//! myco home — 根窗口(Root Window,2026-08-16 定稿):myco 的源头与编队长机。
//! 时间视角:今日/待办+新建任务+红黄绿灯墙+舰队调度(P/A/PA,前台/收起)。
//! 身份区:Youling/DID(v1 经 canvas)。协议:嵌入服务 :17895;移动=settle 通知
//! canvas 重排(anchor_moved),自身不加入成员列(它是锚)。

const PORT: u16 = 17995; // 第46轮：youling-myco 独立 embed 端口（老 myco 17895 并行）
const DID: &str = "did:myco:agent:ui-home";
const CONSUMES: &[&str] = &["pm/todos · boards_dock(灯) · agents/health"];
const PRODUCES: &[&str] = &["根窗口:任务总控+舰队调度+新建任务(quick_task)"];
const ENV_API: &str = "http://127.0.0.1:3102";

// feat/cli-suite：GUI 侧模块只在 gui feature（默认）下编译；CLI 变体
// （--no-default-features）走 cli/cli_serve 纯 Rust 路径，无 tauri 依赖。
// pub：bin/device_group_e2e.rs 双实例 E2E 复用 add_device_by_did/device_revoke/
// watch_probe_at 产线路径（同 p2p_server/p2p_client 的可见性放开理由）。
/// 委任状自动续约巡检（2026-10-11 分身静默过期缺口：本体巡签+分身续约请求）。
pub mod delegation_renewal;

/// 出厂默认配置（2026-11-12）：裸跑 exe 也必须全量工作——设备域/身份闸/
/// multi-forward/VNETP 口/mf 白名单等不再依赖启动脚本的 set 行。
pub mod boot_config;
#[cfg(feature = "gui")]
pub mod identity_service;
#[cfg(feature = "gui")]
pub mod presence;
// 第81轮：好友+聊天（identity-svc /msg/* 中转 + 本地 chat/ 存储 + 任务卡分享）
#[cfg(feature = "gui")]
pub mod chat_service;
// 第84轮：去中心化聊天 P2P——消息本体走 IPv6 直连，服务器只建联/握手/公钥。
// pub：tests/p2p_e2e.rs 双实例 E2E 对拍（模块可见性放开，函数仍按需 pub）。
#[cfg(feature = "gui")]
pub mod p2p_client;
#[cfg(feature = "gui")]
pub mod p2p_server;
#[cfg(feature = "gui")]
pub mod p2p_sync;
// 2026-10-09：P2P web 隧道（WS 承载的透明 TCP，把本机 loopback 白名单端口经 p2p 网
// 代理给好友设备；握手验签 + 归属闸 + 端口白名单 + 审计。见 p2p_tunnel.rs 模块头）。
// 契约面 `tunnel_open/tunnel_close` 由 p2p_client re-export。
#[cfg(feature = "gui")]
pub mod p2p_tunnel;
// 2026-11-04：vnet 新传输层（UDP-first + P2P 打洞 + 中继兜底）——vnet 会话沙箱代码
// vendoring（去 rand/tracing，仅新依赖 anyhow），与旧 p2p_tunnel.rs 通过
// MYCO_TUNNEL_TRANSPORT=vnet|legacy 开关灰度共存。
pub mod vnet;
/// myco 层的 vnet 传输适配器（端口转发 → vnet Connection 实例）
pub mod vnet_forward;
/// Windows 电源护栏：有活 vnet 隧道时持 SYSTEM power request，防 Modern Standby 断网。
#[cfg(feature = "gui")]
pub mod power_guard;
// 2026-10-22 vnet：mDNS 同 LAN 发现（E1）
pub mod mdns_lan;
// 第95轮：本地待发队列（纯本地 P2P 语义——deliver 失败入队，对方上线自动补发；
// 无服务器信箱。见 offline_queue.rs 模块头）。
#[cfg(feature = "gui")]
pub mod offline_queue;

/// CLI 通道（`myco cli <子命令>`；纯 Rust，两变体都编入——见 cli.rs 头注释）。
pub mod cli;
mod cli_serve;
/// 2026-10-11 云端中转兜底：P2P 直连不通时经阿里云 identity-svc TCP relay 转发
pub mod cloud_relay;
/// 开发/清理型 HTTP 面（peer-tasks 删除、会话删除；`MYCO_DEV_API=1` 门禁）
pub mod dev_cleanup;
/// DSH 分享网关（多颗粒度分享 / DID 授权 / 原生挂载反代本机 dsh web）
pub mod dsh_share;
/// HBL 发题智能体（旧格式收题→ENV publish→truth 轮询→回调；SHADOW 镜像默认开，
/// HBL_INGEST_ENABLED 空=不挂载零影响——见 hbl_ingest.rs 头注释）。
/// 2026-11-03 开源（Phase 1）：feature gate——开源构建不带 HBL 业务集成。
#[cfg(feature = "hbl")]
pub mod hbl_ingest;
pub mod msg;
/// 消息库只读 HTTP 面（/api/msg/*，S3/S4 验收用；mode=off 时明确报错不假绿）
pub mod msg_api;
/// 2026-11-11 跨账号 DSH 会话消息（kind=`dsh-session-msg`）：`POST /api/msg/route`
/// （好友/分享任务 owner 校验 → P2P 投递）+ `GET /api/chat_state`（薄包装）+ 入站
/// 注入本机 DSH 会话（署名头 + 既有 `session/prompt` 代理）。见 msg_route.rs 头契约。
/// 依赖 chat_service（tauri）→ 仅 GUI 变体。
#[cfg(feature = "gui")]
pub mod msg_route;
/// T201 生产适配层（模式/路径/句柄缓存/一次性迁移）；默认 `MYCO_MSG_STORE=off` 零副作用
pub mod msg_store;
/// 统一端口档案 `config_dir()/ports.json`（mgmt 动态换口 + gw/tunnel 实际值
/// 可发现——调用方从文件读实际口，不再硬编码 3102；见模块头）。
pub mod ports_file;
/// DSH 分享网关授权存储（从 apps/env 抽取最小集；env 运行时第 63 轮退役后迁入本进程）
pub mod share_auth;
/// 冷启动分段打点（`MYCO_STARTUP_TRACE=1`；只写 stderr，不改变启动顺序）。
pub mod startup_trace;
/// 测试基建：进程级 MYCO_CONFIG_DIR 共享隔离锁（2026-10-07 flaky 立法，见模块头）。
#[cfg(test)]
pub(crate) mod test_env_lock;
/// 任务卡 env 执行器（2026-10-23 · AOP：入口只来自分享的任务卡；见模块头）
pub mod vnet_env;
pub mod share_app;
/// vnet 端点租约层（L4）：本地入口端口生命周期状态机 + keeper 收归本层
/// （task-vnet-endpoint-lease-20261025 §4/§7；见模块头）
/// 2026-10-26 修：补 gui 门控——内部引用 p2p_tunnel（gui-only），CLI 构建报 E0433。
#[cfg(feature = "gui")]
pub mod vnet_lease;

/// 第88轮：youling 领取任务同步显示 + 我的能力值（观察面协议化——myco 不存
/// 任务状态，每次拉 ENV 感知面 API 渲染；鉴权三层渐进见模块头）。
pub mod youling_tasks;

#[cfg(feature = "gui")]
use std::sync::atomic::{AtomicBool, AtomicU8};
#[cfg(feature = "gui")]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(feature = "gui")]
use std::sync::Mutex;
#[cfg(feature = "gui")]
use tauri::Manager;
// 非 test 构建才引 Tauri `Emitter`（`.emit()` 的 trait）：lib 单元测试 harness 没有 exe
// manifest，测试可达代码一旦链上 tauri 的 webview 运行时（Wry → muda），就会静态导入
// `comctl32.dll!TaskDialogIndirect`（v6 专属符号）→ 加载器绑 v5.82 → 0xC0000139 起不来。
// 详见 `apps/home/src-tauri/build.rs` 顶部长注释。
#[cfg(all(feature = "gui", not(test)))]
use tauri::Emitter;

// 更新链路 v2(2026-09-22 重构):sha256 校验 + Range 断点续传 + 退避重试 +
// 原生 zip 解压 + 事件进度——详见 update.rs 模块头。
#[cfg(feature = "gui")]
pub mod update;

#[cfg(feature = "gui")]
static SETTLE_AT: Mutex<Option<std::time::Instant>> = Mutex::new(None);
#[cfg(feature = "gui")]
static LAST_NOTIFY: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 长机职责0:自报锚点矩形(home 进程内读,无跨进程 DPI 问题)。
#[cfg(feature = "gui")]
fn report_anchor_rect(win: &tauri::WebviewWindow) -> bool {
    // 最小化停泊位是毒锚:outer_position 会报 -32000 系坐标,env 收到即整队
    // 重排+restore,把刚做的整队最小化(点 ─ 全队收)一秒内拉回来(实测)。
    if win.is_minimized().unwrap_or(false) {
        return false;
    }
    let (Ok(p), Ok(sz)) = (win.outer_position(), win.outer_size()) else {
        return false;
    };
    if p.x < -1000 || p.y < -1000 {
        return false;
    }
    ureq::post(&format!("{ENV_API}/api/formation/anchor_rect"))
        .timeout(std::time::Duration::from_secs(2))
        .send_json(ureq::json!({
            "x": p.x, "y": p.y,
            "w": sz.width as i32, "h": sz.height as i32,
        }))
        .is_ok()
}

