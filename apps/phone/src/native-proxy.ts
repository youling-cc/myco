/**
 * native-proxy.ts — **原生壳（WebView bridge）**侧的适配：把 `TunnelProxy` 接到 Android 壳上。
 *
 * ── 为什么必须有原生层（硬约束） ───────────────────────────────────────────
 * 两条都是浏览器的能力天花板，不是实现选择：
 *  ① **WebView 里的 JS 不能监听 TCP 端口**。而"点卡就进"要求把
 *     `http://127.0.0.1:<本地端口>/gw/<id>/?mt=…` 交给 WebView 打开——那个本地端口
 *     必须由原生 `ServerSocket` 提供；
 *  ② **`WebSocket` 构造函数不能设自定义请求头**。而隧道握手信封 + 设备签名必须在
 *     `x-myco-tunnel` / `x-myco-auth` 两个头上（PC 端只读 header）。
 *     Service Worker 也拦不住 WS。所以升级握手只能由原生代做（Java 自己发 HTTP
 *     Upgrade + 自己分 RFC6455 帧），JS 只负责**协议层**：握手原文/签名/ECDH/AEAD 帧。
 *
 * 分工（一句话）：**原生搬字节，JS 管协议**。
 *
 * ── 桥的形状（与 `apps/android-shell/src/com/myco/phone/` 逐字对应） ────────
 * JS → 原生（`window.MycoShell.*`，`@JavascriptInterface`）：
 * ```
 *   tunnelStart()                       → {"ok":true,"port":52341}
 *   tunnelStop()
 *   tunnelSend(connId:int, b64:String)  ← 把对端明文写回本地 socket
 *   tunnelClose(connId:int, why:String)
 *   tunnelOpenWs(wsId:String, url:String, headersJson:String) → "" | "ERR:人话"
 *   tunnelWsSend(wsId:String, b64:String)
 *   tunnelWsClose(wsId:String, code:int, reason:String)
 *   openShareWeb(url:String, title:String)
 * ```
 * 原生 → JS（原生用 `evaluateJavascript("window.__mycoTunnel.x(...)")`）：
 * ```
 *   onStart(json)              // 监听就绪（重复调用幂等）
 *   onConn(connId)             // 一条新的本地连接
 *   onData(connId, b64)
 *   onClose(connId, why)
 *   wsOpened(wsId, errOrEmpty)
 *   wsData(wsId, b64)
 *   wsClosed(wsId, code, reason)
 * ```
 * **安全**：原生只绑 `127.0.0.1`、端口随用随开（`ServerSocket(0,...)`），
 * 关页面即 `tunnelStop()` 释放；本地监听不对外暴露。
 */

import { fromB64, toB64, type TunnelSocket, type TunnelSocketFactory } from './p2p-tunnel'
import type { ProxyBridge } from './tunnel-session'

// ══════════════════ 环境探测 ══════════════════

/** 原生壳暴露的名字（与 MainActivity.java 的 addJavascriptInterface 一致）。 */
export const SHELL_NAME = 'MycoShell'
/** JS 收原生日调的回调对象名（原生 evaluateJavascript 用）。 */
export const TUNNEL_CALLBACK_NAME = '__mycoTunnel'

interface ShellApi {
  vnetForwardStart?: (localPort: number) => string
  vnetForwardStop?: (localPort: number) => string
  vnetForwardList?: () => string
  vnetForwardSend?: (localPort: number, connId: number, b64: string) => void
  vnetForwardClose?: (localPort: number, connId: number, why: string) => void

  isApk?: () => boolean
  tunnelStart?: () => string
  tunnelStop?: () => void
  tunnelState?: () => string
  // 2026-10-22 入向 vnet 隧道：拨 127.0.0.1:<port>（JS 开不了 TCP，只能原生）
  tcpDial?: (port: number) => string
  tcpSend?: (connId: number, b64: string) => void
  tcpClose?: (connId: number) => void
  tunnelSend?: (connId: number, b64: string) => void
  tunnelClose?: (connId: number, why: string) => void
  tunnelOpenWs?: (wsId: string, url: string, headersJson: string) => string
  tunnelWsSend?: (wsId: string, b64: string) => void
  tunnelWsClose?: (wsId: string, code: number, reason: string) => void
  openShareWeb?: (url: string, title: string) => void
}

