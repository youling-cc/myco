/**
 * panelsSplit.test.ts — 面板分工回归（2026-10-13 P0/P1）。
 *
 * 事故形态：PC 端「账号页」与「智能体 Tab」**两份都在显示只读设备运行态**（在线点 +
 * 设备名单浏览），用户看到重复信息；且 P0 之前智能体 Tab 是纯只读名单，操作层缺位。
 * 修法：智能体 Tab = 设备操作层（名单/在线态/放行·授权·除名/复制 DID，见 AgentDevices），
 * 账号页设备区 = 本机身份管理（备份/加设备/出示码/注销/危险区）+ 一句引导。
 *
 * 本文件把"分工"钉成源码级合同（本仓无 jsdom/@testing-library；结构化断言走 `?raw` 源码扫描，
 * 行为断言走 agentDevices.test.tsx 的 SSR 渲染）——防未来有人把只读运行态又搬回账号页。
 */
import { describe, expect, it } from 'vitest'
import mycoDevicesSrc from './components/MycoDevices.tsx?raw'
import identityPanelSrc from './components/IdentityPanel.tsx?raw'
import agentDevicesSrc from './components/AgentDevices.tsx?raw'
import appSrc from './App.tsx?raw'
import { DEVICES_MOVED_HINT, DEVICES_MOVED_JUMP } from './lib/devicePanels'

/** 去注释（`/* *\/` 与 `//`）——注释里会引用"已移除的旧写法"，不该被当成代码断言对象。 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const mycoCode = stripComments(mycoDevicesSrc)
const panelCode = stripComments(identityPanelSrc)
const agentCode = stripComments(agentDevicesSrc)

describe('账号页（MycoDevices/IdentityPanel）不再渲染只读在线状态', () => {
  it('MycoDevices 源码里没有 ●在线 / ○离线 状态点', () => {
    expect(mycoCode).not.toContain('●在线')
    expect(mycoCode).not.toContain('○离线')
  })
  it('名册浏览块（rosterExtras）已下线——不再是"名册有、白名单没有"的浏览视图', () => {
    expect(mycoCode).not.toContain('rosterExtras')
    expect(mycoCode).not.toContain('未授权本机')
  })
  it('委任状剩余徽标仍在（今晚刚加的功能，不能删）', () => {
    expect(mycoCode).toContain('delegation_status_by_device')
    expect(mycoCode).toContain('delegByPub')
  })
})

describe('账号页保留全部管理入口（不许因去重被删）', () => {
  it('添加设备 / 出示码（识别码）/ 配对命令在位', () => {
    expect(mycoCode).toContain("'list_authorized_devices'")
    expect(mycoCode).toContain("'add_device_by_did'")
    expect(mycoCode).toContain('我的识别码')
    expect(mycoCode).toContain('添加设备')
  })
  it('放行管理（set_device_auth）与作用域（set_device_scopes）在位', () => {
    expect(mycoCode).toContain("'set_device_auth'")
    expect(mycoCode).toContain("'set_device_scopes'")
  })
  it('账号页身份管理职责齐：备份恢复码 / 从本机注销设备 / 危险区（解绑）/ 退出登录', () => {
    expect(panelCode).toContain('备份恢复码')
    expect(panelCode).toContain('从本机注销设备')
    expect(panelCode).toContain('解绑本机的账号')
    expect(panelCode).toContain('退出登录')
  })
  it('成员卡「委任状授权剩余」显示保留（delegationStatusText 仍在 IdentityPanel）', () => {
    expect(panelCode).toContain('delegationStatusText')
    expect(panelCode).toContain("'delegation_status'")
  })
})

describe('账号页设备区改为一句引导（用户找得到智能体 Tab）', () => {
  it('引导文案单一源且指向底部「🤖 智能体」Tab', () => {
    expect(DEVICES_MOVED_HINT).toBe('设备与在线状态见底部「🤖 智能体」Tab')
    expect(DEVICES_MOVED_JUMP).toBe('去查看 →')
  })
  it('IdentityPanel 渲染引导句（DEVICES_MOVED_HINT）并接跳转回调', () => {
    expect(panelCode).toContain('DEVICES_MOVED_HINT')
    expect(panelCode).toContain('onOpenAgentsTab')
  })
  it('App 传入跳转回调（关账号页 + 切到 agents Tab）且该 Tab 渲染 AgentDevices', () => {
    expect(appSrc).toContain('onOpenAgentsTab')
    expect(appSrc).toContain('AgentDevices')
    expect(appSrc).toContain("setMainTab('agents')")
  })
  it('智能体 Tab 只用已注册命令（无幽灵调用；除名走 device_revoke 语义=名册吊销）', () => {
    // AgentDevices.tsx 是 P0 的载体：命令清单在这里核对（App.tsx 不再直接 invoke 设备命令）
    expect(agentCode).toContain("'list_authorized_devices'")
    expect(agentCode).toContain("'set_device_auth'")
    expect(agentCode).toContain("'add_device_by_did'")
    expect(agentCode).toContain("'rename_authorized_device'")
    expect(agentCode).toContain("'device_revoke'")
    expect(agentCode).toContain("'delegation_status_by_device'")
    // remove_authorized_device 是「删本机白名单记录」（不做名册吊销）→ 不是本 Tab 的「除名」
    expect(agentCode).not.toContain("'remove_authorized_device'")
    expect(agentCode).not.toContain("'revoke_roster_device'")
    expect(appSrc).not.toContain('remove_authorized_device')
  })
})
