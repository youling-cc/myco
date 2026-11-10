//! vnet 可靠传输层
//! 在 UDP 之上提供 TCP 语义：重传、排序、流控
//! 设计：ARQ（自动重传请求）+ 序号排序 + 指数退避

use std::collections::HashMap;
use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 可靠传输包头
/// [type:1B][seq:4B][ack:4B][length:2B] = 11 字节
pub const HEADER_SIZE: usize = 11;

pub const TYPE_DATA: u8 = 1;
pub const TYPE_ACK: u8 = 2;
/// 应用会话建立控制帧：仅触发对端连接 upstream，不进入应用字节流。
pub const TYPE_SESSION_START: u8 = 3;

/// 构建幂等 SESSION_START 控制帧。
pub fn build_session_start() -> Vec<u8> {
    let mut packet = Vec::with_capacity(HEADER_SIZE);
    packet.push(TYPE_SESSION_START);
    packet.extend_from_slice(&0u32.to_be_bytes());
    packet.extend_from_slice(&0u32.to_be_bytes());
    packet.extend_from_slice(&0u16.to_be_bytes());
    packet
}

/// 数据面主动探测：PING 由发送端在「有数据待交付但连续无进展」时发出，
/// 对端必须回 PONG。它是不携带应用字节的端到端往返证据，
/// 用来把「路径活着但数据面静默」与「对端/路径真死」区分开。
pub const TYPE_PING: u8 = 4;
pub const TYPE_PONG: u8 = 5;
/// 流结束控制帧：对端服务关闭 TCP（server 读到 sink EOF）→ 通知本端关闭对应应用连接。
/// 没有它，对端关闭只停留在本端，应用靠超时才发现响应结束（实测 HTTP 响应收全了还等 15s）。
pub const TYPE_STREAM_END: u8 = 6;

/// P2P 会话公告（进程换代信号）：`[type=8][seq=0][ack=nonce][len=0]`。
///
/// 为什么需要它：P2P 的 `TunnelStream` 跨进程重启仍在（探测重建的是 UDP 路径，
/// 不是流对象），新进程 send seq 从 0 起，而对端 `next_expected` 停在高位。
/// 「落后 > 2×窗口」的反向换代只能覆盖旧会话传过 ≥256 帧的情况；旧会话只传过
/// 几帧（如 4KB 健康检查后客户端重启）时跳幅不够大，新流首帧被当迟到重复帧丢弃
/// → 数据面永久静默，只能等发送端重传预算换代（实测 ~150s，超上层超时）。
/// 本帧与 ARQ 的 seq/ack 空间**完全解耦**：收到即处理，不参与排序/重传/窗口。
pub const TYPE_SESSION: u8 = 8;

/// 构建会话公告帧（nonce 放 ack 位，payload 为空）
pub fn build_session(nonce: u32) -> Vec<u8> {
    let mut packet = Vec::with_capacity(HEADER_SIZE);
    packet.push(TYPE_SESSION);
    packet.extend_from_slice(&0u32.to_be_bytes());
    packet.extend_from_slice(&nonce.to_be_bytes());
    packet.extend_from_slice(&0u16.to_be_bytes());
    packet
}

/// 构建 STREAM_END 控制帧（幂等，不进入应用字节流）
pub fn build_stream_end() -> Vec<u8> {
    let mut packet = Vec::with_capacity(HEADER_SIZE);
    packet.push(TYPE_STREAM_END);
    packet.extend_from_slice(&0u32.to_be_bytes());
    packet.extend_from_slice(&0u32.to_be_bytes());
    packet.extend_from_slice(&0u16.to_be_bytes());
    packet
}

/// 构建 PING（nonce 放在 seq 位，payload 为空）
pub fn build_ping(nonce: u32) -> Vec<u8> {
    let mut packet = Vec::with_capacity(HEADER_SIZE);
    packet.push(TYPE_PING);
    packet.extend_from_slice(&nonce.to_be_bytes());
    packet.extend_from_slice(&0u32.to_be_bytes());
    packet.extend_from_slice(&0u16.to_be_bytes());
    packet
}

/// 构建 PONG（原样回带 nonce）
pub fn build_pong(nonce: u32) -> Vec<u8> {
    let mut packet = Vec::with_capacity(HEADER_SIZE);
    packet.push(TYPE_PONG);
    packet.extend_from_slice(&nonce.to_be_bytes());
    packet.extend_from_slice(&0u32.to_be_bytes());
    packet.extend_from_slice(&0u16.to_be_bytes());
    packet
}

