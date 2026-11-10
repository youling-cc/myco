import { describe, expect, it } from 'vitest'
import { isGroupedWith } from './MessageBubble'
// stripMechanismTail 不在导出里——从正文管道验证:在 stripUserTail 导出后测
import { stripUserTail } from './MessageBubble'
// 批四：authorChip 空串回落 / 头像散列取色 / 破图兜底判定
import { resolveAuthorName, avatarColorOf, imageBroken, AVATAR_PALETTE } from './MessageBubble'
// 批五：isSelfMsg（自己气泡靠右数据源）
import { isSelfMsg } from './MessageBubble'

const T = (s: string) => new Date(`2026-08-28T${s}`).toISOString()

describe('isGroupedWith 群聊署名聚合', () => {
  it('连续同人同 AI(<5min)→ 聚合', () => {
    const a = { role: 'assistant', text: 'a', timestamp: T('10:00:00') }
    const b = { role: 'assistant', text: 'b', timestamp: T('10:02:00') }
    expect(isGroupedWith(a, b)).toBe(true)
  })

  it('间隔超 5min → 不聚合(重新署名)', () => {
    const a = { role: 'assistant', text: 'a', timestamp: T('10:00:00') }
    const b = { role: 'assistant', text: 'b', timestamp: T('10:06:00') }
    expect(isGroupedWith(a, b)).toBe(false)
  })

  it('不同发言人 → 不聚合', () => {
    const u = { role: 'user', text: 'hi', timestamp: T('10:00:00'), author: 'CJ26' }
    const a = { role: 'assistant', text: 'a', timestamp: T('10:00:30') }
    expect(isGroupedWith(u, a)).toBe(false)
    const other = { role: 'user', text: 'x', timestamp: T('10:00:30'), author: 'test-scratch 的 AI' }
    expect(isGroupedWith(u, other)).toBe(false) // CJ26 vs test-scratch 的 AI
  })

  it('同 author 的连续他人消息 → 聚合', () => {
    const a = { role: 'user', text: 'x', timestamp: T('10:00:00'), author: 'test-scratch 的 AI' }
    const b = { role: 'user', text: 'y', timestamp: T('10:01:00'), author: 'test-scratch 的 AI' }
    expect(isGroupedWith(a, b)).toBe(true)
  })

  it('无 prev / 无时间戳 → 不聚合(保守)', () => {
    expect(isGroupedWith(null, { role: 'assistant', text: 'a' })).toBe(false)
    expect(isGroupedWith({ role: 'assistant', text: 'a' }, { role: 'assistant', text: 'b', timestamp: T('10:00:00') })).toBe(false)
  })
})


describe('stripUserTail 机制后缀剥除', () => {
  it('尾部转达指令括号剥掉,正文保留', () => {
    expect(stripUserTail('帮我问问 AR 那边的 AI,最近在忙啥?(转达方式:单独一行 @AR: 问题)'))
      .toBe('帮我问问 AR 那边的 AI,最近在忙啥?')
    expect(stripUserTail('问它一句。(等它回复后会自动带回来)'))
      .toBe('问它一句。')
  })
  it('正文中间的机制词不动', () => {
    expect(stripUserTail('消息格式是「名字: 内容」,转达方要写明')).toBe('消息格式是「名字: 内容」,转达方要写明')
  })
  it('无机制后缀不动', () => {
    expect(stripUserTail('normal text')).toBe('normal text')
  })
})


describe('批四：resolveAuthorName 空串 author 回落（空"👤"胶囊根修）', () => {
  it('author=空串（toBubbleMsg 旧形态 self）→ 回落 ownAuthor', () => {
    expect(resolveAuthorName({ role: 'user', author: '' }, 'CJ26')).toBe('CJ26')
  })
  it('author=undefined（本机直输）→ ownAuthor；都无 → "我"', () => {
    expect(resolveAuthorName({ role: 'user' }, 'CJ26')).toBe('CJ26')
    expect(resolveAuthorName({ role: 'user' })).toBe('我')
    expect(resolveAuthorName({ role: 'user', author: '' })).toBe('我')
  })
  it('author 有值（他人消息）→ 原样；空白串也当空', () => {
    expect(resolveAuthorName({ role: 'user', author: '好友B' }, 'CJ26')).toBe('好友B')
    expect(resolveAuthorName({ role: 'user', author: '   ' }, 'CJ26')).toBe('CJ26')
  })
  it('assistant 消息恒空串（不走作者名——用模型角标）', () => {
    expect(resolveAuthorName({ role: 'assistant' }, 'CJ26')).toBe('')
  })
})

