/**
 * identity.ts — 手机端 DID 身份（与 PC 同一套体系，对齐 canvas identity.rs）。
 *
 * 手机的 iroh 密钥就是它的 DID（一把钥，配对与身份同源）：
 *   - 密钥 = noble/ed25519 生成的 32B 种子，**只在 localStorage，从不上服务端**
 *   - DID  = did:myco:<base58(公钥)>（bs58）
 *   - NodeId = iroh 公钥 hex（wasm node_id_of）
 *   - 注册 = 只上传公钥（选 A：无私钥托管，服务器零私钥）
 *   - 登录 = noble Ed25519 签挑战（本地私钥签）
 *
 * 本地存储两种模式（用户可选，见 design/08-identity/IDENTITY-FOR-USERS.md）：
 *   - plain 快速模式：明文 keyB64 存 localStorage，打开即用
 *   - enc  加密模式：PBKDF2(密码)+AES-256-GCM 加密种子存本地，每次输密码解锁
 *   两种模式私钥都**不上服务端**。加密只在本地。
 *
 * wasm 只做 iroh 连接；crypto 全在这里（noble 纯 JS，HTTP 非安全上下文可用）。
 *
 * DID 格式(ADR-005 封版,2026-09-07):人=灵(youling),机=体(myco 菌丝体),双 method 单规则。
 *   有灵账号 = did:youling:<base58(出生公钥)>(裸公钥——解码即公钥,乐观验证;中文界面永远显示
 *   "有灵账号",did:youling 只出现在技术串);设备 = did:myco:<base58(pub)>(设备钥即身份,丢了重关联)。
 *   服务器 /root/create 三重防冲突:派生校验/did 唯一/公钥复用(409 code 区分,容忍 409 幂等)。
 *   409 语义(裸公钥下):did 被占 ⟺ 同一把钥——不是别人抢了名字,是这身份注册过,幂等/恢复即可,
 *   绝不静默重新随机(那会换人格丢画像)。
 */
import * as ed from '@noble/ed25519'
import bs58 from 'bs58'
import { sha512 } from '@noble/hashes/sha512.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { gcm } from '@noble/ciphers/aes.js'
import { didPubkeyBytes } from './didUtil'

// noble 2.3 的 sha512 后端默认 undefined，async 版又依赖 crypto.subtle（HTTP 非安全上下文没有）。
// 注册纯 JS sha512 后端 → sync/async 方法在 HTTP 下都可用（手机卡"生成本机身份"的根因修复）。
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m))
ed.etc.sha512Async = async (...m) => sha512(ed.etc.concatBytes(...m))

/** DID 服务基址：vnext identity-svc（2026-09-15 第29轮随委任状链路迁移，火山退役）。
 *  2026-09-28 第90轮：固定域名 https://myco.youling.cc/myco-id（443 反代 identity-svc:8321）。
 *  旧 PWA 形态兼容：页面托管在 myco.youling.cc 本机时同源（''，路径即 identity-svc）；
 *  myco.youling.cc 时走默认绝对地址——PWA 由 nginx 托管，同源路径没有 /friends 这些
 *  路由，不能用 ''。其余（本地 dev / APK WebView file://）同样用绝对地址（CORS 已放开 *）。 */
const DID_BASE =
  (import.meta.env?.VITE_DID_BASE as string | undefined) ||
  (typeof location !== 'undefined' && location.hostname === 'myco.youling.cc'
    ? ''
    : 'https://myco.youling.cc/myco-id')

export { DID_BASE }

/** 探索入口（2026-10-08 设计定稿：指向平台真身 www.youling.cc）。
 *  历史：第74轮修过"曾指向 youling.cc 老平台"；此后从 DID_BASE origin 推导=
 *  myco 域（登录器服务域）——2026-10-08 拆开：平台页归 www，DID/下载归 myco。
 *  构建期 VITE_NETWORK_URL 覆盖（换环境改 env 不改代码）。 */
export const EXPLORE_URL: string = ((import.meta.env.VITE_NETWORK_URL as string | undefined) || 'https://www.youling.cc').replace(/\/+$/, '') + '/'

// ── 第66轮存储键收敛：myco-phone.*/myco.* → youling.*（2026-09-21，趁未上线去历史包袱）──
// 一次性 copy-if-missing 迁移；旧键保留不删（回滚安全，永不再读）。
// 模块加载即执行——本文件是 App 身份链的首个 import，任何读取前必已迁移。
const LS_KEY_MIGRATE: ReadonlyArray<readonly [string, string]> = [
  ['myco-phone.id.vault', 'youling.vault'],
  ['myco-phone.id.keyB64', 'youling.keyB64'],
  ['myco-phone.accounts', 'youling.accounts'],
  ['myco.delegation', 'youling.delegation'],
  ['myco-phone.attestation', 'youling.attestation'],
  ['myco-phone.mode', 'youling.mode'],
  ['myco-phone.value', 'youling.value'],
  ['myco-phone.relay', 'youling.relay'],
  ['myco-phone.rtcRelay', 'youling.rtcRelay'],
]
try {
  for (const [from, to] of LS_KEY_MIGRATE) {
    const v = localStorage.getItem(from)
    if (v !== null && localStorage.getItem(to) === null) localStorage.setItem(to, v)
  }
  // 前缀式：myco-phone.acc.<did>（账号槽档案：种子/证明）→ youling.acc.<did>
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith('myco-phone.acc.')) {
      const nk = 'youling.acc.' + k.slice('myco-phone.acc.'.length)
      const v = localStorage.getItem(k)
      if (v !== null && localStorage.getItem(nk) === null) localStorage.setItem(nk, v)
    }
  }
} catch { /* localStorage 不可用（隐私模式）——裸跑新键 */ }

const LS = {
  vault: 'youling.vault',     // {mode, keyB64? | ct/salt/iv?}
  legacy: 'youling.keyB64',   // 旧版明文（迁移用）
}

/** multibase 载荷 = 0xed 0x01 + 32B 公钥（spec v0.3 §3.1，ed25519-pub multicodec
 *  头——与 did:key 逐字节同构）。 */
function multibaseEd25519(pub: Uint8Array): Uint8Array {
  const out = new Uint8Array(34)
  out[0] = 0xed
  out[1] = 0x01
  out.set(pub, 2)
  return out
}

/** 有灵账号 did(ADR-005 终形)。spec v0.3（2026-09-30）起 canonical multibase：
 *  did:youling:z<base58btc(0xed 0x01 + 公钥)>——新注册一律此形态。
 *  旧格式 did:soul:base58(sha256(pub)) 与裸 base58（did:youling:/did:myco:）由
 *  服务器兼容识别，vault 里已存的 rootDid 串原样沿用（存量不迁移）。 */
const rootDidOf = (rootPub: Uint8Array): string => `did:youling:z${bs58.encode(multibaseEd25519(rootPub))}`

const PBKDF2_ITERS = 150_000

export type StorageMode = 'plain' | 'enc'

export interface PhoneIdentity {
  keyB64: string
  nodeId: string
  did: string
}

const b64 = (u8: Uint8Array): string => btoa(String.fromCharCode(...u8))
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
/** 公钥 → iroh NodeId（32B Ed25519 公钥的 hex，与 wasm node_id_of 一致，纯 JS 算）。 */
const toNodeId = (pubkey: Uint8Array): string =>
  Array.from(pubkey, (b) => b.toString(16).padStart(2, '0')).join('')

function identityFromSeed(keyB64: string): PhoneIdentity {
  const seed = fromB64(keyB64)
  const pubkey = ed.getPublicKey(seed)
  // spec v0.3：设备 did 一律 canonical multibase（did:myco:z…）；服务器双收，
  // 老版本注册的 legacy 行按变体查找命中。
  return { keyB64, nodeId: toNodeId(pubkey), did: `did:myco:z${bs58.encode(multibaseEd25519(pubkey))}` }
}

// 会话内存缓存：plain 自动加载或 enc 解锁后填充；App/Pairing 据此判断是否已就绪
let _identity: PhoneIdentity | null = null
// myco 根钥内存缓存：plain 从 vault 读 / enc 解锁后填充；enc 锁定时为 null（root 操作需先解锁）
let _rootSeedB64: string | null = null

/** 当前可用的 myco 根钥（内存）。plain 模式从 vault 读；enc 模式需先解锁，否则 null。 */
export function getRootSeed(): string | null {
  if (_rootSeedB64) return _rootSeedB64
  const v = readVault()
  if (v?.mode === 'plain') { _rootSeedB64 = v.rootSeedB64 ?? null; return _rootSeedB64 }
  return null // enc 模式未解锁
}

/**
 * 根钥不可用的**原因**（2026-10-08 用户实测修复）。
 *
 * <p>此前 UI 把所有"取不到根钥"一律说成「本机是成员设备，不持有账号根钥」——但
 * 实际有两种完全不同的原因：**加密模式未解锁**（可自助解锁后备份）与**确实非主设备**
 * （管理要去主设备）。主设备在加密模式下点备份会得到误导文案（用户原话"像玩用户一样"）。
 *
 * @returns `'locked'` 加密模式未解锁（给「去解锁」出路）/ `'not-main'` 非主设备 /
 *          `null` 根钥可用
 */
