//! myco-aop — AOP 会话运行时独立进程(B3:D 决策层独立)。
//!
//! env 内嵌时代的 AopSessionManager 原样托管,HTTP :8102(形状与 env
//! :3002 内嵌路由逐字节一致,B3 过渡 env 转发、前端零改动;B4 前端直连)。
//!
//! 崩溃隔离收益(与 B1 pomdp 同理):AOP run loop panic 不拖垮编排核;
//! env 重启会话不死(纯客户端附着)。
//!
//! 日志写文件(进程由 env 无窗口拉起,stdout 无处可看——
//! 5555 静默失聪事故教训:服务进程必须文件日志)。

// 无 UI 服务:windows 子系统彻底免 conhost(日志走文件);终端调试用 `myco-{tag}.exe 2>&1 | tee` 不再适用,改看日志文件
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

struct LogWriter(std::sync::Arc<std::fs::File>);
impl std::io::Write for LogWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        (&*self.0).write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        (&*self.0).flush()
    }
}

fn init_logging() {
    let log_dir = std::env::var("LOCALAPPDATA")
        .map(|d| PathBuf::from(d).join("com.myco.env").join("logs"))
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&log_dir);
    match std::fs::File::create(log_dir.join("aop.log")) {
        Ok(f) => {
            let w = LogWriter(std::sync::Arc::new(f));
            tracing_subscriber::fmt()
                .with_writer(move || LogWriter(w.0.clone()))
                .with_ansi(false)
                .init();
        }
        Err(_) => tracing_subscriber::fmt::init(),
    }
}

#[tokio::main]
async fn main() {
    // 单例闸:env 探测+tasklist 判活有竞态窗口(探测期 :8102 未起+tasklist
    // 未刷新=双拉,用户实测桌面两个黑控制台)。命名互斥双保险,已在跑则静默退。
    #[cfg(target_os = "windows")]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn CreateMutexW(a: *const core::ffi::c_void, owner: i32, name: *const u16) -> isize;
            fn GetLastError() -> u32;
        }
        let name: Vec<u16> = "Global:\\myco-aop-singleton".encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            CreateMutexW(std::ptr::null(), 0, name.as_ptr());
            if GetLastError() == 183 {
                // ERROR_ALREADY_EXISTS
                return;
            }
        }
    }
    init_logging();
    tracing::info!("[aop] myco-aop-core.exe starting on :8102");

    let mgr = myco_aop_core::AopSessionManager::new();
    let app = myco_aop_core::http::router(mgr);

    let listener = match tokio::net::TcpListener::bind("127.0.0.1:8102").await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("[aop] bind :8102 失败: {e}");
            std::process::exit(1);
        }
    };
    tracing::info!("[aop] serving :8102");
    if let Err(e) = axum::serve(listener, app).await {
        tracing::error!("[aop] serve 退出: {e}");
        std::process::exit(1);
    }
}
