import { applyI18n, t } from '../shared/i18n.js';
import { wireBrandLinks } from '../shared/brand-link.js';
import { normalizeSettings, DEFAULTS } from '../../lib/settings.js';
import { normalizeQueue } from '../../lib/queue.js';
import { toJson, toCsv } from '../../lib/backup.js';
import { renderQueue, queueOp } from '../shared/queue-view.js';

const $ = (id) => /** @type {any} */ (document.getElementById(id));

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return normalizeSettings(settings);
}

let savedTimer = 0;
/** @param {Record<string, any>} patch */
async function save(patch) {
  const next = normalizeSettings({ ...(await getSettings()), ...patch });
  await chrome.storage.local.set({ settings: next });
  $('saved').textContent = t('saved');
  clearTimeout(savedTimer);
  savedTimer = /** @type {any} */ (setTimeout(() => ($('saved').textContent = ''), 1500));
  return next;
}

/** @param {import('../../lib/settings.js').Settings} s */
function fill(s) {
  for (const k of ['hoverButtons', 'autoAdvance', 'queuePanel']) $(k).checked = /** @type {any} */ (s)[k];
  $('watchedPct').value = String(s.watchedPct);
  $('speed').value = s.speed;
}

/** @param {string} name @param {string} text @param {string} type */
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function paintBackups() {
  const { wlBackups } = await chrome.storage.local.get('wlBackups');
  const list = Array.isArray(wlBackups) ? wlBackups : [];
  const ul = $('backups');
  ul.textContent = '';
  $('noBackups').classList.toggle('hidden', list.length > 0);
  $('delBackups').disabled = !list.length;
  for (const b of list) {
    const li = document.createElement('li');
    li.textContent = t('backupLine', [new Date(b.createdAt).toLocaleString(), String(b.count), String(b.selectedCount)]);
    const base = String(b.name || 'watch-later-backup.json').replace(/\.json$/, '');
    for (const [label, ext] of [['JSON', 'json'], ['CSV', 'csv']]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn small';
      btn.textContent = label;
      btn.addEventListener('click', () => download(`${base}.${ext}`, ext === 'json' ? toJson(b) : toCsv(b), ext === 'json' ? 'application/json' : 'text/csv'));
      li.append(btn);
    }
    ul.append(li);
  }
}

/** @param {ReturnType<typeof normalizeQueue>} q */
function paintQueue(q) {
  renderQueue($('qList'), q);
  $('qEmpty').classList.toggle('hidden', q.items.length > 0);
  $('qClear').disabled = !q.items.length;
}

async function init() {
  applyI18n();
  wireBrandLinks();
  $('version').textContent = `${t('version')} ${chrome.runtime.getManifest().version}`;
  fill(await getSettings());
  for (const k of ['hoverButtons', 'autoAdvance', 'queuePanel']) $(k).addEventListener('change', () => save({ [k]: $(k).checked }));
  $('watchedPct').addEventListener('change', async () => fill(await save({ watchedPct: Number($('watchedPct').value) })));
  $('speed').addEventListener('change', () => save({ speed: $('speed').value }));
  $('reset').addEventListener('click', async () => {
    await chrome.storage.local.set({ settings: DEFAULTS() });
    fill(DEFAULTS());
    $('saved').textContent = t('resetDone');
  });
  const { queue } = await chrome.storage.local.get('queue');
  paintQueue(normalizeQueue(queue));
  $('qClear').addEventListener('click', () => queueOp({ type: 'clear' }));
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.queue) paintQueue(normalizeQueue(ch.queue.newValue));
    if (ch.wlBackups) paintBackups();
    if (ch.settings) fill(normalizeSettings(ch.settings.newValue));
  });
  await paintBackups();
  $('delBackups').addEventListener('click', async () => {
    if (confirm(t('deleteBackupsConfirm'))) await chrome.storage.local.remove('wlBackups');
  });
  $('delJob').addEventListener('click', async () => {
    await chrome.storage.local.remove(['wlJob', 'wlJobItems']);
    $('saved').textContent = t('jobForgotten');
  });
  try {
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'next-in-queue');
    $('shortcut').textContent = cmd && cmd.shortcut ? t('shortcutIs', cmd.shortcut) : t('shortcutNone');
  } catch {
    /* ignore */
  }
  $('shortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    // Firefox: about:addons → Manage Extension Shortcuts (extensions cannot open about: pages directly)
    const commands = /** @type {any} */ (chrome.commands);
    if (typeof commands.openShortcutSettings === 'function') commands.openShortcutSettings();
    else chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
  document.body.dataset.ready = '1';
}

init();
