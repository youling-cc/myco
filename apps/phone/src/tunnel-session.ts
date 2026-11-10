/**
 * tunnel-session.ts — 隧道**会话层**：连接生命周期、断线无感重连、状态机。
 *
 * 分工：
 *   · `p2p-tunnel.ts`  只管**一条** WS 的线协议（握手 + AEAD 帧 + 并行选路）；
 *   · 本文件管**很多条**：本地每条 TCP 连接对应一条隧道（与 PC 端 `tunnel_conn` 同构），
 *     以及"断了怎么办"——候选重探 + 退避 + 恢复后本地下一条连接立刻可用。
 *
 * ── 为什么一条本地连接 = 一条隧道 ─────────────────────────────────────────
 * PC 端 `p2p_tunnel::tunnel_serve` 的结构是：**每接受一条 WS，就连一条
 * 127.0.0.1:<port> 的新 TCP**。所以隧道不是"一条长管道"，而是"每 TCP 连接一条"。
 * 手机侧照抄这个语义（不是发明）：原生代理 accept 到一条本地连接 → 让 JS 开一条隧道。
 *
 * ── "断线无感"是怎么做到的（用户口径：断开后自动重连，恢复后页面继续可用） ──
 * 1. **本地监听永不关**：代理端口在整个分享页生命周期内保持（PC 端也这么做：
 *    `TUNNEL_IDLE_MS` 30 分钟才回收）。浏览器/SPA 脚下的 TCP 断了，它会自己重连，
 *    而重连打到的还是这个端口；
 * 2. **每条新连接都重新赛跑**：不退化成"死记住上次那条"，所以换网（WiFi↔蜂窝）、
 *    对端换 IP 之后下一条连接自动走通的那条腿；
 * 3. **健康探针**：一次失败后按退避（0.3s→0.6s→1.2s→2.4s→4.8s→8s 封顶）重探候选，
 *    探通即把状态翻回 `open` 并刷新"上次胜出"缓存（下次优先那条腿）；
 * 4. **状态外发**：每次状态翻转都通过 `onStatus` 通知 UI/原生（"已断开，正在重连"→
 *    "已恢复"），用户看到的不是白屏而是一句人话。
 *
 * 单测（tunnel-session.test.ts）覆盖：状态机迁移、退避序列、断线后下一条连接自动恢复、
 * 恢复后缓存被刷新、`stop()` 幂等且不再重连。
 */

import {
  FrameIo,
  TunnelFrameError,
  noRouteHint,
  raceCandidates,
  type Candidate,
  type OpenTunnelResult,
  type TunnelIdentity,
  type TunnelSocket,
  type TunnelSocketFactory,
} from './p2p-tunnel'

// ══════════════════ 状态 ══════════════════

/** 会话状态（UI 只认这四个）。 */
export type TunnelState =
  /** 还没开始 / 已 stop */
  | 'idle'
  /** 首条连接正在建（用户点卡后看到的第一屏） */
  | 'connecting'
  /** 至少一条连接建通过（页面可用） */
  | 'open'
  /** 上一轮全失败，正在退避重试（页面还开着，但新连接暂时打不通） */
  | 'degraded'
  /** 已停止（用户离开分享页 / 主动关） */
  | 'closed'

/** 状态快照（`onStatus` 回调的载荷）。 */
export interface TunnelStatus {
  state: TunnelState
  /** 当前胜出候选的 base（有则下次优先）。 */
  base: string | null
  /** 已建立过的连接数（累计，含重连）。 */
  opened: number
  /** 失败的连接数（累计）。 */
  failed: number
  /** 第几次重连尝试（成功后归零）。 */
  attempt: number
  /** 人类可读的一句话（**不吐 tunnel/p2p/端口**）。 */
  message: string
}

/** 退避序列（ms；封顶 8s）。与"重连"语义相配：前几次快，久不通就慢下来别耗电。 */
export const RECONNECT_BACKOFF_MS = [300, 600, 1200, 2400, 4800, 8000] as const

