import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, emptyQueue, normalizeQueue, isValidOp, MAX_QUEUE, watchUrl } from '../extension/lib/queue.js';
import { normalizeSettings, DEFAULTS, pushBackup } from '../extension/lib/settings.js';

const id = (n) => `vid${String(n).padStart(8, '0')}`;
const ids = (q) => q.items.map((i) => i.id);

test('play next goes first, add to queue goes last, no duplicates', () => {
  let q = emptyQueue();
  q = applyOp(q, { type: 'add', item: { id: id(1), title: 'One' }, position: 'end' }).queue;
  q = applyOp(q, { type: 'add', item: { id: id(2), title: 'Two' }, position: 'end' }).queue;
  q = applyOp(q, { type: 'add', item: { id: id(3), title: 'Three' }, position: 'next' }).queue;
  assert.deepEqual(ids(q), [id(3), id(1), id(2)]);
  // "play next" on a queued video moves it to the front; a bare re-add keeps the known title
  q = applyOp(q, { type: 'add', item: { id: id(2) }, position: 'next' }).queue;
  assert.deepEqual(ids(q), [id(2), id(3), id(1)]);
  assert.equal(q.items[0].title, 'Two');
});

test('addMany, move, remove, clear, shift', () => {
  let r = applyOp(emptyQueue(), { type: 'addMany', items: [{ id: id(1) }, { id: id(2) }, { id: id(1) }, { id: 'bad' }, { id: id(3) }], position: 'end' });
  assert.equal(r.added, 3);
  let q = r.queue;
  q = applyOp(q, { type: 'move', from: 0, to: 2 }).queue;
  assert.deepEqual(ids(q), [id(2), id(3), id(1)]);
  assert.deepEqual(ids(applyOp(q, { type: 'move', from: 0, to: 9 }).queue), ids(q), 'out of range ignored');
  q = applyOp(q, { type: 'remove', id: id(3) }).queue;
  assert.deepEqual(ids(q), [id(2), id(1)]);
  r = applyOp(q, { type: 'shift' });
  assert.equal(r.item.id, id(2));
  assert.deepEqual(r.queue.current, { id: id(2), title: '' });
  assert.deepEqual(ids(r.queue), [id(1)]);
  assert.equal(applyOp(emptyQueue(), { type: 'shift' }).item, null);
  assert.deepEqual(applyOp(q, { type: 'clear' }).queue, emptyQueue());
});

test('limits and normalisation', () => {
  const many = Array.from({ length: MAX_QUEUE + 50 }, (_, i) => ({ id: id(i) }));
  assert.equal(applyOp(emptyQueue(), { type: 'addMany', items: many, position: 'end' }).queue.items.length, MAX_QUEUE);
  const q = normalizeQueue({ items: [{ id: id(1), title: '  a\n  b  ' }, { id: id(1) }, null, { id: 'x' }], current: { id: 'nope' } });
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].title, 'a b');
  assert.equal(q.current, null);
  assert.deepEqual(normalizeQueue('junk'), emptyQueue());
  assert.equal(watchUrl(id(1)), `https://www.youtube.com/watch?v=${id(1)}`);
});

test('operations from senders are validated', () => {
  assert.ok(isValidOp({ type: 'add', item: { id: id(1) }, position: 'next' }));
  assert.ok(!isValidOp({ type: 'add', item: { id: 'bad' }, position: 'next' }));
  assert.ok(!isValidOp({ type: 'add', item: { id: id(1) }, position: 'middle' }));
  assert.ok(isValidOp({ type: 'move', from: 1, to: 0 }));
  assert.ok(!isValidOp({ type: 'move', from: '1', to: 0 }));
  assert.ok(!isValidOp({ type: 'drop' }));
  assert.ok(!isValidOp(null));
});

test('settings', () => {
  assert.deepEqual(normalizeSettings(null), DEFAULTS());
  assert.deepEqual(normalizeSettings({ hoverButtons: false, watchedPct: 150, speed: 'turbo' }), { ...DEFAULTS(), hoverButtons: false, watchedPct: 100 });
  assert.equal(normalizeSettings({ speed: 'careful' }).speed, 'careful');
  assert.deepEqual(pushBackup([{ createdAt: 'b' }, { createdAt: 'c' }, { createdAt: 'd' }], { createdAt: 'a' }).map((b) => b.createdAt), ['a', 'b', 'c']);
  assert.deepEqual(pushBackup(undefined, { createdAt: 'a' }), [{ createdAt: 'a' }]);
});
