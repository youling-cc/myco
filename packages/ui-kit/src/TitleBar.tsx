/**
 * TitleBar — 无边框窗口的自绘标题栏(全 UI agent 统一风格母版)。
 *
 * [◆ 标题 | ———拖动区——— | 应用槽位 | ⛒自由/归队 ☀/🌙 ─ ▢ ✕ ]
 *
 * - 拖动区 = data-tauri-drag-region(双击最大化由 Tauri 处理)
 * - 自由/归队:icon-only(tooltip 文案);POST canvas /api/formation/join|leave
 * - 主题:icon-only;POST /api/ui/theme(canvas 广播全队,含本窗 myco://theme 事件)
 * - 窗控:最小化/最大化/关闭(非 Tauri 环境隐藏——embed 形态无窗可控)
 * - 顶部 1px 渐变发光线 = myco 窗队品牌记号(浅/深两主题各有着色)
 *
 * 唯一源码:S2 起收编 @myco/ui-kit(packages/ui-kit),9 成员窗全部 workspace 引用,
 * 历史遗留的 9 份逐字节拷贝已删——改这里即全队生效,再无同步拷贝义务。
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { IconSun, IconMoon } from './Icons'
import { listen } from '@tauri-apps/api/event'

const CANVAS_API = 'http://127.0.0.1:3102'

const IS_TAURI = typeof window !== 'undefined'
  && (!!((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
    || !!((window as unknown as { __TAURI__?: unknown }).__TAURI__))

/** 点击标题栏即刻置焦前台(无边框窗在某些 z 序态下点击不抬升,显式 setFocus 兜底)。 */
async function focusMe() {
  if (!IS_TAURI) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  void getCurrentWindow().setFocus()
}

/** 主动/跟随两态打点:标题栏按下=主动态(Rust 侧只在此态中继拖动)。
 *  经本窗嵌入端口自打,不走 Tauri 命令(库零耦合)。 */
const dragState = (port: number, state: 'begin' | 'end') => {
  void fetch(`http://127.0.0.1:${port}/myco/drag_state`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  }).catch(() => {})
}

/** 全屏子页(聊天/群管理等)头部 drag region 复用——与 TitleBar 根节点同款按下语义:
 *  置焦前台 + 主动态打点(编队 Rust 侧只在此态中继拖动)。
 *  配套 dragRegionUp 挂 window mouseup/blur(按下可能落在窗外,松开兜底)。 */
export function dragRegionDown(port: number) {
  void focusMe()
  dragState(port, 'begin')
}

/** drag region 松开/失焦兜底打点(与 TitleBar 内部 useEffect 同构)。 */
export function dragRegionUp(port: number) {
  dragState(port, 'end')
}

async function winAction(kind: 'min' | 'max' | 'close', port?: number) {
  if (!IS_TAURI) return
  // 最大化语义分派收进成员自家 embed(无 CORS、Rust 侧点击当刻新鲜判定
  // 编队态):在队=canvas 整队阵型铺满,自由=自己最大化。曾走 JS 直打 canvas
  // +挂载时缓存的 joined 判定,stale/CORS 都会静默退回自由最大化=「点了没反应」
  if (kind === 'max') {
    if (port) {
      void fetch(`http://127.0.0.1:${port}/myco/window_state`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'maximize' }),
      }).catch(() => {})
      return
    }
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    void getCurrentWindow().toggleMaximize()
    return
  }
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const w = getCurrentWindow()
  if (kind === 'min') void w.minimize()
  else void w.close()
}

/* ── icons(12px 线条,currentColor) ─────────────────────── */
const IcFleet = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="1" y="5" width="4" height="4" rx="1" />
    <rect x="9" y="1" width="4" height="4" rx="1" />
    <rect x="9" y="9" width="4" height="4" rx="1" />
    <path d="M5 7h1.5M9 3H7.5v0M7.5 3v8M9 11H7.5" strokeLinecap="round" />
  </svg>
)
const IcFree = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="1" y="5" width="4" height="4" rx="1" />
    <path d="M9 3l3 3M12 3l-3 3M9 8l3 3M12 8l-3 3" strokeLinecap="round" />
  </svg>
)
/* IcSun/IcMoon → 孢子系 IconSun/IconMoon(Icons.tsx 单一源,2026-09-05 菌光统一) */
/* 图钉 = 自动隐藏的行业通用图标(Visual Studio/IntelliJ 工具窗钉);钉起=常驻(直),
 * 钉倒=自动隐藏(斜)。inline SVG 无字体依赖(手机 webview 生僻 emoji 豆腐块教训)。 */
