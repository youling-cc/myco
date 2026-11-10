// presence.test.mjs — presence state 保留回归（node --test，2026-09-29 灯恢复）。
//
// 回归背景：/presence/register 曾 `state: body.state ?? undefined`——同设备 did 的
// 老客户端/env 应用（不带 state 字段）每次重登记都把 typing/idle/locked 灯状态抹掉，
// 两端 UI 的呼吸灯/橘黄灯因此不可见。修复：无 state 的重登记保留旧值。
//
// 起真服务器子进程（随机端口 + 临时 DB），真签名走完整验签链（非 stub）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPair, exportPublicKeyRaw, sign } from './identity/crypto.mjs'
import { didFromPublicKey } from './identity/did.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PORT = 18300 + Math.floor(Math.random() * 900)
const BASE = `http://127.0.0.1:${PORT}`
const tmp = mkdtempSync(join(tmpdir(), 'myco-presence-test-'))

const kp = await generateKeyPair()
const pubRaw = await exportPublicKeyRaw(kp.publicKey)
const DID = didFromPublicKey(pubRaw)
const b64 = (b) => Buffer.from(b).toString('base64')

async function signedPost(path, payload) {
  const raw = JSON.stringify(payload)
  const ts = Date.now()
  const sig = await sign(kp.privateKey, new TextEncoder().encode(`${DID}\n${ts}\n${raw}`))
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
  // 等端口就绪（最多 10s）
  const deadline = Date.now() + 10_000
  for (;;) {
    try { await fetch(`${BASE}/health`); break } catch {
      if (Date.now() > deadline) throw new Error('identity-server 未在 10s 内就绪')
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  // 注册设备公钥（验签前置）
  const r = await signedPost('/identity/register', { publicKeyB64: b64(pubRaw) })
  assert.ok([201, 409].includes(r.status), `identity/register status=${r.status}`)
})

test.after(async () => {
  if (server && !server.killed) {
    server.kill()
    await new Promise((r) => { server.once('exit', r); setTimeout(r, 3000) }) // 等 DB 句柄释放再清目录
  }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
})

test('无 state 的重登记保留旧 state（灯状态不被老客户端/env 抹掉）', async () => {
  // ① 带 state=typing 登记
  let r = await signedPost('/presence/register', { nodeId: DID, name: 'pc-1', kind: 'pc', state: 'typing' })
  assert.equal(r.status, 200)
  let list = await signedPost('/presence/list', {})
  let me = list.body.data.find((n) => n.did === DID)
  assert.equal(me.state, 'typing')

  // ② 不带 state 重登记（模拟 env/老客户端同 did 重报）→ state 必须保留
  r = await signedPost('/presence/register', { nodeId: DID, name: 'pc-1', kind: 'pc' })
  assert.equal(r.status, 200)
  list = await signedPost('/presence/list', {})
  me = list.body.data.find((n) => n.did === DID)
  assert.equal(me.state, 'typing', '无 state 重登记擦掉了灯状态（回归）')

  // ③ 带新 state=locked 登记 → 正常更新
  r = await signedPost('/presence/register', { nodeId: DID, name: 'pc-1', kind: 'pc', state: 'locked' })
  assert.equal(r.status, 200)
  list = await signedPost('/presence/list', {})
  me = list.body.data.find((n) => n.did === DID)
  assert.equal(me.state, 'locked')
})
