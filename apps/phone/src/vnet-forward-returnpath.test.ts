/**
 * vnet-forward-returnpath.test.ts — **手机 vnet 固定口转发"服务端响应回不到手机"** 回归。
 *
 * 真机现象（2026-10-23，Honor MBH-AN10 / app 0.3.156）：13911（HTTP，响应慢、多帧）
 * 有回程；22/3389/25037（连接后立刻一帧小 banner/X.224）全部"上行到达、下行丢失"。
 *
 * 本文件用**生产代码原样**复现整条链：
 *   vnet-forward.onConn/onData（真）→ nativeSocketFactory + installNativeBridge（真）
 *   → 假 MycoShell（忠实模拟 android-shell：bridge 方法同步、wsOpened/wsData/wsClosed
 *   经 setTimeout 异步投递 = evaluateJavascript）→ 假"PC"（tunnel-testkit 的
 *   node:crypto 版 Rust responder + 忠实 tunnel_serve 时序：收到手机 CONFIRM 后才拨
 *   目标端口、pump_up 首帧带 idle-flush 延迟）→ 三种目标服务形态：
 *     · banner22  —— 连接即发 SSH banner（服务端主动首发）
 *     · rdp3389   —— 收到 X.224 CR 后 ~2ms 回 CC（请求-即时应答）
 *     · http13911 —— 收到请求后 ~120ms 分两帧回 HTTP（慢响应）
 *
 * 断言口径：三种形态的回程都必须到达本地 socket（等价于真机 nc/curl 收到字节）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import crypto from 'node:crypto'

// ── 全局桩（必须在动态 import 业务模块之前装好：identity.ts 模块加载即读 localStorage）──
const store = new Map<string, string>()
const g = globalThis as unknown as Record<string, unknown>
g.window = globalThis
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
}

const PC_DID = 'did:myco:z6MkgFakePcDevice01'
const realFetch = globalThis.fetch
g.fetch = async (input: unknown): Promise<unknown> => {
  const url = String((input as { url?: string } | undefined)?.url ?? input ?? '')
  if (url.includes('/presence/list')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            did: PC_DID,
            addrs: { ipv6List: ['3fff:3a01:fake::1', '3fff:3a01:fake::2'], port: 9100 },
          },
        ],
      }),
    }
  }
  return realFetch(input as RequestInfo)
}

// ── 动态 import（在全局桩就位后）──
type Fwd = typeof import('./vnet-forward')
type Np = typeof import('./native-proxy')
type P2p = typeof import('./p2p-tunnel')
type Kit = typeof import('./tunnel-testkit')
let fwd: Fwd
let np: Np
let p2p: P2p
let kit: Kit
type RustIo = InstanceType<Kit['RustFrameIo']>

// ── 目标服务形态（PC 上 127.0.0.1:<port> 的替身）──
interface TargetConn {
  write(pt: Uint8Array): void
  closeFromServer(): void
}
interface TargetServer {
  connect(onData: (pt: Uint8Array) => void): TargetConn
  upstream: Uint8Array[]
}
function text(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}
/** 连接即发 banner（sshd 形态：不等人问，先说话）。 */
function bannerServer(banner: string): TargetServer {
  const s: TargetServer = {
    upstream: [],
    connect(onData) {
      setTimeout(() => onData(text(banner)), 0)
      return {
        write(pt) {
          s.upstream.push(pt)
        },
        closeFromServer() {},
      }
    },
  }
  return s
}
/** 请求-应答（X.224 CC / 其它即时回显形态）。 */
function echoServer(delayMs: number, reply: (req: Uint8Array) => Uint8Array[]): TargetServer {
  const s: TargetServer = {
    upstream: [],
    connect(onData) {
      return {
        write(pt) {
          s.upstream.push(pt)
          for (const r of reply(pt)) setTimeout(() => onData(r), delayMs)
        },
        closeFromServer() {},
      }
    },
  }
  return s
}
/** 慢 HTTP：等一会再分两帧回（13911 形态）。 */
function slowHttpServer(delayMs: number): TargetServer {
  return echoServer(delayMs, () => [
    text('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\n'),
    text('no token'),
  ])
}

