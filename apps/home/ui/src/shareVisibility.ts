/**
 * shareVisibility — §3.22「分享范围＝状态空间可见性（s→o 投影）」的纯逻辑。
 *
 * 界面按**后端给的 schema** 动态画（不预置"哪些项可配"的硬编码表，§3.14/§3.22：
 * 范围与能力由任务声明，myco 只加载 / 呈现 / 执行）。本模块只做三件事：
 *   ① 取某项当前值（草稿 → 当前值 → 默认值）；
 *   ② 判 `dependsOn` 是否满足——不满足就**整块不显示**该控件
 *      （用户口径：没选"只指定会话"时，"可见哪些会话"不出现）；
 *   ③ 组装回写体——以 `current` 的形状为底逐项覆盖；`selectable:false` 的项**永远回
 *      默认/当前值**（即用户说的"我们有默认，哪些默认不给选"）。
 *
 * 契约（后端钉死，照此对接，不新造字段）：
 * ```jsonc
 * // share_visibility(shareId)                 -> { ok, current, schema }
 * // share_set_visibility(shareId, visibility) -> { ok, current }
 * "visibility": {
 *   "space": "machine"|"project"|"session",
 *   "sessions": ["…"],                 // 会话白名单（space=session 时生效）
 *   "projects": ["<项目 cwd>", "…"],   // 2026-10-24 多项目白名单：
 *                                      //   project 档 = 只开放这些项目；
 *                                      //   session 档 = 先按项目筛、再按 sessions 筛；
 *                                      //   空数组 = 沿用分享自身 cwd / 不额外按项目限制
 *   "windowMs": 21600000|null,
 *   "projectCwd": "<cwd>"|null         // 旧单项目字段（向后兼容：projects 空时视作单项目白名单）
 * }
 * "schema": { "items": [ { "id":"space", "label":"可见范围", "kind":"enum",
 *                          "options":[{"value":"machine","label":"我的全部（整机）"}],
 *                          "default":"machine", "selectable":true } ],
 *             "workspaces": { "items": [{"value":"<项目 cwd>","label":"项目名"}] } }
 * ```
 * 失败一律 promise reject（界面**不**判 ok:false）。
 *
 * 为什么单独成模块：动态 schema 最容易翻车的地方是值类型、缺 label、联动、只读回写——
 * 抽成纯函数才能被 vitest 直接覆盖（vite build 不做类型检查，"能构建"≠"逻辑对"）。
 */

/** 可选项取值：字符串（多数 enum）/ 数字（如时长）/ null（未知）。 */
export type VisValue = string | number | null
export interface VisOption {
  value?: VisValue
  label?: string
  /** 会话候选可能带的工作目录/项目归属（2026-10-24「先按项目筛会话」用）。
   *  旧后端只给 `{value,label}` → 这些字段都缺 = 拿不到映射，界面显示全部 + 灰字说明
   *  （不静默隐藏）。字段名不押单一拼法：cwd / projectCwd / project / workspace / path 都认。 */
  cwd?: string
  projectCwd?: string
  project?: string
  workspace?: string
  path?: string
}
export interface VisItem {
  id?: string
  label?: string
  /** "enum"=单选一排 chip / "multi"=多选；**未知 kind 一律只读展示**（不猜语义、不崩）。 */
  kind?: string
  options?: VisOption[]
  default?: unknown
  /** false = 按默认值只读显示（用户要的"哪些默认不给选"）。缺省视为可配。 */
  selectable?: boolean
  /** "sessions" = 可选项应来自本机会话清单（清单读不到时界面退化为手填）。 */
  source?: string
  /** 会话清单读不到时后端附的**一句人话**（如「本机 DSH 没在运行——…」）——
   *  原文直接上屏，取代界面本地的笼统提示（后端才知道真实原因）。 */
  optionsError?: string
  /** 会话清单超上限被截断（后端附 `truncated:true`）——上屏一句「只列出最近 50 条」。 */
  truncated?: boolean
  dependsOn?: unknown
}
export interface VisSchema { items?: VisItem[] }
/** Visibility 原样透传：键名只活在数据层，**永不上屏**（人话红线）。 */
export type Visibility = Record<string, unknown>

/** 值等价：一律按字符串比（enum 的 value 可能是数字，schema 与后端未必同型）。 */
export const visEq = (a: unknown, b: unknown): boolean => String(a ?? '') === String(b ?? '')

/** 取多选值：数组归一成字符串数组；单值也当一元列表（后端少给一层也不炸）。 */
export function visAsList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x ?? '')).filter((s) => s !== '')
  if (v === undefined || v === null || v === '') return []
  return [String(v)]
}

