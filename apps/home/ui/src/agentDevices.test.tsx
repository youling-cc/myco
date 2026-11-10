/**
 * agentDevices.test.tsx — 智能体 Tab 设备操作层（2026-10-13 P0）回归锚点。
 *
 * 纪律（事故与修复必须沉淀）：本文件钉住三类**行为合同**——
 *   ① 在线态三档（在线·空闲绿 / 离线灰 / 已除名红）+ 已除名优先于在线；
 *   ② 已除名设备**不渲染放行/暂停放行/除名**，只剩「复制 DID」（P0 规格）；
 *   ③ 命令合同：只用 home 已注册的命令（set_device_auth / add_device_by_did /
 *      device_revoke），参数形态钉死；缺公钥时**不发请求**并抛错（不许无声删除）。
 * 组件级断言走 react-dom/server 的 renderToStaticMarkup（本仓无 jsdom/@testing-library，
 * 且 SSR 足以锁住"渲染出什么按钮"这类结构性合同）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AgentDeviceRow, TTL_PRESETS, authAllowedNow, createDeviceOps, deviceOps, devicePresence,
  type AgentDevice, type AgentDeviceRowHandlers, type DeviceOp,
} from './components/AgentDevices'
import { delegationBadgeText, delegationLevel, delegationLevelBg, delegationLevelColor } from './lib/delegationStatus'

const PK = 'z6MkTestPubkeyB64'

const D = (over: Partial<AgentDevice> = {}): AgentDevice => ({
  did: 'did:myco:z6MkDeviceA', name: '小屏手机', pubkeyB64: PK,
  online: false, revoked: false, isEmbodiment: false, ...over,
})

const NOOP: AgentDeviceRowHandlers = {
  onToggle: () => {}, onCopy: () => {}, onAllow: () => {}, onDeny: () => {},
  onAuthorize: () => {}, onAskRemove: () => {}, onConfirmRemove: () => {},
  onCancelRemove: () => {}, onPickTtl: () => {}, onCancelTtl: () => {},
  onRenameAsk: () => {}, onRenameDraft: () => {}, onRenameSave: () => {}, onRenameCancel: () => {},
}

/** SSR 一台展开的设备行（handlers 全部 noop——本文件只断言"渲染出哪些按钮"）。 */
function rowHtml(d: AgentDevice, opts: { ops?: DeviceOp[]; deleg?: { remainingMs: number; expired: boolean } | null; expanded?: boolean; confirmRemove?: boolean; canManage?: boolean; renaming?: boolean; renameDraft?: string; localName?: string | null } = {}): string {
  const ops = opts.ops ?? deviceOps(d, null, { canManage: opts.canManage ?? true })
  return renderToStaticMarkup(createElement(AgentDeviceRow, {
    d, presence: devicePresence(d), ops,
    deleg: opts.deleg ?? null,
    localName: opts.localName ?? null,
    expanded: opts.expanded ?? true,
    busy: false, copied: false,
    confirmRemove: opts.confirmRemove ?? false,
    ttlOpen: false,
    renaming: opts.renaming ?? false,
    renameDraft: opts.renameDraft ?? '',
    handlers: NOOP,
  }))
}

describe('devicePresence 在线态三档（P0-1：绿/灰/红）', () => {
  it('在线 → 「在线 · 空闲」绿 + 呼吸点', () => {
    const p = devicePresence({ online: true, revoked: false })
    expect(p).toMatchObject({ level: 'online', label: '在线 · 空闲', color: '#15803d', dot: '#22c55e', pulse: true })
  })
  it('离线 → 「离线」灰 + 不呼吸', () => {
    const p = devicePresence({ online: false, revoked: false })
    expect(p).toMatchObject({ level: 'offline', label: '离线', color: '#64748b', dot: '#94a3b8', pulse: false })
  })
  it('已除名 → 「已除名」红；**已除名优先于在线**（名册已吊销不该显示"在线"）', () => {
    expect(devicePresence({ online: false, revoked: true })).toMatchObject({ level: 'revoked', label: '已除名', color: '#dc2626' })
    expect(devicePresence({ online: true, revoked: true }).label).toBe('已除名')
  })
})