export function rootSeedUnavailableReason(): 'locked' | 'not-main' | null {
  if (getRootSeed()) return null
  const v = readVault()
  return v?.mode === 'enc' ? 'locked' : 'not-main'
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${DID_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ── 本地存储读写 ──

interface Vault {
  mode: StorageMode
  keyB64?: string          // plain 模式（本设备钥）
  ct?: string              // enc 模式：密文
  salt?: string
  iv?: string
  /** 根账号（一身份多设备钥）：根私钥 + 根 did。设备钥挂其下。 */
  rootSeedB64?: string
  rootDid?: string
}

/** 容错 localStorage：某些浏览器（如华为/百度浏览器在 http:// 非 HTTPS 源上）会禁用
 *  或抛错 localStorage。全部 try/catch，失败不阻塞——退化为"读不到/存不下"，身份
 *  走内存（plain 仍能用，只是不持久，刷新换 key）。否则 App 启动 ensurePlainIdentity
 *  抛错被吞 → identity 永远 null → 灰屏。 */
function lsGet(k: string): string | null { try { return localStorage.getItem(k) } catch { return null } }
function lsSet(k: string, v: string): void { try { localStorage.setItem(k, v) } catch { /* 忽略 */ } }
function lsDel(k: string): void { try { localStorage.removeItem(k) } catch { /* 忽略 */ } }

/** APK 壳双副本(2026-09-05):vault 除 localStorage 外镜像一份到 APK 私有文件
 *  (getFilesDir,经 MycoShell 桥)。WebView localStorage 被「清数据/存储回收」时
 *  从这里兜底恢复。云端零私钥不变——这是纯本机的第二副本。
 *  非 APK 环境(浏览器 PWA)无桥,静默降级为单副本。 */
type ShellBridge = { MycoShell?: { vaultBackup?: (t: string) => void; vaultRestore?: () => string } }
function mirrorSave(json: string): void {
  try { (window as unknown as ShellBridge)?.MycoShell?.vaultBackup?.(json) } catch { /* 忽略 */ }
}
function mirrorLoad(): string | null {
  try {
    const v = (window as unknown as ShellBridge)?.MycoShell?.vaultRestore?.()
    return typeof v === 'string' && v ? v : null
  } catch { return null }
}

function readVault(): Vault | null {
  let v = lsGet(LS.vault)
  if (!v) {
    const m = mirrorLoad()
    if (m) { lsSet(LS.vault, m); v = m } // 本机双副本恢复:文件 → localStorage
  }
  if (v) { try { return JSON.parse(v) as Vault } catch { /* 坏了 */ } }
  // 迁移旧版明文 keyB64
  const legacy = lsGet(LS.legacy)
  if (legacy) {
    const migrated: Vault = { mode: 'plain', keyB64: legacy }
    const json = JSON.stringify(migrated)
    lsSet(LS.vault, json); mirrorSave(json)
    lsDel(LS.legacy)
    return migrated
  }
  return null
}

function writeVault(v: Vault): void {
  const json = JSON.stringify(v)
  lsSet(LS.vault, json)
  mirrorSave(json)
}

/** 当前本地存储模式（null = 还没有身份）。 */
export function getStorageMode(): StorageMode | null {
  return readVault()?.mode ?? null
}

/** 当前会话已加载的身份（plain 自动加载或 enc 解锁后）。null = 未就绪/已锁。 */
export function currentIdentity(): PhoneIdentity | null {
  return _identity
}

// 有灵账号名缓存（Pairing 拉总览/改名时写；聊天气泡"自己名"显示用——多端共用时区分"谁说的"）
let _accountName = ''
export function setYoulingNameCache(n: string): void { _accountName = n }
/** 读侧兜底链清洗：哨兵/空白 → ''（消费方已有 || 兜底）——「有灵账号」绝不作为昵称值外流。 */
export function currentYoulingName(): string { return nicknameValue(_accountName) }

/**
 * plain 模式（或首次无身份）：加载或生成明文种子，缓存身份。
 * enc 模式抛错（必须先 unlockIdentity）。
 */
/** 采纳本机设备钥(桌面 aop 注入:与 myco 共享 iroh-secret)——替代本进程随机生成。
 *  已加密(enc)身份不动(手机作具身持根钥的场景);保留 rootSeedB64 不丢账号钥。 */
export function adoptDeviceKey(keyB64: string): PhoneIdentity | null {
  try {
    const id = identityFromSeed(keyB64) // 非法钥抛错
    const v = readVault()
    if (v?.mode === 'enc') return null
    if (v?.mode === 'plain' && v.keyB64 === keyB64) { _identity = id; return id }
    writeVault({ mode: 'plain', keyB64, rootSeedB64: v?.rootSeedB64 })
    _identity = id
    return id
  } catch { return null }
}

export async function ensurePlainIdentity(): Promise<PhoneIdentity | null> {
  const v = readVault()
  if (v?.mode === 'enc') throw new Error('身份已加密，请先输密码解锁')
  if (v?.mode === 'plain' && v.keyB64) {
    // 2026-10-09（用户要求登出）：若本账号已登出（loggedOut 标记），不自动进账号——
    // 返回 null，UI 显示"已登出，点击进入/解锁"（用户主动登录才进）。
    if (v.rootDid && isLoggedOut(v.rootDid)) return null
    _identity = identityFromSeed(v.keyB64)
    _rootSeedB64 = v.rootSeedB64 ?? null
    return _identity
  }
  // 首次：生成明文身份（默认快速模式）
  const keyB64 = b64(ed.utils.randomPrivateKey())
  writeVault({ mode: 'plain', keyB64 })
  _identity = identityFromSeed(keyB64)
  return _identity
}

/** 登出标记读取（2026-10-09）：与 logoutYouling 写入同键。 */
function isLoggedOut(did: string): boolean {
  try { return localStorage.getItem(`youling.acct.${did.slice(-8)}.loggedOut`) === '1' } catch { return false }
}

/**
 * enc 模式解锁：用密码解密种子，缓存身份。返回 true=成功，false=密码错。
 * plain 模式调用无意义（直接 ensurePlainIdentity）。
 */
export async function unlockIdentity(password: string): Promise<boolean> {
  const v = readVault()
  if (v?.mode !== 'enc' || !v.ct || !v.salt || !v.iv) return false
  try {
    const key = pbkdf2(sha256, new TextEncoder().encode(password), fromB64(v.salt), { c: PBKDF2_ITERS, dkLen: 32 })
    const plain = gcm(key, fromB64(v.iv)).decrypt(fromB64(v.ct)) // 解密失败会 throw
    // 新格式：UTF8 JSON {keyB64, rootSeedB64?}（设备钥+有灵根钥一起）；旧格式：裸 32B 设备种子（回退）
    let keyB64: string
    let rootSeedB64: string | null = null
    if (plain.length === 32) {
      keyB64 = b64(plain)
    } else {
      const parsed = JSON.parse(new TextDecoder().decode(plain))
      keyB64 = parsed.keyB64
      rootSeedB64 = parsed.rootSeedB64 ?? null
    }
    _identity = identityFromSeed(keyB64)
    _rootSeedB64 = rootSeedB64
    return true
  } catch {
    return false
  }
}

/** plain → enc：用密码把明文种子加密存本地。 */
export async function enableEncryption(password: string): Promise<void> {
  if (!password.trim()) throw new Error('密码不能为空')
  if (!_identity) throw new Error('身份未加载')
  // 设备钥 + 有灵根钥 一起加密（修旧版只加密设备钥、丢 myco 根钥的 bug）。rootDid 公开留明文。
  const payload = new TextEncoder().encode(JSON.stringify({ keyB64: _identity.keyB64, rootSeedB64: _rootSeedB64 }))
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = pbkdf2(sha256, new TextEncoder().encode(password), salt, { c: PBKDF2_ITERS, dkLen: 32 })
  const ct = gcm(key, iv).encrypt(payload)
  const v = readVault()
  writeVault({ mode: 'enc', ct: b64(ct), salt: b64(salt), iv: b64(iv), rootDid: v?.rootDid })
}

/** enc → plain：用密码解密后存明文。密码错抛错。 */
export async function disableEncryption(password: string): Promise<void> {
  const v = readVault()
  if (v?.mode !== 'enc') return
  const ok = await unlockIdentity(password)
  if (!ok) throw new Error('密码不对')
  if (_identity) writeVault({ mode: 'plain', keyB64: _identity.keyB64, rootSeedB64: _rootSeedB64 ?? undefined, rootDid: v.rootDid })
}

// ── 多账号槽（第33轮，demo 定稿"完全还原"）：vault 永远持「活动账号」（rootSeed/rootDid
// 语义不变，现有读写零改），其余账号归档在 acc.<did>，索引在 accounts。角色动态算：
// 有 seedB64=主设备（本机持钥）；只有 attestation=分身（被授权）。类似 web3 钱包多账户。──
export interface AccountEntry {
  rootDid: string
  name: string
  role: 'embodiment' | 'agent' | 'lost'
  lastLogin: number
}
const LS_ACCOUNTS = 'youling.accounts'
const accKey = (did: string) => `youling.acc.${did}`
interface AccArchive { seedB64?: string; attestation?: Attestation }

// ── 账号昵称显示兜底链（2026-09-30 四修，与 env/ui/src/lib/accountDisplay.ts 同源约定）：
// 数据层把「无名字」落成哨兵「有灵账号」（本文件 upsertAccount/后端 account_name 兜底），
// 显示层绝不把它当昵称值：显示文案→「未命名」，输入框→空串配 placeholder，短标 昵称 ·…尾4（省略号统一 …）。──
const NAMELESS_SENTINEL = '有灵账号'
/** 昵称原值清洗：空/哨兵 → ''，其余 trim 原样。 */
export function nicknameValue(name: string | null | undefined): string {
  const t = (name ?? '').trim()
  return t && t !== NAMELESS_SENTINEL ? t : ''
}
/** 账号显示名：空/哨兵 →「未命名」。 */
export function accountDisplayName(name: string | null | undefined): string {
  return nicknameValue(name) || '未命名'
}
/** 账号短标（顶栏/菜单头/登录完成屏）：`昵称 ·…尾4`——did 全文只留公钥行一处。 */
export function accountShortLabel(name: string | null | undefined, did: string): string {
  const tail = (did || '').slice(-4)
  return tail ? `${accountDisplayName(name)} ·…${tail}` : accountDisplayName(name)
}

// ── 2026-10-01 账号重排新增（实现单一源=ui-kit accountDisplay，同 scanAddOrder/backupMask 先例）：
// accountTail=全页尾号唯一格式 …尾4；credText=本机凭据状态文案（role 是「本机对该账号
// 持有什么凭据」不是账号属性——不再用主设备/分身短词当徽章）。──
export { accountTail, credText } from '@myco/accountDisplay'

function readAccounts(): { rootDid: string; name?: string; lastLogin?: number }[] {
  try { return JSON.parse(localStorage.getItem(LS_ACCOUNTS) || '[]') } catch { return [] }
}
function writeAccounts(list: { rootDid: string; name?: string; lastLogin?: number }[]) {
  try { localStorage.setItem(LS_ACCOUNTS, JSON.stringify(list)) } catch { /* 容错 */ }
}
function readArchive(did: string): AccArchive | null {
  try { return JSON.parse(localStorage.getItem(accKey(did)) || 'null') } catch { return null }
}
function writeArchive(did: string, a: AccArchive) {
  try { localStorage.setItem(accKey(did), JSON.stringify(a)) } catch { /* 容错 */ }
}

/** 账号索引 + 角色动态计算（demo 定稿：昵称·…尾4 + 主设备/分身徽标）。 */
export function listAccounts(): AccountEntry[] {
  const cur = getRootIdentity()
  return readAccounts().map((e) => {
    const arc = readArchive(e.rootDid)
    // 角色按凭据档形态：种子=主设备；attestation=分身；都没有=凭据已失（当前活动账号的种子在 vault 里，归档即时补——见 archiveActive）
    void cur
    const role: AccountEntry['role'] = arc?.seedB64 ? 'embodiment' : arc?.attestation ? 'agent' : 'lost'
    return { rootDid: e.rootDid, name: e.name || '有灵账号', role, lastLogin: e.lastLogin ?? 0 }
  })
}

/** 账号 upsert（创建/恢复/收编/改名成功处调用；当前活动账号自动归档到 acc.<did>）。 */
function upsertAccount(rootDid: string, name?: string) {
  const list = readAccounts()
  const i = list.findIndex((e) => e.rootDid === rootDid)
  if (i >= 0) {
    if (name) list[i].name = name
    list[i].lastLogin = Date.now()
  } else {
    list.push({ rootDid, name: name || '有灵账号', lastLogin: Date.now() })
  }
  writeAccounts(list)
  archiveActive(rootDid, name)
}

/**
 * 账号名落库（2026-10-16 修「账号列表全是未命名」——用户真机报）：
 * 云端名只在总览 effect 到达，此前只填 React state + 模块缓存，**从不写回
 * LS_ACCOUNTS** → 账号列表/欢迎屏「本机关联的有灵账号」/登录完成屏全显示「未命名」。
 * 只改 name 不动 lastLogin（与 upsertAccount 分离——总览 10s 一拍，不能把
 * 「最后登录」刷成永远=现在）；账号不在索引则不凭空造条目。
 */
export function saveAccountName(rootDid: string, name: string): void {
  const n = nicknameValue(name)
  if (!n) return
  const list = readAccounts()
  const i = list.findIndex((e) => e.rootDid === rootDid)
  if (i < 0 || list[i].name === n) return
  list[i].name = n
  writeAccounts(list)
}

/** 归档指定账号的凭据（seed 若本机持有 / attestation 若有）。 */
function archiveActive(rootDid: string, name?: string) {
  void name
  const v = readVault()
  const arc = readArchive(rootDid) ?? {}
  const attest = getAttestation()
  if (v?.rootDid === rootDid && v.rootSeedB64) arc.seedB64 = v.rootSeedB64
  if (attest && attest.rootDid === rootDid) arc.attestation = attest
  writeArchive(rootDid, arc)
}

/** 切换活动账号（demo：本地直切秒登，无需扫码）。当前账号先归档；目标按凭据形态装载
 *  （seed→主设备态；attestation→分身态）。成功 true；目标无凭据 false。 */
export function switchAccount(rootDid: string): boolean {
  const v = readVault()
  // 当前活动账号归档
  if (v?.rootDid && v.rootDid !== rootDid) {
    const arc = readArchive(v.rootDid) ?? {}
    if (v.rootSeedB64) arc.seedB64 = v.rootSeedB64
    const at = getAttestation()
    if (at && at.rootDid === v.rootDid) arc.attestation = at
    writeArchive(v.rootDid, arc)
  }
  const target = readArchive(rootDid)
  if (!target || (!target.seedB64 && !target.attestation)) return false
  // 装载目标：vault 的设备钥（keyB64/ct）不动，只换 root 部分
  if (!v) return false
  const nv: Vault = v.mode === 'plain'
    ? { mode: 'plain', keyB64: v.keyB64 }
    : { mode: 'enc', ct: v.ct, salt: v.salt, iv: v.iv }
  let name: string | undefined
  if (target.seedB64) {
    nv.rootSeedB64 = target.seedB64
    nv.rootDid = rootDid
    _rootSeedB64 = target.seedB64
    name = '有灵账号'
  } else if (target.attestation) {
    nv.rootDid = rootDid
    _rootSeedB64 = null
    storeAttestation(target.attestation)
  }
  writeVault(nv)
  const list = readAccounts()
  const i = list.findIndex((e) => e.rootDid === rootDid)
  if (i >= 0) { list[i].lastLogin = Date.now(); name = list[i].name || name }
  writeAccounts(list)
  // 2026-10-16 修「退出后点账号登不进去」（用户真机报）：切换=明确的登录意图——
  // 必须清掉目标账号的 loggedOut 标记；否则下次启动 ensurePlainIdentity 仍读到
  // loggedOut → identity=null → 点完账号完成屏一关，还停在欢迎页（=没登进去）。
  try { localStorage.removeItem(`youling.acct.${rootDid.slice(-8)}.loggedOut`) } catch { /* 忽略 */ }
  return true
}

/** 删除账号槽（解绑/被除名时）：索引 + 凭据档 + 若是活动账号清 vault root。 */
function removeAccountSlot(rootDid: string) {
  writeAccounts(readAccounts().filter((e) => e.rootDid !== rootDid))
  try { localStorage.removeItem(accKey(rootDid)) } catch { /* 容错 */ }
  try { localStorage.removeItem(accKey(rootDid) + '.deleg') } catch { /* 容错 */ }
  // 旧格式停试标记一并清（2026-10-07）：解绑即弃该账号——标记随槽走，不留给下一账号
  try { localStorage.removeItem(legacyFmtKey(rootDid)) } catch { /* 容错 */ }
}

// ── 名册自愈 + 旧格式闸门（C1，2026-10-07 与 PC core identity.rs roster_self_heal 对齐）──
//
// 事故实锤（群体评审）：服务端清档（identity.db 重建，只收 canonical did）后，手机端
// createRootIdentity 幂等短路（本地已有 rootDid 直接返回）——名册 404 无人重建，
// 账号层加好友/设备全 403 半瘫。PC 侧 account_status 顺带自愈已久，手机补齐：
//   GET /root/<myDid> 200 → 在册不动；404 → POST /root/create 重建（409 幂等算成功）；
//   create 400 code=unsupported_did_format → 旧格式账号（服务端闸门一律拒建）——
//   本地 sticky 标记 accountFormatLegacy + UI 引导条（解绑重注册/导恢复码再导入，
//   与 PC 同款文案），重试无意义不再发。

// 判定一律以服务端应答为准（与 PC 同款）：不做本地 did 形态预判——400 落在服务端
// 日志里也是「旧格式存量统计」的兜底数据。

/** 旧格式停试标记（per-did sticky；解绑/重建成功清位）的存储键。 */
const legacyFmtKey = (did: string): string => `youling.legacyFmt.${did}`

/** 本机当前账号是否旧格式已停用（UI 引导条数据源）：仅认服务端 400 确认过的
 *  sticky 标记（与 PC ACCOUNT_FORMAT_LEGACY 同源语义）。未关联账号 false。 */
export function accountFormatLegacy(): boolean {
  const did = getRootIdentity()
  return did ? lsGet(legacyFmtKey(did)) === '1' : false
}

/** 名册自愈结果（与 PC RosterHealOutcome 对齐的子集）。 */
export type RootRosterOutcome = 'present' | 'rebuilt' | 'legacy' | 'skip' | 'uncertain'

/** 自愈防重入（同 PC ROSTER_HEAL_INFLIGHT）：同一时刻最多一个在飞。 */
let _rosterHealInflight = false

/** 名册响应里本机设备是否在册（对齐 PC `core/myco-core/src/identity.rs` 的
 *  `roster_has_device`）：true=在册 / false=明确缺失 / null=响应无 devices（探测不可用）。
 *  已吊销行（revoked≠0）不算在册——补登记会 ON CONFLICT 复活它（自愈意图：
 *  本机此刻持该账号种子 ⇒ 它就是该账号的设备）。 */
function rosterHasDevice(body: unknown, devicePubkeyB64: string): boolean | null {
  const devices = (body as { data?: { devices?: unknown } } | null)?.data?.devices
  if (!Array.isArray(devices)) return null
  let want: Uint8Array
  try { want = fromB64(devicePubkeyB64) } catch { return null }
  return devices.some((d) => {
    const dd = d as { pubkeyB64?: string; revoked?: number }
    if ((dd.revoked ?? 0) !== 0) return false
    const p = dd.pubkeyB64
    if (typeof p !== 'string') return false
    if (p === devicePubkeyB64) return true
    try { const got = fromB64(p); return got.length === 32 && want.length === 32 && got.every((x, i) => x === want[i]) } catch { return false }
  })
}

/** 名册自愈（低频：启动/账号就绪/切号时调用，不做轮询）：
 *  GET /root/<myDid> 404 → 用本地根钥 /root/create 重建（rootSig 与 createRootIdentity
 *  同款 `create\n{rootDid}\n{rootPubkeyB64}`；服务端 2xx/409 幂等）。
 *  200 但**本机设备不在册** → /root/device/add 补登记（2026-10-09 P1-1，对齐 PC
 *  `ensure_device_in_root_at`——此前手机 200 直接 return 'present'，掉出名册永不自愈，
 *  表现为"设备群/我的设备 显示设备数缺人"）。
 *  create 400 code=unsupported_did_format → 'legacy'（旧格式账号，标记 sticky 不再
 *  重试）；无根钥/enc 锁定 → 'skip'；网络不可达/其他失败 → 'uncertain'（不标记，
 *  下次触发再试）。 */
export async function ensureRootRoster(): Promise<RootRosterOutcome> {
  const rootDid = getRootIdentity()
  const rootSeedB64 = getRootSeed()
  if (!rootDid || !rootSeedB64) return 'skip' // 未关联/enc 锁定——无从签名
  if (accountFormatLegacy()) return 'legacy'  // 已检出旧格式——重试无意义，直接短路
  if (_rosterHealInflight) return 'skip'      // 上一次还在飞（离线/慢网），不叠加
  _rosterHealInflight = true
  try {
    let probe: Response
    try {
      probe = await fetch(`${DID_BASE}/root/${encodeURIComponent(rootDid)}`, { signal: AbortSignal.timeout(8000) })
    } catch { return 'uncertain' } // 超时/连不上——不重建（防误判）
    if (probe.status !== 404) {
      // 2xx=名册在（但要再核本机设备是否在册）；其他 4xx/5xx 保守不动
      if (!probe.ok) return 'uncertain'
      const body = await probe.json().catch(() => null)
      const selfId = currentIdentity() ?? (await ensurePlainIdentity())
      if (!selfId) return 'present' // 已登出无设备钥——无从补登记
      const devicePubkeyB64 = b64(ed.getPublicKey(fromB64(selfId.keyB64)))
      if (rosterHasDevice(body, devicePubkeyB64) === true) return 'present' // 在册——零写
      // 本机不在册（明确缺失 / 探测不可用）→ 补登记（幂等）
      const issuedAt = Date.now()
      const attestSig = signWithSeed(rootSeedB64, `attest\n${rootDid}\n${devicePubkeyB64}\n${issuedAt}`)
      const ra = await fetch(`${DID_BASE}/root/device/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootDid, pubkeyB64: devicePubkeyB64, name: 'MYCO', issuedAt, attestSigB64: attestSig, rootSig: attestSig }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => null)
      if (ra?.status === 400) {
        const b = await ra.json().catch(() => null)
        if ((b as { code?: string } | null)?.code === 'unsupported_did_format') { lsSet(legacyFmtKey(rootDid), '1'); return 'legacy' }
      }
      return ra?.ok ? 'rebuilt' : 'uncertain' // 'rebuilt' 兼表"做过名册写操作"（补登记）
    }
    // 名册确实没有本账号（root not found）→ 重建。rootDid 原样沿用 vault 存串：
    // 旧格式串会被服务端闸门 400 拒（这正是检出路径），绝不擅自重算 canonical 冒建新身份。
    const rootPub = ed.getPublicKey(fromB64(rootSeedB64))
    const rootPubkeyB64 = b64(rootPub)
    const id = currentIdentity() ?? (await ensurePlainIdentity())
    if (!id) throw new Error('身份未就绪（本机已登出，请先登录或恢复后再注册）')
    const devicePubkeyB64 = b64(ed.getPublicKey(fromB64(id.keyB64)))
    const rootSig = signWithSeed(rootSeedB64, `create\n${rootDid}\n${rootPubkeyB64}`)
    const localName = readAccounts().find((e) => e.rootDid === rootDid)?.name || '有灵账号'
    let r: Response
    try {
      r = await fetch(`${DID_BASE}/root/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootDid, rootPubkeyB64, devicePubkeyB64, name: localName, deviceName: 'MYCO', rootSig }),
        signal: AbortSignal.timeout(8000),
      })
    } catch { return 'uncertain' }
    if (r.status === 400) {
      const body = await r.json().catch(() => null)
      if ((body as { code?: string } | null)?.code === 'unsupported_did_format') {
        lsSet(legacyFmtKey(rootDid), '1')
        console.warn(`[identity] 名册自愈：账号旧格式被服务端拒（…${rootDid.slice(-4)}）——已标记 accountFormatLegacy 引导解绑重注册，不再重试`)
        return 'legacy'
      }
      return 'uncertain' // 其他 400（缺字段等）——不标记，下次再试
    }
    if (r.status !== 201 && r.status !== 409) return 'uncertain'
    lsDel(legacyFmtKey(rootDid)) // 重建成功——清历史误标（若有）
    return 'rebuilt'
  } catch {
    return 'uncertain'
  } finally {
    _rosterHealInflight = false
  }
}

