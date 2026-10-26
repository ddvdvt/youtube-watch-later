// Packs extension/ into dist/youtube-watch-later-<version>.zip for the Chrome Web Store (no dependencies),
// then reads the archive back and verifies it (CRC of every entry, manifest at the root, locales,
// forward slashes, no dotfiles / tests / node_modules / keys).
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './zip.mjs';
import { readZip, packageProblems } from './zipcheck.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || name === 'Thumbs.db') continue; // no dotfiles in the store package
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push({ name: relative(ext, p).split(sep).join('/'), data: new Uint8Array(readFileSync(p)) });
  }
})(ext);
const { version } = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', `youtube-watch-later-${version}.zip`);
writeFileSync(out, createZip(files));

const entries = readZip(new Uint8Array(readFileSync(out)));
const problems = packageProblems(entries);
if (entries.length !== files.length) problems.push(`expected ${files.length} entries, found ${entries.length}`);
for (const lang of readdirSync(join(ext, '_locales'))) if (!entries.some((e) => e.name === `_locales/${lang}/messages.json`)) problems.push(`locale ${lang} missing`);
if (problems.length) {
  console.error(`${out} is NOT valid:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
const kb = (statSync(out).size / 1024).toFixed(1);
console.log(`${entries.length} files, ${kb} KB -> ${out} (verified)`);
