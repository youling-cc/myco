/**
 * vnet-forward.ts — 手机端 **vnet 固定端口转发**（外网访问家里 PC：RDP/SSH/DSH/立体声）。
 *
 * 用户视角：手机上永远用 `127.0.0.1:<固定端口>`（如 RDP = 127.0.0.1:23389），
 * 不管手机在 WiFi 还是移动网，myco 自动选路（直连 → 打洞 → 阿里云中继）。
 *
 * 分工（与分享页一致）：**原生搬字节（ForwardListener），JS 管隧道协议**。
 * 手机是**发起方**，所以不依赖手机入向监听/RelayProvider 注册。
 *
 * 数据流（一条本地连接 = 一条到 PC 目标端口的隧道）：
 *   RDP 客户端 ─▶ 127.0.0.1:23389(原生) ─onConn/onData─▶ 本模块
 *     └─ openTunnel/raceCandidates（手机 → PC p2p 9100）→ FrameIo.seal → WS
 *     ◀─ onMessage → FrameIo.open → MycoShell.vnetForwardSend → 本地 socket
 */
import {
  buildCandidates,
  httpToWs,
  raceCandidates,
  relayCandidate,
  type Candidate,
  type FrameIo,
  type PeerAddrs as SourceAddrs,
  type TunnelSocket,
} from './p2p-tunnel'
import { nativeSocketFactory } from './native-proxy'
import { tunnelIdentity } from './dsh-open-runtime'
import { currentIdentity, listPresence, lastPresenceErrorText, type PresenceNode } from './identity'
import { inboundApi } from './vnet-inbound'

export interface VnetForward {
  /** 手机本地固定口（127.0.0.1:<localPort>） */
  localPort: number
  /** 目标设备 DID（PC） */
  device: string
  /** 对端要访问的端口（PC 上的 3389/22/13911/9000…） */
  port: number
  label?: string
  enabled?: boolean
}


/**
 * 诊断日志（手机 logcat 被华为 HKS 加密，唯一可读通道是 EnvServer）。
 *
 * ⚠️ 2026-10-22 真机定案：**不能走 `MycoShell.jsNote` 桥**。
 *  该桥是 `void` 的 Java 方法（`EnvServer.note` → 环形 buffer），在 0.3.153/0.154
 *  实测"调几次后整个 WebView JS 线程永久卡死"：notes 停在某一行不再增长，
 *  此后所有 `evaluateJavascript`/`inject` 全部超时返回 null，隧道也不再有
 *  onConn 处理——表现就像"代码没跑"。同批 `selfScreenshot`（有返回值、不碰
 *  EnvServer）一直正常，所以这不是桥坏了，而是这条日志路径本身会把 JS 线程扣死。
 *
 * 现口径：**只写页内环形缓冲**，取证时用 EnvServer `eval` 读回：
 *   `POST /api/intent {"act":"eval","js":"window.__mycoVnet.logs().join(' | ')"}`
 * eval 走 evaluateJavascript + HTTP 响应体，不经过 Java→JS 的同步回调，实测稳定。
 */
const FWD_LOG: string[] = []
const FWD_LOG_MAX = 80

function flog(msg: string): void {
  const line = `${new Date().toISOString().slice(11, 23)} ${msg.slice(0, 240)}`
  try {
    FWD_LOG.push(line)
    while (FWD_LOG.length > FWD_LOG_MAX) FWD_LOG.shift()
  } catch {
    /* ignore */
  }
}

const STORE_KEY = 'myco.vnetForwards'

interface LiveSession {
  socket: TunnelSocket
  io: FrameIo
  inFrames: number
  outFrames: number
  inBytes: number
  outBytes: number
  lastInAt: number
  lastOutAt: number
}

/** connKey = `${localPort}:${connId}` */
const live = new Map<string, LiveSession>()
/** 隧道建好前到达的首包（RDP 的 X.224 请求就一包，丢了就僵住）——按 conn 暂存。 */
const pending = new Map<string, Uint8Array[]>()
const connKey = (p: number, id: number): string => `${p}:${id}`

// ───────────── 原生数据面（2026-10-26 起，2026-11-01 泛化到所有 env 端口） ─────────────

