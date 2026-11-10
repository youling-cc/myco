//! T 环境层（协议/物理）—— vnet 与网络世界打交道的机械部分。
//!
//! 归位（PCDATR M5 渐进搬运，全部「移动/转发、不改逻辑」）：
//! - t_p2p_channel:   P2P 通道（P2pChannel）与通道重建判据（自 connection.rs 抽出）
//! - t_relay_proto:   中继协议客户端（自 relay.rs 移入）
//! - t_udp_transport: UDP/ARQ/TunnelStream（自 transport.rs + tunnel.rs 移入）
//!
//! 本层不做决策：只提供可被 A 层调用的原语、可被 P 层观察的事件源。
//! 旧模块（relay.rs/transport.rs/tunnel.rs）保留为转发 shim，旧引用不断。

pub mod t_p2p_channel;
