// Parses the JSON that the YouTube web client itself receives for the Watch Later page
// (POST /youtubei/v1/browse with browseId "VLWL", then continuation tokens).
// Two item formats are understood:
//  - lockupViewModel        — the current playlist page format (seen on public playlists, 2026-10);
//  - playlistVideoRenderer  — the older format, still accepted in case it comes back.
// Pure module: no chrome.* and no DOM.

/**
 * @typedef {{ action: string, setVideoId?: string, removedVideoId?: string }} EditAction
 * @typedef {{
 *   key: string, videoId: string, setVideoId: string, title: string, channel: string, channelId: string,
 *   duration: number | null, durationText: string, progress: number | null, shorts: boolean, live: boolean,
 *   unavailable: boolean, index: number, remove: EditAction
 * }} WlItem
 */

const VIDEO_ID = /^[\w-]{11}$/;

/**
 * "1:02:03" / "12:05" / "0:59" → seconds; anything else → null.
 * @param {unknown} text
 * @returns {number | null}
 */
export function parseDuration(text) {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Seconds → "1:02:03" / "4:05".
 * @param {number | null | undefined} sec
 */
export function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * Depth-first search for every value stored under `key` (objects and arrays, bounded depth).
 * @param {any} obj
 * @param {string} key
 * @param {any[]} [out]
 * @param {number} [depth]
 * @returns {any[]}
 */
export function findAll(obj, key, out = [], depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 40) return out;
  if (Array.isArray(obj)) {
    for (const v of obj) findAll(v, key, out, depth + 1);
    return out;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (k === key) out.push(v);
    if (v && typeof v === 'object') findAll(v, key, out, depth + 1);
  }
  return out;
}

/** @param {any} t text object: {simpleText} | {runs:[{text}]} | {content} | string */
export function textOf(t) {
  if (t == null) return '';
  if (typeof t === 'string') return t;
  if (typeof t.content === 'string') return t.content;
  if (typeof t.simpleText === 'string') return t.simpleText;
  if (Array.isArray(t.runs)) return t.runs.map((r) => (r && r.text) || '').join('');
  return '';
}

/** Titles YouTube uses for videos that can no longer be played, e.g. "[Private video]", "[Удалённое видео]". */
const UNAVAILABLE_TITLE = /^\s*\[[^\]]{3,60}\]\s*$/;

/**
 * The "remove from Watch Later" action that YouTube's own UI attaches to this item, if present.
 * Prefers ACTION_REMOVE_VIDEO (menu item on the WL page, by setVideoId), then
 * ACTION_REMOVE_VIDEO_BY_VIDEO_ID (the "Watch later" toggle on thumbnails).
 * @param {any} raw
 * @returns {EditAction | null}
 */
export function removeActionIn(raw) {
  /** @type {EditAction | null} */
  let byId = null;
  for (const ep of findAll(raw, 'playlistEditEndpoint')) {
    if (!ep || ep.playlistId !== 'WL' || !Array.isArray(ep.actions)) continue;
    for (const a of ep.actions) {
      if (a && a.action === 'ACTION_REMOVE_VIDEO' && typeof a.setVideoId === 'string' && a.setVideoId) {
        return { action: 'ACTION_REMOVE_VIDEO', setVideoId: a.setVideoId };
      }
      if (a && a.action === 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID' && typeof a.removedVideoId === 'string' && VIDEO_ID.test(a.removedVideoId)) {
        byId = byId || { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: a.removedVideoId };
      }
    }
  }
  return byId;
}

/** @param {any} raw */
function progressIn(raw) {
  for (const key of ['startPercent', 'percentDurationWatched']) {
    for (const v of findAll(raw, key)) {
      const n = Number(v);
      if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
    }
  }
  return null;
}

/** @param {any} raw */
function looksShorts(raw) {
  if (findAll(raw, 'reelWatchEndpoint').length) return true;
  for (const u of findAll(raw, 'url')) if (typeof u === 'string' && u.startsWith('/shorts/')) return true;
  for (const s of findAll(raw, 'style')) if (s === 'SHORTS') return true;
  for (const s of findAll(raw, 'badgeStyle')) if (typeof s === 'string' && s.includes('SHORTS')) return true;
  const ct = raw && raw.contentType;
  return typeof ct === 'string' && ct.includes('SHORTS');
}

/**
 * @param {any} l lockupViewModel
 * @param {number} fallbackIndex 1-based
 * @returns {WlItem | null}
 */
export function itemFromLockup(l, fallbackIndex) {
  if (!l || typeof l !== 'object') return null;
  const videoId = typeof l.contentId === 'string' ? l.contentId : '';
  if (!VIDEO_ID.test(videoId)) return null;
  if (typeof l.contentType === 'string' && /PLAYLIST|CHANNEL|PODCAST/.test(l.contentType)) return null;
  const meta = (l.metadata && l.metadata.lockupMetadataViewModel) || {};
  const title = textOf(meta.title).trim();
  let channel = '';
  let channelId = '';
  const rows = (meta.metadata && meta.metadata.contentMetadataViewModel && meta.metadata.contentMetadataViewModel.metadataRows) || [];
  for (const row of rows) {
    for (const part of (row && row.metadataParts) || []) {
      const browse = findAll(part, 'browseEndpoint')[0];
      if (!channel && browse && typeof browse.browseId === 'string' && browse.browseId.startsWith('UC')) {
        channel = textOf(part.text).trim();
        channelId = browse.browseId;
      }
    }
  }
  let durationText = '';
  let live = false;
  for (const b of findAll(l.contentImage, 'thumbnailBadgeViewModel')) {
    const txt = textOf(b && b.text).trim();
    if (!durationText && parseDuration(txt) != null) durationText = txt;
    if (b && typeof b.badgeStyle === 'string' && b.badgeStyle.includes('LIVE')) live = true;
  }
  const watch = findAll(l.rendererContext, 'watchEndpoint')[0];
  const idx = watch && Number.isInteger(watch.index) ? watch.index + 1 : fallbackIndex;
  const remove = removeActionIn(l) || { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId };
  const setVideoId = remove.setVideoId || '';
  const duration = parseDuration(durationText);
  const unavailable = UNAVAILABLE_TITLE.test(title) || (!durationText && !channel && !live);
  return {
    key: setVideoId || `${videoId}#${idx}`,
    videoId,
    setVideoId,
    title,
    channel,
    channelId,
    duration,
    durationText,
    progress: progressIn(l.contentImage),
    shorts: looksShorts(l),
    live,
    unavailable,
    index: idx,
    remove,
  };
}

