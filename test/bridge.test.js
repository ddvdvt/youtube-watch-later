// Runs the real page script (src/page/bridge.js) in a node vm with a fake window, ytcfg and fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../extension/src/page/bridge.js', import.meta.url), 'utf8');
const sha1 = (s) => createHash('sha1').update(s).digest('hex');

function load({ cookie = 'SAPISID=abc123; other=1', cfg = {}, status = 200, json = { status: 'STATUS_SUCCEEDED' }, retryAfter = null } = {}) {
  const listeners = [];
  const posted = [];
  const fetches = [];
  const data = {
    INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '2.20261020.01.00', hl: 'ru' }, user: {} },
    INNERTUBE_CONTEXT_CLIENT_NAME: 1,
    INNERTUBE_CLIENT_VERSION: '2.20261020.01.00',
    SESSION_INDEX: 0,
    VISITOR_DATA: 'VIS',
    LOGGED_IN: true,
    ...cfg,
  };
  /** @type {any} */
  const W = {
    crypto: globalThis.crypto,
    TextEncoder,
    URL,
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
    setTimeout: () => 0,
    Promise,
    location: { origin: 'https://www.youtube.com', href: 'https://www.youtube.com/playlist?list=WL', assign: () => {} },
    document: { cookie, querySelector: () => null },
    ytcfg: { get: (k) => data[k] },
    addEventListener: (type, fn) => type === 'message' && listeners.push(fn),
    postMessage: (m) => posted.push(m),
    fetch: async (url, init) => {
      fetches.push({ url, init, body: JSON.parse(init.body) });
      return { status, json: async () => json, headers: { get: (h) => (h === 'retry-after' ? retryAfter : null) } };
    },
  };
  W.globalThis = W;
  /** @type {any} */
  let hooks = null;
  W.__ywlTestHooks = (h) => (hooks = h);
  const ctx = vm.createContext(W);
  vm.runInContext(SRC, ctx);
  const inner = vm.runInContext('globalThis', ctx);
  const request = async (method, body) => {
    const id = `t${Math.random()}`;
    for (const fn of listeners) fn({ source: inner, data: { __ywl: 'req', id, method, body } });
    for (let i = 0; i < 500 && !posted.some((p) => p.id === id); i++) await new Promise((r) => setTimeout(r, 2));
    return posted.find((p) => p.id === id).result;
  };
  return { W, ctx, hooks, request, fetches, posted, listeners };
}

test('authorization header is computed like the web client (SAPISIDHASH, 1P/3P variants, _u suffix)', async () => {
  const { hooks } = load();
  const plain = await hooks.authorization('SAPISID=abc123', 'https://www.youtube.com', 1700000000, '');
  assert.equal(plain, `SAPISIDHASH 1700000000_${sha1('1700000000 abc123 https://www.youtube.com')}`);
  const all = await hooks.authorization('SAPISID=a; __Secure-1PAPISID=b; __Secure-3PAPISID=c', 'https://www.youtube.com', 5, 'U1');
  assert.equal(
    all,
    [`SAPISIDHASH 5_${sha1('U1 5 a https://www.youtube.com')}_u`, `SAPISID1PHASH 5_${sha1('U1 5 b https://www.youtube.com')}_u`, `SAPISID3PHASH 5_${sha1('U1 5 c https://www.youtube.com')}_u`].join(' '),
  );
  assert.equal(await hooks.authorization('other=1', 'https://www.youtube.com', 5, ''), '');
  assert.equal(hooks.cookieValue(' a=1; SAPISID=x/y=z ', 'SAPISID'), 'x/y=z');
});

