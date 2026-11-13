/**
 * task-open.test.ts — 手机端「任务卡打开」路由/执行（2026-10-23 真机 bug）。
 *
 * 现场：手机任务列表点开带 env 的卡 → 落到 `/gw/<id>/app/` 报
 * `no valid share cookie (open the share entry first)`。
 * 期望：有 env 的卡按环境直开（RDP→复制地址 / DSH→浏览器），不再走分享入口。
 *
 * 2026-11-12 起（取票/mt 链整链删除）DSH 分享入口的规则：
 *   · 有分享入口（`/gw/…` entryUrl 或 env.shareId）→ **VNETP 直入是唯一路径**
 *     （设备隧道 15200）；拿不到口 → 如实 blocked，绝不回落 mt entryUrl；
 *   · 无 shareId 的普通 http env → 照旧（entryUrl 白名单 → 根路径直开）。
 *
 * 断言的是**行为**（到底拉没拉起客户端、复制了什么、建没建 13911 通道），不是文案快照。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  canOpenEnvExternal,
  declaredEnvsOfCard,
  envOpenLabel,
  openNoteTone,
  openRouteOf,
  openTaskEnv,
  openTaskEnvExternal,
  primaryEnvOf,
  type EnvOpenDeps,
} from './task-open'
import type { TaskEnv } from './task-env'
import { fnBodyOf } from './test-support/fn-body'

interface Calls {
  copy: string[]
  rdp: string[]
  url: string[]
  add: { localPort: number; device: string; port: number; label?: string }[]
}

/** 全套假依赖（记录每一条外部效果）。 */
function deps(
  over: Partial<EnvOpenDeps> & { addOk?: boolean; presence?: string | null; rdpBridge?: boolean } = {},
): EnvOpenDeps & { calls: Calls } {
  const calls: Calls = { copy: [], rdp: [], url: [], add: [] }
  const base: EnvOpenDeps = {
    vnet: {
      add: (f) => {
        calls.add.push(f)
        return { ok: over.addOk === undefined ? true : over.addOk }
      },
      ...(over.presence === null
        ? {}
        : { presence: async () => over.presence ?? 'addrs-ok | n=3' }),
    },
    copy: async (t) => {
      calls.copy.push(t)
      return true
    },
    hasRdp: () => over.rdpBridge === true,
    openRdp: (addr) => {
      calls.rdp.push(addr)
      return true
    },
    openUrl: (url) => {
      calls.url.push(url)
      return true
    },
  }
  return { ...base, ...over, calls }
}

/**
 * 假 localStorage：`pickPhoneForward` 从 `myco.vnetForwards` 读「本机隧道口」表，
 * 这里只喂这一张表（RDP 地址选择的行为断言用）。
 */
function withLocalForwards(list: unknown[]): () => void {
  const g = globalThis as unknown as { localStorage?: unknown }
  const prev = g.localStorage
  g.localStorage = {
    getItem: (k: string) => (k === 'myco.vnetForwards' ? JSON.stringify(list) : null),
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  }
  return () => {
    if (prev === undefined) delete g.localStorage
    else g.localStorage = prev
  }
}

const RDP: TaskEnv = { kind: 'rdp', device: 'did:myco:zPC', port: 3389, localPort: 23389 }
const DSH: TaskEnv = { kind: 'dsh', device: 'did:myco:zPC', port: 13911, localPort: 23911 }

describe('列表行路由：env 卡 → 环境；老卡 → 分享入口', () => {
  it('有 env → via=env，主入口 rdp（标签按 kind）', () => {
    const card = {
      taskId: 'peer-task-share-sh-pc-env-rdp',
      shareId: 'sh-pc-env-rdp',
      env: [DSH, RDP],
    }
    const r = openRouteOf(card, { kind: 'open-env', env: [DSH, RDP], shareId: 'sh-pc-env-rdp', label: '打开远程桌面' })
    expect(r.via).toBe('env')
    if (r.via !== 'env') throw new Error('unreachable')
    expect(r.env.kind).toBe('rdp')
    expect(r.label).toBe('打开远程桌面')
    expect(primaryEnvOf([DSH])?.kind).toBe('dsh')
    expect(envOpenLabel(RDP)).toBe('打开远程桌面')
  })

  it('存量卡：env[] 在、动作还是 open-url（老同步记录）→ 仍走 env', () => {
    const card = { shareId: 'sh-x', env: [RDP], caps: ['vnet.forward'] }
    const r = openRouteOf(card, { kind: 'open-url', url: 'http://127.0.0.1:3102/api/dshShare/open?shareId=sh-x' })
    expect(r.via).toBe('env')
  })

  it('没有 env 的老卡 → via=share（保持 openTaskShare 原行为）', () => {
    const card = { shareId: 'sh-old', sourceDevice: 'did:myco:zOld' }
    expect(declaredEnvsOfCard(card, { kind: 'open-url', url: 'http://x' })).toEqual([])
    expect(openRouteOf(card, { kind: 'open-url', url: 'http://x' }).via).toBe('share')
  })

  it('老卡只有 sourceDevice → 不派生 env（不偷偷把分享入口改成 RDP）', () => {
    expect(declaredEnvsOfCard({ sourceDevice: 'did:myco:zOld' }, undefined)).toEqual([])
    expect(openRouteOf({ sourceDevice: 'did:myco:zOld' }, undefined).via).toBe('none')
  })
})

