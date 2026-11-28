// background.js - 支援 PTT 官方 longpoll + poll 增量即時推文抓取、跨頁找文、防舊快照覆蓋與 MV3 保活
importScripts('config.js');
const CFG = self.PTT_DANMAKU_CONFIG;
const normalizeOption = self.pttDanmakuNormalizeOption;

const DEFAULT_BOARD = CFG.DEFAULT_BOARD;
const DEFAULT_QUERY = CFG.DEFAULT_QUERY;
const BOARD_POLL_INTERVAL_MS = 20000;
const DEFAULT_MIN_FETCH_INTERVAL_MS = CFG.MIN_FETCH_INTERVAL_SECONDS.defaultValue * 1000;
const DEFAULT_FLY_DURATION_MS = CFG.FLY_DURATION_SECONDS.defaultValue * 1000;
const DEFAULT_MAX_BATCH_COUNT = CFG.MAX_BATCH_COUNT.defaultValue;
const DEFAULT_REPLAY_SPEED_MS_PER_SEC = CFG.REPLAY_SPEED_MS_PER_SEC.defaultValue;
const INITIAL_PREVIEW_WINDOW_MINUTES = CFG.INITIAL_PREVIEW_WINDOW_MINUTES;
const INITIAL_PREVIEW_MAX_WAVES = CFG.INITIAL_PREVIEW_MAX_WAVES;
// 逾時涵蓋「收到 header + 讀完 body」全程（文章 HTML 可達數百 KB，故放寬至 15s）
const FETCH_TIMEOUT_MS = 15000;
// PTT /v1/longpoll 為「等待下一次變動」的長輪詢：需常駐一條連線並帶 If-Modified-Since / If-None-Match，
// 否則每 N 秒短暫詢問一次會因伺服器掛住連線而誤判為「無新推文」，導致推文卡住不更新
const LONGPOLL_WATCH_TIMEOUT_MS = 25000;
const LONGPOLL_WATCH_RETRY_MS = 1000;
const LONGPOLL_WATCH_DUP_DELAY_MS = 3000;
const LONGPOLL_WATCH_ERROR_BACKOFF_MS = 5000;
const LONGPOLL_WATCH_HEALTHY_WINDOW_MS = 60000;
const LONGPOLL_WATCH_RETRYABLE_STATUS = new Set([304, 408, 502, 503, 504, 520, 522, 524]);
// 保底：若超過此時間既沒收到 longpoll 變動通知、也沒做過完整抓取，則強制完整重抓一次
const FULL_RELOAD_SAFETY_MS = 180000;
// 抓取失敗後至少等待此時間（或使用者設定的更新間隔，取較長者）才重試，避免 PTT 當機時每秒狂打
const FETCH_FAILURE_MIN_RETRY_MS = 5000;

const STORAGE_ENABLED_KEY = 'ptt_danmaku_extension_enabled';
const STORAGE_MIN_INTERVAL_KEY = 'ptt_danmaku_min_fetch_interval_ms';
const STORAGE_FLY_DURATION_KEY = 'ptt_danmaku_fly_duration_ms';
const STORAGE_MAX_BATCH_KEY = 'ptt_danmaku_max_batch_count';
const STORAGE_REPLAY_SPEED_KEY = 'ptt_danmaku_replay_speed_ms_per_sec';
const STORAGE_FILTER_OPTIONS_KEY = 'ptt_danmaku_filter_options';
const STORAGE_SESSION_META_KEY = 'ptt_danmaku_session_meta';
const STORAGE_RUNTIME_CACHE_KEY = 'ptt_danmaku_runtime_cache';

let sharedState = {
  enabled: true,
  pushes: [],
  startTime: 0,
  endTime: 0,
  totalDuration: 60000,
  currentVirtualTime: 0,
  nextPushIndex: 0,
  isPlaying: false,
  isLiveMode: true,
  speedMsPerSec: DEFAULT_REPLAY_SPEED_MS_PER_SEC,
  minFetchIntervalMs: DEFAULT_MIN_FETCH_INTERVAL_MS,
  flyDurationMs: DEFAULT_FLY_DURATION_MS,
  maxBatchCount: DEFAULT_MAX_BATCH_COUNT,
  crossTabShowEnabled: true,
  booOnly: false,
  keywordRaw: '',
  keywordFilterOnly: false,
  articleTitle: '',
  articleUrl: '',
  board: DEFAULT_BOARD,
  query: DEFAULT_QUERY,
  articleEpoch: 0,
  lastFetchedAt: 0,
  lastFailedAt: 0,
  lastError: '',
  lastDebugInfo: null,
  lastUpdatedAt: Date.now()
};

// 追蹤目前文章的 PTT 增量輪詢狀態 (#article-polling: data-pollurl / data-longpollurl / data-offset)
let pollingSession = {
  articleUrl: '',
  pollUrl: '',
  longPollUrl: '',
  currSize: 0,
  cacheKey: '',
  currentYear: new Date().getFullYear(),
  lastTimestamp: null,
  baseRawDivCount: 0,
  deltaTotalCount: 0,
  lastDeltaAddedCount: 0,
  pollMode: 'init'
};

let lastBoardResolveAt = 0;
let inflightFetchPromise = null;
let inflightFetchKey = '';
let bootstrapPromise = null;
const keepAlivePorts = new Set();

function resetPollingSession(articleUrl = '') {
  pollingSession = {
    articleUrl,
    pollUrl: '',
    longPollUrl: '',
    currSize: 0,
    cacheKey: '',
    currentYear: new Date().getFullYear(),
    lastTimestamp: null,
    baseRawDivCount: 0,
    deltaTotalCount: 0,
    lastDeltaAddedCount: 0,
    pollMode: 'init',
    lastFullLoadAt: 0
  };
}

function saveSessionMetaToStorage() {
  try {
    chrome.storage.local.set({
      [STORAGE_SESSION_META_KEY]: {
        isLiveMode: sharedState.isLiveMode,
        board: sharedState.board,
        query: sharedState.query,
        articleUrl: sharedState.articleUrl,
        articleTitle: sharedState.articleTitle,
        articleEpoch: sharedState.articleEpoch
      },
      [STORAGE_RUNTIME_CACHE_KEY]: {
        articleUrl: sharedState.articleUrl,
        articleTitle: sharedState.articleTitle,
        board: sharedState.board,
        query: sharedState.query,
        articleEpoch: sharedState.articleEpoch,
        startTime: sharedState.startTime,
        endTime: sharedState.endTime,
        totalDuration: sharedState.totalDuration,
        currentVirtualTime: sharedState.currentVirtualTime,
        nextPushIndex: sharedState.nextPushIndex,
        lastFetchedAt: sharedState.lastFetchedAt,
        lastDebugInfo: sharedState.lastDebugInfo,
        pollingSession: { ...pollingSession },
        pushes: sharedState.pushes.slice(-2500)
      }
    });
  } catch (_) { }
}

// 可選值統一由 config.js 定義；以下將秒/毫秒輸入正規化為允許值（不合法時回傳預設值）
function sanitizeSecondsOptionMs(spec, rawMsOrSec, isSeconds) {
  const num = Number(rawMsOrSec);
  if (!Number.isFinite(num) || num <= 0) return spec.defaultValue * 1000;
  const sec = isSeconds ? Math.round(num) : Math.round(num / 1000);
  return normalizeOption(spec, sec) * 1000;
}

function sanitizeMinFetchIntervalMs(rawMsOrSec, isSeconds = false) {
  return sanitizeSecondsOptionMs(CFG.MIN_FETCH_INTERVAL_SECONDS, rawMsOrSec, isSeconds);
}

function sanitizeFlyDurationMs(rawMsOrSec, isSeconds = false) {
  return sanitizeSecondsOptionMs(CFG.FLY_DURATION_SECONDS, rawMsOrSec, isSeconds);
}

function sanitizeMaxBatchCount(rawVal) {
  return normalizeOption(CFG.MAX_BATCH_COUNT, rawVal);
}

function sanitizeReplaySpeed(rawVal) {
  return normalizeOption(CFG.REPLAY_SPEED_MS_PER_SEC, rawVal);
}

function selectInitialPreviewPushes(allPushes, rawMaxBatchCount) {
  if (!Array.isArray(allPushes) || allPushes.length === 0) return [];
  const n = sanitizeMaxBatchCount(rawMaxBatchCount || sharedState.maxBatchCount || DEFAULT_MAX_BATCH_COUNT);
  const minCount = n;
  const maxCount = n * INITIAL_PREVIEW_MAX_WAVES;
  const nowMinuteFloor = Math.floor(Date.now() / 60000) * 60000;
  const cutoffTs = nowMinuteFloor - INITIAL_PREVIEW_WINDOW_MINUTES * 60000;

  let recentCount = 0;
  for (let i = allPushes.length - 1; i >= 0; i--) {
    const ts = Number(allPushes[i]?.timestamp) || 0;
    if (ts >= cutoffTs) {
      recentCount++;
    } else {
      break;
    }
  }

  const targetCount = Math.min(
    allPushes.length,
    Math.max(minCount, Math.min(maxCount, recentCount))
  );
  return allPushes.slice(-targetCount);
}

function extractArticleShortId(urlStr) {
  if (!urlStr) return '';
  const m = String(urlStr).match(/\/(M\.\d+\.A\.[^./]+\.html)/i);
  return m ? m[1] : urlStr;
}

function updateActionBadge(enabled) {
  if (!chrome.action) return;
  if (enabled) {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#00c853' });
    chrome.action.setTitle({ title: 'PTT 彈幕：已啟用（點擊開啟控制面板）' });
  } else {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#757575' });
    chrome.action.setTitle({ title: 'PTT 彈幕：已停用（點擊開啟控制面板）' });
  }
}

function broadcastToAllTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, message, () => {
        void chrome.runtime.lastError;
      });
    }
  });
  try {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  } catch (_) { }
}

