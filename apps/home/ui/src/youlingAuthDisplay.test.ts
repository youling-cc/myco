import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useIdentityStore } from '@wsui/stores/identityStore'

/* 2026-10-02 修复回归：确认弹窗"将使用当前身份"显示与实际用钥不一致——
 * 确认走 wallet_sign=账号钥签名（服务端日志验证提交 did:youling: 轴），
 * 弹窗却显示设备 did（identityStore.did=identity_get 的 did:myco: 轴）。
 * 修后显示=pickAuthDisplayDid(rootDid, did)：账号轴优先，无账号回落设备轴。 */

// Node 测试环境下的 localStorage 是非函数 stub（getItem 不存在）——YoulingAuth
// 模块级 resolveDidBase 会访问它，先 stub 成合法最小 Storage 再动态加载模块。
vi.stubGlobal('localStorage', { getItem: () => null })
const { pickAuthDisplayDid } = await import('./YoulingAuth')

const ACCOUNT_DID = 'did:youling:z6MkmQ7vHsT9wBnE4uLpXyZa1cDfGh'
const DEVICE_DID = 'did:myco:z6MkeJKomRTkqP3vNsW8xHb2aYd4fE'

describe('YoulingAuth 确认弹窗身份显示（pickAuthDisplayDid）', () => {
  beforeEach(() => {
    useIdentityStore.setState({ did: '', rootDid: null })
  })

  it('identityStore 有 rootDid → 弹窗显示账号 did（与 wallet_sign 实际用钥同轴）', () => {
    useIdentityStore.setState({ did: DEVICE_DID, rootDid: ACCOUNT_DID })
    const s = useIdentityStore.getState()
    const display = pickAuthDisplayDid(s.rootDid, s.did)
    expect(display).toBe(ACCOUNT_DID)
    expect(display.startsWith('did:youling:')).toBe(true)
    // 截断显示同现状风格：前 20 字符 + …，且不含设备 did 前缀
    const short = `${display.slice(0, 20)}…`
    expect(short.startsWith('did:youling:')).toBe(true)
    expect(short).not.toContain('did:myco:z6MkeJKomRT')
  })

  it('无账号身份（rootDid=null，needAccount 兜底渲染）→ 回落设备 did，不空白', () => {
    useIdentityStore.setState({ did: DEVICE_DID, rootDid: null })
    const s = useIdentityStore.getState()
    const display = pickAuthDisplayDid(s.rootDid, s.did)
    expect(display).toBe(DEVICE_DID)
    expect(display.startsWith('did:myco:')).toBe(true)
    expect(display.length).toBeGreaterThan(0)
  })

  it('两轴都未加载（空串）→ 空串（confirm 分支不会出现：rootDid 空走 needAccount/checking）', () => {
    expect(pickAuthDisplayDid(null, '')).toBe('')
  })
})
