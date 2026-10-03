import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGGREGATED_STATES_PATH,
  ALL_DEVICES_PATH,
  GladysApi,
  GladysDataUnavailableError,
} from '../src/gladys/api.js';
import { Catalog } from '../src/gladys/catalog.js';
import { relativeWindow } from '../src/gladys/history.js';
import { DEVICES } from './helpers/fakeGladys.js';

/** Stand-in for the SDK host API client (`gladys.httpClient`). */
function fakeHttp(answer) {
  const paths = [];
  return {
    paths,
    async get(path) {
      paths.push(path);
      return answer(path);
    },
  };
}

function apiError(status) {
  const err = new Error(`HTTP ${status}`);
  err.status = status;
  return err;
}

test('devices and history are read through the host API, with the token', async () => {
  const http = fakeHttp((path) => (path === ALL_DEVICES_PATH ? DEVICES : []));
  const api = new GladysApi(http);
  assert.equal(await api.getDevices(), DEVICES);
  await api.getAggregatedStates(['a', 'b'], { interval: 60, offset: 5, maxStates: 100 });
  const [pathname, query] = http.paths[1].split('?');
  assert.equal(pathname, AGGREGATED_STATES_PATH);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(query)), {
    device_features: 'a,b',
    interval: '60',
    offset: '5',
    max_states: '100',
  });
});

test('a Gladys without the read access answers "not available", not an outage', async () => {
  for (const status of [403, 404]) {
    const api = new GladysApi(
      fakeHttp(() => {
        throw apiError(status);
      }),
    );
    await assert.rejects(api.getDevices(), GladysDataUnavailableError);
  }
  // A real outage stays an error.
  const down = new GladysApi(
    fakeHttp(() => {
      throw apiError(500);
    }),
  );
  await assert.rejects(down.getDevices(), (err) => !(err instanceof GladysDataUnavailableError));
});

test('a 404 on the history is a deleted feature, not a missing route', async () => {
  const api = new GladysApi(
    fakeHttp(() => {
      throw apiError(404);
    }),
  );
  await assert.rejects(
    api.getAggregatedStates(['gone'], { interval: 1, maxStates: 10 }),
    (err) => err.status === 404 && !(err instanceof GladysDataUnavailableError),
  );
});

test('the catalog is empty, and flagged, while the data is not available', async () => {
  let available = false;
  const api = new GladysApi(
    fakeHttp(() => {
      if (!available) throw apiError(404);
      return DEVICES;
    }),
  );
  const catalog = new Catalog(api);
  assert.deepEqual(await catalog.refresh(), []);
  assert.equal(catalog.unavailable, true);

  // After the Gladys update: the data shows up on the next refresh.
  available = true;
  assert.equal((await catalog.refresh()).length, 4);
  assert.equal(catalog.unavailable, false);
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
