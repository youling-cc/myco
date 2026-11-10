//! matrix_e2e.rs — 三端互测矩阵 bin（tests/三端互测回归指南.md 的 Windows 载体）。
//!
//! device_group_e2e（双实例）/ friend_e2e（双实例）思路的**可配置 N 实例**泛化：
//! 角色（MX_ROLE）× 成员编号（MX_ID）× 成员数（MX_MEMBERS），信号文件对拍
//! （orchestrator = tests/matrix/run-matrix.mjs，共享目录 MX_DIR）。
//!
//! 场景 → 角色矩阵：
//!   M1 加设备（收编，1+N 实例，Windows 多实例）：
//!     founder：建号 → 收编 N 个 member → 设备群档案/名册断言 → 群发（全员
//!              在线直推 sendState=sent）→ 等各成员「dir=in+署名」回执。
//!     member(i)：presence 上线 → watch_probe 真链取委任状 → role=agent +
//!              account_did=rootDid → 设备群本地幂等出现 → 收群发断言。
//!   M2 加主账号（恢复码导入，2 实例）：
//!     exporter：建号 → account_export_seed → 信号投递 → 等导入回执 →
//!              名册含 importer 设备（恢复码通道=设备入册真链）。
//!     importer：account_import(seed) → 同 did 身份延续 + role=embodiment。
//!   M4 跨端收编（Win founder ↔ Android PWA / Linux cli 外部端）：
//!     xfounder：建号 → 读外部端信号（phone_ready/linux_ready——由 playwright
//!              PWA 脚本与 WSL cli 脚本写）→ add_device_by_did 收编 → 名册断言
//!              → 群发一条（直推/信箱两路实况记录）→ 等外部端到达回执。
//!
//! 与 device_group_e2e 的差异：成员数参数化、M2/M4 场景、不做吊销/不可达段
//! （那是 device_group_e2e 的专属验收链，两 bin 互补不重复）。
//!
//! 三进程对拍环境（orchestrator 负责，bin 自身只硬闸安全前提）：
//!   本地 identity-svc：PORT=18421 DB_PATH=<临时> node services/identity-svc/identity-server.mjs
//!   每实例独立 MYCO_CONFIG_DIR + MYCO_P2P_PORT + COMPUTERNAME + 同一 MYCO_DID_BASE。
//!   **绝不碰生产 myco.youling.cc**——启动即硬闸：MYCO_DID_BASE 非本机即拒跑。

use base64::Engine as _;
use myco_core::delegation::Delegations;
use myco_core::identity as core_id;
use myco_home_lib::chat_service::{chat_device_group_info, chat_send_group, chat_state, conv_load_raw};
use myco_home_lib::identity_service::{add_device_by_did, watch_probe_at, WatchOutcome};
use myco_home_lib::p2p_server::{p2p_port, start_p2p_server_for_test};
use myco_home_lib::presence;
use serde_json::{json, Value};
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
    std::env::var("MX_ROLE").unwrap_or_else(|_| "founder".into())
}

fn member_id() -> String {
    std::env::var("MX_ID").unwrap_or_else(|_| "b".into())
}

fn member_count() -> usize {
    std::env::var("MX_MEMBERS").ok().and_then(|s| s.parse().ok()).unwrap_or(2)
}

