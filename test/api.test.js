import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GladysApi } from '../src/gladys/api.js';
import { relativeWindow } from '../src/gladys/history.js';

/** Fake Gladys server: records requests, accepts the keys in `validKeys`. */
function fakeFetch({ password = 'pw', validKeys = new Set() } = {}) {
  const requests = [];
  let keyCounter = 0;
  const json = (status, body) => new Response(JSON.stringify(body), { status });
  const fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const auth = init.headers.authorization;
    requests.push({ method: init.method, pathname, auth, query: Object.fromEntries(searchParams) });
    if (pathname === '/api/v1/login') {
      const body = JSON.parse(init.body);
      if (body.password !== password) return json(403, { message: 'Wrong password' });
      return json(200, { access_token: 'jwt', refresh_token: 'r', session_id: 'sess-1' });
    }
    if (pathname === '/api/v1/session/api_key') {
      assert.equal(auth, 'Bearer jwt');
      keyCounter += 1;
      const key = `key-${keyCounter}`;
      validKeys.add(key);
      return json(201, { api_key: key, session_id: `api-${keyCounter}` });
    }
    if (pathname === '/api/v1/session/sess-1/revoke') return json(200, {});
    if (!validKeys.has(auth)) return json(401, { message: 'Unauthorized' });
    return json(200, [{ name: 'device' }]);
  };
  return { fetch, requests, validKeys };
}

async function newApi(fake, dataDir) {
  const api = new GladysApi({
    dataDir: dataDir ?? (await mkdtemp(path.join(tmpdir(), 'api-'))),
    fetch: fake.fetch,
  });
  api.configure({ baseUrl: 'http://gladys:80', email: 'me@example.com', password: 'pw' });
  return api;
}

test('the password is traded once for an API key, and the login session revoked', async () => {
  const fake = fakeFetch();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'api-'));
  const api = await newApi(fake, dataDir);
  assert.deepEqual(await api.getDevices(), [{ name: 'device' }]);
  await api.getDevices();
  assert.deepEqual(
    fake.requests.map((r) => r.pathname),
    [
      '/api/v1/login',
      '/api/v1/session/api_key',
      '/api/v1/session/sess-1/revoke',
      '/api/v1/device',
      '/api/v1/device',
    ],
  );
  assert.equal(fake.requests[3].auth, 'key-1', 'API key sent as is, without Bearer');

  // Persisted, owner-only: a restart reuses it without logging in.
  const file = path.join(dataDir, 'gladys-api-key.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).api_key, 'key-1');
  const restarted = await newApi(fake, dataDir);
  await restarted.getDevices();
  assert.equal(fake.requests.filter((r) => r.pathname === '/api/v1/login').length, 1);
});

test('a revoked key triggers one new login', async () => {
  const fake = fakeFetch();
  const api = await newApi(fake);
  await api.getDevices();
  fake.validKeys.clear(); // the user revoked the key in Gladys
  await api.getDevices();
  assert.equal(fake.requests.filter((r) => r.pathname === '/api/v1/login').length, 2);
  assert.equal(fake.requests.at(-1).auth, 'key-2');
});

test('a key stored for another account is not reused', async () => {
  const fake = fakeFetch();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'api-'));
  await (await newApi(fake, dataDir)).getDevices();
  const other = new GladysApi({ dataDir, fetch: fake.fetch });
  other.configure({ baseUrl: 'http://gladys:80', email: 'other@example.com', password: 'pw' });
  await other.getDevices();
  assert.equal(fake.requests.filter((r) => r.pathname === '/api/v1/login').length, 2);
});

test('a wrong password surfaces the Gladys error status', async () => {
  const fake = fakeFetch({ password: 'right' });
  const api = await newApi(fake);
  await assert.rejects(api.getDevices(), (err) => err.status === 403);
});

test('concurrent requests share a single login', async () => {
  const fake = fakeFetch();
  const api = await newApi(fake);
  await Promise.all([api.getDevices(), api.getDevices(), api.getDevices()]);
  assert.equal(fake.requests.filter((r) => r.pathname === '/api/v1/login').length, 1);
});

test('aggregated states are requested with the relative window of Gladys', async () => {
  const fake = fakeFetch();
  const api = await newApi(fake);
  await api.getAggregatedStates(['a', 'b'], { interval: 60, offset: 5, maxStates: 100 });
  assert.deepEqual(fake.requests.at(-1).query, {
    device_features: 'a,b',
    interval: '60',
    offset: '5',
    max_states: '100',
  });
});

test('absolute windows convert to interval/offset minutes', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  assert.deepEqual(relativeWindow(now - 3600_000, now, now), { interval: 60, offset: 0 });
  assert.deepEqual(relativeWindow(now - 7200_000, now - 3600_000, now), {
    interval: 60,
    offset: 60,
  });
  // An end in the future is clamped to now.
  assert.deepEqual(relativeWindow(now - 60_000, now + 60_000, now), { interval: 1, offset: 0 });
});
