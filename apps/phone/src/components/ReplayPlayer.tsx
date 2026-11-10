/** ReplayPlayer — 传感器语料回放播放器(phone/canvas/monitor 共用单一源,同 FineState 模式)。
 *
 * 内核(canvas main.tsx bare=chatview 回放分支抽出,R2 产品化):
 *  - renderTo(i) = clearSession + ensureSession + 重折 events[0..i]——belief 是 fold,
 *    单帧后退靠整体重折,事件量小毫秒级,不要做事件逆操作。
 *  - play() 按事件 __at 间隔节拍(÷speed,gap 封顶 1200ms;__at 是 parse 时注入的外层
 *    节拍源,payload 里的 atMs 多数事件没有,别回退)。
 *  - 事件 sessionId 重映射到展示影子会话(belief.sessionMeta 一并重映射)。
 *
 * UI 层 2026-08-28 产品化重构(K3 评审定稿,用户视角三原则:信息分层/播放器心智/用户语言):
 *  - 控制条=底部 dock 替换输入框槽位(ChatView replayFooter),不再右上角悬浮;
 *  - 进度条=事件序号线性 + 可拖 seek(拖动只动视觉,松手才整体重折) + 密度热区
 *    (序号段对应录制时间跨度,密=深——语料节奏一眼可见);
 *  - 术语:完整录制/部分录制、事件(不暴露 golden/宽松等内部词);
 *  - 循环速度钮 1→2→4→8→20x(localStorage 记忆);键盘 空格/←→/Shift+←→/Home/End;
 *  - 播完终态 ended(主钮变重播+结束提示);断点续播由 ReplayView 按 meta.id 存取。
 *
 * 配套铁律:回放模式必须拦 transport.history()(影子会话在真 ta 404),input/key 必须
 * no-op(回放不产生副作用)——用 replaySafe() 包任意 base transport。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatBeliefStore } from '../belief-store'
import type { SensorCorpus } from '../transport'

export interface ReplayPlayerState { idx: number; playing: boolean; speed: number; total: number; ended: boolean }

export interface ReplayPlayer {
  state: ReplayPlayerState
  renderTo: (i: number) => void
  play: () => Promise<void>
  pause: () => void
  step: (d: number) => void
  restart: () => void
  setSpeed: (v: number) => void
  /** 第 i 个事件(0-based)的录制时刻 ms;无时刻=0。 */
  eventAt: (i: number) => number
  /** 1x 播放节拍下的预计总时长 ms(按 1200ms 封顶口径)。 */
  durationMs: number
}

export function makePlayer(opts: {
  corpus: SensorCorpus
  displaySid: string
  replayTask: string
  speed?: number
  /** 进度回调:kind=seek(用户跳转,应立即持久化)|play(播放节拍,调用方可节流)。 */
  onTick?: (idx: number, kind: 'play' | 'seek') => void
}): ReplayPlayer {
  const { corpus, displaySid, replayTask } = opts
  const events = corpus.events.map((e0) => {
    const e = { ...e0, sessionId: displaySid } as {
      sessionId: string
      __at?: number
      belief?: { sessionMeta?: { sessionId: string; taskId: string } }
    }
    if (e.belief?.sessionMeta) {
      e.belief = { ...e.belief, sessionMeta: { ...e.belief.sessionMeta, sessionId: displaySid, taskId: replayTask } }
    }
    return e
  })
  const atOf = (i: number) => Number(events[i]?.__at ?? 0)
  // 预计时长:相邻事件 gap(min(gap,1200)) 之和——与 play() 节拍同口径
  let durationMs = 0
  for (let i = 0; i < events.length - 1; i++) {
    const a = atOf(i), b = atOf(i + 1)
    durationMs += b > a ? Math.min(b - a, 1200) : 50
  }
  const st: ReplayPlayerState = {
    idx: 0, playing: false, speed: opts.speed ?? 4, total: events.length, ended: false,
  }
  const store = () => useChatBeliefStore.getState()
  const emitSeek = () => opts.onTick?.(st.idx, 'seek')
  const renderTo = (i: number) => {
    const n = Math.max(0, Math.min(events.length, i))
    const s = store()
    s.clearSession(displaySid)
    s.ensureSession(displaySid, replayTask)
    for (let k = 0; k < n; k++) s.applyObservationEvent(events[k] as never)
    st.idx = n
    st.ended = n >= events.length && events.length > 0
    emitSeek()
  }
  return {
    state: st,
    renderTo,
    eventAt: atOf,
    durationMs,
    async play() {
      if (st.playing) return
      if (st.idx >= events.length) renderTo(0) // 播完后再按播放=重播
      st.playing = true
      while (st.playing && st.idx < events.length) {
        const e = events[st.idx]
        store().applyObservationEvent(e as never)
        st.idx++
        const next = events[st.idx]
        const at = Number(e.__at ?? 0)
        const nat = next ? Number(next.__at ?? 0) : at
        const gap = nat > at ? Math.min(nat - at, 1200) / st.speed : 50
        opts.onTick?.(st.idx, 'play')
        await new Promise((r) => setTimeout(r, gap))
      }
      st.playing = false
      if (st.idx >= events.length) st.ended = true
      opts.onTick?.(st.idx, 'seek')
    },
    pause() { st.playing = false },
    step(d) { st.playing = false; renderTo(st.idx + d) },
    restart() { st.playing = false; renderTo(0) },
    setSpeed(v) { st.speed = v },
  }
}

