/**
 * share-entry.ts — 「点卡就进」的**取票**环节：任务卡 → 分享入口凭证（mt）。
 *
 * ── 背景（与 PC 端分工） ─────────────────────────────────────────────────
 * 任务卡的 `action.url` 指的是**源设备**的本地管理面
 * （`http://127.0.0.1:3102/api/dshShare/open?shareId=…`）——那是设备本地注册表，
 * 在手机上点必然 404。PC 端的解法是（`dsh_share.rs` 7773-7799）：
 * ```
 *   点卡 → 向源设备 A 发 share-entry-request（P2P，带设备签名）
 *        → A 校验（同账号自有设备 → owner 票；在 grant 名单 → 该 grant 的票）
 *        → 回 share-entry-grant（现签窄 mt，TTL 180s；拒绝也走回包的人话 error）
 *        → 拿 mt 开隧道 → http://127.0.0.1:<隧道本地端口>/gw/<id>/?mt=…
 * ```
 * 两个控制 kind 的 wire 形状（**逐字对齐** `dsh_share.rs`）：
 * ```
 *   request  payload = { shareId, requestId, requesterDevice, requesterAccount }
 *   信封     { msgId, from, fromName, fromDevice, fromDeviceName, to, kind, payload, ts }
 *   grant    payload = { shareId, requestId, ok, mt?, expiresAt?, gwPort?, error? }
 * ```
 *
 * ── 手机侧的现实（**必须知道**，决定了下面的两条 provider） ─────────────────
 * 手机在 presence 里**没有 addrs/port**（`identity.ts:registerPresence` 只报
 * `{nodeId,name,rootDid,role,kind:'phone',state}`），浏览器也**不能监听端口**。
 * 而源设备回包走的是 `chat_service.rs:1422 share_entry_send_default` →
 * `p2p_client.rs:302 deliver_to_account()` → 逐个**可直连设备** POST `/p2p/msg`。
 * ⇒ **纯 P2P 回推推不到手机**。
 *
 * ── 回程怎么通的（2026-10-09 收口：**同步回程**） ─────────────────────────
 * 请求方打开的那条 HTTP 连接本来就开着在等响应，而源设备的 `handle_msg` 已经在
 * await"现签"这条链——所以源设备把回包**挂进 `POST /p2p/msg` 的 HTTP 响应体**
 * 同步返回（`{ok:true, kept:…, reply:{…grant…}}`），手机读响应体即可。
 * 零新通道、零新端口、零端口白名单（PC 侧见 `chat_service` 的 `SYNC_REPLY_SLOTS`
 * 块注释）。请求方只要在 payload 里写 `syncReply: true`。
 *
 * 所以取票做成**两条 provider，同一出口**，自动择优：
 *   · **A 控制消息（spec 路径）**：发 `share-entry-request`（带 `syncReply`），
 *     回包**同步**在这次 HTTP 响应体里（`reply` 键）→ 直接成票。
 *     桌面端若还没升级（响应体里没有 `reply`），自动回落到既有 P2P 回推等待
 *     （`ShareEntryInbox`），**两边兼容**；
 *   · **B 兜底（同一份 wire，换传输）**：浏览器跨 origin fetch 在个别 WebView
 *     环境不可用时，改走**原生隧道**（原生 raw TCP，无 CORS 约束）把**同一条**
 *     `share-entry-request` 打到源设备的 p2p 数据面端口，读同一个响应体的 `reply`。
 *     **不碰本地管理面**（不再要 3102——那等于把整个管理面交给隧道）。
 *
 * 失败一律**人话**（"对方设备不在线" / "你不在这个任务的授权名单里"），
 * 不吐 tunnel/p2p/mt/端口 这类词。
 */

import type { Candidate, PeerAddrs } from './p2p-tunnel'
import { buildCandidates } from './p2p-tunnel'
import { accountDidEq } from './didUtil'
import { lastRelayFail } from './relay-fail'

// ══════════════════ 卡片形状 ══════════════════

