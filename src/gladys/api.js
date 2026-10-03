// -----------------------------------------------------------------------------
// Access to the Gladys devices and their history, with the integration token.
//
// No Gladys account to configure: the integration reads the data through the
// host API (/api/integration/v1), like every other host API call of the SDK.
//
// The two routes below do not exist in Gladys yet: the host API only exposes
// the devices created by the integration itself. They are the contract of the
// core change this integration waits for (a manifest permission granting the
// read access to every device, shown on the install screen like `location`):
//
//   GET /api/integration/v1/all_devices
//       -> same answer as GET /api/v1/device (features, room, service)
//   GET /api/integration/v1/device_feature/aggregated_states
//       ?device_features=a,b&interval=<min>&offset=<min>&max_states=<n>
//       -> same answer as GET /api/v1/device_feature/aggregated_states
//
// Until then Gladys answers 404 (route unknown) or 403 (permission not
// granted): the error says so, Grafana shows it in its panels.
// -----------------------------------------------------------------------------

export const ALL_DEVICES_PATH = '/all_devices';
export const AGGREGATED_STATES_PATH = '/device_feature/aggregated_states';

export const NOT_AVAILABLE_MESSAGE =
  'This Gladys version does not let integrations read the device history yet.';

export class GladysDataUnavailableError extends Error {
  constructor(cause) {
    super(NOT_AVAILABLE_MESSAGE);
    this.name = 'GladysDataUnavailableError';
    this.status = cause?.status;
  }
}

export class GladysApi {
  /**
   * @param {{ get: (path: string) => Promise<any> }} http the SDK host API
   * client (`gladys.httpClient`), already authenticated with the token.
   */
  constructor(http) {
    this.http = http;
  }

  async get(path, isRouteMissing) {
    try {
      return await this.http.get(path);
    } catch (err) {
      if (isRouteMissing(err)) throw new GladysDataUnavailableError(err);
      throw err;
    }
  }

  /** Every device, with its features, room and service. */
  getDevices() {
    return this.get(ALL_DEVICES_PATH, (err) => err.status === 404 || err.status === 403);
  }

  /**
   * Aggregated history of several features over [now - offset - interval,
   * now - offset] (minutes), in at most `maxStates` buckets per feature.
   * Answers one entry per selector, in the same order. A 404 here means a
   * feature deleted since the device list was read (see history.js), so only
   * the 403 of a missing permission is turned into "not available".
   */
  getAggregatedStates(selectors, { interval, offset = 0, maxStates }) {
    const query = new URLSearchParams({
      device_features: selectors.join(','),
      interval: String(interval),
      offset: String(offset),
      max_states: String(maxStates),
    });
    return this.get(`${AGGREGATED_STATES_PATH}?${query}`, (err) => err.status === 403);
  }
}
