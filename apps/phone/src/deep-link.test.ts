import { describe, it, expect } from 'vitest'
import { parseAuthDeepLink, isCallbackAllowed } from './deep-link'

describe('深链接登录：URI 解析（DL-Auth）', () => {
  it('DL-P-001 合法 URI → 解析出 ticket + callback', () => {
    const url = 'myco://auth?ticket=tk-123&callback=https%3A%2F%2Fwww.youling.cc%2F'
    const r = parseAuthDeepLink(url)
    expect(r).not.toBeNull()
    expect(r!.ticket).toBe('tk-123')
    expect(r!.callback).toBe('https://www.youling.cc/')
  })

  it('DL-P-002 非 auth 路径 → null', () => {
    expect(parseAuthDeepLink('myco://other?ticket=x')).toBeNull()
    expect(parseAuthDeepLink('https://evil.com?ticket=x')).toBeNull()
  })

  it('DL-P-003 缺 ticket 或 callback → null', () => {
    expect(parseAuthDeepLink('myco://auth?callback=https://www.youling.cc/')).toBeNull()
    expect(parseAuthDeepLink('myco://auth?ticket=tk-1')).toBeNull()
  })
})

describe('深链接登录：callback 白名单（DL-Auth）', () => {
  it('DL-S-001 youling.cc 系域名 → 允许', () => {
    expect(isCallbackAllowed('https://www.youling.cc/')).toBe(true)
    expect(isCallbackAllowed('https://youling.cc/auth')).toBe(true)
    expect(isCallbackAllowed('https://dev.youling.cc/')).toBe(true)
  })

  it('DL-S-002 非白名单域名 → 拒绝', () => {
    expect(isCallbackAllowed('https://evil.com/steal')).toBe(false)
    expect(isCallbackAllowed('https://youling.cc.evil.com/')).toBe(false)
    expect(isCallbackAllowed('not-a-url')).toBe(false)
  })
})
