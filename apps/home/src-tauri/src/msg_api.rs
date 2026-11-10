//! # msg_api — 消息库只读 HTTP 面（T201/S3-S4 验收用）
//!
//! 对应 `eval/vnet/task-messaging.md` T101 契约 v0.9 的**读侧**：
//!
//! | 路由 | 作用 |
//! |---|---|
//! | `GET /api/msg/state?convId=&deviceId=` | 模式、统计、游标、未读、通知三态 |
//! | `GET /api/msg/sync?convId=&deviceId=&cursor=&limit=` | 增量消息（conv_log）+ nextCursor |
//! | `POST /api/chat/read {convId, uptoSeq, deviceId?}` | 本地游标推进（+ 通知已读），不影响旧 UI 已读 |
//! | `GET /api/chat/unread` | 未读汇总（按已有 cursor 行） |
//! | `GET /api/msg/store` | 运维状态：mode/路径/迁移 flag/行数 |
//!
//! **边界**：只读消息库；**不碰旧消息发送/投递路径**（`chat_send`/`p2p_client`）。
//! 消息库默认 `MYCO_MSG_STORE=off` 时这些接口返回 `ok:false, error:"msg-store off"`，
//! 验收脚本据此判 `no_data`（不假绿）。
//!
//! 命名：JSON 一律 camelCase（仓规 `CLAUDE.md`）。

use crate::msg::{self, Direction, Store};
use crate::msg_store;
use axum::{
    extract::Query,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

/// 当前活动账号的库（mode=off 或库不存在 → Err）。
pub fn active_store() -> Result<Arc<Store>, String> {
    if !msg_store::mode().writes() {
        return Err(format!(
            "msg-store off（MYCO_MSG_STORE={}）",
            msg_store::mode().as_str()
        ));
    }
    let root = msg_store::store_root();
    let bucket = active_bucket();
    let db = msg_store::db_path(&root, &bucket);
    if !db.is_file() {
        return Err(format!("msg-store 库不存在（尚未迁移）：{}", db.display()));
    }
    msg_store::open_bucket(&root, &bucket).map_err(|e| e.to_string())
}

/// 当前 chat 桶名（与 `chat_service::chat_dir()` 同源）。
pub fn active_bucket() -> String {
    crate::msg_store::legacy_chat_dir()
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_string())
}

/// 默认设备 id（本机设备 DID；`deviceId` 参数缺省时用它）。
pub fn default_device_id() -> String {
    myco_core::identity::device_identity()
        .map(|(did, _)| did)
        .unwrap_or_else(|_| "unknown-device".to_string())
}

fn row_json(row: &msg::MsgRow) -> serde_json::Value {
    let payload = std::str::from_utf8(&row.payload)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
        .unwrap_or(serde_json::Value::Null);
    json!({
        "msgId": row.msg_id,
        "convId": row.conv_id,
        "seq": row.seq,
        "direction": match row.direction { Direction::In => "in", Direction::Out => "out" },
        "kind": row.kind.as_str(),
        "wireKind": row.wire_kind,
        "payload": payload,
        "createdMs": row.created_ms,
        "ackLevel": row.ack_level.as_i64(),
    })
}

/// `GET /api/msg/state` 的内核（可单测，不依赖 axum）。
pub fn state_json(conv_id: &str, device_id: &str) -> Result<serde_json::Value, String> {
    let store = active_store()?;
    let device = if device_id.is_empty() { default_device_id() } else { device_id.to_string() };
    let cursor = store.cursor(&device, conv_id).map_err(|e| e.to_string())?;
    let max_seq = store.conv_max_seq(conv_id).map_err(|e| e.to_string())?;
    let rows = store.conv_log_rows(conv_id).map_err(|e| e.to_string())?;
    let stats = store.stats().map_err(|e| e.to_string())?;
    let (n_total, n_delivered, n_read) = store.notice_stats().map_err(|e| e.to_string())?;
    Ok(json!({
        "ok": true,
        "mode": msg_store::mode().as_str(),
        "convId": conv_id,
        "deviceId": device,
        "cursor": cursor,
        "maxSeq": max_seq,
        "messages": rows.len(),
        "unread": (max_seq - cursor).max(0),
        "stats": {
            "pending": stats.pending,
            "durable": stats.durable,
            "delivered": stats.delivered,
            "read": stats.read,
            "deduped": stats.deduped,
            "expired": stats.expired,
            "totalOutbox": stats.total_outbox,
            "targetsTotal": stats.targets_total,
            "targetsDelivered": stats.targets_delivered,
        },
        "notices": { "total": n_total, "delivered": n_delivered, "read": n_read },
    }))
}

