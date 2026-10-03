// -----------------------------------------------------------------------------
// Grafana sub-container.
//
// The manifest declares a `grafana` sub-container with `start: manual`:
// nothing starts before the provisioning files exist in /data. We then call
// `startContainer` with an env that holds no secret (the admin password is
// read from a file), so Gladys only recreates Grafana when a setting that
// lives in the env actually changes.
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
// Inside the private network, the sub-container answers to its name.
export const GRAFANA_INTERNAL_URL = `http://${CONTAINER_NAME}:${GRAFANA_PORT}`;

const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_RETRY_MS = 3_000;

/**
 * Environment of the Grafana container.
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export function buildContainerEnv(config) {
  return {
    GF_SECURITY_ADMIN_USER: ADMIN_USER,
    GF_SECURITY_ADMIN_PASSWORD__FILE: `${PROVISIONING_MOUNT}/secrets/admin_password`,
    GF_AUTH_ANONYMOUS_ENABLED: String(config.grafana_anonymous),
    GF_AUTH_ANONYMOUS_ORG_ROLE: 'Viewer',
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
    ...(config.generate_dashboards
      ? {
          GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH: `${PROVISIONING_MOUNT}/dashboards/gladys/overview.json`,
        }
      : {}),
  };
}

export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sortedEnv(env) {
  return Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
}

async function readState(dataDir) {
  try {
    return JSON.parse(await readFile(path.join(dataDir, 'grafana-state.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function writeState(dataDir, patch) {
  const state = { ...(await readState(dataDir)), ...patch };
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'grafana-state.json'), JSON.stringify(state), {
      mode: 0o600,
    });
  } catch (err) {
    logger.warn(`Could not persist the Grafana state: ${err.message}`);
  }
}

/**
 * Make the sub-container match the configuration. A running Grafana is left
 * alone when neither its env nor its startup files changed.
 * @returns {Promise<boolean>} true when Grafana was (re)started
 */
export async function applyContainer(gladys, config, { dataDir, startupFilesChanged }) {
  const env = buildContainerEnv(config);
  const envFingerprint = fingerprint(sortedEnv(env));
  const containers = await gladys.getContainers();
  const current = containers.find((c) => c.name === CONTAINER_NAME);
  const isRunning = current?.status === 'running';
  const state = await readState(dataDir);

  if (isRunning && !startupFilesChanged && state.envFingerprint === envFingerprint) {
    logger.info('Grafana already running with this configuration');
    return false;
  }
  logger.info(isRunning ? 'Restarting Grafana to apply the configuration' : 'Starting Grafana');
  // Creates the container if needed, recreates it when the env changed,
  // restarts it otherwise.
  await gladys.startContainer(CONTAINER_NAME, { env });
  await writeState(dataDir, { envFingerprint });
  return true;
}

/** Host port Gladys assigned to the Grafana UI, or null. */
export async function grafanaHostPort(gladys) {
  const containers = await gladys.getContainers();
  const grafana = containers.find((c) => c.name === CONTAINER_NAME);
  return grafana?.ports?.find((p) => p.container_port === GRAFANA_PORT)?.host_port ?? null;
}

const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

export async function waitForGrafana({
  fetch = globalThis.fetch,
  timeoutMs = HEALTH_TIMEOUT_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${GRAFANA_INTERNAL_URL}/api/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('Grafana did not become healthy in time');
    await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_MS));
  }
}

/**
 * Grafana only reads the admin password when it creates its database. When
 * the user changes it in Gladys afterwards, apply it through the Grafana API
 * with the previous one (remembered in /data).
 * @returns {Promise<'unchanged'|'updated'|'unknown'>}
 */
export async function syncAdminPassword(dataDir, password, { fetch = globalThis.fetch } = {}) {
  const state = await readState(dataDir);
  const canLogin = async (candidate) => {
    const res = await fetch(`${GRAFANA_INTERNAL_URL}/api/user`, {
      headers: { authorization: basic(ADMIN_USER, candidate) },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  };

  if (await canLogin(password)) {
    await writeState(dataDir, { adminPassword: password });
    return 'unchanged';
  }
  const previous = state.adminPassword;
  if (previous && previous !== password && (await canLogin(previous))) {
    const res = await fetch(`${GRAFANA_INTERNAL_URL}/api/user/password`, {
      method: 'PUT',
      headers: {
        authorization: basic(ADMIN_USER, previous),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ oldPassword: previous, newPassword: password, confirmNew: password }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      await writeState(dataDir, { adminPassword: password });
      logger.info('Grafana admin password updated');
      return 'updated';
    }
    logger.warn(`Grafana refused the new admin password (HTTP ${res.status})`);
  }
  return 'unknown';
}
