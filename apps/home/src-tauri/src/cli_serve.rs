//! cli_serve.rs — `myco cli serve` 无 UI HTTP 服务（headless 调用面）。
//!
//! API 面结构提取自 A2 myco-ubuntu serve.rs（identity/sign/device/delegation/healthz
//! 端点族），底层全部换成共享 crate core_id / core_deleg + cli.rs 的命令实现
//! （无第二套身份原语）。另加 POST /cli {cmd}——与 phone EnvServer :8210 的
//! /api/cli 通道同款（一行命令透传，脚本友好）。
//!
//! 端点（默认 :3102；MYCO_SERVE_PORT / --port 覆盖）：
//!   GET  /healthz                 → {ok, service, version, deviceDid, rootDid}
//!   GET  /identity/did            → DID Document（设备层 + 根账号层）
//!   GET  /identity/accounts       → 本机账号清单
//!   POST /identity/export-seed    → {seedB64}
//!   POST /sign                    {payload, as?} → {signature, did, algo, signer}
//!   GET  /device/list             → 云名册
//!   POST /device/register         {deviceDid, name?, noDelegation?} → attest 上云+顺签委任状
//!   POST /device/token            {deviceDid, scopes?, ttlSecs?} → {token}
//!   POST /device/verify-token     {token} → {valid, ...}
//!   POST /delegation/issue        {deviceDid, name?, scopes?} → {delegation, wire}
//!   POST /delegation/verify       {wire} → {valid, ...}
//!   GET  /delegation/list         → 本机委任状
//!   POST /attest                  {deviceDid} → {msg, sigB64, ...}
//!   GET  /status                  → 概要
//!   POST /cli                     {"cmd": "identity did"} → 任意上述命令行形式
//!
//! 另挂 HBL 发题智能体（hbl_ingest.rs；HBL_INGEST_ENABLED=true 才挂载）：
//!   POST /hbl/orders · GET /hbl/orders[/{id}]
//!   POST /hibianli/request（=/api/proxy/hibianli/request 旧 context-path 形）
//!
//! 错误约定（A2 同款）：业务失败 4xx/5xx + {"error": msg}。

use crate::cli::{self, Parsed};
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

pub struct Svc; // 无状态（密钥域在 config_dir，进程内即时加载）

type Shared = Arc<Svc>;

fn err(status: StatusCode, msg: impl Into<String>) -> (StatusCode, Json<serde_json::Value>) {
    (status, Json(json!({ "error": msg.into() })))
}

/// 业务 Result → HTTP 响应（Err 统一 400 前缀消歧：网络/上游失败 502，语义错 400）。
fn reply(r: Result<serde_json::Value, String>) -> (StatusCode, Json<serde_json::Value>) {
    match r {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => {
            let up = e.starts_with("attest 请求失败") || e.starts_with("revoke 请求失败");
            let st = if up { StatusCode::BAD_GATEWAY } else { StatusCode::BAD_REQUEST };
            err(st, e)
        }
    }
}

fn parsed(flags: HashMap<String, String>, positional: Vec<String>) -> Parsed {
    Parsed { positional, flags }
}

/// 命令层在 blocking 线程池跑：cli.rs 内部用 block_on 搭单线程 runtime（core_id
/// 的 async 调用），在 axum 的 async 上下文里直接调会嵌套 runtime panic——
/// spawn_blocking 隔离后 block_on 合法，同步网络（blocking reqwest）也不堵 reactor。
async fn run_sync<F>(f: F) -> Result<serde_json::Value, String>
where
    F: FnOnce() -> Result<serde_json::Value, String> + Send + 'static,
{
    tokio::task::spawn_blocking(f).await.map_err(|e| format!("命令执行失败: {e}"))?
}

// ─── identity / sign ───

async fn healthz(State(_s): State<Shared>) -> (StatusCode, Json<serde_json::Value>) {
    let device = myco_core::identity::local_did();
    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "service": "myco-home-cli",
            "version": env!("CARGO_PKG_VERSION"),
            "deviceDid": device,
            "rootDid": myco_core::identity::account_did(),
        })),
    )
}

async fn identity_did(State(_s): State<Shared>) -> (StatusCode, Json<serde_json::Value>) {
    reply(run_sync(move || cli::cmd_identity(&parsed(HashMap::new(), vec!["did".into()]))).await)
}

async fn identity_accounts(State(_s): State<Shared>) -> (StatusCode, Json<serde_json::Value>) {
    reply(run_sync(move || cli::cmd_identity(&parsed(HashMap::new(), vec!["list".into()]))).await)
}

