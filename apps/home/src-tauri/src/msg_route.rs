//! # msg_route — 跨账号 DSH 会话消息（`kind = dsh-session-msg`）的两端端点
//!
//! 与既有的 `/api/msg/send`（本地消息库写入、参数 convId）**语义无关**：本模块是
//! **跨账号路由面**——把一条「给某个 DSH 会话的话」经 P2P 投到对方账号，由对方的
//! myco 注入它本机的 DSH 会话。
//!
//! | 路由 | 作用 |
//! |---|---|
//! | `POST /api/msg/route` | 发：好友/分享任务 owner 校验 → 组装 wire 信封（kind=`dsh-session-msg`）→ `p2p_send_raw` 投递 |
//! | `GET /api/chat_state` | 读：`chat_service::chat_state()` 的薄包装（好友名册 + 在场灯） |
//!
//! 入站：`chat_service::ingest_msg` 里 `kind == dsh-session-msg` 的早分支 → 本模块
//! `ingest()` → 署名头 + 调本机 DSH `session/prompt`（复用网关既有的
//! `dsh_share::cli_local_session_prompt_mode`：同一套 mint cookie + 0.2 信封 +
//! 就绪窗口重试，**不新起 HTTP 客户端/不绕鉴权**）。
//!
//! ## 契约（2026-11-11 与 DSH 插件方定版）
//!
//! 请求体（camelCase，仓规 `CLAUDE.md`）：
//! ```json
//! {"to":"did:youling:…","sessionId":"session-…","fromName":"发送方会话名",
//!  "fromDid":"did:youling:…","fromSessionId":"session-…",
//!  "kind":"dsh-session-msg","body":"正文","mode":"steer|queue"}
//! ```
//! 成功：`{"ok":true,"delivered":true,"sessionId":"…","via":"p2p-direct"}`。
//!
//! ## 信任边界（**实现要点，别改坏**）
//!
//! · `fromDid` / `fromName` 是**发送方自报**（只用于署名与日志对账）；信封顶层
//!   `from` 由本机账号 DID 权威写入（`p2p_send_raw` 的 `my_account_did()`），
//!   接收端一律以**传输层身份**（`p2p_server::auth_gate` 验过签的信封 `from`，
//!   其签名设备 `fromDevice` 已被归属闸证明属于该账号）为准。
//! · 自报 `fromDid` 与本机账号不一致 → 发送侧直接 403 拒发（留痕）。
//! · payload **只放四件** `{sessionId, fromSessionId, body, mode}`——不放 fromName/
//!   fromDid 当凭据（凭据来自传输层，payload 里放身份就等于让对端用我们的自报做授权）。
//! · 入站若 payload 里带了自称 `fromDid`（老/别家实现），与传输层 `from` 不一致 → 拒投。
//! · 入站只认 **P2P 验签通道**（`P2P_TRANSPORT_MARK`）：信箱 `/msg/poll` 那条路没有
//!   逐条设备签名（`from` 由服务端给），能往信箱塞一个声称是好友的 from 就等于能往
//!   别人的 DSH 会话打指令——所以缺标记一律拒。
//!
//! ## 已知边界（2026-11-11 契约方裁决，本轮不修）
//!
//! · **分享任务 owner 的跨账号投递本轮尚未开放**：`p2p_server::auth_gate` 的好友闸
//!   （`friend_gate_exempt_kind`）只豁免 delegation-notify / friend-*，非好友的分享
//!   任务 owner 会在**对端传输层**被 403，根本到不了本模块的入站闸。路由侧仍按
//!   「好友 or 分享任务 owner」放行（为将来留口），但投递前由 `route_transport_gate`
//!   **如实拒发**并说明原因——不许复用"对方不在线、已入待发队列"那句（排队补发也
//!   到不了）。要开放得专门评审后再加豁免，本轮不动安全闸。
//! · `sessionId` 缺省时的 `candidates` 只在目标是**本机账号**时给本机会话；对端清单
//!   本进程看不到，回空数组（把本机清单冒充对端可选会话会诱导误投）。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Map, Value};

/// wire kind（两端一致；入站分支、信封、测试都认这一个常量）。
pub(crate) const KIND_DSH_SESSION_MSG: &str = "dsh-session-msg";

/// 入站通道标记（**内部键，不上 wire、不落库**）：由 `chat_service::ingest_p2p_inner`
/// 写进适配后的信封——它只在 `p2p_server::auth_gate` 之后被调用。
///
/// 为什么需要：`ingest_msg` 有两个入口——P2P（`ingest_p2p_inner`，设备签名+归属闸
/// 都验过）与信箱 `/msg/poll`（`poll_mailbox`，逐条无设备签名、`from` 由服务端给）。
/// 跨账号 prompt 注入只认前者：否则"能往信箱塞一个声称是好友的 from"就能往别人的
/// DSH 会话里打指令。fail-closed。
pub(crate) const P2P_TRANSPORT_MARK: &str = "p2p-sign";

/// `sessionId` 缺省时给回候选的条数上限（够人选，不把整张清单塞进错误体）。
const SESSION_PICK_MAX: usize = 5;

/// 正文上限（与 `session send --text` 的 8000 字上限同口径，防超长注入）。
const BODY_MAX_CHARS: usize = 8000;

/// 在场查询预算（presence 是网络调用；拿不到就 `online:false`，绝不挡 `chat_state`）。
const PRESENCE_BUDGET_MS: u64 = 3_000;

// ═══════════════════════════════════════════════════════════════════════
// 纯逻辑层（参数闸 / 准入闸 / payload 组装 / 署名头）——单测直击
// ═══════════════════════════════════════════════════════════════════════

