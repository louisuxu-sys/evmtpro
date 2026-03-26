require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const line = require('@line/bot-sdk');
const BaccaratEngine = require('./baccarat-engine');
const MTConnector = require('./mt-connector');
const { buildAnalysisFlex, buildHandResultFlex } = require('./flex-builder');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ===== LINE BOT 設定 =====
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || 'dummy_secret'
};

let lineClient = null;
if (lineConfig.channelAccessToken && lineConfig.channelAccessToken !== 'your_line_channel_access_token_here') {
  lineClient = new line.messagingApi.MessagingApiClient({
    channelAccessToken: lineConfig.channelAccessToken
  });
  console.log('✅ LINE BOT 已連線');
} else {
  console.log('⚠️  LINE BOT 未設定，請在 .env 填入 LINE_CHANNEL_ACCESS_TOKEN');
}

const EV_ALERT_THRESHOLD = parseFloat(process.env.EV_ALERT_THRESHOLD || '0.01');
const LINE_NOTIFY_TARGETS = (process.env.LINE_NOTIFY_TARGETS || '').split(',').filter(Boolean);

// ===== 全廳桌台管理 =====
const tables = new Map();           // localId -> BaccaratEngine
const subscribers = new Set();      // LINE 訂閱者 (EV 警報)
let mtTableIdMap = new Map();       // MT平台 tableId -> localId
let localToMtMap = new Map();       // localId -> MT平台 tableId
const userFollowing = new Map();    // LINE userId -> { mtTableId, localId }

// ===== MT 連線器 =====
const mtConnector = new MTConnector({
  pageUrl: process.env.MT_PAGE_URL || 'https://gsa.ofalive99.net',
  headless: process.env.MT_HEADLESS !== 'false',
  logMessages: true
});

// MT 事件: 收到牌桌列表 -> 自動建立引擎 (只百家樂)
mtConnector.on('tables_list', (mtTables) => {
  console.log(`📝 MT收到 ${mtTables.length} 張百家樂桌`);
  for (const mt of mtTables) {
    if (!mtTableIdMap.has(mt.tableId)) {
      const localId = tables.size + 1;
      const engine = new BaccaratEngine(localId, mt.tableName || `MT-${mt.tableId}`);
      if (mt.dealer) engine.setDealer(mt.dealer.name || '');
      engine._mtTableId = mt.tableId;
      engine._hall = mt.hall;
      tables.set(localId, engine);
      mtTableIdMap.set(mt.tableId, localId);
      localToMtMap.set(localId, mt.tableId);
      console.log(`  ✅ 第${localId}廳: ${mt.tableName} (荷官: ${mt.dealer?.name || '-'})`);
    } else {
      // 更新荷官
      const localId = mtTableIdMap.get(mt.tableId);
      const engine = tables.get(localId);
      if (engine && mt.dealer) engine.setDealer(mt.dealer.name || '');
    }
  }
  const allStates = [];
  for (const [id, engine] of tables) allStates.push(engine.getState());
  broadcastWS({ type: 'init', tables: allStates });
});

// MT 事件: Canvas 荷官名字更新
mtConnector.on('dealer_update', (dealerList) => {
  // dealerList 按 y 座標排序的荷官名字
  // 嘗試按順序配對到桌（假設 Canvas 上的桌順序跟建立順序一致）
  const tableArray = Array.from(tables.entries()).sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < dealerList.length && i < tableArray.length; i++) {
    const [localId, engine] = tableArray[i];
    if (dealerList[i]?.name) {
      engine.setDealer(dealerList[i].name);
      const mtId = localToMtMap.get(localId);
      if (mtId) {
        const mtInfo = mtConnector.tables.get(mtId);
        if (mtInfo) mtInfo.dealer = { name: dealerList[i].name };
      }
    }
  }
  console.log(`👩 荷官更新: ${dealerList.map(d => d.name).join(', ')}`);
});

// MT 事件: 開牌結果 -> 記錄 + 推送給跟隨用戶
mtConnector.on('game_result', (data) => {
  const localId = mtTableIdMap.get(data.tableId);
  if (!localId || !tables.has(localId)) return;

  const engine = tables.get(localId);
  const ev = engine.recordHand(data.winner, data.playerCards, data.bankerCards);
  const state = engine.getState();
  const lastDetail = state.handDetails[state.handDetails.length - 1];

  // 廣播到前端
  broadcastWS({ type: 'update', tableId: localId, state });

  // 推送給跟隨此房間的 LINE 用戶
  pushToFollowers(data.tableId, localId, engine, ev, lastDetail);

  console.log(`✅ 第${localId}廳 ${engine.tableName} 第${engine.handCount}局`);
});

