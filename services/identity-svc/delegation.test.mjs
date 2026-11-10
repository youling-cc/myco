// delegation.test.mjs — myco 账号模型:吊销注册表+续签收件箱 端点单测(node --test)。
// 全真签名(ed25519 via WebCrypto),零 mock:签发→推注册表→查询 / 续签请求→收件箱→投递→取件。
import test from 'node:test'
import assert from 'node:assert/strict'

// 被测路由处理函数直接调用(send 捕获)。文件级副作用:revocations.json 会写真实文件——
// 测试前重定向到临时路径做不到(模块内常量),故用专用测试 youling 命名空间,断言后不清理(幂等合并)。
const { DELEGATION_ROUTES, handleDelegationPost, handleDelegationGet } = await import('./delegation.mjs')
const { generateKeyPair, sign } = await import('./identity/crypto.mjs')
const { didFromPublicKey, base58Encode } = await import('./identity/did.mjs')

// WebCrypto 原语(crypto.mjs 的 key 形态)
const sub = globalThis.crypto.subtle
const TE = new TextEncoder()

function b64(u8) { return Buffer.from(u8).toString('base64') }
function unb64(s) { return new Uint8Array(Buffer.from(String(s), 'base64')) }

async function newYouling() {
  const kp = await sub.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const raw = new Uint8Array(await sub.exportKey('raw', kp.publicKey))
  const did = didFromPublicKey(raw)
  return { kp, did, sign: async (msg) => b64(new Uint8Array(await sub.sign({ name: 'Ed25519' }, kp.privateKey, TE.encode(msg)))) }
}

function mkSend() {
  const out = { status: 0, body: null }
  return { send: (status, body) => { out.status = status; out.body = body }, out }
}

test('routes 表完整', () => {
  for (const r of ['/revocation/push', '/delegation/renew', '/delegation/inbox', '/delegation/deliver', '/delegation/poll']) {
    assert.ok(DELEGATION_ROUTES.has(r), r)
  }
})

test('吊销注册表:签名推送→合并→查询;坏签名拒', async () => {
  const youling = await newYouling()
  const ts = Date.now()
  const csv = ['pk-a', 'pk-b']
  const sig = await youling.sign(`revocation\n${youling.did}\n${ts}\n${csv.join(',')}`)
  const { send, out } = mkSend()
  await handleDelegationPost('/revocation/push', { accountDid: youling.did, revokedPubkeys: csv, ts, sigB64: sig }, send)
  assert.equal(out.status, 200)
  assert.deepEqual(out.body.data.revokedPubkeys, csv)

  // 查询(GET)
  const g = mkSend()
  await handleDelegationGet(`/revocation/${encodeURIComponent(youling.did)}`, new URL('http://x/'), g.send)
  assert.equal(g.out.status, 200)
  assert.deepEqual(g.out.body.data.revokedPubkeys, csv)

  // 坏签名
  const bad = mkSend()
  await handleDelegationPost('/revocation/push', { accountDid: youling.did, revokedPubkeys: ['pk-c'], ts: ts + 1, sigB64: sig }, bad.send)
  assert.equal(bad.out.status, 403)

  // 旧报重放(更旧 ts)拒
  const stale = mkSend()
  await handleDelegationPost('/revocation/push', { accountDid: youling.did, revokedPubkeys: ['pk-c'], ts: ts - 1000, sigB64: await youling.sign(`revocation\n${youling.did}\n${ts - 1000}\npk-c`) }, stale.send)
  assert.equal(stale.out.status, 409)
})

