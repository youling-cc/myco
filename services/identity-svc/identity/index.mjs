// identity/index.mjs — 公共出口 + HTTP 端点编排（对齐 createCollectiveApi 模式）。
// handle({method,pathname,query,body}) → {status, body}，HTTP 无关纯调度。
//
// 路由（IDENTITY_ROUTES）：
//   POST /identity/register   {publicKeyB64, ciphertextB64, saltB64, ivB64, iters}
//                             → 服务端算 did=did:myco:<base58(pk)>，校验唯一，落库，返 {did, didDocument}
//   POST /identity/challenge  {did} → {nonce, expiresAt}（签名挑战）
//   POST /identity/login      {did, nonce, signatureB64} → 验签 + 消费挑战 → {token, did, expiresAt}
//   POST /identity/ciphertext {did} → {ciphertextB64, saltB64, ivB64, iters}（多设备恢复取密文）
//   POST /identity/verify     {token} → {did}（会话校验）
//
// 安全要点（见 DESIGN §3.3/§4.2/§4.3）：
// - 私钥永不明文上服务端：register 收到的就是浏览器加密后的密文
// - 登录用 Ed25519 签名挑战，无密码无短信无状态
// - 挑战一次性 + 过期，防重放

import { didFromPublicKey, parseCryptoDid, isCryptoDid, isCanonicalDeviceDid, looksLikeLegacyCryptoDid } from './did.mjs'
import { importPublicKey, verify, randomBytes } from './crypto.mjs'

const DEFAULT_CHALLENGE_TTL = 5 * 60 * 1000   // 5 分钟
const DEFAULT_SESSION_TTL = 24 * 60 * 60 * 1000 // 1 天
const LOGIN_MESSAGE = (did, nonce) => `${did}\n${nonce}`

export const IDENTITY_ROUTES = new Set([
  '/identity/register', '/identity/challenge', '/identity/login',
  '/identity/ciphertext', '/identity/verify',
])

function b64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}
function bytesToB64(bytes) {
  return Buffer.from(bytes).toString('base64')
}
function didDocument(did, publicKeyB64) {
  return {
    '@context': ['https://w3id.org/did/v1'],
    id: did,
    verificationMethod: [{
      id: `${did}#keys-1`,
      type: 'Ed25519VerificationKey2020',
      publicKeyMultibase: publicKeyB64,
    }],
    authentication: ['#keys-1'],
  }
}

/**
 * @param {{store:object, now?:function, challengeTtlMs?:number, sessionTtlMs?:number}} deps
 * @returns {{handle:function}}
 */