function shell(): ShellApi | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  const s = w[SHELL_NAME]
  return s && typeof s === 'object' ? (s as ShellApi) : null
}

/** 是否跑在 myco 安卓壳里**且**这一版壳带隧道代理能力。 */
export function hasNativeProxy(): boolean {
  const s = shell()
  return !!s && typeof s.tunnelStart === 'function' && typeof s.tunnelOpenWs === 'function'
}

/** 是否跑在 myco 安卓壳里（老版本壳也 true）。 */
export function isApkShell(): boolean {
  const s = shell()
  return !!s && typeof s.isApk === 'function'
}

/** 原生壳版本能力：缺哪一项就退化成什么人话（UI 提示用）。 */
export function nativeProxyGap(): string | null {
  const s = shell()
  if (!s) return '不在 myco 手机应用里打开，任务卡打不开（请用 myco 手机应用）'
  if (typeof s.tunnelStart !== 'function' || typeof s.tunnelOpenWs !== 'function') {
    return '当前 myco 应用版本太旧，打开任务卡需要更新一次应用'
  }
  return null
}

/** 解析 `tunnelStart()` 的返回（纯函数，单测直击）。 */
export function parseStartResult(raw: string): { ok: true; port: number } | { ok: false; err: string } {
  try {
    const j = JSON.parse(raw) as { ok?: boolean; port?: number; err?: string }
    if (j.ok && typeof j.port === 'number' && j.port > 0) return { ok: true, port: j.port }
    return { ok: false, err: j.err ?? '本地端口未就绪' }
  } catch {
    return { ok: false, err: '本地端口未就绪' }
  }
}

// ══════════════════ JS 侧回调对象（原生调用入口） ══════════════════

type ConnCb = (id: number) => void
type DataCb = (id: number, d: Uint8Array) => void
type CloseCb = (id: number) => void
type WsOpenCb = (wsId: string, err: string) => void
type WsDataCb = (wsId: string, d: Uint8Array) => void
type WsCloseCb = (wsId: string, code: number, reason: string) => void

interface CallbackTable {
  start: ((port: number) => void) | null
  conn: ConnCb[]
  data: DataCb[]
  close: CloseCb[]
  wsOpen: WsOpenCb[]
  wsData: WsDataCb[]
  wsClose: WsCloseCb[]
}

function emptyTable(): CallbackTable {
  return { start: null, conn: [], data: [], close: [], wsOpen: [], wsData: [], wsClose: [] }
}

const table: CallbackTable = emptyTable()

/** 安装 `window.__mycoTunnel`（幂等；在 main.tsx 早期调用一次）。 */
export function installNativeBridge(): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as Record<string, unknown>
  if (w[TUNNEL_CALLBACK_NAME]) return
  w[TUNNEL_CALLBACK_NAME] = {
    onStart: (json: string): void => {
      const r = parseStartResult(json)
      if (r.ok) table.start?.(r.port)
    },
    onConn: (id: number): void => {
      for (const cb of [...table.conn]) safe(() => cb(id))
    },
    onData: (id: number, b64: string): void => {
      const d = safeBytes(b64)
      if (!d) return
      for (const cb of [...table.data]) safe(() => cb(id, d))
    },
    onClose: (id: number): void => {
      for (const cb of [...table.close]) safe(() => cb(id))
    },
    wsOpened: (wsId: string, err: string): void => {
      for (const cb of [...table.wsOpen]) safe(() => cb(wsId, err ?? ''))
    },
    wsData: (wsId: string, b64: string): void => {
      const d = safeBytes(b64)
      if (!d) return
      for (const cb of [...table.wsData]) safe(() => cb(wsId, d))
    },
    wsClosed: (wsId: string, code: number, reason: string): void => {
      for (const cb of [...table.wsClose]) safe(() => cb(wsId, code ?? 1006, reason ?? ''))
    },
  }
}

/** 测试/热重载用：清掉回调表。 */
export function _resetNativeBridgeForTest(): void {
  Object.assign(table, emptyTable())
  if (typeof window !== 'undefined') {
    delete (window as unknown as Record<string, unknown>)[TUNNEL_CALLBACK_NAME]
  }
}

