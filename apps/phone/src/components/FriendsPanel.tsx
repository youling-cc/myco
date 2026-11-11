/**
 * FriendsPanel — 手机端好友/群/聊天（第81轮）。
 *
 * 入口：Pairing 智能体 Tab（tab==='identity'）账号卡下方（同 PC 结构）。
 * 聊天屏：全屏 overlay；气泡渲染复用 MessageBubble（纯渲染组件，消息模型适配
 * ChatMessage：self=无 author 右侧主题渐变，他人=author 左侧琥珀）+ phone-chat.css
 * （.myco-chat-view 作用域 + .chat-scroll 滚动容器）。
 * 任务卡气泡/系统条是聊天新形态，MessageBubble 无此变体——本文件内渲染（不推翻它）。
 * 存储/网络走 chat-store（youling.chat.* localStorage 键 + signedPost 设备钥签名）。
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { MessageBubble, avatarColorOf } from './MessageBubble'
import { openExternal } from '../explore'
import { QrCamera } from './QrCamera'
import { QrImage } from './QrImage'
import type { ChatMessage } from '../transport'
import {
  isOfficialConv,
  type ChatMsg, type ChatGroup, type PeerTask, type TaskParticipant,
  listFriends, listGroups, listTasks, loadConv, loadMediaB64, loadFileB64, markSeen,
  myAccountDid, chatPoll, chatSendText, chatSendImage, chatSendFile, chatSendGroup,
  addFriend, acceptFriend, ignoreFriend, removeFriend, createGroup, shareTask, acceptTask, setTaskStatus, renameTask,
  peerTaskView,
  // §3.23 任务卡进列表：可点开的分享卡坐标 / 我的权限人话 / 能不能转给第三人
  taskShareCardOf, taskPermLabel, taskCanReshare,
  taskExpired, getBoardTasks, ensureBackgroundPoll, renderOrderMsgs, fmtFileSize, assertFileSize,
  groupInvite, groupRename, groupLeave, groupKick, groupMute, retrySend, storeMedia,
  // 批四：草稿/偏好/撤回/引用/未读计数/时间分隔/长按菜单/会话删除
  getDraft, setDraft, convPref, setConvPinned, setConvMuted, deleteConv, deleteMsgLocal,
  unreadCount, sortConvRows, needTimeSep, fmtConvTime, msgMenuActions, chatRecall, convPreview, isMuted, mutedUntilOf,
  // 设备群（2026-10-07 设计 §3 决策F）：判定/计数/ensure/置顶种子
  isDeviceGroup as isDeviceGroupOf, ensureDeviceGroup, seedDeviceGroupPin, deviceGroupCountsOf, type RosterDevice,
  // 2026-10-18 渲染风暴治理：读库结果增量合并（纯函数）
  mergeConvView,
} from '../chat-store'
import { compressImage } from './ChatView'
import { setOpenConv } from '../chat-notify'
import { currentYoulingName, listPresence, fetchPresenceByRoot, ensureRootRoster, accountFormatLegacy, type PresenceNode } from '../identity'
// 2026-11-11 本机「ADB 调试」卡的打开路由（手机当 vnet server，见 adb-share.ts）
import { adbServerStart, ensureAdbCard, myDeviceDid } from '../adb-share'
// 2026-10-05 复制可靠性加固 + 粘贴非法 DID 实时提示
import { isValidDid, copyDidVerified, copyDidToastText } from '../didCheck'
import { onP2pSyncProgress, onSendStateChange, sendTyping, clearTyping, ensureP2pLoops, syncNowThrottled, syncNowForConv, syncNowForConvThrottled } from '../p2p'
import { TaskLinkCard, extractTaskLink } from './TaskLinkCard'
// 2026-10-23 任务卡 env（AOP 入口收敛）：卡上声明的 env 逐行渲染（rdp/dsh/ssh/…）；
// 设备/好友卡不再挂直连入口（R28）。
import { TaskEnvList } from './TaskEnvList'
// 列表行的「打开」路由：有 env → 固定口直开（RDP 复制地址 / DSH 浏览器）；
// 没有 env → 原分享入口（openTaskShare）。见 ../task-open 的头注释。
import { declaredEnvsOfCard, envGateOf, openNoteTone, openTaskEnv, primaryEnvOf } from '../task-open'
import { stateText, type EnvRowState } from '../task-env'
import { canSubmitTaskForm, taskShareSubmitArgs, type TaskShareCard } from './taskShareForm'
import { ConnBadge } from './conn-badge'
import { SharePermSheet } from './SharePermSheet'
import type { ShareAdminCard } from '../share-admin'

const tail4 = (s: string) => `…${(s || '').slice(-4)}`

/* ═══ 2026-09-29 did→显示名（与 PC ChatBubble.tsx 同构——两端一致惯例）：
 *  任何位置不显示全称 did（58 字符没人看）。 ═══ */

/** 护栏：名称字段若本身是全称 did（服务器/对端可能塞进来），压成 …尾4。 */
export function shortDid(name: string): string {
  const t = (name || '').trim()
  return t.startsWith('did:') ? `…${t.slice(-4)}` : t
}

/** did/convId → 显示名，优先级：好友昵称 > 名称字段（会话 title/群名兜底）> …尾4。
 *  convId 兼容 did_safe 的下划线形式（:_ → 什么形式都能命中好友表）；
 *  2026-10-07：did 匹配走**公钥级同判定**（好友表 did 与会话 id 形态可不同）。
 *  名称本身是全称 did（对端脏数据）=「无昵称」，跳过取下一级——绝不显示全称。 */
export function dispNameOf(didOrConvId: string, friends: { did: string; name?: string }[], fallbackName?: string): string {
  const norm = (didOrConvId || '').trim().replace(/_/g, ':')
  const hit = friends.find((f) => accountDidEq((f.did || '').trim(), norm))
  const isName = (s: string | undefined) => { const t = (s || '').trim(); return t && !t.startsWith('did:') ? t : '' }
  return isName(hit?.name) || isName(fallbackName) || `…${norm.slice(-4)}`
}

// ═══ 第84轮：在线状态灯（三态：绿/呼吸绿/烛光橘——与 PC FriendsZone 同款动画） ═══

/** 烛光关键帧刻意不规则（非均匀正弦）——"像在睡眠，又在不安心的等待，
 *  又愿为你始终点亮这盏等待的灯火"（用户诗意需求）。样式一次注入。 */
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

/** 好友在线状态（presence 聚合：任一设备在线即 online；state 取最新交互设备）。
 *  映射纯函数在 ../presence（单测覆盖，与 PC apps/home/ui/src/presence.ts 同构）。 */
export type { FriendPresence } from '../presence'
import { presenceDotClass, presenceDotTitle, makeThrottle, firstTypingMember, presenceOf, type FriendPresence } from '../presence'
import { accountDidEq, convKey } from '../didUtil'
// 2026-10-09「点卡就进」：分享任务卡（带 shareId+sourceDevice）走隧道直接在手机上打开，
// 而不是落到本机任务详情页（本机没有那张分享的注册表）。
// 2026-10-09 第二程：设备群广播的卡**嵌在 payload.card**——UI 一律先摊平
// （`flattenTaskSharePayload`），否则卡上没标题、也没有「打开」入口。
import { prefetchTaskEntry, isShareCard, openTaskShare, ensureRdpForwardFor } from '../dsh-open-runtime'
import { flattenTaskSharePayload, taskDispTitle } from '../chat-store'

/** 三态灯。 */
function PresenceDot({ p, size = 8 }: { p?: FriendPresence; size?: number }) {
  ensureDotStyle()
  return <span className={`myco-dot ${presenceDotClass(p)}`} style={{ width: size, height: size }} title={presenceDotTitle(p)} />
}

/** presence 列表 → 好友账号粒度聚合（PC 设备优先：灯看的是"人"）。 */
function aggregatePresence(nodes: PresenceNode[]): Record<string, FriendPresence> {
  const rank = (s: string | null | undefined) => (s === 'typing' ? 3 : s === 'active' ? 2 : s === 'idle' ? 1 : s === 'locked' ? 0 : 0)
  const byAcc: Record<string, FriendPresence> = {}
  for (const n of nodes) {
    if (!n.rootDid || n.kind !== 'pc') continue // 手机设备无直连面，聚合只看 PC（发起方模型）
    const cur = byAcc[n.rootDid]
    if (!cur || rank(n.state) >= rank(cur.state)) {
      byAcc[n.rootDid] = { online: true, state: n.state ?? 'active', deviceName: n.name }
    }
  }
  return byAcc
}

/** 第83轮：参与方头像圈（首字圆形并排，最多 4 个 +N）——卡/详情/任务行共用。
 * owner=主题蓝、member=琥珀、已完成=绿（与 PC ChatBubble 同款视觉）。 */
function ParticipantsAvatars({ participants, size = 16 }: { participants?: TaskParticipant[]; size?: number }) {
  const ps = (participants ?? []).filter((p) => p.did)
  if (!ps.length) return null
  const shown = ps.slice(0, 4)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
      title={ps.map((p) => `${p.name || `…${p.did.slice(-6)}`}（${p.role === 'owner' ? '发起' : '一起做'}${p.status === 'done' ? ' · 已完成' : ''}）`).join('、')}>
      {shown.map((p, i) => (
        <span key={p.did} style={{
          width: size, height: size, borderRadius: '50%',
          background: p.role === 'owner' ? 'linear-gradient(135deg,#6b7bff,#5567f5)'
            : p.status === 'done' ? 'linear-gradient(135deg,#34d399,#10b981)'
            : 'linear-gradient(135deg,#fbbf24,#f59e0b)',
          color: '#fff', fontSize: Math.round(size * 0.55), fontWeight: 700,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          marginLeft: i === 0 ? 0 : -Math.round(size * 0.3), border: '1.5px solid #fff', flexShrink: 0,
        }}>{(p.name || '灵').slice(0, 1)}</span>
      ))}
      {ps.length > 4 && <span style={{ fontSize: Math.round(size * 0.62), color: 'var(--muted)', marginLeft: 4, fontWeight: 700 }}>+{ps.length - 4}</span>}
    </span>
  )
}

/** ChatMsg → MessageBubble 的 ChatMessage（图片附件 media 键 → dataURL）。 */
export function toBubbleMsg(m: ChatMsg, prev: ChatMsg | null): ChatMessage | null {
  if (m.kind === 'task-share' || m.kind === 'task-accept' || m.kind === 'task-done' || m.kind === 'sys') return null // 特殊形态，外层自渲染
  if (m.kind === 'file') return null // 第94轮：文件卡，外层 FileCard 渲染
  const ts = new Date(m.ts).toISOString()
  // 批五：署名昵称走 dispNameOf 全优先级（好友昵称 > fromName > …尾4）——此前
  // shortDid(fromName)||tail4(from)，fromName 缺失/脏 did 时署名塌缩成「…尾4」
  // （用户实测「气泡上的昵称没显示全」主因之一）。
  // 设备群（2026-10-07 决策 D.3，对等 PC bubbleSenderName）：from==本账号恒真，
  // 署名优先 fromDeviceName（哪台设备说的）；本机设备消息 dir=out → author 留空=「我」。
  const authorOf = () => {
    if (m.fromDevice) return shortDid(m.fromDeviceName || '') || `…${(m.fromDevice || '').slice(-4)}`
    return dispNameOf(m.from, listFriends(), shortDid(m.fromName || ''))
  }
  if (m.kind === 'image') {
    const p = m.payload as { mediaId?: string; mime?: string; name?: string }
    const b64 = p.mediaId ? loadMediaB64(p.mediaId) : null
    const url = b64 ? `data:${p.mime || 'image/png'};base64,${b64}` : ''
    const base: ChatMessage = { role: 'user', text: '', timestamp: ts, attachments: [{ kind: 'image', mime: p.mime || 'image/png', ref: url, name: p.name }] }
    if (m.dir === 'in') base.author = authorOf()
    return base
  }
  const text = String((m.payload as { text?: string }).text || '')
  const base: ChatMessage = { role: 'user', text, timestamp: ts }
  if (m.dir === 'in') base.author = authorOf()
  // self：author 留空（undefined）——批四修：曾显式 author=''，空串非 nullish，
  // MessageBubble 的 ?? 回落接不住，每条自己消息挂空"👤"胶囊；现由 resolveAuthorName 统一回落。
  void prev
  return base
}

/* ═══════════ 第94轮：文件卡气泡（文件名+大小+类型图标；点击=系统默认程序打开） ═══════════ */

/** 文件类型图标（常见类型彩色徽章，其余通用 📎）——与 PC ChatBubble.fileIconOf 同款。 */
function fileIconOf(name?: string, mime?: string): { emoji: string; bg: string } {
  const ext = (name || '').split('.').pop()?.toLowerCase() || ''
  if ((mime || '').startsWith('image/')) return { emoji: '🖼', bg: 'rgba(107,123,255,.16)' }
  if (ext === 'pdf' || mime === 'application/pdf') return { emoji: '📕', bg: 'rgba(239,68,68,.14)' }
  if (['doc', 'docx'].includes(ext)) return { emoji: '📘', bg: 'rgba(37,99,235,.14)' }
  if (['xls', 'xlsx', 'csv'].includes(ext)) return { emoji: '📗', bg: 'rgba(22,163,74,.14)' }
  if (['ppt', 'pptx'].includes(ext)) return { emoji: '📙', bg: 'rgba(249,115,22,.14)' }
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return { emoji: '🗜', bg: 'rgba(148,163,184,.2)' }
  if (['mp3', 'wav', 'flac', 'm4a'].includes(ext)) return { emoji: '🎵', bg: 'rgba(168,85,247,.14)' }
  if (['mp4', 'mov', 'mkv', 'avi'].includes(ext)) return { emoji: '🎬', bg: 'rgba(236,72,153,.14)' }
  if (['txt', 'md', 'log'].includes(ext) || (mime || '').startsWith('text/')) return { emoji: '📄', bg: 'rgba(100,116,139,.16)' }
  return { emoji: '📎', bg: 'rgba(100,116,139,.16)' }
}

function FileCard({ m, mine, onOpen }: { m: ChatMsg; mine: boolean; onOpen: (m: ChatMsg) => void }) {
  const p = m.payload as { name?: string; mime?: string; size?: number }
  const size = fmtFileSize(p.size)
  const ic = fileIconOf(p.name, p.mime)
  return (
    <div onClick={() => onOpen(m)}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, minWidth: 172, maxWidth: 232,
        padding: '8px 10px', borderRadius: 12, cursor: 'pointer',
        marginLeft: mine ? 'auto' : 0, marginRight: mine ? 0 : 'auto',
        // 批四：硬编码蓝紫改走 chat theme 变量（--mc-accent 系，随聊天气泡主题联动）
        background: mine ? 'linear-gradient(135deg,var(--mc-accent,#6b7bff),var(--mc-accent-2,#5567f5))' : 'var(--card,#fff)',
        border: mine ? 'none' : '1px solid var(--border,#e2e5ee)',
        borderLeft: mine ? undefined : '3px solid #d97706',
        boxShadow: mine ? '0 4px 14px color-mix(in srgb, var(--mc-accent,#6b7bff) 28%, transparent)' : '0 2px 10px rgba(22,30,60,.05)',
      }}
      title="点击用系统默认程序打开">
      <span style={{
        width: 36, height: 36, borderRadius: 10, flexShrink: 0, fontSize: 18,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: ic.bg,
      }}>{ic.emoji}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{
          display: 'block', fontSize: 13, fontWeight: 700, lineHeight: 1.35,
          color: mine ? '#fff' : 'var(--text,#1c2333)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{p.name || '文件'}</span>
        <span style={{
          display: 'block', fontSize: 10.5, marginTop: 1,
          color: mine ? 'rgba(255,255,255,.72)' : 'var(--muted)',
        }}>{size || '文件'} · 点击打开</span>
      </span>
    </div>
  )
}

