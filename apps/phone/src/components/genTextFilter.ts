/**
 * genTextFilter — 生成中实时文本的感知→认知→呈现整理层（2026-09-05 设计定稿方向）。
 *
 * 数据源三路（proxy 流式增量 / jsonl 落盘前屏幕兜底 / spinner 状态行）都带着
 * Claude Code TUI 的原始记号：`(ctrl+o to expand)` 括注、`⎿` 结果行、`●` 工具行、
 * token 计数、键位提示——直接渲染就是用户吐槽的"乱的字符在行首/半行/不知在干嘛"。
 * 这里统一清洗+归类为四大类（工具/结果/思考/状态），前端只管按类渲染图标。
 *
 * 纯函数模块（可单测）；ChatView 的 GenText 与 HistoryPanel 的 pending 块共用。
 */

export interface GenLine {
  /** tool=执行工具(动作) result=工具回声 thought=思考/推理 status=状态/信息 */
  kind: 'tool' | 'result' | 'thought' | 'status'
  text: string
  /** tool 行的首词（Read/Bash/…），渲染层映射 toolIcon/toolColor。 */
  toolWord?: string
}

export interface GenFilterResult {
  lines: GenLine[]
  /** 被丢弃的行数（噪音/状态碎片），渲染层可示"… N 行已略"。 */
  skipped: number
}

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\r(?!\n)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|\u200B|\uFEFF/g
const BULLET_RE = /^([●○◆▪•⏺⎿])\s?(.*)$/
// 🔍✏✍✨(2026-09-09)：claude TUI 状态横幅用 emoji 开头（"🔍 Searching memories…"），
// 与 spinner 同类=状态行；ta 侧已认（find_spinner_anchor），这里同源防漏。
const SPINNER_LEAD = '✻✽✶✳✢*·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏🔍✏✍✨'
const BORDER_CHARS = '─━—–│┃┌┐└┘├┤┬┴┼═║╔╗╚╝╭╮╰╯'

/** 键位/操作提示括注：`(ctrl+o to expand)` `(8s · ↑1.2k tokens)` 等行尾噪音。 */
const TRAILING_NOTE_RE = /\s*\((?:ctrl\+[^)]*|esc[^)]*|\d+s[^)]*)\)\s*$/
/** 未闭合的行尾括注半片：窄终端列宽折行把括注劈成 "… (ctrl" / "+o to expand)" 两半，
 * 完整锚串被劈断后 TRAILING_NOTE_RE 匹配不上——半截也剥掉。 */
const UNCLOSED_PAREN_TAIL_RE = /\s*\([^)]*$/

function clean(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\s{2,}/g, ' ').trim()
}

/** 词边界截断：CJK 按字数；拉丁不截半个词；长路径 token（含 / \ . :）保首尾。 */
export function truncWords(s: string, max: number): string {
  if (s.length <= max) return s
  // 含路径的长 token：保首尾
  if (/[/\\]/.test(s.slice(0, 40))) {
    const head = Math.max(8, Math.floor(max * 0.35))
    return s.slice(0, head) + '…' + s.slice(-(max - head - 1))
  }
  const cut = s.slice(0, max)
  // 拉丁词中间截断：退到词边界（当前字符与下一字符都是字母数字=词中）
  if (/[\w\u4e00-\u9fff]/.test(cut[max - 1]) && /[\w]/.test(s[max] ?? '')) {
    const m = cut.match(/^[\s\S]*[^\w]/)
    return (m ? m[0] : cut) + '…'
  }
  return cut + '…'
}

/** 单行判定+归类。null=丢弃（噪音）。 */
function classifyLine(raw: string): GenLine | null {
  const t = clean(raw)
  if (!t) return null
  const first = t[0]

  // 纯边框/装饰线
  if (BORDER_CHARS.includes(first) && [...t].every((c) => BORDER_CHARS.includes(c) || c === ' ')) return null
  // 输入提示行（TUI 输入框/历史滚动区）
  if (first === '❯' || first === '>' || first === '?') return null
  // logo 四分块
  if (/\u2580|\u2590|\u2584|\u259c|\u2598|\u259d|\u259e|\u259f/.test(t)) return null
  // 键位提示/计数行（整行都是提示语）
  if (/^(ctrl|esc|shift|alt|tab|press|enter)[\s+]/i.test(t)) return null
  if (/tokens?\b/i.test(t) && /\d/.test(t) && t.length < 40 && !BULLET_RE.test(t)) return null
  if (/bypass permissions|shift\+tab|to expand$|interrupt\b/i.test(t)) return null

  let body = t.replace(TRAILING_NOTE_RE, '').replace(UNCLOSED_PAREN_TAIL_RE, '')
  if (!body) return null // 整行就是键位括注（完整或劈半） → 丢

  // ⎿ 结果行
  const m = body.match(BULLET_RE)
  if (m) {
    body = clean(m[2])
    if (!body) return null
    if (m[1] === '⎿') return { kind: 'result', text: truncWords(body, 72) }
    if ('●○◆▪•⏺'.includes(m[1])) {
      const toolWord = body.match(/^[A-Za-z][A-Za-z0-9_]*/)?.[0] ?? ''
      return { kind: 'tool', text: truncWords(body, 72), toolWord: toolWord || undefined }
    }
  }
  // 折叠思考横幅 "Thought for 6s" → 状态（不是思考内容本身）
  if (/^thought for \d+/i.test(body)) return { kind: 'status', text: truncWords(body, 72) }
  // spinner 行有正文 → 状态行（✻ Sautéed for 7s 这类收尾横幅丢弃）
  if (SPINNER_LEAD.includes(first)) {
    const rest = clean(body.slice(1))
    if (!rest) return null
    if (/^(saut\u00e9ed|cooked|simmered|braised|charred|marinated|pickled|fermented|deep[- ]fried|saut�\u00e9ed)/i.test(rest)) return null
    return { kind: 'status', text: truncWords(rest, 72) }
  }
  // 思维链泄露防御：XML/系统提示开头不当思考渲染
  if (/^</.test(body)) return null
  return { kind: 'thought', text: truncWords(body, 72) }
}

/** 整段生成文本 → 归类行列表（保持行序，丢噪音计数）。
 *  2026-09-12：空行/纯零宽行不计 skipped——proxy 流标记(ZWSP)与 keepalive 续推
 *  曾把空行算进丢弃数，「前 N 行已略」在无内容可略时也挂出（K3 帧截图实锤）。
 *  只有「有字符但被分类丢弃」的行才算略过。 */
export function filterGeneratingLines(raw: string): GenFilterResult {
  const all = raw.split('\n')
  let skipped = 0
  const lines: GenLine[] = []
  for (const line of all) {
    const c = classifyLine(line)
    if (c) lines.push(c)
    else if (clean(line)) skipped++
  }
  return { lines, skipped }
}

/** 思维链折态预览：跳过引用行、剥口头禅开头（可连剥多层"好的，让我…"），词边界截。 */
export function thinkingPreview(thinking: string): string {
  const lines = thinking
    .split('\n')
    .map((l) => l.replace(ANSI_RE, '').trim())
    .filter((l) => l && !l.startsWith('> '))
  let text = lines[0] ?? ''
  for (let i = 0; i < 3; i++) {
    const next = text.replace(/^(好的|明白|收到|嗯|OK|Okay|Let me see|Let me|让我|我来|首先|现在|Now let me|Looking at|First,)\s*[，,。.\s]?\s*/i, '')
    if (next === text) break
    text = next
  }
  return truncWords(text, 42)
}