/** 某项当前值：草稿（用户刚动的） → 当前值（后端权威） → 默认值。 */
export function visValueOf(item: VisItem, current: Visibility | null, draft: Record<string, unknown>): unknown {
  const id = String(item.id ?? '')
  if (id && id in draft) return draft[id]
  if (current && id && current[id] !== undefined) return current[id]
  return item.default
}

/** 直接映射写法 `{ "<itemId>": 期望值 }` 里的键——不是这些"期望值关键词"就按依赖项 id 解。 */
const DEP_META_KEYS = ['equals', 'value', 'eq', 'is', 'in', 'values', 'oneOf', 'not', 'notEquals']
/** 依赖项 id 的几种拼法（schema 还在演进，不押单一拼法，但也不猜没影的键）。 */
const DEP_ID_KEYS = ['id', 'item', 'field', 'on']

/**
 * `dependsOn` 是否满足（不满足 = 该控件不显示）。兼容四种写法：
 *   `{ id:"space", equals:"session" }` / `{ item:"space", in:["session"] }`
 *   `{ id:"space", not:"machine" }`    / `{ space:"session" }`（直接映射）
 * 数组 = 全满足；解析不出形状 → 视为满足（**宁可多显示一项，不可把用户的配置藏起来**）。
 */
export function depOk(dep: unknown, valueOf: (id: string) => unknown, depth = 0): boolean {
  if (dep === undefined || dep === null || depth > 3) return true
  if (Array.isArray(dep)) return dep.every((d) => depOk(d, valueOf, depth + 1))
  if (typeof dep !== 'object') return true
  const d = dep as Record<string, unknown>
  const idKey = DEP_ID_KEYS.find((k) => typeof d[k] === 'string' && String(d[k]).trim() !== '')
  if (!idKey) {
    const pairs = Object.entries(d).filter(([k]) => !DEP_META_KEYS.includes(k))
    if (!pairs.length) return true
    return pairs.every(([k, v]) => depOk({ id: k, equals: v }, valueOf, depth + 1))
  }
  const val = valueOf(String(d[idKey]))
  const not = d.not !== undefined ? d.not : d.notEquals
  if (not !== undefined && visEq(not, val)) return false
  const list = d.in ?? d.values ?? d.oneOf
  if (Array.isArray(list)) return list.some((x) => visEq(x, val))
  const eq = d.equals ?? d.value ?? d.eq ?? d.is
  return eq === undefined ? true : visEq(eq, val)
}

/** 该项此刻该不该显示（依赖项不满足 → 整块不画）。 */
export function visItemVisible(item: VisItem, valueOf: (id: string) => unknown): boolean {
  return depOk(item.dependsOn, valueOf)
}

/** 草稿初值：每项 = 当前值（缺）→ 默认值。selectable:false 的项同样入草稿（只读显示用）。 */
export function visDraftFrom(current: Visibility | null, items: VisItem[] | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const it of items ?? []) {
    const id = String(it.id ?? '')
    if (!id) continue
    out[id] = (current && current[id] !== undefined) ? current[id] : it.default
  }
  return out
}

/** 草稿是否偏离基线（有未保存改动）——键序由 visDraftFrom 统一，直接比字符串即可。 */
export function visTouched(base: Record<string, unknown>, draft: Record<string, unknown>): boolean {
  return JSON.stringify(base) !== JSON.stringify(draft)
}

/**
 * 组装回写体：以 `current` 的形状为底（后端认识的键一个不丢），再按 schema 逐项覆盖。
 * · `selectable:false`（默认项）→ 回默认/当前值，**用户改不动也带不偏**；
 * · 多选 → 归一成字符串数组（去空）；时长类数字不合法 → null（后端语义：不限）；
 * · 草稿里没有的项 → 不动（保留原值，不做隐式改写）。
 */
export function buildVisibility(current: Visibility | null, items: VisItem[] | null, draft: Record<string, unknown>): Visibility {
  const out: Visibility = { ...(current ?? {}) }
  for (const it of items ?? []) {
    const id = String(it.id ?? '')
    if (!id) continue
    if (it.selectable === false) {
      if (!(id in out)) out[id] = it.default ?? null
      continue
    }
    if (!(id in draft)) continue
    let v: unknown = draft[id]
    if (v === undefined) v = it.default ?? null
    if (it.kind === 'multi') v = visAsList(v)
    if (id === 'windowMs') v = (typeof v === 'number' && isFinite(v)) ? v : null
    out[id] = v
  }
  return out
}

