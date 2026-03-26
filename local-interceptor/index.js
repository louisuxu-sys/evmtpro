'use strict';
require('dotenv').config();

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');

puppeteer.use(StealthPlugin());

// ===== 設定 =====
const RENDER_URL  = (process.env.RENDER_URL  || 'https://evmtpro.onrender.com').replace(/\/$/, '');
const API_KEY     = process.env.INGEST_API_KEY || '';
const MT_URL      = process.env.MT_PAGE_URL  || 'https://seofufan.seogrwin1688.com/';
const MT_USER     = process.env.MT_USERNAME  || '';
const MT_PASS     = process.env.MT_PASSWORD  || '';
const HEADLESS    = process.env.HEADLESS === 'true';

const BATCH_INTERVAL_MS = 300;   // 每 300ms 送一批
const MAX_BATCH_SIZE    = 50;    // 每批最多 50 筆

// ===== 批次緩衝 =====
let batch   = [];
let sending = false;
let totalSent = 0;

async function flush() {
  if (sending || batch.length === 0) return;
  sending = true;
  const msgs = batch.splice(0, MAX_BATCH_SIZE);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['x-api-key'] = API_KEY;

    await axios.post(`${RENDER_URL}/api/mt/ingest`, msgs, {
      headers,
      timeout: 8000
    });
    totalSent += msgs.length;
    process.stdout.write('.');
    if (totalSent % 100 === 0) process.stdout.write(` [${totalSent}]\n`);
  } catch (e) {
    process.stdout.write('\n');
    console.warn(`⚠️  POST 失敗: ${e.message}`);
    // 把未送出的放回 (避免遺失)
    batch.unshift(...msgs.slice(0, 10));
  }
  sending = false;
}

setInterval(flush, BATCH_INTERVAL_MS);

// ===== WS 訊息解析 =====
function parseWsPayload(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const results = [];
  // 直接 JSON
  try {
    const m = JSON.parse(raw);
    if (m && typeof m === 'object') return [m];
  } catch (e) {}
  // SignalR \x1e 分隔
  const parts = raw.split('\x1e').filter(p => p.trim());
  for (const part of parts) {
    try {
      const m = JSON.parse(part);
      if (m && typeof m === 'object') results.push(m);
    } catch (e) {}
  }
  return results;
}

// 只轉發百家樂相關的 DD 訊息
function isRelevant(msg) {
  return msg && msg.D && msg.SI;
}

// ===== CDP 附加 =====
async function attachCDP(page, wsMap, label) {
  try {
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');

    cdp.on('Network.webSocketCreated', ({ requestId, url }) => {
      wsMap.set(requestId, url);
      if (url.includes('rbjork') || url.includes('ofalive') || url.includes('doubledragon') || url.includes('playerhub')) {
        console.log(`\n🔌 [${label}] MT WS 已連線: ${url}`);
      }
    });

    cdp.on('Network.webSocketClosed', ({ requestId }) => {
      const url = wsMap.get(requestId) || '';
      wsMap.delete(requestId);
      if (url.includes('rbjork') || url.includes('doubledragon')) {
        console.log(`\n🔌 [${label}] MT WS 斷線: ${url}`);
      }
    });

    cdp.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
      if (!response.payloadData) return;
      const url = wsMap.get(requestId) || '';
      const msgs = parseWsPayload(response.payloadData);
      for (const m of msgs) {
        if (isRelevant(m)) batch.push(m);
      }
    });

    return cdp;
  } catch (e) {
    console.error(`⚠️  CDP 附加失敗 [${label}]:`, e.message);
    return null;
  }
}