describe('RDP：手机没有 mstsc → 拿本机隧道口 + 明确下一步（2026-11-11：提示行必须带地址）', () => {
  it('没有壳桥、也没有本机隧道口 → 回退卡片地址（addressOf）并提示到远程桌面 App 里粘贴', async () => {
    const d = deps({ rdpBridge: false })
    const r = await openTaskEnv(RDP, { gate: 'ok', deps: d })
    expect(r.state).toBe('ready')
    expect(r.started).toBe(true)
    expect(d.calls.rdp).toEqual([])
    expect(d.calls.copy).toEqual(['127.0.0.1:23389'])
    expect(r.note).toContain('已复制连接地址')
    expect(r.note).toContain('请在你的远程桌面 App 里粘贴连接')
    // 2026-11-11 真机：WebView 里 clipboard 常没有用户手势 → 复制必败；提示行必须
    // 自带地址（addrHint），否则用户手上根本没有可粘贴的东西。
    expect(r.note).toContain('（地址 127.0.0.1:23389）')
    // 2026-11-01 真机（用户手机连 ECS Linux 报"没连上"）：RDP 服务端是自签证书，
    // 首次连接必弹证书确认，点取消就等于连不上。提示行必须把这一步和随后的
    // 几秒黑屏说清楚，别让用户误判成"地址/端口填错"。
    expect(r.note).toContain('证书')
    expect(r.note).toContain('不再要求连接到这台电脑')
    expect(r.note).toContain('黑屏')
  })

  it('有本机隧道口（25910-25999）→ 复制隧道口，绝不把卡片里 PC 侧的 23389 当手机地址', async () => {
    const restore = withLocalForwards([
      { localPort: 25911, device: 'did:myco:zPC', port: 3389, enabled: true },
    ])
    try {
      const d = deps({ rdpBridge: false })
      const r = await openTaskEnv(RDP, { gate: 'ok', deps: d })
      expect(d.calls.copy).toEqual(['127.0.0.1:25911'])
      expect(r.address).toBe('127.0.0.1:25911')
      expect(r.note).toContain('（地址 127.0.0.1:25911）')
      // 反向锁：卡片里的 localPort(23389) 是 **PC 侧**口，手机上没人监听——
      // 只要本机隧道口在，就不许再拿它当手机地址（2026-11-11 真机"复制成功连不上"）。
      expect(d.calls.copy[0]).not.toBe('127.0.0.1:23389')
    } finally {
      restore()
    }
  })

  it('隧道口落在 25910-25999 之外 → 不采用（回退卡片地址），段外端口不许当隧道口', async () => {
    const restore = withLocalForwards([
      { localPort: 26000, device: 'did:myco:zPC', port: 3389, enabled: true },
    ])
    try {
      const d = deps({ rdpBridge: false })
      const r = await openTaskEnv(RDP, { gate: 'ok', deps: d })
      expect(d.calls.copy).toEqual(['127.0.0.1:23389'])
      expect(r.address).toBe('127.0.0.1:23389')
    } finally {
      restore()
    }
  })

  it('有壳桥（MycoShell.openRdp）→ 直接用远程桌面打开，不复制', async () => {
    const d = deps({ rdpBridge: true })
    const r = await openTaskEnv(RDP, { gate: 'ok', deps: d })
    expect(d.calls.rdp).toEqual(['127.0.0.1:23389'])
    expect(d.calls.copy).toEqual([])
    expect(r.state).toBe('ready')
    expect(r.note).toContain('正在用远程桌面打开')
    expect(r.note).not.toContain('127.0.0.1')
  })
})