// ── 根账号（一身份多设备钥，个人 CA；服务端 identity/root.mjs）──

/** 用指定私钥签（rootSig 用）。 */
function signWithSeed(seedB64: string, msg: string): string {
  const sig = ed.sign(new TextEncoder().encode(msg), fromB64(seedB64))
  return b64(sig)
}

/** 账号/设备身份退出前，停止原生隧道并清除 Keystore 中的 arm 配置。
 *  防“已注销/换设备钥后，START_STICKY 又把旧设备种子恢复回来”。
 *  只调现有 vnetRdpDisarm，不读取也不导出任何种子。 */
function clearNativeTunnelArms(): void {
  try {
    ;(window as unknown as { MycoShell?: { vnetRdpDisarm?: () => string } })
      .MycoShell?.vnetRdpDisarm?.()
  } catch { /* Web/PWA 无原生桥，无需处理 */ }
}

/** 解绑 有灵账号：清本机 账号种子+DID+attestation，设备回到未关联。myco 设备钥保留。
 *  plain 模式直接清 rootSeed/rootDid；enc 模式去 rootDid（rootSeed 在加密块里，rootDid 没了即视为未关联）。
 *  第96轮（修复1）：chat 本地数据（youling.chat.<safeDid>.* 桶 + 旧全局残留）随解绑清理——
 *  账号数据不留给下一个登录者（串号/隐私双防）。 */
