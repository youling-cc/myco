/**
 * dsh-open.test.ts — 隧道 HTTP 设施 + 在途护栏/串行队列的**行为面**单测。
 *
 * 2026-11-12：取票链（openSharedTask / provider B / 预取票 / 复用票 / parseSyncReply）
 * 已整链删除——VNETP 直入成为手机点 DSH 卡的唯一路径（行为测试在
 * dsh-open-runtime.test.ts）。本文件只锁**仍在用**的通用设施：
 *   · `parseHttpResponse` / `dechunk`（隧道 HTTP 响应解析，纯函数）；
 *   · `openHttpTunnelSession` + `httpOverTunnel`（聊天中继的可复用会话，字节面）；
 *   · `makeSingleFlight`（openTaskShare 的双击护栏）；
 *   · `makeSerialQueue`（presence addrs 写入串行化）。
 *
 * 隧道用 `tunnel-testkit` 的内存线 + `node` 版 Rust responder：被测的是真握手、
 * 真 AEAD 帧、真 HTTP 字节拼装；只有"网线"是假的。
 */
import { describe, it, expect } from 'vitest'
import { buildCandidates, type TunnelIdentity, type TunnelSocketFactory } from './p2p-tunnel'
import { pairFactory, attachRustServer, type MemSocket } from './tunnel-testkit'
import {
  parseHttpResponse,
  openHttpTunnelSession,
  httpOverTunnel,
  makeSingleFlight,
  makeSerialQueue,
} from './dsh-open'

/** 假身份（隧道测试不做验签；签名材料记下来供断言）。 */
function fakeIdentity(): { id: TunnelIdentity; signed: string[] } {
  const signed: string[] = []
  const device = 'did:myco:zPhoneDev'
  return {
    id: {
      account: 'did:youling:zAcct',
      device,
      sign: async (m: string) => {
        signed.push(m)
        return `SIG(${m.length})`
      },
    },
    signed,
  }
}

