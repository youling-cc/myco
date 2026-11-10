/**
 * sharePermProjects.ts — 手机版「指定项目」多选 + 会话按项目筛选的纯函数（2026-10-24）
 *
 * 2026-10-24 契约：visibility JSON 增加 `projects: string[]`（项目 cwd 绝对路径白名单）。
 *   · space=project：可见范围 = projects 白名单；空数组 = 沿用分享自身 cwd（旧行为）。
 *   · space=session：projects 非空时**先筛会话所属项目**，再应用 sessions 白名单；
 *     空数组 = 不做项目筛选（全部项目）。
 *   · space=machine：忽略 projects（保持整机）。
 * 兼容旧记录：`projectCwd`（单项目）在 projects 为空时视作一项白名单。
 *
 * 会话→项目映射（主设备 op get 现在每个 session 行都带 `cwd`）：
 *   优先 sessions[i].cwd；再兜底 sessions[i].projectCwd/project/workspace…、
 *   顶层 sessionProjects/sessionProjectMap、workspaces[i].sessions/sessionIds 等形状。
 *   一条映射都拿不到时 `mappingAvailable=false` —— UI 显示**全部会话 + 灰字说明**，
 *   绝不静默隐藏（用户口径 2026-10-24）。
 *
 * 为什么单独成文件：本任务共享写域只有 SharePermSheet.tsx；`share-admin.ts` 的
 * `ShareAdminVisibility` 类型不在写域内，这里用 `VisibilityWithProjects` 做类型扩展，
 * 并把可单测的纯逻辑（去重/映射/筛选/裁剪）集中在一处。
 */
import {
  projectShortName, sameProjectPath,
  type ShareAdminData, type ShareAdminSession, type ShareAdminVisibility, type ShareAdminWorkspace,
} from '../share-admin'

/** visibility 扩展类型：2026-10-24 新增 `projects`（share-admin.ts 不在本任务写域）。 */
export type VisibilityWithProjects = ShareAdminVisibility & { projects?: string[] }

/** 宽松解析 projects：只留非空字符串、按路径判等去重、保序；形状异常 → []。 */
export function normalizeProjects(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const p = typeof item === 'string' ? item.trim() : ''
    if (!p) continue
    if (out.some((x) => sameProjectPath(x, p))) continue
    out.push(p)
  }
  return out
}

/** 读 visibility.projects（宽松；异常→[]）。 */
export function readProjects(v?: ShareAdminVisibility | null): string[] {
  return normalizeProjects((v as VisibilityWithProjects | null | undefined)?.projects)
}

/** 当前所选项目：新契约 projects 优先；为空时把旧 `projectCwd` 视作单项目。 */
export function selectedProjects(v?: ShareAdminVisibility | null): string[] {
  const projects = readProjects(v)
  if (projects.length > 0) return projects
  const legacy = (v as VisibilityWithProjects | null | undefined)?.projectCwd
  const p = typeof legacy === 'string' ? legacy.trim() : ''
  return p ? [p] : []
}

/**
 * 项目选项表（手机勾选列表用）：
 *   workspaces（主设备从会话 cwd 派生）+ 已选项目（旧记录/清单里没有的）+ 分享所在项目兜底；
 *   按路径判等去重、保序；label 缺失时用目录短名。
 */
export function projectOptions(workspaces: ShareAdminWorkspace[], selected: string[], fallback: string): ShareAdminWorkspace[] {
  const out: ShareAdminWorkspace[] = []
  const push = (value: unknown, label?: unknown) => {
    const v = typeof value === 'string' ? value.trim() : ''
    if (!v) return
    if (out.some((w) => sameProjectPath(w.value, v))) return
    const l = typeof label === 'string' ? label.trim() : ''
    out.push({ value: v, label: l || projectShortName(v) || v })
  }
  for (const w of workspaces) push(w.value, w.label)
  for (const p of normalizeProjects(selected)) push(p)
  push(fallback)
  return out
}

/** 项目档折叠摘要：「指定项目（2）」；空=「指定项目（沿用分享项目）」。 */
export function projectsSummary(projects: string[]): string {
  const n = normalizeProjects(projects).length
  return n > 0 ? `指定项目（${n}）` : '指定项目（沿用分享项目）'
}