function findNextIndexByTime(pushes, targetTime) {
  let left = 0;
  let right = pushes.length - 1;
  let ans = pushes.length;
  while (left <= right) {
    const mid = (left + right) >> 1;
    if (pushes[mid].virtualTime >= targetTime) {
      ans = mid;
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }
  return ans;
}

// 距離下一次允許抓取還需等待的毫秒數：成功後依「更新間隔」，失敗後依 max(更新間隔, 5s)
function getFetchCooldownRemainingMs(slackMs = 0) {
  const minInterval = sanitizeMinFetchIntervalMs(sharedState.minFetchIntervalMs, false);
  const now = Date.now();
  let remainMs = 0;
  if (sharedState.lastFetchedAt > 0) {
    remainMs = Math.max(remainMs, minInterval - (now - sharedState.lastFetchedAt));
  }
  if (sharedState.lastFailedAt > 0) {
    const retryMs = Math.max(minInterval, FETCH_FAILURE_MIN_RETRY_MS);
    remainMs = Math.max(remainMs, retryMs - (now - sharedState.lastFailedAt));
  }
  return Math.max(0, remainMs - slackMs);
}

// includePushes=false 時回傳不含推文陣列的輕量狀態（推文未變動時使用，避免每次輪詢都把上千則推文廣播給所有分頁）
function getSnapshot({ includePushes = true } = {}) {
  if (!includePushes) {
    const { pushes, ...rest } = sharedState;
    return { ...rest, pushCount: pushes.length };
  }
  return {
    ...sharedState,
    pushCount: sharedState.pushes.length,
    pushes: sharedState.pushes.map((p) => ({
      index: p.index,
      floor: p.floor,
      tag: p.tag,
      userid: p.userid,
      content: p.content,
      timestamp: p.timestamp,
      virtualTime: p.virtualTime,
      hhmm: p.hhmm,
      timeStr: p.timeStr
    }))
  };
}

function clearDanmakuQueue() {
  sharedState.pushes = [];
  sharedState.startTime = 0;
  sharedState.endTime = 0;
  sharedState.totalDuration = 60000;
  sharedState.currentVirtualTime = 0;
  sharedState.nextPushIndex = 0;
  sharedState.isPlaying = false;
  sharedState.isLiveMode = false;
  sharedState.articleTitle = '';
  sharedState.articleUrl = '';
  sharedState.lastFetchedAt = 0;
  sharedState.lastDebugInfo = null;
  sharedState.lastUpdatedAt = Date.now();
  resetPollingSession('');
  saveSessionMetaToStorage();
  try {
    chrome.storage.local.remove(STORAGE_RUNTIME_CACHE_KEY);
  } catch (_) { }

  const snapshot = getSnapshot();
  broadcastToAllTabs({
    type: 'DANMAKU_QUEUE_CLEARED',
    state: snapshot
  });
  return snapshot;
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripTags(htmlStr) {
  return decodeHtmlEntities(String(htmlStr || '').replace(/<[^>]+>/g, ''));
}

function formatHhMmFromTs(ts) {
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function parseBoardPageFromHtml(htmlText) {
  const entries = [];
  const seenUrls = new Set();
  const prevMatch = htmlText.match(
    /<a[^>]*class="[^"]*btn[^"]*wide[^"]*"[^>]*href="([^"]+)"[^>]*>(?:&lsaquo;|‹)\s*上頁<\/a>/i
  );
  const prevPageUrl = prevMatch
    ? new URL(decodeHtmlEntities(prevMatch[1].trim()), 'https://www.ptt.cc').href
    : '';

  const linkRegex = /<div class="title">[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(htmlText)) !== null) {
    const href = decodeHtmlEntities(match[1].trim());
    const titleText = stripTags(match[2]).trim();
    if (!href || !titleText) continue;
    const fullUrl = new URL(href, 'https://www.ptt.cc').href;
    if (seenUrls.has(fullUrl)) continue;
    seenUrls.add(fullUrl);
    const epochMatch = fullUrl.match(/M\.(\d+)\.A\.[^.]+\.html/i);
    const epoch = epochMatch ? parseInt(epochMatch[1], 10) : 0;
    entries.push({ titleText, fullUrl, epoch });
  }
  return { entries, prevPageUrl };
}

function extractPollingConfigFromHtml(htmlText) {
  if (!htmlText) return null;
  const divMatch = htmlText.match(/<div[^>]*id="article-polling"[^>]*>/i);
  if (!divMatch) return null;
  const tag = divMatch[0];
  const pollUrlMatch = tag.match(/data-pollurl="([^"]+)"/i);
  const longPollUrlMatch = tag.match(/data-longpollurl="([^"]+)"/i);
  const offsetMatch = tag.match(/data-offset="(\d+)"/i);
  if (!pollUrlMatch || !longPollUrlMatch) return null;

  const rawPollUrl = decodeHtmlEntities(pollUrlMatch[1].trim());
  const rawLongPollUrl = decodeHtmlEntities(longPollUrlMatch[1].trim());
  const currSize = offsetMatch ? parseInt(offsetMatch[1], 10) : 0;
  const cacheKeyMatch = rawPollUrl.match(/[?&]cacheKey=([^&]+)/i);

  return {
    pollUrl: new URL(rawPollUrl, 'https://www.ptt.cc').href,
    longPollUrl: new URL(rawLongPollUrl, 'https://www.ptt.cc').href,
    currSize: Number.isFinite(currSize) ? currSize : 0,
    cacheKey: cacheKeyMatch ? decodeURIComponent(cacheKeyMatch[1]) : ''
  };
}

function assignVirtualTimes(pushes) {
  for (let idx = 0; idx < pushes.length; idx++) {
    pushes[idx].index = idx;
    pushes[idx].floor = idx + 1;
  }
  for (let i = 0; i < pushes.length; i++) {
    let sameMinCount = 0;
    while (
      i + sameMinCount < pushes.length &&
      pushes[i + sameMinCount].timestamp === pushes[i].timestamp
    ) {
      sameMinCount++;
    }
    for (let j = 0; j < sameMinCount; j++) {
      pushes[i + j].virtualTime = pushes[i].timestamp + (j / sameMinCount) * 58000;
    }
    i += sameMinCount - 1;
  }
}

function getPushSignature(p) {
  if (!p) return '';
  return `${p.tag || ''}|${p.userid || ''}|${p.timeStr || p.hhmm || ''}|${p.content || ''}`;
}

// 處理 PTT「檔案過大！部分文章無法顯示」截斷機制（靜態 HTML 固定上限約 1484 則推文）：
// 比對舊推文尾端錨點與新抓回推文，保留已被截斷的中段推文並精準取出尾端新增推文
function mergeSameArticlePushes(existingPushes, incomingPushes) {
  if (!Array.isArray(existingPushes) || existingPushes.length === 0) {
    const cloned = Array.isArray(incomingPushes) ? [...incomingPushes] : [];
    assignVirtualTimes(cloned);
    return { mergedPushes: cloned, newlyAddedPushes: cloned };
  }
  if (!Array.isArray(incomingPushes) || incomingPushes.length === 0) {
    return { mergedPushes: existingPushes, newlyAddedPushes: [] };
  }

  const lastExisting = existingPushes[existingPushes.length - 1];
  const lastSig = getPushSignature(lastExisting);
  const prevSig =
    existingPushes.length >= 2 ? getPushSignature(existingPushes[existingPushes.length - 2]) : null;

  let anchorIdx = -1;
  for (let i = incomingPushes.length - 1; i >= 0; i--) {
    if (getPushSignature(incomingPushes[i]) === lastSig) {
      if (!prevSig || i === 0 || getPushSignature(incomingPushes[i - 1]) === prevSig) {
        anchorIdx = i;
        break;
      }
      if (anchorIdx === -1) {
        anchorIdx = i;
      }
    }
  }

  let newlyAddedPushes = [];
  if (anchorIdx !== -1) {
    newlyAddedPushes = incomingPushes.slice(anchorIdx + 1);
  } else {
    // 若尾端錨點已不在新滑動視窗內，取時間戳大於等於最後一則且未出現於近期紀錄的推文
    const recentSigs = new Set(existingPushes.slice(-600).map(getPushSignature));
    const minTs = lastExisting.timestamp || 0;
    newlyAddedPushes = incomingPushes.filter(
      (p) => (p.timestamp || 0) >= minTs && !recentSigs.has(getPushSignature(p))
    );
  }

  if (newlyAddedPushes.length === 0) {
    return { mergedPushes: existingPushes, newlyAddedPushes: [] };
  }

  const mergedPushes = [...existingPushes, ...newlyAddedPushes];
  assignVirtualTimes(mergedPushes);
  return { mergedPushes, newlyAddedPushes };
}

function parsePushNodesFromHtmlChunk(
  htmlChunk,
  { startIndex = 0, initialYear = new Date().getFullYear(), initialLastTimestamp = null } = {}
) {
  if (!htmlChunk) {
    return {
      pushes: [],
      rawDivCount: 0,
      lastYear: initialYear,
      lastTimestamp: initialLastTimestamp
    };
  }

  const rawDivMatches = htmlChunk.match(/<div class="push">/g) || [];
  const pushes = [];
  let currentYear = initialYear;
  let lastTimestamp = initialLastTimestamp;
  const pushRegex = /<div class="push">([\s\S]*?)<\/div>/g;
  let pushMatch;
  let index = startIndex;

  while ((pushMatch = pushRegex.exec(htmlChunk)) !== null) {
    const chunk = pushMatch[1];
    const tagMatch = chunk.match(/<span[^>]*class="[^"]*push-tag[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const userMatch = chunk.match(/<span[^>]*class="[^"]*push-userid[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const contentMatch = chunk.match(/<span[^>]*class="[^"]*push-content[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const ipDateMatch = chunk.match(/<span[^>]*class="[^"]*push-ipdatetime[^"]*"[^>]*>([\s\S]*?)<\/span>/i);

    const tag = stripTags(tagMatch ? tagMatch[1] : '→').trim() || '→';
    const userid = stripTags(userMatch ? userMatch[1] : '').trim();
    const content = stripTags(contentMatch ? contentMatch[1] : '').replace(/^:\s*/, '').trim();
    const ipdatetime = stripTags(ipDateMatch ? ipDateMatch[1] : '').trim();

    const timeMatch = ipdatetime.match(/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
    let timestamp = lastTimestamp;

    if (timeMatch) {
      const month = parseInt(timeMatch[1], 10) - 1;
      const day = parseInt(timeMatch[2], 10);
      const hour = parseInt(timeMatch[3], 10);
      const minute = parseInt(timeMatch[4], 10);

      let candidate = new Date(currentYear, month, day, hour, minute, 0).getTime();
      if (lastTimestamp !== null && candidate < lastTimestamp - 86400000 * 30) {
        currentYear += 1;
        candidate = new Date(currentYear, month, day, hour, minute, 0).getTime();
      }
      timestamp = candidate;
      lastTimestamp = timestamp;
    } else if (timestamp === null) {
      timestamp = Date.now();
      lastTimestamp = timestamp;
    }

    if (timestamp !== null && content) {
      const hhmm = timeMatch ? `${timeMatch[3]}:${timeMatch[4]}` : formatHhMmFromTs(timestamp);
      pushes.push({
        index,
        floor: index + 1,
        tag,
        userid,
        content,
        timestamp,
        hhmm,
        timeStr: timeMatch ? `${timeMatch[1]}/${timeMatch[2]} ${timeMatch[3]}:${timeMatch[4]}` : hhmm
      });
      index++;
    }
  }

  return {
    pushes,
    rawDivCount: rawDivMatches.length,
    lastYear: currentYear,
    lastTimestamp
  };
}

function parsePushesFromHtml(htmlText) {
  const ogTitleMatch = htmlText.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i);
  const docTitleMatch = htmlText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = stripTags(ogTitleMatch ? ogTitleMatch[1] : docTitleMatch ? docTitleMatch[1] : '').trim();

  let currentYear = new Date().getFullYear();
  const timeMetaMatch = htmlText.match(
    /<span class="article-meta-tag">時間<\/span>\s*<span class="article-meta-value">([^<]+)<\/span>/
  );
  if (timeMetaMatch) {
    const yearMatch = timeMetaMatch[1].match(/\b(20\d{2})\b/);
    if (yearMatch) currentYear = parseInt(yearMatch[1], 10);
  }

  const parsed = parsePushNodesFromHtmlChunk(htmlText, {
    startIndex: 0,
    initialYear: currentYear,
    initialLastTimestamp: null
  });

  assignVirtualTimes(parsed.pushes);

  return {
    pushes: parsed.pushes,
    title,
    rawDivCount: parsed.rawDivCount,
    lastYear: parsed.lastYear,
    lastTimestamp: parsed.lastTimestamp
  };
}

function withCacheBust(rawUrl) {
  const u = new URL(rawUrl, 'https://www.ptt.cc');
  u.searchParams.set('_cb', `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  return u.href;
}

// readBody(resp) 會在同一個逾時/AbortController 範圍內執行，避免 header 已回但 body 卡住時永久掛起
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS, readBody = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return readBody ? await readBody(resp) : resp;
  } finally {
    clearTimeout(timer);
  }
}

const NO_STORE_HTML_OPTIONS = {
  cache: 'no-store',
  credentials: 'include',
  headers: {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache'
  }
};

async function fetchPttHtml(url) {
  let html = await fetchWithTimeout(withCacheBust(url), NO_STORE_HTML_OPTIONS, FETCH_TIMEOUT_MS, async (resp) => {
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} (${url})`);
    }
    return await resp.text();
  });

  if (html.includes('/ask/over18') || html.includes('name="yes"')) {
    const body = new URLSearchParams({
      from: new URL(url, 'https://www.ptt.cc').pathname,
      yes: 'yes'
    });
    await fetchWithTimeout(
      'https://www.ptt.cc/ask/over18',
      {
        method: 'POST',
        cache: 'no-store',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body.toString()
      },
      FETCH_TIMEOUT_MS,
      (resp) => resp.text().catch(() => '')
    );

    html = await fetchWithTimeout(withCacheBust(url), NO_STORE_HTML_OPTIONS, FETCH_TIMEOUT_MS, async (resp) => {
      if (!resp.ok) {
        throw new Error(`Over18 重試失敗 HTTP ${resp.status}`);
      }
      return await resp.text();
    });
  }

  return html;
}

async function fetchPttJson(url, timeoutMs = 6000) {
  return await fetchWithTimeout(
    url,
    {
      cache: 'no-store',
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest'
      }
    },
    timeoutMs,
    async (resp) => {
      if (!resp.ok) {
        throw new Error(`JSON HTTP ${resp.status} (${url})`);
      }
      return await resp.json();
    }
  );
}

