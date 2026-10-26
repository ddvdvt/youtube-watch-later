// Release checks: brand-site links, manifest fields required by the Chrome Web Store,
// locales, permissions actually used by the code, no remote code, network limited to YouTube.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, SLUG, brandUrls, welcomeUrlFor } from '../extension/lib/brand.js';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const read = (p) => readFileSync(join(EXT, p), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const LOCALES = readdirSync(join(EXT, '_locales'));

/** @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(EXT);
const codeFiles = files.filter((f) => /\.(js|html)$/.test(f));
const code = codeFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Which code proves that a permission is used. */
const USAGE = {
  storage: /chrome\.storage\.local\./,
  contextMenus: /chrome\.contextMenus\.create\(/,
};

test('brand URLs are built from one BASE', () => {
  assert.equal(SLUG, 'youtube-watch-later');
  assert.equal(BASE, 'https://ddvdvt.github.io/');
  const u = brandUrls();
  assert.equal(u.welcome, `${BASE}welcome/youtube-watch-later.html`);
  assert.equal(u.bye, `${BASE}bye/youtube-watch-later.html`);
  assert.equal(u.privacy, `${BASE}privacy/youtube-watch-later.html`);
  assert.equal(u.other, `${BASE}#youtube-watch-later`);
  assert.equal(brandUrls('https://a.example/site', 'x').welcome, 'https://a.example/site/welcome/x.html');
});

test('welcome page opens only on a fresh install', () => {
  assert.equal(welcomeUrlFor('install'), `${BASE}welcome/youtube-watch-later.html`);
  for (const r of ['update', 'chrome_update', 'shared_module_update', undefined]) assert.equal(welcomeUrlFor(r), null);
});

test('service worker wires the welcome and uninstall pages', () => {
  const sw = read(manifest.background.service_worker);
  assert.match(sw, /from '\.\.\/lib\/brand\.js'/);
  assert.match(sw, /welcomeUrlFor\(details/);
  assert.match(sw, /setUninstallURL\(brandUrls\(\)\.bye\)/);
});

test('"other extensions" links go to the brand site', () => {
  for (const f of files.filter((x) => x.endsWith('.html'))) {
    const html = readFileSync(f, 'utf8');
    assert.ok(!html.includes('https://github.com/'), `${f} still links to a placeholder`);
    for (const m of html.matchAll(/<a [^>]*data-i18n="otherExtensions"[^>]*>/g)) assert.match(m[0], /data-brand-link="other"/, f);
  }
  assert.match(read('src/popup/popup.html'), /data-brand-link="other"/);
  assert.match(read('src/options/options.html'), /data-brand-link="other"/);
});

test('manifest: CWS fields', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.homepage_url, BASE, 'homepage_url must equal BASE from lib/brand.js');
  assert.equal(manifest.default_locale, 'ru');
  assert.equal(manifest.content_security_policy, undefined, 'default CSP');
  for (const size of ['16', '32', '48', '128']) {
    const png = readFileSync(join(EXT, manifest.icons[size]));
    assert.equal(png.readUInt32BE(16), Number(size), `icon ${size} width`);
    assert.equal(png.readUInt32BE(20), Number(size), `icon ${size} height`);
  }
  const cmd = manifest.commands['next-in-queue'];
  assert.equal(cmd.suggested_key.default, 'Alt+Shift+N');
});

test('manifest: every permission is used by the code, host access only to www.youtube.com', () => {
  assert.deepEqual([...manifest.permissions].sort(), Object.keys(USAGE).sort());
  for (const p of manifest.permissions) assert.match(code, USAGE[p], `permission ${p} unused`);
  assert.deepEqual(manifest.host_permissions, ['https://www.youtube.com/*']);
  for (const cs of manifest.content_scripts) {
    assert.deepEqual(cs.matches, manifest.host_permissions);
    assert.equal(cs.all_frames, false, 'embeds and iframes are left alone');
  }
  assert.deepEqual(manifest.web_accessible_resources[0].matches, manifest.host_permissions);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  for (const p of ['downloads', 'cookies', 'tabs', 'scripting', 'webRequest', 'history']) assert.ok(!manifest.permissions.includes(p), p);
  assert.ok(!/chrome\.cookies\b/.test(code), 'no cookies API');
  const main = manifest.content_scripts.find((c) => c.world === 'MAIN');
  assert.deepEqual(main.js, ['src/page/bridge.js']);
});

