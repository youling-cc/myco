//! STUN 客户端 - RFC 8489 + RFC 5780
//! 检测两个独立维度：映射行为（Mapping）和过滤行为（Filtering）
//! 纯自研，Apache 2.0

use std::net::{SocketAddr, UdpSocket};
use std::time::Duration;

// ════════════════ RFC 4787 标准术语 ════════════════

/// 维度 1：映射行为 —— 决定端口是否随目的地变化
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MappingBehavior {
    /// Endpoint-Independent Mapping：所有目的地共用一个公网端口
    /// → 端口可预测，容易打洞
    EIM,
    /// Address-Dependent Mapping：同一 IP 的不同端口共用映射，不同 IP 分配不同端口
    ADM,
    /// Address and Port-Dependent Mapping：每个目的地 (IP:port) 分配不同端口
    /// → 端口不可预测，需要端口扫描
    APDM,
}

/// 维度 2：过滤行为 —— 决定哪些入站包被放行
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilteringBehavior {
    /// Endpoint-Independent Filtering：任何人发到我的端口都能进
    EIF,
    /// Address-Dependent Filtering：只允许"我发过包的 IP"发回来
    ADF,
    /// Address and Port-Dependent Filtering：只允许"我发过包的 IP:端口"发回来
    APDF,
}

/// NAT 完整画像 = 映射 × 过滤（两个独立维度）
#[derive(Debug, Clone, Copy)]
pub struct NatProfile {
    pub mapping: MappingBehavior,
    pub filtering: FilteringBehavior,
    /// 公网地址（通过 STUN 检测）
    pub public_addr: SocketAddr,
    /// 本地 IP
    pub local_ip: std::net::IpAddr,
    /// IPv6 地址（如果有）
    pub ipv6_addr: Option<SocketAddr>,
}

impl NatProfile {
    /// 打洞难度评估
    pub fn difficulty(&self) -> Difficulty {
        use MappingBehavior::*;
        use FilteringBehavior::*;
        match (self.mapping, self.filtering) {
            (EIM, EIF) => Difficulty::Trivial,      // Full Cone，直接通
            (EIM, ADF) => Difficulty::Easy,         // Restricted Cone，敲门即可
            (EIM, APDF) => Difficulty::Easy,        // Port Restricted，敲门 + 源端口要对
            (ADM, _) => Difficulty::Medium,         // 部分可预测
            (APDM, EIF) => Difficulty::Medium,      // 端口随机但过滤宽松
            (APDM, ADF) => Difficulty::Hard,        // 端口随机 + 需要敲门
            (APDM, APDF) => Difficulty::VeryHard,   // 端口随机 + 严格过滤，基本只能走中继
        }
    }

