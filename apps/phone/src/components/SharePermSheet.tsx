/**
 * SharePermSheet.tsx — 手机版「权限设置」底部弹层（2026-10-18）
 *
 * 与 PC 的「🔑 授权与可见性」面板等价（可见范围 / 每人能力 / 逐人可见范围 / 邀请 / 收回），
 * 交互按手机重做：底部弹层、大号触控行、分组折叠、即时保存 + 顶部 Toast。
 *
 * 2026-10-18 第二轮（与主设备新契约配套）：
 *   · 可见范围选「只这个项目」→ 项目选择器（项目清单来自主设备；默认 = 分享自身 cwd）；
 *   · 邀请区优先列**好友**（点人直接按 did 授权），bearer 链接降为折叠的次要入口；
 *   · 每个人可单独收窄到「只看指定会话」（op visibility + did；清除 = 跟随整体）。
 *
 * 2026-10-24（「指定项目」多选契约）：
 *   · 可见范围 project 档从「只这一个项目」改为**指定项目多选**（visibility.projects: string[]）；
 *     空选 = 沿用分享自身 cwd；chip 显示已选数量（如「指定项目（2）」）；
 *   · 指定会话档：已选项目时**先用项目筛会话**（会话→项目映射取 data.sessions[].cwd；
 *     拿不到映射则显示全部 + 灰字说明，不静默隐藏）；
 *   · 动作授权保留现有开关；设置/模型/思考等级类动作以禁用态列出（灰 +「暂未开放」）。
 *
 * 数据/操作全部经 `share-admin.ts` 转发到**主设备**执行（手机是薄客户端）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listFriends, type Friend } from '../chat-store'
import { accountDidEq } from '../didUtil'
import {
  CAP_ROWS, capsSummary, readCaps, visSummary,
  effectiveProjectCwd, listWorkspaces, personOverride, projectPathTail, projectShortName, sameProjectPath,
  shareAdminGet, shareAdminSetCaps, shareAdminSetFaceCaps, shareAdminSetVisibility, shareAdminInvite, shareAdminRevoke, shareAdminRevokeAll,
  type CapKey, type ShareAdminCard, type ShareAdminCollaborator, type ShareAdminData, type ShareAdminSession,
  type ShareAdminVisibility, type ShareAdminWorkspace,
} from '../share-admin'
import {
  filterSessionsByProjects, normalizeProjects, projectOptions, projectsSummary, pruneSessionWhitelist,
  selectedProjects, sessionProjectMapping,
  type VisibilityWithProjects,
} from './sharePermProjects'

const sheetBtn: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', padding: '13px 16px',
  fontSize: 15, background: 'none', border: 'none', borderTop: '1px solid var(--border,#e2e5ee)',
  color: 'var(--text,#1c2333)', cursor: 'pointer',
}
const chip = (on: boolean): React.CSSProperties => ({
  padding: '5px 12px', borderRadius: 999, fontSize: 12.5, flexShrink: 0,
  border: '1px solid ' + (on ? 'var(--accent,#6b7bff)' : 'var(--border,#e2e5ee)'),
  background: on ? 'rgba(107,123,255,.10)' : 'transparent',
  color: on ? 'var(--accent,#4c5bd4)' : 'var(--muted,#8a93a8)',
  fontWeight: on ? 700 : 500, cursor: 'pointer',
})
const capsTone = (caps: Record<CapKey, boolean>): React.CSSProperties => {
  if (caps['session.input']) return { background: 'rgba(230,81,0,.10)', color: '#c2410c' }
  if (caps['session.read']) return { background: 'rgba(107,123,255,.10)', color: '#4c5bd4' }
  return { background: 'rgba(229,83,75,.10)', color: '#d92d20' }
}
/** 折叠的次要入口（如「生成链接邀请」）——像链接一样的整行按钮。 */
const linkBtn: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', padding: '10px 0 2px',
  fontSize: 12.5, background: 'none', border: 'none', color: 'var(--accent,#4c5bd4)', cursor: 'pointer',
}
// 2026-10-20：常见档位补 12 小时；另加「自定义（1-720 小时）」输入。
const WIN_OPTIONS: { label: string; ms: number | null }[] = [
  { label: '全部历史', ms: null },
  { label: '最近 6 小时', ms: 21600000 },
  { label: '最近 12 小时', ms: 43200000 },
  { label: '最近 1 天', ms: 86400000 },
  { label: '最近 7 天', ms: 604800000 },
]
const WIN_PRESET_MS = new Set<number | null>(WIN_OPTIONS.map((w) => w.ms))

/** 会话多选列表（整体可见范围 / 逐人可见范围共用）——大触控行。 */
function SessionPicker({ sessions, selected, onToggle, emptyHint }: {
  sessions: ShareAdminSession[]
  selected: Set<string>
  onToggle: (sessionId: string) => void
  emptyHint: string
}) {
  return (
    <div style={{ maxHeight: 190, overflowY: 'auto', marginTop: 6, border: '1px solid var(--border,#e2e5ee)', borderRadius: 10 }}>
      {sessions.length === 0 && (
        <div style={{ padding: 10, fontSize: 12, color: 'var(--muted,#8a93a8)' }}>{emptyHint}</div>
      )}
      {sessions.map((s, i) => {
        const sid = String(s.sessionId || '')
        const on = selected.has(sid)
        return (
          <div key={sid || `session-${i}`} onClick={() => { if (sid) onToggle(sid) }}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderTop: i === 0 ? 'none' : '1px solid var(--border,#e2e5ee)', cursor: 'pointer' }}>
            <span style={{ fontSize: 14, color: on ? 'var(--accent,#4c5bd4)' : 'var(--muted,#c3c9d6)' }}>{on ? '☑' : '☐'}</span>
            <span style={{ fontSize: 13.5, color: 'var(--text,#1c2333)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label || sid}</span>
          </div>
        )
      })}
    </div>
  )
}

/** 暂未开放的动作（设置/模型/思考等级类）——与 PC 面板同口径的禁用占位。 */
const DISABLED_ACTIONS: { label: string }[] = [
  { label: '修改设置（settings）' },
  { label: '调整思考等级（thinking）' },
]

