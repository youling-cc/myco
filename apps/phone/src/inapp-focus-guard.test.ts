import { describe, expect, it, vi } from 'vitest'

import { INAPP_FOCUS_GUARD_JS, shouldBlurFocus } from './inapp-focus-guard'

/**
 * 2026-10-23 实测反馈回归用例：DSH web 点会话自动弹软键盘。
 * 两层测试：
 *  ① 纯决策函数 shouldBlurFocus（规则本体）
 *  ② 对**实际注入脚本**跑最小 DOM 模拟——防止「纯函数对、脚本拼错」的回归。
 */

describe('shouldBlurFocus（规则本体）', () => {
  it('程序聚焦（点会话后 web 自动 focus 输入框）→ blur', () => {
    expect(shouldBlurFocus(true, false)).toBe(true)
  })
  it('用户直接点输入框 → 放行（键盘正常弹）', () => {
    expect(shouldBlurFocus(true, true)).toBe(false)
  })
  it('聚焦的不是可编辑元素（按钮/链接等）→ 放行', () => {
    expect(shouldBlurFocus(false, false)).toBe(false)
    expect(shouldBlurFocus(false, true)).toBe(false)
  })
})

describe('INAPP_FOCUS_GUARD_JS（注入脚本行为）', () => {
  function makeEnv() {
    const listeners: Record<string, Array<(e: unknown) => void>> = {}
    const env: Record<string, unknown> = {
      window: { __mycoFocusGuard: undefined },
      document: {
        addEventListener: (t: string, fn: (e: unknown) => void) => {
          ;(listeners[t] ||= []).push(fn)
        },
      },
    }
    return { env, listeners }
  }
  function runScript(env: Record<string, unknown>) {
    // 注意：new Function 的函数体没有 return 就返回 undefined（completion value 语义只属于
    // eval）；Android 的 evaluateJavascript 是 eval 语义，直接吃脚本完成值。这里补 return 对齐。
    // eslint-disable-next-line no-new-func
    const fn = new Function('window', 'document', 'return ' + INAPP_FOCUS_GUARD_JS)
    return fn(env.window, env.document)
  }
  function fire(listeners: Record<string, Array<(e: unknown) => void>>, type: string, ev: unknown) {
    for (const fn of listeners[type] ?? []) fn(ev)
  }
  const editableTarget = () => ({
    tagName: 'TEXTAREA',
    isContentEditable: false,
    blur: vi.fn(),
  })

  it('注入返回 ok，重复注入返回 already（幂等）', () => {
    const { env } = makeEnv()
    expect(runScript(env)).toBe('ok')
    expect(runScript(env)).toBe('already')
  })

  it('点会话（触摸非编辑区）后程序 focus 输入框 → 被 blur，计数+1', () => {
    const { env, listeners } = makeEnv()
    runScript(env)
    fire(listeners, 'touchend', { target: { closest: () => null } }) // 点的是会话条目
    const t = editableTarget()
    fire(listeners, 'focusin', { target: t })
    expect(t.blur).toHaveBeenCalledTimes(1)
    expect((env.window as { __mycoFocusGuardBlocked?: number }).__mycoFocusGuardBlocked).toBe(1)
  })

  it('用户直接点输入框 → 不 blur', () => {
    const { env, listeners } = makeEnv()
    runScript(env)
    fire(listeners, 'touchend', { target: { closest: () => ({}) } }) // 点在输入框上
    const t = editableTarget()
    fire(listeners, 'focusin', { target: t })
    expect(t.blur).not.toHaveBeenCalled()
    expect((env.window as { __mycoFocusGuardBlocked?: number }).__mycoFocusGuardBlocked).toBeUndefined()
  })

  it('聚焦非编辑元素（如按钮）→ 不 blur', () => {
    const { env, listeners } = makeEnv()
    runScript(env)
    fire(listeners, 'touchend', { target: { closest: () => null } })
    const btn = { tagName: 'BUTTON', isContentEditable: false, blur: vi.fn() }
    fire(listeners, 'focusin', { target: btn })
    expect(btn.blur).not.toHaveBeenCalled()
  })
})
