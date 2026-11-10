//! hbl_ingest.rs — HBL 发题智能体（原始订单接收端点，镜像双写 SHADOW 默认开）。
//!
//! 使命（2026-09-27 HBL myco 化·最后一跳协议化）：在 hbl-myco（= 本 CLI 套件
//! serve 形态，aop-switch 起 0.3.69 承载）上把 HBL（嗨便利）旧格式发题请求建成
//! **待切换**端点——收旧格式订单 → 翻译成 ENV publish（client_app
//! `POST /env/task/{t}/publish`，组织 did 署名 X-Did-Auth + X-Admin-API-Key）→
//! 后台轮询真值 `GET /env/task/{t}/truth` → 收敛即按 callBackUrl 回调 HBL。
//! **SHADOW=true 镜像模式默认开**：只发新链、回调走影子日志不真调，等 HBL 切换日
//! 翻 `HBL_INGEST_SHADOW=false`。
//!
//! ## 旧接口语义还原（依据：EEVEE k8s hbl-proxy 0.26.1 反编译 + Apollo PRO 配置
//! 实查 2026-09-27，置信度高；与 refactor hibianli.py（Java 镜像实现）逐字段对齐）：
//! - 接收：`POST /api/proxy/hibianli/request?apiName=recog.recog.videoOrder&apiVersion=..`
//!   （Java context-path=/api/proxy + @RequestMapping("/hibianli") + @PostMapping("/request")）。
//!   本模块同挂 `/hibianli/request` 与 `/api/proxy/hibianli/request`——HBL 切换日只改 host。
//! - 鉴权：四 header `hbl-openapi-clientid/-timestamp/-nonce/-signature`，HMAC-SHA256
//!   小写 hex；unign=`clientId=..;nonce=..;timestamp=..;apiName=[..];apiVersion=[..];data=<data_str>`。
//!   老生产 Apollo `hai.sign.check=true`；本端 `HBL_INGEST_SIGN_CHECK`（镜像期 false）。
//! - 请求体 `{"data":"<VideoOrderDTO json>"}`：recogId/callBackUrl/recogLoad/machineCode/
//!   groupKey/doorNum/recogParam/videoList[{duration,videoUrl,videoExpire}]/
//!   skuList[{skuId(Long),skuName,barcode,skuImages}]。
//! - 响应 HBLResponse{code,message,data}：成功 200 data=<orderId>；301/800/801/802/901。
//! - 回调：POST `{callBackUrl}?apiName=recog.recog.videoOrderCallBack&apiVersion=1.0.0`
//!   同 HMAC 四头，body {"data":"<InformVideoOrderResultDto json>"}：recogId/extEventNo/
//!   recogCode/anomalyRecog/recogParam?/recogResult[{skuId,quantity}]；响应 code==200 成功。
//! - 90s SLA：轮询秒级（默认 2s），超时记 slaBreach 告警（降级策略后续补）；
//!   `resultBackTime` 是 Mongo hi.order 回执时间戳字段（非 wire 字段）→ convergedAtMs 对应。
//! - 老生产锚点：client-id `neteaseounRwy53rivt6nHzf7mMGfadX`；hai.url
//!   `https://v2.hibianli.com/recog-delivery-order/netease/callback`；订单侧 callBackUrl
//!   形如 `http://v2.hibianli.com/recog-delivery/netease/callback`；旧任务 id=44235。
//!
//! ## 环境变量（`HBL_INGEST_ENABLED!=true` 时本模块完全不挂载——既有部署零影响）
//!
//! | 变量 | 默认 | 说明 |
//! |---|---|---|
//! | `HBL_INGEST_ENABLED` | 空=关 | `true` 开启接收端点+轮询 |
//! | `HBL_INGEST_SHADOW` | `true` | 镜像模式：回调只记影子日志 |
//! | `HBL_CLIENT_APP_URL` | — | client_app 基址（http://hbl-client-app:9000） |
//! | `HBL_INGEST_TASK_ID` | — | ENV publish 目标 task_id |
//! | `HBL_INGEST_LOCAL_KEY` | — | client_app X-API-Key（/env/task/* worker baseline 第一道闸） |
//! | `HBL_INGEST_ADMIN_KEY` | — | client_app X-Admin-API-Key（发卡授权面第二道闸） |
//! | `HBL_CLIENT_ID`/`HBL_CLIENT_SECRET` | — | HBL HMAC 凭证（验签/回调签名） |
//! | `HBL_INGEST_SIGN_CHECK` | `false` | 收题 HMAC 强验（切换日=true） |
//! | `HBL_CALLBACK_URL` | — | 订单缺 callBackUrl 的回调兜底 |
//! | `HBL_INGEST_POLL_MS` | `2000` | 真值轮询间隔 |
//! | `HBL_INGEST_SLA_MS` | `90000` | SLA 告警阈值 |
//!
//! 台账落盘 `{config_dir}/hbl-ingest/`：orders.json（幂等/状态）+ shadow-callbacks.jsonl。

use axum::body::Bytes;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

type HmacSha256 = Hmac<Sha256>;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn b64e(b: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn b64d(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| format!("base64 解码失败: {e}"))
}

// ─────────────────────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct IngestConfig {
    pub shadow: bool,
    pub client_app_url: String,
    pub task_id: String,
    /// client_app worker baseline 头 X-API-Key（/env/task/* 全量请求第一道闸——
    /// ENV=prod 时 local_api_key 必配；与 client_app .env LOCAL_API_KEY 同值）。
    pub local_key: Option<String>,
    /// client_app 任务方授权头 X-Admin-API-Key（env publish 发卡面第二道闸）。
    pub admin_key: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub sign_check: bool,
    pub callback_base: Option<String>,
    pub poll_ms: u64,
    pub sla_ms: i64,
}

fn env_flag(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(v) => {
            let v = v.trim().to_ascii_lowercase();
            if v.is_empty() { default } else { v == "true" || v == "1" || v == "yes" }
        }
        Err(_) => default,
    }
}

