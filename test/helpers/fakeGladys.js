// -----------------------------------------------------------------------------
// Minimal in-memory stand-ins for unit tests.
//
//   - createFakeGladys : the SDK surface the integration relies on
//     (getContainers / startContainer, setConnectionStatus);
//   - createFakeApi    : the Gladys REST API (devices + aggregated states).
// This lets us test the wiring logic without a running Gladys server.
// -----------------------------------------------------------------------------

export function createFakeGladys({ containerStatus = 'stopped', hostPort = 42000 } = {}) {
  const containerCalls = [];
  const connectionStatuses = [];
  const container = { name: 'grafana', status: containerStatus, desired: containerStatus };

  return {
    containerCalls,
    connectionStatuses,
    container,

    async getContainers() {
      return [
        {
          ...container,
          ports: [
            { container_port: 3000, protocol: 'tcp', host_port: hostPort, name: 'grafana_ui' },
          ],
        },
      ];
    },

    async startContainer(name, options) {
      containerCalls.push({ action: 'start', name, env: options?.env });
      container.status = 'running';
      container.desired = 'running';
      return { success: true };
    },

    async stopContainer(name) {
      containerCalls.push({ action: 'stop', name });
      container.status = 'stopped';
      container.desired = 'stopped';
      return { success: true };
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },
  };
}

/**
 * Fake Gladys REST API.
 * @param {object} options
 * @param {Array} options.devices answer of GET /api/v1/device
 * @param {Record<string, Array>} options.states values per feature selector
 */
export function createFakeApi({ devices = [], states = {} } = {}) {
  const calls = [];
  return {
    calls,
    async getDevices() {
      calls.push({ method: 'getDevices' });
      return devices;
    },
    async getAggregatedStates(selectors, params) {
      calls.push({ method: 'getAggregatedStates', selectors, params });
      return selectors.map((selector) => {
        if (!(selector in states)) {
          const err = new Error('DeviceFeature not found');
          err.status = 404;
          throw err;
        }
        return { device: {}, deviceFeature: {}, values: states[selector] };
      });
    },
  };
}

export const DEVICES = [
  {
    name: 'Thermomètre salon',
    selector: 'thermometre-salon',
    room: { name: 'Salon', selector: 'salon' },
    service: { name: 'zigbee2mqtt' },
    features: [
      {
        name: 'Température',
        selector: 'thermometre-salon-temperature',
        category: 'temperature-sensor',
        type: 'decimal',
        unit: 'celsius',
        keep_history: true,
        last_value: 21.5,
        last_value_changed: '2026-10-03T10:00:00.000Z',
      },
      {
        name: 'Humidité',
        selector: 'thermometre-salon-humidity',
        category: 'humidity-sensor',
        type: 'decimal',
        unit: 'percent',
        keep_history: true,
        last_value: 55,
        last_value_changed: '2026-10-03T10:00:00.000Z',
      },
    ],
  },
  {
    name: 'Thermomètre chambre',
    selector: 'thermometre-chambre',
    room: { name: 'Chambre', selector: 'chambre' },
    service: { name: 'zigbee2mqtt' },
    features: [
      {
        name: 'Température',
        selector: 'thermometre-chambre-temperature',
        category: 'temperature-sensor',
        type: 'decimal',
        unit: 'celsius',
        keep_history: true,
        last_value: 19,
        last_value_changed: '2026-10-03T09:00:00.000Z',
      },
    ],
  },
  {
    name: 'Prise bureau',
    selector: 'prise-bureau',
    room: null,
    service: { name: 'tp-link' },
    features: [
      {
        name: 'État',
        selector: 'prise-bureau-binary',
        category: 'switch',
        type: 'binary',
        keep_history: true,
        last_value: 1,
        last_value_changed: '2026-10-03T08:00:00.000Z',
      },
      {
        name: 'Caméra',
        selector: 'prise-bureau-camera',
        category: 'camera',
        type: 'image',
        last_value: null,
      },
    ],
  },
];
