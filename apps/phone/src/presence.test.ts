import { describe, expect, it } from 'vitest'
import bs58 from 'bs58'
import {
  presenceDotClass, presenceDotTitle, makeThrottle, firstTypingMember, presenceOf,
  computePhoneState, IDLE_THRESHOLD_MS, type FriendPresence,
} from './presence'
import { accountDidCanonical, didFromPubkey, didSafeId } from './didUtil'

/* 2026-09-29 灯恢复（用户报"打字呼吸灯/锁屏橘黄灯 UI 上看不到"）：
 * 状态→灯样式三态映射、typing 3s 节流、超时回退的锚点测试。
 * 与 apps/home/ui/src/presence.test.ts 同构（两端一致惯例）。 */

const P = (online: boolean, state: string): FriendPresence => ({ online, state, deviceName: '' })

describe('presenceDotClass 状态→灯样式三态映射', () => {
  it('离线/无数据 → 灰 off', () => {
    expect(presenceDotClass(undefined)).toBe('off')
    expect(presenceDotClass(P(false, 'active'))).toBe('off')
  })
  it('active → 绿常亮 / typing → 绿呼吸 / idle·locked → 烛光橘', () => {
    expect(presenceDotClass(P(true, 'active'))).toBe('active')
    expect(presenceDotClass(P(true, 'typing'))).toBe('typing')
    expect(presenceDotClass(P(true, 'idle'))).toBe('idle')
    expect(presenceDotClass(P(true, 'locked'))).toBe('locked')
  })
  it('老版本无 state → 回退绿灯', () => {
    expect(presenceDotClass(P(true, ''))).toBe('active')
  })
})

describe('presenceDotTitle 灯文案', () => {
  it('typing=正在输入… / locked=锁屏 / 无数据=离线', () => {
    expect(presenceDotTitle(P(true, 'typing'))).toBe('正在输入…')
    expect(presenceDotTitle(P(true, 'locked'))).toContain('锁屏')
    expect(presenceDotTitle(undefined)).toBe('离线')
  })
})

describe('makeThrottle typing 上报节流', () => {
  it('3s 内多次输入只放行一次', () => {
    const t = makeThrottle(3000)
    expect(t(10_000)).toBe(true)
    expect(t(10_500)).toBe(false)
    expect(t(12_999)).toBe(false)
    expect(t(13_000)).toBe(true)
  })
})

describe('computePhoneState 本机状态决策（presence 上报 state 字段）', () => {
  const base = { now: 1_000_000, typingUntil: 0, visible: true, lastInteractionAt: 1_000_000 }
  it('typing TTL 内 → typing', () => {
    expect(computePhoneState({ ...base, typingUntil: base.now + 4000 })).toBe('typing')
  })
  it('超时回退：TTL 过期 → active（"3 秒无输入回退"）', () => {
    expect(computePhoneState({ ...base, typingUntil: base.now - 1 })).toBe('active')
    expect(computePhoneState({ ...base, typingUntil: base.now })).toBe('active') // 到期瞬间
  })
  it('切后台（不可见）→ idle（手机锁屏/息屏的近似）', () => {
    expect(computePhoneState({ ...base, visible: false })).toBe('idle')
  })
  it('5min 无交互 → idle；恰好 5min 还不算', () => {
    expect(computePhoneState({ ...base, lastInteractionAt: base.now - IDLE_THRESHOLD_MS - 1 })).toBe('idle')
    expect(computePhoneState({ ...base, lastInteractionAt: base.now - IDLE_THRESHOLD_MS })).toBe('active')
  })
  it('typing 优先于 idle（打字中切后台前的最后一报仍是 typing）', () => {
    expect(computePhoneState({ ...base, typingUntil: base.now + 1, visible: false })).toBe('typing')
  })
})

describe('firstTypingMember 群内任一 typing', () => {
  const ME = 'did:youling:ME'
  const A = 'did:youling:AAAA'
  const B = 'did:youling:BBBB'
  it('任一成员 typing → 返回其 did；排除自己', () => {
    const presence = { [A]: P(true, 'active'), [B]: P(true, 'typing') }
    expect(firstTypingMember([ME, A, B], presence, ME)).toBe(B)
    expect(firstTypingMember([ME, A], { [ME]: P(true, 'typing') }, ME)).toBeNull()
  })

  // 2026-10-07：presence 表键 = 服务器上报形态，查询键 = 名册/会话形态，
  // 同一把钥匙的不同历史形态此前查不到 → 灯/typing 恒灭（公钥级查找修）。
  // 2026-10-10 canonical-only：参与归一的只剩双前缀 canonical；legacy 已废止（不再解码）。
  it('presence 表键与查询 did 形态不同（同一把钥匙双 canonical 前缀）仍命中', () => {
    const key = new Uint8Array(32).fill(0x51)
    const canon = didFromPubkey(key, 'youling')
    const mycoCanon = didFromPubkey(key, 'myco')
    const legacy = `did:myco:${bs58.encode(key)}` // 已废止形态：仅作反例
    const presence = { [canon]: P(true, 'typing') }
    expect(presenceOf(presence, mycoCanon)?.state).toBe('typing')
    expect(presenceOf(presence, canon)?.state).toBe('typing')
    expect(presenceOf(presence, didSafeId(mycoCanon))?.state).toBe('typing')
    // legacy 已废止：解不出公钥 → 不参与归一（查不到，灯保持灰）
    expect(presenceOf(presence, legacy)).toBeUndefined()
    expect(accountDidCanonical(legacy)).toBe(legacy) // 不再归一（原样）
    expect(presenceOf(presence, 'did:youling:ZZZZ')).toBeUndefined()
    expect(firstTypingMember([mycoCanon], presence, 'did:youling:ME')).toBe(mycoCanon)
  })
})
