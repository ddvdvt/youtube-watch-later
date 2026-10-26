import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJob, nextRange, actionsFor, classify, applyOutcome, delayFor, progressOf, isResumable, estimateMs, SPEEDS, MAX_CONSECUTIVE_ERRORS, MAX_BACKOFF_MS } from '../extension/lib/runner.js';

const items = Array.from({ length: 60 }, (_, i) => ({ k: `S${i}`, v: `v${String(i).padStart(10, '0')}`, s: `S${i}`, t: `T${i}` }));
const half = () => 0.5; // jitter factor 1.0

/** Run a job to the end with a scripted server. */
function simulate(job, answer) {
  const sent = [];
  let guard = 0;
  while (job.status === 'running' && guard++ < 1000) {
    const r = nextRange(job);
    if (!r) break;
    const batch = items.slice(r.from, r.to);
    sent.push(batch.length);
    const { job: next } = applyOutcome(job, r, batch, answer(batch, sent.length), { rand: half });
    job = next;
  }
  return { job, sent };
}

test('first request carries one video, then full batches', () => {
  const job = createJob({ mode: 'remove', total: 60, speed: 'normal', now: 1 });
  assert.equal(job.batch, SPEEDS.normal.batch);
  const { job: end, sent } = simulate(job, () => 'ok');
  assert.deepEqual(sent, [1, 25, 25, 9]);
  assert.equal(end.status, 'done');
  assert.equal(end.done, 60);
  assert.equal(end.requests, 4);
  const careful = simulate(createJob({ mode: 'remove', total: 60, speed: 'careful' }), () => 'ok');
  assert.deepEqual(careful.sent, [1, 10, 10, 10, 10, 10, 9]);
});

test('edit actions are the ones the web client uses', () => {
  assert.deepEqual(actionsFor('remove', [items[0]]), [{ action: 'ACTION_REMOVE_VIDEO', setVideoId: 'S0' }]);
  assert.deepEqual(actionsFor('remove', [{ k: 'x', v: 'abcdefghijk', s: '', t: '' }]), [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: 'abcdefghijk' }]);
  assert.deepEqual(actionsFor('restore', [{ k: 'x', v: 'abcdefghijk', s: '', t: '' }]), [{ addedVideoId: 'abcdefghijk', action: 'ACTION_ADD_VIDEO' }]);
});

test('classify answers', () => {
  assert.equal(classify(200, { status: 'STATUS_SUCCEEDED' }), 'ok');
  assert.equal(classify(200, { responseContext: {} }), 'ok');
  assert.equal(classify(200, { status: 'STATUS_FAILED' }), 'bad');
  assert.equal(classify(200, null), 'bad');
  assert.equal(classify(429, null), 'rate');
  assert.equal(classify(401, null), 'auth');
  assert.equal(classify(403, null), 'auth');
  assert.equal(classify(400, {}), 'bad');
  assert.equal(classify(500, {}), 'retry');
  assert.equal(classify(0, null), 'retry');
});

test('a rejected batch is retried one video at a time; bad single videos are skipped', () => {
  const job = createJob({ mode: 'remove', total: 30, speed: 'normal' });
  // video 7 can never be removed; any batch containing it is rejected
  const { job: end, sent } = simulate(job, (batch) => (batch.some((b) => b.k === 'S7') ? 'bad' : 'ok'));
  assert.equal(end.status, 'done');
  assert.equal(end.done, 29);
  assert.deepEqual(end.failed.map((f) => f.k), ['S7']);
  assert.deepEqual(sent.slice(0, 3), [1, 25, 1]); // pilot, rejected batch, then singles
  assert.equal(sent.filter((n) => n === 1).length, 26);
});

test('429 and network errors back off without advancing, then pause after too many', () => {
  let job = createJob({ mode: 'remove', total: 10, speed: 'normal' });
  const r = nextRange(job);
  const a = applyOutcome(job, r, items.slice(0, 1), 'rate', { retryAfterSec: 7, rand: half });
  assert.equal(a.job.cursor, 0);
  assert.equal(a.job.errors, 1);
  assert.equal(a.waitMs, 7000, 'Retry-After respected (larger than 2× base)');
  job = a.job;
  for (let i = 1; i < MAX_CONSECUTIVE_ERRORS; i++) job = applyOutcome(job, nextRange(job), items.slice(0, 1), 'retry', { rand: half }).job;
  assert.equal(job.status, 'paused');
  assert.equal(job.error, 'network');
  assert.ok(isResumable(job));
  // recovery resets the error counter
  const ok = applyOutcome({ ...job, status: 'running' }, nextRange(job), items.slice(0, 1), 'ok', { rand: half }).job;
  assert.equal(ok.errors, 0);
  assert.equal(ok.cursor, 1);
});

test('auth errors stop the job', () => {
  const job = createJob({ mode: 'remove', total: 10 });
  const { job: j } = applyOutcome(job, nextRange(job), items.slice(0, 1), 'auth');
  assert.equal(j.status, 'error');
  assert.equal(j.error, 'auth');
  assert.equal(j.cursor, 0);
});

test('delays: jitter around the base, exponential backoff, capped', () => {
  assert.equal(delayFor(1000, 0, null, () => 0), 700);
  assert.equal(delayFor(1000, 0, null, () => 1), 1300);
  assert.equal(delayFor(1000, 1, null, half), 2000);
  assert.equal(delayFor(1000, 3, null, half), 8000);
  assert.equal(delayFor(1000, 30, null, half), MAX_BACKOFF_MS);
  assert.equal(delayFor(1000, 1, 9999, half), MAX_BACKOFF_MS);
});

test('progress, resume and estimate', () => {
  let job = createJob({ mode: 'remove', total: 100, speed: 'normal' });
  job = applyOutcome(job, nextRange(job), items.slice(0, 1), 'ok', { rand: half }).job;
  const p = progressOf(job);
  assert.equal(p.done, 1);
  assert.equal(p.pct, 1);
  assert.ok(p.etaMs > 0);
  assert.equal(isResumable(job), true);
  assert.equal(isResumable({ ...job, status: 'cancelled' }), false);
  assert.equal(isResumable({ ...job, status: 'done' }), false);
  assert.equal(isResumable(null), false);
  assert.equal(estimateMs(0, 'normal'), 0);
  assert.equal(estimateMs(1, 'normal'), 1900);
  assert.ok(estimateMs(5000, 'careful') > estimateMs(5000, 'normal'));
});
