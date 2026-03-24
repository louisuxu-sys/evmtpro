/**
 * MT 平台自動連線器 (Puppeteer + CDP + 遠端登入)
 * 在雲端（Render）用 headless 瀏覽器連接 MT
 * 提供遠端登入介面讓管理者透過網頁操作瀏覽器登入
 * 登入後用 CDP 被動監聽 WebSocket 流量
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

class MTConnector extends EventEmitter {
  constructor(config = {}) {
    super();
    this.pageUrl = config.pageUrl || 'https://gsa.ofalive99.net';
    this.connected = false;
    this.browser = null;
    this.page = null;
    this.cdp = null;
    this.tables = new Map();
    this.reconnectTimer = null;
    this.reconnectDelay = 10000;
    this.messageLog = [];
    this.logMessages = config.logMessages || false;
    this._wsMap = new Map();
    this._loginMode = false; // 是否在遠端登入模式
  }

  // ===== 啟動瀏覽器（不導航，等遠端登入）=====
  async launchBrowser() {
    if (this.browser) {
      try { await this.browser.close(); } catch (e) {}
    }

    console.log('🔌 MT連線器: 啟動瀏覽器...');
    const launchOpts = {
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-popup-blocking',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800'
      ],
      ignoreDefaultArgs: ['--enable-automation']
    };
    // Render/Docker 環境用系統 Chromium
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    this.browser = await puppeteer.launch(launchOpts);

    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1280, height: 800 });
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // 啟動 CDP 監聽
    await this._attachCDP(this.page);

    // 監聽 popup（新視窗/分頁）— 娛樂城點MT會開新視窗
    this.browser.on('targetcreated', async (target) => {
      if (target.type() === 'page') {
        try {
          const newPage = await target.page();
          if (!newPage) return;
          const url = newPage.url();
          console.log(`🔗 MT連線器: 偵測到新視窗 ${url}`);
          // 切換到新頁面
          this.page = newPage;
          await this.page.setViewport({ width: 1280, height: 800 });

          // 立即 attach CDP（不等頁面載入完，避免錯過早期 WS）
          await this._attachCDP(newPage);
          console.log('✅ MT連線器: 已切換到新視窗並附加 CDP');

          // 持續監控：等頁面載入 + 多次重新 attach CDP
          for (let retry = 0; retry < 6; retry++) {
            await new Promise(r => setTimeout(r, 5000));
            if (this.connected) {
              console.log('🎉 MT連線器: WebSocket 已連線！');
              break;
            }
            const curUrl = await newPage.url();
            const curTitle = await newPage.title();
            console.log(`🔄 MT連線器: 重試 CDP (${retry+1}/6) URL=${curUrl.substring(0,80)} title=${curTitle}`);
            await this._attachCDP(newPage);

            // 如果頁面 URL 改變了（跳轉完成），再等多一點
            if (!curUrl.includes('loading')) {
              console.log('📄 MT連線器: 頁面已跳轉，等待 WS...');
              await new Promise(r => setTimeout(r, 5000));
              if (this.connected) {
                console.log('🎉 MT連線器: WebSocket 已連線！');
                break;
              }
            }
          }
        } catch (e) {
          console.error('⚠️ 新視窗處理錯誤:', e.message);
        }
      }
    });

    // 監控瀏覽器關閉
    this.browser.on('disconnected', () => {
      this.connected = false;
      this.emit('disconnected', { reason: 'browser disconnected' });
    });

    console.log('✅ MT連線器: 瀏覽器已就緒');
    return true;
  }

  // 在指定頁面上附加 CDP 監聽
  async _attachCDP(page) {
    try {
      if (this.cdp) {
        try { await this.cdp.detach(); } catch (e) {}
      }
      this.cdp = await page.createCDPSession();
      await this.cdp.send('Network.enable');
      this._wsMap.clear();
      this._setupCDPListeners();
    } catch (e) {
      console.error('⚠️ CDP 附加錯誤:', e.message);
    }
  }

  // 設定 CDP WebSocket 監聯
  _setupCDPListeners() {
    this.cdp.on('Network.webSocketCreated', ({ requestId, url }) => {
      this._wsMap.set(requestId, url);
      console.log(`🔌 CDP: WS 建立 ${url}`);
      // 接受 MT 相關的 WS（rbjork/ofalive/playerhub/doubledragon 等）
      if (url.includes('rbjork') || url.includes('ofalive') || url.includes('/game/ws') || url.includes('playerhub') || url.includes('doubledragon')) {
        console.log(`✅ MT連線器: Game WebSocket 已連線 ${url}`);
        this.connected = true;
        this._gameWsId = requestId;
        this._loginMode = false;
        this.emit('connected');
        // 啟動 DOM 定期讀取
        this._startDOMScraper();
      }
    });

    this.cdp.on('Network.webSocketClosed', ({ requestId }) => {
      const url = this._wsMap.get(requestId) || '';
      this._wsMap.delete(requestId);
      console.log(`🔌 CDP: WS 關閉 ${url}`);
      if (requestId === this._gameWsId || url.includes('/game/ws')) {
        console.log(`🔌 MT連線器: Game WebSocket 斷線`);
        this.connected = false;
      }
    });

    this.cdp.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
      const url = this._wsMap.get(requestId) || '';
      // 接受所有 WS 訊息，不再限制 /game/ws
      try {
        if (response.payloadData) {
          this._onWsMessage(url, response.payloadData);
        }
      } catch (e) {}
    });
  }

  // ===== 遠端登入控制 =====
  async navigate(url) {
    if (!this.page) return;
    console.log(`🌐 MT連線器: 導航到 ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  async screenshot() {
    if (!this.page) return null;
    return await this.page.screenshot({ type: 'jpeg', quality: 70 });
  }

  async click(x, y) {
    if (!this.page) return;
    await this.page.mouse.click(x, y);
  }

  async type(text) {
    if (!this.page) return;
    await this.page.keyboard.type(text);
  }

  async pressKey(key) {
    if (!this.page) return;
    await this.page.keyboard.press(key);
  }

  async getPageInfo() {
    if (!this.page) return { url: '', title: '' };
    return {
      url: this.page.url(),
      title: await this.page.title()
    };
  }

  // 開始遠端登入模式
  async startLogin(url) {
    this._loginMode = true;
    if (!this.browser) await this.launchBrowser();
    const targetUrl = url || this.pageUrl;
    await this.navigate(targetUrl);
    return true;
  }

  // ===== 全自動登入 =====
  async autoLogin() {
    const casinoUrl = process.env.MT_CASINO_URL;
    const username = process.env.MT_CASINO_USERNAME;
    const password = process.env.MT_CASINO_PASSWORD;

    if (!casinoUrl || !username || !password) {
      console.log('⚠️  自動登入: 未設定 MT_CASINO_URL / MT_CASINO_USERNAME / MT_CASINO_PASSWORD');
      console.log('   請到管理員介面手動登入: /admin/login?key=ADMIN_KEY');
      return false;
    }

    console.log('🤖 自動登入: 開始...');
    if (!this.browser) await this.launchBrowser();

    try {
      // 1. 打開娛樂城
      console.log(`🌐 自動登入: 前往 ${casinoUrl}`);
      await this.page.goto(casinoUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await this._sleep(5000);

      // 診斷頁面狀態
      const loginDiag = await this.page.evaluate(() => {
        const inputs = document.querySelectorAll('input');
        const iframes = document.querySelectorAll('iframe');
        return {
          url: location.href,
          title: document.title,
          inputCount: inputs.length,
          iframeCount: iframes.length,
          iframeSrcs: Array.from(iframes).map(f => f.src || '').slice(0, 5),
          bodyLen: document.body?.innerHTML?.length || 0,
          bodyText: document.body?.innerText?.substring(0, 200) || ''
        };
      });
      console.log(`🔍 登入頁診斷: URL=${loginDiag.url} inputs=${loginDiag.inputCount} iframes=${loginDiag.iframeCount} bodyLen=${loginDiag.bodyLen}`);
      console.log(`🔍 登入頁診斷: title=${loginDiag.title}`);
      if (loginDiag.iframeCount > 0) {
        console.log(`🔍 登入頁 iframes: ${JSON.stringify(loginDiag.iframeSrcs)}`);
      }
      console.log(`🔍 登入頁 body: ${loginDiag.bodyText.substring(0, 100)}`);

      // 如果主頁面沒有 input，檢查 iframe
      if (loginDiag.inputCount === 0 && loginDiag.iframeCount > 0) {
        console.log('🔍 自動登入: 主頁面無 input，檢查 iframe...');
        for (const frame of this.page.frames()) {
          const fInputs = await frame.evaluate(() => document.querySelectorAll('input').length).catch(() => 0);
          if (fInputs > 0) {
            console.log(`🔍 找到 iframe 有 ${fInputs} 個 input: ${frame.url().substring(0, 80)}`);
          }
        }
      }

      // 如果沒有 input，等更久再試
      if (loginDiag.inputCount === 0) {
        console.log('⏳ 自動登入: 等待頁面完全載入...');
        await this._sleep(5000);
      }

      // 2. 尋找帳號密碼欄位並填入
      console.log('🔑 自動登入: 填入帳號密碼...');

      // 嘗試多種常見選擇器
      const filled = await this.page.evaluate((user, pass) => {
        // 找所有 input 欄位
        const inputs = Array.from(document.querySelectorAll('input'));
        let userInput = null;
        let passInput = null;

        for (const inp of inputs) {
          const type = (inp.type || '').toLowerCase();
          const name = (inp.name || '').toLowerCase();
          const placeholder = (inp.placeholder || '').toLowerCase();
          const id = (inp.id || '').toLowerCase();

          // 帳號欄位
          if (!userInput && (
            type === 'text' || type === 'tel' || type === '' ||
            name.includes('user') || name.includes('account') || name.includes('login') ||
            placeholder.includes('帳號') || placeholder.includes('用戶') || placeholder.includes('username') ||
            id.includes('user') || id.includes('account')
          ) && type !== 'password' && type !== 'hidden') {
            userInput = inp;
          }

          // 密碼欄位
          if (!passInput && type === 'password') {
            passInput = inp;
          }
        }

        if (userInput && passInput) {
          // 清除 + 填入
          userInput.focus();
          userInput.value = '';
          userInput.dispatchEvent(new Event('input', { bubbles: true }));
          userInput.value = user;
          userInput.dispatchEvent(new Event('input', { bubbles: true }));
          userInput.dispatchEvent(new Event('change', { bubbles: true }));

          passInput.focus();
          passInput.value = '';
          passInput.dispatchEvent(new Event('input', { bubbles: true }));
          passInput.value = pass;
          passInput.dispatchEvent(new Event('input', { bubbles: true }));
          passInput.dispatchEvent(new Event('change', { bubbles: true }));

          return { found: true, userField: userInput.name || userInput.id, passField: passInput.name || passInput.id };
        }

        return { found: false, inputCount: inputs.length };
      }, username, password);

      if (!filled.found) {
        console.log(`⚠️  自動登入: 找不到帳密欄位 (共 ${filled.inputCount} 個 input)`);
        console.log('   請到管理員介面手動登入');
        this._loginMode = true;
        return false;
      }

      console.log(`✅ 自動登入: 已填入帳密 (${filled.userField} / ${filled.passField})`);
      await this._sleep(500);

      // 3. 點擊登入按鈕
      const clicked = await this.page.evaluate(() => {
        // 找登入按鈕
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
        for (const btn of buttons) {
          const text = (btn.textContent || btn.value || '').trim();
          if (text.includes('登入') || text.includes('登录') || text.includes('Login') || text.includes('Sign in')) {
            btn.click();
            return { clicked: true, text };
          }
        }
        // 備用：找 form 然後 submit
        const form = document.querySelector('form');
        if (form) {
          form.submit();
          return { clicked: true, text: 'form.submit()' };
        }
        return { clicked: false };
      });

      if (clicked.clicked) {
        console.log(`✅ 自動登入: 點擊登入 [${clicked.text}]`);
      } else {
        console.log('⚠️  自動登入: 找不到登入按鈕，嘗試按 Enter');
        await this.page.keyboard.press('Enter');
      }

      // 4. 等待登入完成
      console.log('⏳ 自動登入: 等待登入結果...');
      await this._sleep(5000);

      const afterLoginUrl = this.page.url();
      console.log(`📍 自動登入: 目前頁面 ${afterLoginUrl}`);

      // 4.5 關閉公告彈窗（可能有多個，如 1/3, 2/3, 3/3）
      console.log('📢 自動登入: 關閉公告彈窗...');
      for (let i = 0; i < 10; i++) {
        await this._sleep(1500);
        const dismissed = await this.page.evaluate(() => {
          // 找「確認」「確定」「關閉」「我知道了」按鈕
          const btns = Array.from(document.querySelectorAll('button, a, div, span'));
          for (const btn of btns) {
            const text = (btn.textContent || '').trim();
            const style = window.getComputedStyle(btn);
            // 只點擊可見的按鈕
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
            if (btn.offsetWidth === 0 || btn.offsetHeight === 0) continue;
            if (text === '確認' || text === '確定' || text === '關閉' || text === '我知道了' || text === 'OK' || text === 'Close') {
              btn.click();
              return { found: true, text };
            }
          }
          // 也找 X 關閉按鈕
          const closeBtns = Array.from(document.querySelectorAll('.close, .modal-close, [class*="close"], [aria-label="Close"]'));
          for (const btn of closeBtns) {
            if (btn.offsetWidth > 0 && btn.offsetHeight > 0) {
              btn.click();
              return { found: true, text: 'X close' };
            }
          }
          return { found: false };
        });

        if (dismissed.found) {
          console.log(`  ✅ 已關閉彈窗 [${dismissed.text}] (${i + 1})`);
        } else {
          console.log(`  ✅ 沒有更多彈窗了 (共關閉 ${i} 個)`);
          break;
        }
      }

      // 5. 先點「真人視訊」進入分類頁
      console.log('🎰 自動登入: 尋找「真人視訊」分類...');
      await this._sleep(2000);

      const liveClicked = await this.page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('a, div, span, button, li'));
        for (const el of all) {
          const text = (el.textContent || '').trim();
          // 精確匹配「真人視訊」或「真人」（排除包含太多其他文字的大容器）
          if ((text === '真人視訊' || text === '真人' || text === 'Live Casino') && el.offsetWidth > 0) {
            el.click();
            return { clicked: true, text, tag: el.tagName };
          }
        }
        // 備用：找包含真人視訊的連結
        for (const el of all) {
          const text = (el.textContent || '').trim();
          if (text.includes('真人視訊') && text.length < 20 && el.offsetWidth > 0) {
            el.click();
            return { clicked: true, text, tag: el.tagName };
          }
        }
        return { clicked: false };
      });

      if (liveClicked.clicked) {
        console.log(`✅ 自動登入: 已點擊 [${liveClicked.text}] <${liveClicked.tag}>`);
      } else {
        console.log('⚠️  自動登入: 找不到真人視訊分類，嘗試直接找 MT...');
      }

      // 等待分類頁載入
      await this._sleep(3000);

      // 攔截 window.open，記錄 popup URL
      await this.page.evaluate(() => {
        window.__popupUrl = null;
        const origOpen = window.open;
        window.open = function(url, ...args) {
          window.__popupUrl = url;
          return origOpen.call(this, url, ...args);
        };
      });

      // 5.5 診斷分類頁
      const diagCat = await this.page.evaluate(() => {
        return {
          url: location.href,
          title: document.title,
          bodyText: document.body?.innerText?.substring(0, 300) || ''
        };
      });
      console.log(`🔍 診斷: URL=${diagCat.url}`);
      console.log(`🔍 診斷: body=${diagCat.bodyText.substring(0, 150)}`);

      // 6. 在分類頁中找 MT真人 圖片/連結並點擊
      console.log('🎰 自動登入: 在分類頁尋找 MT真人...');
      await this._sleep(2000);

      // 先找「MT真人」文字的位置，然後點擊它上方的圖片或父容器的連結
      const mtClicked = await this.page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('*'));

        // 策略1: 找精確的「MT真人」文字元素，然後往上找可點擊的父元素（a 或有 onclick）
        for (const el of all) {
          const text = (el.textContent || '').trim();
          if (text !== 'MT真人' && text !== 'MT 真人') continue;
          // 找到了「MT真人」文字，往上找可點擊的父元素
          let parent = el.parentElement;
          for (let depth = 0; depth < 5 && parent; depth++) {
            if (parent.tagName === 'A' || parent.onclick || parent.getAttribute('onclick')) {
              parent.click();
              return { clicked: true, text: 'MT真人 parent link', tag: parent.tagName, method: 'parent-link' };
            }
            // 如果父元素是一個合理大小的卡片容器（大概 100-300px 寬）
            const rect = parent.getBoundingClientRect();
            if (rect.width > 50 && rect.width < 300 && rect.height > 50) {
              // 找這個容器裡的圖片
              const img = parent.querySelector('img');
              if (img) {
                img.click();
                return { clicked: true, text: 'MT真人 card img', tag: 'IMG', method: 'card-img' };
              }
              parent.click();
              return { clicked: true, text: 'MT真人 card', tag: parent.tagName, method: 'card-click' };
            }
            parent = parent.parentElement;
          }
          // 直接點擊文字元素本身
          el.click();
          return { clicked: true, text: 'MT真人 text', tag: el.tagName, method: 'text-click' };
        }

        // 策略2: 找圖片 alt 或 title 包含 MT
        const imgs = Array.from(document.querySelectorAll('img'));
        for (const img of imgs) {
          const alt = (img.alt || img.title || '').trim();
          const src = img.src || '';
          if (alt.includes('MT') || src.toLowerCase().includes('mt')) {
            // 先嘗試點擊圖片的父連結
            const parentA = img.closest('a');
            if (parentA) {
              parentA.click();
              return { clicked: true, text: `img alt=${alt}`, tag: 'A', method: 'img-parent-a' };
            }
            img.click();
            return { clicked: true, text: `img alt=${alt}`, tag: 'IMG', method: 'img-click' };
          }
        }

        // 策略3: 找所有遊戲卡片中帶 MT 的
        const cards = Array.from(document.querySelectorAll('[class*="game"], [class*="card"], [class*="item"], [class*="product"]'));
        for (const card of cards) {
          const text = (card.textContent || '').trim();
          if (text.includes('MT') && text.includes('真人')) {
            const a = card.querySelector('a');
            if (a) { a.click(); return { clicked: true, text: 'MT card link', tag: 'A', method: 'card-a' }; }
            const img = card.querySelector('img');
            if (img) { img.click(); return { clicked: true, text: 'MT card img', tag: 'IMG', method: 'card-img2' }; }
            card.click();
            return { clicked: true, text: 'MT card', tag: card.tagName, method: 'card-direct' };
          }
        }

        return { clicked: false };
      });

      if (!mtClicked.clicked) {
        console.log('⚠️  自動登入: 找不到 MT真人 入口');
        // 列出頁面上的元素供調試
        const dbg = await this.page.evaluate(() => {
          const items = [];
          document.querySelectorAll('img').forEach(img => {
            if (img.offsetWidth > 30) items.push({ type: 'img', alt: img.alt || '', src: img.src?.substring(0, 80), w: img.offsetWidth });
          });
          document.querySelectorAll('a').forEach(a => {
            const text = a.textContent?.trim();
            if (text && text.length < 30 && a.offsetWidth > 0) items.push({ type: 'a', text, href: a.href?.substring(0, 80) });
          });
          return items.slice(0, 25);
        }).catch(() => []);
        console.log('🔍 頁面元素:', JSON.stringify(dbg));
        this._loginMode = true;
        return false;
      }

      console.log(`✅ 自動登入: 已點擊 MT真人 [${mtClicked.text}] (${mtClicked.method})`);
      const pagesBefore = (await this.browser.pages()).length;

      // 5.5 診斷點擊後的頁面狀態
      await this._sleep(3000);
      const diag = await this.page.evaluate(() => {
        const iframes = document.querySelectorAll('iframe');
        const iframeInfo = Array.from(iframes).map(f => ({ src: f.src || f.getAttribute('src') || '', w: f.offsetWidth, h: f.offsetHeight }));
        return {
          url: location.href,
          title: document.title,
          iframeCount: iframes.length,
          iframes: iframeInfo,
          bodyText: document.body?.innerText?.substring(0, 200) || ''
        };
      });
      console.log(`🔍 診斷: URL=${diag.url}`);
      console.log(`🔍 診斷: title=${diag.title}`);
      console.log(`🔍 診斷: iframe數=${diag.iframeCount}`);
      if (diag.iframes.length > 0) {
        diag.iframes.forEach((f, i) => console.log(`🔍 診斷: iframe[${i}] src=${f.src} (${f.w}x${f.h})`));
      }
      console.log(`🔍 診斷: body前200字=${diag.bodyText.substring(0, 100)}`);

      // 如果有 iframe 包含 MT/ofalive，切換到 iframe 監聽
      if (diag.iframes.length > 0) {
        for (const frame of this.page.frames()) {
          const fUrl = frame.url();
          if (fUrl.includes('ofalive') || fUrl.includes('game') || fUrl.includes('mt')) {
            console.log(`🔗 自動登入: 偵測到 MT iframe: ${fUrl}`);
            // 在 iframe 上也 attach CDP
            // CDP 已在主頁面 attach，iframe 的 WS 也會被捕捉
          }
        }
      }

      // 點擊 MT 後可能出現確認彈窗
      console.log('📢 自動登入: 檢查 MT 進入確認彈窗...');
      for (let i = 0; i < 5; i++) {
        await this._sleep(2000);
        const confirmResult = await this.page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, a, div, span'));
          for (const btn of btns) {
            const text = (btn.textContent || '').trim();
            const style = window.getComputedStyle(btn);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            if (btn.offsetWidth === 0 || btn.offsetHeight === 0) continue;
            if (text === '確認' || text === '確定' || text === '進入遊戲' || text === '開始遊戲' || text === '立即進入' || text === 'OK' || text === '前往') {
              btn.click();
              return { found: true, text };
            }
          }
          return { found: false };
        });
        if (confirmResult.found) {
          console.log(`  ✅ 已點擊確認 [${confirmResult.text}] (${i + 1})`);
        } else {
          console.log(`  ✅ 無更多確認彈窗`);
          break;
        }
      }

      // 等待 popup 視窗出現或 WS 連線
      console.log('⏳ 自動登入: 等待 MT 視窗或 WebSocket...');
      for (let w = 0; w < 15; w++) {
        await this._sleep(2000);
        if (this.connected) {
          console.log('🎉 自動登入: 成功！MT WebSocket 已連線');
          return true;
        }
        // 檢查是否有新頁面
        const pagesNow = (await this.browser.pages()).length;
        if (pagesNow > pagesBefore) {
          console.log(`📄 自動登入: 偵測到新頁面 (${pagesBefore} -> ${pagesNow})`);
          // targetcreated 會自動切換並 attach CDP
          break;
        }
      }

      // 如果已連線，直接返回
      if (this.connected) {
        console.log('🎉 自動登入: 成功！MT WebSocket 已連線');
        return true;
      }

      // 檢查頁面數
      const pagesAfter = (await this.browser.pages()).length;
      console.log(`📄 自動登入: 頁面數 ${pagesBefore} -> ${pagesAfter}`);

      // 如果沒有新頁面且未連線，嘗試用攔截到的 popup URL
      if (pagesAfter <= pagesBefore && !this.connected) {
        const popupUrl = await this.page.evaluate(() => window.__popupUrl).catch(() => null);
        if (popupUrl) {
          console.log(`🔗 自動登入: 用 popup URL 導航: ${popupUrl}`);
          await this.page.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          // 重新 attach CDP
          await this._attachCDP(this.page);
        } else {
          console.log('⚠️  自動登入: 沒有偵測到新視窗或 popup URL');
          console.log('   不做 fallback 導航，避免破壞現有連線');
        }
      }

      // 最後等待 WebSocket
      console.log('⏳ 自動登入: 等待 MT WebSocket...');
      for (let i = 0; i < 15; i++) {
        await this._sleep(3000);
        if (this.connected) {
          console.log('🎉 自動登入: 成功！MT WebSocket 已連線');
          return true;
        }
      }

      console.log('⚠️  自動登入: MT 載入超時，可能需要手動操作');
      console.log('   請到管理員介面: /admin/login?key=ADMIN_KEY');
      this._loginMode = true;
      return false;

    } catch (err) {
      console.error('❌ 自動登入失敗:', err.message);
      this._loginMode = true;
      return false;
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ===== DOM 定期讀取（荷官、牌路、統計） =====
  _startDOMScraper() {
    if (this._domInterval) return; // 避免重複啟動
    console.log('🔍 DOM讀取器: 啟動 (每15秒)');

    // 等10秒讓遊戲頁面完全載入
    setTimeout(() => {
      this._domInterval = setInterval(() => this._scrapeDOMTables(), 15000);
      this._scrapeDOMTables(); // 立即執行一次
    }, 10000);
  }

  async _scrapeDOMTables() {
    if (!this.page) return;
    try {
      // 找到遊戲頁面（可能是新視窗）
      const pages = await this.browser.pages();
      let gamePage = null;
      for (const p of pages) {
        const url = await p.url().catch(() => '');
        if (url.includes('ofalive') || url.includes('rbjork') || url.includes('game')) {
          gamePage = p;
          break;
        }
      }
      if (!gamePage) gamePage = this.page;

      const domData = await gamePage.evaluate(() => {
        var result = [];
        var allElements = document.querySelectorAll('*');

        for (var i = 0; i < allElements.length; i++) {
          var el = allElements[i];
          var text = el.innerText || '';
          if (text.length < 10 || text.length > 500) continue;
          if (!text.includes('百家樂')) continue;
          if (!text.includes('莊')) continue;
          if (!text.includes('閒')) continue;

          // 提取桌號
          var tableMatch = text.match(/百家樂\s*(\S+)/);
          var tableNum = tableMatch ? tableMatch[1] : '?';

          // 提取統計
          var statsMatch = text.match(/莊\s*(\d+)\s*(?:.*?)閒\s*(\d+)\s*(?:.*?)和\s*(\d+)/);
          var banker = statsMatch ? parseInt(statsMatch[1]) : 0;
          var player = statsMatch ? parseInt(statsMatch[2]) : 0;
          var tie = statsMatch ? parseInt(statsMatch[3]) : 0;

          // 提取荷官（中文名或英文名）
          var dealer = '';
          var dm = text.match(/中文\s+([\u4e00-\u9fff]+)/);
          if (dm) { dealer = dm[1]; }
          else {
            dm = text.match(/([A-Z][A-Z ]{2,20})(?:\s|$)/);
            if (dm) dealer = dm[1].trim();
          }
          if (!dealer) {
            // 最後一行非數字中文名
            var lines = text.split('\n').filter(l => l.trim());
            for (var j = lines.length - 1; j >= 0; j--) {
              var line = lines[j].trim();
              if (/^[\u4e00-\u9fff]{2,4}$/.test(line)) {
                dealer = line;
                break;
              }
              if (/^[A-Z][A-Z ]{2,15}$/.test(line)) {
                dealer = line;
                break;
              }
            }
          }

          // 提取人數
          var pMatch = text.match(/(\d+)\s*人/);
          var online = pMatch ? parseInt(pMatch[1]) : 0;

          // 牌路文字
          var road = '';
          var roadMatch = text.match(/([莊閒和]{4,})/g);
          if (roadMatch) road = roadMatch.join('');

          result.push({
            tableNum: tableNum,
            banker: banker,
            player: player,
            tie: tie,
            dealer: dealer,
            online: online,
            road: road.substring(0, 60),
            textLen: text.length,
          });
        }

        // 去重
        var seen = {};
        return result.filter(function(r) {
          var key = r.tableNum + '_' + r.banker + '_' + r.player;
          if (seen[key]) return false;
          seen[key] = true;
          return true;
        });
      });

      if (domData && domData.length > 0) {
        if (!this._domLogCount) this._domLogCount = 0;
        this._domLogCount++;

        // 更新 tables Map 裡的荷官和牌路
        for (const d of domData) {
          // 用桌號匹配已有的 table
          for (const [tableId, info] of this.tables) {
            const existNum = String(info.tableNum || '');
            if (existNum === String(d.tableNum) || tableId.includes(d.tableNum)) {
              if (d.dealer && d.dealer !== '') {
                info.dealer = { name: d.dealer };
              }
              if (d.road) info.roadText = d.road;
              if (d.online) info.onlinePlayers = d.online;
            }
          }
        }

        // 每5次輸出一次日誌
        if (this._domLogCount <= 3 || this._domLogCount % 5 === 0) {
          console.log(`🔍 DOM讀取: ${domData.length} 張桌 | 範例: ${domData.slice(0, 3).map(d => `${d.tableNum}(${d.dealer || '?'})`).join(', ')}`);
        }

        // 發出 DOM 更新事件
        this.emit('dom_update', domData);
      } else {
        if (!this._domEmptyCount) this._domEmptyCount = 0;
        this._domEmptyCount++;
        if (this._domEmptyCount <= 3) {
          console.log('🔍 DOM讀取: 未找到百家樂桌');
        }
      }
    } catch (e) {
      // 靜默失敗，避免打斷 WS
    }
  }

  // 處理從瀏覽器收到的 WebSocket 訊息
  _onWsMessage(wsUrl, rawData) {
    // 記錄前 50 筆原始訊息（排除空的和心跳）
    if (!this._rawMsgCount) this._rawMsgCount = 0;
    const dataStr = String(rawData).trim();
    if (dataStr.length > 5 && dataStr !== '{}') {
      this._rawMsgCount++;
      if (this._rawMsgCount <= 50) {
        console.log(`📩 WS原始[${this._rawMsgCount}] (${wsUrl.substring(wsUrl.lastIndexOf('/'), wsUrl.lastIndexOf('/') + 30)}): ${dataStr.substring(0, 500)}`);
      }
    }

    try {
      const msg = JSON.parse(rawData);

      if (this.logMessages) {
        this.messageLog.push({ time: new Date().toISOString(), wsUrl, msg });
        if (this.messageLog.length > 500) this.messageLog.shift();
      }

      this.handleMessage(msg);
    } catch (err) {
      // 非 JSON 訊息 - 可能是 SignalR 格式或其他分隔格式
      if (typeof rawData === 'string') {
        // SignalR 用 \x1e (Record Separator) 分隔
        const sep = rawData.includes('\x1e') ? '\x1e' : null;
        if (sep) {
          const parts = rawData.split(sep).filter(p => p.trim());
          for (const part of parts) {
            try {
              const msg = JSON.parse(part);
              if (this.logMessages) {
                this.messageLog.push({ time: new Date().toISOString(), wsUrl, msg });
                if (this.messageLog.length > 500) this.messageLog.shift();
              }
              this.handleMessage(msg);
            } catch (e) {}
          }
        }
      }
    }
  }

  // ===== 訊息處理 =====
  handleMessage(msg) {
    // === SignalR 格式: { type: 1, target: "MethodName", arguments: [...] } ===
    if (msg.type === 1 && msg.target && msg.arguments) {
      this._handleSignalRMessage(msg);
      return;
    }

    // === doubledragon 格式: { D: { Summary: {...}, List: [...] }, C: 301, SI: "gc023002" } ===
    if (msg.D && msg.SI) {
      this._handleDDMessage(msg);
      return;
    }

    // === 原始 MT 格式 ===
    // 取得 action 名稱（兩種格式）
    let actionName = '';
    if (typeof msg.action === 'string') {
      actionName = msg.action;
    } else if (msg.action && msg.action.name) {
      actionName = msg.action.name;
    }

    // 牌桌列表
    if (actionName.includes('/tables') && !actionName.includes('/table/')) {
      this.handleTablesUpdate(msg);
      return;
    }

    // 開牌結果 - summary 或 show_poker 包含牌面資料
    if (actionName.includes('/summary') || actionName.includes('/show_poker')) {
      this.handleSummary(msg);
      return;
    }

    // 贏家公布
    if (actionName.includes('/show_win')) {
      this.handleShowWin(msg);
      return;
    }

    // 路紙更新
    if (actionName.includes('/road')) {
      this.handleRoadUpdate(msg);
      return;
    }

    // 遊戲狀態 (wait, end, deal, bet, etc.)
    if (actionName.includes('/wait') || actionName.includes('/end') ||
        actionName.includes('/deal') || actionName.includes('/bet')) {
      return; // 靜默處理
    }

    // 會員/系統訊息 - 靜默
    if (actionName.includes('/member') || actionName.includes('/chat') ||
        actionName.includes('/authenticate') || actionName.includes('/balance') ||
        actionName.includes('/logout') || actionName.includes('/banner')) {
      return;
    }
  }

  // ===== doubledragon 格式處理 =====
  _handleDDMessage(msg) {
    const d = msg.D;
    const tableId = msg.SI; // e.g. "gc023002"
    const tableNum = msg.C; // e.g. 301

    if (!tableId) return;

    // Summary 訊息 — 包含牌桌統計 + 歷史記錄
    if (d.Summary) {
      const summary = d.Summary;

      // 只收百家樂桌：必須有 Banker 和 Player 欄位（且是數字）
      if (summary.Banker === undefined || summary.Player === undefined) return;
      if (typeof summary.Banker !== 'number' || typeof summary.Player !== 'number') return;

      // 只收 gc + 5~6 位數字 的百家樂桌 (排除 GCBC、純數字長編號等)
      // 有效: gc011012, gc023002, gc020001, gc011015
      // 排除: GCBC20201106, 2012160125, 2201050144
      if (!/^gc\d{5,6}$/i.test(tableId)) return;

      // 從 SI 提取桌號：gc011012 → 取後3~4位得到實際桌號
      // gc011012: 011=系列 012=桌號? 或者最後3位 012
      // gc023002: 023=系列 002=桌號?
      // 直接用完整 SI 作為唯一標識，在 DOM 讀取時再匹配正確桌號
      const tableName = `百家樂 ${tableId}`;
      console.log(`🔍 DD桌 SI=${tableId} C=${tableNum} Total=${summary.Total} B=${summary.Banker} P=${summary.Player} T=${summary.Tie}`);

      // 建立/更新牌桌
      if (!this.tables.has(tableId)) {
        const info = {
          tableId,
          tableName,
          tableNum: tableNum || 0,
          dealer: { name: '-' },
          shoe: null,
          round: summary.Total || 0,
          state: 'active',
          hall: '',
          summary: {
            total: summary.Total || 0,
            banker: summary.Banker || 0,
            player: summary.Player || 0,
            tie: summary.Tie || 0,
          }
        };
        this.tables.set(tableId, info);
        console.log(`📋 DD: 新牌桌 ${tableName} (${tableId}) 共${summary.Total}局 莊${summary.Banker} 閒${summary.Player} 和${summary.Tie}`);
      } else {
        // 更新統計
        const info = this.tables.get(tableId);
        info.summary = {
          total: summary.Total || 0,
          banker: summary.Banker || 0,
          player: summary.Player || 0,
          tie: summary.Tie || 0,
        };
        info.round = summary.Total || 0;
      }

      // 發出牌桌列表更新
      this.emit('tables_list', Array.from(this.tables.values()));

      // 追蹤最新局號，只 emit 新的開牌
      if (d.List && Array.isArray(d.List) && d.List.length > 0) {
        const lastRound = d.List[d.List.length - 1];
        if (!this._lastRound) this._lastRound = {};
        const lastA = this._lastRound[tableId];
        if (lastRound.A && lastRound.A !== lastA) {
          this._lastRound[tableId] = lastRound.A;
          this._processDDRound(tableId, lastRound, summary);
        }
      }
    }

    // 帶牌面的開牌結果
    if (d.P1 !== undefined || d.Total !== undefined) {
      this._processDDFullResult(tableId, d);
    }
  }

  // 處理 DD 單局結果
  _processDDRound(tableId, round, summary) {
    if (!round) return;
    // round 格式: { A: 局號, G: "B"/"P"/"T", P: 點數 }
    const winner = round.G === 'B' ? 'B' : round.G === 'P' ? 'P' : 'T';

    // 記錄但不 emit（因為沒有完整牌面資料）
    // 只在有完整牌面時才 emit game_result
  }

  // 處理 DD 完整開牌結果（帶 6 張牌面）
  _processDDFullResult(tableId, d) {
    // 格式: Total, P1-P4(閒), B1-B4(莊), WP(閒點), WB(莊點), W(贏家)
    // 或: Total, Banker, Player, Tie, List[{A,P1,P2,P3,P4,B1,B2,B3,B4,WB,WP}]
    let playerCards = [];
    let bankerCards = [];

    // 嘗試讀取牌面
    if (d.P1 !== undefined) {
      [d.P1, d.P2, d.P3].forEach(c => {
        if (c && typeof c === 'object' && c.length === 2) {
          // 牌面格式可能是 [花色, 點數] 或數字
          playerCards.push(this._parseDDCard(c));
        } else if (typeof c === 'number' && c > 0) {
          playerCards.push(this.decodeCardNumber(c));
        }
      });
      [d.B1, d.B2, d.B3].forEach(c => {
        if (c && typeof c === 'object' && c.length === 2) {
          bankerCards.push(this._parseDDCard(c));
        } else if (typeof c === 'number' && c > 0) {
          bankerCards.push(this.decodeCardNumber(c));
        }
      });
    }

    // List 格式中的牌面
    if (d.List && Array.isArray(d.List)) {
      for (const item of d.List) {
        // 帶完整牌面的 List item
        if (item.P1 !== undefined && Array.isArray(item.P1)) {
          playerCards = [item.P1, item.P2, item.P3].filter(c => c).map(c => this._parseDDCard(c));
          bankerCards = [item.B1, item.B2, item.B3].filter(c => c).map(c => this._parseDDCard(c));

          const winner = this.normalizeWinner(item.W || item.G || '');
          const playerTotal = item.WP !== undefined ? item.WP : this.calcTotal(playerCards);
          const bankerTotal = item.WB !== undefined ? item.WB : this.calcTotal(bankerCards);

          if (playerCards.length > 0) {
            console.log(`🃏 DD開牌: ${tableId} 第${item.A || '?'}局 ` +
              `閒[${playerCards.map(c => this.formatCard(c)).join(' ')}]=${playerTotal} ` +
              `莊[${bankerCards.map(c => this.formatCard(c)).join(' ')}]=${bankerTotal} ` +
              `→ ${winner === 'B' ? '莊贏' : winner === 'P' ? '閒贏' : '和'}`);

            this.emit('game_result', {
              tableId,
              shoe: null,
              round: item.A,
              playerCards,
              bankerCards,
              playerTotal,
              bankerTotal,
              winner,
              playerPair: playerCards.length >= 2 && playerCards[0]?.rank === playerCards[1]?.rank,
              bankerPair: bankerCards.length >= 2 && bankerCards[0]?.rank === bankerCards[1]?.rank,
            });
          }
        }
      }
    }
  }

  // 解析 DD 牌面格式
  _parseDDCard(c) {
    if (!c) return null;
    // 如果是數字，用 decodeCardNumber
    if (typeof c === 'number') return this.decodeCardNumber(c);
    // 如果是字串如 "6.0" "8.9" — 格式待確認
    if (typeof c === 'string') {
      const parts = c.split('.');
      if (parts.length === 2) {
        return { rank: parseInt(parts[0]) || 0, suit: 's' };
      }
    }
    // 如果是陣列 [花色, 點數]
    if (Array.isArray(c) && c.length >= 2) {
      const suits = ['s', 'h', 'c', 'd'];
      return { rank: parseInt(c[1]) || 0, suit: suits[parseInt(c[0])] || 's' };
    }
    return null;
  }

  // ===== SignalR 訊息處理 =====
  _handleSignalRMessage(msg) {
    const target = msg.target;
    const args = msg.arguments || [];

    // 記錄前 30 筆不同 target
    if (!this._signalrTargets) this._signalrTargets = new Set();
    if (this._signalrTargets.size < 30) {
      if (!this._signalrTargets.has(target)) {
        this._signalrTargets.add(target);
        console.log(`📡 SignalR target: "${target}" args[0]=${JSON.stringify(args[0]).substring(0, 200)}`);
      }
    }

    const data = args[0]; // 通常第一個參數是主要資料

    // ---- 牌桌列表 ----
    if (target === 'TableList' || target === 'tableList' || target === 'GameTableList' ||
        target === 'ReceiveTableList' || target === 'UpdateTableList' ||
        target.toLowerCase().includes('tablelist') || target.toLowerCase().includes('tables')) {
      this._handleSignalRTables(data, args);
      return;
    }

    // ---- 開牌結果 ----
    if (target === 'GameResult' || target === 'gameResult' || target === 'Result' ||
        target === 'ReceiveGameResult' || target === 'ShowResult' ||
        target.toLowerCase().includes('result') || target.toLowerCase().includes('summary')) {
      this._handleSignalRResult(data, args);
      return;
    }

    // ---- 發牌/牌面 ----
    if (target === 'DealCard' || target === 'dealCard' || target === 'ShowCard' ||
        target.toLowerCase().includes('card') || target.toLowerCase().includes('deal')) {
      this._handleSignalRDeal(data, args);
      return;
    }

    // ---- 路紙 ----
    if (target.toLowerCase().includes('road') || target.toLowerCase().includes('bead')) {
      this.emit('road_update', data);
      return;
    }

    // ---- 遊戲狀態 ----
    if (target.toLowerCase().includes('status') || target.toLowerCase().includes('state') ||
        target.toLowerCase().includes('round') || target.toLowerCase().includes('game')) {
      // 有些狀態訊息也帶牌桌資料
      if (data && typeof data === 'object') {
        // 嘗試提取牌桌列表
        const tables = data.tables || data.tableList || data.data?.tables;
        if (Array.isArray(tables) && tables.length > 0) {
          this._handleSignalRTables(data, args);
        }
      }
      return;
    }
  }

  // SignalR: 處理牌桌列表
  _handleSignalRTables(data, args) {
    let tablesArr = [];

    // 嘗試各種格式
    if (Array.isArray(data)) {
      tablesArr = data;
    } else if (data && Array.isArray(data.tables)) {
      tablesArr = data.tables;
    } else if (data && Array.isArray(data.tableList)) {
      tablesArr = data.tableList;
    } else if (data && Array.isArray(data.data)) {
      tablesArr = data.data;
    } else if (args.length > 1 && Array.isArray(args[1])) {
      tablesArr = args[1];
    }

    if (tablesArr.length === 0) return;
    console.log(`📋 SignalR: 收到 ${tablesArr.length} 張牌桌資料`);

    const baccaratTables = [];
    for (const t of tablesArr) {
      // 取得 tableId（各種可能的欄位名）
      const tableId = t.tableId || t.table_id || t.TableId || t.id || t.ID;
      if (!tableId) continue;

      // 取得桌名
      const tableName = t.tableName || t.table_name || t.TableName || t.name || tableId;

      // 取得荷官
      const dealerRaw = t.dealer || t.Dealer || t.dealerInfo || t.DealerInfo;
      const dealer = this.parseDealerInfo(dealerRaw);

      // 過濾百家樂（彈性判斷）
      const gameType = (t.gameType || t.game_type || t.GameType || t.gametype_id || t.gameTypeId || '').toString().toLowerCase();
      const idLower = tableId.toLowerCase();
      const nameLower = tableName.toLowerCase();

      const isBaccarat = idLower.startsWith('ba') || idLower.includes('bac') ||
        gameType.includes('bac') || gameType.includes('ba') ||
        nameLower.includes('百家') || nameLower.includes('baccarat');

      // 如果無法判斷遊戲類型，先全部收（之後再過濾）
      if (!isBaccarat && gameType && !gameType.includes('bac')) continue;

      const info = {
        tableId,
        tableName,
        dealer,
        shoe: t.shoe || t.Shoe || t.shoeNo || null,
        round: t.round || t.Round || t.roundNo || null,
        state: t.status || t.state || t.Status || t.State,
        hall: t.hall || t.Hall || '',
        _raw: t
      };
      this.tables.set(tableId, info);
      baccaratTables.push(info);
    }

    if (baccaratTables.length > 0) {
      console.log(`📋 SignalR: ${baccaratTables.length} 張百家樂桌`);
      this.emit('tables_list', baccaratTables);
    }
  }

  // SignalR: 處理開牌結果
  _handleSignalRResult(data, args) {
    if (!data || typeof data !== 'object') return;

    const tableId = data.tableId || data.table_id || data.TableId;
    if (!tableId) return;

    // 嘗試解析牌面
    let playerCards = [];
    let bankerCards = [];

    // 格式1: result 陣列 [p1,b1,p2,b2,p3,b3]
    const resultArr = data.result || data.Result || data.cards || data.Cards;
    if (Array.isArray(resultArr)) {
      const cards = resultArr.slice(0, 6).map(n => (n > 0) ? this.decodeCardNumber(n) : null);
      playerCards = [cards[0], cards[2], cards[4]].filter(c => c !== null);
      bankerCards = [cards[1], cards[3], cards[5]].filter(c => c !== null);
    }

    // 格式2: playerCards/bankerCards 分開
    if (playerCards.length === 0 && data.playerCards) {
      playerCards = Array.isArray(data.playerCards) ? data.playerCards.map(n => this.decodeCardNumber(n)).filter(c => c) : [];
    }
    if (bankerCards.length === 0 && data.bankerCards) {
      bankerCards = Array.isArray(data.bankerCards) ? data.bankerCards.map(n => this.decodeCardNumber(n)).filter(c => c) : [];
    }

    // 贏家
    const winner = this.normalizeWinner(data.winner || data.Winner || data.winSide || data.WinSide || '');

    const playerTotal = this.calcTotal(playerCards);
    const bankerTotal = this.calcTotal(bankerCards);

    if (playerCards.length > 0 || winner) {
      console.log(`🃏 SignalR開牌: ${tableId} ` +
        `閒[${playerCards.map(c => this.formatCard(c)).join(' ')}]=${playerTotal} ` +
        `莊[${bankerCards.map(c => this.formatCard(c)).join(' ')}]=${bankerTotal} ` +
        `→ ${winner === 'B' ? '莊贏' : winner === 'P' ? '閒贏' : '和'}`);

      this.emit('game_result', {
        tableId,
        shoe: data.shoe || data.Shoe || data.shoeNo,
        round: data.round || data.Round || data.roundNo,
        playerCards,
        bankerCards,
        playerTotal,
        bankerTotal,
        winner,
        playerPair: playerCards.length >= 2 && playerCards[0]?.rank === playerCards[1]?.rank,
        bankerPair: bankerCards.length >= 2 && bankerCards[0]?.rank === bankerCards[1]?.rank,
      });
    }
  }

  // SignalR: 處理發牌
  _handleSignalRDeal(data, args) {
    // 記錄發牌資料（可能需要累積後再 emit）
    if (!data || typeof data !== 'object') return;
    // 大部分情況 result 已經包含完整牌面，這裡只做記錄
  }

  // ===== 處理牌桌列表 =====
  handleTablesUpdate(msg) {
    const tablesData = msg.msg?.tables || [];
    if (!Array.isArray(tablesData)) return;
    console.log(`📋 MT連線器: 收到 ${tablesData.length} 張牌桌資料`);

    for (const table of tablesData) {
      const tableId = table.table_id;
      if (!tableId) continue;

      // 只收百家樂桌 (BAG=百家, BAV=視訊百家)，排除骰寶/龍虎/牛牛等
      if (!tableId.startsWith('BA')) continue;

      const info = {
        tableId: tableId,
        tableName: table.table_name || tableId,
        dealer: this.parseDealerInfo(table.dealer),
        shoe: table.shoe || null,
        round: table.round || null,
        state: table.state,
        roomId: table.room_id,
        hall: table.hall,
        gameTypeId: table.gametype_id,
        _raw: table
      };
      this.tables.set(tableId, info);
    }

    this.emit('tables_list', Array.from(this.tables.values()));
  }

  // 解析荷官資訊
  parseDealerInfo(dealer) {
    if (!dealer) return { name: '未知荷官', avatar: '' };
    if (typeof dealer === 'string') return { name: dealer, avatar: '' };
    return {
      name: dealer.username || dealer.name || dealer.nickname || '未知荷官',
      avatar: dealer.avatar_url || '',
      id: dealer.id || null,
      nation: dealer.nation || ''
    };
  }

  // ===== 處理 summary（開牌牌面）=====
  handleSummary(msg) {
    const body = msg.body || {};
    const tableId = body.table_id;
    const resultArr = body.result;

    if (!tableId || !Array.isArray(resultArr)) return;

    // result 陣列格式: [p1, b1, p2, b2, p3, b3, ??, ??, ??, ??]
    // 牌面索引 1-52 (1-indexed)，0 或 -1 表示沒牌
    const cards = resultArr.slice(0, 6).map(n =>
      (n > 0) ? this.decodeCardNumber(n) : null
    );

    // 發牌順序: p1, b1, p2, b2, p3, b3
    const playerCards = [cards[0], cards[2], cards[4]].filter(c => c !== null);
    const bankerCards = [cards[1], cards[3], cards[5]].filter(c => c !== null);

    const playerTotal = this.calcTotal(playerCards);
    const bankerTotal = this.calcTotal(bankerCards);

    // 快取 summary，等 show_win 來確認贏家
    if (!this._pendingSummary) this._pendingSummary = {};
    this._pendingSummary[tableId] = {
      tableId,
      shoe: body.shoe,
      round: body.round,
      playerCards,
      bankerCards,
      playerTotal,
      bankerTotal,
      playerPair: playerCards.length >= 2 && playerCards[0].rank === playerCards[1].rank,
      bankerPair: bankerCards.length >= 2 && bankerCards[0].rank === bankerCards[1].rank,
    };

    // 嘗試合併 (如果 show_win 先到了)
    this._tryEmitResult(tableId);
  }

  // ===== 處理 show_win（贏家公布）=====
  handleShowWin(msg) {
    const body = msg.body || {};
    const tableId = body.table_id;
    if (!tableId) return;

    // winner: 1=莊, 2=閒, 3=和
    if (!this._pendingWinner) this._pendingWinner = {};
    this._pendingWinner[tableId] = {
      winner: this.normalizeWinner(body.winner),
      shoe: body.shoe,
      round: body.round,
    };

    this._tryEmitResult(tableId);
  }

  // 合併 summary + show_win 後發出 game_result
  _tryEmitResult(tableId) {
    if (!this._pendingSummary) this._pendingSummary = {};
    if (!this._pendingWinner) this._pendingWinner = {};

    const summary = this._pendingSummary[tableId];
    const winInfo = this._pendingWinner[tableId];

    if (!summary || !winInfo) return;

    // 合併
    const result = {
      ...summary,
      winner: winInfo.winner,
    };

    // 清除快取
    delete this._pendingSummary[tableId];
    delete this._pendingWinner[tableId];

    console.log(`🃏 MT開牌: ${tableId} 靴${result.shoe} 第${result.round}局 ` +
      `閒[${result.playerCards.map(c => this.formatCard(c)).join(' ')}]=${result.playerTotal} ` +
      `莊[${result.bankerCards.map(c => this.formatCard(c)).join(' ')}]=${result.bankerTotal} ` +
      `→ ${result.winner === 'B' ? '莊贏' : result.winner === 'P' ? '閒贏' : '和'}`);

    this.emit('game_result', result);
  }

  // 數字牌解碼 (1-52, 1-indexed)
  decodeCardNumber(num) {
    if (num <= 0 || num > 52) return null;
    const idx = num - 1; // 轉為 0-indexed
    const suits = ['s', 'h', 'c', 'd'];
    const suit = suits[Math.floor(idx / 13)] || 's';
    const rank = (idx % 13) + 1; // 1=A, 2-10, 11=J, 12=Q, 13=K
    return { rank, suit };
  }

  // winner 正規化: 1=閒(闊), 2=莊, 3=和
  normalizeWinner(winner) {
    const w = String(winner);
    if (w === '1' || w === 'P' || w === 'player') return 'P';
    if (w === '2' || w === 'B' || w === 'banker') return 'B';
    if (w === '3' || w === 'T' || w === 'tie' || w === '0') return 'T';
    return 'T';
  }

  // 計算百家樂點數
  calcTotal(cards) {
    let sum = 0;
    for (const c of cards) {
      sum += c.rank >= 10 ? 0 : c.rank;
    }
    return sum % 10;
  }

  // 格式化牌面
  formatCard(card) {
    const suits = { s: '♠', h: '♥', c: '♣', d: '♦' };
    const ranks = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
    return `${suits[card.suit] || '?'}${ranks[card.rank] || card.rank}`;
  }

  // 處理路紙更新
  handleRoadUpdate(msg) {
    this.emit('road_update', msg);
  }

  // ===== 重連 =====
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    console.log(`🔄 MT連線器: ${this.reconnectDelay / 1000}秒後重連...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
  }

  // ===== 斷線 =====
  async disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.browser) {
      try { await this.browser.close(); } catch (e) {}
      this.browser = null;
      this.page = null;
    }
    this.connected = false;
    console.log('🔌 MT連線器: 已斷線');
  }

  // 取得所有已記錄的訊息（用於分析）
  getMessageLog() {
    return this.messageLog;
  }

  // 取得連線狀態
  getStatus() {
    return {
      connected: this.connected,
      tablesCount: this.tables.size,
      pageUrl: this.pageUrl,
      tables: Array.from(this.tables.values()).map(t => ({
        tableId: t.tableId,
        tableName: t.tableName,
        dealer: t.dealer?.name,
        status: t.status
      }))
    };
  }
}

module.exports = MTConnector;
