/**
 * taskShareForm — 「新建任务卡」表单状态机（纯函数，零依赖）。
 *
 * 2026-09-29 提交断头路根修的配套：ShareSheet 的提交按钮从 200px 嵌套滚动区
 * 拿出来钉在 sheet 底栏（恒可见），可提交判定 / 提交参数构造收敛到这里——
 * FriendsPanel 渲染用它，单测（taskShareForm.test.ts）直接验状态机：
 * 填写 → 可提交 → 提交动作的参数落位（与 chat-store shareTask 的 card 对齐）。
 */

/** 表单字段（ShareSheet 受控 state 的直传快照；days 是 select 的字符串值）。 */
export interface TaskShareFormFields {
  title: string
  desc: string
  req: string
  reward: string
  days: string
}

/** 提交动作传给 shareTask 的卡参数（字段名对齐 chat-store.shareTask 的 card）。 */
export interface TaskShareCard {
  title: string
  desc: string
  requirements: string
  reward: string
  expiresDays: number
}

/** 可提交判定：标题非空（唯一必填项）且不在提交中。 */
export function canSubmitTaskForm(f: TaskShareFormFields, busy: boolean): boolean {
  return !busy && !!f.title.trim()
}

/** 提交参数：全字段 trim；days 解析为天数（空/非法 → 0 = 长期有效）。 */
export function taskShareSubmitArgs(f: TaskShareFormFields): TaskShareCard {
  return {
    title: f.title.trim(),
    desc: f.desc.trim(),
    requirements: f.req.trim(),
    reward: f.reward.trim(),
    expiresDays: Number(f.days) || 0,
  }
}
