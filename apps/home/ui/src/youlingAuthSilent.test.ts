import { describe, it, expect, vi } from 'vitest'

/* 2026-10-10 任务1（静默加固）：embed-server 把 `silent` 透传进 `myco://auth` URI
 * （`&silent=1`），YoulingAuth 必须**认出**这个标记——认不出就会渲染确认弹层并
 * 以非静默方式调 session_delegation_sign，安全闸（静默只许续期已授权会话钥）形同虚设。
 * 本用例锁死解析口径：只有 `silent=1` / `silent=true` 算静默，缺省/其他值一律非静默。 */

// Node 测试环境下 localStorage 是 stub——YoulingAuth 模块级 resolveDidBase 会访问它
vi.stubGlobal('localStorage', { getItem: () => null })
const { parseAuthUri } = await import('./YoulingAuth')

const CB = 'https://youling.cc/api/v1/auth/myco/callback'

describe('myco://auth URI 的 silent 标记解析', () => {
  it('silent=1（embed-server 现行形态）→ 静默，且携带会话钥', () => {
    const r = parseAuthUri(`myco://auth?ticket=tk&callback=${CB}&svc=s&sk=AAA&silent=1`)
    expect(r).not.toBeNull()
    expect(r!.silent).toBe(true)
    expect(r!.sessionPubkey).toBe('AAA')
    expect(r!.callbackHost).toBe('youling.cc')
  })

  it('缺省 / silent=0 / silent=别的值 → 非静默（原行为：弹确认，需用户点确认）', () => {
    for (const uri of [
      `myco://auth?ticket=tk&callback=${CB}&svc=s&sk=AAA`,
      `myco://auth?ticket=tk&callback=${CB}&svc=s&sk=AAA&silent=0`,
      `myco://auth?ticket=tk&callback=${CB}&svc=s&sk=AAA&silent=no`,
      `myco://auth?ticket=tk&callback=${CB}&svc=s&sk=AAA&silent=`,
    ]) {
      expect(parseAuthUri(uri)!.silent, uri).toBe(false)
    }
  })

  it('silent=true（手写深链接）也认；缺 ticket/callback 仍返回 null', () => {
    expect(parseAuthUri(`myco://auth?ticket=tk&callback=${CB}&silent=true`)!.silent).toBe(true)
    expect(parseAuthUri('myco://auth?callback=' + CB)).toBeNull()
    expect(parseAuthUri('myco://auth?ticket=tk')).toBeNull()
  })
})
