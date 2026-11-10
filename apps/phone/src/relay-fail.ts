/**
 * relay-fail.ts — 中继/隧道腿失败的**如实归因**（2026-10-16）。
 *
 * ## 为什么要有这个文件
 * 真机真案（2026-10-16 00:12，手机点任务卡）：
 *   取票链路里 `relayDeliverOnce` 原来把**所有**失败都吞成 `null`，上层再统一说
 *   「源设备不在线（或那台设备没有可直连的地址），稍后再试」。于是四种物理原因完全
 *   不同的事——云端中转卡槽满(BUSY) / 中转里没这台设备(NOT_FOUND) / 本机身份没就绪
 *   签名没过 / 取票超时——在用户眼里是同一句话，在两侧日志里都查不出真因（PC 侧审计
 *   连一条记录都没有，因为请求根本没走到签票逻辑）。
 *
 * ## 好消息：原生层早就分好类了，只是 JS 扔了
 * `RelayTunnel.java` 读中继应答行时就抛了人话异常：
 *   · `NOT_FOUND`   → 「对方设备不在线（云端中转无此设备）」
 *   · `BUSY`        → 「对方设备的云端通道忙，稍后再试」
 *   · `UNAVAILABLE` → 「对方设备没接上云端通道，稍后再试」
 * 本模块只做两件事：① 把这类异常文本归因成人话（纯函数，单测直击）；② 留痕"这一趟
 * 取票里中继腿**第一次**为什么失败"，供收摊文案取用（第一次 = 源设备那一台，最相关）。
 */

/** 中继/隧道腿失败归因。 */
export type RelayFailWhy =
  | 'busy' // 中继：目标并发通道满（BUSY）
  | 'missing' // 中继：目标没注册（NOT_FOUND）
  | 'unavailable' // 中继：SESSION 下发后 provider 没 ACCEPT（UNAVAILABLE）
  | 'unreachable' // 中继本身连不上（网络层/TCP）
  | 'timeout' // 隧道通了但没等到回包
  | 'auth' // 源设备在签名/鉴权这道闸就把请求挡了
  | 'denied' // 源设备明确回绝（带理由）
  | 'other'

export interface RelayFail {
  why: RelayFailWhy
  /** 直接给用户看的一句话（收摊文案取用）。 */
  note: string
  /** 原始细节（日志用，不对用户说）。 */
  detail: string
}

/**
 * 原生隧道层异常文本 → 归因（纯函数）。
 *
 * 认不出来的走 `other` 并把原文带上——**宁可粗糙也别再吞**（吞掉就是这次真案）。
 */
export function relayFailFromNative(msg: string): RelayFail {
  const m = msg || ''
  if (/BUSY|通道忙|并发.{0,4}满/.test(m)) {
    return { why: 'busy', note: '云端中转忙（源设备的并发通道已满），过几秒再点一次', detail: m }
  }
  if (/NOT_FOUND|中转无此设备|没看到那台设备/.test(m)) {
    return { why: 'missing', note: '云端中转里没看到源设备（它可能刚重启或没连上云），过十几秒再点一次', detail: m }
  }
  if (/UNAVAILABLE|没接上云端通道/.test(m)) {
    return { why: 'unavailable', note: '源设备的云端通道没接上（收到了但没应答），过几秒再点一次', detail: m }
  }
  if (/签名|身份|401|403|未授权|不允许/.test(m)) {
    return { why: 'auth', note: '本机身份还没就绪，签名没通过——重启一次 myco 再点', detail: m }
  }
  if (/超时|timeout|没回话|没有响应/i.test(m)) {
    return { why: 'timeout', note: '取票超时：源设备没回话，稍后再点一次', detail: m }
  }
  if (/中转|relay|连接|ECONNREFUSED|Network|不可达/i.test(m)) {
    return { why: 'unreachable', note: '连不上云端中转——先看看手机网络再点一次', detail: m }
  }
  return { why: 'other', note: '', detail: m }
}

/** 这一趟取票里中继腿的第一次失败（`null` = 没失败过/已清）。 */
let last: RelayFail | null = null

/**
 * 记一次中继腿失败。
 *
 * **只记第一次**（`relayDeliverOnce` 会按"源设备 → 其它同账号设备"逐台试，后面的失败
 * 是次要设备的，拿它给用户看会指错方向）。
 */
export function noteRelayFail(f: RelayFail): void {
  if (!last) last = f
}

/** 一趟取票开始时清空（`openTaskShareOnce` 调）。 */
export function clearRelayFail(): void {
  last = null
}

/** 最近一次中继腿失败（收摊文案用）。 */
export function lastRelayFail(): RelayFail | null {
  return last
}
