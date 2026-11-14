/**
 * AgentDevices — 智能体 Tab 的**设备操作层**（2026-10-13 P0）。
 *
 * 背景：本 Tab 此前是只读设备名单（状态点 + 名字 + 本机/我的设备 + DID 复制）。
 * 现在升为操作层——在线态分三档醒目（绿/灰/红 + 左侧色条 + 在线呼吸点），
 * 点开设备行给出真实可用的操作。
 *
 * ⚠️ 命令可用性纪律（不许放假按钮）：本文件**只**调 home Rust 侧已注册的命令。
 * 2026-10-13 逐条核对 apps/home/src-tauri/src/lib.rs 的 invoke_handler 清单：
 *   ✅ list_authorized_devices      —— 本地白名单（放行态 + 白名单显示名）
 *   ✅ set_device_auth              —— 放行 / 暂停放行（{did, allowed, ttlMs?}）
 *   ✅ add_device_by_did            —— 授权本机（名册成员未在本机白名单时；需本机持账号钥）
 *   ✅ device_revoke                —— 名册除名（{pubkeyOrDid}；账号钥签 /root/device/revoke）
 *   ✅ rename_authorized_device     —— 改**本机白名单**显示名（{did, name}）
 *   ✅ delegation_status_by_device  —— 各成员设备委任状剩余（按 pubkeyB64 匹配）
 *   ❌ remove_authorized_device     —— 已注册但语义=删本机白名单记录（可重新配对，不动名册），
 *                                      与「除名」不是一回事 → 本 Tab 不用；账号页 MycoDevices 用它。
 *
 * 语义边界（Rust 侧写死，别搞混）：服务端名册只有 /root/device/{add,revoke}，**没有 rename**
 * —— 所以「改名」改的是本机白名单名（authorized-dids.json），名册名以 myco_list_devices 为准。
 * 本 Tab 因此**优先显示白名单名**（改了看得见），且只在白名单在册时给「改名」（否则命令返回
 * false = 点了没反应 = 假按钮）。
 *
 * 放行语义（set_device_auth 只改**已在本机白名单**里的条目，did 不在白名单→返回 false 静默无效）：
 *   白名单内 → 「放行 / 暂停放行 / 改名」；不在白名单 → 「授权本机」(add_device_by_did)。
 * 本机（isEmbodiment）不放行自己、不除名自己 → 只留「复制 DID」。
 * 已除名（revoked）→ 只留「复制 DID」（P0 规格）。
 */
import { useCallback, useEffect, useState } from 'react'
import { client } from '../api/client'
import { copyDidVerified, copyDidToastText } from '../didCheck'
import { delegationBadgeText, delegationLevel, delegationLevelBg, delegationLevelColor } from '../lib/delegationStatus'
import '../demo.css'

/** 名册设备（App 的设备名单，来自 myco_list_devices；pubkeyB64=除名/委任状匹配用）。 */
export interface AgentDevice {
  did: string
  name: string
  /** 名册里的设备公钥（device_revoke 与 delegation_status_by_device 均按它匹配；老数据可能缺）。 */
  pubkeyB64?: string
  online: boolean
  revoked: boolean
  isEmbodiment: boolean
  lastSeen?: number | null
}

/** 本地白名单条目（list_authorized_devices）里本组件用得到的字段。 */
export interface DeviceAuthInfo {
  authState: 'pending' | 'allowed' | 'denied'
  /** 限时授权到期时刻 ms（无=不限期）。 */
  authExpiresAt?: number | null
  /** **本机白名单**里的显示名（rename_authorized_device 改的就是它；名册名在服务端，无 rename 接口）。 */
  name?: string
}

/** 在线态三档（P0-1）：在线绿 / 离线灰 / 已除名红。 */
export type PresenceLevel = 'online' | 'offline' | 'revoked'

