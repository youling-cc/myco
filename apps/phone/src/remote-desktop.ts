/**
 * remote-desktop.ts — 远程桌面「一键打开」的**纯逻辑层**（手机端，纯 JS/TS）。
 *
 * 目标：任务卡/聊天里显示 `127.0.0.1:23389`（PC 的 3389 经 myco vnet 固定口），
 * 一键**复制地址**；壳（MainActivity）提供 `MycoShell.openRdp` 后，再多一个
 * 「用远程桌面打开」按钮。
 *
 * 边界（2026-10-22 与并行 agent 的分工）：
 * - **不改** `vnet-forward.ts` / `MainActivity.java` / `ForwardListener.java` /
 *   `vnet-forward.ts` 的桥方法；这里只**读**同一份配置与同一个全局态。
 * - `window.__mycoVnet` 由 `vnet-forward.ts` 的 `bootVnetForwards()` 安装；壳还没起
 *   的时候（首屏/冷启动）退回读 localStorage 的同一份配置。
 * - 复制失败回退 `document.execCommand('copy')`（老 WebView / 非安全上下文里
 *   `navigator.clipboard` 常常 undefined）。
 */

/** PC 侧目标端口（RDP）。 */
export const RDP_TARGET_PORT = 3389
/** 固定本地口（与 `eval/vnet/manual.md` 映射表同口径：23389）。 */
export const RDP_DEFAULT_LOCAL = 23389
/** 手机端 vnet 配置的 localStorage 键（**与 vnet-forward.ts 同一键**，只读不写）。 */
export const VNET_STORE_KEY = 'myco.vnetForwards'

export interface VnetForward {
  localPort: number
  device: string
  port: number
  label?: string
  enabled?: boolean
}

export interface RdpEndpoint {
  /** 本地固定口（127.0.0.1:<localPort>） */
  localPort: number
  /** 目标设备 DID（PC） */
  device: string
  /** 目标端口（恒 3389） */
  port: number
  label?: string
  enabled: boolean
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * 把任意来源的名单归一成 `VnetForward[]`。
 *
 * 认得的形态（壳各版本/本地配置/未来包装）：
 *   `[{...}]` · `{forwards:[...]}` · `{list:[...]}` · `{items:[...]}` · JSON 字符串
 * 脏数据一律丢弃（不抛），只留 `localPort>0 && port>0` 的条目。
 */
export function normalizeForwards(raw: unknown): VnetForward[] {
  let v: unknown = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return []
    }
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    v = o.forwards ?? o.list ?? o.items ?? o.entries ?? []
  }
  if (!Array.isArray(v)) return []
  const out: VnetForward[] = []
  for (const item of v) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const localPort = num(r.localPort ?? r.local_port)
    const port = num(r.port ?? r.targetPort)
    if (localPort <= 0 || port <= 0) continue
    out.push({
      localPort,
      port,
      device: str(r.device ?? r.deviceDid ?? r.targetDevice),
      label: str(r.label) || undefined,
      enabled: r.enabled === undefined ? true : r.enabled !== false,
    })
  }
  return out
}

/** 本地配置（不 import vnet-forward.ts：那份文件另一个 agent 在途，避免耦合）。 */
export function loadLocalForwards(): VnetForward[] {
  try {
    return normalizeForwards(localStorage.getItem(VNET_STORE_KEY))
  } catch {
    return [] // 隐私模式/存储被禁：当没配置
  }
}

/**
 * 写入/更新一条本地转发（2026-11-11：设备级 vnet 隧道拿到的本地口要落到这里，
 * RDP 卡才认得到地址）。
 *
 * 关键：按 **(device, port)** 唯一——同设备同目标端口只保留**一条**，且以本次传入的
 * localPort 为准。不这么做的后果是真机实测到的：任务卡 env 里写死的 PC 侧口
 * （23389/23911）也在这张表里，于是同一 (device,3389) 出现两个 localPort，
 * `pickRdpForward` 可能挑到手机上没有监听的那个死口。
 */
export function upsertLocalForward(f: VnetForward): boolean {
  try {
    const kept = loadLocalForwards().filter((x) => !(x.port === f.port && sameDevice(x.device, f.device)))
    const label = f.label ?? `${f.port === RDP_TARGET_PORT ? '远程桌面' : '隧道'} 127.0.0.1:${f.localPort}`
    kept.push({ ...f, label, enabled: f.enabled !== false })
    localStorage.setItem(VNET_STORE_KEY, JSON.stringify(kept))
    return true
  } catch {
    return false
  }
}

interface VnetBridge {
  state?: () => unknown
}

/** 壳里的实时态（`window.__mycoVnet.state()`），壳没起时给空。 */
export function loadShellForwards(): VnetForward[] {
  try {
    const w = window as unknown as { __mycoVnet?: VnetBridge }
    const state = w.__mycoVnet?.state
    return typeof state === 'function' ? normalizeForwards(state()) : []
  } catch {
    return []
  }
}

/**
 * 合并两路来源：**壳里的实时态优先**（它能反映"监听起来了没"），本地配置补齐。
 * 按 `localPort` 去重（同口以壳为准）。
 */
export function mergedForwards(): VnetForward[] {
  const seen = new Set<number>()
  const out: VnetForward[] = []
  for (const f of [...loadShellForwards(), ...loadLocalForwards()]) {
    if (seen.has(f.localPort)) continue
    seen.add(f.localPort)
    out.push(f)
  }
  return out
}

