//! vnet C FFI —— 嵌入式集成面（APK/JNI、宿主进程等）
//!
//! 设计原则（与 DSH协议应用 2026-11-05 协调定版）：
//! - FFI 只管**生命周期**（init/start/stop/status/候选注入），数据面走本地
//!   TCP 回环（上层连 127.0.0.1:local_port），与 PC 完全同构——不做 JNI 数据泵。
//! - 线程安全：句柄存全局槽，重复 start 返回错误码而不 panic。
//! - 字符串入参均为 UTF-8 C 字符串。
//!
//! 返回码：0=成功 1=参数错误 2=已在运行 3=未运行 4=内部错误 5=缓冲区太小

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

pub const VNET_OK: c_int = 0;
pub const VNET_ERR_ARG: c_int = 1;
pub const VNET_ERR_RUNNING: c_int = 2;
pub const VNET_ERR_NOT_RUNNING: c_int = 3;
pub const VNET_ERR_INTERNAL: c_int = 4;
pub const VNET_ERR_BUFSMALL: c_int = 5;

struct ClientHandle {
    conn: Arc<crate::connection::Connection>,
}

/// 多实例客户端注册表：peer_id → ClientHandle（同一进程可跑多条隧道）
static CLIENTS: OnceLock<Mutex<std::collections::HashMap<u32, ClientHandle>>> = OnceLock::new();
/// server 槽：(run 标志, peer_id)。peer_id 必须随槽保存——stop 时要显式释放
/// 注册占位，否则同进程再 start 恒 PEER_ID_IN_USE（rc=4，2026-11-12 ADB 卡实案）。
static SERVER: OnceLock<Mutex<Option<(Arc<AtomicBool>, u32)>>> = OnceLock::new();

/// 最近一次 start 失败的人读原因（2026-11-11 手机 rc=4 真案）。
/// 嵌入方（Android）拿不到进程 stderr——eprintln 在 Android 默认进 /dev/null，
/// 宿主只看到一个裸 rc 码根本没法排障（"隧道建立失败 rc=4"排查了一晚上）。
/// 这里把失败串出来，宿主用 [`vnet_last_error`] 读；成功启动即清空。
static LAST_ERR: OnceLock<Mutex<String>> = OnceLock::new();

fn last_err_slot() -> &'static Mutex<String> {
    LAST_ERR.get_or_init(|| Mutex::new(String::new()))
}

fn record_err(s: String) {
    *last_err_slot().lock().unwrap() = s;
}

fn clear_err() {
    last_err_slot().lock().unwrap().clear();
}

/// 读最近一次 start 失败原因（NUL 结尾 UTF-8 写入 buf）。
/// 返回 0=OK 5=缓冲区太小 4=内部错误（错误串含 NUL）。
#[no_mangle]
pub extern "C" fn vnet_last_error(buf: *mut c_char, buflen: c_int) -> c_int {
    let s = last_err_slot().lock().unwrap().clone();
    let c = match CString::new(s) {
        Ok(c) => c,
        Err(_) => return VNET_ERR_INTERNAL,
    };
    let bytes = c.to_bytes_with_nul();
    if buf.is_null() || buflen < bytes.len() as c_int {
        return VNET_ERR_BUFSMALL;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf as *mut u8, bytes.len());
    }
    VNET_OK
}

fn clients_map() -> &'static Mutex<std::collections::HashMap<u32, ClientHandle>> {
    CLIENTS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}
fn server_slot() -> &'static Mutex<Option<(Arc<AtomicBool>, u32)>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

fn opt_cstr(p: *const c_char) -> Option<String> {
    if p.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(p) }
        .to_str()
        .ok()
        .map(|s| s.to_string())
}

/// 一次性初始化（幂等）：提升 Windows 定时器精度等。嵌入式启动时调一次。
#[no_mangle]
pub extern "C" fn vnet_init() -> c_int {
    crate::init();
    VNET_OK
}

