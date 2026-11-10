/**
 * dsh-open-runtime.ts — 「点卡就进」的**生产装配**：把 `dsh-open.ts` 的注入面接到
 * 真实的 identity / p2p / 原生壳上。
 *
 * 为什么要单独一层：`dsh-open.ts` / `share-entry.ts` 是纯逻辑（单测跑在 node 环境，
 * 没有 localStorage / WebView），一旦在那里 `import './identity'` 就会把整套
 * localStorage 迁移与 noble sha512 注册拖进单测。**装配放这里，逻辑放那边**。
 *
 * 对外：
 *   · `openTaskShare(payload)` —— 给 UI（任务卡点击）用；
 *   · `window.MycoDshShare` —— 给 adb / EnvServer 的 `eval` 用（真机取证通道）。
 */

import { currentIdentity, getRootIdentity, getAttestation, listPresence, signFriendHandshake, registerPresence, currentYoulingName, fetchPresenceByRoot, signAuthHeader, type PresenceAddrs } from './identity'
import { signWithDeviceKey } from './delegation'
import { ingestWireMsg, p2pDeliverWithReply, setRelayDeliver, setRelayDeliverReply, peerDevicesOf } from './p2p'
import { accountDidEq } from './didUtil'
import { relayCandidate } from './p2p-tunnel'
import { openSharedTask, prefetchShareEntry, makeSingleFlight, makeSerialQueue, openHttpTunnelSession, httpOverTunnel, type HttpTunnelSession, type OpenTaskDeps, type OpenTaskResult } from './dsh-open'
import { OPEN_RETRY_DELAYS_MS, isTransientOpenFailure, retryNote, finalOpenNote, retryTransient, pickHealTargets, withSourceDevice, waitUntil, type SourceDeviceState } from './open-retry'
import { removeTasksByShareId } from './chat-store'
import { clearRelayFail, noteRelayFail, relayFailFromNative } from './relay-fail'
import { effectiveInboundPorts, verifyVnetPeerRoster } from './vnet-inbound'
import {
  NativeProxyBridge,
  hasNativeProxy,
  installNativeBridge,
  nativeProxyDeps,
  nativeProxyGap,
  openShareInWebView,
  startLocalListener,
  stopLocalListener,
} from './native-proxy'
import {
  entryControlEnvelope,
  newControlMsgId,
  shareCardOf,
  type ControlSendResult,
  type ShareCard,
  type SourceAddrs,
} from './share-entry'
import { decideTunnelRoute, ReverseShareBridge, type NativeTapLike, type RouteDecision } from './p2p-tunnel'
import { DEFAULT_GW_PORT } from './share-entry'
import type { TunnelProxy } from './tunnel-session'

/** 当前活着的分享会话（离开页面时 stop——注意本地端口**保留**，见 `stopTaskShare`）。 */
let live: { proxy: TunnelProxy; card: ShareCard; bridge: ReverseShareBridge | null } | null = null

/**
 * 开卡在途护栏（2026-10-10 加固：**30s 超时自清**）。
 *
 * 原实现 `opening` 变量一旦因链路挂起永远非 null，后续所有开卡都被
 * `if (opening) return opening` 挡住——用户看到"点卡再也没反应"。现在
 * 单槽护栏带超时：到点复位 + 收掉半截会话（`stopTaskShare`）+ 代际 +1
 * （还在跑的迟到开卡经 `shouldAbort` 在碰共享状态前自我了断）。
 *
 * 2026-10-12 30s→75s：**自动重试 + 旧卡自愈的总预算必须装进这道护栏**，
 * 否则护栏会在半路把 gen+1、还在跑的自愈一进 `openTaskShareOnce` 就被
 * shouldAbort 掐死（真机实测：死地址卡 4 趟 ×10s/趟 + 退避 6s ≈ 42s 就
 * 撞了 30s 上限，拿到一句"打开超时"而自愈从未跑到）。75s = 4 趟×10s +
 * 退避 6s + 自愈 3 台×~8s + 余量；超时兜底文案不变（真死链路 75s 也能
 * 收口，单飞不会被挂死的旧问题不受影响）。
 */
const OPEN_TIMEOUT_MS = 75_000

/** 开卡代际：超时复位/更新的开卡启动时 +1；迟到任务据此判定自己已被取代。 */
let openGen = 0

const openFlight = makeSingleFlight({ timeoutMs: OPEN_TIMEOUT_MS })

/**
 * presence addrs 写入串行化（真机"反向路径页面白屏"根修）：
 * `stopTaskShare` 的清除（`{}`）与开卡的 wantReverse 注册都是 fire-and-forget
 * 的 HTTP——**乱序到达**时服务器按后到者生效，`{}` 后到会把意愿标记抹掉，
 * PC 拨号循环（10s 一拍，见 p2p_tunnel.rs reverse_dialer_tick）判 gone →
 * 撤空整个反向池 → 分享页扣着的浏览器连接饿死（页面永远白屏）。
 * 全部 addrs 写入经这一条队列排队，顺序即代码顺序。
 */
const presenceQueue = makeSerialQueue()

// ══════════════════ 原生 tap 单槽分发 + 反向桥缓存（2026-10-09 二开修复） ══════════════════
//
// 根因（真机"第二次打开会话列表为空"）：`NativeProxyBridge.onConn/onData/onClose`
// 是往模块级 `table` 里 **push**、没有退订；`ReverseShareBridge.stop()` 也不解绑。
// 原实现每次开卡都 `new ReverseShareBridge({tap: new NativeProxyBridge(), …})` →
// 第二次打开时，新旧两个桥**同时**收到每一条原生事件：旧桥（已 stop）会把新连接
// 重新嗅探/转直连/关连接，与新桥抢同一条 connId——字节双写、连接误关，页面加载
// 与 RPC 全乱（首次打开只有一个桥，所以是好的）。
//
// 运行时层兜住（不动 p2p-tunnel.ts / native-proxy.ts）：对原生 table 只**订阅一次**，
// 转手分发给"当前桥"单槽；换桥（新开卡/换源设备）时旧桥回调被自然顶掉，永不双投。

const nativeTap = new NativeProxyBridge()
const tapSlot: {
  conn: ((id: number) => void) | null
  data: ((id: number, d: Uint8Array) => void) | null
  close: ((id: number) => void) | null
} = { conn: null, data: null, close: null }
let tapWired = false
const sharedTap: NativeTapLike = {
  onConn(cb) {
    if (!tapWired) {
      tapWired = true
      nativeTap.onConn((id) => tapSlot.conn?.(id))
      nativeTap.onData((id, d) => tapSlot.data?.(id, d))
      nativeTap.onClose((id) => tapSlot.close?.(id))
    }
    tapSlot.conn = cb
  },
  onData(cb) {
    tapSlot.data = cb
  },
  onClose(cb) {
    tapSlot.close = cb
  },
  write(id, d) {
    nativeTap.write(id, d)
  },
  close(id) {
    nativeTap.close(id)
  },
}

/**
 * 反向桥按源设备缓存：同设备复用同一实例（`stop()` 清状态后实例可复用，新的
 * `TunnelProxy.start()` 会重接它的 tpConn/tpData/tpClose）；换设备才重建——
 * 旧实例的回调经单槽被顶掉，自然失活，不会再碰原生事件。
 */
let shareBridge: { bridge: ReverseShareBridge; expectDevice: string } | null = null

function shareBridgeFor(expectDevice: string): ReverseShareBridge {
  if (shareBridge && shareBridge.expectDevice === expectDevice) return shareBridge.bridge
  if (shareBridge) {
    try {
      shareBridge.bridge.stop()
    } catch {
      /* ignore */
    }
  }
  const bridge = new ReverseShareBridge({
    tap: sharedTap,
    expectDevice,
    // 2026-10-22 入向 vnet：本机账号（同账号设备可请求 22/3389/5555/9000 等普通端口）
    vnetAccount: (() => {
      try {
        return getRootIdentity() || getAttestation()?.rootDid || ''
      } catch {
        return ''
      }
    })(),
    // 2026-10-23 V21 手机入向隧道：端口开放集合（默认只开 5555；myco.inboundPorts
    // 可配，__mycoVnet.inbound(list) 运行时增删——acceptTunnel 每次求值，立即生效）
    // + 同账号放行的名册级归属校验（签名证明设备身份，账号归属查 /root 名册，fail-closed）。
    vnetPorts: effectiveInboundPorts,
    verifyVnetPeer: verifyVnetPeerRoster,
    onLog: (l) => console.log(l),
    // 扣住超时 = PC 没送来隧道（大概率在拨过期地址）——立即重报最新 addrs
    // （refreshSessionAddrsNow 自带 2s 节流，WebView 节流期的在带恢复信号）。
    onHoldTimeout: () => refreshSessionAddrsNow(),
  })
  bridge.wire()
  shareBridge = { bridge, expectDevice }
  return bridge
}