/**
 * 组装**完整回写体**（2026-10-24 projects 契约版；界面保存范围统一走它）：
 * `buildVisibility` 的 schema 项结果 + 两个顶层字段收口：
 * · `projects`：项目白名单。`project` 档=只开放这些项目；`session` 档=先按项目筛再按会话筛；
 *   `machine` 档不生效，但**照样写 []**（形状一致，免得旧值残留以为还钉着项目）；
 * · `projectCwd`：旧单项目字段，新界面统一写 `null`（后端语义：沿用分享自身 cwd；
 *   兼容旧记录靠后端读侧把 projectCwd 视作单项目白名单）。
 * 空 projects = 沿用分享自身 cwd（界面显示为"当前分享所在项目"）——不是"什么都没得看"。
 */
export function buildVisibilityPayload(
  current: Visibility | null,
  items: VisItem[] | null,
  draft: Record<string, unknown>,
): Visibility {
  const out = buildVisibility(current, items, draft)
  const space = String((draft['space'] ?? current?.['space'] ?? '') || '')
  out['projects'] = (space === 'project' || space === 'session') ? visProjectsOf(draft) : []
  out['projectCwd'] = null
  return out
}

/** 手填会话：逗号/顿号/分号/空白都算分隔符，去空去重（保序）。 */
export function splitSessionIds(text: string): string[] {
  const parts = String(text ?? '').split(/[\s,，、;；]+/).map((s) => s.trim()).filter((s) => s !== '')
  return parts.filter((s, i) => parts.indexOf(s) === i)
}

/** 会话 chip 上的短标签：只给尾 8 位（全文进 title），避免一屏塞满长 id。 */
export function visShortId(id: string): string {
  const s = String(id ?? '')
  return s.length > 10 ? `…${s.slice(-8)}` : s
}

/* ═══════════ 多项目（2026-10-24 用户需求）：路径口径 + 项目白名单 + 会话先按项目筛 ═══════════
 * 用户口径：「可见范围」的项目档从「只这一个项目」改成「指定项目」多选（跟指定会话一样）；
 *   project 档 = 只开放所选项目下的会话与工作区（不选 = 沿用分享自身 cwd = 当前项目）；
 *   session 档 = 先按所选项目筛，再按会话白名单筛。
 *
 * 路径比较全部走 `visPathKey`（反斜杠/正斜杠、大小写、尾分隔符都不算差异）——Windows 上
 * 同一个项目常有 `D:\a\b` / `d:/a/b/` 两种写法，按原串比会把用户选的自己筛掉。
 * 人话红线照旧：这些值只活在数据层，界面只显示项目名（label）。 */

