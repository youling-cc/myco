/**
 * p2p.ts — 第84轮：手机端 P2P 直连客户端 + 对账（"指纹-索引"两段式，TS 版）。
 *
 * 消息只活在参与者的设备上——正文不再走服务器信箱（服务器白名单已收窄到
 * 好友握手三类），本地先落（chat-store），再直推对方 PC 设备（presence 寻址，
 * 逐 IPv6 地址实测选路）；失败不丢，上线后对账补齐（"活的历史"）。
 *
 * 对账摘要算法与 PC 端 apps/home/src-tauri/src/p2p_sync.rs 字节级一致：
 *   F = XOR( SHA256(msgId) for all msgs )  —— 无序、增量 O(1)、零冲突
 * （p2p-sync.test.ts 双端一致性锚点用例互锁。）
 *
 * 已知限制（v1）：手机浏览器无入站监听能力（不能当服务器）——手机是被动的
 * "发起方"：只能手机 → PC 推/拉；手机 ↔ 手机需其中一方 PC 在线做对账中继。
 */
import { sha256 } from '@noble/hashes/sha256.js'
import { signAuthHeader, listPresence, currentIdentity,  currentYoulingName } from './identity'
import { loadConvMeta, saveConvMeta, convMetaKey, ingestMsg, appendMsg, listGroups, listFriends, myAccountDid, loadConv, wirePackMsg, wirePackMsgAsync, flushOutboxFor, flushOutboxAll, updateSendState, chatTrace, isForeground, wireMsgSeen, markWireMsgSeen, seedWireMsgSeen, seedWireMsgSeenFromStorage } from './chat-store'
import { accountDidEq, convSafe } from './didUtil'
import { computePhoneState } from './presence'
import { pendingAccounts, flushAccount, retryDelayMs, type OutboxDeliver } from './outbox'

// ══════════════ 摘要纯函数（单测覆盖；与 p2p_sync.rs 一致） ══════════════

/** SHA256(msgId)（32B 指纹分量）。 */
export function hashMsgId(msgId: string): Uint8Array<ArrayBufferLike> {
  return sha256(new TextEncoder().encode(msgId))
}

/** XOR 两个 32B 指纹（原地语义的函数版）。 */
export function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = a[i] ^ b[i]
  return out
}

/** 全量指纹：XOR( SHA256(id) )；空集=全零。hex 输出与 Rust f_to_hex 一致。 */
export function digestOf(ids: string[]): string {
  let f: Uint8Array<ArrayBufferLike> = new Uint8Array(32)
  for (const id of ids) f = xorBytes(f, hashMsgId(id))
  return Array.from(f).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 索引差集：(to_push=我有他没, to_pull=他有我没)。 */
export function diffIds(mine: [string, number][], theirs: [string, number][]): { push: string[]; pull: string[] } {
  const ms = new Set(mine.map(([id]) => id))
  const ts = new Set(theirs.map(([id]) => id))
  return {
    push: mine.filter(([id]) => !ts.has(id)).map(([id]) => id),
    pull: theirs.filter(([id]) => !ms.has(id)).map(([id]) => id),
  }
}

/** F 一致判断（hex；非法 hex 视为不一致走精对——保守）。 */
export function fEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false
  return a === b
}

// ══════════════ P2P HTTP 客户端（设备钥签名） ══════════════

/** 直连超时（ms）：跨网 IPv6 最坏几秒；失败立刻换下一个地址。 */
const P2P_TIMEOUT = 5000
/**
 * 取票定向单发的直连超时（ms，2026-10-11）：share-entry 只问源设备一台，且后面
 * 还有反向隧道（provider C）与原生隧道（provider B）两条兜底——每地址 2.5s 快
 * 失败，别让 4 个不可达地址把「点开」拖过 3s 目标（原 5s×4=20s 只能吃 30s 护栏）。
 */
const P2P_ENTRY_TIMEOUT = 2500

/**
 * presence 查询超时（ms，2026-10-27 task-42 真机 P0 根因）：
 * `listPresence()` 底层的 identity-svc fetch **没有超时**——真机上它一旦挂起，
 * `peerDevicesOf()` 永不返回，`p2pDeliverWithReply` 既走不到 relay 兜底、也永不
 * settle，上层 share-admin 就永久 loading（真机证据：只有 `send` 没有 `resp`、
 * PC audit 0 事件）。有界降级为「无直连设备」后，定向 relay 兜底才能被走到。
 */
const PRESENCE_LOOKUP_TIMEOUT_MS = 3000
/**
 * 控制面投递总超时（ms，task-42）：直连 + relay 兜底全失败时必须**有界返回 null**；
 * 上层（share-admin 10s 硬超时）会给出人话错误，绝不把 UI 拖成永久 loading。
 */
const P2P_REPLY_TOTAL_TIMEOUT_MS = 15_000
/** 运行期总超时（测试可缩短；生产恒为 P2P_REPLY_TOTAL_TIMEOUT_MS）。 */
let replyTotalTimeoutMs = P2P_REPLY_TOTAL_TIMEOUT_MS

/** 测试钩子：缩短总超时以验证「relay 兜底本身也挂起」时仍有界（与 `_setStorageForTest` 同风格）。 */
export function _setP2pReplyTimeoutForTest(ms: number | null): void {
  replyTotalTimeoutMs = ms && ms > 0 ? ms : P2P_REPLY_TOTAL_TIMEOUT_MS
}

