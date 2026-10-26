// Planning and bookkeeping of a bulk edit job on Watch Later (remove, or restore from a backup).
// The content script sends the requests; this module decides batch sizes, delays and backoff,
// and how each answer changes the job. Pure module: the job is a plain JSON object that is saved
// to storage after every batch, so a reload can resume exactly where it stopped.

/**
 * @typedef {import('./wl-parse.js').EditAction} EditAction
 * @typedef {{ k: string, v: string, s: string, t: string }} JobItem  key, videoId, setVideoId, title
 * @typedef {'remove' | 'restore'} JobMode
 * @typedef {'running' | 'paused' | 'done' | 'cancelled' | 'error'} JobStatus
 * @typedef {{
 *   id: string, mode: JobMode, dry: boolean, status: JobStatus, total: number, cursor: number,
 *   done: number, failed: { k: string, v: string, t: string, why: string }[], singlesUntil: number,
 *   errors: number, requests: number, batch: number, delayMs: number, error: string,
 *   createdAt: number, updatedAt: number, backupName: string
 * }} Job
 * @typedef {'ok' | 'rate' | 'bad' | 'auth' | 'retry'} Outcome
 */

/** Batch size and pause between requests. The first request of a job always carries one video. */
export const SPEEDS = {
  careful: { batch: 10, delayMs: 3000 },
  normal: { batch: 25, delayMs: 1500 },
};

/** After this many failed requests in a row the job pauses itself. */
export const MAX_CONSECUTIVE_ERRORS = 6;
export const MAX_BACKOFF_MS = 5 * 60 * 1000;

/**
 * @param {{ mode: JobMode, total: number, speed?: string, dry?: boolean, backupName?: string, now?: number, id?: string }} o
 * @returns {Job}
 */
export function createJob(o) {
  const sp = SPEEDS[/** @type {keyof typeof SPEEDS} */ (o.speed)] || SPEEDS.normal;
  const now = o.now ?? Date.now();
  return {
    id: o.id || `job-${now.toString(36)}`,
    mode: o.mode,
    dry: !!o.dry,
    status: 'running',
    total: o.total,
    cursor: 0,
    done: 0,
    failed: [],
    singlesUntil: 0,
    errors: 0,
    requests: 0,
    batch: sp.batch,
    delayMs: sp.delayMs,
    error: '',
    createdAt: now,
    updatedAt: now,
    backupName: o.backupName || '',
  };
}

/**
 * Indexes [from, to) of the next batch, or null when everything was sent.
 * The very first request carries a single video (a pilot: if YouTube rejects the format, only one
 * video is involved). After a rejected batch the same range is retried one video at a time.
 * @param {Job} job
 * @returns {{ from: number, to: number } | null}
 */
export function nextRange(job) {
  if (job.cursor >= job.total) return null;
  const size = job.requests === 0 || job.done === 0 || job.cursor < job.singlesUntil ? 1 : job.batch;
  return { from: job.cursor, to: Math.min(job.total, job.cursor + size) };
}

/**
 * The edit actions for a batch, exactly as YouTube's own UI builds them.
 * @param {JobMode} mode
 * @param {JobItem[]} batch
 * @returns {EditAction[] | any[]}
 */
export function actionsFor(mode, batch) {
  if (mode === 'restore') return batch.map((it) => ({ addedVideoId: it.v, action: 'ACTION_ADD_VIDEO' }));
  return batch.map((it) => (it.s ? { action: 'ACTION_REMOVE_VIDEO', setVideoId: it.s } : { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: it.v }));
}

/**
 * Classify an answer of /youtubei/v1/browse/edit_playlist.
 * @param {number} status HTTP status (0 = network error)
 * @param {any} json
 * @returns {Outcome}
 */
export function classify(status, json) {
  if (status === 200) {
    if (json && json.status === 'STATUS_SUCCEEDED') return 'ok';
    if (json && (json.status === 'STATUS_FAILED' || json.error)) return 'bad';
    return json && typeof json === 'object' && !json.status ? 'ok' : 'bad';
  }
  if (status === 429) return 'rate';
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 404 || status === 409) return 'bad';
  return 'retry'; // 0 (network), 5xx, anything unexpected
}

