// User settings. Pure module.

/**
 * @typedef {{ hoverButtons: boolean, autoAdvance: boolean, queuePanel: boolean, watchedPct: number, speed: 'careful' | 'normal' }} Settings
 */

/** @returns {Settings} */
export const DEFAULTS = () => ({ hoverButtons: true, autoAdvance: true, queuePanel: true, watchedPct: 90, speed: 'normal' });

/**
 * @param {any} raw
 * @returns {Settings}
 */
export function normalizeSettings(raw) {
  const d = DEFAULTS();
  if (!raw || typeof raw !== 'object') return d;
  const pct = Math.round(Number(raw.watchedPct));
  return {
    hoverButtons: typeof raw.hoverButtons === 'boolean' ? raw.hoverButtons : d.hoverButtons,
    autoAdvance: typeof raw.autoAdvance === 'boolean' ? raw.autoAdvance : d.autoAdvance,
    queuePanel: typeof raw.queuePanel === 'boolean' ? raw.queuePanel : d.queuePanel,
    watchedPct: Number.isFinite(pct) ? Math.max(1, Math.min(100, pct)) : d.watchedPct,
    speed: raw.speed === 'careful' ? 'careful' : 'normal',
  };
}

/**
 * Keep at most `max` backups, newest first.
 * @template {{ createdAt: string }} T
 * @param {T[]} list
 * @param {T} next
 * @param {number} [max]
 * @returns {T[]}
 */
export function pushBackup(list, next, max = 3) {
  return [next, ...(Array.isArray(list) ? list : [])].slice(0, max);
}
