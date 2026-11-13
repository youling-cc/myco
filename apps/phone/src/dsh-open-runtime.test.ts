/**
 * dsh-open-runtime.test.ts — 「点卡就进」**VNETP 直入唯一路径**的行为锁（2026-11-12）。
 *
 * 取票链（openSharedTask/provider B/预取票/自动重试/旧卡自愈）已整链删除；
 * 本文件锁删除后的四类不可回退行为：
 *   a) 同账号卡 VNETP ensure 失败 → 如实 unreachable（绝不开 mt、绝不静默、绝不开页）；
 *   b) 跨账号卡 → unsupported 明确话术（连 ensure 都不发起）；
 *   c) 复用快径仍工作（reuseSharePage 命中 → 不走隧道、秒回）；
 *   d) ensure 成功 → 打开的必须是 `http://127.0.0.1:<口>/gw/<id>/`（15200 直入、无 mt 参数）。
 *
 * 身份/原生壳经 vi.mock 注入（openTaskShare 的判定依赖 tunnelIdentity）；
 * `p2pTunnelEnsureAsync` 用假 MycoShell 复刻 Java 异步桥（回调 window.<cb>），
 * 走的是**真的** ensureDeviceForward 链（含 targetPort 断言：打的是 15200，不是 13911）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const opened = vi.hoisted(() => ({ calls: [] as string[], ok: true as boolean }))
const ident = vi.hoisted(() => ({ account: 'did:youling:zAcct', device: 'did:myco:zPhoneDev', ready: true }))

vi.mock('./identity', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./identity')>()
  return {
    ...orig,
    currentIdentity: () => (ident.ready ? ({ did: ident.device, nodeId: 't' }) : null),
    getRootIdentity: () => (ident.ready ? ident.account : null),
    getAttestation: () => (ident.ready ? { rootDid: ident.account } : null),
  }
})

vi.mock('./native-proxy', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./native-proxy')>()
  return {
    ...orig,
    openShareInWebView: (url: string, title: string) => {
      opened.calls.push(`${title}|${url}`)
      return opened.ok
    },
  }
})

import { readFileSync } from 'node:fs'
import { openTaskShare } from './dsh-open-runtime'

/** 假 MycoShell：reuseSharePage / p2pTunnelEnsureAsync（Java 异步桥的 JS 侧形状）。 */
const shell = {
  reuse: 'MISS' as string,
  ensureCalls: 0,
  ensureJsons: [] as string[],
  /** 本拍 ensure 的回包（null = 模拟"没回包/失败"→ ensureDeviceForward 收 null）。 */
  reply: null as null | { ok: boolean; localPort?: number },
}
const g = globalThis as unknown as { window?: Record<string, unknown> }
g.window = {
  MycoShell: {
    reuseSharePage: () => shell.reuse,
    p2pTunnelEnsureAsync: (callbackJs: string, json: string) => {
      shell.ensureCalls += 1
      shell.ensureJsons.push(json)
      const r = shell.reply ?? { ok: false }
      // Java 侧是后台线程完成后 evaluateJavascript 回调——microtask 复刻足够
      queueMicrotask(() => {
        const w = (globalThis as unknown as { window?: Record<string, unknown> }).window
        const cb = w?.[callbackJs] as ((r: unknown) => void) | undefined
        cb?.(r)
      })
    },
  },
}

/** 每个用例用**不同的源设备**（syncTunnelCache 按 device|port 缓存成功口 30s，避免串台）。 */
let devSeq = 0
function card(over: Record<string, unknown> = {}): Record<string, unknown> {
  devSeq += 1
  return {
    shareId: 'sh-vnetp-' + devSeq,
    sourceDevice: 'did:myco:zPc' + devSeq,
    sourceAccount: ident.account,
    sourceDeviceName: '办公室的电脑',
    title: 'DSH 分享',
    // 2026-11-13 干净 URL 唯一形态：env 必带 deviceAlias/shareAlias（/gw/ 回落已删）。
    env: [{ kind: 'dsh', deviceAlias: 'office-pc', shareAlias: 'main', device: 'did:myco:zPc' + devSeq, port: 13911 }],
    ...over,
  }
}

beforeEach(() => {
  opened.calls.length = 0
  opened.ok = true
  shell.reuse = 'MISS'
  shell.ensureCalls = 0
  shell.ensureJsons.length = 0
  shell.reply = null
  ident.ready = true
})

