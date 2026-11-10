/**
 * ChatBubble — PC 好友聊天气泡（第81轮；批三 2026-09-29 全量打磨；批四 2026-09-29 实测修复）。
 * 视觉移植自 apps/phone/src/components/MessageBubble.tsx（只取气泡视觉，轻量重写）：
 *   自己=右对齐 + 主题渐变(#6b7bff→#5567f5) + 白字；他人=左对齐 + 中性卡 + 琥珀左边条；
 *   圆角 14px、气泡上方署名/时间行、连续消息紧凑。
 * 变体：text / image（点击查看器）/ file / task-share（任务卡，精美卡片视觉）/
 *       task-accept|task-done（居中系统条）/ recalled（撤回 tombstone 系统条）。
 * 批三：① 头像（Ava：首字+散列取色，三处统一）② 右键菜单（复制[选中优先]/引用/撤回/删除本地）
 *   ③ 引用回复行（点击跳原文）④ recalled tombstone 渲染 ⑤ 正文 user-select:text。
 * 批四（实测修复）：① 图片点击查看器升级=无边框全屏子窗口（缩放/平移/双击复位，
 *   开不起来时窗内全屏 overlay 兜底，见 ImgViewer.tsx）② 悬停快捷条整体删除
 *   （危险操作误触+出气泡沿引发横向滚动条闪现抖动——统一走右键菜单）
 *   ③ 右键菜单定位实测宽高 clampMenuPos 贴边翻转，不出窗不引滚动条。
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TaskLinkCard, extractTaskLink } from './TaskLinkCard'
import { avaColor, canRecall, clampMenuPos, msgCopyText, replyAnchorOf } from './chatOps'
import { ZoomPanView, openImgViewer } from './ImgViewer'
// 2026-10-23 任务卡 env（AOP 入口收敛）：卡上声明的 env（rdp/dsh/ssh/…）各一行，
// 点开 → 后端按固定口建链 + 探测 + 起客户端。**设备卡/好友卡不再挂任何直连入口**（R28）。
import { TaskEnvList } from './TaskEnvList'
// 2026-10-25 文案精简：卡面标题过 cleanCardTitle——老环境卡卡名带 127.0.0.1:端口，
// 显示时抹掉（数据不动；见 task-env.ts 的展示层去技术化）。
import { cleanCardTitle } from './task-env'

export interface ChatMsg {
  msgId: string
  from: string
  to: string
  kind: string
  payload: Record<string, unknown>
  ts: number
  dir: 'out' | 'in'
  fromName?: string
  /** 设备群（2026-10-07 设计 §3 决策D）：同账号多设备 from 恒同——行级持久化
   *  fromDevice/fromDeviceName（Rust conv 行落盘/对账 wire 原样带），署名靠它区分
   *  "哪台设备说的"；普通群/单聊不带（字段缺省走 fromName，行为不变）。 */
  fromDevice?: string
  fromDeviceName?: string
  /** 第95轮：发送状态（仅 dir=out 有）：sending=⏳ 发送中（离线队列待补发）/
   *  sent=✓ 已发送 / failed=! 失败（点按重发）。老消息无此字段=不显示徽标。 */
  sendState?: 'sending' | 'sent' | 'failed'
}

/** ── did→显示名（2026-09-29 用户实测反馈立法：任何位置不显示全称 did）── */

/** 短 did：…尾4（58 字符全称没人看）。 */
export const tail4Of = (s: string): string => `…${(s || '').trim().slice(-4)}`

/** 护栏：名称字段若本身是全称 did（服务器/对端可能塞进来），压成 …尾4。 */
export function shortDid(name: string): string {
  const t = (name || '').trim()
  return t.startsWith('did:') ? `…${t.slice(-4)}` : t
}

/** did/convId → 显示名，优先级：好友昵称 > 名称字段（会话 title/群名兜底）> …尾4。
 *  convId 兼容 did_safe 的下划线形式（:_ → 什么形式都能命中好友表）；
 *  名称本身是全称 did（对端脏数据）=「无昵称」，跳过取下一级——绝不显示全称。 */
export function dispNameOf(didOrConvId: string, friends: { did: string; name?: string }[], fallbackName?: string): string {
  const norm = (didOrConvId || '').trim().replace(/_/g, ':')
  const hit = friends.find((f) => (f.did || '').trim() === norm)
  const isName = (s: string | undefined) => { const t = (s || '').trim(); return t && !t.startsWith('did:') ? t : '' }
  return isName(hit?.name) || isName(fallbackName) || tail4Of(norm)
}

/** 时间分级（对齐 phone fmtBubbleTime：今天→时分；昨天；本年→月日；跨年→全日期）。 */
export function fmtTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  const yest = new Date(now); yest.setDate(now.getDate() - 1)
  if (d.toDateString() === now.toDateString()) return hm
  if (d.toDateString() === yest.toDateString()) return `昨天 ${hm}`
  if (d.getFullYear() === now.getFullYear()) return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}`
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}`
}