/// 构建 ACK 包
pub fn build_ack(ack_seq: u32) -> Vec<u8> {
    let mut packet = Vec::with_capacity(HEADER_SIZE);
    packet.push(TYPE_ACK);
    packet.extend_from_slice(&0u32.to_be_bytes()); // seq 不用
    packet.extend_from_slice(&ack_seq.to_be_bytes());
    packet.extend_from_slice(&0u16.to_be_bytes());
    packet
}

/// 解析包
pub fn parse_packet(packet: &[u8]) -> Option<(u8, u32, u32, &[u8])> {
    if packet.len() < HEADER_SIZE { return None; }
    let pkt_type = packet[0];
    let seq = u32::from_be_bytes([packet[1], packet[2], packet[3], packet[4]]);
    let ack = u32::from_be_bytes([packet[5], packet[6], packet[7], packet[8]]);
    let len = u16::from_be_bytes([packet[9], packet[10]]) as usize;
    if packet.len() < HEADER_SIZE + len { return None; }
    Some((pkt_type, seq, ack, &packet[HEADER_SIZE..HEADER_SIZE + len]))
}

// ─── relay 路径应用流内层帧（连接多路复用）──────────────────────────────
//
// 根因（2026-11-08 R12 RED）：relay 数据面一个 peer 只有一条有序字节流和一条
// upstream，下行按「最近上行发送者」路由。同 peer 第二条应用连接一 accept：
//   ① SESSION_START 让 server 换掉唯一 upstream（在服务的流被截断）；
//   ② accept 即 claim 下行 owner（回包被抢进新连接的队列）；
//   ③ 两条连接的字节在同一条流里交错（双端 framing 损坏）。
// 修法：每条应用连接一个 stream id，ARQ 载荷前加 3 字节内层头按流分路。
// ARQ 本身保持字节不透明（重传/排序/窗口/epoch 语义不变，100 个单测不动）。
//
// 内层帧格式（每个 ARQ chunk 恰好一个内层头；分块由发送侧按 STREAM_CHUNK 完成）：
//   [tag:1B][stream:2B BE][payload...]
pub const STREAM_TAG_DATA: u8 = TYPE_DATA;            // 0x01 应用字节
pub const STREAM_TAG_SESSION_START: u8 = TYPE_SESSION_START; // 0x03 打开流（建 upstream）
pub const STREAM_TAG_STREAM_END: u8 = TYPE_STREAM_END;      // 0x06 对端 upstream 已关
pub const STREAM_TAG_FIN: u8 = 7;                     // 本端应用已关写端（半关闭传播）

/// 内层帧头大小
pub const STREAM_FRAME_HEAD: usize = 3;

/// 包装一个应用流 chunk（调用方必须保证 payload ≤ STREAM_CHUNK，一个 chunk 一个头）
pub fn wrap_stream_frame(tag: u8, stream: u16, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(STREAM_FRAME_HEAD + payload.len());
    v.push(tag);
    v.extend_from_slice(&stream.to_be_bytes());
    v.extend_from_slice(payload);
    v
}

/// 解析内层帧：返回 (tag, stream, payload)
pub fn parse_stream_frame(frame: &[u8]) -> Option<(u8, u16, &[u8])> {
    if frame.len() < STREAM_FRAME_HEAD { return None; }
    let tag = frame[0];
    let stream = u16::from_be_bytes([frame[1], frame[2]]);
    Some((tag, stream, &frame[STREAM_FRAME_HEAD..]))
}

// ── multi-forward：SESSION_START 的目标端口 ────────────────────────────────
//
// 背景（task.md §11 H.2）：一个 Connection 承载多条本地监听口，每条流的上游端口
// 由发起方指定。旧实现 SESSION_START 载荷为空，服务端一律连自己的 --target-port。
//
// 载荷格式：`[ver:1][target_port:2 BE]`；空载荷 = legacy（用服务端默认口）。
// 兼容靠 NetStatus 的 caps 位协商，**不靠猜**：旧服务端会忽略载荷并用默认口，
// 那是静默误路由，必须由发起方在能力缺失时显式失败（MF_UNSUPPORTED）。
pub const STREAM_START_VER_TARGETED: u8 = 1;

