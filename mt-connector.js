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
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-popup-blocking',
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
          // 在新頁面上設定 CDP 監聽
          await this._attachCDP(newPage);
          console.log('✅ MT連線器: 已切換到新視窗');
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

  // 設定 CDP WebSocket 監聽
  _setupCDPListeners() {
    this.cdp.on('Network.webSocketCreated', ({ requestId, url }) => {
      this._wsMap.set(requestId, url);
      if (url.includes('/game/ws')) {
        console.log(`✅ MT連線器: Game WebSocket 已連線`);
        this.connected = true;
        this._loginMode = false;
        this.emit('connected');
      }
    });

    this.cdp.on('Network.webSocketClosed', ({ requestId }) => {
      const url = this._wsMap.get(requestId) || '';
      this._wsMap.delete(requestId);
      if (url.includes('/game/ws')) {
        console.log(`🔌 MT連線器: Game WebSocket 斷線`);
        this.connected = false;
      }
    });

    this.cdp.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
      const url = this._wsMap.get(requestId) || '';
      if (!url.includes('/game/ws')) return;
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
      await this._sleep(2000);

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

      // 5. 尋找並點擊 MT真人
      console.log('🎰 自動登入: 尋找 MT真人...');
      await this._sleep(2000);

      // 攔截 window.open，記錄 popup URL
      await this.page.evaluate(() => {
        window.__popupUrl = null;
        const origOpen = window.open;
        window.open = function(url, ...args) {
          window.__popupUrl = url;
          return origOpen.call(this, url, ...args);
        };
      });

      // 找 MT真人 — 用 JS click 直接點（新分頁由 targetcreated 自動處理）
      const mtClicked = await this.page.evaluate(() => {
        // 策略1: 找「開始登入 MT」「進入MT」「前往MT」按鈕
        const btns = Array.from(document.querySelectorAll('a, button, div, span'));
        for (const el of btns) {
          const text = (el.textContent || '').trim();
          if ((text.includes('開始') || text.includes('進入') || text.includes('前往') || text.includes('登入')) && text.includes('MT')) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              el.click();
              return { clicked: true, text: text.substring(0, 40), tag: el.tagName, method: 'direct-btn' };
            }
          }
        }

        // 策略2: 找最小的包含「MT真人」或「MT 真人」的可點擊元素
        let best = null;
        let bestArea = Infinity;
        const all = Array.from(document.querySelectorAll('a, div, span, button, img, li'));
        for (const el of all) {
          const text = (el.textContent || el.alt || el.title || '').trim();
          if (!text.includes('MT')) continue;
          if (!text.includes('真人') && !text.includes('live') && !text.includes('Live')) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          // 排除太大的元素(大於500px寬的可能是容器)
          if (rect.width > 500) continue;
          const area = rect.width * rect.height;
          if (area < bestArea && area > 50) {
            bestArea = area;
            best = el;
          }
        }
        if (best) {
          best.click();
          const r = best.getBoundingClientRect();
          return { clicked: true, text: (best.textContent || '').trim().substring(0, 40), tag: best.tagName, method: 'smallest-el', x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
        }

        // 策略3: data 屬性
        const dataEls = Array.from(document.querySelectorAll('[data-code*="mt"], [data-code*="MT"], [alt*="MT"]'));
        if (dataEls.length > 0) {
          dataEls[0].click();
          return { clicked: true, text: 'data/alt match', tag: dataEls[0].tagName, method: 'data-attr' };
        }

        return { clicked: false };
      });

      if (!mtClicked.clicked) {
        console.log('⚠️  自動登入: 找不到 MT真人按鈕');
        this._loginMode = true;
        return false;
      }

      console.log(`✅ 自動登入: 已點擊 MT真人 [${mtClicked.text}] <${mtClicked.tag}> (${mtClicked.method})`);
      const pagesBefore = (await this.browser.pages()).length;

      // 5.5 點擊 MT 後可能出現確認彈窗
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

      // 等待 popup 視窗出現
      await this._sleep(5000);
      const pagesAfter = (await this.browser.pages()).length;
      console.log(`📄 自動登入: 頁面數 ${pagesBefore} -> ${pagesAfter}`);

      // 如果有新頁面，targetcreated 會自動切換
      // 如果沒有新頁面，嘗試用攔截到的 popup URL 直接導航
      if (pagesAfter <= pagesBefore) {
        const popupUrl = await this.page.evaluate(() => window.__popupUrl);
        if (popupUrl) {
          console.log(`🔗 自動登入: popup 被擋，直接導航到 ${popupUrl}`);
          await this.page.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } else {
          console.log('⚠️  自動登入: 沒有偵測到新視窗，嘗試直接進入 MT...');
          // 最後手段：直接導航到 MT 頁面
          await this.page.goto(this.pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
      }

      // 6. 等待 MT 載入
      console.log('⏳ 自動登入: 等待 MT 載入...');
      await this._sleep(8000);

      if (this.connected) {
        console.log('🎉 自動登入: 成功！MT WebSocket 已連線');
        return true;
      }

      // 等更久一點
      console.log('⏳ 自動登入: 繼續等待 WebSocket...');
      for (let i = 0; i < 10; i++) {
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

  // 處理從瀏覽器收到的 WebSocket 訊息
  _onWsMessage(wsUrl, rawData) {
    try {
      const msg = JSON.parse(rawData);

      if (this.logMessages) {
        this.messageLog.push({ time: new Date().toISOString(), msg });
        if (this.messageLog.length > 500) this.messageLog.shift();
      }

      this.handleMessage(msg);
    } catch (err) {
      // 非 JSON 訊息忽略
    }
  }

  // ===== 訊息處理 =====
  handleMessage(msg) {
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