// ── 假"PC"（tunnel_serve 忠实时序替身，逐腿一条）──
const TIMING = { oneWayMs: 8, dialMs: 4 }
interface PcLeg {
  fromJs(frame: Uint8Array): void
  closeByPhone(): void
}
function spawnPcLeg(
  wsId: string,
  headers: Record<string, string>,
  target: TargetServer,
): PcLeg {
  const raw = headers[p2p.TUNNEL_HANDSHAKE_HEADER] ?? '{}'
  const eph = crypto.generateKeyPairSync('x25519')
  const myPub = kit.rawPub(eph.publicKey)
  let io: RustIo | null = null
  let phase = 0
  let conn: TargetConn | null = null
  const dialQueue: Uint8Array[] = [] // Rust：拨完才起 pump，拨号期间到达的帧由 WS rx 缓冲
  const deliver = (frame: Uint8Array, delayMs: number): void => {
    setTimeout(() => {
      const bridge = (globalThis as unknown as Record<string, { wsData: (id: string, b64: string) => void }>)[np.TUNNEL_CALLBACK_NAME]
      bridge?.wsData(wsId, p2p.toB64(frame))
    }, delayMs)
  }
  const leg: PcLeg = {
    fromJs(frame) {
      if (phase === 0) {
        // 读 HELLO → 回 HELLO_ACK → 发 CONFIRM（先发确认帧再收——与 Rust 同）
        const ctClient = p2p.parseHello(frame)
        const keys = kit.rustDerive(eph.privateKey, ctClient, ctClient, myPub, raw)
        io = new kit.RustFrameIo(keys, 'responder', raw)
        phase = 1
        deliver(p2p.helloFrame(myPub), TIMING.oneWayMs)
        deliver(io.confirmFrame(), TIMING.oneWayMs + 1)
        return
      }
      if (phase === 1) {
        // 收到手机 CONFIRM → 加密握手完成 → 拨目标端口 → 双向泵
        io!.acceptConfirm(frame)
        phase = 2
        setTimeout(() => {
          if (!legClosed) {
            conn = target.connect((pt) => {
              // pump_up：seal → feed → idle-flush(~2ms) → WS → oneWay 到手机
              deliver(io!.seal(pt), TIMING.oneWayMs + 2)
            })
            for (const pt of dialQueue.splice(0)) conn.write(pt)
          }
        }, TIMING.dialMs)
        return
      }
      const pt = io!.open(frame)
      if (conn) conn.write(pt)
      else dialQueue.push(pt)
    },
    closeByPhone() {
      legClosed = true
      conn?.closeFromServer()
    },
  }
  let legClosed = false
  return leg
}

// ── 假 MycoShell（= MainActivity 桥面，语义逐条对齐 android-shell）──
const localConns = new Map<string, { received: Uint8Array[]; closedWhy: string | null }>()
let connSeq = 0
let currentTarget: TargetServer = bannerServer('x')
const pcs = new Map<string, PcLeg>()
/** 最近一次 tunnelOpenWs 的 wsId（机制测试直驱桥投递用）。 */
let lastWsId = ''

interface LocalClient {
  entry: { received: Uint8Array[]; closedWhy: string | null }
  send(bytes: Uint8Array): void
  waitReceived(ms: number): Promise<Uint8Array[]>
}
function clientConnect(localPort: number): LocalClient {
  const connId = ++connSeq
  const key = `${localPort}:${connId}`
  const entry = { received: [] as Uint8Array[], closedWhy: null as string | null }
  localConns.set(key, entry)
  // ForwardCallbacks：原生事件经 w.post(→ evaluateJavascript) 异步进 JS
  setTimeout(() => (globalThis as unknown as { __mycoFwd: { onConn: (p: number, id: number) => void } }).__mycoFwd.onConn(localPort, connId), 0)
  return {
    entry,
    send(bytes) {
      setTimeout(
        () =>
          (globalThis as unknown as { __mycoFwd: { onData: (p: number, id: number, b64: string) => void } }).__mycoFwd
            .onData(localPort, connId, fwd.b64encode(bytes)),
        0,
      )
    },
    async waitReceived(ms: number): Promise<Uint8Array[]> {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        if (entry.received.length > 0) break
        await new Promise((r) => setTimeout(r, 10))
      }
      return entry.received
    },
  }
}

