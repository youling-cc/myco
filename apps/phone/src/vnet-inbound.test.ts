/**
 * vnet-inbound.test.ts — 手机入向 vnet（V21）两件事的单测：
 *  ① 端口开放集合：默认 [5555]、localStorage `myco.inboundPorts` 读写归一、
 *     生效集合 = 配置 ∩ 静态白名单（协议端口不可配）；
 *  ② 同账号名册校验：`GET /root/<account>` 名册含签名设备 → true；不含/已吊销/
 *     网络失败 → false（fail-closed）；60s 正缓存内不重复拉。
 *
 * 环境：vitest node——localStorage/fetch 走全局桩（identity.ts 模块加载即读
 * localStorage，桩必须先于动态 import 就位；与 vnet-forward-returnpath.test.ts 同款）。
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import crypto from 'node:crypto'
import { didFromPubkey } from './didUtil'

// ── 全局桩（先于动态 import） ──
const store = new Map<string, string>()
const g = globalThis as unknown as Record<string, unknown>
g.window = globalThis
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
}

/** /root/<account> 名册桩（按需改写；默认网络失败）。 */
let rosterResponses = new Map<string, unknown>()
let rosterFetchCount = 0
const realFetch = globalThis.fetch
g.fetch = async (input: unknown): Promise<unknown> => {
  const url = String((input as { url?: string } | undefined)?.url ?? input ?? '')
  const m = /\/root\/([^/?]+)/.exec(url)
  if (m) {
    rosterFetchCount++
    const body = rosterResponses.get(decodeURIComponent(m[1]))
    if (body === undefined) throw new Error('stub network down')
    return { ok: true, status: 200, json: async () => body }
  }
  return realFetch(input as RequestInfo)
}

type Inbound = typeof import('./vnet-inbound')
let ib: Inbound

beforeAll(async () => {
  ib = await import('./vnet-inbound')
})

beforeEach(() => {
  store.clear()
  rosterResponses = new Map()
  rosterFetchCount = 0
  ib._resetRosterCacheForTest()
})

// ══════════════════ ① 端口开放集合 ══════════════════

describe('V21 入向端口集合（myco.inboundPorts）', () => {
  it('默认只开 5555：无配置/坏 JSON/空数组都回落默认', () => {
    expect(ib.loadInboundPorts()).toEqual([5555])
    store.set(ib.INBOUND_KEY, 'not json [')
    expect(ib.loadInboundPorts()).toEqual([5555])
    store.set(ib.INBOUND_KEY, '[]')
    expect(ib.loadInboundPorts()).toEqual([5555])
    store.set(ib.INBOUND_KEY, JSON.stringify([22, 3389]))
    expect(ib.loadInboundPorts()).toEqual([22, 3389])
  })

  it('写读往返：归一化（去重/去非法项/字符串数字也认）并落盘', () => {
    const saved = ib.saveInboundPorts([5555, 5555, 0, 70000, '22', 3389])
    expect(saved).toEqual([5555, 22, 3389])
    expect(JSON.parse(store.get(ib.INBOUND_KEY) ?? '[]')).toEqual([5555, 22, 3389])
    expect(ib.loadInboundPorts()).toEqual([5555, 22, 3389])
    // 全非法 → 回落默认（防把自己锁死在 0 个端口）
    expect(ib.saveInboundPorts(['x', -1])).toEqual([5555])
  })

  it('生效集合 = 配置 ∩ 静态白名单；协议端口(9100/13911)永不入向管辖', () => {
    // 8080 不在 TUNNEL_DEFAULT_PORTS —— JS 放行也拨不出去（Java TcpDialer 同款清单会拒）
    ib.saveInboundPorts([5555, 8080, 9100, 13911, 22])
    expect(ib.effectiveInboundPorts()).toEqual([5555, 22])
    // 默认态
    expect(ib.effectiveInboundPorts()).not.toContain(8080)
  })

  it('inboundApi：无参读、带参写并立即反映', () => {
    expect(ib.inboundApi()).toMatchObject({ ok: true, ports: [5555] })
    const r = ib.inboundApi([5555, 9000])
    expect(r.ok).toBe(true)
    expect(r.ports).toEqual([5555, 9000])
    expect(ib.inboundApi().ports).toEqual([5555, 9000])
  })
})