// 推送開牌結果給跟隨用戶
function pushToFollowers(mtTableId, localId, engine, ev, detail) {
  const mtInfo = mtConnector.tables.get(mtTableId);
  for (const [userId, info] of userFollowing) {
    if (info.mtTableId === mtTableId) {
      try {
        const flex = buildHandResultFlex(engine, mtInfo, detail);
        pushFlex(userId, flex);
      } catch (e) {
        const msg = formatHandResult(localId, engine, ev, detail);
        pushMessage(userId, msg);
      }
    }
  }
}

mtConnector.on('connected', () => {
  broadcastWS({ type: 'mt_status', connected: true });
});

mtConnector.on('disconnected', () => {
  broadcastWS({ type: 'mt_status', connected: false });
});

mtConnector.on('error', (err) => {
  console.error('❌ MT錯誤:', err.message);
});

// 不再初始化示範桌台 - 改由 MT 自動建立
console.log('✅ 等待 MT 連線建立桌台...');

// ===== LINE Webhook - GET (LINE Verify 用) =====
app.get('/webhook', (req, res) => {
  res.status(200).send('OK');
});

// ===== LINE Webhook (必須在 express.json() 之前，使用 raw body 驗證簽名) =====
app.post('/webhook', express.raw({ type: '*/*' }), (req, res) => {
  // ngrok 免費版 bypass
  res.setHeader('ngrok-skip-browser-warning', 'true');
  if (!lineConfig.channelSecret || lineConfig.channelSecret === 'dummy_secret') {
    return res.status(200).json({ message: 'LINE BOT not configured' });
  }

  const signature = req.headers['x-line-signature'];
  console.log('📨 Webhook 收到請求, signature:', signature ? '有' : '無');

  if (!signature) {
    return res.status(200).json({ message: 'OK' });
  }

  const body = req.body.toString('utf8');
  console.log('📨 Webhook body:', body.substring(0, 200));

  if (!line.validateSignature(body, lineConfig.channelSecret, signature)) {
    console.error('❌ Webhook 簽名驗證失敗');
    return res.status(403).json({ message: 'Invalid signature' });
  }

  console.log('✅ Webhook 簽名驗證通過');
  const parsed = JSON.parse(body);
  console.log('📨 Events 數量:', parsed.events ? parsed.events.length : 0);
  if (parsed.events) {
    parsed.events.forEach(handleLineEvent);
  }
  res.status(200).json({ message: 'OK' });
});

