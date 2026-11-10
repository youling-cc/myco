/**
 * cli.ts — 手机版 myco CLI（无 UI 全功能通道，三端一致机制的 phone 侧）。
 *
 * 与 myco-ubuntu（apps/myco-ubuntu/src/cli.rs）/ PC 版 cli.rs 同一套命令词表：
 *   identity birth / identity did / sign <payload-b64>
 *   device register / device list / device token / device verify-token
 *   delegation issue / delegation verify (+phone 特有 delegation show / status)
 *
 * 通道（adb 时代理身体的 shell）：
 *   - APK：EnvServer :8210 新增 POST /api/cli {cmd} → WebView eval 本模块（submit/pollResult
 *     两段式，网络命令可跑数十秒）；PC 侧 `adb forward tcp:8210 tcp:8210` + curl。
 *   - PWA/浏览器控制台：window.MycoCli.exec('identity did') 直接可用。
 *
 * 身份语义映射（phone 双层 → myco-ubuntu 组织/设备两层）：
 *   组织身份 = 有灵根账号 did:youling（rootSeed，vault 持有）
 *   设备身份 = 本机设备钥 did:myco（keyB64，vault 持有）
 *   sign 默认用根钥（对齐 Rust 的 org 签名语义）；无根钥回退设备钥并在返回里注明 signer。
 *
 * wire 兼容（跨端互操作，A6 同款方法）：
 *   delegation msg = "delegation\n{accountDid}\n{devicePubkeyB64}\n{deviceName}\n{scopes}\n{issuedAt}\n{exp}\n{nonce}"
 *     ——三端逐字节一致；JSON 字段 phone/服务端=accountDid、myco-ubuntu=mycoDid，verify 双兼容。
 *   device-grant msg = "device-grant\n{orgDid}\n{deviceDid}\n{scopes}\n{expiresAt}"
 *     ——与 myco-ubuntu device.rs issue_grant/verify_grant 同构（本模块补齐 phone 缺失能力）。
 */
import {
  currentIdentity, ensurePlainIdentity, getRootIdentity, getRootSeed,
  deviceRole, getAttestation, pubkeyB64FromDid, DID_BASE,
  listDevicesWithStatus, approveJoinDevice, issueDelegationToDevice,
} from './identity'
import { loadDelegation, type Delegation, present, isDueRenew } from './delegation'
import { didPubkeyBytes } from './didUtil'
import * as ed from '@noble/ed25519'

// ── 小工具（identity.ts 内部件同款；node/vitest 下 localStorage 容错）──
const b64 = (u8: Uint8Array): string => btoa(String.fromCharCode(...u8))
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0))
/** UTF-8 安全 base64（wire 编码，与 Rust b64e(json_utf8) / 服务端 btoa(unescape(encodeURIComponent())) 一致）。 */
const wireEncode = (s: string): string => btoa(unescape(encodeURIComponent(s)))
const wireDecode = (s: string): string => decodeURIComponent(escape(atob(s.trim())))
function lsGet(k: string): string | null { try { return localStorage.getItem(k) } catch { return null } }
function lsSet(k: string, v: string): void { try { localStorage.setItem(k, v) } catch { /* 忽略 */ } }

const DEVICE_GRANT_TTL_DEFAULT_SECS = 3600
/** phone 现网委任状 TTL=30 天（服务端/续签链按此设计）；myco-ubuntu CLI 默认 7 天——wire 里带 exp，互不影响。 */
const DELEGATION_TTL_DEFAULT_MS = 30 * 24 * 3600 * 1000

// ── 词法/参数解析（与 cli.rs parse_args 同规则：--key value / --key=value，引号词支持）──

interface Parsed { positional: string[]; flags: Record<string, string> }

export function lex(cmdline: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (let i = 0; i < cmdline.length; i++) {
    const c = cmdline[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < cmdline.length) { cur += cmdline[++i] }
      else cur += c
    } else if (c === '"' || c === "'") { quote = c; has = true }
    else if (c === ' ' || c === '\t') { if (cur || has) { out.push(cur); cur = ''; has = false } }
    else cur += c
  }
  if (cur || has) out.push(cur)
  return out
}

