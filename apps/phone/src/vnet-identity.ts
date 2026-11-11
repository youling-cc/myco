/**
 * vnet-identity.ts — 把本机设备身份注入 libvnet（2026-11-11，手机→PC 数据面不通的最后一层）。
 *
 * 背景（真机实证链）：
 *   1. PC 侧 `MYCO_PEER_IDENTITY=1` 后，入站**未认证**的 vnet 流一律
 *      `AUTH_REQUIRED` 拒绝（vnet 源码注释原文：「未认证 peer 的流一律
 *      AUTH_REQUIRED 拒绝」）。
 *   2. 手机只起 client、从不注入身份 → 本地回环口能建、TCP 能连、请求字节发出去
 *      就再无下文。宿主看到的只是 `HttpURLConnection` 10s 读超时，或
 *      `unexpected end of stream`——两个现象都不指向真因。
 *   3. 修法：起任何 vnet client 之前调 `MycoShell.vnetSetLocalIdentity(did, seedB64)`，
 *      libvnet 随后每条流都会先发 AUTH 帧（`identity::build_auth_frame`）。
 *
 * 私钥边界：seed 只从 localStorage 读到内存、经 JNI 字符串交给 libvnet，
 * 不落盘、不进日志、不进任何上报。
 *
 * 幂等：注入成功一次即置位；失败允许下一拍重试（身份可能还没就绪）。
 */

type ShellWithIdentity = {
  vnetSetLocalIdentity?: (did: string, seedB64: string) => string
  vnetHasLocalIdentity?: () => boolean
  myDeviceDid?: () => string
}

let injected = false
let lastError = ''

function shell(): ShellWithIdentity | null {
  try {
    return ((window as unknown as { MycoShell?: ShellWithIdentity }).MycoShell) ?? null
  } catch {
    return null
  }
}

/** 读本机设备 seed（base64）。取不到返回 ''（不报错——身份可能还没落盘）。 */
function deviceSeedB64(): string {
  try {
    const raw = localStorage.getItem('youling.vault')
    if (!raw) return ''
    const v = JSON.parse(raw) as { keyB64?: string }
    return typeof v.keyB64 === 'string' ? v.keyB64 : ''
  } catch {
    return ''
  }
}

/** 本机设备 DID：Java 桥是权威（vault 里没有 rootDid，2026-11-11 踩过）。 */
function deviceDid(s: ShellWithIdentity): string {
  try {
    const d = s.myDeviceDid ? s.myDeviceDid() : ''
    if (typeof d === 'string' && d.length > 8) return d
  } catch {
    /* ignore */
  }
  return ''
}

/**
 * 确保 libvnet 已拿到本机身份。返回 true = 已注入（或本就在注入态）。
 * 非 APK 形态（浏览器/PWA、单测）没有该桥 → 直接返回 false，不抛。
 */
export function ensureVnetIdentity(): boolean {
  if (injected) return true
  const s = shell()
  if (!s || typeof s.vnetSetLocalIdentity !== 'function') return false
  // 已经注入过（进程内别处调过）就直接认
  try {
    if (typeof s.vnetHasLocalIdentity === 'function' && s.vnetHasLocalIdentity()) {
      injected = true
      return true
    }
  } catch {
    /* ignore */
  }
  const did = deviceDid(s)
  const seed = deviceSeedB64()
  if (!did || !seed) {
    lastError = 'device did/seed 未就绪'
    return false
  }
  try {
    const r = s.vnetSetLocalIdentity(did, seed)
    injected = r === 'ok'
    lastError = injected ? '' : String(r)
  } catch (e) {
    lastError = String(e)
  }
  if (injected) console.log(`[vnet-id] 本机身份已注入 libvnet（…${did.slice(-4)}）`)
  else console.log(`[vnet-id] 身份注入失败：${lastError}`)
  return injected
}

/** 诊断用（"为什么流被拒"时第一眼看这里）。 */
export function vnetIdentityState(): { injected: boolean; err: string } {
  return { injected, err: lastError }
}

/** 单测/热重载复位。 */
export function _resetVnetIdentityForTest(): void {
  injected = false
  lastError = ''
}
