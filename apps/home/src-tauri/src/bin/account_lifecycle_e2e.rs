//! account_lifecycle_e2e.rs — 账号生命周期/密码链/多账号切换/委任状/旧格式闸门
//! 单实例 E2E（2026-10-07 myco 功能面广度测试·客户端功能回归线）。
//!
//! 与既有 e2e 的分工（不重叠）：
//!   - device_group_e2e / friend_e2e / p2p_e2e = 双实例消息/设备群/好友链路；
//!   - 本 bin = **单账号域全生命周期**：创建→改名→备份导出→密码链（锁定/解锁/
//!     改密旧密失效）→多账号 A↔B 切换与种子槽路由→解绑→恢复码导入（did 延续）→
//!     登出→重登 + 委任状服务端链（收编投递→取件验签→续签重投→吊销→名册除名）+
//!     旧格式闸门（legacy did /root/create 真服务器 400 unsupported_did_format）。
//!
//! 单进程跑法（本地 identity-svc）：
//!   ① 本地 identity-svc：PORT=18341 DB_PATH=<临时> node services/identity-svc/identity-server.mjs
//!   ② MYCO_CONFIG_DIR=<临时cfg> MYCO_DID_BASE=http://127.0.0.1:18341 \
//!      cargo run --release -p myco-home --bin account_lifecycle_e2e
//!   （安全闸：MYCO_DID_BASE 非本机即拒跑；MYCO_CONFIG_DIR 指向活登录器目录即拒跑。）
//!
//! 「重启后种子读不出」双重验证：①account_switch 清 SOUL_CACHE（与真实重启同读
//! 盘路径）；②自我复制冷启子进程（同 cfg 目录）复核真实冷进程语义。

use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use myco_core::identity as core_id;
use serde_json::{json, Value};
use std::time::Duration;

fn b64e(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn b64d(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).unwrap_or_default()
}

fn base() -> String {
    std::env::var("MYCO_DID_BASE").unwrap_or_default().trim_end_matches('/').to_string()
}

/// 断言即报告：过打 ✅、败打 ❌ 后 panic（退出码即失败信号）。
fn ck(cond: bool, name: &str, detail: &str) {
    if cond {
        println!("[AL-E2E] ✅ {name}");
    } else {
        println!("[AL-E2E] ❌ {name} —— {detail}");
        panic!("E2E 断言失败: {name} —— {detail}");
    }
}

async fn boot() {
    let b = base();
    assert!(
        b.starts_with("http://127.0.0.1:") || b.starts_with("http://localhost:"),
        "安全闸：MYCO_DID_BASE={b} 必须指向本机 identity-svc（绝不碰生产 myco.youling.cc）"
    );
    let cfg = std::env::var("MYCO_CONFIG_DIR").unwrap_or_default();
    assert!(!cfg.is_empty(), "必须设 MYCO_CONFIG_DIR（identity 域隔离）");
    let real = std::env::var("APPDATA").map(|a| format!("{a}\\youling")).unwrap_or_default();
    assert!(
        !cfg.eq_ignore_ascii_case(&real),
        "安全闸：MYCO_CONFIG_DIR 指向了活登录器目录 {cfg}"
    );
    std::fs::create_dir_all(&cfg).expect("建 cfg 目录失败");
    let http = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().unwrap();
    let r = http.get(format!("{b}/health")).send().await.expect("identity-svc 不可达");
    ck(r.status().is_success(), "本地 identity-svc /health 可达", &b);
}

fn seed_slot_path(did: &str) -> std::path::PathBuf {
    let cfg = std::env::var("MYCO_CONFIG_DIR").unwrap();
    std::path::PathBuf::from(cfg).join("accounts").join(format!("{}.seed", did.replace([':', '/'], "_")))
}

fn urlencode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

/// 裸 GET（无签名）——只读服务端事实。
async fn svc_get(path: &str) -> (u16, Value) {
    let http = reqwest::Client::builder().timeout(Duration::from_secs(8)).build().unwrap();
    let r = http.get(format!("{}{}", base(), path)).send().await.expect("GET 失败");
    let s = r.status().as_u16();
    let v = r.json().await.unwrap_or(Value::Null);
    (s, v)
}

