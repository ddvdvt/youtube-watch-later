// Is a URL on one of the extension's host permissions? (match patterns like "https://www.youtube.com/*").
// Pure module; callers pass chrome.runtime.getManifest().host_permissions.

/**
 * @param {string | undefined} url
 * @param {string[]} patterns
 */
export function onHost(url, patterns) {
  if (!url) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return patterns.some((p) => {
    const m = /^(https?|\*):\/\/([^/]+)\//.exec(p);
    if (!m) return false;
    const scheme = m[1] === '*' ? /^https?:$/ : new RegExp(`^${m[1]}:$`);
    return scheme.test(u.protocol) && (m[2] === u.hostname || m[2] === u.host);
  });
}
