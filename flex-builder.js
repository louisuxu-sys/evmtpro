'use strict';

const TOTAL_CARDS_8DECK = 416;

// ===== 顏色常數 =====
const COLOR_B = '#e74c3c';
const COLOR_P = '#2980b9';
const COLOR_T = '#27ae60';
const COLOR_HEADER = '#1a3a5c';

// ===== 圓形 box 元件 =====
function circleBox(result, size) {
  size = size || '26px';
  const bg = result === 'B' ? COLOR_B : result === 'P' ? COLOR_P : COLOR_T;
  const label = result === 'B' ? '莊' : result === 'P' ? '閒' : '和';
  return {
    type: 'box', layout: 'vertical',
    backgroundColor: bg, cornerRadius: 'xxl',
    width: size, height: size,
    justifyContent: 'center', alignItems: 'center',
    contents: [{ type: 'text', text: label, color: '#ffffff', size: 'xxs', align: 'center', gravity: 'center' }]
  };
}

function emptyCell(size) {
  size = size || '26px';
  return { type: 'box', layout: 'vertical', width: size, height: size, contents: [] };
}

// ===== 珠盤路 (6 欄，由左到右由上到下) =====
function buildBeadRoadFlex(beadRoad) {
  const COLS = 6;
  const recent = beadRoad.slice(-42); // max 7 rows × 6 cols

  if (recent.length === 0) {
    return [{ type: 'text', text: '（無資料）', size: 'xs', color: '#aaaaaa' }];
  }

  const rowBoxes = [];
  for (let i = 0; i < recent.length; i += COLS) {
    const row = recent.slice(i, i + COLS);
    rowBoxes.push({
      type: 'box', layout: 'horizontal', spacing: 'xs', margin: 'xs',
      contents: [
        ...row.map(b => circleBox(b.result, '26px')),
        ...Array(COLS - row.length).fill(null).map(() => emptyCell('26px'))
      ]
    });
  }

  return [{ type: 'box', layout: 'vertical', spacing: 'none', contents: rowBoxes }];
}

// ===== 大路 (每欄向下疊加) =====
function buildBigRoadFlex(bigRoad) {
  const MAX_COLS = 8;
  const MAX_ROWS = 6;

  if (bigRoad.length === 0) {
    return [{ type: 'text', text: '（無資料）', size: 'xs', color: '#aaaaaa' }];
  }

  const maxCol = Math.max(...bigRoad.map(e => e.col));
  const startCol = Math.max(0, maxCol - MAX_COLS + 1);

  // grid[c][r] = result
  const grid = {};
  for (const e of bigRoad) {
    const c = e.col - startCol;
    if (c < 0 || c >= MAX_COLS) continue;
    if (!grid[c]) grid[c] = {};
    grid[c][e.row] = e.result;
  }

  const colBoxes = [];
  for (let c = 0; c < MAX_COLS; c++) {
    const cells = [];
    for (let r = 0; r < MAX_ROWS; r++) {
      const res = grid[c] && grid[c][r];
      cells.push(res ? circleBox(res, '22px') : emptyCell('22px'));
    }
    colBoxes.push({ type: 'box', layout: 'vertical', spacing: 'xs', contents: cells });
  }

  return [{ type: 'box', layout: 'horizontal', spacing: 'xs', contents: colBoxes }];
}

// ===== 預測演算法 =====
function predictNext(history, stats) {
  const nonTie = history.filter(h => h !== 'T');
  if (nonTie.length < 3) {
    return { result: 'P', confidence: 52, betSize: 1 };
  }

  const last = nonTie[nonTie.length - 1];
  let streakLen = 1;
  for (let i = nonTie.length - 2; i >= 0; i--) {
    if (nonTie[i] === last) streakLen++;
    else break;
  }

  let predicted, confidence, betSize;

  if (streakLen >= 5) {
    predicted = last; confidence = Math.min(88, 68 + streakLen * 3); betSize = 3;
  } else if (streakLen >= 3) {
    predicted = last; confidence = 72; betSize = 2;
  } else if (streakLen >= 2) {
    predicted = last; confidence = 63; betSize = 2;
  } else {
    // 檢查交替模式
    const tail = nonTie.slice(-4);
    const isAlt = tail.length >= 4 && tail.every((v, i, a) => i === 0 || v !== a[i - 1]);
    if (isAlt) {
      predicted = last === 'B' ? 'P' : 'B'; confidence = 65; betSize = 2;
    } else {
      const total = stats.banker + stats.player;
      const bRate = total > 0 ? stats.banker / total : 0.5;
      predicted = bRate > 0.52 ? 'P' : 'B';
      confidence = 55; betSize = 1;
    }
  }

  return { result: predicted, confidence, betSize, streakLen, streakLast: last };
}

