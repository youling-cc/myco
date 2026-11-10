/**
 * tunnel-testkit.ts — 隧道相关单测的**共享脚手架**（不是测试文件本身，
 * 命名不带 `.test` 所以不会被 vitest 当用例收集）。
 *
 * 提供三件东西：
 *  ① `memPair()` / `pairFactory()` —— 内存 WS 对（背靠背，不走网络），
 *     让 `TunnelSocketFactory` 在 node 环境（无 WebSocket）里可用；
 *  ② `RustFrameIo` / `rustDerive` —— 用 `node:crypto`（OpenSSL）**独立实现**一遍
 *     `apps/home/src-tauri/src/p2p_tunnel.rs` 的服务端，作为线协议的对拍基准；
 *  ③ `attachRustServer()` —— 把上面那套挂到内存线的一端，形成"真 PC 端"的替身。
 */
import crypto from 'node:crypto'
import {
  FRAME_DATA_HEADER,
  FRAME_HELLO_LEN,
  FRAME_MAGIC,
  HKDF_INFO,
  helloFrame,
  parseHello,
  type TunnelSocket,
  type TunnelSocketFactory,
} from './p2p-tunnel'

// ══════════════════ ① 内存传输对 ══════════════════

export interface MemSocket extends TunnelSocket {
  peer: MemSocket
  sent: Uint8Array[]
  closed: boolean
  /** 每条消息的投递延迟（ms；0=下一微任务）。 */
  latencyMs: number
  /** 打开这条连接要多久（ms）。 */
  openDelayMs: number
  /** 打开即失败。 */
  failWith?: string
}

export function memSocket(): MemSocket {
  const msgCbs: ((d: Uint8Array) => void)[] = []
  const closeCbs: ((i: { code?: number; reason?: string; error?: string }) => void)[] = []
  const s: MemSocket = {
    peer: null as unknown as MemSocket,
    sent: [],
    closed: false,
    latencyMs: 0,
    openDelayMs: 0,
    send(data) {
      if (s.closed) return
      s.sent.push(data)
      const p = s.peer
      const deliver = (): void => {
        if (p.closed) return
        for (const cb of msgCbsOf(p)) cb(data)
      }
      if (s.latencyMs > 0) setTimeout(deliver, s.latencyMs)
      else queueMicrotask(deliver)
    },
    close(code, reason) {
      if (s.closed) return
      s.closed = true
      s.peer.closed = true
      for (const cb of closeCbs) cb({ code, reason })
      for (const cb of closeCbsOf(s.peer)) cb({ code: 1006, reason: 'peer-closed' })
    },
    onMessage(cb) {
      msgCbs.push(cb)
      return () => {
        const i = msgCbs.indexOf(cb)
        if (i >= 0) msgCbs.splice(i, 1)
      }
    },
    onClose(cb) {
      closeCbs.push(cb)
      return () => {
        const i = closeCbs.indexOf(cb)
        if (i >= 0) closeCbs.splice(i, 1)
      }
    },
  }
  MSG.set(s, msgCbs)
  CLOSE.set(s, closeCbs)
  return s
}

const MSG = new WeakMap<MemSocket, ((d: Uint8Array) => void)[]>()
const CLOSE = new WeakMap<MemSocket, ((i: { code?: number; reason?: string; error?: string }) => void)[]>()
const msgCbsOf = (s: MemSocket): ((d: Uint8Array) => void)[] => MSG.get(s) ?? []
const closeCbsOf = (s: MemSocket): ((i: { code?: number; reason?: string; error?: string }) => void)[] =>
  CLOSE.get(s) ?? []

export function memPair(): [MemSocket, MemSocket] {
  const a = memSocket()
  const b = memSocket()
  a.peer = b
  b.peer = a
  return [a, b]
}