function safe(fn: () => void): void {
  try {
    fn()
  } catch (e) {
    // 单个回调出错不能拖垮整条桥（否则一条坏连接会让后续字节全丢）
    console.warn('[myco-tunnel] 回调异常', e)
  }
}

function safeBytes(b64: string): Uint8Array | null {
  try {
    return fromB64(b64)
  } catch {
    return null
  }
}

// ══════════════════ ProxyBridge 的原生实现 ══════════════════

/**
 * `ProxyBridge` 的安卓壳实现。
 * 注意：`onConn/onData/onClose` 是**注册**（原生 → JS），因此本类只把回调塞进 `table`；
 * `write/close` 是**出站**（JS → 原生）。
 */
export class NativeProxyBridge implements ProxyBridge {
  onConn(cb: ConnCb): void {
    table.conn.push(cb)
  }
  onData(cb: DataCb): void {
    table.data.push(cb)
  }
  onClose(cb: CloseCb): void {
    table.close.push(cb)
  }
  write(connId: number, data: Uint8Array): void {
    shell()?.tunnelSend?.(connId, toB64(data))
  }
  close(connId: number, why = ''): void {
    shell()?.tunnelClose?.(connId, why)
  }
}

/** 起本地监听（返回端口）；失败给人话。 */
export function startLocalListener(): Promise<number> {
  const s = shell()
  if (!s?.tunnelStart) return Promise.reject(new Error(nativeProxyGap() ?? '当前应用不支持'))
  return new Promise<number>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        table.start = null
        reject(new Error('本地端口没起来，请重开一次 myco 应用'))
      }
    }, 5000)
    table.start = (port) => {
      if (done) return
      done = true
      clearTimeout(timer)
      table.start = null
      resolve(port)
    }
    const raw = safe3(() => s.tunnelStart!())
    if (raw !== null) {
      // 同步拿到结果（正常路径）：不用等回调
      const r = parseStartResult(raw)
      if (r.ok && !done) {
        done = true
        clearTimeout(timer)
        table.start = null
        resolve(r.port)
      } else if (!r.ok && !done) {
        done = true
        clearTimeout(timer)
        table.start = null
        reject(new Error(r.err))
      }
    }
  })
}

function safe3(fn: () => string): string | null {
  try {
    return fn()
  } catch {
    return null
  }
}

/** 停本地监听（关页面时调）。 */
export function stopLocalListener(): void {
  try {
    shell()?.tunnelStop?.()
  } catch {
    /* 壳已退出 */
  }
}

/** 共享监听是否已在运行（供“临时使用者只停自己启动的监听”判定）。 */
export function isLocalListenerRunning(): boolean {
  const s = shell()
  if (!s?.tunnelState) return false
  const raw = safe3(() => s.tunnelState!())
  if (!raw) return false
  // 原生 snapshot 形如 `proxy port=9100 running=true conns=...`。
  return /\brunning=true\b/.test(raw)
}

/** 让原生开一个新 WebView 打开分享页（**不占用** myco 主界面那个 WebView）。 */
export function openShareInWebView(url: string, title = '任务'): boolean {
  const s = shell()
  if (!s?.openShareWeb) return false
  try {
    s.openShareWeb(url, title)
    return true
  } catch {
    return false
  }
}

// ══════════════════ TunnelSocket 的原生实现（带自定义头的 WS） ══════════════════

let wsSeq = 0

/**
 * 用原生壳开一条**带自定义请求头**的 WS，并把它包装成 `TunnelSocket`。
 *
 * 原生侧只搬字节（RFC6455 掩码/分帧/控制帧都归它），二进制 payload 原样经
 * `wsData/wsSend` 过桥；JS 侧在这之上跑 v2 握手与 AEAD 帧。
 */
