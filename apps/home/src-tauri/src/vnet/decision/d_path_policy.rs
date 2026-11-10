//! D 决策层 —— decide(store, policy) -> PathAction。
//!
//! 从 S 层状态（PathStateStore）按 R 权重选出目标管道，判断是否需要切换。
//! 本层是 apply_decision（connection.rs）决策部分的归位：**只裁决，不动状态**——
//! 落地（改 path、计数、打印）由 A 执行层（action::a_switch_path）做。
//!
//! 规则（与旧栈逐字对齐，见 connection.rs apply_decision 注释）：
//! 1) Relay 永远可选（直连优先无条件成立，Relay 成本不参与裁决）
//! 2) 只认**已通过双向验证的通道**（REQUEST 敲门创建的未验证通道不承载业务）
//! 3) 首选族暂无通道、但现有通道族仍可选时，落到现有通道族（直连优先，下一事件再升级）
//! 4) VNET_NO_P2P=1 诊断门：绝不升级离 Relay（降级不受影响）
//! 5) 证据降级不清 P2P 通道（清通道由调用点做：watchdog 停滞 / forward 发送失败）

use crate::vnet::pathpipe::{index_of, PipeKind};
use crate::vnet::problem::a_path_action::{PathAction, SwitchParams};
use crate::vnet::problem::r_path_policy::RPolicy;
use crate::vnet::problem::s_path_state::{DataPath, PathStateStore};

/// D 决策入口：按当前环境诊断门裁决。
/// VNET_NO_P2P=1 → 不允许升级离开 Relay（纯中继对照语义，全局成立）。
pub fn decide(store: &PathStateStore, policy: &RPolicy) -> PathAction {
    let no_p2p = std::env::var("VNET_NO_P2P").unwrap_or_default() == "1";
    decide_with(store, policy, !no_p2p)
}

/// 参数化裁决（单测/FFI 用）：`allow_direct_upgrade=false` 等价 VNET_NO_P2P=1。
pub fn decide_with(
    store: &PathStateStore,
    policy: &RPolicy,
    allow_direct_upgrade: bool,
) -> PathAction {
    // 1) 重算派生态并 pick（锁内完成，释放后再看路径/通道——锁纪律：绝不嵌套）
    let pick = {
        let mut ps = store.pipes.lock().unwrap();
        for p in ps.iter_mut() {
            p.update_derived(policy);
        }
        crate::vnet::pathpipe::pick_pipe(&ps, policy)
    };
    let cur = store.current();
    let cur_kind = cur.kind();
    if pick == cur_kind {
        return PathAction::Noop;
    }
    // 2) 诊断门：不允许升级离开 Relay（降级到 Relay 不受影响）
    if pick != PipeKind::Relay && !allow_direct_upgrade {
        return PathAction::Noop;
    }
    // 3) 通道约束：只认已双向验证的通道
    let chan_kind = store.verified_channel_kind();
    let want = match pick {
        PipeKind::Relay => Some(PipeKind::Relay),
        k => {
            if chan_kind == Some(k) {
                Some(k)
            } else if let Some(ck) = chan_kind {
                // 首选族无通道：现有通道族仍可选则先用它（直连优先）
                let selectable = {
                    let ps = store.pipes.lock().unwrap();
                    let pp = &ps[index_of(ck)];
                    pp.s_selectable && pp.o_ack_ratio >= policy.r_min_ack_ratio
                };
                if selectable { Some(ck) } else { None }
            } else {
                None
            }
        }
    };
    match want {
        Some(k) if k != cur_kind => PathAction::SwitchPipe(SwitchParams { kind: k, from: cur }),
        _ => PathAction::Noop,
    }
}

#[cfg(test)]
mod tests {
    use std::net::UdpSocket;
    use std::sync::Arc;

    use crate::vnet::env::t_p2p_channel::P2pChannel;

    use super::*;

    fn store() -> PathStateStore {
        PathStateStore::new()
    }

    fn v4_addr() -> std::net::SocketAddr {
        "1.2.3.4:9100".parse().unwrap()
    }
    fn v6_addr() -> std::net::SocketAddr {
        "[2001:db8::1]:9100".parse().unwrap()
    }

