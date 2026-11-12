//! delegation_notify.rs — 2026-10-06 收编通知 P2P 直推 全链 mock 集成测试。
//!
//! 覆盖主设备侧发送路径（identity_service::add_device_by_did 的 spawn 链路实际
//! 调用的 p2p_client::deliver_delegation_notify）：
//!   ① 成员在线（presence 按【设备 did】寻址命中）→ POST /p2p/msg 送达，
//!      信封契约 = kind:delegation-notify + payload{rootDid, accountName}；
//!   ② 成员 presence 在列但地址不可达 → false（不 panic 不 Err——不挡主流程）；
//!   ③ 成员不在线（presence 无此设备）→ false（deliverBox 信箱兜底语义）。
//!
//! 独立进程跑的原因：MYCO_CONFIG_DIR / core 的 MYCO_DID_BASE OnceLock 都是进程级
//! 全局态——与 lib 内单测（group_semantics 设 MYCO_CONFIG_DIR）同进程会互相踩。
//! 本进程自设 MYCO_CONFIG_DIR=临时目录（设备钥自动创建）、MYCO_DID_BASE=本机 mock
//! （127.0.0.1 裸 TcpListener 应答），不碰真实配置目录、不碰真网。

use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

type Hits = Arc<Mutex<Vec<(String, String, String)>>>;
type Route = Arc<dyn Fn(&str, &str, &str) -> (u16, String) + Send + Sync>;

/// 最小 HTTP mock（裸 TcpListener；与 identity_service delegation_watch_tests 同款）。
/// 返回 (base_url, 捕获请求日志 [(method, path, body)])。
async fn mock_http(route: Route) -> (String, Hits) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let hits: Hits = Arc::new(Mutex::new(Vec::new()));
    let hits_bg = hits.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { break };
            let route = route.clone();
            let hits_conn = hits_bg.clone();
            tokio::spawn(async move {
                let mut buf: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 8192];
                let header_end = loop {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break p + 4;
                    }
                    if buf.len() > 1024 * 1024 {
                        return;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
                let content_len: usize = head
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
                    .unwrap_or(0);
                while buf.len() < header_end + content_len {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let body = String::from_utf8_lossy(&buf[header_end..]).to_string();
                let mut parts = head.lines().next().unwrap_or("").split_whitespace();
                let (method, path) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
                hits_conn.lock().unwrap().push((method.clone(), path.clone(), body.clone()));
                let (status, resp_body) = route(&method, &path, &body);
                let reason = match status {
                    200 => "OK",
                    201 => "Created",
                    404 => "Not Found",
                    _ => "X",
                };
                let resp = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{resp_body}",
                    resp_body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            });
        }
    });
    (format!("http://{addr}"), hits)
}

/// 测试用成员设备 did（确定性种子派生 canonical 设备 did，与产线同法）。
fn member_device_did() -> String {
    let sk = ed25519_dalek::SigningKey::from_bytes(&[0xABu8; 32]);
    myco_core::identity::did_from_public(&sk.verifying_key().to_bytes())
}

/// presence 条目（成员设备在线，PC，带直连地址指向 mock P2P 口）。
fn presence_entry(member_did: &str, p2p_port: u16) -> Value {
    json!({
        "did": member_did, "nodeId": member_did, "name": "笔记本",
        "kind": "pc", "rootDid": Value::Null, // 成员未取委任状——还不在主账号名册下
        "addrs": { "ipv6": "127.0.0.1", "ipv6List": ["127.0.0.1"], "port": p2p_port },
        "state": "active", "lastSeen": 1,
    })
}

