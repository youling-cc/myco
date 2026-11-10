/**
 * task-open.test.ts — **任务卡「打开」路由**的回归锚（2026-10-23 真机 bug）。
 *
 * 现场：任务列表行点开带 env 的卡 → 浏览器落到 `/gw/<id>/app/` →
 * `no valid share cookie (open the share entry first)`。根因是列表行只认 `open-url`。
 *
 * 这里锁死四条不变量（比 UI 快照更接近用户可见行为）：
 *   ① 有 env → 只调 `vnet_env_open`，**绝不**调 `open_external`；
 *   ② 无 env 的老卡 → 仍只调 `open_external`（向后兼容）；
 *   ③ env-open 返回 offline / no-service / denied → **不补开浏览器**（不把失败伪装成功）；
 *   ④ 存量卡（有 env[] 但动作还是 open-url）也走 env —— 否则已同步到笔记本的卡修不好。
 */
import { describe, expect, it } from 'vitest'
import friendsZoneSource from './FriendsZone.tsx?raw'
import {
  actionLabelOf,
  declaredEnvsOfCard,
  envOpenLabel,
  primaryEnvOf,
  runTaskOpen,
  safeActionUrl,
  type TaskOpenDeps,
} from './task-open'
import type { TaskEnv } from './task-env'

/** 记录"到底调了哪条路"的假依赖。 */
function deps(res?: unknown): TaskOpenDeps & { calls: { kind: string; cmd?: string; args?: Record<string, unknown>; url?: string }[] } {
  const calls: { kind: string; cmd?: string; args?: Record<string, unknown>; url?: string }[] = []
  return {
    calls,
    invoke: async (cmd, args) => {
      calls.push({ kind: 'invoke', cmd, args })
      return res
    },
    openExternalUrl: async (url) => {
      calls.push({ kind: 'external', url })
    },
  }
}

const ENV_CARD = {
  taskId: 'peer-task-share-sh-pc-env-rdp',
  shareId: 'sh-pc-env-rdp',
  title: 'PC 远程桌面',
  env: [{ kind: 'rdp', device: 'did:myco:zPC', port: 3389, localPort: 23389 }],
  caps: ['vnet.forward'],
}

const ENV_ACTION = {
  kind: 'open-env',
  label: '打开远程桌面',
  env: ENV_CARD.env,
  shareId: 'sh-pc-env-rdp',
  target: 'window',
}

describe('列表行：有 env 的卡 → vnet_env_open（不再走分享入口）', () => {
  it('open-env 动作 → 只调 vnet_env_open，参数带卡身份 + env', async () => {
    const d = deps({ ok: true, state: 'ready', kind: 'rdp', address: '127.0.0.1:23389', clientStarted: true, client: 'mstsc' })
    const out = await runTaskOpen(ENV_CARD, ENV_ACTION, d)

    expect(out.via).toBe('env')
    expect(out.ok).toBe(true)
    expect(out.state).toBe('ready')
    // 2026-10-25 文案精简：提示行不再带地址/端口（用户反馈技术细节没用）
    expect(out.note).not.toContain('127.0.0.1')
    expect(out.note).toContain('已启动远程桌面')
    expect(out.label).toBe('打开远程桌面')

    expect(d.calls.map((c) => c.kind)).toEqual(['invoke'])
    expect(d.calls[0].cmd).toBe('vnet_env_open')
    expect(d.calls[0].args).toEqual({
      args: {
        env: { kind: 'rdp', device: 'did:myco:zPC', port: 3389, localPort: 23389 },
        cardId: 'sh-pc-env-rdp',
        taskId: 'peer-task-share-sh-pc-env-rdp',
        caps: ['vnet.forward'],
      },
    })
  })

  it('存量卡：有 env[] 但动作还是 open-url（已同步到本机）→ 仍按 env 打开', async () => {
    const d = deps({ ok: true, state: 'ready', kind: 'rdp', address: '127.0.0.1:23389' })
    const oldAction = { kind: 'open-url', url: 'http://127.0.0.1:3102/api/dshShare/remoteOpen?shareId=sh-pc-env-rdp', label: '打开' }

    const out = await runTaskOpen(ENV_CARD, oldAction, d)

    expect(out.via).toBe('env')
    expect(d.calls.map((c) => c.kind)).toEqual(['invoke'])
    expect(d.calls[0].cmd).toBe('vnet_env_open')
    // 关键：分享入口的 URL 一次都不能被打开（那就是 no valid share cookie 的来源）
    expect(d.calls.some((c) => c.kind === 'external')).toBe(false)
  })

  it('动作里带 env、卡面没 env（跨设备裁剪）→ 也能按 env 打开', async () => {
    const d = deps({ ok: true, state: 'ready', kind: 'dsh', address: '127.0.0.1:23911' })
    const card = { taskId: 't-2', shareId: 'sh-2', caps: ['vnet.forward'] }
    const action = {
      kind: 'open-env',
      label: '打开DSH web',
      shareId: 'sh-2',
      env: [{ kind: 'dsh', device: 'did:myco:zPC', port: 13911, localPort: 23911 }],
    }
    const out = await runTaskOpen(card, action, d)
    expect(out.via).toBe('env')
    expect(d.calls[0].cmd).toBe('vnet_env_open')
  })

  it('多 env 卡：主入口按 rdp → dsh → 声明顺序，标签跟主入口', () => {
    const envs: TaskEnv[] = [
      { kind: 'ssh', device: 'd', port: 22, localPort: 2223 },
      { kind: 'dsh', device: 'd', port: 13911, localPort: 23911 },
      { kind: 'rdp', device: 'd', port: 3389, localPort: 23389 },
    ]
    expect(primaryEnvOf(envs)?.kind).toBe('rdp')
    expect(primaryEnvOf([envs[1], envs[0]])?.kind).toBe('dsh')
    expect(primaryEnvOf([envs[0]])?.kind).toBe('ssh')
    expect(envOpenLabel({ kind: 'rdp' })).toBe('打开远程桌面')
    expect(envOpenLabel({ kind: 'dsh' })).toBe('打开 DSH Web')
    expect(actionLabelOf({ kind: 'open-env' }, envs)).toBe('打开远程桌面')
    expect(actionLabelOf({ kind: 'open-env', label: '打开' }, envs)).toBe('打开')
  })
})

