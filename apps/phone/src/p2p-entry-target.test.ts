/**
 * p2p-entry-target.test.ts — `p2pDeliverWithReply` 的**源设备定向**（2026-10-11
 * 真机"点打开白屏/误报任务不在了"根修）。
 *
 * 事故链（真机复现）：share-entry-request 广播给账号下全部在线 PC、谁先应答听谁
 * ——同账号挂着 laptop（没有这张分享）+ DESKTOP（票在这）时，laptop 抢答 deny
 * 「这个任务在那台设备上已经不在了」，源设备的 grant 到不了 → 手机点卡永远打不开。
 * 定向语义：`preferDevice` 给了就**只问它**；它不在场直接 null（交给 provider B/C
 * 隧道兜底），绝不吃别台设备的错误答案。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// identity 打桩：p2p.ts 只用这四个名字；签名必须可用（真实现无身份会抛 → null）。
vi.mock('./identity', () => ({
  signAuthHeader: vi.fn(() => 'did:myco:me.123.sig'),
  listPresence: vi.fn(),
  currentIdentity: vi.fn(() => ({ did: 'did:myco:me' })),
  currentYoulingName: vi.fn(() => '测试'),
}))

import { p2pDeliverWithReply, setRelayDeliverReply, _setP2pReplyTimeoutForTest } from './p2p'
import { listPresence } from './identity'

const ACC = 'did:youling:zAcc'
const SRC = 'did:myco:z6MkuyFrKzJAzUQSi4D8nfDr9EkkibvY3NdHL2oqyCJBx7oj'
const OTHER = 'did:myco:z6MkpYTe3QL6GHkm1hf8DdNfT7G1Hffn2KBS1Ggx1TbM6Cqf'

/** presence 行（kind=pc、带 ipv6List——peerDevicesOf 才会收）。 */
function pcRow(did: string, ipv6: string) {
  return {
    did, nodeId: '', name: `pc-${did.slice(-4)}`, lastSeen: 0, self: false,
    rootDid: ACC, role: null, kind: 'pc', webrtc: null,
    addrs: { ipv6List: [ipv6], ipv6, port: 9100 },
  }
}

/** fetch 打桩：按 host 前缀路由（[2001:db8::a]=SRC、[2001:db8::b]=OTHER）。 */
function stubFetch(byDev: Record<string, { status: number; body: unknown } | 'unreachable'>): string[] {
  const hits: string[] = []
  ;(globalThis as Record<string, unknown>).fetch = vi.fn(async (url: string) => {
    hits.push(url)
    const who = url.includes('2001:db8::a') ? SRC : url.includes('2001:db8::b') ? OTHER : '?'
    const cfg = byDev[who]
    if (!cfg || cfg === 'unreachable') throw new Error('network unreachable')
    return {
      ok: cfg.status >= 200 && cfg.status < 300,
      status: cfg.status,
      json: async () => (cfg as { body: unknown }).body,
    } as Response
  })
  return hits
}

const GRANT = { ok: true, kept: true, reply: { shareId: 'sh-x', requestId: 'ser-1', ok: true, mt: 'mt-tickets' } }
const DENY_NOT_HERE = { ok: true, kept: true, reply: { shareId: 'sh-x', requestId: 'ser-1', ok: false, error: '这个任务在那台设备上已经不在了（可能已停止分享）' } }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('源设备定向（preferDevice）', () => {
  it('只问源设备：别台在线也不广播——deny 抢答被根除', async () => {
    vi.mocked(listPresence).mockResolvedValue([pcRow(SRC, '2001:db8::a'), pcRow(OTHER, '2001:db8::b')] as never)
    const hits = stubFetch({ [SRC]: { status: 200, body: GRANT } })
    const r = await p2pDeliverWithReply(ACC, { msgId: 'm1' }, SRC)
    expect(r).toEqual(GRANT)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain('2001:db8::a')
  })

  it('源设备不可达 → null（不吃别台的 deny，交给 provider B/C 隧道兜底）', async () => {
    vi.mocked(listPresence).mockResolvedValue([pcRow(SRC, '2001:db8::a'), pcRow(OTHER, '2001:db8::b')] as never)
    const hits = stubFetch({ [SRC]: 'unreachable', [OTHER]: { status: 200, body: DENY_NOT_HERE } })
    const r = await p2pDeliverWithReply(ACC, { msgId: 'm1' }, SRC)
    expect(r).toBeNull()
    // 只打过源设备的地址；laptop 一个字节都没发（更没机会抢答）
    expect(hits.every((u) => u.includes('2001:db8::a'))).toBe(true)
  })

  it('源设备不在线（presence 无此行）→ 直接 null、零网络', async () => {
    vi.mocked(listPresence).mockResolvedValue([pcRow(OTHER, '2001:db8::b')] as never)
    const hits = stubFetch({})
    const r = await p2pDeliverWithReply(ACC, { msgId: 'm1' }, SRC)
    expect(r).toBeNull()
    expect(hits).toHaveLength(0)
  })

  it('did 形态不同也能命中（canonical 公钥级判等：did:youling 前缀 vs did:myco）', async () => {
    // presence 里源设备挂的是 legacy 前缀形态——同一把钥匙，定向仍须命中
    vi.mocked(listPresence).mockResolvedValue([pcRow(SRC.replace('did:myco:', 'did:youling:'), '2001:db8::a')] as never)
    const hits = stubFetch({ [SRC]: { status: 200, body: GRANT } })
    const r = await p2pDeliverWithReply(ACC, { msgId: 'm1' }, SRC)
    expect(r).toEqual(GRANT)
    expect(hits).toHaveLength(1)
  })
})

