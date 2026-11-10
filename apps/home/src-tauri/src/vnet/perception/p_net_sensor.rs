//! P：网络传感器 —— 从网络变化检测 / fwcheck / NAT 过滤证据抽出。
//!
//! 观察的是**本机环境**（与对端无关）：NAT 行为画像、入站防火墙状态、
//! 默认路由接口计费性。它们影响的是候选管道的先验可用性与成本位。

/// 网络传感器：本机网络环境变化时调用。
pub trait NetSensor: Send + Sync {
    /// NAT 行为画像变化（如 RFC 4787 过滤类型证据 "ip-based(ADF/EIF)" / "port-based(APDF)"）
    fn on_nat_change(&self, profile: &'static str);

    /// 入站防火墙状态变化（fwcheck 的 InboundStatus 字符串形态）
    fn on_fw_change(&self, status: &'static str);

    /// 默认路由接口计费性变化（0=免费 WiFi/有线 1=蜂窝计费）——写入 Relay 管道 o_cost
    fn on_cost_change(&self, cost: u8);
}
