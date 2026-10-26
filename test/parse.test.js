import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBrowse, parseDuration, formatDuration, itemFromPvr, itemFromLockup, totalHint, videoIdFromUrl, removeActionIn } from '../extension/lib/wl-parse.js';
import { browsePage, spec, videoIdOf, setVideoIdOf } from '../e2e/fixtures/wl-data.mjs';

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
const firstLockup = (n) =>
  structuredClone(browsePage([n], 0, { first: true }).contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents[0].itemSectionRenderer.contents[0].lockupViewModel);

test('durations', () => {
  assert.equal(parseDuration('0:59'), 59);
  assert.equal(parseDuration('12:05'), 725);
  assert.equal(parseDuration('1:02:03'), 3723);
  assert.equal(parseDuration(' 3:32 '), 212);
  for (const bad of ['', 'LIVE', 'SHORTS', '3:5', null, undefined, '1:2:3:4']) assert.equal(parseDuration(bad), null, String(bad));
  assert.equal(formatDuration(3723), '1:02:03');
  assert.equal(formatDuration(59), '0:59');
  assert.equal(formatDuration(null), '');
});

test('first page: 100 lockups, continuation token, header total; sidebar ignored', () => {
  const list = range(1, 250);
  const p = parseBrowse(browsePage(list, 0, { first: true }));
  assert.equal(p.items.length, 100);
  assert.equal(p.continuation, 'page-100');
  assert.equal(p.totalHint, 250);
  assert.equal(p.foundList, true);
  assert.ok(!p.items.some((i) => i.videoId === 'sidebarxxxx'));
  const it = p.items[0];
  const s = spec(1);
  assert.equal(it.videoId, videoIdOf(1));
  assert.equal(it.setVideoId, setVideoIdOf(1));
  assert.equal(it.key, setVideoIdOf(1));
  assert.deepEqual(it.remove, { action: 'ACTION_REMOVE_VIDEO', setVideoId: setVideoIdOf(1) });
  assert.equal(it.title, s.title);
  assert.equal(it.channel, s.channel);
  assert.equal(it.channelId, s.channelId);
  assert.equal(it.duration, s.duration);
  assert.equal(it.index, 1);
  assert.equal(p.items[99].index, 100);
});

test('continuation page and the last page', () => {
  const list = range(1, 250);
  const p2 = parseBrowse(browsePage(list, 100), 100);
  assert.equal(p2.items.length, 100);
  assert.equal(p2.items[0].index, 101);
  assert.equal(p2.continuation, 'page-200');
  const p3 = parseBrowse(browsePage(list, 200), 200);
  assert.equal(p3.items.length, 50);
  assert.equal(p3.continuation, null);
});

test('flags: watched progress, shorts, unavailable', () => {
  const items = parseBrowse(browsePage(range(1, 100), 0, { first: true })).items;
  const by = (n) => items.find((i) => i.videoId === videoIdOf(n));
  assert.equal(by(5).progress, 100);
  assert.equal(by(7).progress, 45);
  assert.equal(by(1).progress, null);
  assert.equal(by(19).shorts, true);
  assert.equal(by(19).duration, spec(19).duration);
  assert.equal(by(38).shorts, true);
  assert.equal(by(1).shorts, false);
  assert.equal(by(37).unavailable, true);
  assert.equal(by(74).unavailable, true);
  assert.equal(by(37).channel, '');
  assert.equal(items.filter((i) => i.unavailable).length, 2);
  assert.equal(items.filter((i) => i.shorts).length, 5); // 19 38 57 76 95
});

