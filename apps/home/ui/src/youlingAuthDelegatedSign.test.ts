/**
 * 分身签名「进程内化」护栏（2026-10-11 用户实测事故 → 测试沉淀）
 *
 * 事故：成员设备（分身，本机无账号根钥）在 www.youling.cc 点「有灵账号登录」必然失败
 * （三段回落链全灭，用户看到「本机登录已过期」）。根因：UI 的分身签名回落仍 fetch
 * **env 时代遗留 HTTP** `http://127.0.0.1:3102/api/wallet_sign_delegated`——第63轮
 * 「env 合并入 myco.exe」后 3102 只剩 `/api/dshShare/*`，该路由已不存在（生产实测：
 * PC 与笔记本上 `POST /api/wallet_sign_delegated` 均 404，而 `/api/dshShare/list` 200）。
 * 同型漏网点此前已在 `auto_login_url` 上踩过一次（第63轮追修），这是第二处。
 *
 * 本护栏钉死三件事（读源码静态断言，同 cssCollision.test.ts 先例）：
 *  1) YoulingAuth.tsx 不得再出现指向 :3102 的钱包签名 HTTP 调用（env 已退役）；
 *  2) 分身签名必须走进程内 `invoke('wallet_sign_delegated')` 且随行 delegation；
 *  3) Rust 侧该命令已注册进 generate_handler（否则 invoke 必失败）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 直接读原文断言，但只匹配**代码形态**（不剥注释：解释性注释会引用死端点原文，
 *  用 `fetch(` 调用形态 / 带引号的命令名 / `const ENV2` 这类只可能出现在代码里的
 *  形状做判据，注释不会误伤）。 */
const UI_SRC = readFileSync(resolve(HERE, 'YoulingAuth.tsx'), 'utf8')
const LIB_RS = readFileSync(resolve(HERE, '../../src-tauri/src/lib.rs'), 'utf8')
const IDENTITY_RS = readFileSync(resolve(HERE, '../../src-tauri/src/identity_service.rs'), 'utf8')

describe('分身签名进程内化（env 退役漏网调用点护栏）', () => {
  it('YoulingAuth.tsx 不得再有指向 :3102 的 fetch 调用，也不得残留 ENV2 常量（env 已退役）', () => {
    // 代码形态判据（注释里引用原文不算）：fetch(...) 实参提到 3102/ENV2，或声明 ENV2 常量
    expect(UI_SRC).not.toMatch(/fetch\([^)]*3102/)
    expect(UI_SRC).not.toMatch(/fetch\([^)]*ENV2/)
    expect(UI_SRC).not.toMatch(/const\s+ENV2\b/)
  })

  it('分身签名走进程内 invoke 且随行 delegation', () => {
    expect(UI_SRC).toContain("'wallet_sign_delegated'")
    expect(UI_SRC).toContain('delegation: JSON.stringify(dj.delegation)')
    // 设备钥签名结果形态：{did, sig, delegation}
    expect(UI_SRC).toMatch(/dj\?\.did\s*&&\s*dj\?\.sig\s*&&\s*dj\?\.delegation/)
  })

  it('Rust 侧命令已实现并注册', () => {
    expect(IDENTITY_RS).toContain('pub fn wallet_sign_delegated(')
    expect(IDENTITY_RS).toContain('pub(crate) fn pick_valid_delegation(')
    expect(LIB_RS).toContain('identity_service::wallet_sign_delegated')
  })

  it('选状逻辑 fail-closed：无有效委任状时给"重新授权"提示而非静默', () => {
    expect(IDENTITY_RS).toContain('本机无有效设备授权（请在主设备上重新授权本设备）')
  })
})
