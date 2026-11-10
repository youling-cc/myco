/**
 * FriendsZone — 好友/群/聊天区（第81轮：登录器好友+聊天+任务卡分享）。
 *
 * 入口：「智能体」Tab"我的智能体"卡下方（好友列表/待确认/群 + 加好友 + 建群）。
 * 聊天屏：全屏 overlay（仿账号页全屏 section 模式，左上 ‹ 返回）——消息区滚动 +
 * 底部输入栏（文字 + 图片(input accept=image/*) + 任务卡分享）。
 * 轮询：进区即 poll + 5s 周期（半双工简单模型），发送后刷新会话。
 * 数据全部走 Rust 命令（chat_*，签名+HTTP 在 Rust 做）；气泡视觉移植自手机 MessageBubble。
 * 任务卡分享（AOP 分形/索引层思想）：卡=签名摘要微活契约；接受→本地 peer 任务库
 * →回发 task-accept（HBL 词表 claim）；完成→task-done（submit）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

/** 本机管理口（与 App.tsx 的 CANVAS_API 同值）：开卡前的分享存活校验用。 */
const FZ_API = 'http://127.0.0.1:3102'
import { createPortal } from 'react-dom'
import { Ava, ChatBubble, ParticipantsAvatars, dispNameOf, fmtTime, shortDid, type ChatMsg, type TaskParticipant } from './ChatBubble'
import { QrImage } from '@wsui/components/Qr'
import { dragRegionDown, dragRegionUp } from '@myco/ui-kit'
// 2026-10-05 复制可靠性加固 + 粘贴非法 DID 实时提示
import { isValidDid, copyDidVerified, copyDidToastText } from './didCheck'
import { listen } from '@tauri-apps/api/event'
import {
  buildTimeline, canRecall, clampMenuPos, draftPreview, fmtConvTime, loadConvPrefs, makeReplyAnchor,
  saveConvPrefs, sortConvs, totalUnread, unreadBadge,
  deviceGroupHeaderSub, deviceGroupRowSub, isDeviceGroup, seedDeviceGroupPins, showGroupManageEntry,
  type ConvRow, type ConvPref, type DeviceGroupInfo,
} from './chatOps'
import { cancelConvNotif } from './notify'
// §3.22 分享范围＝状态空间可见性（s→o 投影）：schema 驱动的纯逻辑（联动/只读回写/回写体组装）
// §3.20 逐人：继承/全宽判定、人话摘要、逐人回写体（did 随 payload 走）
// 逐人天花板（2026-10-06）：整体基线那一行 + 不能放宽的可选项灰掉（点了不生效 = 界面骗人）
// 2026-10-24 多项目：projects 白名单 / 项目档显示层叫「指定项目」/ 会话候选先按项目筛（拿不到映射=全部+说明）
import {
  buildVisibility, buildVisibilityPayload, splitSessionIds, visApplySessionCwds, visAsList,
  visCeilingLabel, visCeilings, visDisplayItems, visDraftFrom, visEq, visFilterSessionsByProjects,
  visGrantDirty, visGrantPayload, visGrantStart, visItemVisible, visNotNarrowed, visPathParent,
  visPathTail, visProjectsOf, visSamePath, visScopeLabel, visSessionCwdsOf, visShortId, visTouched,
  visValueOf,
  type VisCeiling, type VisGrantMode, type VisItem, type Visibility,
} from './shareVisibility'
import {
  isMemberDeviceCard, memberPermHint, memberRoleTitle, readonlyFooterText, readonlyPanelHint,
} from './permMemberUi'

const invokeT = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: Record<string, unknown>) => Promise<T> } })
    .__TAURI_INTERNALS__.invoke(cmd, args)

export interface Friend { did: string; name: string; addedAt: number; pending?: boolean; status?: 'out-pending' | 'in-pending' | 'ok' }
/** 第85轮：群档案+治理——owner=群主（建群者）；governance 恒 'owner'（'vote' 预留不读）；muted=禁言表。 */
export interface ChatGroup { id: string; name: string; members: string[]; createdAt?: number; owner?: string; governance?: 'owner' | 'vote'; muted?: Record<string, number>
  /** 批二（2026-09-28）：终态——disbanded=群主已解散 / kicked=我已被移出（档案保留只读、
   *  历史可回查、members 清空、输入区禁用）；ownerPending=自愈建群 owner 未同步（治理全拒）。 */
  status?: 'disbanded' | 'kicked'; ownerPending?: boolean
  /** 设备群（2026-10-07 设计 §3 决策A）：kind='device'=系统群标记——本账号全部设备
   *  自动入群（Rust ensure_device_group 本地幂等建档）；治理入口全锁（⚙️ 不渲染）、
   *  头部/行 UI 特化挂它。 */
  kind?: 'device' }
export interface PeerTask {
  taskId: string; title: string; desc?: string; requirements?: string
  rSpec?: { key: string; label?: string; target: unknown; unit?: string }[]
  reward?: string; from: string; fromName?: string; createdAt?: number; expiresAt?: number
  status: string; convId: string; source?: string; participants?: TaskParticipant[]; acceptedAt?: number; doneAt?: number
  /** 改名时间戳（task-rename，2026-10-11）：ts 大者生效的冲突裁决锚（后端 ingest 维护；UI 不读） */
  titleTs?: number
  /** 任务自定义动作（薄卡片契约，2026-10-06）：卡片只保留统一形状，做什么由 action 决定。
   *  open-url = 左键直达该 URL（如 myco 分享的本地现签入口、youling HBL 任务页面）。
   *  未知 kind 的消费端应降级为"不显示动作"，不要猜。
   *  2026-10-09 跨设备：远端同步来的卡 action.kind='open-url'，URL 指向**本机**管理面的
   *  `/api/dshShare/remoteOpen`——由它向源设备要一张窄 mt、开 P2P 隧道把分享页代理过来
   *  （点开只在本机发起；授权由源设备按该分享的 grant 名单判定）。 */
  action?: { kind?: string; url?: string; label?: string; target?: string }
  /** 这张卡来自哪台设备（2026-10-09 任务卡跨设备同步：后端落库时写入；
   *  本机建的卡也带（值=本机设备），远端卡的值为投递方设备 did/名）。 */
  sourceDevice?: string; sourceDeviceName?: string
  /** true=这张卡是**别的设备**同步过来的（本机没有对应分享实例）。
   *  2026-10-09 第二程起**不代表不可点**：动作走本机 remoteOpen（经 P2P 隧道回源设备），
   *  这个标记只剩展示语义——"来自 <设备名>"。 */
  remoteOrigin?: boolean
  /** 分享颗粒度（dsh-share 任务的关键信息：会话/项目/独立实例/整机） */
  granularity?: string
  /** §3.19 任务群组：本地分享记录 id（share_ensure_group / share_task_group 的入参）。
   *  后端 upsert 分享任务时写入（peer-tasks.json 的 shareId）；旧记录缺失时按
   *  taskId 命名约定 `peer-task-share-<shareId>` 兜底推导（见 shareIdOfTask）。 */
  shareId?: string
  /** §3.19 任务群组：该分享绑定的群 id（一个 grp- 会话；后端 ensure 后回填）。
   *  前端只在有值时才能把某个群认作"任务群"并拉成员四色。 */
  groupId?: string
  /** 源账号 did（§3.23 转授闸要靠它找源设备；也供 UI 展示"谁分享的"）。 */
  sourceAccount?: string
  /** 我的角色：owner（我的分享 / 同账号设备同步来的）/ collaborator（好友分享给我）。 */
  myRole?: string
  /** 2026-10-24 分享快照（只读）：成员设备（笔记本/手机）展示"主设备当时的设置"。
   *  判定永远在源设备——这里只是展示数据。 */
  shareSnapshot?: {
    caps?: { o?: { id?: string; label?: string }[]; a?: { id?: string; label?: string }[] }
    visibility?: { space?: string; sessions?: string[]; windowMs?: number | null }
    sourceDeviceName?: string
  }
  /** §3.23 赠卡：源设备随卡下发的"我的权限"（只读/读写 + 生效 caps + 可见范围）。
   *  **只是展示**——判定仍在源设备。 */
  grant?: {
    role?: string; label?: string; ro?: boolean; expiresAt?: number
    caps?: Record<string, boolean>
    visibility?: { space?: string; sessions?: string[]; windowMs?: number | null }
    windowMs?: number | null
    canReshare?: boolean; reshareExp?: number; reshareVia?: string | null
  }
  /** §3.23 转授闸：我能不能把这张卡转给第三人（默认 false = 要经主人同意）。
   *  真相与判定在源设备；这里是**本地那一半**（用来提前给出人话，而不是让对方点空）。 */
  canReshare?: boolean; reshareExp?: number; reshareVia?: string | null
}

/** §3.23「我的权限」一行摘要（人话）：只读/读写 + 可见范围 + 能不能转给第三人。
 *  owner 单独一档（不受限）；赠卡缺失**不猜**（说"权限未知"，绝不默认给全权）。 */
function taskPermHint(t: PeerTask): string {
  // task-43：成员设备（别的设备同步来的卡）的 owner 只是「本账号的一台设备」，不是分享源；
  // 设备级 P/A 下它受任务/设备策略限制——绝不能说「全权」。
  if (isMemberDeviceCard(t)) return memberPermHint(t)
  const isOwner = t.myRole === 'owner' || (!t.remoteOrigin && !t.grant)
  if (isOwner) return '我的（全权）'
  const g = t.grant
  if (!g) return '权限未知'
  const spaces: Record<string, string> = { machine: '整机', project: '这个项目', session: '指定会话' }
  const rw = g.ro ? '只读' : '可看可说'
  const sp = g.visibility?.space ? (spaces[g.visibility.space] || '') : ''
  const win = typeof g.visibility?.windowMs === 'number' ? g.visibility.windowMs
    : (typeof g.windowMs === 'number' ? g.windowMs : null)
  const winTxt = win && win > 0 ? `最近${Math.max(1, Math.round(win / 3_600_000))}小时` : ''
  return [rw, sp, winTxt].filter(Boolean).join(' · ') || '按任务默认'
}

/** §3.23：我能不能转给第三人（本地判定；转发最终由源设备实时复核）。 */
function taskReshareAllowed(t: PeerTask): boolean {
  if (t.myRole === 'owner' || (!t.remoteOrigin && !t.shareId)) return true
  if (t.canReshare !== true) return false
  return typeof t.reshareExp === 'number' && t.reshareExp > Date.now()
}
/* ═══ §3.19 任务群组（2026-10-06）：四色成员 + 任务卡右键入口 ═══
 * 契约（§3.19.3，后端聚合、前端只画；前端不重算状态、不新造对象）：
 *   share_ensure_group(shareId) -> { groupId }                  幂等：没有则建群并同步成员
 *   share_task_group(shareId)   -> { groupId, members:[…] }     成员四色 + lastSeenSec
 * 后端命令未注册（开发期常态）/ 调用失败 → 降级：卡片列表与聊天照常，只在入口处/成员条
 * 给一句「任务群组暂不可用」，绝不卡死整个卡片列表。 */

export type TaskMemberState = 'blue' | 'green' | 'orange' | 'gray'
export interface TaskGroupMember { did: string; name?: string; state?: TaskMemberState | string; lastSeenSec?: number }

/** 四色（互斥单色；优先级由后端算 §3.19.2，前端不重算）：
 *  蓝=在线且参与本任务 / 橘黄=AFK·锁屏 / 绿=在线未参与 / 灰=离线。
 *  橘黄刻意偏黄（用户实测反馈"黄色的感觉不够"——旧值偏红/偏粉）。 */
const TASK_MEMBER_COLOR: Record<TaskMemberState, string> = {
  blue: '#4b7bec',
  orange: '#efc000',
  green: '#22c55e',
  gray: '#c3c9d6',
}
const TASK_MEMBER_LABEL: Record<TaskMemberState, string> = {
  blue: '在线 · 正在参与本任务',
  orange: '在线 · AFK / 锁屏',
  green: '在线 · 未参与本任务',
  gray: '离线',
}
/** 未知 state 一律按灰（宁可少说，不可说错——与 presenceDotClass 兜底同纪律）。 */
const taskMemberColor = (s?: string): string => TASK_MEMBER_COLOR[s as TaskMemberState] ?? TASK_MEMBER_COLOR.gray
const taskMemberLabel = (s?: string): string => TASK_MEMBER_LABEL[s as TaskMemberState] ?? '状态未知'
/** lastSeenSec 是**元信息**（不可点小字），不是动作（§3.10 纪律 3 的动作/元信息分离）。 */
function lastSeenText(sec?: number): string {
  if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return ''
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分钟前`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h}小时前` : `${Math.floor(h / 24)}天前`
}
/** 四色圆点（互斥单色，无环/角标——§3.15 用户口径"别用环，不清楚"）。 */
function TaskMemberDot({ state, size = 8 }: { state?: string; size?: number }) {
  const c = taskMemberColor(state)
  return <span title={taskMemberLabel(state)} style={{ width: size, height: size, borderRadius: '50%', background: c, boxShadow: `0 0 5px ${c}66`, flexShrink: 0, display: 'inline-block' }} />
}

/** groupId → 分享（任务群身份）。PeerTasksCard 在任务 Tab、群会话屏在 FriendsZone
 *  （智能体 Tab）——同模块内的模块级登记表做载体，避免跨屏 prop 链与挂载顺序竞态。 */
interface TaskGroupRef { shareId: string; title: string }
const taskGroupRefs = new Map<string, TaskGroupRef>()
/** shareId 取值：字段优先，缺字段时按后端 taskId 命名约定 `peer-task-share-<shareId>` 兜底。 */
function shareIdOfTask(t: PeerTask): string {
  if (t.shareId) return t.shareId
  const p = 'peer-task-share-'
  return t.taskId.startsWith(p) ? t.taskId.slice(p.length) : ''
}
function rememberTaskGroup(groupId: string, ref: TaskGroupRef): void {
  if (groupId) taskGroupRefs.set(groupId, ref)
}
/** peerTasks 里带 groupId 的（后端 ensure 后回填）顺手登记——从会话列表左键进任务群
 *  时也能认出"这是任务群"并拉四色成员。 */
function rememberTaskGroupsFromTasks(tasks: PeerTask[]): void {
  for (const t of tasks) {
    const sid = shareIdOfTask(t)
    if (t.groupId && sid) rememberTaskGroup(t.groupId, { shareId: sid, title: t.title })
  }
}

/** 待打开的会话 id（跨屏导航 + 兜住"事件早于 FriendsZone 挂载/st 就绪"的竞态）。
 *  模块级监听在 import 时即挂上（App 启动即 import 本模块），组件内监听负责即时消费。 */
let pendingOpenConvId: string | null = null
if (typeof window !== 'undefined') {
  window.addEventListener('myco:open-conv', (e) => {
    const id = (e as CustomEvent<string>).detail
    if (id) pendingOpenConvId = id
  })
}

/** 人话错误摘要（Rust 侧错误串可能很长——只留一句给用户，细节在控制台）。 */
const briefErr = (e: unknown): string => {
  const s = String(e).replace(/^Error:\s*/, '').trim()
  return s.length > 48 ? `${s.slice(0, 48)}…` : (s || '未知错误')
}

/* ═══ 2026-10-06 视觉统一（四条线：层级 / 间距 / 可点 vs 元信息 / 字级三档）═══
 * 字级三档：标题 12.5–13 ｜ 正文 11–12.5 ｜ 元信息 10–10.5（元信息绝不像按钮）。
 * 色板：只用既有变量（--tx/--txm/--accent/--bd/--surface-2/--hover/--card-bg）
 * 与既定四色（蓝 #4b7bec / 橘黄 #efc000 / 绿 #22c55e / 灰 #c3c9d6）——不引入新色。 */

/** 行/项 hover（只有**可点的**才挂 fz-hover——元信息不挂）：五主题走 --hover。 */
const FZ_STYLE_ID = 'myco-fz-unified-style'
function ensureFzStyle(): void {
  if (document.getElementById(FZ_STYLE_ID)) return
  const st = document.createElement('style')
  st.id = FZ_STYLE_ID
  st.textContent = `.fz-hover{transition:background .12s ease;border-radius:8px}.fz-hover:hover{background:var(--hover,#f2f4fa)}`
  document.head.appendChild(st)
}
/** 元信息（状态/说明/lastSeen）：10.5px 暗字——绝不装成按钮（§3.10 分层）。 */
const FZ_META: CSSProperties = { fontSize: 10.5, lineHeight: 1.5, color: 'var(--txm, #8a93a8)' }
/** 可选项 chip 统一几何（enum 单选 / 分段切换共用）：11px 字、3px 10px 内边距、inline-flex 居中。 */
const FZ_OPT_CHIP: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, lineHeight: 1.3, padding: '3px 10px', whiteSpace: 'nowrap' }
/** 被挡（整体天花板/只读）= 灰掉 + not-allowed：摆出来但一眼知道点不动（用户口径：灰，别隐藏）。 */
const FZ_BLOCKED: CSSProperties = { opacity: .45, cursor: 'not-allowed' }
/** 破坏性动作：红字红边 ghost（危险但不过度吓人）；上膛（再点一次）= 浅红底 + 加粗。 */
const FZ_DANGER: CSSProperties = { color: '#e5534b', borderColor: 'rgba(229,83,75,.45)' }
const FZ_DANGER_ARMED: CSSProperties = { background: 'rgba(229,83,75,.12)', borderColor: '#e5534b', color: '#e5534b', fontWeight: 700 }
/** 警告条（链接不认人）：橘黄左边条 + 浅底——醒目提示，不是错误红。 */
const FZ_WARN: CSSProperties = { fontSize: 10.5, lineHeight: 1.55, fontWeight: 600, color: 'var(--tx,#1c2333)', background: 'rgba(239,192,0,.13)', borderLeft: '3px solid #efc000', borderRadius: 6, padding: '5px 8px' }

/** 分段切换（两选一：「跟随整体范围/单独指定」「从好友选/手填·走链接」共用同一画法）：
 *  选中=实色 chip（chipd 非灰），未选=灰 chip + hover——选中态一眼可读，与 enum 单选同一几何。 */
function SegTabs({ options, value, onPick, tips }: {
  options: { key: string; label: string }[]
  value: string
  onPick: (key: string) => void
  tips?: Record<string, string>
}) {
  ensureFzStyle()
  return (
    <div style={{ display: 'inline-flex', gap: 3, padding: 3, borderRadius: 999, background: 'var(--surface-2,#f1f3f8)', border: '1px solid var(--bd,#e2e5ee)' }}>
      {options.map((o) => {
        const on = o.key === value
        return (
          <span key={o.key} title={tips?.[o.key]} onClick={() => onPick(o.key)}
            className={on ? 'chipd' : 'chipd gray fz-hover'}
            style={{ ...FZ_OPT_CHIP, cursor: 'pointer', fontWeight: on ? 700 : 500 }}>
            {o.label}
          </span>
        )
      })}
    </div>
  )
}

/* ── 右键菜单（本区统一版）：行为与 ChatBubble.CtxMenu 逐条对齐（portal 固定坐标、
 *  首帧实测宽高 clamp 贴边、外点/滚动/Esc 关闭、keepOpen 原地二次确认），视觉按四条线
 *  统一：项距一致、危险项红、「再点一次确认」上膛态 = 浅红底 + 加粗。
 *  ChatBubble 内部的气泡菜单在另一文件，不在本次范围。 ── */
interface FzMenuAction { key: string; label: string; danger?: boolean; armed?: boolean; keepOpen?: boolean; run: () => void }
function FzCtxMenu({ x, y, actions, onClose }: { x: number; y: number; actions: FzMenuAction[]; onClose: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos(clampMenuPos(x, y, r.width, r.height, window.innerWidth, window.innerHeight))
  }, [x, y, actions.length])
  useEffect(() => {
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('wheel', close, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('wheel', close, true)
    }
  }, [onClose])
  return createPortal(
    <div ref={boxRef} onMouseDown={(e) => e.stopPropagation()} style={{
      position: 'fixed', left: pos?.x ?? x, top: pos?.y ?? y, zIndex: 400, minWidth: 132, maxWidth: 220, padding: 4,
      visibility: pos ? 'visible' : 'hidden',
      background: 'var(--chrome-bg,#fff)', border: '1px solid var(--bd,#e2e5ee)', borderRadius: 10,
      boxShadow: '0 10px 30px rgba(8,12,20,.22)',
    }}>
      {actions.map((a) => (
        // keepOpen：第一次点击只上膛（原地变文案+上膛态样式），第二次再执行并关闭——行为不变
        <div key={a.key} onClick={() => { a.run(); if (!a.keepOpen) onClose() }} style={{
          padding: '7px 12px', margin: '1px 0', fontSize: 12.5, borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap',
          color: a.danger ? '#e5534b' : 'var(--tx,#1c2333)',
          fontWeight: a.armed ? 700 : 400,
          background: a.armed ? 'rgba(229,83,75,.12)' : 'transparent',
        }}
          onMouseEnter={(e) => { e.currentTarget.style.background = a.armed ? 'rgba(229,83,75,.18)' : a.danger ? 'rgba(229,83,75,.08)' : 'var(--hover,#f2f4fa)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = a.armed ? 'rgba(229,83,75,.12)' : 'transparent' }}>
          {a.label}
        </div>
      ))}
    </div>,
    document.body,
  )
}

/* ═══ §3.14 / §3.20 / §3.22 授权与可见性：任务卡右键「🔑 授权与可见性」 ═══
 * 契约（后端钉死，前端只画、不重算、不新造对象）：
 *   share_grants(shareId)                     -> { ok, collaborators: [{ did, name, isOwner, caps }] }
 *   share_grant_caps(shareId, did, caps)      -> { ok }
 *   share_revoke_all_grants(shareId)          -> { ok, revoked: number }
 * 后端未注册（开发期常态）/ 调用失败 → 面板内一句话「授权信息暂不可用」+ 重试，
 * 卡片列表、其它菜单项、聊天全不受影响（§3.19 同款降级纪律）。
 * 界面纪律：**只用人话**——绝不出现 o/a、能力 id、方法名、caps 等术语。 */
type CapKey = 'session.read' | 'session.input' | 'agent.view' | 'scope.switch' | 'model.select'
type GrantCaps = Record<CapKey, boolean>
interface GrantCollaborator { did: string; name?: string; isOwner?: boolean; caps?: Partial<GrantCaps> }

/** §3.14.2 v1 四个能力 → 界面人话标签（固定，不随任务变）。 */
const CAP_ROWS: { key: CapKey; label: string }[] = [
  { key: 'session.read', label: '看会话内容' },
  { key: 'session.input', label: '输入内容' },
  { key: 'agent.view', label: '看子 agent' },
  { key: 'scope.switch', label: '切换已授权的会话 / 工作区' },
  { key: 'model.select', label: '切换模型' },
]
const CAP_KEYS: CapKey[] = CAP_ROWS.map((r) => r.key)
const capLabel = (k: CapKey): string => CAP_ROWS.find((r) => r.key === k)?.label ?? ''
/** §3.12.5：能输入 = 传递性授予 AI 的全部工具能力（人话说明，供 ⓘ 悬停）。 */
const INPUT_RISK_TIP = '他能给 AI 下命令——AI 能读文件、能动手，等于把 AI 的工具能力借给了他。只看得到已有内容，能输入就是能动这个会话。'
/** caps 归一：缺字段=关（宁可少给，不可默认给）；owner=self「我 · 全部权限」恒真且只读。 */
function readCaps(c: Partial<GrantCaps> | undefined, isOwner: boolean): GrantCaps {
  const out = {} as GrantCaps
  for (const k of CAP_KEYS) out[k] = isOwner ? true : c?.[k] === true
  return out
}
/** 2026-10-18：逐人权限的**一句人话摘要**（面板折叠行用）。
 *  此前要展开 4 个复选框才知道"这朋友到底能做什么"；摘要先说结论，细节按需展开。 */
function capsSummary(caps: GrantCaps): string {
  const parts: string[] = []
  if (caps['session.read']) parts.push('看内容')
  if (caps['session.input']) parts.push('能发言')
  if (caps['agent.view']) parts.push('看子 agent')
  if (caps['scope.switch']) parts.push('切会话')
  return parts.length ? parts.join(' · ') : '还不能看'
}
/** 摘要色：能发言=橙（等于借出 AI 工具能力），只看=蓝，无权限=红。 */
function capsTone(caps: GrantCaps): CSSProperties {
  if (caps['session.input']) return { background: 'rgba(230,81,0,.10)', color: '#c2410c' }
  if (caps['session.read']) return { background: 'rgba(107,123,255,.10)', color: '#4c5bd4' }
  return { background: 'rgba(229,83,75,.10)', color: '#d92d20' }
}
/* ── 动作授权：暂未开放的「设置类 / 模型类 / 思考等级类」动作（2026-10-24 用户需求）──
 * 用户问「改模型、改思考等级、改设置等动作现在是否默认禁用？」——后端把这些写 RPC
 * 明确置于默认拒绝。界面口径：**四个会话能力开关（session.read/input/agent.view/
 * scope.switch）保留不动**，再把这三类动作**灰着列出来**（不隐藏：让人知道有这类动作、
 * 但现在不给协作者），点不动 +「暂未开放」。
 * 只展示、不发请求：caps 契约仍是四个固定 id，这里不新增任何 payload 字段。 */
const CAP_LOCKED_ROWS: { key: string; label: string; hint: string }[] = [
  { key: 'settings', label: '修改设置（工具 / 环境等）', hint: '设置类动作（改设置/环境等写操作）：后端默认拒绝，暂未开放给协作者。' },
  { key: 'thinking', label: '调整思考等级', hint: '思考等级类动作（改思考深度）：后端默认拒绝，暂未开放给协作者。' },
]
/** 三行禁用态动作：灰 + 「暂未开放」（邀请区与逐人调整区共用同一画法）。 */
function LockedActionRows() {
  return (
    <>
      {CAP_LOCKED_ROWS.map((r) => (
        <label key={r.key} title={r.hint}
          style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, padding: '3px 4px', borderRadius: 6, cursor: 'not-allowed', opacity: .55 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--tx,#1c2333)' }}>{r.label}</span>
          <span className="chipd gray" style={{ fontSize: 9.5, padding: '1px 6px', flexShrink: 0 }}>暂未开放</span>
          <input type="checkbox" checked={false} disabled style={{ flexShrink: 0 }} />
        </label>
      ))}
    </>
  )
}
/** 协作者列表兜底去重（**同一 did 只留一行**）。
 *  账号粒度的合并由**后端**做（`grants_view` 用 `resolve_account_did` 把同一账号的多台设备
 *  并成一行、写的时候铺到该账号所有设备行；设备 did → 账号 did 的归并只有后端有）——
 *  这里只挡住"同一个 did 回了两行"这类不该发生的重复，免得同一个人出现两次、配了两份。 */
function dedupeByDid<T extends { did: string }>(rows: T[]): T[] {
  return rows.filter((r, i) => rows.findIndex((x) => x.did === r.did) === i)
}

/* ── ＋ 邀请账号（§3.14.1 新增协作者，2026-10-06）──
 * 契约（后端钉死，前端只传人话对应的四个布尔值）：
 *   share_grant(shareId, label, did?, caps?) -> { ok, did, label, caps, url }
 *   · 给 did   = 直接授权给这个人（label 是给他的称呼）
 *   · 不给 did = 签发 **bearer 链接**（label 必填）——谁拿到链接谁能进
 *   · 失败一律 promise reject（不判 ok:false）；后端未就绪就是 reject → 就地一句话降级。
 * 默认勾选 = 只看 + 输入（与后端新默认一致）——另两项不勾（宁可少给，不可默认给）。 */
const INVITE_DEFAULT_CAPS: GrantCaps = {
  'session.read': true,
  'session.input': true,
  'agent.view': false,
  'scope.switch': false,
}
/** 2026-10-18 交互优化：邀请先给**两档预设**（只看 / 可发言），再让用户微调四项。
 *  "四个复选框怎么勾"是新用户最容易卡住的一步；预设把常见意图一步说清。 */
const INVITE_PRESETS: { key: string; label: string; hint: string; caps: GrantCaps }[] = [
  {
    key: 'ro', label: '👁 只看',
    hint: '能看被授权的会话，不能发言',
    caps: { 'session.read': true, 'session.input': false, 'agent.view': false, 'scope.switch': false },
  },
  {
    key: 'say', label: '✍️ 可发言（默认）',
    hint: '能看也能在会话里发言——等于把 AI 的工具能力借给他',
    caps: { ...INVITE_DEFAULT_CAPS },
  },
]
/** 可邀请的好友态：与 FriendsZone 内 fst 同规则（旧数据无 status 时按 pending 兜底）。 */
const isOkFriend = (f: Friend): boolean => (f.status || (f.pending ? 'in-pending' : 'ok')) === 'ok'
/** 选中某个元素里的文本（复制失败时的兜底：链接已高亮，用户按 Ctrl+C 即可）。 */
function selectTextIn(el: HTMLElement | null): void {
  if (!el) return
  try {
    const r = document.createRange()
    r.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(r)
  } catch { /* 选中失败就只把文本摆在眼前，用户还能手动选 */ }
}

/** 任务动作的"打开"（open-url 白名单已在 safeActionUrl 收口）——左键与右键菜单共用同一实现。 */
async function openExternalUrl(url: string): Promise<void> {
  const m = window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> } }
  try { await m.__TAURI_INTERNALS__?.invoke('open_external', { url }) }
  catch { window.open(url, '_blank') }
}

/** 批三：Conv 与 chatOps.ConvRow 同构（unreadN=seen 后入站条数，Rust conv_state 产出）。 */
type Conv = ConvRow
export type { ConvRow as Conv }
export interface ChatState { myDid: string; myName: string; friends: Friend[]; groups: ChatGroup[]; tasks: PeerTask[]; convs: Conv[] }

// ═══ 第84轮：在线状态灯（三态：绿/呼吸绿/烛光橘）+ 群治理字段透传 ═══

/** 灯的三态视觉（用户诗意需求："像在睡眠，又在不安心的等待，又愿为你始终点亮这盏等待的灯火"）。
 *  烛光关键帧刻意不规则（非均匀正弦）——摇曳感。样式一次注入。 */