/** 路径比较键（Windows 盘符路径统一小写；其它原样）。 */
export function visPathKey(p: string): string {
  const s = String(p ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:(?:\/|$)/.test(s) ? s.toLowerCase() : s
}

/** 两个路径是否是同一个目录。 */
export function visSamePath(a: string, b: string): boolean {
  const x = visPathKey(a)
  return x !== '' && x === visPathKey(b)
}

/** `child` 是否是 `parent` 本身或其子目录（项目内的子目录也算这个项目——候选先按项目筛时
 *  宁可多留，真正生效由后端按 cwd 判；反过来少留会把用户想选的会话静默藏掉）。 */
export function visPathUnder(child: string, parent: string): boolean {
  const c = visPathKey(child)
  const p = visPathKey(parent)
  if (c === '' || p === '') return false
  // 统一拼 `/` 再接子段：盘符根（`c:` → `c:/…`）与普通目录（`d:/a` → `d:/a/…`）同一条规则；
  // 前缀相似但不在同一目录（`d:/p2` vs `d:/p`）不算。
  return c === p || c.startsWith(`${p}/`)
}

/** 路径末段（项目人话名；取不到 = 空串）。 */
export function visPathTail(p: string): string {
  const parts = String(p ?? '').trim().split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

/** 路径倒数第二段（同名项目的区分提示：项目名都取末段，父目录才分得清）。 */
export function visPathParent(p: string): string {
  const parts = String(p ?? '').trim().split(/[\\/]+/).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 2] : ''
}

/** 项目白名单（`projects`）归一：数组/单值都认，去空、去重（路径口径同一化）、保序。
 *  空数组 = 不额外限制 / 沿用分享自身 cwd——**不是"什么都看不到"**。 */
export function visProjectsOf(v: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = []
  for (const raw of visAsList(v?.['projects'])) {
    const s = raw.trim()
    if (s !== '' && !out.some((x) => visSamePath(x, s))) out.push(s)
  }
  return out
}

/** 会话候选带的项目归属（cwd/项目路径）：字段名不押单一拼法，认到第一个非空字符串。
 *  全都取不到 = 拿不到映射（返回空串），界面显示全部会话 + 灰字说明，**不静默隐藏**。 */
export function visSessionCwdOf(opt: VisOption | null | undefined): string {
  if (!opt) return ''
  for (const k of ['cwd', 'projectCwd', 'project', 'workspace', 'path'] as const) {
    const v = opt[k]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return ''
}

/**
 * 解析后端附的「会话 → 项目/cwd」映射（兼容多种形状；解析不出 = 空表，不抛错）：
 * ```jsonc
 * {"s-1": "D:\\p"}                       // 直接映射
 * {"s-1": {"cwd": "D:\\p"}}              // 值带壳
 * {"items":[{"sessionId":"s-1","cwd":"D:\\p"}]}   // 数组（sessionId/value/id 都认）
 * ```
 */
export function visSessionCwdsOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  const put = (id: unknown, cwd: unknown) => {
    const k = typeof id === 'string' ? id.trim() : ''
    const v = typeof cwd === 'string' ? cwd.trim() : ''
    if (k !== '' && v !== '') out[k] = v
  }
  const walk = (node: unknown, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 3) return
    if (Array.isArray(node)) {
      for (const row of node) {
        if (!row || typeof row !== 'object') continue
        const o = row as Record<string, unknown>
        put(o['sessionId'] ?? o['value'] ?? o['id'],
          o['cwd'] ?? o['projectCwd'] ?? o['project'] ?? o['workspace'] ?? o['path'])
      }
      return
    }
    const o = node as Record<string, unknown>
    if (Array.isArray(o['items'])) { walk(o['items'], depth + 1); return }
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string') put(k, v)
      else if (v && typeof v === 'object') {
        const row = v as Record<string, unknown>
        put(k, row['cwd'] ?? row['projectCwd'] ?? row['project'] ?? row['workspace'] ?? row['path'])
      }
    }
  }
  walk(raw)
  return out
}

/** 用 schema 级映射给会话候选补 cwd（option 自己带的优先；只补缺的，不覆盖）。 */
export function visApplySessionCwds(
  opts: VisOption[] | null | undefined,
  cwds: Record<string, string> | null | undefined,
): VisOption[] {
  const map = cwds ?? {}
  return (opts ?? []).map((o) => {
    if (visSessionCwdOf(o) !== '') return o
    const cwd = map[String(o.value ?? '')]
    return typeof cwd === 'string' && cwd.trim() !== '' ? { ...o, cwd: cwd.trim() } : o
  })
}

/** 这条会话是否属于所选项目（cwd 落在任一项目目录内）。`projects` 空 = 不按项目限制。 */
export function visSessionInProjects(
  opt: VisOption | null | undefined,
  projects: string[] | null | undefined,
): boolean {
  const projs = (projects ?? []).map((p) => String(p ?? '').trim()).filter((p) => p !== '')
  if (projs.length === 0) return true
  const cwd = visSessionCwdOf(opt)
  if (cwd === '') return false
  return projs.some((p) => visPathUnder(cwd, p))
}

/** 按所选项目筛选会话候选的结果（用户口径：「未选项目=全部；拿不到映射=显示全部+灰字说明」）。 */
export interface VisSessionFilterResult {
  /** 筛后可见的候选（mapped=false 时 = 全部原样） */
  items: VisOption[]
  /** 候选是否带项目归属（能筛）；false = 拿不到会话→项目映射，界面要显示全部 + 灰字说明 */
  mapped: boolean
  /** 有归属但不在所选项目里 → 被隐藏的条数（界面说明用：没有静默丢） */
  hidden: number
  /** 归属拿不到 → 被隐藏的条数（界面说明用） */
  hiddenUnknown: number
}

/** 会话勾选「先按项目筛」：projects 空 → 全部；候选全无归属 → 全部 + mapped:false。 */
export function visFilterSessionsByProjects(
  opts: VisOption[] | null | undefined,
  projects: string[] | null | undefined,
): VisSessionFilterResult {
  const list = opts ?? []
  const projs = (projects ?? []).map((p) => String(p ?? '').trim()).filter((p) => p !== '')
  if (projs.length === 0) return { items: list, mapped: true, hidden: 0, hiddenUnknown: 0 }
  const mapped = list.some((o) => visSessionCwdOf(o) !== '')
  if (!mapped) return { items: list, mapped: false, hidden: 0, hiddenUnknown: 0 }
  const kept: VisOption[] = []
  let hidden = 0
  let hiddenUnknown = 0
  for (const o of list) {
    if (visSessionCwdOf(o) === '') { hiddenUnknown++; continue }
    if (visSessionInProjects(o, projs)) kept.push(o)
    else hidden++
  }
  return { items: kept, mapped: true, hidden, hiddenUnknown }
}

