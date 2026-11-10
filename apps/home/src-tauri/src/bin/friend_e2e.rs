//! friend_e2e.rs — 好友关系去服务端化双实例 E2E（2026-10-07，设计=refactor
//! docs/todo/2026-10-07-好友关系去服务端化设计.md）。
//!
//! 验收链（双端真链，本地 identity-svc）：
//!   A 加 B（本地乐观 out-pending + 信箱兜底投递）→ B 收 request（chat_poll 拉信箱
//!   → 验签+名册归属 → in-pending）→ B accept（本地 ok + P2P 直推回执）→
//!   A 收 accept（豁免闸放行 → out-pending→ok + "你们已成为好友"系统条）→
//!   B remove → A 收 friend-remove（清行+清会话）。
//!
//! 双路覆盖：①段 A 加 B 走**信箱兜底**（B 不起 p2p 服务器/不上 presence——直推
//! 寻址落空自动落 /msg/send）；②段 B 的 accept/remove 走 **P2P 直推**（B 起 p2p
//! 服务器+presence 后，A 在线直收——好友闸豁免三 kind 的真实验证）。
//!
//! 三进程对拍（device_group_e2e.rs 同款）：
//!   ① 本地 identity-svc：PORT=18331 DB_PATH=<临时> node services/identity-svc/identity-server.mjs
//!      （**绝不碰生产 myco.youling.cc**——本 bin 启动即硬闸：MYCO_DID_BASE 非本机即拒跑）
//!   ② 实例 A：FR_E2E_ROLE=a MYCO_CONFIG_DIR=<dir>\cfgA MYCO_P2P_PORT=9140
//!             COMPUTERNAME=FR-E2E-A MYCO_DID_BASE=http://127.0.0.1:18331
//!   ③ 实例 B：FR_E2E_ROLE=b ... cfgB / 9145 / FR-E2E-B
//!   双端 FR_E2E_DIR 指同一共享目录（信号文件 a_*.json / b_*.json / s_*.json 对拍）。
//!
//! MYCO_CONFIG_DIR 分桶 = identity 域隔离（设备钥/账号槽/chat 桶全分开）。

use myco_core::identity as core_id;
use myco_home_lib::chat_service::{chat_accept_friend, chat_add_friend, chat_poll, chat_remove_friend, chat_state};
use myco_home_lib::p2p_server::{p2p_port, start_p2p_server_for_test};
use myco_home_lib::presence;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

fn role() -> String {
    std::env::var("FR_E2E_ROLE").unwrap_or_else(|_| "a".into())
}

/// 断言即报告：过打 ✅、败打 ❌ 后 panic（进程非零退出，orchestrator 靠退出码判）。
fn ck(cond: bool, name: &str, detail: &str) {
    if cond {
        println!("[FR-E2E-{}] ✅ {}", role(), name);
    } else {
        println!("[FR-E2E-{}] ❌ {} —— {}", role(), name, detail);
        panic!("E2E 断言失败: {name} —— {detail}");
    }
}

fn shared_dir() -> PathBuf {
    PathBuf::from(std::env::var("FR_E2E_DIR").expect("必须设 FR_E2E_DIR（双端同一共享信号目录）"))
}

fn sig_write(name: &str, v: &Value) {
    let p = shared_dir().join(name);
    std::fs::write(&p, serde_json::to_string_pretty(v).unwrap()).expect("写信号文件失败");
    println!("[FR-E2E-{}] → 信号 {} 已写", role(), name);
}