/// `POST /api/msg/route` 的解析结果（字段均已 trim）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RouteRequest {
    pub to: String,
    /// **目标**会话 id（对方账号上的会话）。允许空串——由调用方回 `sessionId-required`
    /// （不猜目标会话，见 `route_body_session_required`）。
    pub session_id: String,
    /// 发送方会话名（对方署名头里的名字；空则由账号昵称→`myco` 兜底）。
    pub from_name: String,
    /// 发送方账号 did（**自报**，只做一致性校验与日志）。
    pub from_did: String,
    /// 发送方会话 id（对方用 `reply-to-session:` 回信）。
    pub from_session_id: String,
    pub body: String,
    pub mode: String,
}

/// 参数闸（纯函数）：Err = (HTTP 状态码, 人话)。顺序 = 契约字段顺序，先报最该修的。
pub(crate) fn parse_route_request(v: &Value) -> Result<RouteRequest, (u16, String)> {
    if !v.is_object() {
        return Err((400, "请求体必须是 JSON 对象".into()));
    }
    let s = |k: &str| -> String {
        v.get(k)
            .and_then(|x| x.as_str())
            .map(str::trim)
            .unwrap_or("")
            .to_string()
    };
    let to = s("to");
    if to.is_empty() {
        return Err((400, "缺 to（目标账号 did）".into()));
    }
    // kind：缺省按本端点唯一支持的 kind 处理；给了别的值就明确拒绝（不静默当同义）。
    let kind = s("kind");
    if !kind.is_empty() && kind != KIND_DSH_SESSION_MSG {
        return Err((
            400,
            format!("不支持 kind {kind:?}（本端点只有 {KIND_DSH_SESSION_MSG}）"),
        ));
    }
    let mode = s("mode").to_ascii_lowercase();
    if mode.is_empty() {
        return Err((400, "缺 mode（steer|queue）".into()));
    }
    if mode != "steer" && mode != "queue" {
        return Err((400, format!("mode 只能是 steer 或 queue（给的是 {mode:?}）")));
    }
    let from_did = s("fromDid");
    if from_did.is_empty() {
        return Err((400, "缺 fromDid（发送方账号 did）".into()));
    }
    let body = v
        .get("body")
        .and_then(|x| x.as_str())
        .map(String::from)
        .unwrap_or_default();
    if body.trim().is_empty() {
        return Err((400, "缺 body（消息正文）".into()));
    }
    if body.chars().count() > BODY_MAX_CHARS {
        return Err((
            400,
            format!(
                "body 太长（{} 字 > 上限 {BODY_MAX_CHARS} 字）",
                body.chars().count()
            ),
        ));
    }
    Ok(RouteRequest {
        to,
        session_id: s("sessionId"),
        from_name: s("fromName"),
        from_did,
        from_session_id: s("fromSessionId"),
        body,
        mode,
    })
}

/// 发送侧准入闸（纯函数）：Err = (HTTP 状态码, 人话)。
///
/// · `fromDid` 必须就是**本机账号**（自报与本账号不一致 = 想冒别人名，直接拒）；
/// · `to` 必须是本好友或本机任务库里的分享任务 owner（第二种可通信关系）。
pub(crate) fn route_gate(
    req: &RouteRequest,
    my_did: &str,
    to_is_friend: bool,
    to_is_task_owner: bool,
) -> Result<(), (u16, String)> {
    if !myco_core::identity::account_did_eq(&req.from_did, my_did) {
        return Err((
            403,
            format!(
                "fromDid 与本机账号不一致（自称 {}，本机 {my_did}）——拒绝投递",
                req.from_did
            ),
        ));
    }
    if !(to_is_friend || to_is_task_owner) {
        return Err((
            403,
            format!(
                "目标 {} 不是本好友，也不是分享任务 owner——请先加好友，或让对方把任务卡分享给你",
                req.to
            ),
        ));
    }
    Ok(())
}

/// 传输层好友闸的**诚实预判**（纯函数）：Err = (403, 人话)。
///
/// `p2p_server::auth_gate` 只放行「同账号（自我同步/持委任状）」或「ok 好友」——
/// 非好友的**分享任务 owner** 会在对端被 403，根本到不了 `msg_route::ingest`。
/// 本轮不动那道安全闸（见模块头「已知边界」），但这里必须**如实**拒发：
/// 不能落到"对方不在线、已入待发队列"那句——那句会让人以为排队能补发。
pub(crate) fn route_transport_gate(
    to_is_friend: bool,
    to_is_self: bool,
) -> Result<(), (u16, String)> {
    if to_is_friend || to_is_self {
        return Ok(());
    }
    Err((
        403,
        "目标账号未通过传输层好友校验（分享任务 owner 的跨账号投递本轮尚未开放）".to_string(),
    ))
}

/// `sessionId` 缺省时给不给候选（纯函数）：**只有目标是本机账号才有意义**。
/// 对端机器上的会话清单本进程看不到——把本机清单当成"对端可选会话"会诱导调用方
/// 拿错误 id 重发（2026-11-11 契约方裁决）。
pub(crate) fn session_required_candidates_allowed(to: &str, my_did: &str) -> bool {
    let t = to.trim();
    !t.is_empty() && myco_core::identity::account_did_eq(t, my_did)
}

/// wire payload（纯函数，单测钉死形状）：**只有四件**，身份一律不进 payload。
pub(crate) fn build_payload(
    session_id: &str,
    from_session_id: &str,
    body: &str,
    mode: &str,
) -> Value {
    json!({
        "sessionId": session_id,
        "fromSessionId": from_session_id,
        "body": body,
        "mode": mode,
    })
}

/// `sessionId` 缺省的响应体（**逐字契约**：`error` 就是 `sessionId-required`）。
pub(crate) fn route_body_session_required(candidates: Vec<Value>) -> Value {
    json!({ "ok": false, "error": "sessionId-required", "candidates": candidates })
}

