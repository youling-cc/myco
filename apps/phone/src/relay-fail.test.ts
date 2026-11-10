/**
 * relay-fail.test.ts — 中继腿失败**归因**的锁（2026-10-16 真案那一轮）。
 *
 * 锁两件事：
 *   ① 原生隧道层那几句异常文本（`RelayTunnel.java` 的应答分派）能被认出来，
 *      并各自归到**动作不同**的一类（卡槽满=等一下 / 没注册=等十几秒 / 签名没过=重启 app）；
 *   ② 认不出来也**不吞**（保留原文）——这次真案就是"吞掉"造成的：四种原因同一句话，
 *      两侧日志全空白，查了半天。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { relayFailFromNative, noteRelayFail, clearRelayFail, lastRelayFail } from './relay-fail'

describe('原生异常文本 → 归因', () => {
  // 下面三句是 RelayTunnel.java 的原话（NOT_FOUND / BUSY / UNAVAILABLE 三个应答行）
  it('BUSY（并发卡槽满）→ busy：过几秒再点', () => {
    const f = relayFailFromNative('对方设备的云端通道忙，稍后再试')
    expect(f.why).toBe('busy')
    expect(f.note).toContain('云端中转忙')
    expect(f.note).toContain('过几秒')
  })

  it('NOT_FOUND（中转里没这台设备）→ missing', () => {
    const f = relayFailFromNative('对方设备不在线（云端中转无此设备）')
    expect(f.why).toBe('missing')
    expect(f.note).toContain('没看到源设备')
  })

  it('UNAVAILABLE（SESSION 下发后没 ACCEPT）→ unavailable', () => {
    const f = relayFailFromNative('对方设备没接上云端通道，稍后再试')
    expect(f.why).toBe('unavailable')
    expect(f.note).toContain('没接上')
  })

  it('签名/身份没就绪 → auth：指向"重启一次 myco"', () => {
    const f = relayFailFromNative('身份未就绪')
    expect(f.why).toBe('auth')
    expect(f.note).toContain('myco')
  })

  it('超时 → timeout', () => {
    expect(relayFailFromNative('取票超时：源设备没回话').why).toBe('timeout')
  })

  it('认不出来也不吞：why=other 且保留原文', () => {
    const f = relayFailFromNative('某种没见过的新错误 xyz')
    expect(f.why).toBe('other')
    expect(f.detail).toBe('某种没见过的新错误 xyz')
  })
})

describe('留痕（收摊文案取用）', () => {
  beforeEach(() => clearRelayFail())

  it('只记第一次 —— 源设备那台优先，后续次要设备的失败不覆盖', () => {
    noteRelayFail(relayFailFromNative('对方设备的云端通道忙，稍后再试'))
    noteRelayFail(relayFailFromNative('对方设备不在线（云端中转无此设备）'))
    expect(lastRelayFail()?.why).toBe('busy')
  })

  it('clear 之后为空（每趟取票各一份）', () => {
    noteRelayFail(relayFailFromNative('BUSY'))
    clearRelayFail()
    expect(lastRelayFail()).toBeNull()
  })
})