beforeAll(async () => {
  fwd = await import('./vnet-forward')
  np = await import('./native-proxy')
  p2p = await import('./p2p-tunnel')
  kit = await import('./tunnel-testkit')
  const ident = await import('./identity')

  // 身份就绪（plain 设备钥；签名走真 signFriendHandshake）
  const seed = crypto.randomBytes(32)
  expect(ident.adoptDeviceKey(Buffer.from(seed).toString('base64'))?.did).toBeTruthy()

  // 真 JS 桥（native-proxy 的 table）：假壳的 wsData 投递走它，msgCbs 语义=生产
  np.installNativeBridge()

  g.MycoShell = {
    vnetForwardStart: () => '{"ok":true}',
    vnetForwardStop: () => undefined,
    vnetForwardList: () => '{"ok":true,"forwards":[]}',
    vnetForwardSend: (localPort: number, connId: number, b64: string) => {
      localConns.get(`${localPort}:${connId}`)?.received.push(fwd.b64decode(b64))
    },
    vnetForwardClose: (localPort: number, connId: number, why: string) => {
      const e = localConns.get(`${localPort}:${connId}`)
      if (e && e.closedWhy === null) e.closedWhy = why
    },
    tunnelOpenWs: (wsId: string, url: string, headersJson: string) => {
      lastWsId = wsId
      const headers = JSON.parse(headersJson) as Record<string, string>
      const connectMs = url.includes('fake::1') ? 12 : url.includes('fake::2') ? 20 : 60
      setTimeout(() => {
        if (pcs.has(wsId)) return
        pcs.set(wsId, spawnPcLeg(wsId, headers, currentTarget))
        ;(globalThis as unknown as Record<string, { wsOpened: (id: string, e: string) => void }>)[np.TUNNEL_CALLBACK_NAME].wsOpened(wsId, '')
      }, connectMs)
      return ''
    },
    tunnelWsSend: (wsId: string, b64: string) => {
      pcs.get(wsId)?.fromJs(fwd.b64decode(b64))
    },
    tunnelWsClose: (wsId: string) => {
      pcs.get(wsId)?.closeByPhone()
    },
    relayPredial: () => 'OK',
  }
})

async function runCase(
  localPort: number,
  targetPort: number,
  target: TargetServer,
  clientWrites: (c: LocalClient) => void,
): Promise<{ received: Uint8Array[]; upstream: Uint8Array[]; closedWhy: string | null }> {
  currentTarget = target
  fwd.saveForwards([
    ...fwd
      .loadForwards()
      .filter((f) => f.localPort !== localPort),
    { localPort, device: PC_DID, port: targetPort, enabled: true },
  ])
  fwd.bootVnetForwards()
  const c = clientConnect(localPort)
  clientWrites(c)
  const received = await c.waitReceived(1500)
  await new Promise((r) => setTimeout(r, 50))
  return { received, upstream: target.upstream, closedWhy: c.entry.closedWhy }
}

describe('手机 vnet 固定口转发：服务端响应必须回到本地 socket（真机 4/4 复现的回归）', () => {
  it('端口 22 形态（服务端连接即发 SSH banner）——banner 必须回到本地口', async () => {
    const r = await runCase(22022, 22, bannerServer('SSH-2.0-OpenSSH_9.8\r\n'), () => {})
    expect(r.upstream.length).toBe(0) // SSH 客户端先等 banner，无上行
    expect(r.received.map((x) => new TextDecoder().decode(x)).join('')).toBe('SSH-2.0-OpenSSH_9.8\r\n')
  })

  it('端口 3389 形态（X.224 CR → 立即回 CC）——CC 必须回到本地口', async () => {
    const x224cr = Uint8Array.from([3, 0, 0, 19, 14, 0xe0, 0, 0, 0, 0, 0, 1, 0, 8, 0, 3, 0, 0, 0])
    const cc = Uint8Array.from([3, 0, 0, 11, 6, 0xd0, 0, 0, 0x12, 0x34, 0])
    const r = await runCase(23389, 3389, echoServer(2, () => [cc]), (c) => c.send(x224cr))
    expect(Buffer.from(r.upstream[0] ?? []).equals(Buffer.from(x224cr))).toBe(true) // 上行到达目标
    expect(r.received.map((x) => new TextDecoder().decode(x)).join('')).toBe(new TextDecoder().decode(cc))
  })

  it('端口 13911 形态（慢 HTTP 分两帧回）——响应必须回到本地口（现行即通的基线）', async () => {
    const r = await runCase(
      23911,
      13911,
      slowHttpServer(120),
      (c) => c.send(text('GET /gw/sh-1/ HTTP/1.1\r\nHost: x\r\n\r\n')),
    )
    const got = r.received.map((x) => new TextDecoder().decode(x)).join('')
    expect(got).toContain('HTTP/1.1 401')
    expect(got).toContain('no token')
  })
})