/// 等信号文件出现（500ms 轮询；超时 panic 带上下文）。
async fn sig_wait(name: &str, timeout_secs: u64) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        let p = shared_dir().join(name);
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str(&s) {
                println!("[FR-E2E-{}] ← 信号 {} 已收", role(), name);
                return v;
            }
        }
        if std::time::Instant::now() > deadline {
            panic!("等待信号 {name} 超时（{timeout_secs}s）——对端实例未按预期推进");
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

fn my_cfg_dir() -> String {
    std::env::var("MYCO_CONFIG_DIR").expect("必须设 MYCO_CONFIG_DIR（identity 域分桶）")
}

/// 启动前置（双角色共用）：环境硬闸（绝不碰生产/绝不碰活登录器目录）。
/// 注意：**不**起 p2p 服务器——①段 A→B 必须走信箱兜底（B 无监听+无 presence），
/// p2p 服务器由 B 在②段显式起（验证 P2P 直推路径）。
async fn boot() {
    let base = std::env::var("MYCO_DID_BASE").unwrap_or_default();
    assert!(
        base.starts_with("http://127.0.0.1:") || base.starts_with("http://localhost:"),
        "安全闸：MYCO_DID_BASE={base} 必须指向本机 identity-svc（绝不碰生产 myco.youling.cc）"
    );
    let cfg = my_cfg_dir();
    let real = std::env::var("APPDATA").map(|a| format!("{a}\\youling")).unwrap_or_default();
    assert!(
        !cfg.eq_ignore_ascii_case(&real),
        "安全闸：MYCO_CONFIG_DIR 指向了活登录器目录 {cfg}"
    );
    std::fs::create_dir_all(&cfg).expect("建 cfg 目录失败");
    std::fs::create_dir_all(shared_dir()).expect("建共享信号目录失败");
}

/// 本机快照里的好友行（按 did 公钥级找）。
async fn friend_row(did: &str) -> Option<Value> {
    let snap = chat_state().await.ok()?;
    snap["friends"].as_array().and_then(|fs| {
        fs.iter().find(|f| {
            f["did"].as_str().map(|d| core_id::account_did_eq(d, did)).unwrap_or(false)
        }).cloned()
    })
}

/// 等好友行满足谓词（轮询本地快照；超时 panic）。
async fn wait_friend_row(did: &str, name: &str, pred: impl Fn(&Value) -> bool, timeout_secs: u64) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        if let Some(f) = friend_row(did).await {
            if pred(&f) {
                println!("[FR-E2E-{}] ✅ 好友行 {name} 已就位", role());
                return f;
            }
        }
        if std::time::Instant::now() > deadline {
            panic!("等待好友行 {name} 超时（{timeout_secs}s）");
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// presence 心跳循环（10s < 90s TTL）。返回停止开关。
fn spawn_heartbeat() -> std::sync::Arc<AtomicBool> {
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let s = stop.clone();
    tokio::spawn(async move {
        loop {
            if s.load(Ordering::Relaxed) {
                return;
            }
            presence::refresh().await;
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });
    stop
}

// ═══════════════════════ 实例 A（发起方） ═══════════════════════

async fn run_a() {
    boot().await;

    // ── ① 建号 + 上线（p2p 服务器 + presence——B 的 accept/remove 直推目标）──
    let info = core_id::account_create(Some("好友E2E-甲".into()), None, None, None)
        .await
        .expect("建号失败（本地 identity-svc 未起？）");
    let me = info.root_did.clone();
    println!("[FR-E2E-a] 建号 rootDid={me}");
    tokio::spawn(async { start_p2p_server_for_test().await });
    for _ in 0..40 {
        if p2p_port() > 0 { break; }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    ck(p2p_port() > 0, "A p2p 服务器已启动", &format!("port={}", p2p_port()));
    let _hb = spawn_heartbeat();
    presence::refresh().await;
    sig_write("a_ready.json", &json!({ "rootDid": me }));

    // ── ② A 加 B（B 离线无监听 → 直推寻址落空 → 信箱兜底投递）──
    let b = sig_wait("b_ready.json", 90).await;
    let b_root = b["rootDid"].as_str().unwrap_or("").to_string();
    let add = chat_add_friend(b_root.clone(), String::new()).await.expect("chat_add_friend 失败");
    println!("[FR-E2E-a] chat_add_friend → {add}");
    ck(add["status"].as_str() == Some("out-pending"), "本地乐观态 out-pending（无服务器回执）", &add.to_string());
    let row = friend_row(&b_root).await.expect("A 好友行缺失");
    ck(row["status"].as_str() == Some("out-pending"), "A 侧好友行 out-pending", &row.to_string());
    sig_write("s_added.json", &json!({ "from": me, "to": b_root }));

    // ── ③ 等 B 收 request（B 侧 in-pending 由信号 b_got_request.json 确认）→ 放行 B accept ──
    sig_wait("b_got_request.json", 90).await;
    sig_write("s_accept.json", &json!({}));

    // ── ④ 等 B accept 直推到达：A 侧 out-pending → ok + "你们已成为好友"系统条 ──
    let ok_row = wait_friend_row(&b_root, "A 侧 ok（accept 直推转正）", |f| f["status"].as_str() == Some("ok"), 60).await;
    println!("[FR-E2E-a] A 侧转正行 {ok_row}");
    // 系统条（发起方等待转正的会话凭据；msgId 固定幂等）
    let conv_did = b_root.replace([':', '/'], "_");
    let mut sys_hit = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while std::time::Instant::now() < deadline {
        let rows = myco_home_lib::chat_service::conv_load_raw(&conv_did);
        if rows.iter().any(|m| {
            m["msgId"].as_str() == Some(format!("sys-friend-ok-{b_root}").as_str())
                && m["kind"].as_str() == Some("sys")
                && m.pointer("/payload/text").and_then(|t| t.as_str()).unwrap_or("").contains("你们已成为好友")
        }) {
            sys_hit = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    ck(sys_hit, "A 侧会话凭据系统条「你们已成为好友」", &format!("conv={conv_did}"));
    sig_write("a_ok.json", &json!({ "status": "ok" }));

    // ── ⑤ B remove 直推到达：A 侧行+会话被清（friend-remove 语义）──
    let mut gone = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(45);
    while std::time::Instant::now() < deadline {
        if friend_row(&b_root).await.is_none() {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    ck(gone, "A 侧好友行已消失（B remove 直推 → 清行+会话）", &b_root);
    let conv_rows = myco_home_lib::chat_service::conv_load_raw(&conv_did);
    ck(conv_rows.is_empty(), "A 侧会话已清（friend-remove 连带）", &format!("rows={}", conv_rows.len()));
    sig_write("a_removed.json", &json!({}));
    println!("[FR-E2E-a] 🎉 好友握手 E2E（A 侧）PASS");
}

// ═══════════════════════ 实例 B（被加方） ═══════════════════════

async fn run_b() {
    boot().await;

    // ── ① 建号（**不起 p2p 服务器/不上 presence**——①段逼 A 走信箱兜底）──
    let info = core_id::account_create(Some("好友E2E-乙".into()), None, None, None)
        .await
        .expect("建号失败（本地 identity-svc 未起？）");
    let me = info.root_did.clone();
    println!("[FR-E2E-b] 建号 rootDid={me}");
    sig_write("b_ready.json", &json!({ "rootDid": me }));
    let a = sig_wait("s_added.json", 90).await;
    let a_root = a["from"].as_str().unwrap_or("").to_string();

    // ── ② 轮询信箱直到好友请求落地（验签+名册归属+状态机全链）──
    let mut got = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    while std::time::Instant::now() < deadline {
        let _ = chat_poll().await;
        if let Some(f) = friend_row(&a_root).await {
            if f["status"].as_str() == Some("in-pending") {
                println!("[FR-E2E-b] B 侧收到请求行 {f}");
                ck(f["name"].as_str().map(|n| !n.is_empty()).unwrap_or(false), "请求行带发起方名字", &f.to_string());
                got = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
    ck(got, "B 收 friend-request（信箱兜底→poll→验签→in-pending）", &a_root);
    sig_write("b_got_request.json", &json!({ "from": a_root, "to": me }));

    // ── ③ B accept：起 p2p 服务器 + 上 presence → accept 走 P2P 直推 ──
    sig_wait("s_accept.json", 60).await;
    tokio::spawn(async { start_p2p_server_for_test().await });
    for _ in 0..40 {
        if p2p_port() > 0 { break; }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    ck(p2p_port() > 0, "B p2p 服务器已启动（②段直推面）", &format!("port={}", p2p_port()));
    let _hb = spawn_heartbeat();
    presence::refresh().await;
    chat_accept_friend(a_root.clone()).await.expect("chat_accept_friend 失败");
    let row = wait_friend_row(&a_root, "B 侧 ok", |f| f["status"].as_str() == Some("ok"), 30).await;
    println!("[FR-E2E-b] B 侧接受后行 {row}");
    ck(row["status"].as_str() == Some("ok"), "B accept 本地 ok", &row.to_string());
    sig_write("b_accepted.json", &json!({}));

    // ── ④ 等 A 转正确认后 remove：直推 friend-remove ──
    sig_wait("a_ok.json", 90).await;
    chat_remove_friend(a_root.clone()).await.expect("chat_remove_friend 失败");
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let mut b_gone = false;
    while std::time::Instant::now() < deadline {
        if friend_row(&a_root).await.is_none() {
            b_gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    ck(b_gone, "B remove 后本地行已清", "");
    sig_write("b_removed.json", &json!({}));
    println!("[FR-E2E-b] 🎉 好友握手 E2E（B 侧）PASS");
}

fn main() {
    let rt = tokio::runtime::Runtime::new().expect("tokio rt");
    let r = role();
    println!("[FR-E2E-{r}] 启动：cfg={} p2p_port_base={} id_base={}",
        std::env::var("MYCO_CONFIG_DIR").unwrap_or_default(),
        std::env::var("MYCO_P2P_PORT").unwrap_or_default(),
        std::env::var("MYCO_DID_BASE").unwrap_or_default());
    rt.block_on(async {
        if r == "b" {
            run_b().await;
        } else {
            run_a().await;
        }
    });
}
