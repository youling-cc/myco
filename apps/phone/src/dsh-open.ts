/**
 * dsh-open.ts — 「点卡就进」的**编排**：取票 → 起本地端口 → 建隧道 → 开 WebView。
 *
 * 全链路（每一步谁做什么）：
 * ```
 * ① 取票    share-entry.ts：向源设备要一张窄 mt（控制消息 / 代取，自动择优）
 * ② 起端口  原生 ServerSocket(127.0.0.1:0)  ← JS 不能监听 TCP，这条只能原生做
 * ③ 建隧道  TunnelProxy 并行赛跑候选（lan/publicV4/reflexive/ipv6），
 *           每条本地连接对应一条到源设备 gwPort 的加密隧道
 * ④ 预热    先探一次，让 WebView 的首次请求不用等整场赛跑
 * ⑤ 开页面  原生开**新 WebView** 载入 http://127.0.0.1:<本地端口>/gw/<id>/?mt=…
 * ```
 * 本文件是**纯编排**（依赖全注入）→ 单测不打网络、不碰 DOM；
 * 生产装配在 `dsh-open-runtime.ts`（那里才 import identity/chat-store）。
 */

import {
  DEFAULT_P2P_PORT,
  RELAY_DEFAULT_ADDR,
  buildCandidates,
  isRelayBase,
  openTunnel,
  raceCandidates,
  relayCandidate,
  tunnelAuthHeader,
  tunnelSignMaterial,
  type Candidate,
  type CandidateKind,
  type FrameIo,
  type OpenTunnelResult,
  type TunnelIdentity,
  type TunnelSocket,
  type TunnelSocketFactory,
} from './p2p-tunnel'
import {
  TunnelProxy,
  memKv,
  statusMessage,
  type ProxyBridge,
  type TunnelKv,
  type TunnelState,
  type TunnelStatus,
} from './tunnel-session'
import {
  DEFAULT_GW_PORT,
  EntryError,
  buildLocalEntryUrl,
  entryControlEnvelope,
  newControlMsgId,
  newRequestId,
  parseGrant,
  requestShareEntry,
  shareEntryRequestWire,
  type EntryContext,
  type ShareCard,
  type ShareEntry,
  type SourceAddrs,
} from './share-entry'

/** 2026-10-10 用户要求：强制直连模式——开启后不走云端中转，直连不通时明确提示。
 *  设置入口在 Pairing 连接 Tab（localStorage `myco.forceDirect`）。 */
export function isForceDirect(): boolean {
  try { return localStorage.getItem('myco.forceDirect') === '1' } catch { return false }
}

/**
 * 中继腿预拨：让原生壳的中继 TCP 预连池（`RelayTunnel.java`，深 2 / TTL 8s）先热
 * 起来——真要用 CONNECT 时从池里拎一条现成的，省 1×公网 RTT。
 * 无壳/旧壳（没有 `relayPredial` 桥方法）静默跳过；中继腿本身不依赖预连（池空现拨）。
 */
function relayPredial(): void {
  try {
    const shell =
      typeof window !== 'undefined'
        ? (window as unknown as { MycoShell?: { relayPredial?: (addr: string) => unknown } }).MycoShell
        : null
    shell?.relayPredial?.(RELAY_DEFAULT_ADDR)
  } catch {
    /* 旧壳没有这个方法：静默（中继腿现拨照常） */
  }
}

// ══════════════════ 隧道上的"一次性 HTTP"（给兜底传输用） ══════════════════

/** 一条 HTTP 响应（只取到我们需要的部分）。 */
export interface TunnelHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/** 经隧道发一条 HTTP 请求的入参。 */
export interface TunnelHttpRequest {
  method: 'GET' | 'POST'
  /** 形如 `/p2p/msg`（含 query）。 */
  path: string
  /** 额外请求头（签名头就靠它带过去）。 */
  headers?: Record<string, string>
  /** 请求体（utf-8；签名覆盖的必须是**逐字这一份**）。 */
  body?: string
}

/**
 * 一条**可复用**的隧道会话（2026-10-20：手机→PC 聊天每条 3.3s 的根因修复）。
 *
 * 旧实现"一条隧道 = 一次 HTTP"（`Connection: close`）：手机每发一条聊天消息都要重新
 * CONNECT + 加密握手（公网中继 p50 ~124ms 的 pair + 握手），实测 10 条均匀 3.3s。
 * PC 侧有 CHAT_TUNNELS 复用（PC→手机只要 62ms），手机侧一直没有 → 这把复用补上。
 */
export interface HttpTunnelSession {
  socket: TunnelSocket
  io: FrameIo
  base: string
  closed: boolean
  createdAt: number
}

/** 建一条可复用的 HTTP 隧道会话（建连代价只会付一次）。 */
export async function openHttpTunnelSession(
  candidate: Candidate,
  targetPort: number,
  identity: TunnelIdentity,
  factory: TunnelSocketFactory,
  opts: { timeoutMs?: number } = {},
): Promise<HttpTunnelSession> {
  const timeoutMs = opts.timeoutMs ?? 8000
  const r: OpenTunnelResult = await openTunnel(candidate.base, {
    identity,
    targetPort,
    factory,
    handshakeTimeoutMs: timeoutMs,
  })
  const session: HttpTunnelSession = {
    socket: r.socket,
    io: r.io,
    base: r.base,
    closed: false,
    createdAt: Date.now(),
  }
  r.socket.onClose(() => {
    session.closed = true
  })
  return session
}

