//! identity_service.rs — 第63轮 env 合并：身份/设备/委任状服务编进 home。
//! 底层原语复用 myco-core，本模块只做 Tauri command 包装 + 账号级签名。

use base64::Engine as _;
use ed25519_dalek::Signer as _;
use myco_core::identity as core_id;

const DEFAULT_BASE_URL: &str = "https://myco.youling.cc/myco-id";

/// identity-svc 基址（环境 MYCO_DID_BASE / 默认线上）。pub(crate)：委任状续约
/// 巡检（delegation_renewal.rs）与本地管理面共用同一配置源。
pub(crate) fn base_url() -> String {
    std::env::var("MYCO_DID_BASE").unwrap_or_else(|_| DEFAULT_BASE_URL.into())
}

// ── 2026-11-03 开源配置化（Phase 1）：平台/下载/ENV 基址集中在此 ──
// 自部署时设 MYCO_NETWORK_URL / MYCO_DOWNLOADS_URL / MYCO_ENV_API_BASE 环境变量即可。

/// 平台页基址（www.youling.cc，探索/任务/登录）
pub(crate) fn network_url() -> String {
    std::env::var("MYCO_NETWORK_URL")
        .unwrap_or_else(|_| "https://www.youling.cc".into())
        .trim_end_matches('/').to_string()
}

/// 下载面基址（myco.youling.cc，发版/工具页/任务卡）
pub(crate) fn downloads_url() -> String {
    std::env::var("MYCO_DOWNLOADS_URL")
        .unwrap_or_else(|_| "https://myco.youling.cc".into())
        .trim_end_matches('/').to_string()
}

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
// Tauri Commands
// ============================================================================

#[tauri::command]
pub async fn identity_get() -> Result<serde_json::Value, String> {
    core_id::identity_get_impl().await
}

#[tauri::command]
pub async fn myco_get() -> Result<serde_json::Value, String> {
    let device_did = core_id::local_did();
    let host = std::env::var("COMPUTERNAME").unwrap_or_default();
    if let Some(root) = core_id::account_did() {
        let name = core_id::account_name().await.unwrap_or_default();
        // 角色=本机凭据动态判定（2026-10-10 多归属显示面收口）：active.txt 指向
        // 成员账号时此处曾硬编码 embodiment——顶栏/账号页徽章误显「主设备」。
        let role = core_id::account_local_role(&root);
        return Ok(serde_json::json!({
            "rootDid": root, "deviceDid": device_did,
            "role": role, "hostName": host, "name": name
        }));
    }
    Ok(serde_json::json!({
        "rootDid": serde_json::Value::Null, "deviceDid": device_did,
        "role": "unlinked", "hostName": host, "name": ""
    }))
}

#[tauri::command]
pub async fn myco_list_devices() -> Result<serde_json::Value, String> {
    let ov = core_id::account_list_devices().await?;
    Ok(serde_json::json!({"name": ov.name, "backedUp": ov.backed_up, "devices": ov.devices}))
}

#[tauri::command]
pub async fn myco_set_backed_up() -> Result<(), String> {
    core_id::account_set_backed_up().await
}

#[tauri::command]
pub async fn myco_create(name: Option<String>, password: Option<String>) -> Result<serde_json::Value, String> {
    let info = core_id::account_create(name, password, None, None).await?;
    Ok(serde_json::json!({"rootDid": info.root_did, "deviceDid": info.device_did}))
}

#[tauri::command]
pub async fn myco_accounts() -> Result<serde_json::Value, String> {
    let mut list = core_id::accounts_load_with_roles();
    // 当前账号兜底入列：历史创建路径可能没 upsert（本机实况——当前账号不在清单里，
    // 抽屉会看不到"自己"）。以服务端名为准，失败用占位名。
    if let Some(active) = core_id::account_did() {
        let cur_name = list
            .iter()
            .find(|a| a.get("did").and_then(|d| d.as_str()) == Some(active.as_str()))
            .and_then(|a| a.get("name").and_then(|n| n.as_str()))
            .map(|n| n.to_string());
        let server_name = core_id::account_name().await;
        // 自愈：缺失入列；在列但名字落后于服务端（改名后清单未跟）→ 以服务端为准刷新
        let need_add = cur_name.is_none();
        let need_rename = matches!(
            (&cur_name, &server_name),
            (Some(local), Some(server)) if local != server
        );
        if need_add || need_rename {
            let name = server_name.unwrap_or_else(|| "有灵账号".into());
            core_id::accounts_upsert(&active, &name);
            list = core_id::accounts_load_with_roles();
        }
    }
    // 委任状自动发现（2026-10-09 设备最后一公里）：抽屉打开顺带触发一轮后台发现
    // （fire-and-forget + 防重入；云名册在而本地有验得过委任状的账号自动入列——
    // 启动面挂在 core account_status，这里是第二挂点，覆盖「启动后才被收编」的窗口）。
    // 新账号入列后下一次清单刷新即见。
    core_id::cloud_discovery_spawn();
    // 委任状续约巡检（2026-10-11 分身静默过期缺口）：抽屉打开顺带踢一轮巡检
    // （fire-and-forget + 防重入——本体巡签/分身续约请求，详见 delegation_renewal.rs；
    // 与上面的发现环互补：发现管「新收编」，巡检管「存量续命」）。
    crate::delegation_renewal::kick_patrol();
    Ok(serde_json::json!({ "accounts": list }))
}

/// 委任状自动发现（手动触发面，2026-10-09 设备最后一公里）：同步跑一轮
/// core::discover_cloud_accounts_at 并回处置明细——验收/调试用。
/// 自动面：core::account_status（启动即被前端调）+ myco_accounts（抽屉刷新）。
/// 笔记本验收法：myco devtools/console 执行
///   `await __TAURI_INTERNALS__.invoke('myco_discover_accounts')`
/// → `{"outcome":"report","joined":[{"did":"…","name":"CJ26"}],…}` 即通；
/// 服务器不可达回 `{"outcome":"unreachable"}`——静默语义，不抛错。
#[tauri::command]
pub async fn myco_discover_accounts() -> Result<serde_json::Value, String> {
    let run = core_id::discover_cloud_accounts_at(&base_url()).await;
    Ok(match run {
        core_id::CloudDiscoveryRun::Report(r) => serde_json::json!({
            "outcome": "report",
            "joined": r.joined.iter().map(|(d, n)| serde_json::json!({ "did": d, "name": n })).collect::<Vec<_>>(),
            "alreadyListed": r.already_listed,
            "noDelegation": r.no_delegation,
        }),
        core_id::CloudDiscoveryRun::NotOnRoster => serde_json::json!({ "outcome": "notOnRoster" }),
        core_id::CloudDiscoveryRun::Unreachable => serde_json::json!({ "outcome": "unreachable" }),
    })
}

#[tauri::command]
pub async fn myco_export_seed() -> Result<String, String> {
    core_id::account_export_seed().await
}

// ============================================================================
// 账号密码（env→home identityStore 迁移阻塞项：UI invoke 名固定为 myco_status/
// myco_unlock/myco_set_password/myco_remove_password，薄封装 core 同名原语，
// 错误原文透传）。status 透传 core 的 {hasSoul, hasPassword, locked,
// accountFormatLegacy}——UI 只读 hasPassword/locked/accountFormatLegacy，
// 多出的 hasSoul 无害。accountFormatLegacy（2026-10-07 清档闸门立法）=名册自愈
// 检出旧格式账号（create 400 unsupported_did_format）的 sticky 标记：UI 账号页/
// 顶栏引导条数据源（解绑重注册/导恢复码再导入），core::account_format_legacy
// 可直读。零字段加工——本命令层透传即透出。
// ============================================================================

#[tauri::command]
pub async fn myco_status() -> Result<serde_json::Value, String> {
    core_id::account_status().await
}

#[tauri::command]
pub async fn myco_unlock(password: String) -> Result<serde_json::Value, String> {
    core_id::account_unlock(password).await?;
    Ok(serde_json::json!(true))
}

#[tauri::command]
pub async fn myco_set_password(password: String) -> Result<serde_json::Value, String> {
    core_id::account_set_password(password).await?;
    Ok(serde_json::json!(true))
}

#[tauri::command]
pub async fn myco_remove_password(password: String) -> Result<serde_json::Value, String> {
    core_id::account_remove_password(password).await?;
    Ok(serde_json::json!(true))
}

#[tauri::command]
pub async fn myco_import(text: String, password: String) -> Result<serde_json::Value, String> {
    // 2026-09-30 批A（恢复码导入真链通）：薄封装 core::account_import——明文 seedB64
    // 或 ct=/salt=/iv= 加密备份+密码。错误原文透传（备份格式不对/加密备份需要密码/
    // aes-gcm decrypt failed=密码不对/网络错误），UI 红字直显，不吞不错译。
    let root_did = core_id::account_import(text, password).await?;
    // 2026-10-01 修（导入后身份即时切换）：账号已换——广播 account-changed 让
    // App 顶栏/账号页即时重拉身份（此前只能等 30s 轮询，用户实测昵称 ~30s 不切）。
    // 经全局 AppHandle 可选发射（CLI/测试无窗口场景静默）。
    // cfg(not(test))：import_tests 直接调本命令——emit 路径会把 tauri GUI 运行时
    // 链进测试 exe（无 tauri-build 嵌的 SxS manifest，加载即 ENTRYPOINT_NOT_FOUND）。
    #[cfg(not(test))]
    if let Some(app) = crate::p2p_client::current_app_handle() {
        use tauri::Emitter as _;
        let _ = app.emit("account-changed", serde_json::json!({ "rootDid": root_did }));
    }
    Ok(serde_json::json!({ "rootDid": root_did }))
}

#[tauri::command]
pub async fn myco_create_force(name: Option<String>, password: Option<String>, phone: Option<String>, email: Option<String>) -> Result<serde_json::Value, String> {
    let r = core_id::account_create_ex(name, password, phone, email, true).await?;
    Ok(serde_json::json!({ "rootDid": r.root_did, "deviceDid": r.device_did }))
}

#[tauri::command]
pub async fn myco_switch_account(did: String) -> Result<serde_json::Value, String> {
    // 第96轮（修复1）：chat 数据已按账号分桶（chat/<safeDid>/，桶随 account_did()
    // 动态求值）——切账号后 chat_service/offline_queue 读写自动重定向到新账号桶，
    // 此处无需显式刷新钩子；旧全局 chat/ 在首个真实账号访问时一次性 move 迁移。
    core_id::account_switch(did)
}

#[tauri::command]
pub async fn myco_logout() -> Result<serde_json::Value, String> {
    // 第96轮（修复1）：登出后 chat 落 _guest 桶（命令层未登录即 Err）——
    // 原账号数据留在其桶内不动，重新登录（同账号）即复原；切到别的账号各看各桶。
    core_id::account_logout().await
}

/// 解绑本机的账号（高风险）：删账号种子+active+会话，设备钥保留。
/// 此前未注册到 invoke_handler——UI client.invoke('myco_unbind') 一直报 unknown command。
#[tauri::command]
pub async fn myco_unbind() -> Result<(), String> {
    core_id::account_unbind().await
}

/// 设备注销（2026-09-30 设计定稿）：删设备钥+设备会话，账号层与服务端名册不动。
/// 本机回到设备未注册态（重开登录器=全新设备，需重新被收编/登录）。
#[tauri::command]
pub async fn myco_device_logout() -> Result<(), String> {
    core_id::device_logout().await
}

#[tauri::command]
pub async fn myco_rename(name: String) -> Result<(), String> {
    // 2026-09-30：改走 core::account_rename——原实现在此重复签名/HTTP 且改名成功后
    // 不失效名缓存（SOUL_NAME_CACHE 仍留旧名，myco_get 拿旧名）；core 版成功即
    // accounts_upsert+缓存直写新名，失败带 HTTP 状态返回给 UI（不静默）。
    core_id::account_rename(name).await
}

// ============================================================================
// 设备授权
// ============================================================================

#[tauri::command]
pub async fn add_device_by_did(did: String, name: String, owner_root_did: Option<String>) -> Result<serde_json::Value, String> {
    // 第68轮：参数名 did 沿用 env 时代，但服务端 pubkeyB64 字段=裸公钥 b64——归一化
    // 两形态（did:myco:xxx 串 / 裸 b64）都收，防 did 串当公钥入库的静默脏数据。
    let pubkey_b64 = core_id::device_pubkey_from_did_or_b64(&did)?;
    let seed = core_id::cached_account_seed().ok_or("本机未持有根钥")?;
    let root_did = core_id::account_did().ok_or("DID 缺失")?;
    let issued_at = now_ms();
    let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
    let msg = format!("attest\n{root_did}\n{pubkey_b64}\n{issued_at}");
    let sig = b64e(&signing.sign(msg.as_bytes()).to_bytes());
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build().map_err(|e| e.to_string())?;
    let r = http.post(format!("{}/root/device/add", base_url()))
        .json(&serde_json::json!({
            "rootDid": root_did, "pubkeyB64": pubkey_b64, "name": name,
            "issuedAt": issued_at, "attestSigB64": sig
        }))
        .send().await.map_err(|e| e.to_string())?;
    let status = r.status();
    let body: serde_json::Value = r.json().await.map_err(|e| e.to_string())?;
    // 手机端 approveJoinDevice 对等：非 2xx 视为失败抛错（原实现不查 status，
    // 服务端拒绝也回 ok 给 UI 显成功——静默假添加）。
    if !status.is_success() {
        return Err(format!("添加失败 ({status}): {}", serde_json::to_string(&body).unwrap_or_default()));
    }
    // 2026-10-06 任务1（DID 互换收编链路段②，手机端 identity.ts issueDelegationToDevice
    // 对等）：attest 成功后顺签 30 天委任状投 identity-svc 信箱——被收编端轮询
    // /device/<pubkey> 发现收编 → /delegation/poll 取走委任状本地落凭据。
    // 投递失败不挡配对（手机端同款 catch warn；UI 按 delegationDelivered 提示补投）。
    let delivered = match deliver_delegation_at(&base_url(), &seed, &root_did, &pubkey_b64, &name).await {
        Ok(()) => true,
        Err(e) => {
            eprintln!("[add_device_by_did] 委任状投递失败(不挡配对): {e}");
            false
        }
    };
    // 2026-10-06 去中心化通讯架构落地（refactor 仓 docs/todo/2026-10-06-去中心化
    // 通讯架构-发现层与P2P数据面.md §4 数据面主路）：attest+投信箱后，经 P2P 聊天
    // 通道直推「收编通知」给成员设备——成员在线秒级触发取件，不再等 20s watch
    // 轮询；离线/P2P 不可达静默（deliverBox 信箱兜底）。spawn 后台发送：成员多
    // 地址逐个实测最坏几秒，不挡 UI 主流程返回。
    spawn_delegation_notify(&pubkey_b64, &root_did);
    let mut out = body;
    out["delegationDelivered"] = serde_json::json!(delivered);
    Ok(out)
}

