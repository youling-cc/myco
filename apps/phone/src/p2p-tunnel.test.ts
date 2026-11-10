/**
 * p2p-tunnel.test.ts — 手机侧隧道 v2 线协议的**对齐锚点**。
 *
 * 分两层证据：
 *  ① **跨实现对拍**（最有说服力）：本文件用 `node:crypto`（= OpenSSL）按
 *     `apps/home/src-tauri/src/p2p_tunnel.rs` 的服务端行为**独立实现一遍 responder**，
 *     让被测客户端与它跑完真握手 + 真数据帧往返。两者一致 ⇒ 与 PC 端线协议一致
 *     （Rust 侧用的是 ed25519-dalek/x25519-dalek/aes-gcm/hkdf/hmac 同一套原语）。
 *  ② **纯函数单测**：帧布局、序号/重放/篡改/前缀/确认不一致、候选合并、并行选路。
 *
 * 环境：vitest `node`（无 DOM、无 WebSocket）——所以传输层走内存对（见 `memPair()`）。
 */
import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { x25519 } from '@noble/curves/ed25519.js'
import {
  FrameIo,
  TunnelFrameError,
  buildTunnelHandshake,
  buildCandidates,
  deriveSessionKeys,
  formatHostPort,
  fromB64,
  helloFrame,
  httpToWs,
  isRelayBase,
  mergeCandidates,
  nextNonce,
  noRouteHint,
  nonceFor,
  openTunnel,
  parseHello,
  parseRelayAddr,
  raceCandidates,
  relayCandidate,
  relayWsUrl,
  tunnelAuthHeader,
  tunnelSignMaterial,
  wsToHttp,
  DEFAULT_P2P_PORT,
  FRAME_DATA_HEADER,
  FRAME_MAGIC,
  RELAY_LEG_DELAY_MS,
  RELAY_LEG_TIMEOUT_MS,
  RELAY_PORT,
  TUNNEL_HANDSHAKE_HEADER,
  TUNNEL_AUTH_HEADER,
  type Candidate,
  type FrameIo as FrameIoType,
  type TunnelSocket,
  type TunnelSocketFactory,
} from './p2p-tunnel'
import {
  attachRustServer,
  pairFactory,
  rawPub,
  rustDerive,
  RustFrameIo,
} from './tunnel-testkit'

// ══════════════════ 共享脚手架（内存线 + node:crypto 版 Rust 服务端） ══════════════════
// 见 tunnel-testkit.ts：那边的 RustFrameIo 是用 node:crypto(OpenSSL) **独立实现**一遍
// p2p_tunnel.rs 的服务端行为，作为线协议对拍基准（不是把被测代码抄一遍）。

/** 固定身份的假 identity（设备钥用假签名——服务端在测试里不做验签）。 */
function fakeIdentity(): { account: string; device: string; sign: (m: string) => Promise<string | null>; signed: string[] } {
  const signed: string[] = []
  return {
    account: 'did:youling:zTestAccount',
    device: 'did:myco:zTestDevice',
    signed,
    sign: async (m: string) => {
      signed.push(m)
      return 'ZmFrZXNpZw==' // base64("fakesig")
    },
  }
}

// ══════════════════ ① 跨实现对拍 ══════════════════

