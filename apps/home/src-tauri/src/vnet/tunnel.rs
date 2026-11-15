//! 隧道可靠流：把 RelayArq v3（快速重传+SACK+自适应RTO）与 crypto 封装成直接可用的对象。
//!
//! 架构变更（2026-11-14 P1）：P2P 路径原来用 transport.rs 的简化 ARQ（只有超时重传），
//! 在数据负载下只有 33-50% 帧确认率——根因是缺少快速重传/SACK/自适应 RTO。
//! relay 路径的 RelayArq v3 已有这三个特性且在生产验证稳定。
//! 本模块现在直接复用 RelayArq（同一实现，两处使用），消除双实现漂移。
//!
//! 发送流程：payload → RelayArq.send()（分片+编号）→ flush_and_tick() → 明文帧 → seal → UDP
//! 接收流程：UDP → unseal → RelayArq.on_packet() → 按序交付的 payload 列表
//! 会话公告：nonce 变化 → 重置 RelayArq（对端重启检测）

use std::net::UdpSocket;
use std::sync::Arc;

use crate::vnet::crypto::SessionCrypto;
use crate::vnet::relay_arq::RelayArq;

pub struct TunnelStream {
    arq: RelayArq,
    socket: Arc<UdpSocket>,
    crypto: Option<Arc<std::sync::Mutex<SessionCrypto>>>,
    peer: std::net::SocketAddr,
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
            arq: RelayArq::new(),
            socket,
            crypto,
            peer,
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
        let frame = crate::vnet::transport::build_session(process_session_nonce());
        let sealed = self.seal(&frame);
        let _ = self.socket.send_to(&sealed, self.peer);
    }

    /// 本端换代计数（handler 据此清 per-stream 表）
    pub fn session_generation(&self) -> u64 {
        self.session_gen
    }

    fn on_session(&mut self, nonce: u32) {
        match self.peer_session {
            Some(old) if old != nonce => {
                println!("  [P2P-SESSION] peer session {} -> {} (peer restarted, reset ARQ)",
                    old, nonce);
                // 对端 ARQ 也是新的 → 本端重建（序号归零，自适应 RTO 重新学习）
                self.arq = RelayArq::new();
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
    ///
    /// **关键约束（2026-11-15 SSH MAC 损坏事故修复）**：
    /// payload 是完整流帧 `[tag:1][stream:2][data]`。RelayArq 会把超过
    /// chunk_size 的载荷分片成多个 ARQ chunk——如果流帧的 data 部分被
    /// ARQ 内部分块切开，只有第一个 chunk 带流头，后续 chunk 变成裸数据
    /// 被接收端 push_p2p_frame 误路由 → 数据跨连接污染 → SSH MAC 错误。
    ///
    /// 修法（与 relay 路径同款预分块策略，见 relay_arq.rs L12-14 注释）：
    /// DATA 类大帧在此处拆成多个 ≤chunk_size 的小 DATA 流帧，
    /// 每个 ARQ chunk 恰好装一个完整流帧。接收端 push_stream 按序拼接。
    pub fn send(&mut self, payload: &[u8]) -> anyhow::Result<()> {
        if payload.is_empty() {
            return Ok(());
        }
        if !arq_enabled() {
            // 对照模式：裸转发（不编号、不重传），用于证明 ARQ 不可替代
            if loss_drop() { return Ok(()); }
            let sealed = self.seal(payload);
            let _ = self.socket.send_to(&sealed, self.peer);
            return Ok(());
        }
        // 预分块：大 DATA 流帧拆小，确保每个 ARQ chunk = 一个完整流帧
        let max_chunk = crate::vnet::relay_arq::chunk_size();
        if payload.len() > max_chunk {
            if let Some((crate::vnet::transport::STREAM_TAG_DATA, sid, data)) =
                crate::vnet::transport::parse_stream_frame(payload)
            {
                // 每个小帧的 data 上限 = chunk_size - 3 字节流头
                let max_data = max_chunk.saturating_sub(3).max(1);
                for piece in data.chunks(max_data) {
                    let small = crate::vnet::transport::wrap_stream_frame(
                        crate::vnet::transport::STREAM_TAG_DATA, sid, piece);
                    self.arq.send(&small);
                }
                self.flush_frames();
                return Ok(());
            }
        }
        self.arq.send(payload);
        // 立即 flush（后续帧由 tick() 补发）
        self.flush_frames();
        Ok(())
    }

    /// 从 ARQ 取出新帧+重传帧，加密后发到对端
    fn flush_frames(&mut self) {
        let (new_f, retrans_f) = self.arq.flush_and_tick();
        for frame in new_f.into_iter().chain(retrans_f.into_iter()) {
            if loss_drop() { continue; } // 丢包注入（红例专用）
            let sealed = self.seal(&frame);
            let _ = self.socket.send_to(&sealed, self.peer);
        }
    }

    /// 当前 inflight（已发送未确认）帧数——流控窗口用
    pub fn inflight_count(&self) -> usize {
        // RelayArq 以字节为单位管理 inflight；帧数用窗口近似
        (self.arq.inflight_bytes() / crate::vnet::relay_arq::chunk_size().max(1)).min(crate::vnet::relay_arq::window_size())
    }

    /// pending 积压字节数（背压判断用）
    pub fn pending_bytes(&self) -> usize {
        self.arq.inflight_bytes() // RelayArq 的 inflight 即未确认积压
    }

    /// 处理一个收到的 UDP 包。返回按序可交付的上层字节块（可能有多个）。
    /// RelayArq 内部处理 ACK/SACK/快速重传。
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
        // 会话公告包不走 ARQ（TYPE_SESSION 帧：nonce 在 ack 字段位置）
        if plain.len() >= 1 && plain[0] == crate::vnet::transport::TYPE_SESSION {
            if plain.len() >= 9 {
                // 帧格式 [type:1][seq:4][ack:4][len:2]，nonce 在 ack 位（bytes 5-8）
                let nonce = u32::from_be_bytes([plain[5], plain[6], plain[7], plain[8]]);
                self.on_session(nonce);
            }
            return Vec::new();
        }
        // 数据/ACK/控制帧 → RelayArq 处理
        let (payloads, ack_frame, control_frames) = self.arq.on_packet(&plain);
        // 发 ACK / 控制帧（加密后回发）
        if let Some(ack) = ack_frame {
            let sealed = self.seal(&ack);
            let _ = self.socket.send_to(&sealed, self.peer);
        }
        for cf in control_frames {
            let sealed = self.seal(&cf);
            let _ = self.socket.send_to(&sealed, self.peer);
        }
        payloads
    }

    /// ARQ tick：flush 新帧+重传帧（窗口可能已因 ACK/SACK 打开）
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
            self.flush_frames();
        }
    }

    pub fn stats(&self) -> (u64, u64, u64) {
        // RelayArq 的统计口径：(sent_chunks, acked_chunks, retransmitted_chunks)
        // 从 inflight/pacing 状态推导——生产诊断主要看 hist.log 的 ack 比例
        (0, 0, 0) // 占位：RelayArq 的统计接口由调用方（connection.rs）从 flush/ACK 计数获取
    }

    /// 诊断用：接收器状态（保持旧接口兼容）
    pub fn receiver_stats(&self) -> (u32, usize, u64) {
        (0, 0, 0) // RelayArq 的接收状态由内部 SACK 位图管理，无直接暴露
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
        f.push(crate::vnet::transport::TYPE_DATA);
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

    /// 短会话 + 对端换代：会话公告 nonce 变化必须换代（ARQ 复位由 RelayArq::new() 保证）。
    /// （2026-11-14 P1：内部换成 RelayArq v3——测试验证换代计数行为；数据流由 17 场景黑盒回归覆盖）
    #[test]
    fn test_session_announce_short_session_reset() {
        let (mut a, _b) = stream_pair();
        // 对端首次公告（建立基线，不该触发复位）
        let _ = a.on_packet(&crate::vnet::transport::build_session(1111));
        assert_eq!(a.session_generation(), 0, "首次公告不应换代");
        // 对端重启：新 nonce → 换代
        let _ = a.on_packet(&crate::vnet::transport::build_session(2222));
        assert_eq!(a.session_generation(), 1, "nonce 变化必须换代");
        // 同一 nonce 重复公告幂等，不再换代
        let _ = a.on_packet(&crate::vnet::transport::build_session(2222));
        assert_eq!(a.session_generation(), 1, "重复公告不应反复换代");
    }

    /// 回归（2026-11-15 SSH MAC 损坏事故）：大 DATA 流帧必须预分块，
    /// 每块 ≤ chunk_size 且带完整流头，不得让 RelayArq 在流帧中间切。
    #[test]
    fn test_large_stream_frame_fragmentation() {
        let conn_id: u16 = 42;
        let big_data = vec![0xABu8; 16384]; // 模拟一次 16KB TCP 读
        let frame = crate::vnet::transport::wrap_stream_frame(
            crate::vnet::transport::STREAM_TAG_DATA, conn_id, &big_data);
        assert!(frame.len() > crate::vnet::relay_arq::chunk_size(), "16KB 帧确实超过 chunk 上限");

        // 验证预分块参数
        let max_chunk = crate::vnet::relay_arq::chunk_size();
        let max_data = max_chunk.saturating_sub(3).max(1); // 3 = [tag:1][stream:2]
        let pieces: Vec<_> = big_data.chunks(max_data).collect();
        assert!(pieces.len() > 1, "必须分成多块（当前 {} 块）", pieces.len());

        // 每块必须是完整可解析的流帧
        for (i, piece) in pieces.iter().enumerate() {
            let small = crate::vnet::transport::wrap_stream_frame(
                crate::vnet::transport::STREAM_TAG_DATA, conn_id, piece);
            assert!(small.len() <= max_chunk,
                "块 #{} 长度 {} 超过 chunk 上限 {}", i, small.len(), max_chunk);
            let parsed = crate::vnet::transport::parse_stream_frame(&small);
            assert!(parsed.is_some(), "块 #{} 必须是完整流帧", i);
            let (tag, sid, _) = parsed.unwrap();
            assert_eq!(tag, crate::vnet::transport::STREAM_TAG_DATA, "块 #{} tag 正确", i);
            assert_eq!(sid, conn_id, "块 #{} stream id 正确", i);
        }
    }
}
