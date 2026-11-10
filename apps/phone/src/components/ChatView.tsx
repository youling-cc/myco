/**
 * ChatView — 聊天气泡式执行视图（phone/canvas 共用单一源）。
 *
 * 数据走 beliefStore（C 层 belief，s'）：
 *  - 历史对话：lazy 拉 jsonl（滚到顶加载更早）
 *  - 当前轮 pending：appState=working 时底部"正在生成"气泡 + spinner 状态行
 *  - 顶部条：session 标题 + 主题色切换 + 工作时长 + 展开 popover
 *  - 虚拟化 + stick-to-bottom + 新消息角标
 *
 * 复用约定（最大复用）：
 *  - phone/canvas 都从本文件引（canvas 经 @phone alias）。
 *  - 主题用 useChatTheme（localStorage 持久，两端共享）。
 *  - subscribe prop：phone 默认 true（自订阅 belief-events 喂 store）；canvas 传 false
 *    （它由 useTerminalAgent 持有 SSE，避免双订阅）。
 *
 * 样式：../styles/phone-chat.css（.myco-chat-view 作用域）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import 'highlight.js/styles/github-dark.css'
import { SendHorizontal, ImagePlus, X, ArrowLeft, ArrowUpToLine, ArrowDownToLine, ChevronUp, ChevronDown, ListCollapse } from 'lucide-react'
import type { Transport, SessionInfo, ChatMessage, ModelOption, ProjectInfo } from '../transport'
import { MessageBubble, DEFAULT_EXPAND_TOOLS, DEFAULT_EXPAND_THINKING, defaultModelColor, toolIcon } from './MessageBubble'
import { PickerView } from './PickerView'
import { TodoPanel } from './TodoPanel'
import { TerminalView } from './TerminalView'
import { DesktopView } from './DesktopView'
import { quickThemes } from '../chat-themes'
import { useChatTheme } from '../use-chat-theme'
import { useBeliefStore } from '../belief-store'
import { ApprovalCard, FineStateBadge, approvalSteps, resolveHarness } from './FineState'
import { WorkingIndicator } from './WorkingIndicator'
import { filterGeneratingLines, truncWords } from './genTextFilter'
import { PerfHud, markExpand, bumpChatRender, isPerfOn } from './PerfHud'
import { useWorkRest, fmtDur2 } from '../work-rest'
import '../styles/phone-chat.css'

const PAGE = 50
const EXPAND_TOOLS_LS_KEY = 'myco.chat.expandTools'
const EXPAND_THINKING_LS_KEY = 'myco.chat.expandThinking'

/** 模块级稳定空数组——selector 兜底用，避免每次返回新引用触发重渲。 */
const EMPTY_MESSAGES: ChatMessage[] = []
const EMPTY_AGENTS: import('../transport').AgentLive[] = []

/** 稳定 key：uuid 优先（jsonl 权威），否则 role+timestamp+序号兜底。前插历史不位移。 */
function bubbleKey(m: { uuid?: string | null; role: string; timestamp?: string | null }, i: number): string {
  if (m.uuid) return m.uuid
  return `${m.role}-${m.timestamp ?? '0'}-${i}`
}

/** 图片自动压缩：>2MB 先缩到 1600px JPEG(q0.85)——不让用户自己想办法。
 *  透明底铺白（JPEG 无 alpha）；缩完仍 >5MB 才拒（极少见）。
 *  2026-09-29 移到模块顶层导出：FriendsPanel 好友聊天发图复用（手机相册大图
 *  普遍超 2MB 发送上限，直接拒发="传照片"形同虚设——Bug2 配套）。 */
export async function compressImage(file: File, maxDim = 1600, quality = 0.85): Promise<Blob> {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bmp, 0, 0, w, h)
  return (await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/jpeg', quality))) ?? file
}

/** pending 生成文本渲染（2026-09-03 二轮:行首类型标识+双态视觉）。
 *
 *  两大态(设计定稿):执行工作 vs 正在思考——行首标记区分:
 *    ⚡/📄/🔍 = 执行工具(动作)     ↳ = 工具结果(回声)
 *    ∼ = 思考/推理(内部)           · = 状态/信息
 *  容器随 fineState 切换边色:tool_running=蓝(accent)/generating=紫(思考)
 *  ANSI 清洗+路径截断+只显尾 3 行(一轮已做,保持) */
/** pending 生成文本渲染(2026-09-13 设计定稿四轮重做)。
 *
 *  生成中：只显示拼接出的**最尾部一行**（最新在干嘛），点击展开全量。
 *  展开后：显示全部行（工具/结果/思考/状态），点击收起回单行。
 *  完成后：ThinkingBlock 气泡从头部接管（已有，不属于这里）。
 *  工具调用同理——执行中只显最新工具动作行，展开看完整过程。 */
function GenText({ text, mode }: { text: string; mode?: 'thinking' | 'executing' }) {
  const [expanded, setExpanded] = useState(false)
  const { lines: all } = filterGeneratingLines(text)
  if (all.length === 0) return null
  const last = all[all.length - 1]
  const markerOf = (g: { kind: string; toolWord?: string }) => {
    if (g.kind === 'tool') {
      return g.toolWord ? <span className="tool-ic">{toolIcon(g.toolWord)}</span> : null
    }
    return null
  }
  return (
    <div className={`generating-text${mode === 'thinking' ? ' gen-thinking-mode' : mode === 'executing' ? ' gen-executing-mode' : ''}`}>
      {!expanded ? (
        /* 折叠态：单行——最新活动 + 展开提示 */
        <div className="gen-line gen-last" onClick={() => setExpanded(true)} title="点击展开完整生成过程">
          {markerOf(last)}
          <span className="gen-last-text">{truncWords(last.text, 72)}</span>
          {all.length > 1 && <span className="gen-expand-hint">▾{all.length}</span>}
        </div>
      ) : (
        /* 展开态：全部行（截尾 12 行防超长）+ 收起 */
        <>
          <div className="gen-collapse" onClick={() => setExpanded(false)}>▴ 收起</div>
          {all.slice(-12).map((g, i) => {
            if (g.kind === 'result') return <div key={i} className="gen-line gen-result">↳ {g.text}</div>
            if (g.kind === 'status') return <div key={i} className="gen-line gen-status">· {g.text}</div>
            return <div key={i} className={`gen-line${g.kind === 'thought' ? ' gen-thought' : ''}`}>{markerOf(g)}{g.text}</div>
          })}
        </>
      )}
    </div>
  )
}



/** 2026-10-18 聊天微信化（M11）：对话视图的「正在回复」极简指示——只有呼吸三点，
 *  不呈现过程文字（工具行/计时/状态胶囊只在轨迹视图）。复用 phone-chat.css 既有
 *  .typing-dots（原本是 working-indicator 的前身，视觉语言一致）。 */
function TypingDots() {
  return (
    <span className="typing-dots" title="AI 正在回复" aria-label="AI 正在回复">
      <span /><span /><span />
    </span>
  )
}

