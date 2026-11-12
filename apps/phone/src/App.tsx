/**
 * App — myco 接入口壳：登录/身份（智能体页）→ 主设备任务卡片 → 子任务（项目）列表 → 会话。
 * 视图状态机；手机身份（DID，localStorage 持久）在启动时加载，iroh 连接复用其密钥。
 * 2026-08-25 节点漫游器(期1):多节点切换(NodeRoamer)+审批收件箱——手机从"遥控
 * 一台 PC"升格为"节点群漫游"(design/04-agent/fleet-division-and-node-federation.md)。
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { type Transport, HttpTransport, MockTransport, DirectHttpTransport, WebRtcTransport, connectWebRtc, type SessionInfo } from './transport'
import { ensurePlainIdentity, getStorageMode, currentIdentity, currentYoulingName, fetchMyRoot, getAttestation, clearAttestation, ensureRootRoster, accountFormatLegacy, unbindYouling, getRootIdentity, listDevicesWithStatus, didFromPubkeyB64, type PhoneIdentity, type DeviceWithStatus } from './identity'
import { Pairing } from './components/Pairing'
import { TaskList } from './components/TaskList'
// 第83轮：任务卡事件 toast（App 根级——任意页面/Tab 下任务卡到达与完成都有通知；
// 内部走 ensureBackgroundPoll，顺带修掉"停在任务页时信箱无人拉"的到达盲区）
import { PeerTaskToasts, FriendsPanel } from './components/FriendsPanel'
import { AdbShareCard } from './components/AdbShareCard'
import { ChatView } from './components/ChatView'
import { NodeRoamer, loadNodes, saveNodes, type NodeEntry } from './components/NodeRoamer'

/** 顶层视图（2026-10-08 UI 一致性调研 S2）：补 `'agents'`——此前连上设备后
 *  `view==='tasks'` 只渲染任务页，Pairing（唯一含 tabbar + FriendsPanel 的宿主）
 *  被卸载 ⇒ **手机连上 PC 后 tab 栏整个消失、好友/群/聊天不可达**，唯一出口是
 *  "断开连接"（TaskList 的 ⚙️）。现把「🤖 智能体」提升为 App 层视图（FriendsPanel
 *  是零参组件，可直接渲染），配合下方常驻底栏，与 PC「任何状态好友都在智能体 tab」
 *  对齐。 */
type View = 'pairing' | 'tasks' | 'list' | 'terminal' | 'agents'
export type PairMode = 'http' | 'mock' | 'direct' | 'webrtc'

const LS = { mode: 'youling.mode', value: 'youling.value' }

function buildTransport(mode: PairMode, value: string): Transport {
  switch (mode) {
    case 'webrtc': return new WebRtcTransport(value)         // value = PC did；WebRTC 直连打洞（去中心化）
    case 'direct': return new DirectHttpTransport(value)    // value = http://[ipv6]:port 或云服务器 /pc-direct；HTTP 直连
    case 'http': return new HttpTransport(value)
    case 'mock': return new MockTransport()
  }
}

