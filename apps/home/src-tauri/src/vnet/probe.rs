//! UDP 探测引擎 v2 - IPv6 优先 + 双向敲门 + IPv4 端口扫描
//! 核心思想：持续探测本身就是敲门，天然支持双向防火墙穿透

use std::net::{SocketAddr, UdpSocket, IpAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 探测包魔数
pub const PROBE_MAGIC: u32 = 0x564E4554; // "VNET"

/// 探测包 payload 大小（不含 IP/UDP 头）
/// 布局: magic(4) + type(1) + reserved(3) + nonce(8) + timestamp(8) = 24
pub const PROBE_PACKET_SIZE: usize = 24;

/// 探测包类型
pub const PROBE_TYPE_REQUEST: u8 = 1;
pub const PROBE_TYPE_REPLY: u8 = 2;

/// 构建探测请求
pub fn build_probe_packet(nonce: u64) -> Vec<u8> {
    build_probe_typed(PROBE_TYPE_REQUEST, nonce, now_us())
}

/// 构建探测回复：回显请求的 nonce 和 timestamp，用于 RTT 计算
pub fn build_probe_reply(nonce: u64, echo_ts: u64) -> Vec<u8> {
    build_probe_typed(PROBE_TYPE_REPLY, nonce, echo_ts)
}

/// 当前时间（微秒）。用微秒而非毫秒，避免 ±1ms 的量化误差污染 RTT 统计
pub fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64
}

/// 已收包时间减去回显时间戳，得到微秒级 RTT
pub fn rtt_us_from(echo_ts: u64) -> u64 {
    now_us().saturating_sub(echo_ts)
}

fn build_probe_typed(pkt_type: u8, nonce: u64, ts: u64) -> Vec<u8> {
    let mut packet = Vec::with_capacity(PROBE_PACKET_SIZE);
    packet.extend_from_slice(&PROBE_MAGIC.to_be_bytes());
    packet.push(pkt_type);
    packet.extend_from_slice(&[0u8; 3]);
    packet.extend_from_slice(&nonce.to_be_bytes());
    packet.extend_from_slice(&ts.to_be_bytes());
    packet
}

/// 解析探测包，返回 (type, nonce, timestamp)
pub fn parse_probe_full(packet: &[u8]) -> Option<(u8, u64, u64)> {
    if packet.len() < PROBE_PACKET_SIZE { return None; }
    let magic = u32::from_be_bytes([packet[0], packet[1], packet[2], packet[3]]);
    if magic != PROBE_MAGIC { return None; }
    let pkt_type = packet[4];
    let nonce = u64::from_be_bytes([
        packet[8], packet[9], packet[10], packet[11],
        packet[12], packet[13], packet[14], packet[15],
    ]);
    let ts = u64::from_be_bytes([
        packet[16], packet[17], packet[18], packet[19],
        packet[20], packet[21], packet[22], packet[23],
    ]);
    Some((pkt_type, nonce, ts))
}

/// 兼容旧接口：返回 (nonce, timestamp)
pub fn parse_probe_packet(packet: &[u8]) -> Option<(u64, u64)> {
    parse_probe_full(packet).map(|(_, n, t)| (n, t))
}
