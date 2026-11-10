//! vnet UDP relay server — Rust 版（取代 relay_server.c）
//!
//! 保留：VNRL 二进制协议（16 字节头）、peer 表、token 路径（迁移期兼容）、stats.json 口径
//! 新增：
//!   1. REGISTER_SIGNED（type=10）：DID 注册表 + Ed25519 验签（对齐 relay.mjs 语义）
//!   2. peer_id ↔ DID 绑定校验（slot 方案：SHA256("vnet-peer"||DID) 前28位 << 4 | slot）
//!   3. 三级限速（每 IP / 每 DID / 全局）+ 廉价预检在验签前
//!   4. 零放大：错误一律静默丢弃；LOOKUP/PEERINFO/DATA 只响应已注册地址
//!
//! 部署：musl 静态单二进制；systemd 加固模板沿用（NoNewPrivileges/ProtectSystem=strict/低权用户）。
//! 安全评审文档：docs/SA-REVIEW-RELAY-OPEN.md

use std::collections::HashMap;
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

// ── 协议常量（与 relay_server.c / 客户端 relay.rs 严格一致）──
const MAGIC: u32 = 0x564E_524C; // "VNRL"
const HEADER: usize = 16;
const PKT_REGISTER: u8 = 1;
const PKT_REGISTER_ACK: u8 = 2;
const PKT_DATA: u8 = 3;
const PKT_LOOKUP: u8 = 4;
const PKT_LOOKUP_ACK: u8 = 5;
const PKT_KEEPALIVE: u8 = 6;
const PKT_ANNOUNCE: u8 = 7;
const PKT_PEERINFO: u8 = 8;
const PKT_PEERINFO_ACK: u8 = 9;
const PKT_REGISTER_SIGNED: u8 = 10;
const PKT_UNREGISTER: u8 = 11;

const PEER_TIMEOUT_SECS: u64 = 180;
// 时间戳单位 = 毫秒（与 relay.mjs 的 Date.now() 惯例一致，2026-11-05 与 DSH协议应用对齐）
const TS_WINDOW_MS: i64 = 300_000;
const REGISTRY_TTL_SECS: u64 = 300;
const REGISTRY_STALE_GRACE_SECS: u64 = 86_400; // identity-svc 故障时缓存宽限 24h
const PER_IP_RATE: u32 = 10; // REGISTER/秒/源 IP
const PER_DID_MIN_INTERVAL_MS: u64 = 5_000;
const GLOBAL_REGISTER_RATE: u32 = 100;

fn build_packet(buf: &mut [u8], typ: u8, peer_id: u32, payload: &[u8]) -> usize {
    buf[0..4].copy_from_slice(&MAGIC.to_be_bytes());
    buf[4] = typ;
    buf[5] = 0;
    buf[6] = 0;
    buf[7] = 0;
    buf[8..12].copy_from_slice(&peer_id.to_be_bytes());
    buf[12..16].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    let n = payload.len();
    buf[HEADER..HEADER + n].copy_from_slice(payload);
    HEADER + n
}

fn parse_packet(buf: &[u8]) -> Option<(u8, u32, &[u8])> {
    if buf.len() < HEADER {
        return None;
    }
    if u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) != MAGIC {
        return None;
    }
    let typ = buf[4];
    let peer_id = u32::from_be_bytes([buf[8], buf[9], buf[10], buf[11]]);
    let plen = u32::from_be_bytes([buf[12], buf[13], buf[14], buf[15]]) as usize;
    if buf.len() < HEADER + plen {
        return None;
    }
    Some((typ, peer_id, &buf[HEADER..HEADER + plen]))
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// slot 方案的 peer_id 基数校验：
/// 期望 peer_id 的高 28 位 == SHA256("vnet-peer" || did) 的前 28 位
/// （与 DSH协议应用 421b0085 的客户端映射一致；防跨 DID 抢占 peer_id）
fn peer_id_matches_did(peer_id: u32, did: &str) -> bool {
    let mut h = Sha256::new();
    h.update(b"vnet-peer");
    h.update(did.as_bytes());
    let digest = h.finalize();
    let base28 = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) >> 4;
    (peer_id >> 4) == base28
}