// ════════════════ 机制直击：两个修复点的最小单元 ════════════════

describe('修复机制 ①：nativeSocketFactory 无订阅者期间到达的帧入队、订阅时同步补投', () => {
  it('wsData 先到（无人订阅）→ onMessage 后挂 → 同步补投、一帧不丢、顺序不变', async () => {
    const factory = np.nativeSocketFactory()
    const pending = factory(
      'ws://[3fff:3a01:fake::1]:9100/p2p/tunnel?v=2',
      { [p2p.TUNNEL_HANDSHAKE_HEADER]: '{"v":2}', [p2p.TUNNEL_AUTH_HEADER]: 'x.1.y' },
      new AbortController().signal,
    )
    await new Promise((r) => setTimeout(r, 40)) // 等 wsOpened（假壳异步连接）
    const socket = await pending
    // 无人订阅时原生连投两帧（= 真机 offMsg→onConn 挂回调窗口内的 wsData 投递）
    const bridge = (globalThis as unknown as Record<string, { wsData: (id: string, b64: string) => void }>)[np.TUNNEL_CALLBACK_NAME]
    bridge.wsData(lastWsId, p2p.toB64(text('SSH-2.0-OpenSSH_9.8\r\n')))
    bridge.wsData(lastWsId, p2p.toB64(Uint8Array.from([1, 2])))
    await new Promise((r) => setTimeout(r, 20))
    // 后挂订阅：排队帧必须**同步**补投（同 tick、顺序保持）
    const got: Uint8Array[] = []
    socket.onMessage((d) => got.push(d))
    expect(got.map((x) => new TextDecoder().decode(x))).toEqual(['SSH-2.0-OpenSSH_9.8\r\n', '\x01\x02'])
    socket.close(1000, 'done')
  })
})

describe('修复机制 ②：openTunnel 握手期挤进 inbox 的下行帧 → earlyFrames 交给调用方', () => {
  it('服务端 CONFIRM 与 banner 同批到达 → earlyFrames 含 banner 且可解', async () => {
    const { pairFactory, rustDerive, RustFrameIo, rawPub } = kit
    const { factory } = pairFactory((_c, s, _url, headers) => {
      const raw = headers[p2p.TUNNEL_HANDSHAKE_HEADER]!
      // 忠实模拟 Rust 侧"先发确认帧再收"+ sshd 形态：CONFIRM 之后**立刻**压一帧 banner
      // （banner 与 CONFIRM 在同一批 wsData 里到达手机 = 真机 coalesce 场景）
      const eph = crypto.generateKeyPairSync('x25519')
      const myPub = rawPub(eph.publicKey)
      let io: InstanceType<typeof RustFrameIo> | null = null
      let phase = 0
      s.onMessage((d) => {
        if (phase === 0) {
          const ctClient = p2p.parseHello(d)
          const keys = rustDerive(eph.privateKey, ctClient, ctClient, myPub, raw)
          io = new RustFrameIo(keys, 'responder', raw)
          phase = 1
          s.send(p2p.helloFrame(myPub))
          s.send(io.confirmFrame())
          s.send(io.seal(text('SSH-2.0-coalesced\r\n'))) // ← 与 CONFIRM 同批的下行数据帧
          return
        }
        if (phase === 1) {
          io!.acceptConfirm(d)
          phase = 2
        }
      })
    })
    const ident = await import('./identity')
    const seed = crypto.randomBytes(32)
    ident.adoptDeviceKey(Buffer.from(seed).toString('base64'))
    const r = await p2p.openTunnel('http://pc:9100', {
      identity: {
        account: 'did:youling:zA',
        device: 'did:myco:zB',
        sign: async () => 'ZmFrZQ==',
      },
      targetPort: 22,
      factory,
    })
    expect(r.earlyFrames.length).toBe(1)
    const pt = r.io.open(r.earlyFrames[0])
    expect(new TextDecoder().decode(pt)).toBe('SSH-2.0-coalesced\r\n')
  })
})
