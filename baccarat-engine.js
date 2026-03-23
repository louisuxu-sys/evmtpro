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

  // 計算 EV (期望值)
  calculateEV() {
    if (this.totalCards < 6) {
      return { banker: 0, player: 0, tie: 0, bankerEdge: 0, playerEdge: 0 };
    }

    // 基於剩餘牌組的概率計算
    const remaining = this.totalCards;
    const shoe = this.shoe;

    // 基礎機率 (8副牌標準)
    // 莊贏: 45.86%, 閒贏: 44.62%, 和: 9.52%
    const baseBankerProb = 0.4586;
    const basePlayerProb = 0.4462;
    const baseTieProb = 0.0952;

    // 根據剩餘牌組調整機率
    // 高牌(6-9)多有利於莊，低牌(1-5)多有利於閒
    let highCards = 0;
    let lowCards = 0;
    for (let i = 1; i <= 5; i++) highCards += shoe[i] || 0;
    for (let i = 6; i <= 9; i++) lowCards += shoe[i] || 0;
    const zeroCards = shoe[0] || 0;

    const highRatio = remaining > 0 ? highCards / remaining : 0;
    const lowRatio = remaining > 0 ? lowCards / remaining : 0;
    const zeroRatio = remaining > 0 ? zeroCards / remaining : 0;

    // 調整因子
    const adjustment = (lowRatio - highRatio) * 0.15;
    const tieAdjustment = (zeroRatio - 128 / 416) * 0.08;

    let bankerProb = baseBankerProb + adjustment;
    let playerProb = basePlayerProb - adjustment;
    let tieProb = baseTieProb + tieAdjustment;

    // 正規化
    const total = bankerProb + playerProb + tieProb;
    bankerProb /= total;
    playerProb /= total;
    tieProb /= total;

    // EV 計算（考慮賠率）
    // 莊贏賠率 0.95 (扣5%佣金), 閒贏賠率 1.0, 和賠率 8.0
    const bankerEV = bankerProb * 0.95 - playerProb - tieProb;
    const playerEV = playerProb - bankerProb - tieProb;
    const tieEV = tieProb * 8 - bankerProb - playerProb;

    // 莊/閒的優勢差
    const bankerEdge = (bankerProb * 0.95 - (1 - bankerProb));
    const playerEdge = (playerProb - (1 - playerProb));

    return {
      banker: parseFloat(bankerEV.toFixed(6)),
      player: parseFloat(playerEV.toFixed(6)),
      tie: parseFloat(tieEV.toFixed(6)),
      bankerProb: parseFloat((bankerProb * 100).toFixed(2)),
      playerProb: parseFloat((playerProb * 100).toFixed(2)),
      tieProb: parseFloat((tieProb * 100).toFixed(2)),
      bankerEdge: parseFloat(bankerEdge.toFixed(6)),
      playerEdge: parseFloat(playerEdge.toFixed(6)),
      remainingCards: this.totalCards,
      handCount: this.handCount
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