/// 本机设备公钥 b64（device_identity 返回的是种子 b64——派生出公钥）。
fn local_device_pubkey_b64() -> String {
    let (_, seed_b64) = core_id::device_identity().expect("设备钥不可读");
    let arr: [u8; 32] = b64d(&seed_b64).try_into().expect("设备种子长度坏");
    b64e(&SigningKey::from_bytes(&arr).verifying_key().to_bytes())
}

/// 轮询等谓词真（800ms 间隔；超时 panic）。
async fn wait_until(name: &str, timeout_secs: u64, pred: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    while std::time::Instant::now() < deadline {
        if pred() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(800)).await;
    }
    panic!("等待 {name} 超时（{timeout_secs}s）");
}

async fn poll_delegation(device_pubkey_b64: &str) -> Result<Value, String> {
    let http = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().map_err(|e| e.to_string())?;
    let r = http.get(format!("{}/delegation/poll", base()))
        .query(&[("devicePubkeyB64", device_pubkey_b64)])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("poll status={}", r.status()));
    }
    let v: Value = r.json().await.map_err(|e| e.to_string())?;
    v.get("data").cloned().filter(|d| !d.is_null()).ok_or_else(|| "poll 无 data".into())
}

async fn run() {
    boot().await;

    // ══ S1 创建 + 基础 ══
    let a = core_id::account_create_ex(Some("生命周期A".into()), None, None, None, true)
        .await
        .expect("建号 A 失败");
    let did_a = a.root_did.clone();
    println!("[AL-E2E] 建号 A rootDid={did_a}");
    ck(did_a.starts_with("did:youling:z"), "新账号 did 为 canonical 形态（did:youling:z…）", &did_a);
    ck(core_id::account_did().as_deref() == Some(did_a.as_str()), "account_did()==did_A", &format!("{:?}", core_id::account_did()));

    core_id::account_rename("生命A改".into()).await.expect("改名失败");
    ck(core_id::account_name_cached().as_deref() == Some("生命A改"), "改名后本地名缓存即时回填", &format!("{:?}", core_id::account_name_cached()));
    let (s, v) = svc_get(&format!("/root/{}", urlencode(&did_a))).await;
    ck(s == 200 && v.pointer("/data/name").and_then(|n| n.as_str()) == Some("生命A改"),
        "服务端名册名字=生命A改（真落库）", &v.to_string());

    // ══ S2 备份导出（明文种子 + 加密备份）══
    let seed_a_b64 = core_id::account_export_seed().await.expect("导出种子失败");
    ck(b64d(&seed_a_b64).len() == 32, "导出种子=32B", &format!("len={}", b64d(&seed_a_b64).len()));
    let bk = core_id::account_export_encrypted("恢复密码R1".into()).await.expect("导出加密备份失败");
    ck(!bk.ct.is_empty() && !bk.salt.is_empty() && !bk.iv.is_empty(), "加密备份 ct/salt/iv 齐", "");

    // ══ S3 密码链：设密→锁定→错拒→解锁→改密→旧密失效 ══
    core_id::account_set_password("密码P1".into()).await.expect("设密失败");
    let st = core_id::account_status().await.expect("status 失败");
    ck(st["hasPassword"] == json!(true) && st["locked"] == json!(false), "设密后 hasPassword=true 且当前会话未锁", &st.to_string());

    let b = core_id::account_create_ex(Some("账号B".into()), None, None, None, true)
        .await
        .expect("建号 B 失败");
    let did_b = b.root_did.clone();
    println!("[AL-E2E] 建号 B rootDid={did_b}");
    ck(core_id::account_did().as_deref() == Some(did_b.as_str()), "建 B 后活动账号=B", "");
    let seed_b_b64 = core_id::account_export_seed().await.expect("B 导出种子失败");
    ck(seed_slot_path(&did_a).is_file() && seed_slot_path(&did_b).is_file(), "A/B 双种子槽文件各自在位", "");

    // 切回 A：缓存清空 + 槽加密 → 锁定态（与重启后同读盘路径）
    let sw = core_id::account_switch(did_a.clone()).expect("切 A 失败");
    ck(sw["role"] == json!("embodiment"), "切 A role=embodiment", &sw.to_string());
    let st = core_id::account_status().await.expect("status 失败");
    ck(st["locked"] == json!(true), "A 加密槽+缓存空 → locked=true（重启后等价）", &st.to_string());
    ck(core_id::cached_account_seed().is_none(), "锁定态种子读不出", "");
    ck(core_id::account_export_seed().await.is_err(), "锁定态导出种子被拒", "");

    let wrong = core_id::account_unlock("错误密码".into()).await;
    ck(wrong.is_err(), "错密码解锁失败", &format!("{wrong:?}"));
    ck(core_id::cached_account_seed().is_none(), "错密码后仍锁定", "");
    core_id::account_unlock("密码P1".into()).await.expect("正确密码解锁失败");
    let unlocked: [u8; 32] = core_id::cached_account_seed().expect("解锁后种子应可读");
    ck(unlocked[..] == b64d(&seed_a_b64)[..], "解锁出的种子==导出的种子（同一把钥匙）", "");

    core_id::account_set_password("密码P2".into()).await.expect("改密失败");
    core_id::account_switch(did_b.clone()).expect("切 B 失败");
    core_id::account_switch(did_a.clone()).expect("切回 A 失败");
    ck(core_id::account_status().await.unwrap()["locked"] == json!(true), "改密后再切换仍锁定（盘上已换新密）", "");
    ck(core_id::account_unlock("密码P1".into()).await.is_err(), "旧密码 P1 已失效", "");
    core_id::account_unlock("密码P2".into()).await.expect("新密码 P2 解锁失败");
    ck(core_id::cached_account_seed().is_some(), "新密码解锁成功", "");

    // ══ S4 多账号切换与种子槽路由（A↔B 交叉两轮）══
    for round in 1..=2 {
        core_id::account_switch(did_b.clone()).expect("切 B 失败");
        let sb: [u8; 32] = core_id::cached_account_seed().expect("B 种子应可读（无密码槽）");
        ck(sb[..] == b64d(&seed_b_b64)[..], &format!("第{round}轮 切 B 读到 B 种子（槽路由不串）"), "");
        ck(core_id::account_did().as_deref() == Some(did_b.as_str()), &format!("第{round}轮 活动=B"), "");
        core_id::account_switch(did_a.clone()).expect("切 A 失败");
        ck(core_id::cached_account_seed().is_none(), &format!("第{round}轮 切 A 即锁定（A 槽仍密文，B 种子未泄给 A）"), "");
        core_id::account_unlock("密码P2".into()).await.expect("A 解锁失败");
        let sa: [u8; 32] = core_id::cached_account_seed().expect("A 种子应可读");
        ck(sa[..] == b64d(&seed_a_b64)[..], &format!("第{round}轮 切 A 读到 A 种子"), "");
    }

    // 设备归属自愈独立性（真除名→真复活路径）：
    //   ① A 名册除名本机设备（device_revoke=服务端 revoked=1）
    //   ② B 名册不受影响（同一设备两账号各自独立行）
    //   ③ 切回 A 触发自愈（switch/status 的 fire-and-forget）→ 设备复活（revoked=0）
    let dev_pub_b64 = local_device_pubkey_b64();
    let roster_has_active = |v: &Value| -> bool {
        v.pointer("/data/devices").and_then(|d| d.as_array()).map(|ds| {
            ds.iter().any(|dv| dv["pubkeyB64"].as_str() == Some(dev_pub_b64.as_str()) && dv["revoked"] == json!(0))
        }).unwrap_or(false)
    };
    myco_home_lib::identity_service::device_revoke(dev_pub_b64.clone())
        .await
        .expect("A 除名本机设备失败");
    let (_, va) = svc_get(&format!("/root/{}", urlencode(&did_a))).await;
    ck(!roster_has_active(&va), "A 名册本机设备已除名（revoked）", &va.to_string());
    let (_, vb) = svc_get(&format!("/root/{}", urlencode(&did_b))).await;
    ck(roster_has_active(&vb), "B 名册本机设备不受影响（归属独立）", &vb.to_string());

    // A 侧自愈复活：切 B 再切回 A（switch+status 双触发）→ 轮询名册直到复活
    core_id::account_switch(did_b.clone()).expect("切 B 失败");
    core_id::account_switch(did_a.clone()).expect("切回 A 失败");
    core_id::account_unlock("密码P2".into()).await.expect("A 解锁失败");
    let mut healed = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(25);
    while std::time::Instant::now() < deadline {
        let (_, v) = svc_get(&format!("/root/{}", urlencode(&did_a))).await;
        if roster_has_active(&v) {
            healed = true;
            break;
        }
        let _ = core_id::account_status().await; // 再触发一轮自愈检查
        tokio::time::sleep(Duration::from_millis(900)).await;
    }
    ck(healed, "A 名册自愈复活（切回即补登记，设备归属自愈独立生效）", &did_a);

    // ══ S5 解绑 → 恢复码导入（身份延续）→ 登出 → 重登 ══
    let backup_text = format!("ct={}\nsalt={}\niv={}", bk.ct, bk.salt, bk.iv);
    core_id::account_unbind().await.expect("解绑失败");
    ck(!seed_slot_path(&did_a).exists(), "解绑删 A 活动槽", "");
    ck(core_id::account_did().is_none(), "解绑后无账号指向", "");
    let imported = core_id::account_import(backup_text, "恢复密码R1".into()).await.expect("恢复码导入失败");
    ck(core_id::account_did_eq(&imported, &did_a), "导入身份延续：did 不变", &format!("{imported} != {did_a}"));
    ck(core_id::account_did().as_deref() == Some(did_a.as_str()), "导入后活动账号=A", "");
    let sa: [u8; 32] = core_id::cached_account_seed().expect("导入后种子可读（导入写无密码槽）");
    ck(sa[..] == b64d(&seed_a_b64)[..], "导入种子与原种子同把钥匙", "");

    core_id::account_logout().await.expect("登出失败");
    ck(core_id::account_did().is_none(), "登出后无活动账号", "");
    let listed = core_id::accounts_load();
    ck(listed.iter().any(|x| x["did"].as_str() == Some(did_a.as_str()) && x["loggedOut"] == json!(true)),
        "账号清单 A 标记 loggedOut", &serde_json::to_string(&listed).unwrap_or_default());
    let relogin = core_id::account_switch(did_a.clone()).expect("重登（切回 A）失败");
    ck(relogin["role"] == json!("embodiment"), "重登 role=embodiment", &relogin.to_string());
    let sb2 = core_id::account_export_seed().await.expect("重登后种子可读失败");
    ck(b64d(&sb2)[..] == b64d(&seed_a_b64)[..], "重登后种子同把钥匙", "");

    // ══ S6 委任状服务端链：收编投递→取件验签→续签重投→吊销→名册除名→停喂 ══
    let member_seed: [u8; 32] = rand::random();
    let member_pub_b64 = b64e(&SigningKey::from_bytes(&member_seed).verifying_key().to_bytes());
    let add = myco_home_lib::identity_service::add_device_by_did(member_pub_b64.clone(), "e2e成员".into(), None)
        .await
        .expect("收编成员失败");
    ck(add["delegationDelivered"] == json!(true), "收编=attest+委任状投信箱 delivered", &add.to_string());
    let member_enc = urlencode(&member_pub_b64);
    let (s, v) = svc_get(&format!("/device/{member_enc}")).await;
    ck(s == 200 && v.pointer("/data/rootDid").and_then(|d| d.as_str()).map(|d| core_id::account_did_eq(d, &did_a)).unwrap_or(false),
        "名册反查成员设备 → rootDid=A", &v.to_string());

    let d1 = poll_delegation(&member_pub_b64).await.expect("取委任状失败");
    ck(core_id::account_did_eq(d1["accountDid"].as_str().unwrap_or(""), &did_a), "委任状 accountDid=A", &d1.to_string());
    ck(d1["devicePubkeyB64"].as_str() == Some(member_pub_b64.as_str()), "委任状 devicePubkeyB64=成员钥", "");
    let del1: myco_core::delegation::Delegation = serde_json::from_value(d1.clone()).expect("委任状反序列化失败");
    ck(myco_core::delegation::verify(&del1).is_ok(), "委任状验签通过（账号钥签名）", "");
    ck(del1.exp - del1.issued_at == myco_core::delegation::DEVICE_DELIVER_TTL_MS, "30 天 TTL 形态", &format!("{}ms", del1.exp - del1.issued_at));

    let seed_a: [u8; 32] = core_id::cached_account_seed().expect("A 种子");
    myco_home_lib::identity_service::deliver_delegation_at(&base(), &seed_a, &did_a, &member_pub_b64, "e2e成员")
        .await
        .expect("续签重投失败");
    let d2 = poll_delegation(&member_pub_b64).await.expect("二取失败");
    ck(d2["nonce"] != d1["nonce"], "续签重投=新 nonce", &format!("{}→{}", d1["nonce"], d2["nonce"]));
    let del2: myco_core::delegation::Delegation = serde_json::from_value(d2.clone()).unwrap();
    ck(myco_core::delegation::verify(&del2).is_ok(), "续签后验签通过", "");

    myco_home_lib::identity_service::device_revoke(member_pub_b64.clone())
        .await
        .expect("吊销失败");
    let (s, v) = svc_get(&format!("/device/{member_enc}")).await;
    ck(s == 404 || v.pointer("/data/rootDid").is_none(), "吊销后名册反查 404（watch 将见 NotOnRoster）", &format!("status={s} {v}"));

    // 复活路径（纯服务端吊销→重收编）：服务端 /root/device/add ON CONFLICT revoked=0
    // 复活 + 委任状照投（此时尚未本地停喂）
    let re_add = myco_home_lib::identity_service::add_device_by_did(member_pub_b64.clone(), "e2e成员2".into(), None)
        .await
        .expect("重收编失败");
    ck(re_add["delegationDelivered"] == json!(true), "吊销后重收编成功（revive+委任状照投）", &re_add.to_string());
    let (s, _) = svc_get(&format!("/device/{member_enc}")).await;
    ck(s == 200, "重收编后名册反查恢复", &format!("status={s}"));

    // 本地停喂：已吊销设备续签拒签（此后再收编=名册可复活但委任状不投——设计语义）
    let seed_a: [u8; 32] = core_id::cached_account_seed().expect("A 种子");
    let del_store = myco_core::delegation::Delegations::load();
    del_store.revoke(&member_pub_b64);
    let stopped = del_store.issue_for_with_ttl(&seed_a, &did_a, &member_pub_b64, "e2e成员", None, 60_000);
    ck(stopped.is_err(), "本地吊销后续签拒绝（停喂）", &format!("{stopped:?}"));
    let re_add2 = myco_home_lib::identity_service::add_device_by_did(member_pub_b64.clone(), "e2e成员3".into(), None)
        .await
        .expect("本地停喂后重收编（名册层）失败");
    ck(re_add2["delegationDelivered"] == json!(false), "本地停喂后：名册复活但委任状不投（停喂语义）", &re_add2.to_string());
    let (s, _) = svc_get(&format!("/device/{member_enc}")).await;
    ck(s == 200, "停喂后名册反查仍恢复（名册与委任状两层独立）", &format!("status={s}"));

    // ══ S7 旧格式闸门（真服务器 400 unsupported_did_format）══
    let aliases = core_id::account_did_aliases(&did_a);
    let legacy = aliases.iter().find(|d| d.starts_with("did:youling:") && !d.starts_with("did:youling:z"))
        .or_else(|| aliases.iter().find(|d| d.starts_with("did:myco:") && !d.starts_with("did:myco:z")))
        .expect("找不到 legacy 形态别名");
    println!("[AL-E2E] legacy 形态={legacy}");
    let signing = SigningKey::from_bytes(&seed_a);
    let root_pub_b64 = b64e(&signing.verifying_key().to_bytes());
    let create_msg = format!("create\n{legacy}\n{root_pub_b64}");
    let sig = b64e(&signing.sign(create_msg.as_bytes()).to_bytes());
    let http = reqwest::Client::builder().timeout(Duration::from_secs(8)).build().unwrap();
    let r = http.post(format!("{}/root/create", base()))
        .json(&json!({
            "rootDid": legacy,
            "rootPubkeyB64": root_pub_b64,
            "devicePubkeyB64": dev_pub_b64,
            "name": "闸门探针",
            "deviceName": "E2E",
            "rootSig": sig,
        }))
        .send()
        .await
        .expect("legacy create 请求失败");
    let status = r.status().as_u16();
    let body: Value = r.json().await.unwrap_or(Value::Null);
    ck(status == 400, "legacy did /root/create → 400（格式闸门）", &format!("status={status} {body}"));
    ck(body["code"].as_str() == Some("unsupported_did_format"), "code=unsupported_did_format", &body.to_string());
    let (s, _) = svc_get(&format!("/root/{}", urlencode(legacy))).await;
    ck(s == 404, "闸门未落库（GET 404）", &format!("status={s}"));
    let st = core_id::account_status().await.unwrap();
    ck(st["accountFormatLegacy"] == json!(false), "canonical 账号不误标 accountFormatLegacy", &st.to_string());

    // 收尾设密（import 后槽是无密码态——重新上密，供冷启子阶段验「重启后锁定」真语义）
    core_id::account_set_password("密码P2".into()).await.expect("收尾设密失败");

    println!("[AL-E2E] 🎉 账号生命周期 E2E 主链 PASS");
}

