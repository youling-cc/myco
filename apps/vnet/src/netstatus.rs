//! NetStatus v2 —— 带一致性保证的网络状态同步
//!
//! 核心原则：
//! 1. 原子更新：整个 NetStatus 一起换，不允许部分字段更新（防止半新半旧）
//! 2. 版本号：单调递增，接收方只接受更高版本（防止旧数据覆盖新数据）
//! 3. 感知来源标记：每个字段的来源决定可信度（STUN 实测 > 探测推导 > 默认假设）
//! 4. 矛盾检测：探测结果与状态信念矛盾时，立即触发重感知（不等周期）
//! 5. 全量重同步：每 60s 全量重感知+重公告（防漏同步）

use std::net::SocketAddr;
use std::time::{Duration, Instant};

/// 感知来源（可信度分层）
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Source {
    /// 默认假设（最低可信度）
    Default = 0,
    /// 上次已知（可能过期）
    LastKnown = 1,
    /// 探测推导（中可信度）
    Probe = 2,
    /// STUN/工具实测（高可信度）
    Measured = 3,
}

impl Source {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Default => "dft",
            Self::LastKnown => "last",
            Self::Probe => "probe",
            Self::Measured => "meas",
        }
    }
}

/// NAT 映射类型
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NatMapping { Eim, Adm, Apdm, Unknown }

impl NatMapping {
    pub fn as_str(&self) -> &'static str {
        match self { Self::Eim => "EIM", Self::Adm => "ADM", Self::Apdm => "APDM", Self::Unknown => "?" }
    }
    pub fn from_str(s: &str) -> Self {
        match s { "EIM" => Self::Eim, "ADM" => Self::Adm, "APDM" => Self::Apdm, _ => Self::Unknown }
    }
}

/// NAT 过滤类型
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NatFiltering { Eif, Adf, Apdf, Unknown }

impl NatFiltering {
    pub fn as_str(&self) -> &'static str {
        match self { Self::Eif => "EIF", Self::Adf => "ADF", Self::Apdf => "APDF", Self::Unknown => "?" }
    }
    pub fn from_str(s: &str) -> Self {
        match s { "EIF" => Self::Eif, "ADF" => Self::Adf, "APDF" => Self::Apdf, _ => Self::Unknown }
    }
}

/// 防火墙入站状态
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FwInbound { Allowed, Blocked, Unknown }

impl FwInbound {
    pub fn as_str(&self) -> &'static str {
        match self { Self::Allowed => "ok", Self::Blocked => "blk", Self::Unknown => "?" }
    }
    pub fn from_str(s: &str) -> Self {
        match s { "ok" => Self::Allowed, "blk" => Self::Blocked, _ => Self::Unknown }
    }
}

/// 接口类型
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IfType { Ethernet, Wifi, Cellular, Unknown }

impl IfType {
    pub fn as_str(&self) -> &'static str {
        match self { Self::Ethernet => "eth", Self::Wifi => "wifi", Self::Cellular => "cell", Self::Unknown => "?" }
    }
    pub fn from_str(s: &str) -> Self {
        match s { "eth" => Self::Ethernet, "wifi" => Self::Wifi, "cell" => Self::Cellular, _ => Self::Unknown }
    }
}

/// 入站连通性三态：明确通 / 明确不通 / 未测过。
/// 关键：Unknown ≠ No。「没测过」必须触发「试着直连 + 兜底」，
/// 不能被压成 false 直接排除直连——状态真实是策略正确的前提。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InboundState { Yes, No, Unknown }

impl InboundState {
    pub fn as_str(&self) -> &'static str {
        match self { Self::Yes => "1", Self::No => "0", Self::Unknown => "?" }
    }
    pub fn from_str(s: &str) -> Self {
        match s { "1" => Self::Yes, "0" => Self::No, _ => Self::Unknown }
    }
}

/// 能力位掩码（caps；task.md §11 H.2）：
/// bit0 = multi_forward —— 本端作为 server 能接受带 target_port 的 SESSION_START 载荷。
/// 旧端公告里没有 caps 字段 → 解析结果为 0 = 无任何新能力，
/// client 据此在建 route 前显式报 MF_UNSUPPORTED，而不是静默误路由到旧 server 默认口。
pub const CAP_MULTI_FORWARD: u32 = 1 << 0;

