/**
 * youling-tasks.ts — youling 平台 ENV 感知面（第88轮：领取任务同步 + 能力值 resume）。
 *
 * 观察面协议化：myco 侧**零本地存储**（localStorage 不落任何任务/能力状态），每次进
 * 任务页现拉两个只读端点（AOP 思路：状态可感知，不复制状态）：
 *   GET {ENV_API_BASE}/env/worker/{did}/tasks   → 我领取的任务列表
 *   GET {ENV_API_BASE}/env/agents/{did}/resume  → 我的能力值（技能 α/β Beta 分布）
 * did = 当前账号锚（myAccountDid：主设备 rootDid / 分身 attestation.rootDid）。
 *
 * 鉴权：先无签名 GET；403 再用 X-Did-Auth 设备签名重试一次（did-auth.ts 协议——
 * GET 空 body 参与签名，根钥优先设备钥兜底，resolveDidAuthSigningIdentity 已铺好）。
 *
 * 2026-09-28 第90轮：ENV 端点已上 nginx——/env/* 走 ENV_API_BASE（/myco-env 前缀
 * 反代 :9000，app 路径不变）。修的正是此前 bug：手机打 http://IP/env/... 落进 SPA
 * fallback（HTTP 200 + text/html），有灵任务一直拉不到。HTML 响应兜底保留——
 * 识别 content-type 含 text/html 仍判 "not-ready" 优雅降级（UI 低调提示，不刷屏）。
 * 字段名多形态兜底（taskId/task_id、title/name…），与 TaskLinkCard 第87轮同哲学。
 *
 * 2026-09-28 第91轮（产品定稿，与 PC 同步）：/env/worker/{did}/tasks 是全题池三态
 * 投影（47 条）——**只渲染已领取**：modes.{production|practice|exam} 里
 * `my_claim != null || my_assigned > 0 || my_answered > 0` 的态才进"我的任务"；
 * 标题 name → 回退 task_id（不再"未命名任务"）；resume 解析补 abilities
 * （role/mean/α/β/ci95）+ 账号全局门槛，供任务页顶部能力值卡消费。
 */
import { myAccountDid } from './chat-store'
import { signDidAuthHeader, resolveDidAuthSigningIdentity } from './did-auth'

/** youling 平台基址——网页/分享链接用（/task/{id} 落地页等，443 直达）。
 *  换域名只改这一处（与 TaskLinkCard 第87轮约定一致）。
 *  2026-10-08 设计定稿：平台页基址改 www.youling.cc（平台真身）——
 *  myco.youling.cc=登录器服务域（DID/ENV/下载），两者分离。 */
export const YOULING_BASE: string = ((import.meta.env.VITE_NETWORK_URL as string | undefined) || 'https://www.youling.cc').replace(/\/+$/, '')

/** /env API 调用基址——nginx /myco-env 前缀反代 client_app(:9000)，剥前缀后路径不变
 *  （/env/worker/... 直达）。注意与 YOULING_BASE 分开：网页路由在 443 站根，ENV 接口
 *  在 /myco-env 前缀下——手机此前用站根拉 /env/* 拿到的是 SPA HTML（第90轮修）。 */
export const ENV_API_BASE: string = ((import.meta.env.VITE_ENV_API_BASE as string | undefined) || 'https://myco.youling.cc/myco-env').replace(/\/+$/, '')

export interface YoulingTask {
  taskId: string
  title: string
  slaText?: string
  pendingCount?: number
  answeredToday?: number
  /** 落地页（服务端给了用给的；没有按 /task/{id} 约定拼，与 TaskLinkCard 链接格式一致） */
  url?: string
  /** 第91轮：领取态（production/practice/exam，来自 modes 键） */
  mode?: string
  /** 第91轮：任务门槛（profile_filter/gateThreshold 宽容解析；无则 undefined → 能力卡目标回退全局门槛） */
  threshold?: number
  /** 第91轮：领取角色（与 resume.abilities.role 匹配能力卡主显行） */
  role?: string
}

/** 第91轮：能力画像行（服务端 resume.abilities：Beta 后验 role/mean/α/β/ci95）。 */
export interface AbilityRow {
  role: string
  mean?: number
  alpha: number
  beta: number
  ci95?: [number, number]
}

