'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'users.json');
const TRIAL_MS  = 5 * 60 * 1000; // 5 分鐘試用
const VALID_DAYS = [1, 2, 3, 7, 15, 30, 365];

function fmtDate(ts) {
  return new Date(ts).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
}

class UserManager {
  constructor(adminIds = []) {
    this.admins = new Set(adminIds.filter(Boolean));
    this.users  = new Map(); // userId -> { firstSeen, trialExpiry, expiry }
    this.codes  = new Map(); // code   -> { days, createdBy, createdAt, usedBy, usedAt }
    this._load();
  }

  // ── 持久化 ──────────────────────────────────────────────
  _load() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (data.users) for (const [k, v] of Object.entries(data.users)) this.users.set(k, v);
        if (data.codes) for (const [k, v] of Object.entries(data.codes)) this.codes.set(k, v);
        console.log(`👥 UserManager 載入: ${this.users.size} 用戶, ${this.codes.size} 序號`);
      }
    } catch (e) { console.error('UserManager 載入失敗:', e.message); }
  }

  _save() {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify({
        users: Object.fromEntries(this.users),
        codes: Object.fromEntries(this.codes)
      }, null, 2));
    } catch (e) { console.error('UserManager 儲存失敗:', e.message); }
  }

  // ── 用戶初始化 ───────────────────────────────────────────
  _getOrCreate(userId) {
    if (!this.users.has(userId)) {
      const now = Date.now();
      this.users.set(userId, { firstSeen: now, trialExpiry: now + TRIAL_MS, expiry: null });
      this._save();
    }
    return this.users.get(userId);
  }

  // ── 核心方法 ─────────────────────────────────────────────
  isAdmin(userId) { return this.admins.has(userId); }

  /**
   * 回傳 { ok, reason, expiry, remaining }
   * reason: 'admin' | 'active' | 'trial' | 'expired'
   */
  checkAccess(userId) {
    if (this.admins.has(userId)) return { ok: true, reason: 'admin' };
    const u = this._getOrCreate(userId);
    const now = Date.now();
    if (u.expiry && u.expiry > now) {
      return { ok: true, reason: 'active', expiry: u.expiry, remaining: u.expiry - now };
    }
    if (u.trialExpiry > now) {
      return { ok: true, reason: 'trial', expiry: u.trialExpiry, remaining: u.trialExpiry - now };
    }
    return { ok: false, reason: 'expired' };
  }

  // ── 管理員: 生成序號 ─────────────────────────────────────
  generateCode(days, adminId) {
    const d = Number(days);
    if (!VALID_DAYS.includes(d)) {
      return { ok: false, error: `天數須為 ${VALID_DAYS.join(' / ')} 其中之一` };
    }
    const code = this._mkCode();
    this.codes.set(code, {
      days: d, createdBy: adminId, createdAt: Date.now(),
      usedBy: null, usedAt: null
    });
    this._save();
    return { ok: true, code, days: d };
  }

  // ── 用戶: 兌換序號 ───────────────────────────────────────
  redeemCode(userId, raw) {
    const code = raw.toUpperCase().replace(/[\s\u3000]/g, '');
    if (!this.codes.has(code)) return { ok: false, error: '序號不存在或輸入錯誤' };
    const c = this.codes.get(code);
    if (c.usedBy) return { ok: false, error: '此序號已被使用' };
    const now = Date.now();
    const u = this._getOrCreate(userId);
    // 累加：在現有有效期基礎上延長
    const base = (u.expiry && u.expiry > now) ? u.expiry : now;
    u.expiry = base + c.days * 86400000;
    c.usedBy = userId;
    c.usedAt = now;
    this._save();
    return { ok: true, days: c.days, expiry: u.expiry };
  }

  // ── 查詢用戶狀態文字 ─────────────────────────────────────
  getUserStatusText(userId) {
    if (this.admins.has(userId)) return '👑 管理員（永久使用權）';
    const u = this.users.get(userId);
    if (!u) return '🆕 新用戶（試用尚未開始）';
    const now = Date.now();
    if (u.expiry && u.expiry > now) {
      const rem = u.expiry - now;
      const d = Math.floor(rem / 86400000);
      const h = Math.floor((rem % 86400000) / 3600000);
      return `✅ 訂閱中，剩餘 ${d} 天 ${h} 小時\n到期: ${fmtDate(u.expiry)}`;
    }
    if (u.trialExpiry > now) {
      const m = Math.ceil((u.trialExpiry - now) / 60000);
      return `⏱ 試用中，剩餘約 ${m} 分鐘\n試用到期: ${fmtDate(u.trialExpiry)}`;
    }
    return `❌ 已到期 (${fmtDate(u.trialExpiry > u.expiry ? u.trialExpiry : (u.expiry || u.trialExpiry))})`;
  }

  // ── 管理員: 查詢用戶 ─────────────────────────────────────
  queryUser(uid) {
    if (this.admins.has(uid)) return `👑 管理員\nUID: ${uid}`;
    const u = this.users.get(uid);
    if (!u) return `❓ 查無此用戶\nUID: ${uid.substring(0, 20)}...`;
    const status = this.getUserStatusText(uid);
    return `👤 用戶資訊\nUID: ${uid.substring(0, 20)}...\n首次: ${fmtDate(u.firstSeen)}\n狀態: ${status}`;
  }

  // ── 管理員: 最近序號列表 ──────────────────────────────────
  listRecentCodes(limit = 10) {
    const entries = [...this.codes.entries()].slice(-limit);
    if (!entries.length) return null;
    return entries.map(([code, c]) =>
      `${code}\n  ${c.days}天 | ${c.usedBy ? `✅已用` : '⏳未用'} | ${fmtDate(c.createdAt)}`
    ).join('\n─\n');
  }

  // ── 產生隨機序號 XXXX-XXXX-XXXX-XXXX ─────────────────────
  _mkCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const seg = () => Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
    let code;
    do { code = [seg(), seg(), seg(), seg()].join('-'); } while (this.codes.has(code));
    return code;
  }
}

module.exports = UserManager;