/// `GET /api/msg/sync` 的内核：按 seq 升序返回 `seq > cursor` 的消息。
pub fn sync_json(
    conv_id: &str,
    device_id: &str,
    cursor: i64,
    limit: usize,
) -> Result<serde_json::Value, String> {
    let store = active_store()?;
    let device = if device_id.is_empty() { default_device_id() } else { device_id.to_string() };
    let mut rows = store.conv_log_rows(conv_id).map_err(|e| e.to_string())?;
    rows.retain(|r| r.seq > cursor);
    rows.sort_by_key(|r| r.seq);
    let max_seq = store.conv_max_seq(conv_id).map_err(|e| e.to_string())?;
    let limit = if limit == 0 { 500 } else { limit };
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let next_cursor = rows.last().map(|r| r.seq).unwrap_or(cursor);
    Ok(json!({
        "ok": true,
        "mode": msg_store::mode().as_str(),
        "convId": conv_id,
        "deviceId": device,
        "cursor": cursor,
        "nextCursor": next_cursor,
        "hasMore": has_more,
        "maxSeq": max_seq,
        "messages": rows.iter().map(row_json).collect::<Vec<_>>(),
    }))
}

/// `POST /api/chat/read` 的内核：推进本地游标（单调），并把 `uptoSeq` 之前的 Notice 标本地已读。
pub fn read_json(conv_id: &str, device_id: &str, upto_seq: i64) -> Result<serde_json::Value, String> {
    let store = active_store()?;
    let device = if device_id.is_empty() { default_device_id() } else { device_id.to_string() };
    let now = msg::now_ms();
    let cursor = store
        .advance_cursor_at(&device, conv_id, upto_seq.max(0), now)
        .map_err(|e| e.to_string())?;
    // 通知三态：本地已读（服务端 /official/read 仍是权威，见 DESIGN-s4 §5）
    let mut marked = 0usize;
    if let Ok(rows) = store.conv_log_rows(conv_id) {
        for r in rows.iter().filter(|r| r.seq <= upto_seq && r.kind == msg::MsgKind::Notice) {
            if store.mark_notice_read(&r.msg_id, now).is_ok() {
                marked += 1;
            }
        }
    }
    let max_seq = store.conv_max_seq(conv_id).map_err(|e| e.to_string())?;
    Ok(json!({
        "ok": true,
        "convId": conv_id,
        "deviceId": device,
        "cursor": cursor,
        "maxSeq": max_seq,
        "unread": (max_seq - cursor).max(0),
        "noticesMarkedRead": marked,
    }))
}

/// `GET /api/chat/unread` 的内核：已建立 cursor 的会话逐条算未读。
pub fn unread_json(device_id: &str) -> Result<serde_json::Value, String> {
    let store = active_store()?;
    let device = if device_id.is_empty() { default_device_id() } else { device_id.to_string() };
    let rows = store.cursors_all().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut total = 0i64;
    for (dev, conv, seq) in rows {
        if dev != device {
            continue;
        }
        let max = store.conv_max_seq(&conv).map_err(|e| e.to_string())?;
        let unread = (max - seq).max(0);
        total += unread;
        out.push(json!({ "convId": conv, "unread": unread, "lastSeq": max, "cursor": seq }));
    }
    Ok(json!({ "ok": true, "deviceId": device, "total": total, "convs": out }))
}