/** Promise 超时竞速：只丢弃超时后的结果、不取消原 promise；到点走 fallback（不抛错）。 */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: () => T, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[p2p] ${label} timeout ${ms}ms -> 降级（不再无限等待）`)
      resolve(fallback())
    }, ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface PeerDevice {
  did: string
  name: string
  addrs: string[]
  port: number
  state?: string | null
}

/** presence → 某账号下可直连的在线 PC 设备（排除本机、有 addrs、kind=pc）。
 *  2026-10-07：presence 表的账号/设备 did 形态与调用方传入的 did 形态可能不同
 *  （同一把钥匙四形态）——**公钥级判等**，否则直推查不到设备（消息"全挂"）。
 *  2026-11-11：`opts.includeAddrless`（对账专用）——保留无直连地址的设备
 *  （vnet 传输模式的 PC 可能不报可达 addrs），让中继兜底有机会接手；
 *  deliver 路径不传 → 行为不变（无地址不直推）。 */
export async function peerDevicesOf(
  accountDid: string,
  opts: { includeAddrless?: boolean } = {},
): Promise<PeerDevice[]> {
  // task-42：identity 面 fetch 可能永久挂起 → 有界降级为「无直连设备」，
  // 让上层（取票/聊天/share-admin）立刻走 relay 兜底而不是无限等待。
  const list = await withTimeout(
    listPresence().catch(() => []),
    PRESENCE_LOOKUP_TIMEOUT_MS,
    () => [],
    'presence 查询',
  )
  const myDevice = currentIdentity()?.did ?? ''
  return list
    .filter((p) => accountDidEq(p.rootDid, accountDid) && !accountDidEq(p.did, myDevice) && p.kind === 'pc')
    .map((p) => {
      const addrs = p.addrs?.ipv6List?.length ? p.addrs.ipv6List : (p.addrs?.ipv6 ? [p.addrs.ipv6] : [])
      return { did: p.did, name: p.name || 'myco-pc', addrs, port: p.addrs?.port ?? 9100, state: (p as { state?: string }).state ?? null }
    })
    .filter((d) => opts.includeAddrless || d.addrs.length > 0)
}

function urlOf(dev: PeerDevice, addr: string, path: string): string {
  const host = addr.includes(':') ? `[${addr}]` : addr
  return `http://${host}:${dev.port}${path}`
}

/** 签名 POST 到对端（逐地址实测，先通先得）。成功返回 JSON。
 *  2026-10-11：`timeoutMs` 可调——share-entry 定向单发（对端大概率不可达、后面还有
 *  反向隧道兜底）用短超时快失败，别把整场打开拖到 30s 护栏。 */
export async function p2pPost(dev: PeerDevice, path: string, body: unknown, opts: { timeoutMs?: number } = {}): Promise<Record<string, unknown> | null> {
  const raw = JSON.stringify(body)
  let auth: string
  try { auth = signAuthHeader(raw) } catch { return null }
  for (const addr of dev.addrs) {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? P2P_TIMEOUT)
      const r = await fetch(urlOf(dev, addr, path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Myco-Auth': auth },
        body: raw,
        signal: ctrl.signal,
      })
      clearTimeout(t)
      if (r.ok) return (await r.json().catch(() => ({}))) as Record<string, unknown>
    } catch { /* 换下一个地址 */ }
  }
  return null
}

// ══════════════ 发送直推 / typing ══════════════

// ── 2026-10-12 跨网兜底：直推失败 → 云中继隧道投递 ──────────────────────────
// 真机实测（手机异地）：手机与 PC 分处不同 v6 段（2cf:5b30 ≠ a94:8b30），
// ping6 100% 丢包——直推与对账（同走直连）全断，正文又不走服务器信箱，
// 消息只能躺 outbox。分享层早有云中继兜底（relay://…@…:8321 mux，PC 侧隧道
// 白名单 TUNNEL_DEFAULT_PORTS 也含 9100、同账号隧道授权放行），聊天层补上
// 同一条梯子：**直连优先，不通走中转**（与 DSH web 完全同构）。
//
// 钩子注入而非直接 import：p2p.ts 是传输层（不依赖隧道装配件），兜底需要
// tunnelHttpRequest/identity/factory（dsh-open 一族）——装配在 runtime 层做
// （wireChatRelayFallback），本层只留一个可测的口子。
export type RelayDeliverFn = (accountDid: string, envelope: Record<string, unknown>) => Promise<boolean>

let relayDeliver: RelayDeliverFn | null = null

/** 装配层注入中继兜底（传 null 卸载）。 */
export function setRelayDeliver(fn: RelayDeliverFn | null): void {
  relayDeliver = fn
}

/** 2026-10-14 取票中继兜底（真机异网破案：手机点卡报"源设备不在线"的根因）——
 *  p2pDeliver（聊天）有 relay 兜底，而 p2pDeliverWithReply（取票 share-entry-request）
 *  只走直推：手机在异网（蜂窝/别段 wifi）时直推必败 → 取票必败 → "没有可直连的地址"。
 *  这个 hook 走**同一条帧内 HTTP**（tunnelHttpRequest relay 候选 → POST /p2p/msg），
 *  响应体同样带 reply（serveP2pDataFace 回 {ok,kept,reply}）——中继腿也能把票带回来。 */
export type RelayDeliverReplyFn = (
  accountDid: string,
  envelope: Record<string, unknown>,
  preferDevice?: string,
) => Promise<Record<string, unknown> | null>

let relayDeliverReply: RelayDeliverReplyFn | null = null

/** 装配层注入取票中继兜底（传 null 卸载）。 */
export function setRelayDeliverReply(fn: RelayDeliverReplyFn | null): void {
  relayDeliverReply = fn
}

// ── 2026-11-11 对账（sync digest/index/batch）的 vnet 隧道兜底 ────────────────
// 真因（PC 切 vnet 传输模式后手机任务卡断流）：PC 的 p2p 数据面在 vnet 模式下
// **只绑 127.0.0.1:9100**（p2p_server.rs bind_for_mode：vnet=IPv4 回环、legacy=[::]
// 双栈）——手机按 presence addrs 直连 IPv6:9100 永远连不上，设备群 task-share
// 卡再也拉不到（手机任务卡列表空）。
//
// 唯一活路是 vnet 本地回环隧道（libvnet，RDP/DSH 数据面同款，真机已验证）：
// PC 侧按白名单全量起了 vnet server（含 9100，multiForward=false，
// peer_id=SHA256("vnet-peer"||did||":server:"||9100)），手机起 client 到它，
// 本地 25910 回环，这里直接 fetch http://127.0.0.1:<localPort><path>（PC 路由
// CORS 全开 + X-Myco-Auth 验签与直连同款）。
//
// ⚠️ 2026-11-11 起不再走 8321 mux 中继兜底（原第三级）：p2p_tunnel.rs:6436
// relay_provider_start() 已是空壳（2026-11-06 用户令：legacy 退场——云端中继
// Provider 不再启动），PC 不在 8321 注册 provider，中继腿永远超时（实测
// no-parsable-body + 每台设备白等 2.5s，纯拖慢对账）。依据：DSH协议应用
// 2026-11-11 复核（全日志 0 条 [provider]）。
export type VnetP2pTunnelFn = (deviceDid: string) => Promise<number | null>

let vnetP2pTunnel: VnetP2pTunnelFn | null = null

/** 装配层注入 vnet 对账隧道（传 null 卸载）。 */
export function setVnetP2pTunnel(fn: VnetP2pTunnelFn | null): void {
  vnetP2pTunnel = fn
}