/// 启动客户端（P2P 优先 + 中继兜底；注册为确认式，失败立刻返回错误码）。
/// 成功后本地代理监听 127.0.0.1:local_port，上层直接连它收发数据。
#[no_mangle]
pub extern "C" fn vnet_client_start(
    relay: *const c_char,
    peer_id: u32,
    target_peer_id: u32,
    local_port: u16,
    secret: *const c_char,
) -> c_int {
    let (relay_s, secret_s) = match (opt_cstr(relay), opt_cstr(secret)) {
        (Some(r), Some(s)) => (r, s),
        _ => return VNET_ERR_ARG,
    };
    // 多实例：同 peer_id 视为重复启动（错误），不同 peer_id 各自独立
    {
        let map = clients_map().lock().unwrap();
        if map.contains_key(&peer_id) {
            return VNET_ERR_RUNNING;
        }
    }
    let sec = if secret_s.is_empty() { None } else { Some(secret_s.as_str()) };
    let conn = match crate::connection::Connection::with_secret_and_port(&relay_s, peer_id, target_peer_id, sec, None) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let msg = format!("client construct failed: {:#}", e);
            eprintln!("[vnet-ffi] {msg}");
            record_err(msg);
            return VNET_ERR_INTERNAL;
        }
    };
    // detached：accept 循环跑独立线程，本调用立刻返回（JNI 调用线程不能被阻塞）
    match conn.start_client_detached(local_port) {
        Ok(()) => {
            clear_err();
            clients_map().lock().unwrap().insert(peer_id, ClientHandle { conn });
            VNET_OK
        }
        Err(e) => {
            let msg = format!("client_start failed: {:#}", e);
            eprintln!("[vnet-ffi] {msg}");
            record_err(msg);
            // 启动失败必须把 Connection 停掉：否则 peer_id 占位与 relay 映射泄漏，
            // 宿主下次同 peer_id 只会拿到 PEER_ID_IN_USE（2026-11-11 手机真案）。
            conn.stop();
            VNET_ERR_INTERNAL
        }
    }
}

/// 启动 multi-forward 客户端（对端是 `:server:multi-forward-v1` 那种设备级 server）。
///
/// 为什么需要单独的入口（2026-11-11 手机真机定界）：myco 现役配置
/// `MYCO_VNET_MULTI_FORWARD=1` 下，PC **只**起一条 multi-forward server
/// （peer_id=SHA256("vnet-peer"||did||":server:multi-forward-v1")），
/// 逐端口 server（`:server:9100` 之类）根本不启动。用单目标 API 连逐端口
/// peer_id 会 `[A_lookup_peer] no_answer` → 静默预算耗尽 → 流被关。本机 CLI
/// 客户端对同一 peer_id 也一样失败（A/B 实证），不是手机侧问题。
///
/// 语义：注册/建链在**调用线程**完成（与单目标版一致），forward 由
/// [`vnet_client_add_forward`] 追加，端口监听在 libvnet 线程里。
#[no_mangle]
pub extern "C" fn vnet_client_start_multi(
    relay: *const c_char,
    peer_id: u32,
    target_peer_id: u32,
    secret: *const c_char,
) -> c_int {
    let (relay_s, secret_s) = match (opt_cstr(relay), opt_cstr(secret)) {
        (Some(r), Some(s)) => (r, s),
        _ => return VNET_ERR_ARG,
    };
    {
        let map = clients_map().lock().unwrap();
        if map.contains_key(&peer_id) {
            return VNET_ERR_RUNNING;
        }
    }
    let sec = if secret_s.is_empty() { None } else { Some(secret_s.as_str()) };
    let conn = match crate::connection::Connection::with_secret_and_port(&relay_s, peer_id, target_peer_id, sec, None) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let msg = format!("client_start_multi construct failed: {:#}", e);
            eprintln!("[vnet-ffi] {msg}");
            record_err(msg);
            return VNET_ERR_INTERNAL;
        }
    };
    conn.enable_multi_forward();
    // start_client_multi 在 multi 模式下只起接收/keepalive/探测线程，
    // 不建 listener、不阻塞（listener 由 add_forward 各自绑定），所以直接同步调。
    if let Err(e) = conn.start_client_multi() {
        let msg = format!("client_start_multi failed: {e}");
        eprintln!("[vnet-ffi] {msg}");
        record_err(msg);
        conn.stop();
        return VNET_ERR_INTERNAL;
    }
    clear_err();
    clients_map().lock().unwrap().insert(peer_id, ClientHandle { conn });
    VNET_OK
}

