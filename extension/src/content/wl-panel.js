// Watch Later cleanup panel (www.youtube.com/playlist?list=WL).
// Loads the whole list through the same requests the YouTube page makes, filters it locally,
// shows a virtualised preview, saves a backup, then removes the chosen videos in throttled batches
// (pause / cancel / resume after reload). Can also re-add videos from a backup.
import { parseBrowse, formatDuration } from '../../lib/wl-parse.js';
import { defaultFilters, normalizeFilters, selectKeys, channelStats, summarize, shuffled } from '../../lib/wl-filter.js';
import { makeBackup, toJson, toCsv, backupFileName, parseBackup, restorePlan } from '../../lib/backup.js';
import { createJob, nextRange, actionsFor, classify, applyOutcome, progressOf, isResumable, estimateMs, delayFor } from '../../lib/runner.js';
import { pushBackup } from '../../lib/settings.js';
import { el, shadowHost, t, toast, downloadText, send, sleep, etaText, num } from './ui.js';
import { call } from './rpc.js';
import { playNext } from './queue-panel.js';

/** The value YouTube's own "Show unavailable videos" menu item sends (browse params). */
const SHOW_UNAVAILABLE_PARAMS = 'wgYCCAA%3D';
const ROW = 46;
const MAX_LOAD_RETRIES = 5;

const CSS = `
.launch{position:fixed;right:20px;bottom:20px;z-index:2147482500;display:flex;align-items:center;gap:8px;padding:10px 16px;border-radius:22px;border:0;background:var(--accent);color:var(--accent-fg);font-weight:500;font-size:14px;box-shadow:0 6px 20px rgba(0,0,0,.25)}
.drawer{position:fixed;top:0;right:0;bottom:0;z-index:2147482600;width:min(600px,100vw);display:flex;flex-direction:column;background:var(--bg);border-left:1px solid var(--line);box-shadow:-10px 0 30px rgba(0,0,0,.2)}
.top{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line)}
.top h2{flex:1;margin:0;font-size:17px;font-weight:600}
.body{flex:1;overflow:auto;padding:12px 16px 16px}
.sec{margin:0 0 14px}
.sec h3{margin:0 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--fg2);font-weight:600}
p{margin:0 0 8px}
.note{padding:8px 10px;border-radius:8px;background:var(--bg2);font-size:13px}
.note.warn{background:var(--warn-soft);color:var(--warn)}
.note.err{background:var(--danger-soft);color:var(--danger)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{padding:4px 10px;border-radius:14px;background:var(--bg2);font-size:12.5px}
.chip b{font-weight:600}
.f{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 0;border-bottom:1px solid var(--line)}
.f:last-child{border-bottom:0}
.f label.main{display:flex;align-items:center;gap:8px;min-width:200px;flex:1}
.f input[type=number]{width:72px}
.f input[type=text]{flex:1;min-width:160px}
.channels{width:100%;padding:4px 0 2px 24px}
.channels input[type=search]{width:100%;margin-bottom:4px}
.chlist{max-height:170px;overflow:auto;border:1px solid var(--line);border-radius:6px}
.chlist label{display:flex;gap:8px;align-items:center;padding:3px 8px;font-size:13px}
.chlist label span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chlist label em{font-style:normal;color:var(--fg2);font-size:12px}
.mode{display:flex;gap:14px;align-items:center;padding-top:6px;font-size:13px}
.mode label{display:flex;gap:6px;align-items:center}
.selbar{position:sticky;top:-12px;z-index:2;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 0;background:var(--bg)}
.selbar .count{font-size:15px;font-weight:600;flex:1}
.vlist{height:330px;overflow:auto;border:1px solid var(--line);border-radius:8px;position:relative;contain:strict}
.vspacer{position:relative}
.vrow{position:absolute;left:0;right:0;height:${ROW}px;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid var(--line)}
.vrow.sel{background:var(--danger-soft)}
.vrow .pos{width:44px;text-align:right;color:var(--fg2);font-size:12px;flex:none}
.vrow .txt{flex:1;min-width:0}
.vrow .ti{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;color:var(--fg);text-decoration:none}
.vrow .me{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11.5px;color:var(--fg2)}
.tag{display:inline-block;padding:0 5px;margin-left:4px;border-radius:4px;background:var(--bg2);font-size:11px}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.bar{height:10px;border-radius:5px;background:var(--bg2);overflow:hidden;margin:8px 0}
.bar i{display:block;height:100%;background:var(--accent);width:0;transition:width .3s}
.modal{position:absolute;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:16px}
.dialog{background:var(--bg);border-radius:12px;padding:18px;max-width:460px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,.35)}
.dialog h4{margin:0 0 10px;font-size:17px}
.dialog ul{margin:6px 0 10px;padding-left:18px;font-size:12.5px;color:var(--fg2);max-height:120px;overflow:auto}
.dialog .actions{justify-content:flex-end;margin-top:12px}
.log{font-size:12px;color:var(--fg2);max-height:110px;overflow:auto;margin:6px 0 0;padding-left:18px}
.foot{padding:8px 16px;border-top:1px solid var(--line);font-size:12px;color:var(--fg2)}
`;

/** @typedef {import('../../lib/wl-parse.js').WlItem} WlItem */