/// P2P 收编通知发送（best-effort fire-and-forget）：成员公钥 → canonical 设备 did
/// → 后台任务直推。送达与否只记日志（成员离线/不可达=信箱兜底，语义不报错）。
fn spawn_delegation_notify(member_pubkey_b64: &str, root_did: &str) {
    let Ok(pk) = base64::engine::general_purpose::STANDARD.decode(member_pubkey_b64) else { return };
    let Ok(arr) = <[u8; 32]>::try_from(pk.as_slice()) else { return };
    let member_device_did = core_id::did_from_public(&arr);
    let root = root_did.to_string();
    tauri::async_runtime::spawn(async move {
        let name = core_id::account_name().await.unwrap_or_else(|| "有灵账号".into());
        let ok = crate::p2p_client::deliver_delegation_notify(&member_device_did, &root, &name).await;
        eprintln!(
            "[add_device_by_did] P2P 收编通知 → {}：{}",
            member_device_did.chars().take(20).collect::<String>(),
            if ok { "已送达（成员秒级取件）" } else { "未送达（成员离线/不可达，信箱兜底）" }
        );
    });
}

/// 签发 30 天设备委任状（本地 delegations.json 留档——delegation_list/吊销凭据）
/// 并 POST /delegation/deliver 投 identity-svc 信箱。base 显式传入供单测指 mock。
/// 规范形/字段名与手机端逐字节一致（delegation.rs issue_with_ttl + serde camelCase）。
pub async fn deliver_delegation_at(base: &str, seed: &[u8; 32], root_did: &str, pubkey_b64: &str, name: &str) -> Result<(), String> {
    let device_name = if name.trim().is_empty() { "成员设备" } else { name.trim() };
    let d = myco_core::delegation::Delegations::load().issue_for_with_ttl(
        seed, root_did, pubkey_b64, device_name, None, myco_core::delegation::DEVICE_DELIVER_TTL_MS,
    )?;
    deliver_delegation_http(base, &d).await
}

/// 投递本体（纯 HTTP，单测可指 mock——不落本地文件）。
pub async fn deliver_delegation_http(base: &str, d: &myco_core::delegation::Delegation) -> Result<(), String> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build().map_err(|e| e.to_string())?;
    let r = http.post(format!("{}/delegation/deliver", base.trim_end_matches('/')))
        .json(d) // serde camelCase = 手机端 body 契约（accountDid/devicePubkeyB64/.../sigB64）
        .send().await.map_err(|e| format!("deliver 请求失败: {e}"))?;
    let status = r.status();
    if !status.is_success() {
        let t = r.text().await.unwrap_or_default();
        return Err(format!("deliver status={status} body={}", &t.chars().take(160).collect::<String>()));
    }
    Ok(())
}

#[tauri::command]
pub async fn device_revoke(pubkey_or_did: String) -> Result<serde_json::Value, String> {
    // 与手机端 revokeRosterDevice 对等：签 revoke\n{rootDid}\n{pubkeyB64} 上云除名。
    // 被除名设备下次轮询总览自查到 revoked → 清本地 attestation 回未关联（除名传播）。
    let pubkey_b64 = core_id::device_pubkey_from_did_or_b64(&pubkey_or_did)?;
    let seed = core_id::cached_account_seed().ok_or("本机未持有根钥")?;
    let root_did = core_id::account_did().ok_or("DID 缺失")?;
    let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
    let msg = format!("revoke\n{root_did}\n{pubkey_b64}");
    let sig = b64e(&signing.sign(msg.as_bytes()).to_bytes());
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build().map_err(|e| e.to_string())?;
    let r = http.post(format!("{}/root/device/revoke", base_url()))
        .json(&serde_json::json!({
            "rootDid": root_did, "pubkeyB64": pubkey_b64, "rootSig": sig
        }))
        .send().await.map_err(|e| format!("revoke 请求失败: {e}"))?;
    let status = r.status();
    let body: serde_json::Value = r.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("revoke status={status} body={}", serde_json::to_string(&body).unwrap_or_default()));
    }
    Ok(body)
}

// ============================================================================
// 委任状（读本地 delegations.json）
// ============================================================================

#[tauri::command]
pub fn delegation_list() -> Result<serde_json::Value, String> {
    // 第69轮修：走 core 委托库（config_dir=youling/，第66轮收敛后的真身）。
    // 原读 myco_config_dir()=死的 youling-myco/ 目录（env 时代残留）——目录收编后
    // 副本停更，这里会读到陈旧委任状。
    let recs = myco_core::delegation::Delegations::load().list();
    let data = serde_json::to_value(&recs).unwrap_or(serde_json::json!([]));
    Ok(serde_json::json!({"data": data}))
}

// ============================================================================
// 委任状状态视图（2026-10-11 自动续约配套 UI 面）：分身面板「授权剩余 X 天」
// 数据源。走 read_records_raw（不过期清理）——已过期委任状也要能显示"已过期"
// 提醒（load 的清理会把过期行抹掉，那就永远只见 null=静默，恰是本批修的病）。
// 零私钥：只暴露 exp/issuedAt/剩余与两个布尔。
// ============================================================================

/// 活动账号的委任状状态（无委任状/未登录 → None）。
fn delegation_status_impl() -> Option<serde_json::Value> {
    let acc = core_id::account_did()?;
    let (_, dev_seed_b64) = core_id::device_identity().ok()?;
    let dev_pub = {
        let b = base64::engine::general_purpose::STANDARD.decode(dev_seed_b64).ok()?;
        let arr: [u8; 32] = b.try_into().ok()?;
        b64e(&ed25519_dalek::SigningKey::from_bytes(&arr).verifying_key().to_bytes())
    };
    // raw 视图 + 同（账号,设备）取 exp 最大（与续约巡检同口径）
    let best = myco_core::delegation::read_records_raw()
        .into_iter()
        .filter(|r| !r.revoked
            && core_id::account_did_eq(&r.delegation.account_did, &acc)
            && r.delegation.device_pubkey_b64 == dev_pub)
        .max_by_key(|r| r.delegation.exp)?;
    let d = &best.delegation;
    let now = now_ms();
    Some(serde_json::json!({
        "exp": d.exp,
        "issuedAt": d.issued_at,
        // 已过期饱和 0（UI 不防下溢）
        "remainingMs": d.exp.saturating_sub(now),
        "dueRenew": d.is_due_renew_at(now),
        "expired": d.is_expired_at(now),
    }))
}

/// 界面读取入口：`{exp,issuedAt,remainingMs,dueRenew,expired}` 或 null（UI 不渲染）。
#[tauri::command]
pub fn delegation_status() -> Result<serde_json::Value, String> {
    Ok(delegation_status_impl().unwrap_or(serde_json::Value::Null))
}

/// 主设备视角（2026-10-13 用户需求"台式机也要看到 30 天授权数字"）：
/// 本账号签发给**各成员设备**的委任状剩余（按设备公钥聚合 exp 最大者）。
/// 返回 [{devicePubkeyB64, remainingMs, expired}]——UI 按 pubkey 映射到设备行，
/// 同款绿（>3天）/橙（≤3天）/红（过期）分档。
#[tauri::command]
pub fn delegation_status_by_device() -> Result<serde_json::Value, String> {
    let Some(acc) = core_id::account_did() else { return Ok(serde_json::json!([])) };
    let (_, dev_seed_b64) = match core_id::device_identity() {
        Ok(v) => v,
        Err(_) => return Ok(serde_json::json!([])),
    };
    let dev_pub = {
        let b = match base64::engine::general_purpose::STANDARD.decode(dev_seed_b64) {
            Ok(b) => b,
            Err(_) => return Ok(serde_json::json!([])),
        };
        let arr: [u8; 32] = match b.try_into() { Ok(a) => a, Err(_) => return Ok(serde_json::json!([])) };
        b64e(&ed25519_dalek::SigningKey::from_bytes(&arr).verifying_key().to_bytes())
    };
    let now = now_ms();
    let mut best: std::collections::HashMap<String, (i64, bool)> = Default::default();
    for r in myco_core::delegation::read_records_raw() {
        if r.revoked { continue; }
        if !core_id::account_did_eq(&r.delegation.account_did, &acc) { continue; }
        // 本机（主设备自己）的委任状行跳过——主设备不是委任状持有者
        if r.delegation.device_pubkey_b64 == dev_pub { continue; }
        let rem = r.delegation.exp.saturating_sub(now) as i64;
        let entry = best.entry(r.delegation.device_pubkey_b64.clone()).or_insert((i64::MIN, false));
        if rem > entry.0 { *entry = (rem, r.delegation.exp <= now); }
    }
    let list: Vec<serde_json::Value> = best
        .into_iter()
        .map(|(pk, (rem, expired))| serde_json::json!({
            "devicePubkeyB64": pk,
            "remainingMs": rem.max(0),
            "expired": expired,
        }))
        .collect();
    Ok(serde_json::json!(list))
}

// ══ MycoDevices 管理面 8 命令补齐（2026-10-13）══
// 组件从 media 时代拷来而这些命令在 home 从未实现 → invoke 全部 unknown command
// 被 refresh 的 try 静默吞 → 设备列表永远空（用户实测"PC 上看不到成员设备"）。
// 底座全部走 share_auth::shared()（与 authorized-dids.json 同一存储）。

use crate::share_auth as sa;

#[tauri::command]
pub fn list_authorized_devices() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!(sa::shared().list()))
}

#[tauri::command]
pub fn list_trusted_roots() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!(sa::shared().list_roots()))
}

/// 根账号显示名解析（roots 备注名优先，设备名兜底，再兜底 did 尾4）。
#[tauri::command]
pub fn resolve_myco_names(root_dids: Vec<String>) -> Result<serde_json::Value, String> {
    let shared = sa::shared();
    let m: std::collections::HashMap<String, String> = root_dids
        .iter()
        .map(|d| (d.clone(), shared.author_name_for(d)))
        .collect();
    Ok(serde_json::json!(m))
}

#[tauri::command]
pub fn rename_trusted_root(root_did: String, name: String) -> Result<bool, String> {
    Ok(sa::shared().rename_root(&root_did, &name))
}

#[tauri::command]
pub fn set_root_note(root_did: String, note: String) -> Result<bool, String> {
    Ok(sa::shared().set_root_note(&root_did, &note))
}

#[tauri::command]
pub fn set_device_scopes(did: String, scopes: Vec<String>) -> Result<bool, String> {
    Ok(sa::shared().set_scopes(&did, scopes))
}

#[tauri::command]
pub fn set_device_auth(did: String, allowed: bool, ttl_ms: Option<u64>) -> Result<bool, String> {
    Ok(sa::shared().set_auth(&did, allowed, ttl_ms))
}

/// 按出生地整组吊销（返回移除的设备数）。
#[tauri::command]
pub fn revoke_origin(origin: String) -> Result<u32, String> {
    Ok(sa::shared().remove_by_origin(&origin) as u32)
}

// ── 2026-10-13：MycoDevices 管理面三个**幽灵 invoke** 补齐 ────────────────────
// 背景：core/myco-core/src/authorized.rs 里 remove_authorized_device / rename_authorized_device /
// revoke_roster_device 都只是**普通函数**（未加 #[tauri::command]、未注册），前端 invoke 必报
// unknown command，而调用点 try/catch 静默吞掉 → 按钮点了没反应（v0.3.132 实况）。
// 语义分层（三者不重叠，别搞混）：
//   · rename_authorized_device  = 改**本机白名单**里的显示名
//   · remove_authorized_device  = 删**本机白名单**记录（可重新配对；不动名册）
//   · revoke_roster_device      = 从**账号名册**除名（账号根钥签 → /root/device/revoke）

/// 改本机白名单设备显示名（不碰服务端名册——名册无 rename 接口）。
#[tauri::command]
pub fn rename_authorized_device(did: String, name: String) -> Result<bool, String> {
    Ok(sa::shared().rename_device(&did, &name))
}

/// 删本机白名单设备记录（该设备不再被本机放行；可重新配对）。
#[tauri::command]
pub fn remove_authorized_device(did: String) -> Result<bool, String> {
    Ok(sa::shared().remove_device(&did))
}

/// 账号名册除名（attestation 吊销，账号根钥签名；本机须是主设备）。
#[tauri::command]
pub async fn revoke_roster_device(pubkey_b64: String) -> Result<bool, String> {
    myco_core::authorized::revoke_roster_device(pubkey_b64).await
}