// ===== 輔助函數 =====
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ===== 自動登入 =====
async function autoLogin(page) {
  try {
    console.log(`\n🌐 前往 MT 平台: ${MT_URL}`);
    await page.goto(MT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    if (!MT_USER || !MT_PASS) {
      console.log('⚠️  未設定 MT_USERNAME / MT_PASSWORD');
      console.log('   請手動在瀏覽器視窗中登入，然後進入 MT 百家樂廳');
      return;
    }

    console.log('🔑 自動登入中...');

    // 填帳號
    const userSel = 'input[type="text"], input[name="account"], input[name="username"], input[placeholder*="帳"], input[placeholder*="account" i]';
    try {
      const userInput = await page.$(userSel);
      if (userInput) {
        await userInput.click({ clickCount: 3 });
        await userInput.type(MT_USER, { delay: 50 });
      }
    } catch (e) {}

    await sleep(400);

    // 填密碼
    try {
      const passInput = await page.$('input[type="password"]');
      if (passInput) {
        await passInput.click({ clickCount: 3 });
        await passInput.type(MT_PASS, { delay: 50 });
      }
    } catch (e) {}

    await sleep(400);

    // 點登入
    const loginClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
      for (const btn of btns) {
        const t = (btn.textContent || btn.value || '').trim();
        if (/(登入|登录|Login|Sign\s*in)/i.test(t) && btn.offsetWidth > 0) {
          btn.click();
          return t;
        }
      }
      return null;
    });
    if (loginClicked) console.log(`✅ 已點擊 [${loginClicked}]`);

    await sleep(4000);

    // 關閉彈窗
    for (let i = 0; i < 6; i++) {
      const closed = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('button, a, div, span, i'));
        for (const el of all) {
          const t = (el.textContent || '').trim();
          const cls = el.className || '';
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
          if (/^[×✕✗xX关關]$/.test(t) || /close|dismiss|modal-close/i.test(cls)) {
            el.click();
            return true;
          }
        }
        return false;
      });
      if (!closed) break;
      await sleep(600);
    }

    // 點「真人視訊」
    await sleep(2000);
    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('a, div, span, button, li'));
      for (const el of all) {
        const t = (el.textContent || '').trim();
        if ((t === '真人視訊' || t === '真人' || t === 'Live Casino') && el.offsetWidth > 0) {
          el.click();
          return;
        }
      }
    });

    await sleep(3000);

    // 攔截 window.open（MT 遊戲在 popup 裡）
    await page.evaluate(() => {
      window.__popupUrl = null;
      const orig = window.open;
      window.open = function(url, ...a) {
        window.__popupUrl = url;
        return orig.call(this, url, ...a);
      };
    });

    // 點「MT真人」
    const mtClicked = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'));
      for (const el of all) {
        const t = (el.textContent || '').trim();
        if (t !== 'MT真人' && t !== 'MT 真人') continue;
        let parent = el.parentElement;
        for (let d = 0; d < 6 && parent; d++) {
          if (parent.tagName === 'A' || parent.onclick || parent.getAttribute('onclick')) {
            parent.click();
            return 'link';
          }
          const rect = parent.getBoundingClientRect();
          if (rect.width > 50 && rect.width < 400 && rect.height > 50) {
            const img = parent.querySelector('img');
            if (img) { img.click(); return 'img'; }
            parent.click();
            return 'card';
          }
          parent = parent.parentElement;
        }
      }
      return null;
    });

    if (mtClicked) {
      console.log(`✅ 已點擊 MT真人 (${mtClicked})`);
    } else {
      console.log('⚠️  找不到 MT真人，請手動點擊進入百家樂廳');
    }

  } catch (e) {
    console.error('❌ 自動登入錯誤:', e.message);
    console.log('   請手動在瀏覽器視窗中完成登入');
  }
}

// ===== 主程式 =====
async function main() {
  console.log('');
  console.log('🚀 MT 本地攔截器啟動');
  console.log(`📡 Render: ${RENDER_URL}`);
  console.log(`🔑 API Key: ${API_KEY ? '已設定' : '未設定'}`);
  console.log(`👤 MT帳號: ${MT_USER ? MT_USER : '未設定 (需手動登入)'}`);
  console.log('');

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-popup-blocking',
      '--window-size=1280,900'
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    defaultViewport: null
  });

  const wsMap = new Map();
  const page  = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // 附加 CDP 到主頁面
  await attachCDP(page, wsMap, 'main');

  // 監聽 popup 視窗（MT 在新視窗開遊戲）
  let popupCount = 0;
  browser.on('targetcreated', async (target) => {
    if (target.type() !== 'page') return;
    const newPage = await target.page();
    if (!newPage) return;
    popupCount++;
    const label = `popup${popupCount}`;
    console.log(`\n📄 偵測到新視窗 [${label}]`);

    const popupWsMap = new Map();
    await attachCDP(newPage, popupWsMap, label);

    // 多次重試以確保攔截到 WS
    for (let i = 0; i < 5; i++) {
      await sleep(5000);
      await attachCDP(newPage, popupWsMap, `${label}-retry${i+1}`);
    }
  });

  browser.on('disconnected', () => {
    console.log('\n❌ 瀏覽器已關閉');
    process.exit(0);
  });

  // 自動登入
  await autoLogin(page);

  console.log('\n⏳ 等待 MT WebSocket 資料...');
  console.log('   每個 "." 代表一批資料已送到 Render');
  console.log('   若畫面無回應，請手動點擊進入 MT 百家樂廳\n');

  // 保持程式執行 + 定期狀態報告
  setInterval(() => {
    const pending = batch.length;
    if (pending > 0) console.log(`\n📦 待送批次: ${pending} 筆`);
  }, 60000);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
