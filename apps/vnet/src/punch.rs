//! vnet P2P 打洞引擎
//! 目标：性能不弱于 EasyTier（跨运营商 P2P ≤65ms）
//!
//! 策略（从最便宜到最贵，全部并行）：
//! 1. IPv6 直连（如果有，不需要打洞）
//! 2. UDP 简单打洞（Cone NAT，1个包就通）
//! 3. 端口预测（APDM-Sequential，±50 端口范围扫描）
//! 4. 多 socket 批量打洞（APDM-Random，20 个 socket 并发）
//! 5. 持续探测（永远不停，探测包就是保活）
//!
//! 关键设计：探测包 = 敲门 = 保活，三位一体

use crate::probe;
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 打洞结果
#[derive(Debug, Clone)]
pub struct PunchResult {
    /// 打通的直接地址
    pub peer_addr: SocketAddr,
    /// 是否 IPv6
    pub is_ipv6: bool,
    /// RTT
    pub rtt_ms: u64,
    /// 用了什么方法打通的
    pub method: PunchMethod,
    /// 打通用时
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PunchMethod {
    Ipv6Direct,
    SimpleHole,
    PortPrediction,
    BatchSockets,
    Relay,
}

impl PunchMethod {
    pub fn name(&self) -> &'static str {
        match self {
            PunchMethod::Ipv6Direct => "IPv6 Direct",
            PunchMethod::SimpleHole => "Simple Hole Punch",
            PunchMethod::PortPrediction => "Port Prediction",
            PunchMethod::BatchSockets => "Batch Sockets",
            PunchMethod::Relay => "Relay",
        }
    }
}

/// P2P 打洞引擎
pub struct PunchEngine {
    /// 对端的所有已知地址
    peer_ipv6: Option<SocketAddr>,
    peer_ipv4_relay: Option<SocketAddr>,  // 中继看到的 IPv4 地址
    peer_ipv4_stun: Option<SocketAddr>,   // STUN 检测的公网地址
    peer_port_base: Option<u16>,           // STUN 端口（端口预测锚点）

    /// 打洞 socket 池
    sockets: Vec<Arc<UdpSocket>>,

    /// 运行状态
    /// 引擎自身停止位。当前由外层线程（connection.rs 的 running）控制生命周期，
    /// 本字段尚未被读取；保留以备将来把 punch_round 做成后台自驱线程。
    running: Arc<AtomicBool>,
    /// 打洞成功的结果
    result: Arc<Mutex<Option<PunchResult>>>,
    /// 统计
    probes_sent: Arc<AtomicU64>,
    probes_recv: Arc<AtomicU64>,
    /// 开始时间
    started_at: Instant,
    /// 打通时使用的 socket 索引（None = 尚未打通）。数据面要复用这个 socket，
    /// 因为 NAT 映射是绑在具体 socket 上的，换 socket 就打不通了。
    winning_idx: Arc<Mutex<Option<usize>>>,
    /// 打通时使用的地址族（true = IPv6，走临时 v6 socket，不在池内）
    winning_ipv6: Arc<Mutex<Option<Arc<UdpSocket>>>>,
    /// 探测包签名器（与 RelayClient 同一把 ProbeAuth）。不签名对端会丢弃。
    auth: Option<crate::crypto::ProbeAuth>,
}

impl PunchEngine {
    /// 创建打洞引擎
    ///
    /// # Arguments
    /// * `peer_ipv6` - 对端 IPv6 地址（如果有）
    /// * `peer_ipv4` - 对端 IPv4 地址（中继或 STUN 检测到的）
    /// * `peer_stun_port` - 对端 STUN 端口（用于端口预测）
    /// * `socket_count` - 打洞 socket 数量（默认 20）
    pub fn new(
        peer_ipv6: Option<SocketAddr>,
        peer_ipv4: Option<SocketAddr>,
        peer_stun_port: Option<u16>,
        socket_count: usize,
        auth: Option<crate::crypto::ProbeAuth>,
    ) -> anyhow::Result<Self> {
        let mut sockets = Vec::with_capacity(socket_count);
        for _ in 0..socket_count {
            let sock = UdpSocket::bind("0.0.0.0:0")?;
            sock.set_nonblocking(true)?;
            sockets.push(Arc::new(sock));
        }

        Ok(Self {
            peer_ipv6,
            peer_ipv4_relay: peer_ipv4,
            peer_ipv4_stun: peer_ipv4,
            peer_port_base: peer_stun_port,
            sockets,
            running: Arc::new(AtomicBool::new(false)),
            result: Arc::new(Mutex::new(None)),
            probes_sent: Arc::new(AtomicU64::new(0)),
            probes_recv: Arc::new(AtomicU64::new(0)),
            started_at: Instant::now(),
            auth,
            winning_idx: Arc::new(Mutex::new(None)),
            winning_ipv6: Arc::new(Mutex::new(None)),
        })
    }

