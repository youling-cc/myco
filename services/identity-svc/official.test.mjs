// official.test.mjs — 官方通知通道单测（node --test，2026-10-20「小灵」）
// 覆盖：鉴权/批量与群发/幂等去重/字段校验/URL 白名单/TTL 夹取/状态机（queued→delivered→read→expired）/
//       设备归属校验/限流/持久化重载。签名验证用真 ed25519（identity/crypto.mjs）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createOfficialApi, noticeSignMaterial, NOTICE_KIND, TITLE_MAX, BODY_MAX, BATCH_MAX, TTL_MIN_MS,
  OFFICIAL_GET_ROUTES, OFFICIAL_POST_ROUTES, DEFAULT_URL_HOSTS,
} from './official.mjs'
import {
  generateKeyPair, exportPublicKeyRaw, exportPrivateKeyPkcs8, importPublicKey, verify,
} from './identity/crypto.mjs'
import { canonicalMethodId, didFromPublicKey } from './identity/did.mjs'

const b64 = (u8) => Buffer.from(u8).toString('base64')
const didAcct = (pub) => `did:youling:${canonicalMethodId(pub)}`
const didDev = (pub) => didFromPublicKey(pub) // canonical did:myco:（客户端设备）

// —— 测试夹具：真 ed25519 官方账号 + 临时目录 + 假信箱 ——
const dirs = []
function tmpDir() { const d = mkdtempSync(join(tmpdir(), 'myco-official-')); dirs.push(d); return d }
test.after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* */ } } })

const ROOT = await generateKeyPair()
const ROOT_PUB = await exportPublicKeyRaw(ROOT.publicKey)
const PUSH = await generateKeyPair()          // identity-svc 持有的「小灵推送」设备钥
const PUSH_PUB = await exportPublicKeyRaw(PUSH.publicKey)
const OFFICIAL = {
  did: didAcct(ROOT_PUB), name: '小灵',
  rootPubkeyB64: b64(ROOT_PUB),
  devicePubkeyB64: b64(PUSH_PUB),
  devicePrivPkcs8B64: b64(await exportPrivateKeyPkcs8(PUSH.privateKey)),
}
const DEV = await generateKeyPair()
const DEV_PUB = await exportPublicKeyRaw(DEV.publicKey)
const DEV_DID = didDev(DEV_PUB)
const ACC_A = didAcct((await exportPublicKeyRaw((await generateKeyPair()).publicKey)))
const ACC_B = didAcct((await exportPublicKeyRaw((await generateKeyPair()).publicKey)))
const TOKEN = 'test-token-0123456789abcdef'

function mkApi(opts = {}) {
  const inbox = []
  const nowRef = { t: 1_800_000_000_000 }
  const dir = tmpDir()
  const api = createOfficialApi({
    dir, token: TOKEN, official: OFFICIAL,
    deposit: (did, env) => inbox.push({ did, env }),
    now: () => nowRef.t,
    ratePerSec: opts.ratePerSec || 1000,
    urlHosts: opts.urlHosts || DEFAULT_URL_HOSTS,
    ...(opts.dir ? { dir: opts.dir } : {}),
  })
  return { api, inbox, nowRef }
}
function mkSend() { const out = { status: 0, body: null }; return { out, send: (s, b) => { out.status = s; out.body = b } } }
const HDRS = { 'x-official-token': TOKEN }
const baseBody = (over = {}) => ({
  to: [ACC_A], title: '你这道题有疑议',
  body: '题目「无人售货柜商品结算」被申诉，你可在 24 小时内补充陈词。',
  action: { label: '去写陈词', url: 'https://dev.youling.cc/tool/t1/i2' },
  category: 'appeal.statement.invite', dedupeKey: 'appeal:c1:invite', ...over,
})
async function notify(api, body, headers = HDRS) {
  const { out, send } = mkSend()
  await api.handlePost('/official/notify', JSON.stringify(body ?? {}), '', body, send, { headers })
  return out
}
async function status(api, qs, headers = HDRS) {
  const { out, send } = mkSend()
  api.handleGet('/official/status', new URLSearchParams(qs), headers, send)
  return out
}
async function read(api, body, ctx) {
  const { out, send } = mkSend()
  await api.handlePost('/official/read', JSON.stringify(body ?? {}), 'auth', body, send,
    ctx || { authedDid: async () => DEV_DID, rootApi: { getRoot: () => ({ devices: [{ pubkeyB64: b64(DEV_PUB), revoked: 0 }] }) } })
  return out
}

