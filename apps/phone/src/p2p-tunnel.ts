/**
 * p2p-tunnel.ts — 手机侧 P2P 隧道 **v2 线协议**客户端（帧级 AEAD）+ **服务端角色**（反向连接）。
 *
 * 权威来源：`apps/home/src-tauri/src/p2p_tunnel.rs`（PC 端）。本文件与它**逐字节对齐**，
 * 任何一方改动都必须同步——对齐锚点见 `p2p-tunnel.test.ts`（RFC 7748 向量 + 帧布局 +
 * HMAC 确认 + 重放拒绝都在测）。
 *
 * ── 为什么手机要自己实现一份 ────────────────────────────────────────────────
 * PC 侧 `p2p_tunnel::tunnel_open()` 是 Rust 内部 API，JS 调不到。手机要在 WebView 里
 * 打开 `http://127.0.0.1:<本地端口>/gw/<id>/?mt=…`，就得自己在 JS 侧把隧道立起来
 * （WS 由原生壳代开：**浏览器 WebSocket 不能设自定义头**，而握手信封/签名必须走
 * `x-myco-tunnel` / `x-myco-auth` 两个头——见 TunnelSocket 的注释）。
 *
 * ── 服务端角色（2026-10-09 反向连接） ───────────────────────────────────────
 * 实测拓扑：手机（电信移动 IPv6）→ PC（电信家宽，光猫拦入站）打不通；反向
 * PC → 手机 IPv6 直连**通**。所以隧道方向可以反转：**PC 主动拨手机**，在连接上
 * 跑同一套隧道协议，角色互换——PC 是发起方（originator：签握手信封、先发 HELLO），
 * 手机是应答方（responder：验签 + 闸门 + 回 HELLO_ACK）。v2 AEAD 的 HKDF 盐里
 * `ct_client` 恒为**发起方**的临时公钥（与谁拨谁无关）——本文件 `FrameIo` 两个角色
 * 早就支持，缺的只是服务端入口：[`acceptTunnel`]。
 * 手机端配套：原生 `TunnelProxyServer` 绑 `[::]` 接受入站；桥接层按首行嗅探区分
 * "浏览器连接"与"反向隧道入站"（后者首行必是 `GET /p2p/tunnel`），入站连接交给
 * [`acceptTunnel`] 做完整闸门（签名/设备=预期源设备/端口白名单/nonce 去重）。
 *
 * ── 线协议速览（与 Rust 注释块一字对应） ───────────────────────────────────
 * ```
 * 端点      ws://<host>:<p2pPort>/p2p/tunnel?v=2      （v 不符 → 400，绝不降级）
 * 握手头    x-myco-tunnel: {"v":2,"port":P,"account":A,"device":D,"origin":O,"nonce":N}
 * 签名头    x-myco-auth:   <deviceDid>.<tsMs>.<sigB64>
 *           签名字节 = "<deviceDid>\n<tsMs>\n<握手原文>"   （ed25519，ts 窗口 ±60s）
 * 帧        MAGIC="MET2"(4B) + ver(1B)=1 + type(1B)
 *             HELLO(1) / CONFIRM(2): +32B 明文载荷       → 整帧 38B
 *             DATA(3)              : +seq(u64 BE) + noncePrefix(12B) + AES-256-GCM(ct+tag)
 * 密钥      salt   = SHA256("MET2" ‖ ct_client ‖ ct_server ‖ utf8(握手原文))
 *           okm    = HKDF-SHA256(ikm=ECDH(临时X25519), salt, info="myco-p2p-tunnel/v2", 140B)
 *                    [0:32]=c2s [32:64]=s2c [64:76]=nonce 前缀
 *                    [76:108]=confirm_c2s [108:140]=confirm_s2c
 *          CONFIRM = HMAC-SHA256(confirm_key, utf8(握手原文))
 *  nonce    prefix 的**末 8 字节**按大端当 u64，与 seq 异或
 *  重放     每方向独立单调序号：收到的 seq 必须严格大于已见最大值，否则拒
 * ```
 * 握手时序（两端对称，无死锁）：client 发 HELLO → server 回 HELLO_ACK → server 发 CONFIRM
 * → client 校验后回 CONFIRM。
 *
 * ── 本模块的可测性约定 ─────────────────────────────────────────────────────
 * 仓库的 vitest 跑在 **node 环境**（无 DOM/WebSocket，见 vite.config.ts）。所以：
 *   · 本文件**不碰** `window` / `document` / 全局 `WebSocket`（生产适配器见 native-proxy.ts）；
 *   · 传输层抽象成 `TunnelSocket`（send/close/onMessage/onClose），测试可以直接把两个
 *     实例背靠背接起来跑真帧；
 *   · 时间/随机数可注入（`now` / `randomNonce`）。
 */

import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { sha1 } from '@noble/hashes/sha1.js'
import { hmac } from '@noble/hashes/hmac.js'
// 2026-10-12 数据面分流：信封 port=9100 的隧道走帧内 HTTP（/p2p/msg → ingest）。
// 对端只 import 本文件的类型（type-only，编译后消失——不构成运行时环）。
import { serveP2pDataFace } from './p2p-data-face'
import { didEquiv, didPubkeyBytes } from './didUtil'
// 网关默认口（13911）：`serveVnetTcpSession` 判"这个 port 是不是网关口"要用。
// 原来漏了这个 import——`DEFAULT_GW_PORT` 是**未定义标识符**（`tsc -b` 报 TS2552，
// 运行时跑到那行直接 ReferenceError）。定义仍只留在 `share-entry.ts`（单一来源）。
import { DEFAULT_GW_PORT } from './share-entry'

// ══════════════════ 常量（与 Rust 同名同值） ══════════════════

/** 帧魔数 "MET2"——裸明文/别的协议在第一眼就被认出。 */
export const FRAME_MAGIC = Uint8Array.from([0x4d, 0x45, 0x54, 0x32])
/** 帧格式版本（独立于握手信封版本）。 */
export const FRAME_FORMAT_VERSION = 1
/** 帧类型：握手（明文，仅升级后头两条）。 */
export const FRAME_HELLO = 1
/** 帧类型：密钥确认（明文 MAC）。 */
export const FRAME_CONFIRM = 2
/** 帧类型：AEAD 数据帧（密文）。 */
export const FRAME_DATA = 3
/** HELLO / CONFIRM 帧长度：MAGIC(4) + ver(1) + type(1) + 32B。 */
export const FRAME_HELLO_LEN = 38
/** 数据帧固定头长度：MAGIC(4) + ver(1) + type(1) + seq(8) + noncePrefix(12)。 */
export const FRAME_DATA_HEADER = 26
/** GCM tag 长度。 */
export const GCM_TAG_LEN = 16
/** HKDF info（域分隔标签）。 */
export const HKDF_INFO = new TextEncoder().encode('myco-p2p-tunnel/v2')
/** 隧道协议版本（进 query `?v=2` 与握手信封）。 */
export const TUNNEL_PROTOCOL_VERSION = 2
/** 端点路径。 */
export const TUNNEL_PATH = '/p2p/tunnel'
/** 握手信封头名（原文即签名载荷）。 */
export const TUNNEL_HANDSHAKE_HEADER = 'x-myco-tunnel'
/** 签名头名。 */
export const TUNNEL_AUTH_HEADER = 'x-myco-auth'
/** 默认白名单端口：13911=DSH 分享网关，9100=p2p 服务器。
 *  2026-10-22 vnet：与 PC 端 `p2p_tunnel::TUNNEL_DEFAULT_PORTS` 对齐，
 *  加入 22(SSH)/3389(RDP)/5555(ADB)/9000(立体声)——手机作为隧道**目标**时
 *  （PC 经 myco 隧道访问手机端口，如 V11 手机 adb）才不会被白名单挡掉。
 *  安全口径不变：准入仍是设备签名+账号归属+端口级授权，这里只是端口清单。 */
export const TUNNEL_DEFAULT_PORTS = [13911, 9100, 22, 3389, 5555, 9000] as const
/** 除信封 `port` 外，隧道端点自己跑在 p2p 服务器上（默认 9100）。 */
export const DEFAULT_P2P_PORT = 9100
/** 帧载荷上限（Rust FRAME_MAX_PAYLOAD：1MB，防对端发超大帧打爆内存）。 */
export const FRAME_MAX_PAYLOAD = 1024 * 1024
/** 隧道内层单次搬运块大小（与 Rust TUNNEL_CHUNK 同：16KB）。 */
export const TUNNEL_CHUNK = 16 * 1024

// ── 并行赛跑预算（与 Rust RACE_* 同值："建连秒级"硬指标） ──
/** 单候选建隧道超时：移动网络 RTT 200-400ms ×（TCP+WS 升级+加密握手 ≈4 RTT）
 *  → 900ms 旧值误杀慢而能通的候选（2026-10-10 与 Rust 同步提到 2s）。 */
export const RACE_CANDIDATE_TIMEOUT_MS = 2000
/** 整场赛跑硬预算：无论多少候选/多慢，都不晚于这个上界返回。 */
export const RACE_TOTAL_BUDGET_MS = 3000
/** 首个成功后留给"几乎同时完成"的候选的合流窗口（让真最快的胜出）。 */
export const RACE_SETTLE_WINDOW_MS = 80

// ── 云端中继腿（2026-10-11；对齐 PC 端 cloud_relay.rs / p2p_tunnel.rs relay_leg） ──
//
// 直连（lan/publicV4/reflexive/ipv6）与反向全断的拓扑下（例：手机 WiFi AP 隔离、
// PC 在家宽光猫后），手机没有任何可拨地址——中继是最后一条路。协议见
// `services/identity-svc/relay.mjs`：consumer 连 TCP → 发 `CONNECT <did>\n` →
// 等 `OK\n` → **同一条 TCP** 上照常跑 `/p2p/tunnel` 的 WS 升级 + v2 加密握手
// （中继只搬字节，provider 侧 PC 的 p2p 服务器验签/白名单一道不少）。
//
// 中继与 identity-svc **同口复用**（:8321 首行嗅探分流）——所有能跑 presence 的
// 网络必达。手机 WebView 的 JS 不能开 TCP，所以 CONNECT 由原生壳代做：base 用
// `relay://` 伪形态，`TunnelWs.java` 见到即走"先 CONNECT 中继再升级"（见
// `relayWsUrl`）。预连池（深 2 / TTL 8s）也在原生层（`RelayTunnel.java`）。

/** 中继地址（阿里云 identity-svc；与 HTTP 同口复用）。 */
export const RELAY_HOST = 'myco.youling.cc'
/** 中继端口（identity 正式口，中继同口复用）。 */
export const RELAY_PORT = 8321
/** 中继默认地址记法（`host:port`）。 */
export const RELAY_DEFAULT_ADDR = `${RELAY_HOST}:${RELAY_PORT}`
/** 中继腿让先：直连候选先跑 300ms（LAN/IPv6 直连几乎必胜——"优先直连"；直连全断时中继胜出）。 */
export const RELAY_LEG_DELAY_MS = 300
/** 中继腿自身预算（TCP+CONNECT+WS 升级+加密握手 ≈3-4×公网 RTT）。 */
export const RELAY_LEG_TIMEOUT_MS = 2500
/** 中继腿 base 的标记前缀（不参与直连拨号；缓存/候选表跳过之——对齐 PC 端 RELAY_BASE）。 */
export const RELAY_BASE_PREFIX = 'relay://'

// ══════════════════ 错误（可断言） ══════════════════

/** 加密层错误码——与 Rust `FrameError` 一一对应（测试按码断言，不按文案）。 */
export type FrameErrorCode =
  /** 首帧不是合法 HELLO（魔数/长度/版本不符） */
  | 'hello-malformed'
  /** ECDH 出全 0（低阶点/非贡献行为）或密钥派生失败 */
  | 'key-rejected'
  /** 密钥确认 MAC 不一致（MITM/降级/密钥不一致） */
  | 'confirm-mismatch'
  /** 收到明文数据帧 / 类型未知 / 帧结构坏 */
  | 'plaintext-or-unknown-frame'
  /** GCM tag 校验失败（篡改）或长度不足 */
  | 'auth-fail'
  /** 序号非递增（重放/乱序） */
  | 'replay-or-out-of-order'
  /** nonce 前缀不符（换钥/串台/降级） */
  | 'prefix-mismatch'

/** 帧层错误。`code` 稳定（测试断言它），`message` 给人看。 */
export class TunnelFrameError extends Error {
  readonly code: FrameErrorCode
  constructor(code: FrameErrorCode, message?: string) {
    super(message ?? FRAME_ERROR_TEXT[code])
    this.name = 'TunnelFrameError'
    this.code = code
  }
}

const FRAME_ERROR_TEXT: Record<FrameErrorCode, string> = {
  'hello-malformed': '加密握手帧无效',
  'key-rejected': '会话密钥协商失败（低阶公钥/非贡献行为）',
  'confirm-mismatch': '会话密钥确认失败（可能被中间人/降级）',
  'plaintext-or-unknown-frame': '收到明文帧或未知帧类型（协议要求全部加密）',
  'auth-fail': '帧认证失败（密文被篡改）',
  'replay-or-out-of-order': '帧序号非递增（重放或乱序）',
  'prefix-mismatch': '帧 nonce 前缀不符（换钥或串台）',
}

// ══════════════════ 小工具 ══════════════════

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** 定长字节比较（避免把 Uint8Array 直接 `===`）。 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

/** 小写 hex（日志/证据用；与 Rust hex_lower 同口径）。 */
export function toHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