/// 周用量按项目归因(2026-08-30):只读 llm-proxy 账本(权威源,canvas 不在也不丢),
/// 路径 %APPDATA%/myco/usage/usage-YYYY-MM-DD.jsonl;每行 camelCase
/// inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/project。
/// 聚合本周(本地周一 00:00 起) → {monday, weekTotal, byProject:{name:tokens}}。
/// 配额/权重语义在前端;这里只给事实数据(home 只读账本,不写)。
#[tauri::command]
#[cfg(feature = "gui")]
fn usage_week_by_project() -> Result<serde_json::Value, String> {
    use chrono::Datelike;
    use std::collections::BTreeMap;
    use std::io::{BufRead, BufReader};

    let dir = std::env::var("APPDATA")
        .map(|a| std::path::PathBuf::from(a).join("myco").join("usage"))
        .or_else(|_| {
            std::env::var("HOME").map(|h| {
                std::path::PathBuf::from(h)
                    .join(".config")
                    .join("myco")
                    .join("usage")
            })
        })
        .map_err(|_| "no config dir".to_string())?;
    let now = chrono::Local::now();
    let mon =
        now.date_naive() - chrono::Duration::days(now.weekday().num_days_from_monday() as i64);
    let mon_s = mon.format("%Y-%m-%d").to_string();

    let mut by: BTreeMap<String, u64> = BTreeMap::new();
    let mut week_total: u64 = 0;
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".jsonl") {
            continue;
        }
        // usage-YYYY-MM-DD.jsonl:只要本周(含)之后的文件
        let day = name
            .strip_prefix("usage-")
            .and_then(|s| s.get(..10))
            .unwrap_or("");
        if day < mon_s.as_str() {
            continue;
        }
        let Ok(f) = std::fs::File::open(e.path()) else {
            continue;
        };
        for ln in BufReader::new(f).lines().flatten() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&ln) else {
                continue;
            };
            let t = v["inputTokens"].as_u64().unwrap_or(0)
                + v["outputTokens"].as_u64().unwrap_or(0)
                + v["cacheReadTokens"].as_u64().unwrap_or(0)
                + v["cacheWriteTokens"].as_u64().unwrap_or(0);
            if t == 0 {
                continue;
            }
            let p = match v["project"].as_str() {
                Some(s) if !s.is_empty() => s.to_string(),
                _ => "(未归因)".to_string(),
            };
            *by.entry(p).or_insert(0) += t;
            week_total += t;
        }
    }
    Ok(serde_json::json!({ "monday": mon_s, "weekTotal": week_total, "byProject": by }))
}

/// 生产更新检查(2026-08-31):对比 dev-02 latest.json。
/// 第64轮修:「当前 v0.3.24」误显——原读 exe 旁 VERSION.txt(冻结目录时代机制,
/// 装机目录里是陈年旧文件),改用 exe 内嵌 CARGO_PKG_VERSION(唯一真相源)。
/// 三端更新闭环的 PC 端入口:web 端随 PC 自动新版(零更新),手机 APK 另查同一清单。
/// 平台前端基址（/downloads 更新清单、/task 卡所在站根）。环境变量 `MYCO_NETWORK_URL`
/// 覆盖（换环境只改变量，不改代码），缺省=第90轮域名现状。
pub(crate) fn platform_base_url() -> String {
    std::env::var("MYCO_NETWORK_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "https://myco.youling.cc".to_string())
}

#[tauri::command]
#[cfg(feature = "gui")]
fn prod_update_info() -> serde_json::Value {
    let cur = env!("CARGO_PKG_VERSION").to_string();
    let (mut latest, mut notes) = (String::new(), String::new());
    if let Ok(resp) = ureq::get(&format!("{}/downloads/latest.json", platform_base_url()))
        .timeout(std::time::Duration::from_secs(8))
        .call()
    {
        if let Ok(j) = resp.into_json::<serde_json::Value>() {
            if let Some(v) = j["version"].as_str() {
                latest = v.to_string();
            }
            if let Some(n) = j["notes"].as_str() {
                notes = n.to_string();
            }
        }
    }
    let has = !latest.is_empty() && latest != cur;
    serde_json::json!({ "current": cur, "latest": latest, "notes": notes, "hasUpdate": has })
}

/// 确认更新:run_prod_update(zip 流自更新,第64轮起唯一主路——下载→解包→替换→
/// 重启全在 Rust 内;update-prod.ps1 是历史死件,本仓无活跃调用方)。
/// 优雅关闭成员(2026-09-03 用户修正:先发 WM_CLOSE 让程序清理,不是 /F 强杀):
/// ① taskkill(不带 /F)= 发 WM_CLOSE → 窗口收到 CloseRequested → Tauri 正常退出
///   (保存状态/关连接/落盘) ② 等 5s ③ 还活着 → taskkill /F 强杀兜底。
#[tauri::command]
#[cfg(feature = "gui")]
async fn kill_member(exe: String) -> Result<String, String> {
    let whitelist = ["aop.exe", "youling.exe"];
    if !whitelist.contains(&exe.as_str()) {
        return Err(format!("非白名单 exe: {exe}"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 2026-10-15：taskkill/tasklist 都是控制台程序——不带 CREATE_NO_WINDOW 会闪黑窗
        let _ = std::process::Command::new("taskkill")
            .args(["/IM", &exe])
            .creation_flags(0x0800_0000)
            .output();
        for _ in 0..10 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let check = std::process::Command::new("tasklist")
                .args(["/FI", &format!("IMAGENAME eq {exe}"), "/FO", "CSV", "/NH"])
                .creation_flags(0x0800_0000)
                .output()
                .map_err(|e| e.to_string())?;
            let out = String::from_utf8_lossy(&check.stdout);
            if !out.to_lowercase().contains(&exe.to_lowercase()) {
                return Ok("graceful".to_string());
            }
        }
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", &exe])
            .creation_flags(0x0800_0000)
            .output();
        Ok("forced".to_string())
    }
    #[cfg(not(windows))]
    Err("仅 Windows".to_string())
}

/// 各 exe 报版本(2026-09-03):编译时嵌入 Cargo 版本。
#[tauri::command]
#[cfg(feature = "gui")]
fn get_build_info() -> serde_json::Value {
    // exeMtime：当前进程 exe 的修改时间（epoch ms）。版本号相同的自建包靠它区分构建批次；
    // 纯本地读取、不联网——设置页「当前版本」在离线/检查更新失败时也要能显示（用户 2026-10-23 要求）。
    let exe_mtime = std::env::current_exe()
        .ok()
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "name": env!("CARGO_PKG_NAME"),
        "exeMtime": exe_mtime,
    })
}

