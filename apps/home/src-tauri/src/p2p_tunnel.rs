//! p2p_tunnel.rs — 2026-10-09：P2P web 隧道（把本机 loopback 服务经 p2p 网代理给好友设备）。
//!
//! ## 为什么是"WS 承载的透明字节流"而不是裸 TCP
//! p2p 网的两端只有一个已存在的 TCP 服务器（`/p2p/*`，axum + 设备签名信封）。
//! 徒手实现裸 TCP 隧道要另开一条监听端口并自行做 NAT 穿透/多路径选路——
//! 而寻址（内网/公网 IPv4/IPv6）、端口顺延、防火墙规则这套已经由 p2p 服务器解决。
//! 所以在**同一条** p2p HTTP 通道上加一个 WebSocket 端点，把 WS 的**二进制帧当字节分片**：
//! 上层拿到的是一条透明 TCP 流——HTTP/1.1 请求（含 `Upgrade: websocket` 的内层握手）
//! 只是字节，**内层 WebSocket 因此天然穿透**（DSH SPA 的 `/api/remote.mux` WS 走这条）。
//!
//! ```text
//!  调用方设备 B                                        目标设备 A（分享者）
//!  ┌────────────────┐  ws://<A 候选>:<p2pPort>/p2p/tunnel?v=2  ┌──────────────────┐
//!  │ tunnel_open()  │ ───────────────────────────────────────► │ handle_tunnel    │
//!  │ 127.0.0.1:LP   │  握手：x-myco-tunnel(信封) + x-myco-auth    │  验签+白名单+授权 │
//!  │  (本地临时监听) │  ◄══ 加密二进制帧 = 原始字节 ══►            │  tunnel_serve    │
//!  └────────────────┘                                          └────────┬─────────┘
//!        ▲  http://127.0.0.1:LP/...  ≡  http://A:target_port/...         │ 裸 TCP
//!        │                                                             ▼
//!   DSH/浏览器/reqwest                                    127.0.0.1:<target_port>
//!                                                         (13911 公网网关 / 9100 ...)
//! ```
//!
//! ## 安全闸（防变开放代理）
//! 1. **设备签名信封**：`x-myco-tunnel` 头是 `{v,port,account,device,origin,nonce}` JSON，
//!    签名口径与 `/p2p/*` 完全一致（`x-myco-auth: <did>.<ts>.<sig>`，签
//!    `did\nts\n<x-myco-tunnel 头的原文>`，60s 窗口）。`verify_auth` 复用 p2p_server。
//!    `origin` = 发起方设备 DID，与签名者必须同一把钥（`did_equiv`）——把"谁开的这条隧道"
//!    绑进签名覆盖面，防"转发别人的合法握手"。
//! 2. **签名设备必须属于信封里的 account**（`device_belongs_to_account`，复用第95轮
//!    归属闸：本机设备/本机委任状/云名册三通道，fail-closed）。
//! 3. **端口白名单**：只允许转发到固定 loopback 端口集合（默认 `13911` 公网网关 +
//!    `9100` p2p 服务器本身；`MYCO_P2P_TUNNEL_PORTS` 可运维级追加）。**绝不接受任意
//!    host/port**——host 硬编码 `127.0.0.1`，端口必须在册。
//! 4. **nonce 去重**（120s 窗口）：握手带 `getrandom` 真随机 nonce，重放同一份
//!    握手（签名仍在 ts 窗口内）直接 403。
//! 5. **内容加密**：握手完成后所有二进制帧都是 AEAD 密文；明文帧/坏帧/重放帧/乱序帧
//!    一律拒（关连接 + 审计）。
//! 6. **审计**：每次升级成功/失败记 `TunnelAudit{ts,account,device,port,peer,result}`
//!    （内存环形 256 条 + `p2p-tunnel` Tauri 事件 + stderr）。
//!
//! ## 授权（grant 名单）由上层接——本模块不发明规则
//! 传输层只负责把**调用方设备身份 + 账号 DID** 解出来，然后问一次
//! [`set_tunnel_authorizer`] 安装的钩子。**未安装 = 一律拒绝（fail-closed）**。
//! 网关侧（分享 grant 名单）在此钩子里判断"调用方 DID 是否在册"。
//!
//! ## 建连速度：并行赛跑（2026-10-09，硬指标"秒级"；2026-10-10 移动网调参）
//! 旧实现 `for b in ws_bases { probe(b).await }` 是**串行**：N 个候选最坏 N×5s。
//! 现在：**全部候选同一时刻发起**（`FuturesUnordered`），单候选短超时
//! [`RACE_CANDIDATE_TIMEOUT`]（2s——移动网络 RTT 可达 200-400ms，TCP+WS 升级+
//! 加密握手 ≈ 4 个 RTT，900ms 的旧值会把慢而**能通**的候选误判成死路），
//! **首个升级成功即采用**，其余立刻 drop（取消在途 TCP/WS 握手），整场 race 由
//! [`RACE_TOTAL_BUDGET`]（3s）硬兜底。
//! 因此建连耗时 ≈ **最快可用候选的 RTT**（不随候选数线性增长），
//! 最坏（全不通）= 3s 上界（不再是 N×5s）。
//! 成功候选进 [`CACHE`]（按设备 did，300s 新鲜期），下次 `tunnel_open` 把它排到最前
//! （同时仍并行试其余候选——缓存是"提速"不是"唯一路径"，避免过期 base 卡死）。
//!
//! ## 候选地址：多类盘点（含反射地址）
//! 候选 = 上次成功的 base（缓存，排最前）
//!      ∪ 对端 presence 上报的 addrs（lan → publicV4 → reflexive → ipv6）
//!      ∪ 本机候选（`p2p_server::local_candidate_urls`，一次 ipconfig；同机自连/兜底）。
//! 反射地址（reflexive）由服务器观测我方连接的**源地址**得到，见
//! `p2p_server::record_reflexive_observation` / `p2p_server::reflexive_addrs`——
//! 本机在 NAT 后方时这是唯一"对端可能可达"的公网地址来源。
//!
//! ## 谁能连谁（成立条件与边界，人话）
//! * **lan**：同网段才可达（跨网段必失败，实测会跳过）。
//! * **publicV4**：本机网卡**直接持有**公网 IPv4（无 NAT 前置）→ 任何网络的对端都能连。
//! * **reflexive（公网出口/反射地址）**：本机在 NAT 后面，服务器看到我的出口 `IP:port`。
//!   它只说明"我出网时是这个地址"，**不等于对端能连回来**：NAT 没做端口映射时，
//!   对端拨这个地址会打到 NAT 的空映射上。有端口映射（或锥形 NAT 复用同端口）才成立。
//! * **ipv6**：全球单播地址，双方都有 v6 出口即直连（最不需要 NAT 配合）。
//! * 一句话：**只要有一方持有对端可达的地址（公网 IPv4 / 已映射的出口 / 全球 IPv6），
//!   另一方主动拨它就能直连**——"两个 p，有一方有公网 IP 就行"成立。
//! * **打不通的情形（诚实标注）**：双方都在 NAT 后且都没有端口映射/锥形 NAT/全球 IPv6
//!   时，**没有中继就打不通**（需要 TURN 式中继，属后续工作；本模块只把"有一方可达"
//!   这条路走顺，并把不可达情形的人话原因回给调用方，见 [`no_route_hint`]）。
//!
//! ## 断线无感重连（2026-10-09 第二程）
//! 本层的"隧道"**不是一条长连接**，而是一个**长命的本地监听端口** + 每来一条本地
//! TCP 连接就现场重赛候选、重做握手（[`tunnel_conn`]）。所以"断开后自动恢复"在这里
//! 是三件具体的事，缺一不可：
//!   1. **地址清单可热更新**：候选是 `tunnel_open` 那一刻的快照。源设备重启/换网后
//!      旧清单可能全不通 → 全部失败时**重新问一次 presence**（限频 10s）拿到新地址再赛
//!      （[`refresh_candidates_throttled`]）。
//!   2. **端口不许被误回收**：上层的空闲回收环看不见隧道内的流量，只看"点卡"时间。
//!      本层用 [`TunnelStat`]（活连接数 + 最近活动时间）如实上报 [`tunnel_in_use`]，
//!      让"用户正看着的页面"不会被当空闲抽掉脚下端口。
//!   3. **每次连接都是新握手**：会话密钥一次性（见下），连接级失败只影响那一条连接。
//! 实测：源侧目标服务从"没在跑"到"起来"之后，**同一个本地端口**的下一次访问即通
//! （`tunnel_local_port_self_heals_when_target_comes_back`）。
//!
//! ## 契约面
//! ```ignore
//! /// 与 target 设备建 P2P 隧道，本地起临时监听端口，返回该本地端口。
//! pub async fn tunnel_open(target_device_did: &str, target_port: u16) -> Result<u16, String>;
//! /// 关闭某设备的隧道（返回是否本来开着）。
//! pub fn tunnel_close(target_device_did: &str, target_port: u16) -> bool;
//! /// 反向模式（2026-10-09）：本机作为**发起方**主动连 viewer（手机），把本机
//! /// target_port 服务经出站连接交给对方浏览器；不开本地监听口，返回拨出条数。
//! pub async fn tunnel_open_reverse(target_device_did: &str, target_port: u16, count: usize) -> Result<usize, String>;
//! /// 停掉某设备的全部反向连接。
//! pub fn tunnel_reverse_stop(target_device_did: &str) -> bool;
//! ```
//! 语义：拿到 `local_port` 后 `http://127.0.0.1:<local_port>/...` ≡
//! `target_device:target_port/...`（HTTP 与 WS 都透传）。同 `(device,port)` 重复
//! `tunnel_open` = 先关旧再开新。`p2p_client` 已 re-export 这两个函数。
//!
//! ## 反向连接（⑧，2026-10-09：PC 主动拨手机）
//! 手机 → PC 被家宽光猫拦入站、PC → 手机（移动网络 IPv6）直连通的拓扑下，
//! 隧道方向反转：**谁拨 TCP 谁是发起方**（originator：签信封、先发 HELLO），
//! 接电话的是应答方（responder：验签 + 闸门）——v2 线协议一字不改，角色互换。
//! 触发 = 手机 presence 上报 `addrs.wantReverse`（10s 轮询 + 同账号/好友闸），
//! 见下方 ⑧ 段与 `p2p_client::reverse_wants_now`。

use aes_gcm::aead::{Aead as _, KeyInit as _};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo,
    },
    http::{HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Json, Response},
};
use base64::Engine as _;
use ed25519_dalek::Signer as _;
use futures_util::stream::{FuturesUnordered, StreamExt as _};
use futures_util::SinkExt;
use hkdf::Hkdf;
use hmac::Mac as _;
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};
use std::net::SocketAddr;

#[path = "tunnel_resume_frames.rs"]
mod tunnel_resume_frames;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
// 只在非 test 构建里引 Tauri Emitter：lib test 产物没有 exe manifest（tauri-build 的
// manifest 只给 bin target），一旦把 tauri 的 webview 栈链进测试 exe，加载器会绑到
// 无 v6 导出的 comctl32 → 0xC0000139 起不来。审计本体（eprintln+环形缓冲）不受影响。
#[cfg(not(test))]
use tauri::Emitter as _;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message as TMessage;
use x25519_dalek::{PublicKey as X25519Public, StaticSecret as X25519Secret};

// ═══════════════════════════════════════════════════════════════════════
// 诊断行毫秒时间戳（2026-11-11 RDP 三连断经验沉淀）
//
// 事故现场：PC 日志抽样 20 万行，`[vnet-keeper]` 占 35%，但**一行时间戳都没有**
// （裸 `eprintln!`）——"20:54/20:58 重启 → 21:00 三次 RDP，前两次连上就断"这条
// 时间线只能靠计数和文件 mtime 反推，无法证实也无法证伪。
//
// 契约：
// · 只加前缀、**一个字节都不改消息正文**（`{ts} {原行}`），现有 grep 锚点
//   （`[vnet-keeper]` / `[p2p-tunnel]` …）与解析脚本继续可用；
// · 毫秒精度、本地时区（与 `relay-trace.log` 的 `%H:%M:%S%.3f` 同口径，
//   但补全年月日——事故跨天时 `%H:%M:%S` 无法定位）；
// · 跨平台（chrono，无 Windows API），不影响非 Windows 构建；
// · 每次调用一次 `chrono::Local::now()`，不加锁、不碰全局表——这些行都是低频
//   诊断（keeper 每拍/建链每跳），热点行另有节流（见 vnet_lease 的 keeper_log）。
// ═══════════════════════════════════════════════════════════════════════

/// 日志时间戳格式：`2026-11-11 21:00:00.123`（定宽 23 字符，便于按列 diff）。
pub(crate) const LOG_TS_FMT: &str = "%Y-%m-%d %H:%M:%S%.3f";

/// 把给定时刻格式化成日志时间戳（纯函数；单测钉住"定宽 + 毫秒补零"）。
pub(crate) fn format_log_ts(dt: chrono::DateTime<chrono::Local>) -> String {
    dt.format(LOG_TS_FMT).to_string()
}

/// 可打印时间戳（`impl Display`，不额外分配 String；`elog!` 用它）。
pub(crate) fn log_ts(dt: chrono::DateTime<chrono::Local>) -> impl std::fmt::Display {
    dt.format(LOG_TS_FMT)
}

/// 当前时刻的日志时间戳字符串。
pub(crate) fn now_log_ts() -> String {
    format_log_ts(chrono::Local::now())
}

/// 一行诊断文本 = `时间戳 + 空格 + 原消息`（纯函数；"只加前缀不改正文"的测试锚点）。
pub(crate) fn format_log_line(dt: chrono::DateTime<chrono::Local>, msg: &str) -> String {
    format!("{} {msg}", format_log_ts(dt))
}

/// 带毫秒时间戳的诊断行：参数与 `eprintln!` 完全一致，只多一个 `{ts} ` 前缀。
///
/// 用法（本 crate 内任意模块）：`crate::p2p_tunnel::elog!("[vnet-keeper] …")`。
/// 为什么是宏而不是 `fn elog(&str)`：后者要求调用点先 `format!`（多一次分配）
/// 或丢掉 `{:?}`/内联参数；宏把 `format_args!` 直接喂给 `eprintln!`，只在真正
/// 打印时才格式化，且**完全不改变**原消息的 `{}`/`{x}` 捕获语义。
macro_rules! elog {
    ($($arg:tt)*) => {{
        eprintln!(
            "{} {}",
            $crate::p2p_tunnel::log_ts(chrono::Local::now()),
            format_args!($($arg)*)
        );
    }};
}
pub(crate) use elog;

#[cfg(test)]
mod log_ts_tests {
    use super::*;
    use chrono::TimeZone as _;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32, ms: u32) -> chrono::DateTime<chrono::Local> {
        chrono::Local
            .with_ymd_and_hms(y, mo, d, h, mi, s)
            .single()
            .expect("本地时区该时刻应唯一")
            + chrono::Duration::milliseconds(i64::from(ms))
    }

    /// 事故要求的格式：`2026-11-11 21:00:00.123`（定宽、毫秒三位、本地时区）。
    #[test]
    fn log_ts_is_fixed_width_millisecond_local_time() {
        let dt = at(2026, 11, 11, 21, 0, 0, 123);
        assert_eq!(format_log_ts(dt), "2026-11-11 21:00:00.123");
        assert_eq!(format_log_ts(dt).len(), 23, "定宽 23 字符（含毫秒补零）");
        // 毫秒必须补零到三位（`%.3f`），否则排序/比对会错位
        assert_eq!(format_log_ts(at(2026, 1, 2, 3, 4, 5, 7)), "2026-01-02 03:04:05.007");
        assert_eq!(format_log_ts(at(2026, 1, 2, 3, 4, 5, 0)), "2026-01-02 03:04:05.000");
        // 跨天定位能力（事故跨 20:54 → 21:00 的边界）
        assert_eq!(format_log_ts(at(2026, 11, 12, 0, 0, 1, 999)), "2026-11-12 00:00:01.999");
        // Display 版（elog! 真正用的那条）与 String 版必须逐字节一致
        assert_eq!(log_ts(dt).to_string(), format_log_ts(dt));
    }

    /// **只加前缀、不改正文**：前缀之后必须逐字节等于原消息（含中文/箭头/`{:?}` 结果）。
    #[test]
    fn log_line_prefixes_without_touching_body() {
        let dt = at(2026, 11, 11, 21, 0, 0, 123);
        let body = "[vnet-keeper] 固定口漂移 → 收编现状 :23389（不 close，避免重建循环）：did:myco:x:5555";
        let line = format_log_line(dt, body);
        assert_eq!(line, format!("2026-11-11 21:00:00.123 {body}"));
        assert!(line.ends_with(body), "正文必须原样保留在行尾");
        assert!(line.starts_with("2026-11-11 21:00:00.123 "), "时间戳前缀独立成段");
        // 阈值：前缀恰好 24 字节（23 字符 + 一个空格），消息体可以从第 24 字节起切
        assert_eq!(&line[..24], "2026-11-11 21:00:00.123 ");
        assert_eq!(&line[24..], body);
    }

    /// 实时路径冒烟：`now_log_ts()` 必须是当下（误差 < 1h）、形状恒定。
    #[test]
    fn now_log_ts_has_expected_shape() {
        let ts = now_log_ts();
        assert_eq!(ts.len(), 23, "{ts}");
        let bytes = ts.as_bytes();
        for (i, b) in bytes.iter().enumerate() {
            let ok = match i {
                4 | 7 => *b == b'-',
                10 => *b == b' ',
                13 | 16 => *b == b':',
                19 => *b == b'.',
                _ => b.is_ascii_digit(),
            };
            assert!(ok, "位置 {i} 字符非法：{ts}");
        }
    }
}

/// 隧道握手信封头（原文即签名载荷）。
pub const TUNNEL_HANDSHAKE_HEADER: &str = "x-myco-tunnel";
/// 握手协议版本。
/// **v1（明文帧）→ v2（AEAD 加密帧）**：版本不符一律 400，**不静默降级成明文**
/// ——老 v1 客户端会被明确拒绝（人话："协议版本不符（本机 v2）：请升级 myco"）。
pub const TUNNEL_PROTOCOL_VERSION: u32 = 2;
/// 默认白名单端口：13911 = DSH 分享公网网关（UI/任务/remote.mux 的入口）；
/// 9100 = 本机 p2p 服务器（好友设备可经隧道调用我方 /p2p/* 数据面）。
pub const TUNNEL_DEFAULT_PORTS: &[u16] = &[
    15200, // VNETP/1 源端 HTTP target（设备域终态：远端 HTTP 经 vnet 认证前导入此口）
    13911, // 分享公网网关
    9100,  // P2P 自身
    // ── 2026-10-22 vnet（虚拟组网）：frp 等价端口 ──
    // 白名单只是"允许被授权的对端通过隧道访问本机的哪些端口"；真正的准入仍是
    // 设备签名 + 账号归属 + 端口级授权（未授权设备连握手都过不了）。加这些端口
    // 是为了让"我的笔记本 RDP 连我的 PC / adb 连手机"能用 myco 隧道完成。
    22,   // SSH
    3389, // Windows RDP
    5555, // Android ADB（手机 adb tcpip）
    9000, // 立体声（frp stereorx 对端）
    // 2026-11-01 自由远程桌面方案（REMOTE-DESKTOP-远程桌面自由方案.md）：
    5900,   // VNC（Mac 屏幕共享 / Linux TigerVNC·x11vnc，display 0；5901+ 由 extra 文件放行）
    21118, // RustDesk「允许 IP 直接访问」默认口
];
/// 隧道内层单次读取块大小（16KB——HTTP 首包/WS 帧都在一两个块内）。
/// 2026-10-22 vnet 吞吐真案：64KB 分块实测单帧往返 **97ms**（32KB 仅 0.58ms、
/// 16KB 0.26ms）——帧体积跨过 64KB 边界后 TCP 拆段 + 延迟 ACK，吞吐塌到 3MB/s。
/// 32KB 帧实测 ~54MB/s、16KB ~60MB/s。取 32KB：帧数少一半、又稳在快区。
// 2026-10-22 实测结论：32KB 帧是本机/跨网的最优点（跨网 32KB 3.7-4.7MB/s vs 128KB 2.6-4.1MB/s；
// 自连 32KB 45.9MB/s vs 128KB 28-31MB/s）。带宽不在帧尺寸，在在途帧数（受 TCP 窗口/自动调优限制）——
// 要再上需改传输模型（批量 feed/不逐帧 await），属独立里程碑。
const TUNNEL_CHUNK: usize = 32 * 1024;
/// 端点侧连本机目标端口的超时（5s，与本机服务同机——不该慢）。
const TUNNEL_UPSTREAM_TIMEOUT_SECS: u64 = 5;
/// 单侧结束后留给另一侧收尾的宽限（防"对端已 FIN、最后一帧还在 WS 缓冲里"的截断）。
const TUNNEL_DRAIN_GRACE: Duration = Duration::from_secs(2);
/// 客户端下行写本地浏览器/目标服务的策略。
///
/// 2026-10-28 01:02 曾用无限等待；当时真正缺的是网关代答 DSH 上游 Ping，导致
/// 浏览器停读后外层连接半开。随后加的 30s fail-fast 在 04:04 真案中误伤了
/// 正常 TCP 背压：PC 下行 363MB，浏览器渲染慢，内核缓冲填满后本地写只阻塞
/// 30 秒就被我们主动 RST，造成一次可见重连。
///
/// 现在恢复直连语义：下游慢就自然阻塞，背压经 p2p WS/TCP 一路传回上游；
/// 上游心跳已由 dsh_share 网关本地代答，不再依赖这条停读的浏览器腿。
const LOCAL_WRITE_STALL_TIMEOUT: Option<Duration> = None;

// ── 并行赛跑预算（"建连秒级"硬指标） ──
/// 单候选的建隧道超时：过这个点就没戏（LAN <1ms；移动网络 RTT 200-400ms ×
/// TCP+WS 升级+加密握手 ≈4 RTT → 900ms 旧值误杀慢而能通的候选，2026-10-10 提到 2s）。
pub const RACE_CANDIDATE_TIMEOUT: Duration = Duration::from_millis(2000);
/// 整场赛跑的硬预算：无论多少候选/多慢，`tunnel_open` 不晚于这个上界返回。
pub const RACE_TOTAL_BUDGET: Duration = Duration::from_millis(3000);
/// 首个成功后留给"几乎同时完成"的候选的短暂合流窗口（让真最快的那个胜出，
/// 而不是被排空顺序随机化）——上限 1 个 RTT 级，远小于候选超时。
const RACE_SETTLE_WINDOW: Duration = Duration::from_millis(80);
/// 2026-10-24 task-19（enc-fail 循环根修）：稳态**首选单拨**超时——先单独拨当前
/// 活跃/缓存 base，成功即用（不并发第二个候选 → 对端零取消/RST）；失败才回落完整赛跑。
const PREFERRED_DIAL_TIMEOUT: Duration = Duration::from_millis(800);

// ══════════════════ 端口白名单 ══════════════════

/// 运维级追加白名单（逗号分隔端口）。默认只有 [`TUNNEL_DEFAULT_PORTS`]。
fn tunnel_env_ports() -> Vec<u16> {
    std::env::var("MYCO_P2P_TUNNEL_PORTS")
        .map(|s| {
            s.split(',')
                .filter_map(|p| p.trim().parse::<u16>().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// 测试注入的额外白名单（回环 E2E 需要随机端口；不污染进程 env）。
#[cfg(test)]
pub(crate) static TEST_EXTRA_PORTS: LazyLock<Mutex<Vec<u16>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));

/// 用户级持久化授权端口（`%APPDATA%\youling\vnet-allowed-ports.json`，形如 `[8080,18080]`）。
///
/// 2026-10-22 用户口径："要能做 127.0.0.1:某端口的 ssh/http/webrtc/rdp 等操作"——默认
/// 表只有几个常用端口，任意端口需要**用户显式授权**：本机管理面 `POST /api/vnet/allowPorts`
/// 写入此文件，立即生效（每次读盘，文件小、频率低）。安全边界不变：隧道握手仍要求
/// 设备签名 + 账号归属；这里只是"这台机器的用户允许被访问哪些端口"。
pub fn vnet_allowed_ports_path() -> std::path::PathBuf {
    myco_core::config::config_dir().join("vnet-allowed-ports.json")
}

/// 读用户授权端口（文件不存在/损坏 → 空）。
pub fn vnet_user_ports() -> Vec<u16> {
    std::fs::read_to_string(vnet_allowed_ports_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<u16>>(&t).ok())
        .unwrap_or_default()
}

/// 写用户授权端口（去重排序）。
pub fn vnet_set_user_ports(mut ports: Vec<u16>) -> Result<(), String> {
    ports.sort_unstable();
    ports.dedup();
    let p = vnet_allowed_ports_path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(
        &p,
        serde_json::to_string_pretty(&ports).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// 当前生效的额外白名单端口。
fn tunnel_extra_ports() -> Vec<u16> {
    let mut v = tunnel_env_ports();
    v.extend(vnet_user_ports());
    // 测试注入（cfg 下才存在；非测试构建零开销、无 unused_mut 噪音）
    #[cfg(test)]
    let v = {
        let mut v = v;
        v.extend(TEST_EXTRA_PORTS.lock().unwrap().iter().copied());
        v
    };
    v
}

/// 纯判定（单测直击）：端口 ∈ 默认表 ∪ extra。0 永远不在册。
pub fn tunnel_port_allowed_in(port: u16, extra: &[u16]) -> bool {
    // 2026-11-10：viewer 专属口段 15100-15199 已随分口机制删除（插件 owner 口按
    // 连接身份归属，不再需要逐 viewer 分口），白名单只剩默认表 + 显式 extra。
    port != 0
        && (TUNNEL_DEFAULT_PORTS.contains(&port) || extra.contains(&port))
}

/// 端口是否在册（读 env/测试注入）。
pub fn tunnel_port_allowed(port: u16) -> bool {
    tunnel_port_allowed_in(port, &tunnel_extra_ports())
}

// ══════════════════ 握手信封 + 闸门 ══════════════════

/// 隧道握手信封（`x-myco-tunnel` 头的 JSON；`#[serde(rename_all="camelCase")]` 约定）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelHandshake {
    pub v: u32,
    pub port: u16,
    /// 调用方账号 DID（授权判定的主体；网关侧 grant 名单按它比对）
    pub account: String,
    /// 调用方设备 DID（= 签名者；归属闸要求它属于 account）
    pub device: String,
    /// 发起方设备 DID（v2 新增；与签名者必须同一把钥——把"谁开的隧道"绑进签名覆盖面）
    pub origin: String,
    /// 一次性随机串（120s 重放去重）
    pub nonce: String,
    /// 可选能力集：声明 `resume` 才进入续传协议；老客户端缺省 = 空集，v1 语义不变。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cap: Vec<String>,
}

impl TunnelHandshake {
    /// 客户端是否声明续传能力；不声明一律按旧 v1 处理，避免改变现有路径。
    pub fn resume_capable(&self) -> bool {
        self.cap.iter().any(|c| c == "resume")
    }
}

/// 构造握手原文（字段顺序确定；调用方必须**签同一串**）。
pub fn tunnel_handshake_json(
    account: &str,
    device: &str,
    origin: &str,
    port: u16,
    nonce: &str,
) -> String {
    serde_json::to_string(&TunnelHandshake {
        v: TUNNEL_PROTOCOL_VERSION,
        port,
        account: account.to_string(),
        device: device.to_string(),
        origin: origin.to_string(),
        nonce: nonce.to_string(),
        cap: Vec::new(),
    })
    .unwrap_or_default()
}

/// 拒绝原因（单测可断言；HTTP 状态见 [`TunnelReject::status`]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TunnelReject {
    /// 握手体缺失/JSON 坏/版本不符 → 400
    BadHandshake,
    /// 无签名或验签失败 → 403
    BadSignature,
    /// 签名设备 ≠ 信封 device（拿别人设备 did 签名）→ 403
    DeviceMismatch,
    /// 端口不在白名单 → 403
    PortNotAllowed,
    /// 签名设备不属于信封 account（伪造身份 / 名册不可查 fail-closed）→ 403
    Ownership,
    /// nonce 已用过（重放）→ 403
    Replay,
    /// 上层授权钩子拒绝（不在该分享的 grant 名单）→ 403
    NotAuthorized,
}

impl TunnelReject {
    fn status(self) -> StatusCode {
        match self {
            TunnelReject::BadHandshake => StatusCode::BAD_REQUEST,
            _ => StatusCode::FORBIDDEN,
        }
    }

    fn audit_result(self) -> &'static str {
        match self {
            TunnelReject::BadHandshake => "bad-handshake",
            TunnelReject::BadSignature => "bad-signature",
            TunnelReject::DeviceMismatch => "device-mismatch",
            TunnelReject::PortNotAllowed => "port-not-allowed",
            TunnelReject::Ownership => "not-owner",
            TunnelReject::Replay => "replay",
            TunnelReject::NotAuthorized => "not-authorized",
        }
    }

    fn into_response(self) -> Response {
        let msg = match self {
            TunnelReject::BadHandshake => {
                format!("隧道握手体无效或协议版本不符（本机 v{TUNNEL_PROTOCOL_VERSION}：老版本请升级 myco）")
            }
            TunnelReject::BadSignature => "auth failed（设备签名无效）".to_string(),
            TunnelReject::DeviceMismatch => "device 与签名者不一致".to_string(),
            TunnelReject::PortNotAllowed => {
                format!("端口不在隧道白名单（允许 {:?}）", TUNNEL_DEFAULT_PORTS)
            }
            TunnelReject::Ownership => "签名设备不属于声称的账号".to_string(),
            TunnelReject::Replay => "握手 nonce 重复（重放）".to_string(),
            TunnelReject::NotAuthorized => "未获授权访问该端口".to_string(),
        };
        (self.status(), Json(json!({ "error": msg }))).into_response()
    }
}

/// 纯决策（输入齐备）——单测直击；handler 的唯一逻辑源。
/// 顺序：设备一致（最廉价，先挡）→ 端口白名单（次廉价）→ 归属 → 上层授权。
pub(crate) fn tunnel_gate_decision(
    signer: &str,
    device: &str,
    port: u16,
    extra: &[u16],
    belongs: bool,
    authorized: bool,
) -> Result<(), TunnelReject> {
    if !myco_core::identity::did_equiv(signer, device) {
        return Err(TunnelReject::DeviceMismatch);
    }
    if !tunnel_port_allowed_in(port, extra) {
        return Err(TunnelReject::PortNotAllowed);
    }
    if !belongs {
        return Err(TunnelReject::Ownership);
    }
    if !authorized {
        return Err(TunnelReject::NotAuthorized);
    }
    Ok(())
}

// ── nonce 重放去重（120s 窗口） ──

static TUNNEL_NONCES: LazyLock<Mutex<Vec<(String, i64)>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));
const TUNNEL_NONCE_WINDOW_MS: i64 = 120_000;

/// nonce 是否**已经用过**（副作用：登记新 nonce + 清理窗口外）。纯本地、O(窗口内条数)。
fn nonce_is_replay(nonce: &str, now_ms: i64) -> bool {
    let mut g = TUNNEL_NONCES.lock().unwrap();
    g.retain(|(_, t)| now_ms - *t < TUNNEL_NONCE_WINDOW_MS);
    if g.iter().any(|(n, _)| n == nonce) {
        return true;
    }
    g.push((nonce.to_string(), now_ms));
    false
}

/// 每次连接一个不重复 nonce。
/// 2026-10-09：改用 `getrandom` 真随机（原实现是"纳秒+自增"——可预测，与
/// "nonce 应不可预测"的语义不符；去重口径不变）。
fn next_nonce() -> String {
    let mut b = [0u8; 16];
    if getrandom::fill(&mut b).is_ok() {
        return format!("tn-{}", hex_lower(&b));
    }
    // 兜底（RNG 不可用不该让隧道整体不可用）：纳秒 + 进程内自增
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("tn-{t:x}-{n:x}")
}

/// 小写十六进制（无外部依赖；nonce/日志用）。
fn hex_lower(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 0x0f) as usize] as char);
    }
    s
}

// ── 上层授权钩子（网关侧安装"该分享的 grant 名单"判定） ──

type TunnelAuthorizer = dyn Fn(&str, &str, u16) -> bool + Send + Sync + 'static;
static TUNNEL_AUTHORIZER: LazyLock<Mutex<Option<Arc<TunnelAuthorizer>>>> =
    LazyLock::new(|| Mutex::new(None));

/// 安装授权钩子：`(调用方账号 DID, 调用方设备 DID, 目标端口) -> 是否放行`。
/// 网关侧在此处接"该分享的 grant 名单"（调用方 DID 在册即放行）。
/// **未安装 = 一律拒绝（fail-closed）**：授权规则是上层的事，传输层不替它放行——
/// 否则任何 myco 账号（只要有一台在册设备）都能把隧道打进我的 :13911（=开放代理）。
/// 装好钩子这一个动作就是"开闸"，网关侧的 grant 判定接在钩子里。
pub fn set_tunnel_authorizer(f: impl Fn(&str, &str, u16) -> bool + Send + Sync + 'static) {
    *TUNNEL_AUTHORIZER.lock().unwrap() = Some(Arc::new(f));
}

/// 问钩子（未安装=拒绝，见 [`set_tunnel_authorizer`] 的 fail-closed 定案）。
fn tunnel_authorized(account: &str, device: &str, port: u16) -> bool {
    let hook = TUNNEL_AUTHORIZER.lock().unwrap().clone();
    match hook {
        Some(f) => f(account, device, port),
        None => {
            elog!("[p2p-tunnel] 未安装授权钩子 → 拒绝 {account}/{device}:{port}（网关需 set_tunnel_authorizer 开闸）");
            false
        }
    }
}

/// 测试复位（避免用例间钩子串味）。
#[cfg(test)]
pub(crate) fn clear_tunnel_authorizer() {
    *TUNNEL_AUTHORIZER.lock().unwrap() = None;
}

// ── 审计 ──

/// 一条隧道审计记录（谁 / 从哪台设备 / 连哪个端口 / 结果）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelAudit {
    pub ts: i64,
    pub account: String,
    pub device: String,
    pub port: u16,
    /// 调用方来源地址（p2p 面 TCP peer）
    pub peer: String,
    /// upgraded | closed | upstream-fail | enc-fail | 各拒绝原因（见 TunnelReject::audit_result）
    pub result: String,
}

const TUNNEL_AUDIT_CAP: usize = 256;
static TUNNEL_AUDIT: LazyLock<Mutex<Vec<TunnelAudit>>> = LazyLock::new(|| Mutex::new(Vec::new()));

fn audit_push(rec: TunnelAudit) {
    elog!(
        "[p2p-tunnel] {} account={} device={} port={} peer={}",
        rec.result, rec.account, rec.device, rec.port, rec.peer
    );
    // 只发 UI 事件（非 test 构建）——见文件顶部 `use tauri::Emitter` 前的注释：
    // lib test 产物不能链 tauri 的 webview 栈，否则 0xC0000139 起不来。
    #[cfg(not(test))]
    if let Some(app) = crate::p2p_client::current_app_handle() {
        let _ = app.emit(
            "p2p-tunnel",
            serde_json::to_value(&rec).unwrap_or(Value::Null),
        );
    }
    let mut g = TUNNEL_AUDIT.lock().unwrap();
    if g.len() >= TUNNEL_AUDIT_CAP {
        g.remove(0);
    }
    g.push(rec);
}

/// 最近审计记录（旧→新；最多 256 条）。网关侧可据此做展示/风控。
pub fn tunnel_audit_recent() -> Vec<TunnelAudit> {
    TUNNEL_AUDIT.lock().unwrap().clone()
}

/// 测试清空审计。
#[cfg(test)]
pub(crate) fn clear_tunnel_audit() {
    TUNNEL_AUDIT.lock().unwrap().clear();
}

// ══════════════════════════════════════════════════════════════════════
// ② 帧级内容加密（2026-10-09）
//
// 目标：WS 仍是 ws://（明文承载密文），但**内容不可读、不可篡改、不可重放**。
// 方案：应用层 AEAD（不引 TLS 证书体系，改动局限在本模块）。
//   1. 握手（升级完成后，同一 WS 通道内的二进制帧）：
//        client → server: [MAGIC][ver][HELLO][ct_client(32)]   ← 临时 X25519 公钥
//        server → client: [MAGIC][ver][HELLO][ct_server(32)]
//      ct = X25519 **临时**公钥，**每次连接新生成** ⇒ 会话密钥一次性（前向保密）。
//   2. 会话密钥：ECDH(我方临时私钥, 对端临时公钥) → `SharedSecret`
//      （全 0 = 低阶点/非贡献行为 → 拒绝）→ HKDF-SHA256 派生 140B：
//        salt = SHA256(MAGIC ‖ ct_client ‖ ct_server ‖ handshake_raw)，info = HKDF_INFO
//        [0..32]   c2s 方向密钥      [32..64]  s2c 方向密钥
//        [64..76]  nonce 前缀(12B)   [76..108] c2s 确认键  [108..140] s2c 确认键
//      salt 串进**已签名的握手原文** ⇒ ECDH 结果绑定到已认证的握手（防换钥重放）。
//   3. 密钥确认：双方各发一条明文 MAC 帧（HMAC-SHA256(确认键, handshake_raw)），
//      不一致 = 密钥不一致（MITM/降级）→ 立刻关连接，**绝不静默降级成明文**。
//   4. 数据帧：`[MAGIC][ver][DATA][seq u64 BE][nonce_prefix 12][ciphertext+tag]`；
//      nonce = nonce_prefix XOR seq，AES-256-GCM 逐帧加解密。
//   5. 防重放：**每方向独立的单调序号**，收到的 seq 必须严格大于已见最大值
//      （WS over TCP 保序 ⇒ "小于等于"就是重放/乱序）→ 拒绝并关连接。
//      GCM tag 校验失败（篡改）同理拒绝。nonce 前缀不符（串台/换钥）也拒绝。
// 兼容性：版本不符（v1 客户端 / 缺 `?v=2`）→ 400 明确拒绝，不静默降级。
// ══════════════════════════════════════════════════════════════════════

/// 帧魔数（"MET2"）：让"裸明文/别的协议"在第一眼就被认出并拒绝。
pub(crate) const FRAME_MAGIC: [u8; 4] = *b"MET2";
/// 帧格式版本（独立于握手信封版本；将来改帧布局时另起）。
pub(crate) const FRAME_FORMAT_VERSION: u8 = 1;
/// 帧类型：握手（明文，仅升级后头两条）。
pub(crate) const FRAME_HELLO: u8 = 1;
/// 帧类型：密钥确认（明文 MAC）。
pub(crate) const FRAME_CONFIRM: u8 = 2;
/// 帧类型：AEAD 数据帧（密文）。
pub(crate) const FRAME_DATA: u8 = 3;
/// 握手帧 / 确认帧长度（MAGIC4 + ver1 + type1 + 32B 载荷）。
const FRAME_HELLO_LEN: usize = 6 + 32;
/// 数据帧固定头长度（MAGIC4 + ver1 + type1 + seq8 + nonce_prefix12）。
const FRAME_DATA_HEADER: usize = 6 + 8 + 12;
/// 帧载荷上限（16KB 块 + GCM tag，留裕量；防对端发超大帧打爆内存）。
const FRAME_MAX_PAYLOAD: usize = 1024 * 1024;
/// HKDF info（域分隔标签）。
const HKDF_INFO: &[u8] = b"myco-p2p-tunnel/v2";

/// 加密层错误（单测可断言）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FrameError {
    /// 首帧不是合法 HELLO（魔数/长度/版本不符）
    HelloMalformed,
    /// ECDH 出全 0（低阶点/非贡献行为）或密钥派生失败
    KeyRejected,
    /// 密钥确认 MAC 不一致（MITM/降级/密钥不一致）
    ConfirmMismatch,
    /// 收到明文数据帧 / 类型未知 / 帧结构坏
    PlaintextOrUnknownFrame,
    /// GCM tag 校验失败（篡改）或长度不足
    AuthFail,
    /// 序号非递增（重放/乱序）
    ReplayOrOutOfOrder,
    /// resume 帧版本不符
    WrongVersion,
    /// RESUME 的偏移不在 [ackedOffset, sendNext] 区间（防乱序/截断误当已收到）
    ResumeOffsetInvalid,
    /// 底层 IO/WS 错
    Io(String),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            FrameError::HelloMalformed => "加密握手帧无效",
            FrameError::KeyRejected => "会话密钥协商失败（低阶公钥/非贡献行为）",
            FrameError::ConfirmMismatch => "会话密钥确认失败（可能被中间人/降级）",
            FrameError::PlaintextOrUnknownFrame => "收到明文帧或未知帧类型（协议要求全部加密）",
            FrameError::AuthFail => "帧认证失败（密文被篡改）",
            FrameError::ReplayOrOutOfOrder => "帧序号非递增（重放或乱序）",
            FrameError::WrongVersion => "resume 帧版本不符",
            FrameError::ResumeOffsetInvalid => "RESUME 偏移不在已确认/已发送区间内",
            FrameError::Io(_) => "加密层 IO 错误",
        };
        match self {
            FrameError::Io(e) => write!(f, "{s}: {e}"),
            _ => write!(f, "{s}"),
        }
    }
}

/// 我在本条隧道的角色（决定 HKDF 里 ct 的拼接顺序与方向密钥的取用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TunnelRole {
    /// WS 发起方（`tunnel_conn` 侧）
    Originator,
    /// WS 接受方（`handle_tunnel` 侧）
    Responder,
}

/// 一条隧道的会话密钥材料（每次连接新建；用后即弃=前向保密）。
#[derive(Clone)]
pub(crate) struct SessionKeys {
    pub(crate) c2s: [u8; 32],
    pub(crate) s2c: [u8; 32],
    pub(crate) prefix: [u8; 12],
    pub(crate) confirm_c2s: [u8; 32],
    pub(crate) confirm_s2c: [u8; 32],
}

impl SessionKeys {
    /// 由 ECDH + HKDF 派生（两端同法，输入对称：ct_client 恒在 ct_server 之前）。
    pub(crate) fn derive(
        my_priv: &X25519Secret,
        their_pub: &[u8; 32],
        ct_client: &[u8; 32],
        ct_server: &[u8; 32],
        handshake_raw: &str,
    ) -> Result<Self, FrameError> {
        let shared = my_priv.diffie_hellman(&X25519Public::from(*their_pub));
        let shared_bytes = shared.as_bytes();
        // 非贡献行为（低阶点）会让 ECDH 出全 0 —— 必须拒绝
        if shared_bytes.iter().all(|b| *b == 0) {
            return Err(FrameError::KeyRejected);
        }
        let salt = {
            let mut h = Sha256::new();
            h.update(FRAME_MAGIC);
            h.update(ct_client);
            h.update(ct_server);
            h.update(handshake_raw.as_bytes());
            h.finalize()
        };
        let hk = Hkdf::<Sha256>::new(Some(salt.as_slice()), shared_bytes.as_slice());
        let mut okm = [0u8; 140];
        hk.expand(HKDF_INFO, &mut okm)
            .map_err(|_| FrameError::KeyRejected)?;
        let mut k = SessionKeys {
            c2s: [0; 32],
            s2c: [0; 32],
            prefix: [0; 12],
            confirm_c2s: [0; 32],
            confirm_s2c: [0; 32],
        };
        k.c2s.copy_from_slice(&okm[0..32]);
        k.s2c.copy_from_slice(&okm[32..64]);
        k.prefix.copy_from_slice(&okm[64..76]);
        k.confirm_c2s.copy_from_slice(&okm[76..108]);
        k.confirm_s2c.copy_from_slice(&okm[108..140]);
        Ok(k)
    }

    /// 本方向（发送）数据密钥。
    pub(crate) fn send_key(&self, role: TunnelRole) -> &[u8; 32] {
        match role {
            TunnelRole::Originator => &self.c2s,
            TunnelRole::Responder => &self.s2c,
        }
    }

    /// 对方向（接收）数据密钥。
    pub(crate) fn recv_key(&self, role: TunnelRole) -> &[u8; 32] {
        match role {
            TunnelRole::Originator => &self.s2c,
            TunnelRole::Responder => &self.c2s,
        }
    }

    fn send_confirm_key(&self, role: TunnelRole) -> &[u8; 32] {
        match role {
            TunnelRole::Originator => &self.confirm_c2s,
            TunnelRole::Responder => &self.confirm_s2c,
        }
    }

    fn recv_confirm_key(&self, role: TunnelRole) -> &[u8; 32] {
        match role {
            TunnelRole::Originator => &self.confirm_s2c,
            TunnelRole::Responder => &self.confirm_c2s,
        }
    }

    /// 本方向确认 MAC = HMAC-SHA256(确认键, handshake_raw)。
    pub(crate) fn my_confirm_mac(&self, role: TunnelRole, handshake_raw: &str) -> [u8; 32] {
        let mut mac =
            <hmac::Hmac<Sha256> as hmac::Mac>::new_from_slice(self.send_confirm_key(role))
                .expect("HMAC 接受任意长度密钥");
        mac.update(handshake_raw.as_bytes());
        mac.finalize().into_bytes().into()
    }

    /// 对端确认 MAC 是否一致（常量时间比较）。
    pub(crate) fn verify_peer_confirm(
        &self,
        role: TunnelRole,
        handshake_raw: &str,
        got: &[u8; 32],
    ) -> bool {
        let mut mac =
            <hmac::Hmac<Sha256> as hmac::Mac>::new_from_slice(self.recv_confirm_key(role))
                .expect("HMAC 接受任意长度密钥");
        mac.update(handshake_raw.as_bytes());
        mac.verify_slice(got.as_slice()).is_ok()
    }

    /// 数据帧 nonce = prefix XOR seq（seq 放末 8 字节）。
    fn nonce_for(&self, seq: u64) -> [u8; 12] {
        let mut n = self.prefix;
        let tail = u64::from_be_bytes(n[4..12].try_into().unwrap());
        n[4..12].copy_from_slice(&(tail ^ seq).to_be_bytes());
        n
    }
}

/// 帧编解码器（一个连接一套；发送/接收各自单调序号）。
pub(crate) struct FrameIo {
    tx: Aes256Gcm,
    rx: Aes256Gcm,
    pub(crate) keys: SessionKeys,
    role: TunnelRole,
    send_seq: u64,
    recv_max_seq: Option<u64>,
    /// 握手原文（确认帧用）。
    handshake_raw: String,
}

impl FrameIo {
    pub(crate) fn new(keys: SessionKeys, role: TunnelRole, handshake_raw: &str) -> Self {
        let tx = Aes256Gcm::new_from_slice(keys.send_key(role)).expect("32B 密钥");
        let rx = Aes256Gcm::new_from_slice(keys.recv_key(role)).expect("32B 密钥");
        FrameIo {
            tx,
            rx,
            keys,
            role,
            send_seq: 0,
            recv_max_seq: None,
            handshake_raw: handshake_raw.to_string(),
        }
    }

    /// 密钥确认帧（明文 MAC 载荷）。
    pub(crate) fn confirm_frame(&self) -> Vec<u8> {
        let mut f = Vec::with_capacity(FRAME_HELLO_LEN);
        f.extend_from_slice(&FRAME_MAGIC);
        f.push(FRAME_FORMAT_VERSION);
        f.push(FRAME_CONFIRM);
        f.extend_from_slice(&self.keys.my_confirm_mac(self.role, &self.handshake_raw));
        f
    }

    /// 校验对端确认帧。
    pub(crate) fn accept_confirm(&self, frame: &[u8]) -> Result<(), FrameError> {
        if frame.len() != FRAME_HELLO_LEN || &frame[0..4] != FRAME_MAGIC {
            return Err(FrameError::HelloMalformed);
        }
        if frame[4] != FRAME_FORMAT_VERSION || frame[5] != FRAME_CONFIRM {
            return Err(FrameError::PlaintextOrUnknownFrame);
        }
        let mut got = [0u8; 32];
        got.copy_from_slice(&frame[6..38]);
        if !self
            .keys
            .verify_peer_confirm(self.role, &self.handshake_raw, &got)
        {
            return Err(FrameError::ConfirmMismatch);
        }
        Ok(())
    }

    /// 加密一帧（序号自增）。
    pub(crate) fn seal(&mut self, plaintext: &[u8]) -> Vec<u8> {
        let seq = self.send_seq;
        self.send_seq += 1;
        let nonce = self.keys.nonce_for(seq);
        let ct = self
            .tx
            .encrypt(Nonce::from_slice(&nonce), plaintext)
            .expect("GCM 加密不会失败");
        let mut f = Vec::with_capacity(FRAME_DATA_HEADER + ct.len());
        f.extend_from_slice(&FRAME_MAGIC);
        f.push(FRAME_FORMAT_VERSION);
        f.push(FRAME_DATA);
        f.extend_from_slice(&seq.to_be_bytes());
        f.extend_from_slice(&self.keys.prefix);
        f.extend_from_slice(&ct);
        f
    }

    /// 解一帧（校验结构 + nonce 前缀 + tag + 单调序号）。
    pub(crate) fn open(&mut self, frame: &[u8]) -> Result<Vec<u8>, FrameError> {
        // 先看魔数（<4B 连魔数都没有 → 当坏帧）：明文/别的协议在这里第一眼被认出
        if frame.len() < 4 || &frame[0..4] != FRAME_MAGIC {
            return Err(FrameError::PlaintextOrUnknownFrame);
        }
        if frame.len() < FRAME_DATA_HEADER + 16 {
            return Err(FrameError::AuthFail);
        }
        if frame[4] != FRAME_FORMAT_VERSION {
            return Err(FrameError::PlaintextOrUnknownFrame);
        }
        if frame[5] != FRAME_DATA {
            // HELLO/CONFIRM 只允许出现在握手阶段；数据阶段收到即拒（防降级/注入）
            return Err(FrameError::PlaintextOrUnknownFrame);
        }
        let seq = u64::from_be_bytes(frame[6..14].try_into().unwrap());
        if &frame[14..26] != self.keys.prefix.as_slice() {
            // 会话不一致（换钥/串台/降级）
            return Err(FrameError::AuthFail);
        }
        if let Some(max) = self.recv_max_seq {
            if seq <= max {
                return Err(FrameError::ReplayOrOutOfOrder);
            }
        }
        let nonce = self.keys.nonce_for(seq);
        let pt = self
            .rx
            .decrypt(Nonce::from_slice(&nonce), &frame[FRAME_DATA_HEADER..])
            .map_err(|_| FrameError::AuthFail)?;
        self.recv_max_seq = Some(seq);
        Ok(pt)
    }
}

/// 生成临时 X25519 密钥对（32B 真随机私钥；X25519 clamp 由算法内部处理）。
fn gen_ephemeral() -> (X25519Secret, [u8; 32]) {
    // 测试可注入确定性临时钥（取用即清空：同一条连接里客户端/服务端各取一次不同值）
    #[cfg(test)]
    if let Some(seed) = TEST_EPHEMERAL.with(|c| c.borrow_mut().take()) {
        let s = X25519Secret::from(seed);
        let p = X25519Public::from(&s).to_bytes();
        return (s, p);
    }
    let mut bytes = [0u8; 32];
    if getrandom::fill(&mut bytes).is_err() {
        // RNG 不可用：退化为时间+计数器（仍每次不同；安全性下调，打日志）
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
            .to_be_bytes();
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = SEQ
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .to_be_bytes();
        bytes[0..16].copy_from_slice(&t);
        bytes[16..24].copy_from_slice(&n);
        bytes[24..32].copy_from_slice(&t[8..16]);
        elog!("[p2p-tunnel] 警告：getrandom 不可用，临时钥退化生成（安全性下调）");
    }
    let s = X25519Secret::from(bytes);
    let p = X25519Public::from(&s).to_bytes();
    (s, p)
}

// 测试注入的确定性临时钥（线程局部，避免用例间串味）。
// 注：目前没有用例需要确定性临时钥（加解密用例都从显式私钥构造 SessionKeys），
// 但注入钩子保留在 `gen_ephemeral` 里——将来要做"两端全链对拍（含 HELLO 帧）"时直接用。
#[cfg(test)]
thread_local! {
    pub(crate) static TEST_EPHEMERAL: std::cell::RefCell<Option<[u8; 32]>> = const { std::cell::RefCell::new(None) };
}

/// HELLO 帧载荷：`[MAGIC][ver][type][pub32]`。
pub(crate) fn hello_frame(pubkey: &[u8; 32]) -> Vec<u8> {
    let mut f = Vec::with_capacity(FRAME_HELLO_LEN);
    f.extend_from_slice(&FRAME_MAGIC);
    f.push(FRAME_FORMAT_VERSION);
    f.push(FRAME_HELLO);
    f.extend_from_slice(pubkey);
    f
}

/// 解析 HELLO 帧 → 32B 公钥（校验魔数/版本/类型/长度）。
pub(crate) fn parse_hello(frame: &[u8]) -> Result<[u8; 32], FrameError> {
    if frame.len() != FRAME_HELLO_LEN {
        return Err(FrameError::HelloMalformed);
    }
    if &frame[0..4] != FRAME_MAGIC || frame[4] != FRAME_FORMAT_VERSION || frame[5] != FRAME_HELLO {
        return Err(FrameError::HelloMalformed);
    }
    let mut p = [0u8; 32];
    p.copy_from_slice(&frame[6..38]);
    Ok(p)
}

/// 从 WS 读一条二进制帧（Close/文本/Ping → 差错；None = 连接结束）。
macro_rules! ws_next_payload {
    ($rx:expr) => {
        match $rx.next().await {
            Some(Ok(Message::Binary(d))) => Ok(d),
            Some(Ok(Message::Close(_))) => Err(FrameError::Io("对端关闭".into())),
            Some(Ok(_)) => Err(FrameError::HelloMalformed),
            Some(Err(e)) => Err(FrameError::Io(e.to_string())),
            None => Err(FrameError::Io("连接结束".into())),
        }
    };
}

/// 服务端侧加密握手：读 HELLO → 回 HELLO_ACK → 互验确认帧 → [`FrameIo`]。
/// 任一步失败 = 明确拒绝（返回错误 → 调用方关连接 + 审计 `enc-fail`），**不降级**。
pub(crate) async fn crypto_handshake_server(
    ws: &mut WebSocket,
    handshake_raw: &str,
) -> Result<FrameIo, FrameError> {
    let f1 = ws_next_payload!(ws)?;
    let ct_client = parse_hello(&f1)?;
    let (my_priv, my_pub) = gen_ephemeral();
    ws.send(Message::Binary(hello_frame(&my_pub)))
        .await
        .map_err(|e| FrameError::Io(e.to_string()))?;
    let keys = SessionKeys::derive(&my_priv, &ct_client, &ct_client, &my_pub, handshake_raw)?;
    let io = FrameIo::new(keys, TunnelRole::Responder, handshake_raw);
    // 先发确认帧，再收对端确认帧（两端对称，无死锁）
    ws.send(Message::Binary(io.confirm_frame()))
        .await
        .map_err(|e| FrameError::Io(e.to_string()))?;
    let f2 = ws_next_payload!(ws)?;
    io.accept_confirm(&f2)?;
    Ok(io)
}

/// 客户端侧加密握手：发 HELLO → 收 HELLO_ACK → 互验确认帧 → [`FrameIo`]。
pub(crate) async fn crypto_handshake_client(
    ws: &mut WsStream,
    handshake_raw: &str,
) -> Result<FrameIo, FrameError> {
    let (my_priv, my_pub) = gen_ephemeral();
    let t0 = std::time::Instant::now();
    ws.send(TMessage::Binary(hello_frame(&my_pub)))
        .await
        .map_err(|e| FrameError::Io(format!("{e:?}")))?;
    let f2 = match ws.next().await {
        Some(Ok(TMessage::Binary(d))) => d,
        Some(Ok(TMessage::Close(_))) => return Err(FrameError::Io("对端关闭".into())),
        Some(Ok(_)) => return Err(FrameError::HelloMalformed),
        Some(Err(e)) => return Err(FrameError::Io(e.to_string())),
        None => return Err(FrameError::Io("连接结束".into())),
    };
    let ct_server = parse_hello(&f2)?;
    let keys = SessionKeys::derive(&my_priv, &ct_server, &my_pub, &ct_server, handshake_raw)?;
    // 注：ct_client = my_pub（发起方 HELLO 里的临时公钥），ct_server = ct_server
    let io = FrameIo::new(keys, TunnelRole::Originator, handshake_raw);
    let f3 = match ws.next().await {
        Some(Ok(TMessage::Binary(d))) => d,
        Some(Ok(TMessage::Close(_))) => return Err(FrameError::Io("对端关闭".into())),
        Some(Ok(_)) => return Err(FrameError::HelloMalformed),
        Some(Err(e)) => return Err(FrameError::Io(e.to_string())),
        None => return Err(FrameError::Io("连接结束".into())),
    };
    io.accept_confirm(&f3)?;
    ws.send(TMessage::Binary(io.confirm_frame()))
        .await
        .map_err(|e| FrameError::Io(format!("{e:?}")))?;
    elog!("[p2p-tunnel] crypto-handshake ms={}", t0.elapsed().as_millis());
    Ok(io)
}

// ══════════════════ 服务端：端点 + 透明转发 ══════════════════

/// `GET /p2p/tunnel?v=2`（WebSocketUpgrade）。
/// 顺序：版本（query，最廉价先挡）→ 握手体解析 → 验签 → 廉价闸（设备一致/端口白名单）
/// → 发起方=签名者 → nonce 去重 → 归属闸 → 授权钩子 → 升级 → 加密握手（v2 必需）。
pub async fn handle_tunnel(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    uri: Uri,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let peer = peer.to_string();
    let extra = tunnel_extra_ports();
    // ⓪ 协议版本（query `?v=2`，最廉价先挡）：老 v1 客户端/缺参数一律 400（不静默降级）
    if !query_version_ok(&uri, TUNNEL_PROTOCOL_VERSION) {
        elog!(
            "[p2p-tunnel] 拒绝：协议版本不符（query 非 v{TUNNEL_PROTOCOL_VERSION}）peer={peer}"
        );
        audit_push(audit(&peer, "", "", 0, TunnelReject::BadHandshake));
        return TunnelReject::BadHandshake.into_response();
    }
    // ① 握手体（原文即签名载荷）
    let Some(raw) = headers
        .get(TUNNEL_HANDSHAKE_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(String::from)
    else {
        audit_push(audit(&peer, "", "", 0, TunnelReject::BadHandshake));
        return TunnelReject::BadHandshake.into_response();
    };
    let hs: TunnelHandshake = match serde_json::from_str(&raw) {
        Ok(h) => h,
        Err(_) => {
            audit_push(audit(&peer, "", "", 0, TunnelReject::BadHandshake));
            return TunnelReject::BadHandshake.into_response();
        }
    };
    if hs.v != TUNNEL_PROTOCOL_VERSION || hs.nonce.is_empty() || hs.origin.is_empty() {
        audit_push(audit(
            &peer,
            &hs.account,
            &hs.device,
            hs.port,
            TunnelReject::BadHandshake,
        ));
        return TunnelReject::BadHandshake.into_response();
    }
    // ② 验签（设备钥自证；签 raw 原文——端口/账号/发起方都在签名覆盖面内）
    let Some(signer) = crate::p2p_server::verify_auth(&headers, raw.as_bytes()) else {
        audit_push(audit(
            &peer,
            &hs.account,
            &hs.device,
            hs.port,
            TunnelReject::BadSignature,
        ));
        return TunnelReject::BadSignature.into_response();
    };
    // ③ 廉价闸（设备一致 + 端口白名单）——过了才做重放去重/归属（可能云名册 HTTP）
    if let Err(r) = tunnel_gate_decision(&signer, &hs.device, hs.port, &extra, true, true) {
        if matches!(r, TunnelReject::PortNotAllowed) {
            elog!("[p2p-tunnel] port-not-allowed raw={raw}");
        }
        audit_push(audit(&peer, &hs.account, &hs.device, hs.port, r));
        return r.into_response();
    }
    // ③′ 发起方 = 签名者（防"转发别人的合法握手"）
    if !myco_core::identity::did_equiv(&signer, &hs.origin) {
        audit_push(audit(
            &peer,
            &hs.account,
            &hs.device,
            hs.port,
            TunnelReject::DeviceMismatch,
        ));
        return TunnelReject::DeviceMismatch.into_response();
    }
    // ④ nonce 重放去重
    if nonce_is_replay(&hs.nonce, chrono::Utc::now().timestamp_millis()) {
        audit_push(audit(
            &peer,
            &hs.account,
            &hs.device,
            hs.port,
            TunnelReject::Replay,
        ));
        return TunnelReject::Replay.into_response();
    }
    // ⑤ 归属闸：签名设备必须属于信封 account（fail-closed）
    let belongs = crate::p2p_server::device_belongs_to_account(&hs.device, &hs.account).await;
    // ⑥ 上层授权（该分享的 grant 名单；未安装=拒绝）
    let authorized = tunnel_authorized(&hs.account, &hs.device, hs.port);
    if let Err(r) = tunnel_gate_decision(&signer, &hs.device, hs.port, &extra, belongs, authorized)
    {
        audit_push(audit(&peer, &hs.account, &hs.device, hs.port, r));
        return r.into_response();
    }
    audit_push(TunnelAudit {
        ts: chrono::Utc::now().timestamp_millis(),
        account: hs.account.clone(),
        device: hs.device.clone(),
        port: hs.port,
        peer: peer.clone(),
        result: "upgraded".to_string(),
    });
    let (account, device, port) = (hs.account.clone(), hs.device.clone(), hs.port);
    let resume_capable = hs.resume_capable();
    elog!("[p2p-tunnel] handle_tunnel resume_capable={resume_capable} cap={:?} raw={raw}", hs.cap);
    ws.on_upgrade(move |socket| tunnel_serve(socket, raw, peer, account, device, port, resume_capable))
}

/// query `v` 是否等于期望版本（纯函数，单测直击）。
/// 缺 `v` / 非数字 / 版本不符 → false（→ 400，绝不静默降级）。
pub(crate) fn query_version_ok(uri: &Uri, want: u32) -> bool {
    uri.query()
        .map(|q| {
            q.split('&').any(|kv| {
                let mut it = kv.splitn(2, '=');
                let (k, v) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
                (k == "v" || k == "V") && v.parse::<u32>().ok() == Some(want)
            })
        })
        .unwrap_or(false)
}

fn audit(peer: &str, account: &str, device: &str, port: u16, r: TunnelReject) -> TunnelAudit {
    TunnelAudit {
        ts: chrono::Utc::now().timestamp_millis(),
        account: account.to_string(),
        device: device.to_string(),
        port,
        peer: peer.to_string(),
        result: r.audit_result().to_string(),
    }
}

/// 对端在加密握手开始/中途直接断开（RST/Close/EOF）的判定（纯函数，单测直击）：
/// 这类"失败"是拨号方取消（赛跑败者 drop、预热池回收、页面关连接）造成的**良性取消**，
/// 不是密钥协商/协议错误——不能记 enc-fail（否则日志被误读成"双端互踢"）。
fn peer_aborted_handshake(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    msg.contains("对端关闭")
        || msg.contains("连接结束")
        || msg.contains("远程主机强迫关闭") // Windows(WSAECONNRESET 10054) 中文文案
        || m.contains("connection reset")
        || m.contains("without closing handshake")
        || m.contains("connection aborted")
        || m.contains("forcibly closed") // Windows 英文文案
        || m.contains("os error 10054")
        || m.contains("broken pipe")
}

/// 已升级的隧道：先做 v2 加密握手（**未 split**，读写同一 socket），再连本机
/// `127.0.0.1:<port>` 双向对泵**密文帧**。
/// host 硬编码 loopback + 端口已过白名单 = 不可能变开放代理。
async fn tunnel_serve(
    socket: WebSocket,
    handshake_raw: String,
    peer: String,
    account: String,
    device: String,
    port: u16,
    resume_capable: bool,
) {
    let mut socket = socket;
    let t0 = std::time::Instant::now();
    elog!("[p2p-tunnel] tunnel_serve-start device={device} port={port} peer={peer}");
    // 加密握手：失败=明确拒绝（审计 enc-fail），不降级
    let io = match crypto_handshake_server(&mut socket, &handshake_raw).await {
        Ok(io) => io,
        Err(e) => {
            // 2026-10-24 task-19：区分「对端在加密握手前断开（取消/半开回收）」与真加密失败。
            // 旧代码一律 enc-fail → 两侧日志被"加密握手失败(Connection reset)"刷屏，
            // 误读成双方互踢（实际多为拨号取消/赛跑败者被 RST）。
            let benign = matches!(&e, FrameError::Io(m) if peer_aborted_handshake(m));
            if benign {
                elog!(
                    "[p2p-tunnel] 对端在加密握手前断开（拨号取消/半开回收）→ {device}:{port}"
                );
            } else {
                elog!("[p2p-tunnel] 加密握手失败（{e}）→ 拒绝 {device}:{port}");
            }
            audit_push(TunnelAudit {
                ts: chrono::Utc::now().timestamp_millis(),
                account,
                device,
                port,
                peer,
                result: if benign {
                    "peer-abort".to_string()
                } else {
                    "enc-fail".to_string()
                },
            });
            let _ = socket.close().await;
            return;
        }
    };
    // cap=resume：先做逻辑会话首帧握手（SESSION_OPEN / RESUME），再进入 resume 数据泵。
    // 老客户端不声明 cap，完全走旧 v1 路径。
    elog!("[p2p-tunnel] tunnel_serve resume_capable={resume_capable} device={device} port={port}");
    let mut resume_pump: Option<(
        tunnel_resume_frames::ResumeIo,
        Arc<Mutex<tunnel_resume_frames::ResumeSession>>,
        u64,
        Vec<u8>,
    )> = None;
    if resume_capable {
        elog!("[p2p-tunnel] session-resume start device={device} port={port}");
        let mut resume_io = tunnel_resume_frames::ResumeIo::new(io.keys.clone(), TunnelRole::Responder);
        let first = match socket.next().await {
            Some(Ok(Message::Binary(d))) => d,
            Some(Ok(Message::Close(_))) => {
                elog!("[p2p-tunnel] session-resume fail device={device} port={port} 对端关闭");
                let _ = socket.close().await;
                return;
            }
            Some(Ok(_)) | None => {
                elog!("[p2p-tunnel] session-resume fail device={device} port={port} 首帧缺失");
                let _ = socket.close().await;
                return;
            }
            Some(Err(e)) => {
                elog!("[p2p-tunnel] session-resume fail device={device} port={port} {e}");
                let _ = socket.close().await;
                return;
            }
        };
        // RESUME 的精确 offset 在找回会话后由 ResumeSession.on_resume 再校验；
        // 这里先放行首帧，随后用真实会话状态生成 ACK。顺手清理超过恢复窗口的旧会话。
        let now = now_ms_i64();
        RESUME_SESSIONS.lock().unwrap().retain(|_, s| {
            let mut g = s.lock().unwrap();
            g.tick(now);
            g.state != tunnel_resume_frames::SessionState::Closed
        });
        RESUME_SESSION_OWNERS.lock().unwrap().retain(|sid, _| {
            RESUME_SESSIONS.lock().unwrap().contains_key(sid)
        });
        let action = match tunnel_resume_frames::server_accept_first_frame(&mut resume_io, &first, 0, u64::MAX) {
            Ok((a, _ack)) => a,
            Err(e) => {
                elog!("[p2p-tunnel] session-resume fail device={device} port={port} {e}");
                let _ = socket.close().await;
                return;
            }
        };
        match action {
            tunnel_resume_frames::ResumeServerAction::SessionOpen { sid, .. } => {
                let ack = match resume_io.seal_control(
                    tunnel_resume_frames::T_SESSION_ACK,
                    &tunnel_resume_frames::encode_session_ack(&sid, 0).unwrap_or_default(),
                ) {
                    Ok(v) => v,
                    Err(e) => {
                        elog!("[p2p-tunnel] session-resume fail device={device} port={port} {e}");
                        let _ = socket.close().await;
                        return;
                    }
                };
                if let Err(e) = socket.send(Message::Binary(ack)).await {
                    elog!("[p2p-tunnel] session-resume fail device={device} port={port} 回包失败 {e}");
                    let _ = socket.close().await;
                    return;
                }
                let sess = Arc::new(Mutex::new(tunnel_resume_frames::ResumeSession::new(sid)));
                sess.lock().unwrap().on_leg_open();
                RESUME_SESSIONS.lock().unwrap().insert(sid, sess.clone());
                RESUME_SESSION_OWNERS.lock().unwrap().insert(sid, (account.clone(), device.clone()));
                resume_pump = Some((resume_io, sess, 0, Vec::new()));
            }
            tunnel_resume_frames::ResumeServerAction::Resume { sid, replay_from } => {
                let sess = { RESUME_SESSIONS.lock().unwrap().get(&sid).cloned() };
                if let Some(sess) = sess {
                    let owner = { RESUME_SESSION_OWNERS.lock().unwrap().get(&sid).cloned() };
                    let owner_ok = resume_owner_matches(owner, &account, &device);
                    if !owner_ok {
                        elog!("[p2p-tunnel] session-resume fail device={device} port={port} 会话归属不符");
                        let _ = socket.close().await;
                        return;
                    }
                    let replay_result = { sess.lock().unwrap().on_resume(replay_from) };
                    let replay = match replay_result {
                        Ok(v) => v,
                        Err(e) => {
                            elog!("[p2p-tunnel] session-resume fail device={device} port={port} {e}");
                            let _ = socket.close().await;
                            return;
                        }
                    };
                    // RESUME_ACK 告诉客户端：服务端已从客户端收到多少字节（recv_offset）。
                    // 不能用 acked_offset（那是客户端对服务端数据的确认方向，方向相反会误判越界）。
                    let acked = sess.lock().unwrap().recv_offset;
                    let ack = match resume_io.seal_control(
                        tunnel_resume_frames::T_RESUME_ACK,
                        &tunnel_resume_frames::encode_ack(acked),
                    ) {
                        Ok(v) => v,
                        Err(e) => {
                            elog!("[p2p-tunnel] session-resume fail device={device} port={port} {e}");
                            let _ = socket.close().await;
                            return;
                        }
                    };
                    if let Err(e) = socket.send(Message::Binary(ack)).await {
                        elog!("[p2p-tunnel] session-resume fail device={device} port={port} 回包失败 {e}");
                        let _ = socket.close().await;
                        return;
                    }
                    let replay_len = replay.len();
                    resume_pump = Some((resume_io, sess, replay_from, replay));
                    elog!("[p2p-tunnel] leg-switch device={device} port={port} replay_bytes={replay_len}");
                } else {
                    // RESUME miss（例如 x11vnc/提供端重启导致旧会话消失）：
                    // 回 SESSION_ACK 让客户端重置为新会话，而不是直接关连接、让 RFB 首字节丢失。
                    let sess = Arc::new(Mutex::new(tunnel_resume_frames::ResumeSession::new(sid)));
                    sess.lock().unwrap().on_leg_open();
                    RESUME_SESSIONS.lock().unwrap().insert(sid, sess.clone());
                    RESUME_SESSION_OWNERS.lock().unwrap().insert(sid, (account.clone(), device.clone()));
                    let ack = match resume_io.seal_control(
                        tunnel_resume_frames::T_SESSION_ACK,
                        &tunnel_resume_frames::encode_session_ack(&sid, 0).unwrap_or_default(),
                    ) {
                        Ok(v) => v,
                        Err(e) => {
                            elog!("[p2p-tunnel] session-resume fail device={device} port={port} {e}");
                            let _ = socket.close().await;
                            return;
                        }
                    };
                    if let Err(e) = socket.send(Message::Binary(ack)).await {
                        elog!("[p2p-tunnel] session-resume fail device={device} port={port} 回包失败 {e}");
                        let _ = socket.close().await;
                        return;
                    }
                    elog!("[p2p-tunnel] session-resume fallback-open device={device} port={port}");
                    resume_pump = Some((resume_io, sess, 0, Vec::new()));
                }
            }
        }
        elog!("[p2p-tunnel] session-resume ok device={device} port={port}");
    }
    let target = format!("127.0.0.1:{port}");
    let tcp = match tokio::time::timeout(
        Duration::from_secs(TUNNEL_UPSTREAM_TIMEOUT_SECS),
        TcpStream::connect(&target),
    )
    .await
    {
        Ok(Ok(t)) => t,
        other => {
            elog!(
                "[p2p-tunnel] 上游 {target} 连接失败: {:?}",
                other.err().map(|e| e.to_string())
            );
            audit_push(TunnelAudit {
                ts: chrono::Utc::now().timestamp_millis(),
                account,
                device,
                port,
                peer,
                result: "upstream-fail".to_string(),
            });
            let _ = socket.close().await;
            return;
        }
    };
    let _ = tcp.set_nodelay(true);
    elog!("[p2p-tunnel] upstream-ready {target} peer={peer} ms={}", t0.elapsed().as_millis());
    // 2026-10-23 真机排障（手机 forward 隧道 upgraded→closed 但目标服务零请求）：
    // 默认静默；`MYCO_TUNNEL_TRACE=1` 时打印"上游已连接"与"哪一侧先结束"，
    // 用于区分「根本没连上目标 / 连上但无数据 / 手机先关 / 上游先关」四种情况。
    let trace = std::env::var_os("MYCO_TUNNEL_TRACE").is_some();
    if trace {
        elog!("[p2p-tunnel] trace 上游 {target} 已连接 → 开始中继 {device}:{port} peer={peer}");
    }
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (tcp_rx, tcp_tx) = tcp.into_split();
    let resume_session = resume_pump.as_ref().map(|(_, s, _, _)| s.clone());
    // 建腿时的代际（SESSION_OPEN=1 / RESUME 后 +1）：收尾时只在仍是本代腿才标 Recovering。
    let leg_at_open = resume_pump.as_ref().map(|(_, s, _, _)| s.lock().unwrap().leg);
    let (res, first) = if let Some((mut resume_io, session, replay_from, replay)) = resume_pump {
        if !replay.is_empty() {
            let frame = resume_io.seal_data(replay_from, &replay);
            if ws_tx.send(Message::Binary(frame)).await.is_err() {
                return;
            }
        }
        let layer = ResumePumpLayer::new(resume_io, session);
        let up = resume_pump_up(tcp_rx, &mut ws_tx, &layer, None);
        let down = resume_pump_down(&mut ws_rx, tcp_tx, &layer);
        tokio::pin!(up);
        tokio::pin!(down);
        tokio::select! {
            r = &mut up => { let _ = tokio::time::timeout(TUNNEL_DRAIN_GRACE, &mut down).await; (r, "up(上游→ws)") }
            r = &mut down => { let _ = tokio::time::timeout(TUNNEL_DRAIN_GRACE, &mut up).await; (r, "down(ws→上游)") }
        }
    } else {
        let layer = PumpLayer::new(io);
        let up = pump_up(tcp_rx, &mut ws_tx, &layer, None);
        let down = pump_down(&mut ws_rx, tcp_tx, &layer);
        tokio::pin!(up);
        tokio::pin!(down);
        tokio::select! {
            r = &mut up => { let _ = tokio::time::timeout(TUNNEL_DRAIN_GRACE, &mut down).await; (r, "up(上游→ws)") }
            r = &mut down => { let _ = tokio::time::timeout(TUNNEL_DRAIN_GRACE, &mut up).await; (r, "down(ws→上游)") }
        }
    };
    if let (Some(sess), Some(leg_at_open)) = (resume_session, leg_at_open) {
        // 腿结束只标记 RECOVERING，不关逻辑会话；下一条腿用 RESUME 找回并重放。
        // 只在会话仍停在本代腿时才标——旧腿晚收尾不得把新腿打回 Recovering。
        let mut s = sess.lock().unwrap();
        if s.leg == leg_at_open {
            s.on_leg_dead(now_ms_i64());
        }
    }
    if trace {
        elog!(
            "[p2p-tunnel] trace 中继结束 {device}:{port} 先结束={first} result={:?}",
            res.as_ref().map(|_| ()).map_err(|e| e.to_string())
        );
    }
    if let Err(e) = res {
        elog!("[p2p-tunnel] 加密层错误（{e}）→ 关闭 {device}:{port}");
        audit_push(TunnelAudit {
            ts: chrono::Utc::now().timestamp_millis(),
            account: account.clone(),
            device: device.clone(),
            port,
            peer: peer.clone(),
            result: "enc-fail".to_string(),
        });
        return;
    }
    audit_push(TunnelAudit {
        ts: chrono::Utc::now().timestamp_millis(),
        account,
        device,
        port,
        peer,
        result: "closed".to_string(),
    });
}

/// resume 数据泵：把发送/接收偏移绑定到逻辑会话，RESUME 后可重放未确认数据。
struct ResumePumpLayer {
    io: Mutex<tunnel_resume_frames::ResumeIo>,
    session: Arc<Mutex<tunnel_resume_frames::ResumeSession>>,
}

impl ResumePumpLayer {
    fn new(io: tunnel_resume_frames::ResumeIo, session: Arc<Mutex<tunnel_resume_frames::ResumeSession>>) -> Self {
        ResumePumpLayer { io: Mutex::new(io), session }
    }

    fn seal(&self, plaintext: &[u8]) -> Vec<u8> {
        let mut s = self.session.lock().unwrap();
        let offset = s.send_next;
        s.on_local_data(plaintext);
        self.io.lock().unwrap().seal_data(offset, plaintext)
    }

    fn open(&self, frame: &[u8]) -> Result<tunnel_resume_frames::ResumeFrame, FrameError> {
        self.io.lock().unwrap().open(frame)
    }

    /// 接收偏移有推进时生成 ACK 帧；返回实际确认的 offset，避免重复发送。
    fn ack_frame(&self, last_acked: u64) -> Option<(u64, Vec<u8>)> {
        let recv = self.session.lock().unwrap().recv_offset;
        if recv <= last_acked { return None; }
        let frame = self.io.lock().unwrap().seal_control(
            tunnel_resume_frames::T_ACK,
            &tunnel_resume_frames::encode_ack(recv),
        ).ok()?;
        Some((recv, frame))
    }

    async fn feed_bytes<S, M>(&self, tx: &mut S, data: &[u8]) -> Result<(), FrameError>
    where
        S: futures_util::Sink<M> + Unpin,
        M: WsBinary,
    {
        let frame = self.seal(data);
        tx.feed(M::bin(frame))
            .await
            .map_err(|_| FrameError::Io("发送失败".into()))
    }
}

/// resume 上行：本机目标端口 → 带 offset 的密文 WS 帧。
async fn resume_pump_up<R, S, M>(mut tcp_rx: R, ws_tx: &mut S, layer: &ResumePumpLayer, mut close_rx: Option<&mut tokio::sync::mpsc::UnboundedReceiver<()>>) -> Result<(), FrameError>
where
    R: tokio::io::AsyncRead + Unpin,
    S: futures_util::Sink<M> + Unpin,
    M: WsBinary,
{
    let mut buf = vec![0u8; TUNNEL_CHUNK];
    const IDLE_FLUSH_MS: u64 = 2;
    let send_batch = tunnel_send_batch();
    let mut pending = 0usize;
    let mut last_ack_sent = 0u64;
    let mut goaway_sent = false;
    let t0 = std::time::Instant::now();
    let mut first_read = true;
    loop {
        // 恢复窗口到点：给对端明确 GOAWAY，而不是只在本端悄悄 CLOSED。
        let goaway = {
            let mut s = layer.session.lock().unwrap();
            s.tick(now_ms_i64());
            if !goaway_sent && s.state == tunnel_resume_frames::SessionState::Closed {
                let payload = tunnel_resume_frames::encode_goaway(
                    tunnel_resume_frames::GOAWAY_RECOVERY_TIMEOUT,
                    s.recv_offset,
                    s.send_next,
                );
                layer.io.lock().unwrap().seal_control(tunnel_resume_frames::T_GOAWAY, &payload).ok()
            } else {
                None
            }
        };
        if let Some(frame) = goaway {
            let _ = ws_tx.send(M::bin(frame)).await;
            goaway_sent = true;
            break;
        }
        if let Some((acked, frame)) = layer.ack_frame(last_ack_sent) {
            ws_tx.send(M::bin(frame)).await.map_err(|_| FrameError::Io("ACK 发送失败".into()))?;
            last_ack_sent = acked;
        }
        // 真背压：>256KB 暂停从本机 TCP 读入，等 ACK 释放缓冲；>128KB 轻微降速。
        // 不能只返回 ReadAction 枚举而继续读，否则恢复期间缓冲会无限增长。
        let read_action = layer.session.lock().unwrap().read_action();
        if read_action == tunnel_resume_frames::ReadAction::Pause {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            continue;
        }
        if read_action == tunnel_resume_frames::ReadAction::Throttled {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        tokio::select! {
            _ = async {
                if let Some(rx) = close_rx.as_mut() {
                    rx.recv().await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {
                let _ = ws_tx.send(M::close_frame()).await;
                return Err(FrameError::Io("leg-close".into()));
            }
            r = tcp_rx.read(&mut buf) => {
                match r {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if first_read {
                            elog!("[p2p-tunnel] pump-up-first-read ms={}", t0.elapsed().as_millis());
                            first_read = false;
                        }
                        layer.feed_bytes(ws_tx, &buf[..n]).await?;
                        pending += 1;
                        if pending >= send_batch {
                            let _ = futures_util::SinkExt::flush(ws_tx).await;
                            pending = 0;
                        }
                    }
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(IDLE_FLUSH_MS)) => {
                if pending > 0 {
                    let _ = futures_util::SinkExt::flush(ws_tx).await;
                    pending = 0;
                }
            }
        }
    }
    if pending > 0 {
        let _ = futures_util::SinkExt::flush(ws_tx).await;
    }
    // 正常收尾（本侧数据流结束）先发 GOAWAY：对端据此把这条腿当**自然结束**，
    // 不会把随后的 Close 误判成腿故障去重拨/RESUME（否则每条短请求都多一轮重拨）。
    let goaway_frame = {
        let payload = {
            let s = layer.session.lock().unwrap();
            tunnel_resume_frames::encode_goaway(
                tunnel_resume_frames::GOAWAY_USER_CLOSED,
                s.recv_offset,
                s.send_next,
            )
        };
        layer
            .io
            .lock()
            .unwrap()
            .seal_control(tunnel_resume_frames::T_GOAWAY, &payload)
            .ok()
    };
    if let Some(frame) = goaway_frame {
        let _ = ws_tx.send(M::bin(frame)).await;
    }
    let _ = ws_tx.send(M::close_frame()).await;
    Ok(())
}

/// resume 下行：密文 WS 帧 → 本机目标端口；ACK/GOAWAY 由会话层消费，不写进上游。
async fn resume_pump_down<R, W>(ws_rx: &mut R, mut tcp_tx: W, layer: &ResumePumpLayer) -> Result<(), FrameError>
where
    R: futures_util::Stream<Item = Result<Message, axum::Error>> + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let t0 = std::time::Instant::now();
    let mut first_frame = true;
    while let Some(m) = ws_rx.next().await {
        match m {
            Ok(Message::Binary(d)) => {
                if first_frame {
                    elog!("[p2p-tunnel] pump-down-first-frame ms={}", t0.elapsed().as_millis());
                    first_frame = false;
                }
                if d.len() > FRAME_MAX_PAYLOAD {
                    return Err(FrameError::AuthFail);
                }
                match layer.open(&d)? {
                    tunnel_resume_frames::ResumeFrame::Data { plaintext, .. } => {
                        layer.session.lock().unwrap().recv_offset += plaintext.len() as u64;
                        if tcp_tx.write_all(&plaintext).await.is_err() {
                            break;
                        }
                    }
                    tunnel_resume_frames::ResumeFrame::Control { type_, payload, .. } => {
                        match type_ {
                            tunnel_resume_frames::T_ACK => {
                                if let Ok(off) = tunnel_resume_frames::decode_ack(&payload) {
                                    layer.session.lock().unwrap().on_ack(off);
                                }
                            }
                            tunnel_resume_frames::T_GOAWAY => break,
                            _ => {}
                        }
                    }
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(e) => return Err(FrameError::Io(e.to_string())),
        }
    }
    let _ = tcp_tx.shutdown().await;
    Ok(())
}

/// 密文层（一读一写共用一个 [`FrameIo`]，因此需要锁——两个对泵方向是独立任务）。
pub(crate) struct PumpLayer {
    io: Mutex<FrameIo>,
}

impl PumpLayer {
    pub(crate) fn new(io: FrameIo) -> Self {
        PumpLayer { io: Mutex::new(io) }
    }

    /// 明文 → 密文帧字节。
    pub(crate) fn seal(&self, plaintext: &[u8]) -> Vec<u8> {
        self.io.lock().unwrap().seal(plaintext)
    }

    /// 密文帧字节 → 明文。
    pub(crate) fn open(&self, frame: &[u8]) -> Result<Vec<u8>, FrameError> {
        self.io.lock().unwrap().open(frame)
    }

    async fn send_bytes<S, M>(&self, tx: &mut S, data: &[u8]) -> Result<(), FrameError>
    where
        S: futures_util::Sink<M> + Unpin,
        M: WsBinary,
    {
        let frame = self.seal(data);
        tx.send(M::bin(frame))
            .await
            .map_err(|_| FrameError::Io("发送失败".into()))
    }

    /// 2026-10-22 吞吐优化（助手诊断：公网 RTT≈30ms 时在途只有 ~4 帧 = 141KB ≈ 4.7MB/s）：
    /// 只把密文帧**入发送缓冲**（`Sink::feed`），由调用方凑够一批再 `flush`。
    /// 这样一次 TCP flush 能带走多帧，在途字节数由批量大小决定，而不是"每帧一次往返"。
    async fn feed_bytes<S, M>(&self, tx: &mut S, data: &[u8]) -> Result<(), FrameError>
    where
        S: futures_util::Sink<M> + Unpin,
        M: WsBinary,
    {
        let frame = self.seal(data);
        tx.feed(M::bin(frame))
            .await
            .map_err(|_| FrameError::Io("发送失败".into()))
    }
}

/// WS 消息的二进制载荷包装（axum 与 tungstenite 的 `Message` 是**两个不同枚举**；
/// 对泵上行要同时服务服务端(axum)与客户端(tungstenite)，故抽一层）。
pub(crate) trait WsBinary: Sized {
    /// 密文二进制帧
    fn bin(d: Vec<u8>) -> Self;
    /// 关闭帧
    fn close_frame() -> Self;
}

impl WsBinary for Message {
    fn bin(d: Vec<u8>) -> Self {
        Message::Binary(d)
    }
    fn close_frame() -> Self {
        Message::Close(None)
    }
}

impl WsBinary for TMessage {
    fn bin(d: Vec<u8>) -> Self {
        TMessage::Binary(d)
    }
    fn close_frame() -> Self {
        TMessage::Close(None)
    }
}

/// 强制禁用 IPv6 直连候选（2026-10-22，E3 打洞实测开关）。
///
/// 为什么需要：本机/对端都有公网 IPv6 时，赛跑总是 v6 直连先胜，打洞腿（100ms 后加入）
/// 根本没机会被观测到。置 true 后候选里的 v6 地址被过滤，只剩 IPv4 直连/打洞/中继，
/// 从而能真实量出 E3（双方 NAT 打洞）的 path 与耗时。
pub static TUNNEL_DISABLE_IPV6: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub fn tunnel_disable_ipv6() -> bool {
    TUNNEL_DISABLE_IPV6.load(std::sync::atomic::Ordering::Relaxed)
}

pub fn set_tunnel_disable_ipv6(v: bool) -> bool {
    TUNNEL_DISABLE_IPV6.store(v, std::sync::atomic::Ordering::Relaxed);
    v
}

/// 候选是否 IPv6（`http://[240e:...]:9100` 这种方括号形态）。
fn candidate_is_ipv6(base: &str) -> bool {
    base.contains("://[")
}

/// 隧道上行批量帧数（在途窗口档位）。默认 8；`POST /api/vnet/tune {batch:N}` 可热调。
/// 依据（2026-10-22 实测+推算）：公网 RTT≈30ms 时吞吐 ≈ batch×32KB/RTT；
/// batch=4→~4.3MB/s、8→~8.5MB/s（实测 5.7-6.8，含损耗）、需 ~9 档才能到 10MB/s。
pub static TUNNEL_SEND_BATCH: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(16);

/// 读当前批量帧数（1..=64 夹取）。
pub fn tunnel_send_batch() -> usize {
    let v = TUNNEL_SEND_BATCH.load(std::sync::atomic::Ordering::Relaxed);
    v.clamp(1, 64)
}

/// 设置批量帧数（返回生效值）。
pub fn set_tunnel_send_batch(n: usize) -> usize {
    let v = n.clamp(1, 64);
    TUNNEL_SEND_BATCH.store(v, std::sync::atomic::Ordering::Relaxed);
    v
}

/// 上行：本机目标端口 → 密文 WS 帧。
async fn pump_up<R, S, M>(mut tcp_rx: R, ws_tx: &mut S, layer: &PumpLayer, mut close_rx: Option<&mut tokio::sync::mpsc::UnboundedReceiver<()>>) -> Result<(), FrameError>
where
    R: tokio::io::AsyncRead + Unpin,
    S: futures_util::Sink<M> + Unpin,
    M: WsBinary,
{
    let mut buf = vec![0u8; TUNNEL_CHUNK];
    // 批量帧数：默认 8 帧 × 32KB = 256KB/次 flush（≈公网 30ms RTT 下 8.5MB/s 的在途量）。
    // 2026-10-22：改为**运行时可变**（`POST /api/vnet/tune {batch:N}`），便于扫窗口档位找拐点，
    // 不必为每个档位重启进程。交互型流量（SSH 单键）不会被攒：数据一停 2ms 就 flush。
    const IDLE_FLUSH_MS: u64 = 2;
    let send_batch = tunnel_send_batch();
    let mut pending = 0usize;
    let t0 = std::time::Instant::now();
    let mut first_read = true;
    loop {
        tokio::select! {
            _ = async {
                if let Some(rx) = close_rx.as_mut() {
                    rx.recv().await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {
                let _ = ws_tx.send(M::close_frame()).await;
                return Err(FrameError::Io("leg-close".into()));
            }
            r = tcp_rx.read(&mut buf) => {
                match r {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if first_read {
                            elog!("[p2p-tunnel] pump-up-first-read ms={}", t0.elapsed().as_millis());
                            first_read = false;
                        }
                        layer.feed_bytes(ws_tx, &buf[..n]).await?;
                        pending += 1;
                        if pending >= send_batch {
                            let _ = futures_util::SinkExt::flush(ws_tx).await;
                            pending = 0;
                        }
                    }
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(IDLE_FLUSH_MS)) => {
                if pending > 0 {
                    let _ = futures_util::SinkExt::flush(ws_tx).await;
                    pending = 0;
                }
            }
        }
    }
    if pending > 0 {
        let _ = futures_util::SinkExt::flush(ws_tx).await;
    }
    let _ = ws_tx.send(M::close_frame()).await;
    Ok(())
}

/// 下行（服务端侧：axum 帧类型）。密文 WS 帧 → 本机目标端口。
async fn pump_down<R, W>(ws_rx: &mut R, mut tcp_tx: W, layer: &PumpLayer) -> Result<(), FrameError>
where
    R: futures_util::Stream<Item = Result<Message, axum::Error>> + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let t0 = std::time::Instant::now();
    let mut first_frame = true;
    while let Some(m) = ws_rx.next().await {
        match m {
            Ok(Message::Binary(d)) => {
                if first_frame {
                    elog!("[p2p-tunnel] pump-down-first-frame ms={}", t0.elapsed().as_millis());
                    first_frame = false;
                }
                if d.len() > FRAME_MAX_PAYLOAD {
                    return Err(FrameError::AuthFail);
                }
                let data = layer.open(&d)?;
                if tcp_tx.write_all(&data).await.is_err() {
                    break;
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(e) => return Err(FrameError::Io(e.to_string())),
        }
    }
    let _ = tcp_tx.shutdown().await;
    Ok(())
}

/// 下行（客户端侧：tungstenite 帧类型；两侧错误类型不同，故不共用一份实现）。
async fn write_all_client_local<W>(
    tcp_tx: &mut W,
    data: &[u8],
    timeout: Option<Duration>,
) -> Result<(), FrameError>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let write = tokio::io::AsyncWriteExt::write_all(tcp_tx, data);
    match timeout {
        None => write.await.map_err(|e| FrameError::Io(e.to_string())),
        Some(timeout) => match tokio::time::timeout(timeout, write).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(FrameError::Io(e.to_string())),
            Err(_) => Err(FrameError::Io("local-write-stall".to_string())),
        },
    }
}

async fn pump_down_client<R, W>(
    ws_rx: &mut R,
    mut tcp_tx: W,
    layer: &PumpLayer,
) -> Result<(), FrameError>
where
    R: futures_util::Stream<Item = Result<TMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let t0 = std::time::Instant::now();
    let mut first_frame = true;
    while let Some(m) = ws_rx.next().await {
        match m {
            Ok(TMessage::Binary(d)) => {
                if first_frame {
                    elog!("[p2p-tunnel] pump-down-first-frame ms={}", t0.elapsed().as_millis());
                    first_frame = false;
                }
                if d.len() > FRAME_MAX_PAYLOAD {
                    return Err(FrameError::AuthFail);
                }
                let data = layer.open(&d)?;
                if let Err(e) =
                    write_all_client_local(&mut tcp_tx, &data, LOCAL_WRITE_STALL_TIMEOUT).await
                {
                    elog!("[p2p-tunnel] 本地目标写入失败，关闭隧道：{e}");
                    return Err(e);
                }
            }
            Ok(TMessage::Close(_)) => return Err(FrameError::Io("ws closed".into())),
            Ok(_) => {}
            Err(e) => return Err(FrameError::Io(e.to_string())),
        }
    }
    let _ = tcp_tx.shutdown().await;
    Ok(())
}

// ══════════════════ 客户端：本地临时监听 + 并行赛跑选路 ══════════════════

type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

/// Power guard 只看 **live 连接数**，不看 TUNNELS.len()：
/// M1-2 聊天兜底隧道和 keep 移除路径可能留下无主 listener（独立评审 P1）。
/// listener 空挂不阻止睡眠；第一条连接进入立刻持有，最后一条结束立刻释放。
fn stats_power_busy<'a>(stats: impl Iterator<Item = &'a TunnelStat>) -> bool {
    for s in stats {
        if s.live.load(std::sync::atomic::Ordering::SeqCst) > 0 {
            return true;
        }
    }
    false
}

/// 反向连接池的活数据连接数（dialing 不算；已连上本机上游后才算）。
/// REVERSE_POOL 不建 TUNNELS 条目，Modern Standby 口径必须单独计入。
static REVERSE_LIVE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

struct ReverseLiveGuard;

impl ReverseLiveGuard {
    fn new() -> Self {
        REVERSE_LIVE.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        refresh_power_guard();
        Self
    }
}

impl Drop for ReverseLiveGuard {
    fn drop(&mut self) {
        REVERSE_LIVE.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        refresh_power_guard();
    }
}

/// 纯谓词：任一正向 live 连接或任一反向已建立数据连接，都禁止 Modern Standby。
fn vnet_power_busy<'a>(
    forward_stats: impl Iterator<Item = &'a TunnelStat>,
    reverse_live: usize,
) -> bool {
    stats_power_busy(forward_stats) || reverse_live > 0
}

/// 串行化“读 TUNNELS → 施效 GUARD”的整个临界区：并发 enter/leave 的 apply
/// 不能乱序（独立复审 R1——否则最后一条 leave 可能覆盖并发首连接 acquire）。
static POWER_REFRESH_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn refresh_power_guard() {
    let _serial = POWER_REFRESH_LOCK.lock().unwrap();
    let busy = {
        let tunnels = TUNNELS.lock().unwrap();
        let forward = tunnels.values().map(|e| e.stat.as_ref());
        vnet_power_busy(
            forward,
            REVERSE_LIVE.load(std::sync::atomic::Ordering::SeqCst),
        )
    };
    crate::power_guard::vnet_activity_changed(busy);
}

/// 隧道"活着"的证据（**不含任何身份/内容**，只计数与时间戳）。
///
/// 为什么需要它（2026-10-09「断线无感重连」）：本地监听端口是**长命**的，而上层
/// （`dsh_share` 的 `TUNNEL_IDLE_MS` 回收环）**看不见**隧道里有没有流量——它的
/// `last_used` 只在"点卡"（`tunnel_acquire`）时刷新。于是一个正被手机看着的分享页，
/// 30 分钟后会被当成"空闲"把脚下端口抽掉：页面所有请求瞬间 ECONNREFUSED，
/// 用户看到的就是"白屏/报错，要重新点卡"。本结构把传输层**真实的活动**暴露给回收环。
struct TunnelStat {
    /// 当前活着的本地连接数（一个 HTTP keep-alive / 一条 mux WS 都算一条）。
    live: std::sync::atomic::AtomicUsize,
    /// 最近一次活动（accept / 连接结束）的毫秒时间戳。
    last_activity_ms: std::sync::atomic::AtomicU64,
}

impl TunnelStat {
    fn new() -> Arc<Self> {
        Arc::new(TunnelStat {
            live: std::sync::atomic::AtomicUsize::new(0),
            last_activity_ms: std::sync::atomic::AtomicU64::new(now_ms_i64() as u64),
        })
    }
    fn enter(&self) {
        self.live.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.touch();
        refresh_power_guard();
    }
    fn leave(&self) {
        self.live.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        self.touch();
        refresh_power_guard();
    }
    fn touch(&self) {
        self.last_activity_ms
            .store(now_ms_i64() as u64, std::sync::atomic::Ordering::SeqCst);
    }
    fn busy(&self, now: u64, idle_ms: u64) -> bool {
        if self.live.load(std::sync::atomic::Ordering::SeqCst) > 0 {
            return true;
        }
        now.saturating_sub(
            self.last_activity_ms
                .load(std::sync::atomic::Ordering::SeqCst),
        ) < idle_ms
    }
}

fn now_ms_i64() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

struct TunnelEntry {
    device_did: String,
    target_port: u16,
    local_port: u16,
    task: tokio::task::JoinHandle<()>,
    stat: Arc<TunnelStat>,
}

static TUNNELS: LazyLock<Mutex<std::collections::HashMap<String, TunnelEntry>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// 逻辑会话跨腿保存（SESSION_OPEN 建立，RESUME 找回并重放未确认数据）。
static RESUME_SESSIONS: LazyLock<
    Mutex<std::collections::HashMap<[u8; 16], Arc<Mutex<tunnel_resume_frames::ResumeSession>>>>,
> = LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// 会话归属（account, device）：RESUME 必须同身份，不能凭 sid 读别人的重放数据。
static RESUME_SESSION_OWNERS: LazyLock<
    Mutex<std::collections::HashMap<[u8; 16], (String, String)>>,
> = LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// 活跃传输腿的 AbortHandle 与正常关闭信号（先 close，再必要时 abort）。
static ACTIVE_LEGS: LazyLock<
    Mutex<
        std::collections::HashMap<
            String,
            (String, u16, tokio::task::AbortHandle, tokio::sync::mpsc::UnboundedSender<()>),
        >,
    >,
> = LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// 客户端 RESUME 的重拨计划（目标设备 → bases/active）。旧腿死后先重拨，再 RESUME。
static REDIAL_PLANS: LazyLock<
    Mutex<std::collections::HashMap<String, (Arc<Mutex<Vec<String>>>, Arc<Mutex<String>>)>>,
> = LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// 单腿守卫：**只在会话还停在"本腿"时才标 RECOVERING**。
///
/// 2026-11-02 真案：旧腿的泵晚于新腿返回时，旧守卫会把已经换到新腿的会话重新
/// 标成 Recovering —— 新腿上正常流动的数据随后被当成"需要重放"，再触发偏移风暴。
/// 记下建守卫时的 `leg` 号，drop 时只认这一代。
struct ResumeLegGuard {
    session: Arc<Mutex<tunnel_resume_frames::ResumeSession>>,
    leg: u32,
}
impl ResumeLegGuard {
    fn new(session: Arc<Mutex<tunnel_resume_frames::ResumeSession>>) -> Self {
        let leg = session.lock().unwrap().leg;
        ResumeLegGuard { session, leg }
    }
}
impl Drop for ResumeLegGuard {
    fn drop(&mut self) {
        let mut s = self.session.lock().unwrap();
        if s.leg == self.leg {
            s.on_leg_dead(now_ms_i64());
        }
    }
}

// 2026-11-02 真案：客户端逻辑会话**必须按本地 TCP 连接**持有，不能放进程级静态表。
// 旧实现按 `local#target#port` 分键跨连接复用 → 同一 forward 的并发连接
// （浏览器多连接 / vnet-keeper 探活 / 页面 mux WS）共用一个 send_next/recv_offset，
// 双方偏移互踩 → 每条 RESUME 都 `RESUME 偏移不在已确认/已发送区间内` 或
// `resume-ack closed` → 15s 重拨风暴、请求被强制关闭（笔记本 DSH 真机 RED）。
// resume 的语义是"这一条上层 TCP 流跨腿续传"，键就只能是连接级（见
// `resume_pump_client_inner` 里现建的 Arc<Mutex<ResumeSession>>）。

fn resume_enabled() -> bool {
    matches!(std::env::var("MYCO_TUNNEL_RESUME").ok().as_deref(), Some("1") | Some("true") | Some("yes") | Some("on"))
}

fn resume_requested(hs_raw: &str) -> bool {
    serde_json::from_str::<TunnelHandshake>(hs_raw)
        .map(|h| h.resume_capable())
        .unwrap_or(false)
}

fn client_resume_session_key(local_device: &str, target_device: &str, port: u16) -> String {
    format!("{local_device}#{target_device}#{port}")
}

/// 连接级逻辑会话 id：`H(键 + 一次性 nonce)`。
///
/// 同一 forward 上并发多条本地连接时，sid 必须各不相同（否则提供端 RESUME 会
/// 命中别人的会话）；因此 nonce 是必需项而不是装饰。
fn new_client_resume_sid(key: &str) -> [u8; 16] {
    let digest = Sha256::digest(format!("{key}:{}", next_nonce()).as_bytes());
    let mut sid = [0u8; 16];
    sid.copy_from_slice(&digest[..16]);
    sid
}

/// 逻辑会话按**本地连接**隔离：同一设备+端口的不同 TCP 连接不能共享待发缓冲/ACK。
/// 换腿只在同一个本地连接内恢复，避免 HTTP 多连接互相拖住。
fn client_resume_session_key_with_scope(local_device: &str, target_device: &str, port: u16, scope: &str) -> String {
    format!("{}#{scope}", client_resume_session_key(local_device, target_device, port))
}

fn resume_owner_matches(owner: Option<(String, String)>, account: &str, device: &str) -> bool {
    owner
        .map(|(acc, dev)| acc == account && myco_core::identity::did_equiv(&dev, device))
        .unwrap_or(false)
}

/// 设备 DID 归一（**同钥同键**）：`did:myco:z…` 与 `did:youling:z…` 是同一把
/// 设备钥的两种合法写法，卡上带哪种前缀不由建链方决定。不归一会让同一
/// (设备,端口) 在表里分裂成两条：`tunnel_local_port` miss → 误判离线/重复建链，
/// 第二次还想 bind 同一个固定口 → `固定本地口绑定失败`。
///
/// 解析不出公钥的串（软 did / 测试假 DID）原样返回——键仍是稳定的。
fn did_key(device_did: &str) -> String {
    myco_core::identity::account_did_canonical(device_did)
}

fn tunnel_key(device_did: &str, target_port: u16) -> String {
    format!(
        "{}#{}",
        did_key(device_did).replace([':', '/'], "_"),
        target_port
    )
}

/// 这条隧道**现在是否在用**（有活连接，或 `idle_ms` 内有过活动）。
///
/// 给上层的空闲回收环用：`true` 就**别回收**——回收的是用户正看着的那个端口。
/// 隧道不存在 → `false`（调用方本来就要把它从自己的表里摘掉）。
pub fn tunnel_in_use(target_device_did: &str, target_port: u16, idle_ms: u64) -> bool {
    let now = now_ms_i64() as u64;
    let g = TUNNELS.lock().unwrap();
    match g.get(&tunnel_key(target_device_did, target_port)) {
        Some(e) => e.stat.busy(now, idle_ms),
        None => false,
    }
}

// ── 2026-10-11 提速：连接模式记录 + 隧道预热连接池 ──
//
// 模式记录：每条 (设备,端口) 隧道**最近一次胜出**的连接腿（direct / relay）。
// 消费者：dsh_share::remote_open 把它随 302 fragment（#mycoConn=）交给页面，
// 页面状态指示器显示 ⚡/☁️（设计定稿设计）。逐连接降级时以最后胜出为准。

/// base → 人话模式（纯函数，单测直击）：`relay://` 标记 = 云端中继，其余 = 直连。
pub(crate) fn mode_of_base(base: &str) -> &'static str {
    if base.starts_with(RELAY_BASE) {
        "relay"
    } else {
        "direct"
    }
}

/// (设备,端口) → 最近一次胜出的连接模式。
static TUNNEL_MODES: LazyLock<Mutex<std::collections::HashMap<String, &'static str>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

fn tunnel_mode_put(device_did: &str, target_port: u16, mode: &'static str) {
    TUNNEL_MODES
        .lock()
        .unwrap()
        .insert(tunnel_key(device_did, target_port), mode);
}

/// 这条隧道最近一次胜出的连接模式（"direct" | "relay"；无记录 = None）。
/// dsh_share 的 remote_open 在隧道建立后读一次，交给页面指示器。
pub fn tunnel_mode(target_device_did: &str, target_port: u16) -> Option<&'static str> {
    TUNNEL_MODES
        .lock()
        .unwrap()
        .get(&tunnel_key(target_device_did, target_port))
        .copied()
}

// ── 预热连接池（3s 打开目标的关键一刀）──
//
// 现状：隧道本地口上的**每条浏览器 TCP 连接**都要自跑一场赛跑 + WS 升级 +
// AEAD 握手（中继腿 ≈4-5×RTT，跨网 ~500ms）；SPA 首屏并行开 3-6 条连接，
// 首条都要各付一遍。预热池在**隧道建立后**（用户还没点开页面/还在等 302）
// 预先赛跑好 N 条（WS 已升级、握手原文在手；AEAD 握手留给使用时——服务端
// `crypto_handshake_server` 无超时地等 HELLO，池连接可以安静挂着），浏览器
// 连接一到**零等待**直通，用掉一条立刻后台补一条。
//
// 生命周期护栏：只给"刚建立或仍在活跃窗口（90s 内有人用）"的隧道养池，
// 窗口外清池收工（不为没人看的页面白养连接）；池条目自身 60s 过期
// （中继服务端会话空闲上限 15min，留足余量）。测试构建默认关闭
// （`test_set_warm` 显式开——不扰动既有单测的连接计数断言）。

/// 预热池深度：SPA 首屏并发的常见上限（浏览器同源 HTTP/1.1 ≈6 连接）。
pub const WARM_POOL_DEPTH: usize = 3;
/// 实际池深（2026-10-14 P1 真案：默认 3 只够半屏——浏览器一次并发 ~6，池被抽干后
/// 剩下的请求每个都要现配对；中继腿上就是"首开 6.5~15.9s"）。
/// 默认提到 6；测试可用旗标文件 `~/.youling/test-warm-depth`（内容为数字）动态改，
/// 便于同一二进制做 A/B 量化。
fn warm_depth() -> usize {
    std::env::var("MYCO_TUNNEL_WARM_DEPTH")
        .ok()
        .and_then(|s| s.trim().parse::<usize>().ok())
        .or_else(|| {
            let f = format!("{}/.youling/test-warm-depth", crate::dsh_share::dirs_home());
            std::fs::read_to_string(f)
                .ok()
                .and_then(|s| s.trim().parse::<usize>().ok())
        })
        .unwrap_or(6)
        .clamp(1, 16)
}
/// 单轮最多并发补几条（防瞬间把中继/直连拨号机打满）。
const WARM_REFILL_BURST: usize = 8;
/// 测试注入：强制只走中继腿（`~/.youling/test-force-relay` 存在时）——
/// 无 IPv6 / NAT / 移动网场景的确定性复现（生产无此文件，恒 false）。
pub(crate) fn force_relay() -> bool {
    let f = format!(
        "{}/.youling/test-force-relay",
        crate::dsh_share::dirs_home()
    );
    std::path::Path::new(&f).is_file()
}
/// 池条目寿命（入池起算；过期弃用——宁可再生一场赛跑，不赌陈年连接）。
const WARM_TTL: Duration = Duration::from_secs(60);
/// 2026-10-21（O14 断线重连）：本地浏览器连接**先接住**，在最多 2.5s 内持续尝试
/// 拨通上游隧道，而不是一次失败就关本地 socket——页面 WS 重连的第一次尝试
/// 往往打在「网络刚恢复/隧道未就绪」的窗口里，立即失败会让客户端退避到下一秒（3-5s）。
const TUNNEL_CONN_GRACE_MS: u64 = 2_500;
/// 养池活跃窗口：隧道建立起 / 最近一次取用起 90s 内才养（闲置即清池收工）。
const WARM_WINDOW: Duration = Duration::from_secs(90);
/// 养池循环的巡检间隔（补池/续期判定的节拍）。2026-10-14：700ms→300ms，
/// 页面并发抽干后更快续上（并发补池已把单轮耗时压到一场配对）。
const WARM_TICK: Duration = Duration::from_millis(300);

/// 一条预热好的上游连接（WS 已升级；`hs` = 该连接自己的握手原文，绑 nonce）。
struct WarmConn {
    base: String,
    ws: WsStream,
    hs: String,
    born: std::time::Instant,
}

/// 每条隧道的预热池。
static WARM_POOL: LazyLock<
    Mutex<std::collections::HashMap<String, std::collections::VecDeque<WarmConn>>>,
> = LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// 每条隧道的"最近活跃"时刻（建立/取用即刷新）。
static WARM_TOUCH: LazyLock<Mutex<std::collections::HashMap<String, std::time::Instant>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// 在跑的 warmer 标记（防重复启动；warmer 收工时摘除）。
static WARM_RUNNERS: LazyLock<Mutex<std::collections::HashSet<String>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

/// 测试注入的预热开关（未注入 = 测试态默认关）。
#[cfg(test)]
static TEST_WARM: LazyLock<std::sync::atomic::AtomicBool> =
    LazyLock::new(|| std::sync::atomic::AtomicBool::new(false));

/// 预热是否启用：测试态看 [`TEST_WARM`]；生产 `MYCO_TUNNEL_WARM=0` 可关。
fn warm_enabled() -> bool {
    #[cfg(test)]
    {
        return TEST_WARM.load(std::sync::atomic::Ordering::SeqCst);
    }
    #[cfg(not(test))]
    {
        !matches!(
            std::env::var("MYCO_TUNNEL_WARM").unwrap_or_default().trim(),
            "0" | "false" | "off"
        )
    }
}

/// 测试注入：显式开/关预热池（默认关——既有单测的连接计数不被扰动）。
#[cfg(test)]
pub(crate) fn test_set_warm(on: bool) {
    TEST_WARM.store(on, std::sync::atomic::Ordering::SeqCst);
}

/// 池条目是否仍新鲜（纯函数，单测直击）。
fn warm_fresh(born: std::time::Instant, now: std::time::Instant) -> bool {
    now.duration_since(born) < WARM_TTL
}

/// 活跃窗口判定（纯函数，单测直击）：`true` = 该隧道仍在养池窗口内。
fn warm_window_open(last_touch: std::time::Instant, now: std::time::Instant) -> bool {
    now.duration_since(last_touch) < WARM_WINDOW
}

/// 清空某隧道的预热池（优雅关连接，幂等；关帧走后台任务——本函数是同步的）。
fn warm_drain(key: &str) {
    let mut g = WARM_POOL.lock().unwrap();
    if let Some(mut q) = g.remove(key) {
        while let Some(c) = q.pop_front() {
            tokio::spawn(async move {
                let mut ws = c.ws;
                let _ = ws.close(None).await;
            });
        }
    }
}

/// 取一条新鲜预热连接（FIFO，先入先用；过期条目就地丢弃）。
/// 命中即刷新活跃窗口（池还被人用，warmer 继续养）。
fn warm_pop(device_did: &str, target_port: u16) -> Option<(String, WsStream, String)> {
    let key = tunnel_key(device_did, target_port);
    let now = std::time::Instant::now();
    let mut g = WARM_POOL.lock().unwrap();
    let q = g.get_mut(&key)?;
    // 从头取新鲜的；过期的关掉扔掉
    loop {
        let front_born = q.front().map(|c| c.born);
        match front_born {
            Some(b) if warm_fresh(b, now) => {
                let c = q.pop_front()?;
                if let Some(t) = WARM_TOUCH.lock().unwrap().get_mut(&key) {
                    *t = now;
                }
                return Some((c.base, c.ws, c.hs));
            }
            Some(_) => {
                if let Some(stale) = q.pop_front() {
                    tokio::spawn(async move {
                        let mut ws = stale.ws;
                        let _ = ws.close(None).await;
                    });
                }
            }
            None => return None,
        }
    }
}

/// 为隧道启动预热循环（幂等：已有 warmer 在养 → 只刷新活跃窗口）。
/// `bases` = 有序候选（`ordered`，活跃 base 排最前——warmer 赛跑用同一口径）。
fn warm_start(device_did: &str, target_port: u16, bases: Vec<String>) {
    // 测试注入：强制中继时**丢掉直连候选**（复现"无 IPv6/NAT 只能中继"）。
    let bases: Vec<String> = if force_relay() { Vec::new() } else { bases };
    if !warm_enabled() || (bases.is_empty() && !relay_ready()) {
        return;
    }
    let key = tunnel_key(device_did, target_port);
    {
        let runners = WARM_RUNNERS.lock().unwrap();
        if runners.contains(&key) {
            // 已有 warmer：续窗即可（它自己的循环会按窗口/存续判定收工）
            if let Some(t) = WARM_TOUCH.lock().unwrap().get_mut(&key) {
                *t = std::time::Instant::now();
            }
            return;
        }
    }
    WARM_RUNNERS.lock().unwrap().insert(key.clone());
    WARM_TOUCH
        .lock()
        .unwrap()
        .insert(key.clone(), std::time::Instant::now());
    let dev = device_did.to_string();
    tokio::spawn(async move {
        loop {
            let now = std::time::Instant::now();
            // 隧道没了 / 窗口过了 → 清池收工
            let gone = !TUNNELS.lock().unwrap().contains_key(&key);
            let expired = WARM_TOUCH
                .lock()
                .unwrap()
                .get(&key)
                .map(|t| !warm_window_open(*t, now))
                .unwrap_or(true);
            if gone || expired {
                warm_drain(&key);
                WARM_TOUCH.lock().unwrap().remove(&key);
                WARM_RUNNERS.lock().unwrap().remove(&key);
                elog!("[p2p-tunnel] 预热池收工（{key}）");
                return;
            }
            // 补池：**按缺口并发补**（2026-10-14 P1 真案根修）。
            // 原实现每 tick 只赛跑一场、补 1 条（间隔 700ms）：中继腿单场配对 0.5~2s ⇒
            // 池被页面首屏并发一次抽干后要数秒才续上，期间每个请求都现配对——笔记本在
            // 无 IPv6（只能走中继）时首开 6.5~15.9s。改为一次并发拨 `缺口` 条。
            let live = WARM_POOL
                .lock()
                .unwrap()
                .get(&key)
                .map(|q| q.iter().filter(|c| warm_fresh(c.born, now)).count())
                .unwrap_or(0);
            let depth = warm_depth();
            if live < depth {
                let want = (depth - live).min(WARM_REFILL_BURST);
                let mut handles = Vec::with_capacity(want);
                for _ in 0..want {
                    let bases = bases.clone();
                    let dev2 = dev.clone();
                    // 预热腿不打洞（打洞信令按设备限频，省着用；直连/中继已覆盖绝大多数）
                    let relay = relay_ready().then(|| RelayPlan {
                        device: dev2.clone(),
                    });
                    handles.push(tokio::spawn(async move {
                        dial_with_context(
                            &dev2,
                            &bases,
                            target_port,
                            ROUTE_EXPLORE_DIAL_TIMEOUT,
                            RACE_TOTAL_BUDGET,
                            None,
                            relay,
                        )
                        .await
                    }));
                }
                let mut refilled = 0usize;
                for h in handles {
                    if let Ok(Some((base, ws, hs))) = h.await {
                        WARM_POOL
                            .lock()
                            .unwrap()
                            .entry(key.clone())
                            .or_default()
                            .push_back(WarmConn {
                                base,
                                ws,
                                hs,
                                born: std::time::Instant::now(),
                            });
                        refilled += 1;
                    }
                }
                if refilled == 0 {
                    // 一场都没成（真不可达/中继没就绪）→ 退避一拍，不热旋
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
            }
            tokio::time::sleep(WARM_TICK).await;
        }
    });
}

// ── 成功路径缓存（建连提速：上次通的 base 优先；有过期保护） ──

/// 缓存新鲜期：过期 base 不排最前（但仍作为候选参与赛跑——并行不额外花钱）。
const CACHE_TTL: Duration = Duration::from_secs(300);
static CACHE: LazyLock<Mutex<std::collections::HashMap<String, (String, std::time::Instant)>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// 记下某设备最后一次成功的 base（供下次抢先试）。
fn cache_put(device_did: &str, base: &str) {
    let key = device_did.replace([':', '/'], "_");
    let mut g = CACHE.lock().unwrap();
    if g.len() > 64 {
        g.retain(|_, (_, t)| t.elapsed() < CACHE_TTL);
    }
    g.insert(key, (base.to_string(), std::time::Instant::now()));
}

/// 取缓存 base（按过期丢弃）。
fn cache_get(device_did: &str) -> Option<String> {
    let key = device_did.replace([':', '/'], "_");
    let g = CACHE.lock().unwrap();
    g.get(&key).and_then(|(b, t)| {
        if t.elapsed() < CACHE_TTL {
            Some(b.clone())
        } else {
            None
        }
    })
}

#[cfg(test)]
pub(crate) fn test_clear_cache() {
    CACHE.lock().unwrap().clear();
}

/// 候选合并（纯函数，单测直击）：**缓存优先 → 显式候选 → 本机地址**，
/// 去重保序（第一次出现的位置即优先级；首尾空白与尾斜杠归一）。
pub(crate) fn merge_candidates(
    cached: Option<&str>,
    explicit: &[String],
    local: &[String],
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut groups: Vec<&str> = Vec::new();
    if let Some(c) = cached {
        groups.push(c);
    }
    groups.extend(explicit.iter().map(String::as_str));
    groups.extend(local.iter().map(String::as_str));
    for s in groups {
        let t = s.trim().trim_end_matches('/');
        if !t.is_empty() && !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
    }
    out
}

/// 建连失败的人话原因（把"候选清单的实际构成"翻成用户能懂的话）。
pub(crate) fn no_route_hint(target_name: &str, n: usize, with_local: bool) -> String {
    let tail = if with_local {
        "（候选含本机地址）= 双方都没有对方可达的地址：若两边都在 NAT 后面且没有端口映射/\
         锥形 NAT/全球 IPv6，没有中继就打不通。可让一侧开公网 IPv4 端口映射、或用 IPv6、\
         或后续接 TURN 式中继。"
    } else {
        "候选=对端 presence 上报的地址（本次未并入本机地址）。"
    };
    format!("{target_name} 的 {n} 个候选地址都连不上隧道端点{tail}")
}

// ══════════════════════════════════════════════════════════════════════════
// AOP Phase 1：S（状态持久化）/ C（网络识别）/ D（缓存路由优先）
// 设计：eval/vnet/task.md 的 S/C/D 三节（2026-10-24 task-20）。
//
// 解决的问题：现有 CACHE 只有 300s 内存缓存——myco 重启/换网络即"失忆"，
// 每次冷启动都要重新赛跑全部候选（首连慢 + 败者取消噪声）。S 层把
// **哪个网络下到哪台设备走哪条路由最快** 变成跨重启、分网络的持久记忆：
//   S：NetworkContext（≤16 槽 LRU，按网络指纹分档）+ 落盘 vnet-contexts.json
//   C：从本机接口派生网络指纹（IPv6 前 3 段 → IPv4 /24 网段兜底），网络变化切上下文
//   D：连接决策——有可用缓存路由先单拨它（800ms），失败才探索赛跑（2000ms）
// 结果写回 S（成功/失败/RTT/冷却），并 audit `vnet-route-hit` 供 R7 命中率统计。
// 纪律：S 层只是**派生记忆**，坏文件/写失败一律降级（不炸连接路径）；路由命中
// 只影响选路顺序，不改变任何授权/白名单判定。
// ══════════════════════════════════════════════════════════════════════════

/// S 层槽数上限（设计文档：≤16 个命名网络上下文）。
pub(crate) const NET_CTX_MAX: usize = 16;
/// 网络指纹缓存 TTL：网络变化事件之外的 60s 兜底刷新。
const NET_ID_TTL_MS: u64 = 60_000;
/// 连续失败达到该值 → 路由进入冷却（设计 §C：ipv6 超时 → 冷却 300s）。
pub(crate) const ROUTE_COOLDOWN_FAILS: u32 = 3;
/// 路由冷却时长（设计 §D：300s）。
pub(crate) const ROUTE_COOLDOWN_MS: u64 = 300_000;
/// D 层缓存路由单拨超时（设计：800ms）。
pub(crate) const ROUTE_CACHE_DIAL_TIMEOUT: Duration = Duration::from_millis(800);
/// D 层探索赛跑的单候选超时（设计：2000ms）。
pub(crate) const ROUTE_EXPLORE_DIAL_TIMEOUT: Duration = Duration::from_millis(2000);

/// 一条已验证的 peer 路由（S 层 `peer_routes` 的值）。
fn default_peer_listen_port() -> u16 { 9100 }

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
struct PeerRoute {
    /// 上次成功的完整 URL（如 `ws://[240e:...]:9100`；connect_tunnel 内部会归一）。
    preferred_base: String,
    /// `direct` | `relay`（取自 base：relay:// 前缀 = 云端中继）。
    preferred_mode: String,
    /// 上次实测 RTT（毫秒）。
    rtt_ms: u64,
    /// 候选地址类别（`classify_candidate_kind`：lan_v4/public_v4/ipv6_stable/
    /// ipv6_temporary/reflexive/relay/loopback/unknown）。L2/L3 状态复用用。
    kind: String,
    /// 实际打通的对端监听端口（EndpointLease 的一部分；默认 9100，成功后按真实值覆盖）。
    #[serde(default = "default_peer_listen_port")]
    peer_listen_port: u16,
    success_count: u32,
    fail_count: u32,
    /// 连续失败后的冷却截止时间（epoch ms；0 = 无冷却）。
    cooldown_until: u64,
    last_used: u64,
}

impl PeerRoute {
    /// D 层判定核（纯函数，单测直击）：此刻能否走"缓存路由单拨"。
    fn cacheable(&self, now: u64) -> bool {
        !self.preferred_base.trim().is_empty() && self.cooldown_until <= now
    }
}

/// 一个命名网络上下文（S 层）。
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
struct NetworkContext {
    /// 网络指纹（IPv6 前 3 段 / IPv4 /24 网段 / `unknown`）。
    network_id: String,
    /// device_did → 已验证路由。
    peer_routes: std::collections::HashMap<String, PeerRoute>,
    created_at: u64,
    last_active: u64,
    total_connects: u32,
    successful_connects: u32,
}

impl NetworkContext {
    fn new(network_id: &str, now: u64) -> Self {
        NetworkContext {
            network_id: network_id.to_string(),
            peer_routes: std::collections::HashMap::new(),
            created_at: now,
            last_active: now,
            total_connects: 0,
            successful_connects: 0,
        }
    }

    /// 成功率（无样本 = 1.0；用于 LRU 平手时的降权与诊断）。
    fn success_rate(&self) -> f64 {
        if self.total_connects == 0 {
            1.0
        } else {
            self.successful_connects as f64 / self.total_connects as f64
        }
    }
}

/// 落盘形状（`vnet-contexts.json`）。
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
struct NetworkContextsFile {
    contexts: Vec<NetworkContext>,
}

/// 进程内 S 层存储：网络指纹 → 上下文槽；`current` 只是诊断/最近使用标记。
struct NetworkContextStore {
    loaded: bool,
    current: Option<String>,
    /// 网络指纹 + 采集时刻（60s 兜底刷新，避免每次 dial 都探测接口）。
    net_id_cache: Option<(String, u64)>,
    contexts: std::collections::HashMap<String, Arc<Mutex<NetworkContext>>>,
}

static NET_CTX: LazyLock<Mutex<NetworkContextStore>> = LazyLock::new(|| {
    Mutex::new(NetworkContextStore {
        loaded: false,
        current: None,
        net_id_cache: None,
        contexts: std::collections::HashMap::new(),
    })
});

/// R7 命中率统计（无需解析日志即可读）。
static ROUTE_HIT_CACHE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static ROUTE_HIT_RACE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static ROUTE_CACHE_FAIL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 异步落盘的 dirty/running 门（合并短时间内的多次变更）。
static CTX_SAVE_DIRTY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static CTX_SAVE_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 路由命中统计 `(cache_hits, race_hits, cache_fails)`（R7 用；当前由测试/诊断消费）。
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn route_hit_stats() -> (u64, u64, u64) {
    use std::sync::atomic::Ordering;
    (
        ROUTE_HIT_CACHE.load(Ordering::Relaxed),
        ROUTE_HIT_RACE.load(Ordering::Relaxed),
        ROUTE_CACHE_FAIL.load(Ordering::Relaxed),
    )
}

fn network_ctx_path() -> std::path::PathBuf {
    myco_core::config::config_dir().join("vnet-contexts.json")
}

/// 读盘（纯 IO，坏文件/缺文件 → 空；同 network_id 去重保留 last_active 更新者）。
fn load_contexts_from_path(path: &std::path::Path) -> Vec<NetworkContext> {
    let Ok(s) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(f) = serde_json::from_str::<NetworkContextsFile>(&s) else {
        elog!(
            "[vnet-route] 网络上下文文件损坏，按空重建（{}）",
            path.display()
        );
        return Vec::new();
    };
    let mut out: Vec<NetworkContext> = Vec::new();
    for c in f.contexts {
        if c.network_id.trim().is_empty() {
            continue;
        }
        match out.iter_mut().find(|x| x.network_id == c.network_id) {
            Some(old) => {
                if c.last_active > old.last_active {
                    *old = c;
                }
            }
            None => out.push(c),
        }
    }
    out
}

/// 落盘（原子写；失败只留日志——S 层是可再生派生状态，绝不能炸连接路径）。
fn save_contexts_to_path(
    path: &std::path::Path,
    contexts: &[NetworkContext],
) -> Result<(), String> {
    let f = NetworkContextsFile {
        contexts: contexts.to_vec(),
    };
    let s = serde_json::to_string(&f).map_err(|e| format!("序列化失败: {e}"))?;
    write_file_atomic(path, &s);
    Ok(())
}

/// S 层快照（按 last_active 新→旧；供落盘与诊断）。
fn contexts_snapshot() -> Vec<NetworkContext> {
    let mut out: Vec<NetworkContext> = {
        let g = NET_CTX.lock().unwrap();
        g.contexts
            .values()
            .map(|a| a.lock().unwrap().clone())
            .collect()
    };
    out.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    out
}

/// 异步落盘：spawn_blocking 写盘（连接路径零阻塞）；SAVE_RUNNING 保证单飞，
/// dirty 保证"写盘期间又有变更"时最终一致。
fn schedule_context_save() {
    use std::sync::atomic::Ordering;
    CTX_SAVE_DIRTY.store(true, Ordering::SeqCst);
    if CTX_SAVE_RUNNING.swap(true, Ordering::SeqCst) {
        return; // 已有写盘任务，dirty 会在下一圈被吃掉
    }
    let task = || {
        let path = network_ctx_path();
        loop {
            if !CTX_SAVE_DIRTY.swap(false, Ordering::SeqCst) {
                break;
            }
            let snap = contexts_snapshot();
            if let Err(e) = save_contexts_to_path(&path, &snap) {
                elog!("[vnet-route] 网络上下文落盘失败（降级继续）：{e}");
            }
        }
        CTX_SAVE_RUNNING.store(false, Ordering::SeqCst);
        // 收尾再抢一次：若刚好在 swap(false) 后又有变更，避免丢最后一笔。
        if CTX_SAVE_DIRTY.load(Ordering::SeqCst) && !CTX_SAVE_RUNNING.swap(true, Ordering::SeqCst) {
            schedule_context_save();
        }
    };
    match tokio::runtime::Handle::try_current() {
        Ok(h) => {
            h.spawn_blocking(task);
        }
        // 无 tokio 运行时（少数同步测试路径）：退化为同步写，保证数据不丢。
        Err(_) => task(),
    }
}

/// 启动时加载（restore 入口调用；幂等）。之后 current_context 按需懒加载。
pub(crate) fn load_network_contexts_on_start() {
    ensure_contexts_loaded();
}

fn ensure_contexts_loaded() {
    {
        let g = NET_CTX.lock().unwrap();
        if g.loaded {
            return;
        }
    }
    let loaded = load_contexts_from_path(&network_ctx_path());
    let mut g = NET_CTX.lock().unwrap();
    if g.loaded {
        return;
    }
    for c in loaded {
        g.contexts
            .insert(c.network_id.clone(), Arc::new(Mutex::new(c)));
    }
    g.loaded = true;
}

// ── C 层：网络识别 ──────────────────────────────────────────────────────

/// IPv6 网络前缀：取前 3 个段（`3fff:390:a95:...` → `3fff:390:a95`）。
/// 回环/链路本地/未指定/压缩形式兜底不足 3 段 → None（交给 IPv4 或 unknown）。
fn ipv6_prefix(ip: &str) -> Option<String> {
    let t = ip.trim().trim_start_matches('[').trim_end_matches(']');
    let t = t.split('%').next().unwrap_or(t).trim();
    if t.is_empty() {
        return None;
    }
    let low = t.to_ascii_lowercase();
    if low == "::1" || low == "::" || low.starts_with("fe80:") {
        return None;
    }
    let segs: Vec<&str> = t.split(':').filter(|s| !s.is_empty()).take(3).collect();
    if segs.len() < 3 {
        return None;
    }
    Some(segs.join(":"))
}

/// IPv4 网段：取前 3 个八位组（`192.168.1.31` → `192.168.1`）。
/// 回环/未指定/链路本地（169.254）/非四段 → None。
fn ipv4_subnet(ip: &str) -> Option<String> {
    let t = ip.trim();
    if t.is_empty() {
        return None;
    }
    let oct: Vec<&str> = t.split('.').collect();
    if oct.len() != 4 || oct.iter().any(|o| o.parse::<u8>().is_err()) {
        return None;
    }
    if matches!(oct[0], "0" | "127" | "169") {
        return None;
    }
    Some(format!("{}.{}.{}", oct[0], oct[1], oct[2]))
}

/// 网络指纹派生（**纯函数**，单测直击）：优先 IPv6 前 3 段，退 IPv4 /24，再退 unknown。
fn network_id_from_addrs(v6_addrs: &[String], v4_addrs: &[String]) -> String {
    if let Some(p) = v6_addrs.iter().find_map(|s| ipv6_prefix(s)) {
        return p;
    }
    if let Some(p) = v4_addrs.iter().find_map(|s| ipv4_subnet(s)) {
        return p;
    }
    "unknown".to_string()
}

/// 本机当前主出口 IPv6（UDP connect 让系统选路；失败 = None，不阻塞）。
fn primary_local_ipv6() -> Option<String> {
    let s = std::net::UdpSocket::bind("[::]:0").ok()?;
    s.connect("[2400:3200::1]:53").ok()?;
    match s.local_addr().ok()?.ip() {
        std::net::IpAddr::V6(v6) if !v6.is_loopback() && !v6.is_unspecified() => {
            Some(v6.to_string())
        }
        _ => None,
    }
}

/// 本机当前主出口 IPv4（同上）。
fn primary_local_ipv4() -> Option<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("223.5.5.5:53").ok()?;
    match s.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_unspecified() => {
            Some(v4.to_string())
        }
        _ => None,
    }
}

/// 当前网络指纹（C 层入口）。
fn network_id_of() -> String {
    let v6: Vec<String> = primary_local_ipv6().into_iter().collect();
    let v4: Vec<String> = primary_local_ipv4().into_iter().collect();
    network_id_from_addrs(&v6, &v4)
}

fn current_network_id() -> String {
    let now = now_ms_i64().max(0) as u64;
    {
        let g = NET_CTX.lock().unwrap();
        if let Some((id, at)) = &g.net_id_cache {
            if now.saturating_sub(*at) < NET_ID_TTL_MS {
                return id.clone();
            }
        }
    }
    let id = network_id_of();
    NET_CTX.lock().unwrap().net_id_cache = Some((id.clone(), now));
    id
}

/// LRU 淘汰对象（纯函数）：last_active 最旧者优先；平手取成功率更低者
/// （设计 §S：success_rate < 0.3 降权不删——这里体现为"平手先淘汰差网络"）。
fn pick_lru_victim(g: &NetworkContextStore, exclude: &str) -> Option<String> {
    g.contexts
        .iter()
        .filter(|(k, _)| k.as_str() != exclude)
        .map(|(k, a)| {
            let c = a.lock().unwrap();
            (k.clone(), c.last_active, c.success_rate())
        })
        .min_by(|a, b| {
            a.1.cmp(&b.1)
                .then(a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal))
        })
        .map(|x| x.0)
}

/// C 层：获取/创建**当前网络**上下文（按 network_id 匹配；miss 新建 + LRU 淘汰）。
pub(crate) fn current_context() -> Arc<Mutex<NetworkContext>> {
    ensure_contexts_loaded();
    let nid = current_network_id();
    let now = now_ms_i64().max(0) as u64;
    let mut g = NET_CTX.lock().unwrap();
    if let Some(a) = g.contexts.get(&nid).cloned() {
        a.lock().unwrap().last_active = now;
        g.current = Some(nid);
        return a;
    }
    if g.contexts.len() >= NET_CTX_MAX {
        if let Some(victim) = pick_lru_victim(&g, &nid) {
            g.contexts.remove(&victim);
            elog!("[vnet-route] 网络上下文 LRU 淘汰 {victim}（上限 {NET_CTX_MAX} 槽）");
        }
    }
    let ctx = Arc::new(Mutex::new(NetworkContext::new(&nid, now)));
    g.contexts.insert(nid.clone(), ctx.clone());
    g.current = Some(nid);
    drop(g);
    schedule_context_save();
    ctx
}

// ── C 层：路由更新 ──────────────────────────────────────────────────────

/// 连接成功 → 写回 S：首选路由 + 实测 RTT，清零失败/冷却。
pub(crate) fn update_route_success(device: &str, base: &str, rtt_ms: u64) {
    let ctx = current_context();
    let now = now_ms_i64().max(0) as u64;
    {
        let mut c = ctx.lock().unwrap();
        let r = c.peer_routes.entry(device.to_string()).or_default();
        r.preferred_base = base.trim().to_string();
        r.preferred_mode = mode_of_base(base).to_string();
        r.kind = classify_candidate_kind(base).to_string();
        if let Some((_host, port)) = base_host_port(base) {
            r.peer_listen_port = port;
        }
        r.rtt_ms = rtt_ms;
        r.success_count = r.success_count.saturating_add(1);
        r.fail_count = 0;
        r.cooldown_until = 0;
        r.last_used = now;
        c.total_connects = c.total_connects.saturating_add(1);
        c.successful_connects = c.successful_connects.saturating_add(1);
        c.last_active = now;
    }
    schedule_context_save();
}

fn is_cloud_relay_base(base: &str) -> bool {
    base.starts_with(RELAY_BASE)
        || base.starts_with("relay://")
        || base.contains("myco.youling.cc:8321")
}

/// 连接失败 → 写回 S：fail_count++；**连续 ≥3 次 → 冷却 300s**（设计 §C O2）。
pub(crate) fn update_route_fail(device: &str, base: &str) {
    update_route_fail_with_cooldown(device, base, true);
}

/// 失败计数；`allow_cooldown=false` 用于中继控制面暂时不可用，避免 403×3 直接冷却 300s。
fn update_route_fail_with_cooldown(device: &str, base: &str, allow_cooldown: bool) {
    let ctx = current_context();
    let now = now_ms_i64().max(0) as u64;
    {
        let mut c = ctx.lock().unwrap();
        let r = c
            .peer_routes
            .entry(device.to_string())
            .or_insert_with(|| PeerRoute {
                preferred_base: base.trim().to_string(),
                ..Default::default()
            });
        r.fail_count = r.fail_count.saturating_add(1);
        r.last_used = now;
        if allow_cooldown && r.fail_count >= ROUTE_COOLDOWN_FAILS {
            r.cooldown_until = now.saturating_add(ROUTE_COOLDOWN_MS);
            r.fail_count = 0;
            elog!(
                "[vnet-route] 路由冷却 {}s（{device} ← {base}；连续失败 {ROUTE_COOLDOWN_FAILS} 次）",
                ROUTE_COOLDOWN_MS / 1000
            );
        }
        c.total_connects = c.total_connects.saturating_add(1);
        c.last_active = now;
    }
    schedule_context_save();
}

/// 审计一条路由命中（R7 命中率：source=cache|race，可直接 grep `vnet-route-hit`）。
fn audit_route_hit(device: &str, base: &str, rtt_ms: u64, source: &str) {
    use std::sync::atomic::Ordering;
    match source {
        "cache" => {
            ROUTE_HIT_CACHE.fetch_add(1, Ordering::Relaxed);
        }
        _ => {
            ROUTE_HIT_RACE.fetch_add(1, Ordering::Relaxed);
        }
    }
    elog!(
        "[vnet-route] vnet-route-hit device={device} base={base} rtt_ms={rtt_ms} source={source}"
    );
}

// ── D 层：连接决策（缓存路由优先） ────────────────────────────────────

/// **D 层决策入口**（AOP Phase 1）：连接时先查 S 层缓存路由——
///   · 有可用路由（未冷却）→ **单拨缓存 base**（800ms），成功即用；
///   · 无路由/冷却中/缓存失败 → 探索：首选单拨 + 全量赛跑兜底（2000ms，见
///     [`dial_preferred_or_race`]——保留 task-19 的"稳态首选单拨零取消"特性）。
/// 结果写回 S（成功/RTT/失败/冷却）并 audit `vnet-route-hit`。
async fn dial_with_context(
    device: &str,
    bases: &[String],
    target_port: u16,
    per_candidate: Duration,
    budget: Duration,
    hp: Option<HpPlan>,
    relay: Option<RelayPlan>,
) -> Option<RacedWs> {
    use std::sync::atomic::Ordering;
    let now = now_ms_i64().max(0) as u64;
    let cached_route = {
        let ctx = current_context();
        let c = ctx.lock().unwrap();
        c.peer_routes.get(device).cloned()
    };
    if let Some(route) = cached_route.filter(|r| r.cacheable(now) && r.rtt_ms <= 250) {
        // 只给快路由单拨捷径；慢 preferred（例如旧中继 ~2s）必须重新赛跑，
        // 让已恢复的直连把 TTFB 拉回来，而不是永远吃旧缓存。
        let t0 = std::time::Instant::now();
        // 2026-11-03 真案（笔记本→PC 中继-only 拓扑，每连接固定 ~2.1s）：公网中继的
        // CONNECT+配对+握手在本网络实测 ~1.3s > 800ms → 缓存单拨**每次**超时 → 掉进
        // 全量赛跑（再付 300ms 让先 + 赛跑开销）。缓存路由本身是**已验证过的**中继，
        // 单拨预算按探索档（2000ms）给——命中即省掉整场赛跑。
        let cache_budget = if is_cloud_relay_base(&route.preferred_base) {
            ROUTE_EXPLORE_DIAL_TIMEOUT
        } else {
            ROUTE_CACHE_DIAL_TIMEOUT
        };
        match tokio::time::timeout(
            cache_budget,
            connect_tunnel(&route.preferred_base, target_port),
        )
        .await
        {
            Ok(Ok((ws, _resp, hs))) => {
                let rtt = t0.elapsed().as_millis() as u64;
                update_route_success(device, &route.preferred_base, rtt);
                audit_route_hit(device, &route.preferred_base, rtt, "cache");
                return Some((route.preferred_base, ws, hs));
            }
            _ => {
                ROUTE_CACHE_FAIL.fetch_add(1, Ordering::Relaxed);
                elog!("[vnet-route] 缓存路由不通 → 探索赛跑（{device}）");
                update_route_fail_with_cooldown(device, &route.preferred_base, !is_cloud_relay_base(&route.preferred_base));
            }
        }
    }
    // 探索路径：首选单拨 + 并行赛跑兜底（无缓存/冷却中/刚失败都走这里）。
    let t0 = std::time::Instant::now();
    let picked = dial_preferred_or_race(bases, target_port, per_candidate, budget, hp, relay).await;
    match picked {
        Some((base, ws, hs)) => {
            let rtt = t0.elapsed().as_millis() as u64;
            update_route_success(device, &base, rtt);
            audit_route_hit(device, &base, rtt, "race");
            Some((base, ws, hs))
        }
        None => {
            if let Some(first) = bases
                .iter()
                .find(|b| !b.trim().is_empty() && !b.starts_with("relay://"))
            {
                update_route_fail_with_cooldown(device, first, !is_cloud_relay_base(first));
            }
            None
        }
    }
}

#[cfg(test)]
pub(crate) fn test_reset_network_contexts() {
    use std::sync::atomic::Ordering;
    {
        let mut g = NET_CTX.lock().unwrap();
        g.loaded = false;
        g.current = None;
        g.net_id_cache = None;
        g.contexts.clear();
    }
    ROUTE_HIT_CACHE.store(0, Ordering::Relaxed);
    ROUTE_HIT_RACE.store(0, Ordering::Relaxed);
    ROUTE_CACHE_FAIL.store(0, Ordering::Relaxed);
    CTX_SAVE_DIRTY.store(false, Ordering::Relaxed);
}

/// **契约面**：与 target 设备建 P2P 隧道，本地起一个临时监听端口，返回该本地端口。
/// 语义：访问 `http://127.0.0.1:<local_port>/...` ≡ 访问 `target_device:target_port/...`
/// （HTTP 与 WS 都透传）。
/// 寻址：presence 按【设备 did】找在线 PC 设备 → 候选 = 缓存 ∪ 对端上报地址 ∪ 本机地址
/// → **并行赛跑**（先通先得，总预算 [`RACE_TOTAL_BUDGET`]）。
/// 失败：目标不在线/无直连地址、全部候选连不上隧道端点、端口不在白名单、本机未登录
/// （附人话原因，见 [`no_route_hint`]）。
/// 隧道本地口记忆（2026-10-12 端口持久化）：`config_dir()/tunnel-ports.json`
/// = {"<device>|<port>": local_port}。落盘让 myco 重启后**复用同口**——浏览器里
/// 开着的分享页 URL 因此跨重启仍有效（刷新即恢复）。
fn port_memo_path() -> std::path::PathBuf {
    myco_core::config::config_dir().join("tunnel-ports.json")
}

/// **原子落盘**（同目录 tmp → fsync → rename）——2026-10-23 固定口漂移真案根修之一。
///
/// 事故：`tunnel-ports.json` / `vnet-forwards.json` 原来用 `std::fs::write`
/// （O_TRUNC 后写）。进程在写到一半被杀/断电 → 文件空或残缺 → 下次启动读回
/// `None`（`port_memo_all` 坏文件直接返空）→ **固定口"失忆"退回随机口**。
/// rename 是原子的：其他读者/崩溃恢复只可能看到「旧完整版」或「新完整版」。
///
/// 失败只记日志（记忆/配置是可再生派生信息，不该炸掉隧道）；tmp 残留顺手清掉。
pub(crate) fn write_file_atomic(path: &std::path::Path, body: &str) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("tmp{}-{n}", std::process::id()));
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let res = (|| -> std::io::Result<()> {
        use std::io::Write as _;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_file(&tmp);
        elog!("[p2p-tunnel] 原子写 {} 失败：{e}", path.display());
    }
}

fn port_memo_key(device: &str, port: u16) -> String {
    format!("{device}|{port}")
}

/// 端口记忆的**读-改-写互斥**：并发 `tunnel_open`（restore/keeper/keep 同时来）
/// 各写各的 key 时，原实现会互相覆盖丢失条目（F3 的另一半）。
static PORT_MEMO_WRITE: Mutex<()> = Mutex::new(());

/// 读记忆口（纯 fs 语义；读不到/坏文件 → None，行为回到"随机口"）。
fn port_memo_get(device: &str, port: u16) -> Option<u16> {
    let s = std::fs::read_to_string(port_memo_path()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    v.get(port_memo_key(device, port))?
        .as_u64()
        .map(|p| p as u16)
}

fn port_memo_set(device: &str, port: u16, local: u16) {
    let _g = PORT_MEMO_WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let path = port_memo_path();
    let mut v: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(o) = v.as_object_mut() {
        o.insert(port_memo_key(device, port), serde_json::json!(local));
    }
    write_file_atomic(&path, &serde_json::to_string(&v).unwrap_or_default());
}

/// 读全部记忆条目 → [(device, target_port)]（启动恢复用；坏文件返回空）。
fn port_memo_all() -> Vec<(String, u16)> {
    let s = match std::fs::read_to_string(port_memo_path()) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let v: serde_json::Value = match serde_json::from_str(&s) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    v.as_object()
        .map(|o| {
            o.keys()
                .filter_map(|k| {
                    let (d, p) = k.split_once('|')?;
                    let port: u16 = p.parse().ok()?;
                    if d.is_empty() || port == 0 {
                        return None;
                    }
                    Some((d.to_string(), port))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 删除一条隧道记忆（过期设备 did 自愈用）。
fn port_memo_remove(device: &str, port: u16) {
    let _g = PORT_MEMO_WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let path = port_memo_path();
    let Ok(s) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&s) else {
        return;
    };
    let Some(o) = v.as_object_mut() else { return };
    if o.remove(&port_memo_key(device, port)).is_some() {
        write_file_atomic(&path, &serde_json::to_string(&v).unwrap_or_default());
    }
}

/// **重启自愈**（2026-10-13 完整闭环的最后一块；同日 3s 提速版）：按端口记忆
/// 重建上次的隧道——用户场景"重启 myco 后刷新已开分享页"此前断在这里：隧道
/// listener 只在 tunnel_open 时 bind，重启后记忆口无人监听，刷新必 000。
///
/// 3s 目标（用户要求"从 myco 启动到刷新重连好 ≤3s"）：
/// · 身份就绪轮询 300ms 粒度（本地加载通常 <1s）；
/// · 隧道赛跑同 LAN 直连 ~百 ms、跨网中继 ~600ms——合计 ≈1.5s；
/// · **对端也可能正在重启**（如 PC 更新）——失败**每 1s 重试（30 次上限）**，
///   对端一回来隧道立即恢复；首轮成功则零重试。
/// 对端离线超时则静默放弃（tunnel_open 失败不 bind，不占死口）。
pub async fn restore_remembered_tunnels() {
    // 固定口第一跳：restore 早于 vnet keeper 启动，必须自己把持久化的用户约定口
    // 灌进内存——否则按 tunnel-ports.json 的旧随机口重建，固定口永不 LISTEN。
    preferred_local_load_once();
    // task-20 AOP Phase 1：启动时加载持久化网络上下文（S 层；坏文件自动降级为空）
    load_network_contexts_on_start();
    let all = port_memo_all();
    crate::startup_trace::mark_detail("restore-enter", &format!("entries={}", all.len()));
    if all.is_empty() {
        return;
    }
    // 等本机身份就绪（唯一硬前置：签名信封需要设备密钥）；300ms 粒度，30s 放弃。
    for _ in 0..100 {
        if myco_core::identity::device_identity().is_ok() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    crate::startup_trace::mark("restore-identity-ready");
    let t_start = std::time::Instant::now();
    // 2026-10-15：**并行恢复**每条记忆（原为顺序 for——第一条约 1s 的重试会把后面
    // 页面真正依赖的条目（如 x7oj|13911）压后整整一段，实测 mgmt→ping 多付 ~1s）。
    let mut handles = Vec::new();
    for (device, port) in all {
        handles.push(tokio::spawn(async move {
            let t0 = std::time::Instant::now();
            // 对端也可能在重启：失败 **200ms 高频重试**（用户定调"重连就 200ms
            // 不停试"），最多 150 次 ≈30s；对端一回来即恢复、首轮成功零重试。
            let mut last_err = String::new();
            for attempt in 0..150 {
                match tunnel_open(&device, port).await {
                    Ok(local) => {
                        elog!(
                            "[p2p-tunnel] 重启恢复隧道成功（第 {} 跳，{}ms，总 {}ms）：{device}:{port} → 本地 :{local}",
                            attempt + 1,
                            t0.elapsed().as_millis(),
                            t_start.elapsed().as_millis(),
                        );
                        crate::startup_trace::mark_detail(
                            "restore-tunnel-ok",
                            &format!("device={device} port={port} local={local} attempt={}", attempt + 1),
                        );
                        last_err.clear();
                        break;
                    }
                    Err(e) => {
                        // 固定口被别的进程占着：重试 150 次只会空转 30s+，也**绝不**
                        // 回落随机口（那正是本次事故）。记一条人话日志后放弃本条，
                        // 保留 memo/kept，等用户释放端口或下次启动再试。
                        if e.contains("固定本地口") {
                            elog!(
                                "[p2p-tunnel] 重启恢复放弃：{device}:{port} 约定固定口不可用（{e}）"
                            );
                            last_err.clear();
                            break;
                        }
                        last_err = e;
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    }
                }
            }
            if !last_err.is_empty() {
                elog!("[p2p-tunnel] 重启恢复隧道未成（重试 30 次，对端可能离线）：{device}:{port}（{last_err}）");
                // 2026-10-20 R10：过期设备 did 会永远空转（真案：手机换设备 did 后 memo 里留着旧 did）。
                // 恢复失败且错误是"目标设备未注册中继/不在线"→ 删除该条记忆，下次按新设备重记。
                if last_err.contains("未注册中继") || last_err.contains("不在线") || last_err.contains("无可拨地址") {
                    port_memo_remove(&device, port);
                    elog!("[p2p-tunnel] 已清理过期隧道记忆：{device}:{port}");
                }
            }
        }));
    }
    for h in handles {
        let _ = h.await;
    }
    crate::startup_trace::mark_detail(
        "restore-done",
        &format!("ms={}", t_start.elapsed().as_millis()),
    );
}

/// 用户指定的**固定本地口**（`(device,port) -> localPort`）。优先级高于记忆口：
/// 2026-10-22 用户需求——微软远程桌面/SSH/VNC 的地址是配置死的，不能每次重建换口。
/// `POST /api/vnet/forward {device,port,localPort}` 与 `vnet keep --local` 写入这里；
/// keeper 重建前按持久化记录重新设置。进程内有效（持久化由 kept 文件负责）。
pub static PREFERRED_LOCAL: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, u16>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// 设置/清除首选本地口。
///
/// 2026-10-23 固定口漂移真案：原来只在**进程内**记（`PREFERRED_LOCAL`），
/// `restore_remembered_tunnels` 在 keeper 之前跑、读不到用户约定的口 → 按
/// `tunnel-ports.json` 的旧随机口重建；keeper 见隧道已活就跳过 → 约定口永不 LISTEN
/// （笔记本 23389 变 57811，mstsc 0x204）。现在**落盘** `tunnel-fixed-ports.json`
/// （tmp+rename 原子写），重启后 restore 第一跳就按固定口 bind。
pub fn set_preferred_local(device: &str, port: u16, local: Option<u16>) {
    preferred_local_load_once();
    // 写锁包住「改内存 + 快照 + 落盘」：并发 set（keeper 每拍 + keep/rdp）各自
    // 快照再各自写盘会**后写覆盖前写**（丢条目 → 重启后又漂移）。
    let _w = PREFERRED_WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let key = pref_key(device, port);
    let legacy = pref_key_legacy(device, port);
    let snapshot = {
        let mut g = PREFERRED_LOCAL.lock().unwrap_or_else(|e| e.into_inner());
        g.remove(&legacy);
        match local {
            Some(lp) if lp > 0 => {
                g.insert(key, lp);
            }
            _ => {
                g.remove(&key);
            }
        }
        g.clone()
    };
    preferred_local_save(&snapshot);
}

/// 固定口映射键：**设备 DID 先归一**（同 [`did_key`]）。历史文件里是未归一的
/// `did:myco:…#port`，读取侧同时兼容（见 [`preferred_local`] / 加载迁移）。
fn pref_key(device: &str, port: u16) -> String {
    format!("{}#{}", did_key(device), port)
}

/// 历史（未归一）键——只用于读兼容与清理，不再写入。
fn pref_key_legacy(device: &str, port: u16) -> String {
    format!("{device}#{port}")
}

/// 固定口快照落盘的写互斥（见 [`set_preferred_local`]）。
static PREFERRED_WRITE: Mutex<()> = Mutex::new(());

/// 读首选本地口（首次调用时从磁盘加载——重启后 restore 无需外部先灌一遍）。
///
/// 键先按归一 DID 查，再回退历史未归一键：老 `tunnel-fixed-ports.json` 是
/// `did:myco:…#port`，卡上换一种前缀写法时不能"失忆"退回随机口。
pub fn preferred_local(device: &str, port: u16) -> Option<u16> {
    preferred_local_load_once();
    let g = PREFERRED_LOCAL.lock().unwrap_or_else(|e| e.into_inner());
    g.get(&pref_key(device, port))
        .copied()
        .or_else(|| g.get(&pref_key_legacy(device, port)).copied())
}

/// 固定口持久化文件（`%APPDATA%\youling\tunnel-fixed-ports.json`，形如
/// `{"<device>#<port>": 23389}`）。与 kept 文件（`vnet-forwards.json`）的
/// `localPort` 同源：`vnet_keep_upsert` 写 kept 时也会经 [`set_preferred_local`]
/// 落到这里；这份是 p2p_tunnel 自己的"启动第一跳"依据。
fn preferred_local_path() -> std::path::PathBuf {
    myco_core::config::config_dir().join("tunnel-fixed-ports.json")
}

/// 进程内缓存是否已从磁盘加载（一次）。
static PREFERRED_LOADED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 测试进程若没隔离配置目录，**绝不**往真实 `%APPDATA%` 写（cargo test 不许污染用户文件）。
fn preferred_persist_allowed() -> bool {
    if cfg!(test) {
        std::env::var_os("MYCO_CONFIG_DIR").is_some()
    } else {
        true
    }
}

fn preferred_local_load_once() {
    use std::sync::atomic::Ordering;
    if PREFERRED_LOADED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Ok(s) = std::fs::read_to_string(preferred_local_path()) else {
        return;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) else {
        elog!(
            "[p2p-tunnel] 固定口档案损坏，忽略：{}",
            preferred_local_path().display()
        );
        return;
    };
    let Some(o) = v.as_object() else { return };
    let mut g = PREFERRED_LOCAL.lock().unwrap_or_else(|e| e.into_inner());
    for (k, val) in o {
        let Some(lp) = val.as_u64().map(|p| p as u16).filter(|p| *p > 0) else {
            continue;
        };
        // 2026-10-23：加载即把历史键（未归一 DID）迁到归一键。两前缀同钥必须
        // 命中同一条固定口——否则卡上换一种写法就"失忆"退回随机口。
        let key = match k.rsplit_once('#') {
            Some((dev, port_s)) => match port_s.parse::<u16>() {
                Ok(port) => pref_key(dev, port),
                Err(_) => k.clone(),
            },
            None => k.clone(),
        };
        // 进程内先设的优先（keeper 可能先于首次读取写入）
        g.entry(key).or_insert(lp);
    }
}

fn preferred_local_save(g: &std::collections::HashMap<String, u16>) {
    if !preferred_persist_allowed() {
        return;
    }
    let v: serde_json::Value = g
        .iter()
        .map(|(k, p)| (k.clone(), serde_json::json!(p)))
        .collect::<serde_json::Map<String, serde_json::Value>>()
        .into();
    write_file_atomic(
        &preferred_local_path(),
        &serde_json::to_string(&v).unwrap_or_default(),
    );
}

/// 测试用：模拟"进程重启"里**这一条**的失忆（从内存去掉，允许下次读取时从磁盘档案补回），
/// 只影响 (device,port) 这一条，不打扰并行跑的其他用例。
#[cfg(test)]
pub(crate) fn forget_preferred_for_test(device: &str, port: u16) {
    use std::sync::atomic::Ordering;
    let mut g = PREFERRED_LOCAL.lock().unwrap_or_else(|e| e.into_inner());
    g.remove(&pref_key(device, port));
    g.remove(&pref_key_legacy(device, port));
    drop(g);
    PREFERRED_LOADED.store(false, Ordering::SeqCst);
}

/// 隧道**连接失败计数**（自愈用）：`(device,port)` → (连续失败数, 最后失败毫秒)。
/// 2026-10-22 真案：对端 myco 重启后，本地监听还在 → keeper 认为隧道健康不重建 →
/// 该口一直"接受连接但连不通"。修法：连接全候选失败时计数，keeper 见连续 3 次
/// 就 `tunnel_close`（下一拍按 kept 记录重建，重新解析地址/端口）。
pub static TUNNEL_FAIL: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, (u32, i64)>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

fn fail_key(device: &str, port: u16) -> String {
    // 与隧道键同口径归一：同钥不同前缀不能各记一份失败/成功。
    format!("{}#{}", did_key(device), port)
}

/// 记一次连接失败（返回累计次数）。
pub fn note_tunnel_fail(device: &str, port: u16) -> u32 {
    let mut g = TUNNEL_FAIL.lock().unwrap();
    let e = g.entry(fail_key(device, port)).or_insert((0, 0));
    e.0 = e.0.saturating_add(1);
    e.1 = now_ms_i64();
    e.0
}

/// 记一次连接成功（清零）。
pub fn note_tunnel_ok(device: &str, port: u16) {
    TUNNEL_FAIL.lock().unwrap().remove(&fail_key(device, port));
}

/// 当前连续失败次数（超过 120s 没新失败则视为已过期，返回 0）。
pub fn tunnel_fail_streak(device: &str, port: u16) -> u32 {
    let g = TUNNEL_FAIL.lock().unwrap();
    match g.get(&fail_key(device, port)) {
        Some((n, at)) if now_ms_i64().saturating_sub(*at) < 120_000 => *n,
        _ => 0,
    }
}

/// 清零（重建前后调用，避免同一故障反复触发）。
pub fn tunnel_fail_clear(device: &str, port: u16) {
    TUNNEL_FAIL.lock().unwrap().remove(&fail_key(device, port));
}

// ── 2026-10-24 task-19：重建退避（两端并发重建互踢的止血）──
//
// 真案（PC+笔记本两侧日志对齐）：两端 keeper 每 250ms 一拍、各自 `tunnel_open`；
// 断网/半开窗口里两侧同时拨号重建，先建成的一侧又被下一轮重建 abort → 两侧同时报
// 对方 `加密握手失败(Connection reset)` 的死循环。隧道真断时必须重建，但**连续失败
// 必须退避**：250ms×2^failures（上限 4s），成功一次立刻清零——抖动时拨号次数指数
// 下降，不会几秒一轮对拨。
const OPEN_BACKOFF_BASE_MS: i64 = 250;
const OPEN_BACKOFF_MAX_MS: i64 = 2000;
static OPEN_BACKOFF: LazyLock<Mutex<std::collections::HashMap<String, (u32, i64)>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// 还在退避窗口里 → 返回剩余毫秒（调用方直接返回人话 Err，不拨号）。
pub(crate) fn open_backoff_remaining(device: &str, port: u16) -> Option<u64> {
    let g = OPEN_BACKOFF.lock().unwrap();
    let (n, at) = *g.get(&fail_key(device, port))?;
    let wait = (OPEN_BACKOFF_BASE_MS << n.min(4)).min(OPEN_BACKOFF_MAX_MS);
    let elapsed = now_ms_i64().saturating_sub(at).max(0);
    if elapsed >= wait {
        None
    } else {
        Some((wait - elapsed) as u64)
    }
}

/// 记一次重建失败（退避翻倍；返回累计连续失败次数）。
pub(crate) fn open_backoff_fail(device: &str, port: u16) -> u32 {
    let mut g = OPEN_BACKOFF.lock().unwrap();
    let e = g.entry(fail_key(device, port)).or_insert((0, 0));
    e.0 = e.0.saturating_add(1);
    e.1 = now_ms_i64();
    e.0
}

/// 记一次重建成功（清零退避）。
pub(crate) fn open_backoff_ok(device: &str, port: u16) {
    OPEN_BACKOFF.lock().unwrap().remove(&fail_key(device, port));
}

/// 优先 bind **固定口**（用户约定，失败即报错）/ 记忆口（失效仅告警回落随机口）。
///
/// 只绑 127.0.0.1（隧道口绝不对外）。
/// 2026-10-23 契约（用户真机事故）：`keep/forward {localPort:L}` 的语义是
/// **最终必须监听 L，否则明确失败**——原实现"重试 5×300ms 后回落记忆口/随机口"
/// 会让接口返回成功、`localPort` 却悄悄变成 57811，.rdp 里写死的 23389 永远
/// 连不上（mstsc 0x204）。所以固定口失败**不**回落。
async fn bind_preferred_local(device: &str, port: u16) -> Result<TcpListener, String> {
    if let Some(p) = preferred_local(device, port) {
        // 重试 5×300ms：旧监听刚 abort 时端口可能还没完全释放。
        let mut last = String::new();
        for i in 0..5 {
            match TcpListener::bind(("127.0.0.1", p)).await {
                Ok(l) => return Ok(l),
                Err(e) => {
                    last = e.to_string();
                    if i < 4 {
                        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                    }
                }
            }
        }
        return Err(format!(
            "固定本地口 127.0.0.1:{p} 绑定失败（重试 5 次）：{last}；不会自动换成随机口——请释放该端口或改 localPort"
        ));
    }
    if let Some(p) = port_memo_get(device, port) {
        if let Ok(l) = TcpListener::bind(("127.0.0.1", p)).await {
            return Ok(l);
        }
        elog!("[p2p-tunnel] 记忆口 {p} 被占用，回落随机口（旧页面链接将失效）");
    }
    TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("本地监听失败: {e}"))
}

/// 同一 (device,port) 的**开隧道串行门**（F1：并发 opener 无互斥）。
///
/// 真案：keeper / restore / keep / forward 同时打同一 (device,port) 时，两个
/// opener 都会先看到"表里没有"→ 各自 `tunnel_close`+bind：后一个把前一个的
/// 监听 abort 掉、抢口时前一个还没释放 → bind 固定口失败 → 回落随机口。
/// 现在所有 opener 在门内串行，「关旧 → bind → 装表」是一个原子段。
static OPEN_GATES: LazyLock<Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

async fn open_gate(key: String) -> tokio::sync::OwnedMutexGuard<()> {
    let m = {
        let mut g = OPEN_GATES.lock().unwrap_or_else(|e| e.into_inner());
        g.entry(key)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    m.lock_owned().await
}

/// 已有隧道能否**直接复用**（`tunnel_open` 的快速路径）：有固定口时只认固定口——
/// 现监听 ≠ 约定口一律**关旧监听再重绑**（否则 keep/forward{localPort} 会把旧随机口
/// 当成功返回，约定口永不 LISTEN）；没有固定口时保持"存活即复用"（分享页 URL 不换口）。
fn reuse_existing_if_ok(device: &str, port: u16) -> Option<u16> {
    let cur = tunnel_local_port(device, port)?;
    match preferred_local(device, port) {
        Some(want) if want != cur => {
            elog!(
                "[p2p-tunnel] 固定口漂移修复：{device}:{port} 现监听 :{cur} ≠ 约定 :{want} → 关闭旧隧道（abort 接受循环）并按固定口重绑"
            );
            tunnel_close(device, port);
            None
        }
        _ => Some(cur),
    }
}

/// **门内幂等复用**：只认固定口——现监听 == 约定口才复用；口不对就关旧重绑。
///
/// 为什么不像 [`reuse_existing_if_ok`] 那样"无固定口也复用"：`tunnel_open_with_bases`
/// 是显式"重开"入口（真案单测：强制直连 + 空候选必须**失败**，不能因为上一条隧道
/// 还活着就返回成功）。固定口场景才需要"并发多次调用只建一次"的幂等。
fn reuse_fixed_if_match(device: &str, port: u16) -> Option<u16> {
    let want = preferred_local(device, port)?;
    let cur = tunnel_local_port(device, port)?;
    if cur == want {
        return Some(cur);
    }
    elog!(
        "[p2p-tunnel] 固定口漂移修复：{device}:{port} 现监听 :{cur} ≠ 约定 :{want} → 关闭旧隧道（abort 接受循环）并按固定口重绑"
    );
    tunnel_close(device, port);
    None
}

/// 隧道本地口记忆键（测用可见性：单测直击读写往返）。
#[cfg(test)]
mod port_memo_tests {
    use super::*;

    #[test]
    fn memo_roundtrip_and_key_isolation() {
        // 纯 fs 往返（MYCO_CONFIG_DIR 由共享 test_env_lock 隔离的用例覆盖；
        // 这里只验证同进程内 key 语义与 JSON 形态，不依赖具体目录）
        let k1 = port_memo_key("did:myco:A", 9100);
        let k2 = port_memo_key("did:myco:A", 13911);
        let k3 = port_memo_key("did:myco:B", 9100);
        assert_ne!(k1, k2);
        assert_ne!(k1, k3);
        assert!(k1.contains("9100") && k1.contains("did:myco:A"));
    }

    /// **跨设备候选剔除 loopback**（2026-10-13 破案修的判定核）：127.x / ::1 /
    /// localhost 连的是自己的服务——TCP+WS 对自己永远通=必赢的毒候选（实测：
    /// 笔记本隧道全部自环、PC 侧零连接、请求回到自己网关 404"分享不存在"），
    /// 且以"成功"入缓存长期污染选路。
    #[test]
    fn loopback_candidates_are_recognized() {
        assert!(is_loopback_base("http://127.0.0.1:9100"));
        assert!(is_loopback_base("127.0.0.2:9100"));
        assert!(is_loopback_base("http://localhost:13911"));
        assert!(is_loopback_base("http://[::1]:9100"));
        assert!(!is_loopback_base("http://192.168.1.82:9100"));
        assert!(!is_loopback_base("http://[3fff:390:a94::1]:9100"));
        assert!(!is_loopback_base("http://203.0.113.99:9100"));
    }

    /// **跨重启复用同口**的硬验证（用户报笔记本/手机"重启后旧页面刷新
    /// ERR_CONNECTION_REFUSED"的根修锚）：真 bind → 释放（模拟进程退出）→
    /// 再 bind_preferred → **必须是同一口**。这条测试不依赖真机、不依赖网络，
    /// 是本修复的"我自己测好"证据。
    #[tokio::test]
    async fn preferred_bind_keeps_port_across_restart() {
        // 隔离配置目录（走全进程共享锁，避免和别的 fs 用例互踩 MYCO_CONFIG_DIR）
        let _g = crate::test_env_lock::test_env_lock();
        let dev = "did:myco:PORTMEMO";
        let port = 13911u16;

        // 第一次：无记忆 → 随机口，写入记忆
        let l1 = bind_preferred_local(dev, port).await.expect("first bind");
        let p1 = l1.local_addr().unwrap().port();
        port_memo_set(dev, port, p1);
        assert_eq!(port_memo_get(dev, port), Some(p1), "记忆应写入");

        // 模拟进程退出：释放监听
        drop(l1);
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;

        // 第二次（"重启后"）：应复用同口
        let l2 = bind_preferred_local(dev, port).await.expect("second bind");
        let p2 = l2.local_addr().unwrap().port();
        assert_eq!(p2, p1, "重启后必须复用记忆口（旧页面 URL 才有效）");

        drop(l2);
        let _ = std::fs::remove_file(port_memo_path());
    }

    /// **固定口是契约，不是偏好**（2026-10-23 真机事故的回归锚）：
    /// `keep/forward {localPort:L}` 语义 = 最终监听 L 或明确失败。固定口被占时
    /// `bind_preferred_local` 必须 `Err`——**绝不**悄悄回落记忆口/随机口。
    /// 事故原型：接口返回成功、实际监听 57811，`.rdp` 写死的 23389 永远连不上（mstsc 0x204）。
    #[tokio::test]
    async fn fixed_local_bind_failure_is_explicit_not_random() {
        let _g = crate::test_env_lock::test_env_lock();
        let dev = "did:myco:FIXED-OCCUPIED";
        let key_port = 23389u16;
        // 先占一个口（模拟"旧监听/别的进程"占着约定固定口）
        let squatter = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let busy = squatter.local_addr().unwrap().port();
        set_preferred_local(dev, key_port, Some(busy));

        let err = bind_preferred_local(dev, key_port)
            .await
            .expect_err("固定口被占必须明确失败（不许回落随机口）");
        assert!(err.contains("固定本地口"), "错误必须点名固定口语义: {err}");
        assert!(err.contains(&busy.to_string()), "错误里要带具体端口: {err}");
        assert!(err.contains("随机口"), "错误要说明不会换成随机口: {err}");

        // 释放后能按固定口绑上（同一口）
        drop(squatter);
        let mut bound = None;
        for _ in 0..20 {
            match bind_preferred_local(dev, key_port).await {
                Ok(l) => {
                    bound = Some(l);
                    break;
                }
                Err(_) => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
            }
        }
        let l = bound.expect("端口释放后应能按固定口绑定");
        assert_eq!(l.local_addr().unwrap().port(), busy);
        drop(l);
        set_preferred_local(dev, key_port, None);
    }

    /// **重启后仍用固定口**（事故第二半：restore 早于 keeper，必须自己读回约定口）：
    /// 进程内缓存清空后，`preferred_local` 必须从 `tunnel-fixed-ports.json` 恢复，
    /// 且 `bind_preferred_local` 直接绑到那个口。
    #[tokio::test]
    async fn fixed_local_survives_process_restart() {
        let _g = crate::test_env_lock::test_env_lock();
        let dev = "did:myco:FIXED-RESTART";
        let key_port = 23911u16;
        let free = {
            let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            l.local_addr().unwrap().port()
        };
        set_preferred_local(dev, key_port, Some(free));
        assert_eq!(preferred_local(dev, key_port), Some(free));

        // 模拟"重启"：内存缓存丢掉（磁盘档案还在）
        forget_preferred_for_test(dev, key_port);
        assert_eq!(
            preferred_local(dev, key_port),
            Some(free),
            "重启后必须从 tunnel-fixed-ports.json 读回固定口（否则回落记忆/随机口）"
        );
        let raw = std::fs::read_to_string(preferred_local_path()).expect("固定口档案必须存在");
        assert!(
            raw.contains(&free.to_string()),
            "档案里必须存着约定口: {raw}"
        );

        let l = bind_preferred_local(dev, key_port)
            .await
            .expect("按固定口 bind");
        assert_eq!(l.local_addr().unwrap().port(), free);
        drop(l);
        set_preferred_local(dev, key_port, None);
    }

    /// **memo 原子写 + 读改写互斥**（F3）：并发写不同 key → 成品必须是**完整合法
    /// JSON** 且一条不丢。旧实现 `fs::write`（截断写）+ 无锁读改写：崩溃/并发会
    /// 留下坏文件/丢条目 → 重启读不到记忆 → 固定口/页面口漂移。
    #[test]
    fn port_memo_concurrent_writes_stay_valid_and_complete() {
        let _g = crate::test_env_lock::test_env_lock();
        let _ = std::fs::remove_file(port_memo_path());
        let dev = "did:myco:MEMO-ATOMIC";
        std::thread::scope(|s| {
            for i in 0..8u16 {
                s.spawn(move || port_memo_set(dev, 9000 + i, 21000 + i));
            }
        });
        let raw = std::fs::read_to_string(port_memo_path()).expect("memo 文件必须存在");
        let _: serde_json::Value =
            serde_json::from_str(&raw).expect("并发写后必须是完整合法 JSON（坏文件=端口失忆）");
        for i in 0..8u16 {
            assert_eq!(
                port_memo_get(dev, 9000 + i),
                Some(21000 + i),
                "第 {i} 条不能丢"
            );
        }
        let _ = std::fs::remove_file(port_memo_path());
    }
}

pub async fn tunnel_open(target_device_did: &str, target_port: u16) -> Result<u16, String> {
    if !tunnel_port_allowed(target_port) {
        return Err(format!(
            "端口 {target_port} 不在 P2P 隧道白名单（防开放代理）"
        ));
    }
    // 2026-10-23 F1：同一 (device,port) 的 opener 串行化（keeper/restore/keep 并发时
    // 只允许一个走「关旧→bind→装表」，其余在门内直接看到成品并复用）。
    let _gate = open_gate(tunnel_key(target_device_did, target_port)).await;
    // 2026-10-15 复用优先（笔记本"重启后一直连不上"真案根修之一）：已有隧道**直接返回**。
    // 此前重复 tunnel_open 会把好端端的隧道关掉重开，而旧口被自己占着 → 新 bind 只能拿
    // 随机口 → 页面 URL 立即失效。隧道连接本就按需重拨（候选清单支持热更新自愈），
    // 存活即复用是安全的。
    // 2026-10-23：复用**只认固定口**——现监听≠约定口时先关闭再由下文按固定口重绑。
    if let Some(p) = reuse_existing_if_ok(target_device_did, target_port) {
        return Ok(p);
    }
    // 2026-10-24 task-19：连续失败**指数退避**——两端 keeper 250ms 一拍同时重建时，
    // 不退避 = 永久对拨互踢（本次事故）。退避期间直接失败（人话），下一次合法窗口再拨。
    if let Some(remain) = open_backoff_remaining(target_device_did, target_port) {
        return Err(format!(
            "隧道重建退避中（还差 {remain}ms；连续失败后退避 250ms→2s，成功一次即清零）"
        ));
    }
    let r = tunnel_open_dial(target_device_did, target_port).await;
    match &r {
        Ok(_) => open_backoff_ok(target_device_did, target_port),
        Err(_) => {
            open_backoff_fail(target_device_did, target_port);
        }
    }
    r
}

/// `tunnel_open` 的拨号内核（已过白名单/复用/退避闸；**调用方必须已持 open_gate**）。
async fn tunnel_open_dial(target_device_did: &str, target_port: u16) -> Result<u16, String> {
    // 2026-10-22 vnet 自连接根修：目标=本机设备时**不查 presence**——刚启动/未上报时
    // presence 里可能没有自己 → 原逻辑走"对端不在线"分支（空候选 + 中继腿）→
    // 自环隧道要绕公网中继、甚至直接失败。自连接的正确候选就是本机 p2p 口。
    let self_target = self_did_for_loopback_filter()
        .map(|mine| myco_core::identity::did_equiv(mine.as_str(), target_device_did))
        .unwrap_or(false);
    if self_target {
        let port = crate::p2p_server::p2p_port().max(1);
        let mut bases = vec![format!("http://127.0.0.1:{port}")];
        bases.extend(crate::p2p_server::local_candidate_urls(port));
        return tunnel_open_with_bases_locked(bases, target_device_did, "self", target_port).await;
    }
    // 2026-10-22 vnet：**不过滤设备类型**（手机 kind=phone 也要能当隧道目标；
    // 原 presence_device_by_did 只认 pc → 打手机永远落到"不在线"分支）。
    let dev = crate::p2p_client::presence_device_by_did_any_kind(target_device_did).await;
    match dev {
        Some(dev) => {
            // 2026-10-11 提速：presence 确认对端在线 → 后台预连中继 TCP（只握手不上
            // 协议）——接下来十有八九要开隧道，到时 CONNECT 少等一个公网 RTT。
            if let Some((rh, rp)) = relay_addr() {
                crate::cloud_relay::predial_refill(rh, rp);
            }
            let explicit = crate::p2p_client::urls_of(&dev);
            let bases = candidate_bases(target_device_did, &explicit);
            tunnel_open_with_bases_locked(bases, target_device_did, &dev.name, target_port).await
        }
        None => {
            // presence 无此设备：直连候选无从谈起。但云端中继的注册面**独立于
            // presence**（provider 常驻 REGISTER，不受 presence 心跳抖动影响）——
            // 仍给中继一条路（空候选 + 中继腿；打洞腿自动退出：目标账号不可知）。
            // 全败则回原始人话（对端确实哪儿都不在）。
            match tunnel_open_with_bases_locked(
                Vec::new(),
                target_device_did,
                target_device_did,
                target_port,
            )
            .await
            {
                Ok(p) => Ok(p),
                Err(_) => Err(format!(
                    "目标设备不在线或未上报直连地址: {target_device_did}"
                )),
            }
        }
    }
}

/// 候选 URL 是否 loopback（host 为 127.x / [::1] / localhost）——跨设备目标
/// 的毒候选（连的是自己的服务），2026-10-13 破案修的判定核。纯函数（单测直击）。
fn is_loopback_base(b: &str) -> bool {
    let t = b.trim();
    let t = t.split_once("://").map(|(_, r)| r).unwrap_or(t);
    let t = t.split('/').next().unwrap_or(t);
    // `[v6]:port` 先剥方括号再切端口；v4/host 直接按 ':' 切
    let host = if let Some(rest) = t.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest)
    } else {
        t.split(':').next().unwrap_or(t)
    };
    host == "localhost"
        || host == "::1"
        || host.split('.').next().map(|o| o == "127").unwrap_or(false)
}

// ── L2 候选分类（vnet 端点租约契约 §3 o_peer_presence.reported_candidates.kind）──

/// 本机**临时** IPv6 地址快照（Windows `SuffixOrigin=Random`；60s 缓存）。
///
/// 临时地址由 RA 生成、短寿命轮换（契约 E2：长连接死因之一）；识别出来才能把
/// `ipv6_temporary` 与 `ipv6_stable` 分开记（I6：有稳定路径不得竞速选短寿命地址）。
    #[test]
    fn relay_fail_does_not_enter_cooldown() {
        let dev = "did:myco:relay-cooldown-test";
        for _ in 0..3 {
            update_route_fail_with_cooldown(dev, "ws://myco.youling.cc:8321/p2p/tunnel?v=2", false);
        }
        let ctx = current_context();
        let g = ctx.lock().unwrap();
        let r = g.peer_routes.get(dev).expect("route recorded");
        assert_eq!(r.cooldown_until, 0, "中继控制面暂时不可用不应触发 300s 冷却");
    }

    #[test]
    fn route_success_records_peer_listen_port() {
        let dev = "did:myco:route-lease-test";
        update_route_success(dev, "ws://[3fff:471:8b0:25fb:e808:fcff:fe6d:e0a8]:9100/p2p/tunnel?v=2", 42);
        let ctx = current_context();
        let g = ctx.lock().unwrap();
        let r = g.peer_routes.get(dev).expect("route recorded");
        assert_eq!(r.peer_listen_port, 9100);
        assert_eq!(r.rtt_ms, 42);
    }

fn temporary_ipv6_snapshot() -> Vec<String> {
    static CACHE: LazyLock<Mutex<(u64, Vec<String>)>> =
        LazyLock::new(|| Mutex::new((0, Vec::new())));
    let now = now_ms_i64().max(0) as u64;
    {
        let g = CACHE.lock().unwrap();
        if now.saturating_sub(g.0) < 60_000 {
            return g.1.clone();
        }
    }
    let mut out: Vec<String> = Vec::new();
    #[cfg(windows)]
    {
        let mut ps = std::process::Command::new("powershell");
        ps.args([
            "-NoProfile",
            "-Command",
            "(Get-NetIPAddress -AddressFamily IPv6 | Where-Object {$_.SuffixOrigin -eq 'Random'}).IPAddress",
        ]);
        {
            use std::os::windows::process::CommandExt;
            ps.creation_flags(0x0800_0000);
        }
        if let Ok(o) = ps.output() {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                let t = line.trim().to_ascii_lowercase();
                if !t.is_empty() {
                    out.push(t);
                }
            }
        }
    }
    *CACHE.lock().unwrap() = (now, out.clone());
    out
}

/// 从候选 base url 里剥出 host（`http://[v6]:port/x` → `v6`；`v4:port` → `v4`；小写）。
fn base_host_raw(b: &str) -> String {
    let t = b.trim();
    let t = t.split_once("://").map(|(_, r)| r).unwrap_or(t);
    let t = t.split('/').next().unwrap_or(t);
    if let Some(rest) = t.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest).to_ascii_lowercase()
    } else {
        t.split(':').next().unwrap_or(t).to_ascii_lowercase()
    }
}

/// IPv4 是否私网/链路本地/CGNAT（→ lan_v4；否则 public_v4）。
fn ipv4_is_lan(host: &str) -> bool {
    let oct: Vec<u32> = host.split('.').filter_map(|o| o.parse().ok()).collect();
    if oct.len() != 4 {
        return false;
    }
    matches!(
        (oct[0], oct[1]),
        (10, _) | (192, 168) | (169, 254) | (172, 16..=31) | (100, 64..=127)
    )
}

/// 候选地址类别（**纯函数 + 60s 临时地址缓存**；单测直击）：
/// `relay` / `loopback` / `lan_v4` / `public_v4` / `ipv6_stable` / `ipv6_temporary`。
/// reflexive（STUN 观测的公网映射）只在探测层产生，候选字符串上无法区分，
/// 归入 public_v4（netstate 面另行标注）。
pub fn classify_candidate_kind(base: &str) -> &'static str {
    if base.trim().to_ascii_lowercase().starts_with("relay://") {
        return "relay";
    }
    if let Some((rh, _)) = relay_addr() {
        if base_host_raw(&format!("http://{rh}")) == base_host_raw(base) {
            return "relay";
        }
    }
    if is_loopback_base(base) {
        return "loopback";
    }
    let host = base_host_raw(base);
    if host.contains(':') {
        if temporary_ipv6_snapshot().iter().any(|t| *t == host) {
            return "ipv6_temporary";
        }
        return "ipv6_stable";
    }
    if ipv4_is_lan(&host) {
        return "lan_v4";
    }
    "public_v4"
}

// ── L3 诊断快照（vnet_lease::netstate_snapshot 消费；只读） ─────────────

/// 一条已记忆路由的只读视图（L3：network_id + 候选 + 实测 RTT/失败/冷却）。
pub(crate) struct Layer3RouteDiag {
    pub network_id: String,
    pub device: String,
    pub preferred_base: String,
    pub kind: String,
    pub rtt_ms: u64,
    pub success_count: u32,
    pub fail_count: u32,
    pub cooldown_until: u64,
    pub last_used: u64,
}

/// 全部网络上下文的路由记忆（进程重启后仍从 `vnet-contexts.json` 读回——
/// 上次成功的 network_id/route/candidate 下次优先探测的底座）。
pub(crate) fn network_layer3_diag() -> (String, Vec<Layer3RouteDiag>) {
    ensure_contexts_loaded();
    let cur = current_network_id();
    let mut out = Vec::new();
    for c in contexts_snapshot() {
        for (device, r) in &c.peer_routes {
            out.push(Layer3RouteDiag {
                network_id: c.network_id.clone(),
                device: device.clone(),
                preferred_base: r.preferred_base.clone(),
                kind: if r.kind.is_empty() {
                    classify_candidate_kind(&r.preferred_base).to_string()
                } else {
                    r.kind.clone()
                },
                rtt_ms: r.rtt_ms,
                success_count: r.success_count,
                fail_count: r.fail_count,
                cooldown_until: r.cooldown_until,
                last_used: r.last_used,
            });
        }
    }
    (cur, out)
}

/// 本机地址族快照（L1/L2：v4/v6 出口是否可用）。
pub(crate) fn local_address_families() -> (bool, bool) {
    (
        primary_local_ipv4().is_some(),
        primary_local_ipv6().is_some(),
    )
}

/// 本机 IPv6 地址快照（诊断用；含链路本地，调用方自行过滤）。
pub fn local_ipv6_snapshot() -> Vec<String> {
    let mut out = Vec::new();
    // 对公网 IPv6 目标做一次 UDP connect（不发包）能让系统选出口地址
    if let Ok(sock) = std::net::UdpSocket::bind("[::]:0") {
        if sock.connect("[2400:3200::1]:53").is_ok() {
            if let Ok(a) = sock.local_addr() {
                if let std::net::IpAddr::V6(v6) = a.ip() {
                    if !v6.is_loopback() && !v6.is_unspecified() {
                        out.push(v6.to_string());
                    }
                }
            }
        }
    }
    // 2026-10-23：同 mdns_lan——原生 IPv6 快照每轮 presence 刷新都会跑，必须静默。
    let mut ps6 = std::process::Command::new("powershell");
    ps6.args(["-NoProfile", "-Command", "(Get-NetIPAddress -AddressFamily IPv6 | Where-Object {$_.IPAddress -notlike '::1'}).IPAddress"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        ps6.creation_flags(0x0800_0000);
    }
    if let Ok(o) = ps6.output() {
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            let t = line.trim().to_string();
            if !t.is_empty() && !out.contains(&t) {
                out.push(t);
            }
        }
    }
    out
}

/// 公网 IPv4 探测（STUN Binding Request，超时 2.5s；失败返回 None，纯诊断用途）。
pub async fn public_ipv4_probe() -> Option<String> {
    use tokio::net::UdpSocket;
    let servers = [
        ("stun.cloudflare.com:3478", "cloudflare"),
        ("stun.l.google.com:19302", "google"),
    ];
    for (addr, _name) in servers {
        let sock = match UdpSocket::bind("0.0.0.0:0").await {
            Ok(s) => s,
            Err(_) => return None,
        };
        if sock.connect(addr).await.is_err() {
            continue;
        }
        let mut req = vec![0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xA4, 0x42];
        req.extend_from_slice(&[0u8; 12]); // 无属性的 binding request
        if sock.send(&req).await.is_err() {
            continue;
        }
        let mut buf = [0u8; 256];
        match tokio::time::timeout(std::time::Duration::from_millis(2500), sock.recv(&mut buf))
            .await
        {
            Ok(Ok(n)) if n >= 20 => {
                let data = &buf[..n];
                // 属性区找 XOR-MAPPED-ADDRESS(0x0020)
                let mut p = 20usize;
                while p + 4 <= n {
                    let atype = u16::from_be_bytes([data[p], data[p + 1]]);
                    let alen = u16::from_be_bytes([data[p + 2], data[p + 3]]) as usize;
                    let vstart = p + 4;
                    if vstart + alen > n {
                        break;
                    }
                    if atype == 0x0020 && alen >= 8 {
                        let xport =
                            u16::from_be_bytes([data[vstart + 2], data[vstart + 3]]) ^ 0x2112;
                        let ip = [
                            data[vstart + 4] ^ 0x21,
                            data[vstart + 5] ^ 0x12,
                            data[vstart + 6] ^ 0xA4,
                            data[vstart + 7] ^ 0x42,
                        ];
                        return Some(format!("{}.{}.{}.{}:{}", ip[0], ip[1], ip[2], ip[3], xport));
                    }
                    p = vstart + ((alen + 3) / 4) * 4;
                }
            }
            _ => continue,
        }
    }
    None
}

/// 候选清单装配（**唯一口径**/// 候选清单装配（**唯一口径**：`tunnel_open` 首建与 `tunnel_conn` 冷重连共用）：
/// 缓存（上次通的 base，排最前）∪ 对端 presence 上报地址 ∪ 本机地址，去重保序。
///
/// 2026-10-11 修：目标**不是本机设备**时不再并入本机地址——本机候选本为"同机
/// 自连/兜底"而设，跨设备场景它只会连到**自己的** p2p 服务器（回环 RTT 最快、
/// 赛跑必胜），把请求发给错误的机器（AP 隔离拓扑实测：要票发给了自己）。
fn candidate_bases(device_did: &str, explicit: &[String]) -> Vec<String> {
    let self_target = myco_core::identity::device_identity()
        .map(|(mine, _)| myco_core::identity::did_equiv(mine.as_str(), device_did))
        .unwrap_or(false);
    let local = if self_target {
        // 2026-10-22 vnet 吞吐真案：自连接（设备隧道到自己）原来只给 LAN/IPv6 候选，
        // 实测 3 个本机候选全败 → **云端中继 582ms 胜出** → 自连吞吐被公网 RTT 限死
        // （3.85MB/s，基线 loopback echo 有 65MB/s）。修：自连接**显式把 127.0.0.1
        // 回环候选排最前**（本机 p2p 服务器就在这个口上，必通且零 RTT）。
        let port = crate::p2p_server::p2p_port().max(1);
        let mut v = vec![format!("http://127.0.0.1:{port}")];
        v.extend(crate::p2p_server::local_candidate_urls(port));
        v
    } else {
        Vec::new()
    };
    let cached = cache_get(device_did);
    // E3 实测开关：禁用 IPv6 时把 v6 候选全部剔除（缓存/presence/local 三条来源都过这里）
    let cached = if tunnel_disable_ipv6() {
        cached.filter(|b| !candidate_is_ipv6(b))
    } else {
        cached
    };
    let explicit_owned: Vec<String> = if tunnel_disable_ipv6() {
        explicit
            .iter()
            .filter(|b| !candidate_is_ipv6(b))
            .cloned()
            .collect()
    } else {
        explicit.to_vec()
    };
    let explicit: &[String] = explicit_owned.as_slice();
    // 2026-10-22 vnet E1：同 LAN 设备经 mDNS 发现（零配置）——追加到候选尾部，
    // 公网/presence 候选优先；mDNS 只在同广播域出现，不会拖慢跨网首连。
    let mut extra: Vec<String> = Vec::new();
    if !self_target {
        extra = crate::mdns_lan::lan_candidates_for(device_did);
    }
    if extra.is_empty() {
        merge_candidates(cached.as_deref(), explicit, &local)
    } else {
        let mut all: Vec<String> = Vec::new();
        all.extend(explicit.iter().cloned());
        all.extend(extra);
        merge_candidates(cached.as_deref(), &all, &local)
    }
}

/// 冷重连限频（毫秒）：全部候选失败时重新问 presence 是**网络动作**，
/// 对端真离线时不该每条浏览器连接都白等一轮。10s 内只问一次。
const REFRESH_MIN_INTERVAL_MS: u128 = 10_000;
static LAST_REFRESH: LazyLock<Mutex<std::collections::HashMap<String, std::time::Instant>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// 重新解析候选地址（限频）。返回 `Some` = 拿到了新清单（可能与原清单相同）。
///
/// 为什么需要：候选清单是 `tunnel_open` 那一刻**快照**下来的。源设备重启 /
/// 换网 / p2p 端口变了之后，旧清单可能**全部不通**——而本地监听端口还在，
/// 浏览器会不断来新连接。此时唯一能自救的动作就是**重新问一次 presence**
/// （对端上线时会重新上报地址），拿到新地址再赛一轮。这就是"隧道自动重建"。
async fn refresh_candidates_throttled(device_did: &str) -> Option<Vec<String>> {
    {
        let mut g = LAST_REFRESH.lock().unwrap();
        let now = std::time::Instant::now();
        if let Some(t) = g.get(device_did) {
            if now.duration_since(*t).as_millis() < REFRESH_MIN_INTERVAL_MS {
                return None;
            }
        }
        if g.len() > 64 {
            g.retain(|_, t| now.duration_since(*t).as_millis() < 600_000);
        }
        g.insert(device_did.to_string(), now);
    }
    let dev = crate::p2p_client::presence_device_by_did_any_kind(device_did).await?;
    let explicit = crate::p2p_client::urls_of(&dev);
    let bases = candidate_bases(device_did, &explicit);
    if bases.is_empty() {
        None
    } else {
        Some(bases)
    }
}

/// `tunnel_open` 的可注入核心（网关/测试直调：显式给候选 base url，跳过 presence 发现）。
/// `bases` = 形如 `http://host:port` 的候选（顺序即优先级；但**建连是并行的**）。
/// 2026-10-11 ⑨：候选为空也**不再直接失败**——中继可用时仍给云端一条路
/// （presence 无此设备/对端没上报直连地址的拓扑，直连无从谈起，中继是唯一活路）。
pub async fn tunnel_open_with_bases(
    bases: Vec<String>,
    target_device_did: &str,
    target_name: &str,
    target_port: u16,
) -> Result<u16, String> {
    let _gate = open_gate(tunnel_key(target_device_did, target_port)).await;
    tunnel_open_with_bases_locked(bases, target_device_did, target_name, target_port).await
}

/// 已持 [`open_gate`] 门锁的内核（`tunnel_open` / 公开入口共用；**不要**直接对外
/// 暴露——重复加锁会自锁）。
async fn tunnel_open_with_bases_locked(
    bases: Vec<String>,
    target_device_did: &str,
    target_name: &str,
    target_port: u16,
) -> Result<u16, String> {
    if !tunnel_port_allowed(target_port) {
        elog!("[p2p-tunnel] tunnel_open_with_bases_locked 拒绝端口 {target_port} target={target_device_did} name={target_name} bases={bases:?}");
        return Err(format!(
            "端口 {target_port} 不在 P2P 隧道白名单（防开放代理）"
        ));
    }
    // 门内复查：并发 opener 中第一个已按**固定口**建好 → 直接复用（幂等，不重建）。
    if let Some(p) = reuse_fixed_if_match(target_device_did, target_port) {
        return Ok(p);
    }
    // 2026-10-13 破案修（笔记本实测自环）：非本机目标的候选里**剔除 loopback**
    // ——127.0.0.1 候选连的是**自己的** 9100（TCP+WS 对自己永远通=必赢的毒候选，
    // 还会以"成功"入缓存长期污染选路；本次实测笔记本的隧道全部自环、PC 侧零
    // 连接、页面 404"分享不存在"=请求回到了笔记本自己的网关）。缓存里的历史
    // 脏条目经此过滤自然失效。本机目标（self）保留 loopback——那是合法自连。
    // 自环判定用测试感知身份：测试以注入身份（TEST_IDENTITY）既当本机又当目标
    // （回环拓扑），读真机身份会把测试的 127.0.0.1 候选全部滤掉（2026-10-14 修）。
    let self_target = self_did_for_loopback_filter()
        .map(|mine| myco_core::identity::did_equiv(mine.as_str(), target_device_did))
        .unwrap_or(false);
    let bases: Vec<String> = if self_target {
        bases
    } else {
        bases.into_iter().filter(|b| !is_loopback_base(b)).collect()
    };
    // 测试注入：强制中继（复现"无 IPv6/NAT 只能中继"，见 [`force_relay`]）
    let bases: Vec<String> = if force_relay() { Vec::new() } else { bases };
    // 中继腿（⑨）：地址已知且未强制直连才参与
    let relay = relay_ready().then(|| RelayPlan {
        device: target_device_did.to_string(),
    });
    if bases.is_empty() && relay.is_none() {
        return Err(format!("{target_name} 无可直连候选地址"));
    }
    // ① 并行赛跑：所有候选同时发起，首个成功即采用（其余立即取消）；
    //    打洞腿 100ms 后加入同一场赛跑（不阻塞/不拖慢直连；直连先通则它连信令都不发）；
    //    云端中继腿 300ms 后加入（直连优先；直连全断时它兜底——⑨）
    let ws_bases: Vec<String> = bases.iter().map(|b| http_to_ws(b)).collect();
    let n_candidates = ws_bases.len();
    let t0 = std::time::Instant::now();
    let active = probe_tunnel_parallel_hp(
        &ws_bases,
        target_port,
        RACE_CANDIDATE_TIMEOUT,
        RACE_TOTAL_BUDGET,
        Some(HpPlan {
            device: target_device_did.to_string(),
            share_id: String::new(),
        }),
        relay.clone(),
    )
    .await
    .ok_or_else(|| {
        // 中继也试过了仍失败 → 目标真不可达（provider 未注册中继/彻底离线）。
        // 文案给人话层（dsh_share 的 tunnel_offline_human）再包一层，这里保技术可读。
        let mut msg = no_route_hint(target_name, n_candidates, true);
        if relay.is_some() {
            msg.push_str("；云端中继也未打通（源设备可能未在线）");
        }
        msg
    })?;
    let elapsed = t0.elapsed();
    // 成功路径入缓存（**归一成 host:port 形态**，与调用方传入的候选同口径——
    // 否则 `merge_candidates` 去重失效，下次同一地址白占两条并行腿）+ 排到最前。
    // relay:// 标记不入缓存（它不是直连候选，由中继腿按需重跑）。
    if !active.starts_with("relay://") {
        cache_put(target_device_did, &ws_to_http(&active));
    }
    elog!(
        "[p2p-tunnel] 赛跑完成 {:.1}ms（{} 候选，胜出 {active}）",
        elapsed.as_secs_f64() * 1000.0,
        n_candidates
    );
    // task-20 AOP Phase 1：建链成功立即写回 S 层（下次连接可走缓存路由，免赛跑）
    update_route_success(target_device_did, &active, elapsed.as_millis() as u64);
    let mut ordered = vec![active.clone()];
    ordered.extend(ws_bases.iter().filter(|b| **b != active).cloned());
    // ② 本地临时监听（只绑 127.0.0.1——隧道口绝不对外）。
    // **2026-10-12 端口持久化**（笔记本/浏览器场景根修）：此前恒 `:0` 随机口——
    // 浏览器里开着的分享页 URL 绑的就是这个口（笔记本 remoteOpen 302 给的
    // 127.0.0.1:55245/gw/…），myco 一重启口就变 → 旧页面**刷新也 ERR_CONNECTION_REFUSED**
    // （用户实测）。现在优先复用上次给该 (device,port) 的口（落盘记忆），
    // 占用/失败回落随机并记新口——重启后刷新即可恢复。
    // ③ 旧隧道先关（同 (device,port) 幂等重开）。
    // **2026-10-15 顺序根修**（笔记本真案：日志"记忆口 61886 被占用，回落随机口"→
    // "隧道已关闭 61886"→ 新口 49909——页面 URL 就这么被换掉的）：原顺序是
    // 先 bind 后关旧——旧隧道自己占着记忆口，新 bind 必然拿随机口。必须**先关再绑**，
    // 幂等重开才能把口拿回来，页面 URL 跨重开保持不变。
    // （若此后 bind 失败：调用方（restore 150 次重试 / remote_open 自身重试）会再来，
    // loopback bind 失败本身近乎不存在。）
    tunnel_close(target_device_did, target_port);
    let listener = bind_preferred_local(target_device_did, target_port).await?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    port_memo_set(target_device_did, target_port, local_port);
    let active_base = Arc::new(Mutex::new(ordered[0].clone()));
    let did = target_device_did.to_string();
    // 候选清单**可热更新**：冷重连（全部候选不通 → 重新问 presence）后写回，
    // 之后的连接直接用新地址（不必每条连接再等一次刷新）。
    let bases_shared = Arc::new(Mutex::new(ordered.clone()));
    let stat = TunnelStat::new();
    let stat_task = stat.clone();
    let bases_task = bases_shared.clone();
    let task = tokio::spawn(async move {
        loop {
            // 黑盒生命周期：单次 accept 失败**不得**让整个本地监听退出。
            // 否则上层看到的是固定本地口突然 ECONNREFUSED——切网/换腿之外，
            // 一个瞬时的 socket/资源错误也会把页面打死（12min 实测曾出现）。
            let accepted = listener.accept().await;
            let (tcp, _peer) = match accepted {
                Ok(v) => v,
                Err(e) => {
                    elog!("[p2p-tunnel] accept 临时错误（{e}）——50ms 后继续监听（不退出）");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            };
            let _ = tcp.set_nodelay(true);
            stat_task.enter();
            let bases = bases_task.clone();
            let ab = active_base.clone();
            let did = did.clone();
            let st = stat_task.clone();
            let leg_id = next_nonce();
            let reg_id = leg_id.clone();
            let did_for_leg = did.clone();
            let (close_tx, close_rx) = tokio::sync::mpsc::unbounded_channel();
            let task = tokio::spawn(async move {
                tunnel_conn(tcp, bases, ab, &did, target_port, Some(close_rx)).await;
                // 连接结束：live 减一 + 打点（回收环据此判定"真的没人用了"）
                st.leave();
                ACTIVE_LEGS.lock().unwrap().remove(&reg_id);
            });
            ACTIVE_LEGS.lock().unwrap().insert(leg_id, (did_for_leg, target_port, task.abort_handle(), close_tx));
        }
    });
    {
        let mut tunnels = TUNNELS.lock().unwrap();
        tunnels.insert(
            tunnel_key(target_device_did, target_port),
            TunnelEntry {
                device_did: target_device_did.to_string(),
                target_port,
                local_port,
                task,
                stat,
            },
        );
    }
    // Modern Standby 真案（2026-10-28 00:22）：AC 3 分钟 idle 会断 Wi-Fi。
    // 只按 live 连接持 SYSTEM request；空挂/残留 listener 不阻止睡眠。
    refresh_power_guard();
    elog!("[p2p-tunnel] 隧道就绪 127.0.0.1:{local_port} → {target_device_did}:{target_port}（{n_candidates} 个候选）");
    // 2026-10-11 提速：① 记录胜出模式（页面指示器经 dsh_share 读）② 启动预热池
    // （隧道虽好，浏览器每条 TCP 连接还要各付一场赛跑+握手——预热在 302 往返的
    // 空档里把首批连接先赛跑好）。③ 中继 TCP 预连（下一场中继腿省一个 RTT）。
    tunnel_mode_put(target_device_did, target_port, mode_of_base(&active));
    warm_start(target_device_did, target_port, ordered.clone());
    if let Some((rh, rp)) = relay_addr() {
        crate::cloud_relay::predial_refill(rh, rp);
    }
    Ok(local_port)
}

/// 强杀某设备的活跃传输腿（保留逻辑会话与端口记忆），供真实断腿/RESUME 测试。
pub(crate) fn debug_leg_drop(device_did: &str) -> usize {
    let handles: Vec<(String, tokio::task::AbortHandle, tokio::sync::mpsc::UnboundedSender<()>)> = {
        let mut g = ACTIVE_LEGS.lock().unwrap();
        let keys: Vec<String> = g
            .iter()
            .filter(|(_, (dev, _, _, _))| myco_core::identity::did_equiv(dev, device_did))
            .map(|(id, _)| id.clone())
            .collect();
        keys.into_iter()
            .filter_map(|id| g.remove(&id).map(|(_, _, h, tx)| (id, h, tx)))
            .collect()
    };
    let n = handles.len();
    for (_, _, tx) in &handles {
        let _ = tx.send(());
    }
    if n > 0 {
        elog!("[p2p-tunnel] debug 先发正常关闭 device={device_did} legs={n}（保留逻辑会话，**不再 abort 本地 TCP**）");
    }
    // 不再 abort：让本地 TCP 保持活着，WS close 会触发 resume_pump_client_inner 的重拨/RESUME。
    // 之前 120ms 后 abort 会把本地连接一起杀掉，导致根本没有主动恢复的机会。
    n
}

/// 关闭某设备（+端口）的隧道：丢弃监听（端口立刻释放）+ abort 接受循环 + 清预热池。
/// 返回是否本来开着。
pub fn tunnel_close(target_device_did: &str, target_port: u16) -> bool {
    let key = tunnel_key(target_device_did, target_port);
    let entry = {
        let mut tunnels = TUNNELS.lock().unwrap();
        tunnels.remove(&key)
    };
    refresh_power_guard();
    warm_drain(&key);
    WARM_TOUCH.lock().unwrap().remove(&key);
    match entry {
        Some(e) => {
            e.task.abort();
            elog!(
                "[p2p-tunnel] 隧道已关闭 127.0.0.1:{} → {}:{}",
                e.local_port, e.device_did, e.target_port
            );
            true
        }
        None => false,
    }
}

/// 当前开着的隧道本地端口（诊断/集成方查询）。
pub fn tunnel_local_port(target_device_did: &str, target_port: u16) -> Option<u16> {
    TUNNELS
        .lock()
        .unwrap()
        .get(&tunnel_key(target_device_did, target_port))
        .map(|e| e.local_port)
}

/// **忘掉一条 (device,port) 的本地口约定**（P1 收口用，2026-11-02）：
/// 清落盘记忆 + 进程内/持久化首选口，让下一次 `tunnel_open` 绑**随机内部口**。
///
/// 场景：应用类分享（dsh）的代签代理要占卡上 `localPort`（如 23911）作为浏览器
/// 入口；raw vnet 转发必须让位到内部随机口。调用方须**先** `tunnel_close`，
/// 再 `forget_tunnel_local_port`，再重开隧道；否则旧监听仍占着约定口。
pub fn forget_tunnel_local_port(target_device_did: &str, target_port: u16) {
    port_memo_remove(target_device_did, target_port);
    set_preferred_local(target_device_did, target_port, None);
}

/// 这条隧道的 **listener 是否真实活着**（I7：在册 ≠ 在听）。
///
/// 2026-10-25 真案（独立复验 + live RED）：`tunnel_local_port` 只查注册表——
/// accept 循环退出（本地 socket 已拆）后条目仍留在 TUNNELS，端口表照样回旧口；
/// vnet keeper 据此把 `listenerPresent` 硬写成 true，API 报"listener 在"而
/// 127.0.0.1:23104 实测无监听（Test-NetConnection 失败、netstat 无行）。
///
/// 判据 = **本进程自己的 accept 任务还在跑**（`!task.is_finished()`）：这是
/// 自己 listener socket 的充要观测——不是上游 health（上游死 listener 可以活着），
/// 也不是外部进程碰巧监听同口（svchost 抢口影响不了我们的 JoinHandle）。
pub fn tunnel_listener_alive(target_device_did: &str, target_port: u16) -> bool {
    TUNNELS
        .lock()
        .unwrap()
        .get(&tunnel_key(target_device_did, target_port))
        .map(|e| !e.task.is_finished())
        .unwrap_or(false)
}

/// listener 真活着的隧道的本地口（`tunnel_local_port` 的 I7 口径版）。
/// 条目在册但 accept 任务已死（socket 已拆）→ `None`——调用方（keeper）据此
/// 走"隧道缺失 → 同口重建"分支，而不是把死条目当活 listener。
pub fn tunnel_live_local_port(target_device_did: &str, target_port: u16) -> Option<u16> {
    if tunnel_listener_alive(target_device_did, target_port) {
        tunnel_local_port(target_device_did, target_port)
    } else {
        None
    }
}

/// 哪个 `(设备, 端口)` 的活隧道正占着这个本地口（**冲突预检**用）。
///
/// 真机事故（2026-10-23）：`kind=http` 不带 localPort 时用了默认 23912，而 23912
/// 已被另一条隧道占着；若先把 23912 写进 keep/preferred 再 bind，失败后**正确口
/// 已被覆盖** → keeper 之后每拍都按冲突口重建、永远失败。调用方应先预检、
/// 冲突时在**写任何持久化之前**明确报错。
pub fn tunnel_owner_of_local_port(local_port: u16) -> Option<(String, u16)> {
    let g = TUNNELS.lock().unwrap();
    g.values()
        .find(|e| e.local_port == local_port)
        .map(|e| (e.device_did.clone(), e.target_port))
}

/// `http://host:port` → `ws://host:port/p2p/tunnel?v=2`（http→ws、https→wss；
/// 已是 ws/wss 的保持 scheme；无 scheme 的补 `ws://`）。
/// **幂等（2026-10-11 修）**：输入已带 `/p2p/tunnel` 路径时剥掉再补——原实现
/// 对 `ws://h/p2p/tunnel?v=2` 会叠成 `…?v=2/p2p/tunnel?v=2`，query 里混进路径
/// → 版本闸 `v` 解析失败一律 400（赛跑测试传完整 ws URL 时全灭的根因）。
/// **版本进 URL**：服务端最廉价地先挡老客户端（v1 无 `?v=2` → 400，不静默降级）。
pub(crate) fn http_to_ws(base: &str) -> String {
    let t = base.trim().trim_end_matches('/');
    let (scheme, rest) = if let Some(r) = t.strip_prefix("https://") {
        ("wss", r)
    } else if let Some(r) = t.strip_prefix("http://") {
        ("ws", r)
    } else if let Some(r) = t.strip_prefix("wss://") {
        ("wss", r)
    } else if let Some(r) = t.strip_prefix("ws://") {
        ("ws", r)
    } else {
        ("ws", t)
    };
    // 只留 host:port（剥可能带的路径/query——重复调用/带路径候选都不叠路径）
    let hostport = rest.split('/').next().unwrap_or(rest);
    let hostport = hostport.split('?').next().unwrap_or(hostport);
    format!("{scheme}://{hostport}/p2p/tunnel?v={TUNNEL_PROTOCOL_VERSION}")
}

/// `ws://host:port/p2p/tunnel?v=2` → `http://host:port`（[`http_to_ws`] 的逆；
/// **缓存口径归一**：`CACHE` 里存的必须是 host:port 形态的 base，否则下次
/// `merge_candidates` 去重失效 → 同一地址既进缓存又进显式候选，白占一条并行腿）。
pub(crate) fn ws_to_http(ws_url: &str) -> String {
    let t = ws_url.trim().trim_end_matches('/');
    let t = t.split_once("/p2p/tunnel").map(|(h, _)| h).unwrap_or(t);
    if let Some(r) = t.strip_prefix("wss://") {
        format!("https://{r}")
    } else if let Some(r) = t.strip_prefix("ws://") {
        format!("http://{r}")
    } else {
        t.to_string()
    }
}

/// 一条本地 TCP 连接 → 一条外层 WS（先试活跃 base，失败则并行回落其余；
/// **全部不通 → 重新解析候选地址再赛一轮**，见 [`refresh_candidates_throttled`]）。
async fn tunnel_conn(
    tcp: TcpStream,
    bases: Arc<Mutex<Vec<String>>>,
    active: Arc<Mutex<String>>,
    device_did: &str,
    target_port: u16,
    close_rx: Option<tokio::sync::mpsc::UnboundedReceiver<()>>,
) {
    REDIAL_PLANS.lock().unwrap().insert(device_did.to_string(), (bases.clone(), active.clone()));
    let session_scope = next_nonce();
    elog!("[p2p-tunnel] tunnel_conn start device={device_did} port={target_port}");
    // 2026-10-11 提速：预热池命中 → 零等待直通（赛跑+WS 升级在池里已做完，
    // 只剩使用时的 AEAD 握手——那是协议绑定 nonce 的必要往返，省不掉）。
    if let Some((base, ws, hs)) = warm_pop(device_did, target_port) {
        *active.lock().unwrap() = base.clone();
        tunnel_mode_put(device_did, target_port, mode_of_base(&base));
        if !base.starts_with(RELAY_BASE) {
            cache_put(device_did, &ws_to_http(&base));
        }
        if let Err(e) = pump_client_with(ws, hs, tcp, device_did, close_rx, &session_scope).await {
            elog!("[p2p-tunnel] 预热连接 {base} 结束（{e}）");
        }
        return;
    }
    let ordered_now =
        |bases: &Arc<Mutex<Vec<String>>>, active: &Arc<Mutex<String>>| -> Vec<String> {
            let cur = active.lock().unwrap().clone();
            let snap = bases.lock().unwrap().clone();
            let mut v = vec![cur.clone()];
            v.extend(snap.iter().filter(|b| **b != cur).cloned());
            // 2026-10-13 破案修：跨设备连接的毒 loopback 候选（含 active 里缓存的
            // 历史脏条目）不参与拨号——见 tunnel_open_with_bases 头注释。
            // 2026-10-14 修：本机目标（self）保留 loopback——与 tunnel_open_with_bases
            // 同一口径（否则自环拓扑下每条本地连接的拨号清单被清空，隧道"就绪"但
            // 一连就断；测试以注入身份既当本机又当目标，正是这条拓扑）。
            let self_target = self_did_for_loopback_filter()
                .map(|mine| myco_core::identity::did_equiv(mine.as_str(), device_did))
                .unwrap_or(false);
            v.retain(|b| self_target || !is_loopback_base(b) || b.is_empty());
            v
        };
    let relay = relay_ready().then(|| RelayPlan {
        device: device_did.to_string(),
    });
    // 2026-10-21（O14 断线重连）：**宽限内重试**——一次赛跑失败不立刻关本地连接，
    // 在 TUNNEL_CONN_GRACE_MS 内每 ~250ms 再赛一轮（冷重连时先刷新一次候选）。
    // 这样浏览器重连的第一次 WS 尝试就能「等」到隧道恢复，避免客户端退避到 3-5s。
    let grace_deadline = std::time::Instant::now() + Duration::from_millis(TUNNEL_CONN_GRACE_MS);
    let mut refreshed = false;
    let picked = loop {
        // task-19/20：D 层决策（缓存路由优先→首选单拨→赛跑兜底）
        let cands = ordered_now(&bases, &active);
        let attempt = dial_with_context(
            device_did,
            &cands,
            target_port,
            ROUTE_EXPLORE_DIAL_TIMEOUT,
            RACE_TOTAL_BUDGET,
            // 打洞腿：每条本地连接都要有自己的五元组配对（防火墙记录随连接生死），
            // 但信令按设备 2s 限频（直连通时这条腿在 100ms 让先里就被 drop，零信令）。
            Some(HpPlan {
                device: device_did.to_string(),
                share_id: String::new(),
            }),
            // 云端中继腿（⑨）：直连全断时这条连接自动走中继——「断线无感降级」。
            relay.clone(),
        )
        .await;
        if attempt.is_some() {
            break attempt;
        }
        if std::time::Instant::now() >= grace_deadline {
            break None;
        }
        if !refreshed {
            // 冷重连：已知地址全不通（源设备重启/换网/p2p 端口变了）→ 重新问一次 presence。
            refreshed = true;
            if let Some(fresh) = refresh_candidates_throttled(device_did).await {
                elog!(
                    "[p2p-tunnel] {device_did}:{target_port} 已知候选全不通 → 刷新候选（{} 个）再赛",
                    fresh.len()
                );
                *bases.lock().unwrap() = fresh;
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    };
    let Some((base, ws, hs_raw)) = picked else {
        let n = note_tunnel_fail(device_did, target_port);
        elog!(
            "[p2p-tunnel] {device_did}:{target_port} 全部候选失败（宽限 {}ms 用尽，连续失败 {n} 次）——本连接关闭",
            TUNNEL_CONN_GRACE_MS
        );
        return;
    };
    note_tunnel_ok(device_did, target_port);
    *active.lock().unwrap() = base.clone();
    // 逐连接的模式记录（中途降级到中继时，指示器口径跟着最后胜者走）
    tunnel_mode_put(device_did, target_port, mode_of_base(&base));
    if !base.starts_with("relay://") {
        cache_put(device_did, &ws_to_http(&base));
    }
    if let Err(e) = pump_client_with(ws, hs_raw, tcp, device_did, close_rx, &session_scope).await {
        elog!("[p2p-tunnel] 隧道 {base} 结束（{e}）");
    }
}

/// 一次竞速的产物：胜出的 base + 已升级成功的 WS + **该连接自己的握手原文**
/// （加密握手要绑定的就是它——握手原文里有 nonce，每次连接不同，不能借用别人的）。
type RacedWs = (String, WsStream, String);

/// **并行赛跑**（核心）：`FuturesUnordered` 同时发起全部候选的建隧道尝试，
/// 首个成功即采用（其余 future 立刻 drop = 取消在途握手）。
/// `budget` 是整场硬预算（用尽返回当前结果），`per_candidate` 是单候选超时。
pub(crate) async fn race_tunnel(
    ws_bases: &[String],
    target_port: u16,
    per_candidate: Duration,
    budget: Duration,
) -> Option<RacedWs> {
    race_tunnel_ex(ws_bases, target_port, per_candidate, budget, None, None).await
}

/// 同上（2026-10-09 双向打洞整合点）：`hp` = Some 时，把**打洞腿**作为一条额外候选
/// 加入同一场赛跑——直连候选仍在 t=0 全量起跑（优先级/时序一字不变），打洞腿
/// 自带 100ms 让先；谁先通谁赢，其余照常取消。打洞腿内部自限（信令限频/ack 超时/
/// 拨号轮数），被 drop 时零清理负担（最坏后果 = 对端多收几个无害探测 SYN）。
///
/// 2026-10-11 ⑨：`relay` = Some 时再加一条**云端中继腿**（300ms 让先——直连优先；
/// 中继腿内部自限 [`RELAY_LEG_TIMEOUT`]）。`relay://` 形态的 base 不参与直连拨号。
pub(crate) async fn race_tunnel_ex(
    ws_bases: &[String],
    target_port: u16,
    per_candidate: Duration,
    budget: Duration,
    hp: Option<HpPlan>,
    relay: Option<RelayPlan>,
) -> Option<RacedWs> {
    let t0 = std::time::Instant::now();
    // 统一装箱（直连候选与打洞腿两种 async 块要进同一个 FuturesUnordered）
    type RacedFut = std::pin::Pin<Box<dyn std::future::Future<Output = Option<RacedWs>> + Send>>;
    // 2026-10-20 R10 诊断：候选里出现过 `ws://myco.youling.cc/p2p/tunnel?v=2`（无端口）——
    // 命中网站 80/443 返回 200，永远失败且浪费赛跑预算。这里显式过滤：
    // · 身份服务域名（myco.youling.cc / myco.youling.cc 的网站面）不是 p2p 直连地址；
    // · IPv4/域名候选必须带显式端口（IPv6 字面量本身含 ':' 不在此列，见 ws_url_host 处理）。
    fn candidate_bogus(b: &str) -> bool {
        let rest = b
            .strip_prefix("ws://")
            .or_else(|| b.strip_prefix("wss://"))
            .unwrap_or(b);
        let authority = rest.split('/').next().unwrap_or("");
        if authority.is_empty() {
            return true;
        }
        if authority.contains("myco.youling.cc") {
            return true;
        }
        // 非 IPv6 字面量（不含方括号）且不含 ':' → 没有端口，不可拨
        if !authority.starts_with('[') && !authority.contains(':') {
            return true;
        }
        false
    }
    elog!(
        "[p2p-tunnel] 赛跑候选 {} 条：{:?}",
        ws_bases.len(),
        ws_bases
    );
    let mk_direct = |b: String| -> RacedFut {
        // relay:// 标记不是直连候选（中继由独立腿跑）——静默跳过，别拿去拨号
        if b.starts_with("relay://") {
            return Box::pin(async move { None });
        }
        if candidate_bogus(&b) {
            elog!("[p2p-tunnel] 跳过无效直连候选 {b}（无显式端口/身份服务域名）");
            return Box::pin(async move { None });
        }
        Box::pin(async move {
            match tokio::time::timeout(per_candidate, connect_tunnel(&b, target_port)).await {
                Ok(Ok((ws, _resp, hs))) => Some((b, ws, hs)),
                Ok(Err(e)) => {
                    elog!("[p2p-tunnel] 候选不通 {b}: {e}");
                    None
                }
                Err(_) => {
                    elog!("[p2p-tunnel] 候选超时 {}ms {b}", per_candidate.as_millis());
                    None
                }
            }
        })
    };
    let mut futs: FuturesUnordered<RacedFut> =
        ws_bases.iter().map(|b| mk_direct(b.clone())).collect();
    if let Some(plan) = hp {
        // 打洞腿：type 与直连候选一致（Option<RacedWs>），胜出时同样走"首个成功即采用"。
        let bases = ws_bases.to_vec();
        let f: RacedFut = Box::pin(async move { hole_punch_leg(bases, target_port, plan).await });
        futs.push(f);
    }
    if let Some(rp) = relay {
        // 云端中继腿（⑨）：同样只是赛跑里的一条候选。
        // 2026-11-03：让先的意义是"直连更快时别抢跑"——**没有任何有效直连候选时
        // 让先纯属白等**（直连全灭的拓扑每个连接固定多付 300ms，笔记本→PC 实测）。
        let has_direct_rival = ws_bases
            .iter()
            .any(|b| !b.starts_with("relay://") && !candidate_bogus(b));
        let relay_delay = if has_direct_rival { RELAY_LEG_DELAY } else { Duration::ZERO };
        let f: RacedFut =
            Box::pin(async move { relay_leg(rp.device, target_port, relay_delay).await });
        futs.push(f);
    }
    let mut winner: Option<RacedWs> = None;
    loop {
        // 第一个成功后，再给"几乎同时完成"的候选极短合流窗口，让真最快的胜出
        let budget_left = budget.saturating_sub(t0.elapsed());
        if budget_left.is_zero() {
            elog!("[p2p-tunnel] 赛跑总预算 {}ms 用尽", budget.as_millis());
            return winner;
        }
        let wait = if winner.is_some() {
            budget_left.min(RACE_SETTLE_WINDOW)
        } else {
            budget_left
        };
        match tokio::time::timeout(wait, futs.next()).await {
            Err(_) => {
                if winner.is_some() {
                    return winner; // 合流窗口用尽 → 采用已胜出者
                }
                elog!("[p2p-tunnel] 赛跑总预算 {}ms 用尽", budget.as_millis());
                return None;
            }
            Ok(None) => return winner, // 全部候选都失败
            Ok(Some(Some(v))) => {
                if let Some((old_base, old_ws, _)) = winner.take() {
                    // 合流窗口内出现更快候选：**优雅关闭**先到者（Close 帧）——drop 会让
                    // 对端看到 RST 并记 enc-fail（本次事故噪声来源之一）。
                    elog!(
                        "[p2p-tunnel] 合流窗口内换更快候选 {old_base} → {}（旧连接优雅关闭）",
                        v.0
                    );
                    tokio::spawn(async move {
                        let mut ws = old_ws;
                        let _ = ws.close(None).await;
                    });
                } else {
                    elog!(
                        "[p2p-tunnel] 首个成功候选 {}（{:.1}ms）",
                        v.0,
                        t0.elapsed().as_secs_f64() * 1000.0
                    );
                }
                winner = Some(v);
            }
            Ok(Some(None)) => {}
        }
    }
}

/// 2026-10-24 task-19（enc-fail 循环根修）：**首选单拨 → 失败才赛跑**。
///
/// 根因取证：PC/笔记本两侧日志里 `upgraded : enc-fail` ≈ 443:368、1167:990（~83-85%），
/// 且失败文案全是 `Connection reset without closing handshake`——这不是加密/密钥错误，
/// 而是**并行赛跑取消败者**：同一时刻拨 N 个候选，首个成功后其余 future 被 drop，已升级
/// 成功的 WS 被内核 RST，对端 `crypto_handshake_server` 读到的正是这句话。每条浏览器
/// 连接/每次预热补池都付一次"N-1 个 RST"，页面重连风暴时两侧同时刷 enc-fail，看起来
/// 就像"双端互踢"。稳态首选（活跃/缓存 base）本来就活着——**先单独拨它一次**就够了；
/// 只有它失败才进入完整并行赛跑（选路成本只在异常时付）。
async fn dial_preferred_or_race(
    bases: &[String],
    target_port: u16,
    per_candidate: Duration,
    budget: Duration,
    hp: Option<HpPlan>,
    relay: Option<RelayPlan>,
) -> Option<RacedWs> {
    if let Some(first) = bases
        .iter()
        .find(|b| !b.trim().is_empty() && !b.starts_with("relay://"))
    {
        let t = per_candidate.min(PREFERRED_DIAL_TIMEOUT);
        if let Ok(Ok((ws, _resp, hs))) =
            tokio::time::timeout(t, connect_tunnel(first, target_port)).await
        {
            return Some((first.clone(), ws, hs));
        }
    }
    race_tunnel_ex(bases, target_port, per_candidate, budget, hp, relay).await
}

/// 探路：并行赛跑建一次隧道（成功即关掉探路连接），返回可用 base。
pub(crate) async fn probe_tunnel_parallel(
    ws_bases: &[String],
    target_port: u16,
    per_candidate: Duration,
    budget: Duration,
) -> Option<String> {
    probe_tunnel_parallel_hp(ws_bases, target_port, per_candidate, budget, None, None).await
}

/// 同上，可带一条**打洞候选腿**（`tunnel_open` 首建用——直连照常先跑，打洞 100ms 后加入）。
/// 2026-10-11 ⑨：`relay` = Some 时再带云端中继腿（直连全断时它赢 → 隧道仍能建）。
pub(crate) async fn probe_tunnel_parallel_hp(
    ws_bases: &[String],
    target_port: u16,
    per_candidate: Duration,
    budget: Duration,
    hp: Option<HpPlan>,
    relay: Option<RelayPlan>,
) -> Option<String> {
    match race_tunnel_ex(ws_bases, target_port, per_candidate, budget, hp, relay).await {
        Some((base, mut ws, _hs)) => {
            let _ = ws.close(None).await;
            Some(base)
        }
        None => None,
    }
}

// ══════════════════ ⑦ 双向打洞（hole punching，2026-10-09 三设备实测后补的缺口） ══════════════════
//
// **问题（pktmon 实证）**：手机/笔记本 → PC（家宽）IPv6:9100 单向发起，PC 网卡零包到达。
// 根因：家宽光猫/路由器的**有状态防火墙**只放行"有对应出站记录的入站包"——
// 单向 SYN 没有五元组匹配的出站流 → 被丢弃。
//
// **解法（设计文档 design/07-connectivity/P2P-并行建联方案.md）**：双向打洞——
// 两台设备**同时**向对方发探测包，在各自防火墙上创建出站记录，让对方的 SYN 进得来。
// TCP 打洞的端口配对（关键）：有状态防火墙按五元组
// (src_ip, src_port, dst_ip, dst_port, proto) 匹配——
//   A 的出站探测：A_ip:9100 → B_ip:P   （在 A 侧光猫创建记录）
//   B 的入站 SYN：B_ip:P    → A_ip:9100（五元组完全反转 = "已建立流" → 放行）
// 所以 B **必须预绑端口 P**（`TcpListener::bind` 拿到确定端口后释放，后续 connect 从
// 这个源口发出），并在信令里告知 A；A 的探测必须**从 :9100 发出**（B 将要拨的端口）。
//
// **时序**：t=0 直连候选并行起跑（既有逻辑一字不动）→ t=100ms 打洞腿加入赛跑
// （LAN 直连 <5ms 已赢时，打洞腿在 sleep 里就被 drop，**零信令、零网络动作**）→
// B 预绑 P + 发 `hole-punch-request` → A 收到即回 `hole-punch-ack` 并从 :9100 向 B 的
// 候选发探测 SYN（大概率失败——B 没在监听——但足以在 A 侧光猫创建出站记录）→
// B 收到 ack 后从 P 向 A 的候选 :9100 发 SYN（500ms 短超时，循环重试 3 轮）→
// 防火墙匹配 → 建连 → 该连接即为隧道连接（WS 握手照常做）。
//
// **信令通道**：复用 chat_service 的 P2P 控制消息底座（`send_share_entry_msg` 同款、
// 可注入；设备签名信封 + 直推），**数据面永远不经服务器**。直推不可达时兜底落
// identity-svc 信箱（/msg/send——服务器 kind 白名单补上 `hole-punch-*` 后即通，
// 见报告遗留）。**诚实边界**：双方都出不去时（本功能的目标场景），直推信令同样
// 过不去——这正是要服务器信箱兜底的原因；本模块不发明 TURN 中继。
//
// **取消策略**：打洞腿是 `race_tunnel_ex` FuturesUnordered 里的一条普通候选——
// 任何腿先成功，其余立即 drop（打洞腿若在 sleep/等 ack 阶段被 drop，最坏后果是
// A 多发几个无害探测 SYN，出站记录 30s 级自然过期）。信令按设备 2s 限频，
// 防对端真不可达时每条浏览器连接都白打一轮信令。

/// 打洞信令 kind：B → A，"请从我声明过的地址反向探测我"。
pub const HOLE_PUNCH_REQUEST_KIND: &str = "hole-punch-request";
/// 打洞信令 kind：A → B，"收到，我已开始探测"（收到即回，不等探测完成）。
pub const HOLE_PUNCH_ACK_KIND: &str = "hole-punch-ack";
/// 打洞腿的起跑延迟：直连候选先跑这么多毫秒（给 LAN 一点点先手机会，但不阻塞）。
pub const HOLE_PUNCH_START_DELAY: Duration = Duration::from_millis(100);
/// B 等 ack 的超时：超了继续走直连路径（race 里直连腿本来就并行在跑）。
pub const HOLE_PUNCH_ACK_TIMEOUT: Duration = Duration::from_secs(2);
/// B 打洞拨号的单次超时（短超时快速换下一个候选/下一轮）。
pub const HOLE_PUNCH_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
/// B 打洞拨号的重试轮数（每轮扫全部候选地址）。
pub const HOLE_PUNCH_CONNECT_ROUNDS: u32 = 3;
/// A 侧探测的单次超时。
pub const HOLE_PUNCH_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
/// 信令新鲜窗口：超过这个 ts 的 request 一律不理（迟到探测只扰民）。
pub const HOLE_PUNCH_FRESH_MS: i64 = 30_000;
/// 信令按设备限频（两条腿并发时也别轰炸对端）。
const HOLE_PUNCH_SIGNAL_MIN_INTERVAL: Duration = Duration::from_secs(2);
/// B 声明给 A 的候选地址上限（防信令被当成端口扫描清单）。
const HOLE_PUNCH_MAX_CANDIDATES: usize = 8;

/// B 声明的一个可探测候选：`{addr, port}`（port = B 预绑的本地端口 P）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HolePunchCandidate {
    pub addr: String,
    pub port: u16,
}

/// `hole-punch-request` 载荷：`{requestId, candidates: [{addr, port}], shareId, ts}`。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HolePunchRequest {
    pub request_id: String,
    pub candidates: Vec<HolePunchCandidate>,
    pub share_id: String,
    pub ts: i64,
}

/// `hole-punch-ack` 载荷：`{requestId, ts}`。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HolePunchAck {
    pub request_id: String,
    pub ts: i64,
}

/// 构造 request 载荷（wire 形状唯一口径——单测锁形状）。
pub(crate) fn hole_punch_request_payload(
    request_id: &str,
    candidates: &[HolePunchCandidate],
    share_id: &str,
) -> Value {
    serde_json::to_value(HolePunchRequest {
        request_id: request_id.to_string(),
        candidates: candidates.to_vec(),
        share_id: share_id.to_string(),
        ts: chrono::Utc::now().timestamp_millis(),
    })
    .unwrap_or(Value::Null)
}

/// 解析 request 载荷（形状 + 新鲜度 + 候选有效性；`now_ms` 供单测拨时钟）。
/// 候选过滤：addr 非空、port≠0；过滤后为空 → None。
pub(crate) fn parse_hole_punch_request(p: &Value, now_ms: i64) -> Option<HolePunchRequest> {
    let mut req: HolePunchRequest = serde_json::from_value(p.clone()).ok()?;
    req.request_id = req.request_id.trim().to_string();
    if req.request_id.is_empty() {
        return None;
    }
    if now_ms.saturating_sub(req.ts) > HOLE_PUNCH_FRESH_MS {
        return None; // 迟到的信令：探测早已没意义
    }
    req.candidates
        .retain(|c| !c.addr.trim().is_empty() && c.port != 0);
    req.candidates.truncate(HOLE_PUNCH_MAX_CANDIDATES);
    if req.candidates.is_empty() {
        return None;
    }
    Some(req)
}

/// 构造 ack 载荷。
pub(crate) fn hole_punch_ack_payload(request_id: &str) -> Value {
    serde_json::to_value(HolePunchAck {
        request_id: request_id.to_string(),
        ts: chrono::Utc::now().timestamp_millis(),
    })
    .unwrap_or(Value::Null)
}

/// 解析 ack 载荷（有 requestId 即可——ack 没有会话语义，迟到无害）。
pub(crate) fn parse_hole_punch_ack(p: &Value) -> Option<HolePunchAck> {
    let mut ack: HolePunchAck = serde_json::from_value(p.clone()).ok()?;
    ack.request_id = ack.request_id.trim().to_string();
    if ack.request_id.is_empty() {
        return None;
    }
    Some(ack)
}

// ── ack 等待表（B 侧） ──

/// requestId → ack 唤醒通道（B 发 request 前登记，ack ingest 唤醒）。
static HP_ACK_WAITERS: LazyLock<
    Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>,
> = LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// 登记一个 ack 等待者（同 requestId 重复登记 = 覆盖旧通道，旧的被丢弃）。
pub(crate) fn hp_ack_register(request_id: &str) -> tokio::sync::oneshot::Receiver<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    HP_ACK_WAITERS
        .lock()
        .unwrap()
        .insert(request_id.to_string(), tx);
    rx
}

/// ack 到达（chat_service 的 `hole-punch-ack` ingest 调）。`true` = 确实唤醒了一个等待者。
pub(crate) fn hole_punch_ack_arrived(request_id: &str) -> bool {
    match HP_ACK_WAITERS.lock().unwrap().remove(request_id) {
        Some(tx) => tx.send(()).is_ok(),
        None => false,
    }
}

// ── 探测审计（A 侧） ──

/// 一条打洞探测记录（人话：谁让我探哪个地址、我从哪个源口发的、结果如何）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HolePunchProbe {
    pub ts: i64,
    /// 探测目标 `addr:port`（B 声明的候选）。
    pub target: String,
    /// 实际使用的源端口（配对成败的关键证据；回退临时口时与 wanted 不同）。
    pub src_port: u16,
    /// 期望的源端口（= 本机 p2p 端口，B 将拨的端口）。
    pub wanted_port: u16,
    /// probe-open（对面居然在听）| probe-refused | probe-timeout | probe-error | probe-bad-addr
    /// —— refused/timeout 都是**正常成功**：出站记录已创建，这正是探测的目的。
    pub result: String,
}

const HP_PROBE_AUDIT_CAP: usize = 128;
static HP_PROBE_AUDIT: LazyLock<Mutex<Vec<HolePunchProbe>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));

fn hp_probe_audit_push(rec: HolePunchProbe) {
    elog!(
        "[p2p-tunnel] 打洞探测 {} 自 :{}（期望 :{}）→ {}",
        rec.target, rec.src_port, rec.wanted_port, rec.result
    );
    let mut g = HP_PROBE_AUDIT.lock().unwrap();
    if g.len() >= HP_PROBE_AUDIT_CAP {
        g.remove(0);
    }
    g.push(rec);
}

/// 最近打洞探测记录（旧→新；诊断/单测）。
pub fn hole_punch_probe_recent() -> Vec<HolePunchProbe> {
    HP_PROBE_AUDIT.lock().unwrap().clone()
}

/// 从指定源口向 `addr:port` 发一次探测 SYN（A 侧核心动作）。
/// 返回 `(result, 建立的连接)`——连接通常 None（对面没在听），但**出站记录已创建**。
///
/// 源口绑定：优先 `src_port`（= p2p 端口，五元组配对的命门），`SO_REUSEADDR`
/// 与在听的 p2p 服务器共存（Windows 语义；Linux 若 EADDRINUSE 则回退临时口并如实审计）。
pub(crate) async fn hole_punch_probe_once(
    addr: &str,
    port: u16,
    src_port: u16,
) -> (String, Option<TcpStream>) {
    let target = match format_host_port_for_dial(addr, port).parse::<SocketAddr>() {
        Ok(t) => t,
        Err(_) => {
            hp_probe_audit_push(HolePunchProbe {
                ts: now_ms_i64(),
                target: format_host_port_for_dial(addr, port),
                src_port: 0,
                wanted_port: src_port,
                result: "probe-bad-addr".into(),
            });
            return ("probe-bad-addr".into(), None);
        }
    };
    let (stream, actual_src) = dial_from_port(target, src_port, HOLE_PUNCH_PROBE_TIMEOUT).await;
    let result = match &stream {
        Some(_) => "probe-open".to_string(),
        None => "probe-fail".to_string(), // 拒绝/超时/错误统一记 fail——细节在 eprintln
    };
    hp_probe_audit_push(HolePunchProbe {
        ts: now_ms_i64(),
        target: format_host_port_for_dial(addr, port),
        src_port: actual_src,
        wanted_port: src_port,
        result: result.clone(),
    });
    (result, stream)
}

/// A 侧：对 B 声明的每个候选地址发探测（spawn、不阻塞 ingest）。
/// `src_port` = 本机 p2p 端口（B 将要拨的端口——五元组配对要求源口一致）。
pub(crate) fn spawn_hole_punch_probes(candidates: &[HolePunchCandidate], src_port: u16) {
    for c in candidates {
        let (addr, port) = (c.addr.clone(), c.port);
        tokio::spawn(async move {
            let (_result, _stream) = hole_punch_probe_once(&addr, port, src_port).await;
            // 探测连接立即关闭（探测的目的只是创建出站记录）
        });
    }
}

/// `addr:port` 拨号记法（IPv6 走 `[addr]:port`）。
fn format_host_port_for_dial(addr: &str, port: u16) -> String {
    if addr.contains(':') && !addr.starts_with('[') {
        format!("[{addr}]:{port}")
    } else {
        format!("{addr}:{port}")
    }
}

/// **预绑端口**（B 侧）：`bind("0.0.0.0:0")` 拿到确定的本地端口 P 后立刻释放——
/// 后续 `dial_from_port` 会以 P 为源口发起连接（有状态防火墙按五元组匹配，源口必须
/// 与信令里声明的一致，不能让内核随机分配）。释放与重绑之间有极小被抢占窗口，
/// 由拨号重试轮次兜底。
pub(crate) fn pre_bind_port() -> std::io::Result<u16> {
    let l = std::net::TcpListener::bind("0.0.0.0:0")?;
    let p = l.local_addr()?.port();
    drop(l);
    Ok(p)
}

/// 从指定本地源口向 target 发起 TCP 连接（B 打洞拨号 / A 探测共用底座）。
/// 返回 `(连接, 实际源口)`——源口绑定失败时回退内核临时口（如实返回，审计可辨）。
async fn dial_from_port(
    target: SocketAddr,
    local_port: u16,
    per: Duration,
) -> (Option<TcpStream>, u16) {
    let mk_sock = || -> std::io::Result<tokio::net::TcpSocket> {
        let s = match target {
            SocketAddr::V4(_) => tokio::net::TcpSocket::new_v4()?,
            SocketAddr::V6(_) => tokio::net::TcpSocket::new_v6()?,
        };
        s.set_reuseaddr(true)?;
        Ok(s)
    };
    let bind_addr: SocketAddr = match target {
        SocketAddr::V4(_) => format!("0.0.0.0:{local_port}").parse().unwrap(),
        SocketAddr::V6(_) => format!("[::]:{local_port}").parse().unwrap(),
    };
    // 第一试：绑上指定源口（五元组配对的命门）
    let sock = match mk_sock().and_then(|s| s.bind(bind_addr).map(|_| s)) {
        Ok(s) => s,
        Err(e) => {
            elog!(
                "[p2p-tunnel] 源口 :{local_port} 绑定失败（{e}）——回退临时口（配对可能失效）"
            );
            // 回退：不 bind，connect 时内核分配临时源口
            match mk_sock() {
                Ok(s) => s,
                Err(_) => return (None, 0),
            }
        }
    };
    let fut = sock.connect(target);
    match tokio::time::timeout(per, fut).await {
        Ok(Ok(stream)) => {
            let actual = stream.local_addr().map(|a| a.port()).unwrap_or(0);
            (Some(stream), actual)
        }
        Ok(Err(e)) => {
            elog!("[p2p-tunnel] 探测/拨号 {target} 自 :{local_port} → {e}");
            (None, 0)
        }
        Err(_) => {
            elog!(
                "[p2p-tunnel] 探测/拨号 {target} 自 :{local_port} → 超时（{}ms）",
                per.as_millis()
            );
            (None, 0)
        }
    }
}

/// 候选 base（`http(s)://host:port` / `ws(s)://host:port`）→ `(host, port)`。
/// IPv6 方括号形态、无 scheme 形态都认；无端口 → None（打洞必须知道对端端口）。
pub(crate) fn base_host_port(base: &str) -> Option<(String, u16)> {
    let t = base.trim().trim_end_matches('/');
    let t = t.split_once("://").map(|(_, r)| r).unwrap_or(t);
    let t = t.split('/').next().unwrap_or(t);
    let hostport = if let Some(q) = t.split_once('?') {
        q.0
    } else {
        t
    };
    if let Some(rest) = hostport.strip_prefix('[') {
        let (h, r) = rest.split_once(']')?;
        let port = r.strip_prefix(':')?.parse().ok()?;
        return Some((h.to_string(), port));
    }
    let (h, p) = hostport.rsplit_once(':')?;
    if h.is_empty() {
        return None;
    }
    Some((h.to_string(), p.parse().ok()?))
}

/// 在**已建立的 TCP 流**上做隧道 WS 握手（打洞成功的连接就地升级成隧道连接）。
/// 与 [`connect_tunnel`] 同一套信封/签名头，只是传输层不再自己拨号。
async fn connect_tunnel_from_stream(
    ws_url: &str,
    target_port: u16,
    stream: TcpStream,
) -> Result<RacedWs, String> {
    if target_port == 0 {
        elog!("[p2p-tunnel] connect_tunnel_from_stream 拒绝 port=0 base={ws_url}，调用栈：\n{}", std::backtrace::Backtrace::capture());
        return Err("目标端口为 0，拒绝发起隧道握手".into());
    }
    if !tunnel_port_allowed(target_port) {
        elog!("[p2p-tunnel] connect_tunnel_from_stream 拒绝非白名单端口 {target_port}");
        return Err(format!("端口 {target_port} 不在隧道白名单"));
    }
    let (handshake, auth) = tunnel_credentials(target_port)?;
    let mut req = ws_url
        .into_client_request()
        .map_err(|e| format!("URL 无效: {e}"))?;
    req.headers_mut().insert(
        TUNNEL_HANDSHAKE_HEADER,
        HeaderValue::from_str(&handshake).map_err(|e| format!("握手头编码失败: {e}"))?,
    );
    req.headers_mut().insert(
        "x-myco-auth",
        HeaderValue::from_str(&auth).map_err(|e| format!("签名头编码失败: {e}"))?,
    );
    let t_ws = std::time::Instant::now();
    let (ws, _resp) =
        tokio_tungstenite::client_async(req, tokio_tungstenite::MaybeTlsStream::Plain(stream))
            .await
            .map_err(|e| format!("{e}"))?;
    elog!("[p2p-tunnel] ws-upgrade-from-stream base={ws_url} ms={}", t_ws.elapsed().as_millis());
    Ok((ws_url.to_string(), ws, handshake))
}

// ── 信令限频 + 目标账号解析 ──

/// 按设备的最近一次打洞信令时刻（限频用）。
static HP_LAST_SIGNAL: LazyLock<Mutex<std::collections::HashMap<String, std::time::Instant>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

fn hp_signal_throttled(device: &str) -> bool {
    match HP_LAST_SIGNAL.lock().unwrap().get(device) {
        Some(t) => t.elapsed() < HOLE_PUNCH_SIGNAL_MIN_INTERVAL,
        None => false,
    }
}

fn hp_signal_sent(device: &str) {
    let mut g = HP_LAST_SIGNAL.lock().unwrap();
    if g.len() > 64 {
        let now = std::time::Instant::now();
        g.retain(|_, t| now.duration_since(*t) < HOLE_PUNCH_SIGNAL_MIN_INTERVAL * 10);
    }
    g.insert(device.to_string(), std::time::Instant::now());
}

/// 测试注入：目标设备 → 信令目标账号（测试态**绝不触网**；未注入 = 打洞腿禁用）。
#[cfg(test)]
static TEST_HP_ACCOUNT_OVERRIDE: LazyLock<Mutex<Option<(String, String)>>> =
    LazyLock::new(|| Mutex::new(None));

#[cfg(test)]
pub(crate) fn test_set_hp_account(device: &str, account: Option<&str>) {
    *TEST_HP_ACCOUNT_OVERRIDE.lock().unwrap() =
        account.map(|a| (device.to_string(), a.to_string()));
}

/// 目标账号解析缓存（prod 用；Some 30s / None 5s——None 短缓存防对端离线时每腿都问）。
#[cfg(not(test))]
static HP_ACCOUNT_CACHE: LazyLock<
    Mutex<std::collections::HashMap<String, (Option<String>, std::time::Instant)>>,
> = LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// 解析目标设备所属账号（信令投递地址）。prod 走 presence（`/presence/list` 行的
/// rootDid，did_equiv **canonical-only** 归一），750ms 短超时 + 进程内缓存；**测试态只认注入值，
/// 绝不触网**（未注入 → None → 打洞腿静默退出，既有测试行为一字不变）。
async fn hp_resolve_account(device_did: &str) -> Option<String> {
    #[cfg(test)]
    {
        let o = TEST_HP_ACCOUNT_OVERRIDE.lock().unwrap().clone();
        return o.and_then(|(dev, acc)| {
            if myco_core::identity::did_equiv(&dev, device_did) {
                Some(acc)
            } else {
                None
            }
        });
    }
    #[cfg(not(test))]
    {
        {
            let g = HP_ACCOUNT_CACHE.lock().unwrap();
            if let Some((acc, at)) = g.get(device_did) {
                let ttl = if acc.is_some() {
                    Duration::from_secs(30)
                } else {
                    Duration::from_secs(5)
                };
                if at.elapsed() < ttl {
                    return acc.clone();
                }
            }
        }
        let got = tokio::time::timeout(
            Duration::from_millis(750),
            crate::chat_service::resolve_device_account(device_did),
        )
        .await
        .ok()
        .flatten();
        HP_ACCOUNT_CACHE.lock().unwrap().insert(
            device_did.to_string(),
            (got.clone(), std::time::Instant::now()),
        );
        got
    }
}

/// 一场赛跑里打洞腿的参数（谁在对端、什么场景——账号解析在腿内部懒做，不阻塞直连）。
#[derive(Debug, Clone)]
pub(crate) struct HpPlan {
    /// 目标设备 did（解析信令投递账号 + 限频键）。
    pub device: String,
    /// 场景上下文（分享 id；隧道通用场景为空串）。
    pub share_id: String,
}

/// 测试注入：打洞腿起跑延迟覆盖（验证"直连先通→零信令"不变量时拉开与
/// 合流窗的差距，规避 Windows 定时器粒度 ~15.6ms 的翻转竞态；生产恒 100ms）。
#[cfg(test)]
static TEST_HP_START_DELAY: LazyLock<Mutex<Option<Duration>>> = LazyLock::new(|| Mutex::new(None));

#[cfg(test)]
pub(crate) fn test_set_hp_start_delay(d: Option<Duration>) {
    *TEST_HP_START_DELAY.lock().unwrap() = d;
}

fn hp_start_delay() -> Duration {
    #[cfg(test)]
    {
        TEST_HP_START_DELAY
            .lock()
            .unwrap()
            .unwrap_or(HOLE_PUNCH_START_DELAY)
    }
    #[cfg(not(test))]
    {
        HOLE_PUNCH_START_DELAY
    }
}

/// B 侧打洞腿（`race_tunnel_ex` 的一条候选）：
/// 100ms 让先 → 预绑 P → 发信令 → 等 ack（2s）→ 从 P 逐候选短超时拨号 → 成功即做
/// 隧道 WS 握手返回。任何一步失败返回 None（直连腿照常赛跑，互不拖累）。
async fn hole_punch_leg(ws_bases: Vec<String>, target_port: u16, plan: HpPlan) -> Option<RacedWs> {
    tokio::time::sleep(hp_start_delay()).await;
    if hp_signal_throttled(&plan.device) {
        return None;
    }
    let Some(account) = hp_resolve_account(&plan.device).await else {
        return None; // 对端账号不可知（离线/未上报）→ 没有信令地址，打洞无从谈起
    };
    let Ok(port_p) = pre_bind_port() else {
        elog!("[p2p-tunnel] 打洞预绑端口失败——继续直连路径");
        return None;
    };
    // B 的候选地址（A 将探测的目标）：本机多路径候选 ∪ 反射地址，全部配预绑口 P
    let my_dev = my_tunnel_identity()
        .ok()
        .map(|(_, did, _)| did)
        .unwrap_or_default();
    let mut addrs: Vec<String> = crate::p2p_server::detect_local_candidates().ordered();
    if let Some((reflex, _)) = crate::p2p_server::reflexive_addrs(&my_dev) {
        if !reflex.is_empty() && !addrs.iter().any(|a| a == &reflex) {
            addrs.push(reflex);
        }
    }
    let candidates: Vec<HolePunchCandidate> = addrs
        .into_iter()
        .take(HOLE_PUNCH_MAX_CANDIDATES)
        .map(|addr| HolePunchCandidate { addr, port: port_p })
        .collect();
    let request_id = format!("hp-{}", next_nonce());
    let rx = hp_ack_register(&request_id);
    let payload = hole_punch_request_payload(&request_id, &candidates, &plan.share_id);
    if let Err(e) =
        crate::chat_service::hp_signal_send(&account, HOLE_PUNCH_REQUEST_KIND, payload).await
    {
        elog!("[p2p-tunnel] 打洞信令未送达（{e}）——继续直连路径");
        return None;
    }
    hp_signal_sent(&plan.device);
    elog!(
        "[p2p-tunnel] 打洞信令已发（requestId={request_id}，{} 候选，预绑口 {port_p}，对端 {account}）——等 ack（{}ms）",
        candidates.len(),
        HOLE_PUNCH_ACK_TIMEOUT.as_millis()
    );
    match tokio::time::timeout(HOLE_PUNCH_ACK_TIMEOUT, rx).await {
        Ok(Ok(())) => {}
        _ => {
            elog!(
                "[p2p-tunnel] 打洞 ack 超时（{}ms）——继续直连路径",
                HOLE_PUNCH_ACK_TIMEOUT.as_millis()
            );
            return None;
        }
    }
    // ack 到了：A 的出站探测已在路上。从预绑口 P 向 A 的每个候选 :port 发 SYN。
    for round in 0..HOLE_PUNCH_CONNECT_ROUNDS {
        for b in &ws_bases {
            let Some((host, hport)) = base_host_port(b) else {
                continue;
            };
            let target = match format_host_port_for_dial(&host, hport).parse::<SocketAddr>() {
                Ok(t) => t,
                Err(_) => continue,
            };
            match dial_from_port(target, port_p, HOLE_PUNCH_CONNECT_TIMEOUT).await {
                (Some(stream), actual) => {
                    let paired = actual == port_p;
                    elog!(
                        "[p2p-tunnel] 打洞拨号第 {} 轮命中 {b}（源口 :{actual}，预绑 :{port_p}，配对{}）——就地升级隧道",
                        round + 1,
                        if paired { "成立" } else { "已回退临时口" }
                    );
                    match connect_tunnel_from_stream(b, target_port, stream).await {
                        Ok(w) => return Some(w),
                        Err(e) => elog!("[p2p-tunnel] 打洞连接的隧道握手失败 {b}: {e}"),
                    }
                }
                _ => {}
            }
        }
    }
    elog!("[p2p-tunnel] 打洞 {HOLE_PUNCH_CONNECT_ROUNDS} 轮拨号全部未通——继续直连路径");
    None
}

/// 测试复位（打洞全局态：等待表/限频表/审计/账号注入/起跑延迟覆盖）。
#[cfg(test)]
pub(crate) fn test_clear_hp_state() {
    HP_ACK_WAITERS.lock().unwrap().clear();
    HP_LAST_SIGNAL.lock().unwrap().clear();
    HP_PROBE_AUDIT.lock().unwrap().clear();
    test_set_hp_account("", None);
    test_set_hp_start_delay(None);
}

/// 建一条外层 WS：握手信封 + 设备签名头（每次连接重新签名——ts 窗口 60s 不能复用）。
/// **只做传输层升级**；v2 加密握手由调用方在拿到 WS 后立刻进行
/// （[`crypto_handshake_client`]，用返回的握手原文绑定密钥）。分开的理由：赛跑只需要
/// "可达且端点接受"，ECDH 放在胜出者身上做（少做 N-1 次密钥协商）。
/// 返回 `(WS, HTTP 响应, 本次连接的握手原文)`。
async fn connect_tunnel(
    ws_url: &str,
    target_port: u16,
) -> Result<
    (
        WsStream,
        tokio_tungstenite::tungstenite::handshake::client::Response,
        String,
    ),
    String,
> {
    if target_port == 0 {
        elog!("[p2p-tunnel] connect_tunnel 拒绝 port=0 base={ws_url}，调用栈：\n{}", std::backtrace::Backtrace::capture());
        return Err("目标端口为 0，拒绝发起隧道握手".into());
    }
    if !tunnel_port_allowed(target_port) {
        elog!("[p2p-tunnel] connect_tunnel 拒绝非白名单端口 {target_port}");
        return Err(format!("端口 {target_port} 不在隧道白名单"));
    }
    let (handshake, auth) = tunnel_credentials(target_port)?;
    // 候选可能以 http:// 传来（presence/urls_of 的原生形态）——WebSocket 客户端
    // 只认 ws/wss，先归一（http→ws / https→wss / 已是 ws 原样补路径）。
    let normalized = http_to_ws(ws_url);
    let mut req = normalized
        .as_str()
        .into_client_request()
        .map_err(|e| format!("URL 无效（{ws_url} → {normalized}）: {e}"))?;
    req.headers_mut().insert(
        TUNNEL_HANDSHAKE_HEADER,
        HeaderValue::from_str(&handshake).map_err(|e| format!("握手头编码失败: {e}"))?,
    );
    req.headers_mut().insert(
        "x-myco-auth",
        HeaderValue::from_str(&auth).map_err(|e| format!("签名头编码失败: {e}"))?,
    );
    // 2026-10-22 vnet 吞吐真案：connect_async 内部建的 TCP **不设 TCP_NODELAY**，
    // 64KB 密文帧的最后一个 TCP 段会被 Nagle 扣住等延迟 ACK（~40ms）→ 隧道吞吐被
    // 限死在几 MB/s（实测自连单向 5-11MB/s、echo 3MB/s，而 loopback 基线 800+MB/s）。
    // 修法：自己拨 TCP + 开 nodelay，再 client_async 跑 WS 握手（URL/Host 头不变）。
    let url: axum::http::Uri = normalized
        .parse()
        .map_err(|e: axum::http::uri::InvalidUri| format!("URL 无效: {e}"))?;
    let host = url
        .host()
        .ok_or("URL 缺 host")?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let port = url.port_u16().unwrap_or(if normalized.starts_with("wss") {
        443
    } else {
        80
    });
    let stream = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::net::TcpStream::connect((host.as_str(), port)),
    )
    .await
    .map_err(|_| format!("隧道端点 {host}:{port} 连接超时"))?
    .map_err(|e| format!("隧道端点 {host}:{port} 连接失败: {e}"))?;
    let _ = stream.set_nodelay(true);
    let t_ws = std::time::Instant::now();
    let r = tokio_tungstenite::client_async(req, tokio_tungstenite::MaybeTlsStream::Plain(stream))
        .await
        .map(|(ws, resp)| (ws, resp, handshake))
        .map_err(|e| format!("{e}"));
    elog!("[p2p-tunnel] ws-upgrade base={ws_url} ms={}", t_ws.elapsed().as_millis());
    r
}

/// 本机隧道身份：`(account_did, device_did, signing_key)`。测试可注入确定性钥匙。
#[cfg(test)]
static TEST_IDENTITY: LazyLock<Mutex<Option<(String, String, [u8; 32])>>> =
    LazyLock::new(|| Mutex::new(None));

#[cfg(test)]
pub(crate) fn test_set_identity(account: &str, device_did: &str, seed: [u8; 32]) {
    *TEST_IDENTITY.lock().unwrap() = Some((account.to_string(), device_did.to_string(), seed));
}

/// 自环判定（loopback 候选过滤）用的"本机设备 did"：测试态认 `TEST_IDENTITY`
/// 注入的身份（与 `my_tunnel_identity` 同源——测试常以注入身份既当本机又当目标，
/// 回环 base 是合法自连），生产读真机身份。行为差异只在 `cfg(test)`。
static SELF_DID_CACHE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// 本机设备 DID（缓存成功值；失败**不缓存**，下次重试）。
///
/// 2026-10-23 修：早前用 `OnceLock<Option>` 缓存 → 进程刚起时的一次失败会把 None 永久钉住，
/// 连带把「本机自连隧道」「RDP 卡片自连检测」全部搞坏（表现为 self:3389 forward 报
/// "目标设备不在线"）。现在只缓存 Some，失败走兜底/重试。
pub fn self_did_for_loopback_filter() -> Option<String> {
    #[cfg(test)]
    if let Some((_, did, _)) = TEST_IDENTITY.lock().unwrap().clone() {
        return Some(did);
    }
    if let Ok(g) = SELF_DID_CACHE.lock() {
        if let Some(d) = g.clone() {
            return Some(d);
        }
    }
    let mut found: Option<String> = None;
    if let Ok((d, _)) = myco_core::identity::device_identity() {
        found = Some(d);
    }
    if found.is_none() {
        // 兜底：current_exe cli identity did → DID Document `{"id":"did:myco:…"}`。
        // 2026-10-23 修：原实现用 `split("\"id\"").nth(1).split('"').nth(2)` 取
        // **引号分段的下一个分隔符**（实际拿到 `,`），永远解析不出 did——兜底等于
        // 死代码。这里按 JSON 读，`id` / `did` 两种字段名都认。
        if let Ok(exe) = std::env::current_exe() {
            let mut c = std::process::Command::new(exe);
            c.args(["cli", "identity", "did"]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                c.creation_flags(0x0800_0000);
            }
            if let Ok(out) = c.output() {
                let txt = String::from_utf8_lossy(&out.stdout).to_string();
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(txt.trim()) {
                    if let Some(id) = v
                        .get("id")
                        .or_else(|| v.get("did"))
                        .and_then(|x| x.as_str())
                        .map(str::trim)
                        .filter(|s| s.starts_with("did:"))
                    {
                        found = Some(id.to_string());
                    }
                }
            }
        }
    }
    if let Some(d) = &found {
        if let Ok(mut g) = SELF_DID_CACHE.lock() {
            *g = Some(d.clone());
        }
    }
    found
}

fn my_tunnel_identity() -> Result<(String, String, ed25519_dalek::SigningKey), String> {
    #[cfg(test)]
    if let Some((acc, did, seed)) = TEST_IDENTITY.lock().unwrap().clone() {
        return Ok((acc, did, ed25519_dalek::SigningKey::from_bytes(&seed)));
    }
    let (did, seed_b64) = myco_core::identity::device_identity()?;
    let account = myco_core::identity::account_did()
        .filter(|a| !a.is_empty())
        .ok_or("本机未登录账号")?;
    let seed = base64::engine::general_purpose::STANDARD
        .decode(seed_b64)
        .map_err(|e| format!("seed 解码失败: {e}"))?;
    let arr: [u8; 32] = seed.try_into().map_err(|_| "seed 长度异常".to_string())?;
    Ok((account, did, ed25519_dalek::SigningKey::from_bytes(&arr)))
}

/// 构造 `(握手原文, X-Myco-Auth 头)`——签的正是将被发出的握手原文。
fn tunnel_credentials(target_port: u16) -> Result<(String, String), String> {
    let (account, did, sk) = my_tunnel_identity()?;
    let mut handshake = tunnel_handshake_json(&account, &did, &did, target_port, &next_nonce());
    if resume_enabled() {
        let mut v: Value = serde_json::from_str(&handshake).map_err(|e| e.to_string())?;
        v["cap"] = json!(["resume"]);
        handshake = v.to_string();
    }
    let ts = chrono::Utc::now().timestamp_millis() as u64;
    let sig = sk.sign(format!("{did}\n{ts}\n{handshake}").as_bytes());
    let auth = format!(
        "{did}.{ts}.{}",
        base64::engine::general_purpose::STANDARD.encode(sig.to_bytes())
    );
    Ok((handshake, auth))
}

/// 本地 TCP ↔ 外层 WS 对泵（本函数内先做 v2 加密握手，再对泵密文帧）。
async fn pump_client_with(
    ws: WsStream,
    hs_raw: String,
    tcp: TcpStream,
    target_device_did: &str,
    mut close_rx: Option<tokio::sync::mpsc::UnboundedReceiver<()>>,
    session_scope: &str,
) -> Result<(), FrameError> {
    pump_client_with_inner(ws, hs_raw, tcp, target_device_did, close_rx.as_mut(), session_scope).await
}

async fn pump_client_with_inner(mut ws: WsStream, hs_raw: String, tcp: TcpStream, target_device_did: &str, close_rx: Option<&mut tokio::sync::mpsc::UnboundedReceiver<()>>, session_scope: &str) -> Result<(), FrameError> {
    let diag_port = serde_json::from_str::<TunnelHandshake>(&hs_raw).map(|h| h.port).unwrap_or(0);
    elog!("[p2p-tunnel] pump_client_with resume_enabled={} cap={} device={} port={}", resume_enabled(), resume_requested(&hs_raw), target_device_did, diag_port);
    if resume_requested(&hs_raw) {
        return resume_pump_client_with(ws, hs_raw, tcp, target_device_did, close_rx, session_scope).await;
    }
    let io = crypto_handshake_client(&mut ws, &hs_raw).await?;
    let layer = PumpLayer::new(io);
    let (mut ws_tx, mut ws_rx) = ws.split();
    let (tcp_rx, tcp_tx) = tcp.into_split();
    let upload = pump_up(tcp_rx, &mut ws_tx, &layer, close_rx);
    let download = pump_down_client(&mut ws_rx, tcp_tx, &layer);
    tokio::pin!(upload);
    tokio::pin!(download);
    let res = tokio::select! {
        r = &mut upload => { let _ = tokio::time::timeout(TUNNEL_DRAIN_GRACE, &mut download).await; r }
        r = &mut download => { let _ = tokio::time::timeout(TUNNEL_DRAIN_GRACE, &mut upload).await; r }
    };
    // upload 内部已发 Close（见 pump_up）；此处只需等 borrow 结束
    drop(upload);
    res
}

/// 客户端 resume 数据泵：首腿 SESSION_OPEN，后续腿 RESUME；RESUME_ACK 后重放未确认数据。
async fn resume_pump_client_with(ws: WsStream, hs_raw: String, tcp: TcpStream, target_device_did: &str, mut close_rx: Option<&mut tokio::sync::mpsc::UnboundedReceiver<()>>, session_scope: &str) -> Result<(), FrameError> {
    let port = serde_json::from_str::<TunnelHandshake>(&hs_raw).map(|h| h.port).unwrap_or(0);
    elog!("[p2p-tunnel] session-resume start device={target_device_did} port={port}");
    let r = resume_pump_client_inner(ws, hs_raw, tcp, target_device_did, close_rx.as_deref_mut(), session_scope).await;
    match &r {
        Ok(()) => elog!("[p2p-tunnel] session-resume ok device={target_device_did} port={port}"),
        Err(e) => elog!("[p2p-tunnel] session-resume fail device={target_device_did} port={port} {e}"),
    }
    r
}

/// 旧腿失败后的恢复入口：本地 TCP 保持不动，先重拨新腿，再在新腿上 RESUME。
async fn resume_pump_client_inner(ws: WsStream, hs_raw: String, tcp: TcpStream, target_device_did: &str, mut close_rx: Option<&mut tokio::sync::mpsc::UnboundedReceiver<()>>, session_scope: &str) -> Result<(), FrameError> {
    let mut current_ws = Some(ws);
    let mut current_hs = hs_raw;
    // 重拨必须使用原会话的真实目标端口，绝不能以 0 发起自连探测。
    let redial_port = serde_json::from_str::<TunnelHandshake>(&current_hs)
        .map(|h| h.port)
        .unwrap_or(0);
    let send_seq = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    // 连接级逻辑会话：sid = H(device#target#port + 一次性 nonce)，跨连接不撞。
    let session = {
        let hs: TunnelHandshake = serde_json::from_str(&current_hs)
            .map_err(|e| FrameError::Io(e.to_string()))?;
        let key = client_resume_session_key(&hs.device, target_device_did, hs.port);
        Arc::new(Mutex::new(tunnel_resume_frames::ResumeSession::new(
            new_client_resume_sid(&key),
        )))
    };
    // 首腿 SESSION_OPEN 成功后置 true；之后的腿一律 RESUME（会话已在提供端建立）。
    let opened = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut tcp = tcp;
    let deadline = std::time::Instant::now() + Duration::from_millis(15_000);
    let mut redial_backoff = Duration::from_millis(250);
    loop {
        if current_ws.is_none() {
            let plan = { REDIAL_PLANS.lock().unwrap().get(target_device_did).cloned() };
            let Some((bases, active)) = plan else {
                return Err(FrameError::Io("no-redial-plan".into()));
            };
            let cur = active.lock().unwrap().clone();
            let snap = bases.lock().unwrap().clone();
            let mut cands = vec![cur.clone()];
            cands.extend(snap.iter().filter(|b| **b != cur).cloned());
            let relay = relay_ready().then(|| RelayPlan { device: target_device_did.to_string() });
            let Some((base, ws, hs)) = dial_with_context(
                target_device_did,
                &cands,
                redial_port,
                ROUTE_EXPLORE_DIAL_TIMEOUT,
                RACE_TOTAL_BUDGET,
                None,
                relay,
            ).await else {
                if std::time::Instant::now() >= deadline {
                    return Err(FrameError::Io("resume redial timeout".into()));
                }
                // 重拨失败也走同一恢复窗口与指数退避，禁止固定 250ms 无限风暴。
                tokio::time::sleep(redial_backoff).await;
                redial_backoff = (redial_backoff * 2).min(Duration::from_secs(2));
                continue;
            };
            elog!("[p2p-tunnel] 旧腿失败，已重拨新腿 {base}，准备 RESUME");
            *active.lock().unwrap() = base;
            current_ws = Some(ws);
            current_hs = hs;
        }
        let attempt_ws = current_ws.take().expect("current_ws checked above");
        match resume_pump_client_attempt(attempt_ws, current_hs.clone(), &mut tcp, target_device_did, close_rx.as_deref_mut(), send_seq.clone(), session.clone(), opened.clone()).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                elog!("[p2p-tunnel] session-resume fail device={target_device_did} {e}——尝试重拨新腿");
                if std::time::Instant::now() >= deadline {
                    return Err(e);
                }
                // 失败后不要立刻再拨：指数退避，避免重拨风暴把中继打到 403/限流。
                tokio::time::sleep(redial_backoff).await;
                redial_backoff = (redial_backoff * 2).min(Duration::from_secs(2));
            }
        }
    }
}

/// 单腿尝试：会话已开 → RESUME，否则 SESSION_OPEN。成功/失败都由调用方决定是否重拨。
#[allow(clippy::too_many_arguments)]
async fn resume_pump_client_attempt(
    ws: WsStream,
    hs_raw: String,
    tcp: &mut TcpStream,
    target_device_did: &str,
    close_rx: Option<&mut tokio::sync::mpsc::UnboundedReceiver<()>>,
    send_seq: std::sync::Arc<std::sync::atomic::AtomicU64>,
    session: Arc<Mutex<tunnel_resume_frames::ResumeSession>>,
    opened: Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), FrameError> {
    let t0 = std::time::Instant::now();
    let hs: TunnelHandshake = serde_json::from_str(&hs_raw).map_err(|e| FrameError::Io(e.to_string()))?;
    let mut ws = ws;
    let io = crypto_handshake_client(&mut ws, &hs_raw).await?;
    let mut resume_io = tunnel_resume_frames::ResumeIo::new(io.keys.clone(), TunnelRole::Originator);
    resume_io.set_shared_send_seq(send_seq);

    if !opened.load(std::sync::atomic::Ordering::SeqCst) {
        let sid = session.lock().unwrap().session_id;
        let open = resume_io
            .seal_control(tunnel_resume_frames::T_SESSION_OPEN, &tunnel_resume_frames::encode_session_open(&sid, 0)?)
            .map_err(|e| FrameError::Io(format!("session-open: {e}")))?;
        ws.send(TMessage::Binary(open)).await.map_err(|e| FrameError::Io(e.to_string()))?;
        elog!("[p2p-tunnel] session-open-sent device={target_device_did} port={} ms={}", hs.port, t0.elapsed().as_millis());
        let ack = match ws.next().await {
            Some(Ok(TMessage::Binary(d))) => d,
            Some(Ok(TMessage::Close(_))) => return Err(FrameError::Io("session-ack closed".into())),
            Some(Ok(_)) | None => return Err(FrameError::Io("session-ack missing".into())),
            Some(Err(e)) => return Err(FrameError::Io(e.to_string())),
        };
        match resume_io.open(&ack)? {
            tunnel_resume_frames::ResumeFrame::Control { type_, payload, .. }
                if type_ == tunnel_resume_frames::T_SESSION_ACK =>
            {
                let (got_sid, _recv) = tunnel_resume_frames::decode_session_ack(&payload)?;
                if got_sid != sid { return Err(FrameError::PlaintextOrUnknownFrame); }
            }
            _ => return Err(FrameError::PlaintextOrUnknownFrame),
        }
        elog!("[p2p-tunnel] session-ack-recv device={target_device_did} port={} ms={}", hs.port, t0.elapsed().as_millis());
        session.lock().unwrap().on_leg_open();
        opened.store(true, std::sync::atomic::Ordering::SeqCst);
    } else {
        let (sid, recv_offset, send_next) = {
            let s = session.lock().unwrap();
            (s.session_id, s.recv_offset, s.send_next)
        };
        let resume = resume_io
            .seal_control(tunnel_resume_frames::T_RESUME, &tunnel_resume_frames::encode_resume(&sid, recv_offset, send_next)?)
            .map_err(|e| FrameError::Io(format!("resume: {e}")))?;
        ws.send(TMessage::Binary(resume)).await.map_err(|e| FrameError::Io(e.to_string()))?;
        elog!("[p2p-tunnel] resume-sent device={target_device_did} port={} ms={}", hs.port, t0.elapsed().as_millis());
        let ack = match ws.next().await {
            Some(Ok(TMessage::Binary(d))) => d,
            Some(Ok(TMessage::Close(_))) => return Err(FrameError::Io("resume-ack closed".into())),
            Some(Ok(_)) | None => return Err(FrameError::Io("resume-ack missing".into())),
            Some(Err(e)) => return Err(FrameError::Io(e.to_string())),
        };
        let acked = match resume_io.open(&ack)? {
            tunnel_resume_frames::ResumeFrame::Control { type_, payload, .. }
                if type_ == tunnel_resume_frames::T_RESUME_ACK => Some(tunnel_resume_frames::decode_ack(&payload)?),
            tunnel_resume_frames::ResumeFrame::Control { type_, payload, .. }
                if type_ == tunnel_resume_frames::T_SESSION_ACK => {
                let (got_sid, _recv) = tunnel_resume_frames::decode_session_ack(&payload)?;
                if got_sid != sid { return Err(FrameError::PlaintextOrUnknownFrame); }
                // 提供端 RESUME miss 后回 SESSION_ACK：当场重置为同 sid 的新会话，
                // 不把旧会话的未确认数据重放到一个已经不存在的服务端会话里。
                {
                    let mut s = session.lock().unwrap();
                    *s = tunnel_resume_frames::ResumeSession::new(sid);
                    s.on_leg_open();
                }
                elog!("[p2p-tunnel] session-resume fallback-open device={target_device_did} port={}", hs.port);
                None
            }
            _ => return Err(FrameError::PlaintextOrUnknownFrame),
        };
        elog!("[p2p-tunnel] resume-ack-recv device={target_device_did} port={} ms={}", hs.port, t0.elapsed().as_millis());
        if let Some(acked) = acked {
            let replay = session.lock().unwrap().on_resume(acked)?;
            let replay_len = replay.len();
            if !replay.is_empty() {
                let frame = resume_io.seal_data(acked, &replay);
                ws.send(TMessage::Binary(frame)).await.map_err(|e| FrameError::Io(e.to_string()))?;
            }
            elog!("[p2p-tunnel] leg-switch device={target_device_did} port={} replay_bytes={replay_len}", hs.port);
        }
    }

    // 会话已在提供端建立（或已换腿）→ 此刻才建本腿守卫：
    // 握手失败时状态保持上一代（Recovering/Connecting），不该由本腿再标一次。
    let _leg_guard = ResumeLegGuard::new(session.clone());

    let layer = ResumePumpLayer::new(resume_io, session.clone());
    elog!("[p2p-tunnel] resume-pump-start device={target_device_did} port={} ms={}", hs.port, t0.elapsed().as_millis());
    let (mut ws_tx, mut ws_rx) = ws.split();
    let (tcp_rx, tcp_tx) = tcp.split();
    let upload = resume_pump_up(tcp_rx, &mut ws_tx, &layer, close_rx);
    let download = resume_pump_down_client(&mut ws_rx, tcp_tx, &layer);
    tokio::pin!(upload);
    tokio::pin!(download);
    let res = tokio::select! {
        r = &mut upload => { let _ = tokio::time::timeout(TUNNEL_DRAIN_GRACE, &mut download).await; r }
        r = &mut download => { let _ = tokio::time::timeout(TUNNEL_DRAIN_GRACE, &mut upload).await; r }
    };
    drop(upload);
    res
}

/// resume 客户端下行：DATA 写本地，ACK/GOAWAY 由会话消费。
async fn resume_pump_down_client<R, W>(ws_rx: &mut R, mut tcp_tx: W, layer: &ResumePumpLayer) -> Result<(), FrameError>
where
    R: futures_util::Stream<Item = Result<TMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let t0 = std::time::Instant::now();
    let mut first_frame = true;
    while let Some(m) = ws_rx.next().await {
        match m {
            Ok(TMessage::Binary(d)) => {
                if first_frame {
                    elog!("[p2p-tunnel] pump-down-first-frame ms={}", t0.elapsed().as_millis());
                    first_frame = false;
                }
                if d.len() > FRAME_MAX_PAYLOAD {
                    return Err(FrameError::AuthFail);
                }
                match layer.open(&d)? {
                    tunnel_resume_frames::ResumeFrame::Data { plaintext, .. } => {
                        layer.session.lock().unwrap().recv_offset += plaintext.len() as u64;
                        write_all_client_local(&mut tcp_tx, &plaintext, Some(Duration::from_secs(60))).await?;
                    }
                    tunnel_resume_frames::ResumeFrame::Control { type_, payload, .. } => match type_ {
                        tunnel_resume_frames::T_ACK => {
                            if let Ok(off) = tunnel_resume_frames::decode_ack(&payload) {
                                layer.session.lock().unwrap().on_ack(off);
                            }
                        }
                        tunnel_resume_frames::T_GOAWAY => break,
                        _ => {}
                    },
                }
            }
            Ok(TMessage::Close(_)) => return Err(FrameError::Io("ws closed".into())),
            Ok(_) => {}
            Err(e) => return Err(FrameError::Io(e.to_string())),
        }
    }
    // 不在每次腿结束时 shutdown 本地写半：旧腿失败还要保留原始本地 TCP 供重拨/RESUME。
    Ok(())
}

// ══════════════════ ⑧ 反向连接（2026-10-09：PC 主动拨手机） ══════════════════
//
// **问题（三设备实测）**：手机 → PC（家宽 IPv6:9100）被光猫的有状态防火墙拦
// （单向 SYN 无五元组匹配 → 丢），正向隧道（手机拨 PC 的 `/p2p/tunnel`）建不起来；
// 反方向 **PC → 手机（移动网络 IPv6）直连是通的**。
//
// **解法：反转连接方向**——PC 当发起方（originator：签握手信封、先发 HELLO），
// 主动拨手机上报的地址；手机当应答方（responder：验签 + 闸门 + 回 HELLO_ACK）。
// 隧道语义不变：把 **本机** 的 target_port 服务（13911 分享网关）泵给手机的浏览器。
// 线协议一个字不改——`race_tunnel_ex`（拨号赛跑）+ `pump_client_with`（对泵）原样复用，
// 唯一的区别是 TCP 由谁发起（我们拨出去，**不开本地监听口**）。
//
// **触发（want-marker）**：手机打开分享时在 presence 的 `addrs` 里带
// `wantReverse: 13911`（服务器 addrs 原样透传）；本模块的拨号循环（1s 一拍，
// 2026-10-10 从 10s→3s→1s 迭代而来）查 presence（`p2p_client::reverse_wants_now`，
// 同账号 ∪ 好友闸）→ 给每台想看的手机维持一个连接池（池深 [`REVERSE_POOL_DEPTH`]，
// 手机侧每条浏览器连接配一条隧道）。
// 手机离开页面重报 presence 清标记 → 循环发现后停拨（在途连接由对端关闭自然收尾）。
//
// **安全面（与正向对称）**：
// * PC 侧只暴露白名单端口（13911/9100）——信封 port 过 [`tunnel_port_allowed`]；
// * 13911 网关本身逐请求验窄 mt（短 TTL 现签票据）——隧道只是字节管道；
// * 手机侧（p2p-tunnel.ts `acceptTunnel`）验设备签名 + 预期源设备 + 端口白名单 +
//   nonce 去重——互联网上任何扫到手机端口的设备，没有源设备私钥过不了闸。

/// 反向连接池深：每台想看的手机维持几条隧道（浏览器每条 TCP 连接配一条；
/// 页面加载通常 3-5 条连接，池空时手机侧浏览器会自重试、循环下一拍补齐）。
/// 2026-10-10：8→4，与手机侧 ReverseShareBridge 的 poolCap（4）对齐——PC 拨 8 条
/// 时手机只留 4 条、多余的被关，下一拍 PC 又补拨又被关……每拍 4 条注定被拒的
/// 空拨（churn）。对齐后稳态零空拨，池也不缺（手机 poolCap=4 是浏览器并发的
/// 实测上限）。
pub const REVERSE_POOL_DEPTH: usize = 4;
/// 反向拨号的单候选超时（移动网络 RTT 高，与正向赛跑同量级：2s）。
pub const REVERSE_DIAL_PER: Duration = Duration::from_millis(2000);
/// 反向拨号一场赛跑的总预算。
pub const REVERSE_DIAL_BUDGET: Duration = Duration::from_millis(3500);
/// want-marker 轮询周期（presence 查询是云上动作，别太密）。
/// 2026-10-10：3s→1s（"建联 <2s"硬指标的最大延迟项就是这一拍：手机报
/// wantReverse 后 PC 平均要等 1.5s 才看到。1s 一拍把平均检测延迟压到 0.5s；
/// presence/list 是服务端内存 Map 的一次读，1 RPS 无压力。地址新鲜度同理：
/// 手机 IPv6 前缀轮换后，新地址 1s 内进入 PC 的拨号清单）。
pub const REVERSE_TICK: Duration = Duration::from_secs(1);

/// 每台 viewer 设备的反向连接池（device_did → 在途连接的 JoinHandle）。
static REVERSE_POOL: LazyLock<
    Mutex<std::collections::HashMap<String, Vec<tokio::task::JoinHandle<()>>>>,
> = LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// 当前活跃隧道快照（vnet API 用）：[(device_did, target_port, local_port)]。
pub(crate) fn tunnel_list_snapshot() -> Vec<(String, u16, u16)> {
    TUNNELS
        .lock()
        .unwrap()
        .values()
        .map(|e| (e.device_did.clone(), e.target_port, e.local_port))
        .collect()
}

/// 白名单端口快照（p2p_client 的 want 解析用；默认表 ∪ env/测试注入）。
pub(crate) fn tunnel_allowed_ports_snapshot() -> Vec<u16> {
    let mut v = TUNNEL_DEFAULT_PORTS.to_vec();
    v.extend(tunnel_extra_ports());
    v.sort_unstable();
    v.dedup();
    v
}

/// 一个"槽"：并行赛跑拨对方候选 → 胜出连接上跑隧道客户端（本机=发起方）→
/// 连本机 `127.0.0.1:target_port` 双向对泵到隧道关闭。槽的生死 = 连接的生死。
async fn reverse_connect_slot(bases: Vec<String>, target_port: u16, device_did: &str) {
    let Some((base, mut ws, hs)) = race_tunnel_ex(
        &bases,
        target_port,
        REVERSE_DIAL_PER,
        REVERSE_DIAL_BUDGET,
        None,
        None,
    )
    .await
    else {
        elog!(
            "[p2p-tunnel] 反向连接：{} 个候选全部未通（对端可能已换网/IPv6 前缀轮换）——下一拍（≤1s）重查 presence 拿新地址再拨",
            bases.len()
        );
        return;
    };
    let target = format!("127.0.0.1:{target_port}");
    let tcp = match tokio::time::timeout(
        Duration::from_secs(TUNNEL_UPSTREAM_TIMEOUT_SECS),
        TcpStream::connect(&target),
    )
    .await
    {
        Ok(Ok(t)) => t,
        other => {
            elog!(
                "[p2p-tunnel] 反向隧道：本机上游 {target} 不可达（{:?}）——关连接",
                other.err().map(|e| e.to_string())
            );
            let _ = ws.close(None).await;
            return;
        }
    };
    let _ = tcp.set_nodelay(true);
    // 反向腿不进 TUNNELS；用 Drop guard 保证 abort/成功/错误都同步电源口径。
    let _power = ReverseLiveGuard::new();
    elog!("[p2p-tunnel] 反向隧道就绪：本机 {target} ⇄ {base}（我们=发起方）");
    let session_scope = next_nonce();
    if let Err(e) = pump_client_with(ws, hs, tcp, device_did, None, &session_scope).await {
        elog!("[p2p-tunnel] 反向隧道 {base} 结束（{e}）");
    }
}

/// 给某设备补池（去死柄 + 限深）。`want` = 需要的总量。
fn reverse_pool_topup(device_did: &str, bases: &[String], target_port: u16, want: usize) {
    let mut g = REVERSE_POOL.lock().unwrap();
    let live = g.entry(device_did.to_string()).or_default();
    live.retain(|h| !h.is_finished());
    let need = want.min(REVERSE_POOL_DEPTH).saturating_sub(live.len());
    for _ in 0..need {
        let b = bases.to_vec();
        let dev_owned = device_did.to_string();
        live.push(tokio::spawn(async move {
            reverse_connect_slot(b, target_port, &dev_owned).await
        }));
    }
}

/// **契约面**：`tunnel_open` 的**反向模式**——本机（PC）作为发起方主动连 viewer（手机），
/// 把本机 `target_port` 服务经出站连接交给对方的浏览器。
/// 与正向模式的差别：**不开本地监听端口**（消费方在对方设备上），返回本轮拨出的连接数。
/// 寻址：presence 按【设备 did】查手机上报的 addrs（手机须已上报，见 identity.ts
/// `registerPresence` 的 addrs 参数）。
pub async fn tunnel_open_reverse(
    target_device_did: &str,
    target_port: u16,
    count: usize,
) -> Result<usize, String> {
    if !tunnel_port_allowed(target_port) {
        return Err(format!(
            "端口 {target_port} 不在 P2P 隧道白名单（防开放代理）"
        ));
    }
    let dev = crate::p2p_client::presence_device_by_did_kind(target_device_did, &["phone"])
        .await
        .ok_or_else(|| format!("目标设备不在线或未上报直连地址: {target_device_did}"))?;
    let bases = crate::p2p_client::urls_of(&dev);
    if bases.is_empty() {
        return Err(format!("目标设备无可拨地址: {target_device_did}"));
    }
    let n = count.max(1);
    reverse_pool_topup(target_device_did, &bases, target_port, n);
    elog!(
        "[p2p-tunnel] 反向模式：向 {target_device_did} 拨 {} 条（暴露本机 :{target_port}，{} 个候选）",
        n.min(REVERSE_POOL_DEPTH),
        bases.len()
    );
    Ok(n.min(REVERSE_POOL_DEPTH))
}

/// 停掉某设备的全部反向连接（对端关分享/手动停）。
pub fn tunnel_reverse_stop(target_device_did: &str) -> bool {
    let entry = REVERSE_POOL.lock().unwrap().remove(target_device_did);
    match entry {
        Some(handles) => {
            for h in handles {
                h.abort();
            }
            true
        }
        None => false,
    }
}

/// 当前反向池的活连接数（诊断/单测）。
pub fn tunnel_reverse_live(target_device_did: &str) -> usize {
    let g = REVERSE_POOL.lock().unwrap();
    g.get(target_device_did)
        .map(|v| v.iter().filter(|h| !h.is_finished()).count())
        .unwrap_or(0)
}

/// 一拍拨号循环：查 want（同账号/好友闸后）→ 补池；标记消失的设备 → 停拨。
async fn reverse_dialer_tick() {
    let wants = crate::p2p_client::reverse_wants_now().await;
    let gone: Vec<String> = {
        let g = REVERSE_POOL.lock().unwrap();
        g.keys()
            .cloned()
            .filter(|dev| {
                !wants
                    .iter()
                    .any(|w| myco_core::identity::did_equiv(&w.device_did, dev))
            })
            .collect()
    };
    for dev in gone {
        tunnel_reverse_stop(&dev);
        elog!("[p2p-tunnel] 反向意愿消失：停拨 {dev}");
    }
    for w in &wants {
        let bases = crate::p2p_server::urls_from_addrs(&w.addrs, w.port);
        if bases.is_empty() {
            continue;
        }
        reverse_pool_topup(&w.device_did, &bases, w.want_port, REVERSE_POOL_DEPTH);
    }
}

/// 起反向拨号循环（幂等；App 启动时由 `p2p_client::start_sync_loop` 调一次）。
/// **测试态 no-op**（循环里的 presence 查询绝不触网——单测见下方 reverse 段）。
pub fn reverse_dialer_start() {
    static STARTED: LazyLock<std::sync::atomic::AtomicBool> =
        LazyLock::new(|| std::sync::atomic::AtomicBool::new(false));
    #[cfg(not(test))]
    {
        if !STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
            tauri::async_runtime::spawn(async move {
                loop {
                    reverse_dialer_tick().await;
                    tokio::time::sleep(REVERSE_TICK).await;
                }
            });
        }
    }
    #[cfg(test)]
    let _ = &STARTED; // 测试态：不起循环（保持"单测不触网"纪律）
}

// ══════════════════ ⑨ 云端中继（identity-svc TCP relay，2026-10-11） ══════════════════
//
// 连接阶梯第 ④ 级：①LAN ②IPv6/公网 ③反向/打洞 全不通（双方都在 NAT 后且无
// 端口映射/锥形 NAT/全球 IPv6——例：笔记本挂手机热点 → PC 在家宽光猫后面）时，
// 经 identity-svc **:8322** 的 TCP 中继转一圈：
//
// ```text
//  本机(消费者)                        identity-svc(阿里云)                 PC(provider)
//  ┌────────────┐   CONNECT <did>   ┌──────────────┐   SESSION <sid>   ┌──────────────┐
//  │ tunnel 连接 ├──────────────────►│  relay :8322 ├──────────────────►│ 控制连(REGISTER)│
//  └─────┬──────┘                   └──────┬───────┘                   └──────┬───────┘
//        │      OK（配对完成）              │◄──────────── ACCEPT ─────────────┤ 新会话连
//        └═════════ 纯字节（隧道协议原样跑在这条连接上）════════════════════════┘
//                          WS 升级 + 设备签名信封 + AEAD → PC 的 127.0.0.1:9100(/p2p/tunnel)
// ```
//
// * 中继**只搬字节**（协议见 services/identity-svc/relay.mjs）；隧道的验签/端口
//   白名单/授权钩子全在 provider 侧的 p2p 服务器上，一道不少。
// * consumer 侧：中继腿是 [`race_tunnel_ex`] 赛跑里的一条候选（300ms 让先——
//   LAN/IPv6 直连 <300ms 必胜，"优先直连"；直连全断时中继赢）。
// * provider 侧：[`relay_provider_start`] 常驻注册（断线指数退避重连），收到
//   SESSION 就开新连接接单，把会话接进本机 p2p 服务器。
// * 强制直连：`MYCO_P2P_FORCE_DIRECT=1` → 中继腿禁用（行为回到 ⑨ 之前）。

/// 中继默认端口（identity-svc TCP relay；`MYCO_RELAY_ADDR` 可整体覆盖）。
/// 注意：生产 identity-svc 的中继与 HTTP **同口复用**（8321 首行嗅探分流，
/// 见 relay.mjs createPortMux——阿里云安全组未放行独立 8322），所以中继地址
/// 的默认推导是"identity 基址的 host + 基址显式端口（无则 8321）"，而不是
/// 这个常量；本常量只作为 `MYCO_RELAY_ADDR` 只写 host 时的端口缺省。
pub const RELAY_PORT: u16 = 8322;
/// 中继腿让先：直连候选先跑 300ms（LAN/IPv6 直连几乎必胜——"优先直连"；
/// 云端 RTT 下中继全链 ≈300ms+3×RTT，慢而能通的直连（>1s）会让位——可接受）。
const RELAY_LEG_DELAY: Duration = Duration::from_millis(300);
/// 中继腿自身预算（TCP+CONNECT+WS 升级 ≈3×RTT；整场赛跑 3s 硬顶兜底）。
const RELAY_LEG_TIMEOUT: Duration = Duration::from_millis(2500);
/// 连中继的 TCP 连接超时。
const RELAY_DIAL_TIMEOUT: Duration = Duration::from_millis(3000);
/// 等中继应答行（OK/NOT_FOUND/…）超时。
const RELAY_LINE_TIMEOUT: Duration = Duration::from_millis(4000);
/// provider 控制连心跳周期（服务端 60s 无数据踢线 → 25s 一拍留足余量）。
const RELAY_HEARTBEAT: Duration = Duration::from_secs(25);
/// provider 断线重连的退避封顶（1s 起 ×2）。
const RELAY_BACKOFF_MAX: Duration = Duration::from_secs(30);
/// 中继腿胜出时 base 的标记形态（不参与直连拨号；缓存/候选表跳过之）。
pub(crate) const RELAY_BASE: &str = "relay://cloud";

/// 赛跑里中继腿的参数（谁是对端设备）。
#[derive(Debug, Clone)]
pub(crate) struct RelayPlan {
    pub device: String,
}

/// 测试注入的中继地址（测试态**绝不**从 env/默认域名推导——单测不触网）。
#[cfg(test)]
static TEST_RELAY_ADDR: LazyLock<Mutex<Option<(String, u16)>>> = LazyLock::new(|| Mutex::new(None));

/// 测试注入：指定/清除中继地址。
#[cfg(test)]
pub(crate) fn test_set_relay_addr(addr: Option<(String, u16)>) {
    *TEST_RELAY_ADDR.lock().unwrap() = addr;
}

/// 中继地址（host, port）。优先 `MYCO_RELAY_ADDR`（host[:port]）；否则取 identity
/// 基址（`MYCO_DID_BASE`）的 host + 显式端口（无则 8321——中继与 identity 同口
/// 复用，见 relay.mjs createPortMux）。
pub fn relay_addr() -> Option<(String, u16)> {
    #[cfg(test)]
    {
        return TEST_RELAY_ADDR.lock().unwrap().clone();
    }
    #[cfg(not(test))]
    {
        if let Ok(v) = std::env::var("MYCO_RELAY_ADDR") {
            let t = v.trim();
            if !t.is_empty() {
                if let Some(rest) = t.strip_prefix('[') {
                    // [v6] 或 [v6]:port
                    let (h, r) = rest.split_once(']')?;
                    let port = r
                        .strip_prefix(':')
                        .and_then(|p| p.parse().ok())
                        .unwrap_or(RELAY_PORT);
                    return Some((h.to_string(), port));
                }
                return match t.rsplit_once(':') {
                    Some((h, p)) if !h.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
                        Some((h.to_string(), p.parse().unwrap_or(RELAY_PORT)))
                    }
                    _ => Some((t.to_string(), RELAY_PORT)),
                };
            }
        }
        let base = std::env::var("MYCO_DID_BASE")
            .unwrap_or_else(|_| "https://myco.youling.cc/myco-id".to_string());
        // 中继与 identity 同口复用：显式端口就跟基址走（dev 的 8321/自定义口），
        // 域名无端口（443 走 nginx/TLS，不是裸 TCP 面）→ 落 8321（identity 正式口）。
        base_host_port_opt(&base).map(|(h, p)| (h, p.unwrap_or(IDENTITY_DEFAULT_PORT)))
    }
}

/// identity 的正式端口（中继同口复用时的缺省）。
const IDENTITY_DEFAULT_PORT: u16 = 8321;

/// URL → (host, 显式端口)。无端口返回 None 端口（`[v6]:port` 认方括号形态）。
fn base_host_port_opt(s: &str) -> Option<(String, Option<u16>)> {
    let t = s.trim();
    let t = t.split_once("://").map(|(_, r)| r).unwrap_or(t);
    let t = t.split('/').next().unwrap_or(t);
    let t = t.split('?').next().unwrap_or(t);
    if t.is_empty() {
        return None;
    }
    if let Some(rest) = t.strip_prefix('[') {
        let (h, r) = rest.split_once(']')?;
        let port = r.strip_prefix(':').and_then(|p| p.parse().ok());
        return Some((h.to_string(), port));
    }
    match t.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() && p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty() => {
            Some((h.to_string(), p.parse().ok()))
        }
        Some(_) => None,
        None => Some((t.to_string(), None)),
    }
}

/// 强制直连（跳过中继腿）：`MYCO_P2P_FORCE_DIRECT` ∈ {1, true, yes, on}。
pub fn relay_force_direct() -> bool {
    #[cfg(test)]
    {
        // 测试注入（未注入时测试态默认 false——既有用例行为不变）
        if let Some(v) = TEST_FORCE_DIRECT.lock().unwrap().as_ref() {
            return *v;
        }
        return false;
    }
    #[cfg(not(test))]
    {
        matches!(
            std::env::var("MYCO_P2P_FORCE_DIRECT")
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
                .as_str(),
            "1" | "true" | "yes" | "on"
        )
    }
}

#[cfg(test)]
static TEST_FORCE_DIRECT: LazyLock<Mutex<Option<bool>>> = LazyLock::new(|| Mutex::new(None));

/// 测试注入：强制直连开关。
#[cfg(test)]
pub(crate) fn test_set_force_direct(v: Option<bool>) {
    *TEST_FORCE_DIRECT.lock().unwrap() = v;
}

/// 中继腿此刻是否可用（地址已知 + 未强制直连）。
fn relay_ready() -> bool {
    !relay_force_direct() && relay_addr().is_some()
}

/// 从流上读一行（字节级——绝不消费 '\n' 之后的数据；中继应答都是 ASCII 短行）。
async fn read_reply_line(stream: &mut TcpStream) -> Result<String, String> {
    let mut line = Vec::new();
    let mut b = [0u8; 1];
    let deadline = tokio::time::Instant::now() + RELAY_LINE_TIMEOUT;
    loop {
        let n = tokio::time::timeout_at(deadline, stream.read(&mut b))
            .await
            .map_err(|_| "等中继应答超时".to_string())?
            .map_err(|e| format!("中继连接读取失败: {e}"))?;
        if n == 0 {
            return Err("中继连接提前关闭".into());
        }
        if b[0] == b'\n' {
            return Ok(String::from_utf8_lossy(&line).trim().to_string());
        }
        line.push(b[0]);
        if line.len() > 512 {
            return Err("中继应答行超长".into());
        }
    }
}

/// ws:// URL 的 host 部分（v6 裸地址补方括号——into_client_request 需要）。
fn ws_url_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

/// Consumer：连中继 → `CONNECT <did>` → 等 `OK` → 在这条连接上做隧道 WS 握手
/// （与打洞成功的连接同款：[`connect_tunnel_from_stream`]）。产物与直连腿同构。
/// 2026-10-11 提速：TCP 腿优先吃**预连池**（后台已握好手的裸 TCP——省一个公网
/// RTT；池空就现拨，行为不变）。用后随手补池（下一条中继腿继续吃现成的）。
async fn relay_connect(target_device_did: &str, target_port: u16) -> Result<RacedWs, String> {
    let t0 = std::time::Instant::now();
    let (host, rport) = relay_addr().ok_or("中继地址未配置")?;
    let target = format!("{}:{rport}", ws_url_host(&host));
    let mut stream = match crate::cloud_relay::predial_take(&host, rport) {
        Some(s) => s,
        None => tokio::time::timeout(RELAY_DIAL_TIMEOUT, TcpStream::connect(&target))
            .await
            .map_err(|_| format!("中继 {target} 连接超时"))?
            .map_err(|e| format!("中继 {target} 连接失败: {e}"))?,
    };
    crate::cloud_relay::predial_refill(host.clone(), rport);
    let _ = stream.set_nodelay(true);
    stream
        .write_all(format!("CONNECT {target_device_did}\n").as_bytes())
        .await
        .map_err(|e| format!("CONNECT 发送失败: {e}"))?;
    match read_reply_line(&mut stream).await?.as_str() {
        "OK" => {}
        "NOT_FOUND" => return Err(format!("目标设备未注册中继: {target_device_did}")),
        "BUSY" => return Err("目标设备中继会话忙".into()),
        "UNAVAILABLE" => return Err("目标设备未接单（中继等待 provider 超时）".into()),
        other => return Err(format!("中继应答异常: {other}")),
    }
    elog!("[p2p-tunnel] relay-pair-ready device={target_device_did} port={target_port} ms={}", t0.elapsed().as_millis());
    // 2026-10-20：WS URL 必须带中继端口（Host 头/代理路由按 host:port 匹配；原来漏了 rport）。
    let ws_url = format!(
        "ws://{}:{}/p2p/tunnel?v={TUNNEL_PROTOCOL_VERSION}",
        ws_url_host(&host),
        rport
    );
    connect_tunnel_from_stream(&ws_url, target_port, stream).await
}

/// 中继腿（赛跑的一条候选）：让先 [`RELAY_LEG_DELAY`] → [`relay_connect`]。
/// 任何失败返回 None（直连腿照常赛跑，互不拖累）。
async fn relay_leg(device: String, target_port: u16, delay: Duration) -> Option<RacedWs> {
    if !relay_ready() {
        return None;
    }
    tokio::time::sleep(delay).await;
    match tokio::time::timeout(RELAY_LEG_TIMEOUT, relay_connect(&device, target_port)).await {
        Ok(Ok(w)) => {
            elog!("[p2p-tunnel] 云端中继腿打通（{device} → :{target_port}）");
            Some(w)
        }
        Ok(Err(e)) => {
            elog!("[p2p-tunnel] 云端中继腿失败（{device}）: {e}");
            None
        }
        Err(_) => {
            elog!("[p2p-tunnel] 云端中继腿超时（{device}）");
            None
        }
    }
}

// ── Provider（PC 侧）：常驻注册 + 接单 ──

/// 启动 provider 常驻任务（幂等；`p2p_client::start_sync_loop` 调一次）。
/// **测试态 no-op**（单测直接调 `relay_provider_session_to` 注入身份/上游/中继）。
pub fn relay_provider_start() {
    // 2026-11-06 用户令：legacy 退役——云端中继 Provider 不再启动。
    // 本函数保留为空壳（调用方在 p2p_client::start_sync_loop 里），
    // 彻底删除需连调用方一起拆（下轮做）。
    static STARTED: LazyLock<std::sync::atomic::AtomicBool> =
        LazyLock::new(|| std::sync::atomic::AtomicBool::new(false));
    let _ = &STARTED;
}

/// 永续循环：会话结束就重连（指数退避；成功跑过 60s 退避重置）。
async fn relay_provider_loop() {
    let mut backoff = Duration::from_secs(1);
    loop {
        let started = std::time::Instant::now();
        match relay_provider_session().await {
            Ok(()) => eprintln!("[relay-provider] 控制连结束，重连"),
            Err(e) => eprintln!("[relay-provider] 会话失败: {e}，重连"),
        }
        if started.elapsed() > Duration::from_secs(60) {
            backoff = Duration::from_secs(1);
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(RELAY_BACKOFF_MAX);
    }
}

/// 一次控制连会话：解析本机身份与 p2p 端口 → 注册 → 心跳 + 等 SESSION 接单。
/// 返回 = 控制连结束（对端关闭/网络断），调用方负责重连。
async fn relay_provider_session() -> Result<(), String> {
    let upstream = crate::p2p_server::p2p_port();
    let (_, did, _) = my_tunnel_identity()?;
    relay_provider_session_to(upstream, &did).await
}

/// 可注入核心（E2E 测试直调）：注册 `did` 到中继，SESSION 到来即接单，
/// 把会话管道接进 `127.0.0.1:upstream`（本机 p2p 服务器）。
async fn relay_provider_session_to(upstream: u16, did: &str) -> Result<(), String> {
    if upstream == 0 {
        return Err("本机 p2p 服务器未就绪".into());
    }
    let (host, rport) = relay_addr().ok_or("中继地址未配置")?;
    let addr = format!("{}:{rport}", ws_url_host(&host));
    let sock = tokio::time::timeout(RELAY_DIAL_TIMEOUT, TcpStream::connect(&addr))
        .await
        .map_err(|_| format!("中继 {addr} 连接超时"))?
        .map_err(|e| format!("中继 {addr} 连接失败: {e}"))?;
    let mut sock = sock;
    let _ = sock.set_nodelay(true);
    sock.write_all(format!("REGISTER {did}\n").as_bytes())
        .await
        .map_err(|e| format!("REGISTER 发送失败: {e}"))?;
    if read_reply_line(&mut sock).await? != "OK" {
        return Err("REGISTER 被拒".into());
    }
    eprintln!(
        "[relay-provider] 已注册中继 {addr}（did=…{}，会话上游 127.0.0.1:{upstream}）",
        &did[did.len().saturating_sub(10)..]
    );
    let (mut r, mut w) = sock.into_split();
    let mut heartbeat = tokio::time::interval(RELAY_HEARTBEAT);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut line = Vec::new();
    let mut b = [0u8; 1];
    loop {
        tokio::select! {
            hb = heartbeat.tick() => {
                let _ = hb;
                if w.write_all(b"\n").await.is_err() {
                    return Err("心跳发送失败（控制连断）".into());
                }
            }
            n = r.read(&mut b) => {
                match n {
                    Ok(0) => return Err("中继控制连关闭".into()),
                    Ok(_) => {
                        if b[0] == b'\n' {
                            let l = String::from_utf8_lossy(&line).trim().to_string();
                            line.clear();
                            if let Some(sid) = l.strip_prefix("SESSION ").map(str::trim) {
                                if sid.is_empty() { continue; }
                                eprintln!("[relay-provider] SESSION {sid} → 接单");
                                let host2 = host.clone();
                                let did2 = did.to_string();
                                let sid2 = sid.to_string();
                                tokio::spawn(async move {
                                    if let Err(e) = relay_provider_accept(&host2, rport, &did2, &sid2, upstream).await {
                                        eprintln!("[relay-provider] 会话 {sid2} 接单失败: {e}");
                                    }
                                });
                            }
                            // 空行/未知行：忽略
                        } else {
                            line.push(b[0]);
                            if line.len() > 512 {
                                return Err("控制连命令行超长".into());
                            }
                        }
                    }
                    Err(e) => return Err(format!("控制连读取失败: {e}")),
                }
            }
        }
    }
}

/// 接一单：新连中继发 `ACCEPT` → 与 consumer 的连接对接 → 另一端接本机 p2p 服务器，
/// 双向纯字节转接到任一侧关闭。
async fn relay_provider_accept(
    host: &str,
    rport: u16,
    did: &str,
    sid: &str,
    upstream: u16,
) -> Result<(), String> {
    let addr = format!("{}:{rport}", ws_url_host(host));
    let mut relay = tokio::time::timeout(RELAY_DIAL_TIMEOUT, TcpStream::connect(&addr))
        .await
        .map_err(|_| format!("中继 {addr} 连接超时"))?
        .map_err(|e| format!("中继 {addr} 连接失败: {e}"))?;
    let _ = relay.set_nodelay(true);
    relay
        .write_all(format!("ACCEPT {did} {sid}\n").as_bytes())
        .await
        .map_err(|e| format!("ACCEPT 发送失败: {e}"))?;
    let mut up = tokio::time::timeout(
        Duration::from_secs(3),
        TcpStream::connect(("127.0.0.1", upstream)),
    )
    .await
    .map_err(|_| "本机 p2p 服务器连接超时".to_string())?
    .map_err(|e| format!("本机 p2p 服务器连接失败: {e}"))?;
    let _ = up.set_nodelay(true);
    let _ = tokio::io::copy_bidirectional(&mut relay, &mut up).await;
    Ok(())
}

// ══════════════════ 单测 ══════════════════

#[cfg(test)]
mod tunnel_tests {
    use super::*;
    use crate::p2p_server;

    fn dev(tag: u8) -> (ed25519_dalek::SigningKey, String) {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[tag; 32]);
        let did = myco_core::identity::did_from_public(&sk.verifying_key().to_bytes());
        (sk, did)
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// 与产线同法构造 X-Myco-Auth（签 raw 原文）。
    fn auth_header(sk: &ed25519_dalek::SigningKey, did: &str, raw: &str) -> HeaderMap {
        let ts = chrono::Utc::now().timestamp_millis() as u64;
        let sig = sk.sign(format!("{did}\n{ts}\n{raw}").as_bytes());
        let mut h = HeaderMap::new();
        h.insert(
            "x-myco-auth",
            format!("{did}.{ts}.{}", b64(&sig.to_bytes()))
                .parse()
                .unwrap(),
        );
        h
    }

    /// 产线口径的握手原文（origin = device，与 `tunnel_credentials` 一致）。
    fn hs_json(account: &str, device: &str, port: u16, nonce: &str) -> String {
        tunnel_handshake_json(account, device, device, port, nonce)
    }

    fn auth_str(sk: &ed25519_dalek::SigningKey, did: &str, raw: &str) -> String {
        let ts = chrono::Utc::now().timestamp_millis() as u64;
        let sig = sk.sign(format!("{did}\n{ts}\n{raw}").as_bytes());
        format!("{did}.{ts}.{}", b64(&sig.to_bytes()))
    }

    #[test]
    fn query_version_gate() {
        let u = |q: &str| q.parse::<Uri>().unwrap();
        assert!(query_version_ok(&u("/p2p/tunnel?v=2"), 2));
        assert!(
            !query_version_ok(&u("/p2p/tunnel?v=1"), 2),
            "v1 老客户端必须拒"
        );
        assert!(
            !query_version_ok(&u("/p2p/tunnel"), 2),
            "缺版本必须拒（不静默降级）"
        );
        assert!(!query_version_ok(&u("/p2p/tunnel?v=x"), 2));
        assert!(
            query_version_ok(&u("/p2p/tunnel?port=9100&v=2"), 2),
            "多参数里认 v"
        );
    }

    /// **同一把设备钥的两种 DID 前缀必须同键**（2026-10-23 env 真案根修）：
    /// 卡上带 `did:youling:z…`、隧道按 `did:myco:z…` 建时，若不归一，
    /// `tunnel_local_port` 会 miss → 误判离线/重复建链 → 固定口自撞。
    #[test]
    fn tunnel_key_normalizes_did_prefix_same_key() {
        let (_, d) = dev(7);
        let alt = d.replacen("did:myco:", "did:youling:", 1);
        assert_ne!(d, alt, "构造前提：两种合法前缀串不相等");
        assert!(
            myco_core::identity::did_equiv(&d, &alt),
            "同一把钥必须 did_equiv"
        );
        assert_eq!(
            tunnel_key(&d, 3389),
            tunnel_key(&alt, 3389),
            "同钥不同前缀必须同键"
        );
        assert_ne!(
            tunnel_key(&d, 3389),
            tunnel_key(&d, 13911),
            "端口仍是键的一部分"
        );
        // 解析不出公钥的串保持原样（测试假 DID 不能被折叠）
        assert_eq!(tunnel_key("did:myco:zFAKE", 22), "did_myco_zFAKE#22");
    }

    // ═══ ① 加密 ═══

    #[test]
    fn crypto_session_agrees_and_confirms() {
        let ct_c = X25519Public::from(&X25519Secret::from([1u8; 32])).to_bytes();
        let ct_s = X25519Public::from(&X25519Secret::from([2u8; 32])).to_bytes();
        let hs = hs_json("acct", "dev", 13911, "tn-x");
        let ck =
            SessionKeys::derive(&X25519Secret::from([1u8; 32]), &ct_s, &ct_c, &ct_s, &hs).unwrap();
        let sk =
            SessionKeys::derive(&X25519Secret::from([2u8; 32]), &ct_c, &ct_c, &ct_s, &hs).unwrap();
        // 双方派生出同一套：客户端发送钥 == 服务端接收钥
        assert_eq!(
            ck.send_key(TunnelRole::Originator),
            sk.recv_key(TunnelRole::Responder)
        );
        assert_eq!(
            ck.recv_key(TunnelRole::Originator),
            sk.send_key(TunnelRole::Responder)
        );
        assert_eq!(ck.prefix, sk.prefix, "nonce 前缀两端一致");
        assert_ne!(&ck.c2s[..], &ck.s2c[..], "双向密钥必须不同（防反射）");
        // 密钥确认 MAC 互验
        let cmac_c = ck.my_confirm_mac(TunnelRole::Originator, &hs);
        let cmac_s = sk.my_confirm_mac(TunnelRole::Responder, &hs);
        assert!(
            sk.verify_peer_confirm(TunnelRole::Responder, &hs, &cmac_c),
            "服务端验证客户端确认"
        );
        assert!(
            ck.verify_peer_confirm(TunnelRole::Originator, &hs, &cmac_s),
            "客户端验证服务端确认"
        );
        // 换一份握手原文（如 MITM 改了 nonce）→ 确认必须失败
        let hs2 = hs_json("acct", "dev", 13911, "tn-y");
        assert!(
            !ck.verify_peer_confirm(TunnelRole::Originator, &hs2, &cmac_s),
            "握手原文不同则确认失败"
        );
        // 低阶点（全 0 公钥）→ ECDH 全 0 → 拒绝（SessionKeys 无 Debug，用 is_err 断言）
        assert!(
            SessionKeys::derive(
                &X25519Secret::from([1u8; 32]),
                &[0u8; 32],
                &ct_c,
                &ct_s,
                &hs
            )
            .is_err(),
            "低阶公钥必须拒（KeyRejected）"
        );
    }

    /// 往返 + 篡改/重放/乱序全部拒绝。
    #[test]
    fn frame_roundtrip_and_rejects_tamper_replay_disorder() {
        let ct_c = X25519Public::from(&X25519Secret::from([1u8; 32])).to_bytes();
        let ct_s = X25519Public::from(&X25519Secret::from([2u8; 32])).to_bytes();
        let hs = hs_json("acct", "dev", 13911, "tn-z");
        let ck =
            SessionKeys::derive(&X25519Secret::from([1u8; 32]), &ct_s, &ct_c, &ct_s, &hs).unwrap();
        let sk =
            SessionKeys::derive(&X25519Secret::from([2u8; 32]), &ct_c, &ct_c, &ct_s, &hs).unwrap();
        let mut c = FrameIo::new(ck, TunnelRole::Originator, &hs);
        let mut s = FrameIo::new(sk, TunnelRole::Responder, &hs);

        let payloads: Vec<Vec<u8>> = (0..8u8).map(|i| vec![i; 100 + i as usize]).collect();
        let mut wire: Vec<Vec<u8>> = Vec::new();
        for p in &payloads {
            let f = c.seal(p);
            wire.push(f.clone());
            assert_eq!(&s.open(&f).unwrap(), p, "密文帧必须原样还原");
        }
        // 重放：同一条帧再解一次 → 序号非递增
        assert_eq!(
            s.open(&wire[1]).unwrap_err(),
            FrameError::ReplayOrOutOfOrder,
            "重放帧必须拒"
        );
        // 乱序（回退到更小序号）
        assert_eq!(
            s.open(&wire[0]).unwrap_err(),
            FrameError::ReplayOrOutOfOrder,
            "乱序帧必须拒"
        );
        // 篡改密文 → GCM tag 校验失败（用**新会话**收，确保走到 tag 校验而非序号检查）
        let mut s_fresh = FrameIo::new(
            SessionKeys::derive(&X25519Secret::from([2u8; 32]), &ct_c, &ct_c, &ct_s, &hs).unwrap(),
            TunnelRole::Responder,
            &hs,
        );
        let mut bad = wire[7].clone();
        let n = bad.len();
        bad[n - 1] ^= 0x01;
        assert_eq!(
            s_fresh.open(&bad).unwrap_err(),
            FrameError::AuthFail,
            "篡改帧必须拒"
        );
        // 明文（非帧）字节 → 拒绝
        assert_eq!(
            s_fresh
                .open(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
                .unwrap_err(),
            FrameError::PlaintextOrUnknownFrame,
            "明文/非帧字节必须拒"
        );
        // nonce 前缀被换（串台/降级）→ 拒
        let mut wrong_prefix = wire[6].clone();
        wrong_prefix[14] ^= 0xff;
        assert_eq!(
            s_fresh.open(&wrong_prefix).unwrap_err(),
            FrameError::AuthFail,
            "nonce 前缀不符必须拒"
        );
        // 反向：服务端 → 客户端 也成立
        let f = s.seal(b"reply");
        assert_eq!(c.open(&f).unwrap(), b"reply".to_vec());
    }

    /// 密钥确认帧：**只有对向**（客户端发的确认由服务端收）能验过；
    /// 确认 MAC 不符（MITM/密钥不一致）→ ConfirmMismatch，绝不降级。
    #[test]
    fn confirm_frame_rejects_mismatched_key() {
        let ct_c = X25519Public::from(&X25519Secret::from([1u8; 32])).to_bytes();
        let ct_s = X25519Public::from(&X25519Secret::from([2u8; 32])).to_bytes();
        let hs = hs_json("acct", "dev", 13911, "tn-cf");
        let ck =
            SessionKeys::derive(&X25519Secret::from([1u8; 32]), &ct_s, &ct_c, &ct_s, &hs).unwrap();
        let sk =
            SessionKeys::derive(&X25519Secret::from([2u8; 32]), &ct_c, &ct_c, &ct_s, &hs).unwrap();
        let client = FrameIo::new(ck, TunnelRole::Originator, &hs);
        let server = FrameIo::new(sk, TunnelRole::Responder, &hs);
        let c_frame = client.confirm_frame();
        let s_frame = server.confirm_frame();
        // 对向互验通过
        assert!(
            server.accept_confirm(&c_frame).is_ok(),
            "服务端应收下客户端的确认"
        );
        assert!(
            client.accept_confirm(&s_frame).is_ok(),
            "客户端应收下服务端的确认"
        );
        // 同向（拿自己的确认帧去验）→ ConfirmMismatch（方向密钥不同 = 防反射）
        assert_eq!(
            client.accept_confirm(&c_frame).unwrap_err(),
            FrameError::ConfirmMismatch,
            "同向确认帧必须拒（方向密钥不同）"
        );
        // 换一个会话（不同临时钥）→ 确认 MAC 必不同 → 拒
        let other =
            SessionKeys::derive(&X25519Secret::from([9u8; 32]), &ct_c, &ct_c, &ct_s, &hs).unwrap();
        let io2 = FrameIo::new(other, TunnelRole::Responder, &hs);
        assert_eq!(
            io2.accept_confirm(&c_frame).unwrap_err(),
            FrameError::ConfirmMismatch,
            "密钥不一致必须 ConfirmMismatch（不降级）"
        );
        // 结构坏（长度/魔数/类型）→ 明确拒绝
        assert_eq!(
            server.accept_confirm(b"short").unwrap_err(),
            FrameError::HelloMalformed
        );
        let mut plain_data = c_frame.clone();
        plain_data[5] = FRAME_DATA;
        assert_eq!(
            server.accept_confirm(&plain_data).unwrap_err(),
            FrameError::PlaintextOrUnknownFrame
        );
        // HELLO 解析：合法帧往返、坏帧拒绝
        let hf = hello_frame(&ct_c);
        assert_eq!(parse_hello(&hf).unwrap(), ct_c);
        let mut bad_magic = hf.clone();
        bad_magic[0] = b'X';
        assert_eq!(
            parse_hello(&bad_magic).unwrap_err(),
            FrameError::HelloMalformed
        );
        assert_eq!(
            parse_hello(&hf[..10]).unwrap_err(),
            FrameError::HelloMalformed
        );
    }

    /// 明文不可见 + 每条连接密钥不同（前向保密：同明文两份密文不同）。
    #[test]
    fn ciphertext_hides_plaintext_and_differs_per_connection() {
        let ct_c = X25519Public::from(&X25519Secret::from([1u8; 32])).to_bytes();
        let ct_s = X25519Public::from(&X25519Secret::from([2u8; 32])).to_bytes();
        let hs = hs_json("acct", "dev", 13911, "tn-c");
        let k1 =
            SessionKeys::derive(&X25519Secret::from([2u8; 32]), &ct_c, &ct_c, &ct_s, &hs).unwrap();
        let k2 =
            SessionKeys::derive(&X25519Secret::from([3u8; 32]), &ct_s, &ct_c, &ct_s, &hs).unwrap();
        let mut a = FrameIo::new(k1, TunnelRole::Responder, &hs);
        let mut b = FrameIo::new(k2, TunnelRole::Responder, &hs);
        let secret = b"Authorization: Bearer SUPER-SECRET-TOKEN-1234567890";
        let fa = a.seal(secret);
        let fb = b.seal(secret);
        assert!(
            !fa.windows(secret.len()).any(|w| w == secret),
            "密文里不得出现明文"
        );
        assert_ne!(fa, fb, "不同会话密钥 → 不同密文");
        assert_ne!(a.keys.prefix, b.keys.prefix, "每条连接 nonce 前缀必须不同");
        // 异会话解不开（不 panic、不返回明文）
        let mut other = FrameIo::new(
            SessionKeys::derive(&X25519Secret::from([4u8; 32]), &ct_s, &ct_c, &ct_s, &hs).unwrap(),
            TunnelRole::Responder,
            &hs,
        );
        assert_eq!(
            other.open(&fa).unwrap_err(),
            FrameError::AuthFail,
            "异会话解不开"
        );
    }

    // ═══ ①′ 连接模式 + 预热池（2026-10-11 提速）═══

    /// base → 模式：`relay://` 标记 = 云端中继，其余（ws://…）= 直连。
    #[test]
    fn mode_of_base_distinguishes_relay_from_direct() {
        assert_eq!(mode_of_base(RELAY_BASE), "relay");
        assert_eq!(
            mode_of_base("ws://192.168.1.10:9100/p2p/tunnel?v=2"),
            "direct"
        );
        assert_eq!(
            mode_of_base("ws://[3fff:390:a94::1]:9100/p2p/tunnel?v=2"),
            "direct"
        );
    }

    /// 模式记录往返：put 之后 tunnel_mode 可读回（页面指示器的数据源）；
    /// 无记录 = None（remote_open 不加 fragment，页面回落"连接中"）。
    #[test]
    fn tunnel_mode_roundtrip_and_default_none() {
        let dev = "did:myco:zModeProbe0001";
        assert_eq!(tunnel_mode(dev, 13911), None, "无记录必须是 None");
        tunnel_mode_put(dev, 13911, "relay");
        assert_eq!(tunnel_mode(dev, 13911), Some("relay"));
        assert_eq!(tunnel_mode(dev, 9100), None, "端口维度隔离（9100 无记录）");
        tunnel_mode_put(dev, 13911, "direct");
        assert_eq!(
            tunnel_mode(dev, 13911),
            Some("direct"),
            "逐连接降级要覆盖前值"
        );
    }

    /// 预热池门控与新鲜度：测试态默认关（不扰动既有连接计数断言）、显式可开；
    /// 条目 60s 新鲜 / 活跃窗口 90s 的边界判定。
    #[test]
    fn warm_pool_gating_and_freshness_boundaries() {
        assert!(!warm_enabled(), "测试态默认关（test_set_warm 未注入）");
        test_set_warm(true);
        assert!(warm_enabled());
        test_set_warm(false);
        assert!(!warm_enabled(), "恢复默认，不泄漏给其它用例");

        let now = std::time::Instant::now();
        let ago = |s: u64| now - Duration::from_secs(s);
        assert!(warm_fresh(ago(59), now), "60s 内新鲜");
        assert!(
            !warm_fresh(ago(60), now),
            "满 60s 过期（宁可再生，不赌陈年连接）"
        );
        assert!(warm_window_open(ago(89), now), "90s 活跃窗口内继续养");
        assert!(
            !warm_window_open(ago(90), now),
            "窗口外清池收工（不为没人看的页面养连接）"
        );
    }

    // ═══ ② 并行赛跑 vs 串行 ═══

    /// 黑穴 listener：accept 后**什么都不回**（模拟"拨得通但握手不响应"的候选）。
    async fn spawn_blackhole() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((s, _)) = l.accept().await {
                held.push(s);
            }
        });
        port
    }

    async fn wait_port_free(retries: usize) {
        for _ in 0..retries {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn race_acct() -> (&'static str, ed25519_dalek::SigningKey, String) {
        let (sk, did) = dev(0x71);
        ("did:youling:RaceAccount", sk, did)
    }

    /// 真 p2p 端点（回环随机端口 + 种名册 + 装授权钩子）。
    async fn spawn_ready_p2p(
        account: &str,
        sk: &ed25519_dalek::SigningKey,
        extra_ports: Vec<u16>,
    ) -> u16 {
        p2p_server::test_seed_roster_cache(account, vec![b64(&sk.verifying_key().to_bytes())]);
        *TEST_EXTRA_PORTS.lock().unwrap() = extra_ports;
        let acc = account.to_string();
        set_tunnel_authorizer(move |a, _d, _p| a == acc);
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(
                l,
                p2p_server::p2p_router().into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        port
    }

    async fn tunnel_attempt(url: &str, hs: Option<&str>, auth: Option<&str>) -> Result<u16, u16> {
        let mut req = url.into_client_request().map_err(|_| 0u16)?;
        if let Some(h) = hs {
            req.headers_mut()
                .insert(TUNNEL_HANDSHAKE_HEADER, h.parse().unwrap());
        }
        if let Some(a) = auth {
            req.headers_mut().insert("x-myco-auth", a.parse().unwrap());
        }
        match tokio_tungstenite::connect_async(req).await {
            Ok((mut ws, resp)) => {
                let _ = ws.close(None).await;
                Ok(resp.status().as_u16())
            }
            Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => Err(resp.status().as_u16()),
            Err(_) => Err(0),
        }
    }

    // ── 2026-10-24 task-19：enc-fail 循环根修的单测（首选单拨 / 退避 / 取消分类） ──

    /// 首选候选健康时：**只拨一条上游连接**（不并发拨第二个候选）。
    /// 锁的行为：改动前 `race_tunnel_ex` 同时拨 2 条，对端 audit 里 = upgraded×2 +（败者被
    /// drop →）enc-fail×1；现在首选单拨 → upgraded×1、enc-fail×0。
    #[tokio::test]
    async fn preferred_dial_single_upstream_when_first_healthy() {
        let _env = crate::test_env_lock::test_env_lock();
        clear_tunnel_authorizer();
        test_clear_cache();
        let (account, sk, did) = race_acct();
        test_set_identity(account, &did, [0x71; 32]);
        let target_port = 19130u16;
        let p2p_port = spawn_ready_p2p(account, &sk, vec![target_port]).await;
        let base = format!("ws://127.0.0.1:{p2p_port}/p2p/tunnel?v=2");
        clear_tunnel_audit();
        // 同一地址放两条候选：赛跑实现会拨两次；首选单拨必须只拨一次。
        let got = dial_preferred_or_race(
            &[base.clone(), base.clone()],
            target_port,
            RACE_CANDIDATE_TIMEOUT,
            RACE_TOTAL_BUDGET,
            None,
            None,
        )
        .await
        .expect("首选健康必须成功");
        assert_eq!(got.0, base);
        drop(got); // 模拟"未开始加密就用完/放弃"：对端应记 peer-abort，不是 enc-fail
        tokio::time::sleep(Duration::from_millis(400)).await;
        let audits = tunnel_audit_recent();
        let upgraded = audits.iter().filter(|a| a.result == "upgraded").count();
        let enc = audits.iter().filter(|a| a.result == "enc-fail").count();
        let abort = audits.iter().filter(|a| a.result == "peer-abort").count();
        assert_eq!(
            upgraded, 1,
            "首选单拨只应产生 1 条 upgraded（赛跑会是 2）：{audits:?}"
        );
        assert_eq!(enc, 0, "取消/放弃不是加密失败：{audits:?}");
        assert_eq!(abort, 1, "握手前被取消应记 peer-abort：{audits:?}");
        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
        wait_port_free(3).await;
    }

    /// 首选候选不可达时：**回落并行赛跑**，仍能选到活候选（不会因为单拨失败就整体失败）。
    #[tokio::test]
    async fn preferred_dial_falls_back_to_race_when_first_dead() {
        let _env = crate::test_env_lock::test_env_lock();
        clear_tunnel_authorizer();
        test_clear_cache();
        let (account, sk, did) = race_acct();
        test_set_identity(account, &did, [0x71; 32]);
        let target_port = 19131u16;
        let p2p_port = spawn_ready_p2p(account, &sk, vec![target_port]).await;
        let black = spawn_blackhole().await;
        let dead = format!("ws://127.0.0.1:{black}/p2p/tunnel?v=2");
        let good = format!("ws://127.0.0.1:{p2p_port}/p2p/tunnel?v=2");
        clear_tunnel_audit();
        let got = dial_preferred_or_race(
            &[dead, good.clone()],
            target_port,
            Duration::from_millis(500),
            RACE_TOTAL_BUDGET,
            None,
            None,
        )
        .await
        .expect("首选死后必须由赛跑兜底");
        assert_eq!(got.0, good, "回落赛跑必须选到活候选");
        drop(got);
        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
        wait_port_free(3).await;
    }

    /// 重建退避：连续失败指数退避（250ms→4s 封顶），成功清零。
    #[test]
    fn open_backoff_grows_and_resets() {
        let dev = "did:myco:zBackoffUnit";
        let port = 19990u16;
        open_backoff_ok(dev, port);
        assert!(
            open_backoff_remaining(dev, port).is_none(),
            "清零后不该退避"
        );
        open_backoff_fail(dev, port);
        let w1 = open_backoff_remaining(dev, port).expect("第 1 次失败后必须退避");
        assert!(w1 <= 500, "第 1 次退避 ≈250-500ms（{w1}）");
        open_backoff_fail(dev, port);
        open_backoff_fail(dev, port);
        open_backoff_fail(dev, port);
        open_backoff_fail(dev, port);
        open_backoff_fail(dev, port);
        let w = open_backoff_remaining(dev, port).expect("连续失败仍在退避");
        assert!(w <= 2000, "退避必须封顶 2s（{w}）");
        open_backoff_ok(dev, port);
        assert!(open_backoff_remaining(dev, port).is_none(), "成功一次清零");
    }

    /// 退避闸作用于 `tunnel_open`：退避窗口内直接人话失败，不再拨号。
    #[tokio::test]
    async fn open_backoff_gates_tunnel_open() {
        let _env = crate::test_env_lock::test_env_lock();
        let (account, _sk, did) = race_acct();
        test_set_identity(account, &did, [0x71; 32]);
        let port = 19132u16;
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![port];
        // 本机设备 = 目标设备 → 走 self 分支（不查 presence/网络），拨 127.0.0.1 必然失败。
        test_set_identity(account, &did, [0x71; 32]);
        open_backoff_ok(&did, port);
        let e1 = tunnel_open(&did, port).await;
        assert!(e1.is_err(), "无服务应失败：{e1:?}");
        let e2 = tunnel_open(&did, port)
            .await
            .expect_err("第 2 次必须被退避闸挡住");
        assert!(e2.contains("退避"), "退避期必须直接返回人话原因：{e2}");
        open_backoff_ok(&did, port);
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
    }

    /// 取消 vs 真加密失败分类（纯函数）。
    #[test]
    fn peer_abort_classification_is_precise() {
        for s in [
            "WebSocket protocol error: Connection reset without closing handshake",
            "对端关闭",
            "连接结束",
            "broken pipe",
            "IO error: 远程主机强迫关闭了一个现有的连接。 (os error 10054)",
            "An existing connection was forcibly closed by the remote host. (os error 10054)",
        ] {
            assert!(peer_aborted_handshake(s), "应判为良性取消：{s}");
        }
        for s in [
            "会话密钥确认失败（可能被中间人/降级）",
            "加密握手帧无效",
            "会话密钥协商失败（低阶公钥/非贡献行为）",
            "收到明文帧或未知帧类型",
        ] {
            assert!(!peer_aborted_handshake(s), "真握手失败不得归为取消：{s}");
        }
    }

    /// 服务端集成：只在 WS 升级后直接断开（预热池取消/赛跑败者）→ audit 记 peer-abort。
    #[tokio::test]
    async fn abort_before_crypto_is_peer_abort_not_enc_fail() {
        let _env = crate::test_env_lock::test_env_lock();
        clear_tunnel_authorizer();
        let (account, sk, did) = race_acct();
        test_set_identity(account, &did, [0x71; 32]);
        let target_port = 19133u16;
        let p2p_port = spawn_ready_p2p(account, &sk, vec![target_port]).await;
        let base = format!("ws://127.0.0.1:{p2p_port}/p2p/tunnel?v=2");
        clear_tunnel_audit();
        let (ws, _resp, _hs) = connect_tunnel(&base, target_port)
            .await
            .expect("WS 升级成功");
        drop(ws); // 不跑加密握手 → 就是赛跑败者/预热回收的现场
        tokio::time::sleep(Duration::from_millis(400)).await;
        let audits = tunnel_audit_recent();
        assert_eq!(
            audits.iter().filter(|a| a.result == "enc-fail").count(),
            0,
            "取消不得记 enc-fail：{audits:?}"
        );
        assert_eq!(
            audits.iter().filter(|a| a.result == "peer-abort").count(),
            1,
            "应记 1 条 peer-abort：{audits:?}"
        );
        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
        wait_port_free(3).await;
    }

    /// **首个成功即采用**：慢候选（黑穴）不拖慢快候选；耗时 ≈ 快候选 RTT。
    #[tokio::test]
    async fn race_adopts_first_success_without_waiting_slow_candidates() {
        let _env = crate::test_env_lock::test_env_lock();
        clear_tunnel_authorizer();
        test_clear_cache();
        let (account, sk, did) = race_acct();
        test_set_identity(account, &did, [0x71; 32]);
        let target_port = 19100u16;
        let p2p_port = spawn_ready_p2p(account, &sk, vec![target_port]).await;
        let black = spawn_blackhole().await;

        let good = format!("ws://127.0.0.1:{p2p_port}/p2p/tunnel?v=2");
        let slow = format!("ws://127.0.0.1:{black}/p2p/tunnel?v=2");
        // 慢候选排前面：串行实现会先耗掉一个候选超时才轮到快候选
        let bases = vec![slow.clone(), good.clone()];
        let per = Duration::from_millis(900);
        let t0 = std::time::Instant::now();
        let got = race_tunnel(&bases, target_port, per, RACE_TOTAL_BUDGET).await;
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        let (base, mut ws, _hs) = got.expect("应有候选成功");
        println!("[race] 2 候选（1 黑穴，单候选超时 900ms）→ 胜出 {base}，耗时 {ms:.1}ms（串行需 ~900ms）");
        assert_eq!(base, good, "胜出的必须是活着的那个候选");
        assert!(ms < 500.0, "并行赛跑不该等慢候选（实测 {ms:.1}ms）");
        let _ = ws.close(None).await;
        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
        wait_port_free(3).await;
    }

    /// **最坏上界**：全不通时按单候选超时收口，不叠加候选数。
    #[tokio::test]
    async fn race_all_dead_bounded_by_candidate_timeout() {
        let _env = crate::test_env_lock::test_env_lock();
        let (account, _sk, did) = race_acct();
        test_set_identity(account, &did, [0x71; 32]);
        let target_port = 19101u16;
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![target_port];
        let b1 = spawn_blackhole().await;
        let b2 = spawn_blackhole().await;
        let b3 = spawn_blackhole().await;
        let bases: Vec<String> = [b1, b2, b3]
            .iter()
            .map(|p| format!("ws://127.0.0.1:{p}/p2p/tunnel?v=2"))
            .collect();
        let per = Duration::from_millis(400);
        let t0 = std::time::Instant::now();
        let got = race_tunnel(&bases, target_port, per, RACE_TOTAL_BUDGET).await;
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        println!(
            "[race] 3 个全不通候选 → None，耗时 {ms:.1}ms（上界=单候选超时 400ms，不是 3×400ms）"
        );
        assert!(got.is_none());
        assert!(ms < 700.0, "全不通上界应≈单候选超时（实测 {ms:.1}ms）");
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
        wait_port_free(3).await;
    }

    /// **并行 vs 串行 对照**：同候选集、同单候选超时，仅差是否并行。
    /// 用相对断言（不依赖本机绝对 RTT），两侧实测 ms 打进输出。
    #[tokio::test]
    async fn race_parallel_is_faster_than_sequential_same_candidates() {
        let _env = crate::test_env_lock::test_env_lock();
        clear_tunnel_authorizer();
        let (account, sk, did) = race_acct();
        test_set_identity(account, &did, [0x71; 32]);
        let target_port = 19102u16;
        let p2p_port = spawn_ready_p2p(account, &sk, vec![target_port]).await;
        let good = format!("ws://127.0.0.1:{p2p_port}/p2p/tunnel?v=2");
        let black = spawn_blackhole().await;
        let slow = format!("ws://127.0.0.1:{black}/p2p/tunnel?v=2");
        let per = Duration::from_millis(500);
        let p_bases = vec![slow.clone(), slow.clone(), slow.clone(), good.clone()];

        // 并行：4 个候选同时发起 → 首个成功即采用
        let t0 = std::time::Instant::now();
        let par = race_tunnel(&p_bases, target_port, per, RACE_TOTAL_BUDGET).await;
        let par_ms = t0.elapsed().as_secs_f64() * 1000.0;
        assert!(par.is_some(), "并行应至少有一个成功");

        // 串行：同批候选按顺序逐个试（与并行同超时）——前 3 个黑穴各耗 500ms
        let t1 = std::time::Instant::now();
        let mut seq_ok = false;
        for b in &p_bases {
            if let Ok(Ok((mut ws, _r, _hs))) =
                tokio::time::timeout(per, connect_tunnel(b, target_port)).await
            {
                let _ = ws.close(None).await;
                seq_ok = true;
                break;
            }
        }
        let seq_ms = t1.elapsed().as_secs_f64() * 1000.0;
        assert!(seq_ok, "串行对照也必须最终成功");
        assert!(
            par_ms < seq_ms,
            "并行({par_ms:.1}ms) 必须快于串行({seq_ms:.1}ms)"
        );
        println!(
            "[race] 同候选集（3 黑穴前缀 + 1 可用；单候选超时 {}ms）：并行 {par_ms:.1}ms vs 串行 {seq_ms:.1}ms（加速比 {:.1}x）",
            per.as_millis(),
            seq_ms / par_ms.max(0.001)
        );
        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
        wait_port_free(3).await;
    }

    /// **成功路径缓存**：胜出 base 入缓存且排最前（下次先试它），去重保序。
    #[tokio::test]
    async fn cache_remembers_success_and_prioritizes_it() {
        let _env = crate::test_env_lock::test_env_lock();
        clear_tunnel_authorizer();
        test_clear_cache();
        let (account, sk, did) = race_acct();
        test_set_identity(account, &did, [0x71; 32]);
        let target_port = 19103u16;
        let p2p_port = spawn_ready_p2p(account, &sk, vec![target_port]).await;
        let p2p_base = format!("http://127.0.0.1:{p2p_port}");
        let black = spawn_blackhole().await;
        let dead_base = format!("http://127.0.0.1:{black}");

        let ws_bases = vec![http_to_ws(&dead_base), http_to_ws(&p2p_base)];
        let got = probe_tunnel_parallel(
            &ws_bases,
            target_port,
            Duration::from_millis(500),
            RACE_TOTAL_BUDGET,
        )
        .await;
        assert_eq!(got.as_deref(), Some(http_to_ws(&p2p_base).as_str()));
        // 归一：缓存口径必须是 host:port（`tunnel_open_with_bases` 的实际缓存行为），
        // 否则下次 merge_candidates 会因 ws/http 形态不同而去重失效、白占并行腿。
        assert_eq!(
            ws_to_http(got.as_deref().unwrap()),
            p2p_base,
            "缓存必须归一成 host:port 形态"
        );
        cache_put(&did, &ws_to_http(got.as_deref().unwrap()));
        let cached = cache_get(&did).expect("成功路径必须进缓存");
        assert_eq!(cached, p2p_base);
        let merged = merge_candidates(Some(&cached), &[p2p_base.clone()], &[]);
        assert_eq!(merged[0], cached, "缓存 base 必须排最前（下次先试它）");
        assert_eq!(merged.len(), 1, "同一地址（缓存+显式）必须去重成一条");

        // 候选合并形状：缓存 → 显式 → 本机；去重保序
        let m = merge_candidates(
            Some("http://a:1"),
            &["http://b:2".into(), "http://a:1".into()],
            &["http://c:3".into(), "http://b:2".into()],
        );
        assert_eq!(
            m,
            vec!["http://a:1", "http://b:2", "http://c:3"],
            "顺序=缓存→显式→本机，去重保序"
        );
        assert!(merge_candidates(None, &[], &[]).is_empty());
        assert_eq!(
            merge_candidates(None, &["  ".into(), "http://x:9/".into()], &[]),
            vec!["http://x:9"]
        );
        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
        wait_port_free(3).await;
    }

    /// 人工对照跑（默认忽略）：打印候选集下并行 vs 串行的原始 ms。
    ///   <test-exe> --ignored --exact --nocapture p2p_tunnel::tunnel_tests::race_bench_vs_sequential_ignore
    #[tokio::test]
    #[ignore]
    async fn race_bench_vs_sequential_ignore() {
        let _env = crate::test_env_lock::test_env_lock();
        clear_tunnel_authorizer();
        let (account, sk, did) = race_acct();
        test_set_identity(account, &did, [0x71; 32]);
        let target_port = 19109u16;
        let p2p_port = spawn_ready_p2p(account, &sk, vec![target_port]).await;
        let good = format!("ws://127.0.0.1:{p2p_port}/p2p/tunnel?v=2");
        let black = spawn_blackhole().await;
        let slow = format!("ws://127.0.0.1:{black}/p2p/tunnel?v=2");
        let per = Duration::from_millis(900);
        // 同一候选集、同一单候选超时；**慢候选排前面**（旧串行实现的最坏序：前三个各耗一个超时）
        let bases = vec![slow.clone(), slow.clone(), slow.clone(), good.clone()];
        // 并行：4 候选同时发起 → 首个成功即采用
        let t0 = std::time::Instant::now();
        let par = race_tunnel(&bases, target_port, per, RACE_TOTAL_BUDGET).await;
        let par_ms = t0.elapsed().as_secs_f64() * 1000.0;
        assert!(par.is_some());
        // 串行对照：同批候选按顺序逐个试（与并行同超时）
        let t1 = std::time::Instant::now();
        let mut seq_ok = false;
        for b in &bases {
            if let Ok(Ok((mut ws, _r, _hs))) =
                tokio::time::timeout(per, connect_tunnel(b, target_port)).await
            {
                let _ = ws.close(None).await;
                seq_ok = true;
                break;
            }
        }
        let seq_ms = t1.elapsed().as_secs_f64() * 1000.0;
        assert!(seq_ok);
        println!(
            "[bench] 4 候选（慢候选在前；单候选超时 {}ms，总预算 {}ms）：并行 {par_ms:.1}ms vs 串行 {seq_ms:.1}ms",
            per.as_millis(),
            RACE_TOTAL_BUDGET.as_millis()
        );
        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
    }

    // ═══ ③ 端到端（加密隧道打通 + 降级被拒） ═══

    async fn spawn_mock_http(body: &'static str) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let _ = s.read(&mut buf).await;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = s.write_all(resp.as_bytes()).await;
                    let _ = s.shutdown().await;
                });
            }
        });
        port
    }

    async fn spawn_mock_ws() -> u16 {
        use axum::routing::get;
        let app = axum::Router::new().route(
            "/ws",
            get(|ws: WebSocketUpgrade| async move {
                ws.on_upgrade(|mut s: WebSocket| async move {
                    while let Some(Ok(m)) = s.recv().await {
                        match m {
                            Message::Text(t) => {
                                let _ = s.send(Message::Text(format!("echo:{t}").into())).await;
                            }
                            Message::Binary(b) => {
                                let _ = s.send(Message::Binary(b)).await;
                            }
                            Message::Close(_) => break,
                            _ => {}
                        }
                    }
                })
            }),
        );
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(l, app).await;
        });
        port
    }

    async fn spawn_p2p_server() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(
                l,
                p2p_server::p2p_router().into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        port
    }

    /// **端到端**：加密隧道两端对拍 —— HTTP 与内层 WS 都原样穿透，审计齐全。
    #[tokio::test]
    async fn tunnel_end_to_end_http_and_ws_encrypted() {
        let _env = crate::test_env_lock::test_env_lock();
        clear_tunnel_authorizer();
        clear_tunnel_audit();
        test_clear_cache();
        let account = "did:youling:TunnelE2EAccount";
        let (sk, did) = dev(0xE1);
        test_set_identity(account, &did, [0xE1; 32]);
        p2p_server::test_seed_roster_cache(account, vec![b64(&sk.verifying_key().to_bytes())]);

        let http_body = "hello-through-encrypted-p2p-tunnel";
        let http_port = spawn_mock_http(http_body).await;
        let ws_port = spawn_mock_ws().await;
        let p2p_port = spawn_p2p_server().await;
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![http_port, ws_port];

        let bases = vec![format!("http://127.0.0.1:{p2p_port}")];

        // ⓪ fail-closed：未装授权钩子 → 建不起来
        assert!(
            tunnel_open_with_bases(bases.clone(), &did, "device-A", http_port)
                .await
                .is_err(),
            "未安装授权钩子时必须拒绝建隧道"
        );
        set_tunnel_authorizer(move |acc, _dev, port| {
            acc == account && (port == http_port || port == ws_port)
        });

        // ① HTTP 经加密隧道
        let t0 = std::time::Instant::now();
        let local = tunnel_open_with_bases(bases.clone(), &did, "device-A", http_port)
            .await
            .expect("隧道应建立");
        let open_ms = t0.elapsed().as_secs_f64() * 1000.0;
        println!("[E2E] tunnel_open 建连耗时 {open_ms:.1}ms（1 候选）");
        assert!(local > 0 && local != http_port);
        assert_eq!(tunnel_local_port(&did, http_port), Some(local));
        let resp = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap()
            .get(format!("http://127.0.0.1:{local}/any/path?q=1"))
            .send()
            .await
            .expect("经隧道取 HTTP 失败");
        assert_eq!(resp.status(), 200);
        let text = resp.text().await.unwrap();
        assert_eq!(text, http_body, "隧道回来的必须是目标端响应体");

        // ② 内层 WS 穿透
        let local_ws = tunnel_open_with_bases(bases.clone(), &did, "device-A", ws_port)
            .await
            .expect("WS 隧道应建立");
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{local_ws}/ws"))
            .await
            .expect("经隧道建内层 WS 失败");
        ws.send(TMessage::Text("ping-through-tunnel".into()))
            .await
            .unwrap();
        let got = loop {
            match tokio::time::timeout(Duration::from_secs(10), ws.next()).await {
                Ok(Some(Ok(TMessage::Text(t)))) => break t.to_string(),
                Ok(Some(Ok(_))) => continue,
                other => panic!("内层 WS 未收到文本回包: {other:?}"),
            }
        };
        assert_eq!(got, "echo:ping-through-tunnel", "内层 WS 必须原样穿透");
        let _ = ws.close(None).await;

        // ③ 审计
        let audit = tunnel_audit_recent();
        assert!(
            audit.iter().any(|a| a.result == "upgraded"
                && a.account == account
                && a.port == http_port
                && a.device == did),
            "审计必须记录 谁/哪台设备/哪个端口: {audit:?}"
        );

        // ④ 关闭
        assert!(tunnel_close(&did, http_port));
        assert!(tunnel_close(&did, ws_port));
        assert_eq!(tunnel_local_port(&did, http_port), None);
        assert!(!tunnel_close(&did, http_port), "重复关闭返回 false");

        // ⑤ 未授权端口直接拒（客户端本地闸）
        assert!(tunnel_open_with_bases(bases, &did, "device-A", 3389)
            .await
            .is_err());
        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
    }

    /// **降级拒绝**：v1（无 `?v=2`）→ 400；升级成功但发明文帧 → 服务端失败并留 `enc-fail`。
    #[tokio::test]
    async fn plaintext_and_v1_clients_are_rejected() {
        let _env = crate::test_env_lock::test_env_lock();
        clear_tunnel_audit();
        clear_tunnel_authorizer();
        let account = "did:youling:DowngradeAccount";
        let (sk, did) = dev(0xE8);
        test_set_identity(account, &did, [0xE8; 32]);
        p2p_server::test_seed_roster_cache(account, vec![b64(&sk.verifying_key().to_bytes())]);
        let p2p_port = spawn_p2p_server().await;
        let free_port = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![free_port];
        set_tunnel_authorizer(move |acc, _d, _p| acc == account);

        // ① v1 客户端：URL 不带 ?v=2 → 400
        let (hs, auth) = tunnel_credentials(free_port).unwrap();
        let v1_url = format!("ws://127.0.0.1:{p2p_port}/p2p/tunnel");
        assert_eq!(
            tunnel_attempt(&v1_url, Some(&hs), Some(&auth)).await,
            Err(400),
            "v1（无 ?v=2）必须 400，不得静默降级"
        );
        let v1b = format!("ws://127.0.0.1:{p2p_port}/p2p/tunnel?v=1");
        assert_eq!(tunnel_attempt(&v1b, Some(&hs), Some(&auth)).await, Err(400));
        // 版本不符的握手体（v=1 的 JSON）也必须 400
        let legacy_hs = format!(
            "{{\"v\":1,\"port\":{free_port},\"account\":\"{account}\",\"device\":\"{did}\",\"nonce\":\"tn-legacy\"}}"
        );
        let legacy_auth = auth_str(&sk, &did, &legacy_hs);
        let v2_url = format!("ws://127.0.0.1:{p2p_port}/p2p/tunnel?v=2");
        assert_eq!(
            tunnel_attempt(&v2_url, Some(&legacy_hs), Some(&legacy_auth)).await,
            Err(400)
        );

        // ② 协议版本对，但升级后**发明文帧**（模拟"内容不加密"）→ 服务端必须失败/关闭
        let (hs2, auth2) = tunnel_credentials(free_port).unwrap();
        let (mut ws, _resp) = {
            let mut req = v2_url.as_str().into_client_request().unwrap();
            req.headers_mut()
                .insert(TUNNEL_HANDSHAKE_HEADER, hs2.parse().unwrap());
            req.headers_mut()
                .insert("x-myco-auth", auth2.parse().unwrap());
            tokio_tungstenite::connect_async(req)
                .await
                .expect("升级应成功（闸门都过）")
        };
        let _ = ws
            .send(TMessage::Binary(
                b"GET / HTTP/1.1\r\nHost: x\r\n\r\n".to_vec(),
            ))
            .await;
        let closed = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                match ws.next().await {
                    Some(Ok(TMessage::Close(_))) | None => break true,
                    Some(Ok(_)) => continue,
                    Some(Err(_)) => break true,
                }
            }
        })
        .await;
        assert!(
            closed.is_ok(),
            "发明文帧后服务端必须关闭连接（实测超时未关）"
        );
        let audit = tunnel_audit_recent();
        assert!(
            audit.iter().any(|a| a.result == "enc-fail"),
            "明文/降级尝试必须留 enc-fail 审计: {audit:?}"
        );

        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
        wait_port_free(3).await;
    }

    // ═══ ④ 闸门（回归） ═══

    #[test]
    fn whitelist_only_listed_ports() {
        assert!(tunnel_port_allowed_in(13911, &[]), "公网网关端口必须在册");
        assert!(tunnel_port_allowed_in(9100, &[]), "p2p 服务器端口必须在册");
        for bad in [0u16, 1, 80, 8080, 3102, 3306, 65535] {
            assert!(
                !tunnel_port_allowed_in(bad, &[]),
                "端口 {bad} 不得在册（防开放代理）"
            );
        }
        assert!(tunnel_port_allowed_in(8080, &[8080]));
        assert!(!tunnel_port_allowed_in(8081, &[8080]));
    }

    #[test]
    fn gate_decision_truth_table() {
        let (sk, did) = dev(1);
        let (_sk2, other) = dev(2);
        assert_eq!(
            tunnel_gate_decision(&did, &other, 8080, &[], true, true),
            Err(TunnelReject::DeviceMismatch)
        );
        assert_eq!(
            tunnel_gate_decision(&did, &did, 8080, &[], true, true),
            Err(TunnelReject::PortNotAllowed)
        );
        assert_eq!(
            tunnel_gate_decision(&did, &did, 13911, &[], false, true),
            Err(TunnelReject::Ownership)
        );
        assert_eq!(
            tunnel_gate_decision(&did, &did, 13911, &[], true, false),
            Err(TunnelReject::NotAuthorized)
        );
        assert_eq!(
            tunnel_gate_decision(&did, &did, 13911, &[], true, true),
            Ok(())
        );
        // canonical 另一前缀写法（同钥）仍过闸；legacy 已废止 → DeviceMismatch（不再互认）
        let youling = did.replacen("did:myco:", "did:youling:", 1);
        assert_eq!(
            tunnel_gate_decision(&did, &youling, 9100, &[], true, true),
            Ok(())
        );
        let legacy = format!(
            "did:myco:{}",
            bs58::encode(&sk.verifying_key().to_bytes()).into_string()
        );
        assert_eq!(
            tunnel_gate_decision(&did, &legacy, 9100, &[], true, true),
            Err(TunnelReject::DeviceMismatch),
            "legacy 已废止：设备一致性闸不再互认"
        );
    }

    #[test]
    fn authorizer_hook_default_deny_then_follows_hook() {
        clear_tunnel_authorizer();
        assert!(
            !tunnel_authorized("did:youling:A", "did:myco:D", 13911),
            "未安装钩子必须拒绝（否则任何在册账号都能开放代理）"
        );
        set_tunnel_authorizer(|acc, _dev, port| acc == "did:youling:Granted" && port == 13911);
        assert!(tunnel_authorized(
            "did:youling:Granted",
            "did:myco:D",
            13911
        ));
        assert!(!tunnel_authorized(
            "did:youling:Stranger",
            "did:myco:D",
            13911
        ));
        assert!(!tunnel_authorized(
            "did:youling:Granted",
            "did:myco:D",
            9100
        ));
        clear_tunnel_authorizer();
        assert!(
            !tunnel_authorized("did:youling:Granted", "did:myco:D", 13911),
            "复位后回到拒绝"
        );
    }

    #[test]
    fn resume_leg_guard_marks_recovering_on_drop() {
        let sess = Arc::new(Mutex::new(tunnel_resume_frames::ResumeSession::new([0x77u8; 16])));
        sess.lock().unwrap().on_leg_open();
        {
            let _guard = ResumeLegGuard::new(sess.clone());
        }
        assert_eq!(sess.lock().unwrap().state, tunnel_resume_frames::SessionState::Recovering);
    }

    #[test]
    fn stale_leg_guard_does_not_mark_new_leg_recovering() {
        // 旧腿 pump 晚于新腿收尾：旧守卫 drop 时不得把已前进的会话打回 Recovering。
        let sess = Arc::new(Mutex::new(tunnel_resume_frames::ResumeSession::new([0x78u8; 16])));
        sess.lock().unwrap().on_leg_open(); // leg=1
        let stale_guard = ResumeLegGuard::new(sess.clone());
        sess.lock().unwrap().on_leg_dead(0);
        sess.lock().unwrap().on_resume(0).expect("resume"); // leg=2, Open
        drop(stale_guard);
        assert_eq!(
            sess.lock().unwrap().state,
            tunnel_resume_frames::SessionState::Open,
            "旧腿收尾不能覆盖新腿的 Open"
        );
    }

    #[test]
    fn concurrent_local_connections_get_distinct_resume_sessions() {
        // 2026-11-02 RED：同一 forward 上两条并发本地连接共用会话 → offset 互踩。
        let key = client_resume_session_key("local", "target", 13911);
        let a = Arc::new(Mutex::new(tunnel_resume_frames::ResumeSession::new(new_client_resume_sid(&key))));
        let b = Arc::new(Mutex::new(tunnel_resume_frames::ResumeSession::new(new_client_resume_sid(&key))));
        a.lock().unwrap().on_leg_open();
        b.lock().unwrap().on_leg_open();
        a.lock().unwrap().on_local_data(b"GET / HTTP/1.1\r\n\r\n");
        assert_eq!(a.lock().unwrap().send_next, 18);
        assert_eq!(b.lock().unwrap().send_next, 0, "并发连接不能共享 send_next");
        assert_ne!(
            a.lock().unwrap().session_id,
            b.lock().unwrap().session_id,
            "同键也要有各自的 sid"
        );
    }

    #[test]
    fn resume_owner_requires_same_account_and_device() {
        let owner = Some(("acct-a".to_string(), "dev-a".to_string()));
        assert!(resume_owner_matches(owner.clone(), "acct-a", "dev-a"));
        assert!(!resume_owner_matches(owner.clone(), "acct-a", "dev-b"));
        assert!(!resume_owner_matches(owner, "acct-b", "dev-a"));
        assert!(!resume_owner_matches(None, "acct-a", "dev-a"));
    }

    #[test]
    fn client_resume_session_key_scopes_by_target() {
        let a = client_resume_session_key("local", "target-a", 3389);
        let b = client_resume_session_key("local", "target-b", 3389);
        assert_ne!(a, b, "不同目标设备不能共用 RESUME 会话");
        assert_eq!(a, client_resume_session_key("local", "target-a", 3389));
    }

    #[test]
    fn handshake_resume_cap_is_opt_in_and_old_json_stays_v1() {
        let old = hs_json("did:youling:Acc", "did:myco:Dev", 13911, "tn-old");
        assert!(!old.contains("\"cap\""), "老握手不能多出 cap 字段");
        let old_hs: TunnelHandshake = serde_json::from_str(&old).unwrap();
        assert!(!old_hs.resume_capable());
        let with_cap = serde_json::json!({
            "v": TUNNEL_PROTOCOL_VERSION,
            "port": 13911,
            "account": "did:youling:Acc",
            "device": "did:myco:Dev",
            "origin": "did:myco:Dev",
            "nonce": "tn-new",
            "cap": ["resume"],
        });
        let new_hs: TunnelHandshake = serde_json::from_value(with_cap).unwrap();
        assert!(new_hs.resume_capable());
    }

    #[test]
    fn handshake_json_is_camel_case_and_signable() {
        let handshake = hs_json("did:youling:Acc", "did:myco:Dev", 13911, "tn-1");
        let hs: TunnelHandshake = serde_json::from_str(&handshake).unwrap();
        assert_eq!(hs.v, TUNNEL_PROTOCOL_VERSION);
        assert_eq!(hs.port, 13911);
        assert_eq!(hs.account, "did:youling:Acc");
        assert_eq!(hs.device, "did:myco:Dev");
        assert_eq!(hs.origin, "did:myco:Dev");
        assert_eq!(hs.nonce, "tn-1");
        assert!(
            handshake.contains("\"account\"")
                && handshake.contains("\"device\"")
                && handshake.contains("\"origin\""),
            "camelCase 约定"
        );
    }

    #[test]
    fn handshake_verify_rejects_missing_and_wrong_signature() {
        let (sk, did) = dev(11);
        let hs = hs_json("did:youling:Acc", &did, 13911, "tn-1");
        assert!(
            p2p_server::verify_auth(&HeaderMap::new(), hs.as_bytes()).is_none(),
            "无签名必须拒"
        );
        let h = auth_header(&sk, &did, &hs);
        assert_eq!(
            p2p_server::verify_auth(&h, hs.as_bytes()).as_deref(),
            Some(did.as_str())
        );
        let tampered = hs_json("did:youling:Acc", &did, 9100, "tn-1");
        assert!(
            p2p_server::verify_auth(&h, tampered.as_bytes()).is_none(),
            "篡改端口必须拒"
        );
        let (sk2, did2) = dev(12);
        let h2 = auth_header(&sk2, &did2, &hs);
        let signer = p2p_server::verify_auth(&h2, hs.as_bytes());
        assert_eq!(signer.as_deref(), Some(did2.as_str()));
        assert_eq!(
            tunnel_gate_decision(signer.as_deref().unwrap(), &did, 13911, &[], true, true),
            Err(TunnelReject::DeviceMismatch)
        );
    }

    #[tokio::test]
    async fn ownership_gate_rejects_device_not_in_roster() {
        let account = "did:youling:TunnelRosterAccount";
        let (real_sk, real_dev) = dev(21);
        let (_ghost_sk, ghost) = dev(22);
        p2p_server::test_seed_roster_cache(account, vec![b64(&real_sk.verifying_key().to_bytes())]);
        assert!(
            p2p_server::device_belongs_to_account(&real_dev, account).await,
            "在册设备应放行"
        );
        assert!(
            !p2p_server::device_belongs_to_account(&ghost, account).await,
            "未在册设备必须拒"
        );
        assert_eq!(
            tunnel_gate_decision(&ghost, &ghost, 13911, &[], false, true),
            Err(TunnelReject::Ownership)
        );
    }

    #[test]
    fn nonce_replay_is_rejected() {
        let now = chrono::Utc::now().timestamp_millis();
        let n = format!("tn-test-{}", std::process::id());
        assert!(!nonce_is_replay(&n, now), "首次不算重放");
        assert!(nonce_is_replay(&n, now), "同 nonce 第二次必须判重放");
        assert!(!nonce_is_replay(&format!("{n}-x"), now));
        // 新 nonce 的真随机性：连续 100 个不重复、前缀稳定
        let mut seen = std::collections::HashSet::new();
        for _ in 0..100 {
            let s = next_nonce();
            assert!(s.starts_with("tn-"));
            assert!(seen.insert(s), "nonce 不得重复");
        }
    }

    #[tokio::test]
    async fn tunnel_endpoint_rejects_bad_handshakes() {
        let _env = crate::test_env_lock::test_env_lock();
        clear_tunnel_audit();
        clear_tunnel_authorizer();
        test_set_identity("did:youling:RejectCase", "did:myco:unused", [0xE2; 32]);
        let p2p_port = spawn_p2p_server().await;
        let url = format!("ws://127.0.0.1:{p2p_port}/p2p/tunnel?v=2");

        // ① 无握手头 → 400
        assert_eq!(tunnel_attempt(&url, None, None).await, Err(400));
        // ② 有握手头无签名 → 403
        let hs = hs_json(
            "did:youling:RejectCase",
            "did:myco:unused",
            13911,
            "tn-reject-1",
        );
        assert_eq!(tunnel_attempt(&url, Some(&hs), None).await, Err(403));
        // ③ 签名对但端口越权 → 403
        let (sk, did) = dev(0xE3);
        let hs2 = hs_json("did:youling:RejectCase", &did, 8080, "tn-reject-2");
        let a2 = auth_str(&sk, &did, &hs2);
        assert_eq!(tunnel_attempt(&url, Some(&hs2), Some(&a2)).await, Err(403));
        // ④ 篡改端口 → 403
        let (sk2, did2) = dev(0xE4);
        let signed = hs_json("did:youling:RejectCase", &did2, 13911, "tn-reject-3");
        let tampered = hs_json("did:youling:RejectCase", &did2, 9100, "tn-reject-3");
        let a3 = auth_str(&sk2, &did2, &signed);
        assert_eq!(
            tunnel_attempt(&url, Some(&tampered), Some(&a3)).await,
            Err(403)
        );
        // ⑤ 归属不在册 → 403
        let (sk5, did5) = dev(0xE5);
        let (sk7, other_dev) = dev(0xE7);
        p2p_server::test_seed_roster_cache(
            "did:youling:NotInRosterAccount",
            vec![b64(&sk7.verifying_key().to_bytes())],
        );
        let hs5 = hs_json(
            "did:youling:NotInRosterAccount",
            &did5,
            13911,
            "tn-reject-5",
        );
        let a5 = auth_str(&sk5, &did5, &hs5);
        assert_eq!(tunnel_attempt(&url, Some(&hs5), Some(&a5)).await, Err(403));
        let _ = other_dev;

        // ⑥ 未安装授权钩子 → 403（fail-closed）
        let (sk6, did6) = dev(0xE6);
        p2p_server::test_seed_roster_cache(
            "did:youling:ReplayAccount",
            vec![b64(&sk6.verifying_key().to_bytes())],
        );
        let free_port = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![free_port];
        let hs6 = hs_json("did:youling:ReplayAccount", &did6, free_port, "tn-noauth-1");
        let a6 = auth_str(&sk6, &did6, &hs6);
        assert_eq!(
            tunnel_attempt(&url, Some(&hs6), Some(&a6)).await,
            Err(403),
            "未装授权钩子必须拒"
        );

        // ⑦ 装上钩子：首次升级 101；同 nonce 第二次 → 403 Replay
        set_tunnel_authorizer(|acc, _, _| acc == "did:youling:ReplayAccount");
        let hs7 = hs_json(
            "did:youling:ReplayAccount",
            &did6,
            free_port,
            "tn-replay-fixed",
        );
        let a7 = auth_str(&sk6, &did6, &hs7);
        assert_eq!(
            tunnel_attempt(&url, Some(&hs7), Some(&a7)).await,
            Ok(101),
            "授权后握手应被接受"
        );
        let hs7b = hs_json(
            "did:youling:ReplayAccount",
            &did6,
            free_port,
            "tn-replay-fixed",
        );
        let a7b = auth_str(&sk6, &did6, &hs7b);
        assert_eq!(
            tunnel_attempt(&url, Some(&hs7b), Some(&a7b)).await,
            Err(403),
            "重放必须拒"
        );

        // ⑧ 发起方 ≠ 签名者（转发别人的合法握手）→ 403
        let (sk8, did8) = dev(0xE9);
        p2p_server::test_seed_roster_cache(
            "did:youling:OriginMismatch",
            vec![b64(&sk8.verifying_key().to_bytes())],
        );
        let (_ox_sk, ox_did) = dev(0xEA);
        let hs8 = tunnel_handshake_json(
            "did:youling:OriginMismatch",
            &did8,
            &ox_did,
            free_port,
            "tn-origin-1",
        );
        let a8 = auth_str(&sk8, &did8, &hs8);
        assert_eq!(
            tunnel_attempt(&url, Some(&hs8), Some(&a8)).await,
            Err(403),
            "origin 必须是签名者本人"
        );

        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];

        let results: Vec<String> = tunnel_audit_recent()
            .into_iter()
            .map(|a| a.result)
            .collect();
        for want in [
            "bad-handshake",
            "bad-signature",
            "port-not-allowed",
            "not-owner",
            "not-authorized",
            "replay",
            "device-mismatch",
        ] {
            assert!(
                results.iter().any(|r| r == want),
                "审计缺 {want}: {results:?}"
            );
        }
    }

    // ═══ ⑤ 反射地址（候选/形状/观测端点） ═══

    /// 地址 → 候选 URL：IPv6 方括号、IPv4 原样、顺序即传入顺序。
    #[test]
    fn candidate_url_shape_and_order() {
        let addrs: Vec<String> = ["10.0.0.8", "203.0.113.7", "198.51.100.9", "3fff:1::2"]
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(
            p2p_server::urls_from_addrs(&addrs, 9100),
            vec![
                "http://10.0.0.8:9100",
                "http://203.0.113.7:9100",
                "http://198.51.100.9:9100",
                "http://[3fff:1::2]:9100",
            ]
        );
    }

    /// `http_to_ws`：版本进 URL（老客户端拿不到 v2 → 服务端 400）。
    #[test]
    fn http_to_ws_carries_protocol_version() {
        assert_eq!(
            http_to_ws("http://1.2.3.4:9100"),
            "ws://1.2.3.4:9100/p2p/tunnel?v=2"
        );
        assert_eq!(
            http_to_ws("https://d.example/"),
            "wss://d.example/p2p/tunnel?v=2"
        );
        assert_eq!(http_to_ws("ws://h:1"), "ws://h:1/p2p/tunnel?v=2");
        assert_eq!(http_to_ws("h:9100"), "ws://h:9100/p2p/tunnel?v=2");
    }

    /// 反射观测：服务器按 TCP peer 得到"我在公网看来是什么地址"；
    /// IPv4-mapped v6（双栈 socket 收 IPv4 的形态）必须归一成 IPv4。
    #[test]
    fn reflexive_from_peer_normalizes_v4_and_mapped_v6() {
        let v4: SocketAddr = "203.0.113.7:51000".parse().unwrap();
        assert_eq!(
            p2p_server::reflexive_from_peer(v4),
            Some(("203.0.113.7".to_string(), false))
        );
        let mapped: SocketAddr = "[::ffff:203.0.113.7]:51000".parse().unwrap();
        assert_eq!(
            p2p_server::reflexive_from_peer(mapped),
            Some(("203.0.113.7".to_string(), false))
        );
        let v6: SocketAddr = "[3fff:1::2]:51000".parse().unwrap();
        let (a, is6) = p2p_server::reflexive_from_peer(v6).unwrap();
        assert_eq!(a, "3fff:1::2");
        assert!(is6);
    }

    /// 反射地址发布形状：按设备 did 记录、TTL 内可读、后观测覆盖前观测、空值不覆盖；
    /// 响应 JSON 带 `reflexive` / `reflexiveIsV6` / `ports`。
    #[test]
    fn reflexive_observation_shape_and_ttl() {
        p2p_server::clear_reflexive_observations();
        let did = "did:myco:ReflexDevice";
        assert_eq!(p2p_server::reflexive_addrs(did), None, "未观测=None");
        p2p_server::record_reflexive_observation(did, "203.0.113.9");
        assert_eq!(
            p2p_server::reflexive_addrs(did),
            Some(("203.0.113.9".to_string(), false)),
            "观测后 TTL 内可读"
        );
        p2p_server::record_reflexive_observation(did, "3fff:9::1");
        assert_eq!(
            p2p_server::reflexive_addrs(did),
            Some(("3fff:9::1".to_string(), true)),
            "后观测覆盖前观测"
        );
        p2p_server::record_reflexive_observation("", "1.2.3.4");
        p2p_server::record_reflexive_observation(did, "");
        assert_eq!(
            p2p_server::reflexive_addrs(did),
            Some(("3fff:9::1".to_string(), true)),
            "空值不覆盖"
        );

        let j = p2p_server::reflect_response_json(
            Some(("198.51.100.9".to_string(), false)),
            did,
            &[9100, 13911],
        );
        assert_eq!(j["ok"], json!(true));
        assert_eq!(j["reflexive"], json!("198.51.100.9"));
        assert_eq!(j["reflexiveIsV6"], json!(false));
        assert_eq!(j["ports"], json!([9100, 13911]));
        assert_eq!(j["device"], json!(did));
        let bad = p2p_server::reflect_response_json(None, did, &[]);
        assert_eq!(bad["ok"], json!(false));
        p2p_server::clear_reflexive_observations();
    }

    /// 端到端：真发一次 `/p2p/reflect` 签名请求，服务器回"我看到的你"（并进观测表）。
    #[tokio::test]
    async fn reflect_endpoint_returns_observed_source() {
        let _env = crate::test_env_lock::test_env_lock();
        p2p_server::clear_reflexive_observations();
        let p2p_port = spawn_p2p_server().await;
        let (sk, did) = dev(0xF1);
        let body = serde_json::to_string(&json!({ "ports": [9100] })).unwrap();
        let auth = auth_str(&sk, &did, &body);
        // 无签名 → 403（只有签名设备能问自己的出口地址）
        let unauth = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{p2p_port}/p2p/reflect"))
            .body(body.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(unauth.status(), 403, "反射端点必须验签");
        // 有签名 → 200 + 观测地址（回环环境=127.0.0.1/[::1]）
        let ok = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{p2p_port}/p2p/reflect"))
            .header("x-myco-auth", &auth)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .unwrap();
        assert_eq!(ok.status(), 200);
        let v: Value = ok.json().await.unwrap();
        assert_eq!(v["ok"], json!(true), "应回观测结果: {v}");
        let addr = v["reflexive"].as_str().unwrap_or("");
        assert!(!addr.is_empty(), "回环也应能观测到源地址");
        println!("[reflect] 服务器观测到的本机出口 = {addr}（回环环境=127.0.0.1/[::1]）");
        assert_eq!(
            p2p_server::reflexive_addrs(&did).map(|(a, _)| a).as_deref(),
            Some(addr),
            "观测必须进表（供对端读取）"
        );
        p2p_server::clear_reflexive_observations();
    }

    // ═══ ⑥ 断线无感重连：隧道"在用"证据 + 冷重连限频 + 源侧服务停/起后同口自愈 ═══

    /// 占一个空闲端口后立刻释放（拿来当"源设备上的目标服务端口"）。
    async fn reserve_free_port() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let p = l.local_addr().unwrap().port();
        drop(l);
        p
    }

    /// 在**指定端口**上起一个极简 HTTP 服务（答一句固定 body 后关连接）。
    async fn spawn_mock_http_on(port: u16, body: &'static str) {
        let l = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let _ = s.read(&mut buf).await;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = s.write_all(resp.as_bytes()).await;
                    let _ = s.shutdown().await;
                });
            }
        });
    }

    /// **断线无感重连（隧道半边）**：本地监听端口是长命的——
    ///   ① 源设备上那个目标服务**一开始根本没在跑**（隧道仍能建，本地口正常监听）；
    ///   ② 服务起来之后，**同一个本地端口**（同一条已建的隧道，不重开、用户不操作）
    ///      的下一次访问就通了。
    /// 这就是"源设备重启/服务恢复后页面继续可用，用户不需要点刷新"的传输层底座
    /// （每来一条浏览器连接就重新赛候选 + 重做加密握手，见 `tunnel_conn`）。
    #[tokio::test]
    async fn tunnel_local_port_self_heals_when_target_comes_back() {
        let _env = crate::test_env_lock::test_env_lock();
        clear_tunnel_authorizer();
        clear_tunnel_audit();
        test_clear_cache();
        let account = "did:youling:ReconnectAccount";
        let (sk, did) = dev(0xE9);
        test_set_identity(account, &did, [0xE9; 32]);
        p2p_server::test_seed_roster_cache(account, vec![b64(&sk.verifying_key().to_bytes())]);

        let target_port = reserve_free_port().await; // 此刻**没有**任何东西在听
        let p2p_port = spawn_p2p_server().await;
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![target_port];
        set_tunnel_authorizer(move |acc, _d, p| acc == account && p == target_port);

        let bases = vec![format!("http://127.0.0.1:{p2p_port}")];
        let local = tunnel_open_with_bases(bases, &did, "device-A", target_port)
            .await
            .expect("隧道建立不依赖目标服务是否在跑");
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(6))
            .build()
            .unwrap();

        // ① 目标服务没跑 → 本连接失败（但隧道本身还在，本地口还在听）
        let first = client
            .get(format!("http://127.0.0.1:{local}/x"))
            .send()
            .await;
        assert!(
            first.is_err() || first.unwrap().status().is_server_error(),
            "没服务时应失败"
        );
        assert_eq!(
            tunnel_local_port(&did, target_port),
            Some(local),
            "隧道不该因为一次失败就消失"
        );

        // ② 源侧服务起来（同一个端口）→ **同一个本地端口**的下一次访问必须通
        spawn_mock_http_on(target_port, "back-online").await;
        let mut ok = false;
        for _ in 0..5 {
            if let Ok(r) = client
                .get(format!("http://127.0.0.1:{local}/x"))
                .send()
                .await
            {
                if r.status() == 200 && r.text().await.unwrap_or_default() == "back-online" {
                    ok = true;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        assert!(
            ok,
            "源侧服务恢复后，同一条隧道的本地端口必须自动重新可用（无需重开/重握手以外的人工动作）"
        );

        // ③ "在用"证据：刚有连接走过 → 回收环绝不会把它当空闲抽掉
        assert!(
            tunnel_in_use(&did, target_port, 60_000),
            "刚活动过必须算在用"
        );
        assert!(
            !tunnel_in_use("did:youling:someone-else", target_port, 60_000),
            "别人的隧道不算"
        );

        assert!(tunnel_close(&did, target_port));
        assert!(
            !tunnel_in_use(&did, target_port, 60_000),
            "关掉之后不再是在用"
        );
        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
    }

    /// `TunnelStat` 的真值表（回收环判定的唯一依据）：
    /// 有活连接 → 忙；刚有过活动 → 忙；久无活动且无连接 → 闲。
    /// 这一条就是"用户正看着的页面不会被 30 分钟空闲回收抽掉端口"的守卫。
    #[test]
    fn tunnel_stat_busy_truth_table() {
        let st = TunnelStat::new();
        let now = now_ms_i64() as u64;
        // 刚建：没有活连接，但"刚刚活动过" → 仍算忙（给页面一次挂上连接的机会）
        assert!(st.busy(now, 60_000), "新建即视为近期活动");
        st.enter();
        assert!(st.busy(now + 3_600_000, 60_000), "有活连接 → 再久也算忙");
        st.leave();
        assert!(st.busy(now, 60_000), "刚结束也算活动");
        assert!(!st.busy(now + 61_000, 60_000), "无连接且超窗口 → 才算闲");
        assert!(st.busy(now + 61_000, 120_000), "窗口更大 → 仍算忙");
    }

    /// 电源护栏必须跟随 **live 连接**，不能跟随 TUNNELS 条目数：
    /// M1-2 兜底隧道 / keep 移除可能留下无主 listener；若按条目数持 SYSTEM request，
    /// myco 空闲时笔记本将永不 Modern Standby（2026-10-28 独立评审 P1 红例）。
    #[test]
    fn power_guard_follows_live_connections_not_stale_listeners() {
        let stale = TunnelStat::new();
        let active = TunnelStat::new();
        active.live.store(1, std::sync::atomic::Ordering::SeqCst);

        assert!(
            !stats_power_busy([stale.as_ref()].into_iter()),
            "空挂 listener 不得阻止睡眠"
        );
        assert!(
            stats_power_busy([stale.as_ref(), active.as_ref()].into_iter()),
            "任一活连接必须阻止睡眠"
        );
        active.live.store(0, std::sync::atomic::Ordering::SeqCst);
        assert!(
            !stats_power_busy([stale.as_ref(), active.as_ref()].into_iter()),
            "最后一条连接结束后必须释放"
        );
    }

    /// 反向腿不进 TUNNELS，但手机经 PC 反向隧道看 DSH/RDP 时同样是活数据面；
    /// 若漏进电源口径，PC idle 3 分钟仍会 Modern Standby 断网（独立复审 P1-B）。
    #[test]
    fn power_guard_counts_reverse_tunnel_live_slots() {
        // REVERSE_LIVE 是进程级计数；反向握手用例会并行真实持 guard，
        // 精确 0/1 断言必须拿全进程测试锁（独立复审阻断项）。
        let _env = crate::test_env_lock::test_env_lock();
        let stale = TunnelStat::new();
        assert_eq!(
            REVERSE_LIVE.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "测试起点必须无反向活腿"
        );
        assert!(
            !vnet_power_busy([stale.as_ref()].into_iter(), 0),
            "无反向活腿不得阻止睡眠"
        );
        {
            let _guard = ReverseLiveGuard::new();
            assert_eq!(REVERSE_LIVE.load(std::sync::atomic::Ordering::SeqCst), 1);
            assert!(
                vnet_power_busy([stale.as_ref()].into_iter(), 1),
                "任一反向已建立数据连接必须阻止睡眠"
            );
        }
        assert_eq!(
            REVERSE_LIVE.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "反向腿 Drop（含 abort）必须释放"
        );
    }

    /// 2026-10-28 04:04 真案红例：浏览器处理 363MB 下行时可能暂时停读，这是正常
    /// TCP 背压；生产写路径不得用短超时主动 RST，否则把慢消费者变成可见重连。
    #[tokio::test]
    async fn client_local_write_backpressure_stays_pending() {
        assert!(
            LOCAL_WRITE_STALL_TIMEOUT.is_none(),
            "生产路径必须保留自然背压"
        );
        let (_reader, mut writer) = tokio::io::duplex(1);
        tokio::select! {
            result = write_all_client_local(&mut writer, &[1, 2], LOCAL_WRITE_STALL_TIMEOUT) => {
                panic!("对端短暂停读时不得完成/报错，应保持背压等待，实际 {result:?}");
            }
            _ = tokio::time::sleep(Duration::from_millis(20)) => {}
        }
    }

    /// 泵级红例：直接驱动 `pump_down_client`，防止未来绕过
    /// `LOCAL_WRITE_STALL_TIMEOUT`/helper 在泵内内联短超时。慢本地消费者
    /// 应保持 pending，不完成、不报错、不关闭。
    #[tokio::test]
    async fn pump_down_client_preserves_slow_consumer_backpressure() {
        let ct_c = X25519Public::from(&X25519Secret::from([1u8; 32])).to_bytes();
        let ct_s = X25519Public::from(&X25519Secret::from([2u8; 32])).to_bytes();
        let hs = hs_json("acct", "dev", 13911, "tn-backpressure");
        let client_io = FrameIo::new(
            SessionKeys::derive(&X25519Secret::from([1u8; 32]), &ct_s, &ct_c, &ct_s, &hs).unwrap(),
            TunnelRole::Originator,
            &hs,
        );
        let mut server_io = FrameIo::new(
            SessionKeys::derive(&X25519Secret::from([2u8; 32]), &ct_c, &ct_c, &ct_s, &hs).unwrap(),
            TunnelRole::Responder,
            &hs,
        );
        let frame = server_io.seal(&[1, 2, 3]);
        let mut frames = futures_util::stream::iter(vec![Ok(TMessage::Binary(frame))]);
        let (_reader, mut writer) = tokio::io::duplex(1);
        let layer = PumpLayer::new(client_io);
        tokio::select! {
            result = pump_down_client(&mut frames, &mut writer, &layer) => {
                panic!("慢本地消费者不得触发泵完成/报错，应保留背压，实际 {result:?}");
            }
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
    }

    /// 显式传入短超时的 helper 行为仍必须有界，供未来运维开关/诊断复用。
    #[tokio::test]
    async fn client_local_write_explicit_timeout_is_bounded() {
        let (_reader, mut writer) = tokio::io::duplex(1);
        let result =
            write_all_client_local(&mut writer, &[1, 2], Some(Duration::from_millis(20))).await;
        match result {
            Err(FrameError::Io(e)) => assert_eq!(e, "local-write-stall"),
            other => panic!(
                "显式超时的本地写必须 fail-fast，实际 {:?}",
                other.map(|_| ())
            ),
        }
    }

    /// 未建隧道时 `tunnel_in_use` 必须 false（回收环据此把自己表里的死记录摘掉）。
    #[test]
    fn tunnel_in_use_false_when_absent() {
        assert!(!tunnel_in_use("did:youling:nobody", 13911, 60_000));
        assert!(tunnel_local_port("did:youling:nobody", 13911).is_none());
    }

    /// 冷重连限频：`REFRESH_MIN_INTERVAL_MS` 内第二次刷新必须被挡掉
    /// （对端真离线时不能每条浏览器连接都白等一轮网络）。
    /// 只测限频闸本身（第一次调用会去打 presence，返回 None 也无所谓——
    /// 关键是第二次**一定**因限频而 None，不产生网络动作）。
    #[tokio::test]
    async fn candidate_refresh_is_throttled() {
        let did = format!("did:youling:throttle-{}", now_ms_i64());
        // 预热限频表（不走网络：直接登记一次"刚刷新过"）
        LAST_REFRESH
            .lock()
            .unwrap()
            .insert(did.clone(), std::time::Instant::now());
        assert!(
            refresh_candidates_throttled(&did).await.is_none(),
            "10s 内第二次刷新必须被限频挡掉"
        );
    }

    // ═══ ⑨ 云端中继（relay.mjs 的对拍 E2E + 单元） ═══

    /// 极简测试中继（与 services/identity-svc/relay.mjs 同协议）：
    /// REGISTER → OK + 入表；CONNECT → 向 provider 控制连发 SESSION；新连接
    /// ACCEPT → 回 consumer OK 并双向对接。控制连的写半区经 mpsc 转发（免锁跨 await）。
    async fn spawn_test_relay() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        // did → 控制连"发信通道"（任务持有写半区，通道送 SESSION 行）
        let providers: Arc<
            Mutex<std::collections::HashMap<String, tokio::sync::mpsc::UnboundedSender<String>>>,
        > = Arc::new(Mutex::new(std::collections::HashMap::new()));
        // sid → 等配对的 consumer
        let pending: Arc<Mutex<std::collections::HashMap<String, TcpStream>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        let sid_seq = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let pv = providers.clone();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let providers = pv.clone();
                let pending = pending.clone();
                let sid_seq = sid_seq.clone();
                tokio::spawn(async move {
                    let mut sock = sock;
                    // 读首行（字节级——绝不消费 '\n' 之后的数据，与产线中继同约束）
                    let mut line = Vec::new();
                    let mut b = [0u8; 1];
                    loop {
                        match sock.read(&mut b).await {
                            Ok(0) => return,
                            Ok(_) if b[0] == b'\n' => break,
                            Ok(_) => {
                                line.push(b[0]);
                                if line.len() > 512 {
                                    return;
                                }
                            }
                            Err(_) => return,
                        }
                    }
                    let l = String::from_utf8_lossy(&line).to_string();
                    let (cmd, rest) = l.split_once(' ').unwrap_or((l.as_str(), ""));
                    match cmd {
                        "REGISTER" => {
                            let _ = sock.write_all(b"OK\n").await;
                            let (mut r, mut w) = sock.into_split();
                            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
                            // 排水读半区（心跳/对端关闭）+ 转发写半区
                            tokio::spawn(async move {
                                let mut buf = [0u8; 64];
                                loop {
                                    tokio::select! {
                                        n = r.read(&mut buf) => {
                                            match n {
                                                Ok(0) | Err(_) => break,
                                                Ok(_) => {}
                                            }
                                        }
                                        m = rx.recv() => {
                                            match m {
                                                Some(s) => {
                                                    if w.write_all(s.as_bytes()).await.is_err() {
                                                        break;
                                                    }
                                                }
                                                None => break,
                                            }
                                        }
                                    }
                                }
                            });
                            providers
                                .lock()
                                .unwrap()
                                .insert(rest.trim().to_string(), tx);
                        }
                        "ACCEPT" => {
                            let Some((_did, sid)) = rest.trim().split_once(' ') else {
                                return;
                            };
                            let consumer = pending.lock().unwrap().remove(sid);
                            if let Some(mut consumer) = consumer {
                                let _ = consumer.write_all(b"OK\n").await;
                                let _ =
                                    tokio::io::copy_bidirectional(&mut sock, &mut consumer).await;
                            }
                        }
                        "CONNECT" => {
                            let target = rest.trim().to_string();
                            let tx = providers.lock().unwrap().get(&target).cloned();
                            let Some(tx) = tx else {
                                let _ = sock.write_all(b"NOT_FOUND\n").await;
                                return;
                            };
                            let sid = format!(
                                "t{}",
                                sid_seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                            );
                            if tx.send(format!("SESSION {sid}\n")).is_err() {
                                let _ = sock.write_all(b"NOT_FOUND\n").await;
                                return;
                            }
                            pending.lock().unwrap().insert(sid.clone(), sock);
                            // 超时兜底：没人接单就放掉（防泄漏挂死）
                            let sid2 = sid;
                            tokio::spawn(async move {
                                tokio::time::sleep(Duration::from_secs(10)).await;
                                let s = pending.lock().unwrap().remove(&sid2); // guard 不跨 await
                                if let Some(mut s) = s {
                                    let _ = s.write_all(b"UNAVAILABLE\n").await;
                                }
                            });
                        }
                        _ => {}
                    }
                });
            }
        });
        port
    }

    /// relay_addr 解析真值表（base_host_port_opt 纯函数口径）。
    #[test]
    fn relay_host_parsing_shapes() {
        let hp = |s: &str| base_host_port_opt(s);
        assert_eq!(
            hp("https://myco.youling.cc/myco-id"),
            Some(("myco.youling.cc".into(), None))
        );
        assert_eq!(
            hp("http://myco.youling.cc:8321"),
            Some(("myco.youling.cc".into(), Some(8321)))
        );
        assert_eq!(
            hp("myco.youling.cc:8322"),
            Some(("myco.youling.cc".into(), Some(8322)))
        );
        assert_eq!(
            hp("myco.youling.cc"),
            Some(("myco.youling.cc".into(), None))
        );
        assert_eq!(
            hp("http://[240e:xx::1]:9100/x"),
            Some(("240e:xx::1".into(), Some(9100)))
        );
        assert_eq!(hp(""), None);
        // env 推导链在测试态被禁（TEST_RELAY_ADDR 单一来源——单测不触网）
        assert!(relay_addr().is_none(), "测试态未注入时中继地址必须是 None");
    }

    /// **中继 E2E（直连候选全空 = 双方都在 NAT 后的模拟）**：
    /// provider 注册测试中继 → consumer `tunnel_open_with_bases(空)` → 中继腿赢 →
    /// WS 升级/验签/授权/AEAD 全链走通 → HTTP 经中继隧道取回目标端响应体。
    #[tokio::test]
    async fn tunnel_via_cloud_relay_when_no_direct_candidates() {
        let _env = crate::test_env_lock::test_env_lock();
        clear_tunnel_authorizer();
        clear_tunnel_audit();
        test_clear_cache();
        let account = "did:youling:RelayE2EAccount";
        let (sk, did) = dev(0xE2);
        test_set_identity(account, &did, [0xE2; 32]);
        p2p_server::test_seed_roster_cache(account, vec![b64(&sk.verifying_key().to_bytes())]);

        // 目标端（PC 侧的"分享网关"等价物）+ 真 p2p 服务器（provider 的会话上游）
        let body = "hello-through-cloud-relay";
        let http_port = spawn_mock_http(body).await;
        let p2p_port = spawn_p2p_server().await;
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![http_port];
        set_tunnel_authorizer(move |acc, _d, p| acc == account && p == http_port);

        // 测试中继 + provider 常驻（注册 did，接单接进测试 p2p 服务器）
        let relay_port = spawn_test_relay().await;
        test_set_relay_addr(Some(("127.0.0.1".to_string(), relay_port)));
        let provider_did = did.clone();
        let provider_task = tokio::spawn(async move {
            // 返回即控制连结束；测试期间它一直挂着（等 SESSION 接单）
            relay_provider_session_to(p2p_port, &provider_did).await
        });
        // 等 REGISTER 落表（中继侧毫秒级，稳一点）
        tokio::time::sleep(Duration::from_millis(150)).await;

        // consumer：空候选 + 中继腿 → 必须建得起来（直连 0 候选的"热点拓扑"）
        let t0 = std::time::Instant::now();
        let local = tunnel_open_with_bases(Vec::new(), &did, "device-relay", http_port)
            .await
            .expect("空直连候选时，云端中继腿必须兜底建隧道");
        println!(
            "[relay-e2e] 空候选 → 中继建隧道 {:.1}ms（本地 :{local}）",
            t0.elapsed().as_secs_f64() * 1000.0
        );

        let resp = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap()
            .get(format!("http://127.0.0.1:{local}/any/path"))
            .send()
            .await
            .expect("经中继隧道取 HTTP 失败");
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.text().await.unwrap(),
            body,
            "经中继回来的必须是目标端响应体"
        );

        // 审计：走的是真 /p2p/tunnel 端点（验签/授权全过）
        assert!(
            tunnel_audit_recent()
                .iter()
                .any(|a| a.result == "upgraded" && a.port == http_port),
            "中继会话必须过真实的隧道端点闸门: {:?}",
            tunnel_audit_recent()
        );

        // 强制直连：中继腿禁用 → 空候选必须失败（回到 ⑨ 之前的行为）
        test_set_force_direct(Some(true));
        let forced = tunnel_open_with_bases(Vec::new(), &did, "device-relay", http_port).await;
        assert!(forced.is_err(), "强制直连 + 空候选必须失败（不悄悄走中继）");
        test_set_force_direct(None);

        // 收尾：关隧道 + 中继地址/身份复位（别污染其他用例）
        assert!(tunnel_close(&did, http_port));
        test_set_relay_addr(None);
        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
        provider_task.abort();
    }

    /// **固定口漂移回归（用户真机事故）**：先按随机口建好隧道（= 重启恢复出来的
    /// 57811），用户再 `keep {localPort:L}`（= [`set_preferred_local`]）——重开必须
    /// **关掉旧随机口监听、在 L 上重绑**；旧实现会走"已有隧道直接返回"，把旧随机口
    /// 当成功返回，L 永远不 LISTEN（.rdp 写死 23389 → mstsc 0x204）。
    #[tokio::test]
    async fn fixed_local_rebinds_drifted_tunnel() {
        let _env = crate::test_env_lock::test_env_lock();
        clear_tunnel_authorizer();
        clear_tunnel_audit();
        test_clear_cache();
        let account = "did:youling:FixedPortReorder";
        let (sk, did) = dev(0xF2);
        test_set_identity(account, &did, [0xF2; 32]);
        p2p_server::test_seed_roster_cache(account, vec![b64(&sk.verifying_key().to_bytes())]);
        let target_port = reserve_free_port().await;
        let p2p_port = spawn_p2p_server().await;
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![target_port];
        set_tunnel_authorizer(move |acc, _d, p| acc == account && p == target_port);
        let bases = vec![format!("http://127.0.0.1:{p2p_port}")];

        // ① 首建（无固定口）→ 随机口（≈事故现场重启恢复出来的 57811）
        let first = tunnel_open_with_bases(bases.clone(), &did, "device-A", target_port)
            .await
            .expect("首建隧道");
        assert_ne!(first, target_port);

        // ② 用户 keep{localPort:L}
        let want = reserve_free_port().await;
        assert_ne!(want, first, "固定口不能恰好等于旧随机口（否则测不出漂移）");
        assert_ne!(want, target_port);
        set_preferred_local(&did, target_port, Some(want));

        // ③ 重开：必须落在固定口（原实现会直接把 first 当成功返回）
        let second = tunnel_open_with_bases(bases.clone(), &did, "device-A", target_port)
            .await
            .expect("按固定口重绑");
        assert_eq!(second, want, "keep 之后必须监听约定固定口，而不是旧随机口");
        assert_eq!(tunnel_local_port(&did, target_port), Some(want));

        // ④ 旧随机口的监听必须已关闭（abort 旧接受循环）
        let mut closed = false;
        for _ in 0..20 {
            if tokio::net::TcpStream::connect(("127.0.0.1", first))
                .await
                .is_err()
            {
                closed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(closed, "旧随机口 :{first} 的监听必须关闭");

        // ⑤ 幂等：再次调用仍是同一口（不重建、不换口）
        let third = tunnel_open_with_bases(bases.clone(), &did, "device-A", target_port)
            .await
            .expect("幂等重开");
        assert_eq!(third, want, "重复调用必须幂等返回固定口");

        assert!(tunnel_close(&did, target_port));
        set_preferred_local(&did, target_port, None);
        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
    }

    /// **并发安全（F1）**：同一 (device,port) 6 个并发 opener → 只产生**一条**隧道，
    /// 且全部返回约定固定口（幂等）。旧实现无互斥：后一个 opener 关掉前一个的监听再
    /// 抢口，前一个还没释放 → bind 固定口失败 → 回落随机口（正是漂移事故的并发版）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_fixed_port_opens_create_one_tunnel() {
        let _env = crate::test_env_lock::test_env_lock();
        clear_tunnel_authorizer();
        clear_tunnel_audit();
        test_clear_cache();
        let account = "did:youling:FixedPortConcurrent";
        let (sk, did) = dev(0xF3);
        test_set_identity(account, &did, [0xF3; 32]);
        p2p_server::test_seed_roster_cache(account, vec![b64(&sk.verifying_key().to_bytes())]);
        let target_port = reserve_free_port().await;
        let p2p_port = spawn_p2p_server().await;
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![target_port];
        set_tunnel_authorizer(move |acc, _d, p| acc == account && p == target_port);
        let bases = vec![format!("http://127.0.0.1:{p2p_port}")];
        let want = reserve_free_port().await;
        set_preferred_local(&did, target_port, Some(want));

        let mut hs = Vec::new();
        for _ in 0..6 {
            let bases = bases.clone();
            let did2 = did.clone();
            hs.push(tokio::spawn(async move {
                tunnel_open_with_bases(bases, &did2, "device-A", target_port).await
            }));
        }
        let mut ports = Vec::new();
        for h in hs {
            ports.push(h.await.expect("join").expect("并发开隧道必须成功"));
        }
        assert!(
            ports.iter().all(|p| *p == want),
            "所有调用必须落在约定固定口 :{want}: {ports:?}"
        );
        let n = tunnel_list_snapshot()
            .iter()
            .filter(|(d, p, _)| d == &did && *p == target_port)
            .count();
        assert_eq!(n, 1, "同一 (device,port) 只允许一条隧道（幂等）");
        assert_eq!(tunnel_local_port(&did, target_port), Some(want));

        assert!(tunnel_close(&did, target_port));
        set_preferred_local(&did, target_port, None);
        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
    }

    /// 中继的**拒绝路径**：目标 did 未注册 → NOT_FOUND（provider 离线时的人话源头）。
    #[tokio::test]
    async fn relay_connect_not_found_for_unregistered_device() {
        let _env = crate::test_env_lock::test_env_lock();
        clear_tunnel_authorizer();
        test_clear_cache();
        let relay_port = spawn_test_relay().await;
        test_set_relay_addr(Some(("127.0.0.1".to_string(), relay_port)));
        let err = relay_connect("did:myco:zNobodyRegistered", 13911)
            .await
            .expect_err("未注册设备必须失败");
        assert!(err.contains("未注册中继"), "人话可读的失败原因: {err}");
        test_set_relay_addr(None);
    }

    // ══ task-20（AOP Phase 1）：S 持久化 / C 网络识别 / D 缓存路由优先 单测 ══

    fn tmp_ctx_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "vnet-ctx-{}-{}-{}.json",
            tag,
            std::process::id(),
            now_ms_i64()
        ))
    }

    /// C 层：网络指纹派生（IPv6 前 3 段优先；退 IPv4 /24；回环/链路本地不算；多接口按序）。
    #[test]
    fn network_id_prefers_ipv6_prefix_then_ipv4_subnet() {
        let v6 = vec![
            "3fff:390:a95:62c0:45cd:b9bf:81ee:fa06".to_string(),
            "fe80::1".to_string(),
        ];
        let v4 = vec!["192.168.1.31".to_string()];
        assert_eq!(
            network_id_from_addrs(&v6, &v4),
            "3fff:390:a95",
            "优先 IPv6 前 3 段"
        );
        assert_eq!(
            network_id_from_addrs(&["fe80::1".into(), "::1".into()], &v4),
            "192.168.1",
            "IPv6 不可用退 IPv4 /24"
        );
        assert_eq!(
            network_id_from_addrs(&[], &["127.0.0.1".into(), "169.254.3.4".into()]),
            "unknown",
            "回环/链路本地不算网络"
        );
        // 多接口：第一个可用 IPv6 前缀胜出（顺序即优先级）
        assert_eq!(
            network_id_from_addrs(
                &["3fff:390:a95:1::1".into(), "3ffd:8a00:1234::1".into()],
                &[]
            ),
            "3fff:390:a95"
        );
        assert_eq!(
            ipv6_prefix("[3fff:390:a95:62c0::1]"),
            Some("3fff:390:a95".into())
        );
        assert_eq!(ipv4_subnet("10.20.30.40"), Some("10.20.30".into()));
        assert_eq!(ipv4_subnet("127.0.0.1"), None);
        assert_eq!(ipv6_prefix("::1"), None);
    }

    /// S 层：落盘 round-trip + ≤16 槽 LRU 淘汰（最旧 last_active 先走）。
    #[test]
    fn s_layer_roundtrip_and_lru_16() {
        let _env = crate::test_env_lock::test_env_lock();
        test_reset_network_contexts();
        // ① round-trip：存 3 个上下文（含一条路由）→ 读回逐字段一致
        let mut ctxs: Vec<NetworkContext> = (0..3)
            .map(|i| NetworkContext::new(&format!("net-{i}"), 1000 + i as u64))
            .collect();
        ctxs[0].peer_routes.insert(
            "did:myco:zA".into(),
            PeerRoute {
                preferred_base: "ws://[3fff:390:a95:1::2]:9100".into(),
                preferred_mode: "direct".into(),
                kind: "ipv6_stable".into(),
                peer_listen_port: 9100,
                rtt_ms: 27,
                success_count: 2,
                fail_count: 0,
                cooldown_until: 0,
                last_used: 1000,
            },
        );
        let path = tmp_ctx_path("rt");
        save_contexts_to_path(&path, &ctxs).expect("save");
        let loaded = load_contexts_from_path(&path);
        assert_eq!(loaded, ctxs, "S 层 JSON round-trip 必须逐字段一致");
        // 坏文件 → 空（降级，不 panic）
        std::fs::write(&path, b"{not-json").unwrap();
        assert!(
            load_contexts_from_path(&path).is_empty(),
            "坏文件必须降级为空"
        );
        let _ = std::fs::remove_file(&path);
        // ② LRU：20 个槽（last_active 递增）→ 只留 16，最旧先淘汰
        test_reset_network_contexts();
        let all: Vec<NetworkContext> = (0..20)
            .map(|i| NetworkContext::new(&format!("net-{i:02}"), 1000 + i as u64))
            .collect();
        {
            let mut g = NET_CTX.lock().unwrap();
            g.loaded = true;
            for c in &all {
                g.contexts
                    .insert(c.network_id.clone(), Arc::new(Mutex::new(c.clone())));
            }
            while g.contexts.len() > NET_CTX_MAX {
                let victim = pick_lru_victim(&g, "").expect("victim");
                g.contexts.remove(&victim);
            }
            assert_eq!(g.contexts.len(), NET_CTX_MAX, "LRU 上限 16 槽");
            assert!(!g.contexts.contains_key("net-00"), "最旧上下文必须被淘汰");
            assert!(g.contexts.contains_key("net-19"), "最新上下文必须保留");
        }
        test_reset_network_contexts();
    }

    /// D 层判定核 + 冷却生命周期：连续 3 次失败 → 冷却 300s → 期内不可缓存 → 过期恢复 → 成功清零。
    #[test]
    fn route_cacheable_and_cooldown_lifecycle() {
        let _env = crate::test_env_lock::test_env_lock();
        test_reset_network_contexts();
        let dev = "did:myco:zCooldownUnit";
        let base = "ws://[3fff:390:a95:62c0:45cd:b9bf:81ee:fa06]:9100";
        assert!(
            !PeerRoute::default().cacheable(now_ms_i64().max(0) as u64),
            "空路由不可缓存"
        );
        update_route_success(dev, base, 27);
        let now = now_ms_i64().max(0) as u64;
        {
            let ctx = current_context();
            let c = ctx.lock().unwrap();
            let r = c.peer_routes.get(dev).expect("route");
            assert!(r.cacheable(now), "成功路由应可缓存");
            assert_eq!(r.rtt_ms, 27);
            assert_eq!(r.preferred_mode, "direct");
        }
        for _ in 0..ROUTE_COOLDOWN_FAILS {
            update_route_fail(dev, base);
        }
        let now = now_ms_i64().max(0) as u64;
        {
            let ctx = current_context();
            let c = ctx.lock().unwrap();
            let r = c.peer_routes.get(dev).expect("route");
            assert!(
                r.cooldown_until > now,
                "连续失败 {ROUTE_COOLDOWN_FAILS} 次必须进入冷却"
            );
            assert!(!r.cacheable(now), "冷却中不得走缓存路由");
            assert!(r.cacheable(r.cooldown_until + 1), "冷却过期必须恢复可缓存");
        }
        update_route_success(dev, base, 12);
        {
            let ctx = current_context();
            let c = ctx.lock().unwrap();
            let r = c.peer_routes.get(dev).expect("route");
            assert_eq!(r.cooldown_until, 0, "成功必须清零冷却");
            assert_eq!(r.fail_count, 0, "成功必须清零失败计数");
        }
        test_reset_network_contexts();
    }

    /// D 层：有缓存路由时**单拨缓存 base**（不并发赛跑；对端只看到 1 条 upgraded、0 取消）。
    #[tokio::test]
    async fn d_layer_cache_route_single_dial_when_available() {
        let _env = crate::test_env_lock::test_env_lock();
        clear_tunnel_authorizer();
        test_clear_cache();
        test_reset_network_contexts();
        let (account, sk, did) = race_acct();
        test_set_identity(account, &did, [0x71; 32]);
        let target_port = 19141u16;
        let p2p_port = spawn_ready_p2p(account, &sk, vec![target_port]).await;
        let good = format!("ws://127.0.0.1:{p2p_port}/p2p/tunnel?v=2");
        let black = spawn_blackhole().await;
        let dead = format!("ws://127.0.0.1:{black}/p2p/tunnel?v=2");
        // S 层预置：该设备缓存路由 = good
        update_route_success(&did, &good, 12);
        clear_tunnel_audit();
        let (cache_hits0, _, _) = route_hit_stats();
        // bases[0] 故意放死地址：若走探索赛跑会去拨它；缓存路由优先则只拨 good
        let got = dial_with_context(
            &did,
            &[dead.clone(), good.clone()],
            target_port,
            ROUTE_EXPLORE_DIAL_TIMEOUT,
            RACE_TOTAL_BUDGET,
            None,
            None,
        )
        .await
        .expect("缓存路由必须直接成功");
        assert_eq!(got.0, good, "必须走 S 层缓存路由（而非探索赛跑）");
        drop(got);
        tokio::time::sleep(Duration::from_millis(350)).await;
        let audits = tunnel_audit_recent();
        assert_eq!(
            audits.iter().filter(|a| a.result == "upgraded").count(),
            1,
            "缓存命中只拨 1 条上游（赛跑会并发拨多候选）: {audits:?}"
        );
        assert_eq!(audits.iter().filter(|a| a.result == "enc-fail").count(), 0);
        let (cache_hits1, _, _) = route_hit_stats();
        assert_eq!(
            cache_hits1,
            cache_hits0 + 1,
            "audit vnet-route-hit source=cache 计数"
        );
        {
            let ctx = current_context();
            let c = ctx.lock().unwrap();
            let r = c.peer_routes.get(&did).expect("route");
            assert_eq!(r.preferred_base, good, "S 层首选路由写回");
            assert!(r.success_count >= 2, "S 层成功计数写回");
        }
        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
        test_reset_network_contexts();
    }

    /// D 层：无缓存路由 → 探索赛跑，成功后写回 S（下次可命中缓存）。
    #[tokio::test]
    async fn d_layer_explores_when_no_route() {
        let _env = crate::test_env_lock::test_env_lock();
        clear_tunnel_authorizer();
        test_clear_cache();
        test_reset_network_contexts();
        let (account, sk, did) = race_acct();
        test_set_identity(account, &did, [0x71; 32]);
        let target_port = 19142u16;
        let p2p_port = spawn_ready_p2p(account, &sk, vec![target_port]).await;
        let good = format!("ws://127.0.0.1:{p2p_port}/p2p/tunnel?v=2");
        let black = spawn_blackhole().await;
        let slow = format!("ws://127.0.0.1:{black}/p2p/tunnel?v=2");
        let got = dial_with_context(
            &did,
            &[slow, good.clone()],
            target_port,
            Duration::from_millis(500),
            RACE_TOTAL_BUDGET,
            None,
            None,
        )
        .await
        .expect("探索路径应成功");
        assert_eq!(got.0, good);
        drop(got);
        {
            let ctx = current_context();
            let c = ctx.lock().unwrap();
            let r = c.peer_routes.get(&did).expect("探索成功必须写回 S 层路由");
            assert_eq!(r.preferred_base, good);
        }
        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
        test_reset_network_contexts();
    }
}

// ══════════════════ ⑧ 反向连接单测（测试即规格） ══════════════════
//
// 核心用例：`reverse_connect_slot`（被测，PC=发起方）↔ 测试内手写的"手机服务端"
// （TcpListener + `accept_hdr_async` 捕获升级头 + responder 加密握手 + echo 泵）。
// 断言四层：① 升级头形状（信封 v/port/account/device/origin + 签名可验过——手机侧
// acceptTunnel 闸门的 Rust 镜像）；② v2 加密握手角色互换（我们 originator、对端
// responder）；③ 双向数据（本机 echo 服务 ↔ 隧道 ↔ "手机"）；④ want 行解析闸门。
#[cfg(test)]
mod reverse_tests {
    use super::*;
    use crate::p2p_server;
    use tokio_tungstenite::tungstenite::handshake::server::Response;

    fn dev(tag: u8) -> (ed25519_dalek::SigningKey, String) {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[tag; 32]);
        let did = myco_core::identity::did_from_public(&sk.verifying_key().to_bytes());
        (sk, did)
    }

    /// 本机 echo 服务（替身 13911 网关）：收什么回什么。返回 (端口, 收到的明文)。
    async fn spawn_echo() -> (u16, Arc<Mutex<Vec<Vec<u8>>>>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let seen: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_task = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                let seen = seen_task.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    loop {
                        match s.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                seen.lock().unwrap().push(buf[..n].to_vec());
                                let _ = s.write_all(&buf[..n]).await;
                            }
                        }
                    }
                });
            }
        });
        (port, seen)
    }

    /// "手机服务端"：验升级头（信封 + 签名——手机侧闸门的镜像）→ responder 加密握手
    /// → 隧道帧 ↔ 明文通道。返回 (监听端口, 手机收到的明文, 让手机发送明文的通道)。
    async fn spawn_phone_server(
        expect_did: String,
        expect_port: u16,
    ) -> (
        u16,
        tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
        tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    ) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let (plain_tx, plain_rx) = tokio::sync::mpsc::unbounded_channel();
        let (send_tx, mut send_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let expect = (expect_did, expect_port);
        tokio::spawn(async move {
            let (stream, _) = l.accept().await.expect("手机端应收到反向连接");
            let mut envelope_raw = String::new();
            let mut auth_raw = String::new();
            let mut path_ok = false;
            let cb = |req: &tokio_tungstenite::tungstenite::http::Request<()>,
                      resp: Response|
             -> Result<
                Response,
                tokio_tungstenite::tungstenite::handshake::server::ErrorResponse,
            > {
                path_ok = req.uri().path() == "/p2p/tunnel"
                    && req
                        .uri()
                        .query()
                        .map(|q| q.contains("v=2"))
                        .unwrap_or(false);
                envelope_raw = req
                    .headers()
                    .get(TUNNEL_HANDSHAKE_HEADER)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                auth_raw = req
                    .headers()
                    .get("x-myco-auth")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                Ok(resp)
            };
            let ws = tokio_tungstenite::accept_hdr_async(stream, cb)
                .await
                .expect("WS 升级应成功");
            // ① 信封与签名（镜像手机侧 acceptTunnel 的闸门）
            assert!(path_ok, "请求必须打 /p2p/tunnel?v=2");
            let hs: TunnelHandshake =
                serde_json::from_str(&envelope_raw).expect("信封必须是合法 JSON");
            assert_eq!(hs.v, TUNNEL_PROTOCOL_VERSION);
            assert_eq!(hs.port, expect.1, "信封 port = 本机要暴露的目标端口");
            assert!(
                myco_core::identity::did_equiv(&hs.device, &expect.0),
                "信封 device = 本机设备"
            );
            assert!(
                myco_core::identity::did_equiv(&hs.origin, &expect.0),
                "信封 origin = 本机设备"
            );
            assert!(!hs.nonce.is_empty(), "nonce 必须非空（重放去重键）");
            let parts: Vec<&str> = auth_raw.splitn(3, '.').collect();
            assert_eq!(parts.len(), 3, "x-myco-auth 形状 did.ts.sig");
            let (adid, ats, asig) = (parts[0], parts[1], parts[2]);
            assert!(
                myco_core::identity::did_equiv(adid, &expect.0),
                "签名者 = 本机设备"
            );
            let ts: i64 = ats.parse().unwrap();
            let now = chrono::Utc::now().timestamp_millis();
            assert!((now - ts).abs() < 60_000, "签名时间窗 ±60s");
            let sig_bytes = base64::engine::general_purpose::STANDARD
                .decode(asig)
                .unwrap();
            let vk = ed25519_dalek::VerifyingKey::from_bytes(
                &myco_core::identity::did_pubkey_bytes(adid).expect("did 应能解出公钥"),
            )
            .unwrap();
            use ed25519_dalek::Verifier as _;
            vk.verify(
                format!("{adid}\n{ats}\n{envelope_raw}").as_bytes(),
                &ed25519_dalek::Signature::from_slice(&sig_bytes).unwrap(),
            )
            .expect("设备签名必须验过（手机侧最硬的闸）");
            // ② responder 加密握手（收 HELLO → 回 HELLO_ACK → 发 CONFIRM → 收 CONFIRM）
            let mut ws = ws;
            let f1 = loop {
                match ws.next().await {
                    Some(Ok(TMessage::Binary(d))) => break d,
                    Some(Ok(TMessage::Close(_))) | None => panic!("握手期间不应断开"),
                    Some(Err(e)) => panic!("握手读失败：{e}"),
                    Some(Ok(_)) => continue,
                }
            };
            let ct_client = parse_hello(&f1).expect("HELLO 帧合法");
            let (my_priv, my_pub) = gen_ephemeral();
            ws.send(TMessage::Binary(hello_frame(&my_pub)))
                .await
                .unwrap();
            let keys =
                SessionKeys::derive(&my_priv, &ct_client, &ct_client, &my_pub, &envelope_raw)
                    .unwrap();
            let mut io = FrameIo::new(keys, TunnelRole::Responder, &envelope_raw);
            ws.send(TMessage::Binary(io.confirm_frame())).await.unwrap();
            let f2 = loop {
                match ws.next().await {
                    Some(Ok(TMessage::Binary(d))) => break d,
                    Some(Ok(TMessage::Close(_))) | None => panic!("握手期间不应断开"),
                    Some(Err(e)) => panic!("握手读失败：{e}"),
                    Some(Ok(_)) => continue,
                }
            };
            io.accept_confirm(&f2).expect("对端 CONFIRM 必须验过");
            // ③ echo 泵：隧道帧 ↔ 明文通道（手机收到的 = 解密上行；手机发的 = 加密下行）
            let (mut tx, mut rx) = ws.split();
            loop {
                tokio::select! {
                    m = rx.next() => match m {
                        Some(Ok(TMessage::Binary(d))) => {
                            if let Ok(pt) = io.open(&d) {
                                let _ = plain_tx.send(pt);
                            }
                        }
                        Some(Ok(TMessage::Close(_))) | None | Some(Err(_)) => break,
                        Some(Ok(_)) => {}
                    },
                    pt = send_rx.recv() => match pt {
                        Some(pt) => {
                            let _ = tx.send(TMessage::Binary(io.seal(&pt))).await;
                        }
                        None => break,
                    },
                }
            }
        });
        (port, plain_rx, send_tx)
    }

    /// **核心**：反向隧道全链——PC 发起拨号（被测 `reverse_connect_slot`）→
    /// "手机服务端"（上方替身）验签 + responder 握手 → 本机 echo 服务双向数据。
    #[tokio::test]
    async fn reverse_tunnel_handshake_with_phone_server_role() {
        let _env = crate::test_env_lock::test_env_lock();
        clear_tunnel_authorizer();
        test_clear_cache();
        let (account, _sk, did) = {
            let (sk, did) = dev(0x91);
            ("did:youling:ReverseAccount", sk, did)
        };
        test_set_identity(account, &did, [0x91; 32]);
        let (echo_port, echo_seen) = spawn_echo().await;
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![echo_port];
        let (phone_port, mut plain_rx, plain_tx) = spawn_phone_server(did.clone(), echo_port).await;

        let bases = vec![format!("ws://127.0.0.1:{phone_port}/p2p/tunnel?v=2")];
        let slot = tokio::spawn(async move { reverse_connect_slot(bases, echo_port, "test-viewer").await });
        // 手机发一段明文 → 应原样到本机 echo（上行）→ echo 回 → 隧道回手机（下行）。
        let probe = b"GET /gw/sh-1/ HTTP/1.1\r\n\r\n".to_vec();
        let mut ok = false;
        for _ in 0..50 {
            let _ = plain_tx.send(probe.clone());
            if let Ok(Some(got)) =
                tokio::time::timeout(Duration::from_millis(200), plain_rx.recv()).await
            {
                if got == probe {
                    ok = true;
                    break;
                }
            }
        }
        assert!(ok, "手机→echo→手机 的完整往返必须通（反向隧道双向数据）");
        assert_eq!(
            echo_seen.lock().unwrap()[0],
            probe,
            "上行明文必须原样到达本机目标端口"
        );
        slot.abort();
        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
    }

    /// 反向模式的端口闸：非白名单端口直接人话拒绝（不触网）。
    #[tokio::test]
    async fn reverse_open_rejects_non_whitelisted_port() {
        let err = tunnel_open_reverse("did:myco:zPhoneDev", 12345, 1)
            .await
            .unwrap_err();
        assert!(err.contains("白名单"), "人话错误应点名白名单：{err}");
    }

    /// 停拨未知设备 → false（幂等语义）。
    #[test]
    fn reverse_stop_unknown_device_is_false() {
        assert!(!tunnel_reverse_stop("did:myco:zNobody"));
    }

    /// want 行解析闸门（p2p_client 的纯函数）：kind=phone、白名单端口、有地址、
    /// 非本机设备；**canonical 双前缀互认**、单值 ipv6 键也认；legacy 已废止（不再互认）。
    #[test]
    fn reverse_want_rows_gates() {
        let (me_sk, me_did) = dev(0x51);
        let (phone_sk, phone_did) = dev(0x52);
        let rows = vec![
            // 合法：手机 + wantReverse 13911 + ipv6
            serde_json::json!({
                "did": phone_did, "kind": "phone", "rootDid": "did:youling:zAcc",
                "addrs": { "ipv6List": ["3fff:471:900::1"], "port": 5555, "wantReverse": 13911 }
            }),
            // kind 不对（pc）——正向寻址的行，反向不认
            serde_json::json!({
                "did": me_did, "kind": "pc", "rootDid": "did:youling:zAcc",
                "addrs": { "ipv6List": ["3fff::9"], "port": 5555, "wantReverse": 13911 }
            }),
            // wantReverse 端口不在白名单（3102 管理面——绝不放行）
            serde_json::json!({
                "did": "did:myco:zOther", "kind": "phone", "rootDid": "did:youling:zAcc",
                "addrs": { "ipv6List": ["3fff::8"], "port": 5555, "wantReverse": 3102 }
            }),
            // 无可拨地址
            serde_json::json!({
                "did": "did:myco:zOther", "kind": "phone", "rootDid": "did:youling:zAcc",
                "addrs": { "wantReverse": 13911 }
            }),
            // 缺监听端口
            serde_json::json!({
                "did": "did:myco:zOther", "kind": "phone", "rootDid": "did:youling:zAcc",
                "addrs": { "ipv6List": ["3fff::7"], "wantReverse": 13911 }
            }),
        ];
        let got = crate::p2p_client::reverse_want_rows(&rows, &me_did, &[13911, 9100]);
        assert_eq!(got.len(), 1, "只有第一条应命中");
        assert!(myco_core::identity::did_equiv(
            &got[0].device_did,
            &phone_did
        ));
        assert_eq!(got[0].want_port, 13911);
        assert_eq!(got[0].port, 5555);
        assert_eq!(got[0].addrs, vec!["3fff:471:900::1".to_string()]);
        // canonical 另一前缀写法上报、canonical 查询 → 公钥级互认（同钥）；单值 ipv6 键也认
        let youling_phone = phone_did.replacen("did:myco:", "did:youling:", 1);
        let twin_rows = vec![serde_json::json!({
            "did": youling_phone, "kind": "phone", "rootDid": "did:youling:zAcc",
            "addrs": { "ipv6": "3fff::42", "port": 5556, "wantReverse": 9100 }
        })];
        let got2 = crate::p2p_client::reverse_want_rows(&twin_rows, &me_did, &[13911, 9100]);
        assert_eq!(got2.len(), 1, "canonical 双前缀互认");
        assert!(myco_core::identity::did_equiv(
            &got2[0].device_did,
            &phone_did
        ));
        assert_eq!(
            got2[0].addrs,
            vec!["3fff::42".to_string()],
            "单值 ipv6 键也认"
        );
        // legacy 已废止：不再被认成本机设备（did_equiv=false → 该行不被自筛掉）
        let legacy_self = format!(
            "did:myco:{}",
            bs58::encode(phone_sk.verifying_key().to_bytes()).into_string()
        );
        let same_row = vec![serde_json::json!({
            "did": phone_did, "kind": "phone", "rootDid": "did:youling:zAcc",
            "addrs": { "ipv6": "3fff::43", "port": 5557, "wantReverse": 9100 }
        })];
        let got3 = crate::p2p_client::reverse_want_rows(&same_row, &legacy_self, &[13911, 9100]);
        assert_eq!(
            got3.len(),
            1,
            "legacy 不再被认成本机 → 同钥 canonical 行不被自筛掉"
        );
        drop(me_sk);
    }

    // ═══ I7：listener 存活 = 本进程 accept 任务在跑（2026-10-25 live RED 配套） ═══
    //
    // live RED（2026-10-25 14:00，PC 实机 /api/vnet/leases）：租约 laptop:3103 →
    // localPort 23104 报 listenerPresent=true，而 127.0.0.1:23104 无任何监听
    // （Test-NetConnection 失败 / netstat 无行）——accept 循环退出后 TUNNELS 条目
    // 残留，tunnel_local_port 照样回旧口，keeper 据此硬写 true。

    /// 死条目（accept 任务已结束 = socket 已拆）不得被当成活 listener：
    /// `tunnel_listener_alive`=false、`tunnel_live_local_port`=None；
    /// 旧口径 `tunnel_local_port` 仍回旧口（钉住旧 bug 形态，防止有人拿它当判据）。
    #[tokio::test]
    async fn dead_tunnel_entry_is_not_a_live_listener() {
        let dev = "did:myco:z6MkDeadListenerEntry";
        let tport = 3999_u16;
        let key = tunnel_key(dev, tport);
        // 已完成的 accept 任务
        let done = tokio::spawn(async {});
        for _ in 0..200 {
            if done.is_finished() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(done.is_finished(), "测试前置：任务必须已完成");
        // 活着的挂起任务（对照组）
        let live_gate = Arc::new(tokio::sync::Notify::new());
        let g2 = live_gate.clone();
        let alive_task = tokio::spawn(async move { g2.notified().await });
        {
            let mut g = TUNNELS.lock().unwrap();
            g.insert(
                key.clone(),
                TunnelEntry {
                    device_did: dev.to_string(),
                    target_port: tport,
                    local_port: 45123,
                    task: done,
                    stat: TunnelStat::new(),
                },
            );
            g.insert(
                tunnel_key(dev, tport + 1),
                TunnelEntry {
                    device_did: dev.to_string(),
                    target_port: tport + 1,
                    local_port: 45124,
                    task: alive_task,
                    stat: TunnelStat::new(),
                },
            );
        }
        // 死条目：legacy 口径仍回口（残留事实），live 口径必须看穿
        assert_eq!(
            tunnel_local_port(dev, tport),
            Some(45123),
            "旧口径只查注册表（残留即回口）"
        );
        assert!(
            !tunnel_listener_alive(dev, tport),
            "socket 已拆 → 不是活 listener"
        );
        assert_eq!(
            tunnel_live_local_port(dev, tport),
            None,
            "live 口径把死条目当无 listener"
        );
        // 活条目：两口径一致
        assert!(tunnel_listener_alive(dev, tport + 1));
        assert_eq!(tunnel_live_local_port(dev, tport + 1), Some(45124));
        // 无条目：三口径一致为空/false
        assert!(!tunnel_listener_alive(dev, 3998));
        assert_eq!(tunnel_live_local_port(dev, 3998), None);
        // 清理（唤醒活任务 + 摘条目，不污染其它测试）
        live_gate.notify_one();
        TUNNELS.lock().unwrap().remove(&key);
        TUNNELS.lock().unwrap().remove(&tunnel_key(dev, tport + 1));
        assert_eq!(tunnel_live_local_port(dev, tport), None);
    }
}

// ══════════════════ ⑦ 双向打洞单测（测试即规格） ══════════════════
//
// 覆盖：wire 形状（request/ack 序列化+反序列化+闸门）、预绑端口的确定性（五元组
// 配对的命门——后续连接的源口必须是它）、ack 等待表生命周期、A 侧探测实发（含
// 源口=指定端口）、base 解析、信令限频、以及与 race_tunnel 的整合（直连通时零
// 信令；直连全断时打洞腿从"源口防火墙"后面赢下赛跑——防火墙仿真 = 只放行信令里
// 声明的预绑源口的 TCP 代理，正对有状态防火墙的五元组语义）。
#[cfg(test)]
mod hole_punch_tests {
    use super::*;
    use crate::p2p_server;
    use std::sync::atomic::{AtomicU16, Ordering};

    fn dev(tag: u8) -> (ed25519_dalek::SigningKey, String) {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[tag; 32]);
        let did = myco_core::identity::did_from_public(&sk.verifying_key().to_bytes());
        (sk, did)
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// 防火墙当前放行的源口（0 = 全挡）。信令 fake sender 与防火墙代理共享它——
    /// **正是生产语义**：A 收到 request（带预绑口 P）才在防火墙上为 P 开记录。
    static FIREWALL_ALLOWED: AtomicU16 = AtomicU16::new(0);
    /// fake 信令面捕获的 (to, kind, payload)。
    static SIGNALS: LazyLock<Mutex<Vec<(String, String, Value)>>> =
        LazyLock::new(|| Mutex::new(Vec::new()));

    /// 假信令发送面：捕获全部信令；对 hole-punch-request 模拟 A 侧完整动作
    /// （记录预绑口到"防火墙" + 立即回 ack——生产里这两步分别是 A 的探测与 ack）。
    fn fake_sender(
        to: String,
        kind: String,
        payload: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>> {
        Box::pin(async move {
            SIGNALS
                .lock()
                .unwrap()
                .push((to, kind.clone(), payload.clone()));
            if kind == HOLE_PUNCH_REQUEST_KIND {
                if let Some(req) = parse_hole_punch_request(&payload, now_ms_i64()) {
                    FIREWALL_ALLOWED.store(req.candidates[0].port, Ordering::SeqCst);
                    hole_punch_ack_arrived(&req.request_id);
                }
            }
            Ok(())
        })
    }

    /// 中性恢复面（≈ 默认直推在无账号环境下的行为：快速失败，不触网）。
    fn neutral_sender(
        _to: String,
        _kind: String,
        _payload: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>> {
        Box::pin(async { Err("test-no-send".into()) })
    }

    fn reset_hp_test_state() {
        test_clear_hp_state();
        FIREWALL_ALLOWED.store(0, Ordering::SeqCst);
        SIGNALS.lock().unwrap().clear();
    }

    /// 记录入站连接源口的探针 listener（`v6` = 绑 [::1]，默认 127.0.0.1）。
    async fn spawn_peer_recorder(v6: bool) -> (u16, Arc<Mutex<Vec<u16>>>) {
        let bind_addr = if v6 { "[::1]:0" } else { "127.0.0.1:0" };
        let l = TcpListener::bind(bind_addr).await.unwrap();
        let port = l.local_addr().unwrap().port();
        let seen: Arc<Mutex<Vec<u16>>> = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut s, peer)) = l.accept().await {
                s2.lock().unwrap().push(peer.port());
                // 保持连接挂着（探测方会立即看到建连成功）
                let mut buf = [0u8; 64];
                let _ = tokio::time::timeout(Duration::from_secs(2), s.read(&mut buf)).await;
            }
        });
        (port, seen)
    }

    /// 占一个空闲端口后立刻释放。
    async fn reserve_free_port() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let p = l.local_addr().unwrap().port();
        drop(l);
        p
    }

    /// 真 p2p 端点（回环随机端口）。
    async fn spawn_p2p() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(
                l,
                p2p_server::p2p_router().into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        port
    }

    /// **源口防火墙**（有状态防火墙的五元组仿真）：只放行源口 ==
    /// [`FIREWALL_ALLOWED`] 的连接（放行者把它们双向转接到真服务器）；
    /// 其余连接**立即丢弃**（模拟"没有对应出站记录的入站 SYN 被光猫丢弃"）。
    async fn spawn_firewall_proxy(upstream: u16) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((down, peer)) = l.accept().await {
                let allowed = FIREWALL_ALLOWED.load(Ordering::SeqCst);
                if allowed == 0 || peer.port() != allowed {
                    let mut down = down;
                    let _ = down.shutdown().await; // 丢包：不回任何字节
                    continue;
                }
                tokio::spawn(async move {
                    let Ok(mut up) = TcpStream::connect(("127.0.0.1", upstream)).await else {
                        return;
                    };
                    let (mut dr, mut dw) = down.into_split();
                    let (mut ur, mut uw) = up.into_split();
                    let a = tokio::io::copy(&mut dr, &mut uw);
                    let b = tokio::io::copy(&mut ur, &mut dw);
                    let _ = tokio::join!(a, b);
                });
            }
        });
        port
    }

    /// 等条件成立（200ms 一轮，最多 ~3s）——探测/信令都是 spawn 出去的，得给它们跑的时间。
    async fn wait_until(desc: &str, mut f: impl FnMut() -> bool) {
        for _ in 0..15 {
            if f() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        panic!("等待超时：{desc}");
    }

    // ═══ ① 信令 wire 形状 ═══

    /// request/ack 的序列化形状（camelCase 键）+ 反序列化 + 解析闸门。
    #[test]
    fn hole_punch_wire_shape_and_gates() {
        let now = now_ms_i64();
        let cands = vec![
            HolePunchCandidate {
                addr: "3fff:1::2".into(),
                port: 52331,
            },
            HolePunchCandidate {
                addr: "192.168.1.5".into(),
                port: 52331,
            },
        ];
        let payload = hole_punch_request_payload("hp-tn-1", &cands, "");
        // camelCase 键（CLAUDE.md JSON 约定）
        assert_eq!(payload["requestId"], json!("hp-tn-1"));
        assert_eq!(payload["candidates"][0]["addr"], json!("3fff:1::2"));
        assert_eq!(payload["candidates"][0]["port"], json!(52331));
        assert_eq!(payload["shareId"], json!(""));
        assert!(
            payload["ts"]
                .as_i64()
                .map(|t| (t - now).abs() < 10_000)
                .unwrap_or(false),
            "ts=现在"
        );
        // 往返
        let parsed = parse_hole_punch_request(&payload, now).expect("合法载荷必须可解析");
        assert_eq!(parsed.request_id, "hp-tn-1");
        assert_eq!(parsed.candidates, cands);
        // 闸门：过期（超过 30s 新鲜窗）
        let mut stale = payload.clone();
        stale["ts"] = json!(now - 31_000);
        assert!(
            parse_hole_punch_request(&stale, now).is_none(),
            "迟到信令必须拒"
        );
        // 闸门：空候选
        let mut empty = payload.clone();
        empty["candidates"] = json!([]);
        assert!(parse_hole_punch_request(&empty, now).is_none());
        // 闸门：候选全无效（port=0 / 空地址）过滤后为空
        let mut zero = payload.clone();
        zero["candidates"] = json!([{ "addr": "x", "port": 0 }, { "addr": "  ", "port": 1 }]);
        assert!(parse_hole_punch_request(&zero, now).is_none());
        // 闸门：缺 requestId
        let mut norid = payload.clone();
        norid["requestId"] = json!("");
        assert!(parse_hole_punch_request(&norid, now).is_none());
        // 上限：候选截断到 HOLE_PUNCH_MAX_CANDIDATES
        let mut many = payload.clone();
        many["candidates"] = (0..20)
            .map(|i| json!({ "addr": format!("10.0.0.{i}"), "port": 9 }))
            .collect::<Vec<_>>()
            .into();
        assert_eq!(
            parse_hole_punch_request(&many, now)
                .unwrap()
                .candidates
                .len(),
            HOLE_PUNCH_MAX_CANDIDATES
        );

        // ack 形状
        let ack = hole_punch_ack_payload("hp-tn-2");
        assert_eq!(ack["requestId"], json!("hp-tn-2"));
        assert!(ack["ts"].as_i64().is_some());
        let parsed_ack = parse_hole_punch_ack(&ack).expect("ack 必须可解析");
        assert_eq!(parsed_ack.request_id, "hp-tn-2");
        assert!(
            parse_hole_punch_ack(&json!({ "ts": 1 })).is_none(),
            "缺 requestId 必须拒"
        );
        assert!(parse_hole_punch_ack(&json!({ "requestId": " " })).is_none());
    }

    // ═══ ② 预绑端口的确定性（端口配对命门） ═══

    /// pre_bind_port 拿到的端口 P，必须成为后续拨号的**源口**（对端防火墙上
    /// "放行 B_ip:P → A:9100"的记录对应的正是这个五元组）。
    #[tokio::test]
    async fn pre_bound_port_is_the_source_port_of_subsequent_dial() {
        let _env = crate::test_env_lock::test_env_lock();
        reset_hp_test_state();
        let (lport, seen) = spawn_peer_recorder(false).await;
        let p = pre_bind_port().expect("预绑端口应成功");
        assert!(p != 0, "预绑口必须是非零确定端口");
        let target: SocketAddr = format!("127.0.0.1:{lport}").parse().unwrap();
        let (stream, actual) = dial_from_port(target, p, Duration::from_secs(2)).await;
        assert!(stream.is_some(), "回环拨号应成功");
        assert_eq!(actual, p, "拨号实际源口必须是预绑口 P（五元组配对的命门）");
        wait_until("探针 listener 看到源口 = P", || {
            seen.lock().unwrap().contains(&p)
        })
        .await;
        // 同口可重复使用（SO_REUSEADDR：打洞重试轮次要反复从 P 发）。
        // 语义对齐生产：重试发生在**未建连**的候选上；已建连又关掉的连接会留下
        // TIME_WAIT（同四元组重拨 10048），所以这里换一个目标地址验证 P 的复用
        // （新五元组 = 新一轮探测/拨号的真实形态）。
        drop(stream);
        let (lport2, seen2) = spawn_peer_recorder(false).await;
        let target2: SocketAddr = format!("127.0.0.1:{lport2}").parse().unwrap();
        let (s2, a2) = dial_from_port(target2, p, Duration::from_secs(2)).await;
        assert!(s2.is_some(), "同口对新目标的拨号应成功（重试轮次语义）");
        assert_eq!(a2, p, "第二轮拨号仍必须从 P 发出");
        wait_until("第二个探针看到源口 = P", || {
            seen2.lock().unwrap().contains(&p)
        })
        .await;
    }

    /// base 解析：http/ws/无 scheme、IPv6 方括号、无端口=None。
    #[test]
    fn base_host_port_parses_all_shapes() {
        assert_eq!(
            base_host_port("http://127.0.0.1:9100"),
            Some(("127.0.0.1".into(), 9100))
        );
        assert_eq!(
            base_host_port("ws://[3fff:1::2]:9100/p2p/tunnel?v=2"),
            Some(("3fff:1::2".into(), 9100))
        );
        assert_eq!(
            base_host_port("127.0.0.1:1234"),
            Some(("127.0.0.1".into(), 1234))
        );
        assert_eq!(
            base_host_port("http://host.only"),
            None,
            "无端口不能打洞（不知对端端口）"
        );
        assert_eq!(base_host_port(""), None);
    }

    // ═══ ③ ack 等待表 ═══

    #[tokio::test]
    async fn ack_waiter_fires_times_out_and_tolerates_late_arrivals() {
        // 全局等待表测试必须与其它会 reset 打洞全局态的测试互斥（并行下清表会
        // drop 掉本测试在等的 sender）。
        let _env = crate::test_env_lock::test_env_lock();
        reset_hp_test_state();
        // 命中：登记 → 到达 → 唤醒
        let rx = hp_ack_register("hp-a");
        assert!(
            hole_punch_ack_arrived("hp-a"),
            "在等的 requestId 必须被唤醒"
        );
        rx.await.expect("唤醒通道必须闭合");
        // 未登记的 requestId：不算唤醒
        assert!(
            !hole_punch_ack_arrived("hp-zz"),
            "无人等待的 ack 返回 false"
        );
        // 超时：等待方放弃后，迟到 ack 无害（不 panic、通道仍可收）
        let mut rx2 = hp_ack_register("hp-b");
        assert!(
            matches!(
                tokio::time::timeout(Duration::from_millis(50), &mut rx2).await,
                Err(_)
            ),
            "没有 ack 时必须等到超时"
        );
        assert!(
            hole_punch_ack_arrived("hp-b"),
            "迟到 ack 仍应被接收（无等待者也 OK）"
        );
        rx2.await.expect("迟到 ack 唤醒被放弃的等待者也不炸");
    }

    /// 信令限频：同一设备 2s 内第二条腿不再发信令。
    #[test]
    fn hp_signal_is_throttled_per_device() {
        let _env = crate::test_env_lock::test_env_lock();
        reset_hp_test_state();
        assert!(!hp_signal_throttled("did:myco:devT"));
        hp_signal_sent("did:myco:devT");
        assert!(hp_signal_throttled("did:myco:devT"), "2s 内必须限频");
        assert!(
            !hp_signal_throttled("did:myco:devOther"),
            "限频按设备，不连坐"
        );
    }

    // ═══ ④ A 侧探测实发 ═══

    /// 收到 request 后 A 确实发了探测：从**指定源口**（= p2p 端口）拨向 B 声明的
    /// 候选地址，审计留痕（wanted/src/result 人话可读）。
    #[tokio::test]
    async fn a_side_probe_dials_from_fixed_source_port_and_audits() {
        let _env = crate::test_env_lock::test_env_lock();
        reset_hp_test_state();
        let (lport, seen) = spawn_peer_recorder(false).await;
        let src = reserve_free_port().await;
        let (result, stream) = hole_punch_probe_once("127.0.0.1", lport, src).await;
        assert_eq!(result, "probe-open", "对面在听时探测应建连");
        assert!(stream.is_some());
        assert_eq!(
            stream.unwrap().local_addr().unwrap().port(),
            src,
            "探测源口必须是指定端口"
        );
        wait_until("探针看到源口 = 指定源口", || {
            seen.lock().unwrap().contains(&src)
        })
        .await;
        let audit = hole_punch_probe_recent();
        let last = audit.last().expect("探测必须留审计");
        assert_eq!(last.result, "probe-open");
        assert_eq!(last.src_port, src);
        assert_eq!(last.wanted_port, src);
        assert_eq!(last.target, format!("127.0.0.1:{lport}"));
        // IPv6 候选同样可解析拨号（v6 回环 ::1 + v6 探针 listener）
        let (lport6, _seen6) = spawn_peer_recorder(true).await;
        let (r6, s6) = hole_punch_probe_once("::1", lport6, 0).await;
        assert_eq!(
            r6, "probe-open",
            "v6 候选必须同样可探测（源口 0=回退临时口）"
        );
        assert!(s6.is_some());
    }

    // ═══ ⑤ 与 race_tunnel 的整合 ═══

    /// 直连通时打洞腿零信令：直连候选 <100ms 赢下赛跑，打洞腿在 100ms 让先的
    /// sleep 里被 drop——SIGNALS 空、防火墙零记录、胜者=直连 base。
    #[tokio::test]
    async fn race_prefers_direct_and_sends_no_signaling_when_direct_works() {
        let _env = crate::test_env_lock::test_env_lock();
        reset_hp_test_state();
        clear_tunnel_authorizer();
        test_clear_cache();
        let account = "did:youling:HpDirectAccount";
        let (sk, did) = dev(0xD6);
        test_set_identity(account, &did, [0xD6; 32]);
        p2p_server::test_seed_roster_cache(account, vec![b64(&sk.verifying_key().to_bytes())]);
        let target_port = reserve_free_port().await;
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![target_port];
        set_tunnel_authorizer(move |acc, _d, _p| acc == account);
        let p2p_port = spawn_p2p().await;
        crate::chat_service::install_share_entry_sender(fake_sender);
        test_set_hp_account("did:myco:HpTargetA", Some(account));
        // 起跑延迟拉大到 500ms：赛跑在直连赢 + 合流窗（~90ms）后必然返回，
        // 打洞腿还在 sleep 里就被 drop——零信令是确定的（生产 100ms 下这个
        // 边界受 Windows 定时器粒度 ~15.6ms 影响，可能抢跑一条无害信令，有 2s 限频兜底）。
        test_set_hp_start_delay(Some(Duration::from_millis(500)));

        let bases = vec![format!("ws://127.0.0.1:{p2p_port}/p2p/tunnel?v=2")];
        let got = race_tunnel_ex(
            &bases,
            target_port,
            Duration::from_millis(900),
            Duration::from_secs(3),
            Some(HpPlan {
                device: "did:myco:HpTargetA".into(),
                share_id: String::new(),
            }),
            None,
        )
        .await;
        let (base, mut ws, _hs) = got.expect("直连候选活着，赛跑必须成功");
        assert_eq!(base, bases[0], "胜者必须是直连候选（打洞不抢直连的戏）");
        let _ = ws.close(None).await;
        assert!(
            SIGNALS.lock().unwrap().is_empty(),
            "直连 <100ms 赢时不得发任何打洞信令"
        );
        assert_eq!(FIREWALL_ALLOWED.load(Ordering::SeqCst), 0);

        crate::chat_service::install_share_entry_sender(neutral_sender);
        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
        reset_hp_test_state();
    }

    /// **正题**：直连候选全被"源口防火墙"挡死（模拟家宽光猫丢单向 SYN）时，
    /// 打洞腿赢下赛跑——预绑口 P 经信令告知"防火墙"（= A 侧探测开的记录），
    /// B 从 P 发出的连接被放行并完成完整隧道 WS 握手（含验签/白名单/授权闸）。
    #[tokio::test]
    async fn race_wins_via_hole_punch_when_direct_blocked_by_source_port_firewall() {
        let _env = crate::test_env_lock::test_env_lock();
        reset_hp_test_state();
        clear_tunnel_authorizer();
        test_clear_cache();
        let account = "did:youling:HpPunchAccount";
        let (sk, did) = dev(0xD7);
        test_set_identity(account, &did, [0xD7; 32]);
        p2p_server::test_seed_roster_cache(account, vec![b64(&sk.verifying_key().to_bytes())]);
        let target_port = reserve_free_port().await;
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![target_port];
        set_tunnel_authorizer(move |acc, _d, _p| acc == account);
        let real_port = spawn_p2p().await;
        let fw_port = spawn_firewall_proxy(real_port).await;
        crate::chat_service::install_share_entry_sender(fake_sender);
        test_set_hp_account("did:myco:HpTargetB", Some(account));

        let ws_base = format!("ws://127.0.0.1:{fw_port}/p2p/tunnel?v=2");
        let bases = vec![ws_base.clone()];
        let t0 = std::time::Instant::now();
        let got = race_tunnel_ex(
            &bases,
            target_port,
            Duration::from_millis(400),
            Duration::from_secs(4),
            Some(HpPlan {
                device: "did:myco:HpTargetB".into(),
                share_id: String::new(),
            }),
            None,
        )
        .await;
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        let (base, mut ws, _hs) = got.expect("直连全断时，打洞腿必须赢下赛跑");
        let _ = ws.close(None).await;
        assert_eq!(base, ws_base, "胜者必须是打洞打通的那条候选");
        let allowed = FIREWALL_ALLOWED.load(Ordering::SeqCst);
        assert!(
            allowed != 0,
            "预绑口 P 必须经信令传到对端（防火墙才开了记录）"
        );
        // 先在块内作用域取断言材料并**释放 SIGNALS 守卫**——std Mutex 不可重入，
        // 守卫活到收尾会让 reset_hp_test_state 的第二次 lock 同线程自死锁。
        let port_traveled = {
            let signals = SIGNALS.lock().unwrap();
            let reqs: Vec<&(String, String, Value)> = signals
                .iter()
                .filter(|(to, k, _)| k == HOLE_PUNCH_REQUEST_KIND && to == account)
                .collect();
            assert!(
                !reqs.is_empty(),
                "必须发过 hole-punch-request（投递到目标账号）"
            );
            serde_json::from_value::<HolePunchRequest>(reqs[0].2.clone())
                .map(|r| r.candidates.iter().any(|c| c.port == allowed))
                .unwrap_or(false)
        };
        assert!(port_traveled, "信令里的候选端口必须是预绑口 P");
        println!(
            "[hp-race] 防火墙仿真：直连全断 → 打洞腿 {:.1}ms 赢（预绑口 {allowed}）",
            ms
        );

        crate::chat_service::install_share_entry_sender(neutral_sender);
        clear_tunnel_authorizer();
        *TEST_EXTRA_PORTS.lock().unwrap() = vec![];
        reset_hp_test_state();
    }
}

// ══════════════════════════════════════════════════════════════════════════
