// E2E in real Firefox: the Firefox build (scripts/firefox.mjs) in a fresh temporary profile, run
// against the LOCAL fixture pages (e2e/fixtures/site.mjs) with the fake innertube API that records
// every request — the same flows as e2e/smoke.mjs, driven by puppeteer-core over WebDriver BiDi.
// Firefox-specific parts covered here: the MAIN-world page bridge declared in content_scripts
// ("world": "MAIN"), downloads started from the page, the context-menu items, the keyboard command
// and the "Change shortcut" button. The real site is never contacted.
//
// Test-only changes in the temporary copy (never in the real manifest): host_permissions /
// content_scripts / web_accessible_resources also match http://127.0.0.1/*; lib/brand.js BASE points
// at this local server (welcome page).
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { route, createApi } from './fixtures/site.mjs';
import { spec, videoIdOf } from './fixtures/wl-data.mjs';
import { writeUnpacked, SLUG } from '../scripts/firefox.mjs';
import { startFirefox } from './firefox-harness.mjs';

let passed = 0;
async function step(name, fn) {
  const t0 = Date.now();
  await fn();
  passed++;
  console.log(`ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, timeout = 20000) {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(100)) if (await fn().catch(() => false)) return;
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

const work = await mkdtemp(join(tmpdir(), `${SLUG}-ff-e2e-`));
const extDir = writeUnpacked(join(work, 'extension'));
const manifest = JSON.parse(await readFile(join(extDir, 'manifest.json'), 'utf8'));
assert.equal(manifest.content_scripts[0].world, 'MAIN', 'the page bridge runs in the page world');
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

const ff = await startFirefox({ extDir, addonId: manifest.browser_specific_settings.gecko.id });
const edits = () => api.st.log.filter((e) => e.path.endsWith('/edit_playlist'));
const browses = () => api.st.log.filter((e) => e.path.endsWith('/browse'));

// ---- small Playwright-like helpers over a puppeteer page (elements may live in open shadow roots of the
// extension's UI: `>>>` pierces them)
const q = (sel) => (sel.startsWith('>>>') ? sel : `>>> ${sel}`);
const exists = async (page, sel) => !!(await page.$(q(sel)));
const waitFor = (page, sel, timeout = 10000) => until(() => exists(page, sel), sel, timeout);
const count = async (page, sel) => (await page.$$(q(sel))).length;
const text = (page, sel) => page.$eval(q(sel), (el) => el.textContent);
const attr = (page, sel, name) => page.$eval(q(sel), (el, n) => el.getAttribute(n), name);
const isVisible = (page, sel) => page.$eval(q(sel), (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden').catch(() => false);
const click = async (page, sel) => {
  await ff.front(page);
  await page.click(q(sel));
};
const setChecked = async (page, sel, on) => {
  if ((await page.$eval(q(sel), (el) => el.checked)) !== on) await click(page, sel);
};

let exitCode = 0;
try {
  const { bg } = ff;
  const storage = (keys) => bg((b, k) => b.chrome.storage.local.get(k), keys);
  const setStorage = (obj) => bg((b, o) => b.chrome.storage.local.set(o), obj);

  await step('fresh install opens the welcome page; settings and an empty queue are initialised', async () => {
    const found = await ff.findPage((u) => u === `${brandBase}welcome/youtube-watch-later.html`, 15000);
    assert.ok(found, 'welcome tab opened');
    await found.close();
    await until(async () => (await storage('settings')).settings, 'settings');
    const { settings, queue } = await storage(['settings', 'queue']);
    assert.deepEqual(settings, { hoverButtons: true, autoAdvance: true, queuePanel: true, watchedPct: 90, speed: 'normal' });
    assert.deepEqual(queue, { items: [], current: null });
  });

  await step('context menu items on video links exist (Firefox contextMenus with targetUrlPatterns/documentUrlPatterns)', async () => {
    const r = await bg(async (b) => {
      const exists = (id) => new Promise((res) => b.chrome.contextMenus.update(id, {}, () => res(!b.chrome.runtime.lastError)));
      return [await exists('ywl-play-next'), await exists('ywl-add-end')];
    });
    assert.deepEqual(r, [true, true]);
  });

  const page = await ff.browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const goto = (url) => page.goto(url, { waitUntil: 'load' }).catch(() => {});
  const wl = async () => {
    await goto(`${O}/playlist?list=WL`);
    // right after a temporary install Firefox may still be registering the content scripts when the
    // very first page loads (seen once in ~5 runs): reload once in that case
    await waitFor(page, '[data-act="open"]', 6000).catch(async () => {
      await page.reload({ waitUntil: 'load' });
      await waitFor(page, '[data-act="open"]');
    });
  };
  const selCount = async () => Number(await attr(page, '[data-sel]', 'data-count'));
  const loadList = async () => {
    await click(page, '[data-act="load"]');
    await waitFor(page, '[data-state="ready"]', 60000);
  };
  const jobDone = (status = 'done') => waitFor(page, `[data-job-status="${status}"]`, 60000);
  const back = () => click(page, '[data-act="back"]');
  /** Wait for a new file in the profile's downloads folder. */
  const downloadAfter = async (before) => {
    let f = null;
    await until(async () => {
      f = (await readdir(ff.downloads)).find((x) => !before.has(x) && !x.endsWith('.part'));
      return !!f;
    }, 'download');
    await sleep(300);
    return { name: f, path: join(ff.downloads, f) };
  };

  await step('Watch Later: the whole list of 5000 loads in 50 requests via the MAIN-world bridge, page stays responsive, list is virtualised', async () => {
    await wl();
    await click(page, '[data-act="open"]');
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
    assert.equal(await text(page, '[data-chip="total"] b'), (5000).toLocaleString('ru-RU'));
    assert.equal(browses().length, 50);
    assert.ok(browses().every((e) => e.auth && e.status === 200), 'every request carries a valid SAPISIDHASH header');
    assert.equal(browses()[0].body.browseId, 'VLWL');
    assert.equal(browses()[1].body.continuation, 'page-100');
    assert.equal(browses()[0].body.context.client.clientName, 'WEB');
    const rows = await count(page, '.vrow');
    assert.ok(rows > 5 && rows < 40, `${rows} rows in the DOM for 5000 items`);
    assert.equal(edits().length, 0);
    console.log(`    max main-thread gap while loading: ${Math.round(maxGap)} ms`);
  });

  const unavailable = Array.from({ length: 5000 }, (_, k) => k + 1).filter((i) => spec(i).unavailable);

  await step('filter "unavailable": live count; dry run walks the plan without a single request', async () => {
    await setChecked(page, '#f-unavailable', true);
    await until(async () => (await selCount()) === unavailable.length, 'selection count');
    await setChecked(page, '#ywl-only', true);
    assert.equal(await attr(page, '.vrow', 'data-vid'), videoIdOf(unavailable[0]));
    await click(page, '[data-act="dry"]');
    await jobDone();
    assert.equal(edits().length, 0, 'dry run sends nothing');
    assert.match(await text(page, '[data-job-status]'), /Обработано 135 из 135/);
    assert.match(await text(page, '[data-state="job"]'), /не ушло ни одного запроса/);
    assert.equal((await storage('wlJob')).wlJob, undefined, 'dry runs are not saved as resumable jobs');
    await back();
    await until(async () => (await selCount()) === unavailable.length, 'selection kept');
  });

  await step('remove 135 unavailable: confirm with exact number, backup downloaded first, pilot request, batches of 25, throttled', async () => {
    const before = new Set(await readdir(ff.downloads));
    await click(page, '[data-act="remove"]');
    await waitFor(page, '[role="dialog"][aria-modal="true"]');
    assert.match(await text(page, '[role="dialog"][aria-modal="true"]'), /Удалить 135 видео/);
    await click(page, '[data-act="confirm"]');
    const download = await downloadAfter(before);
    assert.match(download.name, /^watch-later-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    const backup = JSON.parse(await readFile(download.path, 'utf8'));
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
    assert.equal(await text(page, '[data-chip="unavailable"] b'), '0');
  });

  let channelSel = 0;
  let removedInPausedJob = [];
  await step('pause stops requests; reload; continue resumes where it stopped; 429 backs off with Retry-After', async () => {
    await setChecked(page, '#f-unavailable', false);
    await setChecked(page, '#ywl-only', false);
    await setChecked(page, '#f-channels', true);
    await waitFor(page, '[data-channel]');
    await setChecked(page, '[data-channel]', true);
    await until(async () => (await selCount()) > 100, 'channel selection');
    channelSel = await selCount();
    const before = edits().length;
    const files = new Set(await readdir(ff.downloads));
    await click(page, '[data-act="remove"]');
    await click(page, '[data-act="confirm"]');
    await downloadAfter(files);
    await until(async () => edits().length >= before + 3, 'three requests');
    await click(page, '[data-act="pause"]');
    await jobDone('paused');
    const n = edits().length;
    await sleep(2500);
    assert.equal(edits().length, n, 'no requests while paused');
    const { wlJob } = await storage('wlJob');
    assert.equal(wlJob.status, 'paused');
    assert.ok(wlJob.cursor > 0 && wlJob.cursor < channelSel);
    await page.reload({ waitUntil: 'load' });
    await waitFor(page, '[data-act="open"]');
    assert.equal(await text(page, '[data-act="open"]'), 'Продолжить удаление');
    await click(page, '[data-act="open"]');
    assert.match(await text(page, '[data-job-status]'), new RegExp(`из ${channelSel}`));
    api.st.fail = [{ status: 429, retryAfter: 3 }];
    await click(page, '[data-act="resume"]');
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
    await loadList();
    await setChecked(page, '#f-keyword', true);
    await click(page, 'input[placeholder="слова через запятую"]');
    await page.keyboard.type('хлеб');
    await until(async () => (await selCount()) > 0, 'keyword selection');
    const kw = await selCount();
    await click(page, '[data-act="enqueue-order"]');
    await until(async () => (await storage('queue')).queue.items.length === kw, 'queue filled');
    await setStorage({ queue: { items: [], current: null } });
    await setChecked(page, '#f-keyword', false);
    await setChecked(page, '#f-shorts', true);
    shortsBefore = shorts().length;
    await until(async () => (await selCount()) === shortsBefore, 'shorts selection');
    const before = edits().length;
    const files = new Set(await readdir(ff.downloads));
    await click(page, '[data-act="remove"]');
    await click(page, '[data-act="confirm"]');
    await downloadAfter(files);
    await until(async () => edits().length >= before + 2, 'two requests');
    await click(page, '[data-act="cancel"]');
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
    await click(page, '[data-act="restore-stored-0"]');
    await waitFor(page, '[role="dialog"][aria-modal="true"]');
    assert.match(await text(page, '[role="dialog"][aria-modal="true"]'), new RegExp(`Вернуть ${cancelledRemoved.length} видео`));
    const before = edits().length;
    await click(page, '[data-act="confirm"]');
    await jobDone();
    const adds = edits().slice(before).flatMap((x) => x.body.actions);
    assert.ok(adds.every((a) => a.action === 'ACTION_ADD_VIDEO'));
    const want = cancelledRemoved.map((s) => videoIdOf(Number.parseInt(s.slice(1), 16))).sort();
    assert.deepEqual(adds.map((a) => a.addedVideoId).sort(), want);
    assert.equal(shorts().length, shortsBefore);
    assert.ok(removedInPausedJob.length > 0);
  });

  // ---------- queue ----------
  await goto(`${O}/`);
  await waitFor(page, 'yt-lockup-view-model');
  const THUMB = 'a.ytLockupViewModelContentImage';
  const thumb = async (k) => (await page.$$(THUMB))[k];
  const idAt = async (k) => new URL(await (await thumb(k)).evaluate((a) => a.getAttribute('href')), O).searchParams.get('v');
  const queueIds = async () => (await storage('queue')).queue.items.map((i) => i.id);
  const hoverThumb = async (k) => {
    await ff.front(page);
    await (await thumb(k)).hover();
    await waitFor(page, '.bar:not(.hidden)', 3000);
  };

  await step('hover buttons on thumbnails: "Play next" puts first, "Add to queue" appends, titles are kept', async () => {
    await sleep(500);
    await hoverThumb(0);
    await click(page, '.bar [data-act="next"]');
    await hoverThumb(1);
    await click(page, '.bar [data-act="end"]');
    await hoverThumb(2);
    await click(page, '.bar [data-act="next"]');
    await until(async () => (await queueIds()).length === 3, 'three queued');
    const [a, b, c] = [await idAt(0), await idAt(1), await idAt(2)];
    assert.deepEqual(await queueIds(), [c, a, b]);
    const { queue } = await storage('queue');
    assert.equal(queue.items[1].title, spec(Number.parseInt(a.slice(1), 36)).title);
    assert.ok(queue.items[1].channel);
    assert.match(await text(page, '#ywl-toast >>> .toast'), /воспроизведётся следующим/);
  });

  await step('watch page: queue panel, reorder by button and drag, auto-advance on "ended" inside the app (no reload)', async () => {
    await goto(`${O}/watch?v=${videoIdOf(3)}`);
    await waitFor(page, 'section.panel');
    assert.equal(await count(page, 'section.panel li'), 3);
    const order0 = await queueIds();
    await click(page, 'section.panel li:nth-child(1) [data-act="down"]');
    await until(async () => (await queueIds())[0] === order0[1], 'moved down');
    // HTML5 drag and drop: drag events dispatched on the panel rows (WebDriver pointer actions do not
    // start a native drag session in Firefox)
    await page.$eval(q('section.panel'), (panel) => {
      const rows = panel.querySelectorAll('li');
      const dt = new DataTransfer();
      const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
      fire(rows[2], 'dragstart');
      fire(rows[0], 'dragenter');
      fire(rows[0], 'dragover');
      fire(rows[0], 'drop');
      fire(rows[2], 'dragend');
    });
    await until(async () => (await queueIds())[0] === order0[2], 'dragged to the top');
    const qq = await queueIds();
    await page.evaluate(() => {
      /** @type {any} */ (window).__navigations = 0;
      document.querySelector('video').dispatchEvent(new Event('ended'));
    });
    await until(async () => (await page.evaluate(() => location.href)).includes(qq[0]), 'navigated to the first queued video');
    assert.equal(await page.evaluate(() => /** @type {any} */ (window).__navigations), 1, 'navigation inside the app');
    assert.deepEqual(await queueIds(), qq.slice(1));
    assert.equal((await storage('queue')).queue.current.id, qq[0]);
    await waitFor(page, 'section.panel .now');
  });

  await step('no advance while an ad plays or with auto-advance off', async () => {
    const url = await page.evaluate(() => location.href);
    await page.evaluate(() => {
      document.querySelector('#movie_player').classList.add('ad-showing');
      document.querySelector('video').dispatchEvent(new Event('ended'));
    });
    await sleep(1200);
    assert.equal(await page.evaluate(() => location.href), url);
    await page.evaluate(() => document.querySelector('#movie_player').classList.remove('ad-showing'));
    const { settings } = await storage('settings');
    await setStorage({ settings: { ...settings, autoAdvance: false } });
    await sleep(300);
    await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('ended')));
    await sleep(1200);
    assert.equal(await page.evaluate(() => location.href), url);
    assert.equal((await queueIds()).length, 2);
    await setStorage({ settings: { ...settings, autoAdvance: true } });
  });

  const tabId = await bg(async (b, u) => (await b.chrome.tabs.query({})).find((t) => t.url === u)?.id, await page.evaluate(() => location.href));
  assert.ok(tabId, 'fixture tab found');
  const popup = await ff.browser.newPage();
  const openPopup = async () => {
    await ff.navigate(popup, `${ff.base}src/popup/popup.html?tabId=${tabId}`);
    await ff.waitFor(popup, () => document.body.dataset.ready === '1');
  };

  await step('popup: queue list, "Next" plays in the tab, remove, empty state, brand link; Alt+Shift+Q registered', async () => {
    await openPopup();
    assert.equal(await count(popup, '#qList li'), 2);
    assert.equal(await text(popup, '#qCount'), '2');
    assert.equal(await text(popup, '#shortcut'), 'Следующее из очереди: Alt+Shift+Q');
    assert.equal(await attr(popup, 'a[data-brand-link="other"]', 'href'), `${brandBase}#youtube-watch-later`);
    const qq = await queueIds();
    await click(popup, '#qNext');
    await until(async () => (await page.evaluate(() => location.href)).includes(qq[0]), 'tab plays the next video');
    await until(async () => (await count(popup, '#qList li')) === 1, 'popup updated');
    await click(popup, '#qList li [data-act="remove"]');
    await until(() => isVisible(popup, '#qEmpty'), 'empty state');
    assert.ok(await popup.$eval('#qNext', (b) => b.disabled));
  });

  await step('options page: settings save, hover buttons can be switched off, backups listed; "Change" opens the Firefox shortcut manager', async () => {
    const opt = await ff.open('src/options/options.html');
    await ff.waitFor(opt, () => document.body.dataset.ready === '1');
    assert.equal(await count(opt, '#backups li'), 3, 'three newest backups kept');
    await click(opt, 'label:has(#hoverButtons)');
    await until(async () => (await storage('settings')).settings.hoverButtons === false, 'saved');
    await opt.select('#speed', 'careful');
    await until(async () => (await storage('settings')).settings.speed === 'careful', 'speed saved');
    await click(opt, '#shortcuts');
    const addons = await ff.findPage((u) => u.startsWith('about:addons'), 5000);
    assert.ok(addons, 'about:addons opened');
    await addons.close();
    await opt.close();
    await goto(`${O}/`);
    await waitFor(page, 'yt-lockup-view-model');
    await sleep(500);
    await ff.front(page);
    await (await thumb(0)).hover();
    await sleep(300);
    assert.equal(await count(page, '.bar:not(.hidden)'), 0);
  });

  await step('page bridge (MAIN world) refuses requests outside Watch Later; they never reach the server', async () => {
    await wl();
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

  await step('Firefox: access to the site withheld → popup explains it and offers "Allow"; nothing runs on the page', async () => {
    assert.equal(await isVisible(popup, '#access'), false, 'no message while access is granted');
    assert.equal(await popup.evaluate(() => chrome.permissions.remove({ origins: ['http://127.0.0.1/*', 'https://www.youtube.com/*'] })), true);
    await goto(`${O}/`);
    await sleep(1000);
    assert.equal(await count(page, '#ywl-toast, ywl-hover, [data-ywl]'), 0, 'no content script without access');
    await openPopup();
    assert.ok(await isVisible(popup, '#access'), 'access message shown');
    assert.match(await text(popup, '#access'), /нет доступа к youtube.com/);
    // a real click: Firefox accepts the request and shows its own prompt (not automatable here);
    // without user input it would be rejected at once and "not granted" would appear
    await click(popup, '#grantAccess');
    await sleep(1500);
    assert.equal(await text(popup, '#accessMsg'), '', 'request pending on the Firefox prompt');
  });

  await step('no errors in the background, pages, popup or options', async () => {
    assert.deepEqual(await ff.errors(), []);
  });
  console.log(`\n${passed} e2e checks passed`);
} catch (e) {
  exitCode = 1;
  console.error('E2E FAILED:', e);
  console.error('collected errors:', await ff.errors().catch(() => []));
} finally {
  await ff.close();
  server.close();
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
process.exit(exitCode);