describe('deviceOps 每台设备可用操作', () => {
  it('已除名：只留「复制 DID」（P0 规格——不给放行/除名按钮）', () => {
    expect(deviceOps(D({ revoked: true }), { authState: 'allowed' }, { canManage: true })).toEqual(['copy'])
  })
  it('本机（isEmbodiment）：不放行/除名自己，只留复制', () => {
    expect(deviceOps(D({ isEmbodiment: true }), { authState: 'allowed' }, { canManage: true })).toEqual(['copy'])
  })
  it('白名单内且已放行（不限时）→ 暂停放行 + 改名 + 除名 + 复制', () => {
    expect(deviceOps(D(), { authState: 'allowed', authExpiresAt: null }, { canManage: true })).toEqual(['auth-deny', 'rename', 'remove', 'copy'])
  })
  it('白名单内但未放行（denied/pending）→ 放行 + 改名 + 除名 + 复制', () => {
    expect(deviceOps(D(), { authState: 'denied' }, { canManage: true })).toEqual(['auth-allow', 'rename', 'remove', 'copy'])
    expect(deviceOps(D(), { authState: 'pending' }, { canManage: true })).toEqual(['auth-allow', 'rename', 'remove', 'copy'])
  })
  it('限时放行到期 → 回到「放行」（与 Rust is_allowed 同口径：到期=未放行）', () => {
    const past = { authState: 'allowed' as const, authExpiresAt: 1000 }
    expect(authAllowedNow(past, 2000)).toBe(false)
    expect(authAllowedNow(past, 500)).toBe(true)
    expect(deviceOps(D(), past, { canManage: true, now: 2000 })).toEqual(['auth-allow', 'rename', 'remove', 'copy'])
  })
  it('名册成员但不在本机白名单（主设备）→ 授权本机 + 除名 + 复制（**不给改名**：rename 只改白名单名）', () => {
    expect(deviceOps(D(), null, { canManage: true })).toEqual(['authorize', 'remove', 'copy'])
  })
  it('成员机（canManage=false）：不给授权/除名（需账号钥）→ 只剩复制', () => {
    expect(deviceOps(D(), null, { canManage: false })).toEqual(['copy'])
  })
  it('名册缺公钥 → 不给除名（device_revoke 需要 pubkeyOrDid，避免点了报错）', () => {
    expect(deviceOps(D({ pubkeyB64: '' }), null, { canManage: true })).toEqual(['authorize', 'copy'])
  })
})

describe('AgentDeviceRow 组件渲染（SSR：结构性合同）', () => {
  it('普通在线设备展开：渲染 放行/改名/除名/复制DID + 「在线 · 空闲」', () => {
    const html = rowHtml(D({ online: true }), { ops: ['auth-allow', 'rename', 'remove', 'copy'] })
    expect(html).toContain('在线 · 空闲')
    expect(html).toContain('>放行<')
    expect(html).toContain('>改名<')
    expect(html).toContain('>除名<')
    expect(html).toContain('复制 DID')
  })
  it('**已除名设备：不渲染 放行/暂停放行/改名/除名/授权本机**，只留复制 DID + 说明', () => {
    const html = rowHtml(D({ revoked: true, online: true, isEmbodiment: false }))
    expect(html).toContain('已除名')
    expect(html).not.toContain('>放行<')
    expect(html).not.toContain('暂停放行')
    expect(html).not.toContain('>改名<')
    expect(html).not.toContain('>除名<')
    expect(html).not.toContain('授权本机')
    expect(html).toContain('复制 DID')
    expect(html).toContain('要再启用需重新配对收编')
  })
  it('已放行设备：渲染「暂停放行」而不是「放行」', () => {
    const html = rowHtml(D(), { ops: ['auth-deny', 'copy'] })
    expect(html).toContain('暂停放行')
    expect(html).not.toContain('>放行<')
  })
  it('改名：未点时不渲染输入框；点开（renaming）后输入框预填本机白名单名 + 保存/取消', () => {
    const closed = rowHtml(D(), { ops: ['rename', 'copy'] })
    expect(closed).toContain('>改名<')
    expect(closed).not.toContain('给这台设备起个名')
    const open = rowHtml(D(), { ops: ['rename', 'copy'], renaming: true, renameDraft: '书房平板', localName: '书房平板' })
    expect(open).toContain('给这台设备起个名')
    expect(open).toContain('value="书房平板"')
    expect(open).toContain('>保存<')
    expect(open).toContain('>取消<')
    expect(open).not.toContain('>改名<')
  })
  it('本机白名单名优先于名册名显示（改名看得见效果）', () => {
    const html = rowHtml(D({ name: '名册旧名' }), { ops: ['copy'], localName: '本机备注名' })
    expect(html).toContain('本机备注名')
    expect(html).not.toContain('名册旧名')
  })
  it('除名两段确认：未确认时**不渲染**「确认除名」，确认后才出现（防无声删除）', () => {
    const ask = rowHtml(D(), { ops: ['remove', 'copy'], confirmRemove: false })
    expect(ask).toContain('>除名<')
    expect(ask).not.toContain('确认除名')
    const confirm = rowHtml(D(), { ops: ['remove', 'copy'], confirmRemove: true })
    expect(confirm).toContain('确认除名')
    expect(confirm).toContain('立即失去授权')
  })
  it('本机行：不渲染放行/除名，给出说明；且不带委任状徽标', () => {
    const html = rowHtml(D({ isEmbodiment: true, name: '我的电脑' }), { deleg: { remainingMs: 30 * 86_400_000, expired: false } })
    expect(html).not.toContain('>放行<')
    expect(html).not.toContain('授权剩余')
    expect(html).toContain('不在此处放行/除名自己')
  })
})

