/**
 * task-env.ts — **任务卡 env** 的纯逻辑层（PC，2026-10-23）。
 *
 * 设计基准：`eval/vnet/design-task-card-env.md`（AOP：入口只来自分享的任务卡）。
 * 这里只做"卡片数据 → 可渲染/可执行的行"的纯映射，不碰 React、不碰 IPC：
 *   · `envsOfCard`  卡上的 `env[]` → 行（老卡无 env 时按 sourceDevice 派生一条 rdp）
 *   · `localPortOf` 固定本地口（卡上显式 → kind 默认表）
 *   · `capsGate`    caps 是否授予 `vnet.forward`（客户端预检；最终以后端为准）
 *   · `stateText`/`dotColor` 五状态文案与颜色（设计 §5）
 *   · `openArgs`    拼 `vnet_env_open` 的 args（HTTP body 与 IPC 同构）
 *
 * 契约纪律：**这里的每一行入口都来自卡**（card/env），组件不读设备名册、不读好友表。
 */

/** env.kind 白名单（与 Rust `vnet_env::ENV_KINDS` 同一份词表）。
 *  2026-11-01 +vnc/rustdesk（自由远程桌面方案）。 */
export const ENV_KINDS = ['rdp', 'dsh', 'ssh', 'http', 'stereo', 'adb', 'vnc', 'rustdesk'] as const
export type EnvKind = (typeof ENV_KINDS)[number]

/** 固定本地口（设计 §4；`http` 不在表内 → 卡必须显式给 localPort，23912 只是兜底）。 */
export const KIND_DEFAULT_LOCAL: Record<string, number> = {
  rdp: 23389,
  dsh: 23911,
  ssh: 2223,
  stereo: 29000,
  adb: 25037,
  http: 23912,
  vnc: 23590,
  rustdesk: 23591,
}

/** 目标端口默认值（设计 §4）。 */
export const KIND_DEFAULT_TARGET: Record<string, number> = {
  rdp: 3389,
  dsh: 13911,
  ssh: 22,
  stereo: 9000,
  adb: 5037,
  http: 80,
  vnc: 5900,
  rustdesk: 21118,
}

/** kind → 图标。 */
export const KIND_ICON: Record<string, string> = {
  rdp: '🖥',
  dsh: '🌐',
  ssh: '⌨️',
  http: '🔗',
  stereo: '🎧',
  adb: '📱',
  vnc: '🖥',
  rustdesk: '🦀',
}

/** kind → 人话名（与 Rust `service_name` 同口径）。 */
export const KIND_LABEL: Record<string, string> = {
  rdp: '远程桌面',
  dsh: 'DSH web',
  ssh: 'SSH',
  http: 'HTTP',
  stereo: '立体声',
  adb: 'adb',
  vnc: 'VNC 远程桌面',
  rustdesk: 'RustDesk',
}

/** 卡上声明的一个 env。 */
export interface TaskEnv {
  kind: string
  device?: string
  port?: number
  localPort?: number
  label?: string
  requires?: { service?: string }
  /**
   * 卡上的**分享入口 URL**（`dsh/http` 可选；2026-10-23 现场修复）。
   *
   * DSH 的根路径 `http://127.0.0.1:<localPort>/` 只在浏览器已有该分享 cookie 时
   * 才有内容（否则 401 `no share cookie (open the share entry first)`）；cookie 由
   * 入口 `/gw/<shareId>/?mt=…` 的 302 种下。执行器（Rust）会校验后优先打开它，
   * **这里只负责把卡上的原值一路带到 `vnet_env_open`**（别在 UI 层丢字段）。
   */
  entryUrl?: string
}

/** 五状态 + 未点开（`idle` 只是 UI 初始态，不在设计词表里；`error` 是本机侧失败）。 */
export type EnvRowState = 'idle' | 'building' | 'ready' | 'offline' | 'no-service' | 'denied' | 'error'