test('route 表与关键常量', () => {
  for (const p of ['/official/info', '/official/status']) assert.ok(OFFICIAL_GET_ROUTES.has(p), p)
  for (const p of ['/official/notify', '/official/read']) assert.ok(OFFICIAL_POST_ROUTES.has(p), p)
  assert.equal(NOTICE_KIND, 'official-notice')
  assert.equal(TITLE_MAX, 60)
  assert.equal(BODY_MAX, 500)
  assert.equal(BATCH_MAX, 200)
  assert.ok(DEFAULT_URL_HOSTS.includes('dev.youling.cc'))
})

test('未配置官方账号：info/notify 都 503（安全默认）', async () => {
  const dir = tmpDir()
  const api = createOfficialApi({ dir, token: TOKEN, official: null, deposit: () => {}, now: () => Date.now() })
  const i = mkSend(); api.handleGet('/official/info', new URLSearchParams(), {}, i.send)
  assert.equal(i.out.status, 503)
  const n = await notify(api, baseBody())
  assert.equal(n.status, 503)
})

test('鉴权：缺 token / 错 token → 401；正确 token 放行', async () => {
  const { api } = mkApi()
  assert.equal((await notify(api, baseBody(), {})).status, 401)
  assert.equal((await notify(api, baseBody(), { 'x-official-token': 'wrong' })).status, 401)
  assert.equal((await notify(api, baseBody(), HDRS)).status, 200)
})

test('单发：入信箱形状正确 + 状态 queued + 载荷字段齐', async () => {
  const { api, inbox } = mkApi()
  const r = await notify(api, baseBody({ meta: { caseId: 'c1', itemId: 'i2' } }))
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  const n0 = r.body.data.notices[0]
  assert.equal(n0.did, ACC_A)
  assert.equal(n0.state, 'queued')
  assert.equal(n0.dedupe, false)
  assert.equal(inbox.length, 1)
  assert.equal(r.body.data.nextPollHintMs, 5000)
  const env = inbox[0].env
  assert.equal(env.kind, 'official-notice')
  assert.equal(env.payload.signer.pubkeyB64, b64(PUSH_PUB))
  assert.equal(env.from, OFFICIAL.did)
  assert.equal(env.fromName, '小灵')
  for (const k of ['noticeId', 'title', 'body', 'action', 'category', 'createdAt', 'expiresAt', 'sigB64', 'officialDid']) {
    assert.ok(k in env.payload, k)
  }
  assert.deepEqual(env.payload.meta, { caseId: 'c1', itemId: 'i2' })
})

test('签名可被客户端用官方公钥验过（改一个字就过不去）', async () => {
  const { api, inbox } = mkApi()
  await notify(api, baseBody())
  const p = inbox[0].env.payload
  assert.equal(p.signer.pubkeyB64, b64(PUSH_PUB), '通知由「小灵推送」设备钥签')
  const pk = await importPublicKey(PUSH_PUB)
  const material = noticeSignMaterial(ACC_A, p.noticeId, p.createdAt, p)
  const sig = new Uint8Array(Buffer.from(p.sigB64, 'base64'))
  assert.equal(await verify(pk, new TextEncoder().encode(material), sig), true)
  const tampered = noticeSignMaterial(ACC_A, p.noticeId, p.createdAt, { ...p, body: p.body + 'x' })
  assert.equal(await verify(pk, new TextEncoder().encode(tampered), sig), false)
})

test('群发：3 个不同 did 一次请求 → 各自独立 noticeId + 3 条信箱', async () => {
  const { api, inbox } = mkApi()
  const accC = didAcct((await exportPublicKeyRaw((await generateKeyPair()).publicKey)))
  const r = await notify(api, baseBody({ to: [ACC_A, ACC_B, accC] }))
  assert.equal(r.status, 200)
  assert.equal(r.body.data.notices.length, 3)
  const ids = r.body.data.notices.map((n) => n.noticeId)
  assert.equal(new Set(ids).size, 3, '每人独立 noticeId')
  assert.equal(inbox.length, 3)
  assert.ok(r.body.data.notices.every((n) => n.state === 'queued' && n.dedupe === false))
})

