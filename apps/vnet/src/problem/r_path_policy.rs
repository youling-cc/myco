//! R：路径决策评价指标（ROSA 问题空间）。
//!
//! 用户可调的策略旋钮（FFI 将来注入：vnet_set_path_policy），不含任何观察。
//! 正本自 pathpipe.rs 移入（PCDATR M1）；pathpipe.rs 保留 `pub use` 转发，旧引用不断。
//!
//! 与 PATH-STRATEGY.md 的对应：
//! - r_prefer_v6_over_v4 = §2 ②>③（公网 v6 直连 > IPv4 打洞）
//! - r_cost_w / o_cost   = §2 同级「免费介质 > 计费介质」
//! - r_min_ack_ratio / r_max_failure_run = §3 切换规则的证据门（防抖动的正确位置
//!   是证据门，不是时间门）

use crate::problem::o_path_obs::{obs_of, rtt_evidence, PathObs};
use crate::pathpipe::PathPipe;

/// R 评价指标（用户可调，FFI 将来注入）。所有字段都是纯策略旋钮，不含观察。
#[derive(Debug, Clone)]
pub struct RPolicy {
    /// R：延迟权重
    pub r_latency_w: f32,
    /// R：成本权重
    pub r_cost_w: f32,
    /// R：稳定性权重（ack_ratio 的权重）
    pub r_stability_w: f32,
    /// R：可选管道的最低 ACK 率阈值（默认 0.5）
    pub r_min_ack_ratio: f32,
    /// R：降级游程阈值（默认 3）
    pub r_max_failure_run: u32,
    /// R：偏好序（PATH-STRATEGY：Relay 兜底，直连里 v6>v4）——用 PipeKind 排序表达。
    /// true 时 v6 严格优先于 v4（PATH-STRATEGY §2 ②>③：v6 无 NAT 参与）；
    /// false 时由实测（延迟/稳定性/成本加权分）在 v4/v6 之间裁决。
    pub r_prefer_v6_over_v4: bool,
}

impl Default for RPolicy {
    fn default() -> Self {
        Self {
            r_latency_w: 1.0,
            r_cost_w: 0.5,
            r_stability_w: 1.0,
            r_min_ack_ratio: 0.5,
            r_max_failure_run: 3,
            r_prefer_v6_over_v4: true,
        }
    }
}

/// R 打分：对一份观察按 R 权重算奖励分（延迟 + 稳定性 - 成本惩罚）。
///
/// 与 pathpipe::weighted_score 同式（那是旧栈 D 内部函数，保持不动）；
/// r_reward 是它在新栈的 R 层正本，供决策层/测试/将来 B4 策略引擎直接使用。
/// 延迟归一：0ms→1.0，1000ms+→0.0；无 RTT 证据按 500ms（中性偏保守）。
pub fn r_reward(obs: &PathObs, r: &RPolicy) -> f32 {
    let rtt_ms = rtt_evidence(obs).unwrap_or(500) as f32;
    let lat = 1.0 - (rtt_ms / 1000.0).clamp(0.0, 1.0);
    let stab = obs.o_ack_ratio.clamp(0.0, 1.0);
    let cost_pen = obs.o_cost.min(1) as f32;
    r.r_latency_w * lat + r.r_stability_w * stab - r.r_cost_w * cost_pen
}

/// 便捷封装：直接对 PathPipe 的当前观察打分（投影 + r_reward）。
pub fn r_reward_pipe(p: &PathPipe, r: &RPolicy) -> f32 {
    r_reward(&obs_of(p), r)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obs(rtt: Option<u64>, ack: f32, cost: u8) -> PathObs {
        let mut o = PathObs::empty();
        o.o_ack_ratio = ack;
        o.o_cost = cost;
        if let Some(ms) = rtt {
            o.o_rtt_window.push_back(ms);
        }
        o
    }

    #[test]
    fn defaults_match_strategy() {
        let r = RPolicy::default();
        assert_eq!(r.r_prefer_v6_over_v4, true, "PATH-STRATEGY §2: v6 > v4");
        assert_eq!(r.r_max_failure_run, 3);
        assert!((r.r_min_ack_ratio - 0.5).abs() < f32::EPSILON);
    }

    #[test]
    fn lower_rtt_scores_higher() {
        let r = RPolicy::default();
        let fast = r_reward(&obs(Some(20), 1.0, 0), &r);
        let slow = r_reward(&obs(Some(300), 1.0, 0), &r);
        assert!(fast > slow);
    }

    #[test]
    fn no_evidence_scores_as_500ms_neutral() {
        let r = RPolicy::default();
        let none = r_reward(&obs(None, 1.0, 0), &r);
        let at500 = r_reward(&obs(Some(500), 1.0, 0), &r);
        assert!((none - at500).abs() < 1e-4);
    }

    #[test]
    fn cost_penalizes_when_weighted() {
        let r = RPolicy::default();
        let free = r_reward(&obs(Some(60), 1.0, 0), &r);
        let paid = r_reward(&obs(Some(60), 1.0, 1), &r);
        assert!(free > paid, "same-level free medium must beat billed");
        assert!((free - paid - r.r_cost_w).abs() < 1e-4);
    }

    #[test]
    fn stability_weights_ack_ratio() {
        let r = RPolicy::default();
        let solid = r_reward(&obs(Some(60), 1.0, 0), &r);
        let flaky = r_reward(&obs(Some(60), 0.2, 0), &r);
        assert!(solid > flaky);
    }

    #[test]
    fn reward_pipe_matches_obs_projection() {
        let mut p = PathPipe::new(crate::pathpipe::PipeKind::P2pV6);
        p.push_rtt(42);
        p.o_ack_ratio = 0.9;
        p.o_cost = 1;
        let r = RPolicy::default();
        assert!((r_reward_pipe(&p, &r) - r_reward(&obs_of(&p), &r)).abs() < 1e-6);
    }
}
