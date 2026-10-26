// Service worker: first-run defaults, welcome / uninstall pages, the right-click menu on video
// links, the "next in queue" keyboard shortcut, and the single writer of the play queue
// (operations from tabs, the popup and the menu are applied one after another).
// It makes no network requests.
import { normalizeSettings } from '../lib/settings.js';
import { applyOp, normalizeQueue, isValidOp, watchUrl } from '../lib/queue.js';
import { videoIdFromUrl } from '../lib/wl-parse.js';
import { brandUrls, welcomeUrlFor } from '../lib/brand.js';
import { onHost } from '../lib/hosts.js';

const HOSTS = chrome.runtime.getManifest().host_permissions || [];

const MENU_NEXT = 'ywl-play-next';
const MENU_END = 'ywl-add-end';
const LINKS = ['https://www.youtube.com/watch*', 'https://www.youtube.com/shorts/*', 'https://youtu.be/*'];

/** @param {string} key */
const msg = (key) => chrome.i18n.getMessage(key) || key;

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    const common = { contexts: /** @type {chrome.contextMenus.ContextType[]} */ (['link']), targetUrlPatterns: LINKS, documentUrlPatterns: ['https://www.youtube.com/*'] };
    chrome.contextMenus.create({ id: MENU_NEXT, title: msg('playNext'), ...common });
    chrome.contextMenus.create({ id: MENU_END, title: msg('addToQueue'), ...common });
  });
}

// ---- queue: one operation at a time ----
let chain = Promise.resolve();
/**
 * @param {import('../lib/queue.js').QueueOp} op
 * @returns {Promise<{ queue: import('../lib/queue.js').Queue, item?: any, added?: number }>}
 */
function queueOp(op) {
  const run = chain.then(async () => {
    const { queue } = await chrome.storage.local.get('queue');
    const r = applyOp(normalizeQueue(queue), op);
    await chrome.storage.local.set({ queue: r.queue });
    return r;
  });
  chain = run.then(() => {}, () => {});
  return run;
}

/** YouTube tab to act on: the active tab if it is YouTube. */
async function activeYoutubeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab && tab.id != null && onHost(tab.url, HOSTS) ? tab : null;
}

/** Play the next queued video: in the YouTube tab (inside the app, no reload) or a new tab. */
async function playNextFromQueue(tabId) {
  const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : await activeYoutubeTab();
  if (tab && tab.id != null) {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'yt:next' }).catch(() => null);
    if (r && 'ok' in r) return r.ok;
  }
  const { item } = await queueOp({ type: 'shift' });
  if (!item) return false;
  if (tab && tab.id != null) await chrome.tabs.update(tab.id, { url: watchUrl(item.id) });
  else await chrome.tabs.create({ url: watchUrl(item.id) });
  return true;
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const url = welcomeUrlFor(details && details.reason);
  if (url) chrome.tabs.create({ url }).catch(() => {});
  const { settings, queue } = await chrome.storage.local.get(['settings', 'queue']);
  await chrome.storage.local.set({ settings: normalizeSettings(settings), queue: normalizeQueue(queue) });
  createMenus();
});

chrome.runtime.onStartup.addListener(createMenus);

// Page shown after the extension is removed (a plain static page; nothing is sent to it).
try {
  chrome.runtime.setUninstallURL(brandUrls().bye).catch(() => {});
} catch {
  /* not available in this context */
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_NEXT && info.menuItemId !== MENU_END) return;
  const id = videoIdFromUrl(info.linkUrl || '');
  if (!id) return;
  const position = info.menuItemId === MENU_NEXT ? 'next' : 'end';
  // the tab knows the title of the link; without it the video is queued by id
  const r = tab && tab.id != null ? await chrome.tabs.sendMessage(tab.id, { type: 'ctx:add', videoId: id, position }).catch(() => null) : null;
  if (!r) await queueOp({ type: 'add', item: { id }, position });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'next-in-queue') playNextFromQueue().catch(() => {});
});

chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  if (!m || typeof m.type !== 'string' || sender.id !== chrome.runtime.id) return;
  if (m.type === 'queue:op') {
    if (!isValidOp(m.op) || m.op.type === 'shift') {
      sendResponse(null);
      return;
    }
    queueOp(m.op).then((r) => sendResponse({ queue: r.queue, added: r.added }), () => sendResponse(null));
    return true;
  }
  if (m.type === 'queue:advance') {
    queueOp({ type: 'shift' }).then((r) => sendResponse({ item: r.item || null }), () => sendResponse(null));
    return true;
  }
  if (m.type === 'queue:playNext') {
    playNextFromQueue(m.tabId).then((ok) => sendResponse({ ok }), () => sendResponse({ ok: false }));
    return true;
  }
});
