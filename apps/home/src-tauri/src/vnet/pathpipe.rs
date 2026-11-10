//! 路径决策 —— PCDATR 实例化
//!
//! ROSA（问题空间）：
//!   R 评价指标（用户可调，FFI 将来注入）：延迟权重/成本权重/稳定性权重/偏好序
//!   O 观察（带时间形状）：o_verified_bidi(帧·双向验证)、o_req_rx/o_reply_rx(帧·计数)、
//!       o_rtt_window(轨迹·滑窗)、o_ack_ratio(轨迹·窗口ACK率)、o_failure_run(轨迹·游程)、o_cost(帧)
//!   S 状态：s_pipes —— 每条候选管道一个 PathPipe（Relay/P2pV4/P2pV6），ENV 线程持续更新
//!   A 动作：switch_path(pipe_kind)
//! PCDATR（解空间）：
//!   P=现有探测线程(ENV冻结层,产出O) C=PathPipe窗口统计(belief组装)
//!   D=pick_pipe(事件驱动) A=switch_path执行体 T=网络动力学+未暴露控制面的内部机械
//!
//! 直连优先永远成立（PATH-STRATEGY.md §1）：只要有可选直连就用直连，中继是兜底；
//! 直连内部按偏好序（v6>v4，可由 R 关闭）+ 实测质量排序。
//! 防抖动的正确位置是证据门（s_selectable / o_ack_ratio 门槛），
//! 不是时间门 —— 这是本模块取代 P2P_COOLDOWN 时间冷却的根据。

use std::collections::VecDeque;

/// 管道类别（S：每条候选管道一个 PathPipe）。
/// 排列顺序即 std_pipes() 的固定下标：0=Relay 1=P2pV4 2=P2pV6。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipeKind {
    Relay,
    P2pV4,
    P2pV6,
}

/// s_pipes 中该类别的固定下标（接线层用，避免每次线性查找）。
pub fn index_of(kind: PipeKind) -> usize {
    match kind {
        PipeKind::Relay => 0,
        PipeKind::P2pV4 => 1,
        PipeKind::P2pV6 => 2,
    }
}

/// 一条候选管道的观察与派生态（O + S 派生）。
#[derive(Debug, Clone)]
pub struct PathPipe {
    pub kind: PipeKind,
    // ── O 观察 ──
    /// 帧：双向验证过（verify 门，直连管道必须 true 才可选）
    pub o_verified_bidi: bool,
    /// 帧：敲门包计数
    pub o_req_rx: u64,
    /// 帧：探测回包计数
    pub o_reply_rx: u64,
    /// 帧：最近 RTT
    pub o_rtt_last_ms: u64,
    /// 轨迹：滑窗（容量 32）
    pub o_rtt_window: VecDeque<u64>,
    /// 轨迹：窗口 ACK 率（0.0-1.0）。
    /// 初始 1.0 = 尚无流量证据（watchdog 只在有数据后写入实测值）——
    /// 0 流量时不应因 ACK 率门槛否决一条刚通过双向验证的管道。
    pub o_ack_ratio: f32,
    /// 轨迹：连续验证失败游程
    pub o_failure_run: u32,
    /// 帧：0=免费(WiFi/有线) 1=计费(蜂窝)
    pub o_cost: u8,
    // ── S 派生态 ──
    /// = o_verified_bidi && o_failure_run < r_max_failure_run（证据门，防抖动的正确位置）。
    /// 由 update_derived() 在每次观察更新后重算；pick_pipe 只信这个位 + ACK 门槛。
    pub s_selectable: bool,
    pub s_updated_at: std::time::Instant,
}

/// RTT 滑窗容量（轨迹形状固定 32 个样本）。
pub const RTT_WINDOW_CAP: usize = 32;

impl PathPipe {
    /// 新管道：未验证、无计数、免费、ACK 率 1.0（无反例证据）。
    pub fn new(kind: PipeKind) -> Self {
        Self {
            kind,
            o_verified_bidi: false,
            o_req_rx: 0,
            o_reply_rx: 0,
            o_rtt_last_ms: 0,
            o_rtt_window: VecDeque::new(),
            o_ack_ratio: 1.0,
            o_failure_run: 0,
            o_cost: 0,
            s_selectable: false,
            s_updated_at: std::time::Instant::now(),
        }
    }

    /// 轨迹：追加一个 RTT 样本（滑窗容量 32，先进先出）。
    pub fn push_rtt(&mut self, ms: u64) {
        self.o_rtt_last_ms = ms;
        self.o_rtt_window.push_back(ms);
        while self.o_rtt_window.len() > RTT_WINDOW_CAP {
            self.o_rtt_window.pop_front();
        }
    }

