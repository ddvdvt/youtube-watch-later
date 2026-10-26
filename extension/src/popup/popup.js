import { applyI18n, t } from '../shared/i18n.js';
import { wireBrandLinks } from '../shared/brand-link.js';
import { normalizeQueue } from '../../lib/queue.js';
import { renderQueue, queueOp } from '../shared/queue-view.js';

const WL_URL = 'https://www.youtube.com/playlist?list=WL';
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** The tab the popup was opened for (?tabId= is used by the automated test). */
async function targetTab() {
  const forced = Number(new URLSearchParams(location.search).get('tabId'));
  if (forced) return chrome.tabs.get(forced).catch(() => null);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

const isYoutube = (tab) => !!tab && /^https:\/\/www\.youtube\.com\//.test(tab.url || '');

function paint(queue) {
  renderQueue(/** @type {HTMLOListElement} */ ($('qList')), queue);
  $('qCount').textContent = String(queue.items.length);
  $('qEmpty').classList.toggle('hidden', queue.items.length > 0);
  /** @type {HTMLButtonElement} */ ($('qNext')).disabled = !queue.items.length;
  /** @type {HTMLButtonElement} */ ($('qClear')).disabled = !queue.items.length;
}

async function init() {
  applyI18n();
  wireBrandLinks();
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
      await chrome.tabs.update(tab.id, { url: WL_URL });
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
