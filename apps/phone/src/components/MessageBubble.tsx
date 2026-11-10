/**
 * MessageBubble — 聊天气泡富渲染（phone/canvas 共用）。
 *
 * 渲染一条 ChatMessage：markdown 正文（assistant 语法高亮）+ 模型角标 +
 * 富媒体附件（图片内嵌）+ 工具调用链 + 思维链。
 * 不依赖任何 store/transport，纯渲染 props.message——双端各自的数据层都能喂。
 *
 * expandTools / expandThinking（ChatView 展开 checkbox popover 控制，两个独立 boolean）：
 *  - expandTools=true：工具调用内部参数（代码块语法高亮）直接全显；false：一行 chip，hover tooltip 看参数
 *  - expandThinking=true：思维链正文直接展开；false：只露标题，hover tooltip 看内容
 * 折叠态下单个 chip / 思维链仍可点开（局部展开）。
 *
 * 两个展开开关是**原始值**（非对象），React.memo 浅比较即生效——切一个不会让另一个的气泡重渲。
 *
 * ta 地址（图片 src）：默认 http://127.0.0.1:8100（canvas/phone http 模式同源或
 * 局域网直连）；iroh 远端时图片经 projection 另说（暂用 ta 直链，PC 端可用）。
 */
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
// 2026-10-07 hljs 按需注册（原主入口全量 191 语言≈2MB 未压缩——单 chunk >1MB 触发
// esbuild 临时文件本机坑，且拖手机首屏）。聊天代码块场景够用的常用语言集：
import hljs from 'highlight.js/lib/core'
import hljsJson from 'highlight.js/lib/languages/json'
import hljsJs from 'highlight.js/lib/languages/javascript'
import hljsTs from 'highlight.js/lib/languages/typescript'
import hljsPy from 'highlight.js/lib/languages/python'
import hljsBash from 'highlight.js/lib/languages/bash'
import hljsShell from 'highlight.js/lib/languages/shell'
import hljsSql from 'highlight.js/lib/languages/sql'
import hljsRust from 'highlight.js/lib/languages/rust'
import hljsGo from 'highlight.js/lib/languages/go'
import hljsJava from 'highlight.js/lib/languages/java'
import hljsC from 'highlight.js/lib/languages/c'
import hljsCpp from 'highlight.js/lib/languages/cpp'
import hljsCsharp from 'highlight.js/lib/languages/csharp'
import hljsCss from 'highlight.js/lib/languages/css'
import hljsXml from 'highlight.js/lib/languages/xml'
import hljsMd from 'highlight.js/lib/languages/markdown'
import hljsYaml from 'highlight.js/lib/languages/yaml'
import hljsDiff from 'highlight.js/lib/languages/diff'
import hljsIni from 'highlight.js/lib/languages/ini'
import hljsToml from 'highlight.js/lib/languages/ini'
for (const [n, l] of Object.entries({
  json: hljsJson, javascript: hljsJs, typescript: hljsTs, python: hljsPy,
  bash: hljsBash, shell: hljsShell, sql: hljsSql, rust: hljsRust, go: hljsGo,
  java: hljsJava, c: hljsC, cpp: hljsCpp, csharp: hljsCsharp, css: hljsCss,
  xml: hljsXml, markdown: hljsMd, yaml: hljsYaml, diff: hljsDiff, ini: hljsIni, toml: hljsToml,
})) hljs.registerLanguage(n, l)
import 'highlight.js/styles/github-dark.css'
import type { ChatMessage, ToolCall, Attachment } from '../transport'
import { AgentCard } from './AgentCard'
import { thinkingPreview } from './genTextFilter'

/** hljs 高亮结果的全局缓存（按 code 字符串）。重复展开同一参数零成本；滚动来回切不再重算。
 *  - 超过 HLJS_MAX 字符的大 dump（文件读取/长输出）直接返回 null → 纯文本渲染，跳过高亮
 *    （那种 dump 不需要语法色，且 highlightAuto 在大文本上是主要卡顿源）。 */
const HLJS_MAX = 6000
const HLJS_CAP = 300
const HLJS_CACHE = new Map<string, string | null>()
function highlightCode(code: string, lang?: string): string | null {
  if (code.length > HLJS_MAX) return null
  const key = lang ? `${lang}\u0000${code}` : code
  const cached = HLJS_CACHE.get(key)
  if (cached !== undefined) return cached
  if (HLJS_CACHE.size >= HLJS_CAP) HLJS_CACHE.delete(HLJS_CACHE.keys().next().value!)
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0
  // 指定语言且 hljs 认识 → 精确高亮;否则 auto(工具卡 JSON dump 场景)
  const v = lang && hljs.getLanguage(lang)
    ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    : hljs.highlightAuto(code).value
  // 性能埋点（PerfHud/perf-bench 读）：累计 hljs 调用次数与耗时，定位卡顿根因。
  if (typeof window !== 'undefined') {
    const w = (window as any).__hljs = (window as any).__hljs || { calls: 0, ms: 0, misses: 0 }
    w.calls += 1
    w.ms += (typeof performance !== 'undefined' ? performance.now() : 0) - t0
    w.misses += 1
  }
  HLJS_CACHE.set(key, v)
  return v
}
/** 只读缓存、不现算（滚动中命中即直接彩色、零脚本）。 */
function peekHighlight(code: string, lang?: string): string | null | undefined {
  return HLJS_CACHE.get(lang ? `${lang}\u0000${code}` : code)
}
// bench only：清缓存 + 重置计数器（perf-measure 测冷高亮用；生产不调）。
if (typeof window !== 'undefined') {
  ;(window as any).__clearHljsCache = () => { HLJS_CACHE.clear() }
}

