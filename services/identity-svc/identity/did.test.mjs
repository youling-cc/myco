// identity/did.test.mjs — DID 字符串构造/解析/base58 往返测试。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  base58Encode, base58Decode,
  didFromPublicKey, parseCryptoDid, isCryptoDid, isSoftDid, isValidDid,
  canonicalMethodId, normalizeDid,
} from './did.mjs'

const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((b) => parseInt(b, 16)))

test('base58: 往返随机字节', () => {
  for (let i = 0; i < 20; i += 1) {
    const n = 1 + Math.floor(Math.random() * 50)
    const bytes = new Uint8Array(n).map(() => Math.floor(Math.random() * 256))
    assert.deepEqual(base58Decode(base58Encode(bytes)), bytes)
  }
})

test('base58: 前导零字节映射为前导 1', () => {
  const bytes = fromHex('000000ff')
  const s = base58Encode(bytes)
  assert.equal(s.slice(0, 3), '111')
  assert.deepEqual(base58Decode(s), bytes)
})

test('didFromPublicKey: 32 字节公钥 → did:myco:<base58>', () => {
  const pk = fromHex('3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29') // RFC8032 testvec pub
  const did = didFromPublicKey(pk)
  assert.ok(did.startsWith('did:myco:'))
  assert.equal(did.length > 'did:myco:'.length + 40, true)
})

test('did 确定性：同公钥同 did；不同公钥不同 did', () => {
  const pk1 = fromHex('3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29')
  const pk2 = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
  assert.equal(didFromPublicKey(pk1), didFromPublicKey(pk1))
  assert.notEqual(didFromPublicKey(pk1), didFromPublicKey(pk2))
})

test('parseCryptoDid: did → 还原原公钥字节', () => {
  const pk = fromHex('3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29')
  const did = didFromPublicKey(pk)
  const parsed = parseCryptoDid(did)
  assert.deepEqual(parsed.idBytes, pk)
})

test('did 形态判别：加密/软/非法', () => {
  const pk = fromHex('3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29')
  const cryptoDid = didFromPublicKey(pk)
  const softDid = 'did:myco:participant:alice'
  assert.equal(isCryptoDid(cryptoDid), true)
  assert.equal(isSoftDid(cryptoDid), false)
  assert.equal(isSoftDid(softDid), true)
  assert.equal(isCryptoDid(softDid), false)
  assert.equal(isValidDid(cryptoDid), true)
  assert.equal(isValidDid(softDid), true)
  assert.equal(isValidDid('did:myco:!!!notbase58'), false)
  assert.equal(isValidDid('not a did'), false)
  assert.equal(isValidDid('did:eth:0xabc'), false)
})

test('parseCryptoDid 对软 did / 非法 did 返回 null', () => {
  assert.equal(parseCryptoDid('did:myco:participant:alice'), null)
  assert.equal(parseCryptoDid('garbage'), null)
})

// ══ spec v0.3 Multibase 双格式（2026-09-30）══

const RFC_PK = fromHex('3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29') // RFC8032 testvec pub

test('v0.3: didFromPublicKey 默认 canonical（did:myco:z…），字节序=base58btc(0xed 0x01 + 公钥)', () => {
  const did = didFromPublicKey(RFC_PK)
  assert.ok(did.startsWith('did:myco:z'), `应以 z 开头: ${did}`)
  const payload = base58Decode(did.slice('did:myco:z'.length))
  assert.equal(payload.byteLength, 34)
  assert.equal(payload[0], 0xed)
  assert.equal(payload[1], 0x01)
  assert.deepEqual(payload.slice(2), RFC_PK)
})

test('v0.3 收敛: legacy 裸 base58（32B）被 parseCryptoDid 拒（2026-10-10 canonical-only）', () => {
  const canonical = didFromPublicKey(RFC_PK)
  const legacy = 'did:myco:' + base58Encode(RFC_PK)
  assert.ok(legacy.startsWith('did:myco:'))
  assert.notEqual(legacy, canonical)
  const pc = parseCryptoDid(canonical)
  assert.deepEqual(pc.idBytes, RFC_PK)
  assert.equal(pc.format, 'canonical')
  // legacy 串不再回落解析——统一口径：34B 载荷 + 0xed 0x01 头，否则 null
  assert.equal(parseCryptoDid(legacy), null, 'legacy 裸 base58 应被拒: ' + legacy)
})

