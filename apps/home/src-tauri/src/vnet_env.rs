//! vnet_env.rs — **任务卡 env 执行器**（2026-10-23 · AOP 范式：入口只来自分享的任务卡）。
//!
//! 设计基准：`eval/vnet/design-task-card-env.md`（定稿）+ `eval/vnet/task.md` §3R R24–R28
//! + `eval/vnet/cases-matrix.md` V20.1–V20.6。
//!
//! ## 为什么单独一个模块（而不是塞进 dsh_share.rs）
//!
//! `dsh_share.rs` 已是 2 万行、且并行会话在改它的 msg 路由挂载。执行器的策略
//! （kind 白名单 / 固定口 / 五状态机 / 协议探测）最好**可单测**，所以：
//!   · 本模块独立承载全部新逻辑；
//!   · `dsh_share.rs` 只加一行路由挂载（`/api/env/open`）；
//!   · 复用它的三条既有能力（`audit` / `vnet_keep_upsert` / `write_rdp_file` +
//!     `launch_mstsc`），仅把可见性放到 `pub(crate)`，不复制实现（单一事实源）。
//!
//! ## 执行链（设计 §3「客户端行为」六步）
//!
//! ```text
//! ① 卡闸     caps 必须含 vnet.forward（卡未声明 caps 一律 denied；本机调试用显式 debug:true）
//!            + signature 形态校验（占位：见下方「签名」说明）
//! ② presence 设备在线？离线 → state=offline，**不建链、不启动客户端**（R26）
//! ③ keep     固定本地口（env.localPort，缺省按 kind 默认表）持久化 + 复用/新建隧道
//! ④ 探测     TCP 通 + 协议握手（rdp X.224 / dsh·http GET / / ssh banner）
//!            不通 → state=no-service，不启动客户端（R27）
//! ⑤ 启动     rdp→mstsc <临时.rdp>；dsh/http→系统浏览器 127.0.0.1:<local>/；ssh/stereo/adb→给提示
//! ⑥ 回报     {ok, state, address, clientStarted, ms, ...}；每次调用都写 `env-open` 审计
//! ```
//!
//! ## 五状态 + 本机错误（设计 §5；`building` 由 UI 在 await 期间本地呈现）
//!
//! `ready` 绿 / `building` 转圈 / `offline` 灰 / `no-service` 黄 / `denied` 红。
//! 执行器只返回**终态**（ready/offline/no-service/denied/error），从不在离线/无服务/无权限时
//! 启动客户端——R26/R27 的「不误启动、不误报成功」就靠这一条。
//!
//! 2026-10-23 补：`error`（本机侧失败，如固定本地口被占）。它不是设计五状态之一，
//! 但**绝不能伪装成 `offline`**——设备可能好得很，是本机端口/资源问题。文案必须
//! 点名 localPort，让用户改卡，而不是等一次永远不会好的"稍后再试"。
//!
//! ## 签名（明确边界，不装）
//!
//! 本版只做**形态校验**（非空 / 长度 / ASCII 可打印）并把 `verified.signature="format"`
//! 如实回给调用方；**没有**做 Ed25519 验签——卡 payload 里不带 `owner` 公钥，而按 did
//! 现取公钥要走身份服务（离线卡会全灭）。真验签留给「卡由源设备签名 + 公钥随卡」的
//! 下一版，别在这里写一个看起来验过、其实没验的假绿。
//!
//! ## 为什么探测走阻塞 IO（`std::net` + `spawn_blocking`）
//!
//! `tokio` 在本 crate 只开了 `net/time/rt`，没有 `io-util`；`TcpStream::read/write`
//! 的扩展 trait 用不了。探测本身是**一次短同步握手**（读超时 1.5s 内），用
//! `std::net::TcpStream::set_read_timeout` 写出来最短、最好测（单测直接用 std 线程起
//! 假服务器），也避免为一次握手给 Cargo 加 feature。

use axum::Json;
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

/// 卡必须授予的能力名（与 `eval/vnet/design-task-card-env.md` §3 一致）。
pub const CAP_VNET_FORWARD: &str = "vnet.forward";

/// kind 白名单（设计 §3/§4；`stereo`/`adb` 只在默认口表里出现，同样可执行）。
/// 2026-11-01 自由远程桌面方案（design/07-connectivity/REMOTE-DESKTOP-远程桌面自由方案.md）：
/// + `vnc`（Mac 屏幕共享 / Linux TigerVNC·x11vnc，RFB 5900 段）
/// + `rustdesk`（GPL 远程桌面，"允许 IP 直接访问"固定口，默认 21118）。
pub const ENV_KINDS: &[&str] = &["rdp", "dsh", "ssh", "http", "stereo", "adb", "vnc", "rustdesk"];

/// 本机管理面保留口：固定口不许占用（顶掉自己的管理面/网关）。
const RESERVED_LOCALS: &[u16] = &[3102, 9100, 13911, crate::dsh_share::VIEWER_HTTP_DEFAULT_PORT];

/// 单步预算（R25：固定口已建 ≤1500ms，需建链 ≤3000ms）。
/// presence 是一次云端名册读（正常 50–300ms），给 2.5s 只用于「离线判定」不被网络拖死。
pub const PRESENCE_BUDGET: Duration = Duration::from_millis(2500);
/// keep + 建链：`tunnel_open` 内部赛跑预算 3000ms，这里留 200ms 余量。
pub const FORWARD_BUDGET: Duration = Duration::from_millis(3200);
/// 协议握手：RDP 的 X.224 confirm 正常 <100ms；1.5s 覆盖对端慢启动。
pub const PROBE_BUDGET: Duration = Duration::from_millis(1500);

/// 2026-11-03 真案（笔记本点 DSH 卡误报 no-service）：HTTP 探测经"代签口→vnet 隧道→
/// host 网关"的往返里，网关根路径回的是整页 DSH HTML（~71KB），经中继腿时**首字节**
/// 可能超 1.5s（探测放弃后响应才到——clean-proxy 日志实锤：`resp bytes=71848 path=/`
/// 在探测器超时后照样落回来，同口 `/gw/<id>/ping`（138B）则秒回）。dsh/http 探测
/// 预算放宽到 3.5s，并且有 shareId 时优先探轻量 ping 路径（见 RealRuntime::probe）。
pub const HTTP_PROBE_BUDGET: Duration = Duration::from_millis(3500);
/// 客户端启动（spawn mstsc / 打开浏览器）：进程创建本身 <100ms。
pub const LAUNCH_BUDGET: Duration = Duration::from_millis(1500);

/// kind → 固定本地口（设计 §4 表；`http` 不在表内——卡**应显式给 localPort**，
/// 这里给的 23912 只是"不给也不崩"的兜底，且刻意避开 dsh 的 23911）。
///
/// 2026-11-02：应用类 kind（dsh）的本机默认口改由 [`crate::share_app`] 适配器提供——
/// 「DSH 专属下沉」P0：数值仍 23911、行为零变化，但语义归属已离开核心常量表。
pub fn default_local_port(kind: &str) -> Option<u16> {
    if let Some(app) = crate::share_app::adapter_for(kind) {
        return Some(app.default_local_port());
    }
    Some(match kind {
        "rdp" => 23389,
        "ssh" => 2223,
        "stereo" => 29000,
        "adb" => 25037,
        "http" => 23912,
        "vnc" => 23590,
        "rustdesk" => 23591,
        _ => return None,
    })
}

/// kind → 目标端口（设计 §4 表）。
///
/// 2026-11-02：应用类 kind（dsh）的默认口改由 [`crate::share_app`] 适配器提供——
/// 这是「DSH 专属下沉」P0：数值仍 13911、行为零变化，但语义归属已经离开核心常量表。
pub fn default_target_port(kind: &str) -> Option<u16> {
    if let Some(app) = crate::share_app::adapter_for(kind) {
        return Some(app.default_target_port());
    }
    Some(match kind {
        "rdp" => 3389,
        "ssh" => 22,
        "stereo" => 9000,
        "adb" => 5037,
        "http" => 80,
        "vnc" => 5900,
        "rustdesk" => 21118,
        _ => return None,
    })
}

/// kind 是否在白名单内。
pub fn is_known_kind(kind: &str) -> bool {
    ENV_KINDS.contains(&kind)
}

/// kind → 人话服务名（no-service 文案用，设计 §5）。
///
/// 应用类 kind（dsh）走适配器 [`crate::share_app::ShareAppAdapter::title`]（P0 文案不变）。
pub fn service_name(kind: &str) -> &'static str {
    if let Some(app) = crate::share_app::adapter_for(kind) {
        return app.title();
    }
    match kind {
        "rdp" => "远程桌面",
        "ssh" => "SSH",
        "http" => "HTTP",
        "stereo" => "立体声",
        "adb" => "adb",
        "vnc" => "VNC 远程桌面",
        "rustdesk" => "RustDesk",
        _ => "目标",
    }
}

/// 五状态词表（`building` 不由此执行器返回，见模块头）。
///
/// `Error` 是 2026-10-23 追加的**本机错误**终态：固定本地口被占、本机监听失败这类
/// "不是设备离线"的失败。设计五状态里没有它，但把本机端口冲突报成 `offline`
/// 会让用户永远等一个不会恢复的"稍后再试"（真机事故：默认口 23912 被占）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvState {
    Ready,
    Building,
    Offline,
    NoService,
    Denied,
    Error,
}

impl EnvState {
    pub fn as_str(self) -> &'static str {
        match self {
            EnvState::Ready => "ready",
            EnvState::Building => "building",
            EnvState::Offline => "offline",
            EnvState::NoService => "no-service",
            EnvState::Denied => "denied",
            EnvState::Error => "error",
        }
    }

    /// `ok` 只对 ready 为真——旧接口的 `launched` 曾把"自连提示"也报成成功，
    /// 这里从词表层面切断"误报成功"（R27）。
    pub fn ok(self) -> bool {
        matches!(self, EnvState::Ready)
    }
}

/// 解析后的一个 env 执行请求（含闸门信息；`spec` 为 None 即 denied）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvCall {
    pub card_id: String,
    pub task_id: String,
    pub kind: String,
    pub device: String,
    pub port: u16,
    pub local_port: u16,
    /// `localPort` 是否由卡显式给出（false = 用了 kind 默认表；本机端口冲突时的
    /// 文案要据此区分"改卡"还是"释放端口"）。
    pub local_port_explicit: bool,
    pub label: Option<String>,
    pub caps: Vec<String>,
    /// `caps` 字段**是否出现**（空数组也算声明过 → 必须含 vnet.forward，否则 denied）。
    pub caps_declared: bool,
    pub signature: String,
    pub signature_declared: bool,
    pub debug: bool,
    /// 卡上的分享入口 URL（`env.kind=dsh/http` 的可选字段 `entryUrl`）。
    ///
    /// **原样保留在 call 里**（只用于 trace/审计"卡上带没带入口"），真正的校验在
    /// [`browser_target`]：不合法的 URL **绝不打开**，回落根路径。见 [`validate_entry_url`]。
    pub entry_url: Option<String>,
    /// Some = 通过全部闸门；None = denied（原因见 `denial`）。
    pub spec: Option<EnvSpec>,
    pub denial: Option<String>,
}

/// 通过闸门后的可执行规格。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvSpec {
    pub kind: String,
    pub device: String,
    pub port: u16,
    pub local_port: u16,
    pub local_port_explicit: bool,
    pub label: Option<String>,
    /// 卡上声明的分享入口（可选；`dsh|http`）。**执行前必校验**——见 [`browser_target`]。
    pub entry_url: Option<String>,
    /// 分享 id（`sh-…`）：新架构（remote 无 mt/cookie）用它起本机 clean 断言代理，
    /// 浏览器只拿简版地址 `/gw/<shareId>/`，断言由代理逐请求现签。
    /// 来源：卡上 entryUrl 的 shareId，或卡身份 `cardId/shareId`（sh- 前缀）。
    pub share_id: Option<String>,
}

fn as_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty())
}

fn as_u16(v: &Value, key: &str) -> Option<u16> {
    v.get(key)
        .and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.trim().parse::<u64>().ok())))
        .and_then(|n| u16::try_from(n).ok())
        .filter(|n| *n > 0)
}

/// `caps` 归一：数组 / JSON 字符串（`'["vnet.forward"]'`）/ 逗号分隔串 / 对象键。
/// 返回 (词表, 是否声明过)。
fn parse_caps(v: &Value) -> (Vec<String>, bool) {
    let Some(x) = v.get("caps") else { return (Vec::new(), false) };
    let mut out: Vec<String> = Vec::new();
    match x {
        Value::Array(a) => {
            for it in a {
                if let Some(s) = it.as_str() {
                    out.push(s.trim().to_string());
                }
            }
        }
        Value::String(s) => {
            let t = s.trim();
            if let Ok(Value::Array(a)) = serde_json::from_str::<Value>(t) {
                for it in a {
                    if let Some(s) = it.as_str() {
                        out.push(s.trim().to_string());
                    }
                }
            } else if !t.is_empty() {
                for part in t.split(|c| c == ',' || c == ' ') {
                    if !part.trim().is_empty() {
                        out.push(part.trim().to_string());
                    }
                }
            }
        }
        Value::Object(o) => {
            // `{c:["vnet.forward"]}` / `{caps:[...]}` 两种历史形态
            let inner = o.get("c").or_else(|| o.get("caps")).cloned().unwrap_or(Value::Null);
            return parse_caps(&json!({ "caps": inner }));
        }
        _ => {}
    }
    (out, true)
}

