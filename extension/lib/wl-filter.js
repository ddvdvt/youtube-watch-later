// Filters for the Watch Later cleanup: which loaded items would be removed.
// Pure module. Works on plain arrays of WlItem (see wl-parse.js) and is fast enough for 10 000+ items.

/**
 * @typedef {import('./wl-parse.js').WlItem} WlItem
 * @typedef {{
 *   mode: 'all' | 'any',
 *   watched: { on: boolean, min: number },
 *   unavailable: { on: boolean },
 *   shorts: { on: boolean },
 *   channels: { on: boolean, ids: string[] },
 *   duration: { on: boolean, min: number | null, max: number | null },
 *   position: { on: boolean, keep: number },
 *   keyword: { on: boolean, text: string },
 * }} Filters
 */

/** @returns {Filters} */
export function defaultFilters(watchedMin = 90) {
  return {
    mode: 'all',
    watched: { on: false, min: clampPct(watchedMin) },
    unavailable: { on: false },
    shorts: { on: false },
    channels: { on: false, ids: [] },
    duration: { on: false, min: null, max: null },
    position: { on: false, keep: 100 },
    keyword: { on: false, text: '' },
  };
}

/** @param {unknown} v */
function clampPct(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(1, Math.min(100, n)) : 90;
}

/** @param {unknown} v @returns {number | null} */
function optNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Repair anything (stored or user input) into valid Filters.
 * @param {any} f
 * @returns {Filters}
 */
export function normalizeFilters(f) {
  const d = defaultFilters();
  if (!f || typeof f !== 'object') return d;
  return {
    mode: f.mode === 'any' ? 'any' : 'all',
    watched: { on: !!(f.watched && f.watched.on), min: clampPct(f.watched && f.watched.min) },
    unavailable: { on: !!(f.unavailable && f.unavailable.on) },
    shorts: { on: !!(f.shorts && f.shorts.on) },
    channels: { on: !!(f.channels && f.channels.on), ids: Array.isArray(f.channels && f.channels.ids) ? f.channels.ids.filter((x) => typeof x === 'string') : [] },
    duration: { on: !!(f.duration && f.duration.on), min: optNum(f.duration && f.duration.min), max: optNum(f.duration && f.duration.max) },
    position: { on: !!(f.position && f.position.on), keep: Math.max(0, Math.floor(Number(f.position && f.position.keep) || 0)) },
    keyword: { on: !!(f.keyword && f.keyword.on), text: String((f.keyword && f.keyword.text) || '').slice(0, 300) },
  };
}

/** Channel identity used by the channel filter (id when known, otherwise the name). @param {WlItem} it */
export const channelKey = (it) => it.channelId || (it.channel ? `name:${it.channel}` : 'none');

/** Lower-cased keywords: "a, b c" → ["a", "b c"]. @param {string} text */
export function keywords(text) {
  return String(text || '')
    .split(/[,;\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The individual tests that are switched on.
 * @param {Filters} f
 * @returns {Array<(it: WlItem) => boolean>}
 */
export function activeTests(f) {
  /** @type {Array<(it: WlItem) => boolean>} */
  const tests = [];
  if (f.watched.on) tests.push((it) => it.progress != null && it.progress >= f.watched.min);
  if (f.unavailable.on) tests.push((it) => it.unavailable);
  if (f.shorts.on) tests.push((it) => it.shorts);
  if (f.channels.on && f.channels.ids.length) {
    const ids = new Set(f.channels.ids);
    tests.push((it) => ids.has(channelKey(it)));
  }
  if (f.duration.on && (f.duration.min != null || f.duration.max != null)) {
    const lo = f.duration.min != null ? f.duration.min * 60 : -Infinity;
    const hi = f.duration.max != null ? f.duration.max * 60 : Infinity;
    tests.push((it) => it.duration != null && it.duration >= lo && it.duration <= hi);
  }
  if (f.position.on) tests.push((it) => it.index > f.position.keep);
  if (f.keyword.on) {
    const words = keywords(f.keyword.text);
    if (words.length) tests.push((it) => {
      const title = it.title.toLowerCase();
      return words.some((w) => title.includes(w));
    });
  }
  return tests;
}

/**
 * Keys of items to remove: items matching the filters (all / any of the active tests),
 * plus manual additions, minus manual exclusions. No active filter → only manual additions.
 * @param {WlItem[]} items
 * @param {Filters} filters
 * @param {{ add?: Set<string>, remove?: Set<string> }} [manual]
 * @returns {Set<string>}
 */
export function selectKeys(items, filters, manual = {}) {
  const f = normalizeFilters(filters);
  const tests = activeTests(f);
  const add = manual.add || new Set();
  const remove = manual.remove || new Set();
  const out = new Set();
  for (const it of items) {
    let hit = false;
    if (tests.length) hit = f.mode === 'any' ? tests.some((t) => t(it)) : tests.every((t) => t(it));
    if ((hit || add.has(it.key)) && !remove.has(it.key)) out.add(it.key);
  }
  return out;
}

/**
 * Channels with item counts, most frequent first (ties: by name).
 * @param {WlItem[]} items
 * @returns {{ id: string, name: string, count: number }[]}
 */
export function channelStats(items) {
  /** @type {Map<string, { id: string, name: string, count: number }>} */
  const m = new Map();
  for (const it of items) {
    const id = channelKey(it);
    const e = m.get(id);
    if (e) e.count++;
    else m.set(id, { id, name: it.channel || '', count: 1 });
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Overview numbers for the panel.
 * @param {WlItem[]} items
 * @param {number} watchedMin
 */
export function summarize(items, watchedMin = 90) {
  let watched = 0;
  let unavailable = 0;
  let shorts = 0;
  let seconds = 0;
  for (const it of items) {
    if (it.progress != null && it.progress >= watchedMin) watched++;
    if (it.unavailable) unavailable++;
    if (it.shorts) shorts++;
    if (it.duration) seconds += it.duration;
  }
  return { total: items.length, watched, unavailable, shorts, seconds };
}

/**
 * Fisher–Yates shuffle (copy). `rand` is injectable for tests.
 * @template T
 * @param {T[]} arr
 * @param {() => number} [rand]
 * @returns {T[]}
 */
export function shuffled(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