/**
 * 数据面下沉到 Android 原生（NativeRdpTunnel.java + `:tunnel` 进程）。
 *
 * 两个真机根因（对**任意** env 端口都成立，不只是 RDP/DSH）：
 *  ① 外部客户端 App 前台：荣耀可冻结整个 myco UID；
 *  ② 主 WebView `document.hidden`（InAppBrowser 覆盖 / 切后台 / 外部 App 前台）：
 *     Chromium 停投 `__mycoFwd`/`__mycoTunnel` 回调；`resumeTimers()` 不足以恢复。
 *
 * 2026-11-01 真机复现（用户手机连 ECS Linux）：23390 只 arm 在 JS 侧时，
 * 切到远程桌面 App 再连 → `vnet-forward conn accept` 有了但 JS 不拨号，
 * 客户端一直「正在启动」。⇒ 不再维护"哪些口走原生"的白名单：**所有已配置的
 * 转发都优先 arm 原生**，原生 arm 失败才回落 JS 监听（旧壳/身份未就绪）。
 *
 * JS 侧只做三件事（身份层仍是唯一身份来源——原生不重复实现存储）：
 *  ① 身份就绪后把 {账号/设备 DID/设备种子/候选腿} 注入原生（arm）；
 *  ② 周期性重注刷新候选腿（JS 活着才刷；冻结期间原生用最后一次快照 + 中继腿）；
 *  ③ 删除转发时撤注（disarm）。
 * arm 成功后该端口的 acceptLoop 从主进程移交 `:tunnel` 进程（不派 onConn 给 JS），
 * 本模块的 onConn/onData 对该端口自然静默。
 */
/** 已成功 arm 的原生端口（诊断/清扫用；协议侧判据在 NativeRdpTunnel.CFG）。 */
const nativeArmed = new Set<number>()
const lastArmAt = new Map<number, number>()
const ARM_INTERVAL_MS = 30_000
/** arm 代际：remove/start/刷新都会推进，旧异步结果不允许复活已撤下的配置。 */
let armEpoch = 0
let armTimerInstalled = false

interface NativeStreamArmShell {
  vnetRdpArm?: (json: string) => string
  vnetStreamDisarm?: (localPort: number) => string
  vnetRdpState?: () => string
}

function nativeStreamShell(): NativeStreamArmShell | null {
  const s = window as unknown as { MycoShell?: NativeStreamArmShell }
  return s.MycoShell?.vnetRdpArm ? s.MycoShell : null
}

/** 同步注入一组候选腿（不 await，不开监听；调用方保证身份就绪）。
 *  成功 = 该端口已交给 `:tunnel` 进程，主进程监听必须关掉（两处避免抢 accept：
 *  主进程 accept 只会派给 JS，而 JS 在 WebView 冻结时收不到）。 */
function armNativeStreamWithLegs(f: VnetForward, legs: string[]): { ok: boolean; err?: string } {
  const sh = nativeStreamShell()
  if (!sh?.vnetRdpArm) return { ok: false, err: '壳不支持原生数据面' }
  const ident = tunnelIdentity()
  const seedB64 = currentIdentity()?.keyB64 ?? ''
  if (!ident || !seedB64) return { ok: false, err: '身份未就绪，稍后再试' }
  const finalLegs = legs.length > 0 ? legs : [httpToWs(relayCandidate(f.device).base)]
  try {
    const raw = sh.vnetRdpArm(
      JSON.stringify({
        localPort: f.localPort,
        targetDevice: f.device,
        targetPort: f.port,
        account: ident.account,
        device: ident.device,
        seedB64,
        legs: finalLegs,
      }),
    )
    const r = JSON.parse(raw || '{}') as { ok?: boolean; err?: string }
    lastArmAt.set(f.localPort, Date.now())
    if (!r.ok) return { ok: false, err: r.err ?? '原生流通道建立失败' }
    nativeArmed.add(f.localPort)
    try { shell()?.vnetForwardStop?.(f.localPort) } catch { /* ignore */ }
    flog(`native-stream arm ok local=${f.localPort} legs=${finalLegs.length}`)
    return { ok: true }
  } catch (e) {
    return { ok: false, err: String(e) }
  }
}

/** 配置快照（只取启用的转发；原生数据面覆盖全部 env 端口）。 */
function enabledForwards(): VnetForward[] {
  return loadForwards().filter((f) => f.enabled !== false)
}

/** 同步注入 relay-only 配置（首连前必须完成，避免 JS 回落窗口）。
 *  单端口 arm 失败不再让整批失败：失败端口已在用 JS 监听兜底，下一轮刷新再试。 */
