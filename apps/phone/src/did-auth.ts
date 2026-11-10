/**
 * did-auth.ts — X-Did-Auth 请求签名（did Ed25519 鉴权，worker 手机端侧）。
 *
 * 协议对齐 refactor 仓 client_app/example/vending_machine/hibianli.py（服务端权威）：
 *   header  X-Did-Auth: <did> <ts> <sig_b64>          —— 三段空格分隔（L77/L92/L699）
 *   签名内容 msg = `{did}\n{ts}\n` + raw_body          —— 字节级拼接，body 原样参与（L148-150）；
 *             服务端 verify 用头里的 ts **原始字符串**参与（L249-260），故签名的 ts 与头中的
 *             ts 必须逐字符一致（Unix 秒整数，str(int(time.time()))，无前导零/小数）。
 *   签名算法 Ed25519（RFC 8032，64B 确定性签名），sig 以标准 base64（含 padding）传输；
 *             公钥源 = 服务端 guild_org.public_key（裸 base58 = did 尾段）。
 *   ts 窗口 ±300s（L88）+ (did,ts,sig) 一次性重放占用——每次请求取新 ts；
 *             ⚠ 同一秒内对同一 body 重发会同签名撞重放缓存被拒，重试须间隔 ≥1s。
 *
 * 开关纪律（2026-09-26 铺路）：**本地默认关闭**——服务端 hbl_sign_check 三态现处 false，
 * 白发签名头只会污染请求。激活时机=服务端切 "did" 模式时同步打开：
 *   ① 构建期 `VITE_DID_AUTH=1`（.env / CI 注入）；② 联调可 localStorage `youling.didAuth=1`。
 *
 * 签名铁律：**签的=发的**。拦截器只对 body 为 string / Uint8Array / URLSearchParams 的
 * 写请求签名（这些形态能拿到"将要发送的确切字节"）；FormData/Blob 等不可知形态不签
 * （透传），绝不签与发送不一致的内容。
 */
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512.js'
import { currentIdentity, getRootIdentity, getRootSeed } from './identity'

// noble 2.3 的 sha512 后端默认 undefined（HTTP 非安全上下文无 crypto.subtle）——与
// identity.ts 同款注册纯 JS 后端；重复赋值幂等，本模块独立可测（不依赖 identity 先加载）。
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m))

/** 头名（服务端 FastAPI Header(alias='X-Did-Auth')）。 */
export const DID_AUTH_HEADER = 'X-Did-Auth'
/** 协议接受的 did method 前缀（服务端 DID_AUTH_METHOD_PREFIXES 同表：人=youling 机=myco）。 */
export const DID_AUTH_METHOD_PREFIXES = ['did:youling:', 'did:myco:'] as const

const b64 = (u8: Uint8Array): string => btoa(String.fromCharCode(...u8))
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/**
 * 构造 X-Did-Auth 签名内容：`{did}\n{ts}\n` UTF-8 字节 + raw_body 原样字节。
 * 与服务端 hibianli.did_auth_message 字节级一致（对拍见 did-auth.test.ts msgB64）。
 */
export function didAuthMessage(did: string, ts: string, rawBody: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(`${did}\n${ts}\n`)
  const out = new Uint8Array(head.length + rawBody.length)
  out.set(head, 0)
  out.set(rawBody, head.length)
  return out
}

/** ts 取值：Unix 秒整数的十进制字符串（对齐 Python str(int(time.time()))）。
 *  时钟源=设备本地时钟；服务端 ±300s 窗口容手机正常漂移，超窗会被拒（设备时间错乱
 *  属环境问题，签名侧无从代偿）。 */
export function didAuthTsNow(): string {
  return String(Math.floor(Date.now() / 1000))
}

/**
 * 产出 X-Did-Auth 头值：`{did} {ts} {sig_b64}`。
 * @param did   签名身份（did:youling: / did:myco:，须与 seed 对应公钥一致——服务端按 did 尾段查公钥验签）
 * @param seed  Ed25519 私钥种子（32B）
 * @param rawBody 将要发送的请求体字节（签的=发的）
 * @param ts    参与（并出现在头里的）时间戳；缺省取当前秒
 */
export function signDidAuthHeader(
  did: string,
  seed: Uint8Array,
  rawBody: Uint8Array,
  ts: string = didAuthTsNow(),
): string {
  const sig = ed.sign(didAuthMessage(did, ts, rawBody), seed)
  return `${did} ${ts} ${b64(sig)}`
}

// ── 开关（默认关；激活=服务端切 did 模式时同步开）──

const LS_KEY = 'youling.didAuth'