/** base64（btoa 在 node 18+ 与 WebView 都在；分块避免 spread 大数组爆栈）。 */
export function toB64(b: Uint8Array): string {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < b.length; i += CH) {
    s += String.fromCharCode(...b.subarray(i, i + CH))
  }
  return btoa(s)
}

/** base64 → 字节。 */
export function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * 一次性 nonce（16B 真随机，`tn-` + 32 hex）。
 * Rust 侧 `next_nonce()` 同形（它也用 getrandom 16B）——**形状不必一致，只要 120s 内不重复**；
 * 保持一致是为了日志/审计好对。
 */
export function nextNonce(rand: (n: number) => Uint8Array = randomBytes): string {
  return `tn-${toHex(rand(16))}`
}

/** CSPRNG（WebView 与 node 都有 globalThis.crypto）。 */
export function randomBytes(n: number): Uint8Array {
  const g = globalThis.crypto
  if (!g?.getRandomValues) throw new Error('本环境没有可用的随机数源（crypto.getRandomValues）')
  const b = new Uint8Array(n)
  g.getRandomValues(b)
  return b
}

/** 生成临时 X25519 密钥对（每次连接新建 = 前向保密）。 */
export function genEphemeral(): { priv: Uint8Array; pub: Uint8Array } {
  const priv = x25519.utils.randomSecretKey()
  return { priv, pub: x25519.getPublicKey(priv) }
}

// ══════════════════ 握手信封 ══════════════════

/**
 * 握手信封原文（**字段顺序即 serde 结构体声明顺序**：v,port,account,device,origin,nonce,cap）。
 *
 * ⚠️ 这个字符串有三个身份：签名载荷、HKDF 的 salt 分量、服务端 `serde_json::from_str` 的输入。
 * 必须以 `JSON.stringify` 的紧凑形态产出（无空格）——serde_json 也是紧凑输出，逐字节可对。
 * 对象字面量的键顺序在 JS 里是**插入序**，所以这里的书写顺序就是输出顺序（别重排）。
 * cap 是纯加法能力声明：v1 对端忽略未知字段；签名与 HKDF 都覆盖完整原文。
 */
export function buildTunnelHandshake(
  account: string,
  device: string,
  origin: string,
  port: number,
  nonce: string,
): string {
  return JSON.stringify({ v: TUNNEL_PROTOCOL_VERSION, port, account, device, origin, nonce, cap: ['resume'] })
}

/** `x-myco-auth` 头值：`<did>.<tsMs>.<sigB64>`。 */
export function tunnelAuthHeader(device: string, tsMs: number, sigB64: string): string {
  return `${device}.${tsMs}.${sigB64}`
}

/**
 * 签名载荷：`<deviceDid>\n<tsMs>\n<握手原文>`。
 * 与 PC 端 `p2p_tunnel::tunnel_credentials` 的 `format!("{did}\n{ts}\n{handshake}")` 一字对应，
 * 也与手机既有 `identity.ts:961 signAuthHeader` 同式（所以设备钥直接用）。
 */
export function tunnelSignMaterial(device: string, tsMs: number, handshakeRaw: string): string {
  return `${device}\n${tsMs}\n${handshakeRaw}`
}

// ══════════════════ URL 形态 ══════════════════

/** 候选基址归一（去空白/尾斜杠）。 */
export function normalizeBase(base: string): string {
  return base.trim().replace(/\/+$/, '')
}

/**
 * `http://host:port` → `ws://host:port/p2p/tunnel?v=2`。
 * 与 Rust `http_to_ws` 同语义（https→wss；已是 ws/wss 的原样补路径；无 scheme 补 ws://）。
 * **版本进 URL**：服务端最廉价地先挡老客户端。
 * 例外：`relay://` 伪 base 原样透传——中继腿的拨号信息（目标 DID + 中继地址）
 * 全在这个 URL 里，由原生壳解析（见 [`relayWsUrl`]）。
 */
export function httpToWs(base: string): string {
  const t = normalizeBase(base)
  if (t.startsWith(RELAY_BASE_PREFIX)) return t
  let host: string
  if (t.startsWith('https://')) host = `wss://${t.slice('https://'.length)}`
  else if (t.startsWith('http://')) host = `ws://${t.slice('http://'.length)}`
  else if (t.startsWith('ws://') || t.startsWith('wss://')) host = t
  else host = `ws://${t}`
  return `${host}${TUNNEL_PATH}?v=${TUNNEL_PROTOCOL_VERSION}`
}

/** [`httpToWs`] 的逆（缓存口径归一：缓存里必须存 host:port 形态）。 */
export function wsToHttp(wsUrl: string): string {
  const t = normalizeBase(wsUrl)
  const head = t.includes(TUNNEL_PATH) ? t.slice(0, t.indexOf(TUNNEL_PATH)) : t
  if (head.startsWith('wss://')) return `https://${head.slice('wss://'.length)}`
  if (head.startsWith('ws://')) return `http://${head.slice('ws://'.length)}`
  return head
}

/** `host:port` 记法（IPv6 走 `[addr]:port`）——与 Rust `format_host_port` 同口径。 */
export function formatHostPort(addr: string, port: number): string {
  return addr.includes(':') ? `[${addr}]:${port}` : `${addr}:${port}`
}

// ══════════════════ 候选 ══════════════════

/**
 * 候选类型（顺序即**优先级展示序**，但**建连是并行的**——先通先得）。
 * 与 PC 端 `p2p_server::LocalCandidates::ordered()` 的 lan → publicV4 → ipv6 一致，
 * 另加 2026-10-09 新增的 `reflexive`（NAT 出口观测地址）与 `cached`（上次胜出）。
 */
export type CandidateKind = 'cached' | 'lan' | 'publicV4' | 'reflexive' | 'ipv6' | 'relay'

/**
 * 一条候选。`base` 形如 `http://192.168.1.82:9100`；中继腿是 `relay://` 伪形态
 * （见 [`relayWsUrl`]——原生壳解析，不参与直连拨号）。
 */
export interface Candidate {
  kind: CandidateKind
  host: string
  port: number
  base: string
  /**
   * 发起让先（ms；缺省 0=立即）。中继腿给直连 300ms 先机——"优先直连，直连全断
   * 才走云"；让先计入赛跑耗时（同速时直连先胜）。
   */
  delayMs?: number
  /** 本腿自己的建连预算（ms；缺省用 raceCandidates 的 perCandidateMs）。 */
  timeoutMs?: number
}

/** 用户能看懂的类型名（失败人话用；不吐 "p2p/tunnel/端口" 这类词只在最终 UI 层做）。 */
export const CANDIDATE_LABEL: Record<CandidateKind, string> = {
  cached: '上次用的地址',
  lan: '局域网地址',
  publicV4: '公网地址',
  reflexive: '穿透地址',
  ipv6: 'IPv6 地址',
  relay: '云端中转',
}

/**
 * 合并候选：**缓存优先 → 显式候选 → 本机地址**，去重保序（第一次出现的位置即优先级）。
 * 与 Rust `merge_candidates` 同语义（首尾空白与尾斜杠归一）。
 */
export function mergeCandidates(cached: string | null, explicit: string[], local: string[]): string[] {
  const out: string[] = []
  const groups = [cached, ...explicit, ...local]
  for (const s of groups) {
    if (s == null) continue
    const t = normalizeBase(s)
    if (t !== '' && !out.includes(t)) out.push(t)
  }
  return out
}

/**
 * 按类型装配候选清单（手机侧寻址：presence 上报的地址 + 上次胜出缓存）。
 *
 * 输入形状**逐字对齐 PC 端 `p2p_server::LocalCandidates::addrs_json`**：
 * `{lan, lanList, publicV4, publicV4List, ipv6, ipv6List, reflexive, reflexiveList, port}`
 * （空类别整键省略；单值键 = 该类首个地址）。收集顺序必须与
 * `p2p_client::peer_from_entry` 一致：**lan → publicV4 → reflexive → ipv6**。
 */
export interface PeerAddrs {
  /** 单值键（旧/手工上报）。 */
  lan?: string
  publicV4?: string
  reflexive?: string
  ipv6?: string
  /** 列表键（现行口径）。 */
  lanList?: string[]
  publicV4List?: string[]
  reflexiveList?: string[]
  ipv6List?: string[]
  /** PC 的 p2p 端口（缺省 9100）。 */
  port?: number
}

/** 组装候选（同类型内保持上游顺序；跨类型 cached → lan → publicV4 → reflexive → ipv6）。 */
export function buildCandidates(addrs: PeerAddrs, cachedBase?: string | null): Candidate[] {
  const port = addrs.port ?? DEFAULT_P2P_PORT
  const out: Candidate[] = []
  const seen = new Set<string>()
  const push = (kind: CandidateKind, addr: string | undefined | null): void => {
    if (!addr) return
    // presence 可能给数组（如 lanList: ["192.168.1.82"]）——归一成字符串再 trim
    const a = Array.isArray(addr) ? String(addr[0] ?? '') : String(addr)
    const host = a.trim()
    if (host === '') return
    const base = `http://${formatHostPort(host, port)}`
    if (seen.has(base)) return
    seen.add(base)
    out.push({ kind, host, port, base })
  }
  if (cachedBase) {
    const b = normalizeBase(cachedBase)
    // 中继胜出的标记形态不进直连候选表（对齐 PC 端"缓存/候选表跳过 relay://"——
    // 中继腿由调用方按 targetDeviceDid 现场装配，见 relayCandidate）
    if (b !== '' && !isRelayBase(b)) {
      seen.add(b)
      // 缓存里可能带 scheme / 端口；这里只做类型标注，host/port 从 base 反解
      const hp = /^(?:https?|wss?):\/\/(.+)$/.exec(b)?.[1] ?? b
      const host = hp.startsWith('[') ? hp.slice(1, hp.indexOf(']')) : hp.split(':')[0]
      const p = hp.startsWith('[') ? Number(hp.slice(hp.indexOf(']') + 2)) : Number(hp.split(':')[1] ?? port)
      out.push({ kind: 'cached', host, port: Number.isFinite(p) ? p : port, base: b })
    }
  }
  const each = (kind: CandidateKind, list?: string[], single?: string): void => {
    if (list?.length) for (const a of list) push(kind, a)
    else push(kind, single)
  }
  each('lan', addrs.lanList, addrs.lan)
  each('publicV4', addrs.publicV4List, addrs.publicV4)
  each('reflexive', addrs.reflexiveList, addrs.reflexive)
  each('ipv6', addrs.ipv6List, addrs.ipv6)
  return out
}

// ── 云端中继腿的装配（base 形态与解析） ──

/** base 是否是中继腿的标记形态（`relay://` 伪 base——不参与直连拨号/缓存）。 */
export function isRelayBase(base: string): boolean {
  return base.startsWith(RELAY_BASE_PREFIX)
}

/** `host[:port]` → { host, port }（`[v6]`/`[v6]:port` 认方括号；缺省 8321）。 */
export function parseRelayAddr(addr: string): { host: string; port: number } {
  const t = addr.trim()
  if (t.startsWith('[')) {
    const close = t.indexOf(']')
    if (close > 1) {
      const host = t.slice(1, close)
      const rest = t.slice(close + 1)
      const port = rest.startsWith(':') ? Number(rest.slice(1)) : NaN
      return { host, port: Number.isFinite(port) && port > 0 ? port : RELAY_PORT }
    }
    return { host: RELAY_HOST, port: RELAY_PORT }
  }
  const i = t.lastIndexOf(':')
  if (i > 0 && /^\d+$/.test(t.slice(i + 1))) {
    const port = Number(t.slice(i + 1))
    return { host: t.slice(0, i), port: Number.isFinite(port) && port > 0 ? port : RELAY_PORT }
  }
  return { host: t === '' ? RELAY_HOST : t, port: RELAY_PORT }
}

/**
 * 中继腿 base：`relay://<targetDeviceDid>@<host>:<port>/p2p/tunnel?v=2`。
 *
 * 原生壳（`TunnelWs.java`）见到 `relay://` 即走中继路径：TCP 连中继 → 发
 * `CONNECT <did>\n` → 等 `OK\n` → **同一条 TCP** 上做 `/p2p/tunnel` 的 WS 升级
 * （与直连腿同款，握手信封/签名/AEAD 一字不差）。DID 不含 `@`，用一个 `@`
 * 分隔目标设备与中继地址（取最后一个 `@`，与原生解析口径一致）。
 */
export function relayWsUrl(targetDeviceDid: string, addr: string = RELAY_DEFAULT_ADDR): string {
  const { host, port } = parseRelayAddr(addr)
  return `${RELAY_BASE_PREFIX}${targetDeviceDid}@${formatHostPort(host, port)}${TUNNEL_PATH}?v=${TUNNEL_PROTOCOL_VERSION}`
}

/**
 * 装配一条中继候选（赛跑的一条腿）。
 *
 * · `host` = 中继主机（诊断/展示）；**`port` 不是中继端口**——候选的 `port` 沿用
 *   "对端 p2p 数据面端口"口径（dsh-open 的 p2pPort 推导 `deps.p2pPort ?? c.port
 *   ?? 9100` 拿它当信封 targetPort），所以这里存 9100；中继自己的地址只藏在
 *   base（`relay://…@host:port`）里，原生壳从 base 解析；
 * · `delayMs=300`：给直连让先（LAN/IPv6 几乎必胜；直连全断时中继胜出）；
 * · `timeoutMs=2500`：中继腿自身预算（TCP+CONNECT+WS+加密握手）。
 */
