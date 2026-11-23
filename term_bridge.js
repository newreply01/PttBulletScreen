// term_bridge.js - 支援 Blob/ArrayBuffer/String 雙編碼偵測，精準抓取文章網址與看板標題
(function () {
  'use strict';

  const OrigWebSocket = window.WebSocket;
  const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
  let big5Decoder = null;
  try {
    big5Decoder = new TextDecoder('big5', { fatal: false });
  } catch (_) {}

  let buffer = '';
  let lastDetectedKey = '';

  function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  }

  function emitDetected(payload) {
    const key = payload.url || `${payload.board}::${payload.title}`;
    if (key === lastDetectedKey) return;
    lastDetectedKey = key;
    window.postMessage(
      {
        source: 'PTT_DANMAKU_TERM_BRIDGE',
        type: 'ARTICLE_DETECTED',
        ...payload
      },
      '*'
    );
  }

  function inspectTerminalStream(chunk) {
    buffer = (buffer + stripAnsi(chunk)).slice(-8000);

    // 方式 1：最精準！偵測文章內按 Q 彈出的完整網頁版網址 (https://www.ptt.cc/bbs/看板/M.xxx.html)
    const urlMatch = buffer.match(/https:\/\/www\.ptt\.cc\/bbs\/([a-zA-Z0-9_-]+)\/(M\.\d+\.A\.[A-Z0-9]+\.html)/i);
    if (urlMatch) {
      emitDetected({
        board: urlMatch[1],
        url: `https://www.ptt.cc/bbs/${urlMatch[1]}/${urlMatch[2]}`
      });
      return;
    }

    // 方式 2：偵測進入文章時的標頭列 (看板《Stock》 與 標題 ...)
    const boardMatch = buffer.match(/看板《([a-zA-Z0-9_-]+)》/);
    const titleMatch = buffer.match(/標\s*題\s+([^\r\n\x00-\x1f]+)/);

    if (boardMatch && titleMatch) {
      const board = boardMatch[1].trim();
      const title = titleMatch[1].trim();
      if (title.length >= 2) {
        emitDetected({ board, title });
      }
    }
  }

  function handleBuffer(ab) {
    inspectTerminalStream(utf8Decoder.decode(ab, { stream: true }));
    if (big5Decoder) {
      inspectTerminalStream(big5Decoder.decode(ab, { stream: true }));
    }
  }

  window.WebSocket = new Proxy(OrigWebSocket, {
    construct(target, args) {
      const ws = new target(...args);
      ws.addEventListener('message', (event) => {
        try {
          if (typeof event.data === 'string') {
            inspectTerminalStream(event.data);
          } else if (event.data instanceof ArrayBuffer) {
            handleBuffer(event.data);
          } else if (event.data instanceof Blob) {
            event.data.arrayBuffer().then(handleBuffer).catch(() => {});
          }
        } catch (_) {}
      });
      return ws;
    }
  });
})();