/**
 * @param {any} r playlistVideoRenderer
 * @param {number} fallbackIndex 1-based
 * @returns {WlItem | null}
 */
export function itemFromPvr(r, fallbackIndex) {
  if (!r || typeof r !== 'object' || !VIDEO_ID.test(String(r.videoId || ''))) return null;
  const videoId = r.videoId;
  const title = textOf(r.title).trim();
  const by = r.shortBylineText || {};
  const channel = textOf(by).trim();
  const browse = findAll(by, 'browseEndpoint')[0];
  const channelId = browse && typeof browse.browseId === 'string' ? browse.browseId : '';
  const idxText = Number(textOf(r.index).replace(/\D+/g, ''));
  const idx = idxText > 0 ? idxText : fallbackIndex;
  const fromMenu = removeActionIn(r.menu);
  const setVideoId = typeof r.setVideoId === 'string' ? r.setVideoId : (fromMenu && fromMenu.setVideoId) || '';
  /** @type {EditAction} */
  const remove = fromMenu || (setVideoId ? { action: 'ACTION_REMOVE_VIDEO', setVideoId } : { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId });
  const lengthSec = Number(r.lengthSeconds);
  const durationText = textOf(r.lengthText).trim();
  const duration = Number.isFinite(lengthSec) && r.lengthSeconds != null && r.lengthSeconds !== '' ? lengthSec : parseDuration(durationText);
  const live = findAll(r.thumbnailOverlays, 'style').some((s) => s === 'LIVE');
  return {
    key: setVideoId || `${videoId}#${idx}`,
    videoId,
    setVideoId,
    title,
    channel,
    channelId,
    duration,
    durationText: durationText || formatDuration(duration),
    progress: progressIn(r.thumbnailOverlays),
    shorts: looksShorts(r.thumbnailOverlays) || looksShorts(r.navigationEndpoint),
    live,
    unavailable: r.isPlayable === false || UNAVAILABLE_TITLE.test(title),
    index: idx,
    remove,
  };
}

/**
 * Parse one browse response (first page or a continuation).
 * Only the main content is read (contents / onResponseReceivedActions) — never header or sidebar items.
 * @param {any} json
 * @param {number} [startIndex] number of items already loaded (for 1-based fallback indexes)
 * @returns {{ items: WlItem[], continuation: string | null, totalHint: number | null, unknown: number, foundList: boolean }}
 */
export function parseBrowse(json, startIndex = 0) {
  const roots = [json && json.contents, json && json.onResponseReceivedActions, json && json.onResponseReceivedEndpoints].filter(Boolean);
  /** @type {WlItem[]} */
  const items = [];
  let unknown = 0;
  let foundList = false;
  for (const root of roots) {
    for (const arr of [...findAll(root, 'contents'), ...findAll(root, 'continuationItems')]) {
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.lockupViewModel) {
          foundList = true;
          const it = itemFromLockup(entry.lockupViewModel, startIndex + items.length + 1);
          if (it) items.push(it);
          else unknown++;
        } else if (entry.playlistVideoRenderer) {
          foundList = true;
          const it = itemFromPvr(entry.playlistVideoRenderer, startIndex + items.length + 1);
          if (it) items.push(it);
          else unknown++;
        } else if (entry.continuationItemViewModel || entry.continuationItemRenderer) {
          foundList = true;
        }
      }
    }
  }
  const tokens = roots.flatMap((r) => findAll(r, 'continuationCommand')).map((c) => c && c.token).filter((t) => typeof t === 'string' && t);
  return { items: dedupe(items), continuation: tokens.length ? tokens[tokens.length - 1] : null, totalHint: totalHint(json), unknown, foundList };
}

/** @param {WlItem[]} items */
function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => (seen.has(it.key) ? false : (seen.add(it.key), true)));
}

/**
 * Number of videos announced in the page header ("5 012 видео", "5,012 videos"), or null.
 * @param {any} json
 * @returns {number | null}
 */
export function totalHint(json) {
  const header = json && json.header;
  if (!header) return null;
  const texts = [...findAll(header, 'content'), ...findAll(header, 'simpleText'), ...findAll(header, 'text').map(textOf)].filter((s) => typeof s === 'string');
  for (const s of texts) {
    const m = /^\s*([\d][\d\s  .,]*)\s+(видео|video|videos|бейне)\s*$/iu.exec(s);
    if (m) {
      const n = Number(m[1].replace(/[^\d]/g, ''));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * Video id from any YouTube video URL (watch, shorts, youtu.be, embed, live), or null.
 * @param {string} href
 * @param {string} [base]
 */
export function videoIdFromUrl(href, base = 'https://www.youtube.com/') {
  let u;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com' || u.origin === new URL(base).origin) {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname);
      if (m) id = m[2];
    }
  }
  return id && VIDEO_ID.test(id) ? id : null;
}
