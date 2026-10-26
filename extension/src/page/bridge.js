// Page-context part ("MAIN world") of the extension, on www.youtube.com only.
//
// Why it exists: the Watch Later list is private, so it can only be read and edited the way the
// YouTube web client itself does it — same-origin POST requests to /youtubei/v1/... with the page's
// own client context (window.ytcfg) and the page's own session. Content scripts cannot see
// window.ytcfg, so this small script answers requests from the content script (window.postMessage).
//
// What it can do (and nothing else — every request is checked against this allowlist):
//  - "browse":        POST /youtubei/v1/browse with browseId "VLWL" (Watch Later) or a continuation token;
//  - "edit":          POST /youtubei/v1/browse/edit_playlist with playlistId "WL" and only
//                     ACTION_REMOVE_VIDEO / ACTION_REMOVE_VIDEO_BY_VIDEO_ID / ACTION_ADD_VIDEO;
//  - "navigate":      open /watch?v=<id> inside the single-page app (falls back to a normal load);
//  - "status":        whether the page reports a signed-in user (ytcfg LOGGED_IN).
// Authorization: YouTube's web client sends an "Authorization: SAPISIDHASH …" header that it
// computes from the SAPISID cookie of the page (SHA-1 of "<time> <SAPISID> <origin>"). This script
// computes the same header in the same way, in the page, for the request to www.youtube.com only.
// The cookie value is never stored, logged or sent to the extension or anywhere else.
(() => {
  'use strict';
  const W = /** @type {any} */ (globalThis);
  if (W.__ywlBridge) return;
  W.__ywlBridge = true;

  const VIDEO_ID = /^[\w-]{11}$/;
  const EDIT_ACTIONS = new Set(['ACTION_REMOVE_VIDEO', 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', 'ACTION_ADD_VIDEO']);

  /** @param {string} k */
  function cfg(k) {
    try {
      const y = W.ytcfg;
      if (y && typeof y.get === 'function') return y.get(k);
      return y && y.data_ ? y.data_[k] : undefined;
    } catch {
      return undefined;
    }
  }

  /** @param {string} cookie @param {string} name */
  function cookieValue(cookie, name) {
    for (const part of String(cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return '';
  }

  /** @param {string} s */
  async function sha1Hex(s) {
    const buf = await W.crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * "SAPISIDHASH <ts>_<sha1>[_u] SAPISID1PHASH … SAPISID3PHASH …" — the same value YouTube's own
   * scripts put into the Authorization header. Empty string when there is no session cookie.
   * @param {string} cookie
   * @param {string} origin
   * @param {number} nowSec
   * @param {string} userSession first part of DATASYNC_ID, if any
   */
  async function authorization(cookie, origin, nowSec, userSession) {
    const ts = String(nowSec);
    const schemes = [
      ['SAPISIDHASH', cookieValue(cookie, 'SAPISID') || cookieValue(cookie, '__Secure-3PAPISID')],
      ['SAPISID1PHASH', cookieValue(cookie, '__Secure-1PAPISID')],
      ['SAPISID3PHASH', cookieValue(cookie, '__Secure-3PAPISID')],
    ];
    const out = [];
    for (const [scheme, sid] of schemes) {
      if (!sid) continue;
      const parts = userSession ? [userSession, ts, sid, origin] : [ts, sid, origin];
      const hash = await sha1Hex(parts.join(' '));
      out.push(`${scheme} ${ts}_${hash}${userSession ? '_u' : ''}`);
    }
    return out.join(' ');
  }

  /** Checks of what the content script may ask for. */
  function allowed(kind, body) {
    if (!body || typeof body !== 'object') return false;
    if (kind === 'browse') {
      const keys = Object.keys(body);
      if (typeof body.continuation === 'string' && body.continuation && keys.every((k) => k === 'continuation')) return true;
      return body.browseId === 'VLWL' && keys.every((k) => k === 'browseId' || (k === 'params' && typeof body.params === 'string'));
    }
    if (kind === 'edit') {
      if (body.playlistId !== 'WL' || !Array.isArray(body.actions) || !body.actions.length || body.actions.length > 100) return false;
      if (!Object.keys(body).every((k) => k === 'playlistId' || k === 'actions')) return false;
      return body.actions.every(
        (a) =>
          a &&
          EDIT_ACTIONS.has(a.action) &&
          (a.action === 'ACTION_REMOVE_VIDEO'
            ? typeof a.setVideoId === 'string' && a.setVideoId.length > 0 && a.setVideoId.length < 100
            : a.action === 'ACTION_ADD_VIDEO'
              ? VIDEO_ID.test(String(a.addedVideoId))
              : VIDEO_ID.test(String(a.removedVideoId))),
      );
    }
    return false;
  }

  /**
   * One innertube request, like the web client sends it.
   * @param {'browse' | 'edit'} kind
   * @param {any} body
   */
  async function innertube(kind, body) {
    if (!allowed(kind, body)) return { status: -1, error: 'not allowed' };
    const context = cfg('INNERTUBE_CONTEXT');
    if (!context || !context.client) return { status: -2, error: 'no client context' };
    const origin = W.location.origin;
    const path = kind === 'browse' ? '/youtubei/v1/browse' : '/youtubei/v1/browse/edit_playlist';
    /** @type {Record<string, string>} */
    const headers = {
      'content-type': 'application/json',
      'x-origin': origin,
      'x-youtube-client-name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') ?? 1),
      'x-youtube-client-version': String(cfg('INNERTUBE_CONTEXT_CLIENT_VERSION') || cfg('INNERTUBE_CLIENT_VERSION') || context.client.clientVersion || ''),
      'x-goog-authuser': String(cfg('SESSION_INDEX') ?? 0),
    };
    const visitor = cfg('VISITOR_DATA') || context.client.visitorData;
    if (visitor) headers['x-goog-visitor-id'] = String(visitor);
    const delegated = cfg('DELEGATED_SESSION_ID');
    if (delegated) headers['x-goog-pageid'] = String(delegated);
    const datasync = String(cfg('DATASYNC_ID') || '');
    const userSession = datasync.includes('||') ? datasync.split('||')[0] : '';
    const auth = await authorization(W.document.cookie, origin, Math.floor(Date.now() / 1000), userSession);
    if (auth) headers.authorization = auth;
    let res;
    try {
      res = await W.fetch(`${origin}${path}?prettyPrint=false`, {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify({ context, ...body }),
      });
    } catch (e) {
      return { status: 0, error: String((e && e.message) || e) };
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON */
    }
    const ra = Number(res.headers.get('retry-after'));
    return { status: res.status, json, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : null };
  }

  /** @param {string} id */
  function navigate(id) {
    if (!VIDEO_ID.test(String(id))) return { ok: false };
    const url = `/watch?v=${id}`;
    try {
      const app = W.document.querySelector('ytd-app');
      if (app) {
        app.dispatchEvent(
          new CustomEvent('yt-navigate', {
            bubbles: true,
            composed: true,
            detail: { endpoint: { commandMetadata: { webCommandMetadata: { url, webPageType: 'WEB_PAGE_TYPE_WATCH', rootVe: 3832 } }, watchEndpoint: { videoId: id } } },
          }),
        );
      }
    } catch {
      /* fall back below */
    }
    // if the app did not navigate, do a normal page load
    setTimeout(() => {
      try {
        if (new URL(W.location.href).searchParams.get('v') !== id) W.location.assign(url);
      } catch {
        /* ignore */
      }
    }, 1500);
    return { ok: true };
  }

  W.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== W || !m || m.__ywl !== 'req' || typeof m.id !== 'string') return;
    const reply = (result) => W.postMessage({ __ywl: 'res', id: m.id, result }, W.location.origin);
    Promise.resolve()
      .then(() => {
        if (m.method === 'browse' || m.method === 'edit') return innertube(m.method, m.body);
        if (m.method === 'navigate') return navigate(m.body && m.body.videoId);
        if (m.method === 'status') return { loggedIn: cfg('LOGGED_IN') === true || cfg('LOGGED_IN') === 'true', hasContext: !!cfg('INNERTUBE_CONTEXT') };
        return { status: -1, error: 'unknown method' };
      })
      .then(reply, (err) => reply({ status: 0, error: String((err && err.message) || err) }));
  });

  // for the unit test in node (vm context); never used on the page
  if (W.__ywlTestHooks) W.__ywlTestHooks({ authorization, allowed, cookieValue });
})();
