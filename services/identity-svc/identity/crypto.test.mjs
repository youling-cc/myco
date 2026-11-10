// identity/crypto.test.mjs — 纯密码原语测试（零依赖，globalThis.crypto.subtle）。
// 覆盖：Ed25519 密钥对/签名/验签/导入导出；PBKDF2 派生；AES-GCM 加解密。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  generateKeyPair, exportPublicKeyRaw, exportPrivateKeyPkcs8,
  importPublicKey, importPrivateKey, sign, verify,
  deriveKeyFromPassword, encrypt, decrypt, randomBytes,
} from './crypto.mjs'

const sub = globalThis.crypto.subtle
const enc = new TextEncoder()

test('Ed25519: 生成密钥对返回 CryptoKey', async () => {
  const { publicKey, privateKey } = await generateKeyPair()
  assert.equal(publicKey.type, 'public')
  assert.equal(privateKey.type, 'private') // 非对称私钥 type='private'
  assert.equal(publicKey.algorithm.name, 'Ed25519')
})

test('Ed25519: 签名/验签往返，篡改后失败', async () => {
  const { publicKey, privateKey } = await generateKeyPair()
  const msg = enc.encode('hello meeting-aop')
  const sig = await sign(privateKey, msg)
  assert.equal(await verify(publicKey, msg, sig), true)
  // 篡改消息
  const tampered = enc.encode('hello meeting-aop!')
  assert.equal(await verify(publicKey, tampered, sig), false)
  // 篡改签名
  const badSig = new Uint8Array(sig)
  badSig[0] ^= 0xff
  assert.equal(await verify(publicKey, msg, badSig), false)
})

test('公钥 raw 导出 = 32 字节；导入后验签等价', async () => {
  const { publicKey, privateKey } = await generateKeyPair()
  const raw = await exportPublicKeyRaw(publicKey)
  assert.equal(raw.byteLength, 32)
  const imported = await importPublicKey(raw)
  const msg = enc.encode('roundtrip')
  const sig = await sign(privateKey, msg)
  assert.equal(await verify(imported, msg, sig), true)
})

test('私钥 pkcs8 导出/导入往返，签名等价', async () => {
  const { publicKey, privateKey } = await generateKeyPair()
  const pkcs8 = await exportPrivateKeyPkcs8(privateKey)
  const imported = await importPrivateKey(pkcs8)
  const msg = enc.encode('private roundtrip')
  const sigA = await sign(privateKey, msg)
  const sigB = await sign(imported, msg)
  // Ed25519 确定性签名：同私钥同消息应相同
  assert.deepEqual(sigA, sigB)
  assert.equal(await verify(publicKey, msg, sigB), true)
})

test('PBKDF2: 同密码+salt 派生等价；不同 salt 不同', async () => {
  const salt = randomBytes(16)
  const k1 = await deriveKeyFromPassword('p@ssw0rd', salt, 1000)
  const k2 = await deriveKeyFromPassword('p@ssw0rd', salt, 1000)
  // 派生密钥不可直接比较（CryptoKey 不透明），用加解密往返间接验证一致性
  const pt = enc.encode('secret')
  const { ciphertext, iv } = await encrypt(k1, pt)
  const dec = await decrypt(k2, ciphertext, iv) // 同密码+salt 应能解
  assert.deepEqual(dec, pt)
  // 不同 salt → 不同密钥 → 解密失败
  const k3 = await deriveKeyFromPassword('p@ssw0rd', randomBytes(16), 1000)
  await assert.rejects(() => decrypt(k3, ciphertext, iv))
})

test('AES-GCM: 加解密往返；错误密钥抛错', async () => {
  const salt = randomBytes(16)
  const key = await deriveKeyFromPassword('pw', salt, 1000)
  const pt = enc.encode('plaintext payload')
  const { ciphertext, iv } = await encrypt(key, pt)
  assert.notDeepEqual([...ciphertext], [...pt])
  const dec = await decrypt(key, ciphertext, iv)
  assert.deepEqual(dec, pt)
  // 用另一个密钥解 → GCM tag 校验失败
  const other = await deriveKeyFromPassword('other', randomBytes(16), 1000)
  await assert.rejects(() => decrypt(other, ciphertext, iv))
})

test('加密每次 iv 随机（相同明文密文不同）', async () => {
  const salt = randomBytes(16)
  const key = await deriveKeyFromPassword('pw', salt, 1000)
  const pt = enc.encode('same')
  const a = await encrypt(key, pt)
  const b = await encrypt(key, pt)
  assert.notDeepEqual([...a.ciphertext], [...b.ciphertext])
})
