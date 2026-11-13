/**
 * task-open.ts — 手机端「任务卡打开」的路由与执行（2026-10-23）。
 *
 * 与 PC `apps/home/ui/src/task-open.ts` 同一套规则，差异只在执行面：
 *   · PC：`vnet_env_open`（Rust 执行器，RDP→mstsc / DSH→浏览器）；
 *   · 手机：`window.__mycoVnet.add` 起本机固定口 → 壳桥拉客户端：
 *       RDP  → `MycoShell.openRdp`（没有桥就**复制 `127.0.0.1:<localPort>`** 并提示
 *              "请在你的远程桌面 App 里连接"——手机没有 mstsc）；
 *       DSH  → 分享入口（/gw/… 或 env.shareId）**只走设备隧道 VNETP 直入**
 *              （15200 DID 认证口，免 mt；2026-11-12 取票/mt 链已删）；无 shareId
 *              的普通 http env 照旧 `entryUrlOf` 白名单 → 根路径直开。
 *
 * 为什么列表行也要走这里（真机 bug）：任务列表行原来只认「分享卡坐标」
 * （shareId + sourceDevice + sourceAccount）→ `openTaskShare`。带 env 的卡
 * 走那条路会落到 `/gw/<id>/app/`，页面报 `no valid share cookie (open the
 * share entry first)`。**有 env 的卡，入口就是环境本身**。
 *
 * 入口纪律（R28）：只认卡上**显式** `env[]`（动作里的 env 优先）；
 * 不按 `sourceDevice` 派生（老卡的行为保持不变）。
 */
import { shareIdFromGw } from './client-assert'
import { INAPP_FOCUS_GUARD_JS } from './inapp-focus-guard'

import {
  addressOf,
  browserUrlOf,
  capsGate,
  capsOfCard,
  cleanTechText,
  entryUrlOf,
  envsOfCard,
  KIND_LABEL,
  localPortOf,
  openUrlViaShell,
  presenceDiagState,
  stateText,
  targetPortOf,
  vnetBridge,
  type EnvRowState,
  type TaskEnv,
  type VnetBridge,
} from './task-env'
import { copyText, hasRdpBridge, openRdpViaShell, loadLocalForwards, sameDevice } from './remote-desktop'

/**
 * 手机侧设备隧道的本地口段（Java `P2pSyncTunnel.PORT_BASE` 起自动分配）。
 *
 * 2026-11-11 真案：任务卡 env 里的 `localPort`（23389 / 23911）是 **PC 侧** 口——
 * 手机上没有监听。照它把地址交给远程桌面 App，表现就是"复制成功但连不上"，
 * 复制失败时更糟（用户手上连个能试的地址都没有）。手机侧必须用**本机**隧道口。
 */
const PHONE_TUNNEL_PORT_MIN = 25910
const PHONE_TUNNEL_PORT_MAX = 25999

/** 本机隧道里「到 env.device 的 env.port」那条转发的本地口；没有则 0。 */
function pickPhoneForward(env: TaskEnv): number {
  try {
    const target = targetPortOf(env)
    const hit = loadLocalForwards().find(
      (f) => f.port === target && sameDevice(f.device, env.device ?? '')
        && f.localPort >= PHONE_TUNNEL_PORT_MIN && f.localPort <= PHONE_TUNNEL_PORT_MAX,
    )
    return hit ? hit.localPort : 0
  } catch {
    return 0
  }
}

/** 任务卡动作（与 Rust `share_card_record` / PC 同形状）。 */
export interface TaskCardAction {
  kind?: string
  url?: string
  label?: string
  target?: string
  env?: unknown[]
  shareId?: string
}

/** 卡上**显式声明**的 env（动作里的 env 优先；无派生）。空 = 这张卡没有 env 入口。 */
export function declaredEnvsOfCard(
  card: Record<string, unknown> | null | undefined,
  action?: TaskCardAction | null,
): TaskEnv[] {
  const c = card || {}
  if (Array.isArray(c.env) && c.env.length > 0) {
    const fromCard = envsOfCard(c)
    if (fromCard.length) return fromCard
  }
  if (Array.isArray(action?.env) && action.env.length > 0) {
    return envsOfCard({ env: action.env })
  }
  return []
}

