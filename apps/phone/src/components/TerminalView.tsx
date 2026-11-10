/**
 * TerminalView — raw 终端风格视图（mac 终端原味）。
 *
 * 关键：claude 的 console buffer 有 9999 行历史，但 claude 重绘 spinner 会把
 * **窗口** snap 回光标，所以移动窗口无效。解法：**不动窗口，直接按 offset 读 buffer**
 * （ta 的 /buffer 端点读任意区段）。TerminalView 维护一个 scrollOffset，本地滚到边界
 * 就移动 offset 翻 buffer 里的历史，window.top 即"实时"位置（live）。
 *
 *   - offset == liveTop（window.top）→ 显示实时屏，随 claude 写入更新。
 *   - offset < liveTop → 显示历史区段，顶部"⏵ 返回最新"按钮可跳回。
 *
 * **reflow（M-Term P3）**：不锁 PC 的 cols×rows。按容器实际像素宽 / 字宽算出
 * phoneCols，把 PC 物理行先拼回逻辑行再按 phoneCols 重断（term-reflow.ts 纯函数）：
 *   - model 模式：ta 回 wrapped 标记（alacritty WRAPLINE）精确拼行，覆盖 scrollback；
 *   - screen 模式：无标记，"满宽行与下行拼接"启发式；
 *   - 无 cells 的老 ta/snap：文本行合成默认色单元格走同一 reflow。
 * offset/翻页语义不变（仍按 PC buffer 行）。
 *
 * **truecolor**：CharInfo 带可选 fgRgb/bgRgb（仅 model 模式 24bit 色），有值直接用，
 * 否则退回 mac 风格 16 色调色板。深色背景 + mac 终端字体栈。
 *
 * 渲染：重排后的行按相同样式合并成 run；光标块反相闪烁（仅 live 且光标在区段内）。
 * A−/A+ 调字号适配各屏。键条透传 ↑↓⏎Esc Tab。
 *
 * 滚动换算：本地视口在区段内是原生 overflow 平移；撞顶继续滚 → offset 上移看更早；
 * 撞底继续滚 → offset 下移趋近 live。发 offset 变化即重拉。
 *
 * phone/canvas 共用（canvas 经 @phone 引）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Transport, SessionInfo, BufferRegion, CharInfo } from '../transport'
import { reflow, cellsFromLines } from '../term-reflow'

/** 颜色由后端 alacritty model 解析 VT 序列后直传 RGB(truecolor/256色/16色全覆盖);
 *  fgRgb/bgRgb 缺省(=NamedColor::Foreground/Background)时用标准终端默认色。 */
const TERM_FG_DEFAULT = '#e5e5e5'

/** mac 终端字体栈：SF Mono（Apple 设备）→ 各平台常见等宽 → 系统等宽兜底。 */
const TERM_FONT = "'SF Mono',Menlo,Monaco,'Cascadia Mono','JetBrains Mono','Roboto Mono',Consolas,ui-monospace,monospace"

