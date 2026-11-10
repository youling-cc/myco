//! youling_tasks.rs — 第88轮：youling 领取任务同步显示 + 我的能力值。
//!
//! 架构（观察面协议化）：myco 不存任务状态——每次拉 youling ENV 感知面 API 渲染，
//! 数据唯一真相在 youling，myco 只做渲染器；做题仍在 youling 网页，本模块
//! 给任务 Tab 提供「我领取的任务」卡 + 「我的能力值」简历视图的数据源。
//!
//! 端点（client_app = 有灵联盟任务服务，FastAPI :9000，openapi 2026-09-28 实查）：
//! - `GET /env/worker/{did}/tasks`  worker 三态任务感知面（practice/exam/production
//!   按模式聚合的领取入口视图，只读投影）
//! - `GET /env/agents/{did}/resume` 工人画像简历（ResumeBuilder 聚合 worker_task_records，
//!   Beta(α,β) 各技能画像/总题数/准确率；persona 信封解包后的协议形态）
//!
//! 鉴权（三层渐进全带；2026-09-28 公网 curl 矩阵实测定论——**两道闸当前都无登录器
//! 可用凭证，任务面恒 403/401 是服务端未收口，非本模块头格式/签名/did 注册问题**）：
//! 1. `X-API-Key`——client_app worker baseline 第一道闸（InternalTokenMiddleware 对
//!    /env/worker/* 只认此头；值经 `YOULING_API_KEY` 环境变量注入，与 hbl_ingest 同
//!    语义）。实测：缺头=403 `forbidden: missing api key`（内测现状），带头=过闸。
//! 2. `X-Did-Auth`——组织署名 `{did} {ts} {sig_b64}`（签 `{did}\n{ts}\n{body}`，GET
//!    body=空串；与 client_app did_auth_message 同构造）。实测：**该头在 /env/worker/*
//!    中间件与路由均无人读取**（只有 hbl 发卡示例端点读，且公钥源是 guild_org 组织
//!    名册，个人 did:myco 不在其内）——带上无害、服务端收口后零改动，但当前不救命。
//! 3. 裸 GET——`/env/agents/*` GET 已公开读（resume 实测裸 GET 200）；`/env/worker/*`
//!    即使过了 X-API-Key 闸，路由内还有 `_worker_view_identity` 身份闸：X-Ticket 平台
//!    会话票（实测 qr/autologin 票被平台 verify-ticket 40310 拒）/ X-Admin-API-Key /
//!    dev ?did= 三选一，登录器一个都给不出 → 401 `worker 面查询需身份`。
//! 结论：待服务端放行（公开读同 /env/agents，或中间件收口 X-Did-Auth）后本模块
//! 零改动即通；nginx /myco-env 不剥自定义头（X-Ticket/X-API-Key 实测均可达 app）。
//!
//! 第91轮（2026-09-28 晚复核）：`/env/worker/{did}/tasks` 裸 GET 已放行（公网实测
//! 200，47 条全题池投影）。本模块保持**纯传输层**（透明透传 JSON + {ok,status,data}
//! 信封），结构解析在 UI 侧宽容做多键名适配（与手机端 youling-tasks.ts 同构），原因：
//! 服务端字段未定稿（name/abilities 由服务端 agent 同步补齐中），双语言重复解析只会
//! 放大漂移。UI 侧消费契约（apps/home/ui/src/App.tsx parseYoulingTasks）：
//! - 响应 `{topic,did,tasks:[{task_id,task_type_id,modes:{practice|exam|production:
//!   {available,pool_size,my_answered,open_items,my_assigned,my_claim,claim,entry}}}],mode_matrix,notes}`
//! - **只渲染已领取**（产品定稿）：`my_claim != null || my_assigned > 0 || my_answered > 0`
//!   的 mode 才进"我的任务"，其余（46 条未领取）不进列表；空列表 → 空态+去探索引导
//! - 标题：`name`（服务端补）→ 回退 `task_id`；统计：待做=my_assigned、今日已答=my_answered
//! - resume：`resume.abilities[{role,mean,alpha,beta,ci95}]` → 能力值卡（当前/目标
//!   门槛/95%CI；α+β<5 → 样本不足）；门槛=已领取任务的 task_threshold/profile_filter
//!   兜底 resume 全局门槛（路径多键名宽容解析，缺失优雅降级）
//!
//! 降级约定：任何失败不抛错打断 UI——返回 `{ok:false,status,message}` 结构，
//! 前端按「暂无 youling 任务 / 能力值需要绑定」渲染。
//!
//! 缓存：30s 内存缓存（任务列表轮询 30s 周期同频；resume 每次打开视图拉新）。

use base64::Engine as _;
use serde_json::{json, Value};