fn b64e(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn did_safe(did: &str) -> String {
    did.replace([':', '/'], "_")
}

/// 断言即报告：过打 ✅、败打 ❌ 后 panic（进程非零退出，orchestrator 靠退出码判）。
fn ck(cond: bool, name: &str, detail: &str) {
    if cond {
        println!("[MX-{}] ✅ {}", role(), name);
    } else {
        println!("[MX-{}] ❌ {} —— {}", role(), name, detail);
        panic!("E2E 断言失败: {name} —— {detail}");
    }
}

fn shared_dir() -> PathBuf {
    PathBuf::from(std::env::var("MX_DIR").expect("必须设 MX_DIR（全体实例同一共享信号目录）"))
}

fn sig_write(name: &str, v: &Value) {
    let p = shared_dir().join(name);
    std::fs::write(&p, serde_json::to_string_pretty(v).unwrap()).expect("写信号文件失败");
    println!("[MX-{}] → 信号 {} 已写", role(), name);
}

/// 等信号文件出现（500ms 轮询；超时 panic 带上下文）。
async fn sig_wait(name: &str, timeout_secs: u64) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        let p = shared_dir().join(name);
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str(&s) {
                println!("[MX-{}] ← 信号 {} 已收", role(), name);
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
            println!("[MX-{}] ✅ 会话 {name} 行已到达", role());
            return m;
        }
        if std::time::Instant::now() > deadline {
            panic!("等待会话行 {name} 超时（{timeout_secs}s）");
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
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

/// 启动前置（全角色共用）：环境硬闸（绝不碰生产/绝不碰活登录器目录）+ p2p 服务器。
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

/// 设备群档案断言（founder/member 共用；本地幂等 ensure 后 chat_state 可见）。
async fn assert_device_group(gid: &str, who: &str) {
    let snap = chat_state().await.expect("chat_state 失败");
    let g = snap["groups"]
        .as_array()
        .and_then(|gs| gs.iter().find(|g| g["id"].as_str() == Some(gid)).cloned())
        .unwrap_or(Value::Null);
    ck(!g.is_null(), &format!("{who} 侧设备群档案已建"), gid);
    ck(g["kind"].as_str() == Some("device"), &format!("{who} 群档案 kind=device"), &g.to_string());
    ck(g["name"].as_str() == Some("设备群"), &format!("{who} 群名=设备群"), &g["name"].to_string());
    let init = conv_load_raw(gid)
        .into_iter()
        .find(|m| m["msgId"].as_str() == Some(format!("devgrp-init-{gid}").as_str()));
    ck(init.is_some(), &format!("{who} 开群系统条（确定性 msgId）"), "");
}

// ═══════════════════════ M1 实例 founder（主设备，收编 N 成员） ═══════════════════════

async fn run_founder() {
    boot().await;
    let (a_dev, a_pub) = dev_identity();
    let a_name = device_name();
    let n = member_count();

    // ── ① 建号（真链 /root/create）──
    let info = core_id::account_create(Some("矩阵E2E主账号".into()), None, None, None)
        .await
        .expect("建号失败（本地 identity-svc 未起？）");
    let root = info.root_did;
    ck(
        core_id::account_did().map(|d| core_id::account_did_eq(&d, &root)) == Some(true),
        "建号后 account_did=rootDid",
        &root,
    );
    let heartbeat = spawn_heartbeat();
    presence::refresh().await;
    let gid = format!("grp-dev-{}", did_safe(&core_id::account_did_canonical(&root)));
    sig_write(
        "f_ready.json",
        &json!({ "rootDid": root, "aDeviceDid": a_dev, "aPub": a_pub, "aName": a_name, "gid": gid, "members": n }),
    );

    // ── ② 收编 N 个成员（真链 attest + 委任状投递）──
    let mut member_pubs = Vec::new();
    for i in 1..=n {
        let m = sig_wait(&format!("m{i}_ready.json"), 90).await;
        let m_dev = m["did"].as_str().unwrap_or("").to_string();
        let m_name = m["name"].as_str().unwrap_or("").to_string();
        let m_pub = m["pub"].as_str().unwrap_or("").to_string();
        let add = add_device_by_did(m_dev.clone(), m_name.clone(), None).await;
        match &add {
            Ok(v) => println!("[MX-founder] 收编成员{i}（{m_name}）成功 delegationDelivered={}", v["delegationDelivered"]),
            Err(e) => panic!("收编成员{i}（{m_name}）失败: {e}"),
        }
        ck(add.is_ok(), &format!("add_device_by_did 成员{i}（attest+委任状）成功"), "");
        member_pubs.push(m_pub);
    }

    // ── ③ 各成员收编完成（取委任状→账号就位→设备群 ensure）──
    for i in 1..=n {
        let mm = sig_wait(&format!("m{i}_member.json"), 120).await;
        ck(
            mm["gid"].as_str() == Some(gid.as_str()),
            &format!("成员{i} 与 founder 派生同一设备群 id（canonical 归一）"),
            &format!("A={gid} m{i}={}", mm["gid"].as_str().unwrap_or("?")),
        );
    }

    // ── ④ founder 侧设备群自动出现（挂点① chat_state→ensure）──
    assert_device_group(&gid, "founder").await;
    let snap = chat_state().await.expect("chat_state 失败");
    let g = snap["groups"]
        .as_array()
        .and_then(|gs| gs.iter().find(|g| g["id"].as_str() == Some(gid.as_str())).cloned())
        .unwrap_or(Value::Null);
    ck(
        g["members"].to_string() == json!([root.clone()]).to_string(),
        "成员恒 [rootDid]（真成员表=名册）",
        &g["members"].to_string(),
    );

    // ── ⑤ chat_device_group_info 真链：全员在册+在线，A isEmbodiment ──
    let mut info_v = Value::Null;
    for _ in 0..30 {
        if let Ok(v) = chat_device_group_info().await {
            info_v = v;
            let all_ok = member_pubs.iter().all(|p| {
                info_v["devices"].as_array().and_then(|ds| {
                    ds.iter().find(|d| d["pubkeyB64"].as_str() == Some(p.as_str()))
                }).and_then(|r| {
                    match (r["online"].as_bool(), r["revoked"].as_bool()) {
                        (Some(true), Some(false)) => Some(true),
                        _ => None,
                    }
                }) == Some(true)
            });
            if all_ok {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
    for (i, p) in member_pubs.iter().enumerate() {
        let row = info_v["devices"].as_array().and_then(|ds| {
            ds.iter().find(|d| d["pubkeyB64"].as_str() == Some(p.as_str())).cloned()
        });
        ck(row.is_some(), &format!("group_info 名册含成员{} 设备", i + 1), &info_v.to_string());
        let row = row.unwrap_or_default();
        ck(row["revoked"].as_bool() == Some(false), &format!("成员{} revoked=false（在册）", i + 1), &row.to_string());
        ck(row["online"].as_bool() == Some(true), &format!("成员{} online=true（presence 已带 rootDid）", i + 1), &row.to_string());
    }
    let a_row = info_v["devices"].as_array().and_then(|ds| {
        ds.iter().find(|d| d["pubkeyB64"].as_str() == Some(a_pub.as_str())).cloned()
    });
    ck(
        a_row.as_ref().and_then(|r| r["isEmbodiment"].as_bool()) == Some(true),
        "founder isEmbodiment=true（主设备）",
        &a_row.unwrap_or_default().to_string(),
    );

    // ── ⑥ 群发消息：全员在线 → 直推 sendState=sent；等各成员 dir=in+署名 回执 ──
    let text = format!("三端矩阵群发（founder→全员）ts={}", now_ms());
    let r = chat_send_group(gid.clone(), json!({ "text": text })).await.expect("群发失败");
    let msg1 = r["msgId"].as_str().unwrap_or("").to_string();
    ck(
        r["sendState"].as_str() == Some("sent"),
        "群发 sendState=sent（全员在线直推）",
        &r.to_string(),
    );
    let out_row = wait_conv_row(&gid, "founder 侧 out 行", |m| m["msgId"].as_str() == Some(msg1.as_str()), 10).await;
    ck(out_row["dir"].as_str() == Some("out"), "founder 侧本机消息 dir=out（「我」）", &out_row.to_string());
    sig_write(
        "s_text.json",
        &json!({ "msgId": msg1, "text": text, "expectDevice": a_dev, "expectName": a_name }),
    );
    for i in 1..=n {
        let got = sig_wait(&format!("m{i}_got.json"), 60).await;
        ck(
            got["msgId"].as_str() == Some(msg1.as_str()),
            &format!("成员{i} 回执 msgId 一致（他机消息署名=设备名断言在成员侧）"),
            &got.to_string(),
        );
    }
    let _ = heartbeat;
    println!("[MX-founder] 🎉 M1 加设备（1+{n} 实例）全链 PASS");
}

// ═══════════════════════ M1 实例 member（成员设备，被收编） ═══════════════════════

async fn run_member() {
    let id = member_id(); // 信号前缀：m1/m2/…（orchestrator 与 founder 约定）
    boot().await;
    let (m_dev, m_pub) = dev_identity();
    let m_name = device_name();
    let base = std::env::var("MYCO_DID_BASE").unwrap_or_default();

    // ── ① 设备身份在线（presence 无 rootDid——未收编态）──
    let heartbeat = spawn_heartbeat();
    presence::refresh().await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    sig_write(&format!("{id}_ready.json"), &json!({ "did": m_dev, "pub": m_pub, "name": m_name }));

    // ── ② 收编取件环（watch_probe_at 真链：名册反查+委任状取件+验签+nonce）──
    let accepted: (String, Value);
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    loop {
        match watch_probe_at(&base, &m_pub, |root| {
            Delegations::load().has_valid_for(root, &m_pub)
        })
        .await
        {
            Ok(WatchOutcome::Accepted { root_did, name, delegation }) => {
                accepted = (root_did, json!({ "name": name, "delegation": delegation }));
                break;
            }
            Ok(_) => {}
            Err(e) => println!("[MX-member] probe 错误（重试）: {e}"),
        }
        if std::time::Instant::now() > deadline {
            panic!("120s 内未被收编（founder 侧 add_device 未跑？）");
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    let (root, meta) = accepted;
    println!("[MX-member] 取到委任状：root={} name={}", root, meta["name"].as_str().unwrap_or("?"));
    // Accepted 副作用序列（= watch_tick_inner 同款；GUI 通知/emit 除外）
    let del = serde_json::from_value::<myco_core::delegation::Delegation>(meta["delegation"].clone())
        .expect("委任状反序列化");
    Delegations::load().accept_received(del);
    core_id::accounts_upsert(&root, meta["name"].as_str().unwrap_or("有灵账号"));
    let sw = core_id::account_switch(root.clone()).expect("account_switch 失败");
    ck(sw["role"].as_str() == Some("agent"), "成员角色切换为 agent（委任状分身）", &sw.to_string());
    ck(
        core_id::account_did().map(|d| core_id::account_did_eq(&d, &root)) == Some(true),
        "成员 account_did=rootDid（同账号多设备支点）",
        &core_id::account_did().unwrap_or_default(),
    );

    // ── ③ 设备群自动出现（挂点① chat_state→ensure；成员独立派生）──
    let gid = format!("grp-dev-{}", did_safe(&core_id::account_did_canonical(&root)));
    assert_device_group(&gid, "成员").await;
    presence::refresh().await; // 立即带 rootDid 重报（founder 侧 online 断言依赖它）
    tokio::time::sleep(Duration::from_millis(500)).await;
    sig_write(&format!("{id}_member.json"), &json!({ "rootDid": root, "gid": gid }));

    // ── ④ 收 founder 群发：dir=in + 署名=founder 设备名（信封实况）──
    let st = sig_wait("s_text.json", 120).await;
    let msg1 = st["msgId"].as_str().unwrap_or("").to_string();
    let row = wait_conv_row(&gid, "founder 群发 in 行", |m| m["msgId"].as_str() == Some(msg1.as_str()), 30).await;
    ck(row["dir"].as_str() == Some("in"), "他机消息 dir=in（不显示成「我」）", &row.to_string());
    ck(
        row["fromDevice"].as_str() == Some(st["expectDevice"].as_str().unwrap_or("?")),
        "成员侧 fromDevice=founder 设备 did（信封透传）",
        &row.to_string(),
    );
    ck(
        row["fromDeviceName"].as_str() == Some(st["expectName"].as_str().unwrap_or("?")),
        "成员侧署名=founder 设备名（公会场景成败点）",
        &row.to_string(),
    );
    sig_write(&format!("{id}_got.json"), &json!({ "msgId": msg1 }));
    let _ = heartbeat;
    println!("[MX-member] 🎉 M1 成员（{id}）全链 PASS");
}

// ═══════════════════════ M2 实例 exporter / importer（恢复码导入） ═══════════════════════

async fn run_exporter() {
    boot().await;
    let (e_dev, e_pub) = dev_identity();

    // ── ① 建号 + 导出恢复码 ──
    let info = core_id::account_create(Some("恢复码E2E".into()), None, None, None)
        .await
        .expect("建号失败（本地 identity-svc 未起？）");
    let root = info.root_did;
    let seed = core_id::account_export_seed().await.expect("导出恢复码失败");
    ck(!seed.is_empty(), "account_export_seed 导出恢复码（b64 种子）", &format!("len={}", seed.len()));
    let heartbeat = spawn_heartbeat();
    presence::refresh().await;
    sig_write("e_seed.json", &json!({ "rootDid": root, "seed": seed, "eDeviceDid": e_dev, "ePub": e_pub, "eName": device_name() }));

    // ── ② 等 importer 完成导入 ──
    let done = sig_wait("i_done.json", 120).await;
    ck(
        core_id::account_did_eq(done["rootDid"].as_str().unwrap_or(""), &root),
        "importer 回执 did 与 exporter 同源（身份延续）",
        &done.to_string(),
    );

    // ── ③ 名册真链：importer 设备已入册（恢复码通道=设备入册）──
    let i_pub = done["iPub"].as_str().unwrap_or("").to_string();
    let mut found = Value::Null;
    for _ in 0..20 {
        if let Ok(v) = chat_device_group_info().await {
            if let Some(r) = v["devices"].as_array().and_then(|ds| {
                ds.iter().find(|d| d["pubkeyB64"].as_str() == Some(i_pub.as_str())).cloned()
            }) {
                found = r;
                if found["revoked"].as_bool() == Some(false) {
                    break;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
    ck(!found.is_null(), "名册含 importer 设备（导入即入册）", &found.to_string());
    ck(found["revoked"].as_bool() == Some(false), "importer 设备 revoked=false", &found.to_string());
    let _ = heartbeat;
    println!("[MX-exporter] 🎉 M2 导出侧 PASS");
}

async fn run_importer() {
    boot().await;
    let (i_dev, i_pub) = dev_identity();
    sig_write("i_ready.json", &json!({ "did": i_dev, "pub": i_pub, "name": device_name() }));

    // ── ① 等 exporter 投恢复码 → 导入（同 did 身份延续 + embodiment）──
    let e = sig_wait("e_seed.json", 120).await;
    let seed = e["seed"].as_str().unwrap_or("").to_string();
    let root_expect = e["rootDid"].as_str().unwrap_or("").to_string();
    let root = core_id::account_import(seed, "".into()).await.expect("account_import 失败");
    ck(
        core_id::account_did_eq(&root, &root_expect),
        "导入后 did 与导出侧一致（canonical 归一比较——同 did 身份延续）",
        &format!("importer={root} exporter={root_expect}"),
    );
    let st = core_id::account_get().await.expect("account_get 失败");
    ck(st["role"].as_str() == Some("embodiment"), "导入后 role=embodiment（持种子=具身）", &st.to_string());
    ck(
        core_id::account_did().map(|d| core_id::account_did_eq(&d, &root_expect)) == Some(true),
        "导入后 account_did=同源 rootDid",
        &core_id::account_did().unwrap_or_default(),
    );

    // ── ② 设备入册断言（account_import 内联 ensure_device_in_root 的结果面）──
    let overview = core_id::account_list_devices().await.expect("account_list_devices 失败");
    let me = overview.devices.iter().find(|d| d.pubkey_b64 == i_pub);
    ck(me.is_some(), "名册含本机 importer 设备（导入即入册）", &format!("pub={i_pub}"));
    ck(me.map(|d| d.revoked) == Some(false), "importer 设备在册未吊销", "");

    // ── ③ presence 上线（带 rootDid）──
    let heartbeat = spawn_heartbeat();
    presence::refresh().await;
    sig_write("i_done.json", &json!({ "rootDid": root, "iPub": i_pub }));
    let _ = heartbeat;
    println!("[MX-importer] 🎉 M2 导入侧 PASS");
}

// ═══════════════════════ M4 实例 xfounder（跨端收编：PWA/Linux 外部端） ═══════════════════════

/// 外部端（phone=PWA playwright 脚本 / linux=WSL cli 脚本）信号约定：
///   <tag>_ready.json  {did, pub?, name}     —— 设备身份就绪，等收编
///   <tag>_member.json {rootDid?, gid?}      —— 收编确认（端侧自证）
///   <tag>_got.json    {msgId}               —— 群发消息到达确认
/// founder 写：s_x_text.json {msgId, text, expectDevice, expectName}
async fn run_xfounder() {
    boot().await;
    let (a_dev, a_pub) = dev_identity();
    let a_name = device_name();

    let info = core_id::account_create(Some("跨端矩阵E2E".into()), None, None, None)
        .await
        .expect("建号失败（本地 identity-svc 未起？）");
    let root = info.root_did;
    let heartbeat = spawn_heartbeat();
    presence::refresh().await;
    let gid = format!("grp-dev-{}", did_safe(&core_id::account_did_canonical(&root)));
    sig_write(
        "x_ready.json",
        &json!({ "rootDid": root, "aDeviceDid": a_dev, "aPub": a_pub, "aName": a_name, "gid": gid }),
    );

    // ── ① 收编外部端（等就绪信号 → add_device_by_did → 等端侧确认）──
    let tags: Vec<String> = std::env::var("MX_TAGS")
        .unwrap_or_else(|_| "phone,linux".into())
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    assert!(!tags.is_empty(), "MX_TAGS 至少一个外部端 tag（phone/linux）");
    let mut ext_pubs = Vec::new();
    for tag in &tags {
        let r = sig_wait(&format!("{tag}_ready.json"), 180).await;
        let did = r["did"].as_str().unwrap_or("").to_string();
        let name = r["name"].as_str().unwrap_or(tag.as_str()).to_string();
        let pub_b64 = r["pub"].as_str().unwrap_or("").to_string();
        ck(!did.is_empty(), &format!("{tag} 出示设备 did"), &r.to_string());
        // 跨端 did 形态实况（canonical-only，2026-10-10）：外部端出示的必须是 canonical
        // 设备 did（`did:myco:z…`）——legacy 裸 base58 已废止，device_pubkey_from_did_or_b64
        // 会直接报「不支持的 did 格式」（真互测点：解析失败=add_device_by_did 直接报错，见下）
        let add = add_device_by_did(did.clone(), name.clone(), None).await;
        match &add {
            Ok(v) => println!(
                "[MX-xfounder] 跨端收编 {tag}（{name}）成功 delegationDelivered={}",
                v["delegationDelivered"]
            ),
            Err(e) => panic!("跨端收编 {tag}（{name}）失败: {e}"),
        }
        ck(add.is_ok(), &format!("跨端收编 {tag}（attest+委任状投递）成功"), "");
        if !pub_b64.is_empty() {
            ext_pubs.push(pub_b64);
        }
    }

    // ── ② 名册真链：外部端设备入册（online 实况记录——cli 端不发 presence）──
    for (tag, p) in tags.iter().zip(ext_pubs.iter()) {
        let mut row = Value::Null;
        for _ in 0..20 {
            if let Ok(v) = chat_device_group_info().await {
                if let Some(r) = v["devices"].as_array().and_then(|ds| {
                    ds.iter().find(|d| d["pubkeyB64"].as_str() == Some(p.as_str())).cloned()
                }) {
                    row = r;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(1000)).await;
        }
        ck(!row.is_null(), &format!("名册含 {tag} 设备"), &row.to_string());
        ck(row["revoked"].as_bool() == Some(false), &format!("{tag} revoked=false"), &row.to_string());
        println!(
            "[MX-xfounder] 👀 {tag} online={}（PWA 走 presence；cli 端不发——如实记录）",
            row["online"].as_bool().unwrap_or(false)
        );
    }

    // ── ③ founder 侧设备群 + 群发（直推/信箱两路实况）──
    assert_device_group(&gid, "xfounder").await;
    let text = format!("跨端矩阵群发 ts={}", now_ms());
    let r = chat_send_group(gid.clone(), json!({ "text": text })).await.expect("群发失败");
    let msg1 = r["msgId"].as_str().unwrap_or("").to_string();
    println!(
        "[MX-xfounder] 👀 跨端群发 sendState={}（在册在线者直推；余信箱兜底）",
        r["sendState"].as_str().unwrap_or("?")
    );
    sig_write(
        "s_x_text.json",
        &json!({ "msgId": msg1, "text": text, "expectDevice": a_dev, "expectName": a_name }),
    );

    // ── ④ 等外部端完成回执（按端能力断言，语义分两种）──
    //   phone（PWA 全功能端）：{msgId} —— 群发消息经信箱兜底到达，msgId 一致；
    //   linux（cli 身份域端）：{rootDid, delegationVerified} —— 委任状 wire 三端
    //     互通（Win 签发 → svc 投递 → Linux cli 离线验签通过）+ 反查同 root。
    for tag in &tags {
        let got = sig_wait(&format!("{tag}_done.json"), 150).await;
        if let Some(m) = got["msgId"].as_str() {
            ck(
                m == msg1,
                &format!("{tag} 收到群发消息（msgId 一致，信箱兜底路）"),
                &got.to_string(),
            );
        }
        if let Some(v) = got["delegationVerified"].as_bool() {
            ck(v, &format!("{tag} 委任状验签通过（wire 三端互通铁证）"), &got.to_string());
        }
        if let Some(rd) = got["rootDid"].as_str() {
            ck(
                core_id::account_did_eq(rd, &root),
                &format!("{tag} 反查/回执 rootDid 与 xfounder 同源"),
                &format!("x={root} {tag}={rd}"),
            );
        }
        ck(
            !got["msgId"].is_null() || !got["delegationVerified"].is_null(),
            &format!("{tag} done 信号至少携带一种完成凭据"),
            &got.to_string(),
        );
    }
    let _ = heartbeat;
    println!("[MX-xfounder] 🎉 M4 跨端收编+群发 PASS（tags={}）", tags.join("+"));
}

fn main() {
    let r = role();
    println!(
        "[MX-{r}] 启动：cfg={} p2p_port_base={} id_base={} members={}",
        std::env::var("MYCO_CONFIG_DIR").unwrap_or_default(),
        std::env::var("MYCO_P2P_PORT").unwrap_or_default(),
        std::env::var("MYCO_DID_BASE").unwrap_or_default(),
        member_count()
    );
    let rt = tokio::runtime::Runtime::new().expect("tokio rt");
    rt.block_on(async {
        match r.as_str() {
            "member" => run_member().await,
            "exporter" => run_exporter().await,
            "importer" => run_importer().await,
            "xfounder" => run_xfounder().await,
            _ => run_founder().await,
        }
    });
}
