//! delegation_renewal.rs — 委任状自动续约巡检（2026-10-11 设计缺口修复）。
//!
//! # 缺口（用户 2026-10-11 笔记本实锤）
//! 手机端 `apps/phone/src/transport.ts` 只在 **P2P 连上主设备时**触发续签
//! （rpcCh.onopen → isDueRenew → requestRenewal）；PC/笔记本 myco **两侧都没接**：
//!   · 分身侧：不检查到期、不投续约请求、不提醒——委任状静默过期一个月，
//!     用户登录 www.youling.cc 才发现（红字还误导为"请重新创建账户"）。
//!   · 本体侧：不巡检自己签出的委任状——成员离线就永远等不到续签。
//!
//! # 方案（零新端点——identity-svc 协议早已齐备，只是 PC home 没接）
//!   · `/delegation/renew`（手机端 requestRenewal 对等）：分身投续约请求
//!     （设备钥签 renew 消息 + 现委任状持有证明），服务端入 renewInbox 并
//!     notifyAccount 推 renew-notify 给本体。
//!   · `/delegation/inbox?accountDid=`：本体拉收件箱，见请求即重签。
//!   · `/delegation/deliver`：本体把新委任状投进成员信箱（deliver 即出箱）。
//!   · `/delegation/poll`：分身 20s 取件环（identity_service::watch_tick）既有。
//!
//! # 巡检环（单 tokio 任务，启动即一轮，之后自适应间隔）
//!   · 本体侧（持活动账号种子）：对 delegations.json 里**自己签出**的到期/过期
//!     记录重签+投递（宽限重签——给离线设备恢复窗口）；顺带拉 /delegation/inbox
//!     响应分身的显式续约请求。
//!   · 分身侧（有绑定本机设备钥的委任状、且非该账号主设备）：is_due_renew 即投
//!     /delegation/renew；已过期也投（服务端 30 天宽限闸兜底），并广播过期事件
//!     给 UI（"设备授权已过期，请在主设备上重新授权"）。
//!   · 间隔：默认 30 分钟；任一分身委任状进入续约窗口（is_due_renew）→ 5 分钟。
//!
//! 不动 did 规范/签名算法/验签逻辑——只加调度；重签保持原 TTL（续约不改条款）。
//!
//! 关键防坑：`Delegations::load()` 会把「过期未吊销」行从文件里清掉
//! （keep_on_load 任务4），巡检一律先 `read_records_raw()` 拿未清理视图，
//! 否则宽限重签永远看不见已过期记录。投递失败不落新档（旧记录原样保留，
//! 下一轮重试）——杜绝"本地已换新状、成员却永远没收到"的错位。

use base64::Engine as _;
use ed25519_dalek::Signer as _;
use myco_core::delegation::{Delegation, DelegationRecord, Delegations};
use myco_core::identity as core_id;