export function nativeSocketFactory(): TunnelSocketFactory {
  return (url, headers, signal) =>
    new Promise<TunnelSocket>((resolve, reject) => {
      const s = shell()
      if (!s?.tunnelOpenWs) {
        reject(new Error(nativeProxyGap() ?? '当前应用不支持连接对方设备'))
        return
      }
      const wsId = `w${++wsSeq}-${Date.now().toString(36)}`
      const msgCbs: ((d: Uint8Array) => void)[] = []
      const closeCbs: ((i: { code?: number; reason?: string; error?: string }) => void)[] = []
      // 2026-10-23 回程丢帧根修：无订阅者期间到达的帧**入队**（浏览器 WebSocket 语义
      // ——消息总在事件队列里等 onmessage，绝不因"还没挂回调"而丢），首个 onMessage
      // 注册时同步补投。真机病：22/3389/25037 的服务端首发帧（SSH banner/X.224 CC）
      // 在 openTunnel offMsg() → raceCandidates 80ms settle 窗 → onConn 重挂 onMessage
      // 的窗口内到达，msgCbs 为空即被静默丢弃 → "上行到达、下行丢失"。
      // 上限防滥用（对端发疯不至 OOM；丢最旧的——AEAD 严格递增序号下丢旧帧不破坏链）。
      const MAX_QUEUED_FRAMES = 256
      const rxQueue: Uint8Array[] = []
      let settled = false
      const onAbort = (): void => {
        if (settled) return
        settled = true
        try {
          s.tunnelWsClose?.(wsId, 1000, 'cancelled')
        } catch {
          /* ignore */
        }
        reject(new Error('已取消'))
      }
      signal.addEventListener('abort', onAbort, { once: true })

      table.wsOpen.push((id, err) => {
        if (id !== wsId || settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        if (err) {
          reject(new Error(err))
          return
        }
        resolve({
          send: (d) => {
            try {
              s.tunnelWsSend?.(wsId, toB64(d))
            } catch {
              /* 壳已退 */
            }
          },
          close: (code = 1000, reason = '') => {
            try {
              s.tunnelWsClose?.(wsId, code, reason)
            } catch {
              /* ignore */
            }
          },
          onMessage: (cb) => {
            msgCbs.push(cb)
            // 补投：注册前到达的排队帧（同序、同步——新订阅者立刻看到，零额外时延）
            if (rxQueue.length > 0) {
              const queued = rxQueue.splice(0)
              for (const d of queued) safe(() => cb(d))
            }
            return () => {
              const i = msgCbs.indexOf(cb)
              if (i >= 0) msgCbs.splice(i, 1)
            }
          },
          onClose: (cb) => {
            closeCbs.push(cb)
            return () => {
              const i = closeCbs.indexOf(cb)
              if (i >= 0) closeCbs.splice(i, 1)
            }
          },
        })
      })
      table.wsData.push((id, d) => {
        if (id !== wsId) return
        if (msgCbs.length === 0) {
          // 无人订阅：入队等首个订阅者（见上方注释——这就是 2026-10-23 真机回程丢帧的根因点）
          if (rxQueue.length >= MAX_QUEUED_FRAMES) rxQueue.shift()
          rxQueue.push(d)
          return
        }
        for (const cb of [...msgCbs]) safe(() => cb(d))
      })
      table.wsClose.push((id, code, reason) => {
        if (id !== wsId) return
        for (const cb of [...closeCbs]) safe(() => cb({ code, reason }))
      })

      let headersJson = '{}'
      try {
        headersJson = JSON.stringify(headers)
      } catch {
        /* 不该发生：值都是字符串 */
      }
      const err = safe3(() => s.tunnelOpenWs!(wsId, url, headersJson))
      if (err === null) {
        if (!settled) {
          settled = true
          signal.removeEventListener('abort', onAbort)
          reject(new Error('发起连接失败（应用内部错误）'))
        }
        return
      }
      if (err && err !== '') {
        if (!settled) {
          settled = true
          signal.removeEventListener('abort', onAbort)
          reject(new Error(err))
        }
      }
    })
}

// ══════════════════ 组装：能在手机上跑的那套依赖 ══════════════════

/** 打包给 `TunnelProxy` 用的原生依赖（`factory` + `bridge`）。 */
export function nativeProxyDeps(): { factory: TunnelSocketFactory; bridge: ProxyBridge } {
  installNativeBridge()
  return { factory: nativeSocketFactory(), bridge: new NativeProxyBridge() }
}
