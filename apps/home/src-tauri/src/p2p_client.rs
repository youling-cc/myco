//! p2p_client.rs — 第84轮：P2P 直连客户端（发送直推 + 对账循环 + typing 信号）。
//!
//! 寻址链：identity-svc /presence/list（只做建联中介）→ 好友账号 rootDid 下的
//! 在线 PC 设备 → 逐 IPv6 地址实测直连（前缀轮换期多地址全报，实测选路——
//! env direct_server 的定案思想）。消息本体不经服务器。
//!
//! - deliver_to_account：POST /p2p/msg（设备钥签名信封）；best-effort。
//! - sync_with_account：指纹-索引两段式对账（p2p_sync.rs 的流程侧）。
//! - sync_loop：60s 周期对全部好友 + 本机其他设备对账（在线遇到即收敛）。
//! - typing_signal：POST /p2p/typing 瞬时信号。

use base64::Engine as _;
use ed25519_dalek::Signer as _;
use myco_core::identity as core_id;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Mutex;
// 非 test 构建才引 Tauri `Emitter`（`.emit()` 的 trait）。lib 单元测试 harness 没有
// exe manifest，测试可达的代码一旦链上 tauri 的 webview 运行时（Wry → muda → 静态
// 导入 `comctl32.dll!TaskDialogIndirect`，v6 专属符号）→ 加载器绑 System32 的 v5.82
// → `0xC0000139`，`cargo test -p myco-home --lib` 全体起不来。
// 详见 `apps/home/src-tauri/build.rs` 顶部长注释。
#[cfg(not(test))]
use tauri::Emitter as _;

/// 直连 HTTP 超时（秒）——跨网 IPv6 最坏几秒；失败立刻换下一个地址。
const HTTP_TIMEOUT_SECS: u64 = 5;
/// 第96轮（修复3）：媒体端点超时放宽到 60s（10MB 分片跨网传输，5s 必死）。
const MEDIA_HTTP_TIMEOUT_SECS: u64 = 60;
/// 单批对账传输条数（与字节预算双闸——p2p_sync::chunk_wire_msgs）。
const SYNC_CHUNK: usize = 50;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn base_url() -> String {
    std::env::var("MYCO_DID_BASE").unwrap_or_else(|_| "https://myco.youling.cc/myco-id".into())
}

/// 设备钥签名 → X-Myco-Auth 头（p2p_server 验签对偶）。
fn p2p_auth(raw: &str) -> Result<String, String> {
    let (did, seed_b64) = core_id::device_identity()?;
    let seed = base64::engine::general_purpose::STANDARD
        .decode(seed_b64)
        .map_err(|e| format!("seed 解码失败: {e}"))?;
    let arr: [u8; 32] = seed.try_into().map_err(|_| "seed 长度异常".to_string())?;
    let signing = ed25519_dalek::SigningKey::from_bytes(&arr);
    let ts = now_ms();
    let sig = signing.sign(format!("{did}\n{ts}\n{raw}").as_bytes());
    Ok(format!("{did}.{ts}.{}", base64::engine::general_purpose::STANDARD.encode(sig.to_bytes())))
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .unwrap_or_default()
}

/// 直推专用（2026-10-12 真机拆账：stale 地址吃满 5s 超时 ×3=15s 白等，而能通的
/// 中继腿 1.3s）：单地址 2.5s——直连语义（LAN/v6 同网建立 <1s；不通的尽快让位
/// 给中继腿）。媒体/对账等大传输**不走这里**（http_media/对账各自有客户端）。
fn http_direct() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(2500))
        .build()
        .unwrap_or_default()
}

/// 第96轮（修复3）：媒体端点专用客户端（60s——分片传输放宽；信令仍走 5s 快失败）。
fn http_media() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(MEDIA_HTTP_TIMEOUT_SECS))
        .build()
        .unwrap_or_default()
}

/// 隧道口专用客户端（**2026-10-19 Phase 2：共享实例 + keep-alive 连接池**）。
///
/// 演进史：
/// - 2026-10-18 task-7：曾用 `pool_max_idle_per_host(0)` 禁 keep-alive——当时隧道口
///   上游连接会死而本地 listener 还活着，reqwest 复用池里的旧连接 → POST 30-80ms
///   快失败（"假活"）。那是**没有持久隧道**时代的权宜。
/// - 2026-10-19 持久隧道（tmp-shots/persistent-tunnel-metrics.md T6）：手机侧
///   `serveP2pDataFace` 已改成 HTTP/1.1 keep-alive（一条隧道多次 HTTP），PC 端必须
///   **复用同一条 TCP**才能做到"N 条消息 1 次握手"。要点：
///   ① `http_tunnel()` 返回**进程级共享** Client（每次 build 新 Client 等于没有连接池）；
///   ② `pool_max_idle_per_host(1)`：每条隧道只留 1 条空闲连接（投递侧已有
///      `RELAY_POST_LOCK` 串行，并发不会额外开连接）；
///   ③ `pool_idle_timeout(90s)` **小于**手机空闲回收（120s）：客户端先主动丢弃，
///      避免复用到手机刚关掉的半死连接；
///   ④ 连接真的坏了（拒绝/重置）由投递侧标 unhealthy + 失效重连（T8 ≤2s）。
static TUNNEL_CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
        .pool_max_idle_per_host(1)
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .tcp_keepalive(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default()
});

fn http_tunnel() -> &'static reqwest::Client {
    &TUNNEL_CLIENT
}

// ══════ presence 寻址 ══════

/// 在线 PC 设备（rootDid==account、排除本机设备、上报了直连地址）。
#[derive(Clone)]
pub struct PeerDevice {
    pub did: String,
    pub name: String,
    pub addrs: Vec<String>,
    pub port: u16,
}

/// presence 条目 → PeerDevice（过滤：空 did/本机设备/无直连地址/kind 不在清单 → None）。
/// 2026-10-09 反向连接：kind 清单参数化——正向寻址只认 `pc`（原行为一字不变），
/// 反向拨号（PC 主动连手机）查 `phone` 行（手机上报 addrs 后才查得到）。
/// 无直连地址（老版本手机）——发起方语义，跳过。
/// 本机设备判定走 [`core_id::did_equiv`]（**canonical-only**：`did:myco:z…` 与
/// `did:youling:z…` 指同一把设备钥即等价；legacy 裸 base58 已废止、不再参与）
/// ——原为裸字符串相等，遇另一 canonical 前缀写法会把"自己"当对端去投递。
///
/// 2026-10-09 多路径寻址：addrs 收集顺序 = **lan → publicV4 → reflexive → ipv6**（选路顺序即
/// 数组顺序；urls_of 逐地址实测先通先得，隧道侧改成并行赛跑）。类别键双形态都认：
///   lan       ← `/addrs/lanList`（列表）| `/addrs/lan`（单值，旧/手工上报）
///   publicV4  ← `/addrs/publicV4List` | `/addrs/publicV4`
///   reflexive ← `/addrs/reflexiveList` | `/addrs/reflexive`（**服务器观测的公网出口**，
///               2026-10-09 新增：NAT 后方机器的"对端可能可达"地址；排在直接持有的
///               publicV4 之后——直接持有是无条件可达，反射地址要看 NAT 映射）
///   ipv6      ← `/addrs/ipv6List` | `/addrs/ipv6`（存量口径不变）
/// 只有 ipv6 的老版本上报照旧命中（向后兼容）。
fn peer_from_entry_kinds(d: &Value, my_device: &str, kinds: &[&str]) -> Option<PeerDevice> {
    let did = d.get("did").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if did.is_empty() || core_id::did_equiv(&did, my_device) {
        return None;
    }
    let kind = d.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    if !kinds.iter().any(|k| *k == kind) {
        return None;
    }
    let addrs = presence_row_addrs(d);
    if addrs.is_empty() {
        return None;
    }
    Some(PeerDevice {
        did,
        name: d.get("name").and_then(|v| v.as_str()).unwrap_or("myco-pc").to_string(),
        port: d.pointer("/addrs/port").and_then(|v| v.as_u64()).unwrap_or(9100) as u16,
        addrs,
    })
}

/// presence 行的 `/addrs` → 直连地址清单（lan → publicV4 → reflexive → ipv6；
/// 列表键优先、单值键兜底）。手机（只报 ipv6List）与 PC 共用这一个收集口径。
fn presence_row_addrs(d: &Value) -> Vec<String> {
    let list_or_single = |list_key: &str, single_key: &str| -> Vec<String> {
        d.pointer(&format!("/addrs/{list_key}"))
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>())
            .filter(|v: &Vec<String>| !v.is_empty())
            .or_else(|| {
                d.pointer(&format!("/addrs/{single_key}"))
                    .and_then(|v| v.as_str())
                    .map(|s| vec![s.to_string()])
            })
            .unwrap_or_default()
    };
    let mut addrs = list_or_single("lanList", "lan");
    addrs.extend(list_or_single("publicV4List", "publicV4"));
    addrs.extend(list_or_single("reflexiveList", "reflexive"));
    addrs.extend(list_or_single("ipv6List", "ipv6"));
    addrs
}

/// presence 条目 → PeerDevice（**只认 pc**——正向 P2P 寻址的既有口径，行为不变）。
fn peer_from_entry(d: &Value, my_device: &str) -> Option<PeerDevice> {
    peer_from_entry_kinds(d, my_device, &["pc"])
}

/// presence 全量在线列表缓存（2026-10-18 晚 验收实测新增）：
/// 并发/洪峰下每条投递都会打 `/presence/list`，补发积压一多 identity-svc 变慢，
/// 投递在**到达中继腿之前**就吃满 6s 预算（真机实证：手机解锁后 36 条积压 + 前台
/// 10 条连发，连 `[relay-targets]` 行都没来得及打，10/10 全 6s 超时；而队列补发
/// 之后单发 95-162ms 就通了）。
/// 对策：**2.5s TTL 缓存 + 单飞（single-flight）**——同一时刻只有一个请求真打网络，
/// 其余复用；网络失败时用过期缓存兜底（宁可 2.5s 旧列表，也别把"服务慢"变成"0 台"）。
const PRESENCE_TTL_MS: u128 = 2_500;
static PRESENCE_CACHE: std::sync::LazyLock<tokio::sync::Mutex<Option<(std::time::Instant, Vec<Value>)>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(None));
static PRESENCE_FETCH_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

/// 拉 presence 全量在线列表（发现层查询；失败=空——调用方按"无人在线"兜底）。
async fn presence_list() -> Vec<Value> {
    presence_list_result().await.unwrap_or_default()
}

/// `/presence/list` 的**可区分结果**（2026-10-23 env 修复）：
/// - `Ok(rows)`：真的查到了（可能为空 = 名册里没有该设备）；
/// - `Err(())`：**查不了**（签名/身份不可用、网络失败、超时）。
///
/// 原实现把 Err 吞成空数组，上层无法区分"设备离线"与"名册不可用"——真机上
/// 后者会把自连/已建隧道的请求误报成 `state=offline`（`ms=1` 就来自这条
/// 不触网的失败路径：`signed_post` → `load_seed` 失败即返回）。
async fn presence_list_result() -> Result<Vec<Value>, ()> {
    async fn cached() -> Option<Vec<Value>> {
        let g = PRESENCE_CACHE.lock().await;
        g.as_ref()
            .filter(|(at, _)| at.elapsed().as_millis() < PRESENCE_TTL_MS)
            .map(|(_, rows)| rows.clone())
    }
    async fn stale() -> Option<Vec<Value>> {
        PRESENCE_CACHE.lock().await.as_ref().map(|(_, rows)| rows.clone())
    }
    if let Some(rows) = cached().await {
        return Ok(rows);
    }
    // 单飞：等锁后**再查一次缓存**，避免并发一起打网络（洪峰下这里能省 90% 请求）。
    let _fetch = PRESENCE_FETCH_LOCK.lock().await;
    if let Some(rows) = cached().await {
        return Ok(rows);
    }
    let rows = match core_id::signed_post("/presence/list", &json!({})).await {
        Ok(resp) => resp.pointer("/data").and_then(|d| d.as_array()).cloned().unwrap_or_default(),
        // 网络/签名失败 = 未知，不冒充"没有人在线"（stale 也不拿来冒充新鲜名册）。
        Err(_) => return Err(()),
    };
    if rows.is_empty() {
        // 空结果：有过期缓存就沿用（宁可 2.5s+ 旧列表，也别把"服务慢"变成"0 台"）；
        // 没有缓存才是真的空名册（= 目标确实不在线）。
        return Ok(stale().await.unwrap_or(rows));
    }
    *PRESENCE_CACHE.lock().await = Some((std::time::Instant::now(), rows.clone()));
    Ok(rows)
}

/// 名册查询结论（**查不到 ≠ 查不了**）。消费方：`vnet_env::RealPresenceProbe`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RosterLookup {
    /// 名册里有这台设备（不看 kind/addrs——在线就值得尝试建链；中继 provider
    /// 本来就不依赖直连地址）。
    Online,
    /// 名册查成功、确实没有这台设备 → 离线。
    Absent,
    /// 名册查不了（签名/身份/网络）→ 未知，交给建链结果说话。
    Unavailable,
}

/// 按设备 DID 查名册在线态（不过滤 kind/addrs、不排除本机行——是否本机由
/// 调用方先判；这里只回答"名册里有没有这台设备"）。
pub(crate) async fn roster_lookup_by_did_any_kind(device_did: &str) -> RosterLookup {
    let rows = match presence_list_result().await {
        Ok(rows) => rows,
        Err(()) => return RosterLookup::Unavailable,
    };
    if rows.iter().any(|d| {
        let did = d.get("did").and_then(|v| v.as_str()).unwrap_or("");
        !did.is_empty() && core_id::did_equiv(did, device_did)
    }) {
        RosterLookup::Online
    } else {
        RosterLookup::Absent
    }
}

/// 行是否属于目标账号（纯函数，单测直击）：rootDid 与 account 的相等性**一律**
/// [`core_id::account_did_eq`]——presence 上报的 rootDid 来自 `account_did()`（归一到
/// `did:youling:`），而好友锚/会话 id 多是名册历史形态 `did:myco:`，裸串相等永不命中。
/// 2026-10-07 修（P2P 好友恒"对端不可达"的根因之一）：此处原为裸 `==`。
pub fn row_targets_account(d: &Value, account: &str) -> bool {
    let root = d.get("rootDid").and_then(|v| v.as_str()).unwrap_or("");
    !root.is_empty() && core_id::account_did_eq(root, account)
}

async fn presence_devices(account: &str) -> Vec<PeerDevice> {
    let my_device = core_id::device_identity().map(|(d, _)| d).unwrap_or_default();
    presence_list()
        .await
        .iter()
        .filter(|d| row_targets_account(d, account))
        .filter_map(|d| peer_from_entry(d, &my_device))
        .collect()
}

/// presence 行 → 正向直推设备清单（纯函数；与 [`presence_devices`] 同口径，
/// 供投递主路径"取一次 presence 同时算直推与中继腿目标"复用）。
pub fn direct_devices_from_rows(rows: &[Value], account: &str, my_device: &str) -> Vec<PeerDevice> {
    rows.iter()
        .filter(|d| row_targets_account(d, account))
        .filter_map(|d| peer_from_entry(d, my_device))
        .collect()
}

/// 账号下全部在线设备 did（纯函数，单测直击）：presence 行按账号聚合、排除本机，
/// **不过滤 kind/addrs**——中继 provider 是**常驻注册**（与 presence 心跳/直连地址
/// 无关），手机（kind=phone）也在这份清单里。
pub fn account_device_targets(rows: &[Value], account: &str, my_device: &str) -> Vec<String> {
    rows.iter()
        .filter(|d| row_targets_account(d, account))
        .filter_map(|d| d.get("did").and_then(|v| v.as_str()))
        .filter(|did| !did.is_empty() && !core_id::did_equiv(did, my_device))
        .map(String::from)
        .collect()
}

