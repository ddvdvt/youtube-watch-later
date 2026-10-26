// CSS selectors for the YouTube desktop markup the queue buttons rely on (checked on the
// logged-out site on 2026-10-26). Kept generic on purpose: a thumbnail is any link to a video
// that contains an image; the nearest known item element gives the title and channel.
// Pure data module.

/** Links to a video. */
export const VIDEO_LINK = 'a[href*="/watch?v="], a[href^="/shorts/"]';
/** Something inside the link that shows it is a thumbnail, not a text link. */
export const THUMB_HINT = 'img, yt-image, yt-thumbnail-view-model, ytd-thumbnail, .ytThumbnailViewModelImage, .thumb';
/** Item containers (current view models and older renderers). */
export const ITEM =
  'yt-lockup-view-model, ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-reel-item-renderer, ytm-shorts-lockup-view-model, ytd-movie-renderer';
export const TITLE = '.ytLockupMetadataViewModelTitle, .yt-lockup-metadata-view-model__title, #video-title, h3 a, h3, .title';
export const CHANNEL = 'ytd-channel-name #text, #channel-name #text, .ytContentMetadataViewModelMetadataText, .yt-content-metadata-view-model__metadata-text, a[href^="/@"], .channel';
export const DURATION = '.ytBadgeShapeText, .yt-badge-shape__text, ytd-thumbnail-overlay-time-status-renderer #text, .dur';
/** The main player and its "an ad is playing" state. */
export const PLAYER = '#movie_player';
export const AD_CLASSES = ['ad-showing', 'ad-interrupting'];