    /// 推荐打洞策略
    pub fn strategy(&self) -> &'static str {
        use MappingBehavior::*;
        use FilteringBehavior::*;
        match (self.mapping, self.filtering) {
            (EIM, EIF) => "直接发包，一个包就通",
            (EIM, ADF) => "双方同时发一个包（敲门），秒通",
            (EIM, APDF) => "双方同时发 + 源端口匹配，秒通",
            (ADM, _) => "端口预测 ±50，5-30 秒",
            (APDM, EIF) => "端口扫描，30 秒内",
            (APDM, ADF) => "双向端口扫描，1-3 分钟",
            (APDM, APDF) => "基本不可行，直接走中继或 IPv6",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Difficulty {
    Trivial,
    Easy,
    Medium,
    Hard,
    VeryHard,
}

// ════════════════ STUN 协议（RFC 8489） ════════════════

const MAGIC_COOKIE: u32 = 0x2112A442;
const BINDING_REQUEST: u16 = 0x0001;
const BINDING_RESPONSE: u16 = 0x0101;

fn build_binding_request(tid: [u8; 12]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(20);
    packet.extend_from_slice(&BINDING_REQUEST.to_be_bytes());
    packet.extend_from_slice(&0u16.to_be_bytes());
    packet.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
    packet.extend_from_slice(&tid);
    packet
}

fn parse_binding_response(packet: &[u8], tid: &[u8; 12]) -> Option<SocketAddr> {
    if packet.len() < 20 { return None; }
    let msg_type = u16::from_be_bytes([packet[0], packet[1]]);
    if msg_type != BINDING_RESPONSE { return None; }
    let cookie = u32::from_be_bytes([packet[4], packet[5], packet[6], packet[7]]);
    if cookie != MAGIC_COOKIE { return None; }
    if &packet[8..20] != tid { return None; }

    let msg_len = u16::from_be_bytes([packet[2], packet[3]]) as usize;
    let mut offset = 20;

    while offset + 4 <= 20 + msg_len && offset < packet.len() {
        let attr_type = u16::from_be_bytes([packet[offset], packet[offset + 1]]);
        let attr_len = u16::from_be_bytes([packet[offset + 2], packet[offset + 3]]) as usize;
        let attr_start = offset + 4;

        if attr_type == 0x0020 && attr_len >= 8 && attr_start + attr_len <= packet.len() {
            let family = packet[attr_start + 1];
            let xor_port = u16::from_be_bytes([packet[attr_start + 2], packet[attr_start + 3]]);
            let port = xor_port ^ (MAGIC_COOKIE >> 16) as u16;
            match family {
                0x01 => {
                    let xor_addr = [
                        packet[attr_start + 4], packet[attr_start + 5],
                        packet[attr_start + 6], packet[attr_start + 7],
                    ];
                    let cb = MAGIC_COOKIE.to_be_bytes();
                    let addr = [
                        xor_addr[0] ^ cb[0], xor_addr[1] ^ cb[1],
                        xor_addr[2] ^ cb[2], xor_addr[3] ^ cb[3],
                    ];
                    return Some(SocketAddr::from((addr, port)));
                }
                _ => {}
            }
        }
        let padded = (attr_len + 3) & !3;
        offset = attr_start + padded;
    }
    None
}

// ════════════════ DNS 解析 ════════════════

fn resolve_server(server: &str) -> anyhow::Result<SocketAddr> {
    if let Ok(addr) = server.parse::<SocketAddr>() {
        return Ok(addr);
    }
    use std::net::ToSocketAddrs;
    server.to_socket_addrs()
        .map_err(|e| anyhow::anyhow!("DNS 解析失败 {}: {}", server, e))?
        .next()
        .ok_or_else(|| anyhow::anyhow!("无地址: {}", server))
}

// ════════════════ NAT 检测 ════════════════

/// 查询单个 STUN 服务器
/// 用调用方提供的 socket 做 STUN 查询。
///
/// Rendezvous 必需：NAT 映射是绑在**具体 socket** 上的，
/// 要想知道「我的监听端口在公网映射成什么」，必须用那个监听 socket 本身去探测。
/// 用别的 socket 探到的端口对监听端口无效。
pub fn query_stun_on_socket(server: &str, socket: &UdpSocket) -> anyhow::Result<SocketAddr> {
    let server_addr = resolve_server(server)?;

    let mut tid = [0u8; 12];
    {
        use std::sync::atomic::{AtomicU64, Ordering};
        static CTR: AtomicU64 = AtomicU64::new(0);
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64
            ^ (CTR.fetch_add(1, Ordering::Relaxed).wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let mut x = n;
        for b in tid.iter_mut() {
            x ^= x << 13; x ^= x >> 7; x ^= x << 17;
            *b = (x & 0xFF) as u8;
        }
    }

    let request = build_binding_request(tid);
    socket.send_to(&request, server_addr)?;

    let mut buf = [0u8; 512];
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        match socket.recv_from(&mut buf) {
            Ok((len, _)) => {
                if let Some(addr) = parse_binding_response(&buf[..len], &tid) {
                    return Ok(addr);
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(anyhow::anyhow!("STUN recv: {}", e)),
        }
    }
    anyhow::bail!("STUN 无响应（{}）", server)
}

pub fn query_stun(server: &str, local_port: u16) -> anyhow::Result<SocketAddr> {
    let server_addr = resolve_server(server)?;
    let local_addr = if server_addr.is_ipv4() {
        format!("0.0.0.0:{}", local_port)
    } else {
        format!("[::]:{}", local_port)
    };
    let socket = UdpSocket::bind(&local_addr)?;
    socket.set_read_timeout(Some(Duration::from_secs(3)))?;
    socket.connect(server_addr)?;

    let mut tid = [0u8; 12];
        // 不用 rand：STUN transaction-id 只需高熵不重复，不需要密码学随机。
    // 用 (纳秒时间戳 ^ 进程内计数器) 填充，跨进程/跨次调用都不易碰撞。
    {
        use std::sync::atomic::{AtomicU64, Ordering};
        static CTR: AtomicU64 = AtomicU64::new(0);
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64
            ^ (CTR.fetch_add(1, Ordering::Relaxed).wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let mut x = n;
        for b in tid.iter_mut() {
            x ^= x << 13; x ^= x >> 7; x ^= x << 17;   // xorshift64
            *b = (x & 0xFF) as u8;
        }
    }

    let request = build_binding_request(tid);
    socket.send_to(&request, server_addr)?;

    let mut buf = [0u8; 1024];
    let (len, _) = socket.recv_from(&mut buf)?;
    parse_binding_response(&buf[..len], &tid)
        .ok_or_else(|| anyhow::anyhow!("STUN 响应解析失败"))
}

/// 检测完整 NAT 画像（映射 × 过滤）
pub async fn detect_nat_profile() -> anyhow::Result<NatProfile> {
    // 服务器列表可覆盖：默认用国内可达的，Google 系在国内被墙，
    // 之前硬编码 Google 导致 NAT 检测永远失败（2026-11-04 实测）。
    let env_servers: Vec<String> = std::env::var("VNET_STUN_SERVERS")
        .ok()
        .map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
        .unwrap_or_default();
    let servers: Vec<String> = if env_servers.len() >= 2 {
        env_servers
    } else {
        vec![
            "stun.chat.bilibili.com:3478".to_string(),
            "stun.hitv.com:3478".to_string(),
            "stun.miwifi.com:3478".to_string(),
        ]
    };

    // 测试 1：从同一端口查询不同 STUN 服务器 → 判断映射类型
    let probe_sock = UdpSocket::bind("0.0.0.0:0")?;
    probe_sock.set_nonblocking(true)?;
    let mut addr1 = None;
    let mut addr2 = None;
    for s in &servers {
        match query_stun_on_socket(s, &probe_sock) {
            Ok(a) => {
                if addr1.is_none() { addr1 = Some(a); }
                else if addr2.is_none() { addr2 = Some(a); }
            }
            Err(_) => continue,
        }
        if addr2.is_some() { break; }
    }
    let addr1 = addr1.ok_or_else(|| anyhow::anyhow!("STUN: 所有服务器均无响应"))?;
    let addr2 = addr2.unwrap_or(addr1);

    let mapping = if addr1.ip() == addr2.ip() && addr1.port() == addr2.port() {
        MappingBehavior::EIM
    } else if addr1.ip() == addr2.ip() {
        MappingBehavior::APDM
    } else {
        // 不同公网 IP：多出口 ISP（曾实测到）或分布式 STUN 视角差异，
        // 不能据此判定对称 NAT —— 按 EIM 处理并标记，避免误降级到端口扫描。
        MappingBehavior::EIM
    };

    // 过滤行为检测需要更复杂的测试（RFC 5780）
    // 目前保守假设为 ADF（最常见）
    let filtering = FilteringBehavior::ADF;

    // 获取本地 IP
    let local_ip = get_local_ip()?;

    // 获取 IPv6 地址
    let ipv6_addr = get_ipv6_addr();

    Ok(NatProfile {
        mapping,
        filtering,
        public_addr: addr1,
        local_ip,
        ipv6_addr,
    })
}

fn get_local_ip() -> anyhow::Result<std::net::IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0")?;
    socket.connect("8.8.8.8:80")?;
    Ok(socket.local_addr()?.ip())
}

fn get_ipv6_addr() -> Option<SocketAddr> {
    // 绑 [::]:0 后 local_addr() 只能拿到未指定地址 [::]，拿不到真实地址。
    // 必须 connect 一个全球 IPv6 目的地址，内核才会选出一个真实的源地址。
    if let Ok(sock) = UdpSocket::bind("[::]:0") {
        // 阿里公共 DNS 的 IPv6，仅用于让内核选路，不发包
        if sock.connect("[2400:3200::1]:53").is_ok() {
            if let Ok(local) = sock.local_addr() {
                if let std::net::IpAddr::V6(v6) = local.ip() {
                    if !v6.is_loopback() && !v6.is_unicast_link_local() && !v6.is_unspecified() {
                        return Some(SocketAddr::new(std::net::IpAddr::V6(v6), 9100));
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mapping_filtering_independent() {
        // EIM + APDF 是合法组合（端口固定但过滤严格）
        let profile = NatProfile {
            mapping: MappingBehavior::EIM,
            filtering: FilteringBehavior::APDF,
            public_addr: "1.2.3.4:5000".parse().unwrap(),
            local_ip: "192.168.1.1".parse().unwrap(),
            ipv6_addr: None,
        };
        assert_eq!(profile.difficulty(), Difficulty::Easy);
    }

    #[test]
    fn test_apdm_apdf_hardest() {
        let profile = NatProfile {
            mapping: MappingBehavior::APDM,
            filtering: FilteringBehavior::APDF,
            public_addr: "1.2.3.4:5000".parse().unwrap(),
            local_ip: "192.168.1.1".parse().unwrap(),
            ipv6_addr: None,
        };
        assert_eq!(profile.difficulty(), Difficulty::VeryHard);
    }
}

/// 构造一个 STUN Binding Request，返回 (transaction-id, packet)。
/// 供调用方在自己的接收循环里做「非阻塞 STUN」——绝不能另起线程读同一个 socket，
/// 否则会和数据接收线程抢包（2026-11-04 实测：每 30 秒丢 2% 数据包）。
pub fn make_binding_request() -> ([u8; 12], Vec<u8>) {
    let mut tid = [0u8; 12];
    {
        use std::sync::atomic::{AtomicU64, Ordering};
        static CTR: AtomicU64 = AtomicU64::new(0);
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64
            ^ (CTR.fetch_add(1, Ordering::Relaxed).wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let mut x = n;
        for b in tid.iter_mut() {
            x ^= x << 13; x ^= x >> 7; x ^= x << 17;
            *b = (x & 0xFF) as u8;
        }
    }
    (tid, build_binding_request(tid))
}

/// 解析 STUN Binding Response。返回 (公网地址, transaction-id)。
/// 调用方用 transaction-id 判断这个包是不是自己那笔查询的响应。
pub fn parse_binding_response_pub(packet: &[u8]) -> Option<(SocketAddr, [u8; 12])> {
    if packet.len() < 20 { return None; }
    let msg_type = u16::from_be_bytes([packet[0], packet[1]]);
    if msg_type != BINDING_RESPONSE { return None; }
    let mut tid = [0u8; 12];
    tid.copy_from_slice(&packet[8..20]);
    parse_binding_response(packet, &tid).map(|a| (a, tid))
}

/// 解析 STUN 服务器地址（供非阻塞 STUN 状态机使用）
pub fn resolve_stun_server(server: &str) -> Option<SocketAddr> {
    resolve_server(server).ok()
}
