//! multi_membership_regression.rs — 多归属（一台 did:myco 设备属于多个 did:youling
//! 账号）TDD **红阶段**回归套件。
//!
//! 依据（两份共识，逐条对应测试名前缀）：
//!   · design/07-connectivity/多归属设备-共识版.md —— ★1-★5 阻断项 + 问题表 #1-#10
//!     （测试前缀 g1..g10；★=g1..g5）
//!   · design/07-connectivity/多归属落地-坑位预判-共识版.md —— L1-L3 活 bug
//!     （测试前缀 l1/l2/l3）
//!
//! 纪律（用户立法原话）：「TDD，你先做测试用例，体系化。以后改动相关要能回归，
//! 或产品定义变，用例同步。用例能复现我说的问题了，再改，然后证明用例通过。」
//! —— 因此本套件**全部为 RED（预期失败）**：断言写的是"修复后应然"，当前产品
//! 代码必然失败。修产品代码时**不得改本文件的断言方向**，只允许随产品定义变化
//! 同步用例（并在测试头注释里记录变更理由）。
//!
//! 运行：`cargo test -p myco-home --test multi_membership_regression -- --test-threads=1`
//! （进程级 MYCO_CONFIG_DIR / MYCO_DID_BASE / 各 OnceLock 全局态——必须串行；
//! 与 lib 单测同进程会互踩，故放独立集成测试进程，与 tests/delegation_notify.rs
//! 同款手法）。
//!
//! 隔离：本进程自设 MYCO_CONFIG_DIR=<temp>（不碰真实配置目录）、MYCO_DID_BASE=
//! 本机 mock（127.0.0.1 裸 TcpListener，不碰真网）。lib 内的 test_env_lock /
//! seed_own_share_for_test 是 pub(crate)，集成测试不可见——这里等价重建
//! （一把进程锁 + 一个临时目录），分享注册表用产线 HTTP 面（local_router /
//! p2p_router 在回环临时端口上真起 axum）驱动，比 seed 帮手更贴近真实链路。

use base64::Engine as _;
use ed25519_dalek::Signer as _;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use myco_home_lib::{dsh_share, presence, share_auth};
use myco_core::{delegation, identity as core_id};

// ═══════════════════════════════════════════════════════════════════════
// 进程级隔离：一把锁 + 一个临时配置目录 + 一个 mock identity-svc + 两个回环
// HTTP 面（dsh_share 本地管理面 / p2p_server 数据面）。
// ═══════════════════════════════════════════════════════════════════════

static LOCK: Mutex<()> = Mutex::new(());

/// 进程级测试锁（等价 lib 的 test_env_lock；这里集成测试进程自持一份）。
fn guard() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

type Hit = (String, String, String); // (method, path, body)

#[derive(Default)]
struct MockState {
    /// GET /root/<accountDid> → 名册应答（device_belongs_to_account 归属闸数据源）。
    rosters: HashMap<String, Value>,
    /// GET /device/<urlencoded pubkey> → 反查应答（L3：支持 roots 多账号列表形态）。
    device_lookup: HashMap<String, Value>,
    /// GET /delegation/poll → 信箱投递（L3）。
    delegation_poll: Option<Value>,
}

struct World {
    dir: std::path::PathBuf,
    /// mock identity-svc 基址（MYCO_DID_BASE）。
    id_base: String,
    hits: Arc<Mutex<Vec<Hit>>>,
    state: Arc<Mutex<MockState>>,
    /// dsh_share 本地管理面（:3102 同款路由，回环临时端口）。
    local: String,
    /// p2p_server 数据面（/p2p/msg 等，回环临时端口）。
    p2p: String,
}

static WORLD: OnceLock<World> = OnceLock::new();

/// 进程级世界（配置目录 + mock identity-svc + 两个回环 HTTP 面）。
/// 必须在持 guard() 后调用（初始化含 await；测试间串行避免双份 mock）。
async fn world() -> &'static World {
    if let Some(w) = WORLD.get() {
        return w;
    }
    let w = build_world().await;
    let _ = WORLD.set(w);
    WORLD.get().unwrap()
}

/// 进程级常驻 runtime：每个 #[tokio::test] 各有独立 current-thread runtime，
/// 测试结束即销毁——mock/路由服务器若 spawn 在测试 runtime 上会随第一个测试
/// 结束被杀（实测后续测试全部 connection refused）。这里用常驻 multi-thread
/// runtime 承载服务器任务，活到进程结束。
fn rt() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("常驻测试 runtime 应可构建")
    })
}

/// 在常驻 runtime 上起一个 axum 服务（端口随机），回传基址。
fn serve_persistent(make_router: impl FnOnce() -> axum::Router + Send + 'static) -> String {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    rt().spawn(async move {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind 应成功");
        let addr = listener.local_addr().unwrap();
        tx.send(format!("http://{addr}")).ok();
        let app = make_router();
        let _ = axum::serve(listener, app).await;
    });
    rx.recv().expect("服务器应回传基址")
}