const IcPin = ({ on }: { on: boolean }) => (
  // 图钉 v5.1:v5 语义(小窗↔磁条)保留;对比度修——开态用字面 accent 蓝
  // (var(--accent) 在 light 主题未定义/过淡,k3 实测图标本体仍是灰的),条加粗。
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"
    stroke={on ? 'var(--accent)' : 'currentColor'} strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round"
    style={{ transition: 'all .15s' }}>
    {on ? (
      // 收拢箭头 + 磁条(实心蓝条=窗口将缩成的形态)
      <>
        <path d="M7 1v4.4M4.7 3.6 7 5.9l2.3-2.3" stroke="#5a6fff" />
        <rect x="1.4" y="9" width="11.2" height="3.2" rx="1.6" fill="#5a6fff" stroke="none" />
      </>
    ) : (
      // 小窗(圆角矩形+标题线)
      <>
        <rect x="1.8" y="2" width="10.4" height="10" rx="1.6" />
        <path d="M1.8 5h10.4" />
      </>
    )}
  </svg>
)

const btn = (extra?: Record<string, string | number>): CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 26, height: 22, borderRadius: 6, cursor: 'pointer', flexShrink: 0,
  background: 'transparent', border: 'none', color: 'var(--tb-muted, #6b7280)',
  ...extra,
})

/** 磁条态(边缘磁贴/自动隐藏磁条):横条=窗高 ≤48px,竖条=窗宽 ≤36px。
 *  交互(2026-08-18 定稿,行业参照=Visual Studio 自动隐藏工具窗/Win11 任务栏):
 *   悬停进入 → 150ms 意图延迟后 peek(临时展开回原矩形,置顶,邻居不重排)
 *   ——条嵌在编队链中段,鼠标路过穿行频繁,0ms 会乱弹;150ms 是 VS/任务栏量级;
 *   离开窗口 → 400ms 宽限后 unpeek(收回),宽限内 re-enter 取消收回;
 *   点击条任意处 → 关自动隐藏回正常槽位(条态下摘掉 drag region,否则拖动区吞点击,
 *   只剩标题文字能点——实测)。磁贴条点击=回伴生态(tier companion)。
 *  条形态下标题栏紧凑化:横条只露标题行,竖条标题竖排。 */
