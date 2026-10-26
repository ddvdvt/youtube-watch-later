// Fake Watch Later data in the JSON shape the YouTube web client receives
// (lockupViewModel items, continuationItemViewModel, pageHeaderRenderer), modelled on what a
// logged-out public playlist returned on 2026-10-26, plus the "Remove from Watch Later" menu
// action a signed-in user's list carries. Titles and channels are invented. Used by unit tests,
// the e2e fake endpoint and the store screenshots.

export const CHANNELS = [
  'Инженерные истории', 'Кухня без спешки', 'Открытый университет', 'Горы рядом', 'Музыка с нуля', 'Наука просто',
  'Мастерская', 'История картографии', 'Код и кофе', 'Шахматный клуб', 'Путешествия налегке', 'Своими руками',
  'Космос сегодня', 'Лекторий', 'Велодорога', 'Огород круглый год', 'Тихие стримы', 'Языки за 5 минут',
  'Ретро-техника', 'Физкультура дома', 'Старое кино', 'Фотошкола', 'Экономика на пальцах',
];
const TOPICS = [
  'полный разбор', 'для начинающих', 'часть 2', 'ошибки новичков', 'как это работает', 'обзор за 10 минут', 'лекция',
  'пошаговая инструкция', 'интервью', 'история одного проекта', 'сравнение', 'лайфхаки', 'подкаст', 'прямой эфир (запись)',
];
const SUBJECTS = [
  'Двигатель внутреннего сгорания', 'Хлеб на закваске', 'Линейная алгебра', 'Поход по Тянь-Шаню', 'Три аккорда на гитаре',
  'Почему небо голубое', 'Тормоза велосипеда', 'Карты XVI века', 'Асинхронный JavaScript', 'Дебют ферзевых пешек',
  'Рюкзак на 7 кг', 'Полка из фанеры', 'Запуск телескопа', 'Римское право', 'Зимняя езда', 'Томаты на балконе',
  'Ночной лес', 'Испанский: глаголы', 'Магнитофон «Электроника»', 'Утренняя зарядка', 'Немое кино', 'Свет и тень', 'Инфляция',
];

/** @param {number} i 1-based */
export const videoIdOf = (i) => `v${i.toString(36).padStart(10, '0')}`;
/** @param {number} i */
export const setVideoIdOf = (i) => `S${i.toString(16).toUpperCase().padStart(15, '0')}`;

/**
 * Properties of the i-th video (1-based) — deterministic, so tests can compute expected counts.
 * @param {number} i
 */
export function spec(i) {
  const unavailable = i % 37 === 0;
  const shorts = !unavailable && i % 19 === 0;
  const progress = unavailable ? null : i % 5 === 0 ? 100 : i % 7 === 0 ? 45 : null;
  const channel = unavailable ? '' : CHANNELS[(i * 7) % CHANNELS.length];
  const duration = unavailable ? null : shorts ? 15 + (i % 45) : 60 + ((i * 37) % 3600);
  const title = unavailable ? (i % 2 ? '[Private video]' : '[Deleted video]') : `${SUBJECTS[i % SUBJECTS.length]}: ${TOPICS[(i * 3) % TOPICS.length]}${shorts ? ' #shorts' : ''}`;
  return { i, videoId: videoIdOf(i), setVideoId: setVideoIdOf(i), unavailable, shorts, progress, channel, channelId: channel ? `UC${String(CHANNELS.indexOf(channel)).padStart(22, 'x')}` : '', duration, title };
}

/** @param {number} s */
const dur = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

/**
 * One lockupViewModel item.
 * @param {ReturnType<typeof spec>} s
 * @param {number} index 0-based position in the list
 */