function armNativeStreamsSync(force = false): { ok: boolean; err?: string } {
  if (typeof window === 'undefined') return { ok: true }
  const sh = nativeStreamShell()
  if (!sh?.vnetRdpArm) return { ok: true }
  const forwards = enabledForwards()
  // 已撤下的端口要撤注（删除转发 / 停用）
  for (const localPort of [...nativeArmed]) {
    if (forwards.some((x) => x.localPort === localPort)) continue
    nativeArmed.delete(localPort)
    lastArmAt.delete(localPort)
    sh.vnetStreamDisarm?.(localPort)
  }
  let firstErr: string | undefined
  for (const f of forwards) {
    const last = lastArmAt.get(f.localPort) ?? 0
    if (!force && Date.now() - last < ARM_INTERVAL_MS) continue
    const r = armNativeStreamWithLegs(f, [])
    if (!r.ok && !firstErr) firstErr = r.err
  }
  return firstErr ? { ok: false, err: firstErr } : { ok: true }
}

/** 异步刷新直连腿；代际不匹配直接丢弃，防止旧结果复活已撤下的配置。 */
async function refreshNativeStreams(epoch: number): Promise<void> {
  if (typeof window === 'undefined') return
  const sh = nativeStreamShell()
  if (!sh?.vnetRdpArm) return
  for (const f of enabledForwards()) {
    const localPort = f.localPort
    try {
      const { cands } = await candidatesFor(f.device).catch(() => ({ cands: [] as Candidate[] }))
      if (epoch !== armEpoch) return
      const cur = loadForwards().find((x) => x.localPort === localPort && x.enabled !== false)
      if (!cur || cur.device !== f.device || cur.port !== f.port) continue
      const legs = cands.map((c) => httpToWs(c.base))
      if (!legs.some((u) => u.startsWith('relay://'))) legs.push(httpToWs(relayCandidate(cur.device).base))
      armNativeStreamWithLegs(cur, legs)
    } catch {
      /* 刷新失败不撤已在用的 relay 配置 */
    }
  }
}

/** 推进代际并刷新（定时器 / 其它 JS 端口连接时用）。 */
function scheduleNativeStreamsRefresh(): void {
  const epoch = ++armEpoch
  void refreshNativeStreams(epoch)
}

/**
 * 网络切换重置（2026-10-30 外部 WiFi/移动网真案）。
 *
 * ①清 presence 地址缓存——旧 WiFi 下拿到的 LAN/IPv6 候选不因 60s TTL 继续占位；
 * ②立刻强制重注 relay-only 原生配置——RDP/DSH 新连接不再先撞旧直连腿；
 * ③异步刷新 direct+relay 全量候选。
 */
export function resetNetworkStreams(): void {
  addrsCache.clear()
  const sync = armNativeStreamsSync(true)
  flog(`network-reset native-sync ${sync.ok ? 'ok' : `fail:${sync.err ?? ''}`}`)
  scheduleNativeStreamsRefresh()
}

// ───────────────────── 配置持久化 ─────────────────────

export function loadForwards(): VnetForward[] {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as VnetForward[]).filter((f) => f && f.localPort > 0 && f.port > 0) : []
  } catch {
    return []
  }
}

export function saveForwards(list: VnetForward[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list))
  } catch {
    /* 存储满/隐私模式：忽略 */
  }
}

// ───────────────────── base64（原生桥用） ─────────────────────

export function b64encode(u8: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
  return btoa(s)
}