const PRESENCE_STYLE_ID = 'myco-presence-dot-style'
function ensureDotStyle(): void {
  if (document.getElementById(PRESENCE_STYLE_ID)) return
  const st = document.createElement('style')
  st.id = PRESENCE_STYLE_ID
  st.textContent = `
@keyframes mycoBreathe { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(1.3)} }
@keyframes mycoCandle { 0%,100%{opacity:.7;box-shadow:0 0 6px #f59e0b40} 30%{opacity:1;box-shadow:0 0 10px #f59e0b60} 60%{opacity:.6;box-shadow:0 0 4px #f59e0b30} }
@keyframes mycoSpin { to { transform: rotate(360deg) } }
.myco-dot { width:8px;height:8px;border-radius:50%;flex-shrink:0;display:inline-block;transition:background .4s }
.myco-dot.off { background:#c3c9d6 }
.myco-dot.active { background:#22c55e;box-shadow:0 0 5px #22c55e55 }
.myco-dot.typing { background:#22c55e;box-shadow:0 0 8px #22c55e88;animation:mycoBreathe 1.2s ease-in-out infinite }
.myco-dot.idle, .myco-dot.locked { background:linear-gradient(135deg,#fbbf24,#f59e0b);animation:mycoCandle 2.8s ease-in-out infinite }
`
  document.head.appendChild(st)
}

/** 好友在线状态（chat_presence 聚合结果）——映射纯函数在 ./presence（单测覆盖）。 */
export type { FriendPresence } from './presence'
import { presenceDotClass, presenceDotTitle, makeThrottle, firstTypingMember, type FriendPresence } from './presence'
/** 任务卡「打开」路由（2026-10-23）：有 env → `vnet_env_open` 直开；无 env → 原 open-url。
 *  `safeActionUrl` 也在这里（scheme 白名单只许有一份）。
 *  `cleanCardTitle`（task-env）：卡面标题去技术化（2026-10-25 用户反馈——老环境卡
 *  卡名带 127.0.0.1:端口，显示时去掉；数据与打开链路不动）。 */
import {
  actionLabelOf, declaredEnvsOfCard, runTaskOpen, safeActionUrl,
} from './task-open'
import { cleanCardTitle } from './task-env'

/** 三态灯：offline=灰 / active=绿 / typing=呼吸绿 / idle|locked=烛光橘。 */
function PresenceDot({ p, size = 8 }: { p?: FriendPresence; size?: number }) {
  ensureDotStyle()
  return <span className={`myco-dot ${presenceDotClass(p)}`} style={{ width: size, height: size }} title={presenceDotTitle(p)} />
}

/** 尾4位显示。 */
const tail4 = (s: string) => `…${(s || '').slice(-4)}`

/* ═══ 2026-09-29 全屏子页两修：① 头部不显示全称 did（昵称>名称>…尾4）；
 * ② overlay 不再整窗盖死 TitleBar——让出窗口栏（拖动区+─▢✕ 恒可达），且子页
 * 自己的头部背景也是 drag region（与 TitleBar 同款按下语义）。 ═══ */

/** home 嵌入端口（与 App.tsx TitleBar port 同源——编队拖动打点用）。 */
const HOME_PORT = 17995

/** TitleBar 底缘 y（embed 态无 TitleBar=0）——全屏子页 overlay 的 top 让位量。 */
function titleBarBottomPx(): number {
  if (typeof document === 'undefined') return 0
  const el = document.querySelector('.myco-titlebar')
  return el ? Math.max(0, Math.round(el.getBoundingClientRect().bottom)) : 0
}