/**
 * DSH 分享任务卡（跨设备同步过来的那条；字段名对齐 PC 端 `chat_service.rs`
 * `device_group_task_payload` 的 `card` 记录）。
 */
export interface ShareCard {
  /** 分享实例 id（`sh-…`）——没它就没有可打开的入口。 */
  shareId: string
  /** **源设备** did（隧道目标）。别和 `requesterDevice` 混。 */
  sourceDevice: string
  /** 源设备展示名（"来自 X"）。 */
  sourceDeviceName?: string
  /** 源账号 did（grant 名单按它比对；同账号时 == 本机账号）。 */
  sourceAccount: string
  /** 卡片标题（给 WebView 的标题栏/日志用）。 */
  title?: string
}

/**
 * 从卡的 `action.url` 里抠分享坐标（**纯函数**）。
 *
 * 为什么需要它（2026-10-10 真机事故）：真实广播/同步链里有的卡**顶层缺
 * `shareId`/`sourceDevice`**（只有 `sourceDeviceName`），但它的 `action.url`
 * （`/api/dshShare/remoteOpen?shareId=…&device=…&account=…`，或源设备那份
 * `/open?shareId=…`）里带着同样的坐标——URL 是源设备建卡时写死的，与顶层字段同源。
 * 顶层字段缺失时从 URL 兜底，**老卡也兼容**（不要求对方重发）。
 *
 * 解析手写不引 `URL`：`did:` 值里的 `:` 合法，值本身可能带未编码残留，按
 * `?` 后 `k=v&` 切分最稳；`#` 起是 fragment 先切掉。值做一次 decodeURIComponent
 * （PC 侧 `qenc` 只编码必要字符，解码是幂等的）。
 */
export function actionShareCoords(p: Record<string, unknown> | null | undefined): {
  shareId: string
  device: string
  account: string
} {
  const out = { shareId: '', device: '', account: '' }
  if (!p) return out
  const act = p.action && typeof p.action === 'object' ? (p.action as Record<string, unknown>) : null
  let url = str(act?.url).trim()
  if (!url) return out
  const hash = url.indexOf('#')
  if (hash >= 0) url = url.slice(0, hash)
  const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
  if (!q) return out
  for (const part of q.split('&')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const k = part.slice(0, eq).trim()
    let v = part.slice(eq + 1).trim()
    if (!v) continue
    try {
      v = decodeURIComponent(v).trim()
    } catch {
      /* 值有裸 % 也照用 */
    }
    if (!v) continue
    if (k === 'shareId' && !out.shareId) out.shareId = v
    else if (k === 'device' && !out.device) out.device = v
    else if (k === 'account' && !out.account) out.account = v
  }
  return out
}

/**
 * 从一条 task-share 消息里抽出分享卡（纯函数；不是分享卡 → null）。
 *
 * **两层形状都要认**（真机踩过）：
 *   · 设备群广播（`chat_service.rs` 的 `device_group_task_payload`）把卡片**嵌在
 *     `payload.card`** 里，外层是 `{groupId, groupName, members, card, status, fromName}`；
 *   · 好友直推的分享卡则把字段**平铺在 payload 顶层**。
 * 只认一层就会漏掉一半来源。账号 did 也做多级兜底：`sourceAccount → account → from
 * → 外层 members[0]`（设备群的 members 就是账号 did，是最可靠的那个）。
 *
 * **坐标最后一道兜底**（2026-10-10）：`shareId` / `sourceDevice` / `sourceAccount`
 * 顶层缺失时从 `action.url` 的 query 抠（[`actionShareCoords`]）——顶层与 URL 同源，
 * 谁缺谁补，不因某个同步链丢了字段就把一张本来能开的卡判死。
 */
