/**
 * tunnel-session.test.ts — 断线重连状态机 + 本地连接↔隧道映射。
 *
 * 覆盖用户明确的硬指标："隧道断开后**自动重连**并在恢复后让页面继续可用"。
 * 用内存线 + node:crypto 版"真 PC 端"（见 tunnel-testkit），全程不走网络。
 */
import { describe, it, expect } from 'vitest'
import { TunnelProxy, backoffFor, memKv, statusMessage, RECONNECT_BACKOFF_MS, type ProxyBridge } from './tunnel-session'
import { buildCandidates, type Candidate } from './p2p-tunnel'
import { attachRustServer, memPair, pairFactory, type MemSocket } from './tunnel-testkit'

// ══════════════════ 内存桥（替身：原生代理） ══════════════════

function memBridge(): ProxyBridge & {
  /** 模拟"浏览器侧"：建立一条本地连接。 */
  openLocal(id: number, first?: Uint8Array): void
  /** 模拟"浏览器侧"：浏览器发字节。 */
  localWrite(id: number, d: Uint8Array): void
  /** 模拟"浏览器侧"：浏览器关连接。 */
  localClose(id: number): void
  /** JS 写回"本地 socket"的明文。 */
  toLocal: Map<number, Uint8Array[]>
  /** 被 JS 关掉的本地连接。 */
  closedByJs: number[]
  connCbs: ((id: number) => void)[]
  dataCbs: ((id: number, d: Uint8Array) => void)[]
  closeCbs: ((id: number) => void)[]
} {
  const connCbs: ((id: number) => void)[] = []
  const dataCbs: ((id: number, d: Uint8Array) => void)[] = []
  const closeCbs: ((id: number) => void)[] = []
  const toLocal = new Map<number, Uint8Array[]>()
  const closedByJs: number[] = []
  return {
    connCbs,
    dataCbs,
    closeCbs,
    toLocal,
    closedByJs,
    onConn: (cb) => void connCbs.push(cb),
    onData: (cb) => void dataCbs.push(cb),
    onClose: (cb) => void closeCbs.push(cb),
    write: (id, d) => {
      const a = toLocal.get(id) ?? []
      a.push(d)
      toLocal.set(id, a)
    },
    close: (id) => void closedByJs.push(id),
    openLocal: (id, first) => {
      for (const cb of connCbs) cb(id)
      if (first) for (const cb of dataCbs) cb(id, first)
    },
    localWrite: (id, d) => {
      for (const cb of dataCbs) cb(id, d)
    },
    localClose: (id) => {
      for (const cb of closeCbs) cb(id)
    },
  }
}

function cands(...bases: string[]): Candidate[] {
  return bases.map((b, i) => ({ kind: i === 0 ? 'lan' : 'ipv6', host: `h${i}`, port: 9100, base: b }))
}

/** 用假定时器（可控时钟），让退避"快进"。 */
function fakeTimers(): { setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void; run: () => Promise<void>; pending: () => number } {
  const q = new Map<number, () => void>()
  let seq = 1
  return {
    setTimer: (fn) => {
      const id = seq++
      q.set(id, fn)
      return id
    },
    clearTimer: (h) => {
      q.delete(h as number)
    },
    pending: () => q.size,
    run: async () => {
      const fns = [...q.values()]
      q.clear()
      for (const f of fns) f()
      // 让 reprobe 的 await 链跑完
      await new Promise((r) => setTimeout(r, 30))
    },
  }
}

const idOf = (): { account: string; device: string; sign: (m: string) => Promise<string | null> } => ({
  account: 'did:youling:zPhone',
  device: 'did:myco:zPhoneDevice',
  sign: async () => 'U0lH',
})