/// SESSION_START 载荷解析结果
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SessionStartTarget {
    /// 空载荷：旧语义，用服务端默认 target
    Legacy,
    /// 指定上游端口（ver 1）
    Target(u16),
    /// 有载荷但版本/长度不认识：必须显式拒绝（不能当 Legacy 处理，否则静默误路由）
    Malformed,
}

/// 构造带目标端口的 SESSION_START 帧
pub fn build_session_start_targeted(stream: u16, target_port: u16) -> Vec<u8> {
    let mut payload = [0u8; 3];
    payload[0] = STREAM_START_VER_TARGETED;
    payload[1..3].copy_from_slice(&target_port.to_be_bytes());
    wrap_stream_frame(STREAM_TAG_SESSION_START, stream, &payload)
}

/// 解析 SESSION_START 载荷（只接受空载荷或 ver=1 的 3 字节）
pub fn parse_session_start_target(payload: &[u8]) -> SessionStartTarget {
    if payload.is_empty() {
        return SessionStartTarget::Legacy;
    }
    if payload.len() == 3 && payload[0] == STREAM_START_VER_TARGETED {
        return SessionStartTarget::Target(u16::from_be_bytes([payload[1], payload[2]]));
    }
    SessionStartTarget::Malformed
}

#[cfg(test)]
mod stream_frame_tests {
    use super::*;

    #[test]
    fn wrap_parse_roundtrip() {
        let f = wrap_stream_frame(STREAM_TAG_DATA, 0xBEEF, b"hello");
        let (tag, sid, p) = parse_stream_frame(&f).unwrap();
        assert_eq!((tag, sid, p), (STREAM_TAG_DATA, 0xBEEF, &b"hello"[..]));
    }

    #[test]
    fn control_frames_carry_stream_id() {
        for tag in [STREAM_TAG_SESSION_START, STREAM_TAG_STREAM_END, STREAM_TAG_FIN] {
            let f = wrap_stream_frame(tag, 7, b"");
            let (t, sid, p) = parse_stream_frame(&f).unwrap();
            assert_eq!((t, sid, p), (tag, 7, &b""[..]));
        }
    }

    #[test]
    fn parse_rejects_short_frames() {
        assert!(parse_stream_frame(&[0x01, 0x00]).is_none());
        assert!(parse_stream_frame(&[]).is_none());
    }
}

/// 可靠 UDP 发送器
pub struct ReliableSender {
    next_seq: u64,
    inflight: Arc<Mutex<HashMap<u32, (Vec<u8>, Instant, u32)>>>,
    socket: Arc<UdpSocket>,
    peer: std::net::SocketAddr,
    pub packets_sent: Arc<AtomicU64>,
    pub packets_retransmitted: Arc<AtomicU64>,
    pub packets_acked: Arc<AtomicU64>,
}

impl ReliableSender {
    pub fn new(socket: Arc<UdpSocket>, peer: std::net::SocketAddr) -> Self {
        Self {
            next_seq: 0,
            inflight: Arc::new(Mutex::new(HashMap::new())),
            socket,
            peer,
            packets_sent: Arc::new(AtomicU64::new(0)),
            packets_retransmitted: Arc::new(AtomicU64::new(0)),
            packets_acked: Arc::new(AtomicU64::new(0)),
        }
    }

    /// 当前 inflight（已发送未确认）帧数——流控窗口用
    pub fn inflight_count(&self) -> usize {
        self.inflight.lock().unwrap().len()
    }

    pub fn send(&mut self, data: &[u8]) -> anyhow::Result<()> {
        let seq = (self.next_seq % u32::MAX as u64) as u32;
        self.next_seq += 1;

        let mut packet = Vec::with_capacity(HEADER_SIZE + data.len());
        packet.push(TYPE_DATA);
        packet.extend_from_slice(&seq.to_be_bytes());
        packet.extend_from_slice(&0u32.to_be_bytes());
        packet.extend_from_slice(&(data.len() as u16).to_be_bytes());
        packet.extend_from_slice(data);

        self.socket.send_to(&packet, self.peer)?;
        self.packets_sent.fetch_add(1, Ordering::Relaxed);

        self.inflight.lock().unwrap().insert(seq, (packet, Instant::now(), 0));
        Ok(())
    }

