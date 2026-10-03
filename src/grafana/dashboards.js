// -----------------------------------------------------------------------------
// Dashboards provisioned in Grafana, in a "Gladys" folder.
//
//   - overview.json : generated from the catalog, one panel per metric
//                     present in the house (temperature, humidity, power…),
//                     with the right Grafana unit, filterable by room;
//   - device.json   : static, pick a device and see all its features.
//
// Provisioned dashboards are read-only in Grafana: users "Save as" a copy to
// customize them, so a regeneration never overwrites their work.
// -----------------------------------------------------------------------------

export const DATASOURCE = { type: 'prometheus', uid: 'gladys' };
export const OVERVIEW_UID = 'gladys-overview';
export const DEVICE_UID = 'gladys-device';

// Gladys unit -> Grafana unit id. Anything else is shown with a suffix.
const UNITS = {
  celsius: 'celsius',
  fahrenheit: 'fahrenheit',
  kelvin: 'kelvin',
  percent: 'percent',
  hPa: 'pressurehpa',
  kPa: 'pressurekpa',
  bar: 'pressurebar',
  'milli-bar': 'pressurembar',
  psi: 'pressurepsi',
  lux: 'lux',
  ppm: 'ppm',
  ppb: 'conppb',
  watt: 'watt',
  kilowatt: 'kwatt',
  'watt-hour': 'watth',
  'kilowatt-hour': 'kwatth',
  ampere: 'amp',
  milliampere: 'mamp',
  volt: 'volt',
  millivolt: 'mvolt',
  'volt-ampere': 'voltamp',
  'kilovolt-ampere': 'kvoltamp',
  'volt-ampere-reactive': 'voltampreact',
  mm: 'lengthmm',
  m: 'lengthm',
  km: 'lengthkm',
  inch: 'lengthin',
  feet: 'lengthft',
  mile: 'lengthmi',
  degree: 'degree',
  liter: 'litre',
  milliliter: 'mlitre',
  cubicmeter: 'm3',
  euro: 'currencyEUR',
  dollar: 'currencyUSD',
  'pound-sterling': 'currencyGBP',
  'meter-per-second': 'velocityms',
  'kilometer-per-hour': 'velocitykmh',
  'mile-per-hour': 'velocitymph',
  microseconds: 'µs',
  milliseconds: 'ms',
  seconds: 's',
  minutes: 'm',
  hours: 'h',
  days: 'd',
  bit: 'bits',
  byte: 'bytes',
  kilobyte: 'kbytes',
  megabyte: 'mbytes',
  gigabyte: 'gbytes',
  'bits-per-second': 'bps',
  'kilobits-per-second': 'Kbits',
  'megabits-per-second': 'Mbits',
  'bytes-per-second': 'Bps',
  'microgram-per-cubic-meter': 'conμgm3',
  'milligram-per-cubic-meter': 'conmgm3',
  decibel: 'dB',
};

const SUFFIXES = {
  pascal: 'Pa',
  'megawatt-hour': 'MWh',
  'cubic-meter-per-hour': 'm³/h',
  'millimeter-per-hour': 'mm/h',
  'millimeter-per-day': 'mm/j',
  'uv-index': 'UV',
  'gram-co2eq-per-kilowatt-hour': 'gCO₂/kWh',
  aqi: 'AQI',
  ph: 'pH',
};

export function grafanaUnit(unit) {
  if (!unit) return undefined;
  if (UNITS[unit]) return UNITS[unit];
  return `suffix: ${SUFFIXES[unit] ?? unit}`;
}