export interface MyResume {
  skills: { name: string; alpha: number; beta: number; score?: number }[]
  /** 第91轮：能力值卡数据源（服务端未上线时为空数组） */
  abilities: AbilityRow[]
  /** 第91轮：账号全局门槛（无领取任务时能力卡目标值兜底） */
  gateThreshold?: number
  totalAnswered?: number
  /** 准确率（已归一为 0-100；服务端给 0-1 小数时换算） */
  accuracy?: number
  taskCount?: number
}

/** 第91轮：三态中文标签（mode_matrix 的 task_mode → 人话；两端一致）。 */
export const MODE_LABEL: Record<string, string> = { production: '正式', practice: '练习', exam: '考核' }
/** 第91轮：角色中文标签（与 PC MyResume.tsx 同款）。 */
export const ROLE_LABEL: Record<string, string> = { executor: '执行', verifier: '审核', publisher: '出题' }
/** 第91轮：0-1 小数 → 百分数文本（≤1 一律视为比例；mean/门槛/CI 同规则）。 */
export const fmtPct = (v: number): string => `${Math.round(v <= 1.0001 ? v * 100 : v)}%`

/** 错误分类：UI 按 kind 区分提示（没账号 / 平台未就绪 / 网络 / HTTP）。 */
export class YoulingApiError extends Error {
  constructor(message: string, readonly kind: 'no-account' | 'not-ready' | 'network' | 'http') {
    super(message)
  }
}

/** 任务落地页（服务端未给 url 时的约定拼接）。 */
export function youlingTaskUrl(taskId: string): string {
  return `${YOULING_BASE}/task/${taskId}`
}

// ── 解析层（纯函数，导出供单测；多字段名兜底）──

const numOf = (v: unknown): number | undefined =>
  (typeof v === 'number' && Number.isFinite(v)) ? v : (typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined)
const strOf = (v: unknown): string | undefined =>
  (typeof v === 'string' && v !== '') ? v : undefined

/** 第91轮：任务门槛宽容解析（服务端路径未定稿：task_threshold/gateThreshold/
 *  profile_filter 下各门槛键 / modes 内门槛字段多键兜底；数字字符串也吃）。 */
function pickThreshold(t: Record<string, unknown>, m: Record<string, unknown> | null): number | undefined {
  const pf = (t.profile_filter ?? t.profileFilter) as Record<string, unknown> | undefined
  const pfObj = pf && typeof pf === 'object' ? pf : {}
  const cands: unknown[] = [
    t.task_threshold, t.gate_threshold, t.gateThreshold, t.threshold,
    pfObj.gateThreshold, pfObj.gate_threshold, pfObj.threshold, pfObj.gate, pfObj.min_ability, pfObj.min_mean,
    m?.task_threshold, m?.gate_threshold, m?.gateThreshold, m?.threshold,
  ]
  for (const c of cands) { const n = numOf(c); if (n != null) return n }
  return undefined
}

/** 第91轮：ci95 宽容解析：[lo,hi] 数组 / {lo,hi}|{lower,upper} 对象 → 元组。 */
function parseCi95(v: unknown): [number, number] | undefined {
  if (Array.isArray(v)) {
    const lo = numOf(v[0]), hi = numOf(v[1])
    return lo != null && hi != null ? [lo, hi] : undefined
  }
  if (v && typeof v === 'object') {
    const c = v as Record<string, unknown>
    const lo = numOf(c.lo ?? c.low ?? c.lower ?? c.min)
    const hi = numOf(c.hi ?? c.high ?? c.upper ?? c.max)
    return lo != null && hi != null ? [lo, hi] : undefined
  }
  return undefined
}

/** 解析任务列表：容忍 data 包裹 / 裸数组 / {tasks|list} 键三种形态。
 *  第91轮（产品定稿）：新形态 tasks[].modes 三态视图**只保留已领取**的态——
 *  `my_claim != null || my_assigned > 0 || my_answered > 0`（production=领取/派单，
 *  exam/practice 无领取概念用 my_answered，practice 恒 0 不误纳）；标题 name →
 *  回退 task_id（不再"未命名任务"）。旧扁平形态兼容保留。 */