/**
 * 桥预创建（2026-10-14 移动直连修复）：app 启动/隧道启动时立即创建桥——
 * 不等 openTaskShare。原因：桥是 PC 反向连接的唯一处理器；冷启动后桥不存在
 * → PC 连接无人处理 → 取票/数据全断 → open 卡死 30s → JS 阻塞循环。
 * 幂等：同设备已建桥则跳过。
 */
export function ensureBridgeFor(expectDevice: string): void {
  try {
    shareBridgeFor(expectDevice)
  } catch {
    /* 预创建失败不阻塞启动 */
  }
}

/** 上次分享的源设备（localStorage 持久化键——冷启动桥预创建的输入）。 */
const LAST_SOURCE_DEVICE_KEY = 'myco.dsh.lastSourceDevice'

function persistLastShareSourceDevice(device: string): void {
  try {
    localStorage.setItem(LAST_SOURCE_DEVICE_KEY, device)
  } catch {
    /* 私有模式/满盘：预创建降级为仅本次会话 */
  }
}

function readLastShareSourceDevice(): string | null {
  try {
    return localStorage.getItem(LAST_SOURCE_DEVICE_KEY)
  } catch {
    return null
  }
}

/**
 * 真机取证用的**寻址/端口覆盖**（只在显式设置时生效；生产路径一个字都不改）。
 *
 * 为什么需要它：手机上的端到端验证要用一台"源设备"配合，而 PC 侧跑的那个实例
 * 可能是旧构建（没有 `/p2p/tunnel` 路由）。把源设备地址与 p2p 数据面端口做成可覆盖，
 * 就能用一台**线协议等价**的对端做真机验证，而不必改一行生产逻辑。
 */
export interface DebugOverride {
  addrs?: SourceAddrs
  /** 兜底传输要打的源设备 p2p 数据面端口（生产取 presence 上报的 `addrs.port`）。 */
  p2pPort?: number
}

let debugOverride: DebugOverride | null = null

/** 设置/清除真机取证覆盖（`null` = 清除）。 */
export function setDebugOverride(o: DebugOverride | null): void {
  debugOverride = o
}

/**
 * 本机隧道身份（账号/设备/签名）。身份未就绪 → null（上层给人话）。
 *
 * 账号 did 的三级兜底（**真机踩过**）：`vault.rootDid` → `attestation.rootDid` →
 * 设备 did。手机上常常只做了"设备已收编"（有 attestation）、没有 rootSeed，
 * 这时 `getRootIdentity()` 是空的——若就这么发出去，服务端的归属闸会拿**设备 did
 * 当账号**去比，必然拒（"签名设备不属于声称的账号"）。
 */
export function tunnelIdentity(): { account: string; device: string; sign: (m: string) => Promise<string | null> } | null {
  const device = currentIdentity()?.did ?? ''
  if (!device) return null
  const account = getRootIdentity() || getAttestation()?.rootDid || device
  return {
    account,
    device,
    // 与 `identity.ts:961 signAuthHeader` 同式（did\nts\nbody 由调用方拼好）；
    // 这里用设备钥直接签隧道材料 `did\nts\n握手原文`。
    sign: (m: string) => {
      const sync = signFriendHandshake(m)
      return sync ? Promise.resolve(sync) : signWithDeviceKey(m)
    },
  }
}

/** 身份就绪的等待上限（真机实测：app 从后台冻结被唤醒后约 5 秒才就绪）。 */
export const IDENTITY_WAIT_MS = 6000

/**
 * 等身份就绪（已就绪立刻返回，零等待）。
 *
 * 就绪判据 = `tunnelIdentity()` 非空（设备 did 有了 + 账号 did 的三级兜底取到了）——
 * 这与取票签名、隧道握手用的是同一份材料，所以它非空就等于"能签得动"。
 *
 * 2026-10-16 真案：手机 app 从后台冻结被唤醒时，WebView 的 JS 先恢复、身份后加载完。
 * 那一刻点卡会立刻发取票请求，签名材料还没就绪 → 源设备那道签名闸把请求挡在签票
 * 逻辑之前（PC 侧审计里连一条记录都没有）→ 用户看到"在线但连不上"，四趟重试白等
 * 40 多秒，重启 app 立刻就好。取票前等一下（最多 6 秒），比失败后重试便宜得多。
 */
async function waitForIdentityReady(): Promise<ReturnType<typeof tunnelIdentity>> {
  const waited = await waitUntil(() => tunnelIdentity() !== null, { timeoutMs: IDENTITY_WAIT_MS, pollMs: 200 })
  if (waited === null) {
    console.log(`[dsh-open] 身份未就绪，等了 ${IDENTITY_WAIT_MS}ms 仍没好（冷启动/解冻）`)
    return null
  }
  console.log(`[dsh-open] 身份未就绪，等了 ${waited}ms 才就绪（多半刚从后台解冻）——已放行取票`)
  return tunnelIdentity()
}

/**
 * 源设备的寻址候选来源。
 *
 * 优先用 presence 的 `addrs`（`{lan/lanList, publicV4/publicV4List, reflexive/reflexiveList,
 * ipv6/ipv6List, port}`——与 PC 端 `LocalCandidates::addrs_json` 同形状）；
 * 找不到就 null（上层给人话"不在线"）。
 */
export async function sourceAddrsOf(deviceDid: string): Promise<SourceAddrs | null> {
  if (debugOverride?.addrs) return debugOverride.addrs
  const list = await listPresence().catch(() => [])
  const hit = list.find((p) => p.did === deviceDid)
  if (!hit) return null
  const a = (hit.addrs ?? {}) as unknown as SourceAddrs
  const hasAny =
    (a.lanList?.length ?? 0) +
      (a.publicV4List?.length ?? 0) +
      (a.reflexiveList?.length ?? 0) +
      (a.ipv6List?.length ?? 0) >
      0 || !!a.lan || !!a.publicV4 || !!a.reflexive || !!a.ipv6
  return hasAny ? a : null
}

/**
 * **provider A**：把 `share-entry-request` 直推给源设备，并**读回响应体**。
 *
 * 手机推不到回包（没有入站监听能力），所以源设备把回包挂进 `POST /p2p/msg` 的
 * HTTP 响应体（`reply` 键）——这条连接本来就开着在等响应，一次往返拿到票。
 * 源设备是旧版本（没有 `reply`）→ `reply:null`，上层回落到既有 P2P 回推等待。
 */
function makeSendControl(card: ShareCard) {
  return async (kind: string, payload: Record<string, unknown>): Promise<ControlSendResult> => {
    const now = Date.now()
    const env = entryControlEnvelope(
      {
        account: getRootIdentity() ?? getAttestation()?.rootDid ?? currentIdentity()?.did ?? '',
        device: currentIdentity()?.did ?? '',
        name: currentYoulingName() || '好友',
        deviceName: 'myco-phone',
      },
      card.sourceAccount,
      kind,
      payload,
      newControlMsgId(now),
      now,
    )
    const resp = await p2pDeliverWithReply(card.sourceAccount, env, card.sourceDevice)
    if (!resp) return { delivered: false }
    const reply = resp.reply
    return {
      delivered: true,
      reply: reply && typeof reply === 'object' && !Array.isArray(reply) ? (reply as Record<string, unknown>) : null,
    }
  }
}

/** 组装生产依赖（可在测试里替换字段）。 */
export function makeOpenTaskDeps(overrides: Partial<OpenTaskDeps> = {}): OpenTaskDeps {
  const id = tunnelIdentity()
  const { factory, bridge } = nativeProxyDeps()
  const identity = id ?? { account: '', device: '', sign: async () => null }
  return {
    myAccount: id?.account ?? '',
    myDevice: id?.device ?? '',
    identity,
    sourceAddrs: sourceAddrsOf,
    startListener: startLocalListener,
    stopListener: stopLocalListener,
    openWebView: (url, title) => openShareInWebView(url, title),
    factory,
    bridge,
    onLog: (l) => console.log(l),
    p2pPort: debugOverride?.p2pPort,
    ...overrides,
  }
}

