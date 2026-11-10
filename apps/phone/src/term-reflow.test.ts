/**
 * term-reflow 单测：逻辑行拼接（model wrapped / screen 启发式）、按 phoneCols
 * 重断行、宽字符宽度、行尾填充 trim、truecolor 透传、光标映射。
 */
import { describe, it, expect } from 'vitest'
import { reflow, groupLogicalLines, trimRowEnd, rowWidth, cellWidth, cellsFromLines } from './term-reflow'
import type { CharInfo } from './transport'

const c = (ch: string, over: Partial<CharInfo> = {}): CharInfo =>
  ({ ch, fg: 7, bg: 0, inverse: false, ...over })

const rowOf = (s: string, over: Partial<CharInfo> = {}): CharInfo[] =>
  Array.from(s, (ch) => c(ch, over))

/** 造一行"网格行"：内容 + 默认空格填充到 cols。 */
const gridRow = (s: string, cols: number): CharInfo[] => {
  const cells = rowOf(s)
  while (cells.length < cols) cells.push(c(' '))
  return cells
}

const text = (cells: CharInfo[]): string => cells.map((x) => x.ch).join('')

describe('cellWidth / rowWidth', () => {
  it('ASCII 1 列，CJK 2 列', () => {
    expect(cellWidth('a')).toBe(1)
    expect(cellWidth('中')).toBe(2)
    expect(cellWidth('。')).toBe(2)
    expect(rowWidth(rowOf('ab中文'))).toBe(6)
  })
})

describe('trimRowEnd', () => {
  it('去掉默认背景空格填充，不动原数组', () => {
    const r = gridRow('hi', 6)
    const t = trimRowEnd(r)
    expect(text(t)).toBe('hi')
    expect(r.length).toBe(6) // 不可变
  })
  it('保留带背景色的行尾空格（状态栏填充）', () => {
    const r = [...rowOf('hi'), c(' ', { bg: 4 }), c(' ', { bg: 4 })]
    expect(trimRowEnd(r).length).toBe(4)
  })
  it('保留 truecolor 背景的行尾空格', () => {
    const r = [...rowOf('hi'), c(' ', { bgRgb: [30, 30, 30] })]
    expect(trimRowEnd(r).length).toBe(3)
  })
})

describe('groupLogicalLines', () => {
  it('model：wrapped 精确拼行', () => {
    const rows = [gridRow('ABCDEFGH', 8), gridRow('IJK', 8), gridRow('xy', 8)]
    const g = groupLogicalLines(rows, 8, [true, false, false])
    expect(g).toEqual([{ start: 0, end: 2 }, { start: 2, end: 3 }])
  })
  it('model：wrapped 覆盖 scrollback 区段内任意位置', () => {
    const rows = [gridRow('a', 8), gridRow('12345678', 8), gridRow('90', 8), gridRow('z', 8)]
    const g = groupLogicalLines(rows, 8, [false, true, false, false])
    expect(g).toEqual([{ start: 0, end: 1 }, { start: 1, end: 3 }, { start: 3, end: 4 }])
  })
  it('screen 启发式：满宽行与下行拼接', () => {
    const rows = [gridRow('12345678', 8), gridRow('90', 8), gridRow('短', 8)]
    const g = groupLogicalLines(rows, 8)
    expect(g).toEqual([{ start: 0, end: 2 }, { start: 2, end: 3 }])
  })
  it('screen 启发式：满宽但末列是空格也拼（trim 留 1 列容差）', () => {
    const rows = [gridRow('1234567 ', 8), gridRow('90', 8)]
    // trim 后宽 7 ≥ cols-1 → 视为满宽，拼接
    const g = groupLogicalLines(rows, 8)
    expect(g).toEqual([{ start: 0, end: 2 }])
  })
  it('screen 启发式：不满宽不拼', () => {
    const rows = [gridRow('12345', 8), gridRow('90', 8)]
    const g = groupLogicalLines(rows, 8)
    expect(g).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }])
  })
})