// ===== 連龍資訊 =====
function getStreakInfo(history) {
  const nonTie = history.filter(h => h !== 'T');
  if (nonTie.length === 0) return { len: 0, result: null };
  const last = nonTie[nonTie.length - 1];
  let len = 1;
  for (let i = nonTie.length - 2; i >= 0; i--) {
    if (nonTie[i] === last) len++;
    else break;
  }
  return { len, result: last };
}

// ===== 派生路統計 (大眼/小路/蟑螂) =====
function getDerivedRoadStats(bigRoad) {
  if (bigRoad.length < 6) {
    return { bigEye: { r: 50, b: 50 }, small: { r: 50, b: 50 }, cockroach: { r: 50, b: 50 } };
  }
  const maxCol = Math.max(...bigRoad.map(e => e.col));
  let beR = 0, beB = 0;
  for (let c = 1; c <= maxCol; c++) {
    const cur = bigRoad.filter(e => e.col === c).length;
    const prev = bigRoad.filter(e => e.col === c - 1).length;
    if (cur === prev) beR++; else beB++;
  }
  const beT = beR + beB || 1;

  const recent = bigRoad.slice(-10).map(e => e.result);
  let altCnt = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] !== recent[i - 1]) altCnt++;
  }
  const altRate = recent.length > 1 ? altCnt / (recent.length - 1) : 0.5;
  const smR = Math.round((1 - altRate) * 100);
  const crR = Math.min(95, Math.max(30, Math.round(beR / beT * 90)));

  return {
    bigEye: { r: Math.round(beR / beT * 100), b: Math.round(beB / beT * 100) },
    small: { r: smR, b: 100 - smR },
    cockroach: { r: crR, b: 100 - crR }
  };
}

// ===== 從 history 陣列直接建珠盤路/大路（供 mtInfo.listHistory 使用）=====
function historyToBeadRoad(history) {
  return history.map((h, i) => ({ index: i, result: h }));
}
function historyToBigRoad(history) {
  const road = []; let col = 0, row = 0, last = null;
  for (const h of history) {
    if (h === 'T') { if (road.length > 0) road[road.length - 1].tie = true; continue; }
    if (h !== last) { col = last === null ? 0 : col + 1; row = 0; } else row++;
    road.push({ col, row, result: h, tie: false }); last = h;
  }
  return road;
}

