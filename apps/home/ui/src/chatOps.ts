/* chatOps.ts — PC 聊天 UI 全量打磨（批三）纯函数集：会话列表微信化/时间体系/
 * 撤回/引用/通知内容构造/置顶免打扰持久化/头像散列取色。全部不碰 DOM/网络，
 * 单测在 chatOps.test.ts（与 presence.ts 同惯例：逻辑抽出可测）。 */

import type { ChatMsg } from './ChatBubble'
import { dispNameOf, shortDid } from './ChatBubble'

/* ── 会话行（chat_state convs 的形态；unreadN 是批三新增的计数） ── */
export interface ConvRow {
  id: string
  kind: 'friend' | 'group'
  title: string
  lastTs: number
  lastText: string
  unread?: boolean
  unreadN?: number
  /** 2026-10-20 小灵官方通知会话（Rust conv_state 标；UI 输入区只读） */
  official?: boolean
}

/* ═══ 会话列表行内时间（微信语义：今天时分/昨天/星期x/同年内 M月D日/跨年全日期） ═══ */
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六']
export function fmtConvTime(ts?: number, now: Date = new Date()): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  const p2 = (n: number) => String(n).padStart(2, '0')
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  const day0 = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((day0(now) - day0(d)) / 86400e3)
  if (diffDays <= 0) return hm
  if (diffDays === 1) return '昨天'
  if (diffDays < 7) return `星期${WEEK_CN[d.getDay()]}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/* ═══ 未读角标数字化（>99 显 99+；0/undefined 显空） ═══ */
export function unreadBadge(n?: number): string {
  const v = n ?? 0
  if (v <= 0) return ''
  return v > 99 ? '99+' : String(v)
}

/* ═══ 置顶/免打扰（本地存储持久化；pin 值=置顶时刻，新的更前） ═══ */
export interface ConvPref { pin?: number; mute?: boolean }
const PREFS_KEY = 'myco-conv-prefs'

export function loadConvPrefs(store: Pick<Storage, 'getItem'> | null = safeLocal()): Record<string, ConvPref> {
  try { return JSON.parse(store?.getItem(PREFS_KEY) || '{}') as Record<string, ConvPref> } catch { return {} }
}
export function saveConvPrefs(p: Record<string, ConvPref>, store: Pick<Storage, 'setItem'> | null = safeLocal()): void {
  try { store?.setItem(PREFS_KEY, JSON.stringify(p)) } catch { /* 容错 */ }
}
function safeLocal(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null }
}

/** 会话排序（微信语义）：置顶在前（按置顶时刻新→旧），其余按 lastTs 新→旧；同键稳定。 */
export function sortConvs<T extends ConvRow>(convs: readonly T[], prefs: Record<string, ConvPref>): T[] {
  return convs
    .map((c, i) => ({ c, i, pin: prefs[c.id]?.pin ?? 0 }))
    .sort((a, b) => {
      if (a.pin !== b.pin) return b.pin - a.pin // 置顶块在前，块内新置顶更前
      if (a.c.lastTs !== b.c.lastTs) return b.c.lastTs - a.c.lastTs
      return a.i - b.i
    })
    .map((x) => x.c)
}

/** 总未读数（免打扰会话不计入总数——微信语义；其行内只显红点）。 */
export function totalUnread(convs: readonly ConvRow[], prefs: Record<string, ConvPref>): number {
  return convs.reduce((a, c) => a + (prefs[c.id]?.mute ? 0 : (c.unreadN ?? (c.unread ? 1 : 0))), 0)
}

/* ═══ 时间体系：5 分钟合并 + 居中时间条 + 跨天日期分隔 + 未读分割线 ═══ */

export const MERGE_GAP_MS = 5 * 60_000

export type TLItem =
  | { t: 'time'; key: string; label: string }   // >5min 断开（同日）→ "HH:mm"
  | { t: 'date'; key: string; label: string }   // 跨天 → "9月29日"（跨年带年）
  | { t: 'unread'; key: string }                // "以下为新消息"
  | { t: 'msg'; key: string; m: ChatMsg; merged: boolean }

const SYS_KINDS = new Set(['sys', 'task-accept', 'task-done', 'task-rename', 'recalled'])

function dateLabel(d: Date, now: Date): string {
  const p2 = (n: number) => n
  return d.getFullYear() === now.getFullYear()
    ? `${p2(d.getMonth() + 1)}月${p2(d.getDate())}日`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

/** 渲染序列构造（微信时间语义）：
 *  ① 首条前：非今天先日期条；然后总有时间条（HH:mm）。
 *  ② 相邻 gap > 5min → 时间条；跨天（本地日变化）→ 日期条。
 *  ③ merged=与上一条同人同向 5min 窗内（系统条恒不 merge 也不被 merge）。
 *  ④ firstUnreadMsgId 锚：该消息前插一次"以下为新消息"分割线。 */
export function buildTimeline(msgs: readonly ChatMsg[], opts: { firstUnreadMsgId?: string; now?: Date } = {}): TLItem[] {
  const now = opts.now ?? new Date()
  const out: TLItem[] = []
  let prev: ChatMsg | null = null
  let unreadDone = false
  const dayOf = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` }
  for (const m of msgs) {
    const key0 = m.msgId || `ts-${m.ts}`
    if (!unreadDone && opts.firstUnreadMsgId && m.msgId === opts.firstUnreadMsgId) {
      out.push({ t: 'unread', key: `unread-${key0}` })
      unreadDone = true
    }
    const d = new Date(m.ts)
    const p2 = (n: number) => String(n).padStart(2, '0')
    let broke = false
    if (!prev) {
      if (dayOf(m.ts) !== dayOf(now.getTime())) out.push({ t: 'date', key: `date-${key0}`, label: dateLabel(d, now) })
      out.push({ t: 'time', key: `time-${key0}`, label: `${p2(d.getHours())}:${p2(d.getMinutes())}` })
      broke = true
    } else {
      if (dayOf(m.ts) !== dayOf(prev.ts)) {
        out.push({ t: 'date', key: `date-${key0}`, label: dateLabel(d, now) })
        out.push({ t: 'time', key: `time-${key0}`, label: `${p2(d.getHours())}:${p2(d.getMinutes())}` })
        broke = true
      } else if (m.ts - prev.ts > MERGE_GAP_MS) {
        out.push({ t: 'time', key: `time-${key0}`, label: `${p2(d.getHours())}:${p2(d.getMinutes())}` })
        broke = true
      }
    }
    const merged = !broke && !!prev
      && !SYS_KINDS.has(prev.kind) && !SYS_KINDS.has(m.kind)
      && prev.dir === m.dir && prev.fromName === m.fromName && prev.from === m.from
      // 设备群（2026-10-07 设计 §3 决策D）：同账号多设备 from 恒同——连续消息归并
      // 追加 fromDevice 判等，否则不同设备的消息共享署名行（谁说的分不清）。
      && prev.fromDevice === m.fromDevice
    out.push({ t: 'msg', key: key0, m, merged })
    prev = m
  }
  return out
}

