/**
 * delegation.ts — 委任状客户端(有灵账号模型 v1,design/08-identity/MYCO-ACCOUNT-MODEL.md)。
 *
 * 分身(手机)持:设备钥(identity.ts 既有,隐形管道)+ 委任状(账号签 7 天)。
 * 双证出示:X-Myco-Auth(设备签名,既有)+ X-Myco-Delegation(本模块 present())。
 * 自动续签:开机/定期 isDue → 投 identity-svc 收件箱 → 轮询取件(本体上线后续好投回)。
 * 编解码与 canvas delegation.rs 逐字节一致(base64(json),签名验在服务端)。
 */
import { currentIdentity, DID_BASE } from './identity'
import * as ed from '@noble/ed25519'

// 第33轮多账号：委任状按账号分键（myco-phone.acc.<did>.deleg）——切账号即切委任状。
// 旧单键 myco.delegation 首访迁移到当前账号名下。
import { getRootIdentity } from './identity'
function delegKey(): string {
  const did = getRootIdentity()
  return did ? `myco-phone.acc.${did}.deleg` : 'youling.delegation'
}
/** 续签判定(与 Rust 同参:剩余 <20% TTL 或 <24h)——TTL 30 天即剩 ~6 天触发,≈spec §7.4「剩7天续」 */
const RENEW_MIN_MS = 24 * 3600 * 1000
const RENEW_FRACTION = 0.2

export interface Delegation {
  accountDid: string
  devicePubkeyB64: string
  deviceName: string
  scopes: string
  issuedAt: number
  exp: number
  nonce: string
  sigB64: string
}

/** DID_BASE 与 identity.ts 同源(vnext identity-svc,随部署配置走)。 */

export function loadDelegation(): Delegation | null {
  try {
    const k = delegKey()
    let raw = localStorage.getItem(k)
    if (!raw && k !== 'youling.delegation') {
      // 旧单键迁移（一次性）
      raw = localStorage.getItem('youling.delegation')
      if (raw) { localStorage.setItem(k, raw); localStorage.removeItem('youling.delegation') }
    }
    return raw ? (JSON.parse(raw) as Delegation) : null
  } catch {
    return null
  }
}

export function saveDelegation(d: Delegation) {
  localStorage.setItem(delegKey(), JSON.stringify(d))
}

export function clearDelegation() {
  localStorage.removeItem(delegKey())
}

/** 出示头值:base64(json)——与 canvas encode_present 一致。 */
export function present(d: Delegation): string {
  const json = JSON.stringify(d)
  return btoa(unescape(encodeURIComponent(json)))
}

/** 是否该续签(过期也返回 true——续签请求会触发;真过期时服务端拒)。 */
export function isDueRenew(d: Delegation): boolean {
  const now = Date.now()
  const left = d.exp - now
  return left <= 0 || left < RENEW_MIN_MS || (d.exp - d.issuedAt) * RENEW_FRACTION > left
}

const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const toB64 = (u8: Uint8Array): string => btoa(String.fromCharCode(...u8))

/** 本机设备公钥(base64 raw 32B)——从 identity 的 seed 派生(noble ed,同步可用)。 */
export function devicePubkeyB64(): string | null {
  const id = currentIdentity()
  if (!id) return null
  try {
    return toB64(ed.getPublicKey(fromB64(id.keyB64)))
  } catch {
    return null
  }
}

/**
 * 投递续签请求到 identity-svc 收件箱(设备钥签 renew 消息 + 现委任状持有证明)。
 * 持有证明是 2026-09-15 服务端新契约:accountDid 公开,无证明的 renew 会被 403
 * (堵"陌生设备投 renew 让主设备自动签委任状"的劫持洞)。
 * 返回 true=已入箱(主设备在线即自动重签投回);网络失败静默 false(下轮再试)。
 */
export async function requestRenewal(): Promise<boolean> {
  const dlg = loadDelegation()
  if (!dlg) return false
  const pub = devicePubkeyB64()
  if (!pub || pub !== dlg.devicePubkeyB64) return false
  const ts = Date.now()
  const msg = `renew\n${dlg.accountDid}\n${pub}\n${ts}`
  const sig = await signWithDeviceKey(msg)
  if (!sig) return false
  try {
    const r = await fetch(`${DID_BASE}/delegation/renew`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountDid: dlg.accountDid, devicePubkeyB64: pub, name: dlg.deviceName, ts, sigB64: sig, delegation: dlg }),
    })
    return r.ok
  } catch {
    return false
  }
}

/** 轮询取新委任状(本体投递到 /delegation/poll 箱);拿到即存。 */
export async function pollDelegation(): Promise<Delegation | null> {
  const pub = devicePubkeyB64()
  if (!pub) return null
  try {
    const r = await fetch(`${DID_BASE}/delegation/poll?devicePubkeyB64=${encodeURIComponent(pub)}`)
    const j = (await r.json()) as { data?: Delegation | null }
    if (j?.data && j.data.exp > Date.now()) {
      saveDelegation(j.data)
      return j.data
    }
  } catch { /* 静默 */ }
  return null
}

// 设备钥签名:identity.ts 的 ed25519 原语同款(noble ed + sha512 已在其模块注册)。
// 导出供 YoulingLogin 委任状模式签 "myco-auth\n{ticket}"。
export async function signWithDeviceKey(msg: string): Promise<string | null> {
  const id = currentIdentity()
  if (!id) return null
  try {
    const sig = ed.sign(new TextEncoder().encode(msg), fromB64(id.keyB64))
    return toB64(sig)
  } catch {
    return null
  }
}
