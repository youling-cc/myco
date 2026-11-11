// official-read.test.mjs — /official/read 双鉴权（平台代读 TD-021~025）+ 多 token 单测（node --test）
// 2026-10-24 有灵myco：任务直达卡实现批第①步（identity-svc）。
// 口径来源：repo-b/eval/task-dispatch/task.md v1.3 §C 组 + 契约 §9.1（平台设计页 v0.2）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createOfficialApi } = await import('./official.mjs')

const FIXED = 1_793_000_000_000 // 固定时钟（expiresAt 相对它算）
const now = () => FIXED
const DID = 'did:youling:z6Mktest000000000000000000000000000000000000000Qm'

function mkApi({ fileTokens, optToken, ratePerSec = 1000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'official-read-'))
  if (fileTokens) writeFileSync(join(dir, 'official-token.txt'), fileTokens.join('\n') + '\n')
  const api = createOfficialApi({
    dir, token: optToken, now, ratePerSec, deposit: () => {},
    urlHosts: ['www.youling.cc'], official: undefined, // 读路径不依赖官方账号配置
  })
  return { api, dir }
}

/** 直接播种一条 notice（绕过 notify 的签名链路——那是 E2E 的事） */
function seed(api, { noticeId, dedupeKey, state, did = DID, expiresAt = FIXED + 600_000 }) {
  api.__test.notices.set(noticeId, {
    noticeId, did, dedupeKey, state, createdAt: FIXED - 1000, expiresAt,
    title: '有新题可做', body: 'b', category: 'task.dispatch',
  })
  api.__test.dedupe.set(`${did}|${dedupeKey}`, noticeId)
}

function last(send) { return send.calls[send.calls.length - 1] }
function mkSend() {
  const s = (code, obj) => { s.calls.push({ code, obj }); return obj }
  s.calls = []
  return s
}

test('TD-021 平台代读：delivered → read（带 prevState/readAt）', async () => {
  const { api, dir } = mkApi({ fileTokens: ['tokA', 'tokB'] })
  seed(api, { noticeId: 'ntc-1', dedupeKey: 'dispatch-t1-i1', state: 'delivered' })
  const send = mkSend()
  await api.handlePost('/official/read', '', '', { did: DID, dedupeKey: 'dispatch-t1-i1' }, send, { headers: { 'x-official-token': 'tokB' } })
  const r = last(send)
  assert.equal(r.code, 200)
  assert.deepEqual(r.obj.data, { matched: 1, noticeId: 'ntc-1', prevState: 'delivered', state: 'read' })
  const n = api.__test.notices.get('ntc-1')
  assert.equal(n.state, 'read'); assert.equal(n.readAt, FIXED); assert.ok(n.deliveredAt)
  rmSync(dir, { recursive: true, force: true })
})

test('TD-024 边界：queued 直置 read（未投递也可被平台代读）', async () => {
  const { api, dir } = mkApi({ fileTokens: ['tokA'] })
  seed(api, { noticeId: 'ntc-2', dedupeKey: 'dispatch-t2-i2', state: 'queued' })
  const send = mkSend()
  await api.handlePost('/official/read', '', '', { did: DID, dedupeKey: 'dispatch-t2-i2' }, send, { headers: { 'x-official-token': 'tokA' } })
  const r = last(send)
  assert.equal(r.obj.data.prevState, 'queued')
  assert.equal(r.obj.data.state, 'read')
  assert.equal(api.__test.notices.get('ntc-2').deliveredAt, FIXED) // 补投递戳
  rmSync(dir, { recursive: true, force: true })
})

test('TD-025a 未命中 dedupeKey → 幂等 200 matched:0（绝不 4xx）', async () => {
  const { api, dir } = mkApi({ fileTokens: ['tokA'] })
  const send = mkSend()
  await api.handlePost('/official/read', '', '', { did: DID, dedupeKey: 'nope' }, send, { headers: { 'x-official-token': 'tokA' } })
  assert.deepEqual(last(send).obj.data, { matched: 0 })
  rmSync(dir, { recursive: true, force: true })
})

