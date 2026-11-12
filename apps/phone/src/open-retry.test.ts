/**
 * open-retry.test.ts — `waitUntil` 的行为锁。
 *
 * 2026-11-12：取票重试策略/自愈/收摊文案（retryTransient、pickHealTargets、
 * finalOpenNote 等）随手机端取票链整链删除，对应用例一并作废；只剩仍在用的
 * `waitUntil`（waitForIdentityReady 的底层）三条用例。
 */
import { describe, it, expect } from 'vitest'
import { waitUntil } from './open-retry'

describe('等就绪（身份/隧道；2026-10-16 冷启动真案）', () => {
  it('已经就绪 → 零等待、不 sleep', async () => {
    let slept = 0
    const r = await waitUntil(() => true, { timeoutMs: 1000, sleep: async () => { slept++ } })
    expect(r).toBe(0)
    expect(slept).toBe(0)
  })

  it('等一会儿才就绪 → 返回等了多久', async () => {
    let ready = false
    let n = 0
    const r = await waitUntil(() => ready, {
      timeoutMs: 1000,
      pollMs: 100,
      now: () => n * 100,
      sleep: async () => { n++; if (n >= 3) ready = true },
    })
    expect(r).toBe(300)
  })

  it('一直不就绪 → null（调用方据此说人话，不无限等）', async () => {
    let n = 0
    const r = await waitUntil(() => false, {
      timeoutMs: 300,
      pollMs: 100,
      now: () => n * 100,
      sleep: async () => { n++ },
    })
    expect(r).toBeNull()
  })
})
