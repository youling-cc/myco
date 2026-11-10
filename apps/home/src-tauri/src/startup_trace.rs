//! 冷启动分段打点（`MYCO_STARTUP_TRACE=1` 时输出到 stderr）。
//!
//! 为什么需要：用户口径是"重启 myco → 页面 3s 内重连"，而线上实测 PC 29.4s /
//! 笔记本 ~7s。仅靠外部轮询只能看到"总时长"，无法判断时间花在 launcher 探测、
//! 进程初始化、mgmt bind/serve、还是 vnet 固定口恢复。本模块给出一把**进程内**
//! 的毫秒尺子：`t=0` 是 `main()` 第一行，之后每个关键节点一行。
//!
//! 契约：
//! · 未设 `MYCO_STARTUP_TRACE` 时**零输出、零可测开销**（一次 OnceLock 读取）；
//! · 只写 stderr（launcher 已把 stderr 重定向到日志，不污染 CLI/HTTP 输出）；
//! · 时间戳单调递增（`Instant`），不受系统时钟调整影响；
//! · 不改变任何启动顺序/语义——纯观测，便于 A/B 对比与回归。
use std::sync::OnceLock;
use std::time::Instant;

static T0: OnceLock<Instant> = OnceLock::new();
static ENABLED: OnceLock<bool> = OnceLock::new();

fn enabled() -> bool {
    *ENABLED.get_or_init(|| std::env::var_os("MYCO_STARTUP_TRACE").is_some())
}

/// 在 `main()` 最开头调用：钉住 t=0 并读取开关（之后改 env 不再生效）。
pub fn init() {
    let _ = T0.set(Instant::now());
    let _ = ENABLED.set(std::env::var_os("MYCO_STARTUP_TRACE").is_some());
}

/// 距离 t=0 的毫秒数（未 init 时返回 0）。
pub fn elapsed_ms() -> u128 {
    T0.get().map(|t| t.elapsed().as_millis()).unwrap_or(0)
}

/// 打一个点：`[startup-trace] t=<ms>ms evt=<name>`。
#[inline]
pub fn mark(evt: &str) {
    if !enabled() {
        return;
    }
    eprintln!("[startup-trace] t={}ms evt={evt}", elapsed_ms());
}

/// 带细节的点：`... evt=<name> detail=<detail>`（detail 里不要带换行）。
#[inline]
pub fn mark_detail(evt: &str, detail: &str) {
    if !enabled() {
        return;
    }
    eprintln!("[startup-trace] t={}ms evt={evt} detail={detail}", elapsed_ms());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_by_default_is_silent_and_cheap() {
        // 本进程一般没设 MYCO_STARTUP_TRACE；即便设了，mark 也只能写 stderr，
        // 这里断言的是"不 panic + elapsed 单调"。
        init();
        let a = elapsed_ms();
        mark("test-mark");
        mark_detail("test-detail", "k=v");
        let b = elapsed_ms();
        assert!(b >= a, "elapsed 必须单调不减");
    }

    #[test]
    fn init_is_idempotent() {
        init();
        init();
        let _ = elapsed_ms();
    }
}
