// LOCAL fixture "video site" for e2e tests and store screenshots. Its DOM mimics the parts of
// the YouTube desktop markup the extension relies on (ytd-app, yt-lockup-view-model, #movie_player,
// window.ytcfg), and a fake innertube API mimics the requests the Watch Later page makes:
//   POST /youtubei/v1/browse               {browseId: "VLWL"} | {continuation}
//   POST /youtubei/v1/browse/edit_playlist {playlistId: "WL", actions: [...]}
// The fake API checks the SAPISIDHASH authorization header exactly like the real one is built,
// records every request (time, actions) and can answer 429 / 500 on demand.
// Written from public knowledge and a look at logged-out pages on 2026-10-26; nothing is copied
// from YouTube (no HTML, CSS, images or logos). Titles and channels are invented.
import { createHash } from 'node:crypto';
import { spec, browsePage, CHANNELS } from './wl-data.mjs';

export const SAPISID = 'fixture-sapisid-value';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const sha1 = (s) => createHash('sha1').update(s).digest('hex');

/**
 * Fake innertube API with state.
 * @param {{ total?: number }} [o]
 */
export function createApi(o = {}) {
  const st = {
    /** @type {number[]} */ list: [],
    /** @type {{ t: number, path: string, auth: boolean, body: any, status: number }[]} */ log: [],
    fail: /** @type {{ status: number, retryAfter?: number }[]} */ ([]),
    loggedIn: true,
  };
  const reset = (total = o.total ?? 5000) => {
    st.list = Array.from({ length: total }, (_, k) => k + 1);
    st.log = [];
    st.fail = [];
    st.loggedIn = true;
  };
  reset();
  /** @param {string} header @param {string} origin */
  const authOk = (header, origin) => {
    const m = /^SAPISIDHASH (\d+)_([0-9a-f]{40})(?:_u)?(?: |$)/.exec(header || '');
    if (!m) return false;
    if (Math.abs(Number(m[1]) - Date.now() / 1000) > 300) return false;
    return m[2] === sha1(`${m[1]} ${SAPISID} ${origin}`);
  };
  /**
   * @param {string} path
   * @param {any} body
   * @param {Record<string, string | string[] | undefined>} headers
   * @returns {{ status: number, json: any, headers?: Record<string, string> }}
   */
  function handle(path, body, headers) {
    const auth = authOk(String(headers.authorization || ''), String(headers['x-origin'] || ''));
    const entry = { t: Date.now(), path, auth, body, status: 200 };
    st.log.push(entry);
    const answer = (status, json, h) => ((entry.status = status), { status, json, headers: h });
    if (!body || !body.context || !body.context.client) return answer(400, { error: { code: 400, message: 'no context' } });
    if (!st.loggedIn || !auth) return answer(401, { error: { code: 401, message: 'login required' } });
    const f = st.fail.shift();
    if (f) return answer(f.status, { error: { code: f.status } }, f.retryAfter ? { 'retry-after': String(f.retryAfter) } : undefined);
    if (path === '/youtubei/v1/browse') {
      if (body.browseId === 'VLWL') return answer(200, browsePage(st.list, 0, { first: true }));
      const m = /^page-(\d+)$/.exec(String(body.continuation || ''));
      if (m) return answer(200, browsePage(st.list, Number(m[1])));
      return answer(400, { error: { code: 400 } });
    }
    if (path === '/youtubei/v1/browse/edit_playlist') {
      if (body.playlistId !== 'WL' || !Array.isArray(body.actions)) return answer(400, { error: { code: 400 } });
      for (const a of body.actions) {
        let n = -1;
        if (a.action === 'ACTION_REMOVE_VIDEO') n = st.list.findIndex((i) => spec(i).setVideoId === a.setVideoId);
        else if (a.action === 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID') n = st.list.findIndex((i) => spec(i).videoId === a.removedVideoId);
        else if (a.action === 'ACTION_ADD_VIDEO') {
          const i = Number.parseInt(String(a.addedVideoId).slice(1), 36);
          if (st.list.includes(i)) return answer(409, { error: { code: 409, message: 'already in the playlist' } });
          st.list.unshift(i);
          continue;
        }
        if (n < 0) return answer(400, { error: { code: 400, message: 'not in the playlist' } });
        st.list.splice(n, 1);
      }
      return answer(200, { responseContext: {}, status: 'STATUS_SUCCEEDED', actions: [] });
    }
    return answer(404, null);
  }
  return { st, reset, handle };
}

const PALETTE = [210, 30, 260, 150, 330, 190, 95, 45, 280, 0, 170, 120];

/** @param {ReturnType<typeof spec>} s @param {number} k */
function lockupHtml(s, k, compact = false) {
  const href = `/watch?v=${s.videoId}`;
  const d = s.duration == null ? '' : `${Math.floor(s.duration / 60)}:${String(s.duration % 60).padStart(2, '0')}`;
  return `<yt-lockup-view-model class="lockup${compact ? ' compact' : ''}"><div class="ytLockupViewModelHost">
  <a href="${href}" class="ytLockupViewModelContentImage" tabindex="-1" aria-hidden="true"><yt-thumbnail-view-model><div class="ytThumbnailViewModelImage thumb" style="--h:${PALETTE[k % PALETTE.length]}"><span class="glyph">${esc(s.title.slice(0, 1))}</span></div>${d ? `<div class="badge"><div class="ytBadgeShapeText">${d}</div></div>` : ''}</yt-thumbnail-view-model></a>
  <div class="ytLockupViewModelMetadata"><a class="ytLockupMetadataViewModelTitle" href="${href}">${esc(s.title)}</a><span class="ytContentMetadataViewModelMetadataText">${esc(s.channel || '—')}</span><span class="sub">${(s.i * 13) % 900 + 1} тыс. просмотров · ${(s.i % 11) + 1} мес. назад</span></div>
</div></yt-lockup-view-model>`;
}

const HOME_IDS = [3, 8, 12, 21, 26, 31, 44, 52, 61, 66, 73, 88];

/** @param {string} title @param {string} body @param {{ dark?: boolean }} [o] */
function page(title, body, o = {}) {
  return `<!doctype html><html lang="ru"${o.dark ? ' dark' : ''}><head><meta charset="utf-8"><title>${esc(title)}</title>
<link rel="stylesheet" href="/fixture/site.css"><script src="/fixture/app.js"></script></head>
<body><ytd-app><div id="masthead"><a class="logo" href="/"><span class="logo-mark">▶</span> Видеосайт</a><div class="search">Поиск</div><div class="avatar-me">Я</div></div>
<div id="layout"><nav id="guide"><a href="/">⌂ Главная</a><a href="/feed/subscriptions">▤ Подписки</a><a href="/playlist?list=WL">◷ Смотреть позже</a><a href="/feed/history">↺ История</a></nav>
<ytd-page-manager id="page-manager">${body}</ytd-page-manager></div></ytd-app></body></html>`;
}

function home() {
  return page('Главная — видеосайт', `<ytd-browse page-subtype="home"><div class="grid">${HOME_IDS.map((n, k) => lockupHtml(spec(n), k)).join('')}</div></ytd-browse>`);
}

/** @param {string} id */
function watch(id) {
  const n = Number.parseInt(id.slice(1), 36);
  const s = Number.isFinite(n) && n > 0 ? spec(n) : { title: `Видео ${id}`, channel: CHANNELS[0] };
  const related = HOME_IDS.filter((x) => x !== n).slice(0, 8);
  return page(`${s.title} — видеосайт`, `<ytd-watch-flexy video-id="${esc(id)}"><div class="watch"><div class="primary">
  <div id="movie_player" class="html5-video-player"><video class="html5-main-video" muted playsinline></video><div class="player-face">▶ ${esc(s.title)}</div></div>
  <h1 class="vtitle">${esc(s.title)}</h1><div class="vchannel">${esc(s.channel || '')}</div></div>
  <div class="secondary">${related.map((x, k) => lockupHtml(spec(x), k + 3, true)).join('')}</div></div></ytd-watch-flexy>`);
}

function watchLater(count) {
  const first = Array.from({ length: Math.min(12, count) }, (_, k) => spec(k + 1));
  return page('Смотреть позже — видеосайт', `<ytd-browse page-subtype="playlist"><div class="wl"><div class="wl-head"><div class="wl-cover thumb" style="--h:200"></div><h1>Смотреть позже</h1><p>Плейлист · ${count.toLocaleString('ru-RU')} видео · Обновлено сегодня</p><p class="muted">Доступ ограничен</p></div>
  <div class="wl-list">${first.map((s, k) => `<div class="wl-row"><span class="idx">${k + 1}</span>${lockupHtml(s, k, true)}</div>`).join('')}</div></div></ytd-browse>`);
}

const APP_JS = `
// Fixture app: ytcfg (as the real page defines it), the session cookie, and SPA navigation
// through the "yt-navigate" event and links, firing yt-navigate-finish like the real app.
window.ytcfg = { data_: {
  INNERTUBE_CONTEXT: { client: { hl: 'ru', gl: 'KZ', clientName: 'WEB', clientVersion: '2.20261020.01.00' }, user: { lockedSafetyMode: false }, request: { useSsl: true } },
  INNERTUBE_CONTEXT_CLIENT_NAME: 1, INNERTUBE_CLIENT_VERSION: '2.20261020.01.00', INNERTUBE_CONTEXT_CLIENT_VERSION: '2.20261020.01.00',
  SESSION_INDEX: 0, VISITOR_DATA: 'CgtGaXh0dXJlVmlz', LOGGED_IN: true
}, get(k) { return this.data_[k]; } };
document.cookie = 'SAPISID=${SAPISID}; path=/';
(() => {
  async function navigate(href, push = true) {
    const url = new URL(href, location.href);
    window.dispatchEvent(new CustomEvent('yt-navigate-start'));
    const html = await (await fetch(url.href)).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    document.getElementById('page-manager').innerHTML = doc.getElementById('page-manager').innerHTML;
    document.title = doc.title;
    if (push) history.pushState({}, '', url.href);
    window.__navigations = (window.__navigations || 0) + 1;
    window.dispatchEvent(new CustomEvent('yt-navigate-finish'));
  }
  window.__spaNavigate = navigate;
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('ytd-app').addEventListener('yt-navigate', (e) => {
      const ep = e.detail && e.detail.endpoint;
      const url = ep && ep.commandMetadata && ep.commandMetadata.webCommandMetadata.url;
      if (url) navigate(url);
    });
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented || a.origin !== location.origin || a.target || a.hasAttribute('download')) return;
    e.preventDefault();
    navigate(a.href);
  });
  window.addEventListener('popstate', () => navigate(location.href, false));
})();
`;

const CSS = `
*{box-sizing:border-box}body{margin:0;font:14px/1.4 Roboto,"Segoe UI",Arial,sans-serif;background:#fff;color:#0f0f0f}
html[dark] body{background:#0f0f0f;color:#f1f1f1}
a{color:inherit;text-decoration:none}
#masthead{height:56px;display:flex;align-items:center;gap:24px;padding:0 20px;border-bottom:1px solid #eee}
.logo{font-weight:700;font-size:18px;display:flex;gap:6px;align-items:center}.logo-mark{display:inline-flex;width:28px;height:20px;border-radius:6px;background:#3d6f9e;color:#fff;font-size:11px;align-items:center;justify-content:center}
.search{flex:1;max-width:560px;margin:0 auto;height:38px;border:1px solid #ccc;border-radius:19px;padding:9px 18px;color:#888}
.avatar-me{width:32px;height:32px;border-radius:50%;background:#7a5;color:#fff;display:flex;align-items:center;justify-content:center}
#layout{display:flex}#guide{width:200px;flex:none;padding:12px;display:flex;flex-direction:column;gap:2px}#guide a{padding:9px 12px;border-radius:10px}#guide a:hover{background:#f2f2f2}
#page-manager{flex:1;min-width:0;padding:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:24px 16px}
.lockup .ytLockupViewModelHost{display:flex;flex-direction:column;gap:10px}
.lockup.compact .ytLockupViewModelHost{flex-direction:row}
.ytLockupViewModelContentImage{display:block;position:relative}
.lockup.compact .ytLockupViewModelContentImage{width:168px;flex:none}
.thumb{aspect-ratio:16/9;border-radius:12px;background:linear-gradient(135deg,hsl(var(--h) 45% 62%),hsl(calc(var(--h) + 40) 50% 40%));display:flex;align-items:center;justify-content:center}
.glyph{font:700 42px Georgia,serif;color:rgba(255,255,255,.55)}
.lockup.compact .glyph{font-size:26px}
.badge{position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,.75);color:#fff;font-size:12px;font-weight:500;padding:1px 5px;border-radius:4px}
.ytLockupViewModelMetadata{display:flex;flex-direction:column;gap:2px;min-width:0}
.ytLockupMetadataViewModelTitle{font-weight:500;font-size:15px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.lockup.compact .ytLockupMetadataViewModelTitle{font-size:14px}
.ytContentMetadataViewModelMetadataText,.sub{color:#606060;font-size:13px}
.watch{display:flex;gap:24px}.primary{flex:1;min-width:0}.secondary{width:400px;flex:none;display:flex;flex-direction:column;gap:10px}
#movie_player{position:relative;aspect-ratio:16/9;border-radius:12px;background:#111;overflow:hidden}
#movie_player video{position:absolute;inset:0;width:100%;height:100%}
.player-face{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#ddd;font-size:20px;background:radial-gradient(circle at 40% 40%,#3a4a5a,#111)}
.vtitle{font-size:20px;margin:12px 0 4px}.vchannel{color:#606060}
.wl{display:flex;gap:24px;align-items:flex-start}.wl-head{width:340px;flex:none;border-radius:16px;padding:20px;background:linear-gradient(#5c7fa8,#2f4a6a);color:#fff}
.wl-head h1{margin:14px 0 6px;font-size:26px}.wl-head p{margin:4px 0;font-size:13px}.wl-head .muted{opacity:.75}
.wl-list{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}.wl-row{display:flex;gap:10px;align-items:center}.wl-row .idx{width:22px;color:#606060;text-align:center}
`;

/**
 * GET routes. Returns {body, type} or null.
 * @param {string} rawUrl
 * @param {ReturnType<typeof createApi>} api
 */
export function route(rawUrl, api) {
  const u = new URL(rawUrl, 'http://fixture.local');
  if (u.pathname === '/fixture/app.js') return { body: APP_JS, type: 'text/javascript' };
  if (u.pathname === '/fixture/site.css') return { body: CSS, type: 'text/css' };
  if (u.pathname === '/') return { body: home() };
  if (u.pathname === '/watch' && /^[\w-]{11}$/.test(u.searchParams.get('v') || '')) return { body: watch(String(u.searchParams.get('v'))) };
  if (u.pathname === '/playlist' && u.searchParams.get('list') === 'WL') return { body: watchLater(api.st.list.length) };
  if (u.pathname.startsWith('/feed/')) return { body: page('Раздел — видеосайт', '<p>Пустой раздел фикстуры.</p>') };
  return null;
}
