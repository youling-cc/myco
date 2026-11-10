//! P：ARQ 传感器 —— 从 watchdog（数据面停滞看门狗）抽出。
//!
//! 周期性上报当前通道 ARQ 计数；C 层用 (sent, acked) 增量的滑窗比算
//! 窗口 ACK 率（o_ack_ratio 轨迹观察的证据源）。

/// ARQ 传感器：周期上报可靠流统计。
pub trait ArqSensor: Send + Sync {
    /// `sent`/`acked`/`retrans` 为累计值（TunnelStream::stats() 的三元组）。
    /// C 层自己维护增量滑窗；累计值不变即无新证据。
    fn on_stats(&self, sent: u64, acked: u64, retrans: u64);
}