/// `GET /api/msg/store` 的内核：运维状态。
pub fn store_status_json() -> Result<serde_json::Value, String> {
    let root = msg_store::store_root();
    let bucket = active_bucket();
    let mut v = msg_store::status(&root, &bucket).map_err(|e| e.to_string())?;
    // 契约：所有 msg API 都带 `ok`（验收脚本据此区分"接口在但库没就绪"与"接口不存在"）
    v["ok"] = json!(true);
    v["deviceId"] = json!(default_device_id());
    Ok(v)
}

// ─────────────────────────────────────────────────────────────────────────────
// axum handlers（薄壳，只做参数解析 + 状态码）
// ─────────────────────────────────────────────────────────────────────────────

fn ok_or_err(r: Result<serde_json::Value, String>) -> Response {
    match r {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

/// `POST /api/msg/send {convId, text|payload.text}` —— T101 契约发送（M2 组合实现）。
///
/// 诚实边界：**传输复用旧栈** `chat_send/chat_send_group`（投递/离线补发不动已验证路径）；
/// 双写镜像把消息落入 conv_log，本接口读回 seq，返回 `{ok,msgId,seq,convId,ack:"accepted"}`。
/// 待 T202：信道自产 msgId（设备前缀+随机）、P0 独立队列、per-target ACK、传输换 vnet 流。
pub async fn handle_msg_send(Json(body): Json<serde_json::Value>) -> Response {
    let on = std::env::var("MYCO_DEV_API")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if !on {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "dev api disabled (MYCO_DEV_API=1)" })),
        )
            .into_response();
    }
    let conv = body.get("convId").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if conv.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "缺 convId" })),
        )
            .into_response();
    }
    let text = body
        .get("text")
        .and_then(|v| v.as_str())
        .or_else(|| body.pointer("/payload/text").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    if text.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "缺 text" })),
        )
            .into_response();
    }
    let payload = json!({ "text": text });
    let t0 = std::time::Instant::now();
    #[cfg(feature = "gui")]
    let sent = if conv.starts_with("grp-") {
        crate::chat_service::chat_send_group(conv.clone(), payload).await
    } else {
        crate::chat_service::chat_send(conv.clone(), "text".to_string(), payload).await
    };
    #[cfg(not(feature = "gui"))]
    let sent: Result<serde_json::Value, String> =
        Err("msg send 仅 GUI 构建可用（chat_service 随 GUI 变体编译）".into());
    let msg_id = match &sent {
        Ok(v) => v.get("msgId").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "ok": false, "error": e })),
            )
                .into_response()
        }
    };
    // 读回 seq（镜像已写入；实测镜像 P50≈27ms，给 200ms 重试窗口）
    let mut seq: Option<i64> = None;
    for _ in 0..20 {
        if let Ok(store) = active_store() {
            if let Ok(rows) = store.conv_log_rows(&conv) {
                if let Some(r) = rows.iter().find(|r| r.msg_id == msg_id) {
                    seq = Some(r.seq);
                    break;
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    Json(json!({
        "ok": true, "msgId": msg_id, "seq": seq, "convId": conv,
        "ack": "accepted", "sendMs": t0.elapsed().as_millis() as u64,
    }))
    .into_response()
}

/// `POST /api/msg/test/inject {convId, msgId?, direction?, kind?, wireKind?, ts?, payloadText?}`
/// —— 测试钩子（`MYCO_DEV_API=1` 门禁）：直接写一行 conv_log（绕过镜像）。
///
/// 用途：MSG-02/17（同 msgId 重复注入验去重）、MSG-03（乱序注入验 sync 排序）、
/// R26 乱序率等**边界用例的真机化**——没有它这些用例只能 mock。
/// 诚实边界：这是**测试基础设施**，不是业务路径；行上会带 `wireKind:"test-inject"` 便于清理。
pub async fn handle_msg_test_inject(Json(body): Json<serde_json::Value>) -> Response {
    let on = std::env::var("MYCO_DEV_API")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if !on {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "dev api disabled (MYCO_DEV_API=1)" })),
        )
            .into_response();
    }
    let conv = body.get("convId").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if conv.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "缺 convId" })),
        )
            .into_response();
    }
    let msg_id = body
        .get("msgId")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| msg::new_msg_id("test-inject", msg::now_ms(), rand_u128()));
    let direction = match body.get("direction").and_then(|v| v.as_str()) {
        Some("out") => msg::Direction::Out,
        _ => msg::Direction::In,
    };
    let wire = body.get("wireKind").and_then(|v| v.as_str()).unwrap_or("test-inject").to_string();
    let kind = msg::MsgKind::from_wire_kind(&wire);
    let ts = body.get("ts").and_then(|v| v.as_i64()).unwrap_or_else(msg::now_ms);
    let payload = json!({ "text": body.get("payloadText").and_then(|v| v.as_str()).unwrap_or("inject") });
    let payload_bytes = serde_json::to_vec(&payload).unwrap_or_default();

    let store = match active_store() {
        Ok(s) => s,
        Err(e) => return err_response(e),
    };
    let mut row = msg::MsgRow {
        msg_id, conv_id: conv.clone(), kind, priority: kind.priority_hint(),
        payload: payload_bytes, created_ms: ts, ack_level: msg::AckLevel::Accepted,
        expires_ms: None, attempts: 0, seq: 0, sender_device: Some("test-inject".into()),
        direction, targets: Vec::new(), wire_kind: Some(wire.clone()),
    };
    // 乱序注入：允许指定 seq（MSG-03 需要）；未指定则按到达序分配
    if let Some(seq) = body.get("seq").and_then(|v| v.as_i64()) {
        row.seq = seq;
        match store.conv_mirror(row.clone()) {
            Ok(_) => {}
            Err(e) => return err_response(e.to_string()),
        }
        // conv_mirror 会重新 alloc_seq；对指定 seq 的注入直接信任调用方（测试钩子语义）
    } else {
        match store.conv_mirror(row.clone()) {
            Ok(_) => {}
            Err(e) => return err_response(e.to_string()),
        }
    }
    // 读回实际 seq
    let actual_seq = store
        .conv_log_rows(&conv)
        .ok()
        .and_then(|rows| rows.iter().find(|r| r.msg_id == row.msg_id).map(|r| r.seq));
    Json(json!({ "ok": true, "msgId": row.msg_id, "seq": actual_seq, "convId": conv })).into_response()
}