describe('VNC / RustDesk：与 RDP 同款"复制地址"，但**不带**证书引导（按 kind 分文案）', () => {
  const VNC: TaskEnv = { kind: 'vnc', device: 'did:myco:zPC', port: 5900, localPort: 23590 }
  const RD: TaskEnv = { kind: 'rustdesk', device: 'did:myco:zPC', port: 21118, localPort: 23591 }

  it('vnc → 复制 127.0.0.1:23590，提示用 VNC App，无证书/黑屏话术', async () => {
    const d = deps()
    const r = await openTaskEnv(VNC, { gate: 'ok', deps: d })
    expect(r.state).toBe('ready')
    expect(r.started).toBe(true)
    expect(d.calls.copy).toEqual(['127.0.0.1:23590'])
    expect(r.note).toContain('已复制连接地址')
    expect(r.note).toContain('VNC App')
    expect(r.note).not.toContain('证书')
    expect(r.note).not.toContain('黑屏')
  })

  it('rustdesk → 复制 127.0.0.1:23591，提示用 RustDesk App，无证书话术', async () => {
    const d = deps()
    const r = await openTaskEnv(RD, { gate: 'ok', deps: d })
    expect(d.calls.copy).toEqual(['127.0.0.1:23591'])
    expect(r.note).toContain('RustDesk App')
    expect(r.note).not.toContain('证书')
  })

  it('复制失败分支同样带上 RDP 首次连接引导（不让用户卡在证书弹窗）', async () => {
    const d = deps({ copy: async () => false })
    const r = await openTaskEnv(RDP, { gate: 'ok', deps: d })
    expect(r.started).toBe(false)
    expect(r.note).toContain('自动复制失败')
    expect(r.note).toContain('不再要求连接到这台电脑')
  })
})

