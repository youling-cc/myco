// toBubbleMsg.test.ts — 批五（2026-09-29 用户实测「气泡署名昵称没显示全」）：
// 好友聊天气泡署名取值立法——好友昵称 > fromName > …尾4（dispNameOf 全优先级），
// fromName 缺失/脏 did 时不再塌缩成「…尾4」。
import { describe, expect, it, beforeEach } from 'vitest'
import { toBubbleMsg } from './FriendsPanel'
import { _setStorageForTest, upsertFriend, type ChatMsg, type ChatStorage } from '../chat-store'

const MY = 'did:youling:AAA'
const PEER = 'did:youling:BBB'

function memStorage(): ChatStorage {
  const m = new Map<string, string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v) }, del: (k) => { m.delete(k) } }
}
beforeEach(() => { _setStorageForTest(memStorage()) })

const M = (over: Partial<ChatMsg> = {}): ChatMsg => ({
  msgId: 'm1', from: PEER, to: MY, kind: 'text', payload: { text: '你好' },
  ts: Date.now(), dir: 'in', ...over,
})

describe('批五：toBubbleMsg 气泡署名取值（好友昵称 > fromName > …尾4）', () => {
  it('好友列表命中 → 署名用本地好友昵称（fromName 缺失也显示全名）', () => {
    upsertFriend(PEER, '小明', 'ok')
    const cm = toBubbleMsg(M(), null) // fromName 未带
    expect(cm?.author).toBe('小明')
  })

  it('好友昵称优先于 fromName（本地改名后署名跟着本地）', () => {
    upsertFriend(PEER, '小明', 'ok')
    const cm = toBubbleMsg(M({ fromName: '对方自称的长名字' }), null)
    expect(cm?.author).toBe('小明')
  })

  it('非好友 → 用 fromName（群聊陌生成员）', () => {
    const cm = toBubbleMsg(M({ fromName: '群友甲' }), null)
    expect(cm?.author).toBe('群友甲')
  })

  it('非好友且 fromName 是脏 did → …尾4（不显示全称 did）', () => {
    const cm = toBubbleMsg(M({ fromName: 'did:youling:ZZZZ1234' }), null)
    expect(cm?.author).toBe('…1234')
  })

  it('非好友且无 fromName → …尾4 兜底（不炸）', () => {
    const cm = toBubbleMsg(M({ from: 'did:youling:Q9X2K7AB' }), null)
    expect(cm?.author).toBe('…K7AB')
  })

  it('自己发的（dir=out）→ author 留空（resolveAuthorName 统一回落 ownAuthor/我）', () => {
    const cm = toBubbleMsg(M({ dir: 'out', from: MY }), null)
    expect(cm?.author).toBeUndefined()
  })

  it('特殊形态（task-share/sys/file）→ null（外层自渲染）', () => {
    expect(toBubbleMsg(M({ kind: 'task-share' }), null)).toBeNull()
    expect(toBubbleMsg(M({ kind: 'sys' }), null)).toBeNull()
    expect(toBubbleMsg(M({ kind: 'file' }), null)).toBeNull()
  })
})

describe('设备群署名（2026-10-07 决策 D.3，对等 PC bubbleSenderName）：fromDevice 优先', () => {
  it('他机 in 行带 fromDeviceName → 署名=设备名（优先于账号名 fromName）', () => {
    const cm = toBubbleMsg(M({ from: MY, fromName: '测试账号', fromDevice: 'did:myco:B', fromDeviceName: '员工1-PC' }), null)
    expect(cm?.author).toBe('员工1-PC')
  })
  it('fromDeviceName 是脏全称 did → 压 …尾4（护栏沿用）', () => {
    const cm = toBubbleMsg(M({ from: MY, fromDevice: 'did:myco:ZZ99', fromDeviceName: 'did:myco:ZZ99' }), null)
    expect(cm?.author).toBe('…ZZ99')
  })
  it('fromDevice 在但 fromDeviceName 缺 → …设备尾4（不显示账号名——同账号多设备语义）', () => {
    const cm = toBubbleMsg(M({ from: MY, fromName: '测试账号', fromDevice: 'did:myco:K7AB' }), null)
    expect(cm?.author).toBe('…K7AB')
  })
  it('无 fromDevice（普通群/单聊）→ 好友昵称 > fromName 既有行为不变', () => {
    upsertFriend(PEER, '小明', 'ok')
    expect(toBubbleMsg(M({ from: PEER, fromName: 'x' }), null)?.author).toBe('小明')
    expect(toBubbleMsg(M({ from: MY, fromName: '测试账号' }), null)?.author).toBe('测试账号')
  })
  it('本机设备消息（dir=out，ingest 已按 fromDevice 判向）→ author 留空=「我」', () => {
    const cm = toBubbleMsg(M({ dir: 'out', from: MY, fromDevice: 'did:myco:ME', fromDeviceName: 'myco-phone' }), null)
    expect(cm?.author).toBeUndefined()
  })
})
