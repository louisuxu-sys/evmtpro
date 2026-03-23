#!/bin/bash
# 百家之眼 - 一鍵啟動腳本 (Xvfb + PM2 + ngrok)
# 用法: bash ~/evmtpro/start-all.sh

set -e

echo "🎰 百家之眼 - 啟動所有服務..."

# 1. 啟動 Xvfb 虛擬螢幕
if ! pgrep -x Xvfb > /dev/null; then
  echo "🖥️  啟動 Xvfb..."
  Xvfb :99 -screen 0 1280x800x24 &
  sleep 2
  echo "✅ Xvfb 已啟動"
else
  echo "✅ Xvfb 已在運行"
fi
export DISPLAY=:99

# 2. 啟動 PM2 (server.js)
echo "🚀 啟動 PM2..."
cd ~/evmtpro
pm2 start ecosystem.config.js 2>/dev/null || pm2 restart evpro
echo "✅ PM2 已啟動"

# 3. 啟動 ngrok (背景)
if ! pgrep -x ngrok > /dev/null; then
  echo "🔗 啟動 ngrok..."
  nohup /snap/bin/ngrok http 3000 --log=stdout > ~/ngrok.log 2>&1 &
  sleep 3
  # 取得 ngrok URL
  NGROK_URL=$(curl -s http://127.0.0.1:4040/api/tunnels | grep -o '"public_url":"https://[^"]*' | head -1 | cut -d'"' -f4)
  echo "✅ ngrok 已啟動"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "🔗 ngrok URL: ${NGROK_URL}"
  echo "📡 LINE Webhook: ${NGROK_URL}/webhook"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "⚠️  記得到 LINE Developers 更新 Webhook URL！"
else
  NGROK_URL=$(curl -s http://127.0.0.1:4040/api/tunnels | grep -o '"public_url":"https://[^"]*' | head -1 | cut -d'"' -f4)
  echo "✅ ngrok 已在運行: ${NGROK_URL}"
fi

echo ""
echo "🎰 所有服務已啟動！"
echo "📋 查看日誌: pm2 logs evpro"
echo "📋 查看 ngrok: cat ~/ngrok.log"