export function unbindYouling(): void {
  // 先使当前身份代际失效：vnet-forward 的周期/在途刷新都会重新读
  // currentIdentity，若仍给旧种子，disarm 后会立刻 re-arm 并写回恢复记录。
  _identity = null
  clearNativeTunnelArms()
  const v = readVault()
  if (v?.rootDid) removeAccountSlot(v.rootDid)   // 多账号：索引+凭据档一并清（第33轮）
  if (v?.rootDid) clearChatLocalData(v.rootDid)  // 第96轮：chat 桶+旧全局键
  if (v) {
    if (v.mode === 'plain') writeVault({ mode: 'plain', keyB64: v.keyB64 })
    else writeVault({ mode: 'enc', ct: v.ct, salt: v.salt, iv: v.iv })
  }
  _rootSeedB64 = null
  try { localStorage.removeItem('youling.attestation') } catch { /* 忽略 */ }
}

/** 登出（2026-10-09 用户要求）：清会话态但**保留账号钥**——与「解绑」分层：
 *  解绑=删账号钥（永久），登出=只退出当前登录（钥匙还在，随时可再登录/切换账号）。
 *  实现：标 `loggedOut=true`（与 PC `accounts_mark_logged_out` 同语义），
 *  下次启动**不自动进账号**（显示"已登出，点击进入/解锁"），除非用户主动登录。 */
export function logoutYouling(): void {
  _identity = null
  clearNativeTunnelArms()
  const v = readVault()
  if (v?.rootDid) {
    // 多账号槽位：标 loggedOut（与 PC accounts.json 同构）
    const key = `youling.acct.${v.rootDid.slice(-8)}.loggedOut`
    try { localStorage.setItem(key, '1') } catch { /* 忽略 */ }
  }
  // 清内存态（下次启动 readVault 会读到 loggedOut → 不自动进）
  _rootSeedB64 = null
  try { localStorage.removeItem('youling.attestation') } catch { /* 忽略 */ }
}

/** 从本机注销设备（2026-10-09 用户要求，与 PC `myco_device_logout` 同语义）：
 *  清**本机设备钥**（`keyB64`）+ 会话（attestation）+ 登出标记——本机回"全新设备"态
 *  （重开=一台新设备，需重新注册/被收编）。**账号钥（`rootSeedB64`/`rootDid`）保留**——
 *  与「解绑账号」分层（解绑=删账号钥，注销=只删设备钥）。 */
