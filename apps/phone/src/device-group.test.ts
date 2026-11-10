// device-group.test.ts — 设备群手机端锚点测试（2026-10-07 设计 §3 决策A/B/C/D/F，
// docs/design/设备群设计.md；PC 对等=apps/home/ui/src/deviceGroup.test.ts）。
// 网络层（identity）mock、存储层注入——纯逻辑测试零 localStorage/fetch 依赖。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import bs58 from 'bs58'
import { didFromPubkey, didSafeId } from './didUtil'

// ── identity mock：账号 did 固定 + 本机设备 did 固定（ingest dir 判定的两要素） ──
const PUB = new Uint8Array(32).fill(0x5a)
const ROOT = didFromPubkey(PUB, 'youling') // canonical did:youling:z…
const ROOT_MYCO = didFromPubkey(PUB, 'myco') // 同钥匙的另一 canonical 前缀
const ROOT_LEGACY = `did:myco:${bs58.encode(PUB)}` // 已废止形态（仅作反例）
const MY_DEVICE = 'did:myco:MEDEV'
vi.mock('./identity', () => ({
  signalPost: async () => { throw new Error('network disabled in test') },
  getRootIdentity: () => ROOT,
  getAttestation: () => null,
  currentIdentity: () => ({ did: MY_DEVICE, keyB64: '' }),
  currentYoulingName: () => '测试账号',
}))

import {
  _setStorageForTest, type ChatStorage, type ServerMsg,
  listGroups, loadConv, convPref, setConvPinned, upsertGroup,
  deviceGroupId, isDeviceGroup, deviceGroupIngestDir, deviceGroupCountsOf, type RosterDevice,
  ensureDeviceGroup, seedDeviceGroupPin, ingestMsg,
  groupInvite, groupRename, groupLeave, groupKick, groupMute,
} from './chat-store'

const GID = `grp-dev-${didSafeId(ROOT)}`

function memStorage(): ChatStorage {
  const m = new Map<string, string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v) }, del: (k) => { m.delete(k) } }
}

beforeEach(() => { _setStorageForTest(memStorage()) })

let srvSeq = 0
const S = (over: Partial<ServerMsg> = {}): ServerMsg => ({
  seq: 1, id: `srv-${++srvSeq}`, from: ROOT, fromName: '测试账号', fromDevice: 'did:myco:OTHER',
  kind: 'group-msg', payload: {}, ts: Date.now(), ...over,
})

describe('deviceGroupId 确定性派生（canonical 归一，与 PC device_group_id 同式）', () => {
  it('同一把钥匙的 canonical 双前缀 → 同一群 id（grp-dev- 前缀）', () => {
    expect(deviceGroupId(ROOT)).toBe(GID)
    expect(deviceGroupId(ROOT_MYCO)).toBe(GID)
    expect(GID.startsWith('grp-dev-')).toBe(true)
    expect(GID.startsWith('grp-')).toBe(true) // 全库按 grp- 前缀判群的语义保住
  })

  // 2026-10-10 canonical-only：双前缀 canonical 全归一；legacy 裸 base58 已废止
  //（解不出公钥 → 不归一，原样落键；不得与真钥匙形态撞桶）。
  it('双前缀 canonical 全归一；legacy 裸 base58 已废止 → 不归一（各自成键，不撞真钥匙桶）', () => {
    const YOULING_LEGACY = `did:youling:${bs58.encode(PUB)}`
    expect(deviceGroupId(ROOT_MYCO)).toBe(GID)
    // legacy：不再解码 → 原样进 key（确定性），且与 canonical 桶不同
    expect(deviceGroupId(YOULING_LEGACY)).toBe(`grp-dev-${didSafeId(YOULING_LEGACY)}`)
    expect(deviceGroupId(ROOT_LEGACY)).toBe(`grp-dev-${didSafeId(ROOT_LEGACY)}`)
    expect(deviceGroupId(ROOT_LEGACY)).not.toBe(GID)
    expect(deviceGroupId(YOULING_LEGACY)).not.toBe(GID)
  })

  it('畸形输入不崩且确定性：软 did / 垃圾串 / 空串', () => {
    // 软 did（participant 段）解析不出公钥 → 原样落 key（不与任何真钥匙撞桶）
    const soft = 'did:myco:participant:foo'
    expect(deviceGroupId(soft)).toBe(`grp-dev-${didSafeId(soft)}`)
    expect(deviceGroupId('not-a-did')).toBe('grp-dev-not-a-did')
    // 幂等：同输入两次同输出；空串也不抛
    expect(deviceGroupId('not-a-did')).toBe(deviceGroupId('not-a-did'))
    expect(deviceGroupId('')).toBe('grp-dev-')
    // 畸形形态不得混进真钥匙的桶
    expect(deviceGroupId('not-a-did')).not.toBe(GID)
  })
})

