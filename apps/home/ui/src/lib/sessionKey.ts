/**
 * sessionKey.ts — 网页提交授权（会话委任状）剩余时间的**界面显示**文案单一源。
 *
 * 背景（2026-10-10 设计定稿，设计稿 refactor docs/todo/2026-10-10-会话委任状过期前续期设计.md）：
 * 会话委任状 = 账号钥授权浏览器临时钥提交答案，12h；到期后工人做完题提交会 40109 且
 * 界面无入口。原 C-3 方案是**发 Windows 系统通知**，用户明确否掉：「总之不想打扰用户」→
 * **方案 A：不发系统通知**，只在 myco 登录器界面显示授权剩余。
 *
 * 数据来自 Rust 侧 `session_key_status()` 命令（或 `session-key-due` 事件广播）：
 * `{exp, issuedAt, remainingMs, dueWarn}`，**零私钥**；无记录时命令返回 null，界面整行不渲染
 * （不给用户噪音）。
 */

/** `session_key_status()` 命令 / `session-key-due` 事件的载荷契约（camelCase）。 */
export interface SessionKeyStatus {
  /** 委任状到期时刻（ms epoch）。 */
  exp: number
  /** 签发时刻（ms epoch）。 */
  issuedAt: number
  /** 距到期剩余 ms（Rust 侧已饱和：已过期 = 0，不会为负）。 */
  remainingMs: number
  /** 是否进入提醒窗口（剩 <30min 或已过期）——true 时界面用琥珀色 + "即将过期"。 */
  dueWarn: boolean
}

/** 剩余时长 → 人读文案（分钟粒度）。已过期/非正数 → '已过期'。 */
export function formatSessionRemaining(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '已过期'
  const totalMin = Math.floor(remainingMs / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0) return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`
  if (totalMin > 0) return `${totalMin} 分`
  return '不到 1 分钟'
}

/**
 * 界面那一行的文案（IdentityPanel 账号区小字）：
 *   正常   → 「网页提交授权 剩余 11 小时 32 分」
 *   将过期 → 「网页提交授权 即将过期（剩余 12 分）」
 *   已过期 → 「网页提交授权 已过期，请重新授权」
 */
export function sessionKeyText(s: Pick<SessionKeyStatus, 'remainingMs' | 'dueWarn'>): string {
  const left = s.remainingMs
  if (!Number.isFinite(left) || left <= 0) return '网页提交授权 已过期，请重新授权'
  if (s.dueWarn) return `网页提交授权 即将过期（剩余 ${formatSessionRemaining(left)}）`
  return `网页提交授权 剩余 ${formatSessionRemaining(left)}`
}

/**
 * C-4（2026-10-22 设计定稿「小改进」）：是否已过期（UI 据此把那一行做成**可点**：
 * 点击清掉本机陈旧记录；清除只动本地跟踪文件，下次网页答题时走正常重新授权）。
 * 与 `sessionKeyText` 的「已过期」判定同口径（非有限数/≤0 均视为过期）。
 */
export function sessionKeyExpired(s: Pick<SessionKeyStatus, 'remainingMs'>): boolean {
  return !Number.isFinite(s.remainingMs) || s.remainingMs <= 0
}
