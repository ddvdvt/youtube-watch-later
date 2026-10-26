// E2E: load the unpacked extension into the locally installed Chromium and run it against LOCAL
// fixture pages (e2e/fixtures/site.mjs) with a fake innertube API that records every request.
// The real site is never contacted.
//
// Test-only changes, made in a temporary copy of the extension (never in the real manifest):
//  - host_permissions / content_scripts / web_accessible_resources also match http://127.0.0.1/*;
//  - lib/brand.js BASE points at this local server (welcome page).
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { route, createApi } from './fixtures/site.mjs';
import { spec, videoIdOf } from './fixtures/wl-data.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.env.CHROMIUM_PATH || join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');
if (!existsSync(exe)) {
  console.error(`Chromium not found at ${exe}. Set CHROMIUM_PATH.`);
  process.exit(1);
}

let passed = 0;
async function step(name, fn) {
  const t0 = Date.now();
  await fn();
  passed++;
  console.log(`ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, timeout = 20000) {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(100)) if (await fn()) return;
  throw new Error(`timed out waiting for ${what}`);
}

const api = createApi({ total: 5000 });
const server = createServer(async (req, res) => {
  try {
    const url = req.url || '/';
    const path = url.split('?')[0];
    if (req.method === 'POST' && path.startsWith('/youtubei/v1/')) {
      let raw = '';
      for await (const c of req) raw += c;
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* bad body */
      }
      const r = api.handle(path, body, /** @type {any} */ (req.headers));
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
      res.end(JSON.stringify(r.json));
      return;
    }
    if (path.startsWith('/brand/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>brand ${path}</title>`);
      return;
    }
    const r = route(url, api);
    if (!r) throw new Error('404');
    res.writeHead(200, { 'content-type': r.type || 'text/html; charset=utf-8' });
    res.end(r.body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = /** @type {any} */ (server.address()).port;
const O = `http://127.0.0.1:${port}`;

const work = await mkdtemp(join(tmpdir(), 'youtube-watch-later-e2e-'));
const extDir = join(work, 'extension');
await cp(join(ROOT, 'extension'), extDir, { recursive: true });
const manifest = JSON.parse(await readFile(join(extDir, 'manifest.json'), 'utf8'));
const local = ['http://127.0.0.1/*'];
manifest.host_permissions = [...manifest.host_permissions, ...local];
for (const cs of manifest.content_scripts) cs.matches = [...cs.matches, ...local];
manifest.web_accessible_resources[0].matches = [...manifest.web_accessible_resources[0].matches, ...local];
await writeFile(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
const brandBase = `${O}/brand/`;
const brandFile = join(extDir, 'lib', 'brand.js');
const brandSrc = await readFile(brandFile, 'utf8');
const patched = brandSrc.replace(/export const BASE = '[^']*';/, `export const BASE = '${brandBase}';`);
assert.notEqual(patched, brandSrc);
await writeFile(brandFile, patched);

const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  executablePath: exe,
  headless: false,
  locale: 'ru-RU',
  acceptDownloads: true,
  viewport: { width: 1280, height: 900 },
  args: ['--headless=new', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage', '--renderer-process-limit=2', '--lang=ru'],
});

const errors = [];
const watchErrors = (p, label) => {
  p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && errors.push(`${label}: ${m.text()}`));
};
const edits = () => api.st.log.filter((e) => e.path.endsWith('/edit_playlist'));
const browses = () => api.st.log.filter((e) => e.path.endsWith('/browse'));

