// access-log.mjs — 访问日志（SQLite 存储，零依赖）。
// 仿 feedback.mjs 的 FeedbackStore 模式：node:sqlite 的 DatabaseSync，同步 API。
// 每条记录一个 HTTP 请求：时间/IP/方法/路径/UA/认证 DID；提供聚合统计供后台展示。
import { DatabaseSync } from 'node:sqlite'

export class AccessLogStore {
  constructor({ path }) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        ip TEXT,
        method TEXT,
        path TEXT,
        ua TEXT,
        authedDid TEXT,
        status INTEGER
      )
    `)
    // 按时间查的常用场景加索引（幂等，已存在则跳过）
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_access_ts ON access_log(ts)`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_access_path ON access_log(path)`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_access_ip ON access_log(ip)`)
    // 2026-11-04: WAL 模式允许运维进程并发 prune（否则外部删除会 database is locked）
    try { this.db.exec('PRAGMA journal_mode=WAL') } catch {}
    try { this.db.exec('PRAGMA busy_timeout=5000') } catch {}
  }

  /** 插入一条访问记录。字段缺省兜底。 */
  add({ ip, method, path, ua, authedDid, status }) {
    this.db.prepare(`
      INSERT INTO access_log (ts, ip, method, path, ua, authedDid, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(Date.now(), ip || null, method || null, path || null,
      ua ? String(ua).slice(0, 300) : null, authedDid || null, status ?? null)
  }

  /** 原始记录分页（倒序）。 */
  list({ limit = 100, offset = 0 } = {}) {
    return this.db.prepare(
      'SELECT id, ts, ip, method, path, ua, authedDid, status FROM access_log ORDER BY id DESC LIMIT ? OFFSET ?'
    ).all(limit, offset)
  }

  /**
   * 聚合统计（供后台"访问监控"展示）。
   * @param {object} o
   * @param {number} o.since  只统计 ts >= since 的记录（毫秒）。不传则全量。
   * @returns {{ total, uniqueIp, byPath:[{path,count}], byIp:[{ip,count,firstSeen,lastSeen}], byHour:[{hour,count}], recent:[...] }}
   */
  stats({ since } = {}) {
    const where = since ? `WHERE ts >= ${Number(since)}` : ''
    const total = this.db.prepare(`SELECT COUNT(*) as n FROM access_log ${where}`).get().n
    const uniqueIp = this.db.prepare(
      `SELECT COUNT(DISTINCT ip) as n FROM access_log ${where}`
    ).get().n

    const byPath = this.db.prepare(
      `SELECT path, COUNT(*) as count FROM access_log ${where} GROUP BY path ORDER BY count DESC LIMIT 20`
    ).all()

    // 来源 IP Top：since 为空时不能用 "WHERE ... AND"，分支处理
    const byIp = this.db.prepare(
      since
        ? `SELECT ip, COUNT(*) as count, MIN(ts) as firstSeen, MAX(ts) as lastSeen FROM access_log WHERE ts >= ${Number(since)} AND ip IS NOT NULL GROUP BY ip ORDER BY count DESC LIMIT 20`
        : `SELECT ip, COUNT(*) as count, MIN(ts) as firstSeen, MAX(ts) as lastSeen FROM access_log WHERE ip IS NOT NULL GROUP BY ip ORDER BY count DESC LIMIT 20`
    ).all()

    // 按小时聚合（ts 毫秒 → 小时桶，用 SQLite 整除）。since 限定范围。
    const hourQuery = since
      ? `SELECT (ts / 3600000) * 3600000 as hour, COUNT(*) as count FROM access_log WHERE ts >= ${Number(since)} GROUP BY hour ORDER BY hour`
      : `SELECT (ts / 3600000) * 3600000 as hour, COUNT(*) as count FROM access_log GROUP BY hour ORDER BY hour DESC LIMIT 48`
    const byHour = this.db.prepare(hourQuery).all()

    const recent = this.db.prepare(
      `SELECT id, ts, ip, method, path, ua, authedDid, status FROM access_log ${where} ORDER BY id DESC LIMIT 50`
    ).all()

    return { total, uniqueIp, byPath, byIp, byHour, recent }
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) as n FROM access_log').get().n
  }
}