function useStripPeek(port: number) {
  useEffect(() => {
    const detect = () => {
      const v = window.innerWidth <= 36
      const h = !v && window.innerHeight <= 48
      return { strip: v || h, vertical: v }
    }
    let { strip } = detect()
    let peeking = false
    let autoHidden = false
    let enterTimer: ReturnType<typeof setTimeout> | undefined
    let leaveTimer: ReturnType<typeof setTimeout> | undefined
    // peek 走 canvas 重排(邻居让位,设计定稿);本地 window_state peek 仅剩诊断用途
    const post = (state: string) => {
      if (state === 'peek' || state === 'unpeek') {
        void fetch(`${CANVAS_API}/api/formation/peek_member`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port, on: state === 'peek' }),
        }).catch(() => {})
        return
      }
      void fetch(`http://127.0.0.1:${port}/myco/window_state`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state }),
      }).catch(() => {})
    }
    const applyStripClass = (s: boolean, vertical: boolean) => {
      const el = document.documentElement
      if (!s) { delete el.dataset.strip; return }
      el.dataset.strip = vertical ? 'v' : 'h'
    }
    const setDraggable = (on: boolean) => {
      // 条态下拖条毫无意义(条 Moved 不中继,拖了也会被编队吸回),且 drag region
      // 会在 mousedown 时启动系统拖动吞掉 click——条态摘掉,离条还原。
      // 墓碑标记:摘除时留 data-was-drag,还原按墓碑找回。若按 data-tauri-drag-region
      // 找回,摘完就永远找不回——peek 一次后标题栏永久不可拖(交互探针实测抓住)。
      if (on) {
        document.querySelectorAll('[data-was-drag]').forEach((el) => {
          (el as HTMLElement).setAttribute('data-tauri-drag-region', '')
          ;(el as HTMLElement).removeAttribute('data-was-drag')
        })
      } else {
        document.querySelectorAll('[data-tauri-drag-region]').forEach((el) => {
          (el as HTMLElement).removeAttribute('data-tauri-drag-region')
          ;(el as HTMLElement).setAttribute('data-was-drag', '1')
        })
      }
    }
    const refreshKind = () => {
      // 进条时查一次编队态:区分自动隐藏条 vs 磁贴条(点击行为不同)
      // home(17895)是锚点不在 members 表,读顶层 homeAutoHide
      void fetch(`${CANVAS_API}/api/formation/state`).then((r) => r.json()).then((j) => {
        const me = (j?.data?.members ?? []).find((m: { port: number }) => m.port === port)
        autoHidden = port === 17895 ? !!j?.data?.homeAutoHide : !!me?.autoHide
      }).catch(() => {})
    }
    const onResize = () => {
      const d = detect()
      const entered = d.strip && !strip
      strip = d.strip
      applyStripClass(d.strip, d.vertical)
      setDraggable(!strip)
      // peek 重排语义:peek 期窗口展开是预期,resize 到"非条尺寸"绝不许清
      // peeking——清了本地标志却不发 unpeek,canvas 的 PEEK_VIS 永留,窗口
      // 再也回不了条态(用户实测:进出多次就不会隐藏了)。收回只由 onLeave/失焦驱动。
      if (entered) refreshKind()
    }
    const onEnter = () => {
      if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = undefined }
      if (!strip || peeking || enterTimer) return
      enterTimer = setTimeout(() => {
        enterTimer = undefined
        if (strip && !peeking) { peeking = true; post('peek') }
      }, 150)
    }
    const onLeave = () => {
      if (enterTimer) { clearTimeout(enterTimer); enterTimer = undefined }
      if (peeking) {
        if (leaveTimer) clearTimeout(leaveTimer)
        leaveTimer = setTimeout(() => { if (peeking) { peeking = false; post('unpeek') } }, 400)
        return
      }
      // 自动隐藏开着但实尺寸非条(条被手动拉大):离开即请 canvas 重排即时收条
      // (400ms 宽限防边缘擦过;实查 formation state,不靠进条时的缓存)。
      // 30s heal_drift 巡检是兜底——用户期望"鼠标离开就缩回"。
      if (leaveTimer) clearTimeout(leaveTimer)
      leaveTimer = setTimeout(() => {
        if (strip || peeking) return
        void fetch(`${CANVAS_API}/api/formation/state`).then((r) => r.json()).then((j) => {
          const me = (j?.data?.members ?? []).find((m: { port: number }) => m.port === port)
          const ah = port === 17895 ? !!j?.data?.homeAutoHide : !!me?.autoHide
          if (ah) return fetch(`${CANVAS_API}/api/formation/relayout`, { method: 'POST' })
        }).catch(() => {})
      }, 400)
    }
    const onClick = () => {
      if (!strip) return
      if (autoHidden) {
        void fetch(`${CANVAS_API}/api/formation/autohide`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port, on: false }),
        }).catch(() => {})
      } else {
        void fetch(`${CANVAS_API}/api/formation/tier`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port, tier: 'companion' }),
        }).catch(() => {})
      }
    }
    applyStripClass(strip, detect().vertical)
    if (strip) { refreshKind(); setDraggable(false) }
    // 失焦立即收回(设计定稿):peek 期点别处/切窗口,宽限都不等
    const onBlur = () => {
      if (enterTimer) { clearTimeout(enterTimer); enterTimer = undefined }
      if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = undefined }
      if (peeking) { peeking = false; post('unpeek') }
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('blur', onBlur)
    const bar = document.querySelector('.myco-titlebar')
    bar?.addEventListener('mouseenter', onEnter)
    document.documentElement.addEventListener('mouseenter', onEnter)
    document.documentElement.addEventListener('mouseleave', onLeave)
    bar?.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('blur', onBlur)
      bar?.removeEventListener('mouseenter', onEnter)
      document.documentElement.removeEventListener('mouseenter', onEnter)
      document.documentElement.removeEventListener('mouseleave', onLeave)
      bar?.removeEventListener('click', onClick)
      if (enterTimer) clearTimeout(enterTimer)
      if (leaveTimer) clearTimeout(leaveTimer)
      setDraggable(true)
      delete document.documentElement.dataset.strip
    }
  }, [port])
}