export function ChatView({
  transport,
  session,
  modelColor,
  subscribe = true,
  onBack,
  onOpenTheme,
  ownAuthor,
  headerSlot,
  modelLabel,
  harnessLabel,
  modelOptions,
  harnessOptions,
  onSetModel,
  onSetHarness,
  currentModelId,
  currentHarnessId,
  hideViewToggle,
  replayFooter,
  onToggleRecord,
  recording,
  onOpenUsage,
  replayReadOnly,
}: {
  transport: Transport
  session: SessionInfo
  modelColor?: string
  /** true=本组件自订阅 transport belief-events 喂 store（phone）；false=调用方自己管（canvas 的 useTerminalAgent）。 */
  subscribe?: boolean
  /** 可选返回按钮（phone 的 session 列表返回）。 */
  onBack?: () => void
  /** 打开完整外观设置面板（chatwin 的 ThemeSettings）；不传=无「色」入口（配色仍可点圆点快切）。 */
  onOpenTheme?: () => void
  /** 自己的 有灵账号名（user 气泡作者兜底：本机直接输入的消息没 author 时显示它）。 */
  ownAuthor?: string
  /** canvas 执行页：chat-head 内容上移到 App header 的目标元素（createPortal）；不传=本地渲染（phone）。 */
  headerSlot?: HTMLElement | null
  /** header 灰字：当前生效模型名（如 glm-5.3）。 */
  modelLabel?: string
  /** 实时数据集录制开关（chatwin→ta /api/sensor_record;phone 端 webrtc 也可用 http 隧道,后续接）。 */
  onToggleRecord?: (on: boolean) => Promise<boolean> | void
  /** 当前录制状态(父组件持有——切会话保持 per-session 记忆)。 */
  recording?: boolean
  /** 打开总 token 用量面板（chatwin 工作区入口；canvas 有自家 header 入口，不传=不显示）。 */
  onOpenUsage?: () => void
  /** 回放只读态（2026-09-13 OSAR 界面回放）：隐藏「停止生成」钮——回放灌 pending=working 会误显。 */
  replayReadOnly?: boolean
  /** header 灰字：当前 Harness 代理名（如 Claude）。 */
  harnessLabel?: string
  /** 模型可选项（canvas 从 providers 构建；phone 不传=不可改）。 */
  modelOptions?: { id: string; label: string }[]
  /** Harness 可选项。 */
  harnessOptions?: { id: string; label: string; installed: boolean }[]
  /** 切换模型回调。 */
  onSetModel?: (id: string | null) => void
  /** 切换 Harness 回调。 */
  onSetHarness?: (id: string | null) => void
  /** 当前模型 providerId（选中态）。 */
  currentModelId?: string
  /** 当前 harness id。 */
  currentHarnessId?: string
  /** 隐藏头部 💬/终端/远程桌面 视图切换组(工作区四主视图已覆盖同语义:
   *  聊=主视图「聊」、终端=「端」;phone 不传=保留,手机端这是主要交互)。 */
  hideViewToggle?: boolean
  /** 回放态底部槽位:传入则整个输入区被替换为该节点(K3 定稿 2026-08-28:回放只读
   *  不做"置灰输入框"的假控件,底部槽位直接换成播放器 dock——播放器心智)。 */
  replayFooter?: React.ReactNode
}) {
  const sid = session.sessionId
  // 连续工作块/休息计时(2026-09-01 用户:工作总时间,空闲>30s 重置;停下显休息时长)
  const wr = useWorkRest(sid)
  if (isPerfOn()) bumpChatRender() // 性能 HUD：统计本组件重渲次数（dev only）
  // 精细订阅：拆 belief 为独立选择器，gen_progress 只动 pending → messages 不重渲（滚动丝滑）。
  const messages = useBeliefStore((s) => s.beliefs[sid]?.messages ?? EMPTY_MESSAGES)
  const pending = useBeliefStore((s) => s.beliefs[sid]?.pending ?? null)
  const interactive = useBeliefStore((s) => s.beliefs[sid]?.interactive ?? false)
  const picker = useBeliefStore((s) => s.beliefs[sid]?.picker ?? null)
  const todos = useBeliefStore((s) => s.beliefs[sid]?.todos ?? null)
  // H4 细态三件套的数据源（state 事件驱动，变化才推）
  const appState = useBeliefStore((s) => s.beliefs[sid]?.appState ?? null)
  const fineState = useBeliefStore((s) => s.beliefs[sid]?.fineState ?? null)
  const appType = useBeliefStore((s) => s.beliefs[sid]?.appType ?? null)
  // 气泡 harness 对比基准：显式 prop 优先（canvas），否则 appType 兜底（phone）
  const effectiveHarness = currentHarnessId ?? (appType ? appType.replace(/_/g, '-') : undefined)
  const approval = useBeliefStore((s) => s.beliefs[sid]?.approval ?? null)
  // 忙态胶囊(2026-09-02):动作动词+本轮 token 用量(spinner 行提炼,state 事件增量)
  const hintAction = useBeliefStore((s) => s.beliefs[sid]?.hintAction ?? null)
  const tokensUsed = useBeliefStore((s) => s.beliefs[sid]?.tokensUsed ?? null)
  // todos 防抖：claude 重绘时 todo 页脚可能瞬时空缺，直接清会闪烁；null 延迟 600ms 再清。
  const [todosView, setTodosView] = useState(todos)
  useEffect(() => {
    if (todos) { setTodosView(todos); return }
    const t = setTimeout(() => setTodosView(null), 600)
    return () => clearTimeout(t)
  }, [todos])
  // 最后一条 assistant 消息里的 AskUserQuestion 是否"当前正在问"：
  // 必须同时满足 live.interactive（claude 确在 picker 态）——否则加载历史时，
  // 某条已作答的 AskUserQuestion 恰好是最后一条 assistant 消息，会被误判成"正在问"。
  const askUserMsgIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'assistant') continue
      return m.toolUse?.some((t) => /AskUserQuestion/i.test(t.name)) ? i : -1
    }
    return -1
  }, [messages])
  const askUserActive = interactive && askUserMsgIdx >= 0
  // 区分「真·选择 picker」(有 ❯ 选中项，如 /model /rewind) vs「纯展示功能屏」(如 /context /status)。
  // 依据是测试报告 PICKER-COMMAND-TEST-REPORT.md 的分类：选择类才有 ❯，展示类没有。
  const hasSelection = !!(picker?.lines.some((l) => l.trimStart().startsWith('❯')))
  // 默认 false(2026-09-05):未加载确认前不显示"上滑加载更早…"——曾默认 true,
  // 空会话/加载延迟期误导用户"还有历史没加载"(幽灵锚任务重开=全新空会话,
  // 提示挂 3s+);确认有更多历史后才显示。
  const historyHasMore = useBeliefStore((s) => s.beliefs[sid]?.historyHasMore ?? false)
  const agents = useBeliefStore((s) => s.beliefs[sid]?.agents ?? EMPTY_AGENTS)
  const ensureSession = useBeliefStore((s) => s.ensureSession)
  // 连接路径指示器：直连/中转/连接中（仅 WebRTC transport 实现 connInfo）。轮询 2s。
  const [connKind, setConnKind] = useState<'direct' | 'relay' | 'connecting' | null>(null)
  useEffect(() => {
    if (!transport.connInfo) { setConnKind(null); return }
    let on = true
    const tick = async () => { if (!on) return; try { setConnKind(await transport.connInfo!()) } catch { /* ignore */ } }
    void tick()
    const id = setInterval(tick, 2000)
    return () => { on = false; clearInterval(id) }
  }, [transport])
  const appendHistory = useBeliefStore((s) => s.appendHistory)

  const [loadingOlder, setLoadingOlder] = useState(false)
  /** 挂载时刻：早于它的消息=历史气泡，永久 no-anim（容器级动画开关切换会全体重播 mc-rise——
   *  开屏 350ms 后闪一下、加载更早后顶部一直闪的根因）；晚于它的=实时新消息，正常播 mc-rise。 */
  const mountTsRef = useRef(Date.now())
  const [err, setErr] = useState<string | null>(null)
  /** 死会话判定(terminal "Session not found" / AOP "AOP 会话不存在")——
   *  触发友好下线态而非红错横幅。 */
  const isDeadSessionErr = (msg: string) => /session .*not found|会话不存在/i.test(msg)
  /** 错误横幅统一话术：网络类失败(canvas/主机不可达,常见于主机重启窗口)说人话——
   *  文本仍留在输入框,恢复后直接重发即可;其余原样透出。 */
  const friendlyErr = (e: unknown) => {
    const msg = String(e).replace(/^Error:\s*/, '')
    return /failed to fetch|networkerror|load failed|err_connection/i.test(msg)
      ? '主机连接中断(可能正在重启)——输入内容已保留,稍后重试即可'
      : msg
  }
  // zcode 桥会话 working 心跳(轮询 status→本地 1s 计时驱动 WorkingIndicator;
  // zcWorking=working 起始时刻戳,0=空闲)
  const [zcWorking, setZcWorking] = useState(0)
  const [zcElapsed, setZcElapsed] = useState(0)
  useEffect(() => {
    if (!zcWorking) return
    const t = setInterval(() => setZcElapsed(Math.floor((Date.now() - zcWorking) / 1000)), 1000)
    return () => clearInterval(t)
  }, [zcWorking])

  // 视图模式：💬 结构化聊天 / 🖥 raw 终端（原味 mac 终端，彩色单元格 + 键透传 + 撞边滚屏）/ 远程桌面
  // (远程桌面在任务页顶栏也有设备级入口;这里保留是因调试中常要立刻看 PC 画面)
  const [viewMode, setViewMode] = useState<'chat' | 'terminal' | 'desktop'>(() => {
    const v = localStorage.getItem('myco-chat-viewmode')
    return v === 'terminal' ? 'terminal' : v === 'desktop' ? 'desktop' : 'chat'
  })
  useEffect(() => { localStorage.setItem('myco-chat-viewmode', viewMode) }, [viewMode])
  // AOP chat-native 会话:无终端/远程桌面视图,永远聊天视图(输入经 canvas aop/message)
  const isAopSession = session.command === 'aop'
  useEffect(() => {
    if (isAopSession && viewMode !== 'chat') setViewMode('chat')
  }, [isAopSession, viewMode])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  /** 待发图片（选图后暂存，发送键才真上传；可 ✕ 删除撤回）。 */
  const [pendingImgs, setPendingImgs] = useState<{ b64: string; dataURL: string; kind?: 'image' | 'file'; name?: string }[]>([])
  // 每会话独立草稿/待发图（按 sessionId 存）：ChatView 被复用时 useState 不重置，
  // 靠这两个 ref 在切换会话时存/恢复——各项目输入区互不串台、切回各自保留。
  // kind/name(2026-09-05 文件粘贴):image=图片缩略预览;file=非图文件 chip。
  // 兼容旧字段:b64=dataURL(全量 dataURL,上传与回显共用)。
  type Img = { b64: string; dataURL: string; kind?: 'image' | 'file'; name?: string }
  const draftMap = useRef<Record<string, string>>({})
  const imgsMap = useRef<Record<string, Img[]>>({})
  const updateText = useCallback((nv: string) => {
    setText(nv)
    draftMap.current[session.sessionId] = nv
  }, [session.sessionId])
  const updateImgs = useCallback((u: Img[] | ((prev: Img[]) => Img[])) => {
    setPendingImgs((prev) => {
      const next = typeof u === 'function' ? u(prev) : u
      imgsMap.current[session.sessionId] = next
      return next
    })
  }, [session.sessionId])
  const [, setShowJumpBottom] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  /** 展开开关（两个独立 boolean → primitive props，memo 有效；切一个不连带重渲另一个的气泡）。 */
  const [expandTools, setExpandTools] = useState<boolean>(() => {
    const raw = localStorage.getItem(EXPAND_TOOLS_LS_KEY)
    return raw == null ? DEFAULT_EXPAND_TOOLS : raw === '1'
  })
  const [expandThinking, setExpandThinking] = useState<boolean>(() => {
    const raw = localStorage.getItem(EXPAND_THINKING_LS_KEY)
    return raw == null ? DEFAULT_EXPAND_THINKING : raw === '1'
  })
  const [showExpandMenu, setShowExpandMenu] = useState(false)
  /** 2026-10-18 聊天微信化（M11）：默认「对话」=只呈现人的消息 + AI 最终回答正文；
   *  「轨迹」=工具调用/工具结果/思考/运行状态等过程全显。默认不展开，进会话重置。
   *  入口=jump-nav 底部那枚极轻的「过程」小钮（对话 ↔ 轨迹 切换）。 */
  const [showTrace, setShowTrace] = useState(false)
  useEffect(() => { setShowTrace(false) }, [session.sessionId])
  const menuHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const expandMenuRef = useRef<HTMLDivElement>(null)
  // 点外部关展开菜单（替代 overlay——overlay 会盖住按钮导致 mouseleave 误触发）
  useEffect(() => {
    if (!showExpandMenu) return
    const onDocClick = (e: MouseEvent) => {
      if (expandMenuRef.current && !expandMenuRef.current.contains(e.target as Node)) {
        setShowExpandMenu(false)
      }
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [showExpandMenu])
  /** 长按主题点 → 自定义颜色选择器 */
  const [showColorPicker, setShowColorPicker] = useState(false)
  /** header 模型/Harness 配置弹窗 */
  const [showConfigPicker, setShowConfigPicker] = useState(false)
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null)
  const configPickerRef = useRef<HTMLDivElement>(null)
  const configPopoverRef = useRef<HTMLDivElement>(null)  // popover createPortal 到 body，独立引用
  const canConfig = !!(onSetModel || onSetHarness)
  useEffect(() => {
    if (!showConfigPicker) return
    const onDocClick = (e: MouseEvent) => {
      // popover 经 createPortal 移到 body 脱离了 configPickerRef——触发器与弹窗都算"内部"，否则点弹窗里的下拉被误判成"点外部"误关
      const t = e.target as Node
      const inTrigger = configPickerRef.current?.contains(t)
      const inPopover = configPopoverRef.current?.contains(t)
      if (!inTrigger && !inPopover) setShowConfigPicker(false)
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [showConfigPicker])
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { localStorage.setItem(EXPAND_TOOLS_LS_KEY, expandTools ? '1' : '0') }, [expandTools])
  useEffect(() => { localStorage.setItem(EXPAND_THINKING_LS_KEY, expandThinking ? '1' : '0') }, [expandThinking])
  const fileRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const firstLoadedRef = useRef(false)

  // stick-to-bottom 模型：容器 column-reverse，scrollTop=0 即底部、上翻为负——近底（<=阈值）
  // 就粘住，新消息/展开自动贴底（scrollTop=0 保持即可）；用户主动上滑远离底部才解除粘住。
  const STICK_THRESHOLD = 40
  const stickRef = useRef(true)
  /** 程序性滚动时屏蔽一次 onScroll，避免把自己贴底的动作误判成"用户上滚"。 */
  const suppressScrollRef = useRef(false)
  /** 看历史期间（stick=false）累计的新消息数，显示在「最新」按钮角标上；回到底部清零。 */
  const [unread, setUnread] = useState(0)
  const prevLenRef = useRef(0)
  /** 文字选中期间暂停粘底(2026-08-30 修):用户拖选跨气泡文本时,新消息到达
   *  自动贴底会把容器滚动→选中被截断/重置("拷贝漏选中"的根因)。选中非空时
   *  保持当前 stick 态不强制贴底;selectionchange 清空时恢复。
   */
  const selectingRef = useRef(false)
  useEffect(() => {
    const onSelChange = () => {
      const sel = document.getSelection()
      const has = !!sel && !sel.isCollapsed && sel.toString().length > 0
      selectingRef.current = has
    }
    document.addEventListener('selectionchange', onSelChange)
    return () => document.removeEventListener('selectionchange', onSelChange)
  }, [])
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    if (suppressScrollRef.current) return
    const dist = -el.scrollTop // column-reverse：底部=0，上翻越来越负
    const stick = dist <= STICK_THRESHOLD
    stickRef.current = stick
    setShowJumpBottom(!stick)
    if (stick && unread > 0) setUnread(0)
  }, [unread])
  const timedToggle = (setter: (fn: (v: boolean) => boolean) => void) => {
    const t0 = performance.now()
    setter((v) => !v)
    requestAnimationFrame(() => markExpand(performance.now() - t0))
  }
  // pending 气泡的模型名/色 移到 modelsRef 之后（需 provider 列表匹配 @模型名）。

  // 自订阅 belief-events（phone 用；canvas 传 subscribe=false 由 useTerminalAgent 管）
  useEffect(() => {
    if (!subscribe) return
    const unsub = transport.subscribe(session, (json) => {
      try { useBeliefStore.getState().applyObservationEvent(JSON.parse(json)) } catch { /* 噪音/半包丢弃 */ }
    })
    return unsub
  }, [transport, session, subscribe])

  // 进 session：建 belief + 拉最近一批历史
  useEffect(() => {
    // 会话切换：恢复该会话的草稿/待发图（按 sessionId 隔离——各项目独立输入区，切回各自保留）
    setText(draftMap.current[session.sessionId] ?? '')
    setPendingImgs(imgsMap.current[session.sessionId] ?? [])
    ensureSession(session.sessionId, session.taskId)
    firstLoadedRef.current = false
    initialPinDoneRef.current = false
    let cancelled = false
    // collab 会话(插件化)：消息来自 App 层轮询(/api/collab/messages)——不走 ta
    // history 首拉（ta 无此会话，Session not found 错误曾是红色误报源）
    const isCollab = session.command === 'collab'
    ;(async () => {
      if (isCollab) { initialPinDoneRef.current = true; firstLoadedRef.current = true; return }
      // 手机远程 open 后 claude 启动需数秒，首次 history 常落空（会话还没进 ta 列表）——
      // 退避重试直到拿到历史，或确认是真空会话（新项目）：有 messages/total 即停，否则试到上限。
      // 500ms 首屏(2026-08-29 设计定稿):先拉尾部小批(12 条)立刻渲染底部,完整 50 条
      // 随后补齐;空/报错路径两阶段各走一遍(重试只对急拉,避免双等)。
      const FIRST_BATCH = 12
      let didFirstBatch = false
      for (let attempt = 0; attempt < 6 && !cancelled; attempt++) {
        try {
          // 急拉(仅首次):尾部 12 条
          if (!didFirstBatch) {
            const first = await transport.history(session, undefined, FIRST_BATCH)
            if (cancelled) break
            if (first.messages.length > 0) {
              appendHistory(session.sessionId, { messages: first.messages, total: first.total, count: first.count }, false)
              firstLoadedRef.current = true
              didFirstBatch = true
            }
          }
          const page = await transport.history(session, undefined, PAGE)
          if (cancelled) break
          if (page.messages.length > 0 || page.total > 0 || attempt === 5) {
            // 急拉已先灌:完整页替换式补(急拉的 12 条是尾部子集,整体换防错位)
            appendHistory(session.sessionId, { messages: page.messages, total: page.total, count: page.count }, false)
            firstLoadedRef.current = true
            break
          }
        } catch (e) {
          const msg = String(e).replace(/^Error:\s*/, '')
          // 死会话(主机上已被清理/杀掉——含切 harness 销毁 AOP 会话的"AOP 会话不存在"):
          // 友好态而非红错——列表轮询会自然剔除/宿主对账器跳新会话
          // collab 会话(插件化):无 ta 会话——ta 404 是预期(消息来自 App 层轮询),
          // 不当死会话(否则红色误报条)
          if (session.command !== 'collab' && isDeadSessionErr(msg)) { setSessionGone(true); break }
          if (attempt === 5) { setErr(msg); break }
        }
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)))
      }
      if (!cancelled) initialPinDoneRef.current = true // 别锁死上滑加载
    })()
  
  // zcode 桥会话(canvas ZcodeSessionManager):无 SSE 事件推送,轮询 history 刷新
    // (长度变化才重灌,增量静默;phone 端无 zcode 会话,此分支不触发)
    let zcTimer: ReturnType<typeof setInterval> | null = null
    // 2026-09-11 实测反馈「刚进去就看正在生成」：历史消息不该触发生成中。
  // 记录进入聊天时刻——只有进入后新发的 user 消息才算「正在等 AI 回复」。

  // collab 会话（插件化 harness）：消息经 transport HTTP 隧道轮询 env
    // /api/collab/messages（PC aop 工作区 App 层轮询的手机同构——phone 无
    // App 层轮询管线，就地 useEffect+cleanup）。1.2s 全量拉、长度变化才重灌、
    // 乐观尾部保留+stripFrom 去重（同 aop startCollabPoll 口径）。
    let cbTimer: ReturnType<typeof setInterval> | null = null
    if (session.command === 'collab' && session.cwd) {
      let lastLen = -1
      let firstBurstDone = false
      const stripFrom = (t: string) => t.replace(/^\[from:[^\]]*\]\s*/, '')
      const apply = (slice: Array<{ role: string; text?: string; toolUse?: Array<{ name: string; input?: string }>; author?: string; thinking?: string }>) => {
        useBeliefStore.setState((st) => {
          const b = st.beliefs[session.sessionId]
          if (!b) return st
          const mapped = slice.map((m, i) => ({
            role: m.role, text: m.text || '', uuid: `collab-${i}-${m.role}`, timestamp: new Date().toISOString(),
            author: m.author || '', toolUse: m.toolUse || [],
            // 2026-09-12 修⑤：思维链透传（MessageBubble ThinkingBlock 默认折叠）
            thinking: m.thinking || '',
          })) as typeof b.messages
          // 乐观尾部保留：API 权威版尚无该消息（jsonl 落盘滞后）时拼回防闪烁；
          // 权威版带回同文本（剥 [from:X] 前缀比对）即自然去重
          const pending = b.messages.filter((m) => String(m.uuid || '').startsWith('optimistic-')
            && !slice.some((api) => (api.text || '') === m.text || stripFrom(api.text || '') === stripFrom(m.text || '')))
          const final = pending.length ? [...mapped, ...pending] : mapped
          return { beliefs: { ...st.beliefs, [session.sessionId]: { ...b, messages: final, historyTotal: mapped.length } } }
        })
      }
      const tick = async () => {
        try {
          if (!transport.http) return
          const q = `cwd=${encodeURIComponent(session.cwd!)}&taskKey=${encodeURIComponent(session.taskId)}`
          const r = await transport.http('GET', `/api/collab/messages?${q}`)
          if (r.s !== 200) return
          const msgs = (JSON.parse(r.b).messages || []) as Array<{ role: string; text?: string; toolUse?: Array<{ name: string; input?: string }>; author?: string; streaming?: boolean }>
          // 生成中指示(2026-09-11 实测反馈「看不到正在生成」): 尾部 user 无 assistant
          // 回复=AI 生成中 → belief.pending 接 WorkingIndicator(spinner+计时);回复到自动清
          // [from:] 投递(aop_msg 回投)也是 user 角色——AI 回复到达后尾部仍 user,提示曾永不清除
          // 2026-09-11 设计定稿根修：generating 直接用 env 的 streaming 标志
          // (merge_stream_tail 追加 streaming:true——llm_proxy 实时推,跨导航/
          // 多 UI 均准)。替代此前五层补丁(role/30s/firstTask/enteredAt/系统排除)。
          const parsedFull = JSON.parse(r.b) as { streamingActive?: boolean; streamingText?: string }
          const generating = !!parsedFull.streamingActive
          const streamText = parsedFull.streamingText || ''
          useBeliefStore.setState((st) => {
            const b = st.beliefs[session.sessionId]
            if (!b) return st
            const wasWorking = b.pending?.appState === 'working'
            if (wasWorking === generating) {
              // 续算秒数+流式文本(2026-09-11 用户需求「一行简略呈现」：tail 文本
              // 写入 generatingText 驱动 GenText 预览行——用户能瞟到模型在干嘛)
              if (generating && b.pending?.startedAt) {
                const sec = Math.floor((Date.now() - b.pending.startedAt) / 1000)
                const textChanged = b.pending.generatingText !== streamText
                if (sec !== b.pending.workingSec || textChanged) {
                  return { beliefs: { ...st.beliefs, [session.sessionId]: { ...b,
                    pending: { ...b.pending, workingSec: sec, generatingText: streamText } } } }
                }
              }
              return st
            }
            return { beliefs: { ...st.beliefs, [session.sessionId]: { ...b,
              pending: generating ? { appState: 'working' as const, workingSec: 0, startedAt: Date.now(), generatingText: streamText } : null } } }
          })
          if (msgs.length === lastLen) return
          lastLen = msgs.length
          if (!firstBurstDone) {
            firstBurstDone = true
            apply(msgs.slice(-4))
            setTimeout(() => apply(msgs), 50)
          } else {
            apply(msgs)
          }
        } catch { /* 瞬时失败忽略（隧道重建中） */ }
      }
      void tick()
      cbTimer = setInterval(() => void tick(), 1200)
    }
    if (session.command === 'zcode') {
      let lastLen = -1
      zcTimer = setInterval(() => {
        void (async () => {
          try {
            // working 心跳:顺带拉桥会话表取 status(连接正常的证据源)
            // 2026-09-10 修:直连 127.0.0.1:3102 只在 PC 成立——手机 zcode 桥会话
            // (WebRtcTransport.list 并入 /api/zcode/list)同样进 ChatView,此 fetch
            // 在手机上打手机自己必败(catch 静默→working 心跳死+消息不刷)。走隧道。
            const zl = await (transport.http
              ? transport.http('GET', '/api/zcode/list').then((r) => (r.s === 200 ? JSON.parse(r.b) : null)).catch(() => null)
              : fetch('http://127.0.0.1:3102/api/zcode/list').then((r) => r.json()).catch(() => null))
            const st = zl?.data?.find?.((x: { taskId?: string }) => x.taskId === session.taskId)?.status
            // 桥侧保留引擎原词:running=生成中(canvas 不动,前端兼容两词)
            setZcWorking(st === 'working' || st === 'running' ? Date.now() : 0)
            const page = await transport.history(session, undefined, PAGE)
            if (page.messages.length !== lastLen) {
              lastLen = page.messages.length
              // 替换式重灌(非 appendHistory 追加语义):流式中间态会被终态覆盖,
              // 曾用追加+无 timestamp 去重失效→半截/完整两条并存(k3 读图实测)
              useBeliefStore.setState((st) => {
                const b = st.beliefs[session.sessionId]
                if (!b) return st
                return { beliefs: { ...st.beliefs, [session.sessionId]: { ...b, messages: page.messages, historyTotal: page.total } } }
              })
            }
          } catch { /* 瞬时失败忽略 */ }
        })()
      }, 2500)
    }
    return () => { cancelled = true; if (zcTimer) clearInterval(zcTimer); if (cbTimer) clearInterval(cbTimer) }
  }, [session.sessionId, session.taskId]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 首批历史拉完才 true——顶哨兵的自动"加载更早"由它把门（防止空窗期误触发）。 */
  const initialPinDoneRef = useRef(false)

  /** 加载更早：column-reverse 下更老消息追加在视觉顶部，视口内容不受影响——无需滚动补偿。 */
  const loadOlder = useCallback(async () => {
    const b = useBeliefStore.getState().beliefs[session.sessionId]
    if (!b || loadingOlder || !b.historyHasMore) return
    setLoadingOlder(true)
    setErr(null)
    try {
      const page = await transport.history(session, b.historyLoadedFrom, PAGE)
      if (page.messages.length > 0) {
        appendHistory(session.sessionId, { messages: page.messages, total: page.total, count: page.count }, true)
      }
    } catch (e) {
      setErr(friendlyErr(e))
    } finally {
      setLoadingOlder(false)
    }
  }, [transport, session, loadingOlder, appendHistory])

  useEffect(() => {
    const root = scrollRef.current
    const sentinel = topSentinelRef.current
    if (!root || !sentinel) return
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting && firstLoadedRef.current && initialPinDoneRef.current)) loadOlder() },
      { root, rootMargin: '120px 0px 0px 0px' },
    )
    io.observe(sentinel)
    return () => io.disconnect()
  }, [loadOlder])

  // 回到底部。容器是 column-reverse：scrollTop=0 天然就是最新一条，与 content-visibility
  // 估计高无关（高度修正发生在屏外顶部，scroll anchoring 自动补偿）——一次到位，无需补跳。
  // 屏蔽两帧 onScroll，避免把这次程序性滚动误判成"用户上滚"而解除粘住。
  const pinToBottom = useCallback(() => {
    stickRef.current = true
    setShowJumpBottom(false)
    setUnread(0)
    const el = scrollRef.current
    if (!el) return
    suppressScrollRef.current = true
    el.scrollTop = 0
    requestAnimationFrame(() => requestAnimationFrame(() => { suppressScrollRef.current = false }))
  }, [])

  // 未读计数：看历史期间（stick=false）每多一条消息，角标 +1；粘底时不计。
  useLayoutEffect(() => {
    const grew = messages.length - prevLenRef.current
    prevLenRef.current = messages.length
    if (grew > 0 && !stickRef.current) setUnread((n) => n + grew)
  }, [messages.length])

  // ── 历史导航（四键 + 快捷键）：顶部 / 上个气泡 / 下个气泡（无则更底=最新）/ 底部 ──
  // 坐标全部用视口 rect（column-reverse 下 scrollTop 为负，视口比较方向无关、最不易错）。
  const bubbleEls = useCallback((): HTMLElement[] => {
    const el = scrollRef.current
    if (!el) return []
    return Array.from(el.querySelectorAll<HTMLElement>('[data-bubble]'))
  }, [])

  const jumpToTop = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = false
    setShowJumpBottom(true)
    el.scrollTop = -(el.scrollHeight - el.clientHeight) // column-reverse：负到底=视觉最顶
  }, [])

  /** 上个气泡（更早=视觉在上方）：取视口上沿之上最靠近的一个，对齐到显示区域顶部；没有 → 到顶。 */
  const jumpPrevBubble = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = false
    setShowJumpBottom(true)
    const base = el.getBoundingClientRect().top
    const target = bubbleEls()
      .filter((b) => b.getBoundingClientRect().top < base - 4)
      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]
    if (target) el.scrollTop += target.getBoundingClientRect().top - base - 8
    else el.scrollTop = -(el.scrollHeight - el.clientHeight)
  }, [bubbleEls])

  /** 下个气泡（更新=视觉在下方）：取视口上沿之下第一个，对齐到顶部；没有 → 跳底部看最新。 */
  const jumpNextBubble = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const base = el.getBoundingClientRect().top
    const target = bubbleEls()
      .filter((b) => b.getBoundingClientRect().top > base + 12)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]
    if (target) {
      stickRef.current = false
      setShowJumpBottom(true)
      el.scrollTop += target.getBoundingClientRect().top - base - 8
    } else {
      pinToBottom()
    }
  }, [bubbleEls, pinToBottom])

  // 快捷键：Ctrl+↑ 最早 / Shift+↑ 上个气泡 / Shift+↓ 下个气泡 / Ctrl+↓ 最新（输入框内不抢）
  // （裸 ↑/↓ 的路由在下方 capture 单口里——交互态给 claude，非交互态导航）

  // 自动贴底（stick-to-bottom）：粘住时，新消息 / pending / 切展开都重新跳到末尾。
  useLayoutEffect(() => {
    if (!scrollRef.current) return
    if (!stickRef.current) return
    pinToBottom()
  }, [messages.length, pending?.appState, expandTools, expandThinking, pinToBottom])

  // 高度后变补偿：内容撑高时，只要还粘着就保持贴底（column-reverse 下即 scrollTop=0）。
  // 实现：MutationObserver（DOM/文本变化）+ 捕获期 load 监听（图片解码撑高，不进 DOM）——
  // 不用 ResizeObserver（百度等 webview 会把 "ResizeObserver loop" 当错误弹给用户，屡禁不止）。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let scheduled = false
    const jump = () => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        const e = scrollRef.current
        if (!e || !stickRef.current || selectingRef.current) return // 选中期间不贴底(防选中断裂)
        e.scrollTop = 0
      })
    }
    const mo = new MutationObserver(() => { if (stickRef.current) jump() })
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    const onLoad = (ev: Event) => {
      if ((ev.target as HTMLElement)?.tagName === 'IMG' && stickRef.current) jump()
    }
    el.addEventListener('load', onLoad, true)
    return () => { mo.disconnect(); el.removeEventListener('load', onLoad, true) }
  }, [])

  const sendKey = useCallback(async (keyName: string) => {
    try { await transport.key(session, keyName) } catch (e) { setErr(friendlyErr(e)) }
  }, [transport, session])
  // 审批响应（① 审批待办化）：按该会话 harness 的按键语义注入（docs/harness-state-union.md §4）。
  // 文本键不带换行（直选/编辑语义）；Enter 单独发 key（claude/codex 选中后确认）。
  // 卡片消失不做本地乐观清除——由 ta 的 state 事件（细态翻转）驱动，防"点了没生效却消失"。
  const [approvalBusy, setApprovalBusy] = useState(false)
  /** 死会话(主机上已不存在):显示中文提示+返回钮,不再刷红错 */
  const [sessionGone, setSessionGone] = useState(false)
  useEffect(() => { setSessionGone(false) }, [session.sessionId])
  const respondApproval = useCallback(async (approve: boolean) => {
    const harness = resolveHarness(appType, session.command)
    const steps = approvalSteps(harness, approve)
    setApprovalBusy(true)
    setErr(null)
    try {
      for (const st of steps) {
        if (st.text != null) await transport.input(session, st.text)
        else if (st.key) await transport.key(session, st.key)
        // 文本与 Enter 分开时留一拍（claude 输入处理器 stabilize，同 runTest 的教训）
        await new Promise((r) => setTimeout(r, 150))
      }
    } catch (e) {
      setErr(friendlyErr(e))
    } finally {
      setApprovalBusy(false)
    }
  }, [transport, session, appType])
  // 同步版（给 MessageBubble 的 AskUserQuestion 卡片当 onKey；稳定引用不破坏 memo）
  const sendKeySync = useCallback((k: string) => { void sendKey(k) }, [sendKey])
  // 图片附件按文件名拉 dataURL/URL（手机 WebRTC rpc；canvas localhost URL）。稳定引用。
  const fetchAsset = useCallback((name: string) => transport.fetchAsset(name), [transport])
  const interrupt = useCallback(() => { void sendKey('esc') }, [sendKey])

  // 右键复制(2026-08-28 用户需求):聊天正文可选中(user-select:text 见 css);
  // WebView2 默认右键菜单不可用——前端接管:消息区右键=复制选中文本,
  // 无选中=复制整条气泡正文,浮条提示 1.2s。
  const [copyTip, setCopyTip] = useState(0)
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const body = (e.target as HTMLElement | null)?.closest?.('.msg-body')
      if (!body) return // 非消息区(输入框/头部等)走默认行为
      e.preventDefault()
      const sel = (window.getSelection()?.toString() ?? '').trim()
      const text = sel || (body as HTMLElement).innerText.trim()
      if (!text) return
      const done = () => { setCopyTip(Date.now()); window.setTimeout(() => setCopyTip(0), 1200) }
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done))
      } else {
        fallbackCopy(text, done)
      }
    }
    const fallbackCopy = (text: string, done: () => void) => {
      const ta = document.createElement('textarea')
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
      document.body.appendChild(ta); ta.select()
      try { document.execCommand('copy'); done() } catch { /* 复制失败静默 */ }
      ta.remove()
    }
    window.addEventListener('contextmenu', onCtx)
    return () => window.removeEventListener('contextmenu', onCtx)
  }, [])

  // 按键路由（capture 单口）：
  //  - Ctrl+↑/↓ → 最早/最新；Shift+↑/↓ → 上/下个气泡（输入框内不抢）
  //  - 裸 ↑/↓：claude 交互态（菜单/选择界面）或终端视图或输入框中 → 透传 claude；
  //    非交互态（AI 静置/执行中/干完）→ 聊天历史导航（上个/下个气泡）——少按一个修饰键
  //  - 裸 ←/→/Esc/Tab/Enter：维持原透传语义；带修饰键的方向键不再漏给 claude
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 配置弹窗打开时 Esc 只关弹窗，不透传终端
      if (showConfigPicker && e.key === 'Escape') { setShowConfigPicker(false); e.stopPropagation(); return }
      const t = e.target as HTMLElement | null
      const inText = !!t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)
      // ① 导航快捷键（修饰键组合）：不传给 claude
      if (!inText && e.key === 'ArrowUp' && e.ctrlKey) { e.preventDefault(); jumpToTop(); return }
      if (!inText && e.key === 'ArrowDown' && e.ctrlKey) { e.preventDefault(); pinToBottom(); return }
      if (!inText && e.key === 'ArrowUp' && e.shiftKey) { e.preventDefault(); jumpPrevBubble(); return }
      if (!inText && e.key === 'ArrowDown' && e.shiftKey) { e.preventDefault(); jumpNextBubble(); return }
      // ② 裸方向键：带修饰键的不漏给 claude（①已消费的除外）
      if (e.ctrlKey || e.shiftKey || e.altKey) return
      const alwaysMap: Record<string, string> = {
        ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
        Escape: 'esc',
      }
      const ak = alwaysMap[e.key]
      if (ak) {
        // 输入框聚焦时，方向键留给输入框光标编辑：不透传 claude、不 preventDefault。
        // 此监听在 capture 阶段（addEventListener 第3参 true），若 inText 也走透传分支，
        // preventDefault 会吃掉 textarea 的光标移动 → 左右键光标不动、全发给 claude，
        // 在 claude TUI 的菜单/补全态误触发操作（实测：按左右键 → claude 自动跑 cd / skill）。
        // Escape 不在此列：输入框里 Esc 仍透传 claude（取消当前操作）。
        if (inText && e.key.startsWith('Arrow')) return
        // 交互态/终端视图 → 原样透传 claude（菜单导航等）
        if (interactive || viewMode === 'terminal') {
          e.preventDefault(); void sendKey(ak); return
        }
        // 非交互态：↑/↓ = 聊天历史导航；←/→ 仍透传 claude
        e.preventDefault()
        if (e.key === 'ArrowUp') jumpPrevBubble()
        else if (e.key === 'ArrowDown') jumpNextBubble()
        else void sendKey(ak)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        if (document.activeElement === textareaRef.current) {
          textareaRef.current?.blur()   // 已在输入区 → 退出焦点（↑↓ 导航键恢复可用）
        } else {
          void sendKey('tab')
          textareaRef.current?.focus()  // 不在 → 透传 claude + 进入输入区
        }
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const hasText = text.trim().length > 0 || pendingImgs.length > 0
        if (!inText || !hasText) { e.preventDefault(); void sendKey('enter') }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [sendKey, text, pendingImgs, interactive, viewMode, jumpToTop, jumpPrevBubble, jumpNextBubble, pinToBottom, showConfigPicker])

  const send = async () => {
    const t = text.trim()
    if (!t && pendingImgs.length === 0) return
    setSending(true)
    setErr(null)
    const imgs = pendingImgs
    try {
      // 多图重做(2026-09-01 用户):粘贴/多选/纯图皆可。暂存上传(不逐张注入)
      // → 组合 "@p1 @p2 [正文]" 一行,一次提交——多图+文本=单条消息,纯图亦可发。
      let attachments: Array<{ kind: string; mime: string; ref: string }> | undefined
      let line = t
      if (imgs.length > 0) {
        const staged = transport as unknown as { imageStage?: (s: SessionInfo, b64: string) => Promise<string | null> }
        const paths: string[] = []
        for (const img of imgs) {
          const p = staged.imageStage ? await staged.imageStage(session, img.b64) : null
          if (p) paths.push(p)
        }
        if (paths.length > 0) {
          line = [paths.map((p) => `@${p}`).join(' '), t].filter(Boolean).join(' ')
          attachments = imgs.map((im) => {
            const mime = /^data:([^;]+)/.exec(im.dataURL)?.[1] ?? (im.kind === 'file' ? 'application/octet-stream' : 'image/png')
            return { kind: im.kind === 'file' ? 'file' : 'image', mime, ref: im.dataURL, name: im.name }
          })
        }
      }
      if (imgs.length > 0) updateImgs([])
      if (line) {
        // text + 独立 Enter 键:ta 的 write_text 把尾部 \n 转 \r 后 120ms 分段写入,
        // kimi TUI 会吞掉这个延迟 \r(输入留在输入框不提交)——独立 key=enter
        // 直接写 \r 立即提交,claude/codex 同样兼容。
        // 且 kimi TUI 需要 text 与 Enter 之间 ≥1s 间隔(实测 <100ms 连发 \r 被吞、
        // 2s 间隔正常)——统一 1s,claude 提交晚 1s 无副作用(echo/gen_start 不依赖 Enter)。
        // author=ownAuthor(有灵账号名):多人房间署名——跨端/跨项目看这条消息都知道是谁说的。
        if (session.command === 'collab') {
          // collab 会话（插件化 harness）：输入直通 aop_myco 队列——零注入；
          // jsonl 落盘后轮询带回权威版。
          // 2026-09-10 修：直连 http://127.0.0.1:3102 只在 PC(aop 工作区)成立——
          // 手机上那是手机自己，必须走 transport HTTP 隧道到 PC。
          // author=ownAuthor：多人房间署名（远程工作区/第二身份发言可归属——
          // take 折 [from:X]，模型可见发送者，解析侧剥还原显示）
          // 2026-09-10 L40 根修：transport.http?.() 在 transport.http 不存在时
          // 静默失败（断网/直连 transport 无 http 面）——用户发了消息不知道没
          // 发出。修=transport.http 不存在时回退直接 fetch（aop 工作区的
          // EnvTransport 无 http 面，直打 env :3002）；失败时显式抛错。
          const body = JSON.stringify({ cwd: session.cwd || '', taskKey: session.taskId, text: line, author: ownAuthor || '' })
          if (transport.http) {
            await transport.http('POST', '/api/collab/human', body)
          } else {
            // EnvTransport（aop 工作区）无 http 面——直打 env :3002
            const r = await fetch('http://127.0.0.1:3102/api/collab/human', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
            })
            if (!r.ok) throw new Error(`发送失败（HTTP ${r.status}）`)
          }
          // 乐观气泡（2026-09-10 L25 抓出：发送成功只清输入框，自己的消息要等
          // 1.2s 轮询带回——空窗期用户不知消息是否发出。发送即写本地消息，轮询
          // 带回权威版后由 startCollabPoll 的乐观保留逻辑去重/兑现）
          try {
            const { useChatBeliefStore } = await import('../belief-store')
            useChatBeliefStore.setState((st) => {
              const b = st.beliefs[session.sessionId]
              if (!b) return st
              const optimistic = { role: 'user', text: line, uuid: `optimistic-${Date.now()}`, timestamp: new Date().toISOString(), author: ownAuthor || '' }
              return { beliefs: { ...st.beliefs, [session.sessionId]: { ...b, messages: [...b.messages, optimistic] } } }
            })
          } catch { /* store 不可达时静默（轮询兜底） */ }
        } else {
          await transport.input(session, line.endsWith('\n') ? line.slice(0, -1) : line, ownAuthor, attachments)
        }
        updateText('')  // 立即清输入框(不等 Enter 延迟,防"发送后输入框还留着文本")
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
        // AOP 会话消息即发即达(无终端 Enter)
        if (!isAopSession) {
          await new Promise((r) => setTimeout(r, 1000))
          try { await transport.key(session, 'enter') } catch { /* transport 无 key 时回退 */ }
        }
      }
    } catch (e) {
      // 死会话(如切 harness 销毁 AOP 会话后再发消息)→ 友好下线态,不刷红错
      const msg = String(e).replace(/^Error:\s*/, '')
      // collab 会话无 ta 会话——ta 404 是预期，不当死会话
      if (session.command !== 'collab' && isDeadSessionErr(msg)) { setSessionGone(true); updateText(t); return }
      setErr(friendlyErr(e))
    } finally {
      setSending(false)
    }
  }

  /** 粘贴图片(2026-09-01 用户):剪贴板里的图片全部进暂存条,可再粘贴多张,随下一条消息一并发出。 */
  const onPasteImgs = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    // 全文件形态(2026-09-05):图片(压缩+缩略预览)+非图文件(PDF/txt 等,文件名
    // chip 预览)都可粘贴——发送时统一落盘 @path 注入(claude 的 @ 引用支持
    // 任意文件读取)。
    const files = items.filter((it) => it.kind === 'file')
    if (files.length === 0) return
    e.preventDefault()
    for (const it of files) {
      const f = it.getAsFile()
      if (!f) continue
      void stageImageFile(f)
    }
  }

  const onPickImage = () => fileRef.current?.click()

  // ── @补全：句首/空白后 @ 触发，列可选模型 + 当前聊天观看者（除自己），可现场打名字 ──
  const [atOpen, setAtOpen] = useState(false)
  const [atFilter, setAtFilter] = useState('')
  const [atSel, setAtSel] = useState(0)
  const [watchersList, setWatchersList] = useState<string[]>([])
  const modelsRef = useRef<ModelOption[] | null>(null)
  const projectsRef = useRef<ProjectInfo[] | null>(null)
  const sessionsRef = useRef<SessionInfo[] | null>(null)
  /** 当前 @ 片段（caret 前的 "@xxx" 部分），插入时按它替换 */
  const atSpanRef = useRef<{ start: number; end: number } | null>(null)

  // pending 气泡的模型名：优先取最新 user 消息的 @模型（本轮切换目标，与 PC apply_at_model 同语义）；
  // 否则取最近 assistant 的 model。放 modelsRef 后（需 provider 列表匹配 @名）。
  const pendingModel = (() => {
    const ms = useBeliefStore.getState().beliefs[session.sessionId]?.messages ?? []
    const lastUser = [...ms].reverse().find((m) => m.role === 'user')
    const at = lastUser?.text?.trimStart().match(/^@([^\s[]+)/)
    if (at) {
      const bare = at[1].toLowerCase()
      const hit = (modelsRef.current ?? []).find((p) =>
        p.name?.toLowerCase() === bare || p.id?.toLowerCase() === bare ||
        (p.model && p.model.split('[')[0].trim().toLowerCase() === bare))
      if (hit?.model) return hit.model.replace(/\[.*?\]/g, '')
    }
    const lastAi = [...ms].reverse().find((m) => m.role === 'assistant' && m.model)
    if (lastAi?.model) return lastAi.model.replace(/\[.*?\]/g, '')
    // zcode 桥消息无 model 字段——兜底 glm-5.3(曾显示 claude,k3 读图实测实测问题)
    return session.command === 'zcode' ? 'glm-5.3' : 'claude'
  })()
  // pending 气泡的模型色：与 MessageBubble 同款兜底（modelColor 优先，否则 defaultModelColor）。
  const pendingAccent = modelColor || defaultModelColor(pendingModel)

  // 模型清单：进 session 拉一次（projection models；不支持@的 transport 为空）
  useEffect(() => {
    modelsRef.current = null
    if (transport.models) void transport.models().then((m) => { modelsRef.current = m }).catch(() => {})
    projectsRef.current = null
    if (transport.projects) void transport.projects().then((p) => { projectsRef.current = p }).catch(() => {})
    // 会话清单（@列表只列"启动中"项目用；周期拉，项目启停跟着变）
    const loadSessions = () => { if (transport.list) void transport.list().then((s) => { sessionsRef.current = s }).catch(() => {}) }
    loadSessions()
    const st = setInterval(loadSessions, 4000)
    return () => clearInterval(st)
  }, [transport, session.sessionId])
  // 观看者：@面板开着时每 3s 刷一次（谁进谁走跟着变）
  useEffect(() => {
    if (!atOpen || !transport.watchers) return
    const load = () => void transport.watchers!(session).then(setWatchersList).catch(() => {})
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [atOpen, transport, session])

  /** @补全候选：模型（🤖，命中切本轮模型）+ 项目（🗂，跨项目对话，只列启动中的）+ 观看者（👤 有灵账号名，除自己）。 */
  const atItems = (() => {
    const f = atFilter.toLowerCase()
    const models = (modelsRef.current ?? [])
      .filter((m) => !f || m.id.toLowerCase().includes(f) || m.name.toLowerCase().includes(f) || (m.model ?? '').toLowerCase().includes(f))
      .map((m) => ({ kind: 'model' as const, label: m.name, detail: m.model ?? m.id, color: m.color }))
    // 只列启动中的项目（sessions 里有 proj-{id} 活会话）。手打 @未启动项目仍可（relay 会自动启动它）。
    const liveIds = new Set((sessionsRef.current ?? [])
      .map((s) => s.taskId?.match(/^proj-(.+)$/)?.[1])
      .filter((x): x is string => !!x))
    const projs = (projectsRef.current ?? [])
      .filter((p) => liveIds.has(p.id))
      .filter((p) => !f || p.name.toLowerCase().includes(f))
      .map((p) => ({ kind: 'project' as const, label: p.name, detail: '项目 · 带它的上下文对话（可加 .模型名 指定本轮模型）', color: undefined }))
    const youlings = watchersList
      .filter((n) => n && n !== ownAuthor && (!f || n.toLowerCase().includes(f)))
      .map((n) => ({ kind: 'youling' as const, label: n, detail: '在看这个聊天', color: undefined }))
    return [...models, ...projs, ...youlings]
  })()

  /** 检测 caret 前是否处于 "@片段" 中（@在句首或空白后，@到 caret 间无空白）。 */
  const detectAt = (el: HTMLTextAreaElement) => {
    const caret = el.selectionStart ?? el.value.length
    const upto = el.value.slice(0, caret)
    const m = /(?:^|\s)@([^\s@]*)$/.exec(upto)
    if (!m) { atSpanRef.current = null; setAtOpen(false); return }
    atSpanRef.current = { start: caret - m[1].length - 1, end: caret }
    setAtFilter(m[1])
    setAtSel(0)
    setAtOpen(true)
  }

  const pickAt = (label: string) => {
    const el = textareaRef.current
    const span = atSpanRef.current
    if (!el || !span) { setAtOpen(false); return }
    const v = el.value
    const nv = v.slice(0, span.start) + '@' + label + ' ' + v.slice(span.end)
    updateText(nv)
    setAtOpen(false)
    const pos = span.start + label.length + 2
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(pos, pos) })
  }

  /** 图片文件 → 压缩 → 暂存条(选择/粘贴共用;可多张,随下一条消息一并发出)。 */
  const stageImageFile = async (f: File) => {
    try {
      const isImg = f.type.startsWith('image/')
      if (!isImg) {
        // 非图文件:5MB 限,原样 dataURL(mime 保真),kind=file 文件名 chip。
        if (f.size > 5_000_000) { setErr(`「${f.name}」过大（>5MB），跳过`); return }
        const dataURL = await new Promise<string>((res, rej) => {
          const r = new FileReader()
          r.onload = () => res(r.result as string)
          r.onerror = () => rej(r.error || new Error('读取失败'))
          r.readAsDataURL(f)
        })
        updateImgs((prev) => [...prev, { b64: dataURL, dataURL, kind: 'file', name: f.name }])
        return
      }
      const blob = f.size > 2_000_000 ? await compressImage(f) : f
      if (blob.size > 5_000_000) { setErr(`「${f.name}」压缩后仍过大（>5MB），跳过`); return }
      const dataURL = await new Promise<string>((res, rej) => {
        const r = new FileReader()
        r.onload = () => res(r.result as string)
        r.onerror = () => rej(r.error || new Error('读取失败'))
        r.readAsDataURL(blob)
      })
      updateImgs((prev) => [...prev, { b64: dataURL, dataURL, kind: 'image', name: f.name }])
    } catch (e2) { setErr(String(e2).replace(/^Error:\s*/, '')) }
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])]
    e.target.value = ''
    for (const f of files) void stageImageFile(f)
  }

  // 主题：useChatTheme（localStorage 持久，两端共享同一套 chat-themes）。
  const [theme, setThemeId] = useChatTheme()
  const themeVars = {
    '--mc-accent': theme.accent,
    '--mc-accent-2': theme.accent2,
    '--mc-glow-1': theme.glow1,
    '--mc-glow-2': theme.glow2,
  } as CSSProperties

  // canvas 执行页：头部内容上移到 App header 中部（createPortal），本地不再占一行；phone 不传 → 本地渲染。
  // 「展开」控制不进头部——挪到右下导航键组顶部（header 中部不挤，键组本就浮在画布上）。
  const expandCtl = (
        <div className="expand-menu-wrap" ref={expandMenuRef} onMouseEnter={() => { if (menuHideTimer.current) { clearTimeout(menuHideTimer.current); menuHideTimer.current = null } }} onMouseLeave={() => { menuHideTimer.current = setTimeout(() => setShowExpandMenu(false), 400) }}>
          <button
            className="expand-toggle"
            onClick={() => setShowExpandMenu((v) => !v)}
            title="选择自动展开的内容（点开勾选；未勾选的 hover 悬浮可看）"
          >
            <ListCollapse size={15} />
          </button>
          {showExpandMenu && (
            <div className="expand-menu">
              <div className="expand-menu-row" onClick={() => timedToggle(setExpandTools)}>
                <input type="checkbox" checked={expandTools} readOnly />
                  工具调用
                </div>
                <div className="expand-menu-row" onClick={() => timedToggle(setExpandThinking)}>
                  <input type="checkbox" checked={expandThinking} readOnly />
                  思维链
                </div>
              </div>
          )}
        </div>
  )

  // 单行头部（设计定稿 2026-08-26）：返回+项目/任务名 | 主题配色居中 | 右侧模型/harness 选择+状态+视图。
  const headLeft = (
    <>
        {onBack && (
          <button className="chat-back" onClick={onBack} title="返回" aria-label="返回">
            <ArrowLeft size={16} />
          </button>
        )}
        <span className="chat-head-title">{session.title || session.taskId}</span>
        {/* 2026-10-18 M11：任务态徽标与连接路径（直连/云端中转）都属于运行过程——
            只在「轨迹」视图呈现；对话视图不露任何投递/中继过程文字。 */}
        {showTrace && session.status === 'running' && (
          <span title="任务运行中" style={{ fontSize: 10, color: '#22C55E', flexShrink: 0 }}>● 运行中</span>
        )}
        {showTrace && connKind && (
          <span className={`conn-badge conn-${connKind}`} title={connKind === 'relay' ? '经云端临时中转（加密后中转，服务器看不到内容）' : connKind === 'direct' ? '端到端直连（数据不过任何服务器）' : '连接中…'}>
            {connKind === 'relay' ? '云端中转' : connKind === 'direct' ? '直连' : '…'}
          </span>
        )}
    </>
  )
  /** 右侧配置区：细态徽章 + 模型/harness 选择（点击徽章弹 popover）+ 视图切换等。 */
  const headConfig = (
    <>
        {/* 连续工作/空闲计时(2026-09-01 设计定稿:放原"空闲"徽章位、模型名左侧;
            不占输入区)。工作中→工作 Xm(绿呼吸);停下→空闲 Xm(灰,>30s 工作块已重置)。
            2026-10-18 M11：计时属于运行过程，只在「轨迹」视图出现。 */}
        {showTrace && (wr.working ? (
          <span className="fs-badge fs-badge-working fs-pulse" title={`连续工作 ${fmtDur2(wr.workMs)}(空闲超30s自动重计)`}>
            工作 {fmtDur2(wr.workMs)}
          </span>
        ) : wr.lastEnd !== null ? (
          <span className="fs-badge fs-badge-idle" title={`空闲 ${fmtDur2(wr.restMs)}(上次连续工作 ${fmtDur2(wr.workMs)})`}>
            空闲 {fmtDur2(wr.restMs)}
          </span>
        ) : null)}
        {/* 细态徽章：2026-10-18 M11 起分两档——
            · 对话视图：只保留"需要人处理"的异常/等待态（批准/出错/需登录/已中断/等待输入）；
              生成中/执行工具/启动/压缩等过程态一律不显（它们不是问题，是过程）。
            · 轨迹视图：沿用原规则（过程态与聊天区重复不显；idle 已有计时 chip 时防双显）。 */}
        {(() => {
          const attention = fineState === 'awaiting_approval' || fineState === 'error_blocked'
            || fineState === 'auth_required' || fineState === 'interrupted'
            || (fineState == null && appState === 'waiting_input')
          if (!showTrace) return attention ? <FineStateBadge fineState={fineState} appState={appState} /> : null
          return fineState !== 'generating' && fineState !== 'tool_running'
            && !(fineState === 'idle_ready' && (wr.working || wr.lastEnd !== null))
            && !(fineState == null && appState === 'working') ? (
            <FineStateBadge fineState={fineState} appState={appState} />
          ) : null
        })()}
        {modelLabel && (
          <div ref={configPickerRef} className="chat-head-config-wrap" style={{ position: 'relative' }}>
            <span
              className={`chat-head-meta${canConfig ? ' chat-head-meta-click' : ''}`}
              onClick={canConfig ? () => {
                setShowConfigPicker(v => !v)
                // 计算 popover 定位（fixed 定位需要精确坐标）；左侧钳制不出屏
                // （2026-09-08 用户实测：模型下拉框曾超出屏幕右侧）
                const rect = configPickerRef.current?.getBoundingClientRect()
                if (rect) setPopoverPos({
                  top: rect.bottom + 4,
                  left: Math.max(8, Math.min(rect.left, window.innerWidth - 260)),
                })
              } : undefined}
            >
              {modelLabel}{harnessLabel ? ` · ${harnessLabel}` : ''}
            </span>
            {showConfigPicker && canConfig && popoverPos && createPortal(
              <div ref={configPopoverRef} className="chat-config-popover" style={{ position: 'fixed', top: popoverPos.top, left: popoverPos.left }}>
                {harnessLabel && (
                  <div>
                    <div className="chat-config-label">智能体（启动任务时选择，运行中不可改）</div>
                    <div className="chat-config-static">{harnessLabel}</div>
                  </div>
                )}
                {onSetModel && modelOptions && (
                  <div>
                    <div className="chat-config-label">模型</div>
                    <select
                      value={currentModelId ?? ''}
                      onChange={(e) => { onSetModel(e.target.value || null) }}
                      className="chat-config-select"
                    >
                      <option value="">{modelLabel ?? '默认'}</option>
                      {modelOptions.filter(o => o.label !== modelLabel).map(o => (
                        <option key={o.id} value={o.id}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                )}
                {onSetHarness && harnessOptions && (
                  <div>
                    <div className="chat-config-label">代理</div>
                    <select
                      value={currentHarnessId ?? ''}
                      onChange={(e) => { onSetHarness(e.target.value || null) }}
                      className="chat-config-select"
                    >
                      <option value="">Claude Code</option>
                      {harnessOptions.filter(h => h.id !== 'claude-code').map(h => (
                        <option key={h.id} value={h.id} disabled={!h.installed}>
                          {h.label}{!h.installed ? '(未装)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {onSetHarness && <p className="chat-config-hint">切换代理需重开终端生效</p>}
              </div>,
              document.body
            )}
          </div>
        )}
    </>
  )
  const headCenter = (
    <>
        <div className="theme-dots" title="单击切色 · 长按自定义色 · 双击外观设置">
          {quickThemes().map((t) => (
            <button
              key={t.id}
              className={`theme-dot ${t.id === theme.id ? 'active' : ''}`}
              style={{ background: t.dot }}
              onClick={() => setThemeId(t.id)}
              onDoubleClick={() => { if (onOpenTheme) onOpenTheme(); else setShowColorPicker(true) }}
              onPointerDown={() => { longPressTimer.current = setTimeout(() => setShowColorPicker(true), 500) }}
              onPointerUp={() => { if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null } }}
              onPointerLeave={() => { if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null } }}
              title={t.name}
            />
          ))}
        </div>
        {showColorPicker && (
          <div className="color-picker-popover" onMouseLeave={() => setShowColorPicker(false)}>
            <input
              type="color"
              value={theme.id.startsWith('custom:') ? theme.id.slice(7) : theme.accent}
              onChange={(e) => setThemeId('custom:' + e.target.value)}
            />
            <span style={{ fontSize: 11, color: 'var(--mc-text-2)' }}>自定义</span>
          </div>
        )}    </>
  )
  const headRight = (
    <>
        {headConfig}
        {onOpenUsage && (
          <button
            className="vt-btn"
            onClick={onOpenUsage}
            title="总 token 用量(今日/项目/模型/近7天)"
          >
            📊
          </button>
        )}
        {onToggleRecord && (
          <button
            className={`vt-btn rec-btn${recording ? ' is-rec' : ''}`}
            onClick={async () => { const ok = await onToggleRecord(!recording); if (ok !== false) { /* 父组件状态翻转 */ } }}
            title={recording ? '录制中·点击停止(数据集: .aop/sensors/<sid>.jsonl,Ctrl+3 放视图可回放/调试/对拍)' : '启动数据集录制(实时捕获传感器流,回放视图查看/调试/改进)'}
          >
            <span className="rec-dot" style={{
              display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
              background: recording ? '#ff4444' : '#888',
              boxShadow: recording ? '0 0 6px #ff4444' : 'none',
              animation: recording ? 'rec-pulse 1.2s infinite' : 'none',
            }} />
            <style>{`@keyframes rec-pulse { 0%,100%{opacity:1} 50%{opacity:.3} }`}</style>
          </button>
        )}
        {!hideViewToggle && (
        <div className="view-toggle" title="切换 聊天 / 终端 视图">
          <button className={viewMode === 'chat' ? 'vt-btn is-active' : 'vt-btn'} onClick={() => setViewMode('chat')} title="聊天">💬</button>
          {!isAopSession && (
            <button className={viewMode === 'terminal' ? 'vt-btn is-active' : 'vt-btn'} onClick={() => setViewMode('terminal')} title="终端">
              <svg viewBox="0 0 16 16" width="14" height="14" style={{ display: 'block' }}>
                <rect x="1" y="2" width="14" height="12" rx="1.5" fill="#1e1e1e" stroke="#888" strokeWidth="0.7" />
                <rect x="1" y="2" width="14" height="3" rx="1.5" fill="#3a3a3a" stroke="none" />
                <text x="4" y="11" fontSize="6.5" fill="#7CFC90" fontFamily="monospace" fontWeight="bold">&gt;_</text>
              </svg>
            </button>
          )}
          {!isAopSession && transport.kind === 'webrtc' && (
            <button className={viewMode === 'desktop' ? 'vt-btn is-active' : 'vt-btn'} onClick={() => setViewMode('desktop')} title="远程桌面">
              <svg viewBox="0 0 24 24" width="15" height="15" style={{ display: 'block' }} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
            </button>
          )}
        </div>
        )}


        {pending?.appState === 'working' && !replayReadOnly && (
            <button className="stop-btn" onClick={interrupt} title="停止生成" aria-label="停止生成">
              <span className="stop-square" />
            </button>
          )}
    </>
  )

  return (
    <div className="myco-chat-view" style={themeVars}>
      {isPerfOn() && <PerfHud />}
      {/* 右键复制提示浮条(1.2s 消失) */}
      {copyTip > 0 && (
        <div style={{
          position: 'fixed', right: 18, bottom: 96,
          background: 'var(--mc-surface-2,#1c2333)', color: 'var(--mc-text,#e6edf3)',
          border: '1px solid var(--mc-border,#2d333b)', borderRadius: 10,
          padding: '5px 14px', fontSize: 12, zIndex: 90, pointerEvents: 'none',
          boxShadow: '0 4px 16px rgba(0,0,0,.3)',
        }}>已复制</div>
      )}
      {headerSlot ? (
        createPortal(
          <div className="myco-chat-view chat-portal-root" style={themeVars}>
            <div className="chat-head chat-head-portal">
              <div className="chat-head-side">{headLeft}</div>
              <div className="chat-head-mid">{headCenter}</div>
              <div className="chat-head-side is-right">{headRight}</div>
            </div>
          </div>,
          headerSlot,
        )
      ) : (
        <div className="chat-head">{headLeft}{headCenter}{headRight}</div>
      )}

      {sessionGone && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', fontSize: 12, background: 'var(--err-soft,#ffe9e7)', color: 'var(--error,#ff5a52)' }}>
          <span style={{ flex: 1 }}>该会话已在主机上结束(可能被清理)——返回列表刷新即可消失</span>
          <button onClick={onBack} style={{ padding: '3px 10px', fontSize: 12, border: 'none', borderRadius: 6, background: 'var(--error,#ff5a52)', color: '#fff' }}>返回</button>
        </div>
      )}
      {err && <div style={{ padding: '8px 14px', fontSize: 12, color: 'var(--error,#ff5a52)', background: 'var(--err-soft,#ffe9e7)' }}>{err}</div>}

      {/* ② error_blocked 显形：turn 失败等人工——红色提示条（不强制禁发，视觉明确） */}
      {fineState === 'error_blocked' && (
        <div className="error-blocked-bar">会话出错，需要人工处理（可切终端视图查看现场）</div>
      )}

      {/* 2026-10-18 M11：交互提示行（"claude 在选择界面 · ↑↓选择…"）属于运行过程提示，
          只在「轨迹」视图呈现；对话视图里 PickerView/审批卡本身仍在（动作面不藏）。 */}
      {showTrace && interactive && (
        <div className="interactive-hint">
          {hasSelection
            ? <>🎯 claude 在选择界面 · <kbd>↑↓</kbd>选择 <kbd>Enter</kbd>确认 <kbd>Esc</kbd>取消 <kbd>Tab</kbd></>
            : <>📋 claude 功能界面 · <kbd>Esc</kbd>返回</>}
        </div>
      )}

      {viewMode === 'terminal' ? (
        <TerminalView transport={transport} session={session} onKey={sendKeySync} />
      ) : viewMode === 'desktop' ? (
        <DesktopView transport={transport} />
      ) : (
      <div className="chat-canvas-wrap">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {/* column-reverse：DOM 第一个孩子 = 视觉最底。顺序 = 视觉自底向上：审批卡 → pending → picker → 消息(新→旧) → 空态 → 顶哨兵
            （todos 已移出滚动列钉在消息区下方——新消息曾把它顶出视口,plus 屏刮源丢态,双重"不见"） */}

        {/* ① 审批待办化：awaiting_approval 时消息流尾部的「需要批准」卡片 */}
        {fineState === 'awaiting_approval' && (
          <ApprovalCard
            summary={approval}
            busy={approvalBusy}
            onApprove={() => void respondApproval(true)}
            onReject={() => void respondApproval(false)}
          />
        )}

        {/* zcode 桥执行中(轮询心跳驱动,与 ta 会话同款 WorkingIndicator;
            曾误插 chat-head 头部,k3+DOM 双实测定位后挪正)
            2026-10-18 M11：对话视图只留呼吸三点（极简状态），过程指示归轨迹视图。 */}
        {session.command === 'zcode' && zcWorking > 0 && (
          <div className="msg msg-assistant msg-pending">
            <div className="msg-body">
              {showTrace ? <WorkingIndicator elapsedSec={zcElapsed} extra="连接正常" /> : <TypingDots />}
            </div>
          </div>
        )}

        {pending?.appState === 'working' && (
          <div className="msg msg-assistant msg-pending">
            {showTrace && (
              <div className="msg-role">
                <span className="msg-model" style={{ background: pendingAccent || undefined }}>🤖 {pendingModel}</span>
              </div>
            )}
            <div className="msg-body">
              {/* 2026-10-18 M11：对话视图不呈现生成过程（工具行动/结果行/思考行/状态胶囊），
                  只给一个"正在回复"的呼吸三点；过程全量在「轨迹」视图。 */}
              {showTrace ? (
                <>
                  {/* 内容在上、spinner 状态行在下（对齐 claude 终端顺序，原本反了） */}
                  {pending.generatingText ? (
                    <GenText text={pending.generatingText} mode={fineState === 'tool_running' ? 'executing' : fineState === 'generating' ? 'thinking' : undefined} />
                  ) : null}
                  {/* 执行中指示(K3 圆环计时;动词+token 用量=状态胶囊条,spinner 行提炼) */}
                  <WorkingIndicator elapsedSec={pending.workingSec} action={hintAction} tokens={tokensUsed} agents={agents} />
                </>
              ) : <TypingDots />}
            </div>
          </div>
        )}

        {picker && !askUserActive && (
          <PickerView picker={picker} onKey={(k) => void sendKey(k)} />
        )}

        {messages.map((m, i) => ({ m, i })).reverse().map(({ m, i }, ri, arr) => (
          <MessageBubble
            key={bubbleKey(m, i)}
            m={m}
            modelColor={modelColor}
            expandTools={expandTools}
            expandThinking={expandThinking}
            onKey={askUserActive && i === askUserMsgIdx ? sendKeySync : undefined}
            fetchAsset={fetchAsset}
            ownAuthor={ownAuthor}
            currentHarness={effectiveHarness}
            prevM={ri + 1 < arr.length ? arr[ri + 1].m : null}
            noAnim={!m.timestamp || Date.parse(m.timestamp) < mountTsRef.current}
            showProcess={showTrace}
          />
        ))}

        {messages.length === 0 && !err && (
          <div className="chat-empty">还没有历史对话</div>
        )}

        <div ref={topSentinelRef} className="chat-sentinel">
          {loadingOlder && <span className="spinner" />}{' '}
          {/* 2026-09-13 单帧审查④：新会话/短会话（不足一屏）没有"历史"可言，
              顶哨兵提示是噪音——消息铺不满可视区时隐藏 */}
          {historyHasMore ? '上滑加载更早…' : messages.length > 8 ? '—— 没有更早了 ——' : ''}
        </div>
      </div>

      {/* 导航键组（浮层不占布局，聊天区左右等宽；默认低透明）：展开置顶 + 顶部/上个/下个/底部
          + 极轻的「过程」入口（2026-10-18 M11：对话↔轨迹 切换，默认不展开） */}
      <div className="jump-nav">
        {showTrace && expandCtl}
        <button className="jump-nav-btn" onClick={jumpToTop} title="跳到最早（Ctrl+↑）">
          <ArrowUpToLine size={15} />
        </button>
        <button className="jump-nav-btn" onClick={jumpPrevBubble} title="上个气泡，对齐到顶部（Shift+↑）">
          <ChevronUp size={15} />
        </button>
        <button className="jump-nav-btn" onClick={jumpNextBubble} title="下个气泡，对齐到顶部；没有则到最新（Shift+↓）">
          <ChevronDown size={15} />
        </button>
        <button className="jump-nav-btn" onClick={pinToBottom} title="滚动到最新（Ctrl+↓）">
          <ArrowDownToLine size={15} />
          {unread > 0 && (
            <span className="jump-bottom-badge">{unread > 99 ? '99+' : unread}</span>
          )}
        </button>
        {/* 「过程」入口：极轻小钮（默认不展开）——点了切到轨迹视图，工具调用/思考/
            运行状态全显；再点回对话。对话视图=只看人对人内容 + AI 最终回答正文。 */}
        <button className="jump-nav-btn" onClick={() => setShowTrace((v) => !v)}
          aria-pressed={showTrace}
          title={showTrace ? '回到对话（只看人对人的内容）' : '查看过程（工具调用/思考/运行状态）'}
          style={{ fontSize: 9, fontWeight: 700, lineHeight: 1, color: showTrace ? 'var(--mc-accent, #6b7bff)' : 'var(--mc-text-2, #6b7280)' }}>
          {showTrace ? '对话' : '过程'}
        </button>
      </div>
      </div>
      )}

      {/* 计划常驻条(2026-09-02)：TodoPanel 钉在消息区与输入框之间,不随消息滚走;
          源=ta jsonl 事件序重放(TodoWrite/TaskCreate/TaskUpdate,跨轮稳定),屏尾镜像仅兜底。
          2026-10-18 M11：计划/状态属于过程内容，只在「轨迹」视图呈现。 */}
      {showTrace && todosView && <TodoPanel todos={todosView} />}

      {replayFooter !== undefined ? (
        <div className="chat-input" style={{ position: 'relative', display: 'flex', padding: 0, minHeight: 0 }}>
          {/* canvas(19.2 types)编 phone(独立 19.0)源码时 ReactNode 双实例含 bigint;S2 收编 workspace 后去掉此 as any */}
          {replayFooter as any}
        </div>
      ) : (
      <div className="chat-input" style={{ position: 'relative' }}>
        {/* 连续工作/空闲计时已挪到头部(原"空闲"徽章位,模型名左侧)——底部不再占输入区
            (2026-09-01 用户二次定稿) */}
        {/* @补全面板：模型（🤖 本轮切换）+ 在看这个聊天的人（👤）。提示行钉底——列表多时只滚列表区，提示永不被滚出视野。 */}
        {atOpen && atItems.length > 0 && (
          <div className="at-panel" style={{
            position: 'absolute', bottom: '100%', left: 0, right: 0, marginBottom: 6,
            background: 'var(--mc-surface, #fff)', border: '1px solid var(--mc-border, #e2e5ee)',
            borderRadius: 12, boxShadow: '0 8px 28px rgba(20,28,60,.16)', overflow: 'hidden',
            maxHeight: 240, display: 'flex', flexDirection: 'column', zIndex: 30,
          }}>
            <div style={{ overflowY: 'auto' }}>
              {atItems.map((it, i) => (
                <button key={`${it.kind}-${it.label}`}
                  onMouseDown={(e) => { e.preventDefault(); pickAt(it.label) }}
                  onMouseEnter={() => setAtSel(i)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 12px',
                    background: i === atSel ? 'color-mix(in srgb, var(--mc-accent,#6b7bff) 12%, transparent)' : 'transparent',
                    border: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 13,
                  }}>
                  <span>{it.kind === 'project' ? '🗂' : it.kind === 'model' ? '🤖' : '👤'}</span>
                  <span style={{ fontWeight: 600, color: it.color ?? 'var(--mc-text, #1c2333)' }}>{it.label}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--mc-muted, #8a92a8)' }}>{it.detail}</span>
                </button>
              ))}
            </div>
            <div style={{ padding: '5px 12px', fontSize: 10, color: 'var(--mc-muted,#8a92a8)', borderTop: '1px solid var(--mc-border,#eef0f6)', flexShrink: 0 }}>
              @项目=跨项目对话 · @模型=只这一轮用它跑 · @名字=直呼在看的人
            </div>
          </div>
        )}
        {/* 第94轮：accept 放开（任意文件）——stageImageFile 本就分 image/file 两链
            （图片压缩缩略 / 非图 5MB 文件名 chip + @path 注入），此前被 accept 挡住选不了 */}
        <input type="file" multiple ref={fileRef} onChange={onFile} style={{ display: 'none' }} />
        <button className="chat-icon-btn" onClick={onPickImage} title="选文件/图片（可多选；图片大图自动压缩，其他文件 @path 引用）">
          <ImagePlus size={18} />
        </button>
        <textarea
          rows={1}
          ref={textareaRef}
          value={text}
          onPaste={onPasteImgs}
          onChange={(e) => {
            updateText(e.target.value)
            const el = e.target
            el.style.height = 'auto'
            el.style.height = Math.min(el.scrollHeight, 120) + 'px'
            detectAt(el)
          }}
          onKeyDown={(e) => {
            // @面板开着：↑↓ 选、Enter/Tab 确认、Esc 关（都不进发送/透传）
            if (atOpen && atItems.length > 0) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setAtSel((s) => (s + 1) % atItems.length); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setAtSel((s) => (s - 1 + atItems.length) % atItems.length); return }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickAt(atItems[Math.min(atSel, atItems.length - 1)].label); return }
              if (e.key === 'Escape') { e.preventDefault(); setAtOpen(false); return }
            } else if (atOpen && e.key === 'Escape') { setAtOpen(false); return }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
          }}
          placeholder={isAopSession
            ? '发指令给 AOP…（/plan 拆解 · /execute 执行 · /status 状态 · /stop 中断）'
            : `发指令给 ${harnessLabel || (resolveHarness(appType, session.command) === 'kimi' ? 'Kimi' : resolveHarness(appType, session.command) === 'codex' ? 'Codex' : 'Claude')}…（Enter 发送，Shift+Enter 换行）`}
        />
        <button className="chat-send" onClick={send} disabled={sending || (!text.trim() && pendingImgs.length === 0)} title="发送">
          <SendHorizontal size={17} />
        </button>
      </div>
      )}

      {replayFooter === undefined && pendingImgs.length > 0 && (
        <div className="pending-img" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {pendingImgs.map((img, i) => (
            <div key={i} style={{ position: 'relative' }}>
              {img.kind === 'file'
                ? <div style={{ fontSize: 11, padding: '4px 8px', border: '1px solid var(--border,#333)', borderRadius: 6, color: 'var(--text,#eee)' }}>📎 {img.name || '文件'}</div>
                : <img src={img.dataURL} alt={`待发图片${i + 1}`} />}
              <button className="pending-img-x" onClick={() => updateImgs((prev) => prev.filter((_, j) => j !== i))} title="移除"><X size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
