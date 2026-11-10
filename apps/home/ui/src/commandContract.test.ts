/**
 * 前端 `invoke` 命令名 ↔ Rust `generate_handler!` 注册表 —— 合同护栏
 * （2026-10-13 三起同类经验沉淀，全项目通用教训：**幽灵 invoke = 假按钮**）
 *
 * 事故一族（同一根因，症状全是"点了没反应"——因为调用点大多 `try/catch { /* ignore *\/ }` 静默吞）：
 *   ① MycoDevices 管理面 8 命令 home 应用从未实现 → 设备列表整块空白、按钮无反应；
 *   ② `remove_authorized_device` / `rename_authorized_device` / `revoke_roster_device`
 *      在 core 里只是普通函数（无 `#[tauri::command]`、未注册）→ 改名/除名三个按钮死；
 *   ③ `confirm_device` / `reject_device` / `pair_request_dismiss` / `identity_register_login`
 *      全仓 Rust 侧均未注册 → 配对申请卡「✓ 确认授权 / 拒绝 / ✕」三个动作死；
 *      YoulingAuth「创建有灵账户」第一步 `registerLogin` 必失败（用户看到"创建有灵账户失败"）。
 *
 * 判据（静态源码断言，同 cssCollision.test.ts / youlingAuthDelegatedSign.test.ts 先例）：
 *   UI 源码里 `invoke('x')` / `act('x')` 出现的每个命令名，必须在
 *   `apps/home/src-tauri/src/lib.rs` 的 `generate_handler![...]` 清单里。
 *
 * 误报防护：命令名辅助函数是白名单式的——目前只有 MycoDevices 的 `act(cmd, did)` 一个间接转发点。
 * 若将来新增同类辅助函数，请在此处补 pattern，**不要**为此放宽断言。
 *
 * 注：本文件 import `node:fs/path/url` 会带来 3 条 `TS2307 Cannot find module 'node:*'`
 * ——与 `cssCollision.test.ts` / `youlingAuthDelegatedSign.test.ts` **完全同款**（本仓未装
 * `@types/node`，读仓内源码类护栏都这样）。装机 `@types/node` 可一次性消掉这三处共 9 条。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB_RS = readFileSync(resolve(HERE, '../../src-tauri/src/lib.rs'), 'utf8')

/** 间接命令名转发点（helper 的第一个字符串实参就是命令名）。 */
const INDIRECT_HELPERS = ['act']

/** `generate_handler![a::b, c, ...]` → 命令名集合（取 `::` 最后一段，与 Tauri 命令名规则一致）。 */
export function registeredCommands(libRs: string): string[] {
  const m = libRs.match(/generate_handler!\[([\s\S]*?)\]\)/)
  if (!m) throw new Error('lib.rs 里找不到 generate_handler![...] —— 解析失败，护栏失效即报错')
  return m[1]
    .split(',')
    .map((s) => s.trim().split('::').pop()!.trim())
    .filter(Boolean)
}

const LITERAL_INVOKE = /\.invoke\s*(?:<[^>]*>)?\s*\(\s*'([A-Za-z0-9_]+)'/g

/** 递归收集 UI 源码里被调用的命令名（含间接 helper），跳过测试文件自身。 */
export function invokedCommands(srcDir: string): Map<string, string[]> {
  const found = new Map<string, string[]>()
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.tsx?$/.test(e.name)) continue
      if (/\.test\.tsx?$/.test(e.name)) continue // 测试自身会写命令名字符串，不自扫
      const raw = readFileSync(p, 'utf8')
      const rel = p.slice(srcDir.length + 1).replace(/\\/g, '/')
      const collect = (re: RegExp) => {
        re.lastIndex = 0
        for (let mm = re.exec(raw); mm; mm = re.exec(raw)) {
          const name = mm[1]
          const line = raw.slice(0, mm.index).split('\n').length
          const hits = found.get(name) ?? []
          hits.push(`${rel}:${line}`)
          found.set(name, hits)
        }
      }
      collect(LITERAL_INVOKE)
      for (const h of INDIRECT_HELPERS) collect(new RegExp(`${h}\\(\\s*'([A-Za-z0-9_]+)'`, 'g'))
    }
  }
  walk(srcDir)
  return found
}

const SRC_DIR = resolve(HERE)
const REGISTERED = registeredCommands(LIB_RS)
const INVOKED = invokedCommands(SRC_DIR)

describe('前端 invoke 命令 ↔ Rust 注册表 合同', () => {
  it('解析两边都没空转（护栏自身失效要报错，不许假绿）', () => {
    expect(REGISTERED.length).toBeGreaterThan(100)
    expect(INVOKED.size).toBeGreaterThan(40)
  })

  it('UI 调用的每个命令都已在 generate_handler 注册（幽灵 invoke = 假按钮）', () => {
    const missing = [...INVOKED.keys()].filter((n) => !REGISTERED.includes(n)).sort()
    const detail = missing.map((n) => `  ${n}  ←  ${[...new Set(INVOKED.get(n)!)] .join(', ')}`).join('\n')
    expect(missing, `未注册却被 UI 调用的命令：\n${detail}`).toEqual([])
  })

  it('三起事故的命令逐个钉死（防回归删除）', () => {
    // ① MycoDevices 管理面 8 条
    for (const n of [
      'list_authorized_devices',
      'list_trusted_roots',
      'resolve_myco_names',
      'rename_trusted_root',
      'set_root_note',
      'set_device_scopes',
      'set_device_auth',
      'revoke_origin',
    ]) expect(REGISTERED, `${n} 未注册`).toContain(n)
    // ② 改名/除名三条
    for (const n of ['rename_authorized_device', 'remove_authorized_device', 'revoke_roster_device'])
      expect(REGISTERED, `${n} 未注册`).toContain(n)
    // ③ 配对申请卡 + 深链创建账号
    for (const n of ['confirm_device', 'reject_device', 'pair_request_dismiss', 'identity_register_login'])
      expect(REGISTERED, `${n} 未注册`).toContain(n)
  })

  it('间接转发点（act）仍被巡逻到——漏掉它就是护栏盲区', () => {
    // act('reject_device') / act('confirm_device') 是事故③的一半；若这里读不到说明 pattern 失效
    expect([...INVOKED.keys()]).toContain('reject_device')
    expect([...INVOKED.keys()]).toContain('confirm_device')
  })
})