/** 默认展开配置：自动展开工具调用（全参数），思维链不展开（hover tooltip 可看）。 */
export const DEFAULT_EXPAND_TOOLS = false
export const DEFAULT_EXPAND_THINKING = false

/** 气泡时间分级（2026-09-01 设计定稿）：今天→时分；昨天→"昨天 时分"；
 *  本年→月日 时分；跨年→年月日 时分。无时间戳→空串（不显示）。 */
export function fmtBubbleTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === now.toDateString()) return hm
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`
  if (d.getFullYear() === now.getFullYear()) return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}`
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}`
}

const AVATAR: React.CSSProperties = {
  width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: '#fff', fontSize: 13, fontWeight: 700, userSelect: 'none',
}

/** 批四：头像散列取色（列表/聊天/群管理三处统一——首字母圆+名字散列稳定取色，
 *  同一个人处处同色）。色板取柔和高区分度 8 色。 */
export const AVATAR_PALETTE = ['#6b7bff', '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#f97316']
export function avatarColorOf(name: string): string {
  const s = (name || '?').replace(/的 AI$/, '').trim()
  let h = 0
  for (const ch of s) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]
}

/** 批四：作者显示名解析（纯函数，单测覆盖）——空串 author（toBubbleMsg 旧形态
 *  self=author:''）被 `??` 跳过不了（空串非 nullish），曾渲染成空"👤"胶囊挂在
 *  每条自己消息上。统一走 || 语义：空串/缺省 → ownAuthor → '我'。 */
export function resolveAuthorName(m: Pick<ChatMessage, 'role' | 'author'>, ownAuthor?: string): string {
  if (m.role !== 'user') return ''
  return (m.author || '').trim() || (ownAuthor || '').trim() || '我'
}

/** 批五：「自己发的」判定（纯函数，单测覆盖）——气泡靠右/靠左的数据源。
 *  user 且（无 author=本机直发，或 author===自己的账号名）→ 自己。
 *  2026-09-29 手机端「自己气泡不靠右」排查沉淀：数据侧判定与 CSS 对齐分离，
 *  本函数钉死数据侧语义（CSS 侧是 .msg.msg-user:not(.other) 推右）。 */
export function isSelfMsg(m: Pick<ChatMessage, 'role' | 'author'>, ownAuthor?: string): boolean {
  if (m.role !== 'user') return false
  const a = (m.author || '').trim()
  return !a || (!!ownAuthor && a === ownAuthor.trim())
}

/** 群聊署名聚合判定(纯函数,单测覆盖):同一发言人(用户按 author、AI 按
 * harness/model)+ 间隔 <5min → 连续发言只首条带头像/署名/时间。 */
export function isGroupedWith(prev: ChatMessage | null | undefined, cur: ChatMessage): boolean {
  if (!prev) return false
  const key = (m: ChatMessage) => m.role === 'user'
    ? `u:${m.author ?? ''}`
    : `a:${m.harness ?? m.model ?? ''}`
  if (key(prev) !== key(cur)) return false
  if (!prev.timestamp || !cur.timestamp) return false
  const dt = Date.parse(cur.timestamp) - Date.parse(prev.timestamp)
  return Number.isFinite(dt) && dt >= 0 && dt < 5 * 60_000
}

/** 机制收尾句剥除(设计定稿 2026-08-29):正文以机制括号结尾(转达/自动带回/
 *  转达方式/@项目名)剥掉;中间内容不动。导出供单测。 */
export function stripUserTail(text: string): string {
  return text.replace(/\s*[（(][^（）()]*?(转达|自动带回|转达方式|@项目名)[^（）()]*?[）)]\s*$/, '')
}


/** URL 链接化（用户消息纯文本路径——markdown 只走 assistant，用户消息也要可点）。
 *  检测 http(s):// 和 www. 开头的 URL，转 <a>。2026-09-10 旅程测试抓到。 */
function linkify(text: string): ReactNode {
  const urlRe = /(https?:\/\/[^\s]+|www\.[^\s]+)/g
  const parts = text.split(urlRe)
  return parts.map((part, i) => {
    if (/^(https?:\/\/|www\.)/.test(part)) {
      const href = part.startsWith('www.') ? 'https://' + part : part
      return <a key={i} href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>{part}</a>
    }
    return part
  })
}

function MessageBubbleImpl({ m, modelColor, expandTools = DEFAULT_EXPAND_TOOLS, expandThinking = DEFAULT_EXPAND_THINKING, onKey, fetchAsset, ownAuthor, noAnim, currentHarness, prevM, showProcess = true }: { m: ChatMessage; modelColor?: string; expandTools?: boolean; expandThinking?: boolean; onKey?: (k: string) => void; /** 图片附件按文件名拉 dataURL（手机走 WebRTC rpc；canvas 返回 localhost URL）。 */ fetchAsset?: (name: string) => Promise<string>; /** 自己的 账号名（user 消息无 author=本机直接输入时的兜底显示名）。 */ ownAuthor?: string; /** 历史气泡（挂载前已存在）不播进入动画——容器级 animation 开关切换会全体重播 mc-rise（顶部闪烁根因），逐气泡永久 no-anim 才稳。 */ noAnim?: boolean; /** header 当前选中的 harness id（气泡 harness 不同时追加显示）。 */ currentHarness?: string; /** 上一条消息(连续同人聚合:群聊惯例连续发言只署名一次)。 */ prevM?: ChatMessage | null; /** 2026-10-18 聊天微信化（M11）：false=「对话」视图——不渲染工具调用/工具结果/思维链等过程内容（默认 true，历史面板等既有调用行为不变；ChatView 按对话/轨迹视图传入）。 */ showProcess?: boolean }) {
  // 长消息折叠(群聊惯例,K3 验收"披着气泡的日报"):超长正文默认收起
  // (~340px 高),点击展开全文——报告体内容不再刷屏。
  const [expanded, setExpanded] = useState(false)
  // 折叠阈值=1.5 屏(设计定稿 2026-08-29:更宽松,420 字太激进):正文按视口高
  // 的 1.5 倍收起;字符阈值同步放宽(短汇报不再误伤)。
  const [vh] = useState(() => typeof window === 'undefined' ? 800 : window.innerHeight)
  const collapseMax = Math.round(vh * 1.5)
  const collapsible = m.text.length > 1200
  /** 2026-10-18 M11：对话视图只呈现"人的消息 + AI 最终回答正文"。
   *  - 带工具调用的 assistant 轮次=过程（工具 chip/结果都挂在这轮）——整轮不渲染，
   *    其正文也多是"我先看看文件"这类过场话（先不做语义判别，避免把真答案当过程藏掉）；
   *  - 无正文/无附件/无交互卡的轮次=空气泡，不渲染；
   *  - 交互式 AskUserQuestion 卡例外保留（那是需要用户作答的动作面，藏了就没法回答）。 */
  const askCards = (m.toolUse ?? []).filter((t) => /AskUserQuestion/i.test(t.name))
  const hasBody = !!m.text.trim() || !!(m.attachments && m.attachments.length > 0)
  const processOnly = m.role === 'assistant'
    && askCards.length === 0
    && ((m.toolUse ?? []).length > 0 || !hasBody)
  if (!showProcess && processOnly) return null
  // 左色带 + 模型名底色：provider 配的模型色（modelColor）优先，否则模型默认色，否则跟主题（CSS 变量）
  const accent = modelColor || defaultModelColor(m.model)
  // 全局展开对所有气泡挂载即生效（不再按视野 inView gating）。原先"进视口才展开"在
  // 去虚拟化后会导致：滚到某气泡 → inView 锁存 → 突然展开 → 高度跳变 → 画面窜。
  // 现在高度从首帧稳定，滚动不再跳；hljs 有全局缓存，挂载/切换代价可接受。
  const toolsOpen = expandTools
  const thinkOpen = expandThinking
  // user 气泡作者：resolveAuthorName（空串 author 回落 ownAuthor/'我'——批四修
  // 空"👤"胶囊：toBubbleMsg 旧形态 self=author:''，`??` 跳不过空串，逐条挂空署名）。
  // 别人（别人的 Youling/别的项目的 AI）≠自己名 → 琥珀色 chip + other 样式(左侧中性卡)——
  // 多人房间语义:右侧蓝底只属于「我」,他人(远程辅助者/跨项目 AI)一眼可辨。
  const authorName = resolveAuthorName(m, ownAuthor)
  const isSelf = isSelfMsg(m, ownAuthor)
  const timeText = fmtBubbleTime(m.timestamp)
  // 群聊署名聚合:连续同一发言人只在首条显示头像/署名/时间——群聊惯例,
  // 逐条重复署名是日志腔(判定抽 isGroupedWith 纯函数,单测覆盖)。
  const grouped = isGroupedWith(prevM, m)
  // 他人消息正文与署名去重:coworker 转发正文带「名字: 」前缀(AI 上下文需要),
  // 气泡已有署名——渲染层剥掉,用户看到的是干净的纯正文。
  let bodyText = m.role === 'user' && m.author && m.text.startsWith(`${m.author}: `)
    ? m.text.slice(m.author.length + 2)
    : m.text
  // 图片消息的注入正文是绝对路径(@C:\...\xxx.png)——撑爆气泡宽度且无信息量,
  // 有附件时压缩成「@…\文件名」(K3 验收:路径全量显示偏长)。
  if (m.attachments && m.attachments.length > 0) {
    const t = bodyText.trim()
    const slash = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'))
    const colon = t.indexOf(':')
    if (colon === 1 && slash > colon) {
      bodyText = `${t.startsWith('@') ? '@' : ''}…${t.slice(slash)}`
    }
  }
  // 机制收尾句剥掉(K3 review 必改:用户两次点名"说教的话"不该在气泡里)——
  // 用户消息正文以「(机制指令后缀)」结尾(我们注入的「(转达方式/等它回复…)」
  // 尾部)剥掉;中间内容不动。
  if (m.role === 'user') {
    bodyText = stripUserTail(bodyText)
  }
  // 本项目 AI 直接用模型短名署名(设计定稿 2026-08-29:自己的不用「X 的 AI」,
  // 只有别家(跨项目 user.author)才需要「X 的 AI」区分)
  const aiLabel = m.model ? shortModel(m.model) : 'claude'
  const avatarName = m.role === 'user' ? authorName : aiLabel
  // 批四：自己的消息也带头像（微信语义——自己右侧圆形头像；此前只他人/AI 有）。
  // 头像色：用户=名字散列稳定取色（avatarColorOf，列表/聊天/群管理三处同色）；
  // AI=模型主题色（accent 语义保留）。
  const avatarBg = m.role === 'user'
    ? avatarColorOf(avatarName)
    : (accent ?? 'var(--mc-accent,#6b7bff)')
  const authorChip = (
    <span className="msg-model" title={isSelf ? '我发的' : m.role === 'user' ? `${authorName} 发的` : (m.model ?? undefined)}
      style={isSelf
        ? { background: 'linear-gradient(135deg,#94a3b8,#64748b)' }
        : m.role === 'user'
          ? { background: 'linear-gradient(135deg,#d97706,#b45309)' }
          : { background: accent }}>
      {m.role === 'user' ? `👤 ${authorName}` : `🤖 ${aiLabel}`}
    </span>
  )
  return (
    <div className={`msg msg-${m.role === 'user' ? (isSelf ? 'user' : 'user other') : 'assistant'}${noAnim ? ' no-anim' : ''}${grouped ? ' grouped' : ''}`} data-bubble
      style={!grouped ? (isSelf ? { paddingRight: 38, position: 'relative' } : { paddingLeft: 38, position: 'relative' }) : undefined}>
      {!grouped && (
        <div style={{
          ...AVATAR,
          background: avatarBg,
          position: 'absolute', top: 0,
          ...(isSelf ? { right: 0 } : { left: 0 }),
        }}>
          {avatarName.replace(/的 AI$/, '').trim().slice(0, 1) || '?'}
        </div>
      )}
      {m.role !== 'user' && !grouped && (
        <div className="msg-role">
          {authorChip}
          {m.harness && currentHarness && m.harness !== currentHarness && (
            <span className="msg-harness" title={`此消息由 ${m.harness} 产出`}>{shortHarness(m.harness)}</span>
          )}
          {timeText && <span className="msg-time">{timeText}</span>}
        </div>
      )}
      {m.role === 'user' && !grouped && (
        <div className="msg-role" style={{ justifyContent: isSelf ? 'flex-end' : 'flex-start' }}>
          {!isSelf && authorChip}
          {timeText && <span className="msg-time">{timeText}</span>}
          {isSelf && authorChip}
        </div>
      )}
      <div className="msg-body" style={m.role !== 'user' && accent ? { borderLeftColor: accent } : undefined}>
        <div style={collapsible && !expanded ? { maxHeight: collapseMax, overflow: 'hidden', position: 'relative' } : undefined}>
          {m.role === 'assistant'
            // P8:空文本+有工具调用的轮次(模型直接调工具没说话)不渲染空正文块,
            // 只显工具卡——不出空气泡
            ? (m.text.trim() || !m.toolUse?.length) && <MarkdownBody text={m.text} />
            : <div className="msg-plain" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{linkify(bodyText)}</div>}
          {collapsible && !expanded && (
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 56, background: 'linear-gradient(transparent, var(--mc-surface, #fff))', pointerEvents: 'none' }} />
          )}
        </div>
        {collapsible && (
          <button onClick={() => setExpanded((v) => !v)} style={{
            marginTop: 6, fontSize: 12, color: 'var(--mc-accent, #6b7bff)', background: 'none',
            border: 'none', padding: 0, cursor: 'pointer', fontWeight: 600,
          }}>{expanded ? '收起' : `展开全文(${m.text.length}字)`}</button>
        )}
        {m.attachments && m.attachments.length > 0 && (
          <div className="msg-attachments">
            {m.attachments.map((a, i) => <AttachmentView key={i} a={a} fetchAsset={fetchAsset} />)}
          </div>
        )}
        {/* 2026-10-18 M11：工具调用/工具结果 chip 与思维链属于「过程」——只在轨迹
            视图渲染；对话视图仅保留 AskUserQuestion 交互卡（否则用户无法作答）。 */}
        {m.toolUse && m.toolUse.length > 0 && (
          showProcess
            ? <ToolUseChips tools={m.toolUse} expandAll={toolsOpen} onKey={onKey} />
            : askCards.length > 0 && <ToolUseChips tools={askCards} expandAll onKey={onKey} />
        )}
        {showProcess && m.thinking && <ThinkingBlock thinking={m.thinking} expandAll={thinkOpen} />}
      </div>
    </div>
  )
}

/** React.memo：props（m/modelColor/expandTools/expandThinking 全是原始值）不变就不重渲。
 *  关键是 m 引用稳定（chatBeliefStore 只在变化时换新对象），滚动/兄弟重渲不再连带重算。 */
export const MessageBubble = memo(MessageBubbleImpl)

/** markdown 正文：useMemo 缓存解析结果，只在 text 变时重跑（rehype-highlight 不便宜）。 */
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'

const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeHighlight, { detect: true }], [rehypeKatex, { throwOnError: false, errorColor: '#ef4444' }]]}>
      {text}
    </ReactMarkdown>
  )
})

/** 模型名 → 默认配色（未在 provider 里单独配色时用；跟主题色之外的区分色）。 */
export function defaultModelColor(model?: string): string | undefined {
  if (!model) return undefined
  const m = model.toLowerCase()
  if (m.includes('glm')) return '#8b5cf6'   // 紫
  if (m.includes('kimi') || m.includes('k3')) return '#3b82f6' // 蓝
  return undefined // 其他 → 跟主题（CSS 变量）
}

/** 批四：图片破图判定（纯函数，单测覆盖）——媒体已被清（ref='' 无途径可取）
 *  或拉取失败 → true。渲染层据此降级"图片已被清理"占位卡，不再永远转 🖼。 */
export function imageBroken(a: Pick<Attachment, 'kind' | 'ref' | 'previewDataUrl'>, src: string, loadFailed: boolean): boolean {
  if (a.kind !== 'image') return false
  if (src) return false
  if (loadFailed) return true
  return !a.ref && !a.previewDataUrl
}

/** 富媒体附件：图片内嵌（echo 用本地 dataURL，服务端用 ta /api/assets），点击放大。 */
function AttachmentView({ a, fetchAsset }: { a: Attachment; fetchAsset?: (name: string) => Promise<string> }) {
  const [zoom, setZoom] = useState(false)
  // 图片 src：优先本地 previewDataUrl（echo 即时回显）；否则按文件名经 fetchAsset 拉
  // （手机 WebRTC rpc 取 dataURL；canvas 返回 localhost URL）。
  // ref 三形态(2026-09-05)：dataURL(历史 jsonl 的 image block，解析器直出)直接当 src；previewDataUrl(发送即时回显)；文件名经 fetchAsset 拉。
  const [src, setSrc] = useState<string>(a.previewDataUrl || (a.ref.startsWith('data:') ? a.ref : ''))
  const [loadFailed, setLoadFailed] = useState(false)
  useEffect(() => {
    if (src || a.kind !== 'image') return
    if (a.ref.startsWith('data:')) { setSrc(a.ref); return }
    const name = a.ref.replace(/\\/g, '/').split('/').pop() || ''
    if (!name || !fetchAsset) { if (!name) setLoadFailed(true); return }
    let alive = true
    fetchAsset(name)
      .then((u) => { if (alive) { if (u) setSrc(u); else setLoadFailed(true) } })
      .catch(() => { if (alive) setLoadFailed(true) })
    return () => { alive = false }
  }, [a.ref, a.kind, src, fetchAsset])
  if (a.kind !== 'image') {
    return <div className="attach-file">📎 {a.name || a.ref}</div>
  }
  // 批四：破图兜底——FileCard 式降级卡（媒体已被清理/拉取失败），不放 <img src=''>
  if (imageBroken(a, src, loadFailed)) {
    return (
      <div className="attach-broken" title="媒体已被清理（FIFO 淘汰或源端删除）——请对方重发">
        🖼 图片已被清理
        <span className="attach-broken-sub">{a.name ? `${a.name} · ` : ''}请对方重发</span>
      </div>
    )
  }
  if (!src) return <div className="attach-img attach-loading">🖼</div>
  return (
    <>
      <img className="attach-img attach-zoomable" src={src} alt={a.name || '图片'} loading="lazy" onClick={() => setZoom(true)} />
      {zoom && createPortal(
        <div className="img-lightbox" onClick={() => setZoom(false)}>
          <img src={src} alt={a.name || '图片'} />
        </div>,
        document.body
      )}
    </>
  )
}

/** 工具调用链：expandAll=全展开内部参数；否则一行 chips，单点/hover tooltip 看参数。
 *  特判 AskUserQuestion：它 input 是 questions JSON，走 AskUserCard 可读渲染，不当代码块 dump。 */
function ToolUseChips({ tools, expandAll, onKey }: { tools: ToolCall[]; expandAll: boolean; onKey?: (k: string) => void }) {
  return (
    <div className="tool-chips">
      {tools.map((t, i) =>
        /AskUserQuestion/i.test(t.name)
          ? <AskUserCard key={i} input={t.input} onKey={onKey} />
          : /^(Task|Agent)$/i.test(t.name)
            ? <AgentCard key={i} t={t} />
            : <ToolChip key={i} t={t} expandAll={expandAll} />
      )}
    </div>
  )
}

/** AskUserQuestion 工具的可读 + 可交互卡片：解析 questions JSON → header/问题/选项列表。
 *  - 有 onKey（聊天区）：选项变可交互——本地跟踪选中(❯)，↑↓ 移动并发键，⏎ 确认、Esc 取消。
 *    本地 sel 与 claude 同步：初始都在第 1 项，每次 ↑/↓ 同步发键，故始终保持一致。
 *  - 无 onKey（只读上下文）：纯展示。
 *  多问题场景仅第 1 题高亮（单选最常见；多问题/Submit tab 的键序较脆，留二期）。 */
function AskUserCard({ input, onKey }: { input?: string; onKey?: (k: string) => void }) {
  let qs: Array<{ header?: string; question?: string; multiSelect?: boolean; options?: Array<{ label?: string; description?: string }> }> = []
  if (input) {
    try {
      const parsed = JSON.parse(input)
      qs = Array.isArray(parsed?.questions) ? parsed.questions : []
    } catch { /* 解析失败 → 兜底返回 null */ }
  }
  const n0 = qs[0]?.options?.length ?? 0
  const [sel, setSel] = useState(0)
  // 物理方向键也同步本地高亮（ChatView 已把 ↑/↓ 透传给 claude，这里只镜像选中，
  // 不重复发键——否则点按钮+键盘会双发）。
  useEffect(() => {
    if (!onKey) return
    const onArrows = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1))
      else if (e.key === 'ArrowDown') setSel((s) => Math.min(Math.max(0, n0 - 1), s + 1))
    }
    window.addEventListener('keydown', onArrows)
    return () => window.removeEventListener('keydown', onArrows)
  }, [onKey, n0])
  if (qs.length === 0) return null
  const move = (d: number) => {
    setSel((s) => Math.max(0, Math.min(n0 - 1, s + d)))
    onKey?.(d < 0 ? 'up' : 'down')
  }
  return (
    <div className="ask-card">
      <div className="ask-card-head">❓ claude 在等你选择</div>
      {qs.map((q, qi) => (
        <div key={qi} className="ask-q">
          {q.header && (
            <span className="ask-q-header">{q.header}{q.multiSelect ? ' · 可多选' : ''}</span>
          )}
          {q.question && <div className="ask-q-text">{q.question}</div>}
          <ul className="ask-opts">
            {(q.options ?? []).map((o, oi) => {
              const active = qi === 0 && oi === sel
              return (
                <li key={oi} className={active ? 'ask-opt is-active' : ''}>
                  <span className="ask-opt-mark">{active ? '❯' : ''}</span>
                  <span className="ask-opt-content">
                    <span className="ask-opt-label">{o.label}</span>
                    {o.description && <span className="ask-opt-desc"> — {o.description}</span>}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
      {onKey ? (
        <div className="ask-keys">
          <button className="ask-key" onClick={() => move(-1)}>↑</button>
          <button className="ask-key" onClick={() => move(1)}>↓</button>
          <button className="ask-key ask-key-enter" onClick={() => onKey('enter')}>⏎ 确认</button>
          <button className="ask-key ask-key-esc" onClick={() => onKey('esc')}>Esc</button>
        </div>
      ) : (
        <div className="ask-hint">用下方选择面板（↑↓⏎ Tab/Esc）作答</div>
      )}
    </div>
  )
}

/** 工具名 → 圆点颜色（对齐 claude 终端：Bash=绿、Read=蓝、Write=红…）。 */
export function toolColor(name: string): string {
  const n = name.toLowerCase()
  if (n === 'bash' || n.endsWith('sh') || n.includes('exec') || n.includes('command')) return '#22c55e' // green
  if (n === 'write' || n === 'create' || n.includes('delete') || n.includes('remove')) return '#ef4444' // red
  if (n === 'edit' || n === 'update' || n === 'replace') return '#f97316'  // orange
  if (n === 'read' || n === 'view' || n.includes('file')) return '#3b82f6'  // blue
  if (n === 'grep' || n === 'glob' || n.includes('search') || n.includes('find')) return '#06b6d4' // cyan
  if (n === 'task' || n.includes('agent')) return '#a855f7'                 // purple
  if (n.includes('web') || n.includes('fetch') || n.includes('url')) return '#38bdf8' // sky
  if (n.includes('todo') || n === 'taskcreate' || n === 'taskupdate') return '#eab308' // yellow
  if (n.includes('mcp') || n.includes('__')) return '#14b8a6'               // teal (mcp tools)
  return '#22c55e' // 默认绿（claude 最常见）
}

/** 工具名 → 图标（比彩色圆点更直观；未识别返回 ''，调用方回退彩色 ●）。
 *  Bash/exec=⚡、Write/删=✏️、Edit=✂️、Read/文件=📄、Grep/搜索=🔍、Task/Agent=🤖、Web=🌐、Todo=📋、MCP=🔌。 */
export function toolIcon(name: string): string {
  const n = name.toLowerCase()
  if (n === 'bash' || n.endsWith('sh') || n.includes('exec') || n.includes('command')) return '⚡'
  if (n === 'write' || n === 'create' || n.includes('delete') || n.includes('remove')) return '✏️'
  if (n === 'edit' || n === 'update' || n === 'replace') return '✎'
  if (n === 'read' || n === 'view' || n.includes('file')) return '📄'
  if (n === 'grep' || n === 'glob' || n.includes('search') || n.includes('find')) return '🔍'
  if (n === 'task' || n.includes('agent')) return '👥' // 派子代理（区别于模型角标 🤖）
  if (n.includes('web') || n.includes('fetch') || n.includes('url')) return '🌐'
  if (n.includes('todo') || n === 'taskcreate' || n === 'taskupdate') return '📋'
  if (n.includes('mcp') || n.includes('__')) return '🔌'
  return ''
}

/** 单个工具调用：折叠态一行 chip（⚡ name + 摘要，hover 显原生 title 预览，点击展开看全参数）；
 *  展开态显示完整参数（代码块语法高亮，换行，无横向滚动）。
 *  无自定义浮窗——hover 预览用浏览器原生 title（简洁可靠），想交互就点展开。 */
/** 工具参数 → 语义代码块(2026-09-01 用户:Edit/Write 里的代码没换行没高亮)。
 *  t.input 是压缩单行 JSON(换行被转义、auto 高亮认不出)——按工具拆字段:
 *  Edit=旧/新双块(diff 色),Write=内容块,Bash=命令块,其余=pretty JSON。
 *  语言按 file_path 扩展名映射;解析失败回退原文。 */
interface ToolCodeBlock { kind: 'code' | 'plain'; text: string; lang?: string; tone?: 'old' | 'new'; label?: string }
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  rs: 'rust', py: 'python', json: 'json', md: 'markdown', css: 'css', html: 'xml', xml: 'xml',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', sh: 'bash', ps1: 'powershell', bat: 'bat',
}
function langOf(filePath?: string): string | undefined {
  const ext = filePath?.split('.').pop()?.toLowerCase()
  return ext ? EXT_LANG[ext] : undefined
}
function toolBlocks(t: ToolCall): ToolCodeBlock[] {
  // params 优先(ta 结构化参数,Edit 带旧/新);旧数据/其余工具回退 input 主字段文本
  let p: Record<string, unknown> | null = null
  const src = t.params || (/^[{[]/.test((t.input || '').trim()) ? t.input : null)
  try { p = src ? (JSON.parse(src) as Record<string, unknown>) : null } catch { p = null }
  const get = (k: string): string => (typeof p?.[k] === 'string' ? (p![k] as string) : '')
  const n = t.name.replace(/.*(_|\.)/, '') // AgentTool:Edit → Edit
  if (n === 'Edit') {
    const lang = langOf(get('file_path'))
    const blocks: ToolCodeBlock[] = []
    const oldS = get('old_string')
    const newS = get('new_string') || (t.input ?? '')
    if (oldS) blocks.push({ kind: 'code', text: oldS, lang, tone: 'old', label: get('file_path') || '− 旧' })
    if (newS) blocks.push({ kind: 'code', text: newS, lang, tone: 'new', label: oldS ? '+ 新' : (get('file_path') || '+ 新') })
    if (get('replace_all') === 'true' || p?.replace_all === true) blocks.push({ kind: 'plain', text: '(全部替换)' })
    return blocks
  }
  if (n === 'Write' || n === 'NotebookEdit') {
    const c = get('content') || (t.input ?? '')
    const fp = get('file_path')
    return c ? [{ kind: 'code', text: c, lang: langOf(fp), label: fp || undefined }] : []
  }
  if (n === 'Bash' || n === 'PowerShell') {
    const c = get('command') || (t.input ?? '')
    return c ? [{ kind: 'code', text: c, lang: n === 'Bash' ? 'bash' : 'powershell' }] : []
  }
  if (n === 'Read' || n === 'Glob' || n === 'Grep') {
    const c = get('file_path') || get('path') || get('pattern') || (t.input ?? '')
    return c ? [{ kind: 'plain', text: c }] : []
  }
  // 其余:input 若是 JSON 则 pretty(真换行);否则原文
  if (p) {
    try { return [{ kind: 'code', text: JSON.stringify(p, null, 2), lang: 'json' }] } catch { /* 落到下面 */ }
  }
  return (t.input ?? '').trim() ? [{ kind: 'code', text: t.input! }] : []
}

function ToolChip({ t, expandAll }: { t: ToolCall; expandAll: boolean }) {
  // 三态覆盖：null=跟随全局展开；点击后本块覆盖全局（全局展开时也能单块收起——
  // 曾是 `expandAll || localOpen` + `!expandAll && !v`，全局开着时点击折叠永远无效）。
  const [localOpen, setLocalOpen] = useState<boolean | null>(null)
  const open = localOpen ?? expandAll
  const full = (t.input || '').trim()
  const tip = full || (t.summary || '').trim()
  /** 展开锚定：记录 chip 屏幕Y，展开后调整 scrollTop 保持位置不动（内容不跳） */
  const chipRef = useRef<HTMLDivElement>(null)
  const prevTopRef = useRef(0)
  const toggleOpen = () => {
    if (chipRef.current) prevTopRef.current = chipRef.current.getBoundingClientRect().top
    setLocalOpen(!open)
  }
  useLayoutEffect(() => {
    if (!prevTopRef.current || !chipRef.current) return
    const scroll = chipRef.current.closest('.chat-scroll') as HTMLElement | null
    if (!scroll) return
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!chipRef.current) return
      const newTop = chipRef.current.getBoundingClientRect().top
      const delta = newTop - prevTopRef.current
      if (Math.abs(delta) > 2) scroll.scrollTop += delta
      prevTopRef.current = 0
    }))
  }, [open])
  return (
    <div ref={chipRef} className={`tool-chip ${open ? 'open' : ''}`} title={open ? undefined : (tip.length > 200 ? tip.slice(0, 200) + '…' : tip)}>
      <button className="tool-chip-head" onClick={toggleOpen}>
        <span className="tool-name">
          {toolIcon(t.name)
            ? <span className="tool-ic">{toolIcon(t.name)}</span>
            : <span className="tool-dot" style={{ color: toolColor(t.name) }}>⬤</span>}
          <span className="tool-caret">{open ? '▾' : '▸'}</span>
          {t.name}
        </span>
        {!open && t.summary && (
          <span className="tool-summary">
            {t.summary.replace(/\*\*/g, '').replace(/`/g, '')}
          </span>
        )}
      </button>
      {open && toolBlocks(t).map((b, i) =>
        b.kind === 'code'
          ? <CodeBlock key={i} code={b.text} lang={b.lang} tone={b.tone} label={b.label} />
          : <div key={i} className="tool-full" style={{ whiteSpace: 'pre-wrap' }}>{b.text}</div>,
      )}
      {open && full && toolBlocks(t).length === 0 && <CodeBlock code={full} />}
      {open && !full && t.summary && <div className="tool-full">{t.summary}</div>}
    </div>
  )
}

