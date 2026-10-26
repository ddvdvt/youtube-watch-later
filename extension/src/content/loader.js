// Classic content script (MV3 content scripts can't be ES modules): loads the module once.
// Never throws into the page.
(() => {
  try {
    if (globalThis.__ywlLoaded) return;
    globalThis.__ywlLoaded = true;
    import(chrome.runtime.getURL('src/content/main.js'))
      .then((m) => m.start())
      .catch(() => {
        /* never break the host page */
      });
  } catch {
    /* ignore */
  }
})();
