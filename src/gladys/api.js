// -----------------------------------------------------------------------------
// Client of the Gladys REST API (the one the Gladys web UI uses).
//
// The integration token only opens the host API (/api/integration/v1): it
// cannot read the devices and states of the other integrations. Grafana needs
// all of them, so we authenticate as a Gladys user:
//
//   1. POST /api/v1/login with the configured e-mail/password;
//   2. POST /api/v1/session/api_key -> a long-lived API key, listed (and
//      revocable) in Gladys under Settings > Sessions;
//   3. revoke the login session, which we no longer need.
//
// The API key is kept in /data so the password is only used again when the
// key is refused (revoked, other account configured…).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'gladys-api' });

const REQUEST_TIMEOUT_MS = 20_000;

export class GladysApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GladysApiError';
    this.status = status;
  }
}

export class GladysApi {
  /**
   * @param {object} options
   * @param {string} options.dataDir where the API key is persisted
   * @param {typeof fetch} [options.fetch] injectable for tests
   */
  constructor({ dataDir, fetch: fetchImpl = globalThis.fetch } = {}) {
    this.keyFile = path.join(dataDir, 'gladys-api-key.json');
    this.fetch = fetchImpl;
    this.baseUrl = null;
    this.email = null;
    this.password = null;
    this.apiKey = null;
    this.loginPromise = null;
  }

  /** Apply new credentials; the stored key is kept only if it belongs to them. */
  configure({ baseUrl, email, password }) {
    const changed = baseUrl !== this.baseUrl || email !== this.email;
    this.baseUrl = baseUrl;
    this.email = email;
    this.password = password;
    if (changed) this.apiKey = null;
  }

  // The key is bound to the account and the instance it was created on.
  owner() {
    return createHash('sha256').update(`${this.baseUrl}\n${this.email}`).digest('hex');
  }

  async loadKey() {
    try {
      const stored = JSON.parse(await readFile(this.keyFile, 'utf8'));
      return stored.owner === this.owner() ? stored.api_key : null;
    } catch {
      return null;
    }
  }

  async saveKey(apiKey) {
    try {
      await mkdir(path.dirname(this.keyFile), { recursive: true });
      await writeFile(this.keyFile, JSON.stringify({ owner: this.owner(), api_key: apiKey }), {
        mode: 0o600,
      });
    } catch (err) {
      logger.warn(`Could not persist the Gladys API key: ${err.message}`);
    }
  }

  async forgetKey() {
    this.apiKey = null;
    await rm(this.keyFile, { force: true }).catch(() => {});
  }

  async rawRequest(method, urlPath, { headers = {}, body, query } = {}) {
    const url = new URL(urlPath, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GladysApiError(0, `Gladys unreachable at ${this.baseUrl} (${err.message})`);
    }
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!response.ok) {
      const detail = payload?.message || payload?.error || response.statusText;
      throw new GladysApiError(response.status, `${method} ${url.pathname}: ${detail}`);
    }
    return payload;
  }

  /** Log in with the password and trade the session for an API key. */
  async login() {
    if (!this.email || !this.password) {
      throw new GladysApiError(401, 'No Gladys credentials configured');
    }
    logger.info(`Logging in to Gladys as ${this.email} to create an API key`);
    const session = await this.rawRequest('POST', '/api/v1/login', {
      body: { email: this.email, password: this.password },
    });
    const bearer = { authorization: `Bearer ${session.access_token}` };
    const { api_key: apiKey } = await this.rawRequest('POST', '/api/v1/session/api_key', {
      headers: bearer,
      body: {},
    });
    // The login session is useless now: revoke it so it does not linger.
    if (session.session_id) {
      await this.rawRequest('POST', `/api/v1/session/${session.session_id}/revoke`, {
        headers: bearer,
      }).catch((err) => logger.debug(`Login session not revoked: ${err.message}`));
    }
    this.apiKey = apiKey;
    await this.saveKey(apiKey);
    return apiKey;
  }

  async ensureKey() {
    if (this.apiKey) return this.apiKey;
    const stored = await this.loadKey();
    if (stored) {
      this.apiKey = stored;
      return stored;
    }
    // Concurrent requests share a single login.
    this.loginPromise ??= this.login().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  /** Authenticated GET; a refused key triggers one new login. */
  async get(urlPath, query) {
    const apiKey = await this.ensureKey();
    try {
      return await this.rawRequest('GET', urlPath, { headers: { authorization: apiKey }, query });
    } catch (err) {
      if (err.status !== 401) throw err;
      logger.warn('Gladys refused the API key: logging in again');
      await this.forgetKey();
      const fresh = await this.ensureKey();
      return this.rawRequest('GET', urlPath, { headers: { authorization: fresh }, query });
    }
  }

  /** Every device, with its features, room and service. */
  getDevices() {
    return this.get('/api/v1/device');
  }

  /**
   * Aggregated history of several features over [now - offset - interval,
   * now - offset] (minutes), in at most `maxStates` buckets per feature.
   * Answers one entry per selector, in the same order.
   */
  getAggregatedStates(selectors, { interval, offset = 0, maxStates }) {
    return this.get('/api/v1/device_feature/aggregated_states', {
      device_features: selectors.join(','),
      interval,
      offset,
      max_states: maxStates,
    });
  }
}
