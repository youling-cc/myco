import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import * as ed from '@noble/ed25519'
import {
  currentIdentity,
  deviceLogoutYouling,
  ensurePlainIdentity,
  logoutYouling,
  unbindYouling,
} from './identity'

/** 退出必须先使 currentIdentity 失效；否则 vnet-forward 的周期刷新会立即 re-arm。 */
describe('身份退出 → 原生隧道不可复活', () => {
  const keyB64 = btoa(String.fromCharCode(...ed.utils.randomPrivateKey()))
  const rootDid = 'did:youling:zThinNodeRevokeTest'
  let disarm: ReturnType<typeof vi.fn>

  beforeEach(() => {
    const store = new Map<string, string>()
    store.set('youling.vault', JSON.stringify({ mode: 'plain', keyB64, rootDid }))
    const ls = {
      get length() { return store.size },
      key(i: number) { return [...store.keys()][i] ?? null },
      getItem(k: string) { return store.get(k) ?? null },
      setItem(k: string, v: string) { store.set(k, v) },
      removeItem(k: string) { store.delete(k) },
    }
    vi.stubGlobal('localStorage', ls)
    disarm = vi.fn(() => '{"ok":true}')
    vi.stubGlobal('window', { MycoShell: { vnetRdpDisarm: disarm } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('unbind：currentIdentity 立即失效且只 disarm 一次', async () => {
    await ensurePlainIdentity()
    expect(currentIdentity()).not.toBeNull()
    unbindYouling()
    expect(currentIdentity()).toBeNull()
    expect(disarm).toHaveBeenCalledTimes(1)
  })

  it('logout：currentIdentity 立即失效且只 disarm 一次', async () => {
    await ensurePlainIdentity()
    expect(currentIdentity()).not.toBeNull()
    logoutYouling()
    expect(currentIdentity()).toBeNull()
    expect(disarm).toHaveBeenCalledTimes(1)
  })

  it('deviceLogout：currentIdentity 立即失效且只 disarm 一次', async () => {
    await ensurePlainIdentity()
    expect(currentIdentity()).not.toBeNull()
    deviceLogoutYouling()
    expect(currentIdentity()).toBeNull()
    expect(disarm).toHaveBeenCalledTimes(1)
  })
})
