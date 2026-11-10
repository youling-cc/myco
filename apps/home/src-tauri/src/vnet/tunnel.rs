//! 隧道可靠流：把 transport.rs 的 ARQ 与 crypto 的加密封装成一个直接可用的对象。
//!
//! 背景（2026-11-04 实测）：隧道原本是「裸 UDP 转发 TCP 字节流」，
//! 丢一个 UDP 包，上层 TCP 的字节流就永久缺一段，只能等 5 秒超时。
//! 蜂窝场景启动阶段链路条件差，表现为失败集中在头 5 分钟（0.14% → 目标 <0.1%）。
//!
//! 本模块把两个方向都做成可靠流：
//!   发送：组帧(seq) → 加密 → 发送 → 记 inflight → 超时重传（200ms 起指数退避）
//!   接收：解密 → 解帧 → 去重排序 → 按序交付 → 回累积 ACK
//!
//! 开关：环境变量 `VNET_ARQ=0` 可关闭（回退到裸转发），默认开启。

use std::collections::VecDeque;
use std::net::UdpSocket;
use std::sync::Arc;

use crate::vnet::crypto::SessionCrypto;
use crate::vnet::transport::{self, ReliableReceiver, ReliableSender};

/// 流控窗口：与 relay 路径单一事实源（`relay_arq::window_size()`，缺省 128，
/// `VNET_WINDOW` 可覆盖）。直连 RTT 低于 relay（少一跳），同窗口吞吐不低于 relay；
/// 固定 32 的旧值在跨网 RTT 25–40ms 下只有 0.9–1.4MB/s，会输给 relay 路径。
fn window() -> usize {
    crate::vnet::relay_arq::window_size()
}

pub struct TunnelStream {
    sender: ReliableSender,
    receiver: ReliableReceiver,
    crypto: Option<Arc<std::sync::Mutex<SessionCrypto>>>,
    peer: std::net::SocketAddr,
    /// 流控待发缓冲：send() 只入队，flush_pending() 按窗口发送（非阻塞，避免单线程 handler 死锁）
    pending: VecDeque<Vec<u8>>,
    /// 最近一次收到的对端会话 nonce（None = 还没收到过公告）
    peer_session: Option<u32>,
    /// 换代计数：handler 用它判断「该 peer 的 per-stream 表要不要清」
    session_gen: u64,
    /// 本端公告还欠发几次（首建通道时连发几遍抗丢包）
    announce_left: u8,
    last_announce: std::time::Instant,
}

/// 进程级会话 nonce：同一进程内所有通道共享（per-channel 会让两边互相 reset 死循环）。
/// 非 0（0 表示「未知」）。进程重启 → 新 nonce → 对端据此换代。
fn process_session_nonce() -> u32 {
    static N: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *N.get_or_init(|| {
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        let mut x = t ^ ((std::process::id() as u64) << 32) ^ 0x9E37_79B9_7F4A_7C15;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        (x as u32) | 1
    })
}

impl TunnelStream {
    pub fn new(
        socket: Arc<UdpSocket>,
        peer: std::net::SocketAddr,
        crypto: Option<Arc<std::sync::Mutex<SessionCrypto>>>,
    ) -> Self {
        let mut s = Self {
            sender: ReliableSender::new(socket, peer),
            receiver: ReliableReceiver::new(),
            crypto,
            peer,
            pending: VecDeque::new(),
            peer_session: None,
            session_gen: 0,
            announce_left: 6,
            last_announce: std::time::Instant::now(),
        };
        // 通道建立即公告本进程会话；丢了由 tick() 续发（幂等，nonce 相同不触发对端重置）
        s.send_session_announce();
        s
    }

    /// 会话公告（加密后走裸发送，不进 ARQ 序号/重传体系）
    fn send_session_announce(&mut self) {
        let frame = transport::build_session(process_session_nonce());
        let sealed = self.seal(&frame);
        let _ = self.sender.send_raw_to_peer(&sealed);
    }

    /// 本端换代计数（handler 据此清 per-stream 表）
    pub fn session_generation(&self) -> u64 {
        self.session_gen
    }

    fn on_session(&mut self, nonce: u32) {
        match self.peer_session {
            Some(old) if old != nonce => {
                println!("  [P2P-SESSION] peer session {} -> {} (peer restarted, reset sender+receiver)",
                    old, nonce);
                self.receiver.reset_for_new_session();
                // 对端接收器也是新的 → 本端发送序号必须从 0 对齐，否则对方又按旧流丢弃
                self.sender.reset_for_new_session();
                self.session_gen = self.session_gen.wrapping_add(1);
                self.peer_session = Some(nonce);
                // 回公告一次：让对端也把本端当新会话（幂等）
                self.announce_left = 2;
                self.last_announce = std::time::Instant::now();
            }
            None => self.peer_session = Some(nonce),
            _ => {}
        }
    }

