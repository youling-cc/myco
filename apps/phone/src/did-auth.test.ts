/**
 * did-auth.test.ts — X-Did-Auth 签名能力测试（协议格式 + 跨语言对拍 + 开关行为）。
 *
 * 对拍 fixture（did-auth.fixture.json）由 scripts/gen-did-auth-fixture.py 用 **pynacl**
 * （=服务端 hibianli.py verify_ed25519 的验签库）生成，并在生成时已让 node 侧
 * @noble/ed25519 签名经 Python VerifyKey 验签（crossVerified）。Ed25519 是确定性签名
 * （RFC 8032）：同 seed+msg 双侧必产同字节签名——对拍不一致 = 某侧实现有错。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
// phone 不声明 node 依赖（@types/node 未装、不为此加依赖）；vitest 跑在 node 运行时，
// 'node:fs' 运行时可用，tsc -b 找不到类型声明 → @ts-ignore 压制（仅测试文件，不入构建产物）。
// @ts-ignore
import { readFileSync } from 'node:fs'
import * as ed from '@noble/ed25519'
import bs58 from 'bs58'

import {
  DID_AUTH_HEADER,
  DID_AUTH_METHOD_PREFIXES,
  didAuthMessage,
  didAuthTsNow,
  signDidAuthHeader,
  isDidAuthEnabled,
  setDidAuthEnabled,
  resolveDidAuthSigningIdentity,
  canonicalJsonBody,
  didAuthFetch,
} from './did-auth'

interface Vector {
  name: string
  seedHex: string
  did: string
  ts: string
  body: string
  msgB64: string
  sigB64: string
}
const fixture = JSON.parse(
  readFileSync(new URL('./did-auth.fixture.json', import.meta.url), 'utf-8'),
) as { crossVerified: boolean; vectors: Vector[]; canonicalJson: { name: string; obj: unknown; expected: string }[] }

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16))
const b64d = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

// ── 签名头格式 ──

describe('X-Did-Auth 签名头格式', () => {
  const v = fixture.vectors[0]
  const seed = hexToBytes(v.seedHex)

  it('三段空格分隔：did / ts / sig', () => {
    const header = signDidAuthHeader(v.did, seed, new TextEncoder().encode(v.body), v.ts)
    const parts = header.split(' ')
    expect(parts).toHaveLength(3)
    expect(parts[0]).toBe(v.did)
    expect(parts[1]).toBe(v.ts)
    // 64B 签名 → 标准 base64 定长 88 字符（含 padding），且不含空格（空格切分安全的前提）
    expect(parts[2]).toMatch(/^[A-Za-z0-9+/]{86}==$/)
    expect(header).toBe(`${v.did} ${v.ts} ${v.sigB64}`)
  })

  it('ts 缺省取当前 Unix 秒整数字符串（与头内 ts 逐字符一致）', () => {
    const before = Math.floor(Date.now() / 1000)
    const header = signDidAuthHeader(v.did, seed, new TextEncoder().encode('x'))
    const after = Math.floor(Date.now() / 1000)
    const ts = Number(header.split(' ')[1])
    expect(Number.isInteger(ts)).toBe(true)
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
    expect(didAuthTsNow()).toMatch(/^\d+$/) // 纯数字（Python int(time.time()) 语义，无前导零/小数）
  })

  it('Ed25519 确定性：同参两次签名相同（重试幂等基础）', () => {
    const a = signDidAuthHeader(v.did, seed, new TextEncoder().encode(v.body), v.ts)
    const b = signDidAuthHeader(v.did, seed, new TextEncoder().encode(v.body), v.ts)
    expect(a).toBe(b)
  })

  it('did 前缀必须在协议接受表内', () => {
    for (const vec of fixture.vectors) {
      expect(DID_AUTH_METHOD_PREFIXES.some((p) => vec.did.startsWith(p))).toBe(true)
    }
  })
})

// ── 跨语言对拍（服务端 pynacl ↔ JS noble，字节级一致）──

describe('跨语言对拍（pynacl 服务端向量）', () => {
  it('fixture 生成时已过 node→Python 反向验签', () => {
    expect(fixture.crossVerified).toBe(true)
  })

  for (const v of fixture.vectors) {
    it(`签名内容构造与签名输出字节级一致：${v.name}`, () => {
      const seed = hexToBytes(v.seedHex)
      const body = new TextEncoder().encode(v.body)
      // ① message 拼接对拍：did\nts\n + raw_body（UTF-8，中文 body 覆盖）
      expect(didAuthMessage(v.did, v.ts, body)).toEqual(b64d(v.msgB64))
      // ② 签名对拍：JS noble 产出的 sig == Python pynacl 产的 sigB64
      expect(signDidAuthHeader(v.did, seed, body, v.ts).split(' ')[2]).toBe(v.sigB64)
      // ③ 服务端验签语义自证：公钥=did 尾段 base58 解码（服务端 guild_org.public_key 同源），verify 必须通过
      const pub = bs58.decode(v.did.split(':')[2])
      expect(ed.verify(b64d(v.sigB64), didAuthMessage(v.did, v.ts, body), pub)).toBe(true)
    })
  }

  it('RFC 8032 TEST 1 种子确实是官方向量（防 fixture 被篡改的双保险）', () => {
    expect(fixture.vectors[0].seedHex).toBe(
      '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    )
    // RFC 8032 §7.1 TEST 1：空消息签名（库级正确性锚——noble 对官方向量通过）
    const sig = ed.sign(new Uint8Array(0), hexToBytes(fixture.vectors[0].seedHex))
    expect(ed.verify(sig, new Uint8Array(0), ed.getPublicKey(hexToBytes(fixture.vectors[0].seedHex)))).toBe(true)
  })
})

// ── canonical JSON 跨语言对拍 ──

describe('canonicalJsonBody（与 Python sort_keys+紧凑分隔+ensure_ascii=False 字节级一致）', () => {
  for (const c of fixture.canonicalJson) {
    it(c.name, () => {
      expect(canonicalJsonBody(c.obj)).toBe(c.expected)
    })
  }
  it('数组保序不排序（JSON 语义：只有对象键排序）', () => {
    expect(canonicalJsonBody({ b: [3, 1, 2] })).toBe('{"b":[3,1,2]}')
  })
})

// ── 开关与拦截器 ──

describe('didAuthFetch 开关行为', () => {
  const V = fixture.vectors[0]
  const seedB64 = btoa(String.fromCharCode(...hexToBytes(V.seedHex)))
  const rootDid = V.did // did:youling:（根钥优先路径）
  const vault = JSON.stringify({ mode: 'plain', keyB64: seedB64, rootSeedB64: seedB64, rootDid })

  beforeEach(() => {
    const ls = {
      store: new Map<string, string>(),
      getItem(k: string) { return ls.store.get(k) ?? null },
      setItem(k: string, v: string) { ls.store.set(k, v) },
      removeItem(k: string) { ls.store.delete(k) },
    }
    vi.stubGlobal('localStorage', ls)
    localStorage.setItem('youling.vault', vault)
  })
  afterEach(() => {
    setDidAuthEnabled(null)
    vi.unstubAllGlobals()
  })

  it('开关关闭（默认）：不带签名头，body 原样透传', async () => {
    expect(isDidAuthEnabled()).toBe(false)
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const body = canonicalJsonBody({ data: 'x' })
    await didAuthFetch('http://svc.example/api/task/submit', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://svc.example/api/task/submit')
    expect(init.body).toBe(body)
    expect(new Headers(init.headers).get(DID_AUTH_HEADER)).toBeNull()
  })

  it('开关开启：POST 带签名头且签名可验（签的=发的）', async () => {
    setDidAuthEnabled(true)
    expect(isDidAuthEnabled()).toBe(true)
    expect(resolveDidAuthSigningIdentity()?.did).toBe(rootDid)
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const body = canonicalJsonBody({ taskId: 't-77', answer: { skuId: '88' } })
    await didAuthFetch('http://svc.example/api/task/submit', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    // body 未被改动（签名基于发送字节）
    expect(init.body).toBe(body)
    const header = new Headers(init.headers).get(DID_AUTH_HEADER)
    expect(header).toBeTruthy()
    const parts = header!.split(' ')
    expect(parts).toHaveLength(3)
    expect(parts[0]).toBe(rootDid)
    expect(parts[1]).toMatch(/^\d+$/)
    // 头里 ts 的原始字符串参与验签（服务端语义）：同 ts 重算必须复现同头
    const expectHeader = signDidAuthHeader(rootDid, hexToBytes(V.seedHex), new TextEncoder().encode(body), parts[1])
    expect(header).toBe(expectHeader)
  })

  it('开关开启：GET / 不可知 body 形态（FormData）不签名', async () => {
    setDidAuthEnabled(true)
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    await didAuthFetch('http://svc.example/api/task/list', { method: 'GET' })
    const fd = new FormData(); fd.append('f', 'x')
    await didAuthFetch('http://svc.example/upload', { method: 'POST', body: fd })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(new Headers(init.headers).get(DID_AUTH_HEADER)).toBeNull()
    }
  })

  it('Uint8Array body：按字节签名（二进制安全）', async () => {
    setDidAuthEnabled(true)
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const bytes = new TextEncoder().encode('{"taskId":"t-1"}')
    await didAuthFetch('http://svc.example/api/task/submit', { method: 'POST', body: bytes })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const header = new Headers(init.headers).get(DID_AUTH_HEADER)!
    const ts = header.split(' ')[1]
    expect(header).toBe(signDidAuthHeader(rootDid, hexToBytes(V.seedHex), bytes, ts))
    expect(init.body).toBe(bytes)
  })
})
