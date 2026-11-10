import { describe, expect, it } from 'vitest'
import { isNewerVersion, pickPcDevices, shouldCheckNow } from './update-check'

describe('isNewerVersion', () => {
  it('新版更大 / 同版 / 旧版', () => {
    expect(isNewerVersion('0.3.145', '0.3.144')).toBe(true)
    expect(isNewerVersion('0.3.144', '0.3.144')).toBe(false)
    expect(isNewerVersion('0.3.143', '0.3.144')).toBe(false)
  })
  it('位数不同按缺位补 0', () => {
    expect(isNewerVersion('1.2', '1.2.0')).toBe(false)
    expect(isNewerVersion('1.2.1', '1.2')).toBe(true)
    expect(isNewerVersion('1.0', '0.9.9')).toBe(true)
  })
  it('空/非法 latest 一律不更新', () => {
    expect(isNewerVersion('', '0.3.144')).toBe(false)
    expect(isNewerVersion('abc', '0.3.144')).toBe(false)
  })
})

describe('pickPcDevices', () => {
  const nodes = [
    { did: 'did:myco:phone', kind: 'phone', name: 'phone' },
    { did: 'did:myco:pc1', kind: 'pc', name: 'PC1' },
    { did: 'did:myco:pc2', kind: 'desktop', name: 'PC2' },
    { did: 'did:myco:laptop', kind: 'pc', name: 'lap' },
    { did: '', kind: 'pc' },
  ]
  it('只挑 pc/desktop 且排除自己', () => {
    const got = pickPcDevices(nodes, 'did:myco:phone').map((n) => n.name)
    expect(got).toEqual(['PC1', 'PC2', 'lap'])
  })
  it('排除指定设备', () => {
    const got = pickPcDevices(nodes, 'did:myco:pc1').map((n) => n.name)
    expect(got).toEqual(['PC2', 'lap'])
  })
  it('空输入安全', () => {
    expect(pickPcDevices(null, 'x')).toEqual([])
    expect(pickPcDevices(undefined, 'x')).toEqual([])
  })
})

describe('shouldCheckNow', () => {
  const base = { visibility: 'visible', lastCheckAt: 0, now: 1000 }
  it('force 直接过', () => {
    expect(shouldCheckNow({ ...base, force: true, visibility: 'hidden' })).toBe(true)
  })
  it('不可见不跑', () => {
    expect(shouldCheckNow({ ...base, visibility: 'hidden', now: 10 ** 12 })).toBe(false)
  })
  it('24h 节流', () => {
    const DAY = 24 * 3600 * 1000
    expect(shouldCheckNow({ ...base, lastCheckAt: 5000, now: 5000 + DAY - 1 })).toBe(false)
    expect(shouldCheckNow({ ...base, lastCheckAt: 5000, now: 5000 + DAY })).toBe(true)
  })
})