/// 开机自启（HKCU\\Software\Microsoft\Windows\CurrentVersion\Run，免 UAC）
#[tauri::command]
#[cfg(feature = "gui")]
fn autostart_get() -> bool {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        hkcu.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
            .and_then(|k| k.get_value::<String, _>("YoulingLoginer"))
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[tauri::command]
#[cfg(feature = "gui")]
fn autostart_set(enable: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = hkcu
            .open_subkey_with_flags(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
                winreg::enums::KEY_WRITE,
            )
            .map_err(|e| format!("打开 Run 键失败: {e}"))?;
        if enable {
            let exe = std::env::current_exe().map_err(|e| format!("取 exe 路径失败: {e}"))?;
            key.set_value("YoulingLoginer", &exe.to_string_lossy().to_string())
                .map_err(|e| format!("写自启失败: {e}"))?;
        } else {
            let _ = key.delete_value("YoulingLoginer");
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = enable;
        Err("自启注册仅 Windows".into())
    }
}

// ============================================================
// 窗口自动贴边隐藏（第52轮 home 自研——旧 formation API 参数名 enabled/on 不匹配
// 且作用对象是 env 多窗编队体系,home 单窗从来不在其中,双重无效）
// 交互=平移式:窗口移出左缘只留 22px 磁条（第91轮用户定:44 减半）,鼠标移上平移滑入,移开滑出。
// ============================================================
#[cfg(feature = "gui")]
static AUTOHIDE_PREV: Mutex<Option<(i32, i32, u32, u32)>> = Mutex::new(None); // (x, y, w, h)
#[cfg(feature = "gui")]
static AUTOHIDE_ON: AtomicBool = AtomicBool::new(false);
#[cfg(feature = "gui")]
static AUTOHIDE_EDGE: AtomicU8 = AtomicU8::new(0); // 0=左 1=右

/// 贴边几何（第73轮重写——方向感知 + 最小化免疫 + 停放坐标防呆）。
/// 实测三根因：①最小化时 outer_size 返回停放 64px → 磁条露出 300px（"很宽"）；
/// ②prev 存了停放 y=-16000 → peek/恢复整窗跑出屏幕；③只认左缘,右缘拖过去也往左藏。
#[cfg(feature = "gui")]
fn autohide_geometry(win: &tauri::WebviewWindow) -> Result<(u8, i32, i32, i32, i32), String> {
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    let mon = win
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("无显示器")?;
    let mon_l = mon.position().x;
    let mon_r = mon.position().x + mon.size().width as i32;
    let work_t = mon.position().y; // 工作区上沿近似（任务栏厚度由 clamp 兜底,不精确无碍）
                                   // 方向：窗口中心离哪边近贴哪边
    let cx = pos.x + size.width as i32 / 2;
    let edge = if (cx - mon_l).abs() <= (mon_r - cx).abs() {
        0u8
    } else {
        1u8
    };
    let scale = win.scale_factor().unwrap_or(1.0);
    let strip = (22.0 * scale) as i32; // 磁条露出=22 逻辑像素（第91轮用户定:44 减半）
    let w = size.width as i32;
    let strip_x = if edge == 0 {
        mon_l - w + strip
    } else {
        mon_r - strip
    };
    let expand_x = if edge == 0 { mon_l } else { mon_r - w };
    // y 防呆：停放坐标(-16000)或屏幕外 → 拉回工作区
    let y = if pos.y < work_t || pos.y > work_t + 2000 {
        work_t + 25
    } else {
        pos.y
    };
    Ok((edge, strip_x, expand_x, y, w))
}

#[tauri::command]
#[cfg(feature = "gui")]
fn autohide_set(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use tauri::Manager;
    let win = app.get_webview_window("main").ok_or("主窗不存在")?;
    if on {
        if AUTOHIDE_ON.load(Ordering::Relaxed) {
            return Ok(());
        }
        // 最小化时先还原——否则 outer_size/outer_position 是停放态(64px/-16000),全链烂
        let _ = win.unminimize();
        let pos = win.outer_position().map_err(|e| e.to_string())?;
        let size = win.outer_size().map_err(|e| e.to_string())?;
        // 停放坐标防呆：还原后仍异常（极端时序）→ 不存垃圾 prev,报错退出
        if pos.x <= -30000 || pos.y <= -30000 || size.width < 100 {
            return Err("窗口状态异常（最小化切换中），请稍后再试".into());
        }
        *AUTOHIDE_PREV.lock().unwrap() = Some((pos.x, pos.y, size.width, size.height));
        let (edge, strip_x, _expand_x, y, _w) = autohide_geometry(&win)?;
        AUTOHIDE_EDGE.store(edge, Ordering::Relaxed);
        AUTOHIDE_ON.store(true, Ordering::Relaxed);
        win.set_position(tauri::PhysicalPosition::new(strip_x, y))
            .map_err(|e| e.to_string())?;
    } else {
        AUTOHIDE_ON.store(false, Ordering::Relaxed);
        if let Some((x, y, _w, _h)) = AUTOHIDE_PREV.lock().unwrap().take() {
            // 恢复防呆：prev 是停放坐标（历史脏数据）→ 落到显示器左上默认位,不让窗口消失
            let (px, py) = if x <= -30000 || y <= -30000 {
                let mon = win
                    .current_monitor()
                    .map_err(|e| e.to_string())?
                    .ok_or("无显示器")?;
                (mon.position().x + 25, mon.position().y + 25)
            } else {
                (x, y)
            };
            win.set_position(tauri::PhysicalPosition::new(px, py))
                .map_err(|e| e.to_string())?;
            let _ = win.show();
        }
    }
    Ok(())
}

/// 条化态下的临时展开/收回（document mouseenter/mouseleave 驱动——第91轮:hover 任意窗体部位唤出,原先只认 TitleBar）。
#[tauri::command]
#[cfg(feature = "gui")]
fn autohide_peek(app: tauri::AppHandle, expand: bool) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use tauri::Manager;
    if !AUTOHIDE_ON.load(Ordering::Relaxed) {
        return Ok(());
    }
    let win = app.get_webview_window("main").ok_or("主窗不存在")?;
    // 几何实时算（第73轮：不再用 prev 的陈旧 w——最小化/缩放后 prev.w 是错的）
    let (_edge, strip_x, expand_x, y, _w) = autohide_geometry(&win)?;
    let target_x = if expand { expand_x } else { strip_x };
    win.set_position(tauri::PhysicalPosition::new(target_x, y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================
// 关闭→托盘（2026-10-18 用户需求：微信式常驻）
//   点窗口关闭默认**进托盘**（进程常驻：P2P/聊天/分享网关全部继续服务）；
//   设置可改「退出应用」（真关闭=原行为）。**「最小化」不是选项**——要最小化
//   就点最小化按钮（2026-10-18 用户二次修正拍板）。
//   托盘右键：打开/设置/退出；左键=显示窗口。
//   持久化：%APPDATA%\youling\close-behavior.txt（"tray"|"quit"，缺省=tray）。
// ============================================================
#[cfg(feature = "gui")]
static CLOSE_BEHAVIOR: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

#[cfg(feature = "gui")]
fn close_behavior_file() -> std::path::PathBuf {
    let mut p = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    p.push("youling");
    p.push("close-behavior.txt");
    p
}

/// 当前关闭行为（未加载则先从盘上读；非法值一律归 "tray"）。
#[cfg(feature = "gui")]
fn close_behavior_current() -> String {
    {
        let g = CLOSE_BEHAVIOR.lock().unwrap();
        if !g.is_empty() {
            return g.clone();
        }
    }
    let v = std::fs::read_to_string(close_behavior_file()).unwrap_or_default();
    let v = v.trim().to_string();
    let v = if v == "quit" { v } else { "tray".into() };
    *CLOSE_BEHAVIOR.lock().unwrap() = v.clone();
    v
}

#[tauri::command]
#[cfg(feature = "gui")]
fn close_behavior_get() -> String {
    close_behavior_current()
}

#[tauri::command]
#[cfg(feature = "gui")]
fn close_behavior_set(behavior: String) -> Result<(), String> {
    let b = if behavior == "quit" { "quit" } else { "tray" }.to_string();
    let p = close_behavior_file();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    std::fs::write(&p, &b).map_err(|e| format!("写关闭行为失败: {e}"))?;
    *CLOSE_BEHAVIOR.lock().unwrap() = b;
    Ok(())
}

/// 托盘装配：图标+tooltip+菜单（打开/设置/退出），左键=显示窗口。
/// 菜单事件里窗口操作全走 run_on_main_thread（同 single_instance 的线程纪律）。
#[cfg(feature = "gui")]
fn setup_tray(app: &tauri::App) {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::Emitter;

    let open_i = MenuItem::with_id(app, "tray-open", "打开 myco", true, None::<&str>).ok();
    let settings_i = MenuItem::with_id(app, "tray-settings", "设置", true, None::<&str>).ok();
    let quit_i = MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>).ok();
    let menu = match Menu::new(app) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[tray] 菜单创建失败: {e}");
            return;
        }
    };
    if let Some(i) = open_i {
        let _ = menu.append(&i);
    }
    if let Some(i) = settings_i {
        let _ = menu.append(&i);
    }
    if let Some(i) = quit_i {
        let _ = menu.append(&i);
    }

    let builder = TrayIconBuilder::with_id("myco-main")
        .tooltip("myco 登录器")
        .menu(&menu)
        // Windows：左键不弹菜单（走显示窗口），右键弹菜单
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                match id.as_str() {
                    "tray-open" => show_main_window(&app2),
                    "tray-settings" => {
                        show_main_window(&app2);
                        // 前端监听此事件 → 直接展开设置页（账号视图+设置 tab）
                        let _ = app2.emit("tray-open-settings", ());
                    }
                    "tray-quit" => {
                        // 与原关闭按钮语义一致：真退出（托盘是唯一常驻入口之外的出口）
                        app2.exit(0);
                    }
                    _ => {}
                }
            });
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app2 = tray.app_handle().clone();
                let _ = tray
                    .app_handle()
                    .run_on_main_thread(move || show_main_window(&app2));
            }
        });
    // 图标：打包资源里的默认窗口图标（与 exe 图标同源）——icon() 消耗 builder，
    // 按需改链：有图标 → 带图标的 build；无 → 原样 build。
    if let Some(icon) = app.default_window_icon() {
        match builder.icon(icon.clone()).build(app) {
            Ok(_) => {}
            Err(e) => eprintln!("[tray] 托盘初始化失败（关闭行为仍生效，仅无图标）: {e}"),
        }
    } else {
        match builder.build(app) {
            Ok(_) => {}
            Err(e) => eprintln!("[tray] 托盘初始化失败（关闭行为仍生效，仅无图标）: {e}"),
        }
    }
}

/// 显示主窗（托盘左键/菜单/深链接共用）：show + unminimize + focus。
#[cfg(feature = "gui")]
fn show_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 版本检查/自更新/进度读取 → update.rs(2026-09-22 更新链路 v2 重构迁出)。

/// 更新器 spawn 链最小诊断（2026-09-19 更新卡死排查）：三层实验一次跑完，
/// 各写一个标记文件到 %TEMP%\myco-spawn-*.txt——哪层断了一目了然。
#[tauri::command]
#[cfg(feature = "gui")]
fn spawn_diag() -> Result<String, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let tmp = std::env::temp_dir();
        let out = |name: &str| tmp.join(name);
        let _ = std::fs::write(out("myco-spawn-0-direct.txt"), "direct write ok");
        // 实验1: 直接 spawn cmd 写文件
        let r1 = std::process::Command::new("cmd")
            .args([
                "/C",
                "echo spawn-cmd-ok >",
                out("myco-spawn-1-cmd.txt").to_string_lossy().as_ref(),
            ])
            .creation_flags(0x0800_0000)
            .spawn();
        // 实验2: cmd start 中转 + powershell 写文件
        let r2 = std::process::Command::new("cmd")
            .args([
                "/C",
                "start",
                "\"diag\"",
                "/B",
                "cmd",
                "/C",
                "echo spawn-start-ok >",
                out("myco-spawn-2-start.txt").to_string_lossy().as_ref(),
            ])
            .creation_flags(0x0800_0000)
            .spawn();
        // 实验3: 与更新器完全同款(powershell -File 真文件)
        let ps1 = tmp.join("myco-spawn-3.ps1");
        let _ = std::fs::write(
            &ps1,
            format!(
                "'ps1-ok' | Out-File -FilePath '{}'",
                out("myco-spawn-3-ps1.txt").to_string_lossy()
            ),
        );
        let r3 = std::process::Command::new("cmd")
            .args([
                "/C",
                "start",
                "\"diag3\"",
                "/B",
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&ps1)
            .creation_flags(0x0800_0000)
            .spawn();
        // 实验4: 直 spawn powershell -File（更新器最终形态候选）
        let ps4 = tmp.join("myco-spawn-4.ps1");
        let _ = std::fs::write(
            &ps4,
            format!(
                "'ps4-ok' | Out-File -FilePath '{}'",
                out("myco-spawn-4-direct-ps.txt").to_string_lossy()
            ),
        );
        let r4 = std::process::Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&ps4)
            .creation_flags(0x0800_0000)
            .spawn();
        Ok(format!(
            "r1={:?} r2={:?} r3={:?} r4={:?}",
            r1.is_ok(),
            r2.is_ok(),
            r3.is_ok(),
            r4.is_ok()
        ))
    }
    #[cfg(not(windows))]
    {
        Ok("spawn_diag 仅 Windows".into())
    }
}

// ============================================================
// 有灵账号登录(myco://auth 深链接)——youling.cc 网页登录唤起本机 myco.exe
// ============================================================
// 流程：网页生成 myco://auth?ticket=&callback=&svc= 深链接 → 系统按协议注册
// 启动本 exe(冷启动=argv；已在跑=单实例插件回调 argv) → 存 PENDING 并 emit
// `youling-auth-uri` → 前端弹确认 → take_pending_auth_uri/事件取 URI →
// 用户确认后调 youling_auth_callback(在 Rust 侧 POST 回 youling，免 CORS)。
// static PENDING_AUTH_URI: GUI 侧深链接暂存（CLI 变体无窗口/事件面，不编译）
#[cfg(feature = "gui")]
static PENDING_AUTH_URI: Mutex<Option<String>> = Mutex::new(None);

fn extract_myco_uri<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().find(|a| a.starts_with("myco://"))
}

