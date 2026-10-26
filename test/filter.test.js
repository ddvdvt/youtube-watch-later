import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultFilters, normalizeFilters, selectKeys, channelStats, summarize, keywords, shuffled, channelKey } from '../extension/lib/wl-filter.js';
import { parseBrowse } from '../extension/lib/wl-parse.js';
import { browsePage, spec, setVideoIdOf, CHANNELS } from '../e2e/fixtures/wl-data.mjs';

const N = 1000;
const list = Array.from({ length: N }, (_, k) => k + 1);
const items = [];
for (let off = 0; off < N; off += 100) items.push(...parseBrowse(browsePage(list, off, { first: off === 0 }), off).items);
const expect = (pred) => list.filter((i) => pred(spec(i))).length;
const f = (patch) => normalizeFilters({ ...defaultFilters(), ...patch });

test('no active filter selects nothing', () => {
  assert.equal(selectKeys(items, defaultFilters()).size, 0);
});

test('single filters match the generated data exactly', () => {
  assert.equal(selectKeys(items, f({ unavailable: { on: true } })).size, expect((s) => s.unavailable));
  assert.equal(selectKeys(items, f({ shorts: { on: true } })).size, expect((s) => s.shorts));
  assert.equal(selectKeys(items, f({ watched: { on: true, min: 90 } })).size, expect((s) => s.progress >= 90));
  assert.equal(selectKeys(items, f({ watched: { on: true, min: 40 } })).size, expect((s) => s.progress >= 40));
  const ch = channelStats(items)[0];
  assert.equal(selectKeys(items, f({ channels: { on: true, ids: [ch.id] } })).size, ch.count);
  assert.equal(selectKeys(items, f({ duration: { on: true, min: 30, max: null } })).size, expect((s) => s.duration != null && s.duration >= 1800));
  assert.equal(selectKeys(items, f({ duration: { on: true, min: null, max: 1 } })).size, expect((s) => s.duration != null && s.duration <= 60));
  assert.equal(selectKeys(items, f({ position: { on: true, keep: 900 } })).size, 100);
  assert.equal(selectKeys(items, f({ position: { on: true, keep: 0 } })).size, N);
  assert.equal(selectKeys(items, f({ keyword: { on: true, text: 'ХЛЕБ, лекция' } })).size, expect((s) => /хлеб|лекция/i.test(s.title)));
});

test('combinations: all (AND) and any (OR)', () => {
  const and = selectKeys(items, f({ mode: 'all', watched: { on: true, min: 90 }, shorts: { on: true } }));
  assert.equal(and.size, expect((s) => s.progress >= 90 && s.shorts));
  const or = selectKeys(items, f({ mode: 'any', watched: { on: true, min: 90 }, unavailable: { on: true } }));
  assert.equal(or.size, expect((s) => s.progress >= 90 || s.unavailable));
  // a filter switched on with empty input does not count
  assert.equal(selectKeys(items, f({ keyword: { on: true, text: '  ' } })).size, 0);
  assert.equal(selectKeys(items, f({ channels: { on: true, ids: [] } })).size, 0);
});

test('manual additions and exclusions on top of the filters', () => {
  const add = new Set([setVideoIdOf(1), setVideoIdOf(2)]);
  const remove = new Set([setVideoIdOf(37)]);
  const sel = selectKeys(items, f({ unavailable: { on: true } }), { add, remove });
  assert.equal(sel.size, expect((s) => s.unavailable) - 1 + 2);
  assert.ok(sel.has(setVideoIdOf(1)) && !sel.has(setVideoIdOf(37)));
  assert.equal(selectKeys(items, defaultFilters(), { add }).size, 2);
});

test('channel stats and summary', () => {
  const st = channelStats(items);
  assert.equal(st.reduce((n, c) => n + c.count, 0), N);
  assert.ok(st.length <= CHANNELS.length + 1);
  assert.ok(st.every((c, i) => i === 0 || st[i - 1].count >= c.count));
  assert.ok(st.some((c) => c.id === 'none'), 'unavailable videos have no channel');
  const s = summarize(items, 90);
  assert.equal(s.total, N);
  assert.equal(s.unavailable, expect((x) => x.unavailable));
  assert.equal(s.shorts, expect((x) => x.shorts));
  assert.equal(s.watched, expect((x) => x.progress >= 90));
  assert.ok(s.seconds > 0);
  assert.equal(channelKey({ channelId: '', channel: 'X' }), 'name:X');
});

test('normalizeFilters repairs bad input', () => {
  const n = normalizeFilters({ mode: 'weird', watched: { on: 1, min: 500 }, duration: { on: true, min: '-3', max: 'abc' }, position: { on: true, keep: -5 }, channels: { on: true, ids: ['a', 3] }, keyword: { on: true, text: 5 } });
  assert.equal(n.mode, 'all');
  assert.deepEqual(n.watched, { on: true, min: 100 });
  assert.deepEqual(n.duration, { on: true, min: null, max: null });
  assert.equal(n.position.keep, 0);
  assert.deepEqual(n.channels.ids, ['a']);
  assert.equal(n.keyword.text, '5');
  assert.deepEqual(normalizeFilters(null), defaultFilters());
  assert.deepEqual(keywords(' a, b c ;d\n'), ['a', 'b c', 'd']);
});

test('shuffle keeps every element', () => {
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const a = Array.from({ length: 50 }, (_, i) => i);
  const s = shuffled(a, rand);
  assert.notDeepEqual(s, a);
  assert.deepEqual([...s].sort((x, y) => x - y), a);
  assert.equal(a[0], 0, 'original untouched');
});

test('selection over 10 000 items is fast', () => {
  const big = [];
  for (let k = 0; k < 10; k++) big.push(...items.map((it) => ({ ...it, key: `${it.key}-${k}` })));
  const t0 = performance.now();
  for (let r = 0; r < 20; r++) selectKeys(big, f({ mode: 'any', watched: { on: true, min: 90 }, keyword: { on: true, text: 'хлеб' }, channels: { on: true, ids: [channelStats(big)[0].id] } }));
  assert.ok((performance.now() - t0) / 20 < 100, 'one recalculation < 100 ms');
});
