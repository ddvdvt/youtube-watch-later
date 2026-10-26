// Queue list shared by the popup and the options page (operations go through the background).
import { normalizeQueue } from '../../lib/queue.js';
import { t } from './i18n.js';

/** @param {any} op */
export async function queueOp(op) {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'queue:op', op });
    return r && r.queue ? normalizeQueue(r.queue) : null;
  } catch {
    return null;
  }
}

/**
 * @param {HTMLOListElement} list
 * @param {ReturnType<typeof normalizeQueue>} queue
 */
export function renderQueue(list, queue) {
  list.textContent = '';
  const items = queue.items;
  items.forEach((it, i) => {
    const li = document.createElement('li');
    li.dataset.id = it.id;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(i + 1);
    const txt = document.createElement('div');
    txt.className = 'txt';
    const title = document.createElement('span');
    title.textContent = it.title || it.id;
    title.title = it.title || it.id;
    const meta = document.createElement('small');
    meta.textContent = [it.channel, it.duration].filter(Boolean).join(' · ');
    txt.append(title, meta);
    /** @param {string} act @param {string} label @param {string} text @param {boolean} disabled @param {any} op */
    const btn = (act, label, text, disabled, op) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.act = act;
      b.title = label;
      b.setAttribute('aria-label', `${label}: ${it.title || it.id}`);
      b.textContent = text;
      b.disabled = disabled;
      b.addEventListener('click', () => queueOp(op));
      return b;
    };
    li.append(
      n,
      txt,
      btn('up', t('moveUp'), '↑', i === 0, { type: 'move', from: i, to: i - 1 }),
      btn('down', t('moveDown'), '↓', i === items.length - 1, { type: 'move', from: i, to: i + 1 }),
      btn('remove', t('remove'), '×', false, { type: 'remove', id: it.id }),
    );
    list.append(li);
  });
}
