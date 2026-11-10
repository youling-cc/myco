/**
 * identity-rosterheal.test.ts — 手机端名册自愈 + 旧格式闸门（C1，2026-10-07）。
 *
 * 事故背景：服务端清档后 createRootIdentity 幂等短路——名册 404 无人重建，账号层
 * 403 半瘫。ensureRootRoster 与 PC core identity.rs roster_self_heal_at 对齐：
 *   GET 200 → present；404 → POST /root/create（201/409=rebuilt）；
 *   create 400 code=unsupported_did_format → legacy（sticky 标记，不再重试）；
 *   其他 400 / 网络失败 → uncertain（不标记）；无账号 → skip；in-flight 防重入。
 * fetch 全 mock（零真网）；rootSig 字节级复验（create 签名格式与 createRootIdentity 同款）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import bs58 from 'bs58'
import * as ed from '@noble/ed25519'
import {
  ensureRootRoster, accountFormatLegacy, unbindYouling, getRootIdentity,
} from './identity'

// RFC 8032 §7.1 TEST 1 种子/公钥（did-auth.test.ts 同款锚）
const SEED_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
const PUB_HEX = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
const hexToBytes = (hex: string): Uint8Array => new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)))
const b64 = (u8: Uint8Array): string => btoa(String.fromCharCode(...u8))
const SEED = hexToBytes(SEED_HEX)
const PUB = hexToBytes(PUB_HEX)
const SEED_B64 = b64(SEED)
// canonical 账号 did：did:youling:z<base58btc(0xed 0x01 + pub)>（rootDidOf 同款构造）
const mb = new Uint8Array(34); mb[0] = 0xed; mb[1] = 0x01; mb.set(PUB, 2)
const ROOT_DID = `did:youling:z${bs58.encode(mb)}`
const DEVICE_KEY_B64 = SEED_B64 // vault 里的设备钥（自签同钥，测试只关心流程）

/** route 型 fetch mock：按 (method, path 尾段) 查表应答；未命中 404。 */
function mockFetch(routes: { m: string; p: string; status: number; body?: unknown }[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const m = (init?.method ?? 'GET').toUpperCase()
    for (const r of routes) {
      if (m === r.m && url.includes(r.p)) {
        return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status })
      }
    }
    return new Response('{}', { status: 404 })
  })
}

function stubVault(rootDid: string | null) {
  const ls = {
    store: new Map<string, string>(),
    getItem(k: string) { return ls.store.get(k) ?? null },
    setItem(k: string, v: string) { ls.store.set(k, v) },
    removeItem(k: string) { ls.store.delete(k) },
  }
  vi.stubGlobal('localStorage', ls)
  if (rootDid) {
    localStorage.setItem('youling.vault', JSON.stringify({ mode: 'plain', keyB64: DEVICE_KEY_B64, rootSeedB64: SEED_B64, rootDid }))
    localStorage.setItem('youling.accounts', JSON.stringify([{ rootDid, name: '手机测试号', lastLogin: 0 }]))
  }
}

const GET_404_CREATE_201 = [
  { m: 'GET', p: `/root/${encodeURIComponent(ROOT_DID)}`, status: 404, body: { error: 'root not found' } },
  { m: 'POST', p: '/root/create', status: 201, body: { data: {} } },
]

beforeEach(() => stubVault(ROOT_DID))
afterEach(() => vi.unstubAllGlobals())