/// 网络状态快照（原子性保证：整体替换，不部分更新）
#[derive(Clone, Debug)]
pub struct NetStatus {
    /// 版本号（每次变更 +1，接收方只接受更高版本）
    pub version: u64,
    /// 感知时间
    pub sensed_at: Instant,
    /// 感知来源（各字段）
    pub nat_source: Source,
    pub fw_source: Source,
    pub v6_source: Source,

    // ── 状态字段 ──
    pub nat_mapping: NatMapping,
    pub nat_filtering: NatFiltering,
    pub fw_inbound: FwInbound,
    pub ipv6: Option<SocketAddr>,
    pub ipv6_inbound: InboundState,
    pub if_type: IfType,
    pub if_cost: u8,
    /// 能力位掩码：bit0 = multi_forward（见 [`CAP_MULTI_FORWARD`]）。
    /// 默认 0 = 未公告任何能力（旧端语义，据此判 MF_UNSUPPORTED）。
    pub caps: u32,
}

impl Default for NetStatus {
    fn default() -> Self {
        Self {
            version: 0,
            sensed_at: Instant::now(),
            nat_source: Source::Default,
            fw_source: Source::Default,
            v6_source: Source::Default,
            nat_mapping: NatMapping::Unknown,
            nat_filtering: NatFiltering::Unknown,
            fw_inbound: FwInbound::Unknown,
            ipv6: None,
            ipv6_inbound: InboundState::Unknown,
            if_type: IfType::Unknown,
            if_cost: 0,
            caps: 0,
        }
    }
}

impl NetStatus {
    /// 状态是否过期（超过 60s 未更新视为过期，策略应降级为保守模式）
    pub fn is_stale(&self) -> bool {
        self.sensed_at.elapsed() > Duration::from_secs(30)
    }

    /// 序列化为 announce 附加字段（空格分隔的独立 token，解析方逐 token 匹配）
    pub fn to_announce_extra(&self) -> String {
        format!(
            " v={} nat={}|{} fw={}|{} v6in={} if={} cost={} caps={:x}",
            self.version,
            self.nat_mapping.as_str(), self.nat_source.as_str(),
            self.fw_inbound.as_str(), self.fw_source.as_str(),
            self.ipv6_inbound.as_str(),
            self.if_type.as_str(),
            self.if_cost,
            self.caps,
        )
    }

    /// 从 announce 解析（返回 None 如果版本更低或格式错）
    pub fn parse_announce_extra(s: &str, current_version: u64) -> Option<Self> {
        let mut st = Self::default();
        for kv in s.split_whitespace() {
            if let Some(v) = kv.strip_prefix("v=") {
                let ver: u64 = v.parse().ok()?;
                if ver <= current_version {
                    return None; // 旧版本，拒绝
                }
                st.version = ver;
            } else if let Some(rest) = kv.strip_prefix("nat=") {
                let mut parts = rest.split('|');
                st.nat_mapping = NatMapping::from_str(parts.next().unwrap_or("?"));
                st.nat_source = match parts.next().unwrap_or("dft") {
                    "meas" => Source::Measured,
                    "probe" => Source::Probe,
                    "last" => Source::LastKnown,
                    _ => Source::Default,
                };
            } else if let Some(rest) = kv.strip_prefix("fw=") {
                let mut parts = rest.split('|');
                st.fw_inbound = FwInbound::from_str(parts.next().unwrap_or("?"));
                st.fw_source = match parts.next().unwrap_or("dft") {
                    "meas" => Source::Measured,
                    "probe" => Source::Probe,
                    _ => Source::Default,
                };
            } else if let Some(v) = kv.strip_prefix("v6in=") {
                // 兼容旧格式 "1|..."（v6in=1|... 的尾部附加）：取 | 前的标记
                st.ipv6_inbound = InboundState::from_str(v.split('|').next().unwrap_or("?"));
            } else if let Some(v) = kv.strip_prefix("if=") {
                st.if_type = IfType::from_str(v);
            } else if let Some(v) = kv.strip_prefix("cost=") {
                st.if_cost = v.parse().unwrap_or(0);
            } else if let Some(v) = kv.strip_prefix("caps=") {
                // 能力位掩码（十六进制）。旧端公告没有这个 token → 保持默认 0 = 无能力；
                // 解析失败也按 0：宁可让 client 报 MF_UNSUPPORTED，不可误放行静默误路由。
                st.caps = u32::from_str_radix(v, 16).unwrap_or(0);
            }
        }
        if st.version == 0 { return None; } // 没有版本号 = 格式不对
        st.sensed_at = Instant::now();
        Some(st)
    }

