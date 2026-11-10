//! C 认知层 —— PathBelief：消费 P 层观察，更新 S 层 PathPipe。
//!
//! 实现全部三个传感器 trait（ProbeSensor / ArqSensor / NetSensor）。
//! 每个更新方法都标注它与 connection.rs 旧栈哪一段 O(shadow) 逻辑一一对应
//! （行为零变化；旧栈内联块 → 本层方法，仅归位，不改语义）。
//!
//! 证据强度差异（从旧栈逐字保留）：
//! - relay-socket 回包：弱证据，连续 3 次（A9 迟滞）才 verified；
//! - 监听 socket 上的 REPLY 往返 / 打洞胜出 / verify-ACK：立即 verified；
//! - REQUEST 敲门只有 v4 监听面算双向（打的是我们自己保活出的公告映射），
//!   v6 监听面只计数（等 verify-ACK 决议）。

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use crate::vnet::pathpipe::{index_of, PipeKind};
use crate::vnet::perception::{ArqSensor, NetSensor, ProbeSensor, ProbeSurface};
use crate::vnet::problem::r_path_policy::RPolicy;
use crate::vnet::problem::s_path_state::PathStateStore;

/// ARQ (sent, acked) 快照滑窗容量（10 格 @1s/格 = 10s 窗口，与旧栈 st_w_hist 一致）。
const ARQ_HIST_CAP: usize = 10;

/// C：路径信念 —— 把观察翻译成 PathPipe 的 o_* 更新。
pub struct PathBelief {
    store: Arc<PathStateStore>,
    policy: RPolicy,
    /// relay-socket 探测回包迟滞计数（A9：连续 3 次才允许 verified）。
    /// 旧栈 switch_score；探测静默 30s / 出口变化时清零（对应旧栈两处 =0）。
    reply_score: AtomicU32,
    /// ARQ (sent, acked) 快照滑窗（旧栈 st_w_hist）——窗口 ACK 率证据源。
    arq_hist: Mutex<VecDeque<(u64, u64)>>,
    /// 最近一次 NAT 画像（P→C 记录；当前不 gate 决策，B4 策略引擎将消费）
    nat_profile: Mutex<Option<&'static str>>,
    /// 最近一次防火墙状态（同上）
    fw_status: Mutex<Option<&'static str>>,
}

impl PathBelief {
    pub fn new(store: Arc<PathStateStore>, policy: RPolicy) -> Self {
        Self {
            store,
            policy,
            reply_score: AtomicU32::new(0),
            arq_hist: Mutex::new(VecDeque::new()),
            nat_profile: Mutex::new(None),
            fw_status: Mutex::new(None),
        }
    }

    /// 地址族 → 管道类别（观察的 `from` 决定写到哪条管道）。
    fn kind_of(from: SocketAddr) -> PipeKind {
        if from.is_ipv6() { PipeKind::P2pV6 } else { PipeKind::P2pV4 }
    }

    /// 拿到一条管道的写句柄并顺手重算派生态（所有更新方法的公共尾巴）。
    fn with_pipe<R>(&self, kind: PipeKind, f: impl FnOnce(&mut crate::vnet::pathpipe::PathPipe) -> R) -> R {
        let mut ps = self.store.pipes.lock().unwrap();
        let p = &mut ps[index_of(kind)];
        let r = f(p);
        p.update_derived(&self.policy);
        r
    }

    // ── relay-socket 回包迟滞（A9）状态 ──

    /// 当前迟滞计数（探测线程判 ready/score>=3 用）
    pub fn reply_score(&self) -> u32 {
        self.reply_score.load(Ordering::Relaxed)
    }

    /// score>=3：relay-socket 回包证据已足（旧栈 `ready`）
    pub fn reply_ready(&self) -> bool {
        self.reply_score() >= 3
    }

    /// 清零迟滞计数（旧栈两处 `*switch_score = 0`：30s 静默回退 / 出口变化）
    pub fn reset_reply_score(&self) {
        self.store_clear_score();
    }

    fn store_clear_score(&self) {
        self.reply_score.store(0, Ordering::Relaxed);
    }

    // ── 通道级事件（vnet 特有的 C 输入；旧栈散在 verify 决议 / 转发失败处） ──

    /// verify 决议 Pass（RDV6 的 1 字节验证包 ACK 到达）→ 该族管道双向验证过。
    /// 对应旧栈：tick6 块 VRes::Pass 里的 p6.mark_verified()。
    pub fn on_channel_verified(&self, kind: PipeKind) {
        self.with_pipe(kind, |p| p.mark_verified());
    }

