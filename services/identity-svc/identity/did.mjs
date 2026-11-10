// identity/did.mjs — DID 字符串构造/解析 + base58（零依赖）。
// 复用现有 did:myco: 命名空间（见 DESIGN §4.4）：
//   - 软形（现有，本模块不构造）：did:myco:participant:<slug>     ← 名字派生，无密钥
//   - 加密形（本设计）：did:myco:<base58(Ed25519 公钥 32B)>       ← 公钥即身份，SBT 主体
//
// spec v0.3（2026-09-30）Multibase Identifier Encoding：
//   - canonical（唯一合法形态）：did:<method>:z<base58btc(0xed 0x01 + 32B 公钥)>
//     —— 与 did:key 逐字节同构（0xed01 = ed25519-pub multicodec 头）。
//   - legacy（did:<method>:<base58btc(32B)> 裸公钥）：**已废止（2026-10-10 收敛）**。
//     清档窗口后存量全 canonical、客户端三端已 canonical-only，本服务不再解析/
//     不再当归一别名——解析失败即拒（统一口径：34B 载荷 + 0xed 0x01 头，与
//     Java/Python/SDK 同源判定）。

const DID_PREFIX = 'did:myco:'
const SOFT_SEGMENT = 'participant:'
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz' // Bitcoin base58
const INDEX = new Map(ALPHABET.split('').map((c, i) => [c, i]))

/** multibase base58btc 标识前缀（spec v0.3 §3.1）。 */
const MULTIBASE_BASE58BTC = 'z'
/** ed25519-pub multicodec 头（varint 0xed + codec 0x01）。 */
const MULTICODEC_ED25519_PUB = [0xed, 0x01]