/** 会话 → 项目归属映射 + 覆盖率。 */
export interface SessionProjectMapping {
  map: Map<string, string>
  /** 至少一条映射可用（false = 主设备没给映射，按「全部保留」处理） */
  mappingAvailable: boolean
  mapped: number
  unmapped: number
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** 从 op get 的 data 里尽可能解析「会话→项目 cwd」映射（多来源兜底，绝不抛错）。 */
export function sessionProjectMapping(
  data: ShareAdminData | null | undefined,
  sessions: ShareAdminSession[],
): SessionProjectMapping {
  const map = new Map<string, string>()
  const rawData = (data ?? {}) as Record<string, unknown>

  // ① workspaces 行上直接挂会话清单（如果主设备这么给）
  if (Array.isArray(rawData.workspaces)) {
    for (const w of rawData.workspaces) {
      if (!w || typeof w !== 'object') continue
      const wo = w as Record<string, unknown>
      const project = asStr(wo.value) || asStr(wo.cwd)
      if (!project) continue
      for (const key of ['sessions', 'sessionIds', 'session_ids'] as const) {
        const arr = wo[key]
        if (!Array.isArray(arr)) continue
        for (const id of arr) {
          const sid = asStr(id)
          if (sid && !map.has(sid)) map.set(sid, project)
        }
      }
    }
  }

  // ② 顶层映射表：sessionProjects / sessionProjectMap / sessionProject / projectSessions
  //    （Record<sessionId, cwd> 或 [{sessionId, cwd|project|projectCwd, sessions?}] 两种形状都认）
  const pushTop = (raw: unknown) => {
    if (Array.isArray(raw)) {
      for (const row of raw) {
        if (!row || typeof row !== 'object') continue
        const o = row as Record<string, unknown>
        const project = asStr(o.projectCwd) || asStr(o.project) || asStr(o.cwd) || asStr(o.value) || asStr(o.projectPath)
        if (!project) continue
        const ids: string[] = []
        const direct = asStr(o.sessionId) || asStr(o.session_id) || asStr(o.id)
        if (direct) ids.push(direct)
        if (Array.isArray(o.sessions)) for (const id of o.sessions) { const sid = asStr(id); if (sid) ids.push(sid) }
        if (Array.isArray(o.sessionIds)) for (const id of o.sessionIds) { const sid = asStr(id); if (sid) ids.push(sid) }
        for (const sid of ids) if (!map.has(sid)) map.set(sid, project)
      }
      return
    }
    if (raw && typeof raw === 'object') {
      for (const [sid, value] of Object.entries(raw as Record<string, unknown>)) {
        const project = asStr(value)
        if (sid && project && !map.has(sid)) map.set(sid, project)
      }
    }
  }
  pushTop(rawData.sessionProjects)
  pushTop(rawData.sessionProjectMap)
  pushTop(rawData.sessionProject)
  pushTop(rawData.projectSessions)

  // ③ 每个 session 行自带的字段（当前主设备 get 会带 cwd）
  if (Array.isArray(rawData.sessions)) {
    for (const s of rawData.sessions) {
      if (!s || typeof s !== 'object') continue
      const o = s as Record<string, unknown>
      const sid = asStr(o.sessionId) || asStr(o.session_id)
      if (!sid || map.has(sid)) continue
      const project = asStr(o.cwd) || asStr(o.projectCwd) || asStr(o.projectPath)
        || asStr(o.project) || asStr(o.workspace) || asStr(o.workspaceCwd) || asStr(o.projectValue)
      if (project) map.set(sid, project)
    }
  }

  let mapped = 0
  let unmapped = 0
  for (const s of sessions) {
    if (!s || typeof s.sessionId !== 'string' || !s.sessionId) continue
    if (map.get(s.sessionId)) mapped += 1
    else unmapped += 1
  }
  return { map, mappingAvailable: mapped > 0, mapped, unmapped }
}

/** 会话按项目筛选的结果（含降级信息，UI 据此显示灰字说明）。 */
export interface ProjectFilterResult {
  sessions: ShareAdminSession[]
  /** 是否真的应用了筛选（未选项目 / 拿不到映射时为 false = 原样返回） */
  filtered: boolean
  mappingAvailable: boolean
  /** 判断不出所属项目而被保留的会话数 */
  unmappedKept: number
  /** 因项目不在所选白名单而被筛掉的会话数 */
  dropped: number
}

/**
 * 指定会话档：先用所选项目筛会话（再交给 sessions 白名单）。
 * 未选项目 → 原样返回；拿不到映射 → 原样返回 + mappingAvailable=false（UI 显示灰字）；
 * 认不出所属项目的个别会话 → **保留**（不静默隐藏）。
 */
export function filterSessionsByProjects(
  sessions: ShareAdminSession[],
  mapping: SessionProjectMapping,
  projects: string[],
): ProjectFilterResult {
  const targets = normalizeProjects(projects)
  if (targets.length === 0) {
    return { sessions, filtered: false, mappingAvailable: mapping.mappingAvailable, unmappedKept: 0, dropped: 0 }
  }
  if (!mapping.mappingAvailable) {
    return { sessions, filtered: false, mappingAvailable: false, unmappedKept: sessions.length, dropped: 0 }
  }
  const kept: ShareAdminSession[] = []
  let unmappedKept = 0
  let dropped = 0
  for (const s of sessions) {
    const project = s && typeof s.sessionId === 'string' ? mapping.map.get(s.sessionId) : ''
    if (!project) {
      kept.push(s) // 认不出归属：保留（宁可多显示，不可静默隐藏）
      unmappedKept += 1
      continue
    }
    if (targets.some((t) => sameProjectPath(t, project))) kept.push(s)
    else dropped += 1
  }
  return { sessions: kept, filtered: true, mappingAvailable: true, unmappedKept, dropped }
}

/** 按项目筛选结果裁剪已选会话白名单（只在真的筛过时调用；未映射会话保留）。 */
export function pruneSessionWhitelist(whitelist: string[], filtered: ProjectFilterResult): string[] {
  if (!filtered.filtered) return whitelist
  const allowed = new Set<string>()
  for (const s of filtered.sessions) {
    if (s && typeof s.sessionId === 'string' && s.sessionId) allowed.add(s.sessionId)
  }
  return whitelist.filter((id) => allowed.has(id))
}
