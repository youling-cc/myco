/**
 * dsh-open.test.ts — 「点卡就进」的**编排**面：隧道 HTTP 一次性请求、兜底取票
 * （provider B）、以及"**绝不碰本地管理面 3102**"这条硬边界。
 *
 * 为什么这几条必须有：
 *   · 真机验证时兜底路径是靠 `MYCO_P2P_TUNNEL_PORTS` 放通 **3102**（整个本地管理面）
 *     才走通的——那不是正式方案。现在兜底只发**一条** `share-entry-request` 到
 *     **p2p 数据面端口**（默认 9100，本来就在白名单里）。
 *   · 兜底发出去的那条 wire 必须与 provider A **同形**（同一个信封/签名口径），
 *     否则"换传输"就变成了"另写一套协议"。
 *
 * 隧道用 `tunnel-testkit` 的内存线 + `node` 版 Rust responder：被测的是真握手、
 * 真 AEAD 帧、真 HTTP 字节拼装；只有"网线"是假的。
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_P2P_PORT, buildCandidates, relayCandidate, type TunnelIdentity } from './p2p-tunnel'
import { pairFactory, attachRustServer, type MemSocket } from './tunnel-testkit'
import {
  parseSyncReply,
  parseHttpResponse,
  openSharedTask,
  __resetEntryCaches, prefetchShareEntry,
  takePrefetchedEntry,
  requestEntryViaTunnel,
  tunnelHttpRequest,
  makeSingleFlight,
  makeSerialQueue,
  type OpenTaskDeps,
} from './dsh-open'
import type { ProxyBridge } from './tunnel-session'
import { memKv } from './tunnel-session'
import { DEFAULT_GW_PORT, shareCardOf, type ShareCard } from './share-entry'

const CARD: ShareCard = {
  shareId: 'sh-tunnel-1',
  sourceDevice: 'did:myco:zSourcePc',
  sourceDeviceName: '办公室的电脑',
  sourceAccount: 'did:youling:zAcct',
  title: '重构分享网关',
}

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
  factory: ReturnType<typeof pairFactory> extends never ? never : OpenTaskDeps['factory']
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

/** 空桥（本组用例不经过本地连接；隧道 HTTP 是 JS 自己发的）。 */
const noBridge: ProxyBridge = {
  onConn: () => {},
  onData: () => {},
  onClose: () => {},
  write: () => {},
  close: () => {},
}

/** 造一份最小可用的编排依赖（兜底只用其中几项）。 */
function depsOf(factory: OpenTaskDeps['factory'], id: TunnelIdentity, extra: Partial<OpenTaskDeps> = {}): OpenTaskDeps {
  return {
    myAccount: id.account,
    myDevice: id.device,
    identity: id,
    sourceAddrs: async () => null,
    startListener: async () => 1,
    stopListener: () => {},
    openWebView: () => true,
    factory,
    bridge: noBridge,
    onLog: () => {},
    now: () => 1_700_000_000_000,
    randId: () => 'ser-test-1',
    ...extra,
  }
}