/// **直推够不到**的账号设备 did（纯函数，单测直击）= 全部账号设备 ∖ 直推清单。
///
/// 2026-10-18 task-7 真机根因之二：手机没有正向直推通道（无入站地址、kind=phone
/// 被 `peer_from_entry` 过滤），但手机在云中继注册了常驻 provider——它只能靠
/// **中继腿**推。原实现"直推任一设备成功就整体跳过中继腿"：同账号只要还有一台
/// 在线 PC（哪怕只是另一个设备）直推成功，手机就永远收不到推送，只能等对账
/// 轮询（实测 M3 P50=16s/P95=20s；本轮真机 deliver-ok ms=129 那条第 10.3s 才在
/// 手机上落库=走的是另一台 PC 设备直推 + 对账，不是推送）。
pub fn relay_only_targets(
    rows: &[Value],
    account: &str,
    my_device: &str,
    direct: &[PeerDevice],
) -> Vec<String> {
    let direct_has = |did: &str| direct.iter().any(|p| core_id::did_equiv(&p.did, did));
    let mut out: Vec<(bool, String)> = rows
        .iter()
        .filter(|d| row_targets_account(d, account))
        .filter_map(|d| {
            let did = d.get("did").and_then(|v| v.as_str())?;
            if did.is_empty() || core_id::did_equiv(did, my_device) || direct_has(did) {
                return None;
            }
            // 手机优先（kind=phone 是"只能中继"的主力设备）：多台 relay-only 设备
            // 时下游 `truncate(2)` 不能把手机挤掉。
            let phone = d.get("kind").and_then(|v| v.as_str()) == Some("phone");
            Some((phone, did.to_string()))
        })
        .collect();
    // 稳定排序：phone=true 在前，同组保持 presence 原序
    out.sort_by_key(|(phone, _)| if *phone { 0 } else { 1 });
    out.into_iter().map(|(_, did)| did).collect()
}

/// **本机委任状 → 中继目标 did**（纯函数，单测直击；**零网络**，task-7 终版兜底）。
///
/// 为什么需要：真机上 `/presence/by-root`（云名册）对本账号返回空、而 `/presence/list`
/// 在 GUI 进程里又偶发过滤不出目标——两条依赖 identity-svc 的目标发现路径都不可靠。
/// 但本机 `delegations.json` 里就存着**本账号签出**的设备委任状（`accountDid` +
/// `devicePubkeyB64` + `deviceName`），可由公钥本地派生 device did，零网络直达手机
/// （手机设备名含 "phone"/"手机" → 优先；多台时下游 truncate(2) 不挤掉手机）。
///
/// 过滤：`revoked=false`、`exp > now`（过期委任状不投）、`accountDid` 与目标账号判等、
/// 公钥可解 32B、排除本机。去重保序。
/// 账号判等（2026-10-18 task-7）：`account_did_eq` 在 GUI 进程里对本机账号返回过 false
/// （同串都 false，测试进程正常——见 deleg-diag 现场日志），这里加**字符串直等 +
/// canonical 归一**的双保险，判等不再单点依赖那个函数。
fn acct_match(a: &str, b: &str) -> bool {
    let (x, y) = (a.trim(), b.trim());
    if x.is_empty() || y.is_empty() {
        return false;
    }
    x == y
        || core_id::account_did_canonical(x) == core_id::account_did_canonical(y)
        || core_id::account_did_eq(x, y)
}

/// 账号判等**宽松版**（2026-10-18 晚，新任务）：`acct_match` 在 GUI 进程出现过"同串
/// 仍 false"的异常（deleg-diag 现场：myAcct/account 打印完全一致但 acct_ok=0）。
/// 再退一级：**尾 8 位比较**（did 的 base58 尾段是设备/账号指纹最后一段，冲突概率
/// 可忽略；只在前面几种全部失败时兜底，不用于安全判定、仅用于"本机账号识别"）。
pub fn same_account_loose(a: &str, b: &str) -> bool {
    let (x, y) = (a.trim(), b.trim());
    if x.is_empty() || y.is_empty() {
        return false;
    }
    if acct_match(x, y) {
        return true;
    }
    let tail = |s: &str| -> String {
        let n = s.chars().count();
        s.chars().skip(n.saturating_sub(8)).collect()
    };
    let (tx, ty) = (tail(x), tail(y));
    tx.len() == 8 && tx == ty
}
pub fn delegation_relay_targets(
    records: &[myco_core::delegation::DelegationRecord],
    account: &str,
    my_device: &str,
    now: u64,
) -> Vec<String> {
    fn decode_pk(b64: &str) -> Option<[u8; 32]> {
        let raw = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
        raw.as_slice().try_into().ok()
    }
    let mut out: Vec<(bool, String)> = Vec::new();
    for r in records {
        if r.revoked || r.delegation.exp <= now {
            continue;
        }
        if !acct_match(&r.delegation.account_did, account) {
            continue;
        }
        let Some(pk) = decode_pk(&r.delegation.device_pubkey_b64) else { continue };
        let did = core_id::did_from_public(&pk);
        if did.is_empty() || core_id::did_equiv(&did, my_device) {
            continue;
        }
        if out.iter().any(|(_, d)| core_id::did_equiv(d, &did)) {
            continue; // 同一设备多张委任状：去重
        }
        let name = r.delegation.device_name.to_ascii_lowercase();
        let phone = name.contains("phone") || name.contains("手机") || name.contains("honor")
            || name.contains("mate") || name.contains("redmi") || name.contains("xiaomi");
        out.push((phone, did));
    }
    // 稳定排序：手机优先，同组保持 delegations.json 原序
    out.sort_by_key(|(phone, _)| if *phone { 0 } else { 1 });
    out.into_iter().map(|(_, did)| did).collect()
}

/// 读本机 `delegations.json` 并派生**本账号**的中继目标（零网络；失败=空表）。
/// 返回 (目标 did 列表, 其中手机 did 列表——供日志 phones=…）。
fn local_delegation_relay_targets(account: &str, my_device: &str) -> (Vec<String>, Vec<String>) {
    let records = myco_core::delegation::read_records_raw();
    // 2026-10-18 诊断（task-7 卡点）：GUI 进程里本函数对本机账号返回 0 台、独立进程同
    // 一文件却能读出 3 台——把关键计数写进可读的 chat-ui-trace.log 才能定位（含配置
    // 目录/账号尾部/本机设备尾部/首条记录状态）。
    let now = now_ms() as u64;
    {
        let rec_n = records.len();
        let acct_ok = records
            .iter()
            .filter(|r| acct_match(&r.delegation.account_did, account))
            .count();
        let exp_ok = records.iter().filter(|r| !r.revoked && r.delegation.exp > now).count();
        let first = records
            .first()
            .map(|r| {
                format!(
                    "acctTail={} name={} revoked={} expMinusNow={}",
                    &r.delegation.account_did[r.delegation.account_did.len().saturating_sub(6)..],
                    r.delegation.device_name,
                    r.revoked,
                    r.delegation.exp as i64 - now as i64
                )
            })
            .unwrap_or_default();
        crate::chat_service::chat_ui_trace(
            "backend".into(),
            format!(
                "[deleg-diag] records={rec_n} acct_ok={acct_ok} exp_ok={exp_ok} cfg={:?} myAcct=[{}] account=[{}] myDev=[{}] first=({first})",
                myco_core::config::config_dir(),
                core_id::account_did().unwrap_or_default(),
                account,
                my_device
            ),
        );
    }
    // 2026-10-18 task-7 终修：GUI 进程里"逐条按 accountDid 判等"在本机账号上恒 false
    // （同串在测试进程为 true——现场日志 deleg-diag 已记录该异常）。本机 `delegations.json`
    // 本来就是**本机签出**的委任状（含本账号与自身其它账号），发往自己账号时不需要
    // 再按 accountDid 过滤：只要不是本机设备就都是可投目标（手机优先）。对好友账号
    // 仍走严格 accountDid 判等（避免把消息投给无关设备）。
    let my_acct = core_id::account_did().unwrap_or_default();
    let is_own_account = !my_acct.is_empty() && same_account_loose(account, &my_acct);
    let targets = if is_own_account {
        let mut out: Vec<(bool, String)> = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        let now2 = now;
        for r in &records {
            if r.revoked || r.delegation.exp <= now2 {
                continue;
            }
            let Some(pk) = base64::engine::general_purpose::STANDARD
                .decode(r.delegation.device_pubkey_b64.trim())
                .ok()
                .and_then(|raw| <[u8; 32]>::try_from(raw.as_slice()).ok())
            else { continue };
            let did = core_id::did_from_public(&pk);
            if core_id::did_equiv(&did, my_device) || seen.iter().any(|s| core_id::did_equiv(s, &did)) {
                continue;
            }
            let name = r.delegation.device_name.to_ascii_lowercase();
            let phone = name.contains("phone")
                || name.contains("手机")
                || name.contains("honor")
                || name.contains("mate")
                || name.contains("redmi")
                || name.contains("xiaomi");
            seen.push(did.clone());
            out.push((phone, did));
        }
        out.sort_by_key(|(p, _)| if *p { 0 } else { 1 });
        out.into_iter().map(|(_, d)| d).collect()
    } else {
        delegation_relay_targets(&records, account, my_device, now)
    };
    let phones: Vec<String> = targets
        .iter()
        .filter(|did| {
            records.iter().any(|r| {
                if r.revoked || r.delegation.exp <= now_ms() as u64 {
                    return false;
                }
                match base64::engine::general_purpose::STANDARD
                    .decode(r.delegation.device_pubkey_b64.trim())
                    .ok()
                    .and_then(|raw| <[u8; 32]>::try_from(raw.as_slice()).ok())
                {
                    Some(pk) => {
                        let d = core_id::did_from_public(&pk);
                        core_id::did_equiv(&d, did)
                            && (r.delegation.device_name.to_ascii_lowercase().contains("phone")
                                || r.delegation.device_name.contains("手机"))
                    }
                    None => false,
                }
            })
        })
        .cloned()
        .collect();
    (targets, phones)
}

/// 云名册行（`/presence/by-root` 的 devices）→ 中继目标 did（纯函数，单测直击）：
/// 排除本机 / revoked，**手机优先**（多台时下游 truncate(2) 不挤掉手机），其余保序。
///
/// 用途：/presence/list 在线聚合偶发失败或在途洪峰下超时（task-7 真机实测出现过
/// "直推够不到 0 台"）时，用云名册兜底出"这个账号还有哪些设备"，再走中继腿。
/// 名册对离线设备也会给 did——对端没注册中继只是快速 NOT_FOUND，不会长时间挂。
pub fn roster_relay_targets(roster: &[Value], my_device: &str) -> Vec<String> {
    let mut out: Vec<(bool, String)> = roster
        .iter()
        .filter_map(|d| {
            if d.get("revoked").and_then(|v| v.as_bool()).unwrap_or(false) {
                return None;
            }
            let did = d.get("did").and_then(|v| v.as_str())?;
            if did.is_empty() || core_id::did_equiv(did, my_device) {
                return None;
            }
            let phone = d.get("kind").and_then(|v| v.as_str()) == Some("phone");
            Some((phone, did.to_string()))
        })
        .collect();
    out.sort_by_key(|(phone, _)| if *phone { 0 } else { 1 });
    out.into_iter().map(|(_, did)| did).collect()
}

/// **presence 行里的手机设备 did**（纯函数，单测直击；新任务"手机恒进中继目标"）。
///
/// 为什么单独一条：`row_targets_account` 依赖 `account_did_eq`，GUI 进程里对该函数
/// 出现过异常（同串 false）。这里对 `kind=="phone"` 的行用 [`same_account_loose`]
/// 兜底判等（含尾 8 位比较），保证手机设备即使账号聚合抖动也永远能被认出来。
/// 排除本机；按行序返回（一般只有一台）。
pub fn presence_phone_targets(rows: &[Value], account: &str, my_device: &str) -> Vec<String> {
    rows.iter()
        .filter(|d| d.get("kind").and_then(|v| v.as_str()) == Some("phone"))
        .filter_map(|d| {
            let did = d.get("did").and_then(|v| v.as_str())?;
            if did.is_empty() || core_id::did_equiv(did, my_device) {
                return None;
            }
            let root = d.get("rootDid").and_then(|v| v.as_str()).unwrap_or("");
            // 行 rootDid 为空（未取委任状/旧版上报）时也认：本机账号的 kind=phone 设备
            // 数量极少，宁可为手机保留一条中继腿（投错设备由对端验签/授权闸兜底）。
            if !root.is_empty() && !same_account_loose(root, account) {
                return None;
            }
            Some(did.to_string())
        })
        .collect()
}

/// **中继目标合并（纯函数，单测直击；新任务"手机恒进中继目标"）**：
/// 手机目标恒排最前（下游 `deliver_via_relay_devices` 只试首台），其余候选按序
/// 追加；排除本机 / 直推已覆盖（kind=pc 有地址、直推能到）/ 重复。
pub fn merge_relay_targets(
    phone_targets: &[String],
    other_candidates: &[String],
    direct: &[PeerDevice],
    my_device: &str,
) -> Vec<String> {
    fn push_unique(out: &mut Vec<String>, did: &str, direct: &[PeerDevice], my_device: &str) {
        if did.is_empty() || core_id::did_equiv(did, my_device) {
            return;
        }
        if direct.iter().any(|p| core_id::did_equiv(&p.did, did)) {
            return;
        }
        if out.iter().any(|x| core_id::did_equiv(x, did)) {
            return;
        }
        out.push(did.to_string());
    }
    let mut out: Vec<String> = Vec::new();
    for p in phone_targets {
        push_unique(&mut out, p, direct, my_device);
    }
    for t in other_candidates {
        push_unique(&mut out, t, direct, my_device);
    }
    out
}

/// 纯函数（单测直击）：presence 在线列表里按【设备 did】挑 P2P 目标。
/// did_equiv 公钥级归一（**canonical-only**：`did:myco:z…` / `did:youling:z…` 同钥即中；
/// legacy 裸 base58 已废止、不再命中）。
pub fn pick_peer_device(list: &[Value], target_device_did: &str, my_device: &str) -> Option<PeerDevice> {
    list.iter().find_map(|d| {
        let did = d.get("did").and_then(|v| v.as_str()).unwrap_or("");
        if !core_id::did_equiv(did, target_device_did) {
            return None;
        }
        peer_from_entry(d, my_device)
    })
}

/// 按设备 did 寻址的在线查询。收编通知专用：成员尚未取委任状，presence 里还不在
/// 主账号名册下（rootDid 为空或还是旧账号）——按账号寻址（presence_devices）找不到它。
/// 2026-10-09：`pub(crate)`——P2P 隧道（p2p_tunnel::tunnel_open 按设备 did 找目标）复用。
pub(crate) async fn presence_device_by_did(device_did: &str) -> Option<PeerDevice> {
    let my_device = core_id::device_identity().map(|(d, _)| d).unwrap_or_default();
    pick_peer_device(&presence_list().await, device_did, &my_device)
}

/// 同上（2026-10-09 反向连接）：kind 清单参数化——查**手机**（`tunnel_open_reverse`
/// 按 did 找要反向拨的 viewer）。手机不上报 addrs 时照旧 None（老版本，反向无从谈起）。
pub(crate) async fn presence_device_by_did_kind(device_did: &str, kinds: &[&str]) -> Option<PeerDevice> {
    let my_device = core_id::device_identity().map(|(d, _)| d).unwrap_or_default();
    let list = presence_list().await;
    list.iter().find_map(|d| {
        let did = d.get("did").and_then(|v| v.as_str()).unwrap_or("");
        if !core_id::did_equiv(did, device_did) {
            return None;
        }
        peer_from_entry_kinds(d, &my_device, kinds)
    })
}

/// 按设备 did 寻址（**不过滤设备类型**）——2026-10-22 vnet 真案：
/// `tunnel_open` 原来用 `presence_device_by_did`（只认 kind=pc），导致 **PC 永远
/// 打不到手机**（手机 kind=phone 被过滤 → 落"对端不在线"分支 → 只剩中继腿且
/// 中继也没注册 → V11「手机 adb 经 myco 隧道」不可达）。vnet 是"我自己的设备
/// 之间"的转发，设备是 pc/phone/tablet 都不该挡路——这里接受任意非空 kind
/// （含老客户端无 kind 字段的空串）。
pub(crate) async fn presence_device_by_did_any_kind(device_did: &str) -> Option<PeerDevice> {
    const ANY: &[&str] = &["pc", "phone", "tablet", "android", "ios", ""];
    let my_device = core_id::device_identity().map(|(d, _)| d).unwrap_or_default();
    let list = presence_list().await;
    list.iter().find_map(|d| {
        let did = d.get("did").and_then(|v| v.as_str()).unwrap_or("");
        if !core_id::did_equiv(did, device_did) {
            return None;
        }
        peer_from_entry_kinds(d, &my_device, ANY)
    })
}

