// relay.mjs — 云端 TCP 中继（DSH 分享连接阶梯第 ④ 级，2026-10-11）
//
// ## 为什么需要
// P2P 隧道（p2p_tunnel.rs）的直连阶梯 ①LAN ②IPv6/公网 ③反向/打洞，在"双方都在
// NAT 后且无端口映射/锥形 NAT/全球 IPv6"的拓扑下全部打不通（例：笔记本挂手机
// 热点 → PC 在家宽光猫后面）。产品要求"所有网络下都能成功，优先直连，不行就
// 云端，别要求用户去哪上网"——本模块就是那个"云端"：identity-svc 上的纯字节中继。
//
// ## 协议（端口 RELAY_PORT=8322，TCP；先按行收命令，配对后纯字节转发）
// ```text
// Provider（PC 的 myco，长连控制通道）：
//   → REGISTER <deviceDid>\n            ← OK\n（同 did 重复注册踢旧连，last-wins）
//   → \n                                （空行心跳；CONTROL_IDLE_MS 无数据断开）
//   ← SESSION <sessionId>\n             （consumer 到访，请开新连接接单）
//   → ACCEPT <deviceDid> <sessionId>\n  （在【新】连接上发；发完即成纯字节管道）
//
// Consumer（笔记本/手机的 myco）：
//   → CONNECT <targetDeviceDid>\n
//   ← OK\n          （配对成功；此后本连接与 provider 的 ACCEPT 连接纯字节对接）
//   ← NOT_FOUND\n   （目标设备未注册中继 / 已掉线；随即断开）
//   ← BUSY\n        （目标设备并发会话达上限）
//   ← UNAVAILABLE\n （SESSION 已下发但 PAIR_TIMEOUT_MS 内没等到 provider ACCEPT）
// ```
//
// ## 为什么是"控制连 + 会话连"，而不是把 REGISTER 连直接当管道
// 一条 DSH 分享页 = 多条并发 TCP（HTTP ×N + remote.mux 的 WS）。若把 consumer
// 直接 pipe 到共享的 REGISTER 连接：①同时只服务一个 consumer；②第二个 consumer
// 的字节会串进第一个的流（协议直接报废）。frp 同款模式：控制连只传信令
// （SESSION），每条会话由 provider 新开一条连接（ACCEPT）与 consumer 一一对接
// ——并发不受限，控制连永不被数据占用。
//
// ## 安全边界（诚实标注）
// 中继只搬字节：REGISTER/CONNECT 不带签名（did 仅作路由键）。真正的安全在隧道
// 协议自身——consumer 在中继连接上照常跑 /p2p/tunnel 的 WS 升级 + 设备签名信封
// + AEAD，provider 侧 p2p 服务器验签/端口白名单/授权钩子一道不少。恶意第三方
// 抢注别人 did 的后果 = 收到一堆自己无法完成握手的隧道请求（无钥即 403），不构
// 成身份冒充。中继服务器理论上可观测流量时序/大小（内容有 AEAD，与现有 ws://
// 直连同一信任面）。
//
// ## 带宽限制（QoS，2026-10-23 加）
//
// **为什么在字节层做**：客户端（PC Rust / 手机 JS）协议不能改，限流必须对客户端
// 完全透明。全链路唯一"看得见整条字节流"的位置就是这里的纯转发路径。
//
// **为什么是"读暂停 + 定时补充令牌"而不是丢包**：令牌不足时 `source.pause()`——
// 字节留在内核接收缓冲里，一个都不丢；补充后 `resume()` 按原序继续。保序由
// "同一时刻只有一条 link 在写"天然保证，不需要重排缓冲。
//
// **为什么两层（每会话 + 全局）都要**：只有会话层 → N 个会话各自满速，总量 = N×L，
// 出口照样被打爆；只有全局层 → 一个会话能吃掉全部份额，别的用户在排队（不公平）。
// 两层同时扣令牌（取 min），既防单会话刷爆、又防总量越界。
//
// **全局桶把上下行算在一起**：中继出口带宽是双向共享的物理资源，分开算等于
// "实际能跑 2×L"，与运维承诺的 L 不符（task.md RQ4 / 风险 K4）。
//
// **默认完全关闭**（两个 MBPS 都是 0）：业务优先——限流是防滥用的闸，不是产品默认。
//
// 零 npm 依赖：node:net + node:crypto + node:fs（只读 relay-qos.json）。

import net from 'node:net'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __qosDir = dirname(fileURLToPath(import.meta.url))

/// 控制连（REGISTER）空闲断开：60s 无任何数据（心跳空行也算数据）。
const CONTROL_IDLE_MS = 60_000
/// 会话连空闲断开：15min 无数据（浏览器 idle 的 WS 别误杀；TCP keepalive 兜底半开）。
const SESSION_IDLE_MS = 15 * 60_000
/// consumer 等待 provider ACCEPT 的上限。
const PAIR_TIMEOUT_MS = 5_000
/// 单 provider 并发会话上限（含等配对的；防一台设备被 CONNECT 洪水打爆）。
///
/// 2026-10-15：16 → 128（真案：手机点卡报「「OFFICE-PC」在线但连不上（已自动重试 3 次）」）。
/// 证据链（中继侧日志）：30min 内对同一台 PC 的 CONNECT 有 63% 被 BUSY 挡回
/// （68 BUSY / 39 paired），而一旦有空槽配对率是 100%（39/39）——中继腿本身好，
/// 卡的就是这个上限。**16 比自家客户端的日常水位还小**：一个 DSH 分享页经中继要开
/// WS + 挂起长探 + 并发 HTTP，近十条 TCP；再叠一个已打开的旧页面就越界。
/// 且中继回收是正常的（隔离探针：25 条串行会话全 OK、零泄漏），所以不是漏卡槽，
/// 是上限设得太贴。上限只防洪水，不必贴着正常连接数。
const MAX_SESSIONS_PER_PROVIDER = Number(process.env.RELAY_MAX_SESSIONS || 128)
/// 空占位会话回收：配对后 N ms 内**双向零字节**＝谁都没用它（半开/泄漏），立刻收掉。
/// 为什么不只靠 SESSION_IDLE_MS(15min)：一串泄漏能把卡槽占满十几分钟，期间真用户
/// 点卡只会拿到 BUSY；而真有流量的会话一个字节都不会少给它。
const DEAD_PAIR_MS = Number(process.env.RELAY_DEAD_PAIR_MS || 45_000)
/// 清扫周期（可注入，测试用短周期）。
const SWEEP_MS = 10_000
/// 全局连接上限（防中继自身被连接洪水打爆）。
const MAX_TOTAL_CONNS = 1024
/// 单行命令长度上限（命令都是 ASCII 短行；超长=恶意/坏客户端）。
const MAX_LINE_BYTES = 4096

