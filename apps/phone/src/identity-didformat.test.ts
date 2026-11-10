/**
 * identity-didformat.test.ts — spec v0.3 Multibase（**canonical-only**，2026-10-10 系统拍板）。
 * canonical=`did:myco:z<base58btc(0xed 0x01+pub)>`（与 did:key 同构，载荷恒 34B）；
 * legacy=裸 base58（**已废止**：不再解码、不回落）。didFromPubkeyB64 只产 canonical，
 * pubkeyB64FromDid 只收 canonical（判定以解码结果为准）。
 */
import { describe, expect, it } from 'vitest'
import bs58 from 'bs58'
import { didFromPubkeyB64, pubkeyB64FromDid } from './identity'

const b64 = (u8: Uint8Array): string => btoa(String.fromCharCode(...u8))
const fromHex = (hex: string): Uint8Array => new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)))

// RFC8032 TESTVEC 公钥
const PK = fromHex('3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29')

describe('did v0.3 canonical 构造（didFromPubkeyB64）', () => {
  it('产出 did:myco:z…，multibase 段=base58btc(0xed 0x01+公钥)', () => {
    const did = didFromPubkeyB64(b64(PK))
    expect(did.startsWith('did:myco:z')).toBe(true)
    const payload = bs58.decode(did.slice('did:myco:z'.length))
    expect(payload.length).toBe(34)
    expect(payload[0]).toBe(0xed)
    expect(payload[1]).toBe(0x01)
    expect(Array.from(payload.slice(2))).toEqual(Array.from(PK))
  })
  it('非 32B 输入返回空串', () => {
    expect(didFromPubkeyB64(b64(new Uint8Array(10)))).toBe('')
    expect(didFromPubkeyB64('!!!')).toBe('')
  })
})

describe('did v0.3 canonical 解析（pubkeyB64FromDid，canonical-only）', () => {
  it('canonical 双 method 解析出同一公钥', () => {
    const canonical = didFromPubkeyB64(b64(PK))
    expect(pubkeyB64FromDid(canonical)).toBe(b64(PK))
    // did:youling: method 同规
    expect(pubkeyB64FromDid(canonical.replace('did:myco:', 'did:youling:'))).toBe(b64(PK))
    expect(pubkeyB64FromDid(`did:youling:z${bs58.decode('')}`)).toBeNull()
  })
  it('legacy（裸 base58 32B）已废止 → null（双 method，不再回落）', () => {
    expect(pubkeyB64FromDid(`did:myco:${bs58.encode(PK)}`)).toBeNull()
    expect(pubkeyB64FromDid(`did:youling:${bs58.encode(PK)}`)).toBeNull()
    // 无 z 前缀但载荷恰为 34B（legacy 形态套 canonical 载荷）同样拒
    const payload = new Uint8Array(34)
    payload[0] = 0xed
    payload[1] = 0x01
    payload.set(PK, 2)
    expect(pubkeyB64FromDid(`did:myco:${bs58.encode(payload)}`)).toBeNull()
  })
  it('与 did:key 同构——z6MkhaXg… 知名向量解出同一公钥', () => {
    const mb = '6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
    const payload = bs58.decode(mb)
    expect(payload.length).toBe(34)
    const key = payload.slice(2)
    expect(pubkeyB64FromDid(`did:myco:z${mb}`)).toBe(b64(key))
    expect(didFromPubkeyB64(b64(key))).toBe(`did:myco:z${mb}`)
  })
  it('非法向量：短载荷/错 multicodec 头/非 base58/无 z 前缀长度不对/软 did', () => {
    expect(pubkeyB64FromDid(`did:myco:z${bs58.encode(new Uint8Array(10))}`)).toBeNull()
    const wrong = new Uint8Array(34); wrong[0] = 0x00; wrong[1] = 0x01
    expect(pubkeyB64FromDid(`did:myco:z${bs58.encode(wrong)}`)).toBeNull()
    expect(pubkeyB64FromDid('did:myco:z0OIl')).toBeNull()
    expect(pubkeyB64FromDid(`did:myco:${bs58.encode(new Uint8Array(33))}`)).toBeNull()
    expect(pubkeyB64FromDid('did:myco:participant:x')).toBeNull()
    expect(pubkeyB64FromDid('not a did')).toBeNull()
  })
})