describe('isDeviceGroup 判定', () => {
  it('kind / grp-dev- 前缀 / 普通群 / null', () => {
    expect(isDeviceGroup({ id: 'grp-1', kind: 'device' })).toBe(true)
    expect(isDeviceGroup({ id: 'grp-dev-x' })).toBe(true)
    expect(isDeviceGroup({ id: 'grp-1' })).toBe(false)
    expect(isDeviceGroup(null)).toBe(false)
  })
})

describe('deviceGroupIngestDir 方向判定（决策 D.1）', () => {
  it('本机设备（fromDevice==本机 did）→ out；他机 → in', () => {
    expect(deviceGroupIngestDir(true, MY_DEVICE, MY_DEVICE)).toBe('out')
    expect(deviceGroupIngestDir(true, MY_DEVICE, 'did:myco:OTHER')).toBe('in')
  })
  it('非设备群 / fromDevice 缺失 → in（保守：老端/信箱路径不把别人的当自己的）', () => {
    expect(deviceGroupIngestDir(false, MY_DEVICE, MY_DEVICE)).toBe('in')
    expect(deviceGroupIngestDir(true, MY_DEVICE, '')).toBe('in')
    expect(deviceGroupIngestDir(true, '', '')).toBe('in')
  })
})

describe('deviceGroupCountsOf 名册计数（决策 C：吊销=非成员）', () => {
  it('总/在线（吊销不计）；空名册', () => {
    const devs: RosterDevice[] = [
      { did: 'a', name: '主PC', online: true, isEmbodiment: true },
      { did: 'b', name: '员工PC', online: false },
      { did: 'c', name: '吊销机', online: true, revoked: true },
      { did: 'd', name: '手机', online: true },
    ]
    expect(deviceGroupCountsOf(devs)).toEqual({ total: 3, online: 2 })
    expect(deviceGroupCountsOf([])).toEqual({ total: 0, online: 0 })
  })
})

describe('ensureDeviceGroup 本地幂等建群（决策 B.3；localStorage groups 沿用现有 key）', () => {
  it('首次：建档（kind=device/members=[账号did]/owner/createdAt=0）+ 一条确定性 msgId 系统条', () => {
    const gid = ensureDeviceGroup()
    expect(gid).toBe(GID)
    const g = listGroups().find((x) => x.id === GID)
    expect(g).toMatchObject({ id: GID, name: '设备群', members: [ROOT], owner: ROOT, createdAt: 0, kind: 'device' })
    const conv = loadConv(GID)
    expect(conv).toHaveLength(1)
    expect(conv[0]).toMatchObject({ msgId: `devgrp-init-${GID}`, kind: 'sys', dir: 'in' })
  })
  it('幂等：再次调用不重复建群、不重复落系统条（对账幂等去重同源）', () => {
    ensureDeviceGroup()
    ensureDeviceGroup()
    expect(listGroups().filter((x) => x.id === GID)).toHaveLength(1)
    expect(loadConv(GID)).toHaveLength(1)
  })
  it('档案在但字段旧（自愈建群先到）→ 只校正 kind/name/members/owner，不落系统条', () => {
    // 模拟：群消息先于 ensure 到达 → upsertGroupSelfheal 建了普通群档案（无 kind）
    upsertGroup(GID, '测试群', ['did:youling:PEER'])
    ensureDeviceGroup()
    const g = listGroups().find((x) => x.id === GID)
    expect(g).toMatchObject({ kind: 'device', name: '设备群', owner: ROOT })
    expect(g?.members.some((m) => m === ROOT)).toBe(true)
    expect(loadConv(GID)).toHaveLength(0) // 已存在的档案不补系统条
  })
})

