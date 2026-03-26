/**
 * 百家樂 EV 計算引擎
 * 基於剩餘牌組計算莊/閒/和的期望值
 */

// 8副牌初始牌組
const INITIAL_SHOE = {
  1: 32, 2: 32, 3: 32, 4: 32, 5: 32,
  6: 32, 7: 32, 8: 32, 9: 32, 0: 128 // 10,J,Q,K 都算0
};

const TOTAL_CARDS_8DECK = 416;

// 牌面顯示名稱
const RANK_NAMES = { 1:'A', 2:'2', 3:'3', 4:'4', 5:'5', 6:'6', 7:'7', 8:'8', 9:'9', 10:'10', 11:'J', 12:'Q', 13:'K' };
const SUIT_SYMBOLS = { 's':'♠', 'h':'♥', 'd':'♦', 'c':'♣' };

class BaccaratEngine {
  constructor(tableId, tableName) {
    this.tableId = tableId;
    this.tableName = tableName || `桌 ${tableId}`;
    this.dealer = '';       // 荷官名字
    this.shoe = { ...INITIAL_SHOE };
    this.totalCards = TOTAL_CARDS_8DECK;
    this.history = [];      // 歷史紀錄 ['B','P','T','B',...]
    this.handDetails = [];  // 每手詳細開牌紀錄
    this.roadMap = [];      // 路紙資料
    this.handCount = 0;
    this.stats = { banker: 0, player: 0, tie: 0, bankerPair: 0, playerPair: 0 };
  }

  // 設定荷官
  setDealer(name) {
    this.dealer = name || '';
  }

  // 重置牌靴
  resetShoe() {
    this.shoe = { ...INITIAL_SHOE };
    this.totalCards = TOTAL_CARDS_8DECK;
    this.history = [];
    this.handDetails = [];
    this.roadMap = [];
    this.handCount = 0;
    this.stats = { banker: 0, player: 0, tie: 0, bankerPair: 0, playerPair: 0 };
  }

  // 記錄一手結果（含完整牌型）
  // playerCards / bankerCards: [{rank:1-13, suit:'s'|'h'|'d'|'c'}, ...]
  recordHand(result, playerCards, bankerCards) {
    this.handCount++;
    this.history.push(result);

    if (result === 'B') this.stats.banker++;
    else if (result === 'P') this.stats.player++;
    else if (result === 'T') this.stats.tie++;

    // 建構本手詳細紀錄
    const detail = {
      hand: this.handCount,
      result,
      playerCards: playerCards || [],
      bankerCards: bankerCards || [],
      playerTotal: 0,
      bankerTotal: 0,
      playerPair: false,
      bankerPair: false,
      natural: false,
      dealer: this.dealer
    };

    // 計算點數 & 從牌組扣除
    const allCards = [...(playerCards || []), ...(bankerCards || [])];
    if (allCards.length > 0) {
      for (const card of allCards) {
        const val = this._cardValue(card.rank);
        if (this.shoe[val] !== undefined && this.shoe[val] > 0) {
          this.shoe[val]--;
          this.totalCards--;
        }
      }
      detail.playerTotal = this._calcTotal(playerCards);
      detail.bankerTotal = this._calcTotal(bankerCards);

      // 對子判定（前兩張同點）
      if (playerCards && playerCards.length >= 2 && playerCards[0].rank === playerCards[1].rank) {
        detail.playerPair = true;
        this.stats.playerPair++;
      }
      if (bankerCards && bankerCards.length >= 2 && bankerCards[0].rank === bankerCards[1].rank) {
        detail.bankerPair = true;
        this.stats.bankerPair++;
      }

      // 天牌判定（前兩張合計8或9）
      if (playerCards && playerCards.length >= 2) {
        const natP = (this._cardValue(playerCards[0].rank) + this._cardValue(playerCards[1].rank)) % 10;
        const natB = bankerCards && bankerCards.length >= 2
          ? (this._cardValue(bankerCards[0].rank) + this._cardValue(bankerCards[1].rank)) % 10 : 0;
        if (natP >= 8 || natB >= 8) detail.natural = true;
      }
    } else {
      this.totalCards = Math.max(0, this.totalCards - 5);
    }

    this.handDetails.push(detail);

    // 更新路紙
    this._updateRoadMap(result);

    return this.calculateEV();
  }

