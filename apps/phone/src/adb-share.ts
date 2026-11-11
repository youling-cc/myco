/**
 * adb-share.ts — 手机「ADB 调试」分享任务卡（2026-11-11）。
 *
 * 需求：`apps/vnet/docs/ADB-SHARE-TASK.md`（youling-myco）——手机当 **vnet server**
 * （目标端口 5555 = Android ADB TCP），授权设备经 vnet 隧道 `adb connect` 调试本机，
 * 取代 frp/USB 线。与 RDP/DSH 卡的方向相反：那些卡是"我去连别人"（`__mycoVnet.add`
 * 起本地固定口当 client），这张卡是"别人连我"（libvnet `vnet_server_start`）。
 *
 * peer_id 契约（与 PC `vnet_forward.rs` 同源，Java `VnetTransport.serverPeerId` 实现）：
 *   server = SHA256("vnet-peer" || 手机设备 did || ":server:" || 5555) 低 32 位
 * PC 侧消费**零改动**：`POST /api/vnet/forward {device:手机did, port:5555}` 起的
 * vnet client 按同一公式找到本机的 server → adb connect 127.0.0.1:<本地口>。
 *
 * 卡形状（type "adb"，env 卡同构）：title「ADB 调试」/ icon 🐛 /
 *   env: [{ kind:'adb', device: 本机设备 did, port: 5555, localPort: 15555 }]
 * （localPort 15555 是**调试者侧**的约定口——需求文档 §调试者侧；手机本地不监听它。）
 */

import { currentIdentity } from './identity'
import { ensureDeviceGroup, listTasks, shareTask, type PeerTask } from './chat-store'
import { declaredEnvsOfCard } from './task-open'
import { accountDidEq } from './didUtil'
import { ensureVnetIdentity } from './vnet-identity'

/** Android ADB TCP 端口（手机系统开发者选项开启的 adbd 监听口）。 */
export const ADB_TARGET_PORT = 5555
/** 卡标题（需求文档口径）。 */
export const ADB_CARD_TITLE = 'ADB 调试'
/** 调试者侧（PC）的本地约定口（需求文档 §调试者侧：`adb connect 127.0.0.1:15555`）。 */
export const ADB_CONSUMER_LOCAL_PORT = 15555

/** 壳桥的最小面（旧 APK 没有 → 明确人话，不静默失败）。
 *  2026-11-11 起 start/stop 走**异步桥**（libvnet 注册重试在调用线程会冻住
 *  WebView——真机事故实证）；state/myDeviceDid 只读原子字段，同步安全。 */
interface AdbShellBridge {
  vnetAdbServerStartAsync?: (callbackJs: string, json: string) => void
  vnetAdbServerStopAsync?: (callbackJs: string) => void
  vnetAdbServerState?: () => string
  myDeviceDid?: () => string
}

function adbShell(): AdbShellBridge | null {
  try {
    const w = window as unknown as { MycoShell?: AdbShellBridge }
    return w.MycoShell ?? null
  } catch {
    return null
  }
}

function parseJson(raw: string | undefined | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 异步桥回调序号。 */
let adbCbSeq = 0

/** 异步桥调用一次：callbackJs(resultJson) → resolve；超时（server 注册在
 *  native 线程最长 ~30s——按最坏预算 35s，到点放弃，state 轮询接管）。 */
function callAsync(
  invoke: (cbName: string) => void,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (r: Record<string, unknown> | null): void => {
      if (settled) return
      settled = true
      try { delete (window as unknown as Record<string, unknown>)[cbName] } catch { /* ignore */ }
      resolve(r)
    }
    const cbName = `__mycoAdbCb${++adbCbSeq}`
    ;(window as unknown as Record<string, unknown>)[cbName] = (r: Record<string, unknown>) => finish(r || null)
    try {
      invoke(cbName)
    } catch {
      finish(null)
      return
    }
    setTimeout(() => finish(null), timeoutMs)
  })
}

/** 本机设备 did：优先 JS 身份层；缺失时走 Java 轻量桥（vault 没有 rootDid
 *  字段——2026-11-11 DSH协议应用 踩过，Java 侧装配记录为准）。 */
export function myDeviceDid(deps: { identity?: () => { did: string } | null } = {}): string {
  const fromId = (deps.identity ?? currentIdentity)()?.did
  if (fromId) return fromId
  try {
    return adbShell()?.myDeviceDid?.() || ''
  } catch {
    return ''
  }
}

export interface AdbServerResult {
  ok: boolean
  running?: boolean
  starting?: boolean
  err?: string
  peerId?: string
  targetPort?: number
}

