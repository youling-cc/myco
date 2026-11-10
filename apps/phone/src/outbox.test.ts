// outbox.test.ts — 第95轮：手机端本地待发队列单测（照 chat-store.test.ts 风格）。
// 存储层注入内存实现（memOutboxStore）——逻辑层零 IndexedDB 依赖；
// IDB 持久化语义由浏览器/WebView 保证（与 fileMediaPut 同款模式）。
// 网络（deliver）全部 mock——离线/上线两态确定性覆盖。
import { describe, it, expect, beforeEach } from 'vitest'
import {
  enqueueOutbox, listOutbox, hasPendingForAccount, pendingAccounts, removeConvOutbox,
  getOutboxItem, markOutboxFailed, requeueOutbox, flushAccount, flushOne,
  memOutboxStore, _setOutboxStoreForTest, OUTBOX_MAX_PER_CONV, outboxVisibleToAccount,
  retryDelayMs,
} from './outbox'

const PEER = 'did:youling:BBB'

function env(msgId: string, text = 'x'): Record<string, unknown> {
  return { msgId, from: 'did:youling:AAA', fromDevice: 'did:myco:D', to: PEER, kind: 'text', payload: { text }, ts: 1000 }
}

let st: ReturnType<typeof memOutboxStore>
beforeEach(() => { st = memOutboxStore(); _setOutboxStoreForTest(st) })

describe('入队 + 持久化', () => {
  it('失败入队 → 重 load 仍在（重启存活语义：store 层即持久层）', async () => {
    expect(await enqueueOutbox('conv1', [PEER], env('m1', '在吗'))).toBe('queued')
    expect(await enqueueOutbox('conv1', [PEER], env('m2', '第二条'))).toBe('queued')
    // 模拟重启：store 是同一份持久层，重新 list 即得
    const items = await listOutbox()
    expect(items.map((i) => i.msgId)).toEqual(['m1', 'm2']) // FIFO 入队序
    expect(items[0].status).toBe('pending')
    expect(await hasPendingForAccount(PEER)).toBe(true)
    expect(await hasPendingForAccount('did:youling:OTHER')).toBe(false)
  })

  it('幂等：同 msgId 重复入队不重复（deliver 与 UI 重试双路径安全）', async () => {
    expect(await enqueueOutbox('c', [PEER], env('m1'))).toBe('queued')
    expect(await enqueueOutbox('c', [PEER], env('m1'))).toBe('queued')
    expect((await listOutbox()).length).toBe(1)
    // 无 msgId 拒收
    expect(await enqueueOutbox('c', [PEER], { kind: 'text' })).toBe('overflow')
  })
})

describe('上线重发', () => {
  it('对方上线 → 逐条重发成功出队 + envelope 原样（msgId/ts 不变幂等）', async () => {
    for (let i = 0; i < 3; i++) await enqueueOutbox('c', [PEER], env(`m${i}`, `消息${i}`))
    const seen: [string, string][] = []
    const sent = await flushAccount(PEER, async (t, e) => { seen.push([t, String(e.msgId)]); return true })
    expect(sent.map((i) => i.msgId)).toEqual(['m0', 'm1', 'm2']) // FIFO 逐条
    expect(await listOutbox()).toEqual([]) // 全部出队
    expect(seen).toEqual([[PEER, 'm0'], [PEER, 'm1'], [PEER, 'm2']])
    // envelope 原样保留（重发不重建——接收端按 msgId 幂等去重）
    expect(sent[0].envelope.ts).toBe(1000)
  })

  it('部分送达：任一 target 成功即出队；全失败保留且 attempts+1（下轮再试）', async () => {
    await enqueueOutbox('c', ['tA', 'tB'], env('m-ok'))
    await enqueueOutbox('c', ['tA'], env('m-fail'))
    const sent = await flushAccount('tA', async (t) => t === 'tB') // 只有 tB 可达
    expect(sent.map((i) => i.msgId)).toEqual(['m-ok'])
    const left = await listOutbox()
    expect(left.length).toBe(1)
    expect(left[0].msgId).toBe('m-fail')
    expect(left[0].attempts).toBe(1)
    expect(left[0].status).toBe('pending')
  })

  it('deliver 抛错按未达处理（网络异常不炸队列）', async () => {
    await enqueueOutbox('c', [PEER], env('m1'))
    const sent = await flushAccount(PEER, async () => { throw new Error('network down') })
    expect(sent).toEqual([])
    expect((await listOutbox())[0].attempts).toBe(1)
  })
})