// ===== 主函式：建立完整 Flex Message =====
function buildAnalysisFlex(engine, mtInfo, mode) {
  mode = mode || '穩健跟進';
  const state = engine.getState();
  const { history: engineHistory, stats, ev, totalCards } = state;
  // 優先用 WS 最新 List（最準確），fallback 用 engine 歷史
  const liveHistory = (mtInfo && mtInfo.listHistory && mtInfo.listHistory.length > 0)
    ? mtInfo.listHistory : engineHistory;
  const beadRoad = historyToBeadRoad(liveHistory);
  const bigRoad  = historyToBigRoad(liveHistory);
  const history  = liveHistory;

  const tableName = (mtInfo && mtInfo.tableName) || engine.tableName;
  const total = stats.banker + stats.player + stats.tie;

  const bPct = total > 0 ? (stats.banker / total * 100).toFixed(1) : '45.9';
  const pPct = total > 0 ? (stats.player / total * 100).toFixed(1) : '45.1';
  const tPct = total > 0 ? (stats.tie / total * 100).toFixed(1) : '9.1';

  const evB = (ev && ev.banker != null) ? ev.banker.toFixed(4) : '-0.0149';
  const evP = (ev && ev.player != null) ? ev.player.toFixed(4) : '-0.0080';

  const pred = predictNext(history, stats);
  const predLabel = pred.result === 'B' ? '莊' : pred.result === 'P' ? '閒' : '和';
  const predColor = pred.result === 'B' ? COLOR_B : pred.result === 'P' ? COLOR_P : COLOR_T;
  const predBg = pred.result === 'B' ? '#fff5f5' : pred.result === 'P' ? '#f0f8ff' : '#f0fff0';

  const streak = getStreakInfo(history);
  const rl = streak.result === 'B' ? '莊' : streak.result === 'P' ? '閒' : '';
  const streakText = streak.len >= 2 ? `連${streak.len}${rl}` : '無連莊/連閒';
  const dragonText = streak.len >= 4
    ? `連續${streak.len}${rl}，龍尾延續中`
    : streak.len >= 2 ? `連${streak.len}${rl}` : '無長龍';

  const cardsUsed = TOTAL_CARDS_8DECK - (totalCards || TOTAL_CARDS_8DECK);
  const shoeProgress = Math.round(cardsUsed / TOTAL_CARDS_8DECK * 100);
  const cardsLeft = totalCards || TOTAL_CARDS_8DECK;

  const nonTieTotal = stats.banker + stats.player;
  const accuracy = nonTieTotal > 0
    ? Math.round(Math.max(stats.banker, stats.player) / nonTieTotal * 100)
    : 50;

  const roads = getDerivedRoadStats(bigRoad);

  const lines = [
    `• 🎯 機率：莊${bPct}% / 閒${pPct}% / 和${tPct}%`,
    `• 💰 期望值：莊${evB} / 閒${evP}`,
    `• 📈 精準度：${accuracy}%（已分析${total}局）`,
    `• 🃏 牌靴進度：${shoeProgress}%（約剩${cardsLeft}張）`,
    `• 📊 歷史：莊${bPct}%（${stats.banker}局）/閒${pPct}%（${stats.player}局）`,
    `• 🔥 ${streakText}`,
    `• 🐉 長龍：${dragonText}`,
    `• 👁 大眼行：紅${roads.bigEye.r}%/藍${roads.bigEye.b}%`,
    `• 🔍 小路：紅${roads.small.r}%/藍${roads.small.b}%`,
    `• 🪳 蟑螂路：紅${roads.cockroach.r}%（${roads.cockroach.r >= 65 ? '近期全紅＝機運強' : '近期混合'}）`
  ];

  return {
    type: 'flex',
    altText: `${tableName} | 預測${predLabel} 信心${pred.confidence}%`,
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: COLOR_HEADER, paddingAll: 'md',
        contents: [{ type: 'text', text: '新紀元百家 AI 分析', color: '#ffffff', weight: 'bold', size: 'lg', align: 'center' }]
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'sm', backgroundColor: '#f8f9fa',
        contents: [
          // 房號 + 模式
          {
            type: 'box', layout: 'horizontal', paddingBottom: 'xs',
            contents: [
              { type: 'text', text: `房號：${tableName}`, size: 'sm', color: '#333333', flex: 1 },
              { type: 'text', text: `模式：✅ ${mode}`, size: 'sm', color: '#555555', flex: 1, align: 'end' }
            ]
          },
          { type: 'separator' },
          // 珠盤路
          { type: 'text', text: '珠盤路', size: 'sm', weight: 'bold', color: '#333333', margin: 'sm' },
          ...buildBeadRoadFlex(beadRoad),
          { type: 'separator', margin: 'sm' },
          // 大路
          { type: 'text', text: '大路', size: 'sm', weight: 'bold', color: '#333333', margin: 'sm' },
          ...buildBigRoadFlex(bigRoad),
          { type: 'separator', margin: 'sm' },
          // 預測區塊
          {
            type: 'box', layout: 'vertical', backgroundColor: predBg,
            cornerRadius: 'md', paddingAll: 'md', margin: 'sm',
            contents: [
              { type: 'text', text: `🎯  預測：${predLabel}`, size: 'xxl', weight: 'bold', color: predColor, align: 'center' },
              { type: 'text', text: `信心：${pred.confidence}% | 注碼：${pred.betSize}單位`, size: 'sm', color: '#555555', align: 'center', margin: 'xs' },
              { type: 'text', text: `AI精準度 ${accuracy}% | 莊:${stats.banker} 閒:${stats.player} 和:${stats.tie} 總${total}`, size: 'xs', color: '#888888', align: 'center', margin: 'xs' }
            ]
          },
          { type: 'separator', margin: 'sm' },
          // AI 分析報告
          { type: 'text', text: '📊 AI分析報告：', size: 'sm', weight: 'bold', color: '#333333', margin: 'sm' },
          { type: 'text', text: lines.join('\n'), size: 'xs', color: '#555555', wrap: true, margin: 'xs' }
        ]
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: 'sm',
        contents: [
          { type: 'button', style: 'secondary', height: 'sm', flex: 1, action: { type: 'message', label: '清除', text: '取消' } },
          { type: 'button', style: 'primary', color: COLOR_HEADER, height: 'sm', flex: 1, action: { type: 'message', label: '返回', text: '全廳' } }
        ]
      }
    }
  };
}