/**
 * Pause before the next request: the base delay ±30 % jitter, or exponential backoff after errors
 * (respecting Retry-After), capped at 5 minutes.
 * @param {number} baseMs
 * @param {number} errors consecutive failed requests
 * @param {number | null} [retryAfterSec]
 * @param {() => number} [rand]
 */
export function delayFor(baseMs, errors, retryAfterSec = null, rand = Math.random) {
  const jitter = 0.7 + rand() * 0.6;
  if (errors <= 0) return Math.round(baseMs * jitter);
  const backoff = Math.min(MAX_BACKOFF_MS, baseMs * 2 ** Math.min(errors, 12) * jitter);
  const ra = retryAfterSec && retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
  return Math.round(Math.min(MAX_BACKOFF_MS, Math.max(backoff, ra)));
}

/**
 * Apply the outcome of one request for range [from, to). Returns the new job and the pause before the next request.
 * @param {Job} job
 * @param {{ from: number, to: number }} range
 * @param {JobItem[]} batch
 * @param {Outcome} outcome
 * @param {{ retryAfterSec?: number | null, now?: number, rand?: () => number, message?: string }} [o]
 * @returns {{ job: Job, waitMs: number }}
 */
export function applyOutcome(job, range, batch, outcome, o = {}) {
  const j = { ...job, failed: job.failed.slice(), requests: job.requests + 1, updatedAt: o.now ?? Date.now() };
  const size = range.to - range.from;
  if (outcome === 'ok') {
    j.cursor = range.to;
    j.done += size;
    j.errors = 0;
  } else if (outcome === 'bad' && size > 1) {
    // the batch as a whole was rejected: retry the same videos one by one
    j.singlesUntil = range.to;
    j.errors = 0;
    return { job: finish(j), waitMs: delayFor(j.delayMs, 0, null, o.rand) };
  } else if (outcome === 'bad') {
    // this single video cannot be edited (already removed, not in the list…): note it and move on
    for (const it of batch) j.failed.push({ k: it.k, v: it.v, t: it.t, why: o.message || 'rejected' });
    j.cursor = range.to;
    j.errors = 0;
  } else if (outcome === 'auth') {
    j.status = 'error';
    j.error = 'auth';
  } else {
    j.errors += 1;
    if (j.errors >= MAX_CONSECUTIVE_ERRORS) {
      j.status = 'paused';
      j.error = outcome === 'rate' ? 'rate' : 'network';
    }
  }
  return { job: finish(j), waitMs: delayFor(j.delayMs, j.errors, o.retryAfterSec ?? null, o.rand) };
}

/** @param {Job} j */
function finish(j) {
  if (j.cursor >= j.total && j.status === 'running') j.status = 'done';
  return j;
}

/**
 * Progress numbers for the UI. ETA is a rough estimate from the batch size and base delay.
 * @param {Job} job
 */
export function progressOf(job) {
  const handled = job.cursor;
  const left = Math.max(0, job.total - handled);
  const requestsLeft = Math.ceil(left / Math.max(1, job.batch));
  return {
    done: job.done,
    failed: job.failed.length,
    handled,
    total: job.total,
    pct: job.total ? Math.floor((handled / job.total) * 100) : 100,
    etaMs: requestsLeft * (job.delayMs + 400),
  };
}

/** A job that can still be continued after a reload. @param {Job | null | undefined} job */
export const isResumable = (job) => !!job && (job.status === 'running' || job.status === 'paused' || job.status === 'error') && job.cursor < job.total;

/**
 * Estimated duration of a job before it starts, in ms.
 * @param {number} count
 * @param {string} speed
 */
export function estimateMs(count, speed) {
  const sp = SPEEDS[/** @type {keyof typeof SPEEDS} */ (speed)] || SPEEDS.normal;
  if (count <= 0) return 0;
  return (1 + Math.ceil(Math.max(0, count - 1) / sp.batch)) * (sp.delayMs + 400);
}