/** 主 env：`rdp → dsh → 声明顺序第一条`（与 PC/Rust 同序）。 */
export function primaryEnvOf(envs: TaskEnv[]): TaskEnv | null {
  if (!envs.length) return null
  return envs.find((e) => e.kind === 'rdp') || envs.find((e) => e.kind === 'dsh') || envs[0]
}

/** `open-env` 按钮文案（"打开远程桌面" / "打开 DSH Web"，与 PC/Rust 逐字一致）。 */
export function envOpenLabel(env: TaskEnv): string {
  if (env.kind === 'dsh') return '打开 DSH Web'
  return `打开${KIND_LABEL[env.kind] || '环境'}`
}

export function actionLabelOf(action: TaskCardAction | null | undefined, envs: TaskEnv[]): string {
  const l = (action?.label || '').trim()
  if (l) return l
  const env = primaryEnvOf(envs)
  return env ? envOpenLabel(env) : '打开'
}

/** 打开路由：env 卡走环境；其它仍交给原来的 `openTaskShare`（分享入口/VNETP 直入）。 */
export type PhoneOpenRoute =
  | { via: 'env'; env: TaskEnv; envs: TaskEnv[]; label: string }
  | { via: 'share'; label: string }
  | { via: 'none'; label: string }

export function openRouteOf(
  card: Record<string, unknown> | null | undefined,
  action?: TaskCardAction | null,
): PhoneOpenRoute {
  const envs = declaredEnvsOfCard(card, action)
  const env = primaryEnvOf(envs)
  if (env) return { via: 'env', env, envs, label: actionLabelOf(action, envs) }
  if (action?.kind === 'open-url' || (card && typeof card.shareId === 'string' && card.shareId)) {
    return { via: 'share', label: actionLabelOf(action, envs) }
  }
  return { via: 'none', label: actionLabelOf(action, envs) }
}

/** 执行面依赖（单测注入；生产用默认实现）。 */
export interface EnvOpenDeps {
  vnet?: VnetBridge | null
  copy?: (t: string) => Promise<boolean>
  hasRdp?: () => boolean
  openRdp?: (addr: string, device?: string) => boolean
  openUrl?: (url: string) => boolean
  /**
   * 2026-11-12：设备隧道 VNETP 入口口（15200）的 ensure（生产 =
   * dsh-open-runtime.ensureShareEntryForwardFor）。返回本地口 >0 = 免 mt 的
   * 隧道直入；null/未提供 = 分享入口不可用（如实 blocked，不回落 mt）。
   */
  ensureEntryForward?: (device: string) => Promise<number | null>
}

export interface EnvOpenOutcome {
  state: EnvRowState
  /** 一行给人看的结果（地址/已打开/离线/无服务/无权限） */
  note: string
  address: string
  /** 是否真的把客户端拉起来或把地址交到用户手上（ready 才有意义） */
  started: boolean
}

/** presence 预检最多等 3s（别让"打开"卡 8s）。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))])
}

/** 入口 URL 解析结果（主路径与「↗ 浏览器」共用一份，避免两份逻辑漂移）。 */
interface EnvEntryResolution {
  /** 可直接打开的完整 URL；空 = 没有可用入口（调用方给明确错误，不打开、不复制半截地址） */
  url: string
  /** 入口不可用时给用户的一句说明（合法入口时为空串） */
  fallbackNote: string
  /** URL 为空时的原因（身份未就绪 / 无可用入口） */
  blockedNote: string
}

