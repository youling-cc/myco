//! P 感知层 —— 把 ENV（T 层）各线程里的原始事件抽象成传感器 trait。
//!
//! P 层是「冻结层」：trait 只描述**能观察到什么**，不决定怎么解释。
//! 解释（写进 S 层 PathPipe）是 C 层（cognition::PathBelief）的职责。
//!
//! 传感器从这些旧位置抽出（connection.rs 内联逻辑，行为保持）：
//! - ProbeSensor ← 各接收线程（relay 接收 / v6 探测 socket / RDV4/RDV6 监听）
//! - ArqSensor   ← watchdog（探测循环里的数据面停滞看门狗）
//! - NetSensor   ← 网络变化检测（出口 IP / NAT 过滤证据 / 接口计费性）

pub mod p_arq_sensor;
pub mod p_net_sensor;
pub mod p_probe_sensor;

pub use p_arq_sensor::ArqSensor;
pub use p_net_sensor::NetSensor;
pub use p_probe_sensor::{ProbeSensor, ProbeSurface};
