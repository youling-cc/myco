/**
 * TodoPanel — 会话「计划」的有效周期呈现（钉在消息区与输入框之间，不随消息滚走）。
 *
 * 数据源（2026-09-02 稳定化）：ta 从 jsonl 事件序重放（TodoWrite 全量替换/TaskCreate
 * 追加/TaskUpdate 改态 → read_task_state）→ live.todos → todos 事件。此前屏尾刮取的是
 * claude 瞬时渲染，滚动/重绘/继续对话即丢；jsonl 重放跨轮稳定，冷启动/重订阅也恢复。
 *
 * 三态（2026-09-05 用户问"任务进度对 llm 有没有结束的说法"）：Claude Code 无"计划作废"
 * 事件——列表进上文的方式只是历史工具调用记录，不压缩就一直在；所以"有效"只能按可检测
 * 信号判定，三态呈现：
 *   active：有未完成项且模型近期仍在维护（之后 <3 轮且 <24h）→ 正常展开
 *   done  ：全部完成 → 自动收成一行（标题+计数+进度条仍常驻，状态不丢）
 *   stale ：模型 ≥3 轮没再碰 或 最后事件 >24h → 收成一行灰显「上一轮计划」，
 *           tooltip 说明判据；点击仍可展开查看（历史参考，非当前上文意图）
 * 手动折叠/展开不被自动收展覆盖（只在跨界时触发）。
 * phone/canvas/aop 共用。
 */
import { useEffect, useState } from 'react'
import type { TodoState } from '../belief-store'

const ICON: Record<string, string> = {
  completed: '✓',
  in_progress: '◐',
  pending: '◻',
}

/** 过去时判据：模型 N 轮没碰 / 最后事件超 M 小时（任一命中即 stale） */
const STALE_TURNS = 3
const STALE_MS = 24 * 3600 * 1000

export function TodoPanel({ todos }: { todos: TodoState }) {
  const [open, setOpen] = useState(true)
  const items = todos.items ?? []
  const done = items.filter((i) => i.status === 'completed').length
  const pct = items.length ? Math.round((done / items.length) * 100) : 0
  const allDone = items.length > 0 && done === items.length
  const turns = todos.turnsAfter ?? 0
  const ageMs = todos.lastAtMs ? Date.now() - todos.lastAtMs : 0
  const stale = items.length > 0 && (turns >= STALE_TURNS || (ageMs > 0 && ageMs > STALE_MS))
  // 自动收展：完成→收起；stale→收起；新一轮工作/计划复活→展开。只跨态触发。
  const activeState = allDone ? 'done' : stale ? 'stale' : 'active'
  const [prevS, setPrevS] = useState(activeState)
  useEffect(() => {
    if (prevS !== activeState) {
      if (activeState === 'active') setOpen(true)
      else setOpen(false)
      setPrevS(activeState)
    }
  }, [activeState, prevS])
  const title = stale ? '上一轮计划' : '任务进度'
  const tip = stale
    ? `模型已 ${turns} 轮未更新此计划${ageMs > 0 ? `（最后 ${new Date(todos.lastAtMs!).toLocaleString()}）` : ''}——仅历史参考，非当前上文意图`
    : open ? '收起计划' : '展开计划'
  return (
    <div className={`todo-panel${open ? '' : ' collapsed'}${stale ? ' stale' : ''}`}>
      <div className="todo-head" onClick={() => setOpen((o) => !o)} title={tip}>
        <span className="todo-title">{stale ? '🗄' : '📋'} {title}<span className="todo-caret">{open ? '▾' : '▸'}</span></span>
        <span className="todo-count">{done}/{items.length} · {pct}%</span>
      </div>
      <div className="todo-bar">
        <div className="todo-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      {open && (
        <ul className="todo-items">
          {items.map((it, i) => (
            <li key={i} className={`todo-item is-${it.status}`}>
              <span className="todo-icon">{ICON[it.status] ?? '◻'}</span>
              <span className="todo-text">{it.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