test('群发：同一批里同 did 重复出现 → 按 did+dedupeKey 去重（避免重复轰炸）', async () => {
  const { api, inbox } = mkApi()
  const r = await notify(api, baseBody({ to: [ACC_A, ACC_B, ACC_A] }))
  assert.equal(r.status, 200)
  assert.equal(r.body.data.notices.length, 3)
  const aRows = r.body.data.notices.filter((n) => n.did === ACC_A)
  assert.equal(aRows.length, 2)
  assert.equal(aRows[0].dedupe, false)
  assert.equal(aRows[1].dedupe, true)
  assert.equal(aRows[0].noticeId, aRows[1].noticeId)
  assert.equal(inbox.length, 2)
})

test('批量：200 收件人通过，201 拒绝', async () => {
  const { api } = mkApi()
  const many = Array.from({ length: BATCH_MAX }, (_, i) => didAcct(new Uint8Array(32).fill(1 + (i % 250))))
  const ok = await notify(api, baseBody({ to: many }))
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 200))
  const too = await notify(api, baseBody({ to: [...many, ACC_B] }))
  assert.equal(too.status, 400)
})

test('非法 did 进 rejected，合法收件人照发', async () => {
  const { api, inbox } = mkApi()
  const r = await notify(api, baseBody({ to: ['not-a-did', ACC_B] }))
  assert.equal(r.status, 200)
  assert.equal(r.body.data.notices.length, 1)
  assert.equal(r.body.data.rejected.length, 1)
  assert.equal(r.body.data.rejected[0].did, 'not-a-did')
  assert.equal(inbox.length, 1)
})

test('幂等去重：同 dedupeKey 再发 → dedupe:true 且不再入箱', async () => {
  const { api, inbox } = mkApi()
  const r1 = await notify(api, baseBody())
  const r2 = await notify(api, baseBody())
  assert.equal(r1.body.data.notices[0].dedupe, false)
  assert.equal(r2.body.data.notices[0].dedupe, true)
  assert.equal(r2.body.data.notices[0].noticeId, r1.body.data.notices[0].noticeId)
  assert.equal(inbox.length, 1)
})

test('字段校验：标题/正文超长、控制字符、缺 action 全部拒绝', async () => {
  const { api } = mkApi()
  assert.equal((await notify(api, baseBody({ title: '字'.repeat(TITLE_MAX + 1) }))).status, 400)
  assert.equal((await notify(api, baseBody({ body: '字'.repeat(BODY_MAX + 1) }))).status, 400)
  assert.equal((await notify(api, baseBody({ title: 'bad\u0001title' }))).status, 400)
  const badUrl = await notify(api, baseBody({ action: { label: '去', url: 'https://evil.example.com/x' } }))
  assert.equal(badUrl.status, 400)
  assert.equal(badUrl.body.reason, 'url_not_allowlisted')
  assert.equal((await notify(api, baseBody({ action: { label: '', url: 'https://dev.youling.cc/x' } }))).status, 400)
})

test('TTL 夹取：expiresInMs=1 → 最小 TTL', async () => {
  const { api, inbox } = mkApi()
  await notify(api, baseBody({ expiresInMs: 1, dedupeKey: '' }))
  const p = inbox[0].env.payload
  assert.equal(p.expiresAt - p.createdAt, TTL_MIN_MS)
})

