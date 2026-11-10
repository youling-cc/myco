/**
 * didUtil.test.ts — 账号 DID 形态判定/归一的纯函数单测（**canonical-only**）。
 *
 * 2026-10-10 系统拍板（三仓对齐）：密钥 did = canonical
 *   `did:<method>:z<base58btc(0xed 0x01 + 32B 公钥)>`（method ∈ youling/myco，载荷恒 34B）；
 * legacy `did:<method>:<base58btc(32B 裸公钥)>` **已废止**：不再解码、不再当别名，
 * 统一文案「不支持的 did 格式」。
 *
 * 判定纪律：**以解码结果为准**，不用「尾段以 z 开头」近似（43 位编码的 32B 裸 base58
 * 有约 1/57 概率恰好以 'z' 开头——本文件有该反例回归）。
 *
 * 与 `core/myco-core/src/identity.rs` 用例集对齐（canonical 双前缀同钥 → 一个键；
 * legacy 一律拒；不同钥匙不互相混入；软 did/群 id 原样）。
 */
import { describe, it, expect } from 'vitest'
import bs58 from 'bs58'
import {
  accountDidAliases, accountDidCanonical, accountDidEq, convKey, convSafe, convSafesAll,
  didFromPubkey, didPubkeyBytes, didSafeId, normalizeAccountDid, restoreDidSafe,
} from './didUtil'

const pk = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const b58 = (b: number): string => bs58.encode(pk(b))
const mycoLegacy = (b: number): string => `did:myco:${b58(b)}`
const youlingLegacy = (b: number): string => `did:youling:${b58(b)}`
const mycoCanon = (b: number): string => didFromPubkey(pk(b), 'myco')
const youlingCanon = (b: number): string => didFromPubkey(pk(b), 'youling')

/** 脚本生成的 test vector（可复现）：SHA-256("myco-legacy-z-vector#2948") 的 32B 裸 base58
 *  恰好以 'z' 开头（43 位编码）——「尾段 z 开头 ⇒ canonical」近似的反例。 */
const Z_PREFIXED_RAW_B58 = 'zN3CTimnh7vifw7LJmqqToyz8Z2SZmoT76PpR1sDw3T'

describe('didPubkeyBytes（canonical-only，spec v0.3 §3.1）', () => {
  it('canonical 双 method 解出同一公钥', () => {
    for (const did of [mycoCanon(0x41), youlingCanon(0x41)]) {
      const got = didPubkeyBytes(did)
      expect(got && Array.from(got)).toEqual(Array.from(pk(0x41)))
    }
  })

  it('legacy（尾段裸 32B base58）已废止 → null（双 method）', () => {
    expect(didPubkeyBytes(mycoLegacy(0x41))).toBeNull()
    expect(didPubkeyBytes(youlingLegacy(0x41))).toBeNull()
  })

  it('无 z 前缀的 34B 载荷（legacy 形态套 canonical 载荷）→ null（不按长度放行）', () => {
    const payload = new Uint8Array(34)
    payload[0] = 0xed
    payload[1] = 0x01
    payload.set(pk(0x41), 2)
    expect(didPubkeyBytes(`did:youling:${bs58.encode(payload)}`)).toBeNull()
  })

  it('z 前缀但载荷非「34B + 0xed01」→ null', () => {
    const wrong = new Uint8Array(34)
    wrong[0] = 0x12
    wrong[1] = 0x00
    wrong.set(pk(0x41), 2)
    expect(didPubkeyBytes(`did:youling:z${bs58.encode(wrong)}`)).toBeNull()
    expect(didPubkeyBytes(`did:youling:z${bs58.encode(pk(0x41).slice(0, 10))}`)).toBeNull()
  })

  it('判定以解码结果为准：32B 裸 base58 以 z 开头也不冒充 canonical / 不回落 legacy', () => {
    expect(Z_PREFIXED_RAW_B58.startsWith('z')).toBe(true)
    expect(bs58.decode(Z_PREFIXED_RAW_B58).length).toBe(32)
    expect(didPubkeyBytes(`did:myco:${Z_PREFIXED_RAW_B58}`)).toBeNull()
    expect(didPubkeyBytes(`did:youling:${Z_PREFIXED_RAW_B58}`)).toBeNull()
  })

  it('软 did / 群 id / 非 32B / 非 did:myco|youling 前缀 → null（不误判）', () => {
    expect(didPubkeyBytes('did:youling:BOB')).toBeNull() // 'O' 不在 base58 字母表
    expect(didPubkeyBytes('grp-1a0eb64aa34')).toBeNull()
    expect(didPubkeyBytes('did:key:z6Mk')).toBeNull()
    expect(didPubkeyBytes('')).toBeNull()
    expect(didPubkeyBytes(`did:youling:${b58(0x41).slice(0, 10)}`)).toBeNull() // 截断串
  })
})

