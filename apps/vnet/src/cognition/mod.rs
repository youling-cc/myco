//! C 认知层 —— 把 P 层观察解释为 S 层状态更新（belief 组装）。
//!
//! 当前唯一信念体：PathBelief（路径信念）。
//! 它实现全部 P 层传感器 trait，收到观察后更新 PathStateStore 里的
//! PathPipe（mark_verified / mark_failed / push_rtt / o_ack_ratio）。
//!
//! C 层不做决策：只负责「观察 → 状态」的翻译。要不要切路径是 D 层的事。

pub mod c_path_belief;

pub use c_path_belief::PathBelief;
