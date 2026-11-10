/**
 * DesktopView — 远程桌面视图:显示并操控 canvas(PC) 抓屏推来的 video 流。
 *
 * 入口:主设备卡片「远程桌面」(设备级能力,不属于某个项目的执行区)。
 *
 * 交互(复刻微软远程桌面 + 本地查看增强):
 *  - 全屏:右侧中部半透明圆形按钮组(全屏/模式/键盘/声音/清晰度),纯 CSS fixed
 *  - 指针模式(触摸板语义):手机侧虚拟光标(覆盖层小箭头,60fps 本地即时反馈),
 *    单指拖=移光标(发 {t:'abs'} 绝对坐标注入,不吃 Windows 指针加速、丢消息不漂移),
 *    点按=左键,长按/双指点=右键,双指拖=滚轮(触摸板方向),双击按住拖=左键拖拽
 *  - 触摸模式(触摸屏语义):绝对坐标透传 PC 触摸注入(InjectTouchInput);此模式不画光标
 *  - 双指捏合=本地缩放画面(看局部细节),缩放后双指拖=平移;不发给 PC
 *  - 虚拟键栏:修饰键点按武装(高亮),再点普通键发组合键(Ctrl→c = ctrl+c);⌨ 软键盘输文字
 *  - 声音:默认静音;「声音」按钮取消静音(video 元素同流含 PCMU 音轨)
 *  - 清晰度:流畅(720p 缩放省流)/高清(1080p)/原生(屏多大编多大),input 通道通知 PC 改编码
 *
 * 合帧策略(丝滑关键,两模式统一走 rAF):
 *  - pointer:scheduleVc——一帧多条 pointermove 只发一条 abs(~刷新率上限),虚拟光标同帧本地反馈
 *  - touch:scheduleTouch——down/up 立即发(点按/抬指延迟敏感),move 按 pointerId 记最新位置,
 *    一帧每触点至多发一条(多点触控一帧合并多 id)。不合帧时 60~120Hz+ 洪泛会与视频流挤占
 *    DataChannel,注入消息排队 → 延迟逐条累积 → 拖动毛刺
 *
 * 状态栏:流状态 + readyState + inbound-rtp 统计(rx/dec/lost,定位"没收到 vs 没解出")。
 */
import { useEffect, useRef, useState } from 'react'
import type { Transport } from '../transport'
import { WebRtcTransport } from '../transport'

type Mod = 'ctrl' | 'alt' | 'shift' | 'win'