  // 計算牌值 (rank 1-13 → baccarat value 0-9)
  _cardValue(rank) {
    if (rank >= 10) return 0;
    return rank;
  }

  // 計算一手牌的總點數
  _calcTotal(cards) {
    if (!cards || cards.length === 0) return 0;
    let sum = 0;
    for (const c of cards) sum += this._cardValue(c.rank);
    return sum % 10;
  }

  // 格式化單張牌顯示
  static formatCard(card) {
    const rankStr = RANK_NAMES[card.rank] || card.rank;
    const suitStr = SUIT_SYMBOLS[card.suit] || card.suit || '';
    return suitStr + rankStr;
  }

  // 格式化一手牌顯示
  static formatHand(cards) {
    if (!cards || cards.length === 0) return '-';
    return cards.map(c => BaccaratEngine.formatCard(c)).join(' ');
  }

  // 計算 EV (期望值) — Griffin 逐張計數 + 歷史牌型分析
  calculateEV() {
    if (this.totalCards < 6) {
      return { banker: 0, player: 0, tie: 0, bankerEdge: 0, playerEdge: 0 };
    }

    const remaining = this.totalCards;
    const shoe = this.shoe;

    // 8副牌標準初始數量
    const STD = { 0: 128, 1: 32, 2: 32, 3: 32, 4: 32, 5: 32, 6: 32, 7: 32, 8: 32, 9: 32 };

    // 基礎機率（8副牌精確值）
    // 莊: 45.8597%  閒: 44.6247%  和: 9.5156%
    let bankerProb = 0.458597;
    let playerProb = 0.446247;
    let tieProb    = 0.095156;

    // ── Griffin 計數系統 ──
    // 每張牌移出後對莊家優勢的影響（正=對莊有利, 負=對閒有利）
    // 來源：Griffin 百家樂計數研究 / 牌靴滲透理論
    const BANKER_EFFECT = {
      0: -1,   // 10/J/Q/K：偏向閒
      1: +4,   // A：對莊顯著有利（第三張牌規則）
      2: +3,   // 2
      3: +2,   // 3
      4: -5,   // 4：移除後大幅減少莊優勢（最關鍵牌）
      5: -4,   // 5
      6: +4,   // 6：移除後對莊有利
      7: +3,   // 7
      8: -3,   // 8：對閒有利
      9: -2    // 9
    };

    // 計算 Running Count（已移除牌的加權總和）
    let runningCount = 0;
    for (let v = 0; v <= 9; v++) {
      const removed = STD[v] - (shoe[v] || 0);
      if (removed > 0) runningCount += removed * BANKER_EFFECT[v];
    }

    // True Count = Running Count ÷ 剩餘牌靴數
    const remainingDecks = remaining / 52;
    const trueCount = remainingDecks > 0 ? runningCount / remainingDecks : 0;

    // 調整機率（每個 true count 單位影響 0.0007）
    const adjust = trueCount * 0.0007;
    bankerProb += adjust;
    playerProb -= adjust * 0.8;
    tieProb    -= adjust * 0.2;

    // ── 歷史所有牌型分析 ──
    const histBias = this._analyzeHistoricalCards();
    bankerProb += histBias.bankerBias;
    playerProb += histBias.playerBias;

    // ── 近期走勢偏差（最近 40 手）──
    if (this.history.length >= 15) {
      const recent = this.history.slice(-40).filter(h => h !== 'T');
      if (recent.length >= 10) {
        const recentB = recent.filter(h => h === 'B').length / recent.length;
        const expectedB = 0.458597 / (0.458597 + 0.446247); // ≈ 0.507
        // 輕微回歸均值修正（趨勢反轉理論）
        const trendAdj = (recentB - expectedB) * 0.015;
        bankerProb -= trendAdj;
        playerProb += trendAdj;
      }
    }

    // 夾限 + 正規化
    bankerProb = Math.max(0.40, Math.min(0.53, bankerProb));
    playerProb = Math.max(0.38, Math.min(0.51, playerProb));
    tieProb    = Math.max(0.07, Math.min(0.14, tieProb));
    const tot = bankerProb + playerProb + tieProb;
    bankerProb /= tot;
    playerProb /= tot;
    tieProb    /= tot;

    // ── 正確 EV 公式 ──
    // 和局在莊/閒注中算 PUSH（退還本金），不是輸
    // 莊：贏賠 0.95（扣 5% 佣金），輸賠 -1，和 = 0
    // 閒：贏賠 1.0，輸賠 -1，和 = 0
    const bankerEV = bankerProb * 0.95 - playerProb;  // tie = push (×0)
    const playerEV = playerProb          - bankerProb; // tie = push (×0)
    const tieEV    = tieProb * 8         - (1 - tieProb); // 和注：贏賠8，不中賠-1

    const penetration = parseFloat(((1 - remaining / 416) * 100).toFixed(1));

    return {
      banker:       parseFloat(bankerEV.toFixed(6)),
      player:       parseFloat(playerEV.toFixed(6)),
      tie:          parseFloat(tieEV.toFixed(6)),
      bankerProb:   parseFloat((bankerProb * 100).toFixed(2)),
      playerProb:   parseFloat((playerProb * 100).toFixed(2)),
      tieProb:      parseFloat((tieProb * 100).toFixed(2)),
      bankerEdge:   parseFloat((bankerProb - playerProb).toFixed(6)),
      playerEdge:   parseFloat((playerProb - bankerProb).toFixed(6)),
      remainingCards: remaining,
      penetration,
      handCount: this.handCount
    };
  }