describe('批四：avatarColorOf 头像散列取色（列表/聊天/群管理三处同色）', () => {
  it('同名稳定同色；色板内取色；空名兜底不炸', () => {
    expect(avatarColorOf('好友B')).toBe(avatarColorOf('好友B'))
    expect(AVATAR_PALETTE).toContain(avatarColorOf('好友B'))
    expect(AVATAR_PALETTE).toContain(avatarColorOf(''))
    expect(AVATAR_PALETTE).toContain(avatarColorOf('CJ26 的 AI')) // 「的 AI」后缀剥除后取色
    expect(avatarColorOf('CJ26 的 AI')).toBe(avatarColorOf('CJ26'))
  })
  it('不同名大概率不同色（色板 8 色，至少两个常见名不同）', () => {
    const colors = new Set(['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'].map(avatarColorOf))
    expect(colors.size).toBeGreaterThan(1)
  })
})

describe('批四：imageBroken 破图兜底判定（媒体被清不再永远转 🖼）', () => {
  it('ref=空串（媒体键已被 FIFO 清理）且无 previewDataUrl → 破图', () => {
    expect(imageBroken({ kind: 'image', ref: '' }, '', false)).toBe(true)
  })
  it('fetchAsset 拉取失败 → 破图', () => {
    expect(imageBroken({ kind: 'image', ref: 'a.png' }, '', true)).toBe(true)
  })
  it('有 src（已加载/dataURL 直出）→ 不破图；拉取中（有途径未失败）→ loading 不破图', () => {
    expect(imageBroken({ kind: 'image', ref: '' }, 'data:image/png;base64,x', false)).toBe(false)
    expect(imageBroken({ kind: 'image', ref: 'a.png' }, '', false)).toBe(false) // fetchAsset 途中
  })
  it('非图片附件永不破图（文件走 attach-file 行）', () => {
    expect(imageBroken({ kind: 'file', ref: '' }, '', true)).toBe(false)
  })
})

describe('批五：isSelfMsg 自己消息判定（气泡靠右/靠左数据源）', () => {
  it('user 无 author（本机直发/toBubbleMsg self 形态）→ 自己（靠右）', () => {
    expect(isSelfMsg({ role: 'user' }, 'CJ26')).toBe(true)
    expect(isSelfMsg({ role: 'user', author: '' }, 'CJ26')).toBe(true) // 空串非 nullish 旧坑
    expect(isSelfMsg({ role: 'user', author: '   ' }, 'CJ26')).toBe(true) // 空白串也当自己
  })
  it('author===自己账号名 → 自己（本机输入带名形态）', () => {
    expect(isSelfMsg({ role: 'user', author: 'CJ26' }, 'CJ26')).toBe(true)
  })
  it('author=他人名 → 不是自己（靠左+琥珀 chip）', () => {
    expect(isSelfMsg({ role: 'user', author: '好友B' }, 'CJ26')).toBe(false)
    expect(isSelfMsg({ role: 'user', author: '好友B 的 AI' }, 'CJ26')).toBe(false)
  })
  it('assistant 永不是自己（AI 靠左）', () => {
    expect(isSelfMsg({ role: 'assistant' }, 'CJ26')).toBe(false)
    expect(isSelfMsg({ role: 'assistant', author: 'CJ26' }, 'CJ26')).toBe(false)
  })
  it('ownAuthor 缺省时 author 有值 → 非自己（保守不误判）', () => {
    expect(isSelfMsg({ role: 'user', author: 'CJ26' }, undefined)).toBe(false)
    expect(isSelfMsg({ role: 'user' }, undefined)).toBe(true) // 无 author 仍是自己
  })
})