/** 界面「项目档」的统一叫法（2026-10-24 用户要求）：schema 的 label 可能还是旧的
 *  「只这一个项目（xxx）」——只在**显示层**覆盖，取值/其它项一律不动。 */
export const VIS_PROJECT_TIER_LABEL = '指定项目'

/** 给显示用的 schema items：把 `space` 的 `project` 选项 label 统一成「指定项目」。
 *  返回新对象（不改原数组/原对象）；`visScopeLabel` 等摘要函数喂它 → 摘要也用人话新叫法。 */
export function visDisplayItems(items: VisItem[] | null | undefined): VisItem[] | null {
  if (!items) return null
  return items.map((it) => {
    if (!it || String(it.id ?? '') !== 'space' || !Array.isArray(it.options)) return it
    return {
      ...it,
      options: it.options.map((o) => (o && visEq(o.value, 'project')
        ? { ...o, label: VIS_PROJECT_TIER_LABEL }
        : o)),
    }
  })
}

/* ═══════════ §3.20 逐人可见范围（人对账号配，设备成员跟随主设备/账号） ═══════════
 * 契约回顾（后端 `dsh_share.rs` 钉死，前端只读/只写、不重算生效值）：
 *   · 逐人 `visibility === null` = **继承任务级**；非空 = 与任务级取交（**只能收紧，绝不放大**）；
 *   · 写逐人 = `share_set_visibility` 的 **payload 里带 `did`**（后端从 payload 读 did，
 *     并把该值铺到**该账号的所有设备行**——所以界面按账号一行配就够，设备成员不单列）；
 *   · 协作者列表与逐人行的合并都由后端按账号粒度做完（`same_person` / `resolve_account_did`），
 *     前端无法可靠地把设备 did 归到账号，**故不重复合并**（只在精确 did 上兜底去重）。
 *
 * 「跟随整体」这一态在界面上的落点：读 **null** 是继承；写走**真 null 清除通道**
 * （2026-10-06 后端契约：`share_set_visibility(shareId, {did, visibility:null})` →
 * 清除该人所有设备行的逐人覆盖，返回 `{ok, current:null, did, effective:<生效值>}`；
 * 旧后端不认 null 会 reject——界面就地红字提示，**绝不**静默退回"最宽的一份"）。
 * 摘要里「继承（null）」与「清除后」显示同一句话。 */

/** 「不加额外限制」的规格字面量——与后端 `visibility_default()` 同形（对照/单测用）。 */
export const VIS_WIDE: Visibility = { space: 'machine', sessions: [], windowMs: null }

/**
 * 有没有**额外限制**：`null/undefined` = 没配（继承整体）；全宽的一份 = 没限制。
 * 两者对"这个人到底看得到什么"效果一致（逐人只能收紧），界面因此可以合成同一句话。
 * 口径与后端 `Vis::restricts_sessions`（space=session **且**白名单非空）逐字对齐；
 * 2026-10-24 多项目：`projects` 非空也算真收窄（project 档=项目白名单；
 * session 档=先按项目筛再按会话筛）——否则逐人配了项目会被误判成"跟随整体"。
 */
export function visNotNarrowed(v: Visibility | null | undefined): boolean {
  if (v === null || v === undefined) return true
  const space = String(v.space ?? 'machine')
  const restrictSessions = space === 'session' && visAsList(v.sessions).length > 0
  const restrictProjects = (space === 'project' || space === 'session') && visProjectsOf(v).length > 0
  const w = v.windowMs
  const hasWindow = typeof w === 'number' && isFinite(w)
  return !restrictSessions && !restrictProjects && !hasWindow
}

/** 逐人回写体：把 did 塞进 payload（后端从 payload 读 did；带 did = 写该人）。空 did 不塞键。
 *  `spec = null` = 「跟随整体范围」：返回**真 null**（后端清除通道的契约——visibility 传
 *  null 而不是空对象；did 走调用参数顶层，见 FriendsZone 的 save）。 */
export function visGrantPayload(spec: Visibility | null, did: string): Visibility | null {
  if (spec === null) return null
  const d = String(did ?? '').trim()
  return d ? { ...spec, did: d } : { ...spec }
}

/** 逐人编辑器的模式：follow=「跟随整体范围」（基线是"跟随"这个状态本身，不是某个具体值）。 */
export type VisGrantMode = 'follow' | 'custom'

