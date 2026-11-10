/**
 * term-reflow — 把 PC 端 cols×rows 的终端格子重排（reflow）到手机实际宽度。
 *
 * 背景：ta 的 /buffer 返回 PC 物理行（model 模式带 wrapped 标记，screen 模式没有）。
 * 手机不锁 PC 的 cols：先按"逻辑行"拼回（model 用 wrapped 精确拼，screen 用
 * "满宽行与下行拼接"启发式），再按手机实际 phoneCols 重新断行。覆盖 scrollback
 * 历史——/buffer 任意区段都能过这道重排。
 *
 * 纯函数，不依赖 DOM/React，可单测。
 */
import type { CharInfo } from './transport'

export interface ReflowInput {
  /** PC 物理行的单元格（每行长度≈cols；宽字符 spacer 格 ta 侧已跳过）。 */
  cells: CharInfo[][]
  /** PC 终端列宽（显示列）。 */
  cols: number
  /** 手机实际列宽（显示列，= 容器像素宽 / 字宽）。 */
  phoneCols: number
  /** model 模式：wrapped[i]=true → 行 i 自动换行进行 i+1（同一逻辑行）。 */
  wrapped?: boolean[]
  /** 区段内光标（物理行下标 + 显示列）；给了才返回重排后的光标位置。 */
  cursor?: { row: number; x: number } | null
}

export interface ReflowOutput {
  /** 重排后的显示行（每行显示宽 ≤ phoneCols）。 */
  lines: CharInfo[][]
  /** 重排后光标：line=输出行下标，cell=行内 cell 下标（渲染时按 cell 画光标块）。 */
  cursor: { line: number; cell: number } | null
}

/** 东亚宽字符占 2 显示列（对齐 ta 侧宽字符语义；spacer 格已被 ta 跳过）。 */
export function cellWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  if (cp < 0x1100) return 1
  return (
    (cp <= 0x115f) ||                    // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||    // CJK 部首/符号/日文
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||    // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) ||    // CJK 统一表意
    (cp >= 0xa000 && cp <= 0xa4cf) ||    // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) ||    // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) ||    // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe6f) ||    // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) ||    // 全角
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) ? 2 : 1
}

/** 一行单元格的显示宽度。 */
export function rowWidth(cells: readonly CharInfo[]): number {
  let w = 0
  for (const c of cells) w += cellWidth(c.ch)
  return w
}

/** 去掉行尾"默认背景的空格"（console 网格的填充格；保留带背景色的空格——可能是
 *  状态栏/高亮的有意填充）。不可变：返回新数组或原数组。 */
export function trimRowEnd(cells: readonly CharInfo[]): CharInfo[] {
  let end = cells.length
  while (end > 0) {
    const c = cells[end - 1]
    if (c.ch === ' ' && c.bg === 0 && !c.bgRgb) end--
    else break
  }
  return end === cells.length ? cells.slice() : cells.slice(0, end)
}

/** 把 PC 物理行拼成逻辑行。model 用 wrapped 精确拼；无 wrapped（screen 模式）
 *  用启发式：trim 后显示宽 ≥ cols-1 的"满宽行"与下行拼接（满行末列可能是空格
 *  被 trim 掉，留 1 列容差）。返回每条的成员物理行下标区间 [start, end)。 */
export function groupLogicalLines(
  rows: readonly (readonly CharInfo[])[],
  cols: number,
  wrapped?: readonly boolean[],
): Array<{ start: number; end: number }> {
  const groups: Array<{ start: number; end: number }> = []
  let i = 0
  while (i < rows.length) {
    let end = i + 1
    if (wrapped) {
      while (end - 1 < rows.length && wrapped[end - 1] && end < rows.length) end++
    } else {
      while (end < rows.length && rowWidth(trimRowEnd(rows[end - 1])) >= cols - 1) end++
    }
    groups.push({ start: i, end })
    i = end
  }
  return groups
}

/** 一条逻辑行 = 成员物理行的单元格顺序拼接（中间行全量保留——它们是满行内容；
 *  末行 trim 掉网格填充）。 */
