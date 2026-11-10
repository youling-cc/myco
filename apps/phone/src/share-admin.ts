/**
 * share-admin.ts — 手机（主设备的授权设备）远程管理分享权限（2026-10-18）
 *
 * 用户需求：手机作为主设备的授权设备，也能打开「权限设置」页面，给同 youling 账号
 * 设备分享的任务卡改权限（可见范围 / 每人能力 / 每人可见范围 / 邀请 / 收回）——与 PC 配置页等价。
 *
 * 通道：与「点卡就进」完全同一条 P2P 控制消息底座（`share-entry-*`）：
 *   `share-admin-request`（B=手机 → A=分享所在的主设备，设备签名 + 同步回程）
 *   → 主设备校验「设备属于该账号 + 同账号 + 分享在注册表」→ 改配置 → 回
 *   `share-admin-grant`（在同一个 HTTP 响应体的 `reply` 里带回来）。
 *
 * 手机上只做**薄客户端**：所有授权语义/校验都在主设备执行（单一事实源，不复制规则）。
 *
 * 2026-10-18 第二轮契约（主设备侧同步实现）：
 *   · visibility 新增 `projectCwd: string|null`（null = 沿用分享自身 cwd）；
 *   · op `get` 的 data 新增 `workspaces:[{value,label}]`、`share.cwd`、`share.projectCwd`；
 *   · op `visibility` 支持 `{visibility, did?}`：带 did = 改该人的逐人覆盖；
 *     `visibility:null` + did = 清除覆盖恢复「跟随整体」（老主设备也支持）。
 */
import { p2pDeliverWithReply } from './p2p'
import { entryControlEnvelope, newControlMsgId } from './share-entry'
import { currentIdentity, getRootIdentity, getAttestation, currentYoulingName } from './identity'

/** 卡片坐标（`taskShareCardOf` 的返回形状）。 */
export interface ShareAdminCard {
  shareId: string
  sourceDevice: string
  sourceAccount: string
  sourceDeviceName?: string
  title?: string
}

/** 可见范围（任务级 / 逐人覆盖共用；`projectCwd` 只对 space=project 有意义）。 */
export interface ShareAdminVisibility {
  space?: 'machine' | 'project' | 'session'
  sessions?: string[]
  windowMs?: number | null
  /** 项目档的项目目录；null/缺省 = 沿用分享自身 cwd（2026-10-18 新增契约字段） */
  projectCwd?: string | null
}

/** 可选项目（主设备从 DSH 会话 cwd 派生：`value`=目录全路径，`label`=人话名）。 */
export interface ShareAdminWorkspace {
  value: string
  label: string
}

/** 分享自身信息（op get 的 `share`；`cwd`/`projectCwd` 为 2026-10-18 新增）。 */
export interface ShareAdminShare {
  shareId: string
  title?: string
  granularity?: string
  sessionId?: string
  /** 分享绑定会话的工作目录 */
  cwd?: string
  /** 生效项目目录（缺省 = 分享自身 cwd） */
  projectCwd?: string | null
}

export interface ShareAdminCollaborator {
  did: string
  name?: string
  isOwner?: boolean
  caps?: Partial<Record<CapKey, boolean>>
  canReshare?: boolean
  /** 生效可见范围（主设备已和整体取交；老主设备也发这个字段） */
  visibility?: ShareAdminVisibility | null
  /** 逐人**原始覆盖**（新主设备若给）：null = 跟随整体。优先据此判断「是否单独收窄过」 */
  visibilityOverride?: ShareAdminVisibility | null
}

export interface ShareAdminSession {
  sessionId: string
  label: string
}

export interface ShareAdminData {
  collaborators?: ShareAdminCollaborator[]
  visibility?: ShareAdminVisibility
  share?: ShareAdminShare
  sessions?: ShareAdminSession[]
  /** 可选项目清单（op get 新增；老主设备没有 → UI 降级提示） */
  workspaces?: ShareAdminWorkspace[]
  /** 兜底：有的主设备把项目清单放在 visibility schema 的 workspaces.items 里 */
  schema?: { workspaces?: { items?: ShareAdminWorkspace[] } | null } | null
  /** 任务级声明的能力（只有这些能逐人开关；缺省=四项都可试） */
  availableCaps?: CapKey[]
  /** 2026-10-24：任务级能力面当前 id 清单（能看什么 / 能做什么）——手机弹层编辑用 */
  capsO?: CapKey[]
  capsA?: CapKey[]
  total?: number
  truncated?: boolean
  error?: string | null
}

export type ShareAdminOp = 'get' | 'grantCaps' | 'visibility' | 'caps' | 'invite' | 'revoke' | 'revokeAll'

export type CapKey = 'session.read' | 'session.input' | 'agent.view' | 'scope.switch' | 'model.select'