export function parseArgs(argv: string[]): Parsed {
  const p: Parsed = { positional: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const body = a.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) p.flags[body.slice(0, eq)] = body.slice(eq + 1)
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) p.flags[body] = argv[++i]
      else p.flags[body] = 'true'
    } else p.positional.push(a)
  }
  return p
}

// ── 输出约定：成功 {ok:true,data}（data 与 Rust 命令 JSON 输出同构）；失败 {ok:false,err} ──

export interface CliOut { ok: boolean; data?: unknown; err?: string; usage?: boolean }

const ok = (data: unknown): CliOut => ({ ok: true, data })
const err = (msg: string, usage = false): CliOut => ({ ok: false, err: msg, ...(usage ? { usage: true } : {}) })

export function usageText(): string {
  return `myco phone CLI —— 与 myco-ubuntu / PC 版同一套命令词表

用法:
  identity birth [--name N]           生成本机身份（幂等；已加密身份需先在 UI 解锁）
  identity did                        输出 DID Document（设备层 + 若持有的有灵根账号）
  sign <payload-b64> [--as root|device]   Ed25519 签名（默认根钥，无根钥回退设备钥）
  device register --did <deviceDid> [--name N] [--account DID] [--no-delegation]
                                       注册被授权设备（DID 互换 attest + 顺签委任状）
  device list                         设备清单（云名册 + 在线状态）
  device token --did <deviceDid> [--scopes a,b] [--ttl-secs 3600]
                                       根账号签发设备授权 token（myco-ubuntu 同构）
  device verify-token <token-b64>     离线验证设备授权 token
  delegation issue --did <deviceDid> [--name N] [--scopes a,b] [--ttl-ms N] [--deliver]
                                       签发委任状（返回 wire；--deliver 同时投信箱）
  delegation verify <wire-b64>        离线验证委任状（accountDid/mycoDid 双兼容）
  delegation show                     本机持有的委任状
  status                              身份/角色/委任状概要

通道: POST /api/cli {"cmd":"identity did"}（EnvServer :8210，adb forward 后 curl）
     或浏览器控制台 await window.MycoCli.exec('identity did')
服务: ${DID_BASE || '(同源)'}`
}

// ── identity ──

const LS_BORN_AT = 'youling.bornAt'

/** DID Document（与 myco-ubuntu identity.rs document() 同构）。 */
function didDocument(did: string, pubB58: string, created: string | null): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: did,
    verificationMethod: [{ id: `${did}#key0`, type: 'Ed25519VerificationKey2020', publicKeyBase58: pubB58 }],
  }
  if (created) doc.created = created
  return doc
}

async function cmdIdentityBirth(): Promise<CliOut> {
  const had = !!lsGet('youling.vault') || !!lsGet('youling.keyB64')
  let id
  try { id = currentIdentity() ?? (await ensurePlainIdentity()) } catch (e) { return err(String((e as Error).message || e)) }
  if (!id) return err('身份未就绪（本机已登出，请先登录或恢复）')
  if (!had && lsGet(LS_BORN_AT) === null) lsSet(LS_BORN_AT, String(Date.now()))
  const bornAt = Number(lsGet(LS_BORN_AT) || 0) || null
  return ok({
    did: id.did,
    born: !had,
    document: didDocument(id.did, b58Tail(id.did), bornAt ? new Date(bornAt).toISOString() : null),
    role: deviceRole(),
  })
}

function b58Tail(did: string): string { return did.replace(/^did:(myco|youling):/, '') }

function cmdIdentityDid(): CliOut {
  const id = currentIdentity()
  if (!id) return err('尚未出生：先 identity birth')
  const bornAt = Number(lsGet(LS_BORN_AT) || 0) || null
  const doc = didDocument(id.did, b58Tail(id.did), bornAt ? new Date(bornAt).toISOString() : null)
  const rootDid = getRootIdentity()
  if (rootDid) (doc as Record<string, unknown>).youling = { id: rootDid, note: '本机持有的有灵根账号（组织层身份）' }
  const at = getAttestation()
  if (at) (doc as Record<string, unknown>).attestedBy = at.rootDid
  return ok(doc)
}

// ── sign ──