// ===== Express 中間件 =====
// CORS - 允許 MT 平台瀏覽器攔截腳本跨域請求
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 處理 LINE 事件
async function handleLineEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text.trim();
  const replyToken = event.replyToken;
  const userId = event.source.userId;
  const groupId = event.source.groupId;
  const targetId = groupId || userId;

  // ===== 全廳掃描 =====
  if (text === '全廳' || text === '房間' || text === '廳') {
    const summary = getRoomList();
    await replyMessage(replyToken, summary);
    return;
  }

  // ===== 跟隨房間: 輸入真實房號 (2, B01, 3A等) =====
  const followMatch = text.match(/^(?:第|跟隨|跟随)?([0-9B][0-9A-Za-z]*)(?:廳|厅)?$/);
  if (followMatch) {
    const inputKey = followMatch[1].toUpperCase();
    // 找對應的 MT 房號
    let targetLocalId = null;
    for (const [lid, eng] of tables) {
      const mid = localToMtMap.get(lid);
      const mi = mid ? mtConnector.tables.get(mid) : null;
      // 比對 displayNum、tableName（去掉"百家樂 "前綴）兩種格式
      const dnKey = mi ? String(mi.displayNum || '').toUpperCase() : '';
      const tnKey = String(eng.tableName || '').replace(/^百家樂\s*/,'').toUpperCase();
      if (dnKey === inputKey || tnKey === inputKey) {
        targetLocalId = lid;
        break;
      }
    }
    // debug: 跟隨查找失敗時印出可用房號
    if (targetLocalId === null) {
      const available = [];
      for (const [lid, eng] of tables) {
        const mid = localToMtMap.get(lid);
        const mi = mid ? mtConnector.tables.get(mid) : null;
        available.push(`lid=${lid} dn=${mi?.displayNum} tn=${eng.tableName}`);
      }
      console.log(`🔍 跟隨查找失敗 input="${inputKey}" 可用: ${available.join(' | ')}`);
    }
    if (targetLocalId !== null) {
      const engine = tables.get(targetLocalId);
      const mtId = localToMtMap.get(targetLocalId);
      userFollowing.set(targetId, { mtTableId: mtId, localId: targetLocalId });
      const mtInfo = mtId ? mtConnector.tables.get(mtId) : null;
      try {
        const flex = buildAnalysisFlex(engine, mtInfo);
        await replyFlex(replyToken, flex);
      } catch (e) {
        console.error('Flex build error:', e.message);
        const state = engine.getState();
        await replyMessage(replyToken, `✅ 已開始跟隨「${engine.tableName}」\n荷官: ${state.dealer || '-'}\n\n每手開牌會自動推送\n輸入「取消」停止跟隨`);
      }
    } else {
      await replyMessage(replyToken, `❌ 找不到「${inputKey}」房
輸入「全廳」查看可用房間`);
    }
    return;
  }

  // ===== 查看分析 (分析X 或 分析B01) =====
  const analyseMatch = text.match(/^分析([0-9B][0-9A-Za-z]*)$/);
  if (analyseMatch) {
    const inputKey = analyseMatch[1].toUpperCase();
    let targetLocalId = null;
    for (const [lid, eng] of tables) {
      const mid = localToMtMap.get(lid);
      const mi = mid ? mtConnector.tables.get(mid) : null;
      const dnKey = mi ? String(mi.displayNum || '').toUpperCase() : '';
      const tnKey = String(eng.tableName || '').replace(/^百家樂\s*/, '').toUpperCase();
      if (dnKey === inputKey || tnKey === inputKey) { targetLocalId = lid; break; }
    }
    if (targetLocalId !== null) {
      const engine = tables.get(targetLocalId);
      const mtId = localToMtMap.get(targetLocalId);
      const mtInfo = mtId ? mtConnector.tables.get(mtId) : null;
      try {
        const flex = buildAnalysisFlex(engine, mtInfo);
        await replyFlex(replyToken, flex);
      } catch (e) {
        await replyMessage(replyToken, `❌ 分析建立失敗: ${e.message}`);
      }
    } else {
      await replyMessage(replyToken, `❌ 找不到「${inputKey}」房\n輸入「全廳」查看可用房間`);
    }
    return;
  }

  // ===== 取消跟隨 =====
  if (text === '取消' || text === '取消跟隨' || text === '離開') {
    if (userFollowing.has(targetId)) {
      const info = userFollowing.get(targetId);
      userFollowing.delete(targetId);
      await replyMessage(replyToken, `❌ 已停止跟隨第${info.localId}廳`);
    } else {
      await replyMessage(replyToken, '目前沒有跟隨任何房間');
    }
    return;
  }

  // ===== 指令幫助 =====
  if (text === '指令' || text === '幫助' || text === 'help') {
    await replyMessage(replyToken,
      `🎰 百家之眼 - 指令列表\n` +
      `📊 全廳 - 查看所有百家樂房間\n` +
      `🔢 輸入房號 - 跟隨房間，如: 2 或 B01\n` +
      `🔍 分析X - 查看 AI 分析，如: 分析2 或 分析B01\n` +
      `❌ 取消 - 停止跟隨\n` +
      `❓ 指令 - 顯示此幫助`
    );
    return;
  }

  // ===== 未知指令 =====
  await replyMessage(replyToken, `🎰 百家之眼
輸入「全廳」查看房間
輸入「指令」查看功能`);
}

// LINE 回覆訊息
async function replyMessage(replyToken, text) {
  if (!lineClient) { console.error('LINE client 未初始化'); return; }
  console.log('📤 嘗試回覆訊息, token:', replyToken.substring(0, 20) + '...');
  try {
    await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
    console.log('✅ 回覆成功');
  } catch (err) {
    console.error('❌ LINE reply error:', err.message);
    if (err.statusCode) console.error('  Status:', err.statusCode);
    if (err.body) console.error('  Body:', JSON.stringify(err.body));
  }
}