#[tauri::command]
pub async fn delegation_revoke(device_pubkey_b64: String) -> Result<(), String> {
    // 第69轮：接线 core（原空 stub——UI"吊销委任状"静默无效）。
    // ① 本地吊销+落盘 ② /revocation/push 推服务端（账号钥签，同 wallet_sign 模型）——
    // 只本地吊销=被吊销设备 30 天期到期前仍凭旧状在服务端刷存在感/续签；push 后
    // 服务端认账，被吊销方 poll 即见 revoked 并自清理。
    // 2026-10-09 多归属修(L2/★3)：吊销按 (账号,设备) 收敛——revoke 调用点一次性
    // 捕获 (seed, root_did)（此前 revoke 账号盲只取第一条匹配行，会错杀他账号
    // 同 pubkey 行）；推送清单只含**该账号名下**的吊销记录（此前跨账号全量收集+
    // 活动账号签名=以 A 的名义推走 B 的吊销记录），推送时不再读活动态（切号串号）。
    let pubkey_b64 = core_id::device_pubkey_from_did_or_b64(&device_pubkey_b64)?;
    let seed = core_id::cached_account_seed().ok_or("本机未持有根钥")?;
    let root_did = core_id::account_did().ok_or("DID 缺失")?;
    let d = myco_core::delegation::Delegations::load();
    if !d.revoke_for(&root_did, &pubkey_b64) {
        return Err("本机无该设备的委任状".into());
    }
    // 服务端传播（best-effort：失败也已在本地吊销，重试/自愈走本地）——签名账号
    // 与记录归属同账号：只推 root_did 名下的吊销清单
    let revoked = d.revoked_pubkeys(&root_did);
    let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
    let ts = now_ms();
    let msg = format!("revocation
{root_did}
{ts}
{}", revoked.join(","));
    let sig = b64e(&signing.sign(msg.as_bytes()).to_bytes());
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build().map_err(|e| e.to_string())?;
    let r = http.post(format!("{}/revocation/push", base_url()))
        .json(&serde_json::json!({
            "accountDid": root_did,
            "revokedPubkeys": revoked,
            "ts": ts, "sigB64": sig
        }))
        .send().await;
    if let Err(e) = r {
        eprintln!("[delegation_revoke] 服务端传播失败（本地已吊销）: {e}");
    }
    Ok(())
}

// ============================================================================
// 钱包签名（原 env :3102 /api/wallet_sign，第63轮 env 合并移入）
// ============================================================================

#[tauri::command]
pub async fn wallet_sign(did: String, message: String) -> Result<serde_json::Value, String> {
    let seed = core_id::cached_account_seed()
        .ok_or("本机未持有账号钥（或已锁定）")?;
    let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
    let sig = b64e(&signing.sign(message.as_bytes()).to_bytes());
    let root_did = core_id::account_did().ok_or("DID 派生失败")?;
    Ok(serde_json::json!({"did": root_did, "sig": sig}))
}

/// 选本机可用的委任状（纯函数，单测直击）：
/// 未吊销 ∧ 未过期 ∧ 设备公钥一致；多张时优先归属当前账号，其次取 exp 最大者。
/// fail-closed：无有效委任状返回 None（调用方转成用户可读的"重新授权"提示）。
pub(crate) fn pick_valid_delegation(
    recs: &[myco_core::delegation::DelegationRecord],
    device_pub_b64: &str,
    now: u64,
    account_did: Option<&str>,
) -> Option<myco_core::delegation::Delegation> {
    let mut valid: Vec<&myco_core::delegation::DelegationRecord> = recs
        .iter()
        .filter(|r| {
            !r.revoked && r.delegation.exp > now && r.delegation.device_pubkey_b64 == device_pub_b64
        })
        .collect();
    if let Some(acct) = account_did {
        if let Some(pos) = valid
            .iter()
            .position(|r| core_id::account_did_eq(&r.delegation.account_did, acct))
        {
            return Some(valid.swap_remove(pos).delegation.clone());
        }
    }
    valid
        .into_iter()
        .max_by_key(|r| r.delegation.exp)
        .map(|r| r.delegation.clone())
}

/// 分身设备签名（**进程内**，2026-10-11 修「成员设备网页登录不了」根因）：
/// 委任状签名模式（spec login-design §7.2）——本机无账号根钥时，用**设备钥**签
/// `myco-auth\n{ticket}` 并随行**主设备签的委任状**，平台验链后落账 accountDid。
///
/// 为什么必须新增本命令：UI 原先 fetch env 遗留 HTTP
/// `http://127.0.0.1:3102/api/wallet_sign_delegated`；第 63 轮 env 合并入 myco.exe 后
/// 该路由**已不存在**（3102 只剩 `/api/dshShare/*`，`wallet_sign` 当轮已改 invoke，
/// **此处漏网**）⇒ 分身设备签名必然 404 ⇒ 三段回落链全灭 ⇒ 用户看到
/// 「本机登录已过期/会话缺失」（全员受影响，非单机问题）。与第 63 轮 `auto_login_url`
/// 漏网点同型：env 退役后遗留 HTTP 调用点必须逐个改进程内。
#[tauri::command]
pub fn wallet_sign_delegated(message: String) -> Result<serde_json::Value, String> {
    let (did, sig, delegation) = delegated_sign_parts(&message)?;
    Ok(serde_json::json!({
        "did": did,
        "sig": sig,
        "delegation": delegation,
    }))
}

/// 分身签名**共用实现**（Tauri 命令 `wallet_sign_delegated` 与 `lib::auto_login_url`
/// 的「探索」自动登录都走它）：设备钥签 `message` + 随行本机有效委任状。
/// 返回 `(设备did, sigB64, 委任状JSON)`。
///
/// 2026-10-12 抽公共：`auto_login_url`（myco「探索」按钮）原先只认账号根钥，
/// 成员设备上 `cached_account_seed()` 为 None ⇒ 整段静默失败 ⇒ 退回裸 URL ⇒
/// **分身点「探索」打开网页不登录**（用户实测）。与网页登录属同一根因家族。
pub(crate) fn delegated_sign_parts(
    message: &str,
) -> Result<(String, String, serde_json::Value), String> {
    // ① 设备钥（本机唯一设备身份；分身设备不触账号钥——那正是本路径存在的理由）
    let (device_did, seed_b64) = core_id::device_identity()?;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(seed_b64.as_bytes())
        .map_err(|_| "设备种子解码失败".to_string())?;
    let seed: [u8; 32] = raw
        .as_slice()
        .try_into()
        .map_err(|_| "设备种子长度应为 32 字节".to_string())?;
    let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
    let device_pub_b64 = b64e(&signing.verifying_key().to_bytes());
    // ② 本机有效委任状（未吊销/未过期/设备公钥一致）——没有就明说"重新授权"
    let account_did = core_id::account_did();
    let delegation = pick_valid_delegation(
        &myco_core::delegation::Delegations::load().list(),
        &device_pub_b64,
        now_ms(),
        account_did.as_deref(),
    )
    .ok_or_else(|| "本机无有效设备授权（请在主设备上重新授权本设备）".to_string())?;
    // ③ 设备钥签名 + 委任状随行（平台 verifyDelegatedSignature 五步链验它）
    let sig = b64e(&signing.sign(message.as_bytes()).to_bytes());
    Ok((device_did, sig, serde_json::json!(delegation)))
}

// ============================================================================
// A1 提交面会话钥委任状签发（refactor 仓 docs/security/2026-09-30-session-key-submission.md）
// 登录确认时顺带签发：账号钥授权浏览器临时 Ed25519 钥本会话内提交答案签名。
// 委任状 JSON 与平台 SessionKeyService 验证面逐字段对齐（camelCase 由 serde 重命名）。
//
// 2026-10-10（用户批准"要加"）：**每次调用都新签**（本命令无缓存——页面每次请求
// 都拿到新 exp 的委任状，签发语义不变）；签发成功后顺带做**到期跟踪**（C-2），
// 供常驻环的 C-3 到期前状态（界面显示授权剩余）使用。
// ============================================================================

/// 2026-10-10 任务1（**安全闸**，用户确认"必须做"）：`silent` 为真 = 静默续期——
/// **只允许续期已授权会话钥**，未授权过的新钥一律 Err（理由见 sign_session_delegation ②）。
/// `silent` 是 `Option<bool>`：老调用方不传 ⇒ `None` ⇒ `false` = **原行为完全不变**
/// （同 youling_auth_callback_sig 的 Option 参数先例：Tauri 对 Option 参数允许缺省）。
#[tauri::command]
pub fn session_delegation_sign(session_pubkey_b64: String, silent: Option<bool>) -> Result<serde_json::Value, String> {
    // 命令体只做三件事：定路径 + 静默缺省化 + 取账号态；签发路径本体在 sign_session_delegation
    sign_session_delegation(&session_pubkey_b64, silent.unwrap_or(false), || {
        let seed = core_id::cached_account_seed().ok_or("本机未持有账号钥（或已锁定）")?;
        let root_did = core_id::account_did().ok_or("DID 派生失败")?;
        Ok((seed, root_did))
    }, &session_key_path())
}

/// 签发实现体——账号态用闭包注入（同本模块 watch_probe_at 的 have_valid 手法），
/// 单测因此能走**同一条生产签发路径**：形态校验 → 静默闸 → 取账号钥 →
/// issue_session_key → C-2 落盘 → 返回委任状 JSON，只有账号钥与落盘路径被替换。
/// 闭包在形态校验**之后**才调用，保持原报错优先级（非法入参先于"未登录"）。
pub(crate) fn sign_session_delegation(
    session_pubkey_b64: &str,
    silent: bool,
    account: impl FnOnce() -> Result<([u8; 32], String), String>,
    record_path: &std::path::Path,
) -> Result<serde_json::Value, String> {
    // ① 形态校验：标准 base64 且解出 32 字节（Ed25519 裸公钥）——别把垃圾签进委任状
    let raw = base64::engine::general_purpose::STANDARD
        .decode(session_pubkey_b64.as_bytes())
        .map_err(|_| "会话钥公钥不是合法 base64".to_string())?;
    if raw.len() != 32 {
        return Err("会话钥公钥长度应为 32 字节".into());
    }
    // ② 静默闸（2026-10-10 任务1 **安全闸**，用户确认"必须做"）：静默 = **无用户可见
    //    确认**，若允许静默签新会话钥，则任意 *.youling.cc 页面（含被 XSS 的）都能让
    //    登录器静默签出委任状。故**静默只允许"续期"，不允许"新授权"**：该
    //    sessionPubkey 必须已在本机授权记录（session-key.json）里——= 用户在浏览器
    //    登录时亲自确认过的那把；新钥一律走正常流程（需确认）。
    //    位置在形态校验之后、取账号钥之前：非法入参报错优先级不变；未授权会话在碰
    //    账号钥之前就被拒（不产生任何签名副作用，也不暴露本机账号态）。
    if silent {
        let known = known_session_pubkeys_at(record_path);
        if !silent_renew_allowed(&known, session_pubkey_b64) {
            return Err(SILENT_RENEW_DENIED_MSG.into());
        }
    }
    // ③ 账号态（本机账号种子 + 账号 DID）
    let (seed, root_did) = account()?;
    // ④ 签发（每次都新签，无缓存）
    let d = myco_core::delegation::issue_session_key(&seed, &root_did, session_pubkey_b64);
    // ⑤ C-2 到期跟踪（best-effort：写盘失败只 log，绝不影响签发返回——页面拿不到
    //    委任状才是 40109 的直接原因，提醒记账不许挡这条路）
    let rec = SessionKeyRecord {
        session_pubkey_b64: session_pubkey_b64.to_string(),
        exp: d.exp,
        issued_at: d.issued_at,
    };
    if let Err(e) = record_session_key_at(record_path, &rec) {
        eprintln!("[session-delegation] session-key.json 写入失败（已忽略，不影响签发）: {e}");
    }
    serde_json::to_value(&d).map_err(|e| e.to_string())
}

/// 静默闸拒签文案（单一源：测试与调用方日志都引用它，避免文案漂移）。
pub(crate) const SILENT_RENEW_DENIED_MSG: &str =
    "静默续期仅限已授权会话——该会话钥未授权过，请走正常授权流程";

/// 静默续期许可判定（**纯函数**，独立可测）：请求钥必须**恰等于**本机记过的某把钥。
/// 空请求钥 / 空记录 / 仅前缀相同 / 大小写差异 → 一律不允许（静默无确认，宁拒勿放）。
pub(crate) fn silent_renew_allowed(known_pubkeys: &[String], req_pubkey: &str) -> bool {
    !req_pubkey.is_empty() && known_pubkeys.iter().any(|k| k == req_pubkey)
}

/// 本机授权记录里的会话钥清单（生产 = [`session_key_path`]；测试传临时路径）。
/// 当前存储是**单条最新记录**（C-2 语义：多标签页只留 exp 最晚的一条），故清单
/// 至多一把钥；返回 Vec 是为了「已授权集合」这一语义在签名上就位，将来若要留
/// 多条历史钥无需改调用方。
pub(crate) fn known_session_pubkeys_at(path: &std::path::Path) -> Vec<String> {
    read_session_key_at(path)
        .map(|r| r.session_pubkey_b64)
        .filter(|s| !s.is_empty())
        .into_iter()
        .collect()
}

// ============================================================================
// C-2 到期跟踪 + C-3 到期前状态（2026-10-10 用户批准"要加"）
// 设计稿：refactor 仓 docs/todo/2026-10-10-会话委任状过期前续期设计.md §2.1 C-2/C-3、§4
//
// 为什么需要：会话委任状（账号钥授权浏览器临时钥提交答案，12h）**到期后无恢复路径**
// ——页面只在"登录确认"时请求一次 /auth/request，此后握着旧状 → 工人做完题提交时
// 40109 卡死。续期的执行者只能是**页面**（exp 与 sessionStorage 在浏览器侧，
// /auth/request 只能由页面发起，即设计稿 F-1/F-2）；客户端能做的两件事：
//   C-2 到期跟踪：每次签发顺手记录 {公钥, exp, issuedAt} 到 session-key.json
//   C-3 到期前状态：常驻环每分钟看一次文件，剩 <30min 且本 exp 尚未推送过 →
//       把状态**广播给登录器界面**（`session-key-due` 事件）+ `session_key_status`
//       命令按需读——**方案 A（2026-10-10 设计定稿「总之不想打扰用户」）：
//       不发 Windows 系统通知**，提醒只出现在 myco 界面上。
//
// ⚠️ 安全边界（§4 硬要求）：session-key.json **零私钥/零种子/零签名**——只落上面三个
// 字段（单测 session_key_file_holds_no_secret_fields 把字段集与禁词双双锁死）；
// 状态/事件文案不含 did/密钥。
// ============================================================================

/// C-3 提醒窗口：剩余 <30min（12h 的 1/24；设计稿 §3 默认值）即进入提醒区。
pub const SESSION_KEY_WARN_WINDOW_MS: u64 = 30 * 60 * 1000;

/// C-4（2026-10-22 设计定稿「小改进」）：**过期宽限期**——过期超过 24h 的会话钥记录视为陈旧，
/// 自动清理（账号页不再长期显示「已过期，请重新授权」红字）。与 C-3 的 30min 提醒窗口区分：
/// 30min 内显示琥珀色「即将过期」，过期后 24h 内显示红字（给用户重新授权窗口），
/// 超过 24h 仍未重新授权 → 认为这次网页会话已放弃，清掉记录（下次网页答题时走正常授权/40110）。
pub const SESSION_KEY_STALE_MS: u64 = 24 * 60 * 60 * 1000;

/// C-4 陈旧判定（纯函数）：未过期恒 false；过期超过 [`SESSION_KEY_STALE_MS`] → true。
pub(crate) fn session_key_stale(exp: u64, now: u64) -> bool {
    now.saturating_sub(exp) >= SESSION_KEY_STALE_MS
}

/// C-3 检查节流：挂在 20s 取件环（`WATCH_INTERVAL_SECS`）上，实际每分钟查一次文件。
const SESSION_KEY_CHECK_INTERVAL_MS: u64 = 60 * 1000;

/// C-2 落盘体。⚠️ **只许这三个字段**——多一个种子/签名类字段即违反设计稿 §4。
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionKeyRecord {
    /// 浏览器会话钥**公钥**（base64 裸 32B）——用来人肉辨认"哪把钥"，非密钥材料。
    pub session_pubkey_b64: String,
    /// 委任状到期时刻（ms epoch，取自 `Delegation.exp` 本体，不重算）。
    pub exp: u64,
    /// 签发时刻（ms epoch，取自 `Delegation.issued_at`）。
    pub issued_at: u64,
}

/// 跟踪文件路径（与 delegations.json 同目录：`config::config_dir()` = `%APPDATA%\youling`）。
fn session_key_path() -> std::path::PathBuf {
    myco_core::config::config_dir().join("session-key.json")
}

/// C-2 记录一次签发（显式路径供单测隔离；生产走 [`session_key_path`]）。
///
/// 多标签页/多次签发 → **只保留 exp 最晚的一条**（单条覆盖语义）：每次签发
/// exp=now+12h，后签者 exp 必更晚，故"留最晚"="留最后一次签发"；显式比较是为了
/// 挡住乱序写入（旧 exp 盖掉新 exp 会让 C-3 对着已废的 exp 提醒/漏提醒）。
pub(crate) fn record_session_key_at(path: &std::path::Path, rec: &SessionKeyRecord) -> Result<(), String> {
    if let Some(old) = read_session_key_at(path) {
        if old.exp > rec.exp {
            return Ok(());
        }
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = serde_json::to_string_pretty(rec).map_err(|e| e.to_string())?;
    std::fs::write(path, body).map_err(|e| e.to_string())
}

/// C-3 读跟踪文件：缺文件/坏 JSON/缺字段 → None（=本机从未签发过会话钥，静默无事）。
pub(crate) fn read_session_key_at(path: &std::path::Path) -> Option<SessionKeyRecord> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// C-4 清空本机会话钥记录（UI「已过期→点击清除」与常驻环自动清理共用）。幂等。
///
/// 返回 true = 确实删掉了文件；false = 本来就没有（或删除失败）——调用方无需区分。
/// ⚠️ 清除后静默续期安全闸（C-5：只续"已授权过"的会话钥）会对该公钥失忆 →
/// 下次网页请求只能走**正常授权**（用户确认），这正是陈旧记录过期的预期语义。
pub(crate) fn clear_session_key_at(path: &std::path::Path) -> bool {
    std::fs::remove_file(path).is_ok()
}

/// C-3 到期判定（纯函数）：剩 <30min **或已过期** → 该提示（方案 A：推给界面显示）。
/// 已过期同样提示：过期后连恢复入口都没有，正是最需要提示的时刻。
pub(crate) fn session_key_due_warn(exp: u64, now: u64) -> bool {
    exp <= now || exp - now < SESSION_KEY_WARN_WINDOW_MS
}

/// C-3 检查节流（纯函数）：距上次检查 ≥60s 才查文件（环本身 20s 一跳）。
pub(crate) fn session_key_check_due(last_check_ms: u64, now: u64) -> bool {
    now.saturating_sub(last_check_ms) >= SESSION_KEY_CHECK_INTERVAL_MS
}

/// C-3 同一 exp 只推送一次（进程内去重，防界面被每分钟反复冲刷）。
/// 不落盘：§4 只许 session-key.json 三个字段，故重启后同一 exp 至多再推送一次
/// （可接受，且远好于每分钟推）。
#[derive(Debug, Default)]
pub struct SessionKeyWarner {
    warned_exp: u64,
}

impl SessionKeyWarner {
    /// 判定 + 记账一步到位：返回 true 即已记账，同 exp 再来恒 false。
    /// 未进窗口的 exp **不记账**（下轮进窗口时仍能推送）。
    pub fn should_notify(&mut self, exp: u64, now: u64) -> bool {
        if self.warned_exp == exp || !session_key_due_warn(exp, now) {
            return false;
        }
        self.warned_exp = exp;
        true
    }
}

/// 会话委任状状态 = 暴露给 UI 的**零私钥视图**（任务2 方案 A：把"提醒"改成"界面显示"）。
/// 只有记账三字段 + 两个派生量；**不含 sessionPubkeyB64、不含任何密钥材料**。
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionKeyStatus {
    /// 委任状到期时刻（ms epoch，取自 `Delegation.exp`）。
    pub exp: u64,
    /// 签发时刻（ms epoch）。
    pub issued_at: u64,
    /// 距到期剩余 ms（已过期=0，**不出现负数**——UI 直接格式化，不用自己防下溢）。
    pub remaining_ms: u64,
    /// 是否进入提醒窗口（= [`session_key_due_warn`]：剩 <30min 或已过期）。
    pub due_warn: bool,
}

/// 记录 → UI 状态视图（纯函数，now 注入便于单测边界）。
pub(crate) fn session_key_status_of(rec: &SessionKeyRecord, now: u64) -> SessionKeyStatus {
    SessionKeyStatus {
        exp: rec.exp,
        issued_at: rec.issued_at,
        remaining_ms: rec.exp.saturating_sub(now),
        due_warn: session_key_due_warn(rec.exp, now),
    }
}

/// 界面读取入口（方案 A）：有记录 → `{exp,issuedAt,remainingMs,dueWarn}`；
/// **无记录 → null**（UI 据此不显示，别给用户噪音）。零私钥/零种子。
///
/// C-4（2026-10-22）：过期超过 [`SESSION_KEY_STALE_MS`] 的陈旧记录在这里**顺手清理**并返回
/// null——账号页不再长期挂着「已过期，请重新授权」的红字。
#[tauri::command]
pub fn session_key_status() -> Result<serde_json::Value, String> {
    let path = session_key_path();
    match read_session_key_at(&path) {
        Some(rec) => {
            let now = now_ms();
            if session_key_stale(rec.exp, now) {
                let _ = clear_session_key_at(&path);
                return Ok(serde_json::Value::Null);
            }
            serde_json::to_value(session_key_status_of(&rec, now)).map_err(|e| e.to_string())
        }
        None => Ok(serde_json::Value::Null),
    }
}

/// C-4（2026-10-22 设计定稿「小改进」）：界面「已过期，请重新授权」那一行**可点**——
/// 清掉本机陈旧记录（幂等；无记录也返回 ok）。清除只动本地跟踪文件，**不碰账号钥/委任状**；
/// 下次在网页答题时由页面侧走正常授权（过期后本来就必须重新授权，客户端不能静默签新钥）。
/// 返回 `{cleared: bool}`：true=删掉了文件，false=本来就没有。
#[tauri::command]
pub fn session_key_clear() -> Result<serde_json::Value, String> {
    let cleared = clear_session_key_at(&session_key_path());
    Ok(serde_json::json!({ "cleared": cleared }))
}

/// C-3 状态广播事件名（方案 A：不发系统通知——界面收到即刷新"授权剩余"一行）。
pub const SESSION_KEY_DUE_EVENT: &str = "session-key-due";

/// C-3 上次检查时刻（ms；0=从未检查）。
#[cfg(not(test))]
static SESSION_KEY_LAST_CHECK_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// C-3 推送去重器（进程内）。
#[cfg(not(test))]
static SESSION_KEY_WARNER: std::sync::Mutex<SessionKeyWarner> =
    std::sync::Mutex::new(SessionKeyWarner { warned_exp: 0 });

/// C-3 一轮检查（挂在 20s 取件环 `watch_tick` 上，**不新起线程**）：节流 60s → 读
/// session-key.json → 到期且本 exp 未推送过 → 把状态**广播给登录器界面**。
///
/// 方案 A（2026-10-10 设计定稿「**总之不想打扰用户**」）：**不再发 Windows 系统通知**
/// ——此前这里调 `app.notification()...show()`；现在只 emit（不改窗口显隐、不抢焦点、
/// 不弹系统通知），界面拿状态自己显示「网页提交授权 剩余 X」。C-4「点击通知 → 打开
/// 平台页」随之作废（没有通知可点）；重新授权入口由前端 F-3 负责。
/// 跟踪/判定/去重逻辑全部保留（去重语义 = 同一 exp 只广播一次）。
///
/// cfg(not(test))：emit 路径会把 tauri GUI 运行时链进测试 exe（ENTRYPOINT_NOT_FOUND，
/// 同 notify_system / myco_import）；判定/去重/读写的纯逻辑在 test 下照测
/// （session_key_tracking_tests）。
#[cfg(not(test))]
fn session_key_warn_tick(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    let now = now_ms();
    if !session_key_check_due(SESSION_KEY_LAST_CHECK_MS.load(Ordering::Relaxed), now) {
        return;
    }
    SESSION_KEY_LAST_CHECK_MS.store(now, Ordering::Relaxed);
    let Some(rec) = read_session_key_at(&session_key_path()) else { return };
    // C-4：陈旧记录（过期 >24h）自动清理——不再广播，界面下次拉 status 得到 null 即整行消失。
    if session_key_stale(rec.exp, now) {
        let _ = clear_session_key_at(&session_key_path());
        return;
    }
    let fire = match SESSION_KEY_WARNER.lock() {
        Ok(mut w) => w.should_notify(rec.exp, now),
        Err(e) => e.into_inner().should_notify(rec.exp, now),
    };
    if !fire {
        return;
    }
    // 方案 A：只广播状态（零私钥、不含 did，§4）。绝不调用系统通知。
    use tauri::Emitter as _;
    let _ = app.emit(SESSION_KEY_DUE_EVENT, session_key_status_of(&rec, now));
}

#[cfg(test)]
fn session_key_warn_tick(_app: &tauri::AppHandle) {}

// ============================================================================
// 被收编端后台轮询（2026-10-06 任务2：DID 互换收编链路段③——手机端
// identity.ts fetchMyRoot + delegation.ts pollDelegation 的 PC home 对等）：
//   ① GET /device/<本机设备公钥> 反查——发现自己被某账号收编（attestSigB64+rootDid）
//   ② 本地 delegations.json 无该账号有效委任状 → GET /delegation/poll 取委任状
//   ③ 验签+落 delegations.json + accounts_upsert（accounts_load_with_roles 自动
//     出 role=agent——role 判定纯靠本地凭据，清单条目在即在列）
//   ④ emit delegation-received（前端账号抽屉刷新）+ 系统通知「你已被 XXX 收编为成员」
// 挂在 home 启动的常驻 tokio 环（20s），与 presence 环并行互不影响。
// ============================================================================

const WATCH_INTERVAL_SECS: u64 = 20;

/// watch_tick 并发去重：P2P 收编通知触发的立即取件与 20s 环可能撞车——同一张
/// 委任状双通道并发取会双弹提示；在飞即弃（在飞那趟负责取件，语义等价）。
static TICK_IN_FLIGHT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// P2P 收编通知（delegation-notify）到达 → 立即跑一轮取件（不等 20s 环）。
/// 取件/验签/nonce 去重全部复用 watch_tick——这里只是「唤醒」，不重复实现。
/// AppHandle 缺失（CLI 等非 GUI 场景）静默——取件环本就只在 GUI 常驻。
#[cfg(not(test))]
pub fn trigger_delegation_pickup() {
    if let Some(app) = crate::p2p_client::current_app_handle() {
        tauri::async_runtime::spawn(async move {
            if let Err(e) = watch_tick(&app).await {
                eprintln!("[delegation-watch] P2P 收编通知触发的取件失败（{WATCH_INTERVAL_SECS}s 环兜底）: {e}");
            }
        });
    }
}

// ============================================================================
// 邀请码（方向 B）——2026-10-08 补：home exe 此前**没有** invite_start /
// pair_requests，前端 startInvite 捕获 unknown command 后降级出示 myco-add
// （「我的识别码」）——那种码方向相反（语义是"把本机加进对方账号"），手机扫了
// 会被告知"方向反了"。用户实测：**台式机无摄像头**，PC 扫手机物理上不可行，
// 「大屏出码 + 手机扫」才是可用路径。前端 UI 早已就绪（invite 面板 + 2s 轮询
// 申请卡 + confirm/reject），本批只补后端三个命令即可打通。
// ============================================================================

/// 出示邀请码：生成一次性 nonce + 5 分钟有效期（纯本地，无服务端往返）。
/// 手机扫到本码后把「它自己的 DID + nonce」投进**本机信令信箱**（`/signal/pair`，
/// to=本机 did）→ 本机经 [`pair_requests`] 收申请 → `confirm_device` 收编上名册。
#[tauri::command]
pub async fn invite_start() -> Result<serde_json::Value, String> {
    let n: u64 = rand::random();
    Ok(serde_json::json!({
        "nonce": format!("{n:016x}"),
        "exp": now_ms() + 300_000, // 5 分钟
    }))
}

/// 收起邀请码（前端 `stopInvite` 调）——纯本地态无服务端动作，留命令以免前端
/// 走到 unknown command 分支记噪音日志。
#[tauri::command]
pub async fn invite_stop() -> Result<(), String> {
    Ok(())
}

/// 主设备收配对申请（邀请码方向 B）：签名 GET `/signal/drain`，滤出 `type=='pair'`
/// 的积压消息，映射为前端契约 `[{did, name, dev?, ts}]`（服务端字段名为 `from`，
/// 前端字段名为 `did`——此处对齐；`ts` 缺失兜底 0）。
#[tauri::command]
pub async fn pair_requests() -> Result<serde_json::Value, String> {
    let resp = core_id::signed_get_response("/signal/drain").await?;
    let text = resp.text().await.map_err(|e| format!("pair_requests 读取失败: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::json!({}));
    Ok(serde_json::Value::Array(map_pair_requests(&v)))
}

// ── 2026-10-13：上批"补后端三个命令即可打通"只补了 invite_start/invite_stop/pair_requests，
// 前端配对申请卡上的**确认/拒绝/忽略**三个动作仍然全是幽灵 invoke（点了没反应）：
//   confirm_device / reject_device / pair_request_dismiss —— 全仓 Rust 侧均未注册。
// 同时 YoulingAuth「创建有灵账户」第一步 identity_register_login 也未注册，
// 导致该流程 registerLogin 返回 false 直接报"创建有灵账户失败"。
// 本批一并补齐；并加回归测试 uiCommandContract.test.ts 防同类事故（前端 invoke 的命令名
// 必须存在于 lib.rs 的 generate_handler 清单）。

/// 二次放行：Pending → Allowed（「新设备请求加入」卡的「✓ 确认授权」）。
#[tauri::command]
pub fn confirm_device(did: String) -> Result<bool, String> {
    Ok(sa::shared().confirm_device(&did))
}

/// 拒绝放行：Pending → 移除（可重新配对）。配对申请卡「拒绝」。
#[tauri::command]
pub fn reject_device(did: String) -> Result<bool, String> {
    Ok(sa::shared().reject_device(&did))
}

/// 忽略配对申请（配对申请卡右上 ✕）：`/signal/drain` 读取时已把服务端信箱积压
/// `splice(0)` 取走，本地移除由前端做——这里只需要一个**成功应答**，否则前端
/// `.then(移除卡片)` 永不执行，卡片会一直挂着（与 `invite_stop` 同款"留命令以免
/// 走 unknown command 分支"处理）。
#[tauri::command]
pub fn pair_request_dismiss(_did: String) -> Result<bool, String> {
    Ok(true)
}

/// 向 identity-svc 注册设备身份并登录（YoulingAuth「创建有灵账户」第一步）。
/// 薄封装 core 同名单一源（core 参数序为 (baseUrl, password)，前端 payload 为
/// `{password?, baseUrl?}`——此处按前端契约取名，转调时对位）。
#[tauri::command]
pub async fn identity_register_login(
    password: Option<String>,
    base_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let id = core_id::identity_register_login(base_url, password).await?;
    Ok(serde_json::json!({
        "did": id.did,
        "publicKeyB64": id.public_key_b64,
        "sessionToken": id.session_token,
        "sessionExpiresAt": id.session_expires_at,
    }))
}

/// `/signal/drain` 响应 → 前端契约 `[{did, name, dev?, ts}]` 的**纯映射**
/// （抽出来单测：服务端字段 `from` ↔ 前端字段 `did`，只取 `type=='pair'`，
/// 缺 `ts` 兜底 **当前时间**（2026-10-09 用户实测：此前兜底 0 → 前端超时过滤
/// `now - 0 < 300_000` = false → 全部被过滤 → 确认卡秒消失）。 */
pub(crate) fn map_pair_requests(v: &serde_json::Value) -> Vec<serde_json::Value> {
    let arr = v.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default();
    let now = now_ms();
    arr.iter()
        .filter(|m| m.get("type").and_then(|t| t.as_str()) == Some("pair"))
        .filter_map(|m| {
            let did = m.get("from").and_then(|x| x.as_str())?;
            Some(serde_json::json!({
                "did": did,
                "name": m.get("name").and_then(|x| x.as_str()).unwrap_or(""),
                "dev": m.get("dev").and_then(|x| x.as_str()),
                // ts 缺失时用当前时间（新申请的时间=现在）——否则前端超时过滤会误杀
                "ts": m.get("ts").and_then(|x| x.as_u64()).unwrap_or(now),
            }))
        })
        .collect()
}

/// 测试形态：watch_tick 的 emit/系统通知路径在 cfg(test) 下不编译（tauri GUI
/// 运行时链不进测试 exe）——替换为计数桩，单测断言「收编通知 → 触发取件」接线。
#[cfg(test)]
pub fn trigger_delegation_pickup() {    TEST_PICKUP_TRIGGERS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(test)]
pub static TEST_PICKUP_TRIGGERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// 一轮探测的产出（单测断言面）。fs 副作用（accept_received/accounts_upsert）与
/// UI 副作用（emit/系统通知）都在外层 watch_tick——probe 本身无写盘，可指 mock 直测。
#[derive(Debug)]
pub enum WatchOutcome {
    /// 名册反查无此设备（404 或无 attest）——未被收编，本轮无事。
    NotOnRoster,
    /// 已被该账号收编且本机凭据就绪（主设备自持种子 / 已有有效委任状）。
    AlreadySettled { root_did: String },
    /// 已被收编但信箱暂无委任状（或投来的委任状验签不过）——下轮再取。
    MailboxEmpty { root_did: String },
    /// 取到并验过的新委任状（待外层落盘+入清单+通知）。
    Accepted { root_did: String, name: String, delegation: myco_core::delegation::Delegation },
}

/// 启动被收编端轮询环。lib.rs setup 调一次（GUI 常驻）。
pub fn start_delegation_watch(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // 设备钥就绪前等待（IdentityStore 落盘是惰性的，冷启动可能要一小会儿）
        for _ in 0..30 {
            if core_id::device_identity().is_ok() { break }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        loop {
            if let Err(e) = watch_tick(&app).await {
                eprintln!("[delegation-watch] 本轮失败（{WATCH_INTERVAL_SECS}s 后重试）: {e}");
            }
            tokio::time::sleep(std::time::Duration::from_secs(WATCH_INTERVAL_SECS)).await;
        }
    });
}

async fn watch_tick(app: &tauri::AppHandle) -> Result<(), String> {
    // C-3 会话委任状到期前状态（方案 A：只广播给界面，不发系统通知）：复用本 20s
    // 常驻环（自身节流到每分钟，见 SESSION_KEY_CHECK_INTERVAL_MS）——不新起线程。
    // 放在取件去重之前：取件失败/在飞都不该让状态广播停摆。
    session_key_warn_tick(app);
    // 并发去重（P2P 通知触发 × 20s 环撞车）：在飞即弃，不双弹提示。
    if TICK_IN_FLIGHT.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Ok(());
    }
    let r = watch_tick_inner(app).await;
    TICK_IN_FLIGHT.store(false, std::sync::atomic::Ordering::SeqCst);
    r
}

async fn watch_tick_inner(app: &tauri::AppHandle) -> Result<(), String> {
    let (_dev_did, dev_seed_b64) = core_id::device_identity()?;
    let seed_b = base64::engine::general_purpose::STANDARD
        .decode(dev_seed_b64).map_err(|e| e.to_string())?;
    let arr: [u8; 32] = seed_b.try_into().map_err(|_| "设备种子长度坏".to_string())?;
    let dev_pub_b64 = b64e(&ed25519_dalek::SigningKey::from_bytes(&arr).verifying_key().to_bytes());
    match watch_probe_at(&base_url(), &dev_pub_b64, |root| {
        myco_core::delegation::Delegations::load().has_valid_for(root, &dev_pub_b64)
    }).await? {
        WatchOutcome::NotOnRoster => Ok(()),
        WatchOutcome::MailboxEmpty { root_did } => {
            let _ = root_did; // 下轮再取；字段供单测断言/日志定位
            Ok(())
        }
        WatchOutcome::AlreadySettled { root_did } => {
            // 静默自愈：凭据在但账号清单缺条目（历史残留/手动清过）→ 补 upsert，
            // 不发通知（不是新收编）。accounts_load_with_roles 的 role=agent 判定
            // 只靠委任状，这里补的是「清单里看得见」。
            let listed = core_id::accounts_load().iter().any(|a| {
                a.get("did").and_then(|d| d.as_str())
                    .map(|s| core_id::account_did_eq(s, &root_did)).unwrap_or(false)
            });
            if !listed {
                let name = fetch_account_name_at(&base_url(), &root_did).await
                    .unwrap_or_else(|| "有灵账号".into());
                core_id::accounts_upsert(&root_did, &name);
            }
            Ok(())
        }
        WatchOutcome::Accepted { root_did, name, delegation } => {
            // 2026-10-06 三场景提示文案（用户明确要求三场景都要可见提示）：
            // ① 首次收（无委任状无种子）→ "已被收编为成员"；② 重复收（已有委任状无种子）
            // → "授权已刷新"；③ 已持主账号种子 → "已是主设备（授权已刷新）"。
            // 判定须在 upsert/accept 前（它们会改本地状态）。
            let is_embodiment = core_id::accounts_load_with_roles().iter().any(|a| {
                a.get("did").and_then(|d| d.as_str())
                    .map(|s| core_id::account_did_eq(s, &root_did)).unwrap_or(false)
                    && a.get("role").and_then(|r| r.as_str()) == Some("embodiment")
            });
            let had_delegation = myco_core::delegation::Delegations::load()
                .has_valid_for(&root_did, &dev_pub_b64);
            let refreshed = had_delegation && !is_embodiment;
            myco_core::delegation::Delegations::load().accept_received(delegation);
            core_id::accounts_upsert(&root_did, &name);
            // 设备群挂点②（设备群设计 决策B）：取到委任状=账号就位——立即 ensure 设备群
            // （幂等；该账号尚未激活时登录闸内静默无操作，后续 state_snapshot 挂点接管）。
            let _ = crate::chat_service::ensure_device_group();
            let _ = app; // cfg(test) 下 emit/通知块不编译，app 未用
            // cfg(not(test))：同 myco_import——emit/通知路径会把 tauri GUI 运行时
            // 链进测试 exe（无 SxS manifest 即 ENTRYPOINT_NOT_FOUND）。
            #[cfg(not(test))]
            {
                use tauri::Emitter as _;
                let _ = app.emit("delegation-received", serde_json::json!({ "rootDid": root_did, "name": name, "isEmbodiment": is_embodiment, "refreshed": refreshed }));
                use tauri_plugin_notification::NotificationExt as _;
                let body = if is_embodiment {
                    format!("你已是 {name} 的主设备")
                } else if refreshed {
                    format!("{name} 的授权已刷新")
                } else {
                    format!("你已被 {name} 收编为成员——打开 myco 查看")
                };
                let _ = app.notification().builder()
                    .title("myco")
                    .body(body)
                    .show();
            }
            Ok(())
        }
    }
}

/// 一轮探测（无写盘；base 显式传入供单测指 mock）。
/// have_valid：「本地是否已有该账号签给本设备钥的有效委任状」判定注入——生产传
/// Delegations::load().has_valid_for，测试传 |_| false 避免碰真实 config 目录
/// （load() 的过期清理可能写盘）。
pub async fn watch_probe_at(
    base: &str,
    device_pubkey_b64: &str,
    have_valid: impl Fn(&str) -> bool,
) -> Result<WatchOutcome, String> {
    // ① 名册反查——多账号列表（L3 修）：设备可同时归属多个账号，逐个视为候选
    let roots = lookup_device_roster(base, device_pubkey_b64).await?;
    if roots.is_empty() {
        return Ok(WatchOutcome::NotOnRoster);
    }
    // 本机就是某个归属账号的主设备（持种子）→ 名册上是自己，无需委任状
    if let Some(cur) = core_id::account_did() {
        if core_id::cached_account_seed().is_some() {
            if let Some((r, _)) = roots.iter().find(|(r, _)| core_id::account_did_eq(&cur, r)) {
                return Ok(WatchOutcome::AlreadySettled { root_did: r.clone() });
            }
        }
    }
    // 2026-10-06 场景②修复：poll 移到 has_valid_for 之前——原逻辑「本地已有委任状
    // 就不 poll」导致重复添加的新投递永远积压不被取、永远 AlreadySettled 静默
    // （用户重复添加无任何反应）。/delegation/poll 拉走即删——只要取到件就一定是
    // 新投递（首次或重复添加），收下并提示；取不到才看本地是否已有（稳态静默）。
    let maybe_d = poll_delegation_at(base, device_pubkey_b64).await?;
    let Some(d) = maybe_d else {
        // 信箱空：任一归属账号已有有效委任状=稳态静默；否则待投
        if let Some((r, _)) = roots.iter().find(|(r, _)| have_valid(r)) {
            return Ok(WatchOutcome::AlreadySettled { root_did: r.clone() });
        }
        return Ok(WatchOutcome::MailboxEmpty { root_did: roots[0].0.clone() });
    };
    // 投来的件必须正是「某个归属账号签给本设备钥」且验签过——否则视为毒件跳过
    // （不 error-loop）。L3 修：归属判定从"单值 rootDid 相等"放宽为"任一归属账号
    // 匹配"——多归属下非最近账号的投递不得按毒件丢弃（那正是 A 永远不"活"的根因）。
    let owner_root = roots
        .iter()
        .find(|(r, _)| core_id::account_did_eq(&d.account_did, r))
        .map(|(r, _)| r.clone());
    if d.device_pubkey_b64 != device_pubkey_b64 || owner_root.is_none() {
        eprintln!("[delegation-watch] 信箱委任状归属不符（跳过）");
        return Ok(WatchOutcome::MailboxEmpty { root_did: roots[0].0.clone() });
    }
    if let Err(e) = myco_core::delegation::verify(&d) {
        eprintln!("[delegation-watch] 信箱委任状验签不过（跳过）: {e}");
        return Ok(WatchOutcome::MailboxEmpty { root_did: roots[0].0.clone() });
    }
    // 2026-10-06 nonce 去重：/delegation/poll 服务端只读不删（deliverBox.get 永久保留），
    // 同一张委任状每 20s 都会取到——已收过的（同 nonce）跳过静默，防"每 20s 重复弹
    // 授权已刷新"（用户实测启动后反复刷 Fan 授权）。不同 nonce=新投递才收下。
    // 账号维度取委任状自己的 accountDid（签发者），不是反查列表里的其他归属账号。
    let owner = owner_root.unwrap_or_else(|| d.account_did.clone());
    let local_nonce = myco_core::delegation::Delegations::load()
        .current_nonce_for(&owner, device_pubkey_b64);
    if local_nonce.as_deref() == Some(d.nonce.as_str()) {
        return Ok(WatchOutcome::AlreadySettled { root_did: owner });
    }
    let name = fetch_account_name_at(base, &owner).await.unwrap_or_else(|| "有灵账号".into());
    Ok(WatchOutcome::Accepted { root_did: owner, name, delegation: d })
}

/// 名册反查（手机端 fetchMyRoot 对等）：GET /device/<pubkey> → 该设备的**全部**
/// 归属账号 [(rootDid, attestSigB64)]；404/字段缺 = 未被收编 空 vec。
/// base64 公钥含 +/= 必须百分编码进路径段。
/// 2026-10-09 多归属修(L3)：服务端契约升级为 `data.roots` 多账号列表（服务端
/// `ORDER BY addedAt DESC LIMIT 1` 单值反查是结构性根因——设备先被 A 收编、
/// 再被 B 收编后永远只发现 B，A 静默失联）。roots 缺失时回落 legacy 单值
/// `rootDid`+`attestSigB64`（两代服务端都兼容）。顺序：roots 数组序（服务端
/// 按 addedAt 升序给全量），不再隐含"最近加入优先"。
async fn lookup_device_roster(base: &str, device_pubkey_b64: &str) -> Result<Vec<(String, String)>, String> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build().map_err(|e| e.to_string())?;
    let enc: String = url::form_urlencoded::byte_serialize(device_pubkey_b64.as_bytes()).collect();
    let r = http.get(format!("{}/device/{}", base.trim_end_matches('/'), enc))
        .send().await.map_err(|e| format!("device 反查失败: {e}"))?;
    if r.status().as_u16() == 404 {
        return Ok(Vec::new());
    }
    if !r.status().is_success() {
        return Err(format!("device 反查 status={}", r.status()));
    }
    let v: serde_json::Value = r.json().await.map_err(|e| e.to_string())?;
    let data = v.get("data").cloned().unwrap_or(serde_json::Value::Null);
    let top_attest = data.get("attestSigB64").and_then(|x| x.as_str()).unwrap_or("").to_string();
    // 多账号列表形态（服务端修后契约）：roots[] 每项 {rootDid, attestSigB64?}
    let mut roots: Vec<(String, String)> = data
        .get("roots")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    let rd = e.get("rootDid").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    if rd.is_empty() { return None; }
                    let at = e.get("attestSigB64").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    Some((rd, at))
                })
                .collect()
        })
        .unwrap_or_default();
    // legacy 单值形态回落（两代服务端兼容）：roots 缺失/为空才看单值，防双计
    if roots.is_empty() {
        let root = data.get("rootDid").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if !root.is_empty() && !top_attest.is_empty() {
            roots.push((root, top_attest));
        }
    } else if !top_attest.is_empty() {
        // roots 项缺 attest 时用顶层 attest 补（同一设备钥的 attest 同源）
        for r in roots.iter_mut() {
            if r.1.is_empty() { r.1 = top_attest.clone(); }
        }
    }
    Ok(roots)
}