/** 在已有会话上发一条 HTTP（keep-alive 默认开：连接不关，下一条继续用）。 */
export async function httpOverTunnel(
  session: HttpTunnelSession,
  req: TunnelHttpRequest,
  opts: { timeoutMs?: number; host?: string; keepAlive?: boolean } = {},
): Promise<TunnelHttpResponse> {
  if (session.closed) throw new Error('tunnel session closed')
  const timeoutMs = opts.timeoutMs ?? 6000
  const bodyBytes = req.body === undefined ? new Uint8Array(0) : new TextEncoder().encode(req.body)
  const head: string[] = [`${req.method} ${req.path} HTTP/1.1`, `Host: ${opts.host ?? '127.0.0.1'}`, 'Accept: application/json']
  for (const [k, v] of Object.entries(req.headers ?? {})) head.push(`${k}: ${v}`)
  if (req.body !== undefined) {
    head.push('Content-Type: application/json')
    head.push(`Content-Length: ${bodyBytes.length}`)
  }
  head.push(`Connection: ${opts.keepAlive === false ? 'close' : 'keep-alive'}`)
  const raw = new TextEncoder().encode(`${head.join('\r\n')}\r\n\r\n`)
  const chunks: Uint8Array[] = []
  let done = false
  let wake: (() => void) | null = null
  const notify = (): void => {
    const w = wake
    wake = null
    w?.()
  }
  const offMsg = session.socket.onMessage((frame) => {
    try {
      const pt = session.io.open(frame)
      chunks.push(pt)
      notify()
    } catch {
      done = true
      notify()
    }
  })
  const offClose = session.socket.onClose(() => {
    done = true
    notify()
  })
  const t0 = Date.now()
  try {
    session.socket.send(session.io.seal(raw))
    if (bodyBytes.length > 0) session.socket.send(session.io.seal(bodyBytes))
    while (!done && Date.now() - t0 < timeoutMs) {
      if (looksComplete(chunks)) break
      await new Promise<void>((res) => {
        wake = res
        setTimeout(res, 100)
      })
    }
  } finally {
    offMsg()
    offClose()
  }
  if (done && chunks.length === 0) {
    session.closed = true
    throw new Error('tunnel closed before response')
  }
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let off = 0
  for (const c of chunks) {
    all.set(c, off)
    off += c.length
  }
  return parseHttpResponse(all)
}

/**
 * 经隧道发一条 HTTP 请求（一次性：`Connection: close`），把响应收全。
 *
 * 为什么不用本地端口做这件事：本地端口是**原生**的 `ServerSocket`，JS 没法把它当
 * TCP 客户端去连。但 JS 手里本来就有隧道两端（socket + FrameIo），所以直接
 * 一条隧道一次 HTTP 最省事，也最贴近 PC 端"一条 WS = 一条 TCP"的语义。
 * （高频/连续调用请用 `openHttpTunnelSession` + `httpOverTunnel` 复用连接。）
 */
export async function tunnelHttpRequest(
  candidate: Candidate,
  targetPort: number,
  req: TunnelHttpRequest,
  identity: TunnelIdentity,
  factory: TunnelSocketFactory,
  opts: { timeoutMs?: number; host?: string } = {},
): Promise<TunnelHttpResponse> {
  const timeoutMs = opts.timeoutMs ?? 6000
  const session = await openHttpTunnelSession(candidate, targetPort, identity, factory, { timeoutMs })
  try {
    return await httpOverTunnel(session, req, { ...opts, keepAlive: false })
  } finally {
    try {
      session.socket.close(1000, 'http-done')
    } catch {
      /* 已断 */
    }
  }
}

/**
 * 取票隧道**会话复用**（2026-10-20 R10：首开「点卡→拿到入口」1242ms，大头是每次
 * relay CONNECT+配对+WS 加密握手；命中缓存直接 keep-alive 发一条 HTTP）。
 * 失败即销毁重建；TTL 60s；key = 候选 base + 目标端口（每个设备通常 1-2 条腿）。
 */
const entryTunnelSessions = new Map<string, { session: HttpTunnelSession; at: number }>()
const ENTRY_TUNNEL_TTL_MS = 60_000
/** vitest 环境禁用缓存（跨用例复用假隧道会串数据）；生产/真机一律启用。 */
const ENTRY_CACHE_ENABLED = !(
  typeof process !== 'undefined' &&
  (process as unknown as { env?: Record<string, string> }).env?.VITEST
)

/** 带会话缓存的隧道 HTTP（取票专用；语义与 [`tunnelHttpRequest`] 一致）。 */
export async function tunnelHttpRequestCached(
  candidate: Candidate,
  targetPort: number,
  req: TunnelHttpRequest,
  identity: TunnelIdentity,
  factory: TunnelSocketFactory,
  opts: { timeoutMs?: number; host?: string; cacheKey?: string } = {},
): Promise<TunnelHttpResponse> {
  const key = `${opts.cacheKey ?? ''}|${candidate.base}|${targetPort}`
  const hit = ENTRY_CACHE_ENABLED ? entryTunnelSessions.get(key) : undefined
  if (hit && Date.now() - hit.at < ENTRY_TUNNEL_TTL_MS && !hit.session.closed) {
    try {
      const resp = await httpOverTunnel(hit.session, req, { ...opts, keepAlive: true })
      hit.at = Date.now()
      return resp
    } catch {
      try {
        hit.session.socket.close(1000, 'entry-stale')
      } catch {
        /* 已断 */
      }
      entryTunnelSessions.delete(key)
    }
  }
  const session = await openHttpTunnelSession(candidate, targetPort, identity, factory, {
    timeoutMs: opts.timeoutMs ?? 6000,
  })
  try {
    const resp = await httpOverTunnel(session, req, { ...opts, keepAlive: true })
    if (ENTRY_CACHE_ENABLED) entryTunnelSessions.set(key, { session, at: Date.now() })
    return resp
  } catch (e) {
    try {
      session.socket.close(1000, 'entry-fail')
    } catch {
      /* 已断 */
    }
    throw e
  }
}

/** GET 便捷封装（历史调用面保留）。 */
export function tunnelHttpGet(
  candidate: Candidate,
  targetPort: number,
  pathAndQuery: string,
  identity: TunnelIdentity,
  factory: TunnelSocketFactory,
  opts: { timeoutMs?: number; host?: string } = {},
): Promise<TunnelHttpResponse> {
  return tunnelHttpRequest(candidate, targetPort, { method: 'GET', path: pathAndQuery }, identity, factory, opts)
}

/**
 * 响应是否已经收全：
 *   · 有 `Content-Length` → 按长度比（正常路径；axum 一定带）；
 *   · `Transfer-Encoding: chunked` → 看有没有终止块 `0\r\n\r\n`（真机踩过，见 parseHttpResponse）；
 *   · 都没有 → 只能等连接关（调用方在 `done` 时收尾）。
 */
function looksComplete(chunks: Uint8Array[]): boolean {
  const head = decodeHead(chunks)
  const idx = head.indexOf('\r\n\r\n')
  if (idx < 0) return false
  const headerBytes = idx + 4
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const m = /content-length:\s*(\d+)/i.exec(head.slice(0, idx))
  if (m) return total - headerBytes >= Number(m[1])
  if (/transfer-encoding:\s*chunked/i.test(head.slice(0, idx))) {
    const tail = new TextDecoder('latin1').decode(concat(chunks).subarray(Math.max(0, total - 8)))
    return tail.endsWith('0\r\n\r\n')
  }
  return false
}

