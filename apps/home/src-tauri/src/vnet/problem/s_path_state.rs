//! S：路径状态（ROSA 问题空间）—— 统一状态容器 PathStateStore + DataPath。
//!
//! 各层只拿 store 引用，不直接持有散装 Arc（避免跨层锁序问题）。
//! 锁纪律沿用旧栈（connection.rs apply_decision 的注释）：逐条获取、立即释放，
//! 绝不嵌套（RDV6 verify 块存在 p2p->path 序，反向嵌套会死锁）。
//!
//! DataPath 正本自 connection.rs 移入（v2 栈用）；connection.rs 保留自己的
//! 同构定义不动，两栈互不影响。

use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};

use crate::vnet::env::t_p2p_channel::P2pChannel;
use crate::vnet::pathpipe::{index_of, pick_pipe, std_pipes, PathPipe, PipeKind};

/// 当前数据路径（执行层视角；决策层只认 PipeKind，映射见 kind()/data_path_for）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DataPath {
    Relay,
    P2PUdp,
    P2PIpv6,
}

impl DataPath {
    pub fn name(&self) -> &'static str {
        match self {
            DataPath::Relay => "Relay",
            DataPath::P2PUdp => "P2P UDP",
            DataPath::P2PIpv6 => "P2P IPv6",
        }
    }
    pub fn is_direct(&self) -> bool {
        !matches!(self, DataPath::Relay)
    }
    /// DataPath -> PipeKind（决策层视角的同一事实）
    pub fn kind(&self) -> PipeKind {
        data_path_kind(*self)
    }
}

/// DataPath -> PipeKind 映射（与 connection.rs 的 data_path_kind 同构）。
pub fn data_path_kind(p: DataPath) -> PipeKind {
    match p {
        DataPath::Relay => PipeKind::Relay,
        DataPath::P2PUdp => PipeKind::P2pV4,
        DataPath::P2PIpv6 => PipeKind::P2pV6,
    }
}

/// PipeKind -> DataPath（逆映射；执行层用）
pub fn data_path_for(kind: PipeKind) -> DataPath {
    match kind {
        PipeKind::Relay => DataPath::Relay,
        PipeKind::P2pV4 => DataPath::P2PUdp,
        PipeKind::P2pV6 => DataPath::P2PIpv6,
    }
}

/// S 层统一状态容器 — 所有 Arc<Mutex> 的集合体。
/// 各层只拿 store 引用，不直接持有散装 Arc（避免跨层锁序问题）。
///
/// 与旧栈（connection.rs Connection 的散装字段）一一对应：
/// - pipes            ↔ Connection.pipes: Arc<Mutex<Vec<PathPipe>>>
/// - current_path     ↔ Connection.path: Arc<Mutex<DataPath>>
/// - p2p_channel      ↔ Connection.p2p: Arc<Mutex<Option<P2pChannel>>>
/// - path_switches    ↔ Connection.path_switches: Arc<Mutex<u32>>（G2 路径历史）
/// - peer_listen_port ↔ 旧栈进程级静态 PEER_LISTEN_PORT（对端公告的监听端口）
pub struct PathStateStore {
    /// 3 条候选管道（固定下标序：0=Relay 1=P2pV4 2=P2pV6，见 pathpipe::index_of）
    pub pipes: Arc<Mutex<Vec<PathPipe>>>,
    /// 当前路径
    pub current_path: Arc<Mutex<DataPath>>,
    /// 当前通道
    pub p2p_channel: Arc<Mutex<Option<P2pChannel>>>,
    /// 切换计数
    pub path_switches: Arc<Mutex<u32>>,
    /// 对端公告端口（0=未知；用于 NAT 过滤类型判定：收到源端口≠此值的包即为证据）
    pub peer_listen_port: AtomicU16,
}

impl Default for PathStateStore {
    fn default() -> Self {
        Self::new()
    }
}

impl PathStateStore {
    /// 初始态：std_pipes（Relay 生来 verified）、路径=Relay、无通道、0 次切换。
    pub fn new() -> Self {
        Self {
            pipes: Arc::new(Mutex::new(std_pipes())),
            current_path: Arc::new(Mutex::new(DataPath::Relay)),
            p2p_channel: Arc::new(Mutex::new(None)),
            path_switches: Arc::new(Mutex::new(0)),
            peer_listen_port: AtomicU16::new(0),
        }
    }