async fn build_world() -> World {
    let dir = std::env::temp_dir().join(format!(
        "myco-multi-membership-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    let _ = std::fs::create_dir_all(&dir);
    std::env::set_var("MYCO_CONFIG_DIR", &dir);

    // ── mock identity-svc（先起服务，再设 MYCO_DID_BASE——core base_url 是 OnceLock）──
    let hits: Arc<Mutex<Vec<Hit>>> = Arc::new(Mutex::new(Vec::new()));
    let state: Arc<Mutex<MockState>> = Arc::new(Mutex::new(MockState::default()));
    let id_base = {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let hits_bg = hits.clone();
        let st_bg = state.clone();
        rt().spawn(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tx.send(format!("http://{addr}")).ok();
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let hits_conn = hits_bg.clone();
                let st = st_bg.clone();
                tokio::spawn(async move {
                    let mut buf: Vec<u8> = Vec::new();
                    let mut chunk = [0u8; 8192];
                    let header_end = loop {
                        let n = sock.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 { return; }
                        buf.extend_from_slice(&chunk[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") { break p + 4; }
                        if buf.len() > 1024 * 1024 { return; }
                    };
                    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
                    let content_len: usize = head
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
                        .unwrap_or(0);
                    while buf.len() < header_end + content_len {
                        let n = sock.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 { break; }
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let body = String::from_utf8_lossy(&buf[header_end..]).to_string();
                    let mut parts = head.lines().next().unwrap_or("").split_whitespace();
                    let (method, path) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
                    hits_conn.lock().unwrap().push((method.clone(), path.clone(), body.clone()));
                    let (status, resp_body) = route(&st, &method, &path, &body);
                    let reason = match status { 200 => "OK", 201 => "Created", 404 => "Not Found", 409 => "Conflict", _ => "X" };
                    let resp = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{resp_body}",
                        resp_body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        rx.recv().unwrap()
    };
    std::env::set_var("MYCO_DID_BASE", &id_base);

    // ── dsh_share 本地管理面（产线路由，回环临时端口）──
    let local = serve_persistent(|| dsh_share::local_router::<()>());

    // ── p2p_server 数据面（产线路由，回环临时端口；ConnectInfo 供隧道/审计用）──
    let p2p = {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        rt().spawn(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tx.send(format!("http://{addr}")).ok();
            let app = myco_home_lib::p2p_server::p2p_router()
                .into_make_service_with_connect_info::<std::net::SocketAddr>();
            let _ = axum::serve(listener, app).await;
        });
        rx.recv().unwrap()
    };

    World { dir, id_base, hits, state, local, p2p }
}

/// mock 路由决策（同步、按共享状态应答；未配置的一律 404，归属闸 fail-closed 语义一致）。
fn route(st: &Arc<Mutex<MockState>>, method: &str, path: &str, _body: &str) -> (u16, String) {
    let st = st.lock().unwrap();
    if method == "POST" && path == "/identity/register" {
        return (201, r#"{"ok":true}"#.into());
    }
    if method == "POST" && (path == "/presence/register" || path == "/presence/list") {
        return (200, r#"{"ok":true,"data":[]}"#.into());
    }
    if method == "POST" && path == "/revocation/push" {
        return (200, r#"{"ok":true}"#.into());
    }
    if method == "POST" && (path == "/msg/send" || path == "/msg/poll") {
        return (200, r#"{"ok":true,"data":{"msgs":[]}}"#.into());
    }
    if method == "POST" && path == "/root/create" {
        return (409, r#"{"ok":false,"error":"exists"}"#.into());
    }
    if method == "GET" {
        if let Some(did) = path.strip_prefix("/root/") {
            if let Some(v) = st.rosters.get(did) {
                return (200, v.to_string());
            }
            return (404, r#"{"error":"not found"}"#.into());
        }
        if let Some(_k) = path.strip_prefix("/device/") {
            if let Some(v) = st.device_lookup.get(path) {
                return (200, v.to_string());
            }
            return (404, r#"{"error":"not found"}"#.into());
        }
        if path.starts_with("/delegation/poll") {
            if let Some(v) = &st.delegation_poll {
                return (200, v.to_string());
            }
            return (200, r#"{"data":null}"#.into());
        }
    }
    (404, r#"{"error":"not found"}"#.into())
}

// ═══════════════════════════════════════════════════════════════════════
// 夹具：确定性账号钥 / 活动账号切换 / 名册与信箱注入 / HTTP 帮手
// ═══════════════════════════════════════════════════════════════════════

/// 确定性账号（seed=[tag;32]）→ canonical did:youling:z…（与产线 did_youling_from_public
/// 同构：did_from_public 产 did:myco:z<tail>，账号级只换 method 前缀，tail 同源）。
struct Acct {
    seed: [u8; 32],
    did: String,
    did_legacy: String,
}

fn acct(tag: u8) -> Acct {
    let seed = [tag; 32];
    let sk = ed25519_dalek::SigningKey::from_bytes(&seed);
    let pubb = sk.verifying_key().to_bytes();
    let dev_form = core_id::did_from_public(&pubb); // did:myco:z…
    let did = dev_form.replacen("did:myco:", "did:youling:", 1);
    // legacy 形态：裸 base58 公钥（历史存量 owner_root_did / 老账号串）
    let did_legacy = format!("did:youling:{}", bs58::encode(pubb).into_string());
    Acct { seed, did, did_legacy }
}

/// 本机设备裸公钥 b64（device.key 派生；device_belongs_to_account / 委任状的键形态）。
fn device_pub_b64() -> String {
    let (did, _) = core_id::device_identity().expect("设备钥应已自动创建");
    core_id::device_pubkey_from_did_or_b64(&did).unwrap()
}

/// 种子账号激活（主设备形态）：写 accounts/<safe>.seed + account_switch（产线路径，
/// 内部 reset_account_caches——SOUL_CACHE 是进程级，必须走它清）。
async fn activate_seed_account(a: &Acct) {
    let accounts = world().await.dir.join("accounts");
    std::fs::create_dir_all(&accounts).unwrap();
    std::fs::write(accounts.join(format!("{}.seed", a.did.replace([':', '/'], "_"))), a.seed).unwrap();
    core_id::account_switch(a.did.clone()).expect("切到种子账号应成功");
}

/// 成员账号激活（分身形态）：先落一张 B 签给本机设备钥的委任状（产线 accept_received
/// 路径——(账号,设备) 收敛），再 account_switch（无种子走委任状分支）。
fn activate_member_account(b: &Acct) {
    let dev = device_pub_b64();
    let d = delegation::issue_with_ttl(&b.seed, &b.did, &dev, "member-phone", None, delegation::DEVICE_DELIVER_TTL_MS, "d");
    delegation::Delegations::load().accept_received(d);
    core_id::account_switch(b.did.clone()).expect("持有效委任状应可切到成员账号");
}

/// 名册注入：GET /root/<acc.did> → 含指定设备公钥的未吊销名册（归属闸数据源）。
async fn set_roster(acc: &Acct, member_dev_pubs: &[String]) {
    let sk = ed25519_dalek::SigningKey::from_bytes(&acc.seed);
    let root_pub = b64std(&sk.verifying_key().to_bytes());
    let devices: Vec<Value> = member_dev_pubs.iter().map(|p| json!({"pubkeyB64": p, "revoked": 0})).collect();
    world().await.state.lock().unwrap().rosters.insert(
        acc.did.clone(),
        json!({"data": {"rootPubkeyB64": root_pub, "name": format!("acct-{}", &acc.did[..20.min(acc.did.len())]), "devices": devices}}),
    );
}

fn b64std(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

/// 设备身份信封签名头（X-Myco-Auth = did.ts.sig，签 `did\nts\nrawBody`——p2p 验签同款）。
fn auth_header(sk: &ed25519_dalek::SigningKey, did: &str, raw: &str) -> String {
    let ts = chrono::Utc::now().timestamp_millis() as u64;
    let sig = sk.sign(format!("{did}\n{ts}\n{raw}").as_bytes());
    format!("{did}.{ts}.{}", b64std(&sig.to_bytes()))
}

/// 向 p2p 面发一条设备签名的 /p2p/msg（sender = 任意设备钥，与产线手机/他机同构）。
async fn p2p_msg(
    sender: &ed25519_dalek::SigningKey,
    sender_did: &str,
    envelope: Value,
) -> Result<u16, String> {
    let raw = serde_json::to_string(&envelope).unwrap();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let r = client
        .post(format!("{}/p2p/msg", world().await.p2p))
        .header("x-myco-auth", auth_header(sender, sender_did, &raw))
        .header("content-type", "application/json")
        .body(raw)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(r.status().as_u16())
}

/// 本地管理面 JSON POST。
async fn local_post(path: &str, body: Value) -> (u16, Value) {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap();
    let r = client
        .post(format!("{}{}", world().await.local, path))
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = r.status().as_u16();
    let text = r.text().await.unwrap_or_default();
    let v = serde_json::from_str(&text).unwrap_or(json!({"_raw": text}));
    (status, v)
}

/// 本地管理面 GET（不跟随重定向——302 的 Location 本身是断言对象）。
async fn local_get(path: &str) -> (u16, Value, Option<String>) {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap();
    let r = client.get(format!("{}{}", world().await.local, path)).send().await.unwrap();
    let status = r.status().as_u16();
    let loc = r.headers().get("location").and_then(|v| v.to_str().ok()).map(String::from);
    let text = r.text().await.unwrap_or_default();
    let v = serde_json::from_str(&text).unwrap_or(json!({"_raw": text}));
    (status, v, loc)
}

/// 等待某条 mock 命中出现（异步 spawn 的推送，如 /revocation/push）。
async fn wait_for_hit(pred: impl Fn(&Hit) -> bool) -> Option<Hit> {
    for _ in 0..100 {
        if let Some(h) = world().await.hits.lock().unwrap().iter().find(|h| pred(h)).cloned() {
            return Some(h);
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    None
}

/// 审计文件行（config/dsh-share-audit.jsonl），按 share 过滤。
async fn audit_lines_for(share_id: &str) -> Vec<Value> {
    std::fs::read_to_string(world().await.dir.join("dsh-share-audit.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v.get("d").and_then(|d| d.get("share")).and_then(|s| s.as_str()) == Some(share_id))
        .collect()
}

/// 在 chat/<账号桶>/ 下搜索包含某 msgId 的会话文件 → 命中的桶目录名集合。
async fn chat_buckets_containing(msg_id: &str) -> Vec<String> {
    let mut out = vec![];
    let chat = world().await.dir.join("chat");
    let Ok(entries) = std::fs::read_dir(&chat) else { return out };
    for e in entries.flatten() {
        if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
        let bucket = e.file_name().to_string_lossy().to_string();
        if let Ok(files) = std::fs::read_dir(e.path()) {
            for f in files.flatten() {
                if let Ok(content) = std::fs::read_to_string(f.path()) {
                    if content.contains(msg_id) {
                        out.push(bucket);
                        break;
                    }
                }
            }
        }
    }
    out
}

// ═══════════════════════════════════════════════════════════════════════
// mod l1_l3 —— 坑位预判共识版：三个今天就存在的活 bug
// ═══════════════════════════════════════════════════════════════════════

mod l1_registered_flag {
    use super::*;

    /// L1（坑位预判共识版 §二）：REGISTERED 是进程级单布尔且有【两份】——
    /// presence.rs:28 一份、identity.rs:555 一份；device_logout（identity.rs:1266）
    /// 只复位 core 那份。换设备钥后 presence 永不重新 /identity/register → 静默死亡。
    /// 依据行号：多归属落地-坑位预判-共识版.md §二 L1（identity.rs:555 + presence.rs:28）。
    /// RED：预期失败，修复点在 presence.rs:28（REGISTERED 按 (key,account) 键控，
    /// 落地顺序 ⓪）。
    #[tokio::test]
    async fn l1_presence_must_reregister_after_device_key_rotation() {
        let _g = guard();
        let w = world().await;

        // 第一次 refresh：设备钥 K1 自动创建（identity_store 惰性建），presence 注册。
        presence::refresh().await;
        let old_did = core_id::device_identity().unwrap().0;

        // 换设备钥：device_logout 删 device.key（core REGISTERED 复位、presence 的
        // 不复位——这正是 L1），下次 device_identity 自动生成新钥 K2。
        core_id::device_logout().await.unwrap();
        presence::refresh().await;
        let new_did = core_id::device_identity().unwrap().0;
        assert_ne!(old_did, new_did, "device.key 删除后应生成新设备钥");

        // 新设备公钥必须真实发过 /identity/register（否则服务端不认识 K2，
        // 后续所有 signed_post 401/403 —— presence 静默死亡，只 eprintln）。
        let new_pub = core_id::device_pubkey_from_did_or_b64(&new_did).unwrap();
        let re = w
            .hits
            .lock()
            .unwrap()
            .iter()
            .any(|(m, p, b)| m == "POST" && p == "/identity/register" && b.contains(&new_pub));
        assert!(
            re,
            "RED L1：设备钥轮换后 presence 必须对新公钥重新 /identity/register\
             （当前 presence.rs:28 的 REGISTERED 进程级单布尔永不复位，只复位了 identity.rs:1266 那份）"
        );
    }
}

mod l2_revocation_account_blind {
    use super::*;

    /// L2-a（坑位预判 §二）：吊销链完全账号无关——同一 pubkey 在 A、B 各一条委任状
    /// 时，A 的吊销不得命中/删除 B 的行。当前 delegation.rs:280-292 只取第一条
    /// （find，非按账号过滤）。B 行在先时 A 侧吊销会错杀 B。
    /// 依据：多归属落地-坑位预判-共识版.md §二 L2（delegation.rs:280-292）。
    /// RED：预期失败，修复点在 delegation.rs:280（revoke 按 (账号,设备)）。
    #[test]
    fn l2a_revoke_for_one_account_must_not_kill_other_accounts_row() {
        let _g = guard();
        let a = acct(0xA1);
        let b = acct(0xB1);
        let store = delegation::Delegations::load_at(std::env::temp_dir().join(format!(
            "myco-l2a-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
        )));
        const P: &str = "c2hhcmVkLXB1Yg=="; // 同一把设备钥，A、B 各签一张委任状
        // B 行先落（多归属机器的真实形态：先被 B 收编、后被 A 收编）
        let db = delegation::issue_with_ttl(&b.seed, &b.did, P, "phone", None, delegation::DELEGATION_TTL_MS, "d");
        store.accept_received(db);
        let da = delegation::issue_with_ttl(&a.seed, &a.did, P, "phone", None, delegation::DELEGATION_TTL_MS, "d");
        store.accept_received(da);
        assert_eq!(store.list().len(), 2, "accept_received 按 (账号,设备) 收敛，两账号应并存");

        // A 侧发起吊销（当前 API 形态：revoke(pubkey)——账号盲）
        let _ = store.revoke(P);

        let rows = store.list();
        let b_row = rows.iter().find(|r| core_id::account_did_eq(&r.delegation.account_did, &b.did)).unwrap();
        let a_row = rows.iter().find(|r| core_id::account_did_eq(&r.delegation.account_did, &a.did)).unwrap();
        assert!(
            !b_row.revoked && b_row.delegation.device_pubkey_b64 == P,
            "RED L2-a：A 的吊销不得命中 B 的行（当前 delegation.rs:282 只取第一条=B 行，账号盲错杀）"
        );
        assert!(
            a_row.revoked,
            "RED L2-a：A 的吊销应命中 A 自己的行（当前只动了 B 行）"
        );
    }

    /// L2-b（坑位预判 §二）：revoked_pubkeys() 跨账号全量收集 + push_registry 用
    /// **当前活动账号**的种子签这份全量列表 → A 用自己的名义推走 B 的吊销记录
    /// = 独立跨账号泄露通道。
    /// 依据：多归属落地-坑位预判-共识版.md §二 L2（delegation.rs:304-306、389-393）。
    /// RED：预期失败，修复点在 delegation.rs:304（revoked_pubkeys 加账号参）与
    /// :389（push 用记录所属账号签名）。
    #[tokio::test]
    async fn l2b_revocation_push_must_only_carry_record_owners_pubkeys() {
        let _g = guard();
        let w = world().await;
        let a = acct(0xA2); // 活动账号（有种子，签名者）
        let b = acct(0xB2); // 另一账号（其吊销行不得被 A 的名义推走）
        activate_seed_account(&a).await;

        // delegations.json：A→P1 已吊销；B→P2 已吊销（B 的行属于 B）
        let p1 = "cHViLUEtMS0wMDAx";
        let p2 = "cHViLUItMi0wMDAy";
        let recs = vec![
            delegation::DelegationRecord {
                delegation: delegation::issue_with_ttl(&a.seed, &a.did, p1, "d1", None, delegation::DELEGATION_TTL_MS, "d"),
                revoked: true,
                last_renewed: 0,
            },
            delegation::DelegationRecord {
                delegation: delegation::issue_with_ttl(&b.seed, &b.did, p2, "d2", None, delegation::DELEGATION_TTL_MS, "d"),
                revoked: true,
                last_renewed: 0,
            },
        ];
        std::fs::write(
            w.dir.join("delegations.json"),
            serde_json::to_string_pretty(&recs).unwrap(),
        )
        .unwrap();

        delegation::push_revocations_best_effort(&Arc::new(delegation::Delegations::load()));

        let hit = wait_for_hit(|(m, p, _)| m == "POST" && p == "/revocation/push").await;
        let Some((_, _, body)) = hit else {
            panic!("RED L2-b：应发出 /revocation/push（当前未发——先核对推送链路）");
        };
        let v: Value = serde_json::from_str(&body).unwrap();
        let pushed: Vec<&str> = v["revokedPubkeys"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
        assert!(
            pushed.iter().all(|p| *p == p1),
            "RED L2-b：以 A 的名义（accountDid={}）推送的吊销清单只能含 A 名下的记录，\
             实推 {pushed:?}（当前 revoked_pubkeys() 跨账号全量收集，delegation.rs:304-306）",
            v["accountId"].as_str().or_else(|| v["accountDid"].as_str()).unwrap_or("?"),
        );
    }
}

mod l3_reverse_lookup_single_value {
    use super::*;

    /// L3（坑位预判 §二）：反查单值——GET /device/<pubkey> 只回最近加入的账号。
    /// 服务端修为多账号列表后，客户端取件轮询必须能发现**非最近**账号；当前
    /// watch_probe_at 只读 data.rootDid（单值），且把"归属不符"当毒件丢弃 →
    /// 第二个账号的委任状被静默扔掉，A 永远不"活"。
    /// 依据：多归属落地-坑位预判-共识版.md §二 L3（root.mjs:141-147；客户端对等
    /// identity_service.rs:676-697 / 655-659 毒件分支）。
    /// RED：预期失败，修复点在 identity_service.rs:678（lookup 消费多账号 roots）
    /// 与 :655（非最近账号的投递不得按毒件丢弃）。
    #[tokio::test]
    async fn l3_watch_must_discover_non_latest_account() {
        let _g = guard();
        let w = world().await;
        let a = acct(0xA3); // 先加入的账号（被单值反查吞掉的那个）
        let b = acct(0xB3); // 后加入的账号（反查只见它）
        let dev_pub = device_pub_b64();

        // 清登录态（self_master 判定不得命中）
        core_id::account_logout().await.unwrap();

        // /device/<pub> 应答：兼容多账号 roots 形态（服务端修后契约），单值 rootDid
        // 仍是 B（"最近加入"）。/delegation/poll 投的是 **A** 的委任状。
        let enc: String = url::form_urlencoded::byte_serialize(dev_pub.as_bytes()).collect();
        w.state.lock().unwrap().device_lookup.insert(
            format!("/device/{enc}"),
            json!({"data": {
                "rootDid": b.did,
                "attestSigB64": "dGVzdA==",
                "roots": [
                    {"rootDid": a.did, "attestSigB64": "dGVzdA=="},
                    {"rootDid": b.did, "attestSigB64": "dGVzdA=="}
                ]
            }}),
        );
        let d = delegation::issue_with_ttl(&a.seed, &a.did, &dev_pub, "phone", None, delegation::DEVICE_DELIVER_TTL_MS, "d");
        w.state.lock().unwrap().delegation_poll = Some(json!({"data": serde_json::to_value(&d).unwrap()}));
        set_roster(&a, &[dev_pub.clone()]).await;
        set_roster(&b, &[dev_pub.clone()]).await;

        let out = myco_home_lib::identity_service::watch_probe_at(
            &w.id_base,
            &dev_pub,
            |acc| core_id::account_did_eq(acc, &b.did), // B 已有有效委任状；A 还没有
        )
        .await
        .unwrap();

        match out {
            myco_home_lib::identity_service::WatchOutcome::Accepted { root_did, .. }
                if core_id::account_did_eq(&root_did, &a.did) => {}
            other => {
                panic!(
                    "RED L3：设备属于多账号时必须能发现非最近账号 {}（信箱正投着 A 的委任状），实得 {other:?}（当前 lookup_device_roster 只读单值 rootDid=B，A 的投递被当毒件丢弃）",
                    a.did
                );
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// mod g1_g5 —— 共识版 ★1-★5 阻断项
// ═══════════════════════════════════════════════════════════════════════

mod g1_member_eq_owner {
    use super::*;

    /// ★1-①（共识版问题表 #1 / 阻断清单 1）：handle_open 对"活动账号≠分享所属账号"
    /// 的本地打开必须拒绝——当前现签 owner 票零账号校验、零种子校验。
    /// 依据：多归属设备-共识版.md #1（dsh_share.rs:9167-9169 现签 365 天 owner 票）；
    /// 坑位预判 §四（owner 的定义里没有账号——"总阀门"）。
    /// RED：预期失败，修复点在 dsh_share.rs:9148（handle_open 校验活动账号==归属账号
    /// 或持 owner 凭据）。
    #[tokio::test]
    async fn g1a_local_open_must_reject_when_active_account_is_not_owner() {
        let _g = guard();
        let _w = world().await;
        let a = acct(0x11);
        let b = acct(0x12);
        activate_seed_account(&a).await;
        let (status, _) = local_post("/api/dshShare/create", json!({
            "shareId": "shr-g1a", "granularity": "session", "sessionId": "s-g1a", "title": "A 的分享"
        }))
        .await;
        assert_eq!(status, 200, "建分享应成功（设置步骤）");

        // 切到成员账号 B（本机只是 B 的成员，与分享 shr-g1a 毫无关系）
        activate_member_account(&b);
        let (status, _, loc) = local_get("/api/dshShare/open?shareId=shr-g1a").await;
        assert!(
            status == 401 || status == 403,
            "RED ★1：活动账号是 B（仅成员）时本地打开 A 的分享必须拒绝，\
             实得 {status} + Location={loc:?}（当前 dsh_share.rs:9167-9169 无条件现签 owner 票 302）"
        );
    }

    /// ★1-②（共识版 #1）：remote_open 的"本机即源设备"本地分支只比对设备 did，
    /// 不比对账号——B 活动态下打开 A 建的分享照样现签 owner 票。
    /// 依据：多归属设备-共识版.md #1；dsh_share.rs:9730-9741（device 匹配即 owner 票）。
    /// RED：预期失败，修复点在 dsh_share.rs:9730（本地分支校验分享归属==活动账号）。
    #[tokio::test]
    async fn g1b_remote_open_local_branch_must_check_account_ownership() {
        let _g = guard();
        let _w = world().await;
        let a = acct(0x13);
        let b = acct(0x14);
        activate_seed_account(&a).await;
        let (status, _) = local_post("/api/dshShare/create", json!({
            "shareId": "shr-g1b", "granularity": "session", "sessionId": "s-g1b", "title": "A 的分享"
        }))
        .await;
        assert_eq!(status, 200);

        activate_member_account(&b);
        let my_dev = core_id::device_identity().unwrap().0;
        let (status, _, loc) = local_get(&format!(
            "/api/dshShare/remoteOpen?shareId=shr-g1b&device={}&account={}",
            my_dev, a.did
        ))
        .await;
        assert!(
            status == 401 || status == 403 || (status >= 400 && status < 500 && status != 404),
            "RED ★1：B 活动态下 remote_open 本地分支不得给 A 的分享现签 owner 票，\
             实得 {status} + Location={loc:?}（当前 dsh_share.rs:9730-9741 只比设备 did，账号盲）"
        );
    }

    /// ★1-③（共识版 #1 / 坑位预判 §四）：decide_share_entry_grant ①"同账号自有设备
    /// =本人"只比对**活动账号**——本机切到成员账号 B 后，B 的主设备来要票，对 A 建
    /// 的分享也发 owner 票（member≡owner 的跨设备面）。
    /// 依据：多归属设备-共识版.md #1（dsh_share.rs:9628-9630）；坑位预判 §四。
    /// 断言通道：审计文件 dsh-share-audit.jsonl（remote-open-grant/deny 落点
    /// dsh_share.rs:9697/9702）。
    /// RED：预期失败，修复点在 dsh_share.rs:9628（① 分支加"分享归属账号==my_account"）。
    #[tokio::test]
    async fn g1c_share_entry_request_must_not_grant_owner_to_member_account() {
        let _g = guard();
        let _w = world().await;
        let a = acct(0x15);
        let b = acct(0x16);
        activate_seed_account(&a).await;
        let (status, _) = local_post("/api/dshShare/create", json!({
            "shareId": "shr-g1c", "granularity": "session", "sessionId": "s-g1c", "title": "A 的分享"
        }))
        .await;
        assert_eq!(status, 200);

        // 切到 B（成员）后，B 的主设备（另一台真机）请求进这张 A 的分享卡
        activate_member_account(&b);
        let b_main = acct(0x17); // B 的主设备钥
        let b_main_sk = ed25519_dalek::SigningKey::from_bytes(&b_main.seed);
        let b_main_pub = b64std(&b_main_sk.verifying_key().to_bytes());
        let b_main_did = core_id::did_from_public(&b_main_sk.verifying_key().to_bytes());
        set_roster(&b, &[b_main_pub]).await; // 归属闸：b_main ∈ B 名册

        let env = json!({
            "msgId": "m-g1c-1", "from": b.did, "fromDevice": b_main_did,
            "to": b.did, "kind": "share-entry-request",
            "payload": {"shareId": "shr-g1c", "requestId": "rq-g1c-1", "requesterDevice": b_main_did},
            "ts": chrono::Utc::now().timestamp_millis(),
        });
        let status = p2p_msg(&b_main_sk, &b_main_did, env).await.unwrap();
        assert_eq!(status, 200, "闸门应放行（from==活动账号 B 的自同步语义）");

        let granted = audit_lines_for("shr-g1c").await
            .iter()
            .any(|v| v["d"]["ev"] == json!("remote-open-grant"));
        assert!(
            !granted,
            "RED ★1：B（本机仅是其成员，非 shr-g1c 主人）的设备要票不得发 owner 票\
             （当前 decide_share_entry_grant ① 只比活动账号，dsh_share.rs:9628-9630）"
        );
    }

    /// ★1-④（共识版 阻断清单 1：「owner 票带设备 did（废除 did=None 免检）」）：
    /// create/open 签发的 owner mt 载荷 d 字段当前恒 null——did=None 的票在
    /// authorize_entry 整体跳过 authorized 检查（dsh_share.rs:2986-2990），是
    /// member≡owner 的总阀门。修复后 owner 票必须携带设备 did。
    /// 依据：多归属设备-共识版.md 阻断清单 1；dsh_share.rs:2975-2990、8079、9169。
    /// RED：预期失败，修复点在 dsh_share.rs:8079/9169（owner 票带设备 did）+
    /// :2986（did=None 不再免检）。
    #[tokio::test]
    async fn g1d_owner_ticket_must_carry_device_did() {
        let _g = guard();
        let _w = world().await;
        let a = acct(0x18);
        activate_seed_account(&a).await;
        let (_, v) = local_post("/api/dshShare/create", json!({
            "shareId": "shr-g1d", "granularity": "session", "sessionId": "s-g1d", "title": "t"
        }))
        .await;
        let mt = v["mt"].as_str().expect("create 应返回 owner mt");
        let (pb, _sig) = mt.split_once('.').unwrap();
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(pb)
            .expect("mt 载荷应为 base64url");
        let claims: Value = serde_json::from_slice(&raw).unwrap();
        assert!(
            claims["d"].is_string() && !claims["d"].as_str().unwrap().is_empty(),
            "RED ★1：owner mt 必须携带设备 did（当前 d=null——authorize_entry 对 did=None \
             整体跳过授权检查，dsh_share.rs:2986-2990，member≡owner 的总阀门）: {claims}"
        );
    }
}

mod g2_share_account_scope {
    use super::*;

    /// ★2（共识版 #2 / 阻断清单 2）：分享/授权域无账号维度 → 切号串权。A 建分享后
    /// 切到 B，列举不得看到 A 的分享（当前 handle_list 全局不筛账号）。
    /// 依据：多归属设备-共识版.md #2（dsh_share.rs:8861-8905 列举、Share 结构
    /// 189-241 无 owner 账号字段）；坑位预判 §五（只能逻辑分桶）。
    /// RED：预期失败，修复点在 dsh_share.rs:8861（列举按活动账号过滤）+
    /// Share.ownerAccount 字段（落地顺序 ③）。
    #[tokio::test]
    async fn g2a_list_must_filter_shares_by_active_account() {
        let _g = guard();
        let _w = world().await;
        let a = acct(0x21);
        let b = acct(0x22);
        activate_seed_account(&a).await;
        let (status, _) = local_post("/api/dshShare/create", json!({
            "shareId": "shr-g2a", "granularity": "session", "sessionId": "s-g2a", "title": "A 的分享"
        }))
        .await;
        assert_eq!(status, 200);

        activate_member_account(&b);
        let (_, v, _) = local_get("/api/dshShare/list").await;
        let shares = v["shares"].as_array().cloned().unwrap_or_default();
        let leaked = shares.iter().any(|s| s["shareId"] == json!("shr-g2a"));
        assert!(
            !leaked,
            "RED ★2：切到 B 后列举不得看到 A 的分享（当前 dsh_share.rs:8861-8905 全局不筛账号，切号串权）"
        );
    }

    /// ★2-b（共识版 #2）：local_owns_share 账号盲——不得把"别的账号在本机建的分享"
    /// 判成"我的"（§3.23 转授闸第一问的判定源）。
    /// 依据：多归属设备-共识版.md #2（dsh_share.rs:793-802）。
    /// todo：local_owns_share 是 pub(crate)，集成测试不可直调；且其消费面（转授闸/
    /// chat_service 转发闸）也均 pub(crate)。需要 lib 内单测（dsh_share.rs tests 模块，
    /// 接入 test_env_lock）落地本断言：A 建分享 → 切 B → local_owns_share("shr") 必须
    /// false。修复点 dsh_share.rs:793。
    #[test]
    #[ignore = "需 lib 级单测：local_owns_share(pub(crate)) 与其消费面均不在集成测试可见面"]
    fn g2b_local_owns_share_must_be_account_scoped() {
        todo!("lib 内单测：seed_own_share_for_test(\"shr-g2b\") → account_switch(B) → assert!(!local_owns_share(\"shr-g2b\"))（修复点 dsh_share.rs:793-802）")
    }
}

mod g4_non_active_account_403 {
    use super::*;

    /// ★4（共识版 #4 / 阻断清单 4）：非活动账号来电被 403。本机持 B 的有效委任状
    /// （成员态）时，B 主设备的来信不得因"from≠活动账号且非好友"被 NotFriend 403。
    /// 依据：多归属设备-共识版.md #4（p2p_server.rs:392-411 的 gate_decision：
    /// self_sync 只认活动账号；好友表取活动账号的桶）。
    /// RED：预期失败，修复点在 p2p_server.rs:403（gate_decision 加"本机持有该账号
    /// 有效委任状"分支）。
    #[tokio::test]
    async fn g4a_incoming_for_delegated_account_must_not_be_403() {
        let _g = guard();
        let _w = world().await;
        let a = acct(0x41); // 活动账号（A）
        let b = acct(0x42); // 本机是其成员的账号（持 B→本机 委任状）
        activate_seed_account(&a).await;
        activate_member_account_extra(&b); // 追加 B 的成员关系（活动账号仍是 A）

        let b_main = acct(0x43);
        let sk = ed25519_dalek::SigningKey::from_bytes(&b_main.seed);
        let did = core_id::did_from_public(&sk.verifying_key().to_bytes());
        set_roster(&b, &[b64std(&sk.verifying_key().to_bytes())]).await;

        let env = json!({
            "msgId": "m-g4a-1", "from": b.did, "fromDevice": did,
            "to": a.did, "kind": "text", "payload": {"text": "B 主设备发来的"},
            "ts": chrono::Utc::now().timestamp_millis(),
        });
        let status = p2p_msg(&sk, &did, env).await.unwrap();
        assert_eq!(
            status, 200,
            "RED ★4：本机持 B 有效委任状时，B 主设备来信不得 403 NotFriend\
             （当前 p2p_server.rs:403-405 self_sync 只认活动账号 A → 403）"
        );
    }

    /// ★4-b / 共识 #4 后半（chat 落桶）：收给账号 B 的消息（本机是 B 成员）不得落进
    /// **活动账号 A** 的会话桶——好友表/会话桶全部取活动账号的桶是 403 之外的
    /// 另一半串权。共识对照行：chat_service.rs:140-153（桶随活动账号动态求值）。
    /// 依据：多归属设备-共识版.md #4；坑位预判 §五（对照：会话域"早已"按账号分桶
    /// ——但收信路由仍是活动账号单值）。
    /// RED：预期失败，修复点在 chat_service.rs:944-965（ingest 按 to/归属账号路由桶，
    /// 而非一律活动账号桶）。
    #[tokio::test]
    async fn g4b_message_for_member_account_must_land_in_its_own_bucket() {
        let _g = guard();
        let _w = world().await;
        let a = acct(0x44);
        let b = acct(0x45);
        activate_seed_account(&a).await;
        activate_member_account_extra(&b);

        // B 是 A 的好友（让现行好友闸放行——本测试钉的是落桶，不是闸门）
        let friends = json!([{"did": b.did, "label": "B", "status": "ok"}]);
        let bucket_a = world().await.dir.join("chat").join(a.did.replace([':', '/'], "_"));
        std::fs::create_dir_all(&bucket_a).unwrap();
        std::fs::write(bucket_a.join("friends.json"), serde_json::to_string_pretty(&friends).unwrap()).unwrap();

        let b_main = acct(0x46);
        let sk = ed25519_dalek::SigningKey::from_bytes(&b_main.seed);
        let did = core_id::did_from_public(&sk.verifying_key().to_bytes());
        set_roster(&b, &[b64std(&sk.verifying_key().to_bytes())]).await;

        let env = json!({
            "msgId": "m-g4b-1", "from": b.did, "fromDevice": did,
            "to": b.did, "kind": "text", "payload": {"text": "给 B 账号这台成员设备的"},
            "ts": chrono::Utc::now().timestamp_millis(),
        });
        let status = p2p_msg(&sk, &did, env).await.unwrap();
        assert_eq!(status, 200, "好友在册 + 归属闸过 → 现行闸门应放行");

        let buckets = chat_buckets_containing("m-g4b-1").await;
        let bucket_b = b.did.replace([':', '/'], "_");
        assert!(
            buckets.iter().any(|x| *x == bucket_b) && !buckets.iter().any(|x| *x == a.did.replace([':', '/'], "_")),
            "RED ★4-b：收给账号 B 的消息必须落 B 的桶（本机是 B 的成员设备），\
             实落桶 {buckets:?}（当前 ingest 一律落活动账号 A 的桶，chat_service.rs:944-965）"
        );
    }

    /// ★4-c（坑位预判/共识 #4 附注的确定性形态）：在飞 ingest 的 `my` 在前、
    /// chat_dir() 在后又读一次 active——两次读之间切号则落错桶。
    /// todo：确定性复现需要在 my 读取与 chat_dir() 求值之间注入切号钩子（产品
    /// 代码无此缝）；等 ingest 桶路由改为显式传参（g4b 的修复形态）后本条自然
    /// 收敛为 g4b 的断言。在此之前保留占位，防止"定义变了用例没跟"。
    #[test]
    #[ignore = "需 ingest 内注入切号钩子才能确定性复现；g4b 修复（按归属账号路由桶）后收敛"]
    fn g4c_ingest_bucket_must_follow_arrival_time_account() {
        todo!("注入切号断言落桶==到达时刻的活动账号（修复点 chat_service.rs:944-965 + conv_append 的 chat_dir() 动态求值）")
    }
}

mod g5_create_credential_gate {
    use super::*;

    /// ★5（共识版 #5 / 阻断清单 5）：建分享无凭据闸——无账号种子（纯成员/未登录）时
    /// handle_create 直接用活动账号自动授权，纯成员可"以 A 的身份"建分享并自我授权
    /// owner 级。必须被拒或要求 scope 授权。
    /// 依据：多归属设备-共识版.md #5（dsh_share.rs:8024-8095、8100-8133）。
    /// RED：预期失败，修复点在 dsh_share.rs:8024（handle_create 凭据闸）。
    #[tokio::test]
    async fn g5_create_must_be_rejected_without_owner_credentials() {
        let _g = guard();
        let _w = world().await;
        // 无种子、无委任状：account_logout 清 active.txt + 缓存（account_did → None）
        core_id::account_logout().await.unwrap();
        assert!(core_id::account_did().is_none(), "前置：登出后应无活动账号");

        let (status, v) = local_post("/api/dshShare/create", json!({
            "shareId": "shr-g5", "granularity": "session", "sessionId": "s-g5", "title": "无凭据建分享"
        }))
        .await;
        let ok = v["ok"].as_bool().unwrap_or(false);
        assert!(
            !ok || status == 401 || status == 403,
            "RED ★5：无种子/无委任状时建分享必须被拒（或要求 scope 授权），\
             实得 status={status} ok={ok}（当前 dsh_share.rs:8024-8095 无凭据闸，直接建）"
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════
// mod g6_g10 —— 共识版问题表 #6-#10
// ═══════════════════════════════════════════════════════════════════════

mod g6_presence_role {
    use super::*;

    /// #6（共识版问题表 6）：presence 谎报身份——role 硬编码 "embodiment"（member
    /// 手机在每个账号都自称主设备）；identity.rs:275-300 已算出真实 role，presence
    /// 没用。成员账号活动时 presence 必须如实报 agent。
    /// 依据：多归属设备-共识版.md #6（presence.rs:148-156，role 155）。
    /// RED：预期失败，修复点在 presence.rs:155（role 复用 accounts_load_with_roles）。
    #[tokio::test]
    async fn g6_presence_role_must_report_actual_role() {
        let _g = guard();
        let w = world().await;
        let b = acct(0x61); // 本机只是 B 的成员（无种子、有委任状）
        activate_member_account(&b);
        assert!(core_id::cached_account_seed().is_none(), "成员态无账号种子");

        presence::refresh().await;

        let hit = w
            .hits
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|(m, p, body)| m == "POST" && p == "/presence/register" && body.contains("\"role\""))
            .cloned();
        let Some((_, _, body)) = hit else { panic!("应发出 /presence/register（含 role）") };
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            v["rootDid"].as_str().map(String::from),
            Some(core_id::account_did().unwrap()),
            "sanity：rootDid 应为活动账号"
        );
        assert_eq!(
            v["role"], json!("agent"),
            "RED #6：成员账号的 presence role 必须如实报 agent（当前 presence.rs:155 硬编码 embodiment——member 在每个账号都自称主设备）"
        );
    }
}

mod g8_audit_dimensions {
    use super::*;

    /// #8（共识版问题表 8）：审计缺 (账号,设备) 双维——grant/deny 记账号不记设备，
    /// create 连账号都不记。多归属下无法回答"哪个账号的哪台设备动过这张卡"。
    /// 依据：多归属设备-共识版.md #8（dsh_share.rs:9697/9702/9754、2825-2836）。
    /// RED：预期失败，修复点在 dsh_share.rs:2825（audit 补 account+device 维）。
    #[tokio::test]
    async fn g8_audit_create_must_record_account_and_device() {
        let _g = guard();
        let _w = world().await;
        let a = acct(0x81);
        activate_seed_account(&a).await;
        let (status, _) = local_post("/api/dshShare/create", json!({
            "shareId": "shr-g8", "granularity": "session", "sessionId": "s-g8", "title": "t"
        }))
        .await;
        assert_eq!(status, 200);

        let lines = audit_lines_for("shr-g8").await;
        let create_line = lines.iter().find(|v| v["d"]["ev"] == json!("create")).cloned();
        let Some(line) = create_line else { panic!("create 应落审计行") };
        let has_account = line["d"].get("account").is_some() || line["d"].get("accountDid").is_some();
        let has_device = line["d"].get("device").is_some() || line["d"].get("deviceDid").is_some();
        assert!(
            has_account && has_device,
            "RED #8：审计必须记录 (账号,设备) 双维，实得 {}（当前 dsh_share.rs:2825-2836 只记事件+share）",
            line["d"]
        );
    }
}

mod g9_owner_root_did_semantics {
    use super::*;

    /// #9-a（共识版问题表 9）：owner_root_did 两套注册表语义相反——share_auth 的
    /// upsert **无条件覆盖**归属（最后写入者决定归属），与 core authorized 的
    /// "空才回填"相反。归属不得被后写者翻转。
    /// 依据：多归属设备-共识版.md #9（share_auth.rs:327-329 vs authorized.rs:226-236）。
    /// RED：预期失败，修复点在 share_auth.rs:327（改为空才回填/显式变更面）。
    #[tokio::test]
    async fn g9a_share_auth_upsert_must_not_overwrite_owner_root_did() {
        let _g = guard();
        let _w = world().await;
        let a = acct(0x91);
        let b = acct(0x92);
        let dev = format!("did:myco:zDevG9a{}", std::process::id());
        let authz = share_auth::shared();
        authz.upsert_device(&dev, "g9a 设备", Some(a.did.clone()), Some(true), None, None);
        authz.upsert_device(&dev, "g9a 设备改名", Some(b.did.clone()), Some(true), None, None); // 后写者
        let got = authz.list().iter().find(|d| d.did == dev).unwrap().owner_root_did.clone();
        assert_eq!(
            got.as_deref(),
            Some(a.did.as_str()),
            "RED #9：owner_root_did 不得被后写者覆盖（当前 share_auth.rs:327-329 无条件覆盖，归属由最后写入者决定）"
        );
    }

    /// #9-b（共识版问题表 9，对照锚）：core authorized.rs 的 backfill 语义是
    /// **空才回填**（226-236）——这是两套注册表中"对"的那套。本条是 GREEN 锚：
    /// 修复 share_auth 时不得回退 core 侧语义；两套必须收敛到同一种。
    /// 依据：多归属设备-共识版.md #9（authorized.rs:226-236）。
    #[tokio::test]
    async fn g9b_core_backfill_keeps_first_writer() {
        let _g = guard();
        let _w = world().await;
        let a = acct(0x93);
        let b = acct(0x94);
        let dev = format!("did:myco:zDevG9b{}", std::process::id());
        let authz = myco_core::authorized::Authorized::load();
        authz.add_device_by_did(&dev, "g9b 设备", "", None, false, None, None);
        authz.backfill_owner_root_did(&dev, &a.did);
        authz.backfill_owner_root_did(&dev, &b.did); // 后写者不得翻转
        let got = authz.list().iter().find(|d| d.did == dev).unwrap().owner_root_did.clone();
        assert_eq!(got.as_deref(), Some(a.did.as_str()), "core 侧空才回填语义（对照锚，GREEN）");
    }

    /// #9-c（共识版问题表 9 尾点）：handle_create 的同账号自动授权**不得依赖精确串**比较
    /// owner_root_did——authorized 行存同一账号的**另一 canonical 前缀**写法
    /// （`did:myco:z…` vs 活动账号 `did:youling:z…`，同公钥）时，必须走 `account_did_eq`
    /// 公钥级归一命中，否则该设备拿不到自动授权。
    /// 依据：多归属设备-共识版.md #9（dsh_share.rs:8190 owner_root_did 比较走 account_did_eq）。
    /// 2026-10-10 canonical-only：等价形态轴 = **canonical 双前缀**（legacy 裸 base58 已废止，
    /// 不再参与归一——文末反向守卫锁这条）。
    #[tokio::test]
    async fn g9c_create_auto_grant_must_match_account_did_forms() {
        let _g = guard();
        let _w = world().await;
        let a = acct(0x95);
        activate_seed_account(&a).await;
        let dev = format!("did:myco:zDevG9c{}", std::process::id());
        // 同一账号 A 的另一 canonical 前缀写法（同公钥、非精确串）
        let other_form = a.did.replacen("did:youling:", "did:myco:", 1);
        assert!(other_form.starts_with("did:myco:z") && other_form != a.did, "前置：另一 canonical 前缀且串不同");
        share_auth::shared().upsert_device(&dev, "g9c 自有设备", Some(other_form.clone()), Some(true), None, None);

        let (status, _) = local_post("/api/dshShare/create", json!({
            "shareId": "shr-g9c", "granularity": "session", "sessionId": "s-g9c", "title": "t"
        }))
        .await;
        assert_eq!(status, 200);

        let (_, v, _) = local_get("/api/dshShare/list").await;
        let share = v["shares"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["shareId"] == json!("shr-g9c"))
            .cloned()
            .expect("分享应在列");
        let granted = share["grants"]
            .as_array()
            .unwrap()
            .iter()
            .any(|g| g["did"] == json!(dev));
        assert!(
            granted,
            "RED #9：owner_root_did 存同账号另一 canonical 前缀（{}）时自动授权不得漏\
             （精确串比较会漏，须走 account_did_eq 公钥级归一）",
            other_form
        );

        // ── 反向守卫（canonical-only）：owner_root_did 存**已废止的 legacy 裸 base58** 形态
        //    → account_did_eq 不再归一 → 不自动授权。
        let dev_legacy = format!("did:myco:zDevG9cL{}", std::process::id());
        share_auth::shared().upsert_device(&dev_legacy, "g9c legacy 形态设备", Some(a.did_legacy.clone()), Some(true), None, None);
        let (status2, _) = local_post("/api/dshShare/create", json!({
            "shareId": "shr-g9c-legacy", "granularity": "session", "sessionId": "s-g9c-legacy", "title": "t2"
        }))
        .await;
        assert_eq!(status2, 200);
        let (_, v2, _) = local_get("/api/dshShare/list").await;
        let share2 = v2["shares"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["shareId"] == json!("shr-g9c-legacy"))
            .cloned()
            .expect("第二份分享应在列");
        let granted_legacy = share2["grants"]
            .as_array()
            .unwrap()
            .iter()
            .any(|g| g["did"] == json!(dev_legacy));
        assert!(
            !granted_legacy,
            "legacy 已废止：owner_root_did 存 legacy 形态（{}）不再自动授权（canonical-only）",
            a.did_legacy
        );
    }
}

mod g10_logout_granularity {
    use super::*;

    /// #10（共识版问题表 10）：退出粒度=设备——device_logout 删唯一 device.key，
    /// 从任一账号登出会同时废掉**所有账号**的成员凭据；没有"只退出某账号"的路径。
    /// 前置形态：本机是 A、B 两个账号的成员。从 A 退出后，B 的成员身份必须仍可用
    /// （设备 did 不变、B 的委任状仍绑定本设备钥）。
    /// 依据：多归属设备-共识版.md #10（identity.rs:1254-1268）。
    /// RED：预期失败，修复点在 identity.rs:1254（新增按账号登出；设备级登出须显式
    /// 二次确认"将退出所有账号"）。
    #[tokio::test]
    async fn g10_account_scoped_logout_must_keep_other_membership_alive() {
        let _g = guard();
        let _w = world().await;
        let a = acct(0xAa);
        let b = acct(0xAb);
        activate_member_account(&a); // 先以 A 成员身份登录
        activate_member_account_extra(&b); // 同时是 B 的成员
        let dev_before = core_id::device_identity().unwrap().0;

        // 在 A 的账号界面点"退出"（当前唯一可用的退出路径=设备级 device_logout）
        core_id::device_logout().await.unwrap();

        let dev_after = core_id::device_identity().unwrap().0;
        assert_eq!(
            dev_after, dev_before,
            "RED #10：从 A 退出不得废掉 B 的成员凭据（当前 device_logout 删唯一 device.key，\
             identity.rs:1254-1268——一把钥匙连坐所有账号，新 did={dev_after}）"
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════
// mod g3_issue_side —— 共识"收窄口径消不掉"残留：签发侧每钥一条互删
// （共识版「收窄口径消掉的」表尾注：「成员侧委任状互删」已消，但**签发侧仍活**
// ——同一台主 PC 持多账号种子时 issue 给 B 会删掉 A 的留档，delegation.rs:236）
// ═══════════════════════════════════════════════════════════════════════

mod g3_issue_side_mutdelete {
    use super::*;

    /// ★3 签发侧（共识版 #3 / 收窄口径表尾注）：同一台主 PC 持 A、B 两账号种子，
    /// 先给设备 P 签 A 的委任状、再签 B 的——A 的留档不得被删（retain 只按 pubkey，
    /// 与 accept_received 的 (账号,设备) 收敛实现分叉）。
    /// 依据：多归属设备-共识版.md #3 + 「收窄口径消掉的」表（delegation.rs:236 vs
    /// 247-250 的分叉）。
    /// RED：预期失败，修复点在 delegation.rs:236（issue 侧 retain 同样按 (账号,设备)）。
    #[test]
    fn g3_issue_side_two_accounts_same_pubkey_must_coexist() {
        let _g = guard();
        let a = acct(0xAC);
        let b = acct(0xAD);
        let store = delegation::Delegations::load_at(std::env::temp_dir().join(format!(
            "myco-g3-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
        )));
        const P: &str = "c2hhcmVkLXB1Yg==";
        store
            .issue_for_with_ttl(&a.seed, &a.did, P, "phone", None, delegation::DELEGATION_TTL_MS)
            .unwrap();
        store
            .issue_for_with_ttl(&b.seed, &b.did, P, "phone", None, delegation::DELEGATION_TTL_MS)
            .unwrap();

        let has_a = store.list().iter().any(|r| core_id::account_did_eq(&r.delegation.account_did, &a.did) && r.delegation.device_pubkey_b64 == P);
        let has_b = store.list().iter().any(|r| core_id::account_did_eq(&r.delegation.account_did, &b.did) && r.delegation.device_pubkey_b64 == P);
        assert!(
            has_a && has_b,
            "RED ★3：签发侧 A、B 对同一设备钥的委任状留档必须并存\
             （当前 delegation.rs:236 retain 只按 pubkey，给 B 签发删掉 A 的留档——实现分叉）"
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════
// mod tunnel_keys —— 隧道键不含账号（共识补充面）
// ═══════════════════════════════════════════════════════════════════════

mod tunnel_account_keying {
    /// 隧道 TUNNELS/CACHE 键不含账号（tunnel_key = device#port，p2p_tunnel.rs:1219-1221；
    /// 连接握手身份取**当下活动账号** p2p_tunnel.rs:1655-1664）→ 切号后同一本地端口
    /// 的后续握手以另一账号出示/签名——A 授权的隧道被 B 的身份继续使用。
    /// 依据：任务共识（切号后本地端口以另一账号签名）；坑位预判 §三（出示的身份与
    /// 签名的钥匙在协议层同一个 did）。
    /// todo：确定性复现需要完整隧道对端（WS + v2 加密握手）+ 账号切换钩子——
    /// lib 内 p2p_tunnel::tunnel_tests 的 spawn_p2p_server 夹具（tunnel_two_process_
    /// e2e_role 双进程形态）是正确落点；集成测试侧等 install_tunnel_provider 注入
    /// 钩子后补。修复点：tunnel_key 加账号维 + 复用连接的握手身份绑定开隧账号。
    #[test]
    #[ignore = "需 lib 隧道测试夹具/双进程 E2E 落地；见多归属-多设备测试方法.md 的双进程一节"]
    fn tunnel_keys_must_include_account_dimension() {
        todo!("A 活动态开隧道 → 切 B → 同一本地端口新连接的握手 account 必须仍是 A（或隧道按账号分键重开）")
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 内部帮手：活动账号保持不变的前提下追加成员关系（g4/g10 用——本机同时是
// 多个账号的成员，这才是"多归属"的形态）
// ═══════════════════════════════════════════════════════════════════════

/// 追加 B 的成员关系但**不切换**活动账号：直接往 delegations.json 落一张
/// B→本机设备钥 的委任状（accept_received 是 (账号,设备) 收敛的产线路径）。
fn activate_member_account_extra(b: &Acct) {
    let dev = device_pub_b64();
    let d = delegation::issue_with_ttl(&b.seed, &b.did, &dev, "member-phone", None, delegation::DEVICE_DELIVER_TTL_MS, "d");
    delegation::Delegations::load().accept_received(d);
}