describe('列表行：无 env 的老卡保持 open-url（向后兼容）', () => {
  it('open-url 动作 → 只调 open_external', async () => {
    const d = deps()
    const url = 'http://127.0.0.1:3102/api/dshShare/open?shareId=sh-old'
    const out = await runTaskOpen({ taskId: 't-old', shareId: 'sh-old' }, { kind: 'open-url', url, label: '打开' }, d)
    expect(out.via).toBe('url')
    expect(out.ok).toBe(true)
    expect(d.calls).toEqual([{ kind: 'external', url }])
  })

  it('老卡只有 sourceDevice（没有 env）→ 不派生 env（行为不变，不偷偷改成 RDP）', async () => {
    const d = deps()
    const card = { taskId: 't-legacy', sourceDevice: 'did:myco:zOld', fromDevice: 'did:myco:zOld' }
    expect(declaredEnvsOfCard(card, undefined)).toEqual([])
    expect(declaredEnvsOfCard(card, { kind: 'open-url', url: 'http://x/y' })).toEqual([])
    const out = await runTaskOpen(card, { kind: 'open-url', url: 'http://x/y' }, d)
    expect(out.via).toBe('url')
    expect(d.calls.map((c) => c.kind)).toEqual(['external'])
  })

  it('scheme 白名单：javascript: / file: 一律不打开（未知 kind 也不猜）', async () => {
    const d = deps()
    expect(safeActionUrl('javascript:alert(1)')).toBeNull()
    expect(safeActionUrl('file:///C:/Windows/System32/calc.exe')).toBeNull()
    const out1 = await runTaskOpen({ taskId: 't' }, { kind: 'open-url', url: 'javascript:alert(1)' }, d)
    expect(out1.via).toBe('none')
    const out2 = await runTaskOpen({ taskId: 't' }, { kind: 'weird' }, d)
    expect(out2.via).toBe('none')
    expect(d.calls).toEqual([])
  })
})

describe('env-open 失败态：不误开浏览器、不谎报成功', () => {
  for (const [state, msg, word] of [
    ['offline', '目标设备不在线（没有可用的直连地址）', '不在线'],
    ['no-service', '目标未提供远程桌面服务', '远程桌面'],
    ['denied', '此卡未授予该能力（caps 里没有 vnet.forward）', '未授予'],
    // 本机侧失败（固定口被占）也必须如实显示，且绝不开浏览器顶替
    ['error', '本机固定口 23389 被占用（换一个 localPort 或先关掉占用进程）', '占用'],
  ] as const) {
    it(`${state} → 状态=${state}，open_external 零调用`, async () => {
      const d = deps({ ok: false, state, kind: 'rdp', message: msg })
      const out = await runTaskOpen(ENV_CARD, ENV_ACTION, d)
      expect(out.via).toBe('env')
      expect(out.ok).toBe(false)
      expect(out.state).toBe(state)
      expect(out.note).toContain(word)
      expect(d.calls.map((c) => c.kind)).toEqual(['invoke'])
      expect(d.calls.some((c) => c.kind === 'external')).toBe(false)
    })
  }

  it('caps 预检不通过 → 连 IPC 都不打（立刻给红字）', async () => {
    const d = deps()
    const card = { ...ENV_CARD, caps: ['session.read'] }
    const out = await runTaskOpen(card, ENV_ACTION, d)
    expect(out.state).toBe('denied')
    expect(out.note).toContain('未授予')
    expect(d.calls).toEqual([])
  })

  it('缺目标设备 → denied 人话（不打后端、不开浏览器）', async () => {
    const d = deps()
    const card = { taskId: 't', shareId: 'sh', env: [{ kind: 'rdp', port: 3389, localPort: 23389 }], caps: ['vnet.forward'] }
    const out = await runTaskOpen(card, { kind: 'open-env' }, d)
    expect(out.state).toBe('denied')
    expect(out.note).toContain('目标设备')
    expect(d.calls).toEqual([])
  })

  it('IPC 抛错（旧 exe 没这条命令）→ 不当成功，也不补开浏览器', async () => {
    const d = deps()
    d.invoke = async () => {
      d.calls.push({ kind: 'invoke' })
      throw new Error('command vnet_env_open not found')
    }
    const out = await runTaskOpen(ENV_CARD, ENV_ACTION, d)
    expect(out.ok).toBe(false)
    expect(out.state).toBe('idle')
    expect(out.note).toContain('调用失败')
    expect(d.calls.map((c) => c.kind)).toEqual(['invoke'])
  })
})

describe('接线（源码合同）：任务列表行必须走这条路由', () => {
  const src = friendsZoneSource

  it('左键/右键「打开」都走 runTaskOpen，且列表行先看 declaredEnvsOfCard', () => {
    expect(src).toContain('runTaskOpen(')
    expect(src).toContain('declaredEnvsOfCard(')
    // 老实现（列表行只认 openUrl → openExternalUrl）不得复活：
    // 那正是 "带 env 的卡落进 /gw/<id>/app/ 报 no valid share cookie" 的入口。
    expect(src).not.toContain('await openExternalUrl(openUrl)')
  })
})