/// 同账号**其他设备**的 did 清单（不过滤 kind/addrs——中继预热连手机也要）。
/// 2026-10-12 路由预热用（chat_warm_route）。
pub(crate) async fn roster_devices_except(account: &str, my_device: &str) -> Vec<String> {
    presence_list()
        .await
        .iter()
        .filter(|d| row_targets_account(d, account))
        .filter_map(|d| d.get("did").and_then(|v| v.as_str()).map(String::from))
        .filter(|did| !core_id::did_equiv(did, my_device))
        .collect()
}

// ══════ 反向连接意愿（2026-10-09：手机 presence 上报 addrs.wantReverse） ══════

/// 一条反向连接意愿（手机在 presence 的 `addrs` 里带 `wantReverse: <端口>`）。
#[derive(Debug, Clone, PartialEq)]
pub struct ReverseWant {
    pub device_did: String,
    /// 归属账号（同账号 ∪ 好友 才拨——与打洞信令闸同口径，防"借我出口"）。
    pub root_did: String,
    /// 手机可拨地址（ipv6 等，来自 `addrs.ipv6List`）。
    pub addrs: Vec<String>,
    /// 手机反向隧道监听端口（`addrs.port`）。
    pub port: u16,
    /// 手机想访问的**本机**端口（`addrs.wantReverse`，须在隧道白名单）。
    pub want_port: u16,
}

/// presence 行 → 反向意愿清单（纯函数，单测直击）：
/// kind=phone、`addrs.wantReverse` 为白名单端口、有可拨地址、非本机设备。
/// 账号闸（同账号 ∪ 好友）由 [`reverse_wants_now`] 叠加——这里保持纯函数可测。
pub fn reverse_want_rows(rows: &[Value], my_device: &str, allowed_ports: &[u16]) -> Vec<ReverseWant> {
    rows.iter()
        .filter_map(|d| {
            let did = d.get("did").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if did.is_empty() || core_id::did_equiv(&did, my_device) {
                return None;
            }
            if d.get("kind").and_then(|v| v.as_str()) != Some("phone") {
                return None;
            }
            let want_port = d.pointer("/addrs/wantReverse").and_then(|v| v.as_u64())? as u16;
            if want_port == 0 || !allowed_ports.contains(&want_port) {
                return None;
            }
            let addrs = presence_row_addrs(d);
            if addrs.is_empty() {
                return None;
            }
            Some(ReverseWant {
                device_did: did,
                root_did: d.get("rootDid").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                port: d.pointer("/addrs/port").and_then(|v| v.as_u64()).unwrap_or(0) as u16,
                addrs,
                want_port,
            })
        })
        .filter(|w| w.port != 0)
        .collect()
}

/// 当前 presence 里的反向意愿（**账号闸后**）：同账号设备 ∪ ok 好友——与打洞信令闸
/// （`hole_punch_request_allowed`）同口径，防"陌生手机借我的出口当跳板"。
/// 测试态**绝不触网**：直接返回空（拨号循环在测试里不起）。
pub(crate) async fn reverse_wants_now() -> Vec<ReverseWant> {
    #[cfg(test)]
    {
        return vec![];
    }
    #[cfg(not(test))]
    {
        let my_device = core_id::device_identity().map(|(d, _)| d).unwrap_or_default();
        let rows = presence_list().await;
        let allowed: Vec<u16> = TUNNEL_ALLOWED_PORTS();
        let my = core_id::account_did().unwrap_or_default();
        reverse_want_rows(&rows, &my_device, &allowed)
            .into_iter()
            .filter(|w| {
                if !w.root_did.is_empty() && core_id::account_did_eq(&w.root_did, &my) {
                    return true;
                }
                crate::chat_service::ok_friend_dids()
                    .iter()
                    .any(|f| !f.is_empty() && core_id::account_did_eq(f, &w.root_did))
            })
            .collect()
    }
}

/// 反向拨号允许的目标端口（隧道白名单的只读快照；p2p_tunnel 侧也可注入）。
fn TUNNEL_ALLOWED_PORTS() -> Vec<u16> {
    crate::p2p_tunnel::tunnel_allowed_ports_snapshot()
}

/// 对某设备的候选 URL 列表（**顺序 = PeerDevice.addrs 顺序 =
/// lan → publicV4 → reflexive → ipv6**；IPv6 记法 [addr]:port，IPv4 原样）。
/// 逐地址实测（p2p_post_with）先通先得。**隧道侧不串行**：`p2p_tunnel` 对同一批候选
/// 并行赛跑（首个成功即采用，见 `p2p_tunnel::race_tunnel`）。
/// 2026-10-09：`pub(crate)`——隧道复用同一条 URL 构造（含 ws:// 前缀转换在 p2p_tunnel）。
pub(crate) fn urls_of(dev: &PeerDevice) -> Vec<String> {
    crate::p2p_server::urls_from_addrs(&dev.addrs, dev.port)
}

/// 签名 POST 到对端。vnet 模式只走 route_open + 本地口；legacy 模式保留原逐地址实测。
/// 返回 (响应 JSON, 成功的 base url / vnet 路径标签)。
async fn p2p_post(dev: &PeerDevice, path: &str, body: &Value) -> Option<(Value, String)> {
    if crate::vnet_forward::transport_mode() == crate::vnet_forward::TransportMode::Vnet {
        let v = p2p_post_via_vnet(&dev.did, path, body).await?;
        return Some((v, format!("vnet://{}", dev.did)));
    }
    p2p_post_with(dev, path, body, http_direct()).await
}

/// 隧道口 POST 的结果分类（2026-10-19 Phase 2；决定持久隧道是否标 unhealthy）。
///
/// 为什么要分类：POST 失败有"慢"和"死"两类，处理完全不同——
/// · 超时/慢（手机 JS 忙、跨网抖动）→ **不标 unhealthy**，隧道还有救；
/// · 连接拒绝/重置（手机换了网络、中继会话被回收、上行连接死了）→ 标 unhealthy +
///   失效缓存，下一条消息立即重建（T8 ≤2s 自动恢复）。
#[derive(Debug)]
pub(crate) enum LocalPostOutcome {
    /// 对端数据面 200 + JSON。
    Ok(Value),
    /// 对端应答了但非 2xx（如心跳打到 404——**能应答就说明隧道活着**）。
    HttpStatus(u16),
    /// 连接层失败（拒绝/重置/握手即断）→ 隧道死。
    ConnectFail(String),
    /// 其他错误（编码/读体失败等）。
    Other(String),
}

/// 经**本地隧道端口**发一条已签名的 P2P POST（2026-10-11 云端中继兜底用）。
/// 隧道由 `p2p_tunnel::tunnel_open*` 建立（直连候选 + 中继腿自动赛跑），本地口
/// 等价于对端 p2p 服务面——签名/闸门与直连 p2p_post 完全同一套（X-Myco-Auth）。
pub(crate) async fn p2p_post_via_local(local_port: u16, path: &str, body: &Value) -> Option<Value> {
    match p2p_post_via_local_ex(local_port, path, body).await {
        LocalPostOutcome::Ok(v) => Some(v),
        LocalPostOutcome::HttpStatus(code) => {
            eprintln!("[p2p-post] 隧道口 {path} → HTTP {code}");
            None
        }
        LocalPostOutcome::ConnectFail(e) => {
            eprintln!("[p2p-post] 隧道口 {path} → 连接失败: {e}");
            None
        }
        LocalPostOutcome::Other(e) => {
            eprintln!("[p2p-post] 隧道口 {path} → 失败: {e}");
            None
        }
    }
}

/// 同 [`p2p_post_via_local`]，但**保留错误分类**（持久隧道健康度判定用）。
pub(crate) async fn p2p_post_via_local_ex(local_port: u16, path: &str, body: &Value) -> LocalPostOutcome {
    p2p_post_via_local_with_client(http_tunnel(), local_port, path, body).await
}

/// 本地隧道 POST 的客户端可配版本：普通消息复用共享池，媒体使用 60s 客户端。
async fn p2p_post_via_local_with_client(
    client: &reqwest::Client,
    local_port: u16,
    path: &str,
    body: &Value,
) -> LocalPostOutcome {
    let raw = serde_json::to_string(body).unwrap_or_default();
    let auth = match p2p_auth(&raw) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[p2p-post] 签名失败: {e}");
            return LocalPostOutcome::Other(format!("签名失败: {e}"));
        }
    };
    let url = format!("http://127.0.0.1:{local_port}/{}", path.trim_start_matches('/'));
    match client
        .post(&url)
        .header("X-Myco-Auth", &auth)
        .header("content-type", "application/json")
        .body(raw)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => match r.json::<Value>().await {
            Ok(v) => LocalPostOutcome::Ok(v),
            Err(e) => LocalPostOutcome::Other(format!("读响应体失败: {e}")),
        },
        Ok(r) => LocalPostOutcome::HttpStatus(r.status().as_u16()),
        Err(e) => {
            if e.is_connect() || e.is_request() {
                LocalPostOutcome::ConnectFail(format!("{e}"))
            } else if e.is_timeout() {
                LocalPostOutcome::Other(format!("超时: {e}"))
            } else {
                LocalPostOutcome::Other(format!("{e}"))
            }
        }
    }
}

/// vnet 数据面统一入口：对端 9100 → route_open → 本地签名 POST。
/// 失败如实返回 None；调用方不得因此回退 direct TCP。
async fn p2p_post_via_vnet(device: &str, path: &str, body: &Value) -> Option<Value> {
    p2p_post_via_vnet_with_client(device, path, body, http_tunnel()).await
}

async fn p2p_post_via_vnet_with_client(
    device: &str,
    path: &str,
    body: &Value,
    client: &reqwest::Client,
) -> Option<Value> {
    let local_port = match crate::vnet_forward::route_open(device, 9100, None).await {
        Ok(port) => port,
        Err(e) => {
            eprintln!("[p2p-vnet] {device} {path} 建链失败（不回退 direct）: {e}");
            return None;
        }
    };
    match p2p_post_via_local_with_client(client, local_port, path, body).await {
        LocalPostOutcome::Ok(v) => Some(v),
        LocalPostOutcome::HttpStatus(code) => {
            eprintln!("[p2p-vnet] {device} {path} → HTTP {code}");
            None
        }
        LocalPostOutcome::ConnectFail(e) => {
            eprintln!("[p2p-vnet] {device} {path} → 本地隧道连接失败: {e}");
            None
        }
        LocalPostOutcome::Other(e) => {
            eprintln!("[p2p-vnet] {device} {path} → 投递失败: {e}");
            None
        }
    }
}

/// 第96轮（修复3）：媒体端点 POST（60s 客户端；其余同 p2p_post）。
async fn p2p_post_media(dev: &PeerDevice, path: &str, body: &Value) -> Option<(Value, String)> {
    if crate::vnet_forward::transport_mode() == crate::vnet_forward::TransportMode::Vnet {
        let v = p2p_post_via_vnet_with_client(&dev.did, path, body, &http_media()).await?;
        return Some((v, format!("vnet://{}", dev.did)));
    }
    p2p_post_with(dev, path, body, http_media()).await
}

// ════ 地址健康度（2026-10-12 stale 地址探活淘汰）════════════════════════════
// presence 的"在线"只代表心跳，不代表地址可达（真机实测：手机异地换网后旧 v6
// 地址仍在名册，直推三连失败但 online=true——"假在线"）。投递即探活：
//   · 失败记一次；连续失败 ≥ CAP 的地址在候选构造时**沉底**（不删——全部坏时
//     仍要试，删了会从"慢"变"不可达"；沉底让好地址先试、坏地址保底）；
//   · 任何成功清零；距上次失败超 TTL 恢复（前缀轮换后旧地址永久坏，但不该
//     永久压制同串恢复/重新上报的场景）。
const ADDR_FAIL_CAP: u32 = 1;
const ADDR_TTL_MS: i64 = 10 * 60_000;

struct AddrRec {
    fails: u32,
    last_fail: i64,
}

static ADDR_HEALTH: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, AddrRec>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// 纯内核（单测直击）：当前健康分（0=好；≥CAP 且未过 TTL=坏）。
/// 2026-10-12 CAP 2→1（**首败即沉**）：真机拆账显示 stale 地址每个吃满 5s 超时、
/// 三个死地址 = 15s 白等，而真正能通的中继腿只要 1.3s——死地址不该有第二次
/// 机会排在好地址前面；成功随时清零回来。
fn addr_score_now(rec: Option<&AddrRec>, now: i64) -> u32 {
    match rec {
        None => 0,
        Some(r) => {
            if now - r.last_fail > ADDR_TTL_MS {
                0
            } else {
                r.fails
            }
        }
    }
}

fn addr_health_fail(url: &str) {
    let now = now_ms();
    let mut m = ADDR_HEALTH.lock().unwrap();
    let e = m.entry(url.to_string()).or_insert(AddrRec { fails: 0, last_fail: now });
    e.fails = e.fails.saturating_add(1);
    e.last_fail = now;
    if e.fails == ADDR_FAIL_CAP {
        eprintln!("[addr-health] 连续失败 {ADDR_FAIL_CAP} 次，候选沉底：{}", &url.chars().take(52).collect::<String>());
    }
}

fn addr_health_hit(url: &str) {
    let mut m = ADDR_HEALTH.lock().unwrap();
    if m.remove(url).is_some() {
        eprintln!("[addr-health] 地址恢复健康：{}", &url.chars().take(52).collect::<String>());
    }
}

/// 候选 URL 按健康分稳定排序（坏地址沉底；同分保持原序——lan→publicV4→ipv6
/// 的既有优先级在健康层之内保持）。
fn sort_by_health(urls: &mut [String]) {
    let now = now_ms();
    let score = |u: &String| -> u32 {
        let m = ADDR_HEALTH.lock().unwrap();
        addr_score_now(m.get(u), now)
    };
    urls.sort_by_key(|u| score(u));
}

// ── 设备级通道记忆（2026-10-12 热路径秒发）─────────────────────────────
// 直推刚全败过的账号记 10 分钟"中继优先"：期间 deliver_to_account **跳过直推**
// 直接走中继腿——死设备不再每次烧 2.5-5s 预算（真机拆账：直推 15s + 中继 1.3s
// = 16.5s 空窗的教训）。任何直推成功即清除（对端回同网，直连仍是最快路）。
static RELAY_PREF: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, i64>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
/// 2026-10-19 T4：10min → **2min**。直推失败记忆现在真的会命中（见 direct_push_leg），
/// 好友账号设备若被误判"中继优先"会 2 分钟不再直推、消息错误地等补发；2 分钟既覆盖
/// "连发/群扇出期间不再烧 5s"，又能自动重探恢复（原 10min 会让临时抖动代价过重）。
const RELAY_PREF_TTL_MS: i64 = 2 * 60_000;

fn dev_relay_pref(did: &str) -> bool {
    let now = now_ms();
    let mut m = RELAY_PREF.lock().unwrap();
    match m.get(did).copied() {
        Some(t) if now - t <= RELAY_PREF_TTL_MS => true,
        Some(_) => { m.remove(did); false }
        None => false,
    }
}

fn dev_relay_pref_clear(did: &str) {
    RELAY_PREF.lock().unwrap().remove(did);
}

fn dev_relay_pref_mark(did: &str) {
    RELAY_PREF.lock().unwrap().insert(did.to_string(), now_ms());
}

async fn p2p_post_with(dev: &PeerDevice, path: &str, body: &Value, c: reqwest::Client) -> Option<(Value, String)> {
    let raw = serde_json::to_string(body).unwrap_or_default();
    let auth = match p2p_auth(&raw) { Ok(a) => a, Err(e) => { eprintln!("[p2p-post] 签名失败: {e}"); return None } };
    let mut urls = urls_of(dev);
    sort_by_health(&mut urls);
    // 2026-10-12 直推总预算（5s）：多地址场景别把时间全烧给死地址——超预算剩
    // 余地址不再试（中继腿在后面等着，能通的路比死等快一个量级）。
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    for base in urls {
        if std::time::Instant::now() >= deadline {
            eprintln!("[p2p-post] 直推总预算（5s）耗尽，剩余地址不再试");
            break;
        }
        let url = format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'));
        match c
            .post(&url)
            .header("X-Myco-Auth", &auth)
            .header("content-type", "application/json")
            .body(raw.clone())
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                addr_health_hit(&url);
                let v = r.json::<Value>().await.unwrap_or(json!({ "ok": true }));
                return Some((v, base));
            }
            Ok(r) => {
                let st = r.status();
                let tx = r.text().await.unwrap_or_default();
                addr_health_fail(&url);
                eprintln!("[p2p-post] {} {} → HTTP {} {}", &url.chars().take(48).collect::<String>(), path, st, &tx.chars().take(120).collect::<String>());
            }
            Err(e) => {
                addr_health_fail(&url);
                eprintln!("[p2p-post] {} {} → 连接失败: {}", &url.chars().take(48).collect::<String>(), path, e);
            }
        }
    }
    None
}