describe('DSH / HTTP：分享入口只走 VNETP 直入；普通 http env 照旧根路径', () => {
  // ★ 2026-11-12 真机定案后的唯一路径（取票/mt 链已删）：
  //   手机直连 13911 裸网关 =「此分享需要 DID 授权（无凭证）」（mt 会过期）；
  //   设备隧道 15200（VNETP/1 DID 认证）免 mt 直入。拿不到口 → 如实 blocked。
  const GW_ENTRY = 'http://127.0.0.1:23911/gw/sh-pc-env-dsh/?mt=expired'

  it('普通 http env（无 shareId）→ 照旧根路径直开（行为不变）', async () => {
    const d = deps()
    const r = await openTaskEnv(DSH, { gate: 'ok', deps: d })
    expect(d.calls.url).toEqual(['http://127.0.0.1:23911/'])
    expect(d.calls.copy).toEqual([])
    expect(r.state).toBe('ready')
  })

  it('分享入口：ensure 拿到口 → 打开干净 URL（<alias>.localhost，免 mt、免 /gw/ 形态、不建 13911）', async () => {
    const d = deps({ ensureEntryForward: async () => 25914 })
    const r = await openTaskEnv(
      { ...DSH, entryUrl: GW_ENTRY, deviceAlias: 'office-pc', shareAlias: 'dsh' },
      { gate: 'ok', deps: d },
    )
    expect(d.calls.url).toEqual(['http://office-pc.localhost:25914/dsh/'])
    expect(d.calls.url[0]).not.toContain('mt=')
    expect(d.calls.url[0]).not.toContain('/gw/')
    expect(d.calls.add).toEqual([]) // 13911 通道在这条路径上用不到，不再白建
    expect(r.state).toBe('ready')
    expect(r.note).toContain('已在系统浏览器打开')
  })

  it('分享入口：卡缺别名（旧形态）→ 如实 blocked，不猜 /gw/ URL（2026-11-13 回落已删）', async () => {
    const d = deps({ ensureEntryForward: async () => 25915 })
    const r = await openTaskEnv({ ...DSH, entryUrl: GW_ENTRY }, { gate: 'ok', deps: d })
    expect(r.state).toBe('idle')
    expect(r.started).toBe(false)
    expect(r.note).toContain('旧形态')
    expect(d.calls.url).toEqual([]) // 不开页
  })

  it('分享入口：拿不到口 → 如实 blocked，绝不回落 mt、绝不开页、不复制半截地址', async () => {
    // ① ensure 回 null（对端离线/隧道断）
    const fall = deps({ ensureEntryForward: async () => null })
    const r2 = await openTaskEnv({ ...DSH, entryUrl: GW_ENTRY }, { gate: 'ok', deps: fall })
    expect(r2.state).toBe('idle')
    expect(r2.started).toBe(false)
    expect(r2.note).toBe('连不上源设备（设备隧道不可用），请稍后再试')
    expect(fall.calls.url).toEqual([])
    expect(fall.calls.copy).toEqual([])
    expect(fall.calls.add).toEqual([])
    // ② ensure 抛异常（桥坏）→ 同样如实 blocked
    const boom = deps({
      ensureEntryForward: async () => {
        throw new Error('bridge dead')
      },
    })
    const r3 = await openTaskEnv({ ...DSH, entryUrl: GW_ENTRY }, { gate: 'ok', deps: boom })
    expect(r3.state).toBe('idle')
    expect(r3.note).toContain('连不上源设备')
    expect(boom.calls.url).toEqual([])
    // ③ 无 ensure 依赖且无 MycoShell（node/旧壳）→ 不裸开卡上的 owner 入口
    const bare = deps()
    const r4 = await openTaskEnv({ ...DSH, entryUrl: GW_ENTRY }, { gate: 'ok', deps: bare })
    expect(r4.state).toBe('idle')
    expect(bare.calls.url).toEqual([])
    expect(bare.calls.copy).toEqual([])
  })

  it('env.shareId 坐标同样走 VNETP（不只认 entryUrl 形态）', async () => {
    const d = deps({ ensureEntryForward: async () => 25916 })
    const env = { ...DSH, shareId: 'sh-from-env', deviceAlias: 'office-pc', shareAlias: 'main' } as TaskEnv & { shareId: string }
    const r = await openTaskEnv(env, { gate: 'ok', deps: d })
    expect(d.calls.url).toEqual(['http://office-pc.localhost:25916/main/'])
    expect(r.state).toBe('ready')
  })

  it('分享入口：ensure 口 + 应用内浏览器桥 → openInAppBrowser(隧道 URL + 焦点守卫)，不走系统浏览器', async () => {
    const d = deps({ ensureEntryForward: async () => 25914 })
    const inApp: { url: string[]; guard: string[] } = { url: [], guard: [] }
    const g = globalThis as unknown as { window?: unknown }
    const prevWindow = g.window
    ;(globalThis as unknown as { window: { MycoShell: unknown } }).window = {
      MycoShell: {
        openInAppBrowser: (u: string, guardJs?: string) => {
          inApp.url.push(u)
          if (guardJs) inApp.guard.push(guardJs)
          return '{"ok":true}'
        },
      },
    }
    try {
      const r = await openTaskEnv(
        { ...DSH, entryUrl: GW_ENTRY, deviceAlias: 'office-pc', shareAlias: 'dsh' },
        { gate: 'ok', deps: d },
      )
      expect(inApp.url).toHaveLength(1)
      expect(inApp.url[0]).toBe('http://office-pc.localhost:25914/dsh/')
      expect(inApp.url[0]).not.toContain('mycoClient=') // 断言 fragment 随取票链删除
      expect(inApp.url[0]).not.toContain('/gw/') // 2026-11-13 老形态已删
      expect(inApp.guard.length).toBe(1) // 焦点守卫脚本随行（点会话不弹软键盘）
      expect(d.calls.url).toEqual([]) // 没有回落系统浏览器
      expect(r.state).toBe('ready')
      expect(r.note).toContain('已在应用内浏览器打开')
      expect(r.note).not.toContain('http')
    } finally {
      // 恢复无 window 的默认测试环境（其它用例依赖「无桥 → 回落」路径）
      if (prevWindow === undefined) delete g.window
      else g.window = prevWindow
    }
  })

  it('非分享形态的坏 entryUrl → 绝不打开它，回落根路径并如实说明', async () => {
    const d = deps()
    for (const bad of [
      'https://evil.example/dsh',
      'http://127.0.0.1:23911@evil.example/',
      'http://10.0.0.1:23911/',
    ]) {
      d.calls.url.length = 0
      const r = await openTaskEnv({ ...DSH, entryUrl: bad }, { gate: 'ok', deps: d })
      expect(d.calls.url).toEqual(['http://127.0.0.1:23911/'])
      expect(r.note).toContain('入口不可用')
      expect(r.state).toBe('ready')
    }
    // 分享形态（/gw/…）的坏 entryUrl（端口不符）不回落根路径——VNETP 拿不到口就 blocked
    const r2 = await openTaskEnv({ ...DSH, entryUrl: 'http://127.0.0.1:23912/gw/sh-x/' }, { gate: 'ok', deps: deps() })
    expect(r2.state).toBe('idle')
    expect(r2.note).toContain('连不上源设备')
  })

  // ── 2026-11-03 真案（手机返回再进 ERR_EMPTY_RESPONSE）：探测+重建路径 ──
  // （13911 通道只服务无 shareId 的普通 http env；这里用普通 DSH 触发）
  it('桥有 remove → 首次探测不通自动重建，重建通了才开页（不把空页开给用户）', async () => {
    let probeCount = 0
    const removed: number[] = []
    const d = deps({
      vnet: {
        add: () => ({ ok: true }),
        remove: (p: number) => { removed.push(p) },
        presence: async () => 'addrs-ok',
      } as unknown as import('./task-env').VnetBridge,
    })
    // mock fetch：第一次超时（半死），重建后 200
    const origFetch = globalThis.fetch
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_input: RequestInfo | URL) => {
      probeCount++
      if (probeCount <= 1) throw new Error('net::ERR_EMPTY_RESPONSE')
      return new Response('', { status: 404 })
    }) as typeof fetch
    try {
      const r = await openTaskEnv(DSH, { gate: 'ok', deps: d })
      expect(removed).toEqual([23911]) // 半死后 remove 了旧口
      expect(probeCount).toBe(2) // 探了两次（首探失败 + 重建后成功）
      expect(r.state).toBe('ready') // 重建通了 → 正常开页
    } finally {
      ;(globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch
    }
  })

  it('桥有 remove → 重建后仍不通 → 不开页、报人话错误（不假装成功）', async () => {
    const d = deps({
      vnet: {
        add: () => ({ ok: true }),
        remove: () => undefined,
        presence: async () => 'addrs-ok',
      } as unknown as import('./task-env').VnetBridge,
    })
    const origFetch = globalThis.fetch
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
      throw new Error('always dead')
    }) as typeof fetch
    try {
      const r = await openTaskEnv(DSH, { gate: 'ok', deps: d })
      expect(r.state).toBe('idle')
      expect(r.started).toBe(false)
      expect(r.note).toContain('连接不通')
      expect(r.note).toContain('重建')
    } finally {
      ;(globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch
    }
  })

  it('HTTP kind 同样入口规则：有分享坐标走 VNETP，没有则根路径照旧', async () => {
    const httpEnv = { kind: 'http', device: 'did:myco:zPC', port: 13911, localPort: 23912 } as TaskEnv
    // ① 无 shareId → 根路径直开（不变）
    const plain = deps()
    const r1 = await openTaskEnv(httpEnv, { gate: 'ok', deps: plain })
    expect(plain.calls.url).toEqual(['http://127.0.0.1:23912/'])
    expect(r1.state).toBe('ready')
    // ② 有分享坐标（shareId）→ VNETP 直入（干净 URL；缺别名 → 如实旧形态）
    const tun = deps({ ensureEntryForward: async () => 25917 })
    const r2 = await openTaskEnv(
      { ...httpEnv, shareId: 'sh-http', deviceAlias: 'office-pc', shareAlias: 'svc' } as TaskEnv,
      { gate: 'ok', deps: tun },
    )
    expect(tun.calls.url).toEqual(['http://office-pc.localhost:25917/svc/'])
    expect(r2.state).toBe('ready')
  })
})

