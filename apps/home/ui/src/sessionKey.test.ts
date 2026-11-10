import { describe, it, expect } from 'vitest'
import { formatSessionRemaining, sessionKeyText, sessionKeyExpired } from './lib/sessionKey'

/* 2026-10-10 任务2（方案 A：不发系统通知，只在 myco 界面显示授权剩余）。
 * 设计稿：refactor docs/todo/2026-10-10-会话委任状过期前续期设计.md
 * 用户原话「总之不想打扰用户」→ 登录器界面一行小字「网页提交授权 剩余 11 小时 32 分」，
 * dueWarn（剩 <30min 或已过期）时加"即将过期/已过期"提示。 */

const H = 3600_000
const M = 60_000

describe('会话委任状剩余时间文案（formatSessionRemaining）', () => {
  it('小时+分 / 整小时 / 纯分钟 / 不足一分钟', () => {
    expect(formatSessionRemaining(11 * H + 32 * M)).toBe('11 小时 32 分')
    expect(formatSessionRemaining(2 * H)).toBe('2 小时')
    expect(formatSessionRemaining(45 * M)).toBe('45 分')
    expect(formatSessionRemaining(30_000)).toBe('不到 1 分钟')
  })

  it('已过期/0/负数/非法值 → 已过期（Rust 侧已饱和为 0，UI 也不得显示负数）', () => {
    expect(formatSessionRemaining(0)).toBe('已过期')
    expect(formatSessionRemaining(-1)).toBe('已过期')
    expect(formatSessionRemaining(Number.NaN)).toBe('已过期')
  })
})

describe('账号区那一行（sessionKeyText）', () => {
  it('正常态：网页提交授权 剩余 X', () => {
    expect(sessionKeyText({ remainingMs: 11 * H + 32 * M, dueWarn: false }))
      .toBe('网页提交授权 剩余 11 小时 32 分')
  })

  it('dueWarn 且未过期：提示"即将过期"（琥珀色由 UI 负责）', () => {
    expect(sessionKeyText({ remainingMs: 12 * M, dueWarn: true }))
      .toBe('网页提交授权 即将过期（剩余 12 分）')
    // 剩 29min 进窗口、剩 31min 不进（与 Rust session_key_due_warn 边界同口径）
    expect(sessionKeyText({ remainingMs: 29 * M, dueWarn: true })).toContain('即将过期')
    expect(sessionKeyText({ remainingMs: 31 * M, dueWarn: false })).toContain('剩余 31 分')
  })

  it('已过期（remainingMs=0）：引导重新授权', () => {
    expect(sessionKeyText({ remainingMs: 0, dueWarn: true }))
      .toBe('网页提交授权 已过期，请重新授权')
  })
})

/* C-4（2026-10-22 设计定稿「小改进」）：已过期那一行可点清除陈旧记录。
 * 判定与 sessionKeyText 的「已过期」同口径；UI 据此渲染可点按钮。 */
describe('C-4 过期判定（sessionKeyExpired，可点清除的渲染依据）', () => {
  it('ACC-C4-001 正常/将过期 → 不可点（false）', () => {
    expect(sessionKeyExpired({ remainingMs: 11 * H })).toBe(false)
    expect(sessionKeyExpired({ remainingMs: 12 * M })).toBe(false)
    expect(sessionKeyExpired({ remainingMs: 1 })).toBe(false)
  })

  it('ACC-C4-002 过期/0/负数/非法 → 可点（true）', () => {
    expect(sessionKeyExpired({ remainingMs: 0 })).toBe(true)
    expect(sessionKeyExpired({ remainingMs: -1 })).toBe(true)
    expect(sessionKeyExpired({ remainingMs: Number.NaN })).toBe(true)
  })
})
