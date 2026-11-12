/**
 * dsh-open-runtime.ts — 「点卡就进」的**生产装配**：把分享卡打开接到真实的
 * identity / 设备隧道 / 原生壳上。
 *
 * 2026-11-12 起取票链（share-entry-request / mt 票 / 本地监听数据面 / 自动重试）
 * **整链删除**：手机点 DSH 卡的唯一路径是——
 *   ① `MycoShell.reuseSharePage` 复用仍活着的分享页（返回再开，<1s）；
 *   ② 设备隧道 VNETP 直入：`ensureShareEntryForwardFor(源设备)`（本机→对端 15200，
 *      VNETP/1 DID 认证口，免 mt 免客户端断言）→ `openShareInWebView(/gw/<id>/)`。
 * 拿不到隧道口 → 如实说「连不上源设备」，**绝不回落 mt**（mt 会过期、13911 裸网关
 * 无凭证必拒——真机 0.3.315 前的实测定案）。
 *
 * 为什么要单独一层：纯逻辑（`dsh-open.ts` / `share-entry.ts`）单测跑在 node 环境，
 * 没有 localStorage / WebView；一旦在那里 `import './identity'` 就会把整套 localStorage
 * 迁移与 noble sha512 注册拖进单测。**装配放这里，逻辑放那边**。
 *
 * 对外：
 *   · `openTaskShare(payload)` —— 给 UI（任务卡点击）用；
 *   · `window.MycoDshShare` —— 给 adb / EnvServer 的 `eval` 用（真机取证通道）。
 */

import { currentIdentity, getRootIdentity, getAttestation, signFriendHandshake, registerPresence, signAuthHeader, type PresenceAddrs } from './identity'
import { signWithDeviceKey } from './delegation'
import { ingestWireMsg, setRelayDeliver, setRelayDeliverReply, setVnetP2pTunnel, peerDevicesOf } from './p2p'
import { accountDidEq } from './didUtil'
import { relayCandidate } from './p2p-tunnel'
import { makeSingleFlight, makeSerialQueue, openHttpTunnelSession, httpOverTunnel, type HttpTunnelSession } from './dsh-open'
import { waitUntil } from './open-retry'
import { noteRelayFail, relayFailFromNative } from './relay-fail'
import { ensureVnetIdentity } from './vnet-identity'
import { effectiveInboundPorts, verifyVnetPeerRoster } from './vnet-inbound'
import {
  NativeProxyBridge,
  hasNativeProxy,
  installNativeBridge,
  nativeProxyDeps,
  nativeProxyGap,
  openShareInWebView,
} from './native-proxy'
import {
  shareCardOf,
  type ShareCard,
} from './share-entry'
import { decideTunnelRoute, ReverseShareBridge, type NativeTapLike } from './p2p-tunnel'
import { DEFAULT_GW_PORT } from './share-entry'
import type { TunnelProxy } from './tunnel-session'

/** 当前活着的分享会话（离开页面时 stop——注意本地端口**保留**，见 `stopTaskShare`）。 */
let live: { proxy: TunnelProxy; card: ShareCard; bridge: ReverseShareBridge | null } | null = null

/**
 * 开卡在途护栏（30s→75s 演化，2026-11-12 取票链删除后语义收窄）。
 *
 * 原实现 `opening` 变量一旦因链路挂起永远非 null，后续所有开卡都被
 * `if (opening) return opening` 挡住——用户看到"点卡再也没反应"。单槽护栏带超时：
 * 到点复位 + 代际 +1（还在跑的迟到开卡经 `shouldAbort` 语义在碰共享状态前自我了断）。
 *
 * 75s 的预算依据：VNETP ensure（`SYNC_TUNNEL_ENSURE_TIMEOUT_MS`）最坏 35s（libvnet
 * 注册重试在 native 线程）+ WebView 开页 + 余量；超时兜底文案如实报秒数。
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
  console.log(`[dsh-open] 身份未就绪，等了 ${waited}ms 才就绪（多半刚从后台解冻）——已放行开卡`)
  return tunnelIdentity()
}

/**
 * 聊天投递的中继兜底装配（2026-10-12"直连优先、不通走中转"——与 DSH web 分享
 * 链路同构）。在 app 引导时调一次。
 *
 * 通路复用分享一族的隧道设施：`relayCandidate(对端设备did)`（8321 mux 的 WS 隧道）
 * + `openHttpTunnelSession`/`httpOverTunnel`（可复用隧道会话，目标端口 **9100**——
 * PC 侧隧道白名单 TUNNEL_DEFAULT_PORTS 本就含 9100"好友设备可经隧道调用我方
 * /p2p/* 数据面"，同账号隧道授权放行）——等于把 PC 的 p2p/msg 面从"仅直连"
 * 扩成"直连⊥中继"。
 *
 * 方向说明（诚实边界）：这只解决**手机 → 对端**（手机当 consumer）；反向
 * （PC → 手机）需要手机在云中继注册 provider（裸 TCP 长连+心跳——浏览器 JS
 * 做不了，要 android-shell 的 Java 层，下一步）。
 */