/**
 * 解析 DSH/HTTP 的入口 URL（**主路径与「↗ 浏览器」唯一的一份**）。
 *
 * 2026-11-12 起（取票/mt 链整链删除）只有两种合法形态：
 *   · **分享入口（`/gw/…` 或 env.shareId）→ VNETP 直入是唯一路径**：ensure 设备
 *     隧道 15200（VNETP/1 DID 认证口，DID 随隧道流带上，免 mt/免客户端断言）；
 *     拿不到口 → 如实 blockedNote（连不上源设备），**绝不回落卡上的 mt entryUrl**
 *     （mt 会过期、13911 裸网关无凭证必拒——真机 0.3.315 定案）。
 *   · **无 shareId 的普通 http env → 照旧**：`entryUrlOf` 白名单校验卡上入口
 *     （只认 `http://127.0.0.1:<localPort>/…`），否则 `browserUrlOf` 根路径直开。
 *
 * 抽出来的目的：同一张卡点「打开」和点「↗ 浏览器」必须拿到**逐字相同**的 URL
 * （单测钉住），不能一边走隧道一边落根路径。
 */
/**
 * 设备隧道 VNETP 入口的 ensure（2026-11-12）：
 * deps 注入优先（单测）；真机 WebView 惰性加载装配层；node/无壳 → null（如实 blocked）。
 */
function resolveEntryEnsure(d: EnvOpenDeps): ((device: string) => Promise<number | null>) | null {
  if (d.ensureEntryForward) return d.ensureEntryForward
  const shellLike = (globalThis as unknown as { window?: { MycoShell?: unknown } }).window?.MycoShell
  if (!shellLike) return null
  return async (device: string): Promise<number | null> => {
    try {
      const m = await import('./dsh-open-runtime')
      return await m.ensureShareEntryForwardFor(device)
    } catch {
      return null
    }
  }
}

/** dsh/http 是否具备 VNETP 直入条件（有分享入口 + 目标设备）。 */
function vnetpEligible(env: TaskEnv): string {
  const envAny = env as unknown as { shareId?: string }
  return shareIdFromGw((env.entryUrl || '').trim()) || (envAny.shareId || '').trim()
}

async function resolveEnvEntryUrl(env: TaskEnv, d: EnvOpenDeps): Promise<EnvEntryResolution> {
  return resolveEnvEntryUrlWith(env, d, 0)
}

/**
 * `vnetpPort > 0`（openTaskEnv 已确保的 15200 本地口）时免 ensure 直接用；
 * =0 时自行 ensure（「↗ 浏览器」等旁路调用形态）。
 */
async function resolveEnvEntryUrlWith(env: TaskEnv, d: EnvOpenDeps, vnetpPort: number): Promise<EnvEntryResolution> {
  // ★ 分享入口（/gw/… 或 env.shareId）：VNETP 直入是**唯一**路径（2026-11-12 起）。
  //   拿不到口 → 如实 blocked，绝不回落卡上带 mt 的 entryUrl。
  const sid = vnetpEligible(env)
  if (sid) {
    if (!env.device) {
      return { url: '', fallbackNote: '', blockedNote: '卡上缺少目标设备信息，请让对方重新分享' }
    }
    let port: number | null = null
    if (vnetpPort > 0) {
      port = vnetpPort
    } else {
      const ensure = resolveEntryEnsure(d)
      if (ensure) {
        try {
          port = await ensure(env.device)
        } catch {
          port = null
        }
      }
    }
    if (port && port > 0) {
      // 2026-11-13 卡即合约（与 openTaskShare 同口径）：唯一 URL 形态 =
      // `http://<deviceAlias>.localhost:<口>/<shareAlias>/`（*.localhost 回环解析，
      // Host 随 URL 进隧道，网关按 Host+别名表归位）。/gw/<id>/ 老形态已废
      // （真机 RED 03:47：env 行点开 /gw/ URL，新网关按 Host 路由 → 404 空白）。
      // 卡缺别名 → 如实报旧形态，不猜 URL。
      const aliases = env as unknown as { deviceAlias?: string; shareAlias?: string }
      const da = (aliases.deviceAlias || '').trim()
      const sa = (aliases.shareAlias || '').trim()
      if (!da || !sa) {
        return { url: '', fallbackNote: '', blockedNote: '这张卡是旧形态（缺源设备坐标），请让源设备重新分享一次' }
      }
      return { url: `http://${da}.localhost:${port}/${sa}/`, fallbackNote: '', blockedNote: '' }
    }
    return { url: '', fallbackNote: '', blockedNote: '连不上源设备（设备隧道不可用），请稍后再试' }
  }
  // 无 shareId 的普通 http env：照旧（entryUrl 白名单校验 → 根路径直开）。
  const declared = (env.entryUrl || '').trim()
  const entry = entryUrlOf(env)
  const fallbackNote = declared && !entry ? '（卡上的入口不可用，已改用备用入口）' : ''
  const url = entry || browserUrlOf(env)
  if (!url) {
    // 防御分支：未知 kind / 端口非法时没有可交给浏览器的地址——绝不打开/复制空串。
    return { url: '', fallbackNote: '', blockedNote: '这张卡没有可用的入口地址，请让对方重新分享' }
  }
  return { url, fallbackNote, blockedNote: '' }
}

