import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSeries } from '../src/gladys/catalog.js';
import {
  buildDeviceDashboard,
  buildOverviewDashboard,
  grafanaUnit,
  panelTitle,
} from '../src/grafana/dashboards.js';
import {
  adminPassword,
  datasourcePassword,
  datasourceYaml,
  paths,
  prepareFolders,
  writeDashboards,
  writeStartupFiles,
} from '../src/grafana/provisioning.js';
import { applyContainer, buildContainerEnv } from '../src/grafana/container.js';
import { createFakeGladys, DEVICES } from './helpers/fakeGladys.js';

const tmp = () => mkdtemp(path.join(tmpdir(), 'grafana-'));

test('the overview has one panel per metric, with Grafana units and room filter', () => {
  const dashboard = buildOverviewDashboard(buildSeries(DEVICES));
  assert.deepEqual(
    dashboard.panels.map((p) => [p.title, p.type, p.fieldConfig.defaults.unit]),
    [
      ['Température', 'timeseries', 'celsius'],
      ['Humidité', 'timeseries', 'percent'],
      ['Prise / interrupteur', 'state-timeline', undefined],
    ],
  );
  assert.equal(
    dashboard.panels[0].targets[0].expr,
    'gladys_temperature_sensor_decimal{room=~"$room"}',
  );
  assert.equal(dashboard.templating.list[0].name, 'room');
  // Two columns, no overlap.
  assert.deepEqual(dashboard.panels[2].gridPos, { x: 0, y: 9, w: 12, h: 9 });
});

test('an empty overview says why it is empty', () => {
  const empty = buildOverviewDashboard([]);
  assert.equal(empty.panels.length, 1);
  assert.equal(empty.panels[0].type, 'text');
  assert.match(empty.panels[0].options.content, /Aucun appareil/);
  const waiting = buildOverviewDashboard([], { unavailable: true });
  assert.match(waiting.panels[0].options.content, /version de Gladys/);
});

test('units and titles fall back gracefully', () => {
  assert.equal(grafanaUnit('kilowatt-hour'), 'kwatth');
  assert.equal(grafanaUnit('uv-index'), 'suffix: UV');
  assert.equal(grafanaUnit('brand-new-unit'), 'suffix: brand-new-unit');
  assert.equal(grafanaUnit(undefined), undefined);
  assert.equal(panelTitle('light', 'brightness'), 'Lumière · Brightness');
  assert.equal(panelTitle('flux-capacitor-sensor', 'decimal'), 'Flux capacitor');
});

test('the device dashboard repeats one panel per metric of the chosen device', () => {
  const dashboard = buildDeviceDashboard();
  assert.equal(dashboard.panels[0].repeat, 'metric');
  assert.equal(
    dashboard.templating.list[1].query.query,
    'label_values({device="$device"}, __name__)',
  );
});

test('provisioning files: data source, provider, secret, dashboards', async () => {
  const dataDir = await tmp();
  await prepareFolders(dataDir);
  const p = paths(dataDir);
  assert.equal(
    (await stat(p.grafanaData)).mode & 0o777,
    0o777,
    'Grafana (uid 472) must write its data',
  );

  const password = await datasourcePassword(dataDir);
  assert.equal(await datasourcePassword(dataDir), password, 'the secret is stable');
  const admin = await adminPassword(dataDir);
  assert.equal(await adminPassword(dataDir), admin);
  assert.notEqual(admin, password, 'each secret is generated on its own');
  assert.ok(admin.length >= 20);

  const options = {
    datasourceUrl: 'http://gladys-grafana:9090',
    datasourcePassword: password,
    adminPassword: admin,
  };
  assert.equal(await writeStartupFiles(dataDir, options), true);
  assert.equal(
    await writeStartupFiles(dataDir, options),
    false,
    'unchanged files do not restart Grafana',
  );
  assert.equal(await readFile(path.join(p.secrets, 'admin_password'), 'utf8'), admin);
  const yaml = await readFile(path.join(p.datasources, 'gladys.yaml'), 'utf8');
  assert.match(yaml, /url: "http:\/\/gladys-grafana:9090"/);
  assert.match(yaml, new RegExp(`basicAuthPassword: "${password}"`));

  const series = buildSeries(DEVICES);
  assert.equal(await writeDashboards(dataDir, series), true);
  assert.equal(await writeDashboards(dataDir, series), false, 'unchanged dashboards untouched');
  assert.deepEqual((await readdir(p.dashboards)).sort(), ['device.json', 'overview.json']);
});

test('YAML values are quoted, so special characters cannot break the file', () => {
  const yaml = datasourceYaml({ url: 'http://x:9090', password: 'a"b: #c' });
  assert.match(yaml, /basicAuthPassword: "a\\"b: #c"/);
});

test('the container env carries no secret and pins every path to the volumes', () => {
  const env = buildContainerEnv();
  assert.equal(env.GF_SECURITY_ADMIN_PASSWORD, undefined);
  assert.equal(
    env.GF_SECURITY_ADMIN_PASSWORD__FILE,
    '/etc/grafana/provisioning/secrets/admin_password',
  );
  assert.equal(env.GF_PATHS_DATA, '/var/lib/grafana');
  assert.equal(env.GF_PLUGINS_PREINSTALL_DISABLED, 'true');
  assert.equal(
    env.GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH,
    '/etc/grafana/provisioning/dashboards/gladys/overview.json',
  );
  for (const key of Object.keys(env)) assert.ok(!key.startsWith('GLADYS_'), `${key} is reserved`);
});

test('Grafana is started once, then only restarted when its files changed', async () => {
  const dataDir = await tmp();
  const gladys = createFakeGladys();
  assert.equal(await applyContainer(gladys, { dataDir, startupFilesChanged: true }), true);
  assert.equal(await applyContainer(gladys, { dataDir, startupFilesChanged: false }), false);
  assert.equal(await applyContainer(gladys, { dataDir, startupFilesChanged: true }), true);
  assert.deepEqual(
    gladys.containerCalls.map((c) => c.action),
    ['start', 'start'],
  );
});