export function b64decode(str: string): Uint8Array {
  const bin = atob(str)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ───────────────────── 运行时 ─────────────────────

interface ForwardShell {
  vnetForwardStart?: (localPort: number) => string
  vnetForwardStop?: (localPort: number) => string
  vnetForwardList?: () => string
  vnetForwardSend?: (localPort: number, connId: number, b64: string) => void
  vnetForwardClose?: (localPort: number, connId: number, why: string) => void
}

function shell(): ForwardShell | null {
  const w = window as unknown as { MycoShell?: ForwardShell }
  return w.MycoShell ?? null
}


// ───────────────────── 候选发现（直连地址 + 中继腿） ─────────────────────

/** 中继默认地址（与 `RelayTunnel.DEFAULT_HOST:PORT` / `p2p-tunnel.RELAY_DEFAULT_ADDR` 同源）。 */
const RELAY_ADDR = 'myco.youling.cc:8321'
/**
 * vnet 中继腿自身预算（ms）。dsh-open 用 `RELAY_LEG_TIMEOUT_MS=2500`，vnet 放宽：
 * vnet 的目标端口是**任意 TCP**（RDP 3389 / 网关 13911），PC 侧要新拨一个目标端口，
 * 手机又常从后台解冻（首包慢）；总预算 12s 有富余，中继腿多等几秒比"只差一点点超时"划算。
 */
const RELAY_LEG_MS = 8000
/** 单腿预算 / 整场预算（2026-10-22 现场：2s/3s 在手机 + 公网中继上偏紧）。 */
const PER_CANDIDATE_MS = 5000
const TOTAL_BUDGET_MS = 12000

/**
 * 对端地址缓存（**一次** presence 查询的成功结果）。TTL 60s：PC 的 LAN/IPv6 基本稳定；
 * 真变了（换网/换 WiFi）下一轮赛跑失败会清缓存重查，不会永久用死地址。
 */
const addrsCache = new Map<string, { addrs: SourceAddrs; at: number }>()
const ADDRS_TTL_MS = 60_000

/** presence 条目 → 对端地址（与 PC `addrs_json` 同构：单值键 / *List 列表键都认）。 */
function addrsOfNode(node: PresenceNode | undefined): SourceAddrs | null {
  const a = (node?.addrs ?? null) as Record<string, unknown> | null
  if (!a) return null
  const has = (v: unknown): boolean =>
    Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim() !== ''
  const any =
    ['lan', 'publicV4', 'reflexive', 'ipv6'].some((k) => has(a[k])) ||
    ['lanList', 'publicV4List', 'reflexiveList', 'ipv6List'].some((k) => has(a[k]))
  return any ? (a as unknown as SourceAddrs) : null
}

function tailOf(did: string): string {
  return (did || '').slice(-6)
}

/**
 * **一次** `listPresence()` 查询，双用：①诊断摘要 ②对端地址（并缓存成功结果）。
 *
 * 旧实现（2026-10-22 22:50 真机现场）：`presenceDiag()` 先查一次拿诊断，`addrsFor()`
 * 再另发 3 次查询——那 3 次偶发全挂（签名 POST 8s 超时 / 服务端 5xx / 身份刚解冻），
 * 于是 notes 里出现自相矛盾的连续两行：
 *   `presence n=18 [...JBx7oj:1...] want=JBx7oj` → `raw addrs null`
 * 现在**同一次结果**既出诊断又出地址，绕开二次请求的偶发失败；成功即缓存 60s。
 */
async function presenceLookupSlow(
  device: string,
  force = false,
): Promise<{ addrs: SourceAddrs | null; diag: string }> {
  const hit = addrsCache.get(device)
  if (!force && hit && Date.now() - hit.at < ADDRS_TTL_MS) {
    const age = Math.round((Date.now() - hit.at) / 1000)
    return { addrs: hit.addrs, diag: `cache ${age}s ${JSON.stringify(hit.addrs).slice(0, 120)}` }
  }
  let diag = 'presence n=?'
  for (let attempt = 0; attempt < 2; attempt++) {
    const list = await listPresence().catch(() => [] as PresenceNode[])
    const err = lastPresenceErrorText()
    // did 精确匹配为主；后缀兜底（服务端/本地 did 形态偶有前缀差异时仍能认人）
    const node =
      list.find((p) => p.did === device) ??
      list.find((p) => (p.did || '').slice(-8) === device.slice(-8))
    const addrs = addrsOfNode(node)
    diag =
      `n=${list.length}${err ? `(${err.slice(0, 36)})` : ''} ` +
      (node
        ? `${tailOf(node.did)}:${addrs ? JSON.stringify(addrs).slice(0, 140) : 'addrs=null'}`
        : `entry=缺席 all=[${list.map((p) => tailOf(p.did)).join(',')}]`)
    if (addrs) {
      addrsCache.set(device, { addrs, at: Date.now() })
      return { addrs, diag }
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 350))
  }
  return { addrs: null, diag }
}

/** 探针/诊断用的强制模式：`relay` = 只拨中继腿（隔离直连问题），`direct` = 只拨直连。 */
export type ProbeMode = 'auto' | 'direct' | 'relay'

/**
 * **连接路径上的 presence 查询（永不挂死连接）** —— 2026-10-23 真机现场修复：
 * 手机 DSH 页"列表一直空/页面转圈"时，`forward` 的每条新连接都在**同步等** presence：
 * `signedPost` 单次 8s + 重试 = 最坏 16s，旧实现再循环 2 轮 ≈ 32s；此时 23911 上可积压 7 条
 * 卡住的连接、页面每条请求都落在这个窗口里 ⇒ 永远拿不到数据。
 *
 * 现在的纪律：
 *   · 缓存未过期 → 立即用；
 *   · 缓存过期但 <10min → 立即用**旧地址**（直连腿失效也无妨，赛跑里还有中继腿兜底），
 *     同时后台刷新（in-flight 去重，多连接共享一次请求）；
 *   · 无缓存 → 最多等 **1.8s**，超时先走中继腿；后台刷新继续，下一条连接即用新地址。
 */
