// Queue panel on watch pages and the auto-advance: when the current video ends, the next video
// of the extension's queue opens (whether YouTube's autoplay is on or off).
import { normalizeQueue } from '../../lib/queue.js';
import { PLAYER, AD_CLASSES } from '../../lib/selectors.js';
import { el, shadowHost, t, send, toast } from './ui.js';
import { call } from './rpc.js';

const CSS = `
.panel{position:fixed;right:16px;bottom:16px;z-index:2147482000;width:340px;max-width:calc(100vw - 32px);background:var(--bg);border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.22);overflow:hidden}
.head{display:flex;align-items:center;gap:8px;padding:8px 10px 8px 14px;background:var(--bg2)}
.head b{flex:1;font-size:14px}
.count{display:inline-block;min-width:22px;padding:1px 7px;border-radius:11px;background:var(--accent);color:var(--accent-fg);font-size:12px;text-align:center}
.now{padding:6px 14px;font-size:12.5px;border-bottom:1px solid var(--line)}
ol{list-style:none;margin:0;padding:4px 0;max-height:min(46vh,360px);overflow:auto}
li{display:flex;align-items:center;gap:6px;padding:5px 8px 5px 6px;border-top:1px solid transparent;border-bottom:1px solid transparent}
li:hover{background:var(--bg2)}
li.drag{opacity:.45}
li.over{border-top-color:var(--accent)}
.grip{cursor:grab;color:var(--fg2);padding:0 2px;user-select:none;font-size:15px;line-height:1}
.n{width:20px;text-align:right;color:var(--fg2);font-size:12px;flex:none}
.txt{flex:1;min-width:0}
.txt a{display:block;color:var(--fg);text-decoration:none;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.txt a:hover{text-decoration:underline}
.txt small{display:block;color:var(--fg2);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-btns{display:flex;gap:2px;opacity:.65}
li:hover .row-btns,li:focus-within .row-btns{opacity:1}
.row-btns button{border:0;background:transparent;width:24px;height:24px;border-radius:50%;color:var(--fg2)}
.row-btns button:hover{background:var(--line);color:var(--fg)}
.foot{display:flex;gap:6px;padding:8px 10px;border-top:1px solid var(--line);align-items:center}
.foot .grow{flex:1}
.pill{position:fixed;right:16px;bottom:16px;z-index:2147482000;display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:20px;border:1px solid var(--line);background:var(--bg);box-shadow:0 6px 20px rgba(0,0,0,.2);font-size:13px}
.empty{padding:10px 14px;font-size:12.5px}
`;

/** @type {{ root: ShadowRoot | null, queue: ReturnType<typeof normalizeQueue>, collapsed: boolean, active: boolean, autoAdvance: boolean, show: boolean, advancing: boolean, dragFrom: number }} */
const Q = { root: null, queue: normalizeQueue(null), collapsed: false, active: false, autoAdvance: true, show: true, advancing: false, dragFrom: -1 };

const currentId = () => new URL(location.href).searchParams.get('v') || '';

function ensureRoot() {
  if (Q.root && Q.root.host.isConnected) return Q.root;
  Q.root = shadowHost('ywl-queue', CSS).root;
  return Q.root;
}

/** @param {any} op */
async function op(o) {
  const r = await send({ type: 'queue:op', op: o });
  if (r && r.queue) {
    Q.queue = normalizeQueue(r.queue);
    render();
  }
}

/** Open the next queued video now. Returns false when the queue is empty. */
export async function playNext() {
  if (Q.advancing) return true;
  Q.advancing = true;
  try {
    const r = await send({ type: 'queue:advance' });
    const item = r && r.item;
    if (!item) {
      toast(t('queueEmpty'));
      return false;
    }
    await call('navigate', { videoId: item.id }, 5000);
    return true;
  } finally {
    setTimeout(() => (Q.advancing = false), 2000);
  }
}