// ── QoS 常量与底座（令牌桶 / 限流管道）──────────────────────────────────────

/// 1 MB 的字节数：**十进制 1,000,000**（`RELAY_QOS_LIMIT_MBPS=1` ⇒ 10⁶ B/s）。
/// 全仓统一这个口径，不混用 MiB——否则"设 8MB/s 实测 8.39"永远对不上账。
const MB = 1_000_000
/// 默认突发窗口：100ms。= 允许"一个 100ms 的量"瞬时通过，交互式小包不排队。
const DEFAULT_BURST_MS = 100

/** MB/s 归一化：非数字/≤0 → 0（=不限）；上限 1TB/s 纯粹防呆。 */
function normMbps(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(n, 1e6)
}

/** 突发窗口归一化：默认 100ms，限制 [1ms, 5000ms]。 */
function normBurstMs(v) {
  if (v === undefined || v === null || v === '') return DEFAULT_BURST_MS
  const n = Number(v)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BURST_MS
  return Math.min(n, 5000)
}

/**
 * 令牌桶（单位：字节）。`rate=0` ⇒ `active=false` ⇒ 所有判定短路成 Infinity，
 * 转发路径与"没有限流"逐字节等价（零额外延迟、零额外 oom 风险）。
 * 容量 = rate × burstMs（下限 4KB，保证小包总有一次通行额度）。
 */
function makeBucket(mbps, burstMs) {
  const b = { active: false, rate: 0, cap: 0, tokens: 0, last: Date.now() }
  b.reconfigure = (nextMbps, nextBurstMs) => {
    const rate = normMbps(nextMbps) * MB
    const cap = Math.max(4096, Math.ceil(rate * (normBurstMs(nextBurstMs) / 1000)))
    b.active = rate > 0
    b.rate = rate
    b.cap = cap
    // 收紧上限时必须把多余令牌砍掉：否则"降速瞬间还能猛冲一桶"，实测会超上限。
    b.tokens = b.active ? Math.min(b.tokens > 0 ? b.tokens : cap, cap) : 0
    b.last = Date.now()
    return b
  }
  return b.reconfigure(mbps, burstMs)
}

/** 惰性补充：只在被问"还能写多少"时按经过时间补，零定时器开销。 */
function bucketRefill(b, now) {
  if (!b.active) return
  const dt = now - b.last
  if (dt <= 0) return
  b.last = now
  if (b.tokens < b.cap) b.tokens = Math.min(b.cap, b.tokens + (b.rate * dt) / 1000)
}

/** 当前可立即写出的字节数 = 所有生效桶余量的最小值（无生效桶 ⇒ Infinity）。 */
function gateAllow(buckets, now) {
  let allow = Infinity
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i]
    if (!b || !b.active) continue
    bucketRefill(b, now)
    if (b.tokens < allow) allow = b.tokens
  }
  return allow
}

/** 从所有生效桶里扣掉 n 字节（两层同时扣 = 取交集，不是各扣各的）。 */
function gateTake(buckets, n, now) {
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i]
    if (b && b.active) { bucketRefill(b, now); b.tokens -= n }
  }
}

/**
 * 一条方向的限流管道：`from` 的字节经队列 → `to`。
 * · 无生效上限：同步直写（与改造前等价）
 * · 有上限且有令牌：同步直写（交互式小包零排队）
 * · 令牌不足：入队 + `from.pause()`（字节留内核，不丢）→ 定时补充后继续
 * · 关闭前：`close()` 排空队列再断——**正确性 > 速率**，宁可 teardown 少量超上限
 */