test('TD-025b 重复 read → already:true（幂等）', async () => {
  const { api, dir } = mkApi({ fileTokens: ['tokA'] })
  seed(api, { noticeId: 'ntc-3', dedupeKey: 'dispatch-t3-i3', state: 'read' })
  const send = mkSend()
  await api.handlePost('/official/read', '', '', { did: DID, dedupeKey: 'dispatch-t3-i3' }, send, { headers: { 'x-official-token': 'tokA' } })
  const d = last(send).obj.data
  assert.equal(d.matched, 1); assert.equal(d.state, 'read'); assert.equal(d.already, true)
  rmSync(dir, { recursive: true, force: true })
})

test('TD-025c 错 token → 401（有 token 头绝不回落签名模式）', async () => {
  const { api, dir } = mkApi({ fileTokens: ['tokA'] })
  const send = mkSend()
  await api.handlePost('/official/read', '', '', { did: DID, dedupeKey: 'x' }, send, { headers: { 'x-official-token': 'evil' } })
  assert.equal(last(send).code, 401)
  rmSync(dir, { recursive: true, force: true })
})

test('TD-025d 缺参 → 400', async () => {
  const { api, dir } = mkApi({ fileTokens: ['tokA'] })
  const send = mkSend()
  await api.handlePost('/official/read', '', '', { dedupeKey: 'x' }, send, { headers: { 'x-official-token': 'tokA' } })
  assert.equal(last(send).code, 400)
  rmSync(dir, { recursive: true, force: true })
})

test('过期 notice → matched:1 state:expired，不置读', async () => {
  const { api, dir } = mkApi({ fileTokens: ['tokA'] })
  seed(api, { noticeId: 'ntc-4', dedupeKey: 'dispatch-t4-i4', state: 'delivered', expiresAt: FIXED - 1 })
  const send = mkSend()
  await api.handlePost('/official/read', '', '', { did: DID, dedupeKey: 'dispatch-t4-i4' }, send, { headers: { 'x-official-token': 'tokA' } })
  const d = last(send).obj.data
  assert.equal(d.state, 'expired')
  assert.equal(api.__test.notices.get('ntc-4').state, 'delivered') // 未被置读
  rmSync(dir, { recursive: true, force: true })
})

test('多 token：文件每行一个（含注释/空行），任一可用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'official-read-'))
  writeFileSync(join(dir, 'official-token.txt'), '# 2026-10-24 联调 token\nsupply-ops-token\n\nlegacy-token\n')
  const api = createOfficialApi({ dir, now, ratePerSec: 1000, deposit: () => {}, urlHosts: ['www.youling.cc'] })
  for (const tk of ['supply-ops-token', 'legacy-token']) {
    const send = mkSend()
    await api.handlePost('/official/read', '', '', { did: DID, dedupeKey: 'x' }, send, { headers: { 'x-official-token': tk } })
    assert.equal(last(send).code, 200, `token ${tk} 应可用`)
  }
  const send3 = mkSend()
  await api.handlePost('/official/read', '', '', { did: DID, dedupeKey: 'x' }, send3, { headers: { 'x-official-token': 'unknown' } })
  assert.equal(last(send3).code, 401)
  rmSync(dir, { recursive: true, force: true })
})

test('限流：超过 ratePerSec → 429（与 notify 同桶）', async () => {
  const { api, dir } = mkApi({ fileTokens: ['tokA'], ratePerSec: 3 })
  const send = mkSend()
  const codes = []
  for (let i = 0; i < 5; i++) {
    await api.handlePost('/official/read', '', '', { did: DID, dedupeKey: 'x' }, send, { headers: { 'x-official-token': 'tokA' } })
    codes.push(last(send).code)
  }
  assert.ok(codes.includes(429), `应出现 429：${codes.join(',')}`)
  rmSync(dir, { recursive: true, force: true })
})

test('回归：无 token 头 → 路由进既有设备签名模式（不落 token 分支）', async () => {
  const { api, dir } = mkApi({ fileTokens: ['tokA'] })
  const send = mkSend()
  // 无 x-official-token 头 → handleRead 走 verifySignedAccount；合成 ctx 缺 authedDid 注入
  // → 恒定 500「官方通道缺 authedDid 注入」。这个错误正是"进了签名分支"的确定性证据
  // （若误入 token 分支，会得到 200 matched:0 / 401 token 错——都不含 authedDid 字样）。
  await api.handlePost('/official/read', '{}', '', { accountDid: DID, noticeIds: ['ntc-1'] }, send, {})
  const r = last(send)
  assert.equal(r.code, 500)
  assert.match(r.obj.error, /authedDid/)
  rmSync(dir, { recursive: true, force: true })
})