/// 本机会话清单（`dsh_share::cli_local_sessions` 的形状）→ 候选 `[{sessionId,title}]`。
/// 纯函数：清单拉失败/没 `sessions` 键一律空数组（错误体里 candidates 仍存在）。
pub(crate) fn candidates_from_list(list: &Value, max: usize) -> Vec<Value> {
    list.get("sessions")
        .and_then(|s| s.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    let sid = s.get("sessionId").and_then(Value::as_str)?.trim();
                    if sid.is_empty() {
                        return None;
                    }
                    // title 优先（fork 会话标题就是它的名字），退回清单的显示名 name
                    let title = s
                        .get("title")
                        .and_then(Value::as_str)
                        .or_else(|| s.get("name").and_then(Value::as_str))
                        .unwrap_or("")
                        .trim();
                    Some(json!({ "sessionId": sid, "title": title }))
                })
                .take(max)
                .collect()
        })
        .unwrap_or_default()
}

/// 署名里的名字归一：空 → `myco`（与 `cli::format_chat_header` 的兜底同口径；
/// 这里另给一份是因为信封 `fromName` 也要用它——收件方署名头读的是信封字段）。
pub(crate) fn resolved_from_name(from_name: &str) -> String {
    let t = from_name.trim();
    if t.is_empty() {
        "myco".to_string()
    } else {
        t.to_string()
    }
}

/// `session-<id>` 归一（裸 uuid 补前缀；空 = None）。
pub(crate) fn normalize_session_id(sid: &str) -> Option<String> {
    let t = sid.trim();
    if t.is_empty() {
        return None;
    }
    Some(if t.starts_with("session-") {
        t.to_string()
    } else {
        format!("session-{t}")
    })
}

/// 入站正文渲染：**跨账号三行头**（第一行仍由既有 `format_chat_header` 负责）。
///
/// 契约（2026-11-11 与 DSH 插件方定稿，v6 充要版）：
/// ```text
/// [from: <发送方会话名> · [⚡插队 · ]MM-DD HH:MM]      ← format_chat_header(name, None, steer)
/// reply-to: <发送方账号 DID>                          ← 只有 DID 在对端机器上可路由
/// reply-to-session: session-<发送方会话 id>            ← DID 只到"人"，这行才到"会话"
/// <正文>
/// ```
///
/// 为什么第一行要把 sid 传 `None`：`format_chat_header` 在拿到 sid 时会自己输出一行
/// `reply-to: session-…`，而跨账号要的是 `reply-to: <DID>`。若照旧传 sid 再追加，
/// 头部会变成"两行 session id、没有账号 DID"——对端 AI 拿到后**无法路由回信**
/// （本机 session id 在对端不存在）。所以这里只借它的第一行，后两行自拼；
/// 函数体一行不动（`--to`/`--task` 的逐字契约不受影响）。
pub(crate) fn render_inbound_text(
    from_name: &str,
    from_did: &str,
    from_session_id: &str,
    body: &str,
    steer: bool,
    cross_account: bool,
) -> String {
    let mut head = crate::cli::format_chat_header(from_name, None, steer);
    if cross_account {
        // 账号 DID 优先用传输层权威值；空则整行不编（宁缺勿伪造）。
        let did = from_did.trim();
        if !did.is_empty() {
            head.push_str(&format!("reply-to: {did}\n"));
        }
        if let Some(sid) = normalize_session_id(from_session_id) {
            head.push_str(&format!("reply-to-session: {sid}\n"));
        }
    } else if let Some(sid) = normalize_session_id(from_session_id) {
        // 非跨账号（保留给本地路径的等价输出）：沿用既有两行形态。
        head.push_str(&format!("reply-to: {sid}\n"));
    }
    head.push_str(body);
    head
}