describe('ensureRootRoster：404 → 重建（与 PC roster_self_heal 同语义）', () => {
  it('GET 404 → POST /root/create 201 → rebuilt；rootSig 字节级可复验、rootDid 原样沿用', async () => {
    const fm = mockFetch(GET_404_CREATE_201)
    vi.stubGlobal('fetch', fm)
    const r = await ensureRootRoster()
    expect(r).toBe('rebuilt')
    expect(fm).toHaveBeenCalledTimes(2)
    const [url] = fm.mock.calls[0] as [string, RequestInit]
    expect(url).toContain(`/root/${encodeURIComponent(ROOT_DID)}`)
    const [, createInit] = fm.mock.calls[1] as [string, RequestInit] // 第 2 次调用=POST /root/create
    const body = JSON.parse(String(createInit!.body))
    expect(body.rootDid).toBe(ROOT_DID)
    expect(body.rootPubkeyB64).toBe(b64(PUB))
    expect(body.name).toBe('手机测试号')
    expect(body.deviceName).toBe('MYCO')
    const sig = Uint8Array.from(atob(body.rootSig), (c) => c.charCodeAt(0))
    const msg = new TextEncoder().encode(`create\n${ROOT_DID}\n${b64(PUB)}`)
    expect(ed.verify(sig, msg, PUB)).toBe(true)
  })

  it('GET 200（本机在册）→ present，零 POST', async () => {
    // 2026-10-09 语义变更（P1-1，对齐 PC ensure_device_in_root_at）：200 不再无条件
    // present——还要核**本机设备是否在册**。在册 → present 零写。
    const fm = mockFetch([{ m: 'GET', p: `/root/`, status: 200, body: { data: { rootDid: ROOT_DID, devices: [{ pubkeyB64: b64(PUB), revoked: 0, name: 'MYCO' }] } } }])
    vi.stubGlobal('fetch', fm)
    expect(await ensureRootRoster()).toBe('present')
    expect(fm).toHaveBeenCalledTimes(1)
  })

  it('GET 200 但本机不在册 → POST /root/device/add 补登记 → rebuilt（2026-10-09 P1-1）', async () => {
    // 用户实测"设备数缺人"的治本：手机掉出名册（或被吊销）后自愈补登记（PC 有、手机此前没有）
    const otherPub = b64(new Uint8Array(32).fill(7))
    const fm = mockFetch([
      { m: 'GET', p: `/root/`, status: 200, body: { data: { rootDid: ROOT_DID, devices: [{ pubkeyB64: otherPub, revoked: 0, name: '别的设备' }] } } },
      { m: 'POST', p: '/root/device/add', status: 200, body: { data: {} } },
    ])
    vi.stubGlobal('fetch', fm)
    expect(await ensureRootRoster()).toBe('rebuilt')
    expect(fm).toHaveBeenCalledTimes(2)
    const [, addInit] = fm.mock.calls[1] as [string, RequestInit]
    const body = JSON.parse(String(addInit!.body))
    expect(body.rootDid).toBe(ROOT_DID)
    expect(body.pubkeyB64).toBe(b64(PUB)) // 补登记的是**本机设备**公钥
    const sig = Uint8Array.from(atob(body.attestSigB64), (c) => c.charCodeAt(0))
    const msg = new TextEncoder().encode(`attest\n${ROOT_DID}\n${b64(PUB)}\n${body.issuedAt}`)
    expect(ed.verify(sig, msg, PUB)).toBe(true)
  })

  it('GET 200 但本机行已吊销（revoked=1）→ 也走补登记（复活自身）', async () => {
    const fm = mockFetch([
      { m: 'GET', p: `/root/`, status: 200, body: { data: { rootDid: ROOT_DID, devices: [{ pubkeyB64: b64(PUB), revoked: 1 }] } } },
      { m: 'POST', p: '/root/device/add', status: 200, body: { data: {} } },
    ])
    vi.stubGlobal('fetch', fm)
    expect(await ensureRootRoster()).toBe('rebuilt')
    expect(fm).toHaveBeenCalledTimes(2)
  })

  it('GET 200 但响应无 devices（探测不可用）→ 盲补登记 → rebuilt（对齐 PC None 分支）', async () => {
    const fm = mockFetch([
      { m: 'GET', p: `/root/`, status: 200, body: { data: { rootDid: ROOT_DID } } },
      { m: 'POST', p: '/root/device/add', status: 200, body: { data: {} } },
    ])
    vi.stubGlobal('fetch', fm)
    expect(await ensureRootRoster()).toBe('rebuilt')
    expect(fm).toHaveBeenCalledTimes(2)
  })

  it('create 409（did_conflict 幂等）→ rebuilt', async () => {
    const fm = mockFetch([{ m: 'GET', p: `/root/`, status: 404, body: {} }, { m: 'POST', p: '/root/create', status: 409, body: { code: 'did_conflict' } }])
    vi.stubGlobal('fetch', fm)
    expect(await ensureRootRoster()).toBe('rebuilt')
  })
})