function createLink({ from, to, buckets, onBytes, onWait }) {
  const queue = []
  let qBytes = 0
  let timer = null
  let paused = false
  let closed = false
  const st = { bytes: 0, throttledBytes: 0, waits: 0, waitMs: 0, pausedAt: 0 }

  const limited = () => {
    for (let i = 0; i < buckets.length; i++) if (buckets[i] && buckets[i].active) return true
    return false
  }

  const account = (n) => {
    st.bytes += n
    const lim = limited()
    if (lim) st.throttledBytes += n
    if (onBytes) onBytes(n, lim)
  }

  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null } }

  function pauseSource() {
    if (paused || closed) return
    try { from.pause() } catch { /* 已销毁 */ }
    paused = true
    st.waits++
  }

  function resumeSource() {
    if (!paused) return
    paused = false
    const waited = st.pausedAt ? Date.now() - st.pausedAt : 0
    st.waitMs += waited
    st.pausedAt = 0
    if (waited > 0 && onWait) onWait(waited)
    if (!closed) { try { from.resume() } catch { /* 已销毁 */ } }
  }

  /** 还要等多久才够写出"队首那一块"（或者桶容量那么多）。 */
  function nextWaitMs(need) {
    let wait = Infinity
    const now = Date.now()
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i]
      if (!b || !b.active) continue
      bucketRefill(b, now)
      const want = Math.min(need, b.cap)
      if (b.tokens >= want) continue
      wait = Math.min(wait, ((want - b.tokens) / b.rate) * 1000)
    }
    if (wait === Infinity) return 1
    return Math.max(1, Math.min(50, Math.ceil(wait)))
  }

  /**
   * 水位线：队列涨到 HWM 才暂停源，降到 HWM/4 才恢复。
   * **为什么不是"没令牌就暂停"**：那样每个令牌周期都要 pause→resume 一次，
   * 而 resume 到下一次 'data' 有一段 event-loop 间隙；实测 1MB/s 会掉到 0.7MB/s
   * （2026-10-23 首版：3MB 用了 4.3s / 应 3s）。改成按水位批量暂停后，暂停次数从
   * ~150 次降到 ~8 次，间隙成本可忽略，精度回到 ±5% 内。
   * HWM 同时是每个方向的内存上限（不设水位 = 无界缓冲，会 OOM）。
   */
  function highWater() {
    let rate = Infinity
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i]
      if (b && b.active && b.rate < rate) rate = b.rate
    }
    if (rate === Infinity) return Infinity
    return Math.max(256 * 1024, Math.min(2 * 1024 * 1024, rate * 0.4))
  }

  function schedule() {
    if (timer || closed) return
    timer = setTimeout(() => { timer = null; pump() }, nextWaitMs(queue.length ? queue[0].length : 1))
  }

  function pump() {
    if (closed) return
    while (queue.length) {
      const head = queue[0]
      const now = Date.now()
      const allow = gateAllow(buckets, now)
      if (allow <= 0) break
      const n = allow === Infinity ? head.length : Math.min(head.length, Math.floor(allow))
      if (n <= 0) break
      gateTake(buckets, n, now)
      if (n >= head.length) queue.shift()
      else queue[0] = head.subarray(n)
      qBytes -= n
      account(n)
      to.write(n >= head.length ? head : head.subarray(0, n))
    }
    if (!queue.length) {
      resumeSource()
      clearTimer()
      return
    }
    const hwm = highWater()
    if (!paused && qBytes >= hwm) {
      st.pausedAt = Date.now()
      pauseSource()
    } else if (paused && qBytes <= hwm / 4) {
      resumeSource()
    }
    schedule()
  }

  function write(chunk) {
    if (closed || !chunk || !chunk.length) return
    if (!queue.length) {
      // 快路径：够令牌就直写——交互式小包的额外延迟为 0
      const now = Date.now()
      const allow = gateAllow(buckets, now)
      if (allow >= chunk.length) {
        gateTake(buckets, chunk.length, now)
        account(chunk.length)
        to.write(chunk)
        return
      }
    }
    queue.push(chunk)
    qBytes += chunk.length
    pump()
  }

  /** 关连接前排空（不看令牌）：丢字节是事故，临时超一点速率不是。 */
  function flushAll() {
    clearTimer()
    while (queue.length) {
      const head = queue.shift()
      qBytes -= head.length
      account(head.length)
      try { to.write(head) } catch { break }
    }
  }

  function close() {
    if (closed) return
    if (queue.length) flushAll()
    closed = true
    clearTimer()
    if (paused) { paused = false; st.pausedAt = 0 }
    queue.length = 0
    qBytes = 0
  }

  return {
    write, pump, close, flushAll,
    stats: () => ({ ...st, queuedBytes: qBytes, paused }),
    kick: () => { if (!closed) pump() },
    get queuedBytes() { return qBytes },
  }
}

/** 存活的中继实例（同进程通常 1 个；`setRelayQos()` 对全部生效）。 */
const liveRelays = new Set()

/** 读 relay-qos.json（可选）：不存在/解析失败 ⇒ null（保持默认 0=不限，绝不悄悄限速）。 */
function loadQosFile() {
  const file = process.env.RELAY_QOS_FILE || resolve(__qosDir, 'relay-qos.json')
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error('[relay] relay-qos.json 读取失败（保持默认 0=不限）:', err.message)
    return null
  }
  try {
    const j = JSON.parse(raw)
    const out = { file }
    if (j.globalMbps !== undefined) out.globalMbps = normMbps(j.globalMbps)
    else if (j.limitMbps !== undefined) out.globalMbps = normMbps(j.limitMbps)
    if (j.perSessionMbps !== undefined) out.perSessionMbps = normMbps(j.perSessionMbps)
    if (j.burstMs !== undefined) out.burstMs = normBurstMs(j.burstMs)
    return out
  } catch (err) {
    console.error('[relay] relay-qos.json 解析失败（保持默认 0=不限）:', err.message)
    return null
  }
}

/** 初始配置优先级：显式入参 > env > relay-qos.json > 默认（全 0 = 不限）。 */
function resolveInitialQos(explicit) {
  if (explicit) {
    return {
      globalMbps: normMbps(explicit.globalMbps),
      perSessionMbps: normMbps(explicit.perSessionMbps),
      burstMs: normBurstMs(explicit.burstMs),
      source: 'args', file: null,
    }
  }
  const env = {}
  let envAny = false
  if (process.env.RELAY_QOS_LIMIT_MBPS !== undefined) { env.globalMbps = normMbps(process.env.RELAY_QOS_LIMIT_MBPS); envAny = true }
  if (process.env.RELAY_QOS_PER_SESSION_MBPS !== undefined) { env.perSessionMbps = normMbps(process.env.RELAY_QOS_PER_SESSION_MBPS); envAny = true }
  if (process.env.RELAY_QOS_BURST_MS !== undefined) { env.burstMs = normBurstMs(process.env.RELAY_QOS_BURST_MS); envAny = true }
  const fromFile = loadQosFile()
  const base = fromFile || {}
  return {
    globalMbps: base.globalMbps !== undefined ? base.globalMbps : 0,
    perSessionMbps: base.perSessionMbps !== undefined ? base.perSessionMbps : 0,
    burstMs: base.burstMs !== undefined ? base.burstMs : DEFAULT_BURST_MS,
    ...env,
    source: envAny ? 'env' : (fromFile ? 'file' : 'default'),
    file: fromFile ? fromFile.file : null,
  }
}

/**
 * 创建中继服务器。
 * `port: 0` 不监听（测试拿实例后自行 listen 取随机口）；默认 8322。
 * `qos: {globalMbps, perSessionMbps, burstMs}` 显式指定限流（测试用）；
 * 不传则按 env > relay-qos.json > 默认（全 0=不限）解析。
 * 返回 net.Server，附带 `relayStats()` / `setRelayQos()` / `relayQos()` 诊断与调节面。
 */
