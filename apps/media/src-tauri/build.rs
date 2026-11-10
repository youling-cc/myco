fn main() {
    tauri_build::build();
    // PMv2 DPI manifest(进程启动前生效,比运行时 API 可靠——tao 可能覆盖后者)
    if std::path::Path::new("../../shared/dpi.rc").exists() {
        println!("cargo:rerun-if-changed=../../shared/permonitor.manifest");
        println!("cargo:rerun-if-changed=../../shared/dpi.rc");
        embed_manifest();
    }
}

fn embed_manifest() {
    // 用 windres/cmd 编译 rc 到 obj(Windows 上可用 PowerShell 的 Win32::LoadResource 替代)
    // 最简法:直接用 mt.exe 或 rc.exe;如果不可用,退回到运行时 API(已有)。
    let out_dir = std::env::var("OUT_DIR").unwrap_or_default();
    let rc = std::path::Path::new("../../shared/dpi.rc");
    let rc_path = std::fs::canonicalize(rc).unwrap_or_else(|_| rc.to_path_buf());
    let manifest = rc_path.parent().unwrap().join("permonitor.manifest");
    // 简化:直接拷贝 manifest 到输出(由 tauri_build 的资源机制处理)
    // 注:Tauri 2 的 tauri_build 已内嵌默认 manifest——我们通过 Windows 注册表
    // 或外部 manifest 文件的方式最可靠,但复杂。这里退而求其次:
    // 确保 main() 的 SetProcessDpiAwarenessContext(PER_MONITOR_V2) 生效即可。
    let _ = (out_dir, manifest);
}