export function relayCandidate(targetDeviceDid: string, addr: string = RELAY_DEFAULT_ADDR): Candidate {
  const { host } = parseRelayAddr(addr)
  return {
    kind: 'relay',
    host,
    port: DEFAULT_P2P_PORT,
    base: relayWsUrl(targetDeviceDid, addr),
    delayMs: RELAY_LEG_DELAY_MS,
    timeoutMs: RELAY_LEG_TIMEOUT_MS,
  }
}

/**
 * 建连失败的人话原因（把"候选清单的实际构成"翻成用户能懂的话）。
 * 与 Rust `no_route_hint` 同口径——**不吐 tunnel/p2p/端口**，只说下一步能做什么。
 */
export function noRouteHint(targetName: string, candidates: Candidate[]): string {
  const kinds = [...new Set(candidates.map((c) => CANDIDATE_LABEL[c.kind]))]
  const what = kinds.length ? kinds.join('、') : '任何地址'
  return (
    `连不上 ${targetName}（试过：${what}）。` +
    '通常是两台设备不在同一个网络、或对方设备刚离线——确认对方电脑开着 myco，再点一次试试。'
  )
}

/** 全部候选都失败时的分类（供 UI 区分"没地址"与"有地址但连不上"）。 */
export type TunnelFailReason = 'no-candidates' | 'all-failed' | 'rejected'

// ══════════════════ 会话密钥 ══════════════════

/** 一条隧道的会话密钥材料（每次连接新建；用后即弃 = 前向保密）。 */
export interface SessionKeys {
  c2s: Uint8Array
  s2c: Uint8Array
  prefix: Uint8Array
  confirmC2s: Uint8Array
  confirmS2c: Uint8Array
}

/** 我在本条隧道的角色（决定 HKDF 里 ct 的拼接顺序与方向密钥的取用）。 */
export type TunnelRole = 'originator' | 'responder'

/**
 * 由 ECDH + HKDF 派生会话密钥（两端同法，输入对称：**ct_client 恒在 ct_server 之前**）。
 * `shared` 全 0 → `key-rejected`（低阶点/非贡献行为）。
 */
export function deriveSessionKeys(
  shared: Uint8Array,
  ctClient: Uint8Array,
  ctServer: Uint8Array,
  handshakeRaw: string,
): SessionKeys {
  if (shared.length !== 32) throw new TunnelFrameError('key-rejected', 'ECDH 共享密钥长度异常')
  let allZero = true
  for (const b of shared) {
    if (b !== 0) {
      allZero = false
      break
    }
  }
  if (allZero) throw new TunnelFrameError('key-rejected')
  const salt = sha256(new Uint8Array([...FRAME_MAGIC, ...ctClient, ...ctServer, ...utf8(handshakeRaw)]))
  const okm = hkdf(sha256, shared, salt, HKDF_INFO, 140)
  if (okm.length !== 140) throw new TunnelFrameError('key-rejected', 'HKDF 输出长度异常')
  return {
    c2s: okm.slice(0, 32),
    s2c: okm.slice(32, 64),
    prefix: okm.slice(64, 76),
    confirmC2s: okm.slice(76, 108),
    confirmS2c: okm.slice(108, 140),
  }
}

/** 从临时私钥 + 对端临时公钥派生（薄封装，生产路径用）。 */
export function deriveWithEcdh(
  myPriv: Uint8Array,
  theirPub: Uint8Array,
  ctClient: Uint8Array,
  ctServer: Uint8Array,
  handshakeRaw: string,
): SessionKeys {
  const shared = x25519.getSharedSecret(myPriv, theirPub)
  return deriveSessionKeys(shared, ctClient, ctServer, handshakeRaw)
}

// ══════════════════ 帧编解码 ══════════════════

/** HELLO 帧：`[MAGIC][ver][HELLO][pub32]`。 */
export function helloFrame(pub: Uint8Array): Uint8Array {
  if (pub.length !== 32) throw new TunnelFrameError('hello-malformed', 'HELLO 载荷必须 32B')
  const f = new Uint8Array(FRAME_HELLO_LEN)
  f.set(FRAME_MAGIC, 0)
  f[4] = FRAME_FORMAT_VERSION
  f[5] = FRAME_HELLO
  f.set(pub, 6)
  return f
}

/** 解析 HELLO 帧 → 32B 公钥（校验魔数/版本/类型/长度）。 */
export function parseHello(frame: Uint8Array): Uint8Array {
  if (frame.length !== FRAME_HELLO_LEN) throw new TunnelFrameError('hello-malformed')
  if (!bytesEqual(frame.subarray(0, 4), FRAME_MAGIC)) throw new TunnelFrameError('hello-malformed')
  if (frame[4] !== FRAME_FORMAT_VERSION || frame[5] !== FRAME_HELLO) {
    throw new TunnelFrameError('hello-malformed')
  }
  return frame.slice(6, 38)
}

/** 数据帧 nonce = prefix 的末 8 字节（大端 u64）异或 seq。 */
export function nonceFor(prefix: Uint8Array, seq: bigint): Uint8Array {
  const n = prefix.slice()
  const dv = new DataView(n.buffer, n.byteOffset, n.byteLength)
  const tail = dv.getBigUint64(4, false) ^ seq
  dv.setBigUint64(4, tail, false)
  return n
}

/**
 * 帧编解码器（一个连接一套；发送/接收各自单调序号）。
 * **纯函数式状态**（无 IO）：seal → 字节；open → 明文或抛 `TunnelFrameError`。
 */
export class FrameIo {
  private readonly txKey: Uint8Array
  private readonly rxKey: Uint8Array
  private readonly confirmKey: Uint8Array
  private readonly peerConfirmKey: Uint8Array
  readonly keys: SessionKeys
  readonly role: TunnelRole
  private readonly handshakeRaw: string
  private sendSeq = 0n
  private recvMaxSeq: bigint | null = null

  constructor(keys: SessionKeys, role: TunnelRole, handshakeRaw: string) {
    this.keys = keys
    this.role = role
    this.handshakeRaw = handshakeRaw
    this.txKey = role === 'originator' ? keys.c2s : keys.s2c
    this.rxKey = role === 'originator' ? keys.s2c : keys.c2s
    this.confirmKey = role === 'originator' ? keys.confirmC2s : keys.confirmS2c
    this.peerConfirmKey = role === 'originator' ? keys.confirmS2c : keys.confirmC2s
  }

  /** 本方向确认帧（明文 MAC 载荷）。 */
  confirmFrame(): Uint8Array {
    const mac = hmac(sha256, this.confirmKey, utf8(this.handshakeRaw))
    const f = new Uint8Array(FRAME_HELLO_LEN)
    f.set(FRAME_MAGIC, 0)
    f[4] = FRAME_FORMAT_VERSION
    f[5] = FRAME_CONFIRM
    f.set(mac, 6)
    return f
  }

  /** 校验对端确认帧（常量时间比较，不一致 = MITM/降级）。 */
  acceptConfirm(frame: Uint8Array): void {
    if (frame.length !== FRAME_HELLO_LEN || !bytesEqual(frame.subarray(0, 4), FRAME_MAGIC)) {
      throw new TunnelFrameError('hello-malformed')
    }
    if (frame[4] !== FRAME_FORMAT_VERSION || frame[5] !== FRAME_CONFIRM) {
      throw new TunnelFrameError('plaintext-or-unknown-frame')
    }
    const want = hmac(sha256, this.peerConfirmKey, utf8(this.handshakeRaw))
    if (!bytesEqual(frame.subarray(6, 38), want)) throw new TunnelFrameError('confirm-mismatch')
  }

  /** 已发送帧数（诊断）。 */
  get sentFrames(): number {
    return Number(this.sendSeq)
  }

  /** 加密一帧（序号自增）。 */
  seal(plaintext: Uint8Array): Uint8Array {
    const seq = this.sendSeq
    this.sendSeq += 1n
    const nonce = nonceFor(this.keys.prefix, seq)
    const ct = gcm(this.txKey, nonce).encrypt(plaintext)
    const f = new Uint8Array(FRAME_DATA_HEADER + ct.length)
    f.set(FRAME_MAGIC, 0)
    f[4] = FRAME_FORMAT_VERSION
    f[5] = FRAME_DATA
    new DataView(f.buffer, f.byteOffset, f.byteLength).setBigUint64(6, seq, false)
    f.set(this.keys.prefix, 14)
    f.set(ct, FRAME_DATA_HEADER)
    return f
  }

  /**
   * 解一帧（校验结构 + nonce 前缀 + tag + 单调序号）。
   * 顺序与 Rust `FrameIo::open` 一致：魔数 → 长度 → 版本 → 类型 → 前缀 → 序号 → GCM。
   * **只有 GCM 通过后才推进 recvMaxSeq**（否则一个坏帧就能把序号推到未来）。
   */
  open(frame: Uint8Array): Uint8Array {
    if (frame.length < 4 || !bytesEqual(frame.subarray(0, 4), FRAME_MAGIC)) {
      throw new TunnelFrameError('plaintext-or-unknown-frame')
    }
    if (frame.length < FRAME_DATA_HEADER + GCM_TAG_LEN) throw new TunnelFrameError('auth-fail')
    if (frame[4] !== FRAME_FORMAT_VERSION) throw new TunnelFrameError('plaintext-or-unknown-frame')
    if (frame[5] !== FRAME_DATA) throw new TunnelFrameError('plaintext-or-unknown-frame')
    if (frame.length - FRAME_DATA_HEADER > FRAME_MAX_PAYLOAD) {
      throw new TunnelFrameError('auth-fail', '帧过大')
    }
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    const seq = dv.getBigUint64(6, false)
    if (!bytesEqual(frame.subarray(14, 26), this.keys.prefix)) {
      throw new TunnelFrameError('prefix-mismatch')
    }
    if (this.recvMaxSeq !== null && seq <= this.recvMaxSeq) {
      throw new TunnelFrameError('replay-or-out-of-order')
    }
    const nonce = nonceFor(this.keys.prefix, seq)
    let pt: Uint8Array
    try {
      pt = gcm(this.rxKey, nonce).decrypt(frame.subarray(FRAME_DATA_HEADER))
    } catch {
      throw new TunnelFrameError('auth-fail')
    }
    this.recvMaxSeq = seq
    return pt
  }
}

// ══════════════════ 传输抽象 ══════════════════

/**
 * 隧道用的一条 WS 连接（二进制消息）。
 *
 * **为什么不是直接用全局 `WebSocket`**：浏览器/WebView 的 `WebSocket` 构造函数
 * **不能设自定义请求头**，而握手信封与设备签名必须在 `x-myco-tunnel` / `x-myco-auth`
 * 两个头上（Rust 只读 header）。所以生产实现由**原生壳代开**（Java 自己握手 + 分帧），
 * JS 拿到的是"已升级、可收发二进制"的通道；测试里则背靠背直连。
 */
export interface TunnelSocket {
  /** 发一条二进制消息。 */
  send(data: Uint8Array): void
  /** 主动关闭（幂等；code 1000=正常）。 */
  close(code?: number, reason?: string): void
  /** 注册消息回调（返回取消函数）。 */
  onMessage(cb: (data: Uint8Array) => void): () => void
  /** 注册关闭回调（连接断开/出错都走这里）。 */
  onClose(cb: (info: { code?: number; reason?: string; error?: string }) => void): () => void
}