export function wireChatRelayFallback(): void {
  setRelayDeliver(async (accountDid, envelope) => {
    // 聊天投递**不记**失败留痕（record:false）：留痕是给"同步回包收摊文案"用的，
    // 聊天在后台悄悄失败一次会把真因顶掉，反而更难查。
    const r = await relayDeliverOnce(accountDid, envelope, undefined, { record: false })
    return r !== null
  })
  // 2026-10-14 取票中继兜底（历史注：真机异网破案——控制消息只走直推的根修）。
  // 取票链已于 2026-11-12 删除；这条 reply 通道现在的用户是分享权限管理
  // （share-admin 经 p2pDeliverWithReply 读同步回包）。
  setRelayDeliverReply(async (accountDid, envelope, preferDevice) => relayDeliverOnce(accountDid, envelope, preferDevice))
  // 2026-11-11 对账（/p2p/sync/digest|index|batch）的 vnet 隧道兜底：PC 切 vnet
  // 传输模式后 p2p 数据面只绑 127.0.0.1:9100，手机直连必败 → 设备群 task-share
  // 卡拉不到（任务卡列表空）。libvnet 通道是唯一活路（8321 mux 的 PC 侧
  // relay_provider_start 已于 2026-11-06 退场为空壳，中继腿永远超时，不再兜底）。
  // ensure 走**异步桥**（libvnet 注册重试在 native 线程，同步桥会冻住 WebView），
  // 缓存 30s 减少注册往返；取不到口 → null（对账下一拍自愈重试）。
  setVnetP2pTunnel((deviceDid) => ensureSyncTunnelFor(deviceDid))
}

/** 设备隧道端口映射缓存（`device|targetPort` → {localPort, at}）。30s 内复用；
 *  下一拍 ensure 自愈重建（灭屏僵尸防御在 Java 侧）。 */
const SYNC_TUNNEL_TTL_MS = 30_000
const syncTunnelCache = new Map<string, { localPort: number; at: number }>()

/** 本机→对端某端口：常用端口（对账/RDP；分享入口走 15200 的 VNETP 身份口）。 */
export const DEVICE_PORT_SYNC = 9100
export const DEVICE_PORT_RDP = 3389
/**
 * 2026-11-12：设备隧道直入分享网关的 **VNETP 身份口**（15200）。
 *
 * 真机实测：手机直连 13911（裸网关）→「此分享需要 DID 授权（无凭证）」——
 * mt 票会过期、且卡上的 entryUrl 端口是 PC 侧口；而 **15200 的 VNETP/1 监听
 * 会把隧道对端 DID 随流带上**（免 mt 免断言），同链路实测 DSH 页完整加载。
 * 手机点卡**只**走这条路（13911+mt 回落已删，隧道不可用就如实报错）。
 */
export const DEVICE_PORT_VNETP = 15200

/**
 * 设备域查看端固定本地口（2026-11-12 用户定调回归原架构：三端同一个干净链接）。
 * 每个查看端给「对端设备的 15200」开一条**固定口**隧道；干净 URL
 * `http://<deviceAlias>.localhost:<口>/<shareAlias>/` 骑在这条隧道上——
 * 口永不变 ⇒ WebView 按 URL 缓存钉死死口的问题从根上消失（探活补丁随之删除）。
 * 选 23912 而非 PC/笔记本的 23911：手机 app 自己把 23911 占了（MainActivity
 * DSH_LOCAL_ORIGIN——应用内 DSH 浏览器的固定 origin），真机实测 bind 冲突。
 */
