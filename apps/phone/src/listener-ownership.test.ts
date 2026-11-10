import { describe, expect, it } from 'vitest'
import { shouldStopOwnedListener } from './update-check'
import { isLocalListenerRunning } from './native-proxy'

describe('共享本地监听所有权', () => {
  it('已有主监听时不允许更新检查停掉它', () => {
    expect(shouldStopOwnedListener(true)).toBe(false)
  })

  it('只有调用前没有监听时才允许收尾', () => {
    expect(shouldStopOwnedListener(false)).toBe(true)
  })

  it('snapshot running=true 能识别主监听', () => {
    ;(globalThis as { window?: unknown }).window = {
      MycoShell: { tunnelState: () => 'proxy port=9100 running=true conns=2' },
    }
    expect(isLocalListenerRunning()).toBe(true)
  })

  it('snapshot running=false / 空值不当作在听', () => {
    ;(globalThis as { window?: unknown }).window = {
      MycoShell: { tunnelState: () => 'proxy port=9100 running=false conns=0' },
    }
    expect(isLocalListenerRunning()).toBe(false)
    ;(globalThis as { window?: unknown }).window = {}
    expect(isLocalListenerRunning()).toBe(false)
  })
})