/// 解析请求（**纯函数**：单测直击；不连网、不落盘）。
///
/// 认两种信封（卡本体可直接摊平在顶层，也可嵌在 `card` 里——与聊天 payload 同款兼容）：
/// ```jsonc
/// { "cardId":"sh-…", "taskId":"…", "caps":["vnet.forward"], "signature":"…",
///   "env": { "kind":"rdp","device":"did:myco:…","port":3389,"localPort":23389 } }
/// ```
pub fn parse_call(body: &Value) -> EnvCall {
    let card = body.get("card").unwrap_or(&Value::Null);
    // env 可以在顶层，也可以嵌在 card 里（设备群分享卡的形态）
    let env = body
        .get("env")
        .filter(|v| v.is_object())
        .or_else(|| card.get("env").filter(|v| v.is_object()))
        .unwrap_or(&Value::Null);

    let pick = |keys: &[&str]| -> String {
        for k in keys {
            if let Some(s) = as_str(body, k) {
                return s.to_string();
            }
            if let Some(s) = as_str(card, k) {
                return s.to_string();
            }
        }
        String::new()
    };

    let card_id = pick(&["cardId", "card_id", "id", "shareId"]);
    let task_id = pick(&["taskId", "task_id"]);
    let kind = as_str(env, "kind").unwrap_or("").to_ascii_lowercase();
    let device = as_str(env, "device").or_else(|| as_str(env, "deviceDid")).unwrap_or("").to_string();
    let port = as_u16(env, "port").or_else(|| default_target_port(&kind)).unwrap_or(0);
    // 显式 localPort 必须留痕：默认口被占时要能说"请在卡上显式给 localPort"，
    // 而不是把本机端口冲突伪装成设备离线（2026-10-23 kind=http 真案）。
    let explicit_local = as_u16(env, "localPort").or_else(|| as_u16(env, "local_port"));
    let local_port_explicit = explicit_local.is_some();
    let local_port = explicit_local.or_else(|| default_local_port(&kind)).unwrap_or(0);
    let label = as_str(env, "label").map(String::from);
    // 分享入口（2026-10-23）：`dsh/http` 打开"带 mt 的入口"而不是网关根路径——
    // 根路径无 cookie 必 401（`no share cookie (open the share entry first)`），
    // 而 cookie 只由入口 `/gw/<id>/?mt=…` 的 302 种下。字段名按 camelCase 契约为
    // `entryUrl`（兼容旧脚本写 `entry_url`，与 localPort/local_port 同款）。
    let entry_url = as_str(env, "entryUrl").or_else(|| as_str(env, "entry_url")).map(String::from);

    let (caps, caps_declared) = {
        let (mut c, d) = parse_caps(body);
        if !d {
            let (c2, d2) = parse_caps(card);
            if d2 {
                c = c2;
            }
            (c, d || d2)
        } else {
            (c, d)
        }
    };
    let signature = as_str(body, "signature").or_else(|| as_str(card, "signature")).unwrap_or("").to_string();
    let signature_declared = body.get("signature").is_some() || card.get("signature").is_some();
    let debug = body.get("debug").and_then(|v| v.as_bool()).unwrap_or(false);

    // ── ① 卡闸（caps → 签名形态），再 ② 参数闸 ──
    let mut denial: Option<String> = None;
    if caps_declared {
        if !caps.iter().any(|c| c == CAP_VNET_FORWARD) {
            denial = Some(format!("此卡未授予该能力（caps 里没有 {CAP_VNET_FORWARD}）"));
        }
    } else if debug && card_id.is_empty() {
        // 本机调试口：显式 debug:true 且不带 cardId（带了 cardId 就必须是"真卡"）
    } else {
        denial = Some(
            "卡未声明 caps（无 caps 的卡不能开 env；本机调试请显式 debug:true 且不带 cardId）".to_string(),
        );
    }

    if denial.is_none() && signature_declared {
        // 形态校验（真验签见模块头「签名」：本版不做假绿）
        if signature.len() < 32 || signature.len() > 512 || !signature.is_ascii() {
            denial = Some("卡签名形态不合法（应为 ≥32 字符 ASCII；本版只做形态校验）".into());
        }
    }

    if denial.is_none() {
        if !is_known_kind(&kind) {
            denial = Some(format!("不支持的 env.kind：{kind:?}（白名单：{}）", ENV_KINDS.join("|")));
        } else if device.is_empty() || !device.starts_with("did:") {
            denial = Some("env.device 缺或不是 DID（目标设备 DID 必填）".into());
        } else if port == 0 {
            denial = Some("env.port 非法（0 / 缺省且该 kind 没有默认端口）".into());
        } else if local_port == 0 {
            denial = Some("env.localPort 非法（0 / 缺省且该 kind 没有默认口）".into());
        } else if local_port < 1024 {
            denial = Some(format!("localPort {local_port} 太小（<1024 是系统保留段）"));
        } else if RESERVED_LOCALS.contains(&local_port) {
            denial = Some(format!("localPort {local_port} 是 myco 本机保留口（管理面/网关/p2p）"));
        } else if kind == "rdp" && port != 3389 {
            // RDP 的协议语义只认 3389（22 是 SSH；别拿 RDP 探测去打别的口）
            denial = Some(format!("RDP env 的目标端口只支持 3389（收到 {port}）"));
        } else if kind == "vnc" && !(5900..=5999).contains(&port) {
            // VNC 语义：display N = 5900+N（RFB 探测依赖问候；别的口不给探）
            denial = Some(format!("VNC env 的目标端口只支持 5900-5999（display N=5900+N；收到 {port}）"));
        }
    }

    let spec = if denial.is_none() {
        // 新架构（remote 无 mt/cookie）：分享身份优先取 entryUrl 里的 shareId；
        // 无 entryUrl 的分享卡则用卡身份（cardId/shareId，形如 sh-…）。
        let share_from_entry = entry_url
            .as_deref()
            .and_then(extract_share_id)
            // /dsh/ 是短别名，不是真实 shareId；真实身份取卡上的 cardId/shareId。
            .filter(|sid| sid.starts_with("sh-"));
        let share_from_card = {
            let c = card_id.trim();
            (c.starts_with("sh-") && c.len() > 3).then(|| c.to_string())
        };
        let share_id = share_from_entry.or(share_from_card);
        Some(EnvSpec {
            kind: kind.clone(),
            device: device.clone(),
            port,
            local_port,
            local_port_explicit,
            label: label.clone(),
            entry_url: entry_url.clone(),
            share_id,
        })
    } else {
        None
    };

    EnvCall {
        card_id,
        task_id,
        kind,
        device,
        port,
        local_port,
        local_port_explicit,
        label,
        caps,
        caps_declared,
        signature,
        signature_declared,
        debug,
        entry_url,
        spec,
        denial,
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 分享入口 URL（`entryUrl`）的校验与选择
//
// 现场（2026-10-23）：`dsh` 的客户端开的是 `http://127.0.0.1:<localPort>/` = 分享网关
// **根路径**。根路径只有在浏览器里**已有该分享 cookie** 时才给内容（无 cookie → 401
// `no share cookie (open the share entry first)`）；cookie 只由入口
// `/gw/<shareId>/?mt=<mt>` 的 302 种下。所以卡上带了 `entryUrl` 就必须开它。
//
// 但 `entryUrl` 来自卡（可跨设备投递/转授），**不能无条件信任**：放行任意 URL，一张
// 伪造卡就能借"打开 DSH"把系统浏览器指到外网钓鱼页，或指向本机别的服务（端口探测/
// 明文凭证面）。所以校验只认"本次建链的那个 loopback 口 + http"。
// ═══════════════════════════════════════════════════════════════════════

/// 校验卡上的 `entryUrl`：**只允许** `http://127.0.0.1:<local_port>/…`。
///
/// 规则（最小解析面，不引入 URL crate）：
///   · scheme 必须恰为 `http://`（网关只监听 loopback 的明文 http；https/localhost/
///     IPv6 一律不收——解析歧义面最小）；
///   · authority 必须**逐字等于** `127.0.0.1:<local_port>`（端口必须等于本次实际
///     建链的固定口，防止借卡打本机别的服务；`127.0.0.1:23911.evil` / `:239110`
///     这类靠逐字比较天然拒绝）；
///   · 不接受 userinfo（`127.0.0.1:23911@evil`）：authority 逐字比较会直接拒；
///   · 不接受空白/控制字符（`cmd /C start` 会把某些字符当分隔符）。
///
/// 返回 `Err(人话原因)`——调用方**不得打开**该 URL（回落根路径）。
pub fn validate_entry_url(url: &str, local_port: u16) -> Result<(), String> {
    let raw = url.trim();
    if raw.is_empty() {
        return Err("空 URL".into());
    }
    if raw.len() > 4096 {
        return Err("URL 过长".into());
    }
    if raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("含空白或控制字符".into());
    }
    let rest = raw
        .strip_prefix("http://")
        .ok_or_else(|| "scheme 必须是 http://（分享网关只监听 loopback 明文 http）".to_string())?;
    // authority = scheme 之后到第一个 path/query/fragment 分隔符之前。
    let end = rest.find(|c| c == '/' || c == '?' || c == '#').unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.contains('@') {
        return Err("不接受 URL userinfo（user@host）".into());
    }
    let want = format!("127.0.0.1:{local_port}");
    if local_port == 0 || authority != want {
        return Err(format!("只允许 {want}（收到 {authority:?}）"));
    }
    Ok(())
}

/// MYCO_DEVICE_ORIGIN=1 的入口校验：只认本卡目标设备的 `<alias>.localhost`、本次
/// 本地网关口、以及本卡分享的 `/<分享别名>/`。终态 URL 不得带 query/fragment；
/// 来源身份由 VNETP 承担。返回 Err 时调用方不得打开该 URL；Ok 携带**实际要开的
/// URL**——与卡面逐字一致时原样返回，仅主机别名漂移时治愈为 canonical（见
/// [`healed_device_origin_base`]）。
pub fn validate_device_origin_entry_url(
    url: &str,
    local_port: u16,
    device: &str,
    share_id: &str,
) -> Result<String, String> {
    let raw = url.trim();
    if raw.is_empty() || raw.len() > 4096 {
        return Err("空 URL 或 URL 过长".into());
    }
    if raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("含空白或控制字符".into());
    }
    let base = crate::dsh_share::device_origin_url(local_port, device, share_id)
        .ok_or_else(|| "缺目标设备别名、本地网关口或 shareId".to_string())?;
    if raw == base {
        return Ok(raw.to_string());
    }
    if let Some(healed) = healed_device_origin_base(raw, &base, local_port) {
        return Ok(healed);
    }
    Err(format!("只允许纯设备入口 {base}；不得带 query/fragment 或追加路径"))
}

/// 别名漂移治愈（2026-11-10 笔记本空卡真案）：源设备写进卡的 entryUrl 主机别名，
/// 可能与本 viewer 持久表里该 DID 的现行别名不同（别名规则升级前后、两端设备名缓存
/// 分叉）。**仅当**端口与分享路径段和 canonical 完全一致、只是 `<label>.localhost`
/// 的 label 漂移时，改开 canonical——治愈后的地址由本卡 device+shareId 现算，无凭空
/// 放行面（无 entryUrl 的 RootLegacy 本就开同一 canonical）。其余任何差异维持严格拒绝。
fn healed_device_origin_base(raw: &str, base: &str, local_port: u16) -> Option<String> {
    let rest = raw.strip_prefix("http://")?;
    let end = rest.find(['/', '?', '#'])?;
    let (host, port) = rest[..end].rsplit_once(':')?;
    if port.parse::<u16>().ok()? != local_port {
        return None;
    }
    let label = host.strip_suffix(".localhost")?;
    if label.is_empty() || label.contains('.') || label.contains('@') {
        return None;
    }
    let base_rest = base.strip_prefix("http://")?;
    let base_end = base_rest.find('/')?;
    (&rest[end..] == &base_rest[base_end..]).then(|| base.to_string())
}

/// `dsh|http` 的浏览器目标判定（纯函数：单测直击，不启动浏览器）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserTarget {
    /// 卡上 `entryUrl` 合法 → 直接开分享入口（网关验 mt → 种 cookie → 302 进应用）。
    Entry(String),
    /// 卡上没给 `entryUrl`（老卡）：**根路径，行为与改造前逐字节一致**（向后兼容）。
    /// 注意：根路径需要该分享的 cookie，老卡在"从没进过入口"的机器上仍会 401——
    /// 这是老卡数据缺失，不是执行器回归；重新发卡/同步后即带 `entryUrl`。
    RootLegacy,
    /// 卡上给了 `entryUrl` 但校验不过 → **拒绝该 URL**，回落根路径并留下原因。
    RootFallback(String),
}

impl BrowserTarget {
    /// 实际要打开的 URL（根路径按本次建链的 `local_port` 现拼）。
    pub fn url(&self, local_port: u16) -> String {
        match self {
            BrowserTarget::Entry(u) => u.clone(),
            _ => format!("http://127.0.0.1:{local_port}/"),
        }
    }

    /// 给人看的原因（只有"声明了但不可用"才提示；老卡保持既有文案不打扰用户）。
    pub fn fallback_note(&self) -> Option<&str> {
        match self {
            BrowserTarget::RootFallback(why) => Some(why),
            _ => None,
        }
    }

    pub fn uses_entry(&self) -> bool {
        matches!(self, BrowserTarget::Entry(_))
    }
}

/// 2026-10-25 真案（笔记本二击 401「无凭证」）：隧道重建瞬间约定口被半死旧监听
/// 占用 → 本次建链拿到随机口 → entryUrl 端口校验失败 → `RootFallback` 裸开
/// forward 根路径 → 网关 401「此分享需要 DID 授权（无凭证）」+ 旧标签被导航走。
///
/// 修（纯函数）：host 严格等于 127.0.0.1 且路径以 `/gw/` 开头时，把 authority 的
/// 端口**改写**为本次 local_port——上游是同一个网关（同一 device:port 的隧道），
/// mt 不变即完全等价；端口一致/非 /gw/ 路径/外域 → None（保留原校验语义，防绕）。
pub fn rewrite_entry_port(url: &str, local_port: u16) -> Option<String> {
    let raw = url.trim();
    let rest = raw.strip_prefix("http://")?;
    let end = rest.find(|c| c == '/' || c == '?' || c == '#')?;
    let authority = &rest[..end];
    let (host, port_str) = authority.split_once(':')?;
    let port: u16 = port_str.parse().ok()?;
    if port == local_port {
        return None;
    }
    let tail = &rest[end..];
    if host == "127.0.0.1" && tail.starts_with("/gw/") {
        return Some(format!("http://127.0.0.1:{local_port}{tail}"));
    }
    // 设备域卡也需要消除“源卡写盘口 → 访问端实际全局口”的漂移；只认 localhost 设备域
    // 与非根路径，且改写后仍要过 validate_device_origin_entry_url 的 DID/分享精确校验。
    if host.ends_with(".localhost")
        && !host.starts_with('.')
        && !host.contains('@')
        && tail.starts_with('/')
        && tail != "/"
        && !tail.starts_with("/gw/")
    {
        return Some(format!("http://{host}:{local_port}{tail}"));
    }
    None
}

/// 选目标：`entryUrl`（校验通过）优先；否则/非法 → 根路径。
/// 显式 mode 参数供纯测试使用；生产 wrapper 读 MYCO_DEVICE_ORIGIN，默认零变化。
pub fn browser_target_mode(
    spec: &EnvSpec,
    local_port: u16,
    use_device_origin: bool,
) -> BrowserTarget {
    match spec.entry_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => BrowserTarget::RootLegacy,
        Some(u) => {
            // Ok 携带实际要开的 URL：与卡面一致时原样；仅主机别名漂移时治愈为 canonical。
            let valid = if use_device_origin {
                validate_device_origin_entry_url(
                    u,
                    local_port,
                    &spec.device,
                    spec.share_id.as_deref().unwrap_or(""),
                )
                .map(BrowserTarget::Entry)
            } else {
                validate_entry_url(u, local_port).map(|_| BrowserTarget::Entry(u.to_string()))
            };
            match valid {
                Ok(t) => t,
                Err(why) => BrowserTarget::RootFallback(format!(
                    "卡上的 entryUrl 不可用（{why}），已回落根路径；根路径需要该分享的 cookie，可能 401"
                )),
            }
        }
    }
}

pub fn browser_target(spec: &EnvSpec, local_port: u16) -> BrowserTarget {
    browser_target_mode(spec, local_port, crate::dsh_share::device_origin_enabled())
}

/// MYCO_DEVICE_ORIGIN 的实际启动 URL：合法卡片 entryUrl 原样使用；无 entryUrl 的分享卡
/// 生成同设备域/同短分享名的干净地址。非法 entryUrl 返回 None（调用方不会启动浏览器）。
pub fn device_origin_browser_url(
    spec: &EnvSpec,
    local_port: u16,
    target: &BrowserTarget,
) -> Option<String> {
    let sid = spec.share_id.as_deref()?;
    match target {
        BrowserTarget::Entry(_) => Some(target.url(local_port)),
        BrowserTarget::RootLegacy => {
            crate::dsh_share::device_origin_url(local_port, &spec.device, sid)
        }
        BrowserTarget::RootFallback(_) => None,
    }
}

// ── 从 entryUrl 提取 shareId（旧 /gw/ 形态 + 设备域新形态；clean-proxy 已退役）──

/// 从 entryUrl 的 `/gw/<shareId>/…`（旧）或 `http://<设备别名>.localhost:<port>/<分享别名>/`（设备域新形态）提取。
pub(crate) fn extract_share_id(entry_url: &str) -> Option<String> {
    let u = entry_url.trim();
    if let Some(idx) = u.find("/gw/") {
        let sid = u[idx + 4..].split(['/', '?', '#']).next().unwrap_or("").trim();
        if !sid.is_empty() {
            return Some(sid.to_string());
        }
    }
    // 设备域新形态：路径第一段是分享别名（loose 提取，供旧路径展示/兜底使用）。
    let rest = u.strip_prefix("http://")?;
    let end = rest.find(|c| c == '/' || c == '?' || c == '#')?;
    let sid = rest[end..]
        .trim_start_matches('/')
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .trim();
    (!sid.is_empty()).then(|| sid.to_string())
}

// ═══════════════════════════════════════════════════════════════════════
// 协议探测（R27 的判定核：TCP 通 ≠ 服务存在）
// ═══════════════════════════════════════════════════════════════════════

/// RDP 的 X.224 Connection Request（T.125 一包，19 字节）——与 `vnet-rdp.py` /
/// `manual.md` 实测口径一致：发它，正常 RDP 服务回 `03 00 00 13 …`（Connection Confirm）。
pub const X224_RDP_REQUEST: [u8; 19] = [
    0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, 0x03,
    0x00, 0x00, 0x00,
];

/// 任意 HTTP 服务（DSH web 是 HTTP，401 也算"服务存在"）。
pub const HTTP_PROBE_REQUEST: &[u8] = b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nUser-Agent: myco-env-probe\r\n\r\n";

/// 阻塞版协议探测（纯函数，单测直接用 std 线程起假服务器）。
///
/// - `rdp`：发 X.224，等响应前 4 字节 `03 00 00 13`；
/// - `dsh`/`http`：发 GET，等任意 `HTTP/` 响应（状态码不重要——401 也是"在服务"）；
/// - `ssh`：**服务器先说话**，等 `SSH-` banner（不发任何东西）；
/// - `vnc`：**服务器先说话**，等 RFB 问候 `RFB 003.00x\n`（RFC 6143 §7.1.1）；
/// - `rustdesk`：直连协议无稳定可探测的应用层握手（客户端先说、且带加密），
///   TCP 通即认为"在服务"（与 stereo/adb 同档）；
/// - `stereo`/`adb`：没有稳定的应用层握手可探，TCP 通即认为"在服务"。
pub fn probe_blocking(local_port: u16, kind: &str, budget: Duration) -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], local_port));
    let Ok(mut st) = TcpStream::connect_timeout(&addr, budget) else { return false };
    let _ = st.set_read_timeout(Some(budget));
    let _ = st.set_write_timeout(Some(budget));

    let mut buf = [0u8; 512];
    match kind {
        "rdp" => {
            if st.write_all(&X224_RDP_REQUEST).is_err() {
                return false;
            }
            let mut got: Vec<u8> = Vec::new();
            loop {
                match st.read(&mut buf) {
                    Ok(0) => return false,
                    Ok(n) => {
                        got.extend_from_slice(&buf[..n]);
                        if got.len() >= 4 {
                            return got.starts_with(&[0x03, 0x00, 0x00, 0x13]);
                        }
                        if got.first().map(|b| *b != 0x03).unwrap_or(false) {
                            return false; // 首字节就不是 TPKT
                        }
                    }
                    Err(_) => return false, // 超时/重置：TCP 通但协议没回 → no-service
                }
            }
        }
        "dsh" | "http" => {
            // 2026-11-02 P1 收口：Host 必须带端口——代签代理的 CSRF 闸按
            // `127.0.0.1:<listen_port>` 精确比对；浏览器发起的请求本来就带端口。
            let req = format!(
                "GET / HTTP/1.1\r\nHost: 127.0.0.1:{local_port}\r\nConnection: close\r\nUser-Agent: myco-env-probe\r\n\r\n"
            );
            if st.write_all(req.as_bytes()).is_err() {
                return false;
            }
            let mut got: Vec<u8> = Vec::new();
            loop {
                match st.read(&mut buf) {
                    Ok(0) => return false,
                    Ok(n) => {
                        got.extend_from_slice(&buf[..n]);
                        // 首包可能不足 5 字节（分片）：只有"还是 HTTP/ 的前缀"才继续等
                        if got.len() >= 5 {
                            return got.starts_with(b"HTTP/");
                        }
                        if !b"HTTP/".starts_with(got.as_slice()) {
                            return false; // 前几字节就不是 HTTP → TCP 通但服务不对
                        }
                    }
                    // 读超时：已收到的字节里能认就认，不能认就是 no-service
                    Err(_) => return got.starts_with(b"HTTP/"),
                }
            }
        }
        "ssh" => {
            let mut got: Vec<u8> = Vec::new();
            loop {
                match st.read(&mut buf) {
                    Ok(0) => return false,
                    Ok(n) => {
                        got.extend_from_slice(&buf[..n]);
                        if got.windows(4).any(|w| w == b"SSH-") {
                            return true;
                        }
                        if got.len() > 255 {
                            return false; // SSH banner ≤255 字节（RFC 4253）
                        }
                    }
                    Err(_) => return false,
                }
            }
        }
        // VNC：服务器先发 12 字节 RFB 问候（"RFB 003.008\n"）；读到 "RFB " 前缀即认。
        // 首字节不是 'R' 就早退（TCP 通但服务不对 → no-service）。
        "vnc" => {
            let mut got: Vec<u8> = Vec::new();
            loop {
                match st.read(&mut buf) {
                    Ok(0) => return false,
                    Ok(n) => {
                        got.extend_from_slice(&buf[..n]);
                        if got.len() >= 4 {
                            return got.starts_with(b"RFB ");
                        }
                        if got.first().map(|b| *b != b'R').unwrap_or(false) {
                            return false; // 首字节就不是 RFB
                        }
                    }
                    Err(_) => return false, // 超时：TCP 通但没有 RFB 问候 → no-service
                }
            }
        }
        "rustdesk" | "stereo" | "adb" => true,
        _ => false,
    }
}