test('locales: ru and en complete, CWS length limits', () => {
  assert.deepEqual(LOCALES.sort(), ['en', 'ru']);
  const all = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(read(`_locales/${l}/messages.json`))]));
  const keys = Object.keys(all.ru).sort();
  const used = new Set([...code.matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_]+)"/g), ...code.matchAll(/\b(?:t|msg)\('([A-Za-z0-9_]+)'[,)]/g)].map((m) => m[1]));
  for (const m of JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(m[1]);
  // keys built at runtime
  for (const k of ['err_noContext', 'err_notLoggedIn', 'err_loadHttp', 'err_format', 'jobErr_auth', 'jobErr_rate', 'jobErr_network', 'speed_careful', 'speed_normal'])
    used.add(k);
  for (const s of ['running', 'paused', 'done', 'cancelled', 'error']) used.add(`jobStatus_${s}`);
  for (const l of LOCALES) {
    assert.deepEqual(Object.keys(all[l]).sort(), keys, `${l} keys`);
    for (const k of used) assert.ok(all[l][k], `${l}: missing ${k}`);
    assert.ok([...all[l].extName.message].length <= 75, `${l} name too long`);
    assert.ok([...all[l].extShortName.message].length <= 12, `${l} short_name too long`);
    assert.ok([...all[l].extDescription.message].length <= 132, `${l} description too long (${[...all[l].extDescription.message].length})`);
    assert.ok(!/youtube/i.test(all[l].extName.message), `${l}: no third-party trademark in the name`);
  }
  const unused = keys.filter((k) => !used.has(k));
  assert.deepEqual(unused, [], 'every message is used');
});

test('no remote code, eval or debug leftovers', () => {
  for (const f of codeFiles) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/<script[^>]+src="https?:/.test(src), `${f}: remote script`);
    assert.ok(!/\beval\(|new Function\(|debugger;/.test(src), `${f}: eval/debugger`);
    assert.ok(!/console\.(log|debug)\(/.test(src), `${f}: console.log`);
    assert.ok(!/\b(TODO|FIXME)\b/.test(src), `${f}: TODO left`);
  }
});

test('network: only the page bridge calls fetch, and only same-origin /youtubei/v1 paths', () => {
  const withFetch = codeFiles.filter((f) => /\bfetch\(/.test(stripComments(readFileSync(f, 'utf8'))));
  assert.deepEqual(withFetch.map((f) => f.slice(EXT.length + 1).replace(/\\/g, '/')), ['src/page/bridge.js']);
  const bridge = stripComments(read('src/page/bridge.js'));
  assert.match(bridge, /W\.fetch\(`\$\{origin\}\$\{path\}\?prettyPrint=false`/);
  assert.match(bridge, /const origin = W\.location\.origin;/);
  assert.match(bridge, /credentials: 'same-origin'/);
  assert.ok(!/XMLHttpRequest|sendBeacon|WebSocket|EventSource/.test(code), 'no other network APIs');
  // every absolute URL in the code points to YouTube or the brand site
  for (const m of stripComments(code).matchAll(/https?:\/\/[^\s'"`)<]+/g)) {
    assert.ok(/^https:\/\/(www\.youtube\.com|youtu\.be|ddvdvt\.github\.io)\//.test(m[0]) || m[0] === 'https://www.youtube.com', `unexpected URL ${m[0]}`);
  }
});
