/**
 * task-env.ts — **任务卡 env** 的纯逻辑层（手机端，2026-10-23）。
 *
 * 设计基准：`eval/vnet/design-task-card-env.md`（AOP：入口只来自分享的任务卡）。
 * 手机与 PC 的分工：
 *   · 探测/建链/状态机的**权威在真机管理面**（Rust `vnet_env.rs`）：手机拿不到
 *     `POST /api/env/open`（那是 PC 本机管理面），所以手机这一层只做
 *     ① 卡数据 → 行（envsOfCard）② caps 预检 ③ presence 预检（`__mycoVnet.presence`）
 *     ④ 起本地固定口（`__mycoVnet.add`）⑤ 用壳桥打开客户端（openRdp / openInBrowser）。
 *   · 五状态词表与文案与 PC 侧逐字一致（`apps/home/ui/src/task-env.ts`），避免
 *     "同一条 env 在两端口径不同"。
 *
 * 桥的边界（2026-10-22 分工，别越界）：
 *   - `window.__mycoVnet.add/state/presence` 由 `vnet-forward.ts` 安装；
 *   - `MycoShell.openRdp` 由 APK 壳（MainActivity）实现，没实现就退回"复制地址"；
 *   - `MycoShell.openInBrowser` 已有（系统浏览器 ACTION_VIEW，只放行 http(s)）。
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

export interface TaskEnv {
  kind: string
  device?: string
  port?: number
  localPort?: number
  label?: string
  requires?: { service?: string }
  /**
   * 卡上的**分享入口 URL**（`env.kind=dsh/http` 可选；2026-10-23 现场修复）。
   *
   * 为什么需要：`dsh` 打开 `http://127.0.0.1:<localPort>/` = 分享网关根路径，只有
   * 浏览器里**已有该分享 cookie** 时才给内容（无 cookie → 401
   * `no share cookie (open the share entry first)`）。cookie 只由入口
   * `/gw/<shareId>/?mt=…` 的 302 种下 —— 所以卡上带着入口就必开入口。
   *
   * 安全：来自卡（可跨设备/转授）→ 打开前必须过 [`entryUrlOf`] 的白名单校验。
   */
  entryUrl?: string
}

export type EnvRowState = 'idle' | 'building' | 'ready' | 'offline' | 'no-service' | 'denied'

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asPort(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.floor(n) : 0
}

/**
 * 卡上的 `env[]` → 行（与 PC 同款：有 env 用 env；没有就用 `sourceDevice` 派生一条 rdp）。
 * 手机端的分享卡来自设备群同步，`sourceDevice` 恒在（PC 侧发卡时写入）。
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
  const device = asString(c.sourceDevice) || asString(c.fromDevice)
  if (device) {
    return [{ kind: 'rdp', device, port: KIND_DEFAULT_TARGET.rdp, localPort: KIND_DEFAULT_LOCAL.rdp }]
  }
  return []
}

export function localPortOf(env: TaskEnv): number {
  return asPort(env.localPort) || KIND_DEFAULT_LOCAL[env.kind] || 0
}

export function targetPortOf(env: TaskEnv): number {
  return asPort(env.port) || KIND_DEFAULT_TARGET[env.kind] || 0
}

export function addressOf(env: TaskEnv): string {
  const p = localPortOf(env)
  return p > 0 ? `127.0.0.1:${p}` : ''
}

/* ── 展示层去技术化（2026-10-25 用户反馈：任务卡上不要 IP/URL/端口这些细节）──
 * 与 PC `apps/home/ui/src/task-env.ts` 同一份实现（纯函数，双端逐字一致）。
 * 纯显示层：卡数据、打开参数、剪贴板内容一律不动，后端零变化。 */

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

/** DSH/HTTP 的浏览器地址（固定口 → `http://127.0.0.1:<port>/`）。 */
export function browserUrlOf(env: TaskEnv): string {
  const p = localPortOf(env)
  return p > 0 ? `http://127.0.0.1:${p}/` : ''
}

/**
 * 卡上的分享入口 URL（`env.entryUrl`）→ 可用则原样返回，否则 `''`。
 *
 * **只认 `http://127.0.0.1:<localPort>/…`**（与 Rust `vnet_env::validate_entry_url`
 * 同口径）：
 *   · scheme 必须 http（分享网关只监听 loopback 明文 http）；
 *   · host 必须恰为 `127.0.0.1`（不收 localhost/IPv6/域名——解析歧义面最小）；
 *   · 端口必须等于本次建链的 localPort（否则是"本机别的服务"）；
 *   · 不收 userinfo（`127.0.0.1:23911@evil` 这类歧义写法）。
 *
 * 为什么要这道闸：`entryUrl` 来自**卡**（可跨设备投递/转授）。放行任意 URL，一张
 * 伪造卡就能借"打开 DSH"把系统浏览器指到外网钓鱼页或别的本机服务。
 */