/// 解析 `myco://chat?did=<did>[&label=<名>]` → (did, label)。
/// 用途：分享页（harness web 房间）里点在线协作者圆圈 → 跳回 myco 与该好友的对话。
#[cfg(feature = "gui")]
fn parse_chat_uri(uri: &str) -> Option<(String, Option<String>)> {
    let rest = uri.strip_prefix("myco://chat")?;
    let query = rest.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut did = None;
    let mut label = None;
    for kv in query.split('&') {
        match kv.split_once('=') {
            Some(("did", v)) if !v.is_empty() => did = Some(urldecode(v)),
            Some(("label", v)) if !v.is_empty() => label = Some(urldecode(v)),
            _ => {}
        }
    }
    did.map(|d| (d, label))
}

#[cfg(feature = "gui")]
fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 深链接分发：`myco://chat` 走好友对话，其余仍走登录确认（原语义不变）。
#[cfg(feature = "gui")]
fn dispatch_myco_uri(app: &tauri::AppHandle, uri: String) {
    if let Some((did, label)) = parse_chat_uri(&uri) {
        PENDING_CHAT_DID
            .lock()
            .unwrap()
            .replace((did.clone(), label.clone()));
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
            // cfg(not(test))：UI 事件通道，测试态不引 tauri webview 运行时（见本文件
            // `use tauri::Emitter` 上方注释）。
            #[cfg(not(test))]
            let _ = win.emit(
                "myco-open-chat",
                serde_json::json!({ "did": did, "label": label }),
            );
        }
        return;
    }
    stash_auth_uri_and_emit(app, uri);
}

/// 冷启动深链接暂存（前端挂载后 take_pending_chat_did 取走）：
/// 与 PENDING_AUTH_URI 同款竞态处理——emit 可能早于 webview 就绪。
#[cfg(feature = "gui")]
static PENDING_CHAT_DID: Mutex<Option<(String, Option<String>)>> = Mutex::new(None);

/// 前端取走待处理的"打开好友对话"请求（冷启动用）。
#[cfg(feature = "gui")]
#[tauri::command]
fn take_pending_chat_did() -> Option<serde_json::Value> {
    PENDING_CHAT_DID
        .lock()
        .unwrap()
        .take()
        .map(|(did, label)| serde_json::json!({ "did": did, "label": label }))
}

#[cfg(feature = "gui")]
fn stash_auth_uri_and_emit(app: &tauri::AppHandle, uri: String) {
    PENDING_AUTH_URI.lock().unwrap().replace(uri.clone());
    if let Some(win) = app.get_webview_window("main") {
        // 第21轮用户实测:网页唤起登录器后窗口常埋在后台,用户看不到确认弹层——
        // 唤起即置前+抢焦点(show 对最小化也有效;unminimize 处理贴边条态)。
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        // cfg(not(test))：UI 事件通道（同 dispatch_myco_uri）。
        #[cfg(not(test))]
        let _ = win.emit("youling-auth-uri", uri);
    }
}

/// 便携版 exe 无安装器：启动时自注册 myco:// 协议到 HKCU(免管理员,幂等)。
/// 指向当前 exe 路径——用户换目录/换版本后自动指向新位置。
#[cfg(windows)]
fn register_myco_protocol() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let cmd_line = format!("\"{}\" \"%1\"", exe.display());
    let base = r"HKCU\\Software\Classes\myco";
    for (path, name, val) in [
        (base, "@", "URL:myco Protocol"),
        (base, "URL Protocol", ""),
        (
            r"HKCU\\Software\Classes\myco\shell\open\command",
            "@",
            &cmd_line,
        ),
    ] {
        let mut c = std::process::Command::new("reg");
        c.args(["add", path]);
        if name == "@" {
            c.arg("/ve");
        } else {
            c.args(["/v", name]);
        }
        c.args(["/d", val, "/f"]);
        // 2026-10-15：reg.exe 是控制台程序，GUI 进程 spawn 它必闪黑窗（用户真案：
        // "重启 myco 时有控制台一闪而过"）。CREATE_NO_WINDOW 根治。
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000);
        }
        let _ = c.output();
    }
}
#[cfg(not(windows))]
fn register_myco_protocol() {}

/// 前端挂载后拉取冷启动时带来的登录 URI(取走即清,防重复弹)。
#[tauri::command]
#[cfg(feature = "gui")]
fn take_pending_auth_uri() -> Option<String> {
    PENDING_AUTH_URI.lock().unwrap().take()
}

/// 确认登录后回调 youling(Rust 侧 POST,绕开 webview CORS):
/// body={ticket, token(=identity-svc 会话 token)}；youling 拿 token 去
/// identity-svc 换 did,成则 ticket→CONFIRMED,网页轮询侧完成登录。
///
/// 防钓鱼(spec login-design §2 通道②安全件):回调与 identity 端点均限白名单域。
/// 任意网站可构造 myco://auth 深链接——白名单外的 callback 一律拒绝,
/// 防止会话 token 被 POST 到钓鱼服务器。
///
/// 可配置：环境变量 `MYCO_DID_BASE`（如 https://myco.youling.cc/myco-id 或 http://myco.youling.cc:8321）
/// 设置后其主机名自动加入白名单——切域名时设环境变量即可，代码不用改。
fn get_allowed_hosts() -> Vec<String> {
    let mut hosts: Vec<String> = vec![
        "youling.cc".into(),
        "www.youling.cc".into(),
        // 域名收口（第90轮）：生产固定域名显式入白名单
        "myco.youling.cc".into(),
        // 身份服务专属域（did 激活日 2026-09-30 A5）：二维码 svc=https://did.youling.cc
        "did.youling.cc".into(),
        "localhost".into(),
        "127.0.0.1".into(),
        // 安全白名单双 IP（过渡期 vnext 活到 9/29，平台 callback 可能从任一 IP 来）
        "myco.youling.cc".into(),
    ];
    // 从环境变量 MYCO_DID_BASE 推导（未设时默认生产域名）
    let base =
        std::env::var("MYCO_DID_BASE").unwrap_or_else(|_| "https://myco.youling.cc/myco-id".into());
    if let Ok(u) = url::Url::parse(&base) {
        if let Some(h) = u.host_str() {
            let h = h.to_string();
            if !hosts.contains(&h) {
                hosts.push(h);
            }
        }
    }
    hosts
}

pub fn auth_host_allowed(url: &str) -> bool {
    let hosts = get_allowed_hosts();
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    match u.host_str() {
        Some(h) => {
            // 泛域匹配（2026-10-02 第三次踩坑后根修：dev.youling.cc 又被拦——精确名单
            // 逐个加追不上域名体系扩张）。youling.cc 本域或任意子域放行（DNS 泛解析+
            // 通配符证书体系下子域皆我方资产）；签名清单（B4）上线后由此接管。
            if h == "youling.cc" || (h.ends_with(".youling.cc") && h.len() > ".youling.cc".len()) {
                return true;
            }
            // 精确名单兜底（IP/localhost/环境变量推导）
            hosts.iter().any(|a| a == h)
        }
        None => false,
    }
}

/// CLI 通道（cli.rs 的 `auth` 组）复用网页登录三件套。
///
/// 为什么不直接把上面三个 `#[tauri::command]` 改成 `pub(crate)`：tauri 的命令宏会对
/// 可见性生成同名转发宏，`pub(crate) fn` 触发 `E0255 defined multiple times`（本机实测），
/// 因此保持命令私有，在这里加**只转发**的 crate 内包装（不复制任何逻辑）。
#[cfg(feature = "gui")]
pub(crate) async fn cli_auto_login_url(page_url: String) -> Result<String, String> {
    auto_login_url(page_url).await
}

#[cfg(feature = "gui")]
pub(crate) fn cli_youling_auth_callback(
    url: String,
    ticket: String,
    token: String,
) -> Result<serde_json::Value, String> {
    youling_auth_callback(url, ticket, token)
}

#[cfg(feature = "gui")]
pub(crate) fn cli_youling_auth_callback_sig(
    url: String,
    ticket: String,
    did: String,
    sig: String,
    delegation: Option<String>,
) -> Result<serde_json::Value, String> {
    youling_auth_callback_sig(url, ticket, did, sig, delegation, None, None)
}

#[tauri::command]
#[cfg(feature = "gui")]
fn youling_auth_callback(
    url: String,
    ticket: String,
    token: String,
) -> Result<serde_json::Value, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("仅支持 http(s) 回调地址".into());
    }
    if !auth_host_allowed(&url) {
        return Err(format!("拒绝非白名单回调地址: {url}"));
    }
    let resp = ureq::post(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send_json(ureq::json!({ "ticket": ticket, "token": token }));
    let resp = match resp {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            // 非 2xx：读出 body 里的业务错误（如"会话无效或已过期"），别吞成裸状态码
            let detail = r.into_string().unwrap_or_default();
            let msg = serde_json::from_str::<serde_json::Value>(&detail)
                .ok()
                .and_then(|j| j["error"].as_str().map(String::from))
                .unwrap_or_else(|| format!("HTTP {code}"));
            return Err(msg);
        }
        Err(e) => return Err(format!("回调失败: {e}")),
    };
    let body: serde_json::Value = resp.into_json().map_err(|e| format!("响应解析失败: {e}"))?;
    if body["ok"].as_bool().unwrap_or(false) {
        Ok(body)
    } else {
        Err(body["error"]
            .as_str()
            .unwrap_or("youling 拒绝了登录")
            .to_string())
    }
}

