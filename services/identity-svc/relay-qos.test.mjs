// relay-qos.test.mjs — 中继带宽限制（QoS）单测（node --test，零依赖）。
//
// 覆盖（对应 eval/relay/task.md §3.2）：
//   1. 关闭回归：RELAY_QOS_* 全 0 ⇒ 不限速、行为与改造前一致
//   2. 限速正确性：1MB/s 传 3MB ⇒ ≈3s，字节完全一致（sha256）
//   3. 热更新：流中途 1MB/s → 4MB/s，速率提升且连接不断
//   4. 全局上限：4 会话并发时总吞吐不超过全局上限
//   5. 交互小包不被额外排队（burst 内零等待）
//   6. 配置面：env / relay-qos.json / reloadRelayQos
//
// 口径提醒：MB = 1,000,000 字节（十进制），与 task.md §2.0 一致。
// burstMs 默认 100ms：cap = rate×100ms。若把 burst 调得太小（如 20ms），
// cap 会接近单次 socket 读块大小，定时器抖动无法摊薄，实测会掉到 ~0.7MB/s
// （2026-10-23 实测记录，见 relay.mjs highWater() 注释）。

import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRelay, setRelayQos, getRelayQos, reloadRelayQos } from './relay.mjs'

const MB = 1_000_000
const DID = 'did:myco:zQosTestProvider0001'
const DID2 = 'did:myco:zQosTestProvider0002'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 起一个随机口中继（qos 显式传入，避免被本机 env 干扰）。 */
async function mkRelay(qos) {
  const server = createRelay({ port: 0, qos })
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  return { server, port: server.address().port }
}

/** 拨号 + 可选首行；挂 rdr（行/字节读取器）。 */
function attach(sock) {
  let buf = Buffer.alloc(0)
  const waiters = []
  sock.rdr = {
    line: () => new Promise((resolve) => { waiters.push({ line: true, resolve }); pump() }),
    raw: (n) => new Promise((resolve) => { waiters.push({ line: false, n, resolve }); pump() }),
  }
  function pump() {
    while (waiters.length) {
      const w = waiters[0]
      if (w.line) {
        const i = buf.indexOf(0x0a)
        if (i < 0) return
        const out = buf.subarray(0, i).toString('utf8').trim()
        buf = buf.subarray(i + 1)
        waiters.shift()
        w.resolve(out)
      } else {
        if (buf.length < w.n) return
        const out = buf.subarray(0, w.n)
        buf = buf.subarray(w.n)
        waiters.shift()
        w.resolve(out)
      }
    }
  }
  sock.on('data', (c) => { buf = Buffer.concat([buf, c]); pump() })
  return sock
}

function dial(port, line) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      if (line !== undefined) sock.write(line + '\n')
      resolve(sock)
    })
    sock.on('error', reject)
    sock.setNoDelay(true)
    attach(sock)
  })
}

/** 流式接收器：算 sha256 + 字节数 + 首末字节时间戳。 */
function sink(sock) {
  const st = {
    bytes: 0, firstAt: 0, lastAt: 0,
    hash: createHash('sha256'),
    closed: false,
  }
  const waiters = []
  sock.on('close', () => { st.closed = true })
  sock.on('data', (c) => {
    st.hash.update(c)
    st.bytes += c.length
    const now = Date.now()
    if (!st.firstAt) st.firstAt = now
    st.lastAt = now
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (st.bytes >= waiters[i].n) waiters.splice(i, 1)[0].resolve(st)
    }
  })
  st.waitBytes = (n) => new Promise((resolve) => {
    if (st.bytes >= n) return resolve(st)
    waiters.push({ n, resolve })
  })
  st.hex = () => st.hash.copy().digest('hex')
  return st
}

/** 模拟 provider：REGISTER 常连 + 收到 SESSION 就新开连接 ACCEPT。 */
function makeProvider(port, did) {
  const incoming = []
  const waiters = []
  const p = {
    did,
    async start() {
      p.ctl = await dial(port, `REGISTER ${did}`)
      assert.equal(await p.ctl.rdr.line(), 'OK')
      p.loop()
      return p
    },
    async loop() {
      for (;;) {
        const line = await p.ctl.rdr.line().catch(() => null)
        if (line === null) return
        const m = /^SESSION (\S+)$/.exec(line)
        if (!m) continue
        const s = attach(net.connect(port, '127.0.0.1'))
        await new Promise((res) => s.on('connect', res))
        s.write(`ACCEPT ${did} ${m[1]}\n`)
        if (waiters.length) waiters.shift()(s)
        else incoming.push(s)
      }
    },
    next() {
      return new Promise((res) => { if (incoming.length) res(incoming.shift()); else waiters.push(res) })
    },
    stop() { try { p.ctl.end() } catch { /* ignore */ } },
  }
  return p
}