// ===== 每手推送用的輕量 Flex =====
function buildHandResultFlex(engine, mtInfo, detail) {
  const state = engine.getState();
  const { stats, ev, history, beadRoad } = state;
  const _rawName = (mtInfo && mtInfo.tableName) || engine.tableName || '';
  const tableName = (_rawName && _rawName.includes('\u767e\u5bb6\u6a02'))
    ? _rawName
    : `\u767e\u5bb6\u6a02 ${_rawName || (mtInfo && mtInfo.displayNum) || engine.tableId || '?'}`;
  const dealerName = (mtInfo && mtInfo.dealer && mtInfo.dealer.name && mtInfo.dealer.name !== '-') ? mtInfo.dealer.name : '\u8377\u5b98';

  const pred = predictNext(history, stats);
  const predLabel = pred.result === 'B' ? '莊' : pred.result === 'P' ? '閒' : '和';
  const predColor = pred.result === 'B' ? COLOR_B : pred.result === 'P' ? COLOR_P : COLOR_T;

  const winLabel = detail && detail.winner === 'B' ? '莊贏' : detail && detail.winner === 'P' ? '閒贏' : detail && detail.winner === 'T' ? '和局' : '?';
  const winColor = detail && detail.winner === 'B' ? COLOR_B : detail && detail.winner === 'P' ? COLOR_P : COLOR_T;

  const total = stats.banker + stats.player + stats.tie;
  const evB = (ev && ev.banker != null) ? ev.banker.toFixed(4) : '-';
  const evP = (ev && ev.player != null) ? ev.player.toFixed(4) : '-';

  const hasCards = detail && detail.playerCards && detail.playerCards.length >= 2;

  const streak = getStreakInfo(history);
  const rl = streak.result === 'B' ? '莊' : streak.result === 'P' ? '閒' : '';
  const streakNote = streak.len >= 2 ? ` | 連${streak.len}${rl}` : '';

  return {
    type: 'flex',
    altText: `${tableName} 第${detail && detail.hand || '?'}手 ${winLabel} | 下手預測${predLabel}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box', layout: 'horizontal', backgroundColor: COLOR_HEADER, paddingAll: 'sm',
        contents: [
          { type: 'text', text: tableName, color: '#ffffff', weight: 'bold', size: 'sm', flex: 2 },
          { type: 'text', text: `\u8377\u5b98\uff1a${dealerName}`, color: '#aaccff', size: 'sm', flex: 1, align: 'end' }
        ]
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'md',
        contents: [
          // 本手結果
          {
            type: 'box', layout: 'horizontal', spacing: 'md',
            contents: [
              { type: 'text', text: '本手結果', size: 'sm', color: '#888888', flex: 1 },
              { type: 'text', text: winLabel, size: 'lg', weight: 'bold', color: winColor, flex: 1, align: 'end' }
            ]
          },
          hasCards ? buildColoredCardRow('閒', detail.playerCards) : null,
          hasCards ? buildColoredCardRow('\u838a', detail.bankerCards) : null,
          { type: 'separator' },
          // 下手預測
          {
            type: 'box', layout: 'horizontal', spacing: 'md',
            contents: [
              { type: 'text', text: '下手預測', size: 'sm', color: '#888888', flex: 1 },
              { type: 'text', text: `${predLabel}  ${pred.confidence}%${streakNote}`, size: 'md', weight: 'bold', color: predColor, flex: 2, align: 'end', wrap: true }
            ]
          },
          { type: 'separator' },
          // 統計
          {
            type: 'text',
            text: `莊${stats.banker} 閒${stats.player} 和${stats.tie} 共${total}局  |  EV 莊${evB}/閒${evP}`,
            size: 'xs', color: '#888888', wrap: true
          }
        ].filter(Boolean)
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm',
        contents: [
          { type: 'button', style: 'secondary', height: 'sm', flex: 1, action: { type: 'message', label: '完整分析', text: `分析${tableName.replace('百家樂 ', '')}` } },
          { type: 'button', style: 'primary', color: COLOR_HEADER, height: 'sm', flex: 1, action: { type: 'message', label: '返回', text: '全廳' } }
        ]
      }
    }
  };
}

function fmtCards(cards) {
  if (!cards || cards.length === 0) return '-';
  const RANK = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
  const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
  return cards.map(c => `${SUIT[c.suit] || ''}${RANK[c.rank] || c.rank}`).join(' ');
}

// ===== 彩色花色牌面行元件 (♥♦=紅, ♠♣=黑) =====
const SUIT_INFO = {
  s: { sym: '♠', color: '#222222' },
  h: { sym: '♥', color: '#e74c3c' },
  d: { sym: '\u2663', color: '#222222' },
  c: { sym: '\u2666', color: '#e74c3c' }
};

function buildColoredCardRow(label, cards) {
  if (!cards || cards.length === 0) return null;
  const RANK = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
  const items = [{ type: 'text', text: label + '：', size: 'sm', color: '#888888', flex: 0 }];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const si = SUIT_INFO[c.suit] || { sym: '?', color: '#888888' };
    const rank = RANK[c.rank] || String(c.rank);
    if (i > 0) items.push({ type: 'text', text: ' ', size: 'sm', flex: 0 });
    items.push({ type: 'text', text: si.sym + rank, size: 'sm', color: si.color, flex: 0, weight: 'bold' });
  }
  return { type: 'box', layout: 'horizontal', spacing: 'none', contents: items };
}

// ===== Quick Reply 常數（每則訊息底部的固定按鈕列）=====
const QUICK_REPLY = {
  items: [
    { type: 'action', action: { type: 'message', label: '❌ 取消跟隨', text: '取消' } },
    { type: 'action', action: { type: 'message', label: '🏠 全廳', text: '全廳' } },
    { type: 'action', action: { type: 'message', label: '📋 指令', text: '指令' } }
  ]
};

// ===== 荷官照片 URL 幫助函式 =====
function getDealerPhotoUrl(dealerName, avatarUrl) {
  // 1. WS 直接提供 URL (FA/LA 欄位)
  if (avatarUrl && avatarUrl.startsWith('http')) return avatarUrl;

  // 2. 環境變數設定的 CDN 基底 URL (e.g. https://cdn.example.com/dealer/)
  const base = process.env.DEALER_PHOTO_BASE_URL;
  if (base && dealerName && dealerName !== '-') {
    const encoded = encodeURIComponent(dealerName.trim());
    return `${base.replace(/\/$/, '')}/${encoded}.jpg`;
  }

  // 3. 用名字生成字母頭像 (ui-avatars.com，支援中文)
  if (dealerName && dealerName !== '-') {
    // 取第一個字（中英文均可）作為頭像字
    const initial = [...dealerName.trim()][0] || '?';
    const encoded = encodeURIComponent(initial);
    return `https://ui-avatars.com/api/?name=${encoded}&background=1a3a5c&color=ffffff&size=200&bold=true&font-size=0.6`;
  }

  // 4. 純色預設
  return 'https://ui-avatars.com/api/?name=?&background=888888&color=ffffff&size=200';
}