/// 入站准入闸（纯函数）：Err = (403, 人话)。**传输层身份为准**，自报只做对账。
pub(crate) fn inbound_gate(
    transport_from: &str,
    claimed_from_did: &str,
    is_self: bool,
    is_friend: bool,
    is_task_owner: bool,
) -> Result<(), (u16, String)> {
    let from = transport_from.trim();
    if from.is_empty() {
        return Err((403, "入站信封缺 from（传输层身份不可判）——拒投".into()));
    }
    let claimed = claimed_from_did.trim();
    if !claimed.is_empty() && !myco_core::identity::account_did_eq(claimed, from) {
        return Err((
            403,
            format!("fromDid 与传输层身份不一致（自称 {claimed}，传输层 {from}）——拒投"),
        ));
    }
    if !(is_self || is_friend || is_task_owner) {
        return Err((
            403,
            format!("来源 {from} 不是好友，也不是分享任务 owner——拒投"),
        ));
    }
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════
// HTTP 面
// ═══════════════════════════════════════════════════════════════════════

fn json_resp(status: StatusCode, v: Value) -> Response {
    (status, Json(v)).into_response()
}

/// `POST /api/msg/route` —— 跨账号投递一条 `dsh-session-msg`。
pub async fn handle_msg_route(Json(body): Json<Value>) -> Response {
    let req = match parse_route_request(&body) {
        Ok(r) => r,
        Err((code, msg)) => {
            eprintln!("[msg-route] 参数拒绝：{msg}");
            return json_resp(
                StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST),
                json!({ "ok": false, "delivered": false, "error": msg }),
            );
        }
    };
    // 本机账号：信封 from 的权威来源（不是 req.from_did）。
    let my = match crate::chat_service::my_account_did() {
        Ok(m) => m,
        Err(e) => {
            return json_resp(
                StatusCode::BAD_REQUEST,
                json!({ "ok": false, "delivered": false, "error": e }),
            )
        }
    };
    let to_is_friend = crate::chat_service::is_ok_friend(&req.to);
    let to_is_task_owner = crate::chat_service::is_shared_task_owner(&req.to);
    if let Err((code, msg)) = route_gate(&req, &my, to_is_friend, to_is_task_owner) {
        eprintln!("[msg-route] 拒发（{code}）：to={} fromDid={} —— {msg}", req.to, req.from_did);
        return json_resp(
            StatusCode::from_u16(code).unwrap_or(StatusCode::FORBIDDEN),
            json!({ "ok": false, "delivered": false, "error": msg }),
        );
    }
    // 传输层好友闸（p2p_server::auth_gate）只放行「同账号」或「ok 好友」——非好友的
    // 分享任务 owner 会在对端被 403，根本到不了 ingest。本轮不动那道安全闸（已知边界，
    // 见文件头），但这里必须**如实**拒发：不能落到"对方不在线、已入待发队列"那句，
    // 那句会让人以为排队能补发，实际永远补不到。
    let to_is_self = myco_core::identity::account_did_eq(&req.to, &my);
    if let Err((code, msg)) = route_transport_gate(to_is_friend, to_is_self) {
        eprintln!(
            "[msg-route] 拒发（{code}）：to={} friend={to_is_friend} self={to_is_self} —— {msg}",
            req.to
        );
        return json_resp(
            StatusCode::from_u16(code).unwrap_or(StatusCode::FORBIDDEN),
            json!({ "ok": false, "delivered": false, "error": msg }),
        );
    }
    // sessionId 缺省 = 拒绝，不猜（不投"最近活跃会话"，也不自动 session/create）。
    if req.session_id.is_empty() {
        // 候选只对**本机账号**有意义：对端机器上的会话清单本进程看不到，回空数组
        // （2026-11-11 契约方裁决：拿本机清单冒充对端可选会话会诱导误投）。
        let candidates = if session_required_candidates_allowed(&req.to, &my) {
            session_pick_candidates().await
        } else {
            Vec::new()
        };
        if candidates.is_empty() {
            eprintln!(
                "[msg-route] 拒发（400）：sessionId-required (remote target; no candidate channel yet) to={}",
                req.to
            );
        } else {
            eprintln!(
                "[msg-route] 拒发（400）：sessionId-required (local target) to={}，候选 {} 条",
                req.to,
                candidates.len()
            );
        }
        return json_resp(StatusCode::BAD_REQUEST, route_body_session_required(candidates));
    }
    let from_name = resolved_from_name(&req.from_name);
    let payload = build_payload(&req.session_id, &req.from_session_id, &req.body, &req.mode);
    // 信封 fromName = 发送方**会话名**（收件方署名头用它）；from/fromDevice 由
    // p2p_send_raw 按本机身份权威写入（自报 did 改不了它）。
    match crate::chat_service::p2p_send_raw_with_name(
        &req.to,
        KIND_DSH_SESSION_MSG,
        payload,
        Some(&from_name),
    )
    .await
    {
        Ok((_, _, state)) if state == "sent" => json_resp(
            StatusCode::OK,
            json!({
                "ok": true,
                "delivered": true,
                "sessionId": req.session_id,
                "via": "p2p-direct",
            }),
        ),
        Ok((_, _, state)) => {
            // "sending"=对方全部设备不可达、已入待发队列（**不是**已送达）；
            // "failed"=队列满/长期不在线。两种都必须如实说没送到。
            let err = if state == "sending" {
                "对方账号当前不在线，消息已入本机待发队列（对方上线后自动补发；本次未送达）"
            } else {
                "投递失败：待发队列溢出或对方长期不在线（本次未送达）"
            };
            eprintln!("[msg-route] 投递未送达：to={} state={state}", req.to);
            json_resp(
                StatusCode::BAD_GATEWAY,
                json!({ "ok": false, "delivered": false, "error": err, "state": state }),
            )
        }
        Err(e) => {
            eprintln!("[msg-route] 投递失败：to={} —— {e}", req.to);
            json_resp(
                StatusCode::BAD_GATEWAY,
                json!({ "ok": false, "delivered": false, "error": e }),
            )
        }
    }
}

/// 本机会话候选（`/api/session/list` 背后同一条加工链：`dsh_share::cli_local_sessions`）。
async fn session_pick_candidates() -> Vec<Value> {
    match crate::dsh_share::cli_local_sessions().await {
        Ok(v) => candidates_from_list(&v, SESSION_PICK_MAX),
        Err(e) => {
            // 清单拉不到就把 candidates 留空（错误体形状不变），并留痕。
            eprintln!("[msg-route] 取本机会话清单失败（candidates=[]）：{e}");
            Vec::new()
        }
    }
}

/// `GET /api/chat_state` —— `chat_service::chat_state()` 的薄包装：
/// `{ok, myDid, myName, friends:[{did,name,online}]}`（camelCase，`online` 缺省 false）。
pub async fn handle_chat_state() -> Response {
    let snap = match crate::chat_service::chat_state().await {
        Ok(v) => v,
        Err(e) => {
            return json_resp(
                StatusCode::BAD_REQUEST,
                json!({ "ok": false, "error": e }),
            )
        }
    };
    let lights = presence_lights_or_empty().await;
    let friends = friends_with_online(snap.get("friends"), &lights);
    json_resp(
        StatusCode::OK,
        json!({
            "ok": true,
            "myDid": snap.get("myDid").cloned().unwrap_or(Value::Null),
            "myName": snap.get("myName").cloned().unwrap_or(Value::Null),
            "friends": friends,
        }),
    )
}