// LINE 回覆 Flex Message
async function replyFlex(replyToken, flex) {
  if (!lineClient) { console.error('LINE client 未初始化'); return; }
  try {
    await lineClient.replyMessage({ replyToken, messages: [flex] });
    console.log('✅ Flex 回覆成功');
  } catch (err) {
    console.error('❌ LINE flex reply error:', err.message);
    if (err.body) console.error('  Body:', JSON.stringify(err.body));
  }
}

// LINE 推送訊息
async function pushMessage(targetId, text) {
  if (!lineClient) return;
  try {
    await lineClient.pushMessage({ to: targetId, messages: [{ type: 'text', text }] });
  } catch (err) {
    console.error('LINE push error:', err.message);
  }
}

// LINE 推送 Flex Message
async function pushFlex(targetId, flex) {
  if (!lineClient) return;
  try {
    await lineClient.pushMessage({ to: targetId, messages: [flex] });
  } catch (err) {
    console.error('LINE push flex error:', err.message);
  }
}

// ===== 格式化函數 =====

// 格式化單張牌 (像參考圖片: ♦J ♦3 ♣4)
function fmtCard(card) {
  if (!card) return '';
  const suits = { s: '♠', h: '♥', c: '♣', d: '♦' };
  const ranks = { 1: 'A', 10: '10', 11: 'J', 12: 'Q', 13: 'K' };
  return `${suits[card.suit] || '?'}${ranks[card.rank] || card.rank}`;
}

// 格式化一手牌
function fmtHand(cards) {
  if (!cards || cards.length === 0) return '-';
  return cards.map(c => fmtCard(c)).join(' ');
}

// 房間列表 (按真實房號排序)
function getRoomList() {
  if (tables.size === 0) return '⏳ 正在連線 MT 平台，請稍候...';

  // 建立以房號排序的列表
  const roomList = [];
  for (const [lid, engine] of tables) {
    const mtId = localToMtMap.get(lid);
    const mtInfo = mtId ? mtConnector.tables.get(mtId) : null;
    if (!mtInfo) continue;
    roomList.push({ lid, engine, mtInfo });
  }
  // 自然排序: 數字房號先，然後 B 系列
  roomList.sort((a, b) => {
    const na = String(a.mtInfo.displayNum), nb = String(b.mtInfo.displayNum);
    const ia = parseInt(na) || 999, ib = parseInt(nb) || 999;
    if (ia !== ib) return ia - ib;
    return na.localeCompare(nb);
  });

  let text = `🎰 百家之眼 - MT百家樂
`;
  for (const { lid, engine, mtInfo } of roomList) {
    const summary = mtInfo.summary;
    const dealer = mtInfo.dealer?.name || '-';
    const road = mtInfo.roadText || '';
    const rn = mtInfo.displayNum;

    text += `\n${engine.tableName}`;
    if (dealer && dealer !== '-') text += ` | 👤${dealer}`;
    if (summary && summary.total > 0) {
      text += `\n   莊${summary.banker} 閒${summary.player} 和${summary.tie} (共${summary.total}局)`;
    }
    if (road) text += `\n   ${road.substring(0, 30)}`;
  }
  text += `\n\n━━━━━━━━\n`;
  text += `共 ${roomList.length} 個百家樂桌\n`;
  text += `輸入房號跟隨，如: 2 或 B01`;
  return text;
}

