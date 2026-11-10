//! T：P2P 通道 —— 承载直连数据的 socket + 对端地址 + ARQ 可靠流。
//!
//! 从 connection.rs 原样抽出（M1 先落位，供 S 层 PathStateStore 引用；
//! connection.rs 保持不动，本文件是 v2 栈的正本）。逻辑零修改：
//! - verified 语义原样保留：REQUEST 敲门只证明「对端→我」→ false 入槽；
//!   REPLY 往返 / 打洞胜出 / verify-ACK 到达 → true 才承载业务。
//! - chan_rebuild_needed 重建判据原样保留（防 ARQ 序号归零的关键纪律）。

use std::net::{SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex};

/// 一条 P2P 通道：socket + 对端 + 可靠流 + 通道级验证位。
pub struct P2pChannel {
    pub socket: Arc<UdpSocket>,
    pub peer_addr: SocketAddr,
    pub is_ipv6: bool,
    /// 通道级双向验证位（黑盒回归修复核心）：REQUEST 敲门只证明「对端→我」，
    /// 这样创建的通道为 false（verify ACK 到达才置 true）；REPLY 往返 / 打洞胜出 /
    /// score>=3 证据创建的通道直接 true。决策层只选 verified 通道承载业务，
    /// 否则管道级 verified（可能来自另一个 socket 的证据）会把未验证通道顶上数据面。
    pub verified: bool,
    /// 可靠流（ARQ）。通道建立时创建，自己持有 socket+peer，ACK 从同一通道回。
    pub stream: Arc<Mutex<crate::vnet::tunnel::TunnelStream>>,
}

impl P2pChannel {
    pub fn new(
        socket: Arc<UdpSocket>,
        peer_addr: SocketAddr,
        is_ipv6: bool,
        crypto: Option<Arc<Mutex<crate::vnet::crypto::SessionCrypto>>>,
        verified: bool,
    ) -> Self {
        let stream = crate::vnet::tunnel::TunnelStream::new(socket.clone(), peer_addr, crypto);
        Self { socket, peer_addr, is_ipv6, verified, stream: Arc::new(Mutex::new(stream)) }
    }

    /// 该通道对应的管道类别（决策层只认 PipeKind，执行层只认通道）。
    pub fn pipe_kind(&self) -> crate::vnet::pathpipe::PipeKind {
        if self.is_ipv6 {
            crate::vnet::pathpipe::PipeKind::P2pV6
        } else {
            crate::vnet::pathpipe::PipeKind::P2pV4
        }
    }
}

/// 通道重建判据（与 connection.rs 同名函数逐字一致，注释原样保留）：
/// - 对端 IP 变了 → 重建（真换端；真换端口由 watchdog 停滞清通道后重建兜底）
/// - 同 IP、槽内通道**未验证**、新证据是**已验证**通道（REPLY 往返/打洞胜出）→ 顶替
/// - 其余同 IP 情况（对端打洞引擎扫描端口的敲门/回包）→ 绝不重建
///   （全地址比较会让通道每秒重建、ARQ 归零，对端在途流全判重复吞掉）
pub fn chan_rebuild_needed(existing: &P2pChannel, from: SocketAddr, new_verified: bool) -> bool {
    if existing.peer_addr.ip() != from.ip() {
        return true;
    }
    new_verified && !existing.verified
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sock() -> Arc<UdpSocket> {
        Arc::new(UdpSocket::bind("127.0.0.1:0").unwrap())
    }

    #[test]
    fn pipe_kind_maps_family() {
        let s4 = sock();
        let s6 = Arc::new(UdpSocket::bind("[::]:0").unwrap());
        let ch4 = P2pChannel::new(s4, "1.2.3.4:9100".parse().unwrap(), false, None, true);
        let ch6 = P2pChannel::new(s6, "[2001:db8::1]:9100".parse().unwrap(), true, None, true);
        assert_eq!(ch4.pipe_kind(), crate::vnet::pathpipe::PipeKind::P2pV4);
        assert_eq!(ch6.pipe_kind(), crate::vnet::pathpipe::PipeKind::P2pV6);
    }

    #[test]
    fn rebuild_only_on_ip_change_or_verified_upgrade() {
        let s = sock();
        let a: SocketAddr = "1.2.3.4:5000".parse().unwrap();
        let a2: SocketAddr = "1.2.3.4:5001".parse().unwrap();
        let b: SocketAddr = "5.6.7.8:5000".parse().unwrap();
        let ch = P2pChannel::new(s, a, false, None, false);
        assert!(!chan_rebuild_needed(&ch, a2, false), "same ip scan knock: never rebuild");
        assert!(chan_rebuild_needed(&ch, a2, true), "same ip + verified upgrade: replace");
        assert!(chan_rebuild_needed(&ch, b, false), "ip changed: rebuild");
    }
}