function lsGet(k: string): string | null { try { return localStorage.getItem(k) } catch { return null } }
function lsSet(k: string, v: string): void { try { localStorage.setItem(k, v) } catch { /* 忽略 */ } }

/** 签名头是否启用：构建期 VITE_DID_AUTH=1，或运行期 localStorage youling.didAuth=1（联调）。默认关。 */
export function isDidAuthEnabled(): boolean {
  if ((import.meta.env?.VITE_DID_AUTH as string | undefined) === '1') return true
  return lsGet(LS_KEY) === '1'
}

/** 运行期显式开/关（写 localStorage；清 null 回到"只看构建 flag"）。联调开闸用。 */
export function setDidAuthEnabled(v: boolean | null): void {
  if (v === null) { try { localStorage.removeItem(LS_KEY) } catch { /* 忽略 */ } return }
  lsSet(LS_KEY, v ? '1' : '0')
}

/**
 * 选签名身份：有灵账号根钥（did:youling:，人的身份）优先；无根钥/根钥锁定（enc 模式
 * 未解锁）退设备钥（did:myco:）。两前缀服务端都接受（guild_org 登记哪个用哪个——
 * 激活时运营侧把 worker 身份的公钥落库）。无可签名身份 → null。
 */
export function resolveDidAuthSigningIdentity(): { did: string; seed: Uint8Array } | null {
  const rootDid = getRootIdentity()
  const rootSeedB64 = getRootSeed()
  if (rootDid && rootSeedB64 && rootDid.startsWith('did:youling:')) {
    return { did: rootDid, seed: fromB64(rootSeedB64) }
  }
  const id = currentIdentity()
  if (id?.did.startsWith('did:myco:')) return { did: id.did, seed: fromB64(id.keyB64) }
  return null
}

// ── canonical JSON（固定字节序列化；跨语言对拍钉死）──

/** code point 序比较（Python str 排序语义；JS `<` 是 UTF-16 码元序，非 BMP 字符会排错）。 */
function cmpCodePoints(a: string, b: string): number {
  const x = [...a], y = [...b]
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1
}

/**
 * 确定性 JSON 序列化：递归按 key 排序 + 紧凑分隔，与 Python
 * `json.dumps(obj, sort_keys=True, separators=(',',':'), ensure_ascii=False)` **字节级一致**
 * （对拍见 did-auth.fixture.json canonicalJson）。非 ASCII 原样输出。
 * 适用 string/整数/boolean/null/数组/对象——float 跨语言表示不保证一致（Python repr vs
 * JS toString，如 1.0），业务 body 避免携带 float。
 * 签名场景的正确用法：`const body = canonicalJsonBody(obj)` → 以 body 发送并以 body 签名。
 */
export function canonicalJsonBody(value: unknown): string {
  return serializeCanon(value)
}

function serializeCanon(v: unknown): string {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v)
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(serializeCanon).join(',')}]`
  if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort(cmpCodePoints)
    return `{${keys.map((k) => `${JSON.stringify(k)}:${serializeCanon((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  throw new Error(`canonicalJsonBody: 不支持的类型 ${typeof v}`)
}

// ── fetch 拦截器 ──

/** 取"将要发送的确切字节"；不可知形态返回 null（不签，透传）。 */
function bodyBytes(body: BodyInit | null | undefined): Uint8Array | null {
  if (body == null) return null
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof Uint8Array) return body
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString())
  return null // FormData / Blob / ArrayBuffer / ReadableStream——字节不可知或形态特殊，不签
}

/**
 * X-Did-Auth 签名 fetch 拦截器（收题/提交类请求的统一入口）：
 * - 开关关闭（默认）→ 原样透传，不带签名头（服务端 false 模式下不白发）。
 * - 开启且 init.body 为 string/Uint8Array/URLSearchParams → 取发送字节签名，注入
 *   `X-Did-Auth` 头后转发给全局 fetch（body 原样不动——签的=发的）。
 * - 无可签名身份 / body 形态不可知 → 透传不签（宁可无签名被服务端拒，不可签错内容）。
 */
export async function didAuthFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isDidAuthEnabled()) return fetch(input, init)
  if (input instanceof Request) return fetch(input, init) // body 藏在 Request 里不可靠复刻，透传
  const method = (init?.method ?? 'GET').toUpperCase()
  const bytes = bodyBytes(init?.body)
  if (method === 'GET' || method === 'HEAD' || !bytes) return fetch(input, init)
  const ident = resolveDidAuthSigningIdentity()
  if (!ident) return fetch(input, init)
  const headerValue = signDidAuthHeader(ident.did, ident.seed, bytes)
  const headers = new Headers(init?.headers)
  headers.set(DID_AUTH_HEADER, headerValue)
  return fetch(input, { ...init, headers })
}