/** 假 PC：一条内存线 = 一条到目标端口的 TCP。收到 HTTP 请求 → 按 text 回一个响应。 */
function fakePc(opts: {
  io: (req: { raw: string; headers: Record<string, string>; body: string }) => string
}): {
  factory: TunnelSocketFactory
  requests: { raw: string; headers: Record<string, string>; body: string }[]
  targetPorts: number[]
} {
  const requests: { raw: string; headers: Record<string, string>; body: string }[] = []
  const targetPorts: number[] = []
  const { factory } = pairFactory((client: MemSocket, server: MemSocket, url: string, headers: Record<string, string>) => {
    // 用握手信封里的 port 记下"这条隧道要打到哪个目标端口"
    const hs = JSON.parse(headers['x-myco-tunnel'] ?? '{}') as { port?: number }
    targetPorts.push(hs.port ?? 0)
    const srv = attachRustServer(server, headers['x-myco-tunnel'] ?? '')
    let got = ''
    const feed = (): void => {
      while (srv.plaintexts.length > 0) {
        const pt = srv.plaintexts.shift()!
        got += new TextDecoder().decode(pt)
        if (!got.includes('\r\n\r\n')) continue
        const idx = got.indexOf('\r\n\r\n')
        const head = got.slice(0, idx)
        const bodyStr = got.slice(idx + 4)
        const cl = /content-length:\s*(\d+)/i.exec(head)
        // ⚠️ 必须按**字节**比（信封里有中文名：'我' 是 3 字节 1 个 UTF-16 单元）
        if (cl && new TextEncoder().encode(bodyStr).length < Number(cl[1])) continue
        const body = bodyStr
        const hdrs: Record<string, string> = {}
        for (const line of head.split('\r\n').slice(1)) {
          const i = line.indexOf(':')
          if (i > 0) hdrs[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
        }
        const req = { raw: got, headers: hdrs, body }
        requests.push(req)
        srv.serverSends(opts.io(req))
        got = ''
      }
    }
    // attachRustServer 已经把 onMessage 挂上了；这里用轮询把新明文转成 HTTP
    const t = setInterval(feed, 1)
    setTimeout(() => clearInterval(t), 4000)
    void client
    void url
  })
  return { factory, requests, targetPorts }
}

describe('HTTP 响应解析（隧道上的"一次性 HTTP"）', () => {
  it('状态行/头/正文（utf-8，中文正文不裂）', () => {
    const raw = new TextEncoder().encode(
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{"a":"中"}',
    )
    const r = parseHttpResponse(raw)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('application/json')
    expect(r.body).toBe('{"a":"中"}')
  })

  it('分块编码（Transfer-Encoding: chunked）→ body 去壳（真机踩过：票到了却读不出）', () => {
    const chunked =
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n' +
      '7\r\n{"a":1}\r\n2\r\n{}\r\n0\r\n\r\n'
    const r = parseHttpResponse(new TextEncoder().encode(chunked))
    expect(r.status).toBe(200)
    expect(r.body).toBe('{"a":1}{}')
    // 坏分块不抛（上层 JSON 解析兜底），也不把原文吃掉
    expect(parseHttpResponse(new TextEncoder().encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n')).body).toBe('zz\r\n')
  })
})

describe('httpOverTunnel 的字节面（可复用会话；聊天中继的底座）', () => {
  it('POST 带 body：Content-Length 正确、body 原样跟进、签名头透传', async () => {
    const { id } = fakeIdentity()
    const pc = fakePc({
      io: () => {
        const body = '{"ok":true}'
        return `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`
      },
    })
    const c = buildCandidates({ lan: '127.0.0.1' })[0]
    const session = await openHttpTunnelSession(c, 9100, id, pc.factory)
    const resp = await httpOverTunnel(session, {
      method: 'POST',
      path: '/p2p/msg',
      headers: { 'X-Myco-Auth': 'x.y.z' },
      body: '{"hello":"世界"}',
    })
    expect(resp.status).toBe(200)
    expect(resp.body).toBe('{"ok":true}')
    const req = pc.requests[0]
    expect(req).toBeTruthy()
    expect(req.raw.startsWith('POST /p2p/msg HTTP/1.1\r\n')).toBe(true)
    expect(req.body).toBe('{"hello":"世界"}')
    expect(req.headers['x-myco-auth']).toBe('x.y.z')
    expect(Number(req.headers['content-length'])).toBe(new TextEncoder().encode(req.body).length)
    try {
      session.socket.close(1000, 'test-done')
    } catch {
      /* 已断 */
    }
  })
})

// ══════════════ 在途护栏（单槽 + 超时自清）与串行队列 ══════════════
describe('在途护栏 makeSingleFlight', () => {
  /** 手动计时器：测试里自己拨表。 */
  function manualTimer(): { setTimer: (f: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void; fire: () => void } {
    let pending: (() => void) | null = null
    return {
      setTimer: (f) => {
        pending = f
        return f
      },
      clearTimer: () => {
        pending = null
      },
      fire: () => {
        const f = pending
        pending = null
        f?.()
      },
    }
  }

  it('在途复用：第二次调用拿同一个 Promise，任务只跑一次', async () => {
    const flight = makeSingleFlight({ timeoutMs: 30_000 })
    let runs = 0
    const task = async (): Promise<string> => {
      runs += 1
      await new Promise((r) => setTimeout(r, 5))
      return 'done'
    }
    const a = flight(task, () => 'timeout')
    const b = flight(task, () => 'timeout')
    expect(a).toBe(b)
    expect(flight.inFlight()).toBe(true)
    expect(await a).toBe('done')
    expect(runs).toBe(1)
    expect(flight.inFlight()).toBe(false)
  })

  it('超时复位：返回 onTimeout 值；迟到结果被丢弃；槽位复位后可再跑', async () => {
    const t = manualTimer()
    const flight = makeSingleFlight({ timeoutMs: 30_000, setTimer: t.setTimer, clearTimer: t.clearTimer })
    let lateSettled = false
    const hanging = (): Promise<string> =>
      new Promise((res) => {
        setTimeout(() => {
          lateSettled = true
          res('late')
        }, 50)
      })
    const p = flight(hanging, () => 'timeout-msg')
    t.fire() // 拨表：超时
    await expect(p).resolves.toBe('timeout-msg')
    expect(flight.inFlight()).toBe(false)
    // 下一班可以立即开跑（不被上一班的挂起永久挡门——2026-10-10 真机修复点）
    const q = flight(async () => 'second', () => 'timeout2')
    await expect(q).resolves.toBe('second')
    // 上一班的迟到 settle 不影响任何槽位
    await new Promise((r) => setTimeout(r, 60))
    expect(lateSettled).toBe(true)
    expect(flight.inFlight()).toBe(false)
  })

  it('任务抛异常 → 按 onTimeout 的人话错误收口（不泄漏 rejected）', async () => {
    const flight = makeSingleFlight({ timeoutMs: 30_000 })
    await expect(
      flight(
        async () => {
          throw new Error('boom')
        },
        () => 'human-error',
      ),
    ).resolves.toBe('human-error')
    expect(flight.inFlight()).toBe(false)
  })
})

describe('串行队列 makeSerialQueue', () => {
  it('严格按入队顺序执行：前一个 settle 后一个才开跑（presence addrs 写序根修）', async () => {
    const order: string[] = []
    const queue = makeSerialQueue()
    const gate: { a?: () => void } = {}
    const slowA = new Promise<void>((res) => {
      gate.a = res
    })
    queue(async () => {
      order.push('a-start')
      await slowA
      order.push('a-end')
    })
    queue(async () => {
      order.push('b')
    })
    queue(async () => {
      order.push('c')
    })
    await new Promise((r) => setTimeout(r, 10))
    // a 未 settle：b/c 都不许开跑（{} 不能越过 wantReverse 注册先到服务器）
    expect(order).toEqual(['a-start'])
    gate.a!()
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['a-start', 'a-end', 'b', 'c'])
  })

  it('单个任务失败不阻塞后续', async () => {
    const order: string[] = []
    const queue = makeSerialQueue()
    queue(async () => {
      throw new Error('x')
    })
    queue(async () => {
      order.push('after-fail')
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['after-fail'])
  })
})
