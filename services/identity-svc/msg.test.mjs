// msg.test.mjs — 好友聊天中转信箱端点单测（node --test，第81轮）。
// 路由处理函数直调（send 捕获，照 delegation.test.mjs 风格）；验签注入 stub
// ——本测只测信箱逻辑（路由/限流/扇出/ACK 语义），签名链路由 presence 同款 authedDid 覆盖。
// 文件级副作用：msg-inbox.json 会写真实文件（模块内常量路径），已入 .gitignore；测试尾清空。
// 2026-11-12 开源整改：模块支持 MSG_INBOX_PATH 覆盖，单测改指临时目录，不再污染仓内工作树。
import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { base58Encode, didFromPublicKey } from './identity/did.mjs'

process.env.MSG_INBOX_PATH = join(mkdtempSync(join(tmpdir(), 'myco-inbox-test-')), 'msg-inbox.json')
const { handleMsgPost, MSG_ROUTES, __test } = await import('./msg.mjs')

// 固定种子真算 did（2026-10-10 canonical-only 收敛：账号 did 也须 canonical z 形态——
// 此前用裸公钥 base58 legacy 形态当合法输入，收敛后会被 400 拒，全部改 canonical）
const didOf = (hex, method) => didFromPublicKey(Buffer.from(hex, 'hex')).replace('did:myco:', `${method}:`)
// 设备 did 必须用 canonical 形态：产线 authedDid 验签后返回 normalizeDid 归一串
// （identity-server.mjs「canonical 归一串——presence/信箱/msg 等内存键统一同一桶」），
// msg.mjs 群管理归属校验也拿 canonical 比较（didFromPublicKey 默认 canonical）。
// 2026-10-07 修：此前 stub 用 legacy 裸 b58 形态，合法用例被误判 403——本文件
// 唯一常红的根源（红着的时候真回归反而看不见）。
const DEV = didFromPublicKey(Buffer.from('11'.repeat(32), 'hex'))
const ACC_A = didOf('22'.repeat(32), 'did:youling') // 收件人 A（账号 did）
const ACC_B = didOf('33'.repeat(32), 'did:youling') // 收件人 B（账号 did）
const ctx = { authedDid: async () => DEV }

function mkSend() {
  const out = { status: 0, body: null }
  return { send: (status, body) => { out.status = status; out.body = body }, out }
}
const send1 = async (body, authHeader = 'x', dev = DEV) => {
  const { send, out } = mkSend()
  await handleMsgPost('/msg/send', JSON.stringify(body ?? {}), authHeader, body, send, { authedDid: async () => dev })
  return out
}
const poll = async (accountDid) => {
  const { send, out } = mkSend()
  await handleMsgPost('/msg/poll', JSON.stringify({ accountDid }), 'x', { accountDid }, send, ctx)
  return out
}

test('routes 表完整 + kind 白名单（2026-10-07 好友去服务端化：握手三 kind 回归信箱）', () => {
  assert.ok(MSG_ROUTES.has('/msg/send'))
  assert.ok(MSG_ROUTES.has('/msg/poll'))
  // 在白名单：群建卡 + 群管理五操作（第85轮；b597d04 曾漏收致群管理 400，本轮修复）
  // 批二（2026-09-28）：+group-disband（群主退群=解散）
  for (const k of ['group-create', 'group-invite', 'group-rename', 'group-leave', 'group-kick', 'group-mute', 'group-disband']) {
    assert.ok(__test.MSG_KINDS.has(k), k)
  }
  // 好友去服务端化（2026-10-07）：好友握手三 kind 回归信箱（对端离线时的兜底中转；
  // 服务器不裁决，防冒充校验在接收端——第86轮曾移出，本轮随 friends.mjs 删除加回）
  for (const k of ['friend-request', 'friend-accept', 'friend-remove']) {
    assert.ok(__test.MSG_KINDS.has(k), k)
  }
  // 仍收窄：聊天正文/任务卡全部拒绝（走 P2P 直连）
  for (const k of ['text', 'image', 'file', 'group-msg', 'task-share', 'task-accept', 'task-done']) {
    assert.ok(!__test.MSG_KINDS.has(k), k)
  }
})

