/**
 * acctLayout — 账号页区块排序与字号收敛的纯函数定义 + 切换账号下拉菜单纯逻辑。
 *
 * 2026-10-01 重排（设计定稿方案）：页面底部「账号管理区」(management) 整区删除——
 * 切换/登录/创建全部收进顶部卡「切换账号 ▾」真下拉浮层；区块只剩
 *   identity（账号：我是谁）→ devices（设备：本机是谁）
 * 字号三级 = 标题14 / 正文12 / 辅说明11（didt 10.5 已并入 11）。
 */

/** 账号页区块（一页滚动，自上而下）。 */
export const ACCT_SECTIONS = ['identity', 'devices'] as const
export type AcctSection = (typeof ACCT_SECTIONS)[number]

/** 字号三级收敛：标题 / 正文 / 辅说明。 */
export const FONT_LEVELS = { title: 14, body: 12, caption: 11 } as const
export type FontLevel = keyof typeof FONT_LEVELS

/** 区块中文标签（与用户目标对应）。 */
export const SECTION_LABELS: Record<AcctSection, string> = {
  identity: '账号',
  devices: '设备',
}

/** 区块排序断言：identity → devices。 */
export function sectionOrder(): readonly AcctSection[] {
  return ACCT_SECTIONS
}

/** 字号收敛：给定语义级别返回 px 值。 */
export function fontSize(level: FontLevel): number {
  return FONT_LEVELS[level]
}

/** 危险区红字确认：输入 trim 后须精确匹配关键词才能点确认。 */
export function dangerConfirmOk(input: string, keyword: string): boolean {
  return input.trim().length > 0 && input.trim() === keyword
}

/* ═══ 切换账号下拉（2026-10-01 重排：顶部卡真下拉取代假 scrollIntoView + 页底列表双入口）═══ */

/** myco_accounts 清单条目（App.tsx accounts state 的形状子集）。 */
export interface AcctRowLike {
  did: string
  name?: string
  lastLogin?: string
  role?: string
}

/** 下拉菜单行（账号行；当前账号置顶灰显不可点）。 */
export interface AcctMenuItem {
  did: string
  name: string
  role?: string
  lastLogin?: string
  current: boolean
}

/**
 * 菜单行构造：当前账号置顶（灰显 ●当前），其余按清单原序。
 * did 相等性走 sameLike 的注入（前缀不敏感：did:myco:/did:youling: 同账号）——
 * 纯函数不引 didUtil 硬依赖，由调用方注入 eq 保持可测。
 */
export function acctMenuItems<T extends AcctRowLike>(
  accounts: readonly T[],
  currentDid: string | null | undefined,
  eq: (a: string, b: string) => boolean = (a, b) => a === b,
): AcctMenuItem[] {
  const items: AcctMenuItem[] = accounts.map((a) => ({
    did: a.did,
    name: a.name ?? '',
    role: a.role,
    lastLogin: a.lastLogin,
    current: !!currentDid && eq(a.did, currentDid),
  }))
  return items.sort((a, b) => Number(b.current) - Number(a.current))
}

/**
 * 「切换账号 ▾」按钮可见性：存在可选的其他账号才显示（单账号显示空下拉=反模式）；
 * 单账号时顶部卡右侧只放「＋ 登录另一个账号」小链接。
 */
export function switchMenuVisible(
  accounts: readonly { did: string }[],
  currentDid: string | null | undefined,
  eq: (a: string, b: string) => boolean = (a, b) => a === b,
): boolean {
  return accounts.some((a) => !currentDid || !eq(a.did, currentDid))
}

/** 菜单估算高度（首帧定位用；渲染后 useLayoutEffect 量真实尺寸二次 clamp）：
 *  账号行 46px/行 + 分隔线 9px + 两个入口行 36px/行 + 上下 padding 12px。 */