export function createRelay({
  port = Number(process.env.RELAY_PORT || 8322),
  host = process.env.RELAY_HOST || '0.0.0.0',
  maxSessionsPerProvider = MAX_SESSIONS_PER_PROVIDER,
  sessionIdleMs = SESSION_IDLE_MS,
  deadPairMs = DEAD_PAIR_MS,
  sweepMs = SWEEP_MS,
  qos: qosInit = null,
  // 2026-11-04 P0 安全修复：REGISTER/CONNECT 签名验证（防任意劫持 provider）。
  // auth = { getIdentity(did)→{publicKeyB64}, importPublicKey, verify } —— 由
  // identity-server.mjs 传入（同一进程共享 store/crypto）。
  // 签名格式：REGISTER <did> <ts> <sigB64>，sig = ed25519.sign(`${did}\n${ts}\nrelay-register`)
  // grace 模式（RELAY_SIG_GRACE=1，默认开）：48h 内同时接受无签名（WARN），之后强制。
  auth = null,
} = {}) {
  // did → { sock, lastSeen, pending: Map(sid → {consumer, io, timer}), sessions: Set(Pair) }
  const providers = new Map()
  const sessions = new Set()
  let totalConns = 0
  const stats = {
    register: 0, unregister: 0, connect: 0, paired: 0, notFound: 0, busy: 0, unavailable: 0, deadPair: 0,
    replace: 0, controlTimeout: 0, notFoundByTarget: {}, pairMs: [], startedAt: Date.now(),
    connectByPeer: {}, notFoundByConsumer: {},
  }

  const log = (...a) => console.log('[relay]', ...a)
  const tail = (did) => (did.length > 12 ? did.slice(-12) : did)

  // ── QoS 状态（每实例一份；模块级 setRelayQos 对所有存活实例下发）──
  const qos = {
    globalMbps: 0, perSessionMbps: 0, burstMs: DEFAULT_BURST_MS,
    source: 'default', updatedAt: 0, file: null, changes: 0,
  }
  const globalBucket = makeBucket(0, DEFAULT_BURST_MS)
  const sessionBuckets = new Set() // 所有活会话的会话级桶（热更新要逐个改）
  const liveLinks = new Set() // 所有活 link（热更新后要立刻 kick 一次，别等下一个定时器）
  const totals = { up: 0, down: 0, throttledBytes: 0, waits: 0, waitMs: 0 }

  /**
   * 应用一份限流配置（启动 + 运行时热更新共用同一条路径）。
   * **只改桶的速率/容量，不碰任何 socket**——所以热更新天然不断会话（RQ5）。
   */
  function applyQos(next = {}, source = 'runtime') {
    if (next.globalMbps !== undefined) qos.globalMbps = normMbps(next.globalMbps)
    if (next.perSessionMbps !== undefined) qos.perSessionMbps = normMbps(next.perSessionMbps)
    if (next.burstMs !== undefined) qos.burstMs = normBurstMs(next.burstMs)
    if (next.file !== undefined) qos.file = next.file
    globalBucket.reconfigure(qos.globalMbps, qos.burstMs)
    for (const b of sessionBuckets) b.reconfigure(qos.perSessionMbps, qos.burstMs)
    qos.source = source
    qos.updatedAt = Date.now()
    qos.changes++
    // 立刻重算一次所有管道：从"限"改"不限"时队列要马上放行，不能等定时器
    for (const l of liveLinks) l.kick()
    if (qos.globalMbps || qos.perSessionMbps || source !== 'default') {
      log(`qos 生效 global=${qos.globalMbps || 'off'}MB/s perSession=${qos.perSessionMbps || 'off'}MB/s burst=${qos.burstMs}ms source=${source}`
        + `（活会话 ${sessionBuckets.size}）`)
    }
    return { ...qos }
  }

  const __initQos = resolveInitialQos(qosInit)
  applyQos(__initQos, __initQos.source)

  // 带宽采样环（给仪表盘：最近 1s / 5s / 60s 聚合 MB/s）。1s 粒度、120 项、unref。
  const rateRing = []
  let rateLast = { up: 0, down: 0 }
  const rateTimer = setInterval(() => {
    rateRing.push({ t: Date.now(), up: totals.up - rateLast.up, down: totals.down - rateLast.down })
    rateLast = { up: totals.up, down: totals.down }
    while (rateRing.length > 120) rateRing.shift()
  }, 1000)
  if (rateTimer.unref) rateTimer.unref()

  /** 最近 ms 毫秒内的聚合速率（MB/s，十进制）。 */
  function rateOver(ms) {
    const now = Date.now()
    const since = now - ms
    let up = 0, down = 0, oldest = now
    for (let i = rateRing.length - 1; i >= 0; i--) {
      const e = rateRing[i]
      if (e.t < since) break
      up += e.up; down += e.down; oldest = e.t
    }
    const span = Math.max(1, (now - oldest) / 1000)
    const r4 = (x) => Math.round((x / MB / span) * 10000) / 10000
    return { upMbps: r4(up), downMbps: r4(down), totalMbps: r4(up + down) }
  }

  /**
   * 把 socket 变成"按行收命令"状态机。
   * onLine(line) → undefined（继续收行）| {hold:true}（暂存后续字节等配对）
   *              | {peer}（切换纯转发，缓冲一并冲给 peer）。
   * 关键正确性：hold/pipe 之前**绝不消费** '\n' 之后的字节——consumer 把 CONNECT
   * 和隧道首包 pipeline 在一个 TCP 段里发也不丢字节。
   */
  function lineMode(sock, onLine) {
    sock.setNoDelay(true)
    sock.setKeepAlive(true, 60_000)
    let buf = Buffer.alloc(0)
    let held = null // hold 模式下的字节缓冲（等 pipeTo 一次性冲给对端）
    let piped = null // 纯转发目标 { peer, link }
    sock.on('data', (chunk) => {
      if (piped) { if (chunk.length) piped.link.write(chunk); return }
      if (held) { held.push(chunk); return }
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
      while (!piped && !held && buf.length) {
        const i = buf.indexOf(0x0a)
        if (i < 0) {
          if (buf.length > MAX_LINE_BYTES) { log('line 超长，踢线'); sock.destroy() }
          break
        }
        const line = buf.subarray(0, i).toString('utf8').replace(/\r$/, '').trim()
        buf = buf.subarray(i + 1)
        const act = onLine(line)
        if (!act) continue
        if (act.hold) {
          held = buf.length ? [buf] : []
          buf = Buffer.alloc(0)
        } else if (act.peer) {
          const peer = act.peer
          const link = act.link
            || (piped && piped.peer === peer ? piped.link : null)
            || { write: (c) => peer.write(c) }
          if (buf.length) link.write(buf)
          buf = Buffer.alloc(0)
          piped = { peer, link }
        }
      }
    })
    return {
      /** 切换纯转发：held/缓冲全部冲给 peer，后续字节直发。
       *  `linkIn` = 限流管道（不传则退化为裸 write，即改造前行为）。 */
      pipeTo(peer, linkIn) {
        if (piped) return
        const link = linkIn || { write: (c) => peer.write(c) }
        if (held) { for (const c of held) link.write(c); held = null }
        if (buf.length) { link.write(buf); buf = Buffer.alloc(0) }
        piped = { peer, link }
      },
    }
  }

  /**
   * 建一条会话的限流上下文：一个会话桶（**上下行共享**，即"每会话上限"= 双向合计）
   * + 两条方向的 link。方向以 consumer 视角命名：up = consumer→provider，
   * down = provider→consumer。
   */
  function createPairQos(providerSock, consumerSock) {
    const bucket = makeBucket(qos.perSessionMbps, qos.burstMs)
    sessionBuckets.add(bucket)
    const buckets = [bucket, globalBucket]
    const mk = (from, to, dir) => {
      const link = createLink({
        from, to, buckets,
        onBytes: (n, limited) => {
          if (dir === 'up') totals.up += n
          else totals.down += n
          if (limited) totals.throttledBytes += n
        },
        onWait: (ms) => { totals.waitMs += ms; totals.waits++ },
      })
      liveLinks.add(link)
      return link
    }
    const up = mk(consumerSock, providerSock, 'up')
    const down = mk(providerSock, consumerSock, 'down')
    return {
      bucket, up, down,
      close() {
        try { up.close() } catch { /* ignore */ }
        try { down.close() } catch { /* ignore */ }
        sessionBuckets.delete(bucket)
        liveLinks.delete(up)
        liveLinks.delete(down)
      },
    }
  }

  /** 会话对：双向纯字节（pipeTo 已各就各位）+ 任一侧断开断另一侧 + 空闲计时。
   *  记 `bytes`（双向累计）与 `born`：给清扫区分「空占位」和「有流量的闲页」。 */
  function makePair(a, b, label, entry, qctx) {
    const pr = { a, b, last: Date.now(), born: Date.now(), bytes: 0, entry, qctx, label }
    const touch = (chunk) => { pr.last = Date.now(); pr.bytes += chunk ? chunk.length : 0 }
    a.on('data', touch)
    b.on('data', touch)
    const kill = () => {
      if (pr.killed) return
      pr.killed = true
      // 关之前先把限流队列里没发出去的字节排空：丢字节是事故，临时超一点速率不是
      if (qctx) qctx.close()
      a.destroy()
      b.destroy()
      sessions.delete(pr)
      if (entry) entry.sessions.delete(pr)
    }
    pr.kill = kill
    a.on('close', kill)
    b.on('close', kill)
    sessions.add(pr)
    if (entry) entry.sessions.add(pr)
    stats.paired++
    log(`session paired ${label}（provider 会话 ${entry ? entry.sessions.size : '?'}，全局 ${sessions.size}）`)
    return pr
  }

  const server = net.createServer((sock) => {
    handleConn(sock)
  })

  // 实例级调节/读取面（admin 路由与测试用）。函数级 export 见文件末尾 setRelayQos()。
  server.setRelayQos = (cfg = {}) => applyQos(cfg, cfg.__source || 'runtime')
  server.relayQos = () => ({ ...qos })

  /**
   * 外部注入一条**已嗅探过首行**的连接（端口复用模式：8321 上的分流器把
   * REGISTER/CONNECT/ACCEPT 开头的连接转交这里）。`firstLine` 不含换行；
   * `rest` 是首行之后已读到的字节（原样进管道，不丢字节）。
   */
  server.injectSocket = (sock, firstLine, rest) => {
    handleConn(sock) // 挂 lineMode 监听（同步；'data' 监听会让流进 flowing）
    sock.pause() // 同步块内压回 paused——unshift 的字节在 resume 前不会被吐出
    // unshift 顺序：后 unshift 的先被读 → 先塞 rest 再塞行，读序 = 行 → rest
    if (rest && rest.length) sock.unshift(rest)
    sock.unshift(Buffer.from(firstLine + '\n'))
    sock.resume()
  }

  function handleConn(sock) {
    totalConns++
    const peerAddr = sock.remoteAddress || '?'
    if (totalConns > MAX_TOTAL_CONNS) {
      totalConns--
      sock.destroy()
      return
    }
    sock.on('close', () => { totalConns-- })
    sock.on('error', () => sock.destroy())

    let mode = null // 'control' | 'consumer-wait' | 'session' | null
    let myDid = null // 控制连注册的 did

    const io = lineMode(sock, (line) => {
      const sp = line.indexOf(' ')
      const cmd = sp < 0 ? line : line.slice(0, sp)
      const rest = sp < 0 ? '' : line.slice(sp + 1)

      // ── Provider 控制连 ──
      if (cmd === 'REGISTER') {
        // 2026-11-04 P0 签名验证（async）——pause 流防验证期间的后续行竞态。
        // 签名格式：REGISTER <did> <ts> <sigB64>（sig 覆盖 `${did}\n${ts}\nrelay-register`）
        // 旧格式 REGISTER <did>（无签名）在 grace 期（RELAY_SIG_GRACE≠0）WARN 放行。
        sock.pause()
        handleRegister(sock, rest, peerAddr).finally(() => {
          if (!sock.destroyed && mode !== 'session') sock.resume()
        })
        return
      }
      // 控制连上的空行心跳（SESSION 下发也算活动，见 CONNECT 分支）
      if (line === '' && mode === 'control' && myDid) {
        const e = providers.get(myDid)
        if (e && e.sock === sock) e.lastSeen = Date.now()
        return
      }

      // ── Provider 会话连（接单）──
      if (cmd === 'ACCEPT') {
        const m = rest.trim().match(/^(\S+)\s+(\S+)$/)
        if (!m) { sock.destroy(); return }
        const [, accDid, sid] = m
        const entry = providers.get(accDid)
        const pend = entry?.pending.get(sid)
        if (!entry || !pend || pend.consumer.destroyed || entry.sock.destroyed) {
          entry?.pending.delete(sid)
          log(`accept 无对应等待（did=…${tail(accDid)} sid=${sid}）→ 踢线`)
          sock.destroy()
          return
        }
        mode = 'session'
        entry.pending.delete(sid)
        clearTimeout(pend.timer)
        // 接单耗时（CONNECT → provider ACCEPT）采样，给外部指标面用
        if (pend.at) {
          stats.pairMs.push(Date.now() - pend.at)
          if (stats.pairMs.length > 500) stats.pairMs.splice(0, stats.pairMs.length - 500)
        }
        pend.consumer.write('OK\n')
        // 限流上下文要在 pipeTo 之前建：两条方向共享同一个会话桶（每会话上限=双向合计）
        const qctx = createPairQos(sock, pend.consumer)
        // 双向对接：本连接（provider 侧）后续字节 → consumer；consumer 已 hold 的字节 → 本连接
        pend.io.pipeTo(sock, qctx.up) // consumer → provider（上行）
        io.pipeTo(pend.consumer, qctx.down) // provider → consumer（下行）
        makePair(sock, pend.consumer, `did=…${tail(accDid)} sid=${sid} consumer=${pend.peer || '?'}`, entry, qctx)
        return { peer: pend.consumer, link: qctx.down } // 本 socket 立即进入纯转发
      }

      // ── Consumer ──
      if (cmd === 'CONNECT') {
        const target = rest.trim()
        stats.connect++
        const entry = providers.get(target)
        if (!entry || entry.sock.destroyed) {
          stats.notFound++
          stats.notFoundByConsumer[peerAddr] = (stats.notFoundByConsumer[peerAddr] || 0) + 1
          if (Object.keys(stats.notFoundByConsumer).length > 100) stats.notFoundByConsumer = {}
          const k = tail(target)
          stats.notFoundByTarget[k] = (stats.notFoundByTarget[k] || 0) + 1
          if (Object.keys(stats.notFoundByTarget).length > 200) stats.notFoundByTarget = {}
          // 2026-10-12 补日志：NOT_FOUND/BUSY/UNAVAILABLE 原来**只回给 consumer、不留痕**，
          // 结果"用户连不上到底卡在哪一环"没法回溯（当晚排查就吃了这个亏：只知道设备
          // 注册掉过 5 秒，看不出手机那一刻是不是真被中继判了无此设备）。
          log(`connect 失败 NOT_FOUND did=…${tail(target)} peer=${peerAddr}（在线 provider ${providers.size}）`)
          sock.write('NOT_FOUND\n')
          sock.end()
          return
        }
        if (entry.sessions.size + entry.pending.size >= maxSessionsPerProvider) {
          stats.busy++
          log(`connect 失败 BUSY did=…${tail(target)}（并发 ${entry.sessions.size + entry.pending.size}/${maxSessionsPerProvider}）`)
          sock.write('BUSY\n')
          sock.end()
          return
        }
        stats.connectByPeer[peerAddr] = (stats.connectByPeer[peerAddr] || 0) + 1
        if (Object.keys(stats.connectByPeer).length > 100) stats.connectByPeer = {}
        const sid = randomBytes(8).toString('hex')
        mode = 'consumer-wait'
        const timer = setTimeout(() => {
          entry.pending.delete(sid)
          if (!sock.destroyed) {
            stats.unavailable++
            log(`connect 失败 UNAVAILABLE did=…${tail(target)} sid=${sid}（provider ${PAIR_TIMEOUT_MS}ms 内没 ACCEPT）`)
            sock.write('UNAVAILABLE\n')
            sock.end()
          }
        }, PAIR_TIMEOUT_MS)
        entry.pending.set(sid, { consumer: sock, io, timer, at: Date.now(), peer: peerAddr })
        try {
          entry.sock.write(`SESSION ${sid}\n`)
          entry.lastSeen = Date.now() // 出站信令刷新控制连活性
          log(`connect → did=…${tail(target)} sid=${sid} consumer=${peerAddr}（已下发 SESSION，等 ACCEPT）`)
        } catch {
          entry.pending.delete(sid)
          clearTimeout(timer)
          stats.notFound++
          log(`connect 失败 NOT_FOUND did=…${tail(target)} sid=${sid}（SESSION 写不进控制连=provider 连接已死）`)
          sock.write('NOT_FOUND\n')
          sock.end()
        }
        return { hold: true } // CONNECT 后的隧道首包字节先暂存，配对即冲给 provider
      }

      sock.write('ERROR unknown-command\n')
      sock.end()
    })

    sock.on('close', () => {
      if (mode === 'control' && myDid) {
        const e = providers.get(myDid)
        if (e && e.sock === sock) {
          providers.delete(myDid)
          stats.unregister++
          for (const [, p] of e.pending) {
            clearTimeout(p.timer)
            if (!p.consumer.destroyed) { stats.unavailable++; p.consumer.write('UNAVAILABLE\n'); p.consumer.end() }
          }
          log(`unregister did=…${tail(myDid)} peer=${peerAddr}（在线 provider ${providers.size}）`)
        }
      }
    })

    // ── 2026-11-04 P0：REGISTER 签名验证 + 注册（async 版，由 lineMode 的 REGISTER 分支调用）──
    async function handleRegister(sock2, restStr, peerAddr2) {
      const parts = restStr.trim().split(/\s+/)
      let did = parts[0] || ''
      // 新格式：REGISTER <did> <ts> <sigB64>
      if (auth && parts.length === 3) {
        const [rawDid, tsStr, sigB64] = parts
        did = rawDid
        if (!did || did.length < 8) { sock2.write('ERROR bad-register\n'); sock2.end(); return }
        const ts = Number(tsStr)
        if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 300_000) {
          log(`register 拒绝：ts 窗口外 did=…${tail(did)} ts=${tsStr}`)
          sock2.write('ERROR bad-timestamp\n'); sock2.end(); return
        }
        try {
          const id = await auth.getIdentity(did)
          if (!id) {
            log(`register 拒绝：did 未注册 did=…${tail(did)} peer=${peerAddr2}`)
            sock2.write('ERROR unknown-did\n'); sock2.end(); return
          }
          const pub = await auth.importPublicKey(new Uint8Array(Buffer.from(id.publicKeyB64, 'base64')))
          const data = new TextEncoder().encode(`${did}\n${tsStr}\nrelay-register`)
          const sig = new Uint8Array(Buffer.from(sigB64, 'base64'))
          const ok = await auth.verify(pub, data, sig)
          if (!ok) {
            log(`register 拒绝：签名无效 did=…${tail(did)} peer=${peerAddr2}`)
            sock2.write('ERROR bad-signature\n'); sock2.end(); return
          }
        } catch (e) {
          log(`register 签名验证异常 did=…${tail(did)}: ${e?.message || e}`)
          sock2.write('ERROR verify-failed\n'); sock2.end(); return
        }
      } else if (auth && parts.length === 1) {
        // 旧格式（无签名）——grace 期 WARN 放行
        if (process.env.RELAY_SIG_GRACE === '0') {
          log(`register 拒绝：未签名（grace 已过）did=…${tail(did)} peer=${peerAddr2}`)
          sock2.write('ERROR signature-required\n'); sock2.end(); return
        }
        log(`WARN register 未签名（grace 期放行）did=…${tail(did)} peer=${peerAddr2}`)
      }
      if (!did || /\s/.test(did) || did.length < 8) { sock2.write('ERROR bad-register\n'); sock2.end(); return }
      mode = 'control'
      myDid = did
      const old = providers.get(did)
      if (old && old.sock !== sock2 && !old.sock.destroyed) {
        stats.replace++
        log(`register 替换旧连接 did=…${tail(did)}`)
        old.sock.destroy()
      }
      const entry = { sock: sock2, did, lastSeen: Date.now(), pending: new Map(), sessions: new Set() }
      providers.set(did, entry)
      stats.register++
      sock2.write('OK\n')
      log(`register did=…${tail(did)} peer=${peerAddr2}（在线 provider ${providers.size}）`)
    }
  }

  // 周期清扫：哑控制连（心跳超时）+ 僵死会话（空闲超时）+ 空占位会话（零字节快回收）
  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [did, e] of providers) {
      if (now - e.lastSeen > CONTROL_IDLE_MS) {
        stats.controlTimeout++
        log(`control 心跳超时踢线 did=…${tail(did)}`)
        e.sock.destroy() // close 钩子清 pending/注册表
        providers.delete(did)
      }
    }
    for (const s of sessions) {
      if (now - s.last > sessionIdleMs) {
        log('session 空闲超时关闭')
        s.kill()
        continue
      }
      // 配对后干了多久、一个字节都没走 → 空占位，别拿它占卡槽等到 15min（真案见 DEAD_PAIR_MS 注释）
      if (s.bytes === 0 && now - s.born > deadPairMs) {
        stats.deadPair++
        log(`session 空占位回收（${deadPairMs}ms 零字节，全局 ${sessions.size}）`)
        s.kill()
      }
    }
  }, sweepMs)
  sweeper.unref()

  const pct = (arr, q) => {
    if (!arr.length) return null
    const a = [...arr].sort((x, y) => x - y)
    return a[Math.min(a.length - 1, Math.floor(q * a.length))]
  }
  server.relayStats = () => {
    const pair = [...stats.pairMs].sort((x, y) => x - y)
    const sessionDetail = []
    for (const pr of sessions) {
      if (!pr.qctx) continue
      const u = pr.qctx.up.stats()
      const d = pr.qctx.down.stats()
      sessionDetail.push({
        did: tail(pr.entry?.did || ''),
        bytesUp: u.bytes, bytesDown: d.bytes, bytes: u.bytes + d.bytes,
        throttledBytes: u.throttledBytes + d.throttledBytes,
        queuedBytes: u.queuedBytes + d.queuedBytes,
        ageMs: Date.now() - pr.born,
      })
    }
    sessionDetail.sort((a, b) => b.bytes - a.bytes)
    const r1 = rateOver(1000)
    const r5 = rateOver(5000)
    const r60 = rateOver(60_000)
    return {
      providers: providers.size, sessions: sessions.size, totalConns,
      ...stats,
      pairMs: undefined,
      pairLatency: {
        n: pair.length,
        p50: pct(pair, 0.5), p95: pct(pair, 0.95), max: pair.length ? pair[pair.length - 1] : null,
      },
      providerDetail: [...providers.entries()].slice(0, 32).map(([did, e]) => ({
        did: tail(did), sessions: e.sessions.size, pending: e.pending.size,
        idleMs: Date.now() - e.lastSeen,
      })),
      // 限流指标面：配置 + 累计字节 + 节流字节 + 实时带宽 + 每会话明细（给仪表盘/值班用）
      qos: {
        enabled: qos.globalMbps > 0 || qos.perSessionMbps > 0,
        globalMbps: qos.globalMbps,
        perSessionMbps: qos.perSessionMbps,
        burstMs: qos.burstMs,
        source: qos.source,
        file: qos.file,
        updatedAt: qos.updatedAt,
        changes: qos.changes,
        bytesTotal: totals.up + totals.down,
        bytesUp: totals.up, // 上行 = consumer→provider
        bytesDown: totals.down, // 下行 = provider→consumer
        throttledBytes: totals.throttledBytes, // 经生效桶转发的字节（0 = 从未受限）
        throttleWaits: totals.waits, // 因令牌不足暂停源的次数
        throttleWaitMs: totals.waitMs, // 累计排队时间
        mbpsNow: {
          last1s: r1.totalMbps, last5s: r5.totalMbps, last60s: r60.totalMbps,
          up1s: r1.upMbps, down1s: r1.downMbps,
        },
        // 每会话字节（Top 16，"谁在吃带宽"）
        sessions: sessionDetail.slice(0, 16).map((s) => ({
          did: s.did, bytes: s.bytes, bytesUp: s.bytesUp, bytesDown: s.bytesDown,
          throttledBytes: s.throttledBytes, queuedBytes: s.queuedBytes, ageMs: s.ageMs,
        })),
        sessionsTruncated: sessionDetail.length > 16,
      },
    }
  }

  // 注册进模块级活实例表：`setRelayQos()`（模块导出）对全部实例生效
  liveRelays.add(server)
  server.on('close', () => { liveRelays.delete(server); clearInterval(rateTimer) })

  if (port !== 0) {
    server.listen(port, host, () => log(`TCP 中继就绪 ${host}:${port}（provider 可注册）`))
    server.on('error', (e) => console.error(`[relay] 端口 ${port} 绑定失败:`, e.message))
  }
  return server
}