describe('reflow', () => {
  it('model 拼逻辑行后按 phoneCols 重断（宽 PC → 窄手机）', () => {
    // PC 8 列：'ABCDEFGH'+'IJK' 是同一逻辑行 11 字符；phoneCols=5 → 3 行
    const rows = [gridRow('ABCDEFGH', 8), gridRow('IJK', 8)]
    const out = reflow({ cells: rows, cols: 8, phoneCols: 5, wrapped: [true, false] })
    expect(out.lines.map(text)).toEqual(['ABCDE', 'FGHIJ', 'K'])
  })
  it('窄 PC → 宽手机：逻辑行拼回一行', () => {
    const rows = [gridRow('ABCDEFGH', 8), gridRow('IJK', 8)]
    const out = reflow({ cells: rows, cols: 8, phoneCols: 40, wrapped: [true, false] })
    expect(out.lines.map(text)).toEqual(['ABCDEFGHIJK'])
  })
  it('screen 无 wrapped 时按满宽启发式拼', () => {
    const rows = [gridRow('12345678', 8), gridRow('90', 8), gridRow('xy', 8)]
    const out = reflow({ cells: rows, cols: 8, phoneCols: 40 })
    expect(out.lines.map(text)).toEqual(['1234567890', 'xy'])
  })
  it('宽字符不断在半截：CJK 超宽时整字挪下行', () => {
    const rows = [gridRow('ab中文cd', 8)]
    const out = reflow({ cells: rows, cols: 8, phoneCols: 4 })
    // 'ab中'(4) 超 4 → 'ab' + '中' 下行动作：第一行 'ab中'? ab(2)+中(2)=4 恰好
    expect(out.lines.map(text)).toEqual(['ab中', '文cd'])
  })
  it('空行/全填充行保留为一个空输出行', () => {
    const rows = [gridRow('', 8), gridRow('hi', 8)]
    const out = reflow({ cells: rows, cols: 8, phoneCols: 40 })
    expect(out.lines.length).toBe(2)
    expect(text(out.lines[0])).toBe('')
    expect(text(out.lines[1])).toBe('hi')
  })
  it('truecolor 字段随 cell 透传', () => {
    const r = [...rowOf('Z', { fgRgb: [12, 34, 56] }), ...gridRow('', 7)]
    const out = reflow({ cells: [r], cols: 8, phoneCols: 40 })
    expect(out.lines[0][0].fgRgb).toEqual([12, 34, 56])
  })
  it('属性分段不被重排破坏：颜色边界保持', () => {
    const r = [...rowOf('AB', { fg: 1 }), ...rowOf('CD', { fg: 2 }), ...gridRow('', 4)]
    const out = reflow({ cells: [r], cols: 8, phoneCols: 3 })
    expect(out.lines.map(text)).toEqual(['ABC', 'D'])
    expect(out.lines[0][2].fg).toBe(2)
  })
})

describe('reflow 光标映射', () => {
  it('光标在未断行内直接定位', () => {
    const rows = [gridRow('hello', 8)]
    const out = reflow({ cells: rows, cols: 8, phoneCols: 40, cursor: { row: 0, x: 2 } })
    expect(out.cursor).toEqual({ line: 0, cell: 2 })
  })
  it('光标跨过拼接的逻辑行：落在下行对应 cell', () => {
    // PC 8 列两物理行拼成 11 字符逻辑行，phoneCols=5 → [ABCDE][FGHIJ][K]
    const rows = [gridRow('ABCDEFGH', 8), gridRow('IJK', 8)]
    // 光标在第 2 物理行 x=1（=逻辑行第 9 个字符 J）→ 输出 line1('FGHIJ') cell4
    const out = reflow({ cells: rows, cols: 8, phoneCols: 5, wrapped: [true, false], cursor: { row: 1, x: 1 } })
    expect(out.cursor).toEqual({ line: 1, cell: 4 })
  })
  it('光标前有宽字符：x 是显示列，cell 下标要按宽度折算', () => {
    const rows = [gridRow('中ab', 8)]
    // x=2 → '中'(宽2)之后 → cell 1
    const out = reflow({ cells: rows, cols: 8, phoneCols: 40, cursor: { row: 0, x: 2 } })
    expect(out.cursor).toEqual({ line: 0, cell: 1 })
  })
  it('区段外光标返回 null', () => {
    const rows = [gridRow('hi', 8)]
    const out = reflow({ cells: rows, cols: 8, phoneCols: 40, cursor: { row: 5, x: 0 } })
    expect(out.cursor).toBeNull()
  })
})

describe('cellsFromLines 兜底', () => {
  it('文本行合成默认色单元格后可走同一 reflow', () => {
    const cells = cellsFromLines(['12345678', '90'])
    const out = reflow({ cells, cols: 8, phoneCols: 40 })
    expect(out.lines.map(text)).toEqual(['1234567890'])
  })
})
