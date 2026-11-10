//! restore_import.rs — myco_import 成功态集成测试（2026-09-30 批A）。
//!
//! 独立进程跑（cargo test 每个 tests/ 文件一个进程）——成功导入有真实副作用：
//! 写 myco-did/active.txt/种子槽/device.key、翻 account_did()（chat/offline_queue
//! 桶路由随它动态求值）、core base_url() OnceLock 定型。放进 lib 单测进程会与
//! chat_service/p2p_sync 的 set-once 夹具互踩（实测：meta 索引丢项、群自愈建群失败）。
//! 本进程内随意设 MYCO_CONFIG_DIR/MYCO_DID_BASE，零外溢。
//!
//! 格式错/密码错两纯态在 identity_service.rs 的 import_tests（--lib 覆盖）。

use base64::Engine as _;

/// 本地 identity-svc mock：任意 POST 都回 200 {}（/root/device/add、/root/create、
/// claim_embodiment 全部落这里；account_import 对后两者结果容错）。
async fn spawn_mock_id_svc() -> String {
    let app = axum::Router::new().fallback(axum::routing::post(|| async {
        axum::Json(serde_json::json!({}))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}")
}

#[tokio::test]
async fn import_succeeds_with_plaintext_seed() {
    // 身份域隔离（进程私有）：account_import 写的所有文件都落 temp，不碰真实 %APPDATA%\youling
    let dir = std::env::temp_dir().join(format!("myco-import-it-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::env::set_var("MYCO_CONFIG_DIR", &dir);
    // 身份服务指向本地 mock（本进程第一个也是唯一一个 base_url 调用方）
    let base = spawn_mock_id_svc().await;
    std::env::set_var("MYCO_DID_BASE", &base);

    let seed_b64 = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    let root_did = myco_core::identity::account_import(seed_b64, String::new())
        .await
        .expect("明文种子导入应成功");
    assert!(root_did.starts_with("did:youling:"), "rootDid 形态: {root_did}");
    // 副作用落地：当前账号=导入账号，账号种子已缓存（embodiment 态成立）
    assert_eq!(myco_core::identity::account_did().as_deref(), Some(root_did.as_str()));
    assert_eq!(myco_core::identity::cached_account_seed(), Some([7u8; 32]));

    let _ = std::fs::remove_dir_all(&dir);
}