#[derive(Deserialize)]
struct Empty {}

async fn identity_birth(State(_s): State<Shared>) -> (StatusCode, Json<serde_json::Value>) {
    reply(run_sync(move || cli::cmd_identity(&parsed(HashMap::new(), vec!["birth".into()]))).await)
}

async fn identity_export_seed(State(_s): State<Shared>, _b: Option<Json<Empty>>) -> (StatusCode, Json<serde_json::Value>) {
    // 2026-10-03 审计收口：种子导出=最高敏感端点，回环绑定之上再加显式环境开关
    // （MYCO_SERVE_ALLOW_SEED_EXPORT=1 才可用；默认拒绝——即便进程被错误暴露到
    // 0.0.0.0，种子也不能被裸取）。
    if std::env::var("MYCO_SERVE_ALLOW_SEED_EXPORT").ok().as_deref() != Some("1") {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"ok": false, "error": "export-seed 已默认禁用（审计收口）：设 MYCO_SERVE_ALLOW_SEED_EXPORT=1 显式启用，用完即关"})),
        );
    }
    reply(run_sync(move || cli::cmd_identity(&parsed(HashMap::new(), vec!["export-seed".into()]))).await)
}

#[derive(Deserialize)]
struct SignReq {
    payload: String,
    #[serde(rename = "as")]
    as_mode: Option<String>,
}

async fn sign(State(_s): State<Shared>, Json(req): Json<SignReq>) -> (StatusCode, Json<serde_json::Value>) {
    let mut flags = HashMap::new();
    if let Some(a) = req.as_mode {
        flags.insert("as".into(), a);
    }
    reply(run_sync(move || cli::cmd_sign(&parsed(flags, vec![req.payload]))).await)
}

// ─── device ───