/** 回放安全 transport 包装(原型链包一层):
 *  - history 返回空页(影子会话在真 ta 不存在,不拦会报 "Session not found");
 *  - input/key/send 无副作用(回放只读铁律)。 */
export function replaySafe<T extends object>(base: T): T {
  const noop = async () => ({ ok: true })
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    history: async () => ({ lines: [], messages: [], total: 0, from: 0, count: 0 }),
    input: noop,
    key: noop,
    send: noop,
  }) as T
}

/* ------------------------------------------------------------------ */
/* 底部播放器 dock(K3 定稿:播放器心智=进度条在底部;五钮 SVG 图标——铁律  */
/* 不用符号字形,手机 webview/无头浏览器缺字体成空框)。                    */
/* ------------------------------------------------------------------ */

const SPEEDS = [1, 2, 4, 8, 20]
const SPEED_KEY = 'myco-replay-speed'

const loadSpeed = (): number => {
  const v = Number(localStorage.getItem(SPEED_KEY) ?? '')
  return SPEEDS.includes(v) ? v : 4
}
const saveSpeed = (v: number) => { try { localStorage.setItem(SPEED_KEY, String(v)) } catch { /* 隐私模式等 */ } }

/** 录制时刻 → HH:MM:SS(跨天带日期)。 */
export function fmtRecordClock(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const today = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  return d.toDateString() === today.toDateString() ? hm : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`
}

/** 时长 ms → 「6:12」/「1:06:12」。 */
export function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`
}

/** 主题变量双命名链:monitor 用 --tx/--bd/--mu,home/canvas 用 --text/--border/--muted。
 *  只写一套会在另一套环境踩 undefined 兜底(浅主题下白字落白底=隐形,踩过)。 */
const TX = 'var(--tx, var(--text, #e6edf3))'
const BD = 'var(--bd, var(--border, #2d333b))'
const MU = 'var(--mu, var(--muted, #8b949e))'
const BG3 = 'var(--bg3, #1c2333)'
const AC = 'var(--ac, var(--accent, #6b7bff))'

const ICON: React.CSSProperties = { width: 16, height: 16, display: 'block', flexShrink: 0 }

function IconSkipBack() {
  return <svg viewBox="0 0 24 24" style={ICON}><path d="M6 5h2v14H6zM20 5v14L9.5 12z" fill="currentColor" /></svg>
}
function IconStepBack() {
  return <svg viewBox="0 0 24 24" style={ICON}><path d="M18 5v14L8 12z" fill="currentColor" /></svg>
}
function IconStepFwd() {
  return <svg viewBox="0 0 24 24" style={ICON}><path d="M6 5v14l10-7z" fill="currentColor" /></svg>
}
function IconSkipFwd() {
  return <svg viewBox="0 0 24 24" style={ICON}><path d="M16 5h2v14h-2zM4 5v14l10.5-7z" fill="currentColor" /></svg>
}
function IconPlay() {
  return <svg viewBox="0 0 24 24" style={ICON}><path d="M7 4.5v15L20 12z" fill="currentColor" /></svg>
}
function IconPause() {
  return <svg viewBox="0 0 24 24" style={ICON}><path d="M6.5 5h3.5v14H6.5zM14 5h3.5v14H14z" fill="currentColor" /></svg>
}
function IconReplay() {
  return <svg viewBox="0 0 24 24" style={ICON}><path d="M12 5V1.8L7.2 6 12 10.2V7a5.5 5.5 0 1 1-5.4 6.6l-2 .4A7.5 7.5 0 1 0 12 5z" fill="currentColor" /></svg>
}

