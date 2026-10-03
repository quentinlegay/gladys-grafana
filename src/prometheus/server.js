// -----------------------------------------------------------------------------
// HTTP server speaking the Prometheus query API, for Grafana's built-in
// "Prometheus" data source (no plugin to install).
//
// It listens inside the integration container, reachable only from the
// private Docker network shared with the Grafana sub-container. Every request
// must carry the Basic credentials written in the Grafana provisioning.
//
// Endpoints: query, query_range, labels, label/<name>/values, series,
// metadata, status/buildinfo — plus empty answers for what Grafana probes
// but Gladys does not have (exemplars, rules, alerts).
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { ParseError, parseSelector } from './parser.js';
import { QueryError } from './engine.js';

const logger = createLogger({ name: 'prometheus' });

export const DEFAULT_PORT = 9090;
const MAX_BODY_BYTES = 1024 * 1024;
// Reported to Grafana, which adapts its features to the Prometheus version.
const EMULATED_VERSION = '2.50.0';

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const success = (res, data) => send(res, 200, { status: 'success', data });

function fail(res, status, errorType, error) {
  send(res, status, { status: 'error', errorType, error });
}

async function readParams(req, url) {
  const params = new URLSearchParams(url.searchParams);
  if (req.method === 'POST') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new QueryError('request body too large');
      chunks.push(chunk);
    }
    for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) {
      params.append(key, value);
    }
  }
  return params;
}

/** Prometheus accepts RFC 3339 dates or Unix seconds; answer seconds. */
export function parseTime(value, fallbackSec) {
  if (value === null || value === undefined || value === '') return fallbackSec;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber;
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) return asDate / 1000;
  throw new QueryError(`cannot parse "${value}" to a valid timestamp`);
}

/** Prometheus durations: seconds as a number, or 30s / 5m / 1h / 1d… */
export function parseDuration(value) {
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber;
  const units = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };
  const parts = String(value ?? '').match(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)/g);
  if (!parts || parts.join('') !== String(value)) {
    throw new QueryError(`cannot parse "${value}" to a valid duration`);
  }
  return parts.reduce((total, part) => {
    const [, amount, unit] = part.match(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)/);
    return total + Number(amount) * units[unit];
  }, 0);
}

function checkAuth(req, credentials) {
  if (!credentials) return true;
  const expected = Buffer.from(
    `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64')}`,
  );
  const received = Buffer.from(req.headers.authorization ?? '');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/**
 * Build the request handler (exported for tests).
 * @param {import('./engine.js').Engine} engine
 * @param {{ user: string, password: string } | null} credentials
 */
export function createHandler(engine, { credentials = null, now = Date.now } = {}) {
  const matcherSets = (params) => params.getAll('match[]').map((m) => parseSelector(m));

  const routes = {
    '/api/v1/query': async (params) => {
      const query = params.get('query');
      const time = parseTime(params.get('time'), now() / 1000);
      return engine.queryInstant(query, time);
    },
    '/api/v1/query_range': async (params) => {
      const query = params.get('query');
      const start = parseTime(params.get('start'));
      const end = parseTime(params.get('end'));
      const step = parseDuration(params.get('step'));
      return engine.queryRange(query, start, end, step);
    },
    '/api/v1/labels': async (params) => {
      const sets = matcherSets(params);
      const series = sets.length > 0 ? await engine.series(sets) : await engine.catalog.getSeries();
      return [...new Set(series.flatMap((s) => Object.keys(s.labels)))].sort();
    },
    '/api/v1/series': async (params) => {
      const sets = matcherSets(params);
      if (sets.length === 0) throw new QueryError('no match[] parameter provided');
      return (await engine.series(sets)).map((s) => s.labels);
    },
    '/api/v1/metadata': async (params) => {
      const metric = params.get('metric');
      const metadata = {};
      for (const s of await engine.catalog.getSeries()) {
        const name = s.labels.__name__;
        if (metric && name !== metric) continue;
        metadata[name] ??= [
          {
            type: 'gauge',
            help: `Gladys ${s.labels.category} / ${s.labels.type}`,
            unit: s.labels.unit ?? '',
          },
        ];
      }
      return metadata;
    },
    '/api/v1/status/buildinfo': async () => ({
      version: EMULATED_VERSION,
      revision: 'gladys',
      branch: 'gladys',
      buildUser: 'gladys-grafana',
      buildDate: '',
      goVersion: '',
    }),
    '/api/v1/query_exemplars': async () => [],
    '/api/v1/rules': async () => ({ groups: [] }),
    '/api/v1/alerts': async () => ({ alerts: [] }),
  };

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/-/healthy' || url.pathname === '/-/ready') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('OK');
      return;
    }
    if (!checkAuth(req, credentials)) {
      res.setHeader('www-authenticate', 'Basic realm="gladys"');
      fail(res, 401, 'unauthorized', 'invalid credentials');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      fail(res, 405, 'bad_data', 'method not allowed');
      return;
    }

    let route = routes[url.pathname];
    let labelName = null;
    const labelValues = url.pathname.match(/^\/api\/v1\/label\/([^/]+)\/values$/);
    if (labelValues) {
      labelName = decodeURIComponent(labelValues[1]);
      route = async (params) => {
        const sets = matcherSets(params);
        const series =
          sets.length > 0 ? await engine.series(sets) : await engine.catalog.getSeries();
        const values = series.map((s) => s.labels[labelName]).filter((v) => v !== undefined);
        return [...new Set(values)].sort();
      };
    }
    if (!route) {
      fail(res, 404, 'not_found', `${url.pathname} is not supported by the Gladys data source`);
      return;
    }

    try {
      const params = await readParams(req, url);
      success(res, await route(params));
    } catch (err) {
      if (err instanceof ParseError || err instanceof QueryError) {
        fail(res, 400, 'bad_data', err.message);
        return;
      }
      logger.error(`${url.pathname} failed: ${err.message}`);
      // Gladys unreachable or refusing our key: an "execution" error, shown
      // as is in the Grafana panel.
      fail(res, 503, 'execution', `Gladys: ${err.message}`);
    }
  };
}

/** Start listening; resolves with the http.Server. */
export function startServer(engine, { port = DEFAULT_PORT, host = '0.0.0.0', credentials }) {
  const server = createServer(createHandler(engine, { credentials }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      logger.info(`Prometheus-compatible API listening on ${host}:${port}`);
      resolve(server);
    });
  });
}
