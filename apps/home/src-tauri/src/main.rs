// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 冷启动 t=0（`MYCO_STARTUP_TRACE=1` 时后续每个节点写一行 stderr）。
    myco_home_lib::startup_trace::init();
    myco_home_lib::startup_trace::mark("main");
    let args: Vec<String> = std::env::args().collect();

    // ═══ CLI 入口分叉（feat/cli-suite）═══
    // `myco cli <子命令>` → 纯 Rust 路径：不初始化 Tauri/webview，执行完退出。
    // 与 GUI 同一身份域（%APPDATA%\youling）；无 `cli` 前缀 → 原 GUI 路径不变。
    if args.get(1).map(|s| s.as_str()) == Some("cli") {
        // release（windows_subsystem=windows）下 exe 无自己的控制台——接管父进程
        // 控制台才能让 CLI 输出可见；debug/已有控制台时此调用失败（无害）。
        #[cfg(windows)]
        unsafe {
            #[link(name = "kernel32")]
            extern "system" {
                fn AttachConsole(pid: u32) -> i32;
            }
            const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
        myco_home_lib::cli::main(&args[2..]);
        return;
    }

    // ═══ GUI 路径（默认；CLI 变体构建 = --no-default-features，无此段）═══
    #[cfg(feature = "gui")]
    {
        // Per-monitor-v2 DPI 感知(窗口创建前设,消灭 RDP 200% 屏坐标虚拟化)。
        #[cfg(target_os = "windows")]
        {
            #[link(name = "user32")]
            extern "system" {
                fn SetProcessDpiAwarenessContext(value: isize) -> i32;
            }
            const PER_MONITOR_V2: isize = -4;
            unsafe { let _ = SetProcessDpiAwarenessContext(PER_MONITOR_V2); };
        }
        myco_home_lib::run();
    }

    // CLI 变体直接跑（无参/非 cli 参数）：打用法退出（A2 myco-ubuntu 同语义）
    #[cfg(not(feature = "gui"))]
    {
        eprintln!("（此为 CLI 构建变体，无 GUI；GUI 需 --features gui 构建）");
        eprintln!("用法: myco cli <子命令>    例: myco cli identity did / myco cli help");
        std::process::exit(1);
    }
}