/** identity-server.mjs 入口调用（"测试 runner 直接执行不监听"的把关在调用方）。 */
export function startRelay() {
  return createRelay()
}

// ── 运行时热调节（对外 API；admin 路由 / 测试 / 运维脚本都用这两个）─────────────

/**
 * 运行时改限流上限，**对进程内所有存活中继实例立即生效**。
 * 只改桶的速率/容量、不碰任何 socket ⇒ **不断开现有会话**（task.md RQ5 的机制保证）。
 * @param {{globalMbps?:number, perSessionMbps?:number, burstMs?:number}} cfg 0/缺省=不限
 * @returns {Array} 每个实例应用后的生效配置
 */
export function setRelayQos(cfg = {}) {
  const applied = []
  for (const s of liveRelays) {
    if (typeof s.setRelayQos === 'function') applied.push(s.setRelayQos(cfg))
  }
  return applied
}

/** 读当前生效配置（每个存活实例一份；无实例 ⇒ 空数组）。 */
export function getRelayQos() {
  const out = []
  for (const s of liveRelays) if (typeof s.relayQos === 'function') out.push(s.relayQos())
  return out
}

/**
 * 从 `relay-qos.json` 重读并应用（改文件后免重启）。
 * 文件不存在/解析失败 ⇒ **保持当前配置不动**（绝不因为读坏文件而悄悄把限流改成 0 或反过来）。
 */
