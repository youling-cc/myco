/**
 * scanAddOrder PC 端断言 —— 「扫码添加」tab 重排为 PC 优先形态（2026-09-30 设计定稿）的契约锁。
 * 被测实现单一源：packages/ui-kit/src/scanAddOrder.ts（MycoDevices.tsx 消费）。
 */
import { describe, it, expect } from 'vitest'
import { scanAddPrimary, scanAddSecondary, scanAddOrder } from '@myco/ui-kit/scanAddOrder'

describe('scanAddOrder · PC 形态（粘贴主 / 摄像头·图片次）', () => {
  it('PC 主通道恒为粘贴（与有无摄像头无关）', () => {
    expect(scanAddPrimary('pc', true)).toBe('paste')
    expect(scanAddPrimary('pc', false)).toBe('paste')
  })

  it('PC 有摄像头：次要 = 摄像头 + 从图片识别（摄像头在前）', () => {
    expect(scanAddSecondary('pc', true)).toEqual(['camera', 'image'])
  })

  it('PC 无摄像头：摄像头不显示，从图片识别作兜底保留', () => {
    expect(scanAddSecondary('pc', false)).toEqual(['image'])
    expect(scanAddSecondary('pc', false)).not.toContain('camera')
  })

  it('PC 完整排序：粘贴永远第一视觉焦点', () => {
    expect(scanAddOrder('pc', true)).toEqual(['paste', 'camera', 'image'])
    expect(scanAddOrder('pc', false)).toEqual(['paste', 'image'])
  })
})
