// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
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
    myco_media_lib::run();
}
