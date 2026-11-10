//! problem/ —— ROSA 问题空间（vnet 路径决策的 R/O/S/A 定义）。
//!
//! - R（r_path_policy）：评价指标（用户可调旋钮）+ r_reward 打分
//! - O（o_path_obs）：观察类型（帧/轨迹注解的 PathObs）
//! - S（s_path_state）：PathStateStore 统一状态容器 + DataPath
//! - A（a_path_action）：PathAction 动作语言（问题空间侧）
//!
//! 旧栈 S+D 雏形 pathpipe.rs 保留为正本之一：PipeKind/PathPipe/pick_pipe
//! 仍在那里（旧引用不断），本模块 re-export 对外统一入口。

pub mod a_path_action;
pub mod o_path_obs;
pub mod r_path_policy;
pub mod s_path_state;

pub use a_path_action::{AnnounceParams, PathAction, PunchTarget, SwitchParams};
pub use o_path_obs::{obs_of, rtt_evidence, PathObs};
pub use r_path_policy::{r_reward, r_reward_pipe, RPolicy};
pub use s_path_state::{data_path_for, data_path_kind, DataPath, PathStateStore};

// 旧栈正本 re-export（单一事实来源仍在 pathpipe.rs，避免两份定义漂移）
pub use crate::pathpipe::{index_of, pick_pipe, std_pipes, PathPipe, PipeKind, RTT_WINDOW_CAP};