/// 取委任状（手机端 pollDelegation 对等）：GET /delegation/poll?devicePubkeyB64=... → data。
async fn poll_delegation_at(base: &str, device_pubkey_b64: &str) -> Result<Option<myco_core::delegation::Delegation>, String> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build().map_err(|e| e.to_string())?;
    let r = http.get(format!("{}/delegation/poll", base.trim_end_matches('/')))
        .query(&[("devicePubkeyB64", device_pubkey_b64)])
        .send().await.map_err(|e| format!("delegation/poll 失败: {e}"))?;
    if !r.status().is_success() {
        return Ok(None);
    }
    let v: serde_json::Value = r.json().await.map_err(|e| e.to_string())?;
    match v.get("data") {
        Some(dv) if !dv.is_null() => Ok(serde_json::from_value(dv.clone()).ok()),
        _ => Ok(None),
    }
}

/// 账号名解析（GET /root/<did> → data.name；查不到/空名 None）。
async fn fetch_account_name_at(base: &str, root_did: &str) -> Option<String> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build().ok()?;
    let r = http.get(format!("{}/root/{}", base.trim_end_matches('/'), root_did))
        .send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let v: serde_json::Value = r.json().await.ok()?;
    let name = v.pointer("/data/name")?.as_str()?.trim().to_string();
    if name.is_empty() { None } else { Some(name) }
}