export const DEVICE_VIEWER_LOCAL_PORT = 23912

/** 异步 ensure 的回调序号（window 临时回调名，用完即删）。 */
let syncTunnelCbSeq = 0

/** 异步桥单次等待上限：libvnet Connection 构造同步做 relay 注册重试（5 次
 *  × 3s ACK + 退避）+ STUN ≈ 30s——vnet 侧修好前按最坏预算等，到点放弃
 *  （结果回调迟到就丢弃，下一拍重试）。 */
const SYNC_TUNNEL_ENSURE_TIMEOUT_MS = 35_000

/**
 * 确保「本机 → deviceDid:targetPort」有一个本地回环口，返回该口。
 *
 * 一条设备级 vnet 连接 + 每端口一条 add_forward（Java 侧 P2pSyncTunnel 管）。
 * · 动态口模式（默认，聊天/对账 9100 等）：本地口由 Java 从 25910 起自动分配，
 *   这里不写死端口——写死会和"同时接 DSH 与 RDP"打架（2026-11-11 单隧道实现
 *   踩过：两端口抢同一口必失败）。
 * · 固定口模式（opts.localPort，设备域查看端 15200→23911）：口永不变，URL 稳定
 *   ⇒ 跳过 JS 缓存（省一层状态），幂等正确性由 Java probeLocal 保证（死口自动
 *   evict+原口重建）。
 */
async function ensureDeviceForward(
  deviceDid: string,
  targetPort: number,
  opts?: { localPort?: number },
): Promise<number | null> {
  const fixed = opts?.localPort ?? 0
  const key = `${deviceDid}|${targetPort}`
  if (fixed <= 0) {
    const hit = syncTunnelCache.get(key)
    if (hit && Date.now() - hit.at < SYNC_TUNNEL_TTL_MS) return hit.localPort
  }
  const id = tunnelIdentity()
  if (!id) return null
  // 异步桥（p2pTunnelEnsureAsync）：同步版会冻住 JS 线程（libvnet 注册重试
  // 在调用线程跑 ~30s），真机事故实证——必须走后台线程 + 回调。
  const shell = (window as unknown as {
    MycoShell?: { p2pTunnelEnsureAsync?: (callbackJs: string, json: string) => void }
  }).MycoShell
  if (!shell || typeof shell.p2pTunnelEnsureAsync !== 'function') return null
  // 起隧道前必须让 libvnet 拿到本机身份：PC 侧 MYCO_PEER_IDENTITY=1 后，未认证
  // 的入站流一律 AUTH_REQUIRED 拒绝；不注入的表现就是"回环口能建、请求发出去
  // 没下文"（10s 读超时 / unexpected end of stream）。见 vnet-identity.ts。
  ensureVnetIdentity()
  return new Promise<number | null>((resolve) => {
    let settled = false
    const finish = (port: number | null): void => {
      if (settled) return
      settled = true
      try { delete (window as unknown as Record<string, unknown>)[cbName] } catch { /* ignore */ }
      if (port && port > 0) {
        syncTunnelCache.set(key, { localPort: port, at: Date.now() })
        resolve(port)
      } else {
        console.log(`[p2p-sync] 设备隧道 ensure 失败（…${deviceDid.slice(-4)}:${targetPort}）`)
        resolve(null)
      }
    }
    const cbName = `__mycoSyncTunnelCb${++syncTunnelCbSeq}`
    ;(window as unknown as Record<string, unknown>)[cbName] = (r: { ok?: boolean; localPort?: number }) => {
      finish(r && r.ok === true && typeof r.localPort === 'number' ? r.localPort : null)
    }
    try {
      // 必须**带接收者**调用：`const f = shell.p2pTunnelEnsureAsync; f(...)` 在
      // Android WebView 上会抛 "Java bridge method can't be invoked on a
      // non-injected object"（2026-11-11 真机实测，与本仓 task-open 那条
      // openInBrowser 解绑坑同源）。解绑后 catch 里直接 finish(null)，界面上只看到
      // "vnet 隧道 ensure 失败"，native 侧一行日志都没有——正是这个坑。
      shell.p2pTunnelEnsureAsync!(cbName, JSON.stringify({
        targetDevice: deviceDid,
        targetPort,
        // localPort>0 = 固定口（设备域查看端）；不传 = Java 自动分配（25910 起）
        ...(fixed > 0 ? { localPort: fixed } : {}),
        device: id.device,
      }))
    } catch {
      finish(null)
      return
    }
    setTimeout(() => finish(null), SYNC_TUNNEL_ENSURE_TIMEOUT_MS)
  })
}