// ══════ 账号名册（/presence/by-root；设备群信息 + 寻址兜底共用底座） ══════

/// /presence/by-root 名册缓存（单条目——设备群/自同步场景只查本机账号）。
struct RosterCache {
    fetched_at: i64,
    account: String,
    name: String,
    devices: Vec<Value>,
}
static ROSTER: std::sync::LazyLock<Mutex<Option<RosterCache>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

/// 名册缓存命中判定（纯函数，单测）：同账号（account_did_eq **canonical-only** 互认）且未过期
/// 才复用——切账号即失效，不串名册。
fn roster_cache_hit(c: &Option<RosterCache>, account: &str, now: i64, ttl_ms: i64) -> bool {
    match c {
        Some(r) => now - r.fetched_at < ttl_ms && core_id::account_did_eq(&r.account, account),
        None => false,
    }
}

/// 查账号名册（POST /presence/by-root {rootDid}，signed_post 设备签名）：返回
/// (账号名, 设备表)。设备表透传服务端行 {did,name,pubkeyB64,revoked,isEmbodiment,
/// online,lastSeen,addrs,kind,role}。进程内缓存一条；ttl_ms 由调用场景定（设备群
/// 信息 15s / 寻址兜底 30s——同一份数据两个消费节奏，短 ttl 消费者自然保新鲜）。
/// 失败 None（调用方按不可达兜底，不编造）。
pub(crate) async fn roster_by_root_cached(root_did: &str, ttl_ms: i64) -> Option<(String, Vec<Value>)> {
    let now = now_ms();
    {
        let c = ROSTER.lock().unwrap();
        if let Some(r) = c.as_ref() {
            if roster_cache_hit(&c, root_did, now, ttl_ms) {
                return Some((r.name.clone(), r.devices.clone()));
            }
        }
    }
    let resp = core_id::signed_post("/presence/by-root", &json!({ "rootDid": root_did })).await.ok()?;
    let name = resp.pointer("/data/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let devices = resp.pointer("/data/devices").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    *ROSTER.lock().unwrap() = Some(RosterCache {
        fetched_at: now,
        account: root_did.to_string(),
        name: name.clone(),
        devices: devices.clone(),
    });
    Some((name, devices))
}

// ══════ 发送直推 ══════

/// 寻址兜底决策（设备群设计 决策C，纯函数，单测）：账号寻址落空后，名册里哪些
/// 设备值得按 did 再查 presence。仅本机账号兜底（好友账号不扩——语义/成本收敛：
/// 好友在线本就该被 presence 账号聚合命中，落空=真离线）；revoked 跳过（名册
/// 除名即不可达，吊销设备的存量历史只读）。
pub fn roster_fallback_devices(account: &str, my: &str, roster: &[Value]) -> Vec<String> {
    if my.is_empty() || !core_id::account_did_eq(account, my) {
        return vec![];
    }
    roster
        .iter()
        .filter_map(|d| {
            let did = d.get("did").and_then(|v| v.as_str()).unwrap_or("");
            if did.is_empty() || d.get("revoked").and_then(|v| v.as_bool()).unwrap_or(false) {
                return None;
            }
            Some(did.to_string())
        })
        .collect()
}

/// 把信封直推给某账号的全部在线设备。任一送达=true（其余设备靠对账补齐）。
/// 账号寻址落空（presence 无该账号在线设备）→ 决策C 兜底：仅本机账号（设备群/
/// 自同步场景）查名册（30s 缓存），逐设备 did 再查 presence 直推——复用收编通知
/// 寻址思想（presence_device_by_did）：成员刚被收编、presence rootDid 还空着/旧值
/// 时按账号聚合找不到它，按设备 did 能命中。兜底透明作用于群扇出（targets 含本机
/// 账号）、离线队列 flush、typing——全走本函数。
pub async fn deliver_to_account(account: &str, envelope: &Value) -> bool {
    deliver_to_account_with(account, envelope, 6_000).await
}

/// 2026-10-12 预算分档：聊天首发用紧预算（4s，UI 快返回慢路交补发循环）；
/// **控制面（取票 share-entry / 回执）用宽预算**——真机复现：跨网中继隧道
/// （CONNECT 配对 + WS + AEAD + POST）远超 4s，紧预算把笔记本取票掐死成 502
/// "源设备不在线（或那台设备没有可直连的地址）"。
/// **直推腿（可独立 await / 后台 spawn）**：逐设备 p2p_post 到 `/p2p/msg`。
///
/// 2026-10-19 群扇出根因修复（T4）：
/// ① 原实现把"直推 loop"与"中继腿"**串行**排在 `deliver_to_account_with` 里——同账号
///    有一台 IPv6 不可达的笔记本（直推 5s 预算烧满）时，手机中继腿 100ms 能到却被
///    堵在后面（真机 3 条群消息 deliver-ok 全部 ~5.1s：直推 5029ms → 中继 103ms）。
///    现在直推可并行/后台跑，快路不再被慢路堵。
/// ② 原实现 `dev_relay_pref_mark` 标的是**中继目标 did（手机）**——而跳过判断查的是
///    **直推设备 did（笔记本）**，两者永不相等 → "首败后跳过直推"从未生效。
///    这里在直推失败时给**该设备自己**打 pref（成功清除），下条消息不再为它烧 5s。
/// M1-2 vnet 隧道兜底（非 async fn！oneshot 隔离避免 opaque type 环）：
/// 直推地址选路失败后，经 vnet 隧道（对端 9100 数据面）再试一次。
/// 根因：p2p_client 的地址选择在对端重启后拿不到可达地址（R22 实测 P50=5-8s 快路径全灭）；
/// vnet 隧道有独立候选赛跑+中继兜底（R23/影子已证秒级可达）。
/// 用 oneshot channel 隔离（Receiver<bool> 是具体类型，不引入 tunnel_open 的 future 类型链）。

/// M1-2 退避表：设备 did → 退避截止时间。失败后 30s 内不再为该设备烧赛跑预算。
/// 任一设备 vnet 隧道成功 → 全部清零（网络恢复信号）。
static M1_2_BACKOFF: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

const M1_2_BACKOFF_SECS: u64 = 30;

fn vnet_tunnel_fallback_spawn(did: String, envelope: Value) -> tokio::sync::oneshot::Receiver<bool> {
    // 退避检查：同一设备 30s 内失败过 → 跳过（只记一行，不刷屏）
    {
        let g = M1_2_BACKOFF.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(until) = g.get(&did) {
            if std::time::Instant::now() < *until {
                let remain = until.saturating_duration_since(std::time::Instant::now()).as_secs();
                eprintln!("[m1-2] {} 退避中（剩 {}s）", &did.chars().take(20).collect::<String>(), remain);
                let (tx, rx) = tokio::sync::oneshot::channel();
                let _ = tx.send(false);
                return rx;
            }
        }
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let ok = match crate::vnet_forward::route_open(&did, 9100, None).await {
            Ok(port) => {
                let sent = p2p_post_via_local(port, "/p2p/msg", &envelope).await.is_some();
                if sent {
                    eprintln!(
                        "[p2p-client] M1-2 vnet 隧道兜底送达 {}(port={})",
                        &did.chars().take(20).collect::<String>(),
                        port
                    );
                    // 成功 → 清全部退避（网络恢复信号，其它设备也该重试）
                    M1_2_BACKOFF.lock().unwrap_or_else(|e| e.into_inner()).clear();
                } else {
                    eprintln!(
                        "[p2p-client] M1-2 vnet 隧道开了(port={})但 /p2p/msg POST 失败 {}",
                        port,
                        &did.chars().take(20).collect::<String>()
                    );
                }
                sent
            }
            Err(e) => {
                eprintln!(
                    "[p2p-client] M1-2 tunnel_open 失败 {}: {}",
                    &did.chars().take(20).collect::<String>(),
                    &e.chars().take(80).collect::<String>()
                );
                false
            }
        };
        if !ok {
            // 失败 → 该设备退避 30s
            M1_2_BACKOFF
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(did.clone(), std::time::Instant::now() + std::time::Duration::from_secs(M1_2_BACKOFF_SECS));
        }
        let _ = tx.send(ok);
    });
    rx
}

async fn direct_push_leg(devs: Vec<PeerDevice>, envelope: Value, tag: &'static str) -> bool {
    let t0 = std::time::Instant::now();
    let mut ok = false;
    for d in &devs {
        // ══ M1-2 vnet 隧道兜底（2026-10-23 05:35 修复：绕过 relay_pref 跳过）══
        // 根因：原实现在 direct_push 失败 → relay_pref 标记后，后续消息 continue 跳过整个设备
        // （包括 vnet 兜底）→ 首条失败后所有消息都走 outbox 慢路（R22 实测 misses 全来自此）。
        // vnet 隧道是独立于 p2p_client 地址选择的通路（自己的候选赛跑+中继），应始终尝试。
        let rx = vnet_tunnel_fallback_spawn(d.did.clone(), envelope.clone());
        if rx.await.unwrap_or(false) {
            dev_relay_pref_clear(&d.did);
            ok = true;
            continue; // vnet 已送达，无需再直推
        }
        if crate::vnet_forward::transport_mode() == crate::vnet_forward::TransportMode::Vnet {
            // vnet-only：失败交给中继腿/补发环，不得回退 direct TCP。
            dev_relay_pref_mark(&d.did);
            eprintln!("[p2p-client] vnet-only：{} 建链/投递失败，不回落 direct TCP", d.did);
            continue;
        }
        // legacy 模式原直推路径（仅兼容旧模式；vnet 已在上方直接 continue）。
        if dev_relay_pref(&d.did) {
            continue; // 直推刚败过的设备（TTL 内）跳过直推（但上面 vnet 已试过）
        }
        if p2p_post(d, "/p2p/msg", &envelope).await.is_some() {
            dev_relay_pref_clear(&d.did); // 直推成功：清除中继偏好
            ok = true;
        } else {
            dev_relay_pref_mark(&d.did);
        }
    }
    crate::chat_service::chat_ui_trace(
        "backend".into(),
        format!("{tag} ok={ok} 耗时 {}ms", t0.elapsed().as_millis()),
    );
    ok
}

pub async fn deliver_to_account_with(account: &str, envelope: &Value, relay_budget_ms: u64) -> bool {
    let my_device = core_id::device_identity().map(|(d, _)| d).unwrap_or_default();
    // 一次 presence 查询同时算"直推清单"与"中继腿清单"（原实现中继腿再查一次网络）。
    let rows = presence_list().await;
    let devs = direct_devices_from_rows(&rows, account, &my_device);
    // ══ 中继目标（2026-10-18 晚 新任务：手机恒进中继目标；delivered 以手机回执为准）══
    //
    // 真机教训：`row_targets_account`/`account_did_eq` 在 GUI 进程里对本机账号出现过
    // "同串却 false"（deleg-diag 现场），presence 聚合因此恒 0 台 → 手机永远收不到推送。
    // 现在三层各自独立，手机永远置顶：
    //   ① 本地委任状（零网络，按 devicePubkeyB64 派生 did，手机优先）
    //   ② presence 行里 `kind=="phone"`（宽松账号判等，不受聚合抖动影响）
    //   ③ presence 聚合出的其它"直推够不到"设备（原口径）
    let my_acct = core_id::account_did().unwrap_or_default();
    let is_own_account = !my_acct.is_empty() && same_account_loose(account, &my_acct);
    let mut phone_targets: Vec<String> = Vec::new();
    let mut relay_candidates: Vec<String> = Vec::new();
    if is_own_account {
        let (local_targets, local_phones) = local_delegation_relay_targets(account, &my_device);
        for p in &local_phones {
            if !phone_targets.iter().any(|x| core_id::did_equiv(x, p)) {
                phone_targets.push(p.clone());
            }
        }
        relay_candidates.extend(local_targets);
        for p in presence_phone_targets(&rows, account, &my_device) {
            if !phone_targets.iter().any(|x| core_id::did_equiv(x, &p)) {
                phone_targets.push(p.clone());
            }
            relay_candidates.push(p);
        }
    }
    // ② 里可能已含本机账号的手机；③ 老口径并入（顺序在手机之后）
    relay_candidates.extend(relay_only_targets(&rows, account, &my_device, &devs));
    // 去重 + 排除直推覆盖/本机：手机先入 → 永远排第一（下游 truncate(1) 只试手机）
    let mut relay_targets: Vec<String> =
        merge_relay_targets(&phone_targets, &relay_candidates, &devs, &my_device);
    // 手机/委任状/presence 全落空时再试云名册（好友账号等场景；本机账号基本不会到）
    if relay_targets.is_empty() && !is_own_account {
        if let Some((_name, roster)) = roster_by_root_cached(account, 30_000).await {
            let roster_targets = roster_relay_targets(&roster, &my_device);
            relay_targets = merge_relay_targets(&[], &roster_targets, &devs, &my_device);
        }
    }
    // ══ 执行阶段（2026-10-19 T4 群扇出根因修复：直推 5s 慢路不得堵中继 100ms 快路）══
    //
    // 旧实现：直推 loop（笔记本 IPv6 不可达 = 每条烧满 5s 预算）→ 之后才走中继腿
    // → 群消息 deliver-ok 恒 ~5.1s（真机 trace：直推 5029ms → 中继 103ms）。
    // 现在：
    //   · 本机账号（手机回执门）：**只等中继腿**；直推其它设备改**后台补推**；
    //   · 好友/控制面：直推与中继**并行竞速**，任一成功立即返回；
    //   · 直推失败会给**该设备**打 relay_pref（见 direct_push_leg，原实现误标中继
    //     目标 did 导致跳过逻辑从未生效），下条消息不再为它烧 5s。
    let phone_required = is_own_account && !phone_targets.is_empty();
    let relay_fut = async {
        if relay_targets.is_empty() {
            return false;
        }
        deliver_via_relay_devices(&relay_targets, envelope, relay_budget_ms).await
    };

    if phone_required {
        let t2 = std::time::Instant::now();
        let relay_ok = relay_fut.await;
        let relay_ms = t2.elapsed().as_millis();
        // 手机已回执：直推其它设备放后台（不阻塞 UI / 群扇出时延）。
        #[cfg(feature = "gui")]
        {
            if !devs.is_empty() {
                let devs_bg = devs.clone();
                let env_bg = envelope.clone();
                tokio::spawn(async move {
                    let _ = direct_push_leg(devs_bg, env_bg, "直推(后台)").await;
                });
            }
        }
        crate::chat_service::chat_ui_trace(
            "backend".into(),
            format!(
                "[relay-targets] own={is_own_account} phones={} rows={} direct={} relayTargets={} ok={relay_ok} phoneAckRequired=true 耗时 {relay_ms}ms : {:?}",
                phone_targets.len(),
                rows.len(),
                devs.len(),
                relay_targets.len(),
                relay_targets
                    .iter()
                    .map(|d| &d[d.len().saturating_sub(8)..])
                    .collect::<Vec<_>>()
            ),
        );
        crate::chat_service::chat_ui_trace(
            "backend".into(),
            format!(
                "中继腿 ok={relay_ok} 耗时 {relay_ms}ms（直推够不到 {} 台；直推后台补推 {} 台）",
                relay_targets.len(),
                devs.len()
            ),
        );
        return relay_ok;
    }

    // 好友/控制面：直推与中继**并行竞速**，任一成功立即返回（快路不被慢路堵）。
    let t2 = std::time::Instant::now();
    let mut direct_fut = Box::pin(direct_push_leg(devs.clone(), envelope.clone(), "直推"));
    let mut relay_fut = Box::pin(relay_fut);
    let (mut direct_done, mut relay_done) = (false, false);
    let mut direct_ok = false;
    let mut relay_ok = false;
    loop {
        tokio::select! {
            d = &mut direct_fut, if !direct_done => { direct_done = true; direct_ok = d; }
            r = &mut relay_fut, if !relay_done => { relay_done = true; relay_ok = r; }
        }
        if direct_ok || relay_ok || (direct_done && relay_done) {
            break;
        }
    }
    let relay_ms = t2.elapsed().as_millis();
    crate::chat_service::chat_ui_trace(
        "backend".into(),
        format!(
            "[relay-targets] own={is_own_account} phones={} rows={} direct={} relayTargets={} ok={relay_ok} phoneAckRequired=false 耗时 {relay_ms}ms : {:?}",
            phone_targets.len(),
            rows.len(),
            devs.len(),
            relay_targets.len(),
            relay_targets
                .iter()
                .map(|d| &d[d.len().saturating_sub(8)..])
                .collect::<Vec<_>>()
        ),
    );
    crate::chat_service::chat_ui_trace(
        "backend".into(),
        format!(
            "中继腿 ok={relay_ok} 耗时 {relay_ms}ms（直推够不到 {} 台；直推 ok={direct_ok}）",
            relay_targets.len()
        ),
    );
    // 好友账号老口径兜底：直推全败且中继也没成 → 账号全部设备再经中继一次
    if !is_own_account && !direct_ok && !relay_ok {
        let untried: Vec<String> = account_device_targets(&rows, account, &my_device)
            .into_iter()
            .filter(|did| !relay_targets.iter().any(|x| core_id::did_equiv(x, did)))
            .collect();
        if !untried.is_empty() {
            relay_ok = deliver_via_relay_devices(&untried, envelope, relay_budget_ms).await;
        }
    }
    if direct_ok || relay_ok {
        return true;
    }
    // 兜底：仅本机账号。名册查不到（identity-svc 不可达）→ 空 targets，按不可达处理。
    let my = core_id::account_did().unwrap_or_default();
    let roster = roster_by_root_cached(account, 30_000).await.map(|(_, d)| d).unwrap_or_default();
    let targets = roster_fallback_devices(account, &my, &roster);
    let mut ok = false;
    for dev_did in &targets {
        if let Some(peer) = presence_device_by_did(dev_did).await {
            if p2p_post(&peer, "/p2p/msg", envelope).await.is_some() {
                ok = true;
            }
        }
    }
    ok
}

