//! mDNS 同 LAN 发现（2026-10-22，V17.1/E1 的能力补齐）。
//!
//! 为什么要它：现在直连候选只来自 presence（服务端上报的 IPv6/反射地址）和上次缓存。
//! **同 LAN 的两台设备**其实互不可见服务端地址也未必可用（AP 隔离、v6 前缀不同），
//! 但 mDNS 能零配置发现——这正是 Tailscale/Bonjour 的常规做法。
//!
//! 做法：
//!   · 注册 `_myco._tcp.local.`，TXT 带 `did` 与本机 p2p 端口（name 用 DID 尾 8 位保证唯一）；
//!   · 同时 browse 同服务，把解析到的 (did → Vec<http://ip:port>) 缓存；
//!   · `candidate_bases` 对非本机目标追加该目标的 LAN 候选（排在有公网候选之后）。
//! 安全：mDNS 只广播**本机 LAN 地址 + 设备 DID**（DID 本就是公开标识）；隧道握手仍要求
//! 设备签名 + 账号归属闸，所以局域网可达 ≠ 能建链。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};

pub const SERVICE_TYPE: &str = "_myco._tcp.local.";

#[derive(Clone, Debug)]
pub struct LanPeer {
    pub did: String,
    pub name: String,
    pub addrs: Vec<String>,
    pub port: u16,
    pub last_seen_ms: u64,
}

struct State {
    daemon: Option<ServiceDaemon>,
    last_error: Option<String>,
    self_did: String,
    peers: HashMap<String, LanPeer>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| {
    Mutex::new(State {
        daemon: None,
        last_error: None,
        self_did: String::new(),
        peers: HashMap::new(),
    })
});

/// 诊断日志落盘（WMI/计划任务启动时 stderr 不可见；远程排查靠这个文件）。
fn log(msg: &str) {
    eprintln!("[mdns] {msg}");
    if let Ok(dir) = std::env::var("APPDATA") {
        let path = std::path::Path::new(&dir).join("youling").join("mdns.log");
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            use std::io::Write;
            let _ = writeln!(f, "[{}] {}", now_ms(), msg);
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "myco".to_string())
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect()
}

/// 收集本机私网地址（IPv4 非回环 + 全局 IPv6），用于注册 A/AAAA 记录。
fn local_addrs() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
        // 用 UDP connect 让系统选出口地址（不真的发包）
        if sock.connect("223.5.5.5:53").is_ok() {
            if let Ok(a) = sock.local_addr() {
                let ip = a.ip();
                if !ip.is_loopback() && !ip.is_unspecified() {
                    out.push(ip.to_string());
                }
            }
        }
    }
    // 补充其它 IPv4 私网地址
    // 2026-10-23：GUI 父进程 spawn 控制台程序必须 CREATE_NO_WINDOW，否则每次探测闪一个黑窗
    //（用户反馈「打开 myco 老是弹出控制台」的根因之一）。
    let mut ps4 = std::process::Command::new("powershell");
    ps4.args(["-NoProfile", "-Command", "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown'}).IPAddress"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        ps4.creation_flags(0x0800_0000);
    }
    if let Ok(out2) = ps4.output() {
        for line in String::from_utf8_lossy(&out2.stdout).lines() {
            let t = line.trim();
            if !t.is_empty() && !out.iter().any(|x| x == t) {
                out.push(t.to_string());
            }
        }
    }
    out
}

