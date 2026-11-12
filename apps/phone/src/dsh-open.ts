/**
 * dsh-open.ts — 隧道上的 HTTP 设施 + 在途护栏（**纯逻辑**，依赖全注入 → 单测不打网络）。
 *
 * 2026-11-12 取票链（openSharedTask/provider B/预取票/复用票）已整链删除：
 * 手机点 DSH 卡的唯一路径是设备隧道 VNETP 直入（dsh-open-runtime.openTaskShare →
 * ensureShareEntryForwardFor(15200) → openShareInWebView）。本文件留下的是仍被
 * 聊天中继/对账/护栏使用的**通用设施**：
 *   · `openHttpTunnelSession` + `httpOverTunnel` — 可复用的隧道 HTTP 会话
 *     （聊天中继每条 3.3s → 100-300ms 的那次修复就靠它）；
 *   · `parseHttpResponse` / `dechunk` — 隧道 HTTP 响应解析（纯函数，单测锁定）；
 *   · `makeSingleFlight` — 单槽在途护栏（openTaskShare 的双击护栏）；
 *   · `makeSerialQueue` — presence addrs 写入串行化（反向意愿不被乱序抹掉）。
 *
 * 生产装配在 `dsh-open-runtime.ts`（那里才 import identity/chat-store）。
 */

import {
  openTunnel,
  type Candidate,
  type FrameIo,
  type OpenTunnelResult,
  type TunnelIdentity,
  type TunnelSocket,
  type TunnelSocketFactory,
} from './p2p-tunnel'

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
 * 在途超时强制复位——复位后原任务仍会继续跑完，但其迟到结果被丢弃。
 *
 * 为什么需要它（真机"开卡后点卡再也没反应"排查项之一）：开卡链路任何一步
 * 永久挂起（网络无超时、原生桥不回包、Promise 泄漏），在途变量就永远非 null，
 * 后续所有开卡都被护栏挡住。超时兜底复位后用户再点一次即可重来。
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
