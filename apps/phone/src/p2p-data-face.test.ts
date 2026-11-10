import { describe, it, expect } from 'vitest'
import { serveP2pDataFace } from './p2p-data-face'
import type { ReverseTunnelSession } from './p2p-tunnel'

/** 假会话：把 send 收的字节攒起来；onMessage 由测试灌“PC 发来的 HTTP”。 */
function fakeSession(): { t: ReverseTunnelSession; sent: string[]; feed: (b: Uint8Array) => void; closeByPeer: () => void } {
  const sent: string[] = []
  const cbs: ((b: Uint8Array) => void)[] = []
  const closeCbs: (() => void)[] = []
  const t = {
    io: {} as never,
    handshakeRaw: '',
    peer: { account: 'did:youling:A', device: 'did:myco:PC0001', port: 9100 },
    send: (b: Uint8Array) => { sent.push(new TextDecoder().decode(b)) },
    onMessage: (cb: (b: Uint8Array) => void) => { cbs.push(cb); return () => {} },
    onClose: (cb: () => void) => { closeCbs.push(cb); return () => {} },
    close: () => {},
  } as unknown as ReverseTunnelSession
  return {
    t,
    sent,
    feed: (b) => cbs.forEach((cb) => cb(b)),
    closeByPeer: () => closeCbs.forEach((cb) => cb()),
  }
}

const enc = (s: string) => new TextEncoder().encode(s)

describe('p2p-data-face（PC→手机 帧内 HTTP 落地件；2026-10-19 keep-alive 改造）', () => {
  it('/p2p/msg → 回 200 + {ok,kept}；Connection: close 时回完即关（旧契约兼容）', async () => {
    const { t, sent, feed } = fakeSession()
    const env = JSON.stringify({ msgId: 'm-face-1', kind: 'text', payload: { text: 'hi' } })
    const head = `POST /p2p/msg HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: ${enc(env).length}\r\n\r\n`
    const p = serveP2pDataFace(t)
    feed(enc(head)); feed(enc(env))
    await p
    const resp = sent.join('')
    expect(resp).toContain('HTTP/1.1 200 OK')
    expect(resp).toContain('Connection: close')
    const body = JSON.parse(resp.split('\r\n\r\n')[1]) as { ok: boolean; kept?: boolean }
    expect(typeof body.ok).toBe('boolean')
    expect('kept' in body).toBe(true)
  })

  it('keep-alive：同一隧道连续 3 个 /p2p/msg 都应答，最后 close 收工（T6/T7 关键契约）', async () => {
    const { t, sent, feed } = fakeSession()
    const mk = (id: string, close = false) => {
      const env = JSON.stringify({ msgId: id, kind: 'text', payload: { text: 'x' } })
      const head = `POST /p2p/msg HTTP/1.1\r\nHost: x\r\n${close ? 'Connection: close\r\n' : ''}Content-Length: ${enc(env).length}\r\n\r\n`
      return [enc(head), enc(env)] as const
    }
    const p = serveP2pDataFace(t)
    const [h1, b1] = mk('m-ka-1')
    feed(h1); feed(b1)
    // 等第一条应答出现后再发下一条（真实 PC 是收到 200 才发下一条）
    await new Promise((r) => setTimeout(r, 50))
    const [h2, b2] = mk('m-ka-2')
    feed(h2); feed(b2)
    await new Promise((r) => setTimeout(r, 50))
    const [h3, b3] = mk('m-ka-3', true)
    feed(h3); feed(b3)
    await p
    expect(sent.filter((s) => s.includes('HTTP/1.1 200 OK')).length).toBe(3)
    expect(sent.filter((s) => s.includes('Connection: keep-alive')).length).toBe(2)
    expect(sent[sent.length - 1]).toContain('Connection: close')
  })

  it('keep-alive：流水线（两个请求一次喂入）也能顺序应答', async () => {
    const { t, sent, feed } = fakeSession()
    const mk = (id: string) => {
      const env = JSON.stringify({ msgId: id, kind: 'text', payload: { text: 'p' } })
      const head = `POST /p2p/msg HTTP/1.1\r\nHost: x\r\nContent-Length: ${enc(env).length}\r\n\r\n`
      return head + env
    }
    const p = serveP2pDataFace(t)
    feed(enc(mk('m-pipe-1') + mk('m-pipe-2') + 'GET /p2p/ping HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'))
    await p
    expect(sent.filter((s) => s.includes('HTTP/1.1 200 OK')).length).toBe(2)
    expect(sent.filter((s) => s.includes('HTTP/1.1 404 Not Found')).length).toBe(1)
    expect(sent[sent.length - 1]).toContain('Connection: close')
  })

  it('未知路径（PC 心跳 OPTIONS/HEAD）→ 404 但 keep-alive 继续，不关隧道', async () => {
    const { t, sent, feed } = fakeSession()
    const p = serveP2pDataFace(t)
    feed(enc('OPTIONS /p2p/ping HTTP/1.1\r\nHost: x\r\n\r\n'))
    await new Promise((r) => setTimeout(r, 50))
    expect(sent.join('')).toContain('404')
    expect(sent.join('')).toContain('Connection: keep-alive')
    // 再来一条正常消息（连接还活着）
    const env = JSON.stringify({ msgId: 'm-after-ping', kind: 'text', payload: { text: 'y' } })
    feed(enc(`POST /p2p/msg HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: ${enc(env).length}\r\n\r\n`))
    feed(enc(env))
    await p
    expect(sent.join('')).toContain('HTTP/1.1 200 OK')
  })

  it('chunked 请求 → 400 + 关连接（明确不支持）', async () => {
    const { t, sent, feed } = fakeSession()
    const p = serveP2pDataFace(t)
    feed(enc('POST /p2p/msg HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n'))
    await p
    expect(sent.join('')).toContain('HTTP/1.1 400 Bad Request')
    expect(sent.join('')).toContain('Connection: close')
  })

  it('请求体被截断 → 不回字节（截断场景由超时/关闭收口）', async () => {
    const { t, sent, feed } = fakeSession()
    const p = serveP2pDataFace(t)
    feed(enc('POST /p2p/msg HTTP/1.1\r\nHost: x\r\nContent-Length: 999\r\n\r\n{"partial'))
    await Promise.race([p, new Promise((r) => setTimeout(r, 200))])
    expect(sent.join('')).toBe('')
  })
})