/** 经 vnet 本地回环口 POST 对端 p2p 数据面（签名头与直连同款）。失败 null。
 *
 *  2026-11-11 真机实证：**不能用 JS fetch**。APK 里页面来自
 *  `file:///android_asset/www/index.html`，源是 `null`；fetch 到
 *  `http://127.0.0.1:25910` 属跨源 + 明文，WebView 直接判失败
 *  （实测：TCP 连上又断，`TypeError: Failed to fetch`，PC 侧根本没收到请求）。
 *  APK 内必须走 Java HTTP（`MycoShell.proxyPostAsync`，与既有
 *  `chatRelayPost` 同一条腿，没有 CORS 概念）；浏览器/PWA 形态才用 fetch。
 */
async function p2pPostViaVnet(localPort: number, path: string, body: unknown): Promise<Record<string, unknown> | null> {
  const raw = JSON.stringify(body)
  let auth: string
  try { auth = signAuthHeader(raw) } catch { return null }
  const url = `http://127.0.0.1:${localPort}${path}`
  const bridge = (window as unknown as { MycoShell?: { proxyPostAsync?: (...a: unknown[]) => void } }).MycoShell
  if (bridge && typeof bridge.proxyPostAsync === 'function') {
    const w = window as unknown as Record<string, unknown>
    const cbName = '__p2pSyncCb' + Math.random().toString(36).slice(2)
    const res = await new Promise<{ status?: number; body?: string } | null>((resolve) => {
      const timer = setTimeout(() => { delete w[cbName]; resolve(null) }, P2P_TIMEOUT + 2000)
      w[cbName] = (r: { status?: number; body?: string }) => {
        clearTimeout(timer); delete w[cbName]; resolve(r || null)
      }
      try {
        bridge.proxyPostAsync!('window.' + cbName, url, 'application/json', auth, raw)
      } catch {
        clearTimeout(timer); delete w[cbName]; resolve(null)
      }
    })
    if (!res || !res.status || res.status < 200 || res.status >= 300 || typeof res.body !== 'string') {
      // 非 2xx 必须留痕：只记"post-fail"会把 403（签名/授权）和超时混成一种现象。
      noteSyncDiag('post-http', {
        path, status: res ? res.status : -1,
        body: res && typeof res.body === 'string' ? res.body.slice(0, 140) : '',
      })
      return null
    }
    try { return JSON.parse(res.body) as Record<string, unknown> } catch { return {} }
  }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), P2P_TIMEOUT)
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Myco-Auth': auth },
      body: raw,
      signal: ctrl.signal,
    })
    clearTimeout(t)
    if (r.ok) return (await r.json().catch(() => ({}))) as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

/** 直连 + vnet 隧道兜底的 p2p POST（对账专用；deliver 路径各有自己的兜底，
 *  不走这里）。设备无直连地址（addrs 空，PC 在 vnet 模式下 presence 可能不报
 *  可达地址）时直接走 vnet——没有这层，syncWithAccount 连尝试都不会发生。 */
async function p2pPostSync(dev: PeerDevice, path: string, body: unknown): Promise<Record<string, unknown> | null> {
  const direct = dev.addrs.length > 0 ? await p2pPost(dev, path, body) : null
  if (direct) {
    noteSyncDiag('post', { path, via: 'direct', dev: dev.did.slice(-4) })
    return direct
  }
  if (vnetP2pTunnel) {
    try {
      const localPort = await vnetP2pTunnel(dev.did)
      noteSyncDiag('post', { path, via: 'vnet', dev: dev.did.slice(-4), port: localPort })
      if (localPort && localPort > 0) {
        const via = await p2pPostViaVnet(localPort, path, body)
        if (via) return via
        noteSyncDiag('post-fail', { path, via: 'vnet-post', dev: dev.did.slice(-4) })
      }
    } catch (e) {
      noteSyncDiag('post-fail', { path, via: 'vnet-ensure', dev: dev.did.slice(-4), err: String(e) })
    }
  } else {
    noteSyncDiag('post-fail', { path, via: 'none', dev: dev.did.slice(-4) })
  }
  return null
}

/** wire 信封（与 PC p2p_send_raw 同形）。 */
export function buildEnvelope(to: string, kind: string, payload: Record<string, unknown>, msgId: string, ts: number): Record<string, unknown> {
  return {
    msgId, from: myAccountDid() ?? '', fromName: currentYoulingName() || '好友',
    fromDevice: currentIdentity()?.did ?? '', fromDeviceName: 'myco-phone',
    to, kind, payload, ts,
  }
}

/** 直推信封给某账号全部在线设备（任一送达=true；未达设备靠对账补）。
 *  2026-10-12：直推全败时走中继兜底（钩子未注入=行为不变）。
 *  2026-10-18 fast-ack：`opts.timeoutMs` 单地址直连超时（首发用 1500 快失败）、
 *  `opts.budgetMs` 整次投递总预算（超时按未达返回 false——在飞请求忽略；接收端
 *  msgId 幂等，补发环重投无害；慢路交给补发环/对账走宽预算）。 */
export interface DeliverOpts {
  timeoutMs?: number
  budgetMs?: number
}

/**
 * 直推失败记忆（2026-10-20 手机→PC 3.3s→目标 <300ms）。
 *
 * 真机：手机与 PC 在同一 WiFi 但被 AP 隔离，直推每次白等 1.5s 超时后才走中继；
 * 而中继通路本身只要 ~200ms（建隧道 168ms + POST 50ms）。旧实现"直推全败才中继"
 * 让每条消息都付这份 1.5s。这里记住"该账号直推不可达"，TTL 内让中继与直推**并行**，
 * 谁先到谁赢；中继成功后再续 TTL。直推成功则清标记（换网络后自动恢复直连优先）。
 */
const RELAY_PREF_TTL_MS = 120_000
const relayPrefUntil = new Map<string, number>()

function relayPreferred(accountDid: string): boolean {
  return Date.now() < (relayPrefUntil.get(accountDid) ?? 0)
}

function markRelayPreferred(accountDid: string): void {
  relayPrefUntil.set(accountDid, Date.now() + RELAY_PREF_TTL_MS)
}

function clearRelayPreferred(accountDid: string): void {
  relayPrefUntil.delete(accountDid)
}

