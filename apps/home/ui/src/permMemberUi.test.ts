/**
 * task-43：成员设备只读权限面板的纯函数单测。
 * 目标（fail-closed）：
 *  ① 成员设备（remoteOrigin）绝不再出现「全权」；
 *  ② 角色摘要按快照/grant 显示只读/可输入 + 「受任务/设备策略限制」；
 *  ③ 只有分享源设备允许编辑；成员设备一律只读（面板写入口由 canEdit 判定隐藏/拦截）；
 *  ④ 人话提示必须包含「源设备」与"不能写"。
 */
import { describe, it, expect } from 'vitest'
import {
  canEditPermissionPanel, isMemberDeviceCard, memberPermHint, memberRoleTitle,
  readonlyFooterText, readonlyPanelHint, MEMBER_DEVICE_LIMIT,
} from './permMemberUi'

describe('permMemberUi / 成员设备角色摘要', () => {
  it('分享源设备（非 remoteOrigin）owner 仍可显示全权（原有语义不变）', () => {
    const src = { myRole: 'owner', remoteOrigin: false, grant: { caps: {} } }
    expect(isMemberDeviceCard(src)).toBe(false)
    expect(canEditPermissionPanel(src)).toBe(true)
    expect(memberRoleTitle(src)).toBe('主人（不受限）')
  })

  it('成员设备 owner 不许说全权：无快照时给「受任务/设备策略限制」', () => {
    const member = { myRole: 'owner', remoteOrigin: true }
    expect(isMemberDeviceCard(member)).toBe(true)
    expect(canEditPermissionPanel(member)).toBe(false)
    expect(memberPermHint(member)).toBe(`我的设备 · ${MEMBER_DEVICE_LIMIT}`)
    expect(memberPermHint(member)).not.toContain('全权')
  })

  it('成员设备 grant 只读 → 明确「只读」且带限制话术', () => {
    const member = { myRole: 'owner', remoteOrigin: true, grant: { ro: true, caps: { 'session.read': true } } }
    const hint = memberPermHint(member)
    expect(hint).toContain('只读')
    expect(hint).toContain(MEMBER_DEVICE_LIMIT)
    expect(hint).not.toContain('全权')
  })

  it('成员设备可输入（grant.caps.session.input=true）→ 「可输入」而不是全权', () => {
    const member = { myRole: 'owner', remoteOrigin: true, grant: { caps: { 'session.read': true, 'session.input': true } } }
    const hint = memberPermHint(member)
    expect(hint).toContain('可输入')
    expect(hint).toContain(MEMBER_DEVICE_LIMIT)
    expect(hint).not.toContain('全权')
  })

  it('成员设备无 grant 时从卡片快照 caps 面读权限（只读/可输入）', () => {
    const readOnly = { myRole: 'owner', remoteOrigin: true, shareSnapshot: { caps: { o: [{ id: 'session.read' }], a: [] } } }
    expect(memberPermHint(readOnly)).toContain('只读')
    const canInput = { myRole: 'owner', remoteOrigin: true, shareSnapshot: { caps: { o: [{ id: 'session.read' }], a: [{ id: 'session.input' }] } } }
    expect(memberPermHint(canInput)).toContain('可输入')
  })

  it('成员设备角色 tooltip 不再写「主人（不受限）」', () => {
    expect(memberRoleTitle({ myRole: 'owner', remoteOrigin: true })).toContain('成员设备')
    expect(memberRoleTitle({ myRole: 'owner', remoteOrigin: true })).not.toContain('不受限')
    expect(memberRoleTitle({ myRole: 'collaborator', remoteOrigin: true })).toContain('成员设备')
  })

  it('协作者（非成员设备）仍走原协作者分支，不误判为成员设备', () => {
    const collab = { myRole: 'collaborator', remoteOrigin: false, grant: { caps: { 'session.read': true } } }
    expect(isMemberDeviceCard(collab)).toBe(false)
    expect(canEditPermissionPanel(collab)).toBe(true)
  })
})

describe('permMemberUi / 只读人话提示', () => {
  it('带来源设备名：包含设备名+源设备+不能写', () => {
    const s = readonlyPanelHint('DESKTOP-KJS1H2L')
    expect(s).toContain('DESKTOP-KJS1H2L')
    expect(s).toContain('源设备')
    expect(s).toContain('不能邀请账号')
    expect(s).toContain('不能停止授权')
    expect(s).toContain('不能保存')
    expect(s).toContain('到那台设备操作')
  })

  it('无设备名也给出明确兜底（不静默）', () => {
    const s = readonlyPanelHint()
    expect(s).toContain('源设备')
    expect(s).toContain('只读快照')
  })

  it('底部状态行说明"本机不提供权限编辑"（设计如此，不是失败）', () => {
    expect(readonlyFooterText('LAPTOP-DACG4GGQ')).toContain('本机不提供权限编辑')
    expect(readonlyFooterText('LAPTOP-DACG4GGQ')).toContain('LAPTOP-DACG4GGQ')
    expect(readonlyFooterText()).toContain('另一台设备')
  })
})