/**
 * 打开一条 env（列表行与气泡 env 行**共用这一份实现**）。
 *
 * 硬纪律（与 PC 侧逐条对应）：
 *   · `offline` / `denied` / 固定口起不来 → **不启动任何客户端**（不假装打开）；
 *   · RDP 没有壳桥 → 复制地址 + "请在你的远程桌面 App 里连接"（手机没有 mstsc）；
 *   · DSH/HTTP → 系统浏览器（`MycoShell.openInBrowser`），没有桥就复制地址。
 */
/**
 * HTTP 探测本地转发口：任意 HTTP 响应（含 401/404）= 隧道活着。
 * 超时/网络错误 = 隧道半死/全死——必须重建，不能把空页开给用户。
 * （2026-11-03 手机"返回再进空连接"真案：TCP 能 accept 但对端无响应 = ERR_EMPTY_RESPONSE。）
 */
async function probeHttpPort(localPort: number, timeoutMs: number): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const resp = await fetch(`http://127.0.0.1:${localPort}/`, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    })
    clearTimeout(timer)
    // 任意 HTTP 状态码（含 401/404/5xx）都算"隧道在响应"
    return resp.status >= 200 && resp.status < 600
  } catch {
    return false
  }
}

export async function openTaskEnv(
  env: TaskEnv,
  opts: {
    gate?: 'ok' | 'denied' | 'unknown'
    deps?: EnvOpenDeps
    /** 建链中的进度（列表行/气泡都把这句话摆到行内） */
    onBuilding?: (note: string) => void
  } = {},
): Promise<EnvOpenOutcome> {
  // 手机侧优先用**本机**设备隧道的口（见 pickPhoneForward 注释）
  const phonePort = pickPhoneForward(env)
  const address = phonePort > 0 ? `127.0.0.1:${phonePort}` : addressOf(env)
  const gate = opts.gate ?? 'unknown'
  const d = opts.deps || {}
  const copy = d.copy || copyText
  const hasRdp = d.hasRdp || hasRdpBridge
  const openRdp = d.openRdp || openRdpViaShell
  const openUrl = d.openUrl || openUrlViaShell
  const vnet = d.vnet !== undefined ? d.vnet : vnetBridge()

  if (!env.device) {
    return { state: 'denied', note: '卡上缺少目标设备信息，请让对方重新分享', address, started: false }
  }
  if (gate === 'denied') {
    return { state: 'denied', note: stateText('denied', env.kind), address, started: false }
  }
  if (!vnet?.add) {
    return {
      state: 'idle',
      note: '当前应用版本过旧，暂不支持直接打开（请升级后重试）',
      address,
      started: false,
    }
  }

  opts.onBuilding?.('正在连接…')

  // presence 预检（离线时**不启动客户端**；查不到继续走固定口——不把"查不到"当离线）
  if (typeof vnet.presence === 'function') {
    try {
      const diag = await withTimeout(vnet.presence(env.device), 3000)
      if (presenceDiagState(diag) === 'offline') {
        return { state: 'offline', note: stateText('offline', env.kind), address, started: false }
      }
    } catch {
      /* presence 查询失败不当离线（网络抖动），继续走固定口 */
    }
  }

  const localPort = phonePort > 0 ? phonePort : localPortOf(env)
  const port = targetPortOf(env)

  // ★ 2026-11-12 VNETP 直入（真机 03:00 真案）：dsh/http 有分享入口时**只走**
  // 15200（VNETP/1 DID 认证口）。拿不到口 → 如实报「连不上源设备」提前返回，
  // 不再建 13911 通道（这条路径上它从头到尾用不到），**绝不回落卡上 mt entryUrl**。
  let vnetpPort = 0
  const gwSid = (env.kind === 'dsh' || env.kind === 'http') && env.device ? vnetpEligible(env) : ''
  if (gwSid) {
    const ensureEntry = resolveEntryEnsure(d)
    if (ensureEntry) {
      try {
        const p = await ensureEntry(env.device)
        if (p && p > 0) vnetpPort = p
      } catch {
        /* 拿不到口 → 下面的如实 blocked */
      }
    }
    if (vnetpPort === 0) {
      return {
        state: 'idle',
        note: '连不上源设备（设备隧道不可用），请稍后再试',
        address,
        started: false,
      }
    }
  }

  let added: { ok?: boolean; err?: string } | undefined
  if (vnetpPort === 0) {
    try {
      added = vnet.add({ localPort, device: env.device, port, label: env.label || KIND_LABEL[env.kind] })
    } catch (e) {
      return {
        state: 'idle',
        note: `连接通道建立失败：${cleanTechText(e instanceof Error ? e.message : String(e))}`,
        address,
        started: false,
      }
    }
    if (added && added.ok === false) {
      return {
        state: 'idle',
        note: `连接通道建立失败：${cleanTechText(added.err || '请稍后再试')}`,
        address,
        started: false,
      }
    }
  }

  // ── 2026-11-03 真案修复：先探测再开页（dsh/http）────────────────────────
  // 用户实测：首开 OK → 返回 → 再进 = ERR_EMPTY_RESPONSE（空连接）。
  // 根因：vnet.add 幂等返回 ok，但底层隧道会话可能已半死（TCP 通、对端无响应）。
  // 修法：起客户端**之前**对本地口做一次 HTTP 探测；不通就 remove→re-add 重建隧道，
  // 重建后再探一次；两次都不通才报错——消灭"打开一个空页给用户"。
  // 前提：桥有 remove 才探测（无 remove = 无法重建，探测了也白探；也兼容旧测试）。
  // 2026-11-12：VNETP 直入已就绪（vnetpPort>0）时跳过——探测的是用不到的 13911 口。
  if ((env.kind === 'dsh' || env.kind === 'http') && vnetpPort === 0 && typeof vnet.remove === 'function') {
    opts.onBuilding?.('正在检查连接…')
    let alive = await probeHttpPort(localPort, 3500)
    if (!alive) {
      opts.onBuilding?.('连接已断开，正在重建…')
      vnet.remove?.(localPort)
      try {
        added = vnet.add({ localPort, device: env.device, port, label: env.label || KIND_LABEL[env.kind] })
      } catch {
        /* remove 后 add 失败 → 走下面的失败分支 */
      }
      if (added && added.ok === false) {
        return {
          state: 'idle',
          note: `连接重建失败：${cleanTechText(added.err || '请稍后再试')}`,
          address,
          started: false,
        }
      }
      alive = await probeHttpPort(localPort, 3500)
    }
    if (!alive) {
      return {
        state: 'idle',
        note: `连接不通（已尝试重建）。请检查网络后重试，或等一会儿再点一次`,
        address,
        started: false,
      }
    }
  }

  // ── 2026-11-03 真案修复：RDP/VNC/RustDesk 无条件重建隧道────────────────
  // 用户实测：手机 RDP"刚要连上就断开"。根因同 dsh（半死隧道）但 RDP 不是 HTTP，
  // probeHttpPort 会误判（RDP 服务的响应不是合法 HTTP → fetch 抛错 → 误报死隧道）。
  // 修法：**不做协议探测**，直接 remove→re-add 保证新鲜隧道再交地址给客户端。
  // 隧道重建 ~100ms（实测），代价可忽略。
  if ((env.kind === 'rdp' || env.kind === 'vnc' || env.kind === 'rustdesk') && typeof vnet.remove === 'function') {
    opts.onBuilding?.('正在重建连接通道…')
    vnet.remove?.(localPort)
    try {
      added = vnet.add({ localPort, device: env.device, port, label: env.label || KIND_LABEL[env.kind] })
    } catch {
      /* 重建失败 → 走下面的失败分支 */
    }
    if (added && added.ok === false) {
      return {
        state: 'idle',
        note: `连接通道重建失败：${cleanTechText(added.err || '请稍后再试')}`,
        address,
        started: false,
      }
    }
  }
  // ── 探测/重建修复结束 ──────────────────────────────────────────────────────

  // 起客户端：各 kind 的客户端形态不同
  // 2026-10-25 文案精简：提示行不再带地址/URL/端口（用户反馈技术细节没用）；
  // 复制到剪贴板的仍是完整地址（远程桌面 App 里直接粘贴即可）。
  // 2026-11-01 自由远程桌面：vnc/rustdesk 与 rdp 同款"复制地址"路径
  // （手机端预装客户端不统一：MS RD / bVNC / RustDesk 各装各的）。
  if (env.kind === 'rdp' || env.kind === 'vnc' || env.kind === 'rustdesk') {
    if (env.kind === 'rdp' && hasRdp() && openRdp(address, env.device)) {
      return { state: 'ready', note: '正在用远程桌面打开', address, started: true }
    }
    // 手机没有统一预装客户端：把地址交到用户手上（自动复制 + 明确下一步）
    const appName = env.kind === 'vnc' ? 'VNC App（bVNC/RealVNC）'
      : env.kind === 'rustdesk' ? 'RustDesk App（地址栏直连）'
      : '远程桌面 App'
    // 2026-11-01 真机（用户自己的手机连 ECS Linux）：RDP 服务端都是自签证书，
    // 客户端首次连接必弹「无法验证证书」（名不对/非受信 CA）。用户点了取消，
    // 表现就是"连不上"——曾据此误判成地址/配置错误。连接后还有几秒黑屏
    // （xrdp 起桌面会话）。这两条都在提示行里说清楚，别再让用户猜。
    const firstConnect = env.kind === 'rdp'
      ? '（首次连接：弹证书时勾选「不再要求连接到这台电脑」再点「连接」，随后黑屏几秒属正常）'
      : ''
    const ok = await copy(address)
    // 2026-11-11 真机：WebView 里 clipboard 常常没有用户手势 → 复制必败，而原提示
    // 只写"自动复制失败，请重试一次"，用户手上根本没有地址可粘。地址必须出现在
    // 提示里（远程桌面 App 里手输一次即可）。
    const addrHint = `（地址 ${address}）`
    return {
      state: 'ready',
      note: ok
        ? `已复制连接地址，请在你的${appName} 里粘贴连接${addrHint}${firstConnect}`
        : `请在你的${appName} 里连接${addrHint}（自动复制失败，手动输入即可）${firstConnect}`,
      address,
      started: ok,
    }
  }
  if (env.kind === 'dsh' || env.kind === 'http') {
    // 入口 URL 解析（2026-11-12 起与「↗ 浏览器」共用这一份）：分享入口走 VNETP
    // 直入（免 mt），普通 http env 照旧 entryUrl 白名单 → 根路径。两条路径对
    // 同一张卡必须拿到逐字相同的 URL。
    const resolved = await resolveEnvEntryUrlWith(env, d, vnetpPort)
    if (!resolved.url) {
      return { state: 'idle', note: resolved.blockedNote, address, started: false }
    }
    const url = resolved.url
    const fallbackNote = resolved.fallbackNote
    // 2026-10-23 真机修复：手机系统浏览器（荣耀/百度 LightSearchActivity）经 vnet forward
    // 打开 `127.0.0.1:<端口>` 一律转圈（与目标设备无关，已实测 PC/笔记本都一样）；
    // 应用内浏览器（InAppBrowserActivity）已在真机上完整渲染 DSH 分享页并刷出会话列表
    // ⇒ 手机端优先走应用内浏览器，桥不存在/失败再退回系统浏览器。
    // 第二参传焦点守卫脚本：DSH web 点会话会 programmatic focus 输入框、手机上弹软键盘
    // （2026-10-23 实测反馈；规则与测试见 inapp-focus-guard.ts）。
    const inAppOk = (() => {
      try {
        const sh = (window as unknown as {
          MycoShell?: { openInAppBrowser?: (u: string, guardJs?: string) => string }
        }).MycoShell
        if (!sh?.openInAppBrowser) return false
        const r = JSON.parse(sh.openInAppBrowser(url, INAPP_FOCUS_GUARD_JS) || '{}') as {
          ok?: boolean
        }
        return r.ok === true
      } catch {
        return false
      }
    })()
    if (inAppOk) {
      return {
        state: 'ready',
        note: `已在应用内浏览器打开${fallbackNote}`,
        address,
        started: true,
      }
    }
    if (openUrl(url)) {
      return {
        state: 'ready',
        note: `已在系统浏览器打开${fallbackNote}`,
        address,
        started: true,
      }
    }
    const ok = await copy(url)
    return {
      state: 'ready',
      note: ok ? `已复制访问链接，请在浏览器里打开${fallbackNote}` : '当前应用没能自动打开，请升级后重试',
      address,
      started: ok,
    }
  }
  // ssh / stereo / adb：固定口已起，复制连接地址 + 一句人话（不带地址/端口）
  const ok = await copy(address)
  const hint =
    env.kind === 'ssh'
      ? '已复制 SSH 连接地址，可在终端里使用'
      : env.kind === 'adb'
        ? '已复制 adb 连接地址，可在命令行里使用'
        : '已复制连接地址（立体声服务）'
  return { state: 'ready', note: ok ? hint : '已就绪（自动复制失败，请重试一次）', address, started: ok }
}