function cmdSign(p: Parsed): CliOut {
  const payloadB64 = p.positional[0]
  if (!payloadB64) return err('用法: sign <payload-b64> [--as root|device]', true)
  let payload: Uint8Array
  try { payload = fromB64(payloadB64) } catch { return err('payload 不是合法 base64') }
  const id = currentIdentity()
  if (!id) return err('尚未出生：先 identity birth')
  const as = p.flags.as || 'auto'
  const rootSeed = getRootSeed()
  const rootDid = getRootIdentity()
  let signer: 'root' | 'device'
  let did: string
  let sig: Uint8Array
  if (as === 'root') {
    if (!rootDid || !rootSeed) return err('本机未持有有灵根钥（不是主设备，或加密模式请先解锁）')
    signer = 'root'; did = rootDid
    sig = ed.sign(payload, fromB64(rootSeed))
  } else if (as === 'device') {
    signer = 'device'; did = id.did
    sig = ed.sign(payload, fromB64(id.keyB64))
  } else {
    // auto：对齐 myco-ubuntu 语义（组织钥签）；分身设备回退设备钥并在 signer 标注
    if (rootDid && rootSeed) { signer = 'root'; did = rootDid; sig = ed.sign(payload, fromB64(rootSeed)) }
    else { signer = 'device'; did = id.did; sig = ed.sign(payload, fromB64(id.keyB64)) }
  }
  return ok({ signature: b64(sig), did, algo: 'ed25519', signer })
}

// ── device ──

async function cmdDeviceRegister(p: Parsed): Promise<CliOut> {
  const deviceDid = p.flags.did
  if (!deviceDid) return err('用法: device register --did <deviceDid> [--name N]（phone 模型按 DID 互换注册，设备钥由设备自持）', true)
  const rootDid = getRootIdentity()
  const rootSeed = getRootSeed()
  if (!rootDid || !rootSeed) return err('本机未持有有灵根钥（不是主设备，或加密模式请先解锁）')
  if (p.flags.account && p.flags.account !== rootDid) {
    return err(`本地未持有该账号种子：--account=${p.flags.account} ≠ 本地 ${rootDid}（attest 须由账号钥签）`)
  }
  const pub = pubkeyB64FromDid(deviceDid)
  if (!pub) return err('DID 格式不对（应为 did:myco:<base58(pub)>）')
  const name = p.flags.name || 'cli-device'
  const noDelegation = 'no-delegation' in p.flags
  try {
    await approveJoinDevice(rootDid, pub, name)
  } catch (e) {
    return err(`注册失败: ${(e as Error).message}`)
  }
  let delegationIssued = false
  if (!noDelegation) {
    try { await issueDelegationToDevice(pub, name); delegationIssued = true } catch { /* 不挡注册 */ }
  }
  return ok({
    device: { did: deviceDid, name, pubkeyB64: pub },
    delegationIssued,
    note: delegationIssued ? '委任状已投信箱（对方 pollDelegation 取走）' : undefined,
  })
}

async function cmdDeviceList(): Promise<CliOut> {
  const rootDid = getRootIdentity()
  if (!rootDid) return err('本机未持有有灵根钥（成员设备无名册管理权）')
  const devs = await listDevicesWithStatus(rootDid)
  return ok({ devices: devs, note: '云名册（identity-svc /presence/by-root）——myco-ubuntu 为本地 registry，phone 模型设备钥在设备端自持' })
}

// device token：myco-ubuntu device.rs issue_grant/verify_grant 同构（phone 原缺失，本次补齐）
interface GrantClaims { orgDid: string; deviceDid: string; scopes: string[]; issuedAt: number; expiresAt: number }
const grantMsg = (c: GrantClaims): string => `device-grant\n${c.orgDid}\n${c.deviceDid}\n${c.scopes.join(',')}\n${c.expiresAt}`

