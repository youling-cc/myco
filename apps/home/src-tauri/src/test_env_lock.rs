//! test_env_lock.rs — lib 测试共用的**进程级**配置目录隔离锁（2026-10-07 立）。
//!
//! 事故（三端互测矩阵轮全量 `cargo test` 实锤 flaky）：三处测试各自
//! `set_var("MYCO_CONFIG_DIR", …)`（进程级全局）+ 各自模块锁——模块间并行时：
//! ① 全局 env 互相覆盖（后设者赢，先设模块的已写状态瞬间"消失"）；
//! ② 落到同一最终目录的 groups.json/meta 读-改-写互踩（丢整份更新）→
//! `group_disband_semantics`（chat_service）/`meta_append_concurrent`（p2p_sync）/
//! dsh_share 系列随机挂。
//!
//! 统一立法：凡测试需要**进程级 MYCO_CONFIG_DIR** 的，一律走本锁——全进程一把
//! 锁 + 一个临时目录，测试间完全串行。用线程局部桶（TEST_CHAT_DIR 模式）的
//! 测试不受影响、无需接入（那是更细粒度的正确隔离）。

/// 取进程级测试隔离锁（首次调用顺带设 MYCO_CONFIG_DIR=<temp>/myco-libtest-<pid>-<ms>）。
/// 返回的 MutexGuard 活到测试结束（RAII 串行）。
#[cfg(test)]
pub(crate) fn test_env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    static SET_ENV: std::sync::Once = std::sync::Once::new();
    SET_ENV.call_once(|| {
        let dir = std::env::temp_dir().join(format!(
            "myco-libtest-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        let _ = std::fs::create_dir_all(&dir);
        // Windows/aarch64 等平台 Rust 2024 起 set_var 是 unsafe；2021 edition 仍安全调用。
        std::env::set_var("MYCO_CONFIG_DIR", &dir);
    });
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}
