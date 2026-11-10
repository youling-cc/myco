import { describe, expect, it } from 'vitest'
import { canSubmitTaskForm, taskShareSubmitArgs, type TaskShareFormFields } from './taskShareForm'

/** 2026-09-29 提交断头路根修的最小状态机单测：填写 → 可提交 → 提交参数落位。 */
const F = (over: Partial<TaskShareFormFields> = {}): TaskShareFormFields => ({
  title: '', desc: '', req: '', reward: '', days: '0', ...over,
})

describe('新建任务卡表单状态机', () => {
  it('空表单 → 不可提交（标题必填）', () => {
    expect(canSubmitTaskForm(F(), false)).toBe(false)
  })

  it('只填介绍/要求/奖励、标题仍空 → 不可提交（对应"填完内容没地方提交"场景的守门）', () => {
    expect(canSubmitTaskForm(F({ desc: '一起做任务', req: '验收：可编译', reward: '100 积分' }), false)).toBe(false)
  })

  it('标题纯空白 → 视为空（trim 后判定）', () => {
    expect(canSubmitTaskForm(F({ title: '   ' }), false)).toBe(false)
  })

  it('填了标题 → 可提交；busy 提交中 → 锁定防重复', () => {
    const filled = F({ title: '帮我标 10 条数据' })
    expect(canSubmitTaskForm(filled, false)).toBe(true)
    expect(canSubmitTaskForm(filled, true)).toBe(false)
  })

  it('提交参数：全字段 trim + days 字符串解析为天数', () => {
    expect(taskShareSubmitArgs(F({ title: '  标题 ', desc: ' 介绍 ', req: ' 要求 ', reward: ' 奖励 ', days: '3' })))
      .toEqual({ title: '标题', desc: '介绍', requirements: '要求', reward: '奖励', expiresDays: 3 })
  })

  it('days 空/非法 → 0（长期有效，与 chat-store shareTask 的 expiresDays>0 才生效对齐）', () => {
    expect(taskShareSubmitArgs(F({ title: 't', days: '' })).expiresDays).toBe(0)
    expect(taskShareSubmitArgs(F({ title: 't', days: 'abc' })).expiresDays).toBe(0)
  })
})
