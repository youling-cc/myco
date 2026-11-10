/**
 * YoulingLogin — 扫码登录有灵（spec login-design 通道①：手机扫网页二维码）。
 *
 * 链路：youling 网页「通过 myco 登录」→ 二维码内容=深链接
 *   myco://auth?ticket=&callback=&svc= （MycoQrLoginProvider 生成，与 exe 通道同构）
 *   → 本组件扫码/读图/手输 ticket → 白名单校验 → 确认框（真实请求方域名）→ 按身份分级签名：
 *   ① 本机=主设备（持根钥）→ 根钥签 myco-auth\n{ticket} → POST {ticket, did, sig}
 *   ② 本机=分身（无根钥，持主设备签的委任状，spec §7.2）→ 设备钥签票 + 委任状随行
 *      POST {ticket, did:设备did, sig, delegation}——平台验链后落账 accountDid
 *   ③ 两者皆无 → 引导一键创建（成为主设备）或到主设备配对成分身
 *   → 网页轮询 ticket 状态自动登录。
 *
 * 过渡期说明：http 环境摄像头被禁（getUserMedia 需安全源），QrCamera 自带
 * 「图库读图」备选；另提供 ticket 手输兜底。HTTPS 上线后摄像头自动可用。
 */
import { useState, useEffect } from 'react'
import { QrCamera } from './QrCamera'
import { getRootIdentity, getRootSeed, signWithRoot, createRootIdentity, currentIdentity, DID_BASE } from '../identity'
import { loadDelegation, pollDelegation, requestRenewal, signWithDeviceKey, devicePubkeyB64 } from '../delegation'

// 防钓鱼白名单（与 exe 侧一致；从 DID_BASE 推导当前服务主机，配置改了跟着走）
function allowedHosts(): string[] {
  const s = new Set(['youling.cc', 'www.youling.cc', 'did.youling.cc', 'localhost', '127.0.0.1'])
  try { s.add(new URL(DID_BASE).hostname) } catch { /* DID_BASE 相对路径时跳过 */ }
  return [...s]
}
const ALLOWED_AUTH_HOSTS = allowedHosts()

interface AuthReq { ticket: string; callback: string; svc: string; host: string }

function parseAuthText(text: string): AuthReq | null {
  // scheme/host 规范大小写不敏感（RFC 3986）——只对前缀段小写比较，不动 query 里的值
  if (!text || text.slice(0, 11).toLowerCase() !== 'myco://auth') return null
  try {
    const q = text.slice(text.indexOf('?') + 1)
    const p = new URLSearchParams(q)
    const ticket = p.get('ticket')
    const callback = p.get('callback')
    if (!ticket || !callback) return null
    return { ticket, callback, svc: p.get('svc') || '', host: new URL(callback).hostname }
  } catch { return null }
}

