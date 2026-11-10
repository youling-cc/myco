/**
 * didUtil — 账号 DID 前缀语义（2026-09-29 用户实测立法）：
 *   账号 did canonical = did:youling:（平台/手机端一致）；
 *   did:myco: 是设备级前缀，历史期间 PC 误用它派生账号 did——
 *   同一公钥两形态并存于历史数据（accounts.json/聊天行/委任状）。
 * 出示层归一 + 相等性判断前缀不敏感；存储路由（Rust 侧）不经过这里。
 */

/** 账号 did 出示归一：did:myco:<tail> → did:youling:<tail>；其余形态原样。 */
export function normalizeAccountDid(did: string): string {
  if (!did) return did
  return did.startsWith('did:myco:') ? `did:youling:${did.slice('did:myco:'.length)}` : did
}

/** 账号 did 同判定（前缀不敏感）：did:myco:X 与 did:youling:X 是同一账号。 */
export function sameAccountDid(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  if (a === b) return true
  return normalizeAccountDid(a) === normalizeAccountDid(b)
}

/** did 截断显示（保留 did:method: 前缀）：did:youling:ABCD…WXYZ。 */
export function shortDidKeepPrefix(did: string): string {
  const m = did.match(/^did:[a-z]+:/)
  const pre = m ? m[0] : ''
  return did.length > pre.length + 8 ? `${pre}${did.slice(pre.length, pre.length + 4)}…${did.slice(-4)}` : did
}
