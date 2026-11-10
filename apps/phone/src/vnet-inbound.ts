/**
 * vnet-inbound.ts — **手机入向 vnet 隧道**的端口策略 + 对端名册校验（2026-10-23 V21）。
 *
 * 背景：PC（或笔记本）经 myco vnet 访问手机本地端口（首要 adb 5555）。链路 =
 *   PC `/api/vnet/forward {device:手机did, port:5555}` →（直连 / 中继 CONNECT）→
 *   手机原生 TunnelProxyServer → ReverseShareBridge 嗅探 `GET /p2p/tunnel` →
 *   `acceptTunnel` 六道闸 → `serveVnetTcpSession` → `MycoShell.tcpDial(5555)`（Java
 *   TcpDialer，白名单 + 仅回环）。本模块管其中两件事：
 *
 *  ① **端口开放集合**（用户可配）：`localStorage myco.inboundPorts`（JSON 数组），
 *    默认 `[5555]`；运行时经 `window.__mycoVnet.inbound(list)` 增删（立即对后续
 *    入向隧道的闸门生效——acceptTunnel 每次求值，不缓存）。**单注册多端口**：
 *    RelayProvider 一条 REGISTER 承载整条隧道协议，目标端口在握手信封里逐连接
 *    声明——不需要"每端口一个 provider 实例"（与 frp 的 per-proxy 模型不同）。
 *
 *  ② **同账号放行的名册级校验**（安全）：中继 relay.mjs **不做任何账号/好友门槛**
 *    （"中继只搬字节：REGISTER/CONNECT 不带签名（did 仅作路由键）"，见其安全边界
 *    注释）；手机侧 acceptTunnel 验设备签名（自证设备身份）后，"同账号"原本只比
 *    信封里的 **claim**——陌生人拿自己的设备钥签名 + 声称别人的账号即可过闸。
 *    这里对齐 PC 侧 `p2p_server::device_belongs_to_account`：拉 identity 名册
 *    `GET /root/<account>`（公开读），要求**签名设备的公钥 ∈ 未吊销设备列表**
 *    （或 == rootPubkeyB64，首设备=根钥场景）。查不到/网络失败 → false
 *    （fail-closed，与 PC 同基调）。
 *
 * 纯函数（parse/effective）可单测；roster 校验带 60s 正缓存 / 15s 负缓存。
 */
import { TUNNEL_DEFAULT_PORTS, toB64 } from './p2p-tunnel'
import { didPubkeyBytes } from './didUtil'
import { DID_BASE } from './identity'

// ══════════════════ ① 端口开放集合 ══════════════════

/** localStorage 键（JSON 数组）。 */
export const INBOUND_KEY = 'myco.inboundPorts'
/** 默认只开 adb 5555（任务 V21 口径）。 */
export const DEFAULT_INBOUND_PORTS: readonly number[] = [5555]
/**
 * 协议端口：隧道信令/数据面（9100=帧内 HTTP 消息面、13911=分享网关）。
 * 不受用户配置管辖（关掉它们会打断聊天兜底/分享，与"入向端口开放"是两件事）。
 */
export const PROTOCOL_PORTS: readonly number[] = [9100, 13911]

/** 解析任意输入 → 合法端口数组（去重保序；非法项丢弃；空/坏 → 空数组）。纯函数。 */
export function parseInboundPorts(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  const out: number[] = []
  for (const v of raw) {
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isInteger(n) && n > 0 && n < 65536 && !out.includes(n)) out.push(n)
  }
  return out
}

/** 读配置（无/坏 → 默认 [5555]；空数组视为"回到默认"——防把自己锁死在 0 个端口）。 */
export function loadInboundPorts(): number[] {
  try {
    const raw = localStorage.getItem(INBOUND_KEY)
    if (!raw) return [...DEFAULT_INBOUND_PORTS]
    const parsed = parseInboundPorts(JSON.parse(raw))
    return parsed.length ? parsed : [...DEFAULT_INBOUND_PORTS]
  } catch {
    return [...DEFAULT_INBOUND_PORTS]
  }
}

/** 写配置（归一化后落盘；返回归一化结果）。入参放宽到 unknown[]——`__mycoVnet.inbound`
 *  是 eval 直达口，收到什么形状都得兜住，归一化统一在 parseInboundPorts 做。 */
export function saveInboundPorts(list: readonly unknown[]): number[] {
  const clean = parseInboundPorts(list)
  const out = clean.length ? clean : [...DEFAULT_INBOUND_PORTS]
  try {
    localStorage.setItem(INBOUND_KEY, JSON.stringify(out))
  } catch {
    /* 存储满/隐私模式：内存语义仍在（本进程的闸门读的是这里返回值的调用方快照） */
  }
  return out
}