describe('跨实现对拍：手机 TS 客户端 ↔ node:crypto 版 Rust 服务端', () => {
  it('完整握手 + 双向数据帧往返（真帧、真密钥、真 AEAD）', async () => {
    const seen: Record<string, string> = {}
    const holder: { srv: ReturnType<typeof attachRustServer> | null } = { srv: null }
    // "服务端"用**请求头里的握手原文**挂上（那就是签名载荷与 HKDF salt 的那一串）
    const { factory, servers, urls } = pairFactory((_c, s, _url, headers) => {
      const raw = headers[TUNNEL_HANDSHAKE_HEADER]!
      seen.raw = raw
      seen.auth = headers[TUNNEL_AUTH_HEADER]!
      holder.srv = attachRustServer(s, raw)
    })
    const id = fakeIdentity()
    const r = await openTunnel('http://192.168.1.82:9100', {
      identity: id,
      targetPort: 13911,
      factory,
      nonce: () => 'tn-deadbeef',
    })

    // ① 端点 URL（含 ?v=2）与签名材料形状
    expect(urls[0]).toBe('ws://192.168.1.82:9100/p2p/tunnel?v=2')
    const [mDid, mTs, mRaw] = id.signed[0].split('\n')
    expect(mDid).toBe(id.device)
    expect(Number(mTs)).toBeGreaterThan(0)
    expect(mRaw).toBe(seen.raw)
    expect(seen.auth.startsWith(`${id.device}.`)).toBe(true)
    // 信封原文（serde 字段序）——这也是 HKDF salt 的最后一个分量
    expect(seen.raw).toBe(
      '{"v":2,"port":13911,"account":"did:youling:zTestAccount","device":"did:myco:zTestDevice",' +
        '"origin":"did:myco:zTestDevice","nonce":"tn-deadbeef","cap":["resume"]}',
    )

    const srv = holder.srv
    expect(srv).not.toBeNull()

    // ② 数据帧：TS 客户端 → node/Rust 版服务端
    const got: Uint8Array[] = []
    r.socket.onMessage((d) => {
      got.push(r.io.open(d))
    })
    r.socket.send(r.io.seal(new TextEncoder().encode('GET /gw/sh-1/ HTTP/1.1\r\n\r\n')))
    await new Promise((res) => setTimeout(res, 10))
    expect(Buffer.from(srv!.plaintexts[0]).toString()).toBe('GET /gw/sh-1/ HTTP/1.1\r\n\r\n')

    // ③ 数据帧：node/Rust 版服务端 → TS 客户端
    srv!.serverSends('HTTP/1.1 200 OK\r\n\r\nhello')
    await new Promise((res) => setTimeout(res, 10))
    expect(new TextDecoder().decode(got[0])).toBe('HTTP/1.1 200 OK\r\n\r\nhello')
    expect(servers.length).toBe(1)
  })

  it('帧布局逐字节对齐（hex 证据）', async () => {
    // 用固定密钥直接构造帧，hex 可复现（报告里贴的就是这一段）
    const shared = new Uint8Array(32).fill(0x11)
    const ctClient = new Uint8Array(32).fill(0x22)
    const ctServer = new Uint8Array(32).fill(0x33)
    const keys = deriveSessionKeys(shared, ctClient, ctServer, '{"v":2}')
    const io = new FrameIo(keys, 'originator', '{"v":2}')
    const frame = io.seal(new TextEncoder().encode('AB'))
    const hex = Buffer.from(frame).toString('hex')
    // MAGIC "MET2" = 4d455432；ver=01；type=03(DATA)；seq=0000000000000000；prefix=okm[64:76]
    expect(hex.startsWith('4d455432' + '01' + '03' + '0000000000000000')).toBe(true)
    expect(Buffer.from(frame.subarray(14, 26)).toString('hex')).toBe(Buffer.from(keys.prefix).toString('hex'))
    expect(frame.length).toBe(FRAME_DATA_HEADER + 2 + 16)
    // 确认帧形状
    expect(Buffer.from(io.confirmFrame()).toString('hex').startsWith('4d4554320102')).toBe(true)
    expect(io.confirmFrame().length).toBe(38)
  })

  it('HKDF 派生与 salt 口径：ct_client 恒在 ct_server 之前（与 node 版同输入同输出）', () => {
    const a = deriveSessionKeys(new Uint8Array(32).fill(9), new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), 'h')
    const b = deriveSessionKeys(new Uint8Array(32).fill(9), new Uint8Array(32).fill(2), new Uint8Array(32).fill(1), 'h')
    expect(Buffer.from(a.c2s).equals(Buffer.from(b.c2s))).toBe(false)
    // 与 node(OpenSSL) 版**同输入必须同输出**——这是"密钥派生对齐"的硬证据
    const eph = crypto.generateKeyPairSync('x25519')
    const myPriv = new Uint8Array(crypto.randomBytes(32))
    const myPubObj = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(x25519.getPublicKey(myPriv))]),
      format: 'der',
      type: 'spki',
    })
    const shared = new Uint8Array(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: myPubObj }))
    const ref = rustDerive(eph.privateKey, x25519.getPublicKey(myPriv), new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), 'h')
    // node 侧的 shared 必须与 TS 侧由同一对钥算出的一致
    const tsShared = x25519.getSharedSecret(myPriv, rawPub(eph.publicKey))
    expect(Buffer.from(tsShared).toString('hex')).toBe(Buffer.from(shared).toString('hex'))
    const ts = deriveSessionKeys(tsShared, new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), 'h')
    expect(Buffer.from(ts.prefix).toString('hex')).toBe(Buffer.from(ref.prefix).toString('hex'))
    expect(Buffer.from(ts.c2s).toString('hex')).toBe(Buffer.from(ref.c2s).toString('hex'))
    expect(Buffer.from(ts.confirmS2c).toString('hex')).toBe(Buffer.from(ref.confirmS2c).toString('hex'))
  })
})