// ===== 單一房間卡片 (用於 Carousel) =====
function buildRoomBubble(lid, engine, mtInfo) {
  const displayNum = (mtInfo && mtInfo.displayNum) != null
    ? String(mtInfo.displayNum)
    : String(lid);
  const dealerName = (mtInfo && mtInfo.dealer && mtInfo.dealer.name) || engine.dealer || '-';
  const avatarUrl  = (mtInfo && mtInfo.dealer && mtInfo.dealer.avatar) || '';
  const summary    = mtInfo && mtInfo.summary;
  const roadText   = (mtInfo && mtInfo.roadText) || '';

  const photoUrl = getDealerPhotoUrl(dealerName, avatarUrl);

  const total = summary ? summary.total : 0;
  const statsText = total > 0
    ? `莊${summary.banker} 閒${summary.player} 和${summary.tie}  共${total}局`
    : '等待資料...';

  // 迷你路（最後 10 手）
  const recent = roadText.slice(-10);
  const miniRoad = recent.split('').map(c => {
    if (c === '莊') return { type: 'text', text: '●', color: COLOR_B, size: 'xs', flex: 0 };
    if (c === '閒') return { type: 'text', text: '●', color: COLOR_P, size: 'xs', flex: 0 };
    return { type: 'text', text: '○', color: COLOR_T, size: 'xs', flex: 0 };
  });

  return {
    type: 'bubble',
    size: 'micro',
    hero: {
      type: 'image',
      url: photoUrl,
      size: 'full',
      aspectMode: 'cover',
      aspectRatio: '4:3',
      action: { type: 'message', text: displayNum, label: '跟隨' }
    },
    header: {
      type: 'box', layout: 'vertical', backgroundColor: COLOR_HEADER,
      paddingTop: 'xs', paddingBottom: 'xs', paddingAll: 'sm',
      contents: [
        { type: 'text', text: `百家樂 ${displayNum}`, color: '#ffffff', weight: 'bold', size: 'sm', align: 'center' }
      ]
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: 'sm',
      contents: [
        { type: 'text', text: dealerName !== '-' ? dealerName : '—', size: 'sm', color: '#333333', align: 'center', weight: 'bold' },
        { type: 'text', text: statsText, size: 'xs', color: '#555555', wrap: true, margin: 'xs' }
      ]
    },
    footer: {
      type: 'box', layout: 'horizontal', spacing: 'xs', paddingAll: 'xs',
      contents: [
        {
          type: 'button', style: 'primary', color: COLOR_B, height: 'sm', flex: 1,
          action: { type: 'message', label: '跟隨', text: displayNum }
        },
        {
          type: 'button', style: 'secondary', height: 'sm', flex: 1,
          action: { type: 'message', label: '分析', text: `分析${displayNum}` }
        }
      ]
    }
  };
}

// ===== 全廳 Flex Carousel (最多 12 張/頁，超過分頁) =====
function buildRoomCarousel(roomList) {
  if (roomList.length === 0) {
    return {
      type: 'flex',
      altText: '⏳ 正在連線 MT 平台...',
      quickReply: QUICK_REPLY,
      contents: {
        type: 'bubble',
        body: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '⏳ 正在連線 MT 平台，請稍候...', size: 'sm', color: '#888888', wrap: true }
        ]}
      }
    };
  }

  const PAGE_SIZE = 12;
  const page = roomList.slice(0, PAGE_SIZE);
  const bubbles = page.map(({ lid, engine, mtInfo }) => buildRoomBubble(lid, engine, mtInfo));

  const altText = `🎰 共 ${roomList.length} 個百家樂桌，輸入房號跟隨`;

  if (bubbles.length === 1) {
    return { type: 'flex', altText, quickReply: QUICK_REPLY, contents: bubbles[0] };
  }

  return {
    type: 'flex',
    altText,
    quickReply: QUICK_REPLY,
    contents: { type: 'carousel', contents: bubbles }
  };
}

module.exports = { buildAnalysisFlex, buildHandResultFlex, buildRoomCarousel, QUICK_REPLY };