export function parseYoulingTasks(j: unknown): YoulingTask[] {
  const d = (j as Record<string, unknown> | null)?.data ?? j
  const arr: unknown[] = Array.isArray(d)
    ? d
    : Array.isArray((d as Record<string, unknown>)?.tasks) ? (d as { tasks: unknown[] }).tasks
      : Array.isArray((d as Record<string, unknown>)?.list) ? (d as { list: unknown[] }).list
        : []
  const out: YoulingTask[] = []
  for (const raw of arr) {
    const t = (raw ?? {}) as Record<string, unknown>
    const taskId = strOf(t.taskId ?? t.task_id ?? t.id)
    if (!taskId) continue // 无 id 的行无法跳落地页，丢弃
    const title = strOf(t.name ?? t.title ?? t.taskTitle) ?? taskId // 第91轮：回退 task_id
    if (t.modes && typeof t.modes === 'object' && !Array.isArray(t.modes)) {
      // 新形态：三态卡投影——逐 mode 过滤领取信号，未领取的态不进列表
      for (const [mode, mv] of Object.entries(t.modes as Record<string, unknown>)) {
        if (!mv || typeof mv !== 'object') continue
        const m = mv as Record<string, unknown>
        const claim = m.my_claim ?? m.myClaim
        const assigned = numOf(m.my_assigned ?? m.myAssigned) ?? 0
        const answered = numOf(m.my_answered ?? m.myAnswered) ?? 0
        if (claim == null && assigned <= 0 && answered <= 0) continue
        const claimObj = (claim && typeof claim === 'object' ? claim : {}) as Record<string, unknown>
        out.push({
          taskId,
          title,
          slaText: strOf(t.slaText ?? t.sla ?? t.sla_text),
          pendingCount: assigned > 0 ? assigned : undefined,
          answeredToday: answered > 0 ? answered : undefined,
          url: strOf(t.url) ?? youlingTaskUrl(taskId),
          mode,
          threshold: pickThreshold(t, m),
          role: strOf(t.role ?? t.worker_role ?? claimObj.role),
        })
      }
      continue
    }
    // 旧扁平形态（字段未定稿期兼容；旧响应语义本就是"我的任务"全集）
    out.push({
      taskId,
      title,
      slaText: strOf(t.slaText ?? t.sla ?? t.sla_text),
      pendingCount: numOf(t.pendingCount ?? t.pending ?? t.pending_count),
      answeredToday: numOf(t.answeredToday ?? t.answered_today ?? t.answered),
      url: strOf(t.url) ?? youlingTaskUrl(taskId),
      mode: strOf(t.task_mode ?? t.mode),
      threshold: pickThreshold(t, null),
      role: strOf(t.role ?? t.worker_role),
    })
  }
  return out
}

/** 解析能力值：skills/abilities 多键名兜底；accuracy 0-1 小数归一为百分比。
 *  第91轮：abilities（role/mean/α/β/ci95）+ 账号全局门槛；服务端只给 abilities
 *  时映射成 skills 行让既有 MyResume 视图继续有内容。 */
