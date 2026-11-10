/**
 * p2p-data-face.ts — 手机侧「帧内 HTTP」数据面（2026-10-12 PC→手机 聊天中继的
 * 落地件；2026-10-19 凌晨 Phase 1：**HTTP/1.1 keep-alive 持久隧道**）。
 *
 * 背景：PC 经云中继/反向隧道拨来的加密隧道，帧里承载的是 HTTP 请求（与 PC 侧
 * `p2p_post_via_local` 的对偶——PC 侧隧道泵到 loopback:9100 由 p2p_server 应答；
 * 手机浏览器开不了监听端口，所以这个"应答"由本模块在**帧层**直接做）。
 *
 * 职责（一个端口一个路径）：
 *   · `POST /p2p/msg` → `ingestWireMsg`（chat-store 的既有入口：验签/幂等/落盘/
 *     群扇出全套）→ 回 `{"ok":true,...}`（与 PC p2p_server 的 msg_ok_body 同形）
 *   · 其他路径（含 PC 侧心跳 OPTIONS/HEAD）→ 404（**keep-alive 下不关连接**）
 *
 * 2026-10-19 改造（task「持久隧道」，指标见 tmp-shots/persistent-tunnel-metrics.md）：
 * 原实现"一条隧道一次 HTTP（Connection: close）"→ PC 每条消息都要重新建一次
 * 隧道 WS+AEAD 握手（0.5-1.5s > 600ms 消息间隔）→ 10×600ms 连发必然排队超时
 * （真机 0/10）。现在：
 *   ① 应答后**不关底层连接**，同一 TCP 上继续解析下一个 HTTP 请求（keep-alive）；
 *   ② 空闲 `IDLE_CLOSE_MS`（120s）无新请求才关闭（对齐中继 50s 换注册 + NAT 余量）；
 *   ③ 单个请求头/体攒齐上限 `REQ_TIMEOUT_MS`（15s），超时只关本条隧道；
 *   ④ JS 单线程：多个请求按帧到达顺序串行处理（`ingestWireMsg` 异步等待期间新帧
 *      只是进缓冲，不会乱序）；
 *   ⑤ 边界：支持 `Content-Length`；`Transfer-Encoding: chunked` 暂不支持（400 + 关）；
 *      客户端带 `Connection: close` 时回完即关。
 *
 * 接线：ReverseShareBridge.runAccept 过闸后按信封 `port===9100` 分流到这里
 * （13911 照旧进分享桥的池）。
 */
import type { ReverseTunnelSession } from './p2p-tunnel'
import { ingestWireMsg } from './p2p'

/** 单个请求攒齐（头+体）的时限（慢启动预留；正常 <1s）。 */
const REQ_TIMEOUT_MS = 15_000
/** keep-alive 空闲回收：120s 内没有新请求 → 关隧道（指标 T7 要求 120s 内不重建）。 */
const IDLE_CLOSE_MS = 120_000
/** 等待新字节的轮询粒度（与旧实现一致；唤醒变量优先，定时器兜底）。 */
const WAIT_TICK_MS = 25

interface HttpReq {
  path: string
  len: number
  headEnd: number
  keepAlive: boolean
}

