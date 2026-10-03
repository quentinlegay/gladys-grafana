import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, gladysBaseUrl, missingConfig, normalizeConfig } from '../src/config.js';

const complete = {
  gladys_email: ' me@example.com ',
  gladys_password: ' pw',
  grafana_admin_password: 'admin-password',
};

test('an empty config falls back to the defaults', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('values are trimmed and typed, passwords kept as typed', () => {
  const config = normalizeConfig({
    ...complete,
    gladys_url: 'http://192.168.1.10/ ',
    grafana_anonymous: 'true',
    generate_dashboards: 'false',
  });
  assert.equal(config.gladys_email, 'me@example.com');
  assert.equal(config.gladys_password, ' pw');
  assert.equal(config.gladys_url, 'http://192.168.1.10');
  assert.equal(config.grafana_anonymous, true);
  assert.equal(config.generate_dashboards, false);
});

test('missing settings are reported in both languages', () => {
  assert.match(missingConfig(normalizeConfig({})).fr, /compte Gladys/);
  assert.match(
    missingConfig(normalizeConfig({ ...complete, grafana_admin_password: 'short' })).en,
    /at least 8/,
  );
  assert.match(
    missingConfig(normalizeConfig({ ...complete, gladys_url: 'gladys.local' })).en,
    /http/,
  );
  assert.equal(missingConfig(normalizeConfig(complete)), null);
});

test('the Gladys URL derives from the host API URL unless overridden', () => {
  const config = normalizeConfig(complete);
  assert.equal(gladysBaseUrl(config, 'http://172.30.0.1:80'), 'http://172.30.0.1');
  assert.equal(gladysBaseUrl(config, 'http://gladys:1443'), 'http://gladys:1443');
  assert.equal(
    gladysBaseUrl({ ...config, gladys_url: 'http://192.168.1.10:8080' }, 'http://gladys:1443'),
    'http://192.168.1.10:8080',
  );
});