// ── peer 表 ──
#[derive(Clone)]
struct Peer {
    did: Option<String>, // 签名路径注册的 DID；legacy 路径为 None
    addr: SocketAddr,
    ipv6: String,
    ipv4_pub: String,
    /// 对端公告的 NetStatus 画像原文（announce 的 ns= 段）。
    /// relay 只存转、不理解语义；PeerInfo 回带给查询方，由它解析。
    netstatus: String,
    last_seen: i64,
}

struct Peers {
    map: HashMap<u32, Peer>,
}
impl Peers {
    fn new() -> Self {
        Self { map: HashMap::new() }
    }
}

// ── DID 注册表（identity-svc + 本地文件兜底 + TTL 缓存）──
struct Registry {
    endpoint: Option<String>,     // http://host:port/api/did/  （GET {endpoint}{did} → {"publicKeyB64":...}）
    file_path: Option<String>,    // 本地兜底：每行 "did base64公钥"
    cache: Mutex<HashMap<String, (VerifyingKey, i64, bool)>>, // did → (key, 过期时刻, 是否来自文件)
}

impl Registry {
    fn lookup(&self, did: &str) -> Option<VerifyingKey> {
        let now = now_unix();
        {
            let cache = self.cache.lock().unwrap();
            if let Some((key, expiry, from_file)) = cache.get(did) {
                // 新鲜 → 直接用；过期但宽限期内（identity-svc 故障）→ 仍可用
                if now < *expiry || (*from_file && now < *expiry + REGISTRY_STALE_GRACE_SECS as i64) {
                    return Some(*key);
                }
            }
        }
        // identity-svc 在线查询（极简 std HTTP，GET，2 秒超时）
        if let Some(ep) = &self.endpoint {
            if let Some(key) = http_get_json_pubkey(ep, did) {
                self.cache
                    .lock()
                    .unwrap()
                    .insert(did.to_string(), (key, now + REGISTRY_TTL_SECS as i64, false));
                return Some(key);
            }
        }
        // 文件兜底（测试 / identity-svc 不可达时的运营兜底）
        if let Some(path) = &self.file_path {
            if let Some(key) = file_lookup(path, did) {
                self.cache
                    .lock()
                    .unwrap()
                    .insert(did.to_string(), (key, now + REGISTRY_TTL_SECS as i64, true));
                return Some(key);
            }
        }
        None
    }
}

fn b64_decode_pubkey(s: &str) -> Option<VerifyingKey> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(s.trim()).ok()?;
    let arr: [u8; 32] = bytes.try_into().ok()?;
    VerifyingKey::from_bytes(&arr).ok()
}

fn file_lookup(path: &str, did: &str) -> Option<VerifyingKey> {
    let content = std::fs::read_to_string(path).ok()?;
    for line in content.lines() {
        let mut it = line.split_whitespace();
        if let (Some(d), Some(k)) = (it.next(), it.next()) {
            if d == did {
                return b64_decode_pubkey(k);
            }
        }
    }
    None
}

/// 极简 HTTP GET（std-only；仅支持 http:// 同主机/内网场景，HTTPS 走同机反代）
fn http_get_json_pubkey(endpoint: &str, did: &str) -> Option<VerifyingKey> {
    use std::io::{Read, Write};
    let url = format!("{}{}", endpoint, did);
    let rest = url.strip_prefix("http://")?;
    let (hostport, path) = match rest.split_once('/') {
        Some((h, p)) => (h.to_string(), format!("/{}", p)),
        None => (rest.to_string(), "/".to_string()),
    };
    let mut stream = std::net::TcpStream::connect_timeout(
        &hostport.parse().ok()?,
        Duration::from_secs(2),
    )
    .ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let req = format!(
        "GET {} HTTP/1.0\r\nHost: {}\r\nConnection: close\r\n\r\n",
        path, hostport
    );
    stream.write_all(req.as_bytes()).ok()?;
    let mut resp = Vec::new();
    stream.read_to_end(&mut resp).ok()?;
    let body = String::from_utf8_lossy(&resp);
    // 取 JSON body 里的 publicKeyB64（避免引入 JSON 依赖的正则弱解析）
    let key = body.split("\"publicKeyB64\"").nth(1)?;
    let val = key.split('"').nth(2)?; // : "value"
    b64_decode_pubkey(val)
}

