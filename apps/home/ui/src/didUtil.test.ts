import { describe, it, expect } from 'vitest'
import { normalizeAccountDid, sameAccountDid, shortDidKeepPrefix } from './didUtil'

/* 2026-09-29 DID 前缀语义收敛：账号=did:youling:（平台/手机 canonical），
 * 设备=did:myco:；历史数据里账号 did 误存 did:myco: 形态，出示归一+比较不敏感。 */
describe('normalizeAccountDid（出示归一 did:myco:→did:youling:）', () => {
  it('did:myco: 账号串归一为 did:youling:（同一 tail）', () => {
    expect(normalizeAccountDid('did:myco:7S2YE7Q6g2vx9mqZ4PsXUhszXJhjqCbFKnutmHhQ4cgb'))
      .toBe('did:youling:7S2YE7Q6g2vx9mqZ4PsXUhszXJhjqCbFKnutmHhQ4cgb')
  })
  it('did:youling: 原样通过', () => {
    expect(normalizeAccountDid('did:youling:ABCDEFGH')).toBe('did:youling:ABCDEFGH')
  })
  it('异常串/空串原样（不制造脏数据）', () => {
    expect(normalizeAccountDid('')).toBe('')
    expect(normalizeAccountDid('not-a-did')).toBe('not-a-did')
  })
})

describe('sameAccountDid（前缀不敏感同判定）', () => {
  it('同串相等', () => {
    expect(sameAccountDid('did:youling:X', 'did:youling:X')).toBe(true)
  })
  it('did:myco:X ≡ did:youling:X（历史形态 vs 现行 canonical）', () => {
    expect(sameAccountDid('did:myco:7S2YE7Q6', 'did:youling:7S2YE7Q6')).toBe(true)
    expect(sameAccountDid('did:youling:7S2YE7Q6', 'did:myco:7S2YE7Q6')).toBe(true)
  })
  it('不同账号不相等', () => {
    expect(sameAccountDid('did:myco:AAAA', 'did:youling:BBBB')).toBe(false)
  })
  it('空值不炸', () => {
    expect(sameAccountDid(null, 'did:youling:X')).toBe(false)
    expect(sameAccountDid('did:youling:X', undefined)).toBe(false)
  })
})

describe('shortDidKeepPrefix（截断保留方法前缀）', () => {
  it('长 did 截断成 前缀+头4…尾4', () => {
    expect(shortDidKeepPrefix('did:youling:7S2YE7Q6g2vx9mqZ4PsXUhszXJhjqCbFKnutmHhQ4cgb'))
      .toBe('did:youling:7S2Y…4cgb')
  })
  it('短串原样', () => {
    expect(shortDidKeepPrefix('did:youling:ABCD')).toBe('did:youling:ABCD')
  })
})