/** 在线态单一源：文案 + 点色 + 文字色 + 左侧色条类（demo.css 的 .devline.dev-*）。 */
export function devicePresence(d: Pick<AgentDevice, 'online' | 'revoked'>): {
  level: PresenceLevel
  label: string
  dot: string
  color: string
  /** 在线才加呼吸动画（.dot.pulse）；不做花哨动效。 */
  pulse: boolean
} {
  // 已除名优先于在线：名册已吊销的设备显示"在线"会误导（它已不是本账号设备）
  if (d.revoked) return { level: 'revoked', label: '已除名', dot: '#ef4444', color: '#dc2626', pulse: false }
  if (d.online) return { level: 'online', label: '在线 · 空闲', dot: '#22c55e', color: '#15803d', pulse: true }
  return { level: 'offline', label: '离线', dot: '#94a3b8', color: '#64748b', pulse: false }
}

/** 限时放行是否仍然有效（到期即视为未放行——与 Rust Authorized::is_allowed 同口径）。 */
export function authAllowedNow(auth: DeviceAuthInfo | null | undefined, now: number = Date.now()): boolean {
  if (!auth || auth.authState !== 'allowed') return false
  if (auth.authExpiresAt == null) return true
  return auth.authExpiresAt > now
}

/** 一行设备可用的操作（纯函数，测试锚点）。 */
export type DeviceOp = 'auth-allow' | 'auth-deny' | 'rename' | 'authorize' | 'remove' | 'copy'

export function deviceOps(
  d: Pick<AgentDevice, 'revoked' | 'isEmbodiment' | 'pubkeyB64'>,
  auth: DeviceAuthInfo | null | undefined,
  opts: { canManage: boolean; now?: number },
): DeviceOp[] {
  // 已除名：只留复制（P0 规格）。本机：不放行自己、不除名自己。
  if (d.revoked || d.isEmbodiment) return ['copy']
  const ops: DeviceOp[] = []
  if (auth) {
    ops.push(authAllowedNow(auth, opts.now) ? 'auth-deny' : 'auth-allow')
    // 改名只改**本机白名单**里的显示名（服务端名册无 rename 接口）→ 仅白名单内在册时可改，
    // 否则命令返回 false（点了没反应=假按钮），故与放行同门槛。
    ops.push('rename')
  } else if (opts.canManage) {
    ops.push('authorize')  // 名册成员但不在本机白名单 → 授权本机
  }
  // 除名=名册吊销：需账号钥（主设备）+ 名册公钥在位
  if (opts.canManage && !!d.pubkeyB64) ops.push('remove')
  ops.push('copy')
  return ops
}

/** 常用放行时长（毫秒）：不限 / 30 分钟 / 1 小时 / 24 小时（与 MycoDevices 同款选项）。 */
export const TTL_PRESETS: { label: string; ms?: number }[] = [
  { label: '不限' },
  { label: '30 分钟', ms: 30 * 60_000 },
  { label: '1 小时', ms: 60 * 60_000 },
  { label: '24 小时', ms: 24 * 3600_000 },
]

/** 命令调用单一出口（可注入 invoke 便于测试命令名/参数契约）。 */
export type Invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>

export function createDeviceOps(invoke: Invoke) {
  return {
    /** 放行（ttlMs 省略/undefined = 不限期）。命令返回 false=该 did 不在本机白名单 → 明确报错，不装作成功。 */
    allow: async (did: string, ttlMs?: number) => {
      const ok = await invoke<boolean>('set_device_auth', { did, allowed: true, ttlMs: ttlMs ?? null })
      if (ok === false) throw new Error('放行失败：该设备不在本机白名单（可先点「授权本机」）')
      return ok
    },
    /** 暂停放行（立即生效）。 */
    deny: async (did: string) => {
      const ok = await invoke<boolean>('set_device_auth', { did, allowed: false })
      if (ok === false) throw new Error('暂停失败：该设备不在本机白名单')
      return ok
    },
    /** 授权本机：名册成员加入本机白名单（attest 上云 + 签委任状；需本机持账号钥）。 */
    authorizeLocal: (d: AgentDevice, ownerRootDid: string | null) =>
      invoke('add_device_by_did', { did: d.did, name: d.name, ownerRootDid: ownerRootDid ?? null }),
    /** 改名：改**本机白名单**显示名（rename_authorized_device；服务端名册无 rename 接口）。 */
    rename: async (did: string, name: string) => {
      const ok = await invoke<boolean>('rename_authorized_device', { did, name })
      if (ok === false) throw new Error('改名失败：该设备不在本机白名单（可先点「授权本机」）')
      return ok
    },
    /** 除名：名册吊销（账号钥签 revoke 上云）。缺公钥时**不发请求**并抛明确错误（不许无声删除）。 */
    removeFromRoster: (d: AgentDevice) => {
      const key = (d.pubkeyB64 ?? '').trim()
      if (!key) return Promise.reject(new Error('名册数据缺公钥，无法除名（请升级 PC 端）'))
      return invoke('device_revoke', { pubkeyOrDid: key })
    },
  }
}

