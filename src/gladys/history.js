// -----------------------------------------------------------------------------
// History of the device features, read from Gladys.
//
// GET /api/v1/device_feature/aggregated_states answers, per feature:
//   - numeric features : at most `max_states` buckets { created_at, value }
//                        (value = average of the bucket);
//   - binary/push      : the transitions { created_at, value, end_time }.
// The window is expressed relative to "now" (interval + offset, in minutes),
// so an absolute [start, end] range is converted here.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'history' });

const MINUTE_MS = 60_000;
const BATCH_SIZE = 20; // selectors per request (Gladys runs 4 queries at a time)
const MIN_STATES = 10;
export const MAX_STATES = 1000;
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 5000;

/**
 * Convert an absolute window into the relative parameters of Gladys.
 * @returns {{ interval: number, offset: number }} minutes
 */
export function relativeWindow(startMs, endMs, nowMs) {
  const offset = Math.max(0, Math.floor((nowMs - endMs) / MINUTE_MS));
  const windowEnd = nowMs - offset * MINUTE_MS;
  const interval = Math.max(1, Math.ceil((windowEnd - startMs) / MINUTE_MS));
  return { interval, offset };
}

/** Parse the `values` of one aggregated_states entry into sorted points. */
export function parsePoints(values) {
  const points = [];
  for (const row of values ?? []) {
    const t = Date.parse(row.created_at);
    const v = Number(row.value);
    if (Number.isFinite(t) && Number.isFinite(v)) points.push({ t, v });
  }
  return points.sort((a, b) => a.t - b.t);
}

export class History {
  constructor(api, { now = Date.now } = {}) {
    this.api = api;
    this.now = now;
    this.cache = new Map();
  }

  cacheGet(key) {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > CACHE_TTL_MS) {
      this.cache.delete(key);
      return undefined;
    }
    return hit.points;
  }

  cacheSet(key, points) {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Map keeps insertion order: drop the oldest entry.
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, { at: this.now(), points });
  }

  async fetchBatch(selectors, params) {
    try {
      const entries = await this.api.getAggregatedStates(selectors, params);
      return selectors.map((_, i) => parsePoints(entries?.[i]?.values));
    } catch (err) {
      // A feature deleted since the catalog was read fails the whole batch
      // with a 404: retry one by one so the others still answer.
      if (err.status !== 404) throw err;
      if (selectors.length === 1) {
        logger.debug(`No history for ${selectors[0]}: ${err.message}`);
        return [[]];
      }
      return Promise.all(
        selectors.map((selector) => this.fetchBatch([selector], params).then(([points]) => points)),
      );
    }
  }

  /**
   * Points of each selector over [startMs, endMs].
   * @param {string[]} selectors
   * @returns {Promise<Map<string, Array<{t: number, v: number}>>>}
   */
  async fetch(selectors, startMs, endMs, maxPoints) {
    const maxStates = Math.min(MAX_STATES, Math.max(MIN_STATES, Math.ceil(maxPoints)));
    const params = { ...relativeWindow(startMs, endMs, this.now()), maxStates };
    const keyOf = (selector) => `${selector}|${startMs}|${endMs}|${maxStates}`;

    const result = new Map();
    const missing = [];
    for (const selector of new Set(selectors)) {
      const cached = this.cacheGet(keyOf(selector));
      if (cached) result.set(selector, cached);
      else missing.push(selector);
    }

    const batches = [];
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      batches.push(missing.slice(i, i + BATCH_SIZE));
    }
    await Promise.all(
      batches.map(async (batch) => {
        const pointsList = await this.fetchBatch(batch, params);
        batch.forEach((selector, i) => {
          // Gladys pads the window by up to a minute: keep it exact.
          const points = pointsList[i].filter((p) => p.t <= endMs);
          this.cacheSet(keyOf(selector), points);
          result.set(selector, points);
        });
      }),
    );
    return result;
  }
}