export function TitleBar({ title, port, fleet = true, ah, bare, children, nav }: { title: string; port: number; fleet?: boolean; ah?: boolean; bare?: boolean; children?: ReactNode; nav?: ReactNode }) {
  // ah 缺省跟随 fleet:home 这类锚点窗 fleet={false}(不离队)但自动隐藏仍要(ah 单开)
  // bare(第37轮 demo 整建制):home 主窗专用——隐藏 编队/账号点/主题钮(与 demo-topbar 重复)
  const ahBtn = ah ?? fleet
  useStripPeek(port)
  // 主动态生命周期:按下到松开(或失焦)——mouseup 可能落在 window 外,挂 window 级。
  useEffect(() => {
    const end = () => dragState(port, 'end')
    window.addEventListener('mouseup', end)
    window.addEventListener('blur', end)
    return () => {
      window.removeEventListener('mouseup', end)
      window.removeEventListener('blur', end)
      end()
    }
  }, [port])
  const [joined, setJoined] = useState<boolean | null>(null)
  const [following, setFollowing] = useState(false)
  const [autoHide, setAutoHide] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>(
    () => (localStorage.getItem('myco-theme') as 'light' | 'dark') || 'dark',
  )
  // 有灵账号登录态(2026-08-25:所有窗体统一展示——密钥文件本地共享,
  // 每窗天然知道登录态;不抢镜设计=账号名+小点,不是按钮)
  const [account, setAccount] = useState<{ name: string; role: string } | null>(null)

  useEffect(() => {
    const load = () => void fetch(`${CANVAS_API}/api/identity_get`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json()).then((j) => {
      const d = j?.data
      if (d?.rootDid) setAccount({ name: d.name || d.rootDid.slice(0, 8) + '…', role: d.role || 'member' })
      else setAccount(null)
    }).catch(() => {})
    load()
    const t = setInterval(load, 30_000) // 登录/登出不频繁,30s 够
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    // 初始与全队同步(锚经 canvas 读)
    fetch(`${CANVAS_API}/api/formation/state`).then((r) => r.json()).then((j) => {
      setFollowing(!!j?.data?.following)
      const me = (j?.data?.members ?? []).find((m: { port: number }) => m.port === port)
      setJoined(!!me?.joined)
      // 主题初始同步只对在队窗:自由窗保留自己的风格选择(设计定稿)
      if (me?.joined) {
        void fetch(`${CANVAS_API}/api/ui/theme`).then((r) => r.json()).then((t) => {
          if (t?.data === 'light' || t?.data === 'dark') setTheme(t.data)
        }).catch(() => {})
      }
      // home(17895)是锚点不在 members 表,旗帜读顶层 homeAutoHide
      setAutoHide(port === 17895 ? !!j?.data?.homeAutoHide : !!me?.autoHide)
    }).catch(() => setJoined(false))
    // 低频轮询兜底:autoHide 可能被外部切换(home 舰队行/脚本/API),挂载时一次
    // 读取会让图标停在旧态(exe 真窗实测:API 置 on 后 peek 态图钉仍灰直立,
    // 重启进程才正确)。4s 轮询只在 joined/autoHide 变化时重渲染,开销可忽略。
    const poll = setInterval(() => {
      fetch(`${CANVAS_API}/api/formation/state`).then((r) => r.json()).then((j) => {
        setFollowing(!!j?.data?.following)
        const me = (j?.data?.members ?? []).find((m: { port: number }) => m.port === port)
        setJoined(!!me?.joined)
        setAutoHide(port === 17895 ? !!j?.data?.homeAutoHide : !!me?.autoHide)
      }).catch(() => {})
    }, 4000)
    // 全队主题广播(本窗 Tauri 事件)
    let un: (() => void) | undefined
    if (IS_TAURI) {
      void listen<string>('myco://theme', (e) => {
        if (e.payload === 'light' || e.payload === 'dark') {
          setTheme(e.payload)
          localStorage.setItem('myco-theme', e.payload)
        }
      }).then((f) => { un = f })
    }
    return () => { clearInterval(poll); un?.() }
  }, [port])

  const toggleFleet = () => {
    // home(17895)是锚点不离队——它的编队钮=全局 FOLLOW 开关;成员=归队/自由
    if (port === 17895) {
      const next = !following
      setFollowing(next)
      void fetch(`${CANVAS_API}/api/formation/follow`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: next }),
      }).catch(() => {})
      return
    }
    const next = !(joined ?? false)
    setJoined(next)
    void fetch(`${CANVAS_API}/api/formation/${next ? 'join' : 'leave'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port }),
    }).catch(() => {})
  }
  const toggleAutoHide = () => {
    const next = !autoHide
    setAutoHide(next)
    void fetch(`${CANVAS_API}/api/formation/autohide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port, on: next }),
    }).catch(() => {})
  }
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('myco-theme', next)
    // 在队=全队同切(经 canvas 广播);自由窗只切自己(设计定稿)。
    // home(17895)是锚点不在 members 表,joined 恒 false——特判永远广播
    //(实测:home 切主题只有自己变黑白)。
    if (joined || port === 17895) {
      void fetch(`${CANVAS_API}/api/ui/theme`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      }).catch(() => {})
    }
  }

  return (
    <div data-tauri-drag-region onMouseDown={() => { void focusMe(); dragState(port, 'begin') }} className="myco-titlebar" style={{
      display: 'flex', alignItems: 'center', gap: 6, height: 30,
      padding: '0 6px 0 10px', flexShrink: 0, position: 'relative',
      // 底边线已去(窗口间距横竖统一 0——1px 线让行间比列间多)
      // borderBottom: 'none',
      background: 'var(--tb-bg, #ffffff)',
      userSelect: 'none',
    }}>
      {/* 自带 hover 样式(独立 app 不依赖外部 css)+ 磁条紧凑化(横条只露标题行/竖条标题竖排)
          + 窄窗分级退让:窗宽不足时按 主题→隐→编队 顺序藏次要按钮,窗控(─▢✕)永不藏;
          标题让位收缩(ellipsis)——曾 fixed 宽按钮+不换行标题把右侧窗控挤出可视区 */}
      <style>{`
        /* TitleBar 自带主题(2026-08-19 根修):不再依赖各 app 的 CSS 变量——
           chatwin 无变量(恒白不跟切)、graph 无变量(恒黑)、各窗字色不统一的
           共同根因。双主题在组件内闭环,所有窗一致跟随 data-theme。 */
        .myco-titlebar {
          --tb-bg: #ffffff; --tb-text: #0f172a; --tb-muted: #6b7280;
          --tb-hover: #f3f5f9; --tb-border: #e6eaf0; --tb-accent: #3b82f6;
          --tb-icon: #475569;
        }
        :root[data-theme='dark'] .myco-titlebar {
          --tb-bg: #161b22; --tb-text: #e6edf3; --tb-muted: #8b949e;
          --tb-hover: #1c2333; --tb-border: #2d333b; --tb-accent: #6b7bff;
          --tb-icon: #9aa4b2;
        }
        .myco-titlebar button:hover { background: var(--tb-hover); color: var(--tb-text); }
        .myco-titlebar button.tb-close:hover { background: #e81123; color: #fff; }
        /* 条态标题(设计定稿 2026-08-19):横条=图标+标题整体居中(藏状态 chips,
           曾左对齐+大片空白);竖条=竖排居中。字号 10px 加粗保清晰。 */
        [data-strip=h] .myco-titlebar { height: 22px !important; padding: 0 8px !important; justify-content: center !important; gap: 6px !important; }
        [data-strip=h] .myco-titlebar button { display: none !important; }
        [data-strip=h] .myco-titlebar .tb-slot { display: none !important; }
        /* flex:1 占位在条态必须让位——它吞掉全部空隙,justify-center 永远居不了中 */
        [data-strip=h] .myco-titlebar .tb-spacer,
        [data-strip=v] .myco-titlebar .tb-spacer { display: none !important; }
        [data-strip=h] .myco-titlebar .tb-title { font-size: 10px !important; }
        [data-strip=v] .myco-titlebar { height: 100% !important; padding: 8px 0 !important; flex-direction: column !important; align-items: center !important; justify-content: center !important; gap: 8px !important; border-bottom: none !important; }
        [data-strip=v] .myco-titlebar button { display: none !important; }
        [data-strip=v] .myco-titlebar .tb-slot { display: none !important; }
        [data-strip=v] .myco-titlebar .tb-title { writing-mode: vertical-rl; font-size: 10px !important; letter-spacing: 2px; text-orientation: upright; }
        [data-strip=v] .myco-titlebar .tb-glow { left: 0 !important; right: auto !important; top: 0 !important; bottom: 0 !important; width: 1px !important; height: auto !important;
          background: linear-gradient(180deg, transparent, #6b7bff 30%, #4ec9a5 70%, transparent) !important; }
        .myco-titlebar svg { flex-shrink: 0 !important; }
        /* slot 内 app 控件统一钳制(monitor 实测:srcbtn 挤成竖排两行、槽高 38 溢出栏 30) */
        .myco-titlebar .tb-slot button,
        .myco-titlebar .tb-slot select,
        .myco-titlebar .tb-slot input {
          max-height: 22px !important; flex: 0 0 auto !important; white-space: nowrap !important;
          font-size: 11px !important; padding: 0 8px !important; line-height: 1 !important;
        }
        .myco-titlebar .tb-slot { overflow: hidden; }
        /* ↑ 窄窗 flex 挤压把所有 svg 压到 2px 宽(实测 DOM:tb-ah/tb-fleet 的 svg
           width=2)——图标眯成线,用户"看不到按钮"的视觉成分之一 */
        @media (max-width: 460px) { .myco-titlebar { gap: 3px !important; padding: 0 4px 0 6px !important; } }
        @media (max-width: 340px) { .myco-titlebar .tb-theme { display: none !important; } }
        /* ↑ 460→340:200% DPI 下三列窗 380 CSS 是常态布局,460 把主题钮藏没了(用户实测) */
        /* 分级退让次序=主题→slot状态chips→编队→(图钉永不藏):窄列 330px CSS 是
           常态布局,图钉是自动隐藏唯一入口(曾 ≤380 就藏=功能整段不可达);而 app
           slot chips 不收缩会把图钉挤出右缘裁半(k3 读图实测)——控件优先级高于状态展示 */
        @media (max-width: 380px) { .myco-titlebar .tb-slot { display: none !important; } }
        /* 编队钮(管理组队)全员常驻——设计定稿:大家都有 */
      `}</style>
      {/* 品牌发光线 */}
      <div className="tb-glow" style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 1,
        background: 'linear-gradient(90deg, transparent, #6b7bff 30%, #4ec9a5 70%, transparent)',
        opacity: 0.8,
      }} />
      {/* 第47轮：bare 也保留 logo+title（窗口栏就是品牌位——demo-topbar 不再重复） */}
      <span style={{
        width: 9, height: 9, borderRadius: 3, flexShrink: 0,
        background: 'linear-gradient(135deg, #6b7bff, #4ec9a5)',
      }} />
      <span className="tb-title" style={{ fontSize: 11, fontWeight: 600, color: 'var(--tb-text, #0f172a)', whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1 }}>{title}</span>
      {/* 左导航槽(标题旁,2026-08-27):应用级主导航(如工作区四视图)——左=导航
          右=窗控的桌面惯例;不受 tb-slot 窄窗隐藏规则影响(导航不可裁,标题让位)。 */}
      {nav && <span className="tb-nav" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0, marginLeft: 6 }}>{nav}</span>}
      <span data-tauri-drag-region className="tb-spacer" style={{ flex: 1, alignSelf: 'stretch', minWidth: 4 }} />
      <span className="tb-slot" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, overflow: 'hidden', flexShrink: 1 }}>
        {children}
      </span>
      {ahBtn && (
        <button className="tb-ah" onClick={toggleAutoHide} title={autoHide ? '钉回常驻——窗口回正常槽位,邻居归还空间' : '自动隐藏——缩成边缘磁条,鼠标移上临时展开(150ms),移走 400ms 后收回;点条=钉回'}
          style={btn({ color: autoHide ? 'var(--tb-accent, #3b82f6)' : 'var(--tb-icon, #475569)' })}>
          {!bare && <IcPin on={autoHide} />}
        </button>
      )}
      {fleet && !bare && (
        <button className="tb-fleet" onClick={toggleFleet} title={port === 17895 ? (following ? '编队——整队跟随中,点击全队自由' : '自由——全队各自独立,点击恢复编队') : (joined ? '自由——脱离编队,窗口独立(队籍保留)' : '归队——加入编队,贴主窗右列跟随')}
          style={btn({ color: (port === 17895 ? following : joined) ? '#66bb6a' : 'var(--tb-muted, #6b7280)' })}>
          {(port === 17895 ? following : joined) ? <IcFleet /> : <IcFree />}
        </button>
      )}
      {/* 有灵账号登录态(2026-08-25:全窗统一,不抢镜——账号名+小点) */}
      {!bare && (account ? (
        <span title={`有灵账号: ${account.name} (${account.role})`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0, marginRight: 4,
            fontSize: 10, color: 'var(--tb-muted, #6b7280)', maxWidth: 80, overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'none' }}>
          {account.name}
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#3fb950', flexShrink: 0 }} />
        </span>
      ) : (
        <span title="未登录 有灵账号——在 Home 登录"
          style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, marginRight: 4 }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--tb-muted, #6b7280)', flexShrink: 0 }} />
        </span>
      ))}
      {!bare && <button className="tb-theme" onClick={toggleTheme} title={theme === 'dark' ? '切浅色主题(全窗口)' : '切深色主题(全窗口)'}
        style={btn({ color: theme === 'dark' ? '#e8c468' : 'var(--tb-muted, #6b7280)' })}>
        {theme === 'dark' ? <IconMoon size={13} /> : <IconSun size={13} />}
      </button>}
      {IS_TAURI && (
        <span style={{ display: 'inline-flex', flexShrink: 0 }}>
          <button onClick={() => {
            // 组队=整队一起最小化(与 ▢ 整队铺满对称);自由窗=自己收。
            // 恢复走召唤:点 ▢ / home 舰队行前台 / 托盘全队前排。
            if (port && following && joined) {
              void fetch(`${CANVAS_API}/api/formation/team_minimize`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ port }),
              }).catch(() => {})
            } else {
              void winAction('min')
            }
          }} title={port && following && joined ? '最小化——整队一起收;恢复点 ▢ 或 home 前台' : '最小化'} style={btn({ width: 30 })}>
            <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.3"><path d="M1 5h8" /></svg>
          </button>
          <button onClick={() => void winAction('max', port)} title={following && joined ? '最大化——整队铺满屏幕并全员置顶;再点全员可见召唤' : '最大化/还原'} style={btn({ width: 30 })}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="1.5" y="1.5" width="7" height="7" rx="1" /></svg>
          </button>
          <button onClick={() => void winAction('close')} title="关闭" style={btn({ width: 30 })} className="tb-close">
            <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.3"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" strokeLinecap="round" /></svg>
          </button>
        </span>
      )}
    </div>
  )
}
