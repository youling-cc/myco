// MyResume.tsx — 我的作业档案（有灵简历渲染器，第88轮→89轮重写适配真实 API）。
//
// 数据源：GET /env/agents/{did}/resume（已公开读，无需 key）
// 真实响应：{did, resume: {records[], derived: {by_role, kappa, total_earned}}}
// 本组件只做渲染：经验值 + 任务参与 + 收入 + 记录列表。不存本地。
//
// 空数据（没做过任务）→ "还没有做过任务" + 去做题按钮。

import { useEffect, useState } from 'react'

type EnvResult = { ok?: boolean; status?: number; data?: unknown; message?: string }

type RoleStat = { tasks?: number }

/** 第91轮：能力画像行（服务端 resume.abilities：Beta 后验 role/mean/α/β/ci95）。 */
export type YoulingAbility = { role: string; mean: number | null; alpha: number; beta: number; ci95: [number, number] | null }

interface ParsedResume {
  kappa: number
  totalEarned: number | null
  roles: { role: string; tasks: number }[]
  recordCount: number
  /** 第91轮：能力值卡数据源（服务端未上线 abilities 时=空数组，UI 优雅降级） */
  abilities: YoulingAbility[]
  /** 第91轮：账号全局门槛（无领取任务时能力卡目标值兜底；无则 null → 显示"—"） */
  gateThreshold: number | null
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** ci95 宽容解析：[lo,hi] 数组 / {lo,hi}|{lower,upper} 对象 → 元组；其余 null。 */
function parseCi95(v: unknown): [number, number] | null {
  if (Array.isArray(v)) {
    const lo = numOrNull(v[0]), hi = numOrNull(v[1])
    return lo != null && hi != null ? [lo, hi] : null
  }
  if (v && typeof v === 'object') {
    const c = v as Record<string, unknown>
    const lo = numOrNull(c.lo ?? c.low ?? c.lower ?? c.min)
    const hi = numOrNull(c.hi ?? c.high ?? c.upper ?? c.max)
    return lo != null && hi != null ? [lo, hi] : null
  }
  return null
}

/** 解析真实 resume 响应：{resume:{derived:{by_role,kappa,total_earned},records}} */
export function parseResume(res: EnvResult | null | undefined): ParsedResume | null {
  if (!res) return null
  // Rust 层出参 {ok,data} → data 即 ENV 响应（有 persona 信封再解一层）
  let d: unknown = res.ok ? res.data : null
  if (d && typeof d === 'object') {
    const o = d as Record<string, unknown>
    if (o.resume && typeof o.resume === 'object') d = o.resume
    else if (o.data && typeof o.data === 'object') {
      const o2 = o.data as Record<string, unknown>
      if (o2.resume && typeof o2.resume === 'object') d = o2.resume
      else d = o2
    }
  }
  if (!d || typeof d !== 'object') return null
  const o = d as Record<string, unknown>
  const derived = (o.derived && typeof o.derived === 'object' ? o.derived : {}) as Record<string, unknown>
  const byRole = (derived.by_role && typeof derived.by_role === 'object' ? derived.by_role : {}) as Record<string, unknown>
  const roles: { role: string; tasks: number }[] = []
  for (const [role, v] of Object.entries(byRole)) {
    const rs = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
    const tasks = num(rs.tasks ?? rs.task_count ?? rs.count)
    if (tasks > 0 || role === 'executor') roles.push({ role, tasks })
  }
  const records = Array.isArray(o.records) ? o.records : []
  const earned = derived.total_earned ?? derived.totalEarned
  // 第91轮：abilities 宽容定位（resume.abilities / derived.abilities，字段路径未定稿多键兜底）
  const abilities: YoulingAbility[] = (Array.isArray(o.abilities) ? o.abilities : Array.isArray(derived.abilities) ? derived.abilities : [])
    .map((raw) => {
      const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      return {
        role: String(a.role ?? a.skill ?? '') || 'executor',
        mean: numOrNull(a.mean ?? a.score),
        alpha: numOrNull(a.alpha) ?? 0,
        beta: numOrNull(a.beta) ?? 0,
        ci95: parseCi95(a.ci95 ?? a.ci ?? a.confidence_interval),
      }
    })
  const gateThreshold = numOrNull(o.gate_threshold ?? derived.gate_threshold ?? o.account_threshold ?? derived.account_gate)
  return {
    kappa: num(derived.kappa ?? o.kappa),
    totalEarned: typeof earned === 'number' && earned > 0 ? earned : null,
    roles: roles.length > 0 ? roles : [{ role: 'executor', tasks: 0 }],
    recordCount: records.length,
    abilities,
    gateThreshold,
  }
}

const ROLE_LABEL: Record<string, string> = { executor: '执行', verifier: '审核', publisher: '出题' }
export { ROLE_LABEL }

/** 全屏作业档案视图。 */
export function MyResume({ onClose }: { onClose: () => void }) {
  const [res, setRes] = useState<EnvResult | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    setLoading(true)
    void import('@tauri-apps/api/core')
      .then((m) => m.invoke('youling_my_resume') as Promise<EnvResult>)
      .then((r) => { if (alive) setRes(r) })
      .catch((e) => { if (alive) setRes({ ok: false, status: 0, message: String(e) }) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])
  const p = parseResume(res)
  const hasData = p && (p.kappa > 0 || p.recordCount > 0 || p.roles.some((r) => r.tasks > 0))
  return (
    <section className="sec grow demo-scr" style={{ overflowY: 'auto', padding: '14px 13px 18px', display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div className="backrowd"><button className="bk" onClick={onClose}>‹ 返回</button></div>
      <div className="h2d">📊 我的作业档案</div>
      <div className="tinyd">做越多题、做对越多，能力值越高——这是你在有灵的作业记录</div>

      {loading && <div className="tinyd" style={{ padding: '20px 0', textAlign: 'center' }}>拉取中…</div>}

      {!loading && hasData && p && (
        <>
          {/* 概览 */}
          <div className="cardd" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-around', padding: '14px 10px' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>{p.kappa}</div>
              <div className="tinyd">经验值</div>
            </div>
            {p.roles.map((r) => (
              <div key={r.role} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>{r.tasks}</div>
                <div className="tinyd">{ROLE_LABEL[r.role] || r.role}任务</div>
              </div>
            ))}
            {p.totalEarned != null && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#e65100' }}>{p.totalEarned}</div>
                <div className="tinyd">积分</div>
              </div>
            )}
          </div>
          {p.recordCount > 0 && (
            <div className="cardd">
              <div className="h2d" style={{ fontSize: 12.5 }}>共 {p.recordCount} 条记录</div>
              <div className="tinyd">详细记录在youling网页查看</div>
            </div>
          )}
        </>
      )}

      {!loading && !hasData && (
        <div className="cardd" style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
          <div className="subd">还没有做过任务</div>
          <div className="tinyd">去有灵领第一个任务，答题后这里会长出你的作业档案</div>
          <button className="btnd ghost" style={{ maxWidth: 200 }} onClick={() => void import('@tauri-apps/api/core').then(async (m) => {
            let url = 'https://myco.youling.cc/'
            try { url = (await m.invoke('auto_login_url', { pageUrl: url })) as string } catch { /* 降级 */ }
            try { await m.invoke('open_external', { url }) } catch { window.open(url) }
          })}>去有灵领任务 →</button>
        </div>
      )}
    </section>
  )
}
