/**
 * reverse-tunnel.test.ts — **反向连接**（2026-10-09：PC 主动连手机）的锚点测试。
 *
 * 覆盖四层：
 *  ① WS 服务端基建：accept key（RFC 6455 官方向量）、请求头解析、路径版本闸、
 *     掩码客户端帧 ↔ 不掩码服务端帧；
 *  ② 验签：`x-myco-auth`（did.ts.sig，±60s 窗口，ed25519）；
 *  ③ **服务端角色握手**（核心，"手机做服务端"）：被测 `acceptTunnel` ↔
 *     node:crypto（OpenSSL）独立实现的"PC 发起方"对拍——真 HTTP 升级 + 真 ECDH +
 *     AEAD 帧双向往返；六个闸门（版本/信封/签名/设备一致/预期源设备/nonce 重放）
 *     各有负例；
 *  ④ 连接决策（`decideTunnelRoute`：LAN → 直连 → 反向 → 人话）与反向桥
 *     （`ReverseShareBridge`：浏览器连接直连转发 / 扣等 / 胶合）。
 *
 * 环境：vitest node（无 DOM）——传输层走内存裸字节端（见 `pcNetEnd`/`fakeTap`）。
 */
import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { x25519 } from '@noble/curves/ed25519.js'
import { didFromPubkey } from './didUtil'
import {
  AUTH_WINDOW_MS,
  ReverseShareBridge,
  TUNNEL_DEFAULT_PORTS,
  TunnelAcceptError,
  acceptTunnel,
  buildTunnelHandshake,
  buildUpgradeResponse,
  clearTunnelNoncesForTest,
  decideTunnelRoute,
  helloFrame,
  parseHello,
  parseTunnelAuthHeader,
  parseUpgradeRequest,
  tunnelAuthHeader,
  tunnelNonceIsReplay,
  tunnelPathVersionOk,
  tunnelSignMaterial,
  verifyTunnelAuth,
  wsAcceptKey,
  WsServerCodec,
  type RawTunnelConn,
} from './p2p-tunnel'
import { rustDerive, RustFrameIo } from './tunnel-testkit'

// ══════════════════ 测试脚手架 ══════════════════

const utf8e = (s: string): Uint8Array => new TextEncoder().encode(s)

/**
 * "PC 侧网络端"：write 记录（测试取走分析），feed 注入"收到"的字节。
 * 与 [`RawTunnelConn`] 同面——`pcOriginator` 在它上面跑发起方全流程。
 */
export function pcNetEnd(): RawTunnelConn & { feed(d: Uint8Array): void; written: Uint8Array[] } {
  const chunkCbs: ((d: Uint8Array) => void)[] = []
  const closedCbs: (() => void)[] = []
  const written: Uint8Array[] = []
  let closed = false
  return {
    written,
    feed(d: Uint8Array): void {
      if (closed) return
      for (const cb of [...chunkCbs]) cb(d)
    },
    onChunk(cb) {
      chunkCbs.push(cb)
      return () => {
        const i = chunkCbs.indexOf(cb)
        if (i >= 0) chunkCbs.splice(i, 1)
      }
    },
    onClosed(cb) {
      closedCbs.push(cb)
      return () => {
        const i = closedCbs.indexOf(cb)
        if (i >= 0) closedCbs.splice(i, 1)
      }
    },
    write(d) {
      if (!closed) written.push(d)
    },
    close() {
      if (closed) return
      closed = true
      for (const cb of [...closedCbs]) cb()
    },
  }
}

// ── node:crypto 版"PC 发起方"（对拍基准，不与被测代码共享实现） ──

/** 一个确定性的"PC 设备"（ed25519 设备钥 + did + 签名）。 */
export interface FakePc {
  did: string
  account: string
  sign(material: string): string
}

export function fakePc(seedByte = 0x2a): FakePc {
  const seed = Buffer.alloc(32, seedByte)
  const priv = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  })
  const der = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' })
  const pub = new Uint8Array(der.subarray(der.length - 32))
  const did = didFromPubkey(pub, 'myco')
  return {
    did,
    account: 'did:youling:zPcAccount',
    sign: (material) => crypto.sign(null, Buffer.from(material, 'utf8'), priv).toString('base64'),
  }
}

