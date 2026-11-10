import { describe, expect, it } from 'vitest'
import { _peerCacheTtlForTest } from './dsh-open-runtime'
import type { PeerDevice } from './p2p'

describe('peer cache：presence 超时的空清单不得污染 180s 缓存', () => {
  const dev = (did: string): PeerDevice => ({ did, name: did, addrs: ['127.0.0.1'], port: 13911 })

  it('正常非空清单 → 180s 缓存（名册变化不频繁）', () => {
    expect(_peerCacheTtlForTest([dev('did:myco:zPc')])).toBe(180_000)
  })

  it('空清单（可能是 presence 3s 超时降级）→ 只缓存 5s，避免 3 分钟误判无设备', () => {
    expect(_peerCacheTtlForTest([])).toBe(5_000)
  })
})