/**
 * 逐人编辑器的脏判定（§3.20「展开即脏」修复，2026-10-06）：
 * **基线 = 展开那一刻的快照**（模式 + 值，同源对齐），dirty = 用户真正动过：
 *   · 模式偏离基线（跟随 ⇄ 单独指定）= 改动——切到「单独指定」才算改动，
 *     再切回「跟随整体范围」= 回到基线状态 → 不脏；
 *   · 单独指定下 `draft ≠ base` = 改动；展开/换模式重新起手后两者同源 → 不脏；
 *   · 基线只在对齐点（展开 / 撤销 / 保存成功）刷新——之后的 prop 变化不推动脏标记
 *     （此前 dirty 直接比"活的" savedFollow，grant 行一刷新模式位就可能自己翻脏）。
 */
export function visGrantDirty(
  baseMode: VisGrantMode,
  mode: VisGrantMode,
  base: Record<string, unknown>,
  draft: Record<string, unknown>,
): boolean {
  return mode !== baseMode || (mode === 'custom' && visTouched(base, draft))
}

/**
 * 逐人编辑器的**起手草稿**：已经在逐人这一层收窄过 → 从他的值起手；
 * 否则（继承 / 全宽）→ 从**整体当前值**起手——他本来就看到这么多，用户在"不比整体更大"的
 * 前提下往里收，避免一打开就是空的让人重新猜。
 */
export function visGrantStart(
  raw: Visibility | null | undefined,
  taskCurrent: Visibility | null | undefined,
  items: VisItem[] | null,
): Record<string, unknown> {
  const seed = visNotNarrowed(raw) ? (taskCurrent ?? null) : (raw ?? null)
  return visDraftFrom(seed, items)
}

/* ═══════════ 逐人编辑器的「整体天花板」：能选的 = 整体 ∩ 这一层 ═══════════
 * 用户口径（2026-10-06）：逐人配置里应当**自然显示整体当前的选择**，并且
 * **不能选的直接灰掉**（不是隐藏、不是点了保存才发现不生效）。
 *
 * 为什么要判：后端 `effective_visibility` = 逐人 ∩ 任务级（**只能收紧，不能放大**）。
 * 界面把整体之外的选项照常摆出来、还能点 → 用户点了「我的全部（整机）」，保存后
 * **不生效**（被整体天花板吃掉）——那是界面在骗人。本段把"哪些还能点"算清楚，
 * 由界面把**点不动的**画成灰的 + 一句为什么（`title`）。
 *
 * 三个维度的宽度序（宽 → 窄）：
 *   · `space`     `machine` > `project` > `session`（整体=session ⇒ 只有 session 可点）；
 *   · `sessions`  整体白名单 = **上限**（白名单外的候选项灰掉；白名单空的 = 不额外限制 ⇒ 全可选）；
 *   · `windowMs`  `null`（全部历史）**最宽**，数值越小越窄
 *                 （整体=6 小时 ⇒ 只有 ≤6 小时的可点，6 小时本身可点）。
 * 整体 = `machine` 且 `windowMs=null`（`allVisible`，没有天花板）⇒ 全部可选（现状不变）。
 *
 * `dependsOn` 已实现"整块不渲染"的地方**维持现状**（那是语义不适用，不是被挡）；
 * 本段只负责"画出来但不给点"。
 * 人话红线照旧：灰项的解释只用 schema 给的 label 拼，**不吐** `machine`/`session`/`windowMs`
 * 这类内部词（`visCeilings` 收 `items` 正是为此——文案在纯函数里拼，单测直接扫）。 */

/** schema 给的一项可选项（`VisOption` 的显式版：本段要按取值为 null 的选项判宽窄）。 */
export interface VisOptionLike { value?: VisValue; label?: string }

/** 一项目前**点不动**的可选项（`title` = 为什么点不动，人话）。 */
export interface VisDisabledOption { value: VisValue; title: string }

/** 一项的天花板判定：`locked` = 整块点不动（会话清单读不到时，界面据此把退化路径也关掉）。 */
export interface VisCeiling {
  /** 逐值判定：命中的可选项灰掉 + `title`。 */
  disabled: VisDisabledOption[]
  /** 该项**整块**点不动（`sessions` 清单读不到 → 连"直接填会话编号"也不该收——照样会被挡）。 */
  locked: boolean
  /** 整块点不动时的 `title`。 */
  lockedTitle: string
}