impl IngestConfig {
    /// `HBL_INGEST_ENABLED!=true` → None（模块不挂载，既有部署零影响）。
    pub fn from_env() -> Option<IngestConfig> {
        if !env_flag("HBL_INGEST_ENABLED", false) {
            return None;
        }
        let client_app_url = std::env::var("HBL_CLIENT_APP_URL").ok()?.trim().to_string();
        if client_app_url.is_empty() {
            eprintln!("[hbl-ingest] HBL_INGEST_ENABLED=true 但缺 HBL_CLIENT_APP_URL，不启用");
            return None;
        }
        let task_id = std::env::var("HBL_INGEST_TASK_ID").ok()?.trim().to_string();
        if task_id.is_empty() {
            eprintln!("[hbl-ingest] HBL_INGEST_ENABLED=true 但缺 HBL_INGEST_TASK_ID，不启用");
            return None;
        }
        Some(IngestConfig {
            shadow: env_flag("HBL_INGEST_SHADOW", true),
            client_app_url,
            task_id,
            local_key: std::env::var("HBL_INGEST_LOCAL_KEY").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            admin_key: std::env::var("HBL_INGEST_ADMIN_KEY").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            client_id: std::env::var("HBL_CLIENT_ID").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            client_secret: std::env::var("HBL_CLIENT_SECRET").ok().filter(|s| !s.is_empty()),
            sign_check: env_flag("HBL_INGEST_SIGN_CHECK", false),
            callback_base: std::env::var("HBL_CALLBACK_URL").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            poll_ms: std::env::var("HBL_INGEST_POLL_MS").ok().and_then(|s| s.trim().parse().ok()).unwrap_or(2000).max(200),
            sla_ms: std::env::var("HBL_INGEST_SLA_MS").ok().and_then(|s| s.trim().parse().ok()).unwrap_or(90_000),
        })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 订单台账（幂等 + 状态机；tmp+rename 持久化）
// ─────────────────────────────────────────────────────────────────────────────

/// 状态机：published →(收敛+影子) shadow_done / published →(收敛+真调) done；
/// publish 失败 publish_failed；真调失败 callback_failed（5 次上限）。
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderRecord {
    pub order_id: String,
    /// 幂等键：调用方 orderId > recogId > 首个 videoUrl。
    pub dedup_key: String,
    pub external_order_id: Option<String>,
    pub recog_id: Option<String>,
    pub call_back_url: Option<String>,
    pub task_id: String,
    pub received_at_ms: i64,
    pub status: String,
    pub sku_count: usize,
    pub video_count: usize,
    #[serde(default)]
    pub truth_state: Option<Value>,
    #[serde(default)]
    pub converged_at_ms: Option<i64>,
    #[serde(default)]
    pub callback_attempts: u32,
    #[serde(default)]
    pub sla_breach_logged: bool,
    #[serde(default)]
    pub last_error: Option<String>,
}

pub struct OrderBook {
    dir: PathBuf,
    inner: Mutex<Vec<OrderRecord>>,
}

impl OrderBook {
    pub fn load(dir: PathBuf) -> OrderBook {
        let _ = std::fs::create_dir_all(&dir);
        let list: Vec<OrderRecord> = std::fs::read(dir.join("orders.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        OrderBook { dir, inner: Mutex::new(list) }
    }

    fn persist(&self, list: &[OrderRecord]) {
        // tmp 唯一后缀：并发写者不互踩（rename 覆盖=最后写赢）
        let tmp = self.dir.join(format!("orders.tmp{}.json", tmp_suffix()));
        if let Ok(bytes) = serde_json::to_vec_pretty(list) {
            if std::fs::write(&tmp, &bytes).is_ok() {
                let _ = std::fs::rename(&tmp, self.dir.join("orders.json"));
            }
        }
    }

    pub fn find_by_dedup(&self, key: &str) -> Option<OrderRecord> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).iter().find(|o| o.dedup_key == key).cloned()
    }

    pub fn get(&self, order_id: &str) -> Option<OrderRecord> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).iter().find(|o| o.order_id == order_id).cloned()
    }

    pub fn list(&self) -> Vec<OrderRecord> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn push(&self, rec: OrderRecord) {
        let mut list = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        list.push(rec);
        self.persist(&list);
    }

    pub fn update<F: FnOnce(&mut OrderRecord)>(&self, order_id: &str, f: F) {
        let mut list = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(rec) = list.iter_mut().find(|o| o.order_id == order_id) {
            f(rec);
        }
        self.persist(&list);
    }

    /// 待轮询订单（未收敛或回调未终态）。
    pub fn pending(&self) -> Vec<OrderRecord> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter(|o| o.status == "published" || o.status == "callback_pending")
            .cloned()
            .collect()
    }

    pub fn append_shadow_log(&self, entry: &Value) {
        use std::io::Write as _;
        let line = format!("{}\n", entry);
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("shadow-callbacks.jsonl"))
            .and_then(|mut f| f.write_all(line.as_bytes()));
    }
}

fn tmp_suffix() -> u32 {
    use rand::Rng as _;
    rand::rng().random()
}

