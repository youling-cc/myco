import { describe, it, expect } from 'vitest'
import { approvalSteps, resolveHarness } from './FineState'

// ════════════════════════════════════════════════════════════════
// J32: 三 harness 审批按键序列对比
// ════════════════════════════════════════════════════════════════
describe('J32: approvalSteps — 三 harness 审批按键序列', () => {
  describe('Claude Code', () => {
    it('批准 = 数字 1 + Enter（两步）', () => {
      const steps = approvalSteps('claude', true)
      expect(steps).toEqual([{ text: '1' }, { key: 'enter' }])
      expect(steps).toHaveLength(2)
    })
    it('拒绝 = 数字 3 + Enter（两步）', () => {
      const steps = approvalSteps('claude', false)
      expect(steps).toEqual([{ text: '3' }, { key: 'enter' }])
      expect(steps).toHaveLength(2)
    })
  })

  describe('Kimi Code', () => {
    it('批准 = 数字 1 直选（单步，无 Enter）', () => {
      const steps = approvalSteps('kimi', true)
      expect(steps).toEqual([{ text: '1' }])
      expect(steps).toHaveLength(1)
    })
    it('拒绝 = 数字 3 直选（单步，无 Enter）', () => {
      const steps = approvalSteps('kimi', false)
      expect(steps).toEqual([{ text: '3' }])
      expect(steps).toHaveLength(1)
    })
    it('与 Claude 的关键差异：无 Enter 步骤', () => {
      const kimiSteps = approvalSteps('kimi', true)
      const claudeSteps = approvalSteps('claude', true)
      expect(kimiSteps.length).toBeLessThan(claudeSteps.length)
      expect(kimiSteps.some(s => s.key === 'enter')).toBe(false)
    })
  })

  describe('Codex', () => {
    it('批准 = y + Enter（两步）', () => {
      const steps = approvalSteps('codex', true)
      expect(steps).toEqual([{ text: 'y' }, { key: 'enter' }])
      expect(steps).toHaveLength(2)
    })
    it('拒绝 = n + Enter（两步）', () => {
      const steps = approvalSteps('codex', false)
      expect(steps).toEqual([{ text: 'n' }, { key: 'enter' }])
      expect(steps).toHaveLength(2)
    })
    it('与 Claude 的关键差异：用 y/n 而非数字', () => {
      const codexApprove = approvalSteps('codex', true)
      const claudeApprove = approvalSteps('claude', true)
      expect(codexApprove[0].text).toBe('y')
      expect(claudeApprove[0].text).toBe('1')
    })
  })
})

// ════════════════════════════════════════════════════════════════
// J33: resolveHarness — appType/command 映射
// ════════════════════════════════════════════════════════════════
describe('J33: resolveHarness — appType 优先、command 回落', () => {
  describe('appType 直映', () => {
    it('claude_code → claude', () => {
      expect(resolveHarness('claude_code')).toBe('claude')
    })
    it('kimi_code → kimi', () => {
      expect(resolveHarness('kimi_code')).toBe('kimi')
    })
    it('codex → codex', () => {
      expect(resolveHarness('codex')).toBe('codex')
    })
    it('大小写不敏感: CLAUDE_CODE → claude', () => {
      expect(resolveHarness('CLAUDE_CODE')).toBe('claude')
    })
  })

  describe('command 回落（appType 为空时）', () => {
    it('command 含 claude → claude', () => {
      expect(resolveHarness(null, 'claude-code --model glm')).toBe('claude')
    })
    it('command 含 kimi → kimi', () => {
      expect(resolveHarness(null, 'kimi-code')).toBe('kimi')
    })
    it('command 含 codex → codex', () => {
      expect(resolveHarness(null, 'codex --provider')).toBe('codex')
    })
  })

  describe('appType 覆盖 command', () => {
    it('appType=kimi_code 覆盖 command 含 claude', () => {
      // 项目 B 用 Kimi，但 command 字段残留 claude 相关字
      expect(resolveHarness('kimi_code', 'claude-something')).toBe('kimi')
    })
    it('appType=codex 覆盖 command 含 kimi', () => {
      expect(resolveHarness('codex', 'kimi-something')).toBe('codex')
    })
  })
})

// ════════════════════════════════════════════════════════════════
// J34: 未知 harness 默认审批分派
// ════════════════════════════════════════════════════════════════
describe('J34: 未知 harness 默认行为', () => {
  it('resolveHarness unknown → unknown', () => {
    expect(resolveHarness(null, 'opencode')).toBe('unknown')
    expect(resolveHarness('', '')).toBe('unknown')
    expect(resolveHarness(null, undefined)).toBe('unknown')
  })

  it('approvalSteps unknown → 走 claude 默认（1+Enter）', () => {
    const steps = approvalSteps('unknown', true)
    expect(steps).toEqual([{ text: '1' }, { key: 'enter' }])
  })

  it('approvalSteps unknown reject → 走 claude 默认（3+Enter）', () => {
    const steps = approvalSteps('unknown', false)
    expect(steps).toEqual([{ text: '3' }, { key: 'enter' }])
  })

  it('approvalSteps 空字符串 → 走 default（claude）', () => {
    const steps = approvalSteps('', true)
    expect(steps[0].text).toBe('1')
    expect(steps).toHaveLength(2)
  })
})
