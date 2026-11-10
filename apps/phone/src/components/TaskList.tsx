/**
 * TaskList — 任务页（连上主设备后的一级列表）：项目 → 任务（跟 AOP 工作区同构）。
 * 2026-09-04 设计定稿：与 PC myco 驾驶舱同脸呈现（同一数据源 env /api/tasks_board），
 * 不再按设备/任务卡片分层——关注任务本身。任务行=状态点(活/已关)+目标红黄绿灯徽标；
 * 点活任务直达聊天视图（旧列表点"项目任务"进工作区的体验保留）；已关任务点它→去
 * PC 工作区重开（提示）。风格对齐旧版清爽列表（紧凑行、白底、细分隔线、蓝 accent）。
 * 只读：任务的创建/改名在 PC 工作区做（名唯一闸在那边）。
 */
import { useEffect, useMemo, useState } from 'react'
import { type Transport, type SessionInfo, type AuthInfo, type TasksBoard, type BoardGoal } from '../transport'
import { DesktopView } from './DesktopView'
import { TodoCard } from './TodoCard'
import { YoulingLogin } from './YoulingLogin'
// 第81轮：好友分享任务（peer 来源徽章）+ 任务分享源桥（渲染层只读）
import { PeerTasksSection } from './FriendsPanel'
import { setBoardTasks } from '../chat-store'
// 第88轮：youling 平台 ENV 感知面（领取任务同步显示 + 我的能力值视图）
import { fetchYoulingTasks, fetchMyResume, MODE_LABEL, ROLE_LABEL, fmtPct, type YoulingTask, type MyResume as MyResumeData, type AbilityRow, YoulingApiError } from '../youling-tasks'
import { MyResume } from './MyResume'
import { EXPLORE_URL } from '../identity'
import { openExplore, openExternal } from '../explore'