/// 签名模式回调(第21轮):前端 wallet_sign 拿到 {did,sig} 后直接 POST
/// {ticket,did,sig}——与手机 PWA 确认登录同协议;白名单校验与 token 模式一致。
/// delegation(第29轮,spec login-design §7.2):分身设备(无根钥)可选携带
///委任状 JSON 随行,平台验链后落账 accountDid。
/// A1(2026-09-30):session_pubkey+session_delegation 可选——登录确认顺带签发的
///「提交面会话钥」委任状,平台确认成功后注册(浏览器做题提交签名验签用);
///缺省=老前端/老链路,行为不变。
#[tauri::command]
#[cfg(feature = "gui")]
fn youling_auth_callback_sig(
    url: String,
    ticket: String,
    did: String,
    sig: String,
    delegation: Option<String>,
    session_pubkey: Option<String>,
    session_delegation: Option<String>,
) -> Result<serde_json::Value, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("仅支持 http(s) 回调地址".into());
    }
    if !auth_host_allowed(&url) {
        return Err(format!("拒绝非白名单回调地址: {url}"));
    }
    let mut body = ureq::json!({ "ticket": ticket, "did": did, "sig": sig });
    if let Some(d) = delegation.filter(|s| !s.is_empty()) {
        body["delegation"] = serde_json::Value::String(d);
    }
    if let (Some(pk), Some(sd)) = (
        session_pubkey.filter(|s| !s.is_empty()),
        session_delegation.filter(|s| !s.is_empty()),
    ) {
        body["sessionPubkey"] = serde_json::Value::String(pk);
        body["sessionDelegation"] = serde_json::Value::String(sd);
    }
    let resp = ureq::post(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send_json(body);
    let resp = match resp {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            let detail = r.into_string().unwrap_or_default();
            let msg = serde_json::from_str::<serde_json::Value>(&detail)
                .ok()
                .and_then(|j| j["error"].as_str().map(String::from))
                .unwrap_or_else(|| format!("HTTP {code}"));
            return Err(msg);
        }
        Err(e) => return Err(format!("回调失败: {e}")),
    };
    let body: serde_json::Value = resp.into_json().map_err(|e| format!("响应解析失败: {e}"))?;
    if body["ok"].as_bool().unwrap_or(false) {
        Ok(body)
    } else {
        Err(body["error"]
            .as_str()
            .unwrap_or("youling 拒绝了登录")
            .to_string())
    }
}

/// 读更新进度 → update.rs(轮询兜底;主通道=update-progress 事件)。