test('lockup without a menu falls back to removal by video id (as the thumbnail toggle does)', () => {
  const l = firstLockup(3);
  delete l.metadata.lockupMetadataViewModel.menuButton;
  const it = itemFromLockup(l, 7);
  assert.deepEqual(it.remove, { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoIdOf(3) });
  assert.equal(it.setVideoId, '');
  assert.equal(it.key, `${videoIdOf(3)}#1`);
  const toggle = { playlistEditEndpoint: { playlistId: 'WL', actions: [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoIdOf(3) }] } };
  assert.deepEqual(removeActionIn({ a: toggle }), { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoIdOf(3) });
  assert.equal(removeActionIn({ playlistEditEndpoint: { playlistId: 'PLx', actions: [{ action: 'ACTION_REMOVE_VIDEO', setVideoId: 'X' }] } }), null);
  assert.equal(itemFromLockup({ contentId: 'PLabcdefghi', contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST' }, 1), null);
  assert.equal(itemFromLockup({ contentId: 'bad' }, 1), null);
});

test('older playlistVideoRenderer format', () => {
  const r = {
    videoId: 'abcdefghijk',
    setVideoId: 'SETID1',
    title: { runs: [{ text: 'Old format video' }] },
    shortBylineText: { runs: [{ text: 'Channel A', navigationEndpoint: { browseEndpoint: { browseId: 'UCaaaa' } } }] },
    index: { simpleText: '42' },
    lengthSeconds: '212',
    lengthText: { simpleText: '3:32' },
    isPlayable: true,
    thumbnailOverlays: [{ thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: 93 } }, { thumbnailOverlayTimeStatusRenderer: { style: 'DEFAULT' } }],
  };
  const it = itemFromPvr(r, 1);
  assert.equal(it.index, 42);
  assert.equal(it.duration, 212);
  assert.equal(it.progress, 93);
  assert.equal(it.channelId, 'UCaaaa');
  assert.deepEqual(it.remove, { action: 'ACTION_REMOVE_VIDEO', setVideoId: 'SETID1' });
  const gone = itemFromPvr({ videoId: 'zzzzzzzzzzz', title: { simpleText: '[Deleted video]' }, isPlayable: false, index: { simpleText: '3' } }, 1);
  assert.equal(gone.unavailable, true);
  assert.equal(gone.duration, null);
  const short = itemFromPvr({ ...r, thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { style: 'SHORTS' } }] }, 1);
  assert.equal(short.shorts, true);
  const page = parseBrowse({ contents: { a: { playlistVideoListRenderer: { contents: [{ playlistVideoRenderer: r }, { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TOK' } } } }] } } } });
  assert.equal(page.items.length, 1);
  assert.equal(page.continuation, 'TOK');
});

test('unknown / empty responses and the header count', () => {
  assert.deepEqual(parseBrowse(null).items, []);
  const p = parseBrowse({ contents: { x: { contents: [{ somethingNewViewModel: {} }] } } });
  assert.equal(p.items.length, 0);
  assert.equal(p.foundList, false);
  assert.equal(totalHint({ header: { a: { text: { content: '5 012 видео' } } } }), 5012);
  assert.equal(totalHint({ header: { a: { simpleText: '5,012 videos' } } }), 5012);
  assert.equal(totalHint({ header: { a: { text: { content: '1 045 672 просмотров' } } } }), null);
});

test('video ids from URLs', () => {
  assert.equal(videoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=WL'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFromUrl('/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFromUrl('/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFromUrl('https://youtu.be/dQw4w9WgXcQ?t=5'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFromUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFromUrl('http://127.0.0.1:5000/watch?v=dQw4w9WgXcQ', 'http://127.0.0.1:5000/'), 'dQw4w9WgXcQ');
  for (const bad of ['https://evil.example/watch?v=dQw4w9WgXcQ', '/watch?v=short', '/channel/UCx', 'http://[bad', '/playlist?list=WL']) assert.equal(videoIdFromUrl(bad), null, bad);
});

test('5000 items parse quickly', () => {
  const list = range(1, 5000);
  const t0 = performance.now();
  let n = 0;
  for (let off = 0; off < 5000; off += 100) n += parseBrowse(browsePage(list, off, { first: off === 0 }), off).items.length;
  assert.equal(n, 5000);
  assert.ok(performance.now() - t0 < 4000, 'parsing 5000 items takes under 4 s even on a slow machine');
});