function render() {
  const root = ensureRoot();
  for (const n of [...root.children]) if (n.tagName !== 'STYLE') n.remove();
  if (!Q.active || !Q.show) return;
  const items = Q.queue.items;
  if (!items.length) return; // nothing to show: the panel appears with the first queued video
  if (Q.collapsed) {
    root.append(
      el('div', { class: 'pill' }, el('span', { class: 'count', text: String(items.length) }), el('span', { text: t('queueTitle') }),
        el('button', { type: 'button', class: 'btn small', 'data-act': 'expand', text: t('show'), onclick: () => { Q.collapsed = false; render(); } }),
        el('button', { type: 'button', class: 'btn small primary', 'data-act': 'next', text: t('nextNow'), onclick: () => playNext() })),
    );
    return;
  }
  const cur = Q.queue.current && Q.queue.current.id === currentId() ? Q.queue.current : null;
  const list = el('ol', { 'aria-label': t('queueTitle') });
  items.forEach((it, i) => {
    const li = el('li', { draggable: 'true', 'data-id': it.id, 'data-i': String(i) },
      el('span', { class: 'grip', 'aria-hidden': 'true', text: '⋮⋮' }),
      el('span', { class: 'n', text: String(i + 1) }),
      el('div', { class: 'txt' }, el('a', { href: `/watch?v=${it.id}`, text: it.title || it.id, title: it.title || it.id, onclick: (e) => { e.preventDefault(); op({ type: 'remove', id: it.id }).then(() => call('navigate', { videoId: it.id }, 5000)); } }),
        el('small', { text: [it.channel, it.duration].filter(Boolean).join(' · ') })),
      el('div', { class: 'row-btns' },
        el('button', { type: 'button', 'data-act': 'up', title: t('moveUp'), 'aria-label': `${t('moveUp')}: ${it.title || it.id}`, disabled: i === 0, text: '↑', onclick: () => op({ type: 'move', from: i, to: i - 1 }) }),
        el('button', { type: 'button', 'data-act': 'down', title: t('moveDown'), 'aria-label': `${t('moveDown')}: ${it.title || it.id}`, disabled: i === items.length - 1, text: '↓', onclick: () => op({ type: 'move', from: i, to: i + 1 }) }),
        el('button', { type: 'button', 'data-act': 'remove', title: t('remove'), 'aria-label': `${t('remove')}: ${it.title || it.id}`, text: '×', onclick: () => op({ type: 'remove', id: it.id }) })),
    );
    li.addEventListener('dragstart', (e) => {
      Q.dragFrom = i;
      li.classList.add('drag');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', it.id);
      }
    });
    li.addEventListener('dragend', () => li.classList.remove('drag'));
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      li.classList.add('over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('over'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('over');
      if (Q.dragFrom >= 0 && Q.dragFrom !== i) op({ type: 'move', from: Q.dragFrom, to: i });
      Q.dragFrom = -1;
    });
    list.append(li);
  });
  root.append(
    el('section', { class: 'panel', 'aria-label': t('queueTitle') },
      el('div', { class: 'head' }, el('b', { text: t('queueTitle') }), el('span', { class: 'count', text: String(items.length) }),
        el('button', { type: 'button', class: 'btn icon', 'data-act': 'collapse', title: t('hide'), 'aria-label': t('hide'), text: '–', onclick: () => { Q.collapsed = true; render(); } })),
      cur ? el('div', { class: 'now muted', text: t('nowFromQueue', cur.title || cur.id) }) : null,
      list,
      el('div', { class: 'foot' },
        el('button', { type: 'button', class: 'btn small primary', 'data-act': 'next', text: t('nextNow'), onclick: () => playNext() }),
        el('span', { class: 'grow muted', style: 'font-size:12px', text: Q.autoAdvance ? t('autoAdvanceOn') : t('autoAdvanceOff') }),
        el('button', { type: 'button', class: 'btn small', 'data-act': 'clear', text: t('clear'), onclick: () => { if (confirm(t('clearConfirm', String(items.length)))) op({ type: 'clear' }); } })),
    ),
  );
}

/** The <video> of the main player finished. */
function onEnded(e) {
  try {
    if (!Q.active || !Q.autoAdvance || !Q.queue.items.length) return;
    const v = e.target;
    if (!(v instanceof HTMLVideoElement)) return;
    const player = document.querySelector(PLAYER);
    if (player && !player.contains(v)) return; // a preview or another video, not the main player
    if (player && AD_CLASSES.some((c) => player.classList.contains(c))) return; // an ad finished, not the video
    playNext();
  } catch {
    /* never break YouTube */
  }
}

let installed = false;
/**
 * @param {{ active: boolean, autoAdvance: boolean, show: boolean }} o
 */
export function setQueuePage(o) {
  Q.active = o.active;
  Q.autoAdvance = o.autoAdvance;
  Q.show = o.show;
  if (!installed) {
    installed = true;
    document.addEventListener('ended', onEnded, true); // media events do not bubble, capture does reach them
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.queue) {
        Q.queue = normalizeQueue(ch.queue.newValue);
        render();
      }
    });
    chrome.storage.local.get('queue').then(({ queue }) => {
      Q.queue = normalizeQueue(queue);
      render();
    });
  }
  render();
}
