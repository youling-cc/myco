/**
 * identity.ts — media 窗(远程桌面 viewer)的设备 DID 身份,与 phone 同一套体系。
 *
 * 信任模型与 phone 完全相同:viewer 持有自己的 ed25519 密钥对(DID 即身份),
 * 配对 = 把 viewer DID 加进主机 canvas 的 authorized-dids(本机回环走
 * canvas HTTP /api/add_device_by_did 即写内存态+落盘,不用重启 exe)。
 *
 * 密钥只存 localStorage(plain 模式;PC 窗不比手机,enc 解锁 v1 不上)。
 * 签名格式与 phone/identity.ts 的 signAuthHeader 逐字节一致:
 *   X-Myco-Auth: <did>.<ts>.<sigB64>
 *   sig = ed25519.sign(`${did}\n${ts}\n${rawBody}`, seed)
 */
import * as ed from '@noble/ed25519'
import bs58 from 'bs58'
import { sha512 } from '@noble/hashes/sha512.js'

// noble 2.x 需要显式注册 sha512 后端(HTTP 非安全上下文无 crypto.subtle)。
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m))
ed.etc.sha512Async = async (...m) => sha512(ed.etc.concatBytes(...m))

const LS_KEY = 'myco-media.viewer-keyB64'

/** identity-svc 基址(与 phone transport.ts SIG_BASE 同源)。 */
// 构建期 VITE_DID_BASE 覆盖（换环境改构建 env 不改代码），缺省=现状 EIP 直连。
export const DID_BASE: string = ((import.meta.env.VITE_DID_BASE as string | undefined) || 'http://myco.youling.cc:8321').replace(/\/+$/, '')

export interface ViewerIdentity {
  keyB64: string
  did: string
}

const b64 = (u8: Uint8Array): string => btoa(String.fromCharCode(...u8))
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** ed25519-pub multicodec 前缀（0xed 0x01）+ 公钥 → multibase 载荷前段。
 *  单一实现与 phone/identity.ts 的 `multibaseEd25519` 同构（DID canonical 化的前置）。 */
const multibaseEd25519 = (pub: Uint8Array): Uint8Array => {
  const out = new Uint8Array(pub.length + 2)
  out[0] = 0xed
  out[1] = 0x01
  out.set(pub, 2)
  return out
}

let _id: ViewerIdentity | null = null

/** 读或生成本机 viewer 身份(幂等)。 */
export function ensureViewerIdentity(): ViewerIdentity {
  if (_id) return _id
  let keyB64: string | null = null
  try {
    keyB64 = localStorage.getItem(LS_KEY)
  } catch {
    /* localStorage 被禁则退化内存态 */
  }
  if (!keyB64) {
    keyB64 = b64(ed.utils.randomPrivateKey())
    try {
      localStorage.setItem(LS_KEY, keyB64)
    } catch {
      /* 同上 */
    }
  }
  const pubkey = ed.getPublicKey(fromB64(keyB64))
  // 2026-10-13：DID 形态对齐 spec v0.3 canonical —— 与 phone/identity.ts:129 和
  // core `identity::did_from_public` 逐字节同构：`did:myco:z<base58btc(0xed01+pub)>`。
  // 原实现是 legacy `did:myco:<base58(裸公钥)>`（无 multibase 前缀、无 z）——主机端
  // 与授权表已 canonical 化，legacy 形态在查表时恒 miss（会被判"未放行"而 deny）。
  _id = { keyB64, did: `did:myco:z${bs58.encode(multibaseEd25519(pubkey))}` }
  return _id
}

/** sign-every-request 签名头(与 identity-svc /signal/* 契约一致)。 */
export function signAuthHeader(rawBody: string): string {
  const id = ensureViewerIdentity()
  const ts = Date.now()
  const msg = new TextEncoder().encode(`${id.did}\n${ts}\n${rawBody}`)
  const sig = ed.sign(msg, fromB64(id.keyB64))
  return `${id.did}.${ts}.${b64(sig)}`
}

/** 幂等注册公钥到 identity-svc(已注册 409 也算成功)。
 *  铁律:未注册的 DID 一切签名请求(authedDid)都被 403——
 *  /signal/* 投递前必须先注册(与 phone ensureRegistered 同契约)。 */
export async function ensureRegistered(): Promise<void> {
  const id = ensureViewerIdentity()
  const publicKeyB64 = b64(ed.getPublicKey(fromB64(id.keyB64)))
  const r = await fetch(`${DID_BASE}/identity/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKeyB64 }),
  })
  if (r.status !== 201 && r.status !== 409) {
    throw new Error(`注册失败 (${r.status}): ${(await r.text()).slice(0, 160)}`)
  }
}
