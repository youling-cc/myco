// relay.test.mjs — 云端 TCP 中继协议测试（node --test，零依赖）。
// 覆盖：注册/踢旧连、CONNECT 配对与纯字节转发、pipeline 字节不丢、并发会话、
// NOT_FOUND、未 ACCEPT 超时 UNAVAILABLE、心跳保活。

import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import { createRelay, createPortMux, isRelayLine } from './relay.mjs'

const DID = 'did:myco:zTestProviderDevice0001'

/** 起一个随机口中继。 */
async function spawnRelay() {
  const server = createRelay({ port: 0 })
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  return { server, port: server.address().port }
}

/** 连接 + 可选发首行命令；socket 挂上常驻 reader（sock.rdr）。 */
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

/** 新建的裸连接也要 attach 后才能读。 */
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询等待断言成立（扫除类断言别用固定 sleep，慢机器上会抖）。 */
async function waitFor(fn, ms = 800) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await wait(10)
  }
  return fn()
}

test('REGISTER → OK；重复注册踢旧连', async (t) => {
  const { server, port } = await spawnRelay()
  t.after(() => server.close())
  const p1 = await dial(port, `REGISTER ${DID}`)
  assert.equal(await p1.rdr.line(), 'OK')
  const p2 = await dial(port, `REGISTER ${DID}`)
  assert.equal(await p2.rdr.line(), 'OK')
  // 旧连应被踢（收到 close）
  await new Promise((res) => p1.on('close', res))
  assert.equal(server.relayStats().providers, 1)
  p2.end()
})

test('CONNECT 无 provider → NOT_FOUND', async (t) => {
  const { server, port } = await spawnRelay()
  t.after(() => server.close())
  const c = await dial(port, 'CONNECT did:myco:zNobody')
  assert.equal(await c.rdr.line(), 'NOT_FOUND')
  await new Promise((res) => c.on('close', res))
})

test('全链配对 + 双向纯字节 + pipeline 字节不丢', async (t) => {
  const { server, port } = await spawnRelay()
  t.after(() => server.close())

  // provider：控制连 + 等 SESSION 指令后开新连接接单（ACCEPT 与早期数据同段 pipeline）
  const ctl = await dial(port, `REGISTER ${DID}`)
  assert.equal(await ctl.rdr.line(), 'OK')

  const sessionPromise = (async () => {
    const sidLine = await ctl.rdr.line()
    assert.match(sidLine, /^SESSION [0-9a-f]+$/)
    const sid = sidLine.split(' ')[1]
    const s = attach(net.connect(port, '127.0.0.1'))
    await new Promise((res) => s.on('connect', res))
    s.write(`ACCEPT ${DID} ${sid}\nEARLY-FROM-PROVIDER`)
    return s
  })()

  // consumer：CONNECT + 立刻 pipeline 隧道首包（CONNECT 行后不等待直接发——
  // 验证中继 hold 逻辑不丢字节）
  const c = net.connect(port, '127.0.0.1', () => {
    c.write(`CONNECT ${DID}\nEARLY-FROM-CONSUMER`)
  })
  attach(c)
  assert.equal(await c.rdr.line(), 'OK')

  // consumer 应收到 provider 的 pipeline 字节；provider 会话连应收到 consumer 的
  const s = await sessionPromise
  assert.equal((await c.rdr.raw('EARLY-FROM-PROVIDER'.length)).toString(), 'EARLY-FROM-PROVIDER',
    'consumer 应收到 provider 的 pipeline 字节')
  assert.equal((await s.rdr.raw('EARLY-FROM-CONSUMER'.length)).toString(), 'EARLY-FROM-CONSUMER',
    'provider 应收到 consumer 的 pipeline 字节')

  // 双向继续对发
  c.write('ping')
  assert.equal((await s.rdr.raw(4)).toString(), 'ping')
  s.write('pong')
  assert.equal((await c.rdr.raw(4)).toString(), 'pong')

  // 任一侧断 → 另一侧也断
  c.destroy()
  await new Promise((res) => s.on('close', res))
  ctl.end()
})