// ─────────────────────────────────────────────────────────────────────────────
// 旧格式 DTO（HiOrderInfo / VideoOrderDTO 反编译实证字段）
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoOrderDto {
    /// 旧协议无此字段（orderId 服务端生成）；/hbl/orders 放宽接收做外部幂等键。
    #[serde(default)]
    pub order_id: Option<String>,
    #[serde(default)]
    pub recog_id: Option<String>,
    #[serde(default)]
    pub call_back_url: Option<String>,
    #[serde(default)]
    pub recog_load: Option<String>,
    #[serde(default)]
    pub machine_code: Option<String>,
    #[serde(default)]
    pub group_key: Option<String>,
    #[serde(default)]
    pub door_num: Option<String>,
    #[serde(default)]
    pub recog_param: Option<String>,
    #[serde(default)]
    pub video_list: Vec<HblVideo>,
    #[serde(default)]
    pub sku_list: Vec<HblSku>,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HblVideo {
    pub duration: Option<i64>,
    pub video_url: Option<String>,
    pub video_expire: Option<i64>,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HblSku {
    /// HBL 侧为 Long——宽松接收。
    pub sku_id: Option<Value>,
    pub sku_name: Option<String>,
    pub barcode: Option<String>,
    #[serde(default)]
    pub sku_images: Option<Vec<String>>,
}

fn sku_id_str(v: &Option<Value>) -> String {
    match v {
        None => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(other) => other.to_string(),
    }
}

/// 订单 → ENV publish 的 input_data（与 hibianli._store_video_order 逐字段同构——
/// 工人标注 UI 对新旧链题零区别）。
pub fn translate_input(dto: &VideoOrderDto, order_id: &str) -> Value {
    let videos: Vec<&str> = dto
        .video_list
        .iter()
        .filter_map(|v| v.video_url.as_deref())
        .filter(|u| !u.is_empty())
        .collect();
    let video_expire_ms = dto
        .video_list
        .iter()
        .filter_map(|v| v.video_expire)
        .filter(|e| *e > 0)
        .max()
        .unwrap_or(0);
    let sku_list: Vec<Value> = dto
        .sku_list
        .iter()
        .map(|s| {
            json!({
                "sku_name": s.sku_name,
                "sku_id": sku_id_str(&s.sku_id),
                "sku_images": s.sku_images.clone().unwrap_or_default(),
            })
        })
        .collect();
    json!({
        "order_id": order_id,
        "videos": videos,
        "video_expire_ms": video_expire_ms,
        "sku_list": sku_list,
        "hbl_meta": {
            "recog_id": dto.recog_id,
            "call_back_url": dto.call_back_url,
            "recog_load": dto.recog_load,
            "machine_code": dto.machine_code,
            "group_key": dto.group_key,
            "door_num": dto.door_num,
            "recog_param": dto.recog_param,
        },
    })
}

fn dedup_key_of(dto: &VideoOrderDto) -> String {
    if let Some(o) = dto.order_id.as_deref().filter(|s| !s.is_empty()) {
        return format!("orderId:{}", o);
    }
    if let Some(r) = dto.recog_id.as_deref().filter(|s| !s.is_empty()) {
        return format!("recogId:{}", r);
    }
    if let Some(v) = dto.video_list.iter().find_map(|v| v.video_url.as_deref().filter(|u| !u.is_empty())) {
        return format!("video:{}", v);
    }
    String::new()
}

// ─────────────────────────────────────────────────────────────────────────────
// HMAC-SHA256 签名（镜像 Java HaiClient.getSignature / hibianli.hbl_signature）
// ─────────────────────────────────────────────────────────────────────────────

pub fn hbl_signature(
    client_id: &str,
    client_secret: &str,
    nonce: &str,
    timestamp: &str,
    api_name: &str,
    api_version: &str,
    data_str: &str,
) -> String {
    let unsign = format!(
        "clientId={};nonce={};timestamp={};apiName=[{}];apiVersion=[{}];data={}",
        client_id, nonce, timestamp, api_name, api_version, data_str
    );
    let mut mac = HmacSha256::new_from_slice(client_secret.as_bytes()).expect("HMAC key 任意长度合法");
    mac.update(unsign.as_bytes());
    let out = mac.finalize().into_bytes();
    let mut hex = String::with_capacity(64);
    for b in out {
        hex.push_str(&format!("{:02x}", b));
    }
    hex
}

/// 常时比较（防时序侧信道；hmac.compare_digest 同意图）。
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn gen_uuid4() -> String {
    use rand::RngCore as _;
    let mut b = [0u8; 16];
    rand::rng().fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant
    let h: String = b.iter().map(|x| format!("{:02x}", x)).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

// ─────────────────────────────────────────────────────────────────────────────
// 回调 DTO（镜像 Java HblService.getRecogResult / hibianli.build_callback_dto）
// ─────────────────────────────────────────────────────────────────────────────

/// HBLRecogCodeEnum：(zbCode, recogCode, anomalyRecog, 特殊 skuId)。
/// recogCode：0 识别中 / 1 正常 / 256 视频损坏 / 512 看不清 / 600 无需标注。
/// anomalyRecog（位标记）：0 无 / 1 未上架 / 2 非友好 / 99 无购物。
const RC_COMPLETED: (i64, i64, Option<&str>) = (1, 0, None);
const RC_NOT_UP_SHELF: (i64, i64, Option<&str>) = (1, 1, Some("10"));
const RC_HARD_TO_SEE: (i64, i64, Option<&str>) = (512, 0, None);
const RC_VIDEO_DAMAGE: (i64, i64, Option<&str>) = (256, 0, None);
const RC_OCC_CAMERA: (i64, i64, Option<&str>) = (1, 2, Some("3"));
const RC_NOT_BUY: (i64, i64, Option<&str>) = (1, 99, None);
const RC_PUT_FOREIGN_BODY: (i64, i64, Option<&str>) = (1, 2, Some("4"));
const RC_OTHER: (i64, i64, Option<&str>) = (1, 2, Some("2"));
const RC_NO_LABEL: (i64, i64, Option<&str>) = (600, 0, None);

fn recog_code_of_zb(zb: i64) -> Option<(i64, i64, Option<&'static str>)> {
    let (rc, ar, sku) = match zb {
        -1 => RC_NOT_UP_SHELF,
        1 => RC_HARD_TO_SEE,
        2 => RC_VIDEO_DAMAGE,
        3 => RC_OCC_CAMERA,
        4 => RC_NOT_BUY,
        5 => RC_PUT_FOREIGN_BODY,
        0 => RC_OTHER,
        _ => return None,
    };
    Some((rc, ar, sku))
}

/// JSON/Python repr 字符串 → 对象（镜像 _coerce）。
fn coerce(v: Value) -> Value {
    match v {
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                return Value::Null;
            }
            if t.starts_with('{') || t.starts_with('[') {
                if let Ok(parsed) = serde_json::from_str::<Value>(t) {
                    return parsed;
                }
                let replaced = t.replace('\'', "\"");
                if let Ok(parsed) = serde_json::from_str::<Value>(&replaced) {
                    return parsed;
                }
            }
            if t == "null" {
                return Value::Null;
            }
            Value::String(t.to_string())
        }
        other => other,
    }
}

/// 收敛答案（{sku_list, exception_choose}）→ 嗨便利回调 DTO。
pub fn build_callback_dto(recog_id: Option<&str>, order_id: &str, answer: Value) -> Value {
    let no_label = |recog_id: Option<&str>, order_id: &str| {
        json!({
            "recogId": recog_id,
            "extEventNo": order_id,
            "recogResult": [],
            "anomalyRecog": RC_NO_LABEL.1,
            "recogCode": RC_NO_LABEL.0,
        })
    };
    let mut answer = answer;
    if answer.is_string() {
        answer = coerce(answer);
    }
    let Some(obj) = answer.as_object() else {
        return no_label(recog_id, order_id);
    };
    let sku_list = obj.get("sku_list").map(|v| coerce(v.clone()));
    let exception_choose = obj.get("exception_choose").map(|v| coerce(v.clone()));
    if sku_list.is_none() && exception_choose.is_none() {
        return no_label(recog_id, order_id);
    }
    let mut result = json!({ "recogId": recog_id, "extEventNo": order_id });

    if let Some(exc) = exception_choose.as_ref().and_then(|e| e.as_object()) {
        let has_exc = exc
            .get("has_exception")
            .map(|v| v == &Value::Bool(true) || v.as_i64() == Some(1))
            .unwrap_or(false);
        if has_exc {
            let zb = exc.get("exception").and_then(|v| v.as_i64());
            match zb.and_then(recog_code_of_zb) {
                Some((rc, ar, sku)) => {
                    result["recogCode"] = json!(rc);
                    result["anomalyRecog"] = json!(ar);
                    if let Some(sku_id) = sku {
                        result["recogResult"] = json!([{ "skuId": sku_id, "quantity": 1 }]);
                    } else {
                        result["recogResult"] = json!([]);
                    }
                    return result;
                }
                None => {
                    // 未知异常码：退化已完成无结果（不报畸形数据）
                    result["recogCode"] = json!(RC_COMPLETED.0);
                    result["anomalyRecog"] = json!(RC_COMPLETED.1);
                    result["recogResult"] = json!([]);
                    return result;
                }
            }
        }
    }

    result["recogCode"] = json!(RC_COMPLETED.0);
    result["anomalyRecog"] = json!(RC_COMPLETED.1);
    let mut result_list: Vec<Value> = Vec::new();
    let skus = sku_list.and_then(|s| s.as_array().cloned()).unwrap_or_default();
    if skus.is_empty() {
        result["anomalyRecog"] = json!(RC_NOT_BUY.1); // 无购物 99
    } else {
        let mut anomaly: i64 = RC_COMPLETED.1;
        for sku in &skus {
            let sid = sku.get("sku_id").and_then(|v| v.as_i64());
            let num = sku.get("num").cloned().unwrap_or(json!(1));
            match sid {
                Some(0) => {
                    anomaly |= RC_NOT_UP_SHELF.1;
                    result_list.push(json!({ "skuId": RC_NOT_UP_SHELF.2, "quantity": num }));
                }
                Some(2) => {
                    anomaly |= RC_OTHER.1;
                    result_list.push(json!({ "skuId": RC_OTHER.2, "quantity": 1 }));
                }
                _ => {
                    let sid_str = sku
                        .get("sku_id")
                        .map(|v| match v {
                            Value::String(s) => s.clone(),
                            other => other.to_string(),
                        })
                        .unwrap_or_default();
                    result_list.push(json!({ "skuId": sid_str, "quantity": num }));
                }
            }
        }
        result["anomalyRecog"] = json!(anomaly);
    }
    result["recogResult"] = Value::Array(result_list);
    result
}

// ─────────────────────────────────────────────────────────────────────────────
// 组织署名（X-Did-Auth：与 client_app did_auth_message 同构造）
// ─────────────────────────────────────────────────────────────────────────────

/// 组织签名钥（root 优先，分身设备回退 device——cmd_sign auto 同语义）。
pub fn org_signer() -> Result<(String, [u8; 32]), String> {
    if let (Some(did), Some(seed)) = (myco_core::identity::account_did(), myco_core::identity::cached_account_seed()) {
        return Ok((did, seed));
    }
    let (did, seed_b64) = myco_core::identity::device_identity()?;
    let raw = b64d(&seed_b64)?;
    let seed: [u8; 32] = <[u8; 32]>::try_from(raw.as_slice()).map_err(|_| "设备种子长度异常（≠32B）".to_string())?;
    Ok((did, seed))
}

/// `X-Did-Auth: {did} {ts} {sig_b64}`——签名内容 `{did}\n{ts}\n{raw_body}`。
/// client_app 现不校验此头（发卡走 X-Admin-API-Key），附上=组织署名留痕，
/// 未来收口 did 鉴权零改动。
///
/// ts=Unix **秒**（did 协议正字，26/55 号；client_app DidAuthVerifier 双单位兼容）。
/// 2026-09-30 前曾用毫秒——旧版 0.3.71 容器签名仍为毫秒，验签侧已双收。
fn did_auth_header(did: &str, seed: &[u8; 32], raw_body: &str) -> String {
    use ed25519_dalek::Signer as _;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .to_string();
    let msg = format!("{}\n{}\n{}", did, ts, raw_body);
    let signing = ed25519_dalek::SigningKey::from_bytes(seed);
    let sig = b64e(&signing.sign(msg.as_bytes()).to_bytes());
    format!("{} {} {}", did, ts, sig)
}

// ─────────────────────────────────────────────────────────────────────────────
// ENV 面调用（publish / truth）+ 回调（reqwest blocking；rustls 支持 https）
// ─────────────────────────────────────────────────────────────────────────────

pub struct EnvClient {
    pub cfg: IngestConfig,
    http: reqwest::blocking::Client,
}

impl EnvClient {
    pub fn new(cfg: IngestConfig) -> EnvClient {
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        EnvClient { cfg, http }
    }

    /// `POST /env/task/{t}/publish`（发卡：任务方直建题池）。
    pub fn publish(&self, item_id: &str, input: &Value) -> Result<(), String> {
        let body = json!({ "items": [ { "item_id": item_id, "input": input } ] });
        let raw_body = serde_json::to_string(&body).unwrap_or_default();
        let url = format!("{}/env/task/{}/publish", self.cfg.client_app_url.trim_end_matches('/'), self.cfg.task_id);
        let mut req = self.http.post(&url).header("Content-Type", "application/json");
        if let Some(k) = &self.cfg.local_key {
            req = req.header("X-API-Key", k);
        }
        if let Some(k) = &self.cfg.admin_key {
            req = req.header("X-Admin-API-Key", k);
        }
        if let Ok((did, seed)) = org_signer() {
            req = req.header("X-Did-Auth", did_auth_header(&did, &seed, &raw_body));
        }
        let resp = req.body(raw_body).send().map_err(|e| format!("publish 请求失败: {e}"))?;
        let status = resp.status().as_u16();
        if (200..300).contains(&status) {
            Ok(())
        } else {
            let text = resp.text().unwrap_or_default();
            Err(format!("publish status={} body={}", status, &text.chars().take(300).collect::<String>()))
        }
    }

    /// `GET /env/task/{t}/truth?item_id=` → (item_status, truth.state)。
    pub fn truth(&self, item_id: &str) -> Result<(String, Option<Value>), String> {
        let url = format!(
            "{}/env/task/{}/truth?item_id={}",
            self.cfg.client_app_url.trim_end_matches('/'),
            self.cfg.task_id,
            urlencode(item_id)
        );
        let mut req = self.http.get(&url);
        if let Some(k) = &self.cfg.local_key {
            req = req.header("X-API-Key", k);
        }
        if let Some(k) = &self.cfg.admin_key {
            req = req.header("X-Admin-API-Key", k);
        }
        let resp = req.send().map_err(|e| format!("truth 请求失败: {e}"))?;
        let status = resp.status().as_u16();
        let text = resp.text().unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(format!("truth status={} body={}", status, &text.chars().take(200).collect::<String>()));
        }
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("truth 解析失败: {e}"))?;
        let item = v
            .get("items")
            .and_then(|i| i.as_array())
            .and_then(|a| a.first())
            .cloned()
            .ok_or_else(|| "truth 响应缺 items[0]".to_string())?;
        let st = item.get("item_status").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let state = item.get("truth").and_then(|t| t.get("state")).cloned();
        Ok((st, state))
    }

    /// 结果回调（recog.recog.videoOrderCallBack；同一 HMAC 规则签名）。
    /// Ok(true)=HBL 回执 code==200；Ok(false)=非 200（调用方计数重试）。
    pub fn post_callback(&self, base_url: &str, dto: &Value) -> Result<bool, String> {
        let (client_id, client_secret) = match (&self.cfg.client_id, &self.cfg.client_secret) {
            (Some(id), Some(sec)) => (id.clone(), sec.clone()),
            _ => return Err("缺 HBL_CLIENT_ID/HBL_CLIENT_SECRET（回调签名凭证）".into()),
        };
        let api_name = "recog.recog.videoOrderCallBack";
        let api_version = "1.0.0";
        let nonce = gen_uuid4().replace('-', "");
        let timestamp = now_ms().to_string();
        let data_str = serde_json::to_string(dto).unwrap_or_default();
        let signature = hbl_signature(&client_id, &client_secret, &nonce, &timestamp, api_name, api_version, &data_str);
        let url = format!(
            "{}?apiName={}&apiVersion={}",
            base_url.trim_end_matches('/'),
            api_name,
            api_version
        );
        let body = json!({ "data": data_str });
        let resp = self
            .http
            .post(&url)
            .header("hbl-openapi-clientid", &client_id)
            .header("hbl-openapi-timestamp", &timestamp)
            .header("hbl-openapi-nonce", &nonce)
            .header("hbl-openapi-signature", &signature)
            .json(&body)
            .send()
            .map_err(|e| format!("回调请求失败: {e}"))?;
        if !resp.status().is_success() {
            return Ok(false);
        }
        let code = resp
            .json::<Value>()
            .ok()
            .and_then(|v| v.get("code").and_then(|c| c.as_i64()))
            .unwrap_or(-1);
        Ok(code == 200)
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// 核心 ingest（可测：publish 闭包注入）
// ─────────────────────────────────────────────────────────────────────────────

pub struct IngestOutcome {
    pub order_id: String,
    pub dedup: bool,
    pub published: bool,
    pub error: Option<String>,
}

pub fn ingest_order<P: Fn(&str, &Value) -> Result<(), String>>(
    cfg: &IngestConfig,
    book: &OrderBook,
    dto: &VideoOrderDto,
    publisher: P,
) -> IngestOutcome {
    let key = dedup_key_of(dto);
    if !key.is_empty() {
        if let Some(existing) = book.find_by_dedup(&key) {
            return IngestOutcome { order_id: existing.order_id, dedup: true, published: false, error: None };
        }
    }
    let order_id = gen_uuid4();
    let input = translate_input(dto, &order_id);
    let rec = OrderRecord {
        order_id: order_id.clone(),
        dedup_key: key,
        external_order_id: dto.order_id.clone().filter(|s| !s.is_empty()),
        recog_id: dto.recog_id.clone().filter(|s| !s.is_empty()),
        call_back_url: dto.call_back_url.clone().filter(|s| !s.is_empty()),
        task_id: cfg.task_id.clone(),
        received_at_ms: now_ms(),
        status: "published".into(),
        sku_count: dto.sku_list.len(),
        video_count: dto.video_list.len(),
        truth_state: None,
        converged_at_ms: None,
        callback_attempts: 0,
        sla_breach_logged: false,
        last_error: None,
    };
    match publisher(&order_id, &input) {
        Ok(()) => {
            book.push(rec);
            println!(
                "[hbl-ingest] 接单入库+ENV publish order={} recog={:?} skus={} shadow={}",
                order_id, dto.recog_id, dto.sku_list.len(), cfg.shadow
            );
            IngestOutcome { order_id, dedup: false, published: true, error: None }
        }
        Err(e) => {
            let mut bad = rec;
            bad.status = "publish_failed".into();
            bad.last_error = Some(e.clone());
            book.push(bad);
            eprintln!("[hbl-ingest] ENV publish 失败 order={} recog={:?}: {}", order_id, dto.recog_id, e);
            IngestOutcome { order_id, dedup: false, published: false, error: Some(e) }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// axum 路由
// ─────────────────────────────────────────────────────────────────────────────

pub struct IngestState {
    pub cfg: IngestConfig,
    pub book: Arc<OrderBook>,
}

type SharedIngest = Arc<IngestState>;

fn hbl_response(code: i64, message: &str, data: Value) -> (StatusCode, Json<Value>) {
    (StatusCode::OK, Json(json!({ "code": code, "message": message, "data": data })))
}

/// `POST /hbl/orders` —— 新链规范入口（字段/语义对齐旧接口；body=VideoOrderDTO
/// 直接 JSON 或 {"data": ...} 旧包裹形；可带 orderId 外部幂等键）。
async fn hbl_orders(
    State(st): State<SharedIngest>,
    headers: HeaderMap,
    raw_body: Bytes,
) -> (StatusCode, Json<Value>) {
    if st.cfg.sign_check {
        if let Err((code, msg)) = verify_hmac_headers(&st.cfg, &headers, &raw_body) {
            return hbl_response(code, &msg, Value::Null);
        }
    } else if let Some(tok) = st.cfg.admin_key.as_deref() {
        // 镜像期内网门：带 X-Admin-API-Key 时必须匹配（防误暴露）；不带放行（内网语义）
        if let Some(got) = headers.get("x-admin-api-key").and_then(|v| v.to_str().ok()) {
            if !ct_eq(got, tok) {
                return hbl_response(802, "X-Admin-API-Key mismatch", Value::Null);
            }
        }
    }
    let r = tokio::task::spawn_blocking(move || ingest_blocking(&st, &headers, &raw_body, None))
        .await
        .map_err(|e| format!("命令执行失败: {e}"));
    match r {
        Ok(resp) => resp,
        Err(e) => hbl_response(500, &e, Value::Null),
    }
}

fn ingest_blocking(st: &IngestState, _headers: &HeaderMap, raw_body: &[u8], old_shape: Option<(&str, &str)>) -> (StatusCode, Json<Value>) {
    let body: Value = match serde_json::from_slice(raw_body) {
        Ok(v) => v,
        Err(_) => return hbl_response(901, "数据解析异常", Value::Null),
    };
    let data_val = match body.get("data") {
        Some(v) => v.clone(),
        None if old_shape.is_none() => body, // /hbl/orders 允许裸 DTO
        None => return hbl_response(301, "缺少data参数", Value::Null),
    };
    let dto_value = match &data_val {
        Value::String(s) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
        v @ Value::Object(_) => v.clone(),
        _ => Value::Null,
    };
    let dto: VideoOrderDto = match serde_json::from_value(dto_value) {
        Ok(d) => d,
        Err(_) => return hbl_response(901, "数据解析异常", Value::Null),
    };
    let client = EnvClient::new(st.cfg.clone());
    let outcome = ingest_order(&st.cfg, &st.book, &dto, |item_id, input| client.publish(item_id, input));
    if outcome.dedup {
        let data = if old_shape.is_some() { json!(outcome.order_id) } else { json!({ "orderId": outcome.order_id, "dedup": true }) };
        return hbl_response(200, "success", data);
    }
    if !outcome.published {
        return hbl_response(500, &format!("publish failed: {}", outcome.error.unwrap_or_default()), Value::Null);
    }
    let data = if old_shape.is_some() {
        json!(outcome.order_id)
    } else {
        json!({ "orderId": outcome.order_id, "dedup": false, "shadow": st.cfg.shadow })
    };
    hbl_response(200, "success", data)
}

/// 旧 HMAC 四头验签（Err=(HBL code, message)）。签名覆盖 data 字符串值
/// （不含外层 {"data":...} 括号）——旧契约语义。
fn verify_hmac_headers(cfg: &IngestConfig, headers: &HeaderMap, raw_body: &[u8]) -> Result<(), (i64, String)> {
    let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let signature = get("hbl-openapi-signature").ok_or((801, "签名参数异常".to_string()))?;
    let client_id = get("hbl-openapi-clientid").ok_or((801, "签名参数异常".to_string()))?;
    let nonce = get("hbl-openapi-nonce").unwrap_or_default();
    let timestamp = get("hbl-openapi-timestamp").unwrap_or_default();
    let (cfg_id, secret) = match (&cfg.client_id, &cfg.client_secret) {
        (Some(i), Some(s)) => (i.clone(), s.clone()),
        _ => return Err((801, "服务端未配置 HBL_CLIENT_ID/HBL_CLIENT_SECRET".into())),
    };
    if !cfg_id.is_empty() && client_id != cfg_id {
        return Err((802, "签名clientId非法".to_string()));
    }
    let body: Value = serde_json::from_slice(raw_body).map_err(|_| (901, "数据解析异常".to_string()))?;
    let data_str = match body.get("data") {
        Some(Value::String(s)) => s.clone(),
        Some(v) => serde_json::to_string(v).unwrap_or_default(),
        None => return Err((301, "缺少data参数".to_string())),
    };
    let api_name = get("x-hbl-apiname").unwrap_or_else(|| "recog.recog.videoOrder".into());
    let api_version = get("x-hbl-apiversion").unwrap_or_else(|| "1.0.0".into());
    let expected = hbl_signature(&client_id, &secret, &nonce, &timestamp, &api_name, &api_version, &data_str);
    if !ct_eq(&expected, &signature) {
        return Err((800, "非法签名".to_string()));
    }
    Ok(())
}

#[derive(Deserialize)]
struct OldRequestQuery {
    #[serde(rename = "apiName")]
    api_name: String,
    #[serde(rename = "apiVersion", default)]
    api_version: String,
}

/// `POST /hibianli/request`（旧接口逐语义——HBL 切换日零改动入口；
/// 同 handler 挂 `/api/proxy/hibianli/request` 兼容旧 context-path）。
async fn hibianli_request(
    State(st): State<SharedIngest>,
    Query(q): Query<OldRequestQuery>,
    headers: HeaderMap,
    raw_body: Bytes,
) -> (StatusCode, Json<Value>) {
    const API_VIDEO_ORDER: &str = "recog.recog.videoOrder";
    const API_QUERY_VIDEO_ORDER: &str = "recog.recog.queryVideoOrder";
    const API_PUSH_SKU_RECOG_INFO: &str = "recog.sku.pushSkuRecogInfo";

    // HMAC 验签（镜像期 sign_check=false 不验；切换日=true 对齐老生产 hai.sign.check=true）
    if st.cfg.sign_check {
        let mut enriched = headers.clone();
        if let Ok(v) = axum::http::HeaderValue::from_str(&q.api_name) {
            enriched.insert("x-hbl-apiname", v);
        }
        if let Ok(v) = axum::http::HeaderValue::from_str(&q.api_version) {
            enriched.insert("x-hbl-apiversion", v);
        }
        if let Err((code, msg)) = verify_hmac_headers(&st.cfg, &enriched, &raw_body) {
            return hbl_response(code, &msg, Value::Null);
        }
    }

    if q.api_name == API_VIDEO_ORDER {
        let r = tokio::task::spawn_blocking(move || {
            ingest_blocking(&st, &headers, &raw_body, Some((&q.api_name, &q.api_version)))
        })
        .await
        .map_err(|e| format!("命令执行失败: {e}"));
        return match r {
            Ok(resp) => resp,
            Err(e) => hbl_response(500, &e, Value::Null),
        };
    }
    if q.api_name == API_QUERY_VIDEO_ORDER || q.api_name == API_PUSH_SKU_RECOG_INFO {
        // 对齐 Java 现状：占位不实现
        return hbl_response(200, "success", Value::Null);
    }
    hbl_response(301, "无效的API名称", Value::Null)
}

async fn hbl_orders_list(State(st): State<SharedIngest>) -> Json<Value> {
    let list = st.book.list();
    let pending = list.iter().filter(|o| o.status == "published" || o.status == "callback_pending").count();
    Json(json!({
        "shadow": st.cfg.shadow,
        "taskId": st.cfg.task_id,
        "total": list.len(),
        "pending": pending,
        "orders": list,
    }))
}

async fn hbl_orders_get(
    State(st): State<SharedIngest>,
    AxumPath(order_id): AxumPath<String>,
) -> (StatusCode, Json<Value>) {
    match st.book.get(&order_id) {
        Some(o) => (StatusCode::OK, Json(json!({ "order": o }))),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "订单不存在" }))),
    }
}

