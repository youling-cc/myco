/**
 * vnet-forward-native-rdp.test.ts — 2026-10-26 RDP/DSH 独立进程回归网。
 *
 * 真机结论：
 *  - 23389（RDP）在外部 RDP App 前台时会被荣耀冻结；
 *  - 23911（DSH）在 InAppBrowser 覆盖主 WebView 时，`document.hidden` 导致
 *    `__mycoFwd`/`__mycoTunnel` 回调停投，页面报 `ERR_EMPTY_RESPONSE`。
 *
 * 因此两个端口都必须由 `TunnelProcessService`（`:tunnel` 进程）承载，
 * 主进程 JS 只做身份/arm，不再自己开 23389/23911 监听。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomBytes } from 'node:crypto'

const store = new Map<string, string>()
const g = globalThis as unknown as Record<string, unknown>
g.window = globalThis
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
}

let fwd: typeof import('./vnet-forward')
const armCalls: string[] = []
let startCalls = 0
let stopCalls: number[] = []
let disarmCalls: number[] = []

beforeAll(async () => {
  fwd = await import('./vnet-forward')
  const ident = await import('./identity')
  ident.adoptDeviceKey(randomBytes(32).toString('base64'))

  g.MycoShell = {
    vnetRdpArm: (json: string) => {
      armCalls.push(json)
      return '{"ok":true,"armed":true,"pending":true}'
    },
    vnetStreamDisarm: (p: number) => {
      disarmCalls.push(p)
      return '{"ok":true,"armed":false}'
    },
    vnetRdpState: () => '{"ok":true,"armed":true}',
    vnetForwardStart: () => {
      startCalls++
      return '{"ok":true}'
    },
    vnetForwardStop: (p: number) => {
      stopCalls.push(p)
      return undefined
    },
    vnetForwardList: () => '{"ok":true,"forwards":[]}',
    vnetForwardSend: () => undefined,
    vnetForwardClose: () => undefined,
    relayPredial: () => 'OK',
    tunnelOpenWs: () => '',
    tunnelWsSend: () => undefined,
    tunnelWsClose: () => undefined,
  }

  fwd.saveForwards([
    { localPort: 23389, device: 'did:myco:zFakePc', port: 3389, enabled: true },
    { localPort: 23911, device: 'did:myco:zFakePc', port: 13911, enabled: true },
    // 2026-11-01 泛化：非 RDP/DSH 的 env 端口（ECS RDP / VNC / RustDesk）同样要原生托管
    { localPort: 23390, device: 'did:myco:zFakeEcs', port: 3389, enabled: true },
    { localPort: 23590, device: 'did:myco:zFakePc', port: 5900, enabled: true },
    { localPort: 23591, device: 'did:myco:zFakePc', port: 21118, enabled: true },
  ])
})

function lastArmFor(localPort: number): Record<string, unknown> {
  const raw = [...armCalls].reverse().find((x) => {
    try {
      return (JSON.parse(x) as { localPort?: number }).localPort === localPort
    } catch {
      return false
    }
  })
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

describe('startForward(23389/23911)：RDP/DSH 走独立进程，不回落主进程 JS 监听', () => {
  it('RDP 23389 arm 注入 3389 + 清主进程监听，且不调 vnetForwardStart', () => {
    const f = fwd.loadForwards().find((x) => x.localPort === 23389)
    expect(f).toBeDefined()
    if (!f) return

    const r = fwd.startForward(f)
    expect(r.ok).toBe(true)
    expect(lastArmFor(23389)).toMatchObject({
      localPort: 23389,
      targetPort: 3389,
      targetDevice: 'did:myco:zFakePc',
    })
    expect(stopCalls).toContain(23389)
    expect(startCalls).toBe(0)
  })

  it('DSH 23911 arm 注入 13911 + 清主进程监听，且不调 vnetForwardStart', () => {
    stopCalls = []
    const f = fwd.loadForwards().find((x) => x.localPort === 23911)
    expect(f).toBeDefined()
    if (!f) return

    const r = fwd.startForward(f)
    expect(r.ok).toBe(true)
    expect(lastArmFor(23911)).toMatchObject({
      localPort: 23911,
      targetPort: 13911,
      targetDevice: 'did:myco:zFakePc',
    })
    expect(stopCalls).toContain(23911)
    expect(startCalls).toBe(0)
  })

  it('删除 DSH 23911 时必须撤注原生流端口', () => {
    fwd.removeForward(23911)
    expect(disarmCalls).toContain(23911)
  })
})

/**
 * 2026-11-01 真机（用户手机连 ECS Linux 一直「正在启动」）：
 * 23390 这类"后加的 env 端口"此前只在 JS 侧开监听 → myco 切后台、WebView
 * `document.hidden` 后 Chromium 停投 `__mycoFwd` → native accept 了但 JS 不拨号。
 * 定案：不再维护白名单，**任意已配置转发都优先 arm 到 :tunnel 进程**。
 */
describe('泛化：任意 env 端口都优先走原生数据面（无白名单）', () => {
  const cases: Array<[number, number]> = [
    [23390, 3389], // ECS Linux RDP
    [23590, 5900], // VNC
    [23591, 21118], // RustDesk
  ]
  for (const [localPort, targetPort] of cases) {
    it(`${localPort} → arm 注入 ${targetPort}，且不回落主进程 JS 监听`, () => {
      stopCalls = []
      const f = fwd.loadForwards().find((x) => x.localPort === localPort)
      expect(f).toBeDefined()
      if (!f) return
      const beforeStart = startCalls

      const r = fwd.startForward(f)
      expect(r.ok).toBe(true)
      expect(lastArmFor(localPort)).toMatchObject({
        localPort,
        targetPort,
        targetDevice: f.device,
      })
      expect(stopCalls).toContain(localPort) // 主进程监听已关，交 :tunnel
      expect(startCalls).toBe(beforeStart) // 没有回落 JS 监听
    })
  }

  it('删除任意端口（23390）也要撤注原生流端口', () => {
    disarmCalls = []
    fwd.removeForward(23390)
    expect(disarmCalls).toContain(23390)
  })
})