/// 好友行 → `[{did,name,online}]`（纯函数）。只出 `status == "ok"` 的正式好友
/// （pending 的握手中行不可投递，列出来会诱导对方去发一条必然 403 的消息）。
pub(crate) fn friends_with_online(
    rows: Option<&Value>,
    lights: &Map<String, Value>,
) -> Vec<Value> {
    let Some(arr) = rows.and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .filter(|f| {
            // 缺 status 的老行按 ok 处理（load_friends 已做迁移；双保险）
            matches!(
                f.get("status").and_then(Value::as_str).unwrap_or("ok"),
                "ok"
            )
        })
        .filter_map(|f| {
            let did = f.get("did").and_then(Value::as_str)?.trim();
            if did.is_empty() {
                return None;
            }
            let name = f.get("name").and_then(Value::as_str).unwrap_or("").trim();
            Some(json!({
                "did": did,
                "name": name,
                "online": light_online(lights, did),
            }))
        })
        .collect()
}

/// 好友灯查询：先精确键，再按账号 did 等价扫（好友表可能是 `did:myco:` 旧形态）。
fn light_online(lights: &Map<String, Value>, did: &str) -> bool {
    if let Some(v) = lights.get(did) {
        return v.get("online").and_then(Value::as_bool).unwrap_or(false);
    }
    lights.iter().any(|(k, v)| {
        myco_core::identity::account_did_eq(k, did)
            && v.get("online").and_then(Value::as_bool).unwrap_or(false)
    })
}

