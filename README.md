# 🎰 百家之眼 - 全廳監控系統 + LINE BOT

即時監控百家樂全廳桌台，自動計算 EV（期望值），並透過 LINE BOT 推送警報。

## 功能特色

- **全廳即時監控** - 同時監控多張桌台，即時更新路紙與 EV
- **EV 自動計算** - 基於剩餘牌組動態計算莊/閒/和的期望值
- **大路 & 珠盤路** - 視覺化路紙顯示
- **LINE BOT 整合** - 自動推送 EV 警報到 LINE 群組
- **WebSocket 即時更新** - 所有連線裝置同步更新
- **趨勢分析** - 連莊/連閒/單跳等趨勢識別

## 快速開始

### 1. 安裝依賴
```bash
cd monitor
npm install
```

### 2. 設定環境變數
複製 `.env.example` 為 `.env`，填入 LINE BOT 的設定：
```bash
cp .env.example .env
```

### 3. 啟動伺服器
```bash
npm start
```

### 4. 開啟監控面板
瀏覽器打開 `http://localhost:3000`

## LINE BOT 設定

### 步驟
1. 前往 [LINE Developers](https://developers.line.biz/) 建立 Messaging API Channel
2. 取得 **Channel Access Token** 和 **Channel Secret**
3. 填入 `.env` 檔案
4. 將 Webhook URL 設定為 `https://你的域名/webhook`（需要公開 URL，可用 ngrok）

### LINE 指令
| 指令 | 說明 |
|------|------|
| `全廳` | 查看全廳狀態 |
| `桌N` | 查看第N桌詳情 (如: 桌3) |
| `訂閱` | 開啟 EV 警報通知 |
| `取消訂閱` | 關閉通知 |
| `指令` | 顯示幫助 |

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/tables` | 取得全廳狀態 |
| GET | `/api/tables/:id` | 取得單桌狀態 |
| POST | `/api/tables/:id/record` | 記錄結果 `{ result: "B"/"P"/"T" }` |
| POST | `/api/tables/:id/reset` | 重置牌靴 |
| POST | `/api/tables` | 新增桌台 `{ name: "桌名" }` |
| POST | `/api/tables/:id/batch` | 批量記錄 `{ results: ["B","P","T",...] }` |

## 技術架構

- **後端**: Node.js + Express + WebSocket
- **前端**: 原生 HTML/CSS/JS（無框架，極速載入）
- **LINE BOT**: @line/bot-sdk
- **即時通訊**: ws (WebSocket)
