/**
 * didUtil.ts — 账号 DID 形态归一（**canonical-only**，2026-10-10 系统拍板；与
 * `core/myco-core/src/identity.rs` 的 `account_did_canonical` / `account_did_aliases` /
 * `account_did_eq` **同语义、逐字节同构**）。
 *
 * canonical 密钥 did = `did:<method>:z<base58btc(0xed 0x01 + 32B 公钥)>`
 * （multibase 前缀 `z` + multicodec 头 2B + 32B 公钥 ⇒ base58 载荷恒 **34 字节**；
 * method ∈ did:youling: / did:myco:）。**legacy** = `did:<method>:<base58btc(32B 裸公钥)>`
 * **已废止**：不再解码、不再当别名，统一文案「不支持的 did 格式」。
 *
 * 两条判定纪律：
 *  1. **以解码结果为准**，不用「尾段以 z 开头」近似——43 位编码的 32B 裸 base58 有约
 *     1/57 概率恰好以 `'z'` 开头（`'z'` 是合法 base58 字符），前缀分派会误判（本模块有反例回归）。
 *  2. **限长先于解码**：base58 解码 O(n²)，粘贴/扫码这类入口先按 `DID_MAX_LEN` 拒超长。
 *
 * 背景（PC 端已实证并修复的同款隐患）：手机端此前直接拿"出示形态"当存储键
 * （`didSafe(convId)`）：入站 ingest 按**信封 from 的出示形态**落键、发送与 UI 按
 * **名册 did 的历史形态**读写 → 同一对端两份会话键，消息收到了但 UI 读另一份 → **看不见**。
 * 修法 = 写目标统一 canonical（本模块的归一键）；存量历史命名的文件由别名表归并读取。
 *
 * 本模块只做归一（纯函数，零副作用、零 DOM/存储依赖）：
 *   · accountDidCanonical —— canonical 双前缀 → 单一 canonical（写目标）
 *   · accountDidAliases   —— 全部等价形态（**含 legacy 串枚举，仅供本地存量文件归并读取**）
 *   · accountDidEq        —— 公钥级相等（canonical 双前缀同钥；legacy 不参与）
 *   · convKey/convSafe/convSafesAll —— 会话存储键的归一键/归并键表（含 did_safe 下划线还原）
 *
 * 红线：解析不出公钥的串（软 did / 群 id `grp-*` / legacy did）**原样返回**——不误并、不误改名。
 */
import bs58 from 'bs58'

/** multibase ed25519-pub multicodec 头（spec v0.3 §3.1；与 did:key 逐字节同构）。 */
const ED25519_MULTICODEC = [0xed, 0x01] as const

/** did 串长度上限（公开可达入口 DoS 面：base58 解码 O(n²)）。canonical 实测约 48-52 字符，
 *  与 platform `DidFormat.MAX_DID_LEN` / Python `base58.DID_MAX_LEN` 同口径。 */
export const DID_MAX_LEN = 256

function tryDecode(s: string): Uint8Array | null {
  try {
    const v = bs58.decode(s)
    return v.length ? v : null
  } catch {
    return null
  }
}

/** did → 32 字节公钥（**canonical-only**，spec v0.3 §3.1，与 Rust `did_pubkey_bytes` 同式）：
 *  · 取 `did:myco:` / `did:youling:` 前缀 → 尾段必须以 `z` 开头（multibase base58btc）；
 *  · `z` 后 base58 解码须为 **34B** 且前两字节 `0xed 0x01` → 返回 payload[2..] 的 32B；
 *  · **legacy（尾段裸 32B base58）已废止**：不解码、不回落；软 did / 群 id / 超长 / 非
 *    base58 / 载荷长度或头不符 → 一律 null（判定以解码结果为准，不以尾段 z 近似）。 */
export function didPubkeyBytes(did: string): Uint8Array | null {
  const s = did || ''
  if (!s || s.length > DID_MAX_LEN) return null // 超长先拒（不进 O(n²) 解码）
  const rest = s.startsWith('did:myco:')
    ? s.slice('did:myco:'.length)
    : s.startsWith('did:youling:')
      ? s.slice('did:youling:'.length)
      : null
  if (rest === null || !rest.startsWith('z')) return null // legacy / 非 multibase → 不支持的格式
  const payload = tryDecode(rest.slice(1))
  if (!payload || payload.length !== 34) return null
  if (payload[0] !== ED25519_MULTICODEC[0] || payload[1] !== ED25519_MULTICODEC[1]) return null
  return payload.slice(2)
}

/** 公钥字节 → canonical did（`did:<method>:z<base58btc(0xed01+pub)>`）。 */
export function didFromPubkey(pub: Uint8Array, method: 'myco' | 'youling'): string {
  const payload = new Uint8Array(34)
  payload[0] = ED25519_MULTICODEC[0]
  payload[1] = ED25519_MULTICODEC[1]
  payload.set(pub, 2)
  return `did:${method}:z${bs58.encode(payload)}`
}

/** 账号 did 出示归一（前缀语义，历史遗留保留）：did:myco:<tail> → did:youling:<tail>，其余原样。
 *  **只归前缀不归格式**——存储键/相等判断请用 accountDidCanonical / accountDidEq。 */