/// ENV client_app 基址（将来换域名只改这里/设环境变量）。
fn env_base() -> String {
    std::env::var("YOULING_ENV_BASE")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "https://myco.youling.cc/myco-env".into())
        .trim_end_matches('/')
        .to_string()
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

/// `X-Did-Auth: {did} {ts} {sig_b64}`——签名内容 `{did}\n{ts}\n{raw_body}`
/// （GET 时 raw_body 为空串；与 hbl_ingest::did_auth_message 同构造）。
fn did_auth_header(did: &str, seed: &[u8; 32], raw_body: &str) -> String {
    use ed25519_dalek::Signer as _;
    let ts = now_ms().to_string();
    let msg = format!("{did}\n{ts}\n{raw_body}");
    let signing = ed25519_dalek::SigningKey::from_bytes(seed);
    let sig = b64e(&signing.sign(msg.as_bytes()).to_bytes());
    format!("{did} {ts} {sig}")
}

/// 带三层渐进鉴权的 GET。成功 → 透传服务端 JSON；失败 → `{ok:false,...}`。
async fn authed_get(path: &str) -> Result<Value, String> {
    // 登录闸（未登录有灵账号即拒，不用变量值——签名 did 由 org_signer 自带）
    myco_core::identity::account_did()
        .ok_or_else(|| "未登录有灵账号".to_string())?;
    let url = format!("{}{}", env_base(), path);
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = http.get(&url);
    // 1) X-API-Key（配置了才带——值由任务方下发，环境变量注入）
    if let Ok(k) = std::env::var("YOULING_API_KEY") {
        if !k.trim().is_empty() {
            req = req.header("X-API-Key", k.trim());
        }
    }
    // 2) X-Did-Auth 组织署名（GET 无 body，raw_body=空串）
    // 2026-11-03 开源：hbl feature gate
    #[cfg(feature = "hbl")]
    if let Ok((sig_did, seed)) = crate::hbl_ingest::org_signer() {
        req = req.header("X-Did-Auth", did_auth_header(&sig_did, &seed, ""));
    }
    // 3) 都没配置/服务端开放 → 即裸 GET
    let resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(format!("status={status} body={}", &text.chars().take(160).collect::<String>()));
    }
    serde_json::from_str(&text).map_err(|e| format!("响应非 JSON: {e}"))
}

/// 统一出参：`{ok:true,status,data}` / `{ok:false,status,message}`。
async fn fetch_env(path: &str) -> Value {
    match authed_get(path).await {
        Ok(v) => json!({ "ok": true, "status": 200, "data": v }),
        Err(e) => {
            let status = e.split_whitespace().find(|s| s.starts_with("status="))
                .and_then(|s| s[7..].parse::<u16>().ok()).unwrap_or(0);
            eprintln!("[youling_tasks] {path} 失败: {e}");
            json!({ "ok": false, "status": status, "message": e })
        }
    }
}

// ── 30s 内存缓存（任务列表；轮询同频，防 Tab 切换/重渲染打爆服务端） ──

struct Cache {
    at: std::time::Instant,
    val: Value,
}

static TASKS_CACHE: std::sync::Mutex<Option<Cache>> = std::sync::Mutex::new(None);

/// youling 平台我领取的任务（观察面只读投影）。
/// `GET /env/worker/{account_did}/tasks`，30s 缓存。
/// （CLI 变体无 tauri crate——command 门控沿用 lib.rs 全仓模式）
#[cfg(feature = "gui")]
#[tauri::command]
pub async fn youling_tasks_list() -> Result<Value, String> {
    if let Some(c) = TASKS_CACHE.lock().unwrap().as_ref() {
        if c.at.elapsed().as_secs() < 30 {
            return Ok(c.val.clone());
        }
    }
    let did = myco_core::identity::account_did()
        .ok_or_else(|| "未登录有灵账号".to_string())?;
    let path = format!("/env/worker/{}/tasks", urlencode(&did));
    let val = fetch_env(&path).await;
    *TASKS_CACHE.lock().unwrap() = Some(Cache {
        at: std::time::Instant::now(),
        val: val.clone(),
    });
    Ok(val)
}

/// 我的能力值简历（Beta(α,β) 技能画像/总题数/准确率）。
/// `GET /env/agents/{account_did}/resume`，无缓存（打开视图才拉，量小要新鲜）。
#[cfg(feature = "gui")]
#[tauri::command]
pub async fn youling_my_resume() -> Result<Value, String> {
    let did = myco_core::identity::account_did()
        .ok_or_else(|| "未登录有灵账号".to_string())?;
    let path = format!("/env/agents/{}/resume", urlencode(&did));
    Ok(fetch_env(&path).await)
}

/// URL 路径段编码（did 含 `:` 需转义；非字母数字_-.* 一律 %XX）。
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