/// async 包装：探测是短同步握手，丢到 blocking 线程池，不堵 reactor。
pub async fn probe_protocol(local_port: u16, kind: &str, budget: Duration) -> bool {
    let kind = kind.to_string();
    tokio::task::spawn_blocking(move || probe_blocking(local_port, &kind, budget))
        .await
        .unwrap_or(false)
}

/// 轻量 HTTP 路径探测（dsh/http 专用）：GET 任意路径，等任意 `HTTP/` 前缀即算服务在。
/// 与 [`probe_blocking`] 的 dsh/http 分支同一读法，只是路径与预算可指定（2026-11-03：
/// 网关根路径回整页 ~71KB，经中继首字节可能超 1.5s；ping 路径 138B 秒回）。
pub async fn probe_http_path(local_port: u16, path: &str, budget: Duration) -> bool {
    let host = format!("127.0.0.1:{local_port}");
    probe_http_path_with_host(local_port, path, &host, budget).await
}

/// 同 [`probe_http_path`]，但允许设备域入口显式带白名单 Host；默认路径行为不变。
pub async fn probe_http_path_with_host(
    local_port: u16,
    path: &str,
    host: &str,
    budget: Duration,
) -> bool {
    use std::io::{Read, Write};
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nUser-Agent: myco-env-probe\r\n\r\n"
    );
    tokio::task::spawn_blocking(move || {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], local_port));
        let Ok(mut st) = std::net::TcpStream::connect_timeout(&addr, budget) else { return false };
        let _ = st.set_read_timeout(Some(budget));
        let _ = st.set_write_timeout(Some(budget));
        if st.write_all(req.as_bytes()).is_err() {
            return false;
        }
        let mut buf = [0u8; 512];
        let mut got: Vec<u8> = Vec::new();
        loop {
            match st.read(&mut buf) {
                Ok(0) => return false,
                Ok(n) => {
                    got.extend_from_slice(&buf[..n]);
                    if got.len() >= 5 {
                        return got.starts_with(b"HTTP/");
                    }
                    if !b"HTTP/".starts_with(got.as_slice()) {
                        return false;
                    }
                }
                Err(_) => return got.starts_with(b"HTTP/"),
            }
        }
    })
    .await
    .unwrap_or(false)
}

// ═══════════════════════════════════════════════════════════════════════
// 运行时依赖（trait：真实现 = RealRuntime；单测 = MockRuntime）
// ═══════════════════════════════════════════════════════════════════════

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// presence 结论。
///
/// - `SelfTarget`：目标是本机（在线，但**客户端不该在本机启动**）；
/// - `Online`：确认在线（活隧道命中，或云端名册能查到该设备）；
/// - `Offline`：**确认**不在线（名册查到了、就是没有这台设备）；
/// - `Unknown`：查不了（名册请求失败 / 超时）。**这不是离线**——2026-10-23 真案：
///   把"查不了"当"离线"后，自连/已建隧道场景在启动窗口里被误报 `offline`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    Online,
    SelfTarget,
    Offline,
    Unknown,
}

/// 云端名册的一次查询结论（关键：**没有这台设备 ≠ 没查成**）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RosterState {
    /// 名册里有这台设备（不管它有没有上报直连地址——在线就该试着建链）。
    Online,
    /// 名册查成功，但没有这台设备 → 这才是离线。
    Absent,
    /// 名册查不了（网络/签名/身份不可用）→ 未知，交给建链结果说话。
    Unavailable,
}

/// presence 的三层探针（抽成 trait 才能用替身断言"命中后不再查名册"）。
pub trait PresenceProbe: Send + Sync {
    fn self_did(&self) -> Option<String>;
    fn tunnel_local_port(&self, device: &str, port: u16) -> Option<u16>;
    fn roster<'a>(&'a self, device: &'a str) -> BoxFut<'a, RosterState>;
}

/// 默认静默的诊断开关：`MYCO_ENV_TRACE=1` 时每次 env-open 打判定中间值。
///
/// 保留它是为了下一次真机复现能一眼看到"哪一层没命中"（而不是只能看 audit 的
/// `ms=1/state=offline` 猜）。未设置时零输出。
pub(crate) fn env_trace_enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| {
        matches!(
            std::env::var("MYCO_ENV_TRACE").ok().as_deref(),
            Some("1") | Some("true") | Some("TRUE") | Some("yes")
        )
    })
}

macro_rules! env_trace {
    ($($arg:tt)*) => {
        if env_trace_enabled() {
            eprintln!("[env-trace] {}", format!($($arg)*));
        }
    };
}

/// presence 判定核（**纯顺序逻辑**，三层短路）：
/// ① 目标=本机 → SelfTarget（不看名册：名册里通常没有"自己"）；
/// ② 活隧道命中 → Online（不查云端：固定口已建是 R25 的快路径）；
/// ③ 名册：Online / Absent→Offline / Unavailable→Unknown（**未知绝不判离线**）。
pub async fn resolve_presence(probe: &dyn PresenceProbe, spec: &EnvSpec) -> Presence {
    let mine = probe.self_did();
    // 2026-11-06 真案：分身设备（同账号不同物理机）共享 DID——手机 myco 的
    // device_identity() 与 PC 相同，did_equiv 命中 → 误判 SelfTarget → 不启动
    // RDP 客户端。SelfTarget 的语义是"目标服务的**进程**在本机"，不是"DID 相同"。
    // 修法：仅当本机**确实有该目标端口的监听**时才判 SelfTarget（本机服务真在跑），
    // 否则按普通远端处理（走隧道）。
    if let Some(m) = mine.as_deref() {
        if myco_core::identity::did_equiv(m, &spec.device) {
            // DID 相同：进一步判本机是否真有该端口的服务在听（真·本机自连）
            // 2026-11-06 真案：分身设备（手机 myco）的 vnet server 也在听 3389
            // （白名单全量启动）——但这不是真实 RDP 服务，是隧道入口。SelfTarget
            // 必须排除 vnet server 的监听（它是"别人连我"的入口，不是"我连别人"的服务）。
            let local_listening = std::net::TcpStream::connect_timeout(
                &std::net::SocketAddr::from(([127, 0, 0, 1], spec.port)),
                std::time::Duration::from_millis(200),
            )
            .is_ok()
                // vnet server 监听不算真实服务：它是隧道入口，不是本机 RDP
                && !crate::vnet_forward::is_vnet_managed(&spec.device, spec.port);
            if local_listening {
                env_trace!("presence self_target self={m} device={} port={} (did_equiv+local_listen)", spec.device, spec.port);
                return Presence::SelfTarget;
            }
            // DID 相同但本机无该服务 → 分身设备连主机，按 Online 处理（走隧道）
            env_trace!("presence shared-did device={} port={} self={m} local_listen=false → 分身连主机，按 Online", spec.device, spec.port);
            return Presence::Online;
        }
    }
    // 2026-10-23 兜底（真机：self_did 打印正确但仍判离线）：直接读 device_identity 再比一次。
    if let Ok((raw, _)) = myco_core::identity::device_identity() {
        if myco_core::identity::did_equiv(&raw, &spec.device) {
            let local_listening = std::net::TcpStream::connect_timeout(
                &std::net::SocketAddr::from(([127, 0, 0, 1], spec.port)),
                std::time::Duration::from_millis(200),
            )
            .is_ok()
                && !crate::vnet_forward::is_vnet_managed(&spec.device, spec.port);
            if local_listening {
                env_trace!("presence self_target self={raw} device={} port={} (device_identity+local_listen)", spec.device, spec.port);
                return Presence::SelfTarget;
            }
            env_trace!("presence shared-did device={} port={} self={raw} local_listen=false → 分身连主机，按 Online", spec.device, spec.port);
            return Presence::Online;
        }
    }
    if let Some(p) = probe.tunnel_local_port(&spec.device, spec.port) {
        env_trace!("presence online device={} port={} tunnel=127.0.0.1:{p}", spec.device, spec.port);
        return Presence::Online;
    }
    // 2026-10-23 兜底（真机：隧道记录丢了但固定口还在听——orphan listener）：本地口能连即在线。
    if spec.local_port > 0
        && std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], spec.local_port)),
            std::time::Duration::from_millis(300),
        )
        .is_ok()
    {
        env_trace!("presence online device={} port={} local_listen=127.0.0.1:{}", spec.device, spec.port, spec.local_port);
        return Presence::Online;
    }
    match probe.roster(&spec.device).await {
        RosterState::Online => {
            env_trace!("presence online device={} port={} via roster", spec.device, spec.port);
            Presence::Online
        }
        RosterState::Absent => {
            env_trace!(
                "presence offline device={} port={} roster=absent self_did={}",
                spec.device,
                spec.port,
                mine.as_deref().unwrap_or("<unavailable>")
            );
            Presence::Offline
        }
        RosterState::Unavailable => {
            env_trace!(
                "presence unknown device={} port={} roster=unavailable self_did={} → 尝试建链",
                spec.device,
                spec.port,
                mine.as_deref().unwrap_or("<unavailable>")
            );
            Presence::Unknown
        }
    }
}

/// 客户端启动结果。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Launch {
    pub started: bool,
    /// `mstsc` / `browser` / `terminal`
    pub client: String,
    pub pid: Option<u32>,
    pub error: Option<String>,
    /// 给"不自启客户端"的 kind（ssh/stereo/adb）或自连提示的下一步人话。
    pub hint: Option<String>,
}

/// 执行器依赖面（单测可整体替身；真实现见 [`RealRuntime`]）。
pub trait EnvRuntime: Send + Sync {
    fn presence<'a>(&'a self, spec: &'a EnvSpec) -> BoxFut<'a, Presence>;
    /// keep + 建/复用隧道 → (实际本地口, "reused"|"opened"|"opened-drift")
    fn ensure_forward<'a>(&'a self, spec: &'a EnvSpec) -> BoxFut<'a, Result<(u16, String), String>>;
    fn probe<'a>(&'a self, spec: &'a EnvSpec, local_port: u16) -> BoxFut<'a, bool>;
    fn launch<'a>(&'a self, spec: &'a EnvSpec, local_port: u16, self_target: bool) -> BoxFut<'a, Launch>;
    /// 审计（"谁通过哪张卡用了什么"）。放进依赖面而不是直接调 `dsh_share::audit`：
    /// 单测用替身**在内存里**验审计契约，不往真机 `dsh-share-audit.jsonl` 写假卡。
    fn audit(&self, call: &EnvCall, state: EnvState, local_port: u16, client_started: bool, ms: u128);
    /// 端点租约簿记（task-vnet-endpoint-lease §7；默认 no-op → 测试替身零负担）。
    /// 返回 `Some(err)` = 租约冲突（口不变式；调用方转 Error 态人话返回）。
    fn lease_event(&self, _call: &EnvCall, _spec: &EnvSpec, _ev: LeaseHook) -> Option<String> {
        None
    }
}

/// 租约钩子事件（`EnvRuntime::lease_event` 的入参）。
#[derive(Clone, Debug)]
pub enum LeaseHook {
    /// 建链成功（携带实际本地口；租约口不变式在此裁决）。
    Opened(u16),
    /// 页面/协议可用（active/healthy）。
    UpstreamOk,
    /// 上游失败（→ degraded/recovering；口不释放）。
    UpstreamFail(String),
}

// ═══════════════════════════════════════════════════════════════════════
// 状态机（HTTP 与 Tauri IPC 共用；单测直击四态）
// ═══════════════════════════════════════════════════════════════════════

/// 共享状态机：返回**给 UI 的 JSON**，并经 `rt.audit` 落审计。
///
/// 顺序即设计 §3 的六步；任何一步失败都**提前返回且不启动客户端**。
pub async fn env_open_with(rt: &dyn EnvRuntime, body: &Value) -> Value {
    let t0 = Instant::now();
    let call = parse_call(body);
    let Some(spec) = call.spec.clone() else {
        let ms = t0.elapsed().as_millis();
        let state = EnvState::Denied;
        rt.audit(&call, state, 0, false, ms);
        let denial = call.denial.clone().unwrap_or_else(|| "此卡未授予该能力".into());
        return envelope(&call, state, 0, &Launch::default(), ms, Some(denial));
    };
    // ② presence
    let presence = match tokio::time::timeout(PRESENCE_BUDGET, rt.presence(&spec)).await {
        Ok(p) => p,
        // presence 超时 = 判不了在线 → **未知**（不是离线！）。继续尝试建链，
        // 让建链结果说话：隧道已建 / 对端其实在线时不会被 2.5s 名册拖成 offline。
        Err(_) => Presence::Unknown,
    };
    env_trace!(
        "env-open begin device={} kind={} port={} localPort={} explicit={} presence={:?}",
        spec.device,
        spec.kind,
        spec.port,
        spec.local_port,
        spec.local_port_explicit,
        presence
    );
    if presence == Presence::Offline {
        let ms = t0.elapsed().as_millis();
        let state = EnvState::Offline;
        rt.audit(&call, state, 0, false, ms);
        return envelope(&call, state, 0, &Launch::default(), ms, Some("设备离线，稍后再试".into()));
    }

    // ③ keep + 建链
    // 2026-11-09 负缓存自锁突破：env_open 是**用户显式打开**（不是后台无脑重试），
    // 先清该 (device, port) 的负缓存——否则 keeper 的 120s 退避会让「用户点击」也
    // 直接短路成「设备离线」（今天笔记本 13911 反复 offline 的直接机制）。
    if !spec.device.trim().is_empty() && spec.port != 0 {
        crate::vnet_forward::clear_vnet_backoff(&spec.device, spec.port);
    }
    let (local_port, how) = match tokio::time::timeout(FORWARD_BUDGET, rt.ensure_forward(&spec)).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            let ms = t0.elapsed().as_millis();
            let (state, msg) = forward_failure_state(&call, &spec, &e);
            env_trace!("env-open forward-err state={} msg={msg}", state.as_str());
            // 租约：建链失败=上游/本机故障 → degraded（已有的租约不释放、不换口）
            rt.lease_event(&call, &spec, LeaseHook::UpstreamFail(e.clone()));
            rt.audit(&call, state, 0, false, ms);
            return envelope(&call, state, 0, &Launch::default(), ms, Some(msg));
        }
        Err(_) => {
            let ms = t0.elapsed().as_millis();
            let state = EnvState::Offline;
            rt.lease_event(&call, &spec, LeaseHook::UpstreamFail("建链超时".into()));
            rt.audit(&call, state, 0, false, ms);
            return envelope(&call, state, 0, &Launch::default(), ms, Some("建链超时（设备离线或网络不稳）".into()));
        }
    };
    env_trace!("env-open forward-ok local={local_port} how={how}");
    // 租约登记：口不变式在此裁决（冲突 = 明确失败，不静默换口）。
    // device-origin 的 local_port 是 viewer 的全局 HTTP listener，不是 (device,target_port)
    // 隧道的本地端点；raw 上游由 route 自己管理，绝不能登记进这张卡的隧道租约。
    if how != "device-origin" {
        if let Some(conflict) = rt.lease_event(&call, &spec, LeaseHook::Opened(local_port)) {
            let ms = t0.elapsed().as_millis();
            rt.audit(&call, EnvState::Error, 0, false, ms);
            return envelope(&call, EnvState::Error, 0, &Launch::default(), ms, Some(conflict));
        }
    }

    // ④ 协议探测（2026-11-03 真案：DSH 刚重启的窗口里端口已绑但 HTTP 未就绪，
    //    单次探测 → 「TCP 通了但协议不响应」误报 no-service。修：最多 3 次、
    //    间隔 900ms，覆盖常规重启窗口；全部失败才判 no-service。
    //    ⚠️ 外层 timeout 必须同宽——dsh/http 的首字节经隧道可达 ~2.2s（慢腿，
    //    见 vnet 移交线），外层若仍用 1.5s 会把内层 3.5s 预算掐死（真案：
    //    6.3s=3×1.5s+1.8s，实测仍 no-service）。
    let probe_budget = if matches!(spec.kind.as_str(), "dsh" | "http") {
        HTTP_PROBE_BUDGET
    } else {
        PROBE_BUDGET
    };
    let mut served = false;
    for attempt in 0..3u32 {
        served = tokio::time::timeout(probe_budget, rt.probe(&spec, local_port))
            .await
            .unwrap_or(false);
        if served {
            if attempt > 0 {
                env_trace!("env-open probe 第 {} 次重试后通过 local={local_port}", attempt + 1);
            }
            break;
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(900)).await;
        }
    }
    if !served {
        let ms = t0.elapsed().as_millis();
        let state = EnvState::NoService;
        // 租约：listener 在但上游协议无响应 → degraded（I7：二者分开判定）
        rt.lease_event(&call, &spec, LeaseHook::UpstreamFail("protocol-probe-no-response".into()));
        rt.audit(&call, state, local_port, false, ms);
        return envelope(
            &call,
            state,
            local_port,
            &Launch::default(),
            ms,
            Some(format!(
                "目标未提供{}服务（TCP 通了但协议不响应；若对面服务刚重启请稍等再点，否则检查对面服务是否在跑）",
                service_name(&spec.kind)
            )),
        );
    }

    // ⑤ 启动客户端（自连时只给提示，不在服务端起 mstsc）
    let launch = match tokio::time::timeout(
        LAUNCH_BUDGET,
        rt.launch(&spec, local_port, presence == Presence::SelfTarget),
    )
    .await
    {
        Ok(l) => l,
        Err(_) => Launch { started: false, client: String::new(), pid: None, error: Some("启动客户端超时".into()), hint: None },
    };

    let ms = t0.elapsed().as_millis();
    let state = EnvState::Ready;
    // 租约：页面/服务可用 → active/healthy（T-heal 的正路径）
    rt.lease_event(&call, &spec, LeaseHook::UpstreamOk);
    rt.audit(&call, state, local_port, launch.started, ms);
    let mut out = envelope(&call, state, local_port, &launch, ms, None);
    if let Some(o) = out.as_object_mut() {
        o.insert("tunnel".into(), json!(how));
        o.insert("selfTarget".into(), json!(presence == Presence::SelfTarget));
        o.insert(
            "presence".into(),
            json!(match presence {
                Presence::Online => "online",
                Presence::SelfTarget => "self",
                Presence::Offline => "offline",
                Presence::Unknown => "unknown",
            }),
        );
    }
    out
}