export async function p2pDeliver(accountDid: string, envelope: Record<string, unknown>, opts: DeliverOpts = {}): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    const devs = await peerDevicesOf(accountDid)
    const skipDirect = relayPreferred(accountDid)
    let directOk = false
    const directP = (async (): Promise<boolean> => {
      if (skipDirect) return false
      for (const d of devs) {
        if (await p2pPost(d, '/p2p/msg', envelope, { timeoutMs: opts.timeoutMs }).then((r) => !!r?.ok)) {
          directOk = true
          return true
        }
      }
      return false
    })().catch(() => false)
    let relayOk = false
    const relayP = relayDeliver
      ? relayDeliver(accountDid, envelope)
          .then((ok) => {
            relayOk = ok
            return ok
          })
          .catch(() => false)
      : Promise.resolve(false)
    // 先到先赢：任一路成功立刻返回（不再"直推全败才中继"白等 1.5s）
    const won = await new Promise<boolean>((resolve) => {
      let pending = 2
      let settled = false
      const settle = (ok: boolean): void => {
        pending -= 1
        if (ok && !settled) {
          settled = true
          resolve(true)
        } else if (pending === 0 && !settled) {
          settled = true
          resolve(false)
        }
      }
      directP.then(settle, () => settle(false))
      relayP.then(settle, () => settle(false))
    })
    if (directOk) {
      clearRelayPreferred(accountDid)
      return true
    }
    if (won && relayOk) {
      markRelayPreferred(accountDid)
      console.log(`[p2p] 中继送达（直推${skipDirect ? '已跳过' : '不可达'}，to=…${accountDid.slice(-6)}）`)
      return true
    }
    return won
  }
  if (!opts.budgetMs) return run()
  // 总预算：到点即返回 false（首发的 M5 快失败）；在飞 promise 不取消，但接收端
  // 按 msgId 幂等——万一它后来送达，也只是重复一条被丢弃的副本。
  const budget = opts.budgetMs
  return new Promise<boolean>((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve(false)
    }, budget)
    void run()
      .then((ok) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(ok)
      })
      .catch(() => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(false)
      })
  })
}

/** 2026-10-18 fast-ack：通知 UI「聊天本地状态有变化」（发送态翻转/新消息入库）——
 *  FriendsPanel 的 `onSendStateChange(load)` 订阅者立即重读会话（P2P 直推到达不再
 *  等 5s 轮询窗口；M7 接收上屏 ≤300ms 的手机侧关键一环）。 */
export function notifyChatStateChanged(): void {
  emitSendStateChange()
}

/**
 * 直推信封并**读回响应体**（2026-10-09「同步回程」）。
 *
 * 为什么需要它：手机是纯拉取设备（presence 不报 addrs、浏览器不能监听端口），
 * 源设备**推不回**回包；而这条 HTTP 连接本来就开着在等响应——所以源设备把回包
 * 挂进 `POST /p2p/msg` 的响应体（`{ok,kept,reply}`），手机读 `reply` 即可。
 * 首个应答 `ok` 的设备即返回它的响应体（`reply` 在不在由源设备版本决定：
 * 老版本没有这个键 → 调用方回落到既有 P2P 回推等待，两边兼容）。
 *
 * 2026-10-11 `preferDevice`（**源设备定向**，真机"点打开白屏/误报任务不存在"根修）：
 * 取票的 share-entry-request 此前**广播给账号下所有在线 PC、谁先应答听谁的**——
 * 同账号挂着多台设备时（PC + 笔记本），**没有这张分享的设备**会抢先答一句
 * deny「这个任务在那台设备上已经不在了」，真正持有分享的源设备的 grant 永远
 * 到不了（真机复现：laptop-cjfan 抢答，DESKTOP-KJS1H2L 的票被吞）。
 * 卡上带 `sourceDevice`（shareCardOf 保证有）→ 只问它；它不在线（presence 查无/
 * 无直连地址）→ 直接 null，交给 provider B/C（隧道/反向中继）**定向**打源设备，
 * 不再拿别台设备的错误答案当结论。
 */
export async function p2pDeliverWithReply(
  accountDid: string,
  envelope: Record<string, unknown>,
  preferDevice?: string,
): Promise<Record<string, unknown> | null> {
  // task-42：总超时护栏——presence/直连/relay 任何一环挂起都不得让调用方永久 pending
  // （真机 P0：share-admin 只有 send 没有 resp，UI 无限 loading）。
  const t0 = Date.now()
  const r = await withTimeout(
    deliverWithReplyInner(accountDid, envelope, preferDevice),
    replyTotalTimeoutMs,
    () => null,
    'deliver-with-reply',
  )
  console.log(`[p2p] deliver-with-reply prefer=${preferDevice ? preferDevice.slice(-8) : '-'} -> ${r ? 'ok' : 'null'} ${Date.now() - t0}ms`)
  return r
}

/** 内部实现（无总超时；由外层 `p2pDeliverWithReply` 统一兜底）。 */
async function deliverWithReplyInner(
  accountDid: string,
  envelope: Record<string, unknown>,
  preferDevice?: string,
): Promise<Record<string, unknown> | null> {
  const devs = await peerDevicesOf(accountDid)
  // 源设备定向：命中（公钥级判等——presence 与卡的 did 形态可能不同）只发它一台；
  // 没命中也**不广播**（别的设备必答"任务不在了"，白吃错误答案）。
  if (preferDevice) {
    const hit = devs.find((d) => accountDidEq(d.did, preferDevice))
    if (!hit) {
      // 2026-10-14：presence 查无/无直连地址 ≠ 源设备真不在线——中继注册面独立于
      // presence（provider 常驻）。走取票中继兜底（定向源设备），失败才算真不可达。
      if (relayDeliverReply) {
        try {
          const r = await relayDeliverReply(accountDid, envelope, preferDevice)
          if (r && r.ok) return r
        } catch { /* 兜底失败回落 null */ }
      }
      return null
    }
    const r = await p2pPost(hit, '/p2p/msg', envelope, { timeoutMs: P2P_ENTRY_TIMEOUT })
    if (r?.ok) return r
    // 2026-10-14：定向直推失败（异网直连不通）→ 同样走中继兜底再试一次。
    if (relayDeliverReply) {
      try {
        const r2 = await relayDeliverReply(accountDid, envelope, preferDevice)
        if (r2 && r2.ok) return r2
      } catch { /* 兜底失败维持直推结论 */ }
    }
    return null
  }
  for (const d of devs) {
    const r = await p2pPost(d, '/p2p/msg', envelope)
    if (r?.ok) return r
  }
  return null
}

/** typing TTL（本机 presence state 用）+ 瞬时信号直发。
 *  2026-09-29 灯恢复：设 TTL 后即时重报 presence（原 20s 周期撞 4s TTL 命中率 ~20%）；
 *  to=grp-* 群扇出逐成员（原样发 grp- id 查不到设备，群 typing 静默全丢）。 */