// 格式化每手開牌結果 (推送給跟隨用戶)
function formatHandResult(localId, engine, ev, detail) {
  const state = engine.getState();
  const shoe = state.shoeNum || '-';
  const hand = detail?.hand || state.handCount || '-';
  const dealer = state.dealer || '-';
  // 用 MT 真實房名 (如 "百家樂 2") 而非序號
  const roomLabel = state.tableName || `百家樂 ${localId}`;

  let msg = `${roomLabel} | 靴 ${shoe} 第${hand}手\n`;
  msg += `荷官: ${dealer}\n`;

  if (detail && detail.playerCards && detail.playerCards.length >= 2) {
    msg += `閒牌: ${fmtHand(detail.playerCards)}\n`;
    msg += `莊牌: ${fmtHand(detail.bankerCards)}\n`;
  } else if (detail) {
    const w = detail.winner === 'B' ? '莊贏' : detail.winner === 'P' ? '閒贏' : '和局';
    msg += `結果: ${w}\n`;
  }

  msg += `—— EV ——\n`;
  if (ev && typeof ev.banker === 'number') {
    msg += `莊: ${ev.banker.toFixed(4)}\n`;
    msg += `閒: ${ev.player.toFixed(4)}\n`;
    msg += `超六: ${ev.super6 !== undefined ? ev.super6.toFixed(4) : '-'}\n`;
    msg += `對子: ${ev.pair !== undefined ? ev.pair.toFixed(4) : '-'}\n`;
    msg += `和: ${ev.tie.toFixed(4)}`;
  } else {
    msg += `(等待牌靴資料)`;
  }

  return msg;
}

// ===== Python 外接資料接收 =====
app.post('/api/mt-data', (req, res) => {
  const data = req.body;
  if (!data || !data.type) return res.status(400).json({ error: 'Missing type' });

  console.log(`📩 Python: ${data.type}`);

  if (data.type === 'tables_update' && Array.isArray(data.tables)) {
    // 處理牌桌列表
    for (const t of data.tables) {
      const tableId = t.tableId;
      if (!tableId) continue;

      if (!mtTableIdMap.has(tableId)) {
        const localId = tables.size + 1;
        const engine = new BaccaratEngine(localId, t.tableName || `MT-${tableId}`);
        engine._mtTableId = tableId;
        if (t.dealer) engine.setDealer(t.dealer);
        tables.set(localId, engine);
        mtTableIdMap.set(tableId, localId);
        localToMtMap.set(localId, tableId);
        mtConnector.tables.set(tableId, t);
        console.log(`  ✅ 第${localId}廳: ${t.tableName} | 荷官: ${t.dealer || '-'} (Python)`);
      } else {
        const localId = mtTableIdMap.get(tableId);
        const engine = tables.get(localId);
        if (engine && t.dealer) engine.setDealer(t.dealer);
        mtConnector.tables.set(tableId, t);
      }
    }
    console.log(`📋 Python: ${data.tables.length} 張牌桌, 共 ${tables.size} 廳`);
    return res.json({ ok: true, tables: tables.size });
  }

  if (data.type === 'game_result') {
    const localId = mtTableIdMap.get(data.tableId);
    if (localId && tables.has(localId)) {
      const engine = tables.get(localId);
      const winner = data.winner === 'B' ? 'B' : data.winner === 'P' ? 'P' : 'T';
      const ev = engine.recordHand(winner, null, null);
      const state = engine.getState();
      broadcastWS({ type: 'update', tableId: localId, state });
      pushToFollowers(data.tableId, localId, engine, ev, state.handDetails[state.handDetails.length - 1]);
      console.log(`🃏 Python開牌: 第${localId}廳 → ${winner === 'B' ? '莊' : winner === 'P' ? '閒' : '和'}`);
    }
    // 更新 summary
    if (data.summary && data.tableId) {
      const mt = mtConnector.tables.get(data.tableId);
      if (mt) mt.summary = data.summary;
    }
    return res.json({ ok: true });
  }

  if (data.type === 'dom_tables' && Array.isArray(data.tables)) {
    console.log(`📋 Python DOM: ${data.tables.length} 張牌桌`);
    return res.json({ ok: true });
  }

  res.json({ ok: true });
});

// ===== API 路由 =====

// 取得全廳狀態
app.get('/api/tables', (req, res) => {
  const result = [];
  for (const [id, engine] of tables) {
    result.push(engine.getState());
  }
  res.json(result);
});

// 取得單桌狀態
app.get('/api/tables/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!tables.has(id)) return res.status(404).json({ error: 'Table not found' });
  res.json(tables.get(id).getState());
});