/** 项目多选勾选列表（project 档 = 可见范围白名单；session 档 = 会话预筛选）。 */
function ProjectPicker({ rows, selected, onToggle, emptyHint }: {
  rows: ShareAdminWorkspace[]
  selected: string[]
  onToggle: (value: string) => void
  emptyHint: string
}) {
  return (
    <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 6, border: '1px solid var(--border,#e2e5ee)', borderRadius: 10 }}>
      {rows.length === 0 && (
        <div style={{ padding: 10, fontSize: 12, color: 'var(--muted,#8a93a8)' }}>{emptyHint}</div>
      )}
      {rows.map((w, i) => {
        const on = selected.some((p) => sameProjectPath(p, w.value))
        return (
          <div key={w.value} onClick={() => onToggle(w.value)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
              borderTop: i === 0 ? 'none' : '1px solid var(--border,#e2e5ee)',
              background: on ? 'rgba(107,123,255,.06)' : 'transparent', cursor: 'pointer' }}>
            <span style={{ fontSize: 14, color: on ? 'var(--accent,#4c5bd4)' : 'var(--muted,#c3c9d6)' }}>{on ? '☑' : '☐'}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13.5, color: 'var(--text,#1c2333)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.label || projectShortName(w.value)}</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--muted,#8a93a8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{projectPathTail(w.value)}</span>
            </span>
            {on && <span style={{ fontSize: 11, color: 'var(--accent,#4c5bd4)', flexShrink: 0 }}>已选</span>}
          </div>
        )
      })}
    </div>
  )
}

