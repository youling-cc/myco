//! config.rs — aop 进程内的最小配置面(从 env config.rs 平移的必需子集)。

use std::path::PathBuf;

/// 与 env config::home_dir 一致(USERPROFILE → HOME)。
pub fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(PathBuf::from))
        .ok()
}