let typingUntil = 0
export async function sendTyping(convId: string, to: string): Promise<void> {
  typingUntil = Date.now() + 4000
  void reportPresenceNow()
  const my = myAccountDid() ?? ''
  // 群扇出：逐成员账号（自己除外）；单聊=对方账号。
  let targets: string[] = [to]
  if (to.startsWith('grp-')) {
    const g = listGroups().find((x) => x.id === to)
    targets = (g?.members ?? []).filter((d) => d && !accountDidEq(d, my))
  }
  for (const acc of targets) {
    const devs = await peerDevicesOf(acc)
    for (const d of devs) {
      await p2pPost(d, '/p2p/typing', { convId, from: my, fromName: currentYoulingName(), fromDevice: currentIdentity()?.did ?? '' }).catch(() => null)
    }
  }
}

/** 发送/清空后回退 active：TTL 清零 + 即时重报（2026-09-29 灯恢复）。 */
export function clearTyping(): void {
  if (typingUntil > 0) {
    typingUntil = 0
    void reportPresenceNow()
  }
}

// ══════════════ 对账（手机=发起方：digest → index → batch） ══════════════

export interface SyncProgress { peer: string; got: number; pushed: number; convId?: string; done?: boolean }
type ProgressListener = (p: SyncProgress) => void
const progressListeners = new Set<ProgressListener>()
export function onP2pSyncProgress(l: ProgressListener): () => void {
  progressListeners.add(l)
  return () => progressListeners.delete(l)
}
function emitProgress(p: SyncProgress): void { progressListeners.forEach((l) => l(p)) }

/** 第95轮：发送状态翻转通知（离线队列补发成功/重发失败 → UI 重读会话刷新徽标）。 */
type SendStateListener = () => void
const sendStateListeners = new Set<SendStateListener>()
export function onSendStateChange(l: SendStateListener): () => void {
  sendStateListeners.add(l)
  return () => sendStateListeners.delete(l)
}
function emitSendStateChange(): void { sendStateListeners.forEach((l) => l()) }

/** 第95轮：补发某账号的本地待发队列（对方上线即送达，不等对账收敛）。
 *  有成功条目时广播 send-state 变化（FriendsPanel ChatScreen 重读）。 */
async function flushOutboxAndNotify(account: string): Promise<void> {
  try {
    const sent = await flushOutboxFor(account)
    if (sent.length > 0) emitSendStateChange()
  } catch { /* best-effort */ }
}

const inFlight = new Set<string>()

/** 与某账号（好友/自己）的全部在线 PC 设备对账。返回新收条数。
 *  第95轮：发现对方在线（devs 非空）先补发本地待发队列，再对账。
 *  2026-11-11：对账设备清单带 includeAddrless（中继兜底可接管无直连地址的
 *  设备——设备群 task-share 卡的拉取不再依赖双方可直连）。 */
// ── 对账诊断环（2026-11-11 真机排障：任务卡拉不到时"到底走到哪一步"是黑盒）──
// 只记事实、不参与业务；`window.__mycoSyncDiag()` 可随时读最近 40 条。
// 起因：手机任务卡空了一整天，日志里只有最后一句 "vnet 隧道 ensure 失败"，
// 分不清是"没设备/没地址/直连超时/隧道建不起来/对端没数据"。
export type SyncDiagEntry = { ts: number; ev: string; [k: string]: unknown }
const syncDiagRing: SyncDiagEntry[] = []

export function noteSyncDiag(ev: string, kv?: Record<string, unknown>): void {
  const e: SyncDiagEntry = { ts: Date.now(), ev, ...(kv ?? {}) }
  syncDiagRing.push(e)
  if (syncDiagRing.length > 40) syncDiagRing.shift()
  try {
    const w = window as unknown as Record<string, unknown>
    w.__mycoSyncDiag = () => syncDiagRing.slice()
  } catch {
    /* 非浏览器环境（单测）忽略 */
  }
  try { console.log('[p2p-sync] ' + JSON.stringify(e)) } catch { /* ignore */ }
}

export async function syncWithAccount(accountDid: string): Promise<number> {
  let devs: PeerDevice[] = []
  try {
    devs = await peerDevicesOf(accountDid, { includeAddrless: true })
  } catch (e) {
    // 阵容查询本身就是网络面（identity-svc 名册）：抛异常时原来被调用方
    // `.catch(() => {})` 吞掉 → 界面上只是"卡不来"，日志一片空白。
    noteSyncDiag('account-fail', { acc: accountDid.slice(-4), err: String(e) })
    return 0
  }
  noteSyncDiag('account', { acc: accountDid.slice(-4), devs: devs.length, addrs: devs.map((d) => d.addrs.length) })
  if (devs.length > 0) await flushOutboxAndNotify(accountDid)
  let got = 0
  for (const d of devs) got += await syncWithDevice(d, accountDid).catch(() => 0)
  return got
}

/** 我方相关会话（对方视角合法范围）摘要。2026-10-07：会话 id 走**归一键**
 *  （`convSafe`）——与 chat-store 的存储键/摘要键同源；此前按裸串传入，同一对端两形态
 *  在摘要里被当成两个会话（对端比 F 时"我缺这个会话"→ 拉不到 or 重复拉）。 */
function myDigestFor(peer: string): Record<string, { n: number; lastTs: number; F: string }> {
  const convs = new Set<string>([convSafe(peer)])
  const my = myAccountDid() ?? ''
  for (const g of listGroups()) {
    if (accountDidEq(peer, my) || g.members.some((m) => accountDidEq(m, peer))) convs.add(g.id)
  }
  const out: Record<string, { n: number; lastTs: number; F: string }> = {}
  for (const c of convs) {
    const m = loadConvMeta(c)
    out[c] = { n: m.n, lastTs: m.lastTs, F: m.F }
  }
  return out
}

/**
 * 对端视角 convId → 本地 convId（2026-10-18 对账重放根修，与 PC
 * `p2p_client.rs sync_with_device_inner` 的 my_did_safe/peer_did_safe 映射同款）。
 *
 * 对端摘要里的**单聊** convId = `convSafe(我的账号)`（对端眼中"与我的会话"），
 * 本地同一聊天存为 `convSafe(对端账号)`。此前手机侧缺这层映射 → 拿对端视角键去
 * `loadConvMeta`（本地恒空）→ F 恒不相等 → **每拍把对端全量历史当"缺的"重拉重灌**
 * （实测同一批 64 个 msgId/2 分钟各重放 ~22 次）。群 convId（grp-*）双方一致、原样。
 */