/** 授权剩余徽标文案（与 SessionList 同款：无限期不显示）。 */
function useAuthLeft(transport: Transport): string {
  const [auth, setAuth] = useState<AuthInfo | null>(null)
  useEffect(() => {
    if (!transport.authInfo) return
    const load = () => void transport.authInfo!().then(setAuth).catch(() => {})
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [transport])
  if (!auth?.authExpiresAt) return ''
  const left = auth.authExpiresAt - Date.now()
  if (left <= 0) return '授权已到期'
  const mins = Math.ceil(left / 60_000)
  return mins >= 60 ? `授权剩 ${Math.floor(mins / 60)} 小时${mins % 60 ? ` ${mins % 60} 分` : ''}` : `授权剩 ${mins} 分钟`
}

/** 灯三件套：圆点底色 / 徽标背景 / 徽标文字色（项目 SMART 灯与任务目标灯共用）。 */
const LIGHT_DOT: Record<string, string> = {
  red: '#ef4444', yellow: '#f59e0b', green: '#22c55e', gray: '#cbd5e1', blue: '#3b82f6',
}
const LIGHT_BG: Record<string, string> = {
  red: 'rgba(239,68,68,.10)', yellow: 'rgba(245,158,11,.10)', green: 'rgba(34,197,94,.10)', gray: 'rgba(100,116,139,.08)', blue: 'rgba(59,130,246,.10)',
}
const LIGHT_TXT: Record<string, string> = {
  red: '#b91c1c', yellow: '#b45309', green: '#15803d', gray: '#64748b', blue: '#1d4ed8',
}

/** 目标数值显示（bool=达成/未达；ratio=%；count=万/亿压缩）。 */
function goalVal(g: BoardGoal, which: 'cur' | 'target'): string {
  const n = which === 'cur' ? g.cur : g.target
  if (n == null) return '—'
  if (g.type === 'bool') return n >= 1 ? '达成' : '未达'
  if (g.type === 'ratio') return `${(n * 100).toFixed(0)}%`
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(0)}万`
  return String(Math.round(n))
}

export function TaskList({ transport, onPickSession, onDisconnect, onSettings }: {
  transport: Transport
  onPickSession: (s: SessionInfo) => void
  onDisconnect: () => void
  /** 设置 / 切换账户（2026-10-09 与 PC 对齐）：切回配对页但**不断开连接**——
   *  此前齿轮 title="设置 / 切换账户"但实为 onDisconnect（断开连接），名实不符，
   *  用户连上 PC 后切换账号/主题/设置全部不可达。现：齿轮=设置（切回配对页，transport 保留）。 */
  onSettings: () => void
}) {
  const [board, setBoard] = useState<TasksBoard | null>(null)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<string | null>(null)
  const [showDesktop, setShowDesktop] = useState(false) // 远程桌面(设备级,复用当前 WebRTC 连接)
  const [showYLLogin, setShowYLLogin] = useState(false) // 扫码登录有灵网页(spec login-design 通道①;v0.3.39 改版时入口丢失,补回)
  const [showResume, setShowResume] = useState(false) // 第88轮:我的能力值视图(全屏 overlay)
  const authLeft = useAuthLeft(transport)

  // ── 第88轮：youling 领取的任务（ENV 观察面，零本地存储）──
  // 第91轮：列表=已领取过滤后的条目（parseYoulingTasks 内过滤），空 → 空态引导
  const [yTasks, setYTasks] = useState<YoulingTask[]>([])
  const [yPhase, setYPhase] = useState<'ok' | 'no-account' | 'not-ready' | 'network' | 'http'>('ok')
  useEffect(() => {
    let cancelled = false
    const pull = () => {
      if (cancelled || document.hidden) return
      fetchYoulingTasks()
        .then((ts) => { if (!cancelled) { setYTasks(ts); setYPhase('ok') } })
        .catch((e) => { if (!cancelled) { setYTasks([]); setYPhase(e instanceof YoulingApiError ? e.kind : 'network') } })
    }
    pull() // 进任务页拉一次
    const t = setInterval(pull, 30_000) // 30s 周期（与好友区 5s 轮询分离：外网 API 不跟主列表节奏打）
    const onVis = () => { if (!document.hidden) pull() } // 回前台立即补拉
    document.addEventListener('visibilitychange', onVis)
    return () => { cancelled = true; clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [])

  // ── 第91轮：能力值卡数据（resume.abilities；拉不到=null 藏卡，[]=尚无画像）──
  const [yResume, setYResume] = useState<MyResumeData | null>(null)
  useEffect(() => {
    let cancelled = false
    const pull = () => {
      if (cancelled || document.hidden) return
      fetchMyResume()
        .then((r) => { if (!cancelled) setYResume(r) })
        .catch(() => { if (!cancelled) setYResume(null) })
    }
    pull()
    const t = setInterval(pull, 30_000) // 与任务列表同频（能力画像慢变，30s 足够新鲜）
    const onVis = () => { if (!document.hidden) pull() }
    document.addEventListener('visibilitychange', onVis)
    return () => { cancelled = true; clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [])
  // 能力值卡取值：主显 role 优先匹配领取任务对应 role（匹配不上显第一条）；目标门槛
  // 优先领取任务的门槛，无领取任务时兜底账号全局门槛（再无 → "—"）
  const claimedThreshold = yTasks.map((t) => t.threshold).find((v) => v != null) ?? yResume?.gateThreshold ?? null
  const claimedRole = yTasks.find((t) => t.role)?.role ?? ''
  const ability: AbilityRow | null = yResume == null ? null
    : (claimedRole ? yResume.abilities.find((a) => a.role === claimedRole) : undefined) ?? yResume.abilities[0] ?? null

  const load = async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [b, ss] = await Promise.all([
        (transport.tasksBoard?.() ?? Promise.resolve(null)).catch(() => null),
        transport.list(),
      ])
      setBoard(b); setSessions(ss)
      // 分享源桥（侧写扁平任务清单给好友聊天的「分享我的任务」；不动任务逻辑）
      setBoardTasks((b?.projects ?? []).flatMap((pr: { name: string; tasks?: { title?: string }[] }) => (pr.tasks ?? []).map((tk) => ({ title: tk.title || pr.name, projectName: pr.name }))))
      setError(null)
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      if (!silent) setLoading(false)
    }
  }
  // 周期轮询（5s，silent）+ 切后台暂停、回前台立即拉
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let paused = false
    const tick = async () => {
      if (paused || cancelled) return
      await load(true)
      if (!cancelled && !paused) timer = setTimeout(tick, 5000)
    }
    const onVis = () => {
      paused = document.hidden
      if (cancelled) return
      if (timer) clearTimeout(timer)
      if (!paused) tick()
    }
    const onOnline = () => { if (!cancelled) { if (timer) clearTimeout(timer); tick() } }
    load()
    timer = setTimeout(tick, 5000)
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', onOnline)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', onOnline)
    }
  }, [transport])

  // 提示条自动消（点已关任务的说明）
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(t)
  }, [toast])

  /** 点任务：活 → 直达聊天（taskKey 对位活会话，ta taskId === taskKey）；已关 → 提示。
   *  2026-09-10 根修：活而无会话（collab 管道任务天然无 ta 会话 / ta 重启后 meta 仍开）
   *  曾永远「会话正在就位」——现在按任务 mode 分派重开（与 PC 工作区同构）：
   *  collab → env /api/collab/spawn 重拉管道（已开只附着）+ 伪会话进聊天；
   *  ta → env /api/project_task_open resume（claudeSession 锚恢复原对话）。 */
  const pickTask = (p: { id: string; path: string }, t: { taskKey: string; live: boolean; mode?: string; harness?: string; title: string }) => {
    if (!t.live) { setToast('任务已关闭——在电脑端工作区点任务行重开'); return }
    const s = sessions.find((x) => x.taskId === t.taskKey)
    if (s) { onPickSession(s); return }
    if (!transport.http) { setToast('当前连接不支持远程重开——请在 PC 工作区打开'); return }
    if (t.mode === 'collab') {
      const SPAWN_HARNESS: Record<string, string> = {
        'claude-code': 'claude-pipe', 'claude-console': 'claude-pipe',
        'kimi-code': 'kimi-pipe', 'zcode': 'zcode-pipe', 'codex': 'codex-pipe',
      }
      setToast('正在重开任务…')
      void (async () => {
        try {
          // 已开只附着（spawn 会双开管道——PC 端同款闸）
          const ro = await transport.http!('GET', `/api/collab/open?cwd=${encodeURIComponent(p.path)}`)
          const open = new Set(JSON.parse(ro.b)?.open ?? [])
          if (!open.has(t.taskKey)) {
            await transport.http!('POST', '/api/collab/spawn', JSON.stringify({
              cwd: p.path, taskKey: t.taskKey,
              harness: SPAWN_HARNESS[t.harness || 'claude-code'] ?? t.harness,
              resumeOf: undefined, taskTitle: t.title,
              firstTask: '继续本任务：先一句话总结上次进展，然后等我。',
            }))
          }
          setToast(null)
          onPickSession({ sessionId: `collab:${t.taskKey}`, taskId: t.taskKey, command: 'collab', status: 'running', title: t.title, startedAt: '', cwd: p.path })
        } catch (e) {
          setToast(`重开失败：${String(e).replace(/^Error:\s*/, '').slice(0, 60)}`)
        }
      })()
      return
    }
    // ta 任务：project_task_open resume（env 查 meta 锚 --resume 恢复原对话）
    setToast('正在重开任务…')
    void (async () => {
      try {
        const r = await transport.http!('POST', '/api/project_task_open', JSON.stringify({ projectId: p.id, mode: 'resume', taskKey: t.taskKey }))
        const j = JSON.parse(r.b) as { success?: boolean; data?: SessionInfo; error?: string }
        if (j.success && j.data) {
          setToast(null)
          onPickSession({ ...j.data, cwd: p.path })
        } else {
          setToast(`重开失败：${(j.error || '未知原因').slice(0, 60)}`)
        }
      } catch (e) {
        setToast(`重开失败：${String(e).replace(/^Error:\s*/, '').slice(0, 60)}`)
      }
    })()
  }

  const projects = board?.projects ?? []
  const anyTask = useMemo(() => projects.some((p) => p.tasks.length > 0), [projects])

  return (
    <>
      <div className="topbar">
        <span className="title">任务</span>
        <span className="sub">{transport.kind === 'webrtc' ? '直连' : transport.kind === 'http' ? '局域网' : transport.kind === 'direct' ? '直连' : '样例'}</span>
        {authLeft && (
          <span style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 999, fontWeight: 600,
            background: authLeft.includes('到期') ? 'rgba(220,38,38,.12)' : 'rgba(217,119,6,.12)',
            color: authLeft.includes('到期') ? '#dc2626' : '#b45309',
          }}>{authLeft}</span>
        )}
        {transport.kind === 'webrtc' && (
          <button className="icon-btn" onClick={() => setShowDesktop(true)} title="远程桌面">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
          </button>
        )}
        {/* 扫码登录有灵网页（帮电脑网页扫码确认登录） */}
        <button className="icon-btn" onClick={() => setShowYLLogin(true)} title="扫码登录有灵网页">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8h4M7 12h2M13 8h.01M17 8h.01M13 12h4M7 16h4M14 16h3"/></svg>
        </button>
        <button className="icon-btn" onClick={() => load()} disabled={loading} title="刷新">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>
        </button>
        <button className="icon-btn" onClick={onSettings} title="设置 / 切换账户">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06.06a2 2 0 0 1 2.83 0 2 2 0 0 1 2.83 0 1 0 0 0 2.83 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </div>

      {error && (
        <div className="banner err">
          {error}
          {(error.includes('超时') || error.includes('断开')) && (
            <button onClick={onDisconnect} style={{ marginLeft: 8, fontSize: 12, color: 'var(--accent,#6b7bff)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>断开重连</button>
          )}
        </div>
      )}
      {toast && (
        <div className="banner info" style={{ fontSize: 12 }} onClick={() => setToast(null)}>{toast}</div>
      )}

      <div className="ws-list">
        {/* PM 今日待办只读卡(纲领六;transport 不支持时静默不渲染) */}
        <TodoCard transport={transport} />
        {/* 第81轮：好友分享的任务（peer 来源徽章行，本地库渲染；youling 任务零改动） */}
        <PeerTasksSection />

        {/* 第91轮：能力值紧凑卡（任务页顶）——当前 Beta 均值 / 目标门槛(SLA) / 95%CI；
            α+β<5 或无 ci95 → "样本不足"；点卡片开完整能力值视图（原底部按钮的入口职责收编于此） */}
        {yResume != null && yPhase !== 'no-account' && (
          <div className="card" style={{ marginBottom: 10, cursor: 'pointer' }} onClick={() => setShowResume(true)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="card-title" style={{ marginBottom: 0, flex: 1 }}>我的能力档案{ability ? ` · ${ROLE_LABEL[ability.role] ?? ability.role}` : ''}</span>
              <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>点开完整画像</span>
            </div>
            {ability ? (() => {
              const meanPct = ability.mean == null ? null : Math.min(100, Math.max(0, ability.mean <= 1.0001 ? ability.mean * 100 : ability.mean))
              const targetPct = claimedThreshold == null ? null : Math.min(100, Math.max(0, claimedThreshold <= 1.0001 ? claimedThreshold * 100 : claimedThreshold))
              const enough = ability.alpha + ability.beta >= 5 && ability.ci95 != null
              return (
                <>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 5, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: 'var(--text)' }}>当前 <b style={{ fontSize: 15, color: '#1677ff' }}>{meanPct == null ? '—' : `${Math.round(meanPct)}%`}</b></span>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>目标 {targetPct == null ? '—' : `${Math.round(targetPct)}%`}</span>
                    {enough && ability.ci95 ? (
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>95% CI {fmtPct(ability.ci95[0])}~{fmtPct(ability.ci95[1])}</span>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--muted)', opacity: 0.6 }}>样本不足</span>
                    )}
                  </div>
                  {/* 迷你条：mean 填充 + 目标刻度（目标缺失只画填充） */}
                  <div style={{ position: 'relative', height: 6, borderRadius: 999, background: 'rgba(22,119,255,.1)', marginTop: 7 }}>
                    {meanPct != null && (
                      <div style={{ width: `${Math.max(meanPct, 2)}%`, height: '100%', borderRadius: 999, background: 'linear-gradient(90deg,#7c5cff,#4d8dff)' }} />
                    )}
                    {targetPct != null && (
                      <div style={{ position: 'absolute', left: `calc(${Math.min(targetPct, 100)}% - 1px)`, top: -2, bottom: -2, width: 2, borderRadius: 1, background: '#e65100' }} />
                    )}
                  </div>
                </>
              )
            })() : (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>还没有能力画像——领取任务开始答题后长出</div>
            )}
          </div>
        )}

        {/* 第88轮：🌐 youling 平台领取的任务（ENV 观察面现拉；已领取过滤后列表，
            空列表给空态引导；无账号不占位，未就绪低调提示） */}
        {yPhase === 'ok' && (
          <div className="card" style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="card-title" style={{ marginBottom: 0, flex: 1 }}>我的任务</span>
              <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>点行在浏览器打开</span>
            </div>
            {yTasks.length === 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '9px 0 3px' }}>
                <span style={{ flex: '1 1 auto', fontSize: 12.5, color: 'var(--muted)' }}>还没有领取中的任务——去有灵广场看看</span>
                {/* 2026-10-15：走免登链（原裸开 myco.youling.cc——基址也错，平台页在 www） */}
                <button
                  onClick={() => void openExplore(EXPLORE_URL)}
                  style={{ flexShrink: 0, fontSize: 12, padding: '5px 12px', borderRadius: 8, border: '1px solid rgba(22,119,255,.35)', background: 'rgba(22,119,255,.06)', color: '#1677ff', fontWeight: 600, cursor: 'pointer' }}
                >去探索 →</button>
              </div>
            )}
            {yTasks.map((t) => (
              <div
                key={`${t.taskId}-${t.mode ?? ''}`}
                // 2026-10-16 修「死按钮」（审计 #6）：裸 window.open 在 APK 壳静默无效
                // （真机实证见 explore.ts openExternal 注释）——改走壳桥，浏览器退回 window.open。
                onClick={() => { if (t.url) openExternal(t.url) }}
                style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 0', borderTop: '1px solid var(--border)', cursor: 'pointer' }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 4, background: '#1677ff', flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.title}
                    {t.mode && <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 6, background: 'rgba(22,119,255,.08)', color: '#1677ff', marginLeft: 6, verticalAlign: 'baseline' }}>{MODE_LABEL[t.mode] ?? t.mode}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {(t.pendingCount != null || t.answeredToday != null) && (
                      <>{t.pendingCount != null && <>待做 {t.pendingCount}</>}{t.pendingCount != null && t.answeredToday != null && ' · '}{t.answeredToday != null && <>已答 {t.answeredToday}</>}</>
                    )}
                  </div>
                </span>
                {t.slaText && (
                  <span style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 6, background: 'rgba(22,119,255,.1)', color: '#1677ff', fontWeight: 700, flexShrink: 0 }}>{t.slaText}</span>
                )}
                <span style={{ fontSize: 11, color: '#1677ff', flexShrink: 0 }}>›</span>
              </div>
            ))}
          </div>
        )}
        {yPhase === 'not-ready' && (
          <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', padding: '6px 0 2px', marginBottom: 8, opacity: 0.75 }}>
            有灵任务同步接口尚未就绪，上线后自动显示
          </div>
        )}

        {loading && !board && <div className="banner info"><span className="spinner" /> 正在加载任务…</div>}

        {!loading && !error && projects.length === 0 && (
          <div className="ws-empty">
            <div className="big">🗂</div>
            <div>主设备上还没有项目</div>
            <div style={{ fontSize: 13, marginTop: 6 }}>在电脑端 myco 建项目、在工作区开任务，这里就会出现</div>
          </div>
        )}
        {!loading && board && projects.length > 0 && !anyTask && (
          <div className="banner info" style={{ fontSize: 12 }}>项目都在，还没有任务——在电脑端工作区点项目旁的 ▶ 开任务</div>
        )}

        {projects.map((p) => {
          const open = expanded.has(p.id)
          const liveCount = p.tasks.filter((t) => t.live).length
          return (
            <div key={p.id} style={{ borderBottom: '1px solid var(--border)', paddingBottom: open ? 4 : 0 }}>
              {/* 项目行:灯点+名称+计数,点整行折叠/展开 */}
              <div
                onClick={() => setExpanded((prev) => {
                  const next = new Set(prev)
                  if (next.has(p.id)) next.delete(p.id); else next.add(p.id)
                  return next
                })}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '12px 4px',
                  cursor: 'pointer', userSelect: 'none',
                }}
                title={p.lightNote || p.name}
              >
                <span style={{
                  width: 10, height: 10, borderRadius: 999, flexShrink: 0,
                  background: LIGHT_DOT[p.light] ?? LIGHT_DOT.gray,
                  boxShadow: p.light === 'red' ? '0 0 5px rgba(239,68,68,.45)' : 'none',
                }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>
                  {p.tasks.length > 0 ? `${p.tasks.length} 任务${liveCount > 0 ? ` · ${liveCount} 活跃` : ''}` : '无任务'}
                </span>
                <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0, width: 12, textAlign: 'center' }}>{open ? '▾' : '▸'}</span>
              </div>
              {open && p.tasks.length > 0 && (
                <div onClick={(e) => e.stopPropagation()} style={{ paddingLeft: 20 }}>
                  {p.tasks.map((t) => (
                    <div key={t.taskKey} onClick={() => pickTask(p, t)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 4px',
                        borderTop: '1px solid var(--border)',
                        opacity: t.live ? 1 : 0.6,
                        cursor: 'pointer',
                      }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: 999, flexShrink: 0,
                        background: t.live ? '#22c55e' : LIGHT_DOT.gray,
                        boxShadow: t.live ? '0 0 4px rgba(34,197,94,.5)' : 'none',
                      }} />
                      <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                      {t.goal && (
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
                          fontSize: 11, padding: '2px 8px', borderRadius: 999,
                          background: LIGHT_BG[t.goal.light] ?? LIGHT_BG.gray,
                          color: LIGHT_TXT[t.goal.light] ?? LIGHT_TXT.gray,
                        }}>
                          <span style={{ width: 6, height: 6, borderRadius: 999, background: LIGHT_DOT[t.goal.light] ?? LIGHT_DOT.gray, display: 'inline-block' }} />
                          {t.goal.key} {goalVal(t.goal, 'cur')}/{goalVal(t.goal, 'target')}
                          {t.goal.ratioPct >= 0 && ` ${t.goal.ratioPct}%`}
                        </span>
                      )}
                      <span style={{ fontSize: 11, color: t.live ? 'var(--accent,#6b7bff)' : 'var(--muted)', flexShrink: 0, minWidth: 30, textAlign: 'right' }}>
                        {t.live ? '›' : '已关'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}

        {/* 第88轮→91轮：我的能力值入口收编进顶部能力值紧凑卡（点卡片开完整视图） */}

        {/* 新任务入口（2026-10-09 设计定稿，与 PC 对齐——PC 任务页有「＋ 新任务」，
            手机此前只读。补同款：点击打开平台页（EXPLORE_URL，带自动登录）创建任务。
            2026-10-15：注释里说的"带自动登录"此前并未实现（裸 window.open）——接上真免登链。 */}
        <div className="cardd" style={{ marginTop: 8 }}>
          <div className="textlink"><span className="linkish" onClick={() => void openExplore(EXPLORE_URL)}>＋ 新任务</span></div>
        </div>
      </div>

      {/* 远程桌面(任务页顶栏入口;复用当前 WebRTC 连接,不再新建) */}
      {showDesktop && <DesktopView transport={transport} onClose={() => setShowDesktop(false)} />}

      {/* 第88轮：我的能力值全屏视图（youling ENV resume；与 YoulingLogin 同款深色玻璃 overlay） */}
      {showResume && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(8,12,20,.78)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <MyResume onClose={() => setShowResume(false)} />
        </div>
      )}

      {/* 扫码登录有灵网页：全屏遮罩承载 YoulingLogin（含 hash 桥 #mycoauth= 自动直达确认页） */}
      {showYLLogin && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(8,12,20,.78)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <YoulingLogin onClose={() => setShowYLLogin(false)} />
        </div>
      )}
    </>
  )
}
