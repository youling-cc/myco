//! device_group_e2e.rs — 设备群双实例 E2E（docs/design/设备群设计.md §4 T5 验收链）。
//!
//! 验收链：建号（实例A）→ 收编成员（实例B）→ 设备群自动出现（双端各自 ensure）→
//! 群发消息（他机消息署名=设备名不是「我」——公会场景成败点）→ 传文件（10MB 内）→
//! 吊销成员 → 不可达验证。
//!
//! 三进程对拍（p2p_e2e.rs 的双 bin 思路 + 共享目录信号文件同步时序）：
//!   ① 本地 identity-svc：PORT=18321 DB_PATH=<临时> node services/identity-svc/identity-server.mjs
//!      （**绝不碰生产 myco.youling.cc**——本 bin 启动即硬闸：MYCO_DID_BASE 非本机即拒跑）
//!   ② 实例 A（主设备）：DG_E2E_ROLE=a MYCO_CONFIG_DIR=<dir>\cfgA MYCO_P2P_PORT=9130
//!                     COMPUTERNAME=DEVGRP-E2E-A MYCO_DID_BASE=http://127.0.0.1:18321
//!   ③ 实例 B（成员设备）：DG_E2E_ROLE=b ... cfgB / 9135 / DEVGRP-E2E-B
//!   双端 DG_E2E_DIR 指同一共享目录（信号文件 a_*.json / b_*.json / s_*.json 对拍）。
//!
//! MYCO_CONFIG_DIR 分桶 = identity 域隔离（设备钥/账号槽/chat 桶全分开）；主 exe 单实例
//! 锁不影响本 bin（无 GUI 无锁，p2p_e2e 同理）。
//!
//! B 侧收编取件说明：GUI 常驻的 start_delegation_watch 需要 AppHandle（bin 无窗口），
//! 这里用同一批 pub 函数复刻 watch_tick_inner 的 Accepted 副作用序列
//! （watch_probe_at 真链探测 + accept_received + accounts_upsert + account_switch），
//! 设备群 ensure 走挂点①（chat_state→state_snapshot→ensure_device_group_for）——产线同路径。
//!
//! 吊销后两段不可达验证（决策 C/§5.3 语义）：
//!   Ⅰ B 登出（account_logout，成员离场的产线路径）后：A 直推被 B 侧好友闸 fail-closed
//!     拒收（403）→ sendState=sending，B 本地无该消息；
//!   Ⅱ B 停 presence 心跳 + 等 90s TTL 出表后：A 账号寻址落空 → T3 兜底查名册 →
//!     revoked 设备被 roster_fallback_devices 跳过 → sendState=sending。
//! 另设「实况观察」段：吊销后 B 仍登录+心跳时 A 直推的到达情况（预期仍达——B 侧归属闸
//! 验的是发送方；设计依赖 presence 出表/B 自清，如实记录不硬断言）。

use base64::Engine as _;
use myco_core::delegation::Delegations;
use myco_core::identity as core_id;
use myco_home_lib::chat_service::{chat_device_group_info, chat_send_group, chat_state, conv_load_raw};
use myco_home_lib::identity_service::{add_device_by_did, device_revoke, watch_probe_at, WatchOutcome};
use myco_home_lib::p2p_server::{p2p_port, start_p2p_server_for_test};
use myco_home_lib::presence;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn role() -> String {
    std::env::var("DG_E2E_ROLE").unwrap_or_else(|_| "a".into())
}

