// The extension's own "play next" queue. Pure module: every operation takes a queue object and
// returns a new one. The background service worker is the only writer (it serialises operations
// coming from tabs, the popup, the context menu and the keyboard shortcut).

export const MAX_QUEUE = 5000;
const VIDEO_ID = /^[\w-]{11}$/;

/**
 * @typedef {{ id: string, title: string, channel: string, duration: string, addedAt: number }} QueueItem
 * @typedef {{ items: QueueItem[], current: { id: string, title: string } | null }} Queue
 * @typedef {{ type: 'add', item: Partial<QueueItem>, position: 'next' | 'end' }
 *   | { type: 'addMany', items: Partial<QueueItem>[], position: 'next' | 'end' }
 *   | { type: 'remove', id: string }
 *   | { type: 'move', from: number, to: number }
 *   | { type: 'clear' }
 *   | { type: 'shift' }
 *   | { type: 'setCurrent', current: { id: string, title: string } | null }} QueueOp
 */

/** @returns {Queue} */
export const emptyQueue = () => ({ items: [], current: null });

/**
 * @param {any} raw
 * @param {number} [now]
 * @returns {QueueItem | null}
 */
export function normalizeItem(raw, now = Date.now()) {
  if (!raw || !VIDEO_ID.test(String(raw.id || ''))) return null;
  const s = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  return {
    id: String(raw.id),
    title: s(raw.title, 300),
    channel: s(raw.channel, 120),
    duration: s(raw.duration, 12),
    addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : now,
  };
}

/** @param {any} raw @returns {Queue} */
export function normalizeQueue(raw) {
  const q = emptyQueue();
  if (!raw || typeof raw !== 'object') return q;
  const seen = new Set();
  for (const r of Array.isArray(raw.items) ? raw.items : []) {
    const it = normalizeItem(r, 0);
    if (it && !seen.has(it.id) && q.items.length < MAX_QUEUE) {
      seen.add(it.id);
      q.items.push(it);
    }
  }
  if (raw.current && VIDEO_ID.test(String(raw.current.id))) q.current = { id: String(raw.current.id), title: String(raw.current.title || '').slice(0, 300) };
  return q;
}

/**
 * Apply one operation. A video already in the queue is moved, never duplicated
 * ("play next" on a queued video brings it to the front).
 * @param {Queue} queue
 * @param {QueueOp} op
 * @param {number} [now]
 * @returns {{ queue: Queue, item?: QueueItem | null, added?: number }}
 */
export function applyOp(queue, op, now = Date.now()) {
  const q = normalizeQueue(queue);
  switch (op && op.type) {
    case 'add':
    case 'addMany': {
      const list = (op.type === 'add' ? [op.item] : op.items || []).map((r) => normalizeItem(r, now)).filter(Boolean);
      const uniq = [];
      const ids = new Set();
      for (const it of /** @type {QueueItem[]} */ (list)) if (!ids.has(it.id)) (ids.add(it.id), uniq.push(it));
      // keep known titles when a bare id is re-added
      const old = new Map(q.items.map((it) => [it.id, it]));
      const merged = uniq.map((it) => {
        const o = old.get(it.id);
        return o && !it.title ? { ...it, title: o.title, channel: o.channel || it.channel, duration: o.duration || it.duration } : it;
      });
      const rest = q.items.filter((it) => !ids.has(it.id));
      q.items = (op.position === 'next' ? [...merged, ...rest] : [...rest, ...merged]).slice(0, MAX_QUEUE);
      return { queue: q, added: merged.length };
    }
    case 'remove':
      q.items = q.items.filter((it) => it.id !== op.id);
      return { queue: q };
    case 'move': {
      const from = Math.trunc(op.from);
      const to = Math.trunc(op.to);
      if (from < 0 || from >= q.items.length || to < 0 || to >= q.items.length || from === to) return { queue: q };
      const [it] = q.items.splice(from, 1);
      q.items.splice(to, 0, it);
      return { queue: q };
    }
    case 'clear':
      return { queue: emptyQueue() };
    case 'shift': {
      const item = q.items.shift() || null;
      q.current = item ? { id: item.id, title: item.title } : q.current;
      return { queue: q, item };
    }
    case 'setCurrent':
      q.current = op.current && VIDEO_ID.test(String(op.current.id)) ? { id: op.current.id, title: String(op.current.title || '') } : null;
      return { queue: q };
    default:
      return { queue: q };
  }
}

/** Is this a well-formed operation coming from an untrusted sender? @param {any} op */
export function isValidOp(op) {
  if (!op || typeof op !== 'object') return false;
  switch (op.type) {
    case 'add':
      return (op.position === 'next' || op.position === 'end') && !!normalizeItem(op.item);
    case 'addMany':
      return (op.position === 'next' || op.position === 'end') && Array.isArray(op.items) && op.items.length <= MAX_QUEUE;
    case 'remove':
      return VIDEO_ID.test(String(op.id));
    case 'move':
      return Number.isInteger(op.from) && Number.isInteger(op.to);
    case 'clear':
    case 'shift':
      return true;
    default:
      return false;
  }
}

/** @param {string} id */
export const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
