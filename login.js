/**
 * MT 平台登入工具
 * 打開可見瀏覽器讓你手動登入，登入後自動儲存 cookies
 * 之後 server.js 會用儲存的 cookies 自動連線
 * 
 * 使用方式: node login.js
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const COOKIES_PATH = path.join(__dirname, '.mt-cookies.json');
const MT_URL = process.env.MT_PAGE_URL || 'https://gsa.ofalive99.net';
const USER_DATA_DIR = path.join(__dirname, '.mt-browser-data');

async function main() {
  console.log('🎰 百家之眼 - MT 平台登入工具');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('即將打開瀏覽器，請透過娛樂城登入 MT 平台');
  console.log('登入成功看到遊戲大廳後，回來按 Enter 儲存');
  console.log('');

  // 用持久化的 user data dir，保持所有 cookies/localStorage
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: USER_DATA_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1280,800'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // 如果有之前儲存的 cookies，先載入
  if (fs.existsSync(COOKIES_PATH)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
      await page.setCookie(...cookies);
      console.log('📝 已載入之前的 cookies');
    } catch (e) {}
  }

  console.log(`🌐 正在打開: ${MT_URL}`);
  await page.goto(MT_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  console.log('');
  console.log('✅ 瀏覽器已打開！');
  console.log('');
  console.log('📋 步驟:');
  console.log('  1. 在瀏覽器中透過娛樂城登入');
  console.log('  2. 確認能看到 MT 遊戲大廳（百家樂桌台）');
  console.log('  3. 回到這裡按 Enter 儲存登入狀態');
  console.log('');

  // 等待用戶按 Enter
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
  });

  // 儲存所有 cookies
  const cookies = await page.cookies();
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  console.log(`✅ 已儲存 ${cookies.length} 個 cookies 到 ${COOKIES_PATH}`);

  // 也儲存 localStorage 中的 token（如果有的話）
  try {
    const localStorage = await page.evaluate(() => {
      const items = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        items[key] = window.localStorage.getItem(key);
      }
      return items;
    });
    fs.writeFileSync(
      path.join(__dirname, '.mt-localstorage.json'),
      JSON.stringify(localStorage, null, 2)
    );
    console.log(`✅ 已儲存 localStorage (${Object.keys(localStorage).length} 項)`);
  } catch (e) {}

  await browser.close();

  console.log('');
  console.log('🎉 登入狀態已儲存！');
  console.log('現在可以執行 node server.js，會自動用此登入狀態連線');
  console.log('不需要再打開任何瀏覽器');
}

main().catch(err => {
  console.error('錯誤:', err.message);
  process.exit(1);
});