function makeProxy(
  factory: ReturnType<typeof pairFactory>['factory'],
  bridge: ReturnType<typeof memBridge>,
  extra: Partial<ConstructorParameters<typeof TunnelProxy>[0]> = {},
): { proxy: TunnelProxy; timers: ReturnType<typeof fakeTimers>; statuses: string[] } {
  const timers = fakeTimers()
  const statuses: string[] = []
  const proxy = new TunnelProxy({
    candidates: cands('http://a:9100'),
    targetPort: 13911,
    identity: idOf(),
    factory,
    bridge,
    kv: memKv(),
    targetName: '办公室的电脑',
    onStatus: (s) => statuses.push(s.state),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    perCandidateMs: 300,
    totalBudgetMs: 600,
    ...extra,
  })
  return { proxy, timers, statuses }
}

// ══════════════════ ① 状态机基本迁移 ══════════════════

describe('重连状态机：idle → connecting → open', () => {
  it('首条连接建通后状态=open，且缓存"上次胜出地址"', async () => {
    const bridge = memBridge()
    const kv = memKv()
    const { factory } = pairFactory((_c, s, _u, headers) => {
      attachRustServer(s, headers['x-myco-tunnel']!)
    })
    const statuses: string[] = []
    const proxy = new TunnelProxy({
      candidates: cands('http://a:9100'),
      targetPort: 13911,
      identity: idOf(),
      factory,
      bridge,
      kv,
      targetName: '办公室的电脑',
      onStatus: (s) => statuses.push(s.state),
      perCandidateMs: 300,
      totalBudgetMs: 600,
    })
    proxy.start()
    expect(proxy.status.state).toBe('connecting')
    bridge.openLocal(1)
    await new Promise((r) => setTimeout(r, 40))
    expect(proxy.status.state).toBe('open')
    expect(proxy.status.opened).toBe(1)
    expect(kv.get('myco.tunnel.base.13911')).toBe('http://a:9100')
    expect(statuses).toContain('open')
    proxy.stop()
  })

  it('状态文案是人话（不出现 tunnel/p2p/端口/WS）', () => {
    for (const s of ['connecting', 'open', 'degraded', 'closed'] as const) {
      const m = statusMessage(s, 'http://a:9100', '办公室的电脑')
      expect(m).toContain('办公室的电脑')
      for (const bad of ['tunnel', 'p2p', '端口', 'WS', 'websocket', 'TCP']) {
        expect(m.toLowerCase()).not.toContain(bad.toLowerCase())
      }
    }
    expect(statusMessage('degraded', null, '办公室的电脑')).toContain('自动重连')
  })
})

// ══════════════════ ② 数据通路（本地 ↔ 隧道） ══════════════════

describe('数据通路：本地连接 ↔ 隧道（与 PC 端一条 WS = 一条 TCP 同构）', () => {
  it('浏览器字节经隧道到 PC；PC 字节经隧道回浏览器', async () => {
    const bridge = memBridge()
    const seen: ReturnType<typeof attachRustServer>[] = []
    const { factory } = pairFactory((_c, s, _u, headers) => {
      seen.push(attachRustServer(s, headers['x-myco-tunnel']!))
    })
    const { proxy } = makeProxy(factory, bridge, { candidates: cands('http://a:9100') })
    proxy.start()
    bridge.openLocal(7, new TextEncoder().encode('GET /gw/sh-1/ HTTP/1.1\r\n\r\n'))
    await new Promise((r) => setTimeout(r, 40))
    expect(seen.length).toBe(1)
    expect(seen[0].plaintexts[0] && Buffer.from(seen[0].plaintexts[0]).toString()).toBe(
      'GET /gw/sh-1/ HTTP/1.1\r\n\r\n',
    )

    seen[0].serverSends('HTTP/1.1 200 OK\r\n\r\n')
    await new Promise((r) => setTimeout(r, 20))
    expect(new TextDecoder().decode(bridge.toLocal.get(7)![0])).toBe('HTTP/1.1 200 OK\r\n\r\n')
    proxy.stop()
  })

  it('首包抢在握手之前到达也要不丢（pending 缓冲）', async () => {
    const bridge = memBridge()
    const seen: ReturnType<typeof attachRustServer>[] = []
    const { factory } = pairFactory((_c, s, _u, headers) => {
      // 故意把服务端响应拖后 20ms（拉长握手窗口）
      const h = attachRustServer(s, headers['x-myco-tunnel']!)
      const orig = s.send.bind(s)
      s.send = (d: Uint8Array): void => {
        setTimeout(() => orig(d), 20)
      }
      seen.push(h)
    })
    const { proxy } = makeProxy(factory, bridge)
    proxy.start()
    // 本地连接 + **立刻**发首包（此时隧道还没建好）
    bridge.openLocal(3)
    bridge.localWrite(3, new TextEncoder().encode('EARLY'))
    await new Promise((r) => setTimeout(r, 80))
    expect(seen.length).toBe(1)
    expect(Buffer.from(seen[0].plaintexts[0]).toString()).toBe('EARLY')
    proxy.stop()
  })
})