function cmdDeviceToken(p: Parsed): CliOut {
  const deviceDid = p.flags.did
  if (!deviceDid) return err('用法: device token --did <deviceDid> [--scopes a,b] [--ttl-secs 3600]', true)
  if (!deviceDid.startsWith('did:myco:')) return err('设备 did 应为 did:myco: 前缀')
  const rootSeed = getRootSeed()
  const rootDid = getRootIdentity()
  if (!rootDid || !rootSeed) return err('本机未持有有灵根钥（不是主设备，或加密模式请先解锁）')
  const scopes = (p.flags.scopes || '').split(',').map((s) => s.trim()).filter(Boolean)
  const ttl = Number(p.flags['ttl-secs'] || DEVICE_GRANT_TTL_DEFAULT_SECS)
  const now = Date.now()
  const claims: GrantClaims = { orgDid: rootDid, deviceDid, scopes, issuedAt: now, expiresAt: now + ttl * 1000 }
  const sigB64 = b64(ed.sign(new TextEncoder().encode(grantMsg(claims)), fromB64(rootSeed)))
  const token = wireEncode(JSON.stringify({ ...claims, sigB64 }))
  return ok({
    token,
    verifyHint: '验证方: 设备节点或平台按 orgDid 裸公钥离线验签（device verify-token / Rust device::verify_grant）',
  })
}

function cmdDeviceVerifyToken(p: Parsed): CliOut {
  const tokenB64 = p.positional[1] // [0]=verify-token 子命令自身（与 cli.rs positional.get(1) 对齐）
  if (!tokenB64) return err('用法: device verify-token <token-b64>', true)
  let claims: GrantClaims & { sigB64?: string }
  try { claims = JSON.parse(wireDecode(tokenB64)) } catch { return ok({ valid: false, reason: 'token 结构不符（base64/json 解不开）' }) }
  if (!claims.orgDid || !claims.deviceDid || !claims.sigB64) return ok({ valid: false, reason: 'token 缺 orgDid/deviceDid/sigB64' })
  const orgPub = pubkeyB58Bytes(claims.orgDid)
  if (!orgPub) return ok({ valid: false, reason: '不支持的 did 格式（orgDid 须为 canonical：did:youling:z… / did:myco:z…）' })
  let validSig = false
  try { validSig = ed.verify(fromB64(claims.sigB64), new TextEncoder().encode(grantMsg(claims)), orgPub) } catch { validSig = false }
  if (!validSig) return ok({ valid: false, reason: '签名验证失败（伪造或字段被篡改）' })
  if (claims.expiresAt < Date.now()) return ok({ valid: false, reason: `token 已过期（expiresAt=${claims.expiresAt}）` })
  return ok({ valid: true, claims })
}

/** did:<method>:<tail> → 32B 公钥（**canonical-only**，spec v0.3 §3.1）：单一真源 =
 *  `didUtil.didPubkeyBytes`（`did:myco:`/`did:youling:` + `z` + 载荷 34B + `0xed 0x01` 头）；
 *  **legacy 裸 base58 已废止**：不解码、不回落 → null。 */
function pubkeyB58Bytes(did: string): Uint8Array | null {
  return didPubkeyBytes(did)
}

// ── delegation ──

/** 委任状正文（phone/服务端字段名；wire 解析时兼容 myco-ubuntu 的 mycoDid）。 */
function delegMsg(d: { accountDid: string; devicePubkeyB64: string; deviceName?: string; scopes?: string; issuedAt?: number; exp: number; nonce?: string }): string {
  return `delegation\n${d.accountDid}\n${d.devicePubkeyB64}\n${d.deviceName ?? ''}\n${d.scopes ?? 'all'}\n${d.issuedAt ?? 0}\n${d.exp}\n${d.nonce ?? ''}`
}