export function deviceLogoutYouling(): void {
  _identity = null
  clearNativeTunnelArms()
  const v = readVault()
  if (v) {
    // 清设备钥（keyB64），保留账号钥（rootSeedB64/rootDid）
    if (v.mode === 'plain') writeVault({ mode: 'plain', rootSeedB64: v.rootSeedB64, rootDid: v.rootDid })
    else writeVault({ mode: 'enc', ct: v.ct, salt: v.salt, iv: v.iv, rootSeedB64: v.rootSeedB64, rootDid: v.rootDid })
  }
  _rootSeedB64 = null
  try { localStorage.removeItem('youling.attestation') } catch { /* 忽略 */ }
  // 清登出标记（新设备不再是"已登出"）
  if (v?.rootDid) { try { localStorage.removeItem(`youling.acct.${v.rootDid.slice(-8)}.loggedOut`) } catch { /* 忽略 */ } }
}

/** 第96轮（修复1）：清某账号的 chat localStorage 数据——分桶键 youling.chat.<safeDid>.*
 *  全删；旧全局键（无 <safeDid> 段，分桶前形态，必属本账号——单账号时代产物）同删。
 *  独立于 chat-store 实现（identity 不反向依赖 chat 模块，避免环）。 */
function clearChatLocalData(rootDid: string): void {
  try {
    const scoped = `youling.chat.${rootDid.replace(/[:/]/g, '_')}.`
    const legacyFixed = ['friends', 'groups', 'tasks', 'seen', 'friendsMigrated86', 'media.index', 'drafts', 'convprefs'].map((s) => `youling.chat.${s}`)
    const legacyPrefixes = ['youling.chat.conv.', 'youling.chat.convmeta.', 'youling.chat.media.']
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k) continue
      if (k.startsWith(scoped) || legacyFixed.includes(k) || legacyPrefixes.some((p) => k.startsWith(p))) doomed.push(k)
    }
    doomed.forEach((k) => localStorage.removeItem(k))
  } catch { /* localStorage 不可用（隐私模式）——忽略 */ }
}

/** 当前根账号 did（无则 null）。 */
export function getRootIdentity(): string | null {
  return readVault()?.rootDid ?? null
}

/** 根钥签任意消息（YoulingLogin 扫码确认用；消息如 "myco-auth\n{ticket}"）。
 *  无根钥/enc 锁定 → null（分身设备走 delegation.ts 的设备钥+委任状路径）。 */
export function signWithRoot(msg: string): string | null {
  const rootDid = getRootIdentity()
  const seedB64 = getRootSeed()
  if (!rootDid || !seedB64) return null
  return signWithSeed(seedB64, msg)
}

/** 是否已有根账号。 */
export function hasRootIdentity(): boolean {
  return !!readVault()?.rootDid
}

/** 创建根账号：生成根钥，注册到服务端（本设备=第一台授权设备），存 vault + 自签 attestation。幂等（已有直接返回）。
 *  旧格式迁移(ADR-005)：vault 里存着 did:soul:hash 时代身份时，复用原根钥重算 did:youling:base58(pub)
 *  重新注册(409 幂等)——身份不变(同一把钥)，只是 did 前缀升级。enc 锁定拿不到根钥则先返回旧 did。 */
export async function createRootIdentity(name: string): Promise<string> {
  const existing = getRootIdentity()
  if (existing && !existing.startsWith('did:soul:')) return existing
  const legacySeed = existing ? (getRootSeed() ?? readVault()?.rootSeedB64 ?? null) : null
  if (existing && !legacySeed) return existing // enc 锁定：根钥在加密块里，解锁后再进此函数迁移
  const id = currentIdentity() ?? (await ensurePlainIdentity())
  if (!id) throw new Error('身份未就绪（本机已登出，请先登录或恢复后再创建账号）')
  const rootSeedB64 = legacySeed ?? b64(ed.utils.randomPrivateKey())
  const rootPub = ed.getPublicKey(fromB64(rootSeedB64))
  const rootDid = rootDidOf(rootPub)
  const rootPubkeyB64 = b64(rootPub)
  const devicePubkeyB64 = b64(ed.getPublicKey(fromB64(id.keyB64)))
  const rootSig = signWithSeed(rootSeedB64, `create\n${rootDid}\n${rootPubkeyB64}`)
  const r = await post('/root/create', { rootDid, rootPubkeyB64, devicePubkeyB64, name: name || '有灵账号', deviceName: 'MYCO', rootSig })
  if (r.status !== 201 && r.status !== 409) {
    throw new Error(`创建根账号失败 (${r.status}): ${(await r.text()).slice(0, 120)}`)
  }
  const v = readVault() ?? { mode: 'plain' as StorageMode }
  writeVault({ ...v, rootSeedB64, rootDid })
  _rootSeedB64 = rootSeedB64
  // 自签 attestation（本设备归属凭证，携带用）
  selfAttest(rootDid, id.keyB64, rootSeedB64)
  upsertAccount(rootDid, name)
  return rootDid
}

/**
 * 从备份恢复 有灵账号（成为主设备）。备份可为：明文 seedB64，或加密的 `ct=..\nsalt=..\niv=..` + 密码。
 * 恢复后本机 myco 钥被该账号 attest 入名册 + 自签 attestation 本地携带 + 主设备自报。
 */
export async function importRootIdentity(text: string, password: string): Promise<string> {
  const trimmed = text.trim()
  let rootSeedB64: string
  if (trimmed.startsWith('ct=')) {
    const pick = (k: string) => trimmed.match(new RegExp(`${k}=([^\\s]+)`))?.[1]
    const ct = pick('ct'), salt = pick('salt'), iv = pick('iv')
    if (!ct || !salt || !iv) throw new Error('加密备份格式不对（缺 ct/salt/iv）')
    if (!password) throw new Error('加密备份需要密码')
    const key = pbkdf2(sha256, new TextEncoder().encode(password), fromB64(salt), { c: PBKDF2_ITERS, dkLen: 32 })
    const seed = gcm(key, fromB64(iv)).decrypt(fromB64(ct)) // 解密失败 throw
    if (seed.length !== 32) throw new Error('密码不对或备份损坏')
    rootSeedB64 = b64(seed)
  } else {
    rootSeedB64 = trimmed
    if (fromB64(rootSeedB64).length !== 32) throw new Error('备份格式不对（应为 32 字节种子的 base64）')
  }
  const rootPub = ed.getPublicKey(fromB64(rootSeedB64))
  const rootDid = rootDidOf(rootPub)
  const rootPubkeyB64 = b64(rootPub)
  const id = currentIdentity() ?? (await ensurePlainIdentity())
  if (!id) throw new Error('身份未就绪（本机已登出，请先登录或恢复后再导入）')
  const devicePubkeyB64 = b64(ed.getPublicKey(fromB64(id.keyB64)))
  // 把本机 myco 加入该 有灵账号名单（root 不存在则先建——备份对应 账号未上链的边角）
  const issuedAt = Date.now()
  const attestSig = signWithSeed(rootSeedB64, `attest\n${rootDid}\n${devicePubkeyB64}\n${issuedAt}`)
  let r = await post('/root/device/add', { rootDid, pubkeyB64: devicePubkeyB64, name: '恢复设备', issuedAt, attestSigB64: attestSig, rootSig: attestSig })
  if (r.status === 404) {
    const rootSig = signWithSeed(rootSeedB64, `create\n${rootDid}\n${rootPubkeyB64}`)
    r = await post('/root/create', { rootDid, rootPubkeyB64, devicePubkeyB64, name: '恢复设备', rootSig })
  }
  if (r.status >= 400) {
    const t = await r.text().catch(() => '')
    throw new Error(`恢复失败 (${r.status}): ${t.slice(0, 100)}`)
  }
  const v = readVault() ?? { mode: 'plain' as StorageMode }
  writeVault({ ...v, rootSeedB64, rootDid })
  _rootSeedB64 = rootSeedB64
  selfAttest(rootDid, id.keyB64, rootSeedB64)
  await claimEmbodiment().catch(() => {})
  upsertAccount(rootDid, undefined)
  return rootDid
}

// ── 根认证头（attestation 自证 + 设备钥签名）──

/** 生成根认证所需的两个头：X-Myco-Auth（rootDid.ts.sig，设备钥签）+ X-Myco-Attest（设备公钥.issuedAt.attestSig）。 */
export function signRootAuth(rawBody: string): { auth: string; attest: string } | null {
  const a = getAttestation()
  const id = currentIdentity()
  if (!a || !id) return null
  const ts = Date.now()
  const msg = new TextEncoder().encode(`${a.rootDid}\n${ts}\n${rawBody}`)
  const sig = b64(ed.sign(msg, fromB64(id.keyB64)))
  return {
    auth: `${a.rootDid}.${ts}.${sig}`,
    attest: `${a.devicePubkeyB64}.${a.issuedAt}.${a.attestSigB64}`,
  }
}

export interface RootDevice {
  pubkeyB64: string
  name: string
  addedAt: number
  revoked: number
}

/** 拉根账号下的设备列表。 */
export async function listRootDevices(rootDid: string): Promise<RootDevice[]> {
  try {
    const r = await fetch(`${DID_BASE}/root/${encodeURIComponent(rootDid)}`)
    if (!r.ok) return []
    const d = await r.json()
    return d?.data?.devices ?? []
  } catch {
    return []
  }
}

// ── attestation（归属凭证：根私钥签"这设备钥属于这根"，自证、设备本地携带）──

export interface Attestation {
  rootDid: string
  devicePubkeyB64: string
  issuedAt: number
  attestSigB64: string
}

const ATTEST_PREFIX = 'attest'