describe('「↗ 浏览器」：复制地址 + 系统浏览器（主路径仍是应用内壳，2026-10-31）', () => {
  const ENTRY = 'http://127.0.0.1:23911/gw/sh-pc-env-dsh/?mt=expired'

  it('分享入口：复制/打开的都是 VNETP 直入 URL（同一地址；不再建 13911 固定口）', async () => {
    const d = deps({ ensureEntryForward: async () => 25914 })
    const r = await openTaskEnvExternal(
      { ...DSH, entryUrl: ENTRY, deviceAlias: 'office-pc', shareAlias: 'dsh' },
      { gate: 'ok', deps: d },
    )
    expect(d.calls.copy).toHaveLength(1)
    expect(d.calls.url).toHaveLength(1)
    // 复制的那条 = 交给浏览器的那条（用户收藏的就是实际打开的地址）
    expect(d.calls.url[0]).toBe(d.calls.copy[0])
    expect(d.calls.url[0]).toBe('http://office-pc.localhost:25914/dsh/')
    expect(d.calls.url[0]).not.toContain('mt=')
    expect(d.calls.url[0]).not.toContain('/gw/')
    // 分享入口在设备隧道上，13911 固定口不白建
    expect(d.calls.add).toEqual([])
    expect(r.state).toBe('ready')
    expect(r.started).toBe(true)
    expect(r.note).toBe('已在浏览器打开（地址已复制）')
    expect(r.address).toBe('127.0.0.1:23911')
    expect(openNoteTone(r.note, r.state)).toBe('ok')
  })

  it('分享入口拿不到隧道口 → 明确报错，不复制、不打开（不给半截地址）', async () => {
    const d = deps({ ensureEntryForward: async () => null })
    const r = await openTaskEnvExternal({ ...DSH, entryUrl: ENTRY }, { gate: 'ok', deps: d })
    expect(r.state).toBe('idle')
    expect(r.started).toBe(false)
    expect(r.note).toBe('连不上源设备（设备隧道不可用），请稍后再试')
    expect(d.calls.copy).toEqual([])
    expect(d.calls.url).toEqual([])
    expect(d.calls.add).toEqual([])
  })

  it('普通 http env：系统浏览器打根路径前先起固定口（行为不变）', async () => {
    const d = deps()
    const r = await openTaskEnvExternal(DSH, { gate: 'ok', deps: d })
    expect(d.calls.url).toEqual(['http://127.0.0.1:23911/'])
    expect(d.calls.add).toHaveLength(1)
    expect(d.calls.add[0]).toMatchObject({ localPort: 23911, device: 'did:myco:zPC', port: 13911 })
    expect(r.state).toBe('ready')
  })

  it('无桥/浏览器拉不起来 → 已复制地址的降级提示（地址已交到用户手上）', async () => {
    const d = deps()
    d.openUrl = (url) => {
      d.calls.url.push(url)
      return false
    }
    const r = await openTaskEnvExternal(DSH, { gate: 'ok', deps: d })
    expect(d.calls.url).toEqual(['http://127.0.0.1:23911/'])
    expect(d.calls.copy).toEqual(['http://127.0.0.1:23911/'])
    expect(r.note).toContain('已复制地址，请在浏览器里打开')
    expect(r.started).toBe(true) // 地址在剪贴板 = 用户能自己打开
    expect(r.state).toBe('ready')
    expect(openNoteTone(r.note, r.state)).toBe('ok')
  })

  it('浏览器打开了但复制失败 → 不谎报「地址已复制」，也不降级成失败', async () => {
    const d = deps()
    d.copy = async () => false
    const r = await openTaskEnvExternal(DSH, { gate: 'ok', deps: d })
    expect(d.calls.url).toEqual(['http://127.0.0.1:23911/'])
    expect(r.state).toBe('ready')
    expect(r.started).toBe(true)
    expect(r.note).toContain('已在浏览器打开')
    expect(r.note).not.toContain('（地址已复制）')
  })

  it('无可用 URL → 明确报错，不复制、不打开（不给半截地址）', async () => {
    const d = deps()
    const r = await openTaskEnvExternal({ kind: 'bogus', device: 'did:myco:zPC' }, { gate: 'ok', deps: d })
    expect(r.state).toBe('idle')
    expect(r.started).toBe(false)
    expect(r.note).toContain('没有可用的入口地址')
    expect(d.calls.copy).toEqual([])
    expect(d.calls.url).toEqual([])
  })

  it('同一张卡：主路径与「浏览器」解析出的 URL 逐字相同（共用一份解析，不漂移）', async () => {
    const main = deps({ ensureEntryForward: async () => 25914 })
    const a = await openTaskEnv(
      { ...DSH, entryUrl: ENTRY, deviceAlias: 'office-pc', shareAlias: 'dsh' },
      { gate: 'ok', deps: main },
    )
    const ext = deps({ ensureEntryForward: async () => 25914 })
    const b = await openTaskEnvExternal(
      { ...DSH, entryUrl: ENTRY, deviceAlias: 'office-pc', shareAlias: 'dsh' },
      { gate: 'ok', deps: ext },
    )
    expect(a.state).toBe('ready')
    expect(b.state).toBe('ready')
    expect(main.calls.url).toHaveLength(1)
    // VNETP URL 确定（无毫秒时间戳/签名），两条路径必须逐字相同
    expect(ext.calls.url[0]).toBe(main.calls.url[0])
    expect(ext.calls.url[0]).toBe('http://office-pc.localhost:25914/dsh/')
    expect(ext.calls.copy).toHaveLength(1)
    expect(ext.calls.copy[0]).toBe(main.calls.url[0])
  })

  it('显示条件：只有 dsh/http 且有可用入口才给次要动作', () => {
    expect(canOpenEnvExternal(DSH)).toBe(true)
    expect(canOpenEnvExternal({ kind: 'http', device: 'did:myco:zPC' })).toBe(true)
    expect(canOpenEnvExternal(RDP)).toBe(false)
    expect(canOpenEnvExternal({ kind: 'ssh', device: 'did:myco:zPC' })).toBe(false)
    expect(canOpenEnvExternal({ kind: 'dsh' })).toBe(false) // 无 device 的破卡
    expect(canOpenEnvExternal({ kind: 'bogus', device: 'did:myco:zPC' })).toBe(false)
    expect(canOpenEnvExternal(null)).toBe(false)
  })
})

