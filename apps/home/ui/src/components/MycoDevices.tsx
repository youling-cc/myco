/**
 * MycoDevices —— "Myco（协作设备）" 管理区。
 * 取代旧 AuthorizedDevices。统一授权语义：每台设备独立放行（不再按账号自动放行）。
 *
 * 三块：
 *   ① 待放行（authState=pending）：显示 名/DID/IP归属/归属账号 + [放行]/[拒绝]。
 *   ② 已分组设备（allowed/denied）：按归属账号 分组（自己的账号在最前），每台 ExpandableRow
 *      summary=图标+名+shortDid+在线+授权开关；details=完整 DID+复制/归属/备注/来源。
 *   ③ 添加设备（DID 互换）：PC 优先形态——粘贴识别码为主操作，摄像头/图片识别为底部次要链接；
 *      输入对方设备 DID 调 add_device_by_did，无配对码。通道次序契约见 ui-kit scanAddOrder。
 *
 * 数据：list_authorized_devices / list_trusted_roots（外来账号分组名）。
 * 授权记录只存本机（%APPDATA%/myco/authorized-dids.json），不上服务器。
 */
import { useEffect, useRef, useState } from 'react'
import { Smartphone, Monitor, Copy, Check, Trash2 } from 'lucide-react'
import { client } from '../api/client'
import { nicknameValue } from '../lib/accountDisplay'
import { ExpandableRow } from './ExpandableRow'
import { QrImage, decodeQrFromFile, parseAddPayload } from './Qr'
import { QrCamera } from './QrCamera'
// ui-kit 单一源（2026-10-06 随 env 退役迁入 home/ui——相对路径深度不变，直引 packages/ui-kit）
import { scanAddSecondary } from '../../../../../packages/ui-kit/src/scanAddOrder'
import '../demo.css'

/** 成员设备委任状剩余（2026-10-13 用户需求"台式机也要看到 30 天授权数字"）：
 *  pubkey → 剩余 ms。数据源=delegation_status_by_device（主设备视角，按设备聚合 exp 最大）。 */
type DelegByDevice = Record<string, { remainingMs: number; expired: boolean }>
/** 与 delegationStatus.ts 同口径：>3 天绿 / ≤3 天橙 / 过期红。 */
function delegDaysLeft(remainingMs: number): { days: number; color: string; label: string } {
  const expired = remainingMs <= 0
  const days = Math.max(1, Math.ceil(remainingMs / 86_400_000))
  if (expired) return { days: 0, color: '#dc2626', label: '授权已过期' }
  if (remainingMs <= 3 * 86_400_000) return { days, color: '#d97706', label: `授权剩余 ${days} 天` }
  return { days, color: '#059669', label: `授权剩余 ${days} 天` }
}

/** 摄像头 API 是否存在（WebView2 tauri.localhost 是 https 安全上下文，一般可用）。
    注意：只看 API 不看硬件——PC 无摄像头时也返回 true，设备探测见组件内 liveScan。 */
const canLiveScan = () => { try { return !!navigator.mediaDevices?.getUserMedia } catch { return false } }

/** did 去 method 前缀（2026-10-09）：邀请码/识别码载荷精简用——`did:myco:` 固定 9 字符
 *  可从二维码里省掉，解析侧按前缀缺失补回（手机端 parseQrPayload 已兼容）。
 *  二维码每少一个字符都可能降一档密度，直接影响手机镜头能否识别。 */
const compactDid = (did: string): string => (did || '').replace(/^did:(myco|youling):/, '')

type AuthState = 'pending' | 'allowed' | 'denied'

interface MycoDevice {
  did: string
  name: string
  pubkeyB64: string
  addedAt: number
  lastSeen: number
  lastAddr?: string | null
  ownerRootDid?: string | null
  authState: AuthState
  clientIp?: string | null
  /** 限时授权到期时刻 ms（无=不限期）。 */
  authExpiresAt?: number | null
  /** 授权作用域(v1: *=全量 / desktop.view / session.input / remote.out;老条目缺省全量)。 */
  scopes?: string[]
  /** 出生地标签(手机/本机/…):分组吊销用。 */
  origin?: string | null
}
interface TrustedRoot {
  rootDid: string
  name: string
  note?: string
}
/** 账号名册成员（myco_list_devices，服务器身份层真相）。 */
interface RosterDevice {
  did: string
  name: string
  pubkeyB64: string
  revoked: boolean
  isEmbodiment: boolean
  online: boolean
}

/** IPv6 前缀粗判运营商（"是不是我的设备"参考，非精确地理）。 */
function carrierOf(addr?: string | null): string {
  if (!addr) return ''
  const a = addr.toLowerCase()
  if (a.startsWith('240e')) return '电信'
  if (a.startsWith('2409') || a.startsWith('2408')) return '联通'
  if (a.startsWith('2401')) return '移动'
  if (a.startsWith('2402')) return '铁通'
  return ''
}
function shortAddr(addr?: string | null): string {
  if (!addr) return ''
  const parts = addr.split(':')
  return parts.length > 3 ? `${parts.slice(0, 3).join(':')}:…` : addr
}
function relTime(ms: number): string {
  // 0/epoch/负值 = 从未上线(2026-09-03 用户实测"20698 天前"——lastSeen=0 的显露)
  if (!ms || ms < 946684800_000 /* 2000-01-01 */) return ''
  const d = Date.now() - ms
  if (d < 0) return ''
  if (d < 60_000) return '刚刚 '
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前 `
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时前 `
  return `${Math.floor(d / 86400_000)} 天前 `
}
/** 限时授权剩余（允许中且有到期时间才显示）。 */
function expiryText(d: MycoDevice): string {
  if (d.authState !== 'allowed' || !d.authExpiresAt) return ''
  const left = d.authExpiresAt - Date.now()
  if (left <= 0) return '已到期'
  const mins = Math.ceil(left / 60_000)
  return mins >= 60 ? `限时授权 剩 ${Math.floor(mins / 60)} 小时${mins % 60 ? ` ${mins % 60} 分` : ''}` : `限时授权 剩 ${mins} 分钟`
}
/** 常用授权时长（毫秒）：半小时 / 1 小时 / 24 小时。 */
const TTL_PRESETS: { label: string; ms?: number }[] = [
  { label: '不限' },
  { label: '30 分钟', ms: 30 * 60_000 },
  { label: '1 小时', ms: 60 * 60_000 },
  { label: '24 小时', ms: 24 * 3600_000 },
]
const shortDid = (did: string) => (did.length > 14 ? `${did.slice(0, 8)}…${did.slice(-4)}` : did)

/* ── 2026-10-05 复制可靠性加固 + 粘贴非法 DID 实时提示 ──
 * 单一源在 apps/home/ui/src/didCheck.ts + apps/phone/src/didCheck.ts（双端同内容）；
 * env/ui 无跨 app 依赖先例，这里内联同款实现（改动时三处同步）。
 * 2026-10-10 canonical-only：legacy（裸 base58 尾段）已废止 → 一律拦截（三处同步改）。 */
