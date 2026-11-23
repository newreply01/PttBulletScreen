# 🎬 PTT 跨網頁即時推文彈幕引擎 (PTT BulletScreen / Danmaku Extension)

[![Chrome MV3](https://img.shields.io/badge/Manifest-V3-brightgreen.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-yellow.svg)](https://developer.mozilla.org/zh-TW/docs/Web/JavaScript)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

專為批踢踢實業坊（PTT）設計的 Chrome 瀏覽器即時彈幕與跨網頁追文擴充功能。採用 Chrome Extension Manifest V3 架構，結合 PTT 官方 `#article-polling` 增量推送長輪詢機制與 Shadow DOM 獨立渲染舞台，支援在 **PTT 網頁版（`www.ptt.cc`）**、**網頁終端機（`term.ptt.cc`）** 以及 **任何一般網頁（YouTube、Twitch、新聞等）** 畫面上無縫播放即時與歷史推文彈幕！

---

## 🌟 核心特色一覽

### ⚡ PTT 原生即時增量輪詢（Delta Engine）
* **免狂刷整頁 HTML**：底層整合 PTT 官方 `/v1/longpoll` 與 `/poll/` 增量長輪詢機制。
* **高頻低負載追文**：文章推文激增時（例如棒球賽、台股開盤/收盤盤後閒聊），自動以增量 offset（102 bytes/push）抓取最新推文，毫秒級推送到螢幕。
* **智慧防堵推文漏抓**：動態追補防禦巡檢（guard-up），即便長時間離線或分頁休眠，喚醒後亦能精準接續 offset，不遺漏任何推文。

### 🚀 跨分頁彈幕同步與雙層背景常駐
* **跨分頁浮動彈幕（Cross-tab Danmaku）**：在 Chrome 看 YouTube 轉播、追劇或盯盤時，彈幕可直接疊加在任意網頁畫面上（開關可自由切換）。
* **雙層背景保活機制**：結合 Chrome MV3 Service Worker 與前台 Visible Tab 活躍心跳，杜絕 Service Worker 閒置被瀏覽器強制休眠導致的彈幕中斷。

### 🖼️ 2倍大圖預覽彈幕
* **彈幕內嵌圖片放大**：彈幕內附帶的圖片（如 Imgur 等圖片連結）尺寸提升 2 倍（高達 168px / 寬達 320px），畫面清晰易讀。
* **動態多軌防撞排程**：大圖彈幕自動動態佔用多個軌道（Multi-lane reservation，最多達 4 軌），並計算等像素速度（Constant Velocity）飛行，徹底解決圖片被文字彈幕重疊遮蔽的問題。

### ⏩ 離線喚醒「近 5 分鐘」智慧跳轉（方案 A）
* **即時脫離過期隊列**：使用者離開電腦或切換分頁 30 分鐘後返回，點擊控制台上的 **「⏩ 近5分」** 按鈕，系統將瞬間清空累積已久的過期推文佇列，並快速廣播最近 5 分鐘內的推文，無縫銜接目前討論現況。
* **雙重安全修剪**：系統同時內建逾期推文時間窗守護，避免一覺醒來瞬間噴發數千則舊彈幕卡死瀏覽器。

### 📊 專業控制台 HUD 與推文熱度分析
* **推文熱度密度圖與尖峰標記**：時間軸直接繪製整篇推文隨時間的起伏曲線，並標記爆文尖峰時段（`🔥 14:17`、`🔥 22:28`），點擊立刻跳轉。
* **15x ~ 300x 超高速重播**：支援真實時間至 300 倍極速推文重播，長篇大論與閒聊串能在幾分鐘內完整回顧。
* **只看噓文 / 關鍵字高亮篩選**：支援一鍵切換「🔥 只看噓文」或自訂多組關鍵字高亮 / 僅顯示模式。
* **推 / 噓 / 箭頭情緒比例列**：即時掌握全篇討論風向與正負評價佔比。

---

## 🛠️ 系統架構設計

```
  ┌──────────────────────────────────────────────────────────────┐
  │                 PTT Server (www.ptt.cc)                      │
  │     - /bbs/Board/M.xxx.html (Initial Article HTML)           │
  │     - /v1/longpoll (Poll Registration & Long-polling URL)   │
  │     - /poll/bbs/Board/M.xxx (102-byte Incremental Stream)    │
  └──────────────────────────────┬───────────────────────────────┘
                                 │ Fetch API (Delta Polling)
                                 ▼
  ┌──────────────────────────────────────────────────────────────┐
  │         Chrome MV3 Service Worker (background.js)            │
  │  - PTT Delta Polling Controller (Real-time catch-up loop)    │
  │  - Article State Machine & Local Storage Runtime Cache       │
  │  - Push Delta Aggregator & Timeline Peak Calculator          │
  │  - Smart Time-Window Guardian (Stale-drop & 5-min slicing)  │
  │  - Keepalive Port Heartbeat Manager                          │
  └──────────────┬───────────────────────────────┬───────────────┘
                 │ chrome.runtime.sendMessage    │
                 ▼                               ▼
  ┌─────────────────────────────┐ ┌─────────────────────────────┐
  │   Content Script Stage      │ │     Extension Popup HUD     │
  │      (content.js)           │ │   (popup.html / popup.js)   │
  │ - Isolated Shadow DOM Host  │ │ - Fixed 480px Anti-Jitter   │
  │ - Multi-Lane Constant Speed │ │ - Timeline Scrubber & Peaks │
  │ - 2x Image Sizing & Layout  │ │ - ⏩ 近5分 / 🚀 Live 追文   │
  │ - OSD Status & Toast Alerts │ │ - Board & Article Monitors  │
  └─────────────────────────────┘ └─────────────────────────────┘
```

### 1. 核心檔案職責
* **`manifest.json`**：Chrome MV3 配置清單，聲明 `storage`、`tabs`、`scripting` 權限與跨網頁 Host 權限。
* **`background.js`**：
  * **增量輪詢核心**：解析官方 `#article-polling` 屬性，維護輪詢工作隊列。
  * **快取還原防護**：每次異動均持久化同步至 `chrome.storage.local`，喚醒後可瞬間恢復。
  * **推文派發與跳轉**：處理 `PLAY_RECENT_5M`、`FETCH_ARTICLE`、`CONTROL_DANMAKU` 等通訊請求。
* **`content.js`**：
  * **獨立渲染舞台**：以 Shadow DOM（`#ptt-danmaku-ext-host`）掛載於 `documentElement`，最高層級 `z-index: 2147483647`。
  * **飛行物理運算**：採用固定像素速度計算飛行秒數（飛行時長依文字/圖片寬度動態適配），確保後發推文不追撞前發推文。
* **`popup.html` & `popup.js`**：
  * **防抖動版面（Anti-Jitter）**：嚴格鎖定寬度為 480px，滑鼠移動於時間軸邊界時 Tooltip 邊界吸附防溢出。
  * **多功能操作 HUD**：看板切換、文章挑選、播放速率選擇（15x~300x）、彈幕飛速調節（5s~14s）。

---

## 📥 安裝教學

1. **下載或 Clone 本專案**：
   ```bash
   git clone https://github.com/newreply01/PttBulletScreen.git
   ```
2. **開啟 Chrome 擴充功能管理頁**：
   * 在 Chrome 網址列輸入 `chrome://extensions/` 並按下 Enter。
   * 開啟右上角的**「開發人員模式」（Developer mode）**開關。
3. **載入擴充功能**：
   * 點擊左上角的**「載入未封裝項目」（Load unpacked）**。
   * 選擇剛下載的專案資料夾目錄（包含 `manifest.json` 的路徑）。
4. **釘選至工具列**：
   * 點擊 Chrome 擴充功能拼圖圖示，將「PTT 彈幕」固定於工具列，方便隨時開啟操作面板。

---

## 🎮 操作指引與使用技巧

### 1. 監控熱門看板與追文
* 點擊擴充功能圖示開啟控制面板。
* 在看板欄輸入看板名稱（例如 `Stock`、`Baseball`、`Gossiping`），文章關鍵字欄輸入欲追蹤之文章主題（例如 `閒聊`、`Live`）。
* 點擊 **「背景抓文」** 或 **「🔄 立即重抓」**，系統將自動解析出最新對應文章，並啟動推文同步。
* 若點擊 `ⓘ` 圖示，可查看目前看板最新推薦之閒聊/討論文章清單並一鍵套用。

### 2. 即時追文 vs 歷史重播
* **🚀 Live 追文（預設開啟）**：PTT 有新推文時，畫面會第一時間發射彈幕。
* **▶️ 重播模式**：點擊重播按鈕，可將全篇推文從頭依照時間序列回放，支援最高 **300x** 速度播放。
* **⏩ 近 5 分**：長久未觀看或切換回分頁時，點擊「⏩ 近 5 分」按鈕，立即跳過久遠推文，直接播放最近 5 分鐘推文。
* **🔥 只看噓文**：點擊切換為只播放噓文彈幕，適合快速檢視爭議焦點。
* **🌐 跨分頁彈幕**：開啟後切換至其他分頁（如觀賞運動賽事、觀看股市走勢），彈幕仍會持續在當前網頁頂部飄過。

---

## 📋 授權與宣告 (License & Disclaimer)

* 本專案遵循 [MIT 授權條款](LICENSE) 開源。
* 本工具僅供學術研究與個人瀏覽體驗增強使用，所有文章內容之版權歸批踢踢實業坊及原推文作者所有。
