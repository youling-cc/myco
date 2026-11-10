// deviceGroup.test.ts — 设备群 UI 纯逻辑锚点测试（2026-10-07 设计 §3 决策F/D，
// docs/design/设备群设计.md）。Rust 命令（chat_device_group_info）未就绪期：
// 本文件按设计签名的返回形态构造 mock 数据测纯函数——命令合入后 UI 零改动。
import { describe, expect, it } from 'vitest'
import {
  buildTimeline, deviceGroupCounts, deviceGroupHeaderSub, deviceGroupRowSub,
  isDeviceGroup, seedDeviceGroupPins, showGroupManageEntry,
  type ConvPref, type ConvRow, type DeviceGroupInfo,
} from './chatOps'
import { bubbleSenderName, type ChatMsg } from './ChatBubble'

const T0 = new Date(2026, 9, 7, 12, 0, 0).getTime()
const M = (over: Partial<ChatMsg> = {}): ChatMsg => ({
  msgId: 'm1', from: 'did:youling:ROOT', to: 'grp-dev-x', kind: 'group-msg',
  payload: { text: 'hi' }, ts: T0, dir: 'in', ...over,
})
const C = (id: string, lastTs = 1): ConvRow => ({ id, kind: 'group', title: id, lastTs, lastText: '' })

describe('isDeviceGroup 设备群判定（档案 kind / grp-dev- 前缀双保险）', () => {
  it("kind='device' → true；id 前缀 grp-dev- → true（档案未同步兜底）", () => {
    expect(isDeviceGroup({ id: 'grp-1', kind: 'device' })).toBe(true)
    expect(isDeviceGroup({ id: 'grp-dev-did_youling_zABC' })).toBe(true)
  })
  it('普通群/单聊/null → false', () => {
    expect(isDeviceGroup({ id: 'grp-1' })).toBe(false)
    expect(isDeviceGroup({ id: 'did:youling:PEER' })).toBe(false)
    expect(isDeviceGroup(null)).toBe(false)
    expect(isDeviceGroup(undefined)).toBe(false)
  })
})

describe('deviceGroupCounts / 行副题 / 头部副题（chat_device_group_info mock 形态）', () => {
  // 设计 §3 决策F「新命令」返回形态：{ groupId, name, devices:[{did,name,online,revoked,isEmbodiment,lastSeen}] }
  const info: DeviceGroupInfo = {
    groupId: 'grp-dev-x', name: '设备群',
    devices: [
      { did: 'did:myco:A', name: 'jason-PC', online: true, isEmbodiment: true, lastSeen: 0 },
      { did: 'did:myco:B', name: '员工1-PC', online: false, lastSeen: 300 },
      { did: 'did:myco:C', name: '已吊销', online: true, revoked: true }, // 吊销=非成员（名册即成员表，决策C）
      { did: 'did:myco:D', name: 'jason-phone', online: true },
    ],
  }
  it('counts：吊销不计入总数；在线=未吊销且 online', () => {
    expect(deviceGroupCounts(info)).toEqual({ total: 3, online: 2 })
  })
  it('行副题「N 台设备」；名册不可用 → 「本账号设备」降级', () => {
    expect(deviceGroupRowSub(info)).toBe('3 台设备')
    expect(deviceGroupRowSub(null)).toBe('本账号设备')
    expect(deviceGroupRowSub({ groupId: 'grp-dev-x', devices: [] })).toBe('本账号设备')
  })
  it('头部副题「📱 设备群 · N 台设备 · M 在线」；降级仅「📱 设备群」', () => {
    expect(deviceGroupHeaderSub(info)).toBe('📱 设备群 · 3 台设备 · 2 在线')
    expect(deviceGroupHeaderSub(null)).toBe('📱 设备群')
  })
})

describe('showGroupManageEntry ⚙️ 群管理入口可见性', () => {
  it('普通群 → true；设备群（kind/前缀）→ false（系统群治理锁死，决策 D.4）', () => {
    expect(showGroupManageEntry({ id: 'grp-1' })).toBe(true)
    expect(showGroupManageEntry({ id: 'grp-1', kind: 'device' })).toBe(false)
    expect(showGroupManageEntry({ id: 'grp-dev-x' })).toBe(false)
  })
  it('终态群（disbanded/kicked）→ false（既有行为）；无档案 → false', () => {
    expect(showGroupManageEntry({ id: 'grp-1', status: 'disbanded' })).toBe(false)
    expect(showGroupManageEntry({ id: 'grp-1', status: 'kicked' })).toBe(false)
    expect(showGroupManageEntry(null)).toBe(false)
  })
})