describe('委任状剩余徽标按天数分档（>3 天绿 / ≤3 天橙 / 过期红「请重新授权」）', () => {
  const DAY = 86_400_000
  it('剩余 27 天 → 绿 + 「授权剩余 27 天」', () => {
    const s = { remainingMs: 27 * DAY, expired: false }
    const html = rowHtml(D(), { ops: ['copy'], deleg: s })
    expect(html).toContain('授权剩余 27 天')
    expect(html).toContain(delegationLevelColor('ok'))
    expect(html).toContain(delegationLevelBg('ok'))
    expect(delegationBadgeText(s)).toBe('授权剩余 27 天')
  })
  it('剩余 2 天（≤3 天）→ 橙 + 「授权剩余 2 天」', () => {
    const s = { remainingMs: 2 * DAY, expired: false }
    const html = rowHtml(D(), { ops: ['copy'], deleg: s })
    expect(delegationLevel(s)).toBe('warn')
    expect(html).toContain('授权剩余 2 天')
    expect(html).toContain(delegationLevelColor('warn'))
    expect(html).toContain(delegationLevelBg('warn'))
  })
  it('恰好 3 天 → 橙（边界含等号）；3 天零 1ms → 绿', () => {
    expect(delegationLevel({ remainingMs: 3 * DAY, expired: false })).toBe('warn')
    expect(delegationLevel({ remainingMs: 3 * DAY + 1, expired: false })).toBe('ok')
  })
  it('已过期 → 红 + 「授权已过期 · 请重新授权」', () => {
    const s = { remainingMs: 0, expired: true }
    const html = rowHtml(D(), { ops: ['copy'], deleg: s })
    expect(html).toContain('授权已过期 · 请重新授权')
    expect(html).toContain(delegationLevelColor('expired'))
    expect(delegationLevelBg('expired')).toBe('#fee2e2')
  })
  it('剩不足 1 天 → 「授权剩余不足 1 天」（不谎报 1 天）', () => {
    expect(delegationBadgeText({ remainingMs: 3600_000, expired: false })).toBe('授权剩余不足 1 天')
  })
})