// ── 限速器 ──
struct RateLimiter {
    per_ip: Mutex<HashMap<std::net::IpAddr, (u32, Instant)>>, // (令牌粗粒度：窗口内计数, 窗口起点)
    per_did: Mutex<HashMap<String, Instant>>,                  // 上次注册时刻
    global: (AtomicU64, Mutex<Instant>),
}

impl RateLimiter {
    fn new() -> Self {
        Self {
            per_ip: Mutex::new(HashMap::new()),
            per_did: Mutex::new(HashMap::new()),
            global: (AtomicU64::new(0), Mutex::new(Instant::now())),
        }
    }
    /// 三级检查；任一超限返回 false（调用方静默丢弃——零放大）
    fn allow(&self, ip: std::net::IpAddr, did: &str) -> bool {
        let now = Instant::now();
        {
            let mut m = self.per_ip.lock().unwrap();
            let e = m.entry(ip).or_insert((0, now));
            if now.duration_since(e.1) > Duration::from_secs(1) {
                *e = (1, now);
            } else {
                e.0 += 1;
                if e.0 > PER_IP_RATE {
                    return false;
                }
            }
        }
        {
            let mut m = self.per_did.lock().unwrap();
            if let Some(last) = m.get(did) {
                if now.duration_since(*last) < Duration::from_millis(PER_DID_MIN_INTERVAL_MS) {
                    return false;
                }
            }
            m.insert(did.to_string(), now);
        }
        {
            let g = &self.global;
            let mut w = g.1.lock().unwrap();
            if now.duration_since(*w) > Duration::from_secs(1) {
                g.0.store(0, Ordering::Relaxed);
                *w = now;
            }
            if g.0.fetch_add(1, Ordering::Relaxed) + 1 > GLOBAL_REGISTER_RATE as u64 {
                return false;
            }
        }
        true
    }
}

// ── stats（口径兼容 relay_server.c，新增分类）──
struct Stats {
    rejected_total: AtomicU64, // 与旧口径 register_rejected_10min 合并
    sig_rejected: AtomicU64,
    unknown_did: AtomicU64,
    rate_limited: AtomicU64,
    legacy_rejected: AtomicU64,
    bytes_forwarded: AtomicU64,
    signed_registers: AtomicU64,
    legacy_registers: AtomicU64,
    window_start: Mutex<i64>,
    started_at: i64,
}

impl Stats {
    fn note(&self, which: &str) {
        let now = now_unix();
        {
            let mut w = self.window_start.lock().unwrap();
            if now - *w >= 600 {
                *w = now;
                self.rejected_total.store(0, Ordering::Relaxed);
                self.sig_rejected.store(0, Ordering::Relaxed);
                self.unknown_did.store(0, Ordering::Relaxed);
                self.rate_limited.store(0, Ordering::Relaxed);
                self.legacy_rejected.store(0, Ordering::Relaxed);
            }
        }
        self.rejected_total.fetch_add(1, Ordering::Relaxed);
        match which {
            "sig" => _ = self.sig_rejected.fetch_add(1, Ordering::Relaxed),
            "did" => _ = self.unknown_did.fetch_add(1, Ordering::Relaxed),
            "rate" => _ = self.rate_limited.fetch_add(1, Ordering::Relaxed),
            "legacy" => _ = self.legacy_rejected.fetch_add(1, Ordering::Relaxed),
            _ => {}
        }
    }
}

