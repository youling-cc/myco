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
    conn: Arc<crate::vnet::connection::Connection>,
}

/// 多实例客户端注册表：peer_id → ClientHandle（同一进程可跑多条隧道）
static CLIENTS: OnceLock<Mutex<std::collections::HashMap<u32, ClientHandle>>> = OnceLock::new();
static SERVER: OnceLock<Mutex<Option<Arc<AtomicBool>>>> = OnceLock::new();

fn clients_map() -> &'static Mutex<std::collections::HashMap<u32, ClientHandle>> {
    CLIENTS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}
fn server_slot() -> &'static Mutex<Option<Arc<AtomicBool>>> {
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
    crate::vnet::init();
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
    let conn = match crate::vnet::connection::Connection::with_secret_and_port(&relay_s, peer_id, target_peer_id, sec, None) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            eprintln!("[vnet-ffi] client construct failed: {:#}", e);
            return VNET_ERR_INTERNAL;
        }
    };
    // detached：accept 循环跑独立线程，本调用立刻返回（JNI 调用线程不能被阻塞）
    match conn.start_client_detached(local_port) {
        Ok(()) => {
            clients_map().lock().unwrap().insert(peer_id, ClientHandle { conn });
            VNET_OK
        }
        Err(e) => {
            eprintln!("[vnet-ffi] client_start failed: {:#}", e);
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
    let path = crate::vnet::connection::status_file_path_for("client", h.conn.my_peer_id);
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
    match crate::vnet::connection::start_server_with_secret(&relay_s, peer_id, target_port, sec) {
        Ok(run) => {
            let mut slot = server_slot().lock().unwrap();
            *slot = Some(run);
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
        Some(run) => {
            run.store(false, Ordering::Relaxed);
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
        crate::vnet::relay::clear_register_credentials();
        return VNET_OK;
    }
    let (Some(d), Some(s)) = (opt_cstr(did), opt_cstr(sig_b64)) else {
        return VNET_ERR_ARG;
    };
    crate::vnet::relay::set_register_credentials(&d, ts, &s);
    VNET_OK
}

/// 注入单个对端候选地址（presence 数据，逐个调用累积）。
/// 传 NULL 清空全部注入。
#[no_mangle]
pub extern "C" fn vnet_set_peer_candidates(peer_id: u32, cand: *const c_char) -> c_int {
    if cand.is_null() {
        crate::vnet::relay::clear_peer_candidates_override();
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
    let mut cur = crate::vnet::relay::peer_candidates(peer_id).unwrap_or_default();
    if !cur.contains(&addr) {
        cur.push(addr);
    }
    crate::vnet::relay::set_peer_candidates_override(peer_id, cur);
    VNET_OK
}
