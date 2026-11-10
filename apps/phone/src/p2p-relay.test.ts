
// ── 2026-10-12 中继兜底钩子（直连优先、不通走中转）──────────────────────────
import { describe, it, expect, afterEach } from 'vitest'
import { p2pDeliver, setRelayDeliver } from './p2p'

describe('p2pDeliver 中继兜底（跨网直推全断时走云中继）', () => {
  afterEach(() => setRelayDeliver(null))

  it('直推全败 → 钩子送达 → true（并只调一次钩子）', async () => {
    // 直推必然全败：peerDevicesOf 返回空（无在线设备/无地址）
    let calls = 0
    setRelayDeliver(async () => { calls++; return true })
    const ok = await p2pDeliver('did:youling:PEER', { text: 'hi' })
    expect(ok).toBe(true)
    expect(calls).toBe(1)
  })

  it('钩子也失败 → false（消息照旧落 outbox 语义不破坏）', async () => {
    setRelayDeliver(async () => false)
    expect(await p2pDeliver('did:youling:PEER', { text: 'hi' })).toBe(false)
  })

  it('钩子抛异常 → 不放大，false 兜底', async () => {
    setRelayDeliver(async () => { throw new Error('relay unreachable') })
    expect(await p2pDeliver('did:youling:PEER', { text: 'hi' })).toBe(false)
  })

  it('未注入钩子（老装配）→ 行为不变：直推败=false，无兜底调用', async () => {
    expect(await p2pDeliver('did:youling:PEER', { text: 'hi' })).toBe(false)
  })
})