/** 生成 attestation（rootSig over `attest\nrootDid\ndevicePubkey\nissuedAt`）。 */
function makeAttestation(rootDid: string, devicePubkeyB64: string, rootSeedB64: string): Attestation {
  const issuedAt = Date.now()
  const attestSigB64 = signWithSeed(rootSeedB64, `${ATTEST_PREFIX}\n${rootDid}\n${devicePubkeyB64}\n${issuedAt}`)
  return { rootDid, devicePubkeyB64, issuedAt, attestSigB64 }
}

const LS_ATTEST = 'youling.attestation'

/** 当前设备持有的 attestation（无则 null=未入根）。 */
export function getAttestation(): Attestation | null {
  const v = lsGet(LS_ATTEST)
  if (!v) return null
  try { return JSON.parse(v) as Attestation } catch { return null }
}

function storeAttestation(a: Attestation): void {
  lsSet(LS_ATTEST, JSON.stringify(a))
  // 多账号索引 upsert（第33轮）：收编/自签路径统一在此登记（名字由 create/import 显式传，
  // 收编场景用账号 did 兜底——列表点开可改名场景后续补）
  if (a.rootDid && !readAccounts().some((e) => e.rootDid === a.rootDid)) {
    writeAccounts([...readAccounts(), { rootDid: a.rootDid, name: '有灵账号', lastLogin: Date.now() }])
  }
  const arc0 = readArchive(a.rootDid) ?? {}
  arc0.attestation = a
  writeArchive(a.rootDid, arc0)
}

/** 清除本地 attestation（被主设备除名后回未关联）。 */
export function clearAttestation(): void {
  lsDel(LS_ATTEST)
}

/** 自签 attestation（本设备创建根账号时）。在 createRootIdentity 里调用。 */
function selfAttest(rootDid: string, deviceKeyB64: string, rootSeedB64: string): Attestation {
  const devicePubkeyB64 = b64(ed.getPublicKey(fromB64(deviceKeyB64)))
  const a = makeAttestation(rootDid, devicePubkeyB64, rootSeedB64)
  storeAttestation(a)
  return a
}

/** 从服务端拉取本设备的 attestation（加入根后被主设备签发的；server 存了 attestSig）。 */
export async function fetchMyAttestation(rootDid: string): Promise<Attestation | null> {
  const id = currentIdentity()
  if (!id) return null
  const myPub = b64(ed.getPublicKey(fromB64(id.keyB64)))
  try {
    const r = await fetch(`${DID_BASE}/root/${encodeURIComponent(rootDid)}`)
    if (!r.ok) return null
    const d = await r.json()
    const dev = (d?.data?.devices ?? []).find((x: any) => x.pubkeyB64 === myPub)
    if (!dev?.attestSigB64) return null
    const a: Attestation = { rootDid, devicePubkeyB64: myPub, issuedAt: dev.addedAt ?? Date.now(), attestSigB64: dev.attestSigB64 }
    storeAttestation(a)
    return a
  } catch { return null }
}

/** 主设备（持根私钥）批准一台新设备加入根账号——即给它签发 attestation（归属凭证）。
 *  签名格式 `attest\nrootDid\ndevicePubkey\nissuedAt`（与 attestation 一致），server 存 attestSig，
 *  新设备随后 fetchMyAttestation 拉取并本地携带。须亲眼核对新设备公钥码，防远程偷挂设备。 */
export async function approveJoinDevice(rootDid: string, devicePubkeyB64: string, name: string): Promise<void> {
  const rootSeed = getRootSeed()
  if (!rootSeed || getRootIdentity() !== rootDid) throw new Error('本机不是该 账号的主设备（无 myco 根钥，或加密模式请先解锁）')
  const issuedAt = Date.now()
  const attestSig = signWithSeed(rootSeed, `attest\n${rootDid}\n${devicePubkeyB64}\n${issuedAt}`)
  const r = await post('/root/device/add', { rootDid, pubkeyB64: devicePubkeyB64, name: name || '新设备', issuedAt, attestSigB64: attestSig, rootSig: attestSig })
  if (!r.ok) throw new Error(`批准加入失败 (${r.status}): ${(await r.text()).slice(0, 120)}`)
}

/** 新设备发现自己被哪个有灵账号收编（反查 GET /device/<本机公钥>，无需预知 rootDid）。
 *  DID 互换授权：主设备在 Myco 面板粘贴本机 DID 后即签 attestation 上云；
 *  本机在未关联态轮询这个端点，发现后拉取 attestation 本地携带 → 角色变成员。 */
export async function fetchMyRoot(): Promise<Attestation | null> {
  const id = currentIdentity()
  if (!id) return null
  const myPub = b64(ed.getPublicKey(fromB64(id.keyB64)))
  try {
    const r = await fetch(`${DID_BASE}/device/${encodeURIComponent(myPub)}`, { signal: AbortSignal.timeout(3000) })
    if (!r.ok) return null
    const d = await r.json()
    const dev = d?.data
    if (!dev?.rootDid || !dev?.attestSigB64) return null
    const a: Attestation = { rootDid: dev.rootDid, devicePubkeyB64: myPub, issuedAt: dev.addedAt ?? Date.now(), attestSigB64: dev.attestSigB64 }
    storeAttestation(a)
    return a
  } catch { return null }
}

/** 主设备按 DID 直加新设备（DID 互换，无配对码）：DID 自带公钥，直接签 attestation 上云。
 *  与 canvas 端 add_device_by_did 对等。2026-09-15 起加完顺签 30 天委任状投信箱（对等授权：
 *  手机作主设备也能让 PC/别的手机成分身，可干活+可扫码登录）。 */
export async function addDeviceByDid(did: string, name: string): Promise<void> {
  const rootDid = getRootIdentity()
  if (!rootDid) throw new Error('本机未持有 myco 根钥')
  const pub = pubkeyB64FromDid(did)
  if (!pub) throw new Error('不支持的 did 格式（设备识别码须为 canonical：did:myco:z… / did:youling:z…）')
  await approveJoinDevice(rootDid, pub, name || '新设备')
  await issueDelegationToDevice(pub, name).catch((e) => console.warn('委任状签发失败(不挡配对):', e))
}

/** 主设备签发委任状并投 identity-svc 信箱（分身 poll/renew-notify 取走）。
 *  消息规范形与 delegation.mjs / env delegation.rs 逐字节一致；TTL 30 天。 */
export async function issueDelegationToDevice(devicePubkeyB64: string, name: string): Promise<void> {
  const rootSeed = getRootSeed()
  const rootDid = getRootIdentity()
  if (!rootSeed || !rootDid) throw new Error('本机未持有 myco 根钥（或加密模式请先解锁）')
  const issuedAt = Date.now()
  const exp = issuedAt + 30 * 24 * 3600 * 1000
  const nonce = `d${issuedAt}`
  const deviceName = name || '成员设备'
  const scopes = '*'
  const sigB64 = signWithSeed(rootSeed, `delegation\n${rootDid}\n${devicePubkeyB64}\n${deviceName}\n${scopes}\n${issuedAt}\n${exp}\n${nonce}`)
  const r = await post('/delegation/deliver', { accountDid: rootDid, devicePubkeyB64, deviceName, scopes, issuedAt, exp, nonce, sigB64 })
  if (!r.ok) throw new Error(`委任状投递失败 (${r.status})`)
}

/** 主设备从名册除名一台设备（签 `revoke\nrootDid\npubkeyB64` 上云）。
 *  被除名的设备下次轮询总览时自查到 → 清本地 attestation 回未关联（除名传播）。 */
export async function revokeRosterDevice(pubkeyB64: string): Promise<void> {
  const rootDid = getRootIdentity()
  const rootSeed = getRootSeed()
  if (!rootDid || !rootSeed) throw new Error('本机未持有 myco 根钥')
  const sigB64 = signWithSeed(rootSeed, `revoke\n${rootDid}\n${pubkeyB64}`)
  const r = await post('/root/device/revoke', { rootDid, pubkeyB64, rootSig: sigB64 })
  if (!r.ok) throw new Error(`除名失败 (${r.status}): ${(await r.text()).slice(0, 120)}`)
  // 吊销即时生效（spec §7.4）：名册除名同时推吊销注册表——平台登录/续签/投递即刻拒
  const ts = Date.now()
  const rvSig = signWithSeed(rootSeed, `revocation\n${rootDid}\n${ts}\n${pubkeyB64}`)
  await post('/revocation/push', { accountDid: rootDid, revokedPubkeys: [pubkeyB64], ts, sigB64: rvSig }).catch(() => {})
}

/** 当前登录态（token 未过期）。 */
export function currentSession(): boolean {
  // sign-every-request 后无 token/session：身份就绪即可用。保留函数名供 UI 兼容。
  return !!_identity
}

// ── sign-every-request（无 token/session/challenge/login）──
/** 签名任意请求体 → X-Myco-Auth 头值（`did.ts.sigB64`）。供 DirectHttpTransport 复用。 */
export function signAuthHeader(rawBody: string): string {
  if (!_identity) throw new Error('身份未就绪')
  const seed = fromB64(_identity.keyB64)
  const ts = Date.now()
  const msg = new TextEncoder().encode(`${_identity.did}\n${ts}\n${rawBody}`)
  const sig = ed.sign(msg, seed)
  return `${_identity.did}.${ts}.${b64(sig)}`
}

/** 以有灵账号身份签名（2026-09-10 账户级任务授权）：PC 给 youling 账户开了
 * 任务读/读写时，设备未授权的终端也能以账户身份建连（信令验签按 did 查
 * 公钥——root 公钥在账号创建/恢复时已上链，无需额外注册）。 */
