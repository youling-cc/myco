/**
 * open-retry.ts — 等待就绪的通用小工具。
 *
 * 2026-11-12：取票链（retryTransient 自动重试 / 旧卡自愈 pickHealTargets /
 * 收摊文案 finalOpenNote 等）随手机端取票链整链删除——VNETP 直入失败一律
 * 一次收摊、如实报因（dsh-open-runtime.openTaskShare）。本文件只剩仍在用的
 * `waitUntil`（waitForIdentityReady 的底层：身份从后台冻结恢复可能滞后几秒）。
 */

/**
 * 等到 `ready()` 为真，或超时（纯逻辑，可注入 sleep/now → 单测直击）。
 *
 * 返回**等了多久毫秒**（已经就绪 = 0）；超时返回 `null`。
 *
 * 为什么需要它（2026-10-16 真机真案）：手机 app 从"后台冻结"被唤醒时，WebView 的 JS
 * 恢复了但**身份还没加载完**（日志实证 `[relay-provider] 装配第 1 次未成：身份未就绪`）。
 * 开卡前先等一下（最多 6 秒，实测解冻后约 5 秒就绪），比失败后重试便宜得多。
 */
export async function waitUntil(
  ready: () => boolean,
  opts: {
    timeoutMs: number
    pollMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  },
): Promise<number | null> {
  const pollMs = opts.pollMs ?? 150
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = opts.now ?? (() => Date.now())
  const t0 = now()
  if (ready()) return 0
  while (now() - t0 < opts.timeoutMs) {
    await sleep(pollMs)
    if (ready()) return now() - t0
  }
  return null
}