/** 把分片拼成一段（小工具；只在头部/尾部探测用，成本可忽略）。 */
function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

function decodeHead(chunks: Uint8Array[]): string {
  const n = Math.min(
    chunks.reduce((a, c) => a + c.length, 0),
    8192,
  )
  const b = new Uint8Array(n)
  let off = 0
  for (const c of chunks) {
    if (off >= n) break
    const take = Math.min(c.length, n - off)
    b.set(c.subarray(0, take), off)
    off += take
  }
  return new TextDecoder('latin1').decode(b)
}

/** 解析 HTTP 响应（纯函数，单测直击）。 */
export function parseHttpResponse(raw: Uint8Array): TunnelHttpResponse {
  const text = new TextDecoder('utf-8').decode(raw)
  const idx = text.indexOf('\r\n\r\n')
  const head = idx >= 0 ? text.slice(0, idx) : text
  const rawBody = idx >= 0 ? text.slice(idx + 4) : ''
  const lines = head.split('\r\n')
  const status = Number(/^HTTP\/\d\.\d\s+(\d{3})/.exec(lines[0] ?? '')?.[1] ?? 0)
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  // `Transfer-Encoding: chunked`（**真机踩过**）：源设备若用分块编码（Node 的
  // `res.end(str)` 在没显式 Content-Length 时就会这样），body 是 `<hex>\r\n<data>\r\n…0\r\n\r\n`
  // ——不去壳的话 JSON.parse 必失败，表现为"对方设备没给出入口"（票其实已经到了）。
  // PC 端 axum 的 `Json(...)` 一定带 Content-Length，这里是防御性兼容。
  const body = /chunked/i.test(headers['transfer-encoding'] ?? '') ? dechunk(rawBody) : rawBody
  return { status, headers, body }
}

/** 分块传输解码（纯函数；坏分块原样返回，绝不抛——上层有 JSON 解析兜底）。 */
export function dechunk(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const eol = s.indexOf('\r\n', i)
    if (eol < 0) break
    const size = parseInt(s.slice(i, eol).trim().split(';')[0], 16)
    if (!Number.isFinite(size)) return s
    if (size === 0) return out
    const start = eol + 2
    out += s.slice(start, start + size)
    i = s.indexOf('\r\n', start + size)
    if (i < 0) return out
    i += 2
  }
  return out
}

// ══════════════════ 在途护栏（单槽 + 超时自清）与串行队列 ══════════════════

/**
 * **单槽在途护栏**（纯逻辑，单测直击）：同一时刻只允许一条任务在途；
 * 在途超时强制复位——复位后原任务仍会继续跑完，但其迟到结果被丢弃（装配层
 * 用 `shouldAbort` 让迟到者在碰共享状态前自我了断，见 dsh-open-runtime.ts）。
 *
 * 为什么需要它（真机"开卡后点卡再也没反应"排查项之一）：开卡链路任何一步
 * 永久挂起（网络无超时、原生桥不回包、Promise 泄漏），在途变量就永远非 null，
 * 后续所有开卡都被护栏挡住。30s 兜底复位后用户再点一次即可重来。
 */
export interface SingleFlight {
  <T>(task: () => Promise<T>, onTimeout: () => T): Promise<T>
  /** 当前是否有任务在途（诊断快照用）。 */
  inFlight(): boolean
}