/// 本机侧失败的判据：这些错误说明"端口/监听在本机就不成立"，与对端在不在线
/// 无关，**不能**报成设备离线（真机：默认口 23912 被占 → 用户以为设备离线）。
fn is_local_port_error(e: &str) -> bool {
    e.contains("固定本地口")
        || e.contains("绑定失败")
        || e.contains("本地监听失败")
        || e.contains("localPort")
        || e.contains("隧道白名单")
}

/// 建链失败 → 终态 + 人话。默认口（卡上没给 localPort）被占时，文案必须点名
/// "请在卡上显式给 localPort"；显式口失败则提示释放端口。
fn forward_failure_state(call: &EnvCall, spec: &EnvSpec, err: &str) -> (EnvState, String) {
    if is_local_port_error(err) {
        let default_hit = !spec.local_port_explicit
            && !call.local_port_explicit
            && default_local_port(&spec.kind) == Some(spec.local_port);
        let msg = if default_hit {
            format!(
                "默认本地口 {} 被占用，请在卡上显式给 localPort（{err}）",
                spec.local_port
            )
        } else {
            format!("本地口 {} 不可用，请释放该端口或改卡上的 localPort（{err}）", spec.local_port)
        };
        (EnvState::Error, msg)
    } else {
        (EnvState::Offline, format!("建链失败（设备离线或网络不可达）：{err}"))
    }
}

/// 统一响应外壳（字段命名 camelCase，与前端约定一致）。
fn envelope(call: &EnvCall, state: EnvState, local_port: u16, launch: &Launch, ms: u128, message: Option<String>) -> Value {
    let address = if local_port > 0 { format!("127.0.0.1:{local_port}") } else { String::new() };
    let mut v = json!({
        "ok": state.ok(),
        "state": state.as_str(),
        "kind": call.kind,
        "device": call.device,
        "port": call.port,
        "localPort": local_port,
        "requestedLocalPort": call.local_port,
        "address": address,
        "label": call.label,
        "cardId": call.card_id,
        "taskId": call.task_id,
        "clientStarted": launch.started,
        "client": if launch.client.is_empty() { Value::Null } else { json!(launch.client) },
        "pid": launch.pid,
        "ms": ms as u64,
        "debug": call.debug,
        "verified": {
            "caps": call.caps_declared,
            "signature": if call.signature_declared { "format" } else { "none" },
        },
        "caps": call.caps,
    });
    if let Some(m) = message {
        v["message"] = json!(m);
        if !state.ok() {
            v["error"] = json!(m);
        }
    }
    if let Some(e) = &launch.error {
        v["launchError"] = json!(e);
    }
    if let Some(h) = &launch.hint {
        v["hint"] = json!(h);
    }
    v
}

// ═══════════════════════════════════════════════════════════════════════
// 真实现（GUI 构建；HTTP 面与 Tauri IPC 共用 `env_open`）
// ═══════════════════════════════════════════════════════════════════════

/// 打开外部 URL（系统浏览器）——与 `lib.rs::open_external` 同款防闪终端写法。
#[cfg(all(feature = "gui", windows))]
fn open_url(url: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt as _;
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开浏览器失败: {e}"))
}

#[cfg(all(feature = "gui", not(windows)))]
fn open_url(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开浏览器失败: {e}"))
}

/// 审计落盘（env-open 事件；字段与 `eval/vnet/v20-card-env.py` 的断言同口径）。
#[cfg(feature = "gui")]
pub fn write_audit(call: &EnvCall, state: EnvState, local_port: u16, client_started: bool, ms: u128) {
    let port = call.port.to_string();
    let local_s = local_port.to_string();
    let ms_s = ms.to_string();
    let debug_s = call.debug.to_string();
    let started_s = client_started.to_string();
    let caps_s = call.caps.join(",");
    // 卡上带没带分享入口（2026-10-23：事后能答"这次 401 是老卡没 entryUrl，还是别的原因"）。
    // 只记 0/1，**不记 URL 本身**（里面是 bearer mt，不落审计）。
    let entry_s = if call.entry_url.is_some() { "1" } else { "0" };
    crate::dsh_share::audit(
        "env-open",
        &[
            ("card", &call.card_id),
            ("task", &call.task_id),
            ("kind", &call.kind),
            ("device", &call.device),
            ("port", &port),
            ("local", &local_s),
            ("state", state.as_str()),
            ("clientStarted", &started_s),
            ("caps", &caps_s),
            ("entry", entry_s),
            ("debug", &debug_s),
            ("ms", &ms_s),
        ],
    );
}

/// 生产探针：① 本机 DID（自连）② 活隧道 ③ 云端名册。
///
/// 三层全部走既有单一事实源，不在本模块复制任何判定；区别只在**结论语义**：
/// 名册查不了 → `Unavailable`（未知），查到了但没有 → `Absent`（离线）。
#[cfg(feature = "gui")]
struct RealPresenceProbe;

#[cfg(feature = "gui")]
impl PresenceProbe for RealPresenceProbe {
    fn self_did(&self) -> Option<String> {
        crate::p2p_tunnel::self_did_for_loopback_filter()
    }

    fn tunnel_local_port(&self, device: &str, port: u16) -> Option<u16> {
        crate::p2p_tunnel::tunnel_local_port(device, port)
    }

    fn roster<'a>(&'a self, device: &'a str) -> BoxFut<'a, RosterState> {
        Box::pin(async move {
            match crate::p2p_client::roster_lookup_by_did_any_kind(device).await {
                crate::p2p_client::RosterLookup::Online => RosterState::Online,
                crate::p2p_client::RosterLookup::Absent => RosterState::Absent,
                crate::p2p_client::RosterLookup::Unavailable => RosterState::Unavailable,
            }
        })
    }
}

// ═══════════ RustDesk 客户端直连启动（2026-11-01 点卡全自动） ═══════════
//
// RustDesk CLI 支持带参直连：`rustdesk --connect <ip:port> [--password <pwd>]`
// （2026-11-01 真机验证：直连模式过 myco 隧道可用）。密码策略：**不带** --password
// ——第一次由用户在 RustDesk 里输一次，之后 RustDesk 按对端记住；凭据不落 myco
// （待 §9 P0 凭据托管后再考虑注入）。