describe('openTaskShare：VNETP 直入是唯一路径（2026-11-12 取票链删除后）', () => {
  it('c) 复用快径仍工作：reuseSharePage=OK → 秒回 ok，不起隧道、不开新页', async () => {
    shell.reuse = 'OK'
    const r = await openTaskShare(card())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.via).toBe('reuse')
      expect(r.url).toBe('reused')
    }
    expect(shell.ensureCalls).toBe(0)
    expect(opened.calls).toEqual([]) // 复用 = 不再开新 WebView
  })

  it('d) ensure 成功 → 打开干净 URL（<alias>.localhost，无 mt、无 /gw/ 形态），via=vnetp-direct', async () => {
    shell.reply = { ok: true, localPort: 25930 }
    const c = card()
    const r = await openTaskShare(c)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    // 2026-11-13：唯一 URL 形态 = http://<deviceAlias>.localhost:<口>/<shareAlias>/
    expect(r.url).toBe('http://office-pc.localhost:25930/main/')
    expect(r.url).not.toContain('/gw/')
    expect(r.localPort).toBe(25930)
    expect(r.via).toBe('vnetp-direct')
    expect(r.url).not.toContain('mt=')
    expect(opened.calls).toEqual([`DSH 分享|${r.url}`])
    // 2026-11-13 三端统一：ensure 打的是 24011（public_router Host 分发），
    // 不是 15200 老 VNETP 挂载、也不是 13911 裸网关
    expect(shell.ensureCalls).toBe(1)
    expect(shell.ensureJsons[0]).toContain('"targetPort":24011')
    expect(shell.ensureJsons[0]).not.toContain('13911')
  })

  it('a) 同账号卡 VNETP 失败 → 如实 unreachable：绝不开 mt、绝不静默、绝不开页', async () => {
    shell.reply = { ok: false } // 隧道 ensure 失败（对端离线/隧道断）
    const r = await openTaskShare(card())
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('unreachable')
    expect(r.message).toBe('连不上源设备（设备隧道不可用），请确认对方设备在线后重试')
    expect(r.message).not.toContain('mt')
    expect(opened.calls).toEqual([]) // 没有任何页被打开（无 mt 回落可言）
    expect(shell.ensureCalls).toBe(1) // 确实试过隧道，不是没试就报错
  })

  it('a2) ensure 异常（桥抛错）→ 同样如实 unreachable，不吞不糊弄', async () => {
    ;(g.window!.MycoShell as { p2pTunnelEnsureAsync: unknown }).p2pTunnelEnsureAsync = () => {
      throw new Error('Java bridge method can\'t be invoked on a non-injected object')
    }
    try {
      const r = await openTaskShare(card())
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error('unreachable')
      expect(r.reason).toBe('unreachable')
      expect(r.message).toContain('连不上源设备')
      expect(opened.calls).toEqual([])
    } finally {
      ;(g.window!.MycoShell as Record<string, unknown>).p2pTunnelEnsureAsync = (
        callbackJs: string,
        json: string,
      ) => {
        shell.ensureCalls += 1
        shell.ensureJsons.push(json)
        const r = shell.reply ?? { ok: false }
        queueMicrotask(() => {
          const w = (globalThis as unknown as { window?: Record<string, unknown> }).window
          ;(w?.[callbackJs] as ((r: unknown) => void) | undefined)?.(r)
        })
      }
    }
  })

  it('开页失败（openShareInWebView 回 false）→ 如实报开页失败，不谎报成功', async () => {
    shell.reply = { ok: true, localPort: 25931 }
    opened.ok = false
    const r = await openTaskShare(card())
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('unsupported')
    expect(r.message).toContain('打不开分享页')
    expect(r.message).not.toContain('连不上源设备') // 页面层失败 ≠ 隧道层失败，不混话术
  })

  it('旧形态卡（env 缺 deviceAlias/shareAlias）→ 如实要求重收新卡，不猜 /gw/ URL（2026-11-13 回落已删）', async () => {
    shell.reply = { ok: true, localPort: 25932 } // 隧道层必须成功——失败点在 URL 组装层
    const r = await openTaskShare(card({ env: [{ kind: 'dsh', device: 'did:myco:zPcx', port: 13911 }] }))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('unsupported')
    expect(r.message).toContain('旧形态')
    expect(opened.calls).toEqual([]) // 不开页
    expect(shell.ensureCalls).toBe(1) // 隧道已 ensure（失败在 URL 组装层，不在隧道层）
  })

  it('b) 跨账号卡 → unsupported 明确话术，ensure 一律不发起', async () => {
    const r = await openTaskShare(card({ sourceAccount: 'did:youling:zSomebodyElse' }))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('unsupported')
    expect(r.message).toBe('暂只支持本账号设备的分享入口（跨账号分享请从 PC 端打开）')
    expect(shell.ensureCalls).toBe(0)
    expect(opened.calls).toEqual([])
  })

  it('卡上没有分享坐标（shareCardOf=null）→ internal 人话', async () => {
    const r = await openTaskShare({ title: '普通消息卡' })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('internal')
    expect(r.message).toContain('没有可打开的分享信息')
    expect(shell.ensureCalls).toBe(0)
  })
})

describe('源码合同：取票链不得回归（mt/预取/重试外壳已删）', () => {
  const src = readFileSync(new URL('./dsh-open-runtime.ts', import.meta.url), 'utf8')

  it('openTaskShareOnce 内不得再有 openSharedTask/prefetch/retryTransient 调用', () => {
    expect(src).not.toContain('openSharedTask(')
    expect(src).not.toContain('prefetchShareEntry(')
    expect(src).not.toContain('prefetchTaskEntry')
    expect(src).not.toContain('retryTransient(')
    expect(src).not.toContain('removeTasksByShareId')
  })

  it('VNETP 失败的两句人话在位（unreachable / unsupported 锚点）', () => {
    expect(src).toContain("'连不上源设备（设备隧道不可用），请确认对方设备在线后重试'")
    expect(src).toContain("'暂只支持本账号设备的分享入口（跨账号分享请从 PC 端打开）'")
    // 聊天/对账链的 relay 装配必须保留
    expect(src).toContain('setRelayDeliver(')
    expect(src).toContain('setRelayDeliverReply(')
    expect(src).toContain('setVnetP2pTunnel(')
  })
})