/** 子页 overlay 顶部让位 TitleBar（磁条态 22px 等高度变化跟 resize 重测）。 */
function useTitleBarBottom(): number {
  const [bottom, setBottom] = useState(titleBarBottomPx)
  useEffect(() => {
    const measure = () => setBottom(titleBarBottomPx())
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  return bottom
}

/** 子页头部 drag region 按下语义——与 TitleBar 同款（置焦前台 + 主动态打点，
 *  编队 Rust 侧只在此态中继拖动）；松开挂 window 级（拖动结束鼠标可能在窗外），
 *  卸载兜底 end。返回值放头部容器 onMouseDown。 */
function useDragRegionFx(): () => void {
  useEffect(() => {
    const end = () => dragRegionUp(HOME_PORT)
    window.addEventListener('mouseup', end)
    window.addEventListener('blur', end)
    return () => {
      window.removeEventListener('mouseup', end)
      window.removeEventListener('blur', end)
      end()
    }
  }, [])
  return useCallback(() => dragRegionDown(HOME_PORT), [])
}

/** 图片自动压缩（2026-09-29，与手机 ChatView.compressImage 同款）：>2MB 缩到
 *  1600px JPEG(q0.85)、透明底铺白——原图直发会被 2MB 上限拒掉。 */
async function compressImage(file: File, maxDim = 1600, quality = 0.85): Promise<Blob> {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bmp, 0, 0, w, h)
  return (await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/jpeg', quality))) ?? file
}

/* ═══ §3.19.4 系统留痕的呈现：与人对人的消息分开 ═══
 * 后端（myco 自己）单发的任务内事件——`payload.system=true`，或 kind=sys/system。
 * 形态：居中、灰底、小字、不可点（不是动作也不是气泡）；文案形如
 * 「🛡 <谁> 尝试<动作>，被可信机制拦下 · <时间>」（§3.19.4 留痕通道）。
 *
 * 2026-10-18 聊天微信化（M11 噪声治理）：聊天流只呈现「人对人内容 + 微信也有的系统条」。
 *  - payload.system=true 的机制留痕（cap_denied 等安全审计/工具痕迹）与未知系统事件
 *    属于非人类过程内容——不渲染（只留在诊断日志里）。
 *  - 白名单=微信同款系统提示：好友关系 / 入群·退群·被移出·解散·群创建 / 撤回 / 设备群。
 * 判定函数导出给 buildTimeline 用（返回 null ≠ 非系统消息，必须单独判"该隐藏"）。 */
const WECHAT_SYS_RE = /(已成为好友|加入了群聊|被拉进了群聊|退出了群聊|被移出群|移出了群聊|被群主解散|已被解散|解散了群聊|已创建|撤回了一条消息|设备群已开启)/

/** 该行是否是"要隐藏的系统过程条"（true=不进聊天流；非系统消息恒 false）。 */
export function isHiddenSystemNotice(m: ChatMsg): boolean {
  const p = m.payload as { system?: unknown; text?: unknown; kind?: unknown }
  const isSystem = p.system === true || m.kind === 'system' || m.kind === 'sys'
  if (!isSystem) return false
  if (p.system === true) return true // myco 可信机制留痕（非人的发言）
  const raw = typeof p.text === 'string' ? p.text.trim() : ''
  if (!raw) return true // 无正文系统条不落行（不留空气泡）
  return !WECHAT_SYS_RE.test(raw)
}

function systemNoticeOf(m: ChatMsg): { icon: string; text: string } | null {
  if (isHiddenSystemNotice(m)) return null
  const p = m.payload as { system?: unknown; text?: unknown; event?: unknown; kind?: unknown }
  const isSystem = p.system === true || m.kind === 'system' || m.kind === 'sys'
  if (!isSystem) return null
  const raw = typeof p.text === 'string' ? p.text.trim() : ''
  if (!raw) return null // 无正文的系统条不渲染（不落一个空气泡）
  const ev = String(p.event ?? p.kind ?? '')
  const hasIcon = ['🛡', '🤝', '🎉', '⚙️', '📢', '🚫', '✅', '⚠'].some((k) => raw.startsWith(k))
  const icon = hasIcon ? '' : ev === 'cap_denied' ? '🛡 ' : m.kind === 'sys' ? '🤝 ' : ''
  return { icon, text: raw }
}

/** 会话列表预览净化（2026-10-18 M11）：Rust lastText 对未知 kind 会落原文——
 *  机制留痕（🛡 …被可信机制拦下）不该出现在会话列表。命不中就原样返回。 */
function humanConvPreview(text: string | undefined): string {
  const t = (text || '').trim()
  if (!t) return ''
  if (/^🛡|被可信机制拦下|正在通过|已入队|对方上线后送达/.test(t)) return ''
  return t
}
function SystemNotice({ m, notice }: { m: ChatMsg; notice: { icon: string; text: string } }) {
  return (
    <div id={`msg-${m.msgId}`} style={{ textAlign: 'center', margin: '7px 0' }}>
      {/* 留痕=元信息 pill：灰底细边小字、居中、不可点（不是动作也不是气泡） */}
      <span style={{
        display: 'inline-block', maxWidth: '92%', padding: '3px 12px', borderRadius: 999,
        background: 'rgba(148,163,184,.14)', border: '1px solid rgba(148,163,184,.22)',
        color: 'var(--muted, #8a93a8)', fontSize: 10.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {notice.icon}{notice.text}{m.ts ? ` · ${fmtTime(m.ts)}` : ''}
      </span>
    </div>
  )
}

/* ═══════════ 聊天屏（全屏 overlay） ═══════════
 * 批三（2026-09-29 全量打磨）：时间体系（5min 合并+居中时间条+跨天日期分隔+未读
 * 分割线）/ ↓N 新消息浮标 / 草稿保留 / 引用回复 / 撤回（2min）/ 删除本地 / 右键
 * 菜单 / 粘贴发图 / 文件多选 / 输入框自动增高+自动聚焦+Esc 返回 / 首帧 loading
 * 不闪空态。父组件必须 key={conv.id} 挂载（切会话整屏重挂=状态干净复位）。 */
function ChatScreen({ conv, st, boardTasksSource, onBack, onChanged, onOpenTask, presence, onOpenGroupManage, draft, onDraft, taskGroupShareId }: {
  conv: Conv
  st: ChatState
  boardTasksSource: { title: string; projectName: string; shareId?: string }[]
  onBack: () => void
  onChanged: () => void
  onOpenTask: (m: ChatMsg) => void
  presence: Record<string, FriendPresence>
  onOpenGroupManage: (g: ChatGroup) => void
  /** 批三：草稿（父组件 draftMap 持有；本屏 text 初值+回写通道）。 */
  draft: string
  onDraft: (convId: string, v: string) => void
  /** §3.19 任务群组：本群绑定的分享 id。有值=任务群（顶部显示四色成员条）；
   *  无值=普通群（不显示，不作任何假设）。 */
  taskGroupShareId?: string
}) {
  // 批三：null=加载中（首帧不闪"还没有消息"空态）；[]=真空
  const [msgs, setMsgs] = useState<ChatMsg[] | null>(null)
  const [text, setText] = useState(() => draft)
  const [err, setErr] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  // 2026-09-29：分享成功即时反馈横幅（卡片气泡落屏之外的明确"成了"信号）
  const [sharedFlash, setSharedFlash] = useState(false)
  // 第84轮：对方 typing 指示（P2P 瞬时信号，3.5s 过期）
  const [peerTyping, setPeerTyping] = useState<string | null>(null)
  // 2026-10-18 M11：删除对账"正在同步消息…"状态条（过程不呈现给用户）。
  // 原 syncing/syncTimerRef 状态机一并移除——UI 不被同步阻塞，也不再展示同步过程。
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const typingThrottleRef = useRef(makeThrottle(3000)) // 节流 3s（设计定稿；2026-09-29 由 2s 改）
  const scrollRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // 批三：引用回复（点气泡"引用"→输入区挂引用条；发送时 payload.replyTo 锚）
  const [quoting, setQuoting] = useState<ChatMsg | null>(null)
  // 批三："以下为新消息"分割线锚（仅进屏首次 load 捕获一次；hadUnread 由 Rust 按旧 seen 算）
  const [firstUnreadId, setFirstUnreadId] = useState<string | undefined>(undefined)
  const firstLoadDoneRef = useRef(false)
  // 批三：上翻时新消息 "↓N 条" 浮标
  const [newBelow, setNewBelow] = useState(0)
  const prevLenRef = useRef(0)
  const isGroup = conv.kind === 'group'
  // 2026-09-29 两修：overlay 让位 TitleBar（可拖动/窗控可达）+ 头部 drag region。
  const tbBottom = useTitleBarBottom()
  const dragDown = useDragRegionFx()
  ensureDotStyle() // 第95轮：同步状态条 spinner 的 mycoSpin keyframes（群聊无 PresenceDot 也要在）
  // 显示名取值（任何位置不显示全称 did）：单聊=好友昵称>会话 title>…尾4；群=群名护栏。
  const peerDid = isGroup ? '' : conv.id.replace(/_/g, ':')
  const titleName = isGroup ? (shortDid(conv.title) || '群') : dispNameOf(conv.id, st.friends, conv.title)

  // 进屏触发与对方的 P2P 对账（"活的历史"：对方在线即快速补齐）
  // 2026-10-12：同时**预热路由**（后台把到对端的通路建好进缓存）——之后发消息
  // 复用热隧道，毫秒级（用户定调："能在什么时间点建连好就保持，之后秒发"）。
  useEffect(() => {
    invokeT('chat_warm_route', { convId: conv.id }).catch(() => {})
  }, [conv.id])
  useEffect(() => {
    void invokeT('chat_sync_now', { convId: conv.id }).catch(() => {})
  }, [conv.id])
  // 批三：进屏即清该会话的待发系统通知（用户已进来=已读）
  useEffect(() => { void cancelConvNotif(conv.id) }, [conv.id])
  // 批三：进聊天自动聚焦输入框（key 重挂后 mount 一次）
  useEffect(() => { taRef.current?.focus() }, [])
  // 批三：输入框自动增高（scrollHeight 到 maxHeight 96）
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`
  }, [text])
  // 对方 typing 信号 → 顶栏呼吸灯 + 文案（3.5s 过期）
  useEffect(() => {
    const un = listen<{ convId: string; fromName: string }>('p2p-typing', (e) => {
      if (e.payload.convId !== conv.id && e.payload.convId !== conv.id.replace(/:/g, '_')) return
      setPeerTyping(shortDid(e.payload.fromName || '') || '对方')
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
      typingTimerRef.current = setTimeout(() => setPeerTyping(null), 3500)
    }).catch(() => (() => {}))
    return () => { void un.then((f) => f()) }
  }, [conv.id])

  // 第85轮：群禁言状态（自己被禁言中 → 输入区置灰）
  const group = isGroup ? st.groups.find((g) => g.id === conv.id) : undefined
  const mutedUntil = group?.muted?.[st.myDid] ?? 0
  const amMuted = mutedUntil > Date.now()
  const isOwner = !!group && (group.owner ?? group.members[0]) === st.myDid
  // 批二：终态群（已解散/已被移出）——会话只读（历史可回查），输入区禁用
  const groupTerminal = group?.status === 'disbanded' || group?.status === 'kicked'
  // 2026-10-20 小灵官方通知会话：只读（陈词/处理走卡片 action 到平台，不做第二通道）
  const isOfficialConv = !!conv.official
  const inputLocked = amMuted || groupTerminal || isOfficialConv
  const lockPlaceholder = groupTerminal
    ? (group?.status === 'disbanded' ? '群已被群主解散，仅可查看历史' : '你已被移出该群，仅可查看历史')
    : isOfficialConv ? '小灵只发送官方通知，不可回复——请点通知卡按钮去平台处理'
    : amMuted ? `已被群主禁言至 ${new Date(mutedUntil).toLocaleTimeString()}` : ''

  /* §3.19 任务群组：成员四色（后端聚合，前端只画；15s 轮询）。
   * null=还没取到 → 首次失败显示"任务群组暂不可用"；有旧值时继续显示旧值（不闪空、
   * 后端命令上线后自动恢复）。命令未注册（开发期）也只影响这一条，不影响聊天。 */
  const [members, setMembers] = useState<TaskGroupMember[] | null>(null)
  const [membersErr, setMembersErr] = useState<string | null>(null)
  useEffect(() => {
    if (!isGroup || !taskGroupShareId) { setMembers(null); setMembersErr(null); return }
    let alive = true
    const loadMembers = () => {
      invokeT<{ groupId?: string; members?: TaskGroupMember[] }>('share_task_group', { shareId: taskGroupShareId })
        .then((r) => { if (alive) { setMembers(r?.members ?? []); setMembersErr(null) } })
        .catch((e) => { if (alive) setMembersErr(briefErr(e)) })
    }
    loadMembers()
    const t = setInterval(loadMembers, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [isGroup, taskGroupShareId])

  /* 设备群（2026-10-07 设计 §3 决策F）：头部副题数据——chat_device_group_info 15s 轮询
   * （模式抄上面任务群四色条成员轮询）。Rust 命令未注册/失败 → devInfo=null，头部降级
   * 「📱 设备群」，聊天完全不受影响（§3.19 同款降级纪律）。 */
  const isDevGroup = isGroup && isDeviceGroup(group ?? { id: conv.id })
  const [devInfo, setDevInfo] = useState<DeviceGroupInfo | null>(null)
  useEffect(() => {
    if (!isDevGroup) { setDevInfo(null); return }
    let alive = true
    const loadDevInfo = () => {
      invokeT<DeviceGroupInfo>('chat_device_group_info')
        .then((r) => { if (alive) setDevInfo(r ?? null) })
        .catch(() => { if (alive) setDevInfo(null) })
    }
    loadDevInfo()
    const t = setInterval(loadDevInfo, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [isDevGroup])

  /** typing 瞬时信号（节流 3s；单聊发对方账号，群=grp-id 由 Rust 侧逐成员扇出）。
   *  触发点=onChange（内容变化即报：键盘/粘贴/拖拽全覆盖）+onKeyDown 兼容。 */
  const sendTypingSignal = () => {
    if (!typingThrottleRef.current(Date.now())) return
    const to = isGroup ? conv.id : conv.id.replace(/_/g, ':')
    void invokeT('chat_typing', { convId: conv.id, to }).catch(() => {})
  }

  const load = useCallback(async () => {
    try {
      const r = await invokeT<{ msgs: ChatMsg[]; firstUnreadMsgId?: string; hadUnread?: boolean }>('chat_load_conv', { convId: conv.id })
      invokeT('chat_ui_trace', { tag: 'load', line: `conv=${conv.id.slice(-8)} msgs=${r.msgs?.length ?? -1} last=${r.msgs?.[r.msgs.length - 1]?.sendState ?? '-'}` }).catch(() => {})
      // 在飞的乐观条不抹（见 pushOptimistic 的 2026-10-12 注释）
      const tmp = pendingOptimisticRef.current
      const list = r.msgs ?? []
      const merged = tmp && !list.some((m) => m.msgId === tmp.msgId) ? [...list, tmp] : list
      setMsgs(merged)
      // 批三：未读分割线锚只在进屏首次 load 捕获（后续 5s 轮询不重置——微信语义：
      // 分割线钉在进会话那一刻的未读边界，离开会话才失效）
      if (!firstLoadDoneRef.current) {
        firstLoadDoneRef.current = true
        if (r.hadUnread && r.firstUnreadMsgId) setFirstUnreadId(r.firstUnreadMsgId)
      }
    } catch (e) { setErr(String(e)) }
  }, [conv.id])

  useEffect(() => { void load() }, [load])
  // 进屏即 poll 一次 + 5s 轮询；poll 后重读会话文件（信箱/好友表入库即上屏）。
  // 2026-09-28：此前 poll 后不 load（只在 msgs.length===0 翻转时读）——聊天中对方
  // 消息数据层已落 jsonl 但 UI 不刷新，要退出重进会话才看得见。
  useEffect(() => {
    const t = setInterval(() => { void invokeT('chat_poll').then(() => load()).catch(() => {}) }, 5000)
    return () => clearInterval(t)
  }, [load])
  // chat-incoming（P2P 直推 + 对账入库都会 emit）→ 立即重读（秒级实时，不等 5s 轮询）
  useEffect(() => {
    const un = listen('chat-incoming', () => { void load() }).catch(() => (() => {}))
    return () => { void un.then((f) => f()) }
  }, [load])
  // 第95轮：发送状态翻转（补发成功/重发失败）→ 立即重读。
  // 2026-10-18 M11：对账进度（p2p-sync-progress）不再驱动任何 UI——"正在同步消息…"
  // 这类投递过程文字不上屏（对账本身照常由 Rust 后台推进）。
  useEffect(() => {
    const un2 = listen('chat-send-state', () => { void load() }).catch(() => (() => {}))
    return () => { void un2.then((f) => f()) }
  }, [load])
  // 滚动（2026-09-29 与手机端对齐微信语义）：PC 消息区是普通正序容器（旧→新、
  // 最新在底部——渲染序本身正确，与手机端 column-reverse 病灶不同）。补贴底跟随：
  // 新消息到达时若视口已在底部附近（<=40px）才滚到底；用户上翻看历史时不强拉；
  // 切会话重置为贴底。此前 msgs.length 变化无条件 scrollTop=scrollHeight——上翻中
  // 每来一条新消息都被强拽到底，看不了历史（手机端同日同修，见 FriendsPanel）。
  const stickRef = useRef(true)
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 40
    if (stickRef.current) setNewBelow(0) // 批三：回底即清"↓N 条"浮标
  }
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [msgs])
  // 批三：上翻中来到的新消息计数（贴底时归零；切会话 key 重挂天然复位）
  useEffect(() => {
    const n = msgs?.length ?? 0
    const delta = n - prevLenRef.current
    prevLenRef.current = n
    if (delta <= 0) return
    if (stickRef.current) setNewBelow(0)
    else setNewBelow((x) => x + delta)
  }, [msgs])
  useEffect(() => {
    stickRef.current = true
    prevLenRef.current = 0
    setNewBelow(0)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [conv.id])
  // 批三：浮标点击 → 回底并清零
  const jumpToBottom = () => {
    stickRef.current = true
    setNewBelow(0)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }
  // 批三：引用行点击 → 跳到原文气泡（居中 + 背景闪一下）
  const jumpToMsg = (msgId: string) => {
    const el = document.getElementById(`msg-${msgId}`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.style.transition = 'background .3s'
    el.style.background = 'rgba(107,123,255,.16)'
    el.style.borderRadius = '10px'
    window.setTimeout(() => { el.style.background = 'transparent' }, 1300)
  }

  // 第95轮：乐观上屏——发送请求未返回前先把消息插到本地视图末尾（⏳ 发送中）。
  // 对账进行中也不阻塞打字；invoke 返回后 load() 全量重读（Rust 侧已按 ts 排序
  // 合并——乐观条消失、权威行带上，位置不跳变）。失败时移除乐观条并提示。
  // 2026-10-12 修（"聊天区消息不见了"定案）：乐观条记入 ref——**轮询 load 的
  // 全量覆盖不再抹掉它**（invoke 未返回期间消息还没落盘，权威列表必无此条，
  // 每 5s 的 load 会把气泡冲掉=用户看到的"往复"）；invoke 结束（成功/失败）
  // 清 ref，load 恢复纯权威视图。
  const pendingOptimisticRef = useRef<ChatMsg | null>(null)
  const pushOptimistic = (payload: Record<string, unknown>, kind = 'text'): string => {
    const tmpId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const m: ChatMsg = { msgId: tmpId, from: st.myDid, to: conv.id, kind, payload, ts: Date.now(), dir: 'out', sendState: 'sending' }
    pendingOptimisticRef.current = m
    setMsgs((prev) => [...(prev ?? []), m])
    return tmpId
  }
  const dropOptimistic = (tmpId: string) => {
    invokeT('chat_ui_trace', { tag: 'drop', line: `optimistic 气泡被删 tmp=${tmpId.slice(-6)}（invoke 抛错的回滚路径）` }).catch(() => {})
    setMsgs((prev) => (prev ?? []).filter((m) => m.msgId !== tmpId))
  }

  /** 第95轮：失败消息点按重发（chat_retry_msg：在队=立即补发 / 溢出=重建信封再试）。 */
  const retryMsg = async (m: ChatMsg) => {
    setErr(null)
    // 先本地翻回"发送中"（即时反馈），命令返回后 load() 取权威态
    setMsgs((prev) => (prev ?? []).map((x) => (x.msgId === m.msgId ? { ...x, sendState: 'sending' as const } : x)))
    try {
      await invokeT('chat_retry_msg', { convId: conv.id, msgId: m.msgId })
      await load()
    } catch (e) { setErr(String(e)); await load() }
  }

  /** 批三：引用锚注入（有引用条时 payload.replyTo = {msgId,name,text}）。 */
  const withReply = (payload: Record<string, unknown>): Record<string, unknown> =>
    quoting ? { ...payload, replyTo: makeReplyAnchor(quoting, st.friends) } : payload

  const sendText = async () => {
    const t = text.trim()
    if (!t || sending) return
    invokeT('chat_ui_trace', { tag: 'send', line: `start conv=${conv.id.slice(-8)} len=${t.length} optimistic=1` }).catch(() => {})
    setSending(true); setErr(null)
    const tmpId = pushOptimistic(withReply({ text: t }))
    // 2026-10-12 修（真机 16.5s 空窗定案）：微信语义——回车即清输入框，不是
    // 等 invoke 返回。失败路径 dropOptimistic 后把文字**回填**（可改可重发）。
    setText(''); onDraft(conv.id, '')
    try {
      if (isGroup) await invokeT('chat_send_group', { groupId: conv.id, payloadCore: withReply({ text: t }) })
      else await invokeT('chat_send', { to: conv.id, kind: 'text', payload: withReply({ text: t }) })
      invokeT('chat_ui_trace', { tag: 'send', line: `invoke-ok tmp=${tmpId.slice(-6)}` }).catch(() => {})
      pendingOptimisticRef.current = null // 权威行即将由 load 带上，乐观条退役
      setQuoting(null)
      await load(); onChanged()
      invokeT('chat_ui_trace', { tag: 'send', line: `done tmp=${tmpId.slice(-6)}` }).catch(() => {})
    } catch (e) {
      invokeT('chat_ui_trace', { tag: 'send', line: `invoke-ERR tmp=${tmpId.slice(-6)} ${String(e).slice(0, 120)}` }).catch(() => {})
      pendingOptimisticRef.current = null
      dropOptimistic(tmpId); setErr(String(e)); setText(t); onDraft(conv.id, t)
    } finally { setSending(false) }
  }

  const sendImage = async (f: File) => {
    // 2026-09-29 Bug2 配套（与手机端同款）：>2MB 自动压缩（1600px JPEG q0.85）——
    // 相机/截图原图普遍超 2MB 上限，直接拒发等于"传照片"形同虚设。
    let blob: Blob = f
    try { if (f.size > 2 * 1024 * 1024) blob = await compressImage(f) } catch { /* 压缩失败走原文件校验 */ }
    if (blob.size > 2 * 1024 * 1024) { setErr('图片超过 2MB，请压缩后再发'); return }
    const jpeg = blob !== f
    const name = jpeg ? `${f.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg` : f.name
    const mime = jpeg ? 'image/jpeg' : (f.type || 'image/png')
    const rd = new FileReader()
    rd.onload = async () => {
      const b64 = String(rd.result || '').split(',')[1] || ''
      setSending(true); setErr(null)
      const tmpId = pushOptimistic(withReply({ name, mime, b64 }), 'image')
      try {
        if (isGroup) await invokeT('chat_send_group', { groupId: conv.id, payloadCore: withReply({ name, mime, b64 }) })
        else await invokeT('chat_send', { to: conv.id, kind: 'image', payload: withReply({ name, mime, b64 }) })
        setQuoting(null)
        await load(); onChanged()
      } catch (e) { dropOptimistic(tmpId); setErr(String(e)) } finally { setSending(false) }
    }
    rd.readAsDataURL(blob)
  }

  /** 第94轮：任意文件（非图片）——10MB 上限，kind=file；点击系统打开。 */
  const sendFile = async (f: File) => {
    if (f.size > 10 * 1024 * 1024) { setErr(`文件过大（>10MB），暂不支持`); return }
    const name = f.name || 'file'
    const mime = f.type || 'application/octet-stream'
    const size = f.size
    const rd = new FileReader()
    rd.onload = async () => {
      const b64 = String(rd.result || '').split(',')[1] || ''
      setSending(true); setErr(null)
      const tmpId = pushOptimistic(withReply({ name, mime, size }), 'file')
      try {
        if (isGroup) await invokeT('chat_send_group', { groupId: conv.id, payloadCore: withReply({ name, mime, size, b64 }) })
        else await invokeT('chat_send', { to: conv.id, kind: 'file', payload: withReply({ name, mime, size, b64 }) })
        setQuoting(null)
        await load(); onChanged()
      } catch (e) { dropOptimistic(tmpId); setErr(String(e)) } finally { setSending(false) }
    }
    rd.readAsDataURL(f)
  }

  /** 第94轮：附件入口统一——图片走压缩链路（保持现状），其他文件走 file 卡。 */
  const sendAny = (f: File) => {
    if (f.type.startsWith('image/')) void sendImage(f)
    else void sendFile(f)
  }

  /** 第94轮：文件卡点击 → Rust 写临时文件 + 系统关联程序打开。 */
  const openFile = async (m: ChatMsg) => {
    try { await invokeT('chat_open_file', { convId: conv.id, msgId: m.msgId }) }
    catch (e) { setErr(String(e)) }
  }

  /** 批三：撤回（2min 窗口 UI/Rust 双闸；双向 tombstone——Rust 落 kind=recalled
   *  并给对端发 recall 控制消息）。 */
  const recallMsg = async (m: ChatMsg) => {
    setErr(null)
    try {
      await invokeT('chat_recall_msg', { convId: conv.id, msgId: m.msgId })
      await load(); onChanged()
    } catch (e) { setErr(String(e)) }
  }

  /** 批三：删除本地记录（chat_delete_msg；只清本端，不影响对端）。 */
  const deleteMsg = async (m: ChatMsg) => {
    setErr(null)
    try {
      await invokeT('chat_delete_msg', { convId: conv.id, msgId: m.msgId })
      await load(); onChanged()
    } catch (e) { setErr(String(e)) }
  }

  return (
    <div style={{ position: 'fixed', top: tbBottom, left: 0, right: 0, bottom: 0, zIndex: 220, background: 'var(--bg, #f6f7fa)', display: 'flex', flexDirection: 'column' }}>
      {/* 顶栏：‹ 返回 + 灯 + 标题 + typing 指示 + 群管理 ⚙️。
          *  背景容器=drag region（TitleBar 同款按下语义；按钮/文本子元素不带属性，
          *  正常接收点击——Tauri 只认 mousedown target 自身带 data-tauri-drag-region）。 */}
      <div data-tauri-drag-region onMouseDown={dragDown} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: 'var(--chrome-bg, #fff)', borderBottom: '1px solid var(--bd, #e2e5ee)' }}>
        <button className="bk" onClick={onBack}>‹ 返回</button>
        {/* 2026-10-12 标题居中（微信式）：灯+名+副题整体绝对居中，返回/⚙️ 两侧让位。
            *  背景容器=drag region（TitleBar 同款按下语义；按钮/文本子元素不带属性，
            *  正常接收点击——Tauri 只认 mousedown target 自身带 data-tauri-drag-region）。 */}
        {(() => {
          const groupTyper = isGroup && group ? firstTypingMember(group.members, presence, st.myDid) : null
          const typingName = peerTyping ?? (groupTyper ? dispNameOf(groupTyper, st.friends) : null)
          const peerP = isGroup ? undefined : presence[conv.id.replace(/_/g, ':')]
          const showTyping = !!typingName || peerP?.state === 'typing'
          const dot: FriendPresence | undefined = showTyping
            ? { online: true, state: 'typing', deviceName: '', devices: 1 }
            : peerP
          return (
            <>
              <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', minWidth: 0, maxWidth: '52%', textAlign: 'center', pointerEvents: 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13.5, fontWeight: 800, color: 'var(--tx, #1c2333)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {(dot || !isGroup) && <PresenceDot p={dot} />}
                  {/* 设备群（决策F）：📱 徽标（普通群 👥 不变） */}
                  {isGroup ? (isDevGroup ? '📱 ' : '👥 ') : ''}{titleName}
                </div>
                <div style={{ fontSize: 10.5, color: showTyping ? '#22c55e' : 'var(--muted, #8a93a8)', fontFamily: 'ui-monospace,monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {showTyping
                    ? `${typingName ?? titleName} 正在输入…`
                    /* 设备群副题（2026-10-12 去重）：只留「N 台设备 · M 在线」——
                     * 「📱 设备群」已在主标题，不再重复一遍。 */
                    : isDevGroup ? deviceGroupHeaderSub(devInfo).replace(/^📱 设备群 · /, '')
                    : isGroup ? `${titleName} · ${group?.members.length ?? 0}人${isOwner ? ' · 我是群主' : ''}` : tail4(peerDid)}
                </div>
              </div>
            </>
          )
        })()}
        {/* 第85轮：群管理入口 ⚙️（批二：终态群只读，无管理入口；设备群=系统群治理锁死，
            决策 D.4——kind='device' 不渲染，GroupManageScreen 不可达）。
            2026-10-13 修（用户反馈）：标题改绝对居中后 ⚙️ 被挤到返回键旁——
            marginLeft:auto 推回最右（微信式：左返回/中标题/右操作）。 */}
        {isGroup && group && !groupTerminal && showGroupManageEntry(group) && (
          <button title="群管理" onClick={() => onOpenGroupManage(group)}
            style={{ marginLeft: 'auto', flexShrink: 0, border: '1px solid var(--bd,#e2e5ee)', background: 'none', borderRadius: 8, width: 28, height: 28, cursor: 'pointer', fontSize: 13 }}>⚙️</button>
        )}
      </div>
      {/* §3.19 任务群组：成员四色条（顶部）——互斥单色圆点 + 最近在线（元信息，不可点）。
          群会话屏是"谁在参与这个任务"的唯一落点（§3.15：不往 harness 页面注入）。 */}
      {isGroup && taskGroupShareId && (
        <div style={{ flexShrink: 0, padding: '7px 12px 8px', background: 'var(--surface-2, #f6f7fa)', borderBottom: '1px solid var(--bd, #e2e5ee)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--muted, #8a93a8)' }}>
            {/* 图例不常驻占位（2026-10-06 用户反馈「这些不用常列占用地方，在 tooltip 上显示就行了」）
                → 挪进标题的 title：悬停即见完整四色含义，平时只留"任务群成员（N）"。 */}
            <span
              style={{ fontWeight: 700, flexShrink: 0, cursor: 'help', borderBottom: '1px dotted var(--bd,#e2e5ee)' }}
              title={'四色互斥单色：\n🔵 参与 = 在线且正在参与本任务\n🟠 暂离 = 在线但 AFK / 锁屏\n🟢 在线 = 在线但未参与本任务\n⚪ 离线 = 不在线'}>
              任务群成员{members ? `（${members.length}）` : ''}
            </span>
          </div>
          {members === null ? (
            <div style={{ ...FZ_META, marginTop: 5 }}>
              {membersErr ? `任务群组暂不可用（${membersErr}）` : '成员状态加载中…'}
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginTop: 5, paddingBottom: 1 }}>
              {members.length === 0 && <span style={FZ_META}>还没有成员——授权后自动同步</span>}
              {members.map((mb) => {
                const nm = mb.did === st.myDid ? `${st.myName || '我'}（我）` : dispNameOf(mb.did, st.friends, mb.name)
                const c = taskMemberColor(mb.state)
                const seen = lastSeenText(mb.lastSeenSec)
                return (
                  // 成员 chip=元信息（不可点）：圆点+名字+lastSeen 一行垂直居中，统一几何
                  <span key={mb.did} title={`${nm} · ${taskMemberLabel(mb.state)}`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, padding: '3px 9px', borderRadius: 999, background: 'var(--card-bg, #fff)', border: `1px solid ${c}55` }}>
                    <TaskMemberDot state={mb.state} />
                    <span style={{ fontSize: 11, lineHeight: 1.3, color: 'var(--tx, #1c2333)', maxWidth: 96, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nm}</span>
                    {seen && <span style={{ fontSize: 10, lineHeight: 1.3, color: 'var(--txm, #8a93a8)' }}>{seen}</span>}
                  </span>
                )
              })}
            </div>
          )}
        </div>
      )}
      {/* 2026-10-18 M11：原"对账进行中状态条/同步横幅"整块删除——同步是后台事，
          过程不呈现给用户（syncing 状态机一并移除）。 */}
      {/* 消息区（批三：buildTimeline 驱动——时间条/日期分隔/未读分割线/5min 合并） */}
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: 'auto', padding: '10px 14px 16px', position: 'relative' }}>
        {/* 批三：首帧 loading 不闪空态（null=加载中；[]=真空才显引导文案）
            2026-10-18 M11：加载态只留 spinner（无"消息加载中…"过程文字）。 */}
        {msgs === null && (
          <div title="正在加载聊天记录" style={{ textAlign: 'center', padding: '30px 0' }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, border: '2px solid #6b7bff33', borderTopColor: '#6b7bff', display: 'inline-block', animation: 'mycoSpin 0.9s linear infinite', verticalAlign: -2 }} />
          </div>
        )}
        {msgs !== null && msgs.length === 0 && <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 12, padding: '30px 0' }}>还没有消息，说第一句吧</div>}
        {buildTimeline(msgs ?? [], { firstUnreadMsgId: firstUnreadId }).map((it) => {
          if (it.t === 'time') {
            return (
              <div key={it.key} style={{ textAlign: 'center', margin: '10px 0 6px', fontSize: 10.5, color: 'var(--muted, #8a93a8)' }}>
                <span style={{ background: 'rgba(148,163,184,.12)', padding: '1px 10px', borderRadius: 8 }}>{it.label}</span>
              </div>
            )
          }
          if (it.t === 'date') {
            return (
              <div key={it.key} style={{ textAlign: 'center', margin: '12px 0 6px', fontSize: 10.5, color: 'var(--muted, #8a93a8)' }}>
                <span style={{ background: 'rgba(148,163,184,.16)', padding: '1px 12px', borderRadius: 8, fontWeight: 700 }}>{it.label}</span>
              </div>
            )
          }
          if (it.t === 'unread') {
            return (
              <div key={it.key} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 8px' }}>
                <span style={{ flex: 1, height: 1, background: 'rgba(229,83,75,.35)' }} />
                <span style={{ fontSize: 10.5, color: '#e5534b', fontWeight: 700, whiteSpace: 'nowrap' }}>以下为新消息</span>
                <span style={{ flex: 1, height: 1, background: 'rgba(229,83,75,.35)' }} />
              </div>
            )
          }
          const m = it.m
          // 2026-10-18 M11：非人类系统过程条（机制留痕/未知系统事件）整行不进聊天流。
          if (isHiddenSystemNotice(m)) return null
          // §3.19.4 系统留痕：与人对人的气泡分离（居中灰底小字），不进聊天流气泡
          const notice = systemNoticeOf(m)
          if (notice) return <SystemNotice key={it.key} m={m} notice={notice} />
          return (
            <ChatBubble key={it.key} m={m} myDid={st.myDid}
              prevSameSender={it.merged}
              onOpenTask={onOpenTask} onOpenFile={openFile} onRetry={(mm) => void retryMsg(mm)}
              onOpenUrl={(url) => void openExternalUrl(url)}
              onQuote={(mm) => { setQuoting(mm); taRef.current?.focus() }}
              onDelete={(mm) => void deleteMsg(mm)}
              onRecall={canRecall(m) ? (mm) => void recallMsg(mm) : undefined}
              onJumpMsg={jumpToMsg} />
          )
        })}
      </div>
      {/* 批三：上翻中新消息 "↓N 条" 浮标（点击回底） */}
      {newBelow > 0 && (
        <div onClick={jumpToBottom} style={{
          position: 'absolute', right: 18, bottom: 86, zIndex: 35, cursor: 'pointer',
          padding: '6px 12px', borderRadius: 999, background: 'var(--chrome-bg,#fff)',
          border: '1px solid var(--bd,#e2e5ee)', boxShadow: '0 6px 18px rgba(8,12,20,.18)',
          fontSize: 11.5, fontWeight: 700, color: 'var(--ac,#4338ca)', userSelect: 'none',
        }}>↓ {newBelow > 99 ? '99+' : newBelow} 条新消息</div>
      )}
      {err && <div style={{ padding: '4px 12px', fontSize: 11, color: '#e5534b' }}>{err}</div>}
      {/* 批三：引用条（点气泡"引用"挂上；✕ 取消；Esc 同义） */}
      {quoting && (() => {
        const a = makeReplyAnchor(quoting, st.friends)
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 11px', background: 'var(--surface-2,#f1f3f8)', borderTop: '1px solid var(--bd,#e2e5ee)' }}>
            <span style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, background: '#6b7bff', flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'var(--muted,#8a93a8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              引用 <b style={{ color: 'var(--tx,#1c2333)' }}>{a.name}</b>: {a.text}
            </span>
            <span onClick={() => setQuoting(null)} title="取消引用" style={{ cursor: 'pointer', fontSize: 12, color: 'var(--muted,#8a93a8)', padding: '0 4px', flexShrink: 0 }}>✕</span>
          </div>
        )
      })()}
      {/* 底部输入栏 */}
      <div style={{ display: 'flex', gap: 7, alignItems: 'flex-end', padding: '9px 11px', background: 'var(--chrome-bg, #fff)', borderTop: '1px solid var(--bd, #e2e5ee)' }}>
        <button title={groupTerminal ? '群已只读' : '发文件 / 图片（可多选）'} onClick={() => imgRef.current?.click()} disabled={groupTerminal}
          style={{ flexShrink: 0, border: '1px solid var(--bd,#e2e5ee)', background: 'none', borderRadius: 9, width: 34, height: 34, cursor: groupTerminal ? 'not-allowed' : 'pointer', fontSize: 15, opacity: groupTerminal ? 0.45 : 1 }}>📎</button>
        <button title={groupTerminal ? '群已只读' : '分享任务卡'} onClick={() => setShareOpen((v) => !v)} disabled={groupTerminal}
          style={{ flexShrink: 0, border: '1px solid var(--bd,#e2e5ee)', background: 'none', borderRadius: 9, width: 34, height: 34, cursor: groupTerminal ? 'not-allowed' : 'pointer', fontSize: 15, opacity: groupTerminal ? 0.45 : 1 }}>📋</button>
        <textarea ref={taRef} value={text} rows={1} disabled={inputLocked}
          onChange={(e) => { setText(e.target.value); onDraft(conv.id, e.target.value); sendTypingSignal() }}
          onKeyDown={(e) => {
            sendTypingSignal()
            // 批三：Esc=有引用先撤引用，否则返回会话列表
            if (e.key === 'Escape') { e.preventDefault(); if (quoting) setQuoting(null); else onBack(); return }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendText() }
          }}
          onPaste={(e) => {
            // 批三：PC 粘贴发图/发文件（截图直贴微信语义）
            const files = [...(e.clipboardData?.files ?? [])]
            if (!files.length) return
            e.preventDefault()
            for (const f of files) sendAny(f)
          }}
          placeholder={inputLocked ? lockPlaceholder : '输入消息，Enter 发送'}
          style={{ flex: 1, resize: 'none', border: '1px solid var(--bd,#e2e5ee)', borderRadius: 9, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', maxHeight: 96, opacity: inputLocked ? 0.55 : 1 }} />
        <button disabled={!text.trim() || sending || inputLocked} onClick={() => void sendText()}
          style={{ flexShrink: 0, border: 'none', borderRadius: 9, padding: '0 14px', height: 34, fontSize: 13, fontWeight: 700, color: '#fff', background: 'linear-gradient(135deg,#6b7bff,#5567f5)', cursor: 'pointer', opacity: !text.trim() || sending || inputLocked ? 0.45 : 1 }}>发送</button>
        {/* 第94轮：accept 放开为任意类型（Android 壳 createIntent 跟随 accept；图片自动压缩，其他文件走 file 卡）
            批三：multiple 文件多选（微信拖拽/多选语义） */}
        <input ref={imgRef} type="file" multiple style={{ display: 'none' }}
          onChange={(e) => { for (const f of [...(e.target.files ?? [])]) sendAny(f); e.target.value = '' }} />
      </div>
      {/* 任务卡分享弹层 */}
      {shareOpen && <TaskSharePanel conv={conv}
        targetLabel={isGroup ? `群「${titleName}」（${group?.members.length ?? 0} 人）` : `好友 ${titleName}`}
        boardTasksSource={boardTasksSource} onClose={() => setShareOpen(false)}
        onShared={() => {
          setShareOpen(false); void load(); onChanged()
          setSharedFlash(true)
          setTimeout(() => setSharedFlash(false), 2600)
        }} refreshState={onChanged} />}
      {/* 分享成功反馈横幅（屏内居中，2.6s 自消） */}
      {sharedFlash && (
        <div style={{ position: 'absolute', top: 52, left: '50%', transform: 'translateX(-50%)', zIndex: 40, padding: '7px 14px', borderRadius: 10, background: 'rgba(34,197,94,.94)', color: '#fff', fontSize: 12.5, fontWeight: 700, boxShadow: '0 4px 14px rgba(0,0,0,.22)', whiteSpace: 'nowrap' }}>✓ 任务卡已分享，等 TA 一起做</div>
      )}
    </div>
  )
}

/* ═══════════ 任务卡分享弹层（两路：分享我的任务 / 新建任务卡） ═══════════
 * 2026-09-29 与手机端 ShareSheet 同构（两端交互一致）：头部/页签 + 唯一滚动区
 * + 固定提交底栏——提交按钮不进滚动区，任何窗口高度下恒可见；sheet 整体
 * maxHeight:70vh 自适应矮窗（此前无上限，矮窗下头部会被顶出屏幕外不可滚）。 */
function TaskSharePanel({ conv, targetLabel, boardTasksSource, onClose, onShared, refreshState }: {
  conv: Conv
  targetLabel: string
  boardTasksSource: { title: string; projectName: string; shareId?: string }[]
  onClose: () => void
  onShared: () => void
  refreshState: () => void
}) {
  const [mode, setMode] = useState<'pick' | 'new' | 'env'>('pick')
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [req, setReq] = useState('')
  const [reward, setReward] = useState('')
  const [days, setDays] = useState('0')
  const [busy, setBusy] = useState(false)
  /** 2026-10-23 任务卡 env：正在建哪张环境卡（'rdp' | 'dsh'）——按钮禁用 + 文案用。 */
  const [envBusy, setEnvBusy] = useState<'rdp' | 'dsh' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  /** §3.23：转发被别人分享的卡时，后端回的是"已请主人发卡"这类**人话**（不是错误）——
   *  用中性的提示位呈现，别把它塞进红色错误区。 */
  const [note, setNote] = useState<string | null>(null)
  const canSubmit = !busy && !!title.trim()

  const share = async (t: string, d: string, r: string, rq: string, dd: number, sid?: string) => {
    setBusy(true); setErr(null); setNote(null)
    try {
      const ret = await invokeT<{ message?: string }>('chat_share_task', {
        conv: conv.id, title: t, desc: d, requirements: rq,
        reward: r || null, expiresDays: dd || null,
        // 任务卡带 shareId 时，后端把接收方自动加进该分享的授权列表（分享任务卡=授权）
        ...(sid ? { shareId: sid } : {}),
      })
      await refreshState()
      const msg = (ret?.message || '').trim()
      if (msg) setNote(msg)
      onShared()
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }

  /**
   * 2026-10-23 任务卡 env（AOP：入口只来自任务卡）——**一键建「带环境的卡」并发给当前会话**。
   *
   * 之前只有"渲染/执行"没有"创建"入口：`POST /api/dshShare/create` 不收 env，用户
   * 根本找不到一张 RDP 任务卡（问题原话："RDP 的任务卡名字是什么"）。
   *
   * 2026-10-25 文案精简（用户反馈）：卡名不再带 `127.0.0.1:端口`——那是建链的中间
   * 细节，对看卡的人没用；口子仍按设计 §4 落在卡数据 `env[]` 里，打开链路零变化：
   *   · `【PC远程桌面】`（env: rdp → 目标 3389，本地固定口 23389）
   *   · `【PC-DSH-Web】`（env: dsh → 目标 13911，本地固定口 23911）
   *
   * 走 IPC `share_create_env_card`（UI 是 `tauri://` 源，打不了本机管理面；后端与
   * HTTP `/api/dshShare/create` 共用同一实现，title 只是显示名，不含逻辑）。`device`
   * 留空 = 本机设备，后端补 DID。
   */
  // 2026-11-01 自由远程桌面（补设备选择）：env 卡的目标设备。
  // 后端 share_create_env_card 本就收 device（null=本机）；此前 UI 写死 null，
  // "PC 远程我的另一台设备（ecs-linux/笔记本）"没有入口。这里在「分享环境」面板
  // 顶部加一个设备下拉（myco_list_devices 同源，只列在线未吊销）。
  const [envDevices, setEnvDevices] = useState<{ did: string; name: string; kind?: string | null }[]>([])
  const [envDevice, setEnvDevice] = useState('') // '' = 本机
  useEffect(() => {
    if (mode !== 'env') return
    let alive = true
    void invokeT<{ devices?: { did: string; name: string; kind?: string | null; online?: boolean; revoked?: boolean }[] }>('myco_list_devices')
      .then((r) => {
        if (!alive) return
        const list = (r?.devices ?? [])
          .filter((d) => d.online && !d.revoked)
          .map((d) => ({ did: d.did, name: d.name || d.did.slice(-8), kind: d.kind }))
        setEnvDevices(list)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [mode])
  const envDeviceName = envDevices.find((d) => d.did === envDevice)?.name || ''
  const envTitlePrefix = envDeviceName ? `【${envDeviceName}` : '【PC'

  const shareEnv = async (kind: 'rdp' | 'dsh' | 'vnc' | 'rustdesk') => {
    setEnvBusy(kind); setErr(null); setNote(null)
    try {
      // 2026-11-01 自由远程桌面：vnc（Mac 屏幕共享/Linux VNC）/ rustdesk（GPL，IP 直连）；
      // 目标设备由下拉决定（'' = 本机；ecs-linux 等在线设备 → 远程那台机器的桌面）。
      const kindName = kind === 'rdp' ? '远程桌面】'
        : kind === 'dsh' ? '-DSH-Web】'
        : kind === 'vnc' ? 'VNC远程桌面】'
        : 'RustDesk远程桌面】'
      const title = envDeviceName
        ? `【${envDeviceName}${kindName}`
        : kind === 'rdp' ? '【PC远程桌面】' : kind === 'dsh' ? '【PC-DSH-Web】' : kind === 'vnc' ? '【VNC远程桌面】' : '【RustDesk远程桌面】'
      const ret = await invokeT<{ shareId?: string; card?: { message?: string } }>('share_create_env_card', {
        title, conv: conv.id, kind,
        device: envDevice || null, port: null, localPort: null, label: null, shareId: null, sessionId: null,
      })
      await refreshState()
      const msg = (ret?.card?.message || '').trim()
      if (msg) setNote(msg)
      onShared()
    } catch (e) { setErr(String(e)) } finally { setEnvBusy(null) }
  }

  const tasks = boardTasksSource ?? []
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 10, background: 'var(--chrome-bg,#fff)', borderTop: '1px solid var(--bd,#e2e5ee)', borderRadius: '14px 14px 0 0', padding: '12px 13px 14px', boxShadow: '0 -6px 24px rgba(22,30,60,.12)', maxHeight: '70vh', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, flexShrink: 0 }}>
        <b style={{ fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📋 分享任务卡 → {targetLabel}</b>
        <button className="bk" onClick={onClose}>收起 ✕</button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexShrink: 0 }}>
        <button className={mode === 'pick' ? 'btnd small' : 'btnd small ghost'} disabled={!tasks.length} onClick={() => setMode('pick')}>分享我的任务</button>
        <button className={mode === 'new' ? 'btnd small' : 'btnd small ghost'} onClick={() => setMode('new')}>新建任务卡</button>
        {/* 2026-10-23：带环境（远程桌面 / DSH web）的任务卡——入口只来自卡 */}
        <button className={mode === 'env' ? 'btnd small' : 'btnd small ghost'} onClick={() => setMode('env')}>分享环境</button>
      </div>
      {/* 唯一滚动区：列表/表单字段。提交按钮不进来（钉在底栏恒可见）。 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {mode === 'pick' ? (
          <>
            {tasks.length === 0 && <div className="tinyd">暂无可分享的任务</div>}
            {tasks.map((t, i) => (
              <div key={i} className="devline" style={{ marginTop: 4, cursor: 'pointer' }} onClick={() => void share(t.title, `来自项目「${t.projectName}」`, '', '', 0, t.shareId)}>
                <span className="dot" style={{ background: '#6b7bff' }} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                <span className="endchip go">分享 ›</span>
              </div>
            ))}
          </>
        ) : mode === 'new' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="任务标题（必填）" style={inputS} />
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="任务介绍：做什么、为什么" rows={2} style={{ ...inputS, resize: 'none' }} />
            <textarea value={req} onChange={(e) => setReq(e.target.value)} placeholder={'要求/验收（尽量可测、有时限）：\n如 目标：≤2小时完成 / 验收：代码可编译'} rows={2} style={{ ...inputS, resize: 'none' }} />
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={reward} onChange={(e) => setReward(e.target.value)} placeholder="奖励（可选，如 100 积分）" style={{ ...inputS, flex: 1 }} />
              <select value={days} onChange={(e) => setDays(e.target.value)} style={{ ...inputS, width: 110 }}>
                <option value="0">长期有效</option>
                <option value="1">1 天有效</option>
                <option value="3">3 天有效</option>
                <option value="7">7 天有效</option>
              </select>
            </div>
          </div>
        ) : (
          /* 2026-10-23：带环境的任务卡（AOP：入口只来自卡）。
             TA 收到卡 → 卡上出现「远程桌面 / DSH Web」入口行 → 点「打开」自动连接并打开对应应用。
             2026-10-25 精简：不再给对方展示任何地址/端口。 */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div className="tinyd" style={{ lineHeight: 1.65 }}>
              卡上声明环境 → TA 点卡上的「打开」就自动连接并打开对应应用（走 myco 加密隧道）。
            </div>
            {/* 2026-11-01 设备选择：目标桌面在哪台机器（本机 / ecs-linux / 笔记本 / 手机…） */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="tinyd" style={{ flexShrink: 0 }}>目标设备</span>
              <select value={envDevice} onChange={(e) => setEnvDevice(e.target.value)} style={{ ...inputS, flex: 1 }}>
                <option value="">本机（这台电脑）</option>
                {envDevices.map((d) => (
                  <option key={d.did} value={d.did}>{d.name}{d.kind ? ` (${d.kind})` : ''}</option>
                ))}
              </select>
            </div>
            {envDevice && <div className="tinyd" style={{ color: '#0284c7' }}>→ 分享的是「{envDeviceName}」的桌面；你点卡打开时，myco 会在这台电脑上拉起客户端连过去。</div>}
            <button className="btnd" style={{ width: '100%' }} disabled={!!envBusy} onClick={() => void shareEnv('rdp')}>
              {envBusy === 'rdp' ? '创建中…' : '🖥 分享远程桌面环境'}
            </button>
            <button className="btnd" style={{ width: '100%' }} disabled={!!envBusy} onClick={() => void shareEnv('dsh')}>
              {envBusy === 'dsh' ? '创建中…' : '🌐 分享 DSH Web 环境'}
            </button>
            {/* 2026-11-01 自由远程桌面（方案见 design/07-connectivity/REMOTE-DESKTOP）：
                vnc 服务 Mac 屏幕共享 / Linux VNC（5900）；rustdesk 服务 Mac/Linux（IP 直连口）。
                本机没跑对应服务时打开会如实报「目标未提供 …服务」。 */}
            <button className="btnd ghost" style={{ width: '100%' }} disabled={!!envBusy} onClick={() => void shareEnv('vnc')}>
              {envBusy === 'vnc' ? '创建中…' : '🖥 分享 VNC 远程桌面（Mac/Linux）'}
            </button>
            <button className="btnd ghost" style={{ width: '100%' }} disabled={!!envBusy} onClick={() => void shareEnv('rustdesk')}>
              {envBusy === 'rustdesk' ? '创建中…' : '🦀 分享 RustDesk 远程桌面'}
            </button>
            <div className="tinyd" style={{ lineHeight: 1.6 }}>
              卡名：`【PC远程桌面】` / `【PC-DSH-Web】` / `【VNC远程桌面】` / `【RustDesk远程桌面】`；
              建卡的同时把卡发给当前会话（分享即授权）。
            </div>
          </div>
        )}
      </div>
      {/* 报错 + 提交底栏：不随字段滚动，填完即见（两模式共用报错行）。
          §3.23：转授走"请主人发卡"这条路时后端回的是**人话提示**（不是错误）→ 分开上色。 */}
      {err && <div className="tinyd" style={{ flexShrink: 0, color: '#e5534b', marginTop: 6 }}>{err}</div>}
      {note && <div className="tinyd" style={{ flexShrink: 0, color: '#0284c7', marginTop: 6 }}>{note}</div>}
      {mode === 'new' && (
        <div style={{ flexShrink: 0, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--bd,#e2e5ee)' }}>
          <button className="btnd" style={{ width: '100%' }} disabled={!canSubmit} onClick={() => void share(title.trim(), desc.trim(), reward.trim(), req.trim(), Number(days) || 0)}>
            {busy ? '分享中…' : '创建并分享任务卡'}
          </button>
        </div>
      )}
    </div>
  )
}

const inputS: React.CSSProperties = {
  border: '1px solid var(--bd,#e2e5ee)', borderRadius: 8, padding: '7px 9px', fontSize: 12.5, fontFamily: 'inherit', background: 'var(--surface,#fff)', color: 'var(--tx,#1c2333)',
}

/* ═══════════ 任务卡详情弹层（点气泡卡 → 详情 + 一起做） ═══════════ */

export function TaskDetailOverlay({ task, onClose, onChanged }: {
  task: { taskId: string; title: string; desc?: string; requirements?: string; rSpec?: { key: string; label?: string; target: unknown; unit?: string }[]; reward?: string; fromName?: string; expiresAt?: number; createdAt?: number; status?: string; participants?: TaskParticipant[] }
  onClose: () => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const expired = !!task.expiresAt && task.expiresAt < Date.now()
  const accepted = !!task.status && task.status !== 'pending'
  // 第83轮：参与方（多人协作感）——头像列表 + 各自状态
  const parts = task.participants ?? []
  const taskDone = task.status === 'done'
  const accept = async () => {
    setBusy(true); setErr(null)
    try {
      await invokeT('chat_accept_task', { taskId: task.taskId })
      await onChanged()
      onClose()
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 260, background: 'rgba(8,12,20,.66)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 320, borderRadius: 16, background: 'var(--chrome-bg,#fff)', padding: 16, boxShadow: '0 18px 48px rgba(8,12,20,.3)', maxHeight: '86vh', overflowY: 'auto' }}>
        <div style={{ height: 5, borderRadius: 3, background: expired ? '#9aa3b8' : 'linear-gradient(90deg,#6b7bff,#4ec9a5)', marginBottom: 10 }} />
        <div style={{ fontSize: 15.5, fontWeight: 800, color: 'var(--tx,#1c2333)', lineHeight: 1.4 }}>{cleanCardTitle(task.title || '') || '任务'}</div>
        <div style={{ fontSize: 11, color: 'var(--muted,#8a93a8)', margin: '3px 0 9px' }}>
          来自 {shortDid(task.fromName || '') || '好友'} 分享{task.reward ? ` · 奖励 ${task.reward}` : ''}{expired ? ' · 已过期' : ''}
        </div>
        {task.desc && (
          <>
            <div style={secLabelS}>介绍</div>
            <div style={secBodyS}>{task.desc}</div>
          </>
        )}
        {task.rSpec && task.rSpec.length > 0 && (
          <>
            <div style={secLabelS}>验收指标（r_spec）</div>
            {task.rSpec.map((r, i) => (
              <div key={i} style={{ ...secBodyS, display: 'flex', justifyContent: 'space-between' }}>
                <span>{r.label || r.key}</span>
                <b>{String(r.target)}{r.unit || ''}</b>
              </div>
            ))}
          </>
        )}
        {task.requirements && (
          <>
            <div style={secLabelS}>要求 / 验收</div>
            <div style={secBodyS}>{task.requirements}</div>
          </>
        )}
        {/* 第83轮：参与方列表（头像+名字+状态）——"多人一起齐心协力"的具象 */}
        {parts.length > 0 && (
          <>
            <div style={secLabelS}>一起完成的人（{parts.length}）</div>
            <div style={{ ...secBodyS, display: 'flex', flexDirection: 'column', gap: 5 }}>
              {parts.map((p) => (
                <div key={p.did} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                    background: p.role === 'owner' ? 'linear-gradient(135deg,#6b7bff,#5567f5)' : p.status === 'done' ? 'linear-gradient(135deg,#34d399,#10b981)' : 'linear-gradient(135deg,#fbbf24,#f59e0b)',
                    color: '#fff', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                    {(p.name || '灵').slice(0, 1)}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name || `…${p.did.slice(-6)}`}</span>
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: p.status === 'done' || taskDone ? '#22c55e' : 'var(--muted,#8a93a8)' }}>
                    {p.status === 'done' || taskDone ? '✓ 已完成' : p.role === 'owner' ? '发起人' : '进行中'}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
        {/* 第83轮：完成横幅——"N 人协作完成"的温馨收束 */}
        {taskDone && (
          <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 9, background: 'rgba(34,197,94,.10)', color: '#15803d', fontSize: 12.5, fontWeight: 800, textAlign: 'center' }}>
            🎉 {Math.max(parts.length, 1)} 人协作完成
          </div>
        )}
        {task.expiresAt && (
          <div style={{ fontSize: 10.5, color: expired ? '#e5534b' : 'var(--muted,#8a93a8)', marginTop: 6 }}>
            有效期至 {new Date(task.expiresAt).toLocaleString()}{expired ? '（已过期）' : ''}
          </div>
        )}
        {err && <div className="tinyd" style={{ color: '#e5534b', marginTop: 6 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btnd ghost" style={{ flex: 1 }} onClick={onClose}>关闭</button>
          {!accepted && (
            <button className="btnd" style={{ flex: 2, opacity: busy || expired ? 0.45 : 1 }} disabled={busy || expired} onClick={() => void accept()}>
              {expired ? '已过期' : busy ? '接受中…' : '🤝 一起做'}
            </button>
          )}
          {accepted && !taskDone && <div className="btnd ghost" style={{ flex: 2, textAlign: 'center', opacity: .8 }}>一起做 · 在任务列表</div>}
        </div>
      </div>
    </div>
  )
}
const secLabelS: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: '#8a93a8', margin: '8px 0 3px', letterSpacing: .4 }
const secBodyS: React.CSSProperties = { fontSize: 12.5, color: 'var(--tx,#1c2333)', lineHeight: 1.65, whiteSpace: 'pre-wrap', background: 'var(--surface-2,#f6f7fa)', borderRadius: 8, padding: '7px 9px' }

/* ═══════════ 分享范围与可见性（§3.22 s→o 投影 + §3.20 逐人覆盖，schema 驱动） ═══════════
 * 契约（后端钉死，照此对接，不新造命令/字段）：
 *   share_visibility(shareId)
 *     -> { ok, current, schema, allVisible, grants: [{ did, name, visibility: 原始值|null, effective }] }
 *   share_set_visibility(shareId, visibility)          -> 写**任务级**（整体）：{ ok, current }
 *   share_set_visibility(shareId, visibility{…did})    -> 写**该协作者**：{ ok, current, did, effective }
 *     （did 随 payload 走——后端从 payload 里读 did；会把值铺到该账号的**所有设备行**）
 *   Visibility = { space, sessions: string[], windowMs: number|null }
 *   Schema = { items: [ { id, label, kind:"enum"|"multi", options?:[{value,label}],
 *                         default, selectable: boolean, source?: "sessions", dependsOn? } ] }
 * 失败一律 promise reject（界面不判 ok:false）→ 本段一句话 + 重试，面板其余功能照常。
 *
 * 分层（**同一份 schema、同一套控件**，任务级与逐人不各画一遍）：
 *   useShareVisibility      一次读回 {整体当前值, schema, 逐人原始值/生效值}——两处共用，不 N+1 拉
 *   VisItemsEditor          纯画控件：enum→一排 chip 单选 / multi→多选 / dependsOn 联动 /
 *                           selectable:false→按默认值只读 / 不认识的 kind→只读一句话（不猜、不崩）
 *   VisibilitySectionBody   任务级（整体）：显式「保存范围」按钮
 *   MemberScopeBlock        逐人：摘要常显 + 展开编辑（「跟随整体范围」**一等选项**）
 * 人话红线：只出现 schema 给的 label——界面里不出现 space/windowMs/did/machine/session 这类内部词。
 * 保存策略＝显式按钮（不是每点一下就存）：范围是各项的**合成**，每点即存会写出
 * "只指定会话但一个都没选"这类半成品；也让用户能一次改完再落。 */

/** 面板级一句话反馈（成功绿 / 失败红，4.6s 自消）。 */
type Say = (text: string, bad?: boolean) => void

/** 「跟随整体」的人话口径：后端有**写 null 的清除通道**（2026-10-06 契约：
 *  `share_set_visibility(shareId, {did, visibility:null})` → 清除该人逐人覆盖，
 *  返回 `{ok, current:null, did, effective}`）。界面上这一态就是「跟随整体范围」。 */
const FOLLOW_LABEL = '跟随整体范围'
const FOLLOW_TIP = '跟着上面的整体范围走：整体怎么改，他就跟着改——这里不额外收紧。'

/* ── §3.22 项目档的「可选项目」（2026-10-18；2026-10-24 改多选）──
 * 历史：project 档只用「分享自身 cwd」判定且不显示具体项目 → 用户困惑。先加了单项目
 * `projectCwd`；现在用户口径改成「指定项目」**多选**（跟指定会话一样），契约：
 *   visibility.projects: string[]（项目 cwd 绝对路径列表；空 = 沿用分享自身 cwd）。
 * 项目清单数据源＝`share_visibility` 读命令附带的 `schema.workspaces.items`
 * （后端从会话 cwd 派生，与 GET /api/dshShare/sessions 的 workspaces 同源：value=cwd、label=项目名）。
 * 路径归一/比较的纯函数在 shareVisibility.ts（visSamePath / visPathTail / visPathParent）。
 * 兼容三种形状：顶层 `workspaces:[…]` / `workspaces:{items:[…]}` / `schema.workspaces.items`。 */
interface VisWorkspace { value: string; label: string }

/** 从读命令应答里取项目清单（容错三种形状；只留 value 非空的项，按路径去重）。 */
function visWorkspacesOf(r: unknown): VisWorkspace[] {
  const o = (r && typeof r === 'object' ? r : {}) as { workspaces?: unknown; schema?: { workspaces?: unknown } }
  const raw = o.workspaces !== undefined ? o.workspaces : o.schema?.workspaces
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items : [])
  const out: VisWorkspace[] = []
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    const row = it as { value?: unknown; label?: unknown }
    const value = typeof row.value === 'string' ? row.value.trim() : ''
    if (!value) continue
    if (out.some((w) => visSamePath(w.value, value))) continue
    const label = typeof row.label === 'string' && row.label.trim() !== '' ? row.label.trim() : visPathTail(value)
    out.push({ value, label })
  }
  return out
}
/** 读命令应答里的**分享自身 cwd**（生效项目默认值来源）：新契约 `share.cwd`，
 *  兼容顶层 `shareCwd` / `cwd`；都取不到 = 空串（界面退化，不编造项目名）。 */
function visShareCwdOf(r: unknown): string {
  const o = (r && typeof r === 'object' ? r : {}) as { share?: unknown; shareCwd?: unknown; cwd?: unknown }
  const inside = o.share && typeof o.share === 'object' ? (o.share as { cwd?: unknown }).cwd : undefined
  for (const v of [inside, o.shareCwd, o.cwd]) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return ''
}
/** visibility（或生效值）里的 `projectCwd`：只认非空字符串；null/缺键 = 沿用分享 cwd。 */
function visProjectCwdOf(v: Visibility | null | undefined): string {
  const p = v ? v['projectCwd'] : undefined
  return typeof p === 'string' ? p.trim() : ''
}
/** 项目人话名：先在项目清单里按路径找 label，找不到退回路径末段（不编造）。 */
function visProjectLabelOf(cwd: string, workspaces: VisWorkspace[]): string {
  const hit = workspaces.find((w) => visSamePath(w.value, cwd))
  return hit?.label || visPathTail(cwd)
}
/** 从读命令应答里取「会话 → cwd/项目归属」映射（2026-10-24 需求②）：
 *  后端可能放在 `schema.sessionCwds` / `schema.sessionProjects` / 顶层同名键；
 *  会话 option 自己带 cwd 的走 `visSessionCwdOf`（见 shareVisibility.ts）。
 *  多来源合并（后到的补齐）；一个都拿不到 = {} → 会话列表显示全部 + 灰字说明（不静默隐藏）。 */
function visSessionCwdsOfResponse(r: unknown): Record<string, string> {
  const o = (r && typeof r === 'object' ? r : {}) as {
    schema?: { sessionCwds?: unknown; sessionProjects?: unknown }
    sessionCwds?: unknown
    sessionProjects?: unknown
  }
  return {
    ...visSessionCwdsOf(o.schema?.sessionCwds),
    ...visSessionCwdsOf(o.schema?.sessionProjects),
    ...visSessionCwdsOf(o.sessionCwds),
    ...visSessionCwdsOf(o.sessionProjects),
  }
}

/** `share_visibility` 的逐人行：`visibility`=用户配的原始值（null=继承整体），
 *  `effective`=后端与整体取交后的**生效值**（只收紧不放大）。逐人写成功后两者都会更新。 */
interface VisGrantRow { did: string; name?: string; visibility?: Visibility | null; effective?: Visibility | null }

/** 可见范围的**一份**权威数据（整体 + schema + 逐人），整体段与逐人段共用（同一个命令只拉一次）。 */
interface ShareVisibilityState {
  current: Visibility | null
  items: VisItem[] | null
  grants: VisGrantRow[] | null
  /** 可选项目清单（`schema.workspaces.items`；读不到 = []——项目档退化为"沿用分享 cwd"）。 */
  workspaces: VisWorkspace[]
  /** 分享自身 cwd（`visibility.projectCwd` 为 null 时的**生效项目**来源；取不到 = ''）。 */
  shareCwd: string
  /** 会话 → cwd/项目归属映射（2026-10-24 需求②；后端在 schema.sessionCwds /
   *  schema.sessionProjects 或会话 option 自带字段里给；拿不到 = {} → 会话列表显示全部 + 灰字）。 */
  sessionCwds: Record<string, string>
  loadErr: string | null
  reload: () => Promise<void>
  /** 写成功后静默对齐（整体的改动会改到逐人的"实际能看到"）。 */
  silentReload: () => Promise<void>
  grantOf: (did: string) => VisGrantRow | null
  patchGrant: (did: string, patch: Partial<VisGrantRow>) => void
  setCurrent: (cur: Visibility) => void
}

function useShareVisibility(shareId: string): ShareVisibilityState {
  const [current, setCurrent] = useState<Visibility | null>(null)
  const [items, setItems] = useState<VisItem[] | null>(null)
  const [grants, setGrants] = useState<VisGrantRow[] | null>(null)
  const [workspaces, setWorkspaces] = useState<VisWorkspace[]>([])
  const [shareCwd, setShareCwd] = useState('')
  const [sessionCwds, setSessionCwds] = useState<Record<string, string>>({})
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const read = useCallback(() => invokeT<{
    current?: Visibility
    schema?: { items?: VisItem[]; workspaces?: unknown; sessionCwds?: unknown; sessionProjects?: unknown }
    grants?: VisGrantRow[]
    workspaces?: unknown; share?: { cwd?: string }; shareCwd?: string; cwd?: string
    sessionCwds?: unknown; sessionProjects?: unknown
  }>('share_visibility', { shareId }), [shareId])
  const reload = useCallback(async () => {
    setItems(null); setLoadErr(null)
    try {
      const r = await read()
      const its = Array.isArray(r?.schema?.items) ? r.schema.items.filter((x) => !!x && !!x.id) : []
      const cur = (r?.current && typeof r.current === 'object') ? r.current : {}
      setCurrent(cur); setItems(its)
      // 项目档：可选项目清单 + 分享自身 cwd（生效项目默认值）+ 会话→项目映射——同一份读命令带回
      setWorkspaces(visWorkspacesOf(r)); setShareCwd(visShareCwdOf(r)); setSessionCwds(visSessionCwdsOfResponse(r))
      // 逐人行：同一账号的多台设备**后端已合并成一行**（写的时候铺到该账号所有设备行），
      // 前端不重复合并（设备 did → 账号 did 的归并只在后端有），只按 did 兜底去重。
      const rows = Array.isArray(r?.grants) ? r.grants.filter((g) => !!g && !!g.did) : []
      setGrants(dedupeByDid(rows))
    } catch (e) { setLoadErr(briefErr(e)) }
  }, [read])
  useEffect(() => { void reload() }, [reload])
  /** 静默重拉（整体改完：逐人的"实际能看到"跟着变；schema 不动）。失败保留现有视图，不打扰用户。 */
  const silentReload = useCallback(async () => {
    try {
      const r = await read()
      if (r?.current && typeof r.current === 'object') setCurrent(r.current)
      if (Array.isArray(r?.grants)) setGrants(dedupeByDid(r.grants.filter((g) => !!g && !!g.did)))
      setWorkspaces(visWorkspacesOf(r)); setShareCwd(visShareCwdOf(r)); setSessionCwds(visSessionCwdsOfResponse(r))
    } catch { /* 保持现有视图 */ }
  }, [read])
  const grantOf = useCallback((did: string) => (grants ?? []).find((g) => g.did === did) ?? null, [grants])
  const patchGrant = useCallback((did: string, patch: Partial<VisGrantRow>) => {
    setGrants((prev) => (prev ?? []).map((g) => (g.did === did ? { ...g, ...patch } : g)))
  }, [])
  return { current, items, grants, workspaces, shareCwd, sessionCwds, loadErr, reload, silentReload, grantOf, patchGrant, setCurrent }
}

/** schema 驱动的控件组（任务级与逐人**共用同一套画法**，不抄两遍）：
 *  enum→一排 chip 单选 / multi→多选（清单读不到时退化为手填）/ dependsOn 不满足→整块不画 /
 *  selectable:false→按默认值只读 / 不认识的 kind→只读一句话（不猜语义、不崩）。
 *  **不写死三个控件**：画什么、什么标签、什么默认，全由后端给的 schema 决定。
 *  `ceilings`（只有逐人段给）= 整体天花板：**摆出来但点不动**——灰掉 + `title` 说为什么
 *  （用户口径：能选的直接灰，别隐藏；隐藏会让人以为"没这个功能"）。灰项照样显示，
 *  正是为了教用户"整体是天花板"。 */
function VisItemsEditor({ items, current, draft, setDraft, lockedTitle, ceilings, notes }: {
  items: VisItem[]
  /** 值兜底（草稿缺项时用它；逐人那边传"起手的那一份"）。 */
  current: Visibility | null
  draft: Record<string, unknown>
  setDraft: React.Dispatch<React.SetStateAction<Record<string, unknown>>>
  /** 只读项 chip 的悬停说明（任务级/逐人两种口吻）。 */
  lockedTitle?: string
  /** 逐人的整体天花板（缺省 = 不挡任何项：任务级编辑自己就是天花板）。 */
  ceilings?: Record<string, VisCeiling>
  /** 每项下方的补充说明（按项 id，灰字）。例：会话已按项目筛选、多少个被隐藏——
   *  2026-10-24 需求②「拿不到映射显示全部+灰字说明，不要静默隐藏」。 */
  notes?: Record<string, string>
}) {
  /** 手填会话（清单读不到时的退化输入），按项 id 分开存，避免两项抢一个输入框。 */
  const [manual, setManual] = useState<Record<string, string>>({})
  /** 依赖项取值（草稿优先）——dependsOn 用它判联动。 */
  const valOf = useCallback((id: string): unknown => (
    id in draft ? draft[id] : (current ? current[id] : undefined)
  ), [draft, current])
  const setVal = (id: string, v: unknown) => setDraft((d) => ({ ...d, [id]: v }))
  const togglePick = (id: string, v: string) => setDraft((d) => {
    const cur = visAsList(d[id])
    return { ...d, [id]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] }
  })
  /** 手填添加：逗号/顿号/分号/空格都算分隔，去重保序。 */
  const addManual = (id: string) => {
    const add = splitSessionIds(manual[id] ?? '')
    if (!add.length) return
    setDraft((d) => {
      const next = visAsList(d[id])
      for (const x of add) if (!next.includes(x)) next.push(x)
      return { ...d, [id]: next }
    })
    setManual((m) => ({ ...m, [id]: '' }))
  }
  /** 一项 = 标题行（+「默认」标记）+ 按 kind 画的控件；依赖不满足 → 整块不画。 */
  ensureFzStyle()
  const renderItem = (it: VisItem) => {
    const id = String(it.id ?? '')
    if (!id || !visItemVisible(it, valOf)) return null
    const locked = it.selectable === false
    const ceil = ceilings?.[id]
    /** 整体天花板挡住了这个值吗（挡住了就灰 + 一个 title 说为什么）。 */
    const blockedBy = (value: unknown) => (ceil?.disabled ?? []).find((x) => visEq(x.value, value))
    const val = visValueOf(it, current, draft)
    const opts = (it.options ?? []).filter((o) => !!o && o.value !== undefined)
    const kind = it.kind === 'enum' || it.kind === 'multi' ? it.kind : ''
    const label = it.label || '这一项'
    return (
      <div key={id} style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--tx,#1c2333)' }}>{label}</span>
          {locked && <span className="chipd gray" style={{ fontSize: 10, padding: '1px 7px' }} title={lockedTitle || '这项按默认走，界面里不开放修改'}>默认</span>}
        </div>
        {kind === 'enum' && opts.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {opts.map((o) => {
              const on = visEq(o.value, val)
              const blk = blockedBy(o.value)
              return (
                // 可点=pointer+hover 实色；被挡/只读=FZ_BLOCKED 灰掉 + title 说为什么（§3.10：被挡=灰+说明）
                <span key={String(o.value)} className={`${on ? 'chipd' : 'chipd gray'}${locked || blk ? '' : ' fz-hover'}`}
                  title={locked ? (lockedTitle || '这项按默认走，暂时不能改') : (blk?.title || o.label || '')}
                  onClick={locked || blk ? undefined : () => setVal(id, o.value)}
                  style={{
                    ...FZ_OPT_CHIP, fontWeight: on ? 700 : 500,
                    ...(locked || blk ? FZ_BLOCKED : { cursor: 'pointer' }),
                    opacity: blk ? .45 : locked && !on ? .5 : 1,
                  }}>
                  {o.label || String(o.value ?? '')}
                </span>
              )
            })}
          </div>
        )}
        {/* 三档人话解释（2026-10-18；2026-10-24 项目档改「指定项目」多选）：此前只有档位
            名字，用户不知道"项目档"到底开放什么、也不知道默认用的是哪个项目。 */}
        {id === 'space' && kind === 'enum' && (
          <div className="tinyd" style={{ ...FZ_META, marginTop: 5 }}>
            整机 = 这台机器上的全部会话与工作区；指定项目 = 只开放所选项目下的会话与工作区（不选 = 沿用当前分享所在项目）；指定会话 = 只开放勾选的那几个会话。
          </div>
        )}
        {kind === 'enum' && opts.length === 0 && (
          <div className="tinyd" style={{ ...FZ_META, marginTop: 4 }}>这项眼下没有可选项——先按默认走，不影响别的项</div>
        )}
        {kind === 'multi' && (() => {
          const picked = visAsList(val)
          const box = { ...inputS, padding: '6px 8px', fontSize: 12 } as const
          return (
            <div style={{ marginTop: 6 }}>
              {opts.length > 0 && (
                <div style={{ maxHeight: 132, overflowY: 'auto', border: '1px solid var(--bd,#e2e5ee)', borderRadius: 8, padding: '3px 6px' }}>
                  {opts.map((o) => {
                    const v = String(o.value ?? '')
                    const blk = blockedBy(v)
                    // `title` 给外层 label：原生 disabled 的 checkbox 收不到 hover（灰了也得让人问得着"为什么"）。
                    return (
                      <label key={v} title={blk?.title} className={locked || blk ? '' : 'fz-hover'}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, padding: '3px 4px', borderRadius: 6, cursor: (locked || blk) ? 'not-allowed' : 'pointer', ...(blk ? { opacity: .55 } : {}) }}>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--tx,#1c2333)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label || visShortId(v)}</span>
                        <input type="checkbox" checked={picked.includes(v)} disabled={locked || !!blk}
                          onChange={blk || locked ? undefined : () => togglePick(id, v)} style={{ flexShrink: 0 }} />
                      </label>
                    )
                  })}
                </div>
              )}
              {(ceil?.disabled.length ?? 0) > 0 && (
                <div className="tinyd" style={{ ...FZ_META, marginTop: 5 }}>{ceil?.disabled[0].title}——整体现在开放的会话都在上面，勾掉还能再收。</div>
              )}
              {/* 后端附的 `truncated:true`——清单超 50 条被截断（用户口径：别静默丢，说一声）。 */}
              {it.truncated === true && (
                <div className="tinyd" style={{ ...FZ_META, marginTop: 5 }}>会话太多，只列出最近 50 条——要找更早的，直接填会话编号</div>
              )}
              {/* 清单读不到 → 退化手填。注意：**按项目筛选把候选筛空**不算"读不到"
                  （notes 有说明）——那种情况不能退化成手填（填进去后端也会按项目拒）。 */}
              {opts.length === 0 && !notes?.[id] && (
                <div>
                  {picked.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {picked.map((v) => (
                        <span key={v} className="chipd gray" title={v} style={{ ...FZ_OPT_CHIP, maxWidth: '100%' }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{visShortId(v)}</span>
                          {!locked && <span style={{ cursor: 'pointer', opacity: .7 }} onClick={() => togglePick(id, v)}>✕</span>}
                        </span>
                      ))}
                    </div>
                  )}
                  {!locked && (
                    <div style={{ display: 'flex', gap: 6, marginTop: picked.length > 0 ? 6 : 0 }}>
                      <input value={manual[id] ?? ''} onChange={(e) => setManual((m) => ({ ...m, [id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') addManual(id) }}
                        placeholder="填会话编号（多个用逗号或空格分开）" style={{ ...box, flex: 1, minWidth: 0 }} />
                      <button className="btnd small ghost" onClick={() => addManual(id)}>添加</button>
                    </div>
                  )}
                  {/* 后端附的 `optionsError`（一句人话，如"本机 DSH 没在运行——…"）原文直接上屏，
                      取代本地笼统的"读不到"提示——后端才知道真实原因；截断说明照样给（手填不受影响）。 */}
                  <div className="tinyd" style={{ ...FZ_META, marginTop: 4 }}>
                    {it.optionsError || '可选清单暂时读不到——直接填会话编号也认，只影响这一项'}
                  </div>
                  {it.truncated === true && (
                    <div className="tinyd" style={{ ...FZ_META, marginTop: 4 }}>会话太多，只列出最近 50 条——要找更早的，直接填会话编号</div>
                  )}
                </div>
              )}
            </div>
          )
        })()}
        {!kind && (
          <div className="tinyd" style={{ ...FZ_META, marginTop: 4 }}>这项的配置方式界面还不认识——按默认走，不影响别的项</div>
        )}
        {/* 本项补充说明（灰字；会话按项目筛选的结果/拿不到映射的说明走这里——不静默隐藏） */}
        {notes?.[id] && (
          <div className="tinyd" style={{ ...FZ_META, marginTop: 4 }}>{notes[id]}</div>
        )}
      </div>
    )
  }
  return <>{items.map(renderItem)}</>
}

/** 任务级「分享范围与可见性」（导出：别的入口可复用；不给 `vis` 就自己拉一份）。 */
export function ShareVisibilitySection({ shareId, say, vis }: {
  shareId: string
  say: Say
  /** 面板已经把可见范围读回来了就传进来（整体段与逐人段共用同一份，避免各拉一次）。 */
  vis?: ShareVisibilityState
}) {
  return vis
    ? <VisibilitySectionBody shareId={shareId} say={say} vis={vis} />
    : <StandaloneVisibilitySection shareId={shareId} say={say} />
}
function StandaloneVisibilitySection({ shareId, say }: { shareId: string; say: Say }) {
  const vis = useShareVisibility(shareId)
  return <VisibilitySectionBody shareId={shareId} say={say} vis={vis} />
}

/** 任务级这一段的本体：只写"整体"（不带 did）；逐人入口在下面每个人那一块。 */
function VisibilitySectionBody({ shareId, say, vis }: { shareId: string; say: Say; vis: ShareVisibilityState }) {
  const { current, items, loadErr } = vis
  /** 草稿（用户手里的那份）与基线（上一次"已保存"的那份，用于脏标记与回滚）。 */
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [base, setBase] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  /** 显示层 items：project 档统一叫「指定项目」（schema 的 label 可能是旧的单项目名；
   *  只覆盖显示，取值/回写体不动——见 shareVisibility.visDisplayItems）。 */
  const displayItems = useMemo(() => visDisplayItems(items) ?? [], [items])
  /** 草稿初值：schema 各项 + 合成键 `projects`（顶层契约字段，不在 schema items 里）：
   *  新记录用 visibility.projects；旧记录只有单值 projectCwd → 回填成 [projectCwd]
   *  （既在多选里显示，保存时也自然迁移到 projects）。 */
  const draftFrom = (cur: Visibility | null): Record<string, unknown> => {
    const d = visDraftFrom(cur, displayItems)
    const projs0 = visProjectsOf(cur)
    const legacy = visProjectCwdOf(cur)
    d['projects'] = projs0.length > 0 ? projs0 : (legacy !== '' ? [legacy] : [])
    return d
  }
  /** 后端权威值一变（首次读到 / 保存成功 / 写后静默对齐）→ 草稿与基线跟着它对齐。 */
  const curKey = JSON.stringify(current ?? {})
  const itemsKey = JSON.stringify(items ?? [])
  useEffect(() => {
    const d = draftFrom(current)
    setDraft(d); setBase(d)
  }, [curKey, itemsKey])

  const dirty = visTouched(base, draft)
  const spaceNow = String((draft['space'] ?? current?.['space'] ?? '') || '')
  /** 当前草稿里的项目白名单（多选；空 = 沿用分享自身 cwd）。 */
  const projs = visProjectsOf(draft)
  /** 默认项目（不勾任何项目时用的那个）：label 依次取项目清单、分享 cwd 末段、schema 旧
   *  project 选项括号里的项目名——后端有没有给 share.cwd 都能说人话，不编造。 */
  const projOptionLabel = String(
    ((items ?? []).find((it) => it.id === 'space')?.options ?? []).find((o) => visEq(o.value, 'project'))?.label ?? '')
  const projOptionHint = (/[（(]([^（）()]+)[）)]\s*$/.exec(projOptionLabel)?.[1] ?? '').trim()
  const defaultProjLabel = (vis.shareCwd ? visProjectLabelOf(vis.shareCwd, vis.workspaces) : '') || projOptionHint
  const projLabelOf = (cwd: string) => visProjectLabelOf(cwd, vis.workspaces) || visPathTail(cwd) || cwd
  /** 勾选/取消勾选一个项目（多选；路径归一比较——同一个项目两种写法算一个）。 */
  const toggleProject = (value: string) => setDraft((d) => {
    const cur = visProjectsOf(d)
    const on = cur.some((x) => visSamePath(x, value))
    return { ...d, projects: on ? cur.filter((x) => !visSamePath(x, value)) : [...cur, value] }
  })
  /** 会话勾选先按项目筛（需求②，2026-10-24）：space=session 且选了项目时，候选 = 属于所选
   *  项目的会话（用 option 自带的 cwd / schema 级映射）。拿不到映射 → 显示全部 + 灰字说明
   *  （不静默隐藏）；归属不明的候选在被筛时也不放行（与后端 enforcement 同口径）。
   *  清单本身读不到（没有 options）→ 不筛（保留原有"直接填会话编号"的退化路径）。 */
  const sessionsItem = spaceNow === 'session' && projs.length > 0
    ? displayItems.find((it) => it.id === 'sessions') : undefined
  const sessionFilter = sessionsItem && (sessionsItem.options ?? []).length > 0
    ? visFilterSessionsByProjects(visApplySessionCwds(sessionsItem.options ?? [], vis.sessionCwds), projs)
    : null
  const editItems = sessionFilter && sessionsItem
    ? displayItems.map((it) => (it === sessionsItem ? { ...it, options: sessionFilter.items } : it))
    : displayItems
  const pickedOutside = sessionFilter && sessionFilter.mapped
    ? visAsList(draft['sessions']).filter((sid) => !sessionFilter.items.some((o) => String(o.value ?? '') === sid))
    : []
  const sessionNotes: Record<string, string> | undefined = (() => {
    if (!sessionFilter) return undefined
    if (!sessionFilter.mapped) {
      return { sessions: '拿不到会话属于哪个项目——先显示全部会话；保存后后端仍会按所选项目筛。' }
    }
    if (sessionFilter.items.length === 0) {
      const why = pickedOutside.length > 0 ? `（已选的 ${pickedOutside.length} 个都不在所选项目内）` : ''
      return { sessions: `已按所选项目筛选：没有属于所选项目的会话${why}——换项目，或清空「指定项目」看全部。` }
    }
    const hidden = sessionFilter.hidden + sessionFilter.hiddenUnknown
    const parts = [`已按所选项目筛选：只显示 ${sessionFilter.items.length} 个属于所选项目的会话。`]
    if (hidden > 0) parts.push(`另有 ${hidden} 个不在所选项目内或归属不明，已隐藏（后端同样不会放行）。`)
    if (pickedOutside.length > 0) parts.push(`已选的 ${pickedOutside.length} 个会话不在所选项目内，保存后不会生效。`)
    return { sessions: parts.join('') }
  })()

  /** 保存：乐观（先把基线推到草稿＝标记立刻消失）→ 成功后以后端回的 current 为准
   *  → 失败回滚乐观标记。**失败不吞用户输入**：草稿留着，再点一次即可（手填的编号
   *  重打一遍代价太高，回滚值反而更伤——回滚的是"已保存"这个声明，不是用户的编辑）。 */
  const save = async () => {
    if (saving || items === null) return
    const prevBase = base
    setSaving(true); setBase(draft)
    try {
      // 完整回写体（2026-10-24 契约）：schema 各项走 buildVisibility 口径；顶层
      // `projects`/`projectCwd` 由 buildVisibilityPayload 收口——
      //   project 档 = projects 白名单（空 = 沿用分享 cwd）；
      //   session 档 = projects 先筛、sessions 再筛；
      //   machine 档 projects=[]（不生效但形状一致）；projectCwd 统一 null（旧字段收口）。
      const spec = buildVisibilityPayload(current, displayItems, draft)
      const r = await invokeT<{ current?: Visibility }>('share_set_visibility', {
        shareId, visibility: spec,
      })
      const cur = (r?.current && typeof r.current === 'object') ? r.current : spec
      vis.setCurrent(cur)
      const d = draftFrom(cur)
      setDraft(d); setBase(d)
      // 整体的改动会改到逐人的"实际能看到"——静默对齐（失败保留现有视图，不打扰）
      void vis.silentReload()
      say('分享范围已更新——对方能看到的就按这一份算')
    } catch (e) {
      setBase(prevBase)
      say(`没能保存分享范围（${briefErr(e)}）——改动还留着，可以再点保存`, true)
    } finally { setSaving(false) }
  }
  const reset = () => {
    const d = draftFrom(current)
    setDraft(d); setBase(d)
    say('已撤销未保存的改动')
  }

  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--bd,#e2e5ee)' }}>
      <div className="h2d" style={{ fontSize: 12.5 }}>分享范围与可见性</div>
      <div className="tinyd" style={{ ...FZ_META, marginTop: 3 }}>这里管"整体能看到什么"：范围外的内容对方根本收不到（不是灰掉，是转发时就被挡在外面）。逐个人再开哪几项、各自再收多窄，看下面每个人那一块。</div>
      {loadErr && (
        <div className="cardd" style={{ marginTop: 8 }}>
          <div className="tinyd" style={{ ...FZ_META, color: '#e5534b' }}>分享范围暂时读不到（{loadErr}）——面板其它功能不受影响</div>
          <button className="btnd small ghost" style={{ marginTop: 6 }} onClick={() => void vis.reload()}>重试</button>
        </div>
      )}
      {items === null && !loadErr && <div className="tinyd" style={{ ...FZ_META, marginTop: 8 }}>分享范围加载中…</div>}
      {items !== null && items.length === 0 && <div className="tinyd" style={{ ...FZ_META, marginTop: 8 }}>这个分享暂时没有可配的范围项</div>}
      {items !== null && <VisItemsEditor items={editItems} current={current} draft={draft} setDraft={setDraft} notes={sessionNotes} />}
      {/* 项目档（2026-10-24 用户需求）：从「只这一个项目」改为「指定项目」**多选**（跟指定
          会话一样）。一个都不勾 = 沿用分享自身 cwd（显示为当前分享所在项目）；勾多个 =
          只开放这些项目下的会话与工作区。选择只改草稿，落盘仍走「保存范围」（范围是各项合成）。 */}
      {items !== null && spaceNow === 'project' && (
        <div style={{ marginTop: 10, padding: '8px 9px', borderRadius: 10, border: '1px solid var(--bd,#e2e5ee)', background: 'var(--surface-2,#f6f7fa)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--tx,#1c2333)' }}>指定项目</span>
            {projs.length > 0
              ? <span className="chipd" style={{ fontSize: 10.5, padding: '2px 8px', background: 'rgba(107,123,255,.10)', color: '#4c5bd4' }}>已选 {projs.length} 个</span>
              : (
                <span className="chipd gray" title={vis.shareCwd || undefined}
                  style={{ fontSize: 10.5, padding: '2px 8px', maxWidth: 224, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  未选 · 沿用分享所在项目{defaultProjLabel ? `（${defaultProjLabel}）` : ''}
                </span>
              )}
          </div>
          <div className="tinyd" style={{ ...FZ_META, marginTop: 4 }}>
            勾选一个或多个项目：只开放这些项目下的会话与工作区。一个都不勾 = 沿用当前分享所在项目（默认）。
          </div>
          {vis.workspaces.length === 0 ? (() => {
            // 项目清单读不到时的兜底：把"分享所在项目/旧单项目值"摆成可勾选的一行，不让用户没得选
            const cwd = projs[0] ?? vis.shareCwd ?? ''
            const lb = cwd !== '' ? projLabelOf(cwd) : defaultProjLabel
            const on = projs.length > 0
            return (
              <div style={{ marginTop: 6 }}>
                <label className="fz-hover" title={cwd || undefined}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 5px', borderRadius: 6, cursor: 'pointer' }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--tx,#1c2333)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    分享所在项目{lb ? ` · ${lb}` : ''}
                  </span>
                  <input type="checkbox" checked={on}
                    onChange={() => setDraft((d) => ({ ...d, projects: on ? [] : (cwd !== '' ? [cwd] : []) }))}
                    style={{ flexShrink: 0 }} />
                </label>
                <div className="tinyd" style={{ ...FZ_META, marginTop: 4 }}>
                  项目清单暂时读不到——默认沿用当前分享所在项目{lb ? `（${lb}）` : ''}；勾上 = 只开放它，取消 = 默认。
                </div>
              </div>
            )
          })() : (
            <div style={{ maxHeight: 168, overflowY: 'auto', marginTop: 6, border: '1px solid var(--bd,#e2e5ee)', borderRadius: 8, padding: '3px 6px', background: 'var(--surface,#fff)' }}>
              {vis.workspaces.map((w) => {
                const picked = projs.some((p) => visSamePath(p, w.value))
                return (
                  <label key={w.value} title={w.value} className="fz-hover"
                    style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, padding: '3px 4px', borderRadius: 6, cursor: 'pointer' }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--tx,#1c2333)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.label}</span>
                    {/* 同名项目（末段目录名相同）：父目录提示用来区分，不上整条长路径 */}
                    <span className="tinyd" style={{ ...FZ_META, fontSize: 10, flexShrink: 0 }}>{visPathParent(w.value)}</span>
                    <input type="checkbox" checked={picked} onChange={() => toggleProject(w.value)} style={{ flexShrink: 0 }} />
                  </label>
                )
              })}
              {/* 已选但不在清单里的项目（清单刷新/项目不在本机了）——显示出来可取消，不静默丢 */}
              {projs.filter((p) => !vis.workspaces.some((w) => visSamePath(w.value, p))).length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 5 }}>
                  {projs.filter((p) => !vis.workspaces.some((w) => visSamePath(w.value, p))).map((p) => (
                    <span key={p} className="chipd gray" title={p} style={{ ...FZ_OPT_CHIP, maxWidth: '100%' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{projLabelOf(p)}</span>
                      <span style={{ cursor: 'pointer', opacity: .7 }} onClick={() => toggleProject(p)}>✕</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {projs.length > 0 && (
            <button className="btnd small ghost" style={{ marginTop: 6 }}
              onClick={() => setDraft((d) => ({ ...d, projects: [] }))}>清空（用分享所在项目）</button>
          )}
        </div>
      )}
      {items !== null && items.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <button className="btnd small" disabled={!dirty || saving} style={{ opacity: (!dirty || saving) ? .55 : 1 }}
            onClick={() => void save()}>{saving ? '保存中…' : '保存范围'}</button>
          {dirty && !saving && <button className="btnd small ghost" onClick={reset}>撤销改动</button>}
          <span className="tinyd" style={{ ...FZ_META, color: dirty ? '#e65100' : undefined }}>{saving ? '正在保存…' : dirty ? '有改动还没保存' : '已保存'}</span>
        </div>
      )}
    </div>
  )
}

/** 逐人「可见范围」（§3.20）：**摘要常显**（人话）→ 展开编辑。
 *  · 「跟随整体范围」是**一等选项**（对应后端读回的 `visibility === null`；保存写真
 *    `null` 走后端清除通道，2026-10-06 契约，见 FOLLOW_LABEL 头注）；
 *  · 「单独指定」= 同一套 schema 控件（VisItemsEditor，与上面整体段共用），起手值取他**现在**
 *    能看到的那一份（整体值或他已收窄的值），再往里收；
 *  · 脏判定（`visGrantDirty`）：**基线 = 展开那一刻的快照**（模式 + 值同源对齐）——
 *    展开不脏；切到「单独指定」= 偏离"跟随"这个基线状态才算改动；切回「跟随整体范围」
 *    回到不脏；单独指定下只有 `draft ≠ 基线`（用户真正动过）才脏；
 *  · 保存 = 一次 `share_set_visibility`（payload 带该人的 did → 后端铺到该账号**所有设备行**：
 *    设备成员跟随主设备/账号）；乐观更新（摘要立刻变；生效值等后端回话）+ 失败回滚 + 一句话；
 *  · 「他实际能看到」常显后端算的生效值——逐人只能收紧，改完立刻看得见结果，不用猜。
 *  owner 不画这个入口（后端也拒：分享者本人不受限）。 */
function MemberScopeBlock({ shareId, did, name, taskCurrent, items, sessionCwds, grant, patchGrant, say }: {
  shareId: string
  did: string
  name: string
  /** 整体当前值（"跟随整体"跟的就是它）。 */
  taskCurrent: Visibility | null
  items: VisItem[]
  /** 会话→项目归属映射（整体项目范围先筛会话候选用；拿不到 = {} → 全部+灰字）。 */
  sessionCwds: Record<string, string>
  /** 这个人的逐人行（借"未收窄"判定；可能为 null——那按"跟随整体"处理）。 */
  grant: VisGrantRow | null
  patchGrant: (did: string, patch: Partial<VisGrantRow>) => void
  say: Say
}) {
  const saved = grant?.visibility ?? null
  const savedFollow = visNotNarrowed(saved)
  /** 起手基准：已收窄 → 他的逐人值；继承/全宽 → 整体当前值。 */
  const seedSource = savedFollow ? taskCurrent : saved
  const seed = () => visGrantStart(saved, taskCurrent, items)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<VisGrantMode>(savedFollow ? 'follow' : 'custom')
  /** 基线模式（展开那一刻与"已保存"状态对齐；dirty 只跟这份快照比，不跟"活的" grant 行比）。 */
  const [baseMode, setBaseMode] = useState<VisGrantMode>(savedFollow ? 'follow' : 'custom')
  const [base, setBase] = useState<Record<string, unknown>>(seed)
  const [draft, setDraft] = useState<Record<string, unknown>>(seed)
  const [saving, setSaving] = useState(false)
  const dirty = visGrantDirty(baseMode, mode, base, draft)
  /** 整体天花板（纯函数算，单测覆盖）：哪些可选项点不动 + 为什么。整体最宽（整机 + 不限历史）
   *  ⇒ 全空 ⇒ 现状不变。`valOf` 走草稿优先（与 VisItemsEditor 里判联动同一口径）。 */
  const ceilings = useMemo(() => visCeilings(taskCurrent, (id) => (id in draft ? draft[id] : seedSource?.[id]), items),
    [taskCurrent, draft, seedSource, items])
  /** 会话勾选先按**整体项目白名单**筛（与整体段同一口径，2026-10-24）：
   *  整体选了项目 → 逐人候选中只留属于这些项目的会话；拿不到映射 → 全部 + 灰字说明。 */
  const sessionFilter = (() => {
    const space = String(draft['space'] ?? seedSource?.['space'] ?? '')
    const overallProjs = visProjectsOf(taskCurrent)
    if (space !== 'session' || overallProjs.length === 0) return null
    const it = items.find((x) => x.id === 'sessions')
    if (!it || !(it.options ?? []).length) return null
    return visFilterSessionsByProjects(visApplySessionCwds(it.options, sessionCwds), overallProjs)
  })()
  const editItems = sessionFilter
    ? items.map((x) => (x.id === 'sessions' ? { ...x, options: sessionFilter.items } : x))
    : items
  const filterNotes: Record<string, string> | undefined = !sessionFilter ? undefined
    : !sessionFilter.mapped
      ? { sessions: '拿不到会话属于哪个项目——先显示全部会话（整体已选项目，保存后后端会按项目筛）。' }
      : {
        sessions: `已按整体的项目范围筛选：只显示 ${sessionFilter.items.length} 个属于这些项目的会话`
          + `${(sessionFilter.hidden + sessionFilter.hiddenUnknown) > 0
            ? `；另有 ${sessionFilter.hidden + sessionFilter.hiddenUnknown} 个不在项目内/归属不明已隐藏` : ''}。`,
      }

  /** 展开/撤销/保存成功时**重新起手**：draft = 基线 = 起手值（同源快照），模式基线也对齐
   *  到"已保存"的状态（用户已有的改动不被这次对齐吃掉——只有未改动才由调用方重起）。 */
  const reseed = () => {
    const d = seed()
    const m: VisGrantMode = savedFollow ? 'follow' : 'custom'
    setBase(d); setDraft(d); setMode(m); setBaseMode(m)
  }
  const toggleOpen = () => { if (!open) reseed(); setOpen(!open) }
  const pickFollow = () => setMode('follow')
  const pickCustom = () => { if (!visTouched(base, draft)) reseed(); setMode('custom') }

  /** 保存：乐观（先把这一行推到"已保存"的样子，摘要立刻变）→ 后端回话为准 → 失败回滚到点击前的快照。
   *  「跟随整体范围」= 传**真 `null`**（后端清除通道：清除该人所有设备行的逐人覆盖；
   *  旧后端不认 null 会 reject → 就地红字「没能保存…」，**绝不**静默退回"最宽的一份"——那是被替换的语义）。
   *  **失败不吞用户输入**：编辑留着，再点一次即可（与上面整体段同款纪律）。 */
  const save = async () => {
    if (saving) return
    const modeBefore = mode
    const baseModeBefore = baseMode
    const draftBefore = draft
    const baseBefore = base
    const prev: Partial<VisGrantRow> = { visibility: grant?.visibility ?? null, effective: grant?.effective }
    const spec: Visibility | null = mode === 'follow' ? null : buildVisibility(seedSource, items, draft)
    setSaving(true)
    patchGrant(did, { visibility: spec, effective: undefined }) // 生效值等后端回话（这里是"希望值"）
    try {
      const r = await invokeT<{ current?: Visibility | null; effective?: Visibility | null }>('share_set_visibility', {
        shareId,
        // did 随调用参数顶层走（后端从这里读 did = 写该人，铺到他所有设备行）；
        // 跟随整体 = visibility 传真 null（不是空对象）；单独指定 = payload 内嵌一份 did 兼容旧形态。
        visibility: visGrantPayload(spec, did),
        did,
      })
      // 清除通道回 `current:null`（跟随）；旧后端非 null 路径回对象——两种都按"后端权威"收。
      const cur = (r?.current && typeof r.current === 'object') ? r.current : spec
      const eff = (r?.effective && typeof r.effective === 'object') ? r.effective : prev.effective
      patchGrant(did, { visibility: cur, effective: eff })
      const m: VisGrantMode = visNotNarrowed(cur) ? 'follow' : 'custom'
      setMode(m); setBaseMode(m)
      const d = visGrantStart(cur, taskCurrent, items)
      setBase(d); setDraft(d)
      say(`已保存「${name}」的可见范围：${visScopeLabel(cur, items, FOLLOW_LABEL)}`)
    } catch (e) {
      patchGrant(did, prev)
      setMode(modeBefore); setBaseMode(baseModeBefore); setBase(baseBefore); setDraft(draftBefore)
      say(`没能保存「${name}」的可见范围（${briefErr(e)}）——已还原`, true)
    } finally { setSaving(false) }
  }
  const reset = () => {
    reseed() // 回到基线：值与模式都还原成"已保存"的那份
    say('已撤销这个人的改动')
  }

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--bd,#e2e5ee)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--tx,#1c2333)' }}>可见范围</span>
        <span className="chipd gray"
          style={{ fontSize: 10, padding: '2px 8px', maxWidth: 156, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={savedFollow ? FOLLOW_TIP : `只给他收窄到：${visScopeLabel(saved, items)}`}>
          {visScopeLabel(saved, items, FOLLOW_LABEL)}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btnd small ghost" onClick={toggleOpen}>{open ? '收起' : '调整'}</button>
      </div>
      {open && (
        <div style={{ marginTop: 7, padding: '8px 9px', borderRadius: 10, border: '1px solid var(--bd,#e2e5ee)', background: 'var(--surface,#fff)' }}>
          {/* 「跟随整体范围 / 单独指定」分段切换（跟随=一等选项；选中态=实色 chip） */}
          <SegTabs
            options={[{ key: 'follow', label: FOLLOW_LABEL }, { key: 'custom', label: '单独指定' }]}
            value={mode}
            onPick={(k) => (k === 'follow' ? pickFollow() : pickCustom())}
            tips={{ follow: FOLLOW_TIP, custom: '只给这个人单独设一份：整体以后放宽，也不会带上他' }} />
          {/* 整体基线（**只读**，人话）：先说清"整体现在是什么"，再标出天花板——这样下面
              那些灰掉的项才读得懂（用户口径：不能选的直接灰掉，别隐藏）。 */}
          <div className="tinyd" style={{ ...FZ_META, marginTop: 7, padding: '6px 8px', borderRadius: 8, background: 'var(--surface-2,#f6f7fa)' }}>
            <div>整体现在是：{visCeilingLabel(taskCurrent, items)}</div>
            <div style={{ marginTop: 2 }}>他最多能看到这些；这里只能再收紧。</div>
          </div>
          {mode === 'follow'
            ? <div className="tinyd" style={{ ...FZ_META, marginTop: 6 }}>{FOLLOW_TIP}整体现在是「{visCeilingLabel(taskCurrent, items)}」。</div>
            : (
              <>
                <div className="tinyd" style={{ ...FZ_META, marginTop: 6 }}>在他现在能看到的那一份上往里收：逐个人只会更窄，不会比整体更大。</div>
                <VisItemsEditor items={editItems} current={seedSource} draft={draft} setDraft={setDraft}
                  lockedTitle="这项按整体走，这里不开放修改" ceilings={ceilings} notes={filterNotes} />
                {ceilings.sessions?.locked && !(items.find((x) => x.id === 'sessions')?.options?.length ?? 0) && (
                  <div className="tinyd" style={{ ...FZ_META, marginTop: 4 }}>{ceilings.sessions.lockedTitle}——整体把会话限定死了，这里没法另填</div>
                )}
              </>
            )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <button className="btnd small" disabled={!dirty || saving} style={{ opacity: (!dirty || saving) ? .55 : 1 }}
              onClick={() => void save()}>{saving ? '保存中…' : '保存他的可见范围'}</button>
            {dirty && !saving && <button className="btnd small ghost" onClick={reset}>撤销</button>}
            {dirty && !saving && <span className="tinyd" style={{ ...FZ_META, color: '#e65100' }}>有改动还没保存</span>}
          </div>
          <div className="tinyd" style={{ ...FZ_META, marginTop: 6 }}>
            {saving ? '正在生效…' : `他实际能看到：${visScopeLabel(grant?.effective ?? saved, items, FOLLOW_LABEL)}`}
          </div>
        </div>
      )}
    </div>
  )
}

/* ═══════════ 🔑 授权与可见性面板（§3.14 caps / §3.22 s→o 投影 / §3.20 去中心化） ═══════════
 * 形态：居中浮层（与 TaskDetailOverlay 同款视觉体系——既有 CSS 变量 + cardd/btnd/tinyd/chipd）。
 * 交互流：① 分享范围与可见性（schema 驱动，整体可见什么；显式「保存范围」按钮）
 *        ② 载入协作者 → 每人一行 + 四个开关（人话标签）→ 切换即存（乐观更新/失败回滚）
 *           ＋ 每人一块「可见范围」（§3.20）：摘要常显，展开可「跟随整体范围 / 单独指定」→ 显式保存
 *        ③ 底部两个破坏性入口都走"第一次上膛、第二次执行"（10s 自动卸膛）。
 * 协作者列表＝**账号粒度**（同一账号的多台设备后端已合并成一行、写时铺到该账号所有设备行）。 */
/** 只读快照行（成员设备面板用）：左标签、右人话值。 */
function SnapshotRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 3 }}>
      <span className="tinyd" style={{ ...FZ_META, flexShrink: 0, width: 62 }}>{label}</span>
      <span className="tinyd" style={{ flex: 1, minWidth: 0, color: 'var(--tx,#1c2333)' }}>{value}</span>
    </div>
  )
}

/** 快照的面 → 人话：先吃 grant（布尔表），没有就吃卡片快照里的 id 清单。 */
function snapshotFaceLabel(
  grantCaps: Record<string, boolean> | undefined,
  snap: PeerTask['shareSnapshot'] | undefined,
  face: 'o' | 'a',
): string {
  const ids = face === 'o' ? snap?.caps?.o : snap?.caps?.a
  const rows = CAP_ROWS.filter((r) => (face === 'o'
    ? r.key !== 'session.input' && r.key !== 'scope.switch'
    : r.key === 'session.input' || r.key === 'scope.switch'))
  let on: string[] = []
  if (grantCaps) {
    on = rows.filter((r) => grantCaps[r.key]).map((r) => r.label)
  } else if (ids && ids.length > 0) {
    const set = new Set(ids.map((x) => String(x?.id ?? '')))
    on = rows.filter((r) => set.has(r.key)).map((r) => r.label)
  } else {
    return '卡片没带快照'
  }
  return on.length ? on.join('、') : '没有'
}

/** 可见范围 → 人话（整机/指定项目/只指定会话 + 时间窗）。 */
function shareScopeLabelOf(v?: { space?: string; sessions?: string[]; windowMs?: number | null }): string {
  if (!v) return '卡片没带快照'
  const space = v.space === 'project' ? '指定项目' : v.space === 'session' ? '只指定会话' : '我的全部（整机）'
  const win = v.windowMs == null ? '全部历史'
    : v.windowMs <= 6 * 3600e3 ? '最近 6 小时'
    : v.windowMs <= 24 * 3600e3 ? '最近 1 天'
    : v.windowMs <= 7 * 24 * 3600e3 ? '最近 7 天' : '自定义时间窗'
  const sess = (v.sessions?.length ?? 0) > 0 ? ` · ${v.sessions!.length} 个会话白名单` : ''
  return `${space} · ${win}${sess}`
}

export function ShareGrantsPanel({ shareId, taskTitle, onClose, onChanged, flash, grant, sourceDeviceName, shareSnapshot, memberReadonly }: {
  shareId: string
  taskTitle: string
  /** 成员设备（非分享源）从任务卡带下来的只读权限快照——分享不在本机时展示它。 */
  grant?: { caps?: Record<string, boolean>; visibility?: { space?: string; sessions?: string[]; windowMs?: number | null } }
  /** 这张卡来自哪台设备（成员设备上用来告诉用户"去那台设备改"）。 */
  sourceDeviceName?: string
  /** 分享快照（只读）：卡片下发的 caps 面 id 清单 + 可见范围。 */
  shareSnapshot?: PeerTask['shareSnapshot']
  /** task-43：成员设备（remoteOrigin）面板**只读**——写入口全部隐藏/拦截（fail-closed）。 */
  memberReadonly?: boolean
  onClose: () => void
  onChanged: () => void
  /** 面板关闭后仍要留痕的一句话（如「已停止分享」）——挂在卡片上的 groupMsg。 */
  flash: (text: string) => void
}) {
  const [rows, setRows] = useState<GrantCollaborator[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [savingDid, setSavingDid] = useState<string | null>(null)
  // 2026-10-18 交互优化：逐人权限**默认收起**（先给一句人话摘要，要微调再展开）
  // ——此前每人 4 行复选框全摊开，3 个人就 12 行，看不出"谁能做什么"。
  const [openCaps, setOpenCaps] = useState<Record<string, boolean>>({})
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null)
  // 破坏性动作的二次确认（与右键菜单 revokeArm 同一套模式：第一次上膛、第二次执行）
  const [arm, setArm] = useState<'all' | 'stop' | null>(null)
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const msgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const say = useCallback((text: string, bad = false) => {
    setMsg({ text, bad })
    if (msgTimerRef.current) clearTimeout(msgTimerRef.current)
    msgTimerRef.current = setTimeout(() => setMsg(null), 4600)
  }, [])
  useEffect(() => () => {
    if (msgTimerRef.current) clearTimeout(msgTimerRef.current)
    if (armTimerRef.current) clearTimeout(armTimerRef.current)
  }, [])

  /** §3.22/§3.20 可见范围：整体段与逐人段**共用这一份**（同一个命令只拉一次；整体改完静默对齐逐人）。 */
  const vis = useShareVisibility(shareId)
  /** task-43：只读快照判定（fail-closed）——成员设备一律只读；源设备本机注册表缺分享也不可写。 */
  const readonlySnapshot = !!memberReadonly || (!!vis.loadErr && /不存在/.test(String(vis.loadErr)))
  /** 显示层 items（2026-10-24）：project 档统一叫「指定项目」——逐人段与整体段同一口径，
   *  摘要函数（visScopeLabel/visCeilingLabel）喂它 → 人话里也不出现旧的单项目叫法。 */
  const visDisplay = useMemo(() => visDisplayItems(vis.items) ?? [], [vis.items])

  const load = useCallback(async () => {
    setRows(null); setLoadErr(null)
    try {
      const r = await invokeT<{ collaborators?: GrantCollaborator[] }>('share_grants', { shareId })
      setRows(dedupeByDid(r?.collaborators ?? []))
    } catch (e) { setLoadErr(briefErr(e)) }
  }, [shareId])
  useEffect(() => {
    // task-43：成员设备只读快照不发 share_grants 读/写请求；本机注册表缺分享时
    // 首轮读到「分享不存在」也会收敛到只读快照（不把错误甩给用户）。
    if (readonlySnapshot) { setRows(null); setLoadErr(null); return }
    void load()
  }, [load, readonlySnapshot])

  /** 开关切换：乐观更新 → 保存 → 失败回滚 + 一句话（§3.20 开关即 action，立即生效）。 */
  const toggle = async (c: GrantCollaborator, k: CapKey) => {
    if (readonlySnapshot) { say(readonlyPanelHint(sourceDeviceName), true); return }
    if (c.isOwner || savingDid) return
    const before = readCaps(c.caps, false)
    const next: GrantCaps = { ...before, [k]: !before[k] }
    setRows((prev) => (prev ?? []).map((x) => (x.did === c.did ? { ...x, caps: next } : x)))
    setSavingDid(c.did)
    try {
      await invokeT('share_grant_caps', { shareId, did: c.did, caps: next })
      say(`已${next[k] ? '放开' : '收回'}「${capLabel(k)}」`)
    } catch (e) {
      // 回滚到点击前的快照（同一个人同时只允许一个在途请求，快照不会被别的手势污染）
      setRows((prev) => (prev ?? []).map((x) => (x.did === c.did ? { ...x, caps: before } : x)))
      say(`没能保存（${briefErr(e)}）——已还原`, true)
    } finally { setSavingDid(null) }
  }

  const armFor = (which: 'all' | 'stop') => {
    if (readonlySnapshot) { say(readonlyPanelHint(sourceDeviceName), true); return }
    if (arm !== which) {
      setArm(which)
      say(which === 'all' ? '再点一次「🛑 全部停止授权」确认' : '再点一次「停止分享」确认')
      if (armTimerRef.current) clearTimeout(armTimerRef.current)
      armTimerRef.current = setTimeout(() => setArm((cur) => (cur === which ? null : cur)), 10_000)
      return
    }
    setArm(null)
    if (which === 'all') void revokeAll(); else void stopShare()
  }
  /** 🛑 全部停止授权（share_revoke_all_grants）：只收权限，卡片与聊天不动。 */
  const revokeAll = async () => {
    if (readonlySnapshot) { say(readonlyPanelHint(sourceDeviceName), true); return }
    try {
      const r = await invokeT<{ revoked?: number }>('share_revoke_all_grants', { shareId })
      setRows((prev) => (prev ?? []).map((x) => (x.isOwner ? x : { ...x, caps: readCaps(undefined, false) })))
      say(`已停止全部授权${typeof r?.revoked === 'number' ? `（收回 ${r.revoked} 项）` : ''}`)
      onChanged()
      // 静默以后端为准（失败就保留乐观视图，不打断）
      void invokeT<{ collaborators?: GrantCollaborator[] }>('share_grants', { shareId })
        .then((rr) => setRows(dedupeByDid(rr?.collaborators ?? []))).catch(() => {})
    } catch (e) { say(`没能停止全部授权（${briefErr(e)}）`, true) }
  }
  /** 停止分享（share_revoke）——与右键菜单同一命令，不重复实现，只在这里放个入口。 */
  const stopShare = async () => {
    if (readonlySnapshot) { say(readonlyPanelHint(sourceDeviceName), true); return }
    try {
      await invokeT('share_revoke', { shareId })
      flash('已停止分享')
      onChanged()
      onClose()
    } catch (e) { say(`停止分享失败：${briefErr(e)}`, true) }
  }

  /* ── ＋ 邀请账号：两条路径（从好友选 / 手填·走链接）+ 能力勾选 + 链接复制 ── */
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteMode, setInviteMode] = useState<'friend' | 'link'>('friend')
  /** 候选＝chat_state 的 friends（复用现成好友名单，不另造名单）。 */
  const [friends, setFriends] = useState<Friend[] | null>(null)
  const [friendsErr, setFriendsErr] = useState<string | null>(null)
  const [selDid, setSelDid] = useState('')
  const [inviteLabel, setInviteLabel] = useState('')
  const [inviteDid, setInviteDid] = useState('')
  const [inviteCaps, setInviteCaps] = useState<GrantCaps>({ ...INVITE_DEFAULT_CAPS })
  const [inviting, setInviting] = useState(false)
  const [inviteErr, setInviteErr] = useState<string | null>(null)
  /** 最近一次邀请的结果（url 要给用户，对方得拿它进来）。 */
  const [invited, setInvited] = useState<{ url: string; label: string; bearer: boolean } | null>(null)
  const [copied, setCopied] = useState(false)
  const urlRef = useRef<HTMLDivElement | null>(null)

  const loadFriends = useCallback(async () => {
    setFriends(null); setFriendsErr(null)
    try {
      const s = await invokeT<{ friends?: Friend[] }>('chat_state')
      setFriends((s?.friends ?? []).filter(isOkFriend))
    } catch (e) { setFriendsErr(briefErr(e)) }
  }, [])
  const openInvite = () => {
    if (readonlySnapshot) { say(readonlyPanelHint(sourceDeviceName), true); return }
    setInviteErr(null)
    setInviteOpen((o) => !o)
    if (friends === null && !friendsErr) void loadFriends()
  }
  const pickMode = (m: 'friend' | 'link') => {
    setInviteMode(m); setInviteErr(null)
    if (m === 'friend' && friends === null && !friendsErr) void loadFriends()
  }
  /** 静默重拉协作者（不闪"加载中"；失败保留旧视图，不打断手里的操作）。 */
  const refreshRows = useCallback(async () => {
    try {
      const r = await invokeT<{ collaborators?: GrantCollaborator[] }>('share_grants', { shareId })
      setRows(dedupeByDid(r?.collaborators ?? []))
    } catch { /* 保持旧视图 */ }
  }, [shareId])

  const sendInvite = async () => {
    if (readonlySnapshot) { setInviteErr(readonlyPanelHint(sourceDeviceName)); return }
    if (inviting) return
    const label = inviteLabel.trim()
    const typedDid = inviteDid.trim()
    if (inviteMode === 'friend' && !selDid) { setInviteErr('先从好友名单里选一个人'); return }
    if (!label) { setInviteErr('给他起个称呼吧——对方能看到这个名字'); return }
    if (inviteMode === 'link' && typedDid && !isValidDid(typedDid)) {
      setInviteErr('识别码看起来不完整（did:myco: 开头）；留空就是发链接'); return
    }
    const did = inviteMode === 'friend' ? selDid : typedDid
    setInviting(true); setInviteErr(null)
    try {
      // 给了 did = 发给这个人；不给 did = 签发 bearer 链接（谁拿到链接谁能进）
      const r = await invokeT<{ did?: string; label?: string; url?: string }>('share_grant',
        did ? { shareId, label, did, caps: inviteCaps } : { shareId, label, caps: inviteCaps })
      const who = (r?.label || label).trim() || label
      setInvited({ url: (r?.url || '').trim(), label: who, bearer: !did })
      setCopied(false)
      say(did
        ? `已邀请「${who}」——把下面的链接给他，他就能进`
        : `已生成「${who}」的链接——谁拿到链接谁能进`)
      void refreshRows()
      onChanged()
    } catch (e) {
      // 后端未就绪/失败：就地红字一句话，面板其它功能照常
      setInviteErr(`邀请没成功（${briefErr(e)}）——面板其它功能不受影响`)
    } finally { setInviting(false) }
  }
  const copyUrl = async () => {
    const text = invited?.url || ''
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      say('链接已复制——发给他就能进')
    } catch {
      // 兜底：把链接选中，用户按 Ctrl+C
      selectTextIn(urlRef.current)
      setCopied(false)
      say('自动复制被拦了——链接已选中，按 Ctrl+C 复制', true)
    }
  }

  ensureFzStyle()
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(8,12,20,.66)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 344, maxWidth: '94vw', maxHeight: '86vh', overflowY: 'auto', borderRadius: 16, background: 'var(--chrome-bg,#fff)', padding: 14, boxShadow: '0 18px 48px rgba(8,12,20,.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <b style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: 'var(--tx,#1c2333)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>🔑 授权与可见性</b>
          <button className="bk" onClick={onClose}>收起 ✕</button>
        </div>
        <div className="tinyd" style={{ ...FZ_META, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{taskTitle}</div>
        <div className="tinyd" style={{ ...FZ_META, marginTop: 2 }}>能看什么、能动手做什么，都在这里改</div>

        {/* 2026-10-18 交互优化：一眼概览——"几个人能看、几个人能发言"。
            此前要逐行数复选框才知道给了谁多少权限。 */}
        {rows !== null && rows.filter((r) => !r.isOwner).length > 0 && (() => {
          const others = rows.filter((r) => !r.isOwner)
          const readers = others.filter((r) => readCaps(r.caps, false)['session.read']).length
          const sayers = others.filter((r) => readCaps(r.caps, false)['session.input']).length
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              <span className="chipd gray" style={{ fontSize: 10.5, padding: '2px 8px' }}>👥 {readers} 人能看</span>
              <span className="chipd" style={{ fontSize: 10.5, padding: '2px 8px', ...(sayers > 0 ? { background: 'rgba(230,81,0,.10)', color: '#c2410c' } : { background: 'rgba(148,163,184,.14)', color: 'var(--txm,#8a93a8)' }) }}>✍️ {sayers} 人能发言</span>
              {sayers > 0 && <span className="tinyd" style={{ ...FZ_META }}>能发言 = 能指挥 AI 动手</span>}
            </div>
          )
        })()}

        {/* ① 分享范围与可见性（§3.22）：放在逐人开关**上方**——它管的是"整体能看到什么"。
            ★2026-10-24 成员设备（手机/笔记本看别处发来的卡）：本机注册表里没有这个分享，
              读接口会报「分享不存在」。这里不再甩红字，改成中性只读快照——权限本身在源设备，
              本机改不了；用户要的是"至少看得到主设备的设置"。 */}
        {readonlySnapshot ? (
          <div className="cardd" style={{ marginTop: 10, border: '1px solid var(--bd,#e2e5ee)', background: 'var(--surface-2,#f6f7fa)' }}>
            <div className="tinyd" style={{ ...FZ_META, marginBottom: 4 }}>
              这个分享在{sourceDeviceName ? `「${sourceDeviceName}」` : '另一台设备'}上——权限与可见范围要在那台设备上改；下面是你手里这张卡的快照（只读）。
            </div>
            <SnapshotRow label="能看什么" value={snapshotFaceLabel(grant?.caps, shareSnapshot, 'o')} />
            <SnapshotRow label="能做什么" value={snapshotFaceLabel(grant?.caps, shareSnapshot, 'a')} />
            <SnapshotRow label="可见范围" value={shareScopeLabelOf(grant?.visibility ?? shareSnapshot?.visibility)} />
          </div>
        ) : (
          <ShareVisibilitySection shareId={shareId} say={say} vis={vis} />
        )}

        {/* task-43：只读快照必须明确"本机不能写"，且写入口全部不渲染（fail-closed）。 */}
        {readonlySnapshot && (
          <div className="cardd" style={{ marginTop: 10, border: '1px solid #e8c67a', background: 'rgba(255,193,7,.10)' }}>
            <div className="tinyd" style={{ ...FZ_META, fontWeight: 700 }}>🔒 只读快照 · 本机不能改权限</div>
            <div className="tinyd" style={{ ...FZ_META, marginTop: 3 }}>{readonlyPanelHint(sourceDeviceName)}</div>
            <div className="tinyd" style={{ ...FZ_META, marginTop: 3 }}>{readonlyFooterText(sourceDeviceName)}</div>
          </div>
        )}

        {/* ② 逐人授权（§3.14 caps）+ 逐人可见范围（§3.20）——四开关语义一个字没动 */}
        <div className="h2d" style={{ fontSize: 12.5, marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--bd,#e2e5ee)' }}>每个人的权限与可见范围</div>
        <div className="tinyd" style={{ ...FZ_META, marginTop: 3 }}>{readonlySnapshot
          ? '协作者名单只在源设备上——本机看不到，也不能在这里增删改（只读快照）。'
          : '同一个账号的多台设备算一个人（配一次，他所有设备一起生效）；逐个人只能在整体范围内再往里收。'}</div>

        {/* 载入失败：一句话降级 + 重试（绝不挡住卡片列表与其它菜单项）；只读快照不提供"重试"（重试也改不了源设备）。 */}
        {(readonlySnapshot ? false : !!loadErr) && (
          <div className="cardd" style={{ marginTop: 10 }}>
            {readonlySnapshot ? (
              <div className="tinyd" style={{ ...FZ_META }}>
                协作者名单也只在源设备上——本机看不到；要改谁可以看/可以动手，请到那边操作。
              </div>
            ) : (
              <div className="tinyd" style={{ ...FZ_META, color: '#e5534b' }}>授权信息暂不可用（{loadErr}）</div>
            )}
            {!readonlySnapshot && <button className="btnd small ghost" style={{ marginTop: 6 }} onClick={() => void load()}>重试</button>}
          </div>
        )}
        {rows === null && !loadErr && !readonlySnapshot && <div className="tinyd" style={{ ...FZ_META, marginTop: 10 }}>授权信息加载中…</div>}
        {rows !== null && rows.length === 0 && (
          <div className="tinyd" style={{ ...FZ_META, marginTop: 10 }}>还没有协作者——把任务分享给谁，谁就会出现在这里</div>
        )}
        {rows !== null && rows.map((c) => {
          const isOwner = !!c.isOwner
          const caps = readCaps(c.caps, isOwner)
          const cname = c.name || `…${String(c.did || '').slice(-4)}`
          // 可见范围这一份是共用的：读到之前先把入口收着（不闪、也不挡住四开关）
          const visItems = vis.items
          return (
            <div key={c.did} style={{ marginTop: 8, padding: '10px 10px', border: '1px solid var(--bd,#e2e5ee)', borderRadius: 10, background: 'var(--surface-2,#f6f7fa)', opacity: savingDid === c.did ? .7 : 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700, color: 'var(--tx,#1c2333)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cname}</span>
                {isOwner ? (
                  <span className="chipd gray" style={{ fontSize: 10, padding: '2px 8px', flexShrink: 0 }}>我 · 全部权限</span>
                ) : (
                  <>
                    {/* 一句人话摘要：不展开也知道这个人能做什么 */}
                    <span className="chipd" title="能做什么（点右侧「调整」改）" style={{ fontSize: 10, padding: '2px 8px', flexShrink: 0, ...capsTone(caps) }}>{capsSummary(caps)}</span>
                    <button className="btnd small ghost" style={{ flexShrink: 0, fontSize: 11, padding: '2px 8px' }}
                      onClick={() => setOpenCaps((p) => ({ ...p, [c.did]: !p[c.did] }))}>
                      {openCaps[c.did] ? '收起' : '调整'}
                    </button>
                  </>
                )}
              </div>
              {/* owner：一行说明（四项恒真且不可改，没必要摊开四个禁用复选框） */}
              {isOwner && (
                <div className="tinyd" style={{ ...FZ_META, marginTop: 3 }}>你的权限固定为全部、不受可见范围限制——下面这些只对别人生效。</div>
              )}
              {/* 非 owner 收起态：一句提示怎么改，不摊开细节 */}
              {!isOwner && !openCaps[c.did] && (
                <div className="tinyd" style={{ ...FZ_META, marginTop: 3 }}>
                  {caps['session.read'] ? '点右上「调整」可改权限或收窄他看得到的会话' : '还不能看任何会话——点「调整」开放'}
                </div>
              )}
              {!isOwner && openCaps[c.did] && (
                <div style={{ marginTop: 4, paddingTop: 6, borderTop: '1px dashed var(--bd,#e2e5ee)' }}>
                  <div className="tinyd" style={{ ...FZ_META, marginBottom: 1 }}>动作授权（能动手做什么）</div>
                  {CAP_ROWS.map((r) => {
                    const on = caps[r.key]
                    const risky = r.key === 'session.input'
                    return (
                      <div key={r.key}>
                        <label className="fz-hover" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, padding: '3px 4px', borderRadius: 6, cursor: 'pointer' }}>
                          <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--tx,#1c2333)' }}>
                            {r.label}
                            {risky && <span title={INPUT_RISK_TIP} style={{ color: 'var(--txm,#8a93a8)', marginLeft: 3, cursor: 'help' }}>ⓘ</span>}
                          </span>
                          <input type="checkbox" checked={on} disabled={savingDid === c.did}
                            onChange={() => void toggle(c, r.key)}
                            style={{ flexShrink: 0 }} />
                        </label>
                        {/* §3.12.5 风险提示（人话）：开了就醒目标橙——等于把 AI 的工具能力借出去 */}
                        {risky && (
                          <div className="tinyd" style={{ ...FZ_META, marginTop: 1, ...(on ? { color: '#e65100' } : undefined) }}>等于把 AI 的工具能力借给他</div>
                        )}
                      </div>
                    )
                  })}
                  {/* 设置/模型/思考等级类动作（2026-10-24）：后端默认拒绝、能力暂未开放 →
                      灰着列出来（点不动 +「暂未开放」），只展示不发请求（caps 契约不变）。 */}
                  <LockedActionRows />
                  {/* §3.20 逐人可见范围：读不到就一句人话降级，四开关照常 */}
                  {vis.loadErr && (
                    <div className="tinyd" style={{ ...FZ_META, marginTop: 8 }}>可见范围暂不可用（{vis.loadErr}）——上面的「分享范围与可见性」里可以重试</div>
                  )}
                  {!vis.loadErr && visItems === null && (
                    <div className="tinyd" style={{ ...FZ_META, marginTop: 8 }}>可见范围加载中…</div>
                  )}
                  {!vis.loadErr && visItems !== null && (
                    <MemberScopeBlock shareId={shareId} did={c.did} name={cname}
                      taskCurrent={vis.current} items={visDisplay} sessionCwds={vis.sessionCwds}
                      grant={vis.grantOf(c.did)} patchGrant={vis.patchGrant} say={say} />
                  )}
                </div>
              )}
            </div>
          )
        })}

        {/* ＋ 邀请账号（§3.14.1 新增协作者）：协作者列表下方、破坏性入口之前。
            两条路径——从好友选（chat_state 的 friends）/ 手填·走链接（只给 label = 签发链接）。
            后端未就绪（share_grant 未注册）→ 就地一句话红字，面板其它功能照常。 */}
        {!readonlySnapshot && <div style={{ marginTop: 10 }}>
          <button className="btnd ghost" style={{ width: '100%' }} onClick={openInvite}>
            {inviteOpen ? '收起邀请' : '＋ 邀请账号'}
          </button>
          {inviteOpen && (
            <div className="cardd" style={{ marginTop: 8 }}>
              {/* 两条路径同一套分段切换（选中=实色 chip，一眼知道当前在哪条路上） */}
              <SegTabs
                options={[{ key: 'friend', label: '👥 从好友选' }, { key: 'link', label: '🔗 手填 / 走链接' }]}
                value={inviteMode}
                onPick={(k) => pickMode(k as 'friend' | 'link')} />

              {inviteMode === 'friend' && (
                <div style={{ marginTop: 8 }}>
                  {friends === null && !friendsErr && <div className="tinyd" style={FZ_META}>好友名单加载中…</div>}
                  {friendsErr && (
                    <div>
                      <div className="tinyd" style={{ ...FZ_META, color: '#e5534b' }}>好友名单暂不可用（{friendsErr}）——也可以切到「手填 / 走链接」</div>
                      <button className="btnd small ghost" style={{ marginTop: 5 }} onClick={() => void loadFriends()}>重试</button>
                    </div>
                  )}
                  {friends !== null && friends.length === 0 && (
                    <div className="tinyd" style={FZ_META}>还没有好友——可以切到「手填 / 走链接」用链接邀请</div>
                  )}
                  {friends !== null && friends.length > 0 && (
                    <div style={{ maxHeight: 138, overflowY: 'auto' }}>
                      {friends.map((f) => {
                        const fname = f.name || `…${String(f.did || '').slice(-4)}`
                        const picked = selDid === f.did
                        const already = (rows ?? []).some((x) => x.did === f.did)
                        return (
                          <div key={f.did} className="devline fz-hover"
                            onClick={() => { setSelDid(f.did); setInviteLabel(f.name || fname); setInviteErr(null) }}
                            style={{ marginTop: 4, cursor: 'pointer', ...(picked ? { borderColor: 'var(--accent,#6b7bff)', background: 'var(--chip-bg,rgba(107,123,255,.08))' } : undefined) }}>
                            <span className="dot" style={{ background: picked ? 'var(--accent,#6b7bff)' : '#c3c9d6' }} />
                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fname}</span>
                            {already && <span className="chipd gray" style={{ fontSize: 10, padding: '1px 7px' }}>已在协作者里</span>}
                            {picked && <span className="tinyd" style={{ fontSize: 10.5, color: '#15803d', fontWeight: 700 }}>已选</span>}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              {inviteMode === 'link' && (
                <div style={{ marginTop: 8 }}>
                  {/* 「链接不认人」=警告条（橘黄左边条+浅底）：醒目提示，不是错误红 */}
                  <div style={FZ_WARN}>链接不认人：谁拿到链接谁能进；被转进群里，群里所有人都能进。</div>
                  <input value={inviteDid} onChange={(e) => { setInviteDid(e.target.value); setInviteErr(null) }}
                    placeholder="对方识别码（可不填，留空=发链接）"
                    style={{ ...inputS, width: '100%', marginTop: 7, fontSize: 12 }} />
                  {inviteDid.trim() !== '' && !isValidDid(inviteDid.trim()) && (
                    <div className="tinyd" style={{ ...FZ_META, marginTop: 4, color: '#e5534b' }}>识别码看起来不完整（did:myco: 开头）；留空就是发链接</div>
                  )}
                </div>
              )}

              <input value={inviteLabel} onChange={(e) => { setInviteLabel(e.target.value); setInviteErr(null) }}
                placeholder="称呼（对方能看到，必填）"
                style={{ ...inputS, width: '100%', marginTop: 8, fontSize: 12 }} />

              {/* 2026-10-18 交互优化：先给两档预设（只看 / 可发言），再让用户微调四项 */}
              <div className="tinyd" style={{ ...FZ_META, marginTop: 8 }}>给他这几项（先选档，再微调）</div>
              <div style={{ display: 'flex', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
                {INVITE_PRESETS.map((p) => {
                  const hit = CAP_KEYS.every((k) => inviteCaps[k] === p.caps[k])
                  return (
                    <button key={p.key} className="btnd small ghost" title={p.hint}
                      style={{ fontSize: 11, padding: '3px 9px', ...(hit ? { borderColor: 'var(--accent,#6b7bff)', background: 'rgba(107,123,255,.10)', fontWeight: 700 } : {}) }}
                      onClick={() => setInviteCaps({ ...p.caps })}>
                      {p.label}
                    </button>
                  )
                })}
                <span className="tinyd" style={{ ...FZ_META, alignSelf: 'center' }}>
                  {CAP_KEYS.every((k) => inviteCaps[k] === INVITE_PRESETS[0].caps[k]) ? '只看（不能发言）'
                    : CAP_KEYS.every((k) => inviteCaps[k] === INVITE_PRESETS[1].caps[k]) ? '可听到 + 能发言'
                    : '自定义'}
                </span>
              </div>
              {CAP_ROWS.map((r) => (
                <label key={r.key} className="fz-hover" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, padding: '3px 4px', borderRadius: 6, cursor: 'pointer' }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--tx,#1c2333)' }}>
                    {r.label}
                    {r.key === 'session.input' && <span title={INPUT_RISK_TIP} style={{ color: 'var(--txm,#8a93a8)', marginLeft: 3, cursor: 'help' }}>ⓘ</span>}
                  </span>
                  <input type="checkbox" checked={inviteCaps[r.key]}
                    onChange={() => setInviteCaps((c) => ({ ...c, [r.key]: !c[r.key] }))}
                    style={{ flexShrink: 0 }} />
                </label>
              ))}
              {/* 动作授权：设置/模型/思考等级类动作暂未开放（灰着列出来；只展示不发请求） */}
              <LockedActionRows />

              <button className="btnd" style={{ marginTop: 9, opacity: inviting ? 0.55 : 1 }} disabled={inviting} onClick={() => void sendInvite()}>
                {inviting ? '正在邀请…' : inviteMode === 'link' && !inviteDid.trim() ? '🔗 生成邀请链接' : '＋ 邀请'}
              </button>
              {inviteErr && <div className="tinyd" style={{ ...FZ_META, marginTop: 5, color: '#e5534b' }}>{inviteErr}</div>}

              {invited && (
                <div className="cardd" style={{ marginTop: 8 }}>
                  <div className="tinyd" style={FZ_META}>把这条链接给「{invited.label}」（他打开就能进）：</div>
                  {invited.url
                    ? <div ref={urlRef} style={{ marginTop: 5, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--bd,#e2e5ee)', background: 'var(--surface-2,#f6f7fa)', fontSize: 11, fontFamily: 'ui-monospace,monospace', wordBreak: 'break-all', userSelect: 'text', color: 'var(--tx,#1c2333)' }}>{invited.url}</div>
                    : <div className="tinyd" style={{ ...FZ_META, marginTop: 5 }}>这次没拿到链接——让对方用他自己的账号打开这个分享也行</div>}
                  {invited.bearer && <div style={{ ...FZ_WARN, marginTop: 6 }}>这条链接不认人：谁拿到链接谁能进；转进群 = 群里都能进。</div>}
                  {invited.url && (
                    <button className="btnd small" style={{ marginTop: 7 }} onClick={() => void copyUrl()}>
                      {copied ? '已复制 ✓' : '复制链接'}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>}

        {/* 底部：两个破坏性入口都要二次确认（第一次上膛、第二次执行）。
            视觉权重=红字红边 ghost（危险但不过度吓人）；上膛=浅红底+加粗。
            task-43：只读快照（成员设备）整段**不渲染**——本机没有这些权限。 */}
        {!readonlySnapshot && <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--bd,#e2e5ee)' }}>
          <div className="tinyd" style={{ ...FZ_META, marginBottom: 6 }}>危险操作（都要再点一次确认）</div>
          <button className="btnd ghost" style={{ width: '100%', ...FZ_DANGER, ...(arm === 'all' ? FZ_DANGER_ARMED : {}) }} onClick={() => armFor('all')}>
            {arm === 'all' ? '⚠ 再点一次：全部停止授权' : '🛑 全部停止授权'}
          </button>
          <button className="btnd ghost" style={{ width: '100%', marginTop: 6, ...FZ_DANGER, ...(arm === 'stop' ? FZ_DANGER_ARMED : {}) }} onClick={() => armFor('stop')}>
            {arm === 'stop' ? '⚠ 再点一次：停止分享' : '停止分享'}
          </button>
          <div className="tinyd" style={{ ...FZ_META, marginTop: 6 }}>「全部停止授权」只收回权限，任务卡和聊天还在；「停止分享」对方就再也打不开了。</div>
        </div>}
        {msg && <div className="tinyd" style={{ ...FZ_META, marginTop: 7, color: msg.bad ? '#e5534b' : '#15803d' }}>{msg.text}</div>}
      </div>
    </div>
  )
}

/* ═══════════ peer 任务卡（任务 Tab 用：来源=分享 徽章 + 参与方 + 状态流转） ═══════════ */

/* ── 行尾一排的视觉分层（2026-10-06 排版重做，只动样式不动语义）──
 * 三层一眼可分：动作=彩色 chip（可点）｜协作徽章=灰 chip｜元信息/状态=暗小字（绝不像按钮）。
 * PEER_CHIP 统一几何：10px 字 / 1.25 行高 / 3px 9px 内边距 / 999 圆角，inline-flex 垂直居中
 * （修 🤝 emoji 比文字低一截的错位）；marginLeft:0 抵消 .devline .endchip 的 margin-left:auto——
 * 旧样式让每个 chip 各吞一份剩余空间，整排间距被扯得不均，是最主要的"乱"源。 */
const PEER_CHIP: CSSProperties = {
  marginLeft: 0, flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 3,
  fontSize: 10, lineHeight: 1.25, padding: '3px 9px', borderRadius: 999, fontWeight: 600, whiteSpace: 'nowrap',
}
/** emoji 单独成 flex 项并上移 0.5px：补 emoji 字形降部比中文深的基线差 */
const PEER_CHIP_EMOJI: CSSProperties = { transform: 'translateY(-.5px)' }
/** 元信息（颗粒度）与状态文本退后：10px 暗字、透明度 .6、无底色无边框——与可点 chip 拉开档位 */
const PEER_META: CSSProperties = { fontSize: 10, lineHeight: 1.25, opacity: .6, flexShrink: 0, whiteSpace: 'nowrap' }

/* ── 卡片两行式布局（2026-10-08 用户实测回归修复，只动样式/兜底文案，不动语义）──
 * 旧版把整排 chips 收进一个 flexShrink:0 的容器，窄窗时该容器不收缩 → 溢出卡片与窗口，
 * 且它先占满固有大小时标题（flex:1; minWidth:0）被挤成 0 宽，卡片看起来"没有任务名字"。
 * 现在拆两行（借用本工程既有 idiom：App.tsx 的 .devline + flexBasis:100% 第二行）：
 *   第一行：状态点 / 参与方头像 / **标题 flex:1 ellipsis** / 主操作「打开」
 *   第二行：档位·状态（暗小字元信息） + 可点 chips（分享/开始/完成），flexWrap 允许折行
 * 硬约束：两行都在卡片内折行、都不溢出；标题永远有正宽度；主操作「打开」永不挤压。 */
const PEER_LINE1: CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }
const PEER_LINE2: CSSProperties = {
  flexBasis: '100%', minWidth: 0, flexWrap: 'wrap', rowGap: 4, columnGap: 6,
  display: 'flex', alignItems: 'center', paddingLeft: 14,
}

/** 兜底名：卡片**永远不该没有名字**。真标题拿不到时按档位推导，最后落「未命名任务」。
 *  会话档的标题由后端从分享记录给（本组件拿不到 sessionId）；这里从 desc 抽项目目录名
 *  当次选，取不到再退档位名——只为名字不为空，不新增契约字段。 */
function taskFallbackName(t: PeerTask): string {
  const path = /[A-Za-z]:\\[^\s\n]+|\/(?:[\w.-]+\/)+[\w.-]+/.exec(t.desc || '')
  const dir = path ? (path[0].replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '') : ''
  const byGran: Record<string, string> = { session: '会话任务', workspace: '项目任务', instance: '实例任务', main: '我的工作台' }
  return dir || byGran[t.granularity || ''] || '未命名任务'
}
/** 展示名：真标题优先（去空白后仍为空即视为没有），否则兜底名。
 *  2026-10-25：标题过 `cleanCardTitle`——老环境卡的卡名带 `127.0.0.1:端口`（旧建卡
 *  模板），显示时抹掉；卡片数据与打开链路不动。 */
function taskDisplayTitle(t: PeerTask): string {
  const real = cleanCardTitle((t.title || '').trim())
  return real || taskFallbackName(t)
}

export function PeerTasksCard({ tasks, onChanged, hideTitle }: { tasks: PeerTask[]; onChanged: () => void; hideTitle?: boolean }) {
  const [err, setErr] = useState<string | null>(null)
  // §3.19 任务群组：右键菜单 + 打开任务群的即时反馈（一句话，不挡住卡片列表）
  const [menu, setMenu] = useState<{ x: number; y: number; task: PeerTask } | null>(null)
  const [groupMsg, setGroupMsg] = useState<string | null>(null)
  const [groupBusy, setGroupBusy] = useState(false)
  /** 破坏性动作的二次确认（§3.10 纪律 3）：第一次点击只"上膛"，再点一次才执行 */
  const [revokeArm, setRevokeArm] = useState<string | null>(null)
  /** env 卡「打开」的行内状态（2026-10-23）：建链中/已就绪/离线/无服务/无权限——
   *  **就地给人话**，不再把用户丢进分享入口的 cookie 错误页。 */
  const [envNote, setEnvNote] = useState<{ id: string; text: string; state?: string } | null>(null)
  const [envBusy, setEnvBusy] = useState<string | null>(null)
  /** §3.14 caps / §3.22 可见性：右键「🔑 授权与可见性」打开的面板（有 shareId 才开；无则一句话提示）。 */
  const [grantsOpen, setGrantsOpen] = useState<{ shareId: string; title: string; grant?: PeerTask['grant']; sourceDeviceName?: string; shareSnapshot?: PeerTask['shareSnapshot']; remoteOrigin?: boolean } | null>(null)
  /** §3.23 转授闸：**待批准**的转授申请（好友想把这张卡转给第三人）。
   *  数据源 = 后端 `share_reshare_requests`（dsh-share-requests.json 里 want=reshare 那些）。 */
  const [reshareReqs, setReshareReqs] = useState<{ requestId: string; shareId: string; requesterName?: string; targetName?: string; targetDid?: string }[]>([])
  const [reshareBusy, setReshareBusy] = useState(false)
  // 2026-10-11 任务卡改名：owner 判定锚（chat_state.myDid——与任务 from 同源同形态）+ 改名弹层
  const [myDid, setMyDid] = useState('')
  const [renaming, setRenaming] = useState<PeerTask | null>(null)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await invokeT<{ requests?: typeof reshareReqs }>('share_reshare_requests', {})
        if (alive) setReshareReqs(r?.requests ?? [])
      } catch { /* 后端未注册/未就绪 → 不显示这一块，卡片列表照常 */ }
      try {
        const s = await invokeT<{ myDid?: string }>('chat_state')
        if (alive && s?.myDid) setMyDid(s.myDid)
      } catch { /* 同上——拿不到就永远不会有「改名」入口（fail-closed） */ }
    }
    void load()
    const timer = window.setInterval(load, 10_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [tasks])
  const decideReshare = async (reqId: string, approve: boolean, remember: boolean) => {
    setReshareBusy(true)
    try {
      await invokeT('share_reshare_decide', { shareId: reshareReqs.find((r) => r.requestId === reqId)?.shareId, requestId: reqId, approve, remember })
      flashGroup(approve
        ? (remember ? '已同意，并允许 TA 之后继续转授这张卡' : '已同意这一次转授——卡已由这台设备发给对方')
        : '已驳回这次转授申请')
      const r = await invokeT<{ requests?: typeof reshareReqs }>('share_reshare_requests', {})
      setReshareReqs(r?.requests ?? [])
      await onChanged()
    } catch (e) {
      flashGroup(`处理转授申请失败：${briefErr(e)}`)
    } finally { setReshareBusy(false) }
  }
  const flashGroup = (text: string) => {
    setGroupMsg(text)
    window.setTimeout(() => setGroupMsg((cur) => (cur === text ? null : cur)), 4600)
  }
  // 后端回填了 groupId 的任务顺手登记（groupId↔shareId）——从会话列表进任务群也能认出来
  useEffect(() => { rememberTaskGroupsFromTasks(tasks) }, [tasks])
  const setStatus = async (id: string, status: string) => {
    try { await invokeT('chat_set_task_status', { taskId: id, status }); await onChanged() }
    catch (e) { setErr(String(e)) }
  }
  /** 右键「打开任务群」（§3.15/§3.19）：share_ensure_group（幂等）拿 groupId → 登记
   *  groupId↔shareId → 发 myco:open-task-group 交给 App 切智能体 Tab 并打开该群会话。
   *  后端命令未注册（开发期常态）→ 只说一句"任务群组暂不可用"，卡片列表照常可用。 */
  const openTaskGroup = async (t: PeerTask) => {
    if (groupBusy) return
    const shareId = shareIdOfTask(t)
    if (!shareId) { flashGroup('任务群组暂不可用（该任务未带 shareId）'); return }
    setGroupBusy(true)
    try {
      const r = await invokeT<{ groupId?: string }>('share_ensure_group', { shareId })
      const gid = (r?.groupId || '').trim()
      if (!gid) throw new Error('后端未返回 groupId')
      rememberTaskGroup(gid, { shareId, title: t.title })
      flashGroup('任务群已就绪，正在打开…')
      window.dispatchEvent(new CustomEvent('myco:open-task-group', { detail: { groupId: gid, shareId, title: t.title } }))
    } catch (e) {
      flashGroup(`任务群组暂不可用（${briefErr(e)}）`)
    } finally { setGroupBusy(false) }
  }
  /** 列表行 / 右键「打开」的**唯一实现**（2026-10-23 真机 bug 修复）：
   *  · 卡上有 env（≥1 条）→ `runTaskOpen` 走 `vnet_env_open`：按 env 建 `127.0.0.1:<口>`
   *    链路并起客户端（RDP→mstsc / DSH→浏览器），行内给状态人话；
   *  · 没有 env 的老卡 → 原 `open-url`（分享现签页/HBL 页面），行为不变。
   *  **绝不**把 env 卡再送进分享入口（`/gw/<id>/app/` 会报 no valid share cookie）。 */
  // 2026-10-25（用户报「狂刷浏览器死链接 + 狂开终端」）：开卡前两道闸——
  //  ① 分享已停止（源设备上分享不在了）→ 卡片标失效 + 人话提示，**绝不拉浏览器**；
  //  ② 同一张卡 2.5s 内重复点 → 忽略（防连点/恢复会话式雪崩）。
  const openGuardRef = useRef<Map<string, number>>(new Map())
  const staleRef = useRef<Set<string>>(new Set())
  const checkShareAlive = async (shareId: string): Promise<boolean> => {
    if (!shareId) return true
    if (staleRef.current.has(shareId)) return false
    try {
      const r = await fetch(`${FZ_API}/api/dshShare/list`).then((x) => x.json())
      // 形状：{ ok, shares: [{id,...}], entryBase, pendingRequests }（handle_list）
      const list = (r as { shares?: Array<{ id?: string }> })?.shares ?? []
      const alive = list.some((s) => s?.id === shareId)
      if (!alive) staleRef.current.add(shareId)
      return alive
    } catch {
      return true // 查不到不放行也不拦（网络抖动时不误判失效）
    }
  }
  const openTaskCard = async (t: PeerTask) => {
    const act = t.action
    const envs = declaredEnvsOfCard(t as unknown as Record<string, unknown>, act)
    if (!envs.length && act?.kind !== 'open-url') return
    if (envBusy === t.taskId) return
    // ② 去重：同一张卡 2.5s 内只允许一次打开
    const now = Date.now()
    const last = openGuardRef.current.get(t.taskId) ?? 0
    if (now - last < 2500) return
    openGuardRef.current.set(t.taskId, now)
    // ① 分享还在不在（卡可能过期；不在了就别开浏览器）
    const shareId = (t as unknown as { shareId?: string }).shareId
      || (act as unknown as { shareId?: string })?.shareId
      || (Array.isArray((act as unknown as { env?: Array<{ shareId?: string }> })?.env)
        ? (act as unknown as { env?: Array<{ shareId?: string }> })?.env?.find((e) => e?.shareId)?.shareId
        : undefined)
    if (shareId && !(await checkShareAlive(shareId))) {
      setEnvNote({ id: t.taskId, text: '来源分享已停止——这张卡已失效（请让对方重新分享）', state: 'error' })
      return
    }
    if (envs.length) {
      setEnvBusy(t.taskId)
      setEnvNote({ id: t.taskId, text: '正在连接…', state: 'building' })
    } else if (t.remoteOrigin) {
      // 无 env 的远端卡：先给一句人话（让用户知道这一步是"去源设备取"）
      flashGroup(`正在从「${(t.sourceDeviceName || '').trim() || '另一台设备'}」打开这个任务…`)
    }
    try {
      const out = await runTaskOpen(t as unknown as Record<string, unknown>, act, {
        invoke: (cmd, args) => invokeT<unknown>(cmd, args),
        openExternalUrl,
      })
      if (out.via === 'env') {
        setEnvNote({ id: t.taskId, text: out.note, state: out.state })
      }
    } finally {
      if (envs.length) setEnvBusy(null)
    }
  }
  // shared=我分享出去的（登记在库只为回执取标题），不显示在任务列表
  const shown = tasks.filter((t) => t.status !== 'shared')
  if (!shown.length) return null
  // 第83轮：待接受 N 醒目标记（用户"不知道能点/有新卡"的提示）
  const pendingN = shown.filter((t) => t.status === 'pending').length
  const stLabel: Record<string, string> = { pending: '待接受', todo: '待办', doing: '进行', done: '已完成' }
  ensureFzStyle() // 行 hover 样式一次注入（只有可点行才挂 fz-hover）
  return (
    <div className="cardd" style={pendingN > 0 ? { boxShadow: '0 2px 14px rgba(245,158,11,.14)' } : undefined}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div className="h2d" style={{ fontSize: 12.5, flex: 1 }}>好友分享的任务</div>
        {pendingN > 0 && (
          <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 8, background: 'linear-gradient(135deg,#fbbf24,#f59e0b)', color: '#fff', letterSpacing: .3 }}>待接受 {pendingN}</span>
        )}
        {reshareReqs.length > 0 && (
          <span data-reshare-badge style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 8, background: 'linear-gradient(135deg,#38bdf8,#0284c7)', color: '#fff', letterSpacing: .3 }}>🔁 转授待批准 {reshareReqs.length}</span>
        )}
      </div>
      {/* §3.23 转授待批准（主人侧）：好友想把这张卡转给第三人 —— **默认拒绝**，
          只有主人显式同意才生效（批准后由本机直接把卡发给对方，被转授者点开走同一条链）。 */}
      {reshareReqs.map((r) => (
        <div key={r.requestId} data-reshare-req={r.requestId} style={{ marginTop: 6, padding: '7px 9px', borderRadius: 8, background: 'rgba(56,189,248,.10)', border: '1px solid rgba(56,189,248,.35)', fontSize: 11.5, lineHeight: 1.6 }}>
          <div>
            <b>{r.requesterName || '一位协作者'}</b> 想把这张卡转给 <b>{r.targetName || shortDid(r.targetDid || '') || '第三人'}</b> —— 要经你同意。
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
            <span className="endchip go" style={{ ...PEER_CHIP, cursor: 'pointer' }} onClick={() => { if (!reshareBusy) void decideReshare(r.requestId, true, false) }}>✅ 只同意这一次</span>
            <span className="endchip go" style={{ ...PEER_CHIP, cursor: 'pointer' }} title="同意，并允许 TA 在这条授权的有效期内继续转授（你随时可以收回原授权，转授会跟着一起失效）" onClick={() => { if (!reshareBusy) void decideReshare(r.requestId, true, true) }}>✅ 同意且以后不必再问</span>
            <span className="chipd gray" style={{ ...PEER_CHIP, cursor: 'pointer' }} onClick={() => { if (!reshareBusy) void decideReshare(r.requestId, false, false) }}>🚫 驳回</span>
          </div>
        </div>
      ))}
      {shown.map((t) => {
        const expired = !!t.expiresAt && t.expiresAt < Date.now()
        const parts = t.participants ?? []
        // 薄卡片：左键直达（action 驱动，scheme 白名单）；未知 kind/非法 scheme 不显示动作
        const act = t.action
        // 2026-10-09 第二程（跨设备「代打开」）：远端卡**恢复可点**——后端把动作指到本机
        // remoteOpen（本机必达），由它向源设备现签一张窄 mt + 开 P2P 隧道把分享页代理过来。
        // `remoteOrigin` 现在只表示"这张卡来自别的设备"（展示来源），不再表示不可点。
        const remote = !!t.remoteOrigin
        // 2026-10-23：卡上有 env（显式声明）→ 入口是**环境本身**（env 建链直开），
        // 不是分享页。老卡（无 env）保持 action 驱动的 open-url。
        const envs = declaredEnvsOfCard(t as unknown as Record<string, unknown>, act)
        const openUrl = envs.length ? null : (act?.kind === 'open-url' ? safeActionUrl(act.url) : null)
        const canOpen = !!openUrl || envs.length > 0
        const openLabel = envs.length ? actionLabelOf(act, envs) : (act?.label || '打开')
        const envBusyHere = envBusy === t.taskId
        const srcDev = (t.sourceDeviceName || '').trim()
        // 关键信息（不因"薄"而丢）：颗粒度
        const granLabel: Record<string, string> = { session: '会话', workspace: '项目', instance: '实例', main: '整机' }
        // 名字兜底（产品要求：卡片永远不该没有名字——真标题缺失时按档位/来源推导）
        const dispTitle = taskDisplayTitle(t)
        const metaTone = [t.granularity && granLabel[t.granularity] ? granLabel[t.granularity] : '', t.status !== 'done' ? (stLabel[t.status] || t.status) : ''].filter(Boolean).join(' · ')
        return (
          <div key={t.taskId} data-task={t.taskId} className={canOpen ? 'devline fz-hover' : 'devline'}
            title={canOpen ? `${dispTitle} · 左键打开` : dispTitle}
            onClick={() => { void openTaskCard(t) }}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, task: t }) }}
            style={{ marginTop: 6, flexWrap: 'wrap', rowGap: 3, cursor: canOpen ? 'pointer' : 'default', opacity: t.status === 'done' ? .6 : 1 }}>
            {/* 第一行：状态点 / 参与方 / 标题（min-width:0 + ellipsis，永远有空间）/ 主操作「打开」 */}
            <span style={{ ...PEER_LINE1, flexBasis: '100%' }}>
              <span className="dot" style={{ background: t.status === 'done' ? '#22c55e' : t.status === 'pending' ? (expired ? '#9aa3b8' : '#f59e0b') : '#6b7bff' }} />
              <ParticipantsAvatars participants={parts} size={15} />
              <span data-title style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5, fontWeight: 600, color: 'var(--tx,#1c2333)' }} title={`${dispTitle} · 来自 ${shortDid(t.fromName || '') || '好友'}`}>
                {dispTitle}
              </span>
              {canOpen && (
                <span className="endchip go" data-open-env={envs.length ? '1' : undefined} style={{ ...PEER_CHIP, cursor: envBusyHere ? 'default' : 'pointer', opacity: envBusyHere ? .65 : 1 }} title={`${dispTitle} · ${openLabel}`}>{envBusyHere ? '打开中…' : openLabel}</span>
              )}
            </span>
            {/* 第二行：元信息（档位·状态，暗小字退后）在左，可点 chips（分享/开始/完成）在右。
                整行 flexWrap（窄窗折行，绝不溢出卡片）；每个 chip 自带 marginLeft:0，
                组右靠只由本容器的 marginLeft:auto 承担（不再让每个 chip 各吞一份剩余空间）。 */}
            <span data-actions style={{ ...PEER_LINE2, marginLeft: 'auto' }}>
              {metaTone && <span data-meta className="tinyd" style={PEER_META}>{metaTone}</span>}
              {/* 2026-10-09 跨设备：卡片来自哪台设备——远端卡标"来自 X"（点开时由本机
                  remoteOpen 经 P2P 隧道回源设备取页面；拿不到就是一句人话，不给死链） */}
              {remote
                ? <span data-device className="chipd gray" style={PEER_CHIP} title={`这张卡来自 ${srcDev || '另一台设备'}${t.sourceDevice ? `（${t.sourceDevice}）` : ''} · 点开将由那台设备把页面传过来`}>💻 来自 {srcDev || '另一台设备'}</span>
                : srcDev && <span data-device className="tinyd" style={PEER_META}>💻 {srcDev}</span>}
              {/* §3.23 我的角色 / 我的权限（只读·读写 + 可见范围摘要）：列表项标清"我能做什么"，
                  以及"能不能转给第三人"（默认不可转授——要经主人同意） */}
              <span data-perm className="tinyd" style={PEER_META} title={`我的角色：${memberRoleTitle(t)} · 我的权限：${taskPermHint(t)}`}>
                {isMemberDeviceCard(t) ? `👤 ${taskPermHint(t)}` : `${t.myRole === 'owner' ? '👤 我的' : '👤 协作者'} · ${taskPermHint(t)}`}
              </span>
              {!!t.shareId && !taskReshareAllowed(t) && (
                <span data-reshare className="tinyd" style={PEER_META} title="这是别人分享给你的任务——要转给其他人，得先经主人同意（转发时系统会自动替你去问）">🔁 不可转授</span>
              )}
              {t.status === 'done'
                ? <span className="chipd gray" style={PEER_CHIP}><span style={PEER_CHIP_EMOJI}>🎉</span>{Math.max(parts.length, 1)} 人协作完成</span>
                : <span className="chipd gray" style={PEER_CHIP}><span style={PEER_CHIP_EMOJI}>🤝</span>分享{t.status === 'pending' && expired ? '·已过期' : ''}</span>}
              {t.status === 'pending' && <span className="endchip go" style={{ ...PEER_CHIP, cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); void setStatus(t.taskId, 'todo') }}>一起做</span>}
              {t.status === 'todo' && <span className="endchip go" style={{ ...PEER_CHIP, cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); void setStatus(t.taskId, 'doing') }}>开始</span>}
              {(t.status === 'todo' || t.status === 'doing') && <span className="endchip" style={{ ...PEER_CHIP, cursor: 'pointer', color: '#22c55e' }} onClick={(e) => { e.stopPropagation(); void setStatus(t.taskId, 'done') }}>完成</span>}
            </span>
            {/* env 卡的打开结果（2026-10-23）：就地给人话（地址/已启动/离线/无服务/无权限），
                不再把用户丢进分享入口的 cookie 错误页。 */}
            {envNote && envNote.id === t.taskId && !!envNote.text && (
              <span
                data-env-note
                data-env-state={envNote.state || ''}
                className="tinyd"
                style={{
                  flexBasis: '100%',
                  fontSize: 10.5,
                  lineHeight: 1.5,
                  wordBreak: 'break-all',
                  color:
                    // `error` = 本机侧失败（固定口被占等，见 task-env 的 EnvRowState 注释）：
                    // 与"未授权/无服务"同色警示，但文案不同（"本机建链失败"，不是"稍后再试"）。
                    envNote.state === 'denied' || envNote.state === 'no-service' || envNote.state === 'error'
                      ? '#b45309'
                      : envNote.state === 'offline'
                        ? '#8a93a8'
                        : '#4b5bd6',
                }}
              >
                {envNote.text}
              </span>
            )}
          </div>
        )
      })}
      {err && <div className="tinyd" style={{ color: '#e5534b' }}>{err}</div>}
      {/* §3.19 打开任务群的即时反馈（成功/后端未就绪都有一句人话；4.6s 自消） */}
      {groupMsg && <div className="tinyd" style={{ color: groupMsg.startsWith('任务群组暂不可用') ? '#e5534b' : '#15803d' }}>{groupMsg}</div>}
      {/* 任务卡右键菜单（§3.15 入口）：动作=可点菜单项；元信息（颗粒度/来源）不进菜单。
          「打开」=左键等价动作；action 未知 kind/非法 scheme 时不显示（§3.10 纪律 1-2）。
          破坏性动作（停止分享等）后端命令未就绪前不摆出来——宁可少一项，不可点了没反应。 */}
      {menu && (() => {
        const task = menu.task
        const act = task.action
        // 与左键同一条路由（2026-10-23）：有 env 的卡动作是「打开远程桌面/DSH Web」，
        // 走 `vnet_env_open`；没有 env 才显示原 open-url 的「打开」。
        const menuEnvs = declaredEnvsOfCard(task as unknown as Record<string, unknown>, act)
        const u = menuEnvs.length ? null : (act?.kind === 'open-url' ? safeActionUrl(act.url) : null)
        const openLabel = menuEnvs.length ? actionLabelOf(act, menuEnvs) : (act?.label || '打开')
        // 停止分享用的 shareId：任务直接给，或按后端命名约定 peer-task-share-<shareId> 反推
        const sid = task.shareId
          || (task.taskId?.startsWith('peer-task-share-') ? task.taskId.slice('peer-task-share-'.length) : null)
        const armed = revokeArm === task.taskId
        // 2026-10-11 改名入口：仅 owner（task.from===我的账号 did）可见；后端 chat_rename_task 另有强制校验
        const isTaskOwner = !!myDid && task.from === myDid
        return (
          <FzCtxMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} actions={[
            ...(isTaskOwner ? [{ key: 'rename', label: '✏️ 改名', run: () => setRenaming(task) }] : []),
            { key: 'group', label: groupBusy ? '正在打开任务群…' : '👥 打开任务群', run: () => { void openTaskGroup(task) } },
            // §3.14 caps + §3.22 可见性：授权与可见性（非破坏性，排在「打开任务群」之后、破坏性项之前）。
            // 没有 shareId 也**保留这一项**（菜单形状稳定），点了只给一句人话，不改任何东西。
            { key: 'grants', label: '🔑 授权与可见性', run: () => {
              if (!sid) { flashGroup('这个任务没有分享信息，暂时不能配置授权'); return }
              setGrantsOpen({ shareId: sid, title: task.title, grant: task.grant, sourceDeviceName: task.sourceDeviceName || task.sourceDevice, shareSnapshot: task.shareSnapshot, remoteOrigin: !!task.remoteOrigin })
            } },
            ...(u || menuEnvs.length ? [{ key: 'open', label: `↗ ${openLabel}`, run: () => {
              // 与左键同一实现（env 卡 → vnet_env_open；老卡 → 现签分享页）
              void openTaskCard(task)
            } }] : []),
            // 破坏性动作（§3.10 纪律 3）：放最后，且第一次点击只上膛，再点才执行
            ...(sid ? [{
              key: 'revoke',
              label: armed ? '⚠ 再点一次确认停止分享' : '🛑 停止分享',
              danger: true,
              // 上膛态：浅红底+加粗（菜单内原地可见"再点一次"）
              armed,
              // 未上膛时 keepOpen：第一次点击**原地**变文案（不关菜单），第二次再执行并关闭。
              // 这解决了"CtxMenu 点完必关导致二次确认要重开菜单"的不直观（2026-10-06 用户实测）。
              keepOpen: !armed,
              run: () => {
                if (!armed) {
                  setRevokeArm(task.taskId)
                  flashGroup('再点一次「🛑 停止分享」确认')
                  window.setTimeout(() => setRevokeArm((cur) => (cur === task.taskId ? null : cur)), 10_000)
                  return
                }
                void (async () => {
                  try {
                    await invokeT('share_revoke', { shareId: sid })
                    setRevokeArm(null)
                    flashGroup('已停止分享')
                    await onChanged()
                  } catch (e) { flashGroup(`停止分享失败：${String(e)}`) }
                })()
              },
            }] : []),
          ]} />
        )
      })()}
      {/* §3.14 caps + §3.22 可见性：授权与可见性面板（浮层；后端未就绪时面板内一句话降级，卡片列表不受影响） */}
      {grantsOpen && (
        <ShareGrantsPanel shareId={grantsOpen.shareId} taskTitle={grantsOpen.title}
          grant={grantsOpen.grant} sourceDeviceName={grantsOpen.sourceDeviceName}
          shareSnapshot={grantsOpen.shareSnapshot} memberReadonly={!!grantsOpen.remoteOrigin}
          onClose={() => setGrantsOpen(null)} onChanged={onChanged} flash={flashGroup} />
      )}
      {/* 2026-10-11 任务卡改名弹层（仅 owner 入口——右键菜单「✏️ 改名」） */}
      {renaming && (
        <RenameTaskDialog task={renaming} onClose={() => setRenaming(null)}
          onDone={async (newTitle) => { setRenaming(null); flashGroup(`已改名为「${newTitle}」`); await onChanged() }} />
      )}
    </div>
  )
}

/* ═══════════ 2026-10-11：任务卡改名弹层（owner 端；后端 chat_rename_task 落库+广播） ═══════════ */

function RenameTaskDialog({ task, onClose, onDone }: { task: PeerTask; onClose: () => void; onDone: (newTitle: string) => Promise<void> }) {
  const [title, setTitle] = useState(task.title)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const trimmed = title.trim()
  const unchanged = trimmed === task.title
  const doRename = async () => {
    setBusy(true); setErr(null)
    try {
      await invokeT('chat_rename_task', { taskId: task.taskId, title: trimmed })
      await onDone(trimmed)
    } catch (e) { setErr(briefErr(e)) } finally { setBusy(false) }
  }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 170, background: 'rgba(8,12,20,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}>
      <div className="cardd" onClick={(e) => e.stopPropagation()} style={{ width: 320, padding: 14, boxShadow: '0 18px 48px rgba(8,12,20,.3)' }}>
        <div className="h2d" style={{ fontSize: 13, marginBottom: 8 }}>✏️ 任务卡改名</div>
        <input value={title} onChange={(e) => setTitle(e.target.value.slice(0, 64))} placeholder="新标题（≤64 字）" autoFocus
          style={{ width: '100%', boxSizing: 'border-box', border: '1px solid var(--border,#e2e5ee)', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: 'inherit', background: 'var(--bg,#fff)', color: 'var(--tx,#1c2333)' }}
          onKeyDown={(e) => { if (e.key === 'Enter' && trimmed && !unchanged && !busy) void doRename() }} />
        <div className="tinyd" style={{ ...FZ_META, marginTop: 5 }}>改名会同步给一起做的所有人（以最后一次改名为准）</div>
        {err && <div className="tinyd" style={{ color: '#e5534b', marginTop: 5 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
          <span className="chipd gray" style={{ ...PEER_CHIP, cursor: 'pointer' }} onClick={onClose}>取消</span>
          <span className="endchip go" style={{ ...PEER_CHIP, cursor: busy || !trimmed || unchanged ? 'default' : 'pointer', opacity: busy || !trimmed || unchanged ? .5 : 1 }}
            onClick={() => { if (!busy && trimmed && !unchanged) void doRename() }}>{busy ? '改名中…' : '确认改名'}</span>
        </div>
      </div>
    </div>
  )
}

/* ═══════════ 好友/群分区（智能体 Tab） ═══════════ */

export function FriendsZone({ boardProjs, onPeerTasks, peerTasks, onUnreadTotal }: {
  boardProjs: { name: string; tasks?: { title?: string; closed?: boolean }[] }[]
  onPeerTasks: (t: PeerTask[]) => void
  peerTasks: PeerTask[]
  /** 批三：聊天总未读数上报（App 窗口标题 + 智能体 Tab 角标）。 */
  onUnreadTotal?: (n: number) => void
}) {
  const [st, setSt] = useState<ChatState | null>(null)
  const [notReady, setNotReady] = useState(false)
  const [openConv, setOpenConv] = useState<Conv | null>(null)
  const [taskDetail, setTaskDetail] = useState<Parameters<typeof TaskDetailOverlay>[0]['task'] | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addDid, setAddDid] = useState('')
  const [addMsg, setAddMsg] = useState<string | null>(null)
  const [addBusy, setAddBusy] = useState(false)
  const [grpOpen, setGrpOpen] = useState(false)
  const [grpName, setGrpName] = useState('')
  const [grpSel, setGrpSel] = useState<Set<string>>(new Set())
  const [grpMsg, setGrpMsg] = useState<string | null>(null)
  // 第82轮：删好友二次确认锚点 + 好友事件 toast 队列 + 前次好友快照（diff 检测）
  const [removeArming, setRemoveArming] = useState<string | null>(null)
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([])
  // 第85轮：群管理屏（全屏 overlay）
  const [groupManage, setGroupManage] = useState<ChatGroup | null>(null)
  // 批三：置顶/免打扰（本地持久化）+ 会话行右键菜单 + 草稿池（per-conv 保留）
  const [prefs, setPrefs] = useState<Record<string, ConvPref>>(() => loadConvPrefs())
  const [convMenu, setConvMenu] = useState<{ x: number; y: number; conv: Conv } | null>(null)
  const [draftMap, setDraftMap] = useState<Record<string, string>>({})
  const setDraft = useCallback((convId: string, v: string) => {
    setDraftMap((m) => {
      if (!v.trim()) { if (!(convId in m)) return m; const nx = { ...m }; delete nx[convId]; return nx }
      return m[convId] === v ? m : { ...m, [convId]: v }
    })
  }, [])
  const savePrefsNow = useCallback((next: Record<string, ConvPref>) => { setPrefs(next); saveConvPrefs(next) }, [])
  const togglePinConv = useCallback((id: string) => {
    const p = loadConvPrefs()
    const cur = p[id] ?? {}
    const next = { ...p, [id]: { ...cur, pin: cur.pin ? undefined : Date.now() } as ConvPref }
    savePrefsNow(next)
  }, [savePrefsNow])
  const toggleMuteConv = useCallback((id: string) => {
    const p = loadConvPrefs()
    const cur = p[id] ?? {}
    const next = { ...p, [id]: { ...cur, mute: !cur.mute } }
    savePrefsNow(next)
  }, [savePrefsNow])
  const prevFriendsRef = useRef<Friend[] | null>(null)
  const pushToast = useCallback((text: string) => {
    const id = Date.now() + Math.random()
    setToasts((ts) => [...ts, { id, text }])
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4200)
  }, [])
  // 批二：群事件 toast（被踢/群解散）——groups 快照 diff（好友 toast 同款模式）。
  // ingest 落终态（status=kicked/disbanded）后下一轮 poll 即被发现；本地主动操作
  // （我自己退群/解散）已由 act() 直接 toast，这里用 prevGroupsRef 过滤只报"被动到达"。
  const prevGroupsRef = useRef<ChatGroup[] | null>(null)
  const detectGroupEvents = useCallback((next: ChatGroup[], myDid: string) => {
    const prev = prevGroupsRef.current
    prevGroupsRef.current = next
    if (!prev) return
    for (const g of next) {
      const before = prev.find((x) => x.id === g.id)
      const wasTerminal = before?.status === 'disbanded' || before?.status === 'kicked'
      if (wasTerminal) continue
      if (g.status === 'kicked') pushToast(`🚫 你已被移出群「${g.name}」`)
      // 我是 owner 的解散=我自己（或我另一台设备）的操作，act() 已 toast，不双报
      else if (g.status === 'disbanded' && g.owner !== myDid) pushToast(`📢 群「${g.name}」已被群主解散`)
    }
  }, [pushToast])
  const detectFriendEvents = useCallback((next: Friend[], myRemoveSet: Set<string>) => {
    const prev = prevFriendsRef.current
    prevFriendsRef.current = next
    if (!prev) return
    const fst = (f: Friend) => f.status || (f.pending ? 'in-pending' : 'ok')
    for (const f of next) {
      const before = prev.find((x) => x.did === f.did)
      if (!before && fst(f) === 'in-pending') pushToast(`📩 ${f.name} 请求加你为好友`)
      if (before && fst(before) !== 'ok' && fst(f) === 'ok') pushToast(`🎉 ${f.name} 已通过好友请求`)
    }
    for (const b of prev) {
      if (b.status === 'ok' && !next.find((x) => x.did === b.did) && !myRemoveSet.has(b.did)) {
        pushToast(`${b.name} 已将你移除好友`)
      }
    }
  }, [pushToast])
  const myRemoveSetRef = useRef<Set<string>>(new Set())
  // 第84轮：好友在线状态（灯）——chat_presence 5s 轮询；typing 指示。
  // 2026-10-18 M11：对账进度横幅（"正在与「X」对账历史…"）删除——过程不呈现给用户。
  const [presence, setPresence] = useState<Record<string, FriendPresence>>({})
  useEffect(() => {
    const load = () => {
      invokeT<{ friends: Record<string, FriendPresence> }>('chat_presence')
        .then((r) => setPresence(r.friends ?? {}))
        .catch(() => {})
    }
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  /* 设备群（2026-10-07 设计 §3 决策F）：会话列表行副题数据源——chat_device_group_info
   * 15s 轮询（Rust 侧同款缓存；命令未就绪/失败 → null，行副题降级「本账号设备」，
   * 不影响列表/聊天）。群列表里有设备群才轮询（每账号必有，但命令未注册期零噪音）。 */
  const [devGrpInfo, setDevGrpInfo] = useState<DeviceGroupInfo | null>(null)
  const hasDevGroup = !!st && (st.groups ?? []).some((g) => isDeviceGroup(g))
  useEffect(() => {
    if (!hasDevGroup) { setDevGrpInfo(null); return }
    let alive = true
    const loadDevInfo = () => {
      invokeT<DeviceGroupInfo>('chat_device_group_info')
        .then((r) => { if (alive) setDevGrpInfo(r ?? null) })
        .catch(() => { if (alive) setDevGrpInfo(null) })
    }
    loadDevInfo()
    const t = setInterval(loadDevInfo, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [hasDevGroup])

  /* 设备群首见自动置顶（决策 F.2）：一次性种子——prefs 键存在（含用户手动取消置顶后的
   * {pin:undefined}）就不再种，尊重用户。纯函数 seedDeviceGroupPins（chatOps，单测覆盖）。 */
  useEffect(() => {
    if (!st) return
    const r = seedDeviceGroupPins(st.convs ?? [], st.groups ?? [], prefs, Date.now())
    if (r.changed) savePrefsNow(r.next)
  }, [st, prefs, savePrefsNow])

  const refresh = useCallback(async () => {
    try {
      const s = await invokeT<ChatState>('chat_state')
      setSt(s); setNotReady(false)
      detectFriendEvents(s.friends ?? [], myRemoveSetRef.current)
      detectGroupEvents(s.groups ?? [], s.myDid ?? '')
      onPeerTasks(s.tasks ?? [])
    } catch (e) {
      const msg = String(e)
      if (msg.includes('未登录')) setNotReady(true)
    }
  }, [onPeerTasks, detectFriendEvents, detectGroupEvents])

  const poll = useCallback(async () => {
    try {
      const s = await invokeT<ChatState & { ingested?: number }>('chat_poll')
      setSt(s); setNotReady(false)
      detectFriendEvents(s.friends ?? [], myRemoveSetRef.current)
      detectGroupEvents(s.groups ?? [], s.myDid ?? '')
      onPeerTasks(s.tasks ?? [])
    } catch { /* 网络抖动静默，refresh 兜底 */ }
  }, [onPeerTasks, detectFriendEvents, detectGroupEvents])

  // chat-incoming：P2P 直推消息立即拉取（不等 5s 轮询）。
  // 2026-10-18 M11：p2p-sync-progress 不再驱动 UI（对账横幅/完成 toast 都属过程噪声）。
  useEffect(() => {
    const un2 = listen('chat-incoming', () => { void poll() }).catch(() => (() => {}))
    return () => { void un2.then((f) => f()) }
  }, [poll])

  useEffect(() => { void refresh() }, [refresh])
  // 5s 轮询（智能体 Tab 内）；App 级后台轮询（refreshPeerTasks）负责其他 Tab 时的收件——
  // 它更新 peerTasks prop，这里跟着重读全量状态（好友/会话列表）。
  useEffect(() => {
    const t = setInterval(() => { void poll() }, 5000)
    return () => clearInterval(t)
  }, [poll])
  useEffect(() => { void refresh() }, [peerTasks, refresh])
  // §3.19：任务群身份登记（peerTasks 里带 groupId 的）——从会话列表左键进任务群时
  // 也认得出"这是任务群"，顶部才显示四色成员条。
  useEffect(() => { rememberTaskGroupsFromTasks(peerTasks) }, [peerTasks])
  // 批三：聊天总未读数上报（App 窗口标题 + 智能体 Tab 角标；免打扰会话不计入）
  useEffect(() => {
    if (!st || !onUnreadTotal) return
    onUnreadTotal(totalUnread(st.convs, prefs))
  }, [st, prefs, onUnreadTotal])
  // 批三：系统通知点击 → App 切到智能体 Tab 后发 myco:open-conv——按 convId 开聊天屏
  // §3.19：任务卡右键「打开任务群」也复用这条通道（detail=群 id）。
  // 找不到会话就按好友/群档案构造空会话；任务群（groupId 登记过）即便还没同步进
  // 会话表也能开——否则右键"打开任务群"会静默无反应。
  const openConvById = useCallback((id: string): boolean => {
    if (!id || !st) return false
    setGroupManage(null)
    const c = st.convs.find((x) => x.id === id)
    if (c) { setOpenConv(c); return true }
    const f = st.friends.find((x) => x.did === id)
    if (f) { setOpenConv({ id: f.did, kind: 'friend', title: f.name, lastTs: 0, lastText: '' }); return true }
    const g = st.groups.find((x) => x.id === id)
    if (g) { setOpenConv({ id: g.id, kind: 'group', title: g.name, lastTs: 0, lastText: '' }); return true }
    const tg = taskGroupRefs.get(id)
    if (tg) {
      // 新建的任务群本地档案可能还没同步到：先开会话，同时拉一次全量（档案到达后
      // 群名/成员数自动补齐；聊天本身走 chat_load_conv/chat_send_group）。
      setOpenConv({ id, kind: 'group', title: tg.title || '任务群', lastTs: 0, lastText: '' })
      void poll()
      return true
    }
    return false
  }, [st, poll])
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<string>).detail
      if (!id) return
      // 即时消费成功才清暂存；st 还没就绪（返回 false）时留着给下一个 effect 兜
      if (openConvById(id)) pendingOpenConvId = null
    }
    window.addEventListener('myco:open-conv', onOpen)
    return () => window.removeEventListener('myco:open-conv', onOpen)
  }, [openConvById])
  // 兜住竞态：事件早于 FriendsZone 挂载/st 就绪时（App 切 Tab 后 400ms 才发，但 st 可能
  // 还没回来）——模块级暂存 id，st 一到就消费，不让"打开任务群"点了没反应。
  useEffect(() => {
    if (!st || !pendingOpenConvId) return
    const id = pendingOpenConvId
    pendingOpenConvId = null // st 已就绪，消费一次即可（留着会每 5s 重复打开）
    openConvById(id)
  }, [st, openConvById])
  // 批三：通知点击的挂接在 App 层（bindNotifAction）——这里只负责消费跳转事件

  const friends = st?.friends ?? []
  const fst = (f: Friend) => f.status || (f.pending ? 'in-pending' : 'ok')
  const pending = friends.filter((f) => fst(f) === 'in-pending')
  const waiting = friends.filter((f) => fst(f) === 'out-pending')
  const okFriends = friends.filter((f) => fst(f) === 'ok')
  const groups = st?.groups ?? []
  // 批三：会话列表微信化——convs 序（置顶块在前+lastTs 新→旧）；pending 态好友的
  // 空会话不进列表（在上方"待确认/等待"专区），聊过天的保留（lastTs>0 防误伤）
  const convRows = useMemo(() => {
    const okSet = new Set(okFriends.map((f) => f.did))
    const rows = (st?.convs ?? []).filter((c) =>
      c.kind === 'group' ? true : okSet.has(c.id) || c.lastTs > 0)
    return sortConvs(rows, prefs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st?.convs, prefs, st?.friends])

  const doAddFriend = async () => {
    // 2026-10-05：DID 完整性校验（长度窗+字母表）——残缺串（复制丢字）就地提示，不发请求
    if (!isValidDid(addDid)) { setAddMsg('DID 格式不对（长度/字符异常——复制时可能丢字，请重新复制）'); return }
    if (addBusy) return
    setAddBusy(true); setAddMsg(null)
    try {
      await invokeT('chat_add_friend', { did: addDid.trim(), name: '' })
      setAddMsg('✓ 已发送请求，等待对方通过（通过后这里会提示）')
      setAddDid('')
      await poll()
    } catch (e) { setAddMsg(`✗ ${String(e)}`) } finally { setAddBusy(false) }
  }
  // 批三：接受/忽略补 catch 错误提示（此前静默失败=点了没反应还无反馈）
  const doAccept = async (did: string) => {
    try { await invokeT('chat_accept_friend', { did }); await poll() }
    catch (e) { pushToast(`✗ 接受失败：${String(e)}`) }
  }
  const doIgnore = async (did: string) => {
    try { await invokeT('chat_ignore_friend', { did }); await poll() }
    catch (e) { pushToast(`✗ 忽略失败：${String(e)}`) }
  }
  // 第82轮：删好友（二次确认防误触；删后本地 toast）
  // 批三修：Rust 失败不再假成功 toast——成功才报喜，失败报原因
  const doRemove = async (f: Friend) => {
    if (removeArming !== f.did) { setRemoveArming(f.did); setTimeout(() => setRemoveArming((cur) => cur === f.did ? null : cur), 2500); return }
    setRemoveArming(null)
    try {
      await invokeT('chat_remove_friend', { did: f.did })
      myRemoveSetRef.current.add(f.did)
      pushToast(`已删除好友 ${f.name}`)
    } catch (e) {
      pushToast(`✗ 删除失败：${String(e)}`)
    }
    await poll()
  }
  /** 批三：删除会话（不删好友/群——清本地会话记录，聊天中则先退出聊天屏）。 */
  const deleteConv = async (c: Conv) => {
    try {
      await invokeT('chat_delete_conv', { convId: c.id })
      if (openConv?.id === c.id) setOpenConv(null)
      pushToast(`已删除与「${shortDid(c.title) || '会话'}」的聊天记录`)
      await poll()
    } catch (e) { pushToast(`✗ 删除会话失败：${String(e)}`) }
  }
  const doCreateGroup = async () => {
    if (!grpSel.size || addBusy) return
    setAddBusy(true); setGrpMsg(null)
    try {
      await invokeT('chat_create_group', { name: grpName, members: [...grpSel] })
      setGrpMsg('✓ 群已创建')
      setGrpName(''); setGrpSel(new Set()); setGrpOpen(false)
      await poll()
    } catch (e) { setGrpMsg(`✗ ${String(e)}`) } finally { setAddBusy(false) }
  }

  // 任务卡气泡点击 → 详情（从 peer 任务库补状态/字段）
  const openTaskFromMsg = (m: ChatMsg) => {
    const p = m.payload as { taskId?: string }
    const local = peerTasks.find((t) => t.taskId === p.taskId)
    const pm = m.payload as Record<string, unknown>
    if (local) setTaskDetail(local)
    else setTaskDetail({ taskId: String(p.taskId || ''), title: String(pm.title || '任务'), desc: pm.desc as string | undefined, requirements: pm.requirements as string | undefined, rSpec: pm.rSpec as never, reward: pm.reward as string | undefined, fromName: pm.fromName as string | undefined, expiresAt: pm.expiresAt as number | undefined, createdAt: pm.createdAt as number | undefined, status: 'pending' })
  }

  if (notReady) return null // 未登录不渲染（任务书：好友区挂在登录态后面）

  // 分享我的任务的数据源：任务看板扁平化（渲染层只读，不碰任务逻辑）
  const boardTasksSource = useMemo(() => [
    ...boardProjs.flatMap((p) =>
      (p.tasks ?? []).map((t) => ({ title: t.title || p.name, projectName: p.name }))),
    // 我分享出去的任务也列进来——它们带 shareId，分享给好友时后端会自动授权（分享任务卡=授权）
    ...(peerTasks ?? []).filter((t) => !!t.shareId)
      .map((t) => ({ title: t.title || '分享任务', projectName: '我的分享', shareId: t.shareId })),
  ], [boardProjs, peerTasks])

  return (
    <div className="cardd">
      {/* 第82轮：好友事件 toast（通过/新请求/被移除）——fixed 不占布局 */}
      {toasts.length > 0 && (
        <div style={{ position: 'fixed', top: 46, right: 12, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {toasts.map((t) => (
            <div key={t.id} style={{ padding: '7px 12px', borderRadius: 8, background: 'rgba(30,35,50,.92)', color: '#fff', fontSize: 12, boxShadow: '0 4px 14px rgba(0,0,0,.25)', maxWidth: 240 }}>{t.text}</div>
          ))}
        </div>
      )}
      {/* 2026-10-18 M11：对账横幅"正在与「X」对账历史…"已删除——同步是后台事，
          聊天流只呈现人对人内容（原 syncBanner 状态机随之移除）。 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="h2d" style={{ fontSize: 12.5 }}>好友</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="textlink"><span className="linkish" onClick={() => { setGrpOpen(false); setAddOpen((v) => !v) }}>＋ 加好友</span></span>
          <span className="textlink"><span className="linkish" onClick={() => { setAddOpen(false); setGrpOpen((v) => !v) }}>＋ 建群</span></span>
        </div>
      </div>

      {/* 我发出的请求（等待对方通过）——第82轮：发送方终于能看到状态了 */}
      {waiting.map((f) => (
        <div key={f.did} className="devline" style={{ marginTop: 6, opacity: 0.75 }}>
          <span className="dot" style={{ background: '#94a3b8' }} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {f.name}{tail4(f.did)} · 等待对方通过
          </span>
          {/* 2026-10-07：撤回同走 doRemove 的两步确认——首击只上膛，必须给出可见反馈，
              否则与右键「删好友」同款"点了没反应"（原地变文案=上膛锚点）。 */}
          <span className="endchip" style={{ cursor: 'pointer', color: removeArming === f.did ? '#e5534b' : 'var(--muted)', fontWeight: removeArming === f.did ? 700 : 400 }} onClick={() => void doRemove(f)}>{removeArming === f.did ? '确认撤回？' : '撤回'}</span>
        </div>
      ))}

      {/* 待确认好友请求 */}
      {pending.map((f) => (
        <div key={f.did} className="devline" style={{ marginTop: 6 }}>
          <span className="dot" style={{ background: '#f59e0b' }} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {f.name}{tail4(f.did)} · 请求加好友
          </span>
          <span className="endchip" style={{ cursor: 'pointer', color: 'var(--muted)' }} onClick={() => void doIgnore(f.did)}>忽略</span>
          <span className="endchip go" style={{ cursor: 'pointer' }} onClick={() => void doAccept(f.did)}>接受</span>
        </div>
      ))}

      {/* 会话列表（批三 微信化：convs 序=置顶+lastTs，行内时间/未读计数/[草稿]/📌；
          右键菜单=置顶/免打扰/删除会话/删除好友[批四收二级，一级 ✕ 已撤，二次确认保留]） */}
      {/* 2026-10-07 文案统一：好友空态同走「识别码」词系（原「填对方 DID 或扫码互加」） */}
      {okFriends.length === 0 && pending.length === 0 && (
        <div className="tinyd" style={{ marginTop: 6 }}>还没有好友——填对方识别码或扫码互加</div>
      )}
      {convRows.map((c) => {
        const isG = c.kind === 'group'
        const name = isG ? (shortDid(c.title) || '群') : dispNameOf(c.id, st?.friends ?? [], c.title)
        const pref = prefs[c.id] ?? {}
        const g = isG ? groups.find((x) => x.id === c.id) : undefined
        // 设备群（决策F）：档案 kind 或 grp-dev- 前缀双判定（档案未同步时前缀兜底）
        const isDev = isG && isDeviceGroup(g ?? { id: c.id })
        // 批二：终态群（已解散/已被移出）=灰色只读行，历史可回查（会话不删）
        const terminal = !!g && (g.status === 'disbanded' || g.status === 'kicked')
        const typer = isG && g && !terminal ? firstTypingMember(g.members, presence, st?.myDid) : null
        const typingMe = !isG && presence[c.id]?.online && presence[c.id]?.state === 'typing'
        const draftTxt = draftPreview(draftMap[c.id])
        const unreadN = c.unreadN ?? (c.unread ? 1 : 0)
        return (
          <div key={c.id} className="devline" style={{ marginTop: 4, cursor: 'pointer', fontWeight: 600, alignItems: 'center', opacity: terminal ? 0.55 : 1 }}
            onClick={() => setOpenConv(c)}
            onContextMenu={(e) => { e.preventDefault(); setConvMenu({ x: e.clientX, y: e.clientY, conv: c }) }}>
            {/* 头像（批三 三处统一：首字+散列取色）；单聊左下在线灯 */}
            <span style={{ position: 'relative', flexShrink: 0 }}>
              <Ava name={isG ? (g?.name ?? name) : name} size={28} square />
              {!isG && <span style={{ position: 'absolute', right: -2, bottom: -2 }}><PresenceDot p={presence[c.id]} size={7} /></span>}
            </span>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {!!pref.pin && <span title="已置顶" style={{ marginRight: 3, fontSize: 10 }}>📌</span>}
                  {/* 设备群（决策F）：📱 徽标 + 副题「N 台设备」（members 恒单账号，
                      "(N人)" 语义失真；名册未取到降级「本账号设备」） */}
                  {isG ? (isDev ? '📱 ' : '👥 ') : ''}{name}
                  {isG && g && !terminal && !isDev && <span style={{ color: 'var(--muted)', fontSize: 10, fontWeight: 400 }}> ({g.members.length}人)</span>}
                  {isDev && !terminal && <span style={{ color: 'var(--muted)', fontSize: 10, fontWeight: 400 }}> {deviceGroupRowSub(devGrpInfo)}</span>}
                  {terminal && <span style={{ color: '#8a93a8', fontSize: 10, fontWeight: 700 }}>{g?.status === 'disbanded' ? ' 已解散' : ' 已被移出'}</span>}
                  {!isG && <span style={{ color: 'var(--muted)', fontSize: 10, fontWeight: 400 }}> {tail4(c.id)}</span>}
                </span>
                {c.lastTs > 0 && <span className="tinyd" style={{ fontSize: 9.5, flexShrink: 0 }}>{fmtConvTime(c.lastTs)}</span>}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10.5, fontWeight: 400 }}>
                  {/* 预览优先级：[草稿] > 对方正在输入 > 最后消息（微信语义） */}
                  {draftTxt
                    ? <><span style={{ color: '#e5534b', fontWeight: 700 }}>[草稿]</span> <span style={{ color: 'var(--muted)' }}>{draftTxt}</span></>
                    : (typingMe || typer)
                      ? <span style={{ color: '#22c55e' }}>{typer ? `${dispNameOf(typer, st?.friends ?? [])} ` : ''}正在输入…</span>
                      : <span style={{ color: 'var(--muted)' }}>{humanConvPreview(c.lastText)}</span>}
                </span>
                {/* 未读：免打扰=灰点（不计数）；否则红胶囊数字化（>99 显 99+） */}
                {pref.mute
                  ? (unreadN > 0 && <span title={`${unreadN} 条未读（免打扰）`} style={{ width: 7, height: 7, borderRadius: 4, background: '#c3c9d6', flexShrink: 0 }} />)
                  : unreadN > 0 && (
                    <span style={{ minWidth: 16, height: 16, borderRadius: 8, background: '#e5534b', color: '#fff', fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px', flexShrink: 0 }}>
                      {unreadBadge(unreadN)}
                    </span>
                  )}
                {/* 批四（2026-09-29 实测修法）：行尾一级 ✕ 删好友撤除（易误触）——
                    收进右键菜单二级（下方 convMenu 的"删除好友"项），二次确认保留。 */}
              </span>
            </span>
          </div>
        )
      })}
      {/* 批三：会话行右键菜单（置顶/免打扰/删除会话；批四：删好友收进来二级——
          一级行尾 ✕ 已撤。二次确认保留：第一次点=武装 2.5s，菜单项变"确认删除好友？"，再点=删） */}
      {convMenu && (() => {
        const menuFriend = convMenu.conv.kind !== 'group'
          ? okFriends.find((f) => f.did === convMenu.conv.id) : undefined
        return (
          <FzCtxMenu x={convMenu.x} y={convMenu.y} onClose={() => setConvMenu(null)} actions={[
            { key: 'pin', label: prefs[convMenu.conv.id]?.pin ? '取消置顶' : '📌 置顶', run: () => togglePinConv(convMenu.conv.id) },
            { key: 'mute', label: prefs[convMenu.conv.id]?.mute ? '取消免打扰' : '🔕 免打扰', run: () => toggleMuteConv(convMenu.conv.id) },
            { key: 'del', label: '删除会话', danger: true, run: () => void deleteConv(convMenu.conv) },
            ...(menuFriend ? [{
              key: 'rmfriend', danger: true,
              armed: removeArming === menuFriend.did,
              label: removeArming === menuFriend.did ? '确认删除好友？' : '删除好友',
              // 2026-10-07 实测修：FzCtxMenu 默认"点完必关"，而删好友首击只上膛
              // （doRemove 首击 setRemoveArming 后 return，不删）——菜单当场关闭 ⇒
              // 用户永远看不到「确认删除好友？」上膛态，观感="没有确认弹窗 / 点了没反应 /
              // 好友还在列表"，且第二击无从发生。与同文件「🛑 停止分享」(keepOpen: !armed)
              // 同一模式：未上膛保持菜单打开，第二击才执行并关闭。
              keepOpen: removeArming !== menuFriend.did,
              run: () => { void doRemove(menuFriend) },
            }] : []),
          ]} />
        )
      })()}

      {/* 加好友弹层（2026-10-07 重排）：320 窄窗通栏——粘贴对方识别码（主操作）→ 发送 →
          我的识别码（二维码 + 我的账号复制行，次要，下方独立成块）。
          旧版左右分栏在 320 窄窗把输入框压到 114px（占位符实测 191px → 截断）且按钮不同宽；
          这次主/次分层 + 8px 节奏，样式全在 demo.css .addfr-*（五主题走 biolum 变量）。
          词系统一「识别码」（不再出现「有灵账号」；DID 只作格式示例）。
          2026-10-05 行为保留：粘贴非法识别码实时红框 + 橙字提示，发送按钮保持禁用。 */}
      {addOpen && st && (
        <div className="addfr-panel">
          <div className="addfr-title">加好友</div>
          <div className="addfr-guide">粘贴对方的识别码：</div>
          <textarea rows={2} value={addDid} onChange={(e) => setAddDid(e.target.value.trim())}
            placeholder="粘贴对方识别码（did:…）" className="addfr-ta"
            style={addDid && !isValidDid(addDid) ? { borderColor: '#e5534b', boxShadow: '0 0 0 1px rgba(229,83,75,.25)' } : undefined} />
          {addDid && !isValidDid(addDid) && (
            <div className="addfr-warn">识别码格式不对（长度/字符异常——复制时可能丢字，请重新复制）</div>
          )}
          <button className="addfr-primary" disabled={addBusy || !isValidDid(addDid)} onClick={() => void doAddFriend()}>{addBusy ? '发送中…' : '发送好友请求'}</button>
          {addMsg && <div className="addfr-msg" style={{ color: addMsg.startsWith('✓') ? '#22c55e' : '#e5534b' }}>{addMsg}</div>}
          <div className="addfr-sep" />
          <div className="addfr-mine">
            <QrImage text={st.myDid} size={128} />
            <div className="addfr-mine-cap">我的识别码</div>
            <div className="addfr-mine-sub">对方扫码加我为好友</div>
          </div>
          <div className="addfr-account" title={`点一下复制完整识别码：${st.myDid}`}
            onClick={() => { void copyDidVerified(st.myDid).then((r) => pushToast(copyDidToastText(r))).catch(() => pushToast('复制失败，请重试')) }}>
            <span className="addfr-account-label">我的账号</span>
            <span className="addfr-account-did">DID: {tail4(st.myDid)}</span>
            <span className="addfr-account-copy">⧉ 复制</span>
          </div>
        </div>
      )}

      {/* 建群弹层 */}
      {grpOpen && (
        <div className="cardd info-cardd" style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>建群</div>
          <input value={grpName} onChange={(e) => setGrpName(e.target.value.slice(0, 24))} placeholder="群名（默认「新群聊」）" style={{ ...inputS, width: '100%', marginTop: 6 }} />
          <div className="tinyd" style={{ margin: '6px 0 2px' }}>选择成员（已选 {grpSel.size}）</div>
          {okFriends.map((f) => (
            <label key={f.did} className="devline" style={{ marginTop: 3, cursor: 'pointer', fontWeight: 400 }}>
              <input type="checkbox" checked={grpSel.has(f.did)} onChange={(e) => {
                const nx = new Set(grpSel)
                if (e.target.checked) nx.add(f.did); else nx.delete(f.did)
                setGrpSel(nx)
              }} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0 }}>{f.name}</span>
            </label>
          ))}
          <button className="btnd small" style={{ marginTop: 8 }} disabled={!grpSel.size} onClick={() => void doCreateGroup()}>创建</button>
          {grpMsg && <div className="tinyd" style={{ marginTop: 4, color: grpMsg.startsWith('✓') ? '#22c55e' : '#e5534b' }}>{grpMsg}</div>}
        </div>
      )}

      {/* 聊天屏（全屏 overlay）——批三：key=conv.id 切会话整屏重挂（草稿/引用/
          未读锚/滚动态干净复位）；draft 由父组件 draftMap 跨会话保留 */}
      {openConv && st && !groupManage && (
        <ChatScreen key={openConv.id} conv={openConv} st={st} boardTasksSource={boardTasksSource} onBack={() => { setOpenConv(null); void poll() }} onChanged={() => void poll()} onOpenTask={openTaskFromMsg}
          presence={presence} onOpenGroupManage={(g) => setGroupManage(g)}
          draft={draftMap[openConv.id] ?? ''} onDraft={setDraft}
          taskGroupShareId={openConv.kind === 'group' ? taskGroupRefs.get(openConv.id)?.shareId : undefined} />
      )}
      {/* 第85轮：群管理屏 */}
      {groupManage && st && (
        <GroupManageScreen g={groupManage} st={st} onBack={() => { setGroupManage(null); void poll() }} onChanged={() => void poll()} pushToast={pushToast} />
      )}
      {/* 任务卡详情 */}
      {taskDetail && <TaskDetailOverlay task={taskDetail} onClose={() => setTaskDetail(null)} onChanged={() => void poll()} />}
    </div>
  )
}

/* ═══════════ 第85轮：群管理屏（群主：改名/拉人/踢人/禁言；成员：成员表+退出群） ═══════════ */

function GroupManageScreen({ g: gInit, st, onBack, onChanged, pushToast }: {
  g: ChatGroup
  st: ChatState
  onBack: () => void
  onChanged: () => void
  pushToast: (t: string) => void
}) {
  // 每次操作后 onChanged 拉全量——本地从 st.groups 找最新档案
  const g = st.groups.find((x) => x.id === gInit.id) ?? gInit
  const isOwner = (g.owner ?? g.members[0]) === st.myDid
  const [name, setName] = useState(g.name)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteDid, setInviteDid] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const act = async (label: string, f: () => Promise<unknown>) => {
    setBusy(true); setErr(null)
    try { await f(); await onChanged(); pushToast(label) }
    catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }

  const friendName = (did: string): string => {
    if (did === st.myDid) return `${st.myName}（我）`
    // 2026-09-29：名称字段护栏——全称 did 压 …尾4（与 ChatBubble.shortDid 同口径）。
    return shortDid(st.friends.find((f) => f.did === did)?.name ?? '') || `…${did.slice(-4)}`
  }
  const mutedNow = (did: string) => (g.muted?.[did] ?? 0) > Date.now()
  // 2026-09-29：与 ChatScreen 同款两修（让位 TitleBar + 头部 drag region）。
  const tbBottom = useTitleBarBottom()
  const dragDown = useDragRegionFx()

  return (
    <div style={{ position: 'fixed', top: tbBottom, left: 0, right: 0, bottom: 0, zIndex: 230, background: 'var(--bg, #f6f7fa)', display: 'flex', flexDirection: 'column' }}>
      <div data-tauri-drag-region onMouseDown={dragDown} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: 'var(--chrome-bg, #fff)', borderBottom: '1px solid var(--bd, #e2e5ee)' }}>
        <button className="bk" onClick={onBack}>‹ 返回</button>
        {/* 2026-10-13 修（用户截图反馈：标题靠左、⚙️ 挤在返回键旁）：本屏从未参与
            10-12 的"标题居中改造"——ChatScreen 改了，这里还是老结构（返回 + flex:1
            左对齐标题，⚙️ 写死在标题串里）。对齐 ChatScreen 同款微信式三段：
            左返回 / 中标题（绝对居中）/ 右 ⚙️。
            右侧 ⚙️ 是**装饰**不是按钮（本屏就是管理页，⚙️ 无可去的去处，可点即假按钮）。 */}
        <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', minWidth: 0, maxWidth: '52%', textAlign: 'center', pointerEvents: 'none' }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--tx, #1c2333)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>群管理 · {shortDid(g.name) || '群'}</div>
          <div style={{ fontSize: 10.5, color: 'var(--muted, #8a93a8)' }}>{g.members.length} 位成员{isOwner ? ' · 你是群主' : ''}</div>
        </div>
        <span aria-hidden style={{ marginLeft: 'auto', flexShrink: 0, width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: '1px solid var(--bd,#e2e5ee)', fontSize: 13, opacity: 0.55, userSelect: 'none' }}>⚙️</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
        {/* 改群名（仅群主） */}
        {isOwner && (
          <div className="cardd" style={{ marginBottom: 10 }}>
            <div className="h2d" style={{ fontSize: 12.5 }}>群名</div>
            <div style={{ display: 'flex', gap: 7, marginTop: 6 }}>
              <input value={name} onChange={(e) => setName(e.target.value.slice(0, 24))} style={{ ...inputS, flex: 1 }} />
              <button className="btnd small" disabled={busy || !name.trim() || name === g.name}
                onClick={() => void act('群名已更新', () => invokeT('chat_group_rename', { groupId: g.id, newName: name }))}>保存</button>
            </div>
          </div>
        )}
        {/* 成员列表 */}
        <div className="cardd" style={{ marginBottom: 10 }}>
          <div className="h2d" style={{ fontSize: 12.5 }}>成员（{g.members.length}）</div>
          {g.members.map((did) => {
            const isOwnerDid = (g.owner ?? g.members[0]) === did
            const mName = friendName(did)
            return (
              <div key={did} className="devline" style={{ marginTop: 5 }}>
                {/* 批三：群管理头像与会话列表/聊天同款（首字+散列取色） */}
                <Ava name={mName.replace(/（我）$/, '')} size={22} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {mName}{isOwnerDid && <span style={{ color: '#6b7bff', fontSize: 10, fontWeight: 700 }}> 群主</span>}
                  {mutedNow(did) && <span style={{ color: '#f59e0b', fontSize: 10, fontWeight: 700 }}> 禁言中</span>}
                </span>
                {/* 群主可踢人/禁言（对自己只显示徽章） */}
                {isOwner && did !== st.myDid && (
                  <>
                    <span className="endchip" style={{ cursor: 'pointer', color: mutedNow(did) ? '#22c55e' : '#f59e0b', fontSize: 10 }}
                      title={mutedNow(did) ? '解除禁言' : '禁言 10 分钟'}
                      onClick={() => void act(mutedNow(did) ? '已解除禁言' : '已禁言 10 分钟', () => invokeT('chat_group_mute', { groupId: g.id, targetDid: did, mutedUntil: mutedNow(did) ? 0 : Date.now() + 600_000 }))}>
                      {mutedNow(did) ? '解禁' : '禁言'}
                    </span>
                    <span className="endchip" style={{ cursor: 'pointer', color: '#e5534b', fontSize: 10 }}
                      onClick={() => void act('已移出成员', () => invokeT('chat_group_kick', { groupId: g.id, targetDid: did }))}>移出</span>
                  </>
                )}
              </div>
            )
          })}
          {/* 拉人（仅群主）：从好友选 + 填 DID */}
          {isOwner && (
            <div style={{ marginTop: 8 }}>
              {!inviteOpen ? (
                <button className="btnd small ghost" onClick={() => setInviteOpen(true)}>＋ 拉好友进群</button>
              ) : (
                <div>
                  {st.friends.filter((f) => f.status === 'ok' && !g.members.includes(f.did)).map((f) => (
                    <div key={f.did} className="devline" style={{ marginTop: 3, cursor: 'pointer' }} onClick={() => void act(`${f.name} 已加入群聊`, () => invokeT('chat_group_invite', { groupId: g.id, newMembers: [f.did] }))}>
                      <span className="dot" style={{ background: '#34d399' }} />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name} <span style={{ color: 'var(--muted)', fontSize: 10 }}>{tail4(f.did)}</span></span>
                      <span className="endchip go">拉入 ›</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 7, marginTop: 6 }}>
                    {/* 2026-10-07 文案统一：拉好友进群同样是「识别码」词系（原「或粘贴 有灵账号 DID」） */}
                    <input value={inviteDid} onChange={(e) => setInviteDid(e.target.value.trim())} placeholder="或粘贴识别码（did:…）" style={{ ...inputS, flex: 1, fontFamily: 'ui-monospace,monospace' }} />
                    <button className="btnd small" disabled={!inviteDid.startsWith('did:')}
                      onClick={() => void act('已发出邀请', () => invokeT('chat_group_invite', { groupId: g.id, newMembers: [inviteDid] }))}>拉入</button>
                  </div>
                  <button className="btnd small ghost" style={{ marginTop: 6 }} onClick={() => setInviteOpen(false)}>收起</button>
                </div>
              )}
            </div>
          )}
        </div>
        {/* 治理说明（governance 预留字段：恒 owner，未来可选投票制） */}
        <div className="tinyd" style={{ margin: '6px 2px' }}>群治理：加入即授权群主管理（owner 制；未来可选投票制）</div>
        {/* 退出群（任何人）。批二：群主=解散（名实相符——广播 group-disband，
            全体成员群会话保留只读+系统条"群已被解散"；本端同样置终态）。 */}
        <button className="btnd ghost" style={{ width: '100%', color: '#e5534b', borderColor: '#e5534b55' }} disabled={busy}
          onClick={() => void act(isOwner ? '你已解散群聊' : '你已退出群聊', async () => { await invokeT('chat_group_leave', { groupId: g.id }); onBack() })}>
          {isOwner ? '解散群聊并退出（全员保留历史只读）' : '退出群聊'}
        </button>
        {err && <div className="tinyd" style={{ color: '#e5534b', marginTop: 6 }}>{err}</div>}
      </div>
    </div>
  )
}