function httpResponse(status: number, reason: string, body: string, keepAlive: boolean): Uint8Array {
  const head = [
    `HTTP/1.1 ${status} ${reason}`,
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${new TextEncoder().encode(body).length}`,
    `Connection: ${keepAlive ? 'keep-alive' : 'close'}`,
  ].join('\r\n')
  return new TextEncoder().encode(`${head}\r\n\r\n${body}`)
}

/** 找 HTTP 头结束位置（`\r\n\r\n`），返回头后第一个字节下标；没有则 -1。 */
function findHeadEnd(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i + 4
  }
  return -1
}

/**
 * 从原始字节解析一个完整请求（头已到齐；体按 Content-Length 判满）。
 * `null` = 还未攒齐（需要更多字节）。`{bad:true}` = 协议不支持（chunked/坏头），需 400 关连接。
 */
function parseRequest(buf: Uint8Array): HttpReq | null | { bad: true } {
  const headEnd = findHeadEnd(buf)
  if (headEnd < 0) return null
  const headText = new TextDecoder('latin1').decode(buf.subarray(0, headEnd))
  const firstLine = headText.slice(0, headText.indexOf('\r\n'))
  const parts = firstLine.split(' ')
  if (parts.length < 2) return { bad: true }
  const lenMatch = /content-length:\s*(\d+)/i.exec(headText)
  const len = lenMatch ? Number(lenMatch[1]) : 0
  if (!Number.isFinite(len) || len < 0 || len > 4 * 1024 * 1024) return { bad: true }
  if (/transfer-encoding:\s*chunked/i.test(headText)) return { bad: true }
  // 默认 keep-alive（HTTP/1.1 语义）；显式 `Connection: close` 时回完即关。
  const connMatch = /connection:\s*([^\r\n]+)/i.exec(headText)
  const conn = connMatch ? connMatch[1].trim().toLowerCase() : ''
  const keepAlive = !conn.split(',').map((s) => s.trim()).includes('close')
  return { path: parts[1], len, headEnd, keepAlive }
}

/**
 * 服务一条 9100 隧道：keep-alive 循环——收请求 → 应答 → **继续收下一个**；
 * 空闲 120s 或对端关闭/协议错才关隧道。任何错误只影响本条隧道。
 */
export async function serveP2pDataFace(t: ReverseTunnelSession, log: (l: string) => void = () => {}): Promise<void> {
  /** 未消费字节（可能含多个流水线请求）。 */
  let buf = new Uint8Array(0)
  let done = false
  let wake: (() => void) | null = null
  const notify = (): void => {
    const w = wake
    wake = null
    w?.()
  }
  const offMsg = t.onMessage((pt) => {
    const next = new Uint8Array(buf.length + pt.length)
    next.set(buf, 0)
    next.set(pt, buf.length)
    buf = next
    notify()
  })
  const offClose = t.onClose(() => {
    done = true
    notify()
  })

  /** 等到条件满足；`ms` 内没结果返回 false；对端关闭返回 false。 */
  const waitUntil = async (pred: () => boolean, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms
    while (!pred()) {
      if (done) return false
      const left = deadline - Date.now()
      if (left <= 0) return false
      await new Promise<void>((res) => {
        wake = res
        setTimeout(res, Math.min(WAIT_TICK_MS, left))
      })
    }
    return true
  }

  let served = 0
  try {
    // 外层循环：一条 keep-alive 连接上处理多个请求。
    for (;;) {
      // ① 等头到齐：已有半个请求时用 REQ_TIMEOUT_MS，连接空闲时用 IDLE_CLOSE_MS。
      const hasPartial = buf.length > 0
      const ready = await waitUntil(
        () => findHeadEnd(buf) >= 0,
        hasPartial ? REQ_TIMEOUT_MS : IDLE_CLOSE_MS,
      )
      if (!ready) {
        if (buf.length > 0) log(`[p2p-data-face] 请求头不完整（${buf.length}B），关隧道`)
        return
      }
      // ② 等体到齐。
      let req = parseRequest(buf)
      if (req && !('bad' in req) && buf.length < req.headEnd + req.len) {
        const full = await waitUntil(
          () => {
            const r = parseRequest(buf)
            return !!r && !('bad' in r) && buf.length >= r.headEnd + r.len
          },
          REQ_TIMEOUT_MS,
        )
        if (!full) {
          log('[p2p-data-face] 请求体不完整（超时），关隧道')
          return
        }
        req = parseRequest(buf)
      }
      if (!req) return
      if ('bad' in req) {
        t.send(httpResponse(400, 'Bad Request', JSON.stringify({ ok: false, error: 'unsupported http framing' }), false))
        log('[p2p-data-face] 不支持的 HTTP framing（chunked/坏头），回 400 并关')
        return
      }
      const consumed = req.headEnd + req.len
      const bodyText = new TextDecoder('utf-8').decode(buf.subarray(req.headEnd, consumed))
      buf = buf.subarray(consumed) // 保留流水线里后续请求的字节
      // ③ 应答（keep-alive 下不关连接）。
      if (req.path.startsWith('/p2p/msg')) {
        let out: string
        try {
          const env = JSON.parse(bodyText) as Record<string, unknown>
          const kept = await ingestWireMsg(env)
          out = JSON.stringify({ ok: true, kept: !!kept })
        } catch (e) {
          out = JSON.stringify({ ok: false, error: String(e instanceof Error ? e.message : e) })
        }
        t.send(httpResponse(200, 'OK', out, req.keepAlive))
        served++
        log(`[p2p-data-face] /p2p/msg 已应答（peer=…${t.peer.device.slice(-4)} ${bodyText.length}B，总 ${served}，keep-alive=${req.keepAlive}）`)
      } else {
        t.send(httpResponse(404, 'Not Found', JSON.stringify({ ok: false, error: 'unsupported path' }), req.keepAlive))
        log(`[p2p-data-face] 拒未知路径 ${req.path}（keep-alive 继续）`)
      }
      if (!req.keepAlive) return
      // ④ 回到循环顶部——同一 TCP 上继续等下一个请求（空闲 120s 自动关）。
    }
  } finally {
    offMsg()
    offClose()
    t.close()
  }
}

/** 测试导出：闲时/单请求超时阈值（避免魔法数散落）。 */
export const P2P_DATA_FACE_LIMITS = { REQ_TIMEOUT_MS, IDLE_CLOSE_MS } as const