/// 给已启动的 multi-forward 客户端追加一条转发（本地口 → 对端 target）。
/// 返回 0=成功 1=参数错误 3=该 peer_id 未运行 4=内部错误（原因见 vnet_last_error）。
#[no_mangle]
pub extern "C" fn vnet_client_add_forward(peer_id: u32, local_port: u16, target_port: u16) -> c_int {
    if local_port == 0 || target_port == 0 {
        return VNET_ERR_ARG;
    }
    let conn = {
        let map = clients_map().lock().unwrap();
        match map.get(&peer_id) {
            Some(h) => h.conn.clone(),
            None => return VNET_ERR_NOT_RUNNING,
        }
    };
    match conn.add_forward(crate::forward::ForwardSpec { local_port, target_port }) {
        Ok(info) => {
            if info.local_port != local_port {
                let msg = format!(
                    "add_forward port drift: requested {local_port}, got {}",
                    info.local_port
                );
                eprintln!("[vnet-ffi] {msg}");
                record_err(msg);
                let _ = conn.remove_forward(info.local_port);
                return VNET_ERR_INTERNAL;
            }
            clear_err();
            VNET_OK
        }
        Err(e) => {
            let msg = format!("add_forward :{local_port} -> :{target_port} failed: {e:#}");
            eprintln!("[vnet-ffi] {msg}");
            record_err(msg);
            VNET_ERR_INTERNAL
        }
    }
}

/// 停止指定 peer_id 的客户端实例。
#[no_mangle]
pub extern "C" fn vnet_client_stop_peer(peer_id: u32) -> c_int {
    let mut map = clients_map().lock().unwrap();
    match map.remove(&peer_id) {
        Some(h) => {
            h.conn.stop();
            VNET_OK
        }
        None => VNET_ERR_NOT_RUNNING,
    }
}

/// 读取指定 peer_id 的客户端状态 JSON（多实例模式）。
#[no_mangle]
pub extern "C" fn vnet_client_status_peer(
    peer_id: u32,
    buf: *mut c_char,
    buflen: c_int,
    needed: *mut c_int,
) -> c_int {
    let map = clients_map().lock().unwrap();
    let Some(h) = map.get(&peer_id) else {
        return VNET_ERR_NOT_RUNNING;
    };
    let path = crate::connection::status_file_path_for("client", h.conn.my_peer_id);
    let body = std::fs::read_to_string(&path).unwrap_or_else(|_| {
        format!(
            "{{\"path\":\"unknown\",\"status_file\":\"{}\"}}",
            path.display()
        )
    });
    let c = match CString::new(body) {
        Ok(c) => c,
        Err(_) => return VNET_ERR_INTERNAL,
    };
    let bytes = c.to_bytes_with_nul();
    if !needed.is_null() {
        unsafe { *needed = bytes.len() as c_int };
    }
    if buf.is_null() || buflen < bytes.len() as c_int {
        return VNET_ERR_BUFSMALL;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf as *mut u8, bytes.len());
    }
    VNET_OK
}

/// 停止全部客户端实例。
#[no_mangle]
pub extern "C" fn vnet_client_stop() -> c_int {
    let mut map = clients_map().lock().unwrap();
    if map.is_empty() {
        return VNET_ERR_NOT_RUNNING;
    }
    for (_, h) in map.drain() {
        h.conn.stop();
    }
    VNET_OK
}