/** 纯函数（单测直击）：第 n 次重试（0 基）等多久。 */
export function backoffFor(attempt: number, schedule: readonly number[] = RECONNECT_BACKOFF_MS): number {
  if (attempt <= 0) return schedule[0]
  return schedule[Math.min(attempt, schedule.length - 1)]
}

/** 状态文案（**人话**：不出现 tunnel / p2p / 端口 / 隧道 这些词）。 */
export function statusMessage(state: TunnelState, base: string | null, targetName?: string): string {
  const who = targetName ?? '对方设备'
  switch (state) {
    case 'idle':
      return ''
    case 'connecting':
      return `正在连接${who}…`
    case 'open':
      return base ? `已连接${who}` : `已连接${who}`
    case 'degraded':
      return `和${who}的连接断了，正在自动重连…（页面会自己恢复，不用刷新）`
    case 'closed':
      return `已断开与${who}的连接`
  }
}

// ══════════════════ 本地连接（原生代理暴露给 JS 的一条） ══════════════════

/**
 * 原生代理 ↔ JS 的桥。生产实现见 `native-proxy.ts`（WebView bridge）；
 * 测试用内存实现（把"浏览器侧"和"隧道侧"接起来）。
 *
 * 数据流：
 * ```
 *   浏览器 TCP ──▶ 原生 ServerSocket ──onData(connId,b64)──▶ JS ──seal──▶ 隧道 WS ──▶ PC
 *   浏览器 TCP ◀── 原生 write ◀──write(connId,b64)── JS ◀──open── 隧道 WS ◀── PC
 * ```
 */
export interface ProxyBridge {
  /** 原生侧通知：有一条新的本地连接要开隧道。 */
  onConn(cb: (connId: number) => void): void
  /** 原生侧通知：本地连接送来一段字节（明文）。 */
  onData(cb: (connId: number, data: Uint8Array) => void): void
  /** 原生侧通知：本地连接已关（浏览器侧关了 / 出错）。 */
  onClose(cb: (connId: number) => void): void
  /** JS → 原生：把从对端解出来的明文写回本地 socket。 */
  write(connId: number, data: Uint8Array): void
  /** JS → 原生：关掉本地 socket（隧道断了/协议错）。 */
  close(connId: number): void
}

/** 简单 KV（缓存"上次胜出地址"；生产=localStorage，测试=内存）。 */
export interface TunnelKv {
  get(key: string): string | null
  set(key: string, value: string): void
}

/** 内存 KV（测试/无 localStorage 环境）。 */
export function memKv(init: Record<string, string> = {}): TunnelKv {
  const m = new Map(Object.entries(init))
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => {
      m.set(k, v)
    },
  }
}

/** 运行时依赖（全部可注入 → 单测不需要 DOM/timer 真等）。 */
export interface TunnelProxyDeps {
  /** 候选（调用方负责"此刻"的寻址；重探时会重新调用 `refreshCandidates`）。 */
  candidates: Candidate[]
  /** 目标端口（PC 上要被访问的那个：分享网关 13911 / p2p 服务器 9100）。 */
  targetPort: number
  identity: TunnelIdentity
  /** WS 工厂（生产=原生壳；测试=内存对）。 */
  factory: TunnelSocketFactory
  bridge: ProxyBridge
  /** 重新取候选（换网/对端换地址后；不传=沿用初始清单）。 */
  refreshCandidates?: () => Candidate[]
  kv?: TunnelKv
  /** 缓存键（默认按设备+端口）。 */
  cacheKey?: string
  /** 对象名（人话文案用）。 */
  targetName?: string
  onStatus?: (s: TunnelStatus) => void
  /** 可注入时钟/定时（测试快进）。 */
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  /** 单条连接的建连预算（默认走 raceCandidates 的默认值）。 */
  perCandidateMs?: number
  totalBudgetMs?: number
}

