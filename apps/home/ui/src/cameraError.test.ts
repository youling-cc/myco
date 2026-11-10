/**
 * cameraError PC 端断言 —— getUserMedia 错误分型 → 友好文案映射锁（2026-09-30 用户截图实测问题整改）。
 * 被测实现单一源：packages/ui-kit/src/cameraError.ts（env/ui QrCamera.tsx 消费，MycoDevices 内嵌）。
 * 与 apps/phone/src/cameraError.test.ts 同源双锁（phone 经 @myco alias，此处经 workspace 包）。
 */
import { describe, it, expect } from 'vitest'
import { cameraErrorHint, cameraErrorName } from '@myco/ui-kit/cameraError'

const namedErr = (name: string, msg = 'x') => { const e = new Error(msg); e.name = name; return e }

describe('cameraErrorName — 异常名提取', () => {
  it('Error/DOMException 对象取 .name', () => {
    expect(cameraErrorName(namedErr('NotFoundError'))).toBe('NotFoundError')
    expect(cameraErrorName(new DOMException('Requested device not found', 'NotAllowedError'))).toBe('NotAllowedError')
  })

  it('字符串形态 "NotFoundError: ..." 也能取出名', () => {
    expect(cameraErrorName('NotFoundError: Requested device not found')).toBe('NotFoundError')
    expect(cameraErrorName('Error: NotReadableError: Could not start source')).toBe('NotReadableError')
  })

  it('认不出的 → 空串（走 fallback 分支）', () => {
    expect(cameraErrorName('莫名其妙')).toBe('')
    expect(cameraErrorName(null)).toBe('')
  })
})

describe('cameraErrorHint — 错误类型 → 提示文案（PC 无摄像头=常态，不是错误红）', () => {
  it('NotFoundError（PC 无摄像头常态）→ 「没有摄像头」+ 粘贴/图片双兜底引导', () => {
    const h = cameraErrorHint(namedErr('NotFoundError', 'Requested device not found'))
    expect(h.title).toContain('没有摄像头')
    expect(h.hint).toContain('粘贴识别码')
    expect(h.hint).toContain('从图片识别')
    expect(h.detail).toBeUndefined()
  })

  it('NotAllowedError → 「权限被拒绝」；NotReadableError → 「占用」', () => {
    expect(cameraErrorHint(namedErr('NotAllowedError')).title).toContain('权限被拒绝')
    expect(cameraErrorHint(namedErr('NotReadableError')).title).toContain('占用')
  })

  it('未识别类型 → 通用文案 + detail 附原始错误', () => {
    const h = cameraErrorHint(namedErr('OverconstrainedError', 'facingMode 不满足'))
    expect(h.title).toContain('摄像头打不开')
    expect(h.detail).toContain('OverconstrainedError')
  })

  it('用户实测的原始串（String(e) 形态）也走 NotFound 分支', () => {
    expect(cameraErrorHint('NotFoundError: Requested device not found').title).toContain('没有摄像头')
  })
})
