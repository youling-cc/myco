/**
 * 成员设备（非分享源）权限面板的**只读/角色摘要**纯函数（task-43）。
 *
 * 背景：2026-10-27 设备级 P/A 后，同账号其他设备（笔记本/手机）的 myRole 仍是 owner，
 * 但实际是 owner_device（受任务/设备策略限制、高风险 A 默认关）。旧 UI 直接把 owner
 * 翻译成「我的（全权）」，并允许成员设备面板渲染邀请/停止授权/停止分享——误导且可点。
 *
 * 本模块只做 fail-closed 判定与话术，不实现设备级编辑面（P2 另做）。
 * 判定口径：**只有分享源设备（非 remoteOrigin）才可编辑**；成员设备一律只读快照。
 */

export interface MemberCardLike {
  myRole?: string
  /** true = 这张卡是别的设备同步过来的（本机没有对应分享实例） */
  remoteOrigin?: boolean
  grant?: { role?: string; ro?: boolean; caps?: Record<string, boolean> } | null
  shareSnapshot?: { caps?: { o?: { id?: string }[]; a?: { id?: string }[] } } | null
}

export const MEMBER_DEVICE_LIMIT = '受任务/设备策略限制'

/** 是否是**成员设备**上的卡（分享源不在本机）——成员设备面板只读。 */
export function isMemberDeviceCard(t: MemberCardLike): boolean {
  return !!t.remoteOrigin
}

/** 是否允许在面板里改权限/可见范围（fail-closed：只有分享源设备可改）。 */
export function canEditPermissionPanel(t: MemberCardLike): boolean {
  return !isMemberDeviceCard(t)
}

function snapshotCapIds(t: MemberCardLike): string[] {
  const caps = t.shareSnapshot?.caps
  if (!caps) return []
  return [...(caps.o ?? []), ...(caps.a ?? [])]
    .map((x) => x?.id)
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
}

function memberHasCap(t: MemberCardLike, id: string): boolean {
  const g = t.grant
  if (g?.caps) return g.caps[id] === true
  return snapshotCapIds(t).includes(id)
}

/**
 * 成员设备的「我在这张卡上的权限」一句话——**绝不说全权**：
 *   · grant.ro → 我的设备 · 只读 · 受任务/设备策略限制
 *   · 有 session.input → 我的设备 · 可输入 · 受任务/设备策略限制
 *   · 有 session.read → 我的设备 · 只读 · 受任务/设备策略限制
 *   · 无任何信息 → 我的设备 · 受任务/设备策略限制（不猜全权）
 */
export function memberPermHint(t: MemberCardLike): string {
  const g = t.grant
  if (g?.ro) return `我的设备 · 只读 · ${MEMBER_DEVICE_LIMIT}`
  if (memberHasCap(t, 'session.input')) return `我的设备 · 可输入 · ${MEMBER_DEVICE_LIMIT}`
  if (memberHasCap(t, 'session.read')) return `我的设备 · 只读 · ${MEMBER_DEVICE_LIMIT}`
  return `我的设备 · ${MEMBER_DEVICE_LIMIT}`
}

/** 卡片标题栏 tooltip：成员设备不能说「主人（不受限）」。 */
export function memberRoleTitle(t: MemberCardLike): string {
  if (!isMemberDeviceCard(t)) {
    return t.myRole === 'owner' ? '主人（不受限）' : '协作者'
  }
  return '成员设备（权限在源设备）'
}

/** 只读面板顶部/底部的人话提示：权限在源设备，本机不能写。 */
export function readonlyPanelHint(sourceDeviceName?: string): string {
  const dev = sourceDeviceName ? `源设备「${sourceDeviceName}」` : '源设备'
  return `权限与可见范围在${dev}上——本机只是只读快照：不能邀请账号、不能停止授权/停止分享，也不能保存。要改请到那台设备操作。`
}

/** 只读面板底部状态行：告诉用户"本机没有可写入口"是**设计如此**，不是加载失败。 */
export function readonlyFooterText(sourceDeviceName?: string): string {
  return `本机不提供权限编辑（只读快照，源设备：${sourceDeviceName || '另一台设备'}）`
}