    /// 对端公告的监听端口（0=未知）
    pub fn note_peer_listen_port(&self, p: u16) {
        self.peer_listen_port.store(p, Ordering::Relaxed);
    }

    /// 当前路径（不持锁返回副本；调用方不得据此长期缓存）
    pub fn current(&self) -> DataPath {
        *self.current_path.lock().unwrap()
    }

    /// 槽内通道（若存在）的管道类别——决策层判断通道约束用。
    /// 只认 verified 通道（未验证通道不承载业务，黑盒回归修复语义原样保留）。
    pub fn verified_channel_kind(&self) -> Option<PipeKind> {
        self.p2p_channel
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|ch| if ch.verified { Some(ch.pipe_kind()) } else { None })
    }

    /// 决策快照：按当前 R 重算派生态并 pick_pipe（不改变路径，只读决议）。
    pub fn pick(&self, policy: &crate::vnet::problem::r_path_policy::RPolicy) -> PipeKind {
        let mut ps = self.pipes.lock().unwrap();
        for p in ps.iter_mut() {
            p.update_derived(policy);
        }
        pick_pipe(&ps, policy)
    }

    /// 管道观察快照（状态报告用）
    pub fn obs(&self, kind: PipeKind) -> crate::vnet::problem::o_path_obs::PathObs {
        crate::vnet::problem::o_path_obs::obs_of(&self.pipes.lock().unwrap()[index_of(kind)])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vnet::problem::r_path_policy::RPolicy;

    #[test]
    fn initial_state_is_relay_with_std_pipes() {
        let s = PathStateStore::new();
        assert_eq!(s.current(), DataPath::Relay);
        assert!(s.p2p_channel.lock().unwrap().is_none());
        assert_eq!(*s.path_switches.lock().unwrap(), 0);
        assert_eq!(s.peer_listen_port.load(Ordering::Relaxed), 0);
        let ps = s.pipes.lock().unwrap();
        assert_eq!(ps.len(), 3);
        assert!(ps[0].o_verified_bidi, "relay born verified");
        assert!(!ps[1].o_verified_bidi);
        assert!(!ps[2].o_verified_bidi);
    }

    #[test]
    fn kind_mapping_roundtrip() {
        for k in [PipeKind::Relay, PipeKind::P2pV4, PipeKind::P2pV6] {
            assert_eq!(data_path_for(k).kind(), k);
        }
        assert_eq!(DataPath::P2PUdp.name(), "P2P UDP");
        assert!(DataPath::P2PUdp.is_direct());
        assert!(!DataPath::Relay.is_direct());
    }

    #[test]
    fn pick_falls_back_to_relay_when_no_direct_evidence() {
        let s = PathStateStore::new();
        assert_eq!(s.pick(&RPolicy::default()), PipeKind::Relay);
    }

    #[test]
    fn verified_channel_kind_reads_only_verified() {
        use std::net::UdpSocket;
        let s = PathStateStore::new();
        assert_eq!(s.verified_channel_kind(), None);

        let sock = Arc::new(UdpSocket::bind("127.0.0.1:0").unwrap());
        let unverified = P2pChannel::new(
            sock.clone(),
            "127.0.0.1:9100".parse().unwrap(),
            false,
            None,
            false,
        );
        *s.p2p_channel.lock().unwrap() = Some(unverified);
        assert_eq!(s.verified_channel_kind(), None, "unverified channel carries no business");

        let verified = P2pChannel::new(
            sock,
            "127.0.0.1:9101".parse().unwrap(),
            false,
            None,
            true,
        );
        *s.p2p_channel.lock().unwrap() = Some(verified);
        assert_eq!(s.verified_channel_kind(), Some(PipeKind::P2pV4));
    }

    #[test]
    fn peer_listen_port_atomic_roundtrip() {
        let s = PathStateStore::new();
        s.note_peer_listen_port(41415);
        assert_eq!(s.peer_listen_port.load(Ordering::Relaxed), 41415);
    }
}