/** 代码块高亮（性能采样：滚动耗时 64% 是 JS=hljs 滚动中现算，绘制/布局只 ~17%）。
 *  正解 = 挂载即把高亮排进空闲队列预渲染完并写缓存，滚动时纯读缓存、零脚本：
 *   - 已缓存（预渲染完成）→ 直接彩色，滚动无 hljs、不卡。
 *   - 未缓存 → 先素色（同高不跳），空闲时算好缓存并上色（滚到前已就绪，不闪）。
 *  >6k 大 dump 跳过高亮（纯文本）；hljs 结果全局缓存（同码只算一次）。 */
const CodeBlock = memo(function CodeBlock({ code, lang, tone, label }: { code: string; lang?: string; tone?: 'old' | 'new'; label?: string }) {
  // 首帧：命中缓存（预渲染完）就直接彩色；否则素色占位（高度一致）。
  const [html, setHtml] = useState<string | null>(() => peekHighlight(code, lang) ?? null)
  useEffect(() => {
    if (html) return
    // 空闲时预渲染（requestIdleCallback）：挂载后不久即算好，不抢滚动帧。
    const ric: (cb: () => void) => number =
      (window as any).requestIdleCallback?.bind(window) ?? ((cb: () => void) => (setTimeout(cb, 1) as unknown as number))
    const cic: (id: number) => void =
      (window as any).cancelIdleCallback?.bind(window) ?? ((id: number) => clearTimeout(id))
    const id = ric(() => setHtml(highlightCode(code, lang)))
    return () => cic(id)
  }, [code, lang, html])
  const [copied, setCopied] = useState(false)
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* 剪贴板不可用静默 */ }
  }
  return (
    <div className={`tool-code-wrap${tone ? ` tool-code-${tone}` : ''}`} style={{ position: 'relative' }}>
      {label && <div className="tool-code-label">{label}</div>}
      <button
        className="code-copy-btn"
        onClick={copyCode}
        title="复制代码"
        style={{ position: 'absolute', top: 6, right: 6, opacity: copied ? 1 : 0, transition: 'opacity .15s', background: 'rgba(0,0,0,.5)', color: '#fff', border: 'none', borderRadius: 4, padding: '2px 6px', fontSize: 10, cursor: 'pointer', zIndex: 2 }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
        onMouseLeave={(e) => { if (!copied) e.currentTarget.style.opacity = '0' }}
        onFocus={(e) => (e.currentTarget.style.opacity = '1')}
      >{copied ? '✓ 已复制' : '复制'}</button>
      <pre className="tool-code" onMouseEnter={(e) => { const btn = e.currentTarget.parentElement?.querySelector('.code-copy-btn') as HTMLElement; if (btn) btn.style.opacity = '1' }} onMouseLeave={(e) => { const btn = e.currentTarget.parentElement?.querySelector('.code-copy-btn') as HTMLElement; if (btn && !copied) btn.style.opacity = '0' }}>
        <code className="hljs" dangerouslySetInnerHTML={html ? { __html: html } : undefined}>{html ? undefined : code}</code>
      </pre>
    </div>
  )
})