test('allowlist: only Watch Later browse and WL edits with known actions', () => {
  const { hooks } = load();
  const ok = (k, b) => hooks.allowed(k, b);
  assert.ok(ok('browse', { browseId: 'VLWL' }));
  assert.ok(ok('browse', { browseId: 'VLWL', params: 'wgYCCAA%3D' }));
  assert.ok(ok('browse', { continuation: 'tok' }));
  assert.ok(!ok('browse', { browseId: 'FEhistory' }));
  assert.ok(!ok('browse', { browseId: 'VLPLsomething' }));
  assert.ok(!ok('browse', { continuation: 'tok', browseId: 'FEwhat' }));
  assert.ok(ok('edit', { playlistId: 'WL', actions: [{ action: 'ACTION_REMOVE_VIDEO', setVideoId: 'S1' }] }));
  assert.ok(ok('edit', { playlistId: 'WL', actions: [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: 'abcdefghijk' }] }));
  assert.ok(ok('edit', { playlistId: 'WL', actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: 'abcdefghijk' }] }));
  assert.ok(!ok('edit', { playlistId: 'LL', actions: [{ action: 'ACTION_REMOVE_VIDEO', setVideoId: 'S1' }] }));
  assert.ok(!ok('edit', { playlistId: 'WL', actions: [{ action: 'ACTION_SET_PLAYLIST_NAME', playlistName: 'x' }] }));
  assert.ok(!ok('edit', { playlistId: 'WL', actions: [] }));
  assert.ok(!ok('edit', { playlistId: 'WL', actions: Array(101).fill({ action: 'ACTION_REMOVE_VIDEO', setVideoId: 'S' }) }));
  assert.ok(!ok('edit', { playlistId: 'WL', actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: 'x' }] }));
  assert.ok(!ok('edit', { playlistId: 'WL', privacyStatus: 'PUBLIC', actions: [{ action: 'ACTION_REMOVE_VIDEO', setVideoId: 'S1' }] }));
});

test('edit request: same-origin POST with the page context and client headers', async () => {
  const { request, fetches } = load({ cfg: { DELEGATED_SESSION_ID: 'PAGE1', DATASYNC_ID: 'U9||X' } });
  const r = await request('edit', { playlistId: 'WL', actions: [{ action: 'ACTION_REMOVE_VIDEO', setVideoId: 'S1' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: 'STATUS_SUCCEEDED' });
  assert.equal(fetches.length, 1);
  const f = fetches[0];
  assert.equal(f.url, 'https://www.youtube.com/youtubei/v1/browse/edit_playlist?prettyPrint=false');
  assert.equal(f.init.method, 'POST');
  assert.equal(f.init.credentials, 'same-origin');
  assert.equal(f.body.playlistId, 'WL');
  assert.equal(f.body.context.client.clientName, 'WEB');
  const h = f.init.headers;
  assert.equal(h['x-origin'], 'https://www.youtube.com');
  assert.equal(h['x-youtube-client-name'], '1');
  assert.equal(h['x-youtube-client-version'], '2.20261020.01.00');
  assert.equal(h['x-goog-authuser'], '0');
  assert.equal(h['x-goog-visitor-id'], 'VIS');
  assert.equal(h['x-goog-pageid'], 'PAGE1');
  assert.match(h.authorization, /^SAPISIDHASH \d+_[0-9a-f]{40}_u$/);
});

test('refused requests never reach the network; status and Retry-After are passed back', async () => {
  const a = load();
  const r = await a.request('browse', { browseId: 'FEhistory' });
  assert.equal(r.status, -1);
  assert.equal(a.fetches.length, 0);
  const u = await a.request('fetchAnything', { url: 'https://evil.example' });
  assert.equal(u.status, -1);
  const b = load({ status: 429, json: null, retryAfter: '12' });
  const r2 = await b.request('browse', { browseId: 'VLWL' });
  assert.equal(r2.status, 429);
  assert.equal(r2.retryAfter, 12);
  const c = load({ cfg: { INNERTUBE_CONTEXT: undefined } });
  assert.equal((await c.request('browse', { browseId: 'VLWL' })).status, -2);
  const d = load({ cfg: { LOGGED_IN: false } });
  assert.deepEqual({ ...(await d.request('status')) }, { loggedIn: false, hasContext: true });
});

test('messages from other windows are ignored; the script installs once', () => {
  const a = load();
  for (const fn of a.listeners) fn({ source: {}, data: { __ywl: 'req', id: 'x', method: 'status' } });
  assert.equal(a.posted.length, 0);
  vm.runInContext(SRC, a.ctx);
  assert.equal(a.listeners.length, 1);
});