fn b64e(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn sha256_hex(b: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(b);
    let out = h.finalize();
    out.iter().map(|x| format!("{x:02x}")).collect()
}

fn did_safe(did: &str) -> String {
    did.replace([':', '/'], "_")
}

/// 断言即报告：过打 ✅、败打 ❌ 后 panic（进程非零退出，orchestrator 靠退出码判）。
fn ck(cond: bool, name: &str, detail: &str) {
    if cond {
        println!("[DG-E2E-{}] ✅ {}", role(), name);
    } else {
        println!("[DG-E2E-{}] ❌ {} —— {}", role(), name, detail);
        panic!("E2E 断言失败: {name} —— {detail}");
    }
}

fn shared_dir() -> PathBuf {
    PathBuf::from(std::env::var("DG_E2E_DIR").expect("必须设 DG_E2E_DIR（双端同一共享信号目录）"))
}

fn sig_write(name: &str, v: &Value) {
    let p = shared_dir().join(name);
    std::fs::write(&p, serde_json::to_string_pretty(v).unwrap()).expect("写信号文件失败");
    println!("[DG-E2E-{}] → 信号 {} 已写", role(), name);
}

/// 等信号文件出现（500ms 轮询；超时 panic 带上下文）。
async fn sig_wait(name: &str, timeout_secs: u64) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        let p = shared_dir().join(name);
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str(&s) {
                println!("[DG-E2E-{}] ← 信号 {} 已收", role(), name);
                return v;
            }
        }
        if std::time::Instant::now() > deadline {
            panic!("等待信号 {name} 超时（{timeout_secs}s）——对端实例未按预期推进");
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// 轮询本机会话（conv_load_raw）直到出现满足谓词的行；超时 panic。
async fn wait_conv_row(conv: &str, name: &str, pred: impl Fn(&Value) -> bool, timeout_secs: u64) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        if let Some(m) = conv_load_raw(conv).into_iter().find(|m| pred(m)) {
            println!("[DG-E2E-{}] ✅ 会话 {name} 行已到达", role());
            return m;
        }
        if std::time::Instant::now() > deadline {
            panic!("等待会话行 {name} 超时（{timeout_secs}s）");
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// 直读会话 jsonl 文件（登出后 chat 桶切 _guest、conv_load_raw 读不到原桶——
/// 「不可达」缺席断言必须看真实落盘文件）。行解析失败跳过该行。
fn conv_rows_via_file(cfg: &str, storage_account: &str, conv: &str) -> Vec<Value> {
    let p = PathBuf::from(cfg)
        .join("chat")
        .join(did_safe(storage_account))
        .join(format!("{conv}.jsonl"));
    let s = std::fs::read_to_string(&p).unwrap_or_default();
    s.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// 本机设备 (did, pub b64)。
fn dev_identity() -> (String, String) {
    let (did, seed_b64) = core_id::device_identity().expect("设备身份就绪失败");
    let seed = base64::engine::general_purpose::STANDARD
        .decode(&seed_b64)
        .expect("种子 b64 解码");
    let arr: [u8; 32] = seed.try_into().expect("种子 32B");
    let sk = ed25519_dalek::SigningKey::from_bytes(&arr);
    (did, b64e(&sk.verifying_key().to_bytes()))
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "myco-pc".into())
}

fn my_cfg_dir() -> String {
    std::env::var("MYCO_CONFIG_DIR").expect("必须设 MYCO_CONFIG_DIR（identity 域分桶）")
}

/// presence 心跳循环（10s < 90s TTL）。返回停止开关（final 段拔线用）。
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

/// 启动前置（双角色共用）：环境硬闸（绝不碰生产/绝不碰活登录器目录）+ p2p 服务器。
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
    tokio::spawn(async { start_p2p_server_for_test().await });
    for _ in 0..40 {
        if p2p_port() > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    ck(p2p_port() > 0, "p2p 服务器已启动", &format!("port={}", p2p_port()));
}

// ═══════════════════════ 实例 A（主设备） ═══════════════════════

async fn run_a() {
    boot().await;
    let (a_dev, a_pub) = dev_identity();
    let a_name = device_name();

    // ── ① 建号（真链 /root/create）──
    let info = core_id::account_create(Some("公会主账号E2E".into()), None, None, None)
        .await
        .expect("建号失败（本地 identity-svc 未起？）");
    let root = info.root_did;
    println!("[DG-E2E-a] 建号 rootDid={}（canonical 出示={}）", root, core_id::account_did().unwrap_or_default());
    ck(
        core_id::account_did().map(|d| core_id::account_did_eq(&d, &root)) == Some(true),
        "建号后 account_did=rootDid",
        &format!("{root}"),
    );
    let heartbeat = spawn_heartbeat();
    presence::refresh().await;
    let gid = format!("grp-dev-{}", did_safe(&core_id::account_did_canonical(&root)));
    sig_write(
        "a_ready.json",
        &json!({ "rootDid": root, "aDeviceDid": a_dev, "aPub": a_pub, "aName": a_name, "gid": gid }),
    );

    // ── ② 收编成员 B（真链 attest + 委任状投递 + P2P 收编通知）──
    let b = sig_wait("b_ready.json", 90).await;
    let b_dev = b["bDeviceDid"].as_str().unwrap_or("").to_string();
    let b_name = b["bName"].as_str().unwrap_or("").to_string();
    let b_pub = b["bPub"].as_str().unwrap_or("").to_string();
    let add = add_device_by_did(b_dev.clone(), b_name.clone(), None).await;
    match &add {
        Ok(v) => println!("[DG-E2E-a] 收编 B 成功 delegationDelivered={}", v["delegationDelivered"]),
        Err(e) => panic!("收编 B 失败: {e}"),
    }
    ck(add.is_ok(), "add_device_by_did（attest+委任状）成功", "");

    // ── ③ B 侧收编完成（取委任状→账号就位→设备群 ensure）──
    let bm = sig_wait("b_member.json", 120).await;
    ck(
        bm["gid"].as_str() == Some(gid.as_str()),
        "双端派生出同一设备群 id（canonical 归一）",
        &format!("A={gid} B={}", bm["gid"].as_str().unwrap_or("?")),
    );

    // ── ④ A 侧设备群自动出现（挂点① chat_state→ensure）──
    let snap = chat_state().await.expect("chat_state 失败");
    let g = snap["groups"]
        .as_array()
        .and_then(|gs| gs.iter().find(|g| g["id"].as_str() == Some(gid.as_str())).cloned())
        .unwrap_or(Value::Null);
    ck(!g.is_null(), "A 侧设备群档案已建", &gid);
    ck(g["kind"].as_str() == Some("device"), "群档案 kind=device", &g.to_string());
    ck(
        g["members"].to_string() == json!([root.clone()]).to_string(),
        "成员恒 [rootDid]（真成员表=名册）",
        &g["members"].to_string(),
    );
    ck(g["name"].as_str() == Some("设备群"), "群名=设备群", &g["name"].to_string());
    let init = conv_load_raw(&gid)
        .into_iter()
        .find(|m| m["msgId"].as_str() == Some(format!("devgrp-init-{gid}").as_str()));
    ck(init.is_some(), "开群系统条（确定性 msgId）", "");

    // ── ⑤ chat_device_group_info 真链（本地 identity-svc /presence/by-root + presence）──
    let mut info_v = Value::Null;
    for _ in 0..30 {
        if let Ok(v) = chat_device_group_info().await {
            info_v = v;
            let b_row = info_v["devices"].as_array().and_then(|ds| {
                ds.iter().find(|d| d["pubkeyB64"].as_str() == Some(b_pub.as_str())).cloned()
            });
            if let Some(r) = b_row {
                if r["online"].as_bool() == Some(true) && r["revoked"].as_bool() == Some(false) {
                    break;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
    let b_row = info_v["devices"].as_array().and_then(|ds| {
        ds.iter().find(|d| d["pubkeyB64"].as_str() == Some(b_pub.as_str())).cloned()
    });
    ck(b_row.is_some(), "group_info 名册含 B 设备", &info_v.to_string());
    let b_row = b_row.unwrap();
    ck(b_row["revoked"].as_bool() == Some(false), "B revoked=false（在册成员）", &b_row.to_string());
    ck(b_row["online"].as_bool() == Some(true), "B online=true（presence 已带 rootDid）", &b_row.to_string());
    let a_row = info_v["devices"].as_array().and_then(|ds| {
        ds.iter().find(|d| d["pubkeyB64"].as_str() == Some(a_pub.as_str())).cloned()
    });
    ck(
        a_row.as_ref().and_then(|r| r["isEmbodiment"].as_bool()) == Some(true),
        "A isEmbodiment=true（主设备）",
        &a_row.unwrap_or_default().to_string(),
    );

    // ── ⑥ 群发消息（A→设备群）：A 侧 out + 「我」锚点 ──
    let text = format!("设备群第一条（A→全员）ts={}", now_ms());
    let r = chat_send_group(gid.clone(), json!({ "text": text })).await.expect("群发失败");
    let msg1 = r["msgId"].as_str().unwrap_or("").to_string();
    ck(r["sendState"].as_str() == Some("sent"), "群发 sendState=sent（B 在线直推）", &r.to_string());
    let out_row = wait_conv_row(&gid, "A 侧 out 行", |m| m["msgId"].as_str() == Some(msg1.as_str()), 10).await;
    ck(out_row["dir"].as_str() == Some("out"), "A 侧本机消息 dir=out（「我」）", &out_row.to_string());
    ck(
        out_row["fromDeviceName"].as_str() == Some(a_name.as_str()),
        "A 侧 out 行署名=本机设备名",
        &out_row.to_string(),
    );
    sig_write("s_text.json", &json!({ "msgId": msg1, "text": text, "expectDevice": a_dev, "expectName": a_name }));

    // ── ⑦ 传文件（群 file 内联 b64，8MB 随机——10MB 内贴近上限）──
    let mut bytes = vec![0u8; 8 * 1024 * 1024];
    for (i, b) in bytes.iter_mut().enumerate() {
        // 确定性伪随机（不引 rand 依赖语义歧义）：xorshift 流
        *b = ((i as u64 * 2654435761 + 0x9E3779B9) >> 24) as u8;
    }
    let (fname, sha) = ("e2e-8mb.bin".to_string(), sha256_hex(&bytes));
    let size = bytes.len();
    let r = chat_send_group(
        gid.clone(),
        json!({ "name": fname, "mime": "application/octet-stream", "size": size, "b64": b64e(&bytes) }),
    )
    .await
    .expect("群文件发送失败");
    let msg2 = r["msgId"].as_str().unwrap_or("").to_string();
    ck(r["sendState"].as_str() == Some("sent"), "8MB 群文件 sendState=sent", &r["sendState"].to_string());
    sig_write("s_file.json", &json!({ "msgId": msg2, "name": fname, "size": size, "sha256": sha }));

    // ── ⑧ B→A 反向群发（对称验证：A 收到 in 且署名=B 设备名）──
    sig_write("s_reverse.json", &json!({}));
    let br = sig_wait("b_reverse_ok.json", 60).await;
    let rev_id = br["msgId"].as_str().unwrap_or("").to_string();
    let rev_row =
        wait_conv_row(&gid, "A 侧收 B 反向消息", |m| m["msgId"].as_str() == Some(rev_id.as_str()), 15).await;
    ck(
        rev_row["dir"].as_str() == Some("in"),
        "B 发来的群消息 A 侧 dir=in（fromDevice 判向，不再误判「我」）",
        &rev_row.to_string(),
    );
    ck(
        rev_row["fromDeviceName"].as_str() == Some(br["bName"].as_str().unwrap_or("?")),
        "A 侧他机消息署名=B 设备名（公会场景成败点）",
        &rev_row.to_string(),
    );
    ck(
        rev_row["fromDevice"].as_str() == Some(br["bDeviceDid"].as_str().unwrap_or("?")),
        "A 侧他机消息 fromDevice=B 设备 did",
        &rev_row.to_string(),
    );

    // ── ⑨ 吊销 B ──
    let rv = device_revoke(b_dev.clone()).await.expect("吊销失败");
    let _ = rv;
    println!("[DG-E2E-a] device_revoke(B) 完成");
    sig_write("s_revoked.json", &json!({ "bDeviceDid": b_dev }));

    // ── ⑩ 名册真链：B revoked=true（group_info 15s 缓存过期后）──
    let bp = sig_wait("b_probe_result.json", 60).await;
    ck(
        bp["outcome"].as_str() == Some("NotOnRoster"),
        "吊销后 B 侧名册反查 NotOnRoster（/device 404，除名传播）",
        &bp.to_string(),
    );
    let mut revoked_seen = false;
    for _ in 0..25 {
        if let Ok(v) = chat_device_group_info().await {
            if let Some(r) = v["devices"].as_array().and_then(|ds| {
                ds.iter().find(|d| d["pubkeyB64"].as_str() == Some(b_pub.as_str())).cloned()
            }) {
                if r["revoked"].as_bool() == Some(true) {
                    revoked_seen = true;
                    break;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
    ck(revoked_seen, "group_info 真链显示 B revoked=true", "");

    // ── ⑪ 实况观察：吊销后 B 仍登录+心跳——A 直推是否仍达（不硬断言，如实记录）──
    let text3 = format!("吊销后实况观察 ts={}", now_ms());
    let r = chat_send_group(gid.clone(), json!({ "text": text3 })).await.expect("群发失败");
    let msg3 = r["msgId"].as_str().unwrap_or("").to_string();
    println!(
        "[DG-E2E-a] 👀 实况：吊销后 B 仍在线心跳，sendState={}（预期 sent——直推可达；不可达靠 Ⅰ/Ⅱ 段验证）",
        r["sendState"].as_str().unwrap_or("?")
    );
    sig_write("s_post_revoke1.json", &json!({ "msgId": msg3 }));
    let reality = sig_wait("b_reality.json", 60).await;
    println!(
        "[DG-E2E-a] 👀 实况记录：吊销后未自清的 B 是否仍收到 = {}",
        reality["received"].as_bool().unwrap_or(false)
    );

    // ── Ⅰ 不可达：B 登出（成员离场产线路径）→ A 直推被 B 闸拒收 ──
    sig_write("s_logout.json", &json!({}));
    sig_wait("b_logged_out.json", 60).await;
    let text4 = format!("吊销+登出后不可达验证 ts={}", now_ms());
    let r = chat_send_group(gid.clone(), json!({ "text": text4 })).await.expect("群发失败");
    let msg4 = r["msgId"].as_str().unwrap_or("").to_string();
    ck(
        r["sendState"].as_str() == Some("sending"),
        "B 登出后群发 sendState=sending（B 侧闸 403，投递失败入离线队列）",
        &r.to_string(),
    );
    sig_write("s_post_revoke2.json", &json!({ "msgId": msg4 }));
    sig_wait("b_unreachable_ok.json", 60).await;

    // ── Ⅱ 不可达：B 停心跳 90s TTL 出表 → 账号寻址落空 → T3 兜底跳过 revoked ──
    sig_write("s_stop_heartbeat.json", &json!({}));
    sig_wait("b_heartbeat_stopped.json", 30).await;
    println!("[DG-E2E-a] 等 presence TTL 92s（B 出表）……");
    tokio::time::sleep(Duration::from_secs(92)).await;
    let text5 = format!("TTL 出表+兜底跳过 revoked 验证 ts={}", now_ms());
    let r = chat_send_group(gid.clone(), json!({ "text": text5 })).await.expect("群发失败");
    let msg5 = r["msgId"].as_str().unwrap_or("").to_string();
    ck(
        r["sendState"].as_str() == Some("sending"),
        "B 出表后群发 sendState=sending（账号寻址落空+兜底跳过 revoked 设备）",
        &r.to_string(),
    );
    sig_write("s_final_check.json", &json!({ "msgId": msg5 }));
    sig_wait("b_final_ok.json", 60).await;
    let _ = heartbeat;
    println!("[DG-E2E-a] 🎉 设备群双实例 E2E 全链 PASS");
}

// ═══════════════════════ 实例 B（成员设备） ═══════════════════════

async fn run_b() {
    boot().await;
    let (b_dev, b_pub) = dev_identity();
    let b_name = device_name();
    let base = std::env::var("MYCO_DID_BASE").unwrap_or_default();
    let cfg = my_cfg_dir();

    // ── ① 设备身份在线（presence 无 rootDid——未收编态）──
    let heartbeat = spawn_heartbeat();
    presence::refresh().await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    sig_write("b_ready.json", &json!({ "bDeviceDid": b_dev, "bPub": b_pub, "bName": b_name }));

    // ── ② 收编取件环（watch_probe_at 真链：名册反查+委任状取件+验签+nonce）──
    let accepted: (String, Value);
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    loop {
        match watch_probe_at(&base, &b_pub, |root| {
            Delegations::load().has_valid_for(root, &b_pub)
        })
        .await
        {
            Ok(WatchOutcome::Accepted { root_did, name, delegation }) => {
                accepted = (root_did, json!({ "name": name, "delegation": delegation }));
                break;
            }
            Ok(_) => {}
            Err(e) => println!("[DG-E2E-b] probe 错误（重试）: {e}"),
        }
        if std::time::Instant::now() > deadline {
            panic!("120s 内未被收编（A 侧 add_device 未跑？）");
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    let (root, meta) = accepted;
    println!("[DG-E2E-b] 取到委任状：root={} name={}", root, meta["name"].as_str().unwrap_or("?"));
    // Accepted 副作用序列（= watch_tick_inner 同款；GUI 通知/emit 除外）
    let del = serde_json::from_value::<myco_core::delegation::Delegation>(meta["delegation"].clone())
        .expect("委任状反序列化");
    Delegations::load().accept_received(del);
    core_id::accounts_upsert(&root, meta["name"].as_str().unwrap_or("有灵账号"));
    // 成员设备激活账号（UI 点账号即此路径；active.txt 就位后 account_did=rootDid）
    let sw = core_id::account_switch(root.clone()).expect("account_switch 失败");
    ck(sw["role"].as_str() == Some("agent"), "B 角色切换为 agent（委任状分身）", &sw.to_string());
    ck(
        core_id::account_did().map(|d| core_id::account_did_eq(&d, &root)) == Some(true),
        "B 的 account_did=rootDid（同账号多设备支点）",
        &core_id::account_did().unwrap_or_default(),
    );

    // ── ③ 设备群自动出现（挂点① chat_state→ensure；B 独立派生）──
    let snap = chat_state().await.expect("chat_state 失败");
    let gid = format!("grp-dev-{}", did_safe(&core_id::account_did_canonical(&root)));
    let g = snap["groups"]
        .as_array()
        .and_then(|gs| gs.iter().find(|g| g["id"].as_str() == Some(gid.as_str())).cloned())
        .unwrap_or(Value::Null);
    ck(!g.is_null(), "B 侧设备群档案已建（本地幂等 ensure）", &gid);
    ck(g["kind"].as_str() == Some("device"), "B 侧群档案 kind=device", &g.to_string());
    presence::refresh().await; // 立即带 rootDid 重报（A 侧 group_info 断言 online 依赖它）
    tokio::time::sleep(Duration::from_millis(500)).await;
    sig_write("b_member.json", &json!({ "rootDid": root, "gid": gid }));

    // ── ④ 收 A 群发：dir=in + 署名=A 设备名（信封 fromDevice/fromDeviceName 实况）──
    let st = sig_wait("s_text.json", 120).await;
    let msg1 = st["msgId"].as_str().unwrap_or("").to_string();
    let row =
        wait_conv_row(&gid, "A 群发 in 行", |m| m["msgId"].as_str() == Some(msg1.as_str()), 30).await;
    println!("[DG-E2E-b] 👀 信封透实行（B 侧落盘全行）: {}", &row.to_string()[..row.to_string().len().min(400)]);
    ck(row["dir"].as_str() == Some("in"), "他机消息 dir=in（不显示成「我」——T2 语义）", &row.to_string());
    ck(
        row["fromDevice"].as_str() == Some(st["expectDevice"].as_str().unwrap_or("?")),
        "B 侧 fromDevice=A 设备 did（信封透传）",
        &row.to_string(),
    );
    let fdn = row["fromDeviceName"].as_str().unwrap_or("").to_string();
    ck(
        fdn == st["expectName"].as_str().unwrap_or("?"),
        "B 侧署名=A 设备名（fromDeviceName 信封实况——公会场景成败点）",
        &fdn,
    );
    ck(
        row["fromName"].as_str().is_some() && row["fromName"].as_str() != Some(fdn.as_str()),
        "署名=设备名 ≠ 账号名（fromName 仍为账号名，双字段分明）",
        &row["fromName"].to_string(),
    );
    sig_write("b_text_ok.json", &json!({ "msgId": msg1 }));

    // ── ⑤ 收 A 群文件：file 行 + 字节落盘 + sha256 一致 ──
    let sf = sig_wait("s_file.json", 120).await;
    let msg2 = sf["msgId"].as_str().unwrap_or("").to_string();
    let frow =
        wait_conv_row(&gid, "A 群文件行", |m| m["msgId"].as_str() == Some(msg2.as_str()), 30).await;
    ck(frow["kind"].as_str() == Some("file"), "群文件行 kind=file", &frow.to_string());
    let media_rel = frow.pointer("/payload/media").and_then(|v| v.as_str()).unwrap_or("").to_string();
    ck(!media_rel.is_empty(), "群文件 media 引用已落盘", &frow["payload"].to_string());
    let media_path = PathBuf::from(&cfg)
        .join("chat")
        .join(did_safe(&core_id::account_did_storage().unwrap_or_default()))
        .join(&media_rel);
    let got = std::fs::read(&media_path).unwrap_or_default();
    ck(
        !got.is_empty() && sha256_hex(&got) == sf["sha256"].as_str().unwrap_or(""),
        "8MB 群文件字节完整到达（sha256 一致）",
        &format!("path={} got={}B", media_path.display(), got.len()),
    );
    ck(
        got.len() == sf["size"].as_u64().unwrap_or(0) as usize,
        "文件字节数一致",
        &format!("{}B", got.len()),
    );
    ck(
        frow["fromDeviceName"].as_str() == Some(st["expectName"].as_str().unwrap_or("?")),
        "文件行也带设备署名",
        &frow.to_string(),
    );
    sig_write("b_file_ok.json", &json!({ "msgId": msg2 }));

    // ── ⑥ B→A 反向群发 ──
    sig_wait("s_reverse.json", 60).await;
    let rev_text = format!("B→设备群反向 ts={}", now_ms());
    let r = chat_send_group(gid.clone(), json!({ "text": rev_text })).await.expect("B 群发失败");
    let rev_id = r["msgId"].as_str().unwrap_or("").to_string();
    ck(r["sendState"].as_str() == Some("sent"), "B 群发 sendState=sent", &r.to_string());
    let out_row = wait_conv_row(&gid, "B 侧 out 行", |m| m["msgId"].as_str() == Some(rev_id.as_str()), 10).await;
    ck(out_row["dir"].as_str() == Some("out"), "B 侧本机消息 dir=out", &out_row.to_string());
    sig_write(
        "b_reverse_ok.json",
        &json!({ "msgId": rev_id, "text": rev_text, "bDeviceDid": b_dev, "bName": b_name }),
    );

    // ── ⑦ 吊销自查：名册反查应 NotOnRoster ──
    sig_wait("s_revoked.json", 60).await;
    let mut outcome = String::new();
    for _ in 0..10 {
        match watch_probe_at(&base, &b_pub, |root| {
            Delegations::load().has_valid_for(root, &b_pub)
        })
        .await
        {
            Ok(WatchOutcome::NotOnRoster) => {
                outcome = "NotOnRoster".into();
                break;
            }
            Ok(WatchOutcome::AlreadySettled { .. }) => outcome = "AlreadySettled".into(),
            Ok(WatchOutcome::MailboxEmpty { .. }) => outcome = "MailboxEmpty".into(),
            Ok(_) => outcome = "Accepted".into(),
            Err(e) => outcome = format!("Err:{e}"),
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    sig_write("b_probe_result.json", &json!({ "outcome": outcome }));

    // ── ⑧ 实况观察：吊销后（仍登录+心跳）A 的直推是否到达 ──
    let sp = sig_wait("s_post_revoke1.json", 60).await;
    let msg3 = sp["msgId"].as_str().unwrap_or("").to_string();
    tokio::time::sleep(Duration::from_secs(3)).await;
    let got_it = conv_load_raw(&gid).iter().any(|m| m["msgId"].as_str() == Some(msg3.as_str()));
    println!(
        "[DG-E2E-b] 👀 实况记录：吊销后（B 未自清、仍登录心跳）A 直推到达 = {got_it}（设计依赖 presence 出表/B 自清，如实记录）"
    );
    sig_write("b_reality.json", &json!({ "received": got_it, "msgId": msg3 }));

    // ── Ⅰ 登出（成员离场产线路径）→ 断言 A 的下一条不可达 ──
    sig_wait("s_logout.json", 60).await;
    let lo = core_id::account_logout().await.expect("account_logout 失败");
    let _ = lo;
    ck(core_id::account_did().is_none(), "登出后 account_did=None（回未登录）", "");
    presence::refresh().await; // 不带 rootDid 重报（服务端 prev.rootId 粘滞——如实，靠闸拦）
    sig_write("b_logged_out.json", &json!({}));

    let sp2 = sig_wait("s_post_revoke2.json", 60).await;
    let msg4 = sp2["msgId"].as_str().unwrap_or("").to_string();
    tokio::time::sleep(Duration::from_secs(3)).await;
    let rows4 = conv_rows_via_file(&cfg, &root, &gid);
    ck(
        !rows4.iter().any(|m| m["msgId"].as_str() == Some(msg4.as_str())),
        "B 登出后未收到 A 群发（闸 fail-closed，本地无该行）",
        &format!("rows={}", rows4.len()),
    );
    sig_write("b_unreachable_ok.json", &json!({ "msgId": msg4 }));

    // ── Ⅱ 停心跳 → TTL 出表 → 断言兜底不可达 ──
    sig_wait("s_stop_heartbeat.json", 60).await;
    heartbeat.store(true, Ordering::Relaxed);
    println!("[DG-E2E-b] presence 心跳已停（等 90s TTL 出表）");
    sig_write("b_heartbeat_stopped.json", &json!({}));

    let sp5 = sig_wait("s_final_check.json", 240).await;
    let msg5 = sp5["msgId"].as_str().unwrap_or("").to_string();
    tokio::time::sleep(Duration::from_secs(3)).await;
    let rows5 = conv_rows_via_file(&cfg, &root, &gid);
    ck(
        !rows5.iter().any(|m| m["msgId"].as_str() == Some(msg5.as_str())),
        "B 出表+revoked 后未收到（兜底跳过 revoked，本地无该行）",
        &format!("rows={}", rows5.len()),
    );
    sig_write("b_final_ok.json", &json!({ "msgId": msg5 }));
    println!("[DG-E2E-b] 🎉 设备群双实例 E2E 全链 PASS");
}

fn main() {
    let rt = tokio::runtime::Runtime::new().expect("tokio rt");
    let r = role();
    println!("[DG-E2E-{r}] 启动：cfg={} p2p_port_base={} id_base={}",
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