test('状态机：poll 出队≠触达（只记 legacy 证据），pending 才置 delivered（card-v1）', async () => {
  const { api, inbox, nowRef } = mkApi()
  const r = await notify(api, baseBody())
  const nid = r.body.data.notices[0].noticeId
  const pending = async (extra = {}) => {
    const { out, send } = mkSend()
    await api.handlePost('/official/pending', '{}', 'auth', { accountDid: ACC_A, ...extra }, send, {
      authedDid: async () => DEV_DID,
      rootApi: { getRoot: () => ({ devices: [{ pubkeyB64: b64(DEV_PUB), revoked: 0 }] }) },
    })
    return out
  }
  let st = await status(api, { noticeIds: nid })
  assert.equal(st.body.data.notices[0].state, 'queued')
  assert.equal(st.body.data.notices[0].clientCapability, null)
  assert.equal(st.body.data.notices[0].clientLastSeenAt, null)

  // 旧版客户端拉信箱（会丢弃未知 kind）：只记 legacy 证据，state 保持 queued
  nowRef.t += 1234
  api.onPolled(ACC_A, inbox.map((x) => x.env))
  st = await status(api, { noticeIds: nid })
  assert.equal(st.body.data.notices[0].state, 'queued')
  assert.equal(st.body.data.notices[0].clientCapability, 'legacy')
  assert.ok(st.body.data.notices[0].clientLastSeenAt)

  // 新版客户端 pending 心跳（= 真触达证据）→ queued 转 delivered + card-v1
  nowRef.t += 500
  const p = await pending({ client: { version: '0.3.142', caps: ['official-card-v1'] } })
  assert.equal(p.status, 200)
  assert.equal(p.body.data.count, 1)
  st = await status(api, { noticeIds: nid })
  assert.equal(st.body.data.notices[0].state, 'delivered')
  assert.ok(st.body.data.notices[0].deliveredAt)
  assert.equal(st.body.data.notices[0].clientCapability, 'card-v1')
})

  test('status 过滤：dids + unread + olderThanMs', async () => {
  const { api, nowRef } = mkApi()
  await notify(api, baseBody({ to: [ACC_A] }))
  nowRef.t += 10_000
  await notify(api, baseBody({ to: [ACC_B], dedupeKey: 'k2' }))
  const byA = await status(api, { dids: ACC_A })
  assert.equal(byA.body.data.notices.length, 1)
  assert.equal(byA.body.data.notices[0].did, ACC_A)
  const unread = await status(api, { dids: `${ACC_A},${ACC_B}`, unread: '1' })
  assert.equal(unread.body.data.notices.length, 2)
  const older = await status(api, { olderThan: '5000' }) // 契约名 olderThan（毫秒）
  assert.equal(older.body.data.notices.length, 1)
  assert.equal(older.body.data.notices[0].did, ACC_A)
})

test('已读回执：只有自己的能被标记；别人的 id 静默跳过', async () => {
  const { api } = mkApi()
  const a = await notify(api, baseBody({ to: [ACC_A] }))
  const b = await notify(api, baseBody({ to: [ACC_B], dedupeKey: 'kb' }))
  const nidA = a.body.data.notices[0].noticeId
  const nidB = b.body.data.notices[0].noticeId
  const r1 = await read(api, { accountDid: ACC_A, noticeIds: [nidA, nidB] })
  assert.equal(r1.status, 200)
  assert.equal(r1.body.data.marked, 1)
  const st = await status(api, { noticeIds: [nidA, nidB].join(',') })
  const byId = Object.fromEntries(st.body.data.notices.map((n) => [n.noticeId, n.state]))
  assert.equal(byId[nidA], 'read')
  assert.equal(byId[nidB], 'queued')
})

test('已读回执：设备不属于该账号 → 403（fail-closed）', async () => {
  const { api } = mkApi()
  const a = await notify(api, baseBody())
  const nid = a.body.data.notices[0].noticeId
  const r = await read(api, { accountDid: ACC_A, noticeIds: [nid] }, {
    authedDid: async () => DEV_DID,
    rootApi: { getRoot: () => ({ devices: [{ pubkeyB64: b64(DEV_PUB), revoked: 1 }] }) },  // 已吊销
  })
  assert.equal(r.status, 403)
})

test('过期：TTL 到点后状态变 expired', async () => {
  const { api, nowRef } = mkApi()
  const r = await notify(api, baseBody({ expiresInMs: TTL_MIN_MS }))
  const nid = r.body.data.notices[0].noticeId
  nowRef.t += TTL_MIN_MS + 1000
  const st = await status(api, { noticeIds: nid })
  assert.equal(st.body.data.notices[0].state, 'expired')
})

test('限流：ratePerSec=2 → 第 3 次 429', async () => {
  const { api } = mkApi({ ratePerSec: 2 })
  assert.equal((await notify(api, baseBody())).status, 200)
  assert.equal((await notify(api, baseBody({ dedupeKey: 'r2' }))).status, 200)
  assert.equal((await notify(api, baseBody({ dedupeKey: 'r3' }))).status, 429)
})

