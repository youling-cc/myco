/**
 * MyResume — 我的能力值视图（第88轮）。
 *
 * youling 平台 ENV 感知面的 resume 展示：每技能一行（名称 + α/(α+β) 进度条 + 百分比），
 * 底部总计（已答 N 题 · 准确率 N% · 参与 N 任务）。观察面哲学：每次现拉
 * （/env/agents/{did}/resume），30s 周期刷新，本端零存储。
 *
 * 降级：无账号锚 → 「能力值需要有灵账号绑定」；ENV 未部署/网络不通 →
 * 低调提示 + 自动重试（API 上线后自动工作，不挡其他功能）。
 * 挂载：TaskList 提供全屏 overlay（与 YoulingLogin 同款深色玻璃），本组件是内容面板。
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { fetchMyResume, type MyResume as MyResumeData, YoulingApiError } from '../youling-tasks'

type Phase = 'loading' | 'ok' | 'no-account' | 'not-ready' | 'network' | 'http'

/** 单技能行：名称 + α/β 双色进度条 + 百分比（Beta 后验均值 α/(α+β)）。 */
function SkillRow({ name, alpha, beta }: { name: string; alpha: number; beta: number }) {
  const total = alpha + beta
  const pct = total > 0 ? (alpha / total) * 100 : null
  return (
    <div style={{ padding: '9px 0', borderTop: '1px solid rgba(255,255,255,.08)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: '#e8ecf6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <span style={{ fontSize: 10.5, color: 'rgba(200,210,235,.55)', fontFamily: 'monospace', flexShrink: 0 }}>α{fmtNum(alpha)} β{fmtNum(beta)}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: pct == null ? 'rgba(200,210,235,.4)' : '#9db8ff', width: 44, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {pct == null ? '—' : `${pct.toFixed(0)}%`}
        </span>
      </div>
      {/* 进度条：底槽半透明 + 主渐变（与 YoulingLogin 按钮同色系）；无数据只画底槽 */}
      <div style={{ height: 6, borderRadius: 999, background: 'rgba(255,255,255,.1)', overflow: 'hidden' }}>
        {pct != null && (
          <div style={{ width: `${Math.max(pct, 2)}%`, height: '100%', borderRadius: 999, background: 'linear-gradient(90deg,#7c5cff,#4d8dff)' }} />
        )}
      </div>
    </div>
  )
}

/** 数值显示：整数直接显示，小数保留 1 位（α/β 可能是累计计数或小数权重）。 */
function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export function MyResume({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [data, setData] = useState<MyResumeData | null>(null)

  const load = useCallback(async (silent: boolean) => {
    if (!silent) setPhase('loading')
    try {
      const r = await fetchMyResume()
      setData(r)
      setPhase('ok')
    } catch (e) {
      setPhase(e instanceof YoulingApiError ? e.kind : 'network')
    }
  }, [])

  // 进视图拉一次 + 30s 周期（切后台暂停，回前台下一拍补拉）
  useEffect(() => {
    void load(false)
    const t = setInterval(() => { if (!document.hidden) void load(true) }, 30_000)
    const onVis = () => { if (!document.hidden) void load(true) }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [load])

  return (
    <div style={{
      width: '100%', maxWidth: 420, maxHeight: '86vh', overflowY: 'auto',
      borderRadius: 16, padding: '16px 16px 12px',
      background: 'linear-gradient(160deg,rgba(24,30,48,.97),rgba(16,20,34,.97))',
      border: '1px solid rgba(124,92,255,.25)',
      boxShadow: '0 18px 50px rgba(0,0,0,.5)',
    }}>
      {/* 顶栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 16 }}>📊</span>
        <b style={{ fontSize: 16, color: '#eef1fa', flex: 1 }}>我的能力档案</b>
        <button onClick={() => void load(false)} title="立即刷新" style={btnGhost}>↻</button>
        <button onClick={onClose} style={btnGhost}>✕</button>
      </div>
      <div style={{ fontSize: 11, color: 'rgba(200,210,235,.5)', marginBottom: 8 }}>有灵平台贡献画像 · 每 30 秒自动刷新</div>

      {phase === 'loading' && (
        <div style={{ textAlign: 'center', padding: '34px 0', fontSize: 13, color: 'rgba(200,210,235,.7)' }}>
          <span className="spinner" style={{ display: 'inline-block', marginRight: 8 }} />正在拉取能力值…
        </div>
      )}

      {phase === 'no-account' && (
        <div style={{ textAlign: 'center', padding: '30px 8px' }}>
          <div style={{ fontSize: 30, marginBottom: 8 }}>🔗</div>
          <div style={{ fontSize: 13.5, color: '#e8ecf6', fontWeight: 600, marginBottom: 6 }}>能力值需要有灵账号绑定</div>
          <div style={{ fontSize: 12, color: 'rgba(200,210,235,.6)', lineHeight: 1.6 }}>
            在有灵平台领取任务、参与答题后，这里会展示你的技能画像
          </div>
        </div>
      )}

      {(phase === 'not-ready' || phase === 'network' || phase === 'http') && (
        <div style={{ textAlign: 'center', padding: '30px 8px' }}>
          <div style={{ fontSize: 26, marginBottom: 8 }}>🛰</div>
          <div style={{ fontSize: 13, color: 'rgba(200,210,235,.75)', marginBottom: 6 }}>
            {phase === 'network' ? '连不上有灵平台（检查网络）' : '有灵能力值接口尚未就绪'}
          </div>
          <div style={{ fontSize: 11.5, color: 'rgba(200,210,235,.45)' }}>接口上线后自动展示，无需更新 App</div>
        </div>
      )}

      {phase === 'ok' && data && (
        <>
          {data.skills.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '26px 8px', fontSize: 13, color: 'rgba(200,210,235,.7)' }}>
              还没有技能记录——去有灵平台领取任务开始答题吧
            </div>
          ) : (
            data.skills.map((s, i) => <SkillRow key={`${s.name}-${i}`} name={s.name} alpha={s.alpha} beta={s.beta} />)
          )}
          {/* 总计行 */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexWrap: 'wrap',
            marginTop: 10, padding: '9px 10px', borderRadius: 10,
            background: 'rgba(124,92,255,.1)', fontSize: 12, color: '#c3cdf2',
          }}>
            {data.totalAnswered != null && <span>已答 <b style={{ color: '#e8ecf6' }}>{data.totalAnswered}</b> 题</span>}
            {data.totalAnswered != null && data.accuracy != null && <span style={{ opacity: .4 }}>·</span>}
            {data.accuracy != null && <span>准确率 <b style={{ color: '#9db8ff' }}>{data.accuracy.toFixed(0)}%</b></span>}
            {data.taskCount != null && <span style={{ opacity: .4 }}>·</span>}
            {data.taskCount != null && <span>参与 <b style={{ color: '#e8ecf6' }}>{data.taskCount}</b> 任务</span>}
            {data.totalAnswered == null && data.accuracy == null && data.taskCount == null && (
              <span style={{ opacity: .6 }}>暂无总计数据</span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** 顶部小按钮（ghost）。 */
const btnGhost: CSSProperties = {
  width: 30, height: 30, borderRadius: 9, border: '1px solid rgba(124,92,255,.35)',
  background: 'transparent', color: '#c3cdf2', fontSize: 13, cursor: 'pointer', flexShrink: 0,
}
