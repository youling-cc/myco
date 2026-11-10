import { describe, it, expect } from 'vitest'
import {
  LEGACY_FORMAT_TITLE, LEGACY_FORMAT_BODY, LEGACY_FORMAT_ACTION, LEGACY_FORMAT_CHIP,
  shouldShowLegacyBanner, shouldShowUnbindPanel,
} from '@wsui/lib/legacyAccount'

/* 2026-10-07 清档闸门立法：旧格式账号（非 canonical did）自愈被服务端 400
 * unsupported_did_format 拒——客户端不再静默（此前只 tracing::warn，用户只看到
 * 加好友 403/搜不到）。引导条文案单一源 + 显隐判定的合同测试：
 *  - 文案必须同时给两条出路（G2 区分）：解绑重注册 + 导恢复码再导入；
 *  - 显隐只认「检出标记 ∧ 本机有账号上下文」——未关联/游客态不出。
 * 2026-10-08 修订（用户实测）：正文不再提「注销设备」——它只删设备身份不清账号
 * （旧格式账号回来仍在=死循环），且与「解绑」折叠的确认暗语错位造成"输了没反应"。 */

describe('格式无效引导文案（PC/手机一字不差的单一源，2026-10-09 设计定稿：不说"旧格式"）', () => {
  it('标题/正文/按钮/警示短标非空且含关键动作词', () => {
    expect(LEGACY_FORMAT_TITLE).toBe('格式无效，不支持')
    // 两条出路都必须在正文里：① 清除无效号（回未关联态）② 导恢复码
    expect(LEGACY_FORMAT_BODY).toContain('恢复码')
    expect(LEGACY_FORMAT_BODY).not.toContain('旧格式')
    expect(LEGACY_FORMAT_ACTION).toContain('清除此账号')
    expect(LEGACY_FORMAT_ACTION).not.toContain('注销')
    expect(LEGACY_FORMAT_CHIP).toContain('格式无效')
  })
})

describe('shouldShowLegacyBanner（显隐判定）', () => {
  const DID = 'did:youling:z7S2YE7Q6g2vx9mqZ4PsXUhszXJhjqCbFKnutmHhQ4cgb'
  it('检出标记 + 有账号 → 出引导条', () => {
    expect(shouldShowLegacyBanner(DID, true)).toBe(true)
  })
  it('未检出 / 检出但无账号上下文 → 不出', () => {
    expect(shouldShowLegacyBanner(DID, false)).toBe(false)
    expect(shouldShowLegacyBanner(DID, undefined)).toBe(false)
    expect(shouldShowLegacyBanner(null, true)).toBe(false)
    expect(shouldShowLegacyBanner('', true)).toBe(false)
  })
})

/* 2026-10-08 用户实测 bug 回归锁：**解绑成功后未关联态页面上仍渲染解绑区红框**
 * （文案"请先完成备份，再解绑。"——因 accountBackedUp 标记随解绑一并清除，恰好落在
 * "未备份"分支，用户看起来像"解绑没生效/红框清不掉"）。两个根因缺一即复现：
 *   ① 成功回调里没有收起（unbindOpen 残留）—— doUnbind 已补 setUnbindOpen(false)；
 *   ② 渲染条件只判 unbindOpen、不判身份态—— 本判定把"必须具身态且有账号"一起钉住，
 *      使解绑后（role→unlinked / rootDid 空）无论 unbindOpen 是否被清都不再渲染。 */
describe('shouldShowUnbindPanel（解绑危险区显隐，2026-10-08 用户实测 bug 回归锁）', () => {
  const DID = 'did:youling:7S2YE7Q6g2vx9mqZ4PsXUhszXJhjqCbFKnutmHhQ4cgb'
  it('具身态 + 有账号 + 已展开 → 显示', () => {
    expect(shouldShowUnbindPanel(true, 'embodiment', DID)).toBe(true)
  })
  it('解绑后（role→unlinked）→ 不显示（用户实测 bug 的场景，含 rootDid 残留）', () => {
    expect(shouldShowUnbindPanel(true, 'unlinked', null)).toBe(false)
    expect(shouldShowUnbindPanel(true, 'unlinked', DID)).toBe(false)
  })
  it('账号上下文消失（rootDid 空）→ 不显示', () => {
    expect(shouldShowUnbindPanel(true, 'embodiment', null)).toBe(false)
    expect(shouldShowUnbindPanel(true, 'embodiment', '')).toBe(false)
  })
  it('未展开 / 非具身态 → 不显示', () => {
    expect(shouldShowUnbindPanel(false, 'embodiment', DID)).toBe(false)
    expect(shouldShowUnbindPanel(true, 'agent', DID)).toBe(false)
    expect(shouldShowUnbindPanel(true, null, DID)).toBe(false)
  })
})