const ADDRS_STALE_MS = 10 * 60_000
const PRESENCE_BLOCK_MS = 1800

async function presenceLookup(
  device: string,
  force = false,
): Promise<{ addrs: SourceAddrs | null; diag: string }> {
  const hit = addrsCache.get(device)
  const age = hit ? Date.now() - hit.at : Number.POSITIVE_INFINITY
  if (!force && hit) {
    if (age < ADDRS_TTL_MS) {
      return { addrs: hit.addrs, diag: `cache ${Math.round(age / 1000)}s ${JSON.stringify(hit.addrs).slice(0, 120)}` }
    }
    if (age < ADDRS_STALE_MS) {
      void presenceLookupSlow(device).catch(() => undefined)
      return { addrs: hit.addrs, diag: `stale ${Math.round(age / 1000)}s ${JSON.stringify(hit.addrs).slice(0, 120)}` }
    }
  }
  const raced = await Promise.race([
    presenceLookupSlow(device, force),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), PRESENCE_BLOCK_MS)),
  ])
  if (raced === 'timeout') {
    void presenceLookupSlow(device).catch(() => undefined)
    return { addrs: null, diag: `presence 未在 ${PRESENCE_BLOCK_MS}ms 内返回 → 先走中继腿` }
  }
  return raced
}

/** 中继腿（vnet 放宽预算；`relayCandidate` 的 port 是对端 p2p 口，中继地址只在 base 里）。 */
function relayLeg(device: string): Candidate {
  // 2026-10-25 RDP 真机 RED：relay 让先 300ms 时，RDP 外部客户端切前台，
  // 主 WebView JS 立即被厂商冻结，延迟任务根本没机会执行，整场 race 只跑直连就结束。
  // vnet 的直连/中继必须同时起跑：先通先得，不能让后台冻结把 relay 腿直接抹掉。
  return { ...relayCandidate(device, RELAY_ADDR), delayMs: 0, timeoutMs: RELAY_LEG_MS }
}

/** 候选装配：**直连优先、中继腿恒在**（PC 侧注册了 relay provider，不依赖 presence addrs）。 */
async function candidatesFor(
  device: string,
  mode: ProbeMode = 'auto',
  force = false,
): Promise<{ cands: Candidate[]; diag: string }> {
  if (mode === 'relay') return { cands: [relayLeg(device)], diag: 'mode=relay（单腿）' }
  const { addrs, diag } = await presenceLookup(device, force)
  const direct = addrs ? buildCandidates(addrs) : []
  const cands = mode === 'direct' ? direct : [...direct, relayLeg(device)]
  return { cands, diag }
}

