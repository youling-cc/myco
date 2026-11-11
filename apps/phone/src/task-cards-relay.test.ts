/**
 * task-cards-relay.test.ts — 2026-11-11 任务卡断流根修的回归锚点。
 *
 * 真因：PC myco 切 vnet 传输模式后 p2p 数据面只绑 127.0.0.1:9100
 * （p2p_server.rs bind_for_mode），手机直连 IPv6 候选必败 → 设备群
 * task-share 卡拉不到 → 任务卡列表空。修法：对账（/p2p/sync/*）补中继兜底
 * （与 /p2p/msg 的 relayDeliver 同一条 8321 mux 梯子）。
 *
 * 本文件锁三份契约：
 *  ① p2p.ts：sync 三端点走 p2pPostSync（直连失败/无地址 → relay 钩子）；
 *    peerDevicesOf 有 includeAddrless 选项（对账设备清单不过滤无地址设备）。
 *  ② dsh-open-runtime.ts：wireChatRelayFallback 注入 setRelayP2pPost。
 *  ③ adb-share.ts：本机 ADB 卡识别（findAdbCard 只认 env kind=adb 且
 *    device=本机设备的卡——别人的 adb 卡不误判）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { findAdbCard, ADB_TARGET_PORT } from './adb-share'
import type { PeerTask } from './chat-store'
import { fnBodyOf } from './test-support/fn-body'

describe('源码合同：对账三端点全部走中继兜底版 p2pPostSync', () => {
  const src = readFileSync(new URL('./p2p.ts', import.meta.url), 'utf8')
  const body = fnBodyOf(src, 'syncWithDeviceInner')

  it('digest/index/batch 三处调用都是 p2pPostSync（直连版 p2pPost 不得回归）', () => {
    expect(body).toContain("p2pPostSync(dev, '/p2p/sync/digest'")
    expect(body).toContain("p2pPostSync(dev, '/p2p/sync/index'")
    expect(body).toContain("p2pPostSync(dev, '/p2p/sync/batch'")
    expect(body).not.toContain("p2pPost(dev, '/p2p/sync/")
  })

  it('p2pPostSync：直连成功不碰兜底；直连失败/无地址 → vnet 隧道（两级；8321 中继已删）', () => {
    const fn = fnBodyOf(src, 'p2pPostSync')
    expect(fn).toContain('p2pPost(dev, path, body)')
    expect(fn).toContain('dev.addrs.length > 0') // 无地址设备直接走兜底
    expect(fn).toContain('vnetP2pTunnel(dev.did)')
    expect(fn).toContain('p2pPostViaVnet(localPort, path, body)')
    // 2026-11-11 DSH协议应用 复核：PC 侧 relay_provider_start 已退场为空壳
    //（p2p_tunnel.rs:6436，2026-11-06 legacy 退场令），8321 中继腿永远超时——
    // 对账路径不得再走它（白等 2.5s/台 拖慢 60s 对账拍）。
    expect(fn).not.toContain('relayP2pPost')
    expect(src).not.toContain('setRelayP2pPost')
  })

  it('p2pPostViaVnet：127.0.0.1 本地口 + X-Myco-Auth 签名头（与直连同款）', () => {
    const fn = fnBodyOf(src, 'p2pPostViaVnet')
    expect(fn).toContain('http://127.0.0.1:${localPort}${path}')
    expect(fn).toContain("'X-Myco-Auth'")
    expect(fn).toContain('signAuthHeader(raw)')
  })

  it('peerDevicesOf 支持 includeAddrless（对账专用；deliver 默认行为不变）', () => {
    expect(src).toContain('opts: { includeAddrless?: boolean } = {}')
    expect(src).toContain('opts.includeAddrless || d.addrs.length > 0')
    // 对账设备清单带 includeAddrless
    const syncAcc = fnBodyOf(src, 'syncWithAccount')
    expect(syncAcc).toContain('includeAddrless: true')
  })
})

describe('源码合同：装配层注入对账 vnet 隧道（异步桥）', () => {
  it('wireChatRelayFallback 里 setVnetP2pTunnel 接 ensureSyncTunnelFor；走 p2pTunnelEnsureAsync 异步桥', () => {
    const src = readFileSync(new URL('./dsh-open-runtime.ts', import.meta.url), 'utf8')
    const fn = fnBodyOf(src, 'wireChatRelayFallback')
    expect(fn).toContain('setVnetP2pTunnel(')
    expect(fn).toContain('ensureSyncTunnelFor(deviceDid)')
    // 2026-11-11 重构：ensureSyncTunnelFor 只做「端口常量 → 通用 ensure」的转接，
    // 真正的异步桥在 ensureDeviceForward 里（写死 localPort 会和 RDP 抢同一口）。
    const deleg = fnBodyOf(src, 'ensureSyncTunnelFor')
    expect(deleg).toContain('ensureDeviceForward(deviceDid, DEVICE_PORT_SYNC)')
    expect(src).toContain('export const DEVICE_PORT_SYNC = 9100') // 对账目标口仍是 PC 侧 9100
    // 异步桥（libvnet 注册重试在调用线程会冻 WebView——真机事故）
    const ens = fnBodyOf(src, 'ensureDeviceForward')
    expect(ens).toContain('p2pTunnelEnsureAsync')
    expect(ens).not.toContain('p2pTunnelEnsure(')
    expect(ens).toContain('targetPort,')
    expect(ens).toContain('device: id.device')
    // localPort 不写死：由 Java 从 25910 起自动分配（写死会和「同时接 DSH 与 RDP」打架）
    expect(ens).not.toContain('localPort: 25910')
    // 起隧道前必须注入设备身份（否则入站 AUTH_REQUIRED，回环口建了也没数据）
    expect(ens).toContain('ensureVnetIdentity()')
    // 比的是**真实调用点**（注释里也会提到这个名字，用 indexOf 名字会被注释骗）
    expect(ens.indexOf('ensureVnetIdentity()')).toBeLessThan(ens.indexOf('shell.p2pTunnelEnsureAsync!('))
    // Java 侧同步桥不得回归（MainActivity 只有 Async 版）
    const mj = readFileSync(new URL('../../android-shell/src/com/myco/phone/MainActivity.java', import.meta.url), 'utf8')
    expect(mj).toContain('p2pTunnelEnsureAsync')
    expect(mj).not.toContain('public String p2pTunnelEnsure(')
  })
})

describe('adb-share：本机 ADB 卡识别（纯函数）', () => {
  const MYDEV = 'did:myco:z6MkPhone'
  const OTHER = 'did:myco:z6MkOtherDev'
  const task = (env: unknown[], extra: Partial<PeerTask> = {}): PeerTask => ({
    taskId: 'peer-task-share-adb', title: 'ADB 调试', from: 'did:youling:me',
    status: 'shared', convId: 'grp-dev-1', env, ...extra,
  })

  it('env kind=adb 且 device=本机 → 命中', () => {
    const t = task([{ kind: 'adb', device: MYDEV, port: ADB_TARGET_PORT, localPort: 15555 }])
    expect(findAdbCard([t], MYDEV)).toBe(t)
  })

  it('别人的 adb 卡 / 非 adb 卡 / 无身份 → 不命中（不误开本机 server）', () => {
    const others = task([{ kind: 'adb', device: OTHER, port: ADB_TARGET_PORT }])
    expect(findAdbCard([others], MYDEV)).toBeNull()
    const rdp = task([{ kind: 'rdp', device: MYDEV, port: 3389 }])
    expect(findAdbCard([rdp], MYDEV)).toBeNull()
    expect(findAdbCard([task([{ kind: 'adb', device: MYDEV }])], null)).toBeNull()
  })

  it('action.env 形态同样识别（动作里的 env 优先级与 declaredEnvsOfCard 一致）', () => {
    const t = task([], { action: { env: [{ kind: 'adb', device: MYDEV, port: ADB_TARGET_PORT }] } })
    expect(findAdbCard([t], MYDEV)).toBe(t)
  })
})