/** 键盘图标(手机定制浏览器 emoji 字体缺,用内联 SVG) */
const KbIcon = ({ size = 18 }: { size?: number }) => (
  <svg viewBox="0 0 22 15" width={size} height={size * 15 / 22} fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="1" y="1" width="20" height="13" rx="2" />
    <g fill="currentColor" stroke="none">
      <rect x="3.5" y="3.5" width="2.2" height="1.8" /><rect x="7" y="3.5" width="2.2" height="1.8" /><rect x="10.5" y="3.5" width="2.2" height="1.8" /><rect x="14" y="3.5" width="2.2" height="1.8" /><rect x="17" y="3.5" width="1.8" height="1.8" />
      <rect x="3.5" y="6.6" width="2.2" height="1.8" /><rect x="7" y="6.6" width="2.2" height="1.8" /><rect x="10.5" y="6.6" width="2.2" height="1.8" /><rect x="14" y="6.6" width="2.2" height="1.8" />
      <rect x="6" y="9.7" width="10" height="1.8" rx="0.9" />
    </g>
  </svg>
)
/** 全屏/退出全屏:四角箭头外扩/内收 */
const FullscreenIcon = ({ off = false, size = 19 }: { off?: boolean; size?: number }) => (
  <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {off ? (
      <>
        <path d="M8 3v3.5H4.5" /><path d="M12 3v3.5h3.5" /><path d="M8 17v-3.5H4.5" /><path d="M12 17v-3.5h3.5" />
      </>
    ) : (
      <>
        <path d="M3 8V3.5h4.5" /><path d="M17 8V3.5h-4.5" /><path d="M3 12v4.5h4.5" /><path d="M17 12v4.5h-4.5" />
      </>
    )}
  </svg>
)
/** 指针模式:鼠标箭头光标 */
const PointerIcon = ({ size = 19 }: { size?: number }) => (
  <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
    <path d="M5 2.5 15.5 10l-5 .8L8 16z" fill="currentColor" fillOpacity="0.25" />
  </svg>
)
/** 触摸模式:手指点按 + 触点涟漪 */
const TouchIcon = ({ size = 19 }: { size?: number }) => (
  <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="6" r="2.2" /><circle cx="8" cy="6" r="4.6" strokeDasharray="2 2.4" />
    <path d="M8 8.5v5.2c0 1 .8 1.8 1.8 1.8h3.4c1.4 0 2.6-1 2.9-2.4l.7-3c.2-1-.5-1.9-1.5-2l-2.1-.2V8.5" />
  </svg>
)
/** 声音:喇叭+声波 / 喇叭+叉(静音) */
const SoundIcon = ({ off = false, size = 19 }: { off?: boolean; size?: number }) => (
  <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7.5v5h3L10 16V4L6 7.5H3z" fill="currentColor" fillOpacity="0.25" />
    {off ? (
      <>
        <path d="M13.5 7.5l4 5" /><path d="M17.5 7.5l-4 5" />
      </>
    ) : (
      <>
        <path d="M13 7.2a4.2 4.2 0 0 1 0 5.6" /><path d="M15.4 5a7.4 7.4 0 0 1 0 10" />
      </>
    )}
  </svg>
)
/** 清晰度:显示器 + HD 字样(信号柱太像 WiFi 图标,会误读) */
const QualityIcon = ({ size = 19 }: { size?: number }) => (
  <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="2" y="3.5" width="16" height="11" rx="1.5" />
    <text x="10" y="12" fontSize="6.5" fontWeight="bold" textAnchor="middle" fill="currentColor" stroke="none">HD</text>
    <path d="M7 16.5h6" strokeLinecap="round" />
  </svg>
)
const MODS: Mod[] = ['ctrl', 'alt', 'shift', 'win']
const KEYBAR: { label: string; key: string }[] = [
  { label: 'Esc', key: 'esc' }, { label: 'Tab', key: 'tab' },
  { label: 'Ctrl', key: 'ctrl' }, { label: 'Alt', key: 'alt' }, { label: 'Shift', key: 'shift' }, { label: 'Win', key: 'win' },
  { label: '←', key: 'left' }, { label: '↑', key: 'up' }, { label: '↓', key: 'down' }, { label: '→', key: 'right' },
  { label: 'Home', key: 'home' }, { label: 'End', key: 'end' }, { label: 'PgUp', key: 'pgup' }, { label: 'PgDn', key: 'pgdn' },
  { label: 'Del', key: 'del' }, { label: 'Bksp', key: 'backspace' }, { label: 'Enter', key: 'enter' }, { label: 'Space', key: 'space' },
]
const QUALITIES = [
  { label: '流畅', h: 720 },
  { label: '高清', h: 1080 },
  { label: '原生', h: 0 },
] as const

/** 指针模式单指拖动增益(虚拟光标位移 = 手指位移 × 增益):
 *  1.0=完全跟手但全屏扫一遍要拖约整个屏宽;≥1.5 大位移易过冲、精点难停;
 *  1.3 是触摸板常用灵敏度的折中——精点可控、大距离少拖几次。
 *  abs 消息自含绝对坐标,增益只影响手感不引入漂移。 */
const POINTER_GAIN = 1.3

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** 画面在 video 元素内的 letterbox 几何(client px,含 CSS zoom 变换,扣黑边)。
 *  合帧冲刷时一帧只算一次,多触点共用。 */
function frameGeom(video: HTMLVideoElement): { ox: number; oy: number; dw: number; dh: number } {
  const r = video.getBoundingClientRect()
  const vw = video.videoWidth || 1280
  const vh = video.videoHeight || 720
  const scale = Math.min(r.width / vw, r.height / vh)
  const dw = vw * scale
  const dh = vh * scale
  return { ox: r.left + (r.width - dw) / 2, oy: r.top + (r.height - dh) / 2, dw, dh }
}

/** 触点(clientX/Y)→ 画面内归一化坐标。 */
function toFramePos(clientX: number, clientY: number, video: HTMLVideoElement): { fx: number; fy: number } {
  const { ox, oy, dw, dh } = frameGeom(video)
  return { fx: clamp01((clientX - ox) / dw), fy: clamp01((clientY - oy) / dh) }
}