/// 联调/CI 开关：`MYCO_RUSTDESK_NO_LAUNCH=1` 时不拉 RustDesk
/// （与 MYCO_RDP_NO_LAUNCH / MYCO_ENV_NO_LAUNCH 同款语义，默认行为不变）。
#[cfg(feature = "gui")]
fn rustdesk_launch_suppressed() -> bool {
    std::env::var("MYCO_RUSTDESK_NO_LAUNCH")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// RustDesk 可执行文件发现（纯函数可测）：显式覆盖 → 常见安装位 → PATH 命中。
/// 显式给了却不可用 → None（不猜：避免路径拼错时悄悄拉起别的东西）。
#[cfg(feature = "gui")]
fn find_rustdesk_exe(
    override_path: Option<&str>,
    which: Option<&str>,
) -> Option<std::path::PathBuf> {
    if let Some(p) = override_path {
        let path = std::path::PathBuf::from(p);
        return if path.is_file() { Some(path) } else { None };
    }
    for c in [
        r"C:\Program Files\RustDesk\rustdesk.exe",
        r"C:\Program Files (x86)\RustDesk\rustdesk.exe",
    ] {
        let p = std::path::Path::new(c);
        if p.is_file() {
            return Some(p.to_path_buf());
        }
    }
    // Linux 控制端：发行版/官网 deb 装的 rustdesk 落在 PATH
    which.map(std::path::PathBuf::from).filter(|p| p.is_file())
}

/// PATH 发现（`where` / `command -v`；失败=没有）。
#[cfg(all(feature = "gui", windows))]
fn which_rustdesk() -> Option<String> {
    let out = std::process::Command::new("cmd")
        .args(["/C", "where rustdesk"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    s.lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

#[cfg(all(feature = "gui", not(windows)))]
fn which_rustdesk() -> Option<String> {
    let out = std::process::Command::new("sh")
        .args(["-c", "command -v rustdesk"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    s.lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

/// 点「打开」→ RustDesk 带参直连。返回 Ok(false) = 本机未装（回落提示，不算错误）。
#[cfg(feature = "gui")]
fn launch_rustdesk(address: &str) -> Result<bool, String> {
    if rustdesk_launch_suppressed() {
        return Ok(false);
    }
    let exe = find_rustdesk_exe(
        std::env::var("MYCO_RUSTDESK_EXE").ok().as_deref(),
        which_rustdesk().as_deref(),
    );
    let Some(exe) = exe else {
        return Ok(false);
    };
    std::process::Command::new(&exe)
        .args(["--connect", address])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| true)
        .map_err(|e| format!("启动 RustDesk 失败: {e}"))
}

/// `ensure_forward` 固定口三态判定（纯函数，2026-11-01 抽出便于矩阵测试）：
/// - `claimed`（keep/租约在册）+ 口上有活监听 → 复用（reused-listener）
/// - `claimed` + 口被占（重启后 keeper 恢复窗口：监听半开/未 accept）→ **也复用**
///   （交给随后的协议探测验真伪；2026-10-25 svchost 防线要求无约定时仍报错）
/// - 无约定 + 口被占 → 人话错误（不静默借道别人的监听）
/// - 口空闲 → 走正常 bind/建链
#[derive(Debug, PartialEq, Eq)]
enum PortClaimDecision {
    ReuseListener,
    ReuseClaimedPort,
    ErrOccupied,
    ProceedBind,
}

fn decide_port_claim(claimed: bool, listen_ok: bool, bind_ok: bool) -> PortClaimDecision {
    if claimed && listen_ok {
        PortClaimDecision::ReuseListener
    } else if claimed && !bind_ok {
        PortClaimDecision::ReuseClaimedPort
    } else if !bind_ok {
        PortClaimDecision::ErrOccupied
    } else {
        PortClaimDecision::ProceedBind
    }
}

/// 生产依赖实现：presence / vnet 隧道 / 协议探测 / 客户端启动 / 审计。
#[cfg(feature = "gui")]
pub struct RealRuntime;

#[cfg(feature = "gui")]
impl EnvRuntime for RealRuntime {
    fn presence<'a>(&'a self, spec: &'a EnvSpec) -> BoxFut<'a, Presence> {
        Box::pin(async move { resolve_presence(&RealPresenceProbe, spec).await })
    }

    fn ensure_forward<'a>(&'a self, spec: &'a EnvSpec) -> BoxFut<'a, Result<(u16, String), String>> {
        Box::pin(async move {
            // MYCO_DEVICE_ORIGIN=1：浏览器固定口是 viewer 自己的 Host 路由器；raw 上游
            // 强制走临时口。首次点卡注册目标并预热路由，后续其它设备请求由 Host 动态建链。
            if crate::dsh_share::device_origin_enabled()
                && spec.share_id.is_some()
                && (spec.kind == "dsh" || (spec.kind == "http" && spec.port == 13911))
            {
                let share_id = spec.share_id.as_deref().unwrap_or("");
                crate::dsh_share::register_device_origin_entry(
                    &spec.device,
                    spec.port,
                    spec.entry_url.as_deref(),
                    share_id,
                )?;
                let listen = crate::dsh_share::ensure_device_origin_listener(
                    crate::dsh_share::viewer_http_port(),
                )?;
                crate::dsh_share::ensure_device_http_route(&spec.device, spec.port).await?;
                env_trace!(
                    "ensure_forward device-origin share={} target={}:{} viewer={}",
                    share_id,
                    spec.device,
                    spec.port,
                    listen
                );
                return Ok((listen, "device-origin".to_string()));
            }
            // 2026-10-23 冲突预检（**必须在写 keep/preferred 之前**）：
            // 请求的口若不归这条 (device,port) 且已被别的隧道/进程占着，直接报本机
            // 错误。否则 `vnet_keep_upsert` 会把原来正确的固定口覆盖成冲突口，
            // keeper 之后每拍按冲突口重建、永远失败（真机 23912 死循环）。
            let had = crate::p2p_tunnel::tunnel_local_port(&spec.device, spec.port);
            // 2026-10-25 租约口径（task-vnet-endpoint-lease I2/I7）：这条 (device,port)
            // 已有**活隧道**且现口==约定口（preferred/租约）或根本没有约定 → 直接复用
            // 现口；卡面/入口坐标的端口漂移交给 rewrite_entry_port 改写。
            // 真案（RED）：PC 23911 被 svchost 占，卡面还写 localPort 23911，而隧道
            // 早已按 kept/固定口档案稳定在 24567 —— 旧逻辑落进下面"reused-listener"
            // 把 svchost 的监听当自己的口返回 → 协议探测失败报"目标未提供服务"
            // （静默用错端口 = 契约禁止的坐标漂移）。
            if let Some(cur) = had {
                let agreed = crate::p2p_tunnel::preferred_local(&spec.device, spec.port)
                    .or_else(|| crate::vnet_lease::leased_local_port(&spec.device, spec.port));
                if agreed.is_none() || agreed == Some(cur) {
                    let how = if cur == spec.local_port { "reused" } else { "reused-lease-port" };
                    env_trace!(
                        "ensure_forward reuse-live-tunnel device={} port={} cur={cur} spec={} agreed={agreed:?}",
                        spec.device, spec.port, spec.local_port
                    );
                    return Ok((cur, how.to_string()));
                }
                // 约定口 ≠ 现口（用户改了卡/keep 的 localPort）→ 落到下面按约定口重绑
            }
            if had != Some(spec.local_port) {
                if let Some((owner_dev, owner_port)) = crate::p2p_tunnel::tunnel_owner_of_local_port(spec.local_port) {
                    return Err(format!(
                        "固定本地口 127.0.0.1:{} 绑定失败：已被另一条隧道占用（{owner_dev}:{owner_port}）；请释放该端口或改 localPort",
                        spec.local_port
                    ));
                }
                // 端口被占：若能 TCP 连上**且该口确实归属这条 (device,port)**
                // （preferred/租约在册——典型=本进程的 orphan listener：TUNNELS 记录丢了
                // 但 accept 循环还活着）→ 复用该口（协议探测再验真伪）。
                // 2026-10-25 修：无归属证据的活监听（如 svchost 抢占 23911）**不算
                // 自己的**——继续往下 bind 检查，占用=明确报错，不静默借道。
                let claimed = crate::p2p_tunnel::preferred_local(&spec.device, spec.port)
                    == Some(spec.local_port)
                    || crate::vnet_lease::leased_local_port(&spec.device, spec.port)
                        == Some(spec.local_port);
                let listen_ok = std::net::TcpStream::connect_timeout(
                    &std::net::SocketAddr::from(([127, 0, 0, 1], spec.local_port)),
                    std::time::Duration::from_millis(300),
                )
                .is_ok();
                let bind_ok = std::net::TcpListener::bind(("127.0.0.1", spec.local_port)).is_ok();
                // 2026-11-01 重启窗口修复：约定口（keep/租约）在册、口被占却查不到
                // 归属——典型=重启后 keeper 恢复窗口（监听已起/半开，TUNNELS 注册
                // 未就位）。旧逻辑在这里直接报"端口已被占用"（真机：0.3.196 安装后
                // 首次点卡必红，第二次才复用成功）。约定在册=口是我们的：复用并交给
                // 紧随其后的协议探测验真伪；无归属证据的外来占用（svchost 类，
                // claimed=false）仍走硬错误，2026-10-25 的防御不变。
                match decide_port_claim(claimed, listen_ok, bind_ok) {
                    PortClaimDecision::ReuseListener => {
                        env_trace!(
                            "ensure_forward reuse-listener device={} port={} local=127.0.0.1:{}",
                            spec.device,
                            spec.port,
                            spec.local_port
                        );
                        return Ok((spec.local_port, "reused-listener".to_string()));
                    }
                    PortClaimDecision::ReuseClaimedPort => {
                        env_trace!(
                            "ensure_forward reuse-claimed-port(restart-window) device={} port={} local=127.0.0.1:{}",
                            spec.device,
                            spec.port,
                            spec.local_port
                        );
                        return Ok((spec.local_port, "reused-claimed-port".to_string()));
                    }
                    PortClaimDecision::ErrOccupied => {
                        return Err(format!(
                            "固定本地口 127.0.0.1:{} 绑定失败：端口已被本机其他进程占用；请释放该端口或改 localPort",
                            spec.local_port
                        ));
                    }
                    PortClaimDecision::ProceedBind => {}
                }
            }
            // 固定口先落盘：tunnel_open 的复用/重绑判定以它为准。
            // 2026-10-23 修：原实现"已有隧道就先返回实际口"——旧随机口/漂移口会被
            // 当成成功（reused-drift），约定的固定口永不 LISTEN（mstsc 0x204）。
            // 现在一律交给 route_open：口不对它先 abort 旧监听再按固定口重绑。
            crate::dsh_share::vnet_keep_upsert(&spec.device, spec.port, Some(spec.local_port), spec.label.as_deref());
            let result = crate::vnet_forward::route_open(&spec.device, spec.port, Some(spec.local_port)).await;
            env_trace!("ensure_forward device={} port={} had={had:?} result={result:?}", spec.device, spec.port);
            match result {
                Ok(p) => {
                    // tunnel_open 契约：有固定口时 p == spec.local_port，否则 Err。
                    // drift 分支只是防御（真出现说明契约被破坏，上层会把地址显示出来）。
                    let how = if had == Some(p) {
                        "reused"
                    } else if p == spec.local_port {
                        "opened"
                    } else {
                        "opened-drift"
                    };
                    Ok((p, how.to_string()))
                }
                Err(e) => Err(e),
            }
        })
    }

    fn probe<'a>(&'a self, spec: &'a EnvSpec, local_port: u16) -> BoxFut<'a, bool> {
        Box::pin(async move {
            // 2026-11-03：dsh/http 用宽预算 + 轻量路径（shareId 在手就探 /gw/<id>/ping，
            // 138B 小响应首字节快；ping 404 也照样是合法 HTTP 响应，不影响判定）。
            if matches!(spec.kind.as_str(), "dsh" | "http") {
                if crate::dsh_share::device_origin_enabled() {
                    if let Some(sid) = spec.share_id.as_deref() {
                        let Some(entry) = crate::dsh_share::device_origin_url(
                            local_port,
                            &spec.device,
                            sid,
                        ) else {
                            return false;
                        };
                        let Some(rest) = entry.strip_prefix("http://") else { return false };
                        let Some(end) = rest.find('/') else { return false };
                        let host = &rest[..end];
                        let path = format!("{}ping", &rest[end..]);
                        return probe_http_path_with_host(
                            local_port,
                            &path,
                            host,
                            HTTP_PROBE_BUDGET,
                        )
                        .await;
                    }
                }
                let path = match spec.share_id.as_deref() {
                    Some(sid) => format!("/gw/{sid}/ping"),
                    None => "/".to_string(),
                };
                return probe_http_path(local_port, &path, HTTP_PROBE_BUDGET).await;
            }
            probe_protocol(local_port, &spec.kind, PROBE_BUDGET).await
        })
    }

    fn launch<'a>(&'a self, spec: &'a EnvSpec, local_port: u16, self_target: bool) -> BoxFut<'a, Launch> {
        Box::pin(async move {
            let address = format!("127.0.0.1:{local_port}");
            // 自连：本机就是服务端。**只对 rdp 拦**——起 mstsc 等于自己连自己
            // （2026-10-22 用户纠正）。dsh/http 自开（PC 开自己的分享页）是真实用户
            // 路径（R-CARD-HTTP 2026-10-24 GREEN：经注入代理干净地址可用），以前把
            // 它一并拦掉会让「PC 点自己的 DSH 卡」只给提示不给 URL（2026-10-25
            // r-card-open-e2e PC 侧 RED 真案）。
            if self_target && matches!(spec.kind.as_str(), "rdp" | "adb") {
                return Launch {
                    started: false,
                    client: String::new(),
                    pid: None,
                    error: None,
                    hint: Some(format!(
                        "这是本机（服务端）。请到客户端设备（笔记本/手机）的任务卡上打开；或在本机用客户端连接 {address}"
                    )),
                };
            }
            match spec.kind.as_str() {
                "rdp" => {
                    let no_launch = crate::dsh_share::rdp_launch_suppressed();
                    let file = match crate::dsh_share::write_rdp_file(spec.port, "", &address) {
                        Ok(p) => p,
                        Err(e) => {
                            return Launch { started: false, client: "mstsc".into(), pid: None, error: Some(e), hint: None }
                        }
                    };
                    if no_launch {
                        return Launch {
                            started: false,
                            client: "mstsc".into(),
                            pid: None,
                            error: None,
                            hint: Some(format!("MYCO_RDP_NO_LAUNCH 已置位：只生成 {}，未启动 mstsc", file.display())),
                        };
                    }
                    match crate::dsh_share::launch_mstsc(&file) {
                        Ok(()) => Launch { started: true, client: "mstsc".into(), pid: None, error: None, hint: None },
                        Err(e) => Launch { started: false, client: "mstsc".into(), pid: None, error: Some(e), hint: None },
                    }
                }
                "dsh" | "http" => {
                    // 入口优先（2026-10-23 修）：根路径无 cookie 必 401，会话列表空白；
                    // 卡上的 entryUrl 是带 mt 的 `/gw/<id>/`（网关 302 种 cookie 再进应用）。
                    // 非法 entryUrl 一律**不打开**，回落根路径（老卡行为不变）。
                    //
                    // 2026-10-25 端口改写：隧道重建瞬间约定口可能被半死旧监听占用 →
                    // 本次建链拿到随机口 → entryUrl 端口校验必败 → 旧逻辑裸开根路径
                    // = 401「无凭证」（笔记本二击真案）。先按 `/gw/` 入口改写端口再判。
                    let spec_view;
                    let spec = match spec.entry_url.as_deref().and_then(|u| rewrite_entry_port(u, local_port)) {
                        Some(rw) => {
                            let mut s = spec.clone();
                            s.entry_url = Some(rw);
                            spec_view = s;
                            &spec_view
                        }
                        None => spec,
                    };
                    let target = browser_target(spec, local_port);
                    let device_origin_now = crate::dsh_share::device_origin_enabled()
                        && spec.share_id.is_some()
                        && (spec.kind == "dsh" || (spec.kind == "http" && spec.port == 13911));
                    // clean-proxy 已退役（2026-11-09 viewer-port/设备域终态）：不再起本地
                    // 注入/代签代理，浏览器 URL 决策只剩两路：
                    //   · 设备域（MYCO_DEVICE_ORIGIN）→ device_origin_browser_url 干净地址；
                    //   · 其余 → entryUrl（含 mt）原样 + 本机设备断言 fragment（不回归）。
                    let entry_for_pick = target.url(local_port);
                    // 与 BrowserTarget::url 同款回落（闸在 browser_target）：非法 entryUrl → 根路径。
                    let fallback_url = |entry: &str| {
                        if validate_entry_url(entry, local_port).is_ok() {
                            entry.to_string()
                        } else {
                            format!("http://127.0.0.1:{local_port}/")
                        }
                    };
                    let base = if device_origin_now {
                        device_origin_browser_url(spec, local_port, &target)
                            .unwrap_or_else(|| entry_for_pick.clone())
                    } else {
                        fallback_url(&entry_for_pick)
                    };
                    // 2026-10-23 客户端设备断言：分享入口 URL 追加本机设备签名 fragment，
                    // 页面注入脚本把它带给网关 → 署名显示「实际打字设备」（验签失败回落旧行为）。
                    // 设备域/VNETP 交付身份的路径不追加 fragment（clean-proxy 时代同款口径）。
                    let url = if device_origin_now {
                        base
                    } else {
                        crate::dsh_share::with_client_assert(&base)
                    };
                    // 2026-10-23 展示用短地址：断言 fragment 很长，别塞进给人看的提示
                    let display_url = url.split('#').next().unwrap_or(&url).to_string();
                    if matches!(target, BrowserTarget::RootLegacy) {
                        env_trace!(
                            "env-open browser root-legacy local={local_port}（卡上无 entryUrl：根路径需已有该分享 cookie，否则 401；老卡向后兼容）"
                        );
                    }
                    if let Some(note) = target.fallback_note() {
                        env_trace!("env-open browser entry-rejected local={local_port}: {note}");
                    }
                    let hint = match target.fallback_note() {
                        Some(note) => format!("已在系统浏览器打开 {display_url}（{note}）"),
                        None => format!("已在系统浏览器打开 {display_url}"),
                    };
                    // 2026-10-25：声明的 entryUrl 不可用（端口改写也救不了——外域/坏
                    // scheme/非 /gw/ 路径）→ **不开浏览器**：裸根路径必 401「无凭证」，
                    // 开了只给用户一页死墙（同晚用户真案 + 「分享不在别拉浏览器」口径）。
                    if let BrowserTarget::RootFallback(why) = &target {
                        env_trace!("env-open browser entry-rejected local={local_port}: {why}（不打开浏览器）");
                        Launch {
                            started: false,
                            client: "browser".into(),
                            pid: None,
                            error: Some(why.clone()),
                            hint: Some(
                                "这张卡的入口地址不可用，已避免打开必失败的页面——请让对方重新发一张卡".into(),
                            ),
                        }
                    } else {
                        // 2026-10-25 验证面无副作用通道：MYCO_ENV_NO_LAUNCH=1 时只回
                        // 干净 URL 不拉系统浏览器（与 MYCO_RDP_NO_LAUNCH 同款语义；
                        // 独立复验反馈"实现方会拉起系统浏览器"——默认行为不变）。
                        if crate::dsh_share::env_browser_launch_suppressed() {
                            Launch {
                                started: false,
                                client: "browser".into(),
                                pid: None,
                                error: None,
                                hint: Some(format!(
                                    "MYCO_ENV_NO_LAUNCH=1 已置位：未打开系统浏览器，干净地址 {display_url}"
                                )),
                            }
                        } else {
                            match open_url(&url) {
                                Ok(()) => Launch {
                                    started: true,
                                    client: "browser".into(),
                                    pid: None,
                                    error: None,
                                    hint: Some(hint),
                                },
                                Err(e) => Launch { started: false, client: "browser".into(), pid: None, error: Some(e), hint: None },
                            }
                        }
                    }
                }
                "ssh" => Launch {
                    started: false,
                    client: "terminal".into(),
                    pid: None,
                    error: None,
                    hint: Some(format!("已就绪：终端里执行 ssh -p {local_port} <用户名>@127.0.0.1")),
                },
                "stereo" => Launch {
                    started: false,
                    client: String::new(),
                    pid: None,
                    error: None,
                    hint: Some(format!("已就绪：立体声服务在 {address}")),
                },
                "adb" => Launch {
                    started: false,
                    client: "adb".into(),
                    pid: None,
                    error: None,
                    hint: Some(format!("已就绪：adb -H 127.0.0.1 -P {local_port} devices")),
                },
                // 2026-11-01 自由远程桌面：vnc/rustdesk 不自动拉客户端（各平台客户端
                // 不统一且常无预装）——给"复制级"提示：地址 + 推荐客户端。
                "vnc" => Launch {
                    started: false,
                    client: "vnc-viewer".into(),
                    pid: None,
                    error: None,
                    hint: Some(format!(
                        "已就绪：VNC 客户端连接 {address}（Windows: TightVNC/RealVNC；手机: bVNC/RealVNC；Linux: Remmina）"
                    )),
                },
                "rustdesk" => {
                    // 2026-11-01 点卡全自动：本机装了 RustDesk → `--connect <addr>`
                    // 带参直连（参数数组不经 shell）；密码第一次手输一次、之后
                    // RustDesk 按对端记住。未装 / 启动失败 → 保持"复制级"提示。
                    match launch_rustdesk(&address) {
                        Ok(true) => Launch {
                            started: true,
                            client: "rustdesk".into(),
                            pid: None,
                            error: None,
                            hint: Some(format!("已用 RustDesk 直连 {address}（首次需输入对端 RustDesk 密码，之后自动记住）")),
                        },
                        _ => Launch {
                            started: false,
                            client: "rustdesk".into(),
                            pid: None,
                            error: None,
                            hint: Some(format!(
                                "已就绪：RustDesk 客户端在 ID/地址栏直接输入 {address} 连接（IP 直连模式，无需服务器；装好后点本卡可自动打开）"
                            )),
                        },
                    }
                }
                other => Launch {
                    started: false,
                    client: String::new(),
                    pid: None,
                    error: Some(format!("未知 kind {other}")),
                    hint: None,
                },
            }
        })
    }

    fn audit(&self, call: &EnvCall, state: EnvState, local_port: u16, client_started: bool, ms: u128) {
        write_audit(call, state, local_port, client_started, ms);
    }

    /// 端点租约簿记 → vnet_lease 状态机（task-vnet-endpoint-lease §7）。
    /// `Opened(port)` 冲突（租约期内换口/同源异口）→ Some(人话) 由 env_open_with 转 Error。
    fn lease_event(&self, call: &EnvCall, spec: &EnvSpec, ev: LeaseHook) -> Option<String> {
        let key = crate::vnet_lease::LeaseKey {
            consumer_device: crate::vnet_lease::self_consumer_device(),
            kind: spec.kind.clone(),
            device: spec.device.clone(),
            port: spec.port,
            share_id: call.card_id.clone(),
        };
        match ev {
            LeaseHook::Opened(p) => crate::vnet_lease::lease_open(&key, p).err(),
            LeaseHook::UpstreamOk => {
                crate::vnet_lease::lease_upstream_ok(&key);
                None
            }
            LeaseHook::UpstreamFail(r) => {
                crate::vnet_lease::lease_upstream_fail(&key, &r);
                None
            }
        }
    }
}

/// 生产入口（HTTP handler 与 Tauri 命令共用）。
#[cfg(feature = "gui")]
pub async fn env_open(body: &Value) -> Value {
    env_open_with(&RealRuntime, body).await
}

/// `POST /api/env/open {cardId?, taskId?, env:{kind,device,port,localPort,label?}, caps?, signature?, debug?}`
/// → `{ok, state, address, clientStarted, ms, ...}`；错误沿用 vnet 家族约定 `200 + ok:false`。
#[cfg(feature = "gui")]
pub async fn handle_env_open(Json(body): Json<Value>) -> axum::response::Response {
    use axum::response::IntoResponse;
    Json(env_open(&body).await).into_response()
}

/// Tauri 命令：PC 任务卡 env 行的「打开」（与 HTTP 面同一实现）。
///
/// 参数用**一个对象** `args` 承载（而不是十几个具名参数）：IPC 面与 HTTP body 同构，
/// 单测/脚本/HTTP 三处不会因为字段改名而漂移。
#[cfg(feature = "gui")]
#[tauri::command]
pub async fn vnet_env_open(args: Value) -> Result<Value, String> {
    Ok(env_open(&args).await)
}

// ═══════════════════════════════════════════════════════════════════════
// 单测（Rust：`cargo test -p myco-home --lib env_open` / `vnet_env::`）
// ═══════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};

    // ── 纯函数：默认口 / kind 白名单 / 解析 ──

    #[test]
    fn env_open_default_ports_match_design_table() {
        assert_eq!(default_local_port("rdp"), Some(23389));
        assert_eq!(default_local_port("dsh"), Some(23911));
        assert_eq!(default_local_port("ssh"), Some(2223));
        assert_eq!(default_local_port("stereo"), Some(29000));
        assert_eq!(default_local_port("adb"), Some(25037));
        assert_eq!(default_local_port("http"), Some(23912));
        // 2026-11-01 自由远程桌面：vnc / rustdesk（方案 §3.1 表）
        assert_eq!(default_local_port("vnc"), Some(23590));
        assert_eq!(default_local_port("rustdesk"), Some(23591));
        assert_eq!(default_local_port("nope"), None);
        assert_eq!(default_target_port("rdp"), Some(3389));
        assert_eq!(default_target_port("dsh"), Some(13911));
        assert_eq!(default_target_port("ssh"), Some(22));
        assert_eq!(default_target_port("adb"), Some(5037));
        assert_eq!(default_target_port("vnc"), Some(5900));
        assert_eq!(default_target_port("rustdesk"), Some(21118));
        assert!(is_known_kind("vnc")); // 2026-11-01 起入白名单
        assert!(is_known_kind("rustdesk"));
        assert!(!is_known_kind("nope"));
        assert!(is_known_kind("rdp"));
    }

    /// 2026-11-01 vnc：RFB 问候探测（服务器先说话 "RFB 003.008\n"）；
    /// 非 RFB 首字节（如 HTTP）必须判 no-service（TCP 通 ≠ 服务对）。
    #[test]
    fn vnc_probe_expects_rfb_greeting() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let srv = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = srv.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = srv.accept().unwrap();
            s.write_all(b"RFB 003.008\n").unwrap();
            let _ = s.shutdown(std::net::Shutdown::Write);
        });
        assert!(probe_blocking(port, "vnc", Duration::from_millis(800)));

        let srv2 = TcpListener::bind("127.0.0.1:0").unwrap();
        let port2 = srv2.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = srv2.accept().unwrap();
            s.write_all(b"HTTP/1.1 200 OK\r\n\r\n").unwrap();
            let mut buf = [0u8; 16];
            let _ = s.read(&mut buf);
        });
        assert!(!probe_blocking(port2, "vnc", Duration::from_millis(800)), "HTTP 服务不是 VNC，必须 no-service");
    }

    /// 2026-11-01 rustdesk：无稳定握手，TCP 通即认（与 stereo/adb 同档）。
    #[test]
    fn rustdesk_probe_tcp_only() {
        use std::net::TcpListener;
        let srv = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = srv.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (_s, _) = srv.accept().unwrap();
            std::thread::sleep(Duration::from_millis(300));
        });
        assert!(probe_blocking(port, "rustdesk", Duration::from_millis(800)));
    }

    #[test]
    fn state_vocabulary_is_five_states_plus_local_error() {
        // 词表锁定（UI 的 state 文案表按这些键写死）
        let all = [
            EnvState::Ready,
            EnvState::Building,
            EnvState::Offline,
            EnvState::NoService,
            EnvState::Denied,
            EnvState::Error,
        ];
        let words: Vec<&str> = all.iter().map(|s| s.as_str()).collect();
        assert_eq!(words, vec!["ready", "building", "offline", "no-service", "denied", "error"]);
        // ok 只对 ready 为真——"不误报成功"的词表级保证
        assert!(EnvState::Ready.ok());
        for s in [
            EnvState::Building,
            EnvState::Offline,
            EnvState::NoService,
            EnvState::Denied,
            EnvState::Error,
        ] {
            assert!(!s.ok(), "{} 不该 ok", s.as_str());
        }
    }

    #[test]
    fn parse_uses_card_env_defaults_and_camel_case() {
        let call = parse_call(&json!({
            "cardId": "sh-9", "taskId": "t-9",
            "caps": ["vnet.forward"],
            "env": { "kind": "rdp", "device": "did:myco:zABC" }
        }));
        let spec = call.spec.expect("caps 合法 + kind/device 合法 → 可执行");
        assert_eq!(spec.port, 3389);
        assert_eq!(spec.local_port, 23389);
        assert!(!spec.local_port_explicit, "卡上没给 localPort → 默认口");
        assert_eq!(call.card_id, "sh-9");
        assert_eq!(call.task_id, "t-9");
        assert!(call.caps_declared);
        assert!(!call.debug);
    }

    #[test]
    fn parse_marks_explicit_local_port() {
        let call = parse_call(&json!({
            "caps": ["vnet.forward"],
            "env": { "kind": "rdp", "device": "did:myco:zA", "localPort": 23389 }
        }));
        let spec = call.spec.expect("合法");
        assert!(spec.local_port_explicit, "显式 localPort 必须留痕（冲突文案要区分）");
        // kind=http 不给 localPort → 默认 23912（冲突时文案说"默认口被占"）
        let http = parse_call(&json!({
            "caps": ["vnet.forward"],
            "env": { "kind": "http", "device": "did:myco:zA", "port": 13911 }
        }));
        let h = http.spec.expect("http 合法");
        assert_eq!(h.local_port, 23912);
        assert!(!h.local_port_explicit);
    }

    #[test]
    fn parse_reads_env_nested_in_card() {
        let call = parse_call(&json!({
            "card": { "id": "sh-7", "caps": ["vnet.forward"],
                      "env": { "kind": "dsh", "device": "did:myco:zPC", "port": 13911 } }
        }));
        assert_eq!(call.card_id, "sh-7");
        let spec = call.spec.expect("嵌 card 的形态也要认");
        assert_eq!(spec.kind, "dsh");
        assert_eq!(spec.local_port, 23911);
    }

    /// 分享入口 URL（2026-10-23 现场修复）：`entryUrl` 是可选字段，老卡缺它 → None
    /// （根路径行为逐字节不变）；camelCase 为主契约，蛇形别名兼容脚本。
    #[test]
    fn parse_reads_optional_entry_url() {
        let entry = "http://127.0.0.1:23911/gw/sh-pc-env-dsh/?mt=abc";
        let call = parse_call(&json!({
            "caps": ["vnet.forward"],
            "env": { "kind": "dsh", "device": "did:myco:zPC", "port": 13911,
                     "localPort": 23911, "entryUrl": entry }
        }));
        assert_eq!(call.spec.expect("合法").entry_url.as_deref(), Some(entry));
        // 老卡：没有该字段 → 根路径（向后兼容）
        let old = parse_call(&json!({
            "caps": ["vnet.forward"],
            "env": { "kind": "dsh", "device": "did:myco:zPC" }
        }));
        assert_eq!(old.spec.expect("合法").entry_url, None, "老卡不得被凭空补 entryUrl");
        // 蛇形别名（eval 脚本常这么写）
        let snake = parse_call(&json!({
            "caps": ["vnet.forward"],
            "env": { "kind": "dsh", "device": "did:myco:zPC",
                     "entry_url": "http://127.0.0.1:23911/gw/x/?mt=y" }
        }));
        assert!(snake.spec.expect("合法").entry_url.is_some());
    }

    /// 新架构（remote 无 mt/cookie）：无 entryUrl 的分享卡也要能拿到分享身份，
    /// 由 clean 断言代理现签（浏览器只拿简版地址）。
    #[test]
    fn parse_derives_share_id_from_card_or_entry() {
        // 卡身份 = shareId（sh- 前缀）→ 取到
        let call = parse_call(&json!({
            "cardId": "sh-pc-env-dsh",
            "caps": ["vnet.forward"],
            "env": { "kind": "dsh", "device": "did:myco:zPC", "port": 13911, "localPort": 23911 }
        }));
        assert_eq!(call.spec.expect("合法").share_id.as_deref(), Some("sh-pc-env-dsh"));
        // entryUrl 里的 shareId 优先于卡身份
        let call2 = parse_call(&json!({
            "cardId": "task-1",
            "caps": ["vnet.forward"],
            "env": { "kind": "dsh", "device": "did:myco:zPC",
                     "entryUrl": "http://127.0.0.1:23911/gw/sh-from-entry/?mt=t" }
        }));
        assert_eq!(call2.spec.expect("合法").share_id.as_deref(), Some("sh-from-entry"));
        // 非分享卡（cardId 不是 sh-）→ None（回落老行为）
        let call3 = parse_call(&json!({
            "cardId": "task-2",
            "caps": ["vnet.forward"],
            "env": { "kind": "dsh", "device": "did:myco:zPC" }
        }));
        assert_eq!(call3.spec.expect("合法").share_id, None);
    }

    /// 2026-10-25 真案（笔记本二击 401「无凭证」）：隧道重建瞬间约定口被半死旧监听
    /// 占用 → 建链拿到随机口 → entryUrl 端口校验败 → 旧逻辑裸开根路径 = 401。
    /// 修：`/gw/` 入口端口改写后必须判 Entry（mt 原样保留）。
    #[test]
    fn parse_short_share_alias_keeps_real_card_share_id() {
        let call = parse_call(&json!({
            "cardId": "sh-real-from-card",
            "caps": ["vnet.forward"],
            "env": { "kind": "dsh", "device": "did:myco:zShortAlias",
                     "entryUrl": "http://dev-abcd1234.localhost:24011/dsh/" }
        }));
        assert_eq!(call.spec.expect("合法").share_id.as_deref(), Some("sh-real-from-card"));
        assert_eq!(extract_share_id("http://dev-abcd1234.localhost:24011/dsh/").as_deref(), Some("dsh"));
    }

    #[test]
    #[ignore = "pre-existing/unstable in source baseline, tracked internally"]
    fn device_origin_browser_url_matches_card_and_rejects_coordinate_substitution() {
        let _g = crate::test_env_lock::test_env_lock();
        let mut spec = spec_for("did:myco:browserOrigin90ab", 13911, 24011);
        spec.kind = "dsh".into();
        spec.share_id = Some("sh-browser-real".into());
        let base = crate::dsh_share::device_origin_url(24011, &spec.device, "sh-browser-real")
            .expect("设备域 URL");
        assert!(base.contains(".localhost:24011/dsh/"), "{base}");
        let entry = base.clone();
        assert!(!entry.contains('?') && !entry.contains('#'));
        spec.entry_url = Some(entry.clone());
        let target = browser_target_mode(&spec, 24011, true);
        assert!(matches!(target, BrowserTarget::Entry(_)));
        assert_eq!(device_origin_browser_url(&spec, 24011, &target).as_deref(), Some(entry.as_str()), "env_open 实际启动 URL 与 entryUrl 同版同值");
        let overridden = rewrite_entry_port(&entry, 25011).expect("viewer 自定义口改写");
        spec.entry_url = Some(overridden.clone());
        let override_target = browser_target_mode(&spec, 25011, true);
        assert!(matches!(override_target, BrowserTarget::Entry(_)));
        assert_eq!(device_origin_browser_url(&spec, 25011, &override_target).as_deref(), Some(overridden.as_str()));
        spec.entry_url = None;
        let legacy = browser_target_mode(&spec, 24011, true);
        assert_eq!(device_origin_browser_url(&spec, 24011, &legacy).as_deref(), Some(base.as_str()), "无 entryUrl 也生成同形干净 URL");
        for bad in [
            base.replace(".localhost", ".evil"),
            base.replace(":24011", ":24012"),
            base.replace("/dsh/", "/dsh-2/"),
            base.replace("http://", "https://"),
            base.replace("http://", "http://user@"),
            format!("{base}extra"),
            format!("{base}?mt=abc"),
            format!("{base}#mycoClient=assert"),
        ] {
            spec.entry_url = Some(bad.clone());
            let target = browser_target_mode(&spec, 24011, true);
            assert!(matches!(target, BrowserTarget::RootFallback(_)), "必须拒绝: {bad}");
            assert!(device_origin_browser_url(&spec, 24011, &target).is_none());
        }
    }

    /// 2026-11-10 笔记本空卡真案：别名规则升级/两端设备名缓存分叉后，卡上 entryUrl
    /// 的主机别名与本 viewer 持久表的现行别名不同。只放行「主机别名漂移」，治愈为
    /// canonical 纯设备域地址（由本卡 device+shareId 现算，无凭空放行面）；端口/
    /// 分享路径/query/外域任何其他差异仍拒绝。
    #[test]
    #[ignore = "pre-existing/unstable in source baseline, tracked internally"]
    fn device_origin_stale_card_alias_heals_to_canonical_url() {
        let _g = crate::test_env_lock::test_env_lock();
        let did = "did:myco:staleCardHeal90";
        let mut spec = spec_for(did, 13911, 24011);
        spec.kind = "dsh".into();
        spec.share_id = Some("sh-stale-real".into());
        let base = crate::dsh_share::device_origin_url(24011, did, "sh-stale-real").expect("canonical");
        let port_path = base.split_once(".localhost").expect("含 .localhost").1; // ":24011/dsh/"
        let stale = format!("http://fresh-pc-name.localhost{port_path}");
        spec.entry_url = Some(stale);
        let target = browser_target_mode(&spec, 24011, true);
        match &target {
            BrowserTarget::Entry(u) => assert_eq!(u, &base, "别名漂移治愈为 canonical 纯设备域地址"),
            other => panic!("必须 Entry（治愈）: {other:?}"),
        }
        assert_eq!(device_origin_browser_url(&spec, 24011, &target).as_deref(), Some(base.as_str()));
        for bad in [
            "http://fresh.localhost:24011/dsh-2/",
            "http://fresh.localhost:24012/dsh/",
            "http://fresh.localhost:24011/dsh/?mt=x",
            "http://fresh.localhost:24011/gw/sh-stale-real/",
            "http://fresh.localhost.evil:24011/dsh/",
        ] {
            spec.entry_url = Some(bad.into());
            assert!(
                matches!(browser_target_mode(&spec, 24011, true), BrowserTarget::RootFallback(_)),
                "必须拒绝: {bad}"
            );
        }
    }

    #[test]
    fn entry_url_port_rewrite_heals_rebuilt_tunnel() {
        // 端口不匹配 → 改写（path+query 原样）
        assert_eq!(
            rewrite_entry_port("http://127.0.0.1:23911/gw/sh-1/?mt=abc", 41234),
            Some("http://127.0.0.1:41234/gw/sh-1/?mt=abc".to_string())
        );
        // 端口一致 → 不需要改写
        assert_eq!(rewrite_entry_port("http://127.0.0.1:23911/gw/sh-1/?mt=abc", 23911), None);
        // 外域 / 非 /gw/ 路径 / 畸形 → 一律不改写（保留原校验语义，防绕）
        assert_eq!(rewrite_entry_port("http://evil.com:1/gw/sh-1/?mt=abc", 23911), None);
        assert_eq!(rewrite_entry_port("http://127.0.0.1:1/other/?mt=abc", 23911), None);
        assert_eq!(rewrite_entry_port("not-a-url", 23911), None);
        // 设备域：旧卡 23911 → 独立 viewer 24011；mt/路径原样，外域/错路径仍拒绝。
        assert_eq!(
            rewrite_entry_port("http://myco-abcd1234.localhost:23911/dsh/", 24011),
            Some("http://myco-abcd1234.localhost:24011/dsh/".into())
        );
        assert_eq!(rewrite_entry_port("http://myco-abcd1234.localhost:24011/dsh/", 24011), None);
        assert_eq!(rewrite_entry_port("http://evil.example:23911/dsh/", 24011), None);
        assert_eq!(rewrite_entry_port("http://myco-abcd1234.localhost:23911/gw/sh-1/", 24011), None);
        // 改写后 browser_target 必须判 Entry（整链：mt 到得了网关）
        let spec = EnvSpec {
            kind: "dsh".into(), device: "d".into(), port: 13911, local_port: 41234,
            local_port_explicit: false, label: None,
            entry_url: Some("http://127.0.0.1:23911/gw/sh-1/?mt=abc".into()),
            share_id: Some("sh-1".into()),
        };
        let rewritten = rewrite_entry_port(spec.entry_url.as_deref().unwrap(), spec.local_port)
            .expect("必须可改写");
        let mut s2 = spec.clone();
        s2.entry_url = Some(rewritten);
        assert!(matches!(browser_target(&s2, 41234), BrowserTarget::Entry(_)));
    }

    /// 入口 URL 校验：只认 `http://127.0.0.1:<localPort>/…`。
    /// 卡可跨设备投递 → 放行任意 URL 等于把系统浏览器交给伪造卡（钓鱼/打本机别的口）。
    #[test]
    fn entry_url_validation_is_loopback_and_port_bound() {
        assert!(validate_entry_url("http://127.0.0.1:23911/gw/sh-1/?mt=abc", 23911).is_ok());
        for bad in [
            "https://127.0.0.1:23911/gw/sh-1/?mt=abc",
            "http://localhost:23911/gw/sh-1/?mt=abc",
            "http://127.0.0.1:23912/gw/sh-1/?mt=abc",
            "http://127.0.0.1:23911@evil.example/gw/sh-1/",
            "http://127.0.0.1:239110/gw/sh-1/",
            "http://127.0.0.1:23911.evil.example/gw/sh-1/",
            "http://10.0.0.1:23911/gw/sh-1/",
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "http://127.0.0.1:23911/a b",
        ] {
            assert!(validate_entry_url(bad, 23911).is_err(), "必须拒绝: {bad}");
        }
    }

    /// 目标选择：有 `entryUrl` → 目标=entryUrl；无 → 根路径；非法 → **拒绝并回落**根路径。
    #[test]
    fn browser_target_prefers_valid_entry_url_and_falls_back() {
        let mut spec = spec_for("did:myco:zPC", 13911, 23911);
        spec.kind = "dsh".into();
        // ① 无 entryUrl（老卡）→ 根路径（与改造前逐字节一致）
        assert_eq!(browser_target(&spec, 23911), BrowserTarget::RootLegacy);
        assert_eq!(browser_target(&spec, 23911).url(23911), "http://127.0.0.1:23911/");
        // ② 合法 entryUrl → 目标就是它（不拼根路径）
        let entry = "http://127.0.0.1:23911/gw/sh-pc-env-dsh/?mt=abc";
        spec.entry_url = Some(entry.into());
        let t = browser_target(&spec, 23911);
        assert!(t.uses_entry());
        assert_eq!(t.url(23911), entry);
        assert_eq!(t.fallback_note(), None, "合法入口不该带告警");
        // ③ 非法 entryUrl → 绝不采用（不打开），回落根路径 + 留原因
        for bad in [
            "https://evil.example/dsh",
            "http://127.0.0.1:23912/",
            "http://10.0.0.1:23911/",
            "http://127.0.0.1:23911@evil.example/",
            "javascript:alert(1)",
        ] {
            spec.entry_url = Some(bad.into());
            let t = browser_target(&spec, 23911);
            assert!(!t.uses_entry(), "非法 entryUrl 绝不能被采用: {bad}");
            assert_eq!(t.url(23911), "http://127.0.0.1:23911/", "必须回落根路径: {bad}");
            assert!(t.fallback_note().unwrap_or("").contains("entryUrl"), "{bad}");
        }
    }

    #[test]
    fn parse_denied_when_caps_missing_and_not_debug() {
        let call = parse_call(&json!({ "env": { "kind": "rdp", "device": "did:myco:zA" } }));
        assert!(call.spec.is_none());
        assert!(call.denial.unwrap().contains("caps"));
        // 显式本机调试（debug:true 且无 cardId）才放行
        let dbg = parse_call(&json!({ "debug": true, "env": { "kind": "rdp", "device": "did:myco:zA" } }));
        assert!(dbg.spec.is_some(), "debug:true + 无 cardId 允许本机调试");
        assert!(dbg.debug);
        // 带 cardId 的卡不能靠 debug 洗白
        let fake = parse_call(&json!({ "debug": true, "cardId": "sh-x", "env": { "kind": "rdp", "device": "did:myco:zA" } }));
        assert!(fake.spec.is_none());
    }

    #[test]
    fn parse_denied_on_bad_signature_and_bad_local_port() {
        let bad_sig = parse_call(&json!({
            "caps": ["vnet.forward"], "signature": "short",
            "env": { "kind": "rdp", "device": "did:myco:zA" }
        }));
        assert!(bad_sig.denial.unwrap().contains("签名"));
        let reserved = parse_call(&json!({
            "caps": ["vnet.forward"],
            "env": { "kind": "rdp", "device": "did:myco:zA", "localPort": 13911 }
        }));
        assert!(reserved.denial.unwrap().contains("保留口"));
        let viewer_port = parse_call(&json!({
            "caps": ["vnet.forward"],
            "env": { "kind": "dsh", "device": "did:myco:zA", "localPort": 24011 }
        }));
        assert!(viewer_port.denial.unwrap().contains("保留口"), "24011 是全局 viewer 专用口，raw 卡不得抢占");
        // 2026-11-01：vnc 已入白名单——非法 kind 的例子换 telnet
        let bad_kind = parse_call(&json!({
            "caps": ["vnet.forward"],
            "env": { "kind": "telnet", "device": "did:myco:zA" }
        }));
        assert!(bad_kind.denial.unwrap().contains("kind"));
        // vnc/rustdesk 现在是合法 kind（有默认口，spec 应构造成功）
        let ok_vnc = parse_call(&json!({
            "caps": ["vnet.forward"],
            "env": { "kind": "vnc", "device": "did:myco:zA" }
        }));
        assert!(ok_vnc.spec.is_some(), "vnc 入白名单且有默认口");
        let ok_rust = parse_call(&json!({
            "caps": ["vnet.forward"],
            "env": { "kind": "rustdesk", "device": "did:myco:zA" }
        }));
        assert!(ok_rust.spec.is_some(), "rustdesk 入白名单且有默认口");
        // vnc 目标口语义闸：5900-5999 之外拒绝（RFB 探测依赖）
        let bad_vnc_port = parse_call(&json!({
            "caps": ["vnet.forward"],
            "env": { "kind": "vnc", "device": "did:myco:zA", "port": 8080 }
        }));
        assert!(bad_vnc_port.denial.unwrap().contains("5900-5999"));
    }

    // ── presence 判定核（替身计数：命中短路；未知≠离线）──

    #[derive(Default)]
    struct ProbeCalls {
        self_did: AtomicU32,
        tunnel: AtomicU32,
        roster: AtomicU32,
    }

    struct FakeProbe {
        self_did: Option<String>,
        tunnel: Option<u16>,
        roster: RosterState,
        calls: Arc<ProbeCalls>,
    }

    impl FakeProbe {
        fn new(self_did: Option<&str>, tunnel: Option<u16>, roster: RosterState) -> (Self, Arc<ProbeCalls>) {
            let calls = Arc::new(ProbeCalls::default());
            (
                Self {
                    self_did: self_did.map(String::from),
                    tunnel,
                    roster,
                    calls: calls.clone(),
                },
                calls,
            )
        }
    }

    impl PresenceProbe for FakeProbe {
        fn self_did(&self) -> Option<String> {
            self.calls.self_did.fetch_add(1, Ordering::SeqCst);
            self.self_did.clone()
        }
        fn tunnel_local_port(&self, _device: &str, _port: u16) -> Option<u16> {
            self.calls.tunnel.fetch_add(1, Ordering::SeqCst);
            self.tunnel
        }
        fn roster<'a>(&'a self, _device: &'a str) -> BoxFut<'a, RosterState> {
            self.calls.roster.fetch_add(1, Ordering::SeqCst);
            let r = self.roster;
            Box::pin(async move { r })
        }
    }

    fn spec_for(device: &str, port: u16, local_port: u16) -> EnvSpec {
        EnvSpec {
            kind: "rdp".into(),
            device: device.into(),
            port,
            local_port,
            local_port_explicit: true,
            label: None,
            entry_url: None,
            share_id: None,
        }
    }

    // ── RustDesk 点卡全自动（2026-11-01）：发现/开关/启动臂 ──

    /// 环境变量类用例的串行锁（cargo test 并行跑，env 是进程级全局）。
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn spec_rustdesk(local_port: u16) -> EnvSpec {
        EnvSpec {
            kind: "rustdesk".into(),
            device: "did:myco:zPEER".into(),
            port: 21118,
            local_port,
            local_port_explicit: true,
            label: None,
            entry_url: None,
            share_id: None,
        }
    }

    /// 发现纪律：显式覆盖优先且**给错就 fail-closed**（不猜 PATH）；无覆盖才认安装位/PATH。
    #[test]
    fn rustdesk_exe_discovery_override_wins_and_fails_closed() {
        let dir = std::env::temp_dir().join("myco-rustdesk-discovery-test");
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("rustdesk.exe");
        std::fs::write(&exe, b"fake").unwrap();
        // 覆盖存在 → 直接用（即便 PATH 也给了）
        assert_eq!(
            find_rustdesk_exe(Some(exe.to_str().unwrap()), Some("C:\\Windows\\System32\\cmd.exe")),
            Some(exe.clone())
        );
        // 覆盖不存在 → None（fail-closed：绝不回落到猜出来的路径）
        assert_eq!(
            find_rustdesk_exe(Some(r"C:\no\such\rustdesk.exe"), Some("C:\\Windows\\System32\\cmd.exe")),
            None
        );
        // 无覆盖 + PATH 命中真实文件 → 用 PATH（仅 Windows 上 cmd.exe 存在）
        if cfg!(windows) {
            assert!(find_rustdesk_exe(None, Some("C:\\Windows\\System32\\cmd.exe")).is_some());
        }
    }

    /// MYCO_RUSTDESK_NO_LAUNCH=1 → 不拉客户端，回落"复制级"提示（验证/CI 不弹窗）。
    #[tokio::test]
    async fn rustdesk_launch_suppressed_env_falls_back_to_hint() {
        let _g = ENV_LOCK.lock().unwrap();
        std::env::set_var("MYCO_RUSTDESK_NO_LAUNCH", "1");
        std::env::remove_var("MYCO_RUSTDESK_EXE");
        let l = RealRuntime.launch(&spec_rustdesk(23591), 23591, false).await;
        std::env::remove_var("MYCO_RUSTDESK_NO_LAUNCH");
        assert!(!l.started);
        assert_eq!(l.client, "rustdesk");
        assert!(l.error.is_none());
        assert!(l.hint.as_deref().unwrap_or("").contains("已就绪"), "hint={:?}", l.hint);
    }

    /// 装了 RustDesk（覆盖路径指到真实可执行文件）→ started=true、零输入直连。
    /// Windows 用 cmd.exe 当替身（带 `--connect` 参数即退，无副作用）。
    #[cfg(all(test, windows))]
    #[tokio::test]
    async fn rustdesk_launch_arm_connects_zero_input() {
        let _g = ENV_LOCK.lock().unwrap();
        std::env::remove_var("MYCO_RUSTDESK_NO_LAUNCH");
        std::env::set_var("MYCO_RUSTDESK_EXE", r"C:\Windows\System32\cmd.exe");
        let l = RealRuntime.launch(&spec_rustdesk(23591), 23591, false).await;
        std::env::remove_var("MYCO_RUSTDESK_EXE");
        assert!(l.started, "err={:?} hint={:?}", l.error, l.hint);
        assert_eq!(l.client, "rustdesk");
        assert!(l.hint.as_deref().unwrap_or("").contains("已用 RustDesk 直连"));
    }

    /// 2026-11-01 重启窗口回归：约定口（preferred 在册）被占但 TUNNELS/归属查不到
    /// （= keeper 恢复窗口）→ **必须复用**，不许报"端口被占"（真机：0.3.196 安装后
    /// 首次点卡必红）。本地 listener 可连，走的是 ReuseListener 分支；
    /// "被占但连不上"（ReuseClaimedPort）由矩阵测试覆盖。
    #[tokio::test]
    async fn ensure_forward_reuses_claimed_port_held_during_restart_window() {
        let dev = "did:myco:zTESTRW";
        let hold = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = hold.local_addr().unwrap().port();
        crate::p2p_tunnel::set_preferred_local(dev, 3389, Some(port));
        let spec = EnvSpec {
            kind: "rdp".into(),
            device: dev.into(),
            port: 3389,
            local_port: port,
            local_port_explicit: true,
            label: None,
            entry_url: None,
            share_id: None,
        };
        let r = RealRuntime.ensure_forward(&spec).await;
        crate::p2p_tunnel::set_preferred_local(dev, 3389, None);
        let ok = matches!(&r, Ok((p, how)) if *p == port && how.starts_with("reused-"));
        assert!(ok, "重启窗口必须复用约定口: {r:?}");
        drop(hold);
    }

    /// 矩阵：三态判定的全部组合（ReuseClaimedPort 分支 = 重启窗口"被占但连不上"，
    /// 无法用本地 listener 真实模拟，纯函数钉死行为）。
    #[test]
    fn port_claim_decision_matrix() {
        use PortClaimDecision::*;
        // claimed（约定在册）三种：活监听复用 / 被占复用（新修复）/ 空闲正常建链
        assert_eq!(decide_port_claim(true, true, true), ReuseListener);
        assert_eq!(decide_port_claim(true, false, false), ReuseClaimedPort);
        assert_eq!(decide_port_claim(true, false, true), ProceedBind);
        // 无约定（svchost 抢占类）：被占必须报错，不许静默借道
        assert_eq!(decide_port_claim(false, true, false), ErrOccupied);
        assert_eq!(decide_port_claim(false, false, false), ErrOccupied);
        assert_eq!(decide_port_claim(false, false, true), ProceedBind);
        assert_eq!(decide_port_claim(false, true, true), ProceedBind);
        // claimed 且能连：不可能同时 bind_ok=false（内核语义），防御性不依赖
    }

    /// 防御不回退：口被占且**无**约定（preferred/租约都不在册）→ 仍必须报人话错误
    /// （2026-10-25 svchost 抢占 23911 真案的防线，不能被上面的复用放行冲掉）。
    #[tokio::test]
    async fn ensure_forward_unclaimed_occupied_port_still_errors() {
        let dev = "did:myco:zTESTUNCLAIMED";
        let hold = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = hold.local_addr().unwrap().port();
        let spec = EnvSpec {
            kind: "rdp".into(),
            device: dev.into(),
            port: 3389,
            local_port: port,
            local_port_explicit: true,
            label: None,
            entry_url: None,
            share_id: None,
        };
        let r = RealRuntime.ensure_forward(&spec).await;
        drop(hold);
        assert!(r.is_err(), "无约定的外来占用必须报错: {r:?}");
        assert!(r.unwrap_err().contains("绑定失败"), "错误必须是绑定失败人话");
    }

    /// 单测专用的「确定没人在听」本地口：bind :0 拿临时口后立刻释放。
    ///
    /// 2026-10-25 真机撞上的测试隔离缺陷：`resolve_presence` 的孤儿-listener 兜底
    /// （2026-10-23 加入）会真连 `127.0.0.1:<local_port>`；固定用 23389 时，只要
    /// 本机生产 myco 正挂着 RDP 转发监听，`presence_roster_unavailable_is_unknown_not_offline`
    /// 就被真机状态污染成 Online（期望 Unknown）——测试在"跑着 myco 的机器"上必挂。
    /// 名册路径的用例一律换闭口，单测不再依赖宿主机端口占用态。
    fn closed_local_port() -> u16 {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind 127.0.0.1:0");
        let p = l.local_addr().expect("local addr").port();
        drop(l);
        p
    }

    /// 自连（目标 DID == 本机 DID）→ SelfTarget，且**不查隧道、不查名册**。
    #[tokio::test]
    async fn presence_self_did_hit_is_self_target_without_roster() {
        let (probe, calls) = FakeProbe::new(
            Some("did:myco:zSELF"),
            Some(23389), // 就算隧道也在，自连必须优先判成 SelfTarget
            RosterState::Unavailable,
        );
        let p = resolve_presence(&probe, &spec_for("did:myco:zSELF", 3389, 23389)).await;
        assert_eq!(p, Presence::SelfTarget);
        assert_eq!(calls.tunnel.load(Ordering::SeqCst), 0, "自连命中后不必查隧道");
        assert_eq!(calls.roster.load(Ordering::SeqCst), 0, "自连命中后绝不许查名册");
    }

    /// 活隧道命中 → Online，且**不查名册**（R25 快路径 + 名册不可用也不影响）。
    #[tokio::test]
    async fn presence_tunnel_hit_is_online_without_roster() {
        let (probe, calls) = FakeProbe::new(Some("did:myco:zOTHER"), Some(23389), RosterState::Unavailable);
        let p = resolve_presence(&probe, &spec_for("did:myco:zPEER", 3389, 23389)).await;
        assert_eq!(p, Presence::Online);
        assert_eq!(calls.roster.load(Ordering::SeqCst), 0, "隧道已命中，名册一次都不许查");
    }

    /// 名册查不了 → Unknown（**不是 Offline**）；查到了但没有 → Offline。
    /// local_port 用闭口：这条用例必须走到名册层，不能被本机真实 listener 抢答
    /// （见 `closed_local_port` 注释——2026-10-25 在跑着生产 myco 的机器上必挂）。
    #[tokio::test]
    async fn presence_roster_unavailable_is_unknown_not_offline() {
        let (probe, _) = FakeProbe::new(Some("did:myco:zSELF"), None, RosterState::Unavailable);
        let p = resolve_presence(&probe, &spec_for("did:myco:zPEER", 3389, closed_local_port())).await;
        assert_eq!(p, Presence::Unknown, "名册失败只能算未知，不许判离线");

        let (probe, _) = FakeProbe::new(Some("did:myco:zSELF"), None, RosterState::Absent);
        let p = resolve_presence(&probe, &spec_for("did:myco:zPEER", 3389, closed_local_port())).await;
        assert_eq!(p, Presence::Offline, "名册查成功且没有该设备，才是离线");
    }

    /// 名册里有该设备（哪怕没上报 addrs）→ Online。
    #[tokio::test]
    async fn presence_roster_row_without_addrs_is_online() {
        let (probe, _) = FakeProbe::new(Some("did:myco:zSELF"), None, RosterState::Online);
        let p = resolve_presence(&probe, &spec_for("did:myco:zPEER", 3389, closed_local_port())).await;
        assert_eq!(p, Presence::Online);
    }

    // ── 状态机（MockRuntime：离线 / 无服务 / 无权限 / 就绪 / 本机错误）──

    #[derive(Default)]
    struct Counters {
        presence: AtomicU32,
        forward: AtomicU32,
        probe: AtomicU32,
        launch: AtomicU32,
        /// 内存审计（验"审计带 card/task/kind/device/port"这条契约，不写真机文件）
        audits: Mutex<Vec<Value>>,
    }

    struct MockRuntime {
        presence: Presence,
        forward: Result<(u16, String), String>,
        probe: bool,
        launch: Launch,
        /// 租约专项测试：Opened/健康事件委托真实 vnet_lease；其余测试保持 no-op。
        use_real_lease: bool,
        c: Arc<Counters>,
    }

    impl EnvRuntime for MockRuntime {
        fn presence<'a>(&'a self, _spec: &'a EnvSpec) -> BoxFut<'a, Presence> {
            self.c.presence.fetch_add(1, Ordering::SeqCst);
            let p = self.presence;
            Box::pin(async move { p })
        }
        fn ensure_forward<'a>(&'a self, _spec: &'a EnvSpec) -> BoxFut<'a, Result<(u16, String), String>> {
            self.c.forward.fetch_add(1, Ordering::SeqCst);
            let r = self.forward.clone();
            Box::pin(async move { r })
        }
        fn probe<'a>(&'a self, _spec: &'a EnvSpec, _l: u16) -> BoxFut<'a, bool> {
            self.c.probe.fetch_add(1, Ordering::SeqCst);
            let v = self.probe;
            Box::pin(async move { v })
        }
        fn launch<'a>(&'a self, _spec: &'a EnvSpec, _l: u16, self_target: bool) -> BoxFut<'a, Launch> {
            self.c.launch.fetch_add(1, Ordering::SeqCst);
            let mut l = self.launch.clone();
            // 与 RealRuntime 同契约：self_target 时"调用到了 launch，但不许启动客户端"
            if self_target {
                l.started = false;
                l.client = String::new();
                l.pid = None;
                l.hint = Some("这是本机（服务端）".into());
            }
            if self.use_real_lease {
                let target = browser_target_mode(_spec, _l, true);
                l.hint = Some(
                    device_origin_browser_url(_spec, _l, &target)
                        .expect("租约专项卡必须生成新设备域 URL"),
                );
                l.client = "browser".into();
            }
            Box::pin(async move { l })
        }
        fn audit(&self, call: &EnvCall, state: EnvState, local_port: u16, client_started: bool, ms: u128) {
            self.c.audits.lock().unwrap().push(json!({
                "ev": "env-open",
                "card": call.card_id,
                "task": call.task_id,
                "kind": call.kind,
                "device": call.device,
                "port": call.port,
                "local": local_port,
                "state": state.as_str(),
                "clientStarted": client_started,
                "ms": ms,
            }));
        }
        fn lease_event(&self, call: &EnvCall, spec: &EnvSpec, ev: LeaseHook) -> Option<String> {
            if self.use_real_lease {
                RealRuntime.lease_event(call, spec, ev)
            } else {
                None
            }
        }
    }

    fn mock(presence: Presence, forward_ok: bool, probe: bool) -> (MockRuntime, Arc<Counters>) {
        let c = Arc::new(Counters::default());
        (
            MockRuntime {
                presence,
                forward: if forward_ok { Ok((23389, "opened".into())) } else { Err("目标设备不在线或未上报直连地址".into()) },
                probe,
                launch: Launch { started: true, client: "mstsc".into(), pid: Some(4242), error: None, hint: None },
                use_real_lease: false,
                c: c.clone(),
            },
            c,
        )
    }

    fn body(caps: Value) -> Value {
        json!({
            "cardId": "sh-v20", "taskId": "task-v20",
            "caps": caps,
            "env": { "kind": "rdp", "device": "did:myco:z6MkPC", "port": 3389, "localPort": 23389 }
        })
    }

    /// R26 / V20.3：presence 离线 → state=offline 且**不建链、不启动客户端**。
    #[tokio::test]
    async fn env_open_offline_never_builds_or_launches() {
        let (rt, c) = mock(Presence::Offline, true, true);
        let out = env_open_with(&rt, &body(json!(["vnet.forward"]))).await;
        assert_eq!(out["state"], "offline");
        assert_eq!(out["ok"], false);
        assert_eq!(out["clientStarted"], false);
        assert_eq!(c.presence.load(Ordering::SeqCst), 1);
        assert_eq!(c.forward.load(Ordering::SeqCst), 0, "离线时不许建链");
        assert_eq!(c.probe.load(Ordering::SeqCst), 0, "离线时不许探测");
        assert_eq!(c.launch.load(Ordering::SeqCst), 0, "离线时不许启动客户端");
        assert!(out["message"].as_str().unwrap().contains("离线"));
    }

    /// R27 / V20.4：TCP 通但协议不响应 → no-service，不启动客户端。
    #[tokio::test]
    async fn env_open_no_service_when_probe_fails() {
        let (rt, c) = mock(Presence::Online, true, false);
        let out = env_open_with(&rt, &body(json!(["vnet.forward"]))).await;
        assert_eq!(out["state"], "no-service");
        assert_eq!(out["ok"], false);
        assert_eq!(out["clientStarted"], false);
        assert_eq!(out["address"], "127.0.0.1:23389");
        assert_eq!(c.launch.load(Ordering::SeqCst), 0, "无服务时不许启动客户端");
        assert!(out["message"].as_str().unwrap().contains("远程桌面"));
    }

    /// R27 / V20.5：caps 缺 vnet.forward → denied，连 presence 都不问。
    #[tokio::test]
    async fn env_open_denied_without_cap() {
        let (rt, c) = mock(Presence::Online, true, true);
        let out = env_open_with(&rt, &body(json!([]))).await;
        assert_eq!(out["state"], "denied");
        assert_eq!(out["ok"], false);
        assert_eq!(out["clientStarted"], false);
        assert_eq!(c.presence.load(Ordering::SeqCst), 0, "denied 不该触网");
        assert_eq!(c.launch.load(Ordering::SeqCst), 0);
        assert!(out["error"].as_str().unwrap().contains("vnet.forward"));
    }

    /// R24 / V20.1：在线 + 有服务 + 有权限 → ready，客户端启动，地址=固定口。
    #[tokio::test]
    async fn env_open_ready_launches_client() {
        let (rt, c) = mock(Presence::Online, true, true);
        let out = env_open_with(&rt, &body(json!(["vnet.forward"]))).await;
        assert_eq!(out["state"], "ready");
        assert_eq!(out["ok"], true);
        assert_eq!(out["address"], "127.0.0.1:23389");
        assert_eq!(out["clientStarted"], true);
        assert_eq!(out["client"], "mstsc");
        assert_eq!(out["tunnel"], "opened");
        assert!(out["ms"].as_u64().is_some());
        assert_eq!(c.launch.load(Ordering::SeqCst), 1);
        // 审计契约：每次调用一条，带 card/task/kind/device/port/state
        let audits = c.audits.lock().unwrap();
        assert_eq!(audits.len(), 1);
        let a = &audits[0];
        assert_eq!(a["ev"], "env-open");
        assert_eq!(a["card"], "sh-v20");
        assert_eq!(a["task"], "task-v20");
        assert_eq!(a["kind"], "rdp");
        assert_eq!(a["device"], "did:myco:z6MkPC");
        assert_eq!(a["port"], 3389);
        assert_eq!(a["state"], "ready");
        assert_eq!(a["clientStarted"], true);
    }

    /// device-origin 24011 是 viewer listener，不是隧道端点：已有 23911 租约也不得冲突。
    /// 负对照使用同一真实租约表，普通 opened 仍必须报冲突。
    #[tokio::test]
    async fn env_open_device_origin_listener_bypasses_tunnel_lease() {
        let _g = crate::test_env_lock::test_env_lock();
        let did = "did:myco:leaseOrigin90ab";
        let sid = "sh-lease-origin";
        let entry = crate::dsh_share::device_origin_url(24011, did, sid).expect("设备域入口");
        let card = json!({
            "cardId": sid, "taskId": "task-lease-origin", "caps": ["vnet.forward"],
            "env": { "kind": "dsh", "device": did, "port": 13911,
                     "localPort": 23911, "entryUrl": entry.clone() }
        });
        let key = crate::vnet_lease::LeaseKey {
            consumer_device: crate::vnet_lease::self_consumer_device(),
            kind: "dsh".into(),
            device: did.into(),
            port: 13911,
            // 另一张卡已占用 23911；本卡 device-origin 24011 若误登记就会真实冲突。
            share_id: "sh-existing-23911".into(),
        };
        crate::vnet_lease::lease_open(&key, 23911).expect("已有 23911 active 租约");
        let (mut rt, c) = mock(Presence::Online, true, true);
        rt.forward = Ok((24011, "device-origin".into()));
        rt.use_real_lease = true;
        let out = env_open_with(&rt, &card).await;
        assert_eq!(out["state"], "ready", "device-origin 不得登记/冲突隧道租约: {out}");
        assert_eq!(out["ok"], true);
        assert_eq!(out["localPort"], 24011);
        assert_eq!(out["tunnel"], "device-origin");
        let url = out["hint"].as_str().unwrap_or("");
        assert_eq!(url, entry, "env_open/hint 必须与纯 entryUrl 完全一致");
        assert!(!url.contains(":23911") && !url.contains('?') && !url.contains('#'));
        assert_eq!(c.launch.load(Ordering::SeqCst), 1);
        crate::vnet_lease::lease_release(&key, "explicit_config").unwrap();

        // 同一真实租约冲突下，普通隧道 Opened 仍 fail-closed；用新 key 避免 closed 终态复用。
        let negative_key = crate::vnet_lease::LeaseKey {
            share_id: "sh-existing-negative".into(),
            ..key.clone()
        };
        let mut negative_card = card.clone();
        negative_card["cardId"] = json!("sh-lease-negative");
        crate::vnet_lease::lease_open(&negative_key, 23911).expect("负对照 23911 租约");
        let (mut rt, c) = mock(Presence::Online, true, true);
        rt.forward = Ok((24011, "opened".into()));
        rt.use_real_lease = true;
        let denied = env_open_with(&rt, &negative_card).await;
        assert_eq!(denied["state"], "error", "真实隧道异口仍必须冲突: {denied}");
        assert_eq!(c.launch.load(Ordering::SeqCst), 0);
        crate::vnet_lease::lease_release(&negative_key, "explicit_config").unwrap();
    }

    /// 自连（目标是本机）：ready 但不启动客户端，给"到客户端设备打开"的提示。
    #[tokio::test]
    async fn env_open_self_target_does_not_launch() {
        let (rt, c) = mock(Presence::SelfTarget, true, true);
        let out = env_open_with(&rt, &body(json!(["vnet.forward"]))).await;
        assert_eq!(out["state"], "ready");
        assert_eq!(out["clientStarted"], false);
        assert_eq!(out["selfTarget"], true);
        assert_eq!(c.launch.load(Ordering::SeqCst), 1, "launch 仍被调用，但实现里按 self_target 返回不启动");
        assert_eq!(c.audits.lock().unwrap().len(), 1);
    }

    /// 建链失败（对端突然掉线）→ 归为 offline（不是 no-service：根本没通到对面）。
    #[tokio::test]
    async fn env_open_tunnel_failure_maps_to_offline() {
        let (rt, c) = mock(Presence::Online, false, true);
        let out = env_open_with(&rt, &body(json!(["vnet.forward"]))).await;
        assert_eq!(out["state"], "offline");
        assert_eq!(out["clientStarted"], false);
        assert_eq!(c.launch.load(Ordering::SeqCst), 0);
        assert_eq!(c.audits.lock().unwrap().len(), 1, "失败也要留审计");
    }

    /// presence **未知** → 不退化成 offline：照常建链，成功就 ready。
    #[tokio::test]
    async fn env_open_unknown_presence_still_tries_forward() {
        let (rt, c) = mock(Presence::Unknown, true, true);
        let out = env_open_with(&rt, &body(json!(["vnet.forward"]))).await;
        assert_eq!(out["state"], "ready", "未知只代表名册查不了，建链成功就该 ready");
        assert_eq!(out["ok"], true);
        assert_eq!(c.forward.load(Ordering::SeqCst), 1, "未知时必须尝试建链");
        assert_eq!(c.launch.load(Ordering::SeqCst), 1);
        assert_eq!(out["presence"], "unknown");
    }

    /// presence 未知 + 建链也失败 → 才归 offline（诚实的"连不上"）。
    #[tokio::test]
    async fn env_open_unknown_presence_then_forward_fail_is_offline() {
        let (rt, _c) = mock(Presence::Unknown, false, true);
        let out = env_open_with(&rt, &body(json!(["vnet.forward"]))).await;
        assert_eq!(out["state"], "offline");
        assert_eq!(out["ok"], false);
        assert!(out["message"].as_str().unwrap().contains("建链失败"));
    }

    /// 默认本地口（卡上没给 localPort）被占：state=error + 文案点名 localPort，
    /// **绝不**伪装成"设备离线"（真机：kind=http 默认 23912 被已有隧道占用）。
    #[tokio::test]
    async fn env_open_default_local_port_conflict_is_error_not_offline() {
        let (mut rt, c) = mock(Presence::Online, true, true);
        rt.forward = Err(
            "固定本地口 127.0.0.1:23912 绑定失败（重试 5 次）：通常每个套接字地址(协议/网络地址/端口)只允许使用一次。 (os error 10048)；不会自动换成随机口——请释放该端口或改 localPort".into(),
        );
        let out = env_open_with(
            &rt,
            &json!({
                "cardId": "sh-v20", "taskId": "task-v20",
                "caps": ["vnet.forward"],
                "env": { "kind": "http", "device": "did:myco:z6MkPEER", "port": 13911 }
            }),
        )
        .await;
        let msg = out["message"].as_str().unwrap();
        assert_eq!(out["state"], "error", "本机端口冲突不是离线：{msg}");
        assert_eq!(out["ok"], false);
        assert_eq!(out["clientStarted"], false);
        assert!(msg.contains("默认本地口 23912"), "文案必须点名默认口: {msg}");
        assert!(msg.contains("localPort"), "文案必须提示显式给 localPort: {msg}");
        assert!(!msg.contains("设备离线"), "不许伪装成设备离线: {msg}");
        assert_eq!(c.launch.load(Ordering::SeqCst), 0, "本机错误不许启动客户端");
        assert_eq!(c.audits.lock().unwrap()[0]["state"], "error", "审计也要记 error");
    }

    /// 卡上显式给了 localPort、但本机端口被占 → 也是本机错误（提示释放端口）。
    #[tokio::test]
    async fn env_open_explicit_local_port_conflict_is_local_error() {
        let (mut rt, _c) = mock(Presence::Online, true, true);
        rt.forward = Err("固定本地口 127.0.0.1:23389 绑定失败（重试 5 次）：os error 10048".into());
        let out = env_open_with(&rt, &body(json!(["vnet.forward"]))).await;
        let msg = out["message"].as_str().unwrap();
        assert_eq!(out["state"], "error");
        assert!(msg.contains("本地口 23389"), "文案带具体端口: {msg}");
        assert!(msg.contains("释放"), "显式口失败要提示释放端口: {msg}");
        assert!(!msg.contains("设备离线"));
    }

    /// 卡的参数错误（端口不在隧道白名单）同样不该说成"设备离线"。
    #[tokio::test]
    async fn env_open_port_not_allowed_is_local_error() {
        let (mut rt, _c) = mock(Presence::Online, true, true);
        rt.forward = Err("端口 3389 不在 P2P 隧道白名单（防开放代理）".into());
        let out = env_open_with(&rt, &body(json!(["vnet.forward"]))).await;
        assert_eq!(out["state"], "error");
        assert!(out["message"].as_str().unwrap().contains("白名单"));
    }

    // ── 协议探测（真 socket：起 std 线程假服务器）──

    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn spawn_server(handler: impl FnOnce(std::net::TcpStream) + Send + 'static) -> u16 {
        let l = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((s, _)) = l.accept() {
                handler(s);
            }
        });
        port
    }

    #[test]
    fn probe_rdp_accepts_x224_confirm() {
        let port = spawn_server(|mut s| {
            let mut buf = [0u8; 19];
            let _ = s.read_exact(&mut buf);
            // Connection Confirm（03000013 0ed00000…）
            let _ = s.write_all(&[0x03, 0x00, 0x00, 0x13, 0x0e, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00]);
        });
        assert!(probe_blocking(port, "rdp", Duration::from_millis(800)), "RDP confirm 必须判为有服务");
    }

    #[test]
    fn probe_rdp_rejects_http_server() {
        // TCP 通，但对面是 HTTP（设计 §5 的 no-service 形态）
        let port = spawn_server(|mut s| {
            let mut buf = [0u8; 64];
            let _ = s.read(&mut buf);
            let _ = s.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n");
        });
        assert!(!probe_blocking(port, "rdp", Duration::from_millis(800)), "不是 RDP 就不能报 ready");
    }

    #[test]
    fn probe_http_accepts_401_and_rejects_mute() {
        let port = spawn_server(|mut s| {
            let mut buf = [0u8; 256];
            let _ = s.read(&mut buf);
            let _ = s.write_all(b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n");
        });
        assert!(probe_blocking(port, "dsh", Duration::from_millis(800)), "401 也是 DSH 在服务");

        let mute = spawn_server(|_s| {
            std::thread::sleep(Duration::from_millis(600));
        });
        assert!(!probe_blocking(mute, "dsh", Duration::from_millis(300)), "只连不答 → no-service");

        let refused = {
            let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            l.local_addr().unwrap().port()
            // 监听器立刻 drop → 端口无服务
        };
        assert!(!probe_blocking(refused, "http", Duration::from_millis(300)), "连不上 → no-service");
    }

    #[test]
    fn probe_ssh_waits_for_banner() {
        let port = spawn_server(|mut s| {
            let _ = s.write_all(b"SSH-2.0-OpenSSH_9.0\r\n");
        });
        assert!(probe_blocking(port, "ssh", Duration::from_millis(800)), "SSH banner 必须被认出来");
        let mute = spawn_server(|_s| std::thread::sleep(Duration::from_millis(500)));
        assert!(!probe_blocking(mute, "ssh", Duration::from_millis(300)));
    }

    #[test]
    fn probe_stereo_adb_are_tcp_only() {
        let port = spawn_server(|_s| std::thread::sleep(Duration::from_millis(400)));
        assert!(probe_blocking(port, "stereo", Duration::from_millis(800)));
        assert!(probe_blocking(port, "adb", Duration::from_millis(800)));
    }

    // ── 真服务探针（默认 ignore：只在真机上手动跑，验证协议探测对**真服务**成立）──
    //
    //   cargo test -p myco-home --lib real_local_service_probe -- --ignored --nocapture
    //
    // PC 上 3389=RDP / 13911=DSH web 是真实在跑的服务；这两个探针把「探测核」钉在
    // 真服务上，而不是只在假服务器上自证。

    #[test]
    #[ignore = "真机探针：需要本机 3389 RDP 服务在跑"]
    fn real_local_service_probe_rdp() {
        let port: u16 = std::env::var("MYCO_PROBE_RDP_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(3389);
        let ok = probe_blocking(port, "rdp", Duration::from_millis(1500));
        eprintln!("[env-probe] 127.0.0.1:{port} rdp → {ok}");
        assert!(ok, "本机 {port} 应有 RDP 服务（X.224 confirm）");
    }

    #[test]
    #[ignore = "真机探针：需要本机 13911 DSH web 在跑"]
    fn real_local_service_probe_dsh() {
        let port: u16 = std::env::var("MYCO_PROBE_DSH_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(13911);
        let ok = probe_blocking(port, "dsh", Duration::from_millis(1500));
        eprintln!("[env-probe] 127.0.0.1:{port} dsh → {ok}");
        assert!(ok, "本机 {port} 应有 DSH web（任意 HTTP 响应）");
    }

    #[test]
    #[ignore = "真机探针：无服务端口应判 no-service"]
    fn real_local_service_probe_no_service() {
        let port: u16 = std::env::var("MYCO_PROBE_EMPTY_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(15999);
        let ok = probe_blocking(port, "rdp", Duration::from_millis(600));
        eprintln!("[env-probe] 127.0.0.1:{port} rdp → {ok}");
        assert!(!ok, "{port} 无服务时必须判 no-service");
    }

    /// 真机：**客户端启动这一腿**的时延（R25 的 click→process 里"process"那一段）。
    ///
    // ── task-13：分享入口 URL 追加客户端设备断言（vnet_env 侧接线） ──
    #[test]
    fn browser_entry_url_carries_client_assert_when_identity_available() {
        let entry = "http://127.0.0.1:23911/gw/sh-pc-env-dsh/?mt=abc";
        let url = crate::dsh_share::with_client_assert(entry);
        assert!(url.starts_with(entry), "原 URL 必须原样保留: {url}");
        // 有设备身份才追加；无身份（未建号/钥不可读）= 旧行为原样返回。
        if url != entry {
            assert!(url.contains("#mycoClient="), "{url}");
            assert!(url.contains("mycoClientName="), "{url}");
            assert!(url.contains("mycoClientTs="), "{url}");
            assert!(url.contains("mycoClientSig="), "{url}");
        }
        // 非分享入口（根路径/外站）→ 一字不改
        assert_eq!(
            crate::dsh_share::with_client_assert("http://127.0.0.1:23911/"),
            "http://127.0.0.1:23911/"
        );
        assert_eq!(
            crate::dsh_share::with_client_assert("https://myco.youling.cc/x"),
            "https://myco.youling.cc/x"
        );
    }

    /// 会真的弹一下 mstsc —— 所以默认 ignore；且**只在没有 mstsc 在跑时**执行
    /// （绝不误杀用户正在用的远程桌面窗口），跑完立刻 kill 自己 spawn 的那个 PID。
    ///
    ///   cargo test -p myco-home --lib real_mstsc_launch_latency -- --ignored --nocapture
    #[cfg(all(feature = "gui", windows))]
    #[test]
    #[ignore = "真机：会弹一下 mstsc（约 0.25s 后 kill）"]
    fn real_mstsc_launch_latency() {
        let running = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq mstsc.exe", "/NH"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("mstsc.exe"))
            .unwrap_or(false);
        if running {
            eprintln!("[env-launch] 跳过：已有 mstsc 在运行（不误杀用户的远程桌面）");
            return;
        }
        let file = crate::dsh_share::write_rdp_file(3389, "", "127.0.0.1:23389").expect("写 .rdp");
        let text = std::fs::read(&file).expect("读 .rdp");
        let text = String::from_utf8_lossy(&text).to_string();
        assert!(text.contains("full address:s:127.0.0.1:23389"), ".rdp 必须写死固定口：{text}");
        let t0 = Instant::now();
        let mut child = std::process::Command::new("mstsc.exe")
            .arg(&file)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("启动 mstsc");
        // 进程"出现"的判定：spawn 返回即进程已创建；再确认它没秒退
        std::thread::sleep(Duration::from_millis(250));
        let alive = child.try_wait().ok().flatten().is_none();
        let ms = t0.elapsed().as_millis();
        let pid = child.id();
        let _ = child.kill();
        eprintln!("[env-launch] mstsc pid={pid} alive250ms={alive} click→进程 {ms}ms rdpFile={}", file.display());
        assert!(alive, "mstsc 启动后 250ms 内不该退出");
        assert!(ms < 1500, "客户端启动这一段不许超过 1500ms（实测 {ms}ms）");
    }
}
