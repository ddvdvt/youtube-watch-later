// Reads back a ZIP made by zip.mjs (stored entries) and checks it is a valid Chrome Web Store package.
import { crc32 } from './zip.mjs';

/**
 * Parse the central directory and verify every entry's local header and CRC.
 * @param {Uint8Array} buf
 * @returns {{ name: string, size: number, data: Uint8Array }[]}
 */
export function readZip(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end of central directory');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder('utf-8', { fatal: true });
  const out = [];
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error(`bad central header #${n}`);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extra = v.getUint16(p + 30, true);
    const comment = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (method !== 0) throw new Error(`${name}: unexpected compression method ${method}`);
    if (v.getUint32(local, true) !== 0x04034b50) throw new Error(`${name}: bad local header`);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = buf.subarray(start, start + size);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC mismatch`);
    out.push({ name, size, data });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

/**
 * Store-package rules. Returns a list of problems (empty = OK).
 * @param {{ name: string, data: Uint8Array }[]} entries
 */
export function packageProblems(entries) {
  const problems = [];
  const names = entries.map((e) => e.name);
  const has = (n) => names.includes(n);
  if (!has('manifest.json')) problems.push('manifest.json is not at the root');
  for (const n of names) {
    if (n.includes('\\')) problems.push(`${n}: backslash in path`);
    if (n.split('/').some((part) => part.startsWith('.'))) problems.push(`${n}: dotfile`);
    if (/(^|\/)(node_modules|test|e2e|store|scripts|keys)\//.test(n) || /\.(pem|md|map|zip)$/.test(n)) problems.push(`${n}: does not belong in the package`);
  }
  if (has('manifest.json')) {
    const m = JSON.parse(new TextDecoder().decode(entries.find((e) => e.name === 'manifest.json').data));
    if (m.default_locale && !has(`_locales/${m.default_locale}/messages.json`)) problems.push('default locale missing');
    const refs = [m.background?.service_worker, m.action?.default_popup, m.options_ui?.page, ...Object.values(m.icons || {}), ...(m.content_scripts || []).flatMap((c) => c.js || [])];
    for (const r of refs) if (r && !has(r)) problems.push(`manifest references missing file ${r}`);
  }
  return problems;
}