describe('失败态：不启动客户端、不谎报成功', () => {
  it('presence addrs-null（纯中继设备，ECS Linux 真案）→ 不拦死，继续建链', async () => {
    // 2026-11-01：NAT 后设备名册在、addrs 空、中继可达——旧语义判 offline 拦死打开。
    const d = deps({ presence: 'addrs-null | n=8 31dRy8:addrs=null' })
    const r = await openTaskEnv(RDP, { gate: 'ok', deps: d })
    expect(r.state).toBe('ready')
    expect(d.calls.add).toHaveLength(1)
  })

  it('presence 查不到（unknown）→ 继续建链（不把抖动当离线）', async () => {
    const d = deps({ presence: 'boom' })
    const r = await openTaskEnv(RDP, { gate: 'ok', deps: d })
    expect(r.state).toBe('ready')
    expect(d.calls.add).toHaveLength(1)
  })

  it('caps 未授予 → denied，连固定口都不起', async () => {
    const d = deps()
    const r = await openTaskEnv(RDP, { gate: 'denied', deps: d })
    expect(r.state).toBe('denied')
    expect(r.note).toContain('未授予')
    expect(d.calls.add).toEqual([])
    expect(d.calls.rdp).toEqual([])
  })

  it('缺目标设备 → denied（不打桥、不复制）', async () => {
    const d = deps()
    const r = await openTaskEnv({ kind: 'rdp', localPort: 23389 }, { gate: 'ok', deps: d })
    expect(r.state).toBe('denied')
    expect(r.note).toContain('目标设备')
    expect(d.calls.add).toEqual([])
  })

  it('旧 APK 没有 vnet 桥 → idle + 人话（不假装成功；不带技术词）', async () => {
    const d = deps()
    d.vnet = null
    const r = await openTaskEnv(RDP, { gate: 'ok', deps: d })
    expect(r.state).toBe('idle')
    expect(r.note).toContain('版本过旧')
    expect(d.calls.rdp).toEqual([])
  })

  it('固定口起不来（被占）→ idle + 如实报错（不报端口号），不起客户端', async () => {
    const d = deps({ addOk: false })
    const r = await openTaskEnv(RDP, { gate: 'ok', deps: d })
    expect(r.state).toBe('idle')
    expect(r.note).toContain('建立失败')
    expect(r.note).not.toContain('23389')
    expect(d.calls.rdp).toEqual([])
    expect(d.calls.copy).toEqual([])
    expect(d.calls.add).toHaveLength(1)
  })
})