export function localConvIdOfPeerView(convId: string, myAccount: string, peerAccount: string): string {
  if (!convId || !myAccount || !peerAccount) return convId
  // 自同步（对端=同一账号，多设备）：视角相同，不做映射（对端回的就是双方一致的会话键）
  if (accountDidEq(myAccount, peerAccount)) return convId
  if (convSafe(convId) === convSafe(myAccount)) return convSafe(peerAccount)
  return convId
}

/**
 * 对账拉取前的**严格按 msgId 去重**（2026-10-18 重放风暴根修）：`theirs - mine` 里
 * 若某 msgId 已在本机**任何**会话键里（内存索引，含历史因 to/from 形态差异落进别的
 * 会话键的同一批消息），不再当"缺的"拉——否则每拍重放（实测 80 条 × 每次对账，
 * 2 分钟 1252 行 recv）。msgId 全局唯一，重复出现只可能是同一物理消息。
 */
export function filterUnknownMsgIds(ids: string[]): string[] {
  return ids.filter((id) => !wireMsgSeen(id))
}

/** 与单台设备对账（在飞去重防环）。`peerAccount`=该设备所属账号（好友/自己）——
 *  用于 convId 视角映射（缺失会把单聊 F 比成恒不等，见 localConvIdOfPeerView）。 */
export async function syncWithDevice(dev: PeerDevice, peerAccount: string): Promise<number> {
  if (inFlight.has(dev.did)) return 0
  inFlight.add(dev.did)
  try {
    return await syncWithDeviceInner(dev, peerAccount)
  } finally {
    inFlight.delete(dev.did)
  }
}

const SYNC_CHUNK = 50

/** 会话级"无进展"记忆（2026-10-18 对账空转治理）：对端可能持有本机**永远存不下**的
 *  行（被闸丢弃的未知 kind/禁言消息等）→ 每拍 F 都不同、每次 index+batch 却一条也
 *  灌不进来。记下「上轮双方 F 且 0 进展」，下一拍 F 都没变就整会话跳过；任一侧出现
 *  新消息（F 变）自动重试。纯内存、session 级。 */
const syncNoProgress = new Map<string, { peerF: string; mineF: string }>()

async function syncWithDeviceInner(dev: PeerDevice, peerAccount: string): Promise<number> {
  const my = myAccountDid()
  if (!my) return 0
  // 2026-10-18：全局预热 msgId 索引（每账号桶一次，之后 O(1) 空转；见 chat-store
  // seedWireMsgSeenFromStorage —— 历史落错会话键的同一批 msgId 不再被当缺口重拉）
  try { seedWireMsgSeenFromStorage() } catch { /* best-effort：失败退回按会话预热 */ }
  const fromDevice = currentIdentity()?.did ?? ''
  // ① digest（2026-11-11 起走 p2pPostSync：直连失败/无地址 → 中继兜底）
  const resp = await p2pPostSync(dev, '/p2p/sync/digest', { from: my, fromDevice, convs: myDigestFor(my === '' ? '' : devDidToAccount(dev)) })
  if (!resp) return 0
  const peerConvs = (resp.convs ?? {}) as Record<string, { n: number; lastTs: number; F: string }>
  let totalGot = 0
  let totalPushed = 0
  // ② 逐会话比 F → ③ index → ④ batch
  // convId：请求/响应一路用**对端视角**（对端按自己的会话文件查）；
  // localConv：本地读写用**本地视角**（单聊=convSafe(对端账号)，群=同 id）。
  for (const [convId, pd] of Object.entries(peerConvs)) {
    const localConv = localConvIdOfPeerView(convId, my, peerAccount)
    const mine = loadConvMeta(localConv)
    // 2026-10-18：把已知历史 msgId 预热进内存去重索引——哪怕 F 比对出现偏差，
    // 后续 batch 回包里的历史重放也只在 ingestWireMsg 入口被 O(1) 丢掉。
    seedWireMsgSeen(mine.ids.map(([id]) => id))
    if (fEqual(mine.F, pd.F)) {
      syncNoProgress.delete(localConv)
      continue
    }
    // 上轮双方 F 都没变且 0 进展 → 本拍跳过（避免对"存不下的行"每拍空转两趟 HTTP）
    const memo = syncNoProgress.get(localConv)
    if (memo && memo.peerF === pd.F && memo.mineF === mine.F) continue
    const idx = await p2pPostSync(dev, '/p2p/sync/index', { from: my, fromDevice, convId })
    if (!idx) continue
    const theirs = ((idx.ids ?? []) as [string, number][])
    const { push, pull: pullRaw } = diffIds(mine.ids, theirs)
    // 2026-10-18 严格去重：已在任何会话键里出现过的 msgId 不再当缺口拉——历史因
    // to/from 形态差异落进别的会话键时，F 永远比不齐，旧实现每拍全量重拉重灌。
    const pull = filterUnknownMsgIds(pullRaw)
    if (pull.length === 0 && pullRaw.length > 0) {
      // "缺的"全是本机已有的同一批 msgId：本拍不拉不灌，记无进展等 F 变化（新消息）。
      syncNoProgress.set(localConv, { peerF: pd.F, mineF: mine.F })
      continue
    }
    // 本地 wire 形态（mediaId → b64；第94轮：文件媒体在 IndexedDB，用异步版补齐）
    const local = loadConv(localConv)
    const pushMsgs: Record<string, unknown>[] = []
    for (const m of local.filter((mm) => push.includes(mm.msgId))) {
      pushMsgs.push(m.kind === 'file' ? await wirePackMsgAsync(m) : wirePackMsg(m))
    }
    let got = 0
    // 分批推 + 尾批带 want
    const batches: { msgs: typeof pushMsgs; want: string[] }[] = []
    if (pushMsgs.length === 0 && pull.length > 0) batches.push({ msgs: [], want: pull })
    else {
      for (let i = 0; i < pushMsgs.length; i += SYNC_CHUNK) batches.push({ msgs: pushMsgs.slice(i, i + SYNC_CHUNK), want: [] })
      if (pull.length > 0) {
        if (batches.length) batches[batches.length - 1].want = pull
        else batches.push({ msgs: [], want: pull })
      }
    }
    for (const b of batches) {
      const r = await p2pPostSync(dev, '/p2p/sync/batch', {
        from: my, fromDevice, convId,
        msgs: b.msgs, want: b.want,
      })
      if (!r) continue
      for (const m of ((r.msgs ?? []) as Record<string, unknown>[])) {
        if (ingestWireMsg(m)) got += 1
      }
    }
    totalGot += got
    totalPushed += push.length
    // 无进展记忆：拉了 want 却一条没存进来（对端持有本机存不下的行）→ 下拍 F 未变则跳过
    if (pull.length > 0 && got === 0) syncNoProgress.set(localConv, { peerF: pd.F, mineF: mine.F })
    else syncNoProgress.delete(localConv)
    // 诊断（低频、每差异会话一行）：修后应只见真实缺口（把历史重放按 0 计）。
    if (pull.length > 0 || push.length > 0) {
      console.log(`[p2p-sync] ${String(localConv).slice(-24)} pull=${pull.length} push=${push.length} got=${got}`)
    }
    emitProgress({ peer: dev.name, convId: localConv, got, pushed: push.length })
  }
  if (totalGot + totalPushed > 0) emitProgress({ peer: dev.name, got: totalGot, pushed: totalPushed, done: true })
  return totalGot
}