/** 任务卡是否过期（卡生命周期）。 */
export function taskExpired(m: ChatMsg): boolean {
  const exp = (m.payload as { expiresAt?: number }).expiresAt
  return !!exp && exp < Date.now()
}

/** 第83轮：参与方类型（分享=owner / 接受=member；status='done' 已标记完成）。 */
export interface TaskParticipant { did: string; name?: string; role?: string; status?: string; acceptedAt?: number; doneAt?: number }

/** 批三：统一头像（首字圆+散列取色——会话列表/聊天/群管理三处一致；palette 与
 *  手机 SessionList.avaColor 同源，见 chatOps.avaColor）。 */
export function Ava({ name, size = 28, square }: { name: string; size?: number; square?: boolean }) {
  const t = (name || '灵').trim() || '灵'
  return (
    <span style={{
      width: size, height: size, borderRadius: square ? Math.round(size * 0.3) : '50%', flexShrink: 0,
      background: avaColor(t), color: '#fff', fontSize: Math.round(size * 0.46), fontWeight: 700,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', userSelect: 'none',
    }}>{t.slice(0, 1).toUpperCase()}</span>
  )
}

/** 第83轮：参与方头像圈（首字圆形并排，最多 4 个 +N）——卡/详情/任务行共用。
 * owner=主题蓝、member=琥珀、已完成=绿（协作进度的颜色语言）。 */
export function ParticipantsAvatars({ participants, size = 16 }: { participants?: TaskParticipant[]; size?: number }) {
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
      {ps.length > 4 && <span style={{ fontSize: Math.round(size * 0.62), color: 'var(--muted,#8a93a8)', marginLeft: 4, fontWeight: 700 }}>+{ps.length - 4}</span>}
    </span>
  )
}

/* ── 任务卡气泡（用户要求"精美"：左渐变竖条 + 标题粗体 + 参与方头像 + 底部操作条）── */
function TaskCard({ m, mine, onOpen }: { m: ChatMsg; mine: boolean; onOpen?: (m: ChatMsg) => void }) {
  // 2026-10-09 任务卡跨设备同步：设备群同步的卡把卡片本体放在 payload.card
  // （与群任务卡 payload 平铺契约不同）——两形态取下同一个"卡面"，缺 card 时行为不变。
  const card = (m.payload as { card?: Record<string, unknown> }).card
  const p = { ...(m.payload as Record<string, unknown>), ...(card ?? {}) } as
    { title?: string; desc?: string; fromName?: string; reward?: string; expiresAt?: number; participants?: TaskParticipant[]; sourceDeviceName?: string }
  const expired = taskExpired(m)
  return (
    <div
      onClick={() => (onOpen ? onOpen(m) : undefined)}
      style={{
        /* 2026-10-13 修（用户截图：卡片右下角压到「我」头像）：PC 端一直写死 width:236，
            而气泡行内容 wrapper 有 maxWidth:78% —— 窄窗（320 CSS px）时 78%≈230px，
            236px 的卡从 wrapper 右缘溢出、正好垫到头像下面。补 maxWidth:100% 让卡
            收敛进 wrapper（手机端当时已修，PC 漏网）。 */
        width: 236, maxWidth: '100%', borderRadius: 12, overflow: 'hidden', cursor: onOpen ? 'pointer' : 'default',
        background: expired ? 'var(--surface-2, #f1f3f8)' : 'linear-gradient(160deg, #f6f7ff 0%, #eef1fd 100%)',
        border: `1px solid ${expired ? '#d5d9e2' : '#c9d0f5'}`,
        boxShadow: expired ? 'none' : '0 4px 14px rgba(107,123,255,.16)',
        opacity: expired ? 0.62 : 1,
        filter: expired ? 'grayscale(.7)' : 'none',
        transition: 'transform .12s',
      }}
      onMouseEnter={(e) => { if (!expired) e.currentTarget.style.transform = 'translateY(-1px)' }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'none' }}
      onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(.98)' }}
      onMouseUp={(e) => { e.currentTarget.style.transform = 'none' }}
    >
      {/* 左渐变竖条（主题色系角标视觉） */}
      <div style={{ height: 4, background: expired ? '#9aa3b8' : 'linear-gradient(90deg,#6b7bff,#4ec9a5)' }} />
      <div style={{ padding: '9px 11px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 6px', borderRadius: 6, background: expired ? '#eceff4' : 'rgba(107,123,255,.14)', color: expired ? '#8a93a8' : '#4338ca', letterSpacing: .3 }}>📋 任务卡</span>
          {p.reward && !expired && (
            <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 6px', borderRadius: 6, background: 'rgba(245,158,11,.14)', color: '#b45309' }}>奖励 {p.reward}</span>
          )}
          {expired && <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 6px', borderRadius: 6, background: '#eceff4', color: '#8a93a8' }}>已过期</span>}
        </div>
        <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--tx, #1c2333)', lineHeight: 1.4 }}>{cleanCardTitle(p.title || '') || '任务'}</div>
        {p.desc && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.desc}</div>}
        {/* 第83轮：参与方头像圈 + 来自（多人协作可见） */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7, minWidth: 0 }}>
          <ParticipantsAvatars participants={p.participants} size={14} />
          <span style={{ fontSize: 10.5, color: '#8a93a8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {mine ? '我分享的' : `来自 ${shortDid(p.fromName || '') || '好友'}`}{p.participants && p.participants.length > 1 ? ` · ${p.participants.length} 人一起` : ''}{p.sourceDeviceName ? ` · 💻 ${p.sourceDeviceName}` : ''}
          </span>
        </div>
      </div>
      {/* 第83轮：底部操作条——"不知道能点"的显式暗示（整卡可点，这里给出主行动词） */}
      <div style={{
        padding: '6px 11px',
        background: expired ? '#eceff4' : 'linear-gradient(90deg, rgba(107,123,255,.13), rgba(78,201,165,.15))',
        borderTop: `1px solid ${expired ? '#d5d9e2' : 'rgba(107,123,255,.22)'}`,
        textAlign: 'center', fontSize: 11.5, fontWeight: 800, letterSpacing: .2,
        color: expired ? '#8a93a8' : '#4338ca',
      }}>
        {expired ? '已失效' : mine ? '查看分享详情 ›' : '🤝 一起做 · 点开查看 ›'}
      </div>
    </div>
  )
}