export function acctMenuHeight(rowCount: number): number {
  return 12 + rowCount * 46 + 9 + 2 * 36
}

/** 菜单固定宽（px）——行文案（名+尾4+凭据文案）实测最大宽度余量。 */
export const ACCT_MENU_W = 252

/* ═══ 2026-10-03 批：顶部账号卡单行布局 + 首登/切换反馈分叉（纯函数合同）═══ */

import { accountDisplayName, accountTail, nicknameValue } from '@wsui/lib/accountDisplay'

/**
 * 账号卡单行数据（用户 2026-10-02 实测修：名/尾号上下两行+右侧大片空白）。
 * 单行合同：`[头像] 名 ·…尾4 [弹性空白] [切换账号 ▾]`——
 *   nm   = 显示名（空/哨兵兜底「未命名」链）
 *   tail = `…尾4`（accountTail 单一源）
 *   full = title 悬停兜底（名被 ellipsis 收缩时的唯一全名出口）
 */
export interface AcctCardLine { nm: string; tail: string; full: string }
export function acctCardLine(name: string | null | undefined, did: string | null | undefined): AcctCardLine {
  const nm = accountDisplayName(name)
  const tail = accountTail(did)
  return { nm, tail, full: tail ? `${nm} · ${did}` : nm }
}

/**
 * 单行收缩样式合同（渲染层展开进 style）：名是唯一收缩项（minWidth:0 +
 * overflow ellipsis），尾号 flexShrink:0 钉死——名收无可收才轮到容器裁尾号。
 * 钉成常量防后人翻回两行布局/尾号被挤（测试见 acctLayout.test.ts）。
 */
export const ACCT_LINE_SHRINK = {
  nm: { flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } as const,
  tail: { flexShrink: 0 } as const,
}

/** 账号卡头像色（2026-10-03 设计定稿：彩色圆圈）：名字 hash 散列 8 色盘——
 *  与手机端 MessageBubble.avatarColorOf 同思路（稳定色，跨会话同账号同色），
 *  本文件自持实现避免 home→phone 跨目录引用。 */
const ACCT_AVATAR_PALETTE = ['#6b7bff', '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#f97316']
export function avatarHue(name: string): string {
  const s = (name || '?').trim()
  let h = 0
  for (const ch of s) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return ACCT_AVATAR_PALETTE[h % ACCT_AVATAR_PALETTE.length]
}

/** 首登 done 屏 / 切换轻反馈的 sessionStorage 键。 */
export const DONE_ACCT_KEY = 'myco.doneAcct'
export const SWITCH_ACCT_KEY = 'myco.switchAcct'

/**
 * 首登/切换反馈分叉（用户 2026-10-02 实测修：切换后不进「已登录」全屏页）。
 * wasLoggedIn=动作发生前登录器已有账号：
 *   false（首登：从无账号到有，欢迎屏账号列表/未登录态创建）→ done 屏（庆祝+引导）
 *   true （切换：已登录态换账号/新建）→ 轻反馈 toast（reload 后「已切换到 X」）
 * 返回要写的 {key,payload}；tail4 空（did 缺失）→ null 不写。
 */
export function acctFeedbackRoute(
  wasLoggedIn: boolean,
  name: string | null | undefined,
  tail4: string,
): { key: string; payload: string } | null {
  if (!tail4) return null
  return { key: wasLoggedIn ? SWITCH_ACCT_KEY : DONE_ACCT_KEY, payload: JSON.stringify({ name: name ?? '', tail: tail4 }) }
}

/** 切换 toast 文案：真昵称（空/哨兵不算——无名账号尾号是唯一区分度）→ `…尾4` → 「新账号」。 */
export function switchToastText(p: { name?: string; tail?: string } | null | undefined): string {
  const nm = nicknameValue(p?.name)
  if (nm) return `已切换到 ${nm}`
  if (p?.tail) return `已切换到 …${p.tail}`
  return '已切换到新账号'
}
