/**
 * share-admin.test.ts — 手机权限管理（share-admin-request）的**有界性**锁（task-42）。
 *
 * 真机 RED（task-41，2026-10-27 21:25）：手机打开「权限设置」后只有 send 没有 resp、
 * PC audit 0 事件、UI 永久「正在从主设备读取权限…」。
 *
 * 根因层：`p2pDeliverWithReply` 的第一步 presence 查询可能永久挂起（identity fetch 无
 * 超时）→ share-admin 的 Promise 永不 settle。
 * 本测试从**上层契约**锁死：无论底层怎么挂，share-admin 必须在 8-12s 内 reject 人话错误，
 * 不允许永久 pending（Red：无超时实现时本测试会挂到 vitest timeout）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('./p2p', () => ({ p2pDeliverWithReply: vi.fn() }))
vi.mock('./share-entry', () => ({
  entryControlEnvelope: vi.fn(() => ({})),
  newControlMsgId: vi.fn(() => 'm-1'),
}))
vi.mock('./identity', () => ({
  currentIdentity: vi.fn(() => ({ did: 'did:myco:zPhoneDev' })),
  getRootIdentity: vi.fn(() => 'did:youling:zOwnerAcc'),
  getAttestation: vi.fn(() => null),
  currentYoulingName: vi.fn(() => '手机'),
}))

import { shareAdminGet, shareAdminRequest } from './share-admin'
import { p2pDeliverWithReply } from './p2p'

const CARD = { shareId: 'sh-x', sourceDevice: 'did:myco:zPcDev', sourceAccount: 'did:youling:zOwnerAcc' }

function hung(): Promise<never> {
  return new Promise<never>(() => { /* 永不 settle：模拟真机 presence/relay 挂起 */ })
}

describe('share-admin 控制面必须有界（task-42 RED→GREEN）', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('p2p 永久无回包 → 8-12s 内有界 reject 人话超时（绝不允许永久 loading）', { timeout: 6000 }, async () => {
    vi.useFakeTimers()
    vi.mocked(p2pDeliverWithReply).mockReturnValue(hung() as never)
    const settled = shareAdminGet(CARD).then(
      () => ({ ok: true as const }),
      (e: Error) => ({ ok: false as const, message: String(e?.message ?? e) }),
    )
    // 推进到 >12s：实现必须在此前 reject；无超时实现时这里不会 settle（vitest timeout 红）
    await vi.advanceTimersByTimeAsync(12_100)
    const r = await settled
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/超时|没回包/)
  })

  it('写操作超时 → 等过 p2p 总超时且文案必须说结果未确认（防重复写）', { timeout: 8000 }, async () => {
    vi.useFakeTimers()
    vi.mocked(p2pDeliverWithReply).mockReturnValue(hung() as never)
    const settled = shareAdminRequest(CARD, 'caps', { capsO: [], capsA: [] }).then(
      () => ({ ok: true as const }),
      (e: Error) => ({ ok: false as const, message: String(e?.message ?? e) }),
    )
    // 15.5s 仍不判超时（底层 p2p 总界是 15s）；16.1s 必须失败且提示结果未确认。
    await vi.advanceTimersByTimeAsync(15_500)
    let r = await Promise.race([settled, Promise.resolve({ ok: true as const, pending: true })])
    expect(r).toEqual({ ok: true, pending: true })
    await vi.advanceTimersByTimeAsync(700)
    r = await settled
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toMatch(/16 秒/)
      expect(r.message).toMatch(/结果未确认/)
      expect(r.message).toMatch(/不要连续重复保存/)
    }
  })

  it('主设备回包 ok=true → 返回 data（正常路径不被超时误伤）', async () => {
    vi.mocked(p2pDeliverWithReply).mockResolvedValue({ ok: true, reply: { ok: true, data: { collaborators: [], total: 1 } } } as never)
    const d = await shareAdminGet(CARD)
    expect(d.total).toBe(1)
  })

  it('主设备回包 ok=false → 人话错误原样透出（拒绝不静默、不假成功）', async () => {
    vi.mocked(p2pDeliverWithReply).mockResolvedValue({
      ok: true,
      reply: { ok: false, error: '这个分享的权限由源设备（创建分享的那台 PC）管理' },
    } as never)
    await expect(shareAdminGet(CARD)).rejects.toThrow(/由源设备/)
  })
})