    /// 获取打洞结果
    pub fn get_result(&self) -> Option<PunchResult> {
        self.result.lock().unwrap().clone()
    }

    /// 给探测包附加 HMAC（与 RelayClient 同一套）
    fn sign(&self, pkt: Vec<u8>) -> Vec<u8> {
        match &self.auth {
            Some(a) => a.sign_probe(&pkt),
            None => pkt,
        }
    }

    /// 取打通用到的 socket（数据面必须复用，否则 NAT 映射对不上）
    pub fn winning_socket(&self) -> Option<Arc<UdpSocket>> {
        if let Some(s) = self.winning_ipv6.lock().unwrap().as_ref() {
            return Some(s.clone());
        }
        let idx = (*self.winning_idx.lock().unwrap())?;
        self.sockets.get(idx).cloned()
    }

    /// 统计
    pub fn stats(&self) -> (u64, u64, u64) {
        (
            self.probes_sent.load(Ordering::Relaxed),
            self.probes_recv.load(Ordering::Relaxed),
            self.started_at.elapsed().as_millis() as u64,
        )
    }

    /// 执行一轮打洞（非阻塞，每秒调用一次）
    /// 返回是否打洞成功
    pub fn punch_round(&mut self, nonce: u64) -> bool {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let mut punched = false;

        // ── 方法 1：IPv6 直连（最便宜，一个包就通） ──
        if let Some(v6_target) = self.peer_ipv6 {
            if let Ok(sock) = UdpSocket::bind("[::]:0").map(Arc::new) {
                sock.set_read_timeout(Some(Duration::from_millis(300))).ok();
                let pkt = self.sign(probe::build_probe_packet(nonce));
                if sock.send_to(&pkt, v6_target).is_ok() {
                    self.probes_sent.fetch_add(1, Ordering::Relaxed);
                    let mut buf = [0u8; 128];
                    if let Ok((len, remote)) = sock.recv_from(&mut buf) {
                        if probe::parse_probe_packet(&buf[..len]).is_some() {
                            let rtt = now_ms.saturating_sub(
                                SystemTime::now().duration_since(UNIX_EPOCH)
                                    .unwrap_or_default().as_millis() as u64
                            );
                            *self.winning_ipv6.lock().unwrap() = Some(sock.clone());
                            self.record_success(remote, true, rtt, PunchMethod::Ipv6Direct);
                            punched = true;
                        }
                    }
                }
            }
        }

        if punched { return true; }

        // ── 方法 2：简单 UDP 打洞（Cone NAT，发一个包看能不能通） ──
        if let Some(v4_target) = self.peer_ipv4_relay {
            for (si, sock) in self.sockets.iter().enumerate() {
                let pkt = self.sign(probe::build_probe_packet(nonce));
                if sock.send_to(&pkt, v4_target).is_ok() {
                    self.probes_sent.fetch_add(1, Ordering::Relaxed);
                }
                // 非阻塞检查回复
                let mut buf = [0u8; 128];
                if let Ok((len, remote)) = sock.recv_from(&mut buf) {
                    if probe::parse_probe_packet(&buf[..len]).is_some() {
                        self.probes_recv.fetch_add(1, Ordering::Relaxed);
                        *self.winning_idx.lock().unwrap() = Some(si);
                        self.record_success(remote, false, 0, PunchMethod::SimpleHole);
                        punched = true;
                        break;
                    }
                }
            }
        }

        if punched { return true; }

        // ── 方法 3：端口预测（APDM-Sequential：往 STUN 端口 ±50 的范围扫） ──
        if let (Some(peer_ip), Some(base_port)) = (
            self.peer_ipv4_relay.map(|a| a.ip()),
            self.peer_port_base,
        ) {
            for (i, sock) in self.sockets.iter().enumerate().take(10) {
                // 从 base_port-50 到 base_port+50，每个 socket 负责一个端口
                let offset = (i as i32) * 10 - 50; // -50, -40, -30, ..., +40
                let port = (base_port as i32 + offset).clamp(1024, 65535) as u16;
                let target = SocketAddr::new(peer_ip, port);
                let pkt = self.sign(probe::build_probe_packet(nonce + i as u64));
                if sock.send_to(&pkt, target).is_ok() {
                    self.probes_sent.fetch_add(1, Ordering::Relaxed);
                }
                // 检查回复
                let mut buf = [0u8; 128];
                if let Ok((len, remote)) = sock.recv_from(&mut buf) {
                    if probe::parse_probe_packet(&buf[..len]).is_some() {
                        self.probes_recv.fetch_add(1, Ordering::Relaxed);
                        *self.winning_idx.lock().unwrap() = Some(i);
                        self.record_success(remote, false, 0, PunchMethod::PortPrediction);
                        punched = true;
                        break;
                    }
                }
            }
        }

        if punched { return true; }

        // ── 方法 4：多 socket 批量扫（APDM-Random：往随机端口发） ──
        if let Some(peer_ip) = self.peer_ipv4_relay.map(|a| a.ip()) {
            for (i, sock) in self.sockets.iter().enumerate() {
                // 用 hash 生成伪随机端口（覆盖更大范围）
                let rand_port = 1024 + ((nonce.wrapping_mul(2654435761) + i as u64) % 64512) as u16;
                let target = SocketAddr::new(peer_ip, rand_port);
                let pkt = self.sign(probe::build_probe_packet(nonce + i as u64));
                if sock.send_to(&pkt, target).is_ok() {
                    self.probes_sent.fetch_add(1, Ordering::Relaxed);
                }
                // 检查回复
                let mut buf = [0u8; 128];
                if let Ok((len, remote)) = sock.recv_from(&mut buf) {
                    if probe::parse_probe_packet(&buf[..len]).is_some() {
                        self.probes_recv.fetch_add(1, Ordering::Relaxed);
                        *self.winning_idx.lock().unwrap() = Some(i);
                        self.record_success(remote, false, 0, PunchMethod::BatchSockets);
                        punched = true;
                        break;
                    }
                }
            }
        }


        // ── 方法 5：生日攻击批量扫描（对称 NAT / APDM 专用）──
        //
        // 原理（工业界称 "birthday attack on NAT ports"）：
        //   APDM 下每个 (源端口, 目的端口) 组合都会分配一个随机公网端口。
        //   对端也在做同样的事，它的 M 个对外映射落在随机端口上。
        //   我方 N 个 socket × 向 M 个随机端口发包 = N*M 个组合，
        //   命中概率 ≈ N*M / 端口空间（生日悖论）。
        //
        //   旧实现每轮只有 20 个组合 → 20/64512 ≈ 0.03%/轮 → 实测手机对称 NAT 要 80 秒。
        //   本实现每轮 20*200 = 4000 个组合 → 约 6%/轮 → 期望 16 秒。
        //   可用 VNET_BIRTHDAY_BATCH 调整每 socket 发包数。
        if let Some(peer_ip) = self.peer_ipv4_relay.map(|a| a.ip()) {
            let per_sock: u64 = std::env::var("VNET_BIRTHDAY_BATCH").ok()
                .and_then(|v| v.parse().ok()).unwrap_or(200);
            let mut seed = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0x9E37_79B9)
                ^ nonce.wrapping_mul(0x9E37_79B9_7F4A_7C15);
            let mut next_rand = || {
                seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
                seed
            };
            for (i, sock) in self.sockets.iter().enumerate() {
                for k in 0..per_sock {
                    let rp = 1024u64 + (next_rand() % 64512);
                    let target = SocketAddr::new(peer_ip, rp as u16);
                    let pkt = self.sign(probe::build_probe_packet(
                        nonce.wrapping_add(i as u64).wrapping_mul(1000).wrapping_add(k)));
                    if sock.send_to(&pkt, target).is_ok() {
                        self.probes_sent.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            // 发完统一排空接收队列
            let mut buf = [0u8; 256];
            for (i, sock) in self.sockets.iter().enumerate() {
                loop {
                    match sock.recv_from(&mut buf) {
                        Ok((len, remote)) => {
                            if probe::parse_probe_packet(&buf[..len]).is_some() {
                                self.probes_recv.fetch_add(1, Ordering::Relaxed);
                                *self.winning_idx.lock().unwrap() = Some(i);
                                self.record_success(remote, false, 0, PunchMethod::BatchSockets);
                                return true;
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
        }

        punched
    }

    fn record_success(&self, addr: SocketAddr, is_v6: bool, rtt: u64, method: PunchMethod) {
        let result = PunchResult {
            peer_addr: addr,
            is_ipv6: is_v6,
            rtt_ms: rtt,
            method,
            elapsed_ms: self.started_at.elapsed().as_millis() as u64,
        };
        println!("  [P2P ✅] {} → {} ({}ms, {})",
            method.name(), addr, result.elapsed_ms,
            if is_v6 { "IPv6" } else { "IPv4" }
        );
        *self.result.lock().unwrap() = Some(result);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_engine_creation() {
        let engine = PunchEngine::new(
            Some("[::1]:9100".parse().unwrap()),
            Some("1.2.3.4:5000".parse().unwrap()),
            Some(50000),
            20,
            None,
        );
        assert!(engine.is_ok());
        assert_eq!(engine.unwrap().sockets.len(), 20);
    }
}
