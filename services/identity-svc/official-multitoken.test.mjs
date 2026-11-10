// official-multitoken.test.mjs — 多 token 契约回归（2026-11-07 经验沉淀）
//
// 事故：`official-token.txt` 自 2026-10-24 起是「每行一个 token」多 token 契约
// （official.mjs readTokens：忽略空行 / # 注释），但 `/relay/stats` 仍按整文件 trim() 当
// 单 token 比较。2026-10-25 06:49 生产文件追加第二枚 token（supply-ops）后，got/want 长度
// 永远不等（HTTP 头不可能带换行）⇒ 恒 403 ⇒ 中转会话/带宽指标自 10-25 06:49 起恒 no_data
// （13 天监控盲区），2026-11-07 14:53 修复。官方通道 /official/* 因为走 tokenOk 全程正常 ——
// 即故障面只在「复用了同一个文件却自己写了一套比较」的那条路由。
//
// 本文件锁死两件事：① 多 token 文件里每一枚都能过 tokenOk；② /relay/stats 确实复用 tokenOk。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOfficialApi } from './official.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// 形如事故现场的两枚 token（形状一致，值全为测试假值，不入真实密钥）
const LEGACY64 = 'a'.repeat(64)
const SUPPLY = 'supply-ops-test-token'

const dirs = []
test.after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* */ } } })

function mkApiWithTokenFile(lines) {
  const d = mkdtempSync(join(tmpdir(), 'myco-mtok-')); dirs.push(d)
  writeFileSync(join(d, 'official-token.txt'), lines.join('\n') + '\n')
  return { dir: d, api: createOfficialApi({ dir: d }) }
}

test('多 token 文件：每一枚 token 都能过 tokenOk（不再整文件比较）', () => {
  const prev = process.env.MYCO_OFFICIAL_TOKEN
  delete process.env.MYCO_OFFICIAL_TOKEN
  try {
    const { api } = mkApiWithTokenFile(['# 注释行不算 token', '', LEGACY64, SUPPLY])
    assert.equal(api.tokenOk(LEGACY64), true, '第一行 token 必须能过（旧实现此处恒 false）')
    assert.equal(api.tokenOk(SUPPLY), true, '第二行 token 必须能过（旧实现此处恒 false）')
    assert.equal(api.stats().tokenConfigured, true)
  } finally {
    if (prev !== undefined) process.env.MYCO_OFFICIAL_TOKEN = prev
  }
})

test('旧实现 bug 的签名：整文件连读 / 空 / 错 token 一律拒绝', () => {
  const prev = process.env.MYCO_OFFICIAL_TOKEN
  delete process.env.MYCO_OFFICIAL_TOKEN
  try {
    const { dir, api } = mkApiWithTokenFile(['', LEGACY64, SUPPLY])
    const whole = readFileSync(join(dir, 'official-token.txt'), 'utf8').trim()
    assert.equal(api.tokenOk(whole), false, '含换行的整文件值永远不可能出现在 HTTP 头里')
    assert.equal(api.tokenOk(''), false)
    assert.equal(api.tokenOk(undefined), false)
    assert.equal(api.tokenOk('nope'), false)
    assert.equal(api.tokenOk(LEGACY64 + 'x'), false, '长度不同不得过')
  } finally {
    if (prev !== undefined) process.env.MYCO_OFFICIAL_TOKEN = prev
  }
})

test('单 token 文件（老格式）行为不变', () => {
  const prev = process.env.MYCO_OFFICIAL_TOKEN
  delete process.env.MYCO_OFFICIAL_TOKEN
  try {
    const { api } = mkApiWithTokenFile([LEGACY64])
    assert.equal(api.tokenOk(LEGACY64), true)
    assert.equal(api.tokenOk(SUPPLY), false)
  } finally {
    if (prev !== undefined) process.env.MYCO_OFFICIAL_TOKEN = prev
  }
})

test('/relay/stats 路由必须复用 officialApi.tokenOk（防再次回归成整文件比较）', () => {
  const src = readFileSync(join(__dirname, 'identity-server.mjs'), 'utf8')
  const i = src.indexOf("url.pathname === '/relay/stats'")
  assert.ok(i > 0, 'identity-server.mjs 里找不到 /relay/stats 路由')
  const block = src.slice(i, i + 1400)
  assert.match(block, /officialApi\.tokenOk\(/, '/relay/stats 必须走官方通道同一份 token 校验')
  assert.doesNotMatch(
    block,
    /readFileSync\(resolve\(__dirname, 'official-token\.txt'\)/,
    '不得回退成「整文件 trim() 当单 token」比较（2026-10-25~11-07 生产盲区根因）',
  )
})