/** 四个固定能力 → 人话标签（与 PC 配置页同一套说法）。 */
export const CAP_ROWS: { key: CapKey; label: string }[] = [
  { key: 'session.read', label: '看会话内容' },
  { key: 'session.input', label: '输入内容' },
  { key: 'agent.view', label: '看子 agent' },
  { key: 'scope.switch', label: '切换已授权的会话 / 工作区' },
  { key: 'model.select', label: '切换模型' },
]

export const CAP_KEYS: CapKey[] = CAP_ROWS.map((r) => r.key)

/** caps 归一：缺字段=关（宁可少给，不可默认给）；owner 恒真。 */
export function readCaps(c?: Partial<Record<CapKey, boolean>>, isOwner = false): Record<CapKey, boolean> {
  const out = {} as Record<CapKey, boolean>
  for (const k of CAP_KEYS) out[k] = isOwner ? true : c?.[k] === true
  return out
}

/** 一句人话摘要：这个人能做什么。 */
export function capsSummary(caps: Record<CapKey, boolean>): string {
  const parts: string[] = []
  if (caps['session.read']) parts.push('看内容')
  if (caps['session.input']) parts.push('能发言')
  if (caps['agent.view']) parts.push('看子 agent')
  if (caps['scope.switch']) parts.push('切会话')
  if (caps['model.select']) parts.push('切模型')
  return parts.length ? parts.join(' · ') : '还不能看'
}

/**
 * 可见范围人话。
 * @param projectLabel 项目档的短名（如 `AOP/myco`）——有则显示「只这个项目（AOP/myco）」
 */
export function visSummary(v?: ShareAdminVisibility, projectLabel?: string): string {
  const docs: Record<string, string> = { machine: '我的全部（整机）', project: '只这个项目', session: '只指定会话' }
  const space = v?.space ?? 'machine'
  let base = docs[space] || docs.machine
  if (space === 'project' && projectLabel) base = `只这个项目（${projectLabel}）`
  const n = Array.isArray(v?.sessions) ? v.sessions.length : 0
  const win = v?.windowMs
    ? ` · 近 ${v.windowMs >= 86400000 ? Math.round(v.windowMs / 86400000) + ' 天' : Math.max(1, Math.round(v.windowMs / 3600000)) + ' 小时'}`
    : ''
  return (space === 'session' && n > 0 ? `${base}（${n} 个）` : base) + win
}

// ── 项目档 / 逐人可见范围的小工具（纯函数，形状异常一律降级不抛错） ──

/** 路径拆段（`/`、`\` 都算分隔符；盘符 `D:` 不算目录名）。 */
function pathSegments(cwd?: string | null): string[] {
  return String(cwd ?? '')
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^[A-Za-z]:$/.test(s))
}

/** 路径 → 「父目录/项目名」短名（如 `D:\Projects\AOP\myco` → `AOP/myco`）——手机 chip 用。 */
export function projectShortName(cwd?: string | null): string {
  const parts = pathSegments(cwd)
  return parts.slice(Math.max(0, parts.length - 2)).join('/')
}

/** 路径尾（最多 3 段，超长前缀 `…/`）——项目选择行的第二行小字。 */
export function projectPathTail(cwd?: string | null): string {
  const parts = pathSegments(cwd)
  if (parts.length === 0) return ''
  const tail = parts.slice(Math.max(0, parts.length - 3)).join('/')
  return parts.length > 3 ? `…/${tail}` : tail
}

/** 项目路径同一判定（Windows 不区分大小写；分隔符/尾斜杠归一）。 */
export function sameProjectPath(a?: string | null, b?: string | null): boolean {
  const norm = (p?: string | null) => String(p ?? '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const x = norm(a)
  return !!x && x === norm(b)
}

/** 当前生效项目目录：visibility.projectCwd → share.projectCwd（生效值）→ share.cwd。 */
export function effectiveProjectCwd(data?: ShareAdminData | null): string {
  const c = data?.visibility?.projectCwd ?? data?.share?.projectCwd ?? data?.share?.cwd ?? ''
  return typeof c === 'string' ? c.trim() : ''
}

/**
 * op get 的项目清单（去重、宽松解析：元素不是 `{value,label}` 就跳过）。
 * 兼容两种来源：顶层 `workspaces`（新契约）与 visibility schema 的 `workspaces.items`。
 */
export function listWorkspaces(data?: ShareAdminData | null): ShareAdminWorkspace[] {
  const out: ShareAdminWorkspace[] = []
  const seen = new Set<string>()
  const push = (arr: unknown) => {
    if (!Array.isArray(arr)) return
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object') continue
      const o = raw as Record<string, unknown>
      const value = typeof o.value === 'string' ? o.value.trim() : ''
      if (!value) continue
      const key = value.replace(/[\\/]+$/, '').toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : projectShortName(value)
      out.push({ value, label })
    }
  }
  push(data?.workspaces)
  push(data?.schema?.workspaces?.items)
  return out
}