    /// verify 决议 Fail（2s 无 ACK）→ 失败游程 +1。
    /// 对应旧栈：tick6 块 VRes::Fail 里的 p6.mark_failed()。
    pub fn on_channel_verify_failed(&self, kind: PipeKind) {
        self.with_pipe(kind, |p| p.mark_failed());
    }

    /// 通道发送失败（forward 线程 send err）→ 对应族管道记失败证据。
    /// 对应旧栈：forward up 线程 ch.stream.send() 出错分支。
    pub fn on_channel_send_failed(&self, kind: PipeKind) {
        self.with_pipe(kind, |p| p.mark_failed());
    }

    /// 探测静默 30s（保底 watchdog）→ 当前直连管道记失败证据 + 清迟滞。
    /// 对应旧栈：receiver 线程 30s 无探测回包分支（mark_failed + *score=0）。
    pub fn on_probe_silence(&self, kind: PipeKind) {
        self.store_clear_score();
        self.with_pipe(kind, |p| p.mark_failed());
    }

    /// ARQ 停滞 3s（数据面停滞看门狗）→ 该管道记失败证据。
    /// 对应旧栈：WD 停滞分支（mark_failed；清通道由调用方做，不在 C 层）。
    pub fn on_arq_stall(&self, kind: PipeKind) {
        self.with_pipe(kind, |p| p.mark_failed());
    }

    /// 出口 IP 变化（G3）→ 旧地址上的直连验证全部作废 + 清迟滞。
    /// 对应旧栈：探测循环 NET 分支（对 P2pV4/P2pV6 各 mark_failed 一次）。
    pub fn on_net_egress_changed(&self) {
        self.store_clear_score();
        for k in [PipeKind::P2pV4, PipeKind::P2pV6] {
            self.with_pipe(k, |p| p.mark_failed());
        }
    }

    /// 打洞胜出（PunchResult）→ 对应族管道 o_reply_rx+1 + 双向验证。
    /// 对应旧栈：打洞线程 punch_round 成功分支（不 push RTT，与旧栈一致）。
    pub fn on_punch_success(&self, is_ipv6: bool) {
        let kind = if is_ipv6 { PipeKind::P2pV6 } else { PipeKind::P2pV4 };
        self.with_pipe(kind, |p| {
            p.o_reply_rx += 1;
            p.mark_verified();
        });
    }

    /// 当前 NAT 画像（P 层记录；B4 消费位）
    pub fn nat_profile(&self) -> Option<&'static str> {
        *self.nat_profile.lock().unwrap()
    }

    /// 当前防火墙状态
    pub fn fw_status(&self) -> Option<&'static str> {
        *self.fw_status.lock().unwrap()
    }
}

// ── P 层 trait 实现 ──────────────────────────────────────────────────────────

impl ProbeSensor for PathBelief {
    /// 敲门包观察。按面解释（旧栈差异逐字保留）：
    /// - ListenV4：REQUEST 即双向证据（v4 汇合打的是我们自己保活出的公告映射）
    /// - ListenV6 / 其他面：只计数，verified 等 verify-ACK 决议
    fn on_request(&self, from: SocketAddr, surface: ProbeSurface) {
        let kind = Self::kind_of(from);
        match surface {
            ProbeSurface::ListenV4 => self.with_pipe(kind, |p| {
                p.o_req_rx += 1;
                p.mark_verified();
            }),
            _ => self.with_pipe(kind, |p| {
                p.o_req_rx += 1;
            }),
        }
    }

    /// 探测回包观察。按面解释：
    /// - Relay：弱证据——o_reply_rx+1，score>=3 才 verified（A9 迟滞；不采纳 rtt）
    /// - ListenV4 / ListenV6 / V6Probe：往返成立——o_reply_rx+1 + push_rtt + verified
    fn on_reply(&self, from: SocketAddr, rtt_ms: u64, surface: ProbeSurface) {
        let kind = Self::kind_of(from);
        match surface {
            ProbeSurface::Relay => {
                let score = self.reply_score.fetch_add(1, Ordering::Relaxed) + 1;
                let ready = score >= 3;
                self.with_pipe(kind, |p| {
                    p.o_reply_rx += 1;
                    if ready {
                        p.mark_verified();
                    }
                });
            }
            _ => {
                self.with_pipe(kind, |p| {
                    p.o_reply_rx += 1;
                    p.push_rtt(rtt_ms);
                    p.mark_verified();
                });
            }
        }
    }
}

