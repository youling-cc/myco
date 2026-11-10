// root.concurrency.e2e.test.mjs — 活服务器边界回归（2026-10-07 myco 功能面广度测试沉淀）。
// 与既有 *.test.mjs（路由函数直调）不同：本文件起真 identity-server 子进程（随机端口
// +临时 DB，presence.test 同款），覆盖只有活服务器才暴露的面：
//   ① 并发 create 同 did——恰一 201、其余 409 did_conflict、零 5xx（SQLite 并发写
//     race 由 rootDid 主键兜底，root.mjs 2026-10-07 注释承诺，此处活体锁死）；
//   ② /root/create 格式闸门 fuzz——15 类畸形 rootDid 全 4xx 绝不 5xx（family 残留
//     回归的活服务器面：9e0d635 曾 ReferenceError→500）；
//   ③ 信箱真链往返——/msg/send 投递 → /msg/poll 拉走即删 + fromDevice 验签盖戳。
// （presence 90s TTL 出表活体验证过一轮 pass——太慢不入常驻套件；语义由
//   identity-server.mjs PRESENCE_TTL=90_000 常量+过滤实现保证。）
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPair, exportPublicKeyRaw, sign } from './identity/crypto.mjs'
import { didFromPublicKey, base58Encode } from './identity/did.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
// 与 presence.test 的 18300-19199 随机段错开（node --test 文件级并行，双服务器不能撞口）
const PORT = 19300 + Math.floor(Math.random() * 500)
const BASE = `http://127.0.0.1:${PORT}`
const tmp = mkdtempSync(join(tmpdir(), 'myco-conc-e2e-'))
const b64 = (b) => Buffer.from(b).toString('base64')
const enc = new TextEncoder()

const kp = await generateKeyPair()
const pubRaw = new Uint8Array(await exportPublicKeyRaw(kp.publicKey))
const DID = didFromPublicKey(pubRaw)

async function signedPost(path, payload) {
  const raw = JSON.stringify(payload)
  const ts = Date.now()
  const sig = await sign(kp.privateKey, enc.encode(`${DID}\n${ts}\n${raw}`))
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Myco-Auth': `${DID}.${ts}.${b64(sig)}` },
    body: raw,
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

let server
test.before(async () => {
  server = spawn(process.execPath, [resolve(__dirname, 'identity-server.mjs')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: join(tmp, 'test.db'), WEB_ROOT: join(tmp, 'web') },
    stdio: 'ignore',
  })
  const deadline = Date.now() + 10_000
  for (;;) {
    try { await fetch(`${BASE}/health`); break } catch {
      if (Date.now() > deadline) throw new Error('identity-server 未在 10s 内就绪')
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  const r = await fetch(`${BASE}/identity/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicKeyB64: b64(pubRaw) }),
  })
  assert.ok([201, 409].includes(r.status), `register status=${r.status}`)
})

test.after(async () => {
  if (server && !server.killed) {
    server.kill()
    await new Promise((r) => { server.once('exit', r); setTimeout(r, 3000) })
  }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
})

test('并发 create 同 did：恰一 201、其余 409 did_conflict、零 5xx', async () => {
  const rk = await generateKeyPair()
  const rpub = new Uint8Array(await exportPublicKeyRaw(rk.publicKey))
  const rootDid = 'did:youling:' + didFromPublicKey(rpub).slice('did:myco:'.length)
  const rootSig = b64(await sign(rk.privateKey, enc.encode(`create\n${rootDid}\n${b64(rpub)}`)))
  const body = { rootDid, rootPubkeyB64: b64(rpub), devicePubkeyB64: b64(pubRaw), name: '并发', rootSig }
  const N = 16
  const rs = await Promise.all(Array.from({ length: N }, () =>
    fetch(`${BASE}/root/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (r) => ({ s: r.status, code: (await r.json().catch(() => null))?.code }))))
  assert.equal(rs.filter((r) => r.s === 201).length, 1, JSON.stringify(rs))
  assert.equal(rs.filter((r) => r.s === 409).length, N - 1, JSON.stringify(rs))
  assert.ok(rs.filter((r) => r.s === 409).every((r) => r.code === 'did_conflict'), JSON.stringify(rs))
  assert.equal(rs.filter((r) => r.s >= 500).length, 0, JSON.stringify(rs))
})

