/**
 * taskDispTitle.test.ts — 任务卡标题 mojibake 显示兜底（2026-10-11 手机实测
 * "??"-DSH????"）。根因链：EnvServer eval 调试通道的 POST body 被 PowerShell 5.1
 * 按 ISO-8859-1 best-fit 编码（中文→`?`、U+00B7→U+FFFD、全角→半角），demo 注入的
 * 卡带着烂标题进了本机库。生产链路（fetch/reqwest/axum/原生隧道）全程 UTF-8——
 * 同机会话对账拉到的中文标题完好（重构分享网关）。兜底只作用于**DSH 分享卡**。
 */
import { describe, it, expect } from 'vitest'
import { titleLooksMojibake, taskDispTitle } from '../chat-store'

describe('titleLooksMojibake：烂尾形态识别', () => {
  it('真机病灶串命中（中文塌 ?、间隔号塌 U+FFFD）', () => {
    expect(titleLooksMojibake('??-DSH????')).toBe(true)
    expect(titleLooksMojibake('myco ?? \uFFFD ??(??:? + ?)')).toBe(true)
    expect(titleLooksMojibake('?\uFFFDsHaW')).toBe(true)
  })
  it('正常标题不误伤（含单个问号、空值）', () => {
    expect(titleLooksMojibake('演示-DSH会话协作')).toBe(false)
    expect(titleLooksMojibake('这是什么?')).toBe(false)
    expect(titleLooksMojibake('')).toBe(false)
    expect(titleLooksMojibake(undefined)).toBe(false)
    expect(titleLooksMojibake(null)).toBe(false)
  })
})

describe('taskDispTitle：显示兜底（只对 DSH 分享卡生效）', () => {
  it('分享卡烂标题 → 分享·尾4', () => {
    expect(taskDispTitle({ title: '??-DSH????', shareId: 'sh-7b68c7ee', taskId: 'peer-task-share-sh-7b68c7ee' })).toBe('分享·c7ee')
  })
  it('分享卡好标题原样', () => {
    expect(taskDispTitle({ title: '演示-DSH会话协作', shareId: 'sh-7b68c7ee' })).toBe('演示-DSH会话协作')
  })
  it('普通任务卡不兜底（用户真打 ??? 也照显——不替用户改字）', () => {
    expect(taskDispTitle({ title: '真的吗???', taskId: 'peer-task-1' })).toBe('真的吗???')
  })
  it('老环境卡卡名带 127.0.0.1:端口 → 显示时抹掉（2026-10-25 用户反馈；数据不动）', () => {
    expect(taskDispTitle({ title: '【PC远程桌面】127.0.0.1:23389' })).toBe('【PC远程桌面】')
    expect(taskDispTitle({ title: '【PC-DSH-Web】127.0.0.1:23911', shareId: 'sh-x' })).toBe('【PC-DSH-Web】')
  })
  it('空标题回落「任务」', () => {
    expect(taskDispTitle({})).toBe('任务')
  })
})