// ══════════════════ ③ 断线 → 退避 → 自动恢复 ══════════════════

describe('断线无感重连：断开 → 退避重探 → 恢复后新连接立刻可用', () => {
  it('对端断开 → degraded → 退避一次后探通 → 回 open，且缓存刷新到新的胜出地址', async () => {
    const bridge = memBridge()
    const kv = memKv({ 'myco.tunnel.base.13911': 'http://a:9100' })
    let up = true
    const servers: MemSocket[] = []
    const { factory } = pairFactory((_c, s, _url, headers) => {
      if (!up) {
        s.failWith = 'connection refused'
        return
      }
      servers.push(s)
      attachRustServer(s, headers['x-myco-tunnel']!)
    })
    const { proxy, timers, statuses } = makeProxy(factory, bridge, { kv })
    proxy.start()
    bridge.openLocal(1)
    await new Promise((r) => setTimeout(r, 40))
    expect(proxy.status.state).toBe('open')

    // 模拟"网断了/对端关机"：服务端整体下线 + 现有连接被切断
    up = false
    servers[servers.length - 1].close(1006, 'network-lost')
    await new Promise((r) => setTimeout(r, 20))
    expect(proxy.status.state).toBe('degraded')
    // 浏览器侧那条本地连接必须被关掉（让 SPA 自己重连）
    expect(bridge.closedByJs).toContain(1)

    // 退避：第 0 次 = 300ms（第一条），定时器已排上
    expect(proxy.status.attempt).toBe(1)
    expect(timers.pending()).toBe(1)

    // 网络恢复 → 快进定时器 → 探通 → open，attempt 归零
    up = true
    await timers.run()
    expect(proxy.status.state).toBe('open')
    expect(proxy.status.attempt).toBe(0)
    expect(statuses).toContain('degraded')
    expect(statuses[statuses.length - 1]).toBe('open')

    // 恢复后**下一条本地连接**（浏览器/SPA 重连）立刻跑通
    bridge.openLocal(2, new TextEncoder().encode('RETRY'))
    await new Promise((r) => setTimeout(r, 40))
    const srv = servers[servers.length - 1]
    expect(srv.closed).toBe(false)
    expect(proxy.status.opened).toBeGreaterThanOrEqual(1)
    proxy.stop()
  })

  it('退避序列：0.3/0.6/1.2/2.4/4.8/8s 封顶（纯函数）', () => {
    expect(backoffFor(0)).toBe(300)
    expect(backoffFor(1)).toBe(600)
    expect(backoffFor(2)).toBe(1200)
    expect(backoffFor(5)).toBe(8000)
    expect(backoffFor(99)).toBe(8000)
    expect(RECONNECT_BACKOFF_MS[0]).toBe(300)
  })

  it('连续失败时退避逐次变长（attempt 递增且在飞不叠加）', async () => {
    const bridge = memBridge()
    const { factory } = pairFactory((_c, s) => {
      s.failWith = 'connection refused'
    })
    const { proxy, timers } = makeProxy(factory, bridge)
    proxy.start()
    bridge.openLocal(1)
    await new Promise((r) => setTimeout(r, 40))
    expect(proxy.status.state).toBe('degraded')
    expect(proxy.status.attempt).toBe(1)
    await timers.run()
    const a2 = proxy.status.attempt
    expect(a2).toBeGreaterThanOrEqual(2) // 又失败 → attempt 继续长
    expect(timers.pending()).toBe(1) // 同一时刻只有一条重探在飞
    proxy.stop()
  })

  it('零候选 → 直接 degraded（不空转）', async () => {
    const bridge = memBridge()
    const { factory, urls } = pairFactory()
    const { proxy } = makeProxy(factory, bridge, { candidates: [] })
    proxy.start()
    bridge.openLocal(1)
    await new Promise((r) => setTimeout(r, 20))
    expect(urls.length).toBe(0)
    expect(proxy.status.state).toBe('degraded')
    proxy.stop()
  })
})