// ================= 常駐 longpoll 監聽器 =================
// 模擬 PTT 網頁版行為：永遠掛著一條 /v1/longpoll 連線，伺服器有新推文時立即回傳最新 size/sig，
// 收到後馬上帶 If-Modified-Since / If-None-Match 重新掛上，等待下一次變動。
// 實際的增量抓取仍由排程依「最小抓取間隔」執行，並直接使用這裡記錄的最新 size/sig，因此不會再漏抓。
let longPollWatcher = {
  generation: 0,
  url: '',
  running: false,
  lastModified: '',
  etag: '',
  invalidLastModified: '',
  latest: null,
  lastHealthyAt: 0,
  lastChangeAt: 0
};

function stopLongPollWatcher() {
  longPollWatcher.generation++;
  longPollWatcher.running = false;
  longPollWatcher.url = '';
  longPollWatcher.latest = null;
  longPollWatcher.lastHealthyAt = 0;
  longPollWatcher.lastChangeAt = 0;
}

function ensureLongPollWatcher() {
  const url = sharedState.enabled ? pollingSession.longPollUrl || '' : '';
  if (!url) {
    if (longPollWatcher.running || longPollWatcher.url) stopLongPollWatcher();
    return;
  }
  if (longPollWatcher.running && longPollWatcher.url === url) return;

  stopLongPollWatcher();
  const gen = longPollWatcher.generation;
  longPollWatcher.url = url;
  longPollWatcher.running = true;
  longPollWatcher.lastModified = '';
  longPollWatcher.etag = '';
  longPollWatcher.invalidLastModified = '';

  runLongPollWatcher(gen, url)
    .catch((err) => console.warn('[PTT 彈幕診斷] longpoll 監聽器異常結束:', err?.message || err))
    .finally(() => {
      if (gen === longPollWatcher.generation) {
        longPollWatcher.running = false;
      }
    });
}