/// 启动 mDNS（幂等）。`p2p_port` = 本机 p2p 数据面端口（用于注册）。
pub fn start(p2p_port: u16) {
    let mut g = STATE.lock().unwrap();
    if g.daemon.is_some() || p2p_port == 0 {
        log(&format!("skip start: daemon={} p2p_port={p2p_port}", g.daemon.is_some()));
        return;
    }
    g.last_error = None;
    let did = myco_core::identity::device_identity()
        .map(|(d, _)| d)
        .unwrap_or_default();
    let tail: String = did.chars().rev().take(8).collect::<String>().chars().rev().collect();
    let instance = format!("myco-{}", if tail.is_empty() { hostname() } else { tail });
    let daemon = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            log(&format!("ServiceDaemon::new 失败：{e}"));
            g.last_error = Some(format!("daemon: {e}"));
            return;
        }
    };
    let addrs = local_addrs();
    crate::startup_trace::mark("mdns-enter");
    let mut props: HashMap<String, String> = HashMap::new();
    props.insert("did".to_string(), did.clone());
    props.insert("port".to_string(), p2p_port.to_string());
    props.insert("ver".to_string(), "1".to_string());
    let host = format!("{}.local.", hostname());
    let addr_strs: Vec<String> = addrs.clone();
    match ServiceInfo::new(SERVICE_TYPE, &instance, &host, addr_strs.as_slice(), p2p_port, props) {
        Ok(info) => {
            let info = info.enable_addr_auto();
            if let Err(e) = daemon.register(info) {
                log(&format!("注册失败：{e}"));
                g.last_error = Some(format!("register: {e}"));
            } else {
                log(&format!("已注册 {SERVICE_TYPE} instance={instance} port={p2p_port} addrs={addr_strs:?}"));
            }
        }
        Err(e) => {
            log(&format!("ServiceInfo 构造失败：{e}"));
            g.last_error = Some(format!("info: {e}"));
        }
    }

    // browse 线程：解析到对端就更新缓存
    let recv = daemon.browse(SERVICE_TYPE);
    match recv {
        Ok(rx) => {
            std::thread::spawn(move || {
                while let Ok(ev) = rx.recv() {
                    match ev {
                        ServiceEvent::ServiceResolved(info) => {
                            let props = info.get_properties();
                            let peer_did = props
                                .get_property_val_str("did")
                                .unwrap_or_default()
                                .to_string();
                            if peer_did.is_empty() {
                                continue;
                            }
                            let port = info.get_port();
                            let mut addrs: Vec<String> = info
                                .get_addresses()
                                .iter()
                                .map(|ip| ip.to_string())
                                .collect();
                            addrs.sort();
                            let mut cands: Vec<String> = addrs
                                .iter()
                                .map(|ip| {
                                    if ip.contains(':') {
                                        format!("http://[{ip}]:{port}")
                                    } else {
                                        format!("http://{ip}:{port}")
                                    }
                                })
                                .collect();
                            cands.dedup();
                            {
                                let mut g = STATE.lock().unwrap();
                                if peer_did == g.self_did || peer_did.is_empty() {
                                    continue;
                                }
                                g.peers.insert(
                                    peer_did.clone(),
                                    LanPeer {
                                        did: peer_did,
                                        name: info.get_fullname().to_string(),
                                        addrs: cands,
                                        port,
                                        last_seen_ms: now_ms(),
                                    },
                                );
                            }
                            log(&format!("发现对端 {info:?}"));
                        }
                        ServiceEvent::ServiceRemoved(_ty, full) => {
                            let mut g = STATE.lock().unwrap();
                            g.peers.retain(|_, p| p.name != full);
                        }
                        _ => {}
                    }
                }
            });
        }
        Err(e) => log(&format!("browse 失败：{e}")),
    }
    g.daemon = Some(daemon);
    g.self_did = did;
}

/// 该 DID 的 LAN 候选（`http://ip:port`，最可能可用的排前）。
pub fn lan_candidates_for(did: &str) -> Vec<String> {
    let g = STATE.lock().unwrap();
    if g.self_did.is_empty() || myco_core::identity::did_equiv(&g.self_did, did) {
        return Vec::new();
    }
    g.peers
        .iter()
        .find(|(k, _)| myco_core::identity::did_equiv(k, did))
        .map(|(_, p)| p.addrs.clone())
        .unwrap_or_default()
}

/// 证据/接口用快照。
pub fn snapshot() -> Vec<serde_json::Value> {
    let g = STATE.lock().unwrap();
    g.peers
        .values()
        .map(|p| {
            serde_json::json!({
                "did": p.did,
                "name": p.name,
                "port": p.port,
                "addrs": p.addrs,
                "lastSeenMs": p.last_seen_ms,
            })
        })
        .collect()
}

/// 是否已启动（诊断用）。
pub fn running() -> bool {
    STATE.lock().unwrap().daemon.is_some()
}

/// 启动失败原因（诊断用；None=没有错误）。
pub fn last_error() -> Option<String> {
    STATE.lock().unwrap().last_error.clone()
}