/** 开一条已配对会话，返回 { consumer, prov }。 */
async function openSession(port, provider) {
  const c = attach(net.connect(port, '127.0.0.1'))
  await new Promise((res) => c.on('connect', res))
  c.write(`CONNECT ${provider.did}\n`)
  const prov = await provider.next()
  assert.equal(await c.rdr.line(), 'OK', '配对应成功')
  return { consumer: c, prov }
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

// ── 1. 关闭回归 ──────────────────────────────────────────────────────────────

test('QoS 关闭（全 0）⇒ 不限速、字节一致（改造前行为）', async (t) => {
  const { server, port } = await mkRelay({ globalMbps: 0, perSessionMbps: 0 })
  t.after(() => server.close())
  assert.equal(server.relayStats().qos.enabled, false, '默认必须 enabled=false')
  assert.equal(server.relayStats().qos.globalMbps, 0)
  assert.equal(server.relayStats().qos.perSessionMbps, 0)

  const prov = await makeProvider(port, DID).start()
  t.after(() => prov.stop())
  const { consumer, prov: ps } = await openSession(port, prov)
  t.after(() => { try { consumer.destroy(); ps.destroy() } catch { /* ignore */ } })
  const sk = sink(ps)

  const payload = Buffer.alloc(8 * MB)
  for (let i = 0; i < payload.length; i += 4096) payload[i] = i & 0xff
  const t0 = Date.now()
  consumer.write(payload)
  await sk.waitBytes(payload.length)
  const ms = Date.now() - t0

  assert.equal(sk.hex(), sha(payload), '字节必须完全一致')
  // 关闭时限速器必须零介入：8MB 走 loopback 远快于 1MB/s 的 8s
  assert.ok(ms < 3000, `不限速时 8MB 应在 3s 内完成，实测 ${ms}ms`)
  const st = server.relayStats().qos
  assert.ok(st.bytesTotal >= payload.length, '总字节应被统计')
  assert.equal(st.throttleWaits, 0, '不限速时不应发生任何暂停')
})

// ── 2. 限速精度 ──────────────────────────────────────────────────────────────

test('perSession=1MB/s 传 3MB ⇒ ≈3s 且 sha256 一致', async (t) => {
  const { server, port } = await mkRelay({ globalMbps: 0, perSessionMbps: 1, burstMs: 100 })
  t.after(() => server.close())
  assert.equal(server.relayStats().qos.enabled, true)

  const prov = await makeProvider(port, DID).start()
  t.after(() => prov.stop())
  const { consumer, prov: ps } = await openSession(port, prov)
  t.after(() => { try { consumer.destroy(); ps.destroy() } catch { /* ignore */ } })
  const sk = sink(ps)

  const payload = Buffer.alloc(3 * MB)
  for (let i = 0; i < payload.length; i += 1024) payload[i] = (i * 7) & 0xff

  const t0 = Date.now()
  consumer.write(payload)
  await sk.waitBytes(payload.length)
  const ms = Date.now() - t0
  const mbps = (payload.length / MB) / (ms / 1000)

  assert.equal(sk.hex(), sha(payload), '限速下字节必须完全一致')
  assert.ok(ms >= 2700, `3MB@1MB/s 不应快于 2.7s，实测 ${ms}ms`)
  assert.ok(ms <= 3600, `3MB@1MB/s 不应慢于 3.6s，实测 ${ms}ms`)
  assert.ok(mbps >= 0.85 && mbps <= 1.05, `实测 ${mbps.toFixed(3)}MB/s 应在 [0.85,1.05]`)

  const st = server.relayStats().qos
  assert.ok(st.throttledBytes > 0, '应记录被节流字节')
  assert.ok(st.throttleWaits > 0, '应记录暂停次数')
})

// ── 3. 热更新 ────────────────────────────────────────────────────────────────

test('热更新 1MB/s → 4MB/s：速率提升、连接不断、字节一致', async (t) => {
  const { server, port } = await mkRelay({ globalMbps: 0, perSessionMbps: 1, burstMs: 100 })
  t.after(() => server.close())

  const prov = await makeProvider(port, DID).start()
  t.after(() => prov.stop())
  const { consumer, prov: ps } = await openSession(port, prov)
  t.after(() => { try { consumer.destroy(); ps.destroy() } catch { /* ignore */ } })
  const sk = sink(ps)

  const payload = Buffer.alloc(8 * MB)
  for (let i = 0; i < payload.length; i += 1024) payload[i] = (i * 13) & 0xff

  const t0 = Date.now()
  consumer.write(payload)

  // 跑到 ~1.2s 时热更新（此时约传完 1.2MB）
  await wait(1200)
  const midBytes = sk.bytes
  const applied = server.setRelayQos({ perSessionMbps: 4 })
  const changedAt = Date.now()
  assert.equal(applied.perSessionMbps, 4)

  await sk.waitBytes(payload.length)
  const ms = Date.now() - t0

  assert.equal(sk.hex(), sha(payload), '热更新期间字节不能丢/错序')
  assert.equal(sk.closed, false, '热更新不能断开现有会话')
  // 1MB/s 全程需 8s；1→4 后应在 4.5s 内完成
  assert.ok(ms < 4500, `热更新后应显著加速（实测 ${ms}ms，纯 1MB/s 需 ~8000ms）`)
  assert.ok(ms > 1700, '不应瞬间完成（说明限流仍在生效）')

  // 变更后的平均速率应 ≥2.5MB/s（1MB/s 段 + 4MB/s 段的混合）
  const afterMb = ((payload.length - midBytes) / MB) / ((Date.now() - changedAt) / 1000)
  assert.ok(afterMb >= 2.5, `变更后平均速率 ${afterMb.toFixed(2)}MB/s 应 ≥2.5`)
  assert.equal(server.relayStats().qos.perSessionMbps, 4)
})

// ── 4. 全局上限 ──────────────────────────────────────────────────────────────

test('global=1MB/s：4 会话并发总吞吐不超全局上限', async (t) => {
  const { server, port } = await mkRelay({ globalMbps: 1, perSessionMbps: 0, burstMs: 100 })
  t.after(() => server.close())

  const prov = await makeProvider(port, DID2).start()
  t.after(() => prov.stop())

  const N = 4
  const each = 1 * MB
  const pairs = []
  for (let i = 0; i < N; i++) pairs.push(await openSession(port, prov))
  t.after(() => pairs.forEach((p) => {
    try { p.consumer.destroy(); p.prov.destroy() } catch { /* ignore */ }
  }))

  const sinks = pairs.map((p) => sink(p.prov))
  const payloads = pairs.map((_, i) => {
    const b = Buffer.alloc(each)
    b.fill(i + 1)
    return b
  })

  const t0 = Date.now()
  pairs.forEach((p, i) => p.consumer.write(payloads[i]))
  await Promise.all(sinks.map((s) => s.waitBytes(each)))
  const ms = Date.now() - t0

  const totalMb = (N * each) / MB
  const mbps = totalMb / (ms / 1000)
  sinks.forEach((s, i) => assert.equal(s.hex(), sha(payloads[i]), `会话 ${i} 字节必须一致`))
  assert.ok(mbps >= 0.85 && mbps <= 1.05, `全局总吞吐 ${mbps.toFixed(3)}MB/s 应在 [0.85,1.05]`)
  sinks.forEach((s, i) => assert.equal(s.bytes, each, `会话 ${i} 收全`))
})

// ── 5. 交互小包不被额外排队 ──────────────────────────────────────────────────

test('限速生效时小包往返仍近零排队（burst 内直通）', async (t) => {
  const { server, port } = await mkRelay({ globalMbps: 0, perSessionMbps: 1, burstMs: 100 })
  t.after(() => server.close())

  const prov = await makeProvider(port, DID).start()
  t.after(() => prov.stop())
  const { consumer, prov: ps } = await openSession(port, prov)
  t.after(() => { try { consumer.destroy(); ps.destroy() } catch { /* ignore */ } })

  // provider 侧回声
  ps.on('data', (c) => ps.write(c))

  const rtts = []
  for (let i = 0; i < 120; i++) {
    const t0 = Date.now()
    consumer.write(Buffer.from('x'.repeat(64)))
    await consumer.rdr.raw(64)
    rtts.push(Date.now() - t0)
    await wait(5)
  }
  rtts.sort((a, b) => a - b)
  const p95 = rtts[Math.floor(0.95 * rtts.length)]
  assert.ok(p95 <= 20, `限速下 64B 往返 p95 应 ≤20ms（实测 ${p95}ms）——burst 就是为它留的`)
})

// ── 6. 配置面 ────────────────────────────────────────────────────────────────

test('env 配置：RELAY_QOS_* 生效且 source=env', async (t) => {
  const old = {
    g: process.env.RELAY_QOS_LIMIT_MBPS,
    p: process.env.RELAY_QOS_PER_SESSION_MBPS,
    b: process.env.RELAY_QOS_BURST_MS,
    f: process.env.RELAY_QOS_FILE,
  }
  process.env.RELAY_QOS_LIMIT_MBPS = '2'
  process.env.RELAY_QOS_PER_SESSION_MBPS = '1'
  process.env.RELAY_QOS_BURST_MS = '50'
  delete process.env.RELAY_QOS_FILE
  let server
  try {
    server = createRelay({ port: 0 })
    await new Promise((res) => server.listen(0, '127.0.0.1', res))
    const q = server.relayQos()
    assert.equal(q.globalMbps, 2)
    assert.equal(q.perSessionMbps, 1)
    assert.equal(q.burstMs, 50)
    assert.equal(q.source, 'env')
  } finally {
    try { server?.close() } catch { /* ignore */ }
    const restore = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    restore('RELAY_QOS_LIMIT_MBPS', old.g)
    restore('RELAY_QOS_PER_SESSION_MBPS', old.p)
    restore('RELAY_QOS_BURST_MS', old.b)
    restore('RELAY_QOS_FILE', old.f)
  }
})

test('非法配置值 ⇒ 退回 0（绝不悄悄限速）', async (t) => {
  const { server } = await mkRelay({ globalMbps: -5, perSessionMbps: Number.NaN, burstMs: 0 })
  t.after(() => server.close())
  const q = server.relayQos()
  assert.equal(q.globalMbps, 0)
  assert.equal(q.perSessionMbps, 0)
  assert.equal(q.burstMs, 100, 'burstMs 非法值退回默认 100')
  assert.equal(server.relayStats().qos.enabled, false)
})

test('relay-qos.json 读取 + reloadRelayQos 热重载（解析失败保持旧值）', async (t) => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'relay-qos-'))
  const file = join(dir, 'relay-qos.json')
  fs.writeFileSync(file, JSON.stringify({ globalMbps: 3, perSessionMbps: 1, burstMs: 30 }))
  const old = {
    g: process.env.RELAY_QOS_LIMIT_MBPS,
    p: process.env.RELAY_QOS_PER_SESSION_MBPS,
    f: process.env.RELAY_QOS_FILE,
  }
  delete process.env.RELAY_QOS_LIMIT_MBPS
  delete process.env.RELAY_QOS_PER_SESSION_MBPS
  process.env.RELAY_QOS_FILE = file
  let server
  try {
    server = createRelay({ port: 0 })
    await new Promise((res) => server.listen(0, '127.0.0.1', res))
    assert.equal(server.relayQos().globalMbps, 3)
    assert.equal(server.relayQos().source, 'file')

    // 改文件 → reload 生效
    fs.writeFileSync(file, JSON.stringify({ globalMbps: 7, perSessionMbps: 2 }))
    const r = reloadRelayQos()
    assert.equal(r.ok, true)
    assert.equal(server.relayQos().globalMbps, 7)
    assert.equal(server.relayQos().source, 'file')

    // 文件写坏 → 保持旧值（不抛错、不清零）
    fs.writeFileSync(file, '{ not json')
    const bad = reloadRelayQos()
    assert.equal(bad.ok, false)
    assert.equal(server.relayQos().globalMbps, 7, '解析失败必须保持旧配置')
  } finally {
    try { server?.close() } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true })
    const restore = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    restore('RELAY_QOS_LIMIT_MBPS', old.g)
    restore('RELAY_QOS_PER_SESSION_MBPS', old.p)
    restore('RELAY_QOS_FILE', old.f)
  }
})

test('模块级 setRelayQos 对存活实例生效；getRelayQos 可读回', async (t) => {
  const { server } = await mkRelay({ globalMbps: 0, perSessionMbps: 0 })
  t.after(() => server.close())
  setRelayQos({ globalMbps: 5, perSessionMbps: 2 })
  const list = getRelayQos()
  assert.ok(list.length >= 1)
  assert.ok(list.some((q) => q.globalMbps === 5 && q.perSessionMbps === 2))
  assert.equal(server.relayQos().globalMbps, 5)
  // 关回去，避免影响后续用例
  server.setRelayQos({ globalMbps: 0, perSessionMbps: 0 })
})
