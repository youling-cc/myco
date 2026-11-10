/**
 * conn-badge.test.ts — 设备列表「图标+文字」连接徽标（2026-10-11 设计定稿）。
 * 锁两件事：① 状态→模式映射（连接中 > 直连能力 > 中转 > 仍在试）；
 * ② 三态文案就是用户口径的 直连 / 中转 / 连接中（别再回到文字链时代的
 * "探测中…""直连不通→云端中转"）。
 */
import { describe, it, expect } from 'vitest'
import { connBadgeMode, vnetPathFromStatusText, CONN_BADGE_TEXT, type DirectProbe } from './conn-badge'

describe('connBadgeMode：探测/连接状态 → 徽标模式', () => {
  it('正在连接最优先（其余状态一律显示连接中）', () => {
    for (const probe of ['ok', 'fail', 'probing', undefined] as DirectProbe[]) {
      expect(connBadgeMode(probe, true, true)).toBe('connecting')
      expect(connBadgeMode(probe, false, true)).toBe('connecting')
    }
  })
  it('探测 ok 或 PC 上报 webrtc → 直连', () => {
    expect(connBadgeMode('ok', false, false)).toBe('direct')
    expect(connBadgeMode('ok', null, false)).toBe('direct')
    expect(connBadgeMode('fail', true, false)).toBe('direct')
    expect(connBadgeMode('probing', true, false)).toBe('direct')
  })
  it('探测 fail 且无 webrtc → 中转（原"直连不通→云端中转"的图标化形态）', () => {
    expect(connBadgeMode('fail', false, false)).toBe('relay')
    expect(connBadgeMode('fail', null, false)).toBe('relay')
  })
  it('探测中/未知 → 连接中（旋转图标；首探才有，重探不闪）', () => {
    expect(connBadgeMode('probing', false, false)).toBe('connecting')
    expect(connBadgeMode(undefined, false, false)).toBe('connecting')
    expect(connBadgeMode(undefined, null, false)).toBe('connecting')
  })
})

describe('CONN_BADGE_TEXT：三态文案（用户口径）', () => {
  it('直连 / 中转 / 连接中——不带箭头链、不带省略号', () => {
    expect(CONN_BADGE_TEXT.direct).toBe('直连')
    expect(CONN_BADGE_TEXT.relay).toBe('中转')
    expect(CONN_BADGE_TEXT.connecting).toBe('连接中')
  })
})

describe('vnetPath 优先级（2026-11-06 目标⑥：徽标说真话）', () => {
  it('vnet path=P2P* → 直连（压过探测 fail / 无 webrtc / connecting）', () => {
    expect(connBadgeMode('fail', false, false, 'P2P IPv6')).toBe('direct')
    expect(connBadgeMode('fail', false, false, 'P2P UDP')).toBe('direct')
    expect(connBadgeMode('ok', true, false, 'P2P IPv6')).toBe('direct')
  })
  it('vnet path=Relay → 中转（压过探测 ok——探测只是近似，隧道实际走中继就不许显示直连）', () => {
    expect(connBadgeMode('ok', false, false, 'Relay')).toBe('relay')
    expect(connBadgeMode('ok', true, false, 'Relay')).toBe('relay')
    expect(connBadgeMode('fail', false, false, 'Relay')).toBe('relay')
  })
  it('vnet Relay 且正在连接 → 连接中（打洞进行中的瞬态）', () => {
    expect(connBadgeMode('ok', false, true, 'Relay')).toBe('connecting')
  })
  it('无 vnetPath → 老逻辑不变', () => {
    expect(connBadgeMode('ok', false, false, undefined)).toBe('direct')
    expect(connBadgeMode('fail', false, false, undefined)).toBe('relay')
    expect(connBadgeMode('fail', false, true, undefined)).toBe('connecting')
  })
})

describe('vnetPathFromStatusText：EnvServer vnet 状态解析', () => {
  it('从 status 文本里抽 path= 行', () => {
    const s = 'role=client\nmy_peer_id=1\ntarget_peer_id=2\npath=P2P IPv6\np2p_peer=[::1]:9\n'
    expect(vnetPathFromStatusText(s)).toBe('P2P IPv6')
    expect(vnetPathFromStatusText('path=Relay\n')).toBe('Relay')
  })
  it('无 path 行 / 空输入 → undefined（徽标回退老逻辑）', () => {
    expect(vnetPathFromStatusText('role=client\n')).toBeUndefined()
    expect(vnetPathFromStatusText('')).toBeUndefined()
    expect(vnetPathFromStatusText(undefined)).toBeUndefined()
    expect(vnetPathFromStatusText(null)).toBeUndefined()
  })
})