// ══════════════════ 会话 ══════════════════

interface Conn {
  id: number
  io: FrameIo | null
  socket: TunnelSocket | null
  /** 隧道还没建好时先攒着浏览器发来的字节（HTTP 首包常常抢先到）。 */
  pending: Uint8Array[]
  closed: boolean
}

/**
 * 隧道代理会话：管住"本地连接 ↔ 隧道"的全部映射 + 断线重连。
 *
 * 用法（React 侧）：
 * ```ts
 * const proxy = new TunnelProxy({...})
 * proxy.start()             // 起本地监听（原生）+ 首批连接
 * const port = proxy.localPort  // 交给 WebView 打开 http://127.0.0.1:<port>/gw/<id>/?mt=…
 * ...
 * proxy.stop()              // 离开页面时释放端口
 * ```
 */
export class TunnelProxy {
  private readonly deps: TunnelProxyDeps
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (h: unknown) => void
  private readonly kv: TunnelKv
  private readonly cacheKey: string

  private conns = new Map<number, Conn>()
  private timer: unknown = null
  private stopped = false
  private state: TunnelState = 'idle'
  private base: string | null = null
  private opened = 0
  private failed = 0
  private attempt = 0
  private lastMsg = ''
  /** 一次"探路"在飞时避免叠加。 */
  private probing = false
  /** 网络切换发生在探路中：结束后立刻用新候选再探一轮。 */
  private pendingNetworkReset = false
  private detach: (() => void)[] = []

  constructor(deps: TunnelProxyDeps) {
    this.deps = deps
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer =
      deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.kv = deps.kv ?? memKv()
    this.cacheKey = deps.cacheKey ?? `myco.tunnel.base.${deps.targetPort}`
  }

  /** 当前状态快照。 */
  get status(): TunnelStatus {
    return {
      state: this.state,
      base: this.base,
      opened: this.opened,
      failed: this.failed,
      attempt: this.attempt,
      message: this.lastMsg,
    }
  }

  /** 起会话：接桥 + 载入缓存候选 + 开始服务。 */
  start(): void {
    if (this.state !== 'idle') return
    this.stopped = false
    const cached = this.kv.get(this.cacheKey)
    if (cached && !this.base) this.base = cached
    this.deps.bridge.onConn((id) => this.onLocalConn(id))
    this.deps.bridge.onData((id, d) => this.onLocalData(id, d))
    this.deps.bridge.onClose((id) => this.closeConn(id, 'local-closed'))
    this.setState('connecting')
  }

