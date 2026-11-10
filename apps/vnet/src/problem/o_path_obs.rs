//! O：路径观察类型（ROSA 问题空间）—— 带「帧 / 轨迹」时间形状的观察值对象。
//!
//! P 层（perception）产出观察 → C 层（cognition）把它们写进 S 层的 PathPipe。
//! PathPipe 是旧栈「观察 + S 派生态」的合体正本（不能动），PathObs 是它的
//! **纯观察投影**：供 C 层快照、状态报告、R 层打分（r_reward）与单测使用，
//! 不携带任何派生态（s_selectable 等不在此）。
//!
//! 时间形状（AOP 范式 O 注释约定）：
//! - 帧（frame）：瞬时成立/计数的观察，最新值覆盖旧值；
//! - 轨迹（trajectory）：带窗口/游程形状的时间序列，不能只看瞬时值。

use std::collections::VecDeque;

use crate::pathpipe::{PathPipe, RTT_WINDOW_CAP};

/// 一条候选管道在某个时刻的观察快照（与 PathPipe 的 o_* 字段一一对应）。
#[derive(Debug, Clone, PartialEq)]
pub struct PathObs {
    /// 帧：双向验证过（verify 门，直连管道必须 true 才可选）
    pub o_verified_bidi: bool,
    /// 帧：敲门包（REQUEST）计数
    pub o_req_rx: u64,
    /// 帧：探测回包（REPLY）计数
    pub o_reply_rx: u64,
    /// 轨迹：RTT 滑窗（容量 RTT_WINDOW_CAP=32，先进先出）
    pub o_rtt_window: VecDeque<u64>,
    /// 轨迹：窗口 ACK 率（0.0-1.0）。初始 1.0 = 尚无流量证据——
    /// 0 流量时不应因 ACK 率门槛否决一条刚通过双向验证的管道。
    pub o_ack_ratio: f32,
    /// 轨迹：连续验证失败游程（成功一次即清零）
    pub o_failure_run: u32,
    /// 帧：0=免费(WiFi/有线) 1=计费(蜂窝)
    pub o_cost: u8,
}

impl PathObs {
    /// 空观察（无流量证据的初始态：ack_ratio=1.0 无反例）。
    pub fn empty() -> Self {
        Self {
            o_verified_bidi: false,
            o_req_rx: 0,
            o_reply_rx: 0,
            o_rtt_window: VecDeque::new(),
            o_ack_ratio: 1.0,
            o_failure_run: 0,
            o_cost: 0,
        }
    }
}

/// 从 PathPipe 投影出纯观察快照（S 派生态被丢弃）。
pub fn obs_of(pipe: &PathPipe) -> PathObs {
    PathObs {
        o_verified_bidi: pipe.o_verified_bidi,
        o_req_rx: pipe.o_req_rx,
        o_reply_rx: pipe.o_reply_rx,
        o_rtt_window: pipe.o_rtt_window.clone(),
        o_ack_ratio: pipe.o_ack_ratio,
        o_failure_run: pipe.o_failure_run,
        o_cost: pipe.o_cost,
    }
}

/// RTT 证据（ms）：滑窗均值；窗口为空即无证据。
/// 与 PathPipe::rtt_evidence_ms 同式——差异仅在于 PathPipe 还能退到最近帧
/// （o_rtt_last_ms 是旧栈 S 派生态字段，PathObs 按规格只含 7 个 o_* 观察位）。
pub fn rtt_evidence(obs: &PathObs) -> Option<u64> {
    if obs.o_rtt_window.is_empty() {
        return None;
    }
    let n = obs.o_rtt_window.len() as u64;
    Some(obs.o_rtt_window.iter().sum::<u64>() / n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pathpipe::PipeKind;

    #[test]
    fn empty_obs_is_unverified_neutral() {
        let o = PathObs::empty();
        assert!(!o.o_verified_bidi);
        assert_eq!(o.o_req_rx, 0);
        assert_eq!(o.o_reply_rx, 0);
        assert_eq!(o.o_failure_run, 0);
        assert_eq!(o.o_cost, 0);
        assert!((o.o_ack_ratio - 1.0).abs() < f32::EPSILON, "no counter-evidence yet");
        assert!(rtt_evidence(&o).is_none());
    }

    #[test]
    fn obs_of_drops_derived_state() {
        let mut p = PathPipe::new(PipeKind::P2pV4);
        p.mark_verified();
        p.o_req_rx = 3;
        p.o_reply_rx = 5;
        p.o_failure_run = 0;
        p.push_rtt(30);
        p.o_ack_ratio = 0.8;
        p.o_cost = 1;
        p.update_derived(&crate::pathpipe::RPolicy::default());
        assert!(p.s_selectable, "pipe has derived state");

        let o = obs_of(&p);
        assert!(o.o_verified_bidi);
        assert_eq!(o.o_req_rx, 3);
        assert_eq!(o.o_reply_rx, 5);
        assert_eq!(o.o_cost, 1);
        assert_eq!(rtt_evidence(&o), Some(30));
        // PathObs 不携带 s_* 字段（编译期保证），投影是纯观察
    }

    #[test]
    fn rtt_evidence_uses_window_mean() {
        let mut o = PathObs::empty();
        for ms in [10u64, 20, 30, 40] {
            o.o_rtt_window.push_back(ms);
        }
        assert_eq!(rtt_evidence(&o), Some(25));
    }

    #[test]
    fn frame_vs_trajectory_annotations_hold() {
        // 轨迹字段：窗口封顶 32（与 PathPipe::push_rtt 相同容量）
        let mut o = PathObs::empty();
        for i in 1..=40u64 {
            o.o_rtt_window.push_back(i);
            while o.o_rtt_window.len() > RTT_WINDOW_CAP {
                o.o_rtt_window.pop_front();
            }
        }
        assert_eq!(o.o_rtt_window.len(), RTT_WINDOW_CAP);
        assert_eq!(*o.o_rtt_window.front().unwrap(), 9);
        // 帧字段：计数单调
        o.o_req_rx += 1;
        o.o_req_rx += 1;
        assert_eq!(o.o_req_rx, 2);
    }
}
