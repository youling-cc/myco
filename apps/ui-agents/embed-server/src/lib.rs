//! ui-embed-server — UI-P Agent 协议 v1 的嵌入服务基建。
//!
//! AOP 概念定义:界面 = P(从 state 到 observation 的渲染代理)。每个 UI agent
//! exe 内嵌本服务,对外暴露三件:
//!   GET /myco/agent → manifest(发现握手):did/layer/consumes/produces/embed
//!   GET /embed      → 嵌入形态页面(env webview 组合用;?embed=1 前端切紧凑)
//!   GET /...        → 静态资产(Tauri asset_resolver 读嵌入 dist)
//!
//! 发现协议(本 v1 选型):agents.yaml 静态声明端口 + env 运行时握手探测
//! (GET /myco/agent,带 CORS 头)。生命周期:进程独立——env 死了 UI agent
//! 活着,重启后布局重新探测恢复嵌入。
//!
//! 三个 UI agent(todo/board/monitor)依赖本 crate——这是协议基建库(如 axum),
//! 不是 UI 源码共享:每个 agent 的界面实现仍完全独立。

use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use std::sync::Mutex;
use tauri::Manager;

/// 用户拖动的决定性判据:左键是否物理按着。幽灵 Moved(动画事件被事件循环
/// 延迟投递、系统搬窗、最小化/还原跳变)发生时左键必然没按——静默窗/死区/
/// 钳制都是启发式,这一条是物理事实(2026-08-16 runaway 事故根修)。
#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn GetAsyncKeyState(vkey: i32) -> i16;
}
#[cfg(target_os = "windows")]
fn left_button_down() -> bool {
    const VK_LBUTTON: i32 = 0x01;
    unsafe { (GetAsyncKeyState(VK_LBUTTON) as u32 & 0x8000) != 0 }
}
#[cfg(not(target_os = "windows"))]
fn left_button_down() -> bool { true } // 非 Windows 退回旧行为

pub struct UiAgentManifest {
    pub did: &'static str,
    pub layer: &'static str,
    pub consumes: &'static [&'static str],
    pub produces: &'static [&'static str],
    /// 空间需求档案(100% DPI 基准物理 px;env 编队按 scale 放大):
    /// (minW, idealW, maxW[-1=不限], minH)。内容型窗给足 ideal(终端 760/画布 1100),
    /// 列表型封顶 max(待办 460)——分配器注水时封顶者不再吃宽,余量喂内容型。
    pub demand: (i32, i32, i32, i32),
}

/// 编队拖动中继的 env 端点(成员自身被拖 → 整队平移)。
pub const CANVAS_API: &str = "http://127.0.0.1:3102";

/// 布局动画静默期(动画中的 Moved 不是用户拖动,不中继;毫秒墙钟)。
static ANIM_UNTIL_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 主动/跟随两态(用户 2026-08-16 定架构):标题栏 drag-region 按下=主动态,
/// 松开=跟随态。跟随态下本窗的一切 Moved 都是自己被指挥的回声——不进感知
/// 管线、不中继(时间窗/死区启发式全部退居兜底)。
static USER_DRAG: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 入队闸:只有被编队指挥过(收到过 /myco/layout)的窗口才有资格中继拖动。
/// 窗口启动期/系统摆放/DPI 跳变的 Moved 一律不算拖动——实测事故:启动噪声
/// 被中继把 env 平移到虚拟屏外 y=9390/12176。
static EVER_COMMANDED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── 假死看门狗(2026-08-17 悬案取证):runtime 外 std::thread,3s 一探自家
// /myco/agent;连续 2 次超时就把各路由 in-flight 计数/锁态落盘 %TEMP%/myco-ui-watchdog-<port>.log
static REQ_IN: [std::sync::atomic::AtomicU64; 4] = [
    std::sync::atomic::AtomicU64::new(0), std::sync::atomic::AtomicU64::new(0),
    std::sync::atomic::AtomicU64::new(0), std::sync::atomic::AtomicU64::new(0),
];
static REQ_OUT: [std::sync::atomic::AtomicU64; 4] = [
    std::sync::atomic::AtomicU64::new(0), std::sync::atomic::AtomicU64::new(0),
    std::sync::atomic::AtomicU64::new(0), std::sync::atomic::AtomicU64::new(0),
];
/// window_state 步进探针(悬案定位):0xFFFF=处理完成
static WS_STEP: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
/// 本窗端口(window_state 的 maximize 分派要用;spawn_with_hwnd 时落)
static SELF_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();

/// 落位命令代际戳:restore 臂回放座位前的防撞闸——回放动画(240ms)期间有新
/// layout 进门则放弃回放:旧座位是 stale 的,会盖掉新坐标(实测 team_maximize 时
/// board 落位正确后 250ms 内被回放弹回旧位,整队永远铺不满的根因)。
static LAYOUT_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 成员侧文件日志:WMI 拉起的 exe stdout 全丢,编队竞态/假死排查零取证——
/// 每条关键事件落 %TEMP%/myco-embed-<port>.log(>512KB 重建,UTC 时间戳与 env.log 一致)。
fn trc(msg: &str) {
    let port = SELF_PORT.get().copied().unwrap_or(0);
    let p = std::env::temp_dir().join(format!("myco-embed-{port}.log"));
    if std::fs::metadata(&p).map(|m| m.len() > 512 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&p);
    }
    let ts = chrono::Utc::now().format("[%Y-%m-%d][%H:%M:%S%.3f]");
    let line = format!("{ts} {msg}\n");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        use std::io::Write;
        let _ = f.write_all(line.as_bytes());
    }
}

fn route_idx(path: &str) -> usize {
    match path {
        "/myco/agent" => 0,
        "/myco/window_state" => 1,
        "/myco/layout" => 2,
        _ => 3,
    }
}

async fn count_mw(
    req: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let i = route_idx(req.uri().path());
    REQ_IN[i].fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let resp = next.run(req).await;
    REQ_OUT[i].fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    resp
}

/// CORS 预检短路:exe 形态 webview origin 是 http://tauri.localhost,跨源 POST
/// (Content-Type: application/json)浏览器先发 OPTIONS;此前路由表只注册 post,
/// 预检 405 → fetch 被浏览器拦截 → .catch 静默吞——hover peek、drag_state 打点、
/// 标题栏「整队最大化」分派在 exe 形态全部哑火(2026-08-18 hover 不显现根修;
/// 浏览器/embed 形态同源不受此限,所以 e2e 与脚本从来抓不到)。
async fn cors_preflight_mw(
    req: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    if req.method() == axum::http::Method::OPTIONS {
        return ([
            (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
            (header::ACCESS_CONTROL_ALLOW_METHODS, "GET,POST,OPTIONS"),
            (header::ACCESS_CONTROL_ALLOW_HEADERS, "content-type"),
            // Chrome Private Network Access:https 页面访问 127.0.0.1 必带此头否则拦
            (header::HeaderName::from_static("access-control-allow-private-network"), "true"),
        ])
            .into_response();
    }
    next.run(req).await
}

fn spawn_watchdog(port: u16) {
    use std::io::{Read, Write};
    std::thread::spawn(move || {
        let mut fails = 0u32;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let ok = (|| -> bool {
                let addr: std::net::SocketAddr = ([127, 0, 0, 1], port).into();
                let s = match std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(1)) {
                    Ok(s) => s,
                    Err(_) => return false,
                };
                let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(2)));
                let _ = s.set_write_timeout(Some(std::time::Duration::from_secs(1)));
                let mut s = s;
                if s.write_all(b"GET /myco/agent HTTP/1.0\r\nHost: x\r\n\r\n").is_err() { return false }
                let mut buf = [0u8; 128];
                matches!(s.read(&mut buf), Ok(n) if n > 0)
            })();
            if ok { fails = 0; continue; }
            fails += 1;
            if fails < 2 { continue; }
            let names = ["agent", "window_state", "layout", "other"];
            let mut line = format!("[{}] WEDGE port={} fails={}", chrono::Utc::now().to_rfc3339(), port, fails);
            for (i, n) in names.iter().enumerate() {
                let inflight = REQ_IN[i].load(std::sync::atomic::Ordering::Relaxed)
                    .saturating_sub(REQ_OUT[i].load(std::sync::atomic::Ordering::Relaxed));
                line.push_str(&format!(" {}(in={} out={} fly={})",
                    n,
                    REQ_IN[i].load(std::sync::atomic::Ordering::Relaxed),
                    REQ_OUT[i].load(std::sync::atomic::Ordering::Relaxed),
                    inflight));
            }
            line.push_str(&format!(" strip={} follow_set={} ws_step={:#x}
", is_strip(), FOLLOW.lock().map(|g| g.is_some()).unwrap_or(false), WS_STEP.load(std::sync::atomic::Ordering::Relaxed)));
            let f = std::env::temp_dir().join(format!("myco-ui-watchdog-{port}.log"));
            if let Ok(mut fp) = std::fs::OpenOptions::new().create(true).append(true).open(f) {
                let _ = fp.write_all(line.as_bytes());
                let _ = fp.flush();
            }
        }
    });
}

/// 启动嵌入服务(独立 tokio 任务;端口占用不致命——降级仅窗口形态)。
pub fn spawn(app: tauri::AppHandle, port: u16, manifest: UiAgentManifest) {
    spawn_with_hwnd(app, 0, port, manifest)
}

