//! A（问题空间）：路径动作类型 —— 决策层（D）可以发出的全部动作。
//!
//! 注意与 action/（解空间 A 执行层）的区分：
//! - 本文件是 ROSA 里「问题空间的动作定义」（决策的输出语言）；
//! - action/ 是 PCDATR 的 A 执行层（把动作落到通道/打洞/公告上）。
//!
//! 当前决策层实际只发出 SwitchPipe（与旧栈 apply_decision 语义一致）；
//! PunchTrigger / Announce 是 PATH-STRATEGY 落地清单（B4 策略引擎、
//! 地址撤销公告）的预留动作位，定义与执行体齐备后由 decide() 逐步启用。

use std::net::SocketAddr;

use crate::vnet::pathpipe::PipeKind;
use crate::vnet::problem::s_path_state::DataPath;

/// 打洞目标参数（PunchTrigger 用）：对端 + 候选地址集。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PunchTarget {
    /// 目标对端 peer_id（0 = 未指定，由执行层按 learned peers 自驱）
    pub peer_id: u32,
    /// IPv4 候选（relay 观察地址 + 对端 STUN 公告映射）
    pub cands_v4: Vec<SocketAddr>,
    /// IPv6 候选（对端公告）
    pub cands_v6: Vec<SocketAddr>,
}

/// 公告参数（Announce 用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnnounceParams {
    /// 要公告的地址（v4 走 announce_ipv4，v6 走 announce_ipv6）
    pub addr: SocketAddr,
    /// true = 撤销公告（PATH-STRATEGY 落地清单第 2 项 Some→None 撤销，预留）
    pub withdraw: bool,
}

/// 切换参数（SwitchPipe 用）。
/// 注：不带 Eq——DataPath 与旧栈 connection.rs 同构（仅 PartialEq）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SwitchParams {
    /// 目标管道
    pub kind: PipeKind,
    /// 切换前路径（执行层打印与对账用）
    pub from: DataPath,
}

/// 决策层输出的动作。
#[derive(Debug, Clone, PartialEq)]
pub enum PathAction {
    /// 不动作（决议与现状一致，或被证据门 / VNET_NO_P2P 诊断门否决）
    Noop,
    /// 把数据面切到 kind 管道（决策只认 PipeKind；执行层映射回 DataPath）
    SwitchPipe(SwitchParams),
    /// 触发一次定向打洞（当前由打洞线程自驱；B4 策略引擎上线后由 decide 发出）
    PunchTrigger(PunchTarget),
    /// 公告/撤销本机地址（当前由监听线程自驱；预留）
    Announce(AnnounceParams),
}

impl PathAction {
    /// 便捷判定：是否为有效动作（非 Noop）
    pub fn is_noop(&self) -> bool {
        matches!(self, PathAction::Noop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noop_predicate() {
        assert!(PathAction::Noop.is_noop());
        assert!(!PathAction::SwitchPipe(SwitchParams {
            kind: PipeKind::P2pV6,
            from: DataPath::Relay,
        })
        .is_noop());
    }

    #[test]
    fn switch_params_carry_from_for_audit() {
        let a = PathAction::SwitchPipe(SwitchParams { kind: PipeKind::Relay, from: DataPath::P2PUdp });
        match a {
            PathAction::SwitchPipe(p) => {
                assert_eq!(p.kind, PipeKind::Relay);
                assert_eq!(p.from, DataPath::P2PUdp);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn announce_family_and_withdraw() {
        let a = AnnounceParams {
            addr: "[2001:db8::1]:9100".parse().unwrap(),
            withdraw: false,
        };
        assert!(a.addr.is_ipv6());
        assert!(!a.withdraw);
    }
}
