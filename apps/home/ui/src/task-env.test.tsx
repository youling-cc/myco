/**
 * task-env.test.tsx — PC「任务卡 env」回归锚点（2026-10-23 · R24/R26/R27/R28 的 UI 面）。
 *
 * 三层断言：
 *   ① 纯逻辑：卡数据 → env 行（含老卡 sourceDevice 兼容）、固定口表、caps 闸、五状态文案；
 *   ② 渲染（react-dom/server SSR，本仓无 jsdom/@testing-library 的既定做法）：
 *      卡上 env[] 每项渲染一行 `data-env-kind` + 状态 + 打开按钮；
 *      2026-10-25 起卡面**不再有**地址行/复制按钮/端口/IP（用户反馈技术细节没用）；
 *   ③ 入口收敛的**行为学**断言不在这里（源码扫描在 `eval/vnet/v20-card-env.py`），
 *      但组件合同里钉死：`enabled=false`（自己发的卡）不渲染任何入口。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskEnvList } from './TaskEnvList'
import {
  addressOf,
  capsGate,
  cleanCardTitle,
  cleanTechText,
  dotColor,
  envsOfCard,
  KIND_DEFAULT_LOCAL,
  localPortOf,
  openArgs,
  resultNote,
  rowStateOf,
  stateText,
  targetPortOf,
  type TaskEnv,
} from './task-env'

function ssr(card: Record<string, unknown> | null | undefined, enabled = true): string {
  return renderToStaticMarkup(createElement(TaskEnvList, { card, enabled }))
}

describe('envsOfCard：入口来自卡（不来自设备名册）', () => {
  it('卡上 env[] → 逐项映射（kind/device/port/localPort/label）', () => {
    const envs = envsOfCard({
      env: [
        { kind: 'rdp', device: 'did:myco:zPC', port: 3389, localPort: 23389, label: '我的 PC 桌面' },
        { kind: 'dsh', device: 'did:myco:zPC', port: 13911 },
      ],
    })
    expect(envs).toHaveLength(2)
    expect(envs[0]).toMatchObject({ kind: 'rdp', device: 'did:myco:zPC', localPort: 23389, label: '我的 PC 桌面' })
    expect(envs[1]).toMatchObject({ kind: 'dsh', device: 'did:myco:zPC' })
  })

  it('白名单外的 kind 丢弃（2026-11-01：vnc 已转正，非法例换 telnet）', () => {
    expect(envsOfCard({ env: [{ kind: 'telnet', device: 'did:myco:zPC' }] })).toEqual([])
    expect(envsOfCard({ env: [{ kind: 'vnc', device: 'did:myco:zPC' }] })).toHaveLength(1)
    expect(envsOfCard({ env: [{ kind: 'rustdesk', device: 'did:myco:zPC' }] })).toHaveLength(1)
  })

  it('老分享卡（无 env，只有 sourceDevice）→ 派生一条 rdp env（仍是卡上入口）', () => {
    const envs = envsOfCard({ sourceDevice: 'did:myco:zOld' })
    expect(envs).toEqual([{ kind: 'rdp', device: 'did:myco:zOld', port: 3389, localPort: 23389 }])
  })

  it('什么都没有 → 空（不渲染任何入口）', () => {
    expect(envsOfCard({})).toEqual([])
    expect(envsOfCard(null)).toEqual([])
    expect(ssr({})).toBe('')
  })
})

describe('固定口/目标口/地址（设计 §4）', () => {
  it('缺省按 kind 默认表', () => {
    expect(localPortOf({ kind: 'rdp' })).toBe(23389)
    expect(localPortOf({ kind: 'dsh' })).toBe(23911)
    expect(localPortOf({ kind: 'ssh' })).toBe(2223)
    expect(localPortOf({ kind: 'stereo' })).toBe(29000)
    expect(localPortOf({ kind: 'adb' })).toBe(25037)
    expect(targetPortOf({ kind: 'rdp' })).toBe(3389)
    expect(addressOf({ kind: 'rdp' })).toBe('127.0.0.1:23389')
  })
  it('卡上显式 localPort 优先（一卡多实例）', () => {
    const env: TaskEnv = { kind: 'rdp', localPort: 24389 }
    expect(localPortOf(env)).toBe(24389)
    expect(addressOf(env)).toBe('127.0.0.1:24389')
  })
  it('默认口表与设计表逐值一致', () => {
    expect(KIND_DEFAULT_LOCAL).toMatchObject({ rdp: 23389, dsh: 23911, ssh: 2223, stereo: 29000, adb: 25037 })
  })
})

describe('caps 闸（R27 denied 的客户端预检）', () => {
  it('含 vnet.forward → ok', () => {
    expect(capsGate(['vnet.forward'])).toBe('ok')
    expect(capsGate('vnet.forward,session.read')).toBe('ok')
  })
  it('空数组/不含 → denied（V20.5）', () => {
    expect(capsGate([])).toBe('denied')
    expect(capsGate(['session.read'])).toBe('denied')
  })
  it('没声明 caps → unknown（由后端判，不在 UI 假拒）', () => {
    expect(capsGate(undefined)).toBe('unknown')
  })
})

describe('五状态文案与色点（设计 §5）', () => {
  it('offline/no-service/denied 都给人话 + 对应颜色', () => {
    expect(stateText('offline', 'rdp')).toContain('设备离线')
    expect(stateText('no-service', 'rdp')).toContain('目标未提供远程桌面服务')
    expect(stateText('denied', 'dsh')).toContain('未授予')
    expect(stateText('ready', 'ssh')).toBe('已就绪')
    expect(dotColor('ready')).toBe('#22c55e')
    expect(dotColor('no-service')).toBe('#f59e0b')
    expect(dotColor('denied')).toBe('#ef4444')
    expect(dotColor('offline')).toBe('#9aa3b8')
  })
  it('后端 state → 行状态：未知不假绿', () => {
    expect(rowStateOf({ state: 'ready', ok: true })).toBe('ready')
    expect(rowStateOf({ state: 'no-service', ok: false })).toBe('no-service')
    expect(rowStateOf({ state: 'weird', ok: false })).toBe('idle')
    expect(rowStateOf(null)).toBe('idle')
  })
  it('链路就绪但客户端没起来 → error（自连提示不算失败）', () => {
    // 2026-11-14：RootFallback 曾把 state=ready 亮成绿点，同时提示行说"入口不可用"——自相矛盾。
    expect(rowStateOf({ state: 'ready', ok: true, clientStarted: false, error: '坐标不全' })).toBe('error')
    expect(rowStateOf({ state: 'ready', ok: true, selfTarget: true, error: '自连提示' })).toBe('ready')
  })
})

describe('openArgs：卡身份随行（审计可答"谁用哪张卡用了什么"）', () => {
  it('cardId/taskId/caps/signature + env 规格', () => {
    const args = openArgs(
      { cardId: 'sh-1', taskId: 'tk-9', caps: ['vnet.forward'], signature: 'x'.repeat(40) },
      { kind: 'rdp', device: 'did:myco:zPC' },
    )
    expect(args).toMatchObject({
      cardId: 'sh-1',
      taskId: 'tk-9',
      caps: ['vnet.forward'],
      env: { kind: 'rdp', device: 'did:myco:zPC', port: 3389, localPort: 23389 },
    })
    expect(args.signature).toBe('x'.repeat(40))
  })
  it('无 caps 的调试卡不带 caps（后端按 denied）', () => {
    const args = openArgs({}, { kind: 'dsh', device: 'did:myco:zPC' })
    expect(args.caps).toBeUndefined()
    expect((args.env as Record<string, unknown>).localPort).toBe(23911)
  })

  // 2026-10-23 现场修复：DSH 根路径无 cookie 必 401；卡上的 entryUrl（带 mt 的
  // `/gw/<id>/`）必须在 UI 层原样带到执行器——丢字段=点击回到根路径=空列表。
  it('entryUrl 原样带进 vnet_env_open 的 env（老卡没有该键）', () => {
    const entry = 'http://127.0.0.1:23911/gw/sh-pc-env-dsh/?mt=abc'
    const card = {
      cardId: 'sh-pc-env-dsh',
      caps: ['vnet.forward'],
      env: [{ kind: 'dsh', device: 'did:myco:zPC', port: 13911, localPort: 23911, entryUrl: entry }],
    }
    const envs = envsOfCard(card)
    expect(envs[0].entryUrl).toBe(entry)
    const args = openArgs(card, envs[0])
    expect((args.env as Record<string, unknown>).entryUrl).toBe(entry)
    // 老卡（无 entryUrl）不多出该键（形状零变化）
    const old = envsOfCard({ env: [{ kind: 'dsh', device: 'did:myco:zPC' }] })
    expect((openArgs({}, old[0]).env as Record<string, unknown>).entryUrl).toBeUndefined()
  })
})

describe('resultNote：提示行说人话，不再带地址/端口/URL（2026-10-25 用户反馈）', () => {
  it('ready + mstsc', () => {
    const note = resultNote({ ok: true, state: 'ready', address: '127.0.0.1:23389', clientStarted: true, client: 'mstsc' })
    expect(note).toContain('已启动远程桌面')
    expect(note).not.toContain('127.0.0.1')
  })
  it('浏览器成功：状态行与 hint 同义时不重复（2026-11-14 真案）', () => {
    const note = resultNote({
      ok: true,
      state: 'ready',
      tunnel: 'device-origin',
      localPort: 24011,
      requestedLocalPort: 23911,
      clientStarted: true,
      client: 'browser',
      hint: '已在系统浏览器打开 http://desktop-kjs1h2l.localhost:24011/dsh/',
    })
    expect(note).toBe('已在系统浏览器打开')
  })
  it('固定口漂移：说"换用临时通道"，不报端口号', () => {
    const note = resultNote({ ok: true, address: '127.0.0.1:24001', localPort: 24001, requestedLocalPort: 23389, clientStarted: false })
    expect(note).toContain('原通道被占用')
    expect(note).not.toContain('23389')
    expect(note).not.toContain('24001')
  })
  it('设备域终态：本地口是 viewer 全局 HTTP 口，不报"换用临时通道"（2026-11-14 真案）', () => {
    const note = resultNote({
      ok: true,
      state: 'ready',
      tunnel: 'device-origin',
      localPort: 24011,
      requestedLocalPort: 23911,
      clientStarted: true,
      client: 'browser',
      hint: '已在系统浏览器打开 http://desktop-kjs1h2l.localhost:24011/dsh/',
    })
    expect(note).toContain('已在系统浏览器打开')
    expect(note).not.toContain('临时通道')
    expect(note).not.toContain('24011')
  })
  it('链路就绪但打开失败：不给"已就绪"假绿，直接说卡的问题（2026-11-14 真案）', () => {
    const note = resultNote({
      ok: true,
      state: 'ready',
      clientStarted: false,
      client: 'browser',
      error: '卡坐标无法生成分享入口',
      hint: '这张卡的入口地址不可用，已避免打开必失败的页面',
    })
    expect(note).toContain('入口地址不可用')
    expect(note).not.toContain('已就绪')
  })
  it('自连（本机是服务端）用 hint；hint 里的地址也要抹掉', () => {
    expect(resultNote({ ok: true, selfTarget: true, address: '127.0.0.1:23389', hint: '这是本机' })).toContain('本机')
    expect(
      resultNote({ ok: true, selfTarget: true, address: '127.0.0.1:23389', hint: '请到客户端设备打开 http://127.0.0.1:23911/gw/x/' }),
    ).not.toContain('http')
  })
  it('offline/no-service 用后端 message，不假绿；后端串里的技术细节同样抹掉', () => {
    expect(resultNote({ ok: false, state: 'offline', message: '设备离线，稍后再试' })).toBe('设备离线，稍后再试')
    expect(resultNote({ ok: false, state: 'no-service', message: '目标未提供远程桌面服务' })).toContain('未提供')
    expect(
      resultNote({ ok: false, state: 'error', message: '固定本地口 127.0.0.1:23389 绑定失败（重试 5 次）；请改 localPort' }),
    ).not.toContain('127.0.0.1')
  })
})

describe('展示层去技术化：cleanTechText / cleanCardTitle（纯显示，数据不动）', () => {
  it('URL / IPv4:端口 / IPv6 / DID 全部抹掉', () => {
    expect(cleanTechText('已在系统浏览器打开 http://127.0.0.1:23911/gw/sh-x/?mt=abc')).toBe('已在系统浏览器打开')
    expect(cleanTechText('连接 127.0.0.1:23389 即可')).toBe('连接 即可')
    expect(cleanTechText('地址 3fff:8a0:1234:5678::1 已就绪')).toBe('地址 已就绪')
    expect(cleanTechText('目标是 did:myco:z6MkPC123')).toBe('目标是 设备')
    expect(cleanTechText('本机固定口 23389 被占用（换一个 localPort）')).toBe('本机固定口 被占用（换一个 端口）')
  })
  it('老卡卡名带 127.0.0.1:端口 → cleanCardTitle 去掉（标题本体保留）', () => {
    expect(cleanCardTitle('【PC远程桌面】127.0.0.1:23389')).toBe('【PC远程桌面】')
    expect(cleanCardTitle('【PC-DSH-Web】127.0.0.1:23911')).toBe('【PC-DSH-Web】')
    expect(cleanCardTitle('普通任务卡标题')).toBe('普通任务卡标题')
  })
})

describe('SSR：卡上每个 env 渲染一行（图标 + 状态 + 打开；不再有地址行/复制钮）', () => {
  const CARD = {
    cardId: 'sh-v20',
    taskId: 'task-v20',
    caps: ['vnet.forward'],
    sourceDevice: 'did:myco:zPC',
    env: [
      { kind: 'rdp', device: 'did:myco:zPC', port: 3389, localPort: 23389 },
      { kind: 'dsh', device: 'did:myco:zPC', port: 13911, localPort: 23911 },
    ],
  }

  it('两行 env → 两个 data-myco-env，kind/打开按钮齐全，初始 idle；无任何地址/设备号', () => {
    const html = ssr(CARD)
    expect(html.match(/data-myco-env="1"/g)).toHaveLength(2)
    expect(html).toContain('data-env-kind="rdp"')
    expect(html).toContain('data-env-kind="dsh"')
    expect(html).toContain('data-env-state="idle"')
    // 2026-10-25 用户反馈：IP/端口/DID 不上卡面（打开链路照旧，只是不再展示）
    expect(html).not.toContain('127.0.0.1')
    expect(html).not.toContain('23389')
    expect(html).not.toContain('23911')
    expect(html).not.toContain('did:myco')
    expect(html.match(/data-env-open="1"/g)).toHaveLength(2)
    expect(html).not.toContain('data-env-copy')
    expect(html).not.toContain('undefined')
  })

  it('自己发的卡（enabled=false）不渲染入口', () => {
    expect(ssr(CARD, false)).toBe('')
  })

  it('老卡只有 sourceDevice → 渲染一条 rdp 行（同样不带地址）', () => {
    const html = ssr({ sourceDevice: 'did:myco:zOld' })
    expect(html).toContain('data-env-kind="rdp"')
    expect(html).not.toContain('127.0.0.1')
  })
})

/**
 * 2026-10-23 任务 A.5：**创建入口**（此前只有渲染/执行，没有"带 env 的卡"的来源，
 * 用户根本找不到一张 RDP 任务卡——问题原话"RDP 的任务卡名字是什么"）。
 *
 * 这里做源码级合同断言（与本仓 `commandContract.test.ts` / `eval/vnet/v20-card-env.py`
 * 同一手法）：入口在分享面板，标题与固定口按设计 §4 写死，IPC 用 `share_create_env_card`。
 * 组件级交互不在这里测（需要 jsdom + Tauri IPC 替身，本仓无该栈）。
 */