// ══════════════════ ④ 停止语义 ══════════════════

describe('stop() 语义', () => {
  it('stop 幂等；停止后不再重连、不再开本地连接', async () => {
    const bridge = memBridge()
    const { factory } = pairFactory((_c, s) => {
      s.failWith = 'refused'
    })
    const { proxy, timers } = makeProxy(factory, bridge)
    proxy.start()
    bridge.openLocal(1)
    await new Promise((r) => setTimeout(r, 30))
    expect(proxy.status.state).toBe('degraded')
    proxy.stop()
    expect(proxy.status.state).toBe('closed')
    proxy.stop() // 幂等
    expect(timers.pending()).toBe(0)
    const before = bridge.closedByJs.length
    bridge.openLocal(2) // 停止后的本地连接必须被立刻关掉
    await new Promise((r) => setTimeout(r, 10))
    expect(bridge.closedByJs.length).toBeGreaterThan(before)
    await timers.run()
    expect(proxy.status.state).toBe('closed')
  })

  it('stop 后 UI 拿到的文案是"已断开"而不是"正在重连"', () => {
    expect(statusMessage('closed', null, '办公室的电脑')).toContain('已断开')
  })
})

// ══════════════════ ⑤ 候选刷新（换网/对端换地址） ══════════════════

describe('候选刷新：重探时取"此刻"的地址清单', () => {
  it('refreshCandidates 被调用，换网后新地址参与重探', async () => {
    const bridge = memBridge()
    let n = 0
    const refresh = (): Candidate[] => {
      n += 1
      return n <= 1 ? cands('http://old:9100') : cands('http://new:9100')
    }
    const tried: string[] = []
    const { factory } = pairFactory((_c, _s, url) => {
      tried.push(url)
      throw new Error('nope')
    })
    const timers = fakeTimers()
    const proxy = new TunnelProxy({
      candidates: cands('http://old:9100'),
      refreshCandidates: refresh,
      targetPort: 13911,
      identity: idOf(),
      factory,
      bridge,
      kv: memKv(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      perCandidateMs: 100,
      totalBudgetMs: 200,
    })
    proxy.start()
    bridge.openLocal(1)
    await new Promise((r) => setTimeout(r, 30))
    await timers.run()
    expect(tried.some((u) => u.includes('//new:9100'))).toBe(true)
    proxy.stop()
  })

  it('网络切换 forceNetworkReset：半开 open 也关旧连接并立刻用新候选重探', async () => {
    const bridge = memBridge()
    let generation = 0
    const tried: string[] = []
    const refresh = (): Candidate[] => generation === 0
      ? cands('http://old-wifi:9100')
      : cands('http://new-cellular:9100')
    const { factory } = pairFactory((_c, s, url, headers) => {
      tried.push(url)
      attachRustServer(s, headers['x-myco-tunnel']!)
    })
    const proxy = new TunnelProxy({
      candidates: cands('http://old-wifi:9100'),
      refreshCandidates: refresh,
      targetPort: 13911,
      identity: idOf(),
      factory,
      bridge,
      kv: memKv(),
      perCandidateMs: 300,
      totalBudgetMs: 600,
    })
    proxy.start()
    bridge.openLocal(1, new TextEncoder().encode('GET /first HTTP/1.1\r\n\r\n'))
    await new Promise((r) => setTimeout(r, 40))
    expect(proxy.status.state).toBe('open')
    expect(bridge.closedByJs).not.toContain(1)

    generation = 1
    await proxy.forceNetworkReset()
    expect(bridge.closedByJs).toContain(1) // 半开 open 也不能保留
    expect(tried.some((u) => u.includes('//new-cellular:9100'))).toBe(true)
    expect(proxy.status.state).toBe('open') // 新网络 relay/direct 探通
    proxy.stop()
  })

  it('buildCandidates + 缓存：下次优先上次胜出的那条腿', () => {
    const c = buildCandidates(
      { lanList: ['192.168.1.82'], ipv6List: ['3ffe::1'], port: 9100 },
      'http://[3ffe::1]:9100',
    )
    expect(c[0].kind).toBe('cached')
    expect(c[0].base).toBe('http://[3ffe::1]:9100')
    expect(c.length).toBe(2)
  })
})

// ══════════════════ ⑥ 双端真实对拍（本地 HTTP 语义） ══════════════════

describe('端到端语义：本地端口 ≡ 目标端口（HTTP 往返经由真隧道）', () => {
  it('本地发 HTTP 请求 → 经隧道到"PC" → PC 回响应 → 本地收到', async () => {
    const bridge = memBridge()
    const servers: ReturnType<typeof attachRustServer>[] = []
    const { factory } = pairFactory((_c, s, _u, headers) => {
      const h = attachRustServer(s, headers['x-myco-tunnel']!)
      // "PC 上的 HTTP 服务"：收到 GET 就回一个 200
      const origOnMsg = h.plaintexts
      servers.push(h)
      void origOnMsg
    })
    const { proxy } = makeProxy(factory, bridge)
    proxy.start()
    bridge.openLocal(9, new TextEncoder().encode('GET /gw/sh-9/ HTTP/1.1\r\n\r\n'))
    await new Promise((r) => setTimeout(r, 40))
    expect(Buffer.from(servers[0].plaintexts[0]).toString()).toContain('GET /gw/sh-9/')
    servers[0].serverSends('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')
    await new Promise((r) => setTimeout(r, 20))
    expect(new TextDecoder().decode(bridge.toLocal.get(9)![0])).toContain('200 OK')
    proxy.stop()
  })

  it('本地连接关闭 → 隧道连接一并关闭（不泄漏）', async () => {
    const bridge = memBridge()
    const clients: MemSocket[] = []
    const { factory } = pairFactory((c, s, _u, headers) => {
      clients.push(c)
      attachRustServer(s, headers['x-myco-tunnel']!)
    })
    const { proxy } = makeProxy(factory, bridge)
    proxy.start()
    bridge.openLocal(11)
    await new Promise((r) => setTimeout(r, 40))
    expect(clients[0].closed).toBe(false)
    bridge.localClose(11)
    await new Promise((r) => setTimeout(r, 10))
    expect(clients[0].closed).toBe(true)
    proxy.stop()
  })

  it('memPair 自身健全性（脚手架自检，避免假绿）', async () => {
    const [a, b] = memPair()
    const got: Uint8Array[] = []
    b.onMessage((d) => got.push(d))
    a.send(new Uint8Array([1, 2, 3]))
    await new Promise((r) => setTimeout(r, 1))
    expect(got.length).toBe(1)
    a.close(1000)
    expect(a.closed && b.closed).toBe(true)
  })
})
