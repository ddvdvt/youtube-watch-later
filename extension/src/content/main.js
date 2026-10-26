// Content script module for www.youtube.com. Routes the SPA's pages to the three features:
// hover buttons (everywhere), the queue panel + auto-advance (watch pages) and the Watch Later
// cleanup panel (/playlist?list=WL). YouTube is a single-page app: pages are tracked through its
// yt-navigate-finish event, popstate and a cheap URL check as a fallback. Every entry point is
// wrapped in try/catch so a failure here never breaks YouTube.
import { normalizeSettings } from '../../lib/settings.js';
import { setHover, contextInfo, addToQueue } from './hover.js';
import { setQueuePage, playNext } from './queue-panel.js';
import { setWlPage, openWlPanel, wlJobState } from './wl-panel.js';
import { call } from './rpc.js';

/** @param {() => any} fn */
const safe = (fn) => {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch {
    /* never break YouTube */
  }
};

let settings = normalizeSettings(null);
let lastUrl = '';

const isWatchLater = () => location.pathname === '/playlist' && new URL(location.href).searchParams.get('list') === 'WL';

function route() {
  lastUrl = location.href;
  setHover(settings.hoverButtons);
  setQueuePage({ active: location.pathname === '/watch', autoAdvance: settings.autoAdvance, show: settings.queuePanel });
  setWlPage(isWatchLater(), settings);
}

export async function start() {
  const { settings: raw } = await chrome.storage.local.get('settings');
  settings = normalizeSettings(raw);
  const go = () => safe(route);
  if (document.body) go();
  else document.addEventListener('DOMContentLoaded', go, { once: true });
  window.addEventListener('yt-navigate-finish', go);
  window.addEventListener('popstate', go);
  setInterval(() => {
    if (location.href !== lastUrl) go();
  }, 1000);
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.settings) {
      settings = normalizeSettings(ch.settings.newValue);
      go();
    }
  });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return;
    if (msg.type === 'yt:play') {
      call('navigate', { videoId: msg.videoId }, 5000).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === 'yt:next') {
      playNext().then((ok) => sendResponse({ ok }));
      return true;
    }
    if (msg.type === 'ctx:add') {
      addToQueue(contextInfo(msg.videoId), msg.position === 'next' ? 'next' : 'end').then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === 'wl:open') {
      sendResponse({ ok: openWlPanel() });
      return;
    }
    if (msg.type === 'wl:state') {
      sendResponse({ wl: isWatchLater(), job: wlJobState() });
      return;
    }
  });
}