function isValidDid(s: string): boolean {
  const m = /^did:(myco|youling):([A-Za-z0-9]+)$/.exec(s.trim())
  if (!m) return false
  const body = m[2]
  if (body.startsWith('z6Mk')) return body.length >= 47 && body.length <= 48 && !body.includes('0') && !body.includes('O') && !body.includes('I') && !body.includes('l')
  // legacy（裸 base58 32B，43~44 字符）已废止：不支持的 did 格式 → 拦截（不再放行）
  return false
}
/** 复制 DID：先校验（非法禁止复制）→ writeText → readText 回读比对；
 *  WebView 无 readText 权限（NotAllowedError）降级为只写不比对。 */
async function copyDidVerified(did: string): Promise<'ok' | 'invalid' | 'mismatch' | 'failed'> {
  if (!isValidDid(did)) return 'invalid'
  try { await navigator.clipboard.writeText(did) } catch { return 'failed' }
  try { return (await navigator.clipboard.readText()) === did ? 'ok' : 'mismatch' } catch { return 'ok' }
}
function copyDidToastText(r: 'ok' | 'invalid' | 'mismatch' | 'failed'): string {
  if (r === 'invalid') return '识别码异常（长度不符），请重启登录器后重试，仍异常请反馈'
  if (r === 'mismatch') return '复制可能不完整，请粘贴后核对尾部字符'
  if (r === 'failed') return '复制失败，请重试'
  return '已复制 ✓'
}