/// 读取客户端状态 JSON（NUL 结尾写入 buf）。
/// buf 可为 NULL + needed 非 NULL 时探测所需长度。
#[no_mangle]
pub extern "C" fn vnet_client_status(
    buf: *mut c_char,
    buflen: c_int,
    needed: *mut c_int,
) -> c_int {
    let map = clients_map().lock().unwrap();
    let Some(h) = map.values().next() else {
        return VNET_ERR_NOT_RUNNING;
    };
    let path = crate::connection::status_file_path_for("client", h.conn.my_peer_id);
    let body = std::fs::read_to_string(&path).unwrap_or_else(|_| {
        format!(
            "{{\"path\":\"unknown\",\"status_file\":\"{}\"}}",
            path.display()
        )
    });
    let c = match CString::new(body) {
        Ok(c) => c,
        Err(_) => return VNET_ERR_INTERNAL,
    };
    let bytes = c.to_bytes_with_nul();
    if !needed.is_null() {
        unsafe { *needed = bytes.len() as c_int };
    }
    if buf.is_null() || buflen < bytes.len() as c_int {
        return VNET_ERR_BUFSMALL;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf as *mut u8, bytes.len());
    }
    VNET_OK
}

/// 启动服务端（PC 侧）：转发到 127.0.0.1:target_port。
/// 注意：**阻塞**（主接收循环在函数体内），宿主须自行 spawn 线程调用本 FFI。
/// 多实例：peer_id 各异（slot 方案），监听口 9100 被占时自动回退随机口并公告真实端口。
#[no_mangle]
pub extern "C" fn vnet_server_start(
    relay: *const c_char,
    peer_id: u32,
    target_port: u16,
    secret: *const c_char,
) -> c_int {
    let (relay_s, secret_s) = match (opt_cstr(relay), opt_cstr(secret)) {
        (Some(r), Some(s)) => (r, s),
        _ => return VNET_ERR_ARG,
    };
    let sec = if secret_s.is_empty() { None } else { Some(secret_s.as_str()) };
    // 单 server 槽：已有实例在跑 → 明确拒绝（不静默替换，避免两条 server 抢同一 relay 映射）。
    if server_slot().lock().unwrap().is_some() {
        return VNET_ERR_RUNNING;
    }
    // 自愈：槽空但本 peer_id 仍被占位 = 上一个实例异常退出留下的泄漏，先释放再起。
    crate::connection::release_server_registrations(peer_id);
    match crate::connection::start_server_with_secret(&relay_s, peer_id, target_port, sec) {
        Ok(run) => {
            let mut slot = server_slot().lock().unwrap();
            *slot = Some((run, peer_id));
            VNET_OK
        }
        Err(e) => {
            eprintln!("[vnet-ffi] server_start failed: {:#}", e);
            VNET_ERR_INTERNAL
        }
    }
}

/// 停止服务端。
#[no_mangle]
pub extern "C" fn vnet_server_stop() -> c_int {
    let mut slot = server_slot().lock().unwrap();
    match slot.take() {
        Some((run, peer_id)) => {
            run.store(false, Ordering::Relaxed);
            // 显式释放注册占位（peer_id + target_port 表）——stop 不释放会让同进程
            // 第二次 start 恒 rc=4（2026-11-12 真机 ADB 卡 stop→start 实案）。
            crate::connection::release_server_registrations(peer_id);
            VNET_OK
        }
        None => VNET_ERR_NOT_RUNNING,
    }
}