/**
 * 每次 factory 调用产出一条内存线；`onNew` 在**同一次同步调用里**拿到
 * `(client, server, url, headers)`——测试据此挂"服务端"。
 * ⚠️ 不要在 await 之后再取 `servers.length - 1`：多条并发腿的续体会全部看到同一个下标。
 */
export function pairFactory(
  onNew?: (c: MemSocket, s: MemSocket, url: string, headers: Record<string, string>) => void,
): { factory: TunnelSocketFactory; servers: MemSocket[]; clients: MemSocket[]; urls: string[] } {
  const servers: MemSocket[] = []
  const clients: MemSocket[] = []
  const urls: string[] = []
  const factory: TunnelSocketFactory = (url, headers) => {
    urls.push(url)
    const [c, s] = memPair()
    clients.push(c)
    servers.push(s)
    onNew?.(c, s, url, headers)
    if (s.failWith) return Promise.reject(new Error(s.failWith))
    if (s.openDelayMs > 0) return new Promise((r) => setTimeout(() => r(c), s.openDelayMs))
    return Promise.resolve(c)
  }
  return { factory, servers, clients, urls }
}

// ══════════════════ ② node:crypto 版"Rust 服务端" ══════════════════

export const rawPub = (k: crypto.KeyObject): Buffer => {
  const der = k.export({ type: 'spki', format: 'der' })
  return Buffer.from(der.subarray(der.length - 32))
}

const importX25519Raw = (pub32: Uint8Array): crypto.KeyObject =>
  crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(pub32)]),
    format: 'der',
    type: 'spki',
  })

/** Rust `SessionKeys::derive` 的 node 版（OpenSSL）。 */
export function rustDerive(
  priv: crypto.KeyObject,
  theirPub: Uint8Array,
  ctClient: Uint8Array,
  ctServer: Uint8Array,
  raw: string,
) {
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: importX25519Raw(theirPub) })
  const salt = crypto
    .createHash('sha256')
    .update(Buffer.from(FRAME_MAGIC))
    .update(ctClient)
    .update(ctServer)
    .update(Buffer.from(raw, 'utf8'))
    .digest()
  const okm = Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(HKDF_INFO), 140))
  return {
    c2s: okm.subarray(0, 32),
    s2c: okm.subarray(32, 64),
    prefix: okm.subarray(64, 76),
    confirmC2s: okm.subarray(76, 108),
    confirmS2c: okm.subarray(108, 140),
  }
}

/** Rust `FrameIo`（role=Responder）的 node 版——**独立实现**，与被测 TS 无共享代码。 */
export class RustFrameIo {
  private readonly txKey: Buffer
  private readonly rxKey: Buffer
  private readonly confirmKey: Buffer
  private readonly peerConfirmKey: Buffer
  private readonly prefix: Buffer
  private readonly handshakeRaw: string
  sendSeq = 0n
  private recvMax: bigint | null = null

  constructor(keys: ReturnType<typeof rustDerive>, role: 'originator' | 'responder', handshakeRaw: string) {
    this.txKey = Buffer.from(role === 'originator' ? keys.c2s : keys.s2c)
    this.rxKey = Buffer.from(role === 'originator' ? keys.s2c : keys.c2s)
    this.confirmKey = Buffer.from(role === 'originator' ? keys.confirmC2s : keys.confirmS2c)
    this.peerConfirmKey = Buffer.from(role === 'originator' ? keys.confirmS2c : keys.confirmC2s)
    this.prefix = Buffer.from(keys.prefix)
    this.handshakeRaw = handshakeRaw
  }

  confirmFrame(): Buffer {
    const mac = crypto.createHmac('sha256', this.confirmKey).update(this.handshakeRaw, 'utf8').digest()
    return Buffer.concat([Buffer.from(FRAME_MAGIC), Buffer.from([1, 2]), mac])
  }