export function lockup(s, index) {
  const watch = s.shorts
    ? { commandMetadata: { webCommandMetadata: { url: `/shorts/${s.videoId}`, webPageType: 'WEB_PAGE_TYPE_SHORTS', rootVe: 37414 } }, reelWatchEndpoint: { videoId: s.videoId } }
    : { commandMetadata: { webCommandMetadata: { url: `/watch?v=${s.videoId}&list=WL&index=${index + 1}`, webPageType: 'WEB_PAGE_TYPE_WATCH', rootVe: 3832 } }, watchEndpoint: { videoId: s.videoId, playlistId: 'WL', index } };
  const bottom = { thumbnailBottomOverlayViewModel: { badges: [] } };
  if (s.duration != null) bottom.thumbnailBottomOverlayViewModel.badges.push({ thumbnailBadgeViewModel: { text: s.shorts ? 'SHORTS' : dur(s.duration), badgeStyle: s.shorts ? 'THUMBNAIL_OVERLAY_BADGE_STYLE_SHORTS' : 'THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT' } });
  if (s.shorts && s.duration != null) bottom.thumbnailBottomOverlayViewModel.badges.push({ thumbnailBadgeViewModel: { text: dur(s.duration), badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT' } });
  if (s.progress != null) bottom.thumbnailBottomOverlayViewModel.progressBar = { thumbnailOverlayProgressBarViewModel: { startPercent: s.progress } };
  const rows = [];
  if (s.channel) {
    rows.push({ metadataParts: [{ text: { content: s.channel, commandRuns: [{ startIndex: 0, length: s.channel.length, onTap: { innertubeCommand: { commandMetadata: { webCommandMetadata: { url: `/channel/${s.channelId}`, webPageType: 'WEB_PAGE_TYPE_CHANNEL' } }, browseEndpoint: { browseId: s.channelId } } } }] } }] });
    rows.push({ metadataParts: [{ text: { content: `${(s.i * 13) % 900 + 1} тыс. просмотров` } }, { text: { content: `${(s.i % 11) + 1} мес. назад` } }] });
  }
  const removeItem = {
    listItemViewModel: {
      title: { content: 'Удалить из плейлиста "Смотреть позже"' },
      rendererContext: { commandContext: { onTap: { innertubeCommand: { commandMetadata: { webCommandMetadata: { sendPost: true, apiUrl: '/youtubei/v1/browse/edit_playlist' } }, playlistEditEndpoint: { playlistId: 'WL', actions: [{ action: 'ACTION_REMOVE_VIDEO', setVideoId: s.setVideoId }] } } } } },
    },
  };
  return {
    lockupViewModel: {
      contentImage: { thumbnailViewModel: { image: { sources: [{ url: '', width: 168, height: 94 }] }, overlays: [bottom] } },
      metadata: { lockupMetadataViewModel: { title: { content: s.title }, metadata: { contentMetadataViewModel: { metadataRows: rows, delimiter: ' • ' } }, menuButton: { buttonViewModel: { iconName: 'MORE_VERT', onTap: { innertubeCommand: { showSheetCommand: { panelLoadingStrategy: { inlineContent: { sheetViewModel: { content: { listViewModel: { listItems: [removeItem] } } } } } } } } } } } },
      contentId: s.videoId,
      contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
      rendererContext: { accessibilityContext: { label: s.title }, commandContext: { onTap: { innertubeCommand: watch } } },
    },
  };
}

/** @param {string} token */
const contItem = (token) => ({
  continuationItemViewModel: {
    trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN',
    continuationCommand: { innertubeCommand: { commandMetadata: { webCommandMetadata: { sendPost: true, apiUrl: '/youtubei/v1/browse' } }, continuationCommand: { token, request: 'CONTINUATION_REQUEST_TYPE_BROWSE' } } },
  },
});

/**
 * First page (browseId VLWL) or a continuation page of the given list.
 * @param {number[]} list 1-based video numbers currently in the list, in order
 * @param {number} offset
 * @param {{ pageSize?: number, first?: boolean }} [o]
 */
export function browsePage(list, offset, o = {}) {
  const size = o.pageSize || 100;
  const slice = list.slice(offset, offset + size).map((n, k) => lockup(spec(n), offset + k));
  const items = offset + size < list.length ? [...slice, contItem(`page-${offset + size}`)] : slice;
  if (!o.first) return { responseContext: {}, onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: items, targetId: 'browse-feedVLWL' } }] };
  return {
    responseContext: {},
    contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: items } }] } } } }] } },
    header: { pageHeaderRenderer: { pageTitle: 'Смотреть позже', content: { pageHeaderViewModel: { metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: 'Плейлист' } }, { text: { content: `${list.length.toLocaleString('ru-RU')} видео` } }, { text: { content: 'Обновлено сегодня' } }] }] } } } } } },
    sidebar: { playlistSidebarRenderer: { items: [{ lockupViewModel: { contentId: 'sidebarxxxx', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO' } }] } },
  };
}