export function makeSingleFlight(opts: {
  timeoutMs: number
  setTimer?: (f: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}): SingleFlight {
  const setTimer = opts.setTimer ?? ((f: () => void, ms: number) => setTimeout(f, ms))
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  let inFlight: Promise<unknown> | null = null
  const run = <T>(task: () => Promise<T>, onTimeout: () => T): Promise<T> => {
    if (inFlight) return inFlight as Promise<T>
    let timer: unknown = null
    const p = new Promise<T>((resolve) => {
      let settled = false
      const settle = (v: T): void => {
        if (settled) return
        settled = true
        if (timer !== null) {
          clearTimer(timer)
          timer = null
        }
        inFlight = null
        resolve(v)
      }
      timer = setTimer(() => settle(onTimeout()), opts.timeoutMs)
      // 任务异常与超时同口径（人话错误由 onTimeout 给）；迟到 settle 丢弃。
      void task().then(settle, () => settle(onTimeout()))
    })
    inFlight = p
    return p
  }
  run.inFlight = (): boolean => inFlight !== null
  return run
}

/**
 * **串行执行队列**（纯逻辑）：按入队顺序逐个执行异步任务——前一个 settle
 * 后一个才开跑（单个任务失败不阻塞后续）。
 *
 * 用于 presence addrs 写入排序（真机"反向路径页面白屏"根因）：清除
 * wantReverse（`{}`）与注册 wantReverse 若乱序到达，服务器按**后到者**生效
 * ——`{}` 后到会把意愿标记抹掉，PC 拨号循环判 gone → 撤空整个反向池 →
 * 分享页扣着的浏览器连接饿死（页面永远白屏）。
 */
export function makeSerialQueue(): (fn: () => Promise<unknown>) => void {
  let chain: Promise<unknown> = Promise.resolve()
  return (fn) => {
    chain = chain.then(() => fn().catch(() => undefined))
  }
}

// ══════════════════ 编排依赖 ══════════════════

/** 打开一张分享卡所需要的全部外部能力（生产装配见 `dsh-open-runtime.ts`）。 */
export interface OpenTaskDeps {
  myAccount: string
  myDevice: string
  identity: TunnelIdentity
  /** 源设备寻址（presence 上报的地址）。null/空 = 没有可拨地址。 */
  sourceAddrs: (deviceDid: string) => Promise<SourceAddrs | null>
  /** provider A：把控制消息直推给源设备（不传=只用代取）。 */
  sendControl?: EntryContext['sendControl']
  /** 原生：起本地监听，返回端口。 */
  startListener: () => Promise<number>
  /** 原生：停本地监听。 */
  stopListener: () => void
  /** 原生：开新 WebView。返回是否成功。 */
  openWebView: (url: string, title: string) => boolean
  /** WS 工厂（生产=原生壳）。 */
  factory: TunnelSocketFactory
  /** 本地连接桥（生产=原生壳）。 */
  bridge: ProxyBridge
  kv?: TunnelKv
  onStatus?: (s: TunnelStatus) => void
  onLog?: (line: string) => void
  /**
   * 兜底传输用的**源设备 p2p 数据面端口**（默认取候选自带的 `port`，再退 9100）。
   * ⚠️ 这里**没有**"管理面端口"这个概念了：兜底只打 `/p2p/msg`，不打 3102。
   */
  p2pPort?: number
  /** provider A 等待上限（默认 1.5s）。 */
  controlWaitMs?: number
  /**
   * 打开已被取代/作废的判定（**开 WebView 前**检查一次）：在途护栏超时复位
   * （或更新的开卡接管）后，迟到的开卡任务经此钩子了断——不再弹出页面、
   * 不碰共享会话状态（弹出来也是脚下没隧道的死页）。
   */
  shouldAbort?: () => boolean
  /**
   * 预热赛跑全灭（直连大概率不通）的通知——**在开 WebView 之前**触发：
   * 装配层据此把反向桥提前翻 reverse，入口导航的首条浏览器连接改为扣住
   * 等反向隧道（否则它按 auto 走直连、几秒后死在不可达候选上 =
   * `ERR_EMPTY_RESPONSE` 死页——真机"直连失效时首次开卡必白屏"的根因）。
   */
  onDirectUnlikely?: () => void
  now?: () => number
  setTimer?: (f: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  randId?: () => string
}

/** 打开结果（成功/失败都回，不抛——UI 直接显示 `message`）。 */
export type OpenTaskResult =
  | {
      ok: true
      /** 交给 WebView 的地址（`http://127.0.0.1:<本地端口>/gw/<id>/?mt=…`）。 */
      url: string
      localPort: number
      entry: ShareEntry
      /** 从点卡到"页面已开始加载"的耗时（ms）——秒级硬指标的实测口径。 */
      ms: number
      /** 会话对象（页面生命周期内保持；离开时 `stop()`）。 */
      proxy: TunnelProxy
      candidates: Candidate[]
    }
  | { ok: false; message: string; reason: 'offline' | 'denied' | 'gone' | 'no-entry' | 'expired' | 'unsupported' | 'internal' }

/**
 * 「点卡就进」主入口。
 * 成功 = 已经在**新 WebView** 里开始加载分享页（并把隧道跑起来）。
 */
// ══════ R10 预取票（2026-10-20）══════
// 用户目标「点卡 → 首屏 ≤3s」；冷开时取票就要 1.2s+。任务列表一出现就在后台用
// **中继腿**先取一张票（不需要本地监听：手机当 consumer 直连 PC provider，走既有
// relay 隧道），点卡时直接消费 → 取票段≈0。
// 安全：票是窄 mt（受分享可见范围限制、短时效），预取失败静默、过期作废。
const prefetchedEntries = new Map<string, { entry: ShareEntry; at: number }>()
const PREFETCH_TTL_MS = 90_000
const PREFETCH_MIN_REMAIN_MS = 20_000

// R10 重开加速（2026-10-20）：打开成功后把入口票留一份——用户"返回→再点同一张卡"时
// 直接复用（票本身是短时效窄 mt，与服务器 TTL 同源），省掉 700ms+ 的取票往返。
const reuseEntries = new Map<string, { entry: ShareEntry; at: number }>()

/** 测试专用：清空预取/复用缓存（模块状态跨用例隔离）。 */
export function __resetEntryCaches(): void {
  prefetchedEntries.clear()
  reuseEntries.clear()
}

/** 打开成功后调用：把这张票留下供"返回再点"复用（不含预取票路径，避免重复存放）。 */
export function rememberEntryForReuse(card: ShareCard, entry: ShareEntry, now = Date.now()): void {
  const remain = entry.expiresAt ? entry.expiresAt - now : PREFETCH_TTL_MS
  if (remain <= PREFETCH_MIN_REMAIN_MS) return
  reuseEntries.set(card.shareId, { entry, at: now })
}

function takeUsable(hit: { entry: ShareEntry; at: number } | undefined, now: number): ShareEntry | null {
  if (!hit) return null
  if (now - hit.at > PREFETCH_TTL_MS) return null
  if (hit.entry.expiresAt && hit.entry.expiresAt - now < PREFETCH_MIN_REMAIN_MS) return null
  return hit.entry
}

/** 取出一张预取票（一次性；过期/将过期返回 null）。优先新预取，其次"上次打开留下的票"。 */
export function takePrefetchedEntry(card: ShareCard, now = Date.now()): ShareEntry | null {
  const pre = prefetchedEntries.get(card.shareId)
  if (pre) {
    prefetchedEntries.delete(card.shareId)
    const e = takeUsable(pre, now)
    if (e) return e
  }
  const reuse = reuseEntries.get(card.shareId)
  if (reuse) {
    const e = takeUsable(reuse, now)
    if (e) {
      reuseEntries.delete(card.shareId)
      return e
    }
    reuseEntries.delete(card.shareId)
  }
  return null
}

/** 后台预取一张票（中继腿；失败静默）。 */
export async function prefetchShareEntry(card: ShareCard, deps: OpenTaskDeps): Promise<ShareEntry | null> {
  try {
    const legs: Candidate[] = [relayCandidate(card.sourceDevice)]
    const entry = await requestEntryViaTunnel(card, deps, legs, { prefetch: true })
    prefetchedEntries.set(card.shareId, { entry, at: Date.now() })
    return entry
  } catch {
    return null
  }
}

export async function openSharedTask(card: ShareCard, deps: OpenTaskDeps): Promise<OpenTaskResult> {
  const t0 = (deps.now ?? Date.now)()
  const log = deps.onLog ?? ((): void => {})
  const kv = deps.kv ?? memKv()
  lastBrokerWinLeg = null // 本次开卡重新记账（provider A/C 拿到入口时保持 null）
  log(`[dsh-open] 点卡 shareId=${card.shareId} 源设备=${card.sourceDeviceName ?? card.sourceDevice}`)

  // ① 寻址（先拿到地址：取票与建隧道都要用）
  let addrs: SourceAddrs | null = null
  try {
    addrs = await deps.sourceAddrs(card.sourceDevice)
  } catch (e) {
    log(`[dsh-open] 寻址失败：${e instanceof Error ? e.message : String(e)}`)
  }
  const cached = kv.get(`myco.tunnel.base.${card.sourceDevice}`)
  const candidates = buildCandidates(addrs ?? {}, cached)
  // ③+ 中继腿（2026-10-11 云端兜底）：直连/反向全断时的第三条路。给直连 300ms
  // 让先（优先直连）；强制直连（myco.forceDirect）时不加。原生壳见到 relay://
  // base 会先 CONNECT 中继再在同一条 TCP 上做 WS 升级（TunnelWs/RelayTunnel.java）。
  const withRelayLeg = (list: Candidate[]): Candidate[] => {
    if (isForceDirect()) return list
    return [...list, relayCandidate(card.sourceDevice)]
  }
  const legs = withRelayLeg(candidates)
  if (legs.length > candidates.length) {
    relayPredial() // 中继 TCP 预连池先热起来（省 1×公网 RTT；纯优化，失败静默）
  }
  log(`[dsh-open] 候选 ${legs.length} 条：${legs.map((c) => `${c.kind}=${c.base}`).join(' ')}`)

  // ② 起本地端口（原生）——提前到取票之前：反向连接场景下 PC 要先看到
  // wantReverse 标记才会拨过来，而取票（share-entry-request）唯一可达路径
  // 就是反向隧道。原顺序（取票→起监听）构成死锁：等票才发标记、等标记才
  // 有隧道、等隧道才能拿到票。先起监听，PC 的拨号循环（10s 一拍）看到
  // wantReverse 就开始拨，取票重试/下一次点卡即走通。
  let localPort: number
  try {
    localPort = await deps.startListener()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log(`[dsh-open] 本地端口失败：${msg}`)
    return { ok: false, message: msg, reason: 'unsupported' }
  }

  // ③ 取票（provider A → provider C ∥ B）
  // 2026-10-11 提速（真机实测 25.9s → ~2.5s）：
  //   · 兜底 C∥B 改**并行赛跑**（原为 C 扣满 holdMs 12-15s 后 B 逐条串行试死腿）；
  //   · provider A 慢/挂时**提前起兜底**：死直连拓扑里 sendControl（p2p 直推）要
  //     ~5s 才认输——600ms 未决就把兜底先跑起来，A 若先回照常用 A 的结果
  //     （兜底那张票是独立 requestId，窄时限自然过期，无副作用）；
  //   · A 自身限时 2s：认输更早，兜底（已提前在跑）衔接。
  const runBroker = async (c: ShareCard): Promise<ShareEntry> => {
    // Provider C（2026-10-10 移动直连修复）：先试本地代理中继——
    // 反向隧道已在桥池里时，POST 到本地代理会经池隧道路由到 PC 的 :9100。
    // 移动网络下直连候选全灭但反向隧道活着，这条路径让取票不依赖直连。
    //
    // 并行化：C 与 B **同时**开跑、先成功者胜。串行时序的坑：反向池空的环境里
    // C 要把连接扣满 holdMs（12-15s）才认输，B 再逐条试死掉的直连候选——最后
    // 才轮到中继腿。并行后 B 的中继腿 ~1.5s 就能拿到票；C 在反向活着时
    // ~1-2s 先胜。两边的请求各带独立 requestId，输家那张票窄时限自然过期。
    if (localPort > 0) {
      const viaC = requestEntryViaProxyRelay(c, deps, localPort).then(
        (entry) => {
          log(`[dsh-open] provider C（代理中继）拿到入口，网关端口 ${entry.gwPort}`)
          return entry
        },
        () => null,
      )
      // 2026-10-21（O07）：B 的**致命拒绝**（分享已停止/无权限/过期）不能被 `() => null`
      // 吞掉——否则 C（反向池）要空转到 10s 才结算，僵尸卡清理/提示被拖到 10s+。
      let brokerFatal: Error | null = null
      let brokerFatalResolve: ((e: Error) => void) | null = null
      const brokerFatalP = new Promise<Error>((res) => { brokerFatalResolve = res })
      brokerFatalP.catch(() => undefined)
      const viaB = requestEntryViaTunnel(c, deps, legs).then(
        (entry) => {
          log(`[dsh-open] provider B（隧道传输）拿到入口，网关端口 ${entry.gwPort}`)
          return entry
        },
        (e: unknown) => {
          const reason = (e as { reason?: string } | null)?.reason
          if (reason === 'gone' || reason === 'denied' || reason === 'expired') {
            brokerFatal = e instanceof Error ? e : new Error(String(e))
            try { brokerFatalResolve?.(brokerFatal) } catch { /* ignore */ }
          }
          return null
        },
      )
      const first = await Promise.race([
        firstSuccess([viaC, viaB]),
        brokerFatalP.then((e) => { throw e }),
      ]).catch((e: unknown) => {
        if (brokerFatal) throw brokerFatal
        throw e
      })
      if (first) return first
      if (brokerFatal) throw brokerFatal
      throw new EntryError('offline', `${card.sourceDeviceName ?? '对方设备'}暂时连不上，稍后再试`)
    }
    return requestEntryViaTunnel(c, deps, legs)
  }
  let brokerP: Promise<ShareEntry> | null = null
  const ensureBroker = (c: ShareCard): Promise<ShareEntry> => {
    if (!brokerP) {
      brokerP = runBroker(c)
      // 早启而最终没被等到（A 先赢）时：吞掉 unhandled rejection
      void brokerP.catch(() => undefined)
    }
    return brokerP
  }
  const sendControlTimed: OpenTaskDeps['sendControl'] = deps.sendControl
    ? (kind, payload, requestId) => {
        const kick = setTimeout(() => {
          void ensureBroker(card)
        }, 600)
        const giveUp = new Promise<boolean | { delivered: false }>((resolve) => {
          setTimeout(() => resolve({ delivered: false }), 2000)
        })
        return Promise.race([Promise.resolve(deps.sendControl!(kind, payload, requestId)), giveUp]).finally(
          () => clearTimeout(kick),
        )
      }
    : undefined
  let entry: ShareEntry
  const pre = takePrefetchedEntry(card, t0)
  if (pre) {
    log('[dsh-open] 用预取票（省一次取票往返）')
    entry = pre
  } else
  try {
    entry = await requestShareEntry({
      card,
      myAccount: deps.myAccount,
      myDevice: deps.myDevice,
      sendControl: sendControlTimed,
      controlWaitMs: deps.controlWaitMs,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
      now: deps.now,
      randId: deps.randId,
      onLog: log,
      broker: (c) => ensureBroker(c),
    })
  } catch (e) {
    const err = e instanceof EntryError ? e : new EntryError('internal', e instanceof Error ? e.message : String(e))
    log(`[dsh-open] 取票失败：${err.message}`)
    return { ok: false, message: err.message, reason: err.reason }
  }

  // 票留着给"返回再点"复用（刚取的/刚预取的都记下；过期自动作废）
  rememberEntryForReuse(card, entry)

  // ④ 建隧道（并行赛跑；每条本地连接一条）
  const proxy = new TunnelProxy({
    candidates: legs,
    targetPort: entry.gwPort || DEFAULT_GW_PORT,
    identity: deps.identity,
    factory: deps.factory,
    bridge: deps.bridge,
    refreshCandidates: () => {
      // 重连时重取寻址（换网/对端换地址后自动跟上）；中继腿每次重新装配
      // （isForceDirect 在此重判——切换"强制直连"后重连即生效）
      void deps
        .sourceAddrs(card.sourceDevice)
        .then((a) => {
          if (a) addrs = a
        })
        .catch(() => undefined)
      return withRelayLeg(buildCandidates(addrs ?? {}, kv.get(`myco.tunnel.base.${card.sourceDevice}`)))
    },
    kv,
    cacheKey: `myco.tunnel.base.${card.sourceDevice}`,
    targetName: card.sourceDeviceName ?? '对方设备',
    onStatus: (s) => {
      log(`[dsh-open] 状态=${s.state} ${s.message}`)
      deps.onStatus?.(s)
    },
    now: deps.now,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
  })
  proxy.start()

  // ⑤ 预热：让胜出候选先就位（否则 WebView 的首个请求要等整场赛跑）。
  //    入口经中继腿拿到时跳过——预热在此场景是纯浪费（胜出不进缓存、白拨一条
  //    中继隧道，~1.5s）；首条页面连接自会赛跑，时延等价还早开页面。
  const wonViaRelayLeg = lastBrokerWinLeg === 'relay'
  if (legs.length > 0 && !wonViaRelayLeg) {
    try {
      const warm = await raceCandidates(legs, {
        identity: deps.identity,
        targetPort: entry.gwPort || DEFAULT_GW_PORT,
        factory: deps.factory,
      })
      if (warm) {
        // 中继胜出不缓存为"上次胜出地址"（它不是直连候选，下次由 withRelayLeg 现场装配）
        if (!isRelayBase(warm.winner.base)) {
          kv.set(`myco.tunnel.base.${card.sourceDevice}`, warm.winner.base)
        } else {
          relayPredial()
        }
        try {
          warm.winner.socket.close(1000, 'warm-done')
        } catch {
          /* ignore */
        }
      } else {
        // 整场赛跑全灭（直连+中继都不通）：直连大概率不通——提前告诉装配层（反向桥
        // 翻 reverse），入口导航的首条连接改走"扣住等反向隧道"，不再死在不可达候选上
        log('[dsh-open] 预热全灭：直连不通，改走反向等对方拨入')
        deps.onDirectUnlikely?.()
      }
    } catch {
      /* 预热失败不影响主流程：真正建连在本地连接到来时再试 */
    }
  } else if (wonViaRelayLeg) {
    // 2026-10-21（O01 长尾 4.8s）：入口经中继腿拿到时旧实现完全跳过预热，页面首请求
    // 现拨中继——偶发中继注册/握手窗口会让首连接整场赛跑失败，浏览器重试 → 首屏 ~5s。
    // 现在做**中继单腿预热**（短预算）：先确认中继腿能建隧道并把预连池热起来，再开页。
    log('[dsh-open] 入口经中继腿拿到：开页前做中继单腿预热')
    relayPredial()
    const relayLegs = legs.filter((c) => c.kind === 'relay')
    if (relayLegs.length > 0) {
      try {
        const warm = await raceCandidates(relayLegs, {
          identity: deps.identity,
          targetPort: entry.gwPort || DEFAULT_GW_PORT,
          factory: deps.factory,
          perCandidateMs: 1500,
          totalBudgetMs: 1800,
        })
        if (warm) {
          log(`[dsh-open] 中继预热成功（${warm.winner.elapsedMs}ms）`)
          try {
            warm.winner.socket.close(1000, 'warm-done')
          } catch {
            /* ignore */
          }
        } else {
          log('[dsh-open] 中继预热未成（页面连接自会再试）')
        }
      } catch {
        /* 预热失败不影响主流程 */
      }
    }
  }

  // ⑥ 开页面（开之前最后闸口：这趟开卡若已被取代——在途护栏超时复位/更新的
  // 开卡接管——就地收摊，不把页面弹出来；弹出来也是脚下没隧道的死页）
  if (deps.shouldAbort?.()) {
    proxy.stop()
    deps.stopListener()
    log('[dsh-open] 开卡已被取代/超时，放弃打开页面')
    return { ok: false, message: '这次打开已被更新的操作取代，请再点一次', reason: 'internal' }
  }
  const url = buildLocalEntryUrl(localPort, card, entry.mt)
    + `#mycoConn=${wonViaRelayLeg ? 'relay' : 'direct'}`
  const title = card.title ?? '任务'
  const ok = deps.openWebView(url, title)
  const ms = (deps.now ?? Date.now)() - t0
  if (!ok) {
    proxy.stop()
    deps.stopListener()
    log('[dsh-open] 打不开页面（原生 WebView 不可用）')
    return { ok: false, message: '打不开任务页面，请重开一次 myco 应用', reason: 'unsupported' }
  }
  log(`[dsh-open] 已打开 ${url}（${ms}ms，via=${entry.via}，本地端口 ${localPort}）`)
  return { ok: true, url, localPort, entry, ms, proxy, candidates: legs }
}

// ══════════════════ provider B：同一份 wire，换**原生隧道**传输 ══════════════════

/**
 * 最近一次 provider B 胜出腿的 kind（单飞护栏保证一次开卡一条链路）。
 * openSharedTask 据此优化：**入口经中继腿拿到**时跳过预热赛跑——预热在此场景
 * 是纯浪费（再拨一条中继隧道只为探路，胜出也不进缓存），省 ~1.5s；
 * 首条页面连接自会赛跑（时延与预热等价，还早开页面）。
 */
let lastBrokerWinLeg: CandidateKind | null = null

/**
 * 多个 Promise 里**第一个成功者**胜（失败被吞计数；全失败才 reject）。
 * 输家的迟到结果被丢弃（tunnelHttpRequest 自带收尾关隧道，无悬挂）。
 */
function firstSuccess<T>(ps: Promise<T | null | void>[]): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = 0
    let won = false
    for (const p of ps) {
      void p.then(
        (v) => {
          settled += 1
          if (!won && v != null) {
            won = true
            resolve(v as T)
          } else if (!won && settled === ps.length) {
            resolve(null)
          }
        },
        () => {
          settled += 1
          if (!won && settled === ps.length) resolve(null)
        },
      )
    }
  })
}