/// panic 取证钩子(env 2026-08-14 闪退悬案同款):GUI 子进程 panic 默认只写
/// stderr=彻底丢失。成员窗全员装钩子,panic 追加到 %TEMP%/myco-ui-panic-<port>.log。
/// (2026-08-17 todo/dock HTTP 假死悬案:axum accept 停接但进程响应正常,
/// 疑似 serve 循环 panic——没有这份日志就永远靠猜。)
fn install_panic_hook(port: u16) {
    std::panic::set_hook(Box::new(move |info| {
        let loc = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_else(|| "?".into());
        let msg = info.payload().downcast_ref::<&str>().map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned()).unwrap_or_else(|| "?".into());
        let line = format!("[{}] PANIC port={} loc={} msg={}
",
            chrono::Utc::now().to_rfc3339(), port, loc, msg);
        let f = std::env::temp_dir().join(format!("myco-ui-panic-{port}.log"));
        use std::io::Write;
        if let Ok(mut fp) = std::fs::OpenOptions::new().create(true).append(true).open(f) {
            let _ = fp.write_all(line.as_bytes());
            let _ = fp.flush();
        }
        eprint!("{line}");
    }));
}

/// 带主窗原生句柄启动(几何走裸 Win32,绕 tao 的 DPI 逻辑换算;hwnd=0 退 tao)。
pub fn spawn_with_hwnd(app: tauri::AppHandle, hwnd: isize, port: u16, manifest: UiAgentManifest) {
    install_panic_hook(port);
    spawn_watchdog(port);
    let _ = SELF_PORT.set(port);

    #[cfg(target_os = "windows")]
    {
        if hwnd != 0 {
            hwnd_set(hwnd);
        }
        // 惰性解析:hwnd=0(home 等老调用方)时等 main 窗出现后自取原生句柄——
        // 否则 layout/restore/manifest.rect 全部落空(窗永远不动且不上报矩形)。
        let app_h = app.clone();
        std::thread::spawn(move || {
            for _ in 0..100 {
                if hwnd_get().is_some() { break }
                if let Some(w) = app_h.get_webview_window("main") {
                    if let Ok(h) = w.hwnd() {
                        hwnd_set(h.0 as isize);
                        break;
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
            // 全客户区化(横向缝根修):吞掉 WS_THICKFRAME 的隐形非客户边
            if let Some(h) = hwnd_get() {
                install_full_client(h);
                set_round_corners(h);
                trc(&format!("full_client installed hwnd={h}"));
            }
            // 注册到 env MEMBER_HWNDS(最小变动 z 判定/原子定位 seam):端点
            // 早就在但一直无人调用——需 raise=None 退回全员重刷的根因。
            if let Some(h) = hwnd_get() {
                // env 可能还没就绪(fleet 启动序里 HTTP ready 晚于成员拉起),
                // 一次性 POST 会静默丢 → 最小变动 z 判定退回 None 全员重刷。
                for _ in 0..5 {
                    match ureq::post("http://127.0.0.1:3102/api/formation/register")
                        .timeout(std::time::Duration::from_secs(2))
                        .send_json(ureq::json!({ "port": port, "hwnd": h }))
                    {
                        Ok(_) => { trc(&format!("hwnd registered to env: {h}")); break; }
                        Err(_) => std::thread::sleep(std::time::Duration::from_secs(3)),
                    }
                }
                // 拉起自前台(用户点开=要看它):新进程由后台拉起没有前台权,
                // 直接 SetForegroundWindow 被前台锁拒=任务栏闪红;AttachThreadInput
                // 借道+SwitchToThisWindow 兜底(env 曾用外部 PowerShell 抢
                // 前台,闪红且无效,已删)。
                raw_force_foreground();
            }
        });
    }
    // 单跟随线程(8ms 节拍,直跟+缓动双模式;见 FOLLOW 注释)
    spawn_follower(app.clone());
    // 编队拖动中继:本窗 Moved(非动画期)→ 平移量上报 env → 整队跟随。
    install_fleet_drag(app.clone(), port);
    let m = manifest;
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => { eprintln!("[ui-embed] runtime 失败: {e}"); return; }
        };
        rt.block_on(async move {
            let app_m = app.clone();
            let (m_did, m_layer, m_cons, m_prod, m_dem) = (m.did, m.layer, m.consumes, m.produces, m.demand);
            let manifest_json = move || async move {
                // 动态字段:minimized/maximized/rect 供 env 编队召唤判定
                // (最小化或最大化都要先 restore——SetWindowPos 对最大化窗无效;
                // 防全员 restore 的 set_focus 抢焦战)
                let (minimized, maximized, rect) = current_win_state();
                let rect_json = match rect {
                    Some((x, y, w, h)) => serde_json::json!({"x": x, "y": y, "w": w, "h": h}),
                    None => serde_json::Value::Null,
                };
                let v = serde_json::json!({
                    "did": m_did, "layer": m_layer,
                    "consumes": m_cons, "produces": m_prod,
                    "embed": "/embed", "version": 1,
                    "minimized": minimized, "maximized": maximized, "rect": rect_json,
                    "demand": { "minW": m_dem.0, "idealW": m_dem.1, "maxW": m_dem.2, "minH": m_dem.3 },
                    "strip": is_strip(),
                });
                // 发现握手要被 env 前端跨源 fetch → CORS 放行
                ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")], axum::Json(v))
            };
            let app_h = app.clone();
            let app_e = app.clone();
            let app_a = app.clone();
            let app_t = app.clone();
            let router = Router::new()
                .route("/myco/layout", post(handle_layout).with_state(app_h.clone()))
                .route("/myco/theme", post(handle_theme).with_state(app_t.clone()))
                .route("/myco/drag_state", post(handle_drag_state))
                .route("/myco/window_state", post(handle_window_state).with_state(app_t.clone()))
                .route("/myco/agent", get(move || manifest_json()))
                // 第49轮：网页直连本机登录器（确认次数 2→1）——网页 POST ticket，
                // embed 立即 emit 弹确认窗(复用 YoulingAuth 流程),网页轮询 ticket 状态收尾。
                .route("/auth/request", post(handle_auth_request).with_state(app.clone()))
                .route("/auth/ping", get(|| async { ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")], axum::Json(serde_json::json!({"ok": true, "svc": "myco-embed"}))) }))
                .route("/embed", get(move || serve_asset(app_e.clone(), Some("index.html"))))
                .route("/", get(move || serve_asset(app_m.clone(), Some("index.html"))))
                .layer(axum::middleware::from_fn(count_mw))
                .layer(axum::middleware::from_fn(cors_preflight_mw))
                .fallback(move |req: axum::http::Request<axum::body::Body>| {
                    let path = req.uri().path().trim_start_matches('/').to_string();
                    async move { serve_asset(app_a.clone(), Some(&path)).await }
                });
            match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                Ok(ln) => {
                    println!("[ui-embed] {} 嵌入服务 :{port}(发现 GET /myco/agent,嵌入 GET /embed)", m.did);
                    let _ = axum::serve(ln, router).await;
                }
                Err(e) => eprintln!("[ui-embed] :{port} 绑定失败(降级为仅窗口形态): {e}"),
            }
        });
    });
}

/// 从 Tauri 嵌入资产读文件返回(带基础 MIME)。
async fn serve_asset(app: tauri::AppHandle, path: Option<&str>) -> Response {
    let Some(name) = path.filter(|p| !p.is_empty()) else {
        return (StatusCode::NOT_FOUND, "missing").into_response();
    };
    // 防目录穿越:剥 query、拒 ..
    let clean = name.split('?').next().unwrap_or("");
    if clean.contains("..") {
        return (StatusCode::FORBIDDEN, "..").into_response();
    }
    let asset = app.asset_resolver().get(clean.to_string());
    match asset {
        Some(a) => {
            let bytes = a.bytes().to_vec();
            let mime = match clean.rsplit('.').next().unwrap_or("") {
                "html" => "text/html; charset=utf-8",
                "js" => "text/javascript",
                "css" => "text/css",
                "svg" => "image/svg+xml",
                "png" => "image/png",
                "json" => "application/json",
                _ => "application/octet-stream",
            };
            ([(header::CONTENT_TYPE, mime)], bytes).into_response()
        }
        None => {
            // SPA 兜底:未知路径回 index(前端路由)
            match app.asset_resolver().get("index.html".to_string()) {
                Some(a) => Html(String::from_utf8_lossy(&a.bytes()).to_string()).into_response(),
                None => (StatusCode::NOT_FOUND, "asset").into_response(),
            }
        }
    }
}

// ── 阵型协议:POST /myco/layout(指挥端算目标+共享时长,各窗口本地插值) ──

use serde::Deserialize;

#[derive(Deserialize, Clone, Copy)]
pub struct LayoutTarget {
    pub x: i32, pub y: i32, pub w: i32, pub h: i32,
}

fn ease_out_cubic(t: f64) -> f64 { 1.0 - (1.0 - t).powi(3) }

/// 窗口在 duration_ms 内插值移动到目标(easeOutCubic,16ms 节拍)。
/// 指挥端并发下发+时长一致 → 视觉同步(预测式锁步:无需每帧 IPC)。
/// 动画期写 ANIM_UNTIL_MS 静默窗——这些 Moved 是我们自己的 set_position,
/// 不触发编队拖动中继(否则用户拖 A → 队列回 A → A 再上报 → 死循环)。
/// 单跟随线程的目标槽(durationMs<=80=拖动直跟[零插值零滞后];>80=缓动动画)。
/// 取代"每命令一线程"模型:30Hz 洪泛下旧法每秒生成 30 个线程+定时器,是
/// 卡顿与调度抖动的主源。
struct FollowTarget {
    t: LayoutTarget,
    /// 0=直跟;>0=缓动剩余毫秒
    anim_ms: u64,
    /// 缓动模式的起始矩形(收令时采样)
    start: Option<LayoutTarget>,
    deadline: u64,
}
static FOLLOW: Mutex<Option<FollowTarget>> = Mutex::new(None);

static LAST_TARGET: Mutex<Option<LayoutTarget>> = Mutex::new(None);

/// 整队最大化防抖(最大化会连发 Resized,800ms 内只接管一次)。
static LAST_TEAM_MAX_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 手动 resize 投票的 settle 计时(拖边框连发 Resized,停 350ms 才算一次投票)。
static RESIZE_SETTLE: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// 主窗原生句柄(成员 app 启动时传入;几何操作绕开 tao 的 DPI 逻辑换算——
/// 会话 scale≠系统 DPI 时 tauri set_position 会把物理坐标当逻辑坐标缩放,
/// 实测 200% 会话下目标减半。Win32 SetWindowPos 是纯物理像素,确定语义)。
/// 原子句柄(2026-08-17 假死悬案根修①):句柄只是 isize,Mutex 纯属给阻塞创造
/// 温床——持锁跨 SetWindowPos(同步 SendMessage 语义)时,窗线程模态卡死=全 worker 陪葬。
static HWND: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

fn hwnd_get() -> Option<isize> {
    match HWND.load(std::sync::atomic::Ordering::Relaxed) { 0 => None, h => Some(h) }
}

fn hwnd_set(h: isize) {
    HWND.store(h, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn SetWindowPos(h: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    fn GetWindowRect(h: isize, r: *mut WinRect) -> i32;
    fn IsIconic(h: isize) -> i32;
    fn IsZoomed(h: isize) -> i32;
}
#[cfg(target_os = "windows")]
#[repr(C)]
struct WinRect { l: i32, t: i32, r: i32, b: i32 }

#[cfg(target_os = "windows")]
fn raw_rect() -> Option<(i32, i32, i32, i32)> {
    let h = hwnd_get()?;
    let mut r = WinRect { l: 0, t: 0, r: 0, b: 0 };
    if unsafe { GetWindowRect(h, &mut r) } == 0 { return None }
    Some((r.l, r.t, r.r - r.l, r.b - r.t))
}

#[cfg(target_os = "windows")]
fn raw_minimized() -> bool {
    match hwnd_get() { Some(h) => unsafe { IsIconic(h) != 0 }, None => false }
}

#[cfg(target_os = "windows")]
fn raw_maximized() -> bool {
    match hwnd_get() { Some(h) => unsafe { IsZoomed(h) != 0 }, None => false }
}

// ── not(windows) 后备（A19 feat/linux-gui：linux GUI 变体首编补全）──────────
// 语义：窗态只读项给"无信息"（None/false）——调用方退化路径与下方
// current_win_state 的既有 not-windows 分支一致。linux 上窗口布局由
// apply_target 的 tauri set_position/set_size 分支承载；直调 win32 的
// 路径（磁贴记忆/直落位/整队最大化）自然降级，渲染与登录器主流程不受影响。
#[cfg(not(target_os = "windows"))]
fn raw_rect() -> Option<(i32, i32, i32, i32)> { None }

#[cfg(not(target_os = "windows"))]
fn raw_minimized() -> bool { false }

#[cfg(not(target_os = "windows"))]
fn raw_maximized() -> bool { false }

/// (minimized, maximized, rect) 当前窗态快照(manifest 动态字段)。
#[cfg(target_os = "windows")]
fn current_win_state() -> (bool, bool, Option<(i32, i32, i32, i32)>) {
    (raw_minimized(), raw_maximized(), raw_rect())
}

#[cfg(not(target_os = "windows"))]
fn current_win_state() -> (bool, bool, Option<(i32, i32, i32, i32)>) {
    (false, false, None)
}

/// 抬 z 序但不激活(restore focus:false 的召唤:窗回台前,不抢用户焦点)。
#[cfg(target_os = "windows")]
fn raw_raise_noactivate() {
    if let Some(hd) = hwnd_get() {
        const SWP_NOMOVE: u32 = 0x0002;
        const SWP_NOSIZE: u32 = 0x0001;
        const SWP_NOACTIVATE: u32 = 0x0010;
        const SWP_ASYNCWINDOWPOS: u32 = 0x4000;
        const HWND_TOPMOST: isize = -1;
        const HWND_NOTOPMOST: isize = -2;
        // 置顶再收回两连:终态=非置顶但高于【所有非置顶窗(含前台窗)】。对自家窗
        // 改置顶属性不需要前台权——AttachThreadInput 借道+HWND_TOP 的组合实测
        // 失效(ASYNC 把 z 变更推迟到窗口自身线程执行,借道已断,前台上限重新
        // 生效:raise ret=1 borrowed=true 仍整体压在前台窗后,用户实测看不见)。
        // 两条 ASYNC 同窗按序执行,不阻塞 HTTP worker。
        let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;
        unsafe {
            SetWindowPos(hd, HWND_TOPMOST, 0, 0, 0, 0, flags);
            SetWindowPos(hd, HWND_NOTOPMOST, 0, 0, 0, 0, flags);
        }
        trc(&format!("raise_noactivate hwnd={hd} topmost-dance"));
    } else {
        trc("raise_noactivate: no hwnd");
    }
}

#[cfg(not(target_os = "windows"))]
fn raw_raise_noactivate() {}

#[cfg(target_os = "windows")]
fn raw_apply(x: i32, y: i32, w: i32, h: i32) {
    if let Some(hd) = hwnd_get() {
        const SWP_NOZORDER: u32 = 0x0004;
        const SWP_NOACTIVATE: u32 = 0x0010;
        const SWP_ASYNCWINDOWPOS: u32 = 0x4000;
        // 全 PMv2:物理坐标直接透传。SWP_ASYNCWINDOWPOS=投递而非同步 SendMessage——
        // 窗线程模态卡死(遗留 mouseup 的拖动内循环)时调用者零阻塞(假死悬案根修②)。
        unsafe { SetWindowPos(hd, 0, x, y, w.max(1), h.max(1), SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS) };
    }
}

#[cfg(not(target_os = "windows"))]
fn raw_apply(_x: i32, _y: i32, _w: i32, _h: i32) {}

/// 矩形退化判定(最小化停泊/隐形态):宽<120 或 高<80 或 远负坐标。
fn degenerate(t: &LayoutTarget) -> bool {
    t.w < 120 || t.h < 80 || t.x < -2000 || t.y < -2000
}

/// 上次应用的尺寸(去重:拖动跟随时只有 x,y 变——set_size 即便同值也触发
/// WebView2 全窗重排/重绘,是拖动期 CPU 爆表(实测 10.7 核)的主因;
/// move-only 走系统位块搬运,近零成本)。
static LAST_SIZE: Mutex<Option<(i32, i32)>> = Mutex::new(None);

fn apply_target(app: &tauri::AppHandle, t: &LayoutTarget) {
    #[cfg(target_os = "windows")]
    {
        if raw_minimized() {
            *FOLLOW.lock().unwrap() = None;
            return;
        }
        let (tw, th) = (t.w.max(60), t.h.max(60));
        raw_apply(t.x, t.y, tw, th);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let Some(win) = app.get_webview_window("main") else { return };
        let _ = win.set_position(tauri::PhysicalPosition::new(t.x, t.y));
        let _ = win.set_size(tauri::PhysicalSize::new(t.w.max(60) as u32, t.h.max(60) as u32));
    }
    let _ = app;
}

/// 跟随线程:8ms 节拍读最新目标。直跟模式立即落位(拖动跟手);缓动模式
/// easeOutCubic 到 deadline 精确落位。
fn spawn_follower(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
        let now = now_ms();
        let mut g = FOLLOW.lock().unwrap();
        if let Some(f) = g.as_mut() {
            if f.anim_ms == 0 {
                let t = f.t;
                drop(g);
                apply_target(&app, &t);
                ANIM_UNTIL_MS.store(now_ms() + 120, std::sync::atomic::Ordering::Relaxed);
                *FOLLOW.lock().unwrap() = None;
                continue;
            }
            if now >= f.deadline {
                let t = f.t;
                drop(g);
                apply_target(&app, &t);
                ANIM_UNTIL_MS.store(now_ms() + 120, std::sync::atomic::Ordering::Relaxed);
                *FOLLOW.lock().unwrap() = None;
                continue;
            }
            // 缓动:按剩余时间比例插值
            let total = f.anim_ms as f64;
            let elapsed = total - (f.deadline - now) as f64;
            let tt = ease_out_cubic((elapsed / total).clamp(0.0, 1.0));
            let (cur, tgt) = (f.start.unwrap_or(f.t), f.t);
            let interp = LayoutTarget {
                x: (cur.x as f64 + (tgt.x - cur.x) as f64 * tt) as i32,
                y: (cur.y as f64 + (tgt.y - cur.y) as f64 * tt) as i32,
                w: (cur.w as f64 + (tgt.w - cur.w) as f64 * tt) as i32,
                h: (cur.h as f64 + (tgt.h - cur.h) as f64 * tt) as i32,
            };
            drop(g);
            apply_target(&app, &interp);
            std::thread::sleep(std::time::Duration::from_millis(8));
            continue;
        }
        drop(g);
        std::thread::sleep(std::time::Duration::from_millis(12));
        }
    });
}

fn animate_window(app: &tauri::AppHandle, target: LayoutTarget, duration_ms: u64) {
    let now = now_ms();
    ANIM_UNTIL_MS.store(now + duration_ms + 150, std::sync::atomic::Ordering::Relaxed);
    // 目标下限(防任何路径把窗缩没)
    let target = LayoutTarget { w: target.w.max(60), h: target.h.max(60), ..target };
    *LAST_TARGET.lock().unwrap() = Some(target);
    let start = if duration_ms > 80 {
        // 起点矩形走 raw_rect(HTTP 线程禁 tauri getter:主线程 dispatch 洪峰会堵死)
        let cand = raw_rect().map(|(x, y, w, h)| LayoutTarget { x, y, w, h });
        // 退化起点(最小化停泊矩形等)不插值——从停泊态"缓动"会把窗留在微缩中间态
        cand.filter(|c| !degenerate(c))
    } else {
        None
    };
    let _ = app;
    *FOLLOW.lock().unwrap() = Some(FollowTarget {
        t: target,
        anim_ms: if duration_ms > 80 { duration_ms } else { 0 },
        start,
        deadline: now + duration_ms,
    });
}

async fn handle_layout(
    axum::extract::State(app): axum::extract::State<tauri::AppHandle>,
    axum::Json(req): axum::Json<serde_json::Value>,
) -> impl IntoResponse {
    // 代际闸先于一切副作用:过期 layout 不许清磁条记账/改座位簿(乱序到达的
    // 旧 layout 会把刚条化的窗打回半高槽位)
    if !cmd_seq_fresh(&req) {
        return ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")], axum::Json(serde_json::json!({"ok": true, "stale": true})));
    }
    EVER_COMMANDED.store(true, std::sync::atomic::Ordering::Relaxed);
    // 代际戳:restore 臂座位回放的防撞闸(见 LAYOUT_GEN 注释)
    LAYOUT_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let target = LayoutTarget {
        x: req.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        y: req.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        w: req.get("w").and_then(|v| v.as_i64()).unwrap_or(360) as i32,
        h: req.get("h").and_then(|v| v.as_i64()).unwrap_or(480) as i32,
    };
    let dur = req.get("durationMs").and_then(|v| v.as_u64()).unwrap_or(400);
    // 正常落位 = 脱离磁条态的明确信号(恢复自动隐藏/离收起态):清磁条记账,
    // 否则 STRIP_RECT 残留会让 is_strip() 永远真、resize 投票被永久静默。
    if is_strip() {
        *STRIP_RECT.lock().unwrap() = None;
        *STRIP_PREV.lock().unwrap() = None;
        PEEKING.store(false, std::sync::atomic::Ordering::Relaxed);
    }
    // restore/raise 由 env 合并随落位下发(单请求,杜绝与 restore 回放旧座位的竞态)
    let restore = req.get("restore").and_then(|v| v.as_bool()).unwrap_or(false);
    let raise = req.get("raise").and_then(|v| v.as_bool()).unwrap_or(false);
    trc(&format!(
        "layout recv ({},{}) {}x{} dur={} restore={} raise={}",
        target.x, target.y, target.w, target.h, dur, restore, raise
    ));
    // 座位簿随指令更新(restore 臂回放/resize 投票回声守卫都以它为准)
    *LAST_TARGET.lock().unwrap() = Some(target);
    // 指令位移回声抑制:Moved 中继闸读 ANIM_UNTIL_MS,不标会把自己的落位
    // 回传 env 当用户拖动(原点被平移=整队乱跑的第二来源)
    ANIM_UNTIL_MS.store(now_ms() + dur + 150, std::sync::atomic::Ordering::Relaxed);
    // 同步直调(绕 follower 全链):tauri::async_runtime::spawn_blocking 里做
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 最小化/最大化窗 SetWindowPos 无效:先还原再落位(原 env 双请求
        // 时序合入此处,150ms 等还原生效)
        if restore && (raw_minimized() || raw_maximized()) {
            trc("layout: restore-first (minimized/maximized)");
            raw_show(9); // SW_RESTORE
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
        raw_apply(target.x, target.y, target.w.max(60), target.h.max(60));
        // 召唤语义:落位后抬 z 序不抢焦(整队亮相盖过其他应用,焦点只给锚点)
        if raise {
            raw_raise_noactivate();
        }
        let _ = &app2;
    });
    ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")], axum::Json(serde_json::json!({"ok": true, "sync": true})))
}

// ── 主动/跟随两态:POST /myco/drag_state {state:"begin"|"end"}(TitleBar 打点) ──

async fn handle_drag_state(
    axum::extract::Json(req): axum::extract::Json<serde_json::Value>,
) -> impl IntoResponse {
    let on = req.get("state").and_then(|v| v.as_str()) == Some("begin");
    USER_DRAG.store(on, std::sync::atomic::Ordering::Relaxed);
    ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")], axum::Json(serde_json::json!({"ok": true, "dragging": on})))
}

// ── 窗控协议:POST /myco/window_state {state:"minimize"|"restore"|"close"|"strip"|"peek"|"unpeek"} ──

/// 磁贴态(2026-08-16 空间重设计 D5):收起 ≠ 最小化——窗缩成屏幕右缘的标题条
/// (高度=标题栏,只露 icon+名字,零 UI 改动:36px 高窗体天然只渲染 TitleBar)。
/// STRIP_RECT=当前磁贴位;STRIP_PREV=收起前的正常矩形(peek/还原用)。
static STRIP_RECT: Mutex<Option<LayoutTarget>> = Mutex::new(None);
static STRIP_PREV: Mutex<Option<LayoutTarget>> = Mutex::new(None);
/// peek 浮现中(topmost 覆在 STRIP_PREV 矩形上)。期间 strip 落位指令只记账不应用
/// (悬停时整队重排不能把窗从鼠标下抽走);unpeek 时按最新 STRIP_RECT 收回。
static PEEKING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn is_strip() -> bool {
    STRIP_RECT.lock().unwrap().is_some()
}

/// 磁贴/peek 期间的几何不走 apply_target(它的 240x120 下限和 degenerate 判定
/// 就是为磁贴这种小矩形设的防呆——这里显式绕过,指令源可信)。
fn raw_apply_exact(t: &LayoutTarget) {
    #[cfg(target_os = "windows")]
    raw_apply(t.x, t.y, t.w.max(28), t.h.max(24));
    #[cfg(not(target_os = "windows"))]
    let _ = t;
}

/// 无闪烁前台(粉红色任务栏按钮根修):后台进程直接 SetForegroundWindow 会被
/// 前台锁拒绝 → 系统改为闪烁任务栏按钮(用户看到的"粉红特殊态")。正解=
/// AttachThreadInput 借道当前前台线程的输入队列,合法完成 SetForegroundWindow。
/// 还原最小化用 PostMessageW WM_SYSCOMMAND/SC_RESTORE(投递即返)——同步
/// ShowWindow 跨线程要窗线程应答,窗线程模态卡死时 HTTP worker 被永久挂起
/// (watchdog 实证 window_state fly=1),这是假死悬案根修③。
#[cfg(target_os = "windows")]
fn raw_force_foreground() {
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> isize;
        fn GetWindowThreadProcessId(h: isize, pid: *mut u32) -> u32;
        fn AttachThreadInput(attach: u32, attach_to: u32, yes: i32) -> i32;
        fn SetForegroundWindow(h: isize) -> i32;
        fn PostMessageW(h: isize, msg: u32, w: usize, l: isize) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThreadId() -> u32;
    }
    let Some(hd) = hwnd_get() else { return };
    const WM_SYSCOMMAND: u32 = 0x0112;
    const SC_RESTORE: usize = 0xF120;
    unsafe {
        PostMessageW(hd, WM_SYSCOMMAND, SC_RESTORE, 0);
        // 不用 BringWindowToTop:它是同步跨线程 SetWindowPos,主线程被 resize
        // 风暴(WebView2 重排洪峰)占满时会挂住 HTTP worker(watchdog 实测
        // ws_step=0x5 唯一残留卡点)。SetForegroundWindow 自身会抬 z 序。
        let fg = GetForegroundWindow();
        let fg_tid = GetWindowThreadProcessId(fg, std::ptr::null_mut());
        let my_tid = GetCurrentThreadId();
        if fg_tid != my_tid && fg_tid != 0 {
            AttachThreadInput(my_tid, fg_tid, 1);
            SetForegroundWindow(hd);
            AttachThreadInput(my_tid, fg_tid, 0);
        } else {
            SetForegroundWindow(hd);
        }
        // 前台挂在隐藏窗(env 无窗化启动时抢焦后 hide,前台权死在隐藏窗上)
        // 时 AttachThreadInput 借用也会被静默拒——SwitchToThisWindow 是 Alt-Tab
        // 语义的原生兜底。实测:fg=隐藏 env 时 SetForegroundWindow 无效。
        if GetForegroundWindow() != hd {
            #[link(name = "user32")]
            extern "system" { fn SwitchToThisWindow(h: isize, alt_tab: i32); }
            SwitchToThisWindow(hd, 1);
        }
        trc(&format!("force_foreground fg_now={}", GetForegroundWindow() == hd));
    }
}

