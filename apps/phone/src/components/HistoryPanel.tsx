/**
 * 历史对话面板（lazy 感知历史状态）。
 *
 * AOP 视角：这是 web 端 agent 对"历史 belief"的**按需感知**——平时不拉
 * （远端不囤历史省内存），用户上滑/打开时才向 ta 请求 jsonl 对话流。
 * ta 是唯一状态权威，手机只是临时缓存已看过的片段。
 *
 * 渲染：claude jsonl 的 assistant 消息是 markdown（含代码块），用 react-markdown
 * + remark-gfm + rehype-highlight 渲染——代码块语法高亮，比终端 16 色更清楚。
 * user 消息纯文本气泡。往上滑到顶自动加载更早（lazy pagination）。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import 'highlight.js/styles/github-dark.css'
import { type Transport, type SessionInfo } from '../transport'
import { MessageBubble } from './MessageBubble'
import { filterGeneratingLines } from './genTextFilter'
import { PickerView } from './PickerView'
import { quickThemes } from '../chat-themes'
import { useChatTheme } from '../use-chat-theme'
import { useBeliefStore } from '../belief-store'

const PAGE = 50

export function HistoryPanel({
  transport,
  session,
  onClose,
}: {
  transport: Transport
  session: SessionInfo
  onClose: () => void
}) {
  // 用 beliefStore（s'）：messages/pending 来自订阅 ta belief-events 融合（o'→s'）。
  const belief = useBeliefStore((s) => s.beliefs[session.sessionId])
  const ensureSession = useBeliefStore((s) => s.ensureSession)
  const appendHistory = useBeliefStore((s) => s.appendHistory)

  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const firstLoadedRef = useRef(false)

  const messages = belief?.messages ?? []
  const total = belief?.historyTotal ?? 0
  const hasMore = belief?.historyHasMore ?? true
  const pending = belief?.pending
  const interactive = belief?.interactive ?? false
  const sendKey = (k: string) => transport.key(session, k).catch(() => {})

  // 进 panel：建 belief + 拉最近一批（之后 subscribe 事件流持续融合）
  const loadRecent = useCallback(async () => {
    setLoading(true); setErr(null)
    ensureSession(session.sessionId, session.taskId)
    try {
      const page = await transport.history(session, undefined, PAGE)
      appendHistory(session.sessionId, { messages: page.messages, total: page.total, count: page.count }, false)
      firstLoadedRef.current = true
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setLoading(false)
    }
  }, [transport, session, ensureSession, appendHistory])

  const loadOlder = useCallback(async () => {
    const b = useBeliefStore.getState().beliefs[session.sessionId]
    if (!b || loading || !b.historyHasMore) return
    setLoading(true); setErr(null)
    try {
      const page = await transport.history(session, b.historyLoadedFrom, PAGE)
      if (page.messages.length > 0) {
        appendHistory(session.sessionId, { messages: page.messages, total: page.total, count: page.count }, true)
      }
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setLoading(false)
    }
  }, [transport, session, loading, appendHistory])

  // 打开即拉最近一批
  useEffect(() => { loadRecent() }, [loadRecent])

  // 上滑到顶 sentinel 进入视口 → 加载更早
  useEffect(() => {
    const root = scrollRef.current
    const sentinel = topSentinelRef.current
    if (!root || !sentinel) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some(e => e.isIntersecting && firstLoadedRef.current)) {
          loadOlder()
        }
      },
      { root, rootMargin: '80px 0px 0px 0px' },
    )
    io.observe(sentinel)
    return () => io.disconnect()
  }, [loadOlder])

  const [theme, setTheme] = useChatTheme()
  const themeVars = {
    '--mc-accent': theme.accent,
    '--mc-accent-2': theme.accent2,
    '--mc-glow-1': theme.glow1,
    '--mc-glow-2': theme.glow2,
  } as CSSProperties

  return (
    <div className="history-panel" style={themeVars}>
      <div className="history-head">
        <span className="history-title">📜 历史对话 · {total} 条</span>
        {/* 主题圆点切换器（mac 三色圆圈风） */}
        <div className="theme-dots" title="切换主题色">
          {quickThemes().map((t) => (
            <button
              key={t.id}
              className={`theme-dot ${t.id === theme.id ? 'active' : ''}`}
              style={{ background: t.dot }}
              onClick={() => setTheme(t.id)}
              title={t.name}
            />
          ))}
        </div>
        <button className="cmd-close" onClick={onClose}>✕</button>
      </div>
      {err && <div className="banner err">{err}</div>}
      <div className="history-scroll" ref={scrollRef}>
        <div ref={topSentinelRef} className="history-sentinel">
          {loading && firstLoadedRef.current && <span className="spinner" />}{' '}
          {hasMore ? '上滑加载更早…' : !loading && messages.length > 0 ? '—— 没有更早了 ——' : ''}
        </div>
        {messages.map((m, i) => (
          <MessageBubble key={i} m={m} />
        ))}
        {/* 正在生成（pending，spinner 状态行 + gen_progress 实时文本 + 停止按钮） */}
        {pending?.appState === 'working' && (
          <div className="msg msg-assistant msg-pending">
            <div className="msg-role">
              🤖 claude
              {/* 停止按钮（播放器停止键风，点=发 Esc 给 claude 打断） */}
              <button
                className="stop-btn"
                onClick={() => transport.key(session, 'esc').catch(() => {})}
                title="停止生成"
                aria-label="停止生成"
              >
                <span className="stop-square" />
              </button>
            </div>
            <div className="msg-body">
              {/* 2026-09-05:statusText/generatingText 统一过 genTextFilter——原样直出
                  会把 TUI 键位提示/思维链原文/XML 泄露进气泡（用户实测报的乱源） */}
              {(() => {
                const st = filterGeneratingLines(pending.statusText ?? '')
                const first = st.lines.filter((l) => l.kind === 'status' || l.kind === 'tool').slice(-1)[0]
                return first ? <div className="spinner-status">{first.text}</div> : null
              })()}
              {pending.generatingText ? (
                (() => {
                  const { lines } = filterGeneratingLines(pending.generatingText)
                  const shown = lines.slice(-3)
                  return (
                    <div className="generating-text">
                      {shown.map((g, i) => (
                        <div key={i} className={`gen-line${g.kind === 'thought' ? ' gen-thought' : g.kind === 'result' ? ' gen-result' : ''}`}>
                          <span className="gen-marker">{g.kind === 'result' ? '↳' : g.kind === 'thought' ? '∼' : '·'}</span>{g.text}
                        </div>
                      ))}
                      <span className="gen-cursor">▌</span>
                    </div>
                  )
                })()
              ) : (
                !pending.statusText && (
                  <><span className="typing-dots"><span /><span /><span /></span><span style={{ marginLeft: 8 }}>正在生成 · 已用 {pending.workingSec}s</span></>
                )
              )}
            </div>
          </div>
        )}
        {!loading && messages.length === 0 && !err && (
          <div className="history-empty">还没有历史对话</div>
        )}
      </div>

      {/* 交互选择界面（picker）：渲染 claude 的 /rewind /context 等列表，选中高亮，方向键操作 */}
      {belief?.picker ? (
        <PickerView picker={belief.picker} onKey={sendKey} />
      ) : interactive && (
        <div className="nav-pad">
          <button className="nav-key" onClick={() => sendKey('up')}>↑</button>
          <button className="nav-key" onClick={() => sendKey('down')}>↓</button>
          <button className="nav-key" onClick={() => sendKey('enter')}>⏎</button>
          <button className="nav-key nav-esc" onClick={() => sendKey('esc')}>Esc</button>
        </div>
      )}
    </div>
  )
}