describe('seedDeviceGroupPins 首见自动置顶种子（一次性，尊重用户）', () => {
  const groups = [{ id: 'grp-dev-x', kind: 'device' }, { id: 'grp-1' }]
  const convs = [C('grp-dev-x', 100), C('grp-1', 50)]
  it('首见（会话已出现且 prefs 无键）→ 写入 pin', () => {
    const r = seedDeviceGroupPins(convs, groups, {}, 1234)
    expect(r.changed).toBe(true)
    expect(r.next['grp-dev-x']).toEqual({ pin: 1234 })
    expect(r.next['grp-1']).toBeUndefined() // 普通群不种
  })
  it('键已存在（用户手动取消置顶后的 {pin:undefined}）→ 不再种（不复活）', () => {
    const prefs: Record<string, ConvPref> = { 'grp-dev-x': {} }
    const r = seedDeviceGroupPins(convs, groups, prefs, 9999)
    expect(r.changed).toBe(false)
    expect(r.next).toBe(prefs)
  })
  it('已种过（pin 有值）→ 幂等无改动', () => {
    const prefs: Record<string, ConvPref> = { 'grp-dev-x': { pin: 100 } }
    expect(seedDeviceGroupPins(convs, groups, prefs, 2000).changed).toBe(false)
  })
  it('会话列表还没出现（ensure 未落档）→ 不种，等下轮 poll', () => {
    const r = seedDeviceGroupPins([C('grp-1')], groups, {}, 1234)
    expect(r.changed).toBe(false)
  })
  it('键存在但只有 mute（用户设过免打扰、从未置顶）→ 同样不种（键在=已知会话）', () => {
    const prefs: Record<string, ConvPref> = { 'grp-dev-x': { mute: true } }
    const r = seedDeviceGroupPins(convs, groups, prefs, 1234)
    expect(r.changed).toBe(false)
    expect(r.next['grp-dev-x']).toEqual({ mute: true }) // 偏好原样保留
  })
})

describe('buildTimeline 设备署名归并（决策 D：同账号多设备 from 恒同）', () => {
  it('同账号不同设备（fromDevice 不同）→ 不归并（各自署名行）', () => {
    const items = buildTimeline([
      M({ msgId: 'a', fromDevice: 'did:myco:A', fromDeviceName: 'jason-PC', ts: T0 }),
      M({ msgId: 'b', fromDevice: 'did:myco:B', fromDeviceName: '员工1-PC', ts: T0 + 1000 }),
    ], { now: new Date(T0) })
    const msgs = items.filter((x) => x.t === 'msg')
    expect(msgs[0].merged).toBe(false)
    expect(msgs[1].merged).toBe(false) // 不同设备——签名行分开
  })
  it('同设备连续消息 → 归并（既有微信语义保留）', () => {
    const items = buildTimeline([
      M({ msgId: 'a', fromDevice: 'did:myco:A', ts: T0 }),
      M({ msgId: 'b', fromDevice: 'did:myco:A', ts: T0 + 1000 }),
    ], { now: new Date(T0) })
    const msgs = items.filter((x) => x.t === 'msg')
    expect(msgs[1].merged).toBe(true)
  })
  it('无 fromDevice 字段（普通群/单聊老数据）→ 归并行为不变', () => {
    const items = buildTimeline([
      M({ msgId: 'a', from: 'did:youling:PEER', to: 'did:youling:ME', fromName: '好友', ts: T0 }),
      M({ msgId: 'b', from: 'did:youling:PEER', to: 'did:youling:ME', fromName: '好友', ts: T0 + 1000 }),
    ], { now: new Date(T0) })
    const msgs = items.filter((x) => x.t === 'msg')
    expect(msgs[1].merged).toBe(true)
  })
})

describe('bubbleSenderName 设备群署名（决策 D.3：in 行按 fromDeviceName；本机=「我」）', () => {
  it('dir=out → 「我」（本机设备消息——Rust effective_dir 已判 out）', () => {
    expect(bubbleSenderName(M({ dir: 'out', fromDevice: 'did:myco:A', fromDeviceName: 'jason-PC' }))).toBe('我')
  })
  it('他机 in 行 → fromDeviceName 署名（优先于账号名 fromName）', () => {
    expect(bubbleSenderName(M({ dir: 'in', fromDevice: 'did:myco:B', fromDeviceName: '员工1-PC', fromName: 'jason' }))).toBe('员工1-PC')
  })
  it('fromDeviceName 是脏全称 did → 压 …尾4（护栏沿用）', () => {
    expect(bubbleSenderName(M({ dir: 'in', fromDeviceName: 'did:myco:ZZ99' }))).toBe('…ZZ99')
  })
  it('无 fromDeviceName（普通群/单聊）→ fromName 兜底，行为不变', () => {
    expect(bubbleSenderName(M({ dir: 'in', fromName: '好友B' }))).toBe('好友B')
    expect(bubbleSenderName(M({ dir: 'in' }))).toBe('…ROOT')
  })
})