test('并发会话互不串流（两条 consumer 同时）', async (t) => {
  const { server, port } = await spawnRelay()
  t.after(() => server.close())
  const ctl = await dial(port, `REGISTER ${DID}`)
  await ctl.rdr.line()

  const mkSession = async (tag) => {
    const c = await dial(port, `CONNECT ${DID}`)
    // 先取 SESSION 再等 OK（consumer 的 OK 依赖 ACCEPT，ACCEPT 依赖 sid——顺序反了就是死锁）
    const sid = (await ctl.rdr.line()).split(' ')[1]
    const s = attach(net.connect(port, '127.0.0.1'))
    await new Promise((res) => s.on('connect', res))
    s.write(`ACCEPT ${DID} ${sid}\n`)
    assert.equal(await c.rdr.line(), 'OK', `${tag}: consumer 应配对成功`)
    return { c, s, tag }
  }
  const a = await mkSession('A')
  const b = await mkSession('B')
  // A 会话传 A 的数据、B 会话传 B 的；互不干扰
  a.c.write('AAAA')
  b.c.write('BBBB')
  assert.equal((await a.s.rdr.raw(4)).toString(), 'AAAA')
  assert.equal((await b.s.rdr.raw(4)).toString(), 'BBBB')
  a.c.destroy(); b.c.destroy(); ctl.end()
})

test('SESSION 无人接单 → UNAVAILABLE', async (t) => {
  const { server, port } = await spawnRelay()
  t.after(() => server.close())
  const ctl = await dial(port, `REGISTER ${DID}`)
  await ctl.rdr.line()
  // provider 收到 SESSION 但不开 ACCEPT 连接
  const c = await dial(port, `CONNECT ${DID}`)
  assert.equal((await ctl.rdr.line()).split(' ')[0], 'SESSION')
  assert.equal(await c.rdr.line(), 'UNAVAILABLE')
  await new Promise((res) => c.on('close', res))
  ctl.end()
})

test('心跳空行刷新活性；统计面可见', async (t) => {
  const { server, port } = await spawnRelay()
  t.after(() => server.close())
  const ctl = await dial(port, `REGISTER ${DID}`)
  assert.equal(await ctl.rdr.line(), 'OK')
  ctl.write('\n') // 心跳
  await wait(50)
  assert.equal(server.relayStats().providers, 1, '心跳后 provider 仍在线')
  assert.equal(server.relayStats().register, 1)
  ctl.end()
})

test('单 provider 卡槽满 → BUSY；释放后立刻能进（2026-10-15 手机点卡真案回归）', async (t) => {
  const relay = createRelay({ port: 0, maxSessionsPerProvider: 2 })
  await new Promise((res) => relay.listen(0, '127.0.0.1', res))
  const port = relay.address().port
  t.after(() => relay.close())

  const ctl = await dial(port, `REGISTER ${DID}`)
  assert.equal(await ctl.rdr.line(), 'OK')
  const mkSession = async () => {
    const c = await dial(port, `CONNECT ${DID}`)
    const sid = (await ctl.rdr.line()).split(' ')[1]
    const s = attach(net.connect(port, '127.0.0.1'))
    await new Promise((res) => s.on('connect', res))
    s.write(`ACCEPT ${DID} ${sid}\n`)
    assert.equal(await c.rdr.line(), 'OK')
    return { c, s }
  }
  const a = await mkSession()
  const b = await mkSession()

  // 第 3 条撞上限 → BUSY（真案里手机点卡就是这么被挡回去的）
  const c3 = await dial(port, `CONNECT ${DID}`)
  assert.equal(await c3.rdr.line(), 'BUSY')
  await new Promise((res) => c3.on('close', res))
  assert.equal(relay.relayStats().busy, 1)

  // 关掉一条 → 空槽立刻可用（证明瓶颈是"上限"而不是"漏卡槽"）
  a.c.destroy()
  assert.ok(await waitFor(() => relay.relayStats().sessions === 1), '关掉的会话应立刻出账')
  const c4 = await dial(port, `CONNECT ${DID}`)
  const sid4 = (await ctl.rdr.line()).split(' ')[1]
  const s4 = attach(net.connect(port, '127.0.0.1'))
  await new Promise((res) => s4.on('connect', res))
  s4.write(`ACCEPT ${DID} ${sid4}\n`)
  assert.equal(await c4.rdr.line(), 'OK', '释放后的空槽必须马上能用')

  b.c.destroy(); c4.destroy(); ctl.end()
})