const S = {
  /** @type {ShadowRoot | null} */ root: null,
  open: false,
  /** @type {'intro' | 'loading' | 'ready' | 'job'} */ view: 'intro',
  /** @type {WlItem[]} */ items: [],
  totalHint: /** @type {number | null} */ (null),
  loadError: '',
  loadStop: false,
  filters: defaultFilters(90),
  manual: { add: new Set(), remove: new Set() },
  /** @type {Set<string>} */ selected: new Set(),
  onlySelected: false,
  chFilter: '',
  settings: { watchedPct: 90, speed: 'normal' },
  /** @type {import('../../lib/runner.js').Job | null} */ job: null,
  /** @type {import('../../lib/runner.js').JobItem[]} */ jobItems: [],
  jobLog: /** @type {string[]} */ ([]),
  pause: false,
  cancel: false,
  running: false,
  /** @type {any} */ refs: {},
  /** @type {any} */ recalcTimer: 0,
};

const view = () => S.root;

/** @param {string} key @param {any} value */
const store = (key, value) => chrome.storage.local.set({ [key]: value }).catch(() => {});

// ---------- loading ----------

async function loadAll() {
  S.view = 'loading';
  S.items = [];
  S.loadError = '';
  S.loadStop = false;
  render();
  const status = await call('status', null, 10000);
  if (status && status.hasContext === false) return loadFailed('noContext');
  if (status && status.loggedIn === false) return loadFailed('notLoggedIn');
  let r = await call('browse', { browseId: 'VLWL', params: SHOW_UNAVAILABLE_PARAMS });
  if (!r || r.status !== 200) r = await call('browse', { browseId: 'VLWL' });
  if (!r || r.status !== 200) return loadFailed(r && (r.status === 401 || r.status === 403) ? 'notLoggedIn' : 'loadHttp', String(r ? r.status : 0));
  let page = parseBrowse(r.json, 0);
  if (!page.foundList && !page.items.length) {
    S.totalHint = page.totalHint;
    if (page.totalHint) return loadFailed('format');
    S.view = 'ready';
    recalc();
    return;
  }
  S.totalHint = page.totalHint;
  add(page.items);
  let pages = 1;
  while (page.continuation && !S.loadStop) {
    await sleep(200 + Math.random() * 250);
    let tries = 0;
    let res;
    for (;;) {
      res = await call('browse', { continuation: page.continuation });
      if (res && res.status === 200) break;
      if (++tries > MAX_LOAD_RETRIES || (res && (res.status === 401 || res.status === 403 || res.status < 0))) {
        S.loadError = t('loadPartial', [num(S.items.length), String(res ? res.status : 0)]);
        page = { items: [], continuation: null, totalHint: null, unknown: 0, foundList: true };
        break;
      }
      await sleep(delayFor(1000, tries, res && res.retryAfter));
    }
    if (!res || res.status !== 200) break;
    page = parseBrowse(res.json, S.items.length);
    add(page.items);
    pages++;
    updateLoading();
  }
  if (S.loadStop) S.loadError = t('loadStopped', num(S.items.length));
  S.view = 'ready';
  recalc();
}

/** @param {WlItem[]} list */
function add(list) {
  const seen = new Set(S.items.map((i) => i.key));
  for (const it of list) if (!seen.has(it.key)) S.items.push(it);
}

/** @param {string} code @param {string} [sub] */
function loadFailed(code, sub) {
  S.view = 'intro';
  S.loadError = t(`err_${code}`, sub);
  render();
}

function updateLoading() {
  const r = S.refs.loading;
  if (!r || !r.isConnected) return;
  r.textContent = S.totalHint ? t('loadingOf', [num(S.items.length), num(S.totalHint)]) : t('loadingN', num(S.items.length));
  const bar = S.refs.loadBar;
  if (bar && S.totalHint) bar.style.width = `${Math.min(100, (S.items.length / S.totalHint) * 100)}%`;
}

// ---------- selection ----------

function recalc() {
  S.filters = normalizeFilters(S.filters);
  S.selected = selectKeys(S.items, S.filters, S.manual);
  render();
}

function recalcSoon() {
  clearTimeout(S.recalcTimer);
  S.recalcTimer = setTimeout(() => {
    S.selected = selectKeys(S.items, normalizeFilters(S.filters), S.manual);
    updateSelection();
  }, 120);
}

/** @param {WlItem} it */
function toggleManual(it) {
  if (S.selected.has(it.key)) {
    S.manual.add.delete(it.key);
    S.manual.remove.add(it.key);
    S.selected.delete(it.key);
  } else {
    S.manual.remove.delete(it.key);
    S.manual.add.add(it.key);
    S.selected.add(it.key);
  }
  updateSelection();
}

const visibleItems = () => (S.onlySelected ? S.items.filter((i) => S.selected.has(i.key)) : S.items);

function updateSelection() {
  const c = S.refs.selCount;
  if (c && c.isConnected) {
    c.textContent = t('selectedN', [num(S.selected.size), num(S.items.length)]);
    c.dataset.count = String(S.selected.size);
  }
  const del = S.refs.delBtn;
  if (del) {
    del.disabled = !S.selected.size;
    del.textContent = S.selected.size ? t('removeN', num(S.selected.size)) : t('removeNone');
  }
  for (const b of S.refs.needSel || []) b.disabled = !S.selected.size;
  if (S.refs.vlist) setupVirtual(S.refs.vlist);
}

