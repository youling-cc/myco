// Cloud relay fallback for tunnel_acquire
// When P2P direct fails, connect through the cloud relay (myco.youling.cc:8322)

use tokio::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const RELAY_HOST: &str = "myco.youling.cc";
/// **8321（mux，首行嗅探分流）**——与手机 `RelayTunnel.DEFAULT_PORT` 同一个世界。
/// 2026-10-12 真机排障：这里原写 8322（宿主机 relay-standalone.mjs 直连口），
/// 但手机的 provider 注册/各端 CONNECT 都走 8321（docker mux 嗅探后转 relay）——
/// **两个实例的注册表不互通**：PC 注册进 8322 对 8321 的 CONNECT 永远
/// NOT_FOUND（笔记本取票 502 的深层根因）。统一到 8321。
const RELAY_PORT: u16 = 8321;

// ── 2026-10-11 提速：中继 TCP 预连池 ──
//
// 中继腿的耗时构成：TCP 握手（1×RTT）→ CONNECT 行 → OK → WS 升级。公网 RTT
// ~35-50ms，TCP 握手纯白付——presence 确认对端在线 / 隧道刚建立时，后台先把
// TCP 握手做完（**不上协议**：一行都不发，中继服务端的嗅探窗 15s 内有效），
// 真要用 CONNECT 时从池里拎一条现成的。
//
// 池参数：深 2；条目寿命 8s（服务端嗅探窗 15s 留余量——过期条目直接弃用，
// 后台续拨）。生产由 p2p_tunnel 调 [`predial_refill`]（presence 命中/隧道建立/
// 每次中继腿用后）；测试态全链 no-op（单测不触网纪律）。

/// 预连池深。
const PREDIAL_POOL: usize = 2;
/// 条目寿命（秒）：超龄弃用（中继嗅探窗 15s 内才有效）。
const PREDIAL_TTL_SECS: u64 = 8;

struct PredialConn {
    host: String,
    port: u16,
    stream: TcpStream,
    born: std::time::Instant,
}

static PREDIAL: std::sync::LazyLock<std::sync::Mutex<Vec<PredialConn>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(Vec::new()));

/// 条目是否仍新鲜（纯函数口径：`born` 距 `now` 不足 TTL）。
fn predial_fresh(born: std::time::Instant, now: std::time::Instant) -> bool {
    now.duration_since(born) < std::time::Duration::from_secs(PREDIAL_TTL_SECS)
}

/// 后台补池（非阻塞：拨号在 spawn 里做）：把 (host,port) 的预连补到水位。
/// 同址已有足够新鲜条目就不拨；不同址的旧条目顺手清掉（地址变了就别占着）。
/// 测试态 no-op。
pub fn predial_refill(host: String, port: u16) {
    #[cfg(test)]
    {
        let _ = (&host, port);
        return;
    }
    #[cfg(not(test))]
    {
        let need = {
            let now = std::time::Instant::now();
            let mut g = PREDIAL.lock().unwrap();
            g.retain(|c| (c.host == host && c.port == port) && predial_fresh(c.born, now));
            g.len() < PREDIAL_POOL
        };
        if !need {
            return;
        }
        let target = format!("{host}:{port}");
        tokio::spawn(async move {
            // 只握手不上协议（一行都不发——服务端 15s 嗅探窗内有效）
            match tokio::time::timeout(
                std::time::Duration::from_secs(3),
                TcpStream::connect(&target),
            )
            .await
            {
                Ok(Ok(stream)) => {
                    let _ = stream.set_nodelay(true);
                    let now = std::time::Instant::now();
                    let mut g = PREDIAL.lock().unwrap();
                    g.retain(|c| (c.host == host && c.port == port) && predial_fresh(c.born, now));
                    if g.len() < PREDIAL_POOL {
                        g.push(PredialConn { host, port, stream, born: now });
                    }
                    // 没挤进去（并发补池赢了）就放手——连接 drop 即关
                }
                _ => {} // 预连是纯优化：失败静默（真用腿时现拨照常）
            }
        });
    }
}

/// 取一条 (host,port) 的预连 TCP（最新鲜的先出）；同址过期条目就地丢弃。
/// 池空/测试态 → None（调用方现拨，行为不变）。
pub fn predial_take(host: &str, port: u16) -> Option<TcpStream> {
    let now = std::time::Instant::now();
    let mut g = PREDIAL.lock().unwrap();
    // 同址过期条目顺手清（地址不同的留给它们的主人）
    g.retain(|c| !(c.host == host && c.port == port && !predial_fresh(c.born, now)));
    let idx = g
        .iter()
        .rposition(|c| c.host == host && c.port == port && predial_fresh(c.born, now))?;
    Some(g.swap_remove(idx).stream)
}

/// Check if force direct mode is enabled (skip relay)
pub fn force_direct() -> bool {
    std::env::var("MYCO_FORCE_DIRECT").map(|v| v == "1").unwrap_or(false)
}