test('零字节空占位会话快回收——不占着卡槽等 15min', async (t) => {
  const relay = createRelay({ port: 0, deadPairMs: 60, sweepMs: 40 })
  await new Promise((res) => relay.listen(0, '127.0.0.1', res))
  const port = relay.address().port
  t.after(() => relay.close())

  const ctl = await dial(port, `REGISTER ${DID}`)
  await ctl.rdr.line()
  const c = await dial(port, `CONNECT ${DID}`)
  const sid = (await ctl.rdr.line()).split(' ')[1]
  const s = attach(net.connect(port, '127.0.0.1'))
  await new Promise((res) => s.on('connect', res))
  s.write(`ACCEPT ${DID} ${sid}\n`)
  assert.equal(await c.rdr.line(), 'OK')
  assert.equal(relay.relayStats().sessions, 1)

  // 配对后一个字节都不走 → 当作泄漏收掉（consumer 侧会看到 close）
  await new Promise((res) => c.on('close', res))
  assert.equal(relay.relayStats().sessions, 0, '空占位会话应被回收')
  assert.equal(relay.relayStats().deadPair, 1)
  ctl.end()
})

test('有流量的会话不被空占位回收误杀', async (t) => {
  const relay = createRelay({ port: 0, deadPairMs: 60, sweepMs: 40 })
  await new Promise((res) => relay.listen(0, '127.0.0.1', res))
  const port = relay.address().port
  t.after(() => relay.close())

  const ctl = await dial(port, `REGISTER ${DID}`)
  await ctl.rdr.line()
  const c = await dial(port, `CONNECT ${DID}`)
  const sid = (await ctl.rdr.line()).split(' ')[1]
  const s = attach(net.connect(port, '127.0.0.1'))
  await new Promise((res) => s.on('connect', res))
  s.write(`ACCEPT ${DID} ${sid}\n`)
  assert.equal(await c.rdr.line(), 'OK')

  // 活会话：超过 deadPairMs 仍在（只要有字节走过就永不被空占位回收）
  c.write('x')
  assert.equal((await s.rdr.raw(1)).toString(), 'x')
  await wait(200)
  assert.equal(relay.relayStats().sessions, 1, '有流量的会话不能被误杀')
  assert.equal(relay.relayStats().deadPair, 0)
  c.destroy(); ctl.end()
})

test('isRelayLine：HTTP CONNECT 方法行不误判', () => {
  assert.ok(isRelayLine('REGISTER did:myco:zabc'))
  assert.ok(isRelayLine('CONNECT did:myco:zabc'))
  assert.ok(isRelayLine('ACCEPT did:myco:zabc sid123'))
  assert.ok(!isRelayLine('REGISTER did:myco:zabc extra'), 'REGISTER 只认单 token')
  assert.ok(!isRelayLine('CONNECT host:80 HTTP/1.1'), 'HTTP 代理方法行必须走 HTTP')
  assert.ok(!isRelayLine('CONNECT did:myco:zabc HTTP/1.1'))
  assert.ok(!isRelayLine('GET /health HTTP/1.1'))
  assert.ok(!isRelayLine('POST /identity/login HTTP/1.1'))
  assert.ok(!isRelayLine('OPTIONS * HTTP/1.0'))
  assert.ok(!isRelayLine(''), '空行不是命令')
})

test('端口复用（8321 模式）：同口分流 HTTP 与中继', async (t) => {
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('http-ok')
  })
  const relay = createRelay({ port: 0 })
  const mux = createPortMux({ httpServer, relay })
  await new Promise((res) => mux.listen(0, '127.0.0.1', res))
  const port = mux.address().port
  t.after(() => { mux.close(); relay.close(); httpServer.close() })

  // ① HTTP 请求照常走 HTTP 栈
  const body = await new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${port}/health`, (r) => {
      let b = ''
      r.on('data', (c) => (b += c))
      r.on('end', () => res(b))
    }).on('error', rej)
  })
  assert.equal(body, 'http-ok')

  // ② 同一口上中继全链：REGISTER → CONNECT → ACCEPT → 纯字节
  const ctl = await dial(port, `REGISTER ${DID}`)
  assert.equal(await ctl.rdr.line(), 'OK')
  const c = await dial(port, `CONNECT ${DID}`)
  const sid = (await ctl.rdr.line()).split(' ')[1]
  const s = attach(net.connect(port, '127.0.0.1'))
  await new Promise((res) => s.on('connect', res))
  s.write(`ACCEPT ${DID} ${sid}\nhi-relay`)
  assert.equal(await c.rdr.line(), 'OK')
  assert.equal((await c.rdr.raw(8)).toString(), 'hi-relay', 'mux 分流不丢首行后字节')
  c.write('back')
  assert.equal((await s.rdr.raw(4)).toString(), 'back')
  c.destroy()
  ctl.end()
})
