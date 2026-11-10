// identity/root.didformat.test.mjs — /root/* 的 spec v0.3 双格式行为：
// canonical/legacy 注册均通过派生校验（协议层双格式能力保留）；
// 但查询是单形态精确匹配（2026-10-06 删号窗口清理：三形态归一查找已删，
// 删号=清库+客户端重新注册，行键与出示形态天然一致）。
// （rootSig 用真实 WebCrypto Ed25519 签，走完整验签路径——与线上一致。）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRootApi } from './root.mjs'
import { generateKeyPair, exportPublicKeyRaw, sign } from './crypto.mjs'
import { didFromPublicKey, base58Encode } from './did.mjs'

function enc() { return new TextEncoder() }
const b64 = (u8) => Buffer.from(u8).toString('base64')

async function newKey() {
  const { publicKey, privateKey } = await generateKeyPair()
  const raw = await exportPublicKeyRaw(publicKey)
  return { raw, privateKey, pubB64: b64(raw) }
}

async function createRoot(api, rootDid, key, devicePubB64) {
  const msg = enc().encode(`create\n${rootDid}\n${key.pubB64}`)
  const sig = await sign(key.privateKey, msg)
  return api.handle('POST', '/root/create', {
    rootDid, rootPubkeyB64: key.pubB64, devicePubkeyB64: devicePubB64,
    name: 't', rootSig: b64(sig),
  })
}

test('root: v0.3 canonical 注册通过派生校验，响应返回 canonical 串', async () => {
  const api = createRootApi({ dbPath: ':memory:' })
  const key = await newKey()
  const dev = await newKey()
  const canonical = didFromPublicKey(key.raw) // did:myco:z…（canonical 构造同字节序）
  const rootDid = 'did:youling:' + canonical.slice('did:myco:'.length)
  const r = await createRoot(api, rootDid, key, dev.pubB64)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.data.rootDid, rootDid)
  // 读回：canonical 串查到
  assert.equal(api.getRoot(rootDid)?.rootDid, rootDid)
})

// 2026-10-07 清档定稿改写：原「legacy 注册仍通过（存量兼容）」作废——/root/create
// 已加格式闸门只收 canonical（杜绝清档后旧格式账号被自愈回填），legacy 一律 400 引导解绑。
test('root: legacy 注册被格式闸门拒（400 unsupported_did_format，引导解绑重注册）', async () => {
  const api = createRootApi({ dbPath: ':memory:' })
  const key = await newKey()
  const dev = await newKey()
  const legacyRootDid = 'did:youling:' + base58Encode(key.raw) // 2026-10-10 收敛：legacy 串手搓
  const r = await createRoot(api, legacyRootDid, key, dev.pubB64)
  assert.equal(r.status, 400, JSON.stringify(r.body))
  assert.equal(r.body.code, 'unsupported_did_format')
  assert.ok(String(r.body.error).includes('解绑'), '错误信息应含解绑引导')
  // 库中无该行（闸住未落库）
  assert.equal(api.getRoot(legacyRootDid), null)
})

test('root: 派生不符仍拒（冒用他人 did + 自己钥匙）', async () => {
  const api = createRootApi({ dbPath: ':memory:' })
  const key = await newKey()
  const other = await newKey()
  const dev = await newKey()
  const otherDid = didFromPublicKey(other.raw).replace('did:myco:', 'did:youling:')
  const r = await createRoot(api, otherDid, key, dev.pubB64)
  assert.equal(r.status, 400)
  assert.ok(String(r.body.error).startsWith('derivation_mismatch'))
})

// ══ 2026-10-06 删号窗口清理：单形态精确查询（三形态归一查找已删）══
// 历史行为（2026-09-30 跨前缀归一：did:myco: 存量行 ↔ did:youling: 出示形态
// 三形态寻址同一行）随删号定稿移除——删号=清库+客户端重新注册，不再有跨形态
// 存量行要兼容。此处回归锁死新语义：不同形态查同一公钥的行 → 不命中。

/** 同公钥三形态：did:myco:b58 / did:youling:b58（legacy）/ did:youling:z…（canonical）。 */
function threeForms(raw) {
  const mycoLegacy = 'did:myco:' + base58Encode(raw) // did:myco:b58（2026-10-10 收敛：手搓）
  const youlingLegacy = mycoLegacy.replace('did:myco:', 'did:youling:')
  const youlingCanonical = didFromPublicKey(raw).replace('did:myco:', 'did:youling:') // did:youling:z…
  return { mycoLegacy, youlingLegacy, youlingCanonical }
}