/**
 * 把**同一条** `share-entry-request` 经隧道打到源设备的 **p2p 数据面端口**
 * （`/p2p/msg`），读同一个响应体的 `reply`。
 *
 * 为什么需要这条兜底：WebView 里的跨 origin `fetch` 在个别环境下不可用
 * （不同源策略/预检被拦/混合内容），而原生隧道是 raw TCP，没有这些约束。
 *
 * 2026-10-11 改**并行赛跑**（原为逐候选串行）：直连全断的拓扑里，串行要吃满
 * 每条死腿的拨号超时（真机实测：2 条死 IPv6 ×~5s，中继排在最后 → 兜底取票
 * 12s+）。现在所有候选同时开跑，先 `200 + 回包` 者胜；中继腿的 `delayMs`
 * 让先照认（直连可达时中继腿根本不拨，不占云端会话）。
 *
 * ⚠️ **绝不打本地管理面**（历史实现打 `127.0.0.1:3102/api/dshShare/remoteOpen`，
 * 那要求隧道白名单放通 3102 = 把整个管理面交给隧道，**不是正式方案**）。
 * 现在走的是 p2p 数据面端口（默认 9100，本来就在隧道白名单里），
 * 而且**只发一条 share-entry 请求**（赛跑赢家那条）：源设备侧走的还是那套
 * 设备签名闸 + 授权闸，一个字节的越权面都没有新增。
 */
