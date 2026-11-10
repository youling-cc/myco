/**
 * restoreImport.test.ts — 恢复码导入内联表单纯逻辑（2026-09-30 批A）。
 * 覆盖：归一（三行手抄容忍）/ 表单状态机（展开→提交→错误显示→成功复位）/ 提交编排（错误透传）。
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeRestoreText,
  restoreErrorText,
  restoreFormInit,
  restoreFormReduce,
  submitRestoreImport,
} from './restoreImport'

describe('normalizeRestoreText', () => {
  it('单行 base64 原样通过（复制按钮产出的标准形态）', () => {
    expect(normalizeRestoreText('QUJDREVGR0hJSg==')).toBe('QUJDREVGR0hJSg==')
  })

  it('三行折行拼成单行（备份弹窗分段誊抄场景）', () => {
    expect(normalizeRestoreText('QUJDRA\nRUZH\nMTIz')).toBe('QUJDRARUZHMTIz')
  })

  it('行号前缀全形态剥除（"1." "2)" "3、" "4:"）', () => {
    expect(normalizeRestoreText('1. QUJDRA\n2) RUZH\n3、MTIz')).toBe('QUJDRARUZHMTIz')
    expect(normalizeRestoreText('4: QUJDRA')).toBe('QUJDRA')
  })

  it('行间/行内空白与 \\r 全容忍', () => {
    expect(normalizeRestoreText('  QUJDRA  \n\n  RUZH \r\n')).toBe('QUJDRARUZH')
    expect(normalizeRestoreText('QUJD RARUZH')).toBe('QUJDRARUZH')
  })

  it('加密备份块保持行结构（后端按行解析 ct/salt/iv），剥行号与 \\r', () => {
    expect(normalizeRestoreText('ct=AAA\r\nsalt=BBB\niv=CCC')).toBe('ct=AAA\nsalt=BBB\niv=CCC')
    expect(normalizeRestoreText('1. ct=AAA\n2. salt=BBB')).toBe('ct=AAA\nsalt=BBB')
  })

  it('空输入归一为空串', () => {
    expect(normalizeRestoreText('')).toBe('')
    expect(normalizeRestoreText('  \n \n ')).toBe('')
  })
})

describe('restoreErrorText', () => {
  it('剥 Error: 前缀，后端原文保留', () => {
    expect(restoreErrorText(new Error('Error: 备份格式不对（应为 32 字节种子的 base64）'))).toBe('备份格式不对（应为 32 字节种子的 base64）')
    expect(restoreErrorText('加密备份需要密码')).toBe('加密备份需要密码')
  })
})

describe('restoreFormReduce（表单状态机）', () => {
  it('toggle 展开表单，再 toggle 收起；重新展开清上次错误', () => {
    const opened = restoreFormReduce(restoreFormInit, { type: 'toggle' })
    expect(opened.open).toBe(true)
    expect(restoreFormReduce(opened, { type: 'toggle' }).open).toBe(false)
    const withErr = restoreFormReduce(opened, { type: 'fail', error: '密码不对' })
    expect(withErr.error).toBe('密码不对')
    const reopened = restoreFormReduce({ ...withErr, open: false }, { type: 'toggle' })
    expect(reopened.open).toBe(true)
    expect(reopened.error).toBeNull()
  })

  it('空恢复码提交 → 就地错误行，不进 busy', () => {
    const s = restoreFormReduce({ ...restoreFormInit, open: true }, { type: 'submit' })
    expect(s.error).toBe('请粘贴恢复码')
    expect(s.busy).toBe(false)
  })

  it('合法输入提交 → busy；后端失败 → 错误行显示原文', () => {
    let s = restoreFormReduce({ ...restoreFormInit, open: true, text: 'QUJD' }, { type: 'submit' })
    expect(s.busy).toBe(true)
    expect(s.error).toBeNull()
    s = restoreFormReduce(s, { type: 'fail', error: '备份格式不对（应为 32 字节种子的 base64）' })
    expect(s.busy).toBe(false)
    expect(s.error).toContain('备份格式不对')
  })

  it('busy 中重复提交被吞（防双击双导入）', () => {
    const busy = restoreFormReduce({ ...restoreFormInit, open: true, text: 'QUJD' }, { type: 'submit' })
    expect(restoreFormReduce(busy, { type: 'submit' })).toBe(busy)
  })

  it('成功 done → 表单复位（App 据此跳 page 屏，下次进来是干净表单）', () => {
    const s = restoreFormReduce(
      { ...restoreFormInit, open: true, text: 'QUJD', password: 'x', busy: true },
      { type: 'done' },
    )
    expect(s).toEqual(restoreFormInit)
  })
})

describe('submitRestoreImport（提交编排）', () => {
  it('成功：归一后调 importFn，返回 rootDid（调用方跳 page 屏）', async () => {
    let got: [string, string] | null = null
    const r = await submitRestoreImport(
      { text: '1. QUFDRA\n2. RUZH', password: 'pw' },
      async (t, p) => { got = [t, p]; return 'did:youling:Tail' },
    )
    expect(r).toEqual({ ok: true, rootDid: 'did:youling:Tail' })
    expect(got).toEqual(['QUFDRARUZH', 'pw'])
  })

  it('失败：后端错误原文透传（不吞不错译）', async () => {
    const r = await submitRestoreImport(
      { text: 'QUJD', password: '' },
      async () => { throw new Error('Error: 备份格式不对（应为 32 字节种子的 base64）') },
    )
    expect(r).toEqual({ ok: false, error: '备份格式不对（应为 32 字节种子的 base64）' })
  })

  it('空文本短路：不触网络层', async () => {
    let called = false
    const r = await submitRestoreImport({ text: ' \n ', password: '' }, async () => { called = true; return 'x' })
    expect(r).toEqual({ ok: false, error: '请粘贴恢复码' })
    expect(called).toBe(false)
  })
})