/// 打开外部链接(探索有灵→youling.cc 等)。仅 http(s),防 myco:// 递归唤起。
#[tauri::command]
#[cfg(feature = "gui")]
fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("仅支持 http(s) 链接".into());
    }
    #[cfg(windows)]
    {
        // 第73轮修闪终端：cmd /C start 必须带 CREATE_NO_WINDOW——否则每次点链接
        // cmd.exe 控制台闪一下（用户实测"探索有灵弹一下终端"）。
        use std::os::windows::process::CommandExt as _;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 第92轮:出票节流缓存(10 分钟窗口,键=账号 did;切号自然失效)。
struct CachedAutoLoginTicket {
    did: String,
    ticket: String,
    at: std::time::Instant,
}
static AUTO_LOGIN_TICKET: std::sync::Mutex<Option<CachedAutoLoginTicket>> =
    std::sync::Mutex::new(None);

/// 「探索」自动登录的平台回调体组装（**纯函数**，单测直击；不随 gui feature 门控）。
///
/// 两态（2026-10-12 修「分身点探索打开网页不登录」）：
///  ① 账号钥签名可用（本体设备）→ `{ticket, did, sig}`（原行为不变）
///  ② 账号钥不可用（分身设备，`cached_account_seed()`=None）→ 惰性尝试**设备钥签名 +
///     委任状随行** → `{ticket, did, sig, delegation}`（平台 verifyDelegatedSignature 验链）
///  ③ 两态皆不可用 → Err（调用方降级返回裸 URL，绝不发半成品回调）
///
/// 修因：原实现只有 ①，分身设备上 `signed()` 必 Err ⇒ 闭包整体 Err ⇒ 降级裸 URL ⇒
/// 浏览器打开不登录（用户实测）。与 2026-10-11 网页登录「只认根钥」属同一根因家族。
/// `delegated_sign` 传闭包=**惰性**：根钥可用时不触碰设备钥/委任状读取。
pub(crate) fn auto_login_callback_body<F>(
    ticket: &str,
    root_sign: Result<(String, String), String>,
    delegated_sign: F,
) -> Result<serde_json::Value, String>
where
    F: FnOnce() -> Result<(String, String, serde_json::Value), String>,
{
    match root_sign {
        Ok((did, sig)) => Ok(serde_json::json!({ "ticket": ticket, "did": did, "sig": sig })),
        Err(root_err) => match delegated_sign() {
            Ok((did, sig, delegation)) => Ok(serde_json::json!({
                "ticket": ticket, "did": did, "sig": sig,
                // 平台 MycoCallbackRequest.delegation 是 JSON **字符串**（与网页端
                // JSON.stringify(dj.delegation) 同形）
                "delegation": delegation.to_string(),
            })),
            Err(deleg_err) => Err(format!("{root_err}; 分身签名亦不可用: {deleg_err}")),
        },
    }
}

/// B1 反向自动登录(第19轮):「去探索」跳平台前,本机完成一次完整的 DID 登录
/// (platform 出票 → 本机账号钥签名 → POST callback),把已确认的 ticket
/// 以 ?autologin=<ticket> 附到目标 URL——平台前端轮询到 confirmed 直接落会话,
/// 用户在浏览器里免扫码免点击。
/// 失败静默返回原 URL(未建账号/网络不通 → 平台落登录页走扫码,零损失)。
/// 第63轮 env 合并追修(2026-09-24,A11 排查「探索打开未登录」根因):原实现向
/// env 独立进程的 :3102 HTTP API 调 wallet_sign/wallet_ensure_root——单进程化后
/// 该端口无人监听(前端同源调用点已在第63轮补丁改 invoke,此处漏网),签名必败→
/// 静默降级裸 URL→浏览器永远未登录。改进程内签名(同 identity_service::wallet_sign)
/// +ensure 直连 identity-svc /root/create(不再经 env 转发)。
/// 第92轮会话复用+节流(2026-09-28,内测互踢事故):此前每次「去探索」都完整走一遍
/// 出票→签名→callback=平台同 did 重新登录→单点 token 轮换踢掉浏览器旧会话
/// (内测用户 18:05-18:23 被循环踢 9 次)。修:票按账号 did 缓存 10 分钟——窗口内
/// 重复点击直接复用旧票拼 URL,不再出票不再 callback,不触发平台重登;切号=did
/// 缓存键不同自然失效。出票失败降级:同账号旧票(即使已过窗,平台侧票死则落扫码
/// 页,零损失)→无旧票则原样返回 page_url(保留原兜底)。
#[tauri::command]
#[cfg(feature = "gui")]
async fn auto_login_url(page_url: String) -> Result<String, String> {
    use base64::Engine as _;
    use ed25519_dalek::Signer as _;
    // 2026-10-08 设计定稿：平台页基址改 www（HBL 平台真身在 www.youling.cc；
    // myco.youling.cc 是登录器服务域——身份服务/下载面仍在 myco 域）。
    const PLATFORM: &str = "https://www.youling.cc";
    // identity-svc 走域名代理（第90轮域名收口：/myco-id/ → 8321，此处沿用它做注册保障直连）
    const IDENTITY_SVC: &str = "https://myco.youling.cc/myco-id";
    const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
    let http = |method: &str,
                url: String,
                body: Option<serde_json::Value>|
     -> Result<serde_json::Value, String> {
        let mut cmd = ureq::request(method, &url).timeout(std::time::Duration::from_secs(10));
        if let Some(b) = &body {
            cmd = cmd.set("Content-Type", "application/json");
            let resp = cmd.send_string(&b.to_string()).map_err(|e| e.to_string())?;
            return resp
                .into_json::<serde_json::Value>()
                .map_err(|e| e.to_string());
        }
        cmd.call()
            .map_err(|e| e.to_string())?
            .into_json()
            .map_err(|e| e.to_string())
    };
    // 进程内账号钥签名(第63轮 env 合并移入;同 identity_service::wallet_sign)
    let signed = |ticket: &str| -> Result<(String, String), String> {
        let seed =
            myco_core::identity::cached_account_seed().ok_or("本机未持有账号钥（或已锁定）")?;
        let sig = B64.encode(
            ed25519_dalek::SigningKey::from_bytes(&seed)
                .sign(format!("myco-auth\n{ticket}").as_bytes())
                .to_bytes(),
        );
        let did = myco_core::identity::account_did().ok_or("DID 派生失败")?;
        Ok((did, sig))
    };
    // 注册保障(第21轮):老账号名册可能缺于 vnext——补登记(幂等 201/409,失败不阻断)。
    // 协议同 env 版 wallet_ensure_root:账号钥签 "create\n{did}\n{rootPub}" POST /root/create。
    let ensure_root = || async {
        let Some(seed) = myco_core::identity::cached_account_seed() else {
            return Err("no seed".to_string());
        };
        let sk = ed25519_dalek::SigningKey::from_bytes(&seed);
        let root_pub_b64 = B64.encode(sk.verifying_key().to_bytes());
        let did = myco_core::identity::account_did().ok_or("DID 派生失败")?;
        let root_sig = B64.encode(
            sk.sign(format!("create\n{did}\n{root_pub_b64}").as_bytes())
                .to_bytes(),
        );
        let device_pub_b64 = myco_core::identity::device_identity()
            .and_then(|(dev_did, _)| myco_core::identity::device_pubkey_from_did_or_b64(&dev_did))
            .map_err(|_| "设备公钥派生失败".to_string())?;
        let name = myco_core::identity::account_name()
            .await
            .unwrap_or_else(|| "有灵账号".into());
        let resp = ureq::post(&format!("{IDENTITY_SVC}/root/create"))
            .timeout(std::time::Duration::from_secs(10))
            .send_json(ureq::json!({
                "rootDid": did, "rootPubkeyB64": root_pub_b64,
                "devicePubkeyB64": device_pub_b64,
                "name": name,
                "deviceName": std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Myco-PC".into()),
                "rootSig": root_sig, "phone": "", "email": "",
            }))
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if status != 201 && status != 409 {
            return Err(format!("root/create status={status}"));
        }
        Ok(())
    };
    // 票拼目标 URL:?autologin= 追加(目标页已含 ? 则用 &;不同 page_url 复用同一张票)。
    let with_ticket = |page_url: &str, ticket: &str| -> String {
        let sep = if page_url.contains('?') { '&' } else { '?' };
        format!("{page_url}{sep}autologin={ticket}")
    };
    // 账号身份=节流缓存键(未登录/未建号 → 原样返回,同旧兜底,不缓存)
    let Some(did_now) = myco_core::identity::account_did() else {
        return Ok(page_url);
    };
    // ① 10 分钟窗口内同账号 → 复用旧票拼 URL:不出票、不签名、不 callback,
    //    不触发平台重登(互踢根因=每次完整走一遍 DID 登录舞步)。
    if let Some(c) = AUTO_LOGIN_TICKET.lock().unwrap().as_ref() {
        if c.did == did_now && c.at.elapsed().as_secs() < 600 {
            return Ok(with_ticket(&page_url, &c.ticket));
        }
    }
    // ensure 与 ticket 无依赖,先行尽力补名册(失败不阻断,同原语义;复用路径已跳过)
    let _ = ensure_root().await;
    let url = match (|| -> Result<String, String> {
        let t = http(
            "POST",
            format!("{PLATFORM}/api/v1/auth/qr-tickets"),
            Some(serde_json::json!({ "provider": "myco" })),
        )?;
        let ticket = t["data"]["ticketId"]
            .as_str()
            .ok_or("no ticketId")?
            .to_string();
        // 签名两态（2026-10-12 修「分身点探索不登录」）：本体走账号钥；分身设备本机
        // 无账号根钥 → 设备钥签 + 委任状随行（平台验链落账 accountDid）。组装逻辑抽
        // 纯函数 auto_login_callback_body 便于单测直击（见文件末 auto_login_body_tests）。
        let cb_body = auto_login_callback_body(&ticket, signed(&ticket), || {
            crate::identity_service::delegated_sign_parts(&format!("myco-auth\n{ticket}"))
        })?;
        http(
            "POST",
            format!("{PLATFORM}/api/v1/auth/myco/callback"),
            Some(cb_body),
        )?;
        Ok(ticket)
    })() {
        Ok(ticket) => {
            // 出票+确认成功 → 记入节流缓存(下次 10 分钟内直接复用)
            *AUTO_LOGIN_TICKET.lock().unwrap() = Some(CachedAutoLoginTicket {
                did: did_now,
                at: std::time::Instant::now(),
                ticket: ticket.clone(),
            });
            with_ticket(&page_url, &ticket)
        }
        Err(_) => {
            // 出票失败降级:同账号旧票优先(即使已过窗——平台侧票死则落扫码页,零损失;
            // 他人旧票/did 不符绝不用=防串号)→无旧票原样返回 page_url(原兜底)。
            AUTO_LOGIN_TICKET
                .lock()
                .unwrap()
                .as_ref()
                .filter(|c| c.did == did_now)
                .map(|c| with_ticket(&page_url, &c.ticket))
                .unwrap_or(page_url)
        }
    };
    Ok(url)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg(feature = "gui")]
pub fn run() {
    crate::startup_trace::mark("run-enter");
    tauri::Builder::default()
        // 单实例：网页深链接二次唤起时,把 argv 转给已在跑的实例(emit 给前端)
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(uri) = extract_myco_uri(argv) {
                // 线程纪律(第21轮沙箱实测):single_instance 回调在独立线程——窗口原生操作
                // (show/set_focus)必须回主线程执行,否则 WebView 合成层被破坏=热唤起白屏。
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || {
                    dispatch_myco_uri(&app2, uri);
                });
            }
        }))
        // 批三：系统通知（聊天消息窗口外可达；权限见 capabilities/default.json）
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            usage_week_by_project,
            prod_update_info,
            kill_member,
            get_build_info,
            take_pending_auth_uri,
            take_pending_chat_did,
            youling_auth_callback,
            youling_auth_callback_sig,
            open_external,
            auto_login_url,
            autostart_get,
            autostart_set,
            spawn_diag,
            autohide_set,
            autohide_peek,
            close_behavior_get,
            close_behavior_set,
            identity_service::identity_get,
            identity_service::myco_get,
            identity_service::myco_list_devices,
            identity_service::invite_start,
            identity_service::invite_stop,
            identity_service::pair_requests,
            identity_service::confirm_device,
            identity_service::reject_device,
            identity_service::pair_request_dismiss,
            identity_service::identity_register_login,
            identity_service::myco_set_backed_up,
            identity_service::myco_status,
            identity_service::myco_unlock,
            identity_service::myco_set_password,
            identity_service::myco_remove_password,
            identity_service::myco_create,
            identity_service::myco_create_force,
            identity_service::myco_export_seed,
            identity_service::myco_import,
            identity_service::myco_logout,
            identity_service::myco_unbind,
            identity_service::myco_device_logout,
            identity_service::myco_rename,
            identity_service::myco_accounts,
            identity_service::myco_discover_accounts,
            identity_service::myco_switch_account,
            identity_service::add_device_by_did,
            identity_service::device_revoke,
            identity_service::delegation_list,
            identity_service::delegation_revoke,
            identity_service::delegation_status,
            identity_service::delegation_status_by_device,
            identity_service::list_authorized_devices,
            identity_service::list_trusted_roots,
            identity_service::resolve_myco_names,
            identity_service::rename_trusted_root,
            identity_service::set_root_note,
            identity_service::set_device_scopes,
            identity_service::set_device_auth,
            identity_service::revoke_origin,
            identity_service::rename_authorized_device,
            identity_service::remove_authorized_device,
            identity_service::revoke_roster_device,
            identity_service::wallet_sign,
            identity_service::wallet_sign_delegated,
            identity_service::session_delegation_sign,
            identity_service::session_key_status,
            identity_service::session_key_clear,
            chat_service::chat_state,
            chat_service::chat_ui_trace,
            chat_service::chat_warm_route,
            chat_service::chat_remove_friend,
            chat_service::chat_send,
            chat_service::chat_send_group,
            chat_service::chat_open_file,
            chat_service::chat_poll,
            chat_service::chat_load_conv,
            chat_service::chat_add_friend,
            chat_service::chat_accept_friend,
            chat_service::chat_ignore_friend,
            chat_service::chat_create_group,
            chat_service::chat_share_task,
            chat_service::chat_accept_task,
            chat_service::chat_set_task_status,
            chat_service::chat_rename_task,
            chat_service::chat_presence,
            chat_service::chat_typing,
            chat_service::chat_device_group_info,
            chat_service::chat_sync_now,
            chat_service::chat_group_invite,
            chat_service::chat_group_rename,
            chat_service::chat_group_leave,
            chat_service::chat_group_kick,
            chat_service::chat_group_mute,
            chat_service::chat_retry_msg,
            chat_service::chat_recall_msg,
            chat_service::chat_delete_conv,
            chat_service::chat_delete_msg,
            update::update_check_per_exe,
            update::run_prod_update,
            update::update_progress,
            youling_tasks::youling_tasks_list,
            youling_tasks::youling_my_resume,
            dsh_share::share_ensure_group,
            dsh_share::share_task_group,
            dsh_share::share_revoke,
            dsh_share::share_grants,
            dsh_share::share_grant_caps,
            dsh_share::share_revoke_all_grants,
            dsh_share::share_create_env_card,
            dsh_share::share_grant,
            dsh_share::share_visibility,
            dsh_share::share_set_visibility,
            dsh_share::share_reshare_requests,
            dsh_share::share_reshare_decide,
            dsh_share::share_set_can_reshare,
            dsh_share::vnet_rdp_open,
            dsh_share::vnet_rdp_status,
            vnet_env::vnet_env_open
        ])
        .setup(|app| {
            crate::startup_trace::mark("setup-enter");
            register_myco_protocol();
            crate::startup_trace::mark("protocol-registered");
            // ═══ 2026-10-15 启动提速（用户目标：myco 重启 → 页面 3s 内重连）═══
            // 实测分段：proc→mgmt ≈2.3s 的元凶是**配置窗口在 setup 之前初始化 WebView**，
            // 把下面的服务器全挡在后面。改法：窗口清出配置（windows:[]）、此处**先起
            // 基础设施**（隧道恢复 + 管理面 + 公网网关），窗口挪到 setup 尾部手动创建。
            // 页面重连只依赖这三个服务，与 UI 无关——它们现在领先 WebView ~2s 起跑。
            // ⚠️ setup 是同步上下文，必须走 tauri 的 async runtime（裸 tokio::spawn
            // 会 panic——new7 实测启动即崩）。
            // 2026-11-10：clean-proxy/app-listener 与 p2p_tunnel 的 WS 恢复均已退役，
            // 启动时没有需要恢复的监听器（持久化隧道恢复归 vnet keeper）；
            // 原先只为打点而存在的空 spawn 一并删除。
            crate::startup_trace::mark("spawned-restore");
            tauri::async_runtime::spawn(async move {
                crate::dsh_share::start_local_api().await;
            });
            crate::startup_trace::mark("spawned-mgmt");
            tauri::async_runtime::spawn(async move {
                crate::dsh_share::start_public_gateway().await;
            });
            crate::startup_trace::mark("spawned-gw");
            // 第64轮：登录器在线登记（env 合并时 presence 心跳丢失的回归修复）。
            // 第84轮：+state（灯）+addrs/p2pPort（P2P 直连寻址），20s 心跳。
            crate::presence::start();
            crate::startup_trace::mark("presence-started");
            // 2026-10-12：本机注册为云端中继 provider（SESSION→ACCEPT→泵到本地隧道
            // 面）——笔记本 remoteOpen 的中继腿、聊天跨网投递都依赖它。
            // 2026-10-15 删（这是裸调 async fn——future 直接被丢弃，从未真正运行；
            // 真正的注册由 p2p_client::start_sync_loop → p2p_tunnel::relay_provider_start()
            // 幂等拉起。别在这里再起一个：双 provider 同 did 互踢=30s 断连风暴，
            // 见 start_public_gateway 里的 2026-10-15 注释）。
            // 2026-10-06 任务2：DID 互换收编 被收编端轮询环——反查名册发现自己
            // 被收编 → 取委任状落盘 → 账号抽屉 role=agent + 系统通知。
            identity_service::start_delegation_watch(app.handle().clone());
            // 2026-10-11 委任状自动续约巡检环：本体侧巡签（到期/过期宽限重签+投递、
            // 响应分身 renew 请求）+ 分身侧到期投续约请求——启动即一轮，之后
            // 30min 自适应（分身进入续约窗口 → 5min）。
            crate::delegation_renewal::start_renewal_patrol();
            // 设备群挂点③（设备群设计 决策B）：启动即 ensure（已登录场景；未登录
            // 幂等无操作，后续 state_snapshot/watch_tick 挂点接管）。
            let _ = chat_service::ensure_device_group();
            crate::startup_trace::mark("device-group-ensured");
            // 第84轮：P2P 直连服务器（收消息/对账端点/typing）+ 对账后台循环。
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    crate::p2p_server::start_p2p_server(handle).await;
                });
                let handle2 = app.handle().clone();
                *crate::p2p_client::APP_HANDLE.lock().unwrap() = Some(handle2);
                crate::p2p_client::start_sync_loop();
            }
            crate::startup_trace::mark("spawned-p2p-server");
            // ═══ 2026-11-05 vnet 新传输层服务端（MYCO_TUNNEL_TRANSPORT=vnet 时启动）═══
            // 2026-11-05：按隧道端口白名单**全量**起——只起 13911/3389 时，其余白名单
            // 端口（22/9100/8787/…）对端没有 vnet server，vnet 客户端建链"成功"但数据
            // 黑洞，只能等探活失败回落 legacy（回归实测 PC:9100 即此）。
            // 与旧 p2p_server 并行运行（不同传输层互不干扰），由环境变量切换。
            if crate::vnet_forward::transport_mode() == crate::vnet_forward::TransportMode::Vnet {
                crate::vnet_forward::start_vnet_servers_for_allowed();
                crate::startup_trace::mark("vnet-server-started");
            }
            // ═══ 2026-10-22 关键后台环**必须放在窗口创建之前** ═══
            // 教训（真案）：锁屏/无交互桌面时 WebView2 窗口创建失败 → 下面的 headless
            // 分支 `return Ok(())` 会**跳过窗口之后的一切**——于是"锁屏的笔记本上
            // vnet 持久化转发守护没跑、mDNS 发现没注册、信箱快轮询没启动"。
            // 这些都与 UI 无关，属于远程可用性的地基，必须在 headless 早退之前装配。
            chat_service::start_fast_poll_loop();
            crate::startup_trace::mark("fast-poll-started");
            // T201 Step 5：消息库启动引导（MYCO_MSG_STORE=off 时什么都不做；
            // 迁移放后台线程——大账号可能耗时，绝不阻塞启动/窗口创建）。
            if msg_store::mode().writes() {
                std::thread::spawn(|| {
                    let log = msg_store::bootstrap_active_account();
                    eprintln!("[msg-store] {log}");
                });
            }
            chat_service::start_outbox_retry_loop();
            #[cfg(feature = "gui")]
            vnet_lease::start_vnet_keeper();
            crate::startup_trace::mark("keeper-started");
            std::thread::spawn(|| {
                for _ in 0..60 {
                    let port = crate::p2p_server::p2p_port();
                    if port > 0 {
                        crate::mdns_lan::start(port);
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
                crate::mdns_lan::start(0);
            });
            crate::startup_trace::mark("mdns-thread-spawned");
            // 冷启动：本进程就是被深链接拉起的(argv[1]=myco://...)——入 PENDING,
            // 前端挂载后 take_pending_auth_uri / take_pending_chat_did 取走
            // (解决 emit 早于 webview 就绪的竞态)。myco://chat 走好友对话面。
            if let Some(uri) = extract_myco_uri(std::env::args().skip(1)) {
                if let Some((did, label)) = parse_chat_uri(&uri) {
                    PENDING_CHAT_DID.lock().unwrap().replace((did, label));
                } else {
                    PENDING_AUTH_URI.lock().unwrap().replace(uri);
                }
            }
            let handle = app.handle().clone();
            let app_handle = handle.clone();
            std::thread::spawn(move || {
                ui_embed_server::spawn(
                    handle,
                    PORT,
                    ui_embed_server::UiAgentManifest {
                        did: DID,
                        layer: "PA",
                        consumes: CONSUMES,
                        produces: PRODUCES,
                        demand: (280, 360, 640, 400),
                    },
                );
            });
            // 互联服务附着(C 方案 2026-09-03,去中心定稿):myco-env.exe = 无头 ENV 主机
            // (:3002 API/webrtc answerer/采集/AOP 运行时),独立进程常驻——myco 薄壳
            // 只负责"不在就拉起",不链接重栈(构建 1-2min,exe ~11MB)。探测失败不
            // 阻断驾驶舱;aop 等成员按双模式传感器各自降级本地。
            // [第63轮 env合并停用]             std::thread::spawn(|| {
            // [第63轮 env合并停用]                 #[cfg(windows)]
            // [第63轮 env合并停用]                 use std::os::windows::process::CommandExt;
            // [第63轮 env合并停用]                 let probe = || {
            // [第63轮 env合并停用]                     // 探测端口跟随 env(dev 栈偏移 13002+,不能探到生产 :3002 误判"已在服务"
            // [第63轮 env合并停用]                     // 不拉 dev 实例——dev 永远起不来)
            // [第63轮 env合并停用]                     let port: u16 = std::env::var("ENV_HTTP_PORT")
            // [第63轮 env合并停用]                         .ok()
            // [第63轮 env合并停用]                         .and_then(|v| v.parse().ok())
            // [第63轮 env合并停用]                         .unwrap_or(3102);
            // [第63轮 env合并停用]                     std::net::TcpStream::connect_timeout(
            // [第63轮 env合并停用]                         &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            // [第63轮 env合并停用]                         std::time::Duration::from_millis(400),
            // [第63轮 env合并停用]                     ).is_ok()
            // [第63轮 env合并停用]                 };
            // [第63轮 env合并停用]                 let exe = std::env::current_exe().ok()
            // [第63轮 env合并停用]                     .and_then(|p| p.parent().map(|d| d.join("myco-env.exe")));
            // [第63轮 env合并停用]                 let Some(exe) = exe.filter(|p| p.is_file()) else {
            // [第63轮 env合并停用]                     eprintln!("[env-attach] myco-env.exe 不存在——互联模式不可用(成员将保持本地模式)");
            // [第63轮 env合并停用]                     return;
            // [第63轮 env合并停用]                 };
            // [第63轮 env合并停用]                 let mut cmd = std::process::Command::new(&exe);
            // [第63轮 env合并停用]                 if let Some(d) = exe.parent() { cmd.current_dir(d); }
            // [第63轮 env合并停用]                 // 生产环境变量对齐 start-myco.bat(DB 路径锚定 + 关 discovery 广播)
            // [第63轮 env合并停用]                 let db_default = exe.parent()
            // [第63轮 env合并停用]                     .map(|d| d.join("data").join("belief.db").to_string_lossy().into_owned())
            // [第63轮 env合并停用]                     .unwrap_or_default();
            // [第63轮 env合并停用]                 if std::env::var("DB_PATH").is_err() && !db_default.is_empty() {
            // [第63轮 env合并停用]                     cmd.env("DB_PATH", db_default);
            // [第63轮 env合并停用]                 }
            // [第63轮 env合并停用]                 if std::env::var("DISCOVERY_ADDR").is_err() { cmd.env("DISCOVERY_ADDR", "off"); }
            // [第63轮 env合并停用]                 // 第62轮：登录器场景禁用 env 退休——登录器需要 env 随时待命(网页确认回调)；
            // [第63轮 env合并停用]                 // WebView 最小化后 JS 定时器被节流→轮询停→env 30min 无活动退休→托盘幽灵
            // [第63轮 env合并停用]                 if std::env::var("MYCO_ENV_IDLE_EXIT_MS").is_err() {
            // [第63轮 env合并停用]                     cmd.env("MYCO_ENV_IDLE_EXIT_MS", "0");
            // [第63轮 env合并停用]                 }
            // [第63轮 env合并停用]                 #[cfg(windows)]
            // [第63轮 env合并停用]                 cmd.creation_flags(0x0000_0008); // DETACHED_PROCESS:与 myco 生命周期解耦
            // [第63轮 env合并停用]                 // 首轮快探测×3(启动体验不变):已在服务=纯附着
            // [第63轮 env合并停用]                 for _ in 0..3 {
            // [第63轮 env合并停用]                     if probe() { break; }
            // [第63轮 env合并停用]                     std::thread::sleep(std::time::Duration::from_secs(1));
            // [第63轮 env合并停用]                 }
            // [第63轮 env合并停用]                 // dev 栈(ENV_HTTP_PORT 有值)一次性附着即退,不常驻
            // [第63轮 env合并停用]                 if std::env::var("ENV_HTTP_PORT").is_ok() { return; }
            // [第63轮 env合并停用]                 // 不在服务→拉起
            // [第63轮 env合并停用]                 if !probe() {
            // [第63轮 env合并停用]                     match cmd.spawn() {
            // [第63轮 env合并停用]                         Ok(_) => eprintln!("[env-attach] 已拉起 {}", exe.display()),
            // [第63轮 env合并停用]                         Err(e) => eprintln!("[env-attach] 拉起失败: {e}"),
            // [第63轮 env合并停用]                     }
            // [第63轮 env合并停用]                 }
            // [第63轮 env合并停用]                 // 常驻监测(2026-09-03 根修):env 闲时退休后壳曾永不拉回——笔记本
            // [第63轮 env合并停用]                 // "连接中→未注册"的根因(身份/名册其实都好,只是查询链断了)。60s 一轮
            // [第63轮 env合并停用]                 // 探测,不在即拉回——env 有活就零动作。
            // [第63轮 env合并停用]                 loop {
            // [第63轮 env合并停用]                     std::thread::sleep(std::time::Duration::from_secs(60));
            // [第63轮 env合并停用]                     if !probe() {
            // [第63轮 env合并停用]                         // 第62轮：先查进程存在再拉——只查端口会在 env 启动慢/idle 时叠加 spawn
            // [第63轮 env合并停用]                         let env_alive = std::process::Command::new("tasklist")
            // [第63轮 env合并停用]                             .args(["/FI", "IMAGENAME eq myco-env.exe", "/FO", "CSV", "/NH"])
            // [第63轮 env合并停用]                             .creation_flags(0x0800_0000)
            // [第63轮 env合并停用]                             .output()
            // [第63轮 env合并停用]                             .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("myco-env"))
            // [第63轮 env合并停用]                             .unwrap_or(false);
            // [第63轮 env合并停用]                         if env_alive {
            // [第63轮 env合并停用]                             eprintln!("[env-attach] 端口不通但进程在——env 可能重启中，跳过 spawn");
            // [第63轮 env合并停用]                         } else {
            // [第63轮 env合并停用]                             eprintln!("[env-attach] env 进程不在——拉回");
            // [第63轮 env合并停用]                             let _ = cmd.spawn();
            // [第63轮 env合并停用]                         }
            // [第63轮 env合并停用]                     }
            // [第63轮 env合并停用]                 }
            // [第63轮 env合并停用]             });
            // ═══ 2026-10-15 手动建主窗（原配置窗口会挡住服务器启动 ~2s，已清出
            // tauri.conf.json——属性逐项照搬原 windows[0]，勿漏）═══
            // ═══ 2026-10-22 vnet 真案：锁屏时 WebView 建不出来 ═══
            // Windows 锁屏（或 RDP 断开会话）时 WebView2 报 "无效的窗口句柄"(0x80070578)
            // → 原来的 `?` 把错误传出去 → setup 失败 → 整个进程 PANIC 退出 →
            // **锁屏的电脑上 myco 完全不在线**（用户笔记本/PC 都踩过，DSH 卡全打不开，
            // 远程访问也无从谈起）。修复：窗口建不出来时**降级为 headless**——日志留痕、
            // 跳过所有 UI 装配（托盘/事件只影响界面），**服务继续跑**（隧道/管理面/网关/
            // presence 在窗口之前已启动）。这样才能做到"锁屏也能远程访问"。
            crate::startup_trace::mark("window-build-enter");
            let _main_window =
                match tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                    .title("myco")
                    .inner_size(320.0, 640.0)
                    .min_inner_size(300.0, 560.0)
                    .resizable(true)
                    .fullscreen(false)
                    .always_on_top(false)
                    .decorations(false)
                    .shadow(false)
                    .additional_browser_args(
                        "--remote-debugging-port=9224 --remote-allow-origins=*",
                    )
                    .build()
                {
                    Ok(w) => {
                        crate::startup_trace::mark("window-created");
                        w
                    }
                    Err(e) => {
                        crate::startup_trace::mark("window-failed-headless");
                        eprintln!(
                            "[gui] 主窗创建失败（锁屏/无交互桌面会话？）→ **进入 headless 模式**：\
                         隧道/管理面/公网网关/presence 继续运行，仅无界面。err={e}"
                        );
                        // 不返回错误：setup 成功、事件循环继续跑，服务不中断。
                        return Ok(());
                    }
                };
            // 锚点自报常驻线程:即时一次,失败 3s 快重试(env 未起),成功后 15s 周期重报
            // (canvas 后重启内存锚点丢失 → 周期重报补回;canvas 侧矩形有变化即自动整队重排)。
            if let Some(win) = app.get_webview_window("main") {
                let win2 = win.clone();
                std::thread::spawn(move || {
                    let mut ok = report_anchor_rect(&win2);
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(if ok { 15 } else { 3 }));
                        ok = report_anchor_rect(&win2);
                    }
                });
            }
            // 长机职责:本窗移动(settle 语义)→ 通知 env 整队重排。
            let Some(win) = app.get_webview_window("main") else {
                return Ok(());
            };
            // 2026-10-18 fast-ack：前台标记初值（窗口焦点事件在下方维护）——聊天信箱
            // 快轮询（前台 1.5s/后台 5s）与待发补发环（前台 3s 起/后台 60s）的节奏源。
            chat_service::set_app_foreground(win.is_focused().unwrap_or(true));
            // 2026-10-18 关闭→托盘（微信式常驻）：装配托盘（图标/菜单/左键唤出）。
            setup_tray(app);
            let win_for_close = win.clone();
            win.on_window_event(move |ev: &tauri::WindowEvent| {
                // 2026-10-18 关闭→托盘：CloseRequested 按设置分流——默认**进托盘**
                // （进程常驻，P2P/聊天/分享网关继续服务）；「退出应用」=不拦截，真关闭
                // （原行为）。最小化不是选项（设计定稿：要最小化点最小化按钮）。
                if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                    if close_behavior_current() == "quit" {
                        // 不 prevent_close → 窗口正常关闭 → 应用退出（原行为）
                        return;
                    }
                    api.prevent_close();
                    let _ = win_for_close.hide();
                    return;
                }
                // 2026-10-18 fast-ack：焦点变化 → 前台/后台节奏切换（不参与下面的
                // 吸附/重排逻辑，直接返回）。
                if let tauri::WindowEvent::Focused(f) = ev {
                    crate::chat_service::set_app_foreground(*f);
                    return;
                }
                // Moved=链原点变了;Resized=home 宽度投票(D6:home 纳入需求分配,用户拖宽即学)
                if !matches!(
                    ev,
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
                ) {
                    return;
                }
                let now = std::time::Instant::now();
                if now_ms().saturating_sub(LAST_NOTIFY.load(Ordering::Relaxed)) < 150 {
                    return;
                }
                LAST_NOTIFY.store(now_ms(), Ordering::Relaxed);
                SETTLE_AT
                    .lock()
                    .unwrap()
                    .replace(now + std::time::Duration::from_millis(180));
                let app3 = app_handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(210));
                    let due = *SETTLE_AT.lock().unwrap();
                    if let Some(d) = due {
                        if std::time::Instant::now() >= d {
                            // 最小化的 Moved(去停泊位)不是用户拖动,不报不重排
                            if let Some(w2) = app3.get_webview_window("main") {
                                if w2.is_minimized().unwrap_or(false) {
                                    return;
                                }
                            }
                            // 先自报新矩形,再通知重排
                            if let Some(w2) = app3.get_webview_window("main") {
                                report_anchor_rect(&w2);
                            }
                            let _ = ureq::post(&format!("{ENV_API}/api/formation/anchor_moved"))
                                .timeout(std::time::Duration::from_secs(1))
                                .call();
                        }
                    }
                });
            });
            // 2026-10-22：fast-poll / outbox-retry / vnet-keeper 已前移到窗口创建之前
            // （headless 分支会跳过窗口之后的一切；见上面「同族修复」注释）。
            crate::startup_trace::mark("setup-exit");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running myco-home");
}