/** 可见范围宽松归一（形状异常 → 默认值；用于比较/展示，绝不抛错）。 */
function normalizeVisibility(v?: ShareAdminVisibility | null): ShareAdminVisibility | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const space: ShareAdminVisibility['space'] = v.space === 'project' || v.space === 'session' ? v.space : 'machine'
  const sessions = Array.isArray(v.sessions)
    ? v.sessions.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim())
    : []
  const windowMs = typeof v.windowMs === 'number' && Number.isFinite(v.windowMs) && v.windowMs > 0 ? v.windowMs : null
  const projectCwd = typeof v.projectCwd === 'string' && v.projectCwd.trim() ? v.projectCwd.trim() : null
  return { space, sessions, windowMs, projectCwd }
}

/**
 * 两个可见范围在**会话面**是否等价（space/sessions/windowMs）。
 * `projectCwd` 刻意不参与：主设备可能把生效项目路径补进逐人生效值，拿它比较会误判「有覆盖」。
 */
function sameVisibilityCore(a?: ShareAdminVisibility | null, b?: ShareAdminVisibility | null): boolean {
  const fallback: ShareAdminVisibility = { space: 'machine', sessions: [], windowMs: null, projectCwd: null }
  const x = normalizeVisibility(a) ?? fallback
  const y = normalizeVisibility(b) ?? fallback
  if (x.space !== y.space) return false
  if ((x.windowMs ?? null) !== (y.windowMs ?? null)) return false
  const xs = [...(x.sessions ?? [])].sort()
  const ys = [...(y.sessions ?? [])].sort()
  return xs.length === ys.length && xs.every((s, i) => s === ys[i])
}

/**
 * 某个协作者的「逐人覆盖」可见范围（null = 跟随整体）。
 *
 * 优先用新主设备的原始字段 `visibilityOverride`；老主设备只有生效值 `visibility`：
 * 逐人只能**收紧**，所以「生效值 ≠ 整体可见范围」就说明这个人单独收窄过。
 */
export function personOverride(c: ShareAdminCollaborator, overall?: ShareAdminVisibility): ShareAdminVisibility | null {
  if (Object.prototype.hasOwnProperty.call(c, 'visibilityOverride')) return normalizeVisibility(c.visibilityOverride)
  const eff = normalizeVisibility(c.visibility)
  if (!eff) return null
  return sameVisibilityCore(eff, overall) ? null : eff
}

function nowMs(): number {
  return Date.now()
}

/**
 * 等主设备回包的硬超时（ms，2026-10-27 task-42 真机 P0）：读操作 8-12s 内必须有结果。
 *
 * 真机 RED：手机打开「权限设置」后只打印 `send` 没有 `resp`、PC audit 0 事件、UI 永久
 * 「正在从主设备读取权限…」。根因是底层 `p2pDeliverWithReply` 的第一步 presence 查询
 * （identity-svc fetch 无超时）可能永久挂起。这里在**上层调用链**再加一道 Promise.race。
 */
export const SHARE_ADMIN_REPLY_TIMEOUT_MS = 10_000
/** 写操作（caps/visibility/invite/revoke…）：底层 p2p 总超时 15s，上层必须等过它；
 * 超时文案必须说「结果未确认」——请求可能已送达并落库，不能诱导用户连续重复写。 */
export const SHARE_ADMIN_WRITE_REPLY_TIMEOUT_MS = 16_000
function shareAdminTimeoutMs(op: ShareAdminOp): number {
  return op === 'get' ? SHARE_ADMIN_REPLY_TIMEOUT_MS : SHARE_ADMIN_WRITE_REPLY_TIMEOUT_MS
}

/**
 * 发一条 `share-admin-request` 并等主设备回执；失败一律 throw（人话）。
 * @param card 卡片坐标（shareId/sourceAccount/sourceDevice）
 * @param op   操作名
 * @param params 各 op 的入参（did/caps/visibility/label/...）
 */