  acceptConfirm(f: Uint8Array): void {
    const b = Buffer.from(f)
    if (b.length !== FRAME_HELLO_LEN || !b.subarray(0, 4).equals(Buffer.from(FRAME_MAGIC))) {
      throw new Error('rust: CONFIRM 帧非法')
    }
    const want = crypto.createHmac('sha256', this.peerConfirmKey).update(this.handshakeRaw, 'utf8').digest()
    if (!b.subarray(6, 38).equals(want)) throw new Error('rust: CONFIRM MAC 不一致')
  }

  seal(pt: Uint8Array): Buffer {
    const seq = this.sendSeq++
    const n = Buffer.from(this.prefix)
    n.writeBigUInt64BE(n.readBigUInt64BE(4) ^ seq, 4)
    const c = crypto.createCipheriv('aes-256-gcm', this.txKey, n)
    const ct = Buffer.concat([c.update(Buffer.from(pt)), c.final(), c.getAuthTag()])
    const hdr = Buffer.alloc(FRAME_DATA_HEADER)
    Buffer.from(FRAME_MAGIC).copy(hdr, 0)
    hdr[4] = 1
    hdr[5] = 3
    hdr.writeBigUInt64BE(seq, 6)
    this.prefix.copy(hdr, 14)
    return Buffer.concat([hdr, ct])
  }

  open(frame: Uint8Array): Buffer {
    const f = Buffer.from(frame)
    if (f.length < 4 || !f.subarray(0, 4).equals(Buffer.from(FRAME_MAGIC))) throw new Error('rust: 非本协议帧')
    if (f.length < FRAME_DATA_HEADER + 16) throw new Error('rust: 帧太短')
    if (f[4] !== 1 || f[5] !== 3) throw new Error('rust: 帧类型非法')
    const seq = f.readBigUInt64BE(6)
    if (!f.subarray(14, 26).equals(this.prefix)) throw new Error('rust: 前缀不符')
    if (this.recvMax !== null && seq <= this.recvMax) throw new Error('rust: 序号非递增')
    const n = Buffer.from(this.prefix)
    n.writeBigUInt64BE(n.readBigUInt64BE(4) ^ seq, 4)
    const d = crypto.createDecipheriv('aes-256-gcm', this.rxKey, n)
    d.setAuthTag(f.subarray(f.length - 16))
    const pt = Buffer.concat([d.update(f.subarray(FRAME_DATA_HEADER, f.length - 16)), d.final()])
    this.recvMax = seq
    return pt
  }
}

export interface RustServerHandle {
  /** 收到的明文（客户端 → "PC"）。 */
  plaintexts: Uint8Array[]
  /** "PC" → 客户端 发一段明文。 */
  serverSends: (pt: string | Uint8Array) => void
  io: () => RustFrameIo
}

/**
 * 把内存线的一端接到"Rust 版 responder"：
 * 读 HELLO → 回 HELLO_ACK → 发 CONFIRM → 校验对端 CONFIRM → 数据帧收发。
 */
export function attachRustServer(sock: MemSocket, handshakeRaw: string): RustServerHandle {
  const eph = crypto.generateKeyPairSync('x25519')
  const myPub = rawPub(eph.publicKey)
  let io: RustFrameIo | null = null
  const plaintexts: Uint8Array[] = []
  let phase = 0
  sock.onMessage((d) => {
    if (phase === 0) {
      const ctClient = parseHello(d)
      const keys = rustDerive(eph.privateKey, ctClient, ctClient, myPub, handshakeRaw)
      io = new RustFrameIo(keys, 'responder', handshakeRaw)
      sock.send(helloFrame(myPub))
      sock.send(io.confirmFrame())
      phase = 1
      return
    }
    if (phase === 1) {
      io!.acceptConfirm(d)
      phase = 2
      return
    }
    plaintexts.push(io!.open(d))
  })
  return {
    plaintexts,
    serverSends: (pt) => sock.send(io!.seal(typeof pt === 'string' ? new TextEncoder().encode(pt) : pt)),
    io: () => {
      if (!io) throw new Error('handshake 未完成')
      return io
    },
  }
}