// ══════ 聊天持久隧道池（2026-10-19 Phase 2，指标 T3/T6/T7/T8）══════

/// 空闲多久发一次心跳探测（轻量 `POST /p2p/ping`；手机侧回 404 也算活着）。
const CHAT_TUNNEL_HEARTBEAT_AFTER_MS: u64 = 60_000;
/// 心跳巡检节拍。
const CHAT_TUNNEL_HEARTBEAT_TICK_MS: u64 = 30_000;
/// 单条心跳探测超时。
const CHAT_TUNNEL_HEARTBEAT_TIMEOUT_MS: u64 = 2_000;

/// 一条聊天持久隧道（per 设备）。
struct ChatTunnel {
    local_port: u16,
    last_used: std::time::Instant,
    /// false = 最近一次 POST 连接层失败，下一条消息必须重建。
    healthy: bool,
}

static CHAT_TUNNELS: std::sync::LazyLock<
    tokio::sync::Mutex<std::collections::HashMap<String, ChatTunnel>>,
> = std::sync::LazyLock::new(|| tokio::sync::Mutex::new(std::collections::HashMap::new()));

/// 冷建隧道全局锁：同一时刻只建一条（防多设备并发赛跑互踩）。
static RELAY_BUILD_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));
/// 投递串行锁：手机 RelayProvider 接单/解析是串行的，PC 并发 POST 会互相排队；
/// 串行反而保证**单条 TCP 复用**（T6 隧道复用率=1）并且不积压（稳态 600ms 间隔）。
static RELAY_POST_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));
static CHAT_HEARTBEAT_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 取（必要时冷建）某设备的聊天持久隧道本地口。失败=None（交给补发环）。
#[cfg(feature = "gui")]
async fn chat_tunnel_ensure(device: &str) -> Option<u16> {
    {
        let mut g = CHAT_TUNNELS.lock().await;
        if let Some(t) = g.get_mut(device) {
            if t.healthy {
                t.last_used = std::time::Instant::now();
                return Some(t.local_port);
            }
        }
    }
    // 与共享页/旧流程建的隧道合并（dsh_share TUNNELS 里已有就不要再建）。
    if let Some(port) = crate::dsh_share::tunnel_cached_port(device, 9100) {
        CHAT_TUNNELS.lock().await.insert(
            device.to_string(),
            ChatTunnel { local_port: port, last_used: std::time::Instant::now(), healthy: true },
        );
        return Some(port);
    }
    let _build = RELAY_BUILD_LOCK.lock().await;
    // 双检：等锁期间别的消息可能已经建好
    {
        let mut g = CHAT_TUNNELS.lock().await;
        if let Some(t) = g.get_mut(device) {
            if t.healthy {
                t.last_used = std::time::Instant::now();
                return Some(t.local_port);
            }
        }
    }
    if let Some(port) = crate::dsh_share::tunnel_cached_port(device, 9100) {
        CHAT_TUNNELS.lock().await.insert(
            device.to_string(),
            ChatTunnel { local_port: port, last_used: std::time::Instant::now(), healthy: true },
        );
        return Some(port);
    }
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        crate::dsh_share::tunnel_acquire_pub(device, 9100),
    )
    .await
    {
        Ok(Ok(port)) => {
            eprintln!("[p2p-relay] 聊天隧道建立（{device} → 本地 :{port}，后续复用）");
            CHAT_TUNNELS.lock().await.insert(
                device.to_string(),
                ChatTunnel { local_port: port, last_used: std::time::Instant::now(), healthy: true },
            );
            Some(port)
        }
        Ok(Err(e)) => {
            eprintln!("[p2p-relay] 聊天隧道建立失败（{device}）: {e}");
            None
        }
        Err(_) => {
            eprintln!("[p2p-relay] 聊天隧道建立超时 3s（{device}）");
            None
        }
    }
}

/// 标记隧道健康/刷新使用时间（成功后）。
#[cfg(feature = "gui")]
async fn chat_tunnel_mark_used(device: &str) {
    let mut g = CHAT_TUNNELS.lock().await;
    if let Some(t) = g.get_mut(device) {
        t.healthy = true;
        t.last_used = std::time::Instant::now();
    }
}

/// 隧道判定死亡：摘掉池条目 + 失效 dsh_share 缓存，下一条消息重建（T8）。
#[cfg(feature = "gui")]
async fn chat_tunnel_clear(device: &str) {
    CHAT_TUNNELS.lock().await.remove(device);
    crate::dsh_share::tunnel_acquire_invalidate(device, 9100);
}

/// **T8 测试钩子**：CLI `p2p tunnel drop --did <device>` 强杀指定设备的持久隧道。
/// 用于验证断线恢复（下一条消息应 ≤2s 重建）。返回被清理的状态描述。
#[cfg(feature = "gui")]
pub async fn debug_tunnel_drop(device: &str) -> Result<String, String> {
    let legs = crate::p2p_tunnel::debug_leg_drop(device);
    let had = CHAT_TUNNELS.lock().await.remove(device).is_some();
    crate::dsh_share::tunnel_acquire_invalidate(device, 9100);
    Ok(format!(
        "tunnel dropped: {} (chat_pool={} dsh_cache=invalidated active_legs_close_signaled={}){}",
        &device[device.len().saturating_sub(8)..],
        if had { "had_entry" } else { "no_entry" },
        legs,
        if legs == 0 { " warning=no_active_leg_matched" } else { "" }
    ))
}

/// 心跳是否到期（纯函数，单测直击）：healthy 且空闲 ≥60s。
fn chat_tunnel_heartbeat_due(healthy: bool, idle: std::time::Duration) -> bool {
    healthy && idle >= std::time::Duration::from_millis(CHAT_TUNNEL_HEARTBEAT_AFTER_MS)
}

/// 投递/心跳失败后是否**保留**隧道（纯函数，单测直击）：
/// 只有连接层失败（拒绝/重置/握手即断）才判死；HTTP 非 2xx、超时、读体错误都保留
/// ——它们多半只是"对端忙/协议层问题"，隧道本身还活着（T8 的判据不能过激）。
fn post_failure_keeps_tunnel(o: &LocalPostOutcome) -> bool {
    !matches!(o, LocalPostOutcome::ConnectFail(_))
}

/// 启动心跳巡检（进程内一次）：空闲 ≥60s 的持久隧道发一条轻量 `/p2p/ping`
/// （手机 data-face 回 404 keep-alive——**能应答即活着**），失败才判死重建。
/// 目的：T7「空闲 30/60/120s 后再发不重新握手」；同时避免手机 120s 空闲回收。
#[cfg(feature = "gui")]
fn chat_tunnel_heartbeat_start() {
    if CHAT_HEARTBEAT_STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(CHAT_TUNNEL_HEARTBEAT_TICK_MS)).await;
            let idle: Vec<(String, u16)> = {
                let g = CHAT_TUNNELS.lock().await;
                g.iter()
                    .filter(|(_, t)| chat_tunnel_heartbeat_due(t.healthy, t.last_used.elapsed()))
                    .map(|(k, t)| (k.clone(), t.local_port))
                    .collect()
            };
            for (did, port) in idle {
                let _post = RELAY_POST_LOCK.lock().await;
                let body = json!({ "ping": true });
                match tokio::time::timeout(
                    std::time::Duration::from_millis(CHAT_TUNNEL_HEARTBEAT_TIMEOUT_MS),
                    p2p_post_via_local_ex(port, "/p2p/ping", &body),
                )
                .await
                {
                    Ok(o) if post_failure_keeps_tunnel(&o) => {
                        // 200/404/超时/编码错：能应答或"可能只是慢"都保留，并续命。
                        chat_tunnel_mark_used(&did).await;
                        if matches!(o, LocalPostOutcome::HttpStatus(_)) {
                            // 404 = 手机 data-face 对未知路径的标准应答（心跳成功）
                        }
                    }
                    Ok(o) => {
                        if let LocalPostOutcome::ConnectFail(e) = o {
                            eprintln!("[p2p-relay] 隧道心跳连接失败 → 判死重建（{did}）: {e}");
                            chat_tunnel_clear(&did).await;
                        }
                    }
                    Err(_) => eprintln!("[p2p-relay] 隧道心跳超时（保留隧道，{did}）"),
                }
            }
        }
    });
}

/// 中继腿：**给定设备 did 清单**逐台经隧道投递，任一送达即 true。
/// 隧道由 `tunnel_acquire_pub` 提供（直连→打洞→云中继自动降级），到本地口发同款
/// 签名 `/p2p/msg`（对端手机侧由 `serveP2pDataFace` 应答）。
///
/// 2026-10-19 Phase 2（持久隧道）：不再每条消息 tunnel_acquire——`CHAT_TUNNELS`
/// 保存 per-device 持久隧道；命中 healthy 直接 POST（一条 TCP 复用 → 手机侧
/// keep-alive 继续解析，T6 握手次数=1）；连接层失败才摘除重建（T8）。
async fn deliver_via_relay_devices(devices: &[String], envelope: &Value, budget_ms: u64) -> bool {
    #[cfg(not(feature = "gui"))]
    {
        let _ = (devices, envelope, budget_ms);
        false
    }
    #[cfg(feature = "gui")]
    {
        if devices.is_empty() {
            return false;
        }
        let did = devices.first().cloned().unwrap_or_default();
        if did.is_empty() {
            return false;
        }
        chat_tunnel_heartbeat_start();
        tokio::time::timeout(std::time::Duration::from_millis(budget_ms), async {
            let Some(local_port) = chat_tunnel_ensure(&did).await else {
                return false;
            };
            // 串行 POST：单条 TCP 复用（T6）+ 适配手机串行接单（不积压）。
            let _post = RELAY_POST_LOCK.lock().await;
            match tokio::time::timeout(
                std::time::Duration::from_millis(4_000),
                p2p_post_via_local_ex(local_port, "/p2p/msg", envelope),
            )
            .await
            {
                Ok(LocalPostOutcome::Ok(_)) => {
                    dev_relay_pref_mark(&did); // 热路径记忆：下次跳过直推死路
                    chat_tunnel_mark_used(&did).await;
                    true
                }
                Ok(LocalPostOutcome::HttpStatus(code)) => {
                    // 对端数据面明确拒绝（如 403/404）——隧道活着，消息交给补发环。
                    eprintln!("[p2p-relay] 数据面拒绝 HTTP {code}（保留隧道，{did}）");
                    false
                }
                Ok(LocalPostOutcome::ConnectFail(e)) => {
                    eprintln!("[p2p-relay] 隧道连接失败 → 判死重建（{did}）: {e}");
                    chat_tunnel_clear(&did).await;
                    false
                }
                Ok(LocalPostOutcome::Other(e)) => {
                    // 超时/读体错误 ≠ 隧道死（可能只是手机 JS 忙）：保留隧道。
                    eprintln!("[p2p-relay] 隧道口投递异常（保留隧道，{did}）: {e}");
                    false
                }
                Err(_) => {
                    eprintln!("[p2p-relay] 隧道口 POST 超时 4000ms（{did}，保留持久隧道）");
                    false
                }
            }
        })
        .await
        .unwrap_or_else(|_| {
            eprintln!("[p2p-relay] 首发中继总预算（{budget_ms}ms）耗尽——交给补发循环");
            false
        })
    }
}

// ══════ 收编通知直推（2026-10-06 去中心化通讯架构：数据面 P2P 主路） ══════
// 主设备 add_device_by_did 成功后直推「收编通知」给成员设备——成员在线秒级触发
// 取件（不再等 20s watch 轮询）；离线/P2P 不可达 → false，deliverBox 信箱 +
// watch 轮询兜底（现有逻辑不动）。契约：kind=delegation-notify，payload 带
// { rootDid, accountName }；通知本体只是"去取件"提示，真授权凭证由成员侧取件链
// （名册反查 + 委任状验签 + nonce 去重）保证。

/// 收编通知信封（纯函数——单测断言契约面）。msgId 纳秒前缀（dn-）与普通聊天
/// 消息区分；不入会话、不进离线队列（信箱兜底已存在，滞留通知没有意义）。
pub fn delegation_notify_envelope(root_did: &str, from_device: &str, member_device_did: &str, account_name: &str) -> Value {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    json!({
        "msgId": format!("dn-{n:x}"),
        "from": root_did,
        "fromName": account_name,
        "fromDevice": from_device,
        "to": member_device_did,
        "kind": "delegation-notify",
        "payload": { "rootDid": root_did, "accountName": account_name },
        "ts": now_ms(),
    })
}

/// 主设备 → 成员设备「收编通知」直推。按【设备 did】寻址（成员未取委任状前
/// 不在主账号 presence 名册下）。返回是否送达——false=离线/不可达（信箱兜底），
/// 调用方不因此挡主流程。
pub async fn deliver_delegation_notify(member_device_did: &str, root_did: &str, account_name: &str) -> bool {
    let Some(dev) = presence_device_by_did(member_device_did).await else {
        eprintln!("[p2p] 收编通知：成员设备不在线/无直连地址（信箱兜底）: {member_device_did}");
        return false;
    };
    deliver_delegation_notify_to(&dev, root_did, account_name).await
}

/// 信封组装 + 单设备直推（集成测试指 mock 设备直打这层——不碰 presence 寻址）。
pub async fn deliver_delegation_notify_to(dev: &PeerDevice, root_did: &str, account_name: &str) -> bool {
    let my_device = core_id::device_identity().map(|(d, _)| d).unwrap_or_default();
    let envelope = delegation_notify_envelope(root_did, &my_device, &dev.did, account_name);
    p2p_post(dev, "/p2p/msg", &envelope).await.is_some()
}

/// typing 瞬时信号（不落盘；对端 emit p2p-typing）。
pub async fn typing_signal(account: &str, signal: &Value) -> bool {
    let devs = presence_devices(account).await;
    for d in &devs {
        if p2p_post(d, "/p2p/typing", signal).await.is_some() {
            return true;
        }
    }
    false
}

// ══════ 第96轮（修复3）：媒体分片传输（正文/媒体解耦的字节通道） ══════

/// 把媒体字节分片推给某账号的全部在线设备（1MB/片，b64 JSON 信封走签名链；
/// 60s 媒体客户端）。任一设备收齐=true（其余设备靠对账/按需拉取补齐）。
pub async fn deliver_media_chunks(account: &str, msg_id: &str, name: &str, mime: &str, sha256: &str, bytes: &[u8]) -> bool {
    let devs = presence_devices(account).await;
    if devs.is_empty() || bytes.is_empty() {
        return false;
    }
    let my = core_id::account_did().unwrap_or_default();
    let my_device = core_id::device_identity().map(|(d, _)| d).unwrap_or_default();
    let total = bytes.len().div_ceil(crate::chat_service::MEDIA_CHUNK_BYTES) as u32;
    let mut ok = false;
    for d in &devs {
        let mut all_ok = true;
        for idx in 0..total {
            let start = idx as usize * crate::chat_service::MEDIA_CHUNK_BYTES;
            let end = (start + crate::chat_service::MEDIA_CHUNK_BYTES).min(bytes.len());
            let body = json!({
                "from": my, "fromDevice": my_device, "msgId": msg_id,
                "name": name, "mime": mime, "sha256": sha256,
                "idx": idx, "total": total,
                "b64": base64::engine::general_purpose::STANDARD.encode(&bytes[start..end]),
            });
            if p2p_post_media(d, "/p2p/media/chunk", &body).await.is_none() {
                all_ok = false;
                break; // 该设备这片失败——整组作废（收不齐无意义），换下一设备
            }
        }
        if all_ok {
            ok = true;
        }
    }
    ok
}