test('v0.3: 与 did:key 同构——did:youling:z<知名向量> 解出同一公钥', () => {
  // did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK 的载荷即 ed01+公钥
  const mb = '6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
  const expectedKey = base58Decode(mb).slice(2)
  assert.equal(base58Decode(mb).byteLength, 34)
  const p = parseCryptoDid('did:youling:z' + mb)
  assert.deepEqual(p.idBytes, expectedKey)
  assert.equal(p.format, 'canonical')
  // 同一把钥匙在本方法下重铸 canonical，multibase 段逐字节一致
  assert.equal(canonicalMethodId(expectedKey), 'z' + mb)
})

test('v0.3 非法向量四类：短载荷/错 multicodec 头/非 base58 字符/legacy 长度不对', () => {
  // ① 短：z + base58(10 字节)
  assert.equal(parseCryptoDid('did:myco:z' + base58Encode(fromHex('0102030405060708090a'))), null)
  // ② 错前缀：34 字节但头不是 ed01（此处 0x00 0x01）
  const wrongHead = new Uint8Array(34); wrongHead.set([0x00, 0x01], 0)
  assert.equal(parseCryptoDid('did:myco:z' + base58Encode(wrongHead)), null)
  // ③ 非 base58 字符（0/O/I/l 不在比特币字母表）
  assert.equal(parseCryptoDid('did:myco:z0OIl'), null)
  assert.equal(parseCryptoDid('did:myco:0OIl'), null)
  // ④ 非 z 尾段（legacy 家族）：canonical-only 后不走回落，直接 null
  assert.equal(parseCryptoDid('did:myco:' + base58Encode(new Uint8Array(33))), null)
})

test('v0.3 收敛: legacy 串可能以 z 开头——不再回落，z 分支解析失败即拒（2026-10-10 反转钉住）', () => {
  // 2026-10-08 修正：32B 值域 base58 编码可短至 43 位，43 位串首位上界 = 57 ⇒ 'z'
  // 可达（约 5% 钥匙是 43 位编码，其中约 1/57 以 z 开头）——「z 开头=canonical」
  // 不是无歧义判定。2026-10-10 canonical-only 收敛后，回流分支已删：这类串进 z
  // 分支后因载荷≠34B/头错被拒——本测试搜一个以 z 开头的真实 32B 公钥，钉住「拒」。
  let hit = null
  for (let i = 0; i < 200000 && !hit; i += 1) {
    const key = new Uint8Array(32).map(() => Math.floor(Math.random() * 256))
    const s = base58Encode(key)
    if (s.startsWith('z')) hit = { key, s }
  }
  assert.ok(hit, '200k 次内应能搜到以 z 开头的 legacy 串（单次概率约 0.09%）')
  const p = parseCryptoDid('did:myco:' + hit.s)
  assert.equal(p, null, '以 z 开头的 43 位 legacy 串应被拒（无回落）: ' + hit.s)
  // 极端上界钥匙（0xff 全填充）是 44 位编码，首位不到 'z'
  const maxKey = fromHex('ff'.repeat(32))
  assert.ok(!base58Encode(maxKey).startsWith('z'))
})

test('v0.3 收敛: normalizeDid——canonical 幂等、legacy 归 null（不再换桶，2026-10-10）', () => {
  const canonical = didFromPublicKey(RFC_PK)
  const legacy = 'did:myco:' + base58Encode(RFC_PK)
  assert.equal(normalizeDid(canonical), canonical)
  assert.equal(normalizeDid(legacy), null, 'legacy 串不再归一到 canonical')
  assert.equal(normalizeDid('did:myco:participant:x'), null)
  assert.equal(normalizeDid('garbage'), null)
  // method 前缀保留：youling canonical 归一后仍是 youling
  assert.ok(normalizeDid('did:youling:' + canonical.slice('did:myco:'.length)).startsWith('did:youling:z'))
  assert.equal(normalizeDid('did:youling:' + base58Encode(RFC_PK)), null, 'youling legacy 同样拒')
})

test('v0.3 收敛: isCryptoDid/isValidDid 只收 canonical（legacy 一律 false，2026-10-10）', () => {
  const canonical = didFromPublicKey(RFC_PK)
  const legacy = 'did:myco:' + base58Encode(RFC_PK)
  assert.equal(isCryptoDid(canonical), true)
  assert.equal(isCryptoDid(legacy), false)
  assert.equal(isValidDid(canonical), true)
  assert.equal(isValidDid(legacy), false)
})
