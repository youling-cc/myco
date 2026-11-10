/**
 * IdentityPanel — 身份面板（右侧滑出/embed 全屏）。两个一级栏目：Youling（身份）+ Myco（协作设备）。
 * 见 design/08-identity/SOUL-MYCO-MODEL.md 与 plans/recursive-zooming-pie.md。
 *
 * Youling：主设备全权（改名/密码/备份/加设备到 Youling），成员只读，
 *   未关联=创建全新 + 登录引导（批A 2026-09-30：出示码/恢复码导入收编进 home 登录器
 *   method 屏，宿主经 onLogin 回调跳转；本面板不再自带第二份登录实现）。
 * Myco：设备按归属 Youling 分组（好友列表），每台独立放行（MycoDevices 组件）。
 */
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { X, Fingerprint } from 'lucide-react'
import { useIdentityStore } from '../stores/identityStore'
import { MycoDevices } from './MycoDevices'
import { client } from '../api/client'
// 网页提交授权剩余（2026-10-10 任务2 方案 A：不发系统通知，只在界面显示）文案单一源
import { sessionKeyText, sessionKeyExpired, type SessionKeyStatus } from '../lib/sessionKey'
// 分身设备授权（委任状）剩余（2026-10-11 自动续约配套）：文案/分档/颜色单一源
import { delegationStatusText, delegationLevel, delegationLevelColor, type DelegationStatus } from '../lib/delegationStatus'
// 备份码遮蔽状态机单一源（2026-10-06 随 env 退役迁入 home/ui——相对路径深度不变，同 scanAddOrder/cameraError 先例）
import { backupPanel, backupPanelInitial, backupIdleTimerOn, backupCopyTimerOn, BACKUP_MASK_IDLE_MS, BACKUP_MASK_AFTER_COPY_MS } from '../../../../../packages/ui-kit/src/backupMask'
// credText=本机凭据状态文案单一源（2026-10-01 账号页重排：不再用主设备/分身短词当徽章）
import { nicknameValue, credText } from '../lib/accountDisplay'
// 旧格式账号引导（2026-10-07 清档闸门）：文案单一源 + 显隐判定
import { LEGACY_FORMAT_TITLE, LEGACY_FORMAT_BODY, LEGACY_FORMAT_ACTION, shouldShowLegacyBanner, shouldShowUnbindPanel } from '../lib/legacyAccount'
// 面板分工引导句（2026-10-13 P1：设备名单/在线状态让给智能体 Tab，本页只留身份管理）
import { DEVICES_MOVED_HINT, DEVICES_MOVED_JUMP } from '../lib/devicePanels'
import '../demo.css'

/* 第42轮（双模型评审）：公钥默认截断（保留 did:method: 前缀），点击看全文，复制始终完整值 */
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200) }
    catch { /* 非安全上下文 */ }
  }
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
    </div>
  )
}

const sanitizeName = (s: string) => s.replace(/[\r\n\t\x00-\x1f]/g, '').trim().slice(0, 32)

