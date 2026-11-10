/**
 * 登录 / 身份管理（有灵账号模型）——
 *  - enc 加密模式：先输本地密码解锁 → 自动注册+登录
 *  - plain 快速模式（默认）：零输入自动注册+登录
 *  - 账号面板：未关联 / 成员（只读）/ 主设备（全权管理）
 *  - 主设备列表点即连（任务页）
 *  - 设置：切换加密/快速模式、备份、了解工作原理
 *
 * 添加设备只有一条路（DID 互换，无配对码）：新设备出示本机 DID（自带公钥），
 * 主设备在 Myco 面板粘贴 DID 即签 attestation 上云；新设备轮询反查发现自己被收编。
 *
 * 用户文案/取舍见 design/08-identity/SOUL-MYCO-MODEL.md。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import type { PairMode } from '../App'
import {
  type PhoneIdentity, type PresenceNode, type DeviceWithStatus, type DeviceRole,
  ensureRegistered, listPresence, exportKeyB64,
  getStorageMode, unlockIdentity, disableEncryption,
  createRootIdentity, getRootIdentity, fetchYoulingOverview, setBackedUpCloud,
  fetchMyRoot, addDeviceByDid, pubkeyB64FromDid, importRootIdentity, getAttestation,
  sendPairRequest, drainPairInbox, clearAttestation, revokeRosterDevice,
  deviceRole, encryptRootSeedForBackup, listAccounts, switchAccount,
  claimEmbodiment, registerPresence, renameYouling, didFromPubkeyB64, unbindYouling,
  setYoulingNameCache, EXPLORE_URL, DID_BASE, rootSeedUnavailableReason, logoutYouling, deviceLogoutYouling, saveAccountName,
  accountDisplayName, accountShortLabel, accountTail, credText, nicknameValue } from '../identity'
import { openExplore } from '../explore'

/** 下载中心「其他工具」页（vnet 会话 2026-10-24 上线，静态页无登录）。
 *  2026-11-03 开源配置化：从 VITE_DOWNLOADS_URL 取，默认官方 youling.cc。 */
const TOOLS_URL = (((import.meta.env.VITE_DOWNLOADS_URL as string | undefined) || 'https://myco.youling.cc').replace(/\/+$/, '')) + '/downloads/tools.html'

/** 打开工具页：应用内浏览器优先（MycoShell 桥），否则系统浏览器。 */
function openTools() {
  try {
    const sh = (window as unknown as { MycoShell?: { openInAppBrowser?: (u: string, g?: string) => string } }).MycoShell
    if (sh && typeof sh.openInAppBrowser === 'function') {
      sh.openInAppBrowser(TOOLS_URL, '')
      return
    }
  } catch {
    /* 桥不可用 → 兜底 */
  }
  try { window.open(TOOLS_URL, '_blank', 'noopener') } catch { /* 放弃 */ }
}
import { type Transport, DirectHttpTransport, NotAuthorizedError, connectWebRtc } from '../transport'
import { QrCamera } from './QrCamera'
import { FriendsPanel, PeerTasksSection } from './FriendsPanel'
import { ensureBackgroundPoll } from '../chat-store'
import { QrImage } from './QrImage'
import { YoulingLogin } from './YoulingLogin'
import { buildAddPayload, parseAddPayload, parseQrPayload, decodeQrFromFile, canLiveScan } from '../qr'
import { scanAddPrimary } from '@myco/scanAddOrder'
// 备份码遮蔽状态机单一源（PC IdentityPanel 同款——10s 无操作/复制后 3s 自动遮蔽，重新显示=重导）
import { backupPanel, backupPanelInitial, backupIdleTimerOn, backupCopyTimerOn, BACKUP_MASK_IDLE_MS, BACKUP_MASK_AFTER_COPY_MS } from '@myco/backupMask'
import type { Delegation } from '../delegation'
import { IconPc, IconPhone, IconLaptop } from '@myco/Icons'
// 2026-10-06 凭据徽章图标（NAMING-RATIONALE 定稿：主设备=KeyRound / 成员=User，与 PC 同款）
import { KeyRound, User } from 'lucide-react'
// 2026-10-05 复制可靠性加固 + 手动输入 DID 实时校验
import { isValidDid, copyDidVerified, copyDidToastText } from '../didCheck'
// 2026-10-11 设计定稿：设备列表连接方式改「图标+文字」徽标（⚡直连/☁中转/旋转·连接中）
// ——与 PC/DSH 页面底部连接指示器（conn_status_snippet）同款设计。
import { ConnBadge, connBadgeMode } from './conn-badge'

/** 可作为连接目标的主设备（PC 或手机都可能——有 webrtc 能力或直连地址即可连）。 */
function isConnectableMain(n: PresenceNode): boolean {
  if (n.self) return false
  if (n.kind === 'pc') return true
  if (n.webrtc) return true                 // 手机作主设备（未来）也上报 webrtc
  if (!n.kind && n.addrs?.ipv6) return true // 兼容未上报 kind 的旧 PC
  return false
}


/** 备份素材导出（弹窗打开/重新显示时调一次；遮蔽即清——码不驻留内存/屏幕）：
 *  明文=seedB64，加密备份=三行 ct/salt/iv（与旧渲染/复制口径一致）。
 *  分身设备无根钥 → noRoot 提示态（无敏感内容，不参与遮蔽）。
 *  2026-10-08 用户实测修复：noRoot 再分**原因**——`locked`（加密模式未解锁，可自助
 *  解锁后备份）vs `not-main`（确实非主设备，管理去主设备）。此前一律显示"本机是成员
 *  设备"，主设备在加密模式下点备份会得到误导文案（用户："像玩用户一样"）。 */
function exportBackupText(): { seed: string; noRoot: boolean; noRootReason?: 'locked' | 'not-main' } {
  try {
    const m = encryptRootSeedForBackup('')
    return { seed: m.encrypted ? `ct=${m.ct}\nsalt=${m.salt}\niv=${m.iv}` : m.seedB64, noRoot: false }
  } catch { return { seed: '', noRoot: true, noRootReason: rootSeedUnavailableReason() ?? 'not-main' } }
}

/** 按 UA 猜机型名（QR 载荷里给主设备预填名字用）。 */
function guessDeviceName(did: string): string {
  const ua = navigator.userAgent
  let m = '手机'
  if (/iPhone/i.test(ua)) m = 'iPhone'
  else if (/iPad/i.test(ua)) m = 'iPad'
  else if (/Xiaomi|Mi |Redmi/i.test(ua)) m = '小米'
  else if (/Huawei|Honor/i.test(ua)) m = '华为'
  else if (/OPPO/i.test(ua)) m = 'OPPO'
  else if (/vivo/i.test(ua)) m = 'vivo'
  else if (/Android/i.test(ua)) m = '安卓'
  else if (/Windows/i.test(ua)) m = 'PC浏览器'
  else if (/Mac/i.test(ua)) m = 'Mac浏览器'
  return `${m}·${did ? did.slice(-4) : ''}`
}

/** 一句话设备描述（机型·系统），配对申请里带给主设备核对"这是哪台设备"。best-effort 解析 UA。 */
function describeDevice(): string {
  const ua = navigator.userAgent
  let m = ua.match(/Android ([\d.]+);\s*([^;)]+?)(?:\s+Build\/|\s*;|\s*\))/)
  if (m) return `${m[2].trim()} · Android ${m[1]}`
  m = ua.match(/iPhone; CPU iPhone OS ([\d_]+)/)
  if (m) return `iPhone · iOS ${m[1].replace(/_/g, '.')}`
  m = ua.match(/iPad; CPU OS ([\d_]+)/)
  if (m) return `iPad · iPadOS ${m[1].replace(/_/g, '.')}`
  if (/Windows NT/.test(ua)) return 'Windows PC'
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac'
  if (/Linux/.test(ua)) return 'Linux'
  return ''
}

/** 标识符行：完整 DID + 复制（公钥可直接展示，不缩略）。与 canvas 标识符详情对等。
 *  2026-10-05 复制加固：复制前 isValidDid 校验（非法串禁止复制）+ 复制后回读比对，
 *  异常/不完整以行内橙字提示（WebView 无 readText 权限时降级只写不比对）。 */
function DidRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const [warn, setWarn] = useState<string | null>(null)
  const copy = async () => {
    try {
      const r = await copyDidVerified(value)
      setWarn(r === 'invalid' || r === 'mismatch' || r === 'failed' ? copyDidToastText(r) : null)
      if (r === 'ok') { setCopied(true); setTimeout(() => setCopied(false), 1200) }
    } catch { setWarn('复制失败，请重试') }
  }
  const [expanded, setExpanded] = useState(false)
  const ci = value.indexOf(':', value.indexOf(':') + 1) + 1
  const short = value.length > ci + 8 ? value.slice(0, ci + 4) + '…' + value.slice(-4) : value
  return (
    <div className="cardd" style={{ padding: '8px 10px', cursor: value ? 'pointer' : 'default' }} onClick={() => value && setExpanded((v) => !v)} title={value ? (expanded ? '收起' : '点开查看完整公钥') : undefined}>
      <div className="tinyd" style={{ marginBottom: 2 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <code style={{ flex: 1, minWidth: 0, fontSize: 11, fontFamily: 'ui-monospace,monospace', color: '#3b475e', wordBreak: expanded ? 'break-all' : 'normal', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: expanded ? 'pre-wrap' : 'nowrap', userSelect: 'text' }}>{value ? (expanded ? value : short) : '（未就绪）'}</code>
        {value && (
          <button onClick={(e) => { e.stopPropagation(); void copy() }} title="复制完整公钥"
            style={{ flexShrink: 0, border: '1px solid #d7dfeb', background: '#fff', borderRadius: 7, padding: '3px 8px', fontSize: 11, color: copied ? '#15803d' : '#64748b', cursor: 'pointer', fontWeight: 600 }}>
            {copied ? '✓' : '⧉'}
          </button>
        )}
      </div>
      {warn && <div style={{ marginTop: 4, fontSize: 11, color: '#e65100', lineHeight: 1.5 }}>{warn}</div>}
    </div>
  )
}

/** 手机端"整行点开"组件（与 canvas ExpandableRow 对等）。 */
function PhoneExpandable({ header, children, defaultOpen = false }: { header: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ borderTop: '1px solid var(--border)' }}>
      <button onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '7px 0', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>{header}</span>
        <span style={{ color: 'var(--muted)', fontSize: 11, flexShrink: 0 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && <div style={{ paddingBottom: 8 }}>{children}</div>}
    </div>
  )
}

