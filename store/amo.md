# Firefox Add-ons (AMO) — listing and review notes (Watch Later Cleaner & Play Next Queue)

Upload `dist/youtube-watch-later-<version>-firefox.zip` (built by `npm run zip:firefox`).
Add-on ID: `youtube-watch-later@ddvdvt.github.io`. Minimum version: Firefox 140.0 (Android: 142.0; the add-on is designed for desktop — leave Android unchecked on AMO).
The Russian listing texts can be reused from `listing.ru.md`; the UI is localized (ru, en).

## Name

Watch Later Cleaner & Play Next Queue

("YouTube" is intentionally not in the name; compatibility is stated in the description.)

## Summary (≤ 250 characters)

Clean up a huge YouTube Watch Later list: filters (unavailable, watched, Shorts, channel, duration, keyword), a backup before every removal, pause/resume and restore. Plus "Play next" buttons and your own queue. Local, no account.

## Description

Thousands of videos in Watch Later and YouTube only lets you remove them one by one? This add-on loads the whole list and lets you clean it up safely:

- Filters: unavailable/private videos, watched ones, Shorts, by channel, by duration, by title keyword, "everything except the first N" — combined (all / any), with a live count and manual ticks on top.
- A dry run first, then removal in small throttled batches (the pace YouTube itself allows), with pause, resume after a reload, cancel, and automatic back-off.
- A JSON backup is downloaded before every removal; "Restore" puts the removed videos back.
- "Play next" and "Add to queue" buttons on thumbnails and in the right-click menu, a queue panel on the video page, auto-advance when a video ends, and Alt+Shift+Q for "next from the queue".

Privacy: no account, analytics or ads. Everything stays in your browser; the only requests go to youtube.com itself, from the open YouTube page, exactly like the Watch Later page sends them.

Not affiliated with YouTube or Google.

## Categories

- Photos, Music & Videos
- Other

## Tags

youtube, watch later, playlist cleaner, queue, play next

## Homepage / support

- Homepage: https://ddvdvt.github.io/
- Privacy policy: https://ddvdvt.github.io/privacy/youtube-watch-later.html (also paste the text of `PRIVACY.md` into the AMO privacy policy field)
- License: MIT

## Data collection (data_collection_permissions)

`"required": ["none"]` — nothing is transmitted to the developer or any third party. The Watch Later list, the queue, settings and the last three backups stay in `storage.local` on the device; the only network requests go to www.youtube.com from the user's own open YouTube page, at the user's request.

## Notes for reviewers

**Source code:** not minified, not bundled, no build step, no remote code. The package is the `extension/` folder of the repository as is; only `manifest.json` is generated for Firefox by `scripts/firefox.mjs` (service worker → event page with the same file, gecko id, `minimum_chrome_version` removed).

**Permissions:**

- Host permission `https://www.youtube.com/*` and two content scripts there: `src/page/bridge.js` in the page world (`"world": "MAIN"`, needed because the client context `window.ytcfg` lives in the page) and `src/content/loader.js` (isolated world, `import()`s the ES-module UI from `web_accessible_resources`, matched to youtube.com only). On the Watch Later page, when the user asks, the bridge sends the same same-origin requests the page itself sends: `POST /youtubei/v1/browse` (`browseId: "VLWL"` or a continuation) and `POST /youtubei/v1/browse/edit_playlist` (`playlistId: "WL"`, remove/add-video actions only). Any other request is refused by an allowlist (enforced in code and covered by tests). If the user withholds the host access in Firefox, the popup says so and offers "Allow access to YouTube" (`permissions.request`).
- Authentication: like YouTube's own scripts, the bridge computes the standard `Authorization: SAPISIDHASH …` header from the page's `SAPISID` cookie (SHA-1 of time, cookie value and origin). The value is used only for that header on requests to www.youtube.com, never stored, never passed to other parts of the add-on, never sent anywhere else. The `cookies` API is not used.
- `storage` — settings, the queue, the state of an unfinished removal (to resume after a reload), the last three backups.
- `contextMenus` — "Play next" / "Add to queue" on links to YouTube videos.
- `commands` — Alt+Shift+Q, "next video from the queue" (not used by Firefox itself).
- No `downloads` (the backup is a regular `blob:` link download from the page), no `cookies`, `tabs`, `scripting`, `webRequest`, `history`.

**How to test** (needs a YouTube account with videos in Watch Later):

1. Open https://www.youtube.com/playlist?list=WL → the add-on's panel appears → "Open list cleanup" → "Load the whole list".
2. Tick "Unavailable" (or a channel) → "Dry run": nothing is sent. Then "Remove": a backup .json is downloaded first, then videos are removed in small batches; "Pause" and "Continue" work.
3. "Restore" from the stored backup puts them back.
4. On the home page hover a thumbnail → "Play next"; open a video: the queue panel shows it; when the video ends the next queued one opens.

The add-on also opens a static welcome page on install and sets a static uninstall page (https://ddvdvt.github.io/); nothing is sent to them.