// French titles of the most common categories; others are humanized.
const CATEGORY_TITLES = {
  'temperature-sensor': 'Température',
  'humidity-sensor': 'Humidité',
  'co2-sensor': 'CO₂',
  'light-sensor': 'Luminosité',
  'pressure-sensor': 'Pression',
  'energy-sensor': 'Énergie',
  'energy-production-sensor': 'Production d’énergie',
  'grid-sensor': 'Réseau électrique',
  battery: 'Batterie',
  'battery-low': 'Batterie faible',
  'motion-sensor': 'Mouvement',
  'presence-sensor': 'Présence',
  'opening-sensor': 'Ouverture',
  'leak-sensor': 'Fuite d’eau',
  'smoke-sensor': 'Fumée',
  light: 'Lumière',
  switch: 'Prise / interrupteur',
  shutter: 'Volet',
  curtain: 'Rideau',
  thermostat: 'Thermostat',
  heater: 'Chauffage',
  'air-conditioning': 'Climatisation',
  'airquality-sensor': 'Qualité de l’air',
  'pm25-sensor': 'Particules PM2.5',
  'pm10-sensor': 'Particules PM10',
  'voc-sensor': 'COV',
  'noise-sensor': 'Bruit',
  'uv-sensor': 'UV',
  'precipitation-sensor': 'Précipitations',
  'rain-sensor': 'Pluie',
  'wind-speed-sensor': 'Vent',
  'soil-moisture-sensor': 'Humidité du sol',
  signal: 'Signal',
  teleinformation: 'Téléinformation',
  'device-temperature-sensor': 'Température des appareils',
};

// Display order: comfort first, then energy, then the rest alphabetically.
const CATEGORY_ORDER = [
  'temperature-sensor',
  'humidity-sensor',
  'co2-sensor',
  'airquality-sensor',
  'pressure-sensor',
  'light-sensor',
  'thermostat',
  'heater',
  'energy-sensor',
  'energy-production-sensor',
  'teleinformation',
  'switch',
  'light',
  'shutter',
  'opening-sensor',
  'motion-sensor',
  'presence-sensor',
  'battery',
];

const GENERIC_TYPES = new Set(['decimal', 'integer', 'binary', 'push']);