export function SharePermSheet({ card, onClose, onChanged }: {
  card: ShareAdminCard
  onClose: () => void
  onChanged?: () => void
}) {
  const [data, setData] = useState<ShareAdminData | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null)
  const [savingDid, setSavingDid] = useState<string | null>(null)
  const [openDid, setOpenDid] = useState<string | null>(null)
  const [visOpen, setVisOpen] = useState(false)
  const [savingPersonVis, setSavingPersonVis] = useState<string | null>(null)
  /** 本次弹层里已知的逐人覆盖（did → visibility|null；null=已恢复跟随）。优先于主设备回包推断。 */
  const [personVis, setPersonVis] = useState<Record<string, ShareAdminVisibility | null>>({})
  const [inviteOpen, setInviteOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [inviteLabel, setInviteLabel] = useState('')
  const [inviting, setInviting] = useState(false)
  const [invitingDid, setInvitingDid] = useState<string | null>(null)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)
  const [customWinOpen, setCustomWinOpen] = useState(false)
  const [customWinHours, setCustomWinHours] = useState('')
  /** load 代际（task-42）：重试/重新加载时让旧看门狗与旧结果失效，避免串台。 */
  const loadSeq = useRef(0)

  const say = useCallback((text: string, bad = false) => {
    setToast({ text, bad })
    window.setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 4200)
  }, [])

  // 2026-10-24：任务级能力面（能看什么/能做什么）保存态与切换（与逐人 save 分开）。
  const [savingCaps, setSavingCaps] = useState(false)
  const toggleFaceCaps = useCallback(async (face: 'o' | 'a', id: CapKey) => {
    if (!data || savingCaps) return
    const curO: CapKey[] = (data.capsO ?? []) as CapKey[]
    const curA: CapKey[] = (data.capsA ?? []) as CapKey[]
    const nextO = face === 'o' ? (curO.includes(id) ? curO.filter((x) => x !== id) : [...curO, id]) : curO
    const nextA = face === 'a' ? (curA.includes(id) ? curA.filter((x) => x !== id) : [...curA, id]) : curA
    setSavingCaps(true)
    try {
      const r = await shareAdminSetFaceCaps(card, nextO, nextA)
      setData((d) => (d ? { ...d, ...r } : r))
      say('能力面已更新（对所有人生效）')
    } catch (e) {
      say(e instanceof Error ? e.message : '能力面没保存成功', true)
    } finally {
      setSavingCaps(false)
    }
  }, [card, data, savingCaps, say])

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    setLoadErr(null)
    let settled = false
    // task-42 真机 P0：UI 层再兜一道 12s 看门狗（share-admin 已 10s 硬超时）。
    // 任何上游（presence/relay/隧道）挂起都必须落到「人话失败 + 重试」，绝不永久 loading。
    const watchdog = window.setTimeout(() => {
      if (settled || loadSeq.current !== seq) return
      setLoadErr('从主设备读取权限超时（12 秒）——权限仍在主设备上；请确认主设备 myco 在线、网络正常，然后点「重试」')
    }, 12_000)
    try {
      const d = await shareAdminGet(card)
      if (loadSeq.current === seq && !settled) {
        settled = true
        setData(d)
        setLoadErr(null)
      }
    } catch (e) {
      if (loadSeq.current === seq && !settled) {
        settled = true
        setLoadErr(e instanceof Error ? e.message : String(e))
      }
    } finally {
      window.clearTimeout(watchdog)
    }
  }, [card])

  useEffect(() => { void load() }, [load])

  // 防御：主设备返回形状异常时也不能把整页带崩（真机踩到过 filter of object）
  const collaborators: ShareAdminCollaborator[] = Array.isArray(data?.collaborators)
    ? (data?.collaborators as ShareAdminCollaborator[]).filter((c) => {
      if (!c || typeof c !== 'object') return false
      // owner 行在账号身份未就绪时 did 可能为空串——仍要显示「我」那行；其他行必须有 did
      return c.isOwner === true || (typeof c.did === 'string' && c.did.length > 0)
    })
    : []
  const others = useMemo(() => collaborators.filter((c) => !c.isOwner), [collaborators])
  const readers = others.filter((c) => readCaps(c.caps)['session.read']).length
  const sayers = others.filter((c) => readCaps(c.caps)['session.input']).length
  const vis: ShareAdminVisibility = data?.visibility && typeof data.visibility === 'object' ? data.visibility : {}
  const sessions: ShareAdminSession[] = useMemo(
    () => (Array.isArray(data?.sessions) ? (data?.sessions as ShareAdminSession[]).filter((s) => !!s && typeof s === 'object') : []),
    [data],
  )
  // 只有任务级声明的能力才可逐人开关（其余开了也会被主设备夹回；渲染时直接不给）
  const available: CapKey[] = Array.isArray(data?.availableCaps) && (data?.availableCaps as CapKey[]).length ? (data?.availableCaps as CapKey[]) : CAP_ROWS.map((r) => r.key)
  const visSessions: string[] = Array.isArray(vis.sessions) ? vis.sessions : []
  const visSessionSet = new Set(visSessions)
  const sessionEmptyHint = typeof data?.error === 'string' && data.error ? `主设备上没读到会话清单：${data.error}` : '主设备上没读到会话清单'

  // ── 项目档（2026-10-24）：visibility.projects 多选白名单；空 = 沿用分享自身 cwd ──
  const workspaces = useMemo(() => listWorkspaces(data), [data])
  /** 旧记录/兜底项目（visibility.projectCwd → share.projectCwd → share.cwd）。 */
  const legacyProjectCwd = effectiveProjectCwd(data)
  const legacyProjectName = projectShortName(legacyProjectCwd)
  const projectsSelected = useMemo(() => selectedProjects(vis), [vis])
  const projectRows = useMemo(
    () => projectOptions(workspaces, projectsSelected, legacyProjectCwd),
    [workspaces, projectsSelected, legacyProjectCwd],
  )
  /** 整体范围内的项目（逐人选择器的天花板）：显式多选，或 project 档沿用分享 cwd。 */
  const scopeProjects = useMemo(
    () => (projectsSelected.length > 0
      ? projectsSelected
      : vis.space === 'project' && legacyProjectCwd ? [legacyProjectCwd] : []),
    [projectsSelected, vis.space, legacyProjectCwd],
  )
  /** 会话→项目映射 + 指定会话档的项目筛选结果（拿不到映射时 filtered=false，UI 显示灰字）。 */
  const sessionProjects = useMemo(() => sessionProjectMapping(data, sessions), [data, sessions])
  const projectFilter = useMemo(
    () => filterSessionsByProjects(sessions, sessionProjects, projectsSelected),
    [sessions, sessionProjects, projectsSelected],
  )
  const projectChipLabel = projectsSelected.length > 0 ? `指定项目（${projectsSelected.length}）` : '指定项目'
  const winSuffix = vis.windowMs
    ? ` · 近 ${vis.windowMs >= 86400000 ? Math.round(vis.windowMs / 86400000) + ' 天' : Math.max(1, Math.round(vis.windowMs / 3600000)) + ' 小时'}`
    : ''
  const visHeadText = vis.space === 'project'
    ? `${projectsSummary(projectsSelected)}${winSuffix}`
    : vis.space === 'session'
      ? `${visSummary(vis)}${projectsSelected.length > 0 ? ` · 项目 ${projectsSelected.length} 个` : ''}`
      : visSummary(vis)

  /** 某人的逐人覆盖（null=跟随整体）：本次弹层已知值优先，否则按主设备回包推断。 */
  const overrideFor = useCallback((c: ShareAdminCollaborator): ShareAdminVisibility | null => {
    if (Object.prototype.hasOwnProperty.call(personVis, c.did)) return personVis[c.did] ?? null
    return personOverride(c, vis)
  }, [personVis, vis])

  const projectLabelOf = (value: string): string =>
    projectRows.find((w) => sameProjectPath(w.value, value))?.label || projectShortName(value) || value

  /** 保存可见范围（任务级）：space + sessions + projects + windowMs（+ 旧 projectCwd 兼容）。 */
  const saveVis = async (patch: Partial<VisibilityWithProjects>) => {
    const nextProjects = patch.projects !== undefined ? normalizeProjects(patch.projects) : projectsSelected
    const next: VisibilityWithProjects = {
      space: patch.space ?? vis.space ?? 'machine',
      sessions: patch.sessions ?? visSessions,
      windowMs: patch.windowMs !== undefined ? patch.windowMs : (vis.windowMs ?? null),
      projects: nextProjects,
      // 旧主设备不认识 projects：单项目时仍带 projectCwd（多选/空选只能置 null，旧端回落分享 cwd）
      projectCwd: nextProjects.length === 1 ? nextProjects[0] : null,
    }
    setData((d) => (d ? { ...d, visibility: next } : d))
    try {
      const r = await shareAdminSetVisibility(card, next)
      if (r?.visibility) setData((d) => (d ? { ...d, visibility: r.visibility } : d))
      const n = nextProjects.length
      say(
        patch.projects !== undefined
          ? (n === 0
            ? '已清空项目选择——沿用分享所在项目'
            : n === 1 ? `已指定项目「${projectLabelOf(nextProjects[0])}」` : `已指定 ${n} 个项目`)
          : '可见范围已更新',
      )
      onChanged?.()
    } catch (e) {
      say(e instanceof Error ? e.message : '可见范围没保存成功', true)
      void load()
    }
  }

  /** 勾/取消一个项目（即时保存）。指定会话档顺带把落在项目范围外的已选会话摘掉。 */
  const toggleProject = (value: string) => {
    const has = projectsSelected.some((p) => sameProjectPath(p, value))
    const next = has ? projectsSelected.filter((p) => !sameProjectPath(p, value)) : [...projectsSelected, value]
    const patch: Partial<VisibilityWithProjects> = { projects: next }
    if (vis.space === 'session' && next.length > 0) {
      const after = filterSessionsByProjects(sessions, sessionProjects, next)
      if (after.filtered) patch.sessions = pruneSessionWhitelist(visSessions, after)
    }
    void saveVis(patch)
  }

  /** 切到「只指定会话」：若已选项目，先把项目范围外的已选会话摘掉。 */
  const enterSessionSpace = () => {
    const patch: Partial<VisibilityWithProjects> = { space: 'session', sessions: visSessions }
    if (projectsSelected.length > 0) {
      const after = filterSessionsByProjects(sessions, sessionProjects, projectsSelected)
      if (after.filtered) patch.sessions = pruneSessionWhitelist(visSessions, after)
    }
    void saveVis(patch)
  }

  const toggleCap = async (c: ShareAdminCollaborator, key: CapKey) => {
    if (c.isOwner || savingDid) return
    const before = readCaps(c.caps)
    const next = { ...before, [key]: !before[key] }
    setSavingDid(c.did)
    setData((d) => (d ? { ...d, collaborators: (d.collaborators ?? []).map((x) => (x.did === c.did ? { ...x, caps: next } : x)) } : d))
    try {
      const r = await shareAdminSetCaps(card, c.did, next)
      const fresh = (r?.collaborators ?? []).find((x) => x.did === c.did)
      if (fresh) setData((d) => (d ? { ...d, collaborators: r.collaborators } : d))
      say(`已${next[key] ? '放开' : '收回'}「${CAP_ROWS.find((x) => x.key === key)?.label ?? ''}」`)
      onChanged?.()
    } catch (e) {
      setData((d) => (d ? { ...d, collaborators: (d.collaborators ?? []).map((x) => (x.did === c.did ? { ...x, caps: before } : x)) } : d))
      say(e instanceof Error ? e.message : '没保存成功，已还原', true)
    } finally {
      setSavingDid(null)
    }
  }

  // ── 逐人可见范围（op visibility + did；null = 清除覆盖恢复「跟随整体」）──

  const mergeFromReply = (r: ShareAdminData | null | undefined) => {
    if (!r) return
    setData((d) => {
      if (!d) return d
      const merged: ShareAdminData = { ...d }
      if (Array.isArray(r.collaborators)) merged.collaborators = r.collaborators
      if (r.visibility) merged.visibility = r.visibility
      return merged
    })
  }

  const savePersonVis = async (c: ShareAdminCollaborator, next: ShareAdminVisibility | null) => {
    if (savingPersonVis) return
    const hadLocal = Object.prototype.hasOwnProperty.call(personVis, c.did)
    const prev = overrideFor(c)
    const who = c.name || `…${String(c.did || '').slice(-4)}`
    setPersonVis((m) => ({ ...m, [c.did]: next }))
    setSavingPersonVis(c.did)
    try {
      const r = await shareAdminSetVisibility(card, next, c.did)
      mergeFromReply(r)
      const n = Array.isArray(next?.sessions) ? next.sessions.length : 0
      if (!next) say(`「${who}」恢复跟随整体`)
      else if (n === 0) say('已切到「只看指定会话」——再勾选开放哪些会话')
      else say(`已把「${who}」限定到 ${n} 个会话`)
      onChanged?.()
    } catch (e) {
      setPersonVis((m) => {
        const out = { ...m }
        if (hadLocal) out[c.did] = prev
        else delete out[c.did]
        return out
      })
      say(e instanceof Error ? e.message : '没保存成功，已还原', true)
    } finally {
      setSavingPersonVis(null)
    }
  }

  /** 逐人会话覆盖的 payload：带上整体项目范围（后端逐人腿只能收紧；旧端忽略 projects）。 */
  const personSessionPayload = (cur: ShareAdminVisibility | null, sessions: string[]): VisibilityWithProjects => {
    const curProjects = selectedProjects(cur)
    return {
      space: 'session',
      sessions,
      windowMs: cur?.windowMs ?? null,
      projects: curProjects.length > 0 ? curProjects : [...scopeProjects],
    }
  }

  /** 切到「只看指定会话」（带上已有的会话选择；之后再点列表逐项增删）。 */
  const enablePersonSession = (c: ShareAdminCollaborator) => {
    if (savingPersonVis) return
    const cur = overrideFor(c)
    if (cur?.space === 'session') return
    void savePersonVis(c, personSessionPayload(cur, Array.isArray(cur?.sessions) ? cur.sessions : []))
  }

  /** 点会话 = 即时保存这个人新的会话白名单。 */
  const togglePersonSession = (c: ShareAdminCollaborator, sessionId: string) => {
    if (savingPersonVis) return
    const cur = overrideFor(c)
    const set = new Set(cur?.space === 'session' && Array.isArray(cur.sessions) ? cur.sessions : [])
    if (set.has(sessionId)) set.delete(sessionId); else set.add(sessionId)
    void savePersonVis(c, personSessionPayload(cur, Array.from(set)))
  }

  /** 恢复「跟随整体」（visibility:null + did）。 */
  const clearPersonVis = (c: ShareAdminCollaborator) => {
    if (savingPersonVis) return
    // 已经是跟随整体（且本次没改过）就不发无意义的 P2P 往返
    if (!overrideFor(c) && !Object.prototype.hasOwnProperty.call(personVis, c.did)) {
      say('这个人本来就是跟随整体')
      return
    }
    void savePersonVis(c, null)
  }

  const personVisLabel = (override: ShareAdminVisibility | null): string => {
    if (!override) return '跟随整体'
    if (override.space === 'session') {
      const n = Array.isArray(override.sessions) ? override.sessions.length : 0
      return n > 0 ? `只看 ${n} 个会话` : '只看指定会话（还没选）'
    }
    return '已单独收窄'
  }

  /**
   * 逐人可选的会话（天花板）：先按整体项目范围收窄（拿不到映射不筛），
   * 再按整体会话白名单收窄；已选过的会话始终列出（否则取消不掉）。
   */
  const personSessionOptions = (picked: Set<string>): ShareAdminSession[] => {
    let base = sessions
    if (scopeProjects.length > 0) {
      const byProject = filterSessionsByProjects(sessions, sessionProjects, scopeProjects)
      if (byProject.filtered) base = byProject.sessions
    }
    if (vis.space === 'session' && visSessions.length > 0) {
      return base.filter((s) => visSessionSet.has(s.sessionId) || picked.has(s.sessionId))
    }
    return base
  }

  // ── 邀请：好友列表优先（直接按 did 授权）；bearer 链接降为折叠的次要入口 ──

  const friends: Friend[] = useMemo(() => {
    if (!inviteOpen) return []
    try {
      const list = listFriends()
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }, [inviteOpen, data])
  const collabDids = useMemo(() => others.map((c) => c.did).filter((d): d is string => !!d), [others])
  const okFriends = useMemo(() => friends.filter((f) => !!f && typeof f.did === 'string' && !!f.did && (f.status ?? 'ok') === 'ok'), [friends])
  const friendCandidates = useMemo(
    () => okFriends.filter((f) => !collabDids.some((d) => accountDidEq(d, f.did))),
    [okFriends, collabDids],
  )

  const inviteFriend = async (f: Friend) => {
    if (invitingDid) return
    const name = (f.name || '').trim() || `好友 ${String(f.did).slice(-4)}`
    setInvitingDid(f.did)
    try {
      await shareAdminInvite(card, name, { did: f.did })
      say(`已邀请「${name}」`)
      await load()
      onChanged?.()
    } catch (e) {
      say(e instanceof Error ? e.message : '邀请失败', true)
    } finally {
      setInvitingDid(null)
    }
  }

  const sendInvite = async () => {
    const label = inviteLabel.trim()
    if (!label) { say('先起个称呼（对方能看到）', true); return }
    setInviting(true)
    try {
      const r = await shareAdminInvite(card, label)
      setInviteUrl(r.url ?? null)
      say(r.url ? '邀请链接已生成，复制发给对方' : '已邀请（没拿到链接）')
      await load()
      onChanged?.()
    } catch (e) {
      say(e instanceof Error ? e.message : '邀请失败', true)
    } finally {
      setInviting(false)
    }
  }

  const copyUrl = async () => {
    if (!inviteUrl) return
    try {
      await navigator.clipboard.writeText(inviteUrl)
      say('链接已复制')
    } catch {
      say('复制失败——长按链接手动复制', true)
    }
  }

  const revokePerson = async (c: ShareAdminCollaborator) => {
    const label = (c.name || '').trim()
    if (!label) { say('这个人没有称呼，换用主设备操作', true); return }
    try {
      const r = await shareAdminRevoke(card, label)
      if (r?.collaborators) setData((d) => (d ? { ...d, collaborators: r.collaborators } : d))
      say(`已收回「${label}」的权限`)
      onChanged?.()
    } catch (e) {
      say(e instanceof Error ? e.message : '收回失败', true)
    }
  }

  const revokeAll = async () => {
    if (!armed) { setArmed(true); return }
    setArmed(false)
    try {
      const r = await shareAdminRevokeAll(card)
      if (r?.collaborators) setData((d) => (d ? { ...d, collaborators: r.collaborators } : d))
      say('已停止全部授权（卡片与聊天还在）')
      onChanged?.()
    } catch (e) {
      say(e instanceof Error ? e.message : '停止授权失败', true)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 170, background: 'rgba(8,12,20,.45)', display: 'flex', alignItems: 'flex-end' }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: '100%', maxHeight: '88vh', display: 'flex', flexDirection: 'column',
        background: 'var(--card,#fff)', borderRadius: '18px 18px 0 0',
        boxShadow: '0 -8px 28px rgba(22,30,60,.22)',
      }}>
        {/* 头部 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 8px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text,#1c2333)' }}>🔑 权限设置</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted,#8a93a8)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {card.title || data?.share?.title || '这张任务卡'} · 改的是主设备上的分享
            </div>
          </div>
          <button onClick={onClose} style={{ ...sheetBtn, width: 'auto', padding: '6px 10px', border: 'none', fontSize: 14, color: 'var(--muted,#8a93a8)' }}>关闭 ✕</button>
        </div>

        {/* toast */}
        {toast && (
          <div style={{ margin: '0 16px 6px', padding: '7px 10px', borderRadius: 10, fontSize: 12,
            background: toast.bad ? 'rgba(229,83,75,.10)' : 'rgba(21,128,61,.10)',
            color: toast.bad ? '#b42318' : '#15803d' }}>{toast.text}</div>
        )}

        <div style={{ overflowY: 'auto', flex: 1, paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))' }}>
          {loadErr && (
            <div style={{ margin: '8px 16px', padding: 12, borderRadius: 12, background: 'rgba(229,83,75,.08)', fontSize: 12.5, color: '#b42318' }}>
              取不到权限信息：{loadErr}
              <button className="btn ghost" style={{ display: 'block', marginTop: 8, padding: '6px 12px', fontSize: 13 }} onClick={() => void load()}>重试</button>
            </div>
          )}
          {!data && !loadErr && (
            <div style={{ padding: 22, textAlign: 'center', fontSize: 13, color: 'var(--muted,#8a93a8)' }}>正在从主设备读取权限…（最多等 10 秒）</div>
          )}

          {data && (
            <>
              {/* 概览 */}
              <div style={{ display: 'flex', gap: 8, padding: '4px 16px 12px', flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ ...chip(false), cursor: 'default' }}>👥 {readers} 人能看</span>
                <span style={{ padding: '5px 12px', borderRadius: 999, fontSize: 12.5,
                  background: sayers > 0 ? 'rgba(230,81,0,.10)' : 'rgba(148,163,184,.14)',
                  color: sayers > 0 ? '#c2410c' : '#6b7280' }}>✍️ {sayers} 人能发言</span>
                <span style={{ fontSize: 11, color: 'var(--muted,#8a93a8)' }}>能发言 = 能指挥 AI 动手</span>
              </div>

              {/* 可见范围 */}
              <button style={{ ...sheetBtn, display: 'flex', alignItems: 'center', gap: 8 }} onClick={() => setVisOpen((v) => !v)}>
                <span style={{ flex: 1 }}>👁 可见范围</span>
                <span style={{ fontSize: 11.5, color: 'var(--muted,#8a93a8)' }}>{visHeadText}</span>
                <span style={{ color: 'var(--muted,#8a93a8)' }}>{visOpen ? '▾' : '▸'}</span>
              </button>
              {visOpen && (
                <div style={{ padding: '2px 16px 12px' }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {([
                      ['machine', '我的全部（整机）'],
                      ['project', projectChipLabel],
                      ['session', '只指定会话'],
                    ] as const).map(([sp, label]) => (
                      <button key={sp} style={chip((vis.space ?? 'machine') === sp)}
                        onClick={() => {
                          if (sp === 'session') { enterSessionSpace(); return }
                          void saveVis({ space: sp, sessions: [] })
                        }}>{label}</button>
                    ))}
                  </div>

                  {/* 指定项目多选（2026-10-24）：project 档=可见范围白名单；session 档=会话预筛选 */}
                  {(vis.space === 'project' || vis.space === 'session') && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ flex: 1, fontSize: 11.5, color: 'var(--muted,#8a93a8)' }}>
                          {vis.space === 'project'
                            ? '指定项目（多选；只开放所选项目下的会话与工作区，空选=沿用分享所在项目）'
                            : '先用项目筛选会话（可选；不选=全部项目）'}
                        </span>
                        <span style={{ fontSize: 11.5, flexShrink: 0, color: projectsSelected.length > 0 ? 'var(--accent,#4c5bd4)' : 'var(--muted,#8a93a8)' }}>
                          已选 {projectsSelected.length} 个
                        </span>
                      </div>
                      <ProjectPicker rows={projectRows} selected={projectsSelected} onToggle={toggleProject}
                        emptyHint="主设备还没读到项目清单（harness 没跑，或主设备版本较旧）" />
                      {projectsSelected.length === 0 && (
                        <div style={{ fontSize: 11, color: 'var(--muted,#8a93a8)', marginTop: 6, lineHeight: 1.6 }}>
                          空选：沿用分享所在项目{legacyProjectName ? `「${legacyProjectName}」` : ''}
                          {vis.space === 'session' ? '，且会话列表不做项目筛选' : '（只开放它下面的会话与工作区）'}
                        </div>
                      )}
                    </div>
                  )}

                  {(vis.space === 'session') && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ flex: 1, fontSize: 11.5, color: 'var(--muted,#8a93a8)' }}>开放哪些会话（可多选）</span>
                        {projectsSelected.length > 0 && (
                          <span style={{ fontSize: 11.5, color: 'var(--muted,#8a93a8)', flexShrink: 0 }}>已按项目筛选</span>
                        )}
                      </div>
                      <SessionPicker sessions={projectFilter.sessions} selected={visSessionSet} emptyHint={sessionEmptyHint}
                        onToggle={(sid) => {
                          const next = new Set(visSessionSet)
                          if (next.has(sid)) next.delete(sid); else next.add(sid)
                          void saveVis({ sessions: Array.from(next) })
                        }} />
                      {projectsSelected.length > 0 && (
                        <div style={{ fontSize: 11, color: 'var(--muted,#8a93a8)', marginTop: 6, lineHeight: 1.6 }}>
                          {!projectFilter.mappingAvailable
                            ? '主设备没回会话所属项目，暂不能按项目筛选——已显示全部会话'
                            : projectFilter.unmappedKept > 0
                              ? `有 ${projectFilter.unmappedKept} 个会话判断不出所属项目，已保留显示`
                              : projectFilter.sessions.length === 0
                                ? '所选项目下没有会话——可换项目或清空项目筛选'
                                : projectFilter.dropped > 0
                                  ? `已按所选项目筛掉 ${projectFilter.dropped} 个会话`
                                  : '已按所选项目筛选（当前会话都在范围内）'}
                        </div>
                      )}
                    </div>
                  )}
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11.5, color: 'var(--muted,#8a93a8)' }}>可见多久以前的内容</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                      {WIN_OPTIONS.map((w) => (
                        <button key={String(w.ms)} style={chip((vis.windowMs ?? null) === w.ms)}
                          onClick={() => { setCustomWinOpen(false); void saveVis({ windowMs: w.ms }) }}>{w.label}</button>
                      ))}
                      <button style={chip(customWinOpen || (vis.windowMs != null && !WIN_PRESET_MS.has(vis.windowMs)))}
                        onClick={() => {
                          setCustomWinOpen(true)
                          const h = vis.windowMs && !WIN_PRESET_MS.has(vis.windowMs) ? String(Math.round(vis.windowMs / 3600000)) : ''
                          setCustomWinHours(h)
                        }}>自定义…</button>
                    </div>
                    {customWinOpen && (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                        <span style={{ fontSize: 12, color: 'var(--muted,#8a93a8)' }}>最近</span>
                        <input value={customWinHours} inputMode="numeric"
                          onChange={(e) => setCustomWinHours(e.target.value.replace(/[^0-9]/g, ''))}
                          placeholder="小时"
                          style={{ width: 72, padding: '7px 9px', borderRadius: 8, border: '1px solid var(--border,#e2e5ee)', fontSize: 13, background: 'transparent', color: 'var(--text,#1c2333)' }} />
                        <span style={{ fontSize: 12, color: 'var(--muted,#8a93a8)' }}>小时内的内容（1–720）</span>
                        <button style={chip(false)} onClick={() => {
                          const h = Number(customWinHours)
                          if (!Number.isFinite(h) || h < 1 || h > 720) { say('请输入 1–720 之间的小时数', true); return }
                          setCustomWinOpen(false)
                          void saveVis({ windowMs: Math.round(h * 3600000) })
                        }}>保存</button>
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted,#8a93a8)', marginTop: 8, lineHeight: 1.6 }}>
                    范围外的内容对方根本收不到（不是灰掉，是转发时就被挡住）。「指定项目」= 只开放所选项目下的会话与工作区（空选沿用分享所在项目）；逐个人只能在这个整体范围内再往里收。
                  </div>
                </div>
              )}

              {/* 能力面（任务级）：能看什么 / 能做什么（2026-10-24 用户需求，与 PC 面板同义） */}
              {(data?.capsO || data?.capsA) ? (() => {
                const oOn: CapKey[] = (data?.capsO ?? []) as CapKey[]
                const aOn: CapKey[] = (data?.capsA ?? []) as CapKey[]
                const rows: { title: string; ids: CapKey[]; on: CapKey[]; face: 'o' | 'a' }[] = [
                  { title: '能看什么', ids: ['session.read', 'agent.view'], on: oOn, face: 'o' },
                  { title: '能做什么', ids: ['session.input', 'scope.switch', 'model.select'], on: aOn, face: 'a' },
                ]
                return (
                  <div style={{ borderTop: '6px solid var(--bg,#f6f7fa)', padding: '12px 16px 10px' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text,#1c2333)', marginBottom: 6 }}>🔑 能力面（这只任务允许什么）</div>
                    {rows.map((row) => (
                      <div key={row.face} style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 12, color: 'var(--muted,#8a93a8)', marginBottom: 5 }}>{row.title}</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {row.ids.map((id) => {
                            const on = row.on.includes(id)
                            return (
                              <button key={id} style={{ ...chip(on), cursor: 'pointer' }} disabled={!!savingCaps}
                                onClick={() => void toggleFaceCaps(row.face, id)}>
                                {CAP_ROWS.find((x) => x.key === id)?.label ?? id}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                    <div style={{ fontSize: 11, color: 'var(--muted,#8a93a8)', marginTop: 4 }}>
                      这里改的是**任务级**能力（对所有人生效）；逐个人还能在这之内再收窄。
                    </div>
                  </div>
                )
              })() : null}

              {/* 每个人 */}
              <div style={{ ...sheetBtn, display: 'flex', alignItems: 'center', borderTop: '6px solid var(--bg,#f6f7fa)', padding: '12px 16px 6px', cursor: 'default' }}>
                <span style={{ flex: 1 }}>每个人的权限</span>
                <span style={{ fontSize: 11, color: 'var(--muted,#8a93a8)' }}>点开改四项 + 可见范围</span>
              </div>
              {collaborators.map((c) => {
                const isOwner = !!c.isOwner
                const caps = readCaps(c.caps, isOwner)
                const name = c.name || `…${String(c.did || '').slice(-4)}`
                const open = openDid === c.did
                const override = isOwner ? null : overrideFor(c)
                const personSessionSet = new Set(override?.space === 'session' && Array.isArray(override.sessions) ? override.sessions : [])
                const busyPersonVis = savingPersonVis === c.did
                return (
                  <div key={c.did}>
                    {isOwner ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 16px', borderTop: '1px solid var(--border,#e2e5ee)' }}>
                        <span style={{ flex: 1, fontSize: 14.5, fontWeight: 600 }}>{name}</span>
                        <span style={{ ...chip(false), cursor: 'default' }}>我 · 全部权限</span>
                      </div>
                    ) : (
                      <button style={{ ...sheetBtn, display: 'flex', alignItems: 'center', gap: 8 }}
                        onClick={() => setOpenDid(open ? null : c.did)}>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                        <span style={{ padding: '4px 10px', borderRadius: 999, fontSize: 11.5, ...capsTone(caps) }}>{capsSummary(caps)}</span>
                        <span style={{ color: 'var(--muted,#8a93a8)' }}>{open ? '▾' : '▸'}</span>
                      </button>
                    )}
                    {open && !isOwner && (
                      <div style={{ padding: '0 16px 12px' }}>
                        {CAP_ROWS.filter((r) => available.includes(r.key)).map((r) => {
                          const on = caps[r.key]
                          const risky = r.key === 'session.input'
                          return (
                            <div key={r.key}>
                              <div onClick={() => void toggleCap(c, r.key)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 4px', borderTop: '1px dashed var(--border,#e2e5ee)', cursor: savingDid ? 'default' : 'pointer', opacity: savingDid === c.did ? 0.55 : 1 }}>
                                <span style={{ flex: 1, fontSize: 13.5 }}>{r.label}{risky && <span style={{ color: 'var(--muted,#8a93a8)', marginLeft: 3 }}>ⓘ</span>}</span>
                                <span style={{ width: 42, height: 24, borderRadius: 999, background: on ? 'var(--accent,#6b7bff)' : 'rgba(148,163,184,.35)', position: 'relative', transition: 'background .15s', flexShrink: 0 }}>
                                  <span style={{ position: 'absolute', top: 3, left: on ? 21 : 3, width: 18, height: 18, borderRadius: 9, background: '#fff', transition: 'left .15s' }} />
                                </span>
                              </div>
                              {risky && on && <div style={{ fontSize: 11, color: '#c2410c', margin: '-2px 4px 6px' }}>等于把 AI 的工具能力借给他</div>}
                            </div>
                          )
                        })}

                        {/* 动作授权（2026-10-24）：保留上面四个开关；设置/模型/思考等级类动作暂未开放（禁用占位） */}
                        <div style={{ marginTop: 6, borderTop: '1px dashed var(--border,#e2e5ee)', paddingTop: 8 }}>
                          <div style={{ fontSize: 11.5, color: 'var(--muted,#8a93a8)', marginBottom: 2 }}>
                            动作授权（以下动作暂未开放）
                          </div>
                          {DISABLED_ACTIONS.map((a) => (
                            <div key={a.label} aria-disabled="true"
                              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', opacity: 0.55, cursor: 'not-allowed' }}>
                              <span style={{ flex: 1, fontSize: 13.5, color: 'var(--muted,#8a93a8)' }}>{a.label}</span>
                              <span style={{ padding: '2px 8px', borderRadius: 999, border: '1px dashed var(--border,#e2e5ee)', fontSize: 10.5, color: 'var(--muted,#8a93a8)', flexShrink: 0 }}>暂未开放</span>
                              <span style={{ width: 42, height: 24, borderRadius: 999, background: 'rgba(148,163,184,.22)', position: 'relative', flexShrink: 0 }}>
                                <span style={{ position: 'absolute', top: 3, left: 3, width: 18, height: 18, borderRadius: 9, background: '#fff' }} />
                              </span>
                            </div>
                          ))}
                          <div style={{ fontSize: 11, color: 'var(--muted,#8a93a8)', marginTop: 4, lineHeight: 1.6 }}>
                            改设置 / 切模型 / 调思考等级属于新动作，接入前一律保持关闭（灰态不可点）。
                          </div>
                        </div>

                        {/* 逐人可见范围（2026-10-18）：只能比整体更窄；清除 = 跟随整体 */}
                        <div style={{ marginTop: 6, borderTop: '1px dashed var(--border,#e2e5ee)', paddingTop: 9 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>👁 可见范围</span>
                            <span style={{ fontSize: 11.5, color: 'var(--muted,#8a93a8)' }}>{personVisLabel(override)}</span>
                          </div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                            <button style={chip(!override)} disabled={busyPersonVis} onClick={() => clearPersonVis(c)}>跟随整体</button>
                            <button style={chip(!!override && override.space === 'session')} disabled={busyPersonVis} onClick={() => enablePersonSession(c)}>只看指定会话</button>
                          </div>
                          {override?.space === 'session' && (
                            <div style={{ opacity: busyPersonVis ? 0.6 : 1 }}>
                              <div style={{ fontSize: 11.5, color: 'var(--muted,#8a93a8)', marginTop: 9 }}>
                                {busyPersonVis
                                  ? '正在保存…'
                                  : vis.space === 'session' && visSessions.length > 0
                                    ? `整体只开放了 ${visSessions.length} 个会话，这里只能从中再挑（点一下就存）`
                                    : scopeProjects.length > 0 && sessionProjects.mappingAvailable
                                      ? '整体已按项目筛选，这里只能从这些项目的会话里再挑（点一下就存）'
                                      : '选中的会话才对他开放（可多选，点一下就存）'}
                              </div>
                              <SessionPicker sessions={personSessionOptions(personSessionSet)} selected={personSessionSet} emptyHint={sessionEmptyHint}
                                onToggle={(sid) => togglePersonSession(c, sid)} />
                            </div>
                          )}
                          {override && (
                            <button className="btn ghost" style={{ width: '100%', marginTop: 8, padding: '8px 0', fontSize: 12.5 }}
                              disabled={busyPersonVis} onClick={() => clearPersonVis(c)}>恢复跟随整体</button>
                          )}
                          <div style={{ fontSize: 11, color: 'var(--muted,#8a93a8)', marginTop: 7, lineHeight: 1.6 }}>
                            只能比上面的「整体可见范围」更窄；范围外的内容对方收不到。
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                          <button className="btn ghost" style={{ flex: 1, padding: '7px 10px', fontSize: 12.5 }} onClick={() => setOpenDid(null)}>收起</button>
                          <button className="btn ghost" style={{ flex: 1, padding: '7px 10px', fontSize: 12.5, color: '#b42318', borderColor: 'rgba(229,83,75,.35)' }}
                            onClick={() => { setOpenDid(null); void revokePerson(c) }}>收回此人的权限</button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
              {others.length === 0 && (
                <div style={{ padding: '8px 16px 14px', fontSize: 12, color: 'var(--muted,#8a93a8)' }}>还没有别人能看——点下面「邀请账号」。</div>
              )}

              {/* 邀请 */}
              <button style={{ ...sheetBtn, display: 'flex', alignItems: 'center', gap: 8, borderTop: '6px solid var(--bg,#f6f7fa)' }} onClick={() => setInviteOpen((v) => !v)}>
                <span style={{ flex: 1 }}>＋ 邀请账号</span>
                <span style={{ color: 'var(--muted,#8a93a8)' }}>{inviteOpen ? '▾' : '▸'}</span>
              </button>
              {inviteOpen && (
                <div style={{ padding: '2px 16px 12px' }}>
                  <div style={{ fontSize: 11.5, color: 'var(--muted,#8a93a8)', marginBottom: 6 }}>邀请好友（点一下就授权给他，不用转发链接）</div>
                  {friendCandidates.length > 0 ? (
                    <div style={{ border: '1px solid var(--border,#e2e5ee)', borderRadius: 10, overflow: 'hidden' }}>
                      {friendCandidates.map((f, i) => {
                        const fname = (f.name || '').trim() || `…${String(f.did || '').slice(-4)}`
                        return (
                          <div key={f.did} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderTop: i === 0 ? 'none' : '1px solid var(--border,#e2e5ee)' }}>
                            <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: 'var(--text,#1c2333)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fname}</span>
                            <button className="btn" style={{ padding: '6px 14px', fontSize: 12.5 }} disabled={!!invitingDid}
                              onClick={() => void inviteFriend(f)}>{invitingDid === f.did ? '邀请中…' : '邀请'}</button>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div style={{ padding: '9px 10px', borderRadius: 10, border: '1px dashed var(--border,#e2e5ee)', fontSize: 12, color: 'var(--muted,#8a93a8)' }}>
                      {okFriends.length > 0
                        ? '好友都已经能看这张卡了'
                        : friends.length > 0
                          ? '好友邀请还没通过——通过后就能直接在这里邀请'
                          : '还没有好友——可以先加好友，或用下面的链接邀请'}
                    </div>
                  )}

                  {/* 次要入口：bearer 链接（原有 UI 保留，折叠） */}
                  <button style={linkBtn} onClick={() => setLinkOpen((v) => !v)}>
                    🔗 {linkOpen ? '收起链接邀请' : '生成邀请链接（转发给别人）'} <span style={{ color: 'var(--muted,#8a93a8)' }}>{linkOpen ? '▾' : '▸'}</span>
                  </button>
                  {linkOpen && (
                    <div style={{ paddingTop: 4 }}>
                      <div style={{ fontSize: 11.5, color: 'var(--muted,#8a93a8)', marginBottom: 6 }}>起个称呼，生成一条邀请链接（谁拿到链接谁能进）</div>
                      <input value={inviteLabel} onChange={(e) => setInviteLabel(e.target.value)} placeholder="称呼（对方能看到）"
                        style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border,#e2e5ee)', fontSize: 14, background: 'var(--bg,#f6f7fa)', color: 'var(--text,#1c2333)' }} />
                      <button className="btn" style={{ width: '100%', marginTop: 9, padding: '10px 0', fontSize: 14 }}
                        disabled={inviting} onClick={() => void sendInvite()}>{inviting ? '正在生成…' : '生成邀请链接'}</button>
                      {inviteUrl && (
                        <div style={{ marginTop: 10 }}>
                          <div style={{ fontSize: 11.5, color: 'var(--muted,#8a93a8)' }}>把这条链接发给「{inviteLabel}」：</div>
                          <div style={{ marginTop: 5, padding: '8px 10px', borderRadius: 10, border: '1px solid var(--border,#e2e5ee)', background: 'var(--bg,#f6f7fa)', fontSize: 11.5, fontFamily: 'ui-monospace,monospace', wordBreak: 'break-all', userSelect: 'text' }}>{inviteUrl}</div>
                          <button className="btn ghost" style={{ width: '100%', marginTop: 7, padding: '8px 0', fontSize: 13 }} onClick={() => void copyUrl()}>复制链接</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* 危险操作 */}
              <div style={{ borderTop: '6px solid var(--bg,#f6f7fa)', padding: '12px 16px 4px' }}>
                <div style={{ fontSize: 11, color: 'var(--muted,#8a93a8)', marginBottom: 7 }}>危险操作（要再点一次确认）</div>
                <button className="btn ghost" style={{ width: '100%', padding: '10px 0', fontSize: 14, color: '#b42318', borderColor: armed ? 'rgba(229,83,75,.6)' : 'rgba(229,83,75,.3)', background: armed ? 'rgba(229,83,75,.08)' : 'transparent' }}
                  onClick={() => void revokeAll()}>{armed ? '⚠ 再点一次：全部停止授权' : '🛑 全部停止授权'}</button>
                <div style={{ fontSize: 11, color: 'var(--muted,#8a93a8)', marginTop: 6 }}>只收回权限，任务卡和聊天还在；分享本身还在。</div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