/**
 * 「↗ 浏览器」——先复制入口地址，再交给**系统浏览器**（用户可以在浏览器里收藏）。
 *
 * 与主路径的关系（产品原则：壳只当壳，书签/历史交给生态）：
 *   · 入口 URL 的解析/签名**共用** `resolveEnvEntryUrl` ⇒ 同一张卡两条路径逐字相同；
 *   · 主路径（`openTaskEnv`）仍是应用内浏览器，本函数绝不改它；
 *   · 只有 dsh/http 的入口是 http(s)，其它 kind 没有"浏览器打开"语义。
 *
 * 顺序：先复制地址（拿不到也继续）→ 再试 `MycoShell.openInBrowser`（`deps.openUrl` 可注入）。
 * 成功 →「已在浏览器打开（地址已复制）」；无桥/失败 →「已复制地址，请在浏览器里打开」；
 * 没有可用 URL → 明确报错（不打开、不复制半截地址）。
 *
 * 隧道：系统浏览器打的是 `127.0.0.1:<localPort>`，固定口没起就是死地址；这里
 * best-effort 补一次 `vnet.add`（主路径起过则幂等）。建链失败不阻断"复制地址"兜底。
 */
export async function openTaskEnvExternal(
  env: TaskEnv,
  opts: {
    gate?: 'ok' | 'denied' | 'unknown'
    deps?: EnvOpenDeps
    /** 准备阶段的一句话（列表行摆到行内） */
    onBuilding?: (note: string) => void
  } = {},
): Promise<EnvOpenOutcome> {
  const address = addressOf(env)
  const gate = opts.gate ?? 'unknown'
  const d = opts.deps || {}
  const copy = d.copy || copyText
  const openUrl = d.openUrl || openUrlViaShell
  const vnet = d.vnet !== undefined ? d.vnet : vnetBridge()

  if (!env.device) {
    return { state: 'denied', note: '卡上缺少目标设备信息，请让对方重新分享', address, started: false }
  }
  if (gate === 'denied') {
    return { state: 'denied', note: stateText('denied', env.kind), address, started: false }
  }

  const resolved = await resolveEnvEntryUrl(env, d)
  if (!resolved.url) {
    return { state: 'idle', note: resolved.blockedNote, address, started: false }
  }
  const url = resolved.url
  const fallbackNote = resolved.fallbackNote

  opts.onBuilding?.('正在准备浏览器打开…')

  // 固定口（隧道）：系统浏览器不经应用内壳，必须自己保证地址活着。
  // 分享入口（gw）除外——URL 在设备隧道 15200 的本地口上，ensure 时已建好，
  // 13911 固定口在这条路径上用不到（2026-11-12 起不白建）。
  if (vnet?.add && !vnetpEligible(env)) {
    try {
      vnet.add({
        localPort: localPortOf(env),
        device: env.device,
        port: targetPortOf(env),
        label: env.label || KIND_LABEL[env.kind],
      })
    } catch {
      /* 建链失败仍把地址复制给用户（浏览器侧可刷新/重试） */
    }
  }

  const copied = await copy(url)
  if (openUrl(url)) {
    return {
      state: 'ready',
      note: copied
        ? `已在浏览器打开（地址已复制）${fallbackNote}`
        : `已在浏览器打开（自动复制失败，可在地址栏收藏）${fallbackNote}`,
      address,
      started: true,
    }
  }
  return {
    state: copied ? 'ready' : 'idle',
    note: copied
      ? `已复制地址，请在浏览器里打开${fallbackNote}`
      : '没能在浏览器里打开，自动复制也失败了，请重试一次',
    address,
    started: copied,
  }
}

