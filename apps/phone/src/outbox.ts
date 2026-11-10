/**
 * outbox.ts — 第95轮：手机端本地待发队列（纯本地 P2P 语义，无服务器信箱）。
 *
 * 与 PC apps/home/src-tauri/src/offline_queue.rs 同语义（双端对齐）：
 * - deliver 失败（对方离线/网络不通）→ 信封入本地 persistent 队列；消息行
 *   sendState="sending"（UI ⏳ 发送中，对方上线自动补发）。
 * - 触发重发：对方上线（syncWithAccount 发现对端设备在线）/ 60s 对账循环 /
 *   回前台节流对账 → 逐条重发；成功→出队 + 消息行 sendState 翻 "sent"。
 *   重发保持原 envelope（msgId/ts 不变——接收端按 msgId 幂等去重）。
 * - 队列有界：单会话 pending 上限 200 条；溢出→sendState="failed"
 *   （"对方长期不在线，消息未送达"），UI 手动重发（retrySend 重建信封）。
 *
 * 存储：IndexedDB（localStorage ~5MB 装不下待发文件 b64——任务书定案）；
 * 无 IDB 环境（vitest/node）退内存 Map；存储层可注入（_setOutboxStoreForTest），
 * 单测覆盖逻辑层，IDB 持久化语义由浏览器保证（与 fileMediaPut 同款模式）。
 */

/** 待发条目（与 PC OutboxItem 同构）。 */
import { getRootIdentity } from './identity'
import { accountDidEq, convSafe } from './didUtil'

export interface OutboxItem {
  msgId: string
  convId: string        // 本地会话 id（sendState 回写/按会话清队用）
  targets: string[]     // deliver 目标账号 did（群=成员列表快照）
  envelope: Record<string, unknown> // 完整 wire 信封（重发原样=幂等）
  ts: number            // 入队时刻（FIFO 序）
  attempts: number
  status: 'pending' | 'failed'
  lastError: string
}

/** 单会话待发上限（与 PC OUTBOX_MAX_PER_CONV 对齐）。 */
export const OUTBOX_MAX_PER_CONV = 200

/** 补发节奏（纯函数，单测；2026-10-18 fast-ack，与 PC offline_queue.rs
 *  `retry_delay_ms` 同式）：前台 3s 起指数退避（3/6/12/24/48/60s 封顶）；后台 60s。 */
export function retryDelayMs(attempt: number, foreground: boolean): number {
  if (!foreground) return 60_000
  const shift = Math.max(0, Math.min(attempt, 5)) // 3<<5 = 96s → 下面 min 封 60s
  return Math.min(3_000 * 2 ** shift, 60_000)
}

// ══════════════ 第96轮（修复1）：待发队列随账号分桶 ══════════════

/** 条目是否对账号 cur 可见（纯函数，单测）：信封 from=发送账号——A 的待发不在
 *  B 登录时被补发/误显（切回 A 仍继续）；无 from 的存量条目全账号可见（兼容）。
 *  cur 为空（未登录/测试环境）不过滤。2026-10-07：公钥级判等（from 的出示形态与
 *  当前账号 did 形态可不同）。 */
export function outboxVisibleToAccount(i: OutboxItem, cur: string | null): boolean {
  if (!cur) return true
  const from = typeof i.envelope?.from === 'string' ? (i.envelope.from as string) : ''
  return !from || accountDidEq(from, cur)
}

/** 目标表是否命中某账号（公钥级——目标 did 与查询 did 形态可不同）。 */
function targetsHit(targets: string[], account: string): boolean {
  return targets.some((t) => accountDidEq(t, account))
}

function visibleToCurAccount(i: OutboxItem): boolean {
  return outboxVisibleToAccount(i, getRootIdentity())
}

// ══════════════ 存储层（IDB 生产 / 内存测试，统一 Promise 接口） ══════════════

export interface OutboxStore {
  get(id: string): Promise<OutboxItem | null>
  put(item: OutboxItem): Promise<void>
  del(id: string): Promise<void>
  values(): Promise<OutboxItem[]>
}

const DB_NAME = 'myco-chat-outbox'
const STORE = 'outbox'
/** 内存兜底（无 IDB 环境；模块级——单测重 load 即"重启存活"的注入替身）。 */
const memStore = new Map<string, OutboxItem>()

function dbOpen(): Promise<IDBDatabase | null> {
  try {
    if (typeof indexedDB === 'undefined' || !indexedDB) return Promise.resolve(null)
    return new Promise((res) => {
      const r = indexedDB.open(DB_NAME, 1)
      r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: 'msgId' }) }
      r.onsuccess = () => res(r.result)
      r.onerror = () => res(null)
    })
  } catch { return Promise.resolve(null) }
}

const idbStore: OutboxStore = {
  async get(id) {
    const db = await dbOpen()
    if (!db) return memStore.get(id) ?? null
    return new Promise((res) => {
      const rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(id)
      rq.onsuccess = () => res((rq.result as OutboxItem | undefined) ?? null)
      rq.onerror = () => res(null)
    })
  },
  async put(item) {
    const db = await dbOpen()
    if (!db) { memStore.set(item.msgId, item); return }
    return new Promise<void>((res) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(item)
      tx.oncomplete = () => res()
      tx.onerror = () => res()
    })
  },
  async del(id) {
    const db = await dbOpen()
    if (!db) { memStore.delete(id); return }
    return new Promise<void>((res) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(id)
      tx.oncomplete = () => res()
      tx.onerror = () => res()
    })
  },
  async values() {
    const db = await dbOpen()
    if (!db) return [...memStore.values()]
    return new Promise((res) => {
      const rq = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
      rq.onsuccess = () => res((rq.result as OutboxItem[] | undefined) ?? [])
      rq.onerror = () => res([])
    })
  },
}

