/**
 * rtc.ts — media 窗的 WebRTC offerer(PC↔PC 远程桌面 viewer 侧)。
 *
 * 契约与 phone/transport.ts 的 WebRtcTransport 一致(canvas answerer 零改动):
 *   - 信令:identity-svc :8321 /signal/{offer,ice} 投递 + /signal/poll SSE 拉信箱,
 *     全部 sign-every-request(X-Myco-Auth,见 identity.ts)。
 *   - offer 必须带 m=video recvonly(answer 不能新增 offer 没有的 m-line),
 *     audio 同;canvas answerer 收到后 add_track sendonly 推 PC 屏幕。
 *   - DataChannel:rpc / events / input 三条(input=桌面输入注入,
 *     JSON 消息 → desktop_input::handle_input_json;input 上还有 PC 60Hz
 *     光标位置下行 {t:"cursor",fx,fy})。
 *   - 授权闸门:offer 的 from(=viewer DID)必须在主机 authorized-dids 内,
 *     否则主机回 /signal/deny → 这里抛 MediaRtcDeniedError。
 */
import { ensureRegistered, signAuthHeader } from './identity'

// 构建期 VITE_DID_BASE 覆盖（换环境改构建 env 不改代码），缺省=现状 EIP 直连。
const SIG_BASE = ((import.meta.env.VITE_DID_BASE as string | undefined) || 'http://myco.youling.cc:8321').replace(/\/+$/, '')

export class MediaRtcDeniedError extends Error {
  constructor() {
    super('主机未放行此 viewer(配对后重试)')
    this.name = 'MediaRtcDeniedError'
  }
}

export type ConnState = 'idle' | 'connecting' | 'open' | 'failed' | 'closed'