describe('无 preferDevice（广播语义保持原样）', () => {
  it('首个 ok 应答胜出（老行为一字不变——非取票路径仍可用）', async () => {
    vi.mocked(listPresence).mockResolvedValue([pcRow(SRC, '2001:db8::a'), pcRow(OTHER, '2001:db8::b')] as never)
    const hits = stubFetch({ [SRC]: 'unreachable', [OTHER]: { status: 200, body: GRANT } })
    const r = await p2pDeliverWithReply(ACC, { msgId: 'm1' })
    expect(r).toEqual(GRANT)
    expect(hits.some((u) => u.includes('2001:db8::b'))).toBe(true)
  })
})

/* ══════════ task-42：控制面投递必须有界 + relay 兜底必须真被走到 ══════════
 *
 * 真机 RED（task-41，2026-10-27 21:25）：手机打开「权限设置」后 share-admin 只有
 * send 没有 resp、PC audit 0 事件、UI 永久 loading。怀疑链：`p2pDeliverWithReply`
 * 第一步 `await peerDevicesOf()` → `await listPresence()`；identity 面 fetch 挂起时
 * 无超时 → 既走不到 relay 兜底、也永不返回 → 上层 share-admin 永远 pending。
 */
describe('task-42：控制面投递的有界性 + relay 兜底', () => {
  afterEach(() => {
    setRelayDeliverReply(null)
    _setP2pReplyTimeoutForTest(null)
  })

  it('presence 查询挂起 → 有界（≤4s）按无直连设备处理，relay 兜底仍被走到', { timeout: 8000 }, async () => {
    vi.mocked(listPresence).mockReturnValue(new Promise(() => {}) as never)
    const relay = vi.fn(async () => ({ ok: true, reply: { ok: true, requestId: 'r-hang', data: { via: 'relay' } } }))
    setRelayDeliverReply(relay as never)
    const t0 = Date.now()
    const r = await p2pDeliverWithReply(ACC, { msgId: 'm-hang', requestId: 'r-hang' }, SRC)
    const elapsed = Date.now() - t0
    // 有界：不得等到 vitest 超时；走不到 relay 时也应返回 null
    expect(elapsed).toBeLessThan(4500)
    expect(relay).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ ok: true, reply: { ok: true, requestId: 'r-hang', data: { via: 'relay' } } })
  })

  it('直连不可达 → relay 兜底被调用并返回回包（任务要求的 relay 真被走到）', async () => {
    vi.mocked(listPresence).mockResolvedValue([pcRow(SRC, '2001:db8::a')] as never)
    stubFetch({ [SRC]: 'unreachable' })
    const relay = vi.fn(async () => ({ ok: true, reply: { ok: true, requestId: 'r1', data: { via: 'relay' } } }))
    setRelayDeliverReply(relay as never)
    const r = await p2pDeliverWithReply(ACC, { msgId: 'm-relay', requestId: 'r1' }, SRC)
    expect(relay).toHaveBeenCalledTimes(1)
    expect(relay).toHaveBeenCalledWith(ACC, expect.anything(), SRC)
    expect(r).toEqual({ ok: true, reply: { ok: true, requestId: 'r1', data: { via: 'relay' } } })
  })

  it('presence 无源设备 → relay 定向兜底仍被调用', async () => {
    vi.mocked(listPresence).mockResolvedValue([pcRow(OTHER, '2001:db8::b')] as never)
    stubFetch({})
    const relay = vi.fn(async () => ({ ok: true, reply: { ok: true, requestId: 'r2', data: { via: 'relay' } } }))
    setRelayDeliverReply(relay as never)
    const r = await p2pDeliverWithReply(ACC, { msgId: 'm-absent', requestId: 'r2' }, SRC)
    expect(relay).toHaveBeenCalledWith(ACC, expect.anything(), SRC)
    expect(r).toEqual({ ok: true, reply: { ok: true, requestId: 'r2', data: { via: 'relay' } } })
  })

  it('relay 兜底本身也挂起 → 总超时有界返回 null（真机第二层挂起：relay session 不回调）', { timeout: 5000 }, async () => {
    // 真机复现（2026-10-27 21:4x，故障注入 presence 快速失败后仍 >40s 无回包）：
    // presence 之后 relayDeliverReply 的隧道会话也可能永不回调 —— 必须由总超时兜住。
    vi.mocked(listPresence).mockResolvedValue([pcRow(OTHER, '2001:db8::b')] as never)
    stubFetch({})
    setRelayDeliverReply((() => new Promise(() => { /* relay 永不返回 */ })) as never)
    _setP2pReplyTimeoutForTest(120)
    const t0 = Date.now()
    const r = await p2pDeliverWithReply(ACC, { msgId: 'm-relay-hang', requestId: 'r3' }, SRC)
    const elapsed = Date.now() - t0
    expect(r).toBeNull()
    expect(elapsed).toBeLessThan(2000)
  })
})
