// 百家之眼 - MT WebSocket 資料攔截器
// 注入到 MT 頁面，攔截所有 WebSocket 訊息並轉發到雲端伺服器

(function() {
  'use strict';

  // 從 storage 讀取伺服器 URL
  let SERVER_URL = '';
  let msgCount = 0;
  let connected = false;

  // 讀取設定
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.sync.get(['serverUrl'], (result) => {
      SERVER_URL = result.serverUrl || '';
      if (SERVER_URL) {
        console.log('[百家之眼] 伺服器:', SERVER_URL);
      } else {
        console.log('[百家之眼] ⚠️ 未設定伺服器 URL，請點擊擴充功能圖示設定');
      }
    });

    // 監聽設定變更
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.serverUrl) {
        SERVER_URL = changes.serverUrl.newValue || '';
        console.log('[百家之眼] 伺服器已更新:', SERVER_URL);
      }
    });
  }

  // 攔截 WebSocket
  const OriginalWebSocket = window.WebSocket;
  
  window.WebSocket = function(url, protocols) {
    console.log('[百家之眼] WebSocket 連線:', url);
    
    const ws = protocols 
      ? new OriginalWebSocket(url, protocols) 
      : new OriginalWebSocket(url);

    // 攔截 onmessage
    const origAddEventListener = ws.addEventListener.bind(ws);
    
    ws.addEventListener = function(type, listener, options) {
      if (type === 'message') {
        const wrappedListener = function(event) {
          forwardMessage(url, event.data);
          return listener.call(this, event);
        };
        return origAddEventListener(type, wrappedListener, options);
      }
      return origAddEventListener(type, listener, options);
    };

    // 也攔截直接設定的 onmessage
    let _onmessage = null;
    Object.defineProperty(ws, 'onmessage', {
      get: () => _onmessage,
      set: (fn) => {
        _onmessage = function(event) {
          forwardMessage(url, event.data);
          return fn.call(this, event);
        };
      }
    });

    // 連線成功時通知
    ws.addEventListener('open', () => {
      connected = true;
      console.log('[百家之眼] ✅ WebSocket 已連線:', url);
      updateBadge();
    });

    ws.addEventListener('close', () => {
      connected = false;
      console.log('[百家之眼] ❌ WebSocket 已斷線:', url);
      updateBadge();
    });

    return ws;
  };

  // 保留原始 WebSocket 的屬性
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

  // 轉發訊息到伺服器
  function forwardMessage(wsUrl, data) {
    if (!SERVER_URL) return;
    
    msgCount++;
    
    try {
      fetch(SERVER_URL + '/api/mt/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wsUrl: wsUrl,
          timestamp: Date.now(),
          data: data
        })
      }).catch(() => {});
    } catch (e) {}

    // 每 50 條更新一次 badge
    if (msgCount % 50 === 0) updateBadge();
  }

  // 更新擴充功能 badge
  function updateBadge() {
    try {
      if (chrome && chrome.runtime) {
        chrome.runtime.sendMessage({ 
          type: 'status', 
          connected, 
          msgCount,
          url: window.location.href
        });
      }
    } catch (e) {}
  }

  // 定期回報狀態
  setInterval(updateBadge, 5000);

  console.log('[百家之眼] ✅ WebSocket 攔截器已載入');
})();