/// Connect to the cloud relay as a consumer (get a tunnel to the target device)
/// Returns a TcpStream that's already paired with the provider (target device).
pub async fn relay_connect(target_device_did: &str) -> Result<TcpStream, String> {
    let addr = format!("{}:{}", RELAY_HOST, RELAY_PORT);
    let stream = TcpStream::connect(&addr)
        .await
        .map_err(|e| format!("云端中转服务器不可达（{}）：{}", addr, e))?;
    
    stream.set_nodelay(true).ok();
    
    // Send CONNECT command
    let cmd = format!("CONNECT {}\n", target_device_did);
    use tokio::io::{AsyncWriteExt, AsyncReadExt};
    let mut stream = stream;
    stream.write_all(cmd.as_bytes()).await
        .map_err(|e| format!("发送中转请求失败：{}", e))?;
    
    // Read response (expect "OK\n")
    let mut buf = [0u8; 64];
    let n = stream.read(&mut buf).await
        .map_err(|e| format!("读取中转响应失败：{}", e))?;
    let resp = String::from_utf8_lossy(&buf[..n]);
    
    if resp.starts_with("OK") {
        tracing::info!("[relay] 云端中转连接成功 → {}", target_device_did.chars().rev().take(12).collect::<String>().chars().rev().collect::<String>());
        Ok(stream)
    } else if resp.starts_with("NOT_FOUND") {
        Err("对方设备不在线（云端中转无此设备）".to_string())
    } else {
        Err(format!("中转服务器响应异常：{}", resp.trim()))
    }
}

/// Background task: register this device as a provider on the relay
/// Keeps the connection alive with periodic heartbeats.
///
/// 2026-10-12 补完（真机复现定案）：原实现只 REGISTER+心跳，**从不消费
/// SESSION/ACCEPT**——其他设备（笔记本 remoteOpen 的中继腿）CONNECT 本机时会
/// 配对成功，但配对后的裸字节管无人接，隧道照样死（笔记本取票 502
/// "源设备不在线（或那台设备没有可直连的地址）"的根因之一）。
/// 现补齐 provider 半边（协议与手机 `RelayProvider.java` 同款）：
///   · REGISTER 控制连接 + 30s 空闲心跳（空行）；
///   · `SESSION <sid>` → **开新连接**回 `ACCEPT <did> <sid>` → 裸管双向泵到
///     本地隧道面（`p2p_server::p2p_port()`——进来的流是隧道协议：对端会在
///     其上发 WS upgrade，由 p2p_server 照常处理，与手机把 ACCEPT 泵到本地
///     TunnelProxyServer 端口完全同构）。
///   · 身份未就绪（登录前）也重试等待，而不是退出。
pub async fn relay_provider_start() {
    tokio::spawn(async {
        loop {
            match myco_core::identity::device_identity() {
                Ok((d, _)) => {
                    if let Err(e) = provider_control_loop(&d).await {
                        relay_trace(&format!("[provider] 控制连接断开：{e}（1s 后重连）"));
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
                Err(_) => {
                    // 身份未就绪（启动早期）：2s 后再试（旧实现直接 return，永远不注册）
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            }
        }
    });
}

/// provider 侧落盘日志（2026-10-12 真机排障：release GUI 无 stdout，tracing 不
/// 落盘=盲区。写 config_dir()/relay-trace.log，400KB 滚动——承 chat_ui_trace 纪律）。
fn relay_trace(line: &str) {
    use std::io::Write;
    let dir = myco_core::config::config_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("relay-trace.log");
    if let Ok(md) = std::fs::metadata(&path) {
        if md.len() > 400 * 1024 {
            let _ = std::fs::rename(&path, dir.join("relay-trace.log.old"));
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let ts = chrono::Local::now().format("%H:%M:%S%.3f");
        let _ = writeln!(f, "{ts} {line}");
    }
}

/// 2026-11-04 P0：设备 Ed25519 签名（relay REGISTER 防劫持）。
/// sig = ed25519.sign(`${did}\n${ts}\nrelay-register`, devicePrivKey)
/// 返回 base64 编码的签名字节。
fn relay_register_sig(did: &str, ts: u128) -> Result<String, String> {
    use ed25519_dalek::{Signer, SigningKey};
    let (_, seed_b64) = myco_core::identity::device_identity()?;
    let seed_bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        seed_b64.as_bytes(),
    )
    .map_err(|e| format!("seed base64 解码失败：{e}"))?;
    let mut seed = [0u8; 32];
    if seed_bytes.len() != 32 {
        return Err("seed 长度异常".into());
    }
    seed.copy_from_slice(&seed_bytes);
    let sk = SigningKey::from_bytes(&seed);
    let msg = format!("{}\n{}\nrelay-register", did, ts);
    let sig = sk.sign(msg.as_bytes());
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(sig.to_bytes()))
}

/// provider 控制连接主循环：REGISTER → OK → 循环读（SESSION 行→ACCEPT 泵；空行=心跳回显/保活）。
async fn provider_control_loop(device_did: &str) -> Result<(), String> {
    use tokio::io::{AsyncWriteExt, AsyncBufReadExt};

    let addr = format!("{}:{}", RELAY_HOST, RELAY_PORT);
    let stream = TcpStream::connect(&addr).await.map_err(|e| format!("连接失败：{e}"))?;
    stream.set_nodelay(true).ok();
    let (rd, mut wr) = stream.into_split();

    // 2026-11-04 P0 签名：优先发带签名的 REGISTER（新 relay 验签），
    // 签名失败（如 identity 未就绪）退回无签名（grace 期 WARN 放行）。
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let register_cmd = match relay_register_sig(device_did, ts) {
        Ok(sig_b64) => format!("REGISTER {} {} {}\n", device_did, ts, sig_b64),
        Err(e) => {
            relay_trace(&format!("[provider] 签名失败退回无签名（{e}）"));
            format!("REGISTER {}\n", device_did)
        }
    };
    wr.write_all(register_cmd.as_bytes()).await
        .map_err(|e| format!("发送注册失败：{e}"))?;
    relay_trace(&format!("[provider] REGISTER 已发（{addr}, signed={}）", register_cmd.contains(' ')));
    let mut reader = tokio::io::BufReader::new(rd);

    // 心跳写任务（**20s** 空行——2026-10-13 实测服务器空闲阈值在 20-30s 之间，
    // 30s 心跳踩边界被杀（Rust 稳定 30.0x 断），20s 心跳探针 75s 稳活）。
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
            if wr.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });

    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).await.map_err(|e| format!("读失败：{e}"))?;
        if n == 0 {
            relay_trace("[provider] 对端关闭（EOF）——将重连");
            return Err("对端关闭".into());
        }
        let t = line.trim();
        if t.is_empty() {
            continue; // 心跳回显/保活空行
        }
        relay_trace(&format!("[provider] 收到行：{}", &t.chars().take(60).collect::<String>()));
        if let Some(sid) = t.strip_prefix("SESSION ") {
            let sid = sid.trim().to_string();
            let did = device_did.to_string();
            tokio::spawn(async move {
                if let Err(e) = accept_and_pump(&did, &sid).await {
                    relay_trace(&format!("[provider] ACCEPT {sid} 失败：{e}"));
                }
            });
        }
        // 其他行（OK 等）忽略
    }
}