describe('创建入口：分享面板能建「带 env 的任务卡」', () => {
  const src = readFileSync(new URL('./FriendsZone.tsx', import.meta.url), 'utf8')

  it('走 IPC share_create_env_card（UI 是 tauri:// 源，不能 fetch 本机管理面）', () => {
    expect(src).toContain("invokeT<{ shareId?: string; card?: { message?: string } }>('share_create_env_card'")
  })

  it('两个按钮 + 两张卡的固定标题（设计 §4；2026-10-25 精简：卡名不带 127.0.0.1:端口）', () => {
    expect(src).toContain('分享远程桌面环境')
    expect(src).toContain('分享 DSH Web 环境')
    expect(src).toContain('【PC远程桌面】')
    expect(src).toContain('【PC-DSH-Web】')
    // 旧模板（卡名带 IP:端口）不得复活——用户反馈技术细节不上卡面
    expect(src).not.toContain('【PC远程桌面】127.0.0.1:23389')
    expect(src).not.toContain('【PC-DSH-Web】127.0.0.1:23911')
  })

  it('分享面板有第三档「分享环境」（pick=分享我的任务 / new=新建任务卡 / env=分享环境）', () => {
    expect(src).toContain("useState<'pick' | 'new' | 'env'>")
    expect(src).toContain("setMode('env')")
  })
})