export function signAuthHeaderAsRoot(rawBody: string): string {
  const rootDid = getRootIdentity()
  const seedB64 = getRootSeed()
  if (!rootDid || !seedB64) throw new Error('账号身份未就绪（未关联有灵账号）')
  const seed = fromB64(seedB64)
  const ts = Date.now()
  const msg = new TextEncoder().encode(`${rootDid}
${ts}
${rawBody}`)
  const sig = ed.sign(msg, seed)
  return `${rootDid}.${ts}.${b64(sig)}`
}

/** 是否具备账号签名身份（rootSeed+rootDid 都在）。connectWebRtc 的 fallback 闸。 */
export function hasRootSigningIdentity(): boolean {
  return !!getRootIdentity() && !!getRootSeed()
}

// ── 好友握手签名（2026-10-07 好友去服务端化；与 PC chat_service.rs 同材料字段序）──

/** 好友握手签名材料：六段换行拼接，字段序固定（协议红线——PC/手机两端逐字节一致）。 */
export function friendSignMaterial(kind: string, from: string, to: string, fromDevice: string, ts: number, nonce: string): string {
  return `${kind}\n${from}\n${to}\n${fromDevice}\n${ts}\n${nonce}`
}

/** 设备钥签好友握手材料 → sig b64（身份未就绪/异常 → null；与 signAuthHeader 同钥同链）。 */
export function signFriendHandshake(material: string): string | null {
  if (!_identity) return null
  try {
    const seed = fromB64(_identity.keyB64)
    return b64(ed.sign(new TextEncoder().encode(material), seed))
  } catch {
    return null
  }
}

/** 验签（设备 did 自带公钥——自证）：material 是否出自该设备钥持有人（名册归属另查
 *  listRootDevices——两道闸合成防冒充，与 PC p2p_server auth_gate 同链语义）。
 *  注意 noble v2 API 参数序=verify(sig, msg, pub)——签名在前（v1 是 (msg, sig, pub)，迁移坑）。 */
export function verifyDeviceSig(did: string, material: string, sigB64: string): boolean {
  const pub = didPubkeyBytes(did)
  if (!pub) return false
  try {
    return ed.verify(fromB64(sigB64), new TextEncoder().encode(material), pub)
  } catch {
    return false
  }
}