function DidLine({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const [warn, setWarn] = useState<string | null>(null)
  const copy = async () => {
    try {
      const r = await copyDidVerified(value)
      setWarn(r === 'ok' ? null : copyDidToastText(r))
      if (r === 'ok') { setCopied(true); setTimeout(() => setCopied(false), 1200) }
    } catch { setWarn('复制失败，请重试') }
  }
  return (
    <div className="flex flex-wrap items-start gap-2">
      <code className="flex-1 text-[10px] font-mono text-[var(--text-secondary)] break-all select-text">{value}</code>
      <button onClick={copy} title="复制完整 DID" className="shrink-0 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--accent)]">
        {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
      </button>
      {warn && <div className="w-full text-[10px]" style={{ color: '#e65100', lineHeight: 1.5 }}>{warn}</div>}
    </div>
  )
}

export function MycoDevices({ myYoulingDid, myYoulingName, localDid, isEmbodiment = false }: { myYoulingDid: string | null; myYoulingName: string; localDid: string; isEmbodiment?: boolean }) {
  const [devices, setDevices] = useState<MycoDevice[]>([])
  const [roots, setRoots] = useState<TrustedRoot[]>([])
  const [accountNames, setYoulingNames] = useState<Record<string, string>>({})
  const [roster, setRoster] = useState<RosterDevice[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  // 成员设备委任状剩余（pubkey → 剩余）：主设备视角的"30 天授权数字"（2026-10-13）
  const [delegByPub, setDelegByPub] = useState<DelegByDevice>({})
  // vnet 连接状态（2026-11-15 vnet 需求 / jason「现在就做」）：device did → { path, direct, rttMs }
  // 来源：/api/vnet/status forwards 的设备级聚合（5s 轮询）
  const [vnetPeer, setVnetPeer] = useState<Record<string, { path: string; direct: boolean; rttMs: number | null }>>({})

  // vnet 连接状态轮询：每 5s 拉 /api/vnet/status，从 forwards 聚合每设备最优路径
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const st = await client.invoke<{ peers: Record<string, { path: string; direct: boolean; rttMs: number | null }> }>('vnet_peer_status')
        const peers = st?.peers ?? {}
        if (alive && Object.keys(peers).length > 0) setVnetPeer(peers)
      } catch { /* vnet 未跑/接口不可用 = 无状态，静默 */ }
    }
    void poll()
    const t = setInterval(poll, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const refresh = async () => {
    try {
      const [devs, rts, ov] = await Promise.all([
        client.invoke<MycoDevice[]>('list_authorized_devices'),
        client.invoke<TrustedRoot[]>('list_trusted_roots'),
        // 本 账号名册（身份层）：名册有而白名单没有的成员也显示（标"未授权本机"），否则两端视图不一致
        myYoulingDid ? client.invoke<{ devices: RosterDevice[] }>('myco_list_devices').catch(() => null) : Promise.resolve(null),
      ])
      setDevices(devs ?? [])
      setRoots(rts ?? [])
      setRoster((ov?.devices ?? []).filter((d) => !d.revoked))
      // 主设备视角：各成员设备的委任状剩余（delegation_status_by_device）——
      // 失败静默（旧 exe 无此命令时不显示该列）
      client.invoke<{ devicePubkeyB64: string; remainingMs: number; expired: boolean }[]>('delegation_status_by_device')
        .then((list) => {
          const m: DelegByDevice = {}
          for (const d of list ?? []) m[d.devicePubkeyB64] = { remainingMs: d.remainingMs, expired: d.expired }
          setDelegByPub(m)
        })
        .catch(() => {})
      setDevices(devs ?? [])
      setRoots(rts ?? [])
      setRoster((ov?.devices ?? []).filter((d) => !d.revoked))
      // 外来账号分组名：本地没备注的查云 /root/:did 解析（回写缓存，下轮 refresh 即有名）
      const foreign = [...new Set((devs ?? []).map((d) => d.ownerRootDid).filter((x): x is string => !!x && x !== myYoulingDid))]
      if (foreign.length > 0) {
        const names = await client.invoke<Record<string, string>>('resolve_myco_names', { rootDids: foreign })
        if (names && Object.keys(names).length > 0) setYoulingNames((prev) => ({ ...prev, ...names }))
      }
    } catch { /* 后端未就绪 */ }
  }
  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 3000)
    return () => clearInterval(t)
  }, [])

  const act = async (cmd: string, did: string) => {
    setBusy(did + cmd)
    try { await client.invoke(cmd, { did }) } catch { /* ignore */ }
    setBusy(null)
    void refresh()
  }
  // ── 作用域切换(design/08-identity/TWO-LAYER-AGENT-AUTH.md):点徽章切换;
  // 全量("*")状态点任何具体项=只留该项;最后一项取消=回到全量(与后端规整一致)。
  const SCOPE_LABELS: Record<string, string> = {
    '*': '全量',
    'desktop.view': '看桌面',
    'session.input': '控终端',
    'remote.out': '连出',
  }
  const toggleScope = async (d: MycoDevice, scope: string) => {
    const cur = d.scopes?.length ? d.scopes : ['*']
    let next: string[]
    if (scope === '*') {
      next = ['*']
    } else if (cur.includes('*')) {
      next = [scope]
    } else if (cur.includes(scope)) {
      next = cur.filter((s) => s !== scope)
      if (next.length === 0) next = ['*']
    } else {
      next = [...cur, scope]
    }
    setBusy(d.did + 'scopes')
    try { await client.invoke('set_device_scopes', { did: d.did, scopes: next }) } catch { /* ignore */ }
    setBusy(null)
    void refresh()
  }
  const revokeByOrigin = async (origin: string) => {
    setBusy(origin + 'revoke-origin')
    try { await client.invoke('revoke_origin', { origin }) } catch { /* ignore */ }
    setBusy(null)
    void refresh()
  }
  const toggle = async (d: MycoDevice) => {
    const allowed = d.authState === 'allowed'
    if (allowed) {
      // 关闭授权：立即生效
      setBusy(d.did + 'toggle')
      try { await client.invoke('set_device_auth', { did: d.did, allowed: false }) } catch { /* ignore */ }
      setBusy(null)
      void refresh()
    } else {
      // 开启授权：先选时限（不限/30分/1小时/24小时/自定义），不立即开
      setTtlFor(ttlFor === d.did ? null : d.did)
    }
  }
  const enableWith = async (d: MycoDevice, ttlMs?: number) => {
    setBusy(d.did + 'enable')
    setTtlFor(null)
    try { await client.invoke('set_device_auth', { did: d.did, allowed: true, ttlMs: ttlMs ?? null }) } catch { /* ignore */ }
    setBusy(null)
    void refresh()
  }
  // 限时授权的 TTL 选择面板挂在哪台设备下
  const [ttlFor, setTtlFor] = useState<string | null>(null)
  // 删除：两段确认后选级别——「断开本机授权」(只删本地白名单) 或「断开并从 账号除名」(同时名册吊销，需主设备)
  const [delFor, setDelFor] = useState<string | null>(null)
  const removeDevice = async (d: MycoDevice, alsoRoster: boolean) => {
    setBusy(d.did + 'del')
    setDelFor(null)
    try {
      if (alsoRoster) {
        try { await client.invoke('revoke_roster_device', { pubkeyB64: d.pubkeyB64 }) }
        catch (e) { setBusy(null); alert(`名册除名失败（本机授权未动）：${String(e)}`); return }
      }
      await client.invoke('remove_authorized_device', { did: d.did })
    } catch { /* ignore */ }
    setBusy(null)
    void refresh()
  }
  // 添加设备（DID 互换）：直接输入对方设备的 DID 调 add_device_by_did
  const [addOpen, setAddOpen] = useState(false)
  // 2026-10-06 问题2：添加区在列表底部展开，不自动滚动时下半被视口裁掉——展开后
  // 平滑滚入视野（block:'nearest' 最小滚动；inviteQr 异步到位面板再长高时补滚一次）。
  const addPanelRef = useRef<HTMLDivElement>(null)
  const [addDid, setAddDid] = useState('')
  const [addName, setAddName] = useState('')
  const [addErr, setAddErr] = useState<string | null>(null)
  // 2026-10-06 任务3：添加成功的正面反馈（addErr 只有错误通道——成功后面板即关，
  // 用户不知道「已添加并通知对方设备」）。亮 1.5s 成功条再自动收起。
  const [addOk, setAddOk] = useState<string | null>(null)
  const addDevice = async () => {
    // 2026-10-05：DID 完整性校验（长度窗+字母表）——残缺串（复制丢字）就地提示，不发请求
    if (!isValidDid(addDid.trim())) { setAddErr('DID 格式不对（长度/字符异常——复制时可能丢字，请重新复制）'); return }
    setAddErr(null)
    try {
      // 2026-10-06 场景②：重复添加检测——设备已在列表时提示"已在列表中（已重新通知）"，
      // 防止用户以为没加上而反复点（attest 服务端幂等，重复点安全但提示要区分）。
      const didNorm = addDid.trim()
      const already = devices.some((d) => d.did === didNorm || (d.did && didNorm && d.did.slice(-6) === didNorm.slice(-6)))
      const r = await client.invoke<{ delegationDelivered?: boolean } | null>('add_device_by_did', { did: didNorm, name: addName.trim(), ownerRootDid: null })
      const delivered = r?.delegationDelivered !== false
      // 2026-10-06：成功提示加大+延长（原 10px 小字+1.5s 收起=等于没有，用户实测看不到）——
      // 绿色突出块保留 4.5s 可见，面板不立即收（用户看清成功态）；设备列表已 refresh 高亮。
      setAddOk(already
        ? `该设备已在列表中（已重新通知对方）`
        : delivered
          ? `✓ 已添加${addName.trim() ? `「${addName.trim()}」` : '设备'}并通知对方（对方上线后自动收下）`
          : '✓ 已添加（对方通知投递失败——再点一次「添加设备」可补投）')
      setAddDid(''); setAddName('')
      setTimeout(() => { setAddOk(null); setAddOpen(false) }, 4500)
    } catch (e) { setAddErr(String(e)) }
    void refresh()
  }
  const renameDevice = async (did: string, name: string) => {
    // 2026-10-13：原先 `catch { /* ignore */ }` 静默吞——命令当时根本没注册（幽灵 invoke），
    // 改名看着像成功其实没落盘。Rust 侧补齐后改为**失败必出声**（返回 false=该 did 不在本机白名单）。
    try {
      const ok = await client.invoke<boolean>('rename_authorized_device', { did, name })
      if (ok === false) alert('改名失败：该设备不在本机白名单（可先「添加设备」收编后再改）')
    } catch (e) {
      alert(`改名失败：${String(e)}`)
    }
    void refresh()
  }
  // 扫码添加：摄像头实时扫（可用时）或从图片识别 → 预填，确认后才真添加
  const qrFileRef = useRef<HTMLInputElement>(null)
  const [scanOpen, setScanOpen] = useState(false)
  /* 摄像头入口预检（2026-09-30 用户实测实测问题：PC 无摄像头=常态，不该让用户点到红错页）：
     API 存在 + enumerateDevices 真有 videoinput 才显示「摄像头扫码」链接；
     探测失败/无设备=隐藏（图片识别兜底保留）。真有摄像头但 getUserMedia 失败才进 QrCamera err 分支。 */
  const [liveScan, setLiveScan] = useState(false)
  useEffect(() => {
    let dead = false
    ;(async () => {
      try {
        if (!canLiveScan()) return
        const ds = await navigator.mediaDevices.enumerateDevices()
        if (!dead) setLiveScan(ds.some((d) => d.kind === 'videoinput'))
      } catch { /* 枚举失败保持隐藏，图片识别兜底 */ }
    })()
    return () => { dead = true }
  }, [])
  const applyScanned = (text: string) => {
    setScanOpen(false)
    const p = parseAddPayload(text)
    if (!p) { setAddErr('没识别出有效的设备 DID 二维码'); return }
    setAddDid(p.did)
    if (p.name) setAddName(p.name)
    setAddErr(null)
  }
  const onPickQrFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    const text = await decodeQrFromFile(f)
    if (text) applyScanned(text)
    else setAddErr('图片里没识别出二维码')
  }
  // 出示邀请码（方向 B）：新设备扫这个码 → 它把 DID+nonce 投进本机信箱 → 这里确认
  // inviteKind：'invite'=邀请码（invite 信箱后端在位，env exe）；'did'=降级出示本机 DID 码
  // （2026-09-30 修：loginer(home) exe 没有 invite_start/pair_requests 命令，原实现 catch
  //  静默吞错 → 点「出示码」毫无反应。降级路径=出示 myco-add DID 码，对方用 myco
  //  「账号 → 添加设备 → 扫码添加」扫它把本机加进对方设备列表——DID 互换即唯一添加路径）
  const [inviteMode, setInviteMode] = useState(false)
  const [inviteKind, setInviteKind] = useState<'invite' | 'did'>('invite')
  const [inviteQr, setInviteQr] = useState<string | null>(null)  // QR 载荷文本
  /** 邀请码已复制提示（2026-10-09 用户实测：邀请码 JSON 约 150 字符 → 二维码过密，
   *  手机扫常识别不全并报"没识别出有效的二维码"；手机侧本就有「粘贴邀请码文本」入口，
   *  复制粘贴比跟摄像头较劲可靠）。 */
  const [inviteCopied, setInviteCopied] = useState(false)
  const [pairReqs, setPairReqs] = useState<{ did: string; name: string; dev?: string; ts: number }[]>([])
  const [justAdded, setJustAdded] = useState<string | null>(null)  // 刚批准的设备名（自动收起前的成功反馈）
  // 2026-10-09 用户实测：点通过后确认卡还在——合并式轮询的 `keep` 只过滤超时，
  // **没排已处理的 did**；若服务端 drain 再返回同一条（dismiss 未即时生效）→ 又加回。
  // 修：已处理集合（批准/忽略即记），轮询永不再加回。
  const handledRef = useRef<Set<string>>(new Set())
  // 批准成功飘字（全局 toast，不依赖 addOpen 面板——用户在常驻卡上点批准也要看到反馈）
  const [devToast, setDevToast] = useState<string | null>(null)
  const startInvite = async () => {
    try {
      const { nonce, exp } = await client.invoke<{ nonce: string; exp: number }>('invite_start')
      setInviteKind('invite')
      // 2026-10-09 用户实测：邀请码 JSON 约 150 字符 → 二维码过密，手机镜头识别不全
      // （"没识别出有效的二维码"）。**载荷精简**（短字段名 + did 去 `did:myco:` 前缀，
      // 约 150→90 字符）+ 下方二维码放大到 240px，双管齐下让摄像头可用。
      // 手机端 parseQrPayload 同时兼容本精简格式与旧 `myco-invite` 全名格式。
      setInviteQr(JSON.stringify({
        t: 'i',
        d: compactDid(localDid),
        n: nonce,
        e: exp,
        ...(nicknameValue(myYoulingName) ? { m: nicknameValue(myYoulingName) } : {}),
      }))
      setInviteMode(true)
    } catch {
      // invite 信箱后端不在本 exe（Tauri 拒 unknown command）→ 降级出示本机 DID 码，不再静默
      setInviteKind('did')
      setInviteQr(JSON.stringify({ t: 'a', d: compactDid(localDid), m: '我的电脑' }))
      setInviteMode(true)
    }
  }
  const stopInvite = async () => {
    setInviteMode(false); setInviteQr(null); setPairReqs([])
    try { await client.invoke('invite_stop') } catch { /* ignore */ }
  }
  // 邀请中：轮询配对申请（2s）
  // 2026-10-09 用户实测：pair_requests 走 /signal/drain（**一次性取走信箱**）——
  // 第一次轮询取到申请 → 显示确认卡 → **2s 后下一轮信箱空了** → pairReqs 被覆盖为空 →
  // 确认卡瞬间消失（用户没来及点"通过"）。改**合并式**：新申请加入，已存在的保留
  // （直到用户确认/拒绝/超时 5 分钟——与邀请码有效期一致）。
  useEffect(() => {
    if (!inviteMode) return
    const t = setInterval(async () => {
      try {
        const fresh = await client.invoke<{ did: string; name: string; dev?: string; ts: number }[]>('pair_requests')
        setPairReqs((prev) => {
          const now = Date.now()
          const seen = new Set(prev.map((r) => r.did))
          // 超时过滤只在 ts 有效时（ts>0 且未超 5 分钟）；ts=0（旧数据/缺失）不过滤
          const keep = prev.filter((r) => r.ts === 0 || now - r.ts < 300_000)
          // 已处理（批准/忽略）的 did 永不再加回（2026-10-09：防"点通过后确认卡还在"）
          const add = fresh.filter((r) => !seen.has(r.did) && !handledRef.current.has(r.did))
          return [...keep, ...add]
        })
      } catch { /* ignore */ }
    }, 2000)
    return () => clearInterval(t)
  }, [inviteMode])
  // 2026-10-06 问题2：展开后自动滚入视野——添加区在设备列表底部，不滚动时展开区
  // 一半被视口下缘裁掉（用户实测）。rAF 等面板渲染完再滚；inviteQr 异步到位
  // （面板再长高）也补滚一次，block:'nearest'=最小滚动量不打断用户当前位置。
  useEffect(() => {
    if (!addOpen) return
    const raf = requestAnimationFrame(() => {
      addPanelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(raf)
  }, [addOpen, inviteQr])
  const approvePairReq = async (did: string, name: string) => {
    handledRef.current.add(did)   // 已处理——轮询永不再加回（2026-10-09）
    try {
      // pair 申请已经设备钥签名证明持有（nonce 校验过）→ 直接 Allowed，无需再等首连转正（避免"确认两次"）
      await client.invoke('add_device_by_did', { did, name, ownerRootDid: null, verified: true })
      await client.invoke('pair_request_dismiss', { did })
      const left = pairReqs.filter((x) => x.did !== did)
      setPairReqs(left)
      // 2026-10-09 用户要求：飘字提示加成功了（全局 toast，不只面板内）
      setDevToast(`✓ 已添加「${name || '新设备'}」`)
      setTimeout(() => setDevToast(null), 2600)
      // 最后一条申请批完 → 亮一下"已添加"就自动收起（免再手动点「完成」）
      if (left.length === 0) {
        setJustAdded(name || '新设备')
        setTimeout(() => { setJustAdded(null); setAddOpen(false); void stopInvite() }, 1200)
      }
    } catch { handledRef.current.delete(did); /* 失败可重试 */ }
    void refresh()
  }
  // 2026-10-13 P1 去重：原「名册成员（未授权本机）」浏览块（rosterErr / authorizeRosterMember /
  // revokeRosterMember）已整体下线——「设备名单浏览 + 在线态」让给底部「🤖 智能体」Tab
  // （AgentDevices：授权本机=add_device_by_did、除名=device_revoke，两条管理动作已在那里）。
  // 名册数据仍拉取：groupKey 用它把"白名单有、归属为空"的历史条目归回本账号组。
  // 外来 账号名片编辑（别名+备注，只存本地）
  const [editAccount, setEditAccount] = useState<string | null>(null)
  const renameAccountAlias = async (rootDid: string, name: string) => {
    try { await client.invoke('rename_trusted_root', { rootDid, name }) } catch { /* ignore */ }
    void refresh()
  }
  const saveAccountNote = async (rootDid: string, note: string) => {
    try { await client.invoke('set_root_note', { rootDid, note }) } catch { /* ignore */ }
    void refresh()
  }

  const pending = devices.filter((d) => d.authState === 'pending')
  const settled = devices.filter((d) => d.authState !== 'pending')
  // 2026-10-13 P1：原 rosterExtras（名册有、白名单没有的成员浏览列表）已下线——整块移到
  // 「🤖 智能体」Tab；本页不再渲染名册浏览（含它的在线点）。

  // 按归属账号 分组（自己的在最前）
  const rootName = (rdid: string | null | undefined): string => {
    if (!rdid) return '未分组'
    if (rdid === myYoulingDid) return nicknameValue(myYoulingName) || '我的账号'
    return roots.find((r) => r.rootDid === rdid)?.name || accountNames[rdid] || `账号 …${rdid.slice(-4)}`
  }
  const groupKey = (d: MycoDevice) => {
    if (d.ownerRootDid) return d.ownerRootDid
    // 归属为空但在本 账号名册里（历史记录）→ 归本 账号组（新添加的已在后端回填）
    if (roster.some((r) => r.did === d.did)) return ownKey
    return '__none__'
  }
  // 注意：ownKey 必须先于分组循环声明——groupKey 里引用它，声明在循环后会 TDZ（"Cannot access before initialization"）
  const ownKey = myYoulingDid ?? '__local__'
  const groups: { key: string; name: string; devices: MycoDevice[] }[] = []
  for (const d of settled) {
    const k = groupKey(d)
    let g = groups.find((x) => x.key === k)
    if (!g) { g = { key: k, name: rootName(d.ownerRootDid), devices: [] }; groups.push(g) }
    g.devices.push(d)
  }
  // 本机并入自己的 账号组（组头只出现一次；没有该组则补一个空组放本机）
  if (localDid && !groups.find((g) => g.key === ownKey)) {
    groups.push({ key: ownKey, name: nicknameValue(myYoulingName) || '我的账号', devices: [] })
  }
  // 自己的 账号组排最前
  groups.sort((a, b) => (a.key === ownKey ? -1 : b.key === ownKey ? 1 : a.name.localeCompare(b.name)))

  return (
    <section className="cardd" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* 2026-10-01 重排：标题旁括号注本机角色（可管理/只读，对应 embodiment/agent 语义）；
          自己账号的组名孤行已删（账号名在顶部账号卡，组行无上下文重复）。 */}
      <div className="h2d" style={{ fontSize: 12.5 }}>📱 我的设备
        <span className="tinyd" style={{ fontWeight: 400, marginLeft: 6 }}>{isEmbodiment ? '（主设备，可管理）' : '（成员，只读）'}</span>
      </div>

      {/* ① 待放行（demo approve 屏形态：设备信息卡+说明+拒绝/确认授权按钮行） */}
      {pending.length > 0 && (
        <>
        <div className="h2d" style={{ fontSize: 14 }}>新设备请求加入</div>
        {pending.map((d) => (
          <div key={d.did} className="cardd">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ width: 38, height: 38, borderRadius: 10, background: '#eef2ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19, flexShrink: 0 }}>{/phone|手机|iphone|android/i.test(d.name) ? '📱' : '💻'}</span>
              <span style={{ minWidth: 0 }}>
                <div className="h2d" style={{ fontSize: 14 }}>{d.name || '未命名设备'}</div>
                <div style={{ fontFamily: 'ui-monospace,monospace', fontSize: 10.5, color: '#8a97ab' }}>…{d.did.slice(-4)}{d.clientIp ? ` · ${shortAddr(d.clientIp)}` : ''}</div>
              </span>
            </div>
            <div className="tinyd" style={{ marginTop: 8 }}>确认后这台设备成为「{rootName(d.ownerRootDid)}」的<b>成员</b>：可扫码确认网页登录、可接任务干活。随时可在设备列表除名，立即生效。</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btnd ghost" style={{ flex: 1 }} onClick={() => act('reject_device', d.did)} disabled={busy !== null}>拒绝</button>
              <button className="btnd" style={{ flex: 2 }} onClick={() => act('confirm_device', d.did)} disabled={busy !== null}>✓ 确认授权</button>
            </div>
          </div>
        ))}
        </>
      )}

      {/* ③ 已分组设备（本机并入自己的 账号组首位——组头只列一次） */}
      {settled.length === 0 && pending.length === 0 && !localDid && (
        <div className="tinyd" style={{ padding: '2px 0' }}>暂无设备。点下方「＋ 添加设备」加入。</div>
      )}
      {groups.map((g) => (
        <div key={g.key} className="space-y-1.5">
          {/* 组头只渲染非自己账号的组（外来账号组名有上下文+✎ 编辑功能）；
              自己账号组=标题下的设备直接列出（组名=账号名已在顶部卡，孤行删除）。 */}
          {g.key !== ownKey && (
          <div className="flex items-center gap-1.5 px-1">
            <span className="text-[11px] font-semibold text-[var(--text-secondary)]">{g.name}</span>
            {g.key !== '__none__' && (
              <>
                <span className="text-[9px] text-[var(--text-muted)]">· 其下设备需逐个放行</span>
                <button onClick={() => setEditAccount(editAccount === g.key ? null : g.key)} title="别名/备注（只存本地）"
                  className="ml-auto text-[10px] text-[var(--text-muted)] hover:text-[var(--accent)]">✎</button>
              </>
            )}
          </div>
          )}
          {/* 外来 账号名片编辑：别名（聊天作者名/分组头都用它）+ 备注（只存本地 trusted-roots.json） */}
          {editAccount === g.key && (
            <div className="rounded-md border border-[var(--chrome-border)] bg-white/60 px-2.5 py-2 space-y-1.5">
              <input defaultValue={roots.find((r) => r.rootDid === g.key)?.name ?? g.name} placeholder="别名（聊天里显示的名）"
                onBlur={(e) => { const v = e.target.value.trim(); if (v) void renameAccountAlias(g.key, v) }}
                className="w-full h-7 px-2 text-[11px] bg-white border border-[var(--chrome-border)] rounded focus:outline-none focus:border-[var(--accent)]" />
              <input defaultValue={roots.find((r) => r.rootDid === g.key)?.note ?? ''} placeholder="备注（这是谁/怎么认识的，只存本机）"
                onBlur={(e) => void saveAccountNote(g.key, e.target.value.trim())}
                className="w-full h-7 px-2 text-[11px] bg-white border border-[var(--chrome-border)] rounded focus:outline-none focus:border-[var(--accent)]" />
            </div>
          )}
          {(() => { const note = roots.find((r) => r.rootDid === g.key)?.note; return note && editAccount !== g.key ? <div className="px-1 text-[10px] text-[var(--text-muted)]">{note}</div> : null })()}
          {/* 本机：自己 账号组的首位（不可开关——它就是这台机器） */}
          {g.key === ownKey && localDid && (
            <ExpandableRow
              summary={
                <>
                  <Monitor size={14} className="shrink-0 text-[var(--text-muted)]" />
                  <span className="text-[12px] font-medium text-[var(--text-primary)]">本机</span>
                  <span className="text-[9px] font-mono text-[var(--text-muted)] shrink-0 select-text">{shortDid(localDid)}</span>
                  {/* 2026-10-13 P1：只读在线点（●在线）已从账号页移除——在线态统一在
                      底部「🤖 智能体」Tab 呈现（AgentDevices）。 */}
                </>
              }
              details={<DidLine value={localDid} />}
            />
          )}
          {g.devices.map((d) => {
            const c = carrierOf(d.lastAddr)
            return (
              <div key={d.did}>
              <ExpandableRow
                summary={
                  <span className="flex w-full min-w-0 flex-col gap-0.5">
                    {/* 2026-11-15 用户实拍整改：窄窗下单行塞 名称+DID+徽标+开关 → 名称被压成「DE…」。
                        改为两行：第一行 图标+完整名称+开关；第二行 DID/连接/委任状等徽标。 */}
                    <span className="flex w-full min-w-0 items-center gap-1.5">
                      <span className="shrink-0 text-[var(--text-muted)]">
                        {/phone|手机|iphone|android|华为|npn|dd9f/i.test(d.name + ' ' + d.did) ? <Smartphone size={14} /> : <Monitor size={14} />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text-primary)]" title={d.name || '未命名'}>{d.name || '未命名'}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-1.5">
                        {d.authState === 'denied' && <span className="text-[9px] px-1 rounded bg-red-100 text-[#ff8a80]">已拒</span>}
                        <button onClick={(e) => { e.stopPropagation(); void toggle(d) }} disabled={busy !== null} title={d.authState === 'allowed' ? '关闭授权' : '放行（可选时限）'}
                          style={{ width: 32, height: 16, borderRadius: 9999, padding: 0, border: 'none', background: d.authState === 'allowed' ? '#10b981' : 'var(--chrome-border)' }}
                          className="relative shrink-0 transition-colors">
                          <span className="absolute rounded-full bg-white transition-transform"
                            style={{ width: 12, height: 12, top: 2, left: 2, transform: d.authState === 'allowed' ? 'translateX(16px)' : 'none' }} />
                        </button>
                      </span>
                    </span>
                    <span className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden">
                      <span className="min-w-0 truncate font-mono text-[9px] text-[var(--text-muted)] select-text">{shortDid(d.did)}</span>
                      {/* 2026-11-15 vnet 需求：连接状态标记（⚡直连/🔄中转 + RTT），5s 轮询 */}
                      {vnetPeer[d.did] && (
                        <span className="shrink-0 rounded px-1 font-mono text-[9px]"
                          style={{
                            background: vnetPeer[d.did].direct ? 'rgba(16,185,129,0.12)' : 'rgba(245,158,11,0.12)',
                            color: vnetPeer[d.did].direct ? '#059669' : '#d97706',
                          }}
                          title={`传输路径: ${vnetPeer[d.did].path}${vnetPeer[d.did].rttMs != null ? ` · RTT ${vnetPeer[d.did].rttMs}ms` : ''}`}>
                          {vnetPeer[d.did].direct ? '⚡直连' : '🔄中转'}{vnetPeer[d.did].rttMs != null ? ` ${vnetPeer[d.did].rttMs}ms` : ''}
                        </span>
                      )}
                      {d.origin && <span className="shrink-0 rounded bg-[var(--chrome-border)]/60 px-1 text-[9px] text-[var(--text-muted)]">{d.origin}</span>}
                      {!(d.scopes?.length ? d.scopes : ['*']).includes('*') && (
                        <span className="shrink-0 rounded bg-violet-100 px-1 text-[9px] text-violet-700" title="受限作用域(展开可调)">限权限</span>
                      )}
                      {delegByPub[d.pubkeyB64] && (
                        <span className="shrink-0 rounded px-1 text-[9px] font-semibold"
                          style={{ color: delegDaysLeft(delegByPub[d.pubkeyB64].remainingMs).color }}
                          title="本设备委任状（授权）剩余有效期">
                          {delegDaysLeft(delegByPub[d.pubkeyB64].remainingMs).label}
                        </span>
                      )}
                    </span>
                  </span>
                }
                details={
                  <>
                    <DidLine value={d.did} />
                    <div className="text-[10px] text-[var(--text-muted)]">归属: {rootName(d.ownerRootDid)}{d.origin ? ` · 来源: ${d.origin}` : ''}</div>
                    {/* 作用域徽章:点亮=持有;全量态点具体项=只留该项 */}
                    <div className="flex items-center gap-1 flex-wrap pt-0.5">
                      <span className="text-[10px] text-[var(--text-muted)]">权限:</span>
                      {Object.entries(SCOPE_LABELS).map(([sc, label]) => {
                        const cur = d.scopes?.length ? d.scopes : ['*']
                        const on = cur.includes(sc)
                        return (
                          <button key={sc} onClick={() => void toggleScope(d, sc)} disabled={busy !== null}
                            title={sc === '*' ? '全量(所有作用域)' : `作用域 ${sc}`}
                            /* 2026-11-15 用户实拍：全局 .sec button 的 padding/字号覆盖 tailwind，
                               徽标互相重叠——改内联样式根治（与 ExpandableRow 同一手法）。 */
                            style={{
                              height: 22, padding: '0 8px', fontSize: 10, lineHeight: '20px',
                              borderRadius: 9999, border: '1px solid',
                              background: on ? '#ede9fe' : '#fff',
                              borderColor: on ? '#c4b5fd' : 'var(--chrome-border)',
                              color: on ? '#6d28d9' : 'var(--text-muted)',
                            }}>{label}</button>
                        )
                      })}
                    </div>
                    {d.origin && (
                      <button onClick={() => void revokeByOrigin(d.origin as string)} disabled={busy !== null}
                        title={`吊销来源「${d.origin}」名下全部 agent(丢设备一键清)`}
                        style={{ height: 22, padding: '0 8px', fontSize: 10, lineHeight: '20px', borderRadius: 4, border: '1px solid #fecaca', background: '#fff', color: '#ff8a80' }}>
                        吊销「{d.origin}」全部授权
                      </button>
                    )}
                    <input defaultValue={d.name} placeholder="备注名"
                      onBlur={(e) => { const v = e.target.value.trim(); if (v !== (d.name || '')) void renameDevice(d.did, v) }}
                      /* 2026-11-15 实拍：全局 input 样式把它撑成巨块——内联收紧。 */
                      style={{ width: '100%', height: 28, padding: '0 8px', fontSize: 11, lineHeight: '26px', border: '1px solid var(--chrome-border)', borderRadius: 6, background: '#fff' }} />
                    <div className="text-[10px] text-[var(--text-muted)]">
                      {relTime(d.lastSeen) && relTime(d.lastSeen) + '活跃' || '从未活跃' }{d.lastAddr ? ` · ${shortAddr(d.lastAddr)}${c ? `/${c}` : ''}` : ''} · {new Date(d.addedAt).toLocaleDateString('zh-CN')} 添加
                    </div>
                    <div className="flex items-center justify-between pt-1 border-t border-[var(--chrome-border)]/60">
                      <span className="text-[10px] text-amber-700">{expiryText(d)}</span>
                      <span className="flex items-center gap-1">
                        {delFor === d.did ? (
                          <span className="flex flex-col items-end gap-1">
                            <span className="flex items-center gap-1.5">
                              <button onClick={() => void removeDevice(d, false)} disabled={busy !== null} title="它连不上本机了，但仍是账号成员"
                                style={{ height: 22, padding: '0 8px', fontSize: 10, lineHeight: '20px', borderRadius: 4, border: 'none', background: '#d97706', color: '#fff' }}>断开本机授权</button>
                              {isEmbodiment && d.ownerRootDid === myYoulingDid && (
                                <button onClick={() => void removeDevice(d, true)} disabled={busy !== null} title="名册吊销——它不再是这个账号的设备（手机丢了/退役用这个）"
                                  style={{ height: 22, padding: '0 8px', fontSize: 10, lineHeight: '20px', borderRadius: 4, border: 'none', background: '#dc2626', color: '#fff' }}>断开并从账号除名</button>
                              )}
                              <button onClick={() => setDelFor(null)} style={{ height: 22, padding: '0 8px', fontSize: 10, lineHeight: '20px', borderRadius: 4, border: '1px solid var(--chrome-border)', background: '#fff', color: 'var(--text-muted)' }}>取消</button>
                            </span>
                          </span>
                        ) : (
                          <button onClick={() => setDelFor(d.did)} title="删除此设备记录（可重新配对）"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 22, padding: '0 8px', fontSize: 10, lineHeight: '20px', borderRadius: 4, border: 'none', background: 'transparent', color: 'var(--text-muted)' }}>
                            <Trash2 size={11} /> 删除设备
                          </button>
                        )}
                      </span>
                    </div>
                  </>
                }
              />
              {/* 开启授权的时限选择（点开关 ON 时展开；到期自动回禁用，不删除） */}
              {ttlFor === d.did && (
                <div className="mt-1 rounded-md border border-emerald-200 bg-emerald-50/70 px-2.5 py-2">
                  <div className="text-[10px] text-emerald-800 mb-1.5">放行「{d.name || '未命名'}」多久？到时间自动回禁用（不删除）</div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {TTL_PRESETS.map((p) => (
                      <button key={p.label} onClick={() => void enableWith(d, p.ms)} disabled={busy !== null}
                        className="h-6 px-2 text-[11px] rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">{p.label}</button>
                    ))}
                    <span className="flex items-center gap-1 text-[11px] text-emerald-800">
                      <input id={`ttl-${d.did}`} type="number" min={1} placeholder="N" style={{ width: 44 }}
                        className="h-6 px-1 text-[11px] bg-white border border-emerald-300 rounded text-center" />
                      小时
                      <button onClick={() => {
                        const v = Number((document.getElementById(`ttl-${d.did}`) as HTMLInputElement)?.value)
                        if (v > 0) void enableWith(d, v * 3600_000)
                      }} disabled={busy !== null}
                        className="h-6 px-2 text-[11px] rounded-md border border-emerald-600 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">自定义</button>
                    </span>
                  </div>
                </div>
              )}
              </div>
            )
          })}
          {/* 2026-10-13 P1：「名册成员（未授权本机）」浏览块整块下线——设备名单浏览与在线态
              归底部「🤖 智能体」Tab（AgentDevices 同名册 + 在线态 + 授权本机/除名动作），
              本页不再重复渲染（原读法："手机看 5 台、PC 看 1 台"的合流视图由该 Tab 承担）。 */}
        </div>
      ))}

      {/* ④ 添加设备（微信互扫式）：我的识别码（邀请码/本机DID码） | 添加识别码（图片识别/粘贴）
          2026-10-06 问题4 重构：tab 切换器与内容标题分层（.adddev-tabs / .adddev-title），样式
          全部由 demo.css .adddev-* 类承载——home.css `.sec button`(0,1,1) 的 13px 字+8px 纵 padding
          曾压掉 tailwind h-7/text-[11px]，tab 文字溢出与下方标题重叠（用户截图"山寨"根因）。 */}
      {localDid && (
        <div className="pt-1">
          {!addOpen ? (
            <button className="btnd ghost" onClick={() => { setAddOpen(true); void startInvite() }}>＋ 添加设备</button>
          ) : (
            <div ref={addPanelRef} className="adddev-panel">
              <div className="adddev-tabs">
                <button className={inviteMode ? 'on' : ''} onClick={() => void startInvite()}>我的识别码</button>
                <button className={!inviteMode ? 'on' : ''} onClick={() => void stopInvite()}>添加识别码</button>
              </div>

              {inviteMode && inviteQr ? (
                inviteKind === 'invite' ? (
                <div className="adddev-body">
                  {/* 我的识别码面板：全部居中对齐（标题/码/状态），申请卡为全宽卡——第51轮 K3 审计整改 */}
                  <div className="adddev-title">邀请码 · 5 分钟内有效</div>
                  <div className="adddev-sub">新设备用 myco 扫这个码申请加入</div>
                  <div className="adddev-qr">
                    {/* 2026-10-09：160→240px。二维码能否被手机扫到主要看**每模块像素**——
                        160px 对 ~45 模块只有 3.5px/模块（手机镜头常识别不全），240px 约 5.9px。 */}
                    <QrImage text={inviteQr} size={240} />
                  </div>
                  {/* 2026-10-09 用户实测补：邀请码文本可复制（手机侧有「粘贴邀请码文本」入口）
                      ——二维码约 150 字符偏密，手机镜头常识别不全并报"没识别出有效的二维码"；
                      复制粘贴比跟摄像头较劲可靠。 */}
                  {inviteQr && (
                    <>
                      <button className="btnd ghost" style={{ marginTop: 6, width: '100%' }}
                        onClick={() => {
                          void navigator.clipboard.writeText(inviteQr).then(() => {
                            setInviteCopied(true)
                            setTimeout(() => setInviteCopied(false), 2500)
                          }).catch(() => setInviteCopied(false))
                        }}>
                        {inviteCopied ? '✓ 已复制——去手机「扫主设备的码」页粘贴' : '📋 复制邀请码（手机粘贴用，比扫码可靠）'}
                      </button>
                      <details className="adddev-alt">
                        <summary>不方便复制？展开邀请码文本手动抄</summary>
                        <div style={{ wordBreak: 'break-all', fontSize: 10, fontFamily: 'ui-monospace,monospace', padding: '6px 2px', textAlign: 'left' }}>{inviteQr}</div>
                      </details>
                    </>
                  )}
                  {pairReqs.length > 0 && <div className="adddev-reqhead">收到申请（核对设备信息后再添加）：</div>}
                  {pairReqs.map((r) => (
                    <div key={r.did} className="adddev-req">
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 text-[var(--text-muted)]">
                          {/phone|手机|iphone|android|ipad|小米|华为|vivo|oppo|redmi/i.test(r.dev || r.name) ? <Smartphone size={13} /> : <Monitor size={13} />}
                        </span>
                        <span className="text-[11px] font-medium text-[var(--text-primary)] truncate flex-1">{r.name || '新设备'}</span>
                        <span className="shrink-0 text-[9px] text-[var(--text-muted)]">{relTime(r.ts)}</span>
                        <button className="adddev-approve" onClick={() => void approvePairReq(r.did, r.name)}>添加</button>
                        <button className="adddev-icon" onClick={() => { handledRef.current.add(r.did); void client.invoke('pair_request_dismiss', { did: r.did }).then(() => setPairReqs((xs) => xs.filter((x) => x.did !== r.did))) }}><Trash2 size={11} /></button>
                      </div>
                      {r.dev && <div className="text-[10px] text-[var(--text-muted)]">{r.dev}</div>}
                      <DidLine value={r.did} />
                    </div>
                  ))}
                  {justAdded
                    ? <div className="text-[10px] text-emerald-700 text-center pt-0.5">✓ 已添加「{justAdded}」，自动收起…</div>
                    : pairReqs.length === 0 && (
                      <div className="adddev-wait"><span className="pulse" />等待新设备扫这个码申请…</div>
                    )}
                  {/* 本机要加入别人的账号：出示本机 DID 码（次要路径，折叠；顶部分隔线与主路径区隔） */}
                  <details className="adddev-alt">
                    <summary>本机要加入别人的账号？出示本机 DID 码</summary>
                    <div className="pt-1.5 pb-0.5" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <QrImage text={JSON.stringify({ v: 1, type: 'myco-add', did: localDid })} size={130} />
                      <div className="text-center text-[9px] text-[var(--text-muted)] mt-1">对方扫这个码把本机加进它的设备列表</div>
                    </div>
                  </details>
                  <button className="adddev-done" onClick={() => { setAddOpen(false); void stopInvite() }}>完成</button>
                </div>
                ) : (
                <div className="adddev-body">
                  {/* 降级出示码（invite 信箱后端不在本 exe——loginer/home）：本机 DID 码，
                      对方用 myco「账号 → 添加设备 → 添加识别码」扫这个码把本机加进对方设备列表。
                      与 App.tsx 我的识别码屏（pageView='show'）同一载荷格式 myco-add。 */}
                  <div className="adddev-title">本机识别码（DID 码）</div>
                  <div className="adddev-sub">对方用 myco「账号 → 添加设备 → 添加识别码」扫这个码，把本机加进对方的设备列表</div>
                  <div className="adddev-qr">
                    <QrImage text={inviteQr} size={160} />
                  </div>
                  <ExpandableRow
                    summary={<span style={{ fontSize: 11, color: 'var(--accent)' }}>不方便扫这个码？复制识别码 ▸</span>}
                    details={
                      <>
                        {/* 短句两段 + DID 行（2026-09-30 用户实测：原长句啰嗦读不动）；
                            字色用 --text-secondary(#565b6b,≈7:1) 而非 tinyd 的 --mu(#9aa0b0,≈2.8:1)——小字要够黑 */}
                        <div style={{ fontSize: 11, lineHeight: 1.55, color: 'var(--text-secondary)' }}>把这个识别码发给对方</div>
                        <DidLine value={localDid} />
                        <div style={{ fontSize: 11, lineHeight: 1.55, color: 'var(--text-secondary)' }}>对方在「添加设备 → 添加识别码」里粘贴即可</div>
                      </>
                    }
                  />
                  <button className="adddev-done" onClick={() => { setAddOpen(false); void stopInvite() }}>完成</button>
                </div>
                )
              ) : (
                <div className="adddev-body">
                  {/* 添加识别码 · PC 优先形态（2026-09-30 设计定稿）：粘贴识别码=主操作（第一视觉焦点），
                      摄像头/从图片识别=底部次要链接。通道次序由 scanAddOrder 契约驱动（ui-kit 单一源，
                      手机端 Pairing 同契约反向：摄像头主/粘贴次）。 */}
                  {scanOpen && <QrCamera onResult={applyScanned} onClose={() => setScanOpen(false)} />}
                  {/* 2026-10-06 问题3 定稿文案：指引从对方 myco「我的设备 → 我的识别码」复制 */}
                  <div className="adddev-guide">从对方 myco「我的设备 → 我的识别码」复制，粘贴到这里：</div>
                  {/* 2026-10-06：粘贴框改 textarea——did 码 48+ 字符单行 input 局促丑陋
                      （用户实测），改 2 行高折行显示完整识别码，便于核对 */}
                  <textarea value={addDid} onChange={(e) => setAddDid(e.target.value)} placeholder="粘贴设备识别码（did:myco:…）" rows={2}
                    className="w-full font-mono select-text adddev-didta"
                    style={{ borderColor: addDid && !isValidDid(addDid) ? '#e5534b' : undefined }} />
                  {addDid && !isValidDid(addDid) && (
                    <div className="text-[10px]" style={{ color: '#e65100', lineHeight: 1.5 }}>DID 格式不对（长度/字符异常——复制时可能丢字，请重新复制）</div>
                  )}
                  <input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="设备名（可选）" className="w-full" />
                  {addErr && <div className="text-[10px] text-[#ff8a80] text-center">{addErr}</div>}
                  {addOk && <div className="text-[11px] font-medium text-emerald-700 text-center" style={{ lineHeight: 1.5 }}>{addOk}</div>}
                  <button className="adddev-primary" onClick={() => void addDevice()} disabled={!isValidDid(addDid.trim())}>添加设备</button>
                  {/* 次要通道（降级链接+旁注，不抢视觉）：无摄像头环境「摄像头扫码」不显示，图片识别兜底保留。
                      2026-10-06 图标对齐（srow 垂直居中）+ 文案统一「识别码」词系 */}
                  <div className="adddev-secondary">
                    {scanAddSecondary('pc', liveScan).map((ch) => (
                      <div key={ch} className="srow">
                        {ch === 'camera' ? (
                          <>
                            <button className="linkish" onClick={() => { setScanOpen(true); setAddErr(null) }}>📷 摄像头识别</button>
                            <span className="note">手机/笔记本更方便</span>
                          </>
                        ) : (
                          <>
                            <button className="linkish" onClick={() => qrFileRef.current?.click()}>🖼 从图片识别</button>
                            <span className="note">对方发的识别码截图</span>
                          </>
                        )}
                      </div>
                    ))}
                    <input ref={qrFileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void onPickQrFile(e)} />
                    <div className="srow">
                      <button className="linkish dim"
                        onClick={() => { setAddOpen(false); setAddDid(''); setAddName(''); setAddErr(null) }}>取消</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {/* 批准成功飘字（2026-10-09 用户要求：点通过后要有"加成功了"的反馈） */}
      {devToast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 9999, padding: '9px 16px', borderRadius: 10, background: 'rgba(22,163,74,.95)', color: '#fff', fontSize: 12.5, fontWeight: 600, boxShadow: '0 4px 16px rgba(0,0,0,.25)', whiteSpace: 'nowrap' }}>{devToast}</div>
      )}
    </section>
  )
}