    /// 帧：双向验证通过（verify 决议 Pass / 收到探测回包）——清失败游程。
    pub fn mark_verified(&mut self) {
        self.o_verified_bidi = true;
        self.o_failure_run = 0;
    }

    /// 帧：验证失败（verify 决议 Fail / 停滞降级）——游程 +1 并立即失去可选性。
    pub fn mark_failed(&mut self) {
        self.o_verified_bidi = false;
        self.o_failure_run += 1;
    }

    /// C（belief 组装）：由当前观察重算派生态。pick_pipe 前必须调用。
    pub fn update_derived(&mut self, r: &RPolicy) {
        self.s_selectable = self.o_verified_bidi && self.o_failure_run < r.r_max_failure_run;
        self.s_updated_at = std::time::Instant::now();
    }

    /// RTT 证据（ms）：优先滑窗均值，退而最近帧，无样本则 None。
    pub fn rtt_evidence_ms(&self) -> Option<u64> {
        if !self.o_rtt_window.is_empty() {
            let n = self.o_rtt_window.len() as u64;
            Some(self.o_rtt_window.iter().sum::<u64>() / n)
        } else if self.o_rtt_last_ms > 0 {
            Some(self.o_rtt_last_ms)
        } else {
            None
        }
    }
}

// R 正本已移入 problem/r_path_policy.rs（PCDATR M1）；此处转发，旧引用不断：
// crate::vnet::pathpipe::RPolicy 与 crate::vnet::problem::r_path_policy::RPolicy 是同一类型。
pub use crate::vnet::problem::r_path_policy::RPolicy;

/// S：标准 3 管道（固定下标序：Relay/P2pV4/P2pV6）。
/// Relay 生来 verified（中继注册成功即双向可用，规则 1）；直连管道待证据。
pub fn std_pipes() -> Vec<PathPipe> {
    let mut relay = PathPipe::new(PipeKind::Relay);
    relay.o_verified_bidi = true;
    relay.s_selectable = true;
    vec![relay, PathPipe::new(PipeKind::P2pV4), PathPipe::new(PipeKind::P2pV6)]
}

/// 偏好序排名（越小越优）。直连内部 v6/v4 的先验序；Relay 不参与直连排序。
fn pref_rank(kind: PipeKind, r: &RPolicy) -> u8 {
    match (kind, r.r_prefer_v6_over_v4) {
        (PipeKind::P2pV6, true) | (PipeKind::P2pV4, false) => 0,
        (PipeKind::P2pV4, true) | (PipeKind::P2pV6, false) => 1,
        (PipeKind::Relay, _) => 2,
    }
}

/// 加权分（同偏好序内裁决）：延迟 + 稳定性 - 成本惩罚。
/// 延迟归一：0ms→1.0，1000ms+→0.0；无 RTT 证据按 500ms（中性偏保守）。
fn weighted_score(p: &PathPipe, r: &RPolicy) -> f32 {
    let rtt_ms = p.rtt_evidence_ms().unwrap_or(500) as f32;
    let lat = 1.0 - (rtt_ms / 1000.0).clamp(0.0, 1.0);
    let stab = p.o_ack_ratio.clamp(0.0, 1.0);
    let cost_pen = p.o_cost.min(1) as f32;
    r.r_latency_w * lat + r.r_stability_w * stab - r.r_cost_w * cost_pen
}

