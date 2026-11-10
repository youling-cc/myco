// identity/store.mjs — 身份持久化（node:sqlite，零依赖，对齐 SqliteBeliefStore 模式）。
// 三张表：
//   identity  — 注册账号：did(PK) + 公钥 + 加密私钥密文 + DID Document
//   challenge — 登录签名挑战：nonce(PK) + did + 过期 + 已用
//   session   — 登录会话：token(PK) + did + 过期
// 服务端只存私钥密文（C/salt/iv/iters），永不存明文私钥（见 DESIGN §3.3）。

import { DatabaseSync } from 'node:sqlite'
// （2026-10-08：did.mjs 的 didVariants import 随双格式变体查找删除而移除）

export class IdentityStore {
  constructor({ path = 'identity.db', memory = false, now } = {}) {
    this._now = typeof now === 'function' ? now : Date.now
    this._path = memory ? ':memory:' : path
    this._db = null
  }

  async open() {
    if (this._db) return
    this._db = new DatabaseSync(this._path)
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS identity (
        did TEXT PRIMARY KEY,
        publicKeyB64 TEXT NOT NULL,
        ciphertextB64 TEXT NOT NULL,
        saltB64 TEXT NOT NULL,
        ivB64 TEXT NOT NULL,
        iters INTEGER NOT NULL,
        didDocument TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS challenge (
        nonce TEXT PRIMARY KEY,
        did TEXT NOT NULL,
        expiresAt INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS session (
        token TEXT PRIMARY KEY,
        did TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL
      );
    `)
  }

  async close() {
    if (this._db) { this._db.close(); this._db = null }
  }

  _ensure() {
    if (!this._db) throw new Error('IdentityStore 未 open()')
    return this._db
  }

  async putIdentity(rec) {
    const db = this._ensure()
    const ts = this._now()
    db.prepare(`
      INSERT INTO identity (did, publicKeyB64, ciphertextB64, saltB64, ivB64, iters, didDocument, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(did) DO UPDATE SET
        publicKeyB64=excluded.publicKeyB64,
        ciphertextB64=excluded.ciphertextB64,
        saltB64=excluded.saltB64,
        ivB64=excluded.ivB64,
        iters=excluded.iters,
        didDocument=excluded.didDocument,
        updatedAt=excluded.updatedAt
    `).run(rec.did, rec.publicKeyB64, rec.ciphertextB64, rec.saltB64, rec.ivB64, rec.iters,
      JSON.stringify(rec.didDocument), rec.createdAt ?? ts, ts)
  }

  /** did 查找键（2026-10-08 设备面单形态定稿）：只精确匹配。
   *  原先的"双格式变体查找"（存量 legacy 行 canonical 串也能命中）服务于
   *  过渡期——清档后 identity 表全 canonical（register 从公钥派生 canonical），
   *  老客户端 legacy did 由 index.mjs 入口闸门直接 400，变体兜底已无存在意义。 */
  _lookupDids(did) {
    return [did]
  }

  _getRow(did) {
    const db = this._ensure()
    for (const key of this._lookupDids(did)) {
      const row = db.prepare('SELECT * FROM identity WHERE did=?').get(key)
      if (row) return row
    }
    return null
  }

  async getIdentity(did) {
    const row = this._getRow(did)
    if (!row) return null
    return { ...row, didDocument: JSON.parse(row.didDocument) }
  }

  async identityExists(did) {
    return !!this._getRow(did)
  }

  /** 多设备恢复：凭 did 取加密私钥密文（密文本身可公开，需用户密码才能解）。 */
  async getCiphertext(did) {
    const id = await this.getIdentity(did)
    if (!id) return null
    return { ciphertextB64: id.ciphertextB64, saltB64: id.saltB64, ivB64: id.ivB64, iters: id.iters }
  }

  async createChallenge(nonce, did, ttlMs) {
    const db = this._ensure()
    const expiresAt = this._now() + ttlMs
    db.prepare('INSERT INTO challenge (nonce, did, expiresAt, used) VALUES (?, ?, ?, 0)')
      .run(nonce, did, expiresAt)
    return { nonce, did, expiresAt }
  }

  /** 消费挑战：合法(did 匹配 + 未过期 + 未用)→ 标记已用并返回 true。 */
  async consumeChallenge(nonce, did) {
    const db = this._ensure()
    const row = db.prepare('SELECT * FROM challenge WHERE nonce=?').get(nonce)
    if (!row) return false
    if (row.used || row.did !== did || row.expiresAt < this._now()) return false
    db.prepare('UPDATE challenge SET used=1 WHERE nonce=?').run(nonce)
    return true
  }

  async createSession(token, did, ttlMs) {
    const db = this._ensure()
    const now = this._now()
    const expiresAt = now + ttlMs
    db.prepare('INSERT INTO session (token, did, createdAt, expiresAt) VALUES (?, ?, ?, ?)')
      .run(token, did, now, expiresAt)
    return { token, did, createdAt: now, expiresAt }
  }

  async getSession(token) {
    const db = this._ensure()
    const row = db.prepare('SELECT * FROM session WHERE token=?').get(token)
    if (!row || row.expiresAt < this._now()) return null
    return row
  }

  async revokeSession(token) {
    const db = this._ensure()
    db.prepare('DELETE FROM session WHERE token=?').run(token)
  }

  /** 清理过期挑战/会话（可选周期调用）。 */
  async prune() {
    const db = this._ensure()
    const now = this._now()
    db.prepare('DELETE FROM challenge WHERE expiresAt < ?').run(now)
    db.prepare('DELETE FROM session WHERE expiresAt < ?').run(now)
  }
}