#[cfg(not(target_os = "windows"))]
fn raw_force_foreground() {}

/// 窗控全走裸 Win32(2026-08-17 假死悬案根修):tauri 窗口 getter/方法(dispatch
/// 到主线程同步等应答)从 HTTP worker 调用,在主循环被 Moved/Resized 洪峰占满时
/// 全线阻塞 → tokio worker 池耗尽 → CLOSE_WAIT 堆积 → 监听 backlog 满 = 假死。
/// 最小化/还原用 PostMessageW WM_SYSCOMMAND(投递即返)而非 ShowWindow(同步
/// 跨线程等窗线程应答,模态卡死时永久挂起 worker——watchdog 实证 fly=1)。
#[cfg(target_os = "windows")]
/// 无边框可调窗的全客户区化(横向缝根修):tauri decorations:false+resizable 的窗
/// 仍带 WS_THICKFRAME,系统保留隐形非客户边(实测左 7px/右 8px)——webview 只画
/// 客户区,每窗左缘一条未绘制黑边,相邻窗相贴时叠加成"横向间隙比纵向宽"(用户
/// 实测截图)。标准做法:subclass 吞 WM_NCCALCSIZE(客户区=全窗)+ WM_NCHITTEST
/// 边缘 8px 自答 HTLEFT/RIGHT/...(保留拖边调宽——resize 投票链路靠它)。
#[cfg(target_os = "windows")]
pub(crate) fn install_full_client(hd: isize) {
    #[link(name = "comctl32")]
    extern "system" {
        fn SetWindowSubclass(h: isize, p: *mut core::ffi::c_void, id: usize, d: isize) -> i32;
    }
    unsafe {
        let _ = SetWindowSubclass(hd, full_client_proc as *mut _, 0x4D43, 0);
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn full_client_proc(h: isize, msg: u32, wp: usize, lp: isize, _id: usize, _d: isize) -> isize {
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct MyRect { l: i32, t: i32, r: i32, b: i32 }
    #[link(name = "user32")]
    extern "system" {
        fn DefSubclassProc(h: isize, msg: u32, wp: usize, lp: isize) -> isize;
        fn GetWindowRect(h: isize, r: *mut MyRect) -> i32;
    }
    const WM_NCCALCSIZE: u32 = 0x0083;
    const WM_NCHITTEST: u32 = 0x0084;
    const HTCLIENT: isize = 1;
    const HTLEFT: isize = 10;
    const HTRIGHT: isize = 11;
    const HTTOP: isize = 12;
    const HTTOPLEFT: isize = 13;
    const HTTOPRIGHT: isize = 14;
    const HTBOTTOM: isize = 15;
    const HTBOTTOMLEFT: isize = 16;
    const HTBOTTOMRIGHT: isize = 17;
    #[repr(C)]
    struct NcParams { rgrc: [MyRect; 3] };
    match msg {
        // wParam=TRUE 时仅 return 0 = "保留旧客户区"(实测无效);正确做法是把
        // rgrc[0](新客户区,OUT)改写为 rgrc[1](完整窗口矩形)→ 客户区铺满全窗。
        WM_NCCALCSIZE if wp != 0 => {
            trc("NCCALCSIZE: 进入 full_client_proc 重写 rgrc[0]");
            // rgrc[1] 是"移动前旧矩形"(曾错用);顶层窗的正确做法:GetWindowRect
            // 屏幕坐标直写 rgrc[0](顶层窗客户区即屏幕坐标)→ 客户区=完整窗口。
            let p = lp as *mut NcParams;
            let mut wr = MyRect { l: 0, t: 0, r: 0, b: 0 };
            if GetWindowRect(h, &mut wr as *mut MyRect) != 0 {
                unsafe { (*p).rgrc[0] = wr; }
            }
            0
        }
        WM_NCHITTEST => {
            let d = DefSubclassProc(h, msg, wp, lp);
            if d != HTCLIENT {
                return d;
            }
            let mut r = MyRect { l: 0, t: 0, r: 0, b: 0 };
            if GetWindowRect(h, &mut r) == 0 {
                return d;
            }
            let x = lp as u16 as i16 as i32;
            let y = ((lp as u32) >> 16) as u16 as i16 as i32;
            let edge = 8i32;
            let dl = x - r.l;
            let dr = r.r - 1 - x;
            let dt = y - r.t;
            let db = r.b - 1 - y;
            if dl <= edge || dr <= edge || dt <= edge || db <= edge {
                return match (dl <= edge, dt <= edge, dr <= edge, db <= edge) {
                    (true, true, _, _) => HTTOPLEFT,
                    (true, _, _, true) => HTBOTTOMLEFT,
                    (_, true, true, _) => HTTOPRIGHT,
                    (_, _, true, true) => HTBOTTOMRIGHT,
                    (true, _, _, _) => HTLEFT,
                    (_, _, true, _) => HTRIGHT,
                    (_, true, _, _) => HTTOP,
                    _ => HTBOTTOM,
                };
            }
            d
        }
        _ => DefSubclassProc(h, msg, wp, lp),
    }
}

/// DWM 小圆角(设计定稿 2026-08-19):Win11 DWMWCP_ROUND(系统 ~8px),方形直角
/// 配窗间缝显"排管风",圆角让每窗像独立卡片,与"个体呼吸感"一气呵成。
/// Win10 上该属性静默无效(无代价)。
#[cfg(target_os = "windows")]
pub(crate) fn set_round_corners(hd: isize) {
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(h: isize, attr: u32, val: *const core::ffi::c_void, size: u32) -> i32;
    }
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: u32 = 2;
    unsafe {
        let pref: u32 = DWMWCP_ROUND;
        let _ = DwmSetWindowAttribute(hd, DWMWA_WINDOW_CORNER_PREFERENCE, &pref as *const _ as *const core::ffi::c_void, 4);
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn set_round_corners(_hd: isize) {}

#[cfg(not(target_os = "windows"))]
pub(crate) fn install_full_client(_hd: isize) {}

#[cfg(target_os = "windows")]
fn raw_show(cmd: i32) {
    if let Some(hd) = hwnd_get() {
        #[link(name = "user32")]
        extern "system" { fn PostMessageW(h: isize, msg: u32, w: usize, l: isize) -> i32; }
        const WM_SYSCOMMAND: u32 = 0x0112;
        const SW_MINIMIZE: i32 = 6;
        const SC_MINIMIZE: usize = 0xF020;
        const SC_RESTORE: usize = 0xF120;
        let sc = if cmd == SW_MINIMIZE { SC_MINIMIZE } else { SC_RESTORE };
        unsafe { PostMessageW(hd, WM_SYSCOMMAND, sc, 0) };
    }
}

#[cfg(target_os = "windows")]
fn raw_close() {
    if let Some(hd) = hwnd_get() {
        #[link(name = "user32")]
        extern "system" { fn PostMessageW(h: isize, msg: u32, w: usize, l: isize) -> i32; }
        const WM_CLOSE: u32 = 0x0010;
        unsafe { PostMessageW(hd, WM_CLOSE, 0, 0) };
    }
}

#[cfg(not(target_os = "windows"))]
fn raw_show(_cmd: i32) {}
#[cfg(not(target_os = "windows"))]
fn raw_close() {}

/// 编队指令代际闸:env 下发的 layout/strip 带单调 seq;并发 HTTP 乱序时过期
/// 指令直接丢(实测:连隐同列两窗,第一轮回流的 layout 压倒第二轮的 strip,
/// 成员卡在半高槽位)。无 seq 的调用(旧 env/手调)放行。
static LAST_CMD_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn cmd_seq_fresh(req: &serde_json::Value) -> bool {
    let Some(seq) = req.get("seq").and_then(|v| v.as_u64()) else { return true };
    let prev = LAST_CMD_SEQ.load(std::sync::atomic::Ordering::SeqCst);
    if seq <= prev {
        trc(&format!("cmd seq stale: {seq} <= {prev}, dropped"));
        return false;
    }
    LAST_CMD_SEQ.store(seq, std::sync::atomic::Ordering::SeqCst);
    true
}

async fn handle_window_state(
    axum::extract::State(app): axum::extract::State<tauri::AppHandle>,
    axum::Json(req): axum::Json<serde_json::Value>,
) -> impl IntoResponse {
    // 悬案定位探针:每推进一步 +1,响应前写 0xFFFF;watchdog 见 fly=1 时读出卡死点
    WS_STEP.store(1, std::sync::atomic::Ordering::Relaxed);
    let state = req.get("state").and_then(|v| v.as_str()).unwrap_or("restore");
    // focus:false = 召唤但不抢焦(env 编队平移时恢复最小化成员用)
    let focus = req.get("focus").and_then(|v| v.as_bool()).unwrap_or(true);
    // 根窗(home)窗管路径:关窗=进程退出(成员幂等,可随时由 home/launcher 再拉起)
    // WM_CLOSE 走窗口自己的消息泵退出,不经 tauri dispatch(洪峰期防阻塞)
    if state == "close" {
        #[cfg(target_os = "windows")]
        raw_close();
        #[cfg(not(target_os = "windows"))]
        if let Some(win) = app.get_webview_window("main") { let _ = win.close(); }
        return ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")], axum::Json(serde_json::json!({"ok": true})));
    }
    // 磁贴三态(D5):strip=收成右缘标题条(位置随指令);peek=悬停临时展开
    // (topmost 浮在正常矩形上,不动布局);unpeek=缩回磁贴
    if state == "strip" {
        if !cmd_seq_fresh(&req) {
            return ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")], axum::Json(serde_json::json!({"ok": true, "strip": true, "stale": true})));
        }
        let t = LayoutTarget {
            x: req.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
            y: req.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
            w: req.get("w").and_then(|v| v.as_i64()).unwrap_or(180) as i32,
            h: req.get("h").and_then(|v| v.as_i64()).unwrap_or(40) as i32,
        };
        // 已在磁贴态则只挪位;否则先记下正常矩形。
        // 卫生检查(第18轮用户实测):记忆矩形宽 <300 = 已损坏(跨 DPI 拖拽/编队残留),
        // 直接恢复会得到一条 100px 的挤压窗——改记默认竖版矩形(位置仍用当前 x,y)。
        if STRIP_RECT.lock().unwrap().is_none() {
            let mut prev = raw_rect().map(|(x, y, w, h)| LayoutTarget { x, y, w, h });
            if let Some(p) = prev.as_mut() {
                if p.w < 300 {
                    p.w = 430;
                    p.h = p.h.max(560);
                }
            }
            *STRIP_PREV.lock().unwrap() = prev;
        }
        ANIM_UNTIL_MS.store(now_ms() + 260, std::sync::atomic::Ordering::Relaxed);
        *STRIP_RECT.lock().unwrap() = Some(t);
        // peek 浮现中:只更新记账矩形,不把窗从鼠标下抽走(unpeek 按最新条位收回)
        if PEEKING.load(std::sync::atomic::Ordering::Relaxed) {
            return ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")], axum::Json(serde_json::json!({"ok": true, "strip": true, "deferred": true})));
        }
        raw_apply_exact(&t);
        return ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")], axum::Json(serde_json::json!({"ok": true, "strip": true})));
    }
    if state == "peek" {
        let prev = *STRIP_PREV.lock().unwrap();
        if let (Some(p), Some(_s)) = (prev, *STRIP_RECT.lock().unwrap()) {
            PEEKING.store(true, std::sync::atomic::Ordering::Relaxed);
            ANIM_UNTIL_MS.store(now_ms() + 260, std::sync::atomic::Ordering::Relaxed);
            raw_apply_exact(&p);
            // peek = 临时置顶;unpeek 时还原
            #[cfg(target_os = "windows")]
            if let Some(hd) = hwnd_get() {
                const HWND_TOPMOST: isize = -1;
                const SWP_NOMOVE: u32 = 0x0002;
                const SWP_NOSIZE: u32 = 0x0001;
                const SWP_NOACTIVATE: u32 = 0x0010;
                const SWP_ASYNCWINDOWPOS: u32 = 0x4000;
                unsafe { SetWindowPos(hd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS) };
            }
        }
        return ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")], axum::Json(serde_json::json!({"ok": true})));
    }
    if state == "unpeek" {
        PEEKING.store(false, std::sync::atomic::Ordering::Relaxed);
        let s = *STRIP_RECT.lock().unwrap();
        if let Some(s) = s {
            ANIM_UNTIL_MS.store(now_ms() + 260, std::sync::atomic::Ordering::Relaxed);
            raw_apply_exact(&s);
            #[cfg(target_os = "windows")]
            if let Some(hd) = hwnd_get() {
                const HWND_NOTOPMOST: isize = -2;
                const SWP_NOMOVE: u32 = 0x0002;
                const SWP_NOSIZE: u32 = 0x0001;
                const SWP_NOACTIVATE: u32 = 0x0010;
                const SWP_ASYNCWINDOWPOS: u32 = 0x4000;
                unsafe { SetWindowPos(hd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS) };
            }
        }
        return ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")], axum::Json(serde_json::json!({"ok": true})));
    }
    const SW_MINIMIZE: i32 = 6;
    const SW_RESTORE: i32 = 9;
    let ok = if state == "minimize" {
        raw_show(SW_MINIMIZE);
        true
    } else if state == "maximize" {
        // 最大化语义分派(在队=整队阵型铺满/自由=自己最大化):统一走 Rust 侧
        // 新鲜判定(fleet_joined),TitleBar 钮/双击/Win+↑ 同一决策点
        trc("window_state maximize recv");
        let port = SELF_PORT.get().copied().unwrap_or(0);
        std::thread::spawn(move || maximize_dispatch(port));
        true
    } else {
        // restore:磁贴还原走磁贴前矩形;普通还原回放座位
        WS_STEP.store(2, std::sync::atomic::Ordering::Relaxed);
        let gen_at_entry = LAYOUT_GEN.load(std::sync::atomic::Ordering::SeqCst);
        trc(&format!("window_state restore recv focus={} gen={}", focus, gen_at_entry));
        let strip_prev = STRIP_PREV.lock().unwrap().take();
        *STRIP_RECT.lock().unwrap() = None;
        WS_STEP.store(3, std::sync::atomic::Ordering::Relaxed);
        // 最小化/最大化一并还原(SW_RESTORE 对两者同效;最大化窗 SetWindowPos 无效)
        raw_show(SW_RESTORE);
        WS_STEP.store(4, std::sync::atomic::Ordering::Relaxed);
        // 恢复后:回放座位;focus=true 请求前台(AttachThreadInput,不闪任务栏),
        // focus=false 只抬 z 序不激活(不抢用户正在操作的窗)
        if let Some(mut p) = strip_prev {
            // 恢复宽度下限:同 strip 收起侧的卫生检查(损坏记忆不再放大成挤压窗)
            if p.w < 300 {
                p.w = 430;
                p.h = p.h.max(560);
            }
            ANIM_UNTIL_MS.store(now_ms() + 420, std::sync::atomic::Ordering::Relaxed);
            animate_window(&app, p, 240);
        } else {
            // 拷出即放锁再 animate——if-let 条件里的锁 guard 活到分支体结束,
            // 而 animate_window 第一行就再锁 LAST_TARGET:std Mutex 不可重入,
            // 同线程自死锁(假死悬案真凶,watchdog ws_step=0x4 实证)
            let t = *LAST_TARGET.lock().unwrap();
            // 代际闸:处理期间有新落位指令进门(并发 HTTP 乱序),座位簿已是
            // 新指令写的新座位、且新指令自己会落位——此时回放=用旧座位的
            // 240ms 动画盖掉新坐标(team_maximize 落位被弹回旧位的根因)
            if LAYOUT_GEN.load(std::sync::atomic::Ordering::SeqCst) != gen_at_entry {
                trc("restore: skip seat replay (newer layout arrived)");
            } else if let Some(t) = t {
                animate_window(&app, t, 240);
            }
        }
        WS_STEP.store(5, std::sync::atomic::Ordering::Relaxed);
        if focus {
            raw_force_foreground();
        } else {
            raw_raise_noactivate();
        }
        WS_STEP.store(6, std::sync::atomic::Ordering::Relaxed);
        true
    };
    WS_STEP.store(0xFFFF, std::sync::atomic::Ordering::Relaxed);
    ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")], axum::Json(serde_json::json!({"ok": ok})))
}

// ── 主题协议:POST /myco/theme {mode:"light|dark"} → 自家 webview 事件 ──

async fn handle_theme(
    axum::extract::State(app): axum::extract::State<tauri::AppHandle>,
    axum::Json(req): axum::Json<serde_json::Value>,
) -> impl IntoResponse {
    let mode = req.get("mode").and_then(|v| v.as_str()).unwrap_or("dark").to_string();
    let _ = tauri::Emitter::emit(&app, "myco://theme", mode.clone());
    ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")], axum::Json(serde_json::json!({"ok": true, "mode": mode})))
}

/// 组 YoulingAuth 的 `myco://auth?...` URI（第49轮协议；抽成纯函数以便单测）。
/// - `sk`（A1 浏览器会话钥公钥）：URL 编码防 base64 的 `+`/`/`/`=` 破坏 query 解析；
/// - `silent`（2026-10-10 C-1/任务1）：为真时附 `&silent=1`，YoulingAuth 走静默续期
///   分支（不渲染确认弹层）；Rust 侧只允许它续期已授权会话钥。
fn build_auth_uri(
    ticket: &str,
    callback: &str,
    svc: &str,
    session_pubkey: Option<&str>,
    silent: bool,
) -> String {
    let mut uri = format!("myco://auth?ticket={ticket}&callback={callback}&svc={svc}");
    if let Some(sk) = session_pubkey.filter(|s| !s.is_empty()) {
        uri.push_str("&sk=");
        uri.push_str(&sk.replace('+', "%2B").replace('/', "%2F").replace('=', "%3D"));
    }
    if silent {
        uri.push_str("&silent=1");
    }
    uri
}

/// 第49轮：网页直连本机登录器。网页 POST {ticket,callback,svc} → emit 主窗弹确认 →
/// 网页轮询 ticket 状态收尾(现有协议唤起流程的网页轮询复用)。
async fn handle_auth_request(
    axum::extract::State(app): axum::extract::State<tauri::AppHandle>,
    axum::Json(req): axum::Json<serde_json::Value>,
) -> impl IntoResponse {
    let ticket = req.get("ticket").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let callback = req.get("callback").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let svc = req.get("svc").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if ticket.is_empty() || callback.is_empty() {
        return ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")], axum::Json(serde_json::json!({"ok": false, "error": "ticket/callback 缺失"})));
    }
    // 2026-10-10（会话委任状「过期前续期」C-1，用户批准"要加"）：
    // `silent=true` = 静默续期——**不 show/unminimize/set_focus**（页面定时续期时
    // 不抢用户焦点、不弹窗），仅 emit 让 YoulingAuth 重签新委任状。
    // 缺省 false = 现行为（向后兼容：老调用方不传则完全不变）。
    // 静默模式下窗口不可用（登录器未运行）→ 显式 ok:false，页面据此回退到普通唤起。
    let silent = req.get("silent").and_then(|v| v.as_bool()).unwrap_or(false);
    // 组协议 URI 复用 YoulingAuth 现有解析（myco://auth?ticket=&callback=&svc=&sk=&silent=）
    // 2026-10-10 任务1：把 `silent` 一并透传进 URI（`&silent=1`）——YoulingAuth 据此走
    // **静默续期**分支（不渲染确认弹层）：静默只允许续期已授权会话钥，未授权钥由 Rust
    // 侧 session_delegation_sign 拒签（安全闸），页面届时回退正常授权流程。
    let uri = build_auth_uri(
        &ticket,
        &callback,
        &svc,
        req.get("sessionPubkey").and_then(|v| v.as_str()),
        silent,
    );
    match app.get_webview_window("main") {
        Some(win) => {
            if !silent {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            let _ = tauri::Emitter::emit(&win, "youling-auth-uri", uri);
            (
                [(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")],
                axum::Json(serde_json::json!({
                    "ok": true,
                    "silent": silent,
                    "hint": if silent { "已静默通知本机登录器重签授权" } else { "已通知本机登录器，请在 myco 窗口确认" }
                })),
            )
        }
        None => (
            [(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")],
            axum::Json(serde_json::json!({
                "ok": !silent,
                "silent": silent,
                "error": if silent { "登录器未运行，静默续期不可用（请回退到普通唤起）" } else { "" },
                "hint": if silent { "登录器未运行" } else { "已通知本机登录器，请在 myco 窗口确认" }
            })),
        ),
    }
}

// ── 编队拖动中继:本窗被用户拖(非动画期 Moved)→ 整队平移 ──
//
// 主窗(env)动 → install() 跟随已知;这里补成员侧:拖任何一个成员窗,
// 平移量(dx,dy)上报 env /api/formation/relay_move → env 主窗平移 →
// 其余成员跟随(发起者被排除,防回打)。节流 100ms,与 env 侧一致。

/// canvas 探活(2026-10-03 最大化卡几秒根修):死端口在本机 winsock 上 connect
/// 被拒要 ~2.0-2.1s(实测 curl/原生 TcpClient/线上 exe 三方一致,回环过滤层所致),
/// 且 ureq 请求级 `.timeout(1s)` 拦不住 connect 阶段(实测 dispatch 全程 2.14s)——
/// 直接串在 maximize_dispatch 的 PostMessage 前,用户看到的就是"点最大化卡几秒"。
/// std TcpStream::connect_timeout 是非阻塞+deadline 轮询,语义可靠:
/// canvas 活着本机回环 ~2ms 必应;250ms 内连不上=env 不在/假死,整队铺满本来
/// 也指挥不动,直接走自由最大化。
fn canvas_alive() -> bool {
    let port: u16 = CANVAS_API.rsplit(':').next().and_then(|s| s.parse().ok()).unwrap_or(3102);
    let addr: std::net::SocketAddr = ([127, 0, 0, 1], port).into();
    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(250)).is_ok()
}

/// 编队判定(最大化语义分派用):编队跟随中且本窗在队 → 最大化=整队阵型铺满。
/// 决策时刻新鲜拉取,不用任何缓存(TitleBar 挂载态 stale 曾致在队走自由最大化)。
fn fleet_joined(port: u16) -> bool {
    if !canvas_alive() { return false; }
    ureq::get(&format!("{CANVAS_API}/api/formation/state"))
        .timeout(std::time::Duration::from_secs(1))
        .call()
        .ok()
        .and_then(|r| r.into_json::<serde_json::Value>().ok())
        .map(|j| {
            let following = j.pointer("/data/following").and_then(|v| v.as_bool()).unwrap_or(false);
            // home(17895)是编队锚点,不在 members 表——跟随中且锚点槽位在=在队。
            // 漏了它:home 上点最大化走自由分支自己独占全屏,队友全被盖
            // (「点最大化唤不起各窗」根因)。
            if port == 17895 {
                let home_in = j.pointer("/data/slots/home").map(|v| !v.is_null()).unwrap_or(false);
                return following && home_in;
            }
            let me_joined = j.pointer("/data/members").and_then(|v| v.as_array()).map(|ms| {
                ms.iter().any(|m| {
                    m.get("port").and_then(|p| p.as_u64()) == Some(port as u64)
                        && m.get("joined").and_then(|b| b.as_bool()).unwrap_or(false)
                })
            }).unwrap_or(false);
            following && me_joined
        })
        .unwrap_or(false)
}

/// 最大化语义分派(统一入口:TitleBar 钮/双击标题栏拦截 都走这):
/// 在队 → 自还原 + 请 env 整队阵型铺满;自由 → 自己最大化/还原切换。
/// 全 PostMessage 投递式,永不阻塞调用线程。
#[cfg(target_os = "windows")]
fn maximize_dispatch(port: u16) {
    const WM_SYSCOMMAND: u32 = 0x0112;
    const SC_RESTORE: usize = 0xF120;
    const SC_MAXIMIZE: usize = 0xF030;
    // 计时取证(2026-10-03 卡顿根修):fleet_joined 耗时落日志——canvas 死端口
    // 曾经拖到 2.14s(探活 250ms 封顶后应 ≤250ms),回归一眼可见。
    let t0 = std::time::Instant::now();
    let joined = fleet_joined(port);
    let probe_ms = t0.elapsed().as_millis();
    if joined {
        trc(&format!("maximize_dispatch port={port}: joined → team_maximize (probe={probe_ms}ms)"));
        if raw_maximized() {
            if let Some(hd) = hwnd_get() {
                #[link(name = "user32")]
                extern "system" { fn PostMessageW(h: isize, msg: u32, w: usize, l: isize) -> i32; }
                unsafe { PostMessageW(hd, WM_SYSCOMMAND, SC_RESTORE, 0) };
            }
        }
        // from=发起者端口:env 整队铺满后焦点回发起者(用户的手/眼在此),
        // 而非锚点——成员 TitleBar 点击时本窗本就持焦,焦点跳锚点=视线被抢
        let r = ureq::post(&format!("{CANVAS_API}/api/formation/maximize"))
            .timeout(std::time::Duration::from_secs(2))
            .send_json(serde_json::json!({ "from": port }));
        trc(&format!("maximize_dispatch port={port} team_maximize → {:?}", r.map(|x| x.status())));
    } else {
        // 自由窗:普通最大化/还原切换
        trc(&format!("maximize_dispatch port={port}: free → self toggle (probe={probe_ms}ms)"));
        if let Some(hd) = hwnd_get() {
            #[link(name = "user32")]
            extern "system" { fn PostMessageW(h: isize, msg: u32, w: usize, l: isize) -> i32; }
            let sc = if raw_maximized() { SC_RESTORE } else { SC_MAXIMIZE };
            unsafe { PostMessageW(hd, WM_SYSCOMMAND, sc, 0) };
        }
    }
}

// A19 feat/linux-gui：linux 变体整队最大化无 win32 路径——单窗场景无编队生态，
// TitleBar 最大化钮在此平台无操作（用户侧替代：窗口管理器原生拖边/双击标题栏）。
#[cfg(not(target_os = "windows"))]
fn maximize_dispatch(_port: u16) {}

fn install_fleet_drag(app: tauri::AppHandle, port: u16) {
    let Some(win) = app.get_webview_window("main") else { return };
    let last = std::sync::Mutex::new(win.outer_position().ok().map(|p| (p.x, p.y)));
    let last_relay = std::sync::Mutex::new(std::time::Instant::now() - std::time::Duration::from_secs(10));
    // 启动静默:窗口初始摆放(WM_MOVE 连发/居中/DPI 定位)不是用户拖动——
    // 实测事故:启动 Moved 被中继,env 被平移到虚拟屏外 y=9390。
    let started = std::time::Instant::now();
    win.on_window_event(move |ev: &tauri::WindowEvent| {
        // 用户点 ✕(CloseRequested):同步通知 env 本窗关了——在队窗的补位
        // 重排立即触发,不等 30s 健康轮(用户实测实测问题"关闭没触发布局")。
        // 同步发送(800ms 上限)保送达:进程随后退出,异步线程会被砍。
        if matches!(ev, tauri::WindowEvent::CloseRequested { .. }) {
            let _ = ureq::post(&format!("{CANVAS_API}/api/formation/member_closed"))
                .timeout(std::time::Duration::from_millis(800))
                .send_json(ureq::json!({ "port": port }));
            return;
        }
        // 整队最大化拦截:编队成员被最大化(按钮/Win+↑/双击标题栏)时,不独占
        // 全屏盖住队友——还原自己,请 env 按编队布局把整队铺满屏幕。
        // 只在【在队】时接管;自由窗的原生最大化不碰——曾无差别分派,
        // 自由最大化的 Resized 又触发分派被弹回原状(toggle 环路)。
        if matches!(ev, tauri::WindowEvent::Resized(_)) {
            let Some(w) = app.get_webview_window("main") else { return };
            if w.is_maximized().unwrap_or(false) {
                if !EVER_COMMANDED.load(std::sync::atomic::Ordering::Relaxed) { return; }
                let now = now_ms();
                let prev = LAST_TEAM_MAX_MS.swap(now, std::sync::atomic::Ordering::Relaxed);
                if now.saturating_sub(prev) < 800 { return; }
                std::thread::spawn(move || {
                    if fleet_joined(port) {
                        maximize_dispatch(port);
                    }
                });
                return;
            }
            // 手动 resize = 用户投票(空间重设计):拖边框改宽 → settle 350ms 后上报
            // 实宽 → env 学习 grow 权重 → 整队注水重排。守卫:动画期/从未入队/
            // 最小化一律不报。磁贴态特殊:peek 浮现中拖边框=「钉回+定宽」手势
            // (见 settle 线程内);纯条态(未 peek)没有可拖的边,不报。
            if !EVER_COMMANDED.load(std::sync::atomic::Ordering::Relaxed) { return; }
            if now_ms() < ANIM_UNTIL_MS.load(std::sync::atomic::Ordering::Relaxed) { return; }
            if w.is_minimized().unwrap_or(false) { return; }
            let started2 = started;
            if started2.elapsed() < std::time::Duration::from_secs(2) { return; }
            RESIZE_SETTLE.lock().unwrap().replace(std::time::Instant::now() + std::time::Duration::from_millis(350));
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(370));
                let due = *RESIZE_SETTLE.lock().unwrap();
                if !due.map(|d| std::time::Instant::now() >= d).unwrap_or(false) { return; }
                let in_strip = is_strip();
                if in_strip && !PEEKING.load(std::sync::atomic::Ordering::Relaxed) { return; }
                let Some((_, _, w2, h2)) = raw_rect() else { return };
                // 回声守卫:与最后下发的目标一致=我们自己排的,不是用户拖的
                if let Some(t) = *LAST_TARGET.lock().unwrap() {
                    if (t.w - w2).abs() < 6 && (t.h - h2).abs() < 6 { return; }
                }
                // 窄条宽(<200)不可能是用户意图下限之外的有效投票(磁贴宽不教学)
                if w2 < 200 { return; }
                // peek 态用户拖边框 = 钉回该窗并保留此宽(曾只是丢弃→松手 unpeek
                // 缩回条,用户 resize 静默丢失,实测实测问题)。就地出条态(保持用户
                // 拖出的矩形,不回放 STRIP_PREV),env 侧关 auto_hide 重排给槽位,
                // 随后 resize_vote 让列 ideal 吃下这个宽。
                if in_strip {
                    PEEKING.store(false, std::sync::atomic::Ordering::Relaxed);
                    *STRIP_RECT.lock().unwrap() = None;
                    *STRIP_PREV.lock().unwrap() = None;
                    #[cfg(target_os = "windows")]
                    if let Some(hd) = hwnd_get() {
                        const HWND_NOTOPMOST: isize = -2;
                        const SWP_NOMOVE: u32 = 0x0002;
                        const SWP_NOSIZE: u32 = 0x0001;
                        const SWP_NOACTIVATE: u32 = 0x0010;
                        const SWP_ASYNCWINDOWPOS: u32 = 0x4000;
                        #[link(name = "user32")]
                        extern "system" { fn SetWindowPos(h: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32; }
                        unsafe { SetWindowPos(hd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS) };
                    }
                    let r = ureq::post(&format!("{CANVAS_API}/api/formation/autohide"))
                        .timeout(std::time::Duration::from_secs(1))
                        .send_json(serde_json::json!({ "port": port, "on": false }));
                    trc(&format!("resize-during-peek → pin back (autohide off): {:?}", r.map(|x| x.status())));
                }
                let _ = ureq::post(&format!("{CANVAS_API}/api/formation/resize_vote"))
                    .timeout(std::time::Duration::from_secs(1))
                    .send_json(serde_json::json!({ "port": port, "w": w2, "h": h2 }));
            });
            return;
        }
        if !matches!(ev, tauri::WindowEvent::Moved(_)) {
            return;
        }
        let now = now_ms();
        if now < ANIM_UNTIL_MS.load(std::sync::atomic::Ordering::Relaxed) {
            // 动画期:只更新基线,不上报
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(p) = win.outer_position() {
                    *last.lock().unwrap() = Some((p.x, p.y));
                }
            }
            return;
        }
        let Some(win) = app.get_webview_window("main") else { return };
        let Ok(p) = win.outer_position() else { return };
        let mut g = last.lock().unwrap();
        let Some((lx, ly)) = *g else { *g = Some((p.x, p.y)); return };
        let (dx, dy) = (p.x - lx, p.y - ly);
        if dx == 0 && dy == 0 {
            return;
        }
        *g = Some((p.x, p.y));
        // 最小化(位置=-25600 假象,还原即巨跳)与启动 2s 内、超巨位移、微动死区、
        // 从未被指挥过的窗——一律只重建基线,不中继。
        if !EVER_COMMANDED.load(std::sync::atomic::Ordering::Relaxed)
            || started.elapsed() < std::time::Duration::from_secs(2)
            || dx.abs() > 400 || dy.abs() > 400
            || dx.abs() + dy.abs() < 6 {
            return;
        }
        // 最小化窗的 Moved 全是假象。
        if let Some(w) = app.get_webview_window("main") {
            if w.is_minimized().unwrap_or(false) { return; }
        }
        // 两态判据:只有主动态(标题栏按下中)才中继;跟随态的一切 Moved=回声。
        // 兜底:主动态标志若因丢 mouseup 残留,左键已松则自动纠正为跟随态。
        if !USER_DRAG.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        // 磁条不中继:条态窗的拖动是"挪条"不是"挪阵",平移整队会让条带漂移
        if is_strip() {
            return;
        }
        if !left_button_down() {
            USER_DRAG.store(false, std::sync::atomic::Ordering::Relaxed);
            return;
        }
        drop(g);
        // 节流:拖动事件洪泛,33ms 一报(≈30Hz,env 侧同频;拼板跟手)
        {
            let Ok(mut r) = last_relay.lock() else { return };
            if r.elapsed() < std::time::Duration::from_millis(33) {
                return;
            }
            *r = std::time::Instant::now();
        }
        std::thread::spawn(move || {
            let _ = ureq::post(&format!("{CANVAS_API}/api/formation/relay_move"))
                .timeout(std::time::Duration::from_secs(1))
                .send_json(serde_json::json!({ "port": port, "dx": dx, "dy": dy }));
        });
    });
}

#[cfg(test)]
mod auth_uri_tests {
    use super::*;

    /// 任务1（2026-10-10）回归钉：`silent` 必须透传进 URI（`&silent=1`）——
    /// 这是"静默续期只允许续期已授权会话钥"安全闸在 UI 侧的唯一开关；缺了它
    /// YoulingAuth 会渲染确认弹层且不会带 silent 调 Rust 侧拒签闸。
    #[test]
    fn silent_flag_passthrough() {
        let base = build_auth_uri("tk", "https://youling.cc/cb", "svc", None, false);
        assert_eq!(base, "myco://auth?ticket=tk&callback=https://youling.cc/cb&svc=svc");
        assert!(!base.contains("silent"), "非静默不得带 silent 标记");

        let s = build_auth_uri("tk", "https://youling.cc/cb", "svc", None, true);
        assert!(s.ends_with("&silent=1"), "静默必须透传 &silent=1: {s}");
        // 缺省 false = 原行为（向后兼容：老调用方不传则 URI 完全不变）
        assert_eq!(base, build_auth_uri("tk", "https://youling.cc/cb", "svc", None, false));
    }

    /// A1 会话钥 URL 编码不得被 silent 改动（`+`/`/`/`=` 必编码）+ 两者共存顺序稳定。
    #[test]
    fn session_pubkey_encoded_and_coexists_with_silent() {
        let uri = build_auth_uri("tk", "https://youling.cc/cb", "svc", Some("a+b/c="), true);
        assert!(uri.contains("&sk=a%2Bb%2Fc%3D"), "sk 必须 URL 编码: {uri}");
        assert!(uri.contains("&silent=1"));
        assert!(uri.ends_with("&silent=1"), "silent 在尾部（sk 之后）: {uri}");
        // 空 sk 不入 URI（既有行为）
        let none = build_auth_uri("tk", "cb", "svc", Some(""), false);
        assert!(!none.contains("&sk="), "空 sk 不得入 URI: {none}");
    }
}

#[cfg(test)]
mod maximize_tests {
    use super::*;

    /// 探活必须时限内返回（2026-10-03 卡顿根修回归钉）：canvas 端口死/被回环
    /// 过滤层拖延拒连（本机实测 RST ~2s）时，canvas_alive 的 connect_timeout
    /// 也得在 250ms 封顶处返回——最大化分派串行依赖它，超时即用户可见卡顿。
    #[test]
    fn canvas_probe_is_time_bounded() {
        let t0 = std::time::Instant::now();
        let _alive = canvas_alive();
        let el = t0.elapsed();
        assert!(el < std::time::Duration::from_millis(600),
            "canvas_alive 耗时 {el:?} 超界（应 ≤250ms + 少量余量）");
    }
}