// ============================================================================
// 测试（2026-09-30 批A：myco_import 三态——此处覆盖 格式错/密码错 两个纯态；
// 成功态有真实副作用：写身份文件+翻 account_did 桶路由+core base_url OnceLock，
// 与本进程 chat/offline_queue 的 set-once 测试夹具不可共存（实测并行干扰：
// meta 索引丢项/群自愈建群失败）——挪 tests/restore_import.rs 独立进程跑）
// ============================================================================

#[cfg(test)]
mod import_tests {
    use super::*;
    use base64::Engine as _;

    fn b64(b: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(b)
    }

    #[tokio::test]
    async fn import_rejects_malformed_backup() {
        // 非 base64 垃圾 → b64d 解出空串 → 长度≠32 → 格式不对（无文件写/无网络）
        let e = myco_import("这不是恢复码!!!".into(), String::new()).await.unwrap_err();
        assert!(e.contains("备份格式不对"), "unexpected: {e}");
        // base64 合法但只有 10 字节 → 同样格式不对
        let e = myco_import(b64(&[1u8; 10]), String::new()).await.unwrap_err();
        assert!(e.contains("备份格式不对"), "unexpected: {e}");
        // 加密备份形态缺字段（ct= 但无 salt/iv）
        let e = myco_import(format!("ct={}", b64(&[9u8; 48])), "pw".into()).await.unwrap_err();
        assert!(e.contains("缺 salt") || e.contains("缺 iv"), "unexpected: {e}");
    }

