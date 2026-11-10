//! # dev_cleanup — 开发/清理型 HTTP 面（`MYCO_DEV_API=1` 门禁）
//!
//! 背景（2026-10-23，用户要求清理测试会话/测试任务卡）：
//! * chat 会话：Tauri 已有 `chat_delete_conv/chat_delete_msg`，但**没有 HTTP 面**，清理 agent 用不了；
//! * 任务卡：`peer-tasks.json`（账号桶）**没有任何删除入口**，只能硬改文件（且运行中会回写）。
//!
//! 本模块只暴露"清理/只读"能力，**不新增业务语义**：
//!
//! | 路由 | 作用 |
//! |---|---|
//! | `GET /api/dev/peerTasks` | 列出本地任务卡（taskId/cardId/shareId/status/title），给清理 agent 定位 |
//! | `POST /api/dev/deletePeerTask {taskId?/cardId?/shareId?}` | 从 peer-tasks.json 删除匹配卡片（原子写） |
//! | `POST /api/dev/deleteConv {convId}` | 复用 `chat_service::chat_delete_conv`（删会话 + 相关文件） |
//! | `POST /api/dev/deleteMsg {convId, msgId}` | 复用 `chat_service::chat_delete_msg` |
//!
//! **纪律**：全部 dev 门禁；删除前调用方自备备份；接口返回删除计数与剩余数，便于核对。

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

fn dev_on() -> bool {
    std::env::var("MYCO_DEV_API")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn dev_off() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "ok": false, "error": "dev api disabled (set MYCO_DEV_API=1)" })),
    )
        .into_response()
}

fn tasks_path() -> std::path::PathBuf {
    crate::msg_store::legacy_chat_dir().join("peer-tasks.json")
}

fn read_tasks() -> Vec<serde_json::Value> {
    std::fs::read_to_string(tasks_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(&s).ok())
        .unwrap_or_default()
}

/// 原子写（tmp + rename）：避免半截文件让 UI 读崩。
fn write_tasks(arr: &[serde_json::Value]) -> Result<(), String> {
    let path = tasks_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(arr).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

fn card_keys(rec: &serde_json::Value) -> Vec<String> {
    ["taskId", "cardId", "shareId", "id"]
        .iter()
        .filter_map(|k| rec.get(*k).and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect()
}

fn card_summary(rec: &serde_json::Value) -> serde_json::Value {
    let pick = |k: &str| rec.get(k).cloned().unwrap_or(serde_json::Value::Null);
    json!({
        "taskId": pick("taskId"),
        "cardId": pick("cardId"),
        "shareId": pick("shareId"),
        "status": pick("status"),
        "title": rec.get("title").cloned()
            .or_else(|| rec.pointer("/card/title").cloned())
            .or_else(|| rec.get("name").cloned())
            .unwrap_or(serde_json::Value::Null),
        "from": pick("from"),
        "sourceDevice": pick("sourceDevice"),
    })
}

/// `GET /api/dev/peerTasks` —— 列出本地任务卡（清理 agent 定位用）。
pub async fn handle_dev_peer_tasks() -> Response {
    if !dev_on() {
        return dev_off();
    }
    let arr = read_tasks();
    let cards: Vec<serde_json::Value> = arr.iter().map(card_summary).collect();
    (
        StatusCode::OK,
        Json(json!({ "ok": true, "count": cards.len(), "path": tasks_path().to_string_lossy(), "cards": cards })),
    )
        .into_response()
}

/// `POST /api/dev/deletePeerTask` —— 按 taskId/cardId/shareId 删除本地任务卡（可一次传多个 id）。
pub async fn handle_dev_delete_peer_task(Json(body): Json<serde_json::Value>) -> Response {
    if !dev_on() {
        return dev_off();
    }
    let mut wanted: Vec<String> = Vec::new();
    for key in ["taskId", "cardId", "shareId"] {
        if let Some(s) = body.get(key).and_then(|v| v.as_str()) {
            if !s.trim().is_empty() {
                wanted.push(s.trim().to_string());
            }
        }
    }
    if let Some(arr) = body.get("ids").and_then(|v| v.as_array()) {
        for v in arr {
            if let Some(s) = v.as_str() {
                if !s.trim().is_empty() {
                    wanted.push(s.trim().to_string());
                }
            }
        }
    }
    wanted.sort();
    wanted.dedup();
    if wanted.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "缺 taskId/cardId/shareId 或 ids[]" })),
        )
            .into_response();
    }
    let before = read_tasks();
    let n_before = before.len();
    let mut removed = 0usize;
    let kept: Vec<serde_json::Value> = before
        .into_iter()
        .filter(|rec| {
            let hit = card_keys(rec).iter().any(|k| wanted.contains(k));
            if hit {
                removed += 1;
            }
            !hit
        })
        .collect();
    if removed == 0 {
        return (
            StatusCode::OK,
            Json(json!({ "ok": true, "removed": 0, "kept": n_before, "wanted": wanted })),
        )
            .into_response();
    }
    match write_tasks(&kept) {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "removed": removed, "kept": kept.len(), "wanted": wanted })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": format!("写 peer-tasks 失败: {e}") })),
        )
            .into_response(),
    }
}