// 記錄結果（含開牌牌型）
// body: { result: 'B'|'P'|'T', playerCards: [{rank,suit},...], bankerCards: [{rank,suit},...] }
app.post('/api/tables/:id/record', (req, res) => {
  const id = parseInt(req.params.id);
  if (!tables.has(id)) return res.status(404).json({ error: 'Table not found' });

  const { result, playerCards, bankerCards } = req.body;
  if (!['B', 'P', 'T'].includes(result)) {
    return res.status(400).json({ error: 'Result must be B, P, or T' });
  }

  const engine = tables.get(id);
  const ev = engine.recordHand(result, playerCards || null, bankerCards || null);
  const state = engine.getState();

  // 廣播到 WebSocket
  broadcastWS({ type: 'update', tableId: id, state });

  // 檢查是否需要推送 LINE 警報
  const lastDetail = state.handDetails[state.handDetails.length - 1];
  broadcastEVAlert(engine.tableName, ev, engine.handCount, lastDetail);

  res.json(state);
});

// 重置牌靴
app.post('/api/tables/:id/reset', (req, res) => {
  const id = parseInt(req.params.id);
  if (!tables.has(id)) return res.status(404).json({ error: 'Table not found' });

  tables.get(id).resetShoe();
  const state = tables.get(id).getState();
  broadcastWS({ type: 'reset', tableId: id, state });
  res.json(state);
});

// 新增桌台
app.post('/api/tables', (req, res) => {
  const { name, dealer } = req.body;
  const id = tables.size + 1;
  const engine = new BaccaratEngine(id, name || `桌 ${id}`);
  if (dealer) engine.setDealer(dealer);
  tables.set(id, engine);
  broadcastWS({ type: 'newTable', tableId: id, state: engine.getState() });
  res.json(engine.getState());
});

// 設定荷官名字
app.post('/api/tables/:id/dealer', (req, res) => {
  const id = parseInt(req.params.id);
  if (!tables.has(id)) return res.status(404).json({ error: 'Table not found' });
  const { dealer } = req.body;
  tables.get(id).setDealer(dealer || '');
  const state = tables.get(id).getState();
  broadcastWS({ type: 'update', tableId: id, state });
  res.json(state);
});

// 批量記錄 (用於快速輸入)
app.post('/api/tables/:id/batch', (req, res) => {
  const id = parseInt(req.params.id);
  if (!tables.has(id)) return res.status(404).json({ error: 'Table not found' });

  const { results } = req.body; // ['B','P','B','T',...]
  if (!Array.isArray(results)) return res.status(400).json({ error: 'results must be array' });

  const engine = tables.get(id);
  let lastEV;
  for (const r of results) {
    if (['B', 'P', 'T'].includes(r)) {
      lastEV = engine.recordHand(r);
    }
  }

  const state = engine.getState();
  broadcastWS({ type: 'update', tableId: id, state });
  res.json(state);
});

// LINE BOT 訂閱者管理
app.get('/api/subscribers', (req, res) => {
  res.json({ count: subscribers.size, targets: [...subscribers] });
});

// ===== MT 連線器 API =====

app.get('/api/mt/status', (req, res) => {
  res.json(mtConnector.getStatus());
});

app.get('/api/mt/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const log = mtConnector.getMessageLog();
  res.json(log.slice(-limit));
});

// ===== 管理員遠端登入介面 =====
const ADMIN_KEY = process.env.ADMIN_KEY || 'evpro2024';

function checkAdmin(req, res, next) {
  const key = req.query.key || req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  next();
}