    #[tokio::test]
    async fn import_rejects_wrong_password() {
        // 加密备份（ct/salt/iv 形态良好但内容随机）+ 任意密码 → AES-GCM 标签校验失败
        // ≡ 密码不对（错误路径与真备份输错密码完全同构：解密失败即拒）
        let text = format!("ct={}\nsalt={}\niv={}", b64(&[3u8; 48]), b64(&[4u8; 16]), b64(&[5u8; 12]));
        let e = myco_import(text.clone(), "wrong-pw".into()).await.unwrap_err();
        assert!(e.contains("decrypt"), "密码错应报解密失败: {e}");
        // 加密备份不给密码 → 明确要密码（先于解密短路）
        let e = myco_import(text, String::new()).await.unwrap_err();
        assert!(e.contains("需要密码"), "unexpected: {e}");
    }
}

// ============================================================================
// 2026-10-06 任务1/2 单测：委任状签发投递（/delegation/deliver 契约）+
// 被收编端轮询发现（/device 反查 → /delegation/poll → 验签）全链 mock 直测。
// mock 模式与 core identity.rs roster_self_heal 测试同款（裸 TcpListener 应答）。
// watch_probe_at 无写盘（落盘/通知在外层 watch_tick）——测试不碰真实 config 目录写。
// ============================================================================

#[cfg(test)]
mod delegation_watch_tests {
    use super::*;
    use base64::Engine as _;

    /// 确定性测试账号（seed→canonical `did:myco:z<base58btc(ed01+pub)>`——
    /// canonical-only（2026-10-10）：legacy 裸 base58 已废止，委任状验证不再收；
    /// 与另一前缀 canonical 写法公钥级互认）。
    fn test_soul(b: u8) -> ([u8; 32], String) {
        let mut seed = [b; 32];
        for (i, x) in seed.iter_mut().enumerate() {
            *x = x.wrapping_add(i as u8).rotate_left(3);
        }
        let sk = ed25519_dalek::SigningKey::from_bytes(&seed);
        (seed, core_id::did_from_public(&sk.verifying_key().to_bytes()))
    }

    type Route = std::sync::Arc<dyn Fn(&str, &str, &str) -> Option<(u16, String)> + Send + Sync>;

    /// 最小 identity-svc mock：按 (method, path, body) 路由应答；None → 404。
    /// 返回 (base_url, 捕获的请求日志 [(method, path, body)])。
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
                    let reason = match status { 200 => "OK", 201 => "Created", 404 => "Not Found", 500 => "Internal Server Error", _ => "X" };
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