export function Pairing({ identity, onConnect, onUnlocked }: {
  identity: PhoneIdentity | null
  onConnect: (mode: PairMode, value: string, t?: Transport) => void
  onUnlocked: () => void
}) {

  // APK 自更新(2026-09-03 统一自更新):window.MycoShell(APK WebView bridge)环境下查
  // latest.json 的 apkVersionName,比当前新 → 提示条;确认即 DownloadManager 下载+安装意图
  // (myco 自己的发布通道,不经商店)。PWA 环境无此提示(随 PC 自动新版)。
  const [apkMsg, setApkMsg] = useState<string | null>(null)
  const [apkUpd, setApkUpd] = useState<{ latest: string; url: string } | null>(null)
  // 第38轮：检查更新抽成可手动触发（头像菜单入口），状态三态 检查中/已是最新/有新版
  const [apkCheck, setApkCheck] = useState<'idle' | 'busy' | 'latest'>('idle')
  // 2026-10-23 用户要求：已是最新时也要能看到当前版本号（本地 PackageManager 读，离线也有）
  const [apkVer, setApkVer] = useState('')
  useEffect(() => {
    try {
      const shell = (window as unknown as { MycoShell?: { getVersionName?: () => string } }).MycoShell
      const v = shell?.getVersionName?.()
      if (v) setApkVer(String(v).replace(/^v/, ''))
    } catch { /* 老壳没有该桥 */ }
  }, [])
  const checkApk = useCallback(async () => {
    const shell = (window as unknown as { MycoShell?: { isApk: () => boolean; downloadApkUpdate: (u: string, f: string) => void; getVersionName?: () => string } }).MycoShell
    if (!shell?.isApk?.()) return
    setApkCheck('busy')
    try {
      // no-cache:WebView 会缓存 latest.json 旧值,导致已装新版仍弹"有更新"
      // 2026-09-28 第90轮:固定域名(443 /downloads 直达,不再裸 IP)
      // 基址走 identity.ts 的 DID_BASE origin 推导（DID 服务与平台前端同主机，443 站根
      // 提供 /downloads/），缺省=域名现状；换环境改 DID_BASE 一处即可。
      const dlBase = DID_BASE ? new URL(DID_BASE).origin : ''
      const r = await fetch(`${dlBase}/downloads/phone-latest.json`, { signal: AbortSignal.timeout(8000), cache: 'no-cache' })
      const j = await r.json() as { version: string; base: string; files?: string[]; apkVersionName?: string }
      const cur = shell.getVersionName?.() ?? '' // APK 版本(PackageManager 动态读)
      const apkName = (j.files ?? []).find((f) => f.endsWith('.apk'))
      if (!apkName) return
      const lat = (j.apkVersionName ?? j.version).replace(/^v/, '')
      // 按数值比版本(三段),严格更新才提示
      const na = lat.split('.').map((x) => Number(x) || 0)
      const nb = cur.split('.').map((x) => Number(x) || 0)
      let newer = false
      for (let i = 0; i < 3; i++) {
        if ((na[i] ?? 0) > (nb[i] ?? 0)) { newer = true; break }
        if ((na[i] ?? 0) < (nb[i] ?? 0)) break
      }
      if (newer) setApkUpd({ latest: j.apkVersionName ?? j.version, url: j.base + apkName })
      else { setApkUpd(null); setApkCheck('latest') }
    } catch { /* 离线静默 */ setApkCheck('idle') }
  }, [])
  useEffect(() => { void checkApk() }, [checkApk])
  const doApkUpdate = () => {
    if (!apkUpd) return
    const shell = (window as unknown as { MycoShell?: { downloadApkUpdate: (u: string, f: string) => void } }).MycoShell
    shell?.downloadApkUpdate?.(apkUpd.url, 'youling-myco-android-update.apk')
    setApkMsg('已开始下载新版本,下载完成后会弹出安装')
  }
  const mode = getStorageMode() // 'plain' | 'enc' | null(null=首次，会自动生成plain)
  const locked = mode === 'enc' && !identity
  // roleTick：attestation 落盘后 bump 一下强制重算角色（deviceRole 读的是模块级缓存）
  const [roleTick, setRoleTick] = useState(0)
  const role: DeviceRole = useMemo(() => (identity ? deviceRole() : 'unlinked'), [identity, roleTick])
  const myYoulingDid = useMemo(() => getRootIdentity() ?? getAttestation()?.rootDid ?? null, [roleTick])

  const [unlockPw, setUnlockPw] = useState('')
  const [unlockErr, setUnlockErr] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)

  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [presence, setPresence] = useState<PresenceNode[]>([])
  const [loadingPresence, setLoadingPresence] = useState(false)

  // 账号详情（改名 / DID / 备份 / 添加设备 / 危险操作）——2026-10-19 设计定稿：
  // **默认收起，界面最简洁**。不再"未备份就自动整块展开"（那样首屏像按钮大全）；
  // 未备份的提醒改挂标题行一枚小 chip（⚠️ 待备份），点 ▸ 才展开——入口不丢、首屏不长。
  const [showDid, setShowDid] = useState(false)   // 标识符/管理详情（默认收起）
  // 云端总览是否已拉到：控制「待备份」chip 别在首帧误闪（默认 false=不显示）
  const [ovReady, setOvReady] = useState(false)
  // 危险操作（退出登录/注销设备/解绑账号）折叠区——2026-10-18 用户真机拍板：
  // 这些低频且高敏感/风险的按钮不许铺在智能体页首屏，一律默认收起（展开才渲染）。
  const [dangerOpen, setDangerOpen] = useState(false)
  const [relay, _setRelay] = useState(() => localStorage.getItem('youling.relay') === '1')
  // 2026-10-10 用户要求：强制直连开关——开启后不走云端中转，直连不通时明确提示
  const [forceDirect, setForceDirect] = useState(() => {
    try { return localStorage.getItem('myco.forceDirect') === '1' } catch { return false }
  })
  const toggleForceDirect = () => {
    const next = !forceDirect
    setForceDirect(next)
    try { localStorage.setItem('myco.forceDirect', next ? '1' : '0') } catch { /* ignore */ }
  }
  // 身份/连接 两个 Tab（把连接/中转内容从注册登录页移出）
  const [tab, setTab] = useState<'identity' | 'connect'>(() => deviceRole() === 'unlinked' ? 'identity' : 'connect') // unlinked 仍默认智能体(需先建身份)
  const [_showConnOpts, _setShowConnOpts] = useState(false)
  // IPv6 直连前置探测：每台 PC 连接前就知道走直连还是中转
  const [directProbe, setDirectProbe] = useState<Record<string, 'probing' | 'ok' | 'fail'>>({})
  // 探测成功的 IPv6 地址(did → addr):连接时直接用,不再重试死地址
  const [directOkAddr, setDirectOkAddr] = useState<Record<string, string>>({})
  // 第90轮：「安全设置」折叠入口禁用（JSX 注释块在身份 Tab 底部）——state/handler 保留，
  // 复开随正式设置页（条件登记在仓根 TODO.md）。仅渲染孤儿加 _ 前缀压 TS6133（_backupPw 先例）：
  // 值只出现在注释块里的（showSettings/settingsMsg/keyB64）+ 入口 handler（toPlain/revealKey）；
  // setter 与 newPw/showKey 仍被 _toPlain/_revealKey 引用，不加前缀。
  const [_showSettings, _setShowSettings] = useState(false)
  const [newPw, setNewPw] = useState('')              // 切换加密模式用（仅 _toPlain 内用）
  const [_settingsMsg, setSettingsMsg] = useState<string | null>(null)

  const [showKey, setShowKey] = useState(false)       // 仅 _revealKey 内用
  const [_keyB64, setKeyB64] = useState('')
  const [connectingDid, setConnectingDid] = useState<string | null>(null)

  // ── 账号管理 ──
  const [rootDid, setRootDid] = useState<string | null>(() => getRootIdentity())
  const [accountDevices, setYoulingDevices] = useState<DeviceWithStatus[]>([])
  const [accountName, setYoulingName] = useState('')
  const [rootBusy, setRootBusy] = useState(false)
  const [rootErr, setRootErr] = useState<string | null>(null)
  // 强制备份（2026-10-01 整改：open/seed/masked/copied 归 ui-kit backupMask 状态机，
  // 与 PC IdentityPanel 同源——码不明文晾屏：10s 无操作/复制后 3s 自动遮蔽并清出内存）
  const [bk, bkDispatch] = useReducer(backupPanel, backupPanelInitial)
  // 扫码登录有灵网页（帮电脑网页确认登录；不依赖设备连接——分身/一键建号均可，spec login-design 通道①）
  const [showYLLogin, setShowYLLogin] = useState(false)
  // 第69轮：备份密码框停用（入口注释在备份弹窗处）——state 保留防将来重开，加 _ 前缀压 TS6133
  const [_backupPw, _setBackupPw] = useState('')
  const [backupConfirmed, setBackupConfirmed] = useState(false)
  const [cloudBackedUp, setCloudBackedUp] = useState(false)   // 云端 每账号 "已导出"标记（非本地）
  const [backupErr, setBackupErr] = useState<string | null>(null)
  // 无根钥的**原因**（2026-10-08 用户实测：enc 未解锁被误报成"成员设备"）——
  // 本地 state 而非改 ui-kit backupMask（那个包 PC/board/dock 共用，改动面大不值当）。
  const [bkNoRootReason, setBkNoRootReason] = useState<'locked' | 'not-main' | null>(null)
  /** 本机识别码已复制提示（2026-10-09 用户实测：出示页此前只有二维码，"复制识别码"藏在
   *  折叠里、也看不到本机 DID —— 用户"找不到哪能看手机的 did:myco"。补一眼可见的复制。） */
  const [didCopied, setDidCopied] = useState(false)
  // Agent（设备 myco 钥）自动生成的一次性提示
  const [agentNotice, setAgentNotice] = useState(() => !localStorage.getItem('myco-phone.agentNoticeSeen'))
  // DID 互换授权：主设备粘贴新设备 DID 直加（无配对码）
  const [addDidInput, setAddDidInput] = useState('')
  const [addNameInput, setAddNameInput] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [addMsg, setAddMsg] = useState<string | null>(null)
  const [joinMsg, setJoinMsg] = useState<string | null>(null)  // 未关联态：等待/已加入提示
  const [errNotAuth, setErrNotAuth] = useState(false)          // 连接被拒=未授权 → 错误卡带出本机 DID
  const [scanOpen, setScanOpen] = useState(false)              // 主设备添加：实时扫码（https 可用时）
  const [manualOpen, setManualOpen] = useState(false)          // 第55轮：手动输入 DID 折叠（默认收起）
  // 2026-10-06 问题2（PC 同款）：手动输入区在面板底部展开，不自动滚动时可能被视口下缘
  // 裁掉——展开后平滑滚入视野（block:'nearest' 最小滚动，扫码命中预填自动展开时也生效）。
  const manualRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!manualOpen) return
    const t = setTimeout(() => manualRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60)
    return () => clearTimeout(t)
  }, [manualOpen])
  const qrFileRef = useRef<HTMLInputElement>(null)             // 主设备添加：从图片识别
  // 方向 B：本机作新设备——扫主设备的邀请码申请加入（扫到即自动投递）
  const [joinScanMode, setJoinScanMode] = useState(false)      // 未关联页互扫 tab：false=出示我的码 / true=扫对方的码
  const [joinOpen, setJoinOpen] = useState(false)               // 未关联页「登录已有」展开卡（第31轮）
  const [pendingInvite, setPendingInvite] = useState<{ did: string; name?: string; nonce?: string } | null>(null) // 扫码识别确认步（第32轮）
  const [acctDrawer, setAcctDrawer] = useState(false)        // 账号抽屉（第33轮 多账号切换）
  // 2026-10-09 用户要求 UI 对齐：主题五色（与 PC App.tsx:558-562 同款）——demo.css 已有
  // [data-theme="dark"]/"pink"/"green"/"blue" 映射，只差切换入口（此前只有 dark 被动生效）。
  const [theme, setTheme] = useState<'light' | 'dark' | 'pink' | 'green' | 'blue'>(() => (localStorage.getItem('myco-theme') as 'light' | 'dark' | 'pink' | 'green' | 'blue' | null) || 'light')
  const setThemeTo = (next: 'light' | 'dark' | 'pink' | 'green' | 'blue') => {
    setTheme(next)
    document.documentElement.dataset.theme = next
    try { localStorage.setItem('myco-theme', next) } catch { /* 忽略 */ }
  }
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  const [menuOpen, setMenuOpen] = useState(false)             // 顶栏头像菜单（第38轮 K3 方案）
  // demo done 屏（第41轮）：登录/创建/切换成功后一次性展示
  const [doneInfo, setDoneInfo] = useState<{ name: string; tail: string } | null>(null)
  const showDone = (name: string, rootDidFull: string) => setDoneInfo({ name, tail: rootDidFull.slice(-4) })
  const [acctMsg, setAcctMsg] = useState<string | null>(null)
  const [createConfirm, setCreateConfirm] = useState(false)     // 未关联页创建前二次确认拦截（第31轮 防误创建裂号）
  const [inviteScanOpen, setInviteScanOpen] = useState(false)
  const [invitePaste, setInvitePaste] = useState('')           // 远程场景：粘贴对方发来的邀请码文本
  const inviteFileRef = useRef<HTMLInputElement>(null)
  const inviteGalleryRef = useRef<HTMLInputElement>(null)      // 图库选图（无 capture——浏览器路径；APK 走桥）
  // 方向 B：本机作主设备——出示邀请码 + drain 信箱收申请
  const [myInvite, setMyInvite] = useState<{ nonce: string; exp: number } | null>(null)
  const [myPairReqs, setMyPairReqs] = useState<{ from: string; name?: string; nonce?: string; dev?: string }[]>([])
  // 2026-10-09（与 PC 同修）：已处理（批准/忽略）的设备 did 集合——轮询永不再加回
  const handledPairRef = useRef<Set<string>>(new Set())
  // 主设备：名册除名（两段确认）
  const [revokeFor, setRevokeFor] = useState<string | null>(null)
  const [revokeBusy, setRevokeBusy] = useState(false)
  const [revokeMsg, setRevokeMsg] = useState<string | null>(null)
  const [unbindText, setUnbindText] = useState('')
  // 从备份恢复 有灵账号（换机/找回）
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [importPw, setImportPw] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [importMsg, setImportMsg] = useState<string | null>(null)

  // 就绪后：主设备/成员都按账号拉总览（名下设备在线 + 云端"已导出"标记 + 有灵账号名缓存）
  // 除名传播：名册里自己被吊销/消失（仅 agent 态）→ 清本地 attestation 回未关联
  useEffect(() => {
    if (!ready || !myYoulingDid) { setYoulingDevices([]); return }
    let stop = false
    const fetch_ = async () => {
      const ov = await fetchYoulingOverview(myYoulingDid)
      if (stop) return
      if (ov && role === 'agent' && identity) {
        const me = ov.devices.find((d) => didFromPubkeyB64(d.pubkeyB64) === identity.did)
        if (!me || me.revoked) {
          clearAttestation()
          setYoulingDevices([])
          setJoinMsg('你已被主设备移出这个账号')
          setRoleTick((t) => t + 1)
          return
        }
      }
      setYoulingDevices(ov?.devices ?? [])
      setCloudBackedUp(!!ov?.backedUp)
      setOvReady(true)   // 总览到手——「待备份」chip 才允许出现（防首帧误闪）
      // 有灵账号名：本地空才用云名填（不覆盖正在改的名）+ 写模块缓存（聊天气泡"自己名"用）
      // 2026-10-16 修「账号列表全是未命名」：云名同时落库到 LS_ACCOUNTS（saveAccountName
      // 只改 name 不动 lastLogin）——账号列表/欢迎屏关联账号/登录完成屏才有真名。
      if (ov?.name) {
        setYoulingName((prev) => prev || ov.name!)
        setYoulingNameCache(ov.name)
        saveAccountName(myYoulingDid, ov.name)
      }
    }
    fetch_()
    const t = setInterval(fetch_, 10000)
    return () => { stop = true; clearInterval(t) }
  }, [ready, myYoulingDid, role, identity])

  // 第81轮补：身份就绪即启好友信箱后台轮询（单例 5s——不依赖身份 Tab 可见）
  useEffect(() => { if (ready && identity && role !== 'unlinked') return ensureBackgroundPoll() }, [ready, identity, role])
  // 批四：App 级未读总数（tab 徽章数据源）——信箱轮询入库后重算（免打扰会话不计）。
  const [chatUnread, setChatUnread] = useState(0)
  useEffect(() => {
    if (!ready || !identity || role === 'unlinked') return
    let stop = false
    const tick = () => { void import('../chat-store').then((cs) => { if (!stop) setChatUnread(cs.unreadTotal()) }).catch(() => {}) }
    tick()
    const t = setInterval(tick, 5000)
    return () => { stop = true; clearInterval(t) }
  }, [ready, identity, role])
  // 就绪后：手机登记在线（带 账号归属 + 角色 + 种类），让管理页看得到本机在线
  useEffect(() => {
    if (!ready || !identity) return
    const beat = async () => { await registerPresence('MYCO') }
    beat()
    const t = setInterval(beat, 30000)
    return () => clearInterval(t)
  }, [ready, identity, rootDid, accountName])

  const doCreateRoot = async () => {
    setRootBusy(true); setRootErr(null)
    try {
      const did = await createRootIdentity(accountName)
      setRootDid(did)
      if (accountName.trim()) setYoulingNameCache(accountName.trim())
      // 强制备份门：创建完先弹备份，确认已保存才放行（素材打开时导出一次，遮蔽即清）
      const { seed, noRoot, noRootReason } = exportBackupText()
      setBkNoRootReason(noRootReason ?? null)
      bkDispatch({ type: 'open', seed, noRoot }); setBackupConfirmed(false); _setBackupPw(''); setBackupErr(null)
    } catch (e) {
      setRootErr(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setRootBusy(false)
    }
  }

  /** 备份完成：登记主设备 + 上线，关弹窗。 */
  const finishBackup = async () => {
    if (!backupConfirmed) { setBackupErr('请先勾选"我已妥善保存"'); return }
    setRootBusy(true); setBackupErr(null)
    try {
      await claimEmbodiment().catch(() => {})      // best-effort：登记本机是主设备
      await registerPresence('MYCO').catch(() => {})
      await setBackedUpCloud()                      // 云端置"已导出"标记（每账号，处处不唠叨）
      bkDispatch({ type: 'finish' })                // 清码关窗（码不随弹窗关闭驻留内存）
      setBackupConfirmed(false)
      if (rootDid) {
        const ov = await fetchYoulingOverview(rootDid)
        setYoulingDevices(ov?.devices ?? []); setCloudBackedUp(true)
      }
    } catch (e) {
      setBackupErr(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setRootBusy(false)
    }
  }

  /** 再次打开备份（主设备在面板/设置里可重新导出 myco 根钥）。 */
  const reopenBackup = () => {
    _setBackupPw(''); setBackupConfirmed(false); setBackupErr(null)
    const { seed, noRoot, noRootReason } = exportBackupText()
    setBkNoRootReason(noRootReason ?? null)
    bkDispatch({ type: 'open', seed, noRoot })
  }
  /** 重新显示（2026-10-01 整改）：遮蔽后重导备份素材——旧码已清出内存/屏幕。 */
  const revealBackupSeed = () => {
    const { seed, noRoot, noRootReason } = exportBackupText()
    setBkNoRootReason(noRootReason ?? null)
    bkDispatch({ type: 'reveal', seed, noRoot })
  }
  const doCopyBackup = () => {
    if (bk.masked || !bk.seed) return
    navigator.clipboard?.writeText(bk.seed).then(() => bkDispatch({ type: 'copied' })).catch(() => {})
  }
  // 遮蔽计时（开关见 ui-kit backupMask，与 PC 同源）：10s 无操作 / 复制后 3s
  useEffect(() => {
    if (!backupIdleTimerOn(bk)) return
    const t = setTimeout(() => bkDispatch({ type: 'idle-timeout' }), BACKUP_MASK_IDLE_MS)
    return () => clearTimeout(t)
  }, [bk])
  useEffect(() => {
    if (!backupCopyTimerOn(bk)) return
    const t = setTimeout(() => bkDispatch({ type: 'copy-timeout' }), BACKUP_MASK_AFTER_COPY_MS)
    return () => clearTimeout(t)
  }, [bk])

  // 未关联态：出示本机 DID 等主设备添加；轮询反查发现自己被收编（attestation 落盘 → 角色变成员）
  useEffect(() => {
    if (!ready || !identity || role !== 'unlinked') return
    let stop = false
    const poll = async () => {
      const a = await fetchMyRoot()
      if (!stop && a) {
        setJoinMsg('✓ 已加入账号')
        setRoleTick((t) => t + 1)
      }
    }
    poll()
    const t = setInterval(poll, 3000)
    return () => { stop = true; clearInterval(t) }
  }, [ready, identity, role])

  // 主设备按 DID 直加新设备：DID 自带公钥，签 attestation 上云，新设备轮询自取
  const addDidValid = !!pubkeyB64FromDid(addDidInput)
  const doAddDevice = async () => {
    if (!addDidValid) { setAddMsg('DID 格式不对（应为 did:myco: 开头）'); return }
    setAddBusy(true); setAddMsg(null)
    try {
      await addDeviceByDid(addDidInput, addNameInput.trim())
      setAddMsg('✓ 已添加——新设备稍等几秒会自动发现自己已加入')
      setAddDidInput(''); setAddNameInput('')
      if (rootDid) { const ov = await fetchYoulingOverview(rootDid); setYoulingDevices(ov?.devices ?? []) }
    } catch (e) { setAddMsg(String(e).replace(/^Error:\s*/, '')) }
    finally { setAddBusy(false) }
  }

  /** 扫码/读图命中：解析 payload → 预填 DID+名字，用户确认后才真添加。 */
  const applyScanned = (text: string) => {
    setScanOpen(false)
    const p = parseAddPayload(text, (d) => !!pubkeyB64FromDid(d))
    if (!p) { setAddMsg('没识别出有效的设备 DID 二维码'); return }
    setAddDidInput(p.did)
    if (p.name) setAddNameInput(p.name)
    setAddMsg(null)
    setManualOpen(true) // 第55轮：扫到码预填后展开手动区供核对确认
  }
  const onPickQrFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    const text = await decodeQrFromFile(f)
    if (text) applyScanned(text)
    else setAddMsg('图片里没识别出二维码')
  }

  // ── 方向 B：扫主设备邀请码（本机作新设备）──
  // 扫到即自动投递申请（免二次确认）：DID 是公钥可公开、nonce 5 分钟过期兜底、主设备端确认是最终闸。
  // 第32轮扫码四步流（demo 定稿）：取景→识别确认→申请已发送→主设备确认。
  // 扫到先弹确认卡（对方账号名+did尾码）——防扫错码，点「确认申请加入」才真发送。
  const scanInvite = (text: string) => {
    setInviteScanOpen(false)
    const p = parseQrPayload(text, (d) => !!pubkeyB64FromDid(d))
    if (!p) { setJoinMsg('没识别出有效的二维码'); return }
    if (p.kind === 'add') { setJoinMsg('这是设备的「我的识别码」——方向反了：让主设备扫你「我的识别码」里的码'); return }
    if (p.exp && p.exp < Date.now()) { setJoinMsg('邀请码已过期，让主设备重新出示'); return }
    if (!identity) return
    setJoinMsg(null)
    setPendingInvite({ did: p.did, name: p.name, nonce: p.nonce })
  }
  const confirmInvite = () => {
    const p = pendingInvite
    if (!p || !identity) return
    setPendingInvite(null)
    setJoinMsg('发送申请中…')
    sendPairRequest(p.did, guessDeviceName(identity.did), p.nonce ?? '', describeDevice())
      .then(async (resp) => {
        // 配对响应可能带委任状(PC 端 attest 回发)——存本地(aop 离线身份用)
        if (resp?.delegation) {
          try {
            const dl = await import('../delegation')
            dl.saveDelegation(resp.delegation as Delegation)
          } catch { /* 存失败不阻断 */ }
        }
        setJoinMsg(`⏳ 申请已发送——请「${p.name || `…${p.did.slice(-6)}`} 的主设备」点一下确认授权（确认后自动加入）`)
      })
      .catch((e) => setJoinMsg(String(e).replace(/^Error:\s*/, '')))
  }
  const onPickInviteFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    const text = await decodeQrFromFile(f)
    if (text) scanInvite(text)
    // 2026-10-09 用户实测：原提示"图片里没识别出二维码"像 bug 实测问题。改引导语
    // （拍照/图库路径——EXIF 已修，仍识别不到时给操作建议）。
    else setJoinMsg('没识别到二维码——请靠近对准再拍，或用「实时取景」扫')
  }

  // 图库选图识别(微信取景框相册位的等价物):APK 走桥 pickImage,浏览器走 file input。
  // 回执与拍照共用 _myco_cam_result。
  const doPickFromGallery = () => {
    const shell = (window as unknown as { MycoShell?: { pickImage?: () => string } }).MycoShell
    if (shell?.pickImage) { shell.pickImage(); return }
    // 2026-10-16 修「死按钮」（审计 #5）：hidden file input 只渲染在互斥分支 B
    // （!canLiveScan()&&!MycoShell），https/PWA 浏览器走分支 A → ref 恒 null →
    // ?.click() 静默 no-op。改：动态建 input，读完直接走与桥拍照同款的
    // window._myco_cam_result(dataURL) 回执管线（818 行 effect 已挂好识别链）。
    const inv = document.createElement('input')
    inv.type = 'file'
    inv.accept = 'image/*'
    inv.onchange = () => {
      const f = inv.files?.[0]
      if (!f) return
      const r = new FileReader()
      r.onload = () => {
        const cb = (window as unknown as { _myco_cam_result?: (d: string | null) => void })._myco_cam_result
        cb?.(String(r.result || '') || null)
      }
      r.readAsDataURL(f)
    }
    inv.click()
  }

  // 点「扫对方的码」tab 即进取景页(2026-09-04 终稿):APK 全屏相机预览,
  // 快门/相册缩略图一体;浏览器(无桥)不弹,落到下方按钮布局。 */
  const triggerScanCamera = () => {
    const shell = (window as unknown as { MycoShell?: { captureCamera?: () => string } }).MycoShell
    if (shell?.captureCamera) shell.captureCamera()
  }

  // ── 方向 B：本机作主设备——出示邀请码 + drain 信箱收申请 ──
  const startMyInvite = () => {
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')
    setMyPairReqs([])
    setMyInvite({ nonce, exp: Date.now() + 5 * 60_000 })
  }
  useEffect(() => {
    if (!myInvite) return
    let stop = false
    const poll = async () => {
      if (Date.now() > myInvite.exp) { setMyInvite(null); setMyPairReqs([]); return }
      const msgs = await drainPairInbox()
      if (stop) return
      const fresh = msgs.filter((m) => m.nonce === myInvite.nonce)
      if (fresh.length) {
        setMyPairReqs((prev) => {
          const seen = new Set(prev.map((x) => x.from))
          // 2026-10-09（与 PC 同修）：已处理（批准/忽略）的 from 永不再加回——
          // 否则 drain 再返回同一条时会又加回（用户看到"点通过后确认还在"）。
          return [...prev, ...fresh.filter((x) => !seen.has(x.from) && !handledPairRef.current.has(x.from))]
        })
      }
    }
    poll()
    const t = setInterval(poll, 3000)
    return () => { stop = true; clearInterval(t) }
  }, [myInvite])
  const approveMyPairReq = async (from: string, name?: string) => {
    handledPairRef.current.add(from)   // 已处理——轮询永不再加回（2026-10-09）
    try {
      await addDeviceByDid(from, name || '新设备')
      const left = myPairReqs.filter((x) => x.from !== from)
      setMyPairReqs(left)
      // 最后一条申请处理完 → 自动收起邀请（免再手动点掉；成功反馈由 addMsg 呈现）
      if (left.length === 0) setMyInvite(null)
      setAddMsg('✓ 已添加——新设备稍等几秒会自动发现自己已加入')
      if (rootDid) { const ov = await fetchYoulingOverview(rootDid); setYoulingDevices(ov?.devices ?? []) }
    } catch (e) { handledPairRef.current.delete(from); setAddMsg(String(e).replace(/^Error:\s*/, '')) }
  }

  // 主设备名册除名：签 revoke 上云；对方 10s 轮询自查到后自动退出（除名传播）
  const doRevoke = async (d: DeviceWithStatus) => {
    setRevokeBusy(true); setRevokeMsg(null)
    try {
      await revokeRosterDevice(d.pubkeyB64)
      setRevokeMsg(`✓ ${d.name || '设备'}已从账号除名`)
      setRevokeFor(null)
      if (rootDid) { const ov = await fetchYoulingOverview(rootDid); setYoulingDevices(ov?.devices ?? []) }
    } catch (e) { setRevokeMsg(String(e).replace(/^Error:\s*/, '')) }
    finally { setRevokeBusy(false) }
  }

  // 从备份恢复 有灵账号（换机/找回 → 成主设备）
  const doImport = async () => {
    if (!importText.trim()) { setImportMsg('粘贴备份内容'); return }
    setImportBusy(true); setImportMsg(null)
    try {
      const did = await importRootIdentity(importText, importPw)
      setRootDid(did)
      // 2026-10-01 修（与 PC 导入即时切身份同款）：导入=活动账号已切换——
      // roleTick bump 让 myYoulingDid/role memo 重算（上面的总览 effect 立即按新账号
      // 拉名册+昵称）；旧账号昵称同步清（state+模块缓存），否则 296 行的 prev||ov.name
      // 兜底链填不进新名，顶栏会一直挂着旧账号昵称。
      setRoleTick((t) => t + 1)
      setYoulingName('')
      setYoulingNameCache('')
      setImportMsg('✓ 已恢复账号')
      setShowImport(false); setImportText(''); setImportPw('')
    } catch (e) { setImportMsg(String(e).replace(/^Error:\s*/, '')) }
    finally { setImportBusy(false) }
  }

  // 解绑 有灵账号（高风险）：抄录"解绑"确认 + 须已备份
  const doUnbind = () => {
    if (unbindText.trim() !== '解绑') { setJoinMsg('输入"解绑"二字确认'); return }
    if (!cloudBackedUp) { setJoinMsg('先备份账号钥再解绑——没备份永远找不回'); return }
    unbindYouling()
    setUnbindText(''); setShowDid(false)
    setRootDid(null); setYoulingDevices([])
    // 2026-10-16 修「半死」（死按钮审计 #8）：解绑=活动账号已切换——与 doImport 同款，
    // bump roleTick 让 role/myYoulingDid memo 重算，旧账号昵称同步清；否则账号卡/顶栏
    // 停留旧账号直到重启。setJoinMsg 不可见（渲染在 unlinked 块）→ 用屏上 acctMsg。
    setRoleTick((t) => t + 1)
    setYoulingName(''); setYoulingNameCache('')
    setAcctMsg('✓ 已解绑，回到未关联态')
    setJoinMsg('✓ 已解绑，回到未关联态')
  }

  // ── 解锁（enc 模式）──
  const doUnlock = async () => {
    if (!unlockPw.trim()) { setUnlockErr('请输入本地密码'); return }
    setUnlocking(true); setUnlockErr(null)
    const ok = await unlockIdentity(unlockPw)
    setUnlocking(false)
    if (!ok) { setUnlockErr('密码不对'); return }
    onUnlocked() // App 读缓存身份 → identity 就绪 → 触发下面的登录 effect
  }

  // 身份就绪 → 幂等注册公钥（无登录/session）。
  // 2026-09-04 修:失败自动重试(3s)——服务器重启/信号抖动让首轮 403 时 ready
  // 卡住,presence 列表整页空白,用户得手动操作才发现是后台问题。
  useEffect(() => {
    if (!identity || ready) return
    let stop = false
    const attempt = async (tries: number) => {
      if (stop) return
      setBusy(true); setErr(null)
      try {
        await ensureRegistered()
        if (!stop) { setReady(true); setBusy(false) }
      } catch (e) {
        if (!stop) {
          setErr(String(e).replace(/^Error:\s*/, ''))
          if (tries > 0) setTimeout(() => attempt(tries - 1), 3000)
          else setBusy(false)
        }
      }
    }
    void attempt(5)
    return () => { stop = true }
  }, [identity, ready])

  // 就绪后：拉在线电脑，周期刷新
  useEffect(() => {
    if (!ready) { setPresence([]); return }
    let stop = false
    const fetch_ = async () => {
      setLoadingPresence(true)
      const list = await listPresence()
      if (!stop) { setPresence(list); setLoadingPresence(false) }
    }
    fetch_()
    const t = setInterval(fetch_, 15000)
    return () => { stop = true; clearInterval(t) }
  }, [ready])

  const retry = () => { setErr(null); setReady(false) }

  /** 前置探测某台 PC 的 IPv6 直连可达性（逐地址 2s ping），结果写 directProbe + directOkAddr。
   *  多地址逐个实测（ipv6List）：运营商前缀轮换期 PC 会同时挂新旧前缀，实测选路
   *  而非押注单地址——这是去中心化直连的关键。
   *  2026-10-11 防闪：presence 15s 一刷、每刷重探——已有结果（ok/fail）时不再回退
   *  「探测中」（用户实测"列表不断闪'探测中…'"）。首探才显示进行态；重探静默换新值。 */
  const probeDirect = async (p: PresenceNode) => {
    const list = p.addrs?.ipv6List?.length ? p.addrs.ipv6List : (p.addrs?.ipv6 ? [p.addrs.ipv6] : [])
    if (!list.length) { setDirectProbe((s) => ({ ...s, [p.did]: 'fail' })); return }
    setDirectProbe((s) => (s[p.did] === 'ok' || s[p.did] === 'fail' ? s : { ...s, [p.did]: 'probing' }))
    const port = p.addrs?.port ?? 9100
    for (const ipv6 of list) {
      try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 2000)
        await fetch(`http://[${ipv6}]:${port}/ping`, { signal: ctrl.signal })
        clearTimeout(t)
        setDirectProbe((s) => ({ ...s, [p.did]: 'ok' }))
        setDirectOkAddr((s) => ({ ...s, [p.did]: ipv6 }))
        return
      } catch { /* 试下一个地址 */ }
    }
    setDirectProbe((s) => ({ ...s, [p.did]: 'fail' }))
  }
  // 在线电脑变化时探测每台直连性（连接前就知道走哪条路）
  useEffect(() => { presence.filter(isConnectableMain).forEach((p) => void probeDirect(p)) }, [presence])

  /** 连接阶梯（去中心化：P2P 优先，中转仅 opt-in）：
   *  ① WebRTC 直连（IPv6+打洞穿防火墙，信令仅建联中介，之后数据不过服务器）——PC 上报 webrtc 能力才试；
   *  ② IPv6 HTTP 直连（无打洞能力的纯直连）——presence 带 addrs{ipv6,port} 才能试；
   *  ③ frp 中转（仅"中转兜底"开启时）——云服务器 /pc-direct → 隧道 → PC；
   *  遇到"设备未授权"（WebRTC/403 notAuthorized）→ 提示去 PC 添加本机 DID（DID 互换，无配对码）。 */
  const tryConnect = async (p: PresenceNode) => {
    setConnectingDid(p.did)
    setErr(null); setErrNotAuth(false)
    // ① WebRTC：打洞穿防火墙的直连（PC 对所有 offer 应答；未授权被拒=notAuthorized → 提示去 PC 添加）
    if (p.webrtc) {
      try {
        // 两阶段建连(2026-08-28):①STUN-only 直连档独占提名窗口 12s → ②不通才带 TURN 兜底。
        // 返回已连通实例,经 onConnect 透传给 App 沿用(免重复重建+保住档位)。
        const t = await connectWebRtc(p.did)
        setConnectingDid(null)
        onConnect('webrtc', p.did, t)
        return
      } catch (e) {
        if (e instanceof NotAuthorizedError) {
          setConnectingDid(null)
          setErrNotAuth(true)
          setErr('这台主设备还没添加本机。让对方在 Myco 面板「添加设备」扫下面的码（或粘贴识别码）即可')
          return
        }
        // 打洞没穿通/超时 → 继续走 ②③
      }
    }
    const tryUrl = async (url: string, ms: number) => {
      const t = new DirectHttpTransport(url)
      await Promise.race([t.list(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
      return url
    }
    // 多地址候选:探测成功的排最前,其余上报地址随后(前缀轮换期实测选路)
    const list = p.addrs?.ipv6List?.length ? p.addrs.ipv6List : (p.addrs?.ipv6 ? [p.addrs.ipv6] : [])
    const sorted = [...list].sort((a, _b) => (directOkAddr[p.did] === a ? -1 : 0))
    const candidates: string[] = sorted.map((a) => `http://[${a}]:${p.addrs?.port ?? 9100}`)
    if (relay) candidates.push(window.location.origin + '/pc-direct')
    for (const url of candidates) {
      try {
        const ok = await tryUrl(url, url.includes('/pc-direct') ? 4000 : 3000)
        setConnectingDid(null)
        onConnect('direct', ok)
        return
      } catch (e) {
        if (e instanceof NotAuthorizedError) {
          setConnectingDid(null)
          setErrNotAuth(true)
          setErr('这台主设备还没添加本机。让对方在 Myco 面板「添加设备」扫下面的码（或粘贴识别码）即可')
          return
        }
      }
    }
    setConnectingDid(null)
    setErr(
      !list.length
        ? '这台主设备没上报直连地址' + (p.webrtc ? '，直连打洞也没穿通' : '') + (relay ? '（云端中转也不通）' : '，连不上')
        : relay
          ? '直连和云端中转都连不上，检查电脑是否在线'
          : '直连打不通（当前网络可能拦 IPv6/UDP），检查电脑网络或稍后再试'
    )
  }

  // 第90轮：安全设置入口禁用——这两个 handler 只剩注释块引用，_ 前缀压 TS6133（复开=身份 Tab 底部取消注释）
  const _revealKey = async () => {
    if (!showKey) setKeyB64(await exportKeyB64())
    setShowKey(!showKey)
  }

  const _toPlain = async () => {
    if (!newPw.trim()) { setSettingsMsg('输入当前本地密码以解锁并切换'); return }
    try { await disableEncryption(newPw); setSettingsMsg('✓ 已切换到快速模式'); setNewPw('') }
    catch (e) { setSettingsMsg(String(e).replace(/^Error:\s*/, '')) }
  }
  // 注：_ 前缀只豁免解构元素的 TS6133，普通 const 局部量不豁免——void 引用压住（复开时随上面注释块一起删本行）
  void _revealKey; void _toPlain

  // 主设备列表源(2026-09-04 修):改名册(youlingDevices,by-root 持久态)优先——
  // presence/list 是内存表抖动态,首轮 403/丢条目即整页空白;名册在线/种类
  // 都是同一 by-root 面,稳。名册在线+pc/kind=可连主设备。
  // 相机直拍(系统文件选择器点不弹的兜底):APK bridge captureCamera 拉起系统相机,
  // 拍完经 window._myco_cam_result(dataURL) 回填 → 识别邀请码
  useEffect(() => {
    (window as unknown as { _myco_cam_result?: (d: string | null) => void })._myco_cam_result = (d) => {
      if (!d) { setJoinMsg('相机没拍到图'); return }
      // dataURL → File → 识别(与相册识别同管线)。type 随实际 blob(拍照=PNG/图库=JPEG,
      // 标错 createImageBitmap 在部分 WebView 上直接拒——识别永远失败的暗坑)
      void fetch(d).then((r) => r.blob()).then(async (blob) => {
        const f = new File([blob], blob.type.includes('png') ? 'cam.png' : 'cam.jpg', { type: blob.type || 'image/png' })
        const text = await decodeQrFromFile(f)
        if (text) scanInvite(text)
        else setJoinMsg('拍的图里没识别出二维码')
      }).catch(() => setJoinMsg('识别失败'))
    }
  }, [])

  const mains = (accountDevices.length > 0
    ? accountDevices.filter((d: DeviceWithStatus) => !d.revoked && d.online && d.did !== identity?.did)
      .map((d: DeviceWithStatus) => ({
        did: d.did, nodeId: '', name: d.name || '主设备', lastSeen: d.lastSeen ?? 0,
        self: false, addrs: d.addrs ?? null, rootDid: null, role: d.role ?? null,
        kind: d.kind ?? null, webrtc: null,
      }) as PresenceNode)
    : []).filter(isConnectableMain)

  // agent 态自动连(2026-09-04 设计定稿:任务页直接任务树,免手选设备)——
  // 名册恰好一台在线主设备 → 直接连;多台(要选)/零台(无目标)不动;
  // 连过一次(有 myco-phone.mode 记录)交给 App 的恢复流,不重复抢连。
  const autoTriedRef = useRef(false)
  useEffect(() => {
    if (role !== 'agent' || autoTriedRef.current) return
    if (localStorage.getItem('youling.mode')) return
    if (mains.length !== 1) return
    autoTriedRef.current = true
    void tryConnect(mains[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, mains])
  // 第69轮：备份密码通道停用（backupPw 恒空）→ 恒出明文备份
  // 第89轮：分身设备无根钥——备份弹窗不 crash，显示引导（bk.noRoot）
  // 2026-10-01 整改：备份素材不再每次 render 现算晾屏——打开/重新显示时经 exportBackupText
  // 导出一次存 bk.seed（遮蔽/关闭即清），遮蔽状态机与 PC 同源（ui-kit backupMask）。

  // Myco（协作设备）分组数据:本机 + 名册(排除已吊销),按账号分组——phone 是 web 版,
  // 与 canvas 对等。
  const myDid = identity?.did ?? ''
  const others = accountDevices.filter((d) => {
    if (d.revoked) return false
    return didFromPubkeyB64(d.pubkeyB64) !== myDid
  })
  const selfDev = accountDevices.find((d) => !d.revoked && didFromPubkeyB64(d.pubkeyB64) === myDid)
  const embodimentName = accountDevices.find((d) => d.isEmbodiment && !d.revoked && didFromPubkeyB64(d.pubkeyB64) !== myDid)?.name
  const iconFor = (d: DeviceWithStatus): ReactNode => (d.kind === 'pc' ? <IconPc size={15} style={{ color: 'var(--text-2)' }} /> : d.kind === 'laptop' ? <IconLaptop size={15} style={{ color: 'var(--text-2)' }} /> : <IconPhone size={15} style={{ color: 'var(--text-2)' }} />)
  const [agentsOpen, setAgentsOpen] = useState(true)
  const rosterAll = accountDevices.filter((d) => !d.revoked)
  const rosterOnline = rosterAll.filter((d) => d.online).length

  // 智能体页三组(demo v3 还原,2026-09-05):我的设备(好友列表式,可折叠默认展开)
  // + 孢子分隔 + 合作中的智能体 + 我是谁的用户——与 PC myco 智能体页/demo 同构。
  const renderMyco = (
    <div>
      <button onClick={() => setAgentsOpen((v) => !v)} className="sec-title-btn">
        <span className="ag-caret">{agentsOpen ? '▼' : '▶'}</span>
        <span>📱 我的设备· {role === 'unlinked' ? (myDid ? '1 台 · 1 在线' : '0 台') : `${rosterAll.length} 台 · ${rosterOnline} 在线`}</span>
      </button>

      {agentsOpen && (
        <div className="ag-list">
          {myDid && (
            <PhoneExpandable
              header={<>
                {selfDev?.kind === 'pc' ? <IconPc size={15} style={{ color: 'var(--text-2)' }} /> : selfDev?.kind === 'laptop' ? <IconLaptop size={15} style={{ color: 'var(--text-2)' }} /> : <IconPhone size={15} style={{ color: 'var(--text-2)' }} />}
                <span className="ag-name">{selfDev?.name || guessDeviceName(myDid)}</span>
                <span className="ag-chip ag-chip-acc">本机{role === 'embodiment' ? ' · 主设备' : ''}</span>
                <span className="ag-state ok">● 在线</span>
              </>}
            >
              <DidRow label="本机 myco DID" value={myDid} />
            </PhoneExpandable>
          )}
          {others.length === 0 && <div className="ag-empty" style={{ paddingTop: 6 }}>暂无其他设备——在主设备上点「添加设备」完成授权后，新设备会出现在这里</div>}
          {others.map((d) => (
            <PhoneExpandable
              key={d.pubkeyB64}
              header={<>
                {iconFor(d)}
                <span className="ag-name">{d.name || '未命名'}</span>
                {d.isEmbodiment && <span className="ag-chip ag-chip-acc">主设备</span>}
                <span className={'ag-state' + (d.online ? ' ok' : '')}>{d.online ? '● 在线' : '○ 离线'}</span>
              </>}
            >
              <DidRow label="设备 DID" value={didFromPubkeyB64(d.pubkeyB64)} />
              {/* 主设备:名册除名(吊销 attestation;对方轮询自查后自动退出) */}
              {role === 'embodiment' && !d.revoked && (
                <div style={{ marginTop: 6 }}>
                  {revokeFor === d.pubkeyB64 ? (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: 'var(--err)' }}>确认除名?</span>
                      <button onClick={() => void doRevoke(d)} disabled={revokeBusy}
                        style={{ padding: '4px 10px', fontSize: 11, background: 'var(--err)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>除名</button>
                      <button onClick={() => setRevokeFor(null)}
                        style={{ padding: '4px 10px', fontSize: 11, background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--muted)', cursor: 'pointer' }}>取消</button>
                    </div>
                  ) : (
                    <button onClick={() => setRevokeFor(d.pubkeyB64)} title="吊销它的授权——它不再是这个账号的设备(丢了/退役用这个)"
                      style={{ fontSize: 11, color: 'var(--err)', background: 'none', border: '1px solid var(--err)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>从账号除名</button>
                  )}
                </div>
              )}
            </PhoneExpandable>
          ))}
          {revokeMsg && <div style={{ marginTop: 6, fontSize: 12, color: revokeMsg.startsWith('✓') ? 'var(--ok)' : 'var(--err)' }}>{revokeMsg}</div>}
        </div>
      )}

    </div>
  )

  return (
    <div className="login">
      <div className="login-inner">
        {/* ── demo done 屏（登录/创建/切换成功一次性展示） ── */}
        {doneInfo && (
          <div className="centerd" style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
            <div style={{ fontSize: 46 }}>✅</div>
            <div className="h1d">已登录</div>
            <div className="subd">当前账号：<b>{accountShortLabel(doneInfo.name, doneInfo.tail)}</b></div>
            <div className="tinyd" style={{ textAlign: 'center' }}>本机现在可以：接任务干活 · 扫码确认登录<br />以后打开 myco 自动是它</div>
            <button className="btnd" onClick={() => setDoneInfo(null)}>开始使用</button>
            <a className="btnd ghost" href={EXPLORE_URL} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}
               onClick={(e) => { e.preventDefault(); void openExplore(EXPLORE_URL) }}>🧭 去有灵探索一下 →</a>
          </div>
        )}
        {/* ══ 第38轮（K3 方案）：顶栏 🌙 换成右侧入口（有新版叠红点），点它=锚定下拉菜单（切换账号/检查更新）。
            第90轮 用户反馈：圆头像字母换 ⚙️ 设置图标对齐 PC 顶栏——账号身份顶栏左侧已有（● 账号名），
            头像字母保留在下拉菜单 menu-head。⚙️ 不上渐变圆底（会脏），inline 覆写 .avatar 做素净图标钮 ══ */}
        <div className="demo-topbar">
          <span className="logo" />
          <span className="nm">myco</span>
          {/* 2026-10-06 与 PC 同款：未登录态不显示"未登录"（功能与欢迎屏登录/创建入口重复）；
              已登录账号名、设备就绪态保留。
              2026-10-16 修「退出后顶栏账号名没清」（用户真机报）：退出后 identity=null
              但 vault 的 rootDid 仍在（分身槽）→ myYoulingDid 非 null → chip 继续渲染
              「未命名 ···koGc」。改：**登录态（identity 就绪）才显示账号 chip**；identity
              在但无账号=本机就绪；退出（identity null）=整个 chip 不渲染。 */}
          {identity && myYoulingDid ? (
            <span className="st" onClick={() => { setTab('identity'); setAcctDrawer(true) }}
              style={{ cursor: 'pointer' }} title="切换账号（与 PC 账号区「切换账号 ▾」对齐）">
              {`● ${accountShortLabel(accountName, myYoulingDid)} ▾`}
            </span>
          ) : identity ? (
            <span className="st" style={{ cursor: 'default' }}>● 本机就绪</span>
          ) : null}
          <span style={{ flex: 1 }} />
          <button className="avatar" title="设置——切换账号 / 检查更新" onClick={() => setMenuOpen((v) => !v)}
            style={{ width: 28, height: 28, background: 'transparent', color: 'var(--text-2)', fontSize: 15, fontWeight: 400 }}>
            ⚙️
            {apkUpd && <i className="reddot" />}
          </button>
        </div>
        {menuOpen && (
          <>
            <div className="menu-mask" onClick={() => setMenuOpen(false)} />
            <div className="menu-panel">
              <div className="menu-head">
                <span className="av">{(nicknameValue(accountName) || (myYoulingDid ? '未' : 'm')).slice(0, 1).toUpperCase()}</span>
                {/* 2026-10-03 单行布局（与 PC 账号卡同款修）：[头像] 名 ·…尾4 一行，
                    名长 ellipsis 收缩，title 悬停看全名兜底；credText 不在头部挤行
                    （身份 Tab「有灵账号」面板 chip 与账号抽屉行仍带凭据状态）。 */}
                <span style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 5, whiteSpace: 'nowrap', overflow: 'hidden' }}
                  title={myYoulingDid ? `${accountDisplayName(accountName)} · ${myYoulingDid}` : '未登录'}>
                  <span className="nm" style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{myYoulingDid ? accountDisplayName(accountName) : '未登录'}</span>
                  {myYoulingDid && <span className="sub" style={{ flexShrink: 0, marginTop: 0 }}>{accountTail(myYoulingDid)}</span>}
                </span>
              </div>
              <div className="menu-sep" />
              {/* 主题五色（2026-10-09 与 PC 对齐——demo.css 已有映射，只差切换入口。
                  2026-10-09 修布局：此前一行塞"🎨 主题颜色"+5 圆点 → 文字错位/位置不够；
                  现只留图标 + 圆点（title 提示保留），右对齐。 */}
              <div className="menu-row" style={{ cursor: 'default' }} title="主题颜色">
                <span className="em">🎨</span>
                <div style={{ display: 'flex', gap: 7, marginLeft: 'auto', alignItems: 'center' }}>
                  {([['light', '#f8fafc', '#d7dfeb'], ['dark', '#1a2130', '#1a2130'], ['pink', '#ec5f9b', '#ec5f9b'], ['green', '#16a34a', '#16a34a'], ['blue', '#2563eb', '#2563eb']] as const).map(([k, c, b]) => (
                    <span key={k} title={{ light: '亮白', dark: '暗黑', pink: '粉', green: '绿', blue: '蓝' }[k]}
                      onClick={() => setThemeTo(k)}
                      style={{ width: 20, height: 20, borderRadius: '50%', background: c, border: `2px solid ${theme === k ? '#4338ca' : b}`, cursor: 'pointer', flexShrink: 0, display: 'inline-block', boxSizing: 'border-box' as const }} />
                  ))}
                </div>
              </div>
              <div className="menu-sep" />
              {/* 2026-10-10 用户要求：强制直连开关——开启后不走云端中转，直连不通时明确提示 */}
              <button className="menu-row" onClick={toggleForceDirect} style={{ cursor: 'pointer' }}>
                <span className="em">🔗</span>
                {/* 2026-10-23：标签包 span+nowrap——裸文本是 flex 匿名 item 会被右侧 chip 挤换行（检查更新行同款实测问题） */}
                <span style={{ whiteSpace: 'nowrap' }}>强制直连</span>
                <span className={'stx' + (forceDirect ? ' go' : '')} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{forceDirect ? '已开启' : '已关闭'}</span>
              </button>
              <div className="menu-sep" />
              <button className="menu-row" onClick={() => { void checkApk(); if (apkUpd) doApkUpdate() }}>
                <span className="em">⬆</span>
                {/* 2026-10-23 实测反馈：「检查更新」被挤成两行、「新」字落单——裸文本是 flex 匿名
                    item 不抗挤；菜单面板仅 200px（内容 176px），右侧 chip 带「已是最新 · v0.3.169」
                    时必然溢出。修法：标签 nowrap + chip 收缩省略；idle 兜底文案「检查更新」与行标签
                    重复，改「未检查」；「已是最新」后的「 · 」删掉省宽。 */}
                <span style={{ whiteSpace: 'nowrap' }}>检查更新</span>
                <span className={'stx' + (apkUpd ? ' go' : '')} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {apkCheck === 'busy'
                    ? '检查中…'
                    : apkUpd
                      ? '有新版本 →'
                      : apkCheck === 'latest'
                        ? `已是最新${apkVer ? ` v${apkVer}` : ''}`
                        : `${apkVer ? `当前 v${apkVer}` : '未检查'}`}
                </span>
              </button>

            </div>
          </>
        )}
        {/* 第67轮修重复：done 屏内联渲染期间隐藏本卡（done 自带"去有灵探索一下"）——
            与 PC 的互斥渲染对齐，避免同屏双探索按钮 */}
        {role !== 'unlinked' && !doneInfo && (
        <div className="cardd" style={{ padding: 0 }}>
          {/* 2026-10-15 修（用户报：点探索打开的网页没登录）：对齐 PC auto_login_url 免登链——
              出票→签名（主设备根钥/分身设备钥+委任状）→callback 确认→?autologin= 拼接；
              失败零损失降级裸链接（平台落扫码页）。href 保留仅作长按复制链接用。 */}
          {/* 2026-11-01 jason 设计：扫码登录收进探索卡右侧——同组功能（都是去有灵网页），
              主操作（探索=直接打开）大面积，副操作（扫码=给PC网页授权）小图标。 */}
          <div style={{ display: 'flex', alignItems: 'stretch' }}>
            <a style={{ flex: 1, display: 'block', padding: '11px 12px', textDecoration: 'none' }} href={EXPLORE_URL} target="_blank" rel="noreferrer"
               onClick={(e) => { e.preventDefault(); void openExplore(EXPLORE_URL) }}>
              <div className="h2d" style={{ fontSize: 12.5 }}>🧭 去探索</div>
              <div className="tinyd">有灵 · 大千世界（打开有灵网页）</div>
            </a>
            <button style={{ border: 'none', borderLeft: '1px solid var(--border,#e2e5ee)', background: 'none', cursor: 'pointer', padding: '8px 11px', color: 'var(--muted,#9aa3b2)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, minWidth: 44 }}
              onClick={() => setShowYLLogin(true)} title="扫码登录有灵网页（帮电脑网页确认登录）">
              {/* 内联 SVG 二维码图标——不依赖 emoji 字体（Honor 缺 🔑 字形）。
                  14px 细线条，克制留白，配下方 9px 小字，不抢主操作的视觉重量。 */}
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="1.25" y="1.25" width="5.5" height="5.5" rx="1.1" stroke="currentColor" strokeWidth="1.1" />
                <rect x="3.25" y="3.25" width="1.5" height="1.5" rx="0.3" fill="currentColor" />
                <rect x="9.25" y="1.25" width="5.5" height="5.5" rx="1.1" stroke="currentColor" strokeWidth="1.1" />
                <rect x="11.25" y="3.25" width="1.5" height="1.5" rx="0.3" fill="currentColor" />
                <rect x="1.25" y="9.25" width="5.5" height="5.5" rx="1.1" stroke="currentColor" strokeWidth="1.1" />
                <rect x="3.25" y="11.25" width="1.5" height="1.5" rx="0.3" fill="currentColor" />
                <rect x="9.25" y="9.25" width="2" height="2" rx="0.4" fill="currentColor" />
                <rect x="12.75" y="9.25" width="2" height="2" rx="0.4" fill="currentColor" />
                <rect x="9.25" y="12.75" width="2" height="2" rx="0.4" fill="currentColor" />
              </svg>
              <span style={{ fontSize: 9, lineHeight: 1, letterSpacing: 0.5, transform: 'scale(0.95)' }}>扫码</span>
            </button>
          </div>
          {/* 2026-10-24（vnet 会话交付）：下载中心「其他工具」页——微软远程桌面 APK + myco skill。
              静态页无需登录；优先走应用内浏览器（系统浏览器对 127.0.0.1 之外的站点也可能弹选择器），
              桥不可用再退回 window.open。 */}
          <a style={{ display: 'block', padding: '11px 12px', textDecoration: 'none', borderTop: '1px solid var(--border,#e2e5ee)' }}
             href={TOOLS_URL} target="_blank" rel="noreferrer"
             onClick={(e) => { e.preventDefault(); openTools() }}>
            <div className="h2d" style={{ fontSize: 12.5 }}>🛠 其他工具</div>
            <div className="tinyd">附加下载：远程桌面 App · myco skill（新窗口打开）</div>
          </a>
        </div>
        )}

        {/* APK 有新版提示(2026-09-03 自更新):myco 发布通道直装,不经商店 */}
        {apkUpd && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', marginBottom: 8, borderRadius: 8, background: 'rgba(107,123,255,.12)', border: '1px solid rgba(107,123,255,.35)' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>有新版 {apkUpd.latest}</span>
            <button style={{ marginLeft: 'auto', border: 'none', borderRadius: 6, background: '#6b7bff', color: '#fff', fontSize: 12, padding: '4px 10px' }} onClick={doApkUpdate}>下载安装</button>
          </div>
        )}
        {apkMsg && <div style={{ fontSize: 11.5, color: 'var(--muted,#9CA3AF)', marginBottom: 8 }}>{apkMsg}</div>}

        {/* ── Agent（设备 myco 钥）自动生成的一次性提示 ── */}
        {identity && agentNotice && role !== 'unlinked' && (
          <div className="cardd" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="tinyd" style={{ flex: 1 }}>设备钥匙已自动生成，只需备份<b>有灵账号</b>。</span>
            <button className="btnd ghost small" style={{ flexShrink: 0, padding: '5px 10px', fontSize: 11 }} onClick={() => { localStorage.setItem('myco-phone.agentNoticeSeen', '1'); setAgentNotice(false) }}>知道了</button>
          </div>
        )}

        {/* ── 锁定屏（第41轮 K3 方案：极简居中卡） ── */}
        {locked && (
          <div className="cardd" style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
            <div style={{ fontSize: 40 }}>🔒</div>
            <div className="h1d" style={{ fontSize: 17 }}>已锁定</div>
            <div className="subd">身份钥匙用本地密码加密了。密码只在你设备上，服务器帮不了重置。</div>
            <input className="inpd" type="password" value={unlockPw} onChange={(e) => setUnlockPw(e.target.value)}
              placeholder="本地密码" autoFocus style={{ ...(unlockErr ? { borderColor: '#dc2626' } : {}) }}
              onKeyDown={(e) => { if (e.key === 'Enter') doUnlock() }} disabled={unlocking} />
            {unlockErr && <div className="tinyd" style={{ color: '#dc2626' }}>密码不正确，请重试</div>}
            <button className="btnd" onClick={doUnlock} disabled={unlocking}>
              {unlocking ? '解锁中…' : '解锁'}
            </button>
          </div>
        )}

        {/* ── 自动登录中 / 失败 / 连接未授权 ── */}
        {identity && busy && (
          <div className="card" style={{ textAlign: 'center', padding: '24px 16px' }}>
            <span className="spinner" /> <span style={{ fontSize: 13, color: 'var(--text-2)' }}>正在登录…</span>
          </div>
        )}
        {identity && !busy && err && (
          <div className="card">
            <div className="card-title">{errNotAuth ? '还没被这台主设备授权' : '登录失败'}</div>
            <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, margin: '8px 0 14px' }}>{err}</div>
            {errNotAuth && (
              <div style={{ marginBottom: 12 }}>
                <QrImage text={buildAddPayload(identity.did, guessDeviceName(identity.did))} size={170} />
                <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', margin: '6px 0' }}>主设备在 myco「添加设备 → 添加识别码」扫这个码即可</div>
                <PhoneExpandable header={<span style={{ fontSize: 11, color: 'var(--muted)' }}>或复制本机 DID 发给对方</span>}>
                  <DidRow label="本机 DID" value={identity.did} />
                </PhoneExpandable>
              </div>
            )}
            {errNotAuth
              ? <button className="btn ghost" style={{ width: '100%' }} onClick={() => { setErr(null); setErrNotAuth(false) }}>知道了</button>
              : <button className="btn" style={{ width: '100%' }} onClick={retry}>重试</button>}
          </div>
        )}

        {/* ── 强制备份弹窗（创建 账号后必经）──
            2026-10-01 整改（用户实测：码明文晾屏不安全）：10s 无操作/复制后 3s 自动遮蔽并清码，
            「重新显示」=重导备份素材（ui-kit backupMask，与 PC IdentityPanel 同源）。 */}
        {/* ── 无账号钥提示（2026-10-08 用户实测修复）──
            此前：一行橙色小字、且不分原因——主设备在**加密模式未解锁**下点备份也被告知
            "本机是成员设备"（用户原话"像玩用户一样"）。现：卡片化 + 按原因给文案与出路：
            未解锁 → 「去解锁」（可自助解决）；确实非主设备 → 指路主设备。 */}
        {bk.open && bk.noRoot && (
          <div className="card" style={{ border: '1px solid #e65100' }}>
            <div className="card-title">
              {bkNoRootReason === 'locked' ? '账号钥已加密——先解锁再备份' : '本机没有账号钥，无法备份'}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.6, margin: '8px 0 12px' }}>
              {bkNoRootReason === 'locked' ? (
                <>本机账号钥处于<b>加密模式</b>，需先输入密码解锁才能导出恢复码。解锁后回到这里即可备份。</>
              ) : (
                <>本机是<b>成员设备</b>——账号钥（根钥）在主设备上，本机只持有设备钥。备份/查看恢复码请到<b>主设备</b>的「账号 → 备份」操作。</>
              )}
            </div>
            {bkNoRootReason === 'locked' && (
              <button className="btn" style={{ width: '100%' }}
                onClick={() => { bkDispatch({ type: 'later' }); setTab('identity') }}>去解锁 →</button>
            )}
            <button className="btnd ghost" style={{ width: '100%', marginTop: 6 }}
              onClick={() => bkDispatch({ type: 'later' })}>知道了</button>
          </div>
        )}
        {bk.open && !bk.noRoot && (
          <div className="card" style={{ border: '1px solid var(--accent,#6b7bff)' }}>
            <div className="card-title">备份你的恢复码（重要）</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.6, margin: '8px 0 12px' }}>
              这是你的 <b>账号钥</b>——丢了且没备份，你的账号（及未来声誉）就找不回。现在抄下来或截屏，离线收好。
              截屏/复制请离线收好。
            </div>
            {/* 第69轮（设计定稿）：备份密码框停用——双端不开放设密码（DPAPI/沙箱已兜底，
                多记密码是负担）。enc 路径代码保留不删（存量 enc 设备还能解），新增入口不再。 */}
            {/* <input type="password" value={backupPw} onChange={(e) => _setBackupPw(e.target.value)}
              placeholder="可选：给备份加密码（留空=不加密）"
              style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 12, marginBottom: 8 }} /> */}
            {bk.masked ? (
              <div style={{ fontSize: 13, fontFamily: 'ui-monospace,monospace', textAlign: 'center', letterSpacing: 3, background: 'var(--warn-soft,#fdf6e3)', borderRadius: 8, padding: '12px 10px', color: '#8a97ab', border: '1px dashed #ecd9a8' }}>
                •••• •••• ••••
                <div style={{ fontSize: 10.5, letterSpacing: 0, fontFamily: 'inherit', marginTop: 6, color: 'var(--muted)' }}>已自动隐藏，点「重新显示」再看</div>
              </div>
            ) : (
              <div style={{ fontSize: 11, fontFamily: 'ui-monospace,monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--warn-soft,#fdf6e3)', borderRadius: 8, padding: 10, color: 'var(--text-2)', border: '1px dashed #ecd9a8' }}>
                {bk.seed}
              </div>
            )}
            {bk.masked ? (
              <button onClick={revealBackupSeed} style={{ marginTop: 6, fontSize: 12, color: 'var(--accent,#6b7bff)', background: 'none', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 12px', cursor: 'pointer' }}>👁 重新显示</button>
            ) : (
              <button onClick={doCopyBackup} style={{ marginTop: 6, fontSize: 12, color: 'var(--accent,#6b7bff)', background: 'none', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 12px', cursor: 'pointer' }}>复制到剪贴板</button>
            )}
            {bk.copied && <span style={{ fontSize: 11, color: 'var(--ok)', marginLeft: 8 }}>✓ 已复制（3 秒后自动隐藏）</span>}
            {!bk.masked && (
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>
                {bk.seed.startsWith('ct=') ? '已加密——三行都要复制全。' : '未加密——这串务必保密。'} 复制后存进密码管理器/加密笔记，或截屏。未来可用 QR 扫码恢复（开发中）。
              </div>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text)', margin: '10px 0' }}>
              <input type="checkbox" checked={backupConfirmed} onChange={(e) => { setBackupConfirmed(e.target.checked); bkDispatch({ type: 'interact' }) }} />
              我已妥善保存（抄下来/截屏了）
            </label>
            {backupErr && <div style={{ marginTop: 4, fontSize: 12, color: 'var(--err)' }}>{backupErr}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              {/* 取消=稍后备份（later：清码关窗；手机端无本地"已备份"记号，云标记只在完成时写） */}
              <button className="btn ghost" style={{ flex: 1 }} onClick={() => { bkDispatch({ type: 'later' }); setBackupConfirmed(false) }}>取消</button>
              <button className="btn" style={{ flex: 1 }} onClick={finishBackup} disabled={rootBusy || !backupConfirmed}>
                {rootBusy ? '处理中…' : '完成'}
              </button>
            </div>
          </div>
        )}


            {role === 'unlinked' && (
              <>
                {/* ── demo first 屏（未登录主卡）：h1 欢迎使用有灵 + 登录主按钮 + 创建文字链 ── */}
                <div className="h1d">欢迎使用有灵</div>
                <div className="subd">有灵账号是你的永久身份：跨设备是同一个「我」，手机/电脑互相认可，扫码即可确认网页登录。</div>
                {!createConfirm ? (
                <>
                <button className="btnd" onClick={() => setJoinOpen(true)}>登录已有有灵账号</button>
                <div className="tinyd centerd">在电脑/其他手机上注册过？用这个，扫码授权即可</div>
                <div className="textlink"><span className="linkish" onClick={() => setCreateConfirm(true)}>第一次用有灵？创建一个全新的 →</span></div>
                </>
                ) : (
                <>
                {/* ── demo createConfirm 屏：拦截确认 ── */}
                <div className="h2d">创建全新账号前，确认一下</div>
                <div className="cardd warn-cardd">
                  <div className="subd">如果你在<b>其他设备上已经有有灵账号</b>（比如电脑上注册过），请返回用「<b>登录已有有灵账号</b>」——直接创建会变成两个互不相通的独立账号。</div>
                </div>
                <div className="subd">确实是第一次用有灵、想要全新身份？</div>
                <input className="inpd" value={accountName} onChange={(e) => setYoulingName(e.target.value.replace(/[\r\n\t\x00-\x1f]/g, '').trim().slice(0, 32))} placeholder="给它起个名（可选，之后也能改）" />
                <button className="btnd" onClick={doCreateRoot} disabled={rootBusy}>{rootBusy ? '创建中…' : '✨ 是，创建全新账号'}</button>
                <button className="btnd ghost" onClick={() => setCreateConfirm(false)}>返回登录已有账号</button>
                {rootErr && <div className="tinyd" style={{ color: '#dc2626' }}>{rootErr}</div>}
                </>
                )}

                {joinOpen && (
                <>
                {/* ── demo method 屏：登录方式选择（apk 默认「出示」在首位推荐） ── */}
                <div className="backrowd"><button className="bk" onClick={() => setJoinOpen(false)}>‹ 返回</button></div>
                <div className="h2d">登录已有有灵账号</div>
                <div className="subd">选择一种方式证明「你是老账号的主人」：</div>
                <div className={'methodd' + (!joinScanMode ? ' on' : '')} onClick={() => setJoinScanMode(false)}>
                  <span className="ic">🔳</span><span><div className="t">我的识别码</div><div className="d">本机出码，主设备扫并确认</div></span><span className="rec">推荐</span>
                </div>
                {/* 2026-10-09 用户实测纠正：「扫主设备的码」是**方式选择入口**（切到"扫对方的码"
                    模式），不是删。此前 onClick 里 `triggerScanCamera()` 走桥拍照（全屏拍照，图拉伸+
                    识别不到）——改：**只切模式**（setJoinScanMode(true)），该模式下走 Web 实时取景
                    （QrCamera，见下方 joinScanMode 分支）。 */}
                <div className={'methodd' + (joinScanMode ? ' on' : '')} onClick={() => setJoinScanMode(true)}>
                  <span className="ic">📷</span><span><div className="t">扫主设备的码</div><div className="d">主设备出码，本机扫——最常用</div></span>{joinScanMode && <span className="rec">推荐</span>}
                </div>
                <div className={'methodd' + (showImport ? ' on' : '')} onClick={() => setShowImport(true)}>
                  <span className="ic">🔑</span><span><div className="t">恢复码导入</div><div className="d">输入备份的恢复码（成为主设备）</div></span>
                </div>
                <div className="tinyd">说明：前两种=本机成为该账号的<b>成员</b>（主设备点一下确认即可）；恢复码=把账号钥匙带回本机（成为主设备），适合换机。</div>

                {showImport && (
                <>
                <div className="backrowd"><button className="bk" onClick={() => setShowImport(false)}>‹ 返回方式选择</button></div>
                <div className="h2d">恢复码导入</div>
                <div className="subd">粘贴创建账号时备份的恢复码（三行）。导入后本机成为该账号的<b>主设备</b>。</div>
                <div className="cardd"><textarea className="textaread" rows={3} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="line1&#10;line2&#10;line3" /></div>
                <input className="inpd" type="password" style={{ marginTop: 8 }} value={importPw} onChange={(e) => setImportPw(e.target.value)} placeholder="密码（加密备份才需要）" />
                <button className="btnd" style={{ marginTop: 8 }} onClick={doImport} disabled={importBusy}>{importBusy ? '恢复中…' : '导入并登录'}</button>
                {importMsg && <div className="tinyd" style={{ color: importMsg.startsWith('✓') ? '#15803d' : '#dc2626' }}>{importMsg}</div>}
                </>
                )}

                {!joinScanMode ? (
                  <>
                  {/* ── demo show 屏：出示本机码（二维码+识别码+等待） ── */}
                  {identity?.did && (
                    <div style={{ padding: '2px 0' }}>
                      <QrImage text={buildAddPayload(identity.did, guessDeviceName(identity.did))} />
                      <div className="tinyd centerd">主设备打开 myco「账号 → 添加设备 → 添加识别码」扫这个码</div>
                      {/* 2026-10-09 用户实测：出示页此前只有二维码，「复制识别码」藏在折叠里
                          （且看不到本机 DID）——用户"找不到哪能看手机的 did:myco"。补一眼可见的。 */}
                      <button className="btnd ghost" style={{ marginTop: 6, width: '100%' }}
                        onClick={() => {
                          void navigator.clipboard.writeText(identity.did)
                            .then(() => { setDidCopied(true); setTimeout(() => setDidCopied(false), 2500) })
                            .catch(() => setDidCopied(false))
                        }}>
                        {didCopied ? '✓ 已复制——去 PC「添加设备 → 添加识别码」粘贴' : '📋 复制本机识别码（PC 无摄像头时粘贴用）'}
                      </button>
                      <div className="tinyd centerd" style={{ fontFamily: 'ui-monospace,monospace', fontSize: 10, wordBreak: 'break-all', marginTop: 4 }}>{identity.did}</div>
                    </div>
                  )}
                  <PhoneExpandable header={<span style={{ fontSize: 11, color: '#6b7bff' }}>主设备不方便扫这个码？复制本机识别码 ▸</span>}>
                    <div className="tinyd">这就是要发给主设备的完整识别码（本设备公钥身份）。核对无误再复制——发错码=授权给错的设备。</div>
                    <DidRow label="本机识别码（完整 DID）" value={identity?.did || ''} />
                    <div className="tinyd">复制后去主设备：点顶部<b>账号名 → 添加设备 → 添加识别码</b> 粘贴，核对显示的设备名后确认。手机和电脑不在一起？用微信/QQ 发给自己中转。</div>
                  </PhoneExpandable>
                  <div className="cardd info-cardd centerd">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><span className="spinnerd" /><span className="subd">等待主设备扫这个码/粘贴并确认…</span></div>
                  </div>
                  </>
                ) : (
                  <>
                  {/* ── demo scan 四步：识别确认 → 申请已发送 ── */}
                  {pendingInvite ? (
                    <div style={{ padding: '2px 0' }}>
                      <div className="h2d">识别到邀请码</div>
                      <div className="cardd go-cardd">
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                          <span style={{ width: 42, height: 42, borderRadius: 10, background: '#eef2ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 21, flexShrink: 0 }}>🌿</span>
                          <span style={{ minWidth: 0 }}>
                            <div className="h2d" style={{ fontSize: 14.5 }}>{pendingInvite.name || '对方的主设备'}</div>
                            <div className="did" style={{ fontFamily: 'ui-monospace,monospace', fontSize: 10.5, color: '#8a97ab' }}>…{pendingInvite.did.slice(-6)}</div>
                          </span>
                        </div>
                        <div className="tinyd" style={{ marginTop: 8 }}>确认后向对方发送配对申请——<b>对方点确认</b>，本机即成为该账号的成员。申请无需密码，随时可被对方除名。</div>
                      </div>
                      <button className="btnd" onClick={confirmInvite}>✓ 确认，申请加入</button>
                      <button className="btnd ghost" onClick={() => setPendingInvite(null)}>不是这个？重新扫</button>
                    </div>
                  ) : inviteScanOpen ? (
                    <div className="qrcamera-wrap">
                      <QrCamera onResult={scanInvite} onClose={() => setInviteScanOpen(false)} onGallery={() => { setInviteScanOpen(false); doPickFromGallery() }} />
                    </div>
                  ) : (
                    <>
                    {/* 2026-10-09 用户实测：APK 此前因 `MycoShell` 存在而**强制走桥拍照**
                        （拍照图宽高比拉伸 + 识别不到"相机没拍到图"）。改：**优先 Web 实时取景**
                        （QrCamera，getUserMedia 可用时——WebView 支持摄像头 API）；桥仅当
                        getUserMedia 不可用时（老设备/权限拒）。
                        2026-10-09 补充：QrCamera 全屏（100dvh）出现后要**滚动到位**（否则在屏幕外）。 */}
                    {canLiveScan() ? (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btnd small" style={{ flex: 1 }}
                          onClick={() => {
                            setInviteScanOpen(true)
                            setTimeout(() => document.querySelector('.qrcamera-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120)
                          }}>📷 扫码（实时取景）</button>
                        <button className="btnd small ghost" style={{ flex: 1 }} onClick={doPickFromGallery}>🏞 从图库导入</button>
                      </div>
                    ) : !(window as unknown as { MycoShell?: unknown }).MycoShell ? (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btnd small" style={{ flex: 1 }} onClick={() => {
                          if (canLiveScan()) { setInviteScanOpen(true); return }
                          inviteFileRef.current?.click()
                        }}>📷 拍照</button>
                        <button className="btnd small" style={{ flex: 1 }} onClick={doPickFromGallery}>🏞 从图库导入</button>
                        <input ref={inviteFileRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={onPickInviteFile} />
                        <input ref={inviteGalleryRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onPickInviteFile} />
                      </div>
                    ) : (
                      <div className="centerd">
                        <button onClick={triggerScanCamera} style={{ fontSize: 12, color: '#6b7bff', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', textDecoration: 'underline', textUnderlineOffset: 3 }}>取景页没弹出来？点这里再试</button>
                      </div>
                    )}
                          <PhoneExpandable header={<span style={{ fontSize: 11, color: '#6b7bff' }}>对方不在身边？粘贴对方发来的邀请码文本</span>}>
                            <textarea className="textaread" value={invitePaste} onChange={(e) => setInvitePaste(e.target.value)} placeholder='{"v":1,"type":"myco-invite",…}' rows={3} />
                            <button className="btnd" style={{ marginTop: 6 }} onClick={() => { if (invitePaste.trim()) scanInvite(invitePaste.trim()) }}>识别邀请码</button>
                          </PhoneExpandable>
                        </>
                      )}
                      <div className="tinyd">扫主设备出示的「邀请码」，扫到即自动发送申请</div>
                    </>
                  )}
                  {joinMsg && <div className="tinyd" style={{ color: joinMsg.startsWith('✓') ? '#15803d' : '#dc2626' }}>{joinMsg}</div>}
                </>
                )}

{(() => { const saved = listAccounts(); return saved.length > 0 ? (
                <>
                <div className="dividerd" />
                <div className="h2d" style={{ fontSize: 13 }}>本机关联的有灵账号</div>
                <div className="tinyd">主设备=本机持钥匙的全权账号；成员=被其他设备授权的账号</div>
                {saved.map((a) => (
                  <div key={a.rootDid} className="acct-row" onClick={() => {
                    if (switchAccount(a.rootDid)) {
                      // 与导入同款：切号即清旧昵称（state+模块缓存），总览 effect 随 roleTick 立即拉新名
                      setRoleTick((t) => t + 1); setYoulingName(''); setYoulingNameCache('')
                      setAcctMsg(null); showDone(a.name, a.rootDid)
                      // 2026-10-16 修「退出后点账号登不进去」（用户真机报）：从**已登出会话**
                      // （identity=null，本欢迎屏所在态）点账号，switchAccount 只装载了凭据，
                      // 本会话 identity 不会恢复（ensurePlainIdentity 只在启动跑）→ 完成屏一关
                      // 还在欢迎页。清了 loggedOut 标记后 reload，启动即按新凭据真登入。
                      if (!identity) setTimeout(() => location.reload(), 900)
                    }
                    else setAcctMsg('该账号凭据已不在本机（被除名或数据清理）——请走登录已有重新授权')
                    }}>
                    <span className="av">🌿</span>
                    <span><div className="nm">{accountDisplayName(a.name)} <span className="did">{accountTail(a.rootDid)}</span> <span className={'chipd ' + (a.role === 'embodiment' ? 'green' : 'gray')} style={{ fontSize: 10, padding: '1px 6px' }}>{credText(a.role)}</span></div>
                    <div className="did">最后登录 {new Date(a.lastLogin).toLocaleDateString()}</div></span>
                    <span className="sw">登录 ›</span>
                  </div>
                ))}
                {acctMsg && <div className="tinyd" style={{ color: '#dc2626' }}>{acctMsg}</div>}
                </>
                ) : null })()}
              </>
            )}

        {/* ── 账号面板（身份 Tab）── */}
        {/* 2026-10-09 用户实测：主设备的"新设备请求加入"批准列表此前只在「我的识别码」
            半屏浮层内（不开浮层永远看不到待批准申请）。提到身份页顶部常驻
            （myPairReqs.length > 0 时显示，与 PC 设备区顶部常驻卡对齐）。 */}
        {tab === 'identity' && myPairReqs.length > 0 && (
          <div className="card" style={{ marginBottom: 8, border: '1px solid var(--accent,#6b7bff)' }}>
            <div className="card-title">新设备请求加入（{myPairReqs.length}）</div>
            {myPairReqs.map((r) => (
              <div key={r.from} className="cardd" style={{ marginTop: 8 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span style={{ width: 38, height: 38, borderRadius: 10, background: '#eef2ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19, flexShrink: 0 }}>{/phone|手机|android/i.test(r.dev || '') ? '📱' : '💻'}</span>
                  <span style={{ minWidth: 0 }}>
                    <div className="h2d" style={{ fontSize: 14 }}>{r.name || '新设备'}</div>
                    <div style={{ fontFamily: 'ui-monospace,monospace', fontSize: 10.5, color: '#8a97ab' }}>{r.dev ? r.dev + ' · ' : ''}…{r.from.slice(-4)}</div>
                  </span>
                </div>
                <div className="tinyd" style={{ marginTop: 8 }}>确认后这台设备成为本账号的<b>成员</b>：可扫码确认登录、可接任务干活。随时可除名，立即生效。</div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button className="btnd ghost" style={{ flex: 1 }} onClick={() => setMyPairReqs((xs) => xs.filter((x) => x.from !== r.from))}>忽略</button>
                  <button className="btnd" style={{ flex: 2 }} onClick={() => approveMyPairReq(r.from, r.name)}>✓ 确认授权</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'identity' && identity && ready && !busy && !bk.open && role !== 'unlinked' && (
          <div className="card">
            {/* 标题行=概念（与 Myco 卡对称：标题=概念+副标题，内容=实例）；展开钮在标题行右侧 */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <span className="card-title" style={{ marginBottom: 0, cursor: 'pointer' }} onClick={() => setAcctDrawer((v) => !v)} title="账号列表 · 切换 · 添加">有灵账号 ▾</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* 2026-10-19：详情默认收起后，未备份提醒改挂这里（小 chip，点 ▸ 展开即有
                    「⚠️ 备份恢复码」入口）——不占首屏，也不让备份入口消失。ovReady 前不显示。 */}
                {role === 'embodiment' && ovReady && !cloudBackedUp && (
                  <span className="chipd amber" style={{ fontSize: 10, padding: '1px 7px' }} title="恢复码还没备份——点 ▸ 展开后点「⚠️ 备份恢复码」">⚠️ 待备份</span>
                )}
                {/* 2026-10-06 凭据徽章（NAMING-RATIONALE 定稿：主设备=embodiment 持账号钥可管理；
                    成员=agent 受委任只读；与 PC 账号页顶部卡同款）——状态标识唯一位=本账号卡标题行（防处处提醒） */}
                {role === 'agent'
                  ? <span className="chipd amber" style={{ fontSize: 10, padding: '1px 7px', gap: 3 }} title="成员——能用、只读；管理请到主设备"><User size={11} />成员</span>
                  : <span className="chipd green" style={{ fontSize: 10, padding: '1px 7px', gap: 3 }} title="主设备——本机持有账号钥匙，可管理设备"><KeyRound size={11} />主设备</span>}
                <button onClick={() => setShowDid(!showDid)} title={showDid ? '收起' : '展开：账号详情 / 添加设备 / 危险操作'} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '3px 7px', color: 'var(--muted)' }}>{showDid ? '▾' : '▸'}</button>
              </div>
            </div>
            {/* 账号抽屉（第33轮 多账号）：列表+切换+添加——demo 定稿形态 */}
            {acctDrawer && (
              <div className="cardd" style={{ marginTop: 6 }}>
                {(() => {
                  const cur = myYoulingDid
                  const saved = listAccounts()
                  return (<>
                  <div className="backrowd" style={{ marginBottom: 6 }}><span className="h2d" style={{ fontSize: 14 }}>账号（{saved.length}）</span><span className="flex1" /><button className="bk" onClick={() => setAcctDrawer(false)}>收起 ✕</button></div>
                  {saved.map((a) => (
                    <div key={a.rootDid} className="acct-row" style={{ marginBottom: 6 }} onClick={() => {
                      if (a.rootDid === cur) return
                      if (switchAccount(a.rootDid)) {
                        // 与导入同款：切号即清旧昵称（state+模块缓存），总览 effect 随 roleTick 立即拉新名
                        setRoleTick((t) => t + 1); setYoulingName(''); setYoulingNameCache('')
                        setAcctMsg(null); setAcctDrawer(false)
                        // 2026-10-03：切换不进 done 全屏页（用户：不用这么隆重）——收抽屉
                        // 回身份页，顶栏/账号面板随 roleTick 即时换新账号即反馈。
                        // done 屏只留给首登（上方未关联区账号列表的 showDone）。
                      }
                      else setAcctMsg('该账号凭据已不在本机——请重新授权')
                    }}>
                      <span className="av">🌿</span>
                      <span><div className="nm">{accountDisplayName(a.name)} <span className="did">{accountTail(a.rootDid)}</span> <span className={'chipd ' + (a.role === 'embodiment' ? 'green' : 'gray')} style={{ fontSize: 10, padding: '1px 6px' }}>{credText(a.role)}</span></div></span>
                      {a.rootDid === cur ? <span className="cur">● 当前</span> : <span className="sw">切换</span>}
                    </div>
                  ))}
                  {acctMsg && <div className="tinyd" style={{ color: '#dc2626' }}>{acctMsg}</div>}
                  <div className="dividerd" />
                  {/* 2026-10-16 修「死按钮」（审计 #3/#4）：原 setJoinOpen(true)/setCreateConfirm(true)
                      的目标界面全在 role==='unlinked' 守卫内——已关联时永远渲染不出，点击唯一
                      效果=抽屉收起（用户感知=没反应）。改走安全路径：退出登录（钥匙保留+归档）→
                      reload 落回未关联欢迎屏，「登录已有/创建全新」在那儿原生可达。 */}
                  <button className="btnd ghost" onClick={() => { logoutYouling(); setAcctDrawer(false); setRoleTick((t) => t + 1); setTimeout(() => location.reload(), 400) }}>退出并登录其他账号</button>
                  <div className="textlink"><span className="linkish" onClick={() => { logoutYouling(); setAcctDrawer(false); setRoleTick((t) => t + 1); setTimeout(() => location.reload(), 400) }}>退出并创建全新账号 →</span></div>
                  <div className="tinyd centerd">每个账号=独立身份+独立设备树，类似钱包里的多个账户</div>
                  </>)
                })()}
              </div>
            )}

            {/* 账号详情：改名（主设备）+ 账号公钥 + 备份（点 ▾ 展开）；退出/注销/解绑收进
                下方「危险操作」折叠区（默认收起）；本机 DID 在下方 Myco 卡本机行 */}
            {showDid && (
              <div style={{ marginTop: 6, paddingBottom: 8, borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {role === 'embodiment' && (
                  <input defaultValue={nicknameValue(accountName)} onBlur={async (e) => { const t = e.target as HTMLInputElement; const v = t.value.trim().slice(0, 32); if (v && v !== accountName) { try { await renameYouling(v); setYoulingName(v); setYoulingNameCache(v) } catch (err) { setAcctMsg(`改名失败：${String(err).replace(/^Error:\s*/, '').slice(0, 60)}`) } } }} placeholder="给自己起个名字" style={{ width: '100%', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 12 }} />
                )}
                {myYoulingDid && <DidRow label="账号公钥（DID）" value={myYoulingDid} />}
                {role === 'agent' && (
                  <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.6 }}>
                    归属账号 <b>{accountDisplayName(accountName)}</b>（{myYoulingDid ? accountTail(myYoulingDid) : ''}）——本机是<b>成员</b>，能用、能看设备；管理（加设备/吊销/备份）请到主设备{embodimentName ? `「${embodimentName}」` : ''}。
                  </div>
                )}
                {role === 'embodiment' && (
                  <button onClick={reopenBackup} style={{ fontSize: 12, color: cloudBackedUp ? 'var(--text-2)' : 'var(--warn,#b8860b)', background: 'none', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', cursor: 'pointer', textAlign: 'left' }}>
                    {cloudBackedUp ? '✓ 恢复码已备份（重新导出）' : '⚠️ 备份恢复码'}
                  </button>
                )}
                {/* 添加设备（2026-10-19 设计定稿：从设备列表下方**搬进本展开区**——此前它被
                    「我的设备」列表隔在页中，收起账号详情后仍孤零零悬着；现在随详情一起收起/
                    展开，设备列表照常常显。第55轮改版：一主两次——扫码主按钮 + 我的二维码/
                    手动输入次级链接；原四入口同层级+「出示码/扫码添加」tab 同名套娃已撤。） */}
                {role === 'embodiment' && (
                  <div style={{ marginTop: 2, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                    {scanOpen ? (
                      <QrCamera onResult={applyScanned} onClose={() => setScanOpen(false)} onGallery={() => qrFileRef.current?.click()} />
                    ) : (
                      <>
                        {/* 主按钮：添加识别码（摄像头扫码为主；http 环境无摄像头则升主为相册选图）。
                            主/次通道次序契约=ui-kit scanAddOrder（手机=摄像头主/粘贴次，与 PC 反向）。 */}
                        {(() => { const primary = scanAddPrimary('phone', canLiveScan()); return (
                          <button className="btn" style={{ width: '100%' }} onClick={() => { setAddMsg(null); primary === 'camera' ? setScanOpen(true) : qrFileRef.current?.click() }}>
                            {primary === 'camera' ? '＋ 📷 添加识别码' : '＋ 🖼 从图片添加识别码'}
                          </button>
                        )})()}
                        <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12.5 }}>
                          <span className="linkish" style={{ color: 'var(--muted)' }} onClick={startMyInvite}>我的识别码 ›</span>
                          <span className="linkish" style={{ color: 'var(--muted)' }} onClick={() => setManualOpen((v) => !v)}>{manualOpen ? '收起手动输入 ▴' : '手动输入识别码 ›'}</span>
                        </div>
                        {/* 手动输入/粘贴（默认收起；扫码命中后自动展开供核对）——提示文案与 PC 端同款 */}
                        {manualOpen && (
                          <div ref={manualRef} style={{ marginTop: 8 }}>
                            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>从对方 myco「我的设备 → 我的识别码」复制，粘贴到这里：</div>
                            {/* 2026-10-05：粘贴非法 DID 实时提示——非空且校验不过 → 红边框+橙字（按钮禁用条件不变：addDidValid 解码级校验更严） */}
                            <input value={addDidInput} onChange={(e) => setAddDidInput(e.target.value.trim())}
                              placeholder="粘贴设备识别码（did:myco:…）"
                              style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${addDidInput && !isValidDid(addDidInput) ? '#e5534b' : 'var(--border)'}`, fontSize: 12, fontFamily: 'ui-monospace,monospace', marginBottom: 6 }} />
                            {addDidInput && !isValidDid(addDidInput) && (
                              <div style={{ fontSize: 11, color: '#e65100', lineHeight: 1.5, marginBottom: 6 }}>DID 格式不对（长度/字符异常——复制时可能丢字，请重新复制）</div>
                            )}
                            <input value={addNameInput} onChange={(e) => setAddNameInput(e.target.value.slice(0, 32))}
                              placeholder="给它起个名（可选，默认「新设备」）"
                              style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 12, marginBottom: 6 }} />
                            {addDidValid && (
                              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
                                尾号 <b style={{ fontFamily: 'ui-monospace,monospace', color: 'var(--accent,#6b7bff)' }}>…{addDidInput.slice(-6)}</b>——跟新设备出示的 DID 尾号对一眼，一致再添加
                              </div>
                            )}
                            <button className="btn" style={{ width: '100%' }} onClick={doAddDevice} disabled={addBusy || !addDidValid}>
                              {addBusy ? '添加中…' : '确认添加'}
                            </button>
                          </div>
                        )}
                      </>
                    )}
                    {/* 我的二维码（半屏浮层：对方扫我 + 收到申请的批准列表——原出示码内容迁移） */}
                    {myInvite && (
                      <div style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(8,12,20,.72)', display: 'flex', alignItems: 'flex-end' }} onClick={() => { setMyInvite(null); setMyPairReqs([]) }}>
                        <div style={{ background: 'var(--bg,#fff)', borderRadius: '16px 16px 0 0', width: '100%', maxHeight: '82%', overflowY: 'auto', padding: '14px 14px 18px' }} onClick={(e) => e.stopPropagation()}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                            <b style={{ fontSize: 14 }}>我的识别码</b>
                            <button className="btnd ghost" onClick={() => { setMyInvite(null); setMyPairReqs([]) }}>收起 ✕</button>
                          </div>
                          <QrImage text={JSON.stringify({ v: 1, type: 'myco-invite', did: myDid, nonce: myInvite.nonce, exp: myInvite.exp, name: nicknameValue(accountName) || undefined })} size={185} />
                          <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>新设备用 myco 扫这个码申请加入（5 分钟内有效）</div>
                          {myPairReqs.map((r) => (
                            <div key={r.from} className="cardd" style={{ marginTop: 8 }}>
                              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                <span style={{ width: 38, height: 38, borderRadius: 10, background: '#eef2ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19, flexShrink: 0 }}>{/phone|手机|android/i.test(r.dev || '') ? '📱' : '💻'}</span>
                                <span style={{ minWidth: 0 }}>
                                  <div className="h2d" style={{ fontSize: 14 }}>{r.name || '新设备'}</div>
                                  <div style={{ fontFamily: 'ui-monospace,monospace', fontSize: 10.5, color: '#8a97ab' }}>{r.dev ? r.dev + ' · ' : ''}…{r.from.slice(-4)}</div>
                                </span>
                              </div>
                              <div className="tinyd" style={{ marginTop: 8 }}>确认后这台设备成为本账号的<b>成员</b>：可扫码确认登录、可接任务干活。随时可除名，立即生效。</div>
                              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                                <button className="btnd ghost" style={{ flex: 1 }} onClick={() => setMyPairReqs((xs) => xs.filter((x) => x.from !== r.from))}>忽略</button>
                                <button className="btnd" style={{ flex: 2 }} onClick={() => approveMyPairReq(r.from, r.name)}>✓ 确认授权</button>
                              </div>
                            </div>
                          ))}
                          {myPairReqs.length === 0 && <div style={{ marginTop: 8, textAlign: 'center', fontSize: 11, color: 'var(--muted)' }}><span className="spinner" /> 等待新设备扫这个码申请…</div>}
                        </div>
                      </div>
                    )}
                    <input ref={qrFileRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={onPickQrFile} />
                    {addMsg && <div style={{ marginTop: 6, fontSize: 12, color: addMsg.startsWith('✓') ? 'var(--ok)' : 'var(--err)' }}>{addMsg}</div>}
                  </div>
                )}
                {/* ══ 危险操作（2026-10-18 用户真机拍板）══
                    此前「退出登录 / 从本机注销设备 / 解绑账号(+确认输入框)」三片整宽按钮直接
                    铺在智能体页顶部——低频操作占了首屏最贵的位置，且解绑=账号永久丢，误点
                    代价高。与 PC 账号页同款规矩（危险区在页底、默认收起）收进本折叠条：
                    **默认收起**（dangerOpen 初值 false），展开才渲染三件事；展开后退出登录
                    仍按 2026-10-16 设计定稿用 .btnd 实心（"颜色很浅不醒目"的返工不再重开）。 */}
                <div style={{ marginTop: 6, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                  <button onClick={() => setDangerOpen((v) => !v)} data-testid="danger-toggle"
                    style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer', textAlign: 'left', fontSize: 11.5, color: 'var(--err)' }}>
                    <span style={{ width: 8, flexShrink: 0 }}>{dangerOpen ? '▾' : '▸'}</span>
                    <span>危险操作：退出登录 · 注销设备 · 解绑账号</span>
                  </button>
                  {dangerOpen && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                      {/* 退出登录（2026-10-09 用户要求，与 PC 对齐——**任何角色可见**：
                          PC IdentityPanel.tsx:341-344 是 `onLogout && rootDid` 即渲染（含成员）。
                          此前手机端藏在 embodiment 守卫里（成员设备没有退出登录入口）——移出守卫。
                          2026-10-16 修「按钮无效」（用户真机报）：原 onClick 只调 logoutYouling()
                          + setJoinMsg（消息发到没打开的抽屉=看不见），而 logoutYouling 对成员设备
                          （vault 无 rootDid）连登出标记都不写、只删 attestation——UI 不重算就纹丝
                          不动。修：bump roleTick 让 role/myYoulingDid 立即重算（成员→未连接态），
                          再延迟半秒 location.reload() 拿干净启动态（主设备按 loggedOut 标记回落
                          登录页；同时清掉挂在旧会话上的 chat/presence 模块缓存）。 */}
                      <button className="btnd" onClick={() => {
                        logoutYouling()
                        setRoleTick((t) => t + 1)
                        setJoinMsg('✓ 已登出')
                        setTimeout(() => location.reload(), 500)
                      }}>
                        退出登录（钥匙保留，随时可再登录）
                      </button>
                      {role === 'embodiment' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {/* 从本机注销设备（2026-10-09 用户要求，与 PC 对齐）：清设备钥+会话，
                              本机回"全新设备"态（重开=新设备）。账号钥保留（与解绑分层）。
                              2026-10-16 同「退出登录」同款修：roleTick 重算 + 延迟 reload 拿
                              全新设备的干净启动态（原 setJoinMsg 发到看不见的抽屉=无效反馈）。 */}
                          <button className="btnd" onClick={() => {
                            deviceLogoutYouling()
                            setRoleTick((t) => t + 1)
                            setJoinMsg('✓ 已注销设备，本机回到全新设备态')
                            setTimeout(() => location.reload(), 500)
                          }}>
                            从本机注销设备（回全新设备，账号钥保留）
                          </button>
                          <div style={{ marginTop: 2, paddingTop: 8, borderTop: '1px dashed #fca5a5' }}>
                            <div style={{ fontSize: 11, color: 'var(--err)' }}>解绑账号（危险）：删本机账号钥，回未关联。没备份永远找不回。</div>
                            <input value={unbindText} onChange={(e) => setUnbindText(e.target.value)} placeholder='输入"解绑"确认' style={{ width: '100%', marginTop: 4, padding: '6px 8px', borderRadius: 8, border: '1px solid #fca5a5', fontSize: 12 }} />
                            <button onClick={doUnbind} disabled={unbindText.trim() !== '解绑'} style={{ width: '100%', marginTop: 4, padding: '6px', fontSize: 12, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', opacity: unbindText.trim() !== '解绑' ? 0.4 : 1 }}>确认解绑</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 未关联(第31轮定稿,2026-09-16):「登录已有」前置为主按钮防误创建(装第二台设备的人
                99% 已有账号,创建放主位=手滑裂号);创建降级为底部文字链+二次确认拦截。
                三组列表常驻首屏不变,关联引导仍是折叠卡(secondary)。 */}

            {/* Myco 设备列表（2026-10-19 设计定稿：任何角色都常显示；「添加设备」入口已上移
                到账号详情展开区，不再被设备列表隔在中间） */}
            {renderMyco}
          </div>
        )}

        {/* ── 好友/群/聊天（第81轮）：账号卡下方（未关联账号时自隐）── */}
        {tab === 'identity' && identity && !busy && !bk.open && role !== 'unlinked' && (
          <FriendsPanel />
        )}

        {/* ── 第83轮：好友分享的任务在任务 Tab 直接露出（此前只藏在连接主设备后的
            TaskList 里——未连接时接受的任务在任务 Tab 无处可看，"接了任务没看到"根因）。
            连接态与配对态互斥，不会与 TaskList 内的同名区双渲染。── */}
        {tab === 'connect' && identity && !busy && !bk.open && role !== 'unlinked' && (
          <PeerTasksSection />
        )}

        {/* ── 任务（Tab）：主设备列表——点主设备进入它的任务卡片列表 ── */}
        {tab === 'connect' && identity && ready && !busy && role !== 'unlinked' && (
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <span className="card-title" style={{ marginBottom: 0 }}>主设备</span>
              <span style={{ fontSize: 12, color: 'var(--ok)' }}>✓ 已就绪</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>任务在你的主设备上</div>

            {loadingPresence && mains.length === 0 && (
              <div style={{ padding: '16px 0', fontSize: 13, color: 'var(--muted)' }}><span className="spinner" /> 正在找你的主设备…</div>
            )}
            {!loadingPresence && mains.length === 0 && (
              <div style={{ padding: '16px 0', fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                还没有在线的主设备。<br />在主设备上运行 myco 并登录同一个账号，它就会出现在这里。
              </div>
            )}
            {mains.map((p) => {
              // 2026-10-11 设计定稿：文字链（"直连不通→云端中转"/"探测中…"）废弃——
              // 换「图标+文字」徽标：⚡直连 / ☁中转 / 旋转·连接中（conn-badge，
              // 与 PC/DSH 底部连接指示器同款）。WebRTC 打洞优先（穿防火墙的直连），
              // IPv6 探测只是次要参考。
              const probe = directProbe[p.did]
              const connecting = connectingDid === p.did
              return (
                <button key={p.did} onClick={() => tryConnect(p)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 4px', borderTop: '1px solid var(--border)', textAlign: 'left' }}>
                  <div style={{ width: 40, height: 40, borderRadius: 12, background: 'linear-gradient(135deg,#6b7bff,#4ec9a5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 17, flexShrink: 0 }}>{p.kind === 'phone' ? '📱' : '🖥'}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>{p.name || '主设备'}</div>
                    <div style={{ marginTop: 3 }}><ConnBadge mode={connBadgeMode(probe, p.webrtc, connecting)} /></div>
                  </div>
                  <span style={{ fontSize: 11, color: connecting ? 'var(--muted)' : 'var(--ok)', flexShrink: 0 }}>{connecting ? '⏳' : '● 在线'}</span>
                </button>
              )
            })}
          </div>
        )}

        {/* ── 第90轮 设计定稿禁用：「安全设置」折叠入口——给用户困惑、几乎不会去用；
            PC 端等价能力=账号页「🔑 账号钥备份」。代码保留不删（第72轮中转兜底同款处理，
            复开条件登记在仓根 TODO.md）：随正式设置页一起重开，别单独复活这个折叠按钮。
            复开=取消本段注释；引用的 state/handler 已带 _ 前缀保留在声明处（名字一一对应）。
        {tab === 'identity' && identity && !busy && role !== 'unlinked' && (
          <>
            <button onClick={() => _setShowSettings(!_showSettings)} style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
              {_showSettings ? '▼' : '▶'} 安全设置{getStorageMode() === 'enc' ? '（加密模式）' : ''}
            </button>
            {_showSettings && (
              <div className="card" style={{ marginTop: 6 }}>
                〔原注释·第47轮（设计定稿）：enc 密码模式入口砍掉——DPAPI/系统沙箱已兜底，多记密码是负担。
                  存量 enc 用户保留「解锁并切回快速模式」出口；enc 代码保留不删。〕
                {getStorageMode() === 'enc' ? (
                  <>
                    <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 8 }}>
                      当前是<b>加密模式</b>（遗留）。输当前密码解锁并切换回快速模式（钥匙由系统加密保护，打开即用）。
                    </div>
                    <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="当前本地密码" style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13 }} />
                    <button className="btn ghost" style={{ width: '100%', marginTop: 8 }} onClick={_toPlain}>解锁并切换到快速模式</button>
                    {_settingsMsg && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-2)' }}>{_settingsMsg}</div>}
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 8 }}>
                    钥匙由系统加密保护（Windows DPAPI / 应用沙箱），打开即用，无需额外密码。
                  </div>
                )}
                {_settingsMsg && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-2)' }}>{_settingsMsg}</div>}
                {role === 'embodiment' && (
                  <button onClick={reopenBackup} style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
                    重新备份账号钥
                  </button>
                )}
                <button onClick={_revealKey} style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
                  {showKey ? '隐藏设备钥（myco）' : '备份设备钥 myco（换机恢复用）'}
                </button>
                {showKey && (
                  <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: 'var(--warn-soft,#fdf6e3)', border: '1px dashed #ecd9a8', fontSize: 11, fontFamily: 'ui-monospace,monospace', wordBreak: 'break-all', color: 'var(--text-2)' }}>
                    {_keyB64}
                  </div>
                )}
              </div>
            )}

            〔原注释·第72轮：删"了解有灵的工作原理"死链——youling.cc/docs/how-it-works
              页面不存在（404）,对工具用户是干扰项。真要了解走"去探索"卡。〕
          </>
        )}
        ── 第90轮禁用块到此 ── */}

        {/* 2026-11-01 jason 设计：扫码登录已收进「去探索」卡右侧（🔑 图标），此处独立按钮移除。 */}
        {showYLLogin && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(8,12,20,.78)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <YoulingLogin onClose={() => setShowYLLogin(false)} />
          </div>
        )}

{identity && ready && !busy && !bk.open &&  role !== 'unlinked' && !locked && (
        <div className='tabbar'>
          <button className={'tabbtn' + (tab === 'connect' ? '' : ' ghost')} onClick={() => setTab('connect')}>📋 任务</button>
          {/* 批四：App 级未读徽章（好友/群新消息总数；>99 显 99+） */}
          <button className={'tabbtn' + (tab === 'identity' ? '' : ' ghost')} onClick={() => setTab('identity')} style={{ position: 'relative' }}>
            🤖 智能体
            {chatUnread > 0 && (
              <span style={{ position: 'absolute', top: -5, right: 8, minWidth: 16, height: 16, borderRadius: 8, background: '#e5534b', color: '#fff', fontSize: 10, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px', boxShadow: '0 1px 4px rgba(0,0,0,.25)' }}>
                {chatUnread > 99 ? '99+' : chatUnread}
              </span>
            )}
          </button>
        </div>
      )}
      </div>
    </div>
  )
}