export function shareCardOf(payload: Record<string, unknown> | null | undefined): ShareCard | null {
  if (!payload) return null
  const nested =
    payload.card && typeof payload.card === 'object' ? (payload.card as Record<string, unknown>) : null
  const p = nested ?? payload
  const urlQ = actionShareCoords(p)
  const shareId = str(p.shareId).trim() || urlQ.shareId
  const sourceDevice = str(p.sourceDevice).trim() || urlQ.device
  if (!shareId || !sourceDevice) return null
  const members = Array.isArray(payload.members) ? payload.members : []
  const sourceAccount =
    str(p.sourceAccount).trim() ||
    str(p.account).trim() ||
    str(p.from).trim() ||
    str(members[0]).trim() ||
    str(payload.from).trim() ||
    urlQ.account
  if (!sourceAccount) return null
  return {
    shareId,
    sourceDevice,
    sourceAccount,
    sourceDeviceName: str(p.sourceDeviceName) || undefined,
    title: str(p.title) || undefined,
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// ══════════════════ 入口凭证 ══════════════════

/** 分享入口凭证（现签窄票）。 */
export interface ShareEntry {
  mt: string
  /** 过期毫秒时间戳。 */
  expiresAt: number
  /** 源设备分享网关端口（PC 默认 13911；grant 回包里带）。 */
  gwPort: number
  /**
   * 票是哪条路拿到的（诊断/留痕）：
   *   · `control-sync`   —— 控制消息 + **同步回程**（回包在这次 HTTP 响应体里，正解）；
   *   · `control-message`—— 控制消息 + P2P 回推（桌面端未升级时的兼容路径）；
   *   · `broker`         —— 同一条 wire 换**原生隧道**传输（浏览器直连不可用时的兜底）。
   */
  via: 'control-message' | 'control-sync' | 'broker'
}

/** 取票失败（人话）。 */
export class EntryError extends Error {
  readonly reason: 'offline' | 'denied' | 'gone' | 'no-entry' | 'expired' | 'unsupported' | 'internal'
  constructor(reason: EntryError['reason'], message: string) {
    super(message)
    this.name = 'EntryError'
    this.reason = reason
  }
}

/** PC 端默认网关端口（`dsh_share.rs:GW_BIND_PORT`）。 */
export const DEFAULT_GW_PORT = 13911

/** request 的 payload（**逐字对齐** `dsh_share.rs:8088`）。 */
export function shareEntryRequestPayload(
  card: ShareCard,
  requestId: string,
  requesterDevice: string,
  requesterAccount: string,
): Record<string, unknown> {
  return {
    shareId: card.shareId,
    requestId,
    requesterDevice,
    requesterAccount,
  }
}

/** requestId 形状（PC 端 `format!("ser-{}", rand_hex(24))` 同形）。 */
export function newRequestId(rand: (n: number) => Uint8Array = defaultRand): string {
  const b = rand(12)
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return `ser-${s}`
}

/**
 * 要发出去的控制消息 payload：**spec 四字段 + `syncReply:true`**（纯函数，单测锁）。
 *
 * `syncReply` 是给源设备的一句话："把回包放进这次 HTTP 的响应体"——`share-entry-request`
 * 的四个字段名一个字不改（PC 端逐字解析），只多一个**加法**开关：
 * 老桌面端不认识它，照旧走 P2P 回推；新桌面端看它就同步回包。
 */
export function shareEntryRequestWire(
  card: ShareCard,
  requestId: string,
  requesterDevice: string,
  requesterAccount: string,
): Record<string, unknown> {
  return {
    ...shareEntryRequestPayload(card, requestId, requesterDevice, requesterAccount),
    syncReply: true,
  }
}

/**
 * 控制消息信封（与手机既有 `p2p.ts:buildEnvelope` **同形**：PC 端
 * `chat_service::ingest_p2p_inner` 适配层按这些键取值）。
 *
 * 放在这里（纯函数、零依赖）的理由：**provider A（浏览器直连）与 provider B
 * （原生隧道）必须发同一条 wire**——共用本函数就不会两条路各写一份信封而漂移。
 */
export function entryControlEnvelope(
  me: { account: string; device: string; name?: string; deviceName?: string },
  to: string,
  kind: string,
  payload: Record<string, unknown>,
  msgId: string,
  ts: number,
): Record<string, unknown> {
  return {
    msgId,
    from: me.account,
    fromName: me.name ?? '我',
    fromDevice: me.device,
    fromDeviceName: me.deviceName ?? 'myco-phone',
    to,
    kind,
    payload,
    ts,
  }
}

/** 控制消息 msgId（手机上不落会话，只需唯一；与 `p2p.ts` 的 se- 前缀同风格）。 */
export function newControlMsgId(now: number, rand: () => number = Math.random): string {
  return `se-${now.toString(36)}-${rand().toString(36).slice(2, 8)}`
}

function defaultRand(n: number): Uint8Array {
  const g = globalThis.crypto
  if (!g?.getRandomValues) throw new Error('本环境没有可用的随机数源')
  const b = new Uint8Array(n)
  g.getRandomValues(b)
  return b
}

/**
 * 解析 `share-entry-grant` 的 payload（纯函数）。
 * 形状不全/`ok:false` → EntryError（人话，直接把源设备给的 reason 透出去——
 * 那本来就是给人看的）。
 */
export function parseGrant(payload: Record<string, unknown>, shareId: string, now: number): ShareEntry {
  const gotShare = str(payload.shareId).trim()
  if (gotShare && gotShare !== shareId) {
    throw new EntryError('no-entry', '对方设备返回的入口信息对不上，已拒绝')
  }
  if (!(payload.ok === true)) {
    const why = str(payload.error).trim()
    const code = str(payload.code).trim()
    // 2026-10-20：源设备明确告知"分享已不存在" → 'gone'（不可重试 + 自动清僵尸卡）
    throw new EntryError(code === 'share-gone' ? 'gone' : classifyDeny(why), why || '对方设备拒绝了这次打开')
  }
  const mt = str(payload.mt).trim()
  const expiresAt = num(payload.expiresAt)
  const gwPort = num(payload.gwPort) || DEFAULT_GW_PORT
  if (!mt) throw new EntryError('no-entry', '入口凭证没拿到，再点一次试试')
  if (expiresAt > 0 && expiresAt <= now) {
    throw new EntryError('expired', '入口凭证已经失效，再点一次试试')
  }
  return { mt, expiresAt: expiresAt || now + 180_000, gwPort, via: 'control-message' }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** 把源设备给的中文拒绝理由归类（用于 UI 决定"要不要重试"）。 */
function classifyDeny(why: string): EntryError['reason'] {
  if (!why) return 'denied'
  if (/已经不在了|已停止分享|分享已停止|分享不存在/.test(why)) return 'gone'
  if (why.includes('不在线') || why.includes('没有回应')) return 'offline'
  if (why.includes('过期')) return 'expired'
  return 'denied'
}

/** 从 `Location: http://127.0.0.1:<port>/gw/<id>/?mt=…` 里取 mt 与端口（纯函数）。 */
export function parseEntryUrl(url: string, shareId: string): ShareEntry {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new EntryError('no-entry', '对方设备返回的入口地址不对，稍后再试')
  }
  const mt = u.searchParams.get('mt') ?? ''
  if (!mt) throw new EntryError('no-entry', '对方设备没给入口凭证，稍后再试')
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  if (!u.pathname.includes(`/gw/${shareId}`)) {
    throw new EntryError('no-entry', '对方设备返回的入口对不上，稍后再试')
  }
  return { mt, expiresAt: 0, gwPort: port || DEFAULT_GW_PORT, via: 'broker' }
}

/** 拼手机侧要打开的地址（**本地端口**上的同一路径）。 */
export function buildLocalEntryUrl(localPort: number, card: ShareCard, mt: string): string {
  return `http://127.0.0.1:${localPort}/gw/${card.shareId}/?mt=${encodeURIComponent(mt)}`
}

// ══════════════════ 回包收件箱（spec 路径用） ══════════════════

interface Waiter {
  shareId: string
  account: string
  resolve: (e: ShareEntry) => void
  reject: (e: Error) => void
  timer: unknown
}

const WAITERS = new Map<string, Waiter>()

/** 等 grant 的上限（与 PC 端 `REMOTE_ENTRY_WAIT_MS` 同：8s）。 */
export const ENTRY_WAIT_MS = 8_000

/**
 * 登记一个在飞的 request 并等回包。
 * 回包由 [`deliverShareEntryGrant`] 唤醒（P2P 入站那一层调它）。
 */
export function awaitGrant(
  requestId: string,
  shareId: string,
  account: string,
  opts: { timeoutMs?: number; setTimer?: (f: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void; now?: () => number } = {},
): Promise<ShareEntry> {
  const setT = opts.setTimer ?? ((f, ms) => setTimeout(f, ms))
  const now = opts.now ?? Date.now
  const timeoutMs = opts.timeoutMs ?? ENTRY_WAIT_MS
  return new Promise<ShareEntry>((resolve, reject) => {
    const timer = setT(() => {
      WAITERS.delete(requestId)
      reject(new EntryError('offline', '源设备没有回应，稍后再点一次试试'))
    }, timeoutMs)
    WAITERS.set(requestId, { shareId, account, resolve, reject, timer })
    void now
  })
}

/** 取消等待（发送失败时清场，别留悬挂定时器）。 */
export function cancelGrantWait(requestId: string): void {
  const w = WAITERS.get(requestId)
  if (!w) return
  WAITERS.delete(requestId)
  try {
    clearTimeout(w.timer as ReturnType<typeof setTimeout>)
  } catch {
    /* 注入的定时器可能不是 setTimeout */
  }
}

/**
 * P2P 入站收到 `share-entry-grant` 时调它（挂在手机的消息入库链路里）。
 * 返回 true = 已处置（**不落会话、不进任务库**——与 PC 端 `ingest_msg` 的语义一致）。
 */
export function deliverShareEntryGrant(m: Record<string, unknown>): boolean {
  const payload = (m.payload ?? {}) as Record<string, unknown>
  const requestId = str(payload.requestId).trim()
  if (!requestId) return true
  const w = WAITERS.get(requestId)
  if (!w) return true // 不是本机在等的（他机/迟到/伪造）：静默丢弃，不做放大器
  // 张冠李戴闸：share 与来源必须与请求一致
  const from = str(m.from).trim()
  const shareId = str(payload.shareId).trim()
  if ((shareId && shareId !== w.shareId) || (from && !accountEq(from, w.account))) {
    WAITERS.delete(requestId)
    clearTimeout(w.timer as ReturnType<typeof setTimeout>)
    w.reject(new EntryError('no-entry', '源设备返回的入口信息对不上，已拒绝'))
    return true
  }
  WAITERS.delete(requestId)
  clearTimeout(w.timer as ReturnType<typeof setTimeout>)
  try {
    w.resolve(parseGrant(payload, w.shareId, Date.now()))
  } catch (e) {
    w.reject(e instanceof Error ? e : new Error(String(e)))
  }
  return true
}

/** 测试用：清空收件箱。 */
export function _resetEntryInboxForTest(): void {
  for (const [id] of WAITERS) cancelGrantWait(id)
}

/** 账号 did 判等 = `didUtil.accountDidEq`（**canonical-only** 单一真源：字符串相等 ∪ 双方
 *  canonical 解出同一公钥）。2026-10-10 收敛：此前是本文件的"退化版"（剥前缀 + 可选 `z` 后
 *  比尾段——尾段近似，legacy 已废止），现统一到解码判定，与 Rust `account_did_eq` 同语义。 */
function accountEq(a: string, b: string): boolean {
  return accountDidEq(a, b)
}

// ══════════════════ 取票：两条 provider ══════════════════

/** provider A 的一次投递结果。 */
export interface ControlSendResult {
  /** 请求是否已送达源设备（false → 直接退化到兜底路径，不白等）。 */
  delivered: boolean
  /**
   * ★ **同步回程**：源设备把回包（grant）放进了**这次 HTTP 响应体**的 `reply` 键。
   * 有它就是拿到票了（或拿到一句人话拒绝）——不必再等 P2P 回推。
   * 老桌面端没有这个键 → `null`，自动回落到回推等待（两边兼容）。
   */
  reply?: Record<string, unknown> | null
}

/**
 * 同步回包归属闸（纯函数）：`requestId` 必须与本次请求一致。
 * 空 = 对端没回填（宽容放行）；不一致 = 张冠李戴（拒绝）。
 */
export function syncReplyMatches(reply: Record<string, unknown>, requestId: string): boolean {
  const rid = str(reply.requestId).trim()
  return !rid || rid === requestId
}

/** 取票上下文（全部可注入 → 单测不打网络、不等真定时器）。 */
export interface EntryContext {
  card: ShareCard
  myAccount: string
  myDevice: string
  /**
   * **provider A**：把控制消息发给源设备（生产 = 签名 POST 它的 `/p2p/msg`，
   * 并**读回响应体**）。返回是否送达 +（有的话）同步回包。
   * 老写法返回裸 `boolean` 也接受（无同步回包 → 走回推等待）。
   */
  sendControl?: (
    kind: string,
    payload: Record<string, unknown>,
    requestId: string,
  ) => Promise<boolean | ControlSendResult>
  /**
   * **provider B（兜底）**：同一份 wire 换**原生隧道**传输（浏览器跨 origin
   * fetch 不可用时）。**不打本地管理面**（不碰 3102）。
   */
  broker?: (card: ShareCard) => Promise<ShareEntry>
  /** provider A 的等待上限（默认 1.5s：同步回程拿到票就直接返回，用不到满额）。 */
  controlWaitMs?: number
  /** 注入定时器/时钟/id（测试）。 */
  setTimer?: (f: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  now?: () => number
  randId?: () => string
  onLog?: (line: string) => void
}

/**
 * 取票（自动择优）：
 *  1. 先走 **provider A**（spec 路径）。送达后优先用**同步回程**（响应体里的 `reply`）；
 *     没有（老桌面端）就在 `controlWaitMs` 内等 P2P 回推。
 *  2. 走 **provider B**（兜底：同一份 wire 换原生隧道传输）。
 *  3. 两条都不行 → `EntryError`（人话）。
 *
 * 为什么要"先 A 再 B"而不是只用 B：A 是协议正解（一条 HTTP 往返，回包在响应体里
 * 同步拿到）；B 只在浏览器直连不可用时才用。
 */
export async function requestShareEntry(ctx: EntryContext): Promise<ShareEntry> {
  const log = ctx.onLog ?? ((): void => {})
  const now = ctx.now ?? Date.now
  const errors: string[] = []
  let fatal: EntryError | null = null
  const noteFatal = (e: unknown): void => {
    if (e instanceof EntryError && (e.reason === 'gone' || e.reason === 'denied' || e.reason === 'expired')) {
      fatal = fatal ?? e
    }
  }

  // 2026-10-10 用户要求：强制直连模式下跳过 Provider A（控制消息经 identity-svc
  // 信令中转——那是 relay 路径），直接从隧道/反向隧道取票。直连不通时
  // 明确提示而非静默中转。
  const forceDirect = (() => {
    try { return localStorage.getItem('myco.forceDirect') === '1' } catch { return false }
  })()

  if (ctx.sendControl && !forceDirect) {
    const requestId = (ctx.randId ?? newRequestId)()
    const payload = shareEntryRequestWire(ctx.card, requestId, ctx.myDevice, ctx.myAccount)
    // ⚠️ **先挂等待者再发**：老桌面端可能在我们拿到响应体之前就把 grant 推回来了
    //（同一台设备上的收发是同步链）。先发后挂 = 回包撞空收件箱被丢弃。
    const waiting = awaitGrant(requestId, ctx.card.shareId, ctx.card.sourceAccount, {
      timeoutMs: ctx.controlWaitMs ?? 1500,
      setTimer: ctx.setTimer,
      clearTimer: ctx.clearTimer,
      now,
    })
    // 防"还没 await 就已 reject"（超时早于 sendControl 返回）的 unhandled rejection 噪音
    void waiting.catch(() => undefined)
    let delivered = false
    let reply: Record<string, unknown> | null = null
    try {
      const sent = await ctx.sendControl('share-entry-request', payload, requestId)
      const norm: ControlSendResult = typeof sent === 'boolean' ? { delivered: sent } : sent
      delivered = norm.delivered
      reply = norm.reply ?? null
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    }
    // ★ 同步回程优先：票就在这次 HTTP 响应体里，一次往返拿到，不等回推
    if (reply) {
      cancelGrantWait(requestId)
      if (!syncReplyMatches(reply, requestId)) {
        errors.push('源设备返回的入口信息对不上，已拒绝')
        log('[share-entry] provider A 同步回包张冠李戴，转兜底')
      } else {
        try {
          const entry: ShareEntry = { ...parseGrant(reply, ctx.card.shareId, now()), via: 'control-sync' }
          log(`[share-entry] provider A（同步回程）拿到入口，网关端口 ${entry.gwPort}`)
          return entry
        } catch (e) {
          noteFatal(e)
          errors.push(e instanceof Error ? e.message : String(e))
          log('[share-entry] provider A 同步回包不可用，转兜底')
        }
      }
    } else if (delivered) {
      try {
        const entry = await waiting
        log(`[share-entry] provider A（回推）拿到入口，via=${entry.via}`)
        return entry
      } catch (e) {
        cancelGrantWait(requestId)
        errors.push(e instanceof Error ? e.message : String(e))
        log('[share-entry] provider A 没等到回包，转兜底')
      }
    } else {
      cancelGrantWait(requestId)
      log('[share-entry] provider A 发不出去（对方没有可直连地址），转兜底')
      // 2026-10-16：**如实说**——中继腿为什么没成（卡槽满/没注册/签名没过/超时）比
      // 一句笼统的"源设备不在线"有用得多；留痕来自 dsh-open-runtime 的 relay-fail。
      const relay = lastRelayFail()
      errors.push(relay?.note || '源设备不在线（或那台设备没有可直连的地址），稍后再试')
    }
  }

  if (ctx.broker) {
    try {
      const entry = await ctx.broker(ctx.card)
      log(`[share-entry] provider B（隧道传输）拿到入口，网关端口 ${entry.gwPort}`)
      return entry
    } catch (e) {
      noteFatal(e)
      errors.push(e instanceof Error ? e.message : String(e))
    }
  }

  // 2026-10-20：致命拒绝（分享已停止/无权限/已过期）优先抛出——不可重试、并触发自动清僵尸卡
  if (fatal) throw fatal

  // 都失败：优先把"最具体"的那句人话给用户。
  // 2026-10-16：**具名原因优先**——中继卡槽满/通道没接上/签名没过/超时这几种，用户
  // 的下一步动作各不相同；"不在线"是最泛的那句，只在前两者都没有时才用。
  const specific = errors.find((s) => /中转|中继|签名|超时|通道/.test(s))
  const best =
    specific ?? errors.find((s) => s.includes('不在') || s.includes('过期') || s.includes('结束')) ?? errors[0]
  const forceDirectMsg = forceDirect
    ? '直连不通（已开启强制直连）。请确保双方在同一网络或对方有可达的直连地址'
    : ''
  throw new EntryError('offline', best || forceDirectMsg || `${ctx.card.sourceDeviceName ?? '对方设备'}暂时打不开这个任务，稍后再试`)
}

// ══════════════════ 寻址（隧道候选） ══════════════════

/**
 * 源设备的隧道候选来源（生产 = presence 的 `PresenceNode.addrs`）。
 * 形如 `{ ipv6, ipv6List, port, lan?, publicV4?, reflexive? }`。
 */
export type SourceAddrs = PeerAddrs

/** 由寻址信息装配候选（lan → publicV4 → reflexive → ipv6；缓存最前）。 */
export function candidatesForSource(addrs: SourceAddrs, cachedBase?: string | null): Candidate[] {
  return buildCandidates(addrs, cachedBase)
}