let exitCode = 0;
try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const storage = (keys) => sw.evaluate((k) => chrome.storage.local.get(k), keys);
  const setStorage = (obj) => sw.evaluate((o) => chrome.storage.local.set(o), obj);

  await step('fresh install opens the welcome page; settings and an empty queue are initialised', async () => {
    let found = null;
    for (let i = 0; i < 50 && !found; i++) {
      found = context.pages().find((p) => p.url() === `${brandBase}welcome/youtube-watch-later.html`);
      if (!found) await sleep(200);
    }
    assert.ok(found, 'welcome tab opened');
    await found.close();
    await until(async () => (await storage('settings')).settings, 'settings');
    const { settings, queue } = await storage(['settings', 'queue']);
    assert.deepEqual(settings, { hoverButtons: true, autoAdvance: true, queuePanel: true, watchedPct: 90, speed: 'normal' });
    assert.deepEqual(queue, { items: [], current: null });
  });

  const page = await context.newPage();
  watchErrors(page, 'page');
  const wl = async () => {
    await page.goto(`${O}/playlist?list=WL`);
    await page.locator('[data-act="open"]').waitFor({ timeout: 10000 });
  };
  const selCount = async () => Number(await page.locator('[data-sel]').getAttribute('data-count'));
  const loadList = async () => {
    await page.locator('[data-act="load"]').click();
    await page.locator('[data-state="ready"]').waitFor({ timeout: 60000 });
  };
  const jobDone = (status = 'done') => page.locator(`[data-job-status="${status}"]`).waitFor({ timeout: 60000 });
  const back = () => page.locator('[data-act="back"]').click();

  await step('Watch Later: the whole list of 5000 loads in 50 requests, page stays responsive, list is virtualised', async () => {
    await wl();
    await page.locator('[data-act="open"]').click();
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__maxGap = 0;
      let last = performance.now();
      w.__gapTimer = setInterval(() => {
        const now = performance.now();
        w.__maxGap = Math.max(w.__maxGap, now - last);
        last = now;
      }, 50);
    });
    await loadList();
    const maxGap = await page.evaluate(() => (clearInterval(/** @type {any} */ (window).__gapTimer), /** @type {any} */ (window).__maxGap));
    assert.ok(maxGap < 1000, `main thread blocked for ${Math.round(maxGap)} ms`);
    assert.equal(await page.locator('[data-chip="total"] b').textContent(), (5000).toLocaleString('ru-RU'));
    assert.equal(browses().length, 50);
    assert.ok(browses().every((e) => e.auth && e.status === 200), 'every request carries a valid SAPISIDHASH header');
    assert.equal(browses()[0].body.browseId, 'VLWL');
    assert.equal(browses()[1].body.continuation, 'page-100');
    assert.equal(browses()[0].body.context.client.clientName, 'WEB');
    const rows = await page.locator('.vrow').count();
    assert.ok(rows > 5 && rows < 40, `${rows} rows in the DOM for 5000 items`);
    assert.equal(edits().length, 0);
    console.log(`    max main-thread gap while loading: ${Math.round(maxGap)} ms`);
  });

  const unavailable = Array.from({ length: 5000 }, (_, k) => k + 1).filter((i) => spec(i).unavailable);

  await step('filter "unavailable": live count; dry run walks the plan without a single request', async () => {
    await page.locator('#f-unavailable').check();
    await until(async () => (await selCount()) === unavailable.length, 'selection count');
    await page.locator('#ywl-only').check();
    assert.equal(await page.locator('.vrow').first().getAttribute('data-vid'), videoIdOf(unavailable[0]));
    await page.locator('[data-act="dry"]').click();
    await jobDone();
    assert.equal(edits().length, 0, 'dry run sends nothing');
    assert.match(await page.locator('[data-job-status]').textContent(), /Обработано 135 из 135/);
    assert.match(await page.locator('[data-state="job"]').textContent(), /не ушло ни одного запроса/);
    const { wlJob } = await storage('wlJob');
    assert.equal(wlJob, undefined, 'dry runs are not saved as resumable jobs');
    await back();
    await until(async () => (await selCount()) === unavailable.length, 'selection kept');
  });

  await step('remove 135 unavailable: confirm with exact number, backup downloaded first, pilot request, batches of 25, throttled', async () => {
    const dl = page.waitForEvent('download');
    await page.locator('[data-act="remove"]').click();
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    assert.match(await dialog.textContent(), /Удалить 135 видео/);
    await page.locator('[data-act="confirm"]').click();
    const download = await dl;
    assert.match(download.suggestedFilename(), /^watch-later-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    const backup = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(backup.count, 5000);
    assert.equal(backup.selectedCount, 135);
    assert.ok(backup.items.filter((r) => r.selected).every((r) => r.unavailable));
    await jobDone();
    const e = edits();
    assert.deepEqual(e.map((x) => x.body.actions.length), [1, 25, 25, 25, 25, 25, 9]);
    assert.ok(e.every((x) => x.auth && x.status === 200 && x.body.playlistId === 'WL'));
    const removed = e.flatMap((x) => x.body.actions);
    assert.ok(removed.every((a) => a.action === 'ACTION_REMOVE_VIDEO'));
    assert.deepEqual(removed.map((a) => a.setVideoId).sort(), unavailable.map((i) => spec(i).setVideoId).sort());
    const gaps = e.slice(1).map((x, k) => x.t - e[k].t);
    assert.ok(Math.min(...gaps) >= 900, `requests ${gaps.join(', ')} ms apart`);
    assert.equal(api.st.list.length, 5000 - 135);
    const { wlBackups, wlJob } = await storage(['wlBackups', 'wlJob']);
    assert.equal(wlBackups.length, 1);
    assert.equal(wlJob.status, 'done');
    console.log(`    gaps between requests: ${Math.min(...gaps)}–${Math.max(...gaps)} ms`);
    await back();
    assert.equal(await page.locator('[data-chip="unavailable"] b').textContent(), '0');
  });

  let channelSel = 0;
  let removedInPausedJob = [];
  await step('pause stops requests; reload; continue resumes where it stopped; 429 backs off with Retry-After', async () => {
    await page.locator('#f-unavailable').uncheck();
    await page.locator('#ywl-only').uncheck();
    await page.locator('#f-channels').check();
    await page.locator('[data-channel]').first().check();
    await until(async () => (await selCount()) > 100, 'channel selection');
    channelSel = await selCount();
    const before = edits().length;
    await page.locator('[data-act="remove"]').click();
    const dl = page.waitForEvent('download');
    await page.locator('[data-act="confirm"]').click();
    await dl;
    await until(async () => edits().length >= before + 3, 'three requests');
    await page.locator('[data-act="pause"]').click();
    await jobDone('paused');
    const n = edits().length;
    await sleep(2500);
    assert.equal(edits().length, n, 'no requests while paused');
    const { wlJob } = await storage('wlJob');
    assert.equal(wlJob.status, 'paused');
    assert.ok(wlJob.cursor > 0 && wlJob.cursor < channelSel);
    await page.reload();
    const launch = page.locator('[data-act="open"]');
    await launch.waitFor();
    assert.equal(await launch.textContent(), 'Продолжить удаление');
    await launch.click();
    assert.match(await page.locator('[data-job-status]').textContent(), new RegExp(`из ${channelSel}`));
    api.st.fail = [{ status: 429, retryAfter: 3 }];
    await page.locator('[data-act="resume"]').click();
    await jobDone();
    const e = edits().slice(before);
    const i429 = e.findIndex((x) => x.status === 429);
    assert.ok(i429 > 0, 'a 429 was answered');
    assert.ok(e[i429 + 1].t - e[i429].t >= 2900, `waited ${e[i429 + 1].t - e[i429].t} ms after 429 (Retry-After: 3)`);
    const ok = e.filter((x) => x.status === 200).flatMap((x) => x.body.actions.map((a) => a.setVideoId));
    assert.equal(ok.length, channelSel);
    assert.equal(new Set(ok).size, channelSel, 'nothing removed twice');
    removedInPausedJob = ok;
    assert.equal(api.st.list.length, 5000 - 135 - channelSel);
  });

  const shorts = () => api.st.list.filter((i) => spec(i).shorts);
  let shortsBefore = 0;
  let cancelledRemoved = [];
  await step('add a selection to the queue from the list; cancel a running removal: the rest stays untouched', async () => {
    await back();
    await page.locator('[data-act="load"]').click();
    await page.locator('[data-state="ready"]').waitFor({ timeout: 60000 });
    await page.locator('#f-keyword').check();
    await page.locator('input[placeholder="слова через запятую"]').fill('хлеб');
    await until(async () => (await selCount()) > 0, 'keyword selection');
    const kw = await selCount();
    await page.locator('[data-act="enqueue-order"]').click();
    await until(async () => (await storage('queue')).queue.items.length === kw, 'queue filled');
    await setStorage({ queue: { items: [], current: null } });
    await page.locator('#f-keyword').uncheck();
    await page.locator('#f-shorts').check();
    shortsBefore = shorts().length;
    await until(async () => (await selCount()) === shortsBefore, 'shorts selection');
    const before = edits().length;
    await page.locator('[data-act="remove"]').click();
    const dl = page.waitForEvent('download');
    await page.locator('[data-act="confirm"]').click();
    await dl;
    await until(async () => edits().length >= before + 2, 'two requests');
    await page.locator('[data-act="cancel"]').click();
    await jobDone('cancelled');
    await sleep(2000);
    const e = edits().slice(before);
    cancelledRemoved = e.flatMap((x) => x.body.actions.map((a) => a.setVideoId));
    assert.ok(cancelledRemoved.length >= 26 && cancelledRemoved.length < shortsBefore);
    assert.equal(shorts().length, shortsBefore - cancelledRemoved.length, 'the rest is untouched');
    assert.equal((await storage('wlJob')).wlJob.status, 'cancelled');
  });

  await step('restore from the stored backup re-adds exactly the removed videos (ACTION_ADD_VIDEO)', async () => {
    await back();
    await page.locator('[data-act="restore-stored-0"]').click();
    assert.match(await page.locator('[role="dialog"][aria-modal="true"]').textContent(), new RegExp(`Вернуть ${cancelledRemoved.length} видео`));
    const before = edits().length;
    await page.locator('[data-act="confirm"]').click();
    await jobDone();
    const adds = edits().slice(before).flatMap((x) => x.body.actions);
    assert.ok(adds.every((a) => a.action === 'ACTION_ADD_VIDEO'));
    const want = cancelledRemoved.map((s) => videoIdOf(Number.parseInt(s.slice(1), 16))).sort();
    assert.deepEqual(adds.map((a) => a.addedVideoId).sort(), want);
    assert.equal(shorts().length, shortsBefore);
    assert.ok(removedInPausedJob.length > 0);
  });

  // ---------- queue ----------
  await page.goto(`${O}/`);
  await page.locator('yt-lockup-view-model').first().waitFor();
  const thumbs = page.locator('a.ytLockupViewModelContentImage');
  const idAt = async (k) => new URL(await thumbs.nth(k).getAttribute('href'), O).searchParams.get('v');
  const queueIds = async () => (await storage('queue')).queue.items.map((i) => i.id);

  await step('hover buttons on thumbnails: "Play next" puts first, "Add to queue" appends, titles are kept', async () => {
    await page.waitForTimeout(500);
    await thumbs.nth(0).hover();
    await page.locator('.bar [data-act="next"]').click();
    await thumbs.nth(1).hover();
    await page.locator('.bar [data-act="end"]').click();
    await thumbs.nth(2).hover();
    await page.locator('.bar [data-act="next"]').click();
    await until(async () => (await queueIds()).length === 3, 'three queued');
    const [a, b, c] = [await idAt(0), await idAt(1), await idAt(2)];
    assert.deepEqual(await queueIds(), [c, a, b]);
    const { queue } = await storage('queue');
    assert.equal(queue.items[1].title, spec(Number.parseInt(a.slice(1), 36)).title);
    assert.ok(queue.items[1].channel);
    assert.match(await page.locator('#ywl-toast .toast').textContent(), /воспроизведётся следующим/);
  });

  await step('watch page: queue panel, reorder by button and drag, auto-advance on "ended" inside the app (no reload)', async () => {
    await page.goto(`${O}/watch?v=${videoIdOf(3)}`);
    const panel = page.locator('section.panel');
    await panel.waitFor();
    assert.equal(await panel.locator('li').count(), 3);
    const order0 = await queueIds();
    await panel.locator('li').nth(0).locator('[data-act="down"]').click();
    await until(async () => (await queueIds())[0] === order0[1], 'moved down');
    await panel.locator('li').nth(2).dragTo(panel.locator('li').nth(0));
    await until(async () => (await queueIds())[0] === order0[2], 'dragged to the top');
    const q = await queueIds();
    await page.evaluate(() => {
      /** @type {any} */ (window).__navigations = 0;
      document.querySelector('video').dispatchEvent(new Event('ended'));
    });
    await until(() => page.url().includes(q[0]), 'navigated to the first queued video');
    assert.equal(await page.evaluate(() => /** @type {any} */ (window).__navigations), 1, 'navigation inside the app');
    assert.deepEqual(await queueIds(), q.slice(1));
    assert.equal((await storage('queue')).queue.current.id, q[0]);
    await page.locator('section.panel .now').waitFor();
  });

  await step('no advance while an ad plays or with auto-advance off', async () => {
    const url = page.url();
    await page.evaluate(() => {
      document.querySelector('#movie_player').classList.add('ad-showing');
      document.querySelector('video').dispatchEvent(new Event('ended'));
    });
    await sleep(1200);
    assert.equal(page.url(), url);
    await page.evaluate(() => document.querySelector('#movie_player').classList.remove('ad-showing'));
    const { settings } = await storage('settings');
    await setStorage({ settings: { ...settings, autoAdvance: false } });
    await sleep(300);
    await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('ended')));
    await sleep(1200);
    assert.equal(page.url(), url);
    assert.equal((await queueIds()).length, 2);
    await setStorage({ settings: { ...settings, autoAdvance: true } });
  });

  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, page.url());
  assert.ok(tabId, 'fixture tab found');
  const popup = await context.newPage();
  watchErrors(popup, 'popup');

  await step('popup: queue list, "Next" plays in the tab, remove, empty state, brand link', async () => {
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html?tabId=${tabId}`);
    await popup.waitForSelector('body[data-ready="1"]');
    assert.equal(await popup.locator('#qList li').count(), 2);
    assert.equal(await popup.textContent('#qCount'), '2');
    // the suggested key is free in Chrome (Alt+Shift+N is not: Chrome refuses it)
    assert.equal(await popup.textContent('#shortcut'), 'Следующее из очереди: Alt+Shift+Q');
    assert.equal(await popup.getAttribute('a[data-brand-link="other"]', 'href'), `${brandBase}#youtube-watch-later`);
    const q = await queueIds();
    await popup.click('#qNext');
    await until(() => page.url().includes(q[0]), 'tab plays the next video');
    await until(async () => (await popup.locator('#qList li').count()) === 1, 'popup updated');
    await popup.click('#qList li [data-act="remove"]');
    await until(async () => popup.locator('#qEmpty').isVisible(), 'empty state');
    assert.ok(await popup.locator('#qNext').isDisabled());
  });

  await step('options page: settings save, hover buttons can be switched off, backups listed', async () => {
    const opt = await context.newPage();
    watchErrors(opt, 'options');
    await opt.goto(`chrome-extension://${extId}/src/options/options.html`);
    await opt.waitForSelector('body[data-ready="1"]');
    assert.equal(await opt.locator('#backups li').count(), 3, 'three newest backups kept');
    await opt.locator('label:has(#hoverButtons)').click();
    await until(async () => (await storage('settings')).settings.hoverButtons === false, 'saved');
    await opt.selectOption('#speed', 'careful');
    await until(async () => (await storage('settings')).settings.speed === 'careful', 'speed saved');
    await opt.close();
    await page.goto(`${O}/`);
    await page.locator('yt-lockup-view-model').first().waitFor();
    await page.waitForTimeout(500);
    await thumbs.nth(0).hover();
    await sleep(300);
    assert.equal(await page.locator('.bar:not(.hidden)').count(), 0);
  });

  await step('page bridge refuses requests outside Watch Later; they never reach the server', async () => {
    await page.goto(`${O}/playlist?list=WL`);
    await page.locator('[data-act="open"]').waitFor();
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html?tabId=${tabId}`);
    await popup.waitForSelector('body[data-ready="1"]');
    const n = api.st.log.length;
    const r = await page.evaluate(
      () =>
        new Promise((resolve) => {
          window.addEventListener('message', (e) => e.data && e.data.__ywl === 'res' && e.data.id === 'probe' && resolve(e.data.result));
          window.postMessage({ __ywl: 'req', id: 'probe', method: 'browse', body: { browseId: 'FEhistory' } }, location.origin);
        }),
    );
    assert.equal(r.status, -1);
    assert.equal(api.st.log.length, n);
  });

  assert.deepEqual(errors, [], 'no page / extension errors');
  console.log(`\n${passed} e2e checks passed`);
} catch (e) {
  exitCode = 1;
  console.error('E2E FAILED:', e);
  if (errors.length) console.error('page errors:', errors);
} finally {
  await context.close().catch(() => {});
  server.close();
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
process.exit(exitCode);