/** 启动本机 vnet server（5555）。身份未就绪/旧壳 → ok:false + 人话。 */
export async function adbServerStart(deps: { identity?: () => { did: string } | null } = {}): Promise<AdbServerResult> {
  const shell = adbShell()
  if (!shell?.vnetAdbServerStartAsync) {
    return { ok: false, err: '当前应用版本过旧，请升级后再开 ADB 调试' }
  }
  const did = myDeviceDid(deps)
  if (!did) return { ok: false, err: '本机身份还没就绪，稍后再试' }
  // server 侧虽不主动发 AUTH，但对端（PC）是启用 peer identity 的 client；
  // 身份注入是同一进程全局的，起 server 前一并做掉，避免 ADB/RDP/对账三种
  // 场景各自漏一次（2026-11-11 真机：漏了只看到"连上又断"）。
  ensureVnetIdentity()
  const r = await callAsync((cb) => shell.vnetAdbServerStartAsync!(cb, JSON.stringify({
    device: did,
    targetPort: ADB_TARGET_PORT,
  })), 35_000)
  const j = r ?? {}
  if (j.ok === true) {
    return {
      ok: true, running: true,
      starting: j.starting === true,
      peerId: typeof j.peerId === 'string' ? j.peerId : undefined,
      targetPort: typeof j.targetPort === 'number' ? j.targetPort : ADB_TARGET_PORT,
    }
  }
  return { ok: false, err: typeof j.err === 'string' && j.err ? j.err : 'ADB 服务启动失败，稍后再试' }
}

/** 停止本机 vnet server（撤销：闸门随进程消亡立即断开）。 */
export async function adbServerStop(): Promise<AdbServerResult> {
  const shell = adbShell()
  if (!shell?.vnetAdbServerStopAsync) return { ok: false, err: '当前应用版本过旧' }
  const r = await callAsync((cb) => shell.vnetAdbServerStopAsync!(cb), 5_000)
  const j = r ?? {}
  return { ok: j.ok === true, running: false }
}

/** server 状态快照（running/targetPort/startedAtMs/lastErr；同步桥只读原子）。 */
export function adbServerState(): AdbServerResult {
  const shell = adbShell()
  if (!shell?.vnetAdbServerState) return { ok: false, err: '当前应用版本过旧' }
  const r = parseJson(shell.vnetAdbServerState())
  return {
    ok: r.ok === true || r.running === true,
    running: r.running === true,
    targetPort: typeof r.targetPort === 'number' ? r.targetPort : undefined,
  }
}

/** 任务库里找本机的 ADB 卡（env kind=adb 且 device=本机设备）。 */
export function findAdbCard(
  tasks: PeerTask[],
  myDeviceDid: string | null,
): PeerTask | null {
  if (!myDeviceDid) return null
  for (const t of tasks) {
    for (const env of declaredEnvsOfCard(t as unknown as Record<string, unknown>, t.action)) {
      if (env.kind === 'adb' && env.device && accountDidEq(env.device, myDeviceDid)) return t
    }
  }
  return null
}

/** 本机 ADB 卡是否已建（幂等锚：env 里能对上本机设备）。 */
export function adbCardExists(myDeviceDid_: string | null): boolean {
  return findAdbCard(listTasks(), myDeviceDid_) != null
}

/**
 * 创建「ADB 调试」任务卡并分享到设备群（幂等：已有本机 ADB 卡不再建）。
 * 卡经 task-share 广播 → PC 端入库（peer-tasks.json）→ PC 侧后续可按卡建链。
 */
export async function ensureAdbCard(deps: { identity?: () => { did: string } | null } = {}): Promise<{ created: boolean; err?: string }> {
  const did = myDeviceDid(deps)
  if (!did) return { created: false, err: '本机身份还没就绪，稍后再试' }
  if (adbCardExists(did)) return { created: false }
  const gid = ensureDeviceGroup()
  if (!gid) return { created: false, err: '设备群还没就绪，稍后再试' }
  try {
    await shareTask(gid, {
      title: ADB_CARD_TITLE,
      desc: '授权设备经 vnet 隧道 adb connect 调试本机（端口 5555）',
      env: [{
        kind: 'adb',
        device: did,
        port: ADB_TARGET_PORT,
        localPort: ADB_CONSUMER_LOCAL_PORT,
        label: ADB_CARD_TITLE,
      }],
    })
    return { created: true }
  } catch (e) {
    return { created: false, err: e instanceof Error ? e.message : String(e) }
  }
}
