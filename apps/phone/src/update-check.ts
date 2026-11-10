/**
 * update-check.ts —— 手机端 myco 自更新（V15，2026-10-22）
 *
 * 背景：Java 桥 `MycoShell.downloadApkUpdate(url, fileName)` 已实现（DownloadManager
 * + 下完自动弹安装意图），但下载需要一个**系统 DownloadManager 可达的本地 URL**。
 * 手机 JS 的隧道是 client socket（无本地监听），所以这里复用分享页那套
 * `startLocalListener + TunnelProxy`：本地起个口，把到 PC 网关 :13911 的隧道
 * 代理成本地 HTTP，就能 `GET http://127.0.0.1:<口>/myco-update/latest.json`，
 * 并把 APK 地址交给 Java 桥下载。
 *
 * 安全/稳定性红线（自更新绝不能影响主流程）：
 *   · 只在这些条件全满足时跑：App 可见 + 已启动 ≥30s + 24h 一次 + 桥方法齐全 + native 代理可用
 *   · 全程 try/catch + 超时；任何异常静默返回 status，不抛到上层
 *   · 本地监听与分享页共用原生单口 → 失败（被占用）就跳过，不抢
 */
import { currentIdentity, getRootIdentity, getAttestation, listPresence, signFriendHandshake } from './identity'
import { signWithDeviceKey } from './delegation'
import { relayCandidate, buildCandidates } from './p2p-tunnel'
import { TunnelProxy, memKv, type TunnelKv } from './tunnel-session'
import { startLocalListener, stopLocalListener, isLocalListenerRunning, nativeProxyDeps, hasNativeProxy } from './native-proxy'
import { taskShareState } from './dsh-open-runtime'

const GW_PORT = 13911
const LAST_KEY = 'myco.update.lastCheckAt'
const THROTTLE_MS = 24 * 3600 * 1000
const PROXY_KEEP_MS = 15 * 60 * 1000

/** 版本号比较：latest > current 才更新（支持 0.3.145 / 1.2 / 1.2.3 形式）。纯函数，单测直击。 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] =>
    String(v || '')
      .split(/[.+-]/)
      .map((x) => parseInt(x, 10))
      .filter((x) => Number.isFinite(x))
  const a = parse(latest)
  const b = parse(current)
  if (!a.length) return false
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

/** 从 presence 节点里挑同账号 PC 设备（排除自己；kind=pc/desktop）。纯函数，单测直击。 */
export function pickPcDevices(
  nodes: Array<Record<string, unknown>> | null | undefined,
  myDevice: string,
): Array<Record<string, unknown>> {
  return (nodes || []).filter((n) => {
    const did = String(n?.did || '')
    const kind = String(n?.kind || '')
    return did && did !== myDevice && (kind === 'pc' || kind === 'desktop')
  })
}

/** 是否该跑检查：需可见 + 未被节流。纯函数，单测直击。 */
export function shouldCheckNow(opts: {
  force?: boolean
  visibility: string
  lastCheckAt: number
  now: number
  throttleMs?: number
}): boolean {
  if (opts.force) return true
  if (opts.visibility !== 'visible') return false
  const throttle = opts.throttleMs ?? THROTTLE_MS
  return opts.now - (opts.lastCheckAt || 0) >= throttle
}

export interface UpdateCheckResult {
  status: string
  current?: string
  latest?: string
  downloaded?: boolean
  error?: string
}

interface Shell {
  getVersionName?: () => string
  downloadApkUpdate?: (url: string, fileName: string) => void
}

function shell(): Shell | null {
  const s = (window as unknown as { MycoShell?: Shell }).MycoShell
  return s && typeof s === 'object' ? s : null
}

function tunnelIdentity(account: string, device: string) {
  return {
    account,
    device,
    sign: (m: string) => {
      const sync = signFriendHandshake(m)
      return sync ? Promise.resolve(sync) : signWithDeviceKey(m)
    },
  }
}

async function fetchText(url: string, timeoutMs = 8000): Promise<string | null> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    const r = await fetch(url, { cache: 'no-store', signal: ctl.signal })
    clearTimeout(t)
    if (!r.ok) return null
    return await r.text()
  } catch {
    return null
  }
}

/**
 * 检查并（可选）触发下载。force=true 忽略节流（调试/取证用）。
 * 返回 status：
 *   unsupported-apk | throttled | hidden | no-native | no-identity | no-account
 *   no-pc | listener-busy | no-manifest | up-to-date | downloading | error
 */