#[cfg(test)]
mod auth_tests {
    use super::auth_host_allowed;

    #[test]
    fn whitelist_accepts_known_hosts() {
        for u in [
            "http://youling.cc/api/v1/auth/myco/callback",
            "https://www.youling.cc/x",
            // 第90轮域名收口：生产域名入白名单
            "https://myco.youling.cc/x",
            "https://myco.youling.cc/myco-id/presence/list",
            // did 激活日 2026-09-30（A5）：身份服务专属域（QR svc=https://did.youling.cc）
            "https://did.youling.cc/identity/challenge",
            "https://did.youling.cc:8321/identity/verify",
            // 过渡期：旧 IP 条目仍在白名单（callback 可能从 IP 来）
            "http://myco.youling.cc/api/v1/auth/myco/callback",
            "http://localhost:8080/x",
            "http://127.0.0.1:8321/x",
        ] {
            assert!(auth_host_allowed(u), "should allow: {u}");
        }
    }

    #[test]
    fn whitelist_rejects_unknown_and_malformed() {
        for u in [
            "http://evil.phish.com/api",
            "https://youling.cc.evil.com/", // 后缀仿冒
            "http://not-youling.cc/",
            "ftp://youling.cc/", // 非 http(s) 之外先被前缀挡，url 解析 ok 但 scheme 无关——host 相同！观察
            "",
            "not a url",
        ] {
            // ftp://youling.cc 的 host 是 youling.cc——host 白名单只看 host，scheme 检查在 youling_auth_callback 前置
            if u.starts_with("ftp://") {
                continue;
            }
            assert!(!auth_host_allowed(u), "should reject: {u}");
        }
    }

