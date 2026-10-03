// -----------------------------------------------------------------------------
// Integration configuration.
//
// Filled in by the user in Gladys from the `config_schema` of
// `gladys-assistant-integration.json`. This module only provides defaults and
// normalizes the received object, so the rest of the code never has to deal
// with `undefined` or with numbers/booleans arriving as strings.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (checked by test/manifest.test.js).
export const DEFAULT_CONFIG = {
  gladys_email: '',
  gladys_password: '',
  gladys_url: '', // empty: derived from GLADYS_HOST_API_URL
  grafana_admin_password: '',
  grafana_anonymous: false, // read-only access without login
  generate_dashboards: true,
};

// Grafana is published on the LAN: a short admin password is a mistake.
export const MIN_ADMIN_PASSWORD_LENGTH = 8;

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true';
}

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    gladys_email: trimmed(raw.gladys_email),
    // Passwords are taken as typed: a leading space may be part of them.
    gladys_password: typeof raw.gladys_password === 'string' ? raw.gladys_password : '',
    gladys_url: trimmed(raw.gladys_url).replace(/\/+$/, ''),
    grafana_admin_password:
      typeof raw.grafana_admin_password === 'string' ? raw.grafana_admin_password : '',
    grafana_anonymous: bool(raw.grafana_anonymous, DEFAULT_CONFIG.grafana_anonymous),
    generate_dashboards: bool(raw.generate_dashboards, DEFAULT_CONFIG.generate_dashboards),
  };
}

/**
 * What is missing for the integration to work, as a multi-language message,
 * or `null` when the configuration is complete.
 * @param {ReturnType<typeof normalizeConfig>} config
 */
export function missingConfig(config) {
  if (!config.gladys_email || !config.gladys_password) {
    return {
      en: 'Fill in the e-mail and password of a Gladys account.',
      fr: "Renseignez l'e-mail et le mot de passe d'un compte Gladys.",
    };
  }
  if (config.grafana_admin_password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return {
      en: `Choose a Grafana admin password of at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`,
      fr: `Choisissez un mot de passe administrateur Grafana d'au moins ${MIN_ADMIN_PASSWORD_LENGTH} caractères.`,
    };
  }
  if (config.gladys_url && !/^https?:\/\/[^/]+/.test(config.gladys_url)) {
    return {
      en: 'The Gladys URL must start with http:// or https://.',
      fr: "L'URL de Gladys doit commencer par http:// ou https://.",
    };
  }
  return null;
}

/**
 * Base URL of the Gladys REST API, as seen from the integration container.
 * The supervisor gives us the host API URL: it is the same server, so its
 * origin also serves the regular `/api/v1` routes.
 */
export function gladysBaseUrl(config, hostApiUrl = process.env.GLADYS_HOST_API_URL) {
  if (config.gladys_url) return config.gladys_url;
  return hostApiUrl ? new URL(hostApiUrl).origin : 'http://localhost:1443';
}