/** 打开一条带自定义头的 WS（生产=原生壳，测试=内存对）。 */
export type TunnelSocketFactory = (
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<TunnelSocket>

/** 一次成功建连的产物。 */
export interface OpenTunnelResult {
  socket: TunnelSocket
  io: FrameIo
  /** 本次连接自己的握手原文（加密握手绑定的就是它——nonce 每次不同，不能借用别人的）。 */
  handshakeRaw: string
  /** 胜出候选的 base（`http://host:port`）。 */
  base: string
  /** 从发起到加密握手完成的耗时（ms）。 */
  elapsedMs: number
  /**
   * 加密握手期间到达的**下行数据帧**（按到达序）。
   *
   * 2026-10-23 回程丢帧：服务端（PC）在收到 CONFIRM 后立刻拨目标端口，"连接即首发"
   * 的服务（sshd banner）下行帧可能挤进握手收包 inbox；openTunnel 只消费两条握手帧，
   * 剩余帧在 offMsg() 时会被静默丢弃。现在原样交给调用方（必须**先于**后续帧处理，
   * 它们的 seq 最小——顺序错了会触发单调序号检查 replay-or-out-of-order）。
   */
  earlyFrames: Uint8Array[]
}

/** 建连身份（由调用方从 identity.ts 注入——本模块不碰 localStorage）。 */
export interface TunnelIdentity {
  /** 本机账号 DID（授权判定的主体）。 */
  account: string
  /** 本机设备 DID（= 签名者）。 */
  device: string
  /** 用设备钥签名（ed25519，返回 base64；失败 null）。 */
  sign: (material: string) => Promise<string | null>
}

/** 建连选项。 */
export interface OpenTunnelOptions {
  identity: TunnelIdentity
  /** 隧道对端（PC）的 p2p 端口——信封里的 `port` 是**隧道内要访问的目标端口**，两者不同。 */
  targetPort: number
  factory: TunnelSocketFactory
  /** 可注入时间（测试）。 */
  now?: () => number
  /** 可注入 nonce（测试）。 */
  nonce?: () => string
  /** 握手/确认超时（ms；默认 8s）。 */
  handshakeTimeoutMs?: number
}

/** 建连失败（人话 + 机器可判的 reason）。 */
export class TunnelConnectError extends Error {
  readonly reason: TunnelFailReason | 'cancelled' | 'handshake'
  readonly base: string
  constructor(reason: TunnelConnectError['reason'], base: string, message: string) {
    super(message)
    this.name = 'TunnelConnectError'
    this.reason = reason
    this.base = base
  }
}

/**
 * 建一条隧道（**一条 WS = 一条到目标端口的 TCP 连接**，与 PC 端 `tunnel_conn` 同构）。
 *
 * 步骤：握手信封 + 设备签名 → 升级 WS → v2 加密握手（HELLO/HELLO_ACK/CONFIRM 互验）。
 * 任一步失败都抛 `TunnelConnectError`（**不静默降级**）。
 */
export async function openTunnel(base: string, opts: OpenTunnelOptions): Promise<OpenTunnelResult> {
  const t0 = (opts.now ?? Date.now)()
  const wsUrl = httpToWs(base)
  const nonce = (opts.nonce ?? nextNonce)()
  const { account, device, sign } = opts.identity
  const handshakeRaw = buildTunnelHandshake(account, device, device, opts.targetPort, nonce)
  const ts = (opts.now ?? Date.now)()
  const material = tunnelSignMaterial(device, ts, handshakeRaw)
  const sig = await sign(material)
  if (!sig) throw new TunnelConnectError('handshake', base, '设备签名失败（身份未就绪或已锁定）')
  const headers: Record<string, string> = {
    [TUNNEL_HANDSHAKE_HEADER]: handshakeRaw,
    [TUNNEL_AUTH_HEADER]: tunnelAuthHeader(device, ts, sig),
  }
  const ac = new AbortController()
  let socket: TunnelSocket | null = null
  const timeoutMs = opts.handshakeTimeoutMs ?? 8000
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    socket = await opts.factory(wsUrl, headers, ac.signal)
    const eph = genEphemeral()
    const inbox: Uint8Array[] = []
    let notify: (() => void) | null = null
    let closed: { code?: number; reason?: string; error?: string } | null = null
    const offMsg = socket.onMessage((d) => {
      inbox.push(d)
      notify?.()
    })
    const offClose = socket.onClose((info) => {
      closed = info
      notify?.()
    })
    const waitFrame = async (n: number): Promise<Uint8Array> => {
      while (inbox.length < n) {
        if (closed) {
          const c = closed as { code?: number; reason?: string; error?: string }
          throw new TunnelConnectError('handshake', base, `连接在握手期间断开${c.reason ? `：${c.reason}` : ''}`)
        }
        if (ac.signal.aborted) throw new TunnelConnectError('handshake', base, '握手超时')
        await new Promise<void>((resolve) => {
          notify = resolve
          setTimeout(resolve, 50)
        })
        notify = null
      }
      return inbox[n - 1]
    }
    try {
      socket.send(helloFrame(eph.pub))
      // 服务端回 HELLO_ACK，然后（不等我方 CONFIRM）就发它的 CONFIRM —— 见 Rust
      // `crypto_handshake_server`：先发确认帧再收，两端对称无死锁。
      const helloAck = parseHello(await waitFrame(1))
      const io = new FrameIo(
        deriveWithEcdh(eph.priv, helloAck, eph.pub, helloAck, handshakeRaw),
        'originator',
        handshakeRaw,
      )
      io.acceptConfirm(await waitFrame(2))
      socket.send(io.confirmFrame())
      clearTimeout(timer)
      // 握手完成前挤进 inbox 的下行数据帧（如 sshd banner）：offMsg 前摘出来交给调用方
      const earlyFrames = inbox.splice(2)
      offMsg()
      offClose()
      return { socket, io, handshakeRaw, base: normalizeBase(base), elapsedMs: (opts.now ?? Date.now)() - t0, earlyFrames }
    } catch (e) {
      offMsg()
      offClose()
      try {
        socket.close(1002, 'handshake-failed')
      } catch {
        /* 已断 */
      }
      throw e
    }
  } catch (e) {
    if (e instanceof TunnelConnectError) throw e
    const msg = ac.signal.aborted
      ? `连接超时（${timeoutMs}ms）`
      : e instanceof Error
        ? e.message
        : String(e)
    throw new TunnelConnectError('rejected', base, msg)
  } finally {
    clearTimeout(timer)
  }
}

// ══════════════════ 并行赛跑 ══════════════════

/** 一次赛跑的产物（含每个候选的结果，供诊断/人话）。 */
export interface RaceResult {
  winner: OpenTunnelResult
  /** 被取消/失败的候选（诊断）。 */
  losers: { base: string; reason: string }[]
  /** 参跑候选数。 */
  tried: number
}

/**
 * **并行赛跑**（核心，与 Rust `race_tunnel` 同语义）：
 * 所有候选**同时发起**，首个成功即采用（其余立刻取消），
 * 但给"几乎同时完成"的候选一个极短的**合流窗口**（80ms）让真最快的胜出；
 * `budgetMs` 是整场硬预算（用尽返回当前结果 / null）。
 *
 * 失败人话由调用方用 `noRouteHint` 组装（本函数只回机器可判的结果）。
 */
export async function raceCandidates(
  candidates: Candidate[],
  opts: OpenTunnelOptions & {
    perCandidateMs?: number
    totalBudgetMs?: number
    settleMs?: number
    /**
     * 每条腿**失败/被取消**时的回调（诊断用）。
     *
     * 为什么需要：全灭时本函数返回 `null`，调用方拿不到任何"为什么全灭"的信息——
     * 而 `null` 有两种完全不同的根因（没有地址 / 有地址但都连不上），现场排障只能靠它。
     * 2026-10-22 手机 vnet：没有这个回调时，notes 里只有一句 `race timeout/null`，
     * 中继腿到底是 NOT_FOUND、BUSY、还是本腿超时无从判断。
     */
    onLoser?: (base: string, reason: string) => void
  },
): Promise<RaceResult | null> {
  if (candidates.length === 0) return null
  const per = opts.perCandidateMs ?? RACE_CANDIDATE_TIMEOUT_MS
  const budget = opts.totalBudgetMs ?? RACE_TOTAL_BUDGET_MS
  const settle = opts.settleMs ?? RACE_SETTLE_WINDOW_MS
  const now = opts.now ?? Date.now
  const t0 = now()

  const losers: { base: string; reason: string }[] = []
  const noteLoser = (base: string, reason: string): void => {
    losers.push({ base, reason })
    try {
      opts.onLoser?.(base, reason)
    } catch {
      /* 诊断回调不许影响赛跑 */
    }
  }
  const winners: OpenTunnelResult[] = []
  let done = 0
  let wake: (() => void) | null = null
  /** 赛跑已裁决：其余在途腿全部取消（防泄漏——中继腿 300ms 让先期间直连若已胜出，
   *  不取消就会白白拨一条中继隧道、在 provider 侧挂一个死会话）。 */
  const raceAc = new AbortController()
  const bump = (): void => {
    done += 1
    const w = wake
    wake = null
    w?.()
  }
  /** 睡 ms，或被"有候选完成"提前唤醒（返回是否被唤醒）。 */
  const waitTick = (ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let woken = false
      const h = setTimeout(() => {
        wake = null
        resolve(false)
      }, ms)
      wake = () => {
        woken = true
        clearTimeout(h)
        resolve(true)
      }
      if (ms <= 0) {
        clearTimeout(h)
        wake = null
        resolve(false)
      }
      void woken
    })

  // ① 全部候选同时发起（**并行**是本函数的全部意义：先通先得，不等慢的）。
  //    带 `delayMs` 的腿（中继）先让先再发起；让先计入其赛跑耗时（同速时直连先胜）。
  const tasks = candidates.map(async (c) => {
    const delay = c.delayMs ?? 0
    if (delay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay))
      if (raceAc.signal.aborted) {
        noteLoser(c.base, '已取消（直连已胜出）')
        bump()
        return
      }
    }
    const budget = c.timeoutMs ?? per
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), budget)
    try {
      const w = await openTunnel(c.base, {
        ...opts,
        factory: withAbort(opts.factory, ac.signal, raceAc.signal),
      })
      if (delay > 0) w.elapsedMs += delay
      winners.push(w)
    } catch (e) {
      noteLoser(
        c.base,
        ac.signal.aborted ? `超时 ${budget}ms` : e instanceof Error ? e.message : String(e),
      )
    } finally {
      clearTimeout(timer)
      bump()
    }
  })
  const all = Promise.all(tasks)

  // ② 选路循环：无胜出者时等到预算用尽 / 全部完成；
  //    有胜出者后再给一个极短合流窗口（让"几乎同时完成"的真最快者胜出）。
  while (true) {
    if (done >= candidates.length) break
    const elapsed = now() - t0
    if (winners.length > 0) {
      const best = Math.min(...winners.map((w) => w.elapsedMs))
      const left = settle - (elapsed - best)
      if (left <= 0) break
      await waitTick(left)
      continue
    }
    const left = budget - elapsed
    if (left <= 0) break
    await waitTick(left)
  }
  // 裁决已定（或预算用尽）：取消一切仍在途的腿（含还在让先睡的中继腿）
  raceAc.abort()
  if (winners.length === 0) {
    // 预算用尽但仍有在途尝试：不 await（调用方拿到"失败"即可），只保证不留悬挂句柄
    void all.catch(() => undefined)
    return null
  }

  // ③ 胜者 = 握手耗时最小的那个（不是"最先 push 进数组"的那个）；其余关掉
  const sorted = [...winners].sort((a, b) => a.elapsedMs - b.elapsedMs)
  const winner = sorted[0]
  for (const w of sorted.slice(1)) {
    try {
      w.socket.close(1000, 'slower')
    } catch {
      /* 已断 */
    }
  }
  // 仍在飞的尝试：等它们落地后按同一规则二次裁决（合流窗口里可能还有更快的）
  void all.then(() => {
    const later = winners
      .filter((w) => w !== winner && w.elapsedMs < winner.elapsedMs)
      .sort((a, b) => a.elapsedMs - b.elapsedMs)[0]
    if (later) {
      try {
        later.socket.close(1000, 'settled')
      } catch {
        /* ignore */
      }
    }
  })
  return { winner, losers, tried: candidates.length }
}

/** 把外层 signal（可多个：候选自身超时 + 整场裁决）与内层取消合流（任一触发即 abort）。 */
function withAbort(factory: TunnelSocketFactory, ...signals: AbortSignal[]): TunnelSocketFactory {
  return (url, headers, inner) => {
    const live = signals.filter((s) => !s.aborted)
    if (live.length !== signals.length) return Promise.reject(new Error('已取消'))
    const merged = new AbortController()
    const onAbort = (): void => merged.abort()
    for (const s of live) s.addEventListener('abort', onAbort, { once: true })
    inner.addEventListener('abort', onAbort, { once: true })
    return factory(url, headers, merged.signal)
  }
}

/**
 * 探路：并行赛跑建一次隧道（成功即关掉探路连接），返回可用 base。
 * 与 Rust `probe_tunnel_parallel` 同语义。
 */
export async function probeTunnelParallel(
  candidates: Candidate[],
  opts: OpenTunnelOptions & { perCandidateMs?: number; totalBudgetMs?: number; settleMs?: number },
): Promise<string | null> {
  const r = await raceCandidates(candidates, opts)
  if (!r) return null
  try {
    r.winner.socket.close(1000, 'probe-done')
  } catch {
    /* ignore */
  }
  return r.winner.base
}

// ══════════════════ 反向连接：手机跑服务端角色（2026-10-09） ══════════════════
//
// **角色互换**：谁拨 TCP 谁就是发起方（originator）——签 `x-myco-tunnel` 信封、
// `x-myco-auth` 签名、加密握手先发 HELLO；接电话的一方是应答方（responder）——
// 验签 + 闸门 + 回 HELLO_ACK。反向连接时 PC 拨手机，所以 **PC 是发起方、手机是
// 应答方**——与 Rust `crypto_handshake_server`（responder 侧）逐字节同构。
//
// 手机侧闸门（对齐 PC 端 `handle_tunnel` 的顺序，人话原因一致）：
//   ① 请求行必须是 `GET /p2p/tunnel?v=2`（版本不符 → 400，不静默降级）；
//   ② `x-myco-tunnel` 信封：v==2、port 在白名单、nonce/origin/account/device 非空；
//   ③ `x-myco-auth` 验签（did.ts.sig，签 `did\nts\n<信封原文>`，±60s 窗口）；
//   ④ 签名者 = 信封 device = 信封 origin（did_equiv 公钥级判等）；
//   ⑤ **信封 device = 预期源设备**（本会话分享卡的 sourceDevice）——这是反向
//      入站最硬的一道闸：互联网上任何扫到本机 IPv6:端口 的设备，没有源设备
//      私钥就过不了这一关；
//   ⑥ nonce 120s 去重（防重放抓来的合法握手）。
// 过全闸 → 回 `101 Switching Protocols` → v2 加密握手（responder）→ 数据双向。
//
// 传输层注意：服务端方向上 **WS 帧** 由本模块自理（客户端帧必带掩码、服务端帧
// 必不带）——原生壳只搬 TCP 字节（`TunnelProxyServer`），协议全在 JS。

/** RFC 6455 握手 GUID（`Sec-WebSocket-Accept` 计算）。 */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** `Sec-WebSocket-Accept` = base64(SHA1(key + GUID))——RFC 6455 §4.2.2。 */
export function wsAcceptKey(secWebSocketKey: string): string {
  return toB64(sha1(utf8(`${secWebSocketKey}${WS_GUID}`)))
}