// ---------- virtual list ----------

/** @param {HTMLElement} box */
function setupVirtual(box) {
  const list = visibleItems();
  const spacer = /** @type {HTMLElement} */ (box.firstElementChild);
  spacer.style.height = `${Math.max(list.length * ROW, 1)}px`;
  const paint = () => {
    const first = Math.max(0, Math.floor(box.scrollTop / ROW) - 6);
    const last = Math.min(list.length, Math.ceil((box.scrollTop + box.clientHeight) / ROW) + 6);
    spacer.textContent = '';
    if (!list.length) {
      spacer.append(el('p', { class: 'muted', style: 'padding:10px', text: S.onlySelected ? t('nothingSelected') : t('listEmpty') }));
      return;
    }
    for (let i = first; i < last; i++) spacer.append(rowFor(list[i], i));
  };
  box.onscroll = () => requestAnimationFrame(paint);
  paint();
}

/** @param {WlItem} it @param {number} i */
function rowFor(it, i) {
  const sel = S.selected.has(it.key);
  const cb = el('input', { type: 'checkbox', 'aria-label': t('selectRow', it.title || it.videoId) });
  /** @type {HTMLInputElement} */ (cb).checked = sel;
  cb.addEventListener('change', () => toggleManual(it));
  const flags = [];
  if (it.unavailable) flags.push(el('span', { class: 'tag', text: t('tagUnavailable') }));
  if (it.shorts) flags.push(el('span', { class: 'tag', text: 'Shorts' }));
  if (it.progress != null) flags.push(el('span', { class: 'tag', text: t('tagWatched', String(Math.round(it.progress))) }));
  const meta = [it.channel, it.durationText || formatDuration(it.duration)].filter(Boolean).join(' · ');
  return el('div', { class: `vrow${sel ? ' sel' : ''}`, style: `top:${i * ROW}px`, 'data-key': it.key, 'data-vid': it.videoId },
    cb,
    el('span', { class: 'pos', text: `#${it.index}` }),
    el('div', { class: 'txt' }, el('a', { class: 'ti', href: `/watch?v=${it.videoId}`, target: '_blank', rel: 'noopener', text: it.title || it.videoId, title: it.title }), el('span', { class: 'me' }, meta, ...flags)),
  );
}

// ---------- backup ----------

/** Download the backup files; keep the newest 3 backups in the extension's storage too. */
async function saveBackup(withCsv) {
  const now = new Date();
  const backup = makeBackup(S.items, S.selected, now);
  const name = backupFileName(now, 'json');
  downloadText(name, toJson(backup), 'application/json');
  if (withCsv) setTimeout(() => downloadText(backupFileName(now, 'csv'), toCsv(backup), 'text/csv'), 400);
  try {
    const { wlBackups } = await chrome.storage.local.get('wlBackups');
    await chrome.storage.local.set({ wlBackups: pushBackup(wlBackups, { name, ...backup }) });
  } catch {
    /* storage full: the downloaded file is the backup */
  }
  return name;
}

// ---------- jobs ----------

/** @param {import('../../lib/runner.js').JobItem[]} items @param {'remove' | 'restore'} mode @param {boolean} dry @param {string} backupName */
async function startJob(items, mode, dry, backupName) {
  S.jobItems = items;
  S.job = createJob({ mode, total: items.length, speed: S.settings.speed, dry, backupName });
  S.jobLog = [];
  S.pause = false;
  S.cancel = false;
  if (!dry) await chrome.storage.local.set({ wlJob: S.job, wlJobItems: items });
  S.view = 'job';
  render();
  runJob();
}

async function runJob() {
  if (S.running || !S.job) return;
  S.running = true;
  try {
    while (S.job && S.job.status === 'running') {
      const job = S.job;
      const range = nextRange(job);
      if (!range) break;
      const batch = S.jobItems.slice(range.from, range.to);
      /** @type {import('../../lib/runner.js').Outcome} */
      let outcome;
      let retryAfter = null;
      let message = '';
      if (job.dry) {
        outcome = 'ok';
        S.jobLog.push(t('dryLogLine', [String(job.requests + 1), String(batch.length)]));
      } else {
        const r = await call('edit', { playlistId: 'WL', actions: actionsFor(job.mode, batch) });
        if (r && r.status < 0) {
          outcome = 'auth';
          message = String(r.error || '');
        } else {
          outcome = classify(r ? r.status : 0, r && r.json);
          retryAfter = r && r.retryAfter;
          message = `HTTP ${r ? r.status : 0}`;
        }
        if (outcome !== 'ok') S.jobLog.push(t('logProblem', [String(job.requests + 1), message, outcome]));
      }
      const { job: next, waitMs } = applyOutcome(job, range, batch, outcome, { retryAfterSec: retryAfter, message });
      if (S.cancel) next.status = 'cancelled';
      else if (S.pause && next.status === 'running') next.status = 'paused';
      S.job = next;
      if (outcome === 'ok' && !job.dry && job.mode === 'remove') {
        const gone = new Set(batch.map((b) => b.k));
        S.items = S.items.filter((i) => !gone.has(i.key));
        for (const k of gone) S.selected.delete(k);
      }
      if (!job.dry) await store('wlJob', next);
      renderJob();
      if (next.status !== 'running') break;
      const until = Date.now() + (job.dry ? 40 : waitMs);
      while (Date.now() < until && !S.pause && !S.cancel) await sleep(Math.min(150, until - Date.now()));
      if (S.cancel || S.pause) {
        S.job = { ...S.job, status: S.cancel ? 'cancelled' : 'paused', updatedAt: Date.now() };
        if (!job.dry) await store('wlJob', S.job);
        renderJob();
        break;
      }
    }
  } finally {
    S.running = false;
    renderJob();
  }
}

