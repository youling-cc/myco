//! myco media — 远程桌面窗(B5:PC↔PC 远程桌面的载体)。
//!
//! 窗口舰队第九成员:骨架阶段(B5-1)提供窗口壳+编队接入+设备清单;
//! B5-2 在此挂 PC viewer(WebRTC video track 经 sign_relay 路由)。
//!
//! 数据面:canvas 同源 HTTP(:3002,成员窗双轨惯例)——授权设备清单来自
//! /api/list_authorized_devices;canvas 不在线时纯本地空态。

const PORT: u16 = 17898;
const DID: &str = "did:myco:agent:ui-media";
const CONSUMES: &[&str] = &["canvas :3002 授权设备清单"];
const PRODUCES: &[&str] = &["远程桌面会话(B5-2)"];

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 跨机主机注入(2026-08-28):~/.myco/media-host.txt 一行远端主机 DID →
            // 延迟导航带 ?host=<did>,UI 进跨机模式(如笔记本远程窗看 jason PC 桌面)。
            // 本地 canvas 可不在场;授权由主机侧 authorized-dids enforced(deny 流程)。
            // 实测坑:setup 期直接 navigate 会被 webview 初始加载覆盖——等初始页就绪后
            // 再导航(1.5s 延迟;代价=跨机模式启动多一次整页重载,本机模式零影响)。
            if let Ok(home) = std::env::var("USERPROFILE") {
                let p = std::path::PathBuf::from(home).join(".myco").join("media-host.txt");
                if let Ok(host) = std::fs::read_to_string(&p) {
                    let host = host.trim().to_string();
                    if host.starts_with("did:myco:") && host.len() < 80 {
                        if let Some(w) = app.get_webview_window("main") {
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(1500));
                                if let Ok(mut u) = w.url() {
                                    if u.query().map_or(true, |q| !q.contains("host=")) {
                                        u.set_query(Some(&format!("host={host}")));
                                        let _ = w.navigate(u);
                                    }
                                }
                            });
                        }
                    }
                }
            }
            let hwnd = app
                .get_webview_window("main")
                .and_then(|w| w.hwnd().ok())
                .map(|h| h.0 as isize)
                .unwrap_or(0);
            ui_embed_server::spawn_with_hwnd(app.handle().clone(), hwnd, PORT, ui_embed_server::UiAgentManifest {
                did: DID, layer: "PA", consumes: CONSUMES, produces: PRODUCES,
                // 远程桌面是内容大窗:理想 960(16:9 视频+控制条),封顶不限
                demand: (480, 960, -1, 400),
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running myco media");
}
