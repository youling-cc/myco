/**
 * myco 远程(B5-2):PC↔PC 远程桌面 viewer。
 *
 * 本窗=独立设备 DID(viewer 身份,phone 信任模型):配对=viewer DID 写入主机
 * canvas authorized-dids(本机回环走 /api/add_device_by_did 即时生效);
 * 连接=WebRTC offerer(identity-svc 信令,offer 带 m=video/audio recvonly),
 * canvas answerer 推 PC 屏幕;输入经 input channel 注入主机 SendInput。
 *
 * 数据面:canvas 同源 HTTP :3002(成员窗双轨惯例;canvas 离线=空态)。
 */
import { useEffect, useRef, useState } from 'react'
import { TitleBar } from '@myco/ui-kit'
import { ensureViewerIdentity } from './identity'
import { MediaRtcClient, type ConnState } from './rtc'

const CANVAS_API = 'http://127.0.0.1:3102'
const PORT = 17898

interface Device {
  did: string
  name?: string | null
  kind?: string | null
  authorized?: boolean
  online?: boolean
}

async function fetchCanvasStatus(): Promise<boolean> {
  try {
    const r = await fetch(`${CANVAS_API}/api/formation/state`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch {
    return false
  }
}

async function fetchHostDid(): Promise<string> {
  const r = await fetch(`${CANVAS_API}/api/identity_get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(3000),
  })
  if (!r.ok) return ''
  const j = await r.json()
  return (j?.data?.did as string) ?? ''
}

async function fetchDevices(): Promise<Device[]> {
  const r = await fetch(`${CANVAS_API}/api/list_authorized_devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(3000),
  })
  if (!r.ok) return []
  const j = await r.json()
  const d = j?.data
  return Array.isArray(d) ? d : Array.isArray(d?.devices) ? d.devices : []
}

/** e.code(物理键位)→ desktop_input vk_of 键名。remote 直通用:与字符解耦,
 *  Shift/Ctrl/Alt/Win 独立按键、左右分键、OEM 标点、小键盘全覆盖(RDP 按 scancode
 *  透传同构——PC 侧键盘布局/IME 负责把键位翻成字符)。不可映射返回 null。 */
const CODE_VK: Record<string, string> = {
  ShiftLeft: 'lshift', ShiftRight: 'rshift', ControlLeft: 'lctrl', ControlRight: 'rctrl',
  AltLeft: 'lalt', AltRight: 'ralt', MetaLeft: 'lwin', MetaRight: 'rwin',
  CapsLock: 'capslock', Insert: 'ins', Delete: 'del', Home: 'home', End: 'end',
  PageUp: 'pgup', PageDown: 'pgdn', Escape: 'esc', Tab: 'tab', Backspace: 'backspace',
  Enter: 'enter', NumpadEnter: 'enter', Space: 'space',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Semicolon: 'semicolon', Equal: 'equal', Comma: 'comma', Minus: 'minus', Period: 'period',
  Slash: 'slash', Backquote: 'backquote', BracketLeft: 'bracketleft', Backslash: 'backslash',
  BracketRight: 'bracketright', Quote: 'quote',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummul',
  NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
}
function codeVk(code: string): string | null {
  if (CODE_VK[code]) return CODE_VK[code]
  let m = /^Key([A-Z])$/.exec(code)
  if (m) return m[1].toLowerCase()
  m = /^Digit([0-9])$/.exec(code)
  if (m) return m[1]
  m = /^Numpad([0-9])$/.exec(code)
  if (m) return `num${m[1]}`
  m = /^F([1-9]|1[0-2])$/.exec(code)
  if (m) return `f${m[1]}`
  return null
}

const short = (did: string) => (did.length > 24 ? `${did.slice(0, 18)}…${did.slice(-4)}` : did)

/** 跨机模式(2026-08-28):?host=<did> 指定远端主机——笔记本远程窗看 jason PC 桌面。
 *  启动 URL 由 Rust 侧读 ~/.myco/media-host.txt 注入;授权在主机侧 enforced(deny 流程),
 *  本地配对检查跳过(本地 canvas 可不在线)。 */
const REMOTE_HOST = new URLSearchParams(location.search).get('host')

/** PC 光标语义形状 → 本机 CSS 原生光标(MS-RDPBCGR 指针通道同构:形状带外传输,
 *  客户端本地渲染)。PC 侧 GetCursorInfo+系统共享句柄表识别;自定义光标落回 arrow。
 *  hidden=PC 光标当前不可见(打字隐藏/视频播放),mirror 成 none。 */
const CSS_CURSOR: Record<string, string> = {
  arrow: 'default',
  uparrow: 'default',
  ibeam: 'text',
  hand: 'pointer',
  cross: 'crosshair',
  wait: 'wait',
  appstarting: 'progress',
  no: 'not-allowed',
  size_ns: 'ns-resize',
  size_we: 'ew-resize',
  size_nesw: 'nesw-resize',
  size_nwse: 'nwse-resize',
  size_all: 'move',
  help: 'help',
  hidden: 'none',
}

/** embedded=宿主内嵌形态(2026-09-01 media 并入 aop 工作区):隐藏自家 TitleBar,
 *  样式由宿主引入的 media.css(scoped .media-embed)接管;独立窗形态不变。 */
export default function App({ embedded }: { embedded?: boolean } = {}) {
  const [viewerDid] = useState(() => ensureViewerIdentity().did)
  const [canvasOn, setCanvasOn] = useState(false)
  const [hostDid, setHostDid] = useState(REMOTE_HOST ?? '')
  const [devices, setDevices] = useState<Device[]>([])
  const [err, setErr] = useState('')
  const [paired, setPaired] = useState(false)
  const [conn, setConn] = useState<ConnState>('idle')
  const [statLine, setStatLine] = useState('')
  const [hasStream, setHasStream] = useState(false)
  /** PC 光标死亡(RDP 最小化/显示栈挂起):输入注入已暂停,显示提示条而非装死 */
  const [cursorDead, setCursorDead] = useState(false)
  /** PC 真实光标形状(带外广播,变化才更新):viewer 用本机原生光标换形状,零延迟 */
  const [cshape, setCshape] = useState('arrow')
  /** 自动播放被拒:提示点画面启用(手势内 play + 解除静音) */
  const [needsPlay, setNeedsPlay] = useState(false)
  /* 使用时长目标/进度刻意不渲染(2026-08-31 设计定稿):远程桌面屏幕空间=画面本身,
     状态值上屏即违背屏占比目标。记账照常在 canvas 侧(remote_usage.rs),目标与进度
     由 R 层消费(task.md/账本),不经本 UI。 */

  const videoRef = useRef<HTMLVideoElement>(null)
  /** canvas 渲染层:WebView2 下 <video> 直渲染可能黑屏,用 2D canvas 画帧可靠 */
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRenderRef = useRef(0)
  const clientRef = useRef<MediaRtcClient | null>(null)
  /** mousemove 合帧:rAF 内至多发一条 abs */
  const pendAbs = useRef<{ fx: number; fy: number } | null>(null)
  const rafId = useRef(0)

  // ── 轮询 canvas 在线/主机 DID/设备清单 ──
  useEffect(() => {
    let alive = true
    const tick = async () => {
      const on = await fetchCanvasStatus()
      if (!alive) return
      setCanvasOn(on)
      // 跨机模式:主机 DID 由 URL 注入,授权在主机侧,本地配对检查跳过
      if (REMOTE_HOST) {
        setHostDid(REMOTE_HOST)
        setPaired(true)
        return
      }
      if (!on) return
      try {
        const [hd, list] = await Promise.all([fetchHostDid(), fetchDevices()])
        if (!alive) return
        setHostDid(hd)
        setDevices(list)
        setPaired(list.some((d) => d.did === viewerDid && d.authorized !== false))
        setErr('')
      } catch (e) {
        if (alive) setErr(String(e))
      }
    }
    void tick()
    const t = setInterval(tick, 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [viewerDid])

  // ── 连接状态行:1s 轮 stats ──
  useEffect(() => {
    if (conn !== 'open') return
    const t = setInterval(() => {
      void clientRef.current?.stats().then((s) => { setStatLine(s); calcFps(s) })
    }, 1000)
    return () => clearInterval(t)
  }, [conn])

  // 卸载关连接
  useEffect(
    () => () => {
      clientRef.current?.close()
      if (rafId.current) cancelAnimationFrame(rafId.current)
    },
    [],
  )

  const pair = async () => {
    const r = await fetch(`${CANVAS_API}/api/add_device_by_did`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ did: viewerDid, name: '远程窗(本机)' }),
    })
    if (!r.ok) {
      setErr(`配对失败 ${r.status}`)
      return
    }
    setDevices(await fetchDevices().catch(() => []))
    setPaired(true)
  }

  const connect = async () => {
    if (!hostDid || clientRef.current) return
    const c = new MediaRtcClient()
    clientRef.current = c
    c.onState = (s) => {
      setConn(s)
      if (s === 'open') setErr('')
      if (s === 'failed' || s === 'closed') {
        clientRef.current = null
        setHasStream(false)
      }
    }
    c.onStream = (s) => {
      const v = videoRef.current
      if (v) {
        // WebView2 兼容修复:先清再挂,强制 video 元素重建解码管线(直接 srcObject= 可能不渲染)
        v.srcObject = null
        v.srcObject = s
        v.load()
        v.play().then(() => { v.muted = false })
          .catch(() => {
            v.muted = true
            v.play().catch(() => setNeedsPlay(true))
          })
      }
      setHasStream(true)
    }
    // PC 光标 60Hz 位置广播:仅作存活心跳清死态(位置渲染已移交本机原生光标,见 CSS_CURSOR)
    c.onCursor = () => setCursorDead(false)
    c.onCursorDead = () => setCursorDead(true)
    // PC 光标形状带外广播(变化才发):换本机原生光标形状,RDP 同架构
    c.onCursorShape = (sh) => setCshape(sh)
    try {
      await c.connect(hostDid)
    } catch (e) {
      setErr(String(e))
      c.close()
      clientRef.current = null
    }
  }

  const disconnect = () => {
    clientRef.current?.close()
    clientRef.current = null
    setHasStream(false)
    setNeedsPlay(false)
    if (videoRef.current) videoRef.current.srcObject = null
  }

  // ── 跨机模式自动连接(2026-08-28):部署即连;被主机 deny(授权前)按 10s 退避重试,
  //    主机侧 add_device_by_did 放行后下一轮自动接上,笔记本端零操作。 ──
  useEffect(() => {
    if (!REMOTE_HOST || !paired || !hostDid) return
    let stop = false
    let tries = 0
    const attempt = () => {
      if (stop || clientRef.current) return
      tries++
      void connect()
      if (!stop && tries < 30) setTimeout(attempt, 10_000)
    }
    const t = setTimeout(attempt, 800)
    return () => { stop = true; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [REMOTE_HOST, paired, hostDid])

  // ── 断线自愈重连(2026-08-29):TURN relay allocation ~14min 到期死亡(实测)等意外
  //    断线时,首连 useEffect 的 30 次重试早已跑完,必须按 conn 状态重新武装——
  //    closed/failed 5s 后重连,无限次,用户无感。仅在无存活 client 时触发防重入。 ──
  useEffect(() => {
    if (!REMOTE_HOST || (conn !== 'closed' && conn !== 'failed')) return
    const t = setTimeout(() => {
      if (!clientRef.current) void connect()
    }, 5000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [REMOTE_HOST, conn])

  // ── 输入注入 ──
  const toFrac = (e: React.MouseEvent): { fx: number; fy: number } => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return {
      fx: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      fy: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }

  const onMouseMove = (e: React.MouseEvent) => {
    if (conn !== 'open') return
    // 指针=本机原生光标(零延迟,硬件渲染);这里只把位置注给 PC,PC 光标被它驱动
    pendAbs.current = toFrac(e)
    if (!rafId.current) {
      rafId.current = requestAnimationFrame(() => {
        rafId.current = 0
        if (pendAbs.current) {
          clientRef.current?.sendInput({ t: 'abs', ...pendAbs.current })
          pendAbs.current = null
        }
      })
    }
  }

  const btnName = (b: number) => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left')

  const connLabel: Record<ConnState, string> = {
    idle: '未连接',
    connecting: '连接中…',
    open: '已连接',
    failed: '连接失败',
    closed: '已断开',
  }

  // ── 画质档位(2026-08-28):下拉选择替代三连钮;档位含义=编码目标高度 ──
  const [quality, setQuality] = useState(0)
  const applyQuality = (h: number) => {
    setQuality(h)
    clientRef.current?.sendInput({ t: 'quality', h })
  }
  const qLabel = (h: number) => (h === 0 ? '原生' : `${h}p`)

  // ── fps:1s 轮询时按 framesDecoded 增量折算 ──
  const [fps, setFps] = useState(0)
  const lastFrames = useRef({ t: 0, n: -1 })
  const calcFps = (line: string) => {
    const m = /dec=(\d+)/.exec(line)
    if (!m) return
    const n = Number(m[1]), now = performance.now()
    const prev = lastFrames.current
    if (prev.n >= 0 && n >= prev.n) setFps(Math.round(((n - prev.n) * 1000) / Math.max(1, now - prev.t)))
    lastFrames.current = { t: now, n }
  }

  // ── 中文输入(2026-08-28,RDP 式):画面区常驻隐形 IME 捕获框——本地输入法就地组字,
  // compositionend 整串 Unicode 注入 PC;功能键/快捷键照常键位透传(非组字态)。
  // 直通式仍可用:Shift 切 PC 端输入法中英。 ──
  // local=input / remote=div 两种捕获元素共用同一 ref(点画面统一 focus);
  // HTMLElement 基类,value 清理处 instanceof 收窄。
  const imeRef = useRef<HTMLElement | null>(null)
  /** 直通按住集合(e.code):keyup 只抬真正按过的;blur/断连全抬,防"键留 PC 按住"。 */
  const heldCodes = useRef<Set<string>>(new Set())
  const passDown = (code: string): boolean => {
    if (heldCodes.current.has(code)) return true // 自动重复交给 PC 侧 autorepeat,别双倍
    const k = codeVk(code)
    if (!k) return false
    heldCodes.current.add(code)
    clientRef.current?.sendInput({ t: 'keydown', key: k })
    return true
  }
  const passUp = (code: string) => {
    if (!heldCodes.current.delete(code)) return
    const k = codeVk(code)
    if (k) clientRef.current?.sendInput({ t: 'keyup', key: k })
  }
  const releaseHeld = () => {
    heldCodes.current.forEach((code) => {
      const k = codeVk(code)
      if (k) clientRef.current?.sendInput({ t: 'keyup', key: k })
    })
    heldCodes.current.clear()
  }
  /** 滚轮注入:rAF 合并 + 像素→刻数归一(2026-08-30 用户实测"卡顿/爆发"根修:
   *  浏览器给的是像素 deltaY(精密触摸板高频小量,滚轮 100/格),协议 d=刻数(分数可),
   *  canvas ×120 合成 WHEEL_DELTA;旧版直发原始像素→放大百倍,一格格滚变一页页飞。 */
  const pendWheel = useRef(0)
  const wheelRaf = useRef(0)
  const onWheelInj = (e: React.WheelEvent) => {
    if (conn !== 'open') return
    // deltaMode: 0=px(~100/刻度) 1=行(3 行/刻度) 2=页(1 页/刻度)
    pendWheel.current += e.deltaMode === 1 ? e.deltaY / 3 : e.deltaMode === 2 ? e.deltaY : e.deltaY / 100
    if (!wheelRaf.current) {
      wheelRaf.current = requestAnimationFrame(() => {
        wheelRaf.current = 0
        const d = pendWheel.current
        pendWheel.current = 0
        if (Math.abs(d) >= 0.02) clientRef.current?.sendInput({ t: 'wheel', d })
      })
    }
  }
  /** local 混合语义(2026-08-30 v3,用户实测 Shift/Ctrl+Shift+Esc 无效根修):
   *  修饰键/功能键/带 ctrl|alt|win 的组合 → e.code 物理直通(按住语义——Shift+点击框选、
   *  Win+方向、Ctrl 组合全靠它;旧版 Shift 单按不可映射被静默丢弃);
   *  纯可打印字符仍 text 注入(绕开 PC 端 IME 中文态,本地组字语义不破)。
   *  组字中(isComposing)全放行给本地 IME。 */
  const imeKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (conn !== 'open') return
    if (e.nativeEvent.isComposing) return
    const k = codeVk(e.code)
    if (k && (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey)) {
      e.preventDefault()
      passDown(e.code)
      if (imeRef.current instanceof HTMLInputElement) imeRef.current.value = ''
      return
    }
    if (e.key.length === 1) {
      e.preventDefault()
      clientRef.current?.sendInput({ t: 'text', s: e.key })
      if (imeRef.current instanceof HTMLInputElement) imeRef.current.value = ''
    }
    // 无法映射的功能键放行本地,防呆
  }

  /** 全屏(2026-08-28 v3):整屏只剩视频 + 右缘半透明小圆钮(全屏切换 + 输入法模式)。
   *  Tauri setFullscreen 隐藏任务栏;CSS 隐藏 TitleBar/控制条/设备列表。 */
  const [fsOn, setFsOn] = useState(false)

  /** canvas 渲染循环:video(隐藏) → drawImage → canvas(可见)。
   *  WebView2 下 <video> 直渲染可能黑屏(srcObject 有流但元素不画);2D canvas 稳定。 */
  useEffect(() => {
    if (!hasStream) return
    const v = videoRef.current, c = canvasRef.current
    if (!v || !c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const render = () => {
      if (v.videoWidth > 0 && v.readyState >= 2) {
        if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
          c.width = v.videoWidth
          c.height = v.videoHeight
        }
        ctx.drawImage(v, 0, 0)
      }
      rafRenderRef.current = requestAnimationFrame(render)
    }
    rafRenderRef.current = requestAnimationFrame(render)
    return () => cancelAnimationFrame(rafRenderRef.current)
  }, [hasStream])
  const toggleFullscreen = async () => {
    const next = !fsOn
    setFsOn(next)
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().setFullscreen(next)
    } catch { /* Tauri API 不可用(嵌入浏览器形态)时 CSS 级也够用 */ }
  }
  const minimizeWin = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().minimize()
    } catch { /* 浏览器形态无 Tauri,最小化只对 exe 形态有意义 */ }
  }

  /** 输入法模式:local=本地 IME 组字(中文推荐) / remote=键位直通(PC 端 IME 组字) */
  const [imeMode, setImeMode] = useState<'local' | 'remote'>('local')
  const toggleImeMode = () => setImeMode(m => m === 'local' ? 'remote' : 'local')

  return (
    <>
      {/* 全屏:隐藏 TitleBar,整屏视频 + 右缘浮动圆钮 */}
      {!fsOn && !embedded && <TitleBar title="远程桌面" port={PORT} />}
      <div className={`stage${fsOn ? ' fs' : ''}`}>
        <div className={`video-wrap${hasStream ? ' live' : ''}`}>
          <video
            ref={videoRef}
            className="screen"
            playsInline
            muted
            autoPlay
            tabIndex={0}
            style={{ display: 'none' }} /* 视频元素隐藏,canvas 渲染替代(WebView2 兼容) */
            onMouseMove={onMouseMove}
            onMouseDown={(e) => {
              if (conn !== 'open') return
              e.preventDefault() // 见 canvas 同名注释
              imeRef.current?.focus()
              const { fx, fy } = toFrac(e)
              clientRef.current?.sendInput({ t: 'abs', fx, fy })
              clientRef.current?.sendInput({ t: 'down', btn: btnName(e.button) })
            }}
            onMouseUp={(e) => {
              if (conn !== 'open') return
              clientRef.current?.sendInput({ t: 'up', btn: btnName(e.button) })
            }}
            onWheel={onWheelInj}
            onContextMenu={(e) => e.preventDefault()}
          />
          {/* canvas 渲染层(WebView2 兼容):video 隐藏,canvas 画帧;指针=本机原生光标,
              形状随 PC 真实光标带外广播切换(CSS_CURSOR),RDP 同架构零延迟 */}
          <canvas
            ref={canvasRef}
            style={{
              display: hasStream ? 'block' : 'none',
              width: '100%', height: '100%',
              // 满铺零死边(2026-08-31 设计定稿,屏占比=优化目标之一见 task.md):
              // contain 留黑边(无视频内容)违背目标;cover 裁掉任务栏/边角不可控;
              // fill 拉伸满铺——输入映射是分数坐标(toFrac)天然免疫拉伸,
              // 窗口与桌面宽高比差异小时失真不可感知。
              objectFit: 'fill',
              cursor: conn === 'open' ? (CSS_CURSOR[cshape] ?? 'default') : 'default',
              outline: 'none',
            }}
            onMouseMove={onMouseMove}
            onMouseDown={(e) => {
              if (conn !== 'open') return
              // preventDefault 必须先于 focus():mousedown 默认动作把焦点抢给被点元素
              // (canvas 无 tabindex→落到 BODY),先 focus 会被反抢,键盘消息全哑(2026-08-30 实测)
              e.preventDefault()
              imeRef.current?.focus()
              const { fx, fy } = toFrac(e)
              clientRef.current?.sendInput({ t: 'abs', fx, fy })
              clientRef.current?.sendInput({ t: 'down', btn: btnName(e.button) })
            }}
            onMouseUp={(e) => {
              if (conn !== 'open') return
              clientRef.current?.sendInput({ t: 'up', btn: btnName(e.button) })
            }}
            onWheel={onWheelInj}
            onContextMenu={(e) => e.preventDefault()}
          />
          {/* 指针=RDP 同架构:WGC 帧内无光标(WithoutCursor),viewer 用本机原生光标
              (硬件渲染零延迟),形状=PC 真实光标带外广播(cshape→CSS_CURSOR),位置=本机
              鼠标即 PC 光标(abs 注入 1:1 驱动)。多人同连各看各的指针,天然独立。 */}
          {/* PC 输入栈挂起提示(RDP 最小化/显示栈挂起):画面正常但输入暂停。死亡态下点画面/
              打字=明示接管意图,canvas 自动 tscon(接管后输入复活,RDP 窗口需重连);
              也可点「接管」钮或还原 RDP 窗口。 */}
          {conn === 'open' && cursorDead && (
            <div style={{
              position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
              zIndex: 30, background: 'rgba(20,24,32,.78)', color: 'rgba(255,255,255,.92)',
              padding: '6px 10px 6px 14px', borderRadius: 10, fontSize: 12, backdropFilter: 'blur(4px)',
              whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span>输入暂停(RDP 窗口最小化)——点一下画面即自动接管(RDP 会断开,可重连)</span>
              <button
                onClick={() => clientRef.current?.sendInput({ t: 'takeover' })}
                style={{
                  background: 'rgba(255,255,255,.14)', border: '1px solid rgba(255,255,255,.3)',
                  color: '#fff', borderRadius: 8, padding: '2px 10px', fontSize: 11, cursor: 'pointer',
                }}
                title="把 PC 会话切回本地控制台(远程窗接管输入;RDP 窗口需重连)"
              >
                接管 PC
              </button>
            </div>
          )}
          {/* IME 捕获:local 模式本地组字;remote 模式键位直通。两形态共用 imeRef(点画面统一 focus) */}
          {conn === 'open' && imeMode === 'local' && (
            <input
              ref={(el) => { imeRef.current = el }}
              className="ime-catcher"
              autoFocus
              onKeyDown={imeKeyDown}
              onKeyUp={(e) => { if (conn === 'open') passUp(e.code) }}
              onBlur={releaseHeld}
              onCompositionEnd={(e) => {
                const s = (e as React.CompositionEvent<HTMLInputElement>).data
                if (s) clientRef.current?.sendInput({ t: 'text', s })
                if (imeRef.current instanceof HTMLInputElement) imeRef.current.value = ''
              }}
            />
          )}
          {/* remote 模式:键位直通 div(PC 端 IME 组字) */}
          {conn === 'open' && imeMode === 'remote' && (
            <div
              ref={(el) => { imeRef.current = el }}
              className="ime-catcher"
              tabIndex={0}
              autoFocus
              onKeyDown={(e) => {
                if (conn !== 'open') return
                e.preventDefault()
                // remote=真直通:按 e.code 物理键位发 keydown/keyup——独立修饰键
                // (Shift 切 PC IME 中英)、组合键、Shift+点击、长按全部可表达。
                // repeat 由 held 集合天然去重(PC 侧 autorepeat 接管)。
                if (!passDown(e.code) && e.key.length === 1 && !e.repeat) {
                  clientRef.current?.sendInput({ t: 'text', s: e.key }) // 非标键位字符兜底
                }
              }}
              onKeyUp={(e) => {
                if (conn !== 'open') return
                e.preventDefault()
                passUp(e.code)
              }}
              onBlur={releaseHeld}
            />
          )}
          {/* RDP 式控制条(2026-08-29 设计定稿):小胶囊条可拖动,拖到任一屏幕边缘自动
              隐藏(留小把手),鼠标靠近该边缘滑出,离开 2s 缩回。不阻挡画面点击。 */}
          {conn === 'open' && (
            <CtlBar
              fsOn={fsOn}
              onToggleFs={() => void toggleFullscreen()}
              onMinimize={() => void minimizeWin()}
              imeMode={imeMode}
              onToggleIme={toggleImeMode}
              quality={quality}
              onQuality={applyQuality}
              onCombo={(key, mods) => clientRef.current?.sendInput({ t: 'key', key, mods })}
              onDone={() => setTimeout(() => imeRef.current?.focus(), 0)}
              qLabel={`${qLabel(quality)} · ${fps}fps`}
              onDisconnect={disconnect}
            />
          )}
          {/* 自动播放兜底 */}
          {needsPlay && hasStream && (
            <button
              style={{ position: 'absolute', inset: 0, zIndex: 40, background: 'rgba(0,0,0,.75)', color: '#fff', fontSize: 16, cursor: 'pointer', border: 'none' }}
              onClick={() => {
                const v = videoRef.current
                if (!v) return
                v.muted = false
                void v.play().finally(() => setNeedsPlay(false))
              }}
            >
              ▶ 点击启用画面与声音
            </button>
          )}
          {/* 未连接空态 */}
          {!hasStream && (
            <>
              <div className="glyph">屏</div>
              <div>{conn === 'connecting' ? 'WebRTC 建联中…' : '远程桌面视频区'}</div>
              <div className="hint">
                {REMOTE_HOST ? `跨机 → 主机 ${short(hostDid)}` : paired ? '已授权——点「连接」拉流' : '本机自看点「配对」;跨机复制 viewer DID 让主机授权'}
              </div>
            </>
          )}
        </div>

        {/* 控制条/设备列表:仅未连接时显示(open 态画面即一切,断开钮在右缘浮钮列) */}
        {!fsOn && conn !== 'open' && (
          <>
            <div className="ctl-row">
              <span className={`dot${(canvasOn || REMOTE_HOST) ? ' on' : ''}`} />
              <span className="ctl-text">
                {REMOTE_HOST ? `跨机 → 主机 ${short(hostDid)}` : canvasOn ? `主机 ${short(hostDid)}` : 'canvas 离线'}
              </span>
              <span className="flex1" />
              {!paired && !REMOTE_HOST && (
                <button className="btn accent" onClick={() => void pair()} disabled={!canvasOn}>
                  配对
                </button>
              )}
              {conn === 'connecting' ? (
                <button className="btn" onClick={disconnect}>断开</button>
              ) : (
                <button className="btn accent" onClick={() => void connect()} disabled={!paired || !hostDid}>
                  连接
                </button>
              )}
            </div>
            <div className="ctl-row sub">
              <span className="ctl-text">
                viewer {short(viewerDid)} · {connLabel[conn]}
                {err ? ` · ${err.slice(0, 60)}` : ''}
              </span>
              <span className="flex1" />
            </div>
            <div className="ctl-row sub">
              <span className="ctl-text">{statLine}</span>
            </div>
            <div className="dev-list">
              <div className="dev-head">
                <span>主机授权设备 {devices.length}</span>
                <span className="flex1" />
                {paired && <span className="badge ok">本 viewer 已授权</span>}
              </div>
              {devices.length === 0 && (
                <div className="empty">{canvasOn ? err || '暂无授权设备' : 'canvas 离线:设备清单不可用'}</div>
              )}
              {devices.map((d) => (
                <div className="dev-row" key={d.did}>
                  <span className={`dot${d.online ? ' on' : ''}`} />
                  <span className="name">{d.name || d.did}</span>
                  {d.did === viewerDid && <span className="badge ok">本机</span>}
                  {d.kind && <span className="badge">{d.kind}</span>}
                </div>
              ))}
            </div>
            <footer>myco media :{PORT} · B5-2 PC↔PC 远程桌面</footer>
          </>
        )}
      </div>
    </>
  )
}

/** RDP 式控制条(2026-08-29 设计定稿):小胶囊条,可拖动;拖到视口任一边缘松手→贴边自动隐藏
 *  (条滑出屏,只留小把手);鼠标靠近该边缘(≤8px)滑出;离开条区域 2s 自动缩回。
 *  不阻挡画面点击(贴边后完全不占画面);按钮 onMouseDown preventDefault 不夺键盘焦点。
 *  2026-08-30:左右贴边滑出改**纵向**布局(横条贴竖边又宽又突兀);隐藏位移用
 *  calc(-100%+6px) 自身百分比,不再量 offsetWidth——方向翻转瞬间旧宽度会把条整体推出屏
 *  (把手都不剩)。新增最小化钮(exe 形态 Tauri minimize)。 */
function CtlBar(p: {
  fsOn: boolean
  onToggleFs: () => void
  /** 最小化媒体窗口(仅 exe 形态有效) */
  onMinimize: () => void
  imeMode: 'local' | 'remote'
  onToggleIme: () => void
  quality: number
  onQuality: (h: number) => void
  /** 系统组合键代发(笔记本 OS 拦下的 Ctrl+Shift+Esc/Alt+Tab 等,由按钮经通道直发 PC) */
  onCombo: (key: string, mods: string[]) => void
  /** 交互收尾回调(选完画质把焦点还给 IME 捕获框) */
  onDone?: () => void
  qLabel: string
  onDisconnect: () => void
}) {
  type Edge = '' | 'top' | 'bottom' | 'left' | 'right'
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null) // null=默认顶部居中
  const [edge, setEdge] = useState<Edge>('')
  const [peek, setPeek] = useState(false)
  const [comboOpen, setComboOpen] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const EDGE_SNAP = 24 // 松手时距边缘 <24px 吸附
  const EDGE_PEEK = 8  // 鼠标距边缘 ≤8px 滑出

  // 拖动:Pointer 捕获,实时跟手
  const onGripDown = (e: React.PointerEvent) => {
    const bar = barRef.current
    if (!bar) return
    const r = bar.getBoundingClientRect()
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }
    bar.setPointerCapture(e.pointerId)
    setEdge('') // 拖动中脱离贴边态
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    const bar = barRef.current
    if (!bar) return
    const w = bar.offsetWidth, h = bar.offsetHeight
    const x = Math.min(Math.max(0, e.clientX - drag.current.dx), innerWidth - w)
    const y = Math.min(Math.max(0, e.clientY - drag.current.dy), innerHeight - h)
    setPos({ x, y })
  }
  const onPointerUp = () => {
    if (!drag.current) return
    drag.current = null
    const bar = barRef.current
    if (!bar || !pos) return
    // 贴边吸附判定
    const w = bar.offsetWidth, h = bar.offsetHeight
    if (pos.y < EDGE_SNAP) setEdge('top')
    else if (pos.y + h > innerHeight - EDGE_SNAP) setEdge('bottom')
    else if (pos.x < EDGE_SNAP) setEdge('left')
    else if (pos.x + w > innerWidth - EDGE_SNAP) setEdge('right')
    else setEdge('')
  }

  // 贴边态:鼠标靠近对应边缘滑出;离开 2s 缩回
  useEffect(() => {
    if (!edge) return
    const onMove = (e: MouseEvent) => {
      const near =
        (edge === 'top' && e.clientY <= EDGE_PEEK) ||
        (edge === 'bottom' && e.clientY >= innerHeight - EDGE_PEEK) ||
        (edge === 'left' && e.clientX <= EDGE_PEEK) ||
        (edge === 'right' && e.clientX >= innerWidth - EDGE_PEEK)
      if (near) {
        setPeek(true)
        if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null }
      }
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [edge])
  const onBarLeave = () => {
    if (!edge) return
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setPeek(false), 2000)
  }
  const onBarEnter = () => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null }
  }

  // 贴边态的条位置:滑出屏只留 6px 小把手。位移用自身百分比 calc(±(100%-6px))——
  // 方向翻转(横↔纵)瞬间 DOM 尺寸还是旧值,量 offsetWidth 会把条整体推出屏。
  const edgeStyle = (e: Edge, showing: boolean): React.CSSProperties => {
    const hide = 'calc(-100% + 6px)', show = '0'
    switch (e) {
      case 'top': return { left: '50%', top: 0, transform: `translate(-50%,${showing ? show : hide})` }
      case 'bottom': return { left: '50%', bottom: 0, top: 'auto', transform: `translate(-50%,${showing ? show : 'calc(100% - 6px)'})` }
      case 'left': return { left: 0, top: '50%', transform: `translate(${showing ? show : hide},-50%)` }
      case 'right': return { right: 0, left: 'auto', top: '50%', transform: `translate(${showing ? show : 'calc(100% - 6px)'},-50%)` }
      default: return {}
    }
  }

  const vertical = edge === 'left' || edge === 'right'
  const floating: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y }
    : { left: '50%', top: 10, transform: 'translateX(-50%)' }
  const docked = edge ? edgeStyle(edge, peek) : {}
  // 贴边+非 peek 时 pointerEvents 保持(把手 6px 可点可 hover)
  const style: React.CSSProperties = {
    position: 'fixed', zIndex: 50, display: 'flex', alignItems: 'center', gap: 6,
    flexDirection: vertical ? 'column' : 'row',
    padding: vertical ? '8px 4px' : '4px 8px', borderRadius: 12, userSelect: 'none',
    background: 'rgba(14,18,24,.55)', backdropFilter: 'blur(6px)',
    border: '1px solid rgba(255,255,255,.14)',
    transition: drag.current ? 'none' : 'transform .18s ease-out, left .18s, top .18s',
    ...floating, ...docked,
  }

  return (
    <div
      ref={barRef}
      style={style}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onMouseEnter={onBarEnter}
      onMouseLeave={onBarLeave}
      // 整条件外阻止 mousedown 默认抢焦(按钮/手柄/条身都不夺 IME 捕获框焦点);
      // 唯一下拉框例外:原生 select 的展开就是 mousedown 默认动作,阻了下拉打不开
      onMouseDown={(e) => { if (!(e.target as HTMLElement).closest('select')) e.preventDefault() }}
    >
      {/* 拖动手柄 */}
      <div
        onPointerDown={onGripDown}
        style={{ cursor: 'grab', padding: '2px 4px', color: 'rgba(255,255,255,.5)', fontSize: 11, letterSpacing: -1, touchAction: 'none' }}
        title="拖动我;拖到屏幕边缘自动隐藏"
      >
        ⋮⋮
      </div>
      <button onClick={p.onMinimize} style={barBtn} title="最小化窗口">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M5 12h14" />
        </svg>
      </button>
      <button onClick={p.onToggleFs} style={barBtn} title={p.fsOn ? '退出全屏' : '全屏'}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          {p.fsOn
            ? <><path d="M8 3v3a2 2 0 0 1-2 2H3" /><path d="M21 8h-3a2 2 0 0 1-2-2V3" /><path d="M3 16h3a2 2 0 0 1 2 2v3" /><path d="M16 21v-3a2 2 0 0 1 2-2h3" /></>
            : <><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></>}
        </svg>
      </button>
      <button onClick={p.onToggleIme} style={{ ...barBtn, width: 'auto', padding: '0 8px', fontSize: 11, fontWeight: 600 }} title={p.imeMode === 'local' ? '本地组字(点切远端 IME)' : '远端 IME(点切本地组字)'}>
        {p.imeMode === 'local' ? '中' : 'EN'}
      </button>
      {/* 组合键代发:Ctrl+Shift+Esc/Alt+Tab 等被本机 OS 拦截,网页永远收不到,
          只能由按钮经通道直发 PC(RDP 的"Windows 组合键作用于远程"同义) */}
      <button onClick={() => setComboOpen((v) => !v)} style={{ ...barBtn, width: 'auto', padding: '0 8px', fontSize: 11, fontWeight: 600 }} title="代发系统组合键(任务管理器/Alt+Tab 等)">
        组合
      </button>
      {comboOpen && (
        <div
          style={{
            position: 'absolute', display: 'flex', flexDirection: 'column', gap: 2, padding: 6,
            background: 'rgba(14,18,24,.92)', border: '1px solid rgba(255,255,255,.14)', borderRadius: 10,
            // 朝向随停靠边翻转:竖边横向开(右贴边向左开),横边纵向开(底贴边向上开),
            // 默认顶部居中的横条必须【向下】开——向上会整体出视口够不着(2026-08-30 实测)
            ...(vertical
              ? (edge === 'right' ? { right: '100%', top: 0, marginRight: 6 } : { left: '100%', top: 0, marginLeft: 6 })
              : (edge === 'bottom' ? { bottom: '100%', left: 0, marginBottom: 6 } : { top: '100%', left: 0, marginTop: 6 })),
          }}
        >
          {([
            ['任务管理器', 'esc', ['ctrl', 'shift']],
            ['切换窗口', 'tab', ['alt']],
            ['显示桌面', 'd', ['win']],
            ['运行', 'r', ['win']],
            ['锁屏', 'l', ['win']],
          ] as [string, string, string[]][]).map(([label, key, mods]) => (
            <button
              key={label}
              onClick={() => { p.onCombo(key, mods); setComboOpen(false); p.onDone?.() }}
              style={{ ...barBtn, width: 'auto', padding: '4px 10px', fontSize: 11, whiteSpace: 'nowrap', textAlign: 'left' }}
            >
              {label}<span style={{ opacity: 0.5, marginLeft: 6 }}>{[...mods, key].join('+')}</span>
            </button>
          ))}
        </div>
      )}
      <select
        onChange={(e) => {
          p.onQuality(Number(e.target.value))
          e.currentTarget.blur()
          p.onDone?.() // 选完把焦点还给 IME 捕获框(blur 之后才轮到我们,setTimeout 排队)
        }}
        value={p.quality}
        style={{ ...barBtn, width: 'auto', padding: '0 4px', fontSize: 11, appearance: 'none', textAlign: 'center' }}
        title={`画质 ${p.qLabel}`}
      >
        <option value={0}>原生</option>
        <option value={720}>720</option>
        <option value={1080}>1080</option>
      </select>
      <button onClick={p.onDisconnect} style={{ ...barBtn, width: 'auto', padding: '0 8px', fontSize: 11, fontWeight: 600 }} title="断开连接">
        断
      </button>
    </div>
  )
}

const barBtn: React.CSSProperties = {
  width: 24, height: 24, borderRadius: 8, border: 'none',
  background: 'rgba(255,255,255,.08)', color: 'rgba(255,255,255,.9)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', fontSize: 11, outline: 'none', WebkitAppearance: 'none',
}