/** 名称安全显示（名册空名/脏名兜底）。 */
const devName = (d: Pick<AgentDevice, 'name' | 'did'>): string => (d.name || '').trim() || `设备 …${d.did.slice(-4)}`

export interface AgentDeviceRowHandlers {
  onToggle: () => void
  onCopy: () => void
  onAllow: () => void
  onDeny: () => void
  onAuthorize: () => void
  onAskRemove: () => void
  onConfirmRemove: () => void
  onCancelRemove: () => void
  onPickTtl: (ttlMs?: number) => void
  onCancelTtl: () => void
  onRenameAsk: () => void
  onRenameDraft: (text: string) => void
  onRenameSave: (name: string) => void
  onRenameCancel: () => void
}

/**
 * 单台设备行（**纯展示**，props 进 markup 出——组件级测试用 renderToStaticMarkup 断言，
 * 例如"已除名设备不渲染放行按钮""委任状徽标按天数分档"）。
 */
export function AgentDeviceRow({
  d, presence, ops, deleg, localName, expanded, busy, copied, confirmRemove, ttlOpen, renaming, renameDraft, err, handlers,
}: {
  d: AgentDevice
  presence: ReturnType<typeof devicePresence>
  ops: DeviceOp[]
  /** 委任状剩余（本机/无记录时 null → 不渲染徽标）。 */
  deleg: { remainingMs: number; expired: boolean } | null
  /** 本机白名单里的显示名（有则优先于名册名——rename_authorized_device 改的就是它）。 */
  localName?: string | null
  expanded: boolean
  busy: boolean
  copied: boolean
  confirmRemove: boolean
  ttlOpen: boolean
  renaming: boolean
  renameDraft: string
  err?: string | null
  handlers: AgentDeviceRowHandlers
}) {
  const level = deleg ? delegationLevel(deleg) : null
  // 本机不显示委任状徽标（P0 规格：本机是委任状签发方，不是持有者）——组件内再兜一道，
  // 容器漏传也不会渲染出错误徽标。
  const badge = !d.isEmbodiment && deleg && level ? delegationBadgeText(deleg) : null
  const shown = (localName || '').trim() || devName(d)
  return (
    <div>
      <div className={`devline dev-${presence.level}`} style={{ marginTop: 4, cursor: 'pointer' }}
        title={expanded ? '收起' : '点开看完整设备 DID 与操作'}
        onClick={handlers.onToggle}>
        <span className={'dot' + (presence.pulse ? ' pulse' : '')} style={{ background: presence.dot }} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {shown}
          <span style={{ color: presence.color, fontWeight: 600 }}> · {presence.label}</span>
        </span>
        {badge && level && (
          <span className="delegchip" style={{ background: delegationLevelBg(level), color: delegationLevelColor(level) }}
            title="本设备委任状（授权）剩余有效期">
            {badge}
          </span>
        )}
        <span className="chipd gray" style={{ fontSize: 9.5, padding: '1px 6px' }}>{d.isEmbodiment ? '本机' : '我的设备'}</span>
        <span className="tinyd" style={{ flexShrink: 0, fontSize: 10, color: '#6b7bff' }}>{expanded ? '▴' : '▾'}</span>
      </div>
      {expanded && (
        <div className="devopen">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <code style={{ flex: 1, minWidth: 0, fontSize: 10.5, fontFamily: 'ui-monospace,monospace', color: 'var(--tx2)', wordBreak: 'break-all', userSelect: 'text' }}>{d.did}</code>
            <button onClick={(e) => { e.stopPropagation(); handlers.onCopy() }}
              title="复制完整 DID"
              className="btnd ghost small" style={{ flexShrink: 0, padding: '3px 8px', fontSize: 11, fontWeight: 600, color: copied ? '#15803d' : '#64748b' }}>
              {copied ? '✓ 已复制' : '⧉ 复制 DID'}
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 7 }}>
            {ops.includes('auth-allow') && (
              <button className="btnd small" style={{ padding: '4px 10px', fontSize: 11.5 }}
                disabled={busy} onClick={(e) => { e.stopPropagation(); handlers.onAllow() }}
                title="允许这台设备连接本机（可选时限）">放行</button>
            )}
            {ops.includes('auth-deny') && (
              <button className="btnd ghost small" style={{ padding: '4px 10px', fontSize: 11.5 }}
                disabled={busy} onClick={(e) => { e.stopPropagation(); handlers.onDeny() }}
                title="立即停止放行（设备记录保留，随时可再放行）">暂停放行</button>
            )}
            {ops.includes('authorize') && (
              <button className="btnd small" style={{ padding: '4px 10px', fontSize: 11.5 }}
                disabled={busy} onClick={(e) => { e.stopPropagation(); handlers.onAuthorize() }}
                title="把这台账号成员设备授权到本机（签委任状；需本机持有账号钥）">授权本机</button>
            )}
            {ops.includes('rename') && !renaming && (
              <button className="btnd ghost small" style={{ padding: '4px 10px', fontSize: 11.5 }}
                disabled={busy} onClick={(e) => { e.stopPropagation(); handlers.onRenameAsk() }}
                title="改本机白名单里的显示名（服务端名册没有改名接口）">改名</button>
            )}
            {ops.includes('remove') && (confirmRemove ? (
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <button className="btnd danger small" style={{ padding: '4px 10px', fontSize: 11.5 }}
                  disabled={busy} onClick={(e) => { e.stopPropagation(); handlers.onConfirmRemove() }}>确认除名</button>
                <button className="btnd ghost small" style={{ padding: '4px 10px', fontSize: 11.5 }}
                  disabled={busy} onClick={(e) => { e.stopPropagation(); handlers.onCancelRemove() }}>取消</button>
              </span>
            ) : (
              <button className="btnd danger-ghost small" style={{ padding: '4px 10px', fontSize: 11.5 }}
                disabled={busy} onClick={(e) => { e.stopPropagation(); handlers.onAskRemove() }}
                title="从账号名册除名（吊销它的委托；丢了/退役用这个）">除名</button>
            ))}
          </div>
          {confirmRemove && (
            <div className="tinyd" style={{ color: '#b91c1c', marginTop: 5 }}>
              确认把「{shown}」从账号除名？它会被名册吊销、立即失去授权；要再用需重新配对。
            </div>
          )}
          {ttlOpen && (
            <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span className="tinyd">放行多久？</span>
              {TTL_PRESETS.map((p) => (
                <button key={p.label} className="btnd small" style={{ padding: '4px 10px', fontSize: 11.5 }}
                  disabled={busy} onClick={(e) => { e.stopPropagation(); handlers.onPickTtl(p.ms) }}>{p.label}</button>
              ))}
              <button className="btnd ghost small" style={{ padding: '4px 10px', fontSize: 11.5 }}
                disabled={busy} onClick={(e) => { e.stopPropagation(); handlers.onCancelTtl() }}>取消</button>
            </div>
          )}
          {renaming && (
            <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
              {/* 受控输入：草稿变更由容器持有（纯展示组件不留内部状态，SSR 可测） */}
              <input className="inpd" value={renameDraft} placeholder="给这台设备起个名"
                style={{ flex: 1, minWidth: 0, fontSize: 12 }}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => handlers.onRenameDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); handlers.onRenameSave(renameDraft) } }} />
              <button className="btnd small" style={{ padding: '4px 10px', fontSize: 11.5 }}
                disabled={busy || !renameDraft.trim()} onClick={(e) => { e.stopPropagation(); handlers.onRenameSave(renameDraft) }}>保存</button>
              <button className="btnd ghost small" style={{ padding: '4px 10px', fontSize: 11.5 }}
                disabled={busy} onClick={(e) => { e.stopPropagation(); handlers.onRenameCancel() }}>取消</button>
            </div>
          )}
          {d.revoked && (
            <div className="tinyd" style={{ marginTop: 5 }}>已除名——只剩 DID 可核对；要再启用需重新配对收编。</div>
          )}
          {!d.revoked && d.isEmbodiment && (
            <div className="tinyd" style={{ marginTop: 5 }}>本机（持有账号钥匙的设备）不在此处放行/除名自己。</div>
          )}
          {err && <div className="tinyd" style={{ color: '#dc2626', marginTop: 5 }}>{err}</div>}
        </div>
      )}
    </div>
  )
}