describe('接线（源码合同）：手机任务列表行 env 优先于分享入口', () => {
  it('openShare 分支顺序：adb → dsh → env（RDP 先拉本机隧道）→ 分享卡兜底', () => {
    const src = readFileSync(new URL('./components/FriendsPanel.tsx', import.meta.url), 'utf8')
    const body = fnBodyOf(src, 'openShare')
    // 列表行要能看见 env（卡面 env 缺失时老卡照旧走分享入口）
    expect(src).toContain('declaredEnvsOfCard(')
    // 2026-11-11 两条前置特例路由（必须出现在通用 env 直开之前）：
    // ① 本机 adb 卡 → 手机当 vnet server（adbServerStart），不是 env 直开；
    // ② DSH 卡带分享坐标 → openTaskShare（VNETP 直入；2026-11-12 起唯一路径）。
    const adbAt = body.indexOf("env.kind === 'adb'")
    const dshAt = body.indexOf("env.kind === 'dsh'")
    const envAt = body.indexOf('openTaskEnv(')
    expect(adbAt).toBeGreaterThan(-1)
    expect(dshAt).toBeGreaterThan(-1)
    expect(envAt).toBeGreaterThan(-1)
    expect(adbAt).toBeLessThan(dshAt)
    expect(dshAt).toBeLessThan(envAt)
    // 通用 env 直开之前：RDP 先把设备隧道拉起来并回写本机口
    // （卡片里写死的 localPort 是 PC 侧口，手机上没人监听 → 直接 openTaskEnv 必连不上）
    // 2026-11-12：调用变成 ensureRdpForwardFor(env.device, env.localPort)——第二参把卡上
    // 的固定口传下去（RDP 地址恒 127.0.0.1:23389）。断言只锚到参数表开头，不锚收括号。
    const rdpPrepAt = body.indexOf('ensureRdpForwardFor(env.device')
    expect(rdpPrepAt).toBeGreaterThan(-1)
    expect(rdpPrepAt).toBeLessThan(envAt)
    // 通用 env 直开之后才是无 env 老卡的分享入口兜底
    expect(body.indexOf('openTaskShare(', envAt)).toBeGreaterThan(envAt)
  })
})

describe('接线（源码合同）：DSH 列表行不露「↗ 浏览器」（2026-11-01 设计定稿移除）', () => {
  it('系统浏览器入口不得回归；RDP 主路径＝先 ensureRdpForwardFor 再 openTaskEnv（应用内壳）', () => {
    const src = readFileSync(new URL('./components/FriendsPanel.tsx', import.meta.url), 'utf8')
    // 2026-10-31 曾加「↗ 浏览器」次要动作；当晚设计定稿移除（系统浏览器独立存储分区，
    // 空态不可控）。源码合同改为：入口不得回归。
    expect(src).not.toContain('↗ 浏览器')
    expect(src).not.toContain('openTaskEnvExternal(')
    expect(src).not.toContain('canOpenEnvExternal(')
    // 主路径仍走应用内壳 openTaskEnv；RDP 的前置是「先有本机隧道口」——
    // 2026-11-11 改写成 `const prep = ensureRdpForwardFor(...); void prep.then(() => openTaskEnv(env, ...))`，
    // 断言顺序而不是某一句字面量，否则一句重构就假警。
    // 2026-11-12：第二参 env.localPort（固定口）加入——同上只锚参数表开头。
    const body = fnBodyOf(src, 'openShare')
    const prepAt = body.indexOf('ensureRdpForwardFor(env.device')
    const envAt = body.indexOf('openTaskEnv(env,')
    expect(prepAt).toBeGreaterThan(-1)
    expect(envAt).toBeGreaterThan(prepAt)
    // prep 只对 RDP 生效（别让 adb/dsh 也白等隧道）
    expect(body).toContain("env.kind === 'rdp' && env.device")
  })
})