function pauseJob() {
  S.pause = true;
  if (!S.running && S.job && S.job.status === 'running') S.job = { ...S.job, status: 'paused' };
  renderJob();
}

async function resumeJob() {
  if (!S.job) return;
  S.pause = false;
  S.cancel = false;
  S.job = { ...S.job, status: 'running', errors: 0, error: '' };
  if (!S.job.dry) await store('wlJob', S.job);
  S.view = 'job';
  render();
  runJob();
}

async function cancelJob() {
  S.cancel = true;
  if (!S.running && S.job) {
    S.job = { ...S.job, status: 'cancelled' };
    if (!S.job.dry) await store('wlJob', S.job);
  }
  renderJob();
}

async function discardJob() {
  S.job = null;
  S.jobItems = [];
  await chrome.storage.local.remove(['wlJob', 'wlJobItems']).catch(() => {});
  S.view = S.items.length ? 'ready' : 'intro';
  render();
}

// ---------- dialogs ----------

/**
 * @param {{ title: string, lines: string[], sample?: string[], ok: string, danger?: boolean }} o
 * @returns {Promise<boolean>}
 */
function confirmDialog(o) {
  return new Promise((resolve) => {
    const drawer = S.root && S.root.querySelector('.drawer');
    if (!drawer) return resolve(false);
    const prev = /** @type {HTMLElement | null} */ (S.root && S.root.activeElement);
    const close = (v) => {
      modal.remove();
      if (prev && prev.isConnected) prev.focus();
      resolve(v);
    };
    const okBtn = el('button', { type: 'button', class: `btn ${o.danger ? 'danger' : 'primary'}`, 'data-act': 'confirm', text: o.ok, onclick: () => close(true) });
    const cancelBtn = el('button', { type: 'button', class: 'btn', 'data-act': 'cancel-dialog', text: t('cancel'), onclick: () => close(false) });
    const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ywl-dlg-title' },
      el('div', { class: 'dialog' },
        el('h4', { id: 'ywl-dlg-title', text: o.title }),
        ...o.lines.map((l) => el('p', { text: l })),
        o.sample && o.sample.length ? el('ul', {}, ...o.sample.map((s) => el('li', { text: s }))) : null,
        el('div', { class: 'actions' }, cancelBtn, okBtn)));
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Tab') {
        // keep focus inside the dialog
        const f = [cancelBtn, okBtn];
        const i = f.indexOf(/** @type {any} */ (S.root && S.root.activeElement));
        e.preventDefault();
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
    });
    drawer.append(modal);
    cancelBtn.focus();
  });
}

const selectedItems = () => S.items.filter((i) => S.selected.has(i.key));
/** @param {WlItem[]} list */
const toJobItems = (list) => list.map((i) => ({ k: i.key, v: i.videoId, s: i.setVideoId, t: i.title }));
/** @param {WlItem[]} list */
const sampleOf = (list) => list.slice(0, 8).map((i) => `#${i.index} ${i.title || i.videoId}`).concat(list.length > 8 ? [t('andMore', num(list.length - 8))] : []);

async function onRemove() {
  const list = selectedItems();
  if (!list.length) return;
  const ok = await confirmDialog({
    title: t('confirmRemoveTitle', num(list.length)),
    lines: [t('confirmRemoveBackup'), t('confirmRemoveSpeed', [t(`speed_${S.settings.speed}`), etaText(estimateMs(list.length, S.settings.speed))]), t('confirmRemoveKeepOpen')],
    sample: sampleOf(list),
    ok: t('removeN', num(list.length)),
    danger: true,
  });
  if (!ok) return;
  const name = await saveBackup(false);
  toast(t('backupSaved', name));
  await startJob(toJobItems(list), 'remove', false, name);
}

async function onDryRun() {
  const list = selectedItems();
  if (!list.length) return;
  await startJob(toJobItems(list), 'remove', true, '');
}

/** @param {'order' | 'shuffle' | 'reverse'} how */
async function onEnqueue(how) {
  let list = selectedItems().filter((i) => !i.unavailable);
  if (how === 'shuffle') list = shuffled(list);
  if (how === 'reverse') list = list.slice().reverse();
  if (!list.length) return toast(t('queueNothing'));
  const r = await send({ type: 'queue:op', op: { type: 'addMany', position: 'end', items: list.map((i) => ({ id: i.videoId, title: i.title, channel: i.channel, duration: i.durationText })) } });
  if (!r || !r.queue) return toast(t('queueError'));
  toast(t('queueAddedMany', [num(r.added || list.length), num(r.queue.items.length)]));
}

