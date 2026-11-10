// delegation.mjs — myco 账号模型 v1:吊销注册表 + 续签收件箱(design/08-identity/MYCO-ACCOUNT-MODEL.md §4/§5)。
// 零依赖;签名格式与 canvas delegation.rs 逐字节一致:
//   revocation msg = "revocation\n{accountDid}\n{ts}\n{revokedCsv}"
//   delegation msg = "delegation\n{accountDid}\n{devicePubkeyB64}\n{deviceName}\n{scopes}\n{issuedAt}\n{exp}\n{nonce}"
// 定位:可用性经纪非信任根——验签全自证(公钥从 DID 派生),本服务挂了系统降级不错。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCryptoDid, isCryptoDid } from './identity/did.mjs'
import { verify, importPublicKey } from './identity/crypto.mjs'

const TE = new TextEncoder()
/** 续签宽限:现委任状过期后仍可续签的窗口(=一个 TTL 30 天;真收回靠吊销,过期只是 hygiene) */
const DELEGATION_GRACE_MS = 30 * 24 * 3600 * 1000
function b64ToBytes(b64) {
  const bin = Buffer.from(String(b64), 'base64')
  return new Uint8Array(bin)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const REV_STORE = join(HERE, 'revocations.json')

/** accountDid → revokedPubkeys[](注册表落盘,服务重启保留) */
function loadRevocations() {
  try { return existsSync(REV_STORE) ? JSON.parse(readFileSync(REV_STORE, 'utf8')) : {} } catch { return {} }
}
function saveRevocations(map) {
  try { writeFileSync(REV_STORE, JSON.stringify(map)) } catch { /* 落盘失败不挡内存态 */ }
}

/** 内存收件箱(重启可丢——续签请求可重发): accountDid → [{devicePubkeyB64, name, ts}] */
const renewInbox = new Map()
/** 内存委任状投递箱: devicePubkeyB64 → delegation(签名自证,谁取都无害) */
const deliverBox = new Map()

function pubFromDid(did) {
  // 双 method 单规则（canonical-only，2026-10-10 收敛）：did:myco:/did:youling: ×
  // canonical z multibase——统一归一到公钥字节（did_pubkey 同法）。legacy 裸 base58
  // 不再收（parseCryptoDid 拒 ⇒ null ⇒ 验签面 false）。只剥前缀的旧版让
  // did:youling 账号（PC 端签发方）全部验签 403（2026-09-15 矩阵抓出）；
  // multibase 载荷则比裸串多 2 字节，同样必须显式剥 0xed 0x01 头。
  const p = parseCryptoDid(String(did ?? ''))
  if (!p) return null
  return Buffer.from(p.idBytes).toString('base64')
}

async function youlingVerify(did, msg, sigB64) {
  const pubB64 = pubFromDid(did)
  if (!pubB64) return false
  try {
    const key = await importPublicKey(b64ToBytes(pubB64))
    return await verify(key, TE.encode(msg), b64ToBytes(sigB64))
  } catch { return false }
}

export const DELEGATION_ROUTES = new Set([
  '/revocation/push',
  '/delegation/renew', '/delegation/inbox', '/delegation/deliver', '/delegation/poll',
])

/** 服务端内部吊销登记（2026-10-16 安全洞修复）：root.mjs 的 /root/device/revoke
 *  验完根钥签名后调用——验签在调用方完成，这里只做注册表合并落盘（与
 *  /revocation/push 同一存储，ts 取 max 防旧报回退）。此前 revoke 只标名册、
 *  注册表恒空 → 平台登录回调查表放行（被吊销设备持旧委任状仍登录成功，真机实证）。 */
export function addRevocationInternal(accountDid, revokedPubkeys) {
  if (!accountDid || !Array.isArray(revokedPubkeys) || revokedPubkeys.length === 0) return
  const map = loadRevocations()
  const prev = map[accountDid] ?? { ts: 0, revokedPubkeys: [] }
  const merged = [...new Set([...prev.revokedPubkeys, ...revokedPubkeys])]
  map[accountDid] = { ts: Math.max(Date.now(), prev.ts), revokedPubkeys: merged }
  saveRevocations(map)
}

/** POST 路由处理(body 已 JSON 解析;raw 未用——消息按字段重建规范形)。
 *  ctx.notifyAccount(accountDid) —— renew 入箱后回调:通知本体"有续签请求待处理"
 *  (identity-server 注入:名册查 embodiment 设备 → 投其信令信箱 renew-notify,在线即推)。 */
export async function handleDelegationPost(pathname, body, send, ctx) {
  // ── 2026-10-10 canonical-only 收敛：accountDid 形态前置闸门──
  // legacy 裸 base58 直接 400「不支持的 did 格式」——此前落进验签 403
  // 「账号签名不匹配」，把形态问题误导成密钥问题（统一文案，与三端/平台同口径）。
  const earlyDid = body?.accountDid
  if (earlyDid != null && earlyDid !== '' && !isCryptoDid(earlyDid)) {
    return send(400, { error: '不支持的 did 格式（accountDid 须为 canonical：did:<method>:z…；legacy 裸 base58 已废止）' })
  }
  // ── 吊销注册表:推(验 账号签名;ts 防旧报重放盖新)──
  if (pathname === '/revocation/push') {
    const { accountDid, revokedPubkeys = [], ts, sigB64 } = body ?? {}
    if (!accountDid || !Array.isArray(revokedPubkeys) || !ts || !sigB64) return send(400, { error: 'need accountDid/revokedPubkeys/ts/sigB64' })
    const msg = `revocation\n${accountDid}\n${ts}\n${revokedPubkeys.join(',')}`
    if (!(await youlingVerify(accountDid, msg, sigB64))) return send(403, { error: '账号签名不匹配' })
    const map = loadRevocations()
    const prev = map[accountDid] ?? { ts: 0, revokedPubkeys: [] }
    if (Number(ts) < prev.ts) return send(409, { error: '过期的吊销报(注册表已有更新记录)' })
    const merged = [...new Set([...prev.revokedPubkeys, ...revokedPubkeys])]
    map[accountDid] = { ts: Number(ts), revokedPubkeys: merged }
    saveRevocations(map)
    return send(200, { ok: true, data: { accountDid, revokedPubkeys: merged } })
  }

  // ── 续签收件箱:分身投请求(设备签名自证 + 现委任状持有证明,spec login-design §7.4)──
  // 持有证明是安全闸:accountDid 是公开串,若只凭设备签名入箱,陌生设备投 renew 即可让
  // 主设备自动签出有效委任状(2026-09-15 堵洞)——必须出示"根钥签给这把设备钥、未吊销、
  // 未过期超宽限"的现委任状才配续签。过期宽限=一个 TTL(手机离线整月仍可续,真收回只能吊销)。
  if (pathname === '/delegation/renew') {
    const { accountDid, devicePubkeyB64, name = '', ts, sigB64, delegation } = body ?? {}
    if (!accountDid || !devicePubkeyB64 || !ts || !sigB64) return send(400, { error: 'need accountDid/devicePubkeyB64/ts/sigB64' })
    const msg = `renew\n${accountDid}\n${devicePubkeyB64}\n${ts}`
    try {
      const key = await importPublicKey(b64ToBytes(devicePubkeyB64))
      const ok = await verify(key, TE.encode(msg), b64ToBytes(sigB64))
      if (!ok) return send(403, { error: '设备签名不匹配' })
    } catch (e) { return send(400, { error: '设备签名验证异常' }) }
    // ── 委任状持有证明(五步,与平台登录验签同链)──
    const d = delegation ?? {}
    if (!d.accountDid || !d.devicePubkeyB64 || !d.exp || !d.sigB64) {
      return send(403, { error: '续签须附现委任状（delegation 字段不全）' })
    }
    if (d.accountDid !== accountDid || d.devicePubkeyB64 !== devicePubkeyB64) {
      return send(403, { error: '委任状与请求身份不符' })
    }
    const dlgMsg = `delegation\n${d.accountDid}\n${d.devicePubkeyB64}\n${d.deviceName ?? ''}\n${d.scopes ?? 'all'}\n${d.issuedAt ?? 0}\n${d.exp}\n${d.nonce ?? ''}`
    if (!(await youlingVerify(accountDid, dlgMsg, d.sigB64))) return send(403, { error: '委任状签名不匹配' })
    const rev = loadRevocations()[accountDid]
    if (rev?.revokedPubkeys?.includes(devicePubkeyB64)) return send(403, { error: '该设备委任已被吊销' })
    const now = Date.now()
    if (d.exp + DELEGATION_GRACE_MS < now) return send(403, { error: '委任状过期超宽限，须主设备重新授权' })
    const arr = renewInbox.get(accountDid) ?? []
    // 同设备旧请求出队,只留最新
    const filtered = arr.filter((r) => r.devicePubkeyB64 !== devicePubkeyB64)
    filtered.push({ devicePubkeyB64, name, ts: Number(ts) })
    renewInbox.set(accountDid, filtered)
    // 事件化通知(2026-09-03 委任闭环):本体在线(SSE 信令长连)即推 renew-notify,
    // 它拉收件箱重签——续签从轮询变事件;不在线则信箱暂存 5min,兜底靠分身 6h 周期重投。
    try { ctx?.notifyAccount?.(accountDid) } catch { /* 通知失败不挡入箱 */ }
    return send(200, { ok: true, data: { queued: true } })
  }

  // ── 投递:本体把续好的委任状放进该设备的箱(委任状自身 账号签名自证)──
  if (pathname === '/delegation/deliver') {
    const d = body ?? {}
    const { accountDid, devicePubkeyB64, deviceName = '', scopes = '*', issuedAt, exp, nonce, sigB64 } = d
    if (!accountDid || !devicePubkeyB64 || !issuedAt || !exp || !nonce || !sigB64) return send(400, { error: 'delegation 字段不全' })
    const msg = `delegation\n${accountDid}\n${devicePubkeyB64}\n${deviceName}\n${scopes}\n${issuedAt}\n${exp}\n${nonce}`
    if (!(await youlingVerify(accountDid, msg, sigB64))) return send(403, { error: '账号签名不匹配' })
    // 吊销即时生效(spec §7.4):注册表已吊销的设备钥,新委任状也不得入箱(主设备本地
    // issue_for 已拒,这里挡"绕过本地记录的重签"——如重装后 delegations.json 丢失的场景)
    const revDel = loadRevocations()[accountDid]
    if (revDel?.revokedPubkeys?.includes(devicePubkeyB64)) return send(403, { error: '该设备已吊销,委任状拒收入箱' })
    deliverBox.set(devicePubkeyB64, d)
    // 出收件箱(已处理)
    const arr = renewInbox.get(accountDid) ?? []
    renewInbox.set(accountDid, arr.filter((r) => r.devicePubkeyB64 !== devicePubkeyB64))
    return send(200, { ok: true })
  }

  return send(404, { error: 'unknown delegation route' })
}

/** GET 路由:注册表查询(公开,验证方轮询)/ 收件箱拉取(本体)/ 委任状取件(分身)。 */
export async function handleDelegationGet(pathname, url, send) {
  if (pathname.startsWith('/revocation/')) {
    const accountDid = decodeURIComponent(pathname.slice('/revocation/'.length))
    const map = loadRevocations()
    const rec = map[accountDid]
    return send(200, { ok: true, data: rec ?? { ts: 0, revokedPubkeys: [] } })
  }
  if (pathname === '/delegation/inbox') {
    const accountDid = url.searchParams.get('accountDid') ?? ''
    if (!accountDid) return send(400, { error: 'need accountDid' })
    return send(200, { ok: true, data: renewInbox.get(accountDid) ?? [] })
  }
  if (pathname === '/delegation/poll') {
    const devicePubkeyB64 = url.searchParams.get('devicePubkeyB64') ?? ''
    if (!devicePubkeyB64) return send(400, { error: 'need devicePubkeyB64' })
    return send(200, { ok: true, data: deliverBox.get(devicePubkeyB64) ?? null })
  }
  return send(404, { error: 'unknown delegation route' })
}