describe('openNoteTone：成功提示不得渲染成错误红（2026-10-23 用户反馈；2026-10-25 文案不带地址）', () => {
  it('成功类（已复制/已打开/远程桌面已拉起/ready）→ ok（绿）', () => {
    expect(openNoteTone('已复制连接地址，请在你的远程桌面 App 里粘贴连接')).toBe('ok')
    expect(openNoteTone('已在系统浏览器打开')).toBe('ok')
    expect(openNoteTone('已在应用内浏览器打开')).toBe('ok')
    expect(openNoteTone('已在浏览器打开（地址已复制）')).toBe('ok') // 「↗ 浏览器」
    expect(openNoteTone('已复制地址，请在浏览器里打开')).toBe('ok') // 「↗ 浏览器」降级
    expect(openNoteTone('正在用远程桌面打开')).toBe('ok')
    expect(openNoteTone('任意文案', 'ready')).toBe('ok')
  })

  it('进行中（正在…/building）→ building（蓝）', () => {
    expect(openNoteTone('正在连接…')).toBe('building')
    expect(openNoteTone('正在按环境连接…')).toBe('building')
    expect(openNoteTone('任意文案', 'building')).toBe('building')
  })

  it('失败/离线/拒绝 → warn（红只留给真错误）', () => {
    expect(openNoteTone('连接通道建立失败：被占用')).toBe('warn')
    expect(openNoteTone('设备离线，稍后再试')).toBe('warn')
    expect(openNoteTone('任意文案', 'offline')).toBe('warn')
    expect(openNoteTone('任意文案', 'denied')).toBe('warn')
  })

  it('接线（源码合同）：列表行 note 按 openNoteTone 上色（不再"非蓝即红"）', () => {
    const src = readFileSync(new URL('./components/FriendsPanel.tsx', import.meta.url), 'utf8')
    expect(src).toContain('openNoteTone(')
    // 旧写法（openNote 非"正在打开…"一律红）必须绝迹
    expect(src).not.toContain("openNote.text === '正在打开…' ? '#7ea8d4' : '#e5534b'")
  })
})

describe('真机壳桥：openInBrowser 必须带 receiver（2026-10-23 用户报「DSH 卡只复制地址」）', () => {
  /** 复刻 Android addJavascriptInterface 语义：解绑方法再调 → 抛 non-injected。 */
  function installBridge() {
    const calls: string[] = []
    const shell = {
      openInBrowser(this: unknown, url: string) {
        if (this !== shell) {
          throw new Error("Java bridge method can't be invoked on a non-injected object")
        }
        calls.push(url)
        return 'OK'
      },
    }
    const g = globalThis as unknown as { window?: unknown }
    const prev = g.window
    g.window = { MycoShell: shell }
    return { calls, restore: () => { g.window = prev } }
  }

  it('DSH 默认依赖 → 真的调起 openInBrowser（不是复制地址降级）', async () => {
    const { calls, restore } = installBridge()
    try {
      // 只给 vnet/copy/rdp 依赖，**不传 openUrl** → 走真实 openUrlViaShell
      const r = await openTaskEnv(DSH, {
        gate: 'ok',
        deps: {
          vnet: { add: () => ({ ok: true }) },
          copy: async () => true,
          hasRdp: () => false,
          openRdp: () => true,
        },
      })
      expect(calls).toEqual(['http://127.0.0.1:23911/'])
      expect(r.state).toBe('ready')
      expect(r.note).toContain('已在系统浏览器打开')
      expect(r.note).not.toContain('当前外壳没有浏览器桥')
    } finally {
      restore()
    }
  })

  it('接线（源码合同）：task-env.ts 不得解绑 openInBrowser 后再调', () => {
    const src = readFileSync(new URL('./task-env.ts', import.meta.url), 'utf8')
    expect(src).toContain('shell.openInBrowser(url)')
    // 旧写法：const fn = w.MycoShell?.openInBrowser; fn(url)（解绑 → 真机必抛 → 落复制降级）
    expect(src).not.toMatch(/const fn = w\.MycoShell\?\.openInBrowser/)
    expect(src).not.toMatch(/^\s*fn\(url\)/m)
  })
})