/** base58 编码（含前导零→'1'）。 */
export function base58Encode(bytes) {
  const input = Array.from(bytes, (b) => b)
  let zeros = 0
  while (zeros < input.length && input[zeros] === 0) zeros += 1
  // 大整数 base 转换
  const digits = []
  let startAt = zeros
  while (startAt < input.length) {
    let carry = 0
    for (let i = startAt; i < input.length; i += 1) {
      carry = carry * 256 + input[i]
      input[i] = Math.floor(carry / 58)
      carry %= 58
    }
    digits.push(carry)
    if (input[startAt] === 0) startAt += 1
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join('')
}

/** base58 解码（含前导 '1'→零字节）。非法字符返回 null。 */
export function base58Decode(str) {
  if (typeof str !== 'string' || str.length === 0) return null
  let zeros = 0
  while (zeros < str.length && str[zeros] === '1') zeros += 1
  const bytes = [] // LSB-first
  for (let i = zeros; i < str.length; i += 1) {
    const code = INDEX.get(str[i])
    if (code === undefined) return null
    let carry = code
    for (let j = 0; j < bytes.length; j += 1) { // 大数 ×58 +code，从 LSB 向前
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8 }
  }
  // bytes 为 LSB-first，翻转成 MSB-first 后前置零字节
  const out = new Uint8Array(zeros + bytes.length)
  for (let k = 0; k < bytes.length; k += 1) out[zeros + bytes.length - 1 - k] = bytes[k]
  return out
}

/** method-specific id（canonical，spec v0.3 §3.1）：'z' + base58btc(0xed 0x01 + 32B 公钥)。 */
export function canonicalMethodId(publicKeyRaw) {
  if (!(publicKeyRaw instanceof Uint8Array) || publicKeyRaw.byteLength !== 32) {
    throw new Error('canonicalMethodId 需要 32 字节公钥')
  }
  const payload = new Uint8Array(2 + 32)
  payload[0] = MULTICODEC_ED25519_PUB[0]
  payload[1] = MULTICODEC_ED25519_PUB[1]
  payload.set(publicKeyRaw, 2)
  return MULTIBASE_BASE58BTC + base58Encode(payload)
}

/** Ed25519 公钥(32B raw) → 加密 DID（canonical multibase z 形态，唯一出口）。
 *  2026-10-10 收敛：{ canonical: false } legacy 选项已删——legacy 串不再由本模块
 *  构造（测试向量用 'did:<method>:' + base58Encode(pk) 手搓）。 */
export function didFromPublicKey(publicKeyRaw) {
  if (!(publicKeyRaw instanceof Uint8Array) || publicKeyRaw.byteLength !== 32) {
    throw new Error('didFromPublicKey 需要 32 字节公钥')
  }
  return `${DID_PREFIX}${canonicalMethodId(publicKeyRaw)}`
}

/** 解析加密 DID → {idBytes, prefix, format}；软 did / 非法 / legacy → null。
 *  前缀双轨（2026-09-10 账户级任务授权）：did:myco:=设备体、did:youling:=
 *  有灵账号——同为公钥锚定，账号身份（root 钥）签名/信令曾因单前缀
 *  白名单全链 403「签名无效或未注册」。
 *  格式（2026-10-10 canonical-only 收敛）：只收 z 开头的 canonical multibase
 *  （载荷须 34B 且 0xed 0x01 头）；其余（含 legacy 裸 base58）一律 null。
 *  注：32B 裸公钥的 43 位 base58 串可能以 'z' 开头（约 0.09%），会先落 z 分支
 *  再因载荷≠34B/头错被拒——canonical 校验是唯一关口，不再回落。 */
const CRYPTO_DID_PREFIXES = [DID_PREFIX, 'did:youling:']
export function parseCryptoDid(did) {
  if (typeof did !== 'string') return null
  const pfx = CRYPTO_DID_PREFIXES.find((p) => did.startsWith(p))
  if (!pfx) return null
  const rest = did.slice(pfx.length)
  if (rest.startsWith(SOFT_SEGMENT)) return null // 软形，非加密
  if (rest.startsWith(MULTIBASE_BASE58BTC)) {
    const payload = base58Decode(rest.slice(1))
    if (payload && payload.byteLength === 34
      && payload[0] === MULTICODEC_ED25519_PUB[0] && payload[1] === MULTICODEC_ED25519_PUB[1]) {
      return { idBytes: payload.slice(2), prefix: pfx, format: 'canonical' }
    }
  }
  return null // legacy 裸 base58 已废止（2026-10-10）：不再回落解析
}

/** did 归一化（spec v0.3 §3.3）：canonical 串 → 保留 method 前缀的原串（幂等）。
 *  legacy/软 did/非法 → null（2026-10-10 收敛：legacy 不再归一到 canonical——
 *  投递/轮询两侧都须出示 canonical，形态错配=拒，而非静默换桶）。 */
export function normalizeDid(did) {
  const p = parseCryptoDid(did)
  if (!p) return null
  return `${p.prefix}${canonicalMethodId(p.idBytes)}`
}

/** 是否加密形 DID（did:myco:<base58pk>）。 */
export function isCryptoDid(did) {
  return parseCryptoDid(did) !== null
}

/** 是否"形似 legacy"的加密 did（前缀合法 + 尾段裸 base58 解出 32B，且不以 z 开头）。
 *  2026-10-10 收敛后仅用于**错误分流**——让 legacy 出示者收到「不支持的 did 格式」
 *  升级引导而非「非法加密 did」；这不是合法形态判定（parseCryptoDid 仍拒）。 */
export function looksLikeLegacyCryptoDid(did) {
  if (typeof did !== 'string') return false
  const pfx = CRYPTO_DID_PREFIXES.find((p) => did.startsWith(p))
  if (!pfx) return false
  const rest = did.slice(pfx.length)
  if (rest.startsWith(SOFT_SEGMENT) || rest.startsWith(MULTIBASE_BASE58BTC)) return false
  const idBytes = base58Decode(rest)
  return !!idBytes && idBytes.byteLength === 32
}

/** 是否 canonical 形态的设备 did：必须 `did:myco:z` + multibase(0xed01+32B)
 *  且串与公钥派生值精确相等。2026-10-08 设备面单形态定稿：裸 base58、
 *  异前缀（did:youling: 写法的老设备行）一律拒——老客户端用 legacy did
 *  登录将收 400 unsupported_did_format，被迫升级（清档窗口后全员重注册
 *  正是切换点；同一把 device.key 在新客户端派生即为 canonical，无需换钥）。 */
export function isCanonicalDeviceDid(did) {
  const p = parseCryptoDid(did)
  if (!p || p.prefix !== DID_PREFIX) return false
  return did === `${p.prefix}${canonicalMethodId(p.idBytes)}`
}

/** 是否软形 DID（did:myco:participant:<slug>）。 */
export function isSoftDid(did) {
  return typeof did === 'string' && did.startsWith(DID_PREFIX + SOFT_SEGMENT)
}

/** 是否任一合法 myco DID。 */
export function isValidDid(did) {
  return isCryptoDid(did) || isSoftDid(did)
}