function httpJson(status: number, obj: unknown): string {
  const body = JSON.stringify(obj)
  return (
    `HTTP/1.1 ${status} OK\r\n` +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${body.length}\r\n` +
    'Connection: close\r\n\r\n' +
    body
  )
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

describe('同步回包解析（parseSyncReply，与 PC 端 msg_ok_body 同契约）', () => {
  it('有 reply → 取出来', () => {
    const r = parseSyncReply('{"ok":true,"kept":true,"reply":{"requestId":"ser-1","ok":true,"mt":"M"}}', 'ser-1')
    expect(r?.mt).toBe('M')
  })

  it('没有 reply（老桌面端）/ 非 JSON / ok:false → null（回落兜底，不假装拿到票）', () => {
    expect(parseSyncReply('{"ok":true,"kept":true}', 'ser-1')).toBeNull()
    expect(parseSyncReply('<html>打不开</html>', 'ser-1')).toBeNull()
    expect(parseSyncReply('{"ok":false,"error":"nope"}', 'ser-1')).toBeNull()
    expect(parseSyncReply('{"ok":true,"reply":[]}', 'ser-1')).toBeNull()
  })

  it('requestId 对不上 → null（不拿别人的票）', () => {
    expect(parseSyncReply('{"ok":true,"reply":{"requestId":"ser-2","ok":true,"mt":"M"}}', 'ser-1')).toBeNull()
  })
})

describe('兜底取票（provider B：同一份 wire 换原生隧道传输）', () => {
  it('★ 打的是 p2p 数据面端口（默认 9100），**不是**管理面 3102', async () => {
    const { id } = fakeIdentity()
    const pc = fakePc({
      io: () =>
        httpJson(200, {
          ok: true,
          kept: true,
          reply: { shareId: CARD.shareId, requestId: 'ser-test-1', ok: true, mt: 'MT-T', expiresAt: 1_700_000_180_000, gwPort: DEFAULT_GW_PORT },
        }),
    })
    const entry = await requestEntryViaTunnel(CARD, depsOf(pc.factory, id), buildCandidates({ lan: '127.0.0.1' }))
    expect(entry.mt).toBe('MT-T')
    expect(entry.gwPort).toBe(DEFAULT_GW_PORT)
    expect(entry.via).toBe('broker')
    expect(entry.expiresAt).toBe(1_700_000_180_000)
    expect(pc.targetPorts).toEqual([DEFAULT_P2P_PORT])
    expect(DEFAULT_P2P_PORT).not.toBe(3102)
  })

  it('★ 发出去的是一条 share-entry-request（签名头 + Content-Length + 同形信封）', async () => {
    const { id, signed } = fakeIdentity()
    const pc = fakePc({
      io: () =>
        httpJson(200, {
          ok: true,
          kept: true,
          reply: { shareId: CARD.shareId, requestId: 'ser-test-1', ok: true, mt: 'MT-T', expiresAt: 1_700_000_180_000, gwPort: 13911 },
        }),
    })
    await requestEntryViaTunnel(CARD, depsOf(pc.factory, id), buildCandidates({ lan: '127.0.0.1' }))
    const req = pc.requests[0]
    expect(req).toBeTruthy()
    expect(req.raw.startsWith('POST /p2p/msg HTTP/1.1\r\n')).toBe(true)
    // signed[0] = 签名头的材料（签名头在开隧道**之前**算）；之后那次是隧道握手材料
    const authMaterial = signed[0]
    expect(req.headers['x-myco-auth']).toBe(`${id.device}.1700000000000.SIG(${authMaterial.length})`)
    expect(Number(req.headers['content-length'])).toBe(new TextEncoder().encode(req.body).length)
    // 签名口径：did\nts\n<body>（与 p2p_server::verify_auth 同式）——签名材料必须就是发出去的那份
    expect(authMaterial).toBe(`${id.device}\n1700000000000\n${req.body}`)
    // 信封与 payload（spec 四字段 + syncReply）
    const env = JSON.parse(req.body) as Record<string, unknown>
    expect(Object.keys(env)).toEqual(['msgId', 'from', 'fromName', 'fromDevice', 'fromDeviceName', 'to', 'kind', 'payload', 'ts'])
    expect(env.kind).toBe('share-entry-request')
    expect(env.fromDevice).toBe(id.device)
    expect(env.to).toBe(CARD.sourceAccount)
    expect(Object.keys(env.payload as Record<string, unknown>)).toEqual([
      'shareId',
      'requestId',
      'requesterDevice',
      'requesterAccount',
      'syncReply',
    ])
  })

  it('对方 403（签名/归属闸拒）→ 人话错误，不吐内部术语', async () => {
    const { id } = fakeIdentity()
    const pc = fakePc({ io: () => httpJson(403, { error: 'auth failed' }) })
    let err: unknown
    try {
      await requestEntryViaTunnel(CARD, depsOf(pc.factory, id), buildCandidates({ lan: '127.0.0.1' }))
    } catch (e) {
      err = e
    }
    expect((err as Error).message).toBe('对方设备没认下这次请求')
    for (const bad of ['tunnel', 'p2p', '3102', '端口']) {
      expect((err as Error).message.toLowerCase()).not.toContain(bad.toLowerCase())
    }
  })

  it('对方回 200 但没有回包（老桌面端/形状不符）→ 人话错误', async () => {
    const { id } = fakeIdentity()
    const pc = fakePc({ io: () => httpJson(200, { ok: true, kept: true }) })
    await expect(
      requestEntryViaTunnel(CARD, depsOf(pc.factory, id), buildCandidates({ lan: '127.0.0.1' })),
    ).rejects.toThrowError(/没给出入口/)
  })

  it('没有可拨地址 → 立刻人话（不开隧道）', async () => {
    const { id } = fakeIdentity()
    const pc = fakePc({ io: () => httpJson(200, {}) })
    await expect(requestEntryViaTunnel(CARD, depsOf(pc.factory, id), [])).rejects.toThrowError(/不在线/)
    expect(pc.requests.length).toBe(0)
  })

  it('★ 并行赛跑（2026-10-11）：死直连腿不再堵住中继腿（串行时要先吃满死腿超时）', async () => {
    const { id } = fakeIdentity()
    const pc = fakePc({
      io: () =>
        httpJson(200, {
          ok: true,
          kept: true,
          reply: { shareId: CARD.shareId, requestId: 'ser-test-1', ok: true, mt: 'MT-RACE', expiresAt: 1_700_000_180_000, gwPort: DEFAULT_GW_PORT },
        }),
    })
    // 直连腿 400ms 后才认死（模拟不可达拨号超时）；中继腿让先 20ms 后立刻通。
    // 串行实现 ≥400ms，并行实现 ≈50ms——断言 <250ms 即锁死"并行"语义。
    const inner = pc.factory
    const slowDirect: OpenTaskDeps['factory'] = async (url, headers, signal) => {
      if (url.startsWith('relay://')) return inner(url, headers, signal)
      await new Promise((res) => setTimeout(res, 400))
      throw new Error('connection refused')
    }
    const relayLeg = { ...relayCandidate(CARD.sourceDevice), delayMs: 20 }
    const t0 = Date.now()
    const entry = await requestEntryViaTunnel(CARD, depsOf(slowDirect, id), [
      { kind: 'lan', host: 'h', port: 9100, base: 'http://dead:9100' },
      relayLeg,
    ])
    expect(entry.mt).toBe('MT-RACE')
    expect(Date.now() - t0).toBeLessThan(250)
  }, 10000)
})

describe('tunnelHttpRequest 的字节面', () => {
  it('POST 带 body：Content-Length 正确、body 原样跟进', async () => {    const { id } = fakeIdentity()
    const pc = fakePc({
      io: () => {
        const body = '{"ok":true}'
        return `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`
      },
    })
    const c = buildCandidates({ lan: '127.0.0.1' })[0]
    const resp = await tunnelHttpRequest(
      c,
      9100,
      { method: 'POST', path: '/p2p/msg', headers: { 'X-Myco-Auth': 'x.y.z' }, body: '{"hello":"世界"}' },
      id,
      pc.factory,
      {},
    )
    expect(resp.status).toBe(200)
    expect(resp.body).toBe('{"ok":true}')
    const req = pc.requests[0]
    expect(req.body).toBe('{"hello":"世界"}')
    expect(req.headers['x-myco-auth']).toBe('x.y.z')
    expect(Number(req.headers['content-length'])).toBe(new TextEncoder().encode(req.body).length)
  })
})

// ══════════════ ★ 真形状嵌套卡 → 点开走隧道（端到端，跨本轮两处改动） ══════════════
// 覆盖"用户真能点到"的完整链：设备群广播的**嵌套卡** → chat-store 摊平落库
// → UI 判据（shareCardOf）→ 取票（同步回程 / 隧道兜底）→ 开本地端口上的分享页。
describe('★ 真形状嵌套卡 → 点开走隧道（端到端）', () => {
  const MY = 'did:youling:zAcct'
  const DEV = 'did:myco:zPhoneDev'
  const PC_DEV = 'did:myco:zOfficePc'
  // PC 端 device_group_card_payload × sync_share_task 的真实 wire 形状
  const WIRE: Record<string, unknown> = {
    groupId: 'grp-dev-x',
    groupName: '设备群',
    members: [MY],
    fromName: 'OFFICE-PC',
    status: 'todo',
    card: {
      taskId: 'peer-task-sh-e2e',
      title: '重构分享网关',
      desc: 'myco 分享 · 会话',
      from: MY,
      fromName: '我·abcd',
      createdAt: 1759900000000,
      source: 'dsh-share',
      shareId: 'sh-e2e',
      granularity: 'session',
      participants: [{ did: MY, name: '我·abcd', role: 'owner' }],
      status: 'todo',
      sourceDevice: PC_DEV,
      sourceDeviceName: 'OFFICE-PC',
      action: { kind: 'open-url', url: 'http://127.0.0.1:3102/api/dshShare/open?shareId=sh-e2e', label: '打开', target: 'window' },
    },
  }

  function depsFor(id: TunnelIdentity, pc: ReturnType<typeof fakePc>, opened: string[]): OpenTaskDeps {
    return depsOf(pc.factory, id, {
      addrs: undefined,
      sourceAddrs: async () => ({ lan: '127.0.0.1' }),
      startListener: async () => 45678,
      stopListener: () => {},
      openWebView: (url, title) => {
        opened.push(`${title}|${url}`)
        return true
      },
      sendControl: async () => ({ delivered: false }),
    } as Partial<OpenTaskDeps>)
  }

  it('嵌套卡摊平后能取到卡；provider A 发不出去 → 隧道兜底拿到票并开页面', async () => {
    const { flattenTaskSharePayload } = await import('./chat-store')
    const flat = flattenTaskSharePayload(WIRE)
    const card = shareCardOf(flat)
    expect(card).toBeTruthy()
    expect(card!.shareId).toBe('sh-e2e')

    const { id } = fakeIdentity()
    // 假身份的账号/设备要与卡片坐标一致
    const id2: TunnelIdentity = { ...id, account: MY, device: DEV }
    const pc = fakePc({
      io: () =>
        httpJson(200, {
          ok: true,
          kept: true,
          reply: {
            shareId: 'sh-e2e',
            requestId: 'ser-test-1',
            ok: true,
            mt: 'MT-E2E',
            expiresAt: 1_700_000_180_000,
            gwPort: DEFAULT_GW_PORT,
          },
        }),
    })
    const opened: string[] = []
    const res = await openSharedTask(card!, depsFor(id2, pc, opened))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.entry.mt).toBe('MT-E2E')
    expect(res.entry.via).toBe('broker')
    expect(res.url).toBe(`http://127.0.0.1:45678/gw/sh-e2e/?mt=MT-E2E#mycoConn=direct`)
    expect(opened).toEqual([`重构分享网关|${res.url}`])
    // 隧道打的是 p2p 数据面端口，**不是**管理面
    expect(pc.targetPorts).toContain(DEFAULT_P2P_PORT)
    expect(pc.targetPorts).not.toContain(3102)
    res.proxy.stop()
  })

  it('provider A 同步回程拿到票 → 不开隧道兜底（只起本地端口 + 预热）', async () => {
    const { flattenTaskSharePayload } = await import('./chat-store')
    const card = shareCardOf(flattenTaskSharePayload(WIRE))!
    const { id } = fakeIdentity()
    const id2: TunnelIdentity = { ...id, account: MY, device: DEV }
    const pc = fakePc({ io: () => httpJson(200, { ok: true, kept: true }) })
    const opened: string[] = []
    const deps = depsFor(id2, pc, opened)
    deps.sendControl = async (_kind, _payload, requestId) => ({
      delivered: true,
      reply: { shareId: 'sh-e2e', requestId, ok: true, mt: 'MT-SYNC', expiresAt: 1_700_000_180_000, gwPort: DEFAULT_GW_PORT },
    })
    const res = await openSharedTask(card, deps)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.entry.via).toBe('control-sync')
    expect(res.url).toBe('http://127.0.0.1:45678/gw/sh-e2e/?mt=MT-SYNC#mycoConn=direct')
    // 兜底那条（POST /p2p/msg）没被发过 —— 只有预热/代理的连接
    expect(pc.requests.length).toBe(0)
    res.proxy.stop()
  })

  it('shouldAbort：开 WebView 前自我了断（收代理+收监听+不弹页面）', async () => {
    const { flattenTaskSharePayload } = await import('./chat-store')
    const card = shareCardOf(flattenTaskSharePayload(WIRE))!
    const { id } = fakeIdentity()
    const id2: TunnelIdentity = { ...id, account: MY, device: DEV }
    const pc = fakePc({ io: () => httpJson(200, { ok: true, kept: true }) })
    const opened: string[] = []
    let stopped = 0
    const deps = depsFor(id2, pc, opened)
    deps.stopListener = () => {
      stopped += 1
    }
    deps.sendControl = async (_kind, _payload, requestId) => ({
      delivered: true,
      reply: { shareId: 'sh-e2e', requestId, ok: true, mt: 'MT-SYNC', expiresAt: 1_700_000_180_000, gwPort: DEFAULT_GW_PORT },
    })
    deps.shouldAbort = () => true
    const res = await openSharedTask(card, deps)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('internal')
    expect(opened).toEqual([]) // 页面没弹
    expect(stopped).toBe(1) // 本地监听已收
  })

  it('预热全灭 → onDirectUnlikely 在开页面前触发（装配层翻 reverse 的信号）', async () => {
    const { flattenTaskSharePayload } = await import('./chat-store')
    const card = shareCardOf(flattenTaskSharePayload(WIRE))!
    const { id } = fakeIdentity()
    const id2: TunnelIdentity = { ...id, account: MY, device: DEV }
    let unlikely = 0
    const opened: string[] = []
    const deps = depsOf(async () => {
      throw new Error('unreachable') // 全部候选建连失败 → 预热赛跑 null
    }, id2, {
      sourceAddrs: async () => ({ lan: '192.0.2.1' }),
      startListener: async () => 45678,
      openWebView: (url, title) => {
        opened.push(`${title}|${url}`)
        return true
      },
      sendControl: async (_kind, _payload, requestId) => ({
        delivered: true,
        reply: { shareId: 'sh-e2e', requestId, ok: true, mt: 'MT-SYNC', expiresAt: 1_700_000_180_000, gwPort: DEFAULT_GW_PORT },
      }),
      onDirectUnlikely: () => {
        unlikely += 1
      },
    } as Partial<OpenTaskDeps>)
    const res = await openSharedTask(card, deps)
    expect(res.ok).toBe(true) // 页面照样开（装配层会把首条连接扣住等反向隧道）
    expect(unlikely).toBe(1)
    expect(opened.length).toBe(1)
    if (res.ok) res.proxy.stop()
  })
})

