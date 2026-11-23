// popup.js - 套件工具列彈出控制面板，與 background.js 狀態即時同步
(function () {
  'use strict';

  const ALLOWED_MIN_INTERVAL_SECONDS = [3, 5, 10, 15, 30, 60, 120, 180, 300];
  const DEFAULT_MIN_INTERVAL_SECONDS = 30;
  const ALLOWED_FLY_DURATION_SECONDS = [5, 7, 10, 14, 18];
  const DEFAULT_FLY_DURATION_SECONDS = 10;
  const ALLOWED_MAX_BATCH_COUNTS = [3, 5, 10, 15, 20, 30, 50];
  const DEFAULT_MAX_BATCH_COUNT = 10;

  const btnExtPower = document.getElementById('btn-ext-power');
  const popupToast = document.getElementById('popup-toast');
  const articleBoardBadge = document.getElementById('article-board-badge');
  const articleTitleText = document.getElementById('article-title-text');
  const articleShortId = document.getElementById('article-short-id');
  const articleRuleBadge = document.getElementById('article-rule-badge');
  const articlePushCount = document.getElementById('article-push-count');
  const articleFetchedTime = document.getElementById('article-fetched-time');
  const articleFetchInterval = document.getElementById('article-fetch-interval');
  const articleOpenLink = document.getElementById('article-open-link');

  const boardNavRow = document.getElementById('board-nav-row');
  const cfgBoardInput = document.getElementById('cfg-board');
  const cfgQueryInput = document.getElementById('cfg-query');
  const btnBoardHelp = document.getElementById('btn-board-help');
  const boardHelpPopover = document.getElementById('board-help-popover');
  const btnCloseBoardHelp = document.getElementById('btn-close-board-help');
  const helpCandidatesList = document.getElementById('help-candidates-list');
  const btnBgFetchStock = document.getElementById('btn-bg-fetch-stock');
  const btnForceFetch = document.getElementById('btn-force-fetch');

  const scrubberWrapper = document.getElementById('scrubber-wrapper');
  const tooltip = document.getElementById('hover-tooltip');
  const peakMarkersLayer = document.getElementById('peak-markers-layer');
  const heatmapSvg = document.getElementById('heatmap-svg');
  const slider = document.getElementById('timeline-slider');

  const btnPlay = document.getElementById('btn-play');
  const btnRecent5m = document.getElementById('btn-recent-5m');
  const btnLive = document.getElementById('btn-live');
  const btnCrossTab = document.getElementById('btn-cross-tab');
  const btnBooOnly = document.getElementById('btn-boo-only');

  const speedSelect = document.getElementById('speed-select');
  const flyDurationSelect = document.getElementById('fly-duration-select');
  const minIntervalSelect = document.getElementById('min-interval-select');
  const maxBatchSelect = document.getElementById('max-batch-select');

  const keywordInput = document.getElementById('keyword-input');
  const btnKwMode = document.getElementById('btn-kw-mode');

  const statPushEl = document.getElementById('stat-push');
  const statArrEl = document.getElementById('stat-arr');
  const statBooEl = document.getElementById('stat-boo');
  const barPushEl = document.getElementById('bar-push');
  const barArrEl = document.getElementById('bar-arr');
  const barBooEl = document.getElementById('bar-boo');
  const timeDisplay = document.getElementById('time-display');

  let pushes = [];
  let startTime = 0;
  let endTime = 60000;
  let totalDuration = 60000;
  let currentVirtualTime = 0;
  let nextPushIndex = 0;
  let isPlaying = false;
  let isLiveMode = true;
  let extensionEnabled = true;
  let crossTabShowEnabled = true;
  let booOnly = false;
  let keywordFilterOnly = false;
  let keywords = [];
  let minFetchIntervalSeconds = DEFAULT_MIN_INTERVAL_SECONDS;
  let currentBoardName = 'Stock';
  let currentArticleTitle = '';
  let currentArticleUrl = '';
  let lastFetchedAt = 0;
  let lastDebugInfo = null;
  let isDragging = false;
  const DEFAULT_BOARD_INPUT_TITLE =
    '輸入 PTT 看板英文名稱（不分大小寫，按 Enter 可直接抓文）\n' +
    '常用看板：Stock (股板)、Gossiping (八卦)、Baseball (棒球)、NBA、C_Chat (希洽)、Lifeismoney (省錢)、Tech_Job (科技)';
  const DEFAULT_QUERY_INPUT_TITLE =
    '輸入想鎖定的文章標題關鍵字（按 Enter 可直接抓文）\n' +
    '• 填寫關鍵字（如：閒聊、LIVE、盤中、炸裂）：自動鎖定該板最新符合標題的文章\n' +
    '• 留空不填：直接抓取該看板最新發表的一篇文章';

  let toastTimer = null;
  let kwSyncTimer = null;
  let boardQueryEdited = false;
  let isHelpPinned = false;
  let helpHideTimer = null;

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

  function showToast(text) {
    popupToast.textContent = text;
    popupToast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      popupToast.classList.remove('show');
    }, 2400);
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

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

  function extractShortId(urlStr) {
    if (!urlStr) return '';
    const m = String(urlStr).match(/\/(M\.\d+\.A\.[^./]+\.html)/i);
    return m ? m[1] : '';
  }

  function formatHhMmFromTs(ts) {
    if (!Number.isFinite(ts) || ts <= 0) return '';
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function formatHhMmSsFromTs(ts) {
    if (!Number.isFinite(ts) || ts <= 0) return '--:--:--';
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
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

  function parseKeywords(rawStr) {
    const raw = String(rawStr || '').trim().toLowerCase();
    return raw ? raw.split(/[\s,，、]+/).filter(Boolean) : [];
  }

  function matchKeyword(push) {
    if (keywords.length === 0) return false;
    const target = `${push.userid} ${push.content}`.toLowerCase();
    return keywords.some((kw) => target.includes(kw));
  }

  function extractCandidateTitle(previewItem) {
    return String(previewItem || '')
      .replace(/^M\.\d+\.A\.[^\s]+\s+/i, '')
      .trim();
  }

  function renderHelpCandidates(candidates) {
    if (!helpCandidatesList) return;
    helpCandidatesList.innerHTML = '';
    if (!Array.isArray(candidates) || candidates.length === 0) {
      const emptyEl = document.createElement('span');
      emptyEl.className = 'help-empty';
      emptyEl.textContent = '目前尚無候選文章列表，請先按「背景抓文」或「立即重抓」';
      helpCandidatesList.appendChild(emptyEl);
      return;
    }

    candidates.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'candidate-item';
      btn.textContent = item;
      const cleanTitle = extractCandidateTitle(item);
      btn.title = cleanTitle ? `點擊以鎖定文章：${cleanTitle}` : item;
      btn.addEventListener('click', () => {
        cfgBoardInput.value = currentBoardName || cfgBoardInput.value.trim() || 'Stock';
        cfgQueryInput.value = cleanTitle || item;
        boardQueryEdited = true;
        closeBoardHelpPopover(true);
        triggerFetch(true);
      });
      helpCandidatesList.appendChild(btn);
    });
  }

  function updateInputTooltips(candidates) {
    const boardLabel = currentBoardName || cfgBoardInput.value.trim() || 'Stock';
    cfgBoardInput.title = `目前監控看板：${boardLabel}\n${DEFAULT_BOARD_INPUT_TITLE}`;
    const previewSuffix =
      Array.isArray(candidates) && candidates.length > 0
        ? `\n\n${boardLabel} 板最新候選文章：\n- ${candidates.join('\n- ')}`
        : '';
    cfgQueryInput.title = `${DEFAULT_QUERY_INPUT_TITLE}${previewSuffix}`;
  }

  function updateBannerUI() {
    const candidates = lastDebugInfo?.candidatesPreview;
    updateInputTooltips(candidates);
    renderHelpCandidates(candidates);

    articleBoardBadge.textContent = currentBoardName || 'Stock';
    if (!extensionEnabled) {
      articleTitleText.textContent = '套件已停用';
      articleShortId.textContent = '';
      articleRuleBadge.textContent = '';
      articlePushCount.textContent = '推文數：0 則';
      articleFetchedTime.textContent = '更新: --:--:--';
      articleFetchInterval.textContent = '間隔: --';
      articleOpenLink.style.display = 'none';
      return;
    }

    const titleDisplay = currentArticleTitle
      ? currentArticleTitle.replace(/\s*-\s*看板\s*[^-\s]+\s*-\s*批踢踢實業坊$/i, '').trim()
      : (pushes.length > 0 ? '目前文章' : '背景抓取中...');

    articleTitleText.textContent = titleDisplay || '未命名文章';
    const previewList = Array.isArray(candidates)
      ? `\n看板最新候選：\n- ${candidates.join('\n- ')}`
      : '';
    articleTitleText.title = `${currentArticleTitle || titleDisplay}\n實際抓取網址：${currentArticleUrl || '無'}${previewList}`;

    const shortId = lastDebugInfo?.resolvedShortId || extractShortId(currentArticleUrl);
    articleShortId.textContent = shortId ? `[${shortId}]` : '';
    articleShortId.title = currentArticleUrl || '';

    if (lastDebugInfo?.matchedRule) {
      const rawInfo = typeof lastDebugInfo.rawDivCount === 'number' ? ` raw:${lastDebugInfo.rawDivCount}` : '';
      const deltaInfo =
        typeof lastDebugInfo.deltaTotalCount === 'number' && lastDebugInfo.deltaTotalCount > 0
          ? ` (+即時增量:${lastDebugInfo.deltaTotalCount})`
          : '';
      articleRuleBadge.textContent = `[${lastDebugInfo.matchedRule}${rawInfo}${deltaInfo}]`;
      articleRuleBadge.title = `比對規則：${lastDebugInfo.matchedRule}，模式：${lastDebugInfo.pollMode || 'auto'}`;
    } else {
      articleRuleBadge.textContent = '';
    }

    articlePushCount.textContent = `推文數：${pushes.length} 則`;
    articleFetchedTime.textContent = `更新: ${formatHhMmSsFromTs(lastFetchedAt)}`;
    articleFetchInterval.textContent = isLiveMode
      ? `間隔: ${minFetchIntervalSeconds}s`
      : `間隔: ${minFetchIntervalSeconds}s (Live關)`;

    if (currentArticleUrl && /^https?:\/\//i.test(currentArticleUrl)) {
      articleOpenLink.href = currentArticleUrl;
      articleOpenLink.style.display = 'inline';
    } else {
      articleOpenLink.style.display = 'none';
    }
  }

  function updateButtonsUI() {
    btnExtPower.textContent = extensionEnabled ? '🔌 套件: 已啟用' : '🔌 套件: 已停用';
    btnExtPower.classList.toggle('active', extensionEnabled);
    btnExtPower.classList.toggle('off-state', !extensionEnabled);

    if (isPlaying) {
      btnPlay.textContent = '⏸ 暫停';
      btnPlay.classList.add('active');
    } else if (currentVirtualTime >= endTime && pushes.length > 0) {
      btnPlay.textContent = '▶ 重播';
      btnPlay.classList.remove('active');
    } else {
      btnPlay.textContent = '▶ 播放';
      btnPlay.classList.remove('active');
    }

    if (isLiveMode) {
      btnLive.textContent = '📡 Live 追文: 開';
      btnLive.classList.add('live-active');
    } else {
      btnLive.textContent = '📡 Live 追文: 關';
      btnLive.classList.remove('live-active');
    }

    btnCrossTab.textContent = crossTabShowEnabled ? '🌐 跨分頁彈幕: 開' : '🌐 跨分頁彈幕: 關';
    btnCrossTab.classList.toggle('active', crossTabShowEnabled);

    btnBooOnly.classList.toggle('active', booOnly);

    btnKwMode.textContent = keywordFilterOnly ? '模式: 僅顯示' : '模式: 高亮';
    btnKwMode.classList.toggle('filter-mode', keywordFilterOnly);
  }

  function updateSentimentStats() {
    let pushCnt = 0, booCnt = 0, arrCnt = 0;
    pushes.forEach((p) => {
      if (p.tag === '推') pushCnt++;
      else if (p.tag === '噓') booCnt++;
      else arrCnt++;
    });
    const total = Math.max(1, pushes.length);
    const pushPct = pushes.length === 0 ? '0.0' : ((pushCnt / total) * 100).toFixed(1);
    const arrPct = pushes.length === 0 ? '0.0' : ((arrCnt / total) * 100).toFixed(1);
    const booPct = pushes.length === 0 ? '0.0' : ((booCnt / total) * 100).toFixed(1);

    statPushEl.textContent = `推 ${pushCnt} (${pushPct}%)`;
    statArrEl.textContent = `→ ${arrCnt} (${arrPct}%)`;
    statBooEl.textContent = `噓 ${booCnt} (${booPct}%)`;

    barPushEl.style.width = pushes.length === 0 ? '33.3%' : `${pushPct}%`;
    barArrEl.style.width = pushes.length === 0 ? '33.3%' : `${arrPct}%`;
    barBooEl.style.width = pushes.length === 0 ? '33.3%' : `${booPct}%`;
  }

  function updateTimeDisplay(idx) {
    if (!extensionEnabled) {
      timeDisplay.textContent = '套件已停用';
      return;
    }
    if (pushes.length === 0) {
      timeDisplay.textContent = '背景正在讀取推文...';
      return;
    }
    const safeIdx = Math.min(pushes.length - 1, Math.max(0, idx));
    const p = pushes[safeIdx];
    const pushHhMm = extractPushHhMm(p);
    const pushTimePart = pushHhMm ? ` | 推文 ${pushHhMm}` : '';
    const liveTag = isLiveMode ? ' | LIVE' : '';
    timeDisplay.textContent = `${formatDateTime(currentVirtualTime)}${pushTimePart} | ${p.floor}/${pushes.length}${liveTag}`;
  }

  function renderHeatmapAndPeaks() {
    if (pushes.length === 0) {
      heatmapSvg.innerHTML = '';
      peakMarkersLayer.innerHTML = '';
      return;
    }

    const bucketsCount = 100;
    const buckets = new Array(bucketsCount).fill(0);
    const bucketFirstPush = new Array(bucketsCount).fill(null);
    const kwBuckets = new Array(bucketsCount).fill(0);

    pushes.forEach((p) => {
      const ratio = Math.min(0.999, Math.max(0, (p.virtualTime - startTime) / totalDuration));
      const idx = Math.floor(ratio * bucketsCount);
      buckets[idx]++;
      if (!bucketFirstPush[idx]) bucketFirstPush[idx] = p;
      if (keywords.length > 0 && matchKeyword(p)) kwBuckets[idx]++;
    });

    const maxCount = Math.max(...buckets, 1);
    let points = `0,30 `;
    buckets.forEach((count, i) => {
      const x = (i / (bucketsCount - 1)) * 100;
      const y = 30 - (count / maxCount) * 25;
      points += `${x.toFixed(2)},${y.toFixed(2)} `;
    });
    points += `100,30`;

    let kwSvgLayer = '';
    if (keywords.length > 0) {
      const maxKw = Math.max(...kwBuckets, 1);
      let kwPoints = `0,30 `;
      kwBuckets.forEach((count, i) => {
        const x = (i / (bucketsCount - 1)) * 100;
        const y = 30 - (count / maxKw) * 25;
        kwPoints += `${x.toFixed(2)},${y.toFixed(2)} `;
      });
      kwPoints += `100,30`;
      kwSvgLayer = `<polygon points="${kwPoints}" fill="rgba(255, 215, 0, 0.45)" stroke="#ffd700" stroke-width="0.8" />`;
    }

    heatmapSvg.setAttribute('viewBox', '0 0 100 30');
    heatmapSvg.innerHTML = `
      <polygon points="${points}" fill="rgba(0, 230, 118, 0.25)" stroke="#00e676" stroke-width="0.6" />
      ${kwSvgLayer}
    `;

    const mean = buckets.reduce((a, b) => a + b, 0) / bucketsCount;
    const std = Math.sqrt(buckets.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / bucketsCount);
    const threshold = Math.max(3, mean + std * 1.1);

    const candidatePeaks = [];
    for (let i = 1; i < bucketsCount - 1; i++) {
      const val = buckets[i];
      if (val >= threshold && val >= buckets[i - 1] && val > buckets[i + 1]) {
        candidatePeaks.push({ bucketIdx: i, count: val, push: bucketFirstPush[i] });
      }
    }

    candidatePeaks.sort((a, b) => b.count - a.count);
    const selectedPeaks = [];
    for (const peak of candidatePeaks) {
      if (selectedPeaks.length >= 6) break;
      const tooClose = selectedPeaks.some((sel) => Math.abs(sel.bucketIdx - peak.bucketIdx) < 8);
      if (!tooClose && peak.push) selectedPeaks.push(peak);
    }

    peakMarkersLayer.innerHTML = '';
    selectedPeaks.forEach((peak) => {
      const pct = (peak.bucketIdx / (bucketsCount - 1)) * 100;
      const clampedPct = Math.min(94, Math.max(6, pct));
      const timeLabel = extractPushHhMm(peak.push);
      const flag = document.createElement('div');
      flag.className = 'peak-flag';
      flag.style.left = `${clampedPct}%`;
      flag.textContent = `🔥${timeLabel}`;
      flag.title = `爆量尖峰 (${peak.push.timeStr}) - 密集推文 ${peak.count} 則`;

      flag.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!extensionEnabled) return;
        sendBgMessage({
          type: 'CONTROL_DANMAKU',
          action: 'SEEK_RATIO',
          ratio: peak.bucketIdx / (bucketsCount - 1)
        }).then((res) => {
          if (res?.ok && res.state) applyState(res.state);
        });
        showToast(`🔥 空降尖峰 ${timeLabel}`);
      });

      peakMarkersLayer.appendChild(flag);
    });
  }

  function applyState(state) {
    if (!state) return;

    if (typeof state.enabled === 'boolean') extensionEnabled = state.enabled;
    if (typeof state.isPlaying === 'boolean') isPlaying = state.isPlaying;
    if (typeof state.isLiveMode === 'boolean') isLiveMode = state.isLiveMode;
    if (typeof state.crossTabShowEnabled === 'boolean') crossTabShowEnabled = state.crossTabShowEnabled;
    if (typeof state.booOnly === 'boolean') booOnly = state.booOnly;
    if (typeof state.keywordFilterOnly === 'boolean') keywordFilterOnly = state.keywordFilterOnly;

    if (typeof state.keywordRaw === 'string' && document.activeElement !== keywordInput) {
      keywordInput.value = state.keywordRaw;
      keywords = parseKeywords(state.keywordRaw);
    }

    if (typeof state.minFetchIntervalMs === 'number' && state.minFetchIntervalMs > 0) {
      minFetchIntervalSeconds = normalizeIntervalSeconds(Math.round(state.minFetchIntervalMs / 1000));
      minIntervalSelect.value = String(minFetchIntervalSeconds);
    }
    if (typeof state.flyDurationMs === 'number' && state.flyDurationMs > 0) {
      const flySec = normalizeFlyDurationSeconds(Math.round(state.flyDurationMs / 1000));
      flyDurationSelect.value = String(flySec);
    }
    if (typeof state.maxBatchCount === 'number' && state.maxBatchCount > 0) {
      maxBatchSelect.value = String(normalizeMaxBatchCount(state.maxBatchCount));
    }
    if (state.speedMsPerSec) {
      const exists = Array.from(speedSelect.options).some(
        (opt) => parseInt(opt.value, 10) === state.speedMsPerSec
      );
      if (exists) speedSelect.value = String(state.speedMsPerSec);
    }

    if (typeof state.board === 'string' && state.board) {
      currentBoardName = state.board;
      if (!boardQueryEdited && document.activeElement !== cfgBoardInput) {
        cfgBoardInput.value = state.board;
      }
    }
    if (typeof state.query === 'string' && !boardQueryEdited && document.activeElement !== cfgQueryInput) {
      cfgQueryInput.value = state.query;
    }
    if (typeof state.articleTitle === 'string') currentArticleTitle = state.articleTitle;
    if (typeof state.articleUrl === 'string') currentArticleUrl = state.articleUrl;
    if (typeof state.lastFetchedAt === 'number' && state.lastFetchedAt > 0) lastFetchedAt = state.lastFetchedAt;
    if (state.lastDebugInfo) lastDebugInfo = state.lastDebugInfo;

    if (Array.isArray(state.pushes)) {
      const prevLen = pushes.length;
      const prevLast = prevLen > 0 ? pushes[prevLen - 1] : null;
      const nextLast = state.pushes.length > 0 ? state.pushes[state.pushes.length - 1] : null;
      const changed =
        state.pushes.length !== prevLen ||
        (prevLast?.content !== nextLast?.content) ||
        (prevLast?.timeStr !== nextLast?.timeStr);

      pushes = state.pushes;
      startTime = state.startTime || (pushes[0]?.virtualTime ?? Date.now());
      endTime = state.endTime || (pushes.length > 0 ? pushes[pushes.length - 1].virtualTime + 5000 : startTime + 60000);
      totalDuration = Math.max(endTime - startTime, 60000);

      if (changed) {
        updateSentimentStats();
        renderHeatmapAndPeaks();
      }
    }

    currentVirtualTime = state.currentVirtualTime ?? startTime;
    nextPushIndex = state.nextPushIndex ?? 0;

    if (!isDragging && pushes.length > 0) {
      slider.value = Math.round(
        Math.min(1, Math.max(0, (currentVirtualTime - startTime) / totalDuration)) * 1000
      );
    }

    updateBannerUI();
    updateButtonsUI();
    updateTimeDisplay(nextPushIndex);
  }

  function openBoardHelpPopover() {
    clearTimeout(helpHideTimer);
    if (!boardHelpPopover) return;
    boardHelpPopover.classList.add('board-help-visible');
    if (btnBoardHelp) btnBoardHelp.classList.add('active-help');
  }

  function closeBoardHelpPopover(unpin = false) {
    clearTimeout(helpHideTimer);
    if (unpin) isHelpPinned = false;
    if (!boardHelpPopover) return;
    boardHelpPopover.classList.remove('board-help-visible');
    if (btnBoardHelp) btnBoardHelp.classList.remove('active-help');
  }

  function scheduleCloseBoardHelpPopover() {
    if (isHelpPinned) return;
    clearTimeout(helpHideTimer);
    helpHideTimer = setTimeout(() => {
      if (!isHelpPinned) closeBoardHelpPopover(false);
    }, 180);
  }

  if (btnBoardHelp && boardHelpPopover) {
    btnBoardHelp.addEventListener('mouseenter', openBoardHelpPopover);
    btnBoardHelp.addEventListener('mouseleave', scheduleCloseBoardHelpPopover);
    boardHelpPopover.addEventListener('mouseenter', openBoardHelpPopover);
    boardHelpPopover.addEventListener('mouseleave', scheduleCloseBoardHelpPopover);

    btnBoardHelp.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !isHelpPinned || !boardHelpPopover.classList.contains('board-help-visible');
      if (willOpen) {
        isHelpPinned = true;
        openBoardHelpPopover();
      } else {
        closeBoardHelpPopover(true);
      }
    });
  }

  if (btnCloseBoardHelp) {
    btnCloseBoardHelp.addEventListener('click', (e) => {
      e.stopPropagation();
      closeBoardHelpPopover(true);
    });
  }

  document.addEventListener('click', (e) => {
    if (boardNavRow && !boardNavRow.contains(e.target)) {
      closeBoardHelpPopover(true);
    }
  });

  document.querySelectorAll('.help-board-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const board = chip.dataset.board || 'Stock';
      cfgBoardInput.value = board;
      boardQueryEdited = true;
      updateInputTooltips(lastDebugInfo?.candidatesPreview);
      cfgQueryInput.focus();
      cfgQueryInput.select();
      showToast(`✅ 已填入看板 ${board}，可選擇關鍵字或按「立即重抓」`);
    });
  });

  document.querySelectorAll('.help-query-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      cfgQueryInput.value = chip.dataset.query ?? '';
      boardQueryEdited = true;
      closeBoardHelpPopover(true);
      triggerFetch(true);
    });
  });

  [cfgBoardInput, cfgQueryInput].forEach((inp) => {
    inp.addEventListener('input', () => {
      boardQueryEdited = true;
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        closeBoardHelpPopover(true);
        triggerFetch(true);
      }
    });
  });

  btnExtPower.addEventListener('click', () => {
    const nextVal = !extensionEnabled;
    sendBgMessage({ type: 'SET_EXTENSION_ENABLED', enabled: nextVal }).then((res) => {
      if (res?.ok && res.state) {
        applyState(res.state);
        showToast(res.state.enabled ? '🔌 PTT 彈幕套件已啟用' : '⏹ PTT 彈幕套件已停用');
      }
    });
  });

  async function triggerFetch(force = true) {
    if (!extensionEnabled) {
      showToast('⚠️ 套件目前為停用狀態，請先啟用');
      return;
    }
    const board = cfgBoardInput.value.trim() || 'Stock';
    const query = cfgQueryInput.value.trim();
    boardQueryEdited = false;

    btnForceFetch.disabled = true;
    btnForceFetch.textContent = '🔄 抓取中...';
    showToast(`🔄 正在抓取 ${board} 板最新文章與推文...`);

    try {
      const res = await sendBgMessage({
        type: 'BACKGROUND_LOAD_STOCK',
        board,
        query,
        enableLive: true,
        force
      });
      if (res?.ok && res.state) {
        applyState(res.state);
        const added = Number(res.addedCount || 0);
        showToast(added > 0 ? `✅ 已更新至 ${res.state.pushes.length} 則推文（+${added} 新彈幕）` : `✅ 已更新至 ${res.state.pushes.length} 則推文`);
      } else {
        showToast(`❌ 抓取失敗：${res?.error || '未知錯誤'}`);
      }
    } catch (err) {
      showToast(`❌ 抓取異常：${err.message || err}`);
    } finally {
      btnForceFetch.disabled = false;
      btnForceFetch.textContent = '🔄 立即重抓';
    }
  }

  btnBgFetchStock.addEventListener('click', () => triggerFetch(true));
  btnForceFetch.addEventListener('click', () => triggerFetch(true));

  btnPlay.addEventListener('click', () => {
    if (!extensionEnabled) return;
    sendBgMessage({ type: 'CONTROL_DANMAKU', action: 'TOGGLE_PLAY' }).then((res) => {
      if (res?.ok && res.state) applyState(res.state);
    });
  });

  btnRecent5m.addEventListener('click', async () => {
    if (!extensionEnabled) {
      showToast('⚠️ 套件目前為停用狀態，請先啟用');
      return;
    }
    btnRecent5m.disabled = true;
    try {
      const res = await sendBgMessage({ type: 'CONTROL_DANMAKU', action: 'PLAY_RECENT_5M' });
      if (res?.ok) {
        if (res.state) applyState(res.state);
        showToast(`⏩ 已清空舊佇列，播放最近 5 分鐘推文（共 ${res.recentCount ?? 0} 則）`);
      } else {
        showToast(`❌ 切換失敗：${res?.error || '未知錯誤'}`);
      }
    } catch (err) {
      showToast(`❌ 操作異常：${err.message || err}`);
    } finally {
      btnRecent5m.disabled = false;
    }
  });

  btnLive.addEventListener('click', () => {
    if (!extensionEnabled) return;
    const nextLive = !isLiveMode;
    sendBgMessage({ type: 'CONTROL_DANMAKU', action: 'SET_LIVE', enabled: nextLive }).then((res) => {
      if (res?.ok && res.state) applyState(res.state);
      showToast(nextLive ? '📡 Live 追文已開啟' : '⏹ Live 追文已關閉');
    });
  });

  btnCrossTab.addEventListener('click', () => {
    const nextVal = !crossTabShowEnabled;
    sendBgMessage({ type: 'SET_FILTER_OPTIONS', crossTabShowEnabled: nextVal }).then((res) => {
      if (res?.ok && res.state) applyState(res.state);
      showToast(nextVal ? '🌐 已開啟其他網頁跨分頁彈幕' : '⏹ 已關閉其他網頁跨分頁彈幕');
    });
  });

  btnBooOnly.addEventListener('click', () => {
    const nextVal = !booOnly;
    sendBgMessage({ type: 'SET_FILTER_OPTIONS', booOnly: nextVal }).then((res) => {
      if (res?.ok && res.state) applyState(res.state);
    });
  });

  speedSelect.addEventListener('change', () => {
    if (!extensionEnabled) return;
    const speedMsPerSec = parseInt(speedSelect.value, 10);
    sendBgMessage({ type: 'CONTROL_DANMAKU', action: 'SET_SPEED', speedMsPerSec }).then((res) => {
      if (res?.ok && res.state) applyState(res.state);
      showToast(`⚡ 歷史重播速度：${speedSelect.options[speedSelect.selectedIndex]?.text || ''}`);
    });
  });

  flyDurationSelect.addEventListener('change', () => {
    const sec = normalizeFlyDurationSeconds(flyDurationSelect.value);
    sendBgMessage({ type: 'SET_FLY_DURATION', seconds: sec }).then((res) => {
      if (res?.ok && res.state) applyState(res.state);
      showToast(`💨 已調整彈幕飛越速度：${flyDurationSelect.options[flyDurationSelect.selectedIndex]?.text || sec + 's'}`);
    });
  });

  minIntervalSelect.addEventListener('change', () => {
    const sec = normalizeIntervalSeconds(minIntervalSelect.value);
    sendBgMessage({ type: 'SET_MIN_FETCH_INTERVAL', seconds: sec }).then((res) => {
      if (res?.ok && res.state) applyState(res.state);
      showToast(`⏳ 最小抓取間隔已設為 ${sec} 秒`);
    });
  });

  maxBatchSelect.addEventListener('change', () => {
    const count = normalizeMaxBatchCount(maxBatchSelect.value);
    sendBgMessage({ type: 'SET_MAX_BATCH_COUNT', count }).then((res) => {
      if (res?.ok && res.state) applyState(res.state);
      showToast(`💬 每次最多發射彈幕：${count} 則`);
    });
  });

  keywordInput.addEventListener('input', () => {
    const raw = keywordInput.value;
    keywords = parseKeywords(raw);
    renderHeatmapAndPeaks();
    clearTimeout(kwSyncTimer);
    kwSyncTimer = setTimeout(() => {
      sendBgMessage({ type: 'SET_FILTER_OPTIONS', keywordRaw: raw }).then((res) => {
        if (res?.ok && res.state) applyState(res.state);
      });
    }, 200);
  });

  btnKwMode.addEventListener('click', () => {
    const nextVal = !keywordFilterOnly;
    sendBgMessage({ type: 'SET_FILTER_OPTIONS', keywordFilterOnly: nextVal }).then((res) => {
      if (res?.ok && res.state) applyState(res.state);
    });
  });

  slider.addEventListener('input', () => {
    if (!extensionEnabled) return;
    isDragging = true;
    const ratio = slider.value / 1000;
    currentVirtualTime = startTime + ratio * totalDuration;
    updateTimeDisplay(0);
  });

  slider.addEventListener('change', () => {
    if (!extensionEnabled) return;
    const ratio = slider.value / 1000;
    isDragging = false;
    sendBgMessage({ type: 'CONTROL_DANMAKU', action: 'SEEK_RATIO', ratio }).then((res) => {
      if (res?.ok && res.state) applyState(res.state);
    });
  });

  scrubberWrapper.addEventListener('mousemove', (e) => {
    if (!extensionEnabled || pushes.length === 0) return;
    const rect = scrubberWrapper.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const targetTime = startTime + ratio * totalDuration;
    let idx = 0;
    for (let i = 0; i < pushes.length; i++) {
      if (pushes[i].virtualTime <= targetTime) idx = i;
      else break;
    }
    const p = pushes[idx];
    const hhmm = extractPushHhMm(p);
    tooltip.textContent = `[${hhmm || p.timeStr}] ${p.tag} ${p.userid}: ${p.content}`;
    tooltip.style.display = 'block';
    const wrapperWidth = rect.width || scrubberWrapper.clientWidth || 456;
    const tipWidth = Math.min(wrapperWidth, tooltip.offsetWidth || 0);
    const rawLeft = ratio * wrapperWidth - tipWidth / 2;
    const clampedLeft = Math.min(Math.max(0, rawLeft), Math.max(0, wrapperWidth - tipWidth));
    tooltip.style.left = `${Math.round(clampedLeft)}px`;
  });

  scrubberWrapper.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'DANMAKU_STATE_UPDATED' || msg.type === 'DANMAKU_ENABLED_CHANGED' || msg.type === 'DANMAKU_LIVE_NEW_PUSHES' || msg.type === 'DANMAKU_QUEUE_CLEARED') {
      if (msg.state) applyState(msg.state);
    } else if (msg.type === 'DANMAKU_TICK') {
      if (!extensionEnabled || isDragging) return;
      currentVirtualTime = msg.currentVirtualTime;
      nextPushIndex = msg.nextPushIndex;
      isPlaying = Boolean(msg.isPlaying);
      if (pushes.length > 0) {
        slider.value = Math.round(
          Math.min(1, Math.max(0, (currentVirtualTime - startTime) / totalDuration)) * 1000
        );
        updateTimeDisplay(nextPushIndex);
      }
      updateButtonsUI();
    }
  });

  let popupPollInFlight = false;
  setInterval(() => {
    if (
      !extensionEnabled ||
      !isLiveMode ||
      isPlaying ||
      popupPollInFlight ||
      lastFetchedAt <= 0
    ) {
      return;
    }
    const intervalMs = minFetchIntervalSeconds * 1000;
    if (Date.now() - lastFetchedAt < intervalMs) {
      return;
    }
    popupPollInFlight = true;
    const isEditing =
      boardQueryEdited ||
      document.activeElement === cfgBoardInput ||
      document.activeElement === cfgQueryInput;
    sendBgMessage({
      type: 'BACKGROUND_LOAD_STOCK',
      board: currentBoardName || 'Stock',
      query: isEditing ? undefined : cfgQueryInput.value.trim(),
      enableLive: true,
      force: false
    })
      .then((res) => {
        if (res?.ok && res.state) {
          applyState(res.state);
        }
      })
      .catch(() => {})
      .finally(() => {
        popupPollInFlight = false;
      });
  }, 1000);

  (async function initPopup() {
    try {
      const res = await sendBgMessage({ type: 'GET_DANMAKU_STATE' });
      if (res?.ok && res.state) {
        applyState(res.state);
      }
    } catch (err) {
      showToast(`❌ 無法連接背景服務：${err.message || err}`);
    }
  })();
})();