/** digest 请求的 from 语义：对方 server 闸按"from=好友账号"过滤会话——手机用
 *  自己账号 did（对端把"我的会话"范围给我）；此处取本机账号。 */
function devDidToAccount(dev: PeerDevice): string {
  return myAccountDid() ?? dev.did
}

/** wire 信封 → 信箱格式 → chat-store.ingestMsg 落盘（幂等由 convmeta 判重保证）。
 *  设备群（2026-10-07 决策 D）：信封 fromDeviceName 随行透传（同 fromDevice）。
 *  2026-10-18 fast-ack：新消息入库即通知 UI 重读（P2P 直推到达立即上屏，M7）+
 *  `[chat-trace] recv`（ms=端到端时延，测量脚本按 msgId 对齐发送端 send-ack）。
 *  2026-10-18 对账重放治理：**入口按 msgId 严格去重**——见过即丢（不 ingest、不
 *  notify、不 recv trace、不触发渲染）；`ingestMsg` 的返回值是"已处理"不是"新入库"
 *  （text 等分支恒 true），不能拿它判断重复。重复登记用 `markWireMsgSeen`。
 */
export function ingestWireMsg(m: Record<string, unknown>): boolean {
  const my = myAccountDid()
  if (!my) return false
  // 2026-10-12 控制类 kind：不落会话（PC 端同款拦截）。msg-receipt=已读回执
  //（PC 发来的"你的消息我读了"——手机发出的消息要显已读需消费它，本轮先静默
  // 兼容：不落怪系统条；消费回执下轮做）。
  const kind = String(m.kind ?? '')
  if (kind === 'msg-receipt') return false
  const msgId = String(m.msgId ?? '')
  if (!msgId) return false
  if (wireMsgSeen(msgId)) return false // 重复（对账重放/补发双投）：严格去重，零副作用
  const kept = ingestMsg(my, {
    seq: 0,
    id: msgId,
    from: String(m.from ?? ''),
    fromName: String(m.fromName ?? ''),
    fromDevice: String(m.fromDevice ?? ''),
    fromDeviceName: String(m.fromDeviceName ?? ''),
    to: String(m.to ?? ''),
    kind: String(m.kind ?? ''),
    payload: (m.payload ?? {}) as Record<string, unknown>,
    ts: Number(m.ts ?? Date.now()),
  })
  // 无论 kept 与否都登记：未知 kind / 被闸丢弃的消息也不该每拍重走状态机（否则
  // 会像历史重放一样每次对账都打一条 recv trace、白烧一次 ingest）。
  markWireMsgSeen(msgId)
  if (kept) {
    const ts = Number(m.ts ?? 0)
    chatTrace('recv', msgId, String(m.from ?? ''), ts > 0 ? Math.max(0, Date.now() - ts) : 0)
    notifyChatStateChanged()
  }
  return kept
}

// ══════════════ 后台循环：对账 + presence state 上报 ══════════════

/** 最近一次用户交互时刻（active/idle 判定）。 */
let lastInteraction = Date.now()
function markInteraction(): void { lastInteraction = Date.now() }
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', markInteraction, { passive: true })
  document.addEventListener('keydown', markInteraction, { passive: true })
}

/** 手机设备状态：typing TTL > 后台=idle > 5min 无交互=idle > active（决策纯函数在
 *  ./presence，单测覆盖；手机不能可靠检测锁屏，息屏/切后台按 idle 报）。 */
export function phoneState(): 'active' | 'typing' | 'idle' {
  return computePhoneState({
    now: Date.now(),
    typingUntil,
    visible: typeof document === 'undefined' ? true : document.visibilityState === 'visible',
    lastInteractionAt: lastInteraction,
  })
}

/** presence state 即时重报（typing/回退/前后台切换时调用；周期 20s 循环兜底）。
 *  模块级 + 3s 自节流：连续打字每次 sendTyping 都调也只 3s 一发。 */
let lastReportAt = 0
export async function reportPresenceNow(): Promise<void> {
  const now = Date.now()
  if (now - lastReportAt < 3000) return
  lastReportAt = now
  try {
    const { registerPresence } = await import('./identity')
    await registerPresence(navigator.userAgent.includes('Android') ? 'myco-phone' : 'phone', phoneState())
  } catch { /* best-effort */ }
}

let loopsStarted = false
/** 最近一次对账时刻（syncNowThrottled 节流用）。 */
let lastSyncAt = 0

/** 全量对账一次（ok 好友 + 自己的其他 PC 设备）。
 *  第95轮：对账前先把有 pending 的账号逐个补发（syncWithAccount 内的
 *  flushOutboxAndNotify 已覆盖在线场景；flushOutboxAll 是有待发时的兜底枚举）。 */
function syncAllAccounts(): void {
  const my = myAccountDid()
  const friends = listFriends().filter((f) => (f.status ?? 'ok') === 'ok').map((f) => f.did)
  // 诊断：没有这句时「60s 环到底跑没跑、账号认没认出来」在真机上完全不可见
  noteSyncDiag('all', { my: my ? my.slice(-4) : null, friends: friends.length })
  if (!my) return
  void flushOutboxAll().then((n) => { if (n > 0) emitSendStateChange() }).catch(() => {})
  const accounts = friends
  accounts.push(my) // 自己的 PC 设备（多设备同步）
  for (const a of accounts) void syncWithAccount(a).catch(() => {})
}