// 每个需鉴权的请求带头 X-Myco-Auth: <did>.<ts>.<sigB64>
//   sig = ed25519.sign(`${did}\n${ts}\n${rawBody}`, seed)
// 服务器按 did 查公钥验签 + ts 在 60s 窗口内。无登录态、无过期、无重放。
// 2026-09-28：8s 超时 + 失败重签重发一次——WebView 长时间挂起（后台冻结/息屏）后
// fetch 连接可能滞死（Promise 永不落定，点「接受好友」静默无效的根因），旧实现
// 无超时无重试，一次滞死要冷启动才能恢复。重试必须重签（ts 新鲜度 60s 窗口）。
async function signedPost(path: string, payload: unknown, attempt = 0): Promise<Response> {
  if (!_identity) throw new Error('身份未就绪')
  const seed = fromB64(_identity.keyB64)
  const raw = JSON.stringify(payload ?? {})
  const ts = Date.now()
  const msg = new TextEncoder().encode(`${_identity.did}\n${ts}\n${raw}`)
  const sig = ed.sign(msg, seed)
  try {
    return await fetch(`${DID_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Myco-Auth': `${_identity.did}.${ts}.${b64(sig)}` },
      body: raw,
      signal: AbortSignal.timeout(8000),
    })
  } catch (e) {
    if (attempt < 1) return signedPost(path, payload, attempt + 1)
    throw e
  }
}

/** 签名 GET（签空 body），返回 Response——供 /signal/poll SSE 流式读取（EventSource 不能设自定义头）。 */
export async function signedGetResponse(path: string): Promise<Response> {
  if (!_identity) throw new Error('身份未就绪')
  const seed = fromB64(_identity.keyB64)
  const ts = Date.now()
  const msg = new TextEncoder().encode(`${_identity.did}\n${ts}\n`) // 空 body
  const sig = ed.sign(msg, seed)
  return fetch(`${DID_BASE}${path}`, {
    method: 'GET',
    headers: { 'X-Myco-Auth': `${_identity.did}.${ts}.${b64(sig)}` },
  })
}

/** 签名 POST（导出，供 WebRTCTransport 投递 /signal/* 信令）。 */
export async function signalPost(path: string, payload: unknown): Promise<Response> {
  return signedPost(path, payload)
}

/** 方向 B（AUTH-DID-QR §6）：扫到主设备邀请码后，把本机 DID+nonce 投进主设备的信令信箱。
 *  主设备确认后签 attestation 上名册；本机由 fetchMyRoot 轮询自取。
 *  dev = 一句话设备描述（机型·系统），给主设备核对"这是哪台设备"（服务器透传，可选）。 */
export async function sendPairRequest(toDid: string, name: string, nonce: string, dev?: string): Promise<{ delegation?: unknown }> {
  const r = await signedPost('/signal/pair', { to: toDid, name, nonce, ...(dev ? { dev } : {}) })
  if (!r.ok) throw new Error(`申请发送失败 (${r.status})`)
  // 配对响应可能带委任状(PC 端 attest 回发)——解析返回,调用方存(2026-09-03:
  // 手机端只发不收,委任状从没落盘,aop 离线身份永远拿不到)
  try { return (await r.json()) as { delegation?: unknown } } catch { return {} }
}

/** 手机作主设备收配对申请：一次性取走信箱全部积压，滤出 type='pair' 的。 */
export async function drainPairInbox(): Promise<{ from: string; name?: string; nonce?: string; dev?: string }[]> {
  try {
    const r = await signedGetResponse('/signal/drain')
    if (!r.ok) return []
    const d = await r.json()
    return (d?.data ?? []).filter((m: any) => m?.type === 'pair' && typeof m?.from === 'string')
  } catch { return [] }
}

/** 幂等注册公钥（首次/未知 did 时调；已注册 409 也算成功）。 */
export async function ensureRegistered(): Promise<void> {
  if (!_identity) throw new Error('身份未就绪')
  const seed = fromB64(_identity.keyB64)
  const publicKeyB64 = b64(ed.getPublicKey(seed))
  const r = await post('/identity/register', { publicKeyB64 })
  if (r.status !== 201 && r.status !== 409) {
    throw new Error(`注册失败 (${r.status}): ${(await r.text()).slice(0, 160)}`)
  }
}

/** 导出密钥（base64），供用户抄写备份（换机恢复用）。 */
export async function exportKeyB64(): Promise<string> {
  if (!_identity) throw new Error('身份未加载')
  return _identity.keyB64
}

// ── 有灵账号模型（主设备/肢体/未关联）──

/** 设备角色：主设备（持 myco 根钥、有灵）/ 成员（被 attest 无灵）/ 未关联。 */
export type DeviceRole = 'embodiment' | 'agent' | 'unlinked'

/** 当前设备角色（三态判定，UI 据此切换面板）。 */
export function deviceRole(): DeviceRole {
  const v = readVault()
  // rootDid 在 plain/enc 两种 vault 都留明文 → 它存在即说明本机是有灵账号主设备（持钥）
  if (v?.rootDid) return 'embodiment'
  if (getAttestation()) return 'agent'                   // 被 attest、无灵（成员）
  return 'unlinked'
}

/** 导出 myco 根钥（rootSeedB64）供备份——只有主设备（持 myco 根钥）设备能导出。 */
export function exportRootSeed(): string {
  const s = getRootSeed()
  if (!s) throw new Error('本机未持有 myco 根钥（不是主设备，或加密模式请先解锁）')
  return s
}

/** 用可选密码加密 myco 根钥（备份物加密；返回 {ct,salt,iv}，离线保存）。密码为空则返回明文 seed。 */
export function encryptRootSeedForBackup(password: string): { seedB64: string; ct?: string; salt?: string; iv?: string; encrypted: boolean } {
  const seedB64 = exportRootSeed()
  if (!password.trim()) return { seedB64, encrypted: false }
  const seed = fromB64(seedB64)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = pbkdf2(sha256, new TextEncoder().encode(password), salt, { c: PBKDF2_ITERS, dkLen: 32 })
  const ct = gcm(key, iv).encrypt(seed)
  return { seedB64, ct: b64(ct), salt: b64(salt), iv: b64(iv), encrypted: true }
}

/** 主设备自报：本机持 myco 根钥，向服务端登记"这台设备是主设备"（best-effort 可见性，供管理页）。 */
export async function claimEmbodiment(): Promise<void> {
  const rootSeed = getRootSeed()
  const rootDid = getRootIdentity()
  const id = currentIdentity()
  if (!rootSeed || !rootDid || !id) throw new Error('本机未持有 myco 根钥（或加密模式请先解锁）')
  const devicePubkeyB64 = b64(ed.getPublicKey(fromB64(id.keyB64)))
  const issuedAt = Date.now()
  const embodimentSigB64 = signWithSeed(rootSeed, `embodiment\n${rootDid}\n${devicePubkeyB64}\n${issuedAt}`)
  const r = await post('/root/device/embodiment', { rootDid, pubkeyB64: devicePubkeyB64, issuedAt, embodimentSigB64 })
  if (!r.ok && r.status !== 404) throw new Error(`主设备自报失败 (${r.status})`)
}

/** 公钥 base64 → 设备 DID（spec v0.3 canonical：did:myco:z<multibase>；roster 设备算
 *  DID 展示用——与新注册/新登录器出示的形态一致）。 */
export function didFromPubkeyB64(pubkeyB64: string): string {
  try {
    const bin = atob(pubkeyB64)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    if (bytes.length !== 32) return ''
    return `did:myco:z${bs58.encode(multibaseEd25519(bytes))}`
  } catch { return '' }
}

/** DID → 设备公钥 base64（**canonical-only**，spec v0.3 §3.1）：单一真源 =
 *  `didUtil.didPubkeyBytes`（`did:myco:`/`did:youling:` + `z` + 载荷 34B + `0xed 0x01` 头
 *  → 取 32B）；**legacy 裸 base58 已废止**（不解码、不回落）、软 did/畸形载荷 → null。
 *  DID 互换授权的关键：DID 自带公钥，主设备拿到 DID 即拿到公钥，无需配对码传递。 */
export function pubkeyB64FromDid(did: string): string | null {
  const pub = didPubkeyBytes((did || '').trim())
  return pub ? b64(pub) : null
}

export interface DeviceWithStatus {
  did: string
  name: string
  pubkeyB64: string
  revoked: boolean
  isEmbodiment: boolean
  online: boolean
  lastSeen: number | null
  addrs?: { ipv6?: string; ipv6List?: string[]; port?: number } | null
  kind?: string | null
  role?: string | null
}

/** 按 账号列名下全部设备 + 在线状态 + 主设备标记（管理页用，走 /presence/by-root）。 */
export async function listDevicesWithStatus(rootDid: string): Promise<DeviceWithStatus[]> {
  if (!_identity) return []
  try {
    const r = await signedPost('/presence/by-root', { rootDid })
    if (!r.ok) return []
    const body = await r.json()
    return (body.data?.devices ?? []) as DeviceWithStatus[]
  } catch { return [] }
}

export interface YoulingOverview { name: string; backedUp: boolean; devices: DeviceWithStatus[] }

/** 按账号拉总览：名下设备(在线) + 云端"已导出"标记（管理页 + 备份提醒用）。 */
export async function fetchYoulingOverview(rootDid: string): Promise<YoulingOverview | null> {
  if (!_identity) return null
  try {
    const r = await signedPost('/presence/by-root', { rootDid })
    if (!r.ok) return null
    const body = await r.json()
    const d = body.data ?? {}
    return { name: d.name ?? '', backedUp: !!d.backedUp, devices: (d.devices ?? []) as DeviceWithStatus[] }
  } catch { return null }
}

/** 置云端"已导出备份"标记（主设备签 `backup\nrootDid\ndevicePubkey`）。一处备份、处处不唠叨。 */
export async function setBackedUpCloud(): Promise<void> {
  const rootSeed = getRootSeed()
  const rootDid = getRootIdentity()
  const id = currentIdentity()
  if (!rootSeed || !rootDid || !id) throw new Error('本机未持有 myco 根钥（或加密模式请先解锁）')
  const devicePubkeyB64 = b64(ed.getPublicKey(fromB64(id.keyB64)))
  const sigB64 = signWithSeed(rootSeed, `backup\n${rootDid}\n${devicePubkeyB64}`)
  const r = await post('/root/backup-flag', { rootDid, devicePubkeyB64, sigB64 })
  if (!r.ok) throw new Error(`置云端备份标记失败 (${r.status})`)
}

/** 改 有灵账号名（主设备签 `rename\nrootDid\nname`）。 */
export async function renameYouling(name: string): Promise<void> {
  const rootSeed = getRootSeed()
  const rootDid = getRootIdentity()
  if (!rootSeed || !rootDid) throw new Error('本机未持有 myco 根钥')
  const safe = name.replace(/[\r\n\t\x00-\x1f]/g, '').trim().slice(0, 32)
  const sigB64 = signWithSeed(rootSeed, `rename\n${rootDid}\n${safe}`)
  const r = await post('/root/rename', { rootDid, name: safe, sigB64 })
  if (!r.ok) throw new Error(`改名失败 (${r.status})`)
}

// ── DID 互换授权（唯一添加方式）：无配对码。
//   新设备：出示 DID（自带公钥）→ 主设备 addDeviceByDid 签 attestation 上云 → 新设备 fetchMyRoot 发现。
//   （旧 6 位"加入账号"码流程已随 /soul/join/* 端点一并下线。）──

/**
 * presence 上报的寻址信息（2026-10-09 反向连接）：手机把自己的全球 IPv6 + 可达端口
 * 报上去——PC 侧 `p2p_client` 就能从 presence 查到手机地址、主动拨过来（反向隧道）。
 * 形状与 PC 端 `LocalCandidates::addrs_json` 同构（`ipv6`/`ipv6List`/`port`），
 * 多一个 `wantReverse`（想让 PC 反连的目标端口——服务器原样透传，PC 侧据此拨号）。
 */
export interface PresenceAddrs {
  ipv6?: string
  ipv6List?: string[]
  /** 反向隧道监听端口（TunnelProxyServer 绑 [::] 的那个口）。 */
  port?: number
  /** 反向连接意愿：PC 暴露哪个自身端口（13911 分享网关）。有会话时置位、离开清零。 */
  wantReverse?: number
}

/** 手机登记在线（带 账号归属 + 角色 + 种类），供管理页"全部设备在线状态"可见。
 *  PC 也登记（presence.rs）；手机补上，否则管理页只看得到 PC。失败静默（在线态是 best-effort）。
 *  第84轮：+state（'active'|'typing'|'idle'——灯数据源；手机不能可靠检测锁屏，后台/久无交互=idle）。
 *  2026-10-09：+addrs（反向连接寻址——全球 IPv6 + 监听端口 + wantReverse 意愿标记）。
 *  注意服务器 addrs 是**粘性**的（`body.addrs || prev`）：要清除 wantReverse 必须显式
 *  传一个不带它的 addrs 对象，传 undefined 只是沿用旧值。 */
export async function registerPresence(
  name: string,
  state?: 'active' | 'typing' | 'idle',
  addrs?: PresenceAddrs | null,
): Promise<void> {
  if (!_identity) return
  const role = deviceRole() === 'embodiment' ? 'embodiment' : (getAttestation() ? 'appendage' : null)
  const payload: Record<string, unknown> = {
    nodeId: _identity.nodeId,
    name,
    rootDid: getRootIdentity() ?? getAttestation()?.rootDid ?? null,
    role,
    kind: 'phone',
    state: state ?? 'active',
  }
  if (addrs) payload.addrs = addrs
  await signedPost('/presence/register', payload).catch(() => {})
}

/** 通信簿：在线节点。 */
export interface PresenceNode {
  did: string
  nodeId: string
  name: string
  lastSeen: number
  self?: boolean
  /** PC 的 IPv6 直连地址（若有，手机优先直连）。 */
  addrs?: { ipv6?: string; ipv6List?: string[]; port?: number } | null
  /** 归属账号 / 角色 / 种类（自报，best-effort）。 */
  rootDid?: string | null
  role?: string | null
  kind?: string | null
  /** WebRTC 打洞能力（answerer 常驻才上报）：优先 WebRTC 直连；无此字段=老 PC，跳过空等。 */
  webrtc?: boolean | null
  /** 第84轮：设备状态（active|typing|idle|locked——灯的三态数据源；老版本无此字段）。 */
  state?: string | null
}

/**
 * 最近一次 `/presence/list` 的失败原因（`null` = 成功或尚未调用）。
 *
 * 为什么需要：`listPresence()` 失败时**静默返回 `[]`**（在线态是 best-effort，UI 不该炸）。
 * 但 2026-10-22 手机 vnet 现场卡在"presence 里明明有 PC，`addrsFor()` 三次都拿 null"——
 * 空数组到底是签名/网络失败还是服务端真没数据，只能看这个诊断值。logcat 被 HKS 加密，
 * 排障通道只有 EnvServer notes，所以把原因存下来供上层 flog。
 */
let lastPresenceError: string | null = null

/** 读最近一次 presence 查询失败原因（诊断用；成功返回 null）。 */
export function lastPresenceErrorText(): string | null {
  return lastPresenceError
}

/** 列出在线的电脑（签名鉴权，无 session）。 */
export async function listPresence(): Promise<PresenceNode[]> {
  if (!_identity) {
    lastPresenceError = '身份未就绪'
    return []
  }
  try {
    const r = await signedPost('/presence/list', {})
    if (!r.ok) {
      lastPresenceError = `HTTP ${r.status}`
      return []
    }
    const body = await r.json()
    lastPresenceError = null
    return (body.data ?? []) as PresenceNode[]
  } catch (e) {
    lastPresenceError = `err ${String((e as Error)?.message ?? e).slice(0, 80)}`
    return []
  }
}

/** 名册设备行（/presence/by-root 返回形态；设备群"名册即成员表"的数据源，
 *  设计 §3 决策C/F——revoked=false 的设备就是"当前成员"，online=在线灯）。 */
export interface PresenceByRootDevice {
  did: string
  name?: string
  online?: boolean
  revoked?: boolean
  isEmbodiment?: boolean
  lastSeen?: number
  kind?: string | null
  role?: string | null
}

/** 按根账号查名册设备表（POST /presence/by-root {rootDid} → {devices:[…]}，
 *  identity-svc 已有聚合端点，signedPost 可调）。失败抛错（调用方静默降级）。 */
export async function fetchPresenceByRoot(rootDid: string): Promise<PresenceByRootDevice[]> {
  const r = await signedPost('/presence/by-root', { rootDid })
  if (!r.ok) throw new Error(`名册查询失败 (${r.status})`)
  const d = (await r.json()) as { data?: { devices?: PresenceByRootDevice[] } }
  return d.data?.devices ?? []
}