describe('accountDidCanonical / accountDidAliases（canonical 归一键 + 存量文件名枚举）', () => {
  it('双前缀 canonical 都归一到 canonical did:youling:z…', () => {
    const want = youlingCanon(0x42)
    for (const d of [mycoCanon(0x42), want]) {
      expect(accountDidCanonical(d)).toBe(want)
    }
  })

  it('legacy 输入不再归一（原样返回）', () => {
    expect(accountDidCanonical(mycoLegacy(0x42))).toBe(mycoLegacy(0x42))
    expect(accountDidCanonical(youlingLegacy(0x42))).toBe(youlingLegacy(0x42))
  })

  it('别名表（canonical 输入）：canonical 首位 + 双前缀 canonical + legacy 串枚举（存量文件名归并读取）', () => {
    const from = accountDidAliases(mycoCanon(0x43))
    expect(from[0]).toBe(youlingCanon(0x43))
    for (const d of [mycoCanon(0x43), youlingCanon(0x43), mycoLegacy(0x43), youlingLegacy(0x43)]) {
      expect(from).toContain(d)
    }
    expect(new Set(from).size).toBe(from.length)
    // 两个 canonical 形态出发集合一致（写目标一致）
    expect([...accountDidAliases(youlingCanon(0x43))].sort()).toEqual([...from].sort())
    // 跨钥匙不混入
    const other = accountDidAliases(mycoCanon(0x44))
    expect(other.some((d) => from.includes(d))).toBe(false)
    // 非账号串只有自己
    expect(accountDidAliases('did:youling:BOB')).toEqual(['did:youling:BOB'])
    expect(accountDidAliases('grp-1a0eb64aa34')).toEqual(['grp-1a0eb64aa34'])
  })

  it('别名表（legacy 输入）退化为只有原串——legacy 串仅供存量文件归并，不得用于验签/放行', () => {
    expect(accountDidAliases(mycoLegacy(0x43))).toEqual([mycoLegacy(0x43)])
  })
})

describe('accountDidEq（canonical-only 公钥级同判定）', () => {
  it('双 method canonical 同钥等价；不同钥匙不等价', () => {
    expect(accountDidEq(mycoCanon(0x45), youlingCanon(0x45))).toBe(true)
    expect(accountDidEq(mycoCanon(0x45), mycoCanon(0x46))).toBe(false)
  })

  it('legacy 不再等价：与 canonical、与孪生 legacy 都不等价；逐字相等仍等价', () => {
    expect(accountDidEq(mycoLegacy(0x45), youlingCanon(0x45))).toBe(false)
    expect(accountDidEq(mycoLegacy(0x45), mycoCanon(0x45))).toBe(false)
    expect(accountDidEq(mycoLegacy(0x45), youlingLegacy(0x45))).toBe(false) // 前缀孪生兜底已删
    expect(accountDidEq(mycoLegacy(0x45), mycoLegacy(0x45))).toBe(true)
  })

  it('软 did / null / 空串：解析不出公钥一律退回逐字比较（不再认前缀孪生）', () => {
    expect(accountDidEq('did:myco:BOB', 'did:youling:BOB')).toBe(false)
    expect(accountDidEq('did:youling:BOB', 'did:youling:BOB')).toBe(true)
    expect(accountDidEq('did:youling:BOB', 'did:youling:BOA')).toBe(false)
    expect(accountDidEq(null, 'did:youling:BOB')).toBe(false)
    expect(accountDidEq('', '')).toBe(false)
  })
})

describe('会话存储键（convKey / convSafe / convSafesAll / restoreDidSafe）', () => {
  it('did_safe 下划线形态可还原（仅公钥可解析时）；legacy/软 did 串不误改', () => {
    expect(restoreDidSafe(didSafeId(mycoCanon(0x47)))).toBe(mycoCanon(0x47))
    expect(restoreDidSafe(didSafeId(youlingCanon(0x47)))).toBe(youlingCanon(0x47))
    expect(restoreDidSafe(didSafeId(mycoLegacy(0x47)))).toBeNull() // legacy 已废止：不再还原
    expect(restoreDidSafe('did_youling_BOB')).toBeNull()
    expect(restoreDidSafe('grp-1a0')).toBeNull()
  })

  it('canonical 双形态 + did_safe 形态 → 同一归一键/同一 safe 键；群 id/软 did 原样', () => {
    const canon = youlingCanon(0x48)
    const forms = [mycoCanon(0x48), canon, didSafeId(mycoCanon(0x48)), didSafeId(canon)]
    for (const f of forms) {
      expect(convKey(f)).toBe(canon)
      expect(convSafe(f)).toBe(didSafeId(canon))
    }
    expect(convKey('grp-1a0eb64aa34')).toBe('grp-1a0eb64aa34')
    expect(convKey('did:youling:BOB')).toBe('did:youling:BOB')
    expect(convSafe('did:youling:BOB')).toBe('did_youling_BOB')
    // 不同钥匙不同键
    expect(convSafe(mycoCanon(0x48))).not.toBe(convSafe(mycoCanon(0x49)))
    // legacy did 已废止：不归一（原样进出）；其命名的历史文件由 canonical 侧别名表归并读
    expect(convKey(mycoLegacy(0x48))).toBe(mycoLegacy(0x48))
  })

  it('归并键表包含全部等价形态（归一键首位）；群 id 只有一个；legacy 输入退化', () => {
    const canon = youlingCanon(0x4a)
    const all = convSafesAll(mycoCanon(0x4a))
    expect(all[0]).toBe(didSafeId(canon))
    for (const d of accountDidAliases(mycoCanon(0x4a))) expect(all).toContain(didSafeId(d))
    expect(all).toContain(didSafeId(mycoLegacy(0x4a))) // 存量 legacy 命名的会话文件仍归并读取
    expect(all).toContain(didSafeId(youlingCanon(0x4a)))
    expect(new Set(all).size).toBe(all.length)
    expect(convSafesAll('grp-x')).toEqual(['grp-x'])
    // legacy 输入不再解码 → 只有自己一个键（不再归并）
    expect(convSafesAll(mycoLegacy(0x4a))).toEqual([didSafeId(mycoLegacy(0x4a))])
  })

  it('normalizeAccountDid 保留旧语义（只归前缀，不归格式）', () => {
    expect(normalizeAccountDid('did:myco:7S2Y')).toBe('did:youling:7S2Y')
    expect(normalizeAccountDid(mycoLegacy(0x4b))).toBe(youlingLegacy(0x4b)) // 前缀变、格式不变
  })
})
