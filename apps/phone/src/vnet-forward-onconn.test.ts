/**
 * vnet-forward-onconn.test.ts — 0.3.158 真机回归网（2026-10-23）。
 *
 * 现场：`window.__mycoFwd.onConn(23389,901)` 被 eval 调用时"返回 null、看似 JS 卡死"。
 * 真因在 Java 壳的 EnvServer eval 通道（UiRun kind4 把语句脚本包进 `v=(...)` → 语法
 * 错误 → completion 恒 null），JS 侧本身无辜。本测试守住 JS 侧底线：
 *   ① onConn 包装器**同步返回**（不抛、不挂），主体立即落 FWD_LOG（logs() 可读）；
 *   ② 桥桩抛异常也不拖垮后续 onConn（异步尾的异常必须被 onConn 内部消化）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomBytes } from 'node:crypto'

// ── 全局桩（必须在动态 import 业务模块之前装好：identity.ts 模块加载即读 localStorage）──
const store = new Map<string, string>()
const g = globalThis as unknown as Record<string, unknown>
g.window = globalThis
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
}

let fwd: typeof import('./vnet-forward')

beforeAll(async () => {
  fwd = await import('./vnet-forward')
  // 身份就绪（plain 设备钥）——否则 onConn 走 identity-not-ready 分支，测不到 race 尾
  const ident = await import('./identity')
  ident.adoptDeviceKey(randomBytes(32).toString('base64'))
  // MycoShell 桩：即时返回（真机的阻塞桥行为属 Java 侧范畴，另有加固）
  g.MycoShell = {
    vnetForwardStart: () => '{"ok":true}',
    vnetForwardStop: () => undefined,
    vnetForwardList: () => '{"ok":true,"forwards":[]}',
    vnetForwardSend: () => undefined,
    vnetForwardClose: () => undefined,
    relayPredial: () => 'OK',
    tunnelOpenWs: () => '',
    tunnelWsSend: () => undefined,
    tunnelWsClose: () => undefined,
  }
  fwd.saveForwards([{ localPort: 23389, device: 'did:myco:zFakePc', port: 3389, enabled: true }])
  fwd.bootVnetForwards()
})

describe('__mycoFwd.onConn：调用即返回、主体立即落日志（0.3.158 现场回归网）', () => {
  it('onConn 同步返回 undefined（不抛、不卡），FWD_LOG 立即出现 conn 行', () => {
    const w = g as unknown as {
      __mycoFwd: { onConn: (p: number, id: number) => unknown }
      __mycoVnet: { logs: () => string[]; clearLogs: () => void }
    }
    w.__mycoVnet.clearLogs()
    const before = w.__mycoVnet.logs().length
    let ret: unknown = 'SENTINEL_NOT_RETURNED'
    let threw: unknown = null
    try {
      ret = w.__mycoFwd.onConn(23389, 901)
    } catch (e) {
      threw = e
    }
    expect(threw).toBeNull()
    expect(ret).toBeUndefined() // 真机"卡死"时调用永不返回——此处必须瞬间拿到返回值
    const logs = w.__mycoVnet.logs()
    expect(logs.length).toBeGreaterThan(before)
    expect(logs.some((l) => l.includes('conn 23389/901'))).toBe(true)
  })

  it('桥桩抛异常（tunnelOpenWs 抛错）不拖垮后续 onConn', async () => {
    ;(g.MycoShell as Record<string, unknown>).tunnelOpenWs = () => {
      throw new Error('bridge boom')
    }
    const w = g as unknown as { __mycoFwd: { onConn: (p: number, id: number) => unknown } }
    expect(() => w.__mycoFwd.onConn(23389, 902)).not.toThrow()
    await new Promise((r) => setTimeout(r, 30))
    expect(() => w.__mycoFwd.onConn(23389, 903)).not.toThrow()
  })
})
