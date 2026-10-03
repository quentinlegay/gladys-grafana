import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog, buildSeries, metricName } from '../src/gladys/catalog.js';
import { History } from '../src/gladys/history.js';
import { Engine, sample } from '../src/prometheus/engine.js';
import { createFakeApi, DEVICES } from './helpers/fakeGladys.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const sec = (iso) => Date.parse(iso) / 1000;

function setup(states = {}) {
  const api = createFakeApi({ devices: DEVICES, states });
  const now = () => NOW;
  const catalog = new Catalog(api, { now });
  const engine = new Engine({ catalog, history: new History(api, { now }), now });
  return { api, engine };
}

test('every numeric feature becomes a series; cameras are skipped', () => {
  const series = buildSeries(DEVICES);
  assert.deepEqual(
    series.map((s) => s.labels.__name__),
    [
      'gladys_temperature_sensor_decimal',
      'gladys_humidity_sensor_decimal',
      'gladys_temperature_sensor_decimal',
      'gladys_switch_binary',
    ],
  );
  assert.deepEqual(series[0].labels, {
    __name__: 'gladys_temperature_sensor_decimal',
    device: 'Thermomètre salon',
    device_selector: 'thermometre-salon',
    feature: 'Température',
    feature_selector: 'thermometre-salon-temperature',
    room: 'Salon',
    room_selector: 'salon',
    service: 'zigbee2mqtt',
    category: 'temperature-sensor',
    type: 'decimal',
    unit: 'celsius',
  });
  // No room: the label is absent, not empty.
  assert.equal('room' in series[3].labels, false);
  assert.equal(series[3].discrete, true);
  assert.equal(metricName('co2-sensor', 'decimal'), 'gladys_co2_sensor_decimal');
});

test('sampling carries the last known value forward', () => {
  const points = [
    { t: 10, v: 1 },
    { t: 20, v: 2 },
  ];
  assert.deepEqual(sample(points, [5, 10, 15, 20, 25]), [null, 1, 1, 2, 2]);
});

test('an instant query near now answers the last values without reading the history', async () => {
  const { api, engine } = setup();
  const result = await engine.queryInstant('gladys_temperature_sensor_decimal', NOW / 1000);
  assert.equal(result.resultType, 'vector');
  assert.deepEqual(
    result.result.map((r) => [r.metric.room, r.value[1]]),
    [
      ['Salon', '21.5'],
      ['Chambre', '19'],
    ],
  );
  assert.equal(api.calls.filter((c) => c.method === 'getAggregatedStates').length, 0);
});

test('the health check query of Grafana (1+1) answers a scalar', async () => {
  const { engine } = setup();
  assert.deepEqual(await engine.queryInstant('1+1', 1000), {
    resultType: 'scalar',
    result: [1000, '2'],
  });
});

test('a range query resamples the history on the step grid', async () => {
  const { api, engine } = setup({
    'thermometre-salon-temperature': [
      { created_at: '2026-10-03T08:00:00.000Z', value: 20 },
      { created_at: '2026-10-03T09:00:00.000Z', value: 21 },
    ],
  });
  const result = await engine.queryRange(
    'gladys_temperature_sensor_decimal{room="Salon"}',
    sec('2026-10-03T07:30:00Z'),
    sec('2026-10-03T11:30:00Z'),
    3600,
  );
  assert.equal(result.resultType, 'matrix');
  assert.equal(result.result.length, 1);
  assert.deepEqual(result.result[0].values, [
    // 07:30: nothing known yet -> no point
    [sec('2026-10-03T08:30:00Z'), '20'],
    [sec('2026-10-03T09:30:00Z'), '21'],
    // last_value_changed (10:00) seeds the rest of the range
    [sec('2026-10-03T10:30:00Z'), '21.5'],
    [sec('2026-10-03T11:30:00Z'), '21.5'],
  ]);

  // The absolute window was converted into Gladys' relative parameters.
  const call = api.calls.find((c) => c.method === 'getAggregatedStates');
  assert.deepEqual(call.selectors, ['thermometre-salon-temperature']);
  assert.equal(call.params.offset, 30); // end is 30 min before now
  assert.equal(call.params.interval, 300); // 4 h range + 1 h lookback (one step)
});

test('a feature deleted since the catalog was read does not break the others', async () => {
  const { engine } = setup({
    'thermometre-salon-temperature': [{ created_at: '2026-10-03T11:00:00.000Z', value: 22 }],
    // thermometre-chambre-temperature missing -> 404 from the fake API
  });
  const result = await engine.queryRange(
    'gladys_temperature_sensor_decimal',
    sec('2026-10-03T11:00:00Z'),
    sec('2026-10-03T11:00:00Z'),
    60,
  );
  assert.deepEqual(
    result.result.map((r) => [r.metric.room, r.values[0][1]]),
    [
      ['Salon', '22'],
      // still seeded with its last value
      ['Chambre', '19'],
    ],
  );
});

test('aggregations group by the requested labels', async () => {
  const { engine } = setup();
  const avg = await engine.queryInstant('avg(gladys_temperature_sensor_decimal)', NOW / 1000);
  assert.deepEqual(avg.result, [{ metric: {}, value: [NOW / 1000, '20.25'] }]);

  const byRoom = await engine.queryInstant(
    'max by (room) ({__name__=~"gladys_.*_sensor_decimal"})',
    NOW / 1000,
  );
  assert.deepEqual(
    byRoom.result.map((r) => [r.metric, r.value[1]]),
    [
      [{ room: 'Salon' }, '55'],
      [{ room: 'Chambre' }, '19'],
    ],
  );

  const count = await engine.queryInstant(
    'count without (room, room_selector, device, device_selector, feature, feature_selector) (gladys_temperature_sensor_decimal)',
    NOW / 1000,
  );
  assert.equal(count.result[0].value[1], '2');
  assert.equal(count.result[0].metric.__name__, undefined);
});

test('arithmetic with scalars and between matching vectors', async () => {
  const { engine } = setup();
  const fahrenheit = await engine.queryInstant(
    'gladys_temperature_sensor_decimal{room="Salon"} * 9 / 5 + 32',
    NOW / 1000,
  );
  assert.equal(fahrenheit.result[0].value[1], '70.7');
  assert.equal(fahrenheit.result[0].metric.__name__, undefined, 'arithmetic drops the name');

  const diff = await engine.queryInstant(
    'max(gladys_temperature_sensor_decimal) - min(gladys_temperature_sensor_decimal)',
    NOW / 1000,
  );
  assert.equal(diff.result[0].value[1], '2.5');

  const rounded = await engine.queryInstant(
    'round(gladys_temperature_sensor_decimal, 5)',
    NOW / 1000,
  );
  assert.deepEqual(
    rounded.result.map((r) => r.value[1]),
    ['20', '20'],
  );
});

test('selectors that would match everything are refused', async () => {
  const { engine } = setup();
  await assert.rejects(engine.queryInstant('{room=~".*"}', NOW / 1000), /at least one matcher/);
});

test('too many points are refused like Prometheus does', async () => {
  const { engine } = setup();
  await assert.rejects(engine.queryRange('gladys_switch_binary', 0, 20000, 1), /11,000 points/);
});