test('好友握手信箱中转（去服务端化）：friend-request/accept/remove 投递→拉走即删，信封不拆不改', async () => {
  __test.inbox.delete(ACC_A); __test.inbox.delete(ACC_B)
  // A 设备向 B 发好友请求（payload 为端侧签名握手材料，服务器原样中转）
  const req = {
    fromAccountDid: ACC_A, fromName: '甲', toAccountDid: ACC_B, kind: 'friend-request',
    payload: { to: ACC_B, nonce: 'n-1', sig: 'sig-1', name: '甲' }, msgId: 'fr-1', ts: 12345,
  }
  const s1 = await send1(req)
  assert.equal(s1.status, 200)
  assert.equal(s1.body.data.delivered, 1)
  // B 的回执同链路
  const s2 = await send1({
    fromAccountDid: ACC_B, fromName: '乙', toAccountDid: ACC_A, kind: 'friend-accept',
    payload: { to: ACC_A, nonce: 'n-2', sig: 'sig-2' }, msgId: 'fa-1', ts: 12346,
  })
  assert.equal(s2.status, 200)
  // B 拉信箱：request 信封逐字段完好（id=发送 msgId；fromDevice=验签盖戳设备）
  const pb = await poll(ACC_B)
  assert.equal(pb.body.data.msgs.length, 1)
  const mb = pb.body.data.msgs[0]
  assert.equal(mb.id, 'fr-1')
  assert.equal(mb.kind, 'friend-request')
  assert.equal(mb.from, ACC_A)
  assert.equal(mb.fromName, '甲')
  assert.equal(mb.fromDevice, DEV)
  assert.equal(mb.ts, 12345)
  assert.deepEqual(mb.payload, { to: ACC_B, nonce: 'n-1', sig: 'sig-1', name: '甲' })
  // A 拉信箱：accept 到达；再拉双空（ACK 语义）
  const pa = await poll(ACC_A)
  assert.equal(pa.body.data.msgs.length, 1)
  assert.equal(pa.body.data.msgs[0].kind, 'friend-accept')
  assert.equal((await poll(ACC_A)).body.data.msgs.length, 0)
  assert.equal((await poll(ACC_B)).body.data.msgs.length, 0)
  // friend-remove 同样放行（删除/拒绝共用的收敛消息）
  const s3 = await send1({
    fromAccountDid: ACC_A, toAccountDid: ACC_B, kind: 'friend-remove',
    payload: { to: ACC_B, nonce: 'n-3', sig: 'sig-3' }, msgId: 'frm-1', ts: 12347,
  })
  assert.equal(s3.status, 200)
  assert.equal((await poll(ACC_B)).body.data.msgs.length, 1)
})

test('send → poll 拉走即删（ACK 语义）；from/fromDevice 信封', async () => {
  __test.inbox.delete(ACC_A)
  const s = await send1({ fromAccountDid: ACC_B, fromName: 'B', toAccountDid: ACC_A, kind: 'group-create', payload: { text: '你好' }, msgId: 'm-1', ts: 1 })
  assert.equal(s.status, 200)
  assert.equal(s.body.data.delivered, 1)
  const p = await poll(ACC_A)
  assert.equal(p.status, 200)
  assert.equal(p.body.data.msgs.length, 1)
  const m = p.body.data.msgs[0]
  assert.equal(m.id, 'm-1')
  assert.equal(m.from, ACC_B)       // 好友锚=账号 did
  assert.equal(m.fromDevice, DEV)   // 服务端验签盖戳的设备 did
  assert.equal(m.payload.text, '你好')
  // 再 poll 空（已删）
  const p2 = await poll(ACC_A)
  assert.equal(p2.body.data.msgs.length, 0)
})

test('未注册/坏签名 → 403', async () => {
  const { send, out } = mkSend()
  await handleMsgPost('/msg/send', '{}', 'bad', {}, send, { authedDid: async () => null })
  assert.equal(out.status, 403)
})

