// -----------------------------------------------------------------------------
// Evaluation of the parsed queries against the Gladys catalog and history.
//
// Every expression is evaluated on a grid of timestamps (one for an instant
// query, start..end by step for a range query):
//   - scalar : { kind: 'scalar', values: number[] }
//   - vector : { kind: 'vector', series: [{ labels, values: (number|null)[] }] }
//
// Sampling: Gladys stores a state when a device reports, often only on
// change. The value at t is therefore the last known value at or before t
// (no 5-minute staleness as in Prometheus), seeded with the feature's
// `last_value` so a sensor that has not changed for days still has a line.
// -----------------------------------------------------------------------------

import { parse, ParseError } from './parser.js';

export class QueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueryError';
  }
}

export const MAX_POINTS_PER_SERIES = 11_000; // same limit as Prometheus
const INSTANT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MIN_RANGE_LOOKBACK_MS = 15 * 60 * 1000;
// "Now" for an instant query: Grafana sends its own clock, slightly behind.
const NOW_TOLERANCE_MS = 60_000;

// --- Label helpers -----------------------------------------------------------

export function compileMatchers(matchers) {
  return matchers.map(({ name, op, value }) => {
    if (op === '=') return (labels) => (labels[name] ?? '') === value;
    if (op === '!=') return (labels) => (labels[name] ?? '') !== value;
    let re;
    try {
      re = new RegExp(`^(?:${value})$`, 'u');
    } catch (err) {
      throw new ParseError(`invalid regular expression "${value}": ${err.message}`);
    }
    if (op === '=~') return (labels) => re.test(labels[name] ?? '');
    return (labels) => !re.test(labels[name] ?? '');
  });
}

/** Series of the catalog matching ALL the matchers. */
export function selectSeries(series, matchers) {
  // Same safety rule as Prometheus: `{}` or `{room=~".*"}` alone would
  // select everything, which is never what the user meant.
  const tests = compileMatchers(matchers);
  if (!tests.some((matches) => !matches({}))) {
    throw new ParseError(
      'the selector must contain at least one matcher that does not match empty labels',
    );
  }
  return series.filter((s) => tests.every((matches) => matches(s.labels)));
}

function withoutName(labels) {
  const { __name__: _name, ...rest } = labels;
  return rest;
}

function signature(labels) {
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
}

// --- Sampling ----------------------------------------------------------------

/**
 * Last-value-carried-forward sampling of sorted points on the grid.
 * @param {Array<{t:number, v:number}>} points sorted by t
 * @param {number[]} grid timestamps in ms, ascending
 */
export function sample(points, grid) {
  const values = new Array(grid.length).fill(null);
  let i = -1;
  for (let k = 0; k < grid.length; k += 1) {
    while (i + 1 < points.length && points[i + 1].t <= grid[k]) i += 1;
    if (i >= 0) values[k] = points[i].v;
  }
  return values;
}

function mergeSeed(points, s) {
  if (s.lastValue === null || s.lastValueChanged === null) return points;
  const last = points[points.length - 1];
  if (last && last.t >= s.lastValueChanged) return points;
  return [...points, { t: s.lastValueChanged, v: s.lastValue }];
}

// --- Arithmetic --------------------------------------------------------------

const OPERATORS = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '%': (a, b) => a % b,
};

function combine(a, b, fn) {
  return a.map((x, k) => (x === null || b[k] === null ? null : fn(x, b[k])));
}

function scalarValues(value, length) {
  return new Array(length).fill(value);
}

// --- Engine ------------------------------------------------------------------

export class Engine {
  /**
   * @param {object} deps
   * @param {import('../gladys/catalog.js').Catalog} deps.catalog
   * @param {import('../gladys/history.js').History} deps.history
   */
  constructor({ catalog, history, now = Date.now }) {
    this.catalog = catalog;
    this.history = history;
    this.now = now;
  }

  async series(matcherSets) {
    const all = await this.catalog.getSeries();
    const seen = new Map();
    for (const matchers of matcherSets) {
      for (const s of selectSeries(all, matchers)) seen.set(s.selector, s);
    }
    return [...seen.values()];
  }

