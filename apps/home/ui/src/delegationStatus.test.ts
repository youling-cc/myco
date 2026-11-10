import { describe, it, expect } from 'vitest'
import {
  delegationLevel, delegationRemainDays, delegationStatusText, delegationLevelColor,
  DELEGATION_WARN_DAYS,
} from './lib/delegationStatus'

/* 2026-10-11 委任状自动续约配套 UI 面：分身面板「授权剩余 X 天」提前预警。
 * 规格：>3 天绿色 / ≤3 天橙色 / 过期红色（文案=「设备授权已过期，请在主设备上重新授权」）。
 * dueRenew（剩 <20% TTL 或 <24h）时后台已自动投续约请求——文案加「正在自动续约」。 */

const D = 86_400_000

describe('分档 delegationLevel', () => {
  it('>3 天 → ok（绿）', () => {
    expect(delegationLevel({ remainingMs: 6 * D, expired: false })).toBe('ok')
    expect(delegationLevel({ remainingMs: 29 * D, expired: false })).toBe('ok')
  })
  it('恰好 3 天 / 更少 → warn（橙）——≤3 天口径含边界', () => {
    expect(delegationLevel({ remainingMs: 3 * D, expired: false })).toBe('warn')
    expect(delegationLevel({ remainingMs: 2 * D + 3600_000, expired: false })).toBe('warn')
    expect(delegationLevel({ remainingMs: 12 * 3600_000, expired: false })).toBe('warn')
  })
  it('已过期 → expired（红）；remainingMs≤0/NaN 一律兜底 expired', () => {
    expect(delegationLevel({ remainingMs: 0, expired: true })).toBe('expired')
    expect(delegationLevel({ remainingMs: 5 * D, expired: true })).toBe('expired', 'expired 标志优先')
    expect(delegationLevel({ remainingMs: 0, expired: false })).toBe('expired')
    expect(delegationLevel({ remainingMs: -1, expired: false })).toBe('expired')
    expect(delegationLevel({ remainingMs: Number.NaN, expired: false })).toBe('expired')
  })
})

describe('天数 delegationRemainDays（向上取整，宁多报不漏报）', () => {
  it('整 6 天 → 6；6.5 天 → 7', () => {
    expect(delegationRemainDays(6 * D)).toBe(6)
    expect(delegationRemainDays(6 * D + 1)).toBe(7)
  })
  it('剩 1ms → 1（不过早报 0 天）', () => {
    expect(delegationRemainDays(1)).toBe(1)
  })
})

describe('文案 delegationStatusText', () => {
  it('正常态：设备授权 剩余 X 天', () => {
    expect(delegationStatusText({ remainingMs: 6 * D, dueRenew: false, expired: false }))
      .toBe('设备授权 剩余 6 天')
    // 非整数天向上取整
    expect(delegationStatusText({ remainingMs: 6 * D + 3600_000, dueRenew: false, expired: false }))
      .toBe('设备授权 剩余 7 天')
  })
  it('进入续约窗口（dueRenew）→ 尾注「正在自动续约」', () => {
    expect(delegationStatusText({ remainingMs: 5 * D, dueRenew: true, expired: false }))
      .toBe('设备授权 剩余 5 天 · 正在自动续约')
  })
  it('≤3 天：即将过期（橙）', () => {
    expect(delegationStatusText({ remainingMs: 3 * D, dueRenew: true, expired: false }))
      .toBe('设备授权 即将过期（剩余 3 天） · 正在自动续约')
    expect(delegationStatusText({ remainingMs: 2 * D, dueRenew: false, expired: false }))
      .toBe('设备授权 即将过期（剩余 2 天）')
  })
  it('不足 1 天 → 「剩余不足 1 天」（不显示 0 天）', () => {
    expect(delegationStatusText({ remainingMs: 3600_000, dueRenew: true, expired: false }))
      .toBe('设备授权 即将过期（剩余不足 1 天） · 正在自动续约')
  })
  it('已过期 → 红字口径（与后端过期提醒同一文案）', () => {
    expect(delegationStatusText({ remainingMs: 0, dueRenew: true, expired: true }))
      .toBe('设备授权已过期，请在主设备上重新授权')
    expect(delegationStatusText({ remainingMs: -5, dueRenew: false, expired: false }))
      .toBe('设备授权已过期，请在主设备上重新授权')
  })
})

describe('颜色 delegationLevelColor（三档语义色）', () => {
  it('ok 绿 / warn 琥珀 / expired 红', () => {
    expect(delegationLevelColor('ok')).toBe('#15803d')
    expect(delegationLevelColor('warn')).toBe('#92400e')
    expect(delegationLevelColor('expired')).toBe('#dc2626')
  })
})

describe('规格钉', () => {
  it('预警阈值 = 3 天（任务口径）', () => {
    expect(DELEGATION_WARN_DAYS).toBe(3)
  })
})