async function runLongPollWatcher(gen, url) {
  const isCurrent = () => gen === longPollWatcher.generation;

  while (isCurrent() && sharedState.enabled) {
    const headers = {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest'
    };
    if (longPollWatcher.lastModified) headers['If-Modified-Since'] = longPollWatcher.lastModified;
    if (longPollWatcher.etag) headers['If-None-Match'] = longPollWatcher.etag;

    let delayMs = 0;
    try {
      // 不可附加 _cb query 參數（同 fetchArticleDeltaPushes 說明）
      const result = await fetchWithTimeout(
        url,
        { cache: 'no-store', credentials: 'include', headers },
        LONGPOLL_WATCH_TIMEOUT_MS,
        async (resp) => ({
          status: resp.status,
          lastModified: resp.headers.get('last-modified') || '',
          etag: resp.headers.get('etag') || '',
          data: resp.ok ? await resp.json().catch(() => null) : null
        })
      );
      if (!isCurrent()) return;

      const now = Date.now();
      const data = result.data;
      if (result.status === 200 && data && typeof data.size === 'number' && data.sig) {
        const prev = longPollWatcher.latest;
        const isDuplicate = Boolean(prev && prev.size === data.size && prev.sig === data.sig);
        const isKnownInvalidId =
          Boolean(result.lastModified) && result.lastModified === longPollWatcher.invalidLastModified;
        if (isKnownInvalidId) {
          // 快取仍回傳已失效的訊息 ID：size/sig 資料可用，但不能拿來等待下一則，
          // 維持無條件請求並稍候再查，直到出現新訊息、拿到有效 ID 才回到正常長輪詢
          longPollWatcher.lastModified = '';
          longPollWatcher.etag = '';
          delayMs = LONGPOLL_WATCH_DUP_DELAY_MS;
        } else {
          longPollWatcher.lastModified = result.lastModified;
          longPollWatcher.etag = result.etag;
          longPollWatcher.invalidLastModified = '';
        }
        longPollWatcher.latest = {
          size: data.size,
          sig: data.sig,
          cacheKey: data.cacheKey || '',
          receivedAt: now
        };
        longPollWatcher.lastHealthyAt = now;
        if (isDuplicate) {
          // 伺服器沒給 Last-Modified 時可能重複回傳快取結果，稍候再掛避免空轉
          delayMs = LONGPOLL_WATCH_DUP_DELAY_MS;
        } else {
          longPollWatcher.lastChangeAt = now;
        }
      } else if (LONGPOLL_WATCH_RETRYABLE_STATUS.has(result.status)) {
        // 304 / Cloudflare 522 等：代表這段時間沒有新變動，立即重新掛上
        longPollWatcher.lastHealthyAt = now;
        delayMs = LONGPOLL_WATCH_RETRY_MS;
      } else if (result.status === 400 && longPollWatcher.lastModified) {
        // 400「Message ID invalid」：If-Modified-Since 必須是伺服器緩衝區內真實存在的訊息時間。
        // 常見於監聽剛啟動時拿到的是 CDN 快取的舊回應（其 Last-Modified 已不在緩衝區）。
        // 記住此失效 ID，改以無條件請求輪詢快取，直到出現新訊息。
        longPollWatcher.invalidLastModified = longPollWatcher.lastModified;
        longPollWatcher.lastModified = '';
        longPollWatcher.etag = '';
        longPollWatcher.lastHealthyAt = now;
        delayMs = LONGPOLL_WATCH_RETRY_MS;
      } else {
        console.warn('[PTT 彈幕診斷] longpoll 監聽回應異常:', result.status);
        longPollWatcher.lastModified = '';
        longPollWatcher.etag = '';
        delayMs = LONGPOLL_WATCH_ERROR_BACKOFF_MS;
      }
    } catch (err) {
      if (!isCurrent()) return;
      const msg = String(err?.message || err || '');
      if (err?.name === 'AbortError' || /abort|timeout/i.test(msg)) {
        // 等滿逾時仍無變動 = 正常的「沒有新推文」，立即重新掛上
        longPollWatcher.lastHealthyAt = Date.now();
      } else {
        delayMs = LONGPOLL_WATCH_ERROR_BACKOFF_MS;
      }
    }

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// 回傳監聽器掌握的最新 longpoll 資料；null = 監聽器不可用（需退回直接詢問），
// 'NO_CHANGE' = 監聽器運作正常但尚未收到任何變動
function getWatcherLpData(session) {
  if (!longPollWatcher.running || longPollWatcher.url !== session.longPollUrl) return null;
  if (longPollWatcher.latest) return longPollWatcher.latest;
  if (Date.now() - longPollWatcher.lastHealthyAt < LONGPOLL_WATCH_HEALTHY_WINDOW_MS) return 'NO_CHANGE';
  return null;
}

function isFullReloadDue() {
  const lastSignalAt = Math.max(pollingSession.lastFullLoadAt || 0, longPollWatcher.lastChangeAt || 0);
  return Date.now() - lastSignalAt >= FULL_RELOAD_SAFETY_MS;
}

function buildRefollowPollUrl(basePollUrl, lpData) {
  if (!basePollUrl || !lpData || !lpData.cacheKey) return '';
  const qIdx = basePollUrl.indexOf('?');
  const prefix = qIdx >= 0 ? basePollUrl.slice(0, qIdx) : basePollUrl;
  return (
    `${prefix}?cacheKey=${encodeURIComponent(String(lpData.cacheKey))}` +
    `&offset=${encodeURIComponent(String(lpData.size || 0))}` +
    `&offset-sig=${encodeURIComponent(String(lpData.sig || ''))}`
  );
}

function extractOffsetFromPollUrl(pollUrlStr, fallbackOffset = 0) {
  if (!pollUrlStr) return fallbackOffset;
  const m = String(pollUrlStr).match(/[?&]offset=(\d+)/i);
  if (!m) return fallbackOffset;
  const parsed = parseInt(m[1], 10);
  return Number.isFinite(parsed) ? parsed : fallbackOffset;
}

// 透過 PTT 官方 longpoll + poll 端點抓取靜態 HTML 快照之後的所有增量推文（支援分段回傳迴圈補齊）
async function fetchArticleDeltaPushes(session) {
  if (!session || !session.pollUrl || !session.longPollUrl) {
    return { ok: false, deltaPushes: [], rawDivCount: 0 };
  }

  let lpData = getWatcherLpData(session);
  if (lpData === 'NO_CHANGE') {
    return { ok: true, deltaPushes: [], rawDivCount: 0, watcherNoChange: true };
  }
  if (!lpData) {
    // 監聽器尚未就緒：退回直接詢問一次（僅在最近剛有變動、伺服器仍有快取時會立即回應）
    try {
      // 不可附加 _cb query 參數，否則會繞過 PTT nginx 快取並觸發長連線掛起
      lpData = await fetchPttJson(session.longPollUrl, 4500);
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (err?.name === 'AbortError' || /abort|timeout/i.test(msg)) {
        return { ok: true, deltaPushes: [], rawDivCount: 0, timeoutNoChange: true };
      }
      throw err;
    }
  }

  if (!lpData || typeof lpData.size !== 'number' || !lpData.sig) {
    return { ok: false, deltaPushes: [], rawDivCount: 0 };
  }

  if (lpData.cacheKey && session.cacheKey && lpData.cacheKey !== session.cacheKey) {
    return { ok: false, needFullReload: true, lpData, deltaPushes: [], rawDivCount: 0 };
  }

  if (lpData.size <= session.currSize) {
    return { ok: true, deltaPushes: [], rawDivCount: 0, lpData };
  }

  let combinedHtmlChunks = '';
  let guard = 0;

  while (session.currSize < lpData.size && guard < 80) {
    guard++;
    const deltaReqUrl =
      `${session.pollUrl}` +
      `&size=${encodeURIComponent(String(lpData.size))}` +
      `&size-sig=${encodeURIComponent(String(lpData.sig))}`;

    let pollData;
    try {
      pollData = await fetchPttJson(deltaReqUrl, 6000);
    } catch (pollErr) {
      if (combinedHtmlChunks) {
        break;
      }
      throw pollErr;
    }

    if (!pollData || !pollData.success) {
      if (combinedHtmlChunks) {
        break;
      }
      const refollowUrl = buildRefollowPollUrl(session.pollUrl, lpData);
      if (refollowUrl) {
        session.pollUrl = refollowUrl;
        session.currSize = lpData.size;
        session.cacheKey = lpData.cacheKey || session.cacheKey;
      }
      return { ok: false, needFullReload: true, lpData, deltaPushes: [], rawDivCount: 0 };
    }

    if (pollData.contentHtml) {
      combinedHtmlChunks += pollData.contentHtml;
    }

    if (pollData.pollUrl) {
      const nextPollUrl = new URL(decodeHtmlEntities(pollData.pollUrl), 'https://www.ptt.cc').href;
      const nextOffset = extractOffsetFromPollUrl(nextPollUrl, 0);
      if (nextOffset > session.currSize) {
        session.pollUrl = nextPollUrl;
        session.currSize = nextOffset;
      } else {
        break;
      }
    } else {
      break;
    }

    if (!pollData.contentHtml) {
      break;
    }
  }

  if (lpData.cacheKey) {
    session.cacheKey = lpData.cacheKey;
  }

  const parsedDelta = parsePushNodesFromHtmlChunk(combinedHtmlChunks, {
    startIndex: sharedState.pushes.length,
    initialYear: session.currentYear,
    initialLastTimestamp: session.lastTimestamp
  });

  session.currentYear = parsedDelta.lastYear;
  session.lastTimestamp = parsedDelta.lastTimestamp;

  return {
    ok: true,
    deltaPushes: parsedDelta.pushes,
    rawDivCount: parsedDelta.rawDivCount,
    lpData
  };
}

function getTodayDatePatterns() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return {
    fullSlash: `${yyyy}/${mm}/${dd}`,
    shortSlash: `${mm}/${dd}`,
    compactMmDd: `${mm}${dd}`
  };
}

async function resolveTargetArticleUrl(board, query) {
  const indexUrl = `https://www.ptt.cc/bbs/${encodeURIComponent(board)}/index.html`;
  const indexHtml = await fetchPttHtml(indexUrl);
  const firstPage = parseBoardPageFromHtml(indexHtml);

  const mergedMap = new Map();
  for (const item of firstPage.entries) {
    mergedMap.set(item.fullUrl, item);
  }

  // 同時往前抓 1 頁（避免新發出的盤中/盤後閒聊尚未置底就被新文章洗到上一頁）
  if (firstPage.prevPageUrl) {
    try {
      const prevHtml = await fetchPttHtml(firstPage.prevPageUrl);
      const prevPage = parseBoardPageFromHtml(prevHtml);
      for (const item of prevPage.entries) {
        if (!mergedMap.has(item.fullUrl)) {
          mergedMap.set(item.fullUrl, item);
        }
      }
    } catch (err) {
      console.warn('[PTT 彈幕診斷] 抓取看板上一頁失敗（略過）:', err.message || err);
    }
  }

  const candidates = Array.from(mergedMap.values());
  candidates.sort((a, b) => b.epoch - a.epoch);

  const { fullSlash, shortSlash, compactMmDd } = getTodayDatePatterns();
  const q = (query || '').trim();
  let chosen = null;
  let matchedRule = 'fallback_latest';

  if (q) {
    const todayChat = candidates.find(
      (c) =>
        (c.titleText.includes(fullSlash) ||
          c.titleText.includes(shortSlash) ||
          c.titleText.includes(compactMmDd)) &&
        (c.titleText.includes('盤中閒聊') ||
          c.titleText.includes('盤後閒聊') ||
          c.titleText.includes('閒聊')) &&
        c.titleText.includes(q)
    );
    if (todayChat) {
      chosen = todayChat;
      matchedRule = `today_chat(${shortSlash}+${q})`;
    } else {
      const matched = candidates.find(
        (c) => c.titleText.includes(q) || q.includes(c.titleText)
      );
      if (matched) {
        chosen = matched;
        matchedRule = `query_match(${q})`;
      } else {
        chosen = candidates[0] || null;
        matchedRule = `query_miss_fallback_latest(${q})`;
      }
    }
  } else {
    chosen = candidates[0] || null;
    matchedRule = 'no_query_latest';
  }

  lastBoardResolveAt = Date.now();

  return {
    entry: chosen,
    debugInfo: {
      board,
      query: q,
      indexUrl,
      matchedRule,
      resolvedUrl: chosen ? chosen.fullUrl : '',
      resolvedShortId: chosen ? extractArticleShortId(chosen.fullUrl) : '',
      resolvedTitle: chosen ? chosen.titleText : '',
      candidatesPreview: candidates.slice(0, 6).map((c) => `${extractArticleShortId(c.fullUrl)} ${c.titleText}`)
    }
  };
}

function finalizeArticleStateAndBroadcast({
  articleUrl,
  pushes,
  newlyAddedPushes,
  isSameArticle,
  meta = {},
  title = '',
  rawDivCount = 0,
  deltaTotalCount = 0,
  pollMode = 'full_html'
}) {
  const prevLen = sharedState.pushes.length;
  const startTime = pushes.length > 0 ? pushes[0].virtualTime : Date.now();
  const lastPushTime = pushes.length > 0 ? pushes[pushes.length - 1].virtualTime : startTime;
  // 時間軸最右端保留至當下時間往後 1 小時（3600000ms），方便隨時間推移拖曳滑桿至最新推文
  const oneHourAhead = Date.now() + 3600000;
  const endTime = Math.max(lastPushTime + 5000, oneHourAhead, startTime + 60000);
  const totalDuration = Math.max(endTime - startTime, 60000);

  const m = articleUrl.match(/M\.(\d+)\.A\.[^.]+\.html/i);
  const epoch = meta.epoch ?? (m ? parseInt(m[1], 10) : sharedState.articleEpoch);

  const debugPayload = {
    ...(meta.debugInfo || sharedState.lastDebugInfo || {}),
    resolvedUrl: articleUrl,
    resolvedShortId: extractArticleShortId(articleUrl),
    resolvedTitle: meta.title || title || sharedState.articleTitle || articleUrl,
    rawDivCount,
    deltaTotalCount,
    pollMode,
    currSize: pollingSession.currSize,
    parsedCount: pushes.length,
    prevCount: prevLen,
    addedCount: newlyAddedPushes.length
  };

  console.log('[PTT 彈幕診斷] 抓文結果:', debugPayload);

  sharedState.pushes = pushes;
  sharedState.startTime = startTime;
  sharedState.endTime = endTime;
  sharedState.totalDuration = totalDuration;
  sharedState.articleTitle = meta.title || title || sharedState.articleTitle || articleUrl;
  sharedState.articleUrl = articleUrl;
  sharedState.board = meta.board || sharedState.board || DEFAULT_BOARD;
  sharedState.articleEpoch = epoch;
  sharedState.lastFetchedAt = Date.now();
  sharedState.lastFailedAt = 0;
  sharedState.lastError = '';
  sharedState.lastDebugInfo = debugPayload;

  if (newlyAddedPushes.length > 0) {
    sharedState.nextPushIndex = pushes.length;
    sharedState.currentVirtualTime = endTime;
  } else if (!isSameArticle) {
    sharedState.currentVirtualTime = sharedState.isLiveMode ? endTime : startTime;
    sharedState.nextPushIndex = sharedState.isLiveMode ? pushes.length : 0;
    sharedState.isPlaying = false;
  }

  sharedState.lastUpdatedAt = Date.now();
  // 同篇文章且推文無變動（例如短間隔輪詢但沒人推文）：略過大量推文的儲存與廣播，只同步輕量狀態
  const pushesUnchanged =
    isSameArticle && !meta.force && newlyAddedPushes.length === 0 && pushes.length === prevLen;
  if (!pushesUnchanged) {
    saveSessionMetaToStorage();
  }
  ensureLongPollWatcher();
  const snapshot = getSnapshot({ includePushes: !pushesUnchanged });
  const nowMinuteFloor = Math.floor(Date.now() / 60000) * 60000;
  const cutoffTs = nowMinuteFloor - INITIAL_PREVIEW_WINDOW_MINUTES * 60000;
  const hasStaleCatchup =
    newlyAddedPushes.length > 0 &&
    (Number(newlyAddedPushes[0]?.timestamp) || 0) > 0 &&
    Number(newlyAddedPushes[0].timestamp) < cutoffTs;

  let liveEmitPushes = newlyAddedPushes;
  let clearExistingQueue = false;
  if (meta.force) {
    // 使用者按「立即抓文」：清空排隊中的舊彈幕，只發射最新一波，讓最新推文立刻出現在畫面上
    // （若送出多波，最新推文會排在最後一波，需等前面幾波飛完才看得到）
    liveEmitPushes = (newlyAddedPushes.length > 0 ? newlyAddedPushes : pushes).slice(-sharedState.maxBatchCount);
    clearExistingQueue = true;
  } else if (hasStaleCatchup || !isSameArticle) {
    liveEmitPushes = selectInitialPreviewPushes(
      newlyAddedPushes.length > 0 ? newlyAddedPushes : pushes,
      sharedState.maxBatchCount
    );
    clearExistingQueue = true;
  }

  const batchId =
    liveEmitPushes.length > 0
      ? `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      : '';

  if (sharedState.enabled) {
    if (liveEmitPushes.length > 0 && !sharedState.isPlaying) {
      broadcastToAllTabs({
        type: 'DANMAKU_LIVE_NEW_PUSHES',
        addedPushes: liveEmitPushes,
        addedCount: liveEmitPushes.length,
        clearExistingQueue,
        isCatchupTrimmed: hasStaleCatchup,
        batchId,
        isNewArticle: !isSameArticle,
        state: snapshot
      });
    } else {
      broadcastToAllTabs({
        type: 'DANMAKU_STATE_UPDATED',
        state: snapshot
      });
    }
  }

  return {
    ok: true,
    state: snapshot,
    batchId,
    addedCount: liveEmitPushes.length,
    newlyAddedPushes: liveEmitPushes,
    clearExistingQueue,
    isCatchupTrimmed: hasStaleCatchup,
    isNewArticle: !isSameArticle,
    debugInfo: debugPayload
  };
}

async function loadArticleIntoBackground(articleUrl, meta = {}) {
  const prevLen = sharedState.pushes.length;
  const prevUrl = sharedState.articleUrl;
  const isSameArticle = prevUrl === articleUrl;

  // 快速路徑：若為同一篇文章且已有有效的增量輪詢 Session，直接打 longpoll + poll 拿最新推文
  if (
    isSameArticle &&
    pollingSession.articleUrl === articleUrl &&
    pollingSession.pollUrl &&
    pollingSession.longPollUrl &&
    sharedState.pushes.length > 0 &&
    !isFullReloadDue()
  ) {
    try {
      const deltaRes = await fetchArticleDeltaPushes(pollingSession);
      if (deltaRes.ok && !deltaRes.needFullReload) {
        let newlyAddedPushes = deltaRes.deltaPushes || [];
        let nextPushes = sharedState.pushes;
        if (newlyAddedPushes.length > 0) {
          nextPushes = [...sharedState.pushes, ...newlyAddedPushes];
          assignVirtualTimes(nextPushes);
          pollingSession.deltaTotalCount += newlyAddedPushes.length;
          pollingSession.lastDeltaAddedCount = newlyAddedPushes.length;
        } else {
          pollingSession.lastDeltaAddedCount = 0;
          if (meta.force && nextPushes.length > 0) {
            newlyAddedPushes = selectInitialPreviewPushes(nextPushes, sharedState.maxBatchCount);
          }
        }
        pollingSession.pollMode = 'delta_poll';

        return finalizeArticleStateAndBroadcast({
          articleUrl,
          pushes: nextPushes,
          newlyAddedPushes,
          isSameArticle: true,
          meta,
          title: sharedState.articleTitle,
          rawDivCount: pollingSession.baseRawDivCount + pollingSession.deltaTotalCount,
          deltaTotalCount: pollingSession.deltaTotalCount,
          pollMode: 'delta_poll'
        });
      }
    } catch (deltaErr) {
      console.warn('[PTT 彈幕診斷] 增量輪詢異常，退回完整抓取 + 增量補齊:', deltaErr.message || deltaErr);
    }
  }

  // 完整路徑：首次載入文章、換篇、或 cacheKey 變更時，先抓靜態 HTML 再立刻補齊 longpoll 增量
  const htmlText = await fetchPttHtml(articleUrl);
  const { pushes: basePushes, title, rawDivCount, lastYear, lastTimestamp } = parsePushesFromHtml(htmlText);
  const pollCfg = extractPollingConfigFromHtml(htmlText);

  let combinedPushes = basePushes;
  let deltaCount = 0;
  let pollMode = 'full_html';

  if (pollCfg) {
    pollingSession = {
      articleUrl,
      pollUrl: pollCfg.pollUrl,
      longPollUrl: pollCfg.longPollUrl,
      currSize: pollCfg.currSize,
      cacheKey: pollCfg.cacheKey,
      currentYear: lastYear,
      lastTimestamp,
      baseRawDivCount: rawDivCount,
      deltaTotalCount: 0,
      lastDeltaAddedCount: 0,
      pollMode: 'full_plus_delta'
    };

    try {
      const deltaRes = await fetchArticleDeltaPushes(pollingSession);
      if (deltaRes.ok && deltaRes.deltaPushes.length > 0) {
        deltaCount = deltaRes.deltaPushes.length;
        combinedPushes = [...basePushes, ...deltaRes.deltaPushes];
        assignVirtualTimes(combinedPushes);
        pollingSession.deltaTotalCount = deltaCount;
        pollingSession.lastDeltaAddedCount = deltaCount;
        pollMode = 'full_plus_delta';
      } else if (deltaRes.ok) {
        pollMode = 'full_plus_delta';
      }
    } catch (err) {
      console.warn('[PTT 彈幕診斷] 初次增量補齊失敗（僅使用靜態 HTML）:', err.message || err);
    }
  } else {
    resetPollingSession(articleUrl);
  }
  pollingSession.lastFullLoadAt = Date.now();

  // 處理同篇文章合併（支援 PTT「檔案過大！部分文章無法顯示」滑動視窗截斷下的新推文偵測與保留）
  let newlyAddedPushes = [];
  if (isSameArticle && prevLen > 0) {
    const mergedResult = mergeSameArticlePushes(sharedState.pushes, combinedPushes);
    combinedPushes = mergedResult.mergedPushes;
    newlyAddedPushes = mergedResult.newlyAddedPushes;
    if (newlyAddedPushes.length === 0 && meta.force && combinedPushes.length > 0) {
      newlyAddedPushes = selectInitialPreviewPushes(combinedPushes, sharedState.maxBatchCount);
    }
  } else if (combinedPushes.length > 0) {
    newlyAddedPushes = selectInitialPreviewPushes(combinedPushes, sharedState.maxBatchCount);
  }

  return finalizeArticleStateAndBroadcast({
    articleUrl,
    pushes: combinedPushes,
    newlyAddedPushes,
    isSameArticle,
    meta,
    title,
    rawDivCount: rawDivCount + deltaCount,
    deltaTotalCount: pollingSession.deltaTotalCount,
    pollMode
  });
}

async function backgroundFetchStockArticle({
  board,
  query,
  enableLive,
  force = false,
  checkBoardIndex = false,
  isScheduledPoll = false
} = {}) {
  if (bootstrapPromise) {
    try {
      await bootstrapPromise;
    } catch (_) { }
  }
  if (!sharedState.enabled) {
    return { ok: false, error: '擴充功能目前處於停用狀態' };
  }

  const targetBoard = (board || sharedState.board || DEFAULT_BOARD).trim() || DEFAULT_BOARD;
  const targetQuery = query !== undefined ? String(query).trim() : sharedState.query;
  const boardChanged = targetBoard !== sharedState.board;
  const queryChanged = targetQuery !== sharedState.query;

  sharedState.board = targetBoard;
  sharedState.query = targetQuery;

  if (enableLive) {
    sharedState.isLiveMode = true;
    sharedState.isPlaying = false;
  }
  saveSessionMetaToStorage();

  const requestKey = `${targetBoard}::${targetQuery}`;
  if (inflightFetchPromise && inflightFetchKey === requestKey) {
    if (!force) {
      return inflightFetchPromise;
    }
    // 使用者強制抓取時遇到進行中的排程抓取：等它結束後再執行一次強制抓取，
    // 否則會直接沿用排程結果（不清空佇列、不發射最新一波）
    try {
      await inflightFetchPromise;
    } catch (_) { }
  }

  const cooldownMs = getFetchCooldownRemainingMs(isScheduledPoll ? 350 : 0);
  if (!force && !boardChanged && !queryChanged && cooldownMs > 0) {
    return {
      ok: true,
      state: getSnapshot({ includePushes: false }),
      addedCount: 0,
      newlyAddedPushes: [],
      throttled: true,
      retryAfterMs: cooldownMs,
      debugInfo: sharedState.lastDebugInfo
    };
  }

  const runFetch = async () => {
    try {
      const needResolveIndex =
        force ||
        checkBoardIndex ||
        boardChanged ||
        queryChanged ||
        !sharedState.articleUrl ||
        Date.now() - lastBoardResolveAt >= BOARD_POLL_INTERVAL_MS;

      let targetUrl = sharedState.articleUrl;
      let targetMeta = {
        board: targetBoard,
        title: sharedState.articleTitle,
        epoch: sharedState.articleEpoch,
        debugInfo: sharedState.lastDebugInfo,
        force: Boolean(force)
      };

      if (needResolveIndex) {
        const { entry: found, debugInfo } = await resolveTargetArticleUrl(targetBoard, targetQuery);
        sharedState.lastDebugInfo = debugInfo;
        if (!found) {
          throw new Error(`在 ${targetBoard} 板找不到符合條件的文章`);
        }
        targetUrl = found.fullUrl;
        targetMeta = {
          board: targetBoard,
          title: found.titleText,
          epoch: found.epoch,
          debugInfo,
          force: Boolean(force)
        };
      }

      return await loadArticleIntoBackground(targetUrl, targetMeta);
    } catch (err) {
      sharedState.lastError = err.message || String(err);
      sharedState.lastFailedAt = Date.now();
      console.warn('[PTT 彈幕診斷] 抓文失敗:', sharedState.lastError);
      // 通知控制面板/分頁顯示錯誤狀態
      broadcastToAllTabs({ type: 'DANMAKU_STATE_UPDATED', state: getSnapshot({ includePushes: false }) });
      throw err;
    } finally {
      if (inflightFetchKey === requestKey) {
        inflightFetchPromise = null;
        inflightFetchKey = '';
      }
    }
  };

  inflightFetchKey = requestKey;
  inflightFetchPromise = runFetch();
  return inflightFetchPromise;
}

async function setMinFetchIntervalSeconds(seconds) {
  const nextMs = sanitizeMinFetchIntervalMs(seconds, true);
  sharedState.minFetchIntervalMs = nextMs;
  sharedState.lastUpdatedAt = Date.now();

  try {
    await chrome.storage.local.set({ [STORAGE_MIN_INTERVAL_KEY]: nextMs });
  } catch (_) { }

  const snapshot = getSnapshot();
  broadcastToAllTabs({
    type: 'DANMAKU_STATE_UPDATED',
    state: snapshot
  });

  if (
    sharedState.enabled &&
    sharedState.isLiveMode &&
    !sharedState.isPlaying &&
    getFetchCooldownRemainingMs() === 0
  ) {
    backgroundFetchStockArticle({
      board: sharedState.board || DEFAULT_BOARD,
      query: sharedState.query ?? DEFAULT_QUERY,
      enableLive: true,
      checkBoardIndex: false,
      isScheduledPoll: true
    }).catch(() => { });
  }

  return snapshot;
}

async function setFlyDurationSeconds(seconds) {
  const nextMs = sanitizeFlyDurationMs(seconds, true);
  sharedState.flyDurationMs = nextMs;
  sharedState.lastUpdatedAt = Date.now();

  try {
    await chrome.storage.local.set({ [STORAGE_FLY_DURATION_KEY]: nextMs });
  } catch (_) { }

  const snapshot = getSnapshot();
  broadcastToAllTabs({
    type: 'DANMAKU_STATE_UPDATED',
    state: snapshot
  });
  return snapshot;
}

async function setMaxBatchCount(count) {
  const nextCount = sanitizeMaxBatchCount(count);
  sharedState.maxBatchCount = nextCount;
  sharedState.lastUpdatedAt = Date.now();

  try {
    await chrome.storage.local.set({ [STORAGE_MAX_BATCH_KEY]: nextCount });
  } catch (_) { }

  const snapshot = getSnapshot();
  broadcastToAllTabs({
    type: 'DANMAKU_STATE_UPDATED',
    state: snapshot
  });
  return snapshot;
}

async function setFilterOptions(options = {}) {
  if (typeof options.crossTabShowEnabled === 'boolean') {
    sharedState.crossTabShowEnabled = options.crossTabShowEnabled;
  }
  if (typeof options.booOnly === 'boolean') {
    sharedState.booOnly = options.booOnly;
  }
  if (typeof options.keywordRaw === 'string') {
    sharedState.keywordRaw = options.keywordRaw;
  }
  if (typeof options.keywordFilterOnly === 'boolean') {
    sharedState.keywordFilterOnly = options.keywordFilterOnly;
  }
  sharedState.lastUpdatedAt = Date.now();

  try {
    await chrome.storage.local.set({
      [STORAGE_FILTER_OPTIONS_KEY]: {
        crossTabShowEnabled: sharedState.crossTabShowEnabled,
        booOnly: sharedState.booOnly,
        keywordRaw: sharedState.keywordRaw,
        keywordFilterOnly: sharedState.keywordFilterOnly
      }
    });
  } catch (_) { }

  const snapshot = getSnapshot();
  broadcastToAllTabs({
    type: 'DANMAKU_STATE_UPDATED',
    state: snapshot
  });
  return snapshot;
}

async function setExtensionEnabled(nextEnabled, triggerInitialFetchIfNeeded = false) {
  sharedState.enabled = Boolean(nextEnabled);
  sharedState.lastUpdatedAt = Date.now();

  if (!sharedState.enabled) {
    sharedState.isPlaying = false;
    sharedState.isLiveMode = false;
  } else if (!sharedState.isPlaying) {
    sharedState.isLiveMode = true;
  }

  updateActionBadge(sharedState.enabled);

  try {
    await chrome.storage.local.set({ [STORAGE_ENABLED_KEY]: sharedState.enabled });
  } catch (_) { }
  saveSessionMetaToStorage();

  const snapshot = getSnapshot();
  broadcastToAllTabs({
    type: 'DANMAKU_ENABLED_CHANGED',
    enabled: sharedState.enabled,
    state: snapshot
  });

  if (sharedState.enabled && triggerInitialFetchIfNeeded && sharedState.pushes.length === 0) {
    backgroundFetchStockArticle({
      board: sharedState.board || DEFAULT_BOARD,
      query: sharedState.query || DEFAULT_QUERY,
      enableLive: true,
      force: true,
      checkBoardIndex: true
    }).catch((err) => {
      console.warn('[PTT 彈幕背景] 啟用後抓取 Stock 文章失敗:', err);
    });
  }

  return snapshot;
}

// 接收前端分頁的長連線以防止 MV3 Service Worker 在播放或 Live 追文期間休眠
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ptt-danmaku-keepalive') return;
  keepAlivePorts.add(port);
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === 'PING') {
      try {
        chrome.storage.local.get(STORAGE_ENABLED_KEY, () => {
          void chrome.runtime.lastError;
        });
        port.postMessage({ type: 'PONG', ts: Date.now() });
      } catch (_) { }
    }
  });
  port.onDisconnect.addListener(() => {
    keepAlivePorts.delete(port);
  });
});

setInterval(() => {
  if (!sharedState.enabled) return;
  if (!sharedState.isPlaying || sharedState.isLiveMode || sharedState.pushes.length === 0) {
    return;
  }

  const dt = 200;
  sharedState.currentVirtualTime += dt * (sharedState.speedMsPerSec / 1000);

  if (sharedState.currentVirtualTime >= sharedState.endTime) {
    sharedState.currentVirtualTime = sharedState.endTime;
    sharedState.isPlaying = false;
  }

  const duePushes = [];
  while (
    sharedState.nextPushIndex < sharedState.pushes.length &&
    sharedState.pushes[sharedState.nextPushIndex].virtualTime <= sharedState.currentVirtualTime
  ) {
    duePushes.push(sharedState.pushes[sharedState.nextPushIndex]);
    sharedState.nextPushIndex++;
  }

  sharedState.lastUpdatedAt = Date.now();

  broadcastToAllTabs({
    type: 'DANMAKU_TICK',
    currentVirtualTime: sharedState.currentVirtualTime,
    nextPushIndex: sharedState.nextPushIndex,
    isPlaying: sharedState.isPlaying,
    duePushes
  });
}, 200);

// 動態背景追文排程：依使用者設定的 minFetchIntervalMs（3s~300s）自動抓最新增量推文
setInterval(() => {
  // 確保 longpoll 監聽器隨目前文章常駐（停用、換篇或 SW 重啟後自動切換/恢復）
  ensureLongPollWatcher();
  if (!sharedState.enabled || inflightFetchPromise) return;
  if (!sharedState.isLiveMode && sharedState.isPlaying) return;

  if (getFetchCooldownRemainingMs() > 0) {
    return;
  }

  backgroundFetchStockArticle({
    board: sharedState.board || DEFAULT_BOARD,
    query: sharedState.query ?? DEFAULT_QUERY,
    enableLive: sharedState.isLiveMode,
    checkBoardIndex: false,
    isScheduledPoll: true
  }).catch((err) => {
    sharedState.lastError = err.message || String(err);
    console.warn('[PTT 彈幕背景] Live 追文失敗:', err);
  });
}, 1000);

setInterval(() => {
  if (!sharedState.enabled || !sharedState.board || inflightFetchPromise) return;
  backgroundFetchStockArticle({
    board: sharedState.board,
    query: sharedState.query ?? DEFAULT_QUERY,
    enableLive: sharedState.isLiveMode,
    checkBoardIndex: true,
    isScheduledPoll: true
  }).catch((err) => {
    sharedState.lastError = err.message || String(err);
    console.warn('[PTT 彈幕背景] 看板換篇檢查失敗:', err);
  });
}, BOARD_POLL_INTERVAL_MS);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === 'SET_MIN_FETCH_INTERVAL') {
    setMinFetchIntervalSeconds(message.seconds)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'SET_FLY_DURATION') {
    setFlyDurationSeconds(message.seconds)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'SET_MAX_BATCH_COUNT') {
    setMaxBatchCount(message.count)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'SET_FILTER_OPTIONS') {
    setFilterOptions(message)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'CLEAR_DANMAKU_QUEUE') {
    const state = clearDanmakuQueue();
    sendResponse({ ok: true, state });
    return true;
  }

  if (message.type === 'SET_EXTENSION_ENABLED') {
    const nextEnabled = Boolean(message.enabled);
    setExtensionEnabled(nextEnabled, nextEnabled && sharedState.pushes.length === 0)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'FETCH_PTT_HTML') {
    if (!sharedState.enabled) {
      sendResponse({ ok: false, error: '擴充功能已停用' });
      return true;
    }
    fetchPttHtml(message.url)
      .then((html) => sendResponse({ ok: true, html }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'BACKGROUND_LOAD_STOCK') {
    if (!sharedState.enabled) {
      sendResponse({ ok: false, error: '擴充功能目前處於停用狀態，請先啟用' });
      return true;
    }
    backgroundFetchStockArticle({
      board: message.board,
      query: message.query,
      enableLive: Boolean(message.enableLive),
      force: Boolean(message.force),
      checkBoardIndex: Boolean(message.force)
    })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_DANMAKU_STATE') {
    Promise.resolve(bootstrapPromise)
      .catch(() => { })
      .finally(() => {
        sendResponse({ ok: true, state: getSnapshot() });
      });
    return true;
  }

  if (message.type === 'SET_ARTICLE_PUSHES') {
    if (!sharedState.enabled) {
      sendResponse({ ok: true, state: getSnapshot() });
      return true;
    }

    (async () => {
      const cleanPushes = Array.isArray(message.pushes) ? message.pushes : [];
      const incomingEpoch = Number(message.articleEpoch || 0);
      const incomingUrl = message.articleUrl || '';
      const isSameArticle = Boolean(incomingUrl && sharedState.articleUrl === incomingUrl);

      // 1. 若處於 Live 追文模式且背景已有較新文章，避免舊分頁覆蓋
      if (
        sharedState.isLiveMode &&
        sharedState.articleUrl &&
        incomingUrl &&
        !isSameArticle &&
        sharedState.articleEpoch > incomingEpoch
      ) {
        sendResponse({ ok: true, state: getSnapshot(), ignoredStaleTab: true });
        return;
      }

      const oldLen = sharedState.pushes.length;
      let incomingPushes = [...cleanPushes];
      assignVirtualTimes(incomingPushes);

      // 若分頁傳來 #article-polling 設定，初始化或更新 pollingSession（當分頁 offset 較新或尚未初始化時）並立即補齊最新 delta 推文
      const pollCfg = message.pollingConfig;
      let deltaAddedCount = 0;
      if (pollCfg && pollCfg.pollUrl && pollCfg.longPollUrl) {
        const incomingOffset = Number(pollCfg.currSize) || 0;
        const shouldInitOrAdvanceSession =
          !isSameArticle ||
          pollingSession.articleUrl !== incomingUrl ||
          !pollingSession.pollUrl ||
          incomingOffset > pollingSession.currSize;

        if (shouldInitOrAdvanceSession) {
          const lastPush = incomingPushes.length > 0 ? incomingPushes[incomingPushes.length - 1] : null;
          const inferredYear = lastPush ? new Date(lastPush.timestamp).getFullYear() : new Date().getFullYear();
          pollingSession = {
            articleUrl: incomingUrl,
            pollUrl: new URL(pollCfg.pollUrl, 'https://www.ptt.cc').href,
            longPollUrl: new URL(pollCfg.longPollUrl, 'https://www.ptt.cc').href,
            currSize: incomingOffset,
            cacheKey: pollCfg.cacheKey || '',
            currentYear: inferredYear,
            lastTimestamp: lastPush ? lastPush.timestamp : null,
            baseRawDivCount: incomingPushes.length,
            deltaTotalCount: isSameArticle ? pollingSession.deltaTotalCount : 0,
            lastDeltaAddedCount: 0,
            pollMode: 'tab_dom_plus_delta'
          };
        }
      }

      let mergedPushes = incomingPushes;
      let newlyAddedFromMerge = [];
      if (isSameArticle && oldLen > 0) {
        const mergedResult = mergeSameArticlePushes(sharedState.pushes, incomingPushes);
        mergedPushes = mergedResult.mergedPushes;
        newlyAddedFromMerge = mergedResult.newlyAddedPushes;
      }

      if (
        incomingUrl &&
        pollingSession.articleUrl === incomingUrl &&
        pollingSession.pollUrl &&
        pollingSession.longPollUrl
      ) {
        try {
          const deltaRes = await fetchArticleDeltaPushes(pollingSession);
          if (deltaRes.ok && deltaRes.deltaPushes.length > 0) {
            deltaAddedCount = deltaRes.deltaPushes.length;
            if (isSameArticle && oldLen > 0) {
              const deltaMerged = mergeSameArticlePushes(mergedPushes, deltaRes.deltaPushes);
              mergedPushes = deltaMerged.mergedPushes;
              newlyAddedFromMerge = [...newlyAddedFromMerge, ...deltaMerged.newlyAddedPushes];
            } else {
              mergedPushes = [...mergedPushes, ...deltaRes.deltaPushes];
              assignVirtualTimes(mergedPushes);
            }
            pollingSession.deltaTotalCount += deltaAddedCount;
            pollingSession.lastDeltaAddedCount = deltaAddedCount;
          }
        } catch (err) {
          console.warn('[PTT 彈幕診斷] 分頁 DOM 增量補齊失敗:', err.message || err);
        }
      }

      const startTime = mergedPushes.length > 0 ? mergedPushes[0].virtualTime : Date.now();
      const lastPushTime = mergedPushes.length > 0 ? mergedPushes[mergedPushes.length - 1].virtualTime : startTime;
      const oneHourAhead = Date.now() + 3600000;
      const endTime = Math.max(lastPushTime + 5000, oneHourAhead, startTime + 60000);
      const totalDuration = Math.max(endTime - startTime, 60000);

      sharedState.pushes = mergedPushes;
      sharedState.startTime = startTime;
      sharedState.endTime = endTime;
      sharedState.totalDuration = totalDuration;
      sharedState.articleTitle = message.articleTitle || sharedState.articleTitle;
      sharedState.articleUrl = incomingUrl || sharedState.articleUrl;
      sharedState.board = message.board || sharedState.board;
      sharedState.articleEpoch = incomingEpoch || sharedState.articleEpoch;
      sharedState.lastFetchedAt = Date.now();
      sharedState.lastDebugInfo = {
        ...(sharedState.lastDebugInfo || {}),
        resolvedUrl: sharedState.articleUrl,
        resolvedShortId: extractArticleShortId(sharedState.articleUrl),
        resolvedTitle: sharedState.articleTitle,
        matchedRule: pollingSession.deltaTotalCount > 0 ? 'tab_dom+delta' : 'tab_dom',
        rawDivCount: mergedPushes.length,
        deltaTotalCount: pollingSession.deltaTotalCount,
        parsedCount: mergedPushes.length,
        source: 'tab_dom'
      };
      saveSessionMetaToStorage();

      if (isSameArticle && !sharedState.isPlaying && newlyAddedFromMerge.length > 0) {
        sharedState.nextPushIndex = mergedPushes.length;
        sharedState.currentVirtualTime = endTime;
        broadcastToAllTabs({
          type: 'DANMAKU_LIVE_NEW_PUSHES',
          addedPushes: newlyAddedFromMerge,
          addedCount: newlyAddedFromMerge.length,
          isNewArticle: false,
          state: getSnapshot()
        });
      } else if (!isSameArticle && !sharedState.isPlaying && mergedPushes.length > 0) {
        sharedState.isPlaying = false;
        sharedState.currentVirtualTime = sharedState.isLiveMode ? endTime : startTime;
        sharedState.nextPushIndex = sharedState.isLiveMode ? mergedPushes.length : 0;
        const previewPushes = selectInitialPreviewPushes(mergedPushes, sharedState.maxBatchCount);
        broadcastToAllTabs({
          type: 'DANMAKU_LIVE_NEW_PUSHES',
          addedPushes: previewPushes,
          addedCount: previewPushes.length,
          isNewArticle: true,
          state: getSnapshot()
        });
      } else if (!isSameArticle || newlyAddedFromMerge.length > 0 || deltaAddedCount > 0) {
        sharedState.currentVirtualTime = sharedState.isLiveMode ? endTime : startTime;
        sharedState.nextPushIndex = sharedState.isLiveMode ? mergedPushes.length : 0;
        if (!isSameArticle) {
          sharedState.isPlaying = false;
        }
        broadcastToAllTabs({
          type: 'DANMAKU_STATE_UPDATED',
          state: getSnapshot()
        });
      }

      sendResponse({ ok: true, state: getSnapshot() });
    })();

    return true;
  }

  if (message.type === 'CONTROL_DANMAKU') {
    const action = message.action;
    let clearStage = false;

    if (action === 'PLAY_RECENT_5M') {
      (async () => {
        if (bootstrapPromise) {
          try {
            await bootstrapPromise;
          } catch (_) { }
        }
        if (
          sharedState.enabled &&
          (!sharedState.lastFetchedAt || Date.now() - sharedState.lastFetchedAt >= 3000) &&
          !inflightFetchPromise
        ) {
          await backgroundFetchStockArticle({
            board: sharedState.board || DEFAULT_BOARD,
            query: sharedState.query ?? DEFAULT_QUERY,
            enableLive: true,
            force: false,
            checkBoardIndex: false
          }).catch(() => { });
        }
        sharedState.isLiveMode = true;
        sharedState.isPlaying = false;
        sharedState.currentVirtualTime = sharedState.endTime;
        sharedState.nextPushIndex = sharedState.pushes.length;
        sharedState.lastUpdatedAt = Date.now();
        saveSessionMetaToStorage();

        const snapshot = getSnapshot();
        const recentPushes = selectInitialPreviewPushes(sharedState.pushes, sharedState.maxBatchCount);
        const batchId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        if (sharedState.enabled && recentPushes.length > 0) {
          broadcastToAllTabs({
            type: 'DANMAKU_LIVE_NEW_PUSHES',
            addedPushes: recentPushes,
            addedCount: recentPushes.length,
            batchId,
            isNewArticle: false,
            clearExistingQueue: true,
            toastText: `⏩ 已切換播放最近 5 分鐘推文（共 ${recentPushes.length} 則）`,
            state: snapshot
          });
        } else {
          broadcastToAllTabs({
            type: 'DANMAKU_STATE_UPDATED',
            state: snapshot,
            clearStage: true
          });
        }
        sendResponse({ ok: true, state: snapshot, recentCount: recentPushes.length, batchId });
      })();
      return true;
    }

    if (action === 'TOGGLE_PLAY') {
      if (sharedState.isLiveMode) {
        sharedState.isLiveMode = false;
      }
      if (sharedState.currentVirtualTime >= sharedState.endTime) {
        sharedState.currentVirtualTime = sharedState.startTime;
        sharedState.nextPushIndex = 0;
      }
      sharedState.isPlaying = !sharedState.isPlaying;
    } else if (action === 'SET_PLAYING') {
      sharedState.isPlaying = Boolean(message.isPlaying);
    } else if (action === 'SET_SPEED') {
      // 只調整重播倍速並保存，不切換模式（倍速選單僅在重播模式可操作）
      sharedState.speedMsPerSec = sanitizeReplaySpeed(message.speedMsPerSec);
      chrome.storage.local.set({ [STORAGE_REPLAY_SPEED_KEY]: sharedState.speedMsPerSec }).catch(() => { });
    } else if (action === 'SEEK_RATIO') {
      // 拖曳時間軸 / 點擊尖峰 = 進入重播模式並跳到該時間點；autoPlay 時直接開始播放
      const ratio = Math.min(1, Math.max(0, Number(message.ratio) || 0));
      sharedState.isLiveMode = false;
      sharedState.currentVirtualTime = sharedState.startTime + ratio * sharedState.totalDuration;
      sharedState.nextPushIndex = findNextIndexByTime(sharedState.pushes, sharedState.currentVirtualTime);
      if (message.autoPlay && sharedState.pushes.length > 0) {
        sharedState.isPlaying = true;
      }
      clearStage = true;
    } else if (action === 'JUMP_MINUTES') {
      const deltaMinutes = Number(message.deltaMinutes) || 0;
      if (sharedState.isLiveMode) {
        sharedState.isLiveMode = false;
      }
      sharedState.currentVirtualTime = Math.min(
        sharedState.endTime,
        Math.max(sharedState.startTime, sharedState.currentVirtualTime + deltaMinutes * 60000)
      );
      sharedState.nextPushIndex = findNextIndexByTime(sharedState.pushes, sharedState.currentVirtualTime);
      clearStage = true;
    } else if (action === 'SET_LIVE') {
      const wasLive = sharedState.isLiveMode;
      sharedState.isLiveMode = Boolean(message.enabled);
      if (sharedState.isLiveMode) {
        sharedState.isPlaying = false;
        sharedState.currentVirtualTime = sharedState.endTime;
        sharedState.nextPushIndex = sharedState.pushes.length;
        if (!wasLive) {
          backgroundFetchStockArticle({
            board: sharedState.board || DEFAULT_BOARD,
            query: sharedState.query ?? DEFAULT_QUERY,
            enableLive: true,
            force: true,
            checkBoardIndex: true
          }).catch((err) => {
            console.warn('[PTT 彈幕背景] 啟動 Live 立即抓文失敗:', err);
          });
        }
      }
    }

    sharedState.lastUpdatedAt = Date.now();
    saveSessionMetaToStorage();
    const snapshot = getSnapshot();
    broadcastToAllTabs({
      type: 'DANMAKU_STATE_UPDATED',
      state: snapshot,
      clearStage
    });
    sendResponse({ ok: true, state: snapshot });
    return true;
  }
});

bootstrapPromise = (async function restoreRuntimeStorage() {
  try {
    const saved = await chrome.storage.local.get([
      STORAGE_ENABLED_KEY,
      STORAGE_MIN_INTERVAL_KEY,
      STORAGE_FLY_DURATION_KEY,
      STORAGE_MAX_BATCH_KEY,
      STORAGE_REPLAY_SPEED_KEY,
      STORAGE_FILTER_OPTIONS_KEY,
      STORAGE_SESSION_META_KEY,
      STORAGE_RUNTIME_CACHE_KEY
    ]);
    if (typeof saved[STORAGE_ENABLED_KEY] === 'boolean') {
      sharedState.enabled = saved[STORAGE_ENABLED_KEY];
    }
    if (saved[STORAGE_MIN_INTERVAL_KEY] !== undefined) {
      sharedState.minFetchIntervalMs = sanitizeMinFetchIntervalMs(saved[STORAGE_MIN_INTERVAL_KEY], false);
    }
    if (saved[STORAGE_FLY_DURATION_KEY] !== undefined) {
      sharedState.flyDurationMs = sanitizeFlyDurationMs(saved[STORAGE_FLY_DURATION_KEY], false);
    }
    if (saved[STORAGE_MAX_BATCH_KEY] !== undefined) {
      sharedState.maxBatchCount = sanitizeMaxBatchCount(saved[STORAGE_MAX_BATCH_KEY]);
    }
    if (saved[STORAGE_REPLAY_SPEED_KEY] !== undefined) {
      sharedState.speedMsPerSec = sanitizeReplaySpeed(saved[STORAGE_REPLAY_SPEED_KEY]);
    }
    const filterOpts = saved[STORAGE_FILTER_OPTIONS_KEY];
    if (filterOpts && typeof filterOpts === 'object') {
      if (typeof filterOpts.crossTabShowEnabled === 'boolean') {
        sharedState.crossTabShowEnabled = filterOpts.crossTabShowEnabled;
      }
      if (typeof filterOpts.booOnly === 'boolean') {
        sharedState.booOnly = filterOpts.booOnly;
      }
      if (typeof filterOpts.keywordRaw === 'string') {
        sharedState.keywordRaw = filterOpts.keywordRaw;
      }
      if (typeof filterOpts.keywordFilterOnly === 'boolean') {
        sharedState.keywordFilterOnly = filterOpts.keywordFilterOnly;
      }
    }
    const meta = saved[STORAGE_SESSION_META_KEY];
    if (meta && typeof meta === 'object') {
      if (meta.board) sharedState.board = meta.board;
      if (meta.query !== undefined) sharedState.query = meta.query;
      if (meta.articleUrl) sharedState.articleUrl = meta.articleUrl;
      if (meta.articleTitle) sharedState.articleTitle = meta.articleTitle;
      if (meta.articleEpoch) sharedState.articleEpoch = meta.articleEpoch;
      if (typeof meta.isLiveMode === 'boolean') sharedState.isLiveMode = meta.isLiveMode;
    }
    const runtimeCache = saved[STORAGE_RUNTIME_CACHE_KEY];
    if (runtimeCache && typeof runtimeCache === 'object') {
      if (Array.isArray(runtimeCache.pushes) && runtimeCache.pushes.length > 0) {
        sharedState.pushes = runtimeCache.pushes;
      }
      if (typeof runtimeCache.startTime === 'number' && runtimeCache.startTime > 0) {
        sharedState.startTime = runtimeCache.startTime;
      }
      if (typeof runtimeCache.endTime === 'number' && runtimeCache.endTime > 0) {
        sharedState.endTime = runtimeCache.endTime;
      }
      if (typeof runtimeCache.totalDuration === 'number' && runtimeCache.totalDuration > 0) {
        sharedState.totalDuration = runtimeCache.totalDuration;
      }
      if (typeof runtimeCache.currentVirtualTime === 'number') {
        sharedState.currentVirtualTime = runtimeCache.currentVirtualTime;
      }
      if (typeof runtimeCache.nextPushIndex === 'number') {
        sharedState.nextPushIndex = runtimeCache.nextPushIndex;
      }
      if (typeof runtimeCache.lastFetchedAt === 'number' && runtimeCache.lastFetchedAt > 0) {
        sharedState.lastFetchedAt = runtimeCache.lastFetchedAt;
      }
      if (runtimeCache.lastDebugInfo) {
        sharedState.lastDebugInfo = runtimeCache.lastDebugInfo;
      }
      if (runtimeCache.pollingSession && typeof runtimeCache.pollingSession === 'object') {
        pollingSession = {
          ...pollingSession,
          ...runtimeCache.pollingSession
        };
      }
    }
  } catch (_) { }

  sharedState.isPlaying = false;
  if (sharedState.enabled) {
    sharedState.isLiveMode = true;
  }
  updateActionBadge(sharedState.enabled);
})();

(async function bootstrap() {
  await bootstrapPromise;

  // 從儲存還原的輪詢 Session 立即掛上 longpoll 監聽
  ensureLongPollWatcher();

  // 啟動或從休眠恢復時，若為啟用狀態則預設開啟 Live 追文並立即抓文
  if (sharedState.enabled && sharedState.isLiveMode) {
    backgroundFetchStockArticle({
      board: sharedState.board || DEFAULT_BOARD,
      query: sharedState.query ?? DEFAULT_QUERY,
      enableLive: true,
      force: sharedState.pushes.length === 0,
      checkBoardIndex: sharedState.pushes.length === 0
    }).catch(() => { });
  }
})();

// 僅在安裝/更新/重新載入套件時，將最新的 content.js 注入所有已開啟的 http/https 網頁（免逐一重整分頁）。
// 不可在每次 Service Worker 喚醒時注入，否則會清掉各分頁正在飛的彈幕與待播佇列。
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.scripting && chrome.tabs) {
    chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
      if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
      for (const tab of tabs) {
        if (!tab.id) continue;
        chrome.scripting.executeScript(
          {
            target: { tabId: tab.id },
            files: ['config.js', 'content.js']
          },
          () => {
            void chrome.runtime.lastError;
          }
        );
      }
    });
  }
});
