import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZip } from '../scripts/zip.mjs';
import { readZip, packageProblems } from '../scripts/zipcheck.mjs';

const enc = (s) => new TextEncoder().encode(s);
const manifest = JSON.stringify({
  default_locale: 'ru',
  background: { service_worker: 'src/background.js' },
  action: { default_popup: 'src/popup/popup.html' },
  icons: { 16: 'icons/icon16.png' },
  content_scripts: [{ js: ['src/content/loader.js'] }],
});
const good = [
  { name: 'manifest.json', data: enc(manifest) },
  { name: '_locales/ru/messages.json', data: enc('{}') },
  { name: 'src/background.js', data: enc('//') },
  { name: 'src/popup/popup.html', data: enc('<p>') },
  { name: 'src/content/loader.js', data: enc('//') },
  { name: 'icons/icon16.png', data: new Uint8Array([1, 2, 3]) },
  { name: 'lib/ünïcode.js', data: enc('ok') },
];

test('zip round trip keeps names and bytes', () => {
  const entries = readZip(createZip(good));
  assert.deepEqual(entries.map((e) => e.name), good.map((f) => f.name));
  assert.deepEqual([...entries[5].data], [1, 2, 3]);
  assert.deepEqual(packageProblems(entries), []);
});

test('corruption is detected', () => {
  const z = createZip(good);
  const i = z.indexOf(0x6f, 200); // flip some byte inside an entry
  z[i] ^= 0xff;
  assert.throws(() => readZip(z), /CRC mismatch|bad/);
  assert.throws(() => readZip(new Uint8Array(10)), /end of central directory/);
});

test('package rules: root manifest, locales, referenced files, no junk', () => {
  const p = packageProblems(
    readZip(
      createZip([
        { name: 'ext/manifest.json', data: enc(manifest) },
        { name: '.DS_Store', data: enc('') },
        { name: 'test/a.test.js', data: enc('') },
        { name: 'keys/k.pem', data: enc('') },
        { name: 'a\\b.js', data: enc('') },
      ]),
    ),
  );
  for (const part of ['not at the root', 'dotfile', 'test/a.test.js', 'keys/k.pem', 'backslash']) assert.ok(p.some((x) => x.includes(part)), part);
  const missing = packageProblems(readZip(createZip(good.filter((f) => !f.name.startsWith('_locales') && f.name !== 'src/background.js'))));
  assert.ok(missing.includes('default locale missing'));
  assert.ok(missing.includes('manifest references missing file src/background.js'));
});