test('续签收件箱:委任状持有证明→本体拉取→投递(账号签)→分身取件;吊销即时拒', async () => {
  const youling = await newYouling()
  const dev = await sub.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const devPubB64 = b64(new Uint8Array(await sub.exportKey('raw', dev.publicKey)))
  const ts = Date.now()

  // ⓪ 首签委任状(本体签发投递,分身才有得续)
  const dlg = { accountDid: youling.did, devicePubkeyB64: devPubB64, deviceName: '测试手机', scopes: '*', issuedAt: ts, exp: ts + 30 * 24 * 3600 * 1000, nonce: `d${ts}` }
  const dlgMsg = `delegation\n${dlg.accountDid}\n${dlg.devicePubkeyB64}\n${dlg.deviceName}\n${dlg.scopes}\n${dlg.issuedAt}\n${dlg.exp}\n${dlg.nonce}`
  dlg.sigB64 = await youling.sign(dlgMsg)
  const r0 = mkSend()
  await handleDelegationPost('/delegation/deliver', { ...dlg }, r0.send)
  assert.equal(r0.out.status, 200)

  // ①分身投续签请求(带现委任状持有证明)
  const renewMsg = `renew\n${youling.did}\n${devPubB64}\n${ts}`
  const devSig = b64(new Uint8Array(await sub.sign({ name: 'Ed25519' }, dev.privateKey, TE.encode(renewMsg))))
  const r1 = mkSend()
  await handleDelegationPost('/delegation/renew', { accountDid: youling.did, devicePubkeyB64: devPubB64, name: '测试手机', ts, sigB64: devSig, delegation: dlg }, r1.send)
  assert.equal(r1.out.status, 200)

  // ①b 劫持负例:无委任状的陌生设备(签名合法)拒——accountDid 公开,不能白拿委任状
  const rogue = await sub.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const roguePubB64 = b64(new Uint8Array(await sub.exportKey('raw', rogue.publicKey)))
  const rogueSig = b64(new Uint8Array(await sub.sign({ name: 'Ed25519' }, rogue.privateKey, TE.encode(`renew\n${youling.did}\n${roguePubB64}\n${ts}`))))
  const r1x = mkSend()
  await handleDelegationPost('/delegation/renew', { accountDid: youling.did, devicePubkeyB64: roguePubB64, ts, sigB64: rogueSig }, r1x.send)
  assert.equal(r1x.out.status, 403)

  // ①c 张冠李戴负例:拿别人的委任状续自己 → 拒
  const r1y = mkSend()
  await handleDelegationPost('/delegation/renew', { accountDid: youling.did, devicePubkeyB64: roguePubB64, ts, sigB64: rogueSig, delegation: dlg }, r1y.send)
  assert.equal(r1y.out.status, 403)

  // 坏设备签名拒
  const r1b = mkSend()
  await handleDelegationPost('/delegation/renew', { accountDid: youling.did, devicePubkeyB64: devPubB64, ts: ts + 1, sigB64: devSig, delegation: dlg }, r1b.send)
  assert.equal(r1b.out.status, 403)

  // ②本体拉收件箱
  const g1 = mkSend()
  await handleDelegationGet('/delegation/inbox', new URL(`http://x/?accountDid=${encodeURIComponent(youling.did)}`), g1.send)
  assert.equal(g1.out.status, 200)
  assert.equal(g1.out.body.data.length, 1)
  assert.equal(g1.out.body.data[0].devicePubkeyB64, devPubB64)

  // ③本体投递续好的委任状(账号签,消息与 canvas delegation.rs 规范形一致)
  const r2 = mkSend()
  await handleDelegationPost('/delegation/deliver', { ...dlg, sigB64: await youling.sign(dlgMsg) }, r2.send)
  assert.equal(r2.out.status, 200)

  // 坏 账号签的委任状拒
  const other = await newYouling()
  const r2b = mkSend()
  await handleDelegationPost('/delegation/deliver', { ...dlg, sigB64: await other.sign(dlgMsg) }, r2b.send)
  assert.equal(r2b.out.status, 403)

  // ④分身取件
  const g2 = mkSend()
  await handleDelegationGet('/delegation/poll', new URL(`http://x/?devicePubkeyB64=${encodeURIComponent(devPubB64)}`), g2.send)
  assert.equal(g2.out.status, 200)
  assert.equal(g2.out.body.data.accountDid, youling.did)
  assert.equal(g2.out.body.data.exp, dlg.exp)

  // ⑤投递后收件箱清空
  const g3 = mkSend()
  await handleDelegationGet('/delegation/inbox', new URL(`http://x/?accountDid=${encodeURIComponent(youling.did)}`), g3.send)
  assert.equal(g3.out.body.data.length, 0)

  // ⑥吊销即时生效:注册表吊销该设备 → renew 拒、deliver(重签)拒
  const rvTs = Date.now()
  const rvSig = await youling.sign(`revocation\n${youling.did}\n${rvTs}\n${devPubB64}`)
  const r6 = mkSend()
  await handleDelegationPost('/revocation/push', { accountDid: youling.did, revokedPubkeys: [devPubB64], ts: rvTs, sigB64: rvSig }, r6.send)
  assert.equal(r6.out.status, 200)
  const r6a = mkSend()
  await handleDelegationPost('/delegation/renew', { accountDid: youling.did, devicePubkeyB64: devPubB64, ts: rvTs + 1, sigB64: b64(new Uint8Array(await sub.sign({ name: 'Ed25519' }, dev.privateKey, TE.encode(`renew\n${youling.did}\n${devPubB64}\n${rvTs + 1}`)))), delegation: dlg }, r6a.send)
  assert.equal(r6a.out.status, 403)
  const r6b = mkSend()
  await handleDelegationPost('/delegation/deliver', { ...dlg, issuedAt: rvTs, sigB64: await youling.sign(`delegation\n${dlg.accountDid}\n${dlg.devicePubkeyB64}\n${dlg.deviceName}\n${dlg.scopes}\n${rvTs}\n${dlg.exp}\n${dlg.nonce}`) }, r6b.send)
  assert.equal(r6b.out.status, 403)
})