/* ═══ 消息文本提取（复制/引用摘要/通知预览共用口径） ═══ */
export function msgCopyText(m: ChatMsg): string {
  const p = (m.payload ?? {}) as { text?: string; name?: string; title?: string }
  switch (m.kind) {
    case 'text':
    case 'group-msg': return (p.text ?? '').trim()
    case 'image': return '[图片]'
    case 'file': return `[文件] ${p.name ?? ''}`.trim()
    case 'task-share': return `[任务卡] ${p.title ?? ''}`.trim()
    // 2026-10-11 任务卡改名留痕条（系统条不挂菜单——这里是复制/引用摘要的兜底口径）
    case 'task-rename': return `✏️ 任务卡改名为「${p.title ?? ''}」`.trim()
    case 'sys': return (p.text ?? '').trim()
    case 'recalled': return ''
    default: return (p.text ?? '').trim()
  }
}

/* ═══ 撤回判定（限时 2 分钟；只能撤自己发的正文类消息） ═══ */
export const RECALL_WINDOW_MS = 120_000
export function canRecall(m: ChatMsg, now: number = Date.now()): boolean {
  if (m.dir !== 'out') return false
  if (SYS_KINDS.has(m.kind)) return false
  if (m.sendState === 'sending') return false // 未发出的不存在"撤回"（对方没收到）
  return now - m.ts <= RECALL_WINDOW_MS
}

/* ═══ 引用回复摘要行（"名字: 内容截 30"） ═══ */
export function quoteLine(m: ChatMsg, friends: { did: string; name?: string }[], max = 30): string {
  const name = m.dir === 'out' ? '我' : (shortDid(m.fromName || '') || dispNameOf(m.from, friends))
  const body = msgCopyText(m)
  const cut = body.length > max ? `${body.slice(0, max)}…` : body
  return `${name}: ${cut}`
}