/**
 * 聊天投递的中继兜底装配（2026-10-12"直连优先、不通走中转"——与 DSH web 分享
 * 链路同构）。在 app 引导时调一次。
 *
 * 通路复用分享的隧道设施：`relayCandidate(对端设备did)`（8321 mux 的 WS 隧道）
 * + `tunnelHttpRequest`（一条隧道一次 HTTP，目标端口 **9100**——PC 侧隧道
 * 白名单 TUNNEL_DEFAULT_PORTS 本就含 9100"好友设备可经隧道调用我方 /p2p/* 数据面"，
 * 同账号隧道授权放行）——等于把 PC 的 p2p/msg 面从"仅直连"扩成"直连⊥中继"。
 *
 * 方向说明（诚实边界）：这只解决**手机 → 对端**（手机当 consumer）；反向
 * （PC → 手机）需要手机在云中继注册 provider（裸 TCP 长连+心跳——浏览器 JS
 * 做不了，要 android-shell 的 Java 层，下一步）。
 */
export function wireChatRelayFallback(): void {
  setRelayDeliver(async (accountDid, envelope) => {
    // 聊天投递**不记**失败留痕（record:false）：那份留痕是给"点卡取票"的收摊文案用的，
    // 聊天在后台悄悄失败一次就把取票的真因顶掉了，反而更难查。
    const r = await relayDeliverOnce(accountDid, envelope, undefined, { record: false })
    return r !== null
  })
  // 2026-10-14 取票中继兜底（真机异网破案：点卡"源设备不在线"根因——取票只走
  // 直推）。同一条帧内 HTTP，响应体的 reply（票据）一并带回。
  setRelayDeliverReply(async (accountDid, envelope, preferDevice) => relayDeliverOnce(accountDid, envelope, preferDevice))
}

/**
 * 中继投递一次（定向源设备优先），成功返回响应体对象（含 reply），失败 null。
 *
 * 2026-10-16：失败**不再静默**——每一台的失败归因都进 `relay-fail` 留痕（只记第一台，
 * 即源设备那台），收摊文案据此说人话。原来这里 `catch {}` 一吞，四种完全不同的物理
 * 原因（中继卡槽满 / 中继里没这台设备 / 签名没过 / 超时）在两侧日志里都是空白。
 */
/**
 * 聊天中继**隧道会话缓存**（2026-10-20：手机→PC 每条 3.3s → 目标 100-300ms）。
 *
 * 旧实现每条消息 openTunnel 一次（CONNECT+pair+加密握手，公网 p50 ~124ms pair + 握手开销），
 * 10 条消息均匀 3.3s。这里按目标设备缓存 `HttpTunnelSession`，keep-alive 复用：
 *   · 90s 空闲或会话已关 → 丢弃重建；
 *   · 单条失败 → 销毁缓存（下条重建，避免坏连接连累后续消息）。
 */
const CHAT_RELAY_SESSION_TTL_MS = 90_000
const chatRelaySessions = new Map<string, { session: HttpTunnelSession; lastUsed: number }>()

/** 同账号设备清单缓存（2026-10-20）：`peerDevicesOf` 走云端名册，实测每条消息 ~2.5-3s，
 *  是中继投递剩余时延的主项；名册变化不频繁，缓存 180s + 单飞（并发只查一次）。 */
const PEER_CACHE_TTL_MS = 180_000
/** presence 超时/失败得到的空清单只短缓存：不能把一次 identity 卡顿放大成 3 分钟“无设备”。 */
const PEER_CACHE_EMPTY_TTL_MS = 5_000
type PeerCacheEntry = { at: number; account: string; ttl: number; devs: Awaited<ReturnType<typeof peerDevicesOf>> }
let peerCache: PeerCacheEntry | null = null
let peerInflight: Promise<Awaited<ReturnType<typeof peerDevicesOf>>> | null = null

function peerCacheTtl(devs: Awaited<ReturnType<typeof peerDevicesOf>>): number {
  return devs.length ? PEER_CACHE_TTL_MS : PEER_CACHE_EMPTY_TTL_MS
}
export function _peerCacheTtlForTest(devs: Awaited<ReturnType<typeof peerDevicesOf>>): number {
  return peerCacheTtl(devs)
}

async function peerDevicesCached(accountDid: string): Promise<Awaited<ReturnType<typeof peerDevicesOf>>> {
  const now = Date.now()
  if (peerCache && peerCache.account === accountDid && now - peerCache.at < peerCache.ttl) {
    return peerCache.devs
  }
  if (peerInflight) return peerInflight
  peerInflight = peerDevicesOf(accountDid)
    .then((devs) => {
      peerCache = {
        at: Date.now(),
        account: accountDid,
        ttl: peerCacheTtl(devs),
        devs,
      }
      return devs
    })
    .catch(() => [] as Awaited<ReturnType<typeof peerDevicesOf>>)
    .finally(() => {
      peerInflight = null
    })
  return peerInflight
}

function dropChatRelaySession(key: string): void {
  const ent = chatRelaySessions.get(key)
  if (!ent) return
  chatRelaySessions.delete(key)
  try {
    ent.session.socket.close(1000, 'chat-relay-reset')
  } catch {
    /* 已断 */
  }
}