test('持久化：写入磁盘后新建实例能读回通知与状态', async () => {
  const dir = tmpDir()
  const api1 = createOfficialApi({ dir, token: TOKEN, official: OFFICIAL, deposit: () => {}, now: () => 1_800_000_000_000 })
  const r = await notify(api1, baseBody())
  const nid = r.body.data.notices[0].noticeId
  const api2 = createOfficialApi({ dir, token: TOKEN, official: OFFICIAL, deposit: () => {}, now: () => 1_800_000_100_000 })
  const st = await status(api2, { noticeIds: nid })
  assert.equal(st.body.data.notices.length, 1)
  assert.equal(st.body.data.notices[0].noticeId, nid)
})

test('info：公开返回官方 did/名字/公钥（客户端内置好友与验签用）', async () => {
  const { api } = mkApi()
  const { out, send } = mkSend()
  api.handleGet('/official/info', new URLSearchParams(), {}, send)
  assert.equal(out.status, 200)
  assert.equal(out.body.data.did, OFFICIAL.did)
  assert.equal(out.body.data.name, '小灵')
  assert.equal(out.body.data.pubkeyB64, b64(ROOT_PUB), 'root 公钥')
  assert.equal(out.body.data.devices[0].pubkeyB64, b64(PUSH_PUB), '通知签名设备钥')
})

test('status 排序修复：limit 截断的是最新 N 条（不是最老）', async () => {
  const { api, nowRef } = mkApi()
  const ids = []
  for (let i = 0; i < 3; i++) {
    nowRef.t += 1000
    const r = await notify(api, baseBody({ title: `排序 ${i}`, dedupeKey: `sort:${i}` }))
    ids.push(r.body.data.notices[0].noticeId)
  }
  const st = await status(api, { limit: '2' })
  assert.equal(st.body.data.count, 2)
  assert.deepEqual(st.body.data.notices.map((n) => n.noticeId), [ids[2], ids[1]], '最新两条，倒序')
})

test('pending：queued→delivered（真触达证据）+ 未读可补投（信封形状/签名可验）；read 后不再返回', async () => {
  const { api, nowRef } = mkApi()
  const r = await notify(api, baseBody())
  const nid = r.body.data.notices[0].noticeId
  const pending = async (body) => {
    const { out, send } = mkSend()
    await api.handlePost('/official/pending', JSON.stringify(body ?? {}), 'auth', body, send, {
      authedDid: async () => DEV_DID,
      rootApi: { getRoot: () => ({ devices: [{ pubkeyB64: b64(DEV_PUB), revoked: 0 }] }) },
    })
    return out
  }
  // 新版客户端第一次拉取：queued 也能拿到（同时标记 delivered/card-v1）
  let p = await pending({ accountDid: ACC_A, client: { version: '0.3.142', caps: ['official-card-v1'] } })
  assert.equal(p.status, 200)
  assert.equal(p.body.data.count, 1)
  let st = await status(api, { noticeIds: nid })
  assert.equal(st.body.data.notices[0].state, 'delivered')
  assert.equal(st.body.data.notices[0].clientCapability, 'card-v1')
  // delivered 未读仍会补投（幂等，信封形状 + 签名可验）
  nowRef.t += 500
  p = await pending({ accountDid: ACC_A })
  assert.equal(p.body.data.count, 1)
  const msg = p.body.data.msgs[0]
  assert.equal(msg.kind, 'official-notice')
  assert.equal(msg.payload.noticeId, nid)
  assert.equal(msg.from, OFFICIAL.did)
  const pk = await importPublicKey(PUSH_PUB)
  const material = noticeSignMaterial(ACC_A, msg.payload.noticeId, msg.payload.createdAt, msg.payload)
  assert.equal(await verify(pk, new TextEncoder().encode(material), new Uint8Array(Buffer.from(msg.payload.sigB64, 'base64'))), true)
  // 已读后不再补投
  await read(api, { accountDid: ACC_A, noticeIds: [nid] })
  p = await pending({ accountDid: ACC_A })
  assert.equal(p.body.data.count, 0)
})

  test('pending：设备不属于账号 → 403（fail-closed）', async () => {
  const { api } = mkApi()
  const { out, send } = mkSend()
  await api.handlePost('/official/pending', '{}', 'auth', { accountDid: ACC_A }, send, {
    authedDid: async () => DEV_DID,
    rootApi: { getRoot: () => ({ devices: [] }) },
  })
  assert.equal(out.status, 403)
})