  // 分析歷史所有牌型，對剩餘牌靴做偏差修正
  _analyzeHistoricalCards() {
    const details = this.handDetails.filter(
      d => d.playerCards && d.playerCards.length >= 2 &&
           d.bankerCards  && d.bankerCards.length  >= 2
    );
    if (details.length < 5) return { bankerBias: 0, playerBias: 0 };

    // 統計歷史出牌分佈
    const seen = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };
    let total = 0;
    for (const d of details) {
      for (const card of [...d.playerCards, ...d.bankerCards]) {
        const v = this._cardValue(card.rank);
        seen[v]++;
        total++;
      }
    }
    if (total === 0) return { bankerBias: 0, playerBias: 0 };

    // 標準出牌頻率
    const stdFreq = { 0: 128/416, 1: 32/416, 2: 32/416, 3: 32/416,
                      4: 32/416, 5: 32/416, 6: 32/416, 7: 32/416, 8: 32/416, 9: 32/416 };

    // Griffin 效果（同 calculateEV 中）
    const BANKER_EFFECT = { 0:-1, 1:4, 2:3, 3:2, 4:-5, 5:-4, 6:4, 7:3, 8:-3, 9:-2 };

    // 若某張牌在歷史中出現頻率偏高 → 剩餘牌靴中偏少 → 反向修正
    let bankerBias = 0;
    for (let v = 0; v <= 9; v++) {
      const actualFreq  = seen[v] / total;
      const deviation   = actualFreq - stdFreq[v]; // 正=歷史偏多 → 剩餘偏少
      // 歷史多 → 剩餘少 → 對莊的效果與 BANKER_EFFECT 反向
      bankerBias -= deviation * BANKER_EFFECT[v] * 0.004;
    }

