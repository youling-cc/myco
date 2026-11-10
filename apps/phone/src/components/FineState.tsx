/**
 * FineState — H4 细态（11 态）的 UI 消费三件套（phone/canvas 共用单一源）。
 *
 * 数据源：beliefStore 的 fineState/appState/appType/approval（state 事件驱动，
 * 见 belief-store.ts）。细态判态在 ta 的规则引擎（docs/harness-state-union.md §7），
 * 这里只做呈现 + 按键分派。
 *
 * 三件套：
 *  ① FineStateBadge —— 细态文案徽章（生成中/执行工具/等待批准/选择菜单/已中断/出错/空闲…）
 *  ② ApprovalCard  —— awaiting_approval 的「需要批准」卡片（摘要 + 批准/拒绝）
 *  ③ error_blocked 的红色提示条由 ChatView 直接渲染（本文件只出文案/样式类名）
 *
 * 按键语义差异（docs/harness-state-union.md §4，按 harness 分派）：
 *  claude：1/2/3 + Enter（数字选中后需回车）
 *  kimi：  1/2/3/4 数字直选（敲数字即生效，不要回车）
 *  codex： y/n + Enter（y/n 确认行；真实审批框田野未达，同 y/n 语义）
 */
import { ShieldQuestion } from 'lucide-react'

/** 细态 → 文案/配色。fineState 缺失时回退粗态（旧 ta / 未命中规则的通用终端）。 */
export interface FineStateMeta {
  /** 徽章样式类（phone-chat.css .fs-badge-*） */
  cls: string
  label: string
  /** 是否呼吸动画（进行态/需注意态） */
  pulse: boolean
}

const FINE_META: Record<string, FineStateMeta> = {
  starting:           { cls: 'working',  label: '启动中',     pulse: true },
  idle_ready:         { cls: 'idle',     label: '空闲',       pulse: false },
  generating:         { cls: 'working',  label: '生成中',     pulse: true },
  tool_running:       { cls: 'working',  label: '执行工具',   pulse: true },
  awaiting_approval:  { cls: 'approval', label: '等待批准',   pulse: true },
  picker_open:        { cls: 'waiting',  label: '选择菜单',   pulse: false },
  interrupted:        { cls: 'waiting',  label: '已中断',     pulse: false },
  error_blocked:      { cls: 'error',    label: '出错',       pulse: true },
  exiting:            { cls: 'idle',     label: '退出中',     pulse: false },
  compacting:         { cls: 'working',  label: '压缩上下文', pulse: true },
  auth_required:      { cls: 'error',    label: '需要登录',   pulse: true },
}

/** 粗态兜底（fineState 为 null：旧 ta 或未知终端）。 */
const COARSE_META: Record<string, FineStateMeta> = {
  working:       { cls: 'working', label: '运行中',   pulse: true },
  waiting_input: { cls: 'waiting', label: '等待输入', pulse: true },
  idle:          { cls: 'idle',    label: '空闲',     pulse: false },
}

export function fineStateMeta(fineState?: string | null, appState?: string | null): FineStateMeta | null {
  if (fineState && FINE_META[fineState]) return FINE_META[fineState]
  if (appState && COARSE_META[appState]) return COARSE_META[appState]
  return null
}

/** 细态文案徽章。无状态（还没收到任何 state 事件）不渲染。 */
export function FineStateBadge({ fineState, appState }: { fineState?: string | null; appState?: string | null }) {
  const meta = fineStateMeta(fineState, appState)
  if (!meta) return null
  return (
    <span className={`fs-badge fs-badge-${meta.cls}${meta.pulse ? ' fs-pulse' : ''}`}>
      {meta.label}
    </span>
  )
}

/** 一次注入动作：text=文本注入 / key=特殊键（透传 terminal-agent）。 */
export interface InjectStep {
  text?: string
  key?: string
}

/** 归一化 harness 标识：appType（claude_code/kimi_code/codex）优先，否则按 command 猜。 */
export function resolveHarness(appType?: string | null, command?: string): 'claude' | 'kimi' | 'codex' | 'zcode' | 'unknown' {
  const t = (appType ?? '').toLowerCase()
  if (t === 'claude_code') return 'claude'
  if (t === 'kimi_code') return 'kimi'
  if (t === 'codex') return 'codex'
  const c = (command ?? '').toLowerCase()
  if (c.includes('claude')) return 'claude'
  if (c.includes('kimi')) return 'kimi'
  if (c.includes('codex')) return 'codex'
  if (c.includes('zcode')) return 'zcode'
  return 'unknown'
}

/** 审批按键序列（按 harness 分派；approve=false=拒绝）。
 *  unknown 兜底用 claude 语义（1+Enter）——fineState 只有命中 harness 规则才会是
 *  awaiting_approval，unknown 实际走不到这里，兜底只是防守。 */
export function approvalSteps(harness: string, approve: boolean): InjectStep[] {
  switch (harness) {
    case 'kimi':
      // 数字直选：1=Approve once / 3=Reject（敲数字即生效，不回车）
      return [{ text: approve ? '1' : '3' }]
    case 'codex':
      // y/n 确认行：y+Enter / n+Enter
      return [{ text: approve ? 'y' : 'n' }, { key: 'enter' }]
    case 'claude':
    default:
      // 1. Yes / 3. No：数字选中 + Enter 确认
      return [{ text: approve ? '1' : '3' }, { key: 'enter' }]
  }
}

/** 「需要批准」卡片：awaiting_approval 时挂消息流尾部。
 *  点击后由调用方按 approvalSteps 注入；卡片消失由 state 事件驱动（细态翻转）。 */
export function ApprovalCard({
  summary,
  busy,
  onApprove,
  onReject,
}: {
  /** 审批内容摘要（ta 屏幕提取；空=通用文案）。 */
  summary?: string | null
  busy: boolean
  onApprove: () => void
  onReject: () => void
}) {
  return (
    <div className="approval-card">
      <div className="approval-card-head">
        <ShieldQuestion size={15} />
        <span>需要批准</span>
      </div>
      <div className="approval-card-summary">{summary?.trim() || '智能体请求一项操作授权（详情见终端视图）'}</div>
      <div className="approval-card-actions">
        <button className="approval-btn approve" disabled={busy} onClick={onApprove}>批准</button>
        <button className="approval-btn reject" disabled={busy} onClick={onReject}>拒绝</button>
      </div>
    </div>
  )
}