/** 签名时间窗（±60s，与 Rust `p2p_server::AUTH_WINDOW_MS` 同值）。 */
export const AUTH_WINDOW_MS = 60_000

/** 握手 nonce 去重窗口（120s，与 Rust `TUNNEL_NONCE_WINDOW_MS` 同值）。 */
export const NONCE_WINDOW_MS = 120_000

/** 拼接字节（小工具）。 */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/** 解析后的 HTTP 升级请求（头部完整才算数）。 */
export interface ParsedUpgradeRequest {
  method: string
  /** 含 query 的原始路径（如 `/p2p/tunnel?v=2`）。 */
  path: string
  /** 头表（键小写；重复头逗号合并）。 */
  headers: Record<string, string>
  /** 头部总字节数（`\r\n\r\n` 含）——调用方据此切掉 body 部分。 */
  headLen: number
}

/**
 * 从字节流解出完整请求头（纯函数）：没到 `\r\n\r\n` 返回 null（继续攒）。
 * 用 latin1 解码——头是 ASCII，二进制尾部不影响。
 */
export function parseUpgradeRequest(buf: Uint8Array): ParsedUpgradeRequest | null {
  const text = new TextDecoder('latin1').decode(buf)
  const idx = text.indexOf('\r\n\r\n')
  if (idx < 0) return null
  const head = text.slice(0, idx)
  const lines = head.split('\r\n')
  const reqLine = /^([A-Z]+)\s+(\S+)\s+HTTP\//.exec(lines[0] ?? '')
  if (!reqLine) return null
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const k = line.slice(0, i).trim().toLowerCase()
    const v = line.slice(i + 1).trim()
    headers[k] = headers[k] === undefined ? v : `${headers[k]}, ${v}`
  }
  return { method: reqLine[1], path: reqLine[2], headers, headLen: idx + 4 }
}

/** `101 Switching Protocols`（含按对方 key 算的 accept）。 */
export function buildUpgradeResponse(headers: Record<string, string>): Uint8Array {
  const accept = wsAcceptKey(headers['sec-websocket-key'] ?? '')
  const head =
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  return utf8(head)
}

