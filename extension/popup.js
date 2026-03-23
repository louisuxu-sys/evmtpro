// 載入儲存的設定
chrome.storage.sync.get(['serverUrl'], (result) => {
  document.getElementById('serverUrl').value = result.serverUrl || '';
});

// 儲存設定
document.getElementById('saveBtn').addEventListener('click', () => {
  const url = document.getElementById('serverUrl').value.trim().replace(/\/$/, '');
  chrome.storage.sync.set({ serverUrl: url }, () => {
    const btn = document.getElementById('saveBtn');
    btn.textContent = '✅ 已儲存！';
    btn.style.background = '#2d6a4f';
    setTimeout(() => {
      btn.textContent = '💾 儲存設定';
      btn.style.background = '#e63946';
    }, 2000);
  });
});

// 接收 content script 的狀態更新
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') {
    document.getElementById('msgCount').textContent = msg.msgCount || 0;
    const statusEl = document.getElementById('status');
    const wsEl = document.getElementById('wsStatus');
    
    if (msg.connected) {
      statusEl.className = 'status ok';
      statusEl.textContent = '✅ MT WebSocket 已連線，資料轉發中';
      wsEl.textContent = '已連線';
    } else {
      statusEl.className = 'status wait';
      statusEl.textContent = '⏳ 等待 MT WebSocket 連線...';
      wsEl.textContent = '等待中';
    }
  }
});
