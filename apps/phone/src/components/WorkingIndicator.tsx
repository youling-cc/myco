/**
 * WorkingIndicator — AI 执行中等待指示(K3 定稿 2026-08-28:圆环流光计时)。
 *
 * 14px 旋转弧圆环(进程感)+中心呼吸点(生命感),双色信号合一;计时 Ns→Nm Ns
 * 分秒切换,tabular-nums 防抖动;长等待分级克制——60s 旋转降速+文案"仍在处理"
 * (变慢而非变快,快=焦虑),180s 追加次级提示;全程锚定 --mc-accent 不换告警色
 * (等待不是错误)。曾方案=typing-dots+透传 claude 终端 statusText(●/⎿/Esc 杂
 * 字符),用户实测嫌乱,废弃。
 *
 * 2026-09-02 状态胶囊条:action=忙态动词中文(思考中/检索中/…,ta 从 spinner 行
 * 提炼——是提炼不是镜像,键位提示不透传);tokens=本轮用量("34.5k")。
 * "AI 在忙什么·进行多久·用了多少"一条看完,信息密度上去版面不乱。
 * 纯展示组件:ta 会话(pending.workingSec)与 zcode 桥(轮询 status+本地计时)
 * 同一组件零分支驱动。
 */
export function WorkingIndicator({
  elapsedSec,
  extra,
  action,
  tokens,
  agents,
}: {
  elapsedSec: number
  extra?: string
  /** 忙态动词中文(思考中/检索中…);缺省回退"正在生成/仍在处理" */
  action?: string | null
  /** 本轮 token 用量(原始值,渲染成 34.5k) */
  tokens?: number | null
  /** 后台 agent 运行集(2026-09-05 可视化):>0 显示并发计数 chip */
  agents?: import('../transport').AgentLive[]
}) {
  const tone = elapsedSec > 180 ? 'long' : elapsedSec > 60 ? 'slow' : 'normal'
  const label = action || (elapsedSec > 60 ? '仍在处理' : '正在生成')
  return (
    <div className="working-indicator" data-tone={tone}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ flexShrink: 0 }}>
        <circle cx="7" cy="7" r="5.5" className="ring-track" />
        <circle cx="7" cy="7" r="5.5" className="ring-arc"
          strokeDasharray={`${2 * Math.PI * 5.5 * 0.25} ${2 * Math.PI * 5.5 * 0.75}`} strokeLinecap="round" />
        <circle cx="7" cy="7" r="2" className="ring-dot" style={{ transformOrigin: '7px 7px' }} />
      </svg>
      <span className="working-text">
        {/* k3 终审建议:0s 时只显文案不显秒(起帧更细腻,≥1s 再上计时) */}
        {elapsedSec > 0 ? `${label} · ${fmtElapsed(elapsedSec)}` : `${label}…`}
      </span>
      {tokens != null && tokens > 0 && (
        <span className="working-tokens" title={`本轮 token 用量 ${tokens.toLocaleString()}`}>
          {fmtTokens(tokens)} tok
        </span>
      )}
      {agents && agents.length > 0 && (
        <span className="working-tokens working-agents" title={agents.map((a) => `${a.subagentType ?? 'agent'}: ${a.description ?? ''}`).join('\n')}>
          ⬥ {agents.length} 后台 agent
        </span>
      )}
      {tone === 'long' && <span className="working-extra">{extra ?? '长任务生成中,可继续等待'}</span>}
    </div>
  )
}

function fmtElapsed(s: number): string {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60 ? `${s % 60}s` : ''}`.trim()
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${n}`
}