export async function requestEntryViaTunnel(
  card: ShareCard,
  deps: OpenTaskDeps,
  candidates: Candidate[],
  opts: { prefetch?: boolean } = {},
): Promise<ShareEntry> {
  if (candidates.length === 0) {
    throw new EntryError('offline', `${card.sourceDeviceName ?? '对方设备'}不在线（没有可连接的地址），稍后再试`)
  }
  const now = (deps.now ?? Date.now)()
  const requestId = (deps.randId ?? newRequestId)()
  const payload = shareEntryRequestWire(card, requestId, deps.myDevice, deps.myAccount)
  // R4 口径需要区分"用户点卡取票"与"后台预取票"：预取 grant 的 grant→enter 间隔=用户何时点，
  // 不能计入 R4 的 grant→enter ≤3s。PC 侧审计记录 prefetch=1，R4 判定时跳过。
  if (opts.prefetch) payload.prefetch = true
  const envelope = entryControlEnvelope(
    { account: deps.myAccount, device: deps.myDevice, deviceName: 'myco-phone' },
    card.sourceAccount,
    'share-entry-request',
    payload,
    newControlMsgId(now),
    now,
  )
  const body = JSON.stringify(envelope)
  // 设备签名（签 `did\nts\n<body>`，与 p2p_server::verify_auth 同一口径）。
  // ⚠️ 签名覆盖的必须是**逐字发出去的那一份字节**——先定 body 再签，不再重排。
  const ts = now
  const sig = await deps.identity.sign(tunnelSignMaterial(deps.identity.device, ts, body))
  if (!sig) throw new EntryError('offline', '本机身份未就绪（请重新登录一次 myco）')
  const authHeaders = { 'X-Myco-Auth': tunnelAuthHeader(deps.identity.device, ts, sig) }
  const log = deps.onLog ?? ((): void => {})
  lastBrokerWinLeg = null

  // 并行赛跑：每条候选一条隧道 + 一次 HTTP；先 200+回包 胜出
  let won = false
  let lastErr = ''
  // 2026-10-21（O07 时延根因）：致命拒绝（分享已停止/无权限/过期）不代表"这条腿不行"，
  // 而是**这个分享本身不行**——必须立刻中止整场赛跑并把这句人话抛给上层（触发清卡+提示）。
  // 旧实现把它当普通腿失败吞掉，等其它腿 6s 超时才收摊（实测 10-13s，O07 目标 ≤2s）。
  let fatal: Error | null = null
  let fatalResolve: ((e: Error) => void) | null = null
  const fatalP = new Promise<Error>((res) => { fatalResolve = res })
  const noteFatalLeg = (e: unknown): Error | null => {
    const err = e instanceof Error ? e : new Error(String(e))
    const reason = (err as { reason?: string }).reason
    if (reason === 'gone' || reason === 'denied' || reason === 'expired') {
      if (!fatal) {
        fatal = err
        try { fatalResolve?.(err) } catch { /* ignore */ }
      }
      return err
    }
    return null
  }
  const tasks = candidates.map(async (c) => {
    // 让先（中继腿）：直连候选先跑；已有胜者就不拨（不占云端会话）
    if ((c.delayMs ?? 0) > 0) {
      await new Promise<void>((res) => setTimeout(res, c.delayMs ?? 0))
      if (won) return null
    }
    const p2pPort = deps.p2pPort ?? c.port ?? DEFAULT_P2P_PORT
    const tLeg = (deps.now ?? Date.now)()
    try {
      const resp = await tunnelHttpRequestCached(
        c,
        p2pPort,
        { method: 'POST', path: '/p2p/msg', headers: authHeaders, body },
        deps.identity,
        deps.factory,
        { timeoutMs: 6000, cacheKey: card.sourceDevice },
      )
      if (resp.status !== 200) {
        lastErr = resp.status === 403 ? '对方设备没认下这次请求' : `对方设备返回 ${resp.status}`
        log(`[dsh-open] provider B 腿失败 ${c.kind} status=${resp.status}（${(deps.now ?? Date.now)() - tLeg}ms）`)
        return null
      }
      const reply = parseSyncReply(resp.body, requestId)
      if (!reply) {
        lastErr = '对方设备没给出入口'
        log(`[dsh-open] provider B 腿无回包 ${c.kind}（${(deps.now ?? Date.now)() - tLeg}ms）`)
        return null
      }
      if (won) return null // 输家的迟到结果丢弃（隧道已在 tunnelHttpRequest 收尾关掉）
      won = true
      lastBrokerWinLeg = c.kind
      log(`[dsh-open] provider B 胜出腿：${c.kind}=${c.base.slice(0, 72)}（${(deps.now ?? Date.now)() - tLeg}ms）`)
      return { ...parseGrant(reply, card.shareId, now), via: 'broker' as const }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      const f = noteFatalLeg(e)
      if (f) {
        log(`[dsh-open] provider B 腿致命拒绝 ${c.kind}（${(deps.now ?? Date.now)() - tLeg}ms）: ${lastErr.slice(0, 60)} → 立即中止`)
        return null
      }
      log(`[dsh-open] provider B 腿异常 ${c.kind}（${(deps.now ?? Date.now)() - tLeg}ms）: ${lastErr.slice(0, 80)}`)
      return null
    }
  })
  // 致命拒绝与赛跑取先到者：致命拒绝立刻抛（不再等其他腿超时）
  void fatalP.catch(() => undefined)
  const entry = await Promise.race([
    firstSuccess(tasks),
    fatalP.then((e) => { throw e }),
  ])
  if (!entry) {
    if (fatal) throw fatal
    throw new EntryError('offline', lastErr || `${card.sourceDeviceName ?? '对方设备'}暂时连不上，稍后再试`)
  }
  return entry
}