/// 注入签名注册凭据（私钥留在宿主身份层）。
/// 宿主用设备私钥对 `${did}\n${ts}\nrelay-register`（UTF-8）做 Ed25519 签名，
/// 把 (did, 秒级 ts, base64 签名) 推入。凭据新鲜（ts 距今 <250s）时客户端
/// 自动走签名注册；过期或未注入走 legacy token 路径。
/// 宿主应每 ~200 秒重推一次。传 NULL 清除。
#[no_mangle]
pub extern "C" fn vnet_set_register_credentials(
    did: *const c_char,
    ts: i64,
    sig_b64: *const c_char,
) -> c_int {
    if did.is_null() {
        crate::relay::clear_register_credentials();
        return VNET_OK;
    }
    let (Some(d), Some(s)) = (opt_cstr(did), opt_cstr(sig_b64)) else {
        return VNET_ERR_ARG;
    };
    crate::relay::set_register_credentials(&d, ts, &s);
    VNET_OK
}

/// 注入本机设备身份（DID + 32 字节 seed 的 hex），此后**本进程发起的每条流**
/// 都会先发 AUTH 帧（`identity::build_auth_frame`），对端启用 peer identity 时才
/// 会放行。
///
/// 为什么必须有：2026-11-11 手机真机——PC 侧 `MYCO_PEER_IDENTITY=1` 后，
/// 入站未认证流一律 `AUTH_REQUIRED` 拒绝。手机只起 client 不注身份 →
/// 本地回环口能建、握手能成、请求字节发出去就再无下文（宿主只看到 10s 读超时
/// 或 "unexpected end of stream"）。这是「手机→PC 数据面不通」的最后一层。
///
/// 隐私边界：私钥只经此函数进内存，不落盘、不进日志。
#[no_mangle]
pub extern "C" fn vnet_set_local_identity(did: *const c_char, seed_hex: *const c_char) -> c_int {
    let (Some(d), Some(s)) = (opt_cstr(did), opt_cstr(seed_hex)) else {
        return VNET_ERR_ARG;
    };
    match crate::identity::set_local_identity_from_seed(&d, &s) {
        Some(_key_id) => VNET_OK,
        None => VNET_ERR_ARG,
    }
}

/// 本机设备身份是否已注入（0=未注入 1=已注入）。宿主用它决定是否还要补注入。
#[no_mangle]
pub extern "C" fn vnet_has_local_identity() -> c_int {
    if crate::identity::local_did().is_some() {
        1
    } else {
        0
    }
}

/// 显式 PSK-only 闸门模式（2026-11-12 ADB P0）。
/// 手机 JNI 单口 server 没有 set_peer_resolver 入口——原实现 fail-closed 全拒
/// （AUTH 验签需要 resolver 取公钥，无 resolver → UnknownKey → AUTH_REQUIRED）。
/// 调此函数后：闸门降级为「PSK 网络准入 + AUTH 身份仅作 advisory（不验签）」。
/// 安全语义：与身份功能加入前一致；有 resolver 的宿主不应调此函数。
/// 返回 VNET_OK。
#[no_mangle]
pub extern "C" fn vnet_set_gate_psk_only() -> c_int {
    crate::identity::set_gate_psk_only();
    VNET_OK
}

/// 注入单个对端候选地址（presence 数据，逐个调用累积）。
/// 传 NULL 清空全部注入。
#[no_mangle]
pub extern "C" fn vnet_set_peer_candidates(peer_id: u32, cand: *const c_char) -> c_int {
    if cand.is_null() {
        crate::relay::clear_peer_candidates_override();
        return VNET_OK;
    }
    let raw = match opt_cstr(cand) {
        Some(s) => s,
        None => return VNET_ERR_ARG,
    };
    let addr: std::net::SocketAddr = match raw.parse() {
        Ok(a) => a,
        Err(_) => return VNET_ERR_ARG,
    };
    let mut cur = crate::relay::peer_candidates(peer_id).unwrap_or_default();
    if !cur.contains(&addr) {
        cur.push(addr);
    }
    crate::relay::set_peer_candidates_override(peer_id, cur);
    VNET_OK
}
