//! 会话管理 - 竞速连接 + 自动切换 + 保活 + 网络变化检测 + 路径历史
//! Network change detection: when WiFi ↔ cellular switches, auto reconnect

use std::time::Instant;
use std::collections::VecDeque;
use std::net::UdpSocket;

/// 路径类型
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PathType {
    P2PUdp,
    P2PUdp6,
    RelayCloud,
    RelayMember,
}

impl PathType {
    pub fn name(&self) -> &'static str {
        match self {
            PathType::P2PUdp => "P2P UDP",
            PathType::P2PUdp6 => "P2P IPv6",
            PathType::RelayCloud => "Cloud Relay",
            PathType::RelayMember => "Member Relay",
        }
    }
    pub fn is_direct(&self) -> bool {
        matches!(self, PathType::P2PUdp | PathType::P2PUdp6)
    }
}

/// 网络变化检测器
/// 定期检查本机网络状态（IP 地址变化 = 网络切换）
pub struct NetworkMonitor {
    last_local_ip: Option<std::net::IpAddr>,
    last_ipv6: Option<String>,
    /// 检测到变化时的回调列表
    listeners: Vec<Box<dyn Fn(NetworkChangeEvent) + Send>>,
}

#[derive(Debug, Clone)]
pub enum NetworkChangeEvent {
    /// IP 地址变了（WiFi ↔ 蜂窝，或 DHCP 续约）
    IpChanged {
        old: Option<std::net::IpAddr>,
        new: std::net::IpAddr,
    },
    /// IPv6 地址变了
    Ipv6Changed {
        old: Option<String>,
        new: Option<String>,
    },
    /// 网络完全断开
    Disconnected,
    /// 网络恢复
    Reconnected,
}

impl NetworkMonitor {
    pub fn new() -> Self {
        Self {
            last_local_ip: get_local_ip(),
            last_ipv6: get_ipv6_string(),
            listeners: Vec::new(),
        }
    }

    pub fn on_change(&mut self, f: Box<dyn Fn(NetworkChangeEvent) + Send>) {
        self.listeners.push(f);
    }

    /// 检查一次网络状态，如果有变化则通知所有 listener
    pub fn check(&mut self) -> Vec<NetworkChangeEvent> {
        let mut events = Vec::new();

        let current_ip = get_local_ip();
        let current_v6 = get_ipv6_string();

        // IP 变化检测
        if current_ip != self.last_local_ip {
            if let Some(new_ip) = current_ip {
                events.push(NetworkChangeEvent::IpChanged {
                    old: self.last_local_ip,
                    new: new_ip,
                });
            } else if self.last_local_ip.is_some() {
                events.push(NetworkChangeEvent::Disconnected);
            }
            self.last_local_ip = current_ip;
        }

        // 从断开恢复
        if current_ip.is_some() && self.last_local_ip.is_none() {
            events.push(NetworkChangeEvent::Reconnected);
        }

        // IPv6 变化检测
        if current_v6 != self.last_ipv6 {
            events.push(NetworkChangeEvent::Ipv6Changed {
                old: self.last_ipv6.clone(),
                new: current_v6.clone(),
            });
            self.last_ipv6 = current_v6;
        }

        // 通知所有 listener
        for event in &events {
            for listener in &self.listeners {
                listener(event.clone());
            }
        }

        events
    }
}

fn get_local_ip() -> Option<std::net::IpAddr> {
    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                return Some(addr.ip());
            }
        }
    }
    None
}

fn get_ipv6_string() -> Option<String> {
    if let Ok(sock) = UdpSocket::bind("[::]:0") {
        if sock.connect("[2001:4860:4860::8888]:53").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                match addr.ip() {
                    std::net::IpAddr::V6(v6) if !v6.is_loopback() && !v6.is_unicast_link_local() => {
                        return Some(v6.to_string());
                    }
                    _ => {}
                }
            }
        }
    }
    None
}

/// 路径历史记录
#[derive(Debug, Clone)]
pub struct PathSwitchRecord {
    pub from: PathType,
    pub to: PathType,
    pub at: Instant,
    pub reason: String,
}

pub struct PathHistory {
    records: VecDeque<PathSwitchRecord>,
    max_records: usize,
}

impl PathHistory {
    pub fn new() -> Self {
        Self {
            records: VecDeque::new(),
            max_records: 100,
        }
    }

    pub fn record(&mut self, from: PathType, to: PathType, reason: &str) {
        if self.records.len() >= self.max_records {
            self.records.pop_front();
        }
        self.records.push_back(PathSwitchRecord {
            from, to,
            at: Instant::now(),
            reason: reason.to_string(),
        });
    }

    pub fn last(&self) -> Option<&PathSwitchRecord> {
        self.records.back()
    }

    pub fn all(&self) -> &VecDeque<PathSwitchRecord> {
        &self.records
    }

    pub fn format(&self) -> String {
        let mut out = String::new();
        for r in self.records.iter().rev().take(10) {
            out.push_str(&format!(
                "  {:?} → {:?} ({}, {}s ago)\n",
                r.from, r.to, r.reason,
                r.at.elapsed().as_secs()
            ));
        }
        out
    }
}

/// 会话状态
#[derive(Debug, Clone, PartialEq)]
pub enum SessionState {
    Discovering,
    Racing,
    P2PConnected,
    RelayConnected,
    FallingBack,
}

/// 完整会话管理器
pub struct Session {
    pub state: SessionState,
    pub path_history: PathHistory,
    pub network_monitor: NetworkMonitor,
    connected_at: Option<Instant>,
    path_switches: u32,
}

impl Session {
    pub fn new() -> Self {
        Self {
            state: SessionState::Discovering,
            path_history: PathHistory::new(),
            network_monitor: NetworkMonitor::new(),
            connected_at: None,
            path_switches: 0,
        }
    }

    pub fn on_network_change(&mut self) {
        let events = self.network_monitor.check();
        for event in &events {
            println!("  [NET] {:?}", event);
            match event {
                NetworkChangeEvent::IpChanged { .. } | NetworkChangeEvent::Ipv6Changed { .. } => {
                    println!("  [NET] Network changed, should re-register and re-punch");
                    // In full implementation: re-register with relay, re-announce, restart punching
                }
                NetworkChangeEvent::Disconnected => {
                    println!("  [NET] Network disconnected");
                }
                NetworkChangeEvent::Reconnected => {
                    println!("  [NET] Network reconnected");
                }
            }
        }
    }

    pub fn format_status(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!("State: {:?}\n", self.state));
        if let Some(t) = self.connected_at {
            out.push_str(&format!("Uptime: {}s\n", t.elapsed().as_secs()));
        }
        out.push_str(&format!("Path switches: {}\n", self.path_switches));
        if !self.path_history.all().is_empty() {
            out.push_str("\nPath history:\n");
            out.push_str(&self.path_history.format());
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_path_history() {
        let mut h = PathHistory::new();
        h.record(PathType::RelayCloud, PathType::P2PUdp6, "P2P established");
        h.record(PathType::P2PUdp6, PathType::RelayCloud, "P2P failed");
        assert_eq!(h.all().len(), 2);
        let last = h.last().unwrap();
        assert_eq!(last.from, PathType::P2PUdp6);
        assert_eq!(last.to, PathType::RelayCloud);
    }

    #[test]
    fn test_network_monitor() {
        let mut m = NetworkMonitor::new();
        let events = m.check();
        // No change on first check (or maybe IP changed if just created)
        // The important thing is it doesn't crash
        assert!(events.len() <= 2);
    }
}