export function YoulingLogin({ onClose, initialLink }: { onClose: () => void; initialLink?: string }) {
  const [mode, setMode] = useState<'scan' | 'manual' | 'confirm' | 'busy' | 'done' | 'error'>('scan')
  const [req, setReq] = useState<AuthReq | null>(null)

  // hash 启动桥（联调/自动化通道）：EnvServer 等外部写 location.hash=#mycoauth=<urlencoded 深链接>，
  // 组件挂载/hashchange 即解析直达确认页——绕开 isolated-world 无法触发 React onChange 的限制
  useEffect(() => {
    const fromHash = () => {
      const h = location.hash
      if (h.startsWith('#mycoauth=')) {
        const link = decodeURIComponent(h.slice('#mycoauth='.length))
        history.replaceState(null, '', location.pathname)
        const r = parseAuthText(link)
        if (r) { setReq(r); setMode('confirm'); setMsg('') }
        else { setMode('error'); setMsg('深链接无法解析') }
      }
    }
    fromHash()
    window.addEventListener('hashchange', fromHash)
    return () => window.removeEventListener('hashchange', fromHash)
  }, [])

  useEffect(() => {
    if (initialLink) {
      const r = parseAuthText(initialLink)
      if (r) { setReq(r); setMode('confirm') }
      else { setMode('error'); setMsg('深链接无法解析') }
    }
  }, [initialLink])
  const [msg, setMsg] = useState('')

  // 第79轮→80轮定稿：done 态点窗口任意处立即关 + 1.5s 自动关兜底,不放按钮（与 PC 同款）
  useEffect(() => {
    if (mode !== 'done') return
    const t = setTimeout(onClose, 1500)
    document.addEventListener('mousedown', onClose)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', onClose) }
  }, [mode, onClose])

  const [manual, setManual] = useState('')

  const [rootTick, setRootTick] = useState(0) // 创建后强刷 rootDid
  const [creating, setCreating] = useState(false)
  const rootDid = getRootIdentity()
  void rootTick
  const allowed = req ? ALLOWED_AUTH_HOSTS.includes(req.host) : false
  // 分身凭证（spec §7.2）：无根钥时用。过期则先尝试取续签好的，仍过期=不可用。
  const dlg = loadDelegation()
  const deviceDid = currentIdentity()?.did ?? null
  // 委任状绑定的必须是本机当前设备钥（重建过设备身份的旧委任状直接作废）
  const dlgForThisDevice = !!dlg && dlg.devicePubkeyB64 === devicePubkeyB64()
  const dlgUsable = !rootDid && dlgForThisDevice && !!deviceDid && dlg!.exp > Date.now()
  const dlgStale = !rootDid && dlgForThisDevice && !!deviceDid && dlg!.exp <= Date.now()

  const createAccount = async () => {
    setCreating(true)
    try {
      const did = await createRootIdentity('myco 用户')
      if (did) { setRootTick((t) => t + 1); setMsg('') }
      else setMsg('创建失败：账号钥已存在但注册未完成，请到「配对页→关联有灵账号」重试')
    } catch (e) {
      setMsg(`创建失败：${String(e).replace(/^Error:\s*/, '')}`)
    }
    setCreating(false)
  }

  const onScanned = (text: string) => {
    const r = parseAuthText(text)
    if (!r) { setMode('error'); setMsg('不是有效的有灵登录码'); return }
    setReq(r); setMode('confirm'); setMsg('')
  }

  const confirm = async () => {
    if (!req || !allowed) return
    // ① 主设备路径：根钥签票（须真持钥——分身槽 vault.rootDid 有值但无 seed，走 ② 分身签名）
    if (rootDid && getRootSeed()) {
      const sig = signWithRoot(`myco-auth\n${req.ticket}`)
      if (!sig) { setMode('error'); setMsg('根身份锁定或缺失，请先到身份页解锁/创建'); return }
      setMode('busy')
      try {
        const r = await fetch(req.callback, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket: req.ticket, did: rootDid, sig }),
        })
        const body = await r.json().catch(() => ({}))
        if (r.ok && (body.ok !== false)) { setMode('done') }
        else { setMode('error'); setMsg(body.error ? String(body.error) : `平台拒绝（HTTP ${r.status}）`) }
      } catch (e) {
        setMode('error'); setMsg(`回调失败：${String(e).replace(/^Error:\s*/, '')}`)
      }
      return
    }
    // ② 分身路径（spec §7.2）：设备钥签票 + 委任状随行，平台验链落账 accountDid
    if (!dlg || !deviceDid || !dlg.devicePubkeyB64) { setMode('error'); setMsg('本机既无有灵账号根钥，也未被委任——请先创建账号或到主设备配对'); return }
    setMode('busy')
    let cred = dlg
    if (cred.exp <= Date.now()) {
      // 过期先探一次信箱（主设备可能已自动续好），仍过期→投续签请求并提示
      cred = (await pollDelegation()) ?? cred
      if (cred.exp <= Date.now()) {
        void requestRenewal()
        setMode('error')
        setMsg('设备委任已过期：续签请求已发出，请让主设备（电脑上的 myco）保持在线几分钟后再试')
        return
      }
    }
    const sig = await signWithDeviceKey(`myco-auth\n${req.ticket}`)
    if (!sig) { setMode('error'); setMsg('本机设备身份未就绪，请先到配对页生成设备身份'); return }
    try {
      const r = await fetch(req.callback, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: req.ticket, did: deviceDid, sig, delegation: JSON.stringify(cred) }),
      })
      const body = await r.json().catch(() => ({}))
      if (r.ok && (body.ok !== false)) { setMode('done') }
      else { setMode('error'); setMsg(body.error ? String(body.error) : `平台拒绝（HTTP ${r.status}）`) }
    } catch (e) {
      setMode('error'); setMsg(`回调失败：${String(e).replace(/^Error:\s*/, '')}`)
    }
  }

  return (
    <div style={{ padding: '14px 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <b style={{ fontSize: 15 }}>扫一扫登录有灵</b>
        <button onClick={onClose} style={{ padding: '4px 12px', borderRadius: 8, border: '1px solid rgba(124,92,255,.4)', background: 'transparent', color: 'inherit' }}>关闭</button>
      </div>

      {mode === 'scan' && (
        <>
          <QrCamera onResult={onScanned} onClose={() => setMode('manual')} />
          <div style={{ fontSize: 12, opacity: 0.65, margin: '8px 0' }}>
            对准有灵网页上的登录二维码。浏览器无摄像头权限时可截图后从图库读入，或手输：
          </div>
          <button onClick={() => setMode('manual')} style={{ width: '100%', height: 36, borderRadius: 9, border: '1px solid rgba(124,92,255,.4)', background: 'transparent', color: 'inherit' }}>
            手动输入 ticket
          </button>
        </>
      )}

      {mode === 'manual' && (
        <>
          <textarea value={manual} onChange={(e) => setManual(e.target.value)} rows={3} placeholder="粘贴完整登录码（myco://auth?...）或单输 ticket"
            style={{ width: '100%', borderRadius: 8, border: '1px solid rgba(255,255,255,.15)', background: 'rgba(0,0,0,.25)', color: 'inherit', padding: 8, fontSize: 12, boxSizing: 'border-box' }} />
          <button onClick={() => {
            const r = parseAuthText(manual.trim())
            if (r) { setReq(r); setMode('confirm') }
            else if (manual.trim() && req === null) { setMode('error'); setMsg('无法解析，需粘贴完整 myco://auth 链接') }
          }} style={{ width: '100%', height: 36, borderRadius: 9, border: 'none', marginTop: 8, background: 'linear-gradient(135deg,#7c5cff,#4d8dff)', color: '#fff', fontWeight: 600 }}>解析</button>
          <button onClick={() => setMode('scan')} style={{ width: '100%', height: 30, borderRadius: 8, border: '1px solid rgba(255,255,255,.15)', background: 'transparent', color: 'inherit', marginTop: 6, fontSize: 13 }}>返回扫码</button>
        </>
      )}

      {mode === 'confirm' && req && (
        <>
          {allowed ? (
            <>
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                请求方 <b style={{ fontFamily: 'monospace', color: '#9db8ff' }}>{req.host}</b> 请求用您的有灵账号登录
              </div>
              <div style={{ fontSize: 11, opacity: 0.6, fontFamily: 'monospace', marginBottom: 12 }}>
                {(rootDid && getRootSeed())
                  ? `身份：${rootDid.slice(0, 26)}…`
                  : dlgUsable
                    ? `成员身份：账号 ${dlg!.accountDid.slice(-6)} 的委任设备（${dlg!.deviceName || '设备'}）`
                    : '（未有有灵账号）'}
              </div>
              {!rootDid && !dlgUsable && (
                <>
                  <button onClick={createAccount} disabled={creating}
                    style={{ width: '100%', height: 36, borderRadius: 9, border: '1px solid rgba(124,92,255,.4)', background: 'rgba(124,92,255,.12)', color: 'inherit', fontSize: 13, marginBottom: 10 }}>
                    {creating ? '创建中…（注册身份服务）' : '一键创建有灵账户'}
                  </button>
                  {dlgStale && <div style={{ fontSize: 11, color: '#ffb894', marginBottom: 8 }}>本机的设备委任已过期——点登录会先请求续签（需主设备在线）</div>}
                  {!dlgStale && <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 8 }}>或在电脑的 myco「身份→添加设备」里输入本机 DID，成为该账号的成员</div>}
                </>
              )}
              {creating && <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 8 }}>账号钥将生成并注册到有灵身份服务，请稍候</div>}
              <button onClick={confirm} disabled={!rootDid && !dlgUsable && !dlgStale} style={{ width: '100%', height: 38, borderRadius: 9, border: 'none', background: 'linear-gradient(135deg,#7c5cff,#4d8dff)', color: '#fff', fontWeight: 600, opacity: (rootDid || dlgUsable || dlgStale) ? 1 : 0.45 }}>
                确认登录
              </button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 13, color: '#ff9a6b', marginBottom: 8 }}>⚠ 已拦截可疑登录请求</div>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 12 }}>
                请求方 <b style={{ fontFamily: 'monospace', color: '#ff9a6b' }}>{req.host}</b> 不在可信名单内，已拒绝。
              </div>
              <button onClick={() => { setReq(null); setMode('scan') }} style={{ width: '100%', height: 34, borderRadius: 9, border: '1px solid rgba(255,154,107,.5)', background: 'transparent', color: '#ffb894' }}>我知道了</button>
            </>
          )}
        </>
      )}

      {mode === 'busy' && <div style={{ textAlign: 'center', padding: '18px 0', fontSize: 13, opacity: 0.75 }}>确认中…</div>}

      {mode === 'done' && (
        <div onMouseDown={onClose} style={{ textAlign: 'center', padding: '14px 0', cursor: 'pointer' }}>
          <div style={{ fontSize: 30 }}>✓</div>
          <div style={{ fontSize: 14, marginTop: 6 }}>已确认登录</div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>请回到网页，正在自动登录…</div>
          <div style={{ fontSize: 11, opacity: 0.5, marginTop: 8 }}>点击任意位置关闭</div>
        </div>
      )}

      {mode === 'error' && (
        <div style={{ textAlign: 'center', padding: '10px 0' }}>
          <div style={{ fontSize: 12, color: '#ff7a8a', margin: '8px 0' }}>{msg}</div>
          <button onClick={() => { setMode(req ? 'confirm' : 'scan'); setMsg('') }} style={{ padding: '6px 18px', borderRadius: 8, border: '1px solid rgba(124,92,255,.4)', background: 'transparent', color: 'inherit' }}>重试</button>
        </div>
      )}
    </div>
  )
}