    fn verify_pipe(s: &PathStateStore, k: PipeKind) {
        let mut ps = s.pipes.lock().unwrap();
        let p = &mut ps[index_of(k)];
        p.mark_verified();
        p.update_derived(&RPolicy::default());
    }

    fn put_channel(s: &PathStateStore, v6: bool, verified: bool) {
        let sock = if v6 {
            Arc::new(UdpSocket::bind("[::]:0").unwrap())
        } else {
            Arc::new(UdpSocket::bind("127.0.0.1:0").unwrap())
        };
        let peer = if v6 { v6_addr() } else { v4_addr() };
        *s.p2p_channel.lock().unwrap() = Some(P2pChannel::new(sock, peer, v6, None, verified));
    }

    #[test]
    fn no_evidence_on_relay_is_noop() {
        let s = store();
        assert!(decide_with(&s, &RPolicy::default(), true).is_noop());
    }

    #[test]
    fn verified_v6_pipe_and_channel_switches_from_relay() {
        let s = store();
        verify_pipe(&s, PipeKind::P2pV6);
        put_channel(&s, true, true);
        match decide_with(&s, &RPolicy::default(), true) {
            PathAction::SwitchPipe(p) => {
                assert_eq!(p.kind, PipeKind::P2pV6);
                assert_eq!(p.from, DataPath::Relay);
            }
            a => panic!("expected SwitchPipe, got {:?}", a),
        }
    }

    #[test]
    fn no_direct_upgrade_gate_keeps_relay_but_allows_downgrade() {
        // 诊断门（VNET_NO_P2P=1）：升级被否决
        let s = store();
        verify_pipe(&s, PipeKind::P2pV4);
        put_channel(&s, false, true);
        assert!(decide_with(&s, &RPolicy::default(), false).is_noop());

        // 降级不受影响：当前 P2P、直连证据全部失效 → 切回 Relay
        let s2 = store();
        *s2.current_path.lock().unwrap() = DataPath::P2PUdp;
        put_channel(&s2, false, true); // 通道在，但管道无证据（pick 必为 Relay）
        match decide_with(&s2, &RPolicy::default(), false) {
            PathAction::SwitchPipe(p) => {
                assert_eq!(p.kind, PipeKind::Relay);
                assert_eq!(p.from, DataPath::P2PUdp);
            }
            a => panic!("downgrade must pass the gate, got {:?}", a),
        }
    }

    #[test]
    fn unverified_channel_blocks_upgrade() {
        let s = store();
        verify_pipe(&s, PipeKind::P2pV4);
        put_channel(&s, false, false); // REQUEST 敲门创建的未验证通道
        assert!(decide_with(&s, &RPolicy::default(), true).is_noop(),
            "pipe-level verified must not endorse an unverified channel");
    }

    #[test]
    fn falls_back_to_existing_channel_family() {
        // 首选 v6 无通道，但槽内是已验证 v4 通道且 v4 可选 → 落到 v4（直连优先）
        let s = store();
        verify_pipe(&s, PipeKind::P2pV4);
        verify_pipe(&s, PipeKind::P2pV6);
        put_channel(&s, false, true);
        match decide_with(&s, &RPolicy::default(), true) {
            PathAction::SwitchPipe(p) => assert_eq!(p.kind, PipeKind::P2pV4),
            a => panic!("expected fallback to v4, got {:?}", a),
        }
    }

    #[test]
    fn pick_equal_to_current_is_noop() {
        let s = store();
        verify_pipe(&s, PipeKind::P2pV4);
        put_channel(&s, false, true);
        *s.current_path.lock().unwrap() = DataPath::P2PUdp;
        assert!(decide_with(&s, &RPolicy::default(), true).is_noop());
    }

    #[test]
    fn unselectable_existing_channel_blocks_upgrade() {
        // 首选 v6 无通道；槽内 v4 通道已验证但 v4 管道证据不足（ack_ratio 低）→ 不切
        let s = store();
        verify_pipe(&s, PipeKind::P2pV6);
        verify_pipe(&s, PipeKind::P2pV4);
        {
            let mut ps = s.pipes.lock().unwrap();
            ps[index_of(PipeKind::P2pV4)].o_ack_ratio = 0.1;
        }
        put_channel(&s, false, true);
        assert!(decide_with(&s, &RPolicy::default(), true).is_noop());
    }
}