/** 后端 `POST /api/env/open` / `vnet_env_open` 的返回。 */
export interface EnvOpenResult {
  ok?: boolean
  state?: string
  kind?: string
  address?: string
  localPort?: number
  requestedLocalPort?: number
  clientStarted?: boolean
  client?: string | null
  message?: string
  error?: string
  hint?: string
  launchError?: string
  tunnel?: string
  selfTarget?: boolean
  ms?: number
  debug?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asPort(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.floor(n) : 0
}

/**
 * 卡上的 `env[]` → 可渲染的行。
 *
 * - 有 `env`（对象数组）→ 只用卡声明的（**不补、不猜**）；
 * - 没有 `env` 的**老分享卡** → 按 `sourceDevice`/`fromDevice` 派生一条 rdp env
 *   （仍然挂在任务卡上；设备/好友卡不会因此多出入口——R28）。
 */
export function envsOfCard(card: Record<string, unknown> | null | undefined): TaskEnv[] {
  const c = card || {}
  const raw = c.env
  if (Array.isArray(raw)) {
    const out: TaskEnv[] = []
    for (const it of raw) {
      if (!it || typeof it !== 'object') continue
      const e = it as Record<string, unknown>
      const kind = asString(e.kind).toLowerCase()
      if (!ENV_KINDS.includes(kind as EnvKind)) continue
      out.push({
        kind,
        device: asString(e.device) || undefined,
        port: asPort(e.port) || undefined,
        localPort: asPort(e.localPort) || undefined,
        label: asString(e.label) || undefined,
        requires: (e.requires as { service?: string }) || undefined,
        entryUrl: asString(e.entryUrl) || undefined,
      })
    }
    return out
  }
  // 老卡兼容（2026-10-22 之前的分享卡只有 sourceDevice）：派生一条 rdp env
  const device = asString(c.sourceDevice) || asString(c.fromDevice)
  if (device) {
    return [{ kind: 'rdp', device, port: KIND_DEFAULT_TARGET.rdp, localPort: KIND_DEFAULT_LOCAL.rdp }]
  }
  return []
}

/** 固定本地口：卡上显式 → kind 默认表 → 0（无法渲染地址）。 */
export function localPortOf(env: TaskEnv): number {
  return asPort(env.localPort) || KIND_DEFAULT_LOCAL[env.kind] || 0
}

/** 目标端口：卡上显式 → kind 默认表 → 0。 */
export function targetPortOf(env: TaskEnv): number {
  return asPort(env.port) || KIND_DEFAULT_TARGET[env.kind] || 0
}

/** 唯一允许复制/执行的地址形态（**不再直接展示**，见 cleanTechText）。 */
export function addressOf(env: TaskEnv): string {
  const p = localPortOf(env)
  return p > 0 ? `127.0.0.1:${p}` : ''
}

/* ── 展示层去技术化（2026-10-25 用户反馈：任务卡上不要 IP/URL/端口这些细节）──
 * 纯显示层：卡数据、打开参数（openArgs）、剪贴板内容一律不动，后端零变化。
 *   · cleanTechText  给人看的提示行抹掉 URL / IP（v4·v6，含端口）/ DID / 端口号；
 *   · cleanCardTitle 卡面标题同样净化（老环境卡的卡名带 127.0.0.1:端口 模板）。 */

/** 把文案里的技术细节（URL / IP / DID / 端口号）抹掉——只用于显示。 */
export function cleanTechText(text: string): string {
  let s = String(text || '')
  s = s.replace(/https?:\/\/\S+/g, '') // URL（含带 mt 票据的分享入口）
  s = s.replace(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, '') // IPv6（240e:… / ::1）
  s = s.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, '') // IPv4（可带 :端口）
  s = s.replace(/\bdid:[a-z0-9-]+:\S+/gi, '设备') // 设备 DID 全称
  s = s.replace(/(固定口|本地口|约定口|端口|口)\s*\d{2,5}/g, '$1') // “固定口 23389”类端口号
  s = s.replace(/localPort/gi, '端口') // 字段名不进界面
  s = s.replace(/[（(]\s*[）)]/g, '').replace(/\s{2,}/g, ' ').trim()
  return s
}

/** 卡面标题净化：老卡的卡名带 `127.0.0.1:端口` / URL（旧建卡模板）——显示时去掉，
 *  尾部残留的分隔符一并清掉。数据与打开链路不动。 */