/** @param {{ ok: true, rows: import('../../lib/backup.js').BackupRow[] }} parsed @param {string} label */
async function restoreFrom(parsed, label) {
  const present = new Set(S.items.map((i) => i.videoId));
  const plan = restorePlan(parsed.rows, { present });
  if (!plan.length) return toast(t('restoreNothing'));
  const ok = await confirmDialog({
    title: t('restoreTitle', num(plan.length)),
    lines: [t('restoreFrom', label), t('restoreCaveat'), S.items.length ? t('restoreSkipPresent') : t('restoreNotLoaded')],
    sample: plan.slice(0, 8).map((r) => r.title || r.videoId).concat(plan.length > 8 ? [t('andMore', num(plan.length - 8))] : []),
    ok: t('restoreN', num(plan.length)),
  });
  if (!ok) return;
  await startJob(plan.map((r) => ({ k: r.videoId, v: r.videoId, s: '', t: r.title })), 'restore', false, label);
}

async function onRestoreFile(file) {
  if (!file) return;
  if (file.size > 30 * 1024 * 1024) return toast(t('restoreBadFile'));
  const parsed = parseBackup(await file.text());
  if (!parsed.ok) return toast(t('restoreBadFile'));
  restoreFrom(parsed, file.name);
}

async function onRestoreStored(i) {
  const { wlBackups } = await chrome.storage.local.get('wlBackups');
  const b = Array.isArray(wlBackups) ? wlBackups[i] : null;
  if (!b) return;
  const parsed = parseBackup(JSON.stringify(b));
  if (parsed.ok) restoreFrom(parsed, b.name || b.createdAt);
}

// ---------- rendering ----------

function filtersSection() {
  const f = S.filters;
  const stats = channelStats(S.items);
  const onChange = () => recalcSoon();
  /** @param {string} id @param {any} obj @param {string} label @param {...any} extra */
  const row = (id, obj, label, ...extra) => {
    const cb = el('input', { type: 'checkbox', id: `f-${id}`, 'data-filter': id });
    /** @type {HTMLInputElement} */ (cb).checked = obj.on;
    cb.addEventListener('change', () => {
      obj.on = /** @type {HTMLInputElement} */ (cb).checked;
      if (id === 'channels') chBox.classList.toggle('hidden', !obj.on);
      onChange();
    });
    return el('div', { class: 'f' }, el('label', { class: 'main', for: `f-${id}` }, cb, el('span', { text: label })), ...extra);
  };
  /** @param {any} obj @param {string} key @param {string} aria @param {Record<string, any>} [a] */
  const numInput = (obj, key, aria, a = {}) => {
    const i = el('input', { type: 'number', min: '0', 'aria-label': aria, value: obj[key] ?? '', ...a });
    i.addEventListener('input', () => {
      const v = /** @type {HTMLInputElement} */ (i).value;
      obj[key] = v === '' ? null : Number(v);
      onChange();
    });
    return i;
  };
  const s = summarize(S.items, f.watched.min);
  // channels
  const chSearch = el('input', { type: 'search', placeholder: t('channelSearch'), 'aria-label': t('channelSearch'), value: S.chFilter });
  const chList = el('div', { class: 'chlist', role: 'group', 'aria-label': t('f_channels') });
  const paintChannels = () => {
    chList.textContent = '';
    const q = S.chFilter.trim().toLowerCase();
    const ids = new Set(f.channels.ids);
    const shown = stats.filter((c) => !q || c.name.toLowerCase().includes(q)).slice(0, 300);
    for (const c of shown) {
      const cb = el('input', { type: 'checkbox', 'data-channel': c.id });
      /** @type {HTMLInputElement} */ (cb).checked = ids.has(c.id);
      cb.addEventListener('change', () => {
        const set = new Set(f.channels.ids);
        if (/** @type {HTMLInputElement} */ (cb).checked) set.add(c.id);
        else set.delete(c.id);
        f.channels.ids = [...set];
        onChange();
      });
      chList.append(el('label', {}, cb, el('span', { text: c.name || t('noChannel') }), el('em', { text: num(c.count) })));
    }
    if (!shown.length) chList.append(el('p', { class: 'muted', style: 'padding:6px 8px', text: t('noChannels') }));
  };
  chSearch.addEventListener('input', () => {
    S.chFilter = /** @type {HTMLInputElement} */ (chSearch).value;
    paintChannels();
  });
  paintChannels();
  const chBox = el('div', { class: `channels${f.channels.on ? '' : ' hidden'}` }, chSearch, chList);

  const kw = el('input', { type: 'text', 'aria-label': t('f_keyword'), placeholder: t('keywordPlaceholder'), value: f.keyword.text });
  kw.addEventListener('input', () => {
    f.keyword.text = /** @type {HTMLInputElement} */ (kw).value;
    if (f.keyword.text && !f.keyword.on) {
      f.keyword.on = true;
      const c = /** @type {HTMLInputElement | null} */ (S.root && S.root.querySelector('#f-keyword'));
      if (c) c.checked = true;
    }
    onChange();
  });

  const modeAll = el('input', { type: 'radio', name: 'ywl-mode', value: 'all' });
  const modeAny = el('input', { type: 'radio', name: 'ywl-mode', value: 'any' });
  /** @type {HTMLInputElement} */ (modeAll).checked = f.mode === 'all';
  /** @type {HTMLInputElement} */ (modeAny).checked = f.mode === 'any';
  for (const r of [modeAll, modeAny]) r.addEventListener('change', () => {
    f.mode = /** @type {HTMLInputElement} */ (modeAny).checked ? 'any' : 'all';
    onChange();
  });

  return el('section', { class: 'sec', 'aria-labelledby': 'ywl-f-h' },
    el('h3', { id: 'ywl-f-h', text: t('filtersTitle') }),
    row('watched', f.watched, t('f_watched'), numInput(f.watched, 'min', t('f_watchedPct'), { min: '1', max: '100' }), el('span', { class: 'muted', text: '%' })),
    row('unavailable', f.unavailable, t('f_unavailable', num(s.unavailable))),
    row('shorts', f.shorts, t('f_shorts', num(s.shorts))),
    row('channels', f.channels, t('f_channels'), chBox),
    row('duration', f.duration, t('f_duration'), el('span', { class: 'muted', text: t('from') }), numInput(f.duration, 'min', t('f_durationMin')), el('span', { class: 'muted', text: t('to') }), numInput(f.duration, 'max', t('f_durationMax')), el('span', { class: 'muted', text: t('minutes') })),
    row('position', f.position, t('f_position'), numInput(f.position, 'keep', t('f_positionKeep'))),
    row('keyword', f.keyword, t('f_keyword'), kw),
    el('div', { class: 'mode' }, el('span', { class: 'muted', text: t('modeLabel') }), el('label', {}, modeAll, t('modeAll')), el('label', {}, modeAny, t('modeAny'))),
  );
}

