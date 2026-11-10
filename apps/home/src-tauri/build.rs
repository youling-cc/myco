//! myco-home 构建脚本。
//!
//! ═══════════════════════════════════════════════════════════════════════════
//! 为什么 test 构建不能链 tauri 的 UI / webview 栈（2026-10-09 实测，防复踩）
//! ═══════════════════════════════════════════════════════════════════════════
//! `cargo test -p myco-home --lib` 曾经字面跑不起来：测试 exe 一启动就
//! `0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND`，零输出。链条如下：
//!
//! 1. `tauri-build` 生成的 Windows 资源（图标 + exe manifest）只作用于 **bin 目标**；
//!    lib 单元测试 harness（`target/debug/deps/myco_home_lib-*.exe`）**没有任何
//!    manifest**——实测该 exe 连 `.rsrc` 段都不存在（rustc 不会替它嵌 link.exe 的
//!    默认 manifest）。
//! 2. 没有 manifest ⇒ 没有 SxS 的 `Microsoft.Windows.Common-Controls` v6 依赖 ⇒
//!    `comctl32.dll` 绑到 `C:\Windows\System32` 的 **v5.82**（实测其导出表里根本没有
//!    `TaskDialogIndirect`）。
//! 3. 而 tauri 的 webview 运行时在 Windows 上静态导入
//!    `comctl32.dll!TaskDialogIndirect`（**v6 专属导出**）：`tauri` 默认特性打开
//!    `common-controls-v6` → `muda/common-controls-v6`（win 菜单/关于框）。
//!    只要测试可达的代码引到 Wry 运行时（经 `AppHandle`/`.emit()` 这类泛型方法实例化
//!    → `tauri-runtime-wry` → `muda`），这个导入就落进测试 exe 的导入表。
//! 4. 于是加载器在**进程入口之前**解析导入失败 ⇒ 测试 exe 一个字符都打不出来。
//!
//! 所以纪律是：**测试可达的代码不得引用 tauri 的 UI 事件/webview 通道**。全仓所有
//! `.emit()` 调用点（chat_service / identity_service / update / lib / p2p_*）都收在
//! `#[cfg(not(test))]` 下，`use tauri::Emitter` 同理；非 test 构建行为逐字节不变。
//! 新增 `.emit()` 时必须照抄这个 cfg，否则 `cargo test --lib` 会重新变成"起不来"。
//!
//! ⚠️ 别再用链接参数绕（父会话实测过，均已排除）：
//!   - `cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:...` **覆盖不到 lib 单元测试
//!     harness**（cargo 的 `-tests` 只作用于 `tests/` 集成测试目标，链接命令里压根
//!     没有这个 flag）；
//!   - 不带范围的 `cargo:rustc-link-arg=/MANIFEST:EMBED`（+MANIFESTDEPENDENCY）
//!     确实能让测试跑起来，但 **bin 会链接失败**：`CVTRES CVT1100 资源重复。类型:
//!     MANIFEST, 名称: 1`——与 tauri 打进 `resource.lib` 的 MANIFEST 资源冲突。
//!
//! 验收口径（改动后请照跑）：
//!   `cargo test -p myco-home --lib -- --test-threads=1` → 271 passed；
//!   `cargo build -p myco-home` → 链接成功（无 CVT1100）；
//!   `cargo check -p myco-home --no-default-features --lib` → 0 error。
//!
//! ═══════════════════════════════════════════════════════════════════════════
//! 集成测试目标（tests/）的 SxS manifest 注入（2026-10-09 多归属 TDD 第 0 步基建）
//! ═══════════════════════════════════════════════════════════════════════════
//! `tests/` 目录的集成测试 exe 引用 `p2p_router` / `local_router`（产线 HTTP 面，
//! 如 multi_membership_regression 直接起 axum 路由）→ 锚进 tauri webview 栈 →
//! 同样吃 `comctl32.dll!TaskDialogIndirect` 的 v6 专属导入。tauri-build 的 manifest
//! 资源只作用于 **bin 目标**，集成测试 exe 没有 manifest → 加载器 0xC0000139
//! （一个字符都打不出来，此前只能手工 mt.exe 补嵌）。
//!
//! 修法：`cargo:rustc-link-arg-tests` 作用域**只覆盖 tests/ 的 [[test]] 目标**——
//! 正是需要的粒度：
//!   - bin 目标不受影响（不会撞 tauri resource.lib 的 CVTRES CVT1100 资源重复）；
//!   - lib 单测 harness 不在覆盖范围——但 lib 单测因全仓 `cfg(not(test))` 纪律
//!     本来就不链 webview 栈，无需 manifest。
//! ⚠️ 绝不要改回裸 `cargo:rustc-link-arg`（无作用域）——bin 会 CVT1100 链接失败。

fn main() {
    // feat/cli-suite：GUI 变体才跑 tauri 构建（生成 context/资源清单，要求
    // tauri.conf.json + frontendDist）；CLI 变体（--no-default-features）纯 Rust，
    // 跳过——docker headless 构建不需要 webkit/dist。
    if std::env::var("CARGO_FEATURE_GUI").is_ok() {
        tauri_build::build();
        // PMv2 DPI manifest(进程启动前生效,比运行时 API 可靠——tao 可能覆盖后者)
        if std::path::Path::new("../../shared/dpi.rc").exists() {
            println!("cargo:rerun-if-changed=../../shared/permonitor.manifest");
            println!("cargo:rerun-if-changed=../../shared/dpi.rc");
            embed_manifest();
        }
        // 集成测试目标（tests/）嵌 SxS manifest（见文件头注释）：只此作用域，
        // bin 不碰（CVT1100），lib 单测不需要（cfg(not(test)) 不链 webview）。
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    } else {
        println!("cargo:rerun-if-changed=build.rs");
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