    #[test]
    fn port_variants() {
        assert!(auth_host_allowed("http://myco.youling.cc:9999/x")); // 端口不限（host 匹配即可）
        assert!(!auth_host_allowed("http://vnext.myco.youling.cc.evil.com/"));
    }
}
// ── 「探索」自动登录两态组装单测（2026-10-12 分身点探索不登录修复）────────────
#[cfg(test)]
mod auto_login_body_tests {
    use super::auto_login_callback_body;

    fn delegation_json() -> serde_json::Value {
        serde_json::json!({
            "accountDid": "did:youling:z6MkACCT",
            "devicePubkeyB64": "DEVKEY",
            "deviceName": "笔记本",
            "scopes": "*",
            "issuedAt": 1,
            "exp": 2,
            "nonce": "n1",
            "sigB64": "SIG",
        })
    }

    #[test]
    fn root_key_path_unchanged_no_delegation_field() {
        let body = auto_login_callback_body(
            "tk1",
            Ok(("did:youling:z6MkACCT".into(), "ROOTSIG".into())),
            || panic!("根钥可用时不得触碰分身路径（惰性契约）"),
        )
        .expect("根钥可用应成功");
        assert_eq!(body["ticket"], "tk1");
        assert_eq!(body["sig"], "ROOTSIG");
        assert!(
            body.get("delegation").is_none(),
            "本体路径不应带 delegation"
        );
    }

    #[test]
    fn member_device_path_attaches_delegation_string() {
        let body = auto_login_callback_body(
            "tk2",
            Err("本机未持有账号钥（或已锁定）".into()),
            || {
                Ok((
                    "did:myco:z6MkDEV".into(),
                    "DEVSIG".into(),
                    delegation_json(),
                ))
            },
        )
        .expect("分身路径应成功");
        assert_eq!(body["did"], "did:myco:z6MkDEV");
        assert_eq!(body["sig"], "DEVSIG");
        // 平台契约：delegation 必须是 JSON **字符串**（不是嵌套对象）
        let d = body["delegation"].as_str().expect("delegation 应为字符串");
        assert!(d.contains("did:youling:z6MkACCT"), "委任状内容应随行: {d}");
        assert!(d.contains("\"sigB64\""), "委任状须含签名供平台验链: {d}");
    }

    #[test]
    fn both_paths_fail_returns_err_not_partial_body() {
        let e = auto_login_callback_body(
            "tk3",
            Err("本机未持有账号钥（或已锁定）".into()),
            || Err("本机无有效设备授权（请在主设备上重新授权本设备）".into()),
        )
        .expect_err("两态皆不可用必须 Err（调用方降级裸 URL，不发半成品回调）");
        assert!(e.contains("未持有账号钥"), "应保留根钥失败原文: {e}");
        assert!(e.contains("重新授权"), "应保留分身失败原文: {e}");
    }
}