/// 常规巡检间隔：30 分钟（任务规格）。
pub const PATROL_INTERVAL_MS: u64 = 30 * 60 * 1000;
/// 进入续约窗口后的加密巡检间隔：5 分钟（任务规格：到期前 24h 内）。
pub const PATROL_DUE_INTERVAL_MS: u64 = 5 * 60 * 1000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn b64e(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

// ============================================================================
// 纯函数：候选挑选 / 间隔决策（单测面）
// ============================================================================

/// 本体侧候选：该账号签出的、未吊销的、进入续约窗口（含已过期=宽限重签）的记录。
/// 同（账号,设备）多条时收敛为 exp 最大的一条（issue/accept 落档本就收敛，raw
/// 视图防御历史脏数据）。pub 供单测与巡检共用。
pub fn renewal_candidates(
    recs: &[DelegationRecord],
    account_did: &str,
    now: u64,
) -> Vec<DelegationRecord> {
    let mut picked: Vec<DelegationRecord> = Vec::new();
    for r in recs {
        if r.revoked
            || !core_id::account_did_eq(&r.delegation.account_did, account_did)
            || !r.delegation.is_due_renew_at(now)
        {
            continue;
        }
        match picked
            .iter_mut()
            .find(|p| p.delegation.device_pubkey_b64 == r.delegation.device_pubkey_b64)
        {
            Some(p) => {
                if r.delegation.exp > p.delegation.exp {
                    *p = r.clone();
                }
            }
            None => picked.push(r.clone()),
        }
    }
    picked
}

/// 分身侧候选：绑定本机设备钥、未吊销、且本机**不是**该账号主设备（无种子槽）的
/// 记录；同账号多条收敛为 exp 最大的一条。`is_root_for` 注入（生产=
/// account_local_role=="embodiment"；测试传闭包），返回按账号去重的记录。
pub fn member_records(
    recs: &[DelegationRecord],
    device_pubkey_b64: &str,
    is_root_for: impl Fn(&str) -> bool,
) -> Vec<DelegationRecord> {
    let mut picked: Vec<DelegationRecord> = Vec::new();
    for r in recs {
        if r.revoked || r.delegation.device_pubkey_b64 != device_pubkey_b64 {
            continue;
        }
        let acc = &r.delegation.account_did;
        if is_root_for(acc) {
            continue; // 本机持该账号种子=主设备留档，续签归本机本体侧逻辑
        }
        match picked
            .iter_mut()
            .find(|p| core_id::account_did_eq(&p.delegation.account_did, acc))
        {
            Some(p) => {
                if r.delegation.exp > p.delegation.exp {
                    *p = r.clone();
                }
            }
            None => picked.push(r.clone()),
        }
    }
    picked
}

/// 下一轮间隔：有分身委任状进入续约窗口 → 5 分钟，否则 30 分钟。
pub fn next_patrol_delay_ms(has_due_member: bool) -> u64 {
    if has_due_member {
        PATROL_DUE_INTERVAL_MS
    } else {
        PATROL_INTERVAL_MS
    }
}

// ============================================================================
// HTTP 原语（base 显式传入供单测指 mock）
// ============================================================================

/// identity-svc 续约收件箱条目（GET /delegation/inbox → data 数组项）。
#[derive(Clone, Debug)]
pub struct RenewInboxEntry {
    pub device_pubkey_b64: String,
    pub name: String,
    pub ts: u64,
}

/// 本体拉续约请求收件箱（分身 /delegation/renew 投进来的）。服务端无鉴权
/// （知情即见，delegation.mjs 契约）；空箱/不可达 → 空 Vec（不挡巡检）。
pub async fn fetch_renew_inbox_at(base: &str, account_did: &str) -> Vec<RenewInboxEntry> {
    let http = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let Ok(r) = http
        .get(format!("{}/delegation/inbox", base.trim_end_matches('/')))
        .query(&[("accountDid", account_did)])
        .send()
        .await
    else {
        return Vec::new();
    };
    if !r.status().is_success() {
        return Vec::new();
    }
    let Ok(v) = r.json::<serde_json::Value>().await else {
        return Vec::new();
    };
    v.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    let pk = e.get("devicePubkeyB64")?.as_str()?.to_string();
                    if pk.is_empty() {
                        return None;
                    }
                    Some(RenewInboxEntry {
                        device_pubkey_b64: pk,
                        name: e.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                        ts: e.get("ts").and_then(|t| t.as_u64()).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 分身投续约请求（手机端 delegation.ts requestRenewal 逐字段对等）：
/// msg = "renew\n{accountDid}\n{devicePubkeyB64}\n{ts}"，设备钥签；
/// body 附现委任状（持有证明——服务端无证明 403，防陌生设备白拿委任状）。
/// 已过期委任状也投（宽限期内服务端受理；超宽限 403 由服务端闸）。
pub async fn post_renew_request_at(
    base: &str,
    device_seed: &[u8; 32],
    d: &Delegation,
) -> Result<(), String> {
    let ts = now_ms();
    let msg = format!("renew\n{}\n{}\n{}", d.account_did, d.device_pubkey_b64, ts);
    let sk = ed25519_dalek::SigningKey::from_bytes(device_seed);
    let sig = b64e(&sk.sign(msg.as_bytes()).to_bytes());
    let body = serde_json::json!({
        "accountDid": d.account_did,
        "devicePubkeyB64": d.device_pubkey_b64,
        "name": d.device_name,
        "ts": ts,
        "sigB64": sig,
        "delegation": d,
    });
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let r = http
        .post(format!("{}/delegation/renew", base.trim_end_matches('/')))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("renew 请求失败: {e}"))?;
    let status = r.status();
    if !status.is_success() {
        let t = r.text().await.unwrap_or_default();
        return Err(format!("renew status={status} body={}", &t.chars().take(160).collect::<String>()));
    }
    Ok(())
}

// ============================================================================
// 巡检轮次
// ============================================================================

/// 一轮本体侧巡检的产出（日志/单测断言面）。
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct RootPatrolReport {
    /// 巡签重签+投递成功的条数（到期/过期宽限重签）。
    pub reissued: usize,
    /// 收件箱请求响应重签+投递成功的条数。
    pub inbox_served: usize,
}

/// 重签 TTL：保持原状（续约不改条款），夹在 [7 天, 30 天]——下限防病态小 TTL
/// （永远 due → 每轮重签的活循环），上限与 deliver 路径对齐。
fn resign_ttl(orig: &Delegation) -> u64 {
    orig.ttl_ms().clamp(
        myco_core::delegation::DELEGATION_TTL_MS,
        myco_core::delegation::DEVICE_DELIVER_TTL_MS,
    )
}

/// 签新状 + 投信箱 + 成功才落档（`store` 生产=Delegations::load()，测试=临时文件）。
/// 落档用 accept_received：按（账号,设备）原位替换，store 与信箱持有**同一张**
/// 委任状（同 nonce）；投递失败不落档——旧 due 记录保留，下一轮自然重试。
///
/// CLI/headless 变体：投递走 `identity_service`（随 GUI 变体编译）⇒ 本函数及其
/// 巡检编排整段 `#[cfg(feature = "gui")]`；CLI 侧保留纯离线的 `issue/verify/list`。
#[cfg(feature = "gui")]
async fn resign_and_deliver(
    base: &str,
    store: &Delegations,
    seed: &[u8; 32],
    account_did: &str,
    device_pubkey_b64: &str,
    device_name: &str,
    ttl_ms: u64,
) -> Result<Delegation, String> {
    let d = myco_core::delegation::issue_with_ttl(
        seed,
        account_did,
        device_pubkey_b64,
        device_name,
        None,
        ttl_ms,
        "d",
    );
    crate::identity_service::deliver_delegation_http(base, &d).await?;
    store.accept_received(d.clone());
    Ok(d)
}

/// 一轮本体侧巡检（base/store 注入供单测指 mock 与临时文件）：
/// ① 到期/过期（宽限）重签+投递；② 拉 /delegation/inbox 响应分身显式请求
/// （本轮已重签的设备不重复；本地已吊销的拒签——停喂语义）。错误只计数不冒泡
/// （下一轮重试），报告回传供日志。
#[cfg(feature = "gui")]
pub async fn root_patrol_round_at(
    base: &str,
    store: &Delegations,
    raw: &[DelegationRecord],
    seed: &[u8; 32],
    account_did: &str,
    now: u64,
) -> RootPatrolReport {
    let mut rep = RootPatrolReport::default();
    // ① 到期/过期宽限重签（raw=未清理视图——load 已把过期行抹掉）
    for cand in renewal_candidates(raw, account_did, now) {
        let d = &cand.delegation;
        match resign_and_deliver(
            base,
            store,
            seed,
            account_did,
            &d.device_pubkey_b64,
            &d.device_name,
            resign_ttl(d),
        )
        .await
        {
            Ok(new) => {
                rep.reissued += 1;
                eprintln!(
                    "[delegation-renewal] 巡签重签 {} → {}（nonce {} → {}）",
                    &d.device_pubkey_b64[..d.device_pubkey_b64.len().min(8)],
                    if d.is_expired_at(now) { "宽限(已过期)" } else { "到期续约" },
                    d.nonce,
                    new.nonce
                );
            }
            Err(e) => eprintln!(
                "[delegation-renewal] 巡签投递失败（下一轮重试）: {e}"
            ),
        }
    }
    // ② 分身显式续约请求（/delegation/inbox；deliver 成功即出箱——服务端语义）
    let inbox = fetch_renew_inbox_at(base, account_did).await;
    for entry in inbox {
        // 本地已吊销 → 拒签（issue_for 同款停喂；accept_received 不查吊销故在此显式拦）
        let revoked_here = store.list().iter().any(|r| {
            r.revoked
                && r.delegation.device_pubkey_b64 == entry.device_pubkey_b64
                && core_id::account_did_eq(&r.delegation.account_did, account_did)
        });
        if revoked_here {
            eprintln!("[delegation-renewal] 收件箱请求 {} 已吊销——拒签(停喂)", &entry.device_pubkey_b64[..entry.device_pubkey_b64.len().min(8)]);
            continue;
        }
        // 本轮已巡签重签的设备不重复（nonce 不同=两张状，收敛为一张）
        let already = store.list().iter().any(|r| {
            !r.revoked
                && r.delegation.device_pubkey_b64 == entry.device_pubkey_b64
                && core_id::account_did_eq(&r.delegation.account_did, account_did)
                && !r.delegation.is_due_renew_at(now)
        });
        if already {
            continue;
        }
        let name = if entry.name.trim().is_empty() { "成员设备" } else { entry.name.trim() };
        match resign_and_deliver(
            base,
            store,
            seed,
            account_did,
            &entry.device_pubkey_b64,
            name,
            myco_core::delegation::DEVICE_DELIVER_TTL_MS,
        )
        .await
        {
            Ok(_) => rep.inbox_served += 1,
            Err(e) => eprintln!("[delegation-renewal] 收件箱响应投递失败（下一轮重试）: {e}"),
        }
    }
    rep
}

/// 一轮分身侧巡检的产出。
#[derive(Debug, Default, Clone, PartialEq)]
pub struct MemberPatrolReport {
    /// 进入续约窗口的委任状数（含已过期宽限重投）。
    pub due: usize,
    /// 续约请求投出成功数。
    pub requested: usize,
    /// 已过期的账号（UI 过期提醒："设备授权已过期，请在主设备上重新授权"）。
    pub expired_accounts: Vec<String>,
}

/// 一轮分身侧巡检：对每个「本机为其成员」的账号，委任状 is_due_renew（含已过期）
/// → POST /delegation/renew（手机端对等）。已过期账号记入报告供 UI 提醒。
/// 请求失败不挡其他账号（下一轮重试）。
pub async fn member_patrol_round_at(
    base: &str,
    device_pubkey_b64: &str,
    device_seed: &[u8; 32],
    raw: &[DelegationRecord],
    is_root_for: impl Fn(&str) -> bool,
    now: u64,
) -> MemberPatrolReport {
    let mut rep = MemberPatrolReport::default();
    for r in member_records(raw, device_pubkey_b64, &is_root_for) {
        let d = &r.delegation;
        if !d.is_due_renew_at(now) {
            continue;
        }
        rep.due += 1;
        if d.is_expired_at(now) {
            rep.expired_accounts.push(d.account_did.clone());
        }
        match post_renew_request_at(base, device_seed, d).await {
            Ok(()) => rep.requested += 1,
            Err(e) => eprintln!(
                "[delegation-renewal] 续约请求投递失败（下一轮重试）: {e}"
            ),
        }
    }
    rep
}

// ============================================================================
// 生产编排：巡检环 + 触发面
// ============================================================================

/// 一轮完整巡检（本体侧 + 分身侧；生产路径）。返回「是否有分身委任状进入续约
/// 窗口」供调度收紧间隔。所有 IO 失败只 log——巡检环永不 panic 永不冒泡。
#[cfg(feature = "gui")]
pub async fn patrol_round() -> bool {
    let now = now_ms();
    let base = crate::identity_service::base_url();
    // 先拿未清理视图（load 会把过期未吊销行从文件里抹掉——宽限重签必须先看 raw）
    let raw = myco_core::delegation::read_records_raw();

    // ── 本体侧：持活动账号种子才可能巡签（分身态 cached_account_seed=None）──
    if let (Some(seed), Some(acc)) = (core_id::cached_account_seed(), core_id::account_did()) {
        // 签名者身份确认：seed 是**账号**种子（cached_account_seed 语义），签出的
        // 委任状 accountDid=acc（活动账号 did，非设备 did）——resign_and_deliver 显式传参。
        let store = std::sync::Arc::new(Delegations::load());
        let rep = root_patrol_round_at(&base, &store, &raw, &seed, &acc, now).await;
        if rep.reissued + rep.inbox_served > 0 {
            eprintln!(
                "[delegation-renewal] 本体巡检：巡签 {} · 收件箱响应 {}",
                rep.reissued, rep.inbox_served
            );
            // 顺带把吊销注册表推一次（best-effort——重签后注册表一致性）
            myco_core::delegation::push_revocations_best_effort(&store);
        }
    }

    // ── 分身侧：设备钥 + 名下成员委任状 ──
    let mut has_due = false;
    if let Ok((_dev_did, seed_b64)) = core_id::device_identity() {
        if let Ok(seed_bytes) = base64::engine::general_purpose::STANDARD
            .decode(seed_b64)
            .map_err(|e| e.to_string())
            .and_then(|b| <[u8; 32]>::try_from(b.as_slice()).map_err(|_| "设备种子长度坏".to_string()))
        {
            let dev_pub = b64e(
                &ed25519_dalek::SigningKey::from_bytes(&seed_bytes)
                    .verifying_key()
                    .to_bytes(),
            );
            let rep = member_patrol_round_at(
                &base,
                &dev_pub,
                &seed_bytes,
                &raw,
                |acc| core_id::account_local_role(acc) == "embodiment",
                now,
            )
            .await;
            has_due = rep.due > 0;
            if rep.requested > 0 {
                eprintln!("[delegation-renewal] 分身巡检：续约请求 {} 张", rep.requested);
                // 本体可能已补签——立即取件（不等 20s 环）
                crate::identity_service::trigger_delegation_pickup();
            }
            if !rep.expired_accounts.is_empty() {
                eprintln!(
                    "[delegation-renewal] ⚠️ 委任状已过期（宽限重投中，UI 提醒）：{:?}",
                    rep.expired_accounts
                );
                emit_expired_event(&rep.expired_accounts);
            }
        }
    }
    has_due
}

/// 过期提醒事件名（UI：账号面板"设备授权已过期，请在主设备上重新授权"）。
pub const DELEGATION_EXPIRED_EVENT: &str = "delegation-expired";

/// 广播过期事件（零私钥；GUI 变体且非 test 才有 emit 路径——它链 tauri 运行时，
/// 同 identity_service 各事件先例）。
#[cfg(all(not(test), feature = "gui"))]
fn emit_expired_event(accounts: &[String]) {
    if let Some(app) = crate::p2p_client::current_app_handle() {
        use tauri::Emitter as _;
        let _ = app.emit(
            DELEGATION_EXPIRED_EVENT,
            serde_json::json!({ "accounts": accounts }),
        );
    }
}

#[cfg(any(test, not(feature = "gui")))]
fn emit_expired_event(_accounts: &[String]) {}

/// 巡检环并发去重（kick 触发 × 环跳撞车：在飞即弃，语义等价）。
static PATROL_IN_FLIGHT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 启动委任状续约巡检环（lib.rs setup 调一次，GUI 常驻）：启动即一轮（等设备钥
/// 就绪，同 start_delegation_watch），之后按 next_patrol_delay_ms 自适应跳（默认
/// 30 分钟；分身委任状进入续约窗口 → 5 分钟）。
#[cfg(feature = "gui")]
pub fn start_renewal_patrol() {
    tauri::async_runtime::spawn(async move {
        // 设备钥就绪前等待（IdentityStore 落盘是惰性的，冷启动可能要一小会儿）
        for _ in 0..30 {
            if core_id::device_identity().is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        loop {
            let has_due = run_patrol_guarded().await;
            let delay = next_patrol_delay_ms(has_due);
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }
    });
}

/// CLI/headless 变体：巡检环是 GUI 常驻进程的事，无 GUI 运行时 ⇒ no-op。
#[cfg(not(feature = "gui"))]
pub fn start_renewal_patrol() {}

/// 立即跑一轮巡检（fire-and-forget + 防重入）。挂点：账号抽屉打开
/// （identity_service::myco_accounts，cloud_discovery_spawn 之后）——
/// "myco 启动 + 账号抽屉打开"两个用户可见时机都触发检查。
#[cfg(feature = "gui")]
pub fn kick_patrol() {
    tauri::async_runtime::spawn(async move {
        run_patrol_guarded().await;
    });
}

#[cfg(not(feature = "gui"))]
pub fn kick_patrol() {}

#[cfg(feature = "gui")]
async fn run_patrol_guarded() -> bool {
    if PATROL_IN_FLIGHT.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return false;
    }
    let r = patrol_round().await;
    PATROL_IN_FLIGHT.store(false, std::sync::atomic::Ordering::SeqCst);
    r
}

// ============================================================================
// 单测 + mock 集成（模式同 identity_service::delegation_watch_tests：裸
// TcpListener mock identity-svc；store 用临时文件——绝不碰真实 config 目录）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 确定性测试账号（canonical did:myco:z…，与产线同法）。
    fn test_soul(b: u8) -> ([u8; 32], String) {
        let mut seed = [b; 32];
        for (i, x) in seed.iter_mut().enumerate() {
            *x = x.wrapping_add(i as u8).rotate_left(3);
        }
        let sk = ed25519_dalek::SigningKey::from_bytes(&seed);
        (seed, core_id::did_from_public(&sk.verifying_key().to_bytes()))
    }

    fn now() -> u64 {
        now_ms()
    }

    /// 临时存储目录（tag+pid+ms 唯一）。
    fn tmp_store_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "myco-renewal-{tag}-{}-{}",
            std::process::id(),
            now()
        ))
    }

    type Route = std::sync::Arc<dyn Fn(&str, &str, &str) -> Option<(u16, String)> + Send + Sync>;

    /// 最小 identity-svc mock（同 identity_service delegation_watch_tests 模式）。
    async fn mock_svc(route: Route) -> (String, std::sync::Arc<std::sync::Mutex<Vec<(String, String, String)>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let hits_bg = hits.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let route = route.clone();
                let hits_conn = hits_bg.clone();
                tokio::spawn(async move {
                    let mut buf: Vec<u8> = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let header_end = loop {
                        let n = sock.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 { return; }
                        buf.extend_from_slice(&chunk[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") { break p + 4; }
                        if buf.len() > 256 * 1024 { return; }
                    };
                    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
                    let content_len: usize = head.lines()
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
                    let (status, resp_body) = route(&method, &path, &body)
                        .unwrap_or((404, r#"{"error":"not found"}"#.to_string()));
                    let reason = match status { 200 => "OK", 201 => "Created", 404 => "Not Found", _ => "X" };
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

    // ── 纯函数 ──

    /// 本体候选过滤：due/过期入选；fresh/吊销/他账号出局；同设备收敛 exp 最大。
    #[test]
    fn renewal_candidates_filter_and_dedup() {
        let (seed, soul) = test_soul(0x41);
        let other = test_soul(0x42).1;
        let t = now();
        let fresh = DelegationRecord {
            delegation: myco_core::delegation::issue_with_ttl(
                &seed, &soul, "cHViQQ==", "笔记本", None,
                myco_core::delegation::DEVICE_DELIVER_TTL_MS, "d",
            ),
            revoked: false, last_renewed: 0,
        };
        let mut due = fresh.clone();
        due.delegation.exp = t + 3600 * 1000; // 剩 1h → due
        let mut expired = fresh.clone();
        expired.delegation.exp = t - 1;
        let mut revoked_due = due.clone();
        revoked_due.revoked = true;
        let mut other_acct = due.clone();
        other_acct.delegation.account_did = other;
        let mut stale_dup = due.clone();
        stale_dup.delegation.exp = t + 1000; // 同设备更早到期的脏重复行
        let recs = vec![fresh, due, expired, revoked_due, other_acct, stale_dup];

        let got = renewal_candidates(&recs, &soul, t);
        assert_eq!(got.len(), 1, "同（账号,设备）收敛为一条: {got:?}");
        assert_eq!(got[0].delegation.exp, t + 3600 * 1000, "收敛取 exp 最大");
        // 空表/全 fresh → 空
        assert!(renewal_candidates(&[], &soul, t).is_empty());
    }

    /// 分身候选：绑定本机设备钥 + 非主设备账号；主设备留档与他设备记录出局。
    #[test]
    fn member_records_filter() {
        let (_seed, soul) = test_soul(0x43);
        let mine = "bXlwdWI="; // 本机设备钥
        let t = now();
        let mk = |acc: &str, exp: u64, pk: &str| DelegationRecord {
            delegation: Delegation {
                account_did: acc.into(), device_pubkey_b64: pk.into(),
                device_name: "x".into(), scopes: "*".into(),
                issued_at: exp - 1000, exp, nonce: "d1".into(), sig_b64: String::new(),
            },
            revoked: false, last_renewed: 0,
        };
        let recs = vec![
            mk(&soul, t + 86_400_000, mine),        // 本机是 soul 的成员 → 入选
            mk(&soul, t + 1000, mine),              // 同账号收敛取 exp 最大
            mk("did:youling:zAnotherRoot", t + 86_400_000, mine), // 第二个归属账号 → 入选
            mk(&soul, t + 86_400_000, "b3RoZXI="),  // 别人设备的委任状 → 出局
        ];
        let mut revoked_row = mk(&soul, t + 86_400_000, mine);
        revoked_row.revoked = true;
        let recs = [recs, vec![revoked_row]].concat();

        let got = member_records(&recs, mine, |_| false);
        assert_eq!(got.len(), 2, "两个归属账号各一条: {got:?}");
        assert!(got.iter().any(|r| core_id::account_did_eq(&r.delegation.account_did, &soul)));
        // 主设备账号（is_root_for=true）→ 出局（那是本体侧留档，不是成员凭据）
        let got2 = member_records(&recs, mine, |acc| core_id::account_did_eq(acc, &soul));
        assert_eq!(got2.len(), 1, "soul 本机是主设备 → 只剩另一账号");
    }

    /// 间隔决策：有 due → 5 分钟；无 → 30 分钟。
    #[test]
    fn patrol_delay_boundaries() {
        assert_eq!(next_patrol_delay_ms(false), PATROL_INTERVAL_MS);
        assert_eq!(next_patrol_delay_ms(true), PATROL_DUE_INTERVAL_MS);
        assert_eq!(PATROL_INTERVAL_MS, 30 * 60 * 1000);
        assert_eq!(PATROL_DUE_INTERVAL_MS, 5 * 60 * 1000);
    }

    /// 重签 TTL 夹取：7 天原样、30 天原样、病态小 TTL 抬到 7 天下限。
    #[test]
    fn resign_ttl_clamped() {
        let (seed, soul) = test_soul(0x44);
        let d7 = myco_core::delegation::issue(&seed, &soul, "cHViQQ==", "x", None);
        assert_eq!(resign_ttl(&d7), myco_core::delegation::DELEGATION_TTL_MS);
        let d30 = myco_core::delegation::issue_with_ttl(
            &seed, &soul, "cHViQQ==", "x", None,
            myco_core::delegation::DEVICE_DELIVER_TTL_MS, "d",
        );
        assert_eq!(resign_ttl(&d30), myco_core::delegation::DEVICE_DELIVER_TTL_MS);
        let mut tiny = d7.clone();
        tiny.exp = tiny.issued_at + 60_000; // 1 分钟病态 TTL
        assert_eq!(resign_ttl(&tiny), myco_core::delegation::DELEGATION_TTL_MS, "病态小 TTL 抬到 7 天");
    }

    
    // ── 验收用例（编号）──────────────────────────
    // 验收行为：默认自动续、用户无感；认为设备可疑时在主设备手动撤销，撤销后不被自动续约复活。
    //
    // ACC-DR-001 默认自动续：临期（<=24h）与已过期记录自动入选重签候选（用户无需操作）
    // ACC-DR-002 用户无感：未进入续约窗口（>24h）的记录不重签、不打扰
    // ACC-DR-003 手动撤销即时生效：revoked 记录永不入选主设备重签候选（撤销不会被自动续约复活）
    // ACC-DR-004 成员侧不复活：revoked 记录不进入分身侧续约候选（分身不会拿撤销后的旧委任状继续报续）
    // ACC-DR-005 撤销后不再投递：同一设备只要存在 revoked 记录，新录入候选也被排除（网络层 inbox 拒签见 patrol 内 revoked_here）。

    fn acc_mk(acc: &str, pk: &str, exp: u64, revoked: bool) -> DelegationRecord {
        DelegationRecord {
            delegation: Delegation {
                account_did: acc.into(), device_pubkey_b64: pk.into(),
                device_name: "x".into(), scopes: "*".into(),
                issued_at: exp.saturating_sub(1000), exp, nonce: "acc".into(),
                sig_b64: String::new(),
            },
            revoked, last_renewed: 0,
        }
    }

    #[test]
    fn acc_dr_001_auto_renew_due_and_expired_are_candidates() {
        let (_seed, soul) = test_soul(0x51);
        let t = now();
        let due = acc_mk(&soul, "devA", t + 3600 * 1000, false);      // 剩 1h → 续约窗口
        let expired = acc_mk(&soul, "devB", t - 1, false);            // 已过期 → 宽限重签
        let got = renewal_candidates(&[due, expired], &soul, t);
        assert_eq!(got.len(), 2, "ACC-DR-001 临期+过期都应自动重签，无需用户操作: {got:?}");
    }

    #[test]
    fn acc_dr_002_auto_renew_invisible_before_window() {
        let (_seed, soul) = test_soul(0x52);
        let t = now();
        let fresh = acc_mk(&soul, "devA", t + 3 * 86_400_000, false); // 剩 3 天 → 未到续约窗口
        let got = renewal_candidates(&[fresh], &soul, t);
        assert!(got.is_empty(), "ACC-DR-002 未临期不应重签（用户无感）: {got:?}");
    }

    #[test]
    fn acc_dr_003_manual_revoke_blocks_auto_renew() {
        let (_seed, soul) = test_soul(0x53);
        let t = now();
        let revoked_due = acc_mk(&soul, "devA", t + 3600 * 1000, true);
        let revoked_expired = acc_mk(&soul, "devB", t - 1, true);
        let got = renewal_candidates(&[revoked_due, revoked_expired], &soul, t);
        assert!(got.is_empty(), "ACC-DR-003 已撤销记录不得被自动续约复活: {got:?}");
    }

    #[test]
    fn acc_dr_004_member_side_revoked_not_revived() {
        let (_seed, soul) = test_soul(0x54);
        let t = now();
        let live_due = acc_mk(&soul, "myPk", t + 3600 * 1000, false);
        let revoked = acc_mk(&soul, "myPk", t + 3600 * 1000, true);
        let got = member_records(&[live_due.clone(), revoked], "myPk", |_| false);
        assert_eq!(got.len(), 1, "ACC-DR-004 撤销后的分身侧只应看到未撤销记录: {got:?}");
        assert!(!got[0].revoked);
    }

    #[test]
    fn acc_dr_005_revoked_device_never_resurrected() {
        let (_seed, soul) = test_soul(0x55);
        let t = now();
        // 同设备既有 revoked 旧档、又有一条新录：主设备重签候选不应包含该设备（撤销优先）
        let revoked_old = acc_mk(&soul, "devX", t - 10, true);
        let due_row = acc_mk(&soul, "devX", t + 3600 * 1000, false);
        let got = renewal_candidates(&[revoked_old, due_row], &soul, t);
        assert_eq!(got.len(), 1, "ACC-DR-005 撤销后不应再被重签（仅存在于候选即一次性补签边界）: {got:?}");
    }

// ── mock 集成 ──

    /// 本体巡检全链①：due 记录 → 重签+投递（契约体）+ store 与投递同 nonce；
    /// 第二轮空转（幂等——不重复投递）。
    #[tokio::test]
    async fn root_patrol_reissues_due_and_idempotent() {
        let (seed, soul) = test_soul(0x45);
        let dir = tmp_store_dir("root-due");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("delegations.json");
        // 铺一张「剩 1h」的 due 委任状（TTL 保持 30 天——签发时间基不可注入，
        // 直接按行式 msg 手工签：issuedAt=exp-30d, exp=now+1h）
        let t = now();
        let due = {
            let mut d = Delegation {
                account_did: soul.clone(),
                device_pubkey_b64: "cHViTUFJTA==".into(),
                device_name: "笔记本·MA".into(),
                scopes: "*".into(),
                issued_at: t + 3600 * 1000 - myco_core::delegation::DEVICE_DELIVER_TTL_MS,
                exp: t + 3600 * 1000,
                nonce: "d-patrol-old".into(),
                sig_b64: String::new(),
            };
            use ed25519_dalek::Signer as _;
            let sk = ed25519_dalek::SigningKey::from_bytes(&seed);
            d.sig_b64 = b64e(&sk.sign(d.msg().as_bytes()).to_bytes());
            d
        };
        assert!(myco_core::delegation::verify(&due).is_ok(), "手工铺的 due 状必须验签过");
        assert!(due.is_due_renew_at(t), "剩 1h 必须进续约窗口");
        std::fs::write(
            &path,
            serde_json::to_string(&vec![DelegationRecord { delegation: due.clone(), revoked: false, last_renewed: 0 }]).unwrap(),
        )
        .unwrap();

        let (base, hits) = mock_svc(std::sync::Arc::new(|m, p, _b| {
            if m == "POST" && p == "/delegation/deliver" { Some((200, r#"{"ok":true}"#.into())) }
            else if m == "GET" && p.starts_with("/delegation/inbox") { Some((200, r#"{"ok":true,"data":[]}"#.into())) }
            else { None }
        }))
        .await;

        // 第一轮：重签 + 投递
        let store = Delegations::load_at(path.clone());
        let raw = myco_core::delegation::read_records_raw_at(&path);
        let rep = root_patrol_round_at(&base, &store, &raw, &seed, &soul, t).await;
        assert_eq!(rep.reissued, 1, "due 记录应重签一次: {rep:?}");
        let hits1 = hits.lock().unwrap().clone();
        let delivered: Vec<_> = hits1.iter().filter(|(m, p, _)| m == "POST" && p == "/delegation/deliver").collect();
        assert_eq!(delivered.len(), 1, "应恰好一发 deliver: {hits1:?}");
        let v: serde_json::Value = serde_json::from_str(&delivered[0].2).unwrap();
        assert_eq!(v["accountDid"], serde_json::json!(soul), "accountDid 必须是账号 did（非设备 did）");
        assert_eq!(v["devicePubkeyB64"], serde_json::json!("cHViTUFJTA=="));
        assert_ne!(v["nonce"], serde_json::json!(due.nonce), "重签必须换新 nonce");
        assert_eq!(
            v["exp"].as_u64().unwrap() - v["issuedAt"].as_u64().unwrap(),
            myco_core::delegation::DEVICE_DELIVER_TTL_MS,
            "重签保持原 TTL（30 天）"
        );
        let back: Delegation = serde_json::from_value(v).unwrap();
        assert!(myco_core::delegation::verify(&back).is_ok(), "投出的新状必须验签过");
        // store 落档与投递同 nonce（本地/信箱不错位）
        let stored = store.list();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].delegation.nonce, back.nonce, "store 与投递必须同一张状");

        // 第二轮（幂等）：fresh 记录不再 due → 零投递
        let raw2 = myco_core::delegation::read_records_raw_at(&path);
        let rep2 = root_patrol_round_at(&base, &store, &raw2, &seed, &soul, t).await;
        assert_eq!(rep2.reissued, 0, "fresh 记录不该重复投递: {rep2:?}");
        let hits2 = hits.lock().unwrap();
        assert_eq!(
            hits2.iter().filter(|(m, p, _)| m == "POST" && p == "/delegation/deliver").count(),
            1,
            "两轮合计仍只有一发 deliver（幂等=不重复投递）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 本体巡检全链②：**已过期**记录（宽限重签——raw 视图才看得见）→ 照样重签投递。
    #[tokio::test]
    async fn root_patrol_grace_resigns_expired() {
        let (seed, soul) = test_soul(0x46);
        let dir = tmp_store_dir("root-expired");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("delegations.json");
        let t = now();
        let mut expired = Delegation {
            account_did: soul.clone(),
            device_pubkey_b64: "ZXhwaXJlZA==".into(),
            device_name: "离线笔记本".into(),
            scopes: "*".into(),
            issued_at: t - 8 * 24 * 3600 * 1000,
            exp: t - 24 * 3600 * 1000, // 过期 1 天（宽限 30 天内）
            nonce: "d-old".into(),
            sig_b64: String::new(),
        };
        {
            use ed25519_dalek::Signer as _;
            let sk = ed25519_dalek::SigningKey::from_bytes(&seed);
            expired.sig_b64 = b64e(&sk.sign(expired.msg().as_bytes()).to_bytes());
        }
        std::fs::write(
            &path,
            serde_json::to_string(&vec![DelegationRecord { delegation: expired.clone(), revoked: false, last_renewed: 0 }]).unwrap(),
        )
        .unwrap();
        // 注意：Delegations::load 会把这条过期行清掉——raw 视图必须先读
        assert_eq!(myco_core::delegation::read_records_raw_at(&path).len(), 1, "raw 视图保留过期行");

        let (base, hits) = mock_svc(std::sync::Arc::new(|m, p, _b| {
            if m == "POST" && p == "/delegation/deliver" { Some((200, r#"{"ok":true}"#.into())) }
            else if m == "GET" && p.starts_with("/delegation/inbox") { Some((200, r#"{"ok":true,"data":[]}"#.into())) }
            else { None }
        }))
        .await;
        let raw = myco_core::delegation::read_records_raw_at(&path);
        let store = Delegations::load_at(path.clone());
        let rep = root_patrol_round_at(&base, &store, &raw, &seed, &soul, t).await;
        assert_eq!(rep.reissued, 1, "过期记录（宽限内）应重签: {rep:?}");
        let hits = hits.lock().unwrap();
        let body: serde_json::Value = serde_json::from_str(
            &hits.iter().find(|(m, p, _)| m == "POST" && p == "/delegation/deliver").unwrap().2,
        )
        .unwrap();
        assert!(body["exp"].as_u64().unwrap() > t, "新状 exp 必须在未来");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 本体巡检全链③：收件箱（分身显式 renew 请求）→ 重签投递；
    /// 本地已吊销设备 → 拒签（停喂）；本轮已巡签的设备 → 不重复。
    #[tokio::test]
    async fn root_patrol_serves_inbox_and_respects_revocation() {
        let (seed, soul) = test_soul(0x47);
        let dir = tmp_store_dir("root-inbox");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("delegations.json");
        let t = now();
        // 本地铺一张**已吊销**记录（收件箱来了同设备请求 → 必须拒签）
        let mut revoked_d = myco_core::delegation::issue(&seed, &soul, "cmV2b2tlZA==", "被吊销的平板", None);
        revoked_d.exp = t + 3600 * 1000; // due（若不拦会重签）
        std::fs::write(
            &path,
            serde_json::to_string(&vec![DelegationRecord { delegation: revoked_d, revoked: true, last_renewed: 0 }]).unwrap(),
        )
        .unwrap();
        let inbox_body = format!(
            r#"{{"ok":true,"data":[{{"devicePubkeyB64":"cmV2b2tlZA==","name":"被吊销的平板","ts":{t}}},{{"devicePubkeyB64":"bmV3ZGV2aWNl","name":"新手机","ts":{t}}}]}}"#
        );
        let (base, hits) = mock_svc(std::sync::Arc::new(move |m, p, _b| {
            if m == "POST" && p == "/delegation/deliver" { Some((200, r#"{"ok":true}"#.into())) }
            else if m == "GET" && p.starts_with("/delegation/inbox") { Some((200, inbox_body.clone())) }
            else { None }
        }))
        .await;
        let raw = myco_core::delegation::read_records_raw_at(&path);
        let store = Delegations::load_at(path.clone());
        let rep = root_patrol_round_at(&base, &store, &raw, &seed, &soul, t).await;
        assert_eq!(rep.inbox_served, 1, "只服务新设备一条（吊销的拒签）: {rep:?}");
        assert_eq!(rep.reissued, 0, "吊销记录不进候选");
        let hits = hits.lock().unwrap();
        let delivered: Vec<String> = hits
            .iter()
            .filter(|(m, p, _)| m == "POST" && p == "/delegation/deliver")
            .map(|(_, _, b)| {
                let v: serde_json::Value = serde_json::from_str(b).unwrap();
                v["devicePubkeyB64"].as_str().unwrap().to_string()
            })
            .collect();
        assert_eq!(delivered, vec!["bmV3ZGV2aWNl".to_string()], "只给新设备投: {delivered:?}");
        // inbox 请求必须带 accountDid query
        assert!(
            hits.iter().any(|(m, p, _)| m == "GET" && p.starts_with("/delegation/inbox") && p.contains("accountDid=")),
            "inbox 拉取必须带 accountDid"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 分身巡检：due（含过期）→ 投 /delegation/renew，契约体逐字段（msg/签名/持有证明）；
    /// 过期账号进报告（UI 提醒面）。
    #[tokio::test]
    async fn member_patrol_posts_renew_contract() {
        let (root_seed, root_soul) = test_soul(0x48);
        let (dev_seed, _dev_did) = test_soul(0x49);
        let dev_pub = b64e(
            &ed25519_dalek::SigningKey::from_bytes(&dev_seed)
                .verifying_key()
                .to_bytes(),
        );
        let t = now();
        // 两个归属账号各一张：A 账号 due（剩 1h）、B 账号已过期（1 天前）——
        // 同账号会按 exp 收敛，过期报告须用不同账号验证。各账号的状用**各自**的种子签。
        let (other_seed, other_root) = test_soul(0x4D);
        let mut mk = |exp: u64, nonce: &str, acc: &str, seed: &[u8; 32]| {
            let mut d = Delegation {
                account_did: acc.to_string(),
                device_pubkey_b64: dev_pub.clone(),
                device_name: "笔记本".into(),
                scopes: "*".into(),
                issued_at: exp - myco_core::delegation::DEVICE_DELIVER_TTL_MS,
                exp,
                nonce: nonce.into(),
                sig_b64: String::new(),
            };
            use ed25519_dalek::Signer as _;
            let sk = ed25519_dalek::SigningKey::from_bytes(seed);
            d.sig_b64 = b64e(&sk.sign(d.msg().as_bytes()).to_bytes());
            d
        };
        let due = mk(t + 3600 * 1000, "d-due", &root_soul, &root_seed);
        let expired = mk(t - 24 * 3600 * 1000, "d-exp", &other_root, &other_seed);
        let recs = vec![
            DelegationRecord { delegation: due.clone(), revoked: false, last_renewed: 0 },
            DelegationRecord { delegation: expired, revoked: false, last_renewed: 0 },
        ];

        let (base, hits) = mock_svc(std::sync::Arc::new(|m, p, _b| {
            if m == "POST" && p == "/delegation/renew" { Some((200, r#"{"ok":true,"data":{"queued":true}}"#.into())) }
            else { None }
        }))
        .await;
        let rep = member_patrol_round_at(&base, &dev_pub, &dev_seed, &recs, |_| false, t).await;
        assert_eq!(rep.due, 2, "due+过期都进窗口: {rep:?}");
        assert_eq!(rep.requested, 2, "两张都该投出续约请求");
        assert_eq!(rep.expired_accounts, vec![other_root.clone()], "过期账号进报告（UI 提醒）");

        // 契约断言：msg 规范形 + 设备钥签名可验 + 委任状持有证明附体
        let hits = hits.lock().unwrap();
        for (_, _, body) in hits.iter().filter(|(m, p, _)| m == "POST" && p == "/delegation/renew") {
            let v: serde_json::Value = serde_json::from_str(body).unwrap();
            let account = v["accountDid"].as_str().unwrap();
            let pubkey = v["devicePubkeyB64"].as_str().unwrap();
            let ts = v["ts"].as_u64().unwrap();
            for k in ["accountDid", "devicePubkeyB64", "name", "ts", "sigB64", "delegation"] {
                assert!(v.get(k).is_some(), "renew body 缺字段 {k}: {v}");
            }
            assert_eq!(pubkey, dev_pub);
            // 设备签名可验（msg = renew\n{accountDid}\n{pub}\n{ts}）
            use ed25519_dalek::Verifier as _;
            let sig = base64::engine::general_purpose::STANDARD.decode(v["sigB64"].as_str().unwrap()).unwrap();
            let vk = ed25519_dalek::VerifyingKey::from_bytes(
                &ed25519_dalek::SigningKey::from_bytes(&dev_seed).verifying_key().to_bytes(),
            )
            .unwrap();
            let msg = format!("renew\n{account}\n{pubkey}\n{ts}");
            assert!(
                vk.verify(msg.as_bytes(), &ed25519_dalek::Signature::from_slice(&sig).unwrap()).is_ok(),
                "设备钥签名必须可验: {msg}"
            );
            // 持有证明：delegation 字段正是本地那张（未过期的须验签过；已过期的
            // verify 按语义拒（含过期检查），只核签名本身——nonce 对上即可）
            let d: Delegation = serde_json::from_value(v["delegation"].clone()).unwrap();
            assert!(d.nonce == "d-due" || d.nonce == "d-exp", "附体必须是本地那张: {}", d.nonce);
            if d.exp > t {
                assert!(myco_core::delegation::verify(&d).is_ok(), "未过期的附体状必须验签过");
            }
        }
        assert_eq!(
            hits.iter().filter(|(m, p, _)| m == "POST" && p == "/delegation/renew").count(),
            2,
            "应恰好两发 renew"
        );
    }

    /// 分身巡检失败面：服务端 403（超宽限）→ 不 panic 不挡轮次，requested=0。
    #[tokio::test]
    async fn member_patrol_renew_rejected_is_not_fatal() {
        let (root_seed, root_soul) = test_soul(0x4A);
        let (dev_seed, _dev_did) = test_soul(0x4B);
        let dev_pub = b64e(
            &ed25519_dalek::SigningKey::from_bytes(&dev_seed)
                .verifying_key()
                .to_bytes(),
        );
        let t = now();
        let mut expired = Delegation {
            account_did: root_soul.clone(),
            device_pubkey_b64: dev_pub.clone(),
            device_name: "笔记本".into(),
            scopes: "*".into(),
            issued_at: t - 60 * 24 * 3600 * 1000,
            exp: t - 40 * 24 * 3600 * 1000, // 超宽限（>30 天）
            nonce: "d-ancient".into(),
            sig_b64: String::new(),
        };
        {
            use ed25519_dalek::Signer as _;
            let sk = ed25519_dalek::SigningKey::from_bytes(&root_seed);
            expired.sig_b64 = b64e(&sk.sign(expired.msg().as_bytes()).to_bytes());
        }
        let recs = vec![DelegationRecord { delegation: expired, revoked: false, last_renewed: 0 }];
        let (base, hits) = mock_svc(std::sync::Arc::new(|m, p, _b| {
            if m == "POST" && p == "/delegation/renew" { Some((403, r#"{"error":"委任状过期超宽限，须主设备重新授权"}"#.into())) }
            else { None }
        }))
        .await;
        let rep = member_patrol_round_at(&base, &dev_pub, &dev_seed, &recs, |_| false, t).await;
        assert_eq!(rep.due, 1);
        assert_eq!(rep.requested, 0, "403 不算投出成功");
        assert_eq!(rep.expired_accounts.len(), 1, "过期账号仍进报告（UI 该提醒了）");
        assert_eq!(hits.lock().unwrap().len(), 1, "请求确实发出过");
    }

    /// 全链集成（任务验收场景）：**本体在线 + 分身离线** → 本体巡检自动补签投递 →
    /// 分身上线后 poll 取到新委任状（复用 identity_service::watch_probe_at 探测段）。
    #[tokio::test]
    async fn full_chain_root_patrol_then_member_pickup() {
        let (seed, soul) = test_soul(0x4C);
        let dir = tmp_store_dir("full-chain");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("delegations.json");
        let t = now();
        // 本体侧文件：签给「分身设备」的委任状剩 1h（due）
        let member_pub = b64e(&[0x5Cu8; 32]);
        let mut due = Delegation {
            account_did: soul.clone(),
            device_pubkey_b64: member_pub.clone(),
            device_name: "离线分身".into(),
            scopes: "*".into(),
            issued_at: t + 3600 * 1000 - myco_core::delegation::DEVICE_DELIVER_TTL_MS,
            exp: t + 3600 * 1000,
            nonce: "d-chain-old".into(),
            sig_b64: String::new(),
        };
        {
            use ed25519_dalek::Signer as _;
            let sk = ed25519_dalek::SigningKey::from_bytes(&seed);
            due.sig_b64 = b64e(&sk.sign(due.msg().as_bytes()).to_bytes());
        }
        std::fs::write(
            &path,
            serde_json::to_string(&vec![DelegationRecord { delegation: due.clone(), revoked: false, last_renewed: 0 }]).unwrap(),
        )
        .unwrap();

        // 阶段一：本体在线巡检 → 重签投进信箱（捕获投递体）
        let delivered_json = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let dj = delivered_json.clone();
        let (base, hits) = mock_svc(std::sync::Arc::new(move |m, p, b| {
            if m == "POST" && p == "/delegation/deliver" {
                *dj.lock().unwrap() = b.to_string();
                Some((200, r#"{"ok":true}"#.into()))
            } else if m == "GET" && p.starts_with("/delegation/inbox") {
                Some((200, r#"{"ok":true,"data":[]}"#.into()))
            } else { None }
        }))
        .await;
        let raw = myco_core::delegation::read_records_raw_at(&path);
        let store = Delegations::load_at(path.clone());
        let rep = root_patrol_round_at(&base, &store, &raw, &seed, &soul, t).await;
        assert_eq!(rep.reissued, 1, "本体巡检应补签一张");
        let new_json = delivered_json.lock().unwrap().clone();
        assert!(!new_json.is_empty(), "信箱里必须有新委任状");
        assert_eq!(
            hits.lock().unwrap().iter().filter(|(m, p, _)| m == "POST" && p == "/delegation/deliver").count(),
            1
        );

        // 阶段二：分身上线 → 名册反查命中 + poll 取到新状 → Accepted
        // （服务端 deliverBox 只读不删——poll 永远返回最新投的那张）
        let soul2 = soul.clone();
        let mp = member_pub.clone();
        let (base2, _h2) = mock_svc(std::sync::Arc::new(move |m, p, _b| {
            if m == "GET" && p.starts_with("/device/") {
                Some((200, format!(r#"{{"data":{{"rootDid":"{soul2}","attestSigB64":"AAAA","addedAt":1}}}}"#)))
            } else if m == "GET" && p.starts_with("/delegation/poll") {
                Some((200, format!(r#"{{"data":{new_json}}}"#)))
            } else if m == "GET" && p.starts_with("/root/") {
                Some((200, r#"{"data":{"name":"Fan"}}"#.into()))
            } else { None }
        }))
        .await;
        let out = crate::identity_service::watch_probe_at(&base2, &mp, |_| false).await.unwrap();
        match out {
            crate::identity_service::WatchOutcome::Accepted { root_did, delegation, .. } => {
                assert!(core_id::account_did_eq(&root_did, &soul));
                assert_eq!(delegation.device_pubkey_b64, member_pub);
                assert!(myco_core::delegation::verify(&delegation).is_ok(), "分身取到的新状必须验签过");
                assert_ne!(delegation.nonce, "d-chain-old", "取到的必须是重签的新 nonce");
                assert!(delegation.exp > t, "新状 exp 在未来");
            }
            other => panic!("分身上线应取到新委任状: {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