function humanize(text) {
  const words = String(text)
    .replace(/-sensor$/, '')
    .replace(/[-_]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function panelTitle(category, type) {
  const base = CATEGORY_TITLES[category] ?? humanize(category);
  return GENERIC_TYPES.has(type) ? base : `${base} · ${humanize(type)}`;
}

function categoryRank(category) {
  const index = CATEGORY_ORDER.indexOf(category);
  return index === -1 ? CATEGORY_ORDER.length : index;
}

/** Group the catalog series by metric name. */
export function listMetrics(series) {
  const metrics = new Map();
  for (const s of series) {
    const name = s.labels.__name__;
    if (!metrics.has(name)) {
      metrics.set(name, {
        name,
        category: s.labels.category,
        type: s.labels.type,
        units: new Set(),
        discrete: s.discrete,
        count: 0,
      });
    }
    const metric = metrics.get(name);
    metric.count += 1;
    if (s.labels.unit) metric.units.add(s.labels.unit);
  }
  return [...metrics.values()].sort(
    (a, b) => categoryRank(a.category) - categoryRank(b.category) || a.name.localeCompare(b.name),
  );
}

function roomVariable() {
  return {
    name: 'room',
    label: 'Pièce',
    type: 'query',
    datasource: DATASOURCE,
    query: { query: 'label_values(room)', refId: 'room' },
    definition: 'label_values(room)',
    multi: true,
    includeAll: true,
    allValue: '.*',
    current: { selected: true, text: ['All'], value: ['$__all'] },
    refresh: 1,
    sort: 1,
  };
}

function metricPanel(metric, id, gridPos) {
  // Several units for one metric (°C and °F…): no unit rather than a wrong one.
  const unit = metric.units.size === 1 ? grafanaUnit([...metric.units][0]) : undefined;
  const target = {
    datasource: DATASOURCE,
    refId: 'A',
    expr: `${metric.name}{room=~"$room"}`,
    legendFormat: '{{device}}',
    range: true,
  };
  if (metric.discrete) {
    return {
      id,
      type: 'state-timeline',
      title: panelTitle(metric.category, metric.type),
      datasource: DATASOURCE,
      gridPos,
      targets: [target],
      fieldConfig: {
        defaults: {
          color: { mode: 'thresholds' },
          thresholds: {
            mode: 'absolute',
            steps: [
              { color: 'text', value: null },
              { color: 'green', value: 1 },
            ],
          },
        },
        overrides: [],
      },
      options: {
        showValue: 'never',
        mergeValues: true,
        rowHeight: 0.8,
        legend: { showLegend: false },
      },
    };
  }
  return {
    id,
    type: 'timeseries',
    title: panelTitle(metric.category, metric.type),
    datasource: DATASOURCE,
    gridPos,
    targets: [target],
    fieldConfig: {
      defaults: {
        ...(unit ? { unit } : {}),
        custom: {
          lineInterpolation: 'smooth',
          spanNulls: true,
          fillOpacity: 10,
          showPoints: 'never',
        },
      },
      overrides: [],
    },
    options: {
      legend: {
        showLegend: true,
        displayMode: 'table',
        placement: 'right',
        calcs: ['lastNotNull', 'min', 'max'],
      },
      tooltip: { mode: 'multi', sort: 'desc' },
    },
  };
}

/** The generated overview dashboard. */
export function buildOverviewDashboard(series) {
  const metrics = listMetrics(series);
  const panels = metrics.map((metric, i) =>
    metricPanel(metric, i + 1, { x: (i % 2) * 12, y: Math.floor(i / 2) * 9, w: 12, h: 9 }),
  );
  if (panels.length === 0) {
    panels.push({
      id: 1,
      type: 'text',
      title: 'Aucune donnée',
      gridPos: { x: 0, y: 0, w: 24, h: 4 },
      options: {
        mode: 'markdown',
        content:
          'Aucun appareil Gladys avec des valeurs numériques pour le moment. Ce tableau de bord se met à jour tout seul dès que vous en ajoutez.',
      },
    });
  }
  return {
    uid: OVERVIEW_UID,
    title: 'Gladys — Vue d’ensemble',
    description:
      'Généré automatiquement par l’intégration Grafana de Gladys. Faites « Enregistrer sous » pour le personnaliser.',
    tags: ['gladys'],
    timezone: 'browser',
    editable: true,
    graphTooltip: 1,
    refresh: '1m',
    schemaVersion: 39,
    time: { from: 'now-24h', to: 'now' },
    templating: { list: [roomVariable()] },
    panels,
  };
}

/** Static dashboard: every feature of one device, one panel per metric. */
export function buildDeviceDashboard() {
  return {
    uid: DEVICE_UID,
    title: 'Gladys — Appareil',
    description:
      'Toutes les mesures d’un appareil Gladys. Faites « Enregistrer sous » pour le personnaliser.',
    tags: ['gladys'],
    timezone: 'browser',
    editable: true,
    graphTooltip: 1,
    refresh: '1m',
    schemaVersion: 39,
    time: { from: 'now-7d', to: 'now' },
    templating: {
      list: [
        {
          name: 'device',
          label: 'Appareil',
          type: 'query',
          datasource: DATASOURCE,
          query: { query: 'label_values(device)', refId: 'device' },
          definition: 'label_values(device)',
          refresh: 1,
          sort: 1,
        },
        {
          name: 'metric',
          label: 'Mesures',
          type: 'query',
          datasource: DATASOURCE,
          query: { query: 'label_values({device="$device"}, __name__)', refId: 'metric' },
          definition: 'label_values({device="$device"}, __name__)',
          multi: true,
          includeAll: true,
          current: { selected: true, text: ['All'], value: ['$__all'] },
          hide: 2,
          refresh: 2,
          sort: 1,
        },
      ],
    },
    panels: [
      {
        id: 1,
        type: 'timeseries',
        title: '$metric',
        repeat: 'metric',
        repeatDirection: 'h',
        maxPerRow: 2,
        datasource: DATASOURCE,
        gridPos: { x: 0, y: 0, w: 12, h: 9 },
        targets: [
          {
            datasource: DATASOURCE,
            refId: 'A',
            expr: '{__name__="$metric", device="$device"}',
            legendFormat: '{{feature}}',
            range: true,
          },
        ],
        fieldConfig: {
          defaults: { custom: { spanNulls: true, fillOpacity: 10, showPoints: 'never' } },
          overrides: [],
        },
        options: { legend: { showLegend: true, displayMode: 'list', placement: 'bottom' } },
      },
    ],
  };
}