export async function shareAdminRequest<T extends ShareAdminData | Record<string, unknown> = ShareAdminData>(
  card: ShareAdminCard,
  op: ShareAdminOp,
  params: Record<string, unknown> = {},
): Promise<T> {
  const account = getRootIdentity() ?? getAttestation()?.rootDid ?? currentIdentity()?.did ?? ''
  const device = currentIdentity()?.did ?? ''
  if (!account || !device) throw new Error('账号/设备身份还没就绪，稍后再试')
  const now = nowMs()
  const requestId = `adm-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const payload: Record<string, unknown> = { requestId, requesterDevice: device, op, syncReply: true, shareId: card.shareId, ...params }
  const env = entryControlEnvelope(
    { account, device, name: currentYoulingName() || '我', deviceName: 'myco-phone' },
    card.sourceAccount,
    'share-admin-request',
    payload,
    newControlMsgId(now),
    now,
  )
  console.log('[share-admin] send op=' + op + ' share=' + card.shareId + ' toAcc=' + card.sourceAccount + ' toDev=' + card.sourceDevice)
  const t0 = nowMs()
  const timeoutMs = shareAdminTimeoutMs(op)
  const isWrite = op !== 'get'
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let resp: Record<string, unknown> | null
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        resolve(null)
      }, timeoutMs)
    })
    resp = await Promise.race([p2pDeliverWithReply(card.sourceAccount, env, card.sourceDevice), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
  const elapsed = nowMs() - t0
  if (timedOut) {
    console.warn(`[share-admin] timeout ${elapsed}ms op=${op} share=${card.shareId}`)
    if (isWrite) {
      throw new Error(`主设备没回包（等待 ${Math.round(timeoutMs / 1000)} 秒超时）——这次修改的结果未确认，请求可能还在路上或已生效；请稍后重新打开权限面板查看，不要连续重复保存`)
    }
    throw new Error(`主设备没回包（等待 ${Math.round(timeoutMs / 1000)} 秒超时）——权限还在主设备上；请确认主设备 myco 在线、网络正常，然后点「重试」`)
  }
  console.log('[share-admin] resp=' + JSON.stringify(resp === null ? null : { keys: Object.keys(resp), hasReply: !!resp.reply, replyOk: !!(resp.reply as { ok?: boolean } | undefined)?.ok }) + ' elapsed=' + elapsed + 'ms')
  if (!resp) throw new Error('主设备没回包（可能不在线或连接断了），稍后再试')
  const reply = resp.reply
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
    throw new Error('主设备没有回执（它可能是旧版本），请先在主设备上升级 myco')
  }
  const r = reply as Record<string, unknown>
  if (!r.ok) throw new Error(String(r.error || '主设备拒绝了这次操作'))
  return (r.data ?? {}) as T
}

/** 整页数据（协作者 + 可见范围 + 可选会话/项目清单）。 */
export function shareAdminGet(card: ShareAdminCard): Promise<ShareAdminData> {
  return shareAdminRequest<ShareAdminData>(card, 'get')
}

/** 改任务级能力面（能看什么 / 能做什么；立即生效，2026-10-24 用户需求）。 */
export function shareAdminSetFaceCaps(
  card: ShareAdminCard,
  capsO: CapKey[],
  capsA: CapKey[],
): Promise<ShareAdminData> {
  return shareAdminRequest<ShareAdminData>(card, 'caps', { capsO, capsA })
}

/** 改某个人的四项能力（立即生效）。 */
export function shareAdminSetCaps(
  card: ShareAdminCard,
  did: string,
  caps: Record<CapKey, boolean>,
): Promise<ShareAdminData> {
  return shareAdminRequest<ShareAdminData>(card, 'grantCaps', { did, caps })
}

/**
 * 改可见范围（立即生效）。
 *
 * · 只传 `visibility` = 改**任务级**可见范围（整机/项目/指定会话 + 历史窗 + projectCwd）；
 * · 传 `did` = 改**该人的逐人覆盖**；
 * · `visibility:null` + `did` = 清除逐人覆盖、恢复「跟随整体」（任务级的 null 无意义，主设备会拒）。
 *
 * 兼容老调用：`shareAdminSetVisibility(card, visibility)` 仍是任务级写入。
 */
export function shareAdminSetVisibility(
  card: ShareAdminCard,
  visibility: ShareAdminVisibility | null,
  did?: string,
): Promise<ShareAdminData> {
  const params: Record<string, unknown> = { visibility }
  const d = (did ?? '').trim()
  if (d) params.did = d
  return shareAdminRequest<ShareAdminData>(card, 'visibility', params)
}

/** 邀请：给 did = 直接授权；不给 did = 签发 bearer 链接。 */
export async function shareAdminInvite(
  card: ShareAdminCard,
  label: string,
  opts: { did?: string; caps?: Record<CapKey, boolean> } = {},
): Promise<{ url?: string; label?: string }> {
  const data = await shareAdminRequest<ShareAdminData & { invited?: { url?: string; label?: string } }>(card, 'invite', {
    label,
    did: opts.did,
    caps: opts.caps,
  })
  return data.invited ?? {}
}

/** 收回某个人的授权（不删任务卡）。 */
export function shareAdminRevoke(card: ShareAdminCard, label: string): Promise<ShareAdminData> {
  return shareAdminRequest<ShareAdminData>(card, 'revoke', { label })
}

/** 全部停止授权（保留分享与卡片）。 */
export function shareAdminRevokeAll(card: ShareAdminCard): Promise<ShareAdminData> {
  return shareAdminRequest<ShareAdminData>(card, 'revokeAll')
}