#[tokio::test]
async fn delegation_notify_full_path() {
    // ── 进程级环境：隔离配置目录 + identity-svc 指 mock（OnceLock 前首设） ──
    let dir = std::env::temp_dir().join(format!("myco-dn-e2e-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()));
    std::env::set_var("MYCO_CONFIG_DIR", &dir);

    let member_did = member_device_did();
    let root_did = "did:youling:zMasterAccountForNotify";
    // 场景状态机：online / deadaddr / offline（presence/list 应答随之变化）
    let scenario = Arc::new(Mutex::new("online"));
    let p2p_port_holder = Arc::new(Mutex::new(0u16));

    // ── mock 成员设备 P2P 监听口（捕获 /p2p/msg） ──
    let (p2p_base, p2p_hits) = mock_http(Arc::new(|m, p, _b| {
        if m == "POST" && p == "/p2p/msg" {
            (200, r#"{"ok":true,"kept":false}"#.into())
        } else {
            (404, r#"{"error":"not found"}"#.into())
        }
    }))
    .await;
    let p2p_port: u16 = p2p_base.trim_start_matches("http://").rsplit(':').next().unwrap().parse().unwrap();
    *p2p_port_holder.lock().unwrap() = p2p_port;

    // ── mock identity-svc（注册 + presence/list 按场景应答） ──
    let scen_bg = scenario.clone();
    let member_bg = member_did.clone();
    let port_bg = p2p_port_holder.clone();
    let (id_base, _id_hits) = mock_http(Arc::new(move |m, p, _b| {
        if m == "POST" && p == "/identity/register" {
            return (201, r#"{"ok":true}"#.into());
        }
        if m == "POST" && p == "/presence/list" {
            let data = match *scen_bg.lock().unwrap() {
                "online" => json!([presence_entry(&member_bg, *port_bg.lock().unwrap())]),
                "deadaddr" => json!([presence_entry(&member_bg, 1)]), // 127.0.0.1:1 连接即拒
                _ => json!([]),                                       // offline：列表无此设备
            };
            return (200, json!({ "data": data }).to_string());
        }
        (404, r#"{"error":"not found"}"#.into())
    }))
    .await;
    std::env::set_var("MYCO_DID_BASE", &id_base);

    // ══ 场景①：成员在线 → 秒级送达，信封契约逐字段断言 ══
    let ok = myco_home_lib::p2p_client::deliver_delegation_notify(&member_did, root_did, "Fan").await;
    assert!(ok, "成员在线必须送达");
    let hits = p2p_hits.lock().unwrap();
    let msgs: Vec<_> = hits.iter().filter(|(m, p, _)| m == "POST" && p == "/p2p/msg").collect();
    assert_eq!(msgs.len(), 1, "应恰好一发 /p2p/msg: {hits:?}");
    let env: Value = serde_json::from_str(&msgs[0].2).unwrap();
    assert_eq!(env["kind"], json!("delegation-notify"));
    assert_eq!(env["from"], json!(root_did));
    assert_eq!(env["to"], json!(member_did));
    assert_eq!(env["payload"], json!({ "rootDid": root_did, "accountName": "Fan" }));
    assert!(env["msgId"].as_str().unwrap().starts_with("dn-"));
    assert!(env["fromDevice"].as_str().unwrap().starts_with("did:myco:"));
    drop(hits);

    // ══ 场景②：成员在列但地址不可达 → false（不 panic/不 Err = 不挡主流程） ══
    // 2026-11-12 根因修复：场景①的 presence 行在 2.5s TTL 缓存里，②不清缓存就会
    // 拿①的旧地址（仍在监听的 mock p2p 口）打出 2xx ——「不可达应 false」被污染
    // （0.01s 完成、零网络日志即此特征）。场景切换必须显式回源。
    myco_home_lib::p2p_client::presence_cache_invalidate();
    *scenario.lock().unwrap() = "deadaddr";
    let ok = myco_home_lib::p2p_client::deliver_delegation_notify(&member_did, root_did, "Fan").await;
    assert!(!ok, "地址不可达应 false（信箱兜底）");

    // ══ 场景③：成员离线（presence 无此设备）→ false（deliverBox 信箱兜底） ══
    myco_home_lib::p2p_client::presence_cache_invalidate();
    *scenario.lock().unwrap() = "offline";
    let ok = myco_home_lib::p2p_client::deliver_delegation_notify(&member_did, root_did, "Fan").await;
    assert!(!ok, "成员离线应 false（信箱兜底）");

    // ②③ 不得再有多余投递（总共仍只有场景①那一发）
    let hits = p2p_hits.lock().unwrap();
    assert_eq!(hits.iter().filter(|(m, p, _)| m == "POST" && p == "/p2p/msg").count(), 1);
}