/** payload 里的引用锚（发送时写入 replyTo；渲染时取出一行摘要 + 跳转锚）。 */
export interface ReplyAnchor { msgId: string; name: string; text: string }
export function replyAnchorOf(m: ChatMsg): ReplyAnchor | null {
  const r = (m.payload as { replyTo?: { msgId?: unknown; name?: unknown; text?: unknown } })?.replyTo
  if (!r || typeof r.msgId !== 'string' || !r.msgId) return null
  return {
    msgId: r.msgId,
    name: typeof r.name === 'string' ? r.name : '',
    text: typeof r.text === 'string' ? r.text : '',
  }
}
export function makeReplyAnchor(m: ChatMsg, friends: { did: string; name?: string }[]): ReplyAnchor {
  const name = m.dir === 'out' ? '我' : (shortDid(m.fromName || '') || dispNameOf(m.from, friends))
  const body = msgCopyText(m)
  return { msgId: m.msgId, name, text: body.length > 60 ? `${body.slice(0, 60)}…` : body }
}

/* ═══ 系统通知内容构造（标题=发送者昵称；正文=预览截 60 字；群=群名+"发送者: 预览"） ═══ */
export function notifBody(preview: string, max = 60): string {
  const t = (preview || '').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}
export function chatNotifContent(conv: Pick<ConvRow, 'kind' | 'title' | 'lastText'>, fromName?: string): { title: string; body: string } {
  const prev = notifBody(conv.lastText)
  if (conv.kind === 'group') {
    return { title: shortDid(conv.title) || '群聊', body: fromName ? `${shortDid(fromName)}: ${prev}` : prev }
  }
  return { title: shortDid(conv.title) || '新消息', body: prev }
}

/* ═══ 头像散列取色（与手机 SessionList avaColor 同 palette 同算法——三处统一的权威） ═══ */
const AVA_COLORS: readonly (readonly [string, string])[] = [
  ['#6b7bff', '#5567f5'], ['#4ec9a5', '#2fbf71'], ['#f5a623', '#e8890c'],
  ['#8f7bff', '#6f5bf0'], ['#ff8a7a', '#ff5a52'], ['#4fc3e8', '#2aa5d6'],
]
export function avaColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  const [a, b] = AVA_COLORS[h % AVA_COLORS.length]
  return `linear-gradient(135deg,${a},${b})`
}

/* ═══ 草稿预览标记（好友行预览 [草稿] 红标） ═══ */
export function draftPreview(draft: string | undefined): string {
  const t = (draft ?? '').trim()
  if (!t) return ''
  return t.length > 20 ? `${t.slice(0, 20)}…` : t
}

/* ═══ 菜单定位 clamp（2026-09-29 实测修法：右键菜单不出窗、贴边翻转、不引滚动条） ═══ */
export interface MenuPos { x: number; y: number }

/** 右键菜单定位：默认光标右下展开；贴右边→翻到光标左侧、贴底边→翻到光标上方；
 *  二次 clamp 到 [pad, win-menu-pad]（菜单比窗口还大时退化为贴 pad 边，保证可见可操作）。
 *  纯函数——窗口/菜单实测尺寸由调用方注入（CtxMenu 用 getBoundingClientRect 量真实宽高）。 */
export function clampMenuPos(x: number, y: number, menuW: number, menuH: number, winW: number, winH: number, pad = 4): MenuPos {
  let nx = x
  let ny = y
  if (nx + menuW > winW - pad) nx = x - menuW // 右贴边→翻左
  if (ny + menuH > winH - pad) ny = y - menuH // 底贴边→翻上
  nx = Math.max(pad, Math.min(nx, Math.max(pad, winW - menuW - pad)))
  ny = Math.max(pad, Math.min(ny, Math.max(pad, winH - menuH - pad)))
  return { x: Math.round(nx), y: Math.round(ny) }
}

/* ═══ 图片查看器缩放/平移状态机（子窗口与窗内兜底 overlay 共用；纯函数可测） ═══ */
export interface ImgViewState { scale: number; tx: number; ty: number }
export const IMG_ZOOM_MIN = 0.5
export const IMG_ZOOM_MAX = 5
/** 初始态：scale=1 = 图片自适应窗口（CSS max-width/max-height 96vw/vh 限定）。 */
export const imgViewInit = (): ImgViewState => ({ scale: 1, tx: 0, ty: 0 })

/** 滚轮缩放（光标锚点不动：光标下的图像素点缩放前后在同一屏幕位置）。
 *  px/py=光标相对容器中心的坐标；deltaY<0=放大；结果 clamp 到 [0.5, 5]。 */
export function imgZoomAt(st: ImgViewState, px: number, py: number, deltaY: number): ImgViewState {
  const next = Math.min(IMG_ZOOM_MAX, Math.max(IMG_ZOOM_MIN, st.scale * Math.pow(1.0015, -deltaY)))
  if (next === st.scale) return st
  const k = next / st.scale
  return { scale: next, tx: px - (px - st.tx) * k, ty: py - (py - st.ty) * k }
}