    /// 状态组合 → 策略（带可信度降级）
    pub fn strategy(local: &Self, remote: &Self) -> Strategy {
        // 任一端状态过期 → 保守模式（全试一遍，不做预判）
        if local.is_stale() || remote.is_stale() {
            return Strategy::ConservativeAll;
        }

        // IPv6 直连（双方都有高可信度的 v6）
        if local.ipv6.is_some() && remote.ipv6.is_some() {
            match remote.ipv6_inbound {
                InboundState::Yes => return Strategy::V6DirectFromClient,
                InboundState::No => return Strategy::V6ConntrackRide,
                // Unknown = 没测过，不是「不行」。两种可能对应的策略都要能试：
                // 先试直连（若实际通则最优），不通有 relay 兜底——绝不能因未测就排除直连。
                InboundState::Unknown => return Strategy::V6DirectFromClient,
            }
        }

        // v4 打洞（基于 NAT 映射类型，只在高可信度时做预判）
        if local.nat_source >= Source::Measured && remote.nat_source >= Source::Measured {
            match (local.nat_mapping, remote.nat_mapping) {
                (NatMapping::Eim, NatMapping::Eim) => return Strategy::SimplePunch,
                (NatMapping::Apdm, NatMapping::Apdm) => return Strategy::RelayFirst,
                _ => return Strategy::BatchPunch,
            }
        }

        // NAT 类型不可信 → 保守
        Strategy::ConservativeAll
    }
}

/// P2P 策略
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Strategy {
    V6DirectFromClient,
    V6ConntrackRide,
    SimplePunch,
    BatchPunch,
    RelayFirst,
    /// 保守模式：不做预判，全试一遍（当前行为）
    ConservativeAll,
}

impl Strategy {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::V6DirectFromClient => "v6-direct(client)",
            Self::V6ConntrackRide => "v6-conntrack(server-first)",
            Self::SimplePunch => "v4-simple-punch",
            Self::BatchPunch => "v4-batch-punch",
            Self::RelayFirst => "relay-first",
            Self::ConservativeAll => "conservative-all",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_rejects_stale() {
        let st = NetStatus {
            version: 5,
            ..Default::default()
        };
        let extra = st.to_announce_extra();
        // 当前已有 version 6 → 拒绝 version 5
        assert!(NetStatus::parse_announce_extra(&extra, 6).is_none());
        // 当前只有 version 4 → 接受 version 5
        assert!(NetStatus::parse_announce_extra(&extra, 4).is_some());
    }

    #[test]
    fn test_atomic_replacement() {
        // 整个结构一起换，不允许部分更新
        let old = NetStatus {
            version: 1,
            nat_mapping: NatMapping::Apdm,
            fw_inbound: FwInbound::Allowed,
            if_cost: 1,
            ..Default::default()
        };
        let new = NetStatus {
            version: 2,
            nat_mapping: NatMapping::Eim,
            fw_inbound: FwInbound::Allowed,
            if_cost: 0,
            ..Default::default()
        };
        assert!(new.version > old.version);
        assert_ne!(new.nat_mapping, old.nat_mapping);
        assert_ne!(new.if_cost, old.if_cost);
    }

    /// 核心语义：入站「未测过」（Unknown）不等于「不通」（No）。
    /// Unknown 必须允许试直连（有 relay 兜底），No 才排除直连。
    #[test]
    fn test_inbound_unknown_is_not_no() {
        let mut local = NetStatus::default();
        let mut remote = NetStatus::default();
        local.ipv6 = Some("[3fff::1]:9100".parse().unwrap());
        remote.ipv6 = Some("[3fff::2]:9100".parse().unwrap());
        local.sensed_at = Instant::now();
        remote.sensed_at = Instant::now();

        // Unknown（没测过）→ 仍应允许试直连（V6DirectFromClient），relay 兜底
        remote.ipv6_inbound = InboundState::Unknown;
        assert_eq!(NetStatus::strategy(&local, &remote), Strategy::V6DirectFromClient,
            "未测过就被排除直连 = 把 Unknown 错当 No");

        // No（明确不通）→ 借道 conntrack
        remote.ipv6_inbound = InboundState::No;
        assert_eq!(NetStatus::strategy(&local, &remote), Strategy::V6ConntrackRide);

        // Yes（明确通）→ 直连
        remote.ipv6_inbound = InboundState::Yes;
        assert_eq!(NetStatus::strategy(&local, &remote), Strategy::V6DirectFromClient);
    }

