//! vnet CLI - 命令令行接口
//! stun-test / relay-server / node / connect

use crate::stun;
use crate::relay::RelayClient;
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;

/// STUN 测试：检测 NAT 映射 × 过滤二维画像
pub async fn stun_test(server: &str) -> anyhow::Result<()> {
    println!("_querying STUN server: {}", server);
    let public_addr = stun::query_stun(server, 0)?;
    println!("  Public address: {}", public_addr);

    match stun::detect_nat_profile().await {
        Ok(info) => {
            println!("  ┌─────────────────────────────────────┐");
            println!("  │ NAT Profile (RFC 4787)              │");
            println!("  ├─────────────────────────────────────┤");
            println!("  │ Mapping:   {:?}", info.mapping);
            println!("  │ Filtering: {:?}", info.filtering);
            println!("  │ Difficulty: {:?}", info.difficulty());
            println!("  │ Strategy:  {}", info.strategy());
            println!("  ├─────────────────────────────────────┤");
            println!("  │ Local IP:  {}", info.local_ip);
            println!("  │ Public:    {}", info.public_addr);
            if let Some(v6) = info.ipv6_addr {
                println!("  │ IPv6:      {}", v6);
            }
            println!("  └─────────────────────────────────────┘");
        }
        Err(e) => {
            println!("  NAT detection failed: {}", e);
        }
    }
    Ok(())
}

/// 启动 vnet 节点
/// 包含：本地 TCP 代理 + 中继客户端 + P2P 探测
pub async fn start_node(
    port: u16,
    local_proxy_port: u16,
    relay_addr: &str,
    peer_id: Option<u32>,
) -> anyhow::Result<()> {
    let my_id = peer_id.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as u32
    });

    println!("Starting vnet node");
    println!("  Peer ID: {}", my_id);
    println!("  Service port: {}", port);
    println!("  Local proxy: 127.0.0.1:{}", local_proxy_port);
    println!("  Relay: {}", relay_addr);

    // 1. 连接中继
    let relay_client = RelayClient::new(relay_addr, my_id)?;
    relay_client.register()?;
    println!("  [OK] Registered to relay");

    // 2. 启动本地 TCP 代理（上层应用连接这里）
    let proxy_addr = format!("127.0.0.1:{}", local_proxy_port);
    let listener = TcpListener::bind(&proxy_addr)?;
    println!("  [OK] Local proxy listening on {}", proxy_addr);

    // 3. 主循环：接收本地连接 + 转发数据
    println!("  [OK] Node ready. Waiting for connections...");
    println!("  (Press Ctrl+C to stop)");

    // 中继保活线程
    let relay_keepalive = relay_client;
    thread::spawn(move || {
        loop {
            relay_keepalive.keepalive();
            thread::sleep(std::time::Duration::from_secs(30));
        }
    });

    // 接收本地 TCP 连接并转发
    for stream in listener.incoming() {
        match stream {
            Ok(client_stream) => {
                println!("  [>>] Local connection from {}", client_stream.peer_addr()?);
                handle_local_connection(client_stream, relay_addr, my_id)?;
            }
            Err(e) => {
                eprintln!("  [!!] Accept error: {}", e);
            }
        }
    }

    Ok(())
}

/// 处理本地 TCP 连接：127.0.0.1:port → 通过中继/P2P 转发到远端
fn handle_local_connection(
    client: TcpStream,
    relay_addr: &str,
    my_id: u32,
) -> anyhow::Result<()> {
    // 为这个连接创建独立的中继客户端
    let relay = RelayClient::new(relay_addr, my_id)?;

    // 双向转发：本地 TCP → 中继 → 远端
    let client_read = client.try_clone()?;
    let client_write = client.try_clone()?;
    let relay_read = relay;

    // 上行：本地 TCP 读 → 中继发
    let up_relay = RelayClient::new(relay_addr, my_id)?;
    let up_handle = thread::spawn(move || {
        use std::io::{Read, Write};
        let mut buf = [0u8; 65536];
        let mut stream = client_read;
        loop {
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    // 通过中继发送（目标 peer_id 从连接上下文获取）
                    // TODO: 需要知道目标 peer_id
                    let _ = up_relay.send_to_peer(0, &buf[..n]);
                }
            }
        }
    });

    // 下行：中继收 → 本地 TCP 写
    let down_handle = thread::spawn(move || {
        use std::io::Write;
        let mut stream = client_write;
        let relay = relay_read;
        loop {
            if let Some((_, data)) = relay.try_recv() {
                if stream.write_all(&data).is_err() {
                    break;
                }
            } else {
                thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    });

    let _ = up_handle.join();
    let _ = down_handle.join();
    Ok(())
}

/// 连接到远程节点
pub async fn connect(
    peer_id: u32,
    target_port: u16,
    local_port: u16,
    relay_addr: &str,
) -> anyhow::Result<()> {
    println!("Connecting to peer {}...", peer_id);
    println!("  Target port: {}", target_port);
    println!("  Local port: {}", local_port);
    println!("  Relay: {}", relay_addr);

    let my_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as u32;

    let relay = RelayClient::new(relay_addr, my_id)?;
    relay.register()?;

    // 查询 peer 地址
    if let Some(peer_addr) = relay.lookup_peer(peer_id) {
        println!("  [OK] Peer {} is at {}", peer_id, peer_addr);
    } else {
        println!("  [!!] Peer {} not found or offline", peer_id);
    }

    // TODO: Full P2P probe + data forwarding
    println!("  (Data forwarding in progress)");
    Ok(())
}

/// 显示状态
pub async fn status() -> anyhow::Result<()> {
    println!("vnet status:");
    println!("  (No active sessions)");
    Ok(())
}
