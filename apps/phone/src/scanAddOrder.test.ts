/**
 * scanAddOrder 手机端断言 —— 手机保持「摄像头主 / 粘贴次」形态（2026-09-30 PC 优先重排的对应面）。
 * 被测实现单一源：packages/ui-kit/src/scanAddOrder.ts（Pairing.tsx 消费，经 @myco alias）。
 */
import { describe, it, expect } from 'vitest'
import { scanAddPrimary, scanAddSecondary, scanAddOrder } from '@myco/scanAddOrder'

describe('scanAddOrder · 手机形态（摄像头主 / 粘贴次）', () => {
  it('手机有摄像头：主通道 = 摄像头（举起就扫）', () => {
    expect(scanAddPrimary('phone', true)).toBe('camera')
  })

  it('手机无摄像头环境：从图片识别升主通道', () => {
    expect(scanAddPrimary('phone', false)).toBe('image')
  })

  it('手机次要通道恒为粘贴（折叠区，不抢摄像头主按钮）', () => {
    expect(scanAddSecondary('phone', true)).toEqual(['paste'])
    expect(scanAddSecondary('phone', false)).toEqual(['paste'])
  })

  it('手机完整排序：摄像头/图片在前，粘贴永远次要', () => {
    expect(scanAddOrder('phone', true)).toEqual(['camera', 'paste'])
    expect(scanAddOrder('phone', false)).toEqual(['image', 'paste'])
  })
})
