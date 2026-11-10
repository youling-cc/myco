//! P：探测传感器 —— 从各接收线程抽出。
//!
//! 一个探测事件的两个方向（敲门 REQUEST / 回包 REPLY）各自上报。
//! `surface` 标明事件落在哪个接收面——同一个「回包」在不同面上的证据强度
//! 不同（旧栈行为：relay-socket 回包要 3 连才 verified；监听 socket 上的
//! REPLY 往返立即 verified；REQUEST 只有 v4 监听面算双向）。C 层按面解释。

use std::net::SocketAddr;

/// 探测事件落在的接收面（证据强度解释由 C 层做）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeSurface {
    /// relay socket 上的探测回包（RecvKind::ProbeReply）——弱证据面
    Relay,
    /// IPv4 Rendezvous 监听 socket（RDV4）
    ListenV4,
    /// IPv6 Rendezvous 监听 socket（RDV6）
    ListenV6,
    /// 独立 IPv6 探测 socket（client 探测线程的 v6 接收线程）
    V6Probe,
    /// 打洞引擎胜出 socket（数据泵）
    Punch,
}

/// 探测传感器：收到对端敲门包 / 探测回包时调用。
pub trait ProbeSensor: Send + Sync {
    /// 收到敲门包（PROBE_TYPE_REQUEST）。`from` 决定地址族（v4/v6 管道）。
    fn on_request(&self, from: SocketAddr, surface: ProbeSurface);

    /// 收到探测回包（PROBE_TYPE_REPLY）。`rtt_ms` 由回显时间戳算出
    /// （relay 面无时间戳证据，调用方传 0，C 层不采纳）。
    fn on_reply(&self, from: SocketAddr, rtt_ms: u64, surface: ProbeSurface);
}