/// 从单台设备分片拉媒体并落盘（先取 idx=0 拿 total，再逐片收齐；sha256 校验
/// 通过才落 media/{msgId}.{ext}）。成功 emit chat-media-ready（UI 刷新文件卡）。
pub async fn fetch_media_from_device(dev: &PeerDevice, mref: &crate::chat_service::MediaRef) -> bool {
    let my = core_id::account_did().unwrap_or_default();
    let my_device = core_id::device_identity().map(|(d, _)| d).unwrap_or_default();
    let fetch_one = |idx: u32| {
        let body = json!({ "from": my, "fromDevice": my_device, "msgId": mref.msg_id, "idx": idx });
        async move {
            let (resp, _) = p2p_post_media(dev, "/p2p/media/fetch", &body).await?;
            let b64 = resp.get("b64").and_then(|v| v.as_str())?;
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
            let total = resp.get("total").and_then(|v| v.as_u64())? as u32;
            Some((bytes, total))
        }
    };
    let Some((first, total)) = fetch_one(0).await else { return false };
    if total == 0 || total > 64 {
        return false;
    }
    let mut all = first;
    for idx in 1..total {
        let Some((bytes, _)) = fetch_one(idx).await else { return false };
        all.extend(bytes);
    }
    if crate::chat_service::sha256_hex(&all) != mref.sha256 {
        eprintln!("[p2p-media] {} 拉取 sha256 校验失败（{} 片 {}B）", mref.msg_id, total, all.len());
        return false;
    }
    match crate::chat_service::save_media_bytes(&mref.msg_id, &mref.name, &mref.mime, &all) {
        Ok(_) => {
            // cfg(not(test))：UI 事件通道（见文件顶 `use tauri::Emitter` 上方注释）。
            #[cfg(not(test))]
            if let Some(app) = current_app_handle() {
                let _ = app.emit("chat-media-ready", json!({ "msgId": mref.msg_id }));
            }
            true
        }
        Err(e) => {
            eprintln!("[p2p-media] {} 落盘失败: {e}", mref.msg_id);
            false
        }
    }
}

/// 按需拉媒体（chat_open_file re-fetch）：逐个账号的在线设备试拉，成一台即止。
pub async fn fetch_media_from_accounts(accounts: &[String], mref: &crate::chat_service::MediaRef) -> bool {
    for acc in accounts {
        if acc.is_empty() {
            continue;
        }
        for dev in presence_devices(acc).await {
            if fetch_media_from_device(&dev, mref).await {
                return true;
            }
        }
    }
    false
}

// ══════ 对账（指纹-索引两段式，流程见 p2p_sync.rs 模块头） ══════

/// 进行中的对账设备（防环：A↔B 互触发反向对账时的在飞去重）。
static IN_FLIGHT: std::sync::LazyLock<Mutex<HashSet<String>>> = std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

/// 与某账号的全部在线设备对账。emit p2p-sync-progress / p2p-sync-done。
/// 返回本次新收消息总数。
pub async fn sync_with_account(account: &str) -> usize {
    let devs = presence_devices(account).await;
    let mut got = 0usize;
    for d in devs {
        got += sync_with_device(&d, account).await.unwrap_or(0);
    }
    got
}

fn emit_progress(app: Option<&tauri::AppHandle>, v: Value) {
    // cfg(not(test))：UI 同步进度事件（见文件顶 `use tauri::Emitter` 上方注释）。
    #[cfg(not(test))]
    if let Some(app) = app {
        let _ = app.emit("p2p-sync-progress", v);
    }
    #[cfg(test)]
    let _ = (app, v); // cfg(test) 下 emit 不编译
}

/// 与单台设备对账：① digest ② 对比 F ③ index ④ batch（推我独有 / 拉我缺失）。
/// peer_account=对端账号 did（convId 视角映射用：对端眼中"与我的会话"以
/// 我的账号 did 命名，本地则以对端账号 did 命名——同一聊天两个名字）。
pub async fn sync_with_device(dev: &PeerDevice, peer_account: &str) -> Result<usize, String> {
    {
        let mut g = IN_FLIGHT.lock().unwrap();
        if !g.insert(dev.did.clone()) {
            return Ok(0); // 已在飞（互触发防环）
        }
    }
    let result = sync_with_device_inner(dev, peer_account).await;
    IN_FLIGHT.lock().unwrap().remove(&dev.did);
    result
}

async fn sync_with_device_inner(dev: &PeerDevice, peer_account: &str) -> Result<usize, String> {
    let my = core_id::account_did().ok_or("未登录")?;
    let my_device = core_id::device_identity().map(|(d, _)| d).unwrap_or_default();
    // 第95轮：对账开始事件（UI"正在同步消息…"状态条数据源；done 事件已有）
    emit_progress(current_app_handle().as_ref(), json!({ "start": true, "peer": dev.name }));
    let from_field = |conv_id: &str| {
        json!({ "from": my, "fromDevice": my_device, "convId": conv_id })
    };
    // ① 我方全部相关会话摘要（好友/共同群/自己全部会话——对方 server 闸自会过滤）
    let mut my_digests = serde_json::Map::new();
    for conv in crate::chat_service::my_conv_ids() {
        let m = crate::p2p_sync::load_meta(&conv);
        my_digests.insert(conv, m.digest_json());
    }
    let body = json!({ "from": my, "fromDevice": my_device, "convs": my_digests });
    let (resp, _base) = match p2p_post(dev, "/p2p/sync/digest", &body).await {
        Some(x) => x,
        None => return Err(format!("digest 不通（{}）", dev.name)),
    };
    let peer_convs = match resp.get("convs").and_then(|c| c.as_object()) {
        Some(c) => c.clone(),
        None => { eprintln!("[sync] digest 响应无 convs: {}", resp); return Ok(0) }
    };
    eprintln!("[sync] digest ok：对方会话 {} 个：{:?}", peer_convs.len(), peer_convs.keys().collect::<Vec<_>>());
    // ② 逐会话对比 F，不同则精对。
    // convId 视角映射：对端响应里的单聊 convId=did_safe(我的账号)（对端眼中
    // "与我的会话"）；本地同一聊天存为 did_safe(对端账号)。群 convId 双方一致。
    let my_did_safe = my.replace([':', '/'], "_");
    let peer_did_safe = peer_account.replace([':', '/'], "_");
    let mut total_got = 0usize;
    let mut total_pushed = 0usize;
    for (conv_id, pd) in &peer_convs {
        let local_conv = if *conv_id == my_did_safe { peer_did_safe.clone() } else { conv_id.clone() };
        let my_meta = crate::p2p_sync::load_meta(&local_conv);
        let peer_f = pd.get("F").and_then(|f| f.as_str()).unwrap_or("");
        let eq = crate::p2p_sync::f_equal(&my_meta.f_hex, peer_f);
        eprintln!(
            "[sync] 对端会话 {} → 本地 {}：我的 n={} vs 对方 F={:8} → {}",
            &conv_id.chars().take(20).collect::<String>(),
            &local_conv.chars().take(20).collect::<String>(),
            my_meta.n,
            peer_f,
            if eq { "一致跳过" } else { "差异对账" }
        );
        if eq {
            continue; // 已同步
        }
        // ③ 拉对方索引（convId 用对端视角名——对端按自己的会话文件查）
        let req = from_field(conv_id);
        let (idx, _) = match p2p_post(dev, "/p2p/sync/index", &req).await {
            Some(x) => x,
            None => continue,
        };
        let theirs: Vec<(String, i64)> = idx
            .get("ids")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|e| {
                        let arr = e.as_array()?;
                        Some((arr.first()?.as_str()?.to_string(), arr.get(1)?.as_i64().unwrap_or(0)))
                    })
                    .collect()
            })
            .unwrap_or_default();
        // ④ 差集 → 推我独有 / 拉我缺失（分批；本地读写用 local_conv）
        let (push, pull) = crate::p2p_sync::diff_ids(&my_meta.ids, &theirs);
        eprintln!("[sync] index {} 条 → push {} / pull {}", theirs.len(), push.len(), pull.len());
        let local = crate::chat_service::conv_load_raw(&local_conv);
        let push_msgs: Vec<Value> = local
            .iter()
            .filter(|m| {
                let id = m.get("msgId").and_then(|v| v.as_str()).unwrap_or("");
                push.iter().any(|(pid, _)| pid == id)
            })
            .map(crate::chat_service::wire_pack_msg)
            .collect();
        let want: Vec<String> = pull.iter().map(|(id, _)| id.clone()).collect();
        let mut got = 0usize;
        // 分批推+尾批带 want（一次往返双向收敛）
        // 第96轮（修复2）：批次双闸——条数 ≤50 且累计字节 ≤12MB（媒体 b64 内联时
        // 纯条数闸拦不住：5×2MB 图就超服务端 16MB body limit → 413 对账卡死）。
        let batches: Vec<(Vec<Value>, Vec<String>)> = if push_msgs.is_empty() && !want.is_empty() {
            vec![(vec![], want)]
        } else {
            let mut out: Vec<(Vec<Value>, Vec<String>)> = crate::p2p_sync::chunk_wire_msgs(
                push_msgs,
                SYNC_CHUNK,
                crate::p2p_sync::SYNC_BATCH_BYTE_BUDGET,
            )
            .into_iter()
            .map(|c| (c, vec![]))
            .collect();
            if !want.is_empty() {
                let last = out.last_mut();
                match last {
                    Some((_, w)) => *w = want.clone(),
                    None => out.push((vec![], want.clone())),
                }
            }
            out
        };
        for (msgs, want_batch) in batches {
            let mut req = from_field(conv_id);
            req["msgs"] = json!(msgs);
            if !want_batch.is_empty() {
                req["want"] = json!(want_batch);
            }
            if let Some((resp, _)) = p2p_post(dev, "/p2p/sync/batch", &req).await {
                eprintln!("[sync] batch 回包 msgs={} 条 kept={:?}", resp.get("msgs").and_then(|m| m.as_array()).map(|a| a.len()).unwrap_or(0), resp.get("kept"));
                if let Some(incoming) = resp.get("msgs").and_then(|m| m.as_array()) {
                    for m in incoming {
                        // 第96轮（修复3）：对账拉到 file+mediaRef → 媒体分片从同一
                        // 对端拉（spawn 不阻塞对账主流程；收齐 emit chat-media-ready）。
                        if let Some(mref) = crate::chat_service::msg_needs_media(m) {
                            let dev2 = dev.clone();
                            tauri::async_runtime::spawn(async move {
                                let ok = fetch_media_from_device(&dev2, &mref).await;
                                eprintln!("[sync] 媒体分片拉取 {} → {}", mref.msg_id, if ok { "成功" } else { "失败（open_file 可再试）" });
                            });
                        }
                        let app = current_app_handle();
                        if let Some(app) = app {
                            if crate::chat_service::ingest_p2p(&app, m).await.unwrap_or(false) {
                                got += 1;
                            }
                        }
                    }
                }
            }
        }
        total_got += got;
        total_pushed += push.len();
        emit_progress(
            current_app_handle().as_ref(),
            json!({ "peer": dev.name, "convId": conv_id, "got": got, "pushed": push.len() }),
        );
    }
    if total_got + total_pushed > 0 {
        emit_progress(
            current_app_handle().as_ref(),
            json!({ "done": true, "peer": dev.name, "got": total_got, "pushed": total_pushed }),
        );
    }
    Ok(total_got)
}

// ══════ 对账循环 ══════

/// AppHandle 全局暂存（p2p_server/loop 的事件发射点；setup 时写入）。
pub static APP_HANDLE: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);

/// 取当前 AppHandle（同步事件发射用）。
pub fn current_app_handle() -> Option<tauri::AppHandle> {
    APP_HANDLE.lock().unwrap().clone()
}