/** 构造一次完整的发起方 HTTP 升级请求（真签名）。返回信封原文 + 请求字节。 */
export function pcUpgradeRequest(pc: FakePc, port: number, nonce: string, ts: number): { handshake: string; bytes: Uint8Array } {
  const handshake = buildTunnelHandshake(pc.account, pc.did, pc.did, port, nonce)
  const sig = pc.sign(tunnelSignMaterial(pc.did, ts, handshake))
  const head =
    `GET /p2p/tunnel?v=2 HTTP/1.1\r\n` +
    `Host: [3fff::9]:5555\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
    `Sec-WebSocket-Version: 13\r\n` +
    `x-myco-tunnel: ${handshake}\r\n` +
    `x-myco-auth: ${tunnelAuthHeader(pc.did, ts, sig)}\r\n` +
    `\r\n`
  return { handshake, bytes: utf8e(head) }
}

/** WS 客户端帧（**必掩码**——独立于被测的 WsServerCodec 实现）。 */
export function maskClientFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const mask = crypto.randomBytes(4)
  let h: Uint8Array
  if (payload.length < 126) {
    h = new Uint8Array(2)
    h[1] = 0x80 | payload.length
  } else if (payload.length < 65536) {
    h = new Uint8Array(4)
    h[1] = 0x80 | 126
    new DataView(h.buffer).setUint16(2, payload.length, false)
  } else {
    h = new Uint8Array(10)
    h[1] = 0x80 | 127
    new DataView(h.buffer).setBigUint64(2, BigInt(payload.length), false)
  }
  h[0] = 0x80 | opcode
  const masked = new Uint8Array(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3]
  const out = new Uint8Array(h.length + 4 + payload.length)
  out.set(h, 0)
  out.set(new Uint8Array(mask), h.length)
  out.set(masked, h.length + 4)
  return out
}

/** 解析服务端（不掩码）帧 → 二进制载荷数组（忽略控制帧）。 */
export function parseServerFrames(buf: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  let off = 0
  while (off + 2 <= buf.length) {
    const opcode = buf[off] & 0x0f
    let len = buf[off + 1] & 0x7f
    let h = 2
    if (len === 126) {
      len = (buf[off + 2] << 8) | buf[off + 3]
      h = 4
    } else if (len === 127) {
      let l = 0n
      for (let i = 0; i < 8; i++) l = (l << 8n) | BigInt(buf[off + 2 + i])
      len = Number(l)
      h = 10
    }
    if (off + h + len > buf.length) break
    const payload = buf.subarray(off + h, off + h + len)
    if (opcode === 0x2) out.push(new Uint8Array(payload))
    off += h + len
  }
  return out
}

/**
 * 在一条网络端上扮演"PC 发起方"：发升级请求 → HELLO → 收 HELLO_ACK/CONFIRM →
 * 发 CONFIRM → 返回 originator 角色的 RustFrameIo（node:crypto 独立实现）。
 * `sink` 把"发给网络的字节"交给测试（由测试喂给被测端）。
 */
export async function pcOriginator(
  end: RawTunnelConn & { feed(d: Uint8Array): void },
  pc: FakePc,
  port: number,
  opts: { nonce?: string; ts?: number } = {},
): Promise<{ io: RustFrameIo; handshakeRaw: string; send: (pt: Uint8Array) => void; messages: Uint8Array[] }> {
  const ts = opts.ts ?? Date.now()
  const nonce = opts.nonce ?? `tn-${crypto.randomBytes(16).toString('hex')}`
  const { handshake, bytes } = pcUpgradeRequest(pc, port, nonce, ts)
  const messages: Uint8Array[] = []
  let acc = new Uint8Array(0)
  let wake: (() => void) | null = null
  const offChunk = end.onChunk((d) => {
    acc = new Uint8Array([...acc, ...d])
    if (wake) {
      const w = wake
      wake = null
      w()
    }
  })
  const tick = async (): Promise<void> => {
    await new Promise<void>((res) => {
      wake = res
      setTimeout(res, 10)
    })
    wake = null
  }
  const waitBytes = async (n: number, ms = 3000): Promise<Uint8Array> => {
    const t0 = Date.now()
    while (acc.length < n) {
      if (Date.now() - t0 > ms) throw new Error(`等 ${n} 字节超时（实得 ${acc.length}）`)
      await tick()
    }
    const out = acc.subarray(0, n)
    acc = acc.subarray(n)
    return new Uint8Array(out)
  }
  try {
    end.write(bytes)
    // ① 101 响应（读到 \r\n\r\n）
    const t0 = Date.now()
    while (!new TextDecoder('latin1').decode(acc).includes('\r\n\r\n')) {
      if (Date.now() - t0 > 3000) throw new Error('没等到 101（或拒绝响应）')
      await tick()
    }
    const text = new TextDecoder('latin1').decode(acc)
    const idx = text.indexOf('\r\n\r\n')
    if (!text.startsWith('HTTP/1.1 101')) throw new Error(`升级被拒：${text.slice(0, idx).split('\r\n')[0]}`)
    const accept = /Sec-WebSocket-Accept: (\S+)/i.exec(text)?.[1] ?? ''
    expect(accept).toBe(wsAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='))
    acc = acc.subarray(idx + 4)
    // ② HELLO（真 X25519）
    const ephPriv = x25519.utils.randomSecretKey()
    const ephPub = x25519.getPublicKey(ephPriv)
    end.write(maskClientFrame(0x2, helloFrame(ephPub)))
    // 服务端帧 = 2B 头 + 38B 载荷（HELLO_ACK 与 CONFIRM 各一帧）
    const helloAck = parseHello(parseServerFrames(await waitBytes(40))[0])
    const confirms = parseServerFrames(await waitBytes(40))
    const io = new RustFrameIo(rustDerive(nodeX25519Priv(ephPriv), helloAck, ephPub, helloAck, handshake), 'originator', handshake)
    io.acceptConfirm(confirms[0])
    end.write(maskClientFrame(0x2, io.confirmFrame()))
    // ③ 数据期：服务端帧 → 明文队列
    end.onChunk((d) => {
      for (const m of parseServerFrames(d)) messages.push(io.open(m))
    })
    return {
      io,
      handshakeRaw: handshake,
      send: (pt) => end.write(maskClientFrame(0x2, io.seal(pt))),
      messages,
    }
  } finally {
    offChunk()
  }
}

/** x25519 私钥（Uint8Array）→ node KeyObject（rustDerive 用；PKCS8 OID=1.3.101.110）。 */
function nodeX25519Priv(priv: Uint8Array): crypto.KeyObject {
  return crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(priv)]),
    format: 'der',
    type: 'pkcs8',
  })
}

async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil 超时')
    await new Promise((res) => setTimeout(res, 10))
  }
}

// ══════════════════ ① WS 服务端基建 ══════════════════

describe('反向连接：WS 服务端基建', () => {
  it('accept key＝RFC 6455 §4.2.2 官方向量', () => {
    // RFC 6455 原文示例：key "dGhlIHNhbXBsZSBub25jZQ==" → "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
    expect(wsAcceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  it('101 响应带按对方 key 算的 accept', () => {
    const resp = new TextDecoder().decode(buildUpgradeResponse({ 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }))
    expect(resp.startsWith('HTTP/1.1 101 Switching Protocols\r\n')).toBe(true)
    expect(resp).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  it('请求头解析：到 \\r\\n\\r\\n 才算数；头表小写；信封原文逐字保留', () => {
    const half = utf8e('GET /p2p/tunnel?v=2 HTTP/1.1\r\nHost: x\r\n')
    expect(parseUpgradeRequest(half)).toBeNull()
    const env = '{"v":2,"port":13911,"account":"a","device":"d","origin":"d","nonce":"n"}'
    const full = utf8e(`GET /p2p/tunnel?v=2 HTTP/1.1\r\nx-myco-tunnel: ${env}\r\n\r\nBINARY`)
    const req = parseUpgradeRequest(full)!
    expect(req).not.toBeNull()
    expect(req.method).toBe('GET')
    expect(req.path).toBe('/p2p/tunnel?v=2')
    expect(req.headers['x-myco-tunnel']).toBe(env)
    expect(req.headLen).toBe(full.length - 'BINARY'.length)
  })

  it('路径版本闸：/p2p/tunnel 且 v=2 才过（其余 400 语义）', () => {
    expect(tunnelPathVersionOk('/p2p/tunnel?v=2')).toBe(true)
    expect(tunnelPathVersionOk('/p2p/tunnel?v=1')).toBe(false)
    expect(tunnelPathVersionOk('/p2p/tunnel')).toBe(false)
    expect(tunnelPathVersionOk('/gw/sh-1/?mt=x')).toBe(false)
    expect(tunnelPathVersionOk('/p2p/tunnel?x=1&v=2')).toBe(true)
  })

  it('掩码客户端帧 → 消息；服务端帧不掩码（与 PC 客户端实现对拍）', () => {
    const codec = new WsServerCodec()
    const masked = maskClientFrame(0x2, utf8e('hello tunnel'))
    // 分两半喂（块边界任意性）
    const msgs = [...codec.push(masked.subarray(0, 5)), ...codec.push(masked.subarray(5))]
    expect(msgs.length).toBe(1)
    expect(new TextDecoder().decode(msgs[0])).toBe('hello tunnel')
    const out = codec.binaryFrame(utf8e('back'))
    expect(out[1] & 0x80).toBe(0) // 服务端帧不带掩码位
    expect(new TextDecoder().decode(parseServerFrames(out)[0])).toBe('back')
  })

  it('ping → pong 控制帧；close 回显并停读', () => {
    const codec = new WsServerCodec()
    codec.push(maskClientFrame(0x9, utf8e('ping!')))
    const ctrl = codec.takeControlWrites()
    expect(ctrl.length).toBe(1)
    expect(ctrl[0][0] & 0x0f).toBe(0xa)
    // pong 载荷 = ping 载荷（帧头 2B，无扩展长度）
    expect(new TextDecoder().decode(ctrl[0].subarray(2))).toBe('ping!')
    codec.push(maskClientFrame(0x8, new Uint8Array([0x03, 0xe8])))
    expect(codec.closed).toBe(true)
    expect(codec.closeCode).toBe(1000)
  })
})

// ══════════════════ ② 验签 ══════════════════

describe('反向连接：x-myco-auth 验签（与 PC verify_auth 同口径）', () => {
  it('真签名通过；返回签名者 did', () => {
    const pc = fakePc()
    const raw = buildTunnelHandshake(pc.account, pc.did, pc.did, 13911, 'tn-abc')
    const ts = Date.now()
    const parts = parseTunnelAuthHeader(tunnelAuthHeader(pc.did, ts, pc.sign(tunnelSignMaterial(pc.did, ts, raw))))!
    expect(parts).not.toBeNull()
    expect(verifyTunnelAuth(parts, raw, Date.now())).toBe(pc.did)
  })

  it('±60s 窗口外拒；坏签名拒；坏形状拒', () => {
    const pc = fakePc()
    const raw = '{"v":2}'
    const ts = Date.now()
    const good = tunnelAuthHeader(pc.did, ts, pc.sign(tunnelSignMaterial(pc.did, ts, raw)))
    const staleTs = ts - AUTH_WINDOW_MS - 5_000
    const stale = tunnelAuthHeader(pc.did, staleTs, pc.sign(tunnelSignMaterial(pc.did, staleTs, raw)))
    const future = tunnelAuthHeader(pc.did, ts + AUTH_WINDOW_MS + 5_000, 'A'.repeat(86))
    expect(verifyTunnelAuth(parseTunnelAuthHeader(stale)!, raw, Date.now())).toBeNull()
    expect(verifyTunnelAuth(parseTunnelAuthHeader(future)!, raw, Date.now())).toBeNull()
    // 签的是另一份原文 → 拒
    expect(verifyTunnelAuth(parseTunnelAuthHeader(good)!, '{"v":3}', Date.now())).toBeNull()
    expect(parseTunnelAuthHeader('not-an-auth')).toBeNull()
    expect(parseTunnelAuthHeader(`${pc.did}.${ts}.${btoa('short')}`)).toBeNull()
  })
})

// ══════════════════ ③ 服务端角色握手（核心对拍） ══════════════════

describe('反向连接：acceptTunnel 服务端角色（手机做服务端 ↔ node:crypto 版 PC 发起方）', () => {
  it('完整握手 + 双向数据帧往返（真 HTTP 升级 + 真 ECDH + 真 AEAD）', async () => {
    clearTunnelNoncesForTest()
    const pc = fakePc()
    // 双向缝合：pcEnd 写 → 手机收；手机写 → pcEnd.feed
    const pcEnd = pcNetEnd()
    const phoneEnd = pcNetEnd()
    pcEnd.write = (d): void => phoneEnd.feed(d)
    phoneEnd.write = (d): void => pcEnd.feed(d)
    const accepting = acceptTunnel(phoneEnd, { expectDevice: pc.did })
    const originator = await pcOriginator(pcEnd, pc, 13911)
    const t = await accepting
    // 会话属性：responder 角色、对端身份、信封原文一致
    expect(t.io.role).toBe('responder')
    expect(t.peer.device).toBe(pc.did)
    expect(t.peer.account).toBe(pc.account)
    expect(t.peer.port).toBe(13911)
    expect(t.handshakeRaw).toBe(originator.handshakeRaw)
    // 手机 → PC（s2c 方向）：send 的明文应被发起方 open 出来
    t.send(utf8e('HTTP/1.1 200 OK\r\n\r\nhello from pc-gw'))
    await waitUntil(() => originator.messages.length > 0)
    expect(new TextDecoder().decode(originator.messages[0])).toBe('HTTP/1.1 200 OK\r\n\r\nhello from pc-gw')
    // PC → 手机（c2s 方向）：发起方 seal 的明文应被会话 onMessage 吐出
    const gotOnPhone: Uint8Array[] = []
    t.onMessage((pt) => gotOnPhone.push(pt))
    originator.send(utf8e('GET /gw/sh-1/ HTTP/1.1\r\n\r\n'))
    await waitUntil(() => gotOnPhone.length > 0)
    expect(new TextDecoder().decode(gotOnPhone[0])).toBe('GET /gw/sh-1/ HTTP/1.1\r\n\r\n')
  })

  it('预期源设备不符 → 403 not-expected-device（最硬的闸）', async () => {
    clearTunnelNoncesForTest()
    const pc = fakePc(0x11)
    const other = fakePc(0x22)
    const a = pcNetEnd()
    const b = pcNetEnd()
    a.write = (d): void => b.feed(d)
    b.write = (d): void => a.feed(d)
    const accepting = acceptTunnel(b, { expectDevice: other.did })
    await expect(pcOriginator(a, pc, 13911)).rejects.toThrow()
    await expect(accepting).rejects.toMatchObject({ httpStatus: 403, code: 'not-expected-device' })
  })

  it('坏签名（另一把钥签）→ 403 bad-signature', async () => {
    clearTunnelNoncesForTest()
    const pc = fakePc(0x33)
    const impostor = fakePc(0x44)
    const a = pcNetEnd()
    const b = pcNetEnd()
    a.write = (d): void => b.feed(d)
    b.write = (d): void => a.feed(d)
    const accepting = acceptTunnel(b, { expectDevice: pc.did })
    const ts = Date.now()
    const handshake = buildTunnelHandshake(pc.account, pc.did, pc.did, 13911, 'tn-bad-sig')
    const sig = impostor.sign(tunnelSignMaterial(pc.did, ts, handshake))
    a.write(
      utf8e(
        `GET /p2p/tunnel?v=2 HTTP/1.1\r\nHost: x\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `x-myco-tunnel: ${handshake}\r\nx-myco-auth: ${tunnelAuthHeader(pc.did, ts, sig)}\r\n\r\n`,
      ),
    )
    await expect(accepting).rejects.toMatchObject({ httpStatus: 403, code: 'bad-signature' })
  })

  it('端口不在白名单 → 403 port-not-allowed', async () => {
    clearTunnelNoncesForTest()
    const pc = fakePc(0x55)
    const a = pcNetEnd()
    const b = pcNetEnd()
    a.write = (d): void => b.feed(d)
    b.write = (d): void => a.feed(d)
    const accepting = acceptTunnel(b, { expectDevice: pc.did })
    await expect(pcOriginator(a, pc, 9999)).rejects.toThrow()
    await expect(accepting).rejects.toMatchObject({ httpStatus: 403, code: 'port-not-allowed' })
    void TUNNEL_DEFAULT_PORTS
  })

  // ── 2026-10-23 V21 手机入向：开放集合 + 名册归属两道新闸 ──

  it('V21：端口在白名单但不在开放集合（vnetPorts）→ 403 port-not-open', async () => {
    clearTunnelNoncesForTest()
    const pc = fakePc(0x91)
    const a = pcNetEnd()
    const b = pcNetEnd()
    a.write = (d): void => b.feed(d)
    b.write = (d): void => a.feed(d)
    // 同账号 + 5555 在静态白名单，但用户只开放了 22 → 3389 的请求必须被挡
    const accepting = acceptTunnel(b, {
      expectDevice: 'did:myco:zNotTheSource',
      vnetAccount: pc.account,
      vnetPorts: () => [22],
    })
    await expect(pcOriginator(a, pc, 3389)).rejects.toThrow()
    await expect(accepting).rejects.toMatchObject({ httpStatus: 403, code: 'port-not-open' })
  })

  it('V21：开放集合运行时可变（同一条 acceptTunnel 配置读的是现值）', async () => {
    clearTunnelNoncesForTest()
    const pc = fakePc(0x93)
    const a = pcNetEnd()
    const b = pcNetEnd()
    a.write = (d): void => b.feed(d)
    b.write = (d): void => a.feed(d)
    let open: number[] = [] // 模拟 __mycoVnet.inbound([...]) 改配置
    const accepting = acceptTunnel(b, {
      expectDevice: 'did:myco:zNotTheSource',
      vnetAccount: pc.account,
      vnetPorts: () => open,
    })
    open = [5555]
    const t = await Promise.all([pcOriginator(a, pc, 5555), accepting])
    expect(t[1].peer.port).toBe(5555)
  })

  it('V21：同账号但名册校验不过（verifyVnetPeer=false）→ 403 ownership', async () => {
    clearTunnelNoncesForTest()
    const pc = fakePc(0x92)
    const a = pcNetEnd()
    const b = pcNetEnd()
    a.write = (d): void => b.feed(d)
    b.write = (d): void => a.feed(d)
    const accepting = acceptTunnel(b, {
      expectDevice: 'did:myco:zNotTheSource',
      vnetAccount: pc.account,
      vnetPorts: () => [5555],
      verifyVnetPeer: async () => false, // 名册里没有这把设备钥
    })
    await expect(pcOriginator(a, pc, 5555)).rejects.toThrow()
    await expect(accepting).rejects.toMatchObject({ httpStatus: 403, code: 'ownership' })
  })

  it('V21：同账号 + 名册通过 + 端口开放 → 放行（完整入向路径）', async () => {
    clearTunnelNoncesForTest()
    const pc = fakePc(0x94)
    const a = pcNetEnd()
    const b = pcNetEnd()
    a.write = (d): void => b.feed(d)
    b.write = (d): void => a.feed(d)
    let verified = ''
    const accepting = acceptTunnel(b, {
      expectDevice: 'did:myco:zNotTheSource',
      vnetAccount: pc.account,
      vnetPorts: () => [5555],
      verifyVnetPeer: async (peer) => {
        verified = peer.device
        return true
      },
    })
    const t = await Promise.all([pcOriginator(a, pc, 5555), accepting])
    expect(t[1].peer.port).toBe(5555)
    expect(t[1].peer.device).toBe(pc.did)
    expect(verified).toBe(pc.did) // 校验拿到的是签名设备（不是信封里随便声称的账号主体）
  })

  it('协议版本不符（query v=1）→ 400', async () => {
    clearTunnelNoncesForTest()
    const pc = fakePc(0x66)
    const a = pcNetEnd()
    const b = pcNetEnd()
    a.write = (d): void => b.feed(d)
    b.write = (d): void => a.feed(d)
    const accepting = acceptTunnel(b, { expectDevice: pc.did })
    const ts = Date.now()
    const handshake = buildTunnelHandshake(pc.account, pc.did, pc.did, 13911, 'tn-v1')
    const sig = pc.sign(tunnelSignMaterial(pc.did, ts, handshake))
    a.write(
      utf8e(
        `GET /p2p/tunnel?v=1 HTTP/1.1\r\nHost: x\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `x-myco-tunnel: ${handshake}\r\nx-myco-auth: ${tunnelAuthHeader(pc.did, ts, sig)}\r\n\r\n`,
      ),
    )
    await expect(accepting).rejects.toMatchObject({ httpStatus: 400 })
  })

  it('nonce 重放 → 403 replay（同一份合法握手第二次被拒）', async () => {
    clearTunnelNoncesForTest()
    const pc = fakePc(0x77)
    // 去重器口径：第一次登记、第二次命中、121s 前的已出窗（用独立 nonce，别和端到端撞）
    expect(tunnelNonceIsReplay('tn-dedup-probe', Date.now())).toBe(false)
    expect(tunnelNonceIsReplay('tn-dedup-probe', Date.now())).toBe(true)
    expect(tunnelNonceIsReplay('tn-old', Date.now() - 121_000)).toBe(false)
    expect(tunnelNonceIsReplay('tn-old', Date.now())).toBe(false)
    // 端到端：第一条过，同 nonce 的第二条拒
    const nonce = 'tn-replay-e2e'
    const a1 = pcNetEnd()
    const b1 = pcNetEnd()
    a1.write = (d): void => b1.feed(d)
    b1.write = (d): void => a1.feed(d)
    const acc1 = acceptTunnel(b1, { expectDevice: pc.did })
    await expect(pcOriginator(a1, pc, 13911, { nonce })).resolves.toBeTruthy()
    await expect(acc1).resolves.toBeTruthy()
    const a2 = pcNetEnd()
    const b2 = pcNetEnd()
    a2.write = (d): void => b2.feed(d)
    b2.write = (d): void => a2.feed(d)
    const acc2 = acceptTunnel(b2, { expectDevice: pc.did })
    await expect(pcOriginator(a2, pc, 13911, { nonce })).rejects.toThrow()
    await expect(acc2).rejects.toMatchObject({ httpStatus: 403, code: 'replay' })
  })

  it('TunnelAcceptError 形状（人话 message + 状态码）', () => {
    const e = new TunnelAcceptError(403, 'not-expected-device', '发起方不是本次分享的源设备')
    expect(e.name).toBe('TunnelAcceptError')
    expect(e.httpStatus).toBe(403)
    expect(e.message).toContain('源设备')
  })
})

// ══════════════════ ④ 连接决策 + 反向桥 ══════════════════

describe('反向连接：连接决策（LAN → 直连 → 反向 → 人话）', () => {
  it('决策表全分支', () => {
    expect(decideTunnelRoute({ sameSubnet: true, sourceReachable: false, selfInbound: false }).mode).toBe('direct')
    expect(decideTunnelRoute({ sameSubnet: false, sourceReachable: true, selfInbound: true }).mode).toBe('direct')
    expect(decideTunnelRoute({ sameSubnet: false, sourceReachable: false, selfInbound: true }).mode).toBe('reverse')
    const none = decideTunnelRoute({ sameSubnet: false, sourceReachable: false, selfInbound: false }, '对方电脑')
    expect(none.mode).toBe('none')
    expect(none.mode === 'none' && none.message).toContain('连不上')
  })
})

/** 可编程假 tap（原生桥）：write 可被测试订阅（模拟"网络对端"收到字节）。 */
function fakeTap(): {
  tap: {
    onConn(cb: (id: number) => void): unknown
    onData(cb: (id: number, d: Uint8Array) => void): unknown
    onClose(cb: (id: number) => void): unknown
    write(id: number, d: Uint8Array): void
    close(id: number): void
  }
  conn(id: number): void
  data(id: number, d: Uint8Array): void
  close(id: number): void
  /** 订阅"写到 id 的字节"（= 网络对端收到的字节）。 */
  onWrite(id: number, cb: (d: Uint8Array) => void): void
  written: Map<number, Uint8Array[]>
  closedIds: number[]
} {
  const connCbs: ((id: number) => void)[] = []
  const dataCbs: ((id: number, d: Uint8Array) => void)[] = []
  const closeCbs: ((id: number) => void)[] = []
  const writeCbs = new Map<number, (d: Uint8Array) => void>()
  const written = new Map<number, Uint8Array[]>()
  const closedIds: number[] = []
  return {
    tap: {
      onConn: (cb) => connCbs.push(cb),
      onData: (cb) => dataCbs.push(cb),
      onClose: (cb) => closeCbs.push(cb),
      write: (id, d) => {
        const a = written.get(id) ?? []
        a.push(d)
        written.set(id, a)
        writeCbs.get(id)?.(d)
      },
      close: (id) => {
        if (!closedIds.includes(id)) closedIds.push(id)
      },
    },
    conn: (id) => connCbs.forEach((cb) => cb(id)),
    data: (id, d) => dataCbs.forEach((cb) => cb(id, d)),
    close: (id) => closeCbs.forEach((cb) => cb(id)),
    onWrite: (id, cb) => writeCbs.set(id, cb),
    written,
    closedIds,
  }
}

describe('反向连接：ReverseShareBridge（嗅探/池/胶合）', () => {
  it('auto 模式：浏览器连接原样转交 TunnelProxy（直连路径一字不变）', () => {
    const f = fakeTap()
    const br = new ReverseShareBridge({ tap: f.tap, expectDevice: 'did:myco:zWhatever' })
    br.wire()
    const seen: { conn: number[]; data: string[] } = { conn: [], data: [] }
    br.onConn((id) => seen.conn.push(id))
    br.onData((id, d) => seen.data.push(`${id}:${new TextDecoder().decode(d)}`))
    f.conn(7)
    f.data(7, utf8e('GET /gw/sh-1/?mt=x HTTP/1.1\r\nHost'))
    f.data(7, utf8e(': 127.0.0.1\r\n\r\n'))
    expect(seen.conn).toEqual([7])
    expect(seen.data).toEqual(['7:GET /gw/sh-1/?mt=x HTTP/1.1\r\nHost', '7:: 127.0.0.1\r\n\r\n'])
    // TunnelProxy 写回 → 透传 tap
    br.write(7, utf8e('pong'))
    expect(new TextDecoder().decode(f.written.get(7)![0])).toBe('pong')
  })

  it('auto 模式但 TunnelProxy 未接管（取票阶段）+ 池里有隧道：浏览器连接走池，不再黑洞', async () => {
    // 真机根因（2026-10-10"PC 连过来却 0 字节响应"）：取票 provider C 的
    // fetch 127.0.0.1:<port>/p2p/msg 发生在 TunnelProxy 创建之前——原实现的
    // auto 分支把它交给 null 的 tpConn，连接无人消费（池里隧道干看着）。
    clearTunnelNoncesForTest()
    const pc = fakePc(0x9a)
    const f = fakeTap()
    const br = new ReverseShareBridge({ tap: f.tap, expectDevice: pc.did, holdMs: 8000 })
    br.wire()
    // ① 不注册 TunnelProxy 回调（tpConn=null），PC 先拨来一条隧道 → 进池
    const pcEnd = pcNetEnd()
    f.onWrite(4, (d) => pcEnd.feed(d))
    const origWrite = pcEnd.write.bind(pcEnd)
    pcEnd.write = (d: Uint8Array): void => {
      origWrite(d)
      f.data(4, d)
    }
    f.conn(4)
    const originator = await pcOriginator(pcEnd, pc, 13911)
    await waitUntil(() => br.snapshot().includes('pool=1/4'))
    expect(br.snapshot()).toContain('tp=0')
    // ② provider C 形状的本地连接（POST /p2p/msg）：应从池里立刻胶合
    f.conn(3)
    f.data(3, utf8e('POST /p2p/msg HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n{}'))
    await waitUntil(() => originator.messages.length > 0)
    expect(new TextDecoder().decode(originator.messages[0])).toContain('POST /p2p/msg')
    // ③ 响应沿隧道回流到本地连接
    originator.send(utf8e('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'))
    await waitUntil(() => (f.written.get(3)?.length ?? 0) > 0)
    expect(new TextDecoder().decode(f.written.get(3)![0])).toContain('HTTP/1.1 200 OK')
    expect(br.stats.glued).toBe(1)
  })

  it('auto 模式无 TunnelProxy 且池空：扣住等反向隧道（PC 下一拍拨来即服务）', async () => {
    clearTunnelNoncesForTest()
    const pc = fakePc(0x9b)
    const f = fakeTap()
    const br = new ReverseShareBridge({ tap: f.tap, expectDevice: pc.did, holdMs: 8000 })
    br.wire()
    // ① 取票阶段（tpConn=null）且池空：本地连接被扣住而不是黑洞
    f.conn(3)
    f.data(3, utf8e('GET /gw/sh-1/?mt=t HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'))
    expect(br.stats.held).toBe(1)
    expect(br.snapshot()).toContain('held=1')
    // ② PC 拨来 → 扣住的连接被服务：请求（含首包缓冲）上隧道
    const pcEnd = pcNetEnd()
    f.onWrite(4, (d) => pcEnd.feed(d))
    const origWrite = pcEnd.write.bind(pcEnd)
    pcEnd.write = (d: Uint8Array): void => {
      origWrite(d)
      f.data(4, d)
    }
    f.conn(4)
    const originator = await pcOriginator(pcEnd, pc, 13911)
    await waitUntil(() => originator.messages.length > 0)
    expect(new TextDecoder().decode(originator.messages[0])).toContain('GET /gw/sh-1/?mt=t')
    expect(br.stats.glued).toBe(1)
  })

  it('扣住超时（PC 迟迟没拨来）：连接关闭 + onHoldTimeout 触发（重报 addrs 的在带信号）', async () => {
    // IPv6 前缀轮换场景：presence 挂着过期地址 → PC 每拍都拨旧地址（全超时），
    // 手机侧整个 holdMs 等不到隧道——桥借这个事件通知上层**立即重报最新 addrs**
    // （WebView 后台节流会拖慢周期刷新，这是节流期唯一可靠的在带恢复信号）。
    const f = fakeTap()
    let fired = 0
    const br = new ReverseShareBridge({
      tap: f.tap,
      expectDevice: 'did:myco:zX',
      holdMs: 150,
      onHoldTimeout: () => {
        fired += 1
      },
    })
    br.wire()
    f.conn(3)
    f.data(3, utf8e('GET /gw/sh-1/?mt=t HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'))
    expect(br.stats.held).toBe(1)
    await waitUntil(() => fired > 0)
    expect(fired).toBe(1)
    expect(f.closedIds).toContain(3)
    // 正常关停不重复触发
    br.stop()
    expect(fired).toBe(1)
  })

  it('reverse 模式：浏览器连接扣住 → PC 拨来（真握手）→ 胶合 → 双向数据', async () => {
    clearTunnelNoncesForTest()
    const pc = fakePc(0x88)
    const f = fakeTap()
    const br = new ReverseShareBridge({ tap: f.tap, expectDevice: pc.did, holdMs: 8000 })
    br.wire()
    br.setMode('reverse')
    // ① 浏览器连接（应被扣住，不转 TunnelProxy）
    const tp: { conn: number[]; data: string[] } = { conn: [], data: [] }
    br.onConn((id) => tp.conn.push(id))
    br.onData((_id, d) => tp.data.push(new TextDecoder().decode(d)))
    f.conn(3)
    f.data(3, utf8e('GET /gw/sh-1/?mt=ticket HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'))
    expect(tp.conn).toEqual([])
    expect(br.stats.held).toBe(1)
    // ② PC 拨来（连接 id=4）：pcEnd 写 → tap.data(4)；tap.write(4) → pcEnd.feed
    const pcEnd = pcNetEnd()
    f.onWrite(4, (d) => pcEnd.feed(d))
    const origWrite = pcEnd.write.bind(pcEnd)
    pcEnd.write = (d: Uint8Array): void => {
      origWrite(d)
      f.data(4, d)
    }
    f.conn(4)
    const originator = await pcOriginator(pcEnd, pc, 13911)
    // ③ 扣住的浏览器连接被胶合：浏览器首包应已上隧道（PC 侧 open 出来）
    await waitUntil(() => originator.messages.length > 0)
    expect(new TextDecoder().decode(originator.messages[0])).toContain('GET /gw/sh-1/?mt=ticket')
    // ④ 隧道 → 浏览器：PC 侧发响应，应到达 tap.write(3, ...)
    originator.send(utf8e('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'))
    await waitUntil(() => (f.written.get(3)?.length ?? 0) > 0)
    expect(new TextDecoder().decode(f.written.get(3)![0])).toContain('HTTP/1.1 200 OK')
    expect(br.stats.glued).toBe(1)
    expect(tp.conn).toEqual([])
    // ⑤ 浏览器侧断开（原生 onClose）→ 连接记录清理（隧道随之关闭）
    f.close(3)
    expect(br.snapshot()).toContain('glued=0')
  })

  it('stop：释放扣着的连接', () => {
    const f = fakeTap()
    const br = new ReverseShareBridge({ tap: f.tap, expectDevice: 'did:myco:zX', holdMs: 60_000 })
    br.wire()
    br.setMode('reverse')
    f.conn(9)
    f.data(9, utf8e('GET /gw/x HTTP/1.1\r\n\r\n'))
    expect(br.stats.held).toBe(1)
    br.stop()
    expect(f.closedIds).toContain(9)
  })

  it('泵活动计数：上行/下行帧 + lastActivityAt（诊断"隧道还搬不搬砖"）', () => {
    const f = fakeTap()
    let now = 10_000
    const br = new ReverseShareBridge({ tap: f.tap, expectDevice: 'did:myco:zX', now: () => now })
    br.wire()
    // auto 直连路径：浏览器 → TP 是上行；TP 写回是下行
    const seen: number[] = []
    br.onConn((id) => seen.push(id))
    f.conn(7)
    f.data(7, utf8e('GET /gw/sh-1/?mt=x HTTP/1.1\r\nHost: x\r\n\r\n'))
    expect(br.stats.upFrames).toBe(1)
    expect(br.lastActivityAt).toBe(10_000)
    now = 12_500
    br.write(7, utf8e('HTTP/1.1 200 OK\r\n\r\n'))
    expect(br.stats.downFrames).toBe(1)
    expect(br.lastActivityAt).toBe(12_500)
    now = 15_000
    expect(br.snapshot()).toContain('idleSec=3')
    expect(br.snapshot()).toContain('"upFrames":1')
    expect(br.snapshot()).toContain('"downFrames":1')
  })

  it('空转胶合回收：释放被 keep-alive 占住的隧道槽位（反向路径白屏死循环根修）', async () => {
    clearTunnelNoncesForTest()
    const pc = fakePc(0x89)
    const f = fakeTap()
    let now = 100_000
    const pending: (() => void)[] = []
    const br = new ReverseShareBridge({
      tap: f.tap,
      expectDevice: pc.did,
      holdMs: 60_000,
      idleGluedMs: 60_000,
      sweepMs: 15_000,
      now: () => now,
      setTimer: (fn) => {
        pending.push(fn as () => void)
        return fn
      },
      clearTimer: (h) => {
        const i = pending.indexOf(h as () => void)
        if (i >= 0) pending.splice(i, 1)
      },
    })
    br.wire()
    br.setMode('reverse')
    // 浏览器连接扣住 → PC 拨来 → 胶合
    f.conn(3)
    f.data(3, utf8e('GET /gw/sh-1/?mt=ticket HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'))
    const pcEnd = pcNetEnd()
    f.onWrite(4, (d) => pcEnd.feed(d))
    const origWrite = pcEnd.write.bind(pcEnd)
    pcEnd.write = (d: Uint8Array): void => {
      origWrite(d)
      f.data(4, d)
    }
    f.conn(4)
    const originator = await pcOriginator(pcEnd, pc, 13911)
    await waitUntil(() => originator.messages.length > 0)
    expect(br.stats.glued).toBe(1)
    // 胶合刚发生（有活动）：立即扫一遍——活跃连接**绝不动**
    pending[pending.length - 1]()
    expect(f.closedIds).not.toContain(3)
    // 快进 61s 双方向静默 → 扫描回收：关掉浏览器连接（PC 槽位随之释放）
    now += 61_000
    pending[pending.length - 1]()
    expect(f.closedIds).toContain(3)
    // 原生随后上报关闭 → 记录清理（隧道随关）
    f.close(3)
    expect(br.snapshot()).toContain('glued=0')
  })
})