export function cleanCardTitle(title: string): string {
  const s = cleanTechText(title)
  return s.replace(/[\s·|—-]+$/g, '').trim()
}

/** 卡的 caps 是否授予 `vnet.forward`（`unknown` = 卡没声明 caps，由后端判 denied）。 */
export function capsGate(caps: unknown): 'ok' | 'denied' | 'unknown' {
  if (caps === undefined || caps === null) return 'unknown'
  const list = Array.isArray(caps)
    ? caps.map((x) => asString(x))
    : asString(caps)
        .split(/[\s,]+/)
        .filter(Boolean)
  return list.includes('vnet.forward') ? 'ok' : 'denied'
}

/** 从卡上取 caps（摊平后的卡面）。 */
export function capsOfCard(card: Record<string, unknown>): unknown {
  return card.caps ?? (card as { capabilities?: unknown }).capabilities
}

/** 五状态文案（设计 §5：离线/无服务/无权限必须给明确人话）。 */
export function stateText(state: EnvRowState, kind: string): string {
  switch (state) {
    case 'ready':
      return '已就绪'
    case 'building':
      return '正在连接…'
    case 'offline':
      return '设备离线，稍后再试'
    case 'no-service':
      return `目标未提供${KIND_LABEL[kind] || '该'}服务`
    case 'denied':
      return '此卡未授予该能力'
    case 'error':
      // 本机侧失败（固定口被占等）：不是设备离线，绝不显示"稍后再试"。
      return '本机建链失败'
    default:
      return '未打开（点「打开」自动连接）'
  }
}

/** 状态点颜色（绿/转/灰/黄/红）。 */
export function dotColor(state: EnvRowState): string {
  switch (state) {
    case 'ready':
      return '#22c55e'
    case 'building':
      return '#fbbf24'
    case 'no-service':
      return '#f59e0b'
    case 'denied':
      return '#ef4444'
    case 'error':
      return '#ef4444'
    default:
      return '#9aa3b8'
  }
}

/** 后端 state 字符串 → 行状态（未知一律回 idle，绝不假绿）。 */
export function rowStateOf(res: EnvOpenResult | null | undefined): EnvRowState {
  // 链路就绪但客户端没起来（入口坐标不全 / 浏览器拉起失败）→ 打开失败，不能亮绿点。
  // 自连提示（selfTarget）不算失败，照旧走 state。
  if (res?.ok && !res.selfTarget && asString(res.error)) return 'error'
  const s = asString(res?.state)
  const known: EnvRowState[] = ['ready', 'building', 'offline', 'no-service', 'denied', 'error']
  if (known.includes(s as EnvRowState)) return s as EnvRowState
  return res?.ok ? 'ready' : 'idle'
}

/**
 * 拼 `vnet_env_open` 的 args（与 HTTP `POST /api/env/open` 的 body 同构）。
 *
 * 卡身份三件套（cardId/taskId/caps/signature）一起带上：后端按 caps 做闸，
 * 并把 cardId/taskId 写进 `env-open` 审计（"谁通过哪张卡用了什么"）。
 */