describe('容量溢出', () => {
  it('单会话 200 条 pending 后第 201 条 overflow（调用方标失败态手动重发）', async () => {
    for (let i = 0; i < OUTBOX_MAX_PER_CONV; i++) {
      expect(await enqueueOutbox('convX', [PEER], env(`m${i}`))).toBe('queued')
    }
    expect(await enqueueOutbox('convX', [PEER], env('m-over'))).toBe('overflow')
    // 别的会话不受影响（按会话计数）
    expect(await enqueueOutbox('convY', [PEER], env('m-y'))).toBe('queued')
    // failed 条目不占 pending 名额（标失败后可再入新消息）
    await markOutboxFailed('m0', '对方长期不在线')
    expect(await enqueueOutbox('convX', [PEER], env('m-new'))).toBe('queued')
  })
})

describe('手动重发', () => {
  it('failed 不被自动 flush 碰；requeue + flushOne 后出队', async () => {
    await enqueueOutbox('c', [PEER], env('m1'))
    await markOutboxFailed('m1', '对方长期不在线，消息未送达')
    expect(await hasPendingForAccount(PEER)).toBe(false)
    const sent = await flushAccount(PEER, async () => true)
    expect(sent).toEqual([]) // failed 不在自动补发范围
    await requeueOutbox('m1')
    expect(await hasPendingForAccount(PEER)).toBe(true)
    expect(await flushOne('m1', async () => true)).toBe(true)
    expect(await listOutbox()).toEqual([])
  })

  it('getOutboxItem 定位条目（重发前取 convId/targets）', async () => {
    await enqueueOutbox('conv9', [PEER], env('m9', '定位我'))
    const it = await getOutboxItem('m9')
    expect(it?.convId).toBe('conv9')
    expect(it?.targets).toEqual([PEER])
    expect(await getOutboxItem('nope')).toBeNull()
  })
})

describe('清队与枚举', () => {
  it('removeConvOutbox：删好友/退群只清该会话', async () => {
    await enqueueOutbox('c1', [PEER], env('m1'))
    await enqueueOutbox('c2', [PEER], env('m2'))
    await removeConvOutbox('c1')
    const left = await listOutbox()
    expect(left.length).toBe(1)
    expect(left[0].convId).toBe('c2')
  })

  it('pendingAccounts：去重、只算 pending（对账循环兜底枚举）', async () => {
    await enqueueOutbox('c1', ['did:A', 'did:B'], env('m1'))
    await enqueueOutbox('c2', ['did:A'], env('m2'))
    await enqueueOutbox('c3', ['did:C'], env('m3'))
    await markOutboxFailed('m3', '长期不在线')
    const accts = (await pendingAccounts()).sort()
    expect(accts).toEqual(['did:A', 'did:B'])
  })
})

// ══════════════ 第96轮（修复1）：待发队列随账号分桶 ══════════════

describe('待发随账号分桶（条目只对发送账号可见）', () => {
  it('outboxVisibleToAccount 真值表', () => {
    const item = {
      msgId: 'm1', convId: 'c', targets: [PEER],
      envelope: { from: 'did:youling:AAA', msgId: 'm1' },
      ts: 1, attempts: 0, status: 'pending' as const, lastError: '',
    }
    expect(outboxVisibleToAccount(item, 'did:youling:AAA')).toBe(true)  // 本账号可见
    expect(outboxVisibleToAccount(item, 'did:youling:CCC')).toBe(false) // 他账号不可见（不补发不误显）
    expect(outboxVisibleToAccount(item, null)).toBe(true)               // 未登录/测试环境不过滤
    // 无 from 的存量条目全账号可见（分桶前兼容）
    expect(outboxVisibleToAccount({ ...item, envelope: { msgId: 'm1' } }, 'did:youling:CCC')).toBe(true)
  })
})

// ══════════════ 2026-10-18 fast-ack：补发节奏（与 PC offline_queue 同式） ══════════════

describe('补发节奏 retryDelayMs', () => {
  it('前台 3s 起指数退避、60s 封顶', () => {
    expect(retryDelayMs(0, true)).toBe(3_000)
    expect(retryDelayMs(1, true)).toBe(6_000)
    expect(retryDelayMs(2, true)).toBe(12_000)
    expect(retryDelayMs(3, true)).toBe(24_000)
    expect(retryDelayMs(4, true)).toBe(48_000)
    expect(retryDelayMs(5, true)).toBe(60_000) // 96s → 封顶
    expect(retryDelayMs(9, true)).toBe(60_000)
  })

  it('后台一律 60s（省电省流量）', () => {
    expect(retryDelayMs(0, false)).toBe(60_000)
    expect(retryDelayMs(3, false)).toBe(60_000)
  })
})