async function sigDeposit(kind: 'offer' | 'ice', payload: Record<string, unknown>): Promise<void> {
  const raw = JSON.stringify(payload)
  const r = await fetch(`${SIG_BASE}/signal/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Myco-Auth': signAuthHeader(raw) },
    body: raw,
  })
  if (!r.ok) throw new Error(`signal ${kind} ${r.status}`)
}

/** 拉自己信令信箱(SSE;30s 服务端超时后自动重连)。返回取消函数。 */
function sigPoll(onMsg: (msg: any) => void): () => void {
  const ctrl = new AbortController()
  ;(async () => {
    while (!ctrl.signal.aborted) {
      try {
        const resp = await fetch(`${SIG_BASE}/signal/poll`, {
          headers: { 'X-Myco-Auth': signAuthHeader('') },
          signal: ctrl.signal,
        })
        const reader = resp.body?.getReader()
        if (!reader) return
        const dec = new TextDecoder()
        let buf = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            for (const line of block.split('\n')) {
              if (!line.startsWith('data: ')) continue
              try {
                onMsg(JSON.parse(line.slice(6)))
              } catch {
                /* 忽略坏行 */
              }
            }
          }
        }
      } catch {
        /* 断线/abort → 外层重连 */
      }
      if (!ctrl.signal.aborted) await new Promise((r) => setTimeout(r, 300))
    }
  })()
  return () => ctrl.abort()
}

export class MediaRtcClient {
  private pc: RTCPeerConnection | null = null
  private inputCh: RTCDataChannel | null = null
  private rpcCh: RTCDataChannel | null = null
  private stopPoll: (() => void) | null = null
  /** rpc 请求/响应相关(canvas 侧 {id,line}→{id,data},>CHUNK 走 {g,c,n,d} 分帧) */
  private rpcSeq = 0
  private rpcPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private rpcChunks = new Map<number, string[]>()

  onStream: ((s: MediaStream) => void) | null = null
  onState: ((s: ConnState) => void) | null = null
  /** PC 光标位置下行(60Hz;v1 只透传给状态行,不画层)。 */
  onCursor: ((fx: number, fy: number) => void) | null = null
  /** PC 光标死亡心跳(1Hz):GetCursorPos 失败=RDP 最小化/显示栈挂起→输入栈死亡,viewer 应显示提示。 */
  onCursorDead: (() => void) | null = null
  /** PC 光标形状下行(变化时才发):arrow/ibeam/hand/wait/size_* 等语义类型,
   *  viewer 映射成本机 CSS 原生光标(MS-RDPBCGR 指针通道同构,2026-08-30)。 */
  onCursorShape: ((shape: string) => void) | null = null

  /** 本端是否配 TURN(relay 候选)。两阶段建连由 connect() 控制翻档。 */
  private relay = false
  /** 直连档"短命"计数:连上后 <90s 死亡(v6 路径 NAT/防火墙会话老化实测 ~60s 死)。
   *  连续 2 次短命 → 本进程常驻 TURN 档(此网络环境直连不可靠,不再反复试)。 */
  private shortLived = 0
  private openedAt = 0
  /** 建联代际号:硬超时后旧的 connectInner 仍可能在后台完结(裸 fetch 迟迟返回),
   *  每个裸 await 后核对——陈旧尝试立刻中止,防止覆盖新尝试的 this.pc/stopPoll。 */
  private attemptSeq = 0

  private setState(s: ConnState) {
    // 短命统计:直连档 open 过且快速死亡 → 计数;活到 90s+ 重置(路径其实稳)
    if (s === 'failed' || s === 'closed') {
      if (!this.relay && this.openedAt > 0) {
        const livedMs = Date.now() - this.openedAt
        if (livedMs < 90_000) {
          this.shortLived++
          console.log(`[rtc] 直连档短命(${Math.round(livedMs / 1000)}s) 累计 ${this.shortLived}/2`)
        } else {
          this.shortLived = 0
        }
      }
      this.openedAt = 0
    }
    this.onState?.(s)
  }

  /** 发起对 hostDid(canvas 主机 DID)的连接;rpc channel 打开即算成功。
   *  两阶段建连(2026-08-29,与 phone transport 同语义"中转只兜底不抢跑"):
   *  默认 relay=false——本端不配 TURN,relay 候选不出场,直连对(host/srflx v6)独占
   *  提名窗口;直连档失败(DataChannel 超时/建连异常)自动翻 TURN 档重试一次。
   *  动机实测:TURN 中继下 SCTP/DataChannel 不稳(视频 SRTP 通但输入消息卡死),
   *  且 coturn allocation ~14min 周期死亡——直连则全消。 */
  async connect(hostDid: string): Promise<void> {
    this.relay = this.shortLived >= 2 // 直连反复短命 → 直接 TURN 档
    try {
      await this.connectGuarded(hostDid, this.relay ? 15000 : 8000)
    } catch (e) {
      if (this.relay) throw e // TURN 档失败=真失败
      console.log('[rtc] 直连档未通 → 翻 TURN 兜底档:', String(e).slice(0, 60))
      this.relay = true
      this.stopPoll?.() // 翻档前收掉上一档的信令轮询(否则泄漏成双 poll 抢信箱)
      this.stopPoll = null
      this.pc?.close()
      await this.connectGuarded(hostDid, 15000)
    }
  }

  /** 建联硬看门狗(2026-08-30 "点连接连不上"根修):connectInner 里 ensureRegistered/
   *  sigDeposit 是裸 fetch——浏览器 fetch 无默认超时,网络抖动窗口(笔记本到火山
   *  中断过)会挂死数分钟乃至永不完结;clientRef 因此卡非空,App.connect 的守卫
   *  让后续所有"连接"点击早退,页面只有 reload 能救(reload 后实测 1s 秒连)。
   *  整段 race 一个硬超时(dc 超时+10s 余量),超时走正常 throw → close → 'closed'
   *  → 5s 自动重连路径,与手机端 connectWebRtc 的 Promise.race 超时同构。 */
  private async connectGuarded(hostDid: string, dcTimeoutMs: number): Promise<void> {
    const seq = ++this.attemptSeq
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.connectInner(hostDid, dcTimeoutMs, seq),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`建联硬超时(${Math.round((dcTimeoutMs + 10_000) / 1000)}s,信令面挂死)`)),
            dcTimeoutMs + 10_000,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private async connectInner(hostDid: string, dcTimeoutMs: number, seq: number): Promise<void> {
    this.setState('connecting')
    // 未注册的 DID 一切签名请求都被 identity-svc 403(authedDid 查注册表)——先幂等注册
    await ensureRegistered()
    if (seq !== this.attemptSeq) throw new Error('建联尝试已被取代')
    const iceServers: RTCIceServer[] = [
      // STUN:云服务器 coturn(国内快);v6 直连靠两端 host 候选,STUN 只作 srflx 补充
      { urls: (import.meta.env.VITE_STUN_URL as string | undefined) || 'stun:myco.youling.cc:3478' },
    ]
    if (this.relay) {
      // TURN 兜底(直连不可达时):coturn 云服务器
      iceServers.push({
        urls: (import.meta.env.VITE_TURN_URL as string | undefined) || 'turn:myco.youling.cc:3478?transport=udp',
        username: (import.meta.env.VITE_TURN_USER as string | undefined) || 'myco',
        credential: (import.meta.env.VITE_TURN_CREDENTIAL as string | undefined) || 'a79d8c44cc84b75adceeedb28977ab89',
      })
    }
    const pc = new RTCPeerConnection({ iceServers })
    this.pc = pc

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      if (st === 'failed' || st === 'disconnected' || st === 'closed') this.setState('failed')
    }

    const opened = new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`DataChannel 打开超时(${this.relay ? 'TURN' : '直连'}档未穿通)`)), dcTimeoutMs)
      const rpcCh = pc.createDataChannel('rpc')
      this.rpcCh = rpcCh
      // rpc 响应:{id,data} 单帧;>CHUNK 时 canvas 走 {g,c,n,d} 分帧,这里重组
      rpcCh.onmessage = (ev) => {
        try {
          const v = JSON.parse(ev.data as string)
          if (typeof v.g === 'number' && typeof v.c === 'number' && typeof v.n === 'number') {
            const arr = this.rpcChunks.get(v.g) ?? []
            arr[v.c] = v.d as string
            if (arr.filter(Boolean).length === v.n) {
              this.rpcChunks.delete(v.g)
              this.rpcSettle(JSON.parse(arr.join('')))
            }
            return
          }
          this.rpcSettle(v)
        } catch {
          /* 坏消息忽略 */
        }
      }
      rpcCh.onopen = () => {
        clearTimeout(to)
        resolve()
      }
      rpcCh.onerror = () => {
        clearTimeout(to)
        reject(new Error('rpc channel error'))
      }
      // events:v1 不消费 delta,但 answerer 按标签分派,三条都建与 phone 对齐
      pc.createDataChannel('events')
      this.inputCh = pc.createDataChannel('input')
      this.inputCh.onmessage = (ev) => {
        try {
          const v = JSON.parse(ev.data as string) as { t?: string; fx?: number; fy?: number; dead?: number; s?: string }
          if (v.t === 'cursor' && typeof v.fx === 'number' && typeof v.fy === 'number') {
            this.onCursor?.(v.fx, v.fy)
          } else if (v.t === 'cursor' && v.dead) {
            this.onCursorDead?.()
          } else if (v.t === 'cshape' && typeof v.s === 'string') {
            this.onCursorShape?.(v.s)
            ;(window as unknown as { __cshape?: string }).__cshape = v.s // e2e 观测钩
          }
        } catch {
          /* 坏消息忽略 */
        }
      }
      // 剪贴板双向同步(2026-08-25):host 推 → 写本机剪贴板;本机复制 → 发给 host
      const clipCh = pc.createDataChannel('clipboard')
      clipCh.onmessage = (ev) => {
        try {
          const v = JSON.parse(ev.data as string) as { t?: string; c?: string }
          if (v.t === 'clip' && v.c) void navigator.clipboard.writeText(v.c).catch(() => {})
        } catch { /* 忽略 */ }
      }
      // 本机复制 → 发给 host(500ms 轮询变化;剪贴板读需要 focus/permission,降频)
      let lastClip = ''
      setInterval(async () => {
        if (clipCh.readyState !== 'open') return
        try {
          const text = await navigator.clipboard.readText().catch(() => '')
          if (text && text !== lastClip && text.length < 1_048_576) {
            lastClip = text
            clipCh.send(JSON.stringify({ t: 'clip', c: text }))
          }
        } catch { /* 剪贴板权限不可用时静默 */ }
      }, 500)
    })

    pc.ontrack = (e) => {
      const s = e.streams[0] ?? new MediaStream([e.track])
      if (e.track.kind === 'video') this.onStream?.(s)
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        void sigDeposit('ice', { to: hostDid, candidate: e.candidate.toJSON() }).catch(() => {})
      }
    }

    // 先挂 poll 再发 offer(防漏 answer);只收目标主机发来的消息
    this.stopPoll = sigPoll(async (msg) => {
      try {
        if (msg.from !== hostDid) return
        if (msg.type === 'answer' && pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
        } else if (msg.type === 'ice' && msg.candidate) {
          await pc.addIceCandidate(msg.candidate).catch(() => {})
        } else if (msg.type === 'denied') {
          this.setState('failed')
        }
      } catch {
        /* 信令错忽略 */
      }
    })

    pc.addTransceiver('video', { direction: 'recvonly' })
    pc.addTransceiver('audio', { direction: 'recvonly' })

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    if (seq !== this.attemptSeq) throw new Error('建联尝试已被取代')
    // 等 ICE gathering 收一小段再发?phone 是立即发+trickle,保持一致(trickle 经 /signal/ice)
    await sigDeposit('offer', { to: hostDid, sdp: pc.localDescription?.sdp ?? offer.sdp })
    if (seq !== this.attemptSeq) throw new Error('建联尝试已被取代')
    await opened
    this.openedAt = Date.now()
    this.setState('open')
  }

  /** 桌面输入注入(canvas desktop_input::handle_input_json 的 JSON 契约)。 */
  sendInput(msg: Record<string, unknown>): void {
    const ch = this.inputCh
    if (ch && ch.readyState === 'open') {
      try {
        ch.send(JSON.stringify(msg))
      } catch {
        /* 输入丢一条无碍 */
      }
    }
  }

  /** video inbound-rtp 诊断(状态行):收没收到/解没解出。 */
  async stats(): Promise<string> {
    const pc = this.pc
    if (!pc) return ''
    try {
      const st = await pc.getStats()
      let inb = ''
      st.forEach((r) => {
        if (r.type === 'inbound-rtp' && (r as any).kind === 'video') {
          const a = r as any
          inb = `rx=${a.framesReceived ?? 0} dec=${a.framesDecoded ?? 0} lost=${a.packetsLost ?? 0}`
        }
      })
      return inb
    } catch {
      return ''
    }
  }

  close(): void {
    this.attemptSeq++ // 作废在途建联:手动断开后其迟到的 resolve 不得复活状态
    this.stopPoll?.()
    this.stopPoll = null
    this.pc?.close()
    this.pc = null
    this.inputCh = null
    this.rpcCh = null
    // 在途 rpc 一律拒绝(防调用方 await 吊死)
    for (const [, p] of this.rpcPending) {
      clearTimeout(p.timer)
      p.reject(new Error('连接已关闭'))
    }
    this.rpcPending.clear()
    this.rpcChunks.clear()
    this.setState('closed')
  }

  private rpcSettle(v: { id?: number; data?: any }): void {
    const p = this.rpcPending.get(v.id ?? -1)
    if (!p) return
    this.rpcPending.delete(v.id ?? -1)
    clearTimeout(p.timer)
    p.resolve(v.data)
  }

  /** rpc 调用(canvas projection handle_line 同语义):`rpcCall('remoteusage')` → data。 */
  rpcCall<T = any>(line: string, timeoutMs = 6000): Promise<T> {
    const ch = this.rpcCh
    if (!ch || ch.readyState !== 'open') return Promise.reject(new Error('rpc 通道未开'))
    const id = ++this.rpcSeq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpcPending.delete(id)
        reject(new Error(`rpc 超时: ${line.slice(0, 40)}`))
      }, timeoutMs)
      this.rpcPending.set(id, { resolve, reject, timer })
      ch.send(JSON.stringify({ id, line }))
    })
  }
}