const rgbCss = (rgb: [number, number, number]) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`

/** cell 前景色 css:后端 RGB 直传;缺省=标准终端文本色。 */
const fgCss = (c: Pick<CharInfo, 'fg' | 'fgRgb'>) => c.fgRgb ? rgbCss(c.fgRgb) : TERM_FG_DEFAULT
const bgCss = (c: Pick<CharInfo, 'bg' | 'bgRgb'>) => c.bgRgb ? rgbCss(c.bgRgb) : 'transparent'

interface Seg {
  text: string
  fg: CharInfo['fg']
  bg: CharInfo['bg']
  fgRgb?: CharInfo['fgRgb']
  bgRgb?: CharInfo['bgRgb']
  inverse: boolean
  underline: boolean
  cursor: boolean
}

/** 一行 cell 按相同样式合并成 run；cursorCell ≥ 0 时该 cell 单独成段画光标块。 */
function segments(cells: CharInfo[] | undefined, cursorCell: number): Seg[] {
  if (!cells || cells.length === 0) {
    return [{ text: ' ', fg: 7, bg: 0, inverse: false, underline: false, cursor: cursorCell === 0 }]
  }
  const segs: Seg[] = []
  let cur: Seg | null = null
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]
    const isCursor = i === cursorCell
    const sameRgb = (a?: readonly number[], b?: readonly number[]) =>
      a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2])
    if (cur && cur.fg === c.fg && cur.bg === c.bg && sameRgb(cur.fgRgb, c.fgRgb) && sameRgb(cur.bgRgb, c.bgRgb)
      && cur.inverse === c.inverse && !!cur.underline === !!c.underline && cur.cursor === isCursor) {
      cur.text += c.ch ?? ' '
    } else {
      cur = { text: c.ch ?? ' ', fg: c.fg, bg: c.bg, fgRgb: c.fgRgb, bgRgb: c.bgRgb, inverse: c.inverse, underline: !!c.underline, cursor: isCursor }
      segs.push(cur)
    }
  }
  return segs.length ? segs : [{ text: ' ', fg: 7, bg: 0, inverse: false, underline: false, cursor: false }]
}

export function TerminalView({ transport, session, onKey }: {
  transport: Transport
  session: SessionInfo
  onKey: (k: string) => void
}) {
  const [font, setFont] = useState<number>(() => Number(localStorage.getItem('myco-term-font')) || 13)
  const [region, setRegion] = useState<BufferRegion | null>(null)
  // offset = 当前显示区段的 buffer 起始行；null=跟随 live（首次拉到 window.top 后赋值）
  const [offset, setOffset] = useState<number | null>(null)
  const [showKeys, setShowKeys] = useState(false)
  // 视口实际尺寸（ResizeObserver）→ 算 phoneCols/phoneRows
  const [viewSize, setViewSize] = useState<{ w: number; h: number } | null>(null)
  const liveTopRef = useRef(0)
  const scrollLockRef = useRef(0)
  const charWCacheRef = useRef<Map<number, number>>(new Map())

  const setFontPersist = (f: number) => {
    const v = Math.max(8, Math.min(28, f))
    setFont(v)
    localStorage.setItem('myco-term-font', String(v))
  }

  /** 量等宽字宽（canvas measureText 100 字符取均值，按字号缓存）。 */
  const charWidth = useCallback((fontPx: number): number => {
    const hit = charWCacheRef.current.get(fontPx)
    if (hit) return hit
    const ctx = document.createElement('canvas').getContext('2d')
    let w = fontPx * 0.6 // 兜底比例（canvas 不可用时）
    if (ctx) {
      ctx.font = `${fontPx}px ${TERM_FONT}`
      const m = ctx.measureText('0'.repeat(100))
      if (m.width > 0) w = m.width / 100
    }
    charWCacheRef.current.set(fontPx, w)
    return w
  }, [])

  // 手机实际列数/行数：按容器像素 ÷ 字宽/行高。未测量到尺寸前用保守默认。
  const phoneCols = viewSize ? Math.max(12, Math.floor((viewSize.w - 8) / charWidth(font))) : 40
  const phoneRows = viewSize ? Math.max(8, Math.ceil(viewSize.h / (font * 1.35))) : 30
  // 抓的 PC 物理行数：每物理行至少产出 1 显示行，2× 视口行数保证铺满 + 本地滚动余量。
  const fetchRows = Math.min(300, Math.max(40, phoneRows * 2))

  const fetchRegion = useCallback(async () => {
    try {
      // 优先 buffer（带 scrollback 历史滚动）；WebRTC transport 暂未实现 buffer →
      // 退回 screen（live 彩色）→ snap（live 纯文本）。phone 上 terminal 暂只看 live。
      if (transport.buffer) {
        const from = offset ?? 0
        const r = await transport.buffer(session, from, fetchRows)
        liveTopRef.current = r.window.top
        if (offset === null || offset >= r.window.top) {
          if (offset !== r.window.top) setOffset(r.window.top)
          if (from !== r.window.top) {
            const r2 = await transport.buffer(session, r.window.top, fetchRows)
            liveTopRef.current = r2.window.top
            setRegion(r2)
            return
          }
        }
        setRegion(r)
        return
      }
      if (transport.screen) {
        const s = await transport.screen(session)
        liveTopRef.current = 0
        if (offset !== 0) setOffset(0)
        setRegion({ cols: s.cols, rows: s.rows, lines: s.lines, cells: s.cells, cursorX: s.cursorX, cursorY: s.cursorY, regionTop: 0, bufferSize: s.rows, window: { top: 0, bottom: s.rows - 1 }, source: 'screen' })
        return
      }
      const s = await transport.snap(session)
      liveTopRef.current = 0
      if (offset !== 0) setOffset(0)
      setRegion({ cols: s.cols ?? 80, rows: s.rows ?? 24, lines: s.lines, cursorX: s.cursorX ?? 0, cursorY: s.cursorY ?? 0, regionTop: 0, bufferSize: s.rows ?? 24, window: { top: 0, bottom: (s.rows ?? 24) - 1 } })
    } catch { /* 瞬时失败忽略 */ }
  }, [transport, session, offset, fetchRows])

  useEffect(() => {
    fetchRegion()
    const t = setInterval(fetchRegion, 150)
    return () => clearInterval(t)
  }, [fetchRegion])

  // live 时自动贴底（新内容到达即滚到最新）；滚回去看历史时不抢动。
  // ⚠️ 必须用 stick-to-bottom：只在"已在底部"时贴底。否则每 150ms 无条件 scrollTop=
  // scrollHeight 会和用户的触摸上滚打架（上滚→拉回→惯性上滚→拉回→持续闪烁）。
  const screenRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const isLive = (offset ?? 0) >= (region?.window.top ?? 0)
  const onScreenScroll = useCallback(() => {
    const el = screenRef.current
    if (!el) return
    atBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4
  }, [])

  // 容器尺寸监听：横竖屏切换/窗口缩放 → 重算 phoneCols 触发重排重拉。
  useEffect(() => {
    const el = screenRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      const h = el.clientHeight
      setViewSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (isLive && atBottomRef.current && screenRef.current) {
      screenRef.current.scrollTop = screenRef.current.scrollHeight
    }
  }, [region, isLive])
  // offset 跳到 live（返回最新）时重置贴底标志，确保重新跟到底
  useEffect(() => { if (isLive) atBottomRef.current = true }, [isLive])

  // 光标（buffer 坐标 → 区段内物理行）只在 live 区段且落在显示范围内时画
  const cursorSrc = useMemo(() => {
    if (!region || !isLive) return null
    const row = region.cursorY - region.regionTop
    if (row < 0 || row >= region.lines.length) return null
    return { row, x: region.cursorX }
  }, [region, isLive])

  // reflow：PC 物理行 → 逻辑行 → phoneCols 显示行（model 精确 / screen 启发式）。
  const reflowed = useMemo(() => {
    if (!region) return { lines: [] as CharInfo[][], cursor: null }
    const cells = region.cells ?? cellsFromLines(region.lines)
    return reflow({ cells, cols: region.cols, phoneCols, wrapped: region.wrapped, cursor: cursorSrc })
  }, [region, phoneCols, cursorSrc])

  const send = useCallback((k: string) => {
    onKey(k)
    setTimeout(fetchRegion, 90)
  }, [onKey, fetchRegion])

  /** 滚动 = 移动读 offset（直接读 buffer，不操作 console）。
   *  区段内是本地平移（原生 overflow）；撞到区段顶/底还继续滚，才移 offset
   *  读相邻历史区段。每次按 deltaY 换算行数（~3 行/格，像真终端），平滑翻 buffer。
   *  区段高 ≤ 视口（PC 大屏）时顶底同时成立，任意滚轮都直接翻历史。 */
  const pageOffset = useCallback((dir: -1 | 1, rows: number) => {
    const cur = offset ?? liveTopRef.current
    const next = dir < 0 ? Math.max(0, cur - rows) : Math.min(liveTopRef.current, cur + rows)
    if (next !== cur) setOffset(next)
  }, [offset])

  const onWheel = (e: React.WheelEvent) => {
    const el = e.currentTarget
    const atTop = el.scrollTop <= 0
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1
    if (!atTop && !atBottom) return  // 区段内：交给原生本地平移
    const now = Date.now()
    if (now - scrollLockRef.current < 50) return
    const rows = Math.max(1, Math.min(8, Math.round(Math.abs(e.deltaY) / 40)))
    if (atTop && e.deltaY < 0) { scrollLockRef.current = now; pageOffset(-1, rows) }
    else if (atBottom && e.deltaY > 0) { scrollLockRef.current = now; pageOffset(1, rows) }
  }

  // 触摸翻页(手机没有滚轮):区段内原生滚;到顶/到底继续滑 → 移 offset 翻历史。
  // 注意 React 根委托的 touchmove 是 passive,preventDefault 无效——必须手动挂非 passive 监听。
  const touchRef = useRef<{ y: number; acc: number }>({ y: 0, acc: 0 })
  useEffect(() => {
    const el = screenRef.current
    if (!el) return
    const onTS = (e: TouchEvent) => { touchRef.current = { y: e.touches[0].clientY, acc: 0 } }
    const onTM = (e: TouchEvent) => {
      const t = touchRef.current
      const y = e.touches[0].clientY
      const dy = t.y - y // 手指上滑为正(=内容向下=趋向 live)
      t.y = y
      const atTop = el.scrollTop <= 0
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1
      if (!(atTop && dy < 0) && !(atBottom && dy > 0)) { t.acc = 0; return } // 区段内,原生滚
      e.preventDefault()
      t.acc += dy
      const now = Date.now()
      if (now - scrollLockRef.current < 50) return
      if (Math.abs(t.acc) >= 40) {
        const rows = Math.max(1, Math.min(8, Math.round(Math.abs(t.acc) / 40)))
        scrollLockRef.current = now
        pageOffset(t.acc < 0 ? -1 : 1, rows)
        t.acc = 0
      }
    }
    el.addEventListener('touchstart', onTS, { passive: true })
    el.addEventListener('touchmove', onTM, { passive: false })
    return () => { el.removeEventListener('touchstart', onTS); el.removeEventListener('touchmove', onTM) }
  }, [pageOffset])

  const backToLive = () => setOffset(liveTopRef.current)

  return (
    <div className="term-view">
      {offset !== null && offset < liveTopRef.current && (
        <button className="term-back-live" onClick={backToLive}>⏵ 返回最新</button>
      )}
      <div className="term-screen" ref={screenRef} onWheel={onWheel} onScroll={onScreenScroll}>
        <pre className="term-grid" style={{ fontSize: font, lineHeight: 1.35, fontFamily: TERM_FONT, WebkitFontSmoothing: 'antialiased', textRendering: 'optimizeLegibility' }}>
          {reflowed.lines.map((cells, r) => {
            const segs = segments(cells, reflowed.cursor && reflowed.cursor.line === r ? reflowed.cursor.cell : -1)
            return (
              <div key={r} className="term-row">
                {segs.map((s, si) => {
                  const fg = fgCss(s)
                  const bg = bgCss(s)
                  const inv = s.cursor || s.inverse
                  const style: React.CSSProperties = inv ? { color: bg, background: fg } : { color: fg, background: bg }
                  if (s.underline) style.textDecoration = 'underline'
                  return <span key={si} className={s.cursor ? 'term-cursor' : undefined} style={style}>{s.text}</span>
                })}
              </div>
            )
          })}
        </pre>
      </div>
      {/* 中下方半透明键盘钮:点开完整虚拟键栏(ta 支持的按键全量);收起不占屏 */}
      <button
        className={showKeys ? 'term-keys-toggle is-on' : 'term-keys-toggle'}
        onClick={() => setShowKeys((v) => !v)}
        title="展开/收起虚拟按键"
      >
        <svg viewBox="0 0 22 15" width="18" height="13" fill="none" stroke="currentColor" strokeWidth="1.2">
          <rect x="1" y="1" width="20" height="13" rx="2" />
          <g fill="currentColor" stroke="none">
            <rect x="3.5" y="3.5" width="2.2" height="1.8" /><rect x="7" y="3.5" width="2.2" height="1.8" /><rect x="10.5" y="3.5" width="2.2" height="1.8" /><rect x="14" y="3.5" width="2.2" height="1.8" /><rect x="17" y="3.5" width="1.8" height="1.8" />
            <rect x="3.5" y="6.6" width="2.2" height="1.8" /><rect x="7" y="6.6" width="2.2" height="1.8" /><rect x="10.5" y="6.6" width="2.2" height="1.8" /><rect x="14" y="6.6" width="2.2" height="1.8" />
            <rect x="6" y="9.7" width="10" height="1.8" rx="0.9" />
          </g>
        </svg>
      </button>
      {showKeys && (
        <div className="term-keys">
          <button className="term-key term-key-font" onClick={() => setFontPersist(font - 1)} title="缩小字号">A−</button>
          <button className="term-key term-key-font" onClick={() => setFontPersist(font + 1)} title="放大字号">A+</button>
          <span className="term-key-sep" />
          <button className="term-key term-key-esc" onClick={() => send('esc')}>Esc</button>
          <button className="term-key" onClick={() => send('tab')}>Tab</button>
          <button className="term-key" onClick={() => send('up')}>↑</button>
          <button className="term-key" onClick={() => send('down')}>↓</button>
          <button className="term-key" onClick={() => send('left')}>←</button>
          <button className="term-key" onClick={() => send('right')}>→</button>
          <button className="term-key term-key-enter" onClick={() => send('enter')}>⏎</button>
          <button className="term-key" onClick={() => send('backspace')}>Bksp</button>
          <button className="term-key" onClick={() => send('delete')}>Del</button>
          <span className="term-key-sep" />
          <button className="term-key" onClick={() => send('home')}>Home</button>
          <button className="term-key" onClick={() => send('end')}>End</button>
          <button className="term-key" onClick={() => send('pageup')}>PgUp</button>
          <button className="term-key" onClick={() => send('pagedown')}>PgDn</button>
          <span className="term-key-sep" />
          <button className="term-key" onClick={() => send('ctrl+c')}>^C</button>
          <button className="term-key" onClick={() => send('ctrl+z')}>^Z</button>
          <button className="term-key" onClick={() => send('ctrl+d')}>^D</button>
          <button className="term-key" onClick={() => send('ctrl+l')}>^L</button>
        </div>
      )}
    </div>
  )
}