// ══════════════════ ② 帧层安全语义 ══════════════════

/**
 * 一条隧道的两端（固定密钥）：发端 originator（tx=c2s），收端 responder（rx=c2s）。
 * ⚠️ 方向必须配对——同角色两端加解密用**不同**的方向密钥，这是协议要的（c2s/s2c 分向）。
 */
function fixedPair(): { tx: FrameIoType; rx: FrameIoType } {
  const keys = () =>
    deriveSessionKeys(new Uint8Array(32).fill(7), new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), 'hs')
  return { tx: new FrameIo(keys(), 'originator', 'hs'), rx: new FrameIo(keys(), 'responder', 'hs') }
}
function fixedIo(role: 'originator' | 'responder' = 'originator'): FrameIoType {
  const keys = deriveSessionKeys(new Uint8Array(32).fill(7), new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), 'hs')
  return new FrameIo(keys, role, 'hs')
}

describe('帧层：往返 / 重放 / 篡改 / 前缀 / 确认', () => {
  it('加解密往返（含空载荷与 16KB 块）', () => {
    for (const pt of [new Uint8Array(0), new TextEncoder().encode('hi'), new Uint8Array(16384).fill(0xab)]) {
      const { tx, rx } = fixedPair()
      const back = rx.open(tx.seal(pt))
      expect(Buffer.from(back).equals(Buffer.from(pt))).toBe(true)
    }
  })

  it('重放被拒：同一帧收两次第二次必须 replay-or-out-of-order', () => {
    const { tx, rx } = fixedPair()
    const f = tx.seal(new TextEncoder().encode('once'))
    expect(new TextDecoder().decode(rx.open(f))).toBe('once')
    let err: unknown
    try {
      rx.open(f)
    } catch (e) {
      err = e
    }
    expect((err as TunnelFrameError).code).toBe('replay-or-out-of-order')
  })

  it('乱序被拒：seq 2 之后再收 seq 1', () => {
    const { tx, rx } = fixedPair()
    const f1 = tx.seal(new TextEncoder().encode('1'))
    const f2 = tx.seal(new TextEncoder().encode('2'))
    rx.open(f2)
    expect(() => rx.open(f1)).toThrowError(/序号非递增/)
  })

  it('篡改密文被拒：auth-fail（且不推进 recvMaxSeq）', () => {
    const { tx, rx } = fixedPair()
    const a = tx.seal(new TextEncoder().encode('aaa'))
    const b = tx.seal(new TextEncoder().encode('bbb'))
    const bad = a.slice()
    bad[bad.length - 1] ^= 0x01
    let err: unknown
    try {
      rx.open(bad)
    } catch (e) {
      err = e
    }
    expect((err as TunnelFrameError).code).toBe('auth-fail')
    // 坏帧没有推进序号 → 正确的 seq0 仍可收（证明"坏帧不能把序号推到未来"）
    expect(new TextDecoder().decode(rx.open(a))).toBe('aaa')
    expect(new TextDecoder().decode(rx.open(b))).toBe('bbb')
  })

  it('nonce 前缀不符被拒：prefix-mismatch（换钥/串台）', () => {
    const { rx } = fixedPair()
    const other = new FrameIo(
      deriveSessionKeys(new Uint8Array(32).fill(7), new Uint8Array(32).fill(3), new Uint8Array(32).fill(4), 'hs'),
      'originator',
      'hs',
    )
    const f = other.seal(new TextEncoder().encode('x'))
    let err: unknown
    try {
      rx.open(f)
    } catch (e) {
      err = e
    }
    expect((err as TunnelFrameError).code).toBe('prefix-mismatch')
  })

  it('明文/异协议帧被拒（不含 MAGIC）', () => {
    const { rx } = fixedPair()
    let err: unknown
    try {
      rx.open(new TextEncoder().encode('GET / HTTP/1.1\r\n\r\n'))
    } catch (e) {
      err = e
    }
    expect((err as TunnelFrameError).code).toBe('plaintext-or-unknown-frame')
  })

  it('数据阶段收到 HELLO 帧被拒（38B < 头+tag → auth-fail，与 Rust 检查顺序一致）', () => {
    // Rust `FrameIo::open` 的顺序是：魔数 → **长度** → 版本 → 类型……
    // 38B 的 HELLO 帧过不了 `len < HEADER+16` 这一关 → AuthFail（不是 unknown-frame）。
    // 本用例把这个"顺序"锁住：谁把类型检查提前，这里就会红。
    const { rx } = fixedPair()
    let err: unknown
    try {
      rx.open(helloFrame(new Uint8Array(32).fill(5)))
    } catch (e) {
      err = e
    }
    expect((err as TunnelFrameError).code).toBe('auth-fail')
  })

  it('数据阶段收到足够长的 CONFIRM 型帧被拒：plaintext-or-unknown-frame', () => {
    const { rx } = fixedPair()
    const f = new Uint8Array(FRAME_DATA_HEADER + 16)
    f.set(FRAME_MAGIC, 0)
    f[4] = 1
    f[5] = 2 // CONFIRM
    let err: unknown
    try {
      rx.open(f)
    } catch (e) {
      err = e
    }
    expect((err as TunnelFrameError).code).toBe('plaintext-or-unknown-frame')
  })

  it('确认帧 MAC 被篡改 → confirm-mismatch（MITM/降级）', () => {
    const a = fixedIo('originator')
    const b = fixedIo('responder')
    // 同一套 keys、角色相反：a 的确认帧正是 b 期望的那条（方向键对称）——
    // 这正是协议要的"两端对称可互验"。篡改一个 bit 就必须失败。
    expect(() => b.acceptConfirm(a.confirmFrame())).not.toThrow()
    const bad = a.confirmFrame()
    bad[bad.length - 1] ^= 0x01
    expect(() => b.acceptConfirm(bad)).toThrowError(/密钥确认失败/)
  })

  it('确认帧长度/魔数不对 → hello-malformed（先挡结构）', () => {
    const b = fixedIo('responder')
    expect(() => b.acceptConfirm(new Uint8Array(10))).toThrowError(/握手帧无效/)
  })

  it('ECDH 全 0（低阶点）被拒：key-rejected', () => {
    let err: unknown
    try {
      deriveSessionKeys(new Uint8Array(32), new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), 'h')
    } catch (e) {
      err = e
    }
    expect((err as TunnelFrameError).code).toBe('key-rejected')
  })

  it('nonce = prefix 末 8 字节大端异或 seq', () => {
    const prefix = new Uint8Array(12).fill(0xff)
    const n0 = nonceFor(prefix, 0n)
    const n1 = nonceFor(prefix, 1n)
    expect(Buffer.from(n0.subarray(0, 4)).toString('hex')).toBe('ffffffff')
    expect(Buffer.from(n0.subarray(4)).toString('hex')).toBe('ffffffffffffffff')
    expect(Buffer.from(n1.subarray(4)).toString('hex')).toBe('fffffffffffffffe')
  })
})

