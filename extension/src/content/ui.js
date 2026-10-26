// Small DOM helpers for the in-page UI. Everything the extension shows on YouTube lives in
// shadow roots, so YouTube's styles do not leak in and ours do not leak out.
import { BASE_CSS } from './styles.js';

/** @param {string} key @param {string | string[]} [subs] */
export const t = (key, subs) => {
  try {
    return chrome.i18n.getMessage(key, subs) || key;
  } catch {
    return key;
  }
};

/**
 * Create an element: el('button', { class: 'btn', onclick }, 'text', child…)
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node | string | null | undefined | false)} kids
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c != null && c !== false) e.append(c);
  return e;
}

/**
 * A fixed-position host with an open shadow root (open so automated tests can look inside).
 * @param {string} id
 * @param {string} css
 * @returns {{ host: HTMLElement, root: ShadowRoot }}
 */
export function shadowHost(id, css) {
  let host = document.getElementById(id);
  if (host && host.shadowRoot) return { host, root: host.shadowRoot };
  host = document.createElement('div');
  host.id = id;
  host.setAttribute('data-ywl', '');
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = BASE_CSS + css;
  root.append(style);
  (document.body || document.documentElement).append(host);
  return { host, root };
}

let toastTimer = 0;
/** Short notice at the bottom of the page. @param {string} text */
export function toast(text) {
  const { root } = shadowHost('ywl-toast', '.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483600;background:var(--fg);color:var(--bg);padding:10px 16px;border-radius:8px;font-size:14px;max-width:min(560px,90vw);box-shadow:0 6px 20px rgba(0,0,0,.3)}');
  let box = root.querySelector('.toast');
  if (!box) {
    box = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    root.append(box);
  }
  box.textContent = text;
  box.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = /** @type {any} */ (setTimeout(() => box && box.classList.add('hidden'), 3500));
}

/** Download text as a file from the page (blob URL + <a download>; no extra permission). */
export function downloadText(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  // keep the page's own link handling (single-page app router) away from this click
  a.addEventListener('click', (e) => e.stopPropagation());
  (document.body || document.documentElement).append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** chrome.runtime.sendMessage that never throws (extension reloaded, worker asleep…). */
export async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch {
    return null;
  }
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minutes/seconds text for an ETA. @param {number} ms */
export function etaText(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return t('etaSeconds', String(s));
  return t('etaMinutes', String(Math.round(s / 60)));
}

/** Russian-style grouping 5 012. @param {number} n */
export const num = (n) => Number(n || 0).toLocaleString(chrome.i18n.getUILanguage ? chrome.i18n.getUILanguage() : 'ru');
