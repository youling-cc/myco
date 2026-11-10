import { describe, expect, it } from 'vitest'
import {
  presenceDotClass, presenceDotTitle, makeThrottle, firstTypingMember,
  type FriendPresence,
} from './presence'

/* 2026-09-29 灯恢复（用户报"打字呼吸灯/锁屏橘黄灯 UI 上看不到"）：
 * 状态→灯样式三态映射、typing 3s 节流、超时回退的锚点测试。
 * 与 apps/phone/src/presence.test.ts 同构（两端一致惯例）。 */

const P = (online: boolean, state: string): FriendPresence => ({ online, state, deviceName: '', devices: 1 })

describe('presenceDotClass 状态→灯样式三态映射', () => {
  it('离线/无数据 → 灰 off', () => {
    expect(presenceDotClass(undefined)).toBe('off')
    expect(presenceDotClass(P(false, 'active'))).toBe('off')
  })
  it('active → 绿常亮', () => {
    expect(presenceDotClass(P(true, 'active'))).toBe('active')
  })
  it('typing → 绿呼吸', () => {
    expect(presenceDotClass(P(true, 'typing'))).toBe('typing')
  })
  it('idle/locked → 烛光橘', () => {
    expect(presenceDotClass(P(true, 'idle'))).toBe('idle')
    expect(presenceDotClass(P(true, 'locked'))).toBe('locked')
  })
  it('老版本无 state（在线但 state 空）→ 回退绿灯', () => {
    expect(presenceDotClass(P(true, ''))).toBe('active')
  })
})

describe('presenceDotTitle 灯文案', () => {
  it('三态文案', () => {
    expect(presenceDotTitle(P(true, 'typing'))).toBe('正在输入…')
    expect(presenceDotTitle(P(true, 'active'))).toBe('在线')
    expect(presenceDotTitle(P(true, 'locked'))).toContain('锁屏')
    expect(presenceDotTitle(undefined)).toBe('离线')
  })
})

describe('makeThrottle typing 上报节流', () => {
  it('3s 内多次输入只放行一次', () => {
    const t = makeThrottle(3000)
    expect(t(10_000)).toBe(true)  // 首击放行
    expect(t(10_500)).toBe(false) // +0.5s 吞掉
    expect(t(12_999)).toBe(false) // +2.999s 仍吞
    expect(t(13_000)).toBe(true)  // +3s 整放行
  })
})

describe('firstTypingMember 群内任一 typing', () => {
  const ME = 'did:youling:ME'
  const A = 'did:youling:AAAA'
  const B = 'did:youling:BBBB'
  it('任一成员 typing → 返回其 did', () => {
    const presence = { [A]: P(true, 'active'), [B]: P(true, 'typing') }
    expect(firstTypingMember([ME, A, B], presence, ME)).toBe(B)
  })
  it('排除自己（自己 typing 不算）', () => {
    const presence = { [ME]: P(true, 'typing') }
    expect(firstTypingMember([ME, A], presence, ME)).toBeNull()
  })
  it('离线成员的 typing 残留不算', () => {
    const presence = { [A]: P(false, 'typing') }
    expect(firstTypingMember([ME, A], presence, ME)).toBeNull()
  })
})