export function normalizeAccountDid(did: string): string {
  if (!did) return did
  return did.startsWith('did:myco:') ? `did:youling:${did.slice('did:myco:'.length)}` : did
}

/** 公钥级等价（与 Rust `did_equiv` 同式，**canonical-only**）：逐字相等直接过；否则双方都能
 *  canonical 解出公钥时按字节比较（双 method 前缀不敏感——同一把钥匙的 `did:youling:z…` 与
 *  `did:myco:z…` 等价）；任一侧解析失败（软 did / **legacy 已废止**）→ 不等。 */
export function didEquiv(a: string, b: string): boolean {
  if (a === b) return true
  const x = didPubkeyBytes(a)
  const y = didPubkeyBytes(b)
  if (x && y) return x.length === y.length && x.every((v, i) => v === y[i])
  return false
}

/** 账号 did 同判定（与 Rust `account_did_eq` 同式，与 Java `Ed25519.didEquals` 逐字同语义）：
 *  **字符串相等 ∪ 双方都能 canonical 解码且公钥字节相等**。网络面（信封 from/好友表 did/
 *  委任状 accountDid）两前缀 canonical 都可能出现，一律用它；legacy 不再参与等价。 */
export function accountDidEq(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  if (a === b) return true
  return didEquiv(a, b)
}

/** 账号 did 的 canonical 形态（`did:youling:z<base58btc(0xed01+32B)>`）——**同一把钥匙只有一个键**。
 *  canonical 双前缀都归一到它；**legacy 输入不再归一（原样返回）**；解析不出公钥的串
 *  （软 did / 群 id / legacy）原样返回。会话存储键（消息/摘要/未读/草稿/偏好）一律先过本函数：
 *  写目标唯一。 */
export function accountDidCanonical(did: string): string {
  const b = didPubkeyBytes(did)
  return b ? didFromPubkey(b, 'youling') : did
}

/** 账号 did 的全部等价形态（canonical 首位 + 原串 + 双前缀 canonical + **legacy 串枚举**），
 *  去重、顺序稳定——存量"同一账号两份存储键"的**归并读取**用（不迁移、不删档）。
 *
 *  ⚠️ **legacy 串仅供本地存量文件归并读取**（历史会话/摘要文件名按旧形态落盘）；
 *  **任何验签/放行判定不得用它**（legacy 已废止，见 `didPubkeyBytes`）。
 *  输入是 legacy 时本函数退化为只有原串一个（解不出公钥 → 不再枚举）。
 *  解析不出公钥的串只有自己一个。 */
export function accountDidAliases(did: string): string[] {
  const out: string[] = []
  const push = (s: string) => { if (s && !out.includes(s)) out.push(s) }
  push(accountDidCanonical(did)) // 写目标优先
  push(did)
  const b = didPubkeyBytes(did)
  if (b) {
    push(didFromPubkey(b, 'youling'))
    push(didFromPubkey(b, 'myco'))
    const legacy = bs58.encode(b) // 存量文件名（已废止形态）：只读归并，不作身份判定
    push(`did:youling:${legacy}`)
    push(`did:myco:${legacy}`)
  }
  return out
}

// ══════════════ 会话存储键（chat-store / outbox / p2p 共用） ══════════════

/** 存储键片段形态（与各端既有 `didSafe`/`did_safe` 一致：`:` `/` → `_`）。 */
export function didSafeId(id: string): string { return (id || '').replace(/[:/]/g, '_') }

/** did_safe 下划线形态还原（`did_myco_X` / `did_youling_X` → did）——仅在前缀命中且
 *  **canonical 公钥解析成功**时还原（软 did 串如 `did_youling_BOB`、已废止的 legacy 串
 *  原样返回 null，不误改）。 */
export function restoreDidSafe(s: string): string | null {
  const raw = s || ''
  if (didPubkeyBytes(raw)) return raw
  for (const [safe, did] of [['did_myco_', 'did:myco:'], ['did_youling_', 'did:youling:']] as const) {
    if (raw.startsWith(safe)) {
      const d = `${did}${raw.slice(safe.length)}`
      if (didPubkeyBytes(d)) return d
    }
  }
  return null
}

/** 会话归一键（唯一写目标）：canonical 双前缀 + did_safe 下划线形态 → canonical；
 *  群 id（grp-*）与软 did / legacy 串原样返回。 */
export function convKey(convId: string): string {
  const raw = convId || ''
  const restored = restoreDidSafe(raw)
  return restored ? accountDidCanonical(restored) : raw
}

/** 归一键的存储键片段（chat-store 的 localStorage 键 / outbox 的 convId 字段用）。 */
export function convSafe(convId: string): string { return didSafeId(convKey(convId)) }

/** 该会话的全部等价存储键片段（归一键首位 + 原串 safe 形态 + 账号 did 各历史形态，
 *  **含 legacy 串——仅供存量历史文件归并读取**）——存量双形态键归并读取的键表；
 *  群/软 id/legacy 输入只有自己一个。 */
export function convSafesAll(convId: string): string[] {
  const raw = convId || ''
  const out: string[] = []
  const push = (s: string) => { if (s && !out.includes(s)) out.push(s) }
  push(convSafe(raw))
  push(didSafeId(raw))
  const restored = restoreDidSafe(raw)
  if (restored) for (const a of accountDidAliases(restored)) push(didSafeId(a))
  return out
}