// ══════════════ ⑦ 云端中继腿接入（2026-10-11：直连/反向全断时的第三条路） ══════════════
// 覆盖：openSharedTask 自动装配中继候选（给直连 300ms 让先）、provider B 兜底走
// 中继腿、中继胜出不进"上次胜出"缓存、强制直连（myco.forceDirect）跳过中继。
describe('云端中继腿接入（openSharedTask 自动装配 + provider B 兜底）', () => {
  const MY = 'did:youling:zAcct'
  const DEV = 'did:myco:zPhoneDev'
  const PC_DEV = 'did:myco:zOfficePc'

  const CARD2: ShareCard = {
    shareId: 'sh-relay-1',
    sourceDevice: PC_DEV,
    sourceDeviceName: '办公室的电脑',
    sourceAccount: MY,
    title: '中继兜底',
  }

  function relayDeps(
    id: TunnelIdentity,
    pc: ReturnType<typeof fakePc>,
    opened: string[],
    extra: Partial<OpenTaskDeps> = {},
  ): OpenTaskDeps {
    return depsOf(pc.factory, id, {
      // ⚠️ 无任何直连地址（IPv6 全断 + AP 隔离的场景）——中继腿是唯一一条
      sourceAddrs: async () => null,
      startListener: async () => 45678,
      openWebView: (url, title) => {
        opened.push(`${title}|${url}`)
        return true
      },
      sendControl: async () => ({ delivered: false }),
      ...extra,
    } as Partial<OpenTaskDeps>)
  }

  it('★ 无直连地址 → 自动加中继腿；provider B 经中继腿拿到票并开页面（信封仍打 p2p 数据面口）', async () => {
    const { id } = fakeIdentity()
    const id2: TunnelIdentity = { ...id, account: MY, device: DEV }
    const pc = fakePc({
      io: () =>
        httpJson(200, {
          ok: true,
          kept: true,
          reply: { shareId: 'sh-relay-1', requestId: 'ser-test-1', ok: true, mt: 'MT-RELAY', expiresAt: 1_700_000_180_000, gwPort: DEFAULT_GW_PORT },
        }),
    })
    const opened: string[] = []
    const kv = memKv()
    const res = await openSharedTask(CARD2, relayDeps(id2, pc, opened, { kv }))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // 中继腿是唯一候选（kind=relay、base=relay://<源设备>@中继）
    const relayLegs = res.candidates.filter((c) => c.kind === 'relay')
    expect(relayLegs).toHaveLength(1)
    expect(relayLegs[0].base).toBe(`relay://${PC_DEV}@myco.youling.cc:8321/p2p/tunnel?v=2`)
    expect(relayLegs[0].delayMs).toBe(300)
    // provider B 走的就是这条腿（对端按 base 分流：直连抛、中继通）
    expect(res.entry.mt).toBe('MT-RELAY')
    expect(res.entry.via).toBe('broker')
    expect(pc.targetPorts).toContain(DEFAULT_P2P_PORT) // 信封 targetPort=9100（不是中继口 8321）
    expect(opened).toHaveLength(1)
    // 中继胜出不进"上次胜出"缓存（它不是直连候选，下次由 openSharedTask 现场装配）
    expect(kv.get(`myco.tunnel.base.${PC_DEV}`)).toBeNull()
    res.proxy.stop()
  }, 15000)

  it('★ 强制直连（myco.forceDirect=1）→ 不加中继腿（无直连地址时给人话失败）', async () => {
    const g = globalThis as { localStorage?: { getItem: (k: string) => string | null } }
    const prev = g.localStorage
    g.localStorage = { getItem: (k) => (k === 'myco.forceDirect' ? '1' : null) }
    try {
      const { id } = fakeIdentity()
      const id2: TunnelIdentity = { ...id, account: MY, device: DEV }
      const pc = fakePc({ io: () => httpJson(200, { ok: true, kept: true }) })
      const opened: string[] = []
      const res = await openSharedTask(CARD2, relayDeps(id2, pc, opened))
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.reason).toBe('offline') // 无直连地址且不走云 → 明确人话，不静默走中继
      expect(opened).toHaveLength(0)
      expect(pc.requests.length).toBe(0) // 一条隧道都没开过
    } finally {
      if (prev === undefined) delete g.localStorage
      else g.localStorage = prev
    }
  }, 15000)
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

// ══════════════ ⑧ R10 预取票（2026-10-20：任务列表渲染后后台取票，点卡直接用） ══════════════
describe('R10 预取票', () => {
  const PF_CARD: ShareCard = {
    shareId: 'sh-prefetch-1',
    sourceDevice: 'did:myco:zOfficePc',
    sourceDeviceName: '办公室的电脑',
    sourceAccount: 'did:youling:zAcct',
    title: '预取票',
  }

  function pfDeps(pc: ReturnType<typeof fakePc>, id: TunnelIdentity, extra: Partial<OpenTaskDeps> = {}): OpenTaskDeps {
    return depsOf(pc.factory, id, {
      sourceAddrs: async () => null,
      startListener: async () => 45678,
      openWebView: () => true,
      sendControl: async () => ({ delivered: false }),
      ...extra,
    } as Partial<OpenTaskDeps>)
  }

  function pfPc(mt: string, expiresAt = Date.now() + 120_000) {
    return fakePc({
      io: () =>
        httpJson(200, {
          ok: true,
          kept: true,
          reply: { shareId: PF_CARD.shareId, requestId: 'ser-test-1', ok: true, mt, expiresAt, gwPort: DEFAULT_GW_PORT },
        }),
    })
  }

  it('预取成功 → 一次性消费；再取为 null', async () => {
    const { id } = fakeIdentity()
    const id2: TunnelIdentity = { ...id, account: 'did:youling:zAcct', device: 'did:myco:zPhoneDev' }
    const pc = pfPc('MT-PF')
    const pre = await prefetchShareEntry(PF_CARD, pfDeps(pc, id2))
    expect(pre?.mt).toBe('MT-PF')
    const got = takePrefetchedEntry(PF_CARD, Date.now())
    expect(got?.mt).toBe('MT-PF')
    expect(takePrefetchedEntry(PF_CARD, Date.now())).toBeNull()
  }, 15000)

  it('点卡命中预取票 → 不再发取票请求（sendControl 零调用）', async () => {
    const { id } = fakeIdentity()
    const id2: TunnelIdentity = { ...id, account: 'did:youling:zAcct', device: 'did:myco:zPhoneDev' }
    const pc = pfPc('MT-PF2')
    await prefetchShareEntry(PF_CARD, pfDeps(pc, id2))
    let controlCalls = 0
    const opened: string[] = []
    const deps = pfDeps(pc, id2, {
      sendControl: async () => {
        controlCalls++
        return { delivered: false }
      },
      openWebView: (url) => {
        opened.push(url)
        return true
      },
    })
    const res = await openSharedTask(PF_CARD, deps)
    expect(res.ok).toBe(true)
    expect(controlCalls).toBe(0)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toContain('MT-PF2')
    if (res.ok) res.proxy.stop()
  }, 15000)

  it('返回再点同一张卡 → 复用上次打开的票（不重发取票）', async () => {
    __resetEntryCaches()
    const { id } = fakeIdentity()
    const id2: TunnelIdentity = { ...id, account: 'did:youling:zAcct', device: 'did:myco:zPhoneDev' }
    // 第一次取票用 MT-REUSE；之后 fake PC 若被再请求会回 MT-OTHER（断言第二次没发请求）
    let call = 0
    const pc = fakePc({
      io: () => {
        call++
        return httpJson(200, {
          ok: true,
          kept: true,
          reply: { shareId: PF_CARD.shareId, requestId: 'ser-test-1', ok: true,
                   mt: call === 1 ? 'MT-REUSE' : 'MT-OTHER', expiresAt: Date.now() + 120_000, gwPort: DEFAULT_GW_PORT },
        })
      },
    })
    let controlCalls = 0
    const opened: string[] = []
    const deps = pfDeps(pc, id2, {
      sendControl: async () => {
        controlCalls++
        return { delivered: false }
      },
      openWebView: (url) => {
        opened.push(url)
        return true
      },
    })
    const first = await openSharedTask(PF_CARD, deps)
    expect(first.ok).toBe(true)
    if (first.ok) first.proxy.stop()
    expect(opened[0]).toContain('MT-REUSE')
    const second = await openSharedTask(PF_CARD, deps)
    expect(second.ok).toBe(true)
    if (second.ok) second.proxy.stop()
    expect(opened[1]).toContain('MT-REUSE')   // 复用同一张票
    expect(controlCalls).toBe(1)              // 只有第一次走取票；第二次复用票、零取票
  }, 20000)
})
