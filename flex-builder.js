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

// ===== 主函式：建立完整 Flex Message =====
function buildAnalysisFlex(engine, mtInfo, mode) {
  mode = mode || '穩健跟進';
  const state = engine.getState();
  const { history, stats, ev, beadRoad, bigRoad, totalCards } = state;

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
  const { stats, ev, history } = state;
  const tableName = (mtInfo && mtInfo.tableName) || engine.tableName;

  const pred = predictNext(history, stats);
  const predLabel = pred.result === 'B' ? '莊' : pred.result === 'P' ? '閒' : '和';
  const predColor = pred.result === 'B' ? COLOR_B : pred.result === 'P' ? COLOR_P : COLOR_T;

  const winLabel = detail && detail.winner === 'B' ? '莊贏' : detail && detail.winner === 'P' ? '閒贏' : detail && detail.winner === 'T' ? '和局' : '?';
  const winColor = detail && detail.winner === 'B' ? COLOR_B : detail && detail.winner === 'P' ? COLOR_P : COLOR_T;

  const total = stats.banker + stats.player + stats.tie;
  const evB = (ev && ev.banker != null) ? ev.banker.toFixed(4) : '-';
  const evP = (ev && ev.player != null) ? ev.player.toFixed(4) : '-';

  // 牌面
  let cardsText = '';
  if (detail && detail.playerCards && detail.playerCards.length >= 2) {
    cardsText = `閒：${fmtCards(detail.playerCards)}  莊：${fmtCards(detail.bankerCards)}`;
  }

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
          { type: 'text', text: `第 ${detail && detail.hand || '?'} 手`, color: '#aaccff', size: 'sm', flex: 1, align: 'end' }
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
          cardsText ? { type: 'text', text: cardsText, size: 'sm', color: '#444444', wrap: true } : null,
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

module.exports = { buildAnalysisFlex, buildHandResultFlex };