export function entryUrlOf(env: TaskEnv): string {
  const raw = asString(env.entryUrl)
  if (!raw) return ''
  const port = localPortOf(env)
  if (port <= 0) return ''
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:') return ''
    if (u.username || u.password) return ''
    if (u.hostname !== '127.0.0.1') return ''
    if (u.port !== String(port)) return ''
    return raw
  } catch {
    return ''
  }
}

export function capsGate(caps: unknown): 'ok' | 'denied' | 'unknown' {
  if (caps === undefined || caps === null) return 'unknown'
  const list = Array.isArray(caps)
    ? caps.map((x) => asString(x))
    : asString(caps)
        .split(/[\s,]+/)
        .filter(Boolean)
  return list.includes('vnet.forward') ? 'ok' : 'denied'
}

export function capsOfCard(card: Record<string, unknown>): unknown {
  return card.caps ?? (card as { capabilities?: unknown }).capabilities
}

/** 五状态文案（与 PC 逐字一致；设计 §5；2026-10-25 “建链”→“连接”人话化）。 */
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
    default:
      return '未打开（点「打开」自动连接）'
  }
}

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
    default:
      return '#9aa3b8'
  }
}

/**
 * `window.__mycoVnet.presence(device)` 的诊断串 → 在线判定。
 *
 * vnet-forward.ts 的返回形如 `addrs-ok | n=18 …` / `addrs-null | n=0 …`
 * （见其 `presenceLookup` 的 diag）。只认 `addrs-ok` 前缀；其它一律 unknown
 * ——**不把"查不到"当离线**（网络抖一下不该让用户看到红字）。
 */
export function presenceDiagState(diag: string | null | undefined): 'online' | 'offline' | 'unknown' {
  const s = asString(diag)
  if (!s) return 'unknown'
  if (s.startsWith('addrs-ok')) return 'online'
  // 2026-11-01 修正（ECS Linux 靶机真案）：addrs-null 但名册条目在 = NAT 后的
  // 纯中继设备（docker/Linux/Mac 常态）——中继腿可达，不得判 offline 拦死打开。
  // 真离线 = 名册无条目（diag 'entry=缺席'）→ unknown，由隧道赛跑给真实结果。
  if (s.startsWith('addrs-null')) return 'unknown'
  return 'unknown'
}

/**
 * 壳桥：`MycoShell.openInBrowser`（系统浏览器）。桥不在 → false（调用方给降级文案）。
 *
 * ⚠️ 2026-10-23 真机 bug（用户报「DSH 卡只复制地址、不打开浏览器」）：
 * Android 的 `addJavascriptInterface` 注入对象**不能解绑方法再调**——
 *   const fn = MycoShell.openInBrowser; fn(url)
 *   → `Error: Java bridge method can't be invoked on a non-injected object`
 * 我们原来正是这么写的，于是每次都被 catch 吞掉 → 返回 false → 落"复制地址"降级，
 * 而同一份代码里 explore.ts 用带 receiver 的 `shell.openInBrowser(url)` 一直正常。
 * 修法：**保留 receiver 调用**（或 fn.call(MycoShell, url)）。回归测试见 task-open.test.ts
 * 的「解绑即抛错的假桥」用例。
 */
export function openUrlViaShell(url: string): boolean {
  try {
    const w = window as unknown as { MycoShell?: { openInBrowser?: (u: string) => unknown } }
    const shell = w.MycoShell
    if (!shell || typeof shell.openInBrowser !== 'function') return false
    shell.openInBrowser(url) // 必须带 receiver（见上）
    return true
  } catch {
    return false
  }
}

/** `window.__mycoVnet` 的最小面（vnet-forward.ts 安装；旧 APK 没有）。 */
export interface VnetBridge {
  add?: (f: { localPort: number; device: string; port: number; label?: string }) => { ok?: boolean; err?: string }
  /** 2026-11-03：remove 在桥上已有（vnet-forward.ts `__mycoVnet.remove`），此前接口漏声明。 */
  remove?: (localPort: number) => void
  presence?: (device: string) => Promise<string>
  state?: () => unknown
}

export function vnetBridge(): VnetBridge | null {
  try {
    const w = window as unknown as { __mycoVnet?: VnetBridge }
    return w.__mycoVnet ?? null
  } catch {
    return null
  }
}