    pub fn handle_ack(&self, ack_seq: u32) {
        // ACK 延迟模拟：VNET_ACK_DELAY=100 → 处理 ACK 前延迟 100ms
        if let Some(d) = std::env::var("VNET_ACK_DELAY").ok().and_then(|v| v.parse::<u64>().ok()) {
            if d > 0 { std::thread::sleep(std::time::Duration::from_millis(d)); }
        }
        // u32::MAX 哨兵 = "还没收到任何按序帧"——不清 inflight
        // 不加这个：帧 0 丢失时后续帧乱序到达 → ACK(u32::MAX)
        // → retain(seq > u32::MAX) = 全 false → 全部帧被清空 → 永不重传 → 会话死亡
        if ack_seq == u32::MAX {
            return;
        }
        // 接收端回的是**累积 ACK**（"我已经按序收到 <= ack_seq 的全部"），
        // 所以必须删掉所有 <= ack_seq 的在途包。
        // 只删单个序号会导致旧包永远留在 inflight、被无限重传（实测 10% 丢包下成功率仅 33%）。
        let mut inflight = self.inflight.lock().unwrap();
        let before = inflight.len();
        inflight.retain(|seq, _| *seq > ack_seq);
        let removed = before - inflight.len();
        if removed > 0 {
            for _ in 0..removed {
                self.packets_acked.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    pub fn check_retransmit(&self) {
        let mut inflight = self.inflight.lock().unwrap();
        let now = Instant::now();
        let mut dead = Vec::new();

        for (seq, (packet, sent_at, retries)) in inflight.iter_mut() {
            let timeout = Duration::from_millis(100 * (2u64.pow((*retries).min(4))));
            if now.duration_since(*sent_at) > timeout {
                if *retries >= 8 {
                    dead.push(*seq);
                    continue;
                }
                if self.socket.send_to(packet, self.peer).is_ok() {
                    *sent_at = Instant::now();
                    *retries += 1;
                    self.packets_retransmitted.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        for seq in dead { inflight.remove(&seq); }
    }
}

/// 可靠 UDP 接收器（排序去重）
pub struct ReliableReceiver {
    next_expected_seq: u32,
    out_of_order: HashMap<u32, Vec<u8>>,
    pub dup_count: u64,
}

impl ReliableReceiver {
    pub fn new() -> Self {
        Self { next_expected_seq: 0, out_of_order: HashMap::new(), dup_count: 0 }
    }

    /// 诊断用：当前接收器状态（期望的下一个序号 + 乱序缓冲大小 + 重复计数）
    pub fn stats(&self) -> (u32, usize, u64) {
        (self.next_expected_seq, self.out_of_order.len(), self.dup_count)
    }

    /// 会话换代（收到对端新的 session nonce）：清空接收状态，从头按序接收新流。
    /// 与「反向换代」的跳幅判据不同，这条路径不依赖 seq 大小，短会话重启也成立。
    pub fn reset_for_new_session(&mut self) {
        self.next_expected_seq = 0;
        self.out_of_order.clear();
    }

    /// 处理数据包，返回（按序数据列表，要回复的 ACK 序号）
    pub fn handle_data(&mut self, seq: u32, data: &[u8]) -> (Vec<Vec<u8>>, u32) {
        let mut ordered = Vec::new();

        // 流重置检测（2026-11-07 v2，只保留 forward）：
        //
        // 历史：原 RESET_WINDOW=64 的 backward reset（seq+64 < next_expected → 重置）
        //   在大块传输时会误伤迟到重传帧（256KB=233 帧，迟到帧可在 next_expected 后 100+ 位）
        //   → 误清乱序缓冲 → 数据重复 → sha256 mismatch。
        //
        // v2 修正：去掉**按固定小窗**的 backward reset。理由：
        //   对端重启时双方都会通过探测机制重建通道 → 双方 TunnelStream 都是新建的
        //   → receiver 的 next_expected 本来就是 0，不需要 backward reset。
        //   （2026-11-09 跨网实测推翻后半句：探测重建的是 UDP 路径，P2P 的 TunnelStream
        //     跨进程重启仍在 → 高位 next_expected 遇到新进程 seq=0 → 数据面永久静默；
        //     现由下面「反向换代」按大跳幅恢复，不再用 64 这种小窗。）
        //
        // forward reset（本端重启，seq 大幅前跳）保留：只在 seq 跳跃 >1024 且无乱序缓存时触发。
        // forward reset（本端重启，seq 大幅前跳）：阈值 256 = 4× 最大流控窗口，
        // 正常乱序跳跃不会超过窗口（32），必伴随乱序缓存非空；大幅干净前跳 = 对端续流。
        // 中段错位防御（2026-11-09 跨网实测：新 PeerConn 首见远跳 seq 时，
        // 触发帧本身是流的中间字节——交付它 = 乱码 stream id → OPEN/END 循环）：
        // 跳跃时只同步序号到 seq+1，**不交付触发帧载荷**（丢弃）；下一帧起正常交付。
        const FORWARD_JUMP_MIN: u32 = 256;
        // 跳幅门槛必须 > 最大在途帧数（= 流控窗口），否则迟到重传会被误判成换代：
        // 默认窗口 128 → 门槛 256（2× 余量）；VNET_WINDOW 调大时随之抬高。
        let jump_margin: u32 =
            (crate::vnet::relay_arq::window_size() * 2).max(FORWARD_JUMP_MIN as usize) as u32;

        // 反向换代（2026-11-09 跨网实测，P2P 数据面永久静默的根因）：
        //   现象：client 进程重启后探测仍收敛 Path=P2P IPv6（rtt 30-70ms），
        //         但 4KB echo 超时、客户端日志 down=0B —— 控制面健康、数据面死。
        //   机制：TunnelStream 没有 epoch（RelayArq 有 send_epoch/recv_epoch，P2P 没有）。
        //         对端新进程 send seq 从 0 起，本端 next_expected 仍停在旧流高位，
        //         seq < next_expected 落到下面 else 分支 → 当迟到重复帧丢弃 → 永不交付
        //         → STREAM_OPEN 帧本身被丢 → 流永远打不开 → 只能两边都重启才恢复。
        //   判据与 forward 对称：落后 > jump_margin 不可能是在途迟到重传
        //         （在途帧 ≤ 窗口 → 迟到帧最多落后窗口位，2× 余量），必为对端新会话起点。
        //   与 forward 的差别：forward 触发帧是旧流的中间字节（丢），
        //         反向触发帧是新流的**首帧**（含 STREAM_OPEN），必须交付。
        //   已知残留：旧会话只交付了 < jump_margin 帧时（例如 4KB echo 后立刻重启），
        //         跳幅不够大 → 本条不触发，仍需 P2P 会话公告（probe 子类型 + 进程 nonce）
        //         才能在任意状态下换代。见 task.md 待办。
        if seq < self.next_expected_seq
            && self.next_expected_seq - seq > jump_margin
            && self.out_of_order.is_empty()
        {
            println!("  [RCV-NEW-EPOCH] seq={} next_expected={} (peer restarted, resync)",
                seq, self.next_expected_seq);
            self.out_of_order.clear();
            self.next_expected_seq = seq;
        }

        if seq > self.next_expected_seq.wrapping_add(jump_margin)
            && self.out_of_order.is_empty()
        {
            // 同步到 seq+1：触发帧本身是中段字节，跳过它
            self.next_expected_seq = seq.wrapping_add(1);
            self.out_of_order.clear();
            self.dup_count += 1; // 计数（观测用，与迟到重复同列）
            // 直接构造 ACK 返回——不走下面的交付路径
            let ack = if self.next_expected_seq == 0 {
                u32::MAX
            } else {
                self.next_expected_seq.wrapping_sub(1)
            };
            return (Vec::new(), ack);
        }

        if seq == self.next_expected_seq {
            ordered.push(data.to_vec());
            self.next_expected_seq = self.next_expected_seq.wrapping_add(1);
            while let Some(buf) = self.out_of_order.remove(&self.next_expected_seq) {
                ordered.push(buf);
                self.next_expected_seq = self.next_expected_seq.wrapping_add(1);
            }
        } else if seq > self.next_expected_seq {
            self.out_of_order.insert(seq, data.to_vec());
        } else {
            self.dup_count += 1;
        }

        // ── ACK 语义修复（2026-11-06 110KB 会话死亡根因）──
        // 之前：ack = seq（刚收到的帧号）
        //   乱序帧 120 到达 → ACK(120) → sender 累积删除 seq≤120 的帧
        //   → 丢失的帧 119 被误标为已确认 → 永远不重传 → 会话永久卡死
        //
        // 修复：ack = next_expected_seq - 1（最高按序接收的帧号）
        //   乱序帧 120 到达 → ACK(118) → sender 知道 119 还没到 → 正常重传
        let ack = if self.next_expected_seq == 0 {
            u32::MAX // 还没收到任何按序帧（初始状态），ACK u32::MAX 表示"无新确认"
        } else {
            self.next_expected_seq.wrapping_sub(1)
        };

        (ordered, ack)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// multi-forward：带目标端口的 SESSION_START 往返（服务端据此连不同上游）
    #[test]
    fn test_session_start_targeted_roundtrip() {
        let frame = build_session_start_targeted(7, 3389);
        let (tag, sid, payload) = parse_stream_frame(&frame).expect("frame parses");
        assert_eq!(tag, STREAM_TAG_SESSION_START);
        assert_eq!(sid, 7);
        assert_eq!(parse_session_start_target(payload), SessionStartTarget::Target(3389));
    }

    /// 兼容语义：空载荷 = legacy（用服务端默认 target）；不认识 = Malformed（必须显式拒绝）
    #[test]
    fn test_session_start_target_parse_compat() {
        assert_eq!(parse_session_start_target(&[]), SessionStartTarget::Legacy);
        // ver 2（未来版本）不能当 legacy，也不能猜端口
        assert_eq!(
            parse_session_start_target(&[2, 0x0d, 0x3d]),
            SessionStartTarget::Malformed
        );
        // 长度不对
        assert_eq!(parse_session_start_target(&[1, 0x0d]), SessionStartTarget::Malformed);
        assert_eq!(parse_session_start_target(b"garbage!"), SessionStartTarget::Malformed);
    }

    #[test]
    fn test_packet_roundtrip() {
        let ack = build_ack(42);
        let (t, _, ack_seq, _) = parse_packet(&ack).unwrap();
        assert_eq!(t, TYPE_ACK);
        assert_eq!(ack_seq, 42);
    }

    #[test]
    fn test_receiver_ordering() {
        let mut rx = ReliableReceiver::new();
        let (d1, _) = rx.handle_data(1, b"second");
        assert!(d1.is_empty());
        let (d0, _) = rx.handle_data(0, b"first");
        assert_eq!(d0.len(), 2);
        assert_eq!(d0[0], b"first");
        assert_eq!(d0[1], b"second");
    }

    #[test]
    fn test_receiver_duplicate() {
        let mut rx = ReliableReceiver::new();
        rx.handle_data(0, b"a");
        rx.handle_data(0, b"a");
        assert_eq!(rx.dup_count, 1);
    }

    #[test]
    fn test_receiver_reset_backward() {
        // 小幅回退（≤ jump_margin=256）仍判迟到重复帧丢弃，不触发换代。
        // 2026-11-09 起：只有**大跳幅**回退（>256）才按对端新会话恢复。
        let mut rx = ReliableReceiver::new();
        for i in 0..200 { rx.handle_data(i, b"x"); }
        // 旧流的迟到帧（落后 200 < 256）→ 判重复丢弃（不重置）
        let (d, _) = rx.handle_data(0, b"stale");
        assert_eq!(d.len(), 0, "迟到重传帧应被丢弃（不触发重置）");
        // 继续按序
        let (d2, _) = rx.handle_data(200, b"next");
        assert_eq!(d2.len(), 1);
    }

    /// 对端进程重启（P2P 数据面永久静默的根因回归测试）。
    /// 旧行为：next_expected 高位遇新进程 seq=0 → 全部当重复帧丢弃 → down=0B 永不恢复。
    #[test]
    fn test_receiver_new_epoch_after_peer_restart() {
        let mut rx = ReliableReceiver::new();
        for i in 0..2000 { let _ = rx.handle_data(i, b"x"); }
        assert_eq!(rx.stats().0, 2000);
        // 对端重启：新进程从 seq=0 重新开始 → 首帧必须交付（含 STREAM_OPEN）
        let (d, ack) = rx.handle_data(0, b"open");
        assert_eq!(d.len(), 1, "对端重启后的新流首帧被当成重复帧丢弃（静默根因）");
        assert_eq!(d[0], b"open");
        assert_eq!(ack, 0, "ACK 必须确认新流 seq=0");
        assert_eq!(rx.stats().0, 1);
        // 后续帧正常按序
        let (d2, _) = rx.handle_data(1, b"data");
        assert_eq!(d2.len(), 1);
        assert_eq!(d2[0], b"data");
    }

    /// 会话公告帧格式：type=8、nonce 在 ack 位、不带载荷（与 ARQ 序号空间解耦）。
    #[test]
    fn test_session_frame_layout() {
        let f = build_session(0xDEAD_BEEF);
        assert_eq!(f.len(), HEADER_SIZE);
        let (t, seq, ack, payload) = parse_packet(&f).expect("session frame must parse");
        assert_eq!(t, TYPE_SESSION);
        assert_eq!(seq, 0);
        assert_eq!(ack, 0xDEAD_BEEF);
        assert!(payload.is_empty());
        // 不能与 DATA/ACK 混淆
        assert_ne!(TYPE_SESSION, TYPE_DATA);
        assert_ne!(TYPE_SESSION, TYPE_ACK);
    }

    /// 会话换代复位：清空接收状态后，新会话的 seq=0 必须按序交付（短会话重启的关键）。
    #[test]
    fn test_session_reset_accepts_seq0() {
        let mut rx = ReliableReceiver::new();
        for i in 0..5 { let _ = rx.handle_data(i, b"x"); }   // 旧会话只传了 4KB 级小流量
        assert_eq!(rx.stats().0, 5);
        rx.reset_for_new_session();
        assert_eq!(rx.stats().0, 0, "reset 必须把 next_expected 归零");
        let (d, ack) = rx.handle_data(0, b"open");
        assert_eq!(d.len(), 1, "短会话重启后首帧仍被丢弃");
        assert_eq!(d[0], b"open");
        assert_eq!(ack, 0);
    }

    #[test]
    fn test_receiver_reset_forward() {
        // 本端重启（期望归零）后对端续流发来高位包：同步到对端序号，
        // 但**不交付触发帧**（它是流中间字节，交付 = 乱码 stream id）。
        // 下一帧起正常交付。
        let mut rx = ReliableReceiver::new();
        let (d0, ack0) = rx.handle_data(500, b"cont");
        assert_eq!(d0.len(), 0, "触发前跳的帧不交付（中段错位防御）");
        assert_eq!(ack0, 500, "ACK 到达新同步位");
        let (d1, _) = rx.handle_data(501, b"next");
        assert_eq!(d1.len(), 1, "同步后的下一帧正常交付");
        assert_eq!(d1[0], b"next");
    }

    #[test]
    fn test_receiver_no_false_reset_on_retransmit() {
        // 合法重传（小幅回退）不能触发重置
        let mut rx = ReliableReceiver::new();
        for i in 0..10 { rx.handle_data(i, b"x"); }
        // 丢包重传场景：收到 seq=5（已交付过的）——小幅回退判重复
        let (d, _) = rx.handle_data(5, b"x");
        assert!(d.is_empty());
        assert_eq!(rx.dup_count, 1);
    }
}

impl ReliableSender {
    /// 会话换代：清空在途并从头编号——对端接收器已被重置，必须从 0 对齐。
    pub fn reset_for_new_session(&mut self) {
        self.inflight.lock().unwrap().clear();
        self.next_seq = 0;
    }

    /// 预览下一个序号（调用方自行组帧时用）
    pub fn peek_next_seq(&mut self) -> u32 {
        let s = (self.next_seq % u32::MAX as u64) as u32;
        self.next_seq += 1;
        s
    }

    /// 发送一个「调用方已组帧并加密」的包，并纳入重传管理。
    pub fn send_prepared(&mut self, seq: u32, sealed_frame: Vec<u8>, drop: bool) -> anyhow::Result<()> {
        // 帧总是进 inflight（即使模拟丢包），重传由 tick 恢复
        self.inflight
            .lock()
            .unwrap()
            .insert(seq, (sealed_frame, Instant::now(), 0));
        if !drop {
            if let Some(pkt) = self.inflight.lock().unwrap().get(&seq) {
                let _ = self.socket.send_to(&pkt.0, self.peer);
            }
            self.packets_sent.fetch_add(1, Ordering::Relaxed);
        }
        Ok(())
    }

    /// 不纳入重传管理的直接发送（用于 ACK）
    pub fn send_raw_to_peer(&self, bytes: &[u8]) -> anyhow::Result<()> {
        self.socket.send_to(bytes, self.peer)?;
        Ok(())
    }
}
