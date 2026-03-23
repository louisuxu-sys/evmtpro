#!/bin/bash
# 百家之眼 - GCP VM 一鍵安裝腳本
# 在 GCP VM 上執行此腳本即可完成所有安裝

set -e

echo "🎰 百家之眼 - 開始安裝..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. 安裝 Node.js 20
echo "📦 安裝 Node.js..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. 安裝 Chromium + 中文字體
echo "🌐 安裝 Chromium 瀏覽器..."
sudo apt-get install -y chromium-browser fonts-noto-cjk || \
sudo apt-get install -y chromium fonts-noto-cjk

# 3. Clone 專案
echo "📂 下載專案..."
cd ~
if [ -d "evmtpro" ]; then
  cd evmtpro/monitor
  git pull
else
  git clone https://github.com/louisuxu-sys/evmtpro.git
  cd evmtpro/monitor
fi

# 4. 安裝依賴
echo "📦 安裝 npm 依賴..."
npm ci --production

# 5. 建立 .env 檔案
if [ ! -f .env ]; then
  echo "⚙️  建立 .env 設定檔..."
  cat > .env << 'ENVEOF'
# LINE BOT
LINE_CHANNEL_ACCESS_TOKEN=your_line_channel_access_token_here
LINE_CHANNEL_SECRET=your_line_channel_secret_here

# 管理員密碼
ADMIN_KEY=evpro2024

# MT 娛樂城自動登入
MT_CASINO_URL=https://seofufan.seogrwin1688.com/
MT_CASINO_USERNAME=your_username
MT_CASINO_PASSWORD=your_password

# Chromium 路徑
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 伺服器
PORT=3000
ENVEOF
  echo "⚠️  請編輯 .env 填入你的帳密: nano ~/evmtpro/monitor/.env"
else
  echo "✅ .env 已存在，跳過"
fi

# 6. 安裝 PM2 (程序管理器，開機自動啟動)
echo "🔧 安裝 PM2..."
sudo npm install -g pm2

# 7. 設定防火牆
echo "🔥 開放 port 3000..."
sudo ufw allow 3000 2>/dev/null || true

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ 安裝完成！"
echo ""
echo "接下來的步驟:"
echo "1. 編輯設定:  nano ~/evmtpro/monitor/.env"
echo "2. 啟動系統:  cd ~/evmtpro/monitor && pm2 start server.js --name evpro"
echo "3. 開機自啟:  pm2 save && pm2 startup"
echo "4. 查看日誌:  pm2 logs evpro"
echo "5. LINE Webhook 設為: http://你的VM外部IP:3000/webhook"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━"