/* ── 图片（内嵌 + 点击查看器：无边框全屏子窗口优先，窗内全屏 overlay 兜底）── */
function ImgView({ src, name }: { src: string; name?: string }) {
  const [fallback, setFallback] = useState(false) // 子窗口开不起来时的窗内全屏兜底
  const url = src.startsWith('data:') ? src : `data:image/*;base64,${src}`
  const open = () => {
    void openImgViewer(url, name).then((ok) => { if (!ok) setFallback(true) })
  }
  return (
    <>
      <img src={url} alt={name || '图片'} onClick={open}
        style={{ maxWidth: 210, maxHeight: 170, borderRadius: 10, display: 'block', cursor: 'zoom-in' }} />
      {fallback && createPortal(
        <ZoomPanView url={url} name={name} onClose={() => setFallback(false)} />,
        document.body,
      )}
    </>
  )
}

/** 第94轮：文件大小格式化（与手机端 chat-store.fmtFileSize 同款，单测在手机侧）。 */
export function fmtFileSize(bytes?: number): string {
  const n = Number(bytes) || 0
  if (n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/** 第94轮：文件类型图标（常见类型给彩色徽章，其余通用 📎）。 */
export function fileIconOf(name?: string, mime?: string): { emoji: string; bg: string } {
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

/* ── 第94轮：文件卡气泡（文件名+大小+类型图标；点击=系统默认程序打开）── */
function FileCard({ m, mine, onOpenFile }: { m: ChatMsg; mine: boolean; onOpenFile?: (m: ChatMsg) => void }) {
  const p = m.payload as { name?: string; mime?: string; size?: number }
  const size = fmtFileSize(p.size)
  const ic = fileIconOf(p.name, p.mime)
  return (
    <div onClick={() => onOpenFile?.(m)}
      title="点击用系统默认程序打开"
      style={{
        display: 'flex', alignItems: 'center', gap: 9, minWidth: 168, maxWidth: 224,
        padding: '8px 10px', borderRadius: 10, cursor: 'pointer',
        background: mine ? 'rgba(255,255,255,.14)' : 'var(--surface-2, #f6f7fa)',
        border: `1px solid ${mine ? 'rgba(255,255,255,.25)' : 'var(--bd, #e2e5ee)'}`,
      }}>
      <span style={{
        width: 34, height: 34, borderRadius: 9, flexShrink: 0, fontSize: 17,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: ic.bg,
      }}>{ic.emoji}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{
          display: 'block', fontSize: 12.5, fontWeight: 700, lineHeight: 1.35,
          color: mine ? '#fff' : 'var(--tx, #1c2333)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{p.name || '文件'}</span>
        <span style={{
          display: 'block', fontSize: 10.5, marginTop: 1,
          color: mine ? 'rgba(255,255,255,.72)' : 'var(--muted, #8a93a8)',
        }}>{size || '文件'} · 点击打开</span>
      </span>
    </div>
  )
}

/* ═══ 批三：气泡右键菜单/悬停操作条（aop ChatView 右键复制方案的菜单化演进） ═══ */

export interface MsgAction { key: string; label: string; danger?: boolean; run: () => void; keepOpen?: boolean }

/** 右键菜单（portal 固定坐标；点击任意处/滚动/Esc 关闭）。会话行菜单复用本组件。
 *  2026-09-29 实测修法：定位不再靠估算——首帧隐形容纳渲染，useLayoutEffect 用
 *  getBoundingClientRect 量真实宽高后 clampMenuPos 贴边翻转（出窗=0、不引滚动条）；
 *  position:fixed 挂 body，不占文档流，显示/隐藏零布局位移（抖动根治）。 */
export function CtxMenu({ x, y, actions, onClose }: { x: number; y: number; actions: MsgAction[]; onClose: () => void }) {
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
      position: 'fixed', left: pos?.x ?? x, top: pos?.y ?? y, zIndex: 400, minWidth: 116, maxWidth: 200, padding: '4px',
      visibility: pos ? 'visible' : 'hidden',
      background: 'var(--chrome-bg,#fff)', border: '1px solid var(--bd,#e2e5ee)', borderRadius: 10,
      boxShadow: '0 10px 30px rgba(8,12,20,.22)',
    }}>
      {actions.map((a) => (
        // keepOpen：动作执行后**不关菜单**——给"原地二次确认"用（第一次点击只改文案/上膛，
        // 第二次再执行并关闭）。默认行为不变（run 后关闭）。2026-10-06 用户实测：
        // 原先二次确认只能"重开菜单再点"，不直观。
        <div key={a.key} onClick={() => { a.run(); if (!a.keepOpen) onClose() }} style={{
          padding: '6px 12px', fontSize: 12.5, borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap',
          color: a.danger ? '#e5534b' : 'var(--tx,#1c2333)',
        }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--hover,#f2f4fa)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
          {a.label}
        </div>
      ))}
    </div>,
    document.body,
  )
}

/** 复制（选中优先——aop ChatView 语义：有选中复制选中，无选中复制整条）+ 浮条提示。 */
function copyMsgText(m: ChatMsg, done: () => void): void {
  const sel = (window.getSelection()?.toString() ?? '').trim()
  const text = sel || msgCopyText(m)
  if (!text) return
  const fallback = () => {
    const ta = document.createElement('textarea')
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy'); done() } catch { /* 复制失败静默 */ }
    ta.remove()
  }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(fallback)
  else fallback()
}

/** 气泡署名（纯函数，2026-10-07 抽出可测）：自己=「我」；他人优先 fromDeviceName
 *  （设备群 in 行——决策 D.3，本机设备消息 dir 已由 Rust effective_dir 判 out=「我」），
 *  缺省走 fromName（普通群/单聊既有行为），全称 did 一律压 …尾4（护栏沿用）。 */
export function bubbleSenderName(m: ChatMsg): string {
  if (m.dir === 'out') return '我'
  const devName = (m.fromDeviceName || '').trim()
  const name = devName || (m.fromName || '').trim()
  return shortDid(name) || `…${(m.from || '').slice(-4)}`
}

/** 小灵官方通知卡（2026-10-20）：结构化通知（标题+正文+一个 action）——不是裸文本。
 *  只读语义：用户不在 myco 里回复，点 action 走系统浏览器到平台（陈词在平台匿名评论区写）。
 *  数据来自 Rust `official-notice` 行（已验签），payload: {title, body, action:{label,url}, category}。 */
function OfficialNoticeCard({ m, onOpenUrl }: { m: ChatMsg; onOpenUrl?: (url: string) => void }) {
  const p = m.payload as {
    title?: string; body?: string; category?: string
    action?: { label?: string; url?: string }
    meta?: { caseId?: string; taskId?: string; itemId?: string; deadlineAt?: number; phase?: string }
  }
  const [copied, setCopied] = useState(false)
  const url = (p.action?.url || '').trim()
  const label = (p.action?.label || '打开').trim()
  const meta = p.meta || {}
  // 2026-10-20 用户反馈：陈词邀请应按「有灵任务卡」呈现（标题/截止/主按钮/复制链接），
  // 而不是普通通知文本卡。判定：category=appeal.statement.invite 或 meta.phase=statement。
  const isTask = p.category === 'appeal.statement.invite' || meta.phase === 'statement'
  const copy = () => {
    if (!url) return
    const done = () => { setCopied(true); window.setTimeout(() => setCopied(false), 1200) }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done).catch(done)
    else done()
  }
  let deadlineText = ''
  if (isTask && meta.deadlineAt) {
    const left = Number(meta.deadlineAt) - Date.now()
    deadlineText = left > 0 ? `剩余 ${Math.floor(left / 3600000)}h ${Math.floor((left % 3600000) / 60000)}m` : '已到期'
  }
  if (isTask) {
    return (
      <div data-official-notice data-official-variant="task" style={{
        width: 'min(430px, 100%)', borderRadius: 14, overflow: 'hidden',
        border: '1px solid rgba(22,119,255,.25)', background: 'linear-gradient(180deg,#ffffff,#f2f7ff)',
        boxShadow: '0 8px 22px rgba(22,119,255,.12)',
      }}>
        <div style={{
          padding: '9px 14px', background: 'linear-gradient(135deg,#1677ff,#0958d9)', color: '#fff',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ width: 18, height: 18, borderRadius: 5, background: 'rgba(255,255,255,.22)', fontSize: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>灵</span>
          <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: .4 }}>有灵任务 · 陈词邀请</span>
          {deadlineText ? (
            <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 8, background: 'rgba(255,255,255,.2)' }}>⏳ {deadlineText}</span>
          ) : null}
        </div>
        <div style={{ padding: '12px 14px 4px' }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#0f1e33', lineHeight: 1.45, marginBottom: 6 }}>{p.title || '任务'}</div>
          <div style={{ fontSize: 13, lineHeight: 1.7, color: '#33415c', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{p.body || ''}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0 2px' }}>
            {meta.caseId && <span style={{ fontSize: 10.5, color: '#1677ff', background: '#1677ff14', borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>案件 {String(meta.caseId)}</span>}
            {meta.taskId && <span style={{ fontSize: 10.5, color: '#3a4560', background: 'rgba(100,116,139,.10)', borderRadius: 6, padding: '2px 8px' }}>题目 {String(meta.taskId)}</span>}
            {meta.itemId && <span style={{ fontSize: 10.5, color: '#3a4560', background: 'rgba(100,116,139,.10)', borderRadius: 6, padding: '2px 8px' }}>条目 {String(meta.itemId)}</span>}
          </div>
        </div>
        <div style={{ padding: '8px 14px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {url && (
              <button data-official-action onClick={() => onOpenUrl?.(url)} title={url}
                style={{ border: 'none', borderRadius: 9, padding: '8px 16px', fontSize: 13, fontWeight: 800, color: '#fff', background: 'linear-gradient(135deg,#1677ff,#0958d9)', cursor: 'pointer' }}>{label} →</button>
            )}
            {url && (
              <button onClick={copy} style={{ border: '1px solid #cddcf5', background: '#fff', borderRadius: 9, padding: '7px 12px', fontSize: 12, fontWeight: 700, color: '#1677ff', cursor: 'pointer' }}>{copied ? '已复制 ✓' : '复制链接'}</button>
            )}
          </div>
          {url && <div title={url} style={{ marginTop: 8, fontSize: 10.5, color: '#7c8aa5', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>🔗 {url}</div>}
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted,#8a93a8)' }}>陈词须在平台匿名评论区提交（小灵仅用于通知）</div>
        </div>
      </div>
    )
  }
  return (
    <div data-official-notice style={{
      width: 'min(430px, 100%)', border: '1px solid #dfe6ff', borderRadius: 14, overflow: 'hidden',
      background: 'linear-gradient(180deg,#ffffff,#f6f8ff)', boxShadow: '0 8px 22px rgba(80,100,255,.10)',
    }}>
      <div style={{
        padding: '9px 14px', background: 'linear-gradient(135deg,#6b7bff,#5567f5)', color: '#fff',
        fontSize: 11.5, fontWeight: 800, letterSpacing: .4, display: 'flex', alignItems: 'center', gap: 6,
      }}>🔔 小灵 · 官方通知</div>
      <div style={{ padding: '12px 14px 4px' }}>
        <div style={{ fontSize: 14.5, fontWeight: 800, color: '#1f2a44', lineHeight: 1.45, marginBottom: 6 }}>
          {p.title || '通知'}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.7, color: '#3a4560', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {p.body || ''}
        </div>
      </div>
      <div style={{ padding: '6px 14px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
        {url && (
          <button data-official-action onClick={() => onOpenUrl?.(url)} title={url}
            style={{ border: 'none', borderRadius: 9, padding: '7px 14px', fontSize: 13, fontWeight: 700, color: '#fff', background: 'linear-gradient(135deg,#6b7bff,#5567f5)', cursor: 'pointer' }}>{label} →</button>
        )}
        <span style={{ fontSize: 11, color: 'var(--muted,#8a93a8)' }}>官方通知，仅在此查看</span>
      </div>
    </div>
  )
}

function ChatBubbleImpl({ m, myDid, prevSameSender, onOpenTask, onOpenFile, onRetry, onQuote, onDelete, onRecall, onJumpMsg, onOpenUrl }: {
  m: ChatMsg
  myDid: string
  /** 与上一条同人（连续消息不重复署名/时间，群聊惯例；批三=buildTimeline 的 merged） */
  prevSameSender?: boolean
  onOpenTask?: (m: ChatMsg) => void
  /** 第94轮：文件卡点击——系统默认程序打开（chat_open_file）。 */
  onOpenFile?: (m: ChatMsg) => void
  /** 第95轮：失败消息点按重发（chat_retry_msg）。 */
  onRetry?: (m: ChatMsg) => void
  /** 批三：引用回复（payload.replyTo 锚写入下一条发出的消息）。 */
  onQuote?: (m: ChatMsg) => void
  /** 批三：删除本地记录（chat_delete_msg；不影响对端）。 */
  onDelete?: (m: ChatMsg) => void
  /** 批三：撤回（chat_recall_msg；2min 窗口由 canRecall 与 Rust 双闸）。 */
  onRecall?: (m: ChatMsg) => void
  /** 批三：引用行点击 → 跳到原文气泡（scrollIntoView + 高亮闪）。 */
  onJumpMsg?: (msgId: string) => void
  /** 2026-10-20：打开外部 URL（小灵通知卡 action；系统默认浏览器）。 */
  onOpenUrl?: (url: string) => void
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const mine = m.dir === 'out'
  const time = fmtTime(m.ts)
  // 2026-09-29：署名护栏——fromName 若是对端塞进来的全称 did，压成 …尾4（不显示全称）。
  // 2026-10-07：抽出 bubbleSenderName（设备群 in 行按 fromDeviceName 署名，决策 D.3）。
  const senderName = bubbleSenderName(m)
  // 批三：头像显示名（自己=我；对方=署名）——Ava 散列取色按名定色，同名人同色
  const avaName = mine ? '我' : senderName

  // 系统条：sys（好友关系变更等）+ 任务回执（词表对齐 HBL：claim/submit——文案人话，机器字段在 payload）
  if (m.kind === 'sys') {
    const text = (m.payload as { text?: string }).text || ''
    return (
      <div id={`msg-${m.msgId}`} style={{ textAlign: 'center', margin: '6px 0', fontSize: 11, color: 'var(--muted, #8a93a8)' }}>
        <span style={{ background: 'rgba(52,211,153,.10)', padding: '2px 10px', borderRadius: 8 }}>🤝 {text} · {time}</span>
      </div>
    )
  }
  // 批二（2026-09-28）：group-create 落群会话（对账载体——离线成员补齐真 owner 的凭据），
  // 渲染为"群已创建"系统条；群解散/被踢的提示由 ingest 落 sys 条承载（词表不扩散到气泡）。
  if (m.kind === 'group-create') {
    const gname = (m.payload as { groupName?: string }).groupName || '群'
    return (
      <div style={{ textAlign: 'center', margin: '6px 0', fontSize: 11, color: 'var(--muted, #8a93a8)' }}>
        <span style={{ background: 'rgba(52,211,153,.10)', padding: '2px 10px', borderRadius: 8 }}>🎉 群「{gname}」已创建 · {time}</span>
      </div>
    )
  }
  if (m.kind === 'task-accept' || m.kind === 'task-done') {
    const p = m.payload as { title?: string; name?: string }
    const title = p.title || '任务'
    // 第83轮：带 name（接受/完成者）→"一起"语系（温馨协作感）
    const text = m.kind === 'task-accept'
      ? (p.name ? `🤝 ${p.name} 一起接了任务《${title}》` : `✓ 已接受任务《${title}》`)
      : (p.name ? `🎉 ${p.name} 完成了任务《${title}》` : `✓ 已完成任务《${title}》`)
    return (
      <div id={`msg-${m.msgId}`} style={{ textAlign: 'center', margin: '6px 0', fontSize: 11, color: 'var(--muted, #8a93a8)' }}>
        <span style={{ background: 'rgba(107,123,255,.08)', padding: '2px 10px', borderRadius: 8 }}>{text} · {time}</span>
      </div>
    )
  }
  // 2026-10-11 任务卡改名留痕条（owner 广播的标题终局同步；任务库更新在 Rust ingest 已做）
  if (m.kind === 'task-rename') {
    const p = m.payload as { title?: string }
    const text = m.dir === 'out'
      ? `✏️ 你把任务卡改名为「${p.title || ''}」`
      : `✏️ ${senderName || '对方'} 把任务卡改名为「${p.title || ''}」`
    return (
      <div id={`msg-${m.msgId}`} style={{ textAlign: 'center', margin: '6px 0', fontSize: 11, color: 'var(--muted, #8a93a8)' }}>
        <span style={{ background: 'rgba(107,123,255,.08)', padding: '2px 10px', borderRadius: 8 }}>{text} · {time}</span>
      </div>
    )
  }
  // 批三：撤回 tombstone（kind="recalled"——Rust 双侧同写法；"xxx 撤回了一条消息"系统条）
  if (m.kind === 'recalled') {
    return (
      <div id={`msg-${m.msgId}`} style={{ textAlign: 'center', margin: '6px 0', fontSize: 11, color: 'var(--muted, #8a93a8)' }}>
        <span style={{ background: 'rgba(148,163,184,.12)', padding: '2px 10px', borderRadius: 8 }}>
          {mine ? '你' : senderName}撤回了一条消息 · {time}
        </span>
      </div>
    )
  }

  const body = (() => {
    const p = m.payload as { text?: string; b64?: string; name?: string; mime?: string; size?: number; title?: string }
    // 2026-10-20 小灵官方通知：结构化卡（只读 + action 打开平台）
    if (m.kind === 'official-notice') return <OfficialNoticeCard m={m} onOpenUrl={onOpenUrl} />
    if (m.kind === 'task-share') {
      // 2026-10-23 任务卡 env：卡上 `env[]`（rdp / dsh / ssh / http / stereo / adb）逐行渲染；
      // 老分享卡没有 env 时按 sourceDevice 派生一条 rdp（**入口仍来自卡**，不是设备卡）。
      const card = (m.payload as { card?: Record<string, unknown> }).card
      const flat = { ...(m.payload as Record<string, unknown>), ...(card ?? {}) }
      /* 2026-10-23 真机 bug：卡上有 env 时，**点卡身**会走 onOpenTask 打开底层分享入口
         （点【PC远程桌面】卡 → 打开的是 DSH web 全量会话）。有 env 的卡：卡身只负责展示，
         入口一律走下方 env 行（AOP：env 才是能力入口）。无 env 的老卡保持原行为。 */
      const envArr = (flat as { env?: unknown[] }).env
      const hasEnv = Array.isArray(envArr) && envArr.length > 0
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start' }}>
          <TaskCard m={m} mine={mine} onOpen={hasEnv ? undefined : onOpenTask} />
          {hasEnv && !mine && (
            <div style={{ fontSize: 11, color: 'var(--muted, #8a93a8)', margin: '2px 2px 4px' }}>
              从下方环境打开 ↓
            </div>
          )}
          {/* 自己发的卡不挂：env 的目标是"对面那台"，自己的卡没有对面 */}
          {!mine && <TaskEnvList card={flat} />}
        </div>
      )
    }
    if (m.kind === 'image' && p.b64) return <ImgView src={p.b64} name={p.name} />
    if (m.kind === 'image') {
      // 有 media 无 b64（本地媒体被清）——降级文件卡仍可打开看
      return <FileCard m={m} mine={mine} onOpenFile={onOpenFile} />
    }
    if (m.kind === 'file') return <FileCard m={m} mine={mine} onOpenFile={onOpenFile} />
    // 第87轮：文本里的 youling 任务链接自动变卡片
    const link = extractTaskLink(p.text || '')
    if (link) return <TaskLinkCard url={link} />
    // 批三：正文可选中（右键复制选中优先链路的前提）
    return <div className="msg-body" style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text' }}>{p.text || ''}</div>
  })()

  // 批三：引用锚（本条是对某条的回复 → 气泡内嵌一行摘要，点击跳原文）
  const anchor = replyAnchorOf(m)

  // 批三：操作集（右键菜单与悬停条共用；撤回=2min 窗口双闸的 UI 闸）
  const flashCopied = () => { setCopied(true); window.setTimeout(() => setCopied(false), 1200) }
  const actions: MsgAction[] = []
  if (msgCopyText(m)) actions.push({ key: 'copy', label: '复制', run: () => copyMsgText(m, flashCopied) })
  if (onQuote) actions.push({ key: 'quote', label: '引用', run: () => onQuote(m) })
  if (onRecall && canRecall(m)) actions.push({ key: 'recall', label: '撤回', run: () => onRecall(m) })
  if (onDelete) actions.push({ key: 'delete', label: '删除（本地）', danger: true, run: () => onDelete(m) })

  // 气泡容器：自己=右（渐变白字），他人=左（中性卡琥珀边）
  return (
    <div id={`msg-${m.msgId}`} style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', margin: prevSameSender ? '2px 0' : '8px 0' }}>
      {!prevSameSender && (
        <div style={{ fontSize: 10.5, color: 'var(--muted, #8a93a8)', margin: '0 4px 3px', display: 'flex', gap: 6, alignItems: 'center', ...(mine ? { flexDirection: 'row-reverse' } : {}) }}>
          <span style={{ fontWeight: 700 }}>{senderName}</span>
          {time && <span>{time}</span>}
        </div>
      )}
      {/* 批三：头像+气泡横排（自己头像在右）；连续消息头像位留空对齐。
          右键/悬停挂在整行且行必须全宽（width:100%）——父列 alignItems:flex-end
          会让子行 shrink-to-fit，行内空白处右键无响应（headless 实测捕获）。 */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 7, width: '100%', maxWidth: '100%', ...(mine ? { flexDirection: 'row-reverse' } : {}) }}
        onContextMenu={(e) => {
          if (!actions.length) return
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}>
        {prevSameSender
          ? <span style={{ width: 30, flexShrink: 0 }} />
          : <Ava name={avaName} size={30} />}
        <div style={{ position: 'relative', maxWidth: '78%' }}>
          <div style={{
            borderRadius: 14,
            borderTopLeftRadius: !mine && prevSameSender ? 6 : 14,
            borderTopRightRadius: mine && prevSameSender ? 6 : 14,
            padding: m.kind === 'task-share' ? 0 : '8px 12px',
            background: mine ? 'linear-gradient(135deg,#6b7bff,#5567f5)' : 'var(--surface, #fff)',
            border: mine ? 'none' : '1px solid var(--bd, #e2e5ee)',
            borderLeft: mine ? undefined : '3px solid #d97706',
            color: mine ? '#fff' : 'var(--tx, #1c2333)',
            boxShadow: mine ? '0 4px 14px rgba(107,123,255,.28)' : '0 2px 10px rgba(22,30,60,.05)',
            // 第95轮：发送中/失败的消息气泡降饱和——状态未确认的视觉语义
            opacity: mine && m.sendState === 'sending' ? 0.82 : 1,
          }}>
            {/* 批三：引用行（气泡内嵌摘要；点击跳原文位置） */}
            {anchor && (
              <div onClick={(e) => { e.stopPropagation(); onJumpMsg?.(anchor.msgId) }}
                title="点击跳到原文"
                style={{
                  marginBottom: 6, padding: '4px 8px', borderRadius: 7, fontSize: 11, lineHeight: 1.5,
                  cursor: onJumpMsg ? 'pointer' : 'default',
                  background: mine ? 'rgba(255,255,255,.16)' : 'var(--surface-2,#f1f3f8)',
                  borderLeft: `2.5px solid ${mine ? 'rgba(255,255,255,.6)' : '#6b7bff'}`,
                  color: mine ? 'rgba(255,255,255,.88)' : 'var(--muted,#8a93a8)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                <b>{anchor.name}</b>: {anchor.text}
              </div>
            )}
            {body}
          </div>
          {/* 批四（2026-09-29 实测修法）：悬停快捷条整体删除——危险操作（删除/撤回）曾在一级
              悬停条易误触，且条子绝对定位出气泡顶/右沿会让滚动容器横向滚动条闪现+窗口抖动。
              现统一走右键菜单（全量：复制/引用/撤回/删除本地，clamp 不出窗），对齐微信桌面端。 */}
          {/* 批三：已复制浮条（1.2s 自消） */}
          {copied && (
            <div style={{
              position: 'absolute', top: -26, left: '50%', transform: 'translateX(-50%)', zIndex: 31,
              padding: '3px 10px', borderRadius: 7, background: 'rgba(30,35,50,.92)', color: '#fff',
              fontSize: 11, whiteSpace: 'nowrap',
            }}>✓ 已复制</div>
          )}
        </div>
      </div>
      {/* 2026-10-18 聊天微信化（M11）：发送状态只留三种极小符号——⏳（本机已收待确认）/
          ✓（已投递）/ !（失败，点一下重发）。不渲染任何过程文字（"发送中/已送达/未送达
          ·点击重发"等一律不进界面，解释只放 title 悬停看）。仅自己的新消息显示。 */}
      {mine && m.sendState && (
        <div style={{ margin: '2px 4px 0', fontSize: 10, lineHeight: 1, display: 'flex', alignItems: 'center', gap: 4 }}>
          {m.sendState === 'sending' && (
            <span title="已在本机收下，对方上线后自动送达" style={{ color: 'var(--muted, #8a93a8)' }}>⏳</span>
          )}
          {m.sendState !== 'sending' && m.sendState !== 'failed' && (
            <span title="对方设备已收到" style={{ color: 'var(--muted, #8a93a8)' }}>✓</span>
          )}
          {m.sendState === 'failed' && (
            <span onClick={() => onRetry?.(m)} title="没发出去——点一下重发"
              style={{ color: '#e5534b', fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#e5534b', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9 }}>!</span>
            </span>
          )}
        </div>
      )}
      {/* 批三：右键菜单（portal） */}
      {menu && <CtxMenu x={menu.x} y={menu.y} actions={actions} onClose={() => setMenu(null)} />}
    </div>
  )
}

export const ChatBubble = memo(ChatBubbleImpl)
