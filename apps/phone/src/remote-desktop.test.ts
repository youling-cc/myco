/**
 * remote-desktop 纯函数单测（2026-10-22）：手机端「远程桌面」卡片的判定核。
 * 只测不碰 DOM/桥的部分（copyText 的 fallback 需要真实 WebView，留给真机验收）。
 */
import { describe, expect, it } from 'vitest'
import {
  RDP_DEFAULT_LOCAL,
  RDP_TARGET_PORT,
  normalizeForwards,
  parseAddress,
  pickRdpForward,
  rdpAddress,
  rdpStatus,
  sameDevice,
} from './remote-desktop'

const PC = 'did:myco:z6MkuyFrKzJAzUQSi4D8nfDr9EkkibvY3NdHL2oqyCJBx7oj'
const LAPTOP = 'did:myco:z6MkpYTe3QL6GHkm1hf8DdNfT7G1Hffn2KBS1Ggx1TbM6Cqf'

describe('normalizeForwards：各形态来源归一', () => {
  it('裸数组 / {forwards} / JSON 字符串都认', () => {
    const one = [{ localPort: 23389, device: PC, port: 3389, enabled: true }]
    expect(normalizeForwards(one)).toHaveLength(1)
    expect(normalizeForwards({ forwards: one })[0].localPort).toBe(23389)
    expect(normalizeForwards(JSON.stringify({ list: one }))[0].port).toBe(3389)
  })

  it('脏数据丢弃（缺端口/非对象/坏 JSON），不抛', () => {
    expect(normalizeForwards(null)).toEqual([])
    expect(normalizeForwards('not json')).toEqual([])
    expect(normalizeForwards([{ localPort: 0, port: 3389 }, null, 'x', { localPort: 23389 }])).toEqual([])
  })

  it('camel/snake 两种字段名都认，enabled 缺省为 true', () => {
    const [f] = normalizeForwards([{ local_port: 23389, targetPort: 3389, deviceDid: PC }])
    expect(f.localPort).toBe(23389)
    expect(f.port).toBe(3389)
    expect(f.device).toBe(PC)
    expect(f.enabled).toBe(true)
    expect(normalizeForwards([{ localPort: 1, port: 2, enabled: false }])[0].enabled).toBe(false)
  })
})

describe('pickRdpForward：只认 3389，设备/固定口优先', () => {
  const list = [
    { localPort: 22222, device: LAPTOP, port: 22, enabled: true },
    { localPort: 23389, device: PC, port: 3389, enabled: true, label: 'RDP' },
    { localPort: 25037, device: LAPTOP, port: 5037, enabled: true },
  ]

  it('挑出 RDP 那条（不是 22/5037）', () => {
    const ep = pickRdpForward(list)
    expect(ep?.localPort).toBe(RDP_DEFAULT_LOCAL)
    expect(ep?.port).toBe(RDP_TARGET_PORT)
    expect(ep?.device).toBe(PC)
  })

  it('设备匹配（全等或尾 8 位）；不匹配时仍有兜底', () => {
    expect(pickRdpForward(list, PC)?.localPort).toBe(23389)
    expect(pickRdpForward(list, `did:myco:whatever-${PC.slice(-8)}`)?.localPort).toBe(23389)
    // 目标不是这台 → 只有一条 RDP，仍给出来（用户点的是"远程桌面"，不是"这台特定机器"）
    expect(pickRdpForward(list, LAPTOP)?.localPort).toBe(23389)
  })

  it('localPort 强制定向；没有 3389 条目 → null', () => {
    expect(pickRdpForward(list, undefined, 23389)?.localPort).toBe(23389)
    expect(pickRdpForward(list, undefined, 99999)?.localPort).toBe(23389) // 无此口 → 回落
    expect(pickRdpForward([{ localPort: 22222, device: LAPTOP, port: 22 }])).toBeNull()
  })

  it('sameDevice：空值不相等', () => {
    expect(sameDevice('', '')).toBe(false)
    expect(sameDevice(PC, PC)).toBe(true)
    expect(sameDevice(PC, LAPTOP)).toBe(false)
  })
})

describe('地址形态：127.0.0.1:<固定口>', () => {
  it('默认 23389；解析回原值；非法给 0', () => {
    expect(rdpAddress()).toBe('127.0.0.1:23389')
    expect(rdpAddress(25000)).toBe('127.0.0.1:25000')
    expect(parseAddress('127.0.0.1:23389')).toBe(23389)
    expect(parseAddress('192.168.1.82:3389')).toBe(0)
    expect(parseAddress('127.0.0.1:70000')).toBe(0)
  })
})

describe('rdpStatus：无配置时也给出可复制的默认地址', () => {
  it('node 环境没有 localStorage/壳 → configured=false，地址仍是 127.0.0.1:23389', () => {
    const st = rdpStatus(PC)
    expect(st.configured).toBe(false)
    expect(st.enabled).toBe(false)
    expect(st.address).toBe('127.0.0.1:23389')
    expect(st.source).toBe('none')
    expect(st.device).toBe(PC)
  })
})
