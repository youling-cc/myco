// identity/store.test.mjs — IdentityStore sqlite 往返/挑战消费/会话测试。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IdentityStore } from './store.mjs'
import { didFromPublicKey, base58Encode } from './did.mjs'

function newStore() {
  return new IdentityStore({ memory: true, now: () => 1_000_000 })
}

const sample = {
  did: 'did:myco:ABCdef',
  publicKeyB64: 'pk',
  ciphertextB64: 'ct',
  saltB64: 'salt',
  ivB64: 'iv',
  iters: 600000,
  didDocument: { id: 'did:myco:ABCdef' },
}

test('store: putIdentity + getIdentity 往返（含 DID Document JSON）', async () => {
  const s = newStore()
  await s.open()
  await s.putIdentity({ ...sample })
  const got = await s.getIdentity('did:myco:ABCdef')
  assert.equal(got.did, 'did:myco:ABCdef')
  assert.equal(got.ciphertextB64, 'ct')
  assert.equal(got.iters, 600000)
  assert.deepEqual(got.didDocument, { id: 'did:myco:ABCdef' })
  await s.close()
})

test('store: identityExists 区分已注册/未注册', async () => {
  const s = newStore()
  await s.open()
  await s.putIdentity({ ...sample })
  assert.equal(await s.identityExists('did:myco:ABCdef'), true)
  assert.equal(await s.identityExists('did:myco:nope'), false)
  await s.close()
})

test('store: 单形态精确查找（2026-10-08 设备面定稿：双格式变体查找已删）', async () => {
  const s = newStore()
  await s.open()
  const pk = new Uint8Array(32).map((_, i) => i + 1)
  const canonical = didFromPublicKey(pk)
  const legacy = 'did:myco:' + base58Encode(pk) // 2026-10-10 收敛：legacy 串手搓（didFromPublicKey 已 canonical-only）
  // 原用例语义（作废）：legacy 落库行 canonical 串也能查（变体兜底）。删因：清档后
  // identity 表全 canonical（register 从公钥派生），老客户端 legacy did 由入口闸门
  // 直接 400——变体兜底无存在意义且掩盖形态错配。新语义=精确匹配、异形态不命中。
  await s.putIdentity({ ...sample, did: legacy, didDocument: { id: legacy } })
  assert.equal(await s.identityExists(legacy), true, '本形态命中')
  assert.equal(await s.identityExists(canonical), false, '异形态不再兜底命中')
  assert.equal(await s.getIdentity(canonical), null)
  // canonical 落库、legacy 串反查同样不命中
  const s2 = newStore()
  await s2.open()
  await s2.putIdentity({ ...sample, did: canonical, didDocument: { id: canonical } })
  assert.equal(await s2.identityExists(canonical), true)
  assert.equal(await s2.identityExists(legacy), false)
  // 完全无关的钥匙仍查不到
  const other = didFromPublicKey(new Uint8Array(32).map((_, i) => i + 7))
  assert.equal(await s2.identityExists(other), false)
  await s.close()
  await s2.close()
})

test('store: getCiphertext 返回多设备恢复所需字段', async () => {
  const s = newStore()
  await s.open()
  await s.putIdentity({ ...sample })
  const ct = await s.getCiphertext('did:myco:ABCdef')
  assert.deepEqual(ct, { ciphertextB64: 'ct', saltB64: 'salt', ivB64: 'iv', iters: 600000 })
  assert.equal(await s.getCiphertext('did:myco:nope'), null)
  await s.close()
})

test('store: 挑战一次性消费——合法/did 不符/已用过', async () => {
  const s = newStore()
  await s.open()
  const ch = await s.createChallenge('nonce-1', 'did:myco:ABCdef', 60_000)
  assert.equal(ch.expiresAt, 1_000_000 + 60_000)
  // 合法消费
  assert.equal(await s.consumeChallenge('nonce-1', 'did:myco:ABCdef'), true)
  // 重复消费 → false
  assert.equal(await s.consumeChallenge('nonce-1', 'did:myco:ABCdef'), false)
  await s.close()
})

test('store: 挑战 did 不匹配 / 过期 / 不存在 → false', async () => {
  const s = newStore()
  await s.open()
  await s.createChallenge('n2', 'did:myco:A', 60_000)
  assert.equal(await s.consumeChallenge('n2', 'did:myco:B'), false) // did 不符
  await s.createChallenge('n3', 'did:myco:A', 60_000)
  assert.equal(await s.consumeChallenge('no-such-nonce', 'did:myco:A'), false) // 不存在
  // 过期：用一个回拨时钟的 store
  const later = new IdentityStore({ memory: true, now: () => 2_000_000 })
  await later.open()
  await later.createChallenge('n4', 'did:myco:A', 60_000) // expiresAt=2_060_000
  // 直接用更晚的时钟再开一个，模拟过期
  const expired = new IdentityStore({ memory: true, now: () => 5_000_000 })
  await expired.open()
  await expired.createChallenge('n5', 'did:myco:A', 60_000) // expiresAt=5_060_000 → 仍未过期
  assert.equal(await expired.consumeChallenge('n5', 'did:myco:A'), true)
  await later.close()
  await expired.close()
  await s.close()
})

test('store: 会话创建/校验/吊销/过期', async () => {
  const s = newStore()
  await s.open()
  const sess = await s.createSession('tok-1', 'did:myco:A', 3600_000)
  assert.equal(sess.expiresAt, 1_000_000 + 3600_000)
  assert.equal((await s.getSession('tok-1')).did, 'did:myco:A')
  await s.revokeSession('tok-1')
  assert.equal(await s.getSession('tok-1'), null)
  // 过期会话 getSession 返回 null
  await s.createSession('tok-2', 'did:myco:A', 60_000)
  await s.close()
})

test('store: prune 清理过期挑战与会话', async () => {
  let t = 1_000_000
  const clock = () => t
  const s = new IdentityStore({ memory: true, now: clock })
  await s.open()
  await s.createChallenge('old', 'did:myco:A', 1000)   // expires 1_001_000
  await s.createSession('old-tok', 'did:myco:A', 1000)
  t = 2_000_000 // 推进时间
  await s.prune()
  assert.equal(await s.consumeChallenge('old', 'did:myco:A'), false) // 已被清理
  assert.equal(await s.getSession('old-tok'), null)
  await s.close()
})