let store: OutboxStore = idbStore
/** 测试注入（生产不调）。 */
export function _setOutboxStoreForTest(s: OutboxStore | null): void { store = s ?? idbStore }
/** 测试用内存 store 工厂。 */
export function memOutboxStore(): OutboxStore & { dump: Map<string, OutboxItem> } {
  const m = new Map<string, OutboxItem>()
  return {
    get: async (id) => m.get(id) ?? null,
    put: async (it) => { m.set(it.msgId, it) },
    del: async (id) => { m.delete(id) },
    values: async () => [...m.values()],
    dump: m,
  }
}

// ══════════════ 队列操作 ══════════════

export type EnqueueOutcome = 'queued' | 'overflow'

/** 入队（幂等：msgId 已在队=queued 不重复）。单会话 pending 满 → overflow。
 *  2026-10-07：convId 存**归一键**（同一对端两形态不分裂成两个"会话"，删会话/计数不漏）。 */
export async function enqueueOutbox(convId: string, targets: string[], envelope: Record<string, unknown>): Promise<EnqueueOutcome> {
  const msgId = String(envelope.msgId ?? '')
  if (!msgId) return 'overflow' // 无 msgId 无法幂等——拒收（调用方标失败）
  if (await store.get(msgId)) return 'queued'
  const conv = convSafe(convId)
  const all = (await store.values()).filter(visibleToCurAccount) // 第96轮：按账号分桶计数
  const pendInConv = all.filter((i) => convSafe(i.convId) === conv && i.status === 'pending').length
  if (pendInConv >= OUTBOX_MAX_PER_CONV) return 'overflow'
  await store.put({
    msgId, convId: conv, targets, envelope, ts: Date.now(), attempts: 0,
    status: 'pending', lastError: '',
  })
  return 'queued'
}

/** 全部条目（pending+failed；UI 状态/测试观测用）。第96轮：只列当前账号可见。 */
export async function listOutbox(): Promise<OutboxItem[]> {
  const all = (await store.values()).filter(visibleToCurAccount)
  return all.sort((a, b) => a.ts - b.ts) // FIFO 入队序（IDB getAll 无序）
}

/** 某账号是否有 pending 待发（公钥级命中）。 */
export async function hasPendingForAccount(account: string): Promise<boolean> {
  const all = (await store.values()).filter(visibleToCurAccount)
  return all.some((i) => i.status === 'pending' && targetsHit(i.targets, account))
}

/** 有 pending 的账号集合（对账循环兜底 flush 枚举用）。第96轮：只枚举本账号可见条目——
 *  别的账号的待发不在本账号会话里被触发（切回那个账号时它自己的循环会补）。 */
export async function pendingAccounts(): Promise<string[]> {
  const all = (await store.values()).filter(visibleToCurAccount)
  const out = new Set<string>()
  for (const i of all) if (i.status === 'pending') for (const t of i.targets) out.add(t)
  return [...out]
}

/** 按会话清队（删好友/退群/被踢时调用——与 PC remove_conv 对齐）。
 *  第96轮：只清当前账号可见条目（convId 跨账号可撞——同好友 did——不能误清他账号待发）。
 *  2026-10-07：convId 按**归一键**比对（存量条目的裸串形态一并命中）。 */
export async function removeConvOutbox(convId: string): Promise<void> {
  const all = (await store.values()).filter(visibleToCurAccount)
  const want = convSafe(convId)
  for (const i of all) if (convSafe(i.convId) === want) await store.del(i.msgId)
}

export async function getOutboxItem(msgId: string): Promise<OutboxItem | null> {
  return store.get(msgId)
}

/** 标 failed（自动重发不再碰；UI 手动重发前提示"长期不在线"）。 */
export async function markOutboxFailed(msgId: string, err: string): Promise<void> {
  const it = await store.get(msgId)
  if (it) await store.put({ ...it, status: 'failed', lastError: err })
}

/** failed → pending（手动重发前复位）。 */
export async function requeueOutbox(msgId: string): Promise<void> {
  const it = await store.get(msgId)
  if (it) await store.put({ ...it, status: 'pending' })
}

/** deliver 注入类型：prod=p2pDeliver；单测=mock。 */
export type OutboxDeliver = (target: string, envelope: Record<string, unknown>) => Promise<boolean>

/**
 * 对命中 account 的 pending 条目逐条重发（FIFO=入队序）。
 * 成功条目出队并返回（调用方回写消息行 sendState="sent"）。
 * 任一 target 送达即算成功（与 p2pSendRaw 的 delivered 语义一致）。
 */
export async function flushAccount(account: string, deliver: OutboxDeliver): Promise<OutboxItem[]> {
  const all = await listOutbox()
  const batch = all.filter((i) => i.status === 'pending' && targetsHit(i.targets, account))
  const sent: OutboxItem[] = []
  for (const item of batch) {
    let ok = false
    for (const t of item.targets) {
      if (await deliver(t, item.envelope).catch(() => false)) ok = true
    }
    if (ok) {
      await store.del(item.msgId)
      sent.push(item)
    } else {
      await store.put({ ...item, attempts: item.attempts + 1, lastError: '对端不可达（仍离线或网络不通）' })
    }
  }
  return sent
}

/** 重发单条（手动重发路径）。返回是否送达（送达即出队）。 */
export async function flushOne(msgId: string, deliver: OutboxDeliver): Promise<boolean> {
  const item = await store.get(msgId)
  if (!item) return false
  let ok = false
  for (const t of item.targets) {
    if (await deliver(t, item.envelope).catch(() => false)) ok = true
  }
  if (ok) await store.del(msgId)
  return ok
}