/**
 * 列表行是否该露出「↗ 浏览器」次要动作。
 *
 * 只对 dsh/http（入口是 http(s) 的 kind）且**有可用入口**的 env 返回 true；
 * 无 device 的破卡不给（点了也只能报错）。过期卡由调用方（列表行）再挡一层。
 */
export function canOpenEnvExternal(env: TaskEnv | null | undefined): boolean {
  if (!env || !env.device) return false
  if (env.kind !== 'dsh' && env.kind !== 'http') return false
  return !!(entryUrlOf(env) || browserUrlOf(env))
}

/** 卡片 caps 预检（列表行/气泡共用；与 PC `capsGate` 同口径）。 */
export function envGateOf(card: Record<string, unknown> | null | undefined): 'ok' | 'denied' | 'unknown' {
  return capsGate(capsOfCard(card || {}))
}

/**
 * 列表行 openNote 的语气色（2026-10-23 用户反馈：手机 RDP 复制地址后的提示被渲染成
 * 红色错误样式——"已复制连接地址…"是成功提示）。
 * ready/已复制/已打开 → ok（绿）；正在… → building（蓝）；其余（失败/离线/拒绝）→ warn（红）。
 */
export function openNoteTone(text: string, state?: EnvRowState): 'ok' | 'building' | 'warn' {
  if (state === 'ready') return 'ok'
  if (state === 'building') return 'building'
  const t = (text || '').trim()
  if (
    t.startsWith('已复制') ||
    t.startsWith('已在浏览器打开') || // 「↗ 浏览器」（2026-10-31）
    t.startsWith('已在系统浏览器打开') ||
    t.startsWith('已在应用内浏览器打开') ||
    t.startsWith('正在用远程桌面打开')
  ) {
    return 'ok'
  }
  if (t.startsWith('正在') || t.endsWith('…')) return 'building'
  return 'warn'
}
