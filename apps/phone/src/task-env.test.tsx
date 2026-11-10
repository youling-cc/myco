/**
 * task-env.test.tsx — 手机端「任务卡 env」回归锚点（2026-10-23）。
 *
 * 与 PC `apps/home/ui/src/task-env.test.tsx` 对齐的三层：
 *   ① 纯逻辑（卡→行 / 固定口 / caps 闸 / presence 诊断串 / 五状态文案）；
 *   ② 壳桥降级（没有 `MycoShell.openInBrowser` / 没有 `__mycoVnet` 时如实返回 false）；
 *   ③ SSR 渲染（react-dom/server，本仓既定做法）：卡上每个 env 一行 + 打开/复制。
 *
 * 手机不自己探测协议（权威在 PC 的 `vnet_env.rs`），所以这里不测"no-service"的探测；
 * 只钉住"不谎报"：行状态初始 idle、自己发的卡不渲染、壳不在时给降级文案。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskEnvList } from './components/TaskEnvList'
import {
  addressOf,
  browserUrlOf,
  capsGate,
  dotColor,
  entryUrlOf,
  envsOfCard,
  KIND_DEFAULT_LOCAL,
  localPortOf,
  openUrlViaShell,
  presenceDiagState,
  stateText,
  targetPortOf,
  vnetBridge,
  type TaskEnv,
} from './task-env'

function ssr(card: Record<string, unknown> | null | undefined, enabled = true): string {
  return renderToStaticMarkup(createElement(TaskEnvList, { card, enabled }))
}

function setWindow(v: unknown): void {
  ;(globalThis as unknown as { window?: unknown }).window = v
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('envsOfCard / 固定口（与 PC 同词表）', () => {
  it('env[] 逐项映射 + 白名单过滤（2026-11-01：vnc 已转正，非法例换 telnet）', () => {
    const envs = envsOfCard({
      env: [
        { kind: 'rdp', device: 'did:myco:zPC', port: 3389, localPort: 23389 },
        { kind: 'dsh', device: 'did:myco:zPC' },
        { kind: 'vnc', device: 'did:myco:zPC' },
        { kind: 'telnet', device: 'did:myco:zPC' },
      ],
    })
    expect(envs.map((e) => e.kind)).toEqual(['rdp', 'dsh', 'vnc'])
    expect(localPortOf({ kind: 'vnc' })).toBe(23590)
    expect(targetPortOf({ kind: 'vnc' })).toBe(5900)
    expect(localPortOf({ kind: 'rustdesk' })).toBe(23591)
    expect(targetPortOf({ kind: 'rustdesk' })).toBe(21118)
  })

  it('老卡只有 sourceDevice → 派生 rdp（固定口 23389）', () => {
    expect(envsOfCard({ sourceDevice: 'did:myco:zOld' })).toEqual([
      { kind: 'rdp', device: 'did:myco:zOld', port: 3389, localPort: 23389 },
    ])
    expect(ssr({})).toBe('')
  })

  it('默认口表 = 设计 §4', () => {
    expect(KIND_DEFAULT_LOCAL).toMatchObject({ rdp: 23389, dsh: 23911, ssh: 2223, stereo: 29000, adb: 25037 })
    expect(localPortOf({ kind: 'dsh' })).toBe(23911)
    expect(targetPortOf({ kind: 'dsh' })).toBe(13911)
    expect(addressOf({ kind: 'ssh' })).toBe('127.0.0.1:2223')
    expect(browserUrlOf({ kind: 'dsh' })).toBe('http://127.0.0.1:23911/')
  })

  it('entryUrl 随卡映射（2026-10-23：DSH 根路径 401 的现场修复）', () => {
    const entry = 'http://127.0.0.1:23911/gw/sh-pc-env-dsh/?mt=abc'
    const envs = envsOfCard({
      env: [{ kind: 'dsh', device: 'did:myco:zPC', port: 13911, localPort: 23911, entryUrl: entry }],
    })
    expect(envs[0].entryUrl).toBe(entry)
    // 老卡没该字段 → undefined（不凭空造入口）
    expect(envsOfCard({ env: [{ kind: 'dsh', device: 'did:myco:zPC' }] })[0].entryUrl).toBeUndefined()
  })
})

describe('entryUrlOf：只认 http://127.0.0.1:<localPort>/…（卡可跨设备投递）', () => {
  const DSH: TaskEnv = { kind: 'dsh', device: 'did:myco:zPC', port: 13911, localPort: 23911 }

  it('合法入口原样返回（带 mt 的分享入口）', () => {
    const entry = 'http://127.0.0.1:23911/gw/sh-x/?mt=abc'
    expect(entryUrlOf({ ...DSH, entryUrl: entry })).toBe(entry)
    // 无 entryUrl → 空串（调用方回落根路径）
    expect(entryUrlOf(DSH)).toBe('')
  })

  it('scheme/host/端口/userinfo 任一不符 → 拒绝（返回空串）', () => {
    for (const bad of [
      'https://127.0.0.1:23911/gw/sh-x/?mt=abc',
      'http://localhost:23911/gw/sh-x/?mt=abc',
      'http://127.0.0.1:23912/gw/sh-x/?mt=abc',
      'http://127.0.0.1:23911@evil.example/gw/sh-x/',
      'http://10.0.0.1:23911/gw/sh-x/',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(entryUrlOf({ ...DSH, entryUrl: bad })).toBe('')
    }
  })
})

describe('caps 闸 / 状态文案', () => {
  it('caps：ok / denied / unknown', () => {
    expect(capsGate(['vnet.forward'])).toBe('ok')
    expect(capsGate([])).toBe('denied')
    expect(capsGate(undefined)).toBe('unknown')
  })
  it('五状态文案与色点', () => {
    expect(stateText('offline', 'rdp')).toContain('设备离线')
    expect(stateText('no-service', 'dsh')).toContain('DSH web')
    expect(stateText('denied', 'rdp')).toContain('未授予')
    expect(dotColor('ready')).toBe('#22c55e')
    expect(dotColor('offline')).toBe('#9aa3b8')
  })
})

describe('presence 诊断串（手机不把"查不到"当离线）', () => {
  it('addrs-ok → online', () => {
    expect(presenceDiagState('addrs-ok | n=18 ipv6=…')).toBe('online')
  })
  it('addrs-null → unknown（2026-11-01：纯中继设备不得判离线——ECS Linux 靶机真案）', () => {
    // NAT 后设备（docker/Linux/Mac）名册在、addrs 空、中继腿可达：
    // 判 offline 会拦死打开；真离线由隧道赛跑如实报。
    expect(presenceDiagState('addrs-null | n=8 31dRy8:addrs=null')).toBe('unknown')
    expect(presenceDiagState('addrs-null | n=0 entry=缺席')).toBe('unknown')
  })
  it('空/异常 → unknown（不误报离线）', () => {
    expect(presenceDiagState('')).toBe('unknown')
    expect(presenceDiagState(null)).toBe('unknown')
    expect(presenceDiagState('boom')).toBe('unknown')
  })
})

describe('壳桥降级（旧 APK 不能崩也不能假成功）', () => {
  it('没有 window → openUrlViaShell=false、vnetBridge=null', () => {
    expect(openUrlViaShell('http://127.0.0.1:23911/')).toBe(false)
    expect(vnetBridge()).toBeNull()
  })
  it('有 MycoShell.openInBrowser → true；有 __mycoVnet → 可取到 add', () => {
    setWindow({ MycoShell: { openInBrowser: () => 'ok' }, __mycoVnet: { add: () => ({ ok: true }) } })
    expect(openUrlViaShell('http://127.0.0.1:23911/')).toBe(true)
    expect(typeof vnetBridge()?.add).toBe('function')
  })
})

describe('SSR：卡上 env 逐行渲染（手机；2026-10-25 起无地址行/复制钮）', () => {
  const CARD = {
    cardId: 'sh-v20',
    caps: ['vnet.forward'],
    sourceDevice: 'did:myco:zPC',
    env: [
      { kind: 'rdp', device: 'did:myco:zPC', port: 3389, localPort: 23389 },
      { kind: 'dsh', device: 'did:myco:zPC', port: 13911, localPort: 23911 },
      { kind: 'ssh', device: 'did:myco:zPC', port: 22, localPort: 2223 },
    ],
  }

  it('三个 env → 三行，状态与打开按钮齐全，初始 idle；无地址/端口/复制钮', () => {
    const html = ssr(CARD)
    expect(html.match(/data-myco-env="1"/g)).toHaveLength(3)
    for (const k of ['rdp', 'dsh', 'ssh']) expect(html).toContain(`data-env-kind="${k}"`)
    // 2026-10-25 用户反馈：IP/端口/设备号不上卡面（打开链路照旧，只是不再展示）
    expect(html).not.toContain('127.0.0.1')
    expect(html).not.toContain('23389')
    expect(html).not.toContain('23911')
    expect(html).not.toContain('2223')
    expect(html).not.toContain('did:myco')
    expect(html.match(/data-env-state="idle"/g)).toHaveLength(3)
    expect(html.match(/data-env-open="1"/g)).toHaveLength(3)
    expect(html).not.toContain('data-env-copy')
    expect(html).not.toContain('undefined')
  })

  it('自己发的卡不渲染入口', () => {
    expect(ssr(CARD, false)).toBe('')
  })
})