// 遠端登入頁面
app.get('/admin/login', checkAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

// 啟動遠端登入
app.post('/admin/start-login', checkAdmin, express.json(), async (req, res) => {
  try {
    const { url } = req.body || {};
    await mtConnector.startLogin(url);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// 截圖
app.get('/admin/screenshot', checkAdmin, async (req, res) => {
  try {
    const img = await mtConnector.screenshot();
    if (!img) return res.status(404).json({ error: 'No browser' });
    res.set('Content-Type', 'image/jpeg');
    res.send(img);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 頁面資訊
app.get('/admin/page-info', checkAdmin, async (req, res) => {
  try {
    const info = await mtConnector.getPageInfo();
    info.connected = mtConnector.connected;
    info.loginMode = mtConnector._loginMode;
    info.tablesCount = mtConnector.tables.size;
    res.json(info);
  } catch (err) {
    res.json({ url: '', title: '', error: err.message });
  }
});

// 點擊
app.post('/admin/click', checkAdmin, express.json(), async (req, res) => {
  try {
    await mtConnector.click(req.body.x, req.body.y);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// 打字
app.post('/admin/type', checkAdmin, express.json(), async (req, res) => {
  try {
    await mtConnector.type(req.body.text);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// 按鍵
app.post('/admin/key', checkAdmin, express.json(), async (req, res) => {
  try {
    await mtConnector.pressKey(req.body.key);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// 導航
app.post('/admin/navigate', checkAdmin, express.json(), async (req, res) => {
  try {
    await mtConnector.navigate(req.body.url);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// 接收本地攔截器 / 瀏覽器擴充功能轉發的 MT WebSocket 訊息
const INGEST_API_KEY = process.env.INGEST_API_KEY || '';

app.post('/api/mt/ingest', (req, res) => {
  try {
    // API 金鑰驗證（設定後才檢查）
    if (INGEST_API_KEY) {
      const key = req.headers['x-api-key'] || req.query.key;
      if (key !== INGEST_API_KEY) return res.status(403).json({ error: 'Unauthorized' });
    }

    const body = req.body;
    if (!body) return res.json({ ok: true, skipped: 'no body' });

    // 支援兩種格式:
    // 1. 批次格式 (本地攔截器): [ { D, SI, C, ... }, ... ]
    // 2. 單筆格式 (舊擴充功能): { wsUrl, timestamp, data }
    let msgs = [];

    if (Array.isArray(body)) {
      // 批次格式
      msgs = body.filter(m => m && typeof m === 'object');
    } else if (body.D && body.SI) {
      // 直接單筆 DD 格式
      msgs = [body];
    } else if (body.data) {
      // 舊擴充功能格式
      try {
        const m = typeof body.data === 'string' ? JSON.parse(body.data) : body.data;
        if (m) msgs = [m];
      } catch (e) {
        return res.json({ ok: true, skipped: 'not json' });
      }
    }

    if (msgs.length === 0) return res.json({ ok: true, skipped: 'no messages' });

    // 標記為已連線
    if (!mtConnector.connected) {
      mtConnector.connected = true;
      console.log('✅ MT連線器: 透過本地攔截器接收資料');
      broadcastWS({ type: 'mt_status', connected: true, mode: 'interceptor' });
    }

    let processed = 0;
    for (const msg of msgs) {
      try {
        if (mtConnector.logMessages) {
          mtConnector.messageLog.push({ time: new Date().toISOString(), msg });
          if (mtConnector.messageLog.length > 500) mtConnector.messageLog.shift();
        }
        mtConnector.handleMessage(msg);
        processed++;
      } catch (e) {}
    }

    res.json({ ok: true, processed });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ===== WebSocket =====
const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  console.log(`WebSocket 連線 (總連線: ${wsClients.size})`);

  // 發送當前全廳狀態
  const allStates = [];
  for (const [id, engine] of tables) {
    allStates.push(engine.getState());
  }
  ws.send(JSON.stringify({ type: 'init', tables: allStates }));

  ws.on('close', () => {
    wsClients.delete(ws);
  });
});

function broadcastWS(data) {
  const msg = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// ===== 啟動伺服器 =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎰 百家之眼 - 全廳監控系統`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🌐 監控面板: http://localhost:${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}`);
  console.log(`🤖 LINE Webhook: http://localhost:${PORT}/webhook`);
  console.log(`🔌 MT連線: ${mtConnector.pageUrl}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  console.log(`🔑 管理員介面: /admin/login?key=${ADMIN_KEY}`);
  const isPassive = process.env.MT_MODE === 'passive';
  if (isPassive) {
    console.log('📡 被動模式: 等待本地攔截器推送資料到 /api/mt/ingest');
    console.log(`🔑 INGEST_API_KEY: ${INGEST_API_KEY ? '已設定' : '未設定 (任何人可存取)'}`);
  } else if (process.env.MT_CASINO_USERNAME && process.env.MT_CASINO_PASSWORD) {
    console.log('🤖 偵測到自動登入設定，啟動自動登入...');
    mtConnector.autoLogin().then(ok => {
      if (ok) console.log('🎉 自動登入成功！系統已開始監控');
      else console.log('⚠️  自動登入未完成，請到管理員介面手動操作');
    }).catch(err => {
      console.error('❌ 自動登入失敗:', err.message);
    });
  } else {
    console.log('📡 等待 Chrome 擴充功能或管理員手動操作...');
  }
});
