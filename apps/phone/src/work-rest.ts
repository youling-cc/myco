/**
 * work-rest — 连续工作/休息计时（2026-09-01 设计定稿）。
 *
 * 语义：
 *  - 连续工作 = 本工作块累计时长（多轮累加：turn 间用户插入不打断）；
 *    空闲（无 pending）超过 30s → 工作块结束，下次工作从 0 重计。
 *  - 休息 = 自工作块最后一次 gen_end 起的空闲累计（工作中不显示休息）。
 * 数据源：beliefStore 的 pending（非空=工作中），前端 1s tick 推进——纯 UI 层
 * 派生态（C 层已有 per-turn workingSec，这里是跨轮块聚合，不落盘）。
 */
import { create } from 'zustand'
import { useBeliefStore } from './belief-store'

/** 空闲超过该值(秒) → 工作块重置 */
export const REST_RESET_SEC = 30

export interface WorkRestState {
  working: boolean
  /** 本工作块累计 ms（>30s 空闲后清零重计） */
  workMs: number
  /** 自上次 gen_end 起的休息累计 ms（从未工作过=0） */
  restMs: number
  /** 上次工作结束时刻(ms epoch)；null=从未工作 */
  lastEnd: number | null
}

interface Store {
  bySid: Record<string, WorkRestState>
  tick: number
}

const EMPTY: WorkRestState = { working: false, workMs: 0, restMs: 0, lastEnd: null }

export const useWorkRestStore = create<Store>(() => ({ bySid: {}, tick: 0 }))

let timer: ReturnType<typeof setInterval> | null = null
/** 全局 1s tick：懒启动（首个订阅者触发），随页面存续。 */
export function ensureWorkRestTicker() {
  if (timer) return
  timer = setInterval(() => {
    const beliefs = useBeliefStore.getState().beliefs
    const prev = useWorkRestStore.getState().bySid
    const next: Record<string, WorkRestState> = {}
    const now = Date.now()
    // 只推进"有人订阅过"的 sid（首见=登记）+ belief 里 working 的 sid
    const sids = new Set([...Object.keys(prev), ...Object.keys(beliefs)])
    for (const sid of sids) {
      const working = !!beliefs[sid]?.pending
      const p = prev[sid] ?? EMPTY
      if (working) {
        // 工作中：工作块 +1s；休息清零（新块开始时 lastEnd 已在转换处处理）
        next[sid] = { working: true, workMs: p.workMs + 1000, restMs: 0, lastEnd: null }
      } else {
        if (p.working || p.lastEnd === null) {
          // 刚结束工作（或首见非工作态）：锚定结束时刻
          const lastEnd = p.working ? now : p.lastEnd
          next[sid] = { working: false, workMs: p.workMs, restMs: 0, lastEnd }
        } else {
          const restMs = now - p.lastEnd
          // 空闲超阈值 → 工作块重置（休息继续累计显示）
          const workMs = restMs > REST_RESET_SEC * 1000 ? 0 : p.workMs
          next[sid] = { working: false, workMs, restMs, lastEnd: p.lastEnd }
        }
      }
    }
    useWorkRestStore.setState({ bySid: next, tick: now })
  }, 1000)
}

/** 组件订阅：ensureTicker + 按 sid 取态。 */
export function useWorkRest(sid: string): WorkRestState {
  ensureWorkRestTicker()
  return useWorkRestStore((s) => s.bySid[sid] ?? EMPTY)
}

/** 计时格式：s → Xm → Xh → Xd（用户要求：休息按分/小时/更大单位）。 */
export function fmtDur2(ms: number): string {
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ''}`
  const d = Math.floor(h / 24)
  return `${d}d${h % 24 ? `${h % 24}h` : ''}`
}