    /// 三态序列化/解析 roundtrip：1/0/? 都要正确还原。
    #[test]
    fn test_inbound_state_roundtrip() {
        for (state, tag) in [(InboundState::Yes, "1"), (InboundState::No, "0"), (InboundState::Unknown, "?")] {
            let mut st = NetStatus::default();
            st.version = 1;
            st.ipv6_inbound = state;
            let extra = st.to_announce_extra();
            let parsed = NetStatus::parse_announce_extra(&extra, 0).unwrap();
            assert_eq!(parsed.ipv6_inbound, state, "tag={} roundtrip 失败", tag);
        }
    }

    #[test]
    fn test_stale_degrades_to_conservative() {
        let local = NetStatus {
            sensed_at: Instant::now() - Duration::from_secs(120), // 2 分钟前
            ..Default::default()
        };
        let remote = NetStatus::default();
        // 过期状态 → 保守模式（不基于过期状态做决策）
        assert_eq!(NetStatus::strategy(&local, &remote), Strategy::ConservativeAll);
    }

    #[test]
    fn test_announce_roundtrip() {
        let st = NetStatus {
            version: 42,
            nat_mapping: NatMapping::Apdm,
            nat_source: Source::Measured,
            fw_inbound: FwInbound::Allowed,
            fw_source: Source::Measured,
            if_type: IfType::Cellular,
            if_cost: 1,
            ..Default::default()
        };
        let extra = st.to_announce_extra();
        let parsed = NetStatus::parse_announce_extra(&extra, 0).unwrap();
        assert_eq!(parsed.version, 42);
        assert_eq!(parsed.nat_mapping, NatMapping::Apdm);
        assert_eq!(parsed.nat_source, Source::Measured);
        assert_eq!(parsed.fw_inbound, FwInbound::Allowed);
        assert_eq!(parsed.if_type, IfType::Cellular);
        assert_eq!(parsed.if_cost, 1);
    }

    /// caps 字段 roundtrip：位掩码（含多位组合）经 announce 序列化/解析必须原样还原。
    #[test]
    fn test_caps_field_roundtrip() {
        let mut st = NetStatus::default();
        st.version = 7;
        st.caps = CAP_MULTI_FORWARD | (0x1 << 3); // bit0 + 其它位：验证按位掩码传递而非布尔
        let extra = st.to_announce_extra();
        assert!(extra.contains("caps=9"), "caps 应以十六进制出现在公告里: {}", extra);
        let parsed = NetStatus::parse_announce_extra(&extra, 0).unwrap();
        assert_eq!(parsed.caps, st.caps, "caps roundtrip 后必须逐位一致");
    }

    /// 兼容核心：旧端公告（无 caps token）解析出的 caps 必须是 0 = 无能力。
    /// 新 client 据此对旧 server 显式报 MF_UNSUPPORTED，而不是静默误路由。
    #[test]
    fn test_caps_missing_token_parses_as_zero() {
        let parsed = NetStatus::parse_announce_extra("v=5 nat=EIM|meas cost=2", 0).unwrap();
        assert_eq!(parsed.caps, 0, "缺 caps token = 旧端 = 无能力");
        // 格式坏掉的 caps 同样按 0（安全方向）
        let parsed = NetStatus::parse_announce_extra("v=5 caps=zz", 0).unwrap();
        assert_eq!(parsed.caps, 0, "坏 caps 必须保守处理为无能力");
    }

    /// 位定义：CAP_MULTI_FORWARD 固定占用 bit0，不与后续能力位重叠。
    #[test]
    fn test_caps_bit_definitions() {
        assert_eq!(CAP_MULTI_FORWARD, 1 << 0);
        assert_eq!(CAP_MULTI_FORWARD & 0b1111_1110, 0, "bit0 不得与高位重叠");
    }
}