export function reloadRelayQos() {
  const cfg = loadQosFile()
  if (!cfg) return { ok: false, reason: 'relay-qos.json 不存在或解析失败（保持当前配置）' }
  return { ok: true, file: cfg.file, applied: setRelayQos({ ...cfg, __source: 'file' }) }
}


// ── 端口复用（2026-10-11：中继上 8321，与 identity HTTP 同口分流） ──
//
// **为什么**：阿里云安全组是白名单，8322 未放行（本机无控制台权限开不了）；
// 而 8321 是 identity-svc 的正式端口——**所有能跑 presence 的网络必达 8321**
// （手机热点/家宽 NAT 后都验证过）。让中继共用 8321 = 云端兜底的可达性
// 与 identity 完全一致，不再依赖运维开新端口。
//
// **怎么分**：首行嗅探——
//   · `REGISTER|CONNECT|ACCEPT <token>` 且行内无第二空格（HTTP 的 CONNECT 方法
//     请求行必带 " HTTP/1.x" 尾巴，天然不匹配）→ 转交中继；
//   · 其余（GET/POST/OPTIONS/HEAD…）→ unshift 回去后 `server.emit('connection')`
//     交给 HTTP 栈（Node 端口统一的经典模式，http.Server 本就是 net.Server）。
// 嗅探期间 socket 暂停在缓冲区，分流后一字节不丢（CONNECT 行后紧跟的隧道
// 首包字节由 unshift 原样送回）。

