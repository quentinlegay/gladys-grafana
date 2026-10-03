// -----------------------------------------------------------------------------
// Entry point of the Grafana integration for Gladys.
//
//   Grafana (sub-container) ──Prometheus API──> this integration ──REST──> Gladys
//
// This file only wires the SDK to:
//   - src/gladys/     : reads the devices and their history from Gladys;
//   - src/prometheus/ : serves them through the Prometheus query API, which
//                       Grafana's built-in data source understands;
//   - src/grafana/    : provisions Grafana (data source, dashboards) and
//                       drives its sub-container.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { gladysBaseUrl, missingConfig, normalizeConfig } from './src/config.js';
import { GladysApi } from './src/gladys/api.js';
import { Catalog } from './src/gladys/catalog.js';
import { History } from './src/gladys/history.js';
import { Engine } from './src/prometheus/engine.js';
import { DEFAULT_PORT, startServer } from './src/prometheus/server.js';
import {
  DATASOURCE_USER,
  datasourcePassword,
  prepareFolders,
  writeDashboards,
  writeStartupFiles,
} from './src/grafana/provisioning.js';
import {
  applyContainer,
  grafanaHostPort,
  syncAdminPassword,
  waitForGrafana,
} from './src/grafana/container.js';

// /data is the only writable location of the integration container.
const DATA_DIR = process.env.DATA_DIR ?? '/data';
// How often the device list is re-read to keep the overview dashboard current.
const DASHBOARD_REFRESH_MS = 5 * 60 * 1000;

const gladys = new GladysIntegration();
const api = new GladysApi({ dataDir: DATA_DIR });
const catalog = new Catalog(api);
const history = new History(api);
const engine = new Engine({ catalog, history });

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();
let server = null;
let refreshTimer = null;

// On the private network of the integration, Grafana reaches this container
// by its Docker name.
function datasourceUrl() {
  const selector = process.env.GLADYS_INTEGRATION_SELECTOR;
  return `http://gladys-${selector}:${DEFAULT_PORT}`;
}

async function grafanaUrlHint() {
  const port = await grafanaHostPort(gladys).catch(() => null);
  return port
    ? { en: `Grafana: http://<gladys-ip>:${port}`, fr: `Grafana : http://<ip-de-gladys>:${port}` }
    : { en: '', fr: '' };
}

function gladysErrorMessage(err) {
  if (err.status === 401 || err.status === 403) {
    return {
      en: 'Gladys refused the e-mail/password: check the configuration.',
      fr: "Gladys a refusé l'e-mail ou le mot de passe : vérifiez la configuration.",
    };
  }
  return {
    en: `Gladys API unreachable (${err.message}).`,
    fr: `API de Gladys injoignable (${err.message}).`,
  };
}

// --- Dashboards: regenerate the overview from the current devices ------------
async function refreshDashboards() {
  const series = await catalog.refresh();
  const changed = await writeDashboards(DATA_DIR, series, { enabled: config.generate_dashboards });
  if (changed) logger.info(`Dashboards updated (${series.length} series)`);
  return series;
}

// --- (Re)apply the configuration ---------------------------------------------
async function applyConfig() {
  const missing = missingConfig(config);
  if (missing) {
    logger.warn(`Incomplete configuration: ${missing.en}`);
    await gladys.setConnectionStatus(false, missing);
    return;
  }
  api.configure({
    baseUrl: gladysBaseUrl(config),
    email: config.gladys_email,
    password: config.gladys_password,
  });
  catalog.invalidate();

  // 1) Grafana files, then Grafana itself: it starts even if Gladys does not
  // answer yet, its panels will show the error until it does.
  let startupFilesChanged;
  try {
    await prepareFolders(DATA_DIR);
    startupFilesChanged = await writeStartupFiles(DATA_DIR, {
      datasourceUrl: datasourceUrl(),
      datasourcePassword: await datasourcePassword(DATA_DIR),
      adminPassword: config.grafana_admin_password,
    });
  } catch (err) {
    logger.error('Could not write the Grafana provisioning files', err);
    await gladys.setConnectionStatus(false, {
      en: 'Could not write the Grafana files, check the integration logs.',
      fr: "Impossible d'écrire les fichiers de Grafana, consultez les logs de l'intégration.",
    });
    return;
  }

  // 2) The Gladys data, for the generated dashboards.
  let gladysError = null;
  try {
    await refreshDashboards();
  } catch (err) {
    gladysError = err;
    logger.error(`Gladys API check failed: ${err.message}`);
  }

  try {
    await applyContainer(gladys, config, { dataDir: DATA_DIR, startupFilesChanged });
  } catch (err) {
    logger.error('Failed to start Grafana', err);
    await gladys.setConnectionStatus(false, {
      en: 'Grafana could not be started, check the integration logs.',
      fr: "Grafana n'a pas pu être démarré, consultez les logs de l'intégration.",
    });
    return;
  }

  // 3) Admin password changed since Grafana created its database: apply it.
  waitForGrafana()
    .then(() => syncAdminPassword(DATA_DIR, config.grafana_admin_password))
    .then((result) => {
      if (result === 'unknown') {
        logger.warn(
          'Grafana refuses both the current and the previous admin password: reset it with `grafana cli admin reset-admin-password`.',
        );
      }
    })
    .catch((err) => logger.warn(`Admin password not synchronized: ${err.message}`));

  if (gladysError) {
    await gladys.setConnectionStatus(false, gladysErrorMessage(gladysError));
  } else {
    await gladys.setConnectionStatus(true);
  }
}

// --- Discovery: this integration creates no device ---------------------------
gladys.onScanRequest(async () => {
  await gladys.publishDiscoveredDevices([]);
});

// --- Manifest actions: buttons in the Configuration screen -------------------
gladys.onAction('test_connection', async () => {
  try {
    const series = await catalog.refresh();
    const devices = new Set(series.map((s) => s.labels.device_selector)).size;
    await gladys.setConnectionStatus(true);
    const hint = await grafanaUrlHint();
    return {
      en: `Connected to Gladys: ${series.length} measures from ${devices} devices available in Grafana. ${hint.en}`.trim(),
      fr: `Connecté à Gladys : ${series.length} mesures de ${devices} appareils disponibles dans Grafana. ${hint.fr}`.trim(),
    };
  } catch (err) {
    const message = gladysErrorMessage(err);
    await gladys.setConnectionStatus(false, message);
    return message;
  }
});

gladys.onAction('regenerate_dashboards', async () => {
  if (!config.generate_dashboards) {
    return {
      en: 'Dashboard generation is disabled in the configuration.',
      fr: 'La génération des tableaux de bord est désactivée dans la configuration.',
    };
  }
  const series = await refreshDashboards();
  return {
    en: `Dashboards regenerated (${series.length} measures). Grafana shows them within 30 seconds.`,
    fr: `Tableaux de bord régénérés (${series.length} mesures). Grafana les affiche sous 30 secondes.`,
  };
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  await applyConfig();
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
    config = normalizeConfig(await gladys.getConfig());
    await applyConfig();
    refreshTimer ??= setInterval(() => {
      if (missingConfig(config)) return;
      refreshDashboards().catch((err) =>
        logger.warn(`Periodic dashboard refresh failed: ${err.message}`),
      );
    }, DASHBOARD_REFRESH_MS);
    initialized = true;
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
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
