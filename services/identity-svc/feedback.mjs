// feedback.mjs — 用户反馈收集（SQLite 存储，零依赖）
import { DatabaseSync } from 'node:sqlite'

export class FeedbackStore {
  constructor({ path }) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        accountDid TEXT,
        deviceDid TEXT,
        accountName TEXT,
        type TEXT,
        text TEXT,
        mycoVersion TEXT,
        ipv6 TEXT,
        userAgent TEXT,
        logs TEXT,
        createdAt TEXT DEFAULT (datetime('now')),
        status TEXT DEFAULT 'open'
      )
    `)
  }

  add({ accountDid, deviceDid, accountName, type, text, mycoVersion, ipv6, userAgent, logs }) {
    this.db.prepare(`
      INSERT INTO feedback (accountDid, deviceDid, accountName, type, text, mycoVersion, ipv6, userAgent, logs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(accountDid || null, deviceDid || null, accountName || null, type || 'feedback', text || '',
      mycoVersion || null, ipv6 || null, userAgent || null, logs || null)
  }

  list({ status, limit = 50, offset = 0 } = {}) {
    if (status) {
      return this.db.prepare(
        'SELECT * FROM feedback WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?'
      ).all(status, limit, offset)
    }
    return this.db.prepare(
      'SELECT * FROM feedback ORDER BY id DESC LIMIT ? OFFSET ?'
    ).all(limit, offset)
  }

  count({ status } = {}) {
    if (status) {
      return this.db.prepare('SELECT COUNT(*) as n FROM feedback WHERE status = ?').get(status).n
    }
    return this.db.prepare('SELECT COUNT(*) as n FROM feedback').get().n
  }

  updateStatus(id, status) {
    this.db.prepare('UPDATE feedback SET status = ? WHERE id = ?').run(status, id)
  }

  get(id) {
    return this.db.prepare('SELECT * FROM feedback WHERE id = ?').get(id)
  }
}