// ══════════════════ ③ 握手信封 / URL ══════════════════

describe('握手信封与 URL 形态（与 Rust 逐字对齐）', () => {
  it('信封 JSON 键顺序 = serde 结构体声明顺序，紧凑无空格', () => {
    const raw = buildTunnelHandshake('did:youling:zA', 'did:myco:zD', 'did:myco:zD', 13911, 'tn-01')
    expect(raw).toBe('{"v":2,"port":13911,"account":"did:youling:zA","device":"did:myco:zD","origin":"did:myco:zD","nonce":"tn-01","cap":["resume"]}')
  })

  it('签名载荷 = did\\nts\\n信封原文，auth 头 = did.ts.sig', () => {
    const m = tunnelSignMaterial('did:myco:zD', 1700000000000, '{"v":2}')
    expect(m).toBe('did:myco:zD\n1700000000000\n{"v":2}')
    expect(tunnelAuthHeader('did:myco:zD', 1700000000000, 'SIG')).toBe('did:myco:zD.1700000000000.SIG')
  })

  it('http→ws 与 ws→http 互逆（含 v=2 与尾斜杠归一）', () => {
    expect(httpToWs('http://192.168.1.82:9100')).toBe('ws://192.168.1.82:9100/p2p/tunnel?v=2')
    expect(httpToWs('https://a.example/')).toBe('wss://a.example/p2p/tunnel?v=2')
    expect(httpToWs('ws://a.example')).toBe('ws://a.example/p2p/tunnel?v=2')
    expect(wsToHttp('ws://192.168.1.82:9100/p2p/tunnel?v=2')).toBe('http://192.168.1.82:9100')
    expect(wsToHttp(httpToWs('http://[fe80::1]:9100'))).toBe('http://[fe80::1]:9100')
  })

  it('IPv6 host:port 走方括号（与 Rust format_host_port 同口径）', () => {
    expect(formatHostPort('192.168.1.82', 9100)).toBe('192.168.1.82:9100')
    expect(formatHostPort('3ffe:8207::1', 9100)).toBe('[3ffe:8207::1]:9100')
  })

  it('nonce 形状 tn-<32hex> 且每次不同', () => {
    const a = nextNonce()
    const b = nextNonce()
    expect(a).toMatch(/^tn-[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
  })

  it('头名常量与 Rust 一致（改了就是协议破坏）', () => {
    expect(TUNNEL_HANDSHAKE_HEADER).toBe('x-myco-tunnel')
    expect(TUNNEL_AUTH_HEADER).toBe('x-myco-auth')
  })
})

// ══════════════════ ④ 候选装配与合并 ══════════════════

describe('候选装配（lan → publicV4 → reflexive → ipv6，缓存最前）', () => {
  it('mergeCandidates 去重保序（缓存优先，尾斜杠归一）', () => {
    const got = mergeCandidates('http://a:1/', ['http://a:1', 'http://b:2'], ['http://c:3'])
    expect(got).toEqual(['http://a:1', 'http://b:2', 'http://c:3'])
  })

  it('buildCandidates 按类型排布 + 去重（形状对齐 addrs_json 的 *List/单值双键）', () => {
    const c = buildCandidates({
      lanList: ['192.168.1.82'],
      publicV4List: ['1.2.3.4'],
      reflexiveList: ['5.6.7.8'],
      ipv6List: ['3ffe::1', '3ffe::2'],
      port: 9100,
    })
    expect(c.map((x) => x.kind)).toEqual(['lan', 'publicV4', 'reflexive', 'ipv6', 'ipv6'])
    expect(c[0].base).toBe('http://192.168.1.82:9100')
    expect(c[3].base).toBe('http://[3ffe::1]:9100')
    // 单值键（旧/手工上报）也认
    const single = buildCandidates({ lan: '192.168.1.5', publicV4: '203.0.113.7', ipv6: '3fff::9', port: 9100 })
    expect(single.map((x) => x.base)).toEqual([
      'http://192.168.1.5:9100',
      'http://203.0.113.7:9100',
      'http://[3fff::9]:9100',
    ])
  })

  it('收集顺序与 PC 端 p2p_client::peer_from_entry 一致：lan → publicV4 → reflexive → ipv6', () => {
    const c = buildCandidates({
      lanList: ['192.168.1.5', '10.0.0.8'],
      publicV4List: ['203.0.113.7'],
      reflexiveList: ['198.51.100.9'],
      ipv6List: ['3fff:1::2'],
      port: 9100,
    })
    expect(c.map((x) => x.host)).toEqual(['192.168.1.5', '10.0.0.8', '203.0.113.7', '198.51.100.9', '3fff:1::2'])
  })

  it('缓存候选排最前并被标 kinds=cached（下次优先腿）', () => {
    const c = buildCandidates({ lanList: ['192.168.1.82'], port: 9100 }, 'http://192.168.1.82:9100')
    expect(c[0].kind).toBe('cached')
    expect(c.length).toBe(1) // 与 lan 去重
  })

  it('失败人话不含 tunnel/p2p/端口术语', () => {
    const c = buildCandidates({ lanList: ['192.168.1.82'], port: 9100 })
    const hint = noRouteHint('办公室的电脑', c)
    expect(hint).toContain('办公室的电脑')
    expect(hint).toContain('局域网地址')
    expect(hint.toLowerCase()).not.toContain('tunnel')
    expect(hint).not.toContain('p2p')
    expect(hint).not.toContain('端口')
  })
})

// ══════════════════ ⑤ 并行选路（赛跑） ══════════════════

describe('并行选路：同时发起、首个成功即采用、失败人话', () => {
  function cands(...bases: string[]): Candidate[] {
    return bases.map((b, i) => ({ kind: i === 0 ? 'lan' : 'ipv6', host: `h${i}`, port: 9100, base: b }))
  }

  it('四类候选同时发起，最快的胜出（其余被关）', async () => {
    // 每条线一个"服务端"，其 HELLO_ACK/CONFIRM 的回复延迟不同（下标 1 = publicV4 最快）
    const launched: number[] = []
    const slowByIndex = [400, 10, 250, 300]
    const { factory } = pairFactory((_c, s, _url, headers) => {
      const idx = launched.length
      launched.push(idx)
      attachRustServer(s, headers[TUNNEL_HANDSHAKE_HEADER]!)
      const origSend = s.send.bind(s)
      s.send = (d: Uint8Array): void => {
        setTimeout(() => origSend(d), slowByIndex[idx])
      }
    })
    const t0 = Date.now()
    const r = await raceCandidates(cands('http://a:9100', 'http://b:9100', 'http://c:9100', 'http://d:9100'), {
      identity: fakeIdentity(),
      targetPort: 13911,
      factory,
      settleMs: 60,
      perCandidateMs: 900,
      totalBudgetMs: 1800,
    })
    expect(r).not.toBeNull()
    expect(launched.length).toBe(4) // 四条腿都真的发起了（并行，不是串行）
    expect(r!.winner.base).toBe('http://b:9100')
    expect(r!.tried).toBe(4)
    // 预算语义：胜出=最快那条（~10-40ms），远早于总预算
    expect(Date.now() - t0).toBeLessThan(900)
  }, 15000)

  it('全部候选不通 → null（调用方给人话）', async () => {
    const factory: TunnelSocketFactory = async () => {
      throw new Error('connection refused')
    }
    const r = await raceCandidates(cands('http://a:9100', 'http://b:9100'), {
      identity: fakeIdentity(),
      targetPort: 13911,
      factory,
      totalBudgetMs: 400,
    })
    expect(r).toBeNull()
  })

  it('全灭时 onLoser 逐腿回报死因（诊断：null 不再等于"没证据"）', async () => {
    const factory: TunnelSocketFactory = async (url) => {
      throw new Error(String(url).includes('relay') ? '对方设备不在线（云端中转无此设备）' : 'connection refused')
    }
    const seen: string[] = []
    const r = await raceCandidates(cands('http://a:9100', 'http://b:9100'), {
      identity: fakeIdentity(),
      targetPort: 13911,
      factory,
      totalBudgetMs: 400,
      onLoser: (base, why) => seen.push(`${base}→${why}`),
    })
    expect(r).toBeNull()
    expect(seen).toHaveLength(2)
    expect(seen.join('|')).toContain('connection refused')
  })

  it('onLoser 抛异常不影响赛跑裁决（诊断不许拖垮建连）', async () => {
    const factory: TunnelSocketFactory = async () => {
      throw new Error('nope')
    }
    const r = await raceCandidates(cands('http://a:9100'), {
      identity: fakeIdentity(),
      targetPort: 13911,
      factory,
      totalBudgetMs: 300,
      onLoser: () => {
        throw new Error('诊断回调自己炸了')
      },
    })
    expect(r).toBeNull()
  })

  it('零候选不发任何连接', async () => {
    let called = 0
    const r = await raceCandidates([], {
      identity: fakeIdentity(),
      targetPort: 13911,
      factory: async () => {
        called += 1
        throw new Error('nope')
      },
    })
    expect(r).toBeNull()
    expect(called).toBe(0)
  })

  it('单候选超时后仍受整场预算约束（不晚于 budget 返回）', async () => {
    const factory: TunnelSocketFactory = () => new Promise<TunnelSocket>(() => {}) // 永不开
    const t0 = Date.now()
    const r = await raceCandidates(cands('http://a:9100'), {
      identity: fakeIdentity(),
      targetPort: 13911,
      factory,
      perCandidateMs: 5000,
      totalBudgetMs: 300,
    })
    expect(r).toBeNull()
    expect(Date.now() - t0).toBeLessThan(1200)
  })

  it('服务端 CONFIRM 被篡改 → 建连失败（绝不静默降级）', async () => {
    const { factory, servers } = pairFactory()
    const bad: TunnelSocketFactory = async (url, headers, signal) => {
      const c = await factory(url, headers, signal)
      const s = servers[servers.length - 1]
      const raw = headers[TUNNEL_HANDSHAKE_HEADER]!
      const eph = crypto.generateKeyPairSync('x25519')
      const myPub = rawPub(eph.publicKey)
      s.onMessage((d) => {
        const ctClient = parseHello(d)
        const keys = rustDerive(eph.privateKey, ctClient, ctClient, myPub, raw)
        const io = new RustFrameIo(keys, 'responder', raw)
        s.send(helloFrame(myPub))
        const cf = io.confirmFrame()
        cf[cf.length - 1] ^= 0x01 // 篡改
        s.send(cf)
      })
      return c
    }
    await expect(
      openTunnel('http://a:9100', { identity: fakeIdentity(), targetPort: 13911, factory: bad }),
    ).rejects.toThrow(/密钥确认失败|确认/)
  })
})

/** 取回握手原文的辅助（测试内联用）。 */

// ══════════════════ ⑦ 云端中继腿（2026-10-11；对齐 PC 端 cloud_relay.rs / relay_leg） ══════════════════

describe('云端中继腿：URL 形态 / 候选装配 / 让先 / 兜底胜出', () => {
  it('relayWsUrl：relay://<did>@<host>:<port>/p2p/tunnel?v=2（默认 myco.youling.cc:8321）', () => {
    expect(relayWsUrl('did:myco:z6MkTarget')).toBe(
      'relay://did:myco:z6MkTarget@myco.youling.cc:8321/p2p/tunnel?v=2',
    )
    expect(relayWsUrl('did:myco:z6MkTarget', '1.2.3.4:9999')).toBe(
      'relay://did:myco:z6MkTarget@1.2.3.4:9999/p2p/tunnel?v=2',
    )
    // IPv6 认 [..] 形态；无端口补缺省中继口
    expect(relayWsUrl('d', '[3ffe::1]')).toBe('relay://d@[3ffe::1]:8321/p2p/tunnel?v=2')
    expect(parseRelayAddr('[3ffe::1]:9443')).toEqual({ host: '3ffe::1', port: 9443 })
    expect(parseRelayAddr('example.com')).toEqual({ host: 'example.com', port: RELAY_PORT })
    expect(parseRelayAddr('  ')).toEqual({ host: 'myco.youling.cc', port: RELAY_PORT })
  })

  it('httpToWs：relay:// 伪 base 原样透传（拨号信息全在 URL 里，原生壳解析）', () => {
    const u = relayWsUrl('did:myco:z6MkTarget')
    expect(httpToWs(u)).toBe(u)
    expect(isRelayBase(u)).toBe(true)
    expect(isRelayBase('relay://cloud')).toBe(true)
    expect(isRelayBase('http://1.2.3.4:9100')).toBe(false)
  })

  it('relayCandidate：kind=relay、让先 300ms、预算 2500ms、port=对端 p2p 口（不是中继口）', () => {
    const c = relayCandidate('did:myco:z6MkTarget')
    expect(c.kind).toBe('relay')
    expect(c.delayMs).toBe(RELAY_LEG_DELAY_MS)
    expect(c.timeoutMs).toBe(RELAY_LEG_TIMEOUT_MS)
    expect(c.port).toBe(DEFAULT_P2P_PORT)
    expect(c.base.startsWith('relay://did:myco:z6MkTarget@')).toBe(true)
  })

  it('buildCandidates：relay:// 缓存形态不进直连候选表（对齐 PC 端"跳过 relay://"）', () => {
    const out = buildCandidates({ lan: '192.168.1.82' }, relayWsUrl('did:myco:z6MkTarget'))
    expect(out.map((c) => c.kind)).toEqual(['lan'])
    expect(buildCandidates({}, 'relay://cloud')).toHaveLength(0)
  })

  it('让先：同速时直连先胜；让先期间直连已胜出 → 中继腿取消（不白拨）', async () => {
    let dialed = 0
    const { factory } = pairFactory((_c, s, _url, headers) => {
      dialed += 1
      attachRustServer(s, headers[TUNNEL_HANDSHAKE_HEADER]!)
    })
    const relay: Candidate = { ...relayCandidate('did:myco:z6MkTarget'), delayMs: 80 }
    const r = await raceCandidates(
      [
        { kind: 'lan', host: 'h', port: 9100, base: 'http://a:9100' },
        relay,
      ],
      { identity: fakeIdentity(), targetPort: 13911, factory, settleMs: 30, perCandidateMs: 1200, totalBudgetMs: 2500 },
    )
    expect(r).not.toBeNull()
    expect(r!.winner.base).toBe('http://a:9100') // 同速时直连先胜（让先计入耗时）
    expect(dialed).toBe(1) // 中继腿在让先睡期间赛跑已裁决 → 取消，一条都没白拨
    // 取消记录在让先睡醒后落账（race 返回后一拍）——等它落定再验
    await new Promise((res) => setTimeout(res, 150))
    expect(r!.losers.some((l) => l.base.startsWith('relay://') && l.reason.includes('取消'))).toBe(true)
  }, 10000)

  it('直连全断 → 中继腿胜出（base=relay:// 标记形态；全链真握手 + 真数据帧）', async () => {
    const handles: ReturnType<typeof attachRustServer>[] = []
    const { factory } = pairFactory((_c, s, _url, headers) => {
      handles.push(attachRustServer(s, headers[TUNNEL_HANDSHAKE_HEADER]!))
    })
    const badFactory: TunnelSocketFactory = async (url, headers, signal) => {
      if (!url.startsWith('relay://')) throw new Error('connection refused') // 直连腿全断（AP 隔离）
      return factory(url, headers, signal) // 中继腿照常（原生壳 CONNECT 中继后同款升级）
    }
    const relay: Candidate = { ...relayCandidate('did:myco:z6MkTarget'), delayMs: 20 }
    const r = await raceCandidates(
      [
        { kind: 'lan', host: 'h0', port: 9100, base: 'http://dead1:9100' },
        { kind: 'ipv6', host: 'h1', port: 9100, base: 'http://dead2:9100' },
        relay,
      ],
      { identity: fakeIdentity(), targetPort: 13911, factory: badFactory, perCandidateMs: 1500, totalBudgetMs: 3000 },
    )
    expect(r).not.toBeNull()
    expect(r!.winner.base.startsWith('relay://did:myco:z6MkTarget@')).toBe(true)
    // 不只是建连：胜出的隧道能真收发（AEAD 帧双向往返）
    r!.winner.socket.send(r!.winner.io.seal(new TextEncoder().encode('ping-over-relay')))
    await new Promise((res) => setTimeout(res, 30))
    expect(handles).toHaveLength(1) // 只有中继腿真的拨了（直连腿全断）
    expect(new TextDecoder().decode(handles[0].plaintexts[0] ?? new Uint8Array())).toBe('ping-over-relay')
    const got = await new Promise<Uint8Array>((resolve, reject) => {
      r!.winner.socket.onMessage((f) => {
        try {
          resolve(r!.winner.io.open(f))
        } catch (e) {
          reject(e)
        }
      })
      handles[0].serverSends('pong-over-relay')
      setTimeout(() => reject(new Error('中继腿数据帧超时')), 2000)
    })
    expect(new TextDecoder().decode(got)).toBe('pong-over-relay')
  }, 10000)
})

// ══════════════════ ⑥ 与既有 signAuthHeader 同式（回归锁） ══════════════════

describe('签名材料与既有 signAuthHeader 同式（防将来各写一套）', () => {
  it('手机既有 signAuthHeader 也是 did\\nts\\nbody → 同一把设备钥可直接复用', () => {
    // identity.ts:961 的实现：`${_identity.did}\n${ts}\n${rawBody}`
    const did = 'did:myco:zX'
    const ts = 123
    const body = '{"a":1}'
    expect(tunnelSignMaterial(did, ts, body)).toBe(`${did}\n${ts}\n${body}`)
  })

  it('base64 往返（大 buffer 分块不炸栈）', () => {
    const b = new Uint8Array(200000)
    for (let i = 0; i < b.length; i++) b[i] = i & 0xff
    expect(Buffer.from(fromB64(btoaProbe(b))).equals(Buffer.from(b))).toBe(true)
  })
})

function btoaProbe(b: Uint8Array): string {
  // 走被测的 toB64（动态 import 避免顶部再引一个名字）
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < b.length; i += CH) s += String.fromCharCode(...b.subarray(i, i + CH))
  return btoa(s)
}