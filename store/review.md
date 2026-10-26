# Chrome Web Store — Privacy practices & review notes (Watch Later Cleaner & Play Next Queue / «Смотреть позже — чистка и очередь»)

Copy each block into the matching field of the CWS developer dashboard.
`BASE` = the brand site address from `extension/lib/brand.js` = `https://ddvdvt.github.io/`.

## Single purpose

Manage what the user wants to watch on YouTube: clean up the user's own Watch Later list (load it fully, filter, back up, remove in throttled batches, restore) and keep a "play next" queue of videos that plays in order on the watch page.

## Permission justifications

**Host permission `https://www.youtube.com/*`**
Needed on YouTube pages only: (1) on the Watch Later page (`/playlist?list=WL`) the extension shows its cleanup panel and, when the user asks, loads the list and removes/re-adds videos by sending the same same-origin requests the Watch Later page itself sends (`POST /youtubei/v1/browse` with `browseId: "VLWL"` or a continuation token, and `POST /youtubei/v1/browse/edit_playlist` with `playlistId: "WL"` and remove/add-video actions only); (2) on all YouTube pages it shows "Play next / Add to queue" buttons over video thumbnails; (3) on watch pages it shows the queue panel and opens the next queued video when the current one ends. A small page-context script (`src/page/bridge.js`, `"world": "MAIN"`) is needed because the client context (`window.ytcfg`) lives in the page; it only accepts those two request kinds (allowlist, enforced in code and tested). No other site, no iframes.

**storage**
`chrome.storage.local` keeps the settings, the play queue, the state of an unfinished removal job (so it can continue after a reload) and the three newest backups of the Watch Later list. Nothing is synced or transmitted.

**contextMenus**
Adds "Play next" and "Add to queue" to the right-click menu on video links on www.youtube.com (also the keyboard path: context-menu key / Shift+F10 on a focused link).

Keyboard shortcut (`commands`, Alt+Shift+Q, "next video from the queue") needs no permission. No `downloads` (the backup is saved through a regular `blob:` link click), no `cookies`, `tabs`, `scripting`, `webRequest`.

## Remote code

No, I am not using remote code. All JavaScript is packaged; no remote scripts, `eval` or `new Function`; default extension CSP. The extension fetches no files from anywhere. The only network requests are the user-initiated YouTube requests described above, made to www.youtube.com from the page itself.

## Data usage

What user data do you plan to collect from users now or in the future? — **None is collected.** The Watch Later list (video ids, titles, channels) is processed in the user's tab and stored only locally (backups in `chrome.storage.local` and in the file the user downloads). Nothing is sent to the developer or any third party.

If the form asks about locally handled data, the closest categories are **"Web history"** (titles/ids of videos in the user's Watch Later list) and **"Authentication information"** (see the note below) — both handled locally only, never collected or transmitted to the developer.

Note on authentication: to make the same request the YouTube web client makes, the page-context script computes YouTube's standard `Authorization: SAPISIDHASH …` header from the page's `SAPISID` cookie (SHA-1 of time, cookie value and origin), exactly as YouTube's own scripts do. The value is used only for that header on requests to www.youtube.com, never stored, never passed to the extension's other parts, never sent anywhere else. The `chrome.cookies` API is not used.

Certifications (all three checked):
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Privacy policy URL

`BASE` + `privacy/youtube-watch-later.html` → `https://ddvdvt.github.io/privacy/youtube-watch-later.html`

## Notes for the reviewer (test instructions)

The queue works without an account. The Watch Later cleanup needs a signed-in YouTube account with a few videos in Watch Later (use a test account).

Queue (no sign-in needed):
1. Open https://www.youtube.com/ or a search, e.g. https://www.youtube.com/results?search_query=lofi — hover a video thumbnail: "Next" and "Queue" buttons appear in its top-left corner. Click "Next" on one video and "Queue" on another. Or right-click any video link → "Play next" / "Add to queue".
2. Click the toolbar icon — the popup lists the queue (reorder ↑↓, remove ×, "Next ▶").
3. Open any video. A queue panel appears in the bottom-right corner. Seek to the end of the video: the first queued video opens (also with YouTube autoplay off). Alt+Shift+Q opens the next one immediately.

Watch Later cleanup (signed in):
4. Open https://www.youtube.com/playlist?list=WL — click "Clean up Watch Later" (bottom right) → "Load the whole list". Counts (total / watched / unavailable / Shorts) appear.
5. Tick a filter (e.g. "Watched: at least 90 %") or tick a few videos manually; the "Selected: N of M" count updates. "Dry run" walks through the plan without sending any request.
6. "Remove N" → confirmation dialog with the exact number → a JSON backup file is downloaded first → videos are removed in batches (first request with one video, then up to 25, ~1.5 s apart); "Pause" / "Cancel" work, and after a page reload the button says "Continue removal".
7. "Restore from a backup" → choose the stored backup → the removed videos are re-added.

After installation the extension opens one static welcome page (`BASE/welcome/youtube-watch-later.html`); the uninstall URL is a static page (`BASE/bye/youtube-watch-later.html`). No data or identifiers are added to these URLs.
