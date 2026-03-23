/**
 * MT 平台 WebSocket 攔截腳本
 * 在 MT 平台瀏覽器的 Console 裡貼上此腳本執行
 * 它會攔截所有 WebSocket 訊息並轉發到本地伺服器
 */
(function() {
  const SERVER_URL = 'http://localhost:3000/api/mt/ingest';
  let msgCount = 0;
  let connected = false;

  // 保存原始 WebSocket
  const OriginalWebSocket = window.WebSocket;

  // 覆寫 WebSocket
  window.WebSocket = function(url, protocols) {
    console.log('%c[百家之眼] 攔截 WebSocket: ' + url, 'color: #00ff88; font-weight: bold');

    const ws = protocols
      ? new OriginalWebSocket(url, protocols)
      : new OriginalWebSocket(url);

    // 攔截收到的訊息
    ws.addEventListener('message', function(event) {
      try {
        const data = typeof event.data === 'string' ? event.data : null;
        if (!data) return;

        msgCount++;

        // 轉發到本地伺服器
        fetch(SERVER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            wsUrl: url,
            timestamp: Date.now(),
            data: data
          })
        }).then(resp => {
          if (!connected) {
            connected = true;
            console.log('%c[百家之眼] ✅ 已連線到本地伺服器，開始轉發資料...', 'color: #00ff88; font-weight: bold');
          }
        }).catch(err => {
          if (connected) {
            connected = false;
            console.log('%c[百家之眼] ❌ 本地伺服器未啟動或無法連線', 'color: #ff4444');
          }
        });

        // 每50筆顯示一次統計
        if (msgCount % 50 === 0) {
          console.log(`%c[百家之眼] 已轉發 ${msgCount} 筆訊息`, 'color: #00ff88');
        }
      } catch (e) {
        // 靜默忽略
      }
    });

    ws.addEventListener('open', function() {
      console.log('%c[百家之眼] WebSocket 已開啟: ' + url, 'color: #00ff88');
    });

    ws.addEventListener('close', function() {
      console.log('%c[百家之眼] WebSocket 已關閉: ' + url, 'color: #ffaa00');
    });

    return ws;
  };

  // 保留原型鏈
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

  console.log('%c[百家之眼] 🎰 WebSocket 攔截器已啟動！', 'color: #00ff88; font-size: 16px; font-weight: bold');
  console.log('%c[百家之眼] 請重新整理 MT 頁面以攔截 WebSocket 連線', 'color: #ffaa00; font-weight: bold');
  console.log('%c[百家之眼] 或等待下次 WebSocket 自動重連', 'color: #ffaa00');

  // 也嘗試攔截已有的 WebSocket (如果頁面已經建立連線)
  // 需要重新整理頁面才能攔截已建立的連線
})();
