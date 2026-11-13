//! http.rs — myco-aop-core.exe 的 HTTP 面(:8102)。
//!
//! 路由形状与 env :3002 内嵌时代**逐字节一致**(B3 过渡:env 转发/前端零改动;
//! B4 前端直连)。handlers 从 apps/env/src-tauri/src/http_server.rs 平移,
//! State 从 HttpServerState 收窄为 AopSessionManager 本体。
//!
//! 比 env 时代多出的三条**内部算子路由**(env 进程内直调变 HTTP):
//!   POST /api/labs/create        AopSessionConfig → SessionInfo(action.rs 建会话)
//!   POST /api/labs/destroy_task  {taskId} → bool(project.rs 重启/切 harness)
//!   GET  /api/labs/events_snapshot 一次性快照(remote client 拉首帧用,不开 SSE)

use std::convert::Infallible;
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::session::{AopSessionConfig, HumanSubmission};
use crate::AopSessionManager;

#[derive(Debug, serde::Serialize)]
pub struct ApiResponse<T: serde::Serialize> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}

impl<T: serde::Serialize> ApiResponse<T> {
    fn success(data: T) -> Self {
        Self { success: true, data: Some(data), error: None }
    }
}

impl ApiResponse<()> {
    fn error(e: String) -> ApiResponse<()> {
        ApiResponse { success: false, data: None, error: Some(e) }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AopMessageRequest {
    session_id: String,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AopStopRequest {
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AopHumanSubmitRequest {
    pub session_id: String,
    pub slug: String,
    pub note: String,
    #[serde(default)]
    pub artifacts: Vec<String>,
}

pub fn router(mgr: AopSessionManager) -> Router {
    let state = Arc::new(mgr);
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/api/labs/message", post(handle_aop_message))
        .route("/api/labs/stop", post(handle_aop_stop))
        .route("/api/labs/list", get(handle_aop_list))
        .route("/api/labs/history/:id", get(handle_aop_history))
        .route("/api/labs/events", get(handle_aop_events))
        .route("/api/labs/events_snapshot", get(handle_aop_events_snapshot))
        .route("/api/labs/pause", post(handle_aop_pause))
        .route("/api/labs/resume", post(handle_aop_resume))
        .route("/api/labs/frames/:id", get(handle_aop_frames))
        .route("/api/labs/human_submit", post(handle_aop_human_submit))
        .route("/api/labs/dataset_toggle", post(handle_dataset_toggle))
        .route("/api/labs/create", post(handle_aop_create))
        .route("/api/labs/destroy_task", post(handle_aop_destroy_task))
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(state)
}

async fn handle_aop_message(
    State(aop): State<Arc<AopSessionManager>>,
    Json(payload): Json<AopMessageRequest>,
) -> (StatusCode, Json<ApiResponse<()>>) {
    match aop.send_message(&payload.session_id, &payload.text).await {
        Ok(_) => (StatusCode::OK, Json(ApiResponse::success(()))),
        Err(e) => {
            tracing::warn!("[aop] send_message 失败: {e}");
            (StatusCode::NOT_FOUND, Json(ApiResponse::error(e)))
        }
    }
}

async fn handle_aop_stop(
    State(aop): State<Arc<AopSessionManager>>,
    Json(payload): Json<AopStopRequest>,
) -> (StatusCode, Json<ApiResponse<()>>) {
    match aop.stop(&payload.session_id).await {
        Ok(_) => (StatusCode::OK, Json(ApiResponse::success(()))),
        Err(e) => (StatusCode::NOT_FOUND, Json(ApiResponse::error(e))),
    }
}

async fn handle_aop_list(
    State(aop): State<Arc<AopSessionManager>>,
) -> Json<ApiResponse<Vec<myco_terminal_proto::SessionInfo>>> {
    Json(ApiResponse::success(aop.list().await))
}

/// 会话历史(聊天气泡 lazy 分页;形状对齐 ta 的 /history 响应)。
async fn handle_aop_history(
    State(aop): State<Arc<AopSessionManager>>,
    Path(id): Path<String>,
) -> Json<ApiResponse<serde_json::Value>> {
    let messages = aop.messages_of(&id).await;
    let total = messages.len();
    Json(ApiResponse::success(serde_json::json!({
        "lines": [],
        "messages": messages,
        "totalLines": total,
        "from": 0,
        "count": total,
    })))
}

/// AOP 会话事件流:首帧 = 所有会话的 snapshot 数组(逐条可 apply 进 belief-store),
/// 之后 = 流式事件(形状兼容 ta 的 ObservationEvent)。
async fn handle_aop_events(
    State(aop): State<Arc<AopSessionManager>>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let snap_json = aop.snapshot_events_json().await;
    let rx = aop.subscribe();

    let stream = futures_util::stream::unfold((rx, true), move |(mut rx, first)| {
        let snap = snap_json.clone();
        async move {
            if first {
                return Some((Ok(Event::default().data(snap)), (rx, false)));
            }
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        let data = ev.to_json().to_string();
                        return Some((Ok(Event::default().data(data)), (rx, false)));
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                }
            }
        }
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// 一次性快照(remote client 首帧;不开 SSE 长连)。
async fn handle_aop_events_snapshot(
    State(aop): State<Arc<AopSessionManager>>,
) -> Json<ApiResponse<serde_json::Value>> {
    let s = aop.snapshot_events_json().await;
    Json(ApiResponse::success(serde_json::json!({ "snapshotJson": s })))
}

/// 「等等」:挂起(期限暂停,超时自动续跑)。
async fn handle_aop_pause(
    State(aop): State<Arc<AopSessionManager>>,
    Json(payload): Json<AopStopRequest>,
) -> (StatusCode, Json<ApiResponse<()>>) {
    match aop.pause(&payload.session_id).await {
        Ok(_) => (StatusCode::OK, Json(ApiResponse::success(()))),
        Err(e) => (StatusCode::NOT_FOUND, Json(ApiResponse::error(e))),
    }
}

/// 「继续」:立即续跑。
async fn handle_aop_resume(
    State(aop): State<Arc<AopSessionManager>>,
    Json(payload): Json<AopStopRequest>,
) -> (StatusCode, Json<ApiResponse<()>>) {
    match aop.resume(&payload.session_id).await {
        Ok(_) => (StatusCode::OK, Json(ApiResponse::success(()))),
        Err(e) => (StatusCode::NOT_FOUND, Json(ApiResponse::error(e))),
    }
}

/// 过程帧回放(断线重连/打开过程视图时补齐历史帧)。
async fn handle_aop_frames(
    State(aop): State<Arc<AopSessionManager>>,
    Path(id): Path<String>,
) -> Json<ApiResponse<Vec<crate::AopFrame>>> {
    Json(ApiResponse::success(aop.frames_of(&id).await))
}

/// 人工交付(人类执行者的 A 界面 → 独立 R 评审闭环)。
async fn handle_aop_human_submit(
    State(aop): State<Arc<AopSessionManager>>,
    Json(payload): Json<AopHumanSubmitRequest>,
) -> (StatusCode, Json<ApiResponse<()>>) {
    let sub = HumanSubmission {
        slug: payload.slug,
        note: payload.note,
        artifacts: payload.artifacts,
    };
    match aop.human_submit(&payload.session_id, sub).await {
        Ok(_) => (StatusCode::OK, Json(ApiResponse::success(()))),
        Err(e) => (StatusCode::NOT_FOUND, Json(ApiResponse::error(e))),
    }
}

/// 数据集记录开关(session 级;/dataset 命令的 HTTP 面)。
async fn handle_dataset_toggle(
    State(aop): State<Arc<AopSessionManager>>,
    Json(payload): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let sid = payload.get("sessionId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let on = payload.get("on").and_then(|v| v.as_bool()).unwrap_or(false);
    match aop.dataset_toggle(&sid, on).await {
        Ok(info) => Json(serde_json::json!({"success": true, "data": info, "error": null})),
        Err(e) => Json(serde_json::json!({"success": false, "error": e})),
    }
}

/// 内部算子:建 AOP 会话(env action.rs 的 harness=="aop" 分支平移)。
async fn handle_aop_create(
    State(aop): State<Arc<AopSessionManager>>,
    Json(cfg): Json<AopSessionConfig>,
) -> (StatusCode, Json<ApiResponse<myco_terminal_proto::SessionInfo>>) {
    match aop.create(cfg).await {
        Ok(info) => (StatusCode::OK, Json(ApiResponse::success(info))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse { success: false, data: None, error: Some(e) }),
        ),
    }
}

/// 内部算子:按 taskId 销毁会话(project.rs 重启/切 harness 链路平移)。
async fn handle_aop_destroy_task(
    State(aop): State<Arc<AopSessionManager>>,
    Json(payload): Json<serde_json::Value>,
) -> Json<ApiResponse<bool>> {
    let task_id = payload.get("taskId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    Json(ApiResponse::success(aop.destroy_task(&task_id).await))
}