/// 子阶段：真实冷进程复核「重启后锁定」（父进程同 cfg 目录复制体）。
async fn run_cold_restart() {
    boot().await;
    let st = core_id::account_status().await.expect("status 失败");
    ck(st["hasPassword"] == json!(true), "冷进程 hasPassword=true", &st.to_string());
    ck(st["locked"] == json!(true), "冷进程 locked=true（重启后种子读不出）", &st.to_string());
    ck(core_id::cached_account_seed().is_none(), "冷进程种子不可读", "");
    core_id::account_unlock("密码P2".into()).await.expect("冷进程解锁失败");
    ck(core_id::cached_account_seed().is_some(), "冷进程解锁成功", "");
    println!("[AL-E2E] 🎉 冷进程重启语义 PASS");
}

fn main() {
    let phase = std::env::var("AL_E2E_PHASE").unwrap_or_else(|_| "main".into());
    println!("[AL-E2E] 启动 phase={phase} cfg={} base={}",
        std::env::var("MYCO_CONFIG_DIR").unwrap_or_default(), base());
    let rt = tokio::runtime::Runtime::new().expect("tokio rt");
    rt.block_on(async {
        if phase == "cold-restart" {
            run_cold_restart().await;
        } else {
            run().await;
            let exe = std::env::current_exe().expect("exe 路径");
            let out = std::process::Command::new(exe)
                .env("AL_E2E_PHASE", "cold-restart")
                .output()
                .expect("子进程启动失败");
            let txt = String::from_utf8_lossy(&out.stdout);
            print!("{txt}");
            if !out.status.success() {
                panic!("冷重启子阶段失败: {}", String::from_utf8_lossy(&out.stderr));
            }
            println!("[AL-E2E] 🎉 全部阶段 PASS（主链 + 冷重启）");
        }
    });
}
