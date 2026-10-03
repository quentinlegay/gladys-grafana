import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog } from '../src/gladys/catalog.js';
import { History } from '../src/gladys/history.js';
import { Engine } from '../src/prometheus/engine.js';
import { parseDuration, parseTime, startServer } from '../src/prometheus/server.js';
import { createFakeApi, DEVICES } from './helpers/fakeGladys.js';

const credentials = { user: 'grafana', password: 's3cret' };
const auth = `Basic ${Buffer.from('grafana:s3cret').toString('base64')}`;
let server;
let base;

before(async () => {
  const api = createFakeApi({ devices: DEVICES });
  const engine = new Engine({ catalog: new Catalog(api), history: new History(api) });
  server = await startServer(engine, { port: 0, host: '127.0.0.1', credentials });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function call(path, { method = 'GET', body, headers = { authorization: auth } } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });
  return { status: res.status, json: await res.json() };
}

test('requests without the data source credentials are refused', async () => {
  const { status, json } = await call('/api/v1/labels', { headers: {} });
  assert.equal(status, 401);
  assert.equal(json.status, 'error');
  const wrong = await call('/api/v1/labels', {
    headers: { authorization: `Basic ${Buffer.from('grafana:nope').toString('base64')}` },
  });
  assert.equal(wrong.status, 401);
});

test('the Grafana health check (POST query 1+1) succeeds', async () => {
  const { status, json } = await call('/api/v1/query', {
    method: 'POST',
    body: new URLSearchParams({ query: '1+1', time: '1700000000' }).toString(),
  });
  assert.equal(status, 200);
  assert.deepEqual(json, {
    status: 'success',
    data: { resultType: 'scalar', result: [1700000000, '2'] },
  });
});

test('label names and values feed the Grafana query builder', async () => {
  const labels = await call('/api/v1/labels');
  assert.ok(labels.json.data.includes('room'));
  assert.ok(labels.json.data.includes('__name__'));

  const metrics = await call('/api/v1/label/__name__/values');
  assert.deepEqual(metrics.json.data, [
    'gladys_humidity_sensor_decimal',
    'gladys_switch_binary',
    'gladys_temperature_sensor_decimal',
  ]);

  const rooms = await call(
    `/api/v1/label/room/values?${new URLSearchParams({ 'match[]': 'gladys_temperature_sensor_decimal' })}`,
  );
  assert.deepEqual(rooms.json.data, ['Chambre', 'Salon']);
});

test('series and metadata endpoints', async () => {
  const series = await call(
    `/api/v1/series?${new URLSearchParams({ 'match[]': '{room="Salon"}' })}`,
  );
  assert.equal(series.json.data.length, 2);
  const metadata = await call('/api/v1/metadata?metric=gladys_temperature_sensor_decimal');
  assert.deepEqual(metadata.json.data, {
    gladys_temperature_sensor_decimal: [
      { type: 'gauge', help: 'Gladys temperature-sensor / decimal', unit: 'celsius' },
    ],
  });
});

test('query_range answers a matrix', async () => {
  const now = Math.floor(Date.now() / 1000);
  const { status, json } = await call(
    `/api/v1/query_range?${new URLSearchParams({ query: 'gladys_switch_binary', start: String(now - 120), end: String(now), step: '1m' })}`,
  );
  assert.equal(status, 200);
  assert.equal(json.data.resultType, 'matrix');
  assert.equal(json.data.result[0].metric.device, 'Prise bureau');
  assert.equal(json.data.result[0].values.length, 3);
});

test('invalid queries are a 400 bad_data with the parser message', async () => {
  const { status, json } = await call(`/api/v1/query?query=${encodeURIComponent('rate(x[5m])')}`);
  assert.equal(status, 400);
  assert.equal(json.errorType, 'bad_data');
  assert.match(json.error, /rate/);
});

test('unknown endpoints are a 404', async () => {
  const { status } = await call('/api/v1/targets');
  assert.equal(status, 404);
});

test('time and duration formats of the Prometheus API', () => {
  assert.equal(parseTime('1700000000.5'), 1700000000.5);
  assert.equal(parseTime('2026-10-03T12:00:00Z'), Date.parse('2026-10-03T12:00:00Z') / 1000);
  assert.equal(parseTime(undefined, 42), 42);
  assert.equal(parseDuration('15'), 15);
  assert.equal(parseDuration('1h30m'), 5400);
  assert.throws(() => parseDuration('abc'), /duration/);
});