/** 宽度序：`machine`(2) > `project`(1) > `session`(0)。值认不出（含缺省）→ 按最宽的**整机**算
 *  （与后端 `space` 缺省即 machine 的口径一致；宁可多灰一个，也不放出一个"点了不生效"的选项）。 */
const visSpaceRank = (v: unknown): number => (v == null || v === '' ? 2 : v === 'session' ? 0 : v === 'project' ? 1 : 2)

/** 时间窗数值（不可解析 → `undefined`；`null` 也是**合法值**＝全部历史，不是"没给"）。 */
export const visWindowValue = (v: unknown): number | null | undefined =>
  v === null ? null : typeof v === 'number' && isFinite(v) ? v : undefined

/** 这一项的值是不是比整体还宽（宽了就点不动）。三项语义不同，各写一条，别混着判。 */
function visTooWide(id: string, ceiling: Visibility, val: unknown, item: VisItem): boolean {
  if (id === 'space') return visSpaceRank(val) > visSpaceRank(ceiling.space)
  if (id === 'windowMs') {
    const cur = visWindowValue(ceiling.windowMs)
    const mine = visWindowValue(val)
    // 整体最宽（全部历史/null）→ 无天花板；只挡**能证明更宽**的数值＝全部历史(null)。
    if (cur === null) return false
    if (cur === undefined) return false  // 整体值认不出 → 不挡（宁可漏挡，不可误挡）
    return mine === null ? true : mine === undefined ? false : mine > cur
  }
  if (id === 'sessions') {
    // 白名单只在"整体限定为指定会话"时才是上限（后端 `Vis::restricts_sessions` 同口径）；
    // 空白名单 = 不额外限制 ⇒ 全部候选可选。
    if (String(ceiling.space ?? 'machine') !== 'session') return false
    const wide = visAsList(ceiling.sessions)
    return wide.length > 0 && !wide.includes(String(val ?? ''))
  }
  return false
}

/** 「整体只开放到 X，这里不能放宽」——X 取整体当前值的 label（认不出就给不出名字，退回通用句）。 */
const visNarrowTitle = (room: string): string =>
  room ? `整体只开放到「${room}」，这里不能放宽` : '整体已经限定了范围，这里不能放宽'
/** 多选维度：不在整体开放清单里。 */
const VIS_NOT_OPEN = '整体没开放这个，这里不能放宽'
/** 一个值在某项 schema 里的 label（认不出 → 空串）。 */
const visLabelOf = (it: VisItem | undefined, val: unknown): string =>
  String(((it?.options ?? []).find((o) => !!o && visEq(o.value, val)))?.label ?? '')
/** 时间维度：说清"整体只看到哪一档以内"。 */
const visCeilTitleOf = (it: VisItem | undefined, val: unknown): string => {
  const lb = visLabelOf(it, val)
  return lb ? `整体只看到「${lb}」以内，这里不能放宽` : VIS_NOT_OPEN
}

/** 整体基线的**人话**一行（比 `visScopeLabel` 多两处，只为读起来是完整句子）：
 *  · 会话/项目个数写成「N 个」（"只指定会话（1）"读着像编号，"（1 个）"才是个数）；
 *  · 值取不出 label 的选项**跳过**（宁可少说一句，也不吐内部值——人话红线）。
 *  `windowMs: 21600000` → `只指定会话（1 个） · 最近 6 小时`；
 *  `projects: [a,b]` → `指定项目（2 个）`（label 由界面显示层统一覆盖）；
 *  `machine + null`（`allVisible`）→ `我的全部（整机） · 不限（全部历史）`。 */
export function visCeilingLabel(ceiling: Visibility | null | undefined, items: VisItem[] | null): string {
  const list = (items ?? []).filter((it) => !!it && !!it.id)
  const v = ceiling ?? {}
  const out: string[] = []
  for (const it of list) {
    if (it.kind !== 'enum') continue // 多选项的"几个"不比单选更说明问题，且没有可选 label 时只会添乱
    const val = v[String(it.id)]
    const lb = visLabelOf(it, val)
    if (!lb) continue // 认不出（没这一项 / 值对不上 label）→ 跳过，不回落到原始值
    const n = visAsList(v.sessions).length
    const nProj = visProjectsOf(v).length
    out.push(it.id === 'space' && visEq(val, 'session') && n > 0 ? `${lb}（${n} 个）`
      : it.id === 'space' && visEq(val, 'project') && nProj > 0 ? `${lb}（${nProj} 个）`
      : lb)
  }
  if (out.length) return out.join(' · ')
  // 一项都认不出（没有 schema / 选项对不上）→ 沿用摘要那条人话兜底，同样不吐内部值。
  return visScopeLabel(ceiling, items)
}