describe('ensureRootRoster：旧格式闸门（400 unsupported_did_format）', () => {
  it('400 code=unsupported_did_format → legacy + sticky 标记；再次调用零网络直接 legacy', async () => {
    const fm = mockFetch([
      { m: 'GET', p: `/root/`, status: 404, body: { error: 'root not found' } },
      { m: 'POST', p: '/root/create', status: 400, body: { error: 'unsupported_did_format: 服务端仅支持 canonical 账号', code: 'unsupported_did_format' } },
    ])
    vi.stubGlobal('fetch', fm)
    expect(await ensureRootRoster()).toBe('legacy')
    expect(accountFormatLegacy()).toBe(true)
    expect(fm).toHaveBeenCalledTimes(2)
    // 不再重试：第三次调用零 fetch（本地短路）
    expect(await ensureRootRoster()).toBe('legacy')
    expect(fm).toHaveBeenCalledTimes(2)
  })

  it('其他 400（缺字段）→ uncertain，不标记（可重试语义保留）', async () => {
    const fm = mockFetch([
      { m: 'GET', p: `/root/`, status: 404, body: {} },
      { m: 'POST', p: '/root/create', status: 400, body: { error: '缺字段 rootDid' } },
    ])
    vi.stubGlobal('fetch', fm)
    expect(await ensureRootRoster()).toBe('uncertain')
    expect(accountFormatLegacy()).toBe(false)
  })

  it('标记在 → 本地短路（零网络）：即便服务端名册 404 也不再去撞闸门', async () => {
    localStorage.setItem(`youling.legacyFmt.${ROOT_DID}`, '1')
    const fm = mockFetch(GET_404_CREATE_201)
    vi.stubGlobal('fetch', fm)
    expect(await ensureRootRoster()).toBe('legacy')
    expect(fm).toHaveBeenCalledTimes(0) // 已检出旧格式——重试无意义，连 GET 都不发
  })

  it('解绑（unbindYouling）一并清标记与账号上下文', () => {
    localStorage.setItem(`youling.legacyFmt.${ROOT_DID}`, '1')
    expect(accountFormatLegacy()).toBe(true)
    unbindYouling()
    expect(getRootIdentity()).toBeNull()
    expect(accountFormatLegacy()).toBe(false)
  })
})

describe('ensureRootRoster：边界', () => {
  it('无账号（vault 无 rootDid）→ skip，零网络', async () => {
    stubVault(null)
    const fm = mockFetch([])
    vi.stubGlobal('fetch', fm)
    expect(await ensureRootRoster()).toBe('skip')
    expect(fm).toHaveBeenCalledTimes(0)
  })

  it('网络抛错（超时/连不上）→ uncertain，不标记', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    expect(await ensureRootRoster()).toBe('uncertain')
    expect(accountFormatLegacy()).toBe(false)
  })

  it('in-flight 防重入：首查未落定时并发第二次 → skip（不叠加连接）', async () => {
    let release!: (v: Response) => void
    const gate = new Promise<Response>((res) => { release = res })
    const fm = vi.fn(async () => gate)
    vi.stubGlobal('fetch', fm)
    const first = ensureRootRoster()
    const second = await ensureRootRoster() // 首查还挂在 gate 上
    expect(second).toBe('skip')
    // 2026-10-09：200 响应需含**本机在册**（否则走补登记分支，会再发一次 fetch 挂住）
    release(new Response(JSON.stringify({ data: { rootDid: ROOT_DID, devices: [{ pubkeyB64: b64(PUB), revoked: 0 }] } }), { status: 200 }))
    expect(await first).toBe('present')
  })
})