/**
 * 挑出 RDP 那条：只认 `port===3389`。
 * 给了 `device` 就优先同设备（任务卡来自哪台 PC 就连哪台），否则第一条。
 * 给了 `localPort` 则强制定向到它（消息里写死的地址）。
 */
export function pickRdpForward(
  list: VnetForward[],
  device?: string,
  localPort?: number,
): RdpEndpoint | null {
  const rdp = list.filter((f) => f.port === RDP_TARGET_PORT)
  const wantLocal = localPort && localPort > 0 ? localPort : 0
  const wantDev = str(device)
  const hit =
    (wantLocal ? rdp.find((f) => f.localPort === wantLocal && (!wantDev || sameDevice(f.device, wantDev))) : undefined) ??
    (wantLocal ? rdp.find((f) => f.localPort === wantLocal) : undefined) ??
    (wantDev ? rdp.find((f) => sameDevice(f.device, wantDev)) : undefined) ??
    rdp[0]
  if (!hit) return null
  return {
    localPort: hit.localPort,
    device: hit.device,
    port: RDP_TARGET_PORT,
    label: hit.label,
    enabled: hit.enabled !== false,
  }
}

/** DID 比较：全等或尾 8 位相同（历史 did 前缀差异/短形态都能认人）。 */
export function sameDevice(a: string, b: string): boolean {
  const x = str(a)
  const y = str(b)
  if (!x || !y) return false
  if (x === y) return true
  return x.length >= 8 && y.length >= 8 && x.slice(-8) === y.slice(-8)
}

/** 唯一允许展示/复制的地址形态：`127.0.0.1:<port>`。 */
export function rdpAddress(localPort: number = RDP_DEFAULT_LOCAL): string {
  const p = localPort > 0 ? Math.floor(localPort) : RDP_DEFAULT_LOCAL
  return `127.0.0.1:${p}`
}

/** `127.0.0.1:23389` → 23389（非法给 0；诊断/单测用）。 */
export function parseAddress(addr: string): number {
  const m = /^127\.0\.0\.1:(\d{1,5})$/.exec(str(addr))
  if (!m) return 0
  const p = Number(m[1])
  return p > 0 && p <= 65535 ? p : 0
}

export interface RdpStatus {
  /** 有没有配好 3389 固定口 */
  configured: boolean
  /** 配置是否启用（vnet-forward 的 enabled 字段） */
  enabled: boolean
  /** 地址串（未配置时给默认口，便于"先把地址复制走"） */
  address: string
  /** 目标设备 DID（可能为空） */
  device: string
  /** 来源：壳实时态 / 本地配置 / 都没有 */
  source: 'state' | 'local' | 'none'
  label?: string
}

/**
 * 卡片要显示的状态（纯函数）：`configured=false` 时卡片通常不渲染（见组件）。
 * `source` 只用于诊断文案（"壳已连上"/"仅配置"）。
 */
export function rdpStatus(device?: string, localPort?: number): RdpStatus {
  const shell = loadShellForwards()
  const local = loadLocalForwards()
  const ep = pickRdpForward([...shell, ...local], device, localPort)
  if (!ep) {
    return {
      configured: false,
      enabled: false,
      address: rdpAddress(localPort),
      device: str(device),
      source: 'none',
    }
  }
  const inShell = shell.some((f) => f.localPort === ep.localPort && f.port === RDP_TARGET_PORT)
  return {
    configured: true,
    enabled: ep.enabled,
    address: rdpAddress(ep.localPort),
    device: ep.device,
    source: inShell ? 'state' : 'local',
    label: ep.label,
  }
}

/**
 * 复制到剪贴板：`navigator.clipboard.writeText` 优先，失败（非安全上下文/权限被拒/
 * 老 WebView 没这个 API）回退 `document.execCommand('copy')`。返回是否成功。
 */
export async function copyText(text: string): Promise<boolean> {
  const t = String(text ?? '')
  if (!t) return false
  try {
    const nav = navigator as Navigator & { clipboard?: Clipboard }
    if (nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      await nav.clipboard.writeText(t)
      return true
    }
  } catch {
    /* 落到 execCommand 兜底 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = t
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.left = '0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, t.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

interface RdpShell {
  /** 由壳（MainActivity）实现：用系统远程桌面 App 打开该地址。 */
  openRdp?: (address: string, device?: string) => unknown
}

/**
 * 桥是否就位——**只有壳实现了才显示「用远程桌面打开」**。
 * （桥由并行 agent 在 MainActivity 里加；在那之前按钮不出现，避免点了没反应。）
 */
export function hasRdpBridge(): boolean {
  try {
    const w = window as unknown as { MycoShell?: RdpShell }
    return typeof w.MycoShell?.openRdp === 'function'
  } catch {
    return false
  }
}

/** 经壳打开远程桌面；桥不在/抛错都返回 false（调用方给降级文案）。 */
export function openRdpViaShell(address: string, device?: string): boolean {
  try {
    const w = window as unknown as { MycoShell?: RdpShell }
    const fn = w.MycoShell?.openRdp
    if (typeof fn !== 'function') return false
    fn(address, device)
    return true
  } catch {
    return false
  }
}