// ══ 2026-10-10 canonical-only 收敛（红绿双证）══
test('legacy 裸 base58 accountDid → 400「不支持的 did 格式」（红：legacy 拒，不再落 403 签名不匹配）', async () => {
  const youling = await newYouling()
  const legacyDid = 'did:youling:' + base58Encode(Buffer.from('55'.repeat(32), 'hex'))
  const ts = Date.now()
  // 即便签名材料按 legacy did 正确签出，形态闸门也先行 400
  const sig = await youling.sign(`revocation\n${legacyDid}\n${ts}\npk-x`)
  const r1 = mkSend()
  await handleDelegationPost('/revocation/push', { accountDid: legacyDid, revokedPubkeys: ['pk-x'], ts, sigB64: sig }, r1.send)
  assert.equal(r1.out.status, 400, JSON.stringify(r1.out.body))
  assert.ok(String(r1.out.body?.error).includes('不支持的 did 格式'), `统一文案: ${JSON.stringify(r1.out.body)}`)
  // renew 同闸
  const r2 = mkSend()
  await handleDelegationPost('/delegation/renew', { accountDid: legacyDid, devicePubkeyB64: 'pk', ts, sigB64: sig }, r2.send)
  assert.equal(r2.out.status, 400, JSON.stringify(r2.out.body))
  assert.ok(String(r2.out.body?.error).includes('不支持的 did 格式'), JSON.stringify(r2.out.body))
})

test('canonical accountDid 对照仍通（绿：canonical 通过）', async () => {
  const youling = await newYouling()
  const ts = Date.now()
  const sig = await youling.sign(`revocation\n${youling.did}\n${ts}\npk-y`)
  const r = mkSend()
  await handleDelegationPost('/revocation/push', { accountDid: youling.did, revokedPubkeys: ['pk-y'], ts, sigB64: sig }, r.send)
  assert.equal(r.out.status, 200, JSON.stringify(r.out.body))
})
