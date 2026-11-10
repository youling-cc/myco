/**
 * vnet-forward-native-fallback.test.ts — 原生数据面 arm 失败时的**回落纪律**（2026-11-01）。
 *
 * 背景：数据面泛化到所有 env 端口后，`startForward` 一律先 arm `:tunnel` 进程。
 * 但两种情况下 arm 必失败：
 *   ① 旧壳（没有 MycoShell.vnetRdpArm / 服务起不来）；
 *   ② 身份还没就绪（`armNativeStreamWithLegs` 直接返回"身份未就绪"）。
 * 这两种情况**不能让用户看到"打不开"**：必须回落主进程 JS 监听（能连，只是
 * WebView 冻结期间会停摆），并等下一轮 arm（网络重置 / 30s 定时 / 身份就绪后
 * 再来一次）成功时把监听交还给 `:tunnel` 进程。
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
let armOk = false
const armCalls: string[] = []
let startCalls = 0
let stopCalls: number[] = []

beforeAll(async () => {
  fwd = await import('./vnet-forward')
  const ident = await import('./identity')
  ident.adoptDeviceKey(randomBytes(32).toString('base64'))

  g.MycoShell = {
    vnetRdpArm: (json: string) => {
      armCalls.push(json)
      return armOk ? '{"ok":true}' : '{"ok":false,"err":"服务未就绪"}'
    },
    vnetStreamDisarm: () => '{"ok":true}',
    vnetRdpState: () => '{"ok":true,"armed":false}',
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

  fwd.saveForwards([{ localPort: 23390, device: 'did:myco:zEcs', port: 3389, enabled: true }])
})

describe('原生 arm 失败 → 回落 JS 监听（不打不开）', () => {
  it('arm 返回失败 → startForward 仍 ok，且真的起了主进程监听', () => {
    const f = fwd.loadForwards().find((x) => x.localPort === 23390)
    expect(f).toBeDefined()
    if (!f) return
    const r = fwd.startForward(f)
    expect(r.ok).toBe(true)
    expect(startCalls).toBe(1) // 回落 JS
    expect(stopCalls).not.toContain(23390) // 别把唯一的监听关掉
    expect(armCalls.length).toBeGreaterThan(0) // arm 真的试过
  })

  it('下一轮 arm 成功（网络重置路径）→ 关掉主进程监听，交 :tunnel 进程', () => {
    armOk = true
    stopCalls = []
    fwd.resetNetworkStreams()
    expect(stopCalls).toContain(23390)
  })
})