/** 候选短名（日志紧凑：relay 只留中继主机，直连留 host:port）。 */
function shortBase(base: string): string {
  if (base.startsWith('relay://')) {
    const at = base.lastIndexOf('@')
    return 'relay@' + (at > 0 ? base.slice(at + 1).split('/')[0] : '?')
  }
  return base.replace(/^https?:\/\//, '').replace(/\/p2p\/tunnel.*$/, '')
}

/** 诊断探针：不经过本地口，直接测「手机 → 设备:端口」的隧道能否建起来。 */
async function probeTunnel(device: string, port: number, mode: ProbeMode = 'auto'): Promise<string> {
  const out: string[] = [`mode=${mode}`]
  try {
    const ident = tunnelIdentity()
    out.push('identity=' + (ident ? ident.device.slice(-6) : 'null'))
    if (!ident) return out.join(' | ')
    const { cands, diag } = await candidatesFor(device, mode)
    out.push(`cands=${cands.length}`, diag)
    const losers: string[] = []
    const r = await raceCandidates(cands, {
      identity: ident,
      targetPort: port,
      factory: nativeSocketFactory(),
      perCandidateMs: PER_CANDIDATE_MS,
      totalBudgetMs: TOTAL_BUDGET_MS,
      onLoser: (b, why) => losers.push(`${shortBase(b)}:${why}`),
    })
    out.push(r ? `tunnel=${shortBase(r.winner.base)} ${r.winner.elapsedMs}ms` : 'tunnel=FAIL')
    if (!r && losers.length) out.push('losers=' + losers.join(' ; '))
    if (r) {
      try {
        r.winner.socket.close(1000, 'probe')
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    out.push('err=' + String((e as Error)?.message ?? e))
  }
  flog('probe ' + out.join(' | '))
  return out.join(' | ')
}

/** 中继 TCP 预连池预热（纯优化；旧壳没有这个桥方法就静默跳过）。 */
function warmRelay(): void {
  try {
    const s = shell() as { relayPredial?: (addr: string) => unknown } | null
    s?.relayPredial?.(RELAY_ADDR)
  } catch {
    /* ignore */
  }
}

/** 开固定口监听（幂等）。**优先交原生 `:tunnel` 进程**；arm 不了（旧壳/身份未就绪）
 *  才回落主进程 JS 监听——回落态在 WebView 被冻结时会停摆，但至少"能连"，
 *  下一轮 30s 刷新/网络切换会把该端口重新 arm 过来。 */
export function startForward(f: VnetForward): { ok: boolean; err?: string } {
  const s = shell()
  if (!s?.vnetForwardStart) return { ok: false, err: '壳不支持 vnetForwardStart' }
  armEpoch++
  const epoch = armEpoch
  const arm = armNativeStreamWithLegs(f, [])
  if (arm.ok) {
    void refreshNativeStreams(epoch)
    return { ok: true }
  }
  flog(`native arm 失败 local=${f.localPort}（${arm.err ?? '未知'}）→ 回落 JS 监听`)
  try {
    const r = JSON.parse(s.vnetForwardStart(f.localPort) || '{}') as { ok?: boolean; err?: string }
    return r.ok ? { ok: true } : { ok: false, err: r.err ?? arm.err ?? '未知错误' }
  } catch (e) {
    return { ok: false, err: String(e) }
  }
}

export function stopForward(localPort: number): void {
  shell()?.vnetForwardStop?.(localPort)
  armEpoch++
  nativeArmed.delete(localPort)
  lastArmAt.delete(localPort)
  nativeStreamShell()?.vnetStreamDisarm?.(localPort)
}

/** 添加/更新一条转发并立即启动。 */
export function addForward(f: VnetForward): { ok: boolean; err?: string } {
  const list = loadForwards().filter((x) => x.localPort !== f.localPort)
  list.push({ ...f, enabled: true })
  saveForwards(list)
  return startForward({ ...f, enabled: true })
}

/** 删除一条转发（并存盘）。 */
export function removeForward(localPort: number): void {
  saveForwards(loadForwards().filter((x) => x.localPort !== localPort))
  stopForward(localPort)
}

/** 一条本地连接的隧道建连 + 双向泵。 */
async function onConn(localPort: number, connId: number): Promise<void> {
  const fwd = loadForwards().find((f) => f.localPort === localPort && f.enabled !== false)
  const closeLocally = (why: string): void => {
    pending.delete(connKey(localPort, connId))
    live.delete(connKey(localPort, connId))
    shell()?.vnetForwardClose?.(localPort, connId, why.slice(0, 80))
  }
  if (!fwd) {
    flog(`conn ${localPort}/${connId} 无配置`)
    closeLocally('no-config')
    return
  }
  flog(`conn ${localPort}/${connId} → ${fwd.device.slice(-6)}:${fwd.port}`)
  try {
    const ident = tunnelIdentity()
    if (!ident) {
      flog('identity not ready')
      closeLocally('identity-not-ready')
      return
    }
    const { cands, diag } = await candidatesFor(fwd.device)
    flog(`presence ${diag}`)
    flog(`race start cands=${cands.length} ${cands.map((c) => shortBase(c.base)).join(',')}`)
    if (cands.some((c) => c.kind === 'relay')) warmRelay()
    // 本次连接走的是 JS 回落路径（原生 arm 还没成功）——顺手刷新原生候选腿，
    // 下一条连接就能走冻结免疫的原生数据面。
    scheduleNativeStreamsRefresh()
    const losers: string[] = []
    const r = await Promise.race([
      raceCandidates(cands, {
        identity: ident,
        targetPort: fwd.port,
        factory: nativeSocketFactory(),
        perCandidateMs: PER_CANDIDATE_MS,
        totalBudgetMs: TOTAL_BUDGET_MS,
        onLoser: (b, why) => losers.push(`${shortBase(b)}:${why}`),
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TOTAL_BUDGET_MS + 3000)),
    ])
    if (!r) {
      // 全灭：把每条腿的死因打出来（旧实现只留一句 timeout/null，等于没证据）
      flog(`race 全失败 ${losers.join(' ; ')}`)
      // 直连地址可能已过期（PC 换网/换 WiFi）：清缓存，下次重新查 presence
      addrsCache.delete(fwd.device)
      closeLocally('no-route')
      return
    }
    flog(`隧道通 ${shortBase(r.winner.base)} ${r.winner.elapsedMs}ms`)
    const key = connKey(localPort, connId)
    const sock = r.winner.socket
    const framer = r.winner.io
    live.set(key, {
      socket: sock,
      io: framer,
      inFrames: 0,
      outFrames: 0,
      inBytes: 0,
      outBytes: 0,
      lastInAt: 0,
      lastOutAt: 0,
    })
    // 先挂回调、再冲刷（2026-10-23 回程丢帧加固）：确保对暂存包的响应到达时
    // 消费者一定已就位（native-proxy 侧另有"无订阅者入队"兜底，这里是顺序纪律）。
    sock.onMessage((frame) => {
      try {
        const pt = framer.open(frame)
        if (pt && pt.length) {
          const cur = live.get(key)
          if (cur) {
            cur.inFrames += 1
            cur.inBytes += pt.length
            cur.lastInAt = Date.now()
          }
          if (recvLog < 20) {
            recvLog++
            flog(`recv ${key} #${cur?.inFrames ?? 0} ${pt.length}B → 本地口`)
          }
          shell()?.vnetForwardSend?.(localPort, connId, b64encode(pt))
        }
      } catch {
        /* 坏帧：忽略（AEAD 校验失败不该拖垮整条连接） */
      }
    })
    sock.onClose((info) => {
      // 之前这里一声不吭就关了本地连接——真机日志只见"冲刷"后静默，无从区分
      // "响应丢了"与"隧道断了"。带上 code/reason 和双向帧计数，便于判断停流还是客户端主动断。
      const cur = live.get(key)
      const idleMs = cur?.lastInAt ? Date.now() - cur.lastInAt : -1
      flog(
        `tunnel 关闭 ${key} code=${info?.code ?? '?'} ${String(info?.reason ?? info?.error ?? '').slice(0, 60)}`
        + ` in=${cur?.inFrames ?? 0}f/${cur?.inBytes ?? 0}B out=${cur?.outFrames ?? 0}f/${cur?.outBytes ?? 0}B lastInMs=${idleMs}`,
      )
      live.delete(key)
      closeLocally('tunnel-closed')
    })
    const queued = pending.get(key)
    if (queued && queued.length) {
      pending.delete(key)
      for (const chunk of queued) {
        try {
          sock.send(framer.seal(chunk))
        } catch {
          /* ignore */
        }
      }
      flog(`冲刷 ${queued.length} 个暂存包`)
    }
    // 加密握手期间挤进 ws 收包 inbox 的首批下行帧（openTunnel 只消费握手帧）：
    // 按到达序补交给上面挂好的消费者——它们是**最早**的下行数据（seq 最小），
    // 必须先于任何响应处理，否则会被单调序号检查判成乱序。
    const early = r.winner.earlyFrames
    if (early && early.length) {
      flog(`补交 ${early.length} 个握手期下行帧`)
      for (const frame of early) {
        try {
          const pt = framer.open(frame)
          if (pt && pt.length) shell()?.vnetForwardSend?.(localPort, connId, b64encode(pt))
        } catch {
          /* ignore */
        }
      }
    }
  } catch (e) {
    flog('conn 异常 ' + String((e as Error)?.message ?? e))
    closeLocally(String((e as Error)?.message ?? e))
  }
}

/** 本地 → 隧道。 */
let dataLogCount = 0
let recvLog = 0
function onData(localPort: number, connId: number, b64: string): void {
  const key = connKey(localPort, connId)
  const s = live.get(key)
  if (!s) {
    // 隧道还没建好：暂存，建好后立即冲刷（否则首个请求包丢失 → 客户端僵住）
    const q = pending.get(key) ?? []
    if (q.length < 32) q.push(b64decode(b64))
    pending.set(key, q)
    if (dataLogCount < 3) {
      dataLogCount++
      flog(`data ${key} 暂存 ${b64.length}B（隧道建设中）`)
    }
    return
  }
  if (s) {
    s.outFrames += 1
    s.outBytes += b64.length
    s.lastOutAt = Date.now()
  }
  if (dataLogCount < 20) {
    dataLogCount++
    flog(`data ${key} ${b64.length}B → seal`)
  }
  try {
    s.socket.send(s.io.seal(b64decode(b64)))
  } catch {
    live.delete(key)
    shell()?.vnetForwardClose?.(localPort, connId, 'send-fail')
  }
}

function onClosed(localPort: number, connId: number): void {
  const key = connKey(localPort, connId)
  const s = live.get(key)
  if (!s) return
  live.delete(key)
  try {
    s.socket.close(1000, 'local-closed')
  } catch {
    /* ignore */
  }
}

/**
 * 启动：注册全局回调 + 按配置逐个开监听。
 * （main.tsx 启动 3s 后调；幂等。）
 */
export function bootVnetForwards(): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as { __mycoFwd?: unknown; __mycoVnet?: unknown }
  w.__mycoFwd = {
    onConn: (localPort: number, connId: number) => {
      void onConn(localPort, connId)
    },
    onData,
    onClosed: (localPort: number, connId: number) => onClosed(localPort, connId),
    onError: () => {
      /* bind 失败：由 UI/日志侧反映；不打断其它转发 */
    },
  }
  // 调试/自动化入口（EnvServer inject 或无人值守配置用）
  w.__mycoVnet = {
    list: () => loadForwards(),
    add: (f: VnetForward) => addForward(f),
    remove: (localPort: number) => removeForward(localPort),
    /**
     * 2026-10-23 V21 手机入向端口集合：无参=读生效集合；带参=写（归一化落盘，
     * 立即对后续入向隧道的 acceptTunnel 闸门生效——闸门每次求值不缓存）。
     * 例：`__mycoVnet.inbound()` / `__mycoVnet.inbound([5555, 22])`。
     */
    inbound: (list?: number[]) => inboundApi(list),
    /** 探针：`(device, port, mode?)`；mode=relay 只拨中继腿、direct 只拨直连（隔离排障） */
    probe: (device: string, port: number, mode?: ProbeMode) => probeTunnel(device, port, mode),
    /** presence 诊断（不建隧道）：返回一行摘要，供 EnvServer 取证 */
    presence: async (device: string) => {
      const { addrs, diag } = await presenceLookup(device, true)
      const line = `${addrs ? 'addrs-ok' : 'addrs-null'} | ${diag}`
      flog('presence.probe ' + line)
      return line
    },
    /**
     * 取回本模块的诊断环形缓冲（最新在后）。真机取证通道：
     * `POST /api/intent {"act":"eval","js":"window.__mycoVnet.logs().join('\\n')"}`
     * ——不依赖 `MycoShell.jsNote`（该桥在 0.3.154 上不落地，实测见 notes 为空）。
     */
    logs: () => [...FWD_LOG],
    clearLogs: () => {
      FWD_LOG.length = 0
      return 'ok'
    },
    state: () => {
      try {
        return JSON.parse(shell()?.vnetForwardList?.() ?? '{}')
      } catch {
        return {}
      }
    },
  }
  // 2026-11-13 单一 owner（真机 RED：RDP「反复失效」根因）：3389(RDP)/13911(DSH gw)
  // 的本地转发归 **mf 客户端**（ensureRdpForwardFor/ensureShareEntryForwardFor，
  // R13 耐久回归锁定）。legacy 表里若有历史残留条目（ensureRdpForwardFor 曾回写），
  // 启动时**清除且不恢复**——恢复=Java ARM 抢绑 23389/23911，与 mf 赛跑，
  // legacy 数据面赢了就是黑洞（rc=4 回落那套）。
  const MF_OWNED_TARGET_PORTS = new Set([3389, 13911])
  const all = loadForwards()
  const junk = all.filter((f) => MF_OWNED_TARGET_PORTS.has(f.port))
  if (junk.length > 0) {
    const kept = all.filter((f) => !MF_OWNED_TARGET_PORTS.has(f.port))
    saveForwards(kept)
    flog('boot: 清除 legacy 表中 mf 专属口条目 ' + junk.map((f) => `${f.localPort}->${f.port}`).join(','))
  }
  for (const f of all.filter((x) => !MF_OWNED_TARGET_PORTS.has(x.port))) {
    if (f.enabled === false) continue
    startForward(f)
  }
  // RDP/DSH 原生数据面：startForward 已同步 arm；这里只装一次周期刷新定时器。
  if (!armTimerInstalled) {
    armTimerInstalled = true
    window.setInterval(() => {
      scheduleNativeStreamsRefresh()
    }, ARM_INTERVAL_MS)
  }
}