impl ArqSensor for PathBelief {
    /// ARQ 统计观察：10 格滑窗的 (sent, acked) 增量比 → 当前通道对应管道的
    /// o_ack_ratio。对应旧栈 st_w_hist 块（窗口 ACK 率是轨迹证据，不是帧）。
    /// 地址族取**当前槽内通道**（与旧栈一致：watchdog 读 ch.is_ipv6）。
    fn on_stats(&self, sent: u64, acked: u64, _retrans: u64) {
        let kind = {
            let g = self.store.p2p_channel.lock().unwrap();
            g.as_ref().map(|ch| ch.pipe_kind())
        };
        let Some(kind) = kind else { return };
        let mut hist = self.arq_hist.lock().unwrap();
        hist.push_back((sent, acked));
        while hist.len() > ARQ_HIST_CAP {
            hist.pop_front();
        }
        if hist.len() >= 2 {
            let (s0, a0) = *hist.front().unwrap();
            if sent > s0 {
                let ratio = (acked - a0) as f32 / (sent - s0) as f32;
                drop(hist);
                self.with_pipe(kind, |p| {
                    p.o_ack_ratio = ratio.clamp(0.0, 1.0);
                });
            }
        }
    }
}

impl NetSensor for PathBelief {
    /// NAT 画像变化：当前只记录（旧栈不据此改管道；B4 策略引擎将消费）。
    fn on_nat_change(&self, profile: &'static str) {
        *self.nat_profile.lock().unwrap() = Some(profile);
    }

    /// 防火墙状态变化：同上，只记录。
    fn on_fw_change(&self, status: &'static str) {
        *self.fw_status.lock().unwrap() = Some(status);
    }

