// vnet - UDP-first P2P tunnel with relay fallback
// RFC 8445 (ICE) + RFC 8489 (STUN) + RFC 4787 (NAT behavior)
// Apache 2.0 License - Pure Rust, no third-party code
//
// 设计核心：中继先用着，洞持续打着，通了就切，断了就回。


use clap::Parser;
use vnet::{connection, relay, stun, raise_timer_resolution};

/// 把 Windows 定时器精度提到 1ms。
///
/// 背景：Windows 默认定时器粒度是 15.625ms，`thread::sleep(1ms)` 实际会睡 ~15.6ms。
/// vnet 的接收线程与服务端主循环都是「poll + sleep(1ms)」结构，
/// 探测回复到达时线程大概率正处于这段睡眠中，实测 RTT 会被抬高数毫秒到十几毫秒。
/// 这个调用把进程级定时器分辨率提到 1ms，让 sleep(1ms) 真的接近 1ms。

#[derive(Parser)]
#[command(name = "vnet", version = "0.3.0", about = "UDP-first P2P tunnel - relay-first, P2P upgrade, continuous probing")]
struct Args {
    #[command(subcommand)]
    cmd: Command,
}

#[derive(clap::Subcommand)]
enum Command {
    /// 检测 NAT 类型（映射 × 过滤，RFC 4787 二维分类）
    StunTest {
        #[arg(long, default_value = "stun.chat.bilibili.com:3478")]
        server: String,
    },
    /// 查看运行态状态（读取运行中进程写的状态文件）
    Status {
        #[arg(long, help = "状态文件路径（默认系统临时目录 vnet-status.txt）")]
        file: Option<String>,
    },
    /// 探活 UDP 中继：发一次 REGISTER 等 ACK，判断 relay 是否可达/可用。
    /// 存在的理由（2026-11-09 事故）：relay 是 UDP-only，用 TCP 端口探测会永远失败，
    /// 于是健康的 relay 被判成"挂了"并触发客户端负缓存自锁。本命令给出确定答案。
    ProbeRelay {
        #[arg(long, default_value = "myco.youling.cc:28322")]
        relay: String,
        #[arg(long, help = "与 relay 侧配置一致的 secret（token 校验）")]
        secret: Option<String>,
        #[arg(long, help = "输出机器可读 JSON")]
        json: bool,
    },
    /// 生成开发/测试用身份密钥材料（seed/pub/key_id hex）。
    /// 生产密钥请用 myco 自己的密钥管理；本命令只为 CLI/评测提供可用材料。
    Keygen,
    /// 启动 UDP 中继服务器（部署在 ECS 上）
    RelayServer {
        #[arg(long, default_value = "0.0.0.0")]
        listen: String,
        #[arg(long, default_value = "8322")]
        port: u16,
    },
    /// 服务端模式：接收远端连接，转发到本地服务（如 RDP 3389）
    Server {
        #[arg(long)]
        relay: String,
        #[arg(long, help = "Pre-shared secret for end-to-end AES-256-GCM encryption (both sides must match)")]
        secret: Option<String>,
        #[arg(long, help = "Unique peer ID")]
        peer_id: u32,
        #[arg(long, default_value = "3389", help = "Local target service port")]
        target_port: u16,
    },
    /// 客户端模式：本地代理 → 竞速(中继+P2P) → 远端服务
    Client {
        #[arg(long)]
        relay: String,
        #[arg(long, help = "My unique peer ID")]
        peer_id: u32,
        #[arg(long, help = "Server peer ID to connect to")]
        target_peer_id: u32,
        #[arg(long, default_value = "23389", help = "Local proxy port for your app")]
        local_port: u16,
        #[arg(long, help = "Pre-shared secret for end-to-end AES-256-GCM encryption (both sides must match)")]
        secret: Option<String>,
        /// multi-forward：额外本地监听 LOCAL:TARGET（可重复）。
        /// 对端 server 须 >= 21197f08 且 target 在其白名单（--target-port 或 VNET_TARGET_PORTS）。
        #[arg(long = "forward", value_name = "LOCAL:TARGET")]
        forwards: Vec<String>,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = vnet::connection::boot_instant();   // 启动计时锚点
    // 必须在任何轮询线程启动前调用（Windows 有效，其他平台为空操作）
    raise_timer_resolution();

    let args = Args::parse();

    match args.cmd {
        Command::StunTest { server } => {
            let public_addr = stun::query_stun(&server, 0)?;
            println!("_querying STUN: {}", server);
            println!("  Public: {}", public_addr);

            match stun::detect_nat_profile().await {
                Ok(info) => {
                    println!("  Mapping:   {:?}", info.mapping);
                    println!("  Filtering: {:?}", info.filtering);
                    println!("  Difficulty: {:?}", info.difficulty());
                    println!("  Strategy:  {}", info.strategy());
                    if let Some(v6) = info.ipv6_addr {
                        println!("  IPv6:      {}", v6);
                    }
                }
                Err(e) => println!("  NAT detect failed: {}", e),
            }
        }
        Command::Status { file } => {
            let paths: Vec<std::path::PathBuf> = match file {
                Some(f) => vec![std::path::PathBuf::from(f)],
                None => {
                    // 列出临时目录下所有 vnet 状态文件（server 与 client 各一份，互不覆盖）
                    let mut v = connection::list_status_files();
                    v.sort();
                    if v.is_empty() { v.push(connection::status_file_path()); }
                    v
                }
            };
            for path in paths {
            match std::fs::read_to_string(&path) {
                Ok(body) => {
                    println!("vnet status  ({})", path.display());
                    println!("{}", "-".repeat(46));
                    for line in body.lines() {
                        if let Some((k, v)) = line.split_once('=') {
                            println!("  {:<18} {}", k, v);
                        }
                    }
                    println!();
                }
                Err(e) => {
                    println!("读取状态文件失败: {} ({})", path.display(), e);
                    println!("提示：vnet status 只能看到本机运行中的进程，请先启动 server 或 client");
                }
            }
            }
        }
        Command::ProbeRelay { relay, secret, json } => {
            // 用**生产 client 的同一个构造器**做探针（with_secret_and_port 内含注册+退避重试），
            // 保证「探针能过 ⇔ 生产 client 能注册」。第一版为了轻量自己拼 RelayClient，
            // 少了 PSK crypto，结果 relay 明明是活的却 8/8 报失败——探针与生产不同构就是假阴性制造机。
            let peer = 900_000u32 + (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u32)
                .unwrap_or(0) % 90_000);
            if json { vnet::relay::set_quiet(true); }
            let started = std::time::Instant::now();
            let outcome = vnet::connection::Connection::with_secret_and_port(
                &relay, peer, 0, secret.as_deref(), Some(0));
            let ms = started.elapsed().as_millis() as u64;
            let (ok, err) = match &outcome {
                Ok(_) => (true, String::new()),
                Err(e) => (false, format!("{:#}", e)),
            };
            if json {
                println!("{}", serde_json::json!({
                    "ok": ok, "relay": relay, "register_ms": ms,
                    "peer_id": peer, "error": err,
                }));
            } else if ok {
                println!("relay OK  {}  register {}ms (probe peer {})", relay, ms, peer);
            } else {
                println!("relay FAIL {}  {}ms  {}", relay, ms, err);
                println!("提示：relay 是 UDP-only，不要用 TCP 端口探测判断其死活");
            }
            if !ok { std::process::exit(2); }
        }
        Command::Keygen => {
            let (seed_hex, pub_hex, key_id) = vnet::identity::keygen_material();
            println!("{}", serde_json::json!({
                "seed_hex": seed_hex,
                "pub_hex": pub_hex,
                "key_id": key_id,
                "identity": format!("did:myco:dev-{}|{}|{}", key_id, key_id, seed_hex),
                "peer_key_entry": format!("{}|{}|{}", key_id, format!("did:myco:dev-{}", key_id), pub_hex),
            }));
        }
        Command::RelayServer { listen, port } => {
            println!("Starting UDP relay server on {}:{}", listen, port);
            let server = relay::UdpRelayServer::new(&listen, port)?;
            println!("  Ready. Ctrl+C to stop.");
            server.run();
        }
        Command::Server { relay, peer_id, target_port, secret } => {
            vnet::identity::init_from_env();   // VNET_IDENTITY / VNET_PEER_KEYS / VNET_VNETP_PORTS
            println!("vnet server (peer {})", peer_id);
            println!("  Relay: {}", relay);
            println!("  Target: 127.0.0.1:{}", target_port);
            connection::start_server_with_secret(&relay, peer_id, target_port, secret.as_deref())?;
        }
        Command::Client { relay, peer_id, target_peer_id, local_port, secret, forwards } => {
            vnet::identity::init_from_env();   // VNET_IDENTITY / VNET_PEER_KEYS
        // 签名注册凭据（CLI 测试用；产品路径由 myco 经 set_register_credentials 注入）：
        // VNET_REG_CRED="did|ts|sigB64"
        if let Ok(cred) = std::env::var("VNET_REG_CRED") {
            let parts: Vec<&str> = cred.split('|').collect();
            if parts.len() == 3 {
                if let Ok(ts) = parts[1].parse::<i64>() {
                    vnet::relay::set_register_credentials(parts[0], ts, parts[2]);
                    println!("  [REG] signed credentials loaded (did=…{})", &parts[0][parts[0].len().saturating_sub(8)..]);
                }
            }
        }
            println!("vnet client (peer {})", peer_id);
            println!("  Relay: {}", relay);
            println!("  Target peer: {}", target_peer_id);
            println!("  Local proxy: 127.0.0.1:{}", local_port);
            // --forward LOCAL:TARGET：multi-forward（task.md §11 H.2.1）
            let mut specs = Vec::new();
            for f in &forwards {
                let (l, t) = f.split_once(':').ok_or_else(|| {
                    anyhow::anyhow!("--forward expects LOCAL:TARGET, got {:?}", f)
                })?;
                let l: u16 = l.trim().parse()?;
                let t: u16 = t.trim().parse()?;
                specs.push(vnet::forward::ForwardSpec { local_port: l, target_port: t });
            }
            let conn = std::sync::Arc::new(
                connection::Connection::with_secret(&relay, peer_id, target_peer_id, secret.as_deref())?);
            println!("  [T+{:>7}ms] [BOOT] relay registered", vnet::connection::boot_instant().elapsed().as_millis());
            if !specs.is_empty() {
                conn.enable_multi_forward();
                for s in specs {
                    conn.add_forward(s)?;
                }
            }
            conn.start_client(local_port)?;
        }
    }
    Ok(())
}
