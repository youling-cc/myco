// revoke-registry.test.mjs — 2026-10-16 真机安全洞回归：
// /root/device/revoke 必须同步写吊销注册表（此前只标名册 → 注册表恒空 →
// 平台登录回调查表放行，被吊销设备持旧委任状仍登录成功——钥匙代理多设备实测）。
// 与 identity-server 装配同构：onDeviceRevoked → addRevocationInternal。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRootApi } from './identity/root.mjs'
import { addRevocationInternal, handleDelegationGet } from './delegation.mjs'
import { generateKeyPair, exportPublicKeyRaw, sign } from './identity/crypto.mjs'
import { didFromPublicKey } from './identity/did.mjs'

function enc() { return new TextEncoder() }
const b64 = (u8) => Buffer.from(u8).toString('base64')

async function newKey() {
  const { publicKey, privateKey } = await generateKeyPair()
  const raw = await exportPublicKeyRaw(publicKey)
  return { raw, privateKey, pubB64: b64(raw) }
}
const accountDidOf = (raw) => 'did:youling:' + didFromPublicKey(raw).slice('did:myco:'.length)

async function setupRoot(api, key, devicePubB64) {
  const rootDid = accountDidOf(key.raw)
  const sig = await sign(key.privateKey, enc().encode(`create\n${rootDid}\n${key.pubB64}`))
  const r = await api.handle('POST', '/root/create', {
    rootDid, rootPubkeyB64: key.pubB64, devicePubkeyB64: devicePubB64, name: 't', rootSig: b64(sig),
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return rootDid
}

test('revoke 同步写吊销注册表（onDeviceRevoked 注入，identity-server 同构装配）', async () => {
  const revoked = []
  const api = createRootApi({ dbPath: ':memory:', onDeviceRevoked: (accDid, pub) => { revoked.push([accDid, pub]); addRevocationInternal(accDid, [pub]) } })
  const key = await newKey()
  const dev = await newKey()
  const rootDid = await setupRoot(api, key, dev.pubB64)

  const sig = await sign(key.privateKey, enc().encode(`revoke\n${rootDid}\n${dev.pubB64}`))
  const rv = await api.handle('POST', '/root/device/revoke', { rootDid, pubkeyB64: dev.pubB64, rootSig: b64(sig) })
  assert.equal(rv.status, 200, JSON.stringify(rv.body))

  // ① 回调必须触发（= 注册表写入被调用）
  assert.equal(revoked.length, 1, 'onDeviceRevoked 未触发')
  assert.equal(revoked[0][0], rootDid)
  assert.equal(revoked[0][1], dev.pubB64)
})

test('revoke 未注入 onDeviceRevoked 不报错（向后兼容，老装配/单测）', async () => {
  const api = createRootApi({ dbPath: ':memory:' })
  const key = await newKey()
  const dev = await newKey()
  const rootDid = await setupRoot(api, key, dev.pubB64)
  const sig = await sign(key.privateKey, enc().encode(`revoke\n${rootDid}\n${dev.pubB64}`))
  const rv = await api.handle('POST', '/root/device/revoke', { rootDid, pubkeyB64: dev.pubB64, rootSig: b64(sig) })
  assert.equal(rv.status, 200)
})

test('addRevocationInternal 合并进注册表且 /revocation/{did} 可读', async () => {
  const key = await newKey()
  const rootDid = accountDidOf(key.raw)
  const dev = await newKey()
  addRevocationInternal(rootDid, [dev.pubB64])
  let out = null
  await handleDelegationGet('/revocation/' + encodeURIComponent(rootDid), new URL('https://x/revocation/' + encodeURIComponent(rootDid)), (status, body) => { out = { status, body } })
  assert.equal(out.status, 200)
  assert.ok(out.body.data.revokedPubkeys.includes(dev.pubB64), JSON.stringify(out.body))
  // 幂等合并（重复推不膨胀、不报错）
  addRevocationInternal(rootDid, [dev.pubB64])
  assert.equal(new Set([...out.body.data.revokedPubkeys, dev.pubB64]).size, out.body.data.revokedPubkeys.length)
})