/**
 * 逐人编辑器的**天花板表**：每项 → 哪些可选项点不动（+ 为什么）。
 * 键 = schema 的项 id（只用 `space`/`sessions`/`windowMs` 三个已知维度，其余项不挡——
 * 不认识就不猜、不误伤）。`valOf(id)` 给"此刻的取值"（草稿优先），用于判 `sessions` 是否受限。
 * 整体 = `machine` + `windowMs=null` ⇒ 返回空表（全开，现状不变）。
 */
export function visCeilings(
  taskCurrent: Visibility | null | undefined,
  valOf: (id: string) => unknown,
  items: VisItem[] | null,
): Record<string, VisCeiling> {
  const ceiling: Visibility = taskCurrent ?? {}
  const out: Record<string, VisCeiling> = {}
  const empty: VisCeiling = { disabled: [], locked: false, lockedTitle: '' }
  for (const it of items ?? []) {
    if (!it || !it.id) continue
    const id = String(it.id)
    if (id !== 'space' && id !== 'sessions' && id !== 'windowMs') continue
    const opts = (it.options ?? []).filter((o) => !!o && o.value !== undefined) as VisOptionLike[]
    // 文案按**维度**拼（不按具体选项）：一维一句话，用户扫一眼就知道"这条线画在哪"。
    const title = (): string => {
      if (id === 'space') return visNarrowTitle(visLabelOf(it, ceiling[id] as unknown))
      if (id === 'windowMs') return visCeilTitleOf(it, ceiling[id] as unknown)
      return VIS_NOT_OPEN
    }
    const disabled: VisDisabledOption[] = opts
      .filter((o) => visTooWide(id, ceiling, o.value, it))
      .map((o) => ({ value: o.value as VisValue, title: title() }))
    const val = valOf(id)
    const locked = id === 'sessions' &&
      visTooWide(id, ceiling, typeof val === 'string' || typeof val === 'number' ? val : '', it)
    out[id] = disabled.length || locked
      ? { disabled, locked, lockedTitle: locked ? VIS_NOT_OPEN : '' }
      : { ...empty }
  }
  return out
}

/**
 * 生效摘要（**人话**）：只用 schema 给的 label 拼，**绝不回落到原始值/id**
 * （人话红线：界面上不出现 space/windowMs/session 这类内部词）。
 * · `v` 为 null/undefined（没配）→ `inheritLabel`（给了才算"跟随"）或主项默认 label；
 * · 给了 `inheritLabel` 且这一份没有额外限制（全宽 ≡ 继承）→ `inheritLabel`；
 * · 主项（第一个 enum）取选项 label；`space=session` 且选了会话 → 追加「（N）」；
 *   `space=project` 且选了项目（2026-10-24 多项目）→ 追加「（N）」；
 * · 其余 enum 项**偏离自身默认值**才追加（如"最近 6 小时"），默认值不啰嗦。
 * 认不出（没有 schema / 选项对不上）→ 只给项名或「已设置」，不猜、不吐内部值。
 */
export function visScopeLabel(
  v: Visibility | null | undefined,
  items: VisItem[] | null,
  inheritLabel?: string,
): string {
  const list = (items ?? []).filter((it) => !!it && !!it.id)
  const primary = list.find((it) => it.kind === 'enum') ?? list[0]
  const labelOf = (it: VisItem | undefined, val: unknown): string =>
    ((it?.options ?? []).find((o) => !!o && visEq(o.value, val))?.label) || ''
  const defLabelOf = (it: VisItem | undefined): string => {
    if (!it) return ''
    return labelOf(it, it.default) || it.label || ''
  }
  if (v === null || v === undefined) return inheritLabel || defLabelOf(primary) || '默认范围'
  if (inheritLabel && visNotNarrowed(v)) return inheritLabel
  if (!primary) return inheritLabel || '已设置'
  const main = labelOf(primary, v[String(primary.id ?? '')]) || primary.label || '已设置'
  const space = String(v.space ?? '')
  const nSessions = space === 'session' ? visAsList(v.sessions).length : 0
  const nProjects = space === 'project' ? visProjectsOf(v).length : 0
  const head = nSessions > 0 ? `${main}（${nSessions}）` : nProjects > 0 ? `${main}（${nProjects}）` : main
  const extra = list
    .filter((it) => it !== primary && it.kind === 'enum' && !visEq(v[String(it.id ?? '')], it.default))
    .map((it) => labelOf(it, v[String(it.id ?? '')]) || it.label || '')
    .filter((s) => s !== '')
  return [head, ...extra].join(' · ')
}