/** 对账专用：本机 → 对端 p2p 数据面(9100)。 */
async function ensureSyncTunnelFor(deviceDid: string): Promise<number | null> {
  return ensureDeviceForward(deviceDid, DEVICE_PORT_SYNC)
}

/**
 * DSH 分享入口专用（2026-11-12）：本机 → 对端 **VNETP 身份口 15200**，走
 * 设备域查看端固定口 23911。经此口的 HTTP 请求由网关按隧道对端 DID 认证
 * （免 mt / 免客户端断言）。失败返回 null（调用方如实报「连不上源设备」）。
 */
export async function ensureShareEntryForwardFor(deviceDid: string): Promise<number | null> {
  return ensureDeviceForward(deviceDid, DEVICE_PORT_VNETP, { localPort: DEVICE_VIEWER_LOCAL_PORT })
}

/**
 * RDP 专用：本机 → 对端 3389，并把拿到的本地口落进 `myco.vnetForwards`，
 * 这样 `rdpStatus()/pickRdpForward()` 立刻能给出 `127.0.0.1:<port>`。
 *
 * 2026-11-11 真案：卡片里写死的 `localPort:23389` 是 **PC 侧**口，手机上没有监听
 * ——点卡只能弹"请在远程桌面 App 里连接"加一句"自动复制失败"。现在本地口由设备
 * 隧道自动分配（25910 起），必须回写才认得到。
 */
export async function ensureRdpForwardFor(deviceDid: string): Promise<number | null> {
  const lp = await ensureDeviceForward(deviceDid, DEVICE_PORT_RDP)
  if (!lp) return null
  try {
    const { upsertLocalForward, RDP_TARGET_PORT } = await import('./remote-desktop')
    upsertLocalForward({ device: deviceDid, port: RDP_TARGET_PORT, localPort: lp, enabled: true })
  } catch { /* 落盘失败不影响本拍连接 */ }
  return lp
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
    if (resp.status !== 200) {
      // 2026-11-11 取证（DSH协议应用 要求）：失败分支记 status/content-type/
      // content-encoding/body 头 200 字节（hex + utf8 双份）——区分"拿到 body
      // 但解析挂了" vs "隧道层没响应"，定 chat 是否还有中继腿可走。
      console.log('[chat-relay-forensic] ' + relayForensicOf(resp, req.path))
      throw new Error(`HTTP ${resp.status}`)
    }
    try {
      return JSON.parse(resp.body) as Record<string, unknown>
    } catch {
      console.log('[chat-relay-forensic] parse-fail ' + relayForensicOf(resp, req.path))
      return null
    }
  } catch {
    dropChatRelaySession(key)
    return null
  }
}

/** 2026-11-11 中继腿失败取证行（DSH协议应用 要求）：status / content-type /
 *  content-encoding / body 头 200 字节的 hex + utf8 双份。纯函数（可单测）。 */
export function relayForensicOf(
  resp: { status: number; headers: Record<string, string>; body: string },
  path: string,
): string {
  const head = (resp.body || '').slice(0, 200)
  let hex = ''
  for (let i = 0; i < head.length; i++) {
    hex += head.charCodeAt(i).toString(16).padStart(2, '0')
  }
  const h = resp.headers || {}
  return JSON.stringify({
    path,
    status: resp.status,
    ct: h['content-type'] || h['Content-Type'] || '',
    ce: h['content-encoding'] || h['Content-Encoding'] || '',
    bodyLen: (resp.body || '').length,
    utf8: head,
    hex: hex.slice(0, 400),
  })
}