/// 首行是否是中继命令（非 HTTP）。`line` 为已去掉 \r\n 的完整首行。
/// ACCEPT 带两个 token（did + sid）；HTTP 的 CONNECT 代理方法行必带 " HTTP/1.x"
/// 尾巴（第二个空格）——CONNECT 只认单 token，天然不冲突。
/// 2026-11-04 P0 修复（运维红例抓到）：签名版 REGISTER 是 4 token
/// （REGISTER <did> <ts> <sig>），旧正则只认 2 token → mux 误分到 HTTP 栈 → 400。
/// ts 限定 \d{10,13}（秒/毫秒时间戳），避免 HTTP CONNECT 的第三段 "HTTP/1.1" 误命中。
export function isRelayLine(line) {
  return /^(REGISTER|CONNECT) \S+( \d{10,13} \S+)?$/.test(line) || /^ACCEPT \S+ \S+$/.test(line)
}

/**
 * 造一个"分流前置服务器"：嗅探首行 → 中继命令给 relay，HTTP 给 httpServer。
 * 返回 net.Server（**由调用方 listen**）；httpServer 自身不 listen。
 */
export function createPortMux({ httpServer, relay }) {
  const mux = net.createServer((socket) => {
    socket.setNoDelay(true)
    let buf = Buffer.alloc(0)
    let decided = false
    const sniffTimer = setTimeout(() => {
      if (!decided) socket.destroy() // 嗅探期空连（健康探测/扫描器）15s 放弃
    }, 15_000)
    const ondata = (chunk) => {
      if (decided) return
      buf = Buffer.concat([buf, chunk])
      const i = buf.indexOf(0x0a)
      if (i < 0) {
        if (buf.length > 1024) toHttp() // 不像任何一方的开头——交 HTTP 层报错
        return
      }
      const line = buf.subarray(0, i).toString('utf8').replace(/\r$/, '').trim()
      const rest = buf.subarray(i + 1)
      if (isRelayLine(line)) {
        toRelay(line, rest)
      } else {
        toHttp() // 整个 buf（含请求行）原样还回——HTTP 分支不能吞任何字节
      }
    }
    const cleanup = () => {
      decided = true
      socket.removeListener('data', ondata)
      clearTimeout(sniffTimer)
    }
    const toRelay = (line, rest) => {
      cleanup()
      relay.injectSocket(socket, line, rest) // 内部：pause → 挂监听 → unshift(行+rest) → resume
    }
    const toHttp = () => {
      cleanup()
      socket.pause()
      if (buf.length) socket.unshift(buf)
      // 先让 HTTP 栈挂上它的 parser 监听，再 resume——顺序反了 unshift 的字节会丢
      httpServer.emit('connection', socket)
      socket.resume()
    }
    socket.on('data', ondata)
    socket.on('error', () => socket.destroy())
  })
  return mux
}
