//! myco-core — myco 基础设施库(身份/LLM 服务商/配置/共用类型)。
//!
//! 所有 agent(myco/aop/youling)共用的基础设施:
//!   - identity: myco 账号注册/登录/设备管理/委任状(原 soul_* 统一为 myco 账号)
//!   - identity_store: 密钥存储(TPM>DPAPI>明文,用户无感)
//!   - provider: LLM 服务商管理(认知层基础设施)
//!   - config: 配置目录(%APPDATA%/myco/)
//!   - domain: 共用数据类型
//!   - project: 项目注册表(myco-projects.json;canvas 巨石拆解下沉)
//!   - launch_config: claude 启动参数配置(2026-09-03 下沉,aop 本地模式复用)
//!
//! 命名: 内部统一 myco_* 前缀;pub use 保留 soul_* 别名向后兼容(过渡期)。

pub mod authorized;
pub mod delegation;
pub mod config;
pub mod domain;
pub mod identity;
pub mod identity_store;
pub mod launch_config;
pub mod project;
pub mod provider;

// 便捷再导出(调用方 myco_core::identity::xxx)
pub use authorized::*;
pub use delegation::*;
pub use identity::*;
pub use identity_store::*;
pub use provider::*;

// 命名定稿（第70轮）：soul→myco 账号统一。soul_* 兼容层已删；identity.rs 里
// 的 soul_* 函数本体也已统一改名 myco_*（soul_set_backed_up→account_set_backed_up 等）。
// 老名字只剩 env 仓（已退役）的 HTTP 路由别名——登录器/手机端零 soul_* 痕迹。