/** 本地白名单条目（只取用得到的字段）。 */
interface WhiteRow {
  did: string
  name?: string
  pubkeyB64?: string
  authState: DeviceAuthInfo['authState']
  authExpiresAt?: number | null
}

/**
 * 智能体 Tab 设备操作层（容器）：自取放行态 + 委任状剩余，10s 轮询让"在线/剩余"跟着走；
 * 名单本身由 App（myco_list_devices，30s 轮询）传入，避免两份名册打架。
 */
export function AgentDevices({ devices, canManage, ownerRootDid, onToast }: {
  devices: AgentDevice[]
  /** 本机是否持账号钥（主设备）——除名/授权本机需要；成员机只读。 */
  canManage: boolean
  ownerRootDid: string | null
  onToast: (text: string) => void
}) {
  const [authBy, setAuthBy] = useState<Record<string, DeviceAuthInfo>>({})
  const [delegByPub, setDelegByPub] = useState<Record<string, { remainingMs: number; expired: boolean }>>({})
  const [openDid, setOpenDid] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [ttlFor, setTtlFor] = useState<string | null>(null)
  const [renameFor, setRenameFor] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [errBy, setErrBy] = useState<Record<string, string>>({})
  // 2026-11-15：名册里已吊销的历史设备默认折叠（用户"这些还是没删"实拍）
  const [showRevoked, setShowRevoked] = useState(false)

  const refresh = useCallback(async () => {
    // 放行态（本地白名单）：命令不可用（旧 exe）→ 放行态未知，行内按"未授权"降级
    try {
      const list = await client.invoke<WhiteRow[]>('list_authorized_devices')
      const m: Record<string, DeviceAuthInfo> = {}
      for (const r of list ?? []) {
        const info: DeviceAuthInfo = { authState: r.authState, authExpiresAt: r.authExpiresAt ?? null, name: r.name ?? '' }
        m[r.did] = info
        if (r.pubkeyB64) m[`pk:${r.pubkeyB64}`] = info   // 白名单 did 形态与名册不一致时按公钥兜底匹配
      }
      setAuthBy(m)
    } catch { /* 静默：不显示未知态为已放行 */ }
    try {
      const dl = await client.invoke<{ devicePubkeyB64: string; remainingMs: number; expired: boolean }[]>('delegation_status_by_device')
      const d: Record<string, { remainingMs: number; expired: boolean }> = {}
      for (const r of dl ?? []) d[r.devicePubkeyB64] = { remainingMs: r.remainingMs, expired: r.expired }
      setDelegByPub(d)
    } catch { /* 旧 exe 无此命令 → 不显示该列 */ }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 10_000)
    return () => clearInterval(t)
  }, [refresh])

  const cmd = createDeviceOps(client.invoke as Invoke)
  const run = async (did: string, fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(did); setErrBy((m) => ({ ...m, [did]: '' }))
    try {
      await fn()
      if (okMsg) onToast(okMsg)
    } catch (e) {
      setErrBy((m) => ({ ...m, [did]: String(e).replace(/^Error:\s*/, '') }))
    } finally {
      setBusy(null)
      void refresh()
    }
  }
  const authOf = (d: AgentDevice): DeviceAuthInfo | null =>
    authBy[d.did] ?? (d.pubkeyB64 ? authBy[`pk:${d.pubkeyB64}`] : undefined) ?? null

  const toggleRow = (did: string) => {
    setOpenDid((v) => (v === did ? null : did))
    setCopied(false); setConfirmRemove(null); setTtlFor(null); setRenameFor(null)
  }

  // 2026-11-15 用户反馈「这些还是没删」：名册里已吊销的历史设备仍以「已除名」
  // 逐行铺开（10 台 cloud-mac / ecs-linux / 旧 phone…），把活设备淹掉。
  // 默认只显示未吊销设备；已除名的折叠成一行可展开摘要（用户要看历史再点开）。
  const alive = devices.filter((d) => !d.revoked)
  const revoked = devices.filter((d) => d.revoked)
  const shownDevices = showRevoked ? devices : alive

  return (
    <div>
      <div className="tinyd" style={{ margin: '4px 0 2px' }}>本机 / 我的设备</div>
      {devices.length === 0 && <div className="tinyd" style={{ padding: '2px 0' }}>还没有设备——账号页「添加设备」可加手机/电脑</div>}
      {shownDevices.map((d) => {
        const presence = devicePresence(d)
        const auth = authOf(d)
        const ops = deviceOps(d, auth, { canManage })
        const deleg = !d.isEmbodiment && d.pubkeyB64 ? (delegByPub[d.pubkeyB64] ?? null) : null
        // 本机白名单显示名优先（rename_authorized_device 改的就是它；有它改名才看得见效果）
        const localName = (auth?.name || '').trim() || null
        const shown = localName || devName(d)
        return (
          <AgentDeviceRow key={d.did}
            d={d} presence={presence} ops={ops} deleg={deleg} localName={localName}
            expanded={openDid === d.did} busy={busy === d.did} copied={copied && openDid === d.did}
            confirmRemove={confirmRemove === d.did} ttlOpen={ttlFor === d.did}
            renaming={renameFor === d.did} renameDraft={renameDraft}
            err={errBy[d.did]}
            handlers={{
              onToggle: () => toggleRow(d.did),
              onCopy: () => { void copyDidVerified(d.did).then((r) => {
                onToast(copyDidToastText(r))
                if (r === 'ok') { setCopied(true); setTimeout(() => setCopied(false), 1200) }
              }).catch(() => onToast('复制失败，请重试')) },
              onAllow: () => { setTtlFor(d.did); setRenameFor(null) },   // 放行先选时限（不限/30分/1小时/24小时）——与 MycoDevices 同交互
              onDeny: () => void run(d.did, () => cmd.deny(d.did), `已暂停放行「${shown}」`),
              onAuthorize: () => void run(d.did, () => cmd.authorizeLocal(d, ownerRootDid), `✓ 已授权本机「${shown}」（对方上线后自动收下）`),
              onAskRemove: () => setConfirmRemove(d.did),
              onConfirmRemove: () => void run(d.did, () => cmd.removeFromRoster(d), `已从账号除名「${shown}」`),
              onCancelRemove: () => setConfirmRemove(null),
              onPickTtl: (ttlMs?: number) => { setTtlFor(null); void run(d.did, () => cmd.allow(d.did, ttlMs), `已放行「${shown}」${ttlMs ? `（限时 ${Math.round(ttlMs / 60_000)} 分钟）` : '（不限时）'}`) },
              onCancelTtl: () => setTtlFor(null),
              onRenameAsk: () => { setRenameFor(d.did); setRenameDraft(shown); setTtlFor(null) },
              onRenameDraft: (text: string) => setRenameDraft(text),
              onRenameSave: (name: string) => {
                const v = name.trim()
                if (!v) return
                setRenameFor(null)
                void run(d.did, () => cmd.rename(d.did, v), `已改名「${v}」`)
              },
              onRenameCancel: () => setRenameFor(null),
            }} />
        )
      })}
      {/* 已除名历史设备折叠行（2026-11-15）：默认收起，避免把活设备淹没 */}
      {revoked.length > 0 && (
        <button
          onClick={() => setShowRevoked((v) => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', marginTop: 4,
            padding: '4px 8px', fontSize: 10, lineHeight: '16px', borderRadius: 6,
            border: '1px dashed var(--chrome-border)', background: 'transparent',
            color: 'var(--text-muted)', cursor: 'pointer' }}>
          {showRevoked ? '▾' : '▸'} 已除名历史设备 {revoked.length} 台（{alive.length} 台在用）
        </button>
      )}
      {!canManage && devices.length > 0 && (
        <div className="tinyd" style={{ marginTop: 6 }}>放行/除名需在持有账号钥匙的主设备上操作——本机是成员，可查看状态与复制 DID。</div>
      )}
      <div className="tinyd" style={{ marginTop: 6 }}>
        设备与在线状态在此 Tab 管理；备份恢复码/添加设备/出示码在账号页。
      </div>
    </div>
  )
}