test('未知 kind / 缺 msgId / 坏 toAccountDid → 400；payload 超 3MB → 413', async () => {
  assert.equal((await send1({ toAccountDid: ACC_A, kind: 'nope', payload: {}, msgId: 'x' })).status, 400)
  assert.equal((await send1({ toAccountDid: ACC_A, kind: 'text', payload: {}, ts: 1 })).status, 400) // 第84轮：正文 kind 服务器拒收
  assert.equal((await send1({ toAccountDid: 'not-a-did', kind: 'group-create', payload: {}, msgId: 'x' })).status, 400)
  const big = await send1({ toAccountDid: ACC_A, kind: 'group-create', payload: { b64: 'A'.repeat(3 * 1024 * 1024 + 10) }, msgId: 'big' })
  assert.equal(big.status, 413)
})

test('群建卡扇出：payload.members[] 逐成员投递，发送者除外（群正文已走 P2P）', async () => {
  __test.inbox.delete(ACC_A); __test.inbox.delete(ACC_B)
  const s = await send1({
    fromAccountDid: ACC_B, fromName: '建群人', toAccountDid: ACC_A, kind: 'group-create',
    payload: { groupId: 'g1', groupName: '测试群', fromName: 'B', members: [ACC_A, ACC_B, 'not-a-did'] },
    msgId: 'gm-1', ts: 1,
  })
  assert.equal(s.status, 200)
  assert.equal(s.body.data.delivered, 1) // A 收到；B(发送者)与非法 did 不投
  const pa = await poll(ACC_A)
  assert.equal(pa.body.data.msgs.length, 1)
  assert.equal(pa.body.data.msgs[0].payload.groupId, 'g1')
  const pb = await poll(ACC_B)
  assert.equal(pb.body.data.msgs.length, 0)
})

test('群 kind 的 toAccountDid=groupId（非 did）放行——名义目标，真名单在 members[]', async () => {
  __test.inbox.delete(ACC_A)
  const s = await send1({
    fromAccountDid: ACC_B, toAccountDid: 'grp-abc123', kind: 'group-create',
    payload: { groupId: 'grp-abc123', groupName: 'g', members: [ACC_A] },
    msgId: 'gm-2', ts: 2,
  })
  assert.equal(s.status, 200)
  const p = await poll(ACC_A)
  assert.equal(p.body.data.msgs.length, 1)
  // 非群 kind 仍严格要求 did 格式
  const bad = await send1({ toAccountDid: 'grp-abc123', kind: 'group-create', payload: { text: 'x' }, msgId: 't-1' })
  assert.equal(bad.status, 400)
})

test('第85轮：群管理 kind 的设备归属校验——签名设备不属于声称账号 → 403', async () => {
  __test.inbox.delete(ACC_A)
  // stub rootApi：ACC_B 名下有 DEV 设备（roster 存裸公钥 b64；msg.mjs 从 pubkeyB64
  // 重建 canonical did 与 fromDevice（authedDid 返回的归一串）比较）
  const { base58Encode } = await import('./identity/did.mjs')
  const devPubB64 = Buffer.from('11'.repeat(32), 'hex').toString('base64')
  const rootApi = { getRoot: (did) => did === ACC_B ? { devices: [{ pubkeyB64: devPubB64, revoked: 0 }] } : null }
  const sendAdmin = async (kind, body2) => {
    const { send, out } = mkSend()
    await handleMsgPost('/msg/send', JSON.stringify(body2), 'x', body2, send, { authedDid: async () => DEV, rootApi })
    return out
  }
  // 合法：DEV 确实属于 ACC_B
  const ok = await sendAdmin('group-invite', { fromAccountDid: ACC_B, toAccountDid: ACC_A, kind: 'group-invite', payload: { groupId: 'g1', members: [ACC_A] }, msgId: 'gi-1' })
  assert.equal(ok.status, 200)
  // 伪造：声称 from=ACC_A（群主），但签名设备属于 ACC_B → 403
  const forged = await sendAdmin('group-kick', { fromAccountDid: ACC_A, toAccountDid: ACC_A, kind: 'group-kick', payload: { groupId: 'g1', targetDid: ACC_B }, msgId: 'gk-1' })
  assert.equal(forged.status, 403)
  // 批二：group-disband 同属管理 kind——合法放行 / 伪造 403
  const okDisband = await sendAdmin('group-disband', { fromAccountDid: ACC_B, toAccountDid: ACC_A, kind: 'group-disband', payload: { groupId: 'g1' }, msgId: 'gd-1' })
  assert.equal(okDisband.status, 200)
  const forgedDisband = await sendAdmin('group-disband', { fromAccountDid: ACC_A, toAccountDid: ACC_A, kind: 'group-disband', payload: { groupId: 'g1' }, msgId: 'gd-2' })
  assert.equal(forgedDisband.status, 403)
})