// ══════════════════ ② 名册归属校验 ══════════════════

/** 造一对真钥：账号 root + 设备 dev（都在册）； outsider 不在册。 */
function fakeKeys() {
  const mk = (seed: number): { pubB64: string; did: string } => {
    const priv = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]),
      format: 'der',
      type: 'pkcs8',
    })
    const der = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' })
    const pub = new Uint8Array(der.subarray(der.length - 32))
    return { pubB64: Buffer.from(pub).toString('base64'), did: didFromPubkey(pub, 'myco') }
  }
  return { root: mk(1), dev: mk(2), outsider: mk(3) }
}

const ACCOUNT = 'did:youling:zTestAccount'

describe('V21 同账号名册校验（verifyVnetPeerRoster，fail-closed）', () => {
  it('设备在名册 → true；不在册/已吊销/是 root 钥 → 按名册判定', async () => {
    const k = fakeKeys()
    rosterResponses.set(ACCOUNT, {
      data: {
        rootPubkeyB64: k.root.pubB64,
        devices: [
          { pubkeyB64: k.dev.pubB64, revoked: 0 },
          { pubkeyB64: k.outsider.pubB64, revoked: 1 }, // 已吊销——不算数
        ],
      },
    })
    await expect(ib.verifyVnetPeerRoster({ account: ACCOUNT, device: k.dev.did })).resolves.toBe(true)
    await expect(ib.verifyVnetPeerRoster({ account: ACCOUNT, device: k.outsider.did })).resolves.toBe(false)
    // root 钥兜底（首设备=根钥场景，对齐 PC roster_allows）
    await expect(ib.verifyVnetPeerRoster({ account: ACCOUNT, device: k.root.did })).resolves.toBe(true)
  })

  it('网络失败/账号不存在/坏响应 → false（fail-closed）；60s 正缓存不重复拉', async () => {
    const k = fakeKeys()
    // 名册缺失（stub 网络失败）
    await expect(ib.verifyVnetPeerRoster({ account: 'did:youling:zGhost', device: k.dev.did })).resolves.toBe(false)
    // 404 形态：ok:true 但响应体是 null（名册解析不出）→ false
    const calls = rosterFetchCount
    rosterResponses.set('did:youling:z404', null)
    await expect(ib.verifyVnetPeerRoster({ account: 'did:youling:z404', device: k.dev.did })).resolves.toBe(false)
    // 缓存命中：同账号第二次不再发 fetch
    rosterResponses.set(ACCOUNT, {
      data: { rootPubkeyB64: k.root.pubB64, devices: [{ pubkeyB64: k.dev.pubB64, revoked: 0 }] },
    })
    await expect(ib.verifyVnetPeerRoster({ account: ACCOUNT, device: k.dev.did })).resolves.toBe(true)
    const afterFirst = rosterFetchCount
    await expect(ib.verifyVnetPeerRoster({ account: ACCOUNT, device: k.root.did })).resolves.toBe(true)
    expect(rosterFetchCount).toBe(afterFirst) // 命中缓存（同一账号同一名册）
    expect(calls).toBeGreaterThan(0)
  })

  it('设备 did 解不出公钥 → false（不进网络）', async () => {
    rosterResponses.set(ACCOUNT, { data: { rootPubkeyB64: 'x', devices: [] } })
    await expect(ib.verifyVnetPeerRoster({ account: ACCOUNT, device: 'not-a-did' })).resolves.toBe(false)
    expect(rosterFetchCount).toBe(0)
  })
})