describe('seedDeviceGroupPin 首见置顶种子（一次性；用户可取消不复活）', () => {
  it('首次 → convprefs.pinned 种上（默认置顶）', () => {
    seedDeviceGroupPin()
    expect(!!convPref(GID).pinned).toBe(true)
  })
  it('用户取消置顶后再调 → 不复活（每账号桶标记位；手机取消置顶会删键，键存在性判不了种过）', () => {
    seedDeviceGroupPin()
    setConvPinned(GID, false)
    expect(!!convPref(GID).pinned).toBe(false)
    seedDeviceGroupPin()
    expect(!!convPref(GID).pinned).toBe(false)
  })
})

describe('ingest 设备群消息（决策 D.1/D.2：fromDevice 持久化 + dir 按 fromDevice）', () => {
  beforeEach(() => { ensureDeviceGroup() })
  const pay = (text: string) => ({ groupId: GID, groupName: '设备群', fromName: '测试账号', members: [ROOT], text })

  it('他机（同事设备）消息 → dir=in + fromDevice/fromDeviceName 落行', () => {
    ingestMsg(ROOT, S({ fromDevice: 'did:myco:OTHER', fromDeviceName: '员工1-PC', payload: pay('同事发的') }))
    const m = loadConv(GID).find((x) => x.kind === 'group-msg')
    expect(m?.dir).toBe('in')
    expect(m?.fromDevice).toBe('did:myco:OTHER')
    expect(m?.fromDeviceName).toBe('员工1-PC')
  })
  it('本机设备消息（fromDevice==本机 did，对账/多端回流）→ dir=out（归位右侧）', () => {
    ingestMsg(ROOT, S({ fromDevice: MY_DEVICE, fromDeviceName: 'myco-phone', payload: pay('我自己发的') }))
    const m = loadConv(GID).find((x) => x.kind === 'group-msg')
    expect(m?.dir).toBe('out')
  })
  it('fromDevice 缺失（老端/信箱路径）→ dir=in 保守 + 字段不落', () => {
    ingestMsg(ROOT, S({ fromDevice: '', payload: pay('老端') }))
    const m = loadConv(GID).find((x) => x.kind === 'group-msg')
    expect(m?.dir).toBe('in')
    expect(m?.fromDevice).toBeUndefined()
  })
  it('普通群同账号消息 dir 行为不变（in）；fromDevice 照样持久化（D.2 无条件）', () => {
    upsertGroup('grp-1', '普通群', [ROOT, 'did:youling:PEER'])
    ingestMsg(ROOT, S({ fromDevice: MY_DEVICE, fromDeviceName: 'myco-phone', payload: { groupId: 'grp-1', groupName: '普通群', fromName: '测试账号', members: [ROOT], text: 'x' } }))
    const m = loadConv('grp-1').find((x) => x.kind === 'group-msg')
    expect(m?.dir).toBe('in') // 普通群不动：自同步回流语义保留
    expect(m?.fromDevice).toBe(MY_DEVICE)
  })
})

describe('治理闸：设备群为系统群，五操作全拒（决策 D.4，UI ⚙️ 隐藏之外的数据层兜底）', () => {
  beforeEach(() => { ensureDeviceGroup() })
  it('invite/rename/kick/mute/leave → 抛"设备群为系统群"', async () => {
    await expect(groupInvite(GID, ['did:youling:X'])).rejects.toThrow('设备群为系统群')
    await expect(groupRename(GID, '改名')).rejects.toThrow('设备群为系统群')
    await expect(groupKick(GID, 'did:youling:X')).rejects.toThrow('设备群为系统群')
    await expect(groupMute(GID, 'did:youling:X', Date.now() + 1000)).rejects.toThrow('设备群为系统群')
    await expect(groupLeave(GID)).rejects.toThrow('设备群为系统群')
  })
})