/** 思维链折叠块（点击展开看正文；折叠态 hover 显原生 title 预览前 200 字）。 */
function ThinkingBlock({ thinking, expandAll }: { thinking: string; expandAll: boolean }) {
  // 三态覆盖（同 ToolChip）：null=跟随全局；点击后本块覆盖——全局展开时也能单块收起
  // （曾是 `expandAll || localOpen` + `!expandAll && !v`，全局开着时点折叠永远无效）。
  const [localOpen, setLocalOpen] = useState<boolean | null>(null)
  const open = localOpen ?? expandAll
  /** 展开滚动原则(设计定稿 2026-08-26):
   *  ① 展开区最上方优先可视(屏幕放不下时,滚到让顶部可见)
   *  ② 屏幕放得下时:之前在最底→滚到最底;不在最底→不滚
   *  ③ 收起不滚 */
  const blkRef = useRef<HTMLDivElement>(null)
  const prevBottomRef = useRef(false) // 展开前是否在最底
  const wasAtBottom = () => {
    const scroll = blkRef.current?.closest('.chat-scroll') as HTMLElement | null
    if (!scroll) return false
    // column-reverse：底部=scrollTop 0（负值越大离底越远）
    return -scroll.scrollTop < 40
  }
  const toggleOpen = () => {
    if (!open) prevBottomRef.current = wasAtBottom()
    setLocalOpen(!open)
  }
  // 只在用户点击后的开合变化时滚动——挂载首跑必须跳过:全局展开时几十块挂载即 open,
  // 每块都调 scrollTop 会叠加把视口推到最顶(打开即最旧消息的根因之二)。
  const firstRunRef = useRef(true)
  useLayoutEffect(() => {
    if (firstRunRef.current) { firstRunRef.current = false; return }
    if (!open || !blkRef.current) return
    const scroll = blkRef.current.closest('.chat-scroll') as HTMLElement | null
    if (!scroll) return
    // 双 rAF 等渲染完成后再量高度
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!blkRef.current) return
      const rect = blkRef.current.getBoundingClientRect()
      const scrollRect = scroll.getBoundingClientRect()
      const expandedH = rect.height
      const viewportH = scrollRect.height
      if (expandedH <= viewportH) {
        // 屏幕放得下:之前最底→滚到最底(column-reverse 即 scrollTop=0);否则不滚
        if (prevBottomRef.current) {
          scroll.scrollTop = 0
        }
      } else {
        // 放不下:滚到让展开区顶部可见(视口系平移,column-reverse 同样成立)
        scroll.scrollTop += rect.top - (scrollRect.top + 8)
      }
      prevBottomRef.current = false
    }))
  }, [open])
  // 折叠态首行预览(2026-09-01):genTextFilter 统一清洗(跳引用行/剥口头禅/
  // 词边界截断,2026-09-05 替换裸截 42 字怼脸)。
  const preview = thinkingPreview(thinking)
  return (
    <div ref={blkRef} className="thinking-block" title={open ? undefined : (thinking.length > 200 ? thinking.slice(0, 200) + '…' : thinking)}>
      <button className="thinking-toggle" onClick={toggleOpen}>
        <span className="tool-ic">🧠</span>{open ? '▾' : '▸'} 思维链
        {!open && preview && <span className="thinking-preview"> · {preview}</span>}
      </button>
      {open && <div className="thinking-body">{thinking.trim()}</div>}
    </div>
  )
}

/** 模型名简化显示（剥 [1m] 等方括号后缀）。 */
function shortModel(model: string): string {
  return model.replace(/\[.*?\]/g, '')
}

/** Harness id → 短名（claude-code→Claude, kimi-code→Kimi, codex→Codex）。 */
function shortHarness(harness: string): string {
  return harness.replace(/-code$/i, '').replace(/^claude$/i, 'Claude')
    .replace(/^kimi$/i, 'Kimi').replace(/^codex$/i, 'Codex')
}