export function DesktopView({ transport, onClose }: { transport: Transport; onClose?: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const kbRef = useRef<HTMLTextAreaElement>(null)
  const [status, setStatus] = useState<string>('no-stream')
  const [readyState, setReadyState] = useState(0)
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [rtcStats, setRtcStats] = useState<string>('')
  const [fullscreen, setFullscreen] = useState(false)
  const [mode, setMode] = useState<'pointer' | 'touch'>('pointer')
  // mode 的 ref 镜像(流挂载 effect 里读,避免闭包拿旧 state)
  const modeRef = useRef<'pointer' | 'touch'>('pointer')
  modeRef.current = mode
  const [armed, setArmed] = useState<Mod[]>([])
  const [kbOpen, setKbOpen] = useState(false)
  const [soundOn, setSoundOn] = useState(false)
  const [quality, setQuality] = useState<(typeof QUALITIES)[number]['label']>('高清')
  // 本地查看缩放(捏合放大看细节):transform 作用于容器,toFramePos 用实时外接矩形自动适配
  const [zoom, setZoom] = useState({ s: 1, tx: 0, ty: 0 })

  const sendRef = useRef<(m: Record<string, unknown>) => void>(() => {})
  sendRef.current = transport.kind === 'webrtc'
    ? (m) => (transport as WebRtcTransport).sendDesktopInput(m)
    : () => {}

  // ── 流挂载 + 状态诊断 ──
  useEffect(() => {
    if (transport.kind !== 'webrtc') return
    const wt = transport as WebRtcTransport
    let poll: ReturnType<typeof setInterval> | null = null
    const attach = (s: MediaStream | null) => {
      if (!s) return
      setStatus('stream')
      const v = videoRef.current
      if (!v) return
      v.srcObject = s
      v.onloadeddata = () => { setStatus('playing'); setReadyState(v.readyState) }
      v.oncanplay = () => { setStatus('canplay'); setReadyState(v.readyState) }
      v.onerror = () => {
        setStatus('error')
        setErrMsg(v.error ? `code=${v.error.code} ${v.error.message}` : 'unknown')
      }
      poll = setInterval(() => {
        setReadyState(v.readyState)
        void wt.desktopStats().then(setRtcStats)
      }, 1000)
    }
    attach(wt.desktopStream)
    wt.onDesktopStream = attach
    // 连接建立即上报当前模式:PC 画面光标开关(cursor_flag)初始为 true,
    // 只有收到 mode 消息才关——首连从未发过 → PC 画面画光标+手机本地层=双指针
    // (实测根因)。这里立即上报,保证全程只见一个指针(手机本地层,60Hz)。
    sendRef.current({ t: 'mode', mode: modeRef.current })
    return () => {
      if (wt.onDesktopStream === attach) wt.onDesktopStream = null
      if (poll) clearInterval(poll)
    }
  }, [transport])

  // 声音开关 = video.muted(音轨随视频同流,取消静音即出声;点击本身是用户手势,浏览器放行)
  useEffect(() => {
    const v = videoRef.current
    if (v) v.muted = !soundOn
  }, [soundOn])

  // RDP 式指针通道:PC 30Hz 真实光标位置 → 本地指针层纯跟随(单一真相源:
  // 手机不再自主虚拟位置,双指针/错位根除;拖动经 abs 注入→PC 指针动→回传→层跟随,闭环)
  useEffect(() => {
    if (transport.kind !== 'webrtc') return
    const wt = transport as WebRtcTransport
    wt.onCursorPos = (fx, fy) => {
      const g = gesture.current
      g.vcInit = true
      // 跟随只动视觉层(positionCursor),**绝不回注 abs**——2026-08-28 实锤回环:
      // 下行光标广播若触发上行注入,坐标映射微差被放大成 PC→phone→PC 永动漂移
      // ("没人动鼠标还在漂"根因;捕获停摆时广播断流、回环静默,故时好时坏)。
      // 拖动会话/短窗口仍静默丢弃;用户真实拖动走 pendingAbs 通道,与此无关。
      if (g.dragAnchor || g.pendingAbs) return
      if (Date.now() < g.syncHoldUntil) return
      g.vcx = fx
      g.vcy = fy
      positionCursor()
    }
    return () => { wt.onCursorPos = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport])

  // 切回指针模式:覆盖层光标重挂载后按持久坐标复位;卸载时取消未冲刷的 rAF
  useEffect(() => {
    if (mode !== 'pointer') return
    const id = requestAnimationFrame(positionCursor)
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])
  useEffect(() => () => {
    const g = gesture.current
    if (g.rafId) cancelAnimationFrame(g.rafId)
    if (g.touchRaf) cancelAnimationFrame(g.touchRaf)
  }, [])

  // 模式/清晰度变化 → 通知 PC(藏光标/改编码档位)
  const switchMode = () => {
    const next = mode === 'pointer' ? 'touch' : 'pointer'
    setMode(next)
    // 冲掉在手势的残留:半途切模式后,pointerup 按新模式分支走,旧模式的触点/按键会漏抬——
    // 触摸触点停在 PC 侧=粘住(配合 PC 端 up 按 fx/fy 落点,用最后已知位置抬干净);
    // 指针拖拽的左键停在按下态同样补一个 up
    const g = gesture.current
    const v = videoRef.current
    for (const [id, p] of g.touchPos) {
      const pos = v ? toFramePos(p.x, p.y, v) : { fx: 0, fy: 0 }
      sendRef.current({ t: 'touch', id, phase: 'up', fx: pos.fx, fy: pos.fy })
    }
    g.touchPos.clear()
    g.touchDirty.clear()
    if (g.touchRaf) { cancelAnimationFrame(g.touchRaf); g.touchRaf = 0 }
    if (g.dragging) { g.dragging = false; sendRef.current({ t: 'up', btn: 'left' }) }
    g.dragPending = false
    sendRef.current({ t: 'mode', mode: next })
  }
  const cycleQuality = () => {
    const i = QUALITIES.findIndex((q) => q.label === quality)
    const next = QUALITIES[(i + 1) % QUALITIES.length]
    setQuality(next.label)
    sendRef.current({ t: 'quality', h: next.h })
  }

  // ── 手势 ──
  const gesture = useRef({
    pointers: new Map<number, { x: number; y: number }>(),
    downAt: 0,
    moved: false,
    longPressTimer: 0 as unknown as ReturnType<typeof setTimeout>,
    longPressFired: false,
    dragging: false,
    // 双击第二次按下悬决:快抬(<350ms 未移动)=右键;按住拖动>8px=转拖拽会话
    dragPending: false,
    lastTapAt: 0,
    wheelAcc: 0,
    // 虚拟光标:画面归一化 float 坐标持久保持;增量按显示宽度折算,丢消息不漂移(abs 自含位置)
    vcx: 0.5,
    // 指针模式拖动会话锚:down 时刻的指针位置+手指起点。拖动中目标=锚+累计位移
    // (本地基准,不被 30Hz 回传滞后值覆盖——那是"不断偏移"的根因);
    // 拖动结束回传自然接管(单一真相源仍在 PC)。
    dragAnchor: null as null | { vcx: number, vcy: number, x: number, y: number },
    // 待发 abs(rAF 合帧:一帧只发一条,防 pointermove 60~120Hz 洪泛 DataChannel)
    pendingAbs: null as null | { fx: number, fy: number },
    absRaf: 0,
    vcy: 0.5,
    vcInit: false,
    vcDirty: false,
    rafId: 0,
    // touch 模式合帧:每个触点的最新 client 坐标 + 本帧待发集合(见 scheduleTouch)
    touchPos: new Map<number, { x: number; y: number }>(),
    touchDirty: new Set<number>(),
    touchRaf: 0,
    pinchDist: 0, // 双指捏合基准距离
    lastTapEndAt: 0, // 最近一次轻点抬指时刻(双指点=右键判据)
    syncHoldUntil: 0, // 拖动结束后的回传静默截止时刻(防旧位置回传覆盖→漂移)
  })
  // 缩放倍率的 ref 镜像(手势回调里读,避免闭包拿旧 state)
  const zoomSRef = useRef(1)
  zoomSRef.current = zoom.s
  const cursorRef = useRef<HTMLDivElement>(null)

  /** 画面在容器内的实际显示尺寸(client px,未含 zoom 变换)——与 toFramePos 同一几何 */
  const frameSize = () => {
    const v = videoRef.current
    if (!v) return null
    const vw = v.videoWidth || 1280
    const vh = v.videoHeight || 720
    const scale = Math.min(v.clientWidth / vw, v.clientHeight / vh)
    return { dw: vw * scale, dh: vh * scale }
  }

  /** 覆盖层光标定位:与画面同一 letterbox 几何,直接改 DOM(不走 React 渲染,60fps 不抖) */
  const positionCursor = () => {
    const g = gesture.current
    const v = videoRef.current
    const c = cursorRef.current
    if (!v || !c || !g.vcInit) return
    const fs = frameSize()
    if (!fs) return
    const ox = (v.clientWidth - fs.dw) / 2
    const oy = (v.clientHeight - fs.dh) / 2
    c.style.display = 'block'
    c.style.transform = `translate(${ox + g.vcx * fs.dw}px, ${oy + g.vcy * fs.dh}px)`
  }

  /** abs 发送合帧:一帧只发最新目标(与 scheduleVc 同帧,指针渲染与注入同节拍)。 */
  const scheduleAbsFlush = () => {
    const g = gesture.current
    if (g.absRaf) return
    g.absRaf = requestAnimationFrame(() => {
      g.absRaf = 0
      const p = g.pendingAbs
      g.pendingAbs = null
      if (p) sendRef.current({ t: 'abs', fx: p.fx, fy: p.fy })
    })
  }

  /** rAF 合帧冲刷:一帧内多次【用户】pointermove 只发一条 abs,~60Hz 上限。
   *  仅服务用户真实拖动(onPointerMove);下行光标跟随走 onCursorPos→positionCursor 纯视觉,绝不经此回注。 */
  const scheduleVc = () => {
    const g = gesture.current
    if (g.rafId) return
    g.rafId = requestAnimationFrame(() => {
      g.rafId = 0
      if (!g.vcDirty) return
      g.vcDirty = false
      positionCursor()
      sendRef.current({ t: 'abs', fx: g.vcx, fy: g.vcy })
    })
  }

  /** touch 模式 rAF 合帧冲刷:一帧内多条 pointermove 每触点只发最后一条 move(≤屏幕刷新率),
   *  几何一帧算一次多触点共用;多点触控一帧合并多 id(每 id 一条消息,PC 端逐消息注入)。
   *  down/up 不走这里——点按/抬指延迟敏感,须立即发。 */
  const scheduleTouch = () => {
    const g = gesture.current
    if (g.touchRaf) return
    g.touchRaf = requestAnimationFrame(() => {
      g.touchRaf = 0
      if (g.touchDirty.size === 0) return
      const v = videoRef.current
      if (!v) { g.touchDirty.clear(); return }
      const geo = frameGeom(v)
      for (const id of g.touchDirty) {
        const p = g.touchPos.get(id)
        if (!p) continue
        sendRef.current({
          t: 'touch', id, phase: 'move',
          fx: clamp01((p.x - geo.ox) / geo.dw),
          fy: clamp01((p.y - geo.oy) / geo.dh),
        })
      }
      g.touchDirty.clear()
    })
  }

  const resetZoom = () => setZoom({ s: 1, tx: 0, ty: 0 })

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    const g = gesture.current
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()]
      g.pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
      clearTimeout(g.longPressTimer)
      return
    }

    if (mode === 'touch') {
      const v = videoRef.current
      if (!v) return
      const { fx, fy } = toFramePos(e.clientX, e.clientY, v)
      // 记录最新位置供 cancel 兜底;清掉本 id 残留的待发 move(理论上无,防模式切换竞态)
      g.touchPos.set(e.pointerId, { x: e.clientX, y: e.clientY })
      g.touchDirty.delete(e.pointerId)
      sendRef.current({ t: 'touch', id: e.pointerId, phase: 'down', fx, fy })
      // 长按=右键(touch 模式同享;系统 press-hold 不可靠,手机端自判):
      // 550ms 内单指未移 8px+ → 先抬触摸点再原地右键点按,触摸语义不被破坏。
      if (g.pointers.size === 1) {
        g.moved = false
        g.longPressFired = false
        g.longPressTimer = setTimeout(() => {
          if (!g.moved && g.pointers.size === 1) {
            g.longPressFired = true
            sendRef.current({ t: 'touch', id: e.pointerId, phase: 'up', fx, fy })
            sendRef.current({ t: 'abs', fx, fy })
            sendRef.current({ t: 'click', btn: 'right' })
          }
        }, 550)
      }
      return
    }
    // 指针模式
    if (g.pointers.size === 1) {
      // 首次触碰:虚拟光标以触点画面位置初始化(之后持久保持,不跟每次落指跳)
      if (!g.vcInit) {
        const v = videoRef.current
        if (v) {
          const { fx, fy } = toFramePos(e.clientX, e.clientY, v)
          g.vcx = fx
          g.vcy = fy
          g.vcInit = true
          positionCursor()
          sendRef.current({ t: 'abs', fx, fy })
        }
      }
      g.downAt = Date.now()
      g.moved = false
      g.longPressFired = false
      g.dragPending = false
      // 拖动锚:以当前(回传同步的)指针位置+手指起点为基准
      if (g.vcInit) {
        g.dragAnchor = { vcx: g.vcx, vcy: g.vcy, x: e.clientX, y: e.clientY }
      }
      // 双击(350ms 内第二次按下)=右键(2026-09-03 设计定稿:鼠标模式双击按右键,
      // 触摸板惯例留给触摸模式)。悬决不发 left down:onPointerUp 快抬=右键;
      // 按住拖动>8px 才转拖拽会话(tap-tap-drag 语义保留)。
      if (Date.now() - g.lastTapAt < 350) {
        g.dragPending = true
      }
      g.longPressTimer = setTimeout(() => {
        if (!g.moved && g.pointers.size === 1 && !g.dragging && !g.dragPending) {
          g.longPressFired = true
          sendRef.current({ t: 'click', btn: 'right' }) // 长按=右键(双击之外的兜底入口)
        }
      }, 500)
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const g = gesture.current
    const prev = g.pointers.get(e.pointerId)
    if (!prev) return
    const dx = e.clientX - prev.x
    const dy = e.clientY - prev.y
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    // 双指:捏合=本地缩放;已缩放时拖动=平移;未缩放(指针模式)=滚轮
    if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      // 滚动优先于捏合:双指 y 同向位移(平均绝对 y 位移 > 距离变化量)是滚动
      // 意图,直接进滚轮——原逻辑距离变化 2% 就抢注缩放,滚动极难触发(实测痛点)。
      const pinchDelta = g.pinchDist > 0 ? Math.abs(dist - g.pinchDist) : 0
      const scrollIntent = Math.abs(dy) > 4 && Math.abs(dy) > pinchDelta
      if (scrollIntent) {
        if (zoom.s > 1) {
          setZoom((z) => ({ ...z, ty: z.ty + dy }))
        } else if (mode === 'pointer') {
          // 双指拖动=滚轮(触摸板方向:双指上移=页面下滚/内容跟手)
          g.wheelAcc += dy
          if (Math.abs(g.wheelAcc) >= 40) {
            sendRef.current({ t: 'wheel', d: Math.sign(g.wheelAcc) * Math.floor(Math.abs(g.wheelAcc) / 40) })
            g.wheelAcc = 0
          }
        }
        g.pinchDist = dist
        return
      }
      if (g.pinchDist > 0) {
        const ratio = dist / g.pinchDist
        if (Math.abs(ratio - 1) > 0.06) {
          setZoom((z) => ({ ...z, s: Math.min(4, Math.max(1, z.s * ratio)) }))
          g.pinchDist = dist
          return
        }
      }
      if (zoom.s > 1) {
        setZoom((z) => ({ ...z, tx: z.tx + dx, ty: z.ty + dy }))
        return
      }
      return
    }

    if (mode === 'touch') {
      // 合帧(丝滑关键):只记最新坐标,rAF 每帧每触点至多发一条 move。
      // 直接逐事件发会 60~120Hz+ 洪泛 DataChannel,与视频流挤占带宽 → 注入排队 → 延迟累积毛刺。
      if (Math.abs(dx) + Math.abs(dy) > 8) {
        g.moved = true
        clearTimeout(g.longPressTimer)
      }
      if (g.longPressFired) return // 右键已发,本触点余下移动忽略(等抬指)
      g.touchPos.set(e.pointerId, { x: e.clientX, y: e.clientY })
      g.touchDirty.add(e.pointerId)
      scheduleTouch()
      return
    }
    if (Math.abs(dx) + Math.abs(dy) > 8) {
      g.moved = true
      clearTimeout(g.longPressTimer)
    }
    // 双击悬决中按住拖动 → 转拖拽会话(tap-tap-drag:补发 left down,后续 move 正常)
    if (g.dragPending && g.moved) {
      g.dragPending = false
      g.dragging = true
      sendRef.current({ t: 'down', btn: 'left' })
    }
    // 单指拖动=触摸板语义:目标 = 拖动锚 + 手指累计位移×增益(本地基准,
    // 不被 30Hz 回传滞后值覆盖——那是"不断偏移"的根因)。rAF 合帧只发最新目标
    // (防 60~120Hz 洪泛),同时本地即时渲染指针到目标位置(不等 40-70ms 回传——丝滑)。
    const fs = frameSize()
    if (fs && g.vcInit && g.dragAnchor) {
      const a = g.dragAnchor
      const nx = clamp01(a.vcx + ((e.clientX - a.x) * POINTER_GAIN) / (fs.dw * zoomSRef.current))
      const ny = clamp01(a.vcy + ((e.clientY - a.y) * POINTER_GAIN) / (fs.dh * zoomSRef.current))
      g.pendingAbs = { fx: nx, fy: ny }
      g.vcx = nx
      g.vcy = ny
      g.vcDirty = true
      scheduleVc()
      scheduleAbsFlush()
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const g = gesture.current
    g.pointers.delete(e.pointerId)
    clearTimeout(g.longPressTimer)
    if (g.pointers.size < 2) g.pinchDist = 0
    if (g.pointers.size < 2) g.wheelAcc = 0

    if (mode === 'touch') {
      clearTimeout(g.longPressTimer)
      // 长按右键已发过 up——本次只清状态,不再重复抬指
      if (g.longPressFired) {
        g.longPressFired = false
        g.touchPos.delete(e.pointerId)
        g.touchDirty.delete(e.pointerId)
        return
      }
      // up 立即发(不合帧)且带最新坐标——PC 端按此落点抬指,吃掉 move 合帧的最后一帧差
      const v = videoRef.current
      if (v) {
        const { fx, fy } = toFramePos(e.clientX, e.clientY, v)
        sendRef.current({ t: 'touch', id: e.pointerId, phase: 'up', fx, fy })
      }
      g.touchPos.delete(e.pointerId)
      g.touchDirty.delete(e.pointerId)
      return
    }
    // 拖动会话结束:冲掉最后一条 abs(带最终目标,PC 落点与所见一致)+清锚,
    // 并设 250ms 回传静默窗(在途旧回传是漂移根因)——之后反映最终位置的
    // 回传恢复接管(单一真相源回到 PC)。
    g.dragAnchor = null
    if (g.absRaf) { cancelAnimationFrame(g.absRaf); g.absRaf = 0 }
    const p = g.pendingAbs
    g.pendingAbs = null
    if (p) {
      sendRef.current({ t: 'abs', fx: p.fx, fy: p.fy })
      g.syncHoldUntil = Date.now() + 250
    }
    if (g.dragging) {
      g.dragging = false
      sendRef.current({ t: 'up', btn: 'left' })
      return
    }
    // 双击悬决快抬=右键(2026-09-03 设计定稿);清 lastTapAt 防三击连判成再双击
    if (g.dragPending) {
      g.dragPending = false
      if (!g.moved && !g.longPressFired && Date.now() - g.downAt < 350) {
        sendRef.current({ t: 'click', btn: 'right' })
        g.lastTapAt = 0
        g.lastTapEndAt = Date.now()
        return
      }
    }
    if (!g.moved && !g.longPressFired && g.pointers.size === 0) {
      const dt = Date.now() - g.downAt
      if (dt < 350) {
        // 双指点=右键:另一指在 300ms 内也完成过轻点(两指各点一次);
        // 同指双击的第二次 down 已走 dragging 分支(return 在此之前),不误触。
        const twoFinger = Date.now() - g.lastTapEndAt < 300
        sendRef.current({ t: 'click', btn: twoFinger ? 'right' : 'left' })
        if (!twoFinger) g.lastTapAt = Date.now()
        g.lastTapEndAt = Date.now()
      }
    }
  }

  const onPointerCancel = (e: React.PointerEvent<HTMLElement>) => {
    const g = gesture.current
    g.dragAnchor = null
    g.pendingAbs = null
    g.dragPending = false
    g.pointers.delete(e.pointerId)
    clearTimeout(g.longPressTimer)
    if (mode === 'touch') {
      // 取消:用最后已知触点位置抬指(cancel 事件坐标可能已被清掉;
      // 无记录=PC 侧本就无此触点,坐标无效但消息是 no-op,安全)
      const v = videoRef.current
      const last = g.touchPos.get(e.pointerId)
      const pos = v && last ? toFramePos(last.x, last.y, v) : { fx: 0, fy: 0 }
      sendRef.current({ t: 'touch', id: e.pointerId, phase: 'up', fx: pos.fx, fy: pos.fy })
      g.touchPos.delete(e.pointerId)
      g.touchDirty.delete(e.pointerId)
    }
    if (g.dragging) {
      g.dragging = false
      sendRef.current({ t: 'up', btn: 'left' })
    }
  }

  // ── 虚拟键栏 ──
  const onKeybarTap = (key: string) => {
    if ((MODS as string[]).includes(key)) {
      setArmed((a) => (a.includes(key as Mod) ? a.filter((m) => m !== key) : [...a, key as Mod]))
      return
    }
    sendRef.current({ t: 'key', key, mods: armed })
    if (armed.length) setArmed([])
  }

  // ── 手机软键盘 ──
  // focus 必须在点击手势的同步调用栈内:安卓浏览器只给"带 user activation 的
  // focus()"弹软键盘,setTimeout 异步 focus 会聚焦但键盘不弹(实测根因:
  // 键盘不弹→textarea 永不 blur→kbOpen 卡高亮,再点也无效)。
  const openKeyboard = () => {
    kbRef.current?.focus()
    setKbOpen(true)
  }
  const onKbInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    const v = el.value
    if (v) sendRef.current({ t: 'text', s: v })
    el.value = ''
  }
  const onKbKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Backspace') { sendRef.current({ t: 'key', key: 'backspace', mods: armed }); e.preventDefault() }
    if (e.key === 'Enter') { sendRef.current({ t: 'key', key: 'enter', mods: armed }); e.preventDefault() }
  }

  const zoomed = zoom.s > 1
  return (
    <div className={(fullscreen || onClose) ? 'desktop-view is-fullscreen' : 'desktop-view'}>
      {onClose && (
        <button className="desktop-back" onClick={onClose} title="返回">‹</button>
      )}
      <div
        className="desktop-touch"
        style={zoomed ? { transform: `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.s})` } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={(e) => e.preventDefault()}
        onDoubleClick={resetZoom}
      >
        <video ref={videoRef} autoPlay playsInline muted className="desktop-video" />
        {mode === 'pointer' && (
          <div ref={cursorRef} className="desktop-cursor" style={{ display: 'none' }}>
            <svg viewBox="0 0 20 20" width="16" height="16">
              <path d="M2 1.5 14 9l-5.2.9L6 16z" fill="#fff" stroke="#000" strokeWidth="1" />
            </svg>
          </div>
        )}
      </div>

      {/* 右侧中部半透明浮动按钮组(图标按钮;title 有文字说明) */}
      <div className="desktop-fab">
        <button className="desktop-fab-btn" onClick={() => { setFullscreen((v) => !v); resetZoom() }} title={fullscreen ? '退出全屏' : '全屏显示'}>
          <FullscreenIcon off={fullscreen} />
        </button>
        <button className={mode === 'touch' ? 'desktop-fab-btn is-on' : 'desktop-fab-btn'} onClick={switchMode}
          title={mode === 'pointer' ? '当前:指针模式(触摸板)。点按切到触摸模式(点哪点哪)' : '当前:触摸模式(点哪点哪)。点按切到指针模式'}>
          {mode === 'pointer' ? <PointerIcon /> : <TouchIcon />}
        </button>
        <button className={kbOpen ? 'desktop-fab-btn is-on' : 'desktop-fab-btn'} onClick={openKeyboard} title="打开手机键盘,往 PC 输入文字">
          <KbIcon />
        </button>
        <button className={soundOn ? 'desktop-fab-btn is-on' : 'desktop-fab-btn'} onClick={() => setSoundOn((v) => !v)}
          title={soundOn ? '关闭 PC 声音' : '收听 PC 声音'}>
          <SoundIcon off={!soundOn} />
        </button>
        <button className="desktop-fab-btn" onClick={cycleQuality} title={`清晰度:${quality}(点按切 流畅720p/高清1080p/原生)`}>
          <QualityIcon />
        </button>
      </div>

      {/* 虚拟键栏(修饰键武装高亮;点普通键发组合键后自动解除) */}
      <div className="desktop-keybar">
        {KEYBAR.map((k) => (
          <button
            key={k.key}
            className={armed.includes(k.key as Mod) ? 'desktop-key is-armed' : 'desktop-key'}
            onClick={() => onKeybarTap(k.key)}
          >
            {k.label}
          </button>
        ))}
      </div>

      <div className="desktop-hint">
        远程桌面 · {status} · readyState={readyState}{errMsg ? ` · ${errMsg}` : ''}{rtcStats ? ` · ${rtcStats}` : ''} · {mode === 'pointer' ? '指针' : '触摸'}{zoomed ? ` · ${zoom.s.toFixed(1)}x` : ''}
      </div>

      <textarea
        ref={kbRef}
        className="desktop-kb-sink"
        autoCapitalize="off"
        autoCorrect="off"
        onInput={onKbInput}
        onKeyDown={onKbKeyDown}
        onFocus={() => setKbOpen(true)}
        onBlur={() => setKbOpen(false)}
      />
    </div>
  )
}