/* ═════════ 任务卡气泡（精美卡片：左渐变竖条+标题粗体+参与方头像+底部操作条；过期置灰） ═════════ */
function TaskCard({ m, onOpen }: { m: ChatMsg; onOpen?: () => void }) {
  // 设备群广播的卡嵌在 payload.card → **渲染前摊平**（字段与桌面端对齐；平铺形态原样）
  const p = flattenTaskSharePayload(m.payload as Record<string, unknown>) as {
    title?: string; desc?: string; fromName?: string; reward?: string; expiresAt?: number
    participants?: TaskParticipant[]; sourceDeviceName?: string
  }
  const expired = !!p.expiresAt && p.expiresAt < Date.now()
  const mine = m.dir === 'out'
  // 跨设备同步来的**分享卡**：点开 = 经隧道直达源设备那一页（不是本机任务详情）
  const share = isShareCard(flattenTaskSharePayload(m.payload as Record<string, unknown>))
  const fromLabel = shortDid(p.sourceDeviceName || '') || shortDid(p.fromName || '') || '好友'
  return (
    <div onClick={() => onOpen?.()} style={{
      width: 238, borderRadius: 12, overflow: 'hidden', cursor: 'pointer',
      // 批四：硬编码蓝紫改走 chat theme 变量（--mc-accent 系）
      background: expired ? '#f1f3f8' : 'linear-gradient(160deg, color-mix(in srgb, var(--mc-accent,#6b7bff) 4%, #fff), color-mix(in srgb, var(--mc-accent,#6b7bff) 9%, #fff))',
      border: `1px solid ${expired ? '#d5d9e2' : 'color-mix(in srgb, var(--mc-accent,#6b7bff) 28%, #e2e5ee)'}`,
      boxShadow: expired ? 'none' : '0 4px 14px color-mix(in srgb, var(--mc-accent,#6b7bff) 16%, transparent)',
      opacity: expired ? 0.62 : 1, filter: expired ? 'grayscale(.7)' : 'none',
      marginLeft: mine ? 'auto' : 0, marginRight: mine ? 0 : 'auto',
    }}>
      <div style={{ height: 4, background: expired ? '#9aa3b8' : 'linear-gradient(90deg,var(--mc-accent,#6b7bff),#4ec9a5)' }} />
      <div style={{ padding: '9px 11px 10px' }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 3, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 6px', borderRadius: 6, background: expired ? '#eceff4' : 'color-mix(in srgb, var(--mc-accent,#6b7bff) 14%, transparent)', color: expired ? '#8a93a8' : 'var(--mc-accent,#4338ca)' }}>📋 任务卡</span>
          {/* 分享卡标记：让"这张卡点开是别人的实时页面"一眼可见（不是本地任务） */}
          {share && !expired && <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 6px', borderRadius: 6, background: 'rgba(78,201,165,.18)', color: '#0f766e' }}>🔗 分享</span>}
          {p.reward && !expired && <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 6px', borderRadius: 6, background: 'rgba(245,158,11,.14)', color: '#b45309' }}>奖励 {p.reward}</span>}
          {expired && <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 6px', borderRadius: 6, background: '#eceff4', color: '#8a93a8' }}>已过期</span>}
        </div>
        {/* 2026-10-11 标题走 taskDispTitle：DSH 分享卡标题被调试通道灌成 mojibake
            （"??"-DSH????"）时兜回「分享·尾4」——生产链路全程 UTF-8 不产此形态。 */}
        <div style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--text,#1c2333)', lineHeight: 1.4 }}>{taskDispTitle(p)}</div>
        {p.desc && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.desc}</div>}
        {/* 第83轮：参与方头像圈 + 来自（多人协作可见） */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7, minWidth: 0 }}>
          <ParticipantsAvatars participants={p.participants} size={14} />
          <span style={{ fontSize: 10.5, color: '#8a93a8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {mine ? '我分享的' : `来自 ${fromLabel}`}{p.participants && p.participants.length > 1 ? ` · ${p.participants.length} 人一起` : ''}
          </span>
        </div>
      </div>
      {/* 第83轮：底部操作条——"不知道能点"的显式暗示（整卡可点，这里给出主行动词） */}
      <div style={{
        padding: '6px 11px',
        background: expired ? '#eceff4' : 'linear-gradient(90deg, color-mix(in srgb, var(--mc-accent,#6b7bff) 13%, transparent), rgba(78,201,165,.15))',
        borderTop: `1px solid ${expired ? '#d5d9e2' : 'color-mix(in srgb, var(--mc-accent,#6b7bff) 22%, transparent)'}`,
        textAlign: 'center', fontSize: 11.5, fontWeight: 800, letterSpacing: 0.2,
        color: expired ? '#8a93a8' : 'var(--mc-accent,#4338ca)',
      }}>
        {/* 分享卡的主行动词是「打开」——点开即经隧道进源设备那一页 */}
        {expired ? '已失效' : share ? '▶ 打开（直达对方设备）' : mine ? '查看分享详情 ›' : '🤝 一起做 · 点开查看 ›'}
      </div>
    </div>
  )
}

/* ════════ 2026-10-18 聊天微信化（M11 噪声治理）═══
 * 聊天流只允许「人对人内容 + 极简状态符号」，不呈现任何投递/系统过程文字。
 *  - 气泡状态只有三种符号：⏳（本机已收待确认）/ ✓（已投递）/ !（失败可点重发）；
 *    过程说明只放 title（悬停/长按看），不落在界面上。
 *  - sys 系统条走白名单：微信也有的（好友关系/入群/退群/被移出/解散/群创建/撤回/设备群）
 *    才进聊天流；myco 机制留痕（payload.system=true，如 cap_denied 安全审计）与未知
 *    系统事件属于非人类内容，一律不渲染。 */
const WECHAT_SYS_RE = /(已成为好友|加入了群聊|被拉进了群聊|退出了群聊|被移出群|移出了群聊|被群主解散|已被解散|解散了群聊|已创建|撤回了一条消息|设备群已开启)/
/** sys 行是否属于"微信也有的系统提示"（true=可进聊天流）。非 sys 行不受此过滤。 */
export function isHumanSystemLine(m: ChatMsg): boolean {
  if (m.kind !== 'sys') return true
  const p = m.payload as { system?: unknown; text?: unknown }
  if (p.system === true) return false // myco 可信机制留痕（非人的发言）
  const text = typeof p.text === 'string' ? p.text.trim() : ''
  if (!text) return false
  return WECHAT_SYS_RE.test(text)
}

/* ═════════ 第95轮：发送状态符号（M11 极简版；文案只在 title 里） ═════════
 * ⏳ 本机已收，待确认 / ✓ 已投递 / ! 失败（点一下重发）。
 * 仅自己的新消息（sendState 有值）显示；老消息无字段不显示。 */
function SendStateBadge({ m, onRetry }: { m: ChatMsg; onRetry: (m: ChatMsg) => void }) {
  if (m.dir !== 'out' || !m.sendState) return null
  if (m.sendState === 'sending') {
    return (
      <div title="已在本机收下，对方上线后自动送达" style={{ margin: '1px 4px 0', fontSize: 10, lineHeight: 1, color: 'var(--muted,#8a93a8)', textAlign: 'right' }}>
        ⏳
      </div>
    )
  }
  if (m.sendState === 'sent') {
    return <div title="已送达对方设备" style={{ margin: '1px 4px 0', fontSize: 10, lineHeight: 1, color: 'var(--muted,#8a93a8)', textAlign: 'right' }}>✓</div>
  }
  return (
    <div onClick={() => onRetry(m)} title="没发出去——点一下重发"
      style={{ margin: '1px 4px 0', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', cursor: 'pointer' }}>
      <span style={{ width: 14, height: 14, borderRadius: '50%', background: '#e5534b', color: '#fff', fontSize: 10, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>!</span>
    </div>
  )
}

/* ═════════ 2026-10-18：聊天屏读库→渲染的增量应用（渲染风暴治理） ═════════
 * 背景（chat-metrics A 轮）：对账重放/连续入库时，订阅通知逐条触发
 * `setMsgs(loadConv(convId))` —— 每条都全量 JSON 解析 + 全列表重渲；批量 20 条消息
 * 到达时端到端上屏被放大到 P50 4.6s / P95 8.4s（用户观感"聊天卡"）。
 * 修法：① 60ms 合帧（一批通知只读一次库）；② `mergeConvView` 差异应用（纯函数在
 * chat-store，单测覆盖）——无变化返回原引用不重渲，纯尾部追加只 append。 */

/** 合帧触发器：窗口期内的多次调用只执行一次（尾部执行）。 */
/** 小灵官方通知卡（2026-10-20）：普通通知卡；陈词邀请（category=appeal.statement.invite /
 *  meta.phase=statement）渲染为「有灵任务」卡：标题/正文/案件题目/截止倒计时/主按钮/复制链接。 */
function OfficialNoticeCard({ m }: { m: ChatMsg }) {
  const [copied, setCopied] = useState(false)
  const p = m.payload as {
    title?: string; body?: string; category?: string
    action?: { label?: string; url?: string }
    meta?: { caseId?: string; taskId?: string; itemId?: string; deadlineAt?: number; phase?: string }
  }
  const url = String(p.action?.url || '')
  const label = String(p.action?.label || '打开')
  const meta = p.meta || {}
  const isTask = p.category === 'appeal.statement.invite' || meta.phase === 'statement'
  const copy = () => {
    if (!url) return
    try {
      const ta = document.createElement('textarea')
      ta.value = url
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch { /* 忽略 */ }
  }
  let deadlineText = ''
  if (isTask && meta.deadlineAt) {
    const left = Number(meta.deadlineAt) - Date.now()
    deadlineText = left > 0 ? `剩余 ${Math.floor(left / 3600000)}h ${Math.floor((left % 3600000) / 60000)}m` : '已到期'
  }
  if (isTask) {
    return (
      <div data-official-notice data-official-variant="task" style={{ maxWidth: 300, borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(22,119,255,.25)', background: 'linear-gradient(180deg,#fff,#f2f7ff)', boxShadow: '0 6px 18px rgba(22,119,255,.12)' }}>
        <div style={{ padding: '8px 12px', background: 'linear-gradient(135deg,#1677ff,#0958d9)', color: '#fff', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 16, height: 16, borderRadius: 4, background: 'rgba(255,255,255,.22)', fontSize: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>灵</span>
          <span style={{ fontSize: 11, fontWeight: 800 }}>有灵任务 · 陈词邀请</span>
          {deadlineText ? <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 6, background: 'rgba(255,255,255,.2)' }}>⏳ {deadlineText}</span> : null}
        </div>
        <div style={{ padding: '10px 12px 2px' }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#0f1e33', lineHeight: 1.45, marginBottom: 5 }}>{p.title || '任务'}</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.65, color: '#33415c', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{p.body || ''}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '6px 0 0' }}>
            {meta.caseId ? <span style={{ fontSize: 10, color: '#1677ff', background: '#1677ff14', borderRadius: 6, padding: '2px 6px', fontWeight: 600 }}>案件 {String(meta.caseId)}</span> : null}
            {meta.taskId ? <span style={{ fontSize: 10, color: '#3a4560', background: 'rgba(100,116,139,.10)', borderRadius: 6, padding: '2px 6px' }}>题目 {String(meta.taskId)}</span> : null}
          </div>
        </div>
        <div style={{ padding: '8px 12px 12px' }}>
          {url ? <button onClick={() => openExternal(url)} style={{ border: 'none', borderRadius: 9, padding: '7px 14px', fontSize: 12.5, fontWeight: 800, color: '#fff', background: 'linear-gradient(135deg,#1677ff,#0958d9)' }}>{label} →</button> : null}
          {url ? <button onClick={copy} style={{ marginLeft: 8, border: '1px solid #cddcf5', background: '#fff', borderRadius: 9, padding: '6px 10px', fontSize: 11.5, fontWeight: 700, color: '#1677ff' }}>{copied ? '已复制 ✓' : '复制链接'}</button> : null}
          {url ? <div style={{ marginTop: 6, fontSize: 10, color: '#7c8aa5', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>🔗 {url}</div> : null}
          <div style={{ marginTop: 4, fontSize: 10.5, color: '#8a93a8' }}>陈词须在平台匿名评论区提交（小灵仅用于通知）</div>
        </div>
      </div>
    )
  }
  return (
    <div data-official-notice style={{ maxWidth: 300, border: '1px solid #dfe6ff', borderRadius: 14, overflow: 'hidden', background: 'linear-gradient(180deg,#fff,#f6f8ff)', boxShadow: '0 6px 18px rgba(80,100,255,.10)' }}>
      <div style={{ padding: '8px 12px', background: 'linear-gradient(135deg,#6b7bff,#5567f5)', color: '#fff', fontSize: 11, fontWeight: 800 }}>🔔 小灵 · 官方通知</div>
      <div style={{ padding: '10px 12px 2px' }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: '#1f2a44', lineHeight: 1.45, marginBottom: 5 }}>{p.title || '通知'}</div>
        <div style={{ fontSize: 12.5, lineHeight: 1.65, color: '#3a4560', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{p.body || ''}</div>
      </div>
      <div style={{ padding: '4px 12px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
        {url ? <button onClick={() => openExternal(url)} style={{ border: 'none', borderRadius: 9, padding: '6px 14px', fontSize: 12.5, fontWeight: 700, color: '#fff', background: 'linear-gradient(135deg,#6b7bff,#5567f5)' }}>{label} →</button> : null}
        <span style={{ fontSize: 10.5, color: '#8a93a8' }}>官方通知，仅在此查看</span>
      </div>
    </div>
  )
}

function makeCoalesced(fn: () => void, ms = 60): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  return () => {
    if (timer !== null) return
    timer = setTimeout(() => { timer = null; fn() }, ms)
  }
}

/* ═════════ 聊天屏 ═════════ */
function ChatScreen({ convId, title, isGroup, myName, onBack, onChanged, presence, myDid, onOpenGroupManage, devInfo }: {
  convId: string; title: string; isGroup: boolean; myName: string
  onBack: () => void; onChanged: () => void
  presence: Record<string, FriendPresence>
  myDid: string
  onOpenGroupManage: (g: ChatGroup) => void
  /** 设备群（2026-10-07 决策F）：名册设备计数（FriendsPanel 轮询 fetchPresenceByRoot）；
   *  undefined=非设备群或名册不可用（降级仅「📱 设备群」）。 */
  devInfo?: { total: number; online: number }
}) {
  // 批四：首帧空态闪烁根修——msgs 懒初始化直接同步读本地库，不再 useState([])
  // 先渲一帧"还没有消息"再 useEffect 灌入（每进一次聊天闪一次空文案的根因）。
  const [msgs, setMsgs] = useState<ChatMsg[]>(() => loadConv(convId))
  // 批四：草稿保留（chat-store 持久化，按 convId）——切会话/被杀回来草稿都在；
  // 发送成功清空。会话隔离靠 FriendsPanel 渲染处 key={chat.id} 重挂本组件。
  const [text, setText] = useState(() => getDraft(convId))
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [detail, setDetail] = useState<PeerTask | null>(null)
  // 「点卡就进」：正在打开/打开失败的一行提示（挂在那张卡下面，不遮挡会话）。
  // 2026-10-23：卡身不再走分享入口（无 env 老卡只展示——见下方 TaskCard 注释），
  // setter 随 openTask 一并退役；状态保留给后续 env 行接入复用。
  const [shareOpenNote] = useState<{ msgId: string; text: string } | null>(null)
  // 2026-09-29：分享成功即时反馈横幅（卡片气泡落屏之外的明确"成了"信号）
  const [sharedFlash, setSharedFlash] = useState(false)
  // 批四：屏内轻提示（复制成功/撤回失败等）
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = (t: string) => {
    setToast(t)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 1800)
  }
  // 批四：引用回复（payload replyTo=msgId + 快照摘要——被引消息被撤/清理后仍可显示）
  const [replyTo, setReplyTo] = useState<ChatMsg | null>(null)
  // 批四：长按消息 ActionSheet（复制/引用/撤回/删除本地——msgMenuActions 状态机）
  const [menuFor, setMenuFor] = useState<ChatMsg | null>(null)
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 批四：上翻阅读期间新消息 ↓N 浮标（column-reverse：贴底=scrollTop 0）
  const [newBelow, setNewBelow] = useState(0)
  const stickRef = useRef(true)
  const prevLenRef = useRef(msgs.length)
  // typing 信号节流（3s，设计定稿；2026-09-29 由 2s 改）
  const typingThrottleRef = useRef(makeThrottle(3000))
  const scrollRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 读库 → 增量应用（2026-10-18 渲染风暴治理，见文件内 mergeConvView 说明）。
  const load = useCallback(() => {
    const next = loadConv(convId)
    setMsgs((prev) => mergeConvView(prev, next))
    markSeen(convId)
  }, [convId])
  // 合帧版 load（订阅通知用）：60ms 内的多次入库/同步进度/轮询事件只读一次库。
  const loadRef = useRef(load)
  loadRef.current = load
  const loadSoonRef = useRef<(() => void) | null>(null)
  if (!loadSoonRef.current) loadSoonRef.current = makeCoalesced(() => loadRef.current(), 60)
  const loadSoon = loadSoonRef.current
  useEffect(() => { load() }, [load])
  // 批四：登记"正在聊的会话"——chat-notify 据此静默该会话的通知（微信语义）
  useEffect(() => {
    setOpenConv(convId)
    return () => setOpenConv(null)
  }, [convId])
  // 滚动（2026-09-29 Bug1 修，微信语义）：容器 .chat-scroll 是 column-reverse——
  // DOM 前插=视觉底部增长：贴底（scrollTop=0）时新消息天然跟随；用户上翻
  // （scrollTop<0）时视口锚定原内容、不被新消息/对账灌入的历史打扰。
  // 此前 msgs.map 正序渲染 + msgs.length 变化强拉 el.scrollTop=el.scrollHeight，
  // 在 column-reverse 里=最新顶到屏幕最上面 + 强拉打断上翻（双病症）。
  // 现渲染走 renderOrderMsgs（倒序），进屏/切会话贴底一次即可。
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = 0
    // 2026-10-11 UX：切会话不弹输入法——Android WebView 新页面自动聚焦
    // 第一个可输入元素导致键盘弹出，但用户先看记录不打算马上输入。
    // 主动 blur 打断自动聚焦（微信/Telegram 同款体验）。
    // 注：本页（myco 自己的聊天页）输入框没有 autoFocus，键盘只会因用户点输入框
    // 而出现；这里的一枪是防"从别的页面带焦点过来"。分享页（DSH）那边的自动聚焦
    // 是同名问题的主战场，由原生 ShareFocusGuard 治理。
    if (textareaRef.current) textareaRef.current.blur()
    // 需要延迟一帧——WebView 的自动聚焦在 paint 后才生效
    requestAnimationFrame(() => textareaRef.current?.blur())
  }, [convId])
  // 批四：草稿恢复时输入框同步增高（多行草稿不会只露一行）
  useEffect(() => {
    const el = textareaRef.current
    if (el && el.value) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 96) + 'px' }
  }, [])
  // 批四：Android 返回键接管聊天 overlay——打开时 pushState 占位，系统返回键
  // 触发 popstate → 关 overlay 回会话列表（而非退 app）。壳侧 onBackPressed
  // 已是 canGoBack→goBack 语义，天然对齐；PWA 浏览器返回键同理。
  const onBackRef = useRef(onBack)
  onBackRef.current = onBack
  const pushedRef = useRef(false)
  useEffect(() => {
    try { history.pushState({ mycoConv: convId }, ''); pushedRef.current = true } catch { /* file:// 老壳容错 */ }
    const onPop = () => { pushedRef.current = false; onBackRef.current() }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [convId])
  /** 头部 ‹ 返回：已占位走 history.back()（popstate 统一收口）；未占位直接 onBack。 */
  const goBack = () => { if (pushedRef.current) history.back(); else onBack() }
  // 批四：上翻状态跟踪 + 新消息 ↓N 计数（贴底时 column-reverse 天然跟随，无需滚动）
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const stick = -el.scrollTop <= 40
    stickRef.current = stick
    if (stick && newBelow > 0) setNewBelow(0)
  }
  useEffect(() => {
    const grew = msgs.length - prevLenRef.current
    prevLenRef.current = msgs.length
    if (grew <= 0) return
    if (stickRef.current) setNewBelow(0)
    else setNewBelow((n) => n + grew)
  }, [msgs.length])
  const jumpBottom = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = 0
    stickRef.current = true
    setNewBelow(0)
  }
  // 聊天中 5s 轮询（chat-store 拉信箱入本地）+ P2P 对账进度/入库通知订阅。
  // 2026-10-18 渲染风暴治理：订阅回调统一走 **60ms 合帧 + 增量应用**（loadSoon）——
  // 对账重放/连续 20 条入库时不再逐条全量重读重渲（此前是卡顿主因）；用户主动
  // 操作（发送/重发/撤回）仍走即时 load()。
  useEffect(() => {
    let tick = 0
    const t = setInterval(() => {
      void chatPoll().then(() => loadSoon()).catch(() => {})
      // 2026-10-09（P0-2）：会话页停留期每 10s 轻量对账一次——此前停着不动只能等
      // 60s 兜底环（p2p.ts 的 ensureP2pLoops），用户实测"群消息同步很慢"。
      if (++tick % 2 === 0) syncNowForConvThrottled(convId, isGroup, myDid)
    }, 5000)
    // 进屏触发与对方的 P2P 对账（"活的历史"）；进度只用于增量补拉，不呈现过程文字
    // 2026-10-09（P0-1）：群 → 全部成员 + 自己账号（此前 isGroup 时只传 myDid，漏群成员）
    // 2026-10-18 M11：删掉"正在与 X 同步历史…（已收 N 条）"横幅——过程不呈现给用户。
    void syncNowForConv(convId, isGroup, myDid).catch(() => {})
    const stop = onP2pSyncProgress((p) => { if (p.got > 0) loadSoon() })
    const stopSendState = onSendStateChange(loadSoon)
    return () => { clearInterval(t); stop(); stopSendState() }
  }, [loadSoon, convId, isGroup, myDid])

  // 第85轮：群禁言状态（自己被禁言中 → 输入区置灰）
  const group = isGroup ? listGroups().find((g) => g.id === convId) : undefined
  const mutedUntil = group ? mutedUntilOf(group, myDid) : 0
  const amMuted = mutedUntil > Date.now()
  // 批二：终态群（已解散/已被移出）——会话只读（历史可回查），输入区禁用
  const groupTerminal = group?.status === 'disbanded' || group?.status === 'kicked'
  // 设备群（决策F）：档案 kind / grp-dev- 前缀双判定（档案未同步时前缀兜底）
  const devGroup = isGroup && isDeviceGroupOf(group ?? { id: convId })
  // 2026-10-20 小灵官方通知会话：只读（陈词/处理走卡片 action 到平台，不做第二通道）
  const officialConv = isOfficialConv(convId)
  const inputLocked = amMuted || groupTerminal || officialConv
  const lockPlaceholder = groupTerminal
    ? (group?.status === 'disbanded' ? '群已被群主解散，仅可查看历史' : '你已被移出该群，仅可查看历史')
    : officialConv ? '小灵只发送官方通知，不可回复——请点通知卡按钮去平台处理'
    : amMuted ? `已被群主禁言至 ${new Date(mutedUntil).toLocaleTimeString()}` : ''
  // 2026-10-07：账号 did 公钥级还原（归一键）——convId 可能是 did_safe 下划线形态，
  // 且与 presence/名册形态可能是同一把钥匙的不同历史形态。
  const peerAccDid = convKey(convId)
  const peerP = presenceOf(presence, peerAccDid)

  /** typing 瞬时信号（节流 3s，P2P 直发不落盘；群=grp-id 由 p2p 侧逐成员扇出——
   *  原发 myDid 只到自己设备，群成员根本收不到，2026-09-29 修）。 */
  const sendTypingSignal = () => {
    if (!typingThrottleRef.current(Date.now())) return
    void sendTyping(convId, isGroup ? convId : peerAccDid).catch(() => {})
  }

  // 第95轮：乐观上屏——发送请求未返回前先把消息插到本地视图（⏳ 发送中）。
  // 对账进行中也不阻塞打字；发送完成后 load() 全量重读（chat-store 已按 ts
  // 排序合并——乐观条消失、权威行带上，位置不跳变）。失败时移除乐观条并提示。
  const pushOptimistic = (payload: Record<string, unknown>, kind = 'text', tmpId?: string): string => {
    const id = tmpId ?? `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const m: ChatMsg = { msgId: id, from: myDid, to: convId, kind, payload, ts: Date.now(), dir: 'out', sendState: 'sending' }
    setMsgs((prev) => [...prev, m])
    return id
  }
  const dropOptimistic = (tmpId: string) => setMsgs((prev) => prev.filter((m) => m.msgId !== tmpId))

  /** 第95轮：失败消息点按重发（retrySend：在队=立即补发 / 溢出=重建信封再试）。 */
  const onRetryMsg = (m: ChatMsg) => {
    setMsgs((prev) => prev.map((x) => (x.msgId === m.msgId ? { ...x, sendState: 'sending' as const } : x)))
    void retrySend(convId, m.msgId).then(load).catch((e) => { setErr(String(e).replace(/^Error:\s*/, '')); load() })
  }

  /** 批四：输入框文本更新统一口（草稿随写随存——杀进程/切会话都丢不了）。 */
  const updateText = (v: string) => { setText(v); setDraft(convId, v) }

  /** 批四：长按菜单动作执行（ActionSheet 点选；状态机 msgMenuActions 在 chat-store）。 */
  const runMenuAction = (act: string, m: ChatMsg) => {
    setMenuFor(null)
    if (act === 'copy') {
      const t = String((m.payload as { text?: string }).text || '')
      if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(t).then(() => showToast('已复制')).catch(() => showToast('复制失败'))
      else showToast('复制不可用')
    } else if (act === 'reply') {
      setReplyTo(m)
      textareaRef.current?.focus()
    } else if (act === 'recall') {
      void chatRecall(convId, m.msgId).then(() => { load(); onChanged() }).catch((e) => showToast(String(e).replace(/^Error:\s*/, '')))
    } else if (act === 'delete') {
      deleteMsgLocal(convId, m.msgId)
      load()
    }
  }
  /** 批四：长按手势（500ms 触发；移动/抬起/取消都作废）。右键（PC 浏览器预览）同菜单。 */
  const lpStart = (m: ChatMsg) => () => {
    if (lpTimer.current) clearTimeout(lpTimer.current)
    lpTimer.current = setTimeout(() => { setMenuFor(m); lpTimer.current = null }, 500)
  }
  const lpCancel = () => { if (lpTimer.current) { clearTimeout(lpTimer.current); lpTimer.current = null } }

  const send = async () => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true); setErr(null)
    const rt = replyTo
    const tmpId = pushOptimistic({ text: t, ...(rt ? { replyTo: rt.msgId, replySnippet: convPreview(rt).slice(0, 60), replyFromName: rt.dir === 'out' ? '' : (rt.fromName || '') } : {}) })
    try {
      if (isGroup) await chatSendGroup(convId, { text: t }, { replyTo: rt })
      else await chatSendText(convId, t, { replyTo: rt })
      clearTyping() // 发送即回退 active（2026-09-29 灯恢复）
      setReplyTo(null)
      updateText('') // 草稿同清（批四：发送成功草稿不残留）
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      load(); onChanged()
    } catch (e) { dropOptimistic(tmpId); setErr(String(e).replace(/^Error:\s*/, '')) } finally { setBusy(false) }
  }
  const sendImg = async (f: File) => {
    // 2026-09-29 Bug2 配套：>2MB 自动压缩（1600px JPEG q0.85）——拍照/截图普遍
    // 超 2MB，此前直接拒发（"图片超过 2MB"），手机上"传照片"形同虚设。
    let blob: Blob = f
    try { if (f.size > 2 * 1024 * 1024) blob = await compressImage(f) } catch { /* 压缩失败走原文件校验 */ }
    if (blob.size > 2 * 1024 * 1024) { setErr('图片超过 2MB'); return }
    const rd = new FileReader()
    rd.onload = async () => {
      const b64 = String(rd.result || '').split(',')[1] || ''
      setBusy(true); setErr(null)
      const jpeg = blob !== f
      const name = jpeg ? `${f.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg` : f.name
      const mime = jpeg ? 'image/jpeg' : (f.type || 'image/png')
      // 第95轮：乐观预览——b64 先挂临时媒体键（气泡即时可见；FIFO 迟早淘汰无害）
      const tmpId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      storeMedia(tmpId, b64)
      pushOptimistic({ name, mime, mediaId: tmpId }, 'image', tmpId)
      try {
        if (isGroup) await chatSendGroup(convId, { name, mime, b64 })
        else await chatSendImage(convId, name, mime, b64)
        load(); onChanged()
      } catch (e) { dropOptimistic(tmpId); setErr(String(e).replace(/^Error:\s*/, '')) } finally { setBusy(false) }
    }
    rd.readAsDataURL(blob)
  }

  /** 第94轮：任意文件（非图片）——10MB 上限，kind=file 文件卡；点击系统打开。 */
  const sendAnyFile = (f: File) => {
    if (f.type.startsWith('image/')) { void sendImg(f); return }
    try { assertFileSize(f.size) } catch (e) { setErr(String((e as Error).message)); return }
    const rd = new FileReader()
    rd.onload = async () => {
      const b64 = String(rd.result || '').split(',')[1] || ''
      setBusy(true); setErr(null)
      const name = f.name || 'file'
      const mime = f.type || 'application/octet-stream'
      const tmpId = pushOptimistic({ name, mime, size: f.size, mediaId: '' }, 'file')
      try {
        if (isGroup) await chatSendGroup(convId, { name, mime, size: f.size, b64 })
        else await chatSendFile(convId, name, mime, f.size, b64)
        load(); onChanged()
      } catch (e) { dropOptimistic(tmpId); setErr(String(e).replace(/^Error:\s*/, '')) } finally { setBusy(false) }
    }
    rd.readAsDataURL(f)
  }

  /** 第94轮：文件卡点击——取字节 → APK 壳 MycoShell.openFile（系统关联程序）；
   *  浏览器 PWA 无桥时降级 <a download> 下载。 */
  const openChatFile = async (m: ChatMsg) => {
    const p = m.payload as { mediaId?: string; name?: string; mime?: string }
    const mediaId = p.mediaId || ''
    if (!mediaId) { setErr('文件数据已被清理（对方重发可恢复）'); return }
    setBusy(true)
    try {
      const b64 = await loadFileB64(mediaId)
      if (!b64) { setErr('文件数据已被清理（对方重发可恢复）'); return }
      const shell = (window as unknown as { MycoShell?: { openFile?: (b64: string, name: string, mime: string) => string } }).MycoShell
      if (shell?.openFile) {
        const r = shell.openFile(b64, p.name || 'file', p.mime || 'application/octet-stream')
        if (typeof r === 'string' && r.startsWith('ERR:')) setErr(r.slice(4))
      } else {
        // PWA（浏览器）：降级为下载
        const a = document.createElement('a')
        a.href = `data:${p.mime || 'application/octet-stream'};base64,${b64}`
        a.download = p.name || 'file'
        a.click()
      }
    } finally { setBusy(false) }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'var(--bg,#f6f7fa)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', paddingTop: 'calc(12px + env(safe-area-inset-top, 0px))', background: 'var(--card,#fff)', borderBottom: '1px solid var(--border,#e2e5ee)' }}>
        <button onClick={goBack} style={{ background: 'none', border: 'none', fontSize: 15, color: 'var(--accent,#6b7bff)', cursor: 'pointer', padding: '2px 6px' }}>‹</button>
        {/* 第84轮：三态灯（typing=呼吸绿；idle/locked=烛光橘）。2026-09-29：群也亮灯
            ——任一成员 typing（presence 轮询态）=呼吸绿 + "X 正在输入…"。 */}
        {(() => {
          const groupTyper = isGroup && group ? firstTypingMember(group.members, presence, myDid) : null
          const typerName = groupTyper ? dispNameOf(groupTyper, listFriends()) : null
          const showTyping = !!groupTyper || (!isGroup && peerP?.state === 'typing')
          const dot: FriendPresence | undefined = showTyping
            ? { online: true, state: 'typing', deviceName: '' }
            : isGroup ? undefined : peerP
          return (
            <>
              {(dot || !isGroup) && <PresenceDot p={dot} size={9} />}
              <div style={{ minWidth: 0, flex: 1 }}>
                {/* 批五（2026-09-29 用户实测「顶部昵称没显示全」）：单行 ellipsis 最多露
                    ~8 字 → 放宽为两行 clamp（超两行才尾部省略），title 兜底全名。
                    设备群（决策F）：📱 徽标（普通群 👥 不变）。 */}
                <div title={title} style={{
                  fontSize: 15, fontWeight: 700, color: 'var(--text)', lineHeight: 1.25,
                  wordBreak: 'break-all', overflow: 'hidden',
                  display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2,
                }}>{isGroup ? (devGroup ? '📱 ' : '👥 ') : ''}{title}</div>
                <div style={{ fontSize: 10, color: showTyping ? '#22c55e' : 'var(--muted)', fontFamily: 'ui-monospace,monospace' }}>
                  {/* 设备群副题（决策F）：📱 设备群 · N 台设备 · M 在线（名册即成员表，
                      决策C——吊销不计；不显示"N人"，members 恒单账号语义失真）。 */}
                  {showTyping ? `${typerName ?? title} 正在输入…`
                    : devGroup ? (devInfo && devInfo.total > 0 ? `📱 设备群 · ${devInfo.total} 台设备 · ${devInfo.online} 在线` : '📱 设备群')
                    : isGroup ? `${title} · ${group?.members.length ?? 0}人` : tail4(convId)}
                </div>
              </div>
            </>
          )
        })()}
        {/* 第85轮：群管理入口（批二：终态群只读，无管理入口；设备群=系统群治理锁死，
            决策 D.4——⚙️ 不渲染，GroupManageSheet 不可达） */}
        {isGroup && group && !groupTerminal && !devGroup && (
          <button onClick={() => onOpenGroupManage(group)} style={{ flexShrink: 0, background: 'none', border: '1px solid var(--border,#e2e5ee)', borderRadius: 9, width: 30, height: 30, fontSize: 14, cursor: 'pointer' }}>⚙️</button>
        )}
      </div>
      {/* 2026-10-18 M11：删除 P2P 对账进度横幅（"正在与「X」同步历史…（已收 N 条）"）。
          对账是后台事，聊天流只呈现人对人内容；过程状态不再上屏。 */}

      <div className="myco-chat-view" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
        <div className="chat-scroll friend-chat-scroll" ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: 'auto', padding: '10px 12px 16px' }}>
          {msgs.length === 0 && <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 12.5, padding: '34px 0' }}>还没有消息，说第一句吧</div>}
          {/* 2026-09-29 Bug1 修：容器 column-reverse（DOM 首=视觉底）——渲染序必须
              倒序（新→旧），视觉才是旧→新、最新贴在输入框上方（微信语义，与
              ChatView 的 messages.reverse() 同约定，抽成 renderOrderMsgs 共测）。
              批四：时间条/署名聚合(prevM)/引用块/长按菜单都在本循环接线。 */}
          {renderOrderMsgs(msgs).map((m, ri, arr) => {
            // 设备群=数据面（与 PC chat_load_conv 过滤同义）：task-rename 是 owner 多端
            // 同步的载体行，不渲染成条（任务库已在 ingest 时更新）。
            if (m.kind === 'task-rename' && devGroup) return null
            // 2026-10-18 M11：非人类系统条（机制留痕/未知系统事件）不进聊天流。
            // 白名单=微信同款系统提示（撤回/入群/退群/解散/群创建/好友关系/设备群）。
            if (m.kind === 'sys' && !isHumanSystemLine(m)) return null
            // 批四：时间序前一条=倒序数组的下一个。首条/>5min 断开 → 居中时间条
            // （跨天时条文本自带日期：fmtConvTime withTime）；时间条同时打断署名聚合。
            const prev = ri + 1 < arr.length ? arr[ri + 1] : null
            const timeBar = needTimeSep(prev?.ts ?? null, m.ts) ? (
              <div style={{ textAlign: 'center', margin: '10px 0 4px', fontSize: 11, color: 'var(--muted)' }}>{fmtConvTime(m.ts, true)}</div>
            ) : null
            // 批四：时间合并——好友聊天此前不传 prevM，isGroupedWith 5 分钟规则
            // 形同虚设（每条消息都重署名+头像）。prevM 只接"同为气泡渲染"的前一条；
            // 系统条/任务卡/文件卡/链接卡/时间条都打断聚合。
            let prevCm: ChatMessage | null = null
            if (!timeBar && prev && (prev.kind === 'text' || prev.kind === 'group-msg' || prev.kind === 'image')) {
              const prevLink = prev.kind === 'text' && extractTaskLink((prev.payload as { text?: string }).text || '')
              if (!prevLink) prevCm = toBubbleMsg(prev, null)
            }
            const body = (() => {
            if (m.kind === 'sys') {
              const t2 = (m.payload as { text?: string }).text || ''
              // 批四：sys 条去掉硬编码 🤝 前缀（撤回/退群/入群语义各异，文案自带 emoji）
              return (
                <div style={{ textAlign: 'center', margin: '7px 0', fontSize: 11, color: 'var(--muted)' }}>
                  <span style={{ background: 'rgba(52,211,153,.10)', padding: '2px 10px', borderRadius: 8 }}>{t2}</span>
                </div>
              )
            }
            // 批二：group-create 落群会话（对账载体——离线成员补齐真 owner 的凭据），渲染"群已创建"系统条
            if (m.kind === 'official-notice') return <div style={{ margin: '8px 0' }}><OfficialNoticeCard m={m} /></div>
            if (m.kind === 'group-create') {
              const gname = (m.payload as { groupName?: string }).groupName || '群'
              return (
                <div style={{ textAlign: 'center', margin: '7px 0', fontSize: 11, color: 'var(--muted)' }}>
                  <span style={{ background: 'rgba(52,211,153,.10)', padding: '2px 10px', borderRadius: 8 }}>🎉 群「{gname}」已创建</span>
                </div>
              )
            }
            if (m.kind === 'task-share') {
              // 2026-10-23 任务卡 env：卡上 `env[]` 逐行（老卡按 sourceDevice 派生一条 rdp）；
              // 入口只在卡上——设备/好友卡不挂（R28）。
              const flatCard = flattenTaskSharePayload(m.payload as Record<string, unknown>)
              /* 2026-10-23 真机 bug（与 PC 同源）：卡上有 env 时，点卡身会跳底层分享入口
                 （点【PC远程桌面】卡 → 打开 DSH web 全量会话）。有 env ⇒ 卡身只展示，
                 入口一律走下方 env 行；无 env 的老卡保持原行为。 */
              const phoneEnvArr = (flatCard as { env?: unknown[] }).env
              const phoneHasEnv = Array.isArray(phoneEnvArr) && phoneEnvArr.length > 0
              // 2026-10-23 真机反馈：卡上没有 env（老卡）时，点卡身会打开底层分享入口 →
              // 用户以为"点远程桌面卡却开了 DSH web"。入口只认 env 行：无 env 时卡身
              // 只展示 + 给一句提示，不再打开分享入口（AOP：没有 env 就没有入口）。
              return (
                <div style={{ margin: '8px 0' }}>
                  <TaskCard m={m} onOpen={undefined} />
                  {phoneHasEnv && m.dir !== 'out' && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', margin: '2px 2px 4px' }}>从下方环境打开 ↓</div>
                  )}
                  {!phoneHasEnv && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', margin: '2px 2px 4px' }}>
                      此卡没有可用的环境入口（请让主设备重新分享带环境的任务卡）
                    </div>
                  )}
                  <TaskEnvList card={flatCard as Record<string, unknown>} enabled={m.dir !== 'out'} />
                  {shareOpenNote && shareOpenNote.msgId === m.msgId && shareOpenNote.text && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, maxWidth: 238 }}>
                      {/* 2026-10-11 用户报「连接过程中也不显示连接中」：取票→起本地口→
                          race 候选腿的这几秒就是"连接过程"，把连接中徽标显式摆出来。 */}
                      {shareOpenNote.text === '正在打开…' && <ConnBadge mode="connecting" />}
                      <span style={{ fontSize: 11.5, color: shareOpenNote.text === '正在打开…' ? '#7ea8d4' : '#b45309', lineHeight: 1.5 }}>{shareOpenNote.text}</span>
                    </div>
                  )}
                </div>
              )
            }
            // 第94轮：文件卡气泡（名字+大小+图标；点击系统打开）
            if (m.kind === 'file') return <div style={{ margin: '8px 0' }}><FileCard m={m} mine={m.dir === 'out'} onOpen={(mm) => void openChatFile(mm)} /></div>
            if (m.kind === 'task-accept' || m.kind === 'task-done') {
              const p = (m.payload as { title?: string; name?: string })
              const t = p.title || '任务'
              // 第83轮：带 name → "一起"语系（温馨协作感）
              const text = m.kind === 'task-accept'
                ? (p.name ? `🤝 ${p.name} 一起接了任务《${t}》` : `✓ 已接受任务《${t}》`)
                : (p.name ? `🎉 ${p.name} 完成了任务《${t}》` : `✓ 已完成任务《${t}》`)
              return (
                <div style={{ textAlign: 'center', margin: '7px 0', fontSize: 11, color: 'var(--muted)' }}>
                  <span style={{ background: 'rgba(107,123,255,.08)', padding: '2px 10px', borderRadius: 8 }}>{text}</span>
                </div>
              )
            }
            // 2026-10-11 任务卡改名留痕条（owner 广播的标题终局同步；数据更新在 ingest 已做）
            if (m.kind === 'task-rename') {
              const p = m.payload as { title?: string }
              const text = m.dir === 'out'
                ? `✏️ 你把任务卡改名为「${p.title || ''}」`
                : `✏️ ${m.fromName || '对方'} 把任务卡改名为「${p.title || ''}」`
              return (
                <div style={{ textAlign: 'center', margin: '7px 0', fontSize: 11, color: 'var(--muted)' }}>
                  <span style={{ background: 'rgba(107,123,255,.08)', padding: '2px 10px', borderRadius: 8 }}>{text}</span>
                </div>
              )
            }
            // 第87轮：文本里的 youling 任务链接自动变卡片
            if (m.kind === 'text') {
              const link = extractTaskLink((m.payload as { text?: string }).text || '')
              if (link) return <div style={{ margin: '4px 0', display: 'flex', justifyContent: m.dir === 'out' ? 'flex-end' : 'flex-start' }}><TaskLinkCard url={link} /></div>
            }
            const cm = toBubbleMsg(m, null)
            if (!cm) return null
            // 批四：引用回复摘要块（payload.replyTo 快照）嵌在气泡上方（微信语义）
            const rp = m.payload as { replyTo?: string; replySnippet?: string; replyFromName?: string }
            const quoteName = rp.replyFromName || (m.dir === 'out' ? '我' : shortDid(m.fromName || '') || title)
            return (
              <>
                {!!rp.replyTo && (
                  <div style={{
                    fontSize: 11, color: 'var(--muted,#8a93a8)', padding: '3px 9px', marginBottom: 2,
                    background: 'var(--card,#fff)', border: '1px solid var(--border,#e2e5ee)', borderRadius: 8,
                    maxWidth: '80%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    // 批五：父级是普通块盒，alignSelf 不生效——引用摘要块跟气泡同侧（自己靠右）
                    marginLeft: m.dir === 'out' ? 'auto' : 0, marginRight: m.dir === 'out' ? 0 : 'auto',
                  }}>{quoteName}：{rp.replySnippet || '消息'}</div>
                )}
                <MessageBubble m={cm} ownAuthor={myName || '我'} noAnim prevM={prevCm} />
              </>
            )
            })()
            // 批四：长按/右键菜单只挂内容行（sys/回执条/改名留痕条不挂）
            const menuable = m.kind !== 'sys' && m.kind !== 'task-accept' && m.kind !== 'task-done' && m.kind !== 'task-rename'
            return (
              <Fragment key={m.msgId}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: m.dir === 'out' ? 'flex-end' : 'flex-start' }}
                  {...(menuable ? {
                    onPointerDown: lpStart(m), onPointerUp: lpCancel, onPointerLeave: lpCancel, onPointerCancel: lpCancel,
                    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); setMenuFor(m) },
                  } : {})}>
                  <div style={{ width: '100%' }}>{body}</div>
                  <SendStateBadge m={m} onRetry={onRetryMsg} />
                </div>
                {/* column-reverse：时间条视觉在消息上方 → DOM 排在消息之后 */}
                {timeBar}
              </Fragment>
            )
          })}
        </div>
        {/* 批四：上翻阅读期间的新消息 ↓N 浮标（点击贴底并清零） */}
        {newBelow > 0 && (
          <button onClick={jumpBottom} style={{
            position: 'absolute', right: 14, bottom: 76, zIndex: 40, border: 'none', borderRadius: 999,
            padding: '7px 13px', fontSize: 12, fontWeight: 800, color: '#fff',
            background: 'linear-gradient(135deg,var(--mc-accent,#6b7bff),var(--mc-accent-2,#5567f5))',
            boxShadow: '0 4px 14px rgba(22,30,60,.28)', cursor: 'pointer',
          }}>↓ {newBelow > 99 ? '99+' : newBelow}</button>
        )}
        {err && <div style={{ padding: '3px 14px', fontSize: 11, color: '#e5534b' }}>{err}</div>}
        {/* 批四：引用回复条（输入区上方；✕ 取消） */}
        {replyTo && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 11px', background: 'var(--bg,#f6f7fa)', borderTop: '1px solid var(--border,#e2e5ee)' }}>
            <span style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, background: 'var(--mc-accent,#6b7bff)', flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              引用 <b style={{ color: 'var(--text)' }}>{replyTo.dir === 'out' ? '我' : shortDid(replyTo.fromName || '') || title}</b>：{convPreview(replyTo).slice(0, 42)}
            </span>
            <button onClick={() => setReplyTo(null)} style={{ background: 'none', border: 'none', fontSize: 12, color: 'var(--muted)', cursor: 'pointer', flexShrink: 0 }}>✕</button>
          </div>
        )}
        {/* 批四：safe-area-inset-bottom 适配（全面屏手势条不压输入区） */}
        <div style={{ display: 'flex', gap: 7, alignItems: 'flex-end', padding: '9px 11px', paddingBottom: 'calc(9px + env(safe-area-inset-bottom, 0px))', background: 'var(--card,#fff)', borderTop: '1px solid var(--border,#e2e5ee)' }}>
          <button title={groupTerminal ? '群已只读' : '发文件 / 图片'} onClick={() => imgRef.current?.click()} disabled={groupTerminal} style={{ ...toolBtnS, opacity: groupTerminal ? 0.45 : 1 }}>📎</button>
          <button title={groupTerminal ? '群已只读' : '分享任务卡'} onClick={() => setShareOpen((v) => !v)} disabled={groupTerminal} style={{ ...toolBtnS, opacity: groupTerminal ? 0.45 : 1 }}>📋</button>
          <textarea ref={textareaRef} value={text} rows={1}
            onChange={(e) => {
              updateText(e.target.value)
              // 批四：自动增高（上限 96px 随 maxHeight；此前固定一行高，多行只见一行）
              const el = e.target
              el.style.height = 'auto'
              el.style.height = Math.min(el.scrollHeight, 96) + 'px'
              sendTypingSignal()
            }}
            disabled={inputLocked}
            onKeyDown={(e) => { sendTypingSignal(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
            placeholder={inputLocked ? lockPlaceholder : '输入消息，Enter 发送'}
            style={{ flex: 1, resize: 'none', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 10px', fontSize: 13.5, fontFamily: 'inherit', background: 'var(--bg,#fff)', color: 'var(--text)', maxHeight: 96, overflowY: 'auto', opacity: inputLocked ? 0.55 : 1 }} />
          <button onClick={() => void send()} disabled={!text.trim() || busy || inputLocked}
            style={{ border: 'none', borderRadius: 10, padding: '0 14px', height: 36, fontSize: 13.5, fontWeight: 700, color: '#fff', background: 'linear-gradient(135deg,var(--mc-accent,#6b7bff),var(--mc-accent-2,#5567f5))', opacity: !text.trim() || busy || inputLocked ? 0.45 : 1 }}>发送</button>
          {/* 第94轮：accept 放开为任意类型（Android 壳 onShowFileChooser 的 createIntent 跟随 accept；
              图片自动压缩走原链路，其他文件走 10MB 上限的 file 卡） */}
          <input ref={imgRef} type="file" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) sendAnyFile(f); e.target.value = '' }} />
        </div>
        {shareOpen && (
          <ShareSheet conv={convId}
            targetLabel={isGroup ? `群「${title}」（${group?.members.length ?? 0} 人）` : `好友 ${title}`}
            onClose={() => setShareOpen(false)}
            onShared={() => {
              setShareOpen(false); load(); onChanged()
              setSharedFlash(true)
              setTimeout(() => setSharedFlash(false), 2600)
            }} />
        )}
      </div>

      {detail && <TaskDetail task={detail} onClose={() => setDetail(null)} onChanged={() => { load(); onChanged() }} />}

      {/* 分享成功反馈横幅（fixed 屏内居中，2.6s 自消） */}
      {sharedFlash && (
        <div style={{ position: 'absolute', top: 56, left: '50%', transform: 'translateX(-50%)', zIndex: 150, padding: '7px 14px', borderRadius: 10, background: 'rgba(34,197,94,.94)', color: '#fff', fontSize: 12.5, fontWeight: 700, boxShadow: '0 4px 14px rgba(0,0,0,.22)', whiteSpace: 'nowrap' }}>✓ 任务卡已分享，等 TA 一起做</div>
      )}

      {/* 批四：长按消息 ActionSheet（微信语义：复制/引用回复/撤回(2min 内)/删除本地）。
          可用动作集由 chat-store 的 msgMenuActions 状态机给出（单测覆盖）。 */}
      {menuFor && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 160, background: 'rgba(8,12,20,.45)', display: 'flex', alignItems: 'flex-end' }}
          onClick={() => setMenuFor(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{
            width: '100%', background: 'var(--card,#fff)', borderRadius: '16px 16px 0 0',
            padding: '8px 0 calc(10px + env(safe-area-inset-bottom, 0px))', boxShadow: '0 -6px 24px rgba(22,30,60,.18)',
          }}>
            {/* 被引消息预览行（知道在对哪条操作） */}
            <div style={{ padding: '6px 16px 10px', fontSize: 11.5, color: 'var(--muted)', borderBottom: '1px solid var(--border,#e2e5ee)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {convPreview(menuFor).slice(0, 40) || '消息'}
            </div>
            {msgMenuActions(menuFor).map((act) => (
              <button key={act} onClick={() => runMenuAction(act, menuFor)} style={{
                display: 'block', width: '100%', padding: '13px 16px', border: 'none', background: 'none',
                fontSize: 14.5, textAlign: 'left', cursor: 'pointer',
                color: act === 'delete' ? '#e5534b' : 'var(--text,#1c2333)',
              }}>
                {act === 'copy' ? '📋 复制' : act === 'reply' ? '↩ 引用回复' : act === 'recall' ? '⏪ 撤回（2 分钟内）' : '🗑 删除（仅本地）'}
              </button>
            ))}
            <button onClick={() => setMenuFor(null)} style={{
              display: 'block', width: '100%', padding: '12px 16px', border: 'none', background: 'none',
              fontSize: 14, color: 'var(--muted)', cursor: 'pointer', borderTop: '6px solid var(--bg,#f6f7fa)',
            }}>取消</button>
          </div>
        </div>
      )}
      {/* 批四：屏内轻 toast（复制成功/撤回失败等即时反馈） */}
      {toast && (
        <div style={{ position: 'absolute', top: 56, left: '50%', transform: 'translateX(-50%)', zIndex: 170, padding: '6px 14px', borderRadius: 10, background: 'rgba(30,35,50,.92)', color: '#fff', fontSize: 12.5, whiteSpace: 'nowrap', boxShadow: '0 4px 14px rgba(0,0,0,.25)' }}>{toast}</div>
      )}
    </div>
  )
}
const toolBtnS: React.CSSProperties = { flexShrink: 0, border: '1px solid var(--border,#e2e5ee)', background: 'none', borderRadius: 10, width: 36, height: 36, cursor: 'pointer', fontSize: 16 }
/** 批四：会话行 ActionSheet 按钮通用样式。 */
const convSheetBtnS: React.CSSProperties = { display: 'block', width: '100%', padding: '13px 16px', border: 'none', background: 'none', fontSize: 14.5, textAlign: 'left', cursor: 'pointer', color: 'var(--text,#1c2333)' }

/* ═════════ 分享任务卡弹层（两路：分享我的任务 / 新建） ═════════
 * 2026-09-29 提交断头路根修：此前整个表单（含「分享任务卡」提交按钮）被包在
 * maxHeight:200 的嵌套滚动区里——手机端表单实际高约 260px+（.btn 就有 52px），
 * 提交按钮整颗压在折叠线之下，键盘一开更够不着 → "填完没地方点提交"。
 * 结构改为：头部/页签 + 唯一滚动区（字段/列表）+ 固定提交底栏（不随字段滚动，
 * 恒可见）；sheet 整体 maxHeight:78vh 自适应矮屏。可提交判定走 taskShareForm。 */
function ShareSheet({ conv, targetLabel, onClose, onShared }: {
  conv: string; targetLabel: string; onClose: () => void; onShared: () => void
}) {
  const [mode, setMode] = useState<'pick' | 'new'>('pick')
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [req, setReq] = useState('')
  const [reward, setReward] = useState('')
  const [days, setDays] = useState('0')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const tasks = getBoardTasks()
  const fields = { title, desc, req, reward, days }
  const doShare = async (card: TaskShareCard) => {
    setBusy(true); setErr(null)
    try {
      await shareTask(conv, card)
      onShared()
    } catch (e) { setErr(String(e).replace(/^Error:\s*/, '')) } finally { setBusy(false) }
  }
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 30, background: 'var(--card,#fff)', borderRadius: '16px 16px 0 0', padding: '13px 14px 14px', boxShadow: '0 -6px 24px rgba(22,30,60,.14)', maxHeight: '78vh', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 9, flexShrink: 0 }}>
        <b style={{ fontSize: 14, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📋 分享任务卡 → {targetLabel}</b>
        <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 12, color: 'var(--muted)', cursor: 'pointer', flexShrink: 0 }}>收起 ✕</button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 9, flexShrink: 0 }}>
        <button className={mode === 'pick' ? 'btn' : 'btn ghost'} style={{ padding: '5px 12px', fontSize: 12.5 }} disabled={!tasks.length} onClick={() => setMode('pick')}>分享我的任务</button>
        <button className={mode === 'new' ? 'btn' : 'btn ghost'} style={{ padding: '5px 12px', fontSize: 12.5 }} onClick={() => setMode('new')}>新建任务卡</button>
      </div>
      {/* 唯一滚动区：列表/表单字段。提交按钮不进来（钉在底栏恒可见）。 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {mode === 'pick' ? (
          <>
            {tasks.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', padding: '10px 0' }}>暂无可分享的任务（任务页加载后可用）</div>}
            {tasks.map((t, i) => (
              <div key={i} onClick={() => void doShare({ title: t.title, desc: `来自项目「${t.projectName}」`, requirements: '', reward: '', expiresDays: 0 })}
                style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 2px', borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
                <span style={{ width: 7, height: 7, borderRadius: 4, background: '#6b7bff', flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                <span style={{ fontSize: 11.5, color: 'var(--accent,#6b7bff)', fontWeight: 700, flexShrink: 0 }}>分享 ›</span>
              </div>
            ))}
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="任务标题（必填）" style={inpS} />
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="任务介绍：做什么、为什么" rows={2} style={{ ...inpS, resize: 'none' }} />
            <textarea value={req} onChange={(e) => setReq(e.target.value)} placeholder={'要求/验收（尽量可测、有时限）：\n如 目标：≤2小时完成 / 验收：代码可编译'} rows={2} style={{ ...inpS, resize: 'none' }} />
            <div style={{ display: 'flex', gap: 7 }}>
              <input value={reward} onChange={(e) => setReward(e.target.value)} placeholder="奖励（可选）" style={{ ...inpS, flex: 1 }} />
              <select value={days} onChange={(e) => setDays(e.target.value)} style={{ ...inpS, width: 108 }}>
                <option value="0">长期有效</option>
                <option value="1">1 天</option>
                <option value="3">3 天</option>
                <option value="7">7 天</option>
              </select>
            </div>
          </div>
        )}
      </div>
      {/* 报错 + 提交底栏：不随字段滚动，填完即见（两模式共用报错行）。 */}
      {err && <div style={{ flexShrink: 0, fontSize: 12, color: '#e5534b', marginTop: 7 }}>{err}</div>}
      {mode === 'new' && (
        <div style={{ flexShrink: 0, marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--border,#e2e5ee)' }}>
          <button className="btn" style={{ width: '100%' }} disabled={!canSubmitTaskForm(fields, busy)}
            onClick={() => void doShare(taskShareSubmitArgs(fields))}>
            {busy ? '分享中…' : '创建并分享任务卡'}
          </button>
        </div>
      )}
    </div>
  )
}
const inpS: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 9, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', background: 'var(--bg,#fff)', color: 'var(--text)', width: '100%', boxSizing: 'border-box' }

/* ═════════ 任务卡详情弹层 ═════════ */
function TaskDetail({ task, onClose, onChanged }: { task: PeerTask; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const expired = taskExpired(task)
  const accepted = task.status !== 'pending'
  // 第83轮：参与方（多人协作感）
  const parts = task.participants ?? []
  const taskDone = task.status === 'done'
  const doAccept = async () => {
    setBusy(true); setErr(null)
    try { await acceptTask(task.taskId); onChanged(); onClose() }
    catch (e) { setErr(String(e).replace(/^Error:\s*/, '')) } finally { setBusy(false) }
  }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 140, background: 'rgba(8,12,20,.66)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 330, borderRadius: 16, background: 'var(--card,#fff)', padding: 16, boxShadow: '0 18px 48px rgba(8,12,20,.3)', maxHeight: '84vh', overflowY: 'auto' }}>
        <div style={{ height: 5, borderRadius: 3, background: expired ? '#9aa3b8' : 'linear-gradient(90deg,#6b7bff,#4ec9a5)', marginBottom: 10 }} />
        <div style={{ fontSize: 16.5, fontWeight: 800, color: 'var(--text)', lineHeight: 1.4 }}>{task.title}</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', margin: '3px 0 9px' }}>
          来自 {shortDid(task.fromName || '') || '好友'} 分享{task.reward ? ` · 奖励 ${task.reward}` : ''}{expired ? ' · 已过期' : ''}
        </div>
        {task.desc && <><div style={labelS}>介绍</div><div style={bodyS}>{task.desc}</div></>}
        {task.rSpec && task.rSpec.length > 0 && <><div style={labelS}>验收指标（r_spec）</div>
          {task.rSpec.map((r, i) => <div key={i} style={{ ...bodyS, display: 'flex', justifyContent: 'space-between' }}><span>{r.label || r.key}</span><b>{String(r.target)}{r.unit || ''}</b></div>)}
        </>}
        {task.requirements && <><div style={labelS}>要求 / 验收</div><div style={bodyS}>{task.requirements}</div></>}
        {/* 第83轮：参与方列表（头像+名字+状态）——"多人一起齐心协力"的具象 */}
        {parts.length > 0 && (<>
          <div style={labelS}>一起完成的人（{parts.length}）</div>
          <div style={{ ...bodyS, display: 'flex', flexDirection: 'column', gap: 5 }}>
            {parts.map((p) => (
              <div key={p.did} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                  background: p.role === 'owner' ? 'linear-gradient(135deg,#6b7bff,#5567f5)' : p.status === 'done' ? 'linear-gradient(135deg,#34d399,#10b981)' : 'linear-gradient(135deg,#fbbf24,#f59e0b)',
                  color: '#fff', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                  {(p.name || '灵').slice(0, 1)}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name || `…${p.did.slice(-6)}`}</span>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: p.status === 'done' || taskDone ? '#22c55e' : 'var(--muted)' }}>
                  {p.status === 'done' || taskDone ? '✓ 已完成' : p.role === 'owner' ? '发起人' : '进行中'}
                </span>
              </div>
            ))}
          </div>
        </>)}
        {/* 第83轮：完成横幅 */}
        {taskDone && (
          <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 9, background: 'rgba(34,197,94,.10)', color: '#15803d', fontSize: 12.5, fontWeight: 800, textAlign: 'center' }}>
            🎉 {Math.max(parts.length, 1)} 人协作完成
          </div>
        )}
        {task.expiresAt && <div style={{ fontSize: 10.5, color: expired ? '#e5534b' : 'var(--muted)', marginTop: 6 }}>有效期至 {new Date(task.expiresAt).toLocaleString()}{expired ? '（已过期）' : ''}</div>}
        {err && <div style={{ fontSize: 12, color: '#e5534b', marginTop: 6 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 13 }}>
          <button className="btn ghost" style={{ flex: 1 }} onClick={onClose}>关闭</button>
          {!accepted && <button className="btn" style={{ flex: 2 }} disabled={busy || expired} onClick={() => void doAccept()}>{expired ? '已过期' : busy ? '接受中…' : '🤝 一起做'}</button>}
          {accepted && !taskDone && <div className="btn ghost" style={{ flex: 2, textAlign: 'center', opacity: .8 }}>一起做 · 在任务页</div>}
        </div>
      </div>
    </div>
  )
}
const labelS: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', margin: '8px 0 3px', letterSpacing: .4 }
const bodyS: React.CSSProperties = { fontSize: 12.5, color: 'var(--text)', lineHeight: 1.65, whiteSpace: 'pre-wrap', background: 'var(--bg,#f6f7fa)', borderRadius: 8, padding: '7px 9px' }

/* ═════════ 好友/群分区卡（Pairing 身份 Tab 用） ═════════ */
export function FriendsPanel() {
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  // 第82轮：好友事件 toast + 删除二次确认
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([])
  const [removeArming, setRemoveArming] = useState<string | null>(null)
  const prevFriendsRef = useRef<ReturnType<typeof listFriends> | null>(null)
  const myRemoveSetRef = useRef<Set<string>>(new Set())
  const pushToast = useCallback((text: string) => {
    const id = Date.now() + Math.random()
    setToasts((ts) => [...ts, { id, text }])
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4200)
  }, [])
  const fst2 = (f: { status?: string; pending?: boolean }) => f.status || (f.pending ? 'in-pending' : 'ok')
  const detectFriendEvents = useCallback(() => {
    const next = listFriends()
    const prev = prevFriendsRef.current
    prevFriendsRef.current = next
    if (!prev) return
    for (const f of next) {
      const before = prev.find((x) => x.did === f.did)
      if (!before && fst2(f) === 'in-pending') pushToast(`📩 ${f.name} 请求加你为好友`)
      if (before && fst2(before) !== 'ok' && fst2(f) === 'ok') pushToast(`🎉 ${f.name} 已通过好友请求`)
    }
    for (const b of prev) {
      if (fst2(b) === 'ok' && !next.find((x) => x.did === b.did) && !myRemoveSetRef.current.has(b.did)) pushToast(`${b.name} 已将你移除好友`)
    }
  }, [pushToast])
  useEffect(() => { detectFriendEvents() }, [tick, detectFriendEvents])
  // 批二：群事件 toast（被踢/群解散）——groups 快照 diff（好友 toast 同款模式）；
  // ingest 落终态（status=kicked/disbanded）后下一轮 tick 即被发现。我是 owner 的
  // 解散=自己操作（act() 已 toast），不双报。
  const prevGroupsRef = useRef<ChatGroup[] | null>(null)
  const detectGroupEvents = useCallback(() => {
    const next = listGroups()
    const prev = prevGroupsRef.current
    prevGroupsRef.current = next
    if (!prev) return
    const my = myAccountDid()
    for (const g of next) {
      const before = prev.find((x) => x.id === g.id)
      const wasTerminal = before?.status === 'disbanded' || before?.status === 'kicked'
      if (wasTerminal) continue
      if (g.status === 'kicked') pushToast(`🚫 你已被移出群「${g.name}」`)
      else if (g.status === 'disbanded' && g.owner !== my) pushToast(`📢 群「${g.name}」已被群主解散`)
    }
  }, [pushToast])
  useEffect(() => { detectGroupEvents() }, [tick, detectGroupEvents])
  const doRemove = (f: { did: string; name: string }) => {
    if (removeArming !== f.did) { setRemoveArming(f.did); setTimeout(() => setRemoveArming((cur) => cur === f.did ? null : cur), 2500); return }
    setRemoveArming(null)
    myRemoveSetRef.current.add(f.did)
    // 2026-10-16 修「静默失败」（死按钮审计 🟡）：removeFriend 失败会 throw（投递不可达等）
    // ——此前无 .catch：无任何反馈、好友仍在列表=「点了没反应」。
    void removeFriend(f.did)
      .then(() => { pushToast(`已删除好友 ${f.name}`); refresh() })
      .catch((e) => { pushToast(`删除失败：${String(e).replace(/^Error:\s*/, '').slice(0, 60)}`) })
  }
  const [chat, setChat] = useState<{ id: string; title: string; isGroup: boolean } | null>(null)
    // MD-002（2026-10-21）：把 convRows/setChat/chat 注册进 window.__mycoUi —— agent CLI 执行面。
    const chatRef = useRef(chat); chatRef.current = chat
    useEffect(() => {
        const w = window as unknown as { __mycoUi?: { _impl: unknown } }
        if (!w.__mycoUi) return
        w.__mycoUi._impl = {
            get chat() { return chatRef.current },
            convRows: [],
            setChat,
        }
        return () => { if (w.__mycoUi) w.__mycoUi._impl = null }
    }, [setChat])
  // 第84轮：presence 轮询（灯）+ P2P 后台循环（对账/state 上报）启动
  const [presence, setPresence] = useState<Record<string, FriendPresence>>({})
  useEffect(() => { ensureP2pLoops() }, [])
  // 进好友分区即节流对账（15s 一刀）：PC 建的群/新消息不等 60s 周期（2026-09-28）
  useEffect(() => { syncNowThrottled() }, [])
  useEffect(() => {
    const load = () => { void listPresence().then((l) => setPresence(aggregatePresence(l))).catch(() => {}) }
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [])
  // 第85轮：群管理屏
  const [groupManage, setGroupManage] = useState<ChatGroup | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addDid, setAddDid] = useState('')
  const [addMsg, setAddMsg] = useState<string | null>(null)
  const [scanOpen, setScanOpen] = useState(false)
  const [grpOpen, setGrpOpen] = useState(false)
  const [grpName, setGrpName] = useState('')
  const [grpSel, setGrpSel] = useState<Set<string>>(new Set())
  const myDid = myAccountDid()

  // 设备群（2026-10-07 设计 §3 决策 B.3/F）：挂载即本地幂等建群 + 首见置顶种子
  // （App.tsx 账号加载后是另一个挂点——幂等，多处调用无害）。
  useEffect(() => {
    if (!myDid) return
    ensureDeviceGroup()
    seedDeviceGroupPin()
    refresh() // 建群后即时重渲（不待 5s 轮询）
  }, [myDid, refresh])

  // 名册自愈（C1，2026-10-07）：切号级触发点——myDid 变化（挂载/切账号）即查一次
  // 服务端名册（404→/root/create 重建；App.tsx 另管启动/解锁时点，均为低频非轮询，
  // in-flight 防重入）。检出旧格式（400 unsupported_did_format）→ refresh 让引导条显形。
  useEffect(() => {
    if (!myDid) return
    void ensureRootRoster().then((r) => { if (r === 'legacy') refresh() }).catch(() => {})
  }, [myDid, refresh])

  // 设备群名册（决策 C/F）：fetchPresenceByRoot 15s 轮询（/presence/by-root 已有端点，
  // signedPost 可调）→ 头部副题/行副题数据源。失败（离线/服务未部署）→ null 走降级
  // 文案（「本账号设备」/「📱 设备群」），聊天与列表不受影响。
  const [devRoster, setDevRoster] = useState<RosterDevice[] | null>(null)
  useEffect(() => {
    if (!myDid) return
    let alive = true
    const loadRoster = () => {
      void fetchPresenceByRoot(myDid)
        .then((devs) => { if (alive) setDevRoster(devs ?? []) })
        .catch(() => { if (alive) setDevRoster(null) })
    }
    loadRoster()
    const t = setInterval(loadRoster, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [myDid])
  const devCounts = devRoster ? deviceGroupCountsOf(devRoster) : { total: 0, online: 0 }

  // 5s 轮询拉信箱（好友请求/新消息入库 → 重渲）
  useEffect(() => {
    if (!myDid) return
    void chatPoll().then((n) => { if (n > 0) refresh() }).catch(() => {})
    const t = setInterval(() => { void chatPoll().then((n) => { if (n > 0) refresh() }).catch(() => {}) }, 5000)
    return () => clearInterval(t)
  }, [myDid, refresh])

  const friends = listFriends()
  const groups = listGroups()
  const fst = (f: typeof friends[0]) => f.status || (f.pending ? 'in-pending' : 'ok')
  const pending = friends.filter((f) => fst(f) === 'in-pending')
  const waiting = friends.filter((f) => fst(f) === 'out-pending')
  const okFriends = friends.filter((f) => fst(f) === 'ok')
  /** 2026-10-18 M11：会话行预览只取"人对人内容"——机制留痕/未知系统条跳过，回退到
   *  上一条可见消息（不让 🛡 cap_denied 之类的过程文字出现在列表里）。lastTs 仍取
   *  真实最后一条（含被隐藏的系统行）——排序/时间不被预览过滤影响。 */
  const lastOf = (id: string): { last: ChatMsg | null; lastTs: number } => {
    const conv = loadConv(id)
    const lastTs = conv.length ? conv[conv.length - 1].ts : 0
    for (let i = conv.length - 1; i >= 0; i--) {
      const m = conv[i]
      if (m.kind === 'sys' && !isHumanSystemLine(m)) continue
      return { last: m, lastTs }
    }
    return { last: null, lastTs }
  }
  // 批四：会话列表微信化——好友+群合并统一排序（置顶优先，其余按 lastTs 倒序），
  // 行内时间（fmtConvTime 同款规则）+ 数字未读徽标（>99 显 99+）+ 免打扰 🔕。
  interface ConvRow {
    id: string; isGroup: boolean; title: string; sub: string
    last: ChatMsg | null; lastTs: number; unreadN: number
    pinned: boolean; pinTs: number; muted: boolean; draft: string
    friend?: (typeof okFriends)[0]; group?: ChatGroup
  }
  const convRows = sortConvRows<ConvRow>([
    ...okFriends.map((f) => {
      const { last, lastTs } = lastOf(f.did)
      const pref = convPref(f.did)
      return {
        id: f.did, isGroup: false, title: f.name, sub: tail4(f.did),
        last, lastTs, unreadN: unreadCount(f.did),
        pinned: !!pref.pinned, pinTs: pref.pinned ?? 0, muted: !!pref.muted,
        draft: getDraft(f.did), friend: f,
      }
    }),
    ...groups.map((g) => {
      const { last, lastTs } = lastOf(g.id)
      const pref = convPref(g.id)
      // 设备群（决策F）：行副题「N 台设备」（名册未取到降级「本账号设备」；
      // members 恒单账号，"N人"语义失真）
      const isDev = isDeviceGroupOf(g)
      return {
        id: g.id, isGroup: true, title: g.name,
        sub: isDev ? (devCounts.total > 0 ? `${devCounts.total}台设备` : '本账号设备') : `${g.members.length}人`,
        last, lastTs, unreadN: unreadCount(g.id),
        pinned: !!pref.pinned, pinTs: pref.pinned ?? 0, muted: !!pref.muted,
        draft: getDraft(g.id), group: g,
      }
    }),
  ])
    // MD-002：convRows 渲染期同步进 __mycoUi._impl（agent ui open-conv 的匹配源）
    {
        const b = (window as unknown as { __mycoUi?: { _impl: { convRows: unknown } | null } }).__mycoUi
        if (b && b._impl) b._impl.convRows = convRows.map((r) => ({ id: r.id, title: r.title, isGroup: r.isGroup, unreadN: r.unreadN }))
    }
  // 批四：长按会话行菜单（置顶/免打扰/删除会话）
  const [convMenuFor, setConvMenuFor] = useState<ConvRow | null>(null)
  const [convDelArming, setConvDelArming] = useState(false)
  const convLpTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const convLpStart = (r: ConvRow) => () => {
    if (convLpTimer.current) clearTimeout(convLpTimer.current)
    convLpTimer.current = setTimeout(() => { setConvMenuFor(r); setConvDelArming(false); setRemoveArming(null); convLpTimer.current = null }, 500)
  }
  const convLpCancel = () => { if (convLpTimer.current) { clearTimeout(convLpTimer.current); convLpTimer.current = null } }

  if (!myDid) return null // 未关联账号不渲染（同 PC）

  const doAdd = async () => {
    // 2026-10-05：DID 完整性校验（长度窗+字母表）——残缺串（复制丢字）就地提示，不发请求
    if (!isValidDid(addDid.trim())) { setAddMsg('识别码格式不对（长度/字符异常——复制时可能丢字，请重新复制）'); return }
    setAddMsg(null)
    try { await addFriend(addDid.trim()); setAddMsg('✓ 已发送好友请求'); setAddDid(''); setScanOpen(false); refresh() }
    catch (e) { setAddMsg(`✗ ${String(e).replace(/^Error:\s*/, '')}`) }
  }
  const onScan = (text: string) => {
    const did = text.trim()
    if (did.startsWith('did:')) { setAddDid(did); setScanOpen(false); void doAddWith(did) }
    else { setAddMsg('二维码不是识别码'); setScanOpen(false) }
  }
  const doAddWith = async (did: string) => {
    try { await addFriend(did); setAddMsg('✓ 已发送好友请求'); setAddDid(''); refresh() }
    catch (e) { setAddMsg(`✗ ${String(e).replace(/^Error:\s*/, '')}`) }
  }
  const doGrp = async () => {
    if (!grpSel.size) return
    try { await createGroup(grpName, [...grpSel]); setGrpOpen(false); setGrpName(''); setGrpSel(new Set()); refresh() }
    catch (e) { setAddMsg(`✗ ${String(e).replace(/^Error:\s*/, '')}`) }
  }

  return (
    <div className="card" style={{ marginTop: 10 }}>

      {/* 第82轮：好友事件 toast */}
      {toasts.length > 0 && (
        <div style={{ position: 'fixed', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 6, width: '86%' }}>
          {toasts.map((t) => (
            <div key={t.id} style={{ padding: '8px 12px', borderRadius: 10, background: 'rgba(30,35,50,.92)', color: '#fff', fontSize: 12.5, boxShadow: '0 4px 14px rgba(0,0,0,.25)' }}>{t.text}</div>
          ))}
        </div>
      )}
      {/* 旧格式账号引导条（2026-10-07 清档闸门立法，与 PC 账号页同款文案）——
          名册自愈检出 create 400 unsupported_did_format → accountFormatLegacy：
          此账号格式已死（加好友/搜索等账号功能 403 半瘫），引导两条出路：
          {/* 2026-10-08 修订（用户实测，与 PC legacyAccount.ts 单一源一字不差）：
          ① 解绑后重新注册（不再提「注销设备」——不清账号=回来还在，死循环）；② 先导出恢复码、重注册后导入延续钥匙。 */}
      {accountFormatLegacy() && (
        <div data-testid="legacy-format-banner" style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '10px 12px', marginBottom: 8, borderRadius: 10, border: '1px solid #fca5a5', background: 'rgba(254,242,242,.9)' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#b91c1c' }}>⚠️ 账号为旧格式已停用</div>
          {/* 2026-10-18：解绑入口收进账号卡的「危险操作」折叠区（默认收起），文案同步改；
              此前写"页底危险区"但实际位置在账号详情里——用户找不到（2026-10-09 已修过一次）。 */}
          <div style={{ fontSize: 11.5, lineHeight: 1.6, color: '#b91c1c' }}>请到「智能体 → 有灵账号」卡展开「危险操作 → 解绑账号」，输入"解绑"二字确认解绑，然后重新注册；想保留这把身份钥匙，可先导出恢复码，再重新注册后导入。</div>
          <div style={{ fontSize: 11, color: '#b91c1c' }}>现状：加好友/被搜索等账号功能已受限，处理前无法恢复。</div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span className="card-title" style={{ marginBottom: 0 }}>好友</span>
        <div style={{ display: 'flex', gap: 14, fontSize: 12.5 }}>
          <span className="linkish" style={{ color: 'var(--muted)' }} onClick={() => { setGrpOpen(false); setAddOpen((v) => !v) }}>＋ 加好友</span>
          <span className="linkish" style={{ color: 'var(--muted)' }} onClick={() => { setAddOpen(false); setGrpOpen((v) => !v) }}>＋ 建群</span>
        </div>
      </div>

      {waiting.map((f) => (
        <div key={f.did} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 0', borderTop: '1px solid var(--border)', opacity: 0.72 }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, background: 'linear-gradient(135deg,#94a3b8,#64748b)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flexShrink: 0 }}>{(f.name || '友').slice(0, 1)}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name} <span style={{ fontSize: 10.5, color: 'var(--muted)', fontFamily: 'ui-monospace,monospace' }}>{tail4(f.did)}</span></div>
            <div style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>等待对方通过</div>
          </span>
          <button className="btnd ghost" style={{ padding: '4px 10px', fontSize: 12, flexShrink: 0, whiteSpace: 'nowrap', width: 'auto' }} onClick={() => doRemove(f)}>撤回</button>
        </div>
      ))}

      {pending.map((f) => (
        <div key={f.did} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 0', borderTop: '1px solid var(--border)' }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, background: 'linear-gradient(135deg,#fbbf24,#f59e0b)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flexShrink: 0 }}>{(f.name || '友').slice(0, 1)}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{f.name} <span style={{ fontSize: 10.5, color: 'var(--muted)', fontFamily: 'ui-monospace,monospace' }}>{tail4(f.did)}</span></div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>请求加你为好友</div>
          </span>
          <button className="btnd ghost" style={{ padding: '4px 10px', fontSize: 12, flexShrink: 0, whiteSpace: 'nowrap', width: 'auto' }} onClick={() => { void ignoreFriend(f.did).then(refresh).catch((e) => pushToast(`忽略失败：${String(e).replace(/^Error:\s*/, '')}，请重试`)) }}>忽略</button>
          <button className="btnd" style={{ padding: '4px 12px', fontSize: 12, flexShrink: 0, whiteSpace: 'nowrap', width: 'auto' }} onClick={() => { void acceptFriend(f.did).then(refresh).catch((e) => pushToast(`接受失败：${String(e).replace(/^Error:\s*/, '')}，请重试`)) }}>接受</button>
        </div>
      ))}

      {okFriends.length === 0 && pending.length === 0 && waiting.length === 0 && groups.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 0' }}>还没有好友——填对方识别码或扫码互加</div>
      )}
      {/* 批四：会话列表微信化——好友/群统一按 置顶>lastTs 排序；行内时间+数字未读
          （免打扰会话灰显计数不红点）+ [草稿] 红标 + 长按行菜单（置顶/免打扰/删会话）。 */}
      {convRows.map((r) => {
        // 批二：终态群（已解散/已被移出）=灰色只读行（徽标替代人数，预览仅可查看历史）
        const terminal = !!(r.isGroup && r.group && (r.group.status === 'disbanded' || r.group.status === 'kicked'))
        const typer = !terminal && r.isGroup && r.group ? firstTypingMember(r.group.members, presence, myDid ?? undefined) : null
        const peerTyping = !r.isGroup && !!presenceOf(presence, r.id)?.online && presenceOf(presence, r.id)?.state === 'typing'
        return (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', background: r.pinned ? 'rgba(107,123,255,.05)' : 'transparent', borderRadius: r.pinned ? 10 : 0 }}>
            <button onClick={() => setChat({ id: r.id, title: r.title, isGroup: r.isGroup })}
              onPointerDown={convLpStart(r)} onPointerUp={convLpCancel} onPointerLeave={convLpCancel} onPointerCancel={convLpCancel}
              onContextMenu={(e) => { e.preventDefault(); setConvMenuFor(r); setConvDelArming(false); setRemoveArming(null) }}
              style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '9px 0', borderTop: '1px solid var(--border)', textAlign: 'left', background: 'none', border: 'none', borderTopWidth: 1, cursor: 'pointer', opacity: terminal ? 0.55 : 1 }}>
              <span style={{ position: 'relative', width: 34, height: 34, flexShrink: 0 }}>
                {/* 批四：头像统一——首字母圆+名字散列取色（avatarColorOf，三处同色）；批二：终态群灰化；
                    设备群（决策F）：📱 徽标（普通群 👥 不变） */}
                <span style={{ width: 34, height: 34, borderRadius: 10, background: terminal ? 'linear-gradient(135deg,#9aa3b8,#8a93a8)' : avatarColorOf(r.title), color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14 }}>
                  {r.isGroup ? (r.group && isDeviceGroupOf(r.group) ? '📱' : '👥') : (r.title || '友').slice(0, 1)}
                </span>
                {/* 第84轮：在线灯（三态）——头像右下角（好友行；群无单一对端灯） */}
                {!r.isGroup && <span style={{ position: 'absolute', right: -2, bottom: -2 }}><PresenceDot p={presenceOf(presence, r.id)} size={9} /></span>}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                {/* 批五：昵称名单独省略 span——名字独占可用宽（≥12 字符可见），
                    did 尾/人数徽标不参与换行挤压；此前整行裸排长名直接溢出。 */}
                <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text)', display: 'flex', alignItems: 'baseline', gap: 4 }}>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                  {!terminal && <span style={{ fontSize: 10.5, color: 'var(--muted)', fontFamily: 'ui-monospace,monospace', flexShrink: 0 }}>{r.isGroup ? `(${r.sub})` : r.sub}</span>}
                  {terminal && <span style={{ fontSize: 10.5, color: '#8a93a8', fontWeight: 700, flexShrink: 0 }}> {r.group!.status === 'disbanded' ? '已解散' : '已被移出'}</span>}
                  {r.muted && <span style={{ fontSize: 10.5, marginLeft: 3, flexShrink: 0 }} title="免打扰">🔕</span>}
                </div>
                {/* 行预览：草稿红标 > 对方/成员 typing 绿字 > 最后消息（终态群无 typing，兜底"仅可查看历史"） */}
                {r.draft && !terminal
                  ? <div style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><span style={{ color: '#e5534b', fontWeight: 700 }}>[草稿] </span><span style={{ color: 'var(--muted)' }}>{r.draft}</span></div>
                  : typer
                    ? <div style={{ fontSize: 11, color: '#22c55e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dispNameOf(typer, listFriends())} 正在输入…</div>
                    : peerTyping
                      ? <div style={{ fontSize: 11, color: '#22c55e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>正在输入…</div>
                      : <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.last ? (r.last.dir === 'out' ? '我: ' : '') + chatPreviewOf(r.last) : (terminal ? '仅可查看历史' : r.isGroup ? '群聊建好了' : '发消息试试')}</div>}
              </span>
              {/* 右列：行内时间（fmtConvTime 规则）+ 数字未读徽标 */}
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
                {r.last && <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'ui-monospace,monospace' }}>{fmtConvTime(r.last.ts)}</span>}
                {r.unreadN > 0 && (
                  r.muted
                    ? <span style={{ fontSize: 9.5, color: 'var(--muted)', background: 'rgba(148,163,184,.18)', borderRadius: 8, padding: '0 6px', fontWeight: 700 }}>{r.unreadN > 99 ? '99+' : r.unreadN}</span>
                    : <span style={{ fontSize: 9.5, color: '#fff', background: '#e5534b', borderRadius: 8, padding: '0 6px', fontWeight: 700, minWidth: 16, textAlign: 'center' }}>{r.unreadN > 99 ? '99+' : r.unreadN}</span>
                )}
              </span>
            </button>
            {/* 批五（2026-09-29）：一级行尾的 ✕ 删好友易误触——撤入长按 ActionSheet
                （下方 convMenuFor 菜单，二次确认保留）；群退群仍在群管理屏。 */}
          </div>
        )
      })}

      {/* 批四：长按会话行 ActionSheet——置顶/免打扰/删除会话（不删好友）；
          批五：删除好友也收进本菜单（一级行尾 ✕ 易误触已撤），二次确认保留 */}
      {convMenuFor && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 160, background: 'rgba(8,12,20,.45)', display: 'flex', alignItems: 'flex-end' }}
          onClick={() => setConvMenuFor(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{
            width: '100%', background: 'var(--card,#fff)', borderRadius: '16px 16px 0 0',
            padding: '8px 0 calc(10px + env(safe-area-inset-bottom, 0px))', boxShadow: '0 -6px 24px rgba(22,30,60,.18)',
          }}>
            <div style={{ padding: '6px 16px 10px', fontSize: 11.5, color: 'var(--muted)', borderBottom: '1px solid var(--border,#e2e5ee)' }}>
              {convMenuFor.isGroup ? '👥 ' : ''}{convMenuFor.title}
            </div>
            <button style={convSheetBtnS} onClick={() => { setConvPinned(convMenuFor.id, !convMenuFor.pinned); setConvMenuFor(null); refresh() }}>
              {convMenuFor.pinned ? '📌 取消置顶' : '📌 置顶会话'}
            </button>
            <button style={convSheetBtnS} onClick={() => { setConvMuted(convMenuFor.id, !convMenuFor.muted); setConvMenuFor(null); refresh() }}>
              {convMenuFor.muted ? '🔔 取消免打扰' : '🔕 消息免打扰'}
            </button>
            <button style={{ ...convSheetBtnS, color: '#e5534b' }} onClick={() => {
              if (!convDelArming) { setConvDelArming(true); return }
              deleteConv(convMenuFor.id)
              setConvMenuFor(null); setConvDelArming(false); refresh()
              pushToast(`已删除与「${convMenuFor.title}」的会话记录`)
            }}>
              {convDelArming ? '⚠️ 确认删除？聊天记录将清空（不删好友）' : '🗑 删除会话'}
            </button>
            {/* 批五：删除好友（原一级行尾 ✕ 收编于此；复用 doRemove 两步确认状态机，
                第二击执行后收菜单） */}
            {convMenuFor.friend && (
              <button style={{ ...convSheetBtnS, color: '#e5534b' }} onClick={() => {
                const armed = removeArming === convMenuFor.friend!.did
                doRemove(convMenuFor.friend!)
                if (armed) { setConvMenuFor(null); setConvDelArming(false) }
              }}>
                {removeArming === convMenuFor.friend.did
                  ? `⚠️ 确认删除好友「${convMenuFor.friend.name}」？（再点一次）`
                  : '🗑 删除好友'}
              </button>
            )}
            <button style={{ ...convSheetBtnS, color: 'var(--muted)', borderTop: '6px solid var(--bg,#f6f7fa)' }} onClick={() => setConvMenuFor(null)}>取消</button>
          </div>
        </div>
      )}

      {addOpen && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          {scanOpen ? (
            <QrCamera onResult={onScan} onClose={() => setScanOpen(false)} />
          ) : (
            <>
              <button className="btn" style={{ width: '100%' }} onClick={() => setScanOpen(true)}>📷 扫对方二维码</button>
              {/* 2026-10-05：粘贴非法 DID 实时提示——非空且校验不过 → 红边框+橙字，发送按钮保持禁用
                  2026-10-08 文案统一（随 PC 2026-10-07「识别码」词系）：原 placeholder 有重复笔误
                  "有灵账号 有灵账号 DID"（UI 一致性调研 S3 抓出）。 */}
              <input value={addDid} onChange={(e) => setAddDid(e.target.value.trim())} placeholder="或粘贴对方识别码" style={{ width: '100%', marginTop: 8, padding: '8px 10px', borderRadius: 9, border: `1px solid ${addDid && !isValidDid(addDid) ? '#e5534b' : 'var(--border)'}`, fontSize: 12.5, fontFamily: 'ui-monospace,monospace', boxSizing: 'border-box' }} />
              {addDid && !isValidDid(addDid) && (
                <div style={{ fontSize: 11.5, marginTop: 5, color: '#e65100', lineHeight: 1.5 }}>识别码格式不对（长度/字符异常——复制时可能丢字，请重新复制）</div>
              )}
              <button className="btn" style={{ width: '100%', marginTop: 8 }} disabled={!isValidDid(addDid)} onClick={() => void doAdd()}>发送好友请求</button>
              <div style={{ textAlign: 'center', margin: '10px 0 4px' }}>
                <QrImage text={myDid} size={130} />
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>我的二维码（对方扫码加我）</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'ui-monospace,monospace', cursor: 'pointer' }} onClick={() => { void copyDidVerified(myDid).then((r) => pushToast(copyDidToastText(r))).catch(() => pushToast('复制失败')) }}>我的识别码：{tail4(myDid)} 点击复制</div>
              </div>
              {addMsg && <div style={{ fontSize: 12, marginTop: 6, color: addMsg.startsWith('✓') ? 'var(--ok)' : '#e5534b' }}>{addMsg}</div>}
            </>
          )}
        </div>
      )}

      {grpOpen && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <input value={grpName} onChange={(e) => setGrpName(e.target.value.slice(0, 24))} placeholder="群名（默认「新群聊」）" style={{ width: '100%', padding: '8px 10px', borderRadius: 9, border: '1px solid var(--border)', fontSize: 12.5, boxSizing: 'border-box' }} />
          <div style={{ fontSize: 11, color: 'var(--muted)', margin: '8px 0 2px' }}>选择成员（已选 {grpSel.size}）</div>
          {okFriends.length === 0 && <div style={{ fontSize: 11, color: 'var(--muted)', padding: '6px 0' }}>还没有好友——先加上面加好友，加了才能拉群</div>}
          {okFriends.map((f) => (
            <label key={f.did} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 0', cursor: 'pointer' }}>
              <input type="checkbox" checked={grpSel.has(f.did)} onChange={(e) => { const n = new Set(grpSel); if (e.target.checked) n.add(f.did); else n.delete(f.did); setGrpSel(n) }} />
              <span style={{ fontSize: 13.5, color: 'var(--text)' }}>{f.name}</span>
            </label>
          ))}
          <button className="btn" style={{ width: '100%', marginTop: 8 }} disabled={!grpSel.size} onClick={() => void doGrp()}>创建群聊</button>
        </div>
      )}

      {chat && !groupManage && (
        /* 批四：key={chat.id}——切会话重挂 ChatScreen，草稿/引用/菜单态按会话隔离
           （草稿持久化在 chat-store，重挂后 getDraft 恢复） */
        <ChatScreen key={chat.id} convId={chat.id} title={chat.title} isGroup={chat.isGroup} myName={currentYoulingName()} myDid={myDid}
          onBack={() => { setChat(null); refresh() }} onChanged={refresh}
          presence={presence} onOpenGroupManage={(g) => setGroupManage(g)}
          devInfo={devCounts} />
      )}
      {/* 第85轮：群管理屏 */}
      {groupManage && <GroupManageSheet g={groupManage} myDid={myDid} myName={currentYoulingName()} friends={listFriends()} onBack={() => { setGroupManage(null); refresh() }} onChanged={refresh} pushToast={pushToast} />}
    </div>
  )
}

function chatPreviewOf(m: ChatMsg): string {
  const p = m.payload as { text?: string; name?: string; title?: string }
  switch (m.kind) {
    case 'image': return '[图片]'
    case 'file': return `[文件] ${p.name || ''}`
    case 'task-share': return `[任务卡] ${p.title || ''}`
    // 第83轮：带 name（接受/完成者）
    case 'task-accept': return p.name ? `${p.name} 一起接了任务` : '已接受任务'
    case 'task-done': return p.name ? `${p.name} 完成了任务` : '已完成任务'
    default: return p.text || ''
  }
}

/* ═════════ peer 任务区（TaskList 顶部 / 任务 Tab 露出：参与方 + 状态流转） ═════════ */
export function PeerTasksSection() {
  const [, setTick] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  // §3.23：点列表里的分享卡 → 走 dsh-open-runtime 取票 + 隧道（点它 = 走 remoteOpen 那条链）
  const [openNote, setOpenNote] = useState<{ id: string; text: string; state?: EnvRowState } | null>(null)
  // 2026-10-11 任务卡改名：长按任务卡 → ActionSheet（仅 owner 可见「改名」）→ 改名弹层
  const [taskMenu, setTaskMenu] = useState<PeerTask | null>(null)
  const [renaming, setRenaming] = useState<PeerTask | null>(null)
  // 2026-10-18 手机版权限设置（同账号授权设备 → 主设备上的分享）
  const [permCard, setPermCard] = useState<ShareAdminCard | null>(null)
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const swallowClick = useRef(false)
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  useEffect(() => {
    const t = setInterval(refresh, 5000) // 接受/完成后他端回执与本地变化都靠 tick 重读
    return () => clearInterval(t)
  }, [refresh])
  // R10 预取票：本区块出现可打开的远端任务卡时，后台先取票（点卡时省一次往返）。
  // 依赖 tasks.length 而非 tasks：内容变化靠 tick 刷新，长度变化才需要重新评估。
  const taskCountForPrefetch = getBoardTasks().length
  useEffect(() => {
    for (const task of listTasks()) {
      // env 卡不走取票/隧道（入口是固定口直连）——别为它预取分享票
      if (declaredEnvsOfCard(task as unknown as Record<string, unknown>, task.action).length) continue
      const card = taskShareCardOf(task)
      if (card) prefetchTaskEntry(card as unknown as Record<string, unknown>)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskCountForPrefetch])
  // 批五（2026-09-29 用户实测）：shared（我分享出去的）也入列——此前整体过滤导致
  // 自己发的任务卡在「我的任务」看不到。自己的卡走 peerTaskView 创建者视角
  // （「我发起的 · 待接受/进行中」），不接受者视角的 一起做/开始/完成 按钮。
  const my = myAccountDid()
  const tasks = listTasks()
  if (!tasks.length) return null
  const views = tasks.map((t) => ({ t, v: peerTaskView(t, my) }))
  const pendingN = views.filter(({ v }) => !v.mine && v.statusKey === 'pending').length
  const stLabel: Record<string, string> = { pending: '待接受', todo: '待办', doing: '进行', done: '已完成' }
  const mineLabel: Record<string, string> = { pending: '待接受', doing: '进行中', done: '已完成' }
  const set = async (id: string, s: string) => {
    try { await setTaskStatus(id, s); refresh() } catch (e) { setErr(String(e).replace(/^Error:\s*/, '')) }
  }
  /** 列表行「打开」：**env 卡优先按环境直开**（2026-10-23 真机 bug）——
   *  有 env 时入口是环境本身（固定口 → RDP 复制地址/DSH 浏览器），**不走分享入口**
   *  （`/gw/<id>/app/` 会报 `no valid share cookie (open the share entry first)`）；
   *  没有 env 的老卡保持原 `openTaskShare`（取票 → 本地端口 → 原生 WebView）。
   *
   *  2026-11-11 两条新路由：
   *  · **adb 卡（目标是本机设备）→ 开/关本机 vnet server（5555）**——手机是 server，
   *    `__mycoVnet.add` 是"我去连别人"的方向，用反了；server 生命周期见 adb-share.ts。
   *  · **DSH 卡带分享坐标 → 取票链（openTaskShare）**——PC 网关入口 `/gw/<id>/` 必须
   *    带新鲜 mt 票，而新卡的 entryUrl 已是设备域形态（`<device>.localhost:24011/dsh/`，
   *    手机上 `entryUrlOf` 判非法 → 落根路径 `127.0.0.1:23911/` 无 cookie 必 401）。
   *    取票链（share-entry-request → 中继兜底）每次点卡现签新票，不依赖卡上快照。
   *    RDP 是裸 TCP（3389 无票据概念），保持 env 直开不变。 */
  const openShare = (t: PeerTask) => {
    const envs = declaredEnvsOfCard(t as unknown as Record<string, unknown>, t.action)
    const env = primaryEnvOf(envs)
    const shareCard = taskShareCardOf(t)
    if (env && env.kind === 'adb' && env.device && accountDidEq(env.device, myDeviceDid())) {
      // 本机 ADB 卡：server 开关（异步桥——libvnet 注册在 native 线程；重复点=幂等启动）
      setOpenNote({ id: t.taskId, text: '正在启动 ADB 服务…' })
      void adbServerStart().then((r) => {
        if (r.ok) {
          void ensureAdbCard().catch(() => undefined)
          setOpenNote({ id: t.taskId, text: 'ADB 服务运行中 · 授权设备可经 vnet 隧道连接', state: 'ready' })
        } else {
          setOpenNote({ id: t.taskId, text: r.err || '启动失败，稍后再试' })
        }
      })
      return
    }
    if (env && env.kind === 'dsh' && shareCard) {
      setOpenNote({ id: t.taskId, text: '正在打开…' })
      void openTaskShare(shareCard as unknown as Record<string, unknown>, {
        onNote: (text) => setOpenNote({ id: t.taskId, text }),
      }).then((r) => {
        setOpenNote({ id: t.taskId, text: r.ok ? '' : r.message })
      }).catch((e: unknown) => {
        setOpenNote({ id: t.taskId, text: e instanceof Error ? e.message : '打不开这个任务，稍后再试' })
      })
      return
    }
    if (env) {
      setOpenNote({ id: t.taskId, text: '正在连接…' })
      // RDP：先把「本机 → 该设备:3389」的设备级 vnet 隧道拉起来并回写本地口，
      // 再交给 openTaskEnv 去算地址/复制/唤起远程桌面 App。不做这一步时卡片里写死的
      // localPort(23389) 是 PC 侧口，手机上没人监听（2026-11-11 真机"复制失败"）。
      const prep = env.kind === 'rdp' && env.device
        ? ensureRdpForwardFor(env.device).catch(() => null)
        : Promise.resolve(null)
      void prep.then(() => openTaskEnv(env, {
        gate: envGateOf(t as unknown as Record<string, unknown>),
        onBuilding: (text) => setOpenNote({ id: t.taskId, text }),
      })).then((r) => {
        // 2026-10-23 用户反馈：RDP 复制成功提示曾被渲染成红色错误样式——note 带 state，
        // 渲染按语气上色（ready=绿 / building=蓝 / 其它=红），见 openNoteTone。
        setOpenNote({ id: t.taskId, text: r.note || stateText(r.state, env.kind), state: r.state })
      }).catch((e: unknown) => {
        setOpenNote({ id: t.taskId, text: e instanceof Error ? e.message : '打不开这个环境，稍后再试' })
      })
      return
    }
    const card = shareCard
    if (!card) { setErr('这张任务卡缺少来源设备信息，打不开（可以让对方重新分享一次）'); return }
    setOpenNote({ id: t.taskId, text: '正在打开…' })
    void openTaskShare(card as unknown as Record<string, unknown>, {
      onNote: (text) => setOpenNote({ id: t.taskId, text }),
    }).then((r) => {
      setOpenNote({ id: t.taskId, text: r.ok ? '' : r.message })
    }).catch((e: unknown) => {
      setOpenNote({ id: t.taskId, text: e instanceof Error ? e.message : '打不开这个任务，稍后再试' })
    })
  }
  return (
    <div className="card" style={{ marginBottom: 10, ...(pendingN > 0 ? { boxShadow: '0 2px 14px rgba(245,158,11,.14)' } : {}) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="card-title" style={{ marginBottom: 0, flex: 1 }}>好友分享的任务</span>
        {/* 第83轮：待接受 N 醒目标记（只数好友发来的——自己发的不算「待我接受」） */}
        {pendingN > 0 && (
          <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 8, background: 'linear-gradient(135deg,#fbbf24,#f59e0b)', color: '#fff' }}>待接受 {pendingN}</span>
        )}
      </div>
      {views.map(({ t, v }) => {
        const expired = taskExpired(t)
        const parts = t.participants ?? []
        const label = v.mine ? (mineLabel[v.statusKey] || v.statusKey) : (stLabel[v.statusKey] || v.statusKey)
        // §3.23 列表项标清：**谁分享的** / **我的角色** / **我的权限**（可不可转授）
        // 2026-10-23：有 env 的卡也可点——入口是**环境本身**（不需要 shareId 三坐标）；
        // 没有 env 的老卡仍按分享卡坐标判定（缺坐标 = 不给假入口）。
        const rowEnvs = declaredEnvsOfCard(t as unknown as Record<string, unknown>, t.action)
        const openable = rowEnvs.length > 0 || !!taskShareCardOf(t)
        // 2026-10-31 晚（设计定稿）：这里不再露出「浏览器」次要动作——系统浏览器是
        // 独立存储分区：没有复用、没有空态观察者（B 兜底只在本壳内），指针失效
        // 也无法从 myco 侧修复；实测"打开后列表为空"不可控。DSH 卡一律走
        // 应用内浏览器（本壳内：复用 + 网关指针种子 + 空态兜底）。
        const fromWhom = t.sourceDeviceName || t.fromName || ''
        const roleTxt = t.myRole === 'owner' || v.mine ? '我的' : '协作者'
        // 长按/右键菜单只挂 owner 的行（唯一动作=改名；非 owner 长按无动作可给——
        // 不弹空菜单）。2026-10-12：曾扩到所有可开卡行（配"在浏览器中打开"），
        // 该入口下线后回到 owner-only。
        const lpProps = v.mine ? {
          onPointerDown: () => {
            if (lpTimer.current) clearTimeout(lpTimer.current)
            lpTimer.current = setTimeout(() => { swallowClick.current = true; setTaskMenu(t); lpTimer.current = null }, 500)
          },
          onPointerUp: () => { if (lpTimer.current) { clearTimeout(lpTimer.current); lpTimer.current = null } },
          onPointerLeave: () => { if (lpTimer.current) { clearTimeout(lpTimer.current); lpTimer.current = null } },
          onPointerCancel: () => { if (lpTimer.current) { clearTimeout(lpTimer.current); lpTimer.current = null } },
          onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); setTaskMenu(t) },
        } : {}
        return (
          <div key={t.taskId} onClick={() => { if (swallowClick.current) { swallowClick.current = false; return } if (openable) openShare(t) }}
            {...lpProps}
            style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 0', borderTop: '1px solid var(--border)', opacity: t.status === 'done' ? .6 : 1, cursor: openable ? 'pointer' : 'default' }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: t.status === 'done' ? '#22c55e' : v.statusKey === 'pending' ? (expired ? '#9aa3b8' : '#f59e0b') : '#6b7bff', flexShrink: 0 }} />
            <ParticipantsAvatars participants={parts} size={17} />
            <span style={{ flex: 1, minWidth: 0 }}>
              {/* 2026-10-11 标题走 taskDispTitle（mojibake 兜底，见 chat-store 同名注释） */}
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{taskDispTitle(t)}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.status === 'done'
                  ? `🎉 ${Math.max(parts.length, 1)} 人协作完成`
                  : v.mine
                    ? `我发起的 · ${label}${v.statusKey === 'pending' && expired ? ' · 已过期' : ''}`
                    : `来自 ${shortDid(fromWhom) || '好友'} · ${label}${t.status === 'pending' && expired ? ' · 已过期' : ''}`}
              </div>
              {/* 我的角色 + 我的权限（只读/读写 + 可见范围摘要）：一行小字，不抢标题 */}
              <div style={{ fontSize: 10.5, color: '#8a93a8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {roleTxt} · {taskPermLabel(t)}{openable && !taskCanReshare(t) ? ' · 不可转授' : ''}
              </div>
              {openNote && openNote.id === t.taskId && openNote.text && (() => {
                const tone = openNoteTone(openNote.text, openNote.state)
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
                    {openNote.text === '正在打开…' && <ConnBadge mode="connecting" />}
                    <span style={{ fontSize: 10.5, color: tone === 'ok' ? '#2f9e6e' : tone === 'building' ? '#7ea8d4' : '#e5534b' }}>{openNote.text}</span>
                  </div>
                )
              })()}
            </span>
            {t.status !== 'done' && <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 6, background: v.mine ? 'rgba(148,163,184,.16)' : 'rgba(107,123,255,.12)', color: v.mine ? '#64748b' : '#4338ca', fontWeight: 700, flexShrink: 0 }}>{v.mine ? '📤 我发起' : '🤝 分享'}</span>}
            {openable && <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 6, background: 'rgba(78,201,165,.16)', color: '#0f766e', fontWeight: 700, flexShrink: 0 }}>▶ 打开</span>}
            {!v.mine && t.status === 'pending' && !expired && <button className="btnd" style={{ padding: '3px 10px', fontSize: 12 }} onClick={(e) => { e.stopPropagation(); void acceptTask(t.taskId).then(refresh).catch((e2) => setErr(String(e2))) }}>一起做</button>}
            {!v.mine && t.status === 'todo' && <button className="btnd ghost" style={{ padding: '3px 10px', fontSize: 12 }} onClick={(e) => { e.stopPropagation(); void set(t.taskId, 'doing') }}>开始</button>}
            {!v.mine && (t.status === 'todo' || t.status === 'doing') && <button className="btnd" style={{ padding: '3px 10px', fontSize: 12 }} onClick={(e) => { e.stopPropagation(); void set(t.taskId, 'done') }}>完成</button>}
          </div>
        )
      })}
      {err && <div style={{ fontSize: 11.5, color: '#e5534b', marginTop: 4 }}>{err}</div>}
      {/* 2026-10-11 任务卡长按 ActionSheet；2026-10-12 扩：所有可开卡都挂长按，
          新增「在浏览器中打开」（隧道照建、不占 myco WebView——用户在系统浏览器里
          看 DSH 页，myco 还能正常操作别的；断线也只是浏览器刷新一下）。 */}
      {taskMenu && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 160, background: 'rgba(8,12,20,.45)', display: 'flex', alignItems: 'flex-end' }}
          onClick={() => setTaskMenu(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{
            width: '100%', background: 'var(--card,#fff)', borderRadius: '16px 16px 0 0',
            padding: '8px 0 calc(10px + env(safe-area-inset-bottom, 0px))', boxShadow: '0 -6px 24px rgba(22,30,60,.18)',
          }}>
            <div style={{ padding: '6px 16px 10px', fontSize: 11.5, color: 'var(--muted)', borderBottom: '1px solid var(--border,#e2e5ee)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {taskMenu.title}
            </div>
            {/* 2026-10-12：「在浏览器中打开」先下线（用户决定）——myco 退后台被
                系统冻结时隧道会断，浏览器那侧一直转圈；等隧道客户端 native 化 +
                前台服务保活后再上。当前统一走 app 内 WebView（点卡）。 */}
            {taskMenu.myRole === 'owner' || peerTaskView(taskMenu, my).mine ? (
              <Fragment>
                <button style={convSheetBtnS} onClick={() => { const t = taskMenu; setTaskMenu(null); setRenaming(t) }}>✏️ 改名</button>
                {/* 2026-10-18：手机作为主设备授权设备 → 远程打开这张卡在主设备上的「权限设置」 */}
                <button style={convSheetBtnS} onClick={() => {
                  const t = taskMenu
                  const card = taskShareCardOf(t)
                  setTaskMenu(null)
                  if (!card) { setErr('这张卡缺少来源设备信息，暂时不能改权限'); return }
                  setPermCard(card)
                }}>🔑 权限设置</button>
              </Fragment>
            ) : null}
            <button onClick={() => setTaskMenu(null)} style={{ ...convSheetBtnS, color: 'var(--muted)', borderTop: '6px solid var(--bg,#f6f7fa)', fontSize: 14 }}>取消</button>
          </div>
        </div>
      )}
      {renaming && (
        <RenameTaskSheet task={renaming} onClose={() => setRenaming(null)}
          onDone={() => { setRenaming(null); refresh() }} />
      )}
      {/* 2026-10-18 手机版权限设置（底部弹层；操作转发主设备执行） */}
      {permCard && (
        <SharePermSheet card={permCard} onClose={() => setPermCard(null)} onChanged={refresh} />
      )}
    </div>
  )
}

/* ═════════ 任务卡改名弹层（2026-10-11；仅 owner 入口——PeerTasksSection 长按菜单） ═════════ */
function RenameTaskSheet({ task, onClose, onDone }: { task: PeerTask; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState(task.title)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const trimmed = title.trim()
  const unchanged = trimmed === task.title
  const doRename = async () => {
    setBusy(true); setErr(null)
    try {
      await renameTask(task.taskId, title)
      onDone()
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, '')) // 失败留在弹层内（可改可退），不污染列表
    } finally { setBusy(false) }
  }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 170, background: 'rgba(8,12,20,.66)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 330, borderRadius: 16, background: 'var(--card,#fff)', padding: 16, boxShadow: '0 18px 48px rgba(8,12,20,.3)' }}>
        <div style={{ height: 5, borderRadius: 3, background: 'linear-gradient(90deg,#6b7bff,#4ec9a5)', marginBottom: 10 }} />
        <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)', marginBottom: 8 }}>✏️ 任务卡改名</div>
        <input value={title} onChange={(e) => setTitle(e.target.value.slice(0, 64))} placeholder="新标题（≤64 字）" style={inpS} autoFocus />
        <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4 }}>改名会同步给一起做的所有人（以最后一次改名为准）</div>
        {err && <div style={{ fontSize: 12, color: '#e5534b', marginTop: 6 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 13 }}>
          <button className="btn ghost" style={{ flex: 1 }} onClick={onClose}>取消</button>
          <button className="btn" style={{ flex: 2 }} disabled={busy || !trimmed || unchanged} onClick={() => void doRename()}>{busy ? '改名中…' : '确认改名'}</button>
        </div>
      </div>
    </div>
  )
}

/* ═════════ 任务卡事件 toast（第83轮：App 根级——任务视图无 FriendsPanel 时也可见） ═════════
 * 到达检测=localStorage 任务库快照 diff（好友 toast 同款模式）；ingest 靠 ensureBackgroundPoll
 * （此前停在任务页时信箱无人拉——任务卡到达无通知的根因之一）。 */
export function PeerTaskToasts() {
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([])
  const prevRef = useRef<PeerTask[] | null>(null)
  const pushToast = useCallback((text: string) => {
    const id = Date.now() + Math.random()
    setToasts((ts) => [...ts, { id, text }])
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4600)
  }, [])
  const scan = useCallback(() => {
    const next = listTasks()
    const prev = prevRef.current
    prevRef.current = next
    if (!prev) return // 首帧快照不通知（防启动时存量任务刷屏）
    for (const t of next) {
      const p = prev.find((x) => x.taskId === t.taskId)
      if (!p && t.status === 'pending') pushToast(`📋 ${shortDid(t.fromName || '') || '好友'} 给你分享了任务《${t.title}》`)
      if (p && p.status !== 'done' && t.status === 'done') pushToast(`🎉 《${t.title}》已完成`)
    }
  }, [pushToast])
  // 2026-10-21（O07）：全局轻提示通道——僵尸卡自动清理等"无页面级反馈"的动作也弹 toast
  useEffect(() => {
    const onToast = (e: Event) => {
      const text = String((e as CustomEvent<{ text?: string }>).detail?.text || '').trim()
      if (text) pushToast(text)
    }
    window.addEventListener('myco:toast', onToast as EventListener)
    return () => window.removeEventListener('myco:toast', onToast as EventListener)
  }, [pushToast])
  useEffect(() => {
    scan() // 初始化快照
    const stop = ensureBackgroundPoll(scan) // 后台拉信箱 → 有入库即扫 diff
    const t = setInterval(scan, 3000) // 兜底：FriendsPanel 自轮询入库时也能扫到
    return () => { stop(); clearInterval(t) }
  }, [scan])
  if (!toasts.length) return null
  return (
    <div style={{ position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 6, width: '80%', maxWidth: 300 }}>
      {toasts.map((t) => (
        <div key={t.id} style={{ padding: '8px 12px', borderRadius: 10, background: 'rgba(30,35,50,.92)', color: '#fff', fontSize: 12.5, boxShadow: '0 4px 14px rgba(0,0,0,.25)', textAlign: 'center' }}>{t.text}</div>
      ))}
    </div>
  )
}

/* ═══════════ 第85轮：群管理屏（群主：改名/拉人/踢人/禁言；成员：成员表+退出群） ═══════════ */

function GroupManageSheet({ g: gInit, myDid, myName, friends, onBack, onChanged, pushToast }: {
  g: ChatGroup
  myDid: string
  myName: string
  friends: { did: string; name: string; status?: string }[]
  onBack: () => void
  onChanged: () => void
  pushToast: (t: string) => void
}) {
  const g = listGroups().find((x) => x.id === gInit.id) ?? gInit
  const isOwner = accountDidEq(g.owner ?? g.members[0], myDid)
  const [name, setName] = useState(g.name)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteDid, setInviteDid] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const act = async (label: string, f: () => Promise<unknown>) => {
    setBusy(true); setErr(null)
    try { await f(); await onChanged(); pushToast(label) }
    catch (e) { setErr(String(e).replace(/^Error:\s*/, '')) } finally { setBusy(false) }
  }
  const nameOf = (did: string): string => accountDidEq(did, myDid) ? `${myName || '我'}（我）` : (friends.find((f) => accountDidEq(f.did, did))?.name ?? `…${did.slice(-4)}`)
  const mutedNow = (did: string) => isMuted(g, did)
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 130, background: 'var(--bg,#f6f7fa)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: 'var(--card,#fff)', borderBottom: '1px solid var(--border,#e2e5ee)' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', fontSize: 15, color: 'var(--accent,#6b7bff)', cursor: 'pointer', padding: '2px 6px' }}>‹</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>⚙️ 群管理 · {g.name}</div>
          <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{g.members.length} 位成员{isOwner ? ' · 你是群主' : ''}</div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px 20px' }}>
        {/* 改群名（仅群主） */}
        {isOwner && (
          <div className="card" style={{ marginBottom: 10 }}>
            <div className="card-title" style={{ marginBottom: 6 }}>群名</div>
            <div style={{ display: 'flex', gap: 7 }}>
              <input value={name} onChange={(e) => setName(e.target.value.slice(0, 24))} style={{ ...inpS, flex: 1 }} />
              <button className="btnd" disabled={busy || !name.trim() || name === g.name}
                onClick={() => void act('群名已更新', () => groupRename(g.id, name))}>保存</button>
            </div>
          </div>
        )}
        {/* 成员列表 */}
        <div className="card" style={{ marginBottom: 10 }}>
          <div className="card-title" style={{ marginBottom: 4 }}>成员（{g.members.length}）</div>
          {g.members.map((did) => {
            const isOwnerDid = (g.owner ?? g.members[0]) === did
            const memberName = nameOf(did).replace(/（我）$/, '')
            return (
              <div key={did} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 0', borderTop: '1px solid var(--border)' }}>
                {/* 批四：头像统一——首字母圆+散列取色（列表/聊天/群管理三处同款） */}
                <span style={{ width: 26, height: 26, borderRadius: '50%', background: avatarColorOf(memberName), color: '#fff', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {(memberName || '灵').slice(0, 1)}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, color: 'var(--text)' }}>
                  {nameOf(did)}
                  {isOwnerDid && <span style={{ color: '#6b7bff', fontSize: 10.5, fontWeight: 700 }}> 群主</span>}
                  {mutedNow(did) && <span style={{ color: '#f59e0b', fontSize: 10.5, fontWeight: 700 }}> 禁言中</span>}
                </span>
                {isOwner && !accountDidEq(did, myDid) && (
                  <>
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: mutedNow(did) ? '#22c55e' : '#f59e0b', cursor: 'pointer', flexShrink: 0 }}
                      onClick={() => void act(mutedNow(did) ? '已解除禁言' : '已禁言 10 分钟', () => groupMute(g.id, did, mutedNow(did) ? 0 : Date.now() + 600_000))}>
                      {mutedNow(did) ? '解禁' : '禁言'}
                    </span>
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: '#e5534b', cursor: 'pointer', flexShrink: 0 }}
                      onClick={() => void act('已移出成员', () => groupKick(g.id, did))}>移出</span>
                  </>
                )}
              </div>
            )
          })}
          {/* 拉人（仅群主） */}
          {isOwner && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              {!inviteOpen ? (
                <button className="btn" style={{ width: '100%' }} onClick={() => setInviteOpen(true)}>＋ 拉好友进群</button>
              ) : (
                <div>
                  {friends.filter((f) => (f.status ?? 'ok') === 'ok' && !g.members.includes(f.did)).map((f) => (
                    <div key={f.did} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', cursor: 'pointer' }}
                      onClick={() => void act(`${f.name} 已加入群聊`, () => groupInvite(g.id, [f.did]))}>
                      <span style={{ width: 7, height: 7, borderRadius: 4, background: '#34d399', flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: 13.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--accent,#6b7bff)', fontWeight: 700, flexShrink: 0 }}>拉入 ›</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 7, marginTop: 6 }}>
                    <input value={inviteDid} onChange={(e) => setInviteDid(e.target.value.trim())} placeholder="或粘贴对方识别码" style={{ ...inpS, flex: 1 }} />
                    <button className="btnd" disabled={!inviteDid.startsWith('did:')}
                      onClick={() => void act('已发出邀请', () => groupInvite(g.id, [inviteDid]))}>拉入</button>
                  </div>
                  <button className="btn ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setInviteOpen(false)}>收起</button>
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 2px 10px' }}>群治理：加入即授权群主管理（owner 制；未来可选投票制）</div>
        {/* 退出群（任何人）。批二：群主=解散（名实相符——广播 group-disband，
            全体成员群会话保留只读+系统条"群已被解散"；本端同样置终态）。 */}
        <button className="btn ghost" style={{ width: '100%', color: '#e5534b', borderColor: '#e5534b55' }} disabled={busy}
          onClick={() => void act(isOwner ? '你已解散群聊' : '你已退出群聊', async () => { await groupLeave(g.id); onBack() })}>
          {isOwner ? '解散群聊并退出（全员保留历史只读）' : '退出群聊'}
        </button>
        {err && <div style={{ fontSize: 12, color: '#e5534b', marginTop: 6 }}>{err}</div>}
      </div>
    </div>
  )
}
