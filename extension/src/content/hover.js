// Two small buttons over a video thumbnail under the mouse: "Play next" and "Add to queue".
// One floating toolbar for the whole page (no per-thumbnail injection, so YouTube's re-rendering
// cannot break it). Keyboard and alternative path: the right-click menu on any video link.
import { VIDEO_LINK, THUMB_HINT, ITEM, TITLE, CHANNEL, DURATION } from '../../lib/selectors.js';
import { videoIdFromUrl } from '../../lib/wl-parse.js';
import { el, shadowHost, t, toast, send } from './ui.js';

const CSS = `
.bar{position:fixed;z-index:2147483000;display:flex;gap:4px;padding:3px;border-radius:16px;background:rgba(15,15,15,.78);backdrop-filter:blur(4px)}
.bar button{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 9px;border:0;border-radius:13px;background:transparent;color:#fff;font:500 12.5px/1 Roboto,"Segoe UI",Arial,sans-serif}
.bar button:hover,.bar button:focus-visible{background:rgba(255,255,255,.22)}
.bar svg{width:14px;height:14px;fill:currentColor;flex:none}
.bar.compact button{padding:0 7px}
.bar.compact .lbl{display:none}
`;

const ICON_NEXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14l9-7zM16 5h3v14h-3z"/></svg>';
/** An icon as a DOM node (parsed in an inert document, no innerHTML on the page). @param {string} markup */
const icon = (markup) => /** @type {Element} */ (new DOMParser().parseFromString(markup, 'text/html').body.firstElementChild);
const ICON_ADD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h12v2H3zm0 5h12v2H3zm0 5h8v2H3zm14-3V9h2v4h4v2h-4v4h-2v-4h-4v-2z"/></svg>';

/** @type {{ bar: HTMLElement | null, anchor: HTMLAnchorElement | null, hideTimer: any, enabled: boolean, seen: number }} */
const H = { bar: null, anchor: null, hideTimer: 0, enabled: false, seen: 0 };

/**
 * Title, channel and duration of the item a link belongs to.
 * @param {Element} a
 * @param {string} id
 */
export function infoFor(a, id) {
  const item = a.closest(ITEM);
  const scope = item || a.parentElement || a;
  const pick = (sel) => {
    const n = scope.querySelector(sel);
    return n ? (n.getAttribute('title') || n.textContent || '').replace(/\s+/g, ' ').trim() : '';
  };
  let title = pick(TITLE) || a.getAttribute('title') || a.getAttribute('aria-label') || '';
  if (!title) {
    // a link to the same video elsewhere in the item (the title link)
    for (const l of scope.querySelectorAll(VIDEO_LINK)) {
      const txt = (l.getAttribute('title') || l.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt && videoIdFromUrl(l.getAttribute('href') || '', location.href) === id) {
        title = txt;
        break;
      }
    }
  }
  return { id, title: title.slice(0, 300), channel: pick(CHANNEL).slice(0, 120), duration: pick(DURATION).slice(0, 12) };
}

/** @param {EventTarget | null} target */
function thumbLinkFrom(target) {
  if (!(target instanceof Element)) return null;
  if (target.closest('[data-ywl]')) return null;
  const a = /** @type {HTMLAnchorElement | null} */ (target.closest(VIDEO_LINK));
  if (!a || !a.querySelector(THUMB_HINT)) return null;
  const r = a.getBoundingClientRect();
  if (r.width < 100 || r.height < 56) return null;
  return a;
}