export function createIdentityApi({ store, now, challengeTtlMs, sessionTtlMs } = {}) {
  const _now = typeof now === 'function' ? now : Date.now
  const cTtl = challengeTtlMs ?? DEFAULT_CHALLENGE_TTL
  const sTtl = sessionTtlMs ?? DEFAULT_SESSION_TTL

  async function register(body) {
    // 公钥必填；托管密文可选（选 A：本地私钥不上传，无密文；选 B：附密文供恢复）
    const { publicKeyB64, ciphertextB64 = null, saltB64 = null, ivB64 = null, iters = null } = body ?? {}
    if (!publicKeyB64) {
      return { status: 400, body: { error: '缺少字段: publicKeyB64' } }
    }
    const pk = b64ToBytes(publicKeyB64)
    if (pk.byteLength !== 32) return { status: 400, body: { error: 'publicKey 必须为 32 字节 raw' } }
    const did = didFromPublicKey(pk)
    if (await store.identityExists(did)) {
      return { status: 409, body: { error: '该公钥已注册', did } }
    }
    const doc = didDocument(did, publicKeyB64)
    // DB 列 NOT NULL：无托管密文（选 A）时存空串占位
    await store.putIdentity({
      did, publicKeyB64,
      ciphertextB64: ciphertextB64 || '',
      saltB64: saltB64 || '',
      ivB64: ivB64 || '',
      iters: iters == null ? 0 : Number(iters),
      didDocument: doc,
    })
    return { status: 201, body: { did, didDocument: doc } }
  }

  async function challenge(body) {
    const { did } = body ?? {}
    if (!did || !isCryptoDid(did)) {
      // 2026-10-10 canonical-only 收敛：legacy 裸 base58 落在这道闸——分流到统一文案
      if (looksLikeLegacyCryptoDid(did)) return { status: 400, body: { error: '不支持的 did 格式（须为 canonical：did:<method>:z…；legacy 裸 base58 已废止——请升级 myco 客户端）', code: 'unsupported_did_format' } }
      return { status: 400, body: { error: '非法加密 did' } }
    }
    if (!isCanonicalDeviceDid(did)) return { status: 400, body: { error: 'unsupported_did_format: 设备 did 须为 canonical 形态（did:myco:z<multibase>）——请升级 myco 客户端后重试', code: 'unsupported_did_format' } }
    if (!(await store.identityExists(did))) return { status: 404, body: { error: '未注册' } }
    const nonce = bytesToB64(randomBytes(16))
    const ch = await store.createChallenge(nonce, did, cTtl)
    return { status: 200, body: { did, nonce, expiresAt: ch.expiresAt, message: LOGIN_MESSAGE(did, nonce) } }
  }

  async function login(body) {
    const { did, nonce, signatureB64 } = body ?? {}
    if (!did || !nonce || !signatureB64) {
      return { status: 400, body: { error: '缺少字段: did/nonce/signatureB64' } }
    }
    if (!isCryptoDid(did)) {
      if (looksLikeLegacyCryptoDid(did)) return { status: 400, body: { error: '不支持的 did 格式（须为 canonical：did:<method>:z…；legacy 裸 base58 已废止——请升级 myco 客户端）', code: 'unsupported_did_format' } }
      return { status: 400, body: { error: '非法加密 did' } }
    }
    if (!isCanonicalDeviceDid(did)) return { status: 400, body: { error: 'unsupported_did_format: 设备 did 须为 canonical 形态（did:myco:z<multibase>）——请升级 myco 客户端后重试', code: 'unsupported_did_format' } }
    const id = await store.getIdentity(did)
    if (!id) return { status: 404, body: { error: '未注册' } }
    // 验签（约定签名内容 = did\nnonce）
    const pub = await importPublicKey(b64ToBytes(id.publicKeyB64))
    const ok = await verify(pub, new TextEncoder().encode(LOGIN_MESSAGE(did, nonce)), b64ToBytes(signatureB64))
    if (!ok) return { status: 401, body: { error: '签名校验失败' } }
    if (!(await store.consumeChallenge(nonce, did))) {
      return { status: 401, body: { error: '挑战无效或已用过' } }
    }
    const token = bytesToB64(randomBytes(32))
    const sess = await store.createSession(token, did, sTtl)
    return { status: 200, body: { token, did, expiresAt: sess.expiresAt } }
  }

  async function ciphertext(body) {
    const { did } = body ?? {}
    if (!did || !isCryptoDid(did)) {
      // 2026-10-10 canonical-only 收敛：legacy 裸 base58 落在这道闸——分流到统一文案
      if (looksLikeLegacyCryptoDid(did)) return { status: 400, body: { error: '不支持的 did 格式（须为 canonical：did:<method>:z…；legacy 裸 base58 已废止——请升级 myco 客户端）', code: 'unsupported_did_format' } }
      return { status: 400, body: { error: '非法加密 did' } }
    }
    if (!isCanonicalDeviceDid(did)) return { status: 400, body: { error: 'unsupported_did_format: 设备 did 须为 canonical 形态（did:myco:z<multibase>）——请升级 myco 客户端后重试', code: 'unsupported_did_format' } }
    const ct = await store.getCiphertext(did)
    if (!ct) return { status: 404, body: { error: '未注册' } }
    return { status: 200, body: { did, ...ct } }
  }

  async function verifySession(body) {
    const { token } = body ?? {}
    if (!token) return { status: 400, body: { error: '缺少 token' } }
    const sess = await store.getSession(token)
    if (!sess) return { status: 401, body: { error: '会话无效或已过期' } }
    return { status: 200, body: { did: sess.did, expiresAt: sess.expiresAt } }
  }

  async function handle(r) {
    const { method, pathname, body } = r
    if (method !== 'POST') return { status: 405, body: { error: '仅支持 POST' } }
    try {
      switch (pathname) {
        case '/identity/register': return register(body)
        case '/identity/challenge': return challenge(body)
        case '/identity/login': return login(body)
        case '/identity/ciphertext': return ciphertext(body)
        case '/identity/verify': return verifySession(body)
        default: return { status: 404, body: { error: '未知 identity 路由' } }
      }
    } catch (err) {
      return { status: 500, body: { error: String(err?.message ?? err) } }
    }
  }

  return { handle }
}

export { IdentityStore } from './store.mjs'
export {
  generateKeyPair, exportPublicKeyRaw, exportPrivateKeyPkcs8,
  importPublicKey, importPrivateKey, sign, verify,
  deriveKeyFromPassword, encrypt, decrypt, randomBytes,
} from './crypto.mjs'
export {
  base58Encode, base58Decode, didFromPublicKey, parseCryptoDid,
  isCryptoDid, isCanonicalDeviceDid, isSoftDid, isValidDid,
  canonicalMethodId, normalizeDid,
} from './did.mjs'