    pub fn peer(&self) -> std::net::SocketAddr {
        self.peer
    }

    fn seal(&self, plain: &[u8]) -> Vec<u8> {
        match &self.crypto {
            Some(c) => c.lock().unwrap().encrypt(plain),
            None => plain.to_vec(),
        }
    }

    fn unseal(&self, wire: &[u8]) -> Option<Vec<u8>> {
        match &self.crypto {
            Some(c) => c.lock().unwrap().decrypt(wire),
            None => Some(wire.to_vec()),
        }
    }

    /// 发送一段上层字节（TCP 载荷）。
    /// 流控 v2（2026-11-07）：只入 pending 缓冲 + 立即 flush 到窗口上限，超窗口部分由 tick() 后续 flush。
    /// 非阻塞设计——服务端 P2P handler 单线程同时收包/发包，阻塞等窗会死锁（实测 64KB+ 全超时）。
    pub fn send(&mut self, payload: &[u8]) -> anyhow::Result<()> {
        if payload.is_empty() {
            return Ok(());
        }
        if !arq_enabled() {
            // 对照模式：裸转发（不编号、不重传），用于证明 ARQ 不可替代
            if loss_drop() { return Ok(()); }
            let sealed = self.seal(payload);
            return self.sender.send_raw_to_peer(&sealed);
        }
        // 分片大小按地址族收紧：
        //   IPv6 最小 MTU 是 1280，扣掉 IPv6(40)+UDP(8)+ARQ头(11)+GCM(nonce8+tag16)=83 只剩 ~1197，
        //   取 1100 留安全余量。留 1200 会触发 IPv6 分片，而很多网络直接丢 IPv6 分片包。
        let chunk_size = if self.peer.is_ipv6() { 1100 } else { 1200 };
        for chunk in payload.chunks(chunk_size) {
            self.pending.push_back(chunk.to_vec());
        }
        self.flush_pending()
    }