function storedBackupsSection() {
  const box = el('div', { class: 'actions' });
  chrome.storage.local.get('wlBackups').then(({ wlBackups }) => {
    const list = Array.isArray(wlBackups) ? wlBackups : [];
    if (!list.length) box.append(el('span', { class: 'muted', style: 'font-size:12.5px', text: t('noStoredBackups') }));
    list.forEach((b, i) =>
      box.append(el('button', { type: 'button', class: 'btn small', 'data-act': `restore-stored-${i}`, text: t('restoreStored', [new Date(b.createdAt).toLocaleString(), num(b.selectedCount || 0)]), onclick: () => onRestoreStored(i) })),
    );
  });
  const file = el('input', { type: 'file', accept: '.json,.csv,application/json,text/csv', class: 'hidden', 'data-act': 'restore-file' });
  file.addEventListener('change', () => onRestoreFile(/** @type {HTMLInputElement} */ (file).files?.[0]));
  return el('section', { class: 'sec' },
    el('h3', { text: t('restoreSection') }),
    el('p', { class: 'muted', style: 'font-size:12.5px', text: t('restoreExplain') }),
    el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn small', 'data-act': 'restore-pick', text: t('restoreFromFile'), onclick: () => /** @type {HTMLInputElement} */ (file).click() }), file),
    el('div', { style: 'margin-top:6px' }, box),
  );
}

function introBody() {
  const parts = [
    el('p', { text: t('introText') }),
    el('p', { class: 'note', text: t('builtinNote') }),
  ];
  if (S.loadError) parts.push(el('p', { class: 'note err', role: 'alert', text: S.loadError }));
  parts.push(el('div', { class: 'actions sec' }, el('button', { type: 'button', class: 'btn primary', 'data-act': 'load', text: t('loadAll'), onclick: () => loadAll() })));
  parts.push(storedBackupsSection());
  return parts;
}

function loadingBody() {
  const label = el('p', { 'aria-live': 'polite', 'data-state': 'loading' });
  const bar = el('i');
  S.refs.loading = label;
  S.refs.loadBar = bar;
  setTimeout(updateLoading, 0);
  return [label, el('div', { class: 'bar' }, bar), el('button', { type: 'button', class: 'btn small', 'data-act': 'stop-load', text: t('stopLoading'), onclick: () => (S.loadStop = true) })];
}