/// `POST /api/dev/deleteConv {convId}` —— 复用聊天层删除会话实现。
#[cfg(feature = "gui")]
pub async fn handle_dev_delete_conv(Json(body): Json<serde_json::Value>) -> Response {
    if !dev_on() {
        return dev_off();
    }
    let conv = body.get("convId").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if conv.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "缺 convId" })),
        )
            .into_response();
    }
    match crate::chat_service::chat_delete_conv(conv.clone()).await {
        Ok(v) => (StatusCode::OK, Json(json!({ "ok": true, "convId": conv, "result": v }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "convId": conv, "error": e })),
        )
            .into_response(),
    }
}

/// `POST /api/dev/deleteMsg {convId, msgId}` —— 复用聊天层删除单条消息。
#[cfg(feature = "gui")]
pub async fn handle_dev_delete_msg(Json(body): Json<serde_json::Value>) -> Response {
    if !dev_on() {
        return dev_off();
    }
    let conv = body.get("convId").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let msg = body.get("msgId").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if conv.is_empty() || msg.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "缺 convId 或 msgId" })),
        )
            .into_response();
    }
    match crate::chat_service::chat_delete_msg(conv.clone(), msg.clone()).await {
        Ok(v) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "convId": conv, "msgId": msg, "result": v })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_summary_picks_common_fields_without_panicking() {
        let rec = json!({"taskId":"tid-1","cardId":"cid-1","status":"todo","title":"t","from":"x","extra":1});
        let s = card_summary(&rec);
        assert_eq!(s["taskId"], "tid-1");
        assert_eq!(s["cardId"], "cid-1");
        assert_eq!(s["status"], "todo");
        // 缺字段必须是 null，不是 panic
        let bare = json!({"taskId":"only"});
        let s2 = card_summary(&bare);
        assert!(s2["shareId"].is_null());
        assert!(s2["title"].is_null());
    }

    #[test]
    fn card_keys_covers_legacy_id_forms() {
        let rec = json!({"taskId":"a","shareId":"b","id":"c"});
        let keys = card_keys(&rec);
        assert!(keys.contains(&"a".to_string()));
        assert!(keys.contains(&"b".to_string()));
        assert!(keys.contains(&"c".to_string()));
    }
}


// ── CLI 变体桩（2026-10-25）：会话/消息删除依赖 chat_service（随 GUI 编译）──
#[cfg(not(feature = "gui"))]
pub async fn handle_dev_delete_conv(Json(_body): Json<serde_json::Value>) -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({ "ok": false, "error": "deleteConv 仅 GUI 构建可用（chat_service 随 GUI 变体编译）" })),
    )
        .into_response()
}

#[cfg(not(feature = "gui"))]
pub async fn handle_dev_delete_msg(Json(_body): Json<serde_json::Value>) -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({ "ok": false, "error": "deleteMsg 仅 GUI 构建可用（chat_service 随 GUI 变体编译）" })),
    )
        .into_response()
}
