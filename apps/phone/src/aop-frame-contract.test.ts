/**
 * AopFrame 帧契约测试(Rust↔TS 双侧同读 tests/contract/aop-frame.json):
 * - Rust 侧:apps/canvas/src-tauri/src/labs/frames.rs #[cfg(test)] contract_samples_all_parse
 * - TS 侧(本文件):字段 camelCase 齐备、executorKind/kind 枚举合法、from 为 DID。
 * 帧语义:o/s/a/r 四元组 + 归属(slug/layer/attempt/executorKind/kind/at/from)。
 */
import { describe, it, expect } from 'vitest'
// phone 不声明 node 依赖(@types/node 未装、不为此加依赖);vitest 跑在 node 运行时,
// 'node:fs' 运行时可用,tsc -b 找不到类型声明 → @ts-ignore 压制(仅测试文件,不入构建产物)。
// @ts-ignore
import { readFileSync } from 'node:fs'

/** 契约文件相对本测试文件:apps/phone/src → 仓库根 tests/contract/。 */
const contractUrl = new URL('../../../tests/contract/aop-frame.json', import.meta.url)
const frames = JSON.parse(readFileSync(contractUrl, 'utf-8')) as Array<Record<string, unknown>>

/** 每条帧必须含的 camelCase 键(from 为可选兼容键,单列断言)。 */
const REQUIRED_KEYS = [
  'sessionId', 'slug', 'layer', 'attempt', 'executorKind', 'kind',
  'o', 's', 'a', 'r', 'at',
] as const

const EXECUTOR_KINDS = ['agent', 'human', 'remote']
const FRAME_KINDS = ['tool', 'eval', 'human', 'note']

describe('AopFrame 契约(tests/contract/aop-frame.json)', () => {
  it('至少 5 条样例帧', () => {
    expect(Array.isArray(frames)).toBe(true)
    expect(frames.length).toBeGreaterThanOrEqual(5)
  })

  it('每条帧含全部必填 camelCase 键,且枚举值合法', () => {
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]
      for (const key of REQUIRED_KEYS) {
        expect(f, `第 ${i} 条缺键 ${key}`).toHaveProperty(key)
      }
      expect(EXECUTOR_KINDS, `第 ${i} 条 executorKind 非法`).toContain(f.executorKind)
      expect(FRAME_KINDS, `第 ${i} 条 kind 非法`).toContain(f.kind)
      // 关键字段非空(sessionId/slug/layer/at 是帧的最低自含性)
      expect(String(f.sessionId).length, `第 ${i} 条 sessionId 为空`).toBeGreaterThan(0)
      expect(String(f.slug).length, `第 ${i} 条 slug 为空`).toBeGreaterThan(0)
      expect(String(f.layer).length, `第 ${i} 条 layer 为空`).toBeGreaterThan(0)
      expect(String(f.at).length, `第 ${i} 条 at 为空`).toBeGreaterThan(0)
      expect(Number.isInteger(f.attempt), `第 ${i} 条 attempt 应为整数`).toBe(true)
    }
  })

  it('from 可选:出现时必须是 did: 前缀的 DID', () => {
    for (let i = 0; i < frames.length; i++) {
      const from = frames[i].from
      if (from !== undefined) {
        expect(String(from).startsWith('did:'), `第 ${i} 条 from 非 DID`).toBe(true)
      }
    }
    // 契约要求:含 from 与不含 from 的样例必须各有(serde default 兼容旧 traces)
    expect(frames.some((f) => f.from !== undefined)).toBe(true)
    expect(frames.some((f) => f.from === undefined)).toBe(true)
  })

  it('四种 kind(tool/eval/human/note)全覆盖', () => {
    const kinds = new Set(frames.map((f) => String(f.kind)))
    for (const k of FRAME_KINDS) {
      expect(kinds.has(k), `契约缺 ${k} 样例`).toBe(true)
    }
  })
})
