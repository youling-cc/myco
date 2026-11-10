//! A 执行层 —— 把 D 层的 PathAction 落到通道 / 打洞 / 公告上。
//!
//! 与 problem::a_path_action（问题空间动作**定义**）相区分：本目录是执行**体**。
//! 归位（PCDATR M4）：
//! - a_switch_path ← apply_decision 的落地半段（改 path / 计数 / 打印）
//! - a_punch       ← 打洞线程对 PunchEngine 的调用封装
//! - a_announce    ← 各线程对 relay.announce_ipv4/ipv6 的调用封装
//!
//! 纪律（与旧栈一致）：证据降级**不清 P2P 通道**——清通道 = ARQ 序号归零，
//! 对端在途流在 64 窗口内把新包全判重复吞掉。真死通道由调用点清
//! （watchdog 停滞 / forward 发送失败），不进本层。

pub mod a_announce;
pub mod a_punch;
pub mod a_switch_path;

pub use a_announce::execute_announce;
pub use a_punch::{build_engine, round_once, PunchOutcome};
pub use a_switch_path::{execute, execute_switch};

use std::sync::Arc;

use crate::relay::RelayClient;

/// A 层执行上下文：动作需要的外部句柄（当前只有 relay 协议客户端）。
pub struct ActionContext {
    pub relay: Arc<RelayClient>,
}