  /** 停会话（幂等）：关掉所有在途连接 + 取消重连定时器。 */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    for (const id of [...this.conns.keys()]) this.closeConn(id, 'proxy-stopped')
    for (const off of this.detach) off()
    this.detach = []
    this.setState('closed')
  }

  /** 诊断：当前候选顺序（重探后可能变化）。 */
  currentCandidates(): Candidate[] {
    return this.orderedCandidates()
  }

  // ── 候选 ──

  private orderedCandidates(): Candidate[] {
    const fresh = this.deps.refreshCandidates?.() ?? this.deps.candidates
    const cachedBase = this.base ?? this.kv.get(this.cacheKey)
    if (!cachedBase) return fresh
    // 上次胜出的那条排最前（但**不排除其它腿**——它可能已经不可达了）
    const head = fresh.filter((c) => c.base === cachedBase || c.base === this.base)
    const tail = fresh.filter((c) => !head.includes(c))
    return [...head, ...tail]
  }

  // ── 本地连接生命周期 ──

  private onLocalConn(id: number): void {
    if (this.stopped) {
      this.deps.bridge.close(id)
      return
    }
    this.conns.set(id, { id, io: null, socket: null, pending: [], closed: false })
    void this.openConn(id)
  }

  private onLocalData(id: number, data: Uint8Array): void {
    const c = this.conns.get(id)
    if (!c || c.closed) return
    if (!c.io || !c.socket) {
      // 隧道还在建：先攒着（HTTP 首包会抢在握手前到达）
      c.pending.push(data)
      return
    }
    this.sendUpstream(c, data)
  }

  private sendUpstream(c: Conn, data: Uint8Array): void {
    if (!c.io || !c.socket) return
    try {
      // 单帧 ≤ 16KB（与 PC 端 TUNNEL_CHUNK 同量级；帧边界不必对齐 TCP 读边界）
      for (let i = 0; i < data.length; i += 16 * 1024) {
        c.socket.send(c.io.seal(data.subarray(i, i + 16 * 1024)))
      }
    } catch (e) {
      // 先摘连接再判状态（noteFailure 看的是"还剩几条活连接"）
      this.closeConn(c.id, 'seal-failed')
      this.noteFailure(e)
    }
  }

  private async openConn(id: number): Promise<void> {
    const c = this.conns.get(id)
    if (!c || c.closed) return
    const cands = this.orderedCandidates()
    if (cands.length === 0) {
      this.closeConn(id, 'no-candidates')
      this.noteFailure(new Error('no-candidates'))
      return
    }
    try {
      const raced = await raceCandidates(cands, {
        identity: this.deps.identity,
        targetPort: this.deps.targetPort,
        factory: this.deps.factory,
        perCandidateMs: this.deps.perCandidateMs,
        totalBudgetMs: this.deps.totalBudgetMs,
      })
      // 建连期间浏览器可能已经把连接关了
      if (this.stopped || c.closed || !this.conns.has(id)) {
        if (raced) {
          try {
            raced.winner.socket.close(1000, 'conn-gone')
          } catch {
            /* ignore */
          }
        }
        return
      }
      if (!raced) {
        // 全候选失败：关本地连接（让浏览器/SPA 自己重连）+ 进重连状态机
        this.closeConn(id, 'connect-failed')
        this.noteFailure(new Error('all-candidates-failed'))
        return
      }
      this.attach(c, raced.winner)
    } catch (e) {
      this.closeConn(id, 'connect-error')
      this.noteFailure(e)
    }
  }

  private attach(c: Conn, r: OpenTunnelResult): void {
    c.io = r.io
    c.socket = r.socket
    this.base = r.base
    this.kv.set(this.cacheKey, r.base)
    this.opened += 1
    this.attempt = 0
    this.setState('open')
    // 隧道 → 本地
    r.socket.onMessage((frame) => {
      try {
        const pt = c.io!.open(frame)
        // 解出的明文可能一帧里包着多段，原样交回原生写本地 socket
        for (let i = 0; i < pt.length; i += 32 * 1024) {
          this.deps.bridge.write(c.id, pt.subarray(i, i + 32 * 1024))
        }
      } catch (e) {
        this.closeConn(c.id, 'open-failed')
        this.noteFailure(e)
      }
    })
    r.socket.onClose(() => {
      // **对端关/网断**：这条本地连接废了（TCP 语义上没法"续上"），
      // 关掉它让浏览器/SPA 自己重连——重连打到同一个本地端口，会自动再建一条隧道。
      this.closeConn(c.id, 'tunnel-closed')
      this.noteFailure(new Error('tunnel-closed'))
    })
    // 攒着的首包此刻补发
    const pending = c.pending
    c.pending = []
    for (const d of pending) this.sendUpstream(c, d)
  }

  private closeConn(id: number, why: string): void {
    const c = this.conns.get(id)
    if (!c) return
    c.closed = true
    this.conns.delete(id)
    try {
      c.socket?.close(1000, why)
    } catch {
      /* 已断 */
    }
    try {
      this.deps.bridge.close(id)
    } catch {
      /* 原生侧可能已关 */
    }
    void why
  }

  // ── 失败 → 状态机 + 退避重探 ──

  private noteFailure(e: unknown): void {
    this.failed += 1
    const code = e instanceof TunnelFrameError ? e.code : ''
    // 协议/安全类错误不重试（重试也不会变好，且可能是攻击信号）
    const fatal = code === 'confirm-mismatch' || code === 'key-rejected'
    if (fatal) {
      this.setState('degraded')
      return
    }
    // ⚠️ 调用方必须**先** closeConn 再调本函数：这里判的是"还剩几条活连接"。
    // 还有别的活连接 → 不翻状态（避免"看得好好的突然提示断了"）。
    if (this.conns.size > 0) return
    this.setState('degraded')
    this.scheduleReprobe()
  }

  private scheduleReprobe(): void {
    if (this.stopped || this.timer !== null) return
    const delay = backoffFor(this.attempt)
    this.attempt += 1
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.reprobe()
    }, delay)
  }

  /**
   * 探路：并行赛跑建一次隧道（成功即关掉），刷新"上次胜出"。
   * 探通 → 状态回 `open`；探不通 → 继续退避。
   */
  private async reprobe(): Promise<void> {
    if (this.stopped || this.probing) return
    const cands = this.orderedCandidates()
    if (cands.length === 0) {
      this.setState('degraded')
      return
    }
    this.probing = true
    try {
      const raced = await raceCandidates(cands, {
        identity: this.deps.identity,
        targetPort: this.deps.targetPort,
        factory: this.deps.factory,
        perCandidateMs: this.deps.perCandidateMs,
        totalBudgetMs: this.deps.totalBudgetMs,
      })
      if (this.stopped) {
        if (raced) {
          try {
            raced.winner.socket.close(1000, 'stopped')
          } catch {
            /* ignore */
          }
        }
        return
      }
      if (!raced) {
        this.setState('degraded')
        // 探不通 → 继续退避（timer 在 reprobe 入口已被清空，这里安全重排）
        this.scheduleReprobe()
        return
      }
      this.base = raced.winner.base
      this.kv.set(this.cacheKey, raced.winner.base)
      this.attempt = 0
      this.setState('open')
      try {
        raced.winner.socket.close(1000, 'probe-done')
      } catch {
        /* ignore */
      }
    } finally {
      this.probing = false
      if (this.pendingNetworkReset && !this.stopped) {
        this.pendingNetworkReset = false
        void this.reprobe()
      }
    }
  }

  /** 显式重试一次（UI 上的"重试"按钮；绕过退避）。 */
  async retryNow(): Promise<void> {
    if (this.stopped) return
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    this.attempt = 0
    await this.reprobe()
  }

  /**
   * 网络切换（WiFi↔蜂窝/外部WiFi）强制重探（2026-10-30 真案）。
   *
   * 旧实现只有 state=degraded 才重探；换网后半开 WS 仍可能显示 open，
   * `__mycoTick` 直接 noop。这里主动关掉全部本地连接（浏览器会自动重连），
   * 清退避并立刻用 refreshCandidates 的新地址重探。
   */
  async forceNetworkReset(): Promise<void> {
    if (this.stopped) return
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    this.attempt = 0
    for (const id of [...this.conns.keys()]) this.closeConn(id, 'network-changed')
    this.setState('degraded')
    if (this.probing) {
      // 当前探路还在旧网络上：等它结束后由 finally 再跑一轮，不叠加并发赛跑。
      this.pendingNetworkReset = true
      return
    }
    await this.reprobe()
  }

  private setState(s: TunnelState): void {
    this.state = s
    this.lastMsg = statusMessage(s, this.base, this.deps.targetName)
    this.deps.onStatus?.(this.status)
  }
}

/** 建连失败的人话（把 raceCandidates 的 null 翻成用户能懂的话）。 */
export function failureMessage(targetName: string, candidates: Candidate[]): string {
  return noRouteHint(targetName, candidates)
}