function readyBody() {
  const s = summarize(S.items, S.filters.watched.min);
  const out = [];
  if (S.loadError) out.push(el('p', { class: 'note warn', role: 'status', text: S.loadError }));
  out.push(el('section', { class: 'sec' },
    el('div', { class: 'chips', 'data-state': 'ready' },
      el('span', { class: 'chip', 'data-chip': 'total' }, el('b', { text: num(s.total) }), ` ${t('chipTotal')}`),
      el('span', { class: 'chip', 'data-chip': 'watched' }, el('b', { text: num(s.watched) }), ` ${t('chipWatched', String(S.filters.watched.min))}`),
      el('span', { class: 'chip', 'data-chip': 'unavailable' }, el('b', { text: num(s.unavailable) }), ` ${t('chipUnavailable')}`),
      el('span', { class: 'chip', 'data-chip': 'shorts' }, el('b', { text: num(s.shorts) }), ' Shorts'),
      el('span', { class: 'chip' }, el('b', { text: formatHours(s.seconds) }), ` ${t('chipHours')}`)),
    S.totalHint && S.totalHint > s.total + 5 ? el('p', { class: 'muted', style: 'font-size:12.5px;margin-top:6px', text: t('hiddenHint', [num(S.totalHint), num(s.total)]) }) : null,
  ));
  out.push(el('p', { class: 'note', text: t('builtinNote') }));
  out.push(filtersSection());

  const selCount = el('span', { class: 'count', 'aria-live': 'polite', 'data-sel': '' });
  S.refs.selCount = selCount;
  const only = el('input', { type: 'checkbox', id: 'ywl-only' });
  /** @type {HTMLInputElement} */ (only).checked = S.onlySelected;
  only.addEventListener('change', () => {
    S.onlySelected = /** @type {HTMLInputElement} */ (only).checked;
    if (S.refs.vlist) S.refs.vlist.scrollTop = 0;
    updateSelection();
  });
  const vlist = el('div', { class: 'vlist', tabindex: '0', role: 'list', 'aria-label': t('previewLabel') }, el('div', { class: 'vspacer' }));
  S.refs.vlist = vlist;
  const del = el('button', { type: 'button', class: 'btn danger', 'data-act': 'remove', onclick: onRemove });
  S.refs.delBtn = del;
  const dry = el('button', { type: 'button', class: 'btn', 'data-act': 'dry', text: t('dryRun'), title: t('dryRunHint'), onclick: onDryRun });
  const speed = el('select', { 'aria-label': t('speedLabel'), 'data-act': 'speed' }, el('option', { value: 'careful', text: t('speed_careful') }), el('option', { value: 'normal', text: t('speed_normal') }));
  /** @type {HTMLSelectElement} */ (speed).value = S.settings.speed;
  speed.addEventListener('change', async () => {
    S.settings.speed = /** @type {HTMLSelectElement} */ (speed).value === 'careful' ? 'careful' : 'normal';
    const { settings } = await chrome.storage.local.get('settings');
    store('settings', { ...(settings || {}), speed: S.settings.speed });
  });
  const q1 = el('button', { type: 'button', class: 'btn small', 'data-act': 'enqueue-order', text: t('enqueueOrder'), onclick: () => onEnqueue('order') });
  const q2 = el('button', { type: 'button', class: 'btn small', 'data-act': 'enqueue-shuffle', text: t('enqueueShuffle'), onclick: () => onEnqueue('shuffle') });
  const q3 = el('button', { type: 'button', class: 'btn small', 'data-act': 'enqueue-reverse', text: t('enqueueReverse'), onclick: () => onEnqueue('reverse') });
  const qPlay = el('button', { type: 'button', class: 'btn small', 'data-act': 'queue-play', text: t('queuePlay'), onclick: () => playNext() });
  S.refs.needSel = [dry, q1, q2, q3];
  out.push(el('section', { class: 'sec' },
    el('div', { class: 'selbar' }, selCount, el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, only, t('onlySelected'))),
    vlist,
    el('p', { class: 'muted', style: 'font-size:12px;margin-top:4px', text: t('manualHint') }),
  ));
  out.push(el('section', { class: 'sec' },
    el('h3', { text: t('actionsTitle') }),
    el('div', { class: 'actions' }, del, dry, el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, t('speedLabel'), speed)),
    el('p', { class: 'muted', style: 'font-size:12px;margin-top:6px', text: t('safetyNote') }),
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'btn small', 'data-act': 'export-json', text: t('exportJson'), onclick: () => downloadText(backupFileName(new Date(), 'json'), toJson(makeBackup(S.items, S.selected)), 'application/json') }),
      el('button', { type: 'button', class: 'btn small', 'data-act': 'export-csv', text: t('exportCsv'), onclick: () => downloadText(backupFileName(new Date(), 'csv'), toCsv(makeBackup(S.items, S.selected)), 'text/csv') })),
  ));
  out.push(el('section', { class: 'sec' },
    el('h3', { text: t('queueSection') }),
    el('p', { class: 'muted', style: 'font-size:12.5px', text: t('queueSectionHint') }),
    el('div', { class: 'actions' }, q1, q2, q3, qPlay),
  ));
  out.push(storedBackupsSection());
  out.push(el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn small', 'data-act': 'reload-list', text: t('reloadList'), onclick: () => loadAll() })));
  setTimeout(updateSelection, 0);
  return out;
}

/** @param {number} sec */
function formatHours(sec) {
  const h = sec / 3600;
  return h >= 10 ? num(Math.round(h)) : h.toFixed(1).replace('.', ',');
}

function jobBody() {
  const box = el('div', { 'data-state': 'job' });
  S.refs.job = box;
  setTimeout(renderJob, 0);
  return [box];
}