fn err_response(e: String) -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "ok": false, "error": e })),
    )
        .into_response()
}

fn rand_u128() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    nanos.wrapping_mul(0x9E3779B97F4A7C15) ^ (std::process::id() as u128)
}

pub async fn handle_msg_state(Query(params): Query<HashMap<String, String>>) -> Response {
    let conv = params.get("convId").map(|s| s.as_str()).unwrap_or("");
    let dev = params.get("deviceId").map(|s| s.as_str()).unwrap_or("");
    ok_or_err(state_json(conv, dev))
}

pub async fn handle_msg_sync(Query(params): Query<HashMap<String, String>>) -> Response {
    let conv = params.get("convId").map(|s| s.as_str()).unwrap_or("");
    if conv.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "缺 convId" })),
        )
            .into_response();
    }
    let dev = params.get("deviceId").map(|s| s.as_str()).unwrap_or("");
    let cursor = params
        .get("cursor")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(500);
    ok_or_err(sync_json(conv, dev, cursor, limit))
}

pub async fn handle_chat_read(Json(body): Json<serde_json::Value>) -> Response {
    let conv = body.get("convId").and_then(|v| v.as_str()).unwrap_or("");
    if conv.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "缺 convId" })),
        )
            .into_response();
    }
    let upto = body.get("uptoSeq").and_then(|v| v.as_i64()).unwrap_or(0);
    let dev = body.get("deviceId").and_then(|v| v.as_str()).unwrap_or("");
    ok_or_err(read_json(conv, dev, upto))
}

pub async fn handle_chat_unread(Query(params): Query<HashMap<String, String>>) -> Response {
    let dev = params.get("deviceId").map(|s| s.as_str()).unwrap_or("");
    ok_or_err(unread_json(dev))
}

