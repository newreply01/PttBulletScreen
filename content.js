// content.js - 純淨網頁彈幕舞台（所有控制設定已移至套件 Icon 彈出面板）
(function () {
  'use strict';

  if (typeof window.__pttDanmakuCleanup === 'function') {
    try {
      window.__pttDanmakuCleanup();
    } catch (_) {}
  }

  const HOST = window.location.hostname;
  const IS_TERM_MODE = HOST === 'term.ptt.cc';
  const IS_WEB_PTT_MODE = HOST === 'www.ptt.cc';
  const IS_ANY_PTT_MODE = IS_TERM_MODE || IS_WEB_PTT_MODE;

  const urlObj = new URL(window.location.href);
  const autoLiveOnLoad = urlObj.searchParams.get('autolive') === '1';

  const ALLOWED_MIN_INTERVAL_SECONDS = [3, 5, 10, 15, 30, 60, 120, 180, 300];
  const DEFAULT_MIN_INTERVAL_SECONDS = 5;
  const ALLOWED_FLY_DURATION_SECONDS = [5, 7, 10, 14, 18];
  const DEFAULT_FLY_DURATION_SECONDS = 10;
  const ALLOWED_MAX_BATCH_COUNTS = [3, 5, 10, 15, 20, 30, 50];
  const DEFAULT_MAX_BATCH_COUNT = 10;
  const INITIAL_PREVIEW_WINDOW_MINUTES = 5;
  const INITIAL_PREVIEW_MAX_WAVES = 3;

  function normalizeIntervalSeconds(rawSec) {
    const parsed = parseInt(rawSec, 10);
    return ALLOWED_MIN_INTERVAL_SECONDS.includes(parsed) ? parsed : DEFAULT_MIN_INTERVAL_SECONDS;
  }

  function normalizeFlyDurationSeconds(rawSec) {
    const parsed = parseInt(rawSec, 10);
    return ALLOWED_FLY_DURATION_SECONDS.includes(parsed) ? parsed : DEFAULT_FLY_DURATION_SECONDS;
  }

  function normalizeMaxBatchCount(rawVal) {
    const parsed = parseInt(rawVal, 10);
    return ALLOWED_MAX_BATCH_COUNTS.includes(parsed) ? parsed : DEFAULT_MAX_BATCH_COUNT;
  }

  let minFetchIntervalSeconds = DEFAULT_MIN_INTERVAL_SECONDS;
  let flyDurationSeconds = DEFAULT_FLY_DURATION_SECONDS;
  let maxBatchCount = DEFAULT_MAX_BATCH_COUNT;

  function sendBgMessage(msg) {
    return new Promise((resolve, reject) => {
      if (!chrome?.runtime?.id) {
        reject(new Error('Extension context invalidated'));
        return;
      }
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(res);
        }
      });
    });
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  function formatHhMmFromTs(ts) {
    if (!Number.isFinite(ts) || ts <= 0) return '';
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function formatDateTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function extractPushHhMm(push) {
    if (!push) return '';
    if (push.hhmm) return push.hhmm;
    if (push.timeStr) {
      const m = push.timeStr.match(/(\d{2}:\d{2})/);
      if (m) return m[1];
    }
    return formatHhMmFromTs(push.timestamp ?? push.virtualTime);
  }

  // ================= 1. 網頁版 PTT DOM 推文解析 =================
  function parsePushesFromDoc(doc, existingNodes = null) {
    const pushNodes = Array.from(doc.querySelectorAll('.push'));
    if (pushNodes.length === 0) return [];

    let currentYear = new Date().getFullYear();
    const metalines = doc.querySelectorAll('.article-metaline');
    metalines.forEach((line) => {
      const tag = line.querySelector('.article-meta-tag')?.textContent.trim();
      const val = line.querySelector('.article-meta-value')?.textContent.trim();
      if (tag === '時間' && val) {
        const yearMatch = val.match(/\b(20\d{2})\b/);
        if (yearMatch) currentYear = parseInt(yearMatch[1], 10);
      }
    });

    const pushes = [];
    let lastTimestamp = null;

    pushNodes.forEach((node, index) => {
      const tag = node.querySelector('.push-tag')?.textContent.trim() || '→';
      const userid = node.querySelector('.push-userid')?.textContent.trim() || '';
      const rawContent = node.querySelector('.push-content')?.textContent || '';
      const content = rawContent.replace(/^:\s*/, '').trim();
      const ipdatetime = node.querySelector('.push-ipdatetime')?.textContent.trim() || '';

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
      }

      if (timestamp !== null && content) {
        const domNode = IS_WEB_PTT_MODE && existingNodes ? existingNodes[index] || null : null;
        const hhmm = timeMatch ? `${timeMatch[3]}:${timeMatch[4]}` : formatHhMmFromTs(timestamp);
        pushes.push({
          index,
          floor: index + 1,
          tag,
          userid,
          content,
          timestamp,
          hhmm,
          timeStr: timeMatch ? `${timeMatch[1]}/${timeMatch[2]} ${timeMatch[3]}:${timeMatch[4]}` : hhmm,
          node: domNode
        });
      }
    });

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

    return pushes;
  }

  const activeArticleUrl = IS_WEB_PTT_MODE ? `${window.location.origin}${window.location.pathname}` : null;
  const activeBoard = IS_WEB_PTT_MODE
    ? (window.location.pathname.match(/^\/bbs\/([^/]+)\/M\.\d+\.A\.[^.]+\.html$/i)?.[1] || 'Stock')
    : 'Stock';
  const activeArticleEpoch = IS_WEB_PTT_MODE
    ? parseInt(window.location.pathname.match(/^\/bbs\/[^/]+\/M\.(\d+)\.A\.[^.]+\.html$/i)?.[1] || '0', 10)
    : 0;

  let pushes = IS_WEB_PTT_MODE ? parsePushesFromDoc(document) : [];
  let isPlaying = false;
  let isLiveMode = true;
  let extensionEnabled = true;
  let crossTabShowEnabled = true;
  let booOnly = false;
  let keywords = [];
  let keywordFilterOnly = false;
  let currentBoardName = activeBoard || 'Stock';
  let currentQuery = '閒聊';
  let lastFetchedAt = 0;

  // ================= 2. 注入純淨透明 Shadow DOM 彈幕舞台 =================
  const existingHost = document.getElementById('ptt-danmaku-ext-host');
  if (existingHost) {
    existingHost.remove();
  }
  const host = document.createElement('div');
  host.id = 'ptt-danmaku-ext-host';
  host.style.cssText = 'position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; height: 0 !important; overflow: visible !important; pointer-events: none !important; z-index: 2147483647 !important;';
  (document.documentElement || document.body).appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      :host {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 0;
        overflow: visible;
        pointer-events: none;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang TC", "Microsoft JhengHei", sans-serif;
      }
      #danmaku-stage {
        position: fixed;
        top: 36px;
        left: 0;
        right: 0;
        height: 65vh;
        overflow: hidden;
        pointer-events: none;
      }
      .danmaku-item {
        position: absolute;
        left: 0;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
        font-size: 20px;
        font-weight: 700;
        text-shadow: 1px 1px 2px #000, -1px -1px 2px #000, 1px -1px 2px #000, -1px 1px 2px #000;
        will-change: transform;
        user-select: none;
        padding: 2px 8px;
        border-radius: 4px;
        pointer-events: none;
      }
      .danmaku-img {
        max-height: 168px;
        max-width: 320px;
        width: auto;
        height: auto;
        object-fit: contain;
        border-radius: 6px;
        border: 1px solid rgba(255, 255, 255, 0.35);
        background: rgba(0, 0, 0, 0.35);
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.65);
        vertical-align: middle;
        pointer-events: none;
      }
      .tag-push { color: #ffffff; }
      .tag-boo  { color: #ff5252; border: 1px solid rgba(255, 82, 82, 0.55); background: rgba(60, 0, 0, 0.45); }
      .tag-arrow { color: #dcdcdc; }
      .danmaku-highlight {
        color: #ffd700 !important;
        font-size: 23px;
        background: rgba(255, 193, 7, 0.25);
        border: 1.5px solid #ffd700;
        box-shadow: 0 0 12px rgba(255, 215, 0, 0.65);
        z-index: 10;
      }
      .time-prefix {
        font-size: 13px;
        font-family: monospace;
        opacity: 0.85;
        margin-right: 5px;
        color: #ffd54f;
      }
      .userid-prefix {
        font-size: 14px;
        opacity: 0.78;
        margin-right: 4px;
        color: #80cbc4;
      }
      #osd-toast {
        position: fixed;
        top: 18%;
        left: 50%;
        transform: translate(-50%, -50%) scale(0.92);
        background: rgba(15, 15, 20, 0.94);
        border: 1px solid rgba(255, 255, 255, 0.25);
        color: #fff;
        padding: 10px 22px;
        border-radius: 999px;
        font-size: 14px;
        font-weight: 700;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.7);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.18s ease, transform 0.18s ease;
        z-index: 60;
      }
      #osd-toast.show {
        opacity: 1;
        transform: translate(-50%, -50%) scale(1);
      }
    </style>

    <div id="danmaku-stage"></div>
    <div id="osd-toast"></div>
  `;

  const stage = shadow.getElementById('danmaku-stage');
  const osdToast = shadow.getElementById('osd-toast');

  let osdTimer = null;
  function showOsdToast(text) {
    osdToast.textContent = text;
    osdToast.classList.add('show');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => osdToast.classList.remove('show'), 2200);
  }

  function matchKeyword(push) {
    if (keywords.length === 0) return false;
    const target = `${push.userid} ${push.content}`.toLowerCase();
    return keywords.some((kw) => target.includes(kw));
  }

  // ================= 3. 彈幕渲染、圖片解析與分波佇列 =================
  const LANE_HEIGHT = 48;
  const MAX_LANES = Math.max(4, Math.floor((window.innerHeight * 0.55) / LANE_HEIGHT));
  const laneFreeAt = new Array(MAX_LANES).fill(0);

  let livePendingQueue = [];
  let liveBatchTimer = null;
  let activeWaveClearAt = 0;

  function clearLivePendingQueue() {
    livePendingQueue = [];
    clearTimeout(liveBatchTimer);
    liveBatchTimer = null;
    activeWaveClearAt = 0;
  }

  function shouldRenderDanmakuOnThisTab() {
    if (!extensionEnabled) return false;
    if (document.hidden) return false;
    if (IS_ANY_PTT_MODE) return true;
    return crossTabShowEnabled;
  }

  const IMAGE_URL_REGEX = /https?:\/\/[^\s"'<>]+\.(?:jpe?g|gif|png|webp)(?:\?[^\s"'<>]*)?(?:#[^\s"'<>]*)?/gi;

  function buildDanmakuContentNodes(rawContent) {
    const text = String(rawContent ?? '');
    const frag = document.createDocumentFragment();
    IMAGE_URL_REGEX.lastIndex = 0;

    let lastIdx = 0;
    let hasImage = false;
    let imageCount = 0;
    let match;

    while ((match = IMAGE_URL_REGEX.exec(text)) !== null) {
      const before = text.slice(lastIdx, match.index).trim();
      if (before) {
        const span = document.createElement('span');
        span.textContent = before;
        frag.appendChild(span);
      }

      const imgUrl = match[0];
      const img = document.createElement('img');
      img.className = 'danmaku-img';
      img.src = imgUrl;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.decoding = 'async';
      img.addEventListener('error', () => {
        const fallback = document.createElement('span');
        fallback.textContent = imgUrl;
        if (img.parentNode) {
          img.replaceWith(fallback);
        }
      });
      frag.appendChild(img);

      hasImage = true;
      imageCount++;
      lastIdx = match.index + imgUrl.length;
    }

    const tail = text.slice(lastIdx).trim();
    if (tail || !hasImage) {
      const span = document.createElement('span');
      span.textContent = hasImage ? tail : text;
      frag.appendChild(span);
    }

    return { fragment: frag, hasImage, imageCount };
  }

  function spawnDanmaku(push, isHighlighted = false, forceEmit = false) {
    if (!shouldRenderDanmakuOnThisTab()) return;
    if (booOnly && push.tag !== '噓') return;
    const isKw = isHighlighted || matchKeyword(push);
    if (keywords.length > 0 && keywordFilterOnly && !isKw) return;

    const { fragment, hasImage } = buildDanmakuContentNodes(push.content);

    const laneSpan = hasImage ? Math.min(4, MAX_LANES) : 1;
    const now = performance.now();
    let chosenLane = -1;
    for (let i = 0; i <= MAX_LANES - laneSpan; i++) {
      let spanFree = true;
      for (let k = 0; k < laneSpan; k++) {
        if (laneFreeAt[i + k] > now) {
          spanFree = false;
          break;
        }
      }
      if (spanFree) {
        chosenLane = i;
        break;
      }
    }
    if (chosenLane === -1) {
      let minTime = Infinity;
      for (let i = 0; i <= MAX_LANES - laneSpan; i++) {
        let spanMaxFree = 0;
        for (let k = 0; k < laneSpan; k++) {
          if (laneFreeAt[i + k] > spanMaxFree) {
            spanMaxFree = laneFreeAt[i + k];
          }
        }
        if (spanMaxFree < minTime) {
          minTime = spanMaxFree;
          chosenLane = i;
        }
      }
      if (!forceEmit && minTime - now > 1800) {
        return;
      }
    }

    const hhmm = extractPushHhMm(push);
    const timeBadge = hhmm ? `<span class="time-prefix">[${escapeHtml(hhmm)}]</span>` : '';

    const el = document.createElement('div');
    const baseClass = push.tag === '推' ? 'tag-push' : push.tag === '噓' ? 'tag-boo' : 'tag-arrow';
    el.className = `danmaku-item ${baseClass} ${isKw ? 'danmaku-highlight' : ''}`;
    el.innerHTML = `${timeBadge}<span class="userid-prefix">${escapeHtml(push.userid)}:</span>`;
    el.appendChild(fragment);
    el.style.top = `${chosenLane * LANE_HEIGHT}px`;
    stage.appendChild(el);

    let unloadedReserve = 0;
    if (hasImage) {
      el.querySelectorAll('img').forEach((imgEl) => {
        if (!imgEl.complete) unloadedReserve += 280;
      });
    }

    const stageWidth = window.innerWidth;
    const itemWidth = (el.offsetWidth || 200) + unloadedReserve;
    const baseDurationMs = flyDurationSeconds * 1000;
    const pxPerMs = (stageWidth + 240) / baseDurationMs;
    const totalDistance = stageWidth + itemWidth;
    const duration = Math.round(totalDistance / pxPerMs);

    let laneReadyAt = 0;
    for (let k = 0; k < laneSpan; k++) {
      if (laneFreeAt[chosenLane + k] > laneReadyAt) {
        laneReadyAt = laneFreeAt[chosenLane + k];
      }
    }
    const waitMs = Math.max(0, laneReadyAt - now);
    const startAt = now + waitMs;
    const clearTimeMs = Math.ceil((itemWidth + 140) / pxPerMs);
    const nextFreeAt = startAt + clearTimeMs;
    for (let k = 0; k < laneSpan; k++) {
      laneFreeAt[chosenLane + k] = nextFreeAt;
    }

    el.style.transform = `translate3d(${stageWidth}px, 0, 0)`;
    el.getBoundingClientRect();
    el.style.transition = `transform ${duration}ms linear ${Math.round(waitMs)}ms`;
    el.style.transform = `translate3d(-${itemWidth}px, 0, 0)`;

    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, Math.ceil(waitMs) + duration + 150);

    return nextFreeAt;
  }

  function pruneStaleQueueIfNeeded() {
    if (livePendingQueue.length === 0) return;
    const nowMinuteFloor = Math.floor(Date.now() / 60000) * 60000;
    const cutoffTs = nowMinuteFloor - INITIAL_PREVIEW_WINDOW_MINUTES * 60000;
    const firstTs = Number(livePendingQueue[0]?.timestamp) || 0;
    if (firstTs > 0 && firstTs < cutoffTs) {
      livePendingQueue = selectInitialPreviewPushes(
        livePendingQueue,
        maxBatchCount,
        INITIAL_PREVIEW_MAX_WAVES
      );
    }
  }

  function drainLivePendingQueue() {
    clearTimeout(liveBatchTimer);
    liveBatchTimer = null;

    if (
      !extensionEnabled ||
      isPlaying ||
      document.hidden ||
      !shouldRenderDanmakuOnThisTab() ||
      livePendingQueue.length === 0
    ) {
      return;
    }

    pruneStaleQueueIfNeeded();
    if (livePendingQueue.length === 0) return;

    const batch = livePendingQueue.splice(0, maxBatchCount);
    let waveClearAt = performance.now();
    batch.forEach((p) => {
      const freeAt = spawnDanmaku(p, matchKeyword(p), true);
      if (typeof freeAt === 'number' && freeAt > waveClearAt) {
        waveClearAt = freeAt;
      }
    });
    activeWaveClearAt = Math.max(activeWaveClearAt, waveClearAt);

    if (livePendingQueue.length > 0) {
      const nextWaveDelayMs = Math.max(300, Math.ceil(waveClearAt - performance.now()));
      liveBatchTimer = setTimeout(drainLivePendingQueue, nextWaveDelayMs);
    }
  }

  function enqueueLivePushes(pushesToEnqueue) {
    if (!extensionEnabled || isPlaying) return 0;
    if (!Array.isArray(pushesToEnqueue) || pushesToEnqueue.length === 0) return 0;

    livePendingQueue.push(...pushesToEnqueue);
    pruneStaleQueueIfNeeded();
    if (document.hidden) {
      const maxHiddenQueueLen = Math.max(15, maxBatchCount * 3);
      if (livePendingQueue.length > maxHiddenQueueLen) {
        livePendingQueue.splice(0, livePendingQueue.length - maxHiddenQueueLen);
      }
      return pushesToEnqueue.length;
    }
    if (!liveBatchTimer) {
      const waitForCurrentWaveMs = Math.ceil(activeWaveClearAt - performance.now());
      if (waitForCurrentWaveMs > 80) {
        liveBatchTimer = setTimeout(drainLivePendingQueue, waitForCurrentWaveMs);
      } else {
        drainLivePendingQueue();
      }
    }
    return pushesToEnqueue.length;
  }

  function selectInitialPreviewPushes(allPushes, batchSize = maxBatchCount, maxWaves = INITIAL_PREVIEW_MAX_WAVES) {
    if (!Array.isArray(allPushes) || allPushes.length === 0) return [];
    const n = normalizeMaxBatchCount(batchSize);
    const waves = Math.max(1, Math.round(Number(maxWaves) || INITIAL_PREVIEW_MAX_WAVES));
    const minCount = n;
    const maxCount = n * waves;
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

  function emitLivePushes(addedPushes, isNewArticle = false, options = {}) {
    if (!extensionEnabled || isPlaying) return;
    if (options.clearExistingQueue) {
      clearLivePendingQueue();
      stage.innerHTML = '';
      laneFreeAt.fill(0);
    }
    if (!Array.isArray(addedPushes) || addedPushes.length === 0) return;

    const listToEnqueue = isNewArticle
      ? selectInitialPreviewPushes(addedPushes, maxBatchCount, INITIAL_PREVIEW_MAX_WAVES)
      : addedPushes;
    if (options.toastText) {
      showOsdToast(options.toastText);
    } else if (isNewArticle) {
      showOsdToast(`📰 偵測到新文章，Live 顯示近期 ${listToEnqueue.length} 則推文（每波最多 ${maxBatchCount} 則）`);
    } else if (options.isCatchupTrimmed) {
      showOsdToast(`⏩ 已自動跳過過期舊推文，播放最近 5 分鐘推文（${listToEnqueue.length} 則）`);
    }
    enqueueLivePushes(listToEnqueue);
  }

  let lastCrossTabPreviewAt = 0;

  function previewRecentPushesOnCrossTab(maxWaves = INITIAL_PREVIEW_MAX_WAVES, minIntervalMs = 10000) {
    if (!extensionEnabled || !shouldRenderDanmakuOnThisTab() || isPlaying) return;
    if (!Array.isArray(pushes) || pushes.length === 0) return;
    const now = Date.now();
    if (now - lastCrossTabPreviewAt < minIntervalMs) return;
    lastCrossTabPreviewAt = now;

    const recent = selectInitialPreviewPushes(pushes, maxBatchCount, maxWaves);
    enqueueLivePushes(recent);
  }

  // ================= 4. 背景狀態同步與 PTT DOM 監聽 =================
  function applyStateFromBackground(state) {
    if (!state) return;

    if (typeof state.enabled === 'boolean') {
      extensionEnabled = state.enabled;
      if (!extensionEnabled) {
        clearLivePendingQueue();
        stage.innerHTML = '';
        laneFreeAt.fill(0);
      }
    }
    if (typeof state.crossTabShowEnabled === 'boolean') {
      crossTabShowEnabled = state.crossTabShowEnabled;
    }
    if (typeof state.booOnly === 'boolean') {
      booOnly = state.booOnly;
    }
    if (typeof state.keywordRaw === 'string') {
      const raw = state.keywordRaw.trim().toLowerCase();
      keywords = raw ? raw.split(/[\s,，、]+/).filter(Boolean) : [];
    }
    if (typeof state.keywordFilterOnly === 'boolean') {
      keywordFilterOnly = state.keywordFilterOnly;
    }

    if (typeof state.minFetchIntervalMs === 'number' && state.minFetchIntervalMs > 0) {
      minFetchIntervalSeconds = normalizeIntervalSeconds(Math.round(state.minFetchIntervalMs / 1000));
    }
    if (typeof state.flyDurationMs === 'number' && state.flyDurationMs > 0) {
      flyDurationSeconds = normalizeFlyDurationSeconds(Math.round(state.flyDurationMs / 1000));
    }
    if (typeof state.maxBatchCount === 'number' && state.maxBatchCount > 0) {
      maxBatchCount = normalizeMaxBatchCount(state.maxBatchCount);
    }

    if (typeof state.board === 'string' && state.board) {
      currentBoardName = state.board;
    }
    if (typeof state.query === 'string') {
      currentQuery = state.query;
    }
    if (typeof state.lastFetchedAt === 'number' && state.lastFetchedAt > 0) {
      lastFetchedAt = state.lastFetchedAt;
    }

    if (Array.isArray(state.pushes) && state.pushes.length > 0) {
      pushes = state.pushes.map((p) => ({
        ...p,
        node: IS_WEB_PTT_MODE ? document.querySelectorAll('.push')[p.index] || null : null
      }));
    }

    isPlaying = Boolean(state.isPlaying);
    isLiveMode = Boolean(state.isLiveMode);
  }

  let lastHandledBatchId = '';

  function handleBackgroundLoadResponse(loadRes) {
    if (!loadRes?.ok) return;
    if (loadRes.state) {
      applyStateFromBackground(loadRes.state);
    }
    if (Array.isArray(loadRes.newlyAddedPushes) && loadRes.newlyAddedPushes.length > 0) {
      if (loadRes.batchId && loadRes.batchId === lastHandledBatchId) return;
      if (loadRes.batchId) lastHandledBatchId = loadRes.batchId;
      emitLivePushes(loadRes.newlyAddedPushes, Boolean(loadRes.isNewArticle), {
        clearExistingQueue: Boolean(loadRes.clearExistingQueue),
        isCatchupTrimmed: Boolean(loadRes.isCatchupTrimmed),
        toastText: loadRes.toastText || ''
      });
    }
  }

  function handleRuntimeMessage(msg) {
    if (!msg || !msg.type) return;

    if (msg.type === 'DANMAKU_QUEUE_CLEARED') {
      clearLivePendingQueue();
      stage.innerHTML = '';
      laneFreeAt.fill(0);
      pushes = [];
      isPlaying = false;
      isLiveMode = false;
      showOsdToast('🧹 已清空彈幕佇列與舊資料');
    } else if (msg.type === 'DANMAKU_ENABLED_CHANGED') {
      const prevEnabled = extensionEnabled;
      applyStateFromBackground(msg.state);
      if (prevEnabled !== Boolean(msg.enabled)) {
        showOsdToast(msg.enabled ? '🔌 PTT 彈幕套件已啟用' : '⏹ PTT 彈幕套件已停用');
      }
    } else if (msg.type === 'DANMAKU_STATE_UPDATED') {
      if (msg.clearStage) {
        clearLivePendingQueue();
        stage.innerHTML = '';
        laneFreeAt.fill(0);
      }
      applyStateFromBackground(msg.state);
    } else if (msg.type === 'DANMAKU_TICK') {
      if (!extensionEnabled) return;
      isPlaying = Boolean(msg.isPlaying);
      if (Array.isArray(msg.duePushes) && msg.duePushes.length > 0) {
        let spawnedInBatch = 0;
        for (const p of msg.duePushes) {
          const isKw = matchKeyword(p);
          if (isKw || spawnedInBatch < maxBatchCount) {
            spawnDanmaku(p, isKw, false);
            spawnedInBatch++;
          }
        }
      }
    } else if (msg.type === 'DANMAKU_LIVE_NEW_PUSHES') {
      if (!extensionEnabled) return;
      applyStateFromBackground(msg.state);
      if (msg.batchId && msg.batchId === lastHandledBatchId) return;
      if (msg.batchId) lastHandledBatchId = msg.batchId;
      emitLivePushes(msg.addedPushes, Boolean(msg.isNewArticle), {
        clearExistingQueue: Boolean(msg.clearExistingQueue),
        isCatchupTrimmed: Boolean(msg.isCatchupTrimmed),
        toastText: msg.toastText || ''
      });
    }
  }
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  let handleWindowKeydown = null;
  if (IS_WEB_PTT_MODE) {
    handleWindowKeydown = (e) => {
      if (!extensionEnabled) return;
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      const isEditable = [e.target, document.activeElement, ...path].some((el) => {
        if (!el || typeof el !== 'object') return false;
        const tag = String(el.tagName || '').toUpperCase();
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(el.isContentEditable);
      });
      if (isEditable) return;

      if (e.code === 'Space') {
        e.preventDefault();
        sendBgMessage({ type: 'CONTROL_DANMAKU', action: 'TOGGLE_PLAY' }).then((res) => {
          if (res?.ok && res.state) {
            applyStateFromBackground(res.state);
            showOsdToast(res.state.isPlaying ? '▶ 繼續播放彈幕' : '⏸ 彈幕已暫停');
          }
        });
      } else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
        e.preventDefault();
        const sign = e.code === 'ArrowRight' ? 1 : -1;
        const deltaMinutes = sign * (e.shiftKey ? 5 : 1);
        clearLivePendingQueue();
        stage.innerHTML = '';
        laneFreeAt.fill(0);
        sendBgMessage({ type: 'CONTROL_DANMAKU', action: 'JUMP_MINUTES', deltaMinutes }).then((res) => {
          if (res?.ok && res.state) {
            applyStateFromBackground(res.state);
            const label = deltaMinutes > 0 ? `+${deltaMinutes}` : `${deltaMinutes}`;
            showOsdToast(`${deltaMinutes > 0 ? '⏩' : '⏪'} ${label} 分鐘 (${formatDateTime(res.state.currentVirtualTime)})`);
          }
        });
      }
    };
    window.addEventListener('keydown', handleWindowKeydown);
  }

  function extractDomPollingConfig() {
    if (!IS_WEB_PTT_MODE) return null;
    const pollDiv = document.getElementById('article-polling');
    if (!pollDiv) return null;
    const pollUrl = pollDiv.getAttribute('data-pollurl') || '';
    const longPollUrl = pollDiv.getAttribute('data-longpollurl') || '';
    const currSize = parseInt(pollDiv.getAttribute('data-offset') || '0', 10);
    if (!pollUrl || !longPollUrl) return null;
    const cacheKeyMatch = pollUrl.match(/[?&]cacheKey=([^&]+)/i);
    return {
      pollUrl,
      longPollUrl,
      currSize: Number.isFinite(currSize) ? currSize : 0,
      cacheKey: cacheKeyMatch ? decodeURIComponent(cacheKeyMatch[1]) : ''
    };
  }

  // 建立 MV3 背景 Service Worker 保活長連線（斷線自動重連），並於可見分頁主動驅動間隔追文
  let keepAlivePort = null;
  let keepAliveTimer = null;
  let livePollTimer = null;
  let tabPollInFlight = false;
  let initDone = false;

  function ensureBackgroundKeepAlive() {
    if (!chrome?.runtime?.id || keepAlivePort) return;
    try {
      keepAlivePort = chrome.runtime.connect({ name: 'ptt-danmaku-keepalive' });
      keepAlivePort.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        keepAlivePort = null;
      });
    } catch (_) {
      keepAlivePort = null;
    }
  }
  ensureBackgroundKeepAlive();

  keepAliveTimer = setInterval(() => {
    if (!extensionEnabled || document.hidden) return;
    if (!keepAlivePort) {
      ensureBackgroundKeepAlive();
    }
    if (keepAlivePort) {
      try {
        keepAlivePort.postMessage({ type: 'PING' });
      } catch (_) {
        keepAlivePort = null;
      }
    }
  }, 15000);

  livePollTimer = setInterval(() => {
    if (
      !initDone ||
      document.hidden ||
      !extensionEnabled ||
      !isLiveMode ||
      isPlaying ||
      !shouldRenderDanmakuOnThisTab() ||
      tabPollInFlight
    ) {
      return;
    }
    const intervalMs = minFetchIntervalSeconds * 1000;
    if (lastFetchedAt > 0 && Date.now() - lastFetchedAt < intervalMs) {
      return;
    }
    tabPollInFlight = true;
    sendBgMessage({
      type: 'BACKGROUND_LOAD_STOCK',
      board: currentBoardName || 'Stock',
      query: currentQuery ?? '閒聊',
      enableLive: true,
      force: false
    })
      .then(handleBackgroundLoadResponse)
      .catch(() => {})
      .finally(() => {
        tabPollInFlight = false;
      });
  }, 1000);

  async function syncDomPushesToBackground() {
    if (!extensionEnabled || !IS_WEB_PTT_MODE) return null;
    const latestDomPushes = parsePushesFromDoc(document);
    if (latestDomPushes.length === 0) return null;

    const setRes = await sendBgMessage({
      type: 'SET_ARTICLE_PUSHES',
      pushes: latestDomPushes.map((p) => ({
        index: p.index,
        floor: p.floor,
        tag: p.tag,
        userid: p.userid,
        content: p.content,
        timestamp: p.timestamp,
        virtualTime: p.virtualTime,
        hhmm: p.hhmm,
        timeStr: p.timeStr
      })),
      pollingConfig: extractDomPollingConfig(),
      articleTitle: document.title || '',
      articleUrl: activeArticleUrl || '',
      board: activeBoard || 'Stock',
      articleEpoch: activeArticleEpoch || 0
    });

    if (setRes?.ok && setRes.state) {
      applyStateFromBackground(setRes.state);
    }
    return setRes;
  }

  let mainContentObserver = null;
  let domSyncTimer = null;
  if (IS_WEB_PTT_MODE) {
    const mainContent = document.getElementById('main-content');
    if (mainContent) {
      mainContentObserver = new MutationObserver((mutations) => {
        if (!extensionEnabled) return;
        const hasNewPush = mutations.some((m) =>
          Array.from(m.addedNodes).some(
            (n) =>
              n.nodeType === 1 &&
              (n.classList?.contains('push') ||
                n.classList?.contains('new-push') ||
                n.querySelector?.('.push'))
          )
        );
        if (hasNewPush) {
          clearTimeout(domSyncTimer);
          domSyncTimer = setTimeout(() => {
            syncDomPushesToBackground().catch(() => {});
          }, 300);
        }
      });
      mainContentObserver.observe(mainContent, { childList: true, subtree: true });
    }
  }

  async function handleVisibilityChange() {
    if (document.hidden || !extensionEnabled) return;
    ensureBackgroundKeepAlive();
    try {
      const stateRes = await sendBgMessage({ type: 'GET_DANMAKU_STATE' });
      if (stateRes?.ok && stateRes.state) {
        applyStateFromBackground(stateRes.state);
      }
      if (livePendingQueue.length > 0 && shouldRenderDanmakuOnThisTab() && !isPlaying) {
        drainLivePendingQueue();
      }
      if (shouldRenderDanmakuOnThisTab()) {
        if (Date.now() - lastFetchedAt >= minFetchIntervalSeconds * 1000) {
          sendBgMessage({
            type: 'BACKGROUND_LOAD_STOCK',
            board: currentBoardName || 'Stock',
            query: currentQuery ?? '閒聊',
            enableLive: true,
            force: false
          })
            .then(handleBackgroundLoadResponse)
            .catch(() => {});
        }
        if (stage.children.length === 0 && livePendingQueue.length === 0 && pushes.length > 0) {
          previewRecentPushesOnCrossTab(1, 15000);
        }
      }
    } catch (_) {}
  }
  document.addEventListener('visibilitychange', handleVisibilityChange);

  window.__pttDanmakuCleanup = () => {
    clearLivePendingQueue();
    clearInterval(keepAliveTimer);
    clearInterval(livePollTimer);
    clearTimeout(osdTimer);
    clearTimeout(domSyncTimer);
    if (mainContentObserver) {
      mainContentObserver.disconnect();
      mainContentObserver = null;
    }
    if (handleWindowKeydown) {
      window.removeEventListener('keydown', handleWindowKeydown);
    }
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    try {
      chrome?.runtime?.onMessage?.removeListener(handleRuntimeMessage);
    } catch (_) {}
    if (keepAlivePort) {
      try {
        keepAlivePort.disconnect();
      } catch (_) {}
      keepAlivePort = null;
    }
    if (host.parentNode) {
      host.parentNode.removeChild(host);
    }
  };

  (async function init() {
    try {
      const res = await sendBgMessage({ type: 'GET_DANMAKU_STATE' });
      if (res?.ok && res.state) {
        applyStateFromBackground(res.state);
      }

      if (extensionEnabled && IS_WEB_PTT_MODE && pushes.length > 0) {
        await syncDomPushesToBackground();
        if (autoLiveOnLoad || !isPlaying) {
          await sendBgMessage({ type: 'CONTROL_DANMAKU', action: 'SET_LIVE', enabled: true })
            .then((liveRes) => {
              if (liveRes?.ok && liveRes.state) applyStateFromBackground(liveRes.state);
            })
            .catch(() => {});
          if (autoLiveOnLoad) {
            showOsdToast('📡 已自動切換至最新閒聊文並啟動 Live 追文！');
          }
        }
        if (stage.children.length === 0 && livePendingQueue.length === 0) {
          previewRecentPushesOnCrossTab(INITIAL_PREVIEW_MAX_WAVES, 0);
        }
      } else if (extensionEnabled && shouldRenderDanmakuOnThisTab()) {
        try {
          const loadRes = await sendBgMessage({
            type: 'BACKGROUND_LOAD_STOCK',
            board: currentBoardName || 'Stock',
            query: currentQuery ?? '閒聊',
            enableLive: true,
            force: false
          });
          handleBackgroundLoadResponse(loadRes);
        } catch (_) {}
        if (stage.children.length === 0 && livePendingQueue.length === 0 && pushes.length > 0) {
          previewRecentPushesOnCrossTab(INITIAL_PREVIEW_MAX_WAVES, 0);
        }
      }
    } catch (err) {
      console.warn('[PTT 彈幕] 初始化同步失敗:', err);
    } finally {
      initDone = true;
    }
  })();
})();