/**
 * 生效集合 = 用户配置 ∩ 静态白名单（`TUNNEL_DEFAULT_PORTS`，与 Java `TcpDialer.ALLOWED`
 * 同款清单——JS 放行而 Java 拒拨等于白配，两层必须一致）。协议端口不在入向管辖内。
 */
export function effectiveInboundPorts(): number[] {
  return loadInboundPorts().filter(
    (p) => (TUNNEL_DEFAULT_PORTS as readonly number[]).includes(p) && !PROTOCOL_PORTS.includes(p),
  )
}

/** `window.__mycoVnet.inbound(list?)`：无参=读生效集合；带参=写（立即生效）。 */
export function inboundApi(list?: readonly unknown[]): { ok: boolean; ports: number[]; defaults: readonly number[] } {
  if (list === undefined) return { ok: true, ports: effectiveInboundPorts(), defaults: DEFAULT_INBOUND_PORTS }
  saveInboundPorts(list)
  return { ok: true, ports: effectiveInboundPorts(), defaults: DEFAULT_INBOUND_PORTS }
}

// ══════════════════ ② 对端名册校验（同账号 claim → 名册凭据） ══════════════════

/** 名册缓存条目（per account）。ok=false = 拉取失败/账号不存在（负缓存，短 TTL）。 */
interface RosterCacheEntry {
  ok: boolean
  at: number
  rootPub?: string
  actives?: string[]
}

const rosterCache = new Map<string, RosterCacheEntry>()
/** 正缓存 TTL（吊销传播时滞上界；PC 侧 ROSTER_TTL_OK=600s，手机入向是低频面，60s 足密）。 */
const ROSTER_TTL_OK_MS = 60_000
/** 负缓存 TTL（网络抖动不锁死新设备）。 */
const ROSTER_TTL_NEG_MS = 15_000

/** `GET /root/:did` 响应 → {rootPubkeyB64, 未吊销设备裸公钥列表}（对齐 PC parse_roster）。 */
export function parseRoster(body: unknown): { rootPub: string; actives: string[] } | null {
  const data = (body as { data?: { rootPubkeyB64?: unknown; devices?: unknown } } | null)?.data
  if (!data) return null
  const rootPub = typeof data.rootPubkeyB64 === 'string' ? data.rootPubkeyB64 : ''
  const devs = Array.isArray(data.devices) ? data.devices : []
  const actives: string[] = []
  for (const d of devs) {
    const rec = d as { pubkeyB64?: unknown; revoked?: unknown }
    if (typeof rec.pubkeyB64 !== 'string' || rec.pubkeyB64 === '') continue
    if (Number(rec.revoked ?? 0) !== 0) continue // 只认未吊销
    actives.push(rec.pubkeyB64)
  }
  if (rootPub === '' && actives.length === 0) return null
  return { rootPub, actives }
}

/**
 * 校验"签名设备真的属于声称的账号"：
 * 设备公钥（从 device did 自证解出）∈ 名册未吊销设备列表，或 == rootPubkeyB64。
 * fail-closed：查不到/网络失败/格式坏 → false（不冒充放行）。
 */
export async function verifyVnetPeerRoster(peer: { account: string; device: string }): Promise<boolean> {
  const pub = didPubkeyBytes(peer.device)
  if (!pub || !peer.account) return false
  const devPubB64 = toB64(pub)
  const now = Date.now()
  const cached = rosterCache.get(peer.account)
  if (cached && now - cached.at < (cached.ok ? ROSTER_TTL_OK_MS : ROSTER_TTL_NEG_MS)) {
    if (!cached.ok) return false
    return !!cached.actives && (cached.actives.includes(devPubB64) || cached.rootPub === devPubB64)
  }
  try {
    const r = await fetch(`${DID_BASE}/root/${encodeURIComponent(peer.account)}`, {
      signal: AbortSignal.timeout(4000),
    })
    if (!r.ok) {
      rosterCache.set(peer.account, { ok: false, at: now })
      return false
    }
    const parsed = parseRoster(await r.json())
    if (!parsed) {
      rosterCache.set(peer.account, { ok: false, at: now })
      return false
    }
    rosterCache.set(peer.account, { ok: true, at: now, rootPub: parsed.rootPub, actives: parsed.actives })
    return parsed.actives.includes(devPubB64) || parsed.rootPub === devPubB64
  } catch {
    rosterCache.set(peer.account, { ok: false, at: now })
    return false
  }
}

/** 测试复位（清名册缓存）。 */
export function _resetRosterCacheForTest(): void {
  rosterCache.clear()
}