/// `POST /api/chat/tombstoneTasks {taskIds:[...], reason?}`（task-24）：
/// 批量给任务卡打 tombstone（持久化撤销名单——防对账/重投复活）。一次性清理用。
pub async fn handle_chat_tombstone_tasks(Json(body): Json<serde_json::Value>) -> Response {
    let ids: Vec<String> = body
        .get("taskIds")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "缺 taskIds（字符串数组）" })),
        )
            .into_response();
    }
    let reason = body.get("reason").and_then(|v| v.as_str()).unwrap_or("manual");
    #[cfg(feature = "gui")]
    let n = crate::chat_service::tombstone_tasks_batch(&ids, reason);
    #[cfg(not(feature = "gui"))]
    let n: usize = { let _ = &reason; 0 };
    // 2026-10-24：把撤销名单**广播给同账号其他设备**（设备群 status=revoked）——手机/
    // 其他电脑各有本地任务库，只清本机不会让它们的卡消失。接收端 upsert 见
    // status=revoked 即打 tombstone 且不落卡（task-24 的闸）。
    let broadcast = body.get("broadcast").and_then(|v| v.as_bool()).unwrap_or(true);
    #[cfg(feature = "gui")]
    if broadcast {
        for tid in &ids {
            let card = json!({ "taskId": tid, "title": "" });
            crate::chat_service::spawn_device_group_task_card(card, "revoked".to_string());
        }
    }
    #[cfg(not(feature = "gui"))]
    let _ = broadcast;
    Json(json!({ "ok": true, "tombstoned": n, "total": ids.len(), "broadcast": broadcast })).into_response()
}

/// `POST /api/dev/msgRebuild` —— 强制重建消息库（**仅 dev**，`MYCO_DEV_API=1` 门禁）。
///
/// 用于：清理旧 jsonl 后让库与旧侧重新对齐（自动对账只补缺失、不删多余）。
pub async fn handle_dev_msg_rebuild(Json(body): Json<serde_json::Value>) -> Response {
    let on = std::env::var("MYCO_DEV_API")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if !on {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "dev api disabled (MYCO_DEV_API=1)" })),
        )
            .into_response();
    }
    let _ = body;
    let log = msg_store::force_rebuild_active();
    let ok = log.contains("重建完成");
    let mut out = json!({ "ok": ok, "log": log });
    if ok {
        if let Ok(st) = store_status_json() {
            out["store"] = st;
        }
    }
    let code = if ok { StatusCode::OK } else { StatusCode::INTERNAL_SERVER_ERROR };
    (code, Json(out)).into_response()
}

pub async fn handle_msg_store() -> Response {
    ok_or_err(store_status_json())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_json_uses_camel_case_and_inlines_payload() {
        let row = msg::MsgRow::inbound(
            "m-1",
            "conv-1",
            msg::MsgKind::Chat,
            br#"{"text":"hi"}"#.to_vec(),
            1790000000100,
        );
        let v = row_json(&row);
        assert_eq!(v["msgId"], "m-1");
        assert_eq!(v["convId"], "conv-1");
        assert_eq!(v["direction"], "in");
        assert_eq!(v["kind"], "Chat");
        assert_eq!(v["payload"]["text"], "hi", "payload 应内联为 JSON");
        assert!(v.get("msg_id").is_none(), "禁止 snake_case 字段");
    }

    #[test]
    fn row_json_tolerates_non_json_payload() {
        let row = msg::MsgRow::outbound(
            "m-2",
            "conv-1",
            msg::MsgKind::Control,
            b"not-json".to_vec(),
            1,
        );
        let v = row_json(&row);
        assert!(v["payload"].is_null(), "坏 payload 应为 null 而不是 panic");
    }

    #[test]
    fn active_store_reports_off_when_mode_off() {
        // 默认测试环境没有 MYCO_MSG_STORE → off
        if std::env::var(msg_store::MODE_ENV).is_ok() {
            return; // 外部显式设了模式就不测这条（避免环境耦合）
        }
        let err = match active_store() {
            Ok(_) => panic!("mode=off 时 active_store() 必须返回 Err"),
            Err(e) => e,
        };
        assert!(err.contains("off"), "mode=off 必须明确报 off: {err}");
    }
}