/// 后台对账循环：60s 一轮，对本机账号（多设备自同步）+ 全部 ok 好友的在线设备
/// 发起对账——"有人上线就快速对账共享"。在线判定在 presence_devices 内
/// （不在线=空列表=本轮跳过）。
pub fn start_sync_loop() {
    // 反向拨号循环（2026-10-09）：presence 里带 wantReverse 的手机（同账号/好友）
    // → 主动拨过去开反向隧道。测试态 no-op（reverse_dialer_start 内 cfg 门）。
    crate::p2p_tunnel::reverse_dialer_start();
    // 云端中继 Provider（⑨ 2026-10-11）：常驻注册到 identity-svc:8322——对端
    // 直连全不通（双方都在 NAT 后）时经中继进本机 p2p 服务器（隧道协议/闸门
    // 原样）。幂等 + 断线指数退避重连；测试态 no-op。
    crate::p2p_tunnel::relay_provider_start();
    tauri::async_runtime::spawn(async move {
        // 等 p2p 服务器与身份就绪（最多 30s）
        for _ in 0..30 {
            if crate::p2p_server::p2p_port() > 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        loop {
            if let Some(my) = core_id::account_did() {
                let mut accounts: Vec<String> = vec![my.clone()];
                accounts.extend(crate::chat_service::ok_friend_dids());
                // 第95轮：有待发的账号先补发（对方上线即送达，不等对账收敛）——
                // flush_outbox_for 内部 has_pending 快路径，无待发零开销。
                for a in &accounts {
                    let _ = crate::chat_service::flush_outbox_for(a).await;
                }
                for a in accounts {
                    let got = sync_with_account(&a).await;
                    if got > 0 {
                        // cfg(not(test))：UI 事件通道（见文件顶 `use tauri::Emitter` 上方注释）。
                        #[cfg(not(test))]
                        if let Some(app) = current_app_handle() {
                            let _ = app.emit("p2p-sync-done", json!({ "account": a, "got": got }));
                        }
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
}

// ══════════════ 2026-10-06 收编通知 P2P 直推 单测（纯函数——不碰网不碰盘） ══════════════
// 全链 mock（presence/注册/对端 P2P 监听）的送达+失败面在 tests/delegation_notify.rs
// 独立进程跑（MYCO_CONFIG_DIR/MYCO_DID_BASE 进程级 OnceLock，不能与 lib 测试共享进程）。

#[cfg(test)]
mod delegation_notify_tests {
    use super::*;

    /// 确定性设备（tag 即种子；did=canonical 自派生，与产线同法）。
    fn dev_did(tag: u8) -> String {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[tag; 32]);
        core_id::did_from_public(&sk.verifying_key().to_bytes())
    }

    fn entry(did: &str, kind: &str, addrs: Value) -> Value {
        json!({ "did": did, "name": "laptop", "kind": kind, "rootDid": Value::Null, "addrs": addrs })
    }

    /// 收编寻址：成员设备未入主账号名册（rootDid=null）也能按设备 did 命中。
    #[test]
    fn pick_finds_member_device_without_roster_root() {
        let member = dev_did(1);
        let list = vec![
            entry(&dev_did(9), "pc", json!({ "ipv6List": ["3fff::1"], "port": 9100 })), // 路人
            entry(&member, "pc", json!({ "ipv6List": ["3fff::2", "fe80::x"], "port": 9101 })),
        ];
        let dev = pick_peer_device(&list, &member, &dev_did(3)).expect("应命中成员设备");
        assert_eq!(dev.did, member);
        assert_eq!(dev.addrs, vec!["3fff::2".to_string(), "fe80::x".to_string()]);
        assert_eq!(dev.port, 9101);
    }

    /// canonical 双前缀互认（did_equiv 按公钥字节归一）；**legacy 已废止 → 不再命中**
    /// （2026-10-10 canonical-only）。
    #[test]
    fn pick_matches_canonical_forms_and_rejects_legacy() {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let pk = sk.verifying_key().to_bytes();
        let canonical = core_id::did_from_public(&pk);                          // did:myco:z…
        let youling = canonical.replacen("did:myco:", "did:youling:", 1);       // 同钥另一前缀
        let legacy = format!("did:myco:{}", bs58::encode(pk).into_string());    // 已废止形态
        let list = vec![entry(&youling, "pc", json!({ "ipv6": "3fff::9", "port": 9100 }))];
        // 列表里是另一 canonical 前缀，查询给 canonical → 同钥命中；单值 ipv6 旧字段也认
        let dev = pick_peer_device(&list, &canonical, "did:myco:someoneelse").expect("canonical 双前缀应互认");
        assert_eq!(dev.addrs, vec!["3fff::9".to_string()]);
        // legacy 已废止：列表给 legacy、查询给 canonical → 不命中（旧行为是同钥互认）
        let legacy_list = vec![entry(&legacy, "pc", json!({ "ipv6": "3fff::9", "port": 9100 }))];
        assert!(pick_peer_device(&legacy_list, &canonical, "did:myco:someoneelse").is_none(),
            "legacy 已废止：不再互认");
    }

    /// 过滤面：本机设备跳过（不自推）/ 非 pc（手机无 P2P 服务器）跳过 /
    /// 无直连地址跳过 / 不在列表 → None（信箱兜底语义）。
    #[test]
    fn pick_filters_self_phone_noaddrs_missing() {
        let me = dev_did(1);
        let phone = dev_did(2);
        let noaddr = dev_did(3);
        let list = vec![
            entry(&me, "pc", json!({ "ipv6List": ["3fff::1"], "port": 9100 })),
            entry(&phone, "phone", json!({ "ipv6List": ["3fff::2"], "port": 9100 })),
            entry(&noaddr, "pc", Value::Null),
        ];
        assert!(pick_peer_device(&list, &me, &me).is_none(), "本机设备不自推");
        assert!(pick_peer_device(&list, &phone, &me).is_none(), "手机无 P2P 服务器");
        assert!(pick_peer_device(&list, &noaddr, &me).is_none(), "无地址不可达");
        assert!(pick_peer_device(&list, &dev_did(8), &me).is_none(), "不在线=None（信箱兜底）");
    }

    /// 信封契约：kind=delegation-notify + payload {rootDid, accountName} + from/to 齐。
    #[test]
    fn notify_envelope_contract() {
        let root = "did:youling:zMaster";
        let master_dev = dev_did(1);
        let member = dev_did(2);
        let env = delegation_notify_envelope(root, &master_dev, &member, "Fan");
        assert_eq!(env["kind"], json!("delegation-notify"));
        assert_eq!(env["from"], json!(root));
        assert_eq!(env["fromDevice"], json!(master_dev));
        assert_eq!(env["fromName"], json!("Fan"));
        assert_eq!(env["to"], json!(member));
        assert_eq!(env["payload"], json!({ "rootDid": root, "accountName": "Fan" }));
        assert!(env["msgId"].as_str().unwrap().starts_with("dn-"));
        assert!(env["ts"].as_i64().unwrap() > 0);
    }
}

// ══════════════ 2026-10-07 P2P 寻址相等性（前缀 × 格式不敏感）单测 ══════════════
// 背景：presence 上报的 rootDid 来自 account_did()（归一到 did:youling:），好友锚/会话 id
// 多是名册历史形态 did:myco:。裸串相等 ⇒ presence_devices 恒空 ⇒ deliver_to_account
// 直接 false ⇒ 消息永趴 outbox（UI 恒"⏳ 发送中（对方上线后自动送达）"）。

#[cfg(test)]
mod presence_addressing_tests {
    use super::*;

    /// 确定性密钥 → (canonical `did:myco:z…`, 同钥另一 canonical 前缀 `did:youling:z…`,
    /// **已废止** legacy 裸 base58 串——只作反例)。
    fn forms(tag: u8) -> (String, String, String) {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[tag; 32]);
        let pk = sk.verifying_key().to_bytes();
        let canonical = core_id::did_from_public(&pk);
        let youling = canonical.replacen("did:myco:", "did:youling:", 1);
        let legacy = format!("did:myco:{}", bs58::encode(pk).into_string());
        (canonical, youling, legacy)
    }

    fn row(did: &str, root: &str) -> Value {
        json!({ "did": did, "kind": "pc", "name": "pc", "rootDid": root,
                "addrs": { "ipv6List": ["3fff::1"], "port": 9101 } })
    }

    /// 根因回归：rootDid 归一形 vs 好友锚另一前缀 canonical——同钥必须命中（双向）；
    /// **legacy 已废止**（2026-10-10 canonical-only）：不再命中。
    #[test]
    fn row_matches_account_across_canonical_prefixes_only() {
        let (peer_myco, peer_youling, peer_legacy) = forms(7);
        assert_ne!(peer_myco, peer_youling);
        // 上报 did:youling:z…（端侧归一形），查询 did:myco:z…（另一前缀 canonical）→ 命中
        assert!(row_targets_account(&row("did:myco:zDevX", &peer_youling), &peer_myco));
        // 反向同样成立
        assert!(row_targets_account(&row("did:myco:zDevX", &peer_myco), &peer_youling));
        // 同一个串当然也命中
        assert!(row_targets_account(&row("did:myco:zDevX", &peer_youling), &peer_youling));
        // legacy 已废止：两侧任一为 legacy 都不命中（同公钥也不算）
        assert!(!row_targets_account(&row("did:myco:zDevX", &peer_youling), &peer_legacy), "legacy 查询不再命中");
        assert!(!row_targets_account(&row("did:myco:zDevX", &peer_legacy), &peer_youling), "legacy 上报不再命中");
    }

    /// 反向守卫：不同公钥不得误命中；rootDid 为空（未入名册的收编成员）不按账号命中。
    #[test]
    fn row_does_not_match_other_account_or_empty_root() {
        let (peer_myco, _py, _pl) = forms(7);
        let (_o, other_youling, _ol) = forms(8);
        assert!(!row_targets_account(&row("did:myco:zDevX", &other_youling), &peer_myco));
        assert!(!row_targets_account(&row("did:myco:zDevX", ""), &peer_myco));
    }

    /// 本机设备自筛走 did_equiv：canonical 双前缀两种写法都要认成"自己"丢掉，
    /// 别人的设备仍要保留（否则会对本机自投或漏掉真对端）；legacy 形态不再认。
    #[test]
    fn peer_from_entry_excludes_own_device_in_canonical_forms() {
        let (canon_me, youling_me, legacy_me) = forms(3);
        assert!(peer_from_entry(&row(&canon_me, "x"), &youling_me).is_none(), "同钥另一 canonical 前缀也是自己");
        assert!(peer_from_entry(&row(&youling_me, "x"), &canon_me).is_none(), "反向同");
        // legacy 已废止：不再认成自己（保留为对端；连接闸门会在验签处拒）
        assert!(peer_from_entry(&row(&legacy_me, "x"), &canon_me).is_some(), "legacy 不再被认成本机");
        let (other, _oy, _ol) = forms(5);
        assert!(peer_from_entry(&row(&other, "x"), &canon_me).is_some(), "真对端必须保留");
    }

    /// 过滤面不回归：非 pc / 无地址 / 空 did 仍然 None。
    #[test]
    fn peer_from_entry_still_filters_non_pc_and_noaddrs() {
        let (other, _oy, _ol) = forms(5);
        let me = forms(3).0;
        assert!(peer_from_entry(&json!({ "did": other, "kind": "phone", "rootDid": "x",
            "addrs": { "ipv6List": ["3fff::2"], "port": 9100 } }), &me).is_none());
        assert!(peer_from_entry(&row(&other, "x"), &me).is_some());
        assert!(peer_from_entry(&json!({ "did": other, "kind": "pc", "rootDid": "x", "addrs": Value::Null }), &me).is_none());
    }

    /// 2026-10-09 多路径寻址：addrs 收集顺序必须是 **lan → publicV4 → ipv6**（选路顺序
    /// = 数组顺序），且每条 URL 记法正确（IPv6 带方括号）；只有 ipv6 的存量上报不回归。
    #[test]
    fn peer_from_entry_collects_addrs_in_path_order() {
        let (other, _oy, _ol) = forms(5);
        let me = forms(3).0;
        let e = json!({ "did": other, "kind": "pc", "name": "peer", "rootDid": "x",
            "addrs": { "ipv6List": ["3fff:1::2", "3fff:9::3"], "lanList": ["192.168.1.5", "10.0.0.8"],
                       "publicV4List": ["203.0.113.7"], "port": 9101 } });
        let dev = peer_from_entry(&e, &me).expect("三类地址齐备应在册");
        assert_eq!(
            dev.addrs,
            vec!["192.168.1.5", "10.0.0.8", "203.0.113.7", "3fff:1::2", "3fff:9::3"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>(),
            "顺序必须是 lan → publicV4 → ipv6"
        );
        assert_eq!(
            urls_of(&dev),
            vec![
                "http://192.168.1.5:9101",
                "http://10.0.0.8:9101",
                "http://203.0.113.7:9101",
                "http://[3fff:1::2]:9101",
                "http://[3fff:9::3]:9101",
            ],
            "逐地址实测的顺序即选路顺序"
        );
        // 单值键（旧/手工上报）也认：lan 单值 + publicV4 单值 + 存量 ipv6 单值
        let single = json!({ "did": other, "kind": "pc", "rootDid": "x",
            "addrs": { "lan": "192.168.1.5", "publicV4": "203.0.113.7", "ipv6": "3fff::9", "port": 9100 } });
        assert_eq!(
            peer_from_entry(&single, &me).unwrap().addrs,
            vec!["192.168.1.5", "203.0.113.7", "3fff::9"].into_iter().map(String::from).collect::<Vec<_>>()
        );
        // 只有 lan 的设备也进候选（老版本的 IPv6-only 口径之外新增可达性）
        let lan_only = json!({ "did": other, "kind": "pc", "rootDid": "x",
            "addrs": { "lanList": ["192.168.1.5"], "port": 9100 } });
        assert_eq!(peer_from_entry(&lan_only, &me).unwrap().addrs, vec!["192.168.1.5".to_string()]);
    }

    /// 2026-10-09 反射地址：`reflexive` 类别进候选，**排在 publicV4 之后、ipv6 之前**
    /// （直接持有的公网 IPv4 无条件可达；反射地址要看 NAT 映射，故列其后）。
    /// 双键形态（`reflexiveList` / 单值 `reflexive`）都认。
    #[test]
    fn peer_from_entry_collects_reflexive_after_public_v4() {
        let (other, _oy, _ol) = forms(6);
        let me = forms(3).0;
        let e = json!({ "did": other, "kind": "pc", "name": "peer", "rootDid": "x",
            "addrs": { "lanList": ["192.168.1.5"], "publicV4List": ["203.0.113.7"],
                       "reflexiveList": ["198.51.100.9", "198.51.100.10"],
                       "ipv6List": ["3fff:1::2"], "port": 9100 } });
        let dev = peer_from_entry(&e, &me).expect("四类地址齐备应在册");
        assert_eq!(
            dev.addrs,
            vec!["192.168.1.5", "203.0.113.7", "198.51.100.9", "198.51.100.10", "3fff:1::2"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>(),
            "顺序必须是 lan → publicV4 → reflexive → ipv6"
        );
        // 单值形态（旧/手工上报）
        let single = json!({ "did": other, "kind": "pc", "rootDid": "x",
            "addrs": { "reflexive": "198.51.100.9", "port": 9100 } });
        assert_eq!(peer_from_entry(&single, &me).unwrap().addrs, vec!["198.51.100.9".to_string()]);
        // 只有反射地址（NAT 后方的典型设备）也进候选——这正是"对端可能可达"的来源
        assert_eq!(
            urls_of(&peer_from_entry(&single, &me).unwrap()),
            vec!["http://198.51.100.9:9100"]
        );
    }
}

// ══════════════ 2026-10-07：设备群寻址兜底（决策C）单测 ══════════════
// 纯函数面：兜底只扩本机账号 / revoked 跳过 / 名册缓存命中与账号切换失效。
// 全链 mock（presence 落空→by-root 命中→直推）的集成面由 E2E 收口做。

#[cfg(test)]
mod device_fallback_tests {
    use super::*;

    fn dev_did(tag: u8) -> String {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[tag; 32]);
        core_id::did_from_public(&sk.verifying_key().to_bytes())
    }

    fn roster_row(did: &str, revoked: bool) -> Value {
        json!({ "did": did, "name": "dev", "pubkeyB64": "AAAA", "revoked": revoked,
                "isEmbodiment": false, "online": true, "lastSeen": 1, "addrs": null, "kind": "pc", "role": null })
    }

    /// 本机账号落空 → 名册兜底给出未吊销设备 did（revoked 跳过）；同钥双前缀形态
    /// 的本机账号同样命中（account_did_eq 归一）。
    #[test]
    fn fallback_only_for_own_account_and_skips_revoked() {
        let my = dev_did(1);
        let member = dev_did(2);
        let revoked_dev = dev_did(3);
        let roster = vec![roster_row(&member, false), roster_row(&revoked_dev, true)];
        let targets = roster_fallback_devices(&my, &my, &roster);
        assert_eq!(targets, vec![member.clone()], "revoked 设备必须跳过");
        // 本机账号的双前缀形态（名册/账号 did 历史形态互认）
        let my_youling = my.replacen("did:myco:", "did:youling:", 1);
        assert_eq!(roster_fallback_devices(&my_youling, &my, &roster), vec![member.clone()]);
        // 空 did 行不产出目标
        let dirty = vec![json!({ "did": "", "revoked": false })];
        assert!(roster_fallback_devices(&my, &my, &dirty).is_empty());
    }

    /// 好友账号不兜底（语义/成本收敛）：即便名册有行也一律空。
    #[test]
    fn fallback_never_extends_to_friend_accounts() {
        let my = dev_did(4);
        let friend = dev_did(5);
        let roster = vec![roster_row(&dev_did(6), false)];
        assert!(roster_fallback_devices(&friend, &my, &roster).is_empty(), "好友账号不得扩兜底");
        // my 未知（未登录）也一律不兜底
        assert!(roster_fallback_devices(&my, "", &roster).is_empty());
    }

    /// 核心场景链（纯函数链）：成员设备刚被收编、presence 行 rootDid 还是空 →
    /// 按账号聚合落空（row_targets_account=false）……但名册兜底给出设备 did，
    /// 按设备 did 能命中（pick_peer_device，收编通知同款寻址）——「presence 落空 →
    /// by-root 命中」的决策C 实证。
    #[test]
    fn fallback_hits_member_by_device_did_when_account_lookup_empty() {
        let my = dev_did(7);
        let member = dev_did(8);
        // presence 在线列表：成员在线但 rootDid 空（未取委任状，不在任何账号聚合下）
        let presence_row = json!({ "did": member, "kind": "pc", "name": "member-pc", "rootDid": "",
                "addrs": { "ipv6List": ["3fff::5"], "port": 9100 } });
        assert!(!row_targets_account(&presence_row, &my), "前置：按账号聚合确实落空");
        let roster = vec![roster_row(&member, false)];
        let targets = roster_fallback_devices(&my, &my, &roster);
        assert_eq!(targets, vec![member.clone()]);
        let peer = pick_peer_device(&[presence_row], &member, &dev_did(9))
            .expect("按设备 did 必须命中（收编通知同款寻址）");
        assert_eq!(peer.did, member);
        assert_eq!(peer.addrs, vec!["3fff::5".to_string()]);
    }

    /// 名册缓存命中判定：同账号+新鲜命中；过期/换账号/空缓存不命中——30s 兜底与
    /// 15s 设备群信息两个消费节奏共用一条缓存，短 ttl 消费者自然保新鲜。
    #[test]
    fn roster_cache_freshness_and_account_invalidation() {
        let mk = |acc: &str, at: i64| RosterCache {
            fetched_at: at,
            account: acc.to_string(),
            name: "n".into(),
            devices: vec![],
        };
        let now = 100_000i64;
        // canonical 账号 did（2026-10-10 canonical-only：认公钥级同一账号，不再认软 did 前缀孪生）
        let sk = ed25519_dalek::SigningKey::from_bytes(&[0x2bu8; 32]);
        let a = core_id::did_from_public(&sk.verifying_key().to_bytes()); // did:myco:z…
        assert!(roster_cache_hit(&Some(mk(&a, now - 5_000)), &a, now, 30_000), "新鲜命中");
        assert!(!roster_cache_hit(&Some(mk(&a, now - 40_000)), &a, now, 30_000), "过期不命中");
        assert!(!roster_cache_hit(&Some(mk(&a, now - 20_000)), &a, now, 15_000), "15s 消费者对 20s 旧数据不命中");
        let other = core_id::did_from_public(&[0x2cu8; 32]);
        assert!(!roster_cache_hit(&Some(mk(&other, now)), &a, now, 30_000), "换账号即失效");
        assert!(!roster_cache_hit(&None, &a, now, 30_000), "空缓存不命中");
        // 同钥双前缀 canonical（另一 method 写法）视为同账号命中
        let a_youling = a.replacen("did:myco:", "did:youling:", 1);
        assert!(roster_cache_hit(&Some(mk(&a, now)), &a_youling, now, 30_000));
    }
}

// ── 2026-10-18 task-7：直推够不到的设备（手机）必须独立走中继腿 ──────────
#[cfg(test)]
#[cfg(test)]
mod relay_targets_tests {
    use super::*;

    fn dev_did(tag: u8) -> String {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[tag; 32]);
        core_id::did_from_public(&sk.verifying_key().to_bytes())
    }

    #[test]
    fn phone_is_relay_only_while_pc_is_direct() {
        let account = dev_did(1);
        let my = dev_did(2); // 本机 = 另一台 pc
        let pc = dev_did(3);
        let phone = dev_did(4);
        let rows = vec![
            // 本机自己：任何清单都不应包含
            json!({ "did": my, "kind": "pc", "rootDid": account,
                    "addrs": { "lanList": ["192.168.1.9"], "port": 9100 } }),
            // 同账号在线 PC：有直连地址 → 直推清单
            json!({ "did": pc, "kind": "pc", "rootDid": account,
                    "addrs": { "ipv6List": ["3fff::3"], "port": 9100 } }),
            // 手机：kind=phone、无 addrs（不能直推）→ 只能中继
            json!({ "did": phone, "kind": "phone", "rootDid": account }),
            // 好友账号的行不参与
            json!({ "did": dev_did(9), "kind": "pc", "rootDid": dev_did(8),
                    "addrs": { "ipv6List": ["3fff::9"], "port": 9100 } }),
        ];
        let direct = direct_devices_from_rows(&rows, &account, &my);
        assert_eq!(direct.iter().map(|d| d.did.clone()).collect::<Vec<_>>(), vec![pc.clone()],
                   "直推清单只认有地址的 pc（既有口径）");
        let all = account_device_targets(&rows, &account, &my);
        assert_eq!(all, vec![pc.clone(), phone.clone()], "账号设备清单含手机、排除本机与好友");
        let relay = relay_only_targets(&rows, &account, &my, &direct);
        assert_eq!(relay, vec![phone.clone()], "直推够不到的只剩手机——必须交给中继腿");
        assert!(!relay.iter().any(|d| core_id::did_equiv(d, &my)), "不得把本机当中继目标");
    }

    /// 直推清单为空的纯好友账号：中继目标 = 全部账号设备（老口径不变）。
    #[test]
    fn friend_account_without_direct_still_relays_all() {
        let account = dev_did(5);
        let my = dev_did(6);
        let friend_pc = dev_did(7);
        let rows = vec![json!({ "did": friend_pc, "kind": "pc", "rootDid": account,
                                "addrs": {} })];
        let direct = direct_devices_from_rows(&rows, &account, &my);
        assert!(direct.is_empty(), "无地址的 pc 进不了直推清单");
        let relay = relay_only_targets(&rows, &account, &my, &direct);
        assert_eq!(relay, vec![friend_pc], "无直推地址时仍保留中继腿机会");
    }

    /// presence 聚合落空时的云名册兜底：排除本机/吊销，手机优先（下游 truncate(2) 不挤掉手机）。
    #[test]
    fn roster_relay_targets_phone_first_skip_self_and_revoked() {
        let my = dev_did(1);
        let laptop = dev_did(2);
        let phone = dev_did(3);
        let revoked = dev_did(4);
        let roster = vec![
            json!({ "did": my, "kind": "pc", "revoked": false }),
            json!({ "did": laptop, "kind": "pc", "revoked": false }),
            json!({ "did": phone, "kind": "phone", "revoked": false }),
            json!({ "did": revoked, "kind": "pc", "revoked": true }),
        ];
        let got = roster_relay_targets(&roster, &my);
        assert_eq!(got, vec![phone, laptop], "手机必须排第一；本机/吊销排除");
    }

    // ── 2026-10-18 task-7 终版：本地委任状 → 中继目标（零网络） ──
    fn pub_b64(tag: u8) -> String {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[tag; 32]);
        base64::engine::general_purpose::STANDARD.encode(sk.verifying_key().to_bytes())
    }

    fn delegation_rec(account: &str, pubkey_b64: &str, name: &str, exp: u64, revoked: bool) -> myco_core::delegation::DelegationRecord {
        serde_json::from_value(serde_json::json!({
            "delegation": {
                "accountDid": account, "devicePubkeyB64": pubkey_b64,
                "deviceName": name, "scopes": "*", "issuedAt": 1u64,
                "exp": exp, "nonce": "n", "sigB64": ""
            },
            "revoked": revoked, "lastRenewed": 0u64
        }))
        .expect("DelegationRecord deserialize")
    }

    // ── 2026-10-18 晚 新任务：手机恒进中继目标 ──
    #[test]
    fn merge_relay_targets_phone_first_always() {
        let my = dev_did(1);
        let phone = dev_did(2);
        let laptop = dev_did(3);
        let direct_pc = dev_did(4);
        let direct = vec![PeerDevice { did: direct_pc.clone(), name: "pc".into(), port: 9100, addrs: vec!["3fff::1".into()] }];
        // 手机 + 候选里甚至混进直推可达设备：手机恒第一，直推设备被排除
        let got = merge_relay_targets(
            &[phone.clone()],
            &[direct_pc.clone(), laptop.clone(), phone.clone()],
            &direct,
            &my,
        );
        assert_eq!(got, vec![phone.clone(), laptop.clone()], "手机恒第一；直推已覆盖/重复的不进中继清单");
        // 没有手机目标时退化为普通候选（过滤本机）
        assert_eq!(
            merge_relay_targets(&[], &[my.clone(), laptop.clone()], &direct, &my),
            vec![laptop],
            "本机不得成为中继目标"
        );
    }
    // ── 2026-10-19 Phase 2：持久隧道健康度/心跳判定（纯函数） ──
    #[test]
    fn post_failure_keeps_tunnel_only_on_connect_fail() {
        assert!(!post_failure_keeps_tunnel(&LocalPostOutcome::ConnectFail("refused".into())),
            "连接拒绝/重置=隧道死，必须重建");
        assert!(post_failure_keeps_tunnel(&LocalPostOutcome::HttpStatus(404)),
            "HTTP 非 2xx 说明隧道活着（心跳 404 是正常应答）");
        assert!(post_failure_keeps_tunnel(&LocalPostOutcome::Other("timeout".into())),
            "超时/读体错误不判死（可能只是手机 JS 忙）");
        assert!(post_failure_keeps_tunnel(&LocalPostOutcome::Ok(json!({"ok": true}))));
    }
    // ── 2026-10-19 T4：直推失败按设备记忆（原实现误标中继目标 did，导致永不生效） ──
    #[test]
    fn direct_failure_marks_that_device_only_and_clears_on_success() {
        let failed = dev_did(21);
        let other = dev_did(22);
        dev_relay_pref_clear(&failed);
        dev_relay_pref_clear(&other);
        dev_relay_pref_mark(&failed);
        assert!(dev_relay_pref(&failed), "直推失败的设备必须被记住（否则每条消息都烧 5s）");
        assert!(!dev_relay_pref(&other), "不能误伤其它设备");
        dev_relay_pref_clear(&failed);
        assert!(!dev_relay_pref(&failed), "直推成功后必须清除记忆");
    }

    #[test]
    fn heartbeat_due_after_60s_only_when_healthy() {
        use std::time::Duration;
        assert!(!chat_tunnel_heartbeat_due(true, Duration::from_secs(59)), "59s 不心跳");
        assert!(chat_tunnel_heartbeat_due(true, Duration::from_secs(60)), "60s 心跳（T7 空闲保活）");
        assert!(chat_tunnel_heartbeat_due(true, Duration::from_secs(120)), "120s 仍要续命（手机侧空闲回收线）");
        assert!(!chat_tunnel_heartbeat_due(false, Duration::from_secs(300)), "已判死的隧道不心跳（等下条重建）");
    }
    #[test]
    fn same_account_loose_handles_gui_anomaly_and_tails() {
        let a = dev_did(1);
        assert!(same_account_loose(&a, &a), "同串必须相等");
        let a_youling = a.replacen("did:myco:", "did:youling:", 1);
        assert!(same_account_loose(&a, &a_youling), "双前缀同钥必须相等");
        // GUI 异常兜底：同尾 8 位、前缀不同也认（仅用于本机账号识别）
        let tail = a[a.len() - 8..].to_string();
        let weird = format!("did:myco:{}", tail);
        assert!(same_account_loose(&a, &weird), "尾 8 位兜底");
        assert!(!same_account_loose(&a, &dev_did(2)), "不同账号必须不相等");
        assert!(!same_account_loose("", &a), "空串不相等");
    }

    #[test]
    fn presence_phone_targets_phone_only_loose_account_skip_self() {
        let account = dev_did(1);
        let my = dev_did(2);
        let phone_youling = dev_did(3);
        let other_phone = dev_did(4);
        let pc_same = dev_did(5);
        let root_empty_phone = dev_did(6);
        let account_youling = account.replacen("did:myco:", "did:youling:", 1);
        let rows = vec![
            json!({ "did": phone_youling, "kind": "phone", "rootDid": account_youling }),
            json!({ "did": other_phone, "kind": "phone", "rootDid": dev_did(7) }),
            json!({ "did": pc_same, "kind": "pc", "rootDid": account }),
            json!({ "did": my, "kind": "phone", "rootDid": account }),
            json!({ "did": root_empty_phone, "kind": "phone", "rootDid": "" }),
        ];
        let got = presence_phone_targets(&rows, &account, &my);
        assert_eq!(got, vec![phone_youling, root_empty_phone],
                   "只取本机账号手机（含 rootDid 空），排除他人手机/PC/本机");
    }
    #[test]
    fn delegation_relay_targets_phone_first_skip_expired_revoked_self_other_account() {
        let now = 100_000u64;
        let account = dev_did(1); // did:myco:z...
        let my = dev_did(2);
        let phone = dev_did(3);
        let laptop = dev_did(4);
        let logged = dev_did(5);
        let revoked_dev = dev_did(6);
        let other_acc = dev_did(7);
        let records = vec![
            delegation_rec(&account, &pub_b64(4), "laptop", now + 10_000, false),
            delegation_rec(&account, &pub_b64(3), "phone", now + 10_000, false),
            delegation_rec(&account, &pub_b64(5), "手机-old", now - 1, false),
            delegation_rec(&account, &pub_b64(6), "phone-revoked", now + 10_000, true),
            delegation_rec(&account, &pub_b64(2), "DESKTOP", now + 10_000, false),
            delegation_rec(&other_acc, &pub_b64(7), "phone-other", now + 10_000, false),
            delegation_rec(&account, &pub_b64(3), "phone-dup", now + 10_000, false),
        ];
        let got = delegation_relay_targets(&records, &account, &my, now);
        assert_eq!(got, vec![phone, laptop], "phone first; skip expired/revoked/self/other-account; dedupe");
        assert!(delegation_relay_targets(&records, &dev_did(9), &my, now).is_empty());
        let _ = (logged, revoked_dev);
    }
}

// ══════ P2P web 隧道（2026-10-09）——实现在 p2p_tunnel.rs，此处转出契约面 ══════
// 集成方（网关 / 客户端）的调用面就是 `p2p_client::tunnel_open` / `tunnel_close`
// （签名与语义见 p2p_tunnel.rs 模块头与函数注释；授权钩子 set_tunnel_authorizer
// 由网关侧安装"该分享的 grant 名单"判定）。
// 2026-10-09 反向连接：`tunnel_open_reverse` / `tunnel_reverse_stop`（PC 当发起方
// 主动拨手机，详见 p2p_tunnel.rs ⑧ 段）。
pub use crate::p2p_tunnel::{
    set_tunnel_authorizer, tunnel_audit_recent, tunnel_close, tunnel_open, tunnel_open_reverse,
    tunnel_reverse_live, tunnel_reverse_stop, TunnelAudit,
};

// ── 2026-10-12 地址健康度（stale 探活淘汰）：纯内核单测 ──────────────────
mod addr_health_tests {
    use super::*;

    #[test]
    fn score_lifecycle() {
        let now = 1_000_000i64;
        // 无记录 = 健康
        assert_eq!(addr_score_now(None, now), 0);
        // 1 次失败：分 1（未到沉底线）
        let r1 = AddrRec { fails: 1, last_fail: now };
        assert_eq!(addr_score_now(Some(&r1), now + 1), 1);
        // 达 CAP：沉底分
        let r2 = AddrRec { fails: ADDR_FAIL_CAP, last_fail: now };
        assert_eq!(addr_score_now(Some(&r2), now + 1), ADDR_FAIL_CAP);
        // 超 TTL：恢复健康（前缀轮换后旧地址不该永久压制）
        assert_eq!(addr_score_now(Some(&r2), now + ADDR_TTL_MS + 1), 0);
    }

    #[test]
    fn sort_sinks_unhealthy_keeps_stable_order() {
        // 坏地址沉底；同分保持原序（lan→v4→v6 既有优先级在健康层之内）
        let mut urls = vec![
            "http://bad1:9100".into(),
            "http://good-a:9100".into(),
            "http://bad2:9100".into(),
            "http://good-b:9100".into(),
        ];
        let now = now_ms();
        {
            let mut m = ADDR_HEALTH.lock().unwrap();
            for u in ["http://bad1:9100", "http://bad2:9100"] {
                m.insert(u.to_string(), AddrRec { fails: ADDR_FAIL_CAP, last_fail: now });
            }
        }
        sort_by_health(&mut urls);
        assert_eq!(urls[urls.len() - 2], "http://bad1:9100");
        assert_eq!(urls[urls.len() - 1], "http://bad2:9100");
        // 好地址两台的相对顺序不变
        assert_eq!(urls[0], "http://good-a:9100");
        assert_eq!(urls[1], "http://good-b:9100");
        // 清理（不影响其他用例）
        ADDR_HEALTH.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod vnet_only_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// vnet 模式下，vnet 建链失败不得回退到 direct TCP（9100 迁移红线）。
    /// 旧实现会命中下面的 direct listener；修复后返回失败且 direct 收到零请求。
    #[tokio::test]
    async fn vnet_failure_does_not_fall_back_to_direct_tcp() {
        let _g = crate::test_env_lock::test_env_lock();
        let old_mode = std::env::var_os("MYCO_TUNNEL_TRANSPORT");
        let old_relay = std::env::var_os("MYCO_VNET_RELAY");
        std::env::set_var("MYCO_TUNNEL_TRANSPORT", "vnet");
        // 本机未开放的中继口：确保 vnet 建链失败，不触外网。
        std::env::set_var("MYCO_VNET_RELAY", "127.0.0.1:9");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let direct_port = listener.local_addr().unwrap().port();
        let direct_hits = std::sync::Arc::new(AtomicUsize::new(0));
        let hits = direct_hits.clone();
        let server = tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                hits.fetch_add(1, Ordering::SeqCst);
                let _ = sock.writable().await;
                let _ = sock.try_write(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
                );
            }
        });
        let dev = PeerDevice {
            did: "did:myco:zVnetOnlyNoDirectFallback".into(),
            name: "vnet-only-test".into(),
            port: direct_port,
            addrs: vec!["127.0.0.1".into()],
        };
        // 只隔离外部网络，不绕过被测的 vnet 路由决策：负缓存让 route_open 在
        // 创建 Connection 前确定失败，避免测试触发全局防火墙后台探测污染其它用例。
        crate::vnet_forward::force_vnet_backoff(&dev.did, 9100, 60_000);
        let out = p2p_post(&dev, "/p2p/msg", &json!({"msgId": "vnet-only-red"})).await;

        match old_mode {
            Some(v) => std::env::set_var("MYCO_TUNNEL_TRANSPORT", v),
            None => std::env::remove_var("MYCO_TUNNEL_TRANSPORT"),
        }
        match old_relay {
            Some(v) => std::env::set_var("MYCO_VNET_RELAY", v),
            None => std::env::remove_var("MYCO_VNET_RELAY"),
        }
        server.abort();
        assert!(out.is_none(), "vnet 失败后不得经 direct TCP 得到成功响应");
        assert_eq!(direct_hits.load(Ordering::SeqCst), 0, "direct TCP 收到请求 = legacy 回退未退役");
    }
}
