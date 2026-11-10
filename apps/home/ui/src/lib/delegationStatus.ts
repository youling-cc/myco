/**
 * delegationStatus.ts — 分身设备授权（委任状）剩余时间的**界面显示**文案单一源。
 *
 * 背景（2026-10-11 委任状自动续约缺口修复）：分身侧委任状静默过期一个月无人管，
 * 用户登录 www.youling.cc 才发现。修法=PC home 接上 identity-svc 既有续约协议
 * （delegation_renewal.rs：本体巡签+分身续约请求）+ 本文件的用户可见提前预警：
 * 分身面板显示「授权剩余 X 天」——>3 天绿色 / ≤3 天橙色 / 过期红色。
 *
 * 数据来自 Rust 侧 `delegation_status` 命令（零私钥；无委任状/未登录 → null，
 * 界面整行不渲染——不给主设备/未收编用户噪音）。
 */

/** 一天的毫秒数（文案/阈值单一源）。 */
export const DELEGATION_DAY_MS = 86_400_000

/** 橙色预警阈值：剩余 ≤3 天（任务规格口径）。 */
export const DELEGATION_WARN_DAYS = 3

/** `delegation_status` 命令的载荷契约（camelCase）。 */
export interface DelegationStatus {
  /** 委任状到期时刻（ms epoch）。 */
  exp: number
  /** 签发时刻（ms epoch）。 */
  issuedAt: number
  /** 距到期剩余 ms（Rust 侧已饱和：已过期 = 0，不会为负）。 */
  remainingMs: number
  /** 是否进入续约窗口（is_due_renew：剩 <20% TTL 或 <24h）。
   * true 时后台已自动投续约请求——文案如实提示「正在自动续约」。 */
  dueRenew: boolean
  /** 是否已过期（宽限重签窗口内仍可救）。 */
  expired: boolean
}

/** 显示分档：正常（绿）/ 即将过期（橙）/ 已过期（红）。 */
export type DelegationLevel = 'ok' | 'warn' | 'expired'

/**
 * 分档判定（纯函数）：已过期 → expired；剩余 ≤3 天 → warn；否则 ok。
 * remainingMs ≤0 一律按 expired 兜底（Rust 已饱和，这里防手搓值）。
 */
export function delegationLevel(s: Pick<DelegationStatus, 'remainingMs' | 'expired'>): DelegationLevel {
  if (s.expired || !Number.isFinite(s.remainingMs) || s.remainingMs <= 0) return 'expired'
  return s.remainingMs <= DELEGATION_WARN_DAYS * DELEGATION_DAY_MS ? 'warn' : 'ok'
}

/** 剩余 → 天数（向上取整：剩 1ms 也算「1 天」——宁多报不漏报）。 */
export function delegationRemainDays(remainingMs: number): number {
  return Math.ceil(remainingMs / DELEGATION_DAY_MS)
}

/**
 * 界面那一行的文案（IdentityPanel 成员卡小字）：
 *   正常     → 「设备授权 剩余 6 天」（dueRenew 时加「· 正在自动续约」）
 *   ≤3 天    → 「设备授权 即将过期（剩余 2 天）」
 *   已过期   → 「设备授权已过期，请在主设备上重新授权」
 *   <1 天    → 「…（剩余不足 1 天）」 */
export function delegationStatusText(s: Pick<DelegationStatus, 'remainingMs' | 'dueRenew' | 'expired'>): string {
  const left = s.remainingMs
  if (s.expired || !Number.isFinite(left) || left <= 0) {
    return '设备授权已过期，请在主设备上重新授权'
  }
  const days = delegationRemainDays(left)
  // 剩不足一天显示「剩余不足 1 天」（ceil 会把 1h 也算「1 天」，掩盖紧迫性）
  const remainText = left < DELEGATION_DAY_MS ? '剩余不足 1 天' : `剩余 ${days} 天`
  const renewing = s.dueRenew ? ' · 正在自动续约' : ''
  if (delegationLevel(s) === 'warn') {
    return `设备授权 即将过期（${remainText}）${renewing}`
  }
  return `设备授权 ${remainText}${renewing}`
}

/** 分档 → 颜色（与面板既有语义色一致：绿 #15803d / 琥珀 #92400e / 红 #dc2626）。 */
export function delegationLevelColor(level: DelegationLevel): string {
  if (level === 'expired') return '#dc2626'
  if (level === 'warn') return '#92400e'
  return '#15803d'
}

/** 分档 → 徽标底色（浅底 + delegationLevelColor 文字色，成对使用）。 */
export function delegationLevelBg(level: DelegationLevel): string {
  if (level === 'expired') return '#fee2e2'
  if (level === 'warn') return '#fef3c7'
  return '#dcfce7'
}

/**
 * 设备行上的**紧凑徽标**文案（智能体 Tab 每台设备 / MycoDevices 同口径）：
 *   正常     → 「授权剩余 27 天」
 *   ≤3 天    → 「授权剩余 2 天」（橙）
 *   <1 天    → 「授权剩余不足 1 天」
 *   已过期   → 「授权已过期 · 请重新授权」（红）
 * 与 delegationStatusText 的区别：不带「设备授权」前缀、不显示续约态——一行窄徽标用。
 */
export function delegationBadgeText(s: Pick<DelegationStatus, 'remainingMs' | 'expired'>): string {
  const left = s.remainingMs
  if (s.expired || !Number.isFinite(left) || left <= 0) return '授权已过期 · 请重新授权'
  if (left < DELEGATION_DAY_MS) return '授权剩余不足 1 天'
  return `授权剩余 ${delegationRemainDays(left)} 天`
}