  /** Fetch the points of the selected series for the evaluation grid. */
  async load(selected, grid, step) {
    const start = grid[0];
    const end = grid[grid.length - 1];
    const nowish = this.now() - NOW_TOLERANCE_MS;

    // Instant query close to now: the last value is enough, no history read.
    const needHistory = selected.filter(
      (s) =>
        s.keepHistory &&
        !(
          grid.length === 1 &&
          end >= nowish &&
          s.lastValue !== null &&
          s.lastValueChanged !== null
        ),
    );
    let fetched = new Map();
    if (needHistory.length > 0) {
      const lookback =
        grid.length === 1 ? INSTANT_LOOKBACK_MS : Math.max(step, MIN_RANGE_LOOKBACK_MS);
      fetched = await this.history.fetch(
        needHistory.map((s) => s.selector),
        start - lookback,
        end,
        grid.length === 1 ? 100 : grid.length + 1,
      );
    }
    return selected.map((s) => ({
      labels: s.labels,
      values: sample(mergeSeed(fetched.get(s.selector) ?? [], s), grid),
    }));
  }

  async evaluate(node, grid, step) {
    switch (node.type) {
      case 'number':
        return { kind: 'scalar', values: scalarValues(node.value, grid.length) };

      case 'selector': {
        const selected = selectSeries(await this.catalog.getSeries(), node.matchers);
        return { kind: 'vector', series: await this.load(selected, grid, step) };
      }

      case 'binary': {
        const [lhs, rhs] = await Promise.all([
          this.evaluate(node.lhs, grid, step),
          this.evaluate(node.rhs, grid, step),
        ]);
        const fn = OPERATORS[node.op];
        if (lhs.kind === 'scalar' && rhs.kind === 'scalar') {
          return { kind: 'scalar', values: combine(lhs.values, rhs.values, fn) };
        }
        if (lhs.kind === 'vector' && rhs.kind === 'scalar') {
          return {
            kind: 'vector',
            series: lhs.series.map((s) => ({
              labels: withoutName(s.labels),
              values: combine(s.values, rhs.values, fn),
            })),
          };
        }
        if (lhs.kind === 'scalar' && rhs.kind === 'vector') {
          return {
            kind: 'vector',
            series: rhs.series.map((s) => ({
              labels: withoutName(s.labels),
              values: combine(lhs.values, s.values, fn),
            })),
          };
        }
        // vector op vector: one-to-one matching on every label but the name.
        const right = new Map();
        for (const s of rhs.series) {
          const key = signature(withoutName(s.labels));
          if (right.has(key)) throw new QueryError('many-to-many matching is not supported');
          right.set(key, s);
        }
        const series = [];
        for (const s of lhs.series) {
          const labels = withoutName(s.labels);
          const match = right.get(signature(labels));
          if (match) series.push({ labels, values: combine(s.values, match.values, fn) });
        }
        return { kind: 'vector', series };
      }

      case 'aggregation': {
        const inner = await this.evaluate(node.expr, grid, step);
        if (inner.kind !== 'vector') throw new QueryError(`"${node.op}" expects a series selector`);
        return {
          kind: 'vector',
          series: aggregate(node.op, node.grouping, inner.series, grid.length),
        };
      }

      case 'call': {
        const args = await Promise.all(node.args.map((arg) => this.evaluate(arg, grid, step)));
        const [target, ...params] = args;
        if (params.some((p) => p.kind !== 'scalar')) {
          throw new QueryError(`the extra arguments of "${node.name}" must be numbers`);
        }
        const fn = functionImpl(
          node.name,
          params.map((p) => p.values[0]),
        );
        if (target.kind === 'scalar')
          throw new QueryError(`"${node.name}" expects a series selector`);
        return {
          kind: 'vector',
          series: target.series.map((s) => ({
            labels: withoutName(s.labels),
            values: s.values.map((v) => (v === null ? null : fn(v))),
          })),
        };
      }

      default:
        throw new QueryError(`unsupported expression "${node.type}"`);
    }
  }