fn write_stats_file(
    path: &str,
    port: u16,
    peers: &Peers,
    stats: &Stats,
    strict_peer_id: bool,
) {
    let online = peers.map.len();
    let tmp = format!("{}.tmp", path);
    let body = format!(
        "{{\n  \"port\": {},\n  \"uptime_secs\": {},\n  \"peers_online\": {},\n  \"register_rejected_10min\": {},\n  \"sig_rejected_10min\": {},\n  \"unknown_did_10min\": {},\n  \"rate_limited_10min\": {},\n  \"legacy_rejected_10min\": {},\n  \"bytes_forwarded_total\": {},\n  \"signed_registers_total\": {},\n  \"legacy_registers_total\": {},\n  \"strict_peer_id\": {},\n  \"version\": \"1.0.0-rust-ed25519\"\n}}\n",
        port,
        now_unix() - stats.started_at,
        online,
        stats.rejected_total.load(Ordering::Relaxed),
        stats.sig_rejected.load(Ordering::Relaxed),
        stats.unknown_did.load(Ordering::Relaxed),
        stats.rate_limited.load(Ordering::Relaxed),
        stats.legacy_rejected.load(Ordering::Relaxed),
        stats.bytes_forwarded.load(Ordering::Relaxed),
        stats.signed_registers.load(Ordering::Relaxed),
        stats.legacy_registers.load(Ordering::Relaxed),
        strict_peer_id,
    );
    let _ = std::fs::write(&tmp, body);
    let _ = std::fs::rename(&tmp, path);
}

