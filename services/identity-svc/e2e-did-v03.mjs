// e2e-did-v03.mjs — spec v0.3 canonical-only e2e（本地起服务后跑；2026-10-10 收敛）：
//   ① /identity/register（公钥注册）→ 响应 did 以 z 开头（canonical）；legacy 串领挑战 400
//   ② phone 式 /root/create（canonical rootDid + rootSig）→ 201；GET /root/<canonical> 读回
//   ③ legacy 存量登录被闸门拒：legacy 串走 challenge → 400 unsupported_did_format
//   ④ X-Myco-Auth（sign-every-request）：canonical did 签名 presence/register → 200；
//      同一钥匙 legacy 串再签一次 → 403（单形态查找恒 miss）；信令投递 to=legacy → 400
//   ⑤ 委任状 /delegation/deliver：canonical accountDid 签名 → 200（did:youling 修复顺带验证）
// 用法：node e2e-did-v03.mjs [baseURL= http://127.0.0.1:18321]
import { generateKeyPair, exportPublicKeyRaw, sign } from './identity/crypto.mjs'
import { base58Encode } from './identity/did.mjs'

const BASE = process.argv[2] || 'http://127.0.0.1:18321'
const b64 = (u8) => Buffer.from(u8).toString('base64')
const enc = new TextEncoder()
let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fail++; console.log(`  ✖ ${name} ${detail}`) }
}

const canonicalDid = (pub, method) => {
  const payload = new Uint8Array(34)
  payload[0] = 0xed; payload[1] = 0x01; payload.set(pub, 2)
  return `${method}:z${base58Encode(payload)}`
}
const legacyDid = (pub, method) => `${method}:${base58Encode(pub)}`

async function post(path, body, headers = {}) {
  const raw = JSON.stringify(body ?? {})
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw })
  let j = null; try { j = await r.json() } catch { /* 空 body */ }
  return { status: r.status, body: j }
}
async function get(path) {
  const r = await fetch(`${BASE}${path}`)
  let j = null; try { j = await r.json() } catch { /* */ }
  return { status: r.status, body: j }
}
async function authHeader(did, priv, rawBody) {
  const ts = Date.now()
  const sig = await sign(priv, enc.encode(`${did}\n${ts}\n${rawBody}`))
  return `${did}.${ts}.${b64(sig)}`
}

// ── ① 设备身份注册（canonical 响应）+ legacy 串被闸门拒（2026-10-08 设备面单形态定稿）──
console.log('① /identity/register canonical + legacy 拒（400 unsupported_did_format）')
const dev = await generateKeyPair()
const devPub = await exportPublicKeyRaw(dev.publicKey)
const devCanonical = canonicalDid(devPub, 'did:myco')
const devLegacy = legacyDid(devPub, 'did:myco')
const reg = await post('/identity/register', { publicKeyB64: b64(devPub) })
ok('register 201', reg.status === 201, JSON.stringify(reg.body))
ok('响应 did = canonical（z 开头）', reg.body?.did === devCanonical, `${reg.body?.did} ≠ ${devCanonical}`)
// 原断言（作废）：legacy 串领挑战 200 + 登录 200（双格式变体兜底）。删因：设备面
// 单形态定稿——未升级老客户端 legacy did 一律 400 引导升级（同一把 device.key 在
// 新客户端派生即 canonical，无需换钥）。
const ch1 = await post('/identity/challenge', { did: devLegacy })
ok('legacy 串领挑战 400 unsupported_did_format', ch1.status === 400 && ch1.body?.code === 'unsupported_did_format', JSON.stringify(ch1.body))
const chCanon = await post('/identity/challenge', { did: devCanonical })
ok('canonical 串领挑战 200', chCanon.status === 200, JSON.stringify(chCanon.body))

// ── ② phone 式 root/create（canonical rootDid）──
console.log('② /root/create canonical')
const root = await generateKeyPair()
const rootPub = await exportPublicKeyRaw(root.publicKey)
const rootCanonical = canonicalDid(rootPub, 'did:youling')
const rootLegacy = legacyDid(rootPub, 'did:youling')
const rootSigMsg = enc.encode(`create\n${rootCanonical}\n${b64(rootPub)}`)
const rootSig = b64(await sign(root.privateKey, rootSigMsg))
const rc = await post('/root/create', {
  rootDid: rootCanonical, rootPubkeyB64: b64(rootPub), devicePubkeyB64: b64(devPub),
  name: 'e2e-v03', deviceName: 'E2E', rootSig,
})
ok('root/create 201', rc.status === 201, JSON.stringify(rc.body))
const readCanonical = await get(`/root/${encodeURIComponent(rootCanonical)}`)
ok('GET /root/<canonical> 200 且 devices 含本设备', readCanonical.status === 200 && readCanonical.body?.data?.devices?.some(d => d.pubkeyB64 === b64(devPub)))
// （2026-10-07 群体评审 P1-4：断言删→反转为 404——锁死单形态新语义，部署验收覆盖行为翻转）
const readLegacy = await get(`/root/${encodeURIComponent(rootLegacy)}`)
ok('GET /root/<legacy 同钥> 404（单形态精确查询，异形态不命中）', readLegacy.status === 404, JSON.stringify(readLegacy.body))