async function relayDeliverOnce(  accountDid: string,
  envelope: Record<string, unknown>,
  preferDevice?: string,
  opts: { record?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  // 默认记留痕（share-admin 的同步回包路径）；聊天投递显式关掉（见 wireChatRelayFallback 注释）。
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

/** 开卡进度回调（保留给 openTaskShare 的既有调用方签名；VNETP 路径无中间进度）。 */
export type OpenNoteFn = (text: string) => void
export type OpenTaskShareOpts = { onNote?: OpenNoteFn }

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

// ══ 会话期 addrs 状态（2026-10-10 断线重连修复：IPv6 前缀轮换） ══
//
// 事实链：电信移动网络 IPv6 前缀一天轮换多次（471→473→…）；presence 的 addrs
// 若只报一次 → 轮换后服务器上的是过期地址 → PC 拨旧地址必超时 → "刚才还通，
// 后来又断了"。`refreshSessionAddrsNow`（反向桥 onHoldTimeout / 网络切换回调触发）
// 与全时 `refreshPresenceAddrsNow` 共用这组状态重报最新 IPv6（经 presenceQueue
// 与 stopTaskShare 的清除严格有序）。2026-11-12 取票链删除后分享会话不再置
// `live`，这组状态由全时刷新继续维护（无会话时报地址、不带 wantReverse）。
/** 会话监听端口（有分享会话时记录；无会话 = null → 上报不带 wantReverse）。 */
let sessionListenPort: number | null = null
/** 上次上报的 IPv6 集合指纹（轮换检测/日志）。 */
let lastReportedIpv6Key = ''
/** addrs 刷新自节流（事件触发的立即刷新共用，2s 内不重复入队）。 */
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

/**
 * 「点卡就进」的生产入口。
 *
 * 双击/连点护栏（真机"双击后黑屏"排查项）：同一时刻只允许一条开卡在途——
 * 否则两次并发 `openTaskShare` 会互相 `stopTaskShare` 拆对方的会话，再叠出两个
 * ShareWebActivity。第二次点击直接复用第一次的 Promise。护栏带超时自清
 * （链路挂起不再永久挡门，见 openFlight 注释）。
 *
 * 2026-11-12：取票重试外壳（retryTransient/旧卡自愈）随取票链删除——VNETP
 * ensure 自带 30s 口子缓存 + 下一拍自愈重建，外层重试只会把同一个「连不上」
 * 再说一遍。失败一律一次收摊、如实报因。
 *
 * @param raw 任务卡 payload（含 `shareId` + `sourceDevice`；好友任务卡没有这两项 → 拒绝）
 */
export function openTaskShare(raw: Record<string, unknown>, opts: OpenTaskShareOpts = {}): Promise<OpenSummary> {
  void opts // 保留签名兼容（FriendsPanel 传 onNote）；VNETP 路径无中间进度可报
  return openFlight(
    () => openTaskShareOnce(raw),
    () => {
      // 超时复位：代际 +1 + 收掉半截会话（迟到开卡据此自我了断）
      openGen += 1
      stopTaskShare()
      console.log('[dsh-open] 开卡 75s 未竟——已复位（可再点一次）')
      return { ok: false, message: '打开超时（超过 75 秒），已重置——请再点一次试试', reason: 'offline' }
    },
  )
}

/**
 * 打开一张分享卡（单趟，无重试外壳）。
 *
 * 只有两条路：①复用仍活着的分享页；②设备隧道 VNETP 直入（同账号设备卡）。
 * 其余情况（跨账号卡 / 隧道拿不到口 / 开页失败）一次收摊、如实报因——
 * **绝不回落 mt**（mt 会过期、13911 裸网关无凭证必拒，0.3.315 真机定案）。
 */
async function openTaskShareOnce(raw: Record<string, unknown>): Promise<OpenSummary> {
  // ① 复用快径（2026-10-20 用户指标）：返回列表后再点同一张卡 → 直接复用仍活着的
  //    分享页（<1s）。复用是纯优化：未命中/异常继续走 ②。
  try {
    const card = (raw && (raw.card || raw)) as Record<string, unknown>
    const shareId = typeof card.shareId === 'string' ? card.shareId : ''
    const bridge = (window as unknown as { MycoShell?: { reuseSharePage?: (id: string) => string } }).MycoShell
    if (shareId && bridge?.reuseSharePage) {
      const reuseRes = bridge.reuseSharePage(shareId)
      if (reuseRes === 'OK') {
        console.log('[dsh-open] 复用已打开的分享页（返回再开）')
        return { ok: true, url: 'reused', localPort: 0, ms: 0, via: 'reuse' }
      }
      if (reuseRes === 'STALE') console.log('[dsh-open] 旧页面隧道已死 → 走 VNETP 直入重建')
    }
  } catch {
    /* 复用未命中：继续 */
  }
  const card = shareCardOf(raw)
  if (!card) {
    return { ok: false, message: '这张卡没有可打开的分享信息（可以让对方重新分享一次）', reason: 'internal' }
  }

  // ② VNETP 直入（2026-11-12 真机 03:00 真案起为**唯一**路径）：设备隧道 15200
  //    （VNETP/1 DID 认证口）——网关按隧道对端 DID 认证，免取票/免 mt/免客户端断言。
  //    先等身份就绪（冷启动/后台解冻时 JS 先恢复、身份后加载；与 ensure 同一份
  //    签名材料），再判定账号归属：跨账号分享明确不支持（VNETP 口只对本账号设备放行）。
  const id = tunnelIdentity() ?? (await waitForIdentityReady())
  if (!id) {
    return {
      ok: false,
      message: `本机身份等了 ${IDENTITY_WAIT_MS / 1000} 秒还没就绪——把 myco 切到前台等它连上，或重启一次再点`,
      reason: 'unsupported',
    }
  }
  const srcAcc = (card.sourceAccount || '').trim()
  if (srcAcc !== '' && srcAcc !== id.account) {
    console.log(`[dsh-open] 跨账号分享卡（me=…${id.account.slice(-4)} source=…${srcAcc.slice(-4)}）→ 不支持`)
    return {
      ok: false,
      message: '暂只支持本账号设备的分享入口（跨账号分享请从 PC 端打开）',
      reason: 'unsupported',
    }
  }
  // 记下最近源设备（冷启动时 installTaskShare 据此预创建反向桥——入向 vnet 的闸门对齐）
  persistLastShareSourceDevice(card.sourceDevice)
  const t0 = Date.now()
  let vport: number | null = null
  try {
    vport = await ensureShareEntryForwardFor(card.sourceDevice)
  } catch (e) {
    console.log(`[dsh-open] VNETP ensure 异常（${e instanceof Error ? e.message : String(e)}）`)
    vport = null
  }
  if (!vport || vport <= 0) {
    console.log(`[dsh-open] VNETP ensure 失败（…${card.sourceDevice.slice(-4)}:15200）→ 如实报 unreachable（不回落 mt）`)
    return {
      ok: false,
      message: '连不上源设备（设备隧道不可用），请确认对方设备在线后重试',
      reason: 'unreachable',
    }
  }
  // 干净 URL 优先（2026-11-12 用户定调回归原架构：三端同一个干净简单链接）：
  // 卡上 env 带源设备的 deviceAlias/shareAlias → `http://<alias>.localhost:23911/<share>/`
  // （*.localhost 解析到回环，Host 随 URL 进隧道，网关按 Host+别名表归位并走标准
  // /gw 鉴权链）。老卡没有坐标时回落 /gw/<id>/ 形态（功能等价，仅 URL 不够干净）。
  // 注意从 raw（原始卡面）读 env——shareCardOf 归一化只保留坐标五字段，env 会丢。
  const envSrc = (raw && ((raw as { card?: unknown }).card || raw)) as { env?: unknown[] }
  const env0 = (Array.isArray(envSrc.env) ? (envSrc.env || [])[0] : undefined) as
    | { deviceAlias?: unknown; shareAlias?: unknown }
    | undefined
  const da = String(env0?.deviceAlias ?? '').trim()
  const sa = String(env0?.shareAlias ?? '').trim()
  const vurl = da && sa
    ? `http://${da}.localhost:${vport}/${sa}/`
    : `http://127.0.0.1:${vport}/gw/${card.shareId}/`
  const vtitle = (card.title || card.shareId || '分享').toString()
  const opened = openShareInWebView(vurl, vtitle)
  if (opened !== true) {
    console.log('[dsh-open] VNETP 直入开页失败（' + String(opened).slice(0, 80) + '）')
    return {
      ok: false,
      message: '打不开分享页（原生 WebView 不可用），请重开一次 myco 应用',
      reason: 'unsupported',
    }
  }
  console.log(`[dsh-open] VNETP 直入：${vurl}（${Date.now() - t0}ms，免取票）`)
  return { ok: true, url: vurl, localPort: vport, ms: Date.now() - t0, via: 'vnetp-direct' }
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