/** 拖拽平移（dx/dy=鼠标位移增量）。 */
export function imgPanBy(st: ImgViewState, dx: number, dy: number): ImgViewState {
  return { ...st, tx: st.tx + dx, ty: st.ty + dy }
}

/** 双击复位（回自适应）。 */
export const imgViewReset = (): ImgViewState => imgViewInit()

/* ═══ 同步状态条文案（2026-09-29 用户实测立法：纯状态描述，无"可以打字"类操作引导） ═══ */
export const SYNCING_TEXT = '正在同步消息…'

/* ═══ 设备群（2026-10-07 设计 §3 决策F，docs/design/设备群设计.md）：纯逻辑集 ═══
 * 契约（后端 T1 命令，签名见设计 §3 决策F「新命令」；未就绪时 UI 降级不卡聊天）：
 *   chat_device_group_info() -> { groupId, name, devices: [{did,name,online,revoked,isEmbodiment,lastSeen}] }
 * 群档案（chat_state groups）条目加 kind:'device'；会话 id 前缀 grp-dev-（确定性派生）。 */

/** 设备群会话 id 前缀（与 Rust device_group_id 派生约定一致）。 */
export const DEVICE_GROUP_ID_PREFIX = 'grp-dev-'

/** 设备群判定：档案 kind='device' 或 id 按 grp-dev- 前缀派生（双保险，与 Rust
 *  is_device_group 同式——档案未同步/旧字段缺失时前缀兜底）。 */
export function isDeviceGroup(g: { id?: string; kind?: string } | null | undefined): boolean {
  if (!g) return false
  if (g.kind === 'device') return true
  return typeof g.id === 'string' && g.id.startsWith(DEVICE_GROUP_ID_PREFIX)
}

/** chat_device_group_info 返回形态（Rust 未就绪时调用方拿不到 → 传 undefined 走降级）。 */
export interface DeviceGroupInfo {
  groupId?: string
  name?: string
  devices?: { did?: string; name?: string; online?: boolean; revoked?: boolean; isEmbodiment?: boolean; lastSeen?: number }[]
}

/** 设备群计数：总设备数 N / 在线 M（吊销设备不算成员——名册即成员表，决策 C）。 */
export function deviceGroupCounts(info: DeviceGroupInfo | null | undefined): { total: number; online: number } {
  const alive = (info?.devices ?? []).filter((d) => !d?.revoked)
  return { total: alive.length, online: alive.filter((d) => d?.online).length }
}

/** 会话列表行副题：「N 台设备」；名册未取到 → 「本账号设备」（不显示"(1人)"——
 *  设备群 members 恒单账号，人数语义失真）。 */
export function deviceGroupRowSub(info: DeviceGroupInfo | null | undefined): string {
  const { total } = deviceGroupCounts(info)
  return total > 0 ? `${total} 台设备` : '本账号设备'
}

/** 群聊屏头部副题：「📱 设备群 · N 台设备 · M 在线」；名册未取到 → 仅「📱 设备群」。 */
export function deviceGroupHeaderSub(info: DeviceGroupInfo | null | undefined): string {
  const { total, online } = deviceGroupCounts(info)
  if (total <= 0) return '📱 设备群'
  return `📱 设备群 · ${total} 台设备 · ${online} 在线`
}

/** 群管理入口可见性：设备群=系统群，治理锁死（决策 D.4），⚙️ 不渲染、群管理屏不进。 */
export function showGroupManageEntry(g: { id?: string; kind?: string; status?: string; ownerPending?: boolean } | null | undefined): boolean {
  if (!g) return false
  if (g.status === 'disbanded' || g.status === 'kicked') return false // 终态只读（既有行为）
  return !isDeviceGroup(g)
}

/** 首见自动置顶种子（决策 F.2）：设备群会话首次出现在会话列表且 prefs 里**没有该
 *  会话键**（≠"没置顶"——用户取消置顶后键仍在，pin:undefined）→ 写入 pin。
 *  一次性、尊重用户：种过/用户动过就不再种。纯函数——UI 侧 effect 周期调用。 */
export function seedDeviceGroupPins(
  convs: readonly ConvRow[],
  groups: readonly { id: string; kind?: string }[],
  prefs: Record<string, ConvPref>,
  now: number,
): { next: Record<string, ConvPref>; changed: boolean } {
  let next: Record<string, ConvPref> | null = null
  for (const g of groups) {
    if (!isDeviceGroup(g)) continue
    if (g.id in prefs) continue // 键存在=种过或用户动过——不再种
    if (!convs.some((c) => c.id === g.id)) continue // 会话还没出现（ensure 未落档）——等下轮
    if (!next) next = { ...prefs }
    next[g.id] = { ...(prefs[g.id] ?? {}), pin: now }
  }
  return { next: next ?? prefs, changed: !!next }
}