// ── ④ X-Myco-Auth 双格式（presence + 信箱同桶）──
console.log('④ X-Myco-Auth 双格式')
const rawA = JSON.stringify({ nodeId: 'e2e-node', name: 'e2e', rootDid: rootCanonical, role: 'embodiment', kind: 'e2e' })
const h1 = await authHeader(devCanonical, dev.privateKey, rawA)
const p1 = await post('/presence/register', { nodeId: 'e2e-node', name: 'e2e', rootDid: rootCanonical, role: 'embodiment', kind: 'e2e' }, { 'x-myco-auth': h1 })
ok('canonical did 签名 presence/register 200', p1.status === 200, JSON.stringify(p1.body))
const rawB = JSON.stringify({})
const h2 = await authHeader(devLegacy, dev.privateKey, rawB)
const p2 = await post('/presence/heartbeat', {}, { 'x-myco-auth': h2 })
// 原断言（作废）：legacy did 同钥签名 heartbeat 200（验签面双收）。删因：设备面单形态
// ——legacy did 单形态查找恒 miss → 403（老客户端不可用被迫升级；新客户端恒 canonical）。
ok('legacy did 同钥签名 heartbeat 403（单形态后鉴权面收紧）', p2.status === 403, JSON.stringify(p2.body))
// 信箱投递（2026-10-10 canonical-only 收敛，原「双格式同桶归一」作废）：legacy 串
// 作 to 一律 400「不支持的 did 格式」——投递/轮询两侧都必须出示 canonical，形态
// 错配=拒（不再静默换桶）；drain 用 canonical 串取。
const pairBody = { to: devLegacy, name: 'e2e', nonce: 'n1' }
const h3 = await authHeader(devCanonical, dev.privateKey, JSON.stringify(pairBody))
const sig3 = await post('/signal/pair', pairBody, { 'x-myco-auth': h3 })
ok('signal/pair 投递到 legacy 串 → 400 不支持的 did 格式（收敛后拒）', sig3.status === 400 && String(sig3.body?.error || '').includes('不支持的 did 格式'), JSON.stringify(sig3.body))
const pairBodyOk = { to: devCanonical, name: 'e2e', nonce: 'n2' }
const h4 = await authHeader(devCanonical, dev.privateKey, JSON.stringify(pairBodyOk))
const sig4 = await post('/signal/pair', pairBodyOk, { 'x-myco-auth': h4 })
ok('signal/pair 投递到 canonical 串 200（canonical 仍通）', sig4.status === 200, JSON.stringify(sig4.body))
const drainH = await authHeader(devCanonical, dev.privateKey, '')
const drained = await fetch(`${BASE}/signal/drain`, { headers: { 'x-myco-auth': drainH } })
const drainBody = await drained.json().catch(() => ({ data: [] }))
ok('canonical 串 drain 取到 canonical 投递（legacy 投递不入箱）', (drainBody?.data ?? []).some(m => m?.type === 'pair' && m?.nonce === 'n2') && !(drainBody?.data ?? []).some(m => m?.nonce === 'n1'), JSON.stringify(drainBody).slice(0, 160))

// ── ⑤ 委任状 canonical accountDid ──
console.log('⑤ /delegation/deliver canonical accountDid')
const issuedAt = Date.now(), exp = issuedAt + 3600_000, nonce = `e2e${issuedAt}`
const deviceName = 'e2e-agent', scopes = '*'
const delMsg = `delegation\n${rootCanonical}\n${b64(devPub)}\n${deviceName}\n${scopes}\n${issuedAt}\n${exp}\n${nonce}`
const delSig = b64(await sign(root.privateKey, enc.encode(delMsg)))
const dl = await post('/delegation/deliver', { accountDid: rootCanonical, devicePubkeyB64: b64(devPub), deviceName, scopes, issuedAt, exp, nonce, sigB64: delSig })
ok('delegation/deliver canonical 200', dl.status === 200, JSON.stringify(dl.body))
const delTaken = await get(`/delegation/poll?devicePubkeyB64=${encodeURIComponent(b64(devPub))}`)
ok('delegation/poll 取回 200 且 accountDid=canonical', delTaken.status === 200 && delTaken.body?.data?.accountDid === rootCanonical, JSON.stringify(delTaken.body).slice(0, 160))

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