async function cmdDelegationIssue(p: Parsed): Promise<CliOut> {
  const deviceDid = p.flags.did
  if (!deviceDid) return err('用法: delegation issue --did <deviceDid> [--name N] [--scopes a,b] [--ttl-ms N] [--deliver]', true)
  const rootSeed = getRootSeed()
  const rootDid = getRootIdentity()
  if (!rootDid || !rootSeed) return err('本机未持有有灵根钥（不是主设备，或加密模式请先解锁）')
  const pub = p.flags['pubkey-b64'] || pubkeyB64FromDid(deviceDid)
  if (!pub) return err('不支持的 did 格式（设备识别码须为 canonical：did:myco:z… / did:youling:z…）')
  const name = p.flags.name || 'device'
  const scopes = p.flags.scopes || '*'
  const now = Date.now()
  const exp = now + Number(p.flags['ttl-ms'] || DELEGATION_TTL_DEFAULT_MS)
  const d: Delegation = {
    accountDid: rootDid, devicePubkeyB64: pub, deviceName: name, scopes,
    issuedAt: now, exp, nonce: `d${now}`,
    sigB64: b64(ed.sign(new TextEncoder().encode(delegMsg({ accountDid: rootDid, devicePubkeyB64: pub, deviceName: name, scopes, issuedAt: now, exp, nonce: `d${now}` })), fromB64(rootSeed))),
  }
  const wire = wireEncode(JSON.stringify(d))
  let delivered = false
  if (p.flags.deliver === 'true') {
    try {
      const r = await fetch(`${DID_BASE}/delegation/deliver`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountDid: d.accountDid, devicePubkeyB64: pub, deviceName: name, scopes, issuedAt: now, exp, nonce: d.nonce, sigB64: d.sigB64 }),
      })
      delivered = r.ok
      if (!r.ok) return err(`委任状已签发但投递失败 (${r.status})——wire 仍返回`)
    } catch { return err('委任状已签发但投递异常——wire 仍返回') }
  }
  return ok({ delegation: d, wire, ...(delivered ? { delivered: true } : {}) })
}

function cmdDelegationVerify(p: Parsed): CliOut {
  const wire = p.positional[1] // [0]=verify 子命令自身（与 cli.rs positional.get(1) 对齐）
  if (!wire) return err('用法: delegation verify <wire-b64>', true)
  let raw: Record<string, unknown>
  try { raw = JSON.parse(wireDecode(wire)) } catch { return ok({ valid: false, reason: 'wire 结构不符（base64/json 解不开）' }) }
  // 字段双兼容：phone/服务端 accountDid；myco-ubuntu mycoDid
  const accountDid = (raw.accountDid ?? raw.mycoDid) as string | undefined
  if (!accountDid) return ok({ valid: false, reason: '缺 accountDid/mycoDid 字段' })
  const d = {
    accountDid,
    devicePubkeyB64: String(raw.devicePubkeyB64 ?? ''),
    deviceName: raw.deviceName != null ? String(raw.deviceName) : undefined,
    scopes: raw.scopes != null ? String(raw.scopes) : undefined,
    issuedAt: raw.issuedAt != null ? Number(raw.issuedAt) : undefined,
    exp: Number(raw.exp ?? 0),
    nonce: raw.nonce != null ? String(raw.nonce) : undefined,
  }
  const sigB64 = String(raw.sigB64 ?? '')
  const orgPub = pubkeyB58Bytes(accountDid)
  if (!orgPub) return ok({ valid: false, reason: `accountDid 非裸公钥 did 格式: ${accountDid.slice(0, 24)}` })
  let validSig = false
  try { validSig = ed.verify(fromB64(sigB64), new TextEncoder().encode(delegMsg(d)), orgPub) } catch { validSig = false }
  if (!validSig) return ok({ valid: false, reason: '账号签名不匹配' })
  const now = Date.now()
  if (now >= d.exp) return ok({ valid: false, reason: '委任状已过期' })
  return ok({
    valid: true,
    remainingMs: d.exp - now,
    delegation: { ...d, sigB64, ...(raw.mycoDid && !raw.accountDid ? { crossWire: 'myco-ubuntu 字段名（mycoDid）——已按同一签名消息验证通过' } : {}) },
  })
}

function cmdDelegationShow(): CliOut {
  const d = loadDelegation()
  if (!d) return err('本机未持有委任状（主设备身份无需委任状）')
  return ok({ delegation: d, wire: present(d), dueRenew: isDueRenew(d) })
}

// ── status ──

async function cmdStatus(): Promise<CliOut> {
  const id = currentIdentity()
  return ok({
    identity: id ? { did: id.did, nodeId: id.nodeId } : null,
    role: deviceRole(),
    rootDid: getRootIdentity(),
    attestedBy: getAttestation()?.rootDid ?? null,
    delegation: (() => { const d = loadDelegation(); return d ? { exp: d.exp, dueRenew: isDueRenew(d) } : null })(),
    service: DID_BASE || '(同源)',
  })
}

// ── 分发 ──

export async function exec(cmdline: string): Promise<string> {
  let out: CliOut
  try {
    out = await dispatch(cmdline)
  } catch (e) {
    out = err(String((e as Error).message || e))
  }
  return JSON.stringify(out)
}