function concatGroup(rows: readonly (readonly CharInfo[])[], g: { start: number; end: number }): CharInfo[] {
  const out: CharInfo[] = []
  for (let r = g.start; r < g.end; r++) {
    const cells = r === g.end - 1 ? trimRowEnd(rows[r]) : rows[r]
    for (const c of cells) out.push(c)
  }
  return out
}

/** 把一条逻辑行按 phoneCols 显示宽断成若干输出行；记录每个源物理行首 cell 在
 *  输出中的位置（光标映射用）。纯追加进 out/rowPos。 */
function emitGroup(
  cells: readonly CharInfo[],
  phoneCols: number,
  g: { start: number; end: number },
  memberLens: readonly number[],   // 每个源物理行贡献到逻辑行的 cell 数
  out: CharInfo[][],
  rowPos: Array<{ line: number; cell: number }>,
): void {
  if (cells.length === 0) {
    for (let r = g.start; r < g.end; r++) rowPos[r] = { line: out.length, cell: 0 }
    out.push([])
    return
  }
  // 源物理行 → 其首 cell 在逻辑行里的下标
  const srcBase: number[] = []
  {
    let acc = 0
    for (const len of memberLens) { srcBase.push(acc); acc += len }
  }
  let srcIdx = 0
  let cur: CharInfo[] = []
  let curW = 0
  const flush = () => { out.push(cur); cur = []; curW = 0 }
  for (let i = 0; i < cells.length; i++) {
    // 进入某源物理行的首 cell 时记录输出位置
    while (srcIdx < srcBase.length && srcBase[srcIdx] === i) {
      rowPos[g.start + srcIdx] = { line: out.length, cell: cur.length }
      srcIdx++
    }
    const c = cells[i]
    const w = cellWidth(c.ch)
    if (curW + w > phoneCols) flush()
    cur.push(c)
    curW += w
  }
  flush()
  // 末源行 trim 后可能一个 cell 都没贡献（空行），位置指向末输出行末尾
  for (let r = g.start; r < g.end; r++) {
    if (!rowPos[r]) rowPos[r] = { line: out.length - 1, cell: out[out.length - 1].length }
  }
}

/** 光标显示列 x → 源物理行内的 cell 下标（x 是显示列，前面有宽字符时 cell 数 < x）。 */
function cellIndexAtCol(cells: readonly CharInfo[], x: number): number {
  let acc = 0
  let i = 0
  while (i < cells.length && acc + cellWidth(cells[i].ch) <= x) {
    acc += cellWidth(cells[i].ch)
    i++
  }
  return i
}

export function reflow(input: ReflowInput): ReflowOutput {
  const { cells, cols, phoneCols, wrapped, cursor } = input
  const width = Math.max(2, phoneCols)
  const groups = groupLogicalLines(cells, cols, wrapped)
  const lines: CharInfo[][] = []
  const rowPos: Array<{ line: number; cell: number }> = []
  for (const g of groups) {
    const memberLens: number[] = []
    for (let r = g.start; r < g.end; r++) {
      memberLens.push(r === g.end - 1 ? trimRowEnd(cells[r]).length : cells[r].length)
    }
    emitGroup(concatGroup(cells, g), width, g, memberLens, lines, rowPos)
  }
  let cur: { line: number; cell: number } | null = null
  if (cursor && cursor.row >= 0 && cursor.row < cells.length && rowPos[cursor.row]) {
    const base = rowPos[cursor.row]
    const srcRow = cells[cursor.row]
    const within = cellIndexAtCol(trimRowEnd(srcRow), cursor.x)
    // 从源行首 cell 的输出位置往前走 within 个 cell（可能跨输出行）
    let line = base.line
    let cell = base.cell + within
    while (line < lines.length && cell > lines[line].length) {
      cell -= lines[line].length
      line++
    }
    if (line >= lines.length) { line = lines.length - 1; cell = lines[line]?.length ?? 0 }
    cur = { line, cell }
  }
  return { lines, cursor: cur }
}

/** 无 cells 时的兜底：文本行合成默认色单元格（老 ta / snap 路径），走同一 reflow。 */
export function cellsFromLines(lines: readonly string[]): CharInfo[][] {
  return lines.map((line) =>
    Array.from(line, (ch) => ({ ch, fg: 7, bg: 0, inverse: false }) as CharInfo),
  )
}