  /** Range query, Prometheus semantics: seconds in, `matrix` out. */
  async queryRange(query, startSec, endSec, stepSec) {
    if (![startSec, endSec, stepSec].every(Number.isFinite)) {
      throw new QueryError('start, end and step must be numbers');
    }
    if (stepSec <= 0)
      throw new QueryError('zero or negative query resolution step widths are not accepted');
    if (endSec < startSec) throw new QueryError('end timestamp must not be before start time');
    const count = Math.floor((endSec - startSec) / stepSec) + 1;
    if (count > MAX_POINTS_PER_SERIES) {
      throw new QueryError(
        'exceeded maximum resolution of 11,000 points per timeseries. Try increasing the step',
      );
    }
    const grid = Array.from({ length: count }, (_, k) =>
      Math.round((startSec + k * stepSec) * 1000),
    );
    const result = await this.evaluate(parse(query), grid, stepSec * 1000);
    if (result.kind === 'scalar') {
      return {
        resultType: 'matrix',
        result: [
          { metric: {}, values: grid.map((t, k) => [t / 1000, formatValue(result.values[k])]) },
        ],
      };
    }
    return {
      resultType: 'matrix',
      result: result.series
        .map((s) => ({
          metric: s.labels,
          values: grid
            .map((t, k) => (s.values[k] === null ? null : [t / 1000, formatValue(s.values[k])]))
            .filter(Boolean),
        }))
        .filter((s) => s.values.length > 0),
    };
  }

  /** Instant query: `vector` or `scalar` out. */
  async queryInstant(query, timeSec) {
    if (!Number.isFinite(timeSec)) throw new QueryError('invalid time');
    const t = Math.round(timeSec * 1000);
    const result = await this.evaluate(parse(query), [t], 0);
    if (result.kind === 'scalar') {
      return { resultType: 'scalar', result: [timeSec, formatValue(result.values[0])] };
    }
    return {
      resultType: 'vector',
      result: result.series
        .filter((s) => s.values[0] !== null)
        .map((s) => ({ metric: s.labels, value: [timeSec, formatValue(s.values[0])] })),
    };
  }
}

function aggregate(op, grouping, series, length) {
  const groups = new Map();
  for (const s of series) {
    let labels = {};
    if (grouping?.mode === 'by') {
      for (const name of grouping.labels)
        if (s.labels[name] !== undefined) labels[name] = s.labels[name];
    } else if (grouping?.mode === 'without') {
      labels = withoutName(s.labels);
      for (const name of grouping.labels) delete labels[name];
    }
    const key = signature(labels);
    if (!groups.has(key)) groups.set(key, { labels, members: [] });
    groups.get(key).members.push(s.values);
  }
  return [...groups.values()].map(({ labels, members }) => {
    const values = new Array(length).fill(null);
    for (let k = 0; k < length; k += 1) {
      const present = members.map((m) => m[k]).filter((v) => v !== null);
      if (present.length === 0) continue;
      if (op === 'sum') values[k] = present.reduce((a, b) => a + b, 0);
      else if (op === 'avg') values[k] = present.reduce((a, b) => a + b, 0) / present.length;
      else if (op === 'min') values[k] = Math.min(...present);
      else if (op === 'max') values[k] = Math.max(...present);
      else if (op === 'count') values[k] = present.length;
    }
    return { labels, values };
  });
}

function functionImpl(name, params) {
  switch (name) {
    case 'abs':
      return Math.abs;
    case 'ceil':
      return Math.ceil;
    case 'floor':
      return Math.floor;
    case 'round': {
      const nearest = params[0] ?? 1;
      return (v) => Math.round(v / nearest) * nearest;
    }
    case 'clamp_min':
      return (v) => Math.max(v, params[0]);
    case 'clamp_max':
      return (v) => Math.min(v, params[0]);
    default:
      throw new QueryError(`function "${name}" is not supported`);
  }
}

export function formatValue(v) {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  return String(v);
}
