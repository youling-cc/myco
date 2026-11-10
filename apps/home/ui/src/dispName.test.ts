import { describe, expect, it } from 'vitest'
import { dispNameOf, shortDid, tail4Of } from './ChatBubble'

/* 2026-09-29 用户实测反馈立法：聊天页任何位置不显示全称 did（did:youling:... 58 字符）。
 * 取值优先级：好友昵称 > 名称字段（会话 title/群名）> …尾4。
 * 与 apps/phone/src/components/FriendsPanel.tsx 同构（两端一致惯例）。 */

const DID = 'did:youling:6Dr5Wq3zCn8VxKm2LpQvJtYb4Hf7Rs9Tn1AdEwUkXiZoBgCyF'
const FRIENDS = [
  { did: DID, name: '小明' },
  { did: 'did:youling:AAAA', name: '' }, // 昵称为空的好友
  { did: 'did:youling:BBBB', name: 'did:youling:BBBBCCCCDDDD' }, // 昵称本身是全称 did（对端脏数据）
]

describe('dispNameOf did→显示名取值优先级', () => {
  it('好友命中 → 昵称优先（高于 fallback）', () => {
    expect(dispNameOf(DID, FRIENDS, '随便什么名称')).toBe('小明')
  })

  it('convId 下划线形式（did_safe）也能命中好友', () => {
    expect(dispNameOf(DID.replace(/:/g, '_'), FRIENDS, '别的')).toBe('小明')
  })

  it('非好友（群聊/陌生人）→ 用名称字段（群名）', () => {
    expect(dispNameOf('did:youling:ZZZZ', FRIENDS, '家人群')).toBe('家人群')
  })

  it('昵称为空 → 退到名称字段', () => {
    expect(dispNameOf('did:youling:AAAA', FRIENDS, '会话标题')).toBe('会话标题')
  })

  it('昵称与名称都没有 → …尾4 短 did', () => {
    expect(dispNameOf('did:youling:ZZZZ', FRIENDS)).toBe('…ZZZZ')
    expect(dispNameOf('did:youling:ZZZZ', FRIENDS, '')).toBe('…ZZZZ')
  })

  it('昵称本身是全称 did（脏数据）→ 跳过取 fallback；fallback 也是 → 真实 did 的 …尾4', () => {
    expect(dispNameOf('did:youling:BBBB', FRIENDS, '群名')).toBe('群名')
    expect(dispNameOf('did:youling:BBBB', FRIENDS, 'did:youling:BBBB1234')).toBe('…BBBB')
  })

  it('空字符串 id → …（不炸）', () => {
    expect(dispNameOf('', FRIENDS)).toBe('…')
  })
})

describe('shortDid / tail4Of 护栏', () => {
  it('普通昵称原样返回', () => {
    expect(shortDid('小明')).toBe('小明')
    expect(shortDid('  家人群  ')).toBe('家人群')
  })

  it('全称 did 压成 …尾4', () => {
    expect(shortDid(DID)).toBe(`…${DID.slice(-4)}`)
    expect(tail4Of(DID)).toBe(`…${DID.slice(-4)}`)
  })

  it('空串：shortDid 原样（调用方兜底）、tail4Of 给 …', () => {
    expect(shortDid('')).toBe('')
    expect(tail4Of('')).toBe('…')
  })
})
