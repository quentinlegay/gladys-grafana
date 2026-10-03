// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CONTAINER_NAME,
  GRAFANA_DATA_MOUNT,
  GRAFANA_PORT,
  PROVISIONING_MOUNT,
} from '../src/grafana/provisioning.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('every manifest action has a registered handler', () => {
  for (const action of manifest.actions ?? []) {
    assert.ok(
      indexSource.includes(`gladys.onAction('${action.key}'`),
      `manifest action "${action.key}" has no handler in index.js`,
    );
  }
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  // Older cores reject any unknown manifest field, so a manifest declaring
  // `categories` (and port names) must not claim compatibility below the
  // first release that accepts it.
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion, 'gladys_version must declare a minimum version');
  const [, major, minor] = minVersion.map(Number);
  assert.ok(
    major > 4 || (major === 4 && minor >= 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('nothing to configure: the config schema only explains', () => {
  assert.ok(manifest.config_schema.length > 0);
  for (const field of manifest.config_schema) {
    assert.equal(field.type, 'section', `"${field.key}" would ask the user for a value`);
  }
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.ok(sections.length > 0, 'the manifest declares at least one section block');
  for (const section of sections) {
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(
      section.placeholder,
      undefined,
      `section "${section.key}" must not have a placeholder`,
    );
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('the Grafana sub-container matches what the code provisions', () => {
  const container = manifest.containers.find((c) => c.name === CONTAINER_NAME);
  assert.ok(container, `the manifest declares the "${CONTAINER_NAME}" sub-container`);
  assert.match(
    container.docker_image,
    /^grafana\/grafana:\d+\.\d+\.\d+$/,
    'image pinned to a release',
  );
  // Provisioning files must exist before Grafana starts.
  assert.equal(container.start, 'manual');
  assert.equal(container.env, undefined, 'the public manifest never carries credentials');
  assert.deepEqual(container.volumes.sort(), [PROVISIONING_MOUNT, GRAFANA_DATA_MOUNT].sort());
  const [port] = container.ports;
  assert.equal(port.container_port, GRAFANA_PORT);
  assert.equal(port.browsable, true);
});

test('every {{port:<name>}} placeholder references a declared port', () => {
  const declared = new Set(manifest.containers.flatMap((c) => c.ports ?? []).map((p) => p.name));
  const texts = JSON.stringify(manifest.config_schema);
  for (const [, name] of texts.matchAll(/\{\{port:([a-z0-9_]+)\}\}/g)) {
    assert.ok(declared.has(name), `{{port:${name}}} is not declared`);
  }
});
