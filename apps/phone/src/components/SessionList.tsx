/**
 * 子任务列表（任务详情页）—— 微信通讯录式。
 * 只显示所属任务（WorkTask）的项目：已打开 = PC 上跑着的终端会话；未打开 = 项目（点开即远程开 claude 终端）。
 */
import { useEffect, useMemo, useState } from 'react'
import { type Transport, type SessionInfo, type ProjectInfo, type TaskInfo, type AuthInfo } from '../transport'
import { DesktopView } from './DesktopView'

const AVA_COLORS = [
  ['#6b7bff', '#5567f5'], ['#4ec9a5', '#2fbf71'], ['#f5a623', '#e8890c'],
  ['#8f7bff', '#6f5bf0'], ['#ff8a7a', '#ff5a52'], ['#4fc3e8', '#2aa5d6'],
]
function avaColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  const [a, b] = AVA_COLORS[h % AVA_COLORS.length]
  return `linear-gradient(135deg,${a},${b})`
}
function statusLabel(s: string): string {
  switch (s) {
    case 'running': return '运行中'
    case 'waiting_input': return '等你输入'
    case 'idle': return '空闲'
    case 'exited': return '已退出'
    case 'failed': return '出错'
    default: return s || '—'
  }
}
function fmtTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`
  if (diff < 86400_000) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function SessionList({
  transport,
  task,
  onPick,
  onBack,
}: {
  transport: Transport
  /** 所属任务（WorkTask；未分组是前端虚拟的 {id:'__ungrouped__', projectIds:[...]}）。 */
  task: TaskInfo
  onPick: (s: SessionInfo) => void
  onBack: () => void
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  const [showDesktop, setShowDesktop] = useState(false) // 远程桌面(设备级,复用当前 WebRTC 连接)
  // 自己在对方 PC 的授权信息（限时授权显示剩余；无限期不显示）
  const [auth, setAuth] = useState<AuthInfo | null>(null)

  // 授权剩余：进页面拉一次 + 每分钟刷（到期能看到"已到期"）
  useEffect(() => {
    if (!transport.authInfo) return
    const load = () => void transport.authInfo!().then(setAuth).catch(() => {})
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [transport])

  const authLeft = (() => {
    if (!auth?.authExpiresAt) return '' // 无限期不显示
    const left = auth.authExpiresAt - Date.now()
    if (left <= 0) return '授权已到期'
    const mins = Math.ceil(left / 60_000)
    return mins >= 60 ? `授权剩 ${Math.floor(mins / 60)} 小时${mins % 60 ? ` ${mins % 60} 分` : ''}` : `授权剩 ${mins} 分钟`
  })()

  const load = async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [ss, ps] = await Promise.all([
        transport.list(),
        transport.projects().catch(() => [] as ProjectInfo[]),
      ])
      setSessions(ss)
      setProjects(ps)
      setError(null)
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      if (!silent) setLoading(false)
    }
  }
  // 周期轮询（5s，silent 不闪 loading）+ visibility（切后台暂停、回前台立即拉）。
  // 之前只在 mount 跑一次，PC 下线/新开会话都看不到。
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
      if (!paused) tick() // 回前台立即拉
    }
    const onOnline = () => { if (!cancelled) { if (timer) clearTimeout(timer); tick() } }
    load() // 首次（显示 loading）
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

  // 只留本任务的项目/会话（taskId = proj-{projectId} 匹配）
  const inTask = useMemo(() => {
    const pids = new Set(task.projectIds)
    return {
      projects: projects.filter((p) => pids.has(p.id)),
      sessions: sessions.filter((s) => s.taskId?.startsWith('proj-') && pids.has(s.taskId.slice(5))),
    }
  }, [projects, sessions, task])

  // 未打开的项目 = 没有对应活会话（taskId = proj-{id}）的项目
  const unopened = useMemo(() => {
    return inTask.projects.filter((p) => !inTask.sessions.some((s) => s.taskId === `proj-${p.id}`))
  }, [inTask])

  const term = q.trim().toLowerCase()
  const match = (s: string) => !term || s.toLowerCase().includes(term)
  const openSessions = useMemo(
    () => [...inTask.sessions].filter((s) => match(s.title || s.taskId || '')).sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1)),
    [inTask, term],
  )
  const unopenedFiltered = useMemo(() => unopened.filter((p) => match(p.name)), [unopened, term])

  const openProject = async (p: ProjectInfo) => {
    setOpening(p.id)
    setError(null)
    try {
      const session = await transport.open(p.id)
      // projection open 现在回 {taskId, sessionId}；老后端/异常没回时用 proj-{id} 兜底
      // （项目 taskId 固定是 proj-{id}，ChatView 的 history/snap 都按它查）。
      onPick({ ...session, taskId: session?.taskId || `proj-${p.id}`, title: p.name })
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''))
      await load() // 失败则刷新列表
    } finally {
      setOpening(null)
    }
  }

  return (
    <>
      <div className="topbar">
        <button className="icon-btn" onClick={onBack} title={task.id === '__ungrouped__' ? '断开返回连接页' : '返回任务列表'}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <span className="title">{task.id === '__ungrouped__' ? '项目' : task.title}</span>
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
        <button className="icon-btn" onClick={() => load()} disabled={loading} title="刷新">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>
        </button>
      </div>

      {error && <div className="banner err">{error}</div>}

      <div className="ws-search">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索子任务" />
      </div>

      <div className="ws-list">
        {loading && sessions.length === 0 && <div className="banner info"><span className="spinner" /> 正在连接…</div>}

        {!loading && openSessions.length === 0 && unopenedFiltered.length === 0 && !error && (
          <div className="ws-empty">
            <div className="big">🗂</div>
            <div>这个任务里还没有子任务</div>
            <div style={{ fontSize: 13, marginTop: 6 }}>在主设备 myco 工作台把项目归组进「{task.title}」，这里就会出现</div>
          </div>
        )}

        {openSessions.length > 0 && <div className="ws-group-label">进行中 · {openSessions.length}</div>}
        {openSessions.map((s) => {
          // terminal-agent 的 SessionInfo 无 title 字段，直接显示会是 taskId(uuid 串)。
          // 用 projects 表反查项目名；查不到才退回 title/taskId。
          const proj = projects.find((p) => `proj-${p.id}` === s.taskId)
          const name = proj?.name || s.title || s.taskId || s.sessionId
          return (
            <div key={s.sessionId} className="ws-item" onClick={() => onPick({ ...s, title: name })}>
              <div className="ava" style={{ background: avaColor(name) }}>
                {name.slice(0, 1).toUpperCase()}
                <span className={`dot ${s.status}`} />
              </div>
              <div className="body">
                <div className="top">
                  <span className="name">{name}</span>
                  <span className="time">{fmtTime(s.startedAt)}</span>
                </div>
                <div className="preview">{s.command || '?'} · {statusLabel(s.status)}</div>
              </div>
            </div>
          )
        })}

        {unopenedFiltered.length > 0 && <div className="ws-group-label">未打开 · 点开启动</div>}
        {unopenedFiltered.map((p) => (
          <div key={p.id} className="ws-item" onClick={() => opening ? null : openProject(p)}>
            <div className="ava" style={{ background: 'var(--surface-2)', color: 'var(--muted)' }}>
              {opening === p.id ? <span className="spinner" style={{ borderTopColor: 'var(--accent)' }} /> : (p.name.slice(0, 1).toUpperCase())}
            </div>
            <div className="body">
              <div className="top">
                <span className="name" style={{ color: 'var(--text-2)' }}>{p.name}</span>
                <span className="pill" style={{ background: 'var(--accent-soft)', color: 'var(--accent-ink)' }}>打开</span>
              </div>
              <div className="preview">{p.path.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/')}</div>
            </div>
          </div>
        ))}
      </div>

      {/* 远程桌面(项目列表顶栏入口;复用当前 WebRTC 连接) */}
      {showDesktop && <DesktopView transport={transport} onClose={() => setShowDesktop(false)} />}
    </>
  )
}