export function IdentityPanel({ onClose, embed = false, onLogin, onLogout, topSlot, onOpenAgentsTab }: {
  onClose: () => void
  embed?: boolean
  /** 批A：未关联态登录入口——宿主（home 登录器）给 onLogin 时跳 method 屏 */
  onLogin?: () => void
  /** 退出登录（2026-10-06 补入口）：轻操作——只清当前会话（myco_logout），本机账号
   *  钥匙槽保留、随时可再登录；与危险区解绑（删账号钥）/设备注销（删设备钥）分层。 */
  onLogout?: () => void
  /** 批 B：① 账号区顶部账号卡（App.tsx 注入：头像+昵称+尾号+切换账号▾真下拉入口）。
   *  2026-10-01 重排：accountsSlot（③账号管理区）整区下线——切换/登录/创建收进
   *  home 顶部卡的下拉浮层（App.tsx），本组件不再承载账号列表。 */
  topSlot?: ReactNode
  /** 2026-10-13 P1：设备名单/在线状态让给「🤖 智能体」Tab 后，引导句旁的跳转回调
   *  （宿主给 = 渲染「去查看 →」；不给则只显示引导句，组件可独立复用）。 */
  onOpenAgentsTab?: () => void
}) {
  const { did, rootDid, role, accountName, hasPassword, locked, accountBusy, accountError, renameError,
    createYouling, unlock,
    renameYouling, setBackedUpCloud,
    refreshYoulingDevices, loadYouling, accountFormatLegacy, refreshYoulingStatus } = useIdentityStore()

  // 旧格式标记刷新（2026-10-07）：面板打开即拉一次——自愈在 boot 后异步检出，
  // boot 那次 status 可能还没置位；打开账号页必须看到最新引导态。
  useEffect(() => { void refreshYoulingStatus() }, [refreshYoulingStatus])

  // 网页提交授权（会话委任状 12h）剩余 —— 2026-10-10 任务2 方案 A（设计定稿
  // 「总之不想打扰用户」）：**不发 Windows 系统通知**，只在界面显示这一行小字。
  // 数据源：Rust `session_key_status()`（零私钥；无记录 → null）+ `session-key-due`
  // 事件（到期窗口内由常驻环广播一次，界面即时刷新）。60s 轮询让"剩余 X"跟着走。
  const [sessionKey, setSessionKey] = useState<SessionKeyStatus | null>(null)
  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const s = await client.invoke<SessionKeyStatus | null>('session_key_status')
        if (alive) setSessionKey(s ?? null)
      } catch { /* 命令不可用/读取失败 → 不显示（不打扰） */ }
    }
    void pull()
    const t = setInterval(() => void pull(), 60_000)
    // 走 client.listen（浏览器模式自动降级为 no-op，与其它事件监听同款封装）
    const un = client.listen<SessionKeyStatus>('session-key-due', (e) => { if (alive && e.payload) setSessionKey(e.payload) })
    return () => { alive = false; clearInterval(t); void un.then((f) => f()) }
  }, [])

  // 分身设备授权（委任状）剩余 —— 2026-10-11 自动续约配套的用户可见提前预警：
  // 成员卡显示「授权剩余 X 天」（>3 天绿 / ≤3 天橙 / 过期红「请在主设备上重新授权」）。
  // 数据源：Rust `delegation_status`（零私钥；无委任状/非成员 → null 不渲染）；
  // 60s 轮询让"剩余 X"跟着走，delegation-received（取到新状）事件即时刷新。
  const [delegSt, setDelegSt] = useState<DelegationStatus | null>(null)
  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const s = await client.invoke<DelegationStatus | null>('delegation_status')
        if (alive) setDelegSt(s ?? null)
      } catch { /* 命令不可用/读取失败 → 不显示 */ }
    }
    void pull()
    const t = setInterval(() => void pull(), 60_000)
    const un = client.listen('delegation-received', () => { void pull() })
    return () => { alive = false; clearInterval(t); void un.then((f) => f()) }
  }, [])

  const [agentNotice, setAgentNotice] = useState(() => !localStorage.getItem('myco-pc.agentNoticeSeen'))
  const [createConfirm, setCreateConfirm] = useState(false)  // 未关联创建前二次确认（第31轮 防误创建裂号）
  // 账号密码
  const [accountPw, setYoulingPw] = useState('')
  const [accountPwMsg, setYoulingPwMsg] = useState<string | null>(null)
  // 备份（2026-10-01 整改：open/seed/masked/copied 归 ui-kit backupMask 状态机——
  // 恢复码不再明文晾屏：10s 无操作/复制后 3s 自动遮蔽并清出内存，重新显示=重导新码）
  const [newYoulingName, setNewYoulingName] = useState('')
  const [newYoulingPhone, setNewYoulingPhone] = useState('')
  const [newYoulingEmail, setNewYoulingEmail] = useState('')
  const [bk, bkDispatch] = useReducer(backupPanel, backupPanelInitial)
  const [backupConfirmed, setBackupConfirmed] = useState(false)
  const [backupErr, setBackupErr] = useState<string | null>(null)
  // 解绑账号（高风险）
  const [unbindText, setUnbindText] = useState('')
  const [unbindMsg, setUnbindMsg] = useState<string | null>(null)
  const [unbindOpen, setUnbindOpen] = useState(false)
  // 设备注销（2026-09-30 设计定稿：与解绑分层——清设备钥+会话，账号/服务端不动）
  const [devLogoutOpen, setDevLogoutOpen] = useState(false)
  const [devLogoutText, setDevLogoutText] = useState('')
  const [devLogoutMsg, setDevLogoutMsg] = useState<string | null>(null)
  const [nameSaved, setNameSaved] = useState(false)

  // 引导条一键跳危险区（2026-10-07 旧格式引导；2026-10-08 修订：只展开「解绑账号」——
  // 「注销设备」不清账号（回来旧格式账号仍在=死循环）且确认暗语（"注销"）与引导语境错位，
  // 用户实测在解绑框输"注销"致按钮恒灰"没反应"）
  // 2026-10-09：引导条已升级为 App 层模态阻断（不在账号页角落）——本函数不再被调用。
  const dangerZoneRef = useRef<HTMLDivElement>(null)
  /** 解绑「确认解绑」按钮 ref（2026-10-08）：小窗下输入框聚焦时把按钮滚进可见区。 */
  const unbindBtnRef = useRef<HTMLButtonElement>(null)

  // 主设备：周期刷新名下设备（MycoDevices 自取 authorized；这里刷新 账号名册给加设备用）
  useEffect(() => {
    if (!rootDid) return
    void refreshYoulingDevices()
    const t = setInterval(() => void refreshYoulingDevices(), 10000)
    return () => clearInterval(t)
  }, [rootDid, refreshYoulingDevices])

  const doUnlock = async () => { const ok = await unlock(accountPw); setYoulingPw(''); setYoulingPwMsg(ok ? '✓ 已解锁' : '密码不对') }

  const doCreateYouling = async () => {
    const newRootDid = await createYouling(newYoulingName || undefined, newYoulingPhone || undefined, newYoulingEmail || undefined)
    if (newRootDid) {
      try { bkDispatch({ type: 'open', seed: await client.invoke<string>('myco_export_seed') }) } catch { bkDispatch({ type: 'open', seed: '（导出失败，请重试）' }) }
      setBackupConfirmed(false); setBackupErr(null)
    }
  }
  // 备份记号只存本机（per-Youling），不依赖服务器；丢了重新备份即可
  const accountBackedUp = !!(rootDid && localStorage.getItem(`myco-pc.accountBackedUp:${rootDid}`))
  const finishBackup = () => {
    if (!backupConfirmed) { setBackupErr('请勾选"我已妥善保存"'); return }
    if (rootDid) localStorage.setItem(`myco-pc.accountBackedUp:${rootDid}`, '1')
    void setBackedUpCloud()
    bkDispatch({ type: 'finish' })   // 清码关窗（码不随弹窗关闭驻留内存）
    setBackupConfirmed(false); setBackupErr(null)
  }
  // 稍后备份（2026-10-01 用户实测：弹窗无退出通道）——显式安全退出：清码关窗，
  // 不写 accountBackedUp 记号 → 账号页"未备份"橙徽标仍在（第42轮提醒设计保留）。
  // 遮罩点不关的"强制"语义不破：稍后是显式按钮，不是误触通道。
  const laterBackup = () => {
    bkDispatch({ type: 'later' })
    setBackupConfirmed(false); setBackupErr(null)
  }
  // 重新显示：重导恢复码（myco_export_seed 可重复调用）——旧码已随遮蔽清出内存/屏幕
  const revealBackupSeed = async () => {
    try { bkDispatch({ type: 'reveal', seed: await client.invoke<string>('myco_export_seed') }) } catch { bkDispatch({ type: 'reveal', seed: '（导出失败，请重试）' }) }
  }
  const doCopyBackup = () => {
    if (bk.masked || !bk.seed) return
    void navigator.clipboard.writeText(bk.seed).then(() => bkDispatch({ type: 'copied' }))
  }
  // 遮蔽计时（状态机开关见 ui-kit backupMask）：10s 无操作 / 复制后 3s
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
  const doUnbind = async () => {
    if (unbindText.trim() !== '解绑') { setUnbindMsg('请输入"解绑"二字以确认'); return }
    if (!accountBackedUp) { setUnbindMsg('先备份恢复码（上方）再解绑——没备份就永远找不回'); return }
    try {
      await client.invoke('myco_unbind')
      if (rootDid) localStorage.removeItem(`myco-pc.accountBackedUp:${rootDid}`)
      // 2026-10-08 用户实测 bug：解绑成功后本区**未收起**——未关联态页面上仍渲染这张红框，
      // 且因 accountBackedUp 标记同被清除，文案恰好落在"请先完成备份，再解绑。"分支，
      // 看起来像"解绑没生效"。修：成功后一并收起本区（配合渲染条件加 role 守卫双保险）。
      setUnbindText(''); setUnbindMsg(null); setUnbindOpen(false)
      await loadYouling()   // role → unlinked，面板重渲染进未关联态
    } catch (e) { setUnbindMsg(String(e).replace(/^Error:\s*/, '')) }
  }
  // 设备注销：清设备钥+会话 → 本机回未注册态（重开=全新设备）。账号种子不动。
  const doDevLogout = async () => {
    if (devLogoutText.trim() !== '注销') { setDevLogoutMsg('请输入"注销"二字以确认'); return }
    try {
      await client.invoke('myco_device_logout')
      // 设备钥已换——全量刷新让身份链重走（新设备 DID/重新注册）
      window.location.reload()
    } catch (e) { setDevLogoutMsg(String(e).replace(/^Error:\s*/, '')) }
  }
  const reopenBackup = async () => {
    if (locked) { setYoulingPwMsg('🔒 先解锁账号（详情里）再备份'); return }
    try { bkDispatch({ type: 'open', seed: await client.invoke<string>('myco_export_seed') }) } catch { bkDispatch({ type: 'open', seed: '（导出失败，请重试）' }) }
    setBackupConfirmed(false); setBackupErr(null)
  }

  // 账号密码块（第30轮精简定稿：删「设置/取消密码」入口——小白忘密码=账号锁死，风险大于收益，
  // Windows 账户已隔离本机文件。仅保留存量已设密码者的解锁屏（locked 分支），不再新增设密人。）
  const accountPwBlock = locked ? (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold text-[var(--text-muted)]">账号密码 <span className="font-normal">🔒 已锁定</span></div>
      <div className="text-[11px] text-amber-800">🔒 恢复码已锁定，输密码解锁后才能备份/加设备。</div>
      <input type="password" value={accountPw} onChange={(e) => setYoulingPw(e.target.value)} placeholder="有灵账号 密码" className="w-full h-8 px-2 text-[12px] bg-white border border-[var(--chrome-border)] rounded focus:outline-none focus:border-[var(--accent)]" />
      <button onClick={doUnlock} className="w-full h-9 text-[12px] font-medium rounded bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]">解锁</button>
      {accountPwMsg && <div className="text-[11px]" style={{ color: accountPwMsg.startsWith('✓') ? '#059669' : '#ff8a80' }}>{accountPwMsg}</div>}
    </div>
  ) : hasPassword ? (
    <div className="text-[10px] text-[var(--text-muted)]">🔒 恢复码已加密保护</div>
  ) : null

  // 第25轮:内容段单份定义——embed(全屏账号页)/滑出窗 两种容器复用
  const panelBody = (
    <>
          {/* ── 旧格式账号引导条（2026-10-07 清档闸门立法，醒目置顶）──
              名册自愈检出 create 400 unsupported_did_format → accountFormatLegacy：
              此账号格式已死（服务端一律拒建，加好友 403/搜不到）。不再静默——
              引导两条出路：解绑后重注册，或先导恢复码再导入延续钥匙。
              2026-10-09 修订（设计定稿）：引导条升级为 **App 层模态阻断**（不在账号页角落）——
              本区不再渲染（避免双提示）。 */}

          {agentNotice && (
            <div className="cardd" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="tinyd" style={{ flex: 1 }}>设备钥匙已自动生成，只需备份<b>有灵账号</b>。</span>
              <button className="btnd ghost small" style={{ flexShrink: 0, padding: '5px 10px', fontSize: 11 }} onClick={() => { localStorage.setItem('myco-pc.agentNoticeSeen', '1'); setAgentNotice(false) }}>知道了</button>
            </div>
          )}

          {/* ── ① 账号区（我是谁）：顶部账号卡 + 资料子卡 + 备份子卡 ── */}
          {topSlot}

          {/* 网页提交授权剩余（2026-10-10 任务2 方案 A）——只在有记录且已关联账号时
              显示一行小字；无记录整个不渲染（不给用户噪音）。dueWarn=琥珀色 + "即将过期"。
              C-4（2026-10-22 设计定稿「小改进」）：已过期时那一行**可点**——点击清掉本机
              陈旧记录（调用 session_key_clear），账号页不再长期挂红字；清除只动本地跟踪文件，
              下次网页答题时由页面侧走正常重新授权（客户端不能静默签新钥，安全闸 C-5）。 */}
          {sessionKey && rootDid && (sessionKeyExpired(sessionKey) ? (
            <button
              className="tinyd"
              title="点击清除过期记录；下次在网页答题时会重新授权"
              onClick={async () => {
                try { await client.invoke('session_key_clear') } catch { /* 容错：清不掉也让界面收起，下次启动自动清 */ }
                setSessionKey(null)
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '2px 2px',
                color: '#92400e', background: 'none', border: 'none', cursor: 'pointer',
                textAlign: 'left', font: 'inherit',
              }}
            >
              <span>⏳</span>
              <span style={{ textDecoration: 'underline dotted' }}>{sessionKeyText(sessionKey)}</span>
              <span style={{ fontSize: 10, opacity: 0.75 }}>（点击清除）</span>
            </button>
          ) : (
            <div className="tinyd" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 2px', color: sessionKey!.dueWarn ? '#92400e' : 'var(--text-muted)' }}>
              <span>{sessionKey!.dueWarn ? '⏳' : '🔐'}</span>
              <span>{sessionKeyText(sessionKey!)}</span>
            </div>
          ))}

          {role === 'embodiment' && rootDid && (
            <>
            <div className="cardd">
              {/* 2026-10-01 重排：标题旁「主设备」徽章删——role 是「本机对该账号持有什么凭据」
                  不是账号属性；凭据状态文案在顶部卡下拉菜单行（credText）表达，本卡即默认主设备态 */}
              <div className="h2d">🪪 账号资料</div>
              <div className="tinyd" style={{ margin: '2px 0 6px' }}>公钥是你的账号身份，点行可看全文</div>
              <input className="inpd" defaultValue={nicknameValue(accountName)} onBlur={async (e) => { const v = e.target.value.trim(); if (v && v !== accountName) { const ok = await renameYouling(v); if (ok) { setNameSaved(true); setTimeout(() => setNameSaved(false), 1600) } } }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} placeholder="给自己起个名字" />
              {nameSaved && <div className="tinyd" style={{ color: '#15803d', margin: '4px 0 0' }}>✓ 已自动保存</div>}
              {renameError && <div className="tinyd" style={{ color: '#dc2626', margin: '4px 0 0' }}>改名失败：{renameError}（名字未保存，可重试）</div>}
              <div style={{ marginTop: 6 }}><CopyField label="账号公钥（DID）" value={rootDid} /></div>
            </div>

            <div className="cardd">
              <div className="h2d">🔑 恢复码备份 {!accountBackedUp
                ? <span className="chipd" style={{ fontSize: 11, padding: '1px 6px', marginLeft: 4, background: '#fef3c7', color: '#92400e' }}>未备份</span>
                : <span className="chipd green" style={{ fontSize: 11, padding: '1px 6px', marginLeft: 4 }}>已备份</span>}</div>
              <div className="tinyd" style={{ margin: '2px 0 6px' }}>{accountBackedUp ? '已备份过。需要时可重新导出。' : '备份后才能在新设备找回账号。'}</div>
              {accountBackedUp
                ? <button className="btnd ghost" onClick={reopenBackup}>重新导出备份</button>
                : <button className="btnd" onClick={reopenBackup}>立即备份</button>}
              {locked && accountPwBlock}
            </div>
            </>
          )}

          {role === 'agent' && (
            <div className="cardd">
              {/* 2026-10-01 重排：chip 文案走 credText（本机凭据状态单一源），不用「本机是分身」短词 */}
              <div className="h2d">📱 成员 <span className="chipd gray" style={{ fontSize: 11, padding: '1px 6px', marginLeft: 4 }}>{credText('agent')}</span></div>
              <div className="tinyd" style={{ margin: '2px 0 4px' }}>本机是<b>成员</b>——能用、能看名册，管理（加设备/除名/备份）请到主设备。</div>
              {/* 2026-10-11 设备授权剩余（提前预警）：>3 天绿 / ≤3 天橙 / 过期红。
                  数据缺失（null）整行不渲染——主设备/未收编不显示。 */}
              {delegSt && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 11.5, fontWeight: 600, color: delegationLevelColor(delegationLevel(delegSt)) }}>
                  <span>{delegationLevel(delegSt) === 'expired' ? '⛔' : delegationLevel(delegSt) === 'warn' ? '⏳' : '🔐'}</span>
                  <span>{delegationStatusText(delegSt)}</span>
                </div>
              )}
              {rootDid && <CopyField label="账号公钥（DID）" value={rootDid} />}
            </div>
          )}

          {/* ── ② 设备区（本机身份管理）：添加设备 / 出示码配对 / 放行管理 ──
              2026-10-13 P1：**只读设备运行态（在线状态、设备名单浏览）已让给底部
              「🤖 智能体」Tab**（那边是设备操作层）——本区不再重复渲染在线点/名册浏览，
              只留一句引导（DEVICES_MOVED_HINT），保证用户找得到。 */}
          {role === 'embodiment' && rootDid && (
            <>
            <div className="cardd" style={{ padding: '9px 12px' }}>
              <div className="tinyd" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span>🖥 {DEVICES_MOVED_HINT}</span>
                {onOpenAgentsTab && (
                  <span className="linkish" style={{ fontSize: 11.5, padding: 0 }} onClick={onOpenAgentsTab}>{DEVICES_MOVED_JUMP}</span>
                )}
              </div>
            </div>
            <MycoDevices myYoulingDid={rootDid} myYoulingName={accountName} localDid={did} isEmbodiment={role === 'embodiment'} />
            </>
          )}

            {role === 'unlinked' && !bk.open && (
              <>
                {/* ── 批A（2026-09-30 设计定稿）：「出示本机码」「恢复码导入」两张登录卡已下线——
                    它们与 home 登录器 method 屏是同一件事两份实现（出示码=show 屏；恢复码折叠区
                    调的 myco_import 在 exe Rust 侧根本不存在=死链）。登录入口收编进 method 屏
                    （恢复码导入已在那内联展开+真链通），本面板只留：登录引导（宿主给 onLogin 时）
                    + 创建全新。
                    「🔢 6 位加入码」更早下线（join 配对码服务端从未实现）——复开条件登记在仓根 TODO.md。 */}
                {onLogin && (
                  <div className="cardd" style={{ cursor: 'pointer', borderColor: '#b9c6ff' }} onClick={onLogin}>
                    <div className="h2d" style={{ fontSize: 12.5 }}>🔑 登录已有有灵账号</div>
                    <div className="tinyd" style={{ marginTop: 2 }}>在电脑/其他手机上注册过有灵？去登录流程——我的识别码（成为成员）或恢复码导入（成为主设备）→</div>
                  </div>
                )}

                {/* 创建（二次确认拦截） */}
                {!createConfirm ? (
                  <div className="textlink"><span className="linkish" onClick={() => setCreateConfirm(true)}>第一次用有灵？创建一个全新的 →</span></div>
                ) : (
                  <div className="cardd warn-cardd">
                    <div className="h2d">创建全新账号前，确认一下</div>
                    <div className="subd" style={{ marginTop: 4 }}>如果你在<b>其他设备上已经有有灵账号</b>，请返回用「登录已有」——直接创建会变成两个互不相通的独立账号。</div>
                    <input className="inpd" style={{ marginTop: 8 }} value={newYoulingName} onChange={(e) => setNewYoulingName(sanitizeName(e.target.value))} placeholder="给它起个名（可选，之后也能改）" />
                    <input className="inpd" style={{ marginTop: 6 }} value={newYoulingPhone} onChange={(e) => setNewYoulingPhone(e.target.value)} placeholder="手机号（用于身份找回，可选）" />
                    <input className="inpd" style={{ marginTop: 6 }} value={newYoulingEmail} onChange={(e) => setNewYoulingEmail(e.target.value)} placeholder="邮箱（用于身份找回，可选）" />
                    <button className="btnd" style={{ marginTop: 8 }} onClick={doCreateYouling} disabled={accountBusy}>
                      {accountBusy ? '创建中…' : '✨ 是，创建全新账号'}
                    </button>
                    <button className="btnd ghost" style={{ marginTop: 6 }} onClick={() => setCreateConfirm(false)}>返回登录已有账号</button>
                    {accountError && <div className="tinyd" style={{ color: '#dc2626' }}>{accountError}</div>}
                  </div>
                )}
              </>
            )}

          {/* 强制备份弹窗（第41轮 K3 方案：三行恢复码+复制+勾选，遮罩点不关=强制性）。
              2026-10-01 整改（用户实测：无退出通道+码明文晾屏）：
              ① 底部加「稍后备份」显式退出（不写已备份记号，"未备份"提醒仍在）；
              ② 10s 无操作/复制后 3s 自动遮蔽并清码，「重新显示」=重导新码（ui-kit backupMask）。 */}
          {bk.open && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,.45)' }}>
              <div style={{ width: 288, background: '#fff', borderRadius: 12, border: '1px solid #e4eaf2', padding: 16, color: '#1a2233', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 40, textAlign: 'center' }}>⚠️</div>
                <div style={{ fontSize: 17, fontWeight: 800, textAlign: 'center' }}>备份恢复码</div>
                <div className="cardd warn-cardd"><div className="tinyd">这是找回账号的唯一方式。请抄写或复制保存，不要截图发给任何人。</div></div>
                {bk.masked ? (
                  <div className="cardd" style={{ textAlign: 'center' }}>
                    <div style={{ fontFamily: 'ui-monospace,monospace', fontSize: 14, letterSpacing: 3, color: '#8a97ab', padding: '4px 0' }}>•••• •••• ••••</div>
                    <div className="tinyd">已自动隐藏，点「重新显示」再看</div>
                  </div>
                ) : (
                  <div className="cardd" style={{ cursor: 'pointer' }} onClick={doCopyBackup} title="点击复制完整恢复码">
                    {(() => { const n = Math.ceil(bk.seed.length / 3); return [bk.seed.slice(0, n), bk.seed.slice(n, n * 2), bk.seed.slice(n * 2)].map((seg, i) => (
                      <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                        <span className="tinyd" style={{ flexShrink: 0 }}>{i + 1}.</span>
                        <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: 11.5, fontWeight: 600, wordBreak: 'break-all', userSelect: 'all' }}>{seg}</span>
                      </div>
                    )) })()}
                    {bk.copied && <div className="chipd green" style={{ alignSelf: 'center', marginTop: 4 }}>✓ 已复制</div>}
                  </div>
                )}
                {bk.masked
                  ? <button className="btnd ghost" onClick={revealBackupSeed}>👁 重新显示恢复码</button>
                  : <button className="btnd ghost" onClick={doCopyBackup}>📋 复制恢复码</button>}
                <label className="flex items-center gap-1.5" style={{ fontSize: 12, color: '#5b6a83' }}><input type="checkbox" checked={backupConfirmed} onChange={(e) => { setBackupConfirmed(e.target.checked); bkDispatch({ type: 'interact' }) }} /> 我已妥善保存恢复码</label>
                {backupErr && <div className="tinyd" style={{ color: '#dc2626' }}>{backupErr}</div>}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btnd ghost" onClick={laterBackup}>稍后备份</button>
                  <button className="btnd" style={{ flex: 1 }} onClick={finishBackup} disabled={!backupConfirmed}>完成</button>
                </div>
              </div>
            </div>
          )}



          {/* ── ③ 账号管理区（2026-10-01 重排）已整区下线：切换/登录/创建收进顶部卡
              「切换账号 ▾」下拉浮层（home App.tsx），避免与列表「切换」文字链双入口、
              当前账号两遍展示。 */}

          {/* 退出登录（2026-10-06 补入口，设计定稿）：轻操作不进危险区——只清当前会话，
              本机恢复码保留（随时可再一键登录）。危险区在下方：解绑=删恢复码、
              设备注销=删设备钥，与退出登录三层语义分明。 */}
          {onLogout && rootDid && (
            <div style={{ marginTop: 8, paddingTop: 4 }}>
              <button className="btnd ghost" onClick={onLogout}
                title="只退出当前登录，不清除本机保存的恢复码——随时可以再登录">退出登录</button>
            </div>
          )}

          {/* 危险区（第42轮双模型评审：解绑下移页面最底，远离备份主按钮）。
              ref=旧格式引导条「一键跳危险区」的滚动落点（解绑+注销两个入口都在此）。 */}
          <div ref={dangerZoneRef}>
          {role === 'embodiment' && rootDid && (
            <div className="textlink" style={{ padding: '8px 0 2px', borderTop: '1px solid var(--card-bd)' }}><span className="linkish" style={{ color: '#dc2626', fontSize: 11.5 }} onClick={() => setUnbindOpen((v) => !v)}>解绑本机的账号（危险）▸</span></div>
          )}
          {shouldShowUnbindPanel(unbindOpen, role, rootDid) && (
            <div className="cardd warn-cardd">
              <div className="tinyd" style={{ color: '#b91c1c' }}>删除本机恢复码，设备回到未关联态。<b>没备份就永远找不回这个账号。</b></div>
              {!accountBackedUp ? (
                <div className="tinyd" style={{ color: '#92400e' }}>请先完成备份，再解绑。</div>
              ) : (
                <>
                <input className="inpd" style={{ marginTop: 6 }} value={unbindText}
                  onChange={(e) => setUnbindText(e.target.value)} placeholder='输入"解绑"二字确认'
                  /* 2026-10-08 用户实测：小窗（320x640）下输入框获得焦点时"确认解绑"按钮在屏幕外
                     ——聚焦后把按钮滚进最近可见区（等一帧让输入法/布局稳定）。 */
                  onFocus={() => setTimeout(() => unbindBtnRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 120)} />
                <button ref={unbindBtnRef} className="btnd danger" style={{ marginTop: 6 }} onClick={doUnbind} disabled={unbindText.trim() !== '解绑'}>确认解绑</button>
                </>
              )}
              {unbindMsg && <div className="tinyd">{unbindMsg}</div>}
            </div>
          )}

          {/* 设备注销（2026-09-30 设计定稿：与解绑分层——清设备钥+会话，账号/服务端名册不动） */}
          {role === 'embodiment' && rootDid && (
            <div className="textlink" style={{ padding: '4px 0 2px' }}><span className="linkish" style={{ color: '#dc2626', fontSize: 11.5 }} onClick={() => setDevLogoutOpen((v) => !v)}>从本机注销设备（危险）▸</span></div>
          )}
          {devLogoutOpen && (
            <div className="cardd warn-cardd">
              <div className="tinyd" style={{ color: '#b91c1c' }}>清除本机设备钥匙与会话。本机将回到未注册状态，重新打开登录器就是一台全新设备（需主设备重新收编）。</div>
              <div className="tinyd" style={{ marginTop: 4 }}>账号本身与服务器上的设备列表不受影响——要彻底除名请在主设备上吊销本机。</div>
              <input className="inpd" style={{ marginTop: 6 }} value={devLogoutText} onChange={(e) => setDevLogoutText(e.target.value)} placeholder='输入"注销"二字确认' />
              <button className="btnd danger" style={{ marginTop: 6 }} onClick={doDevLogout} disabled={devLogoutText.trim() !== '注销'}>确认注销设备</button>
              {devLogoutMsg && <div className="tinyd">{devLogoutMsg}</div>}
            </div>
          )}
          </div>
    </>
  )

  return embed ? (
    <div className="w-full px-panel py-3 space-y-5">{panelBody}</div>
  ) : (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="fixed right-0 top-12 bottom-0 w-[340px] z-40 bg-[var(--chrome-bg)] border-l border-[var(--chrome-border)] shadow-[var(--shadow-lg)] flex flex-col">
        <div className="flex items-center gap-2 px-panel h-11 border-b border-[var(--chrome-border)] shrink-0">
          <Fingerprint size={14} className="text-[var(--accent)]" />
          <span className="text-[13px] font-semibold text-[var(--text-primary)] flex-1">身份</span>
          <button onClick={onClose} className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--chrome-hover)]"><X size={15} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-panel py-3 space-y-5">{panelBody}</div>
      </div>
    </>
  )
}