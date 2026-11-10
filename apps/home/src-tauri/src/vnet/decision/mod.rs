//! D 决策层 —— 裁决「下一条路径」，产出 PathAction。
//!
//! 输入：S 层 PathStateStore（观察已由 C 层更新完毕）
//! 输出：PathAction（SwitchPipe / PunchTrigger / Announce / Noop）
//! 执行：A 层（action/）。D 层绝不直接改状态——决策与执行分离是本层存在的意义。

pub mod d_path_policy;

pub use d_path_policy::{decide, decide_with};
