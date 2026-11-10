// chat-notify.test.ts — 批四：新消息通知静默判定（微信语义子集）。
import { describe, it, expect } from 'vitest'
import { shouldSilence } from './chat-notify'

describe('批四：shouldSilence 通知静默判定', () => {
  it('免打扰会话恒静默（前台/后台都不通）', () => {
    expect(shouldSilence('c1', true, null, false)).toBe(true)
    expect(shouldSilence('c1', true, 'c1', true)).toBe(true)
  })
  it('前台且正在聊该会话 → 静默（屏内消息自己看得见）', () => {
    expect(shouldSilence('c1', false, 'c1', true)).toBe(true)
  })
  it('前台但不在该会话（别的会话/列表页）→ 通知；后台（不可见）→ 通知', () => {
    expect(shouldSilence('c1', false, 'c2', true)).toBe(false)
    expect(shouldSilence('c1', false, null, true)).toBe(false)
    expect(shouldSilence('c1', false, 'c1', false)).toBe(false) // 后台就算开着该会话也通知
  })
})