// ── MD-002（2026-10-21）：UI 桥类型 —— App.tsx 挂载 window.__mycoUi（感知+执行） ──
interface UiBridge {
  state(): unknown
  tab(name: string): string
  openConv(idOrName: string): string
  clickText(text: string): string
}

async function dispatch(cmdline: string): Promise<CliOut> {
  const argv = lex(cmdline.trim())
  if (argv.length === 0) return { ok: true, data: usageText() }
  const sub = argv[0]
  const p = parseArgs(argv.slice(1))
  switch (sub) {
    case 'help': case '--help': case '-h': case 'usage':
      return ok(usageText())
    case 'identity': {
      const act = p.positional[0] ?? 'did'
      if (act === 'birth') return cmdIdentityBirth()
      if (act === 'did') return cmdIdentityDid()
      return err(`未知子命令 identity ${act}（可用: birth / did）`)
    }
    case 'sign':
      return cmdSign(p)
    case 'device': {
      const act = p.positional[0] ?? 'list'
      if (act === 'register') return cmdDeviceRegister(p)
      if (act === 'list') return cmdDeviceList()
      if (act === 'token') return cmdDeviceToken(p)
      if (act === 'verify-token') return cmdDeviceVerifyToken(p)
      return err(`未知子命令 device ${act}（可用: register / list / token / verify-token）`)
    }
    case 'delegation': {
      const act = p.positional[0]
      if (act === 'issue') return cmdDelegationIssue(p)
      if (act === 'verify') return cmdDelegationVerify(p)
      if (act === 'show') return cmdDelegationShow()
      return err(`未知或缺失子命令 delegation ${act ?? ''}（可用: issue / verify / show）`)
    }
    case 'ui': {
        // MD-002（2026-10-21）：UI 感知+执行面（window.__mycoUi）——agent 不再依赖 adb 坐标点按
        const w = globalThis as unknown as { window?: unknown; __mycoUi?: UiBridge }
        const ui = ((typeof window !== 'undefined' ? window : w) as { __mycoUi?: UiBridge }).__mycoUi
        if (!ui) return err('no-__mycoUi（PWA 版本过旧或 App.tsx 未挂载）')
        const act = p.positional[0] ?? 'state'
        const arg = p.positional.slice(1).join(' ') || p.flags.arg || p.flags.text || p.flags.conv || p.flags.name || ''
        try {
            let r: unknown
            if (act === 'state') r = ui.state()
            else if (act === 'tab') r = ui.tab(arg)
            else if (act === 'open-conv' || act === 'openConv') r = ui.openConv(arg)
            else if (act === 'click-text' || act === 'clickText') r = ui.clickText(arg)
            else return err(`未知子命令 ui ${act}（可用: state / tab <tasks|agents> / open-conv <id|名> / click-text <文本>）`)
            if (typeof r === 'string' && r.startsWith('ERR')) return err(r)
            return ok(r)
        } catch (e) {
            return err(String((e as Error).message || e))
        }
    }
    case 'status':
        return cmdStatus()
    default:
      return err(`未知命令 ${sub}`, true)
  }
}

// ── EnvServer 桥（两段式：submit 启动 + pollResult 轮询——网络命令可跑数十秒）──

interface Job { cmdline: string; result: string | null }
const jobs = new Map<string, Job>()
const MAX_JOBS = 32

function submit(id: string, cmdline: string): string {
  if (jobs.size >= MAX_JOBS) {
    const first = jobs.keys().next().value
    if (first !== undefined) jobs.delete(first)
  }
  jobs.set(id, { cmdline, result: null })
  void exec(cmdline).then((r) => {
    const j = jobs.get(id)
    if (j) j.result = r
  })
  return 'ok'
}

function pollResult(id: string): string {
  const j = jobs.get(id)
  if (!j) return '__NOJOB__'
  return j.result ?? '__PENDING__'
}

/** 挂到 window（APK EnvServer /api/cli 与浏览器控制台共用）。幂等。 */
export function installMycoCli(): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as { MycoCli?: unknown }
  w.MycoCli = { exec, submit, pollResult, usage: usageText }
}