/** 拒绝响应（对齐 PC 端 `TunnelReject::into_response`：JSON `{"error":人话}`）。 */
export function buildTunnelHttpResponse(status: number, reason: string, message: string): Uint8Array {
  const body = JSON.stringify({ error: message })
  const head =
    `HTTP/1.1 ${status} ${reason}\r\n` +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${utf8(body).length}\r\n` +
    'Connection: close\r\n\r\n'
  return utf8(head + body)
}

/** 请求路径是否是本隧道端点且 query `v=2`（与 Rust `query_version_ok` 同语义）。 */
export function tunnelPathVersionOk(path: string): boolean {
  const q = path.indexOf('?')
  const p = q >= 0 ? path.slice(0, q) : path
  if (p !== TUNNEL_PATH) return false
  if (q < 0) return false
  return path
    .slice(q + 1)
    .split('&')
    .some((kv) => {
      const [k, v] = kv.split('=')
      return (k === 'v' || k === 'V') && v === String(TUNNEL_PROTOCOL_VERSION)
    })
}

/** `x-myco-auth` 头值（`did.ts.sig`）拆解；形状不对 → null。 */
export interface TunnelAuthParts {
  did: string
  ts: number
  sig: Uint8Array
}

export function parseTunnelAuthHeader(v: string): TunnelAuthParts | null {
  const parts = v.split('.')
  if (parts.length !== 3) return null
  const ts = Number(parts[1])
  if (!Number.isFinite(ts) || ts <= 0) return null
  let sig: Uint8Array
  try {
    sig = fromB64(parts[2])
  } catch {
    return null
  }
  if (sig.length !== 64) return null
  return { did: parts[0], ts, sig }
}

/**
 * 验 `x-myco-auth`（对齐 Rust `p2p_server::verify_auth`）：
 * ±60s 窗口 → did 解公钥（双格式双 method）→ ed25519 验 `did\nts\n<信封原文>`。
 * 返回签名者 did；任一步失败 null。
 */
export function verifyTunnelAuth(auth: TunnelAuthParts, rawBody: string, now: number): string | null {
  if (now > auth.ts + AUTH_WINDOW_MS || auth.ts > now + AUTH_WINDOW_MS) return null
  const pub = didPubkeyBytes(auth.did)
  if (!pub) return null
  const ok = ed25519.verify(auth.sig, utf8(tunnelSignMaterial(auth.did, auth.ts, rawBody)), pub)
  return ok ? auth.did : null
}

// ── nonce 去重（120s 窗口；模块级状态，测试可清） ──

const SEEN_TUNNEL_NONCES: { nonce: string; at: number }[] = []

/** nonce 是否已用过（副作用：登记新 nonce + 清窗口外）。与 Rust `nonce_is_replay` 同口径。 */
export function tunnelNonceIsReplay(nonce: string, now: number): boolean {
  for (let i = SEEN_TUNNEL_NONCES.length - 1; i >= 0; i--) {
    if (now - SEEN_TUNNEL_NONCES[i].at >= NONCE_WINDOW_MS) SEEN_TUNNEL_NONCES.splice(i, 1)
  }
  if (SEEN_TUNNEL_NONCES.some((x) => x.nonce === nonce)) return true
  SEEN_TUNNEL_NONCES.push({ nonce, at: now })
  return false
}

/** 测试复位。 */
export function clearTunnelNoncesForTest(): void {
  SEEN_TUNNEL_NONCES.length = 0
}

// ── WS 服务端帧编解码（客户端帧必掩码、服务端帧必不掩码——RFC 6455 §5.1） ──

/** 服务端读到的单帧。 */
interface WsFrame {
  fin: boolean
  opcode: number
  payload: Uint8Array
}

/**
 * WS **服务端**编解码器：喂数据块 → 吐完整二进制消息；发消息 → 不掩码帧。
 * 处理：分片重组、close（回显）、ping→pong（经 [`takeControlWrites`] 取走写出）、
 * pong/未知 opcode 忽略。**客户端帧不带掩码 = 协议错**（按关闭处理，不勉强解）。
 */
export class WsServerCodec {
  private buf: Uint8Array = new Uint8Array(0)
  private frag: Uint8Array | null = null
  private ctrl: Uint8Array[] = []
  /** 收到 close 帧（或协议错）后为 true——调用方应停读。 */
  closed = false
  closeCode: number | null = null

  /** 喂一块 TCP 字节，返回其中完整的二进制消息载荷（0..n 条）。 */
  push(chunk: Uint8Array): Uint8Array[] {
    this.buf = concatBytes(this.buf, chunk)
    const out: Uint8Array[] = []
    while (!this.closed) {
      const f = this.tryReadFrame()
      if (!f) break
      if (f.opcode === 0x2) {
        // 二进制（隧道帧）：不分片直接吐；分片则攒
        this.frag = null
        if (f.fin) out.push(f.payload)
        else this.frag = f.payload
      } else if (f.opcode === 0x0) {
        if (this.frag !== null) {
          this.frag = concatBytes(this.frag, f.payload)
          if (f.fin) {
            out.push(this.frag)
            this.frag = null
          }
        }
      } else if (f.opcode === 0x8) {
        this.closed = true
        this.closeCode = f.payload.length >= 2 ? ((f.payload[0] << 8) | f.payload[1]) : 1005
        // 回显 close（RFC 6455 §5.5.1）
        this.ctrl.push(this.frame(0x8, f.payload.subarray(0, Math.min(2, f.payload.length))))
      } else if (f.opcode === 0x9) {
        this.ctrl.push(this.frame(0xa, f.payload))
      }
      // 0xa pong / 0x1 text：忽略（本协议只有二进制帧）
    }
    return out
  }

  /** 取走要写回对端的控制帧（pong / close 回显）。 */
  takeControlWrites(): Uint8Array[] {
    const w = this.ctrl
    this.ctrl = []
    return w
  }

  /** 包一个服务端帧（**不掩码**）。 */
  frame(opcode: number, payload: Uint8Array): Uint8Array {
    let h: Uint8Array
    if (payload.length < 126) {
      h = new Uint8Array(2)
      h[1] = payload.length
    } else if (payload.length < 65536) {
      h = new Uint8Array(4)
      h[1] = 126
      new DataView(h.buffer).setUint16(2, payload.length, false)
    } else {
      h = new Uint8Array(10)
      h[1] = 127
      new DataView(h.buffer).setBigUint64(2, BigInt(payload.length), false)
    }
    h[0] = 0x80 | opcode
    return concatBytes(h, payload)
  }

  /** 二进制消息帧便捷封装。 */
  binaryFrame(payload: Uint8Array): Uint8Array {
    return this.frame(0x2, payload)
  }

  /** 尝试从缓冲解一帧；不够 → null。 */
  private tryReadFrame(): WsFrame | null {
    const b = this.buf
    if (b.length < 2) return null
    const fin = (b[0] & 0x80) !== 0
    const opcode = b[0] & 0x0f
    const masked = (b[1] & 0x80) !== 0
    let len = b[1] & 0x7f
    let off = 2
    if (len === 126) {
      if (b.length < off + 2) return null
      len = (b[off] << 8) | b[off + 1]
      off += 2
    } else if (len === 127) {
      if (b.length < off + 8) return null
      let l = 0n
      for (let i = 0; i < 8; i++) l = (l << 8n) | BigInt(b[off + i])
      off += 8
      len = Number(l)
    }
    if (!masked || len > 4 * 1024 * 1024) {
      // 客户端帧必须掩码（RFC 6455 §5.1）；超长帧直接判协议错
      this.closed = true
      this.closeCode = 1002
      return null
    }
    if (b.length < off + 4 + len) return null
    const mask = b.subarray(off, off + 4)
    const payload = new Uint8Array(len)
    for (let i = 0; i < len; i++) payload[i] = b[off + 4 + i] ^ mask[i & 3]
    this.buf = b.slice(off + 4 + len)
    return { fin, opcode, payload }
  }
}

// ── 服务端角色入口 ──

/** 一条裸 TCP 连接（原生桥暴露的形态：字节进、字节出）。 */
export interface RawTunnelConn {
  onChunk(cb: (d: Uint8Array) => void): () => void
  onClosed(cb: () => void): () => void
  write(d: Uint8Array): void
  close(): void
}

/** 接受一条反向隧道的选项。 */
export interface AcceptTunnelOptions {
  /** 预期发起方（分享卡的 sourceDevice）——did_equiv 公钥级判等，最硬的闸。 */
  expectDevice: string
  /** 2026-10-22 入向 vnet：同账号设备请求**普通端口**（22/3389/5555/9000）时放行。 */
  vnetAccount?: string
  /**
   * 2026-10-23 V21：入向 vnet 端口的**开放集合**（惰性求值——每次闸门现读，配置
   * 运行时可改）。缺省 = 静态白名单内的非协议端口全开（旧行为兼容）；手机装配处
   * 传 `vnet-inbound.effectiveInboundPorts`（默认只开 5555）。协议端口
   * （9100/13911）不受它管辖。
   */
  vnetPorts?: () => readonly number[]
  /**
   * 2026-10-23 V21：同账号放行前的**名册归属校验**（对齐 PC 侧
   * `p2p_server::device_belongs_to_account`，fail-closed）。签名证明的是设备身份，
   * "account 字段==本机账号"只是对端 claim——这里补"签名设备公钥 ∈ 该账号名册"。
   * 缺省 = 不校验（仅信封 claim，旧行为兼容；测试/无网环境用）。
   */
  verifyVnetPeer?: (peer: { account: string; device: string }) => Promise<boolean>
  /** 信封 port 白名单（默认 `TUNNEL_DEFAULT_PORTS`）。 */
  allowedPorts?: readonly number[]
  now?: () => number
  /** 握手总超时（默认 8s）。 */
  timeoutMs?: number
}

/** 一条已接受的反向隧道（responder 侧会话）。 */
export interface ReverseTunnelSession {
  /** responder 角色的帧编解码器（发起方用 c2s 发、我们用 s2c 发）。 */
  io: FrameIo
  handshakeRaw: string
  peer: { account: string; device: string; port: number }
  /** 发一段明文（内部 seal + WS 帧 + 写连接）。 */
  send(pt: Uint8Array): void
  onMessage(cb: (pt: Uint8Array) => void): () => void
  onClose(cb: () => void): () => void
  close(): void
}

/** 接受失败（闸门拒绝/协议错）——`httpStatus` 是已写回对端的响应码。 */
export class TunnelAcceptError extends Error {
  readonly httpStatus: number
  readonly code: string
  constructor(httpStatus: number, code: string, message: string) {
    super(message)
    this.name = 'TunnelAcceptError'
    this.httpStatus = httpStatus
    this.code = code
  }
}

/** 拒绝并关连接（写人话 JSON 响应 → 返回可抛的错）。 */
function rejectConn(conn: RawTunnelConn, status: number, code: string, message: string): TunnelAcceptError {
  const reason = status === 400 ? 'Bad Request' : 'Forbidden'
  try {
    conn.write(buildTunnelHttpResponse(status, reason, message))
  } catch {
    /* 已断 */
  }
  try {
    conn.close()
  } catch {
    /* 已断 */
  }
  return new TunnelAcceptError(status, code, message)
}

/**
 * **服务端角色**：在一条入站裸 TCP 连接上接受反向隧道。
 *
 * 流程：攒完整请求头 → ⑥ 道闸（见块注释）→ 回 `101` → WS 服务端帧层 →
 * v2 加密握手（responder：收 HELLO → 回 HELLO_ACK → 发 CONFIRM → 收 CONFIRM）→
 * 会话对象（明文收发）。任一闸失败：写人话 HTTP 错误 + 关连接 + 抛
 * [`TunnelAcceptError`]（**不静默降级**）。
 */
/**
 * 2026-10-22 入向 vnet 隧道：把一条**已接受**的隧道会话接到 `127.0.0.1:<port>`。
 *
 * 拓扑：PC `vnet forward {手机, 5555}` → 中继/直连 → 手机原生监听 → `acceptTunnel`
 * （服务端角色，已验签+端口白名单+同账号闸）→ 本函数。JS 不能开 TCP，所以本地
 * 拨号走原生 `MycoShell.tcpDial`，读侧数据经 `window.__mycoTcpData` 回灌会话。
 */
export function serveVnetTcpSession(
  session: ReverseTunnelSession,
  port: number,
  log: (l: string) => void,
): void {
  const sh = (window as unknown as { MycoShell?: Record<string, unknown> }).MycoShell as
    | { tcpDial?: (p: number) => string; tcpSend?: (id: number, b: string) => void; tcpClose?: (id: number) => void }
    | undefined
  if (!sh?.tcpDial || !sh?.tcpSend || !sh?.tcpClose) {
    log(`[vnet-in] 壳不支持 tcpDial（旧 APK），关闭 port=${port}`)
    session.close()
    return
  }
  let raw = ''
  try {
    raw = sh.tcpDial(port)
  } catch (e) {
    raw = String(e)
  }
  let parsed: { ok?: boolean; connId?: number; err?: string } | null = null
  try {
    parsed = JSON.parse(raw) as { ok?: boolean; connId?: number; err?: string }
  } catch {
    parsed = null
  }
  if (!parsed?.ok || typeof parsed.connId !== 'number') {
    log(`[vnet-in] 拨 127.0.0.1:${port} 失败：${raw.slice(0, 120)}`)
    session.close()
    return
  }
  const id = parsed.connId
  const w = window as unknown as Record<string, unknown>
  const prevData = w.__mycoTcpData
  const prevClosed = w.__mycoTcpClosed
  w.__mycoTcpData = (cid: number, b64: string): void => {
    if (cid === id) {
      try {
        session.send(fromB64(b64))
      } catch {
        /* 会话已关 */
      }
      return
    }
    if (typeof prevData === 'function') (prevData as (a: number, b: string) => void)(cid, b64)
  }
  w.__mycoTcpClosed = (cid: number): void => {
    if (cid === id) {
      session.close()
      return
    }
    if (typeof prevClosed === 'function') (prevClosed as (a: number) => void)(cid)
  }
  session.onMessage((pt: Uint8Array) => {
    try {
      sh.tcpSend!(id, toB64(pt))
    } catch {
      /* 已关 */
    }
  })
  session.onClose(() => {
    try {
      sh.tcpClose!(id)
    } catch {
      /* ignore */
    }
    w.__mycoTcpData = prevData
    w.__mycoTcpClosed = prevClosed
  })
  log(`[vnet-in] port=${port} 已接到 127.0.0.1:${port}（connId=${id}）`)
}

export async function acceptTunnel(conn: RawTunnelConn, opts: AcceptTunnelOptions): Promise<ReverseTunnelSession> {
  const now = opts.now ?? Date.now
  const deadline = now() + (opts.timeoutMs ?? 8000)
  const allowed = opts.allowedPorts ?? TUNNEL_DEFAULT_PORTS

  // ① 攒完整请求头（`\r\n\r\n`）
  let headBuf: Uint8Array | null = null
  {
    let acc: Uint8Array = new Uint8Array(0)
    let gotHead = false
    let closed = false
    const offClose = conn.onClosed(() => {
      closed = true
    })
    const offChunk = conn.onChunk((d) => {
      acc = concatBytes(acc, d)
      if (acc.includes(13) && new TextDecoder('latin1').decode(acc).includes('\r\n\r\n')) gotHead = true
    })
    try {
      while (!gotHead && !closed && now() < deadline) {
        await new Promise<void>((res) => setTimeout(res, 20))
      }
    } finally {
      offChunk()
      offClose()
    }
    if (closed) throw new TunnelAcceptError(400, 'conn-closed', '连接在握手前断开')
    if (!gotHead) throw rejectConn(conn, 400, 'bad-handshake', '握手请求不完整')
    headBuf = acc
  }

  const req = parseUpgradeRequest(headBuf)
  if (!req || req.method !== 'GET') {
    throw rejectConn(conn, 400, 'bad-handshake', '隧道握手体无效或协议版本不符')
  }
  // 头部之后可能已经跟着到了字节（快的发起方会紧接着发 WS 帧）——留给帧层
  const carry = headBuf.subarray(req.headLen)
  if (!tunnelPathVersionOk(req.path)) {
    throw rejectConn(
      conn,
      400,
      'bad-handshake',
      `协议版本不符（本机 v${TUNNEL_PROTOCOL_VERSION}：老版本请升级 myco）`,
    )
  }

  // ② 信封
  const raw = req.headers[TUNNEL_HANDSHAKE_HEADER]
  if (!raw) throw rejectConn(conn, 400, 'bad-handshake', '缺少隧道握手信封')
  let env: { v: number; port: number; account: string; device: string; origin: string; nonce: string }
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    env = {
      v: Number(o.v),
      port: Number(o.port),
      account: String(o.account ?? ''),
      device: String(o.device ?? ''),
      origin: String(o.origin ?? ''),
      nonce: String(o.nonce ?? ''),
    }
  } catch {
    throw rejectConn(conn, 400, 'bad-handshake', '隧道握手信封不是合法 JSON')
  }
  if (env.v !== TUNNEL_PROTOCOL_VERSION || !env.nonce || !env.origin || !env.account || !env.device) {
    throw rejectConn(conn, 400, 'bad-handshake', '隧道握手信封字段不全')
  }
  if (!allowed.includes(env.port)) {
    throw rejectConn(conn, 403, 'port-not-allowed', `端口不在隧道白名单（允许 ${allowed.join(', ')}）`)
  }
  // 2026-10-23 V21：入向 vnet 端口还要过**用户开放集合**（默认只开 5555；
  // myco.inboundPorts 可配）。静态白名单是协议层上界，这里是产品层策略。
  const isVnetPort = env.port !== DEFAULT_P2P_PORT && env.port !== DEFAULT_GW_PORT
  if (isVnetPort && opts.vnetPorts && !opts.vnetPorts().includes(env.port)) {
    throw rejectConn(conn, 403, 'port-not-open', `端口 ${env.port} 未开放（对方可在手机 myco 里开启）`)
  }

  // ③ 验签
  const authParts = parseTunnelAuthHeader(req.headers[TUNNEL_AUTH_HEADER] ?? '')
  const signer = authParts ? verifyTunnelAuth(authParts, raw, now()) : null
  if (!signer) throw rejectConn(conn, 403, 'bad-signature', 'auth failed（设备签名无效）')

  // ④ 签名者 = device = origin
  if (!didEquiv(signer, env.device) || !didEquiv(signer, env.origin)) {
    throw rejectConn(conn, 403, 'device-mismatch', 'device 与签名者不一致')
  }

  // ⑤ 发起方 = 预期源设备（本会话分享卡的 sourceDevice）。
  // 2026-10-22 入向 vnet：**普通端口**（非 9100/13911）且**同账号**的已签名设备放行
  // （设备签名/账号字段都在上面①-④验过；这里只是把"仅分享源设备"放宽到"我的设备"）。
  const sameAccount = !!opts.vnetAccount && didEquiv(env.account, opts.vnetAccount)
  if (!didEquiv(env.device, opts.expectDevice) && !(isVnetPort && sameAccount)) {
    const err = rejectConn(conn, 403, 'not-expected-device', '发起方不是本次分享的源设备')
    // 带上对方是谁（排障：多设备同账号都在拨时，得知道拒的是哪台）
    ;(err as TunnelAcceptError & { env?: typeof env }).env = env
    throw err
  }
  // 2026-10-23 V21：同账号 claim 升级为**名册级归属校验**。中继 relay.mjs 不做
  // 任何账号门槛（"REGISTER/CONNECT 不带签名，did 仅作路由键"），签名闸在这里；
  // 而"account==本机账号"只是对端信封里的声明——陌生人可用自己的设备钥签名 +
  // 声称我的账号过掉上面的同账号分支。这里要求签名设备公钥 ∈ 该账号名册
  // （对齐 PC 侧 device_belongs_to_account：本机设备/委任状/云名册三通道，手机
  // 侧走云名册 GET /root/<account>，fail-closed）。
  if (isVnetPort && sameAccount && opts.verifyVnetPeer) {
    const owned = await opts.verifyVnetPeer({ account: env.account, device: env.device })
    if (!owned) {
      throw rejectConn(conn, 403, 'ownership', '签名设备不属于声称的账号')
    }
  }

  // ⑥ nonce 去重
  if (tunnelNonceIsReplay(env.nonce, now())) {
    throw rejectConn(conn, 403, 'replay', '握手 nonce 重复（重放）')
  }

  // ⑦ 101 升级（accept key 按 RFC 6455 算——客户端接下来全部走 WS 帧）
  conn.write(buildUpgradeResponse(req.headers))

  // ⑧ WS 帧层 + v2 加密握手（responder）
  const codec = new WsServerCodec()
  const inbox: Uint8Array[] = []
  if (carry.length > 0) {
    // 头部先行到达的帧字节：直接喂给帧层（可能已含完整 HELLO）
    for (const m of codec.push(carry)) inbox.push(m)
  }
  let wake: (() => void) | null = null
  let connClosed = false
  const msgCbs: ((pt: Uint8Array) => void)[] = []
  const closeCbs: (() => void)[] = []
  const offChunk = conn.onChunk((d) => {
    const msgs = codec.push(d)
    for (const m of msgs) inbox.push(m)
    for (const w of codec.takeControlWrites()) {
      try {
        conn.write(w)
      } catch {
        /* 已断 */
      }
    }
    if (msgs.length > 0 && wake) {
      const w = wake
      wake = null
      w()
    }
  })
  const offClosed = conn.onClosed(() => {
    connClosed = true
    if (wake) {
      const w = wake
      wake = null
      w()
    }
    for (const cb of [...closeCbs]) {
      try {
        cb()
      } catch {
        /* 单个回调不能拖垮整条 */
      }
    }
  })
  const nextMessage = async (): Promise<Uint8Array> => {
    while (inbox.length === 0 && !connClosed && !codec.closed && now() < deadline) {
      await new Promise<void>((res) => {
        wake = res
        setTimeout(res, 20)
      })
      wake = null
    }
    const m = inbox.shift()
    if (!m) throw new TunnelAcceptError(400, 'handshake-timeout', '加密握手未完成（超时或连接断开）')
    return m
  }
  const writeFrame = (f: Uint8Array): void => {
    try {
      conn.write(f)
    } catch {
      /* 已断：后续读会感知 */
    }
  }

  try {
    const ctClient = parseHello(await nextMessage())
    const eph = genEphemeral()
    writeFrame(codec.binaryFrame(helloFrame(eph.pub)))
    const io = new FrameIo(deriveWithEcdh(eph.priv, ctClient, ctClient, eph.pub, raw), 'responder', raw)
    writeFrame(codec.binaryFrame(io.confirmFrame()))
    io.acceptConfirm(await nextMessage())
    // 握手完成 → 会话（读循环转交给会话回调）
    const session: ReverseTunnelSession = {
      io,
      handshakeRaw: raw,
      peer: { account: env.account, device: env.device, port: env.port },
      send: (pt) => {
        for (let i = 0; i < pt.length; i += TUNNEL_CHUNK) {
          writeFrame(codec.binaryFrame(io.seal(pt.subarray(i, i + TUNNEL_CHUNK))))
        }
      },
      onMessage: (cb) => {
        msgCbs.push(cb)
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
      close: () => {
        try {
          writeFrame(codec.frame(0x8, new Uint8Array([0x03, 0xe8])))
        } catch {
          /* ignore */
        }
        try {
          conn.close()
        } catch {
          /* ignore */
        }
      },
    }
    // 会话期读循环：解密 → 分发（协议错 = 关连接，对齐 PC 端语义）
    const pump = (): void => {
      const run = (): void => {
        while (inbox.length > 0) {
          const m = inbox.shift()!
          let pt: Uint8Array
          try {
            pt = io.open(m)
          } catch (e) {
            session.close()
            return
          }
          for (const cb of [...msgCbs]) {
            try {
              cb(pt)
            } catch {
              /* 单个回调不能拖垮整条 */
            }
          }
        }
      }
      run()
      // 后续到达由 onChunk 直接分发
      offChunk()
      conn.onChunk((d) => {
        const msgs = codec.push(d)
        for (const w of codec.takeControlWrites()) writeFrame(w)
        for (const m of msgs) {
          let pt: Uint8Array
          try {
            pt = io.open(m)
          } catch {
            session.close()
            return
          }
          for (const cb of [...msgCbs]) {
            try {
              cb(pt)
            } catch {
              /* ignore */
            }
          }
        }
        if (codec.closed) session.close()
      })
    }
    pump()
    void offClosed // offClosed 保持挂着：连接断开 → closeCbs 全体触发
    return session
  } catch (e) {
    offChunk()
    offClosed()
    try {
      conn.close()
    } catch {
      /* ignore */
    }
    throw e
  }
}

// ── 连接决策（打开分享时走哪条路） ──

/** 决策输入（由调用方从寻址/探测结果装配）。 */
export interface RouteFacts {
  /** B 和 A 同网段（LAN 直连成立）。 */
  sameSubnet: boolean
  /** A 的地址可达（A 有公网/放行入站 → B 直连 A）。 */
  sourceReachable: boolean
  /** B 的地址可达（B 是手机、移动网络放行入站 → A 反向连 B）。 */
  selfInbound: boolean
}

/** 决策结果：direct（现有路径 B 连 A）| reverse（新路径 A 连 B）| none（人话错误）。 */
export type RouteDecision =
  | { mode: 'direct'; why: string }
  | { mode: 'reverse'; why: string }
  | { mode: 'none'; message: string }

/**
 * 打开分享时的连接决策（纯函数，单测直击）：
 * LAN 直连 → B 直连 A → A 反向连 B → 都不通（人话）。
 */
export function decideTunnelRoute(f: RouteFacts, targetName = '对方设备'): RouteDecision {
  if (f.sameSubnet) return { mode: 'direct', why: '同一网段：局域网直连' }
  if (f.sourceReachable) return { mode: 'direct', why: '对方地址可达：直连' }
  if (f.selfInbound) {
    return { mode: 'reverse', why: "对方直连不上，但本机地址可被对方连上：反向连接（请对方连过来）" }
  }
  return {
    mode: 'none',
    message: `连不上 ${targetName}，本机也没有对方能连入的地址。通常是两台设备都在受限网络里——可以让对方电脑检查网络，或把两台设备放到同一个网络再试。`,
  }
}

// ── 反向桥（原生 tap ↔ TunnelProxy 之间的嗅探/池/胶合层） ──

/** 原生桥的最小面（`NativeProxyBridge` 结构兼容；测试可替换）。 */
export interface NativeTapLike {
  onConn(cb: (id: number) => void): unknown
  onData(cb: (id: number, d: Uint8Array) => void): unknown
  onClose(cb: (id: number) => void): unknown
  write(id: number, d: Uint8Array): void
  close(id: number): void
}

/** 反向桥选项。 */
export interface ReverseBridgeOpts {
  tap: NativeTapLike
  expectDevice: string
  /** 2026-10-22 入向 vnet：本机账号 DID（同账号设备可请求普通端口）。 */
  vnetAccount?: string
  /** 2026-10-23 V21：入向 vnet 端口开放集合（惰性求值；缺省=白名单内非协议端口全开）。 */
  vnetPorts?: () => readonly number[]
  /** 2026-10-23 V21：同账号放行的名册归属校验（fail-closed；缺省=仅信封 claim）。 */
  verifyVnetPeer?: (peer: { account: string; device: string }) => Promise<boolean>
  /**
   * 浏览器连接等反向隧道的时限（默认 **15s**；超时关连接让页面自重试）。
   * 必须长过 PC 拨号循环的最坏一拍：PC 侧 want-marker 轮询 1s 一拍
   * （p2p_tunnel.rs REVERSE_TICK，2026-10-10 起）+ 一场拨号预算 3.5s——8s 的
   * 旧默认值会让扣着的连接在池空窗口**等不到下一拍**就被掐断，页面在"扣住→
   * 超时→重试→又扣住"里饿死（真机"反向路径页面永远白屏"的时序根因）。
   */
  holdMs?: number
  /** 反向隧道池上限（默认 4；超出即关——PC 侧重拨由 want-marker 驱动）。
   * 与 PC 侧 REVERSE_POOL_DEPTH=4 对齐（2026-10-10）：PC 池深大于此值时每拍
   * 都有多余拨号被关（churn），对齐后稳态零空拨。 */
  poolCap?: number
  /** 首行嗅探的兜底时限（默认 1500ms；没等到请求行的按浏览器连接转直连）。 */
  sniffMs?: number
  /**
   * 空转胶合连接的回收阈值（默认 60s 无任何方向活动即收）。
   * 为什么必须收（真机"反向路径页面永远白屏"的池死锁根因）：PC 反向池有
   * 硬上限（REVERSE_POOL_DEPTH=4 条活隧道，与 poolCap 对齐），胶合中的浏览器
   * keep-alive 连接**占着隧道不放**——它们空转时，新连接（DSH SPA 的 mux WS、
   * 后续资产）永远等不到空隧道：扣住→超时→重试的死循环。收掉空转胶合 =
   * 释放 PC 槽位 → 下一拍拨号补池 → 新连接有隧道可用。
   * HTTP 语义安全：服务端随时可关 keep-alive 连接，浏览器透明重连。
   */
  idleGluedMs?: number
  /** 空转回收的扫描周期（默认 15s）。 */
  sweepMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  onLog?: (line: string) => void
  /**
   * 浏览器连接扣住超时（holdMs 内没等到 PC 拨来的反向隧道）时的回调
   * （2026-10-10 断线自愈加固）。典型语义：PC 一直在拨**旧地址**（手机 IPv6
   * 前缀已轮换、presence 还挂着过期快照）——上层借这个信号**立即重报最新
   * addrs**，PC 下一次 1s 轮询就能拿到新地址。WebView 后台节流会拖慢周期性
   * 刷新，这个在带事件（native 回调路径）是节流期兜底的恢复信号。
   * 回调内部自行节流；抛错忽略。
   */
  onHoldTimeout?: () => void
}

/** 嗅探缓冲上限（首行/头部都在这以内；超了关连接防滥用）。 */
const SNIFF_CAP = 16 * 1024

/** 把 tap 上的一条连接适配成 [`RawTunnelConn`]（先到的块排队，订阅后补投）。 */
class TapConnAdapter implements RawTunnelConn {
  private chunkCbs: ((d: Uint8Array) => void)[] = []
  private closedCbs: (() => void)[] = []
  private pending: Uint8Array[] = []
  private closed = false

  constructor(private readonly sink: { write(d: Uint8Array): void; close(): void }) {}

  deliver(d: Uint8Array): void {
    if (this.closed) return
    if (this.chunkCbs.length > 0) {
      for (const cb of [...this.chunkCbs]) cb(d)
    } else {
      this.pending.push(d)
    }
  }

  markClosed(): void {
    if (this.closed) return
    this.closed = true
    this.pending = []
    for (const cb of [...this.closedCbs]) {
      try {
        cb()
      } catch {
        /* ignore */
      }
    }
  }

  onChunk(cb: (d: Uint8Array) => void): () => void {
    this.chunkCbs.push(cb)
    if (this.pending.length > 0) {
      const q = this.pending
      this.pending = []
      for (const d of q) cb(d)
    }
    return () => {
      const i = this.chunkCbs.indexOf(cb)
      if (i >= 0) this.chunkCbs.splice(i, 1)
    }
  }

  onClosed(cb: () => void): () => void {
    this.closedCbs.push(cb)
    return () => {
      const i = this.closedCbs.indexOf(cb)
      if (i >= 0) this.closedCbs.splice(i, 1)
    }
  }

  write(d: Uint8Array): void {
    if (this.closed) return
    this.sink.write(d)
  }

  close(): void {
    this.sink.close()
  }
}

interface BridgeConnRec {
  phase: 'sniff' | 'direct' | 'accepting' | 'held' | 'glued'
  buf: Uint8Array[]
  adapter?: TapConnAdapter
  tunnel?: ReverseTunnelSession
  holdTimer?: unknown
  sniffTimer?: unknown
  /** 胶合连接的最近活动时间（空转回收的判定依据；仅 glued 相使用）。 */
  lastAct?: number
  /**
   * 反向入站连接的握手已完成、隧道在池（phase 仍是 'accepting'——入站字节
   * 必须继续走 adapter→codec 的数据通路，记录**不能**删；诊断快照据此把
   * "健康在池"与"握手在途"区分开）。
   */
  pooled?: boolean
}

/**
 * **反向桥**：装在原生 tap 与 `TunnelProxy` 之间（`TunnelProxy` 的 bridge 换成本类）。
 *
 * 职责：
 *   · **首行嗅探**：`GET /p2p/tunnel` → 反向隧道入站（走 [`acceptTunnel`] 服务端角色，
 *     过闸后进池或直接胶合等待中的浏览器连接）；其它（浏览器的 `GET /gw/…` 等）→
 *     浏览器连接——按 [`mode`] 决定交给 `TunnelProxy`（auto=直连照旧）还是扣住等
 *     反向隧道（reverse）；
 *   · **池 + 胶合**：PC 拨来的每条隧道是一个"已验证的 responder 会话"；浏览器连接
 *     与隧道一一胶合（互为字节管道，任一侧断开两侧同关）。
 *
 * mode 翻转由上层驱动（`TunnelProxy` 状态 degraded → `setMode('reverse')`）：
 * 直连死、反向通的场景，浏览器下一次重连就走反向。
 */
export class ReverseShareBridge {
  mode: 'auto' | 'reverse' = 'auto'
  readonly stats = { pooled: 0, glued: 0, rejected: 0, held: 0, upFrames: 0, downFrames: 0 }

  /** 拒绝日志限速（发起方 did → 上次落日志时刻；2026-10-12 防刷屏滚动掉诊断轨迹）。 */
  private readonly rejectLogAt = new Map<string, number>()
  /** 最近一次任一方向的泵活动（毫秒时间戳；诊断"隧道还搬不搬砖"用）。 */
  lastActivityAt = 0
  private readonly conns = new Map<number, BridgeConnRec>()
  private readonly pool: ReverseTunnelSession[] = []
  private readonly poolCap: number
  private readonly holdMs: number
  private readonly sniffMs: number
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (h: unknown) => void
  private readonly log: (line: string) => void
  private readonly tap: NativeTapLike
  /** 预期源设备（构造时给定）。 */
  readonly expectDeviceRef: string
  /** 2026-10-22 入向 vnet：本机账号 DID（同账号设备的普通端口请求放行）。 */
  readonly vnetAccountRef?: string
  /** 2026-10-23 V21：入向端口开放集合（惰性求值）。 */
  readonly vnetPortsRef?: () => readonly number[]
  /** 2026-10-23 V21：同账号放行的名册归属校验。 */
  readonly verifyVnetPeerRef?: (peer: { account: string; device: string }) => Promise<boolean>
  /** 扣住超时回调（节流归上层；此处只投递事件）。 */
  private readonly onHoldTimeout: () => void
  private tpConn: ((id: number) => void) | null = null
  private tpData: ((id: number, d: Uint8Array) => void) | null = null
  private tpClose: ((id: number) => void) | null = null
  private wired = false
  private sweepTimer: unknown = null
  private readonly idleGluedMs: number
  private readonly sweepMs: number

  constructor(opts: ReverseBridgeOpts) {
    this.tap = opts.tap
    this.expectDeviceRef = opts.expectDevice
    this.vnetAccountRef = opts.vnetAccount
    this.vnetPortsRef = opts.vnetPorts
    this.verifyVnetPeerRef = opts.verifyVnetPeer
    this.poolCap = opts.poolCap ?? 4
    this.holdMs = opts.holdMs ?? 15000
    this.sniffMs = opts.sniffMs ?? 1500
    this.idleGluedMs = opts.idleGluedMs ?? 60_000
    this.sweepMs = opts.sweepMs ?? 15_000
    this.now = opts.now ?? (() => Date.now())
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.log = opts.onLog ?? ((): void => {})
    this.onHoldTimeout = opts.onHoldTimeout ?? ((): void => {})
  }

  /** 接线（一次）：订阅原生 tap 的三类回调 + 启动空转胶合回收。 */
  wire(): void {
    if (this.wired) return
    this.wired = true
    this.tap.onConn((id) => this.onNativeConn(id))
    this.tap.onData((id, d) => this.onNativeData(id, d))
    this.tap.onClose((id) => this.onNativeClose(id))
    this.ensureSweeper()
  }

  /** 切换模式（幂等；切到 reverse 时立刻尝试用池里的隧道满足扣着的浏览器连接）。 */
  setMode(m: 'auto' | 'reverse'): void {
    // stop() 会停掉回收器；每次开卡/翻模式都重新武装（幂等）
    this.ensureSweeper()
    if (this.mode === m) return
    this.mode = m
    this.log(`[reverse-bridge] mode=${m}`)
    if (m === 'reverse') this.tryServeHeld()
  }

  /** 诊断快照。 */
  snapshot(): string {
    const ph = (n: string): number => [...this.conns.values()].filter((r) => r.phase === n && !r.pooled).length
    const idleSec = this.lastActivityAt > 0 ? Math.max(0, Math.round((this.now() - this.lastActivityAt) / 1000)) : -1
    // tp=TunnelProxy 是否接管（0=桥在"单干"：取票阶段/开卡失败后——此场景浏览器
    // 连接只能靠反向池；诊断"wss=0 却有入站连接"时先看这个位）
    return `mode=${this.mode} tp=${this.tpConn !== null ? 1 : 0} pool=${this.pool.length}/${this.poolCap} sniff=${ph('sniff')} direct=${ph('direct')} accepting=${ph('accepting')} held=${ph('held')} glued=${ph('glued')} stats=${JSON.stringify(this.stats)} idleSec=${idleSec}`
  }

  // ── ProxyBridge 面（给 TunnelProxy 用；只有 direct 连接会到达这里） ──

  onConn(cb: (id: number) => void): void {
    this.tpConn = cb
  }

  onData(cb: (id: number, d: Uint8Array) => void): void {
    this.tpData = cb
  }

  onClose(cb: (id: number) => void): void {
    this.tpClose = cb
  }

  write(id: number, d: Uint8Array): void {
    this.stats.downFrames += 1
    this.lastActivityAt = this.now()
    this.tap.write(id, d)
  }

  close(id: number): void {
    this.tap.close(id)
  }

  /** 停止：关池里全部隧道 + 释放扣着的连接。 */
  stop(): void {
    if (this.sweepTimer !== null) {
      this.clearTimer(this.sweepTimer)
      this.sweepTimer = null
    }
    for (const [id, rec] of this.conns) {
      if (rec.holdTimer !== undefined) this.clearTimer(rec.holdTimer)
      if (rec.sniffTimer !== undefined) this.clearTimer(rec.sniffTimer)
      rec.adapter?.markClosed()
      rec.tunnel?.close()
      if (rec.phase !== 'direct') {
        try {
          this.tap.close(id)
        } catch {
          /* ignore */
        }
      }
    }
    this.conns.clear()
    for (const t of this.pool) {
      try {
        t.close()
      } catch {
        /* ignore */
      }
    }
    this.pool.length = 0
  }

  // ── 内部 ──

  private onNativeConn(id: number): void {
    this.conns.set(id, { phase: 'sniff', buf: [] })
    // 2026-10-10 竞态修复：嗅探定时器**不在 onConn 启动**，改为在首个 onData
    // 到达时启动（见 onNativeData 的 sniff 分支）。原因：JS 事件循环被 open
    // 流程阻塞时，onData 事件排队延迟 > sniffMs → 定时器先触发 → buf 为空
    // → 错分为浏览器连接（'held'）→ 后到的 "GET /p2p/tunnel" 数据被缓冲
    // 但永远不处理（accepting=0 / wss=0 的根因）。
    // 连接级兜底：如果 5s 内完全没数据（扫描器摸端口），关连接。
    this.conns.get(id)!.sniffTimer = this.setTimer(() => {
      const rec = this.conns.get(id)
      if (!rec || rec.phase !== 'sniff') return
      this.tap.close(id)
    }, Math.max(this.sniffMs, 5000))
  }

  private onNativeData(id: number, d: Uint8Array): void {
    const rec = this.conns.get(id)
    if (!rec) return
    switch (rec.phase) {
      case 'direct':
        this.stats.upFrames += 1
        this.lastActivityAt = this.now()
        this.tpData?.(id, d)
        return
      case 'accepting':
        rec.adapter?.deliver(d)
        return
      case 'glued':
        this.stats.upFrames += 1
        this.lastActivityAt = this.now()
        rec.lastAct = this.now()
        this.tunnelSend(rec.tunnel!, d)
        return
      case 'held':
        this.stats.upFrames += 1
        this.lastActivityAt = this.now()
        rec.buf.push(d)
        return
      case 'sniff': {
        rec.buf.push(d)
        const acc = concatChunks(rec.buf)
        const line = firstLine(acc)
        if (line === null) {
          if (acc.length > SNIFF_CAP) this.tap.close(id)
          return
        }
        if (rec.sniffTimer !== undefined) {
          this.clearTimer(rec.sniffTimer)
          rec.sniffTimer = undefined
        }
        if (line.startsWith('GET /p2p/tunnel')) {
          // 反向隧道入站：整条连接交给服务端角色
          rec.phase = 'accepting'
          const adapter = new TapConnAdapter({ write: (w) => this.tap.write(id, w), close: () => this.tap.close(id) })
          rec.adapter = adapter
          adapter.deliver(acc)
          void this.runAccept(id, adapter)
        } else {
          this.classifyBrowser(id, rec, acc)
        }
        return
      }
    }
  }

  private onNativeClose(id: number): void {
    const rec = this.conns.get(id)
    if (!rec) return
    if (rec.holdTimer !== undefined) this.clearTimer(rec.holdTimer)
    if (rec.sniffTimer !== undefined) this.clearTimer(rec.sniffTimer)
    rec.adapter?.markClosed()
    rec.tunnel?.close()
    this.conns.delete(id)
    if (rec.phase === 'direct') this.tpClose?.(id)
  }

  /** 启动空转胶合回收（幂等；用自续期定时器而非 setInterval，便于注入测试时钟）。 */
  private ensureSweeper(): void {
    if (this.sweepTimer !== null) return
    const tick = (): void => {
      this.sweepTimer = null
      this.sweepIdleGlued()
      this.ensureSweeper()
    }
    this.sweepTimer = this.setTimer(tick, this.sweepMs)
  }

  /**
   * 关掉空转的胶合连接：释放被占的反向隧道（PC 槽位随之由下一拍拨号补回）。
   * 只收 `glued` 且双方向都静默超过 `idleGluedMs` 的连接——活跃的 mux WS /
   * 正在传输的连接绝不动。
   */
  private sweepIdleGlued(): void {
    const now = this.now()
    for (const [id, rec] of [...this.conns.entries()]) {
      if (rec.phase !== 'glued') continue
      const last = rec.lastAct ?? 0
      if (last > 0 && now - last < this.idleGluedMs) continue
      this.log(`[reverse-bridge] 胶合连接 #${id} 空转 ${Math.round((now - last) / 1000)}s——回收隧道槽位`)
      try {
        this.tap.close(id)
      } catch {
        /* ignore */
      }
      // onNativeClose 收尾：rec + rec.tunnel（PC 槽位随之释放）
    }
  }

  /**
   * 浏览器连接分类：auto 且 **TunnelProxy 已接管**（tpConn 已接线）→ 直连照旧；
   * 其余——reverse 模式，或 auto 模式下 TunnelProxy **还没接管**（开卡取票阶段 /
   * 开卡失败后旧页面还开着）→ 走反向池（有池胶合，没池扣住等）。
   *
   * 为什么要兜 tpConn=null（2026-10-10 真机"PC 连过来却 0 字节响应"根因）：
   * 取票的 provider C 是 `fetch http://127.0.0.1:<port>/p2p/msg`，它发生在
   * TunnelProxy 创建**之前**（dsh-open.ts 步骤③早于步骤④）——原实现无条件
   * `this.tpConn?.(id)` 把连接交给一个 null，**没人消费这条连接**（黑洞：
   * 池里隧道干看着、fetch 挂到超时 0 字节）。此场景桥能提供服务的唯一路径
   * 就是反向池，所以 auto 的直连分支必须以"TunnelProxy 真的接管了"为前提。
   */
  private classifyBrowser(id: number, rec: BridgeConnRec, acc: Uint8Array): void {
    // 首包即上行活动（后续数据在 onNativeData 的 direct/glued/held 分支计）
    this.stats.upFrames += 1
    this.lastActivityAt = this.now()
    if (this.mode === 'auto' && this.tpConn !== null) {
      rec.phase = 'direct'
      this.tpConn?.(id)
      this.tpData?.(id, acc)
      return
    }
    // reverse（或 auto 但无 TunnelProxy 接管）：有池立刻胶合，否则扣住等（超时关，让页面自重试）
    const t = this.pool.shift()
    if (t) {
      this.glue(id, rec, t, acc)
    } else {
      rec.phase = 'held'
      rec.buf = [acc]
      this.stats.held += 1
      rec.holdTimer = this.setTimer(() => {
        const r = this.conns.get(id)
        if (r && r.phase === 'held') {
          this.tap.close(id)
          // PC 整个 holdMs 都没送来隧道：大概率在对端的拨号清单里已是过期地址
          // （IPv6 前缀轮换）——通知上层立即重报最新 addrs（节流在上层）。
          try {
            this.onHoldTimeout()
          } catch {
            /* 回调不能拖垮桥 */
          }
        }
      }, this.holdMs)
    }
  }

  private async runAccept(id: number, adapter: TapConnAdapter): Promise<void> {
    try {
      const t = await acceptTunnel(adapter, {
        expectDevice: this.expectDeviceRef,
        vnetAccount: this.vnetAccountRef,
        vnetPorts: this.vnetPortsRef,
        verifyVnetPeer: this.verifyVnetPeerRef,
      })
      // 2026-10-12 分流：信封 port=9100（p2p 数据面）→ 帧内 HTTP 消费者
      // （PC 经中继/反向隧道发来的 /p2p/msg——PC→手机 聊天兜底的落地件）；
      // 13911（分享面）照旧进池/胶合。分流在进池前：两种会话的消费者不同。
      if (t.peer.port === DEFAULT_P2P_PORT) {
        this.log(`[reverse-bridge] 数据面隧道分流（peer=…${t.peer.device.slice(-4)} port=${t.peer.port}）`)
        void serveP2pDataFace(t, this.log).catch(() => { /* 已在内部兜错 */ })
        return
      }
      // 2026-10-22 入向 vnet：普通端口（22/3389/5555/9000…）→ 拨本机端口并把隧道帧泵过去
      if (t.peer.port !== DEFAULT_GW_PORT && (TUNNEL_DEFAULT_PORTS as readonly number[]).includes(t.peer.port)) {
        this.log(`[reverse-bridge] vnet 隧道分流（port=${t.peer.port} peer=…${t.peer.device.slice(-4)}）`)
        serveVnetTcpSession(t, t.peer.port, this.log)
        return
      }
      this.stats.pooled += 1
      this.log(`[reverse-bridge] 反向隧道已接受（peer=${t.peer.device} port=${t.peer.port}）`)
      t.onClose(() => {
        const i = this.pool.indexOf(t)
        if (i >= 0) this.pool.splice(i, 1)
        const rec = this.conns.get(id)
        if (rec && rec.phase === 'glued' && rec.tunnel === t) {
          this.conns.delete(id)
          this.tap.close(id)
        }
      })
      const rec = this.conns.get(id)
      if (rec && rec.phase === 'held') {
        this.glue(id, rec, t, concatChunks(rec.buf))
        rec.buf = []
      } else if (this.pool.length < this.poolCap) {
        this.pool.push(t)
        // 记录留着（'accepting' 相 = 入站字节继续走 adapter→codec 通路），
        // 只打"在池"标记——诊断快照把"健康在池"与"握手在途"区分开
        if (rec) rec.pooled = true
        this.tryServeHeld()
      } else {
        t.close()
      }
    } catch (e) {
      this.stats.rejected += 1
      // 2026-10-11：拒绝必须带**对方是谁**——真机排障时 40 连拒只写一句人话等于
      // 没写（这次就是靠它分辨"拨号的是 laptop 而非源设备"）。
      const who = e instanceof TunnelAcceptError && (e as TunnelAcceptError & { env?: { device?: string } }).env?.device
        ? String((e as TunnelAcceptError & { env?: { device?: string } }).env?.device)
        : ''
      // 2026-10-12 限速：同一发起方 5s 内只记一次——非源设备的反复拨号（排障期
      // 常态）每秒几十条，把 gw-net.log 的诊断轨迹 400KB 刷满滚动掉（实测吃过亏：
      // [dsh-open] 轨迹被冲进 .old）。计数照加，只是不再逐条落日志。
      const now = Date.now()
      const key = who || '?'
      const last = this.rejectLogAt.get(key) ?? 0
      if (now - last >= 5000) {
        this.rejectLogAt.set(key, now)
        this.log(`[reverse-bridge] 反向隧道被拒（${e instanceof Error ? e.message : String(e)}${who ? `；发起方 ${who}` : ''}；同类已静默 5s）`)
      }
      // rejectConn 已写响应并关连接；这里只清状态
      adapter.markClosed()
      this.conns.delete(id)
    }
  }

  /** 池里有隧道时，满足最早扣住的浏览器连接。 */
  private tryServeHeld(): void {
    while (this.pool.length > 0) {
      const entry = [...this.conns.entries()]
        .filter(([, r]) => r.phase === 'held')
        .sort((a, b) => a[0] - b[0])[0]
      if (!entry) return
      const [id, rec] = entry
      if (rec.holdTimer !== undefined) this.clearTimer(rec.holdTimer)
      const t = this.pool.shift()!
      this.glue(id, rec, t, concatChunks(rec.buf))
      rec.buf = []
    }
  }

  private glue(id: number, rec: BridgeConnRec, t: ReverseTunnelSession, pending: Uint8Array): void {
    rec.phase = 'glued'
    rec.tunnel = t
    rec.lastAct = this.now()
    this.stats.glued += 1
    this.log(`[reverse-bridge] 浏览器连接 #${id} ⇄ 反向隧道已胶合`)
    t.onMessage((pt) => {
      this.stats.downFrames += 1
      this.lastActivityAt = this.now()
      rec.lastAct = this.now()
      for (let i = 0; i < pt.length; i += 32 * 1024) {
        try {
          this.tap.write(id, pt.subarray(i, i + 32 * 1024))
        } catch {
          /* 已断 */
        }
      }
    })
    t.onClose(() => {
      const r = this.conns.get(id)
      if (r && r.phase === 'glued') {
        this.conns.delete(id)
        this.tap.close(id)
      }
    })
    if (pending.length > 0) this.tunnelSend(t, pending)
  }

  private tunnelSend(t: ReverseTunnelSession, d: Uint8Array): void {
    for (let i = 0; i < d.length; i += TUNNEL_CHUNK) {
      t.send(d.subarray(i, i + TUNNEL_CHUNK))
    }
  }
}

/** 拼接块。 */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let off = 0
  for (const c of chunks) {
    all.set(c, off)
    off += c.length
  }
  return all
}

/** 首行（到 `\n`；没有 → null；超过 8KB 仍无换行 → null）。 */
function firstLine(buf: Uint8Array): string | null {
  const text = new TextDecoder('latin1').decode(buf.subarray(0, 8192))
  const i = text.indexOf('\n')
  if (i < 0) return null
  return text.slice(0, i).trimEnd()
}
