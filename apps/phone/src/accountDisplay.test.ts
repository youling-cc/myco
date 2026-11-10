import { describe, it, expect } from 'vitest'
import { accountTail, credText } from '@myco/accountDisplay'
import { accountTail as accountTailViaIdentity, credText as credTextViaIdentity } from './identity'

/* 2026-10-01 账号重排：accountTail（尾号唯一格式 …尾4）/ credText（本机凭据状态文案）
 * 实现单一源=packages/ui-kit/src/accountDisplay.ts——phone 经 @myco 直引、
 * identity.ts re-export（Pairing 从 '../identity' 消费）。两通道必须同一实现。 */

describe('accountTail（全页尾号唯一格式 …尾4）', () => {
  it('标准形态：…尾4，无空格/横线', () => {
    expect(accountTail('did:youling:7S2YE7Q6g2vx9mqZ4PsXUhszXJhjqCbFKnutmHhQ4cgb')).toBe('…4cgb')
  })
  it('空值 → 空串', () => {
    expect(accountTail('')).toBe('')
    expect(accountTail(null)).toBe('')
    expect(accountTail(undefined)).toBe('')
  })
})

describe('credText（本机凭据状态文案，用户 2026-10-01 定稿）', () => {
  it('三态文案', () => {
    expect(credText('embodiment')).toBe('本机持有账号钥匙')
    expect(credText('agent')).toBe('受委任的成员')
    expect(credText('lost')).toBe('凭据已失')
  })
})

describe('identity.ts re-export 与 ui-kit 单一实现一致', () => {
  it('accountTail/credText 同一函数（改动一处三端生效的铁证）', () => {
    expect(accountTailViaIdentity).toBe(accountTail)
    expect(credTextViaIdentity).toBe(credText)
  })
})