test('每账号 500 条上限，超限丢最老', async () => {
  __test.inbox.delete(ACC_A)
  for (let i = 0; i < __test.INBOX_CAP + 2; i++) {
    await send1({ fromAccountDid: ACC_B, toAccountDid: ACC_A, kind: 'group-create', payload: { text: String(i) }, msgId: `cap-${i}`, ts: i })
  }
  const p = await poll(ACC_A)
  assert.equal(p.body.data.msgs.length, __test.INBOX_CAP)
  assert.equal(p.body.data.msgs[0].id, 'cap-2') // 最老两条被挤掉
  assert.equal(p.body.data.msgs[p.body.data.msgs.length - 1].id, `cap-${__test.INBOX_CAP + 1}`)
})

test('30 天 TTL：过期条目 sweep 清除', async () => {
  __test.inbox.set(ACC_A, [{ seq: 1, id: 'old', from: ACC_B, kind: 'group-create', payload: {}, ts: Date.now() - 31 * 24 * 3600_000 }])
  __test.sweep()
  assert.equal(__test.inbox.has(ACC_A), false)
})

test('did 形态校验：myco/youling 双 method 收 canonical，裸串拒', () => {
  assert.ok(__test.msgDidOk(DEV))
  assert.ok(__test.msgDidOk(ACC_A))
  assert.ok(!__test.msgDidOk('did:youling:short'))
  assert.ok(!__test.msgDidOk('hello'))
})

test('poll 坏 accountDid → 400', async () => {
  assert.equal((await poll('xxx')).status, 400)
})

// ══ 2026-10-10 canonical-only 收敛（红绿双证）══
test('legacy 裸 base58 did 一律 400「不支持的 did 格式」（红：legacy 拒）', async () => {
  const legacyAcc = 'did:youling:' + base58Encode(Buffer.from('44'.repeat(32), 'hex'))
  // send 的 toAccountDid 是 legacy → 400
  const r1 = await send1({ fromAccountDid: ACC_A, toAccountDid: legacyAcc, kind: 'friend-request', payload: {}, msgId: 'lg-1', ts: Date.now() })
  assert.equal(r1.status, 400, JSON.stringify(r1.body))
  assert.ok(String(r1.body?.error).includes('不支持的 did 格式'), `统一文案: ${JSON.stringify(r1.body)}`)
  // send 的 fromAccountDid 是 legacy → 400
  const r2 = await send1({ fromAccountDid: legacyAcc, toAccountDid: ACC_B, kind: 'friend-request', payload: {}, msgId: 'lg-2', ts: Date.now() })
  assert.equal(r2.status, 400, JSON.stringify(r2.body))
  assert.ok(String(r2.body?.error).includes('不支持的 did 格式'), JSON.stringify(r2.body))
  // poll 的 accountDid 是 legacy → 400
  const r3 = await poll(legacyAcc)
  assert.equal(r3.status, 400, JSON.stringify(r3.body))
  assert.ok(String(r3.body?.error).includes('不支持的 did 格式'), JSON.stringify(r3.body))
  // msgDidOk 纯函数红证
  assert.ok(!__test.msgDidOk(legacyAcc), 'legacy 串 msgDidOk 应 false')
})

test('canonical 对照仍通（绿：canonical 通过）', async () => {
  __test.inbox.delete(ACC_B)
  const ok1 = await send1({ fromAccountDid: ACC_A, toAccountDid: ACC_B, kind: 'friend-request', payload: { sig: 'x' }, msgId: 'canon-ok-1', ts: Date.now() })
  assert.equal(ok1.status, 200, JSON.stringify(ok1.body))
  const p = await poll(ACC_B)
  assert.equal((p.body?.data?.msgs || []).length, 1, JSON.stringify(p.body))
})

// 收尾：清测试落盘副作用（信箱内容与 msg-inbox.json），幂等不影响下一轮
test('清理', () => {
  __test.inbox.clear()
  try { rmSync(__test.INBOX_STORE) } catch { /* 不存在即过 */ }
})