/** 节流对账（默认 15s 一次）：回前台/进好友分区即时拉齐——PC 建的群/发的消息
 *  无直推通道（手机无入站监听），全靠对账；60s 周期循环太钝，用户看屏的时机
 *  即是对账的时机（2026-09-28 双端深测「首条消息后 60-70s 才见群」的收窄）。 */
export function syncNowThrottled(minGapMs = 15_000): void {
  const now = Date.now()
  if (now - lastSyncAt < minGapMs) return
  lastSyncAt = now
  syncAllAccounts()
}

/** 会话级即时对账（2026-10-09 用户实测"群消息同步很慢"的 P0-1 修法）：
 *  按**会话目标集**展开对账对象——群 → 全部成员（`Group.members` 是账号 did 列表）+
 *  自己账号；单聊 → 该好友。
 *  此前 FriendsPanel 进会话时对群只传 `myDid`（`syncWithAccount(isGroup ? myDid : convId)`）
 *  → **群只对账到自己账号、漏掉其他群成员** → 停在群页面时其他成员的消息只能等
 *  60s 兜底环（`ensureP2pLoops`）才到。与 PC 侧 `chat_sync_now`（群展开全部成员）同构。 */
export async function syncNowForConv(convId: string, isGroup: boolean, myDid: string): Promise<void> {
  const targets = new Set<string>()
  if (isGroup) {
    const g = listGroups().find((x) => x.id === convId)
    for (const m of g?.members ?? []) if (m) targets.add(m)
    if (myDid) targets.add(myDid)
    const mine = myAccountDid()
    if (mine) targets.add(mine)
  } else if (convId) {
    targets.add(convId)
  }
  await Promise.all([...targets].map((a) => syncWithAccount(a).catch(() => 0)))
}

/** 会话页停留期轻量对账（2026-10-09 P0-2）：10s 节流档——代替"停着不动只能等 60s
 *  兜底环"。手机无入站推送、群正文不入信箱（msg.mjs 白名单），只能主动对账，
 *  故会话页打开期间必须有比 60s 更密的节拍。 */
let lastConvSyncAt = 0
export function syncNowForConvThrottled(convId: string, isGroup: boolean, myDid: string, minGapMs = 10_000): void {
  const now = Date.now()
  if (now - lastConvSyncAt < minGapMs) return
  lastConvSyncAt = now
  void syncNowForConv(convId, isGroup, myDid).catch(() => {})
}

// ══════════════ 2026-10-18 fast-ack：待发快速补发环 ══════════════
//
// 旧节奏：只有 60s 对账环 + 对端上线（syncWithAccount 发现 devs）才 flush——切网/
// 重连/回前台后可能要等一分钟（用户"发了半天"的另一半）。新环（与 PC
// offline_queue 补发环对称）：**前台 3s 起指数退避（3/6/12/24/48/60s）、后台 60s**；
// 回前台/网络恢复立即重置节奏补一轮（M9 ≤3s 自动补发）。每轮用**紧预算**投递
// （1.5s/目标、总 4s）——离线长队不会把一轮拖成分钟级。

let outboxAttempt = 0
let outboxNextAt = 0
let outboxBusy = false

async function retryOutboxRound(): Promise<void> {
  if (outboxBusy) return
  outboxBusy = true
  try {
    const fg = isForeground()
    const accts = await pendingAccounts()
    if (accts.length === 0) {
      outboxAttempt = 0
      outboxNextAt = Date.now() + 2_000 // 无 pending：2s 轻量复查（有 hint 才枚举）
      return
    }
    const budgeted: OutboxDeliver = (t, env) => p2pDeliver(t, env, { timeoutMs: 1_500, budgetMs: 4_000 })
    let sentN = 0
    for (const a of accts) {
      const s0 = Date.now()
      const sent = await flushAccount(a, budgeted)
      for (const it of sent) {
        updateSendState(it.convId, it.msgId, 'sent')
        chatTrace('deliver-ok', it.msgId, a, Date.now() - s0) // M9：send-ack ts → 本次补发成功 ts
        sentN += 1
      }
    }
    if (sentN > 0) emitSendStateChange()
    const still = await pendingAccounts()
    if (still.length === 0) {
      outboxAttempt = 0
      outboxNextAt = Date.now() + 2_000
      return
    }
    outboxNextAt = Date.now() + retryDelayMs(outboxAttempt, fg)
    outboxAttempt = Math.min(outboxAttempt + 1, 8)
  } catch {
    outboxNextAt = Date.now() + 5_000 // 异常退避（下一拍重试，不放大）
  } finally {
    outboxBusy = false
  }
}

/** 重置补发节奏（回前台/网络变化）：立即补一轮（M9 切网恢复 ≤3s 起）。 */
function kickOutboxRetry(): void {
  outboxAttempt = 0
  outboxNextAt = 0
}

/** 2026-10-18 fast-ack：有新失败消息入 outbox 时由发送侧调用——立即重置补发节奏
 *  （新消息不该排在旧长队的长退避窗口后面）。 */
export function kickOutboxRetryNow(): void {
  kickOutboxRetry()
}

/** 进程级后台循环（App 挂载时调一次）：60s 对账全部 ok 好友 + 20s presence state
 *  + 500ms 节拍检查待发补发（2026-10-18 fast-ack）。 */
export function ensureP2pLoops(): void {
  if (loopsStarted) return
  loopsStarted = true
  noteSyncDiag('loops-start', {})
  // presence state 上报（20s 周期兜底；typing/前后台切换走 reportPresenceNow 即时）
  void reportPresenceNow()
  setInterval(() => { void reportPresenceNow() }, 20_000)
  document.addEventListener('visibilitychange', () => {
    lastReportAt = 0 // 强制绕过自节流——前后台翻转必须立即上报（灯数据源）
    void reportPresenceNow()
    if (document.visibilityState === 'visible') {
      syncNowThrottled() // 回前台即拉齐（挂起恢复）
      kickOutboxRetry() // 回前台：待发立即补发（M9）
    }
  })
  if (typeof window !== 'undefined') {
    // 网络变化（断网恢复/切网）→ 立即补发（浏览器 online 事件）
    window.addEventListener('online', () => kickOutboxRetry())
  }
  // 待发补发环：500ms 节拍检查，到期才真投（无 pending 时零网络开销）
  setInterval(() => {
    if (Date.now() >= outboxNextAt) void retryOutboxRound()
  }, 500)
  // 对账循环（60s 兜底）：在线好友遇到即收敛
  setInterval(() => {
    lastSyncAt = Date.now()
    syncAllAccounts()
  }, 60_000)
}

export { convMetaKey, saveConvMeta, appendMsg }
