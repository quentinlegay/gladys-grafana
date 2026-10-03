// -----------------------------------------------------------------------------
// Catalog: every Gladys device feature, seen as a Prometheus time series.
//
//   metric name : gladys_<category>_<type>   e.g. gladys_temperature_sensor_decimal
//   labels      : device, device_selector, feature, feature_selector, room,
//                 room_selector, service, category, type, unit
//
// so a Grafana query reads naturally:
//   gladys_temperature_sensor_decimal{room="Salon"}
//   avg by (room) (gladys_humidity_sensor_decimal)
// -----------------------------------------------------------------------------

// Features that carry no numeric history worth plotting.
const SKIPPED_CATEGORIES = new Set(['camera', 'text', 'input']);
const SKIPPED_TYPES = new Set(['text', 'image']);

// Types whose states are discrete (on/off, open/closed…): Gladys stores their
// history as transitions rather than averaged buckets.
export const DISCRETE_TYPES = new Set(['binary', 'push']);

const CATALOG_TTL_MS = 60_000;

export function metricName(category, type) {
  return `gladys_${category}_${type}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

/**
 * Turn the device list of GET /api/v1/device into series. Empty labels are
 * left out, as Prometheus does (a missing label matches "").
 * @param {Array<object>} devices
 */
export function buildSeries(devices) {
  const series = [];
  for (const device of devices ?? []) {
    for (const feature of device.features ?? []) {
      if (SKIPPED_CATEGORIES.has(feature.category) || SKIPPED_TYPES.has(feature.type)) continue;
      const labels = {
        __name__: metricName(feature.category, feature.type),
        device: device.name,
        device_selector: device.selector,
        feature: feature.name,
        feature_selector: feature.selector,
        room: device.room?.name,
        room_selector: device.room?.selector,
        service: device.service?.name,
        category: feature.category,
        type: feature.type,
        unit: feature.unit,
      };
      for (const key of Object.keys(labels)) {
        if (labels[key] === undefined || labels[key] === null || labels[key] === '') {
          delete labels[key];
        } else {
          labels[key] = String(labels[key]);
        }
      }
      series.push({
        labels,
        selector: feature.selector,
        discrete: DISCRETE_TYPES.has(feature.type),
        keepHistory: feature.keep_history !== false,
        lastValue: typeof feature.last_value === 'number' ? feature.last_value : null,
        lastValueChanged: feature.last_value_changed
          ? new Date(feature.last_value_changed).getTime()
          : null,
      });
    }
  }
  return series;
}

/** Cached view of the Gladys devices, refreshed at most once per minute. */
export class Catalog {
  constructor(api, { ttlMs = CATALOG_TTL_MS, now = Date.now } = {}) {
    this.api = api;
    this.ttlMs = ttlMs;
    this.now = now;
    this.series = [];
    this.fetchedAt = 0;
    this.pending = null;
  }

  invalidate() {
    this.fetchedAt = 0;
  }

  async refresh() {
    this.pending ??= this.api
      .getDevices()
      .then((devices) => {
        this.series = buildSeries(devices);
        this.fetchedAt = this.now();
        return this.series;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  async getSeries() {
    if (this.now() - this.fetchedAt < this.ttlMs) return this.series;
    return this.refresh();
  }
}