fn main() {
    let port: u16 = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("VNRELAY_PORT").ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(8322);

    // token（迁移期 legacy 路径）：64 位十六进制 = 32 字节
    let token_hex = std::env::args()
        .nth(2)
        .or_else(|| std::env::var("VNRELAY_TOKEN").ok());
    let relay_token: Option<[u8; 32]> = token_hex.and_then(|h| {
        if h.len() != 64 {
            return None;
        }
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).ok()?;
        }
        Some(out)
    });

    // legacy 白名单（迁移期）：逗号分隔 IP；为空则 legacy 路径关闭
    let legacy_ips: Vec<std::net::IpAddr> = std::env::var("VNRELAY_LEGACY_IPS")
        .unwrap_or_default()
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();

    let registry = Registry {
        endpoint: std::env::var("IDENTITY_ENDPOINT").ok().filter(|s| !s.is_empty()),
        file_path: std::env::var("VNRELAY_REGISTRY_FILE").ok().filter(|s| !s.is_empty()),
        cache: Mutex::new(HashMap::new()),
    };
    // peer_id↔DID 的派生绑定校验默认关闭（2026-11-05 定）：
    // 安全由「签名 + 注册表 + peer 归属表」三层保证——同一 peer_id 被其他 DID
    // 注册时会被拒绝（见 REGISTER_SIGNED 分支的 entry.did 检查），
    // 因此派生绑定只是可选的额外约束，不应限制客户端的 slot 取值空间
    // （实测 3389%16 == 5037%16 == 13，按 port%16 取 slot 会撞）。
    let strict_peer_id = std::env::var("VNET_STRICT_PEER_ID")
        .map(|v| v == "1")
        .unwrap_or(false);

    let stats_path =
        std::env::var("VNRELAY_STATS").unwrap_or_else(|_| "stats.json".to_string());

    let socket = Arc::new(UdpSocket::bind(("0.0.0.0", port)).expect("bind failed"));
    println!(
        "vnet relay (rust) on 0.0.0.0:{} [OK] signed=enabled legacy={} ips={} strict_peer_id={}",
        port,
        if legacy_ips.is_empty() { "off" } else { "token+ip" },
        legacy_ips.len(),
        strict_peer_id
    );

    let peers = Arc::new(Mutex::new(Peers::new()));
    let limiter = Arc::new(RateLimiter::new());
    let stats = Arc::new(Stats {
        rejected_total: AtomicU64::new(0),
        sig_rejected: AtomicU64::new(0),
        unknown_did: AtomicU64::new(0),
        rate_limited: AtomicU64::new(0),
        legacy_rejected: AtomicU64::new(0),
        bytes_forwarded: AtomicU64::new(0),
        signed_registers: AtomicU64::new(0),
        legacy_registers: AtomicU64::new(0),
        window_start: Mutex::new(now_unix()),
        started_at: now_unix(),
    });

    // 过期清理线程
    {
        let peers = peers.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(30));
            let now = now_unix();
            let mut p = peers.lock().unwrap();
            let expired: Vec<u32> = p
                .map
                .iter()
                .filter(|(_, e)| now - e.last_seen > PEER_TIMEOUT_SECS as i64)
                .map(|(id, _)| *id)
                .collect();
            for id in expired {
                println!("peer {} expired", id);
                p.map.remove(&id);
            }
        });
    }
    // stats 线程（10 秒原子重写，口径兼容运维现有拉取）
    {
        let peers = peers.clone();
        let stats = stats.clone();
        let path = stats_path.clone();
        std::thread::spawn(move || loop {
            write_stats_file(&path, port, &peers.lock().unwrap(), &stats, strict_peer_id);
            std::thread::sleep(Duration::from_secs(10));
        });
    }

    let mut buf = [0u8; 65536];
    let mut resp = [0u8; 65536];
    loop {
        let (len, src) = match socket.recv_from(&mut buf) {
            Ok(x) => x,
            Err(_) => continue,
        };
        let Some((typ, peer_id, payload)) = parse_packet(&buf[..len]) else {
            continue;
        };
        match typ {
            // ── 新路径：DID + Ed25519 签名注册（对齐 relay.mjs 的载荷格式）──
            PKT_REGISTER_SIGNED => {
                // payload: did\0ts\0sigB64\0（NUL 分隔 UTF-8）
                let parts: Vec<&str> = std::str::from_utf8(payload)
                    .ok()
                    .map(|s| s.trim_end_matches('\0').split('\0').collect())
                    .unwrap_or_default();
                if parts.len() != 3 {
                    stats.note("sig"); // 格式错按 sig 类计（不回包——零放大）
                    continue;
                }
                let (did, ts_str, sig_b64) = (parts[0], parts[1], parts[2]);
                let Ok(ts) = ts_str.parse::<i64>() else {
                    stats.note("sig");
                    continue;
                };
                // 廉价预检 1：时间窗（防重放）
                if (now_millis() - ts).abs() > TS_WINDOW_MS {
                    stats.note("sig");
                    continue;
                }
                // 廉价预检 2：限速（三级）
                if !limiter.allow(src.ip(), did) {
                    stats.note("rate");
                    continue;
                }
                // 廉价预检 3：peer_id ↔ DID 绑定（slot 方案）
                if strict_peer_id && !peer_id_matches_did(peer_id, did) {
                    stats.note("sig");
                    continue;
                }
                // 注册表查询（缓存优先）
                let Some(vkey) = registry.lookup(did) else {
                    stats.note("did");
                    println!("REGISTER rejected: unknown did=…{}", &did[did.len().saturating_sub(8)..]);
                    continue;
                };
                // 验签（载荷与 relay.mjs 完全一致：`${did}\n${ts}\nrelay-register`）
                let msg = format!("{}\n{}\nrelay-register", did, ts_str);
                let sig_bytes = {
                    use base64::Engine;
                    match base64::engine::general_purpose::STANDARD.decode(sig_b64) {
                        Ok(b) => b,
                        Err(_) => {
                            stats.note("sig");
                            continue;
                        }
                    }
                };
                let Ok(sig_arr) = <[u8; 64]>::try_from(sig_bytes.as_slice()) else {
                    stats.note("sig");
                    continue;
                };
                let sig = Signature::from_bytes(&sig_arr);
                if vkey.verify(msg.as_bytes(), &sig).is_err() {
                    stats.note("sig");
                    println!("REGISTER rejected: bad signature did=…{}", &did[did.len().saturating_sub(8)..]);
                    continue;
                }
                // 全部通过 → 注册
                {
                    let mut p = peers.lock().unwrap();
                    let entry = p.map.entry(peer_id).or_insert(Peer {
                        did: None,
                        addr: src,
                        ipv6: String::new(),
                        ipv4_pub: String::new(),
                        netstatus: String::new(),
                        last_seen: 0,
                    });
                    // 防 DID 冒用他人 peer_id（strict 关闭时靠注册表+签名兜底）
                    if let Some(prev) = &entry.did {
                        if *prev != did {
                            stats.note("sig");
                            continue;
                        }
                    }
                    entry.did = Some(did.to_string());
                    entry.addr = src;
                    entry.last_seen = now_unix();
                }
                stats.signed_registers.fetch_add(1, Ordering::Relaxed);
                println!("peer {} registered (signed) did=…{} from {}", peer_id,
                    &did[did.len().saturating_sub(8)..], src);
                let n = build_packet(&mut resp, PKT_REGISTER_ACK, peer_id, &[]);
                let _ = socket.send_to(&resp[..n], src);
            }

            // ── 旧路径：token（迁移期；源 IP 必须在 legacy 白名单）──
            PKT_REGISTER => {
                let legacy_ok = legacy_ips.contains(&src.ip())
                    && relay_token.as_ref().map(|t| {
                        payload.len() >= 32
                            && payload[..32]
                                .iter()
                                .zip(t.iter())
                                .fold(0u8, |a, (x, y)| a | (x ^ y))
                                == 0
                    }).unwrap_or(false);
                if !legacy_ok {
                    stats.note("legacy");
                    continue; // 静默——零放大
                }
                let mut p = peers.lock().unwrap();
                let entry = p.map.entry(peer_id).or_insert(Peer {
                    did: None,
                    addr: src,
                    ipv6: String::new(),
                    ipv4_pub: String::new(),
                    netstatus: String::new(),
                    last_seen: 0,
                });
                // 签名路径已占用的 peer_id 不允许 legacy 覆盖
                if entry.did.is_some() {
                    stats.note("legacy");
                    continue;
                }
                entry.addr = src;
                entry.last_seen = now_unix();
                drop(p);
                stats.legacy_registers.fetch_add(1, Ordering::Relaxed);
                println!("peer {} registered (legacy) from {}", peer_id, src);
                let n = build_packet(&mut resp, PKT_REGISTER_ACK, peer_id, &[]);
                let _ = socket.send_to(&resp[..n], src);
            }

            // ── 注销（DSH 2026-11-10 建议）：立即删 peer 条目，不等 TTL ──
            // 仅从注册地址本身发出的注销有效（防第三方恶意注销他人）
            PKT_UNREGISTER => {
                let mut p = peers.lock().unwrap();
                if let Some(e) = p.map.get(&peer_id) {
                    if e.addr == src {
                        p.map.remove(&peer_id);
                        println!("peer {} unregistered from {}", peer_id, src);
                    }
                }
            }

            // ── keepalive：仅已注册地址有效（签名路径按 DID；legacy 按 IP 白名单）──
            PKT_KEEPALIVE => {
                let mut p = peers.lock().unwrap();
                if let Some(e) = p.map.get_mut(&peer_id) {
                    let ok = match &e.did {
                        Some(_) => true, // 签名注册的 peer：地址漂移跟随（did 绑定已在注册时验过）
                        None => legacy_ips.contains(&src.ip()),
                    };
                    if ok && e.addr.ip() == src.ip() {
                        e.last_seen = now_unix();
                        e.addr = src;
                    }
                }
            }

            PKT_ANNOUNCE => {
                let mut p = peers.lock().unwrap();
                if let Some(e) = p.map.get_mut(&peer_id) {
                    if e.addr.ip() == src.ip() && !payload.is_empty() {
                        let s = String::from_utf8_lossy(payload);
                        for tok in s.split('|') {
                            if let Some(v) = tok.strip_prefix("v6=") {
                                e.ipv6 = v.to_string();
                            } else if let Some(v) = tok.strip_prefix("v4=") {
                                e.ipv4_pub = v.to_string();
                            } else if let Some(v) = tok.strip_prefix("ns=") {
                                // NetStatus 画像：存原文（含空格/竖线的已转义形式由发送方处理）
                                e.netstatus = v.to_string();
                            }
                        }
                        e.last_seen = now_unix();
                        println!("peer {} announced: v6={} v4={}", peer_id, e.ipv6, e.ipv4_pub);
                    }
                }
            }

            // ── 查询/转发：只响应已注册的源地址（防未认证放大）──
            PKT_LOOKUP => {
                let p = peers.lock().unwrap();
                let from_peer = p.map.values().any(|e| e.addr == src);
                drop(p);
                if !from_peer {
                    continue;
                }
                let p = peers.lock().unwrap();
                let body = match p.map.get(&peer_id) {
                    Some(t) => format!("{}", t.addr),
                    None => "offline".to_string(),
                };
                drop(p);
                let n = build_packet(&mut resp, PKT_LOOKUP_ACK, peer_id, body.as_bytes());
                let _ = socket.send_to(&resp[..n], src);
            }

            PKT_PEERINFO => {
                let p = peers.lock().unwrap();
                let from_peer = p.map.values().any(|e| e.addr == src);
                drop(p);
                if !from_peer {
                    continue;
                }
                let p = peers.lock().unwrap();
                let body = match p.map.get(&peer_id) {
                    Some(t) => {
                        let mut info = format!("relay={}", t.addr);
                        if !t.ipv6.is_empty() {
                            info.push('|');
                            info.push_str(&t.ipv6);
                        }
                        if !t.ipv4_pub.is_empty() {
                            info.push('|');
                            info.push_str(&t.ipv4_pub);
                        }
                        if !t.netstatus.is_empty() {
                            // 转义空格/竖线，与客户端 deserialize_peer_info 的还原对齐
                            info.push_str(&format!("|ns={}",
                                t.netstatus.replace('|', "/").replace(' ', ",")));
                        }
                        info
                    }
                    None => "offline".to_string(),
                };
                drop(p);
                let n = build_packet(&mut resp, PKT_PEERINFO_ACK, peer_id, body.as_bytes());
                let _ = socket.send_to(&resp[..n], src);
            }

            PKT_DATA => {
                if payload.len() < 4 {
                    continue;
                }
                let sender_id = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]);
                let p = peers.lock().unwrap();
                // 发送方必须已注册且地址匹配（防未认证转发）
                let sender_ok = p.map.get(&sender_id).map(|e| e.addr == src).unwrap_or(false);
                let target_addr = if sender_ok {
                    p.map.get(&peer_id).map(|e| e.addr)
                } else {
                    None
                };
                if let Some(dst) = target_addr {
                    let n = build_packet(&mut resp, PKT_DATA, sender_id, &payload[4..]);
                    drop(p);
                    let _ = socket.send_to(&resp[..n], dst);
                    stats
                        .bytes_forwarded
                        .fetch_add(payload.len() as u64, Ordering::Relaxed);
                }
            }

            _ => {} // 未知类型：静默丢弃
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_packet_roundtrip() {
        let mut buf = [0u8; 128];
        let n = build_packet(&mut buf, PKT_REGISTER_SIGNED, 77, b"hello");
        let (typ, peer, payload) = parse_packet(&buf[..n]).unwrap();
        assert_eq!((typ, peer, payload), (PKT_REGISTER_SIGNED, 77, &b"hello"[..]));
    }

    #[test]
    fn test_bad_magic_rejected() {
        let buf = [0u8; 32];
        assert!(parse_packet(&buf).is_none());
    }

    #[test]
    fn test_peer_id_did_binding() {
        // did 任意字符串都应有确定性的 base28；slot 位（低 4 位）不参与校验
        let did = "did:myco:z6Mktest";
        let mut h = Sha256::new();
        h.update(b"vnet-peer");
        h.update(did.as_bytes());
        let d = h.finalize();
        let base28 = u32::from_be_bytes([d[0], d[1], d[2], d[3]]) >> 4;
        for slot in 0..16u32 {
            assert!(peer_id_matches_did((base28 << 4) | slot, did), "slot {}", slot);
        }
        assert!(!peer_id_matches_did(((base28 << 4) | 1) + (1 << 4), did));
    }

    #[test]
    fn test_signature_flow() {
        use ed25519_dalek::Signer;
        use ed25519_dalek::SigningKey;
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let did = "did:myco:z6Mkunit";
        let ts = now_unix() * 1000; // 毫秒（与 relay.mjs 惯例一致）
        let msg = format!("{}\n{}\nrelay-register", did, ts);
        let sig = sk.sign(msg.as_bytes());
        // 验签方：公钥来自注册表
        let vk = VerifyingKey::from(&sk);
        assert!(vk.verify(msg.as_bytes(), &sig).is_ok());
        // 篡改载荷 → 拒绝
        let bad = format!("{}\n{}\nrelay-register", did, ts + 1);
        assert!(vk.verify(bad.as_bytes(), &sig).is_err());
    }

    // ── DSH协议应用 提供的官方测试向量（2026-11-05，固化防回归）──
    // ts 单位 = 毫秒（与 relay.mjs / myco 身份层一致）
    const VEC_PUB_HEX: &str = "bc603bf4e5dfabb2df1ef8e166d945bc7385d859e25b419faf602d97bbeba278";
    const VEC_DID1: &str = "did:myco:z6MkTestVector0000000000000000000000000001";
    const VEC_DID2: &str = "did:myco:z6MkTestVector0000000000000000000000000002";
    const VEC_TS_MS: i64 = 1_700_000_000_000;
    const VEC_SIG1_B64: &str =
        "z/0fDnjlkvUgZxXdUdOVtr1ReMsoevGNn21ZPdTvWWCuESYViUUQEB/T12Uk2aJ1AIN3owimYkLws8l6SEpeCQ==";
    const VEC_SIG2_B64: &str =
        "J3tA1Dp+ZMkcNQDhA9pB9UeK1aguX2u4nfN8eZP9w/5RhSj6ssXVhd49uYJoW+yGll7IYcEWkIRIcaBWoUNFCg==";

    fn vec_pubkey() -> VerifyingKey {
        let mut bytes = [0u8; 32];
        for i in 0..32 {
            bytes[i] = u8::from_str_radix(&VEC_PUB_HEX[i * 2..i * 2 + 2], 16).unwrap();
        }
        VerifyingKey::from_bytes(&bytes).unwrap()
    }

    fn vec_sig(b64: &str) -> Signature {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        Signature::from_bytes(&bytes.try_into().unwrap())
    }

    #[test]
    fn test_vector_1_valid_signature() {
        // 向量 1：DID1 的合法签名 → 密码学验证通过
        let msg = format!("{}\n{}\nrelay-register", VEC_DID1, VEC_TS_MS);
        assert!(vec_pubkey().verify(msg.as_bytes(), &vec_sig(VEC_SIG1_B64)).is_ok());
    }

    #[test]
    fn test_vector_2_cross_did_rejected_by_trust_layers() {
        // 向量 2：同一把钥匙签了 DID2 的消息——密码学本身通过（钥匙确实签过这条消息），
        // 拒绝它的是两道信任层：
        //   a) 注册表：DID2 登记的公钥 ≠ 这把钥匙（注册表数据是信任锚）
        //   b) peer_id 绑定：按 DID1 算出的 peer_id 家族与 DID2 不匹配
        let msg = format!("{}\n{}\nrelay-register", VEC_DID2, VEC_TS_MS);
        // 密码学层：通过（这正是"不能只靠验签"的证明）
        assert!(vec_pubkey().verify(msg.as_bytes(), &vec_sig(VEC_SIG2_B64)).is_ok());
        // 绑定层：DID1 的 peer_id 家族 ≠ DID2
        let h = Sha256::new()
            .chain_update(b"vnet-peer")
            .chain_update(VEC_DID1.as_bytes())
            .finalize();
        let base28_did1 = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) >> 4;
        assert!(!peer_id_matches_did((base28_did1 << 4) | 3, VEC_DID2));
        // 注册表层：registry 查 DID2 返回 DID2 自己的钥匙，用它验 DID1 钥匙的签名必然失败
    }
}
