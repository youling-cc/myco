/**
 * 客户端设备断言（2026-10-23，L7 授权发言人身份）。
 *
 * 背景：分享页里打字，网关此前用「票上的设备」署名（= 会话所属设备，通常是 PC），
 * 从手机打字也署名成 PC。用户要求署名必须是**实际打字设备**，且不能冒充 owner。
 *
 * 协议与 PC Rust `dsh_share.rs::with_client_assert` **逐字节一致**：
 *   payload = `myco-client|<shareId>|<did>|<ts>`          （shareId 来自 /gw/<id>/）
 *   fragment = #mycoClient=<did>&mycoClientName=<name>&mycoClientTs=<ts>&mycoClientSig=<b64url(sig)>
 * 页面注入脚本把 fragment 存 localStorage 并在同源 fetch 上加 x-myco-client 头；
 * 网关用 did 内嵌公钥验签，通过则用「设备名·did尾4」署名，失败/缺头回落旧行为。
 */
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512.js'
import { currentIdentity, type PhoneIdentity } from './identity'

// noble 2.x 的 sha512 后端（identity.ts 已注册；这里冗余保证本模块独立可用）
try {
  ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m))
  ed.etc.sha512Async = async (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m))
} catch {
  /* ignore */
}

/** 手机设备在署名里的显示名（与 did 尾4 组合成 `手机·DD9F`，一眼区别于 PC）。 */
const DEVICE_NAME = '手机'

const b64url = (u8: Uint8Array): string => {
  let s = ''
  for (const b of u8) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 从分享入口 URL 里取 share id（`/gw/<id>/...`）；不是分享入口 → null。 */
export function shareIdFromGw(url: string): string | null {
  const i = url.indexOf('/gw/')
  if (i < 0) return null
  const rest = url.slice(i + 4)
  const end = rest.search(/[/?#]/)
  const sid = end < 0 ? rest : rest.slice(0, end)
  return /^[A-Za-z0-9_-]+$/.test(sid) ? sid : null
}

/** 纯函数：用给定身份给分享入口 URL 追加断言 fragment（无身份 → 原样返回）。 */
export function withClientAssertFor(url: string, id: PhoneIdentity | null): string {
  const sid = shareIdFromGw(url)
  if (!sid || !id || !id.keyB64) return url
  try {
    const ts = Date.now()
    const payload = `myco-client|/gw/${sid}|${id.did}|${ts}`
    const seed = Uint8Array.from(atob(id.keyB64), (c) => c.charCodeAt(0))
    const sig = b64url(ed.sign(new TextEncoder().encode(payload), seed))
    const sep = url.includes('#') ? '&' : '#'
    return (
      url +
      sep +
      'mycoClient=' + encodeURIComponent(id.did) +
      '&mycoClientName=' + encodeURIComponent(DEVICE_NAME) +
      '&mycoClientTs=' + ts +
      '&mycoClientSig=' + encodeURIComponent(sig)
    )
  } catch {
    return url
  }
}

/** 运行时入口：用当前已加载的设备身份签名（身份未就绪 → 原样返回，回落旧行为）。 */
export function withClientAssert(url: string): string {
  try {
    return withClientAssertFor(url, currentIdentity())
  } catch {
    return url
  }
}

// ── E2E 调试钩子（2026-10-23）：真机自测署名链路用，不参与 UI ──
try {
  if (typeof window !== 'undefined') {
    const w = window as unknown as {
      __mycoClientAssert?: (url: string) => string
      __mycoClientHeader?: (url: string) => string | null
    }
    // 返回带断言的完整 URL
    w.__mycoClientAssert = (url: string) => withClientAssert(url)
    // 返回注入脚本要发到网关的 x-myco-client 头值（btoa(utf8(json))）
    w.__mycoClientHeader = (url: string) => {
      const signed = withClientAssert(url)
      const frag = signed.split('#')[1] || ''
      const q = new URLSearchParams(frag)
      const did = q.get('mycoClient') || ''
      if (!did) return null
      const obj = {
        did,
        name: q.get('mycoClientName') || '',
        ts: Number(q.get('mycoClientTs') || 0),
        sig: q.get('mycoClientSig') || '',
      }
      const bytes = new TextEncoder().encode(JSON.stringify(obj))
      let s = ''
      for (const b of bytes) s += String.fromCharCode(b)
      return btoa(s)
    }
  }
} catch {
  /* ignore */
}