/**
 * genTextFilter 单测：TUI 记号清洗、四大类归类、词边界截断、思维链预览。
 * 语料来自用户实测吐槽（aop1/aop2 会话原文）。
 */
import { describe, it, expect } from 'vitest'
import { filterGeneratingLines, thinkingPreview, truncWords } from './genTextFilter'

describe('filterGeneratingLines', () => {
  it('⎿ 结果行归类 result 且剥 (ctrl+o to expand) 括注', () => {
    const r = filterGeneratingLines('⎿ "escape"|Esca… (ctrl+o to expand)')
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0].kind).toBe('result')
    expect(r.lines[0].text).not.toContain('ctrl+o')
  })

  it('● 工具行归类 tool 并提取首词', () => {
    const r = filterGeneratingLines('● Read(src/main.rs)')
    expect(r.lines[0].kind).toBe('tool')
    expect(r.lines[0].toolWord).toBe('Read')
  })

  it('spinner 动词行丢弃、状态行保留正文', () => {
    const r = filterGeneratingLines(['✻ Sautéed for 7s', '✻ Searching for 1 pattern…', '● Bash(ls)'].join('\n'))
    const kinds = r.lines.map((l) => l.kind)
    expect(kinds).toEqual(['status', 'tool'])
    expect(r.lines[0].text).toContain('Searching')
  })

  it('键位提示/输入提示/边框/logo 全丢', () => {
    const r = filterGeneratingLines([
      '(ctrl+o to expand)',
      '❯ /model',
      '────────────',
      '  ▐▛███▛█   Claude Code v2.1.239',
      'esc to cancel',
      '↑1.2k tokens',
    ].join('\n'))
    expect(r.lines).toHaveLength(0)
    expect(r.skipped).toBe(6)
  })

  it('无前缀行=thought；XML 开头丢弃', () => {
    const r = filterGeneratingLines(['正在分析数据结构', '<task-notification><task-id>x'].join('\n'))
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0].kind).toBe('thought')
  })

  it('🔍 emoji 状态横幅归 status（2026-09-09 漏网路径）', () => {
    const r = filterGeneratingLines('🔍 Searching memories… (ctrl+o to expand)')
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0].kind).toBe('status')
    expect(r.lines[0].text).toContain('Searching')
    expect(r.lines[0].text).not.toContain('ctrl')
  })

  it('折行劈半的括注尾片剥掉、正文保留', () => {
    // 窄终端列宽折行：前半 "… (ctrl" 不含完整 "ctrl+" 锚，TRAILING_NOTE_RE 匹配不上
    const r = filterGeneratingLines('正在读取记忆库 (ctrl')
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0].kind).toBe('thought')
    expect(r.lines[0].text).toBe('正在读取记忆库')
  })

  it('⏺ 新版工具记号归 tool；Thought for Ns 归 status', () => {
    const r = filterGeneratingLines(['⏺ Bash(ls -la)', 'Thought for 6s'].join('\n'))
    expect(r.lines.map((l) => l.kind)).toEqual(['tool', 'status'])
    expect(r.lines[0].toolWord).toBe('Bash')
  })
})

describe('truncWords', () => {
  it('短串原样', () => {
    expect(truncWords('abc', 10)).toBe('abc')
  })
  it('CJK 按字截断', () => {
    expect(truncWords('一二三四五六七八九十', 5)).toBe('一二三四五…')
  })
  it('拉丁不截半个词', () => {
    const out = truncWords('reading the filesystem carefully', 12)
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toMatch(/caref|filesys/)
  })
  it('路径保首尾（省略号在中间）', () => {
    const out = truncWords('D:\\Projects\\labs\\myco\\services\\terminal-agent\\src\\service.rs', 30)
    expect(out.startsWith('D:\\')).toBe(true)
    expect(out).toContain('…')
    expect(out.endsWith('.rs')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(32)
  })
})

describe('thinkingPreview', () => {
  it('跳过引用行+剥口头禅', () => {
    const t = thinkingPreview('> 引用上文\n好的，让我看看这个问题的根源在哪里才能真正修复')
    expect(t).not.toContain('好的')
    expect(t).not.toContain('让我')
    expect(t).toContain('问题')
  })
  it('英文口头禅剥一层', () => {
    const t = thinkingPreview("Let me check the data source first before making changes")
    expect(t).not.toMatch(/^let me/i)
  })
  it('空/全引用→空串', () => {
    expect(thinkingPreview('> only quote')).toBe('')
  })
})