async function chatRelayPost(
  identity: { account: string; device: string; sign: (m: string) => Promise<string | null> },
  factory: ReturnType<typeof nativeProxyDeps>['factory'],
  did: string,
  req: { method: 'POST'; path: string; headers: Record<string, string>; body: string },
): Promise<Record<string, unknown> | null> {
  const key = did.toLowerCase()
  let ent = chatRelaySessions.get(key)
  if (ent && (ent.session.closed || Date.now() - ent.lastUsed > CHAT_RELAY_SESSION_TTL_MS)) {
    dropChatRelaySession(key)
    ent = undefined
  }
  try {
    let reused = false
    if (!ent) {
      const t0 = Date.now()
      const session = await openHttpTunnelSession(relayCandidate(did), 9100, identity, factory, { timeoutMs: 8000 })
      ent = { session, lastUsed: Date.now() }
      chatRelaySessions.set(key, ent)
      console.log('[chat-relay] 新建中继隧道 …' + did.slice(-4) + ' ' + (Date.now() - t0) + 'ms')
    } else {
      reused = true
    }
    ent.lastUsed = Date.now()
    const tReq = Date.now()
    const resp = await httpOverTunnel(ent.session, req, { timeoutMs: 6000, host: '127.0.0.1', keepAlive: true })
    console.log('[chat-relay] ' + (reused ? '复用' : '新建') + ' POST ' + (Date.now() - tReq) + 'ms status=' + resp.status)
    if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`)
    try {
      return JSON.parse(resp.body) as Record<string, unknown>
    } catch {
      return null
    }
  } catch {
    dropChatRelaySession(key)
    return null
  }
}

async function relayDeliverOnce(
  accountDid: string,
  envelope: Record<string, unknown>,
  preferDevice?: string,
  opts: { record?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  // 默认记（取票路径）；聊天投递显式关掉（见 wireChatRelayFallback 注释）。
  const record = opts.record !== false
  const note = (f: ReturnType<typeof relayFailFromNative>): void => {
    if (record) noteRelayFail(f)
  }
  const id = tunnelIdentity()
  if (!id) {
    note({ why: 'auth', note: '本机身份还没就绪，签名没通过——重启一次 myco 再点', detail: 'tunnelIdentity() = null' })
    return null
  }
  const { factory } = nativeProxyDeps()
  // 定向：preferDevice（源设备 did）优先且必试；其余同账号设备作次选。
  const devs = await peerDevicesCached(accountDid)
  const targets: string[] = []
  if (preferDevice) {
    const hit = devs.find((d) => accountDidEq(d.did, preferDevice))
    if (hit) targets.push(hit.did)
  }
  const relayDid = preferDevice ?? ''
  if (relayDid && !targets.includes(relayDid)) targets.unshift(relayDid)
  for (const d of devs) if (!targets.includes(d.did)) targets.push(d.did)
  const raw = JSON.stringify(envelope)
  // 2026-10-20 DSH协议应用 需求：聊天 relay 失败不再静默（原来 record:false），
  // 轻量留痕（**不含消息内容**），供 matrix 按 msgId 对齐服务端 notFound/paired。
  // 行格式与 PC 端一致：[chat-trace] {"ev":"relay-ok|relay-fail","msgId":...,"target":"…后4位","why":...,"ms":...}
  const relayMsgId = String((envelope as { msgId?: unknown }).msgId ?? '')
  const relayTrace = (ev: string, did: string, extra: Record<string, unknown>): void => {
    try {
      console.log('[chat-trace] ' + JSON.stringify({ ev, msgId: relayMsgId, target: '…' + did.slice(-4), ...extra }))
    } catch { /* trace 失败不影响投递 */ }
  }
  const relayT0 = Date.now()
  let auth = ''
  try {
    auth = signAuthHeader(raw)
  } catch (e) {
    note(relayFailFromNative(e instanceof Error ? e.message : String(e)))
    return null
  }
  for (const did of targets.slice(0, 3)) {
    try {
      // 2026-10-20：走**复用会话**（keep-alive），不再每条消息重建隧道。
      const body = await chatRelayPost(
        { account: id.account, device: id.device, sign: id.sign }, factory, did,
        { method: 'POST', path: '/p2p/msg', headers: { 'X-Myco-Auth': auth }, body: raw },
      )
      if (body && body.ok) {
        relayTrace('relay-ok', did, { ms: Date.now() - relayT0 })
        return body
      }
      if (body) {
        // 200 但 ok:false = 源设备数据面明确回绝（带理由）——那是给用户看的最好一句话
        const err = typeof body.error === 'string' ? body.error : ''
        note({ why: 'denied', note: err, detail: `HTTP 200 ok:false ${err}` })
        relayTrace('relay-fail', did, { ms: Date.now() - relayT0, why: 'denied', detail: err.slice(0, 120) })
      } else {
        note({ why: 'other', note: '', detail: '中继会话无可解析响应（已丢弃重建）' })
        relayTrace('relay-fail', did, { ms: Date.now() - relayT0, why: 'other', detail: 'no-parsable-body' })
      }
    } catch (e) {
      // 原生隧道层的中继应答（BUSY/NOT_FOUND/UNAVAILABLE）都在异常文本里——归因后留痕，
      // 再试下一台设备（对端多设备时逐台试）。
      const f = relayFailFromNative(e instanceof Error ? e.message : String(e))
      note(f)
      relayTrace('relay-fail', did, { ms: Date.now() - relayT0, why: f.why, detail: String(f.detail || '').slice(0, 120) })
      console.log(`[dsh-open] 中继腿失败（…${did.slice(-4)}）：${f.detail || f.why}`)
    }
  }
  return null
}

/** 打开结果的**人话**摘要（UI 直接显示）。 */
export type OpenSummary =
  | { ok: true; url: string; localPort: number; ms: number; via: string }
  | { ok: false; message: string; reason?: string; attempts?: number }

/** 开卡进度回调（UI 用它把"正在重试…"摆到卡片下面；不传就静默重试）。 */
export type OpenNoteFn = (text: string) => void
export type OpenTaskShareOpts = { onNote?: OpenNoteFn }

/** 「在浏览器中打开」用的 openWebView 覆盖（见 resolveShareUrlForBrowser；
 *  单飞护栏下无并发）。 */
let webViewOverride: ((url: string, title: string) => boolean) | null = null

// ══════════════════ 反向连接装配（2026-10-09：PC 主动连手机） ══════════════════
//
// 拓扑事实（实测）：手机 → PC 的 TCP 被家宽光猫拦（入站无五元组记录一律丢）；
// PC → 手机的 IPv6 直连通（移动网络放行入站）。所以数据面可以**反向**：
// PC 从 presence 查到手机上报的 `addrs{ipv6List, port, wantReverse}`，主动拨过来；
// 手机这边 `TunnelProxyServer` 已绑 `[::]` 接受入站，`ReverseShareBridge` 按首行
// 嗅探区分"浏览器连接 / 反向隧道入站"，后者走 `acceptTunnel` 服务端角色（验签 +
// 预期源设备闸 + 端口白名单 + nonce 去重），过闸的隧道进池，等浏览器连接来胶合。
//
// 连接决策（`decideTunnelRoute`，纯函数、单测锁定）：
//   LAN 直连 → B 直连 A（现有路径）→ A 反向连 B（新路径）→ 人话错误。
// 运行时按状态翻转：直连赛跑全挂（TunnelProxy 进 degraded）→ `setMode('reverse')`，
// 浏览器下一次重连就走反向池。

/** 从原生 `tunnelState()` 快照里抠本机全球 IPv6（Java 侧 `ipv6=[a|b|…]` 追加）。 */
export function shellTunnelIpv6(rawTunnelState: string): string[] {
  const m = /ipv6=\[([^\]]*)\]/.exec(rawTunnelState)
  if (!m) return []
  return m[1]
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** 反向意愿上报的 addrs（会话活着的标志——PC 侧拨号循环看到它才拨）。 */
export function reverseWantAddrs(ipv6: string[], listenPort: number, wantPort = DEFAULT_GW_PORT): PresenceAddrs {
  return {
    ipv6: ipv6[0],
    ipv6List: ipv6,
    port: listenPort,
    wantReverse: wantPort,
  }
}

// ══ 会话期 addrs 刷新（2026-10-10 断线重连修复：IPv6 前缀轮换） ══
//
// 事实链：电信移动网络 IPv6 前缀一天轮换多次（471→473→…）；presence 的 addrs
// 原本只在开卡（wrappedStart）时上报一次 → 轮换后服务器上的是过期地址 →
// PC 拨旧地址必超时 → "刚才还通，后来又断了"。会话活着期间每 5s 重报最新
// IPv6（经 presenceQueue 与 stopTaskShare 的清除严格有序）；PC 侧拨号循环
// 1s 一拍重查 presence（无缓存）→ 新地址最迟 ~6s 进入拨号清单，已断的连接
// 由浏览器重连驱动自然恢复。
/** 会话监听端口（wrappedStart 记下——刷新 addrs 要带它；proxy 没有 localPort getter）。 */
let sessionListenPort: number | null = null
/** 会话期 addrs 刷新循环句柄。 */
let addrsRefreshTimer: ReturnType<typeof setInterval> | null = null
/** 上次上报的 IPv6 集合指纹（轮换检测/日志）。 */
let lastReportedIpv6Key = ''
/** addrs 刷新自节流（5s 周期 + 事件触发的立即刷新共用，2s 内不重复入队）。 */
let lastAddrsRefreshAt = 0

/** 立即重报一次最新 addrs（会话活着才做；节流 2s）。 */
function refreshSessionAddrsNow(): void {
  if (!live) return
  const now = Date.now()
  if (now - lastAddrsRefreshAt < 2000) return
  lastAddrsRefreshAt = now
  const port = sessionListenPort
  const ipv6 = shellTunnelIpv6(shellTunnelState())
  if (ipv6.length === 0 || port == null) return
  const key = ipv6.join(',')
  if (key !== lastReportedIpv6Key) {
    if (lastReportedIpv6Key !== '') {
      console.log(`[dsh-open] IPv6 前缀轮换 detected（${lastReportedIpv6Key} → ${key}）——重报 presence`)
    }
    lastReportedIpv6Key = key
  }
  presenceQueue(() => registerPresence('myco-phone', 'active', reverseWantAddrs(ipv6, port)))
}

/** 起会话期 addrs 刷新循环（幂等）。 */
function startAddrsRefresh(): void {
  stopAddrsRefresh()
  addrsRefreshTimer = setInterval(() => {
    if (!live) {
      stopAddrsRefresh()
      return
    }
    refreshSessionAddrsNow()
  }, 5_000)
}

/** 停会话期 addrs 刷新循环（stopTaskShare 调；幂等）。 */
function stopAddrsRefresh(): void {
  if (addrsRefreshTimer !== null) {
    clearInterval(addrsRefreshTimer)
    addrsRefreshTimer = null
  }
}

/**
 * 「点卡就进」的生产入口。
 *
 * 双击/连点护栏（真机"双击后黑屏"排查项）：同一时刻只允许一条开卡在途——
 * 否则两次并发 `openTaskShare` 会互相 `stopTaskShare` 拆对方的端口/隧道，
 * 再叠出两个 ShareWebActivity。第二次点击直接复用第一次的 Promise。
 * 2026-10-10：护栏带 30s 超时自清（链路挂起不再永久挡门，见 openFlight 注释）。
 *
 * @param raw 任务卡 payload（含 `shareId` + `sourceDevice`；好友任务卡没有这两项 → 拒绝）
 */
export function openTaskShare(raw: Record<string, unknown>, opts: OpenTaskShareOpts = {}): Promise<OpenSummary> {
  return openFlight(
    () => openTaskShareWithRetry(raw, opts),
    () => {
      // 超时复位：代际 +1（迟到开卡经 shouldAbort 自我了断）+ 收掉半截会话
      openGen += 1
      stopTaskShare()
      console.log('[dsh-open] 开卡 30s 未竟——已复位（可再点一次）')
      return { ok: false, message: '打开超时（超过 30 秒），已重置——请再点一次试试', reason: 'offline' }
    },
  )
}

/**
 * 取票**带自动重试**的外壳（2026-10-12，用户报"显示在线却说设备不在线"那一轮）。
 *
 * 为什么在这层重试而不是在 dsh-open 内部重发一次请求：一次瞬时失败的物理原因有四种
 *   · 源设备进程刚重启（P2P 监听 + 云端中继注册一起消失几秒）
 *   · 中继里的注册还没回来（REGISTER 是长连接 + 30s 心跳）
 *   · 手机在切网（WiFi↔蜂窝，旧候选全废）
 *   · 反向隧道池还没热身
 * 这四种都要求**重建整条装配**（候选表/桥/本地端口/在飞请求），所以整趟 `…Once` 重跑，
 * 而不是只把某一条腿的 fetch 再发一遍。非瞬时失败（拒绝/过期/入口坏了）一次就收摊。
 */
async function openTaskShareWithRetry(raw: Record<string, unknown>, opts: OpenTaskShareOpts): Promise<OpenSummary> {
  const card = shareCardOf(raw)
  const deviceName = card?.sourceDeviceName
  const total = OPEN_RETRY_DELAYS_MS.length + 1
  const { value: firstValue, attempts } = await retryTransient<OpenSummary>(
    (attempt) => openTaskShareOnce(raw).then((r) => {
      if (!r.ok) {
        console.log(`[dsh-open] 第 ${attempt} 趟失败（${r.reason ?? '?'}：${r.message}）`)
      }
      return r
    }),
    {
      delays: OPEN_RETRY_DELAYS_MS,
      isTransient: (r) => (r.ok ? false : isTransientOpenFailure(r.reason)),
      onRetry: (next, totalAttempts) => {
        opts.onNote?.(retryNote(deviceName, next, totalAttempts))
        console.log(`[dsh-open] 距下一趟（第 ${next}/${totalAttempts} 次）等 ${OPEN_RETRY_DELAYS_MS[next - 2]}ms`)
      },
    },
  )
  let last = firstValue
  if (last.ok) return last
  const { state: source, rows } = await sourceStateOf(card?.sourceDevice, card?.sourceAccount)
  // ①-自愈（2026-10-12）：卡上的来源设备**已不在名册**（换过绑定/改名）→ 换一台在线的
  // 同伴设备去问一遍。取票请求本身不带目标，托管的设备会应答、不托管的回"已经不在了"
  // ——谁托管谁应答。只在"记录确已失效"这条路走，正常路径一个字不改。
  if (source === 'gone' && isTransientOpenFailure(last.reason) && card) {
    const myDev = tunnelIdentity()?.device ?? ''
    for (const t of pickHealTargets(rows, card.sourceDevice, myDev)) {
      const label = t.name && t.name.trim() ? t.name.trim() : `…${t.did.slice(-4)}`
      opts.onNote?.(`原来源设备记录已失效，正在改问「${label}」…`)
      console.log(`[dsh-open] 旧卡自愈：来源 ${card.sourceDevice.slice(-6)} 不在名册 → 改问 ${t.did.slice(-6)}`)
      const healed = await openTaskShareOnce(withSourceDevice(raw, t.did, t.name))
      if (healed.ok) return healed
      last = healed
    }
  }
  return {
    ok: false,
    reason: last.reason,
    attempts,
    message: finalOpenNote({ deviceName, message: last.message, reason: last.reason, attempts: Math.min(attempts, total), source }),
  }
}

/** 名册缓存（15s）：只在失败收摊时查一次，正常路径零额外往返。 */
let rosterAt = 0
let rosterRows: { did: string; name?: string; online?: boolean; revoked?: boolean }[] | null = null

/**
 * 源设备在**名册**里的状态（收摊文案 + 旧卡自愈用，2026-10-12）。
 *
 * 为什么只对"我自己账号的设备"下判断：名册（`/presence/by-root`）按**根账号**查，
 * 好友分享的卡不在我的名册里——那时"没查到"只说明我管不着，不说明记录失效，所以
 * 一律回 `unknown`（文案退回"暂时连不上"，自愈也不走），绝不乱下"已失效"的结论。
 *
 * 2026-10-12 二修（真机 E2E 抓的）：账号比较串不能只用 `getRootIdentity()`——
 * **成员设备**（设备钥+委任状路径，本机 DD9F 就是）的 vault 里没有 rootDid，返回
 * null → 全部判 unknown → 自愈永远不触发。改用与 `tunnelIdentity().account` 同源
 * 的回退链（root vault → attest 的 rootDid），并落一行判定日志（尾 4 对齐，方便
 * 对时间线；这行日志就是上一轮"自愈没触发"排障时缺失的眼睛）。
 */
async function sourceStateOf(
  deviceDid: string | undefined,
  sourceAccount: string | undefined,
): Promise<{ state: SourceDeviceState; rows: { did: string; name?: string; online?: boolean; revoked?: boolean }[] }> {
  const did = (deviceDid || '').trim()
  const me = getRootIdentity() || getAttestation()?.rootDid || ''
  const src = (sourceAccount || '').trim()
  if (!did || !me || src !== me) {
    console.log(`[dsh-open] 名册判定跳过：me=${me ? '…' + me.slice(-4) : '无'} source=${src ? '…' + src.slice(-4) : '无'}`)
    return { state: 'unknown', rows: [] }
  }
  try {
    const now = Date.now()
    if (!rosterRows || now - rosterAt > 15_000) {
      rosterRows = await fetchPresenceByRoot(me)
      rosterAt = now
    }
    const rows = rosterRows || []
    const row = rows.find((r) => r.did === did)
    const state: SourceDeviceState = !row ? 'gone' : row.online ? 'online' : 'offline'
    console.log(`[dsh-open] 名册判定：…${did.slice(-4)}=${state}（名册 ${rows.length} 台，在线 ${rows.filter((r) => r.online).length}）`)
    return { state, rows }
  } catch (e) {
    console.log(`[dsh-open] 名册查询失败（${e instanceof Error ? e.message : String(e)}）→ unknown`)
    return { state: 'unknown', rows: [] }
  }
}

async function openTaskShareOnce(raw: Record<string, unknown>): Promise<OpenSummary> {
  // 2026-10-20（用户追加指标）：返回列表后再点同一张卡 → 直接复用仍活着的分享页（<1s）。
  try {
    const card = (raw && (raw.card || raw)) as Record<string, unknown>
    const shareId = typeof card.shareId === 'string' ? card.shareId : ''
    const bridge = (window as unknown as { MycoShell?: { reuseSharePage?: (id: string) => string } }).MycoShell
    if (shareId && bridge?.reuseSharePage) {
      const reuseRes = bridge.reuseSharePage(shareId)
      if (reuseRes === 'OK') {
        console.log('[dsh-open] 复用已打开的分享页（返回再开）')
        console.log('[dsh-open] 状态=open 已连接源设备（复用页面）')
        return { ok: true, url: 'reused', localPort: 0, ms: 0, via: 'reuse' }
      }
      console.log('[dsh-open] 复用未命中: ' + reuseRes + '（走完整打开流程）')
      if (reuseRes === 'STALE') console.log('[dsh-open] 旧页面隧道已死 → 走全新打开重建隧道')
    }
  } catch {
    /* 复用是纯优化：失败继续走完整打开流程 */
  }
  const gen = openGen
  const card = shareCardOf(raw)
  if (!card) {
    return { ok: false, message: '这张卡没有可打开的分享信息（可以让对方重新分享一次）', reason: 'internal' }
  }
  const gap = hasNativeProxy() ? null : nativeProxyGap()
  if (gap) return { ok: false, message: gap, reason: 'unsupported' }

  // 这一趟取票的中继腿失败留痕清空（每趟一份，收摊文案取"第一次"= 源设备那台）。
  clearRelayFail()

  // 身份就绪**等一下**再开卡（2026-10-16 真案）：app 从后台冻结被唤醒时 JS 已恢复但
  // 身份还没加载完，此刻取票的签名过不了源设备那道闸——PC 侧连审计都没有（请求没走到
  // 签票逻辑），用户只看到"在线但连不上"，四趟重试白等 40 多秒。等最多 6 秒（实测解冻
  // 后约 5 秒就绪），比失败重试便宜得多；真等不到再如实说"身份没就绪"，不糊弄成"设备不在线"。
  const id = tunnelIdentity() ?? (await waitForIdentityReady())
  if (!id) {
    return {
      ok: false,
      message: `本机身份等了 ${IDENTITY_WAIT_MS / 1000} 秒还没就绪——把 myco 切到前台等它连上，或重启一次再点`,
      reason: 'unsupported',
    }
  }

  // 桥先于一切 presence 上报建好（2026-10-10 openTaskShare 死锁修复）：PC 拨号
  // 循环看到 wantReverse 就可能立刻拨过来，桥不存在 = 反向入站无人处理 = 取票
  // fetch（走本地监听 → 桥 → 反向池）挂死 = openTaskShare 卡满 30s。原先桥在
  // openSharedTask 之前才建（下方 shareBridgeFor 行），现在提前到这里 + 冷启动
  // 预创建（installTaskShare）双保险；shareBridgeFor 幂等，同设备不重建。
  ensureBridgeFor(card.sourceDevice)
  persistLastShareSourceDevice(card.sourceDevice)

  // 上一次的会话先收掉（本地端口保留——`stopTaskShare` 头注释，origin 稳定是
  // "第二次打开还能落回分享会话"的前提）。keepPresence：不要在这次收尾里清
  // wantReverse——下面 wrappedStart 马上重报（端口不变），中间清一次会让 PC
  // 拨号循环撤池一拍（饥饿窗口），见 stopTaskShare 尾注释。
  stopTaskShare({ keepPresence: true })

  // 反向桥：原生 tap ↔ TunnelProxy 之间的嗅探/池/胶合层（浏览器连接走直连照旧，
  // PC 拨来的 /p2p/tunnel 入站走服务端角色；degraded 时浏览器连接改扣等反向隧道）。
  // 2026-10-09：经 `sharedTap` 单槽取桥——旧桥不再与新桥双投原生事件（二开
  // 会话为空的根因之一）；每次开卡从 auto 起步，上次 degraded 翻成的 reverse
  // 不带到新会话。
  const bridge = shareBridgeFor(card.sourceDevice)
  bridge.setMode('auto')
  let routeLogged = false
  const logRouteOnce = (sourceReachable: boolean): void => {
    if (routeLogged) return
    routeLogged = true
    const ipv6 = shellTunnelIpv6(shellTunnelState())
    const d: RouteDecision = decideTunnelRoute({ sameSubnet: false, sourceReachable, selfInbound: ipv6.length > 0 }, card.sourceDeviceName ?? '对方设备')
    console.log(`[dsh-open] 连接决策：${d.mode}${d.mode === 'none' ? `（${d.message}）` : `（${d.why}）`}`)
  }
  const wrappedStart = async (): Promise<number> => {
    const port = await startLocalListener()
    // 上报本机可达地址（反向连接的寻址源 + 意愿标记；服务器 addrs 粘性，离开时显式清。
    // ⚠️ 必须经 presenceQueue 排队——与 stopTaskShare 的清除严格有序，乱序=意愿被抹=反向饥饿）
    const ipv6 = shellTunnelIpv6(shellTunnelState())
    sessionListenPort = port
    lastReportedIpv6Key = ipv6.join(',')
    lastAddrsRefreshAt = Date.now()
    if (ipv6.length > 0) {
      presenceQueue(() => registerPresence('myco-phone', 'active', reverseWantAddrs(ipv6, port)))
    }
    return port
  }
  const deps = makeOpenTaskDeps({
    sendControl: makeSendControl(card),
    bridge,
    startListener: wrappedStart,
    // 在途护栏超时复位后，这趟开卡若还在跑：在开 WebView 前自我了断（gen 已变）
    shouldAbort: () => gen !== openGen,
    // 2026-10-12「在浏览器中打开」：调用方注入 no-op 收地址（隧道照建、WebView 不开）
    ...(webViewOverride ? { openWebView: webViewOverride } : {}),
    // 预热全灭=直连大概率不通：开页面前就把桥翻 reverse——入口导航的首条
    // 连接改扣住等反向隧道，不再按 auto 走直连死在不可达候选上（ERR_EMPTY_RESPONSE）
    onDirectUnlikely: () => {
      logRouteOnce(false)
      bridge.setMode('reverse')
    },
    onStatus: (s) => {
      if (s.state === 'degraded') {
        logRouteOnce(false)
        bridge.setMode('reverse')
      } else if (s.state === 'open') {
        logRouteOnce(true)
      }
    },
  })
  let res: OpenTaskResult
  try {
    res = await openSharedTask(card, deps)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '打不开这个任务，稍后再试', reason: 'internal' }
  }
  // reason 必须透上去：上层据此决定"自动重试"还是"原样收摊"（见 open-retry.ts）
  if (!res.ok) {
    // 2026-10-20 僵尸卡自愈：源设备明确说"分享已不存在" → 删除本地任务卡，不再重试。
    if (res.reason === 'gone') {
      try {
        const removed = removeTasksByShareId(card.shareId)
        if (removed > 0) {
          console.log(`[dsh-open] 僵尸卡已自动清理 shareId=${card.shareId}（${removed} 张）`)
          // 2026-10-21 用户反馈：卡消失得悄无声息 → 弹提示（O07）
          try {
            window.dispatchEvent(new CustomEvent('myco:toast', {
              detail: { text: '这个分享已停止，卡片已自动清理' },
            }))
          } catch {
            /* 非浏览器环境（测试）忽略 */
          }
        }
      } catch {
        /* 清理失败不影响提示 */
      }
      return { ok: false, message: '这个分享已经停止（卡片已自动清理），不用再试', reason: 'gone' }
    }
    return { ok: false, message: res.message, reason: res.reason }
  }
  live = { proxy: res.proxy, card, bridge }
  // 会话期 addrs 刷新（IPv6 前缀轮换自愈）：每 5s 重报最新地址，PC 1s 一拍
  // 重查 → 断线后新地址 ~6s 内进入拨号清单。
  startAddrsRefresh()
  // 让"页面在跑"这件事对 UI 可见（重连时状态会翻转；不带 addrs=粘性不动意愿标记，但同样排队保序）
  presenceQueue(() => registerPresence('myco-phone'))
  // connMode 指示器：不写 localStorage（跨 WebView 不同源，主 app file:// ≠ DSH 页 http://127.0.0.1:port）
  // 改由 dsh-open.ts 在 URL fragment 传递 #mycoConn=relay|direct（与 PC 端同款）
  return { ok: true, url: res.url, localPort: res.localPort, ms: res.ms, via: res.entry.via }
}

// ══════ R10 预取票（2026-10-20）══════
// 任务列表可见时后台预取入口票（中继腿）；同一张卡 60s 内只试一次，失败静默。
const lastPrefetchAt = new Map<string, number>()
const prefetchInflight = new Set<string>()
let prefetchBusy = false
export function prefetchTaskEntry(card: Record<string, unknown>): void {
  const shareId = typeof card.shareId === 'string' ? card.shareId : ''
  const sourceDevice = typeof card.sourceDevice === 'string' ? card.sourceDevice : ''
  if (!shareId || !sourceDevice) return
  const now = Date.now()
  const last = lastPrefetchAt.get(shareId) ?? 0
  if (now - last < 20_000) return
  // 2026-10-20 真案：启动时多处触发（3 个 timer + visibilitychange + 列表 effect）会同时
  // 起几十条中继隧道，把首开拖到 8s。这里全局单飞 + 同卡 in-flight 去重。
  if (prefetchBusy || prefetchInflight.has(shareId)) return
  lastPrefetchAt.set(shareId, now)
  prefetchInflight.add(shareId)
  prefetchBusy = true
  void (async () => {
    try {
      const id = tunnelIdentity() ?? (await waitForIdentityReady().catch(() => null))
      if (!id) return
      const deps = makeOpenTaskDeps({})
      const entry = await prefetchShareEntry(card as never, deps)
      if (entry) console.log(`[dsh-open] 预取票成功 shareId=${shareId}（点卡时直接用）`)
    } finally {
      prefetchInflight.delete(shareId)
      prefetchBusy = false
    }
  })().catch(() => undefined)
}

/** 读原生隧道快照（拿本机 IPv6 用；不可用时空串）。 */
function shellTunnelState(): string {
  try {
    const w = window as unknown as { MycoShell?: { tunnelState?: () => string } }
    return w.MycoShell?.tunnelState?.() ?? ''
  } catch {
    return ''
  }
}

// ═══ 2026-10-15 原生 tick 驱动（真机实测定案：DSH 页面盖住主 WebView → Chromium 对
// 隐藏页限流定时器 → 隧道重拨状态机停摆——后台探本地隧道口超时 0 字节，am start
// 前台后 0.54s 复活；用户真案"关 WiFi 后一直重连不上，回应用再点就好"同根）。
// KeepAliveService 每 4s 经 evaluateJavascript 注入 window.__mycoTunnelTick()——
// JS 注入不受定时器限流；degraded 时绕退避立即重探（refreshCandidates 重装中继腿）。═══
export function tunnelTick(): 'noop' | 'reprobe' | 'none' {
  const p = live?.proxy
  if (!p) return 'none'
  const st = p.status.state
  if (st === 'open' || st === 'idle') return 'noop'
  void p.retryNow()
  return 'reprobe'
}

/**
 * 网络切换强制重探（2026-10-30 外部 WiFi 真案）。
 * 半开隧道 state 仍可能是 open；不能等 tick 的 degraded 判定。
 */
export function tunnelNetworkChanged(): 'reset' | 'none' {
  const p = live?.proxy
  if (!p) return 'none'
  // 手机本机 IPv6/反向可达地址也随网络变了：绕过 2s 节流立刻重报 presence。
  lastAddrsRefreshAt = 0
  refreshSessionAddrsNow()
  void p.forceNetworkReset().catch(() => undefined)
  return 'reset'
}
if (typeof window !== 'undefined') {
  // 2026-10-15 统一 tick 入口：隧道重连 + presence 心跳（灭屏时 WebView JS 冻结，
  // 原生 KeepAliveService 每 4s 注入此 tick 驱动两者——真案：手机灭屏 2 小时
  // presence 掉线，用户点任务卡报"对方不在线"）。
  ;(window as unknown as Record<string, unknown>).__mycoTick = () => {
    // ① 隧道：degraded 时绕退避重探
    // 2026-10-16 修「ERR: Script error 红条」：tunnelTick 抛错会冒泡到
    // window.onerror → 全局红条每 4s 刷一次（用户真机报）。tick 是 best-effort
    // 心跳——同步异常就地吞掉（壳侧注入串也已包 try/catch，双保险）。
    let r: 'noop' | 'reprobe' | 'none' = 'none'
    try { r = tunnelTick() } catch { /* 心跳 best-effort */ }
    // ② presence：灭屏时 PWA 的 presence 维护停摆（lastSeen 不更新 → 云名册判离线）。
    //    tick 补一拍 registerPresence——轻量 HTTP POST，presenceQueue 有序不叠加。
    try {
      if (live || taskShareState().startsWith('live')) {
        presenceQueue(() => registerPresence('myco-phone'))
      }
    } catch { /* best-effort */ }
    return r
  }
  // 兼容旧名（不删，防两端版本错配）
  ;(window as unknown as Record<string, unknown>).__mycoTunnelTick = tunnelTick
  // 原生 ConnectivityManager 网络回调入口：半开 open 也强制重探。
  ;(window as unknown as Record<string, unknown>).__mycoNetTunnelChanged = tunnelNetworkChanged
}

/**
 * 收起分享会话（离开页面/开新卡时调）。
 *
 * 2026-10-09 二开修复：**不再停本地监听**。原实现每次开卡都 `tunnelStop()` →
 * `tunnelStart()`，随机端口必变 = origin 必变 = cookie/localStorage 全丢——
 * 第二次打开 DSH SPA 在全新 origin 上"现建空白会话"，会话列表看着是空的。
 * 现在端口跨开保留（`TunnelProxyServer.start()` 本就幂等返回同一端口）：
 * 第二次打开落在**同一个 origin** 上，`dsh.sessions.current`（入口引导种下/用户
 * 自选）与入口 cookie 都还在，直接落回分享的会话；网关的 enter-stale-url
 * 回落（窄票过期但 cookie 在期）也随之生效。一个 ServerSocket 开销可忽略；
 * 外部入站仍有 `GET /p2p/tunnel` 首行闸（TunnelProxyServer）。
 */
export function stopTaskShare(opts: { keepPresence?: boolean } = {}): void {
  // 会话期 addrs 刷新先停（keepPresence 路径下新开卡的 wrappedStart 会重启它）
  stopAddrsRefresh()
  if (!live) return
  try {
    live.proxy.stop()
  } catch {
    /* ignore */
  }
  // 2026-10-10 移动直连修复：不停桥——桥是 PC 反向连接的唯一处理器。
  // 停了桥 → PC 连接没人处理 → 代理不响应 → 下次开卡取票也走不通。
  // 桥的生命周期跟代理一致（TunnelProxyServer 不停，桥也不停）。
  // try {
  //   live.bridge?.stop()
  // } catch {
  //   /* ignore */
  // }
  // 清反向意愿（服务器 addrs 粘性：必须显式传不带 wantReverse 的对象覆盖。
  // ⚠️ 经 presenceQueue 排队——它若跑到下一次开卡的 wantReverse 注册**之后**，
  // 就会把意愿抹掉：PC 拨号循环判 gone 撤空反向池 → 分享页饿死白屏）。
  // keepPresence（开新卡时用）：{} 与随后的 wantReverse 重报之间有个"空窗"，
  // PC 拨号循环一拍看到空窗就撤池——正在服务的胶合连接被抽走（真机"held 的
  // 连接等不到隧道"的饥饿窗口）。新卡随后重报 wantReverse（端口不变），跳过
  // 这次清除，空窗消失；真正的会话结束（离开页面）仍走清除路径。
  if (!opts.keepPresence) {
    presenceQueue(() => registerPresence('myco-phone', 'idle', {}))
  }
  live = null
}

/** 诊断（adb/EnvServer 取证）。 */
export function taskShareState(): string {
  const fly = ` opening=${openFlight.inFlight() ? '1' : '0'} gen=${openGen}`
  // idle 也带桥快照（2026-10-10）：桥预创建是否生效的真机取证面——冷启动后
  // 看到 bridge=mode=auto tp=0 即"开卡前桥已就位"（PC 反向连接有人接电话）。
  const preBridge = shareBridge ? ` bridge=${shareBridge.bridge.snapshot()}` : ''
  if (!live) return `idle${fly}${preBridge}`
  const bridge = live.bridge ? ` bridge=${live.bridge.snapshot()}` : ''
  return `live shareId=${live.card.shareId} ${JSON.stringify(live.proxy.status)}${bridge}${fly}`
}

/** 挂到 window（主界面启动时调一次）：给 UI 与 adb 两条通道。 */
export function installTaskShare(): void {
  installNativeBridge()
  // 桥预创建（2026-10-10 冷启动死锁修复）：上次分享的源设备先建好桥——app
  // 刚启动、presence 的 wantReverse 还在 TTL 里的窗口中，PC 拨过来的反向连接
  // 也有人处理（而不是黑洞到取票超时）。开新卡换源设备时 shareBridgeFor
  // 自动换桥，预创建的桥不会误拦（expectDevice 闸按最新会话判）。
  const last = readLastShareSourceDevice()
  // 2026-10-22 入向 vnet：**没有上次分享源设备时也要建桥**（expectDevice=''）。
  // 否则手机从未点过卡 → 没有反向桥 → PC 的 vnet forward 请求无人处理（黑洞）。
  // expectDevice='' 时闸门只放行"同账号 + 普通端口"的 vnet 请求（分享面仍需精确源设备）。
  ensureBridgeFor(last || '')
  if (typeof window === 'undefined') return
  const w = window as unknown as Record<string, unknown>
  if (w.MycoDshShare) return
  w.MycoDshShare = {
    open: (payload: Record<string, unknown>) => openTaskShare(payload),
    stop: () => stopTaskShare(),
    state: () => taskShareState(),
    canOpen: (payload: Record<string, unknown>) => !!shareCardOf(payload),
    /** 真机取证：覆盖源设备寻址与代取端口（`null` 清除）。 */
    debug: (o: DebugOverride | null) => {
      setDebugOverride(o)
      return 'ok'
    },
    /** 真机取证：本机身份摘要。 */
    whoami: () => {
      const id = tunnelIdentity()
      return JSON.stringify({ account: id?.account ?? '', device: id?.device ?? '' })
    },
    /** 真机取证：原生代理是否可用（缺哪一项给哪句人话）。 */
    native: () => JSON.stringify({ ok: hasNativeProxy(), gap: nativeProxyGap() }),
    /**
     * 真机取证：连接决策（LAN 直连 → B 直连 A → A 反向连 B → 人话错误）。
     * `sourceReachable` 由调用方给（直连探测结果）；本机可达性看原生 IPv6 快照。
     */
    route: (sourceReachable: boolean, sameSubnet = false) => {
      const ipv6 = shellTunnelIpv6(shellTunnelState())
      return JSON.stringify(
        decideTunnelRoute({ sameSubnet, sourceReachable, selfInbound: ipv6.length > 0 }),
      )
    },
    /**
     * **真机取证通道**：把一条 wire 信封喂给**与对账同一条** ingest 链
     * （`p2p.ts:ingestWireMsg` → `chat-store.ingestMsg`）。
     *
     * 为什么需要它：手机没有入站监听、presence 也不报 addrs——设备群广播**推不到**
     * 手机（只能靠对账）。真机验收要的是"**真形状的卡**落进手机会话、UI 上可点"，
     * 所以由外部（adb/EnvServer eval）把一条**真 envelope** 推进来；进的这条链
     * 与对账拉到卡时**完全同一条**（含 `task-share` 的嵌套卡摊平）。
     * 只回一个字符串结果，不改任何业务状态；生产 UI 从不调用它。
     */
    ingestWire: (env: Record<string, unknown>) => {
      const ok = ingestWireMsg(env)
      return JSON.stringify({ ok })
    },
  }
}

/** 卡片里是否带分享信息（UI 决定"点开"走哪条路）。 */
export function isShareCard(payload: Record<string, unknown> | null | undefined): boolean {
  return !!shareCardOf(payload)
}

/**
 * 任务卡「在浏览器中打开」（2026-10-12 用户要求）：**建好隧道拿地址，但不开
 * myco 自己的 WebView**——交给系统浏览器。好处：不占用 myco 内的会话/交互
 * （用户在浏览器里看 DSH 页，myco 还能正常点别的卡），断线也只是浏览器刷新。
 *
 * 复用完整开卡链（寻址→取票→建隧道→本地口），只把最后一步 openWebView 换成
 * 捕获地址；隧道就绪后浏览器才访问得了 127.0.0.1:<port>（这就是必须先跑流程
 * 的原因）。返回 url 供调用方交给 MycoShell.openInBrowser。
 * 单飞护栏（openFlight）保证同一时刻只有一个开卡在飞 → 覆盖变量无并发竞态。
 */
export async function resolveShareUrlForBrowser(
  raw: Record<string, unknown>,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  let captured = ''
  webViewOverride = (url) => {
    captured = url
    return true
  }
  try {
    const r = await openTaskShare(raw)
    if (r.ok && (captured || r.url)) return { ok: true, url: captured || r.url }
    return { ok: false, message: r.ok ? '没拿到地址' : r.message }
  } finally {
    webViewOverride = null
  }
}

/** 交给系统浏览器（native 白名单 http(s)）。返回 native 的 OK/ERR 文本。 */
export function openUrlInBrowser(url: string): string {
  const shell = (window as unknown as { MycoShell?: { openInBrowser?: (u: string) => string } }).MycoShell
  if (!shell?.openInBrowser) return 'ERR:当前外壳不支持（旧 APK）'
  try {
    return shell.openInBrowser(url)
  } catch (e) {
    return 'ERR:' + String(e)
  }
}

// ══ 全时 presence addrs 刷新（2026-10-18，P3：网络切换后地址不再"粘死"） ══
//
// 事实链（真机）：presence 的 addrs 在服务端是**粘性**的（`body.addrs || prev`）；
// 手机原来只在"分享会话 live"时每 5s 重报 → 无会话 / 后台冻结恢复后服务器上还是旧
// 地址（PC 拨死地址，用户看到"重连不成功，得重新点卡才恢复"）。
// 这里加一条**恒常**刷新：每 10s + 回前台 + online 事件各刷一次——
//   · 有会话：带 wantReverse（与既有会话期刷新同款，PC 才拨）；
//   · 无会话：只报地址、不带 wantReverse（免得 PC 拨一个没人接的端口）。
let presenceRefreshTimer: ReturnType<typeof setInterval> | null = null
let lastPresenceRefreshAt = 0

export function refreshPresenceAddrsNow(force = false): void {
  const now = Date.now()
  if (!force && now - lastPresenceRefreshAt < 3000) return
  lastPresenceRefreshAt = now
  const ipv6 = shellTunnelIpv6(shellTunnelState())
  if (ipv6.length === 0) return
  if (live && sessionListenPort != null) {
    const port = sessionListenPort
    presenceQueue(() => registerPresence('myco-phone', 'active', reverseWantAddrs(ipv6, port)))
  } else {
    presenceQueue(() => registerPresence('myco-phone', 'active', { ipv6: ipv6[0], ipv6List: ipv6 }))
  }
  lastReportedIpv6Key = ipv6.join(',')
}

/** 起全时刷新（幂等；模块加载时自动起一次）。 */
export function startPresenceRefreshLoop(): void {
  if (presenceRefreshTimer !== null) return
  try {
    presenceRefreshTimer = setInterval(() => refreshPresenceAddrsNow(), 10000)
  } catch { return }
  try {
    window.addEventListener('online', () => refreshPresenceAddrsNow(true))
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') resumeRecovery()
    })
  } catch { /* 非浏览器环境（单测）忽略 */ }
}

/**
 * 2026-10-23：手机「回前台恢复」统一踢一脚（native onResume 注入 + visibilitychange 双通道）。
 *
 * 真机问题：myco 退后台再切回来连不上（RDP 卡转圈/聊天一直"重新连接"）。根因是 L7：
 * 荣耀后台会压制 WebView 网络与定时器（B1 实测后台 23min 0 请求、native 网络却正常），
 * 回前台时旧连接可能已半开、且页面的 visibilitychange 在部分机型上不触发
 * （MainActivity 之前没有 onPause/onResume → WebView 可能一直"可见"）。
 * 对策：显式入口 `window.__mycoHostResume()`（native onResume 每 4s 的 __mycoTunnelTick
 * 之外再踢一次），做三件事：刷新 presence 地址 / 重武装 vnet 转发监听 / 广播 online。
 */
export function resumeRecovery(): void {
  // 2026-10-23 T2 计时：记录 native onResume 注入时刻（页面内 performance.now），
  // 供 EnvServer eval 读取，测量「回前台 → 列表刷出」耗时。
  try {
    ;(window as unknown as { __mycoResumeT?: number }).__mycoResumeT = performance.now()
  } catch { /* ignore */ }
  try { refreshPresenceAddrsNow(true) } catch { /* ignore */ }
  // 动态 import 避免与 vnet-forward 形成模块环；失败也不影响其余两步
  try {
    void import('./vnet-forward')
      .then((m) => { try { m.bootVnetForwards() } catch { /* ignore */ } })
      .catch(() => { /* ignore */ })
  } catch { /* ignore */ }
  try { window.dispatchEvent(new Event('online')) } catch { /* ignore */ }
}

try {
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __mycoHostResume?: () => void }).__mycoHostResume = resumeRecovery
  }
} catch { /* ignore */ }

try {
  if (typeof window !== 'undefined' && typeof document !== 'undefined') startPresenceRefreshLoop()
} catch { /* ignore */ }

// ── E2E/dev 钩子（2026-10-20）────────────────────────────────────────────
// 目的：设备侧 R 指标（R4 remote / R7 手机 cell）需要"真机点一张卡"，
// 但 adb/EnvServer 无法触发真实点击（按钮走 native 手势 + 桥）。这里在
// **localStorage.myco_eval === '1'** 时暴露最小钩子，E2E 用 EnvServer eval 调用；
// 生产（未设 flag）完全不可见，不改变任何默认路径。
try {
  if (typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem('myco_eval') === '1') {
    ;(window as unknown as Record<string, unknown>).__mycoEval = {
      /** 打开一张分享卡：{shareId, sourceDevice, sourceAccount, title?} */
      openShare: (card: Record<string, unknown>) => openTaskShare(card, {}),
      stopShare: () => stopTaskShare(),
      ready: true,
    }
  }
} catch { /* ignore */ }