/**
 * 回放控制 dock(底部,替换 ChatView 输入框槽位)。
 * player=null 且 disabled 时渲染禁用占位(加载中防布局跳动)。
 * hint:加载进度等顶部小字;播完自动显示结束提示。
 */
export function ReplayBar({ player, disabled, hint }: {
  player: ReplayPlayer | null
  disabled?: boolean
  hint?: string
}) {
  const [, setTick] = useState(0)
  const [drag, setDrag] = useState<{ idx: number } | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 200)
    return () => clearInterval(t)
  }, [])

  const st = player?.state
  const total = st?.total ?? 0
  const shownIdx = drag ? drag.idx : (st?.idx ?? 0)
  const clock = player ? fmtRecordClock(player.eventAt(Math.max(0, Math.min(total - 1, shownIdx)))) : ''

  // 键盘:空格 播/停,←→ ±1,Shift+←→ ±10,Home/End 首尾(回放态无输入框,可全局接管)
  useEffect(() => {
    if (!player || disabled) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === ' ') { e.preventDefault(); if (player.state.playing) player.pause(); else void player.play() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); player.step(e.shiftKey ? -10 : -1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); player.step(e.shiftKey ? 10 : 1) }
      else if (e.key === 'Home') { e.preventDefault(); player.restart() }
      else if (e.key === 'End') { e.preventDefault(); player.renderTo(player.state.total) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [player, disabled])

  // 密度热区:序号均分 60 段,每段录制时间跨度(短=密=亮)。min-max 归一化把
  // 跨度差异视觉放大(语料整体偏均匀时 0.15..0.7 的线性映射会看不出条纹)。
  const density = useMemo(() => {
    if (!player || total < 10) return null
    const N = 60
    const spans: number[] = []
    for (let b = 0; b < N; b++) {
      const lo = Math.floor((b * total) / N), hi = Math.max(lo + 1, Math.floor(((b + 1) * total) / N))
      spans.push(Math.max(0, player.eventAt(Math.min(hi - 1, total - 1)) - player.eventAt(lo)))
    }
    const max = Math.max(...spans), min = Math.min(...spans)
    if (max <= min) return spans.map(() => 0.4)
    return spans.map((s) => 0.12 + 0.68 * ((max - s) / (max - min)))
  }, [player, total])

  const idxFromX = (clientX: number) => {
    const el = trackRef.current
    if (!el || !total) return 0
    const r = el.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    return Math.round(ratio * total)
  }
  const pct = total ? `${(shownIdx / total) * 100}%` : '0%'

  const btn = (main = false): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: main ? 34 : 28, height: main ? 34 : 28,
    borderRadius: main ? 999 : 8, cursor: disabled ? 'default' : 'pointer',
    border: `1px solid ${main ? 'transparent' : BD}`,
    background: main ? AC : 'transparent',
    color: main ? '#fff' : TX,
    opacity: disabled ? 0.4 : 1,
    padding: 0,
  })

  const speed = st?.speed ?? loadSpeed()
  const cycleSpeed = () => {
    if (!player) return
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]
    player.setSpeed(next) // 切速不打断播放、不重置位置(setSpeed 只改节拍分母)
    saveSpeed(next)
    setTick((x) => x + 1)
  }

  return (
    <div className="myco-replay-dock" style={{
      width: '100%', display: 'flex', flexDirection: 'column', gap: 5,
      padding: '7px 14px 9px', fontFamily: 'system-ui',
      borderTop: `1px solid ${BD}`, background: 'var(--bg2, rgba(22,27,34,.92))',
    }}>
      {/* 顶行:提示位(加载进度/回放结束;平时空着不占视觉) */}
      <div style={{ minHeight: 13, fontSize: 10, color: MU, display: 'flex', alignItems: 'center', gap: 8 }}>
        {st?.ended && !st.playing && <span>回放结束 · 共 {total} 事件 · 空格重播</span>}
        {!st?.ended && hint && <span>{hint}</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button style={btn()} disabled={disabled} title="回到开头(Home)" onClick={() => player?.restart()}><IconSkipBack /></button>
        <button style={btn()} disabled={disabled} title="上一事件(←)" onClick={() => player?.step(-1)}><IconStepBack /></button>
        <button
          style={btn(true)}
          disabled={disabled}
          title={st?.playing ? '暂停(空格)' : st?.ended ? '重播(空格)' : '播放(空格)'}
          onClick={() => { if (!player) return; if (player.state.playing) player.pause(); else void player.play() }}
        >
          {st?.playing ? <IconPause /> : st?.ended ? <IconReplay /> : <IconPlay />}
        </button>
        <button style={btn()} disabled={disabled} title="下一事件(→)" onClick={() => player?.step(1)}><IconStepFwd /></button>
        <button style={btn()} disabled={disabled} title="跳到结尾(End)" onClick={() => player?.renderTo(player?.state.total ?? 0)}><IconSkipFwd /></button>

        {/* 进度条:事件序号线性;拖动只动视觉,松手才整体重折 */}
        <div
          ref={trackRef}
          style={{ flex: 1, minWidth: 60, height: 18, display: 'flex', alignItems: 'center', cursor: disabled ? 'default' : 'pointer', position: 'relative', touchAction: 'none' }}
          onPointerDown={(e) => {
            if (disabled || !player) return
            e.currentTarget.setPointerCapture(e.pointerId)
            setDrag({ idx: idxFromX(e.clientX) })
          }}
          onPointerMove={(e) => { if (drag) setDrag({ idx: idxFromX(e.clientX) }) }}
          onPointerUp={() => {
            if (drag && player) player.renderTo(drag.idx)
            setDrag(null)
          }}
        >
          <div style={{ position: 'relative', width: '100%', height: 6, borderRadius: 3, background: BG3, overflow: 'hidden' }}>
            {density && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex' }}>
                {density.map((a, i) => (
                  <span key={i} style={{ flex: 1, background: AC, opacity: Math.min(0.85, a + 0.15) }} />
                ))}
              </div>
            )}
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: pct, background: AC, borderRadius: 3, opacity: 0.95 }} />
          </div>
          <div style={{ position: 'absolute', left: pct, top: '50%', transform: 'translate(-50%,-50%)', width: 12, height: 12, borderRadius: '50%', background: AC, border: '2px solid var(--bg2,#161b22)', boxShadow: '0 1px 4px rgba(0,0,0,.35)' }} />
          {drag && (
            <div style={{
              position: 'absolute', bottom: '100%', left: pct, transform: 'translateX(-50%)',
              background: BG3, color: TX, border: `1px solid ${BD}`, borderRadius: 6,
              padding: '2px 8px', fontSize: 10, whiteSpace: 'nowrap', pointerEvents: 'none',
            }}>
              #{drag.idx}{clock ? ` · ${fmtRecordClock(player?.eventAt(Math.max(0, Math.min(total - 1, drag.idx))) ?? 0)}` : ''}
            </div>
          )}
        </div>

        <span style={{ color: TX, fontSize: 11.5, fontVariantNumeric: 'tabular-nums', minWidth: 64, textAlign: 'right' }}>
          {shownIdx}/{total}
        </span>
        <span style={{ color: MU, fontSize: 10.5, fontVariantNumeric: 'tabular-nums', minWidth: 52, textAlign: 'right' }}>{clock}</span>
        <button
          onClick={cycleSpeed}
          disabled={disabled}
          title={`播放速度(循环 1→2→4→8→20x,当前 ${speed}x)`}
          style={{
            padding: '3px 9px', cursor: disabled ? 'default' : 'pointer', fontSize: 11.5, fontVariantNumeric: 'tabular-nums',
            border: `1px solid ${BD}`, borderRadius: 7, background: BG3, color: TX, opacity: disabled ? 0.4 : 1,
          }}
        >
          {speed}x
        </button>
      </div>
    </div>
  )
}
