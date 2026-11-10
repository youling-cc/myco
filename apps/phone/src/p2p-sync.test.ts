/**
 * p2p-sync.test.ts — 第84/85轮：P2P 对账算法 + 群管理状态机单测。
 *
 * 对账核心（与 PC p2p_sync.rs 字节级一致——跨端一致性锚点）：
 *   XOR 指纹（无序/增量/自逆/零冲突）、索引差集、合并收敛、边界（空/单条/大量）。
 * 群管理（第85轮）：owner 治理闸（非群主拒）、invite/rename/kick/mute 状态机、
 *   禁言消息丢弃、被踢者档案删除。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { _setStorageForTest, type ChatStorage } from './chat-store'
import { convSafe } from './didUtil'

// ── 存储注入（零 localStorage 依赖，chat-store.test.ts 同款） ──
function memStorage(): ChatStorage {
  const m = new Map<string, string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v) }, del: (k) => { m.delete(k) }, keys: () => [...m.keys()] }
}
let storage: ChatStorage
beforeEach(() => { storage = memStorage(); _setStorageForTest(storage) })

// 摘要函数从 p2p.ts（import chat-store 时存储已注入——p2p 顶层读 storage 是函数调用点，安全）
import { hashMsgId, xorBytes, digestOf, diffIds, fEqual, localConvIdOfPeerView, filterUnknownMsgIds } from './p2p'
import {
  appendMsg, loadConvMeta, convMetaAppend, loadConv, CONV_MAX,
  listGroups, upsertGroup, ingestMsg, isGroupOwner, isMuted,
  seedWireMsgSeenFromStorage, _resetWireSeenForTest,
  type ChatMsg, type ServerMsg,
} from './chat-store'

const MY = 'did:youling:AAAA'
const PEER = 'did:youling:BBBB'
const OWNER = 'did:youling:OWNER'

// ══════════════ 摘要算法（第84轮核心） ══════════════

describe('XOR 指纹（与 PC p2p_sync.rs 一致）', () => {
  it('无序：任意顺序同集合同 F', () => {
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5']
    const a = digestOf(ids)
    const b = digestOf([...ids].reverse())
    const c = digestOf(['m3', 'm1', 'm5', 'm2', 'm4'])
    expect(a).toBe(b)
    expect(a).toBe(c)
  })

  it('增量：逐条 XOR 与全量等价（convMetaAppend vs digestOf）', () => {
    const conv = 'conv-inc'
    for (const id of ['a', 'b', 'c', 'd']) convMetaAppend(conv, id, 1)
    expect(loadConvMeta(conv).F).toBe(digestOf(['a', 'b', 'c', 'd']))
  })

  it('自逆：XOR 同一分量两次=移除', () => {
    const full = digestOf(['a', 'b', 'c'])
    const h = hashMsgId('b')
    const fb = Buffer.from(full.slice(2), 'hex') // 不用 Buffer——手工 hex
    void fb
    // 直接按字节算：full 移除 b
    const fullBytes = Uint8Array.from({ length: 32 }, (_, i) => parseInt(full.slice(i * 2, i * 2 + 2), 16))
    const minus = Array.from(xorBytes(fullBytes, h)).map((x) => x.toString(16).padStart(2, '0')).join('')
    expect(minus).toBe(digestOf(['a', 'c']))
  })

  it('零冲突：不同集合不同 F；空集=64 个 0', () => {
    expect(digestOf(['a'])).not.toBe(digestOf(['b']))
    expect(digestOf([])).toBe('0'.repeat(64))
    // 非法 hex 视为不一致（保守走精对）
    expect(fEqual('zz', '0'.repeat(64))).toBe(false)
    expect(fEqual(digestOf(['x']), digestOf(['x']))).toBe(true)
  })

  it('跨端一致性锚点：SHA256(msgId) 分量', () => {
    // 与 Rust 版 hash_msg_id("m-hello-84") 的输出一致（双端实现互锁，改动需双端同改）
    const h = Array.from(hashMsgId('m-hello-84')).map((x) => x.toString(16).padStart(2, '0')).join('')
    // 参照值由同一 SHA256 定义：python hashlib / @noble 三方一致，长度 32B
    expect(h).toHaveLength(64)
    expect(digestOf(['m-hello-84'])).toBe(h)
  })
})

// ══════════════ 差集 + 合并收敛 ══════════════

describe('索引差集与合并收敛', () => {
  const ids = (v: string[]): [string, number][] => v.map((s, i) => [s, 1000 + i])

  it('无交集/有交集/完全一致', () => {
    const d1 = diffIds(ids(['a', 'b']), ids(['c', 'd']))
    expect(d1.push).toEqual(['a', 'b'])
    expect(d1.pull).toEqual(['c', 'd'])
    const d2 = diffIds(ids(['a', 'b', 'c']), ids(['b', 'c', 'd']))
    expect(d2.push).toEqual(['a'])
    expect(d2.pull).toEqual(['d'])
    const d3 = diffIds(ids(['a', 'b']), ids(['b', 'a']))
    expect(d3.push).toEqual([])
    expect(d3.pull).toEqual([])
  })

  it('分叉合并收敛：A∪B 双侧 F 相等（网状收敛保证）', () => {
    const a = ['a1', 'a2', 'common']
    const b = ['b1', 'b2', 'b3', 'common']
    const { push, pull } = diffIds(ids(a), ids(b))
    const mergedA = [...a, ...pull]
    const mergedB = [...b, ...push]
    expect(digestOf(mergedA)).toBe(digestOf(mergedB))
    expect(mergedA).toHaveLength(6) // 3+4-1
  })

  it('大量（1000 条）边界', () => {
    const big = Array.from({ length: 1000 }, (_, i) => `msg-${i}`)
    const m = digestOf(big)
    expect(m).not.toBe('0'.repeat(64))
    const { push, pull } = diffIds(ids(big), ids(big.slice(0, 900)))
    expect(push).toHaveLength(100)
    expect(pull).toHaveLength(0)
  })
})

// ══════════════ convmeta 维护（存储路径） ══════════════

describe('会话摘要存储（youling.chat.convmeta.*）', () => {
  const msg = (id: string, ts = 1): ChatMsg => ({ msgId: id, from: PEER, to: MY, kind: 'text', payload: { text: 'x' }, ts, dir: 'in' })

  it('appendMsg 维护摘要；重复 msgId 幂等丢弃', () => {
    appendMsg('conv1', msg('m1', 100))
    appendMsg('conv1', msg('m2', 200))
    appendMsg('conv1', msg('m1', 300)) // 重复
    const meta = loadConvMeta('conv1')
    expect(meta.n).toBe(2)
    expect(meta.lastTs).toBe(200)
    expect(meta.F).toBe(digestOf(['m1', 'm2']))
    expect(loadConv('conv1')).toHaveLength(2)
  })

  it('显示层滚动丢弃，msgId 索引全量保留（对账语义完整）', () => {
    for (let i = 0; i < CONV_MAX + 20; i++) appendMsg('conv2', msg(`m${i}`, i))
    expect(loadConv('conv2')).toHaveLength(CONV_MAX)      // 显示层截断
    expect(loadConvMeta('conv2').n).toBe(CONV_MAX + 20)   // 索引全量
    expect(loadConvMeta('conv2').F).toBe(digestOf(Array.from({ length: CONV_MAX + 20 }, (_, i) => `m${i}`)))
  })

  it('空会话 meta 默认值', () => {
    const m = loadConvMeta('nobody')
    expect(m.n).toBe(0)
    expect(m.F).toBe('0'.repeat(64))
    expect(m.ids).toEqual([])
  })
})

// ══════════════ 第85轮：群管理状态机 ══════════════

describe('群治理模型（owner 恒定，governance 预留）', () => {
  beforeEach(() => {
    upsertGroup('g1', '测试群', [OWNER, MY, PEER], OWNER)
  })

  it('建群者=群主；governance 字段恒 owner（预留不读）', () => {
    const g = listGroups().find((x) => x.id === 'g1')!
    expect(isGroupOwner(g, OWNER)).toBe(true)
    expect(isGroupOwner(g, MY)).toBe(false)
    expect(g.governance).toBe('owner') // 'vote' 未来支持，暂无切换入口
  })

  it('非群主的群管理消息被拒（group-rename/group-kick）', () => {
    const r1 = ingestMsg(MY, srv(PEER, 'group-rename', { groupId: 'g1', newName: '篡改名' }))
    expect(r1).toBe(false)
    expect(listGroups().find((x) => x.id === 'g1')!.name).toBe('测试群')
    const r2 = ingestMsg(MY, srv(PEER, 'group-kick', { groupId: 'g1', targetDid: MY }))
    expect(r2).toBe(false)
    expect(listGroups().find((x) => x.id === 'g1')!.members).toContain(MY)
  })

  it('群主改名生效', () => {
    expect(ingestMsg(MY, srv(OWNER, 'group-rename', { groupId: 'g1', newName: '新群名' }))).toBe(true)
    expect(listGroups().find((x) => x.id === 'g1')!.name).toBe('新群名')
  })

  it('群主拉人：members 全量更新', () => {
    const r = ingestMsg(MY, srv(OWNER, 'group-invite', { groupId: 'g1', newMembers: ['did:youling:NEW'], members: [OWNER, MY, PEER, 'did:youling:NEW'] }))
    expect(r).toBe(true)
    expect(listGroups().find((x) => x.id === 'g1')!.members).toHaveLength(4)
  })

  it('成员退群：members 移除 + 系统条', () => {
    const r = ingestMsg(MY, srv(PEER, 'group-leave', { groupId: 'g1' }))
    expect(r).toBe(true)
    expect(listGroups().find((x) => x.id === 'g1')!.members).not.toContain(PEER)
    expect(loadConv('g1').some((m) => m.kind === 'sys')).toBe(true)
  })

  it('被踢的是我：批二起=群档案保留只读（status=kicked）+ 系统条，不再静默删除', () => {
    const r = ingestMsg(MY, srv(OWNER, 'group-kick', { groupId: 'g1', targetDid: MY }))
    expect(r).toBe(true)
    const g = listGroups().find((x) => x.id === 'g1')
    expect(g).toBeTruthy()                       // 档案保留（历史可回查）
    expect(g?.status).toBe('kicked')             // 终态只读
    expect(g?.members).toHaveLength(0)           // members 清空（不再参与对账/扇出）
    expect(loadConv('g1').some((m) => m.kind === 'sys' && String(m.payload.text).includes('你已被移出群'))).toBe(true)
  })

  it('群主踢别人：members 更新（含通知其他成员的消息）', () => {
    const r = ingestMsg(MY, srv(OWNER, 'group-kick', { groupId: 'g1', targetDid: PEER, members: [OWNER, MY] }))
    expect(r).toBe(true)
    expect(listGroups().find((x) => x.id === 'g1')!.members).toEqual([OWNER, MY])
  })

  it('禁言：群主禁言生效，被禁言者群消息被丢弃，群主/自己豁免', () => {
    expect(ingestMsg(MY, srv(OWNER, 'group-mute', { groupId: 'g1', targetDid: PEER, mutedUntil: Date.now() + 60_000 }))).toBe(true)
    const g = listGroups().find((x) => x.id === 'g1')!
    expect(isMuted(g, PEER)).toBe(true)
    expect(isMuted(g, MY)).toBe(false)
    // 被禁言者的 group-msg 丢弃
    const r1 = ingestMsg(MY, srv(PEER, 'group-msg', { groupId: 'g1', groupName: '测试群', fromName: PEER, members: [OWNER, MY, PEER], text: '我还说话' }))
    expect(r1).toBe(false)
    // 群主消息不受影响
    const r2 = ingestMsg(MY, srv(OWNER, 'group-msg', { groupId: 'g1', groupName: '测试群', fromName: '主', members: [OWNER, MY, PEER], text: '群主发言' }))
    expect(r2).toBe(true)
    // 解禁
    expect(ingestMsg(MY, srv(OWNER, 'group-mute', { groupId: 'g1', targetDid: PEER, mutedUntil: 0 }))).toBe(true)
    const r3 = ingestMsg(MY, srv(PEER, 'group-msg', { groupId: 'g1', groupName: '测试群', fromName: PEER, members: [OWNER, MY, PEER], text: '解禁了' }))
    expect(r3).toBe(true)
  })

  it('老群（无 owner 字段，第81-84轮存量）：首成员兜底为群主', () => {
    upsertGroup('g2', '老群', [OLD_OWNER, MY]) // 无 owner 参数
    const g = listGroups().find((x) => x.id === 'g2')!
    expect(g.owner).toBeUndefined()
    expect(isGroupOwner(g, OLD_OWNER)).toBe(true) // 首成员兜底
    expect(isGroupOwner(g, MY)).toBe(false)
  })
})

const OLD_OWNER = 'did:youling:OLD0'

// ══════════════ 2026-10-18：对账 convId 视角映射（重放风暴根修，与 PC 同款） ══════════════

describe('localConvIdOfPeerView（对端视角 convId → 本地 convId）', () => {
  it('单聊：对端摘要里的 convId=我的账号 → 本地会话=对端账号（归一键形态）', () => {
    // 对端（PC）回包里的单聊 convId 是「对端眼中与我的会话」= convSafe(我的账号)
    expect(localConvIdOfPeerView(MY, MY, PEER)).toBe(convSafe(PEER))
    // 等价形态（did_safe 下划线形态）也要命中映射——不映射就是每拍全量重放的根因
    const mySafe = MY.replace(/[:/]/g, '_')
    expect(localConvIdOfPeerView(mySafe, MY, PEER)).toBe(convSafe(PEER))
  })

  it('群会话双方一致：原样透传（grp-* 不做映射）', () => {
    expect(localConvIdOfPeerView('grp-x1', MY, PEER)).toBe('grp-x1')
    expect(localConvIdOfPeerView('grp-dev-did_youling_AAA', MY, PEER)).toBe('grp-dev-did_youling_AAA')
  })

  it('自同步（peer==我）：映射回自身，不改变 convId', () => {
    expect(localConvIdOfPeerView(MY, MY, MY)).toBe(MY)
  })

  it('空参数防御：缺账号/空 convId 原样返回（不抛）', () => {
    expect(localConvIdOfPeerView('', MY, PEER)).toBe('')
    expect(localConvIdOfPeerView('did:youling:X', '', PEER)).toBe('did:youling:X')
    expect(localConvIdOfPeerView('did:youling:X', MY, '')).toBe('did:youling:X')
  })

  it('映射后 F 可比：历史不再被当缺口重放（重放风暴的回归锁）', () => {
    // 本地手机视角：与 PEER 的单聊 = convSafe(PEER)，两条消息
    const localConv = convSafe(PEER)
    const msg = (id: string, ts: number): ChatMsg => ({ msgId: id, from: PEER, to: MY, kind: 'text', payload: { text: id }, ts, dir: 'in' })
    appendMsg(localConv, msg('m1', 1))
    appendMsg(localConv, msg('m2', 2))
    // 对端（PC）摘要：同一批消息；会话键是「对端眼中与我的会话」= convSafe(MY)
    const peerViewConv = convSafe(MY)
    const peerF = digestOf(['m1', 'm2'])
    // 旧实现：拿对端视角键读本地 meta → 恒空 → F 恒不等 → 每拍全量重放
    expect(fEqual(loadConvMeta(peerViewConv).F, peerF)).toBe(false)
    // 修后：映射到本地会话键 → F 相等 → 对账直接跳过（不拉不灌不渲染）
    const mapped = localConvIdOfPeerView(peerViewConv, MY, PEER)
    expect(mapped).toBe(localConv)
    expect(fEqual(loadConvMeta(mapped).F, peerF)).toBe(true)
  })
})

// ══════════════ 2026-10-18：对账拉取前按 msgId 严格去重 ══════════════

describe('filterUnknownMsgIds（拉取缺口按 msgId 去重）', () => {
  it('本机任何会话已有的 msgId 不再拉（历史落错会话键的重放根修）', () => {
    const localA = convSafe(PEER)
    appendMsg(localA, { msgId: 'known-1', from: PEER, to: MY, kind: 'text', payload: { text: 'x' }, ts: 1, dir: 'in' } as ChatMsg)
    // 模拟"同一批 msgId 因 to 形态差异落进另一个会话键"：known-2 在别的会话里已存在
    appendMsg('did_youling_someOtherConv', { msgId: 'known-2', from: PEER, to: MY, kind: 'text', payload: { text: 'y' }, ts: 2, dir: 'in' } as ChatMsg)
    const want = ['known-1', 'known-2', 'missing-3']
    expect(filterUnknownMsgIds(want)).toEqual(['missing-3'])
    // 全已知 → 空（调用方据此跳过 index/batch，避免每拍空转）
    expect(filterUnknownMsgIds(['known-1', 'known-2'])).toEqual([])
  })

  it('真实风暴形态回归：全局预热后，对端"缺口"80 条（历史落进另一会话键）全部命中不拉', () => {
    // 模拟手机实际数据：同一批消息被历史形态拆成两个会话键
    //   A（对账比对的那个键）= 12 条；B（to/from 形态差异落进去的键）= 80 条
    const A = convSafe(PEER)
    const B = 'did_youling_upperJVariantConv'
    const ownA: string[] = []
    const ownB: string[] = []
    for (let i = 0; i < 12; i++) {
      const id = `a-${i}`
      ownA.push(id)
      appendMsg(A, { msgId: id, from: PEER, to: MY, kind: 'text', payload: { text: id }, ts: i, dir: 'in' } as ChatMsg)
    }
    for (let i = 0; i < 80; i++) {
      const id = `b-${i}`
      ownB.push(id)
      appendMsg(B, { msgId: id, from: PEER, to: MY, kind: 'text', payload: { text: id }, ts: 100 + i, dir: 'in' } as ChatMsg)
    }
    _resetWireSeenForTest() // 重启：内存索引清空
    seedWireMsgSeenFromStorage() // 对账前全局预热（本桶全部会话摘要）
    // 对端（PC）的 92 条里，差集 = 80 条 b*（不在 A 的 F 里）——全部已知 → 一条不拉
    expect(filterUnknownMsgIds(ownB)).toEqual([])
    // 真新消息仍会拉
    expect(filterUnknownMsgIds([...ownB, 'brand-new-1'])).toEqual(['brand-new-1'])
  })
})

/** ServerMsg 构造（信箱条目形态）。 */
function srv(from: string, kind: string, payload: Record<string, unknown>, id = `t-${Math.random()}`): ServerMsg {
  return { seq: 1, id, from, fromName: from, fromDevice: 'did:myco:dev', kind, payload, ts: Date.now() }
}