    /// 接口计费性变化 → Relay 管道 o_cost（对应旧栈 probe_default_if_cost 写入处；
    /// 与旧栈一致：只写 o_cost，不触发 update_derived——成本位不改变可选性）。
    fn on_cost_change(&self, cost: u8) {
        let mut ps = self.store.pipes.lock().unwrap();
        ps[index_of(PipeKind::Relay)].o_cost = cost;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::UdpSocket;

    use crate::vnet::env::t_p2p_channel::P2pChannel;

    fn belief() -> (Arc<PathStateStore>, PathBelief) {
        let store = Arc::new(PathStateStore::new());
        let b = PathBelief::new(store.clone(), RPolicy::default());
        (store, b)
    }

    fn v4() -> SocketAddr {
        "1.2.3.4:9100".parse().unwrap()
    }
    fn v6() -> SocketAddr {
        "[2001:db8::1]:9100".parse().unwrap()
    }
    fn obs(store: &PathStateStore, k: PipeKind) -> crate::vnet::problem::o_path_obs::PathObs {
        store.obs(k)
    }

    #[test]
    fn relay_reply_needs_three_hits_before_verified() {
        let (s, b) = belief();
        for i in 1..=2 {
            b.on_reply(v4(), 0, ProbeSurface::Relay);
            assert!(!obs(&s, PipeKind::P2pV4).o_verified_bidi, "hit {} not yet", i);
        }
        b.on_reply(v4(), 0, ProbeSurface::Relay);
        assert!(obs(&s, PipeKind::P2pV4).o_verified_bidi, "3rd hit verifies (A9)");
        assert_eq!(obs(&s, PipeKind::P2pV4).o_reply_rx, 3);
        // relay 面不采纳 RTT（无时间戳证据）
        assert!(obs(&s, PipeKind::P2pV4).o_rtt_window.is_empty());
    }

    #[test]
    fn listen_reply_verifies_immediately_with_rtt() {
        let (s, b) = belief();
        b.on_reply(v4(), 37, ProbeSurface::ListenV4);
        let o = obs(&s, PipeKind::P2pV4);
        assert!(o.o_verified_bidi);
        assert_eq!(o.o_reply_rx, 1);
        assert_eq!(rtt_of(&o), Some(37));

        b.on_reply(v6(), 51, ProbeSurface::ListenV6);
        let o6 = obs(&s, PipeKind::P2pV6);
        assert!(o6.o_verified_bidi);
        assert_eq!(rtt_of(&o6), Some(51));

        b.on_reply(v6(), 42, ProbeSurface::V6Probe);
        assert!(obs(&s, PipeKind::P2pV6).o_verified_bidi);
    }

    #[test]
    fn request_on_v4_listen_verifies_v6_does_not() {
        let (s, b) = belief();
        b.on_request(v4(), ProbeSurface::ListenV4);
        let o4 = obs(&s, PipeKind::P2pV4);
        assert!(o4.o_verified_bidi, "v4 knock hits our announced mapping = bidi");
        assert_eq!(o4.o_req_rx, 1);

        b.on_request(v6(), ProbeSurface::ListenV6);
        let o6 = obs(&s, PipeKind::P2pV6);
        assert_eq!(o6.o_req_rx, 1);
        assert!(!o6.o_verified_bidi, "v6 knock proves peer->us only");
    }

    #[test]
    fn probe_silence_fails_pipe_and_resets_hysteresis() {
        let (s, b) = belief();
        for _ in 0..3 {
            b.on_reply(v4(), 0, ProbeSurface::Relay);
        }
        assert!(b.reply_ready());
        b.on_probe_silence(PipeKind::P2pV4);
        assert_eq!(b.reply_score(), 0);
        let o = obs(&s, PipeKind::P2pV4);
        assert!(!o.o_verified_bidi);
        assert_eq!(o.o_failure_run, 1);
    }

    #[test]
    fn net_egress_change_fails_both_direct_pipes() {
        let (s, b) = belief();
        b.on_reply(v4(), 10, ProbeSurface::ListenV4);
        b.on_reply(v6(), 10, ProbeSurface::ListenV6);
        b.on_net_egress_changed();
        assert!(!obs(&s, PipeKind::P2pV4).o_verified_bidi);
        assert!(!obs(&s, PipeKind::P2pV6).o_verified_bidi);
        assert_eq!(obs(&s, PipeKind::P2pV4).o_failure_run, 1);
        assert_eq!(obs(&s, PipeKind::P2pV6).o_failure_run, 1);
    }

    #[test]
    fn verify_resolution_updates_pipe() {
        let (s, b) = belief();
        b.on_channel_verified(PipeKind::P2pV6);
        assert!(obs(&s, PipeKind::P2pV6).o_verified_bidi);
        b.on_channel_verify_failed(PipeKind::P2pV6);
        assert!(!obs(&s, PipeKind::P2pV6).o_verified_bidi);
        b.on_channel_verified(PipeKind::P2pV6);
        assert_eq!(obs(&s, PipeKind::P2pV6).o_failure_run, 0, "success clears run");
    }

    #[test]
    fn punch_success_verifies_family_pipe() {
        let (s, b) = belief();
        b.on_punch_success(false);
        assert!(obs(&s, PipeKind::P2pV4).o_verified_bidi);
        assert_eq!(obs(&s, PipeKind::P2pV4).o_reply_rx, 1);
        assert!(obs(&s, PipeKind::P2pV4).o_rtt_window.is_empty(), "old stack does not push rtt on punch");
        b.on_punch_success(true);
        assert!(obs(&s, PipeKind::P2pV6).o_verified_bidi);
    }

    #[test]
    fn arq_stats_window_ratio_writes_current_channel_pipe() {
        let (s, b) = belief();
        // 无通道：不写
        b.on_stats(100, 100, 0);
        assert!((obs(&s, PipeKind::P2pV4).o_ack_ratio - 1.0).abs() < f32::EPSILON);

        // 放一条 v4 通道
        let sock = Arc::new(UdpSocket::bind("127.0.0.1:0").unwrap());
        *s.p2p_channel.lock().unwrap() =
            Some(P2pChannel::new(sock, v4(), false, None, true));

        b.on_stats(100, 50, 0); // 窗口第 1 格
        assert!((obs(&s, PipeKind::P2pV4).o_ack_ratio - 1.0).abs() < f32::EPSILON, "need >=2 samples");
        b.on_stats(200, 100, 0); // 增量 (100,50) → 0.5
        let o = obs(&s, PipeKind::P2pV4);
        assert!((o.o_ack_ratio - 0.5).abs() < 1e-4);

        // sent 不前进（无新流量）：不更新
        b.on_stats(200, 100, 0);
        assert!((obs(&s, PipeKind::P2pV4).o_ack_ratio - 0.5).abs() < 1e-4);
    }

    #[test]
    fn cost_change_only_touches_relay_pipe() {
        let (s, b) = belief();
        b.on_cost_change(1);
        assert_eq!(obs(&s, PipeKind::Relay).o_cost, 1);
        assert_eq!(obs(&s, PipeKind::P2pV4).o_cost, 0);
    }

    #[test]
    fn net_sensor_records_profile_and_fw() {
        let (_s, b) = belief();
        b.on_nat_change("ip-based(ADF/EIF)");
        b.on_fw_change("blocked");
        assert_eq!(b.nat_profile(), Some("ip-based(ADF/EIF)"));
        assert_eq!(b.fw_status(), Some("blocked"));
    }

    fn rtt_of(o: &crate::vnet::problem::o_path_obs::PathObs) -> Option<u64> {
        crate::vnet::problem::o_path_obs::rtt_evidence(o)
    }
}