export function parseMyResume(j: unknown): MyResume | null {
  const d = (j as Record<string, unknown> | null)?.data ?? j
  if (!d || typeof d !== 'object') return null
  const o0 = d as Record<string, unknown>
  // 信封内 resume 对象（真实形态 {did, resume:{derived,records,abilities,...}}）
  const resumeObj = (o0.resume && typeof o0.resume === 'object' && !Array.isArray(o0.resume) ? o0.resume : o0) as Record<string, unknown>
  const derived = (resumeObj.derived && typeof resumeObj.derived === 'object' ? resumeObj.derived : {}) as Record<string, unknown>
  const rawAbilities: unknown[] = Array.isArray(resumeObj.abilities)
    ? resumeObj.abilities
    : Array.isArray(derived.abilities) ? derived.abilities : []
  const abilities: AbilityRow[] = rawAbilities.map((raw) => {
    const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    return {
      role: strOf(a.role ?? a.skill) ?? 'executor',
      mean: numOf(a.mean ?? a.score),
      alpha: numOf(a.alpha) ?? 0,
      beta: numOf(a.beta) ?? 0,
      ci95: parseCi95(a.ci95 ?? a.ci ?? a.confidence_interval),
    }
  })
  const rawSkills: unknown[] = Array.isArray(o0.skills)
    ? o0.skills
    : Array.isArray(o0.resume) ? o0.resume
      : Array.isArray(o0.items) ? o0.items
        : []
  const skills = rawSkills.map((raw) => {
    const s = (raw ?? {}) as Record<string, unknown>
    return {
      name: strOf(s.name ?? s.skill ?? s.skillName) ?? '技能',
      alpha: numOf(s.alpha) ?? 0,
      beta: numOf(s.beta) ?? 0,
      score: numOf(s.score),
    }
  })
  // 服务端走 abilities 新形态时，把 abilities 映射成 skills 行（既有 MyResume 视图零改动可用）
  const skillsOrFromAbilities = skills.length > 0 ? skills : abilities.map((a) => ({ name: a.role, alpha: a.alpha, beta: a.beta }))
  const accRaw = numOf(o0.accuracy ?? o0.acc ?? o0.accuracyPct)
  const accuracy = accRaw == null ? undefined : accRaw <= 1 ? accRaw * 100 : accRaw
  return {
    skills: skillsOrFromAbilities,
    abilities,
    gateThreshold: numOf(resumeObj.gate_threshold ?? derived.gate_threshold ?? resumeObj.account_threshold ?? derived.account_gate),
    totalAnswered: numOf(o0.totalAnswered ?? o0.total_answered ?? o0.answered),
    accuracy,
    taskCount: numOf(o0.taskCount ?? o0.task_count ?? o0.tasks),
  }
}

// ── 网络层 ──

const FETCH_TIMEOUT_MS = 6000

/** GET JSON：无签名首试 → 403 时 X-Did-Auth 签名重试一次；HTML 响应=ENV 未就绪。
 *  /env/* 走 ENV_API_BASE（/myco-env 反代 :9000）——不走 YOULING_BASE 站根，
 *  那里 /env/* 是 SPA fallback 返回 HTML（第90轮修的手机任务拉不到 bug）。 */
async function getJson(path: string): Promise<unknown> {
  const doFetch = (extra?: Record<string, string>): Promise<Response> => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    return fetch(`${ENV_API_BASE}${path}`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', ...extra },
    }).finally(() => clearTimeout(timer))
  }
  let r: Response
  try {
    r = await doFetch()
    if (r.status === 403 || r.status === 401) {
      // 设备签名重试（did-auth.ts 铺的协议；GET 空 body 参与签名）
      const ident = resolveDidAuthSigningIdentity()
      if (ident) {
        r = await doFetch({ 'X-Did-Auth': signDidAuthHeader(ident.did, ident.seed, new Uint8Array(0)) })
      }
    }
  } catch {
    throw new YoulingApiError('连不上有灵平台', 'network')
  }
  const ct = r.headers.get('content-type') || ''
  if (ct.includes('text/html')) {
    // nginx SPA fallback——ENV 端点未部署（2026-09-28 实测形态）
    throw new YoulingApiError('有灵 ENV 接口未就绪', 'not-ready')
  }
  if (!r.ok) throw new YoulingApiError(`HTTP ${r.status}`, 'http')
  try {
    return await r.json()
  } catch {
    throw new YoulingApiError('响应不是有效 JSON', 'http')
  }
}

function requireDid(): string {
  const did = myAccountDid()
  if (!did) throw new YoulingApiError('能力值需要 youling 账号绑定', 'no-account')
  return did
}

/** 拉我在 youling 领取的任务（观察面：每次现拉，不缓存）。 */
export async function fetchYoulingTasks(): Promise<YoulingTask[]> {
  return parseYoulingTasks(await getJson(`/env/worker/${encodeURIComponent(requireDid())}/tasks`))
}

/** 拉我的能力值 resume；服务端返回空体/空对象时返回 null（视为暂无数据）。 */
export async function fetchMyResume(): Promise<MyResume | null> {
  return parseMyResume(await getJson(`/env/agents/${encodeURIComponent(requireDid())}/resume`))
}