function renderJob() {
  const box = S.refs.job;
  const j = S.job;
  if (!box || !box.isConnected || !j) return;
  const p = progressOf(j);
  box.textContent = '';
  const title = j.dry ? t('jobDryTitle') : j.mode === 'restore' ? t('jobRestoreTitle') : t('jobRemoveTitle');
  const bar = el('i');
  bar.style.width = `${p.pct}%`;
  const statusText = {
    running: t('jobRunning', etaText(p.etaMs)),
    paused: j.error ? t(`jobErr_${j.error}`) : t('jobPaused'),
    done: j.dry ? t('jobDryDone', [num(j.total), String(j.requests)]) : j.mode === 'restore' ? t('jobRestoreDone', num(j.done)) : t('jobDone', num(j.done)),
    cancelled: t('jobCancelled', [num(j.done), num(j.total - j.cursor)]),
    error: t(`jobErr_${j.error || 'network'}`),
  }[j.status];
  box.append(
    el('h3', { style: 'margin:0 0 6px;font-size:15px', text: title }),
    el('p', { 'data-job-status': j.status, 'data-done': String(j.done), 'aria-live': 'polite', text: t('jobProgress', [num(p.handled), num(p.total), num(p.done), num(p.failed)]) }),
    el('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(p.pct) }, bar),
    el('p', { class: `note${j.status === 'error' || j.error ? ' err' : ''}`, text: statusText }),
  );
  if (j.backupName) box.append(el('p', { class: 'muted', style: 'font-size:12.5px', text: t('jobBackup', j.backupName) }));
  const acts = el('div', { class: 'actions' });
  if (j.status === 'running') {
    acts.append(el('button', { type: 'button', class: 'btn', 'data-act': 'pause', text: t('pause'), disabled: S.pause, onclick: pauseJob }));
    acts.append(el('button', { type: 'button', class: 'btn', 'data-act': 'cancel', text: t('cancelJob'), onclick: cancelJob }));
  } else if ((j.status === 'paused' || j.status === 'error') && j.cursor < j.total) {
    acts.append(el('button', { type: 'button', class: 'btn primary', 'data-act': 'resume', text: t('resume'), disabled: S.running, onclick: resumeJob }));
    acts.append(el('button', { type: 'button', class: 'btn', 'data-act': 'cancel', text: t('cancelJob'), onclick: cancelJob }));
  } else {
    acts.append(el('button', { type: 'button', class: 'btn primary', 'data-act': 'back', text: S.items.length ? t('backToList') : t('close'), onclick: discardJob }));
    if (!j.dry) acts.append(el('button', { type: 'button', class: 'btn', 'data-act': 'reload-page', text: t('reloadPage'), onclick: () => location.reload() }));
  }
  box.append(acts);
  if (j.failed.length) {
    box.append(el('p', { class: 'muted', style: 'margin-top:10px;font-size:12.5px', text: t('jobFailedList', num(j.failed.length)) }), el('ul', { class: 'log' }, ...j.failed.slice(0, 50).map((f) => el('li', { text: `${f.t || f.v} — ${f.why}` }))));
  }
  if (S.jobLog.length) box.append(el('ul', { class: 'log', 'data-log': '' }, ...S.jobLog.slice(-30).map((l) => el('li', { text: l }))));
}

function render() {
  const root = view();
  if (!root) return;
  for (const n of [...root.children]) if (n.tagName !== 'STYLE') n.remove();
  S.refs = {};
  if (!S.open) {
    const resumable = isResumable(S.job);
    root.append(el('button', { type: 'button', class: 'launch', 'data-act': 'open', 'aria-haspopup': 'dialog', text: resumable ? t('launchResume') : t('launch'), onclick: () => { S.open = true; render(); } }));
    return;
  }
  let body;
  if (S.view === 'job' && S.job) body = jobBody();
  else if (S.view === 'loading') body = loadingBody();
  else if (S.view === 'ready') body = readyBody();
  else body = introBody();
  const drawer = el('aside', { class: 'drawer', role: 'dialog', 'aria-label': t('panelTitle') },
    el('div', { class: 'top' }, el('h2', { text: t('panelTitle') }), el('button', { type: 'button', class: 'btn icon', 'data-act': 'close', title: t('close'), 'aria-label': t('close'), text: '×', onclick: () => { S.open = false; render(); } })),
    el('div', { class: 'body' }, ...body),
    el('div', { class: 'foot', text: t('panelFoot') }),
  );
  drawer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !(S.root && S.root.querySelector('.modal'))) {
      S.open = false;
      render();
    }
  });
  root.append(drawer);
  if (S.refs.vlist) setupVirtual(S.refs.vlist);
}

// ---------- page lifecycle ----------

let mounted = false;
/**
 * Show or hide the panel. Active only on the Watch Later page.
 * @param {boolean} active
 * @param {{ watchedPct: number, speed: 'careful' | 'normal' }} settings
 */
export async function setWlPage(active, settings) {
  S.settings = { ...settings };
  if (!active) {
    if (mounted && !S.running) {
      const host = document.getElementById('ywl-wl');
      if (host) host.remove();
      S.root = null;
      mounted = false;
    }
    return;
  }
  if (mounted) return;
  mounted = true;
  S.root = shadowHost('ywl-wl', CSS).root;
  if (!S.items.length) S.filters = defaultFilters(settings.watchedPct);
  // an unfinished job (page reloaded, browser closed) can be continued
  if (!S.job) {
    try {
      const { wlJob, wlJobItems } = await chrome.storage.local.get(['wlJob', 'wlJobItems']);
      if (isResumable(wlJob) && Array.isArray(wlJobItems) && wlJobItems.length === wlJob.total) {
        S.job = { ...wlJob, status: wlJob.status === 'running' ? 'paused' : wlJob.status };
        S.jobItems = wlJobItems;
        S.view = 'job';
      }
    } catch {
      /* ignore */
    }
  }
  render();
}

/** Open the panel (from the popup). */
export function openWlPanel() {
  if (!S.root) return false;
  S.open = true;
  render();
  return true;
}

/** Current job state for the popup. */
export const wlJobState = () => (S.job ? { status: S.job.status, ...progressOf(S.job), mode: S.job.mode, dry: S.job.dry } : null);


