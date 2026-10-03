// -----------------------------------------------------------------------------
// Grafana sub-container.
//
// The manifest declares a `grafana` sub-container with `start: manual`:
// nothing starts before the provisioning files exist in /data. We then call
// `startContainer` with a fixed env that holds no secret (the generated admin
// password is read from a file), so Gladys never needs to recreate Grafana.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import {
  CONTAINER_NAME,
  GRAFANA_DATA_MOUNT,
  GRAFANA_PORT,
  PROVISIONING_MOUNT,
} from './provisioning.js';

const logger = createLogger({ name: 'grafana' });

export const ADMIN_USER = 'admin';

/** Environment of the Grafana container. */
export function buildContainerEnv() {
  return {
    GF_SECURITY_ADMIN_USER: ADMIN_USER,
    GF_SECURITY_ADMIN_PASSWORD__FILE: `${PROVISIONING_MOUNT}/secrets/admin_password`,
    // Read-only rootfs: everything Grafana writes goes to its data volume.
    GF_PATHS_DATA: GRAFANA_DATA_MOUNT,
    GF_PATHS_LOGS: `${GRAFANA_DATA_MOUNT}/logs`,
    GF_PATHS_PLUGINS: `${GRAFANA_DATA_MOUNT}/plugins`,
    GF_PATHS_PROVISIONING: PROVISIONING_MOUNT,
    GF_LOG_MODE: 'console',
    // No phone-home, no plugin downloaded at startup: works offline.
    GF_ANALYTICS_REPORTING_ENABLED: 'false',
    GF_ANALYTICS_CHECK_FOR_UPDATES: 'false',
    GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: 'false',
    GF_PLUGINS_PREINSTALL_DISABLED: 'true',
    GF_NEWS_NEWS_FEED_ENABLED: 'false',
    // Land on the Gladys overview right after login.
    GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH: `${PROVISIONING_MOUNT}/dashboards/gladys/overview.json`,
  };
}

export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const stateFile = (dataDir) => path.join(dataDir, 'grafana-state.json');

async function readState(dataDir) {
  try {
    return JSON.parse(await readFile(stateFile(dataDir), 'utf8'));
  } catch {
    return {};
  }
}

async function writeState(dataDir, state) {
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(stateFile(dataDir), JSON.stringify(state), { mode: 0o600 });
  } catch (err) {
    logger.warn(`Could not persist the Grafana state: ${err.message}`);
  }
}

/**
 * Start Grafana if needed. A running Grafana is left alone unless its env
 * (i.e. a new version of this integration) or its startup files changed.
 * @returns {Promise<boolean>} true when Grafana was (re)started
 */
export async function applyContainer(gladys, { dataDir, startupFilesChanged }) {
  const env = buildContainerEnv();
  const envFingerprint = fingerprint(env);
  const containers = await gladys.getContainers();
  const current = containers.find((c) => c.name === CONTAINER_NAME);
  const isRunning = current?.status === 'running';
  const state = await readState(dataDir);

  if (isRunning && !startupFilesChanged && state.envFingerprint === envFingerprint) {
    logger.info('Grafana already running');
    return false;
  }
  logger.info(isRunning ? 'Restarting Grafana to apply its new files' : 'Starting Grafana');
  // Creates the container if needed, recreates it when the env changed,
  // restarts it otherwise.
  await gladys.startContainer(CONTAINER_NAME, { env });
  await writeState(dataDir, { envFingerprint });
  return true;
}

/** Host port Gladys assigned to the Grafana UI, or null before the first start. */
export async function grafanaHostPort(gladys) {
  const containers = await gladys.getContainers();
  const grafana = containers.find((c) => c.name === CONTAINER_NAME);
  return grafana?.ports?.find((p) => p.container_port === GRAFANA_PORT)?.host_port ?? null;
}
