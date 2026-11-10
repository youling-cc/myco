/**
 * backupMask PC 端断言 —— 备份恢复码遮蔽状态机（2026-10-01 用户实测整改：弹窗无退出通道+码明文晾屏）。
 * 被测实现单一源：packages/ui-kit/src/backupMask.ts（env/ui IdentityPanel 相对路径直引消费）。
 * 与 apps/phone/src/backupMask.test.ts 同源双锁（phone 经 @myco alias，此处经 workspace 包）。
 */
import { describe, it, expect } from 'vitest'
import {
  backupPanel, backupPanelInitial, backupIdleTimerOn, backupCopyTimerOn,
  BACKUP_MASK_IDLE_MS, BACKUP_MASK_AFTER_COPY_MS,
} from '@myco/ui-kit/backupMask'

const open = (seed = 'AAAA-BBBB-CCCC-DDDD') => backupPanel(backupPanelInitial, { type: 'open', seed })

describe('打开（open）——码可见、计时启动', () => {
  it('seed 填回 + 未遮蔽 + 空闲计时挂上', () => {
    const s = open()
    expect(s).toMatchObject({ open: true, seed: 'AAAA-BBBB-CCCC-DDDD', masked: false })
    expect(backupIdleTimerOn(s)).toBe(true)
  })
  it('初始态无计时（弹窗没开）', () => {
    expect(backupIdleTimerOn(backupPanelInitial)).toBe(false)
    expect(backupCopyTimerOn(backupPanelInitial)).toBe(false)
  })
})

describe('10s 无操作 → 自动遮蔽并清码（idle-timeout）', () => {
  it('遮蔽 + seed 清出内存 + copied 清零 + 两计时器全停', () => {
    const s = backupPanel(open(), { type: 'idle-timeout' })
    expect(s.masked).toBe(true)
    expect(s.seed).toBe('')                    // 码不再驻留内存/屏幕
    expect(s.copied).toBe(false)
    expect(s.open).toBe(true)                   // 弹窗还开着（遮蔽≠关闭）
    expect(backupIdleTimerOn(s)).toBe(false)
    expect(backupCopyTimerOn(s)).toBe(false)
  })
})

describe('复制后 3s → 自动遮蔽（copied / copy-timeout）', () => {
  it('复制成功不立即遮蔽（3s 缓冲给人离开屏幕的时间）', () => {
    const s = backupPanel(open(), { type: 'copied' })
    expect(s.masked).toBe(false)
    expect(s.copied).toBe(true)
    expect(backupCopyTimerOn(s)).toBe(true)
    expect(backupIdleTimerOn(s)).toBe(true)     // 10s 空闲计时仍挂着（先到先遮）
  })
  it('3s 到点遮蔽并清码', () => {
    const s = backupPanel(backupPanel(open(), { type: 'copied' }), { type: 'copy-timeout' })
    expect(s.masked).toBe(true)
    expect(s.seed).toBe('')
    expect(s.copied).toBe(false)
  })
})

describe('重新显示（reveal）——重导新码、重置 10s 计时', () => {
  it('遮蔽后 reveal：新码填回 + 未遮蔽 + revealSeq bump（组件计时器据此重挂）', () => {
    const masked = backupPanel(open('OLD-SEED'), { type: 'idle-timeout' })
    const s = backupPanel(masked, { type: 'reveal', seed: 'NEW-SEED' })
    expect(s).toMatchObject({ open: true, seed: 'NEW-SEED', masked: false, copied: false })
    expect(s.revealSeq).toBe(masked.revealSeq + 1)
    expect(backupIdleTimerOn(s)).toBe(true)     // 10s 计时重新启动
  })
})

describe('勾选交互（interact）——重置 10s 空闲计时、不是重显通道', () => {
  it('未遮蔽时勾选：计时重置（revealSeq bump），码保持显示', () => {
    const s0 = open()
    const s = backupPanel(s0, { type: 'interact' })
    expect(s.masked).toBe(false)
    expect(s.seed).toBe('AAAA-BBBB-CCCC-DDDD')
    expect(s.revealSeq).toBe(s0.revealSeq + 1)
  })
  it('已遮蔽时勾选：不动（重显必须走显式「重新显示」按钮）', () => {
    const masked = backupPanel(open(), { type: 'idle-timeout' })
    expect(backupPanel(masked, { type: 'interact' })).toBe(masked)   // 引用相等=原样返回
  })
})

describe('稍后备份（later）——安全退出：清码关窗', () => {
  it('码清空 + 弹窗关闭（不写已备份记号是组件层职责——账号页"未备份"徽标仍在）', () => {
    const s = backupPanel(open(), { type: 'later' })
    expect(s).toMatchObject({ open: false, seed: '', masked: false, copied: false })
  })
  it('遮蔽态下 later 同样干净退出', () => {
    const s = backupPanel(backupPanel(open(), { type: 'idle-timeout' }), { type: 'later' })
    expect(s.open).toBe(false)
    expect(s.seed).toBe('')
  })
})

describe('完成（finish）——清码关窗（记号/上云由组件层做）', () => {
  it('纯函数层与 later 同构：码不驻留', () => {
    const s = backupPanel(open(), { type: 'finish' })
    expect(s).toMatchObject({ open: false, seed: '' })
  })
})

describe('分身设备（noRoot）——提示态不参与遮蔽', () => {
  it('noRoot 打开：无码可遮，空闲计时不挂', () => {
    const s = backupPanel(backupPanelInitial, { type: 'open', seed: '', noRoot: true })
    expect(s.noRoot).toBe(true)
    expect(backupIdleTimerOn(s)).toBe(false)
  })
})

describe('遮蔽时限常量锁（防手滑改量级）', () => {
  it('10 秒无操作 / 复制后 3 秒', () => {
    expect(BACKUP_MASK_IDLE_MS).toBe(10_000)
    expect(BACKUP_MASK_AFTER_COPY_MS).toBe(3_000)
  })
})
