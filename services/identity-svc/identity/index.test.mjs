// identity/index.test.mjs — createIdentityApi 端到端调度测试（真实 Ed25519 密钥走完整注册/登录）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIdentityApi, IdentityStore } from './index.mjs'
import {
  generateKeyPair, exportPublicKeyRaw, exportPrivateKeyPkcs8,
  importPrivateKey, sign, deriveKeyFromPassword, encrypt, decrypt, randomBytes,
} from './crypto.mjs'
import { didFromPublicKey, base58Encode } from './did.mjs'

function enc() { return new TextEncoder() }

/** 公钥 raw → legacy 裸 base58 did 串（v0.3 前形态；2026-10-10 收敛后手搓构造，
 *  didFromPublicKey 已 canonical-only 不再提供 legacy 出口）。 */
const legacyDidOf = (pkRaw) => 'did:myco:' + base58Encode(new Uint8Array(pkRaw))

/** 模拟浏览器侧：生成密钥对 + 用密码加密私钥 + 返回注册所需 payload。 */
async function browserRegisterPayload(password) {
  const { publicKey, privateKey } = await generateKeyPair()
  const pkRaw = await exportPublicKeyRaw(publicKey)
  const pkcs8 = await exportPrivateKeyPkcs8(privateKey)
  const salt = randomBytes(16)
  const key = await deriveKeyFromPassword(password, salt, 100_000) // 测试用低 iters 加速
  const { ciphertext, iv } = await encrypt(key, pkcs8)
  return {
    publicKeyB64: Buffer.from(pkRaw).toString('base64'),
    ciphertextB64: Buffer.from(ciphertext).toString('base64'),
    saltB64: Buffer.from(salt).toString('base64'),
    ivB64: Buffer.from(iv).toString('base64'),
    iters: 100_000,
    // 保留私钥供后续登录签名
    _privateKey: privateKey,
    _pkRaw: pkRaw,
  }
}

async function newApi() {
  const store = new IdentityStore({ memory: true, now: () => 1_000_000 })
  await store.open()
  return { store, api: createIdentityApi({ store, challengeTtlMs: 60_000, sessionTtlMs: 3600_000 }) }
}

async function post(api, pathname, body) {
  return api.handle({ method: 'POST', pathname, body })
}

test('register→challenge→login 全流程通过，返回有效会话 token', async () => {
  const { api, store } = await newApi()
  const reg = await browserRegisterPayload('correct-horse')
  const r1 = await post(api, '/identity/register', reg)
  assert.equal(r1.status, 201)
  assert.ok(r1.body.did.startsWith('did:myco:'))
  assert.equal(r1.body.didDocument.id, r1.body.did)

  // 登录：浏览器用私钥对 "did\nnonce" 签名
  const r2 = await post(api, '/identity/challenge', { did: r1.body.did })
  assert.equal(r2.status, 200)
  const message = `${r1.body.did}\n${r2.body.nonce}`
  const sig = await sign(reg._privateKey, enc().encode(message))

  const r3 = await post(api, '/identity/login', {
    did: r1.body.did, nonce: r2.body.nonce,
    signatureB64: Buffer.from(sig).toString('base64'),
  })
  assert.equal(r3.status, 200)
  assert.ok(r3.body.token)
  assert.equal(r3.body.did, r1.body.did)
  // 会话可被 verify 校验
  const r4 = await post(api, '/identity/verify', { token: r3.body.token })
  assert.equal(r4.status, 200)
  assert.equal(r4.body.did, r1.body.did)
  await store.close()
})

test('register: 重复公钥 → 409', async () => {
  const { api, store } = await newApi()
  const reg = await browserRegisterPayload('pw')
  assert.equal((await post(api, '/identity/register', reg)).status, 201)
  const r = await post(api, '/identity/register', reg)
  assert.equal(r.status, 409)
  await store.close()
})

test('v0.3: 注册响应按 canonical 返回（z 开头 multibase）', async () => {
  const { api, store } = await newApi()
  const reg = await browserRegisterPayload('pw')
  const r = await post(api, '/identity/register', reg)
  assert.equal(r.status, 201)
  assert.ok(r.body.did.startsWith('did:myco:z'), '应 canonical: ' + r.body.did)
  assert.equal(r.body.didDocument.id, r.body.did)
  await store.close()
})