async fn device_list(State(_s): State<Shared>) -> (StatusCode, Json<serde_json::Value>) {
    reply(run_sync(move || cli::cmd_device(&parsed(HashMap::new(), vec!["list".into()]))).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRegisterReq {
    device_did: String,
    name: Option<String>,
    no_delegation: Option<bool>,
}

async fn device_register(State(_s): State<Shared>, Json(req): Json<DeviceRegisterReq>) -> (StatusCode, Json<serde_json::Value>) {
    let mut flags = HashMap::new();
    flags.insert("did".into(), req.device_did);
    if let Some(n) = req.name {
        flags.insert("name".into(), n);
    }
    if req.no_delegation.unwrap_or(false) {
        flags.insert("no-delegation".into(), "true".into());
    }
    reply(run_sync(move || cli::cmd_device(&parsed(flags, vec!["register".into()]))).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceTokenReq {
    device_did: String,
    scopes: Option<String>,
    ttl_secs: Option<u64>,
}

async fn device_token(State(_s): State<Shared>, Json(req): Json<DeviceTokenReq>) -> (StatusCode, Json<serde_json::Value>) {
    let mut flags = HashMap::new();
    flags.insert("did".into(), req.device_did);
    if let Some(s) = req.scopes {
        flags.insert("scopes".into(), s);
    }
    if let Some(t) = req.ttl_secs {
        flags.insert("ttl-secs".into(), t.to_string());
    }
    reply(run_sync(move || cli::cmd_device(&parsed(flags, vec!["token".into()]))).await)
}

#[derive(Deserialize)]
struct VerifyTokenReq {
    token: String,
}

async fn device_verify_token(State(_s): State<Shared>, Json(req): Json<VerifyTokenReq>) -> (StatusCode, Json<serde_json::Value>) {
    reply(run_sync(move || cli::cmd_device(&parsed(HashMap::new(), vec!["verify-token".into(), req.token]))).await)
}

// ─── delegation ───

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DelegationIssueReq {
    device_did: String,
    name: Option<String>,
    scopes: Option<String>,
}

async fn delegation_issue(State(_s): State<Shared>, Json(req): Json<DelegationIssueReq>) -> (StatusCode, Json<serde_json::Value>) {
    let mut flags = HashMap::new();
    flags.insert("did".into(), req.device_did);
    if let Some(n) = req.name {
        flags.insert("name".into(), n);
    }
    if let Some(s) = req.scopes {
        flags.insert("scopes".into(), s);
    }
    reply(run_sync(move || cli::cmd_delegation(&parsed(flags, vec!["issue".into()]))).await)
}

#[derive(Deserialize)]
struct WireReq {
    wire: String,
}

async fn delegation_verify(State(_s): State<Shared>, Json(req): Json<WireReq>) -> (StatusCode, Json<serde_json::Value>) {
    reply(run_sync(move || cli::cmd_delegation(&parsed(HashMap::new(), vec!["verify".into(), req.wire]))).await)
}

async fn delegation_list(State(_s): State<Shared>) -> (StatusCode, Json<serde_json::Value>) {
    reply(run_sync(move || cli::cmd_delegation(&parsed(HashMap::new(), vec!["list".into()]))).await)
}

// ─── attest / status / cli 透传 ───

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttestReq {
    device_did: String,
}

async fn attest(State(_s): State<Shared>, Json(req): Json<AttestReq>) -> (StatusCode, Json<serde_json::Value>) {
    let mut flags = HashMap::new();
    flags.insert("did".into(), req.device_did);
    reply(run_sync(move || cli::cmd_attest(&parsed(flags, vec![]))).await)
}

async fn status(State(_s): State<Shared>) -> (StatusCode, Json<serde_json::Value>) {
    match run_sync(|| cli::cmd_status()).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize)]
struct CliReq {
    cmd: String,
}

/// 一行命令透传（phone EnvServer /api/cli 同款）：POST /cli {"cmd":"identity did"}。
/// 解析规则与 CLI argv 相同（空白切词，支持单/双引号短语）。
async fn cli_passthrough(State(_s): State<Shared>, Json(req): Json<CliReq>) -> (StatusCode, Json<serde_json::Value>) {
    let r = run_sync(move || dispatch_cli(&req.cmd)).await;
    reply(r)
}

/// **CLI 统一分发核**（2026-10-14 抽公共；3102 管理面 /api/cli 与本服务 /cli 共用）：
/// 一行命令 → shlex → 子命令校验 → 分发。补齐 friend/chat（原 match 缺这两组，
/// is_cli_command 认它们而 match 落 `unreachable!()` 会 panic——真机踩坑前修掉）。
/// 同步阻塞（内部可能跑网络）——异步上下文里请用 spawn_blocking 包。
pub fn dispatch_cli(cmd: &str) -> Result<serde_json::Value, String> {
    let argv = shlex(cmd);
    if argv.is_empty() {
        return Err("cmd 为空".into());
    }
    let sub = argv[0].clone();
    if !cli::is_cli_command(&sub) {
        return Err(format!("未知子命令 {sub:?}"));
    }
    match cli::parse_args(&argv[1..]) {
        Ok(p) => match sub.as_str() {
            "identity" => cli::cmd_identity(&p),
            "sign" => cli::cmd_sign(&p),
            "device" => cli::cmd_device(&p),
            "delegation" => cli::cmd_delegation(&p),
            "attest" => cli::cmd_attest(&p),
            "status" => cli::cmd_status(),
            // share 段也是 HTTP 语法糖：透传时取 JSON（人话格式只属 argv 面）
            "share" => cli::cmd_share(&p).map(|r| r.json),
            "session" => cli::cmd_session(&p).map(|r| r.json),
            "friend" => cli::cmd_friend(&p),
            "chat" => cli::cmd_chat(&p),
            "serve" => Err("serve 不支持嵌套（long-running）".into()),
            _ => Err(format!("子命令 {sub:?} 已在白名单但无分发（dispatch_cli 需补）")),
        },
        Err(e) => Err(e),
    }
}

/// 极简 shlex：空白切词 + 单/双引号短语（phone cli.ts lex 的 Rust 侧同款）。
fn shlex(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in s.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => cur.push(c),
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            None => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

// ─── 启动 ───

pub fn run(port: u16) -> ! {
    let mut app = Router::new()
        .route("/healthz", get(healthz))
        .route("/identity/birth", post(identity_birth))
        .route("/identity/did", get(identity_did))
        .route("/identity/accounts", get(identity_accounts))
        .route("/identity/export-seed", post(identity_export_seed))
        .route("/sign", post(sign))
        .route("/device/list", get(device_list))
        .route("/device/register", post(device_register))
        .route("/device/token", post(device_token))
        .route("/device/verify-token", post(device_verify_token))
        .route("/delegation/issue", post(delegation_issue))
        .route("/delegation/verify", post(delegation_verify))
        .route("/delegation/list", get(delegation_list))
        .route("/attest", post(attest))
        .route("/status", get(status))
        .route("/cli", post(cli_passthrough))
        .with_state(Arc::new(Svc));

    // HBL 发题智能体（HBL_INGEST_ENABLED=true 才挂载——既有部署零影响；
    // 订单台账落 config_dir()/hbl-ingest/，轮询独立 OS 线程）
    // 2026-11-03 开源：feature gate——无 hbl feature 时编译不包含
    #[cfg(feature = "hbl")]
    if let Some(cfg) = crate::hbl_ingest::IngestConfig::from_env() {
        let book = Arc::new(crate::hbl_ingest::OrderBook::load(
            myco_core::config::config_dir().join("hbl-ingest"),
        ));
        let ist = Arc::new(crate::hbl_ingest::IngestState { cfg: cfg.clone(), book });
        println!(
            "[hbl-ingest] 已启用（HBL 发题智能体）shadow={} client_app={} task={} sign_check={}",
            cfg.shadow, cfg.client_app_url, cfg.task_id, cfg.sign_check
        );
        crate::hbl_ingest::spawn_poller(ist.clone());
        app = app.merge(crate::hbl_ingest::router(ist));
    }

    // DSH 分享网关（headless 与 GUI 同一套 handler）：
    //   · 管理面 /api/dshShare/*（本进程内）
    //   · 公网网关 /gw/<shareId>/（端口 DSH_SHARE_GW_PORT 覆盖，便于隔离测试）
    app = app.merge(crate::dsh_share::local_router());

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    rt.block_on(async move {
        // 公网分享网关（/gw/<shareId>/）同进程拉起：headless 才能端到端验证分享链路
        // （端口 DSH_SHARE_GW_PORT 覆盖；被占只告警不崩）
        tokio::spawn(crate::dsh_share::start_public_gateway());

        // ── 2026-11-04 无头 vnet 节点三件套 ──────────────────────────────────
        // 用户需求：Linux 服务器/无桌面环境跑 myco 当 vnet 节点（被其他设备连接）。
        // 与 GUI 启动链（lib.rs）同源，只是跳过 Tauri/WebView 窗口创建。
        //
        // cfg(feature="gui") 门：p2p_server/p2p_client/presence 模块当前引用
        // tauri::（Emitter/async_runtime，共 ~18 处）→ 只在 gui feature 构建下可用。
        // Windows 默认构建 = 有 gui → `myco cli serve` 即无头 vnet 节点（无窗口）。
        // 纯无 GUI Linux 构建（--no-default-features）暂不含 vnet——待 tauri 解耦后放开。
        #[cfg(feature = "gui")]
        {
            // ① P2P 服务器（:9100 双栈）——其他设备直连入口（隧道协议/闸门原样）
            tokio::spawn(crate::p2p_server::start_p2p_server_for_test());
            // ② Presence 心跳（20s 一次，向 identity-svc 注册本机地址/p2pPort）——
            //   其他设备"看到我在线"的前提
            crate::presence::start();
            // ③ 同步环 = 反向拨号 + 云端中继 Provider 注册 + presence 拉取——
            //   直连全不通时，对端经 myco.youling.cc:8322 中继腿到达本机
            //   （幂等：GUI 已跑时再调不会双注册）
            crate::p2p_client::start_sync_loop();
            println!("[headless-vnet] P2P :9100 + presence + relay provider 已启动（无 UI vnet 节点模式）");
        }
        // ── 无头三件套结束 ────────────────────────────────────────────────────

        // 2026-10-03 审计收口：改绑 127.0.0.1——原 0.0.0.0 让全部端点（/sign 签名
        // oracle、/identity/export-seed 种子导出、/device/token、/cli）暴露给同 docker
        // 网段任意容器（横向调用面）。本进程的正当消费者=同容器内的发题智能体
        // （127.0.0.1 调用不受影响）；显式要对外服务时设 MYCO_SERVE_BIND=0.0.0.0。
        let bind_host =
            std::env::var("MYCO_SERVE_BIND").unwrap_or_else(|_| "127.0.0.1".to_string());
        let listener = tokio::net::TcpListener::bind((bind_host.as_str(), port))
            .await
            .unwrap_or_else(|e| panic!("listen {bind_host}:{port} 失败: {e}"));
        println!("myco cli serve 已监听 {bind_host}:{port}（GET /healthz 探活；POST /cli 透传任意命令；默认回环=审计收口）");
        axum::serve(listener, app).await.expect("axum serve");
    });
    std::process::exit(0)
}

#[cfg(test)]
mod tests {
    #[test]
    fn shlex_quotes() {
        let v = super::shlex("identity did --name \"n 1\" 'x y'");
        assert_eq!(v, vec!["identity", "did", "--name", "n 1", "x y"]);
    }
}
