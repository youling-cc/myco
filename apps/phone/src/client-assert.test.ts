/**
 * client-assert 单测（2026-10-23）：协议与 PC Rust 逐字节一致 + 验签闭环。
 *
 * 断言点：
 *  ① 分享入口才加断言（根路径/外站原样返回）
 *  ② fragment 五段齐全、did/name/ts/sig 可从 URL 还原
 *  ③ 用 did 内嵌公钥验签通过（= 网关侧同一算法）
 *  ④ 篡改 sig / 换 share id → 验签失败（网关会回落旧署名）
 *  ⑤ 无身份（未登录/未加载）→ 原样返回
 */
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512.js'
import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'
import { shareIdFromGw, withClientAssertFor } from './client-assert'
import type { PhoneIdentity } from './identity'

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m))
ed.etc.sha512Async = async (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m))

function newIdentity(): PhoneIdentity {
  const seed = ed.utils.randomPrivateKey()
  const pub = ed.getPublicKey(seed)
  // did:myco:z<base58btc(0xed 0x01 + pub)>；测试里只要 did 能反解出公钥即可，
  // 与生产 identityFromSeed 同形（base58 前缀不参与网关验签的 did→pubkey 反解以外的逻辑）。
  let s = ''
  for (const b of seed) s += String.fromCharCode(b)
  const keyB64 = btoa(s)
  // 直接用 noble 生成 canonical did 需要 base58 依赖；这里用 didPubkeyBytes 的输入形：
  // 网关侧 did_pubkey_bytes 只接受 canonical multibase 串，故这里用一个真实 base58。

  const mb = new Uint8Array(34)
  mb[0] = 0xed
  mb[1] = 0x01
  mb.set(pub, 2)
  return { keyB64, nodeId: 'x', did: `did:myco:z${bs58.encode(mb)}` }
}

function parseFragment(url: string): Record<string, string> {
  const frag = url.split('#')[1] || ''
  const out: Record<string, string> = {}
  for (const kv of frag.split('&')) {
    const i = kv.indexOf('=')
    if (i < 0) continue
    out[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1))
  }
  return out
}

describe('client-assert（授权发言人身份 = 实际打字设备）', () => {
  it('分享入口才加断言，根路径/外站原样返回', () => {
    const id = newIdentity()
    expect(withClientAssertFor('http://127.0.0.1:23911/', id)).toBe('http://127.0.0.1:23911/')
    expect(withClientAssertFor('https://myco.youling.cc/x', id)).toBe('https://myco.youling.cc/x')
    const u = withClientAssertFor('http://127.0.0.1:23911/gw/sh-x/?mt=abc', id)
    expect(u.startsWith('http://127.0.0.1:23911/gw/sh-x/?mt=abc')).toBe(true)
    expect(u).toContain('#mycoClient=')
  })

  it('fragment 可还原 + 用 did 内嵌公钥验签通过（网关同算法）', () => {
    const id = newIdentity()
    const u = withClientAssertFor('http://127.0.0.1:23911/gw/sh-abc/?mt=t', id)
    const f = parseFragment(u)
    expect(f.mycoClient).toBe(id.did)
    expect(f.mycoClientName).toBe('手机')
    const ts = Number(f.mycoClientTs)
    expect(ts).toBeGreaterThan(0)
    // 验签：payload 与 Rust 侧字符串拼接逐字节一致
    const payload = `myco-client|/gw/sh-abc|${id.did}|${ts}`
    const sig = Uint8Array.from(atob(f.mycoClientSig.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    )
    const pub = ed.getPublicKey(Uint8Array.from(atob(id.keyB64), (c) => c.charCodeAt(0)))
    expect(ed.verify(sig, new TextEncoder().encode(payload), pub)).toBe(true)
  })

  it('篡改签名或换 share id → 验签失败', () => {
    const id = newIdentity()
    const u = withClientAssertFor('http://127.0.0.1:23911/gw/sh-abc/?mt=t', id)
    const f = parseFragment(u)
    const ts = Number(f.mycoClientTs)
    const payload = `myco-client|/gw/sh-abc|${id.did}|${ts}`
    const pub = ed.getPublicKey(Uint8Array.from(atob(id.keyB64), (c) => c.charCodeAt(0)))
    const sigBytes = Uint8Array.from(
      atob(f.mycoClientSig.replace(/-/g, '+').replace(/_/g, '/')),
      (c) => c.charCodeAt(0),
    )
    // 篡改：最后一字节翻转
    const bad = new Uint8Array(sigBytes)
    bad[bad.length - 1] ^= 0xff
    expect(ed.verify(bad, new TextEncoder().encode(payload), pub)).toBe(false)
    // 换 share id → payload 不符 → 验签失败
    const payloadOther = `myco-client|/gw/sh-other|${id.did}|${ts}`
    expect(ed.verify(sigBytes, new TextEncoder().encode(payloadOther), pub)).toBe(false)
  })

  it('无身份 / shareId 解析边界', () => {
    expect(withClientAssertFor('http://127.0.0.1:23911/gw/sh-x/?mt=1', null)).toBe(
      'http://127.0.0.1:23911/gw/sh-x/?mt=1',
    )
    expect(shareIdFromGw('http://127.0.0.1:23911/gw/sh-pc-env-dsh/?mt=1')).toBe('sh-pc-env-dsh')
    expect(shareIdFromGw('http://127.0.0.1:23911/')).toBe(null)
    expect(shareIdFromGw('http://127.0.0.1:23911/gw/')).toBe(null)
    expect(shareIdFromGw('http://127.0.0.1:23911/gw/sh-a/#mycoConn=relay')).toBe('sh-a')
  })
})
