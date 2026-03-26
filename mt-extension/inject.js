/**
 * 百家之眼 - MT WebSocket 攔截器
 * 自動攔截 ofalive99.net 的 WebSocket 訊息並轉發到本地伺服器
 */
(function() {
  'use strict';

  const SERVER_URL = 'https://evmtpro.onrender.com/api/mt/ingest';
  const API_KEY = 'aaa555987';
  var msgCount = 0;
  var sentCount = 0;
  var connected = false;
  var lastError = 0;

  // 保存原始 WebSocket
  const OriginalWebSocket = window.WebSocket;

  // 覆寫 WebSocket
  window.WebSocket = function(url, protocols) {
    console.log('%c[百家之眼] 🔌 攔截 WebSocket: ' + url, 'color: #00ff88; font-weight: bold');

    var ws = protocols
      ? new OriginalWebSocket(url, protocols)
      : new OriginalWebSocket(url);

    // 攔截訊息 (只轉發百家樂相關)
    ws.addEventListener('message', function(event) {
      try {
        if (typeof event.data !== 'string') return;
        msgCount++;

        var d = event.data;
        // DD 格式 (doubledragon): 含 "SI" 欄位 → 直接轉發
        var isDDFormat = d.indexOf('"SI"') !== -1 || d.indexOf('"D"') !== -1;
        // 舊 MT 格式: 含關鍵字才轉發
        var hasKeyword = d.indexOf('tables') !== -1 || d.indexOf('summary') !== -1 ||
            d.indexOf('show_win') !== -1 || d.indexOf('show_poker') !== -1 ||
            d.indexOf('road') !== -1 || d.indexOf('/wait') !== -1 ||
            d.indexOf('/end') !== -1 || d.indexOf('/deal') !== -1;
        if (!isDDFormat && !hasKeyword) return;

        sentCount++;
        fetch(SERVER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify({
            wsUrl: url,
            timestamp: Date.now(),
            data: event.data
          })
        }).then(function() {
          if (!connected) {
            connected = true;
            console.log('%c[百家之眼] ✅ 已連線到 Render 伺服器', 'color: #00ff88; font-weight: bold');
          }
        }).catch(function() {
          if (Date.now() - lastError > 10000) {
            lastError = Date.now();
            console.log('%c[百家之眼] ⚠️ Render 伺服器連線失敗 (' + SERVER_URL + ')', 'color: #ffaa00');
          }
        });

        if (sentCount % 100 === 0) {
          console.log('%c[百家之眼] 📊 已轉發 ' + sentCount + '/' + msgCount + ' 筆', 'color: #00ff88');
        }
      } catch (e) { /* ignore */ }
    });

    ws.addEventListener('open', function() {
      console.log('%c[百家之眼] ✅ WebSocket 已連線: ' + url, 'color: #00ff88');
    });

    ws.addEventListener('close', function(e) {
      console.log('%c[百家之眼] 🔌 WebSocket 已斷線 (' + e.code + ')', 'color: #ffaa00');
    });

    return ws;
  };

  // 保留原型和常數
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

  console.log('%c[百家之眼] 🎰 MT 攔截器已啟動 v1.0', 'color: #00ff88; font-size: 14px; font-weight: bold');
})();
