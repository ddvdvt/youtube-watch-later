// Renders the Chrome Web Store images into store/:
//   screenshot-1..5.png (1280×800), promo-small.png (440×280), promo-marquee.png (1400×560).
// The extension UI is real (loaded unpacked into the installed Chromium). The video pages are the
// LOCAL fictional fixture site with the fake Watch Later API (e2e/fixtures/site.mjs): no real
// logos, titles or channels. 127.0.0.1 is added to the matches of a temporary copy only.
// Run: node scripts/store-images.mjs      (REVIEW_DIR=<dir> also saves the raw page shots)
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, prepareExtension, launch, hideScrollbars, dataUrl, fileDataUrl, browserWindow, stage, render, promo } from './store-kit.mjs';
import { route, createApi } from '../e2e/fixtures/site.mjs';
import { videoIdOf } from '../e2e/fixtures/wl-data.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'store');
const REVIEW = process.env.REVIEW_DIR;
const api = createApi({ total: 4873 });

// store-kit's server only does GET; POSTs to the fake API are answered by a small wrapper
const { server, port } = await startServer(async (path, _host, rawUrl) => {
  if (path.startsWith('/brand/')) return { body: '<!doctype html><title>brand</title>' };
  return route(rawUrl, api);
});
const origEmit = server.emit.bind(server);
server.emit = (ev, req, res) => {
  if (ev === 'request' && req.method === 'POST' && String(req.url).startsWith('/youtubei/v1/')) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* bad body */
      }
      const r = api.handle(String(req.url).split('?')[0], body, req.headers);
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
      res.end(JSON.stringify(r.json));
    });
    return true;
  }
  return origEmit(ev, req, res);
};
const O = `http://127.0.0.1:${port}`;
const local = ['http://127.0.0.1/*'];
const ext = await prepareExtension(join(ROOT, 'extension'), {
  base: `${O}/brand/`,
  patchManifest: (m) => {
    m.host_permissions = [...m.host_permissions, ...local];
    for (const cs of m.content_scripts) cs.matches = [...cs.matches, ...local];
    m.web_accessible_resources[0].matches = [...m.web_accessible_resources[0].matches, ...local];
  },
});
const { context, sw, extId } = await launch(ext.extDir, ext.profile);
const icon = await fileDataUrl(join(ROOT, 'extension', 'icons', 'icon128.png'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sitePage(path, w = 1164, h = 591) {
  const page = await context.newPage();
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`${O}${path}`);
  await hideScrollbars(page);
  await page.waitForTimeout(800);
  return page;
}
async function popupFor(page, height = 520) {
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, page.url());
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 340, height });
  await popup.goto(`chrome-extension://${extId}/src/popup/popup.html?tabId=${tabId}`);
  await popup.waitForSelector('body[data-ready="1"]');
  await popup.waitForTimeout(300);
  return popup;
}
const shot = async (page, name) => {
  const url = await dataUrl(page);
  if (REVIEW) await writeFile(join(REVIEW, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
  return url;
};
const win = async (page, name, tab, popup) =>
  browserWindow({ tab, address: page.url().replace(O, 'www.example-video.site'), page: await shot(page, name), icon, popup: popup ? await dataUrl(popup.locator('body')) : undefined, popupWidth: 340 });

try {
  await mkdir(OUT, { recursive: true });
  if (REVIEW) await mkdir(REVIEW, { recursive: true });
  for (const p of context.pages()) if (p.url().includes('/brand/')) await p.close();

  // 1 — the whole list loaded, filters and a live count
  const wl = await sitePage('/playlist?list=WL');
  await wl.locator('[data-act="open"]').click();
  await wl.locator('[data-act="load"]').click();
  await wl.locator('[data-state="ready"]').waitFor({ timeout: 60000 });
  await wl.locator('#f-unavailable').check();
  await wl.locator('#f-watched').check();
  await wl.locator('input[name="ywl-mode"][value="any"]').check();
  await sleep(400);
  await wl.locator('#ywl-only').check();
  await wl.evaluate(() => {
    const b = document.querySelector('#ywl-wl').shadowRoot.querySelector('.body');
    const sec = b.querySelector('[aria-labelledby="ywl-f-h"]');
    b.scrollTop += sec.getBoundingClientRect().top - b.getBoundingClientRect().top - 8;
  });
  await sleep(300);
  await render(context, stage({
    eyebrow: 'Смотреть позже · чистка списка',
    caption: 'Тысячи видео «на потом»? Загрузите <mark>весь список</mark> и выберите, что убрать',
    body: await win(wl, 'raw-1-filters', ['Смотреть позже', 'Главная']),
  }), join(OUT, 'screenshot-1.png'));

  // 2 — channel filter + manual list
  await wl.locator('#ywl-only').uncheck();
  await wl.locator('#f-unavailable').uncheck();
  await wl.locator('#f-watched').uncheck();
  await wl.locator('#f-channels').check();
  await wl.locator('[data-channel]').nth(1).check();
  await wl.locator('[data-channel]').nth(4).check();
  await wl.locator('input[name="ywl-mode"][value="all"]').check();
  await wl.locator('#f-duration').check();
  await wl.locator('input[aria-label="Длительность от, минут"]').fill('20');
  await wl.locator('#ywl-only').check();
  await sleep(400);
  await wl.evaluate(() => {
    const b = document.querySelector('#ywl-wl').shadowRoot.querySelector('.body');
    const sel = b.querySelector('.selbar');
    b.scrollTop += sel.getBoundingClientRect().top - b.getBoundingClientRect().top - 250;
  });
  await sleep(300);
  await render(context, stage({
    eyebrow: 'Фильтры складываются',
    caption: 'Каналы, длительность, просмотренные, Shorts, слова в названии — и <mark>живой предпросмотр</mark>',
    body: await win(wl, 'raw-2-channels', ['Смотреть позже', 'Главная']),
  }), join(OUT, 'screenshot-2.png'));

  // 3 — removal in progress (slow speed so the shot catches it running)
  await wl.locator('[data-act="speed"]').selectOption('careful');
  await wl.setViewportSize({ width: 566, height: 560 });
  await sleep(300);
  await wl.locator('[data-act="remove"]').click();
  await wl.locator('[data-act="confirm"]').waitFor();
  const dialogShot = await shot(wl, 'raw-3-dialog');
  await wl.locator('[data-act="confirm"]').click();
  await wl.locator('[data-job-status="running"]').waitFor();
  for (let i = 0; i < 40 && api.st.log.filter((e) => e.path.endsWith('edit_playlist')).length < 4; i++) await sleep(250);
  await sleep(200);
  await render(context, stage({
    eyebrow: 'Безопасность прежде всего',
    caption: 'Сначала <mark>резервная копия</mark>, потом удаление порциями — с паузой, отменой и продолжением',
    extraCss: '.pair{display:flex;gap:26px;align-items:flex-start}.pair .win{transform:none}',
    body: `<div class="pair">${browserWindow({ tab: 'Смотреть позже', address: 'www.example-video.site/playlist?list=WL', page: dialogShot, icon, width: 570, height: 640 })}${browserWindow({ tab: 'Смотреть позже', address: 'www.example-video.site/playlist?list=WL', page: await shot(wl, 'raw-3-job'), icon, width: 570, height: 640 })}</div>`,
  }), join(OUT, 'screenshot-3.png'));
  await wl.locator('[data-act="cancel"]').click();
  await wl.close();

  // 4 — hover buttons on the home page + the popup with the queue they built
  await sw.evaluate(() => chrome.storage.local.set({ queue: { items: [], current: null } }));
  const home = await sitePage('/');
  const thumbs = home.locator('a.ytLockupViewModelContentImage');
  await thumbs.nth(1).hover();
  await home.locator('.bar [data-act="end"]').click();
  await thumbs.nth(3).hover();
  await home.locator('.bar [data-act="end"]').click();
  await thumbs.nth(5).hover();
  await home.locator('.bar [data-act="next"]').click();
  await home.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  await home.mouse.move(5, 300);
  await thumbs.nth(0).hover();
  await sleep(300);
  const homePopup = await popupFor(home, 420);
  await render(context, stage({
    eyebrow: 'Воспроизвести далее',
    caption: 'На любом превью — <mark>«Воспроизвести далее»</mark> и «В конец очереди». Или правой кнопкой по ссылке',
    body: await win(home, 'raw-4-hover', ['Главная', 'Смотреть позже'], homePopup),
  }), join(OUT, 'screenshot-4.png'));
  if (REVIEW) await homePopup.screenshot({ path: join(REVIEW, 'raw-popup.png') });

  // 5 — watch page with the queue panel + popup
  await home.goto(`${O}/watch?v=${videoIdOf(3)}`);
  await home.locator('section.panel').waitFor();
  await home.locator('section.panel [data-act="next"]').click();
  await home.waitForURL(/v=/);
  await home.locator('section.panel .now').waitFor();
  await hideScrollbars(home);
  await home.mouse.move(400, 500);
  await sleep(600);
  const popup = await popupFor(home, 470);
  await render(context, stage({
    eyebrow: 'Своя очередь',
    caption: 'Видео кончилось — <mark>следующее из очереди</mark>, даже без автовоспроизведения. Alt+Shift+Q — сразу',
    body: await win(home, 'raw-5-watch', ['Видео', 'Главная']),
  }), join(OUT, 'screenshot-5.png'));
  if (REVIEW) {
    const dark = await context.newPage();
    await dark.emulateMedia({ colorScheme: 'dark' });
    await dark.setViewportSize({ width: 340, height: 520 });
    await dark.goto(popup.url());
    await dark.waitForSelector('body[data-ready="1"]');
    await dark.screenshot({ path: join(REVIEW, 'raw-popup-dark.png') });
    await dark.setViewportSize({ width: 900, height: 900 });
    await dark.goto(`chrome-extension://${extId}/src/options/options.html`);
    await dark.waitForSelector('body[data-ready="1"]');
    await dark.screenshot({ path: join(REVIEW, 'raw-options-dark.png'), fullPage: true });
    await dark.close();
  }

  // promo tiles
  const facts = [['Видео в списке', 'до 10 000+'], ['Резервная копия', 'JSON + CSV'], ['Очередь', 'своя'], ['Серверы автора', 'нет'], ['Цена', '0 ₽']];
  await render(context, promo({ size: 'small', icon, name: 'Смотреть позже', eyebrow: 'чистка и очередь', tagline: 'Разобрать огромный список и <mark>воспроизвести далее</mark>', facts }), join(OUT, 'promo-small.png'), 440, 280);
  await render(context, promo({ size: 'marquee', icon, name: 'Смотреть позже', eyebrow: 'чистка списка и очередь', tagline: 'Тысячи видео «на потом» — <mark>разобрать за минуту</mark>, с резервной копией. И кнопка «Воспроизвести далее».', facts }), join(OUT, 'promo-marquee.png'), 1400, 560);
  console.log('store images written to', OUT);
} finally {
  await context.close().catch(() => {});
  server.close();
  await ext.cleanup();
}