test('格式闸门 fuzz：15 类畸形 rootDid 全 4xx 绝不 5xx', async () => {
  const rk = await generateKeyPair()
  const rpub = new Uint8Array(await exportPublicKeyRaw(rk.publicKey))
  const rpubB64 = b64(rpub)
  const otherPub = new Uint8Array(await exportPublicKeyRaw((await generateKeyPair()).publicKey))
  const otherCanonical = 'did:youling:' + didFromPublicKey(otherPub).slice('did:myco:'.length)
  const mk = async (rootDid) => ({
    rootDid, rootPubkeyB64: rpubB64, devicePubkeyB64: b64(pubRaw), name: 'fuzz',
    rootSig: b64(await sign(rk.privateKey, enc.encode(`create\n${rootDid}\n${rpubB64}`))),
  })
  const cases = [
    ['空 rootDid', await mk(''), null],
    ['空尾', await mk('did:youling:'), null],
    ['单字符尾', await mk('did:youling:z'), null],
    ['超长 1KB', await mk('did:youling:z' + 'a'.repeat(1000)), null],
    ['legacy 裸 b58', await mk('did:youling:' + base58Encode(rpub)), 'unsupported_did_format'],
    ['legacy did:myco 前缀', await mk(didFromPublicKey(rpub)), 'unsupported_did_format'],
    ['合法形态错钥', await mk(otherCanonical), null], // derivation_mismatch（非固定 code，验 error 前缀）
    ['垃圾串', await mk('not-a-did-at-all'), null],
    ['unicode', await mk('did:youling:z你好🔐'), null],
    ['路径穿越', await mk('did:youling:../../etc/passwd'), null],
    ['script 注入', await mk('did:youling:z<script>alert(1)</script>'), null],
    ['空白', await mk('did:youling: z abc '), null],
    ['null 字节', await mk('did:youling:z\u0000abc'), null],
    ['非字符串', { rootDid: 12345, rootPubkeyB64: rpubB64, devicePubkeyB64: b64(pubRaw), rootSig: 'x' }, null],
    ['缺字段', { rootPubkeyB64: rpubB64, devicePubkeyB64: b64(pubRaw), rootSig: 'x' }, null],
  ]
  for (const [name, body, wantCode] of cases) {
    const r = await fetch(`${BASE}/root/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const jb = await r.json().catch(() => null)
    assert.ok(r.status >= 400 && r.status < 500, `${name} 应 4xx，实测 ${r.status}: ${JSON.stringify(jb)}`)
    if (wantCode) assert.equal(jb?.code, wantCode, `${name} code 应 ${wantCode}: ${JSON.stringify(jb)}`)
    if (name === '合法形态错钥') assert.match(String(jb?.error || ''), /^derivation_mismatch/, `${name} 应 derivation_mismatch: ${JSON.stringify(jb)}`)
  }
})

test('信箱真链往返：投递→拉走即删+fromDevice 验签盖戳', async () => {
  // 2026-10-10 canonical-only 收敛：收件账号 did 改 canonical 构造（legacy 裸 b58 已被 msg 闸门拒）
  const ACC = didFromPublicKey(new Uint8Array(32).fill(0x33)).replace('did:myco:', 'did:youling:')
  const s = await signedPost('/msg/send', {
    fromAccountDid: DID, fromName: '探针', toAccountDid: ACC, kind: 'friend-request',
    payload: { to: ACC, nonce: 'np-1', sig: 'sig-x', name: '探针' }, msgId: 'np-m1', ts: Date.now(),
  })
  assert.equal(s.status, 200, JSON.stringify(s))
  assert.equal(s.body?.data?.delivered, 1, JSON.stringify(s.body))
  const p = await signedPost('/msg/poll', { accountDid: ACC })
  const msgs = p.body?.data?.msgs || []
  assert.equal(msgs.length, 1, JSON.stringify(p.body))
  assert.equal(msgs[0].id, 'np-m1')
  assert.equal(msgs[0].fromDevice, DID, 'fromDevice=验签盖戳 canonical 设备 did')
  const p2 = await signedPost('/msg/poll', { accountDid: ACC })
  assert.equal((p2.body?.data?.msgs || []).length, 0, '拉走即删')
})