export function App() {
  const [identity, setIdentity] = useState<PhoneIdentity | null>(null)
  const [transport, setTransport] = useState<Transport | null>(null)
  const [view, setView] = useState<View>('pairing')

    // ── MD-002（2026-10-21 双界面原则）：window.__mycoUi —— agent/CLI 的 UI 感知+执行面 ──
    // App 层持有 view/setView；FriendsPanel 挂载时把 convRows/setChat/chat 注册进 _impl。
    // EnvServer POST /api/cli {cmd:"ui state"} → MycoCli → 本桥，agent 不再依赖 adb 坐标点按。
    const viewRef = useRef(view); viewRef.current = view
    const transportRef = useRef(transport); transportRef.current = transport
    const setViewRef = useRef(setView); setViewRef.current = setView
    useEffect(() => {
        const w = window as unknown as { __mycoUi?: Record<string, unknown> }
        const api = {
            _view: null as string | null,
            _impl: null as null | {
                chat: { id: string; title: string } | null
                convRows: { id: string; title: string; isGroup: boolean; unreadN: number }[]
                setChat: (c: { id: string; title: string; isGroup: boolean } | null) => void
            },
            state(): Record<string, unknown> {
                const impl = api._impl
                const texts = Array.from(document.querySelectorAll('button, [role=button], a'))
                    .map((el) => (el.textContent || '').trim()).filter(Boolean).slice(0, 60)
                return {
                    view: api._view, transport: !!transportRef.current,
                    chatId: impl?.chat?.id ?? null, chatTitle: impl?.chat?.title ?? null,
                    convs: impl?.convRows ?? [],
                    clickables: texts,
                }
            },
            tab(name: string): string {
                if (name !== 'tasks' && name !== 'agents') return 'ERR:tab 只支持 tasks|agents'
                setViewRef.current(name as View)
                return 'OK:' + name
            },
            openConv(idOrName: string): string {
                const impl = api._impl
                if (!impl) return 'ERR:friends-panel-not-mounted'
                const q = (idOrName || '').trim().replace(/_/g, ':').toLowerCase()
                const row = impl.convRows.find((r) =>
                    r.id.toLowerCase() === q
                    || r.id.replace(/_/g, ':').toLowerCase() === q
                    || (r.title || '').toLowerCase() === q
                    || (r.title || '').includes(idOrName))
                if (!row) return 'ERR:no-conv:' + idOrName
                impl.setChat({ id: row.id, title: row.title, isGroup: row.isGroup })
                return 'OK:' + row.id
            },
            clickText(t: string): string {
                const els = Array.from(document.querySelectorAll('button, [role=button], a, div[onclick]')) as HTMLElement[]
                const el = els.find((e) => (e.textContent || '').trim().includes(t))
                if (!el) return 'ERR:no-element:' + t
                el.click()
                return 'OK:clicked:' + t
            },
        }
        w.__mycoUi = api
        return () => { if (w.__mycoUi === api) delete w.__mycoUi }
    }, [])
    useEffect(() => {
        const w = window as unknown as { __mycoUi?: { _view: string | null } }
        if (w.__mycoUi) w.__mycoUi._view = view
    }, [view])
  const [selected, setSelected] = useState<SessionInfo | null>(null)
  const [nodes, setNodes] = useState<NodeEntry[]>(() => loadNodes())
  const [activeNode, setActiveNode] = useState<NodeEntry | null>(null)
  // 恢复连接进行中(有缓存节点时)——配对页只显示"连接中…",不先亮设备行
  const [reconnecting, setReconnecting] = useState(false)

  // ── 账号格式停用：模态阻断（2026-10-09 用户实测：旧格式提醒此前只是好友页里一条
  //    淡红色块、且"页底危险区"描述与实际位置不符——用户找不到。现：任何视图都覆盖
  //    全屏模态，只有两个出口（重新注册 / 先导出恢复码）。不再说"旧格式/无效格式"，
    //    只说结果与出路；用户手动改了也防得住（模态不可关闭）。）──
  const [legacyFmt, setLegacyFmt] = useState(false)
  const [regOpen, setRegOpen] = useState(false)
  const [regName, setRegName] = useState('')
  const [regBusy, setRegBusy] = useState(false)
  const [regErr, setRegErr] = useState<string | null>(null)

  // ── 底栏未读徽章（2026-10-09 用户要求）：好友/群新消息总数——状态此前只在 Pairing
  //    内（chatUnread），底栏（App 层）拿不到。现提升到 App 层：5s 轮询 unreadTotal()
  //    （chat-store 单一源，免打扰会话不计）。 ──
  const [chatUnread, setChatUnread] = useState(0)

  // 启动加载手机身份（DID，持久）：
  //  - enc 加密模式：不自动加载（需密码解锁），identity 留 null → Pairing 显示解锁页
  //  - plain/无身份：加载或生成明文身份
  //  某些浏览器（百度/华为浏览器在 http:// 源）会在此抛错 → 记下来显示，不再静默灰屏。
  const [idErr, setIdErr] = useState<string | null>(null)
  // P2P 后台循环（60s 对账 + 20s presence + 回前台节流对账）提级到 App 根——原挂在
  // FriendsPanel（身份 Tab）里，停在任务 Tab 时整条 P2P 同步链不跑（2026-09-28）。
  // ensureP2pLoops 幂等（loopsStarted 单例闸），FriendsPanel 里的旧调用无害保留。
  useEffect(() => { void import('./p2p').then((p) => p.ensureP2pLoops()) }, [])
  // ── 2026-10-28 委任状续签轮询：启动 poll 一次 + 每 60min 刷新 ──
  // 根因：手机端只在「探索有灵」时才 pollDelegation → PC 已续签但手机未拉 →
  // 过期 → exploreAutologinUrl 降级裸链接 → 用户看到未登录页面。
  useEffect(() => {
    const poll = async () => { try { await import('./delegation').then((d) => d.pollDelegation()) } catch { /* 网络/壳问题静默 */ } }
    void poll()
    const id = window.setInterval(() => { void poll() }, 60 * 60 * 1000)
    return () => { window.clearInterval(id) }
  }, [])
  // ── 2026-10-28 深链接登录（DL-Auth）：浏览器 → myco://auth → 弹确认 → 签名 → 回调登录 ──
  const [deepLinkAuth, setDeepLinkAuth] = useState<{ ticket: string; callback: string } | null>(null)
  const [deepLinkBusy, setDeepLinkBusy] = useState(false)
  const [deepLinkErr, setDeepLinkErr] = useState<string | null>(null)
  useEffect(() => {
    void import('./deep-link').then(({ initDeepLinkListener }) => {
      initDeepLinkListener((req) => { setDeepLinkAuth(req); setDeepLinkErr(null) })
    }).catch(() => {})
  }, [])
  // ── 2026-10-29 PULL 模式：JS 每 2 秒轮询 Java Bridge 拉深链接（evaluateJavascript 推送不可靠）──
  useEffect(() => {
    const poll = () => {
      try {
        const bridge = (window as unknown as { MycoDeepLinkBridge?: { getPendingDeepLink(): string | null; clearPendingDeepLink(): void } }).MycoDeepLinkBridge
        if (!bridge?.getPendingDeepLink) return
        const url = bridge.getPendingDeepLink()
        if (url && url.startsWith('myco://auth')) {
          bridge.clearPendingDeepLink()
          void import('./deep-link').then(({ parseAuthDeepLink, isCallbackAllowed }) => {
            const parsed = parseAuthDeepLink(url)
            if (parsed && isCallbackAllowed(parsed.callback)) {
              setDeepLinkAuth(parsed); setDeepLinkErr(null)
            }
          }).catch(() => {})
        }
      } catch { /* 桥不可用（浏览器/测试环境）静默 */ }
    }
    poll() // 立即查一次
    const id = window.setInterval(poll, 2000)
    return () => { window.clearInterval(id) }
  }, [])
  const confirmDeepLink = useCallback(async () => {
    if (!deepLinkAuth || deepLinkBusy) return
    setDeepLinkBusy(true); setDeepLinkErr(null)
    try {
      const { confirmDeepLinkAuth, openAuthCallback } = await import('./deep-link')
      const { signAutologinTicket } = await import('./explore')
      const r = await confirmDeepLinkAuth(deepLinkAuth.ticket, deepLinkAuth.callback, signAutologinTicket)
      if (r.ok && r.url) { openAuthCallback(r.url); setDeepLinkAuth(null) }
      else setDeepLinkErr(r.error || '签名失败')
    } catch (e) { setDeepLinkErr(String(e).slice(0, 80)) }
    setDeepLinkBusy(false)
  }, [deepLinkAuth, deepLinkBusy])
  // 设备群（2026-10-07 设计 §3 决策 B.3/F）：账号就绪即本地幂等建群 + 首见置顶种子
  // ——不依赖 FriendsPanel 挂载（停在任务 Tab 时设备群也要就位，对账面才能带上它）。
  // ensure/seed 均幂等；未登录（无账号 did）内部 no-op。
  useEffect(() => {
    if (!identity) return
    void import('./chat-store').then((c) => { c.ensureDeviceGroup(); c.seedDeviceGroupPin() }).catch(() => {})
  }, [identity])
  // 名册自愈（C1，2026-10-07 与 PC account_status 顺带自愈对齐）：账号就绪即查一次
  // 服务端名册——清档后 404 自动 /root/create 重建（低频：启动/解锁级，不轮询；
  // in-flight 防重入）。旧格式收 400 unsupported_did_format → 本地 sticky 标记，
  // FriendsPanel 引导条显形（加好友/搜索已 403 半瘫的处理引导）。切号级触发在
  // FriendsPanel（myDid 变化即重查）——本 effect 只管启动/解锁两个时点。
  useEffect(() => {
    if (!identity) return
    void ensureRootRoster().catch(() => {})
  }, [identity])

  // ── 账号格式停用：轮询 sticky 标记（2s，轻量）——检出即模态阻断 ──
  useEffect(() => {
    if (!identity) { setLegacyFmt(false); return }
    const check = () => setLegacyFmt(accountFormatLegacy())
    check()
    const t = setInterval(check, 2000)
    return () => clearInterval(t)
  }, [identity])

  // ── 底栏未读徽章：5s 轮询 unreadTotal()（chat-store 单一源）──
  useEffect(() => {
    if (!identity) { setChatUnread(0); return }
    let stop = false
    const tick = () => { void import('./chat-store').then((cs) => { if (!stop) setChatUnread(cs.unreadTotal()) }).catch(() => {}) }
    tick()
    const t = setInterval(tick, 5000)
    return () => { stop = true; clearInterval(t) }
  }, [identity])
  // 批四：新消息通知调度（App 根单例——APK 壳系统通知 / PWA 标题闪烁降级；
  // 免打扰与"正在聊"静默判定在 chat-notify 内）。
  useEffect(() => { void import('./chat-notify').then((n) => n.ensureChatNotify()) }, [])
  useEffect(() => {
    if (getStorageMode() === 'enc') return // 锁着，等 Pairing 解锁后 setIdentity
    ensurePlainIdentity().then(setIdentity).catch((e) => setIdErr(String(e).replace(/^Error:\s*/, '')))
    // 收编反查（2026-09-20 双账号验证排障）：fetchMyRoot 原只在"连接主设备成功后"调，
    // 未连接时被收编的凭证永不落盘（attestation 单槽被账号自签占据、accounts 无分身条目）——
    // 收编发现与连接无关，启动即查（svc 单条往返，静默失败）。
    void fetchMyRoot().then(() => setIdentity(currentIdentity())).catch(() => {})
  }, [])

  // 委任状自动续签(有灵账号模型 §5):开机+每 6h 查;剩余<20%/<24h → 投收件箱并轮询取件。
  // 正常全程静默;本体长期离线致过期也只是等(下轮继续试),不弹窗。
  useEffect(() => {
    if (!identity) return
    const tick = () => {
      void import('./delegation').then(async (dl) => {
        const d = dl.loadDelegation()
        if (!d || !dl.isDueRenew(d)) return
        await dl.requestRenewal()
        // 本体在线则几秒内投回;不在线就等下轮再取
        setTimeout(() => void dl.pollDelegation(), 5000)
      }).catch(() => {})
    }
    tick()
    const t = setInterval(tick, 6 * 3600 * 1000)
    return () => clearInterval(t)
  }, [identity])

  // 身份就绪后恢复上次连接(2026-09-04 设计定稿:连上直接任务树,不再先经设备页)。
  // 有保存节点 → 配对页只显示"连接中…"(不自报设备行),连上即 setView('tasks');
  // 连不上保留缓存+4s 重试,仍失败回配对页(缓存不清——瞬断不再踢人重配)。
  useEffect(() => {
    if (!identity) return
    const mode = localStorage.getItem(LS.mode) as PairMode | null
    const value = localStorage.getItem(LS.value) ?? ''
    if (!mode) return
    let stop = false
    const attempt = async (): Promise<Transport> => {
      return mode === 'webrtc'
        ? await connectWebRtc(value, 12000)
        : await (async () => {
            const t0 = buildTransport(mode, value)
            await Promise.race([t0.list(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))])
            return t0
          })()
    }
    const adopt = (t: Transport) => {
      setTransport(t); setView('tasks'); setReconnecting(false)
      const hit = loadNodes().find((n) => n.mode === mode && n.value === value)
      if (hit) setActiveNode(hit)
    }
    ;(async () => {
      setReconnecting(true)
      try {
        const t = await attempt()
        if (!stop) adopt(t)
        return
      } catch (e) { (window as unknown as { __connErr?: string }).__connErr = String(e).slice(0, 150) }
      if (stop) return
      await new Promise((r) => setTimeout(r, 4000))
      try {
        const t = await attempt()
        if (!stop) adopt(t)
      } catch (e) {
        (window as unknown as { __connErr?: string }).__connErr = String(e).slice(0, 150)
        if (!stop) { setTransport(null); setReconnecting(false); setView('pairing') }
      }
    })()
    return () => { stop = true }
  }, [identity])

  // t=已连通实例(两阶段建连胜出方)——沿用免重建;其余模式现场构建
  const onConnect = useCallback((mode: PairMode, value: string, t?: Transport) => {
    if (!identity) return
    localStorage.setItem(LS.mode, mode)
    localStorage.setItem(LS.value, value)
    // 节点表:已存在(同 mode+value)则激活,否则新增(漫游器多节点)
    setNodes((prev) => {
      const hit = prev.find((n) => n.mode === mode && n.value === value)
      const next = hit ? prev : [...prev, { id: `n${Date.now().toString(36)}`, name: valueName(value, mode), mode, value }]
      saveNodes(next)
      const active = (hit ?? next[next.length - 1])
      setActiveNode(active)
      return next
    })
    setTransport(t ?? buildTransport(mode, value))
    setView('tasks')
    // 连接成功即反查 attestation(2026-09-03:已授权设备可能因 attest 延迟/失败
    // 仍显示"注册"——连接成功=authorized 在,反查名册补 attestation 落盘)
    void fetchMyRoot().then(() => setIdentity(currentIdentity())).catch(() => {})
    // rootDid 漂移检测(2026-09-03 TPM 时代遗留):attestation 里的 rootDid 是旧值
    // (TPM 每次启动轮换),现在 PC 是 DPAPI 固定——对不上就清 attestation 重新配对
    const conn = transport
    if (conn) {
      void (conn as WebRtcTransport).http('POST', '/api/identity_get', '{}').then(({ s: st, b }) => {
        if (st !== 200) return
        const cur = JSON.parse(b)?.data?.rootDid
        const att = getAttestation()
        if (cur && att && att.rootDid !== cur) {
          // 旧 attestation 作废——清掉回未关联,重新走配对(出示新 DID)
          clearAttestation()
          setIdentity(currentIdentity())
        }
      }).catch(() => {})
    }
  }, [identity, transport])

  // 漫游器切换节点:断开→重建 transport(连接验证沿用首次恢复的语义:连上才算)
  const onSwitchNode = useCallback((n: NodeEntry) => {
    transport?.close?.()
    setSelected(null)
    ;(async () => {
      try {
        const t: Transport = n.mode === 'webrtc'
          ? await connectWebRtc(n.value, 12000)
          : await (async () => {
              const t0 = buildTransport(n.mode, n.value)
              await Promise.race([t0.list(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))])
              return t0
            })()
        localStorage.setItem(LS.mode, n.mode)
        localStorage.setItem(LS.value, n.value)
        setActiveNode(n); setTransport(t); setView('tasks')
      } catch {
        setView('pairing') // 连不上回配对页(用户可重选节点/重配)
      }
    })()
  }, [transport])

  const onDisconnect = useCallback(() => {
    localStorage.removeItem(LS.mode)
    localStorage.removeItem(LS.value)
    transport?.close?.()   // WebRTC：关 peer、停信令轮询
    setTransport(null)
    setSelected(null)

    setView('pairing')
  }, [transport])

  const onPick = useCallback((s: SessionInfo) => {
    setSelected(s)
    setView('terminal')
  }, [])

  return (
    <div className="app">
      {idErr && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100, padding: '12px 14px', background: '#ffe9e7', color: '#b91c1c', fontSize: 12, lineHeight: 1.5, fontFamily: 'ui-monospace,monospace', whiteSpace: 'pre-wrap' }}>
          身份加载失败（此浏览器可能限制 http:// 站点的 localStorage/crypto）：<br />{idErr}
        </div>
      )}
      {/* 第83轮：任务卡到达/完成 toast（身份就绪即挂——PeerTaskToasts 内部自判） */}
      {identity && <PeerTaskToasts />}
      {view === 'pairing' && (
        /* onboarding 内容可超出一屏(二维码在底部)——套滚动容器防裁切;
           chat/tasks 仍走 .app 定高 flex(聊天区自管滚动)。 */
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {/* 有缓存节点且正在恢复 → 只显示"连接中…"占位(2026-09-04:不再先亮设备行,
              连上直接任务树;上次删除会闪烁设备维度)。失败回配对页=reconnecting=false */}
          {reconnecting ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 220, gap: 12, color: 'var(--muted)' }}>
              <span className="spinner" style={{ width: 22, height: 22 }} />
              <span style={{ fontSize: 14 }}>正在连接你的设备…</span>
            </div>
          ) : (
            <Pairing identity={identity} onConnect={onConnect} onUnlocked={() => setIdentity(currentIdentity())} />
          )}
        </div>
      )}
      {transport && view === 'tasks' && (
        <>
          <NodeRoamer
            transport={transport}
            nodes={nodes}
            activeId={activeNode?.id ?? null}
            onSwitch={onSwitchNode}
            onAddNode={() => onDisconnect()}
            onOpenSession={(s) => { setSelected(s); setView('terminal') }}
          />
          <TaskList transport={transport} onPickSession={onPick} onDisconnect={onDisconnect}
            onSettings={() => setView('pairing')} />
        </>
      )}
      {/* 智能体页（2026-10-08 S2）：连接态下的好友/群/聊天——此前只能断开连接才能到达 */}
      {/* 2026-10-21 MD-002：P2P 循环已在 App 根挂载（ensureP2pLoops），不依赖 FriendsPanel 挂载。
          transport state 只反映 pairing 手动连接——App 重启后 P2P 恢复但 transport 可能仍 null，
          导致智能体页空白（chat/presence 数据其实都在）。放宽为 view === 'agents' 即渲染。 */}
      {view === 'agents' && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {/* 2026-11-12：「ADB 调试」卡提升到主页（用户口径：任务最终收敛 DSH/RDP/ADB
              三张）。原挂点在 TaskList（transport 配对模式才渲染），独立模式下不可达
              ——真机 03:20 实测点不开。零参自包含组件，两处挂载互不影响（状态各自轮询）。 */}
          <div style={{ padding: '0 10px' }}>
            <AdbShareCard />
          </div>
          {/* 设备区（2026-10-09 与 PC 对齐——连接态智能体页此前只有 FriendsPanel，无设备区；
              PC 是智能体 tab 顶部常驻「我的智能体」卡。补同款（只读列表：本机+名册+在线）。 */}
          <DevicesSection />
          <FriendsPanel />
        </div>
      )}
      {/* 连接态常驻底栏（2026-10-08 S2）：任务 ⇄ 智能体——复刻 Pairing 内的 .tabbar
          样式（demo.css），未读徽章（2026-10-09 提升到 App 层：chatUnread 5s 轮询）。 */}
      {transport && (view === 'tasks' || view === 'agents') && (
        <div className="tabbar">
          <button className={'tabbtn' + (view === 'tasks' ? '' : ' ghost')} onClick={() => setView('tasks')}>📋 任务</button>
          <button className={'tabbtn' + (view === 'agents' ? '' : ' ghost')} onClick={() => setView('agents')} style={{ position: 'relative' }}>
            🤖 智能体
            {chatUnread > 0 && (
              <span style={{ position: 'absolute', top: -5, right: 8, minWidth: 16, height: 16, borderRadius: 8, background: '#e5534b', color: '#fff', fontSize: 10, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px', boxShadow: '0 1px 4px rgba(0,0,0,.25)' }}>
                {chatUnread > 99 ? '99+' : chatUnread}
              </span>
            )}
          </button>
        </div>
      )}
      {transport && view === 'terminal' && selected && (
        <ChatView transport={transport} session={selected} onBack={() => setView('tasks')} ownAuthor={currentYoulingName() || undefined} />
      )}

      {/* ══ 账号格式停用：模态阻断（2026-10-09）══
          用户实测：旧格式提醒此前只是好友页里一条淡红色块（不醒目、不在首页、
          且"页底危险区"描述与实际位置不符——用户找不到）。现：任何视图都覆盖全屏
          模态，只有两个出口（重新注册 / 先导出恢复码）。不再说"旧格式/无效格式"，
          只说结果与出路；模态不可关闭（手动改了也防得住）。 */}
      {legacyFmt && !regOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 20, maxWidth: 340, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,.25)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#b91c1c', marginBottom: 8 }}>⚠️ 格式无效，不支持</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.7, color: '#3b475e', marginBottom: 14 }}>
              此账号的格式已失效，加好友、被搜索等功能不可用。<br />
              <b>清除此账号</b>会删除无效号（回未关联态）；<br />
              想保留这把身份钥匙，可<b>先导出恢复码</b>。
            </div>
            <button className="btnd" style={{ width: '100%', marginBottom: 8, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 9, padding: '10px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
              onClick={async () => {
                setRegBusy(true); setRegErr(null)
                try {
                  unbindYouling()  // 删账号钥（设备钥保留——本机仍是这台设备）
                  setLegacyFmt(false)
                } catch (e) { setRegErr(String(e).replace(/^Error:\s*/, '')) }
                finally { setRegBusy(false) }
              }}
              disabled={regBusy}>
              {regBusy ? '处理中…' : '清除此账号（回未关联态）'}
            </button>
            <button className="btnd ghost" style={{ width: '100%', fontSize: 13, padding: '8px', cursor: 'pointer' }}
              onClick={() => { setLegacyFmt(false); setView('pairing') }}>
              先导出恢复码（去账号页备份）
            </button>
            <div style={{ fontSize: 11, color: '#6b7bff', marginTop: 10, lineHeight: 1.6 }}>
              清除后，你可以：<br />
              · 作为<b>成员设备</b>加入其他设备（出示识别码）<br />
              · 或重新注册新账号
            </div>
          </div>
        </div>
      )}

      {/* 重新注册确认（模态内嵌套——保留但默认不打开，用户主动点"清除"才走） */}
      {legacyFmt && regOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 20, maxWidth: 340, width: '100%' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#b91c1c', marginBottom: 8 }}>确认重新注册</div>
            <div style={{ fontSize: 12, lineHeight: 1.7, color: '#3b475e', marginBottom: 10 }}>
              将<b>删除本机账号钥</b>并创建新账号。<br />
              此操作<b>不可撤销</b>——若未备份恢复码，此账号将永久丢失。
            </div>
            <input value={regName} onChange={(e) => setRegName(e.target.value)} placeholder="给新账号起个名字"
              style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid var(--border,#d7dfeb)', fontSize: 13, boxSizing: 'border-box' as const, marginBottom: 10 }} />
            {regErr && <div style={{ fontSize: 11, color: '#dc2626', marginBottom: 8 }}>{regErr}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btnd ghost" style={{ flex: 1, fontSize: 13, padding: '8px' }} onClick={() => { setRegOpen(false); setRegErr(null) }} disabled={regBusy}>返回</button>
              <button className="btnd" style={{ flex: 2, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, padding: '9px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                disabled={regBusy || !regName.trim()}
                onClick={async () => {
                  setRegBusy(true); setRegErr(null)
                  try {
                    unbindYouling()  // 删账号钥（设备钥保留——本机仍是这台设备）
                    const did = await (await import('./identity')).createRootIdentity(regName.trim())
                    void did
                    setRegOpen(false); setLegacyFmt(false); setRegName('')
                  } catch (e) {
                    setRegErr(String(e).replace(/^Error:\s*/, ''))
                  } finally { setRegBusy(false) }
                }}>
                {regBusy ? '处理中…' : '确认删除并重新注册'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 2026-10-28 深链接登录确认弹窗（DL-Auth）── */}
      {deepLinkAuth && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div className="cardd" style={{ maxWidth: 320, width: '100%', textAlign: 'center' }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>🔐</div>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>登录确认</div>
            <div className="tinyd" style={{ marginBottom: 12 }}>
              网页 <b style={{ color: 'var(--ac,#6b7bff)' }}>
                {(() => { try { return new URL(deepLinkAuth.callback).hostname } catch { return deepLinkAuth.callback.slice(0, 30) } })()}
              </b> 请求用你的 myco 身份登录。
            </div>
            {deepLinkErr && <div className="tinyd" style={{ color: '#dc2626', marginBottom: 8 }}>{deepLinkErr}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btnd ghost" style={{ flex: 1 }} onClick={() => setDeepLinkAuth(null)}>拒绝</button>
              <button className="btnd" style={{ flex: 1 }} disabled={deepLinkBusy} onClick={() => void confirmDeepLink()}>
                {deepLinkBusy ? '签名中…' : '允许'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 节点显示名(与 NodeRoamer 内同名函数一致;App 侧 onConnect 用) */
function valueName(value: string, mode: PairMode): string {
  if (mode === 'webrtc') return `PC · ${value.slice(0, 14)}…`
  if (mode === 'direct') return value.replace(/^https?:\/\//, '').slice(0, 24)
  return mode
}

/** 设备区（2026-10-09 与 PC 对齐——连接态智能体页顶部常驻「我的设备」卡，
 *  只读列表：本机 + 名册设备 + 在线状态。与 Pairing 的 renderMyco 同构但只读（无除名）。 */
function DevicesSection() {
  const [devices, setDevices] = useState<DeviceWithStatus[]>([])
  const [myDid, setMyDid] = useState('')
  useEffect(() => {
    let stop = false
    const load = async () => {
      const id = currentIdentity()
      if (!id || stop) return
      setMyDid(id.did)
      const rootDid = getRootIdentity()
      if (rootDid) setDevices(await listDevicesWithStatus(rootDid))
    }
    void load()
    return () => { stop = true }
  }, [])
  const selfDev = devices.find((d) => didFromPubkeyB64(d.pubkeyB64) === myDid)
  const others = devices.filter((d) => !d.revoked && didFromPubkeyB64(d.pubkeyB64) !== myDid)
  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <div className="card-title">📱 我的设备</div>
      {selfDev && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border,#eef2f7)' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: selfDev.online ? '#22c55e' : '#94a3b8', flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>{selfDev.name || '本机'}</span>
          <span className="chipd gray" style={{ fontSize: 10, padding: '1px 6px' }}>本机</span>
        </div>
      )}
      {others.length === 0 && <div className="tinyd" style={{ padding: '6px 0', color: 'var(--muted)' }}>暂无其他设备——在主设备上点「添加设备」完成授权后，新设备会出现在这里</div>}
      {others.map((d) => (
        <div key={d.pubkeyB64} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border,#eef2f7)' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: d.online ? '#22c55e' : '#94a3b8', flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>{d.name || '未命名'}</span>
          {d.isEmbodiment && <span className="chipd green" style={{ fontSize: 10, padding: '1px 6px' }}>主设备</span>}
          <span className="chipd gray" style={{ fontSize: 10, padding: '1px 6px' }}>{d.online ? '在线' : '离线'}</span>
        </div>
      ))}
    </div>
  )
}
