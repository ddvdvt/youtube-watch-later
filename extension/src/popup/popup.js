import { applyI18n, t } from '../shared/i18n.js';
import { wireBrandLinks } from '../shared/brand-link.js';
import { normalizeQueue } from '../../lib/queue.js';
import { renderQueue, queueOp } from '../shared/queue-view.js';
import { onHost } from '../../lib/hosts.js';

const WL_URL = 'https://www.youtube.com/playlist?list=WL';
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** The tab the popup was opened for (?tabId= is used by the automated test). */
async function targetTab() {
  const forced = Number(new URLSearchParams(location.search).get('tabId'));
  if (forced) return chrome.tabs.get(forced).catch(() => null);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

const isYoutube = (tab) => !!tab && onHost(tab.url, chrome.runtime.getManifest().host_permissions || []);

function paint(queue) {
  renderQueue(/** @type {HTMLOListElement} */ ($('qList')), queue);
  $('qCount').textContent = String(queue.items.length);
  $('qEmpty').classList.toggle('hidden', queue.items.length > 0);
  /** @type {HTMLButtonElement} */ ($('qNext')).disabled = !queue.items.length;
  /** @type {HTMLButtonElement} */ ($('qClear')).disabled = !queue.items.length;
}

/**
 * Access to youtube.com. Chrome grants it at install; in Firefox (MV3) the user can withhold or
 * revoke it, and then no content script runs there. Shown with a button that asks again.
 */
const YT = { origins: chrome.runtime.getManifest().host_permissions || [] };
async function renderAccess() {
  const ok = await chrome.permissions.contains(YT).catch(() => true);
  $('access').classList.toggle('hidden', ok);
}

async function init() {
  applyI18n();
  wireBrandLinks();
  $('grantAccess').addEventListener('click', async () => {
    // straight from the click: permissions.request needs the user gesture
    const granted = await chrome.permissions.request(YT).catch(() => false);
    if (!granted) {
      $('accessMsg').textContent = t('accessDenied');
      return;
    }
    await renderAccess();
    const tab = await targetTab();
    if (isYoutube(tab) && tab.id != null) chrome.tabs.reload(tab.id).catch(() => {});
  });
  await renderAccess();
  const tab = await targetTab();
  const { queue } = await chrome.storage.local.get('queue');
  paint(normalizeQueue(queue));
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.queue) paint(normalizeQueue(ch.queue.newValue));
  });

  try {
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'next-in-queue');
    $('shortcut').textContent = cmd && cmd.shortcut ? t('shortcutIs', cmd.shortcut) : t('shortcutNone');
  } catch {
    /* ignore */
  }

  $('qNext').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'queue:playNext', tabId: isYoutube(tab) ? tab.id : undefined }).catch(() => null);
    if (!new URLSearchParams(location.search).get('tabId')) window.close();
  });
  $('qClear').addEventListener('click', async () => {
    if (confirm(t('clearConfirm', $('qCount').textContent || '0'))) await queueOp({ type: 'clear' });
  });

  // Watch Later: show the job of the WL tab, open the panel there or open the page
  let onWl = false;
  if (isYoutube(tab) && tab.id != null) {
    const st = await chrome.tabs.sendMessage(tab.id, { type: 'wl:state' }).catch(() => null);
    onWl = !!(st && st.wl);
    if (st && st.job) {
      const j = st.job;
      const p = $('jobState');
      p.classList.remove('hidden');
      p.textContent = t('popupJob', [t(`jobStatus_${j.status}`), String(j.handled), String(j.total)]);
    }
  }
  $('openWl').addEventListener('click', async () => {
    if (onWl && tab && tab.id != null) {
      await chrome.tabs.sendMessage(tab.id, { type: 'wl:open' }).catch(() => null);
    } else if (isYoutube(tab) && tab.id != null) {
      await chrome.tabs.update(tab.id, { url: new URL('/playlist?list=WL', tab.url).href });
    } else {
      await chrome.tabs.create({ url: WL_URL });
    }
    if (!new URLSearchParams(location.search).get('tabId')) window.close();
  });
  $('settings').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  document.body.dataset.ready = '1';
}

init();