export async function checkForUpdate(force = false): Promise<UpdateCheckResult> {
  const sh = shell()
  try {
    if (!sh?.getVersionName || !sh?.downloadApkUpdate) return { status: 'unsupported-apk' }
    const current = String(sh.getVersionName() || '')
    const last = Number(localStorage.getItem(LAST_KEY) || 0) || 0
    if (!shouldCheckNow({ force, visibility: document.visibilityState, lastCheckAt: last, now: Date.now() })) {
      return { status: document.visibilityState !== 'visible' ? 'hidden' : 'throttled', current }
    }
    // 分享页活跃时**不抢**原生本地口（startLocalListener 是单例；抢了会把页面隧道顶掉）
    try {
      const st = String(taskShareState() || '')
      if (st && st !== 'idle' && st !== 'closed') return { status: 'share-active', current }
    } catch { /* ignore */ }
    localStorage.setItem(LAST_KEY, String(Date.now()))
    if (!hasNativeProxy()) return { status: 'no-native', current }

    const id = currentIdentity()
    const device = id?.did || ''
    if (!device) return { status: 'no-identity', current }
    const account = getRootIdentity() || getAttestation()?.rootDid || ''
    if (!account) return { status: 'no-account', current }

    // 找同账号 PC（kind=pc）——手机 → PC 的中继/直连腿都依赖它
    // （`listPresence()` 返回 PresenceNode[]，与 pickPcDevices 的宽松 Record 口径之间
    //  差一个索引签名；这里只做类型桥接，运行期形状不变。）
    const nodes = (await listPresence().catch(() => [])) as unknown as Array<Record<string, unknown>>
    const pcs = pickPcDevices(nodes, device)
    if (!pcs.length) return { status: 'no-pc', current }

    // 共享监听所有权：更新检查只能停“自己这次启动的监听”，
    // 绝不能把主流程/分享页已开着的本地口停掉（黑盒生命周期）。
    const wasRunning = isLocalListenerRunning()
    const stopIfOwned = () => { if (shouldStopOwnedListener(wasRunning)) stopLocalListener() }

    let localPort = 0
    try {
      localPort = await startLocalListener()
    } catch (e) {
      return { status: 'listener-busy', current, error: e instanceof Error ? e.message : String(e) }
    }
    if (!(localPort > 0)) return { status: 'listener-busy', current }

    const target = pcs[0]
    const targetDid = String(target.did)
    const addrs = (target.addrs || {}) as Record<string, unknown>
    const candidates = buildCandidates(addrs as never, null)
    // 中继腿必加（手机→PC 中继已验证可用；国内跨网最稳）
    candidates.push(relayCandidate(targetDid))
    const { factory, bridge } = nativeProxyDeps()
    const kv: TunnelKv = memKv()
    let proxy: TunnelProxy | null = null
    const started = Date.now()
    try {
      proxy = new TunnelProxy({
        candidates,
        targetPort: GW_PORT,
        identity: tunnelIdentity(account, device),
        factory,
        bridge,
        kv,
        cacheKey: 'myco.update.proxy',
        targetName: String(target.name || 'PC'),
        onStatus: () => undefined,
        refreshCandidates: () => candidates,
      })
      proxy.start()
    } catch (e) {
      try { stopIfOwned() } catch { /* ignore */ }
      return { status: 'error', current, error: e instanceof Error ? e.message : String(e) }
    }

    // 等隧道就绪（本地口 → 网关）：轮询 latest.json，最多 12s
    const base = `http://127.0.0.1:${localPort}`
    let manifest: string | null = null
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) {
      manifest = await fetchText(`${base}/myco-update/latest.json`, 4000)
      if (manifest) break
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!manifest) {
      try { proxy?.stop?.() } catch { /* ignore */ }
      try { stopIfOwned() } catch { /* ignore */ }
      return { status: 'no-manifest', current }
    }
    let latest = ''
    try {
      latest = String((JSON.parse(manifest) as { versionName?: string }).versionName || '')
    } catch { /* ignore */ }
    if (!latest) {
      try { proxy?.stop?.() } catch { /* ignore */ }
      try { stopIfOwned() } catch { /* ignore */ }
      return { status: 'no-manifest', current }
    }
    if (latest === current) {
      try { proxy?.stop?.() } catch { /* ignore */ }
      try { stopIfOwned() } catch { /* ignore */ }
      return { status: 'up-to-date', current, latest }
    }
    // 有新版本 → 交 Java 桥下载（DownloadManager 走同一本地口；下完自动弹安装）
    try {
      sh.downloadApkUpdate(`${base}/myco-update/myco-phone.apk`, 'myco-phone.apk')
    } catch (e) {
      return { status: 'error', current, latest, error: e instanceof Error ? e.message : String(e) }
    }
    // 下载期间保持代理（APK ~2.9MB，经中继 ~秒级）；15 分钟后收（防泄漏）
    setTimeout(() => {
      try { proxy?.stop?.() } catch { /* ignore */ }
      try { stopIfOwned() } catch { /* ignore */ }
    }, PROXY_KEEP_MS)
    return { status: 'downloading', current, latest, downloaded: true, error: `elapsed=${Date.now() - started}ms` }
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}

/** 共享监听的所有权判定：只有“调用前没有监听”才允许调用方收尾。 */
export function shouldStopOwnedListener(wasRunning: boolean): boolean {
  return !wasRunning
}

/** 供 adb / EnvServer eval 取证（window.__mycoUpdateCheck()）。 */
export function installUpdateBridge(): void {
  try {
    ;(window as unknown as Record<string, unknown>).__mycoUpdateCheck = (force?: boolean) =>
      checkForUpdate(!!force)
  } catch { /* ignore */ }
}
