//! Myco POMDP Core - 任务管理服务
//!
//! 核心数据管理 Agent，处理 task.md 的 CRUD 操作

// 无 UI 服务:windows 子系统彻底免 conhost(日志走文件);终端调试用 `myco-{tag}.exe 2>&1 | tee` 不再适用,改看日志文件
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod parser;
mod scanner;
mod service;

use myco_protocol::AgentConfig;
use std::path::PathBuf;

/// 日志写文件(进程由 canvas 无窗口拉起,stdout 无处可看——
/// 5555 静默失聪事故就是 stdout 丢失导致 panic 不可见)。
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
        .map(|d| PathBuf::from(d).join("com.myco.canvas").join("logs"))
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&log_dir);
    match std::fs::File::create(log_dir.join("pomdp.log")) {
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
async fn main() -> anyhow::Result<()> {
    // 单例闸:canvas 探测+tasklist 判活有竞态窗口(探测期 :5555 未起=双拉,
    // 用户实测桌面出现两个黑控制台)。命名互斥,已在跑则静默退。
    #[cfg(target_os = "windows")]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn CreateMutexW(a: *const core::ffi::c_void, owner: i32, name: *const u16) -> isize;
            fn GetLastError() -> u32;
        }
        let name: Vec<u16> = "Global:myco-pomdp-singleton".encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            CreateMutexW(std::ptr::null(), 0, name.as_ptr());
            if GetLastError() == 183 {
                // ERROR_ALREADY_EXISTS
                return Ok(());
            }
        }
    }
    init_logging();

    tracing::info!("Starting POMDP Core Agent...");

    // 从环境变量或命令行获取基础路径
    let base_path = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("MYCO_TASK_PATH").ok())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            // 默认查找项目根目录下的 taskflow/test-tasks
            let cwd = std::env::current_dir().unwrap_or_default();
            // 尝试向上查找包含 taskflow 目录的根目录
            let mut path = cwd.clone();
            for _ in 0..5 {
                if path.join("taskflow").exists() {
                    return path.join("taskflow").join("test-tasks");
                }
                if !path.pop() {
                    break;
                }
            }
            cwd.join("taskflow").join("test-tasks")
        });

    tracing::info!("Using task path: {:?}", base_path);

    let config = AgentConfig {
        did: "did:myco:agent:pomdp-001".to_string(),
        name: "POMDP Agent".to_string(),
        description: "核心数据管理 Agent".to_string(),
        version: "0.1.0".to_string(),
    };

    let agent = service::PomdpAgent::new(config).with_base_path(base_path);
    agent.start().await?;

    Ok(())
}
