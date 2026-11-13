//! boot_config.rs — 出厂默认配置（2026-11-12 用户立法：「裸跑 exe 必须全量工作」）。
//!
//! ## 为什么需要它
//! 产品开关（设备域 viewer、peer 身份闸、multi-forward、VNETP 口、mf 白名单…）
//! 历史上全部活在启动脚本 `myco-start.cmd` 的 `set` 行里——脚本/环境一丢，
//! exe 裸起就是**残废形态**（真机事故：2026-11-12 换 exe 后裸命令拉起，
//! 15200/24011 全没监听、mf 白名单退回默认 22，手机 DSH/RDP 全断）。
//!
//! ## 语义（与启动脚本共存）
//! · 这里只放**功能性**默认值；`std::env::set_var` 仅在该变量**不存在**时生效
//!   ——显式 env / 启动脚本永远优先（可覆盖，不会互相打架）。
//! · 追踪类开关（MYCO_TUNNEL_TRACE 等）**不进默认**：那是排障旋钮，默认开会
//!   重演 3.9GB 日同事故；需要时由启动脚本/手工 env 打开。
//! · DSH 原生口：`DSH_NATIVE_PORT` 未设时读端口缓存（%LOCALAPPDATA%\Youling\
//!   dsh-port.txt，由 myco_dsh_port_refresh 计划任务保鲜），再退 19387。
//!
//! ## 接线
//! `main()` 第一件正事（startup_trace 之后、任何模块读 env 之前）调
//! [`apply_baked_defaults`]。CLI 路径同样经过（无害：多几个 env 而已）。

/// 功能性默认表（键, 值）。改动这里 = 改出厂行为；同步维护 myco-start.cmd 注释。
const BAKED_DEFAULTS: &[(&str, &str)] = &[
    // vnet 传输面
    ("MYCO_TUNNEL_TRANSPORT", "vnet"),
    ("MYCO_VNET_RELAY", "myco.youling.cc:28322"),
    ("MYCO_VNET_SECRET", "acc-test"),
    ("MYCO_VNET_P2P_PORT", "19100"),
    // 分享/设备域/身份闸（多设备架构的地基三开关）
    ("MYCO_DEVICE_ORIGIN", "1"),
    ("MYCO_PEER_IDENTITY", "1"),
    ("MYCO_VNET_MULTI_FORWARD", "1"),
    // 手机入站面：VNETP 身份口 + mf 目标口白名单（缺省=22 会拒掉一切分享端口）
    ("VNET_VNETP_PORTS", "15200"),
    // 2026-11-13：24011（device-origin viewer / public_router Host 分发）加入
    // mf 白名单——手机 DSH 隧道统一走 24011（干净 URL 直出；15200 是 VNETP
    // 老挂载，会 302 到 /gw/<id>/app/）。
    ("VNET_TARGET_PORTS", "15200,24011,13911,3389,9100"),
    // 管理面/存储
    ("MYCO_SHARE_LOCAL_PORT", "3102"),
    ("MYCO_MSG_STORE", "dual"),
    ("MYCO_DEV_API", "1"),
    // 2026-11-08 RDP 缓解（vnet 356a63db）：ARQ 重传预算耗尽期的连接误杀阈值。
    // 启动脚本里这行曾误放在 exe 行**之后**（永不生效）；进默认后才真正常开。
    ("VNET_RETRY_BUDGET_MS", "60000"),
];

/// DSH 原生口默认链：env 显式值 > 端口缓存文件 > 19387。
fn dsh_default_port() -> String {
    if let Ok(cache) = std::env::var("DSH_CACHE") {
        if let Ok(text) = std::fs::read_to_string(cache.trim()) {
            let port = text.trim();
            if !port.is_empty() {
                return port.to_string();
            }
        }
    } else {
        // 与启动脚本同位的默认缓存路径（不依赖脚本存在）
        let path = std::env::var("LOCALAPPDATA")
            .map(|d| std::path::Path::new(&d).join("Youling").join("dsh-port.txt"))
            .ok();
        if let Some(p) = path {
            if let Ok(text) = std::fs::read_to_string(&p) {
                let port = text.trim();
                if !port.is_empty() {
                    return port.to_string();
                }
            }
        }
    }
    "19387".to_string()
}

/// 把出厂默认灌进环境（只补缺，不覆盖）。幂等：重复调用无副作用。
pub fn apply_baked_defaults() {
    for (k, v) in BAKED_DEFAULTS {
        if std::env::var_os(k).is_none() {
            std::env::set_var(k, v);
        }
    }
    if std::env::var_os("DSH_NATIVE_PORT").is_none() {
        let port = dsh_default_port();
        std::env::set_var("DSH_NATIVE_PORT", &port);
        if std::env::var_os("DSH_NATIVE_AUTHORITY").is_none() {
            std::env::set_var("DSH_NATIVE_AUTHORITY", format!("127.0.0.1:{port}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 并行污染教训（2026-11-13 有灵开源报 7 条并行挂、单跑过；dev 全量并行挂 14 条）：
    /// 本测试曾**裸 set/remove_var 十几个环境变量**（VNET_TARGET_PORTS 等）——
    /// env 是进程级全局，测试线程间无隔离，早期字母序跑完后泄漏到所有后续测试
    /// （凡读这些变量的测试全被污染）。三条纪律：
    /// ① 环境变更必须在 test_env_lock 内（串行化窗口）；
    /// ② 测试结束**恢复原值**（删掉新设、还原已有），不泄漏；
    /// ③ 断言只对「本测试自己设/删的键」做，不假设进程初始态。
    #[test]
    fn baked_defaults_fill_missing_without_overriding() {
        let _g = crate::test_env_lock::test_env_lock();
        // 显式值必须原样保留（env/脚本优先）
        std::env::set_var("MYCO_TEST_MARKER_A", "explicit");
        // 借真默认键验证「缺则补」——记录原值以便恢复
        let prev_msg_store = std::env::var("MYCO_MSG_STORE").ok();
        std::env::remove_var("MYCO_MSG_STORE");
        // 记录本测试可能触发的全部默认键原值（恢复用）
        let keys: Vec<&str> = BAKED_DEFAULTS.iter().map(|(k, _)| *k).collect();
        let prev: Vec<(String, Option<String>)> =
            keys.iter().map(|k| (k.to_string(), std::env::var(k).ok())).collect();
        apply_baked_defaults();
        assert_eq!(std::env::var("MYCO_TEST_MARKER_A").unwrap(), "explicit");
        assert_eq!(std::env::var("MYCO_MSG_STORE").unwrap(), "dual");
        assert_eq!(std::env::var("VNET_TARGET_PORTS").unwrap(), "15200,24011,13911,3389,9100");
        assert!(!std::env::var("DSH_NATIVE_PORT").unwrap().is_empty());
        // 恢复：显式键删掉；默认键回原值（原 None = remove）
        std::env::remove_var("MYCO_TEST_MARKER_A");
        for (k, v) in prev {
            match v {
                Some(s) => std::env::set_var(&k, s),
                None => std::env::remove_var(&k),
            }
        }
        let _ = prev_msg_store; // prev 集已含 MYCO_MSG_STORE
    }
}
