/**
 * AgentCard — 后台 agent（Task/Agent 工具 spawn 的 subagent）的可视化卡片。
 * 2026-09-05 用户需求：「有后台的 agent，UI 上怎么体现？感知到、认知出来，
 * 还能点开看什么 agent，在干嘛」。
 *
 * 折叠态：👥 类型 · 一句话描述 + 状态徽章（运行中 spinner / ✓ 完成）。
 * 展开态：「任务」=prompt 全文（长则折叠）+「报告」=notification 回填的 result。
 * 降级：无 params（老数据/proxy 早期）用 summary；都无则工具名兜底。
 */
import { useState } from 'react'
import type { ToolCall } from '../transport'

const RUNNING_ICON = '⏳'
const DONE_ICON = '✓'

export function AgentCard({ t }: { t: ToolCall }) {
  const [open, setOpen] = useState(false)
  let params: { subagentType?: string; description?: string } = {}
  try {
    params = t.params ? JSON.parse(t.params) : {}
  } catch { /* 老数据 params 非严格 JSON → 空 */ }
  const sub = params.subagentType || 'agent'
  const desc = params.description || t.summary || ''
  const running = t.status === 'running'
  const done = t.status === 'completed'
  // status 缺省（老 jsonl/通知丢失置中性）=未知态：不转圈不打勾
  const prompt = t.input ?? ''

  return (
    <div className={`agent-card${running ? ' agent-running' : ''}${done ? ' agent-done' : ''}`}>
      <button className="agent-card-head" onClick={() => setOpen(!open)} title={open ? '收起' : '展开任务与报告'}>
        <span className="tool-ic">👥</span>
        <span className="agent-kind">{sub}</span>
        {desc && <span className="agent-desc">· {desc.length > 48 ? desc.slice(0, 48) + '…' : desc}</span>}
        <span className={`agent-badge${done ? ' done' : running ? ' run' : ''}`}>
          {done ? `${DONE_ICON} 完成` : running ? `${RUNNING_ICON} 运行中` : ''}
        </span>
        <span className="agent-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="agent-card-body">
          {prompt && (
            <div className="agent-section">
              <div className="agent-section-label">任务</div>
              <div className="agent-prompt">{prompt.length > 600 && !open ? prompt.slice(0, 600) + '…' : prompt}</div>
            </div>
          )}
          {t.result && (
            <div className="agent-section">
              <div className="agent-section-label">报告</div>
              <div className="agent-result">{t.result.length > 4000 ? t.result.slice(0, 4000) + '…' : t.result}</div>
            </div>
          )}
          {!prompt && !t.result && <div className="agent-section muted">（无详情）</div>}
        </div>
      )}
    </div>
  )
}