function bar() {
  if (H.bar && H.bar.isConnected) return H.bar;
  const { root } = shadowHost('ywl-hover', CSS);
  const b = el('div', { class: 'bar hidden', role: 'toolbar', 'aria-label': t('queueTitle') });
  const next = el('button', { type: 'button', 'data-act': 'next', title: t('playNextHint'), 'aria-label': t('playNext') });
  next.append(icon(ICON_NEXT));
  next.append(el('span', { class: 'lbl', text: t('hoverNext') }));
  const end = el('button', { type: 'button', 'data-act': 'end', title: t('addToQueueHint'), 'aria-label': t('addToQueue') });
  end.append(icon(ICON_ADD));
  end.append(el('span', { class: 'lbl', text: t('hoverEnd') }));
  b.append(next, end);
  b.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!btn || !H.anchor) return;
    e.preventDefault();
    e.stopPropagation();
    const id = videoIdFromUrl(H.anchor.getAttribute('href') || '', location.href);
    if (!id) return;
    const position = btn.dataset.act === 'next' ? 'next' : 'end';
    addToQueue(infoFor(H.anchor, id), position);
  });
  b.addEventListener('pointerleave', scheduleHide);
  b.addEventListener('pointerenter', () => clearTimeout(H.hideTimer));
  root.append(b);
  H.bar = b;
  return b;
}

/**
 * @param {{ id: string, title: string, channel: string, duration: string }} info
 * @param {'next' | 'end'} position
 */
export async function addToQueue(info, position) {
  const r = await send({ type: 'queue:op', op: { type: 'add', item: info, position } });
  if (!r || !r.queue) return toast(t('queueError'));
  const name = info.title || info.id;
  toast(position === 'next' ? t('toastNext', name) : t('toastEnd', [name, String(r.queue.items.length)]));
}

/** @param {HTMLAnchorElement} a */
function show(a) {
  clearTimeout(H.hideTimer);
  H.anchor = a;
  const b = bar();
  const r = a.getBoundingClientRect();
  b.style.left = `${Math.round(r.left + 6)}px`;
  b.style.top = `${Math.round(r.top + 6)}px`;
  // small thumbnails (sidebar, playlists): icons only, the labels stay as tooltips and aria-labels
  b.classList.remove('compact');
  b.classList.remove('hidden');
  if (b.offsetWidth > r.width - 12) b.classList.add('compact');
  H.seen = Date.now();
}

function hide() {
  if (H.bar) H.bar.classList.add('hidden');
  H.anchor = null;
}

function scheduleHide() {
  clearTimeout(H.hideTimer);
  H.hideTimer = setTimeout(hide, 250);
}

/** @param {PointerEvent} e */
function onOver(e) {
  if (!H.enabled) return;
  const a = thumbLinkFrom(e.target);
  if (a) show(a);
}

/** @param {PointerEvent} e */
function onMove(e) {
  if (!H.anchor || !H.bar || H.bar.classList.contains('hidden')) return;
  const r = H.anchor.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  const path = e.composedPath ? e.composedPath() : [];
  if (inside || path.includes(H.bar)) clearTimeout(H.hideTimer);
  else scheduleHide();
}

let installed = false;
/** @param {boolean} enabled */
export function setHover(enabled) {
  H.enabled = enabled;
  if (!enabled) hide();
  if (installed || !enabled) return;
  installed = true;
  document.addEventListener('pointerover', (e) => {
    try {
      onOver(e);
    } catch {
      /* never break YouTube */
    }
  }, true);
  document.addEventListener('pointermove', (e) => {
    try {
      onMove(e);
    } catch {
      /* ignore */
    }
  }, { capture: true, passive: true });
  window.addEventListener('scroll', hide, { capture: true, passive: true });
}

// The right-click menu item (created by the background) does not know the title: remember the
// last link the menu was opened on, the background asks for it.
/** @type {{ id: string, title: string, channel: string, duration: string } | null} */
let lastContext = null;
document.addEventListener('contextmenu', (e) => {
  try {
    const a = e.target instanceof Element ? e.target.closest(VIDEO_LINK) : null;
    const id = a && videoIdFromUrl(a.getAttribute('href') || '', location.href);
    lastContext = a && id ? infoFor(a, id) : null;
  } catch {
    lastContext = null;
  }
}, true);

/** @param {string} id */
export function contextInfo(id) {
  return lastContext && lastContext.id === id ? lastContext : { id, title: '', channel: '', duration: '' };
}