    return {
      bankerBias: Math.max(-0.025, Math.min(0.025, bankerBias)),
      playerBias: Math.max(-0.025, Math.min(0.025, -bankerBias))
    };
  }

  // 更新路紙 (大路)
  _updateRoadMap(result) {
    const lastEntry = this.roadMap.length > 0 ? this.roadMap[this.roadMap.length - 1] : null;

    if (!lastEntry || (lastEntry.result !== result && result !== 'T')) {
      // 新列
      this.roadMap.push({
        result: result === 'T' ? (lastEntry ? lastEntry.result : 'B') : result,
        count: result === 'T' ? 0 : 1,
        ties: result === 'T' ? 1 : 0,
        col: lastEntry ? lastEntry.col + 1 : 0
      });
    } else {
      // 同列繼續
      if (result === 'T') {
        lastEntry.ties++;
      } else {
        lastEntry.count++;
      }
    }
  }

  // 取得路紙資料 (大路格式)
  getBigRoad() {
    const road = [];
    let col = 0;
    let row = 0;
    let lastResult = null;

    for (const h of this.history) {
      if (h === 'T') {
        // 和局標記在上一個位置
        if (road.length > 0) {
          road[road.length - 1].tie = true;
        }
        continue;
      }

      if (h !== lastResult) {
        col = lastResult === null ? 0 : col + 1;
        row = 0;
      } else {
        row++;
      }

      road.push({ col, row, result: h, tie: false });
      lastResult = h;
    }

    return road;
  }

  // 取得珠盤路
  getBeadRoad() {
    return this.history.map((h, i) => ({
      index: i,
      result: h
    }));
  }

  // 取得完整狀態
  getState() {
    const ev = this.calculateEV();
    return {
      tableId: this.tableId,
      tableName: this.tableName,
      dealer: this.dealer,
      handCount: this.handCount,
      history: this.history,
      handDetails: this.handDetails,
      stats: this.stats,
      ev: ev,
      bigRoad: this.getBigRoad(),
      beadRoad: this.getBeadRoad(),
      totalCards: this.totalCards
    };
  }

  // 取得最近N手紀錄
  getRecentHistory(n = 20) {
    return this.history.slice(-n);
  }

  // 分析趨勢
  analyzeTrend() {
    const recent = this.getRecentHistory(10);
    if (recent.length < 3) return { trend: '資料不足', confidence: 0 };

    // 連莊/連閒分析
    let streak = 1;
    const lastResult = recent[recent.length - 1];
    for (let i = recent.length - 2; i >= 0; i--) {
      if (recent[i] === lastResult) streak++;
      else break;
    }

    // 計算近期莊閒比
    const recentBanker = recent.filter(r => r === 'B').length;
    const recentPlayer = recent.filter(r => r === 'P').length;

    let trend = '';
    let confidence = 0;

    if (streak >= 6) {
      trend = `長${lastResult === 'B' ? '莊' : '閒'} (連${streak})`;
      confidence = 0.7;
    } else if (streak >= 4) {
      trend = `連${lastResult === 'B' ? '莊' : '閒'} (${streak}連)`;
      confidence = 0.5;
    } else if (this._isZigzag(recent)) {
      trend = '單跳 (閒莊交替)';
      confidence = 0.4;
    } else if (recentBanker > recentPlayer * 1.5) {
      trend = '莊強勢';
      confidence = 0.3;
    } else if (recentPlayer > recentBanker * 1.5) {
      trend = '閒強勢';
      confidence = 0.3;
    } else {
      trend = '均勢';
      confidence = 0.2;
    }

    return { trend, confidence, streak, lastResult };
  }

  // 判斷是否為單跳 (zigzag)
  _isZigzag(arr) {
    if (arr.length < 4) return false;
    const recent4 = arr.slice(-4).filter(r => r !== 'T');
    if (recent4.length < 4) return false;
    for (let i = 1; i < recent4.length; i++) {
      if (recent4[i] === recent4[i - 1]) return false;
    }
    return true;
  }
}

module.exports = BaccaratEngine;