    /// 按流控窗口发送 pending（非阻塞：窗口满即返回，剩余等 tick() 再 flush）
    fn flush_pending(&mut self) -> anyhow::Result<()> {
        let mut frame_count = 0u32;
        while let Some(chunk) = self.pending.pop_front() {
            if self.sender.inflight_count() >= window() {
                self.pending.push_front(chunk); // 窗口满，放回
                break;
            }
            let mut frame = Vec::with_capacity(transport::HEADER_SIZE + chunk.len());
            let seq = self.sender.peek_next_seq();
            frame.push(transport::TYPE_DATA);
            frame.extend_from_slice(&seq.to_be_bytes());
            frame.extend_from_slice(&0u32.to_be_bytes());
            frame.extend_from_slice(&(chunk.len() as u16).to_be_bytes());
            frame.extend_from_slice(&chunk);
            let sealed = self.seal(&frame);
            // loss_drop 模拟丢包：帧照样进 inflight（可重传），只是不发 UDP
            let dropped = loss_drop();
            self.sender.send_prepared(seq, sealed, dropped)?;
            frame_count += 1;
            if frame_count % 32 == 0 {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
        Ok(())
    }

    /// pending 积压字节数（背压判断用）
    pub fn pending_bytes(&self) -> usize {
        self.pending.iter().map(|c| c.len()).sum()
    }

    /// 当前 inflight（已发送未确认）帧数——流控窗口用
    pub fn inflight_count(&self) -> usize {
        self.sender.inflight_count()
    }

    /// 诊断用：接收器状态（next_expected_seq, out_of_order_size, dup_count）
    pub fn receiver_stats(&self) -> (u32, usize, u64) {
        self.receiver.stats()
    }

    /// 处理一个收到的 UDP 包。返回按序可交付的上层字节块（可能有多个）。
    ///
    /// 内部会自动回 ACK —— 调用方不需要关心。
    pub fn on_packet(&mut self, wire: &[u8]) -> Vec<Vec<u8>> {
        let plain = match self.unseal(wire) {
            Some(p) => p,
            None => {
                diag("unseal-fail", wire.len());
                return Vec::new();
            }
        };
        if !arq_enabled() {
            return vec![plain];
        }
        let (ptype, seq, ack, payload) = match transport::parse_packet(&plain) {
            Some(x) => x,
            None => {
                diag("parse-fail", plain.len());
                return Vec::new();
            }
        };
        match ptype {
            transport::TYPE_SESSION => {
                self.on_session(ack);
                Vec::new()
            }
            transport::TYPE_DATA => {
                let (deliver, ack_seq) = self.receiver.handle_data(seq, payload);
                // 回累积 ACK（也走加密）
                let ack_frame = transport::build_ack(ack_seq);
                let sealed = self.seal(&ack_frame);
                let _ = self.sender.send_raw_to_peer(&sealed);
                deliver
            }
            transport::TYPE_ACK => {
                self.sender.handle_ack(ack);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    /// ARQ tick：重传超时帧 + flush pending（流控窗口可能已因 ACK 打开）
    /// 调用方需周期性调用（建议 50–100ms）
    pub fn tick(&mut self) {
        if arq_enabled() {
            // 会话公告续发：首建通道/换代后连发几次，抗丢包（同 nonce 幂等）
            if self.announce_left > 0
                && self.last_announce.elapsed() >= std::time::Duration::from_millis(200)
            {
                self.send_session_announce();
                self.announce_left -= 1;
                self.last_announce = std::time::Instant::now();
            }
            self.sender.check_retransmit();
            let _ = self.flush_pending();
        }
    }

    pub fn stats(&self) -> (u64, u64, u64) {
        use std::sync::atomic::Ordering;
        (
            self.sender.packets_sent.load(Ordering::Relaxed),
            self.sender.packets_acked.load(Ordering::Relaxed),
            self.sender.packets_retransmitted.load(Ordering::Relaxed),
        )
    }
}

/// ARQ 是否启用（默认启用；VNET_ARQ=0 关闭以便对照测试）
pub fn arq_enabled() -> bool {
    std::env::var("VNET_ARQ").map(|v| v != "0").unwrap_or(true)
}

/// 诊断计数（限流打印，便于定位 ARQ 接线问题）
fn diag(tag: &str, len: usize) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let k = N.fetch_add(1, Ordering::Relaxed);
    if k < 10 || k % 50 == 0 {
        println!("  [ARQ-DIAG] {} len={} (#{})", tag, len, k + 1);
    }
}

/// 丢包注入（红例专用）：VNET_LOSS=10 表示随机丢弃 10% 的出站包。
/// 用于证明 ARQ 在丢包链路上的不可替代性。
fn loss_drop() -> bool {
    static CTR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let pct: u64 = match std::env::var("VNET_LOSS").ok().and_then(|v| v.parse().ok()) {
        Some(v) => v,
        None => return false,
    };
    if pct == 0 { return false; }
    let n = CTR.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // xorshift，够用且无依赖
    let mut x = n.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xDEAD_BEEF;
    x ^= x << 13; x ^= x >> 7; x ^= x << 17;
    (x % 100) < pct
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_frame(seq: u32, payload: &[u8]) -> Vec<u8> {
        let mut f = Vec::new();
        f.push(transport::TYPE_DATA);
        f.extend_from_slice(&seq.to_be_bytes());
        f.extend_from_slice(&0u32.to_be_bytes());
        f.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        f.extend_from_slice(payload);
        f
    }

    fn stream_pair() -> (TunnelStream, TunnelStream) {
        let a = Arc::new(UdpSocket::bind("127.0.0.1:0").unwrap());
        let b = Arc::new(UdpSocket::bind("127.0.0.1:0").unwrap());
        a.set_nonblocking(true).unwrap();
        b.set_nonblocking(true).unwrap();
        let (aa, ba) = (a.local_addr().unwrap(), b.local_addr().unwrap());
        (TunnelStream::new(a, ba, None), TunnelStream::new(b, aa, None))
    }

    /// 短会话 + 对端换代：旧会话只传过几帧（跳幅远小于 256），
    /// 靠会话公告仍必须复位并按序接收新会话的 seq=0。
    #[test]
    fn test_session_announce_short_session_reset() {
        let (mut a, mut _b) = stream_pair();
        // 旧会话：只传 3 帧（模拟 4KB 健康检查后重启）
        for seq in 0..3 { let _ = a.on_packet(&data_frame(seq, b"x")); }
        assert_eq!(a.receiver_stats().0, 3);
        // 对端首次公告（建立基线，不该触发复位）
        let _ = a.on_packet(&transport::build_session(1111));
        assert_eq!(a.session_generation(), 0, "首次公告不应换代");
        // 对端重启：非 0 新 nonce → 换代 + 复位
        let _ = a.on_packet(&transport::build_session(2222));
        assert_eq!(a.session_generation(), 1, "nonce 变化必须换代");
        assert_eq!(a.receiver_stats().0, 0, "换代必须清空 next_expected");
        // 新会话首帧必须交付（旧 bug：被当迟到重复帧丢弃）
        let d = a.on_packet(&data_frame(0, b"open"));
        assert_eq!(d.len(), 1, "换代后 seq=0 未交付");
        assert_eq!(d[0], b"open");
        // 同一 nonce 重复公告幂等，不再换代
        let _ = a.on_packet(&transport::build_session(2222));
        assert_eq!(a.session_generation(), 1, "重复公告不应反复换代");
    }
}