/**
 * 从 `POST /p2p/msg` 的响应体里取出**同步回包**（纯函数，单测直击）。
 *
 * 契约（与 PC 端 `p2p_server::msg_ok_body` 逐字对应）：
 * `{"ok":true,"kept":bool}`，有回包时多一个 `"reply":{…}`。
 * `requestId` 对不上 → 视为没有（宁可回落到人话，也不拿别人的票）。
 */
export function parseSyncReply(body: string, requestId: string): Record<string, unknown> | null {
  let v: unknown
  try {
    v = JSON.parse(body)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.ok !== true) return null
  const reply = o.reply
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return null
  const r = reply as Record<string, unknown>
  const rid = typeof r.requestId === 'string' ? r.requestId : ''
  if (rid && rid !== requestId) return null
  return r
}

/** Provider C（2026-10-10 移动直连修复）：通过本地代理中继取票。
 * 反向隧道已在桥池里时，POST 到 `http://127.0.0.1:<proxyPort>/p2p/msg` 会
 * 经桥的池隧道路由到 PC 的 :9100（同一条加密隧道，无需额外握手）。 */
async function requestEntryViaProxyRelay(
  card: ShareCard,
  deps: OpenTaskDeps,
  proxyPort: number,
): Promise<ShareEntry> {
  const now = (deps.now ?? Date.now)()
  const requestId = (deps.randId ?? newRequestId)()
  const payload = shareEntryRequestWire(card, requestId, deps.myDevice, deps.myAccount)
  const envelope = entryControlEnvelope(
    { account: deps.myAccount, device: deps.myDevice, deviceName: 'myco-phone' },
    card.sourceAccount,
    'share-entry-request',
    payload,
    newControlMsgId(now),
    now,
  )
  const body = JSON.stringify(envelope)
  const ts = now
  const sig = await deps.identity.sign(tunnelSignMaterial(deps.identity.device, ts, body))
  if (!sig) throw new EntryError('offline', '本机身份未就绪')
  const authHeader = tunnelAuthHeader(deps.identity.device, ts, sig)
  // 用原生 proxyPost（Java HttpURLConnection）——WebView 的 fetch/XHR 从
  // file:// 到 http://127.0.0.1 被同源策略拦（CORS），原生 HTTP 无此限制。
  // proxyPost 返回 {"status":200,"body":"..."} 或 {"status":0,"body":"err"}。
  const shell = (typeof window !== 'undefined' && (window as unknown as { MycoShell?: { proxyPostAsync?: (cb: string, u: string, ct: string, ah: string, b: string) => void; proxyPost?: (u: string, ct: string, ah: string, b: string) => string } }).MycoShell) || null
  if (shell?.proxyPostAsync) {
    // 异步版（正确版）：同步 proxyPost 会死锁——JS 阻塞等 Java → 代理需要
    // JS 处理连接 → JS 被阻塞。异步版在后台线程跑 HTTP，完成后回调 JS。
    // 注意：Java 的 evaluateJavascript 传的是 JSON 字面量（非字符串），
    // 回调收到的是对象——直接用，别再 JSON.parse。
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('proxyPostAsync timeout')), 12000)
      const w = window as unknown as { __ppResolve?: (r: { status: number; body: string } | string) => void }
      w.__ppResolve = (r) => {
        clearTimeout(timer)
        delete w.__ppResolve
        if (typeof r === 'string') {
          try { resolve(JSON.parse(r) as { status: number; body: string }) } catch { reject(new Error('proxyPost 返回格式异常')) }
        } else if (r && typeof r === 'object' && typeof (r as { status?: unknown }).status === 'number') {
          resolve(r)
        } else {
          reject(new Error('proxyPost 返回格式异常'))
        }
      }
      shell.proxyPostAsync!('window.__ppResolve', `http://127.0.0.1:${proxyPort}/p2p/msg`, 'application/json', authHeader, body)
    })
    if (result.status !== 200) {
      throw new EntryError('offline', `对方设备返回 ${result.status}`)
    }
    const reply = parseSyncReply(result.body, requestId)
    if (!reply) throw new EntryError('offline', '对方设备没给出入口')
    return { ...parseGrant(reply, card.shareId, now), via: 'broker' }
  }
  // 降级：无原生方法时用 XHR（旧 APK 兼容；CORS 可能阻止）
  const xhrResult = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `http://127.0.0.1:${proxyPort}/p2p/msg`, true)
    xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.setRequestHeader('X-Myco-Auth', authHeader)
    xhr.timeout = 6000
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText })
    xhr.onerror = () => reject(new Error('proxy relay network error'))
    xhr.ontimeout = () => reject(new Error('proxy relay timeout'))
    xhr.send(body)
  })
  if (xhrResult.status !== 200) {
    throw new EntryError('offline', `对方设备返回 ${xhrResult.status}`)
  }
  const reply = parseSyncReply(xhrResult.body, requestId)
  if (!reply) throw new EntryError('offline', '对方设备没给出入口')
  return { ...parseGrant(reply, card.shareId, now), via: 'broker' }
}


// ══════════════════ UI 文案 ══════════════════

/** 状态 → 卡片下方那行小字（**人话**）。 */
export function statusLine(state: TunnelState, status: TunnelStatus, targetName?: string): string {
  if (state === 'open' && status.opened > 0) return ''
  return statusMessage(state, status.base, targetName)
}
