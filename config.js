// config.js - background / content / popup 共用設定（單一來源，修改可選值只需改這裡）
// 以 globalThis 賦值而非 const 宣告：content script 可能被重複注入同一個 isolated world，避免重複宣告錯誤
(function (root) {
  'use strict';

  const option = (value, label) => Object.freeze({ value, label });

  root.PTT_DANMAKU_CONFIG = Object.freeze({
    DEFAULT_BOARD: 'Stock',
    DEFAULT_QUERY: '閒聊',

    // 首次載入/跳轉時只播放最近 N 分鐘的推文，最多 M 波
    INITIAL_PREVIEW_WINDOW_MINUTES: 5,
    INITIAL_PREVIEW_MAX_WAVES: 3,

    // Live 推文更新間隔（秒）
    MIN_FETCH_INTERVAL_SECONDS: Object.freeze({
      defaultValue: 30,
      options: Object.freeze([3, 5, 10, 15, 30, 60, 120, 180, 300].map((s) => option(s, `⏳ 更新間隔: ${s}s`)))
    }),

    // 彈幕飛越畫面秒數
    FLY_DURATION_SECONDS: Object.freeze({
      defaultValue: 10,
      options: Object.freeze([
        option(18, '🐢 飛速: 極慢 (18s)'),
        option(14, '🐢 飛速: 慢速 (14s)'),
        option(10, '🚀 飛速: 適中 (10s)'),
        option(7, '🚀 飛速: 快速 (7s)'),
        option(5, '⚡ 飛速: 極快 (5s)')
      ])
    }),

    // 每波最多發射彈幕數
    MAX_BATCH_COUNT: Object.freeze({
      defaultValue: 10,
      options: Object.freeze([3, 5, 10, 15, 20, 30, 50].map((n) => option(n, `💬 每次最多: ${n}則`)))
    }),

    // 歷史重播倍速（每真實 1 秒推進的虛擬毫秒數）
    REPLAY_SPEED_MS_PER_SEC: Object.freeze({
      defaultValue: 60000,
      options: Object.freeze([15000, 30000, 60000, 120000, 180000, 300000].map((ms) => option(ms, `⚡ 重播: ${ms / 1000}x 速`)))
    })
  });

  // 將任意輸入正規化為允許值之一，不合法時回傳預設值
  root.pttDanmakuNormalizeOption = function (spec, rawVal) {
    const parsed = Math.round(Number(rawVal));
    return spec.options.some((o) => o.value === parsed) ? parsed : spec.defaultValue;
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
