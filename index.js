// -----------------------------------------------------------------------------
// Entry point of the Grafana integration for Gladys.
//
//   Grafana (sub-container) ──Prometheus API──> this integration ──host API──> Gladys
//
// Nothing to configure: on startup the integration provisions Grafana (data
// source, dashboards, generated admin password) and starts it.
//
// This file only wires the SDK to:
//   - src/gladys/     : reads the devices and their history from Gladys,
//                       with the integration token;
//   - src/prometheus/ : serves them through the Prometheus query API, which
//                       Grafana's built-in data source understands;
//   - src/grafana/    : provisions Grafana and drives its sub-container.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { GladysApi } from './src/gladys/api.js';
import { Catalog } from './src/gladys/catalog.js';
import { History } from './src/gladys/history.js';
import { Engine } from './src/prometheus/engine.js';
import { DEFAULT_PORT, startServer } from './src/prometheus/server.js';
import {
  DATASOURCE_USER,
  adminPassword,
  datasourcePassword,
  prepareFolders,
  writeDashboards,
  writeStartupFiles,
} from './src/grafana/provisioning.js';
import { ADMIN_USER, applyContainer, grafanaHostPort } from './src/grafana/container.js';

// /data is the only writable location of the integration container.
const DATA_DIR = process.env.DATA_DIR ?? '/data';
// How often the device list is re-read to keep the overview dashboard current.
const DASHBOARD_REFRESH_MS = 5 * 60 * 1000;

const gladys = new GladysIntegration();
// The SDK host API client, already authenticated with the integration token.
const api = new GladysApi(gladys.httpClient);
const catalog = new Catalog(api);
const engine = new Engine({ catalog, history: new History(api) });

let server = null;
let refreshTimer = null;

// On the private network of the integration, Grafana reaches this container
// by its Docker name.
function datasourceUrl() {
  return `http://gladys-${process.env.GLADYS_INTEGRATION_SELECTOR}:${DEFAULT_PORT}`;
}

// --- Dashboards: regenerate the overview from the current devices ------------
async function refreshDashboards() {
  const series = await catalog.refresh();
  const changed = await writeDashboards(DATA_DIR, series, { unavailable: catalog.unavailable });
  if (changed) logger.info(`Dashboards updated (${series.length} series)`);
  if (catalog.unavailable) {
    logger.warn('Gladys does not let integrations read the devices yet: Grafana has no data');
  }
  return series;
}

// --- Provision and start Grafana ---------------------------------------------
async function setup() {
  await prepareFolders(DATA_DIR);
  const startupFilesChanged = await writeStartupFiles(DATA_DIR, {
    datasourceUrl: datasourceUrl(),
    datasourcePassword: await datasourcePassword(DATA_DIR),
    adminPassword: await adminPassword(DATA_DIR),
  });
  // The dashboards are a bonus: Gladys being unreachable must not keep
  // Grafana from starting.
  await refreshDashboards().catch((err) => logger.warn(`Dashboards not generated: ${err.message}`));
  await applyContainer(gladys, { dataDir: DATA_DIR, startupFilesChanged });
}

// --- Discovery: this integration creates no device ---------------------------
gladys.onScanRequest(async () => {
  await gladys.publishDiscoveredDevices([]);
});

// --- Manifest action: show how to sign in to Grafana -------------------------
gladys.onAction('show_credentials', async () => {
  const password = await adminPassword(DATA_DIR);
  const port = await grafanaHostPort(gladys).catch(() => null);
  const address = port ? `http://<ip-gladys>:${port}` : null;
  return {
    en: `${address ? `Address: ${address} — ` : ''}User: ${ADMIN_USER} — Password: ${password}`,
    fr: `${address ? `Adresse : ${address} — ` : ''}Utilisateur : ${ADMIN_USER} — Mot de passe : ${password}`,
  };
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK logs the WebSocket lifecycle itself (under the `gladys-sdk` name).
let initialized = false;
gladys.on('connected', async () => {
  // Reconnection to Gladys: the API server and Grafana are still up.
  if (initialized) return;
  try {
    server ??= await startServer(engine, {
      credentials: { user: DATASOURCE_USER, password: await datasourcePassword(DATA_DIR) },
    });
    await setup();
    refreshTimer ??= setInterval(() => {
      refreshDashboards().catch((err) =>
        logger.warn(`Periodic dashboard refresh failed: ${err.message}`),
      );
    }, DASHBOARD_REFRESH_MS);
    initialized = true;
    await gladys.setConnectionStatus(true);
  } catch (err) {
    logger.error('Grafana could not be started', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Grafana could not be started, check the integration logs.',
        fr: "Grafana n'a pas pu être démarré, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

// --- Graceful shutdown -------------------------------------------------------
// Grafana is left running: the supervisor owns the sub-container lifecycle.
gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  clearInterval(refreshTimer);
  if (!server) return;
  // Grafana keeps its connections alive: close them, or close() waits.
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await closed;
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Grafana integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