test('v0.3: legacy 设备 did 登录被闸门拒——400 unsupported_did_format（2026-10-08 设备面单形态定稿）', async () => {
  const { api, store } = await newApi()
  const reg = await browserRegisterPayload('pw')
  // 服务器注册（canonical 落库）
  await post(api, '/identity/register', reg)
  // 客户端持 legacy 串（未升级老客户端形态）
  const legacyDid = legacyDidOf(reg._pkRaw)
  // 原用例断言（作废）：legacy 串领挑战 200 + 登录 200（双格式变体兜底）。删因：
  // 设备面单形态定稿——老客户端 legacy did 一律 400 引导升级（清档后全员重注册
  // 正是切换点；同一把 device.key 在新客户端派生即 canonical，无需换钥）。
  // 注意用「与 canonical 不等」而非「不含 :z」断言——43 位 legacy 串可以 z 开头
  // （base58 编码歧义，2026-10-08 实测修正）。
  assert.notEqual(legacyDid, didFromPublicKey(reg._pkRaw))
  const r2 = await post(api, '/identity/challenge', { did: legacyDid })
  assert.equal(r2.status, 400, 'legacy did 领挑战应被拒')
  assert.equal(r2.body.code, 'unsupported_did_format', JSON.stringify(r2.body))
  // 登录同样 400（闸门在 store 查找之前）
  const sig = await sign(reg._privateKey, enc().encode(legacyDid + '\nnonce-x'))
  const r3 = await post(api, '/identity/login', {
    did: legacyDid, nonce: 'nonce-x',
    signatureB64: Buffer.from(sig).toString('base64'),
  })
  assert.equal(r3.status, 400)
  assert.equal(r3.body.code, 'unsupported_did_format')
  await store.close()
})

test('register: 字段缺失 → 400；公钥非 32 字节 → 400', async () => {
  const { api, store } = await newApi()
  assert.equal((await post(api, '/identity/register', {})).status, 400)
  const r = await post(api, '/identity/register', {
    publicKeyB64: Buffer.from(new Uint8Array(10)).toString('base64'),
    ciphertextB64: 'c', saltB64: 's', ivB64: 'i', iters: 1,
  })
  assert.equal(r.status, 400)
  await store.close()
})

test('login: 签名被篡改 → 401；不签名挑战也能拒', async () => {
  const { api, store } = await newApi()
  const reg = await browserRegisterPayload('pw')
  const r1 = await post(api, '/identity/register', reg)
  const r2 = await post(api, '/identity/challenge', { did: r1.body.did })
  // 用错误内容签名
  const badSig = await sign(reg._privateKey, enc().encode('tampered'))
  const r3 = await post(api, '/identity/login', {
    did: r1.body.did, nonce: r2.body.nonce,
    signatureB64: Buffer.from(badSig).toString('base64'),
  })
  assert.equal(r3.status, 401)
  await store.close()
})

test('challenge: 软 did / 未注册 / 非法 did → 拒', async () => {
  const { api, store } = await newApi()
  assert.equal((await post(api, '/identity/challenge', { did: 'did:myco:participant:alice' })).status, 400)
  // 合法加密 did 但未注册 → 404
  const unregistered = didFromPublicKey(randomBytes(32))
  assert.equal((await post(api, '/identity/challenge', { did: unregistered })).status, 404)
  await store.close()
})

test('login: 挑战一次性——同 nonce 第二次登录失败', async () => {
  const { api, store } = await newApi()
  const reg = await browserRegisterPayload('pw')
  const r1 = await post(api, '/identity/register', reg)
  const r2 = await post(api, '/identity/challenge', { did: r1.body.did })
  const message = `${r1.body.did}\n${r2.body.nonce}`
  const sig = () => sign(reg._privateKey, enc().encode(message)).then((s) => Buffer.from(s).toString('base64'))
  const r3 = await post(api, '/identity/login', { did: r1.body.did, nonce: r2.body.nonce, signatureB64: await sig() })
  assert.equal(r3.status, 200)
  // 同 nonce 再来一次：挑战已被消费
  const r4 = await post(api, '/identity/login', { did: r1.body.did, nonce: r2.body.nonce, signatureB64: await sig() })
  assert.equal(r4.status, 401)
  await store.close()
})

test('ciphertext: 多设备恢复取回加密私钥密文', async () => {
  const { api, store } = await newApi()
  const reg = await browserRegisterPayload('pw')
  const r1 = await post(api, '/identity/register', reg)
  const r2 = await post(api, '/identity/ciphertext', { did: r1.body.did })
  assert.equal(r2.status, 200)
  assert.equal(r2.body.ciphertextB64, reg.ciphertextB64)
  assert.equal(r2.body.saltB64, reg.saltB64)
  assert.equal(r2.body.ivB64, reg.ivB64)
  assert.equal(r2.body.iters, reg.iters)
  await store.close()
})

test('handle: 非 POST / 未知路由 → 405/404；解密还原私钥可验签', async () => {
  const { api, store } = await newApi()
  assert.equal((await api.handle({ method: 'GET', pathname: '/identity/register' })).status, 405)
  assert.equal((await post(api, '/identity/whatever', {})).status, 404)

  // 端到端恢复：注册 → 取密文 → 用密码解出私钥 → 能签名
  const reg = await browserRegisterPayload('pw')
  const r1 = await post(api, '/identity/register', reg)
  const r2 = await post(api, '/identity/ciphertext', { did: r1.body.did })
  const key = await deriveKeyFromPassword('pw', new Uint8Array(Buffer.from(r2.body.saltB64, 'base64')), r2.body.iters)
  const pkcs8 = await decrypt(key,
    new Uint8Array(Buffer.from(r2.body.ciphertextB64, 'base64')),
    new Uint8Array(Buffer.from(r2.body.ivB64, 'base64')))
  const priv = await importPrivateKey(new Uint8Array(pkcs8))
  const sig = await sign(priv, enc().encode('hello'))
  assert.ok(sig.byteLength > 0)
  await store.close()
})