/// 新连接回 ACCEPT → 裸管与本地隧道面（p2p_port）双向泵。
///
/// **2026-10-13 破案修正**：服务器（relay.mjs ACCEPT 分支）**不向 provider 回
/// 应答**——`OK\n` 只写给 consumer；provider 写完 ACCEPT 行，服务器立刻把
/// consumer 已缓冲的字节灌进来（首行就是隧道 WS upgrade 的 "GET /p2p/tunnel
/// HTTP/1.1"）。旧版在这读"OK 应答"会把 upgrade 首行当应答吞掉（真机探针
/// 实证：`ACCEPT 被拒：GET /p2p/tunnel HTTP/1.1`）→ 隧道必死。写完即泵。
async fn accept_and_pump(device_did: &str, sid: &str) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let addr = format!("{}:{}", RELAY_HOST, RELAY_PORT);
    let mut relay = TcpStream::connect(&addr).await.map_err(|e| format!("连接失败：{e}"))?;
    relay.set_nodelay(true).ok();

    relay.write_all(format!("ACCEPT {device_did} {sid}\n").as_bytes()).await
        .map_err(|e| format!("发送 ACCEPT 失败：{e}"))?;

    // 泵到本地隧道面（进来的流 = 隧道协议：对端在其上做 WS upgrade）
    // CLI/headless 变体没有 p2p_server（它随 GUI 变体编译）——provider 中继只在 GUI 侧有意义；
    // CLI 构建下显式报错（与 cli.rs 里 p2p tunnel drop 的 GUI-only 口径一致）。
    #[cfg(feature = "gui")]
    let local_port = crate::p2p_server::p2p_port().max(1);
    #[cfg(not(feature = "gui"))]
    let local_port = {
        let _ = (device_did, sid);
        return Err("cloud_relay provider 仅 GUI 构建可用（CLI/headless 无 p2p_server）".into());
    };
    let mut local = TcpStream::connect(("127.0.0.1", local_port)).await
        .map_err(|e| format!("连本地隧道面 :{local_port} 失败：{e}"))?;
    local.set_nodelay(true).ok();

    relay_trace(&format!("[provider] 中继入站就绪：relay/{sid} ⇄ 127.0.0.1:{local_port}"));
    let _ = tokio::io::copy_bidirectional(&mut relay, &mut local).await;
    Ok(())
}
