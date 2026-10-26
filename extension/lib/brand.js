// Links to the author's brand site (welcome / uninstall / privacy pages, "other extensions").
// Pure module: no chrome.* calls. BASE is the ONLY place to change the address: background.js,
// the popup/options footer and the e2e test read it from here. "homepage_url" in
// extension/manifest.json must be the same value — test/release.test.js checks it.

/** Base URL of the brand site, with a trailing slash. */
export const BASE = 'https://ddvdvt.github.io/';

/** Page slug of this extension on the brand site. */
export const SLUG = 'youtube-watch-later';

/**
 * All brand URLs for an extension.
 * @param {string} [base]
 * @param {string} [slug]
 */
export function brandUrls(base = BASE, slug = SLUG) {
  const b = base.endsWith('/') ? base : `${base}/`;
  return {
    home: b,
    welcome: `${b}welcome/${slug}.html`,
    bye: `${b}bye/${slug}.html`,
    privacy: `${b}privacy/${slug}.html`,
    other: `${b}#${slug}`,
  };
}

/**
 * URL to open after chrome.runtime.onInstalled, or null. Only a fresh install opens a tab.
 * @param {string | undefined} reason chrome.runtime.OnInstalledReason
 * @param {string} [base]
 * @param {string} [slug]
 * @returns {string | null}
 */
export function welcomeUrlFor(reason, base = BASE, slug = SLUG) {
  return reason === 'install' ? brandUrls(base, slug).welcome : null;
}
