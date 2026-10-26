// Backup files of the Watch Later list (JSON for restoring, CSV for spreadsheets) and their parser.
// Pure module.

import { formatDuration } from './wl-parse.js';

export const BACKUP_FORMAT = 'watch-later-backup';
const VIDEO_ID = /^[\w-]{11}$/;

/**
 * @typedef {import('./wl-parse.js').WlItem} WlItem
 * @typedef {{ position: number, videoId: string, setVideoId: string, title: string, channel: string, channelId: string,
 *   duration: string, durationSeconds: number | null, watchedPercent: number | null, unavailable: boolean, shorts: boolean, selected: boolean }} BackupRow
 * @typedef {{ format: string, version: number, createdAt: string, playlist: 'WL', count: number, selectedCount: number, note: string, items: BackupRow[] }} Backup
 */

/**
 * Whole loaded list, with `selected: true` on the rows that are about to be removed.
 * @param {WlItem[]} items
 * @param {Set<string>} selected keys
 * @param {Date} [now]
 * @returns {Backup}
 */
export function makeBackup(items, selected, now = new Date()) {
  const rows = items.map((it) => ({
    position: it.index,
    videoId: it.videoId,
    setVideoId: it.setVideoId,
    title: it.title,
    channel: it.channel,
    channelId: it.channelId,
    duration: it.durationText || formatDuration(it.duration),
    durationSeconds: it.duration,
    watchedPercent: it.progress,
    unavailable: it.unavailable,
    shorts: it.shorts,
    selected: selected.has(it.key),
  }));
  return {
    format: BACKUP_FORMAT,
    version: 1,
    createdAt: now.toISOString(),
    playlist: 'WL',
    count: rows.length,
    selectedCount: rows.filter((r) => r.selected).length,
    note: 'Rows with "selected": true were chosen for removal. Watch Later list as loaded before the removal.',
    items: rows,
  };
}

/** wl-backup-2026-10-26-1430.json @param {Date} d @param {'json' | 'csv'} ext */
export function backupFileName(d, ext) {
  const p = (n) => String(n).padStart(2, '0');
  return `watch-later-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

/** @param {Backup} b */
export const toJson = (b) => JSON.stringify(b, null, 1);

const CSV_COLUMNS = /** @type {const} */ (['position', 'videoId', 'title', 'channel', 'channelId', 'duration', 'durationSeconds', 'watchedPercent', 'unavailable', 'shorts', 'selected', 'url']);

/** @param {unknown} v */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  // spreadsheet formula injection guard
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV with a UTF-8 BOM (opens correctly in Excel), comma separated, CRLF line ends.
 * @param {Backup} b
 */
export function toCsv(b) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of b.items) {
    const row = { ...r, url: `https://www.youtube.com/watch?v=${r.videoId}` };
    lines.push(CSV_COLUMNS.map((c) => csvCell(/** @type {any} */ (row)[c])).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/**
 * Minimal RFC 4180 CSV parser (quotes, doubled quotes, newlines inside quotes; , or ; separator).
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  /** @type {string[][]} */
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

/**
 * Read a backup made by this extension (JSON or CSV). Returns the rows or an error code.
 * @param {string} text
 * @returns {{ ok: true, rows: BackupRow[], createdAt: string } | { ok: false, error: 'empty' | 'format' }}
 */
export function parseBackup(text) {
  const s = String(text || '').trim();
  if (!s) return { ok: false, error: 'empty' };
  if (s.startsWith('{')) {
    let j;
    try {
      j = JSON.parse(s);
    } catch {
      return { ok: false, error: 'format' };
    }
    if (!j || j.format !== BACKUP_FORMAT || !Array.isArray(j.items)) return { ok: false, error: 'format' };
    const rows = j.items.filter((r) => r && VIDEO_ID.test(String(r.videoId))).map(normalizeRow);
    return rows.length ? { ok: true, rows, createdAt: String(j.createdAt || '') } : { ok: false, error: 'empty' };
  }
  const table = parseCsv(s);
  const head = (table.shift() || []).map((h) => h.trim().replace(/^﻿/, ''));
  const col = (n) => head.indexOf(n);
  if (col('videoId') < 0) return { ok: false, error: 'format' };
  const rows = table
    .map((cells) => Object.fromEntries(head.map((h, i) => [h, (cells[i] || '').replace(/^'(?=[=+\-@])/, '')])))
    .filter((r) => VIDEO_ID.test(r.videoId))
    .map(normalizeRow);
  return rows.length ? { ok: true, rows, createdAt: '' } : { ok: false, error: 'empty' };
}

/** @param {any} r @returns {BackupRow} */
function normalizeRow(r) {
  const bool = (v) => v === true || v === 'true' || v === '1';
  const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    position: Number(r.position) || 0,
    videoId: String(r.videoId),
    setVideoId: String(r.setVideoId || ''),
    title: String(r.title || ''),
    channel: String(r.channel || ''),
    channelId: String(r.channelId || ''),
    duration: String(r.duration || ''),
    durationSeconds: num(r.durationSeconds),
    watchedPercent: num(r.watchedPercent),
    unavailable: bool(r.unavailable),
    shorts: bool(r.shorts),
    selected: bool(r.selected),
  };
}

/**
 * Rows to re-add when restoring: by default only rows that were selected for removal, never
 * unavailable videos (they cannot be added back), never videos that are already in the list,
 * each video once, in the original list order.
 * @param {BackupRow[]} rows
 * @param {{ onlySelected?: boolean, present?: Set<string> }} [opts]
 */
export function restorePlan(rows, opts = {}) {
  const onlySelected = opts.onlySelected !== false && rows.some((r) => r.selected);
  const present = opts.present || new Set();
  const seen = new Set();
  return rows
    .filter((r) => (!onlySelected || r.selected) && !r.unavailable && !present.has(r.videoId))
    .sort((a, b) => a.position - b.position)
    .filter((r) => (seen.has(r.videoId) ? false : (seen.add(r.videoId), true)));
}
