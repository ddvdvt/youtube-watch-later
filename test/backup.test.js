import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBackup, toJson, toCsv, parseCsv, parseBackup, restorePlan, backupFileName, BACKUP_FORMAT } from '../extension/lib/backup.js';
import { parseBrowse } from '../extension/lib/wl-parse.js';
import { browsePage, setVideoIdOf, videoIdOf } from '../e2e/fixtures/wl-data.mjs';

const items = parseBrowse(browsePage(Array.from({ length: 80 }, (_, k) => k + 1), 0, { first: true })).items;
const selected = new Set([setVideoIdOf(2), setVideoIdOf(37), setVideoIdOf(5)]);

test('backup holds the whole list and marks the selection', () => {
  const b = makeBackup(items, selected, new Date('2026-10-26T10:00:00Z'));
  assert.equal(b.format, BACKUP_FORMAT);
  assert.equal(b.count, 80);
  assert.equal(b.selectedCount, 3);
  assert.equal(b.createdAt, '2026-10-26T10:00:00.000Z');
  const r = b.items[1];
  assert.equal(r.videoId, videoIdOf(2));
  assert.equal(r.setVideoId, setVideoIdOf(2));
  assert.equal(r.position, 2);
  assert.equal(r.selected, true);
  assert.equal(b.items[0].selected, false);
  for (const k of ['videoId', 'title', 'channel', 'duration', 'position']) assert.ok(k in r, k);
});

test('JSON round trip', () => {
  const b = makeBackup(items, selected);
  const p = parseBackup(toJson(b));
  assert.equal(p.ok, true);
  assert.equal(p.rows.length, 80);
  assert.equal(p.rows.filter((r) => r.selected).length, 3);
  assert.equal(p.rows[36].unavailable, true);
});

test('CSV: BOM, header, quoting, formula guard, round trip', () => {
  const tricky = [{ ...items[0], title: 'He said "hi", then =SUM(A1)\nnext line', channel: '+cmd' }, ...items.slice(1, 5)];
  const csv = toCsv(makeBackup(tricky, new Set([tricky[0].key])));
  assert.ok(csv.startsWith('﻿position,videoId,title,channel'));
  assert.ok(csv.includes('"He said ""hi"", then =SUM(A1)\nnext line"'));
  assert.ok(csv.includes(",'+cmd,"));
  assert.ok(csv.includes(`https://www.youtube.com/watch?v=${videoIdOf(1)}`));
  const p = parseBackup(csv);
  assert.equal(p.ok, true);
  assert.equal(p.rows.length, 5);
  assert.equal(p.rows[0].title, tricky[0].title);
  assert.equal(p.rows[0].channel, '+cmd');
  assert.equal(p.rows[0].selected, true);
  assert.equal(p.rows[1].selected, false);
});

test('CSV parser: semicolons, CRLF, empty lines', () => {
  assert.deepEqual(parseCsv('a;b\r\n"x;y";2\r\n\r\n'), [['a', 'b'], ['x;y', '2']]);
  assert.deepEqual(parseCsv('a,b\n1,"2\n3"'), [['a', 'b'], ['1', '2\n3']]);
});

test('bad files are rejected', () => {
  assert.deepEqual(parseBackup(''), { ok: false, error: 'empty' });
  assert.deepEqual(parseBackup('{oops'), { ok: false, error: 'format' });
  assert.deepEqual(parseBackup('{"format":"other","items":[]}'), { ok: false, error: 'format' });
  assert.deepEqual(parseBackup('name,url\nx,y'), { ok: false, error: 'format' });
  assert.deepEqual(parseBackup(JSON.stringify({ format: BACKUP_FORMAT, items: [{ videoId: 'bad' }] })), { ok: false, error: 'empty' });
});

test('restore plan: selected rows only, no unavailable, nothing already present, no duplicates', () => {
  const rows = parseBackup(toJson(makeBackup(items, selected))).rows;
  const plan = restorePlan(rows);
  assert.deepEqual(plan.map((r) => r.videoId), [videoIdOf(2), videoIdOf(5)]); // 37 is unavailable
  assert.equal(restorePlan(rows, { present: new Set([videoIdOf(2)]) }).length, 1);
  // a backup without a selection (manual export) restores every available row
  const all = restorePlan(parseBackup(toJson(makeBackup(items, new Set()))).rows);
  assert.equal(all.length, items.filter((i) => !i.unavailable).length);
  const dup = restorePlan([...rows, { ...rows[1] }]);
  assert.equal(dup.length, 2);
});

test('file names', () => {
  const d = new Date(2026, 9, 6, 9, 5);
  assert.equal(backupFileName(d, 'json'), 'watch-later-backup-2026-10-06-0905.json');
  assert.equal(backupFileName(d, 'csv'), 'watch-later-backup-2026-10-06-0905.csv');
});