    /// 任务1：deliver 投出的 body 必须是手机端契约（accountDid/devicePubkeyB64/…/sigB64
    /// 全齐）且签名可被 delegation::verify 验过——链路两端靠这张委任状对上。
    #[tokio::test]
    async fn deliver_posts_phone_contract_body() {
        let (base, hits) = mock_svc(std::sync::Arc::new(|m, p, _b| {
            if m == "POST" && p == "/delegation/deliver" { Some((200, r#"{"ok":true}"#.into())) } else { None }
        })).await;
        let (seed, soul) = test_soul(0x11);
        let dev_pub = b64e(&[0x22u8; 32]);
        let d = myco_core::delegation::issue_with_ttl(
            &seed, &soul, &dev_pub, "笔记本", None, myco_core::delegation::DEVICE_DELIVER_TTL_MS, "d",
        );
        deliver_delegation_http(&base, &d).await.expect("2xx 应投递成功");
        let hits = hits.lock().unwrap();
        assert_eq!(hits.len(), 1, "应恰好一发 deliver: {hits:?}");
        assert_eq!(hits[0].1, "/delegation/deliver");
        let v: serde_json::Value = serde_json::from_str(&hits[0].2).unwrap();
        for k in ["accountDid", "devicePubkeyB64", "deviceName", "scopes", "issuedAt", "exp", "nonce", "sigB64"] {
            assert!(v.get(k).is_some(), "投递体缺字段 {k}: {v}");
        }
        assert_eq!(v["accountDid"], serde_json::json!(soul));
        assert_eq!(v["devicePubkeyB64"], serde_json::json!(dev_pub));
        assert_eq!(v["scopes"], serde_json::json!("*"));
        assert_eq!(v["exp"].as_u64().unwrap() - v["issuedAt"].as_u64().unwrap(), myco_core::delegation::DEVICE_DELIVER_TTL_MS);
        // 服务端视角验收：body 反序列化回 Delegation 验签过
        let back: myco_core::delegation::Delegation = serde_json::from_str(&hits[0].2).unwrap();
        assert!(myco_core::delegation::verify(&back).is_ok(), "投递的委任状必须验签过");
    }

    /// 任务1 失败面：deliver 5xx → Err（调用方不挡配对但如实标 delegationDelivered=false）。
    #[tokio::test]
    async fn deliver_5xx_is_err() {
        let (base, _hits) = mock_svc(std::sync::Arc::new(|m, p, _b| {
            if m == "POST" && p == "/delegation/deliver" { Some((500, r#"{"error":"boom"}"#.into())) } else { None }
        })).await;
        let (seed, soul) = test_soul(0x12);
        let d = myco_core::delegation::issue_with_ttl(&seed, &soul, &b64e(&[0x23u8; 32]), "x", None, 1000, "d");
        let e = deliver_delegation_http(&base, &d).await.unwrap_err();
        assert!(e.contains("500"), "unexpected: {e}");
    }

    /// 任务2：名册反查 404（未被收编）→ NotOnRoster。
    #[tokio::test]
    async fn probe_not_on_roster() {
        let (base, _h) = mock_svc(std::sync::Arc::new(|_m, _p, _b| None)).await;
        let out = watch_probe_at(&base, &b64e(&[0x31u8; 32]), |_| false).await.unwrap();
        assert!(matches!(out, WatchOutcome::NotOnRoster), "unexpected: {out:?}");
    }

    /// 任务2：在名册上但信箱空 → MailboxEmpty（下轮再取，不报错）。
    #[tokio::test]
    async fn probe_mailbox_empty() {
        let (_seed, soul) = test_soul(0x13);
        let soul2 = soul.clone();
        let (base, _h) = mock_svc(std::sync::Arc::new(move |m, p, _b| {
            if m == "GET" && p.starts_with("/device/") {
                Some((200, format!(r#"{{"data":{{"rootDid":"{soul2}","attestSigB64":"AAAA","addedAt":1}}}}"#)))
            } else if m == "GET" && p.starts_with("/delegation/poll") {
                Some((200, r#"{"data":null}"#.into()))
            } else { None }
        })).await;
        let out = watch_probe_at(&base, &b64e(&[0x32u8; 32]), |_| false).await.unwrap();
        match out {
            WatchOutcome::MailboxEmpty { root_did } => assert_eq!(root_did, soul),
            other => panic!("应 MailboxEmpty: {other:?}"),
        }
    }

    /// 任务2 全链：名册命中 → 信箱取件 → 归属/验签全过 → Accepted（带账号名）。
    /// 这是「PC 加笔记本为成员」笔记本侧 30s 内自动落凭据的探测段实证。
    #[tokio::test]
    async fn probe_accepts_valid_delegation() {
        let (seed, soul) = test_soul(0x14);
        let dev_pub = b64e(&[0x33u8; 32]);
        let d = myco_core::delegation::issue_with_ttl(
            &seed, &soul, &dev_pub, "笔记本", None, myco_core::delegation::DEVICE_DELIVER_TTL_MS, "d",
        );
        let soul2 = soul.clone();
        let deleg_json = serde_json::to_string(&d).unwrap();
        let (base, hits) = mock_svc(std::sync::Arc::new(move |m, p, _b| {
            if m == "GET" && p.starts_with("/device/") {
                Some((200, format!(r#"{{"data":{{"rootDid":"{soul2}","attestSigB64":"AAAA","addedAt":1}}}}"#)))
            } else if m == "GET" && p.starts_with("/delegation/poll") {
                Some((200, format!(r#"{{"data":{deleg_json}}}"#)))
            } else if m == "GET" && p.starts_with("/root/") {
                Some((200, r#"{"data":{"name":"Fan"}}"#.into()))
            } else { None }
        })).await;
        let out = watch_probe_at(&base, &dev_pub, |_| false).await.unwrap();
        match out {
            WatchOutcome::Accepted { root_did, name, delegation } => {
                assert!(core_id::account_did_eq(&root_did, &soul));
                assert_eq!(name, "Fan", "账号名应取自 /root/<did>");
                assert!(myco_core::delegation::verify(&delegation).is_ok());
                assert_eq!(delegation.device_pubkey_b64, dev_pub);
            }
            other => panic!("应 Accepted: {other:?}"),
        }
        // poll 请求必须带 devicePubkeyB64 query（手机端契约）
        let hits = hits.lock().unwrap();
        let poll = hits.iter().find(|(m, p, _)| m == "GET" && p.starts_with("/delegation/poll")).expect("应发过 poll");
        assert!(poll.1.contains("devicePubkeyB64="), "poll 缺 query: {}", poll.1);
    }

    /// 任务2 安全面：信箱投来的委任状签名被篡改 → 拒收（MailboxEmpty），绝不落盘。
    #[tokio::test]
    async fn probe_rejects_tampered_delegation() {
        let (seed, soul) = test_soul(0x15);
        let dev_pub = b64e(&[0x34u8; 32]);
        let mut d = myco_core::delegation::issue_with_ttl(
            &seed, &soul, &dev_pub, "笔记本", None, myco_core::delegation::DEVICE_DELIVER_TTL_MS, "d",
        );
        d.device_name = "被篡改".into(); // 改字段不重签 → 验签必挂
        let soul2 = soul.clone();
        let deleg_json = serde_json::to_string(&d).unwrap();
        let (base, _h) = mock_svc(std::sync::Arc::new(move |m, p, _b| {
            if m == "GET" && p.starts_with("/device/") {
                Some((200, format!(r#"{{"data":{{"rootDid":"{soul2}","attestSigB64":"AAAA","addedAt":1}}}}"#)))
            } else if m == "GET" && p.starts_with("/delegation/poll") {
                Some((200, format!(r#"{{"data":{deleg_json}}}"#)))
            } else { None }
        })).await;
        let out = watch_probe_at(&base, &dev_pub, |_| false).await.unwrap();
        assert!(matches!(out, WatchOutcome::MailboxEmpty { .. }), "篡改件必须拒收: {out:?}");
    }

    /// 任务2 安全面：信箱投来的委任状归属别的设备钥 → 拒收。
    #[tokio::test]
    async fn probe_rejects_wrong_device_delegation() {
        let (seed, soul) = test_soul(0x16);
        let d = myco_core::delegation::issue_with_ttl(
            &seed, &soul, &b64e(&[0x99u8; 32]), "别人的设备", None, myco_core::delegation::DEVICE_DELIVER_TTL_MS, "d",
        );
        let soul2 = soul.clone();
        let deleg_json = serde_json::to_string(&d).unwrap();
        let (base, _h) = mock_svc(std::sync::Arc::new(move |m, p, _b| {
            if m == "GET" && p.starts_with("/device/") {
                Some((200, format!(r#"{{"data":{{"rootDid":"{soul2}","attestSigB64":"AAAA","addedAt":1}}}}"#)))
            } else if m == "GET" && p.starts_with("/delegation/poll") {
                Some((200, format!(r#"{{"data":{deleg_json}}}"#)))
            } else { None }
        })).await;
        let out = watch_probe_at(&base, &b64e(&[0x35u8; 32]), |_| false).await.unwrap();
        assert!(matches!(out, WatchOutcome::MailboxEmpty { .. }), "归属不符必须拒收: {out:?}");
    }

    // ── 邀请码方向 B（2026-10-08 补 home exe 的 invite_start / pair_requests）──

    /// `/signal/drain` 响应 → 前端契约的映射（字段改名 from→did、只取 pair、
    /// 缺字段兜底）——前端 MycoDevices 轮询按 `[{did,name,dev?,ts}]` 消费。
    #[test]
    fn map_pair_requests_contract() {
        let v = serde_json::json!({
            "data": [
                { "type": "pair", "from": "did:myco:zAAA", "name": "我的手机", "dev": "HONOR MBH-AN10", "ts": 111 },
                { "type": "pair", "from": "did:myco:zBBB" },                       // 缺 name/dev/ts
                { "type": "signal", "from": "did:myco:zCCC", "name": "非配对消息" }, // 必须滤掉
                { "type": "pair" }                                                  // 缺 from → 丢
            ]
        });
        let reqs = map_pair_requests(&v);
        assert_eq!(reqs.len(), 2, "只应保留两条合法 pair: {reqs:?}");
        assert_eq!(reqs[0]["did"], "did:myco:zAAA", "from 必须改名为 did（前端契约）");
        assert_eq!(reqs[0]["name"], "我的手机");
        assert_eq!(reqs[0]["dev"], "HONOR MBH-AN10");
        assert_eq!(reqs[0]["ts"], 111);
        assert_eq!(reqs[1]["did"], "did:myco:zBBB");
        assert_eq!(reqs[1]["name"], "", "缺 name 兜底空串");
        // 2026-10-09：ts 缺失时兜底**当前时间**（不是 0）——否则前端超时过滤 `now - 0 < 300_000`
        // = false → 全部被过滤 → PC 确认卡秒消失（用户实测）。断言：ts > 0 且接近当前时间。
        let ts1 = reqs[1]["ts"].as_u64().unwrap_or(0);
        assert!(ts1 > 0, "缺 ts 应兜底当前时间（非 0）: ts={ts1}");
        assert!(ts1 >= now_ms() - 5000, "兜底 ts 应接近当前时间: ts={ts1} now={}", now_ms());
    }

    #[test]
    fn map_pair_requests_empty_and_malformed() {
        assert!(map_pair_requests(&serde_json::json!({})).is_empty());
        assert!(map_pair_requests(&serde_json::json!({ "data": [] })).is_empty());
        assert!(map_pair_requests(&serde_json::json!({ "data": "not-an-array" })).is_empty());
    }

    /// 邀请码 nonce/exp 契约：16 位 hex + 5 分钟有效期（前端把它拼进
    /// `{v:1,type:'myco-invite',did,nonce,exp,name}` 二维码载荷）。
    #[tokio::test]
    async fn invite_start_returns_nonce_and_exp() {
        let v = invite_start().await.unwrap();
        let nonce = v["nonce"].as_str().expect("nonce 必须是字符串");
        assert_eq!(nonce.len(), 16, "nonce 应为 16 位 hex: {nonce}");
        assert!(nonce.chars().all(|c| c.is_ascii_hexdigit()), "nonce 必须全 hex: {nonce}");
        let exp = v["exp"].as_u64().expect("exp 必须是数字(ms)");
        let now = now_ms();
        assert!(exp > now && exp <= now + 300_001, "exp 应为 now+5min 窗口: exp={exp} now={now}");
    }
}

// ══════════════ 2026-10-10：会话委任状 C-2 到期跟踪 + C-3 到期前状态 单测 ══════════════
// 事故背景：会话委任状（12h）到期后无恢复路径 → 工人做完题提交时 40109 卡死。
// 设计稿 §4/§6：客户端**零私钥**、session-key.json 只许 {公钥, exp, issuedAt}、
// 同一 exp 只提醒一次。全部用例走真实文件（临时目录），不碰真实 config 目录。
// 同日收尾两件（设计定稿）：
//   任务1 **静默加固**：静默只允许"续期"（钥必须已在 session-key.json），新钥一律拒；
//   任务2 **方案 A**：不发系统通知（「总之不想打扰用户」），改由 session_key_status
//   命令 + session-key-due 事件把状态交给界面显示。
#[cfg(test)]
mod session_key_tracking_tests {
    use super::*;

    /// 确定性测试账号（seed → canonical `did:myco:z…`；canonical-only（2026-10-10）：
    /// `delegation::verify` 收双前缀 canonical，legacy 裸 base58 已废止不再收）。
    fn test_account(b: u8) -> ([u8; 32], String) {
        let mut seed = [b; 32];
        for (i, x) in seed.iter_mut().enumerate() {
            *x = x.wrapping_add(i as u8).rotate_left(5);
        }
        let sk = ed25519_dalek::SigningKey::from_bytes(&seed);
        (seed, core_id::did_from_public(&sk.verifying_key().to_bytes()))
    }

    /// 独立临时目录 + 文件路径（按 tag+pid+ms 唯一，用例互不干扰）。
    fn tmp_path(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "myco-sessionkey-{tag}-{}-{}", std::process::id(), now_ms()
        ));
        (dir.clone(), dir.join("session-key.json"))
    }

    /// C-2 主用例：`session_delegation_sign` 签发后 session-key.json 的
    /// exp/issuedAt/公钥与返回的委任状逐字段一致（TTL=12h），且**文件里零私钥/
    /// 零种子/零签名**（设计稿 §4 安全边界硬要求）。
    #[test]
    fn session_key_file_holds_no_secret_fields() {
        let (seed, soul) = test_account(0x21);
        let (dir, path) = tmp_path("c2");
        let pk = b64e(&[0x33u8; 32]);
        let v = sign_session_delegation(&pk, false, || Ok((seed, soul)), &path).expect("签发应成功");

        // 返回体照旧=完整会话委任状（签发语义不变：browser-session / submit-answer）
        assert_eq!(v["deviceName"], serde_json::json!("browser-session"));
        assert_eq!(v["scopes"], serde_json::json!("submit-answer"));
        let back: myco_core::delegation::Delegation = serde_json::from_value(v.clone()).unwrap();
        assert!(myco_core::delegation::verify(&back).is_ok(), "返回的委任状必须验签过");

        // C-2 落盘：exp/issuedAt 取自返回的委任状本体（不重算）
        let raw = std::fs::read_to_string(&path).expect("session-key.json 应已落盘");
        let f: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(f["exp"], v["exp"], "文件 exp 必须等于返回的 exp");
        assert_eq!(f["issuedAt"], v["issuedAt"]);
        assert_eq!(f["sessionPubkeyB64"], serde_json::json!(pk));
        assert_eq!(
            f["exp"].as_u64().unwrap() - f["issuedAt"].as_u64().unwrap(),
            myco_core::delegation::SESSION_KEY_TTL_MS,
            "会话委任状 TTL 应为 12h"
        );
        assert!(f["exp"].as_u64().unwrap() > now_ms(), "exp 应在未来");
        // 读侧与 C-3 消费同一结构（文件→结构体→判定）
        assert_eq!(read_session_key_at(&path).unwrap().exp, back.exp);

        // ⚠️ §4：字段集恰好三个
        let mut keys: Vec<&str> = f.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["exp", "issuedAt", "sessionPubkeyB64"], "只许公钥+exp+issuedAt: {raw}");
        // ⚠️ §4：不得出现种子/私钥/签名类字样与任何密钥材料
        for bad in ["seed", "Seed", "privat", "Privat", "secret", "Secret", "dpapi", "cipher", "sig"] {
            assert!(!raw.contains(bad), "session-key.json 不得含「{bad}」: {raw}");
        }
        assert!(!raw.contains(b64e(&seed).as_str()), "不得含账号种子: {raw}");
        assert!(!raw.contains(back.sig_b64.as_str()), "不得含委任状签名: {raw}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// C-2 存储语义：缺文件/坏 JSON → None（静默无事，不 panic）；
    /// 多标签页多次签发 → **只留 exp 最晚的一条**（旧 exp 不许盖新 exp，乱序写亦然）。
    #[test]
    fn store_keeps_latest_exp_only() {
        let (dir, path) = tmp_path("store");
        assert!(read_session_key_at(&path).is_none(), "缺文件应 None");

        let rec = |exp: u64| SessionKeyRecord {
            session_pubkey_b64: b64e(&[0x55u8; 32]),
            exp,
            issued_at: exp - 1,
        };
        record_session_key_at(&path, &rec(1_000)).unwrap();
        assert_eq!(read_session_key_at(&path).unwrap().exp, 1_000);
        record_session_key_at(&path, &rec(500)).unwrap();
        assert_eq!(read_session_key_at(&path).unwrap().exp, 1_000, "旧 exp 不得覆盖新 exp");
        record_session_key_at(&path, &rec(2_000)).unwrap();
        assert_eq!(read_session_key_at(&path).unwrap().exp, 2_000, "更新的签发应覆盖");
        record_session_key_at(&path, &rec(2_000)).unwrap();
        assert_eq!(read_session_key_at(&path).unwrap().exp, 2_000, "同 exp 重写幂等");

        std::fs::write(&path, "{ not json").unwrap();
        assert!(read_session_key_at(&path).is_none(), "坏文件应 None（不误报到期）");
        std::fs::write(&path, r#"{"sessionPubkeyB64":"x","exp":1}"#).unwrap();
        assert!(read_session_key_at(&path).is_none(), "缺 issuedAt 应 None");

        // 落盘失败 → Err（调用方 best-effort 只 log，不影响签发返回）
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, "x").unwrap();
        assert!(
            record_session_key_at(&blocker.join("session-key.json"), &rec(3_000)).is_err(),
            "父路径是文件 → 写必失败"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// C-3 到期判定：剩 29min → 该提醒；剩 31min → 不提醒；已过期 → 该提醒。
    #[test]
    fn due_warn_boundaries() {
        let now = 1_700_000_000_000u64;
        assert!(session_key_due_warn(now + 29 * 60_000, now), "剩 29min 应提醒");
        assert!(!session_key_due_warn(now + 31 * 60_000, now), "剩 31min 不该提醒");
        assert!(!session_key_due_warn(now + SESSION_KEY_WARN_WINDOW_MS, now), "恰好 30min（开区间）不提醒");
        assert!(session_key_due_warn(now + 1, now), "剩 1ms 应提醒");
        assert!(session_key_due_warn(now, now), "恰好到期（now==exp）应提醒");
        assert!(session_key_due_warn(now - 60_000, now), "已过期 1min 应提醒（无下溢 panic）");
        assert!(!session_key_due_warn(now + 12 * 3600_000, now), "刚签发（剩 12h）不提醒");
    }

    /// C-3 去重：同一 exp 只提醒一次（防每分钟弹）；静默续期后的新 exp 可再提醒；
    /// 未进窗口的 exp 不消耗去重额度。
    #[test]
    fn same_exp_notified_once() {
        let now = 1_700_000_000_000u64;
        let exp = now + 10 * 60_000;
        let mut w = SessionKeyWarner::default();
        assert!(w.should_notify(exp, now), "首轮应提醒");
        assert!(!w.should_notify(exp, now + 20_000), "同 exp 20s 后（下一跳）不再提醒");
        assert!(!w.should_notify(exp, now + 60_000), "同 exp 下一分钟不再提醒");
        assert!(!w.should_notify(exp, exp + 3600_000), "同 exp 过期后仍不重复提醒");

        // 页面静默续期成功（C-1/F-2）→ 新 exp → 新窗口可再提醒
        let exp2 = exp + myco_core::delegation::SESSION_KEY_TTL_MS;
        assert!(!w.should_notify(exp2, now), "新 exp 未进窗口不提醒");
        assert!(w.should_notify(exp2, exp2 - 60_000), "新 exp 进窗口应提醒");
        assert!(!w.should_notify(exp2, exp2 - 30_000), "新 exp 已提醒过 → 不再提醒");

        // 未进窗口的 exp 不记账
        let mut w2 = SessionKeyWarner::default();
        let far = now + 3600_000;
        assert!(!w2.should_notify(far, now));
        assert!(w2.should_notify(far, far - 1_000), "进窗口后仍能提醒（未提前记账）");
    }

    /// C-2→C-3 全链（真实文件 + 真实签发）：签发落盘 → 读回 → 刚签发不提醒 →
    /// 时间推进到"剩 10min" → 提醒一次且只一次。
    #[test]
    fn signed_file_drives_warn_once() {
        let (dir, path) = tmp_path("chain");
        let (seed, soul) = test_account(0x22);
        sign_session_delegation(&b64e(&[0x44u8; 32]), false, || Ok((seed, soul)), &path).unwrap();
        let rec = read_session_key_at(&path).expect("C-2 应已落盘");

        let mut w = SessionKeyWarner::default();
        assert!(!w.should_notify(rec.exp, rec.issued_at), "刚签发（剩 12h）不该提醒");

        // 时间推进到"还剩 10 分钟"（只推进 now，不伪造文件）
        let later = rec.exp - 10 * 60_000;
        assert!(session_key_due_warn(rec.exp, later), "剩 10min 应进提醒窗口");
        assert!(w.should_notify(rec.exp, later), "首轮应提醒");
        assert!(!w.should_notify(rec.exp, later + 20_000), "同 exp 只提醒一次（20s 后下一跳）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// C-3 节流：20s 环上每分钟只查一次文件（首轮必查）。
    #[test]
    fn check_throttled_to_one_minute() {
        let t0 = 1_700_000_000_000u64;
        assert!(session_key_check_due(0, t0), "从未查过 → 立即查");
        assert!(!session_key_check_due(t0, t0 + 20_000), "20s（环的下一跳）不查");
        assert!(!session_key_check_due(t0, t0 + 59_999), "59.999s 不查");
        assert!(session_key_check_due(t0, t0 + 60_000), "60s 到点查");
        assert!(session_key_check_due(t0, t0 + 5 * 60_000), "隔久了补查");
    }

    // ────────── C-4（2026-10-22 设计定稿「小改进」）：陈旧记录自动清理 + 可点清除 ──────────

    /// C-4 边界（纯函数）：未过期恒 false；过期满 24h 才 stale；23h59m59.999s 仍未 stale。
    #[test]
    fn acc_c4_stale_boundary() {
        let now = 1_792_600_000_000u64;
        assert!(!session_key_stale(now + 1, now), "未过期 → 不 stale");
        assert!(!session_key_stale(now, now), "刚过期（0ms）→ 仍在 24h 宽限期内");
        assert!(!session_key_stale(now - (SESSION_KEY_STALE_MS - 1), now), "过期 23h59m59.999s → 未到清理线");
        assert!(session_key_stale(now - SESSION_KEY_STALE_MS, now), "过期满 24h → 清理");
        assert!(session_key_stale(now - SESSION_KEY_STALE_MS - 1, now), "超过 24h → 清理");
    }

    /// C-4 清理：删掉跟踪文件、二次调用幂等（返回 false 不报错）；没文件也安全。
    #[test]
    fn acc_c4_clear_idempotent() {
        let (dir, path) = tmp_path("c4-clear");
        std::fs::create_dir_all(&dir).unwrap();
        // 第一次：无文件 → false
        assert!(!clear_session_key_at(&path), "无记录时清理应返回 false 且不报错");
        // 有记录 → true，删后 read 为 None
        std::fs::write(&path, "{\"sessionPubkeyB64\":\"x\",\"exp\":1,\"issuedAt\":0}").unwrap();
        assert!(read_session_key_at(&path).is_some());
        assert!(clear_session_key_at(&path), "有记录 → 应删除并返回 true");
        assert!(read_session_key_at(&path).is_none(), "删除后 read 必须为 None（UI 整行消失）");
        // 第二次：幂等
        assert!(!clear_session_key_at(&path), "二次清理幂等返回 false");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// C-4 联动：过期 >24h 的记录在 status 语义下等价于「无记录」（=null，不渲染红字）。
    /// 这里直接验证判定 + 清理的组合口径（命令层 GUI 依赖 cfg(not(test))，纯逻辑在 test 下照测）。
    #[test]
    fn acc_c4_stale_record_reads_as_none() {
        let (dir, path) = tmp_path("c4-stale");
        std::fs::create_dir_all(&dir).unwrap();
        let now = now_ms();
        // 过期 25h 的陈旧记录
        let stale_rec = SessionKeyRecord {
            session_pubkey_b64: "cHViQQ==".into(),
            exp: now - 25 * 3600 * 1000,
            issued_at: now - 37 * 3600 * 1000,
        };
        record_session_key_at(&path, &stale_rec).unwrap();
        assert!(read_session_key_at(&path).is_some());
        if session_key_stale(stale_rec.exp, now) {
            let _ = clear_session_key_at(&path);
        }
        assert!(read_session_key_at(&path).is_none(), "陈旧记录应被清理 → 等价无记录（UI 不渲染）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ────────────── 任务1（2026-10-10）：静默加固——静默只允许"续期" ──────────────

    /// **静默 + 未授权会话钥 → 拒签**（安全闸主用例）。
    /// 静默 = 无用户可见确认：若放行，任意 *.youling.cc 页面（含被 XSS 的）都能让登录器
    /// 静默签出委任状。断言三点：Err、文案说明"仅限已授权"、**不落盘**（没签就不该记账）；
    /// 外加闸位：账号态不可用时报的仍是静默拒绝（闸在取账号钥之前，无签名副作用）。
    #[test]
    fn silent_denied_for_unregistered_pubkey() {
        let (seed, soul) = test_account(0x23);
        let (dir, path) = tmp_path("silent-denied");
        let pk_new = b64e(&[0x66u8; 32]);
        let err = sign_session_delegation(&pk_new, true, || Ok((seed, soul)), &path)
            .expect_err("未授权会话钥 + 静默 → 必须被拒");
        assert_eq!(err, SILENT_RENEW_DENIED_MSG, "拒签文案走单一源");
        assert!(err.contains("静默续期仅限已授权会话"), "文案应说明静默只限已授权: {err}");
        assert!(read_session_key_at(&path).is_none(), "被拒时不得落盘（没签就不该记账）");
        let _ = std::fs::remove_dir_all(&dir);

        // 闸位在取账号钥之前：账号态不可用 → 也应先吃静默拒绝（不是"未登录"）
        let (dir2, path2) = tmp_path("silent-denied-order");
        let err2 = sign_session_delegation(
            &b64e(&[0x69u8; 32]),
            true,
            || Err("本机未持有账号钥（或已锁定）".into()),
            &path2,
        )
        .expect_err("静默未授权应先被静默闸拦下");
        assert_eq!(err2, SILENT_RENEW_DENIED_MSG, "静默闸必须先于账号态: {err2}");
        let _ = std::fs::remove_dir_all(&dir2);
    }

    /// **静默 + 已授权会话钥（已在 session-key.json）→ 允许续期**，且不降级验签。
    #[test]
    fn silent_allowed_for_registered_pubkey() {
        let (seed, soul) = test_account(0x24);
        let (dir, path) = tmp_path("silent-allowed");
        let pk = b64e(&[0x67u8; 32]);
        // 先走一次正常授权（= 用户在浏览器登录时确认过的那把钥）
        sign_session_delegation(&pk, false, || Ok((seed, soul.clone())), &path)
            .expect("首次正常授权应成功");
        assert_eq!(read_session_key_at(&path).unwrap().session_pubkey_b64, pk);

        let v = sign_session_delegation(&pk, true, || Ok((seed, soul)), &path)
            .expect("已授权会话钥静默续期应允许");
        let back: myco_core::delegation::Delegation = serde_json::from_value(v.clone()).unwrap();
        assert!(myco_core::delegation::verify(&back).is_ok(), "静默续期不得降级验签");
        assert_eq!(v["scopes"], serde_json::json!("submit-answer"), "权限面不变");
        assert_eq!(v["deviceName"], serde_json::json!("browser-session"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **非静默 + 新 pubkey → 原行为允许**（正常授权流程不受加固影响），并顺带记账
    /// （下次同一把钥即可走静默续期）。
    #[test]
    fn non_silent_still_authorizes_new_pubkey() {
        let (seed, soul) = test_account(0x25);
        let (dir, path) = tmp_path("non-silent-new");
        let pk_new = b64e(&[0x68u8; 32]);
        assert!(read_session_key_at(&path).is_none(), "前置：本机从未签发过会话钥");
        let v = sign_session_delegation(&pk_new, false, || Ok((seed, soul)), &path)
            .expect("非静默新钥应允许（原行为）");
        assert!(v["sigB64"].is_string(), "应返回完整委任状: {v}");
        assert_eq!(
            read_session_key_at(&path).unwrap().session_pubkey_b64,
            pk_new,
            "新钥应被记账（下次即可静默续期）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 纯函数边界：只有**完全相等**的已授权钥才放行（空钥/空清单/前缀/大小写差异/
    /// 坏记录里的空公钥 一律拒——静默无确认，宁拒勿放）。
    #[test]
    fn silent_renew_allowed_boundaries() {
        let known = vec!["AAAA".to_string(), "BBBB".to_string()];
        assert!(silent_renew_allowed(&known, "AAAA"));
        assert!(silent_renew_allowed(&known, "BBBB"));
        assert!(!silent_renew_allowed(&known, "AAA"), "前缀不算已授权");
        assert!(!silent_renew_allowed(&known, "AAAAA"), "更长不算已授权");
        assert!(!silent_renew_allowed(&known, "aaaa"), "base64 区分大小写，大小写差异不算");
        assert!(!silent_renew_allowed(&known, "CCCC"), "未登记钥必须拒");
        assert!(!silent_renew_allowed(&known, ""), "空请求钥必须拒");
        assert!(!silent_renew_allowed(&[], "AAAA"), "空清单必须拒");

        // 坏记录（空公钥）不得被当成"已授权"
        let (dir, path) = tmp_path("empty-known");
        record_session_key_at(
            &path,
            &SessionKeyRecord { session_pubkey_b64: String::new(), exp: 9, issued_at: 1 },
        )
        .unwrap();
        assert!(known_session_pubkeys_at(&path).is_empty(), "空公钥不入已授权清单");
        assert!(!silent_renew_allowed(&known_session_pubkeys_at(&path), ""));
        // 缺文件 → 空清单（静默一律拒，不会误放行）
        assert!(known_session_pubkeys_at(&dir.join("nope.json")).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ────────────── 任务2（2026-10-10 方案 A）：通知改「界面显示」 ──────────────

    /// 状态视图契约：只暴露 `{exp,issuedAt,remainingMs,dueWarn}`——**零私钥/零公钥**；
    /// 已过期时 remainingMs 饱和到 0（UI 不用自己防下溢）。
    #[test]
    fn status_view_is_ui_ready_and_secret_free() {
        let now = 1_700_000_000_000u64;
        let rec = SessionKeyRecord {
            session_pubkey_b64: b64e(&[0x77u8; 32]),
            exp: now + 11 * 3600_000 + 32 * 60_000,
            issued_at: now,
        };
        let st = session_key_status_of(&rec, now);
        assert_eq!(st.remaining_ms, 11 * 3600_000 + 32 * 60_000, "剩余 = exp - now");
        assert!(!st.due_warn, "剩 11h32m 不进提醒窗口");
        assert_eq!(st.exp, rec.exp);
        assert_eq!(st.issued_at, rec.issued_at);

        let j = serde_json::to_value(&st).unwrap();
        let mut keys: Vec<&str> = j.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["dueWarn", "exp", "issuedAt", "remainingMs"], "UI 契约字段集固定: {j}");
        let raw = j.to_string();
        assert!(!raw.contains(&rec.session_pubkey_b64), "状态视图零公钥/零私钥: {raw}");
        for bad in ["seed", "privat", "secret", "sig", "pubkey", "Pubkey"] {
            assert!(!raw.contains(bad), "状态视图不得含「{bad}」: {raw}");
        }

        // 进窗口（剩 <30min）与已过期：dueWarn=true；已过期不得下溢
        assert!(session_key_status_of(&rec, rec.exp - 60_000).due_warn, "剩 1min 该提示");
        let expired = session_key_status_of(&rec, rec.exp + 5 * 60_000);
        assert_eq!(expired.remaining_ms, 0, "已过期不得下溢为负数");
        assert!(expired.due_warn, "已过期同样该提示（连恢复入口都没有）");
    }

    /// 回归钉（设计定稿方案 A：「总之不想打扰用户」——**不发 Windows 系统通知**）：
    /// 源码级锁死——会话委任状链路不得再出现通知插件调用，旧通知文案不得回归。
    /// （收编链路的系统通知是另一件事，不在本断言范围。）
    #[test]
    fn session_key_warn_never_uses_system_notification() {
        let src = include_str!("identity_service.rs");
        // 被禁文案拼出来比对（不写整串字面量：否则断言自身就把禁词写进了源码）
        let banned_body = ["网页提交授权将于 ", "30 分钟后过期"].concat();
        assert!(
            !src.contains(&banned_body),
            "方案 A：会话委任状到期只走界面显示，旧系统通知文案不得回归"
        );
        // 按函数切段取 session_key_warn_tick 的**生产体**（#[cfg(test)] 桩之前）
        let body = src
            .split("fn session_key_warn_tick")
            .nth(1)
            .and_then(|s| s.split("#[cfg(test)]").next())
            .unwrap_or("");
        assert!(body.contains("SESSION_KEY_DUE_EVENT"), "应能切出生产体且它广播状态: {body}");
        assert!(
            !body.contains("notification"),
            "方案 A：session_key_warn_tick 不得调用系统通知（只 emit 给界面）:\n{body}"
        );
    }
}


// ============================================================================
// 分身签名（wallet_sign_delegated）选状逻辑单测——2026-10-11 成员设备登录修复
// ============================================================================

#[cfg(test)]
mod delegation_pick_tests {
    use super::*;
    use myco_core::delegation::{Delegation, DelegationRecord};

    fn rec(account: &str, dev_pub: &str, exp: u64, revoked: bool) -> DelegationRecord {
        DelegationRecord {
            delegation: Delegation {
                account_did: account.into(),
                device_pubkey_b64: dev_pub.into(),
                device_name: "unit".into(),
                scopes: "*".into(),
                issued_at: 1_000,
                exp,
                nonce: format!("n{exp}"),
                sig_b64: String::new(),
            },
            revoked,
            last_renewed: 1_000,
        }
    }

    const DEV: &str = "lenh9m66iKXMW47yhF6FSMFkJdsjnx0Wm3cJEkb8nlo=";
    const OTHER_DEV: &str = "AAAAn66iKXMW47yhF6FSMFkJdsjnx0Wm3cJEkb8nlo=";
    const ACC: &str = "did:youling:z6Mknjywr4kBRLe2gj8X29ThWsFkjzqTq1VAj27WH1wnkoGc";

    #[test]
    fn picks_valid_delegation_for_device() {
        let recs = vec![rec(ACC, DEV, 2_000, false)];
        let got = pick_valid_delegation(&recs, DEV, 1_500, Some(ACC));
        assert!(got.is_some(), "未过期且未吊销的委任状必须选中");
    }

    #[test]
    fn rejects_expired_and_revoked_and_other_device() {
        let recs = vec![
            rec(ACC, DEV, 1_400, false),      // 已过期（now=1_500）
            rec(ACC, DEV, 2_000, true),       // 已吊销
            rec(ACC, OTHER_DEV, 2_000, false),// 别的设备公钥
        ];
        assert!(
            pick_valid_delegation(&recs, DEV, 1_500, Some(ACC)).is_none(),
            "过期/吊销/他设备三种都不得被选中（fail-closed）"
        );
    }

    #[test]
    fn prefers_current_account_then_latest_exp() {
        let other_acc = "did:youling:z6MkOTHER000000000000000000000000000000000000000";
        let recs = vec![
            rec(other_acc, DEV, 9_000, false), // exp 更大但归属别的账号
            rec(ACC, DEV, 2_000, false),       // 归属当前账号
        ];
        let got = pick_valid_delegation(&recs, DEV, 1_500, Some(ACC)).expect("应有可选委任状");
        assert_eq!(got.account_did, ACC, "有当前账号的委任状时优先用它");
        // 无账号偏好时退化为取 exp 最大
        let got2 = pick_valid_delegation(&recs, DEV, 1_500, None).expect("应有可选委任状");
        assert_eq!(got2.exp, 9_000, "无偏好时取 exp 最大者");
    }
}