test('root: 单形态精确查询——异形态串不命中（归一查找已删）', async () => {
  const api = createRootApi({ dbPath: ':memory:' })
  const key = await newKey()
  const dev = await newKey()
  const { mycoLegacy, youlingLegacy, youlingCanonical } = threeForms(key.raw)
  // 以 canonical 形态落库
  assert.equal((await createRoot(api, youlingCanonical, key, dev.pubB64)).status, 201)
  // 本形态命中
  assert.equal(api.getRoot(youlingCanonical)?.rootDid, youlingCanonical)
  // 其余两形态不再兜底命中
  assert.equal(api.getRoot(mycoLegacy), null, 'did:myco: 形态不应命中 canonical 行')
  assert.equal(api.getRoot(youlingLegacy), null, 'legacy 形态不应命中 canonical 行')
  const g = await api.handle('GET', `/root/${encodeURIComponent(mycoLegacy)}`, {})
  assert.equal(g.status, 404, '异形态 GET 应 404')
})

test('root: 同形态改名/加设备/吊销照常工作（精确行键）', async () => {
  const api = createRootApi({ dbPath: ':memory:' })
  const key = await newKey()
  const dev = await newKey()
  const dev2 = await newKey()
  const youlingCanonical = didFromPublicKey(key.raw).replace('did:myco:', 'did:youling:')
  assert.equal((await createRoot(api, youlingCanonical, key, dev.pubB64)).status, 201)
  // 改名（签名材料=同形态串，验签过 + 真落库）
  const sig = await sign(key.privateKey, enc().encode(`rename\n${youlingCanonical}\ncjfan`))
  const r = await api.handle('POST', '/root/rename', { rootDid: youlingCanonical, name: 'cjfan', sigB64: b64(sig) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(api.getRoot(youlingCanonical)?.name, 'cjfan')
  // 加设备落在同一行键
  const issuedAt = Date.now()
  const attest = await sign(key.privateKey, enc().encode(`attest\n${youlingCanonical}\n${dev2.pubB64}\n${issuedAt}`))
  const add = await api.handle('POST', '/root/device/add', { rootDid: youlingCanonical, pubkeyB64: dev2.pubB64, name: 'phone', issuedAt, attestSigB64: b64(attest) })
  assert.equal(add.status, 200)
  assert.equal(add.body.data.rootDid, youlingCanonical)
  assert.equal(api.getRoot(youlingCanonical)?.devices.length, 2)
  // 吊销
  const revokeSig = await sign(key.privateKey, enc().encode(`revoke\n${youlingCanonical}\n${dev2.pubB64}`))
  const rv = await api.handle('POST', '/root/device/revoke', { rootDid: youlingCanonical, pubkeyB64: dev2.pubB64, rootSig: b64(revokeSig) })
  assert.equal(rv.status, 200)
  assert.equal(api.activeDeviceKeys(youlingCanonical).length, 1)
})

// 2026-10-07 清档定稿改写：原「同公钥异形态重复注册 did_conflict」作废——格式闸门后
// 旧形态 create 直接 400（到不了查重）；幂等容忍语义缩为 canonical 同串重复。
test('root: canonical 重复注册 did_conflict（幂等容忍，不误报 pubkey_conflict）', async () => {
  const api = createRootApi({ dbPath: ':memory:' })
  const key = await newKey()
  const dev = await newKey()
  const youlingCanonical = didFromPublicKey(key.raw).replace('did:myco:', 'did:youling:')
  assert.equal((await createRoot(api, youlingCanonical, key, dev.pubB64)).status, 201)
  const r = await createRoot(api, youlingCanonical, key, dev.pubB64)
  assert.equal(r.status, 409)
  assert.equal(r.body.code, 'did_conflict', `应 did_conflict，得到 ${JSON.stringify(r.body)}`)
})

// （family 残留回归锁测试在独立文件 root.family-regress.test.mjs——
// root.mjs 的 _db 是模块级单例，本文件的 :memory: 已占用，文件路径场景必须独立文件先初始化）