/// 路由挂载（仅 HBL_INGEST_ENABLED=true 时由 cli_serve 调用）。
pub fn router(st: SharedIngest) -> Router {
    Router::new()
        .route("/hbl/orders", post(hbl_orders).get(hbl_orders_list))
        .route("/hbl/orders/:id", get(hbl_orders_get))
        // 旧接口两路径（裸 + 旧 context-path）——HBL 切换日只改 host
        .route("/hibianli/request", post(hibianli_request))
        .route("/api/proxy/hibianli/request", post(hibianli_request))
        .with_state(st)
}

// ─────────────────────────────────────────────────────────────────────────────
// 后台轮询（真值回流：SHADOW=影子日志 / LIVE=真回调；独立 OS 线程 blocking reqwest）
// ─────────────────────────────────────────────────────────────────────────────

pub fn spawn_poller(st: Arc<IngestState>) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("hbl-ingest-poller".into())
        .spawn(move || {
            let cfg = st.cfg.clone();
            let client = EnvClient::new(cfg.clone());
            println!("[hbl-ingest] 轮询启动 poll={}ms shadow={} task={}", cfg.poll_ms, cfg.shadow, cfg.task_id);
            loop {
                std::thread::sleep(Duration::from_millis(cfg.poll_ms));
                for order in st.book.pending() {
                    let (status, state) = match client.truth(&order.order_id) {
                        Ok(v) => v,
                        Err(e) => {
                            eprintln!("[hbl-ingest] truth 查询失败 order={}: {}", order.order_id, e);
                            continue;
                        }
                    };
                    if status == "converged" {
                        let answer = state.clone().unwrap_or(Value::Null);
                        let dto = build_callback_dto(order.recog_id.as_deref(), &order.order_id, answer);
                        let callback_url = order.call_back_url.clone().or_else(|| cfg.callback_base.clone());
                        let now = now_ms();
                        if cfg.shadow {
                            st.book.append_shadow_log(&json!({
                                "ts": now,
                                "mode": "shadow",
                                "orderId": order.order_id,
                                "recogId": order.recog_id,
                                "callbackUrl": callback_url,
                                "receivedAtMs": order.received_at_ms,
                                "latencyMs": now - order.received_at_ms,
                                "dto": dto,
                            }));
                            st.book.update(&order.order_id, |r| {
                                r.status = "shadow_done".into();
                                r.truth_state = state;
                                r.converged_at_ms = Some(now);
                            });
                            println!(
                                "[hbl-ingest] [SHADOW] 收敛回调（只记不调）order={} recog={:?} latency={}ms",
                                order.order_id, order.recog_id, now - order.received_at_ms
                            );
                        } else {
                            let Some(url) = callback_url else {
                                st.book.update(&order.order_id, |r| {
                                    r.status = "callback_failed".into();
                                    r.last_error = Some("无 callBackUrl 且未配置 HBL_CALLBACK_URL".into());
                                    r.converged_at_ms = Some(now);
                                });
                                continue;
                            };
                            match client.post_callback(&url, &dto) {
                                Ok(true) => {
                                    st.book.update(&order.order_id, |r| {
                                        r.status = "done".into();
                                        r.truth_state = state;
                                        r.converged_at_ms = Some(now);
                                        r.last_error = None;
                                    });
                                    println!(
                                        "[hbl-ingest] [LIVE] 回调成功 order={} recog={:?} latency={}ms",
                                        order.order_id, order.recog_id, now - order.received_at_ms
                                    );
                                }
                                ok_err => {
                                    let msg = match ok_err {
                                        Ok(false) => "HBL 回执非 200".to_string(),
                                        Ok(true) => unreachable!("Ok(true) 已在上文处理"),
                                        Err(e) => e,
                                    };
                                    let attempts = order.callback_attempts + 1;
                                    let terminal = attempts >= 5;
                                    st.book.update(&order.order_id, |r| {
                                        r.status = if terminal { "callback_failed".into() } else { "callback_pending".into() };
                                        r.callback_attempts = attempts;
                                        r.last_error = Some(msg.clone());
                                        r.converged_at_ms = Some(now);
                                        r.truth_state = state.clone();
                                    });
                                    eprintln!(
                                        "[hbl-ingest] [LIVE] 回调未成（第{}次）order={}: {}",
                                        attempts, order.order_id, msg
                                    );
                                }
                            }
                        }
                    } else if status == "terminated" {
                        let now = now_ms();
                        st.book.update(&order.order_id, |r| {
                            r.status = "terminated".into();
                            r.converged_at_ms = Some(now);
                            r.last_error = Some("ENV 题终态 terminated（超时/终止）".into());
                        });
                        eprintln!(
                            "[hbl-ingest] 题终态 terminated（不再轮询）order={}——切换日前需补降级回调策略",
                            order.order_id
                        );
                    } else {
                        // 未收敛：SLA 监控（只记一次）
                        let now = now_ms();
                        if !order.sla_breach_logged && now - order.received_at_ms > cfg.sla_ms {
                            st.book.update(&order.order_id, |r| {
                                r.sla_breach_logged = true;
                                r.last_error = Some(format!("SLA 超时（>{}ms 未收敛，继续轮询）", cfg.sla_ms));
                            });
                            eprintln!(
                                "[hbl-ingest] SLA 告警 order={} 距收单 {}ms 未收敛（status={}）",
                                order.order_id, now - order.received_at_ms, status
                            );
                        }
                    }
                }
            }
        })
        .expect("spawn hbl-ingest-poller")
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_book(tag: &str) -> OrderBook {
        let dir = std::env::temp_dir().join(format!("myco-home-hbl-ingest-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        OrderBook::load(dir)
    }

    fn test_cfg() -> IngestConfig {
        IngestConfig {
            shadow: true,
            client_app_url: "http://127.0.0.1:19999".into(),
            task_id: "t-hbl-test".into(),
            local_key: Some("lk".into()),
            admin_key: Some("k".into()),
            client_id: Some("cid-test".into()),
            client_secret: Some("sec-test".into()),
            sign_check: false,
            callback_base: Some("http://cb.test/api".into()),
            poll_ms: 200,
            sla_ms: 90_000,
        }
    }

    /// HMAC 向量：与 hibianli.hbl_signature（Java HaiClient.getSignature 镜像）跨语言对拍。
    #[test]
    fn hmac_signature_vector() {
        let data_str = r#"{"recogId": "R1", "skuList": [{"skuId": 42}]}"#;
        let sig = hbl_signature("cid-test", "sec-test", "n-001", "1700000000123", "recog.recog.videoOrder", "1.0.0", data_str);
        assert_eq!(sig, "26e9384bce0181d57f78e522bfd3e18efe96bfb52e8814fd48a884c563fc59e4");
    }

    #[test]
    fn hmac_roundtrip_verify() {
        let data_str = r#"{"recogId":"R2"}"#;
        let sig = hbl_signature("c", "s", "n", "1", "a.b.c", "1.0.0", data_str);
        assert_eq!(sig.len(), 64);
        assert!(ct_eq(&sig, &sig.clone()));
        let mut bad = sig.clone();
        bad.replace_range(0..1, if bad.starts_with('a') { "b" } else { "a" });
        assert!(!ct_eq(&sig, &bad));
    }

    fn dto_from(s: &str) -> VideoOrderDto {
        serde_json::from_str(s).unwrap()
    }

    const SAMPLE_ORDER: &str = r#"{
        "recogId": "REC-1001",
        "callBackUrl": "http://v2.hibianli.com/recog-delivery/netease/callback",
        "recogLoad": "3",
        "machineCode": "M01",
        "groupKey": "G1",
        "doorNum": "2",
        "recogParam": "{\"mode\":1}",
        "videoList": [
            {"duration": 15, "videoUrl": "http://v/1.mp4", "videoExpire": 1700000500},
            {"duration": 10, "videoUrl": "http://v/2.mp4", "videoExpire": 1700000300}
        ],
        "skuList": [
            {"skuId": 42, "skuName": "可乐", "barcode": "6901"},
            {"skuId": "43", "skuName": "雪碧"},
            {"skuId": 0, "skuName": "未知"}
        ]
    }"#;

    #[test]
    fn translate_input_shape() {
        let dto = dto_from(SAMPLE_ORDER);
        let input = translate_input(&dto, "OID-1");
        assert_eq!(input["order_id"], "OID-1");
        assert_eq!(input["videos"], json!(["http://v/1.mp4", "http://v/2.mp4"]));
        assert_eq!(input["video_expire_ms"], 1700000500); // max
        assert_eq!(input["sku_list"][0]["sku_id"], "42"); // Long→str
        assert_eq!(input["sku_list"][1]["sku_id"], "43");
        assert_eq!(input["sku_list"][2]["sku_id"], "0");
        assert_eq!(input["hbl_meta"]["recog_id"], "REC-1001");
        assert_eq!(input["hbl_meta"]["call_back_url"], "http://v2.hibianli.com/recog-delivery/netease/callback");
    }

    #[test]
    fn ingest_dedup_by_recog_id() {
        let book = tmp_book("dedup");
        let cfg = test_cfg();
        let dto = dto_from(SAMPLE_ORDER);
        let o1 = ingest_order(&cfg, &book, &dto, |_, _| Ok(()));
        assert!(o1.published);
        // 同 recogId 再来 → 幂等返回原 orderId，不再 publish
        let o2 = ingest_order(&cfg, &book, &dto, |_, _| panic!("dedup 不应再 publish"));
        assert!(o2.dedup);
        assert_eq!(o1.order_id, o2.order_id);
        assert_eq!(book.list().len(), 1);
        let _ = std::fs::remove_dir_all(&book.dir);
    }

    #[test]
    fn ingest_dedup_by_external_order_id() {
        let book = tmp_book("dedup2");
        let cfg = test_cfg();
        let mut dto = dto_from(SAMPLE_ORDER);
        dto.order_id = Some("EXT-9".into());
        let o1 = ingest_order(&cfg, &book, &dto, |_, _| Ok(()));
        let mut dto2 = dto_from(SAMPLE_ORDER);
        dto2.recog_id = Some("REC-OTHER".into()); // recogId 不同
        dto2.order_id = Some("EXT-9".into()); // 但 orderId 相同
        let o2 = ingest_order(&cfg, &book, &dto2, |_, _| panic!("orderId 幂等应拦截"));
        assert!(o2.dedup);
        assert_eq!(o1.order_id, o2.order_id);
        let _ = std::fs::remove_dir_all(&book.dir);
    }

    #[test]
    fn ingest_publish_failure_recorded() {
        let book = tmp_book("fail");
        let cfg = test_cfg();
        let dto = dto_from(SAMPLE_ORDER);
        let o = ingest_order(&cfg, &book, &dto, |_, _| Err("client_app down".into()));
        assert!(!o.published);
        let rec = book.get(&o.order_id).unwrap();
        assert_eq!(rec.status, "publish_failed");
        assert!(rec.last_error.unwrap().contains("client_app down"));
        let _ = std::fs::remove_dir_all(&book.dir);
    }

    #[test]
    fn callback_dto_normal_skus() {
        let answer = json!({ "sku_list": [ {"sku_id": 42, "num": 2}, {"sku_id": 7, "num": 1} ] });
        let dto = build_callback_dto(Some("REC-1"), "OID-1", answer);
        assert_eq!(dto["recogId"], "REC-1");
        assert_eq!(dto["extEventNo"], "OID-1");
        assert_eq!(dto["recogCode"], 1);
        assert_eq!(dto["anomalyRecog"], 0);
        assert_eq!(dto["recogResult"], json!([{ "skuId": "42", "quantity": 2 }, { "skuId": "7", "quantity": 1 }]));
    }

    #[test]
    fn callback_dto_special_skus() {
        // skuId 0=未上架（anomaly|1 + sku10）；2=其他不友好（anomaly|2 + sku2 quantity 恒 1）
        let answer = json!({ "sku_list": [ {"sku_id": 0, "num": 3}, {"sku_id": 2, "num": 5}, {"sku_id": 88, "num": 1} ] });
        let dto = build_callback_dto(None, "OID", answer);
        assert_eq!(dto["anomalyRecog"], 3); // 1|2
        assert_eq!(dto["recogResult"], json!([
            {"skuId": "10", "quantity": 3},
            {"skuId": "2", "quantity": 1},
            {"skuId": "88", "quantity": 1}
        ]));
    }

    #[test]
    fn callback_dto_empty_sku_no_buy() {
        let answer = json!({ "sku_list": [] });
        let dto = build_callback_dto(Some("R"), "O", answer);
        assert_eq!(dto["recogCode"], 1);
        assert_eq!(dto["anomalyRecog"], 99); // 无购物
        assert_eq!(dto["recogResult"], json!([]));
    }

    #[test]
    fn callback_dto_exception_branches() {
        // 未上架异常（zb=-1 → recogCode 1 anomaly 1 sku10）
        let a1 = json!({"exception_choose": {"has_exception": true, "exception": -1}});
        let d1 = build_callback_dto(Some("R"), "O", a1);
        assert_eq!(d1["recogCode"], 1);
        assert_eq!(d1["anomalyRecog"], 1);
        assert_eq!(d1["recogResult"], json!([{ "skuId": "10", "quantity": 1 }]));
        // 看不清（zb=1 → 512）
        let a2 = json!({"exception_choose": {"has_exception": true, "exception": 1}});
        assert_eq!(build_callback_dto(Some("R"), "O", a2)["recogCode"], 512);
        // 视频损坏（zb=2 → 256）
        let a3 = json!({"exception_choose": {"has_exception": true, "exception": 2}});
        assert_eq!(build_callback_dto(Some("R"), "O", a3)["recogCode"], 256);
        // 未知异常码 → 退化 COMPLETED
        let a4 = json!({"exception_choose": {"has_exception": true, "exception": 99}});
        let d4 = build_callback_dto(Some("R"), "O", a4);
        assert_eq!(d4["recogCode"], 1);
        assert_eq!(d4["recogResult"], json!([]));
        // has_exception=false 走正常分支
        let a5 = json!({"exception_choose": {"has_exception": false, "exception": 2}, "sku_list": [{"sku_id": 9, "num": 1}]});
        let d5 = build_callback_dto(Some("R"), "O", a5);
        assert_eq!(d5["recogCode"], 1);
        assert_eq!(d5["recogResult"][0]["skuId"], "9");
    }

    #[test]
    fn callback_dto_no_label_and_coerce() {
        // 空 answer → NO_LABEL 600
        let d = build_callback_dto(Some("R"), "O", json!({}));
        assert_eq!(d["recogCode"], 600);
        assert_eq!(d["recogResult"], json!([]));
        // 非对象 → NO_LABEL
        let d2 = build_callback_dto(Some("R"), "O", json!("garbage"));
        assert_eq!(d2["recogCode"], 600);
        // JSON 字符串形态 answer（truth.state 可能是字符串）→ coerce 后正常分支
        let s = json!("{\"sku_list\": [{\"sku_id\": 5, \"num\": 2}]}");
        let d3 = build_callback_dto(Some("R"), "O", s);
        assert_eq!(d3["recogCode"], 1);
        assert_eq!(d3["recogResult"][0]["skuId"], "5");
    }

    #[test]
    fn uuid4_shape() {
        let u = gen_uuid4();
        assert_eq!(u.len(), 36);
        assert_eq!(u.as_bytes()[14], b'4'); // version
    }

    #[test]
    fn order_book_persistence_roundtrip() {
        let book = tmp_book("persist");
        book.push(OrderRecord {
            order_id: "O1".into(),
            dedup_key: "recogId:R1".into(),
            external_order_id: None,
            recog_id: Some("R1".into()),
            call_back_url: None,
            task_id: "t".into(),
            received_at_ms: 1,
            status: "published".into(),
            sku_count: 1,
            video_count: 1,
            truth_state: None,
            converged_at_ms: None,
            callback_attempts: 0,
            sla_breach_logged: false,
            last_error: None,
        });
        let reloaded = OrderBook::load(book.dir.clone());
        assert_eq!(reloaded.list().len(), 1);
        assert_eq!(reloaded.list()[0].order_id, "O1");
        let _ = std::fs::remove_dir_all(&book.dir);
    }
}