export function openArgs(
  card: Record<string, unknown> | null | undefined,
  env: TaskEnv,
): Record<string, unknown> {
  const c = card || {}
  const caps = capsOfCard(c)
  const args: Record<string, unknown> = {
    env: {
      kind: env.kind,
      device: env.device || '',
      port: targetPortOf(env),
      localPort: localPortOf(env),
      ...(env.label ? { label: env.label } : {}),
      // 分享入口（2026-10-23）：**必须原样转发**——Rust 执行器优先打开它，丢了就
      // 回到网关根路径（无 cookie → 401 / 会话列表空）。校验在 Rust 侧做（单点）。
      ...(env.entryUrl ? { entryUrl: env.entryUrl } : {}),
    },
  }
  const cardId = asString(c.cardId) || asString(c.shareId) || asString(c.id)
  const taskId = asString(c.taskId) || asString(c.task_id)
  if (cardId) args.cardId = cardId
  if (taskId) args.taskId = taskId
  // 2026-11-15 真案（用户 01:32「DSH 卡点开没反应」，两端全 denied）：
  // 原来把分享记录的 caps **原样**发出，而分享记录上的 caps 是 O/A 能力集对象
  // （`{o:[…],a:[…]}`）——里面根本没有 `vnet.forward`，后端卡闸必拒。修法：
  // 归一化成扁平词表，并补上 env 卡隐含的隧道权限（有 env 即隐含可开隧道，
  // 与 `share_card_record` 落盘时给 env 卡补 `caps:["vnet.forward"]` 同一口径）。
  const flatCaps: string[] = (() => {
    const raw = caps
    if (raw === undefined || raw === null) return []
    if (Array.isArray(raw)) return raw.map((x) => asString(x)).filter(Boolean)
    if (typeof raw === 'object') {
      const o = raw as Record<string, unknown>
      const out: string[] = []
      for (const k of ['o', 'a', 'caps']) {
        const v = o[k]
        if (Array.isArray(v)) out.push(...v.map((x) => asString(x)).filter(Boolean))
      }
      return out
    }
    return asString(raw)
      .split(/[\s,]+/)
      .filter(Boolean)
  })()
  // 2026-11-15 修正：只在**真卡**（有 cardId/taskId）或卡上本来声明过 caps 时才补
  // `vnet.forward`。调试卡（`openArgs({}, env)`：无卡号、无 caps）必须保持"不带 caps"
  // ——Rust 侧 `parse_call` 的调试闸正是"debug:true 且不带 cardId 且无 caps 声明"，
  // 这里硬塞 caps 会让它从调试路径变成"声明卡但缺签名"的语义（并打破既有单测契约）。
  const isRealCard = Boolean(cardId || taskId)
  const capsDeclared = caps !== undefined && caps !== null
  if (isRealCard || capsDeclared) {
    args.caps = Array.from(new Set([...flatCaps, 'vnet.forward']))
  }
  const sig = asString(c.signature)
  if (sig) args.signature = sig
  return args
}

/** 进度的"人话"（2026-10-25 精简：提示行不再带地址/端口/URL——用户反馈这些技术
 *  细节没用；打开仍用完整地址（Rust 执行器侧不变），这里只改给人看的文案）。 */
export function resultNote(res: EnvOpenResult | null | undefined): string {
  if (!res) return ''
  if (res.selfTarget) {
    return cleanTechText(res.hint || '') || '这是本机发起的分享，请在对方设备上打开'
  }
  // 链路就绪但客户端没起来：入口坐标不全 / 浏览器拉起失败 → 说"打开失败"，不给假绿。
  if (res.ok && res.error) {
    return cleanTechText(res.hint || '') || `打开失败：${cleanTechText(res.error)}`
  }
  // 固定口漂移（端口被占自动换口）：只说发生了什么，不报端口号。
  // 设备域终态的"本地口"是 viewer 的全局 HTTP 口（24011），与卡上的固定口本就不同源，
  // 那不是漂移——不能报成「原通道被占用，已自动换用临时通道」（2026-11-14 用户真案）。
  const drift =
    res.tunnel !== 'device-origin' &&
    res.requestedLocalPort &&
    res.localPort &&
    res.requestedLocalPort !== res.localPort
      ? '（原通道被占用，已自动换用临时通道）'
      : ''
  if (res.ok) {
    const started =
      res.clientStarted === false
        ? '已就绪'
        : res.client === 'browser'
          ? '已在系统浏览器打开'
          : res.client === 'mstsc'
            ? '已启动远程桌面'
            : res.client === 'vnc-viewer'
              ? 'VNC 已就绪'
              : res.client === 'rustdesk'
                ? 'RustDesk 已就绪'
                : '已打开'
    // hint 与状态行同义时不重复（真案：浏览器成功 → "已在系统浏览器打开 · 已在系统浏览器打开"）。
    const hintText = res.hint ? cleanTechText(res.hint) : ''
    const hint = hintText && hintText !== started ? ` · ${hintText}` : ''
    return `${started}${drift}${hint}`
  }
  return cleanTechText(res.message || res.error || res.launchError || '') || '打不开（未知错误）'
}
