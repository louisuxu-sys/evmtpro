// ==UserScript==
// @name         百家之眼 - MT 資料攔截器
// @namespace    http://localhost:3000
// @version      1.0
// @description  攔截 MT 平台 WebSocket 訊息，轉發到百家之眼伺服器
// @author       EV Monitor
// @match        *://*.ofalive99.net/*
// @match        *://gsa.ofalive99.net/*
// @match        *://gsb.ofalive99.net/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      localhost
// ==/UserScript==

(function() {
  'use strict';

  const SERVER_URL = 'http://localhost:3000/api/mt/ingest';
  let msgCount = 0;
  let connected = false;
  let lastError = 0;

  // 發送資料到本地伺服器
  function sendToServer(wsUrl, data) {
    try {
      // 優先使用 GM_xmlhttpRequest (繞過 CORS)
      if (typeof GM_xmlhttpRequest !== 'undefined') {
        GM_xmlhttpRequest({
          method: 'POST',
          url: SERVER_URL,
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify({ wsUrl: wsUrl, timestamp: Date.now(), data: data }),
          onload: function(resp) {
            if (!connected) {
              connected = true;
              console.log('%c[百家之眼] ✅ 已連線到本地伺服器 (GM)', 'color: #00ff88; font-weight: bold');
            }
          },
          onerror: function() {
            if (Date.now() - lastError > 10000) {
              lastError = Date.now();
              console.log('%c[百家之眼] ⚠️ 本地伺服器未啟動', 'color: #ffaa00');
            }
          }
        });
      } else {
        // 備用: 使用 fetch
        fetch(SERVER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wsUrl: wsUrl, timestamp: Date.now(), data: data })
        }).then(function() {
          if (!connected) {
            connected = true;
            console.log('%c[百家之眼] ✅ 已連線到本地伺服器', 'color: #00ff88; font-weight: bold');
          }
        }).catch(function() {
          if (Date.now() - lastError > 10000) {
            lastError = Date.now();
            console.log('%c[百家之眼] ⚠️ 本地伺服器未啟動', 'color: #ffaa00');
          }
        });
      }
    } catch (e) {
      // 靜默忽略
    }
  }

  // 保存原始 WebSocket
  const OriginalWebSocket = window.WebSocket;

  // 覆寫 WebSocket 建構函數
  window.WebSocket = function(url, protocols) {
    console.log('%c[百家之眼] 🔌 攔截 WebSocket: ' + url, 'color: #00ff88; font-weight: bold');

    var ws;
    if (protocols) {
      ws = new OriginalWebSocket(url, protocols);
    } else {
      ws = new OriginalWebSocket(url);
    }

    // 攔截收到的訊息
    var origOnMessage = null;

    // 方法1: addEventListener 攔截
    ws.addEventListener('message', function(event) {
      try {
        if (typeof event.data === 'string') {
          msgCount++;
          sendToServer(url, event.data);

          if (msgCount % 100 === 0) {
            console.log('%c[百家之眼] 📊 已轉發 ' + msgCount + ' 筆訊息', 'color: #00ff88');
          }
        }
      } catch (e) { /* ignore */ }
    });

    ws.addEventListener('open', function() {
      console.log('%c[百家之眼] ✅ WebSocket 已連線: ' + url, 'color: #00ff88; font-weight: bold');
    });

    ws.addEventListener('close', function(e) {
      console.log('%c[百家之眼] 🔌 WebSocket 已斷線: ' + url + ' (' + e.code + ')', 'color: #ffaa00');
    });

    ws.addEventListener('error', function() {
      console.log('%c[百家之眼] ❌ WebSocket 錯誤: ' + url, 'color: #ff4444');
    });

    return ws;
  };

  // 保留原型和靜態屬性
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

  console.log('%c[百家之眼] 🎰 MT 資料攔截器已啟動 v1.0', 'color: #00ff88; font-size: 14px; font-weight: bold');
  console.log('%c[百家之眼] 伺服器: ' + SERVER_URL, 'color: #00ff88');
})();
