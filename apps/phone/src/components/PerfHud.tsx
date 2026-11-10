/**
 * PerfHud — 开发用性能 HUD（默认关，localStorage 'myco.perf'==='1' 才挂）。
 *
 * 量化三类指标：
 *  - FPS：rAF 滚动窗口（最近 1s 帧时间戳算帧率），滚动时读这个
 *  - 展开/折叠耗时：外部 perf.markExpand() 记录 click→下一帧 paint 的耗时
 *  - 重渲计数：本组件每次 React 重渲 +1（观察订阅粒度是否真的把 messages 隔开）
 *
 * 不进生产构建体积也无所谓（小）；想彻底下线就删挂载点。
 */
import { useEffect, useRef, useState } from 'react'

let expandLastMs = 0
let expandMaxMs = 0
let chatRenders = 0
const expandListeners = new Set<() => void>()

/** 记录一次展开/折叠切换的 click→paint 耗时（ChatView 包 setExpandTools 用）。 */
export function markExpand(ms: number) {
  expandLastMs = ms
  if (ms > expandMaxMs) expandMaxMs = ms
  expandListeners.forEach((fn) => fn())
}

/** ChatView 每次重渲调一次——观察订阅粒度是否真把 messages 隔开（gen_progress 期间应几乎不涨）。 */
export function bumpChatRender() {
  chatRenders += 1
  expandListeners.forEach((fn) => fn())
}

export function resetChatRenders() {
  chatRenders = 0
  expandListeners.forEach((fn) => fn())
}

export function isPerfOn(): boolean {
  try {
    return localStorage.getItem('myco.perf') === '1'
  } catch {
    return false
  }
}

export function PerfHud() {
  const [fps, setFps] = useState(0)
  const [fpsMin, setFpsMin] = useState(60)
  const [, force] = useState(0)
  const frames = useRef<number[]>([])
  const renderCount = useRef(0)
  const lastFpsReset = useRef(performance.now())

  useEffect(() => {
    let raf = 0
    const loop = () => {
      const now = performance.now()
      frames.current.push(now)
      // 滚动窗口：只保留最近 1000ms 的帧
      const cutoff = now - 1000
      while (frames.current.length && frames.current[0] < cutoff) frames.current.shift()
      if (now - lastFpsReset.current >= 500) {
        const f = frames.current.length
        setFps(f)
        // 滚动期最低 FPS（每 500ms 衰减一次，反映最近一段最差帧）
        if (f < fpsMinRef.current) {
          fpsMinRef.current = f
          setFpsMin(f)
        }
        lastFpsReset.current = now
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const fpsMinRef = useRef(60)
  // 鼠标进入 HUD 时重置最低值（开始新一轮测量）
  const resetMin = () => { fpsMinRef.current = 60; setFpsMin(60) }

  useEffect(() => {
    const fn = () => force((n) => n + 1)
    expandListeners.add(fn)
    return () => { expandListeners.delete(fn) }
  }, [])

  renderCount.current += 1
  const color = fps >= 50 ? '#3fdb6e' : fps >= 30 ? '#f5a623' : '#ff5a52'
  void chatRenders
  return (
    <div
      onMouseEnter={resetMin}
      style={{
        position: 'fixed', right: 10, top: 10, zIndex: 9999,
        background: 'rgba(20,22,28,.92)', color: '#e8e8ea',
        fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, lineHeight: 1.5,
        padding: '7px 9px', borderRadius: 7, pointerEvents: 'auto',
        boxShadow: '0 4px 18px rgba(0,0,0,.4)', minWidth: 150,
      }}
      title="鼠标移上来重置最低 FPS（开始新一轮测量）"
    >
      <div style={{ color, fontWeight: 700, fontSize: 14 }}>{fps} FPS</div>
      <div>最低(近): <span style={{ color: fpsMin >= 45 ? '#9be' : '#f5a623' }}>{fpsMin}</span></div>
      <div>展开: {expandLastMs.toFixed(1)}ms / max {expandMaxMs.toFixed(1)}ms</div>
      <div>ChatView 渲染: {chatRenders} <span style={{opacity:.5,fontSize:10}}>(gen_progress 期间应几乎不涨)</span></div>
      <div style={{ opacity: .55, fontSize: 10 }}>HUD 帧: {renderCount.current}</div>
    </div>
  )
}
