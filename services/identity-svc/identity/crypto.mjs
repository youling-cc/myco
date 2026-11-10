// identity/crypto.mjs — 纯密码原语（零依赖，globalThis.crypto.subtle）。
// Node 18+ 与浏览器同一套 Web Crypto API：Ed25519 密钥对/签名验签/导入导出、PBKDF2 派生、AES-GCM 加解密。
//
// 设计约束（见 DESIGN-identity-service-onchain.md §3.3/§4.2/§8）：
// - 签名算法 Ed25519（Web Crypto 原生支持 secp256k1 不支持）
// - 密码 KDF = PBKDF2-SHA256（Web Crypto 唯一原生 KDF，非 Argon2/scrypt）
// - 私钥永不以明文离开浏览器：本模块只提供"派生密钥→加密 pkcs8"原语，调用方负责生命周期

const sub = globalThis.crypto.subtle
const enc = new TextEncoder()

/** 随机字节（salt / iv / nonce）。 */
export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n))
}

/** 生成 Ed25519 密钥对（均可导出，私钥由调用方加密托管）。 */
export async function generateKeyPair() {
  return sub.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
}

/** 导出公钥 raw（32 字节）——DID 的 method-specific-id 材料。 */
export async function exportPublicKeyRaw(publicKey) {
  return new Uint8Array(await sub.exportKey('raw', publicKey))
}

/** 导出私钥 pkcs8（DER）——用于加密托管。 */
export async function exportPrivateKeyPkcs8(privateKey) {
  return new Uint8Array(await sub.exportKey('pkcs8', privateKey))
}

/** 从 raw 公钥（32B）导入。 */
export async function importPublicKey(raw) {
  return sub.importKey('raw', raw, { name: 'Ed25519' }, true, ['verify'])
}

/** 从 pkcs8 私钥导入。 */
export async function importPrivateKey(pkcs8) {
  return sub.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'])
}

/** Ed25519 签名。 */
export async function sign(privateKey, message) {
  return new Uint8Array(await sub.sign({ name: 'Ed25519' }, privateKey, message))
}

/** Ed25519 验签，返回布尔。 */
export async function verify(publicKey, message, signature) {
  return sub.verify({ name: 'Ed25519' }, publicKey, signature, message)
}

/**
 * 密码 → AES-GCM 密钥（PBKDF2-SHA256）。
 * @param {string} password 用户登录密码
 * @param {Uint8Array} salt 每用户随机盐（16B）
 * @param {number} iterations 迭代数（建议 ≥600000）
 * @returns {Promise<CryptoKey>} AES-GCM 256 密钥（不可导出）
 */
export async function deriveKeyFromPassword(password, salt, iterations = 600000) {
  const baseKey = await sub.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  return sub.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * AES-GCM 加密。每次随机 iv（12B）。
 * @returns {{ciphertext: Uint8Array, iv: Uint8Array}}
 */
export async function encrypt(key, plaintext) {
  const iv = randomBytes(12)
  const ct = new Uint8Array(await sub.encrypt({ name: 'AES-GCM', iv }, key, plaintext))
  return { ciphertext: ct, iv }
}

/** AES-GCM 解密；密钥/iv 不匹配（GCM tag 校验失败）会抛错。 */
export async function decrypt(key, ciphertext, iv) {
  return new Uint8Array(await sub.decrypt({ name: 'AES-GCM', iv }, key, ciphertext))
}