/// presence 灯（网络调用；超时/失败一律空表——`online` 退化成 false，不编造在线）。
async fn presence_lights_or_empty() -> Map<String, Value> {
    let fut = crate::chat_service::presence_lights();
    match tokio::time::timeout(std::time::Duration::from_millis(PRESENCE_BUDGET_MS), fut).await {
        Ok(Ok((m, _))) => m,
        Ok(Err(e)) => {
            eprintln!("[msg-route] presence 拉取失败（online 一律 false）：{e}");
            Map::new()
        }
        Err(_) => {
            eprintln!("[msg-route] presence 超时（online 一律 false）");
            Map::new()
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 入站：dsh-session-msg → 本机 DSH session/prompt
// ═══════════════════════════════════════════════════════════════════════

/// 入站通道闸（纯函数）：只认 P2P 验签通道（见 [`P2P_TRANSPORT_MARK`]）。
pub(crate) fn inbound_transport_ok(m: &Value) -> bool {
    m.get("transport").and_then(Value::as_str) == Some(P2P_TRANSPORT_MARK)
}

/// 入站信封的消息 id（P2P 适配层用 `id`，wire 原始信封用 `msgId`）——只给日志用。
fn inbound_msg_id(m: &Value) -> String {
    m.get("msgId")
        .or_else(|| m.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// 入站 `dsh-session-msg` 处置（`chat_service::ingest_msg` 的早分支调用）。
///
/// 返回 true = 已处置（控制类消息，**不落会话/不产气泡**——它没有会话语义）；
/// false = 拒投/注入失败（已留痕，P2P 应答复 `kept:false`）。
pub(crate) async fn ingest(my: &str, m: &Value) -> bool {
    let transport_from = m.get("from").and_then(Value::as_str).unwrap_or("");
    let from_name = m.get("fromName").and_then(Value::as_str).unwrap_or("");
    let msg_id = inbound_msg_id(m);
    // 通道闸先于一切：信箱路径（无逐条设备签名）一律不受理 prompt 注入。
    if !inbound_transport_ok(m) {
        eprintln!(
            "[msg-route] 入站拒投（403）：非 P2P 验签通道（缺 transport 标记），from={transport_from} msgId={msg_id}"
        );
        return false;
    }
    let payload = m.get("payload").cloned().unwrap_or_else(|| json!({}));
    let claimed = payload
        .get("fromDid")
        .and_then(Value::as_str)
        .unwrap_or("");
    let is_self = !my.is_empty() && myco_core::identity::account_did_eq(transport_from, my);
    let is_friend = crate::chat_service::is_ok_friend(transport_from);
    let is_task_owner = crate::chat_service::is_shared_task_owner(transport_from);
    if let Err((code, msg)) = inbound_gate(transport_from, claimed, is_self, is_friend, is_task_owner)
    {
        eprintln!("[msg-route] 入站拒投（{code}）：msgId={msg_id} —— {msg}");
        return false;
    }
    let session_id = payload
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if session_id.is_empty() {
        let candidates = session_pick_candidates().await;
        // 接收侧这个错误无法同步回发送端（P2P 投递是单向的）；先原样落日志，
        // 让运维/后续错误回执协议（kind 待定）能照抄这份 JSON。
        eprintln!(
            "[msg-route] 入站拒投（400）：sessionId 缺省，未注入（from={transport_from} msgId={msg_id}）：{}",
            route_body_session_required(candidates)
        );
        return false;
    }
    let body = payload.get("body").and_then(Value::as_str).unwrap_or("");
    if body.trim().is_empty() {
        eprintln!("[msg-route] 入站拒投（400）：body 为空（from={transport_from} msgId={msg_id}）");
        return false;
    }
    // 发送端已按同一上限校验（8000 字）；这里再挡一次——不信任对端实现。
    if body.chars().count() > BODY_MAX_CHARS {
        eprintln!(
            "[msg-route] 入站拒投（400）：body 超上限 {} 字（from={transport_from} msgId={msg_id}）",
            body.chars().count()
        );
        return false;
    }
    let from_session = payload
        .get("fromSessionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    // mode 原样透传（契约：不映射成别的值；空则由 DSH 侧缺省 queue 兜底）。
    let mode = payload.get("mode").and_then(Value::as_str).unwrap_or("");
    let steer = mode.eq_ignore_ascii_case("steer");
    // 本模块只处理跨账号入站（dsh-session-msg 恒为跨账号）——显式传 true，
    // 让"多出来的那一行"在代码里可见，不做隐式无条件追加。
    let text = render_inbound_text(from_name, transport_from, from_session, body, steer, true);
    match crate::dsh_share::cli_local_session_prompt_mode(&session_id, &text, mode).await {
        Ok(_) => {
            eprintln!(
                "[msg-route] 入站已注入：session={session_id} from={transport_from} mode={} 字数={} msgId={msg_id}",
                if mode.is_empty() { "(默认)" } else { mode },
                text.chars().count()
            );
            true
        }
        Err(e) => {
            // 「sessionId 在本机不存在」/DSH 未就绪 都在这里——明确留痕，不静默吞。
            eprintln!(
                "[msg-route] 入站注入失败：session={session_id} from={transport_from} msgId={msg_id} —— {e}"
            );
            false
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 单测（纯函数直击；不打网络、不碰真实账号桶）
// ═══════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod tests {
    use super::*;

    fn full_body() -> Value {
        json!({
            "to": "did:youling:zAlice",
            "sessionId": "session-1111",
            "fromName": "DSH插件",
            "fromDid": "did:youling:zMe",
            "fromSessionId": "2222",
            "kind": "dsh-session-msg",
            "body": "你好\n第二行",
            "mode": "steer",
        })
    }

    #[test]
    fn parse_accepts_full_body_and_trims() {
        let r = parse_route_request(&full_body()).expect("完整 body 必须通过");
        assert_eq!(r.to, "did:youling:zAlice");
        assert_eq!(r.session_id, "session-1111");
        assert_eq!(r.from_name, "DSH插件");
        assert_eq!(r.from_did, "did:youling:zMe");
        assert_eq!(r.from_session_id, "2222");
        assert_eq!(r.body, "你好\n第二行", "正文换行必须原样保留");
        assert_eq!(r.mode, "steer");
    }

    #[test]
    fn parse_rejects_missing_to_400() {
        let mut v = full_body();
        v["to"] = json!("  ");
        let (code, msg) = parse_route_request(&v).unwrap_err();
        assert_eq!(code, 400);
        assert!(msg.contains("to"), "人话要指出缺哪个字段：{msg}");
    }

    #[test]
    fn parse_rejects_unknown_kind_400() {
        let mut v = full_body();
        v["kind"] = json!("text");
        let (code, msg) = parse_route_request(&v).unwrap_err();
        assert_eq!(code, 400);
        assert!(msg.contains("dsh-session-msg"), "{msg}");
    }

    #[test]
    fn parse_rejects_bad_or_missing_mode_400() {
        let mut v = full_body();
        v["mode"] = json!("interrupt");
        let (code, msg) = parse_route_request(&v).unwrap_err();
        assert_eq!(code, 400);
        assert!(msg.contains("steer"), "{msg}");
        let mut v = full_body();
        v["mode"] = json!("");
        assert_eq!(parse_route_request(&v).unwrap_err().0, 400);
    }

    #[test]
    fn parse_rejects_missing_from_did_400() {
        let mut v = full_body();
        v["fromDid"] = json!("");
        let (code, msg) = parse_route_request(&v).unwrap_err();
        assert_eq!(code, 400);
        assert!(msg.contains("fromDid"), "{msg}");
    }

    #[test]
    fn parse_rejects_empty_body_and_overlong_body() {
        let mut v = full_body();
        v["body"] = json!("   ");
        let (code, msg) = parse_route_request(&v).unwrap_err();
        assert_eq!(code, 400);
        assert!(msg.contains("body"), "{msg}");
        let mut v = full_body();
        v["body"] = json!("字".repeat(BODY_MAX_CHARS + 1));
        assert_eq!(parse_route_request(&v).unwrap_err().0, 400);
    }

    #[test]
    fn parse_rejects_non_object_body() {
        assert_eq!(parse_route_request(&json!("hi")).unwrap_err().0, 400);
    }

    /// 验收①：目标不是好友（也不是分享任务 owner）→ 403 + 人话。
    #[test]
    fn gate_rejects_non_friend_403() {
        let req = parse_route_request(&full_body()).unwrap();
        let (code, msg) = route_gate(&req, "did:youling:zMe", false, false).unwrap_err();
        assert_eq!(code, 403, "非好友必须 403");
        assert!(msg.contains("不是本好友"), "{msg}");
    }

    #[test]
    fn gate_allows_friend_and_task_owner() {
        let req = parse_route_request(&full_body()).unwrap();
        assert!(route_gate(&req, "did:youling:zMe", true, false).is_ok(), "好友放行");
        assert!(
            route_gate(&req, "did:youling:zMe", false, true).is_ok(),
            "分享任务 owner 放行"
        );
    }

    /// 验收②：fromDid 与（发送侧）本机账号不一致 → 403 拒发。
    #[test]
    fn gate_rejects_from_did_mismatch_403() {
        let req = parse_route_request(&full_body()).unwrap();
        let (code, msg) = route_gate(&req, "did:youling:zOther", true, false).unwrap_err();
        assert_eq!(code, 403);
        assert!(msg.contains("fromDid"), "{msg}");
        assert!(msg.contains("不一致"), "{msg}");
    }

    /// 验收③：payload 组装形状（恰好四个 camelCase 键，身份不进 payload）。
    #[test]
    fn payload_shape_is_exactly_four_camel_keys() {
        let p = build_payload("session-1111", "2222", "正文", "queue");
        let obj = p.as_object().expect("payload 必须是对象");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["body", "fromSessionId", "mode", "sessionId"]);
        assert_eq!(p["sessionId"], "session-1111");
        assert_eq!(p["fromSessionId"], "2222");
        assert_eq!(p["body"], "正文");
        assert_eq!(p["mode"], "queue");
        // 防回归：凭据性字段一律不得出现
        for banned in ["fromDid", "fromName", "from", "to", "kind"] {
            assert!(p.get(banned).is_none(), "payload 不得带 {banned}");
        }
    }

    /// sessionId 缺省的响应体逐字锁死。
    #[test]
    fn session_required_body_is_literal() {
        let v = route_body_session_required(vec![json!({"sessionId":"session-a","title":"有灵运营"})]);
        assert_eq!(v["ok"], json!(false));
        assert_eq!(v["error"], json!("sessionId-required"));
        assert_eq!(v["candidates"][0]["sessionId"], json!("session-a"));
        assert_eq!(v["candidates"][0]["title"], json!("有灵运营"));
    }

    #[test]
    fn candidates_from_list_takes_first_n_and_normalizes_keys() {
        let list = json!({ "count": 3, "sessions": [
            {"sessionId": "session-1", "name": "甲"},
            {"sessionId": "session-2", "name": "乙", "title": "乙标题"},
            {"sessionId": "   ", "name": "空 id"},
            {"sessionId": "session-3", "name": "丙"},
        ]});
        let c = candidates_from_list(&list, 2);
        assert_eq!(c.len(), 2, "上限生效");
        assert_eq!(c[0], json!({"sessionId": "session-1", "title": "甲"}));
        assert_eq!(c[1]["title"], json!("乙标题"), "title 优先于 name");
        assert_eq!(candidates_from_list(&json!({}), 5), Vec::<Value>::new());
    }

    #[test]
    fn resolved_from_name_falls_back_to_myco() {
        assert_eq!(resolved_from_name("DSH插件"), "DSH插件");
        assert_eq!(resolved_from_name("  "), "myco");
        assert_eq!(resolved_from_name(""), "myco");
    }

    /// ② 候选只对**本机账号**有意义；远端目标回空数组（不拿本机清单冒充对端）。
    #[test]
    fn session_required_candidates_only_for_local_target() {
        let my = "did:youling:zMe";
        assert!(session_required_candidates_allowed(my, my));
        assert!(
            !session_required_candidates_allowed("did:youling:zPeer", my),
            "远端目标不得回本机会话清单（会诱导误投）"
        );
        assert!(!session_required_candidates_allowed("   ", my));
        // 形状不变：空数组时 candidates 键仍在
        let v = route_body_session_required(Vec::new());
        assert_eq!(v["error"], json!("sessionId-required"));
        assert_eq!(v["candidates"], json!([]));
    }

    /// ③ 传输层好友闸预判：非好友（即使持分享任务卡）如实拒，且**不许**说"排队能补发"。
    #[test]
    fn transport_gate_blocks_non_friend_even_with_task_card() {
        let (code, msg) = route_transport_gate(false, false).unwrap_err();
        assert_eq!(code, 403);
        assert_eq!(
            msg,
            "目标账号未通过传输层好友校验（分享任务 owner 的跨账号投递本轮尚未开放）",
            "话术逐字（契约方给定）"
        );
        assert!(!msg.contains("待发队列"), "不许说排队能补发：{msg}");
        assert!(!msg.contains("不在线"), "不许说对方不在线：{msg}");
        assert!(route_transport_gate(true, false).is_ok(), "好友放行");
        assert!(route_transport_gate(false, true).is_ok(), "同账号多设备自同步放行");
    }

    /// 署名头：第一行来自既有 `cli::format_chat_header`，后两行**外拼**
    /// （`reply-to: <账号 DID>` + `reply-to-session: session-…`），然后直接正文。
    #[test]
    fn inbound_header_is_formatter_output_plus_reply_to_session_then_body() {
        let text = render_inbound_text(
            "DSH插件",
            "did:youling:z6Mknjywr4kBRLe2gj8X29ThWsFkjzqTq1VAj27WH1wnkoGc",
            "181a6a6d-d0f4-4e70-a9f1-d7761507bcfc",
            "第一行\n第二行",
            false,
            true,
        );
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 5, "三行头 + 两行正文：{text}");
        assert!(lines[0].starts_with("[from: DSH插件 · "), "{text}");
        assert!(lines[0].ends_with(']'), "{text}");
        assert_eq!(
            lines[1],
            "reply-to: did:youling:z6Mknjywr4kBRLe2gj8X29ThWsFkjzqTq1VAj27WH1wnkoGc",
            "跨账号 reply-to 必须是账号 DID（session id 在对端不可路由）"
        );
        assert_eq!(
            lines[2],
            "reply-to-session: session-181a6a6d-d0f4-4e70-a9f1-d7761507bcfc",
            "第三行定位到发送方会话（裸 id 自动补 session-）"
        );
        assert_eq!(lines[3], "第一行", "头之后直接接正文，不留空行/分隔线");
        assert_eq!(lines[4], "第二行");
        assert!(!text.contains("---"), "不要分隔线");
        assert!(!text.contains("via myco"), "不要通道说明");
        // 时间格式 MM-DD HH:MM（不带秒、不带时区、不是 ISO）
        let inside = lines[0]
            .trim_start_matches("[from: ")
            .trim_end_matches(']');
        let (name, stamp) = inside.split_once(" · ").expect("头里必须有 · 时间");
        assert_eq!(name, "DSH插件");
        assert_eq!(stamp.len(), 11, "MM-DD HH:MM 恰好 11 字符：{stamp}");
        assert_eq!(&stamp[2..3], "-");
        assert_eq!(&stamp[5..6], " ");
        assert_eq!(&stamp[8..9], ":");
        assert!(!stamp.contains('T'), "不是 ISO：{stamp}");
    }

    /// 非跨账号分支：沿用既有两行形态（`reply-to: session-…`），不出现 DID 行。
    #[test]
    fn inbound_header_without_cross_account_is_pure_formatter_output() {
        let sid = "cd8a3c33-c0f3-4843-ade3-55fd603bf5db";
        let text = render_inbound_text("X", "did:youling:zA", sid, "正文", false, false);
        let expected_reply = format!("reply-to: session-{sid}");
        assert!(!text.contains("reply-to-session"), "{text}");
        assert!(!text.contains("did:youling:zA"), "本地分支不写账号 DID：{text}");
        assert_eq!(text.lines().count(), 3, "两行头 + 一行正文：{text}");
        assert_eq!(text.lines().nth(1), Some(expected_reply.as_str()));
        assert!(text.ends_with("正文"), "{text}");
    }

    /// steer 插队标记由既有 `cli::format_chat_header` 负责（不在这里另拼）。
    #[test]
    fn inbound_header_keeps_existing_steer_marker() {
        let text = render_inbound_text("DSH插件", "did:youling:zA", "s1", "正文", true, true);
        let head = text.lines().next().unwrap();
        assert!(head.starts_with("[from: DSH插件 · ⚡插队 · "), "{head}");
        assert_eq!(
            text.lines().nth(1),
            Some("reply-to: did:youling:zA"),
            "插队标记只影响第一行，reply-to 仍是账号 DID"
        );
    }

    #[test]
    fn inbound_header_omits_reply_to_lines_when_session_unknown() {
        // DID 有、session 无 → 保留 `reply-to: <DID>`（否则完全没法回信），只省第三行。
        let text = render_inbound_text("X", "did:youling:zA", "   ", "正文", false, true);
        assert!(text.contains("reply-to: did:youling:zA"), "{text}");
        assert!(!text.contains("reply-to-session"), "{text}");
        assert!(text.starts_with("[from: X · "), "{text}");
        assert!(text.ends_with("正文"));
        assert_eq!(text.lines().count(), 3, "from + reply-to + 正文：{text}");
    }

    #[test]
    fn inbound_header_falls_back_to_myco_when_name_missing() {
        let text = render_inbound_text("", "did:youling:zA", "s1", "正文", false, true);
        assert!(text.starts_with("[from: myco · "), "{text}");
    }

    /// 防伪造：payload 自称 fromDid ≠ 传输层身份 → 403 拒投。
    #[test]
    fn inbound_gate_rejects_from_did_spoof_403() {
        let (code, msg) = inbound_gate(
            "did:youling:zReal",
            "did:youling:zFake",
            false,
            true,
            false,
        )
        .unwrap_err();
        assert_eq!(code, 403);
        assert!(msg.contains("传输层"), "{msg}");
        assert!(msg.contains("不一致"), "{msg}");
    }

    #[test]
    fn inbound_gate_rejects_stranger_and_empty_from_403() {
        let (code, msg) = inbound_gate("did:youling:zStranger", "", false, false, false).unwrap_err();
        assert_eq!(code, 403);
        assert!(msg.contains("不是好友"), "{msg}");
        assert_eq!(inbound_gate("", "", false, false, false).unwrap_err().0, 403);
    }

    #[test]
    fn inbound_gate_allows_friend_self_and_task_owner() {
        assert!(inbound_gate("did:youling:zA", "", false, true, false).is_ok());
        assert!(inbound_gate("did:youling:zA", "", true, false, false).is_ok());
        assert!(inbound_gate("did:youling:zA", "", false, false, true).is_ok());
        // 自报与传输层一致（同 did）也放行
        assert!(inbound_gate("did:youling:zA", "did:youling:zA", false, true, false).is_ok());
    }

    /// 通道闸：只有 p2p_server 验签后打的标记才受理（信箱 `/msg/poll` 一律拒）。
    #[test]
    fn inbound_transport_gate_only_accepts_p2p_signed_path() {
        assert!(inbound_transport_ok(
            &json!({"transport": P2P_TRANSPORT_MARK})
        ));
        assert!(!inbound_transport_ok(&json!({})), "缺标记 = 拒（fail-closed）");
        assert!(
            !inbound_transport_ok(&json!({"transport": "mailbox"})),
            "别家通道标记不得冒充"
        );
        assert!(!inbound_transport_ok(&json!({"transport": null})));
    }

    /// 好友名册 → `[{did,name,online}]`：status=ok 才出，online 缺失一律 false（字段不省）。
    #[test]
    fn friends_with_online_filters_and_keeps_online_field() {
        let rows = json!([
            {"did": "did:youling:zA", "name": "甲", "status": "ok"},
            {"did": "did:youling:zB", "name": "乙", "status": "ok"},
            {"did": "did:youling:zC", "name": "丙", "status": "in-pending"},
            {"did": "   ", "name": "空", "status": "ok"},
        ]);
        let mut lights = Map::new();
        lights.insert(
            "did:youling:zA".into(),
            json!({"online": true, "state": "active"}),
        );
        let out = friends_with_online(Some(&rows), &lights);
        assert_eq!(out.len(), 2, "pending/空 did 不出：{out:?}");
        assert_eq!(out[0], json!({"did": "did:youling:zA", "name": "甲", "online": true}));
        assert_eq!(out[1], json!({"did": "did:youling:zB", "name": "乙", "online": false}));
        assert_eq!(friends_with_online(None, &lights), Vec::<Value>::new());
    }

    #[test]
    fn normalize_session_id_prefixes_once() {
        assert_eq!(normalize_session_id("abc"), Some("session-abc".into()));
        assert_eq!(normalize_session_id("session-abc"), Some("session-abc".into()));
        assert_eq!(normalize_session_id("  "), None);
    }
}