describe('createDeviceOps 命令合同（只用已注册命令 + 参数形态）', () => {
  it('放行：set_device_auth {did, allowed:true, ttlMs}（不限时=tllMs null）', async () => {
    const invoke = vi.fn().mockResolvedValue(true)
    const ops = createDeviceOps(invoke as unknown as Parameters<typeof createDeviceOps>[0])
    await ops.allow('did:myco:A')
    expect(invoke).toHaveBeenLastCalledWith('set_device_auth', { did: 'did:myco:A', allowed: true, ttlMs: null })
    await ops.allow('did:myco:A', 3600_000)
    expect(invoke).toHaveBeenLastCalledWith('set_device_auth', { did: 'did:myco:A', allowed: true, ttlMs: 3600_000 })
  })
  it('暂停放行：set_device_auth {did, allowed:false}', async () => {
    const invoke = vi.fn().mockResolvedValue(true)
    const ops = createDeviceOps(invoke as unknown as Parameters<typeof createDeviceOps>[0])
    await ops.deny('did:myco:B')
    expect(invoke).toHaveBeenLastCalledWith('set_device_auth', { did: 'did:myco:B', allowed: false })
  })
  it('授权本机：add_device_by_did {did, name, ownerRootDid}', async () => {
    const invoke = vi.fn().mockResolvedValue({})
    const ops = createDeviceOps(invoke as unknown as Parameters<typeof createDeviceOps>[0])
    await ops.authorizeLocal(D({ did: 'did:myco:C', name: '平板' }), 'did:youling:ROOT')
    expect(invoke).toHaveBeenLastCalledWith('add_device_by_did', { did: 'did:myco:C', name: '平板', ownerRootDid: 'did:youling:ROOT' })
    await ops.authorizeLocal(D({ did: 'did:myco:C', name: '平板' }), null)
    expect(invoke).toHaveBeenLastCalledWith('add_device_by_did', { did: 'did:myco:C', name: '平板', ownerRootDid: null })
  })
  it('除名：device_revoke {pubkeyOrDid}（**不是**未注册的 remove_authorized_device）', async () => {
    const invoke = vi.fn().mockResolvedValue({})
    const ops = createDeviceOps(invoke as unknown as Parameters<typeof createDeviceOps>[0])
    await ops.removeFromRoster(D({ pubkeyB64: 'PK1' }))
    expect(invoke).toHaveBeenLastCalledWith('device_revoke', { pubkeyOrDid: 'PK1' })
    expect(invoke).not.toHaveBeenCalledWith('remove_authorized_device', expect.anything())
  })
  it('改名：rename_authorized_device {did, name}；返回 false（不在白名单）→ 抛错而不是装作成功', async () => {
    const invoke = vi.fn().mockResolvedValue(true)
    const ops = createDeviceOps(invoke as unknown as Parameters<typeof createDeviceOps>[0])
    await ops.rename('did:myco:A', '书房平板')
    expect(invoke).toHaveBeenLastCalledWith('rename_authorized_device', { did: 'did:myco:A', name: '书房平板' })
    const invokeFalse = vi.fn().mockResolvedValue(false)
    const ops2 = createDeviceOps(invokeFalse as unknown as Parameters<typeof createDeviceOps>[0])
    await expect(ops2.rename('did:myco:B', 'x')).rejects.toThrow('该设备不在本机白名单')
  })
  it('放行返回 false（不在白名单）→ 抛错（点了没反应=假按钮，禁止）', async () => {
    const invoke = vi.fn().mockResolvedValue(false)
    const ops = createDeviceOps(invoke as unknown as Parameters<typeof createDeviceOps>[0])
    await expect(ops.allow('did:myco:X')).rejects.toThrow('放行失败')
    await expect(ops.deny('did:myco:X')).rejects.toThrow('暂停失败')
  })
  it('缺公钥 → 抛错且**不发任何请求**（不许无声删除）', async () => {
    const invoke = vi.fn().mockResolvedValue({})
    const ops = createDeviceOps(invoke as unknown as Parameters<typeof createDeviceOps>[0])
    await expect(ops.removeFromRoster(D({ pubkeyB64: '  ' }))).rejects.toThrow('名册数据缺公钥')
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('放行时长预设（与 MycoDevices 同款：不限/30分/1小时/24小时）', () => {
  it('四项；除「不限」外都带 ms', () => {
    expect(TTL_PRESETS.map((p) => p.label)).toEqual(['不限', '30 分钟', '1 小时', '24 小时'])
    expect(TTL_PRESETS[0].ms).toBeUndefined()
    expect(TTL_PRESETS[3].ms).toBe(24 * 3600_000)
  })
})