/// D 决策：从 s_pipes 中按 R 权重选出当前管道。
/// 规则：1) Relay 永远可选（o_cost 按当前接口；直连优先无条件成立，故 Relay 成本不参与裁决）
///       2) 直连管道必须 s_selectable 且 o_ack_ratio >= r_min_ack_ratio（双重证据门，
///          s_selectable 可能是陈旧快照，ACK 门槛在决策点强制复查）
///       3) 候选内按 (偏好序 via r_prefer_v6_over_v4) > 加权分(延迟>稳定性>成本) 排序；
///          同分时取下标小者（确定性）
///       4) 无任何可选直连 → Relay
/// RTT 倒挂判定：直连 RTT 是否明显高于 relay（>1.5×）。
/// 任一缺失/为 0 = 不判（保持既有行为，避免误伤无证据场景）。
pub fn rtt_inversion(relay_ms: Option<u64>, p2p_ms: Option<u64>) -> bool {
    match (relay_ms, p2p_ms) {
        (Some(r), Some(p)) => r > 0 && p > r * 3 / 2,
        _ => false,
    }
}
pub fn pick_pipe(pipes: &[PathPipe], r: &RPolicy) -> PipeKind {
    let mut best: Option<(usize, u8, f32)> = None; // (idx, rank, score)
    for (i, p) in pipes.iter().enumerate() {
        if p.kind == PipeKind::Relay {
            continue; // 规则 1/4：Relay 是兜底，不进直连候选集
        }
        if !p.s_selectable || p.o_ack_ratio < r.r_min_ack_ratio {
            continue; // 规则 2：证据门
        }
        let rank = pref_rank(p.kind, r);
        let score = weighted_score(p, r);
        let replace = match best {
            None => true,
            Some((_, br, bs)) => rank < br || (rank == br && score > bs),
        };
        if replace {
            best = Some((i, rank, score));
        }
    }
    match best {
        Some((i, _, _)) => pipes[i].kind,
        None => PipeKind::Relay,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pipe(kind: PipeKind) -> PathPipe {
        let mut p = PathPipe::new(kind);
        p.mark_verified();
        p.update_derived(&RPolicy::default());
        p
    }

    #[test]
    fn rtt_inversion_needs_both_evidence() {
        assert!(!rtt_inversion(None, Some(80)), "缺 relay 基线不判");
        assert!(!rtt_inversion(Some(35), None), "缺直连 RTT 不判");
        assert!(!rtt_inversion(Some(0), Some(80)), "relay=0 视为未知");
    }

    #[test]
    fn rtt_inversion_threshold_is_1_5x() {
        // DSH F2 实测形态：relay 35ms、v6 直连 86ms → 必须判倒挂
        assert!(rtt_inversion(Some(35), Some(86)));
        assert!(rtt_inversion(Some(35), Some(53)), "53 > 35*1.5");
        assert!(!rtt_inversion(Some(35), Some(52)), "52 未过 1.5×");
        // 低 RTT 路径（本机 WiFi 实测 4.8ms vs relay 35ms）不应被判倒挂
        assert!(!rtt_inversion(Some(35), Some(5)));
    }
    #[test]
    fn no_direct_selectable_returns_relay() {
        let mut pipes = std_pipes();
        for p in pipes.iter_mut() {
            p.update_derived(&RPolicy::default());
        }
        assert_eq!(pick_pipe(&pipes, &RPolicy::default()), PipeKind::Relay);
    }

    #[test]
    fn verified_v6_preferred_over_v4_even_with_worse_rtt() {
        let mut v4 = pipe(PipeKind::P2pV4);
        v4.push_rtt(20);
        let mut v6 = pipe(PipeKind::P2pV6);
        v6.push_rtt(300); // v6 延迟差很多
        let pipes = vec![PathPipe::new(PipeKind::Relay), v4, v6];
        // 默认偏好序：v6 > v4（PATH-STRATEGY §2）
        assert_eq!(pick_pipe(&pipes, &RPolicy::default()), PipeKind::P2pV6);
    }

    #[test]
    fn prefer_disabled_lets_latency_decide() {
        let mut v4 = pipe(PipeKind::P2pV4);
        v4.push_rtt(20);
        let mut v6 = pipe(PipeKind::P2pV6);
        v6.push_rtt(100);
        let pipes = vec![PathPipe::new(PipeKind::Relay), v4, v6];
        let mut r = RPolicy::default();
        r.r_prefer_v6_over_v4 = false;
        assert_eq!(pick_pipe(&pipes, &r), PipeKind::P2pV4);
    }

    #[test]
    fn ack_ratio_below_min_not_selected() {
        // v6 质量劣化（有流量、ACK 率 0.3 < 0.5）：即使 verified 也不可选 → 落到 v4
        let mut v4 = pipe(PipeKind::P2pV4);
        v4.push_rtt(50);
        let mut v6 = pipe(PipeKind::P2pV6);
        v6.o_ack_ratio = 0.3;
        let pipes = vec![PathPipe::new(PipeKind::Relay), v4, v6.clone()];
        assert_eq!(pick_pipe(&pipes, &RPolicy::default()), PipeKind::P2pV4);

        // 两条直连都劣化 → Relay 兜底
        let mut v4b = pipe(PipeKind::P2pV4);
        v4b.o_ack_ratio = 0.1;
        let pipes2 = vec![PathPipe::new(PipeKind::Relay), v4b, v6];
        assert_eq!(pick_pipe(&pipes2, &RPolicy::default()), PipeKind::Relay);
    }

    #[test]
    fn failure_run_at_threshold_not_selected() {
        // 游程到阈值（3）：update_derived 置 s_selectable=false → 不选
        let mut v6 = pipe(PipeKind::P2pV6);
        v6.o_verified_bidi = true;
        v6.o_failure_run = 3;
        v6.update_derived(&RPolicy::default());
        assert!(!v6.s_selectable);
        let pipes = vec![
            PathPipe::new(PipeKind::Relay),
            PathPipe::new(PipeKind::P2pV4),
            v6,
        ];
        assert_eq!(pick_pipe(&pipes, &RPolicy::default()), PipeKind::Relay);

        // 游程 2（< 3）仍可选
        let mut v6b = pipe(PipeKind::P2pV6);
        v6b.o_failure_run = 2;
        v6b.o_verified_bidi = true;
        v6b.update_derived(&RPolicy::default());
        assert!(v6b.s_selectable);
        let pipes2 = vec![PathPipe::new(PipeKind::Relay), PathPipe::new(PipeKind::P2pV4), v6b];
        assert_eq!(pick_pipe(&pipes2, &RPolicy::default()), PipeKind::P2pV6);
    }

    #[test]
    fn direct_beats_relay_even_with_poor_quality() {
        // 直连优先无条件成立：900ms、计费、ACK 0.51（刚过门槛）仍是直连
        let mut v4 = pipe(PipeKind::P2pV4);
        v4.push_rtt(900);
        v4.o_cost = 1;
        v4.o_ack_ratio = 0.51;
        let pipes = vec![PathPipe::new(PipeKind::Relay), v4, PathPipe::new(PipeKind::P2pV6)];
        assert_eq!(pick_pipe(&pipes, &RPolicy::default()), PipeKind::P2pV4);
    }

    #[test]
    fn cost_penalty_breaks_ties_when_preference_disabled() {
        // 偏好关、延迟/稳定性同分：免费 v4 胜计费 v6（同级免费>计费）
        let mut v4 = pipe(PipeKind::P2pV4);
        v4.push_rtt(60);
        v4.o_cost = 0;
        let mut v6 = pipe(PipeKind::P2pV6);
        v6.push_rtt(60);
        v6.o_cost = 1;
        let pipes = vec![PathPipe::new(PipeKind::Relay), v4, v6];
        let mut r = RPolicy::default();
        r.r_prefer_v6_over_v4 = false;
        assert_eq!(pick_pipe(&pipes, &r), PipeKind::P2pV4);
    }

    #[test]
    fn rtt_window_caps_at_32_and_keeps_latest() {
        let mut p = PathPipe::new(PipeKind::P2pV6);
        for i in 1..=40u64 {
            p.push_rtt(i);
        }
        assert_eq!(p.o_rtt_window.len(), RTT_WINDOW_CAP);
        assert_eq!(p.o_rtt_last_ms, 40);
        // 滑窗只留最近 32 个（9..=40），均值落在中段
        assert_eq!(*p.o_rtt_window.front().unwrap(), 9);
        assert_eq!(*p.o_rtt_window.back().unwrap(), 40);
    }

    #[test]
    fn update_derived_gates_on_verified_and_run() {
        let r = RPolicy::default();
        let mut p = PathPipe::new(PipeKind::P2pV4);
        p.update_derived(&r);
        assert!(!p.s_selectable, "unverified pipe must not be selectable");
        p.mark_verified();
        p.update_derived(&r);
        assert!(p.s_selectable);
        p.mark_failed(); // verified=false + run=1
        p.update_derived(&r);
        assert!(!p.s_selectable);
        p.mark_verified(); // 成功一次即清游程
        assert_eq!(p.o_failure_run, 0);
    }

    #[test]
    fn empty_pipes_falls_back_to_relay() {
        assert_eq!(pick_pipe(&[], &RPolicy::default()), PipeKind::Relay);
    }

    #[test]
    fn std_pipes_order_and_relay_verified() {
        let pipes = std_pipes();
        assert_eq!(pipes.len(), 3);
        assert_eq!(pipes[0].kind, PipeKind::Relay);
        assert_eq!(pipes[1].kind, PipeKind::P2pV4);
        assert_eq!(pipes[2].kind, PipeKind::P2pV6);
        assert!(pipes[0].o_verified_bidi, "relay is born verified (rule 1)");
        assert!(!pipes[1].o_verified_bidi);
        assert!(!pipes[2].o_verified_bidi);
        assert_eq!(index_of(PipeKind::Relay), 0);
        assert_eq!(index_of(PipeKind::P2pV4), 1);
        assert_eq!(index_of(PipeKind::P2pV6), 2);
    }
}
