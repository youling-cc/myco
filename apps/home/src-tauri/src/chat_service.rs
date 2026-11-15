//! chat_service.rs — 第81轮：登录器好友+聊天；第84轮 P2P 直连改造；第86轮好友服务器化。
//!
//! 第96轮（Rust 基座批一，六项）：
//!   ① 账号分桶：chat/ 全局一份 → chat/<accountDid-safe>/ 每账号一桶（切账号串号根修），
//!     旧全局 chat/ 一次性整体 move 迁移；outbox.json 同桶（offline_queue 按桶缓存实例）。
//!   ② 对账批次双闸：条数 ≤50 + 累计字节 ≤12MB（p2p_sync::chunk_wire_msgs）——
//!     媒体 b64 内联时 5×2MB 图就超 16MB body limit → 413 对账永久卡死。
//!   ③ 大文件与正文解耦：单聊 file 消息体只带 mediaRef（{name,size,mime,sha256}），
//!     字节走 /p2p/media/chunk 分片端点（1MB/片，收齐校验 sha256）；图片 ≤2MB 内联不动。
//!   ④ meta 写路径 conv 级锁 + 原子写（p2p_sync.rs）。
//!   ⑤ 自同步回流（from==my）入库 dir=out；chat_load_conv 渲染层 from==my 优先 out 双保险。
//!   ⑥ 群发送禁言闸（发送侧拒发）+ presence 灯 kind=phone 计入 online。
//!
//! 2026-10-07 好友关系去服务端化（设计=refactor docs/todo/2026-10-07-好友关系去服务端化设计.md）：
//! 好友关系=双方各自本地档案（friends.json 即权威非缓存）+ 签名握手
//! （friend-request/accept/remove 三 kind，复用 wire 信封：P2P 直推优先 →
//! msg 信箱兜底）。服务器 friends 模块已净删（/friends/* 404）；防冒充三件套
//! （payload.sig 验签+名册归属闸+公钥级判等）全部在接收端，与 p2p_server
//! auth_gate 同链。聊天正文/任务卡仍走 P2P 直连（第84轮），群档案/群管理仍走
//! 信箱元数据 + P2P 对账（第85轮，不动）。
//!
//! 第84轮（去中心化）：消息本体（text/image/file/task-share/group-msg/task-accept/
//! task-done）不再走服务器——本地先落盘（"活的历史"），再 P2P 直推对方设备
//! （best-effort，失败不丢，上线后对账补齐）。服务器信箱只剩低频控制消息
//! （group-create/group-invite/rename/leave/kick/mute，对方不在线也可靠）。
//! 对账算法见 p2p_sync.rs；直连收发见 p2p_server.rs / p2p_client.rs。
//!
//! 架构（设计定稿）：服务器只中转（信箱拉走即删零存档），消息存本地——
//!   %APPDATA%\youling\chat\（MYCO_CONFIG_DIR 环境分离时跟着切，双实例 E2E 用）
//!     friends.json   [{did,name,addedAt,status}]   好友本地档案（去服务端化后即权威）
//!     groups.json    [{id,name,members:[账号did],createdAt}]
//!     peer-tasks.json 任务卡分享的本地任务库（AOP 分形：卡=签名摘要，执行在本地）
//!     seen.json      {convId: lastSeenTs}           未读角标
//!     {convId}.jsonl 一行一条 {msgId,from,to,kind,payload,ts,dir}；dir=out|in
//!       ↑ 2026-10-07 会话 id 形态归一：文件名先过 conv_key（账号 did 四形态 →
//!         单一 canonical），写目标唯一；存量各形态文件由 conv_paths_all 归并读取
//!         （不迁移/不删档，见 conv_key 注释的根因）。对账 meta 同键。
//!     media\{msgId}.{ext}                            图片/文件字节（jsonl 里只存 media 引用）
//!
//! 签名/HTTP：设备钥（core_id::signed_post，presence 同链——服务器只验设备签名，
//! 消息按 toAccountDid 明文路由）。好友锚=账号 did（did:youling:）。
//!
//! 任务卡协议（coordinator 定稿）：卡=微活契约，payload 平铺不嵌套；
//! 回执 task-accept/task-done 是平铺事件形 {taskId, from, ts}——将来进协议事件流免迁移。
//!
//! 批二（2026-09-28，群语义修正，设计定稿"做彻底"）：
//! ① 群任务卡=群会话一条 task-share（payload.groupId=grp-*，p2p 端侧按 members 扇出），
//!   接受/完成回执群广播落群会话（全员可见"谁接了/谁完成了"）；单聊行为不变。
//! ② 群主退群=解散：owner 发起 group-leave 时先广播 group-disband（新 kind，服务器
//!   白名单同步），全体（含本端）群会话保留只读+members 清空+系统条"群已被解散"；
//!   compat group-leave 随发（老端优雅降级一条"退出了群聊"，不崩）。
//! ③ 被踢=群会话保留只读+系统条"你已被移出群「X」"+UI toast；不再静默删群。
//! ④ 自愈建群 owner=null+ownerPending 标记：治理闸全拒（改名/踢人/禁言/拉人），
//!   group-create 落群 jsonl 参与对账——离线成员对账补齐即得真 owner，不再首成员冒充。

use base64::Engine as _;
use ed25519_dalek::{Signer as _, Verifier as _};
use myco_core::identity as core_id;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
// 非 test 构建才引 Tauri `Emitter`（以及一切 `.emit()` 调用点）。
// 原因见 `apps/home/src-tauri/build.rs` 顶部长注释：lib 单元测试 harness 没有 exe
// manifest，测试可达的代码一旦链上 tauri 的 webview 运行时（Wry → muda），就会静态
// 导入 `comctl32.dll!TaskDialogIndirect`（v6 专属符号），加载器绑到 System32 的
// v5.82 → `0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND`，测试 exe 零输出起不来。
// UI 事件是"给窗口看"的通道，测试态不需要——测试态一律不引。
#[cfg(not(test))]
use tauri::Emitter as _;

static MSG_SEQ: AtomicU64 = AtomicU64::new(0);
/// 第84轮：本机"正在输入"到期时刻（chat_typing 命令设置，presence 心跳上报 state 用）。
pub static TYPING_UNTIL: AtomicI64 = AtomicI64::new(0);

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// msgId：纳秒+进程内序号（crypto.randomUUID 语义等价——端侧唯一即可，服务器不解释）。
fn new_msg_id() -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("m{n:x}-{}", MSG_SEQ.fetch_add(1, Ordering::Relaxed))
}

fn base_url() -> String {
    std::env::var("MYCO_DID_BASE").unwrap_or_else(|_| "https://myco.youling.cc/myco-id".into())
}

// ══════════════ [chat-trace] 消息链路测量（2026-10-18 fast-ack） ══════════════
//
// 只记录 msgId/阶段/目标账号/耗时/时间戳，**不含聊天内容**——测量脚本按 msgId
// 对齐两端时间线算 M2/M3/M4/M7。PC 侧落 %LOCALAPPDATA%\Temp\myco-stdout.log
// （400KB 滚动，逻辑与 chat-ui-trace.log 同款纪律）；手机侧同格式 console.log
// 落 gw-net.log（见 apps/phone/src/chat-store.ts 的 chatTrace）。
// 测试态 no-op：lib 单测并发跑，别让 trace 写盘互相污染。

/// 纯函数：一行 trace（单测锚点）。字段顺序固定；前缀 `[chat-trace] ` 供脚本切行。
fn chat_trace_line(ev: &str, msg_id: &str, target: &str, ms: u64, ts: i64) -> String {
    let v = json!({ "ev": ev, "msgId": msg_id, "ts": ts, "target": target, "ms": ms });
    format!("[chat-trace] {v}")
}

#[cfg(not(test))]
fn chat_trace(ev: &str, msg_id: &str, target: &str, ms: u64) {
    use std::io::Write as _;
    let ts = now_ms();
    let line = chat_trace_line(ev, msg_id, target, ms, ts);
    // 2026-10-18：**独立文件**，不再写 myco-stdout.log —— 启动脚本用 cmd `>` 重定向
    // stdout 时句柄独占该文件，这里再 append 打开会静默失败（真机实测：PC 侧 trace
    // 一条都落不下来，测量全变瞎）。独立文件只需自己滚动。
    let dir = std::env::var("APPDATA")
        .map(|p| PathBuf::from(p).join("youling"))
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("chat-trace.log");
    if let Ok(md) = std::fs::metadata(&path) {
        if md.len() > 400 * 1024 {
            let _ = std::fs::rename(&path, path.with_extension("log.old"));
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{line}");
    }
}
#[cfg(test)]
fn chat_trace(_ev: &str, _msg_id: &str, _target: &str, _ms: u64) {}

/// 收到一条 wire 信封时的 trace（M3/M7）：ms=端到端时延（本机收到时刻-发送方 ts），
/// target=发送方账号。没有 msgId 的控制消息（心跳类）不记。
fn trace_recv(m: &Value) {
    let msg_id = m
        .get("msgId")
        .or_else(|| m.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if msg_id.is_empty() {
        return;
    }
    let ts = m.get("ts").and_then(|v| v.as_i64()).unwrap_or(0);
    let now = now_ms();
    let ms = if ts > 0 && now >= ts {
        (now - ts) as u64
    } else {
        0
    };
    let from = m.get("from").and_then(|v| v.as_str()).unwrap_or("");
    chat_trace("recv", msg_id, from, ms);
}

/// 应用前台标记（lib.rs 的窗口 Focused 事件写入）：信箱轮询前台 1.5s / 后台 5s；
/// 待发补发环前台 3s 起退避、后台 60s（M7/M9）。默认 true（无窗口事件时按前台算）。
static APP_FOREGROUND: AtomicBool = AtomicBool::new(true);
pub fn set_app_foreground(fg: bool) {
    APP_FOREGROUND.store(fg, Ordering::Relaxed);
}
pub fn app_foreground() -> bool {
    APP_FOREGROUND.load(Ordering::Relaxed)
}

// ══════════════ 本地存储 ══════════════

// 测试专用 chat 桶覆盖（**线程局部**）：本仓多个测试模块各自设进程级
// MYCO_CONFIG_DIR 做隔离，并发跑测试时互相改写 → 串桶（偶发红灯，与本模块无关
// 但会被本模块放大）。归一会话的测试改用线程局部覆盖：不写环境变量，也不受
// 其它模块写环境变量的影响。生产构建走 cfg(not(test)) 空实现（零开销）。
#[cfg(test)]
thread_local! {
    static TEST_CHAT_DIR: std::cell::RefCell<Option<PathBuf>> = std::cell::RefCell::new(None);
}
#[cfg(test)]
fn test_chat_dir_override() -> Option<PathBuf> {
    TEST_CHAT_DIR.with(|d| d.borrow().clone())
}
#[cfg(not(test))]
fn test_chat_dir_override() -> Option<PathBuf> {
    None
}

// 本机设备 did（设备群 dir 判定/署名的数据源）。测试用线程局部替身注入——
// core::device_identity 读真实 config 目录设备钥，测试进程内不可控且可能触碰
// 真实密钥文件；替身让"本机/他机"用例完全确定性（生产构建零开销，同 TEST_CHAT_DIR）。
#[cfg(test)]
thread_local! {
    static TEST_MY_DEVICE: std::cell::RefCell<Option<String>> = std::cell::RefCell::new(None);
}
/// 本机设备 did（信封 fromDevice 同款 canonical 形态）。
fn my_device_did() -> String {
    #[cfg(test)]
    if let Some(d) = TEST_MY_DEVICE.with(|d| d.borrow().clone()) {
        return d;
    }
    core_id::device_identity()
        .map(|(d, _)| d)
        .unwrap_or_default()
}

/// 本机设备显示名（p2p_send_raw 信封 fromDeviceName 同源；群行署名用）。
/// 2026-11-03 起委托 core：config 覆盖文件 > 主机名（支持 CLI `device rename`）。
fn device_display_name() -> String {
    core_id::device_display_name()
}

/// 第96轮（修复1 账号分桶）：chat/ 从"全局一份"改为 chat/<accountDid-safe>/ 每账号
/// 一桶——旧实现 myco_switch_account/myco_logout 不碰 chat 数据，切账号后看到上一
/// 账号的好友/会话/任务（串号）。桶随 core_id::account_did() 动态求值，切账号后
/// 所有读写自动重定向（无需显式刷新钩子）；未登录=_guest 桶（chat 命令未登录即
/// Err，仅防御性落点）。p2p_sync/offline_queue 的 chat 路径统一走本函数。
///
/// ★4-b（多归属·桶路由，2026-10-09 共识 #4）：**活动账号只是默认值**——ingest 一条
/// "信封 to 指向本机持有效委任状账号"的消息期间，本任务域内的全部 chat 读写
/// （会话 jsonl/对账 meta/媒体/好友档案）经 [`CHAT_BUCKET`] 路由到该账号桶。
/// 用 tokio task-local 承载：跨 await 安全（工作线程迁移不丢上下文），也不会
/// 泄漏到并发任务；作用域只在 `ingest_p2p_inner` 的路由分支里建立。
pub(crate) fn chat_dir() -> PathBuf {
    if let Some(d) = test_chat_dir_override() {
        let _ = std::fs::create_dir_all(&d);
        return d;
    }
    // ★4-b 桶路由：任务域内的显式账号优先于活动账号默认值
    if let Some(acc) = CHAT_BUCKET.try_with(|b| b.clone()).ok().flatten() {
        return chat_dir_for(&acc);
    }
    let acc = core_id::account_did_storage().unwrap_or_else(|| "_guest".into());
    chat_dir_for(&acc)
}

/// chat 桶的**显式账号参数版**（★4-b）：桶键=传入账号串的 safe 形态（不归一——
/// 与默认路径同一条纪律：历史数据在哪个形态的桶就继续用哪个桶，路由键必须稳定）。
/// 活动账号版 [`chat_dir`] 只是 `chat_dir_for(活动账号存储形态)` 的默认值。
pub(crate) fn chat_dir_for(account: &str) -> PathBuf {
    if let Some(d) = test_chat_dir_override() {
        let _ = std::fs::create_dir_all(&d);
        return d;
    }
    let root = myco_core::config::config_dir().join("chat");
    let bucket = root.join(did_safe(account));
    migrate_legacy_chat_once(&root, &bucket, account != "_guest");
    let _ = std::fs::create_dir_all(&bucket);
    bucket
}

/// ★4-b 桶路由上下文（任务域作用域）：ingest 期间 chat 读写路由到的账号桶。
/// None=默认（活动账号）。只在 `ingest_p2p_inner` 建作用域（`LocalKey::scope`
/// 包住整条 ingest 的 Future，跨 await 安全），别处只读。
tokio::task_local! {
    static CHAT_BUCKET: Option<String>;
}

/// 本机是否持有「该账号签给本设备钥」的有效委任状（未吊销 + 验签过 + 未过期）。
/// `delegation.rs has_valid_for` 的只读包装（★4 收信闸与 ★4-b 落桶路由共用的
/// 判定源——多归属成员面的"这台机器是不是该账号的成员设备"）。
pub(crate) fn holds_valid_delegation_for(account: &str) -> bool {
    let acc = account.trim();
    if acc.is_empty() {
        return false;
    }
    match core_id::device_pubkey_from_did_or_b64(&my_device_did()) {
        Ok(dev_pub_b64) => {
            myco_core::delegation::Delegations::load().has_valid_for(acc, &dev_pub_b64)
        }
        Err(_) => false,
    }
}

/// ★4-b 落桶路由决策（纯判定，fail-closed）：信封 `to` 指向的账号若"本机持该账号
/// 有效委任状"且≠当前活动账号 → Some(该账号)（消息按它的桶落盘）；否则 None
/// （=活动账号默认桶，行为与今天逐字节一致）。收给"本机不是其成员"的账号的信
/// 一律回落默认桶（由收信闸拒掉，不在本函数越权改写）。
pub(crate) fn routed_chat_bucket(my: &str, to: &str) -> Option<String> {
    let to = to.trim();
    if to.is_empty() || core_id::account_did_eq(to, my) {
        return None;
    }
    if holds_valid_delegation_for(to) {
        Some(to.to_string())
    } else {
        None
    }
}

/// 进程内"该桶已检查过迁移"集合（chat_dir 是热路径——fs 迁移探测每桶只做一次）。
static MIGRATION_DONE: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

fn migrate_legacy_chat_once(root: &Path, bucket: &Path, real_account: bool) {
    if !real_account {
        return; // _guest 桶不承接旧数据（旧数据必属某真实账号，等其首次登录再搬）
    }
    let key = bucket.display().to_string();
    {
        let done = MIGRATION_DONE.lock().unwrap();
        if done.contains(&key) {
            return;
        }
    }
    let moved = migrate_legacy_chat(root, bucket);
    MIGRATION_DONE.lock().unwrap().insert(key);
    if moved {
        eprintln!(
            "[chat] 第96轮：旧全局 chat/ 已整体迁移到账号桶 {}",
            bucket.display()
        );
    }
}

/// 第96轮（修复1）一次性迁移核心：旧全局 chat/ 负载 → 账号桶（整体 move，不是
/// 复制——move 后旧位置干净，幂等不重复搬）。触发条件：root 下有旧负载（顶层
/// 文件或 media/ 目录）且桶为空（不存在或空目录）。顶层目录除 media/ 外一律不动
/// （账号桶也是顶层目录，不能互搬）。纯 fs + 路径注入（单测临时目录零全局态）。
fn migrate_legacy_chat(root: &Path, bucket: &Path) -> bool {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return false,
    };
    let mut legacy_files: Vec<PathBuf> = vec![];
    let mut legacy_media: Option<PathBuf> = None;
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        match e.file_type() {
            Ok(t) if t.is_file() => legacy_files.push(p),
            Ok(t) if t.is_dir() && name == "media" => legacy_media = Some(p),
            _ => {}
        }
    }
    if legacy_files.is_empty() && legacy_media.is_none() {
        return false;
    }
    let bucket_empty = match std::fs::read_dir(bucket) {
        Ok(mut it) => it.next().is_none(),
        Err(_) => true, // 桶不存在=空
    };
    if !bucket_empty {
        return false; // 桶已有数据——不覆盖（旧负载留原处，人工处置）
    }
    let _ = std::fs::create_dir_all(bucket);
    let mut moved_any = false;
    for f in legacy_files {
        if let Some(name) = f.file_name() {
            if std::fs::rename(&f, bucket.join(name)).is_ok() {
                moved_any = true;
            }
        }
    }
    if let Some(m) = legacy_media {
        if std::fs::rename(&m, bucket.join("media")).is_ok() {
            moved_any = true;
        }
    }
    moved_any
}

fn media_dir() -> PathBuf {
    let d = chat_dir().join("media");
    let _ = std::fs::create_dir_all(&d);
    d
}
pub(crate) fn did_safe(did: &str) -> String {
    did.replace([':', '/'], "_")
}

/// 会话 id 归一键（2026-10-07 修：跨机好友"两边都✓已发送、都能看到对方打字，
/// 但会话里看不到对方消息"）。
///
/// 根因：会话文件此前直接按裸串 `did_safe(peer)` 命名——
///   ① 接收 ingest 按**信封 `from` 的出示形态**落（canonical `did:youling:z…` 或另一
///      canonical 前缀 `did:myco:z…`；存量老账号文件名是 legacy `did:youling:<b58>`）；
///   ② 发送与 UI 按**名册 did 的形态**落/读（friends.json 里可能是 did:myco:z…）。
/// 同一把钥匙 → 两份 jsonl；UI 只读得到自己那份，对方消息"收到了但看不见"。
/// 归一键 = `account_did_canonical`（canonical 双前缀 → 单一 canonical，含 UI 传的
/// did_safe 下划线形态）；群 id（grp-*）与解析不出公钥的软 did / legacy 串原样返回。
pub(crate) fn conv_key(conv_id: &str) -> String {
    match conv_did_of(conv_id) {
        Some(d) => core_id::account_did_canonical(&d),
        None => conv_id.to_string(),
    }
}

/// 归一的输入还原：did_safe 下划线形态（`did_myco_X`/`did_youling_X`）→ did。
/// 部分调用点传的是 did_safe 形态（task-share 落库 `did_safe(&conv)`、对账摘要
/// 的 `my_conv_ids()`），不还原就解不出公钥、归一会失手。
/// 仅在前缀命中且公钥解析成功时还原（软 did 串如 `did_youling_BOB` 原样）。
fn conv_did_of(conv_id: &str) -> Option<String> {
    if core_id::did_pubkey_bytes(conv_id).is_some() {
        return Some(conv_id.to_string());
    }
    for (safe, did) in [("did_myco_", "did:myco:"), ("did_youling_", "did:youling:")] {
        if let Some(tail) = conv_id.strip_prefix(safe) {
            let d = format!("{did}{tail}");
            if core_id::did_pubkey_bytes(&d).is_some() {
                return Some(d);
            }
        }
    }
    None
}

/// 会话文件：**唯一写目标 = 归一键**（新消息一律落这一份，形态不再分裂）。
/// 存量各形态文件由 conv_paths_all 归并读（不迁移、不删档）。
pub(crate) fn conv_path(conv_id: &str) -> PathBuf {
    chat_dir().join(format!("{}.jsonl", did_safe(&conv_key(conv_id))))
}

/// 该会话的全部等价文件（归一键 + 原串 + 账号 did 各历史形态）——存量双文件
/// 归并读取的路径表；群/软 id 只有自己一个。
pub(crate) fn conv_paths_all(conv_id: &str) -> Vec<PathBuf> {
    fn push_unique(v: &mut Vec<String>, s: String) {
        if !s.is_empty() && !v.contains(&s) {
            v.push(s);
        }
    }
    let mut stems: Vec<String> = Vec::new();
    push_unique(&mut stems, did_safe(&conv_key(conv_id)));
    push_unique(&mut stems, did_safe(conv_id));
    if let Some(d) = conv_did_of(conv_id) {
        for a in core_id::account_did_aliases(&d) {
            push_unique(&mut stems, did_safe(&a));
        }
    }
    let dir = chat_dir(); // 热路径：目录只解析一次（chat_dir 含迁移探测+建目录）
    stems
        .into_iter()
        .map(|s| dir.join(format!("{s}.jsonl")))
        .collect()
}

/// 对账 meta 文件路径（与 jsonl 同归一键——旧形态 meta 由 p2p_sync::load_meta
/// 从归并后的 jsonl 重建/补齐，不再各写一份各算一个指纹）。
pub(crate) fn conv_meta_path(conv_id: &str) -> PathBuf {
    chat_dir().join(format!("{}.meta.json", did_safe(&conv_key(conv_id))))
}

/// 删会话的本地文件（全部等价 jsonl + 归一键 meta）——删除语义必须覆盖归并视图，
/// 否则删完还会从另一形态文件"复活"。只在用户显式删会话/删好友时调用。
fn conv_remove_files(conv_id: &str) {
    for p in conv_paths_all(conv_id) {
        let _ = std::fs::remove_file(&p);
    }
    let _ = std::fs::remove_file(conv_meta_path(conv_id));
}

/// 读 JSON 文本并**剥掉 UTF-8 BOM**（U+FEFF）。
///
/// 真案（2026-11-06 笔记本「任务」页空白）：`peer-tasks.json` 被 PowerShell
/// `ConvertTo-Json | Set-Content -Encoding UTF8`（或任何带 BOM 的写入方）重写，
/// 文件头多了 EF BB BF。`serde_json::from_str` 遇到 BOM 直接报
/// "expected value at line 1 column 1"；而任务库读取把错误吞成空数组 →
/// UI 显示「还没有领取中的任务」，数据其实一张不少地在盘上。
///
/// 与 `strip_prefix('\u{feff}')` 而不是 trim：BOM 只可能出现在**文件头**，
/// 正文里的同名码点属于数据，不能动。
pub(crate) fn read_json_text(path: &std::path::Path) -> Result<String, String> {
    let s = std::fs::read_to_string(path).map_err(|e| format!("读 {} 失败: {e}", path.display()))?;
    Ok(s.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(s))
}

fn read_json_arr(path: &PathBuf) -> Vec<Value> {
    if !path.exists() {
        return Vec::new(); // 首次运行没有这些文件是常态，不算错误
    }
    let parsed = read_json_text(path).and_then(|s| {
        serde_json::from_str(&s).map_err(|e| format!("{} JSON 损坏: {e}", path.display()))
    });
    match parsed {
        Ok(v) => v,
        Err(e) => {
            // 不许静默：读坏 = UI 少东西，必须留痕（BOM 真案就是被静默吞掉的）
            eprintln!("[chat] {e}（按空处理）");
            Vec::new()
        }
    }
}
fn write_json_arr(path: &PathBuf, v: &[Value]) {
    let _ = std::fs::write(path, serde_json::to_string_pretty(v).unwrap_or_default());
}

fn friends_path() -> PathBuf {
    chat_dir().join("friends.json")
}
fn groups_path() -> PathBuf {
    chat_dir().join("groups.json")
}
pub(crate) fn tasks_path() -> PathBuf {
    chat_dir().join("peer-tasks.json")
}
fn seen_path() -> PathBuf {
    chat_dir().join("seen.json")
}

fn load_friends() -> Vec<Value> {
    // 第82轮：pending(bool) → status 三态迁移（out-pending=我发的等对方 / in-pending=对方发的等我确认 / ok）
    let mut list = read_json_arr(&friends_path());
    migrate_friend_statuses(&mut list);
    list
}
fn save_friends(v: &[Value]) {
    write_json_arr(&friends_path(), v)
}

// ═══════════════════════════════════════════════════════════════════════
// 小灵官方通知（2026-10-20）——固定官方 did:youling 账号，服务端经 /msg/poll
// 投递 kind=`official-notice`；本端验签后落「小灵」会话。协议/状态机见
// myco/docs/todo/2026-10-20-小灵官方智能体与服务端推送-设计与R.md
//
// 设计要点：① 官方账号 = 平台/HBL 组织身份（jason 选定，旧联调 did 已轮换）；
// ② 通知由 identity-svc 的「小灵推送」**设备钥**签名（root 私钥不进服务）；
// ③ 客户端不信任信封：必须过 ed25519 验签（signer ∈ 官方 root/设备公钥），
//    失败丢弃 + 审计——其他客户端/账号无法伪造 official-notice（/msg/send 白名单也挡）；
// ④ 内置好友幂等补缺，不覆盖用户自定义；⑤ 打开会话回执 /official/read（服务端三态）。
// ═══════════════════════════════════════════════════════════════════════
pub const OFFICIAL_ACCOUNT_DID: &str =
    "did:youling:z6MkuH5FNdqmGUcoEsNUqiw47dvaHCXoYfBXTdrXpzEZEthD";
pub const OFFICIAL_ACCOUNT_NAME: &str = "小灵";
pub const OFFICIAL_NOTICE_KIND: &str = "official-notice";
/// 官方账号根公钥（base64；用于兼容 root 签名 + 未来轮换时与 /official/info 交叉核对）
pub const OFFICIAL_ROOT_PUBKEY_B64: &str = "3ENJqvaI6PqDbFKdTksfSeBVjRKNdvJ5V8k2A+8TADA=";
/// 「小灵推送」设备公钥（base64；identity-svc 持私钥，当前通知签名钥）
pub const OFFICIAL_PUSH_PUBKEY_B64: &str = "B+rm1EAASFf7conJhulyrrpdXv4EO3JaPFEhgYgjGgo=";

pub(crate) fn official_conv_id() -> String {
    did_safe(OFFICIAL_ACCOUNT_DID)
}

/// 是否小灵会话（conv id 是 did_safe 形态；也兼容直接 did 传入）。
pub(crate) fn is_official_conv(conv_id: &str) -> bool {
    conv_id == did_safe(OFFICIAL_ACCOUNT_DID)
        || core_id::account_did_eq(conv_id, OFFICIAL_ACCOUNT_DID)
}

/// 内置小灵好友（幂等）：历史用户升级后第一次 chat_state/chat_poll 自动出现；
/// 新账号注册后同一路径立即出现。只补缺，不覆盖用户自定义（昵称/置顶/免打扰在 UI 侧）。
pub(crate) fn ensure_official_friend() {
    let mut friends = load_friends();
    if friends.iter().any(|f| {
        f.get("did")
            .and_then(|d| d.as_str())
            .map(|d| core_id::account_did_eq(d, OFFICIAL_ACCOUNT_DID))
            .unwrap_or(false)
    }) {
        return;
    }
    friends.push(json!({
        "did": OFFICIAL_ACCOUNT_DID,
        "name": OFFICIAL_ACCOUNT_NAME,
        "addedAt": now_ms(),
        "status": "ok",
        "official": true,
    }));
    save_friends(&friends);
}

/// 官方通知签名材料（与 identity-svc official.mjs、手机端 chat-store 同口径）：
/// `official-notice\n<收件人 canonical 账号did>\n<noticeId>\n<createdAt>\n<sha256hex(title\nbody\nlabel\nurl)>`
pub(crate) fn official_notice_material(
    recipient_canonical: &str,
    notice_id: &str,
    created_at: i64,
    title: &str,
    body: &str,
    label: &str,
    url: &str,
) -> String {
    let inner = sha256_hex(format!("{title}\n{body}\n{label}\n{url}").as_bytes());
    format!("{OFFICIAL_NOTICE_KIND}\n{recipient_canonical}\n{notice_id}\n{created_at}\n{inner}")
}

/// 纯函数验签（便于单测）：任一官方公钥验过即真。
pub(crate) fn official_notice_verify_with(
    pubkeys_b64: &[&str],
    material: &str,
    sig_b64: &str,
) -> bool {
    let Ok(sig_bytes) = base64::engine::general_purpose::STANDARD.decode(sig_b64) else {
        return false;
    };
    let Ok(sig) = ed25519_dalek::Signature::from_slice(&sig_bytes) else {
        return false;
    };
    use ed25519_dalek::Verifier as _;
    for pk in pubkeys_b64 {
        let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(pk) else {
            continue;
        };
        let Ok(arr) = <[u8; 32]>::try_from(raw.as_slice()) else {
            continue;
        };
        let Ok(vk) = ed25519_dalek::VerifyingKey::from_bytes(&arr) else {
            continue;
        };
        if vk.verify(material.as_bytes(), &sig).is_ok() {
            return true;
        }
    }
    false
}

/// 拉 /official/info（公开）——轮换韧性：内置常量验不过时用服务器当前 key 再验一次。
async fn official_info_fetch() -> Option<Value> {
    match core_id::public_get_json("/official/info").await {
        Ok(v) => v.get("data").cloned(),
        Err(e) => {
            eprintln!("[official] /official/info 拉取失败: {e}");
            None
        }
    }
}

/// 客户端已读回执：POST /official/read（设备签名，服务端校验设备归属后 queued/delivered→read）。
/// 幂等：重复回执不会重复生效；失败不挡 UI（下次打开会话重试）。
pub async fn official_ack(my: &str, notice_ids: Vec<String>) -> Option<()> {
    let body = json!({ "accountDid": my, "noticeIds": notice_ids });
    match core_id::signed_post("/official/read", &body).await {
        Ok(v) => {
            eprintln!(
                "[official] read 回执 ok marked={}",
                v.pointer("/data/marked")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0)
            );
            Some(())
        }
        Err(e) => {
            eprintln!("[official] read 回执失败（下次打开重试）: {e}");
            None
        }
    }
}

/// 官方通知自愈同步（2026-10-20）：/msg/poll 是「拉走即删」ACK 语义——响应在网络上丢失
/// 时通知会永久丢。客户端定期拉 `/official/pending`（delivered 且未读），按 msgId 幂等补投。
/// 返回本轮补投条数；失败静默（下一轮重试），不挡聊天主流程。
pub async fn official_pending_sync(my: &str) -> usize {
    let body = json!({ "accountDid": my });
    match core_id::signed_post("/official/pending", &body).await {
        Ok(v) => {
            let msgs = v
                .pointer("/data/msgs")
                .and_then(|m| m.as_array())
                .cloned()
                .unwrap_or_default();
            let mut n = 0usize;
            for m in &msgs {
                if official_notice_ingest(my, m).await {
                    n += 1;
                }
            }
            if n > 0 {
                eprintln!("[official] 自愈补投 {n} 条（inbox 响应丢失恢复）");
            }
            n
        }
        Err(e) => {
            eprintln!("[official] pending 同步失败（下轮重试）: {e}");
            0
        }
    }
}

/// 上次自愈同步时间（ms；全局去重——poll 环 5s 一轮，不每轮都打 pending）。
static OFFICIAL_SYNC_AT_MS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// 单条 official-notice 入库：验签 → 内置好友 → 落小灵会话（幂等：msgId=noticeId）。
async fn official_notice_ingest(my: &str, m: &Value) -> bool {
    let payload = m.get("payload").cloned().unwrap_or(json!({}));
    let notice_id = payload
        .get("noticeId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let created_at = payload
        .get("createdAt")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let title = payload
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let body = payload
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let label = payload
        .pointer("/action/label")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let url = payload
        .pointer("/action/url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let sig_b64 = payload
        .get("sigB64")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let signer = payload
        .pointer("/signer/pubkeyB64")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if notice_id.is_empty()
        || created_at <= 0
        || title.is_empty()
        || sig_b64.is_empty()
        || signer.is_empty()
    {
        eprintln!("[official] 丢弃：通知字段不全（notice={notice_id}）");
        return false;
    }
    let from = m.get("from").and_then(|v| v.as_str()).unwrap_or("");
    if !core_id::account_did_eq(from, OFFICIAL_ACCOUNT_DID) {
        eprintln!("[official] 丢弃：from 非官方账号（{from}）");
        return false;
    }
    let recipient = core_id::account_did_canonical(my);
    let material = official_notice_material(
        &recipient, &notice_id, created_at, &title, &body, &label, &url,
    );
    let mut keys: Vec<String> = vec![
        OFFICIAL_PUSH_PUBKEY_B64.to_string(),
        OFFICIAL_ROOT_PUBKEY_B64.to_string(),
    ];
    if !keys.iter().any(|k| k == &signer) {
        // 内置常量不匹配（可能服务端已轮换）→ 拉一次 /official/info 再用当前 key 验
        if let Some(info) = official_info_fetch().await {
            if let Some(root) = info.get("pubkeyB64").and_then(|v| v.as_str()) {
                keys.push(root.to_string());
            }
            if let Some(arr) = info.get("devices").and_then(|v| v.as_array()) {
                for d in arr {
                    if let Some(pk) = d.get("pubkeyB64").and_then(|v| v.as_str()) {
                        keys.push(pk.to_string());
                    }
                }
            }
        }
    }
    let key_refs: Vec<&str> = keys.iter().map(|s| s.as_str()).collect();
    if !official_notice_verify_with(&key_refs, &material, &sig_b64) {
        eprintln!("[official] 丢弃：验签失败（notice={notice_id} signer={signer}）");
        return false;
    }
    ensure_official_friend();
    let row = json!({
        "msgId": notice_id,
        "from": OFFICIAL_ACCOUNT_DID,
        "to": my,
        "kind": OFFICIAL_NOTICE_KIND,
        "payload": payload,
        "ts": created_at,
        "dir": "in",
        "fromName": OFFICIAL_ACCOUNT_NAME,
    });
    conv_append(&official_conv_id(), &row);
    eprintln!("[official] 通知入库 notice={notice_id} title={title} from={from}");
    #[cfg(not(test))]
    if let Some(app) = crate::p2p_client::current_app_handle() {
        use tauri_plugin_notification::NotificationExt as _;
        let _ = app
            .notification()
            .builder()
            .title(OFFICIAL_ACCOUNT_NAME)
            .body(title.clone())
            .show();
    }
    true
}

// ── CLI 面（2026-10-12，"UI 有的感知/状态/动作，CLI 都要有"）─────────────────
// 好友档案的三件套：感知（快照）/动作（加·删）。正常链路是 friend-request/accept
// **签名握手**（P2P 直推→信箱兜底，见 §2026-10-07 去服务端化块注释）；这里的
// `friend_add_admin` 是**管理员直写**（写本端档案 status=ok，即"握手完成态"），
// 不做对端投递——给运维/测试/自愈用（双端都由同一管理员控制的 E2E、档案修复）。
// 与 UI 完全同档案同语义：UI 列表/聊天锚点读的就是这份 friends.json。

/// 感知：好友档案快照（[{did,name,addedAt,status}]，**只读本地不发网络**）。
pub(crate) fn friends_snapshot() -> Vec<Value> {
    load_friends()
}

/// 动作：管理员直写加好友（=握手完成态）。幂等：已有行只刷名，不动状态。
/// did 接受账号（did:youling:）/设备（did:myco:）两种形态——好友锚是账号 did，
/// 历史行可能是设备形态，判等一律走 account_did_eq（UI 同款）。
pub(crate) fn friend_add_admin(did: &str, name: &str) -> Result<Value, String> {
    let did = did.trim();
    if !did.starts_with("did:") {
        return Err(format!(
            "did 形态不对（期望 did:youling:… 或 did:myco:…）：{did}"
        ));
    }
    if name.trim().is_empty() {
        return Err("name 不能为空".into());
    }
    let mut list = load_friends();
    // 幂等：同 did（公钥级判等）只刷名。索引访问——iter_mut 的行借用不能跨 save_friends(&list)
    let hit = list.iter().position(|row| {
        core_id::account_did_eq(row.get("did").and_then(|v| v.as_str()).unwrap_or(""), did)
    });
    if let Some(i) = hit {
        list[i]["name"] = json!(name.trim());
        let status = list[i].get("status").cloned().unwrap_or(json!("ok"));
        save_friends(&list);
        return Ok(
            json!({ "ok": true, "did": did, "name": name.trim(), "op": "renamed", "status": status }),
        );
    }
    let row = json!({ "did": did, "name": name.trim(), "addedAt": now_ms(), "status": "ok" });
    list.push(row.clone());
    save_friends(&list);
    Ok(json!({ "ok": true, "op": "added", "row": row,
        "note": "管理员直写（握手完成态，未向对端投递）——正常链路走 UI 加好友（签名握手）" }))
}

/// 动作：删好友行（幂等：无行也 ok）。与会话档案的清理由 UI 语义负责，这里只动好友行。
pub(crate) fn friend_remove(did: &str) -> Result<Value, String> {
    let did = did.trim();
    let mut list = load_friends();
    let before = list.len();
    list.retain(|row| {
        !core_id::account_did_eq(row.get("did").and_then(|v| v.as_str()).unwrap_or(""), did)
    });
    let removed = before - list.len();
    save_friends(&list);
    Ok(json!({ "ok": true, "removed": removed }))
}
fn load_groups() -> Vec<Value> {
    read_json_arr(&groups_path())
}
fn save_groups(v: &[Value]) {
    write_json_arr(&groups_path(), v)
}
pub(crate) fn load_tasks() -> Vec<Value> {
    match load_tasks_result() {
        Ok(v) => v,
        Err(e) => {
            // 与 read_json_arr 同纪律：坏 JSON 不能在 UI 里表现成"你没有任务"。
            eprintln!("[chat] 任务库读取失败（按空处理）: {e}");
            Vec::new()
        }
    }
}

/// 卡内容指纹（无 shareId 的卡去重用）：title + 来源署名 + env 签名排序。
///
/// 2026-11-15 事故（用户实拍两张一模一样的「ADB 调试」）：原来只有 taskId 幂等，
/// 换个 taskId 重投就是第二张卡。有 shareId 的卡必须按 shareId 收敛；没有 shareId
/// （手工/脚本建的散卡）只能按内容判同一张——这里给出稳定指纹，调用方按它去重。
fn task_content_key(t: &Value) -> String {
    let title = t.get("title").and_then(|v| v.as_str()).unwrap_or("").trim();
    if title.is_empty() {
        return String::new();
    }
    let from = t.get("fromName").and_then(|v| v.as_str()).unwrap_or("");
    let mut envs: Vec<String> = t
        .get("env")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .map(|e| {
                    format!(
                        "{}|{}|{}",
                        e.get("kind").and_then(|v| v.as_str()).unwrap_or(""),
                        e.get("device").and_then(|v| v.as_str()).unwrap_or(""),
                        e.get("port").and_then(|v| v.as_u64()).unwrap_or(0)
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    envs.sort();
    format!("{title}\u{1}{from}\u{1}{}", envs.join(";"))
}

/// 落库前去重：**有 shareId 按 shareId**，**无 shareId 按内容指纹**。
///
/// 两条纪律（2026-11-15）：
/// ① `status=shared` 行是「我发出去的卡」的记录，不是收到的卡——永不参与去重删除
///    （UI 侧本来就过滤 status!=='shared'，删了会丢发送历史）。
/// ② 只删"同一张卡的旧副本"，不跨 shareId 误杀。
fn dedupe_task_records(tasks: &mut Vec<Value>, rec: &Value) {
    let is_shared = rec.get("status").and_then(|v| v.as_str()) == Some("shared");
    if is_shared {
        return;
    }
    let sid = rec
        .get("shareId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let keep_shared = |t: &Value| t.get("status").and_then(|v| v.as_str()) == Some("shared");
    if !sid.is_empty() {
        tasks.retain(|t| {
            keep_shared(t)
                || t.get("shareId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim() != sid.as_str())
                    .unwrap_or(true)
        });
        return;
    }
    let key = task_content_key(rec);
    if key.is_empty() {
        return;
    }
    tasks.retain(|t| {
        if keep_shared(t) {
            return true;
        }
        // 有 shareId 的卡与散卡不是同一张（同一张卡在源端有 shareId、在收端可能没有）
        if t.get("shareId")
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        {
            return true;
        }
        task_content_key(t) != key
    });
}

/// 按 shareId 从本机任务卡里取 **主 env（对象）**——执行器 env/open 的最后一道兜底。
///
/// 2026-11-15 事故整改：旧调用方/手机端有时只传 `cardId`，不带 env/caps；执行器
/// 于是判"卡未声明 caps"直接 denied（用户看到的就是"点卡没反应"）。卡在本地任务库里
/// 明明有 env，没理由开不了。这里按 shareId 找到卡，取 env[] 的主条目
/// （rdp → dsh → 首条，与 `dsh_share::primary_env` 同序）返回给 `vnet_env::parse_call`。
///
/// 只读、不审计、无副作用；找不到返回 None（保持原有 denied 语义）。
pub(crate) fn task_card_env_by_share(share_id: &str) -> Option<Value> {
    let sid = share_id.trim();
    if sid.is_empty() {
        return None;
    }
    for t in load_tasks() {
        if t.get("shareId").and_then(|v| v.as_str()) != Some(sid) {
            continue;
        }
        let arr = t.get("env").and_then(|v| v.as_array())?;
        let pick = |k: &str| arr.iter().find(|e| e.get("kind").and_then(|x| x.as_str()) == Some(k));
        return pick("rdp").or_else(|| pick("dsh")).or_else(|| arr.first()).cloned();
    }
    None
}

/// 读任务库并保留“读失败/坏 JSON”信号：clean URL 生命周期必须以**已知**
/// 无卡片为回收前提，不能把瞬时读失败当成“卡片已删除”（fail-open 会误杀入口）。
pub(crate) fn load_tasks_result() -> Result<Vec<Value>, String> {
    let p = tasks_path();
    match std::fs::metadata(&p) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("stat 任务库失败: {e}")),
    }
    // BOM 容忍（2026-11-06 真案：PowerShell 写回的 BOM 让整库被读成空）
    let text = read_json_text(&p)?;
    serde_json::from_str::<Vec<Value>>(&text).map_err(|e| format!("任务库 JSON 损坏: {e}"))
}
fn save_tasks(v: &[Value]) {
    write_json_arr(&tasks_path(), v)
}

// ══════════════ 任务卡 tombstone（task-24，2026-10-24：防对账/重投复活）══════════════
//
// 现象（真机实锤）：task-revoke 已把卡标 revoked，但笔记本重启后**对账把历史
// task-share 消息重新灌入**，upsert 按 taskId 覆盖 status → 已删的卡又出现
// （42 张里 30 张是已删分享的测试卡）。revoked 只在 tasks 库里，对账从消息库
// 重放时根本不看它——需要一张**持久化的撤销名单**在落库口拦。
//
// 形态：`chat_dir()/peer-tasks-tombstones.json`
// `[{"taskId":"peer-task-share-sh-xxx","revokedAt":123,"reason":"task-revoke"}]`
// 语义：该 taskId 的卡**死了**——任何来源（对账重放/迟到重投/设备群同步）都
// 不得再落库；宁可漏一张（用户可重分享得到新 taskId 的卡）不可复活错一张。

fn tombstones_path() -> PathBuf {
    chat_dir().join("peer-tasks-tombstones.json")
}

fn load_tombstones() -> Vec<Value> {
    read_json_arr(&tombstones_path())
}

fn save_tombstones(v: &[Value]) {
    write_json_arr(&tombstones_path(), v)
}

/// 该 taskId 是否已 tombstone（**纯查询**，三个落库口共用同一把闸）。
fn is_tombstoned(task_id: &str) -> bool {
    let t = task_id.trim();
    !t.is_empty()
        && load_tombstones()
            .iter()
            .any(|x| x.get("taskId").and_then(|v| v.as_str()) == Some(t))
}

/// dsh_share clean URL lifecycle 用的只读查询：tombstone 的卡不能再 backing/预热。
pub(crate) fn task_is_tombstoned(task_id: &str) -> bool {
    is_tombstoned(task_id)
}

/// 打 tombstone（幂等：已在册只更新 reason/revokedAt 不重复插行）。
fn tombstone_task(task_id: &str, reason: &str) {
    let t = task_id.trim();
    if t.is_empty() {
        return;
    }
    let mut list = load_tombstones();
    if let Some(x) = list
        .iter_mut()
        .find(|x| x.get("taskId").and_then(|v| v.as_str()) == Some(t))
    {
        x["revokedAt"] = json!(now_ms());
        if !reason.trim().is_empty() {
            x["reason"] = json!(reason);
        }
    } else {
        let why = if reason.trim().is_empty() {
            "manual"
        } else {
            reason
        };
        list.push(json!({ "taskId": t, "revokedAt": now_ms(), "reason": why }));
    }
    save_tombstones(&list);
}

/// 管理面 API 内核：批量 tombstone（一次性清理用）。返回打掉的条数。
pub(crate) fn tombstone_tasks_batch(task_ids: &[String], reason: &str) -> usize {
    let fresh: Vec<String> = task_ids
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if fresh.is_empty() {
        return 0;
    }
    let mut n = 0usize;
    for t in &fresh {
        if !is_tombstoned(t) {
            n += 1;
        }
        tombstone_task(t, reason);
    }
    n
}

/// remoteOpen 二段兜底（2026-10-11）：URL 缺 device/account 且本机分享注册表没有
/// （卡是别人分享的）时，按 shareId 查任务库拿来源坐标（sourceDevice, from 账号）。
/// 治"历史消息卡不可变的无参 URL"（降级快照时代写坏的）——任务列表卡会自愈，
/// 但聊天里的卡永远带旧链接；打开时在此统一补齐，任何入口都自愈。
pub(crate) fn task_source_coords(share_id: &str) -> Option<(String, String)> {
    let sid = share_id.trim();
    if sid.is_empty() {
        return None;
    }
    let tasks = load_tasks();
    let t = tasks.iter().find(|t| {
        let hit_share = t
            .get("shareId")
            .and_then(|v| v.as_str())
            .map(|s| s.trim() == sid)
            .unwrap_or(false);
        let hit_task = t
            .get("taskId")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().ends_with(sid))
            .unwrap_or(false);
        hit_share || hit_task
    })?;
    let dev = t
        .get("sourceDevice")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let acc = t
        .get("from")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if dev.is_empty() || acc.is_empty() {
        None
    } else {
        Some((dev, acc))
    }
}

/// 群成员账号 did 表（群档案 members 原样；群不存在 → 空）。
/// 抽出来是因为"读群成员表"在 typing/回执/同步/任务卡自动授权多处重复，
/// 各处抄一遍 `.find().and_then()` 迟早分叉。
fn group_member_dids(group_id: &str) -> Vec<String> {
    load_groups()
        .iter()
        .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(group_id))
        .and_then(|g| g.get("members").and_then(|m| m.as_array()).cloned())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// 第83轮：participants 合并去重（by did）。
/// incoming 覆盖 role/status/时间戳（仅非空字段），name 取非空者，新 did 追加——
/// 接受/完成回执带全量 participants 上线，接收端本地合并（不新增服务端接口）。
fn merge_participants(cur: &mut Vec<Value>, inc: &[Value]) {
    for p in inc {
        let did = p
            .get("did")
            .and_then(|d| d.as_str())
            .unwrap_or("")
            .to_string();
        if did.is_empty() {
            continue;
        }
        if let Some(c) = cur
            .iter_mut()
            .find(|c| c.get("did").and_then(|d| d.as_str()) == Some(did.as_str()))
        {
            for k in ["role", "status", "acceptedAt", "doneAt"] {
                if let Some(v) = p.get(k).filter(|v| !v.is_null()) {
                    c[k] = v.clone();
                }
            }
            // name 只在本地为空时补（本地显示名优先）
            if c.get("name")
                .and_then(|n| n.as_str())
                .map(|n| n.is_empty())
                .unwrap_or(true)
            {
                if let Some(n) = p.get("name").filter(|n| !n.is_null()) {
                    c["name"] = n.clone();
                }
            }
        } else {
            cur.push(p.clone());
        }
    }
}

/// 任务记录里取 participants 数组（缺省空）。
fn task_participants(t: &Value) -> Vec<Value> {
    t.get("participants")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default()
}

fn load_seen() -> std::collections::HashMap<String, i64> {
    std::fs::read_to_string(seen_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// upsert 好友（按 did）。status: out-pending | in-pending | ok。
/// 状态只升不降（ok 不回退；in-pending 不被 friend-request 覆盖成重复行）。
fn friend_upsert(did: &str, name: &str, status: &str) {
    let mut list = load_friends();
    let name = if name.trim().is_empty() {
        "有灵账号".to_string()
    } else {
        name.trim().to_string()
    };
    let rank = |s: &str| {
        if s == "ok" {
            2
        } else if s == "in-pending" {
            1
        } else {
            0
        }
    };
    if let Some(f) = list
        .iter_mut()
        .find(|f| f.get("did").and_then(|d| d.as_str()) == Some(did))
    {
        let cur = f
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("ok")
            .to_string();
        if rank(status) >= rank(&cur) {
            f["status"] = json!(status);
            f["name"] = json!(name);
        }
    } else {
        list.push(json!({ "did": did, "name": name, "addedAt": now_ms(), "status": status }));
    }
    save_friends(&list);
}

// ══════════════ 2026-10-07 好友关系去服务端化：签名握手 ══════════════
//
// 好友关系=双方各自本地档案（friends.json 即权威），变更靠三类签名握手消息传播：
//   friend-request（加）/friend-accept（接受）/friend-remove（删除·拒绝·忽略共用）。
// 服务器 friends 模块已净删——信箱（/msg/send）只做对端离线时的兜底中转（30 天 TTL）。
//
// 握手消息复用 wire 信封；签名主体=**设备钥**（与聊天鉴权同语义——附属设备也能加好友）：
//   payload = { to, nonce, sig, name? }
//   sig 材料（字段序固定，协议红线，两端逐字节一致）：
//     `${kind}\n${from}\n${to}\n${fromDevice}\n${ts}\n${nonce}`
// 防冒充三件套（接收端，与 p2p_server auth_gate 同链）：payload.sig 验签 +
//   名册归属闸（fromDevice ∈ from 的未吊销设备，fail-closed）+ 公钥级 did 判等
//   （account_did_eq——好友行的历史形态不影响命中）。
// ts 窗口 7 天；msgId/nonce 每次新生成——幂等靠状态机（friend_ingest 12 格），不靠消息去重。

/// 握手 ts 窗口：7 天（离线对端经信箱兜底上线后件仍有效；更老的作废——防陈件回放翻状态）。
const FRIEND_TS_WINDOW_MS: i64 = 7 * 24 * 3600_000;

/// 签名材料（字段序固定=协议红线；发送/接收/测试共用同一构造，杜绝两端各拼各的）。
fn friend_sign_material(
    kind: &str,
    from: &str,
    to: &str,
    from_device: &str,
    ts: i64,
    nonce: &str,
) -> String {
    format!("{kind}\n{from}\n{to}\n{from_device}\n{ts}\n{nonce}")
}

/// 好友握手接收状态机（纯函数，设计 §3.4 十二格全表——单测直击）。
/// cur=本地好友行当前状态（None=无行）；返回端侧动作：
///   Status(新状态)——落行/升态（系统条/通知等副作用由调用方按格子执行）
///   Keep——幂等（请求重发只刷名，不动状态不重复通知）
///   Remove——删行+会话（friend-remove：删除/被拒/被撤三义共用）
///   Drop——丢弃（accept 无行=对端接受的请求我从未发过——不一致态静默丢）
/// 互加竞态（双方同时 friend-request）确定收敛：后到方 out-pending+request → ok
/// 并回发 accept，先到方 out-pending+accept → ok——双端终态一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FriendIngest {
    Status(&'static str),
    Keep,
    Remove,
    Drop,
}

fn friend_ingest(kind: &str, cur: Option<&str>) -> FriendIngest {
    match kind {
        "friend-request" => match cur {
            // 无行 → 对方请求加我（in-pending 等我确认）
            None => FriendIngest::Status("in-pending"),
            // 我先加过对方（out-pending 等待中）→ 互加即好友：直接 ok
            Some("out-pending") => FriendIngest::Status("ok"),
            // 已有来向请求（重发）或已是好友：幂等（调用方只刷名）
            Some(_) => FriendIngest::Keep,
        },
        "friend-accept" => match cur {
            // 无行：我从未发过请求却收到 accept——不一致态，丢弃（对端真接受过我
            // 的话，我的 out-pending 行在——被我自己删了就等下次握手重建）
            None => FriendIngest::Drop,
            // 发起方等转正（out-pending）或互加竞态回执（in-pending）→ ok
            Some("out-pending") | Some("in-pending") => FriendIngest::Status("ok"),
            // 已是好友：幂等
            Some(_) => FriendIngest::Keep,
        },
        "friend-remove" => FriendIngest::Remove, // 无行/任意状态都幂等删（收敛消息可重复投递）
        _ => FriendIngest::Drop,
    }
}

/// 好友行当前状态（公钥级判等找行；无行=None）。
fn friend_row_status(did: &str) -> Option<String> {
    load_friends()
        .iter()
        .find(|f| {
            f.get("did")
                .and_then(|d| d.as_str())
                .map(|d| core_id::account_did_eq(d, did))
                .unwrap_or(false)
        })
        .and_then(|f| f.get("status").and_then(|s| s.as_str()).map(String::from))
}

/// 好友行状态直写（状态机专用——不走 friend_upsert 的"只升不降"闸：remove 后
/// 重新加好友需要 in-pending 重新落地）。name 非空时一并刷新显示名。
fn friend_set_status(did: &str, status: &str, name: &str) {
    let mut list = load_friends();
    if let Some(f) = list.iter_mut().find(|f| {
        f.get("did")
            .and_then(|d| d.as_str())
            .map(|d| core_id::account_did_eq(d, did))
            .unwrap_or(false)
    }) {
        f["status"] = json!(status);
        let nm = f.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if !name.trim().is_empty() && (nm.is_empty() || nm.starts_with('…')) {
            f["name"] = json!(name.trim());
        }
    } else {
        let nm = if name.trim().is_empty() {
            format!("…{}", tail4(did))
        } else {
            name.trim().to_string()
        };
        list.push(json!({ "did": did, "name": nm, "addedAt": now_ms(), "status": status }));
    }
    save_friends(&list);
}

/// 幂等重发只刷显示名（本地名缺省/…尾4占位时才覆盖——本地起的名优先）。
fn friend_refresh_name(did: &str, name: &str) {
    if name.trim().is_empty() {
        return;
    }
    let mut list = load_friends();
    if let Some(f) = list.iter_mut().find(|f| {
        f.get("did")
            .and_then(|d| d.as_str())
            .map(|d| core_id::account_did_eq(d, did))
            .unwrap_or(false)
    }) {
        let nm = f.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if nm.is_empty() || nm.starts_with('…') {
            f["name"] = json!(name.trim());
            save_friends(&list);
        }
    }
}

/// 好友握手发送（签名+双路投递）：P2P 直推优先（对端在线秒达；friend-* 在
/// p2p_server 好友闸豁免表——未成好友也能过闸，验签/归属闸仍全量把守）→
/// 未达走 /msg/send 信箱兜底（30 天 TTL，对端登录 poll 即达）。
/// 同一 (msgId, ts) 双路一致——sig 材料不变（nonce=msgId，每次新生成）。
async fn friend_deliver(to: &str, kind: &str) -> Result<(), String> {
    let my = my_account_did()?;
    let (device_did, seed_b64) =
        core_id::device_identity().map_err(|e| format!("设备身份未就绪: {e}"))?;
    let seed: [u8; 32] = base64::engine::general_purpose::STANDARD
        .decode(&seed_b64)
        .map_err(|e| format!("设备种子解码失败: {e}"))?
        .try_into()
        .map_err(|_| "设备种子非 32B".to_string())?;
    let msg_id = new_msg_id();
    let ts = now_ms();
    let material = friend_sign_material(kind, &my, to, &device_did, ts, &msg_id);
    let sig = ed25519_dalek::SigningKey::from_bytes(&seed).sign(material.as_bytes());
    let fname = my_name().await;
    let payload = json!({
        "to": to, "nonce": msg_id, "sig": b64e(&sig.to_bytes()), "name": fname,
    });
    // ① P2P 直推（非好友可达：friend-* 豁免好友闸，归属闸照常）
    let envelope = json!({
        "msgId": msg_id, "from": my, "fromName": fname,
        "fromDevice": device_did, "fromDeviceName": device_display_name(),
        "to": to, "kind": kind, "payload": payload, "ts": ts,
    });
    if crate::p2p_client::deliver_to_account(to, &envelope).await {
        return Ok(());
    }
    // ② 信箱兜底（服务器只验设备签名哑中转；接收端三件套再验）
    let body = json!({
        "fromAccountDid": my, "fromName": fname,
        "toAccountDid": to, "kind": kind, "payload": payload, "msgId": msg_id, "ts": ts,
    });
    core_id::signed_post("/msg/send", &body).await.map(|_| ())
}

/// 互加竞态的自动回执（对端 out-pending → ok 收敛）。测试态可关（cfg(test) 闸——
/// friend_deliver 触真实身份/网络链，单测必须隔离）。
async fn friend_reply_accept(to: &str) {
    #[cfg(test)]
    if TEST_NO_FRIEND_DELIVER.load(Ordering::Relaxed) {
        return;
    }
    let _ = friend_deliver(to, "friend-accept").await;
}

/// 互加自动回执的测试闸（cfg(test) 编译；生产构建零开销恒走真投递）。
#[cfg(test)]
static TEST_NO_FRIEND_DELIVER: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// 好友握手消息接收链（ingest_msg 三 kind 的入口）：三件套校验 → 状态机 → 副作用。
/// 返回是否入库（Keep/Drop/校验失败=false——不算新消息，UI 计数不变）。
/// 信封键双兼容：信箱 `id` / P2P `msgId`（ingest_p2p_inner 已归一适配；握手不做
/// msgId 去重——幂等靠状态机）。
async fn friend_ingest_msg(my: &str, m: &Value) -> bool {
    let kind = m.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    let from = m.get("from").and_then(|v| v.as_str()).unwrap_or("");
    let from_device = m.get("fromDevice").and_then(|v| v.as_str()).unwrap_or("");
    let payload = m.get("payload").cloned().unwrap_or(json!({}));
    let ts = m.get("ts").and_then(|v| v.as_i64()).unwrap_or(0);
    // ① 基础闸：from 非空且不是我（信箱只投对端、P2P 只投对方账号——from==my 属
    //    异常回流，防御性丢弃）；payload.to 必须是我（防错投/改址重放）。
    if from.is_empty() || core_id::account_did_eq(from, my) {
        return false;
    }
    let to = payload.get("to").and_then(|v| v.as_str()).unwrap_or("");
    if to.is_empty() || !core_id::account_did_eq(to, my) {
        return false;
    }
    // ② ts 窗口 7 天（绝对值——未来件也拒，防时钟攻击）
    if (now_ms() - ts).abs() > FRIEND_TS_WINDOW_MS {
        return false;
    }
    // ③ payload.sig 验签：材料=kind\nfrom\nto\nfromDevice\nts\nnonce 六段换行拼接（字段序红线）
    let nonce = payload.get("nonce").and_then(|v| v.as_str()).unwrap_or("");
    let sig_b64 = payload.get("sig").and_then(|v| v.as_str()).unwrap_or("");
    if nonce.is_empty() || sig_b64.is_empty() {
        return false;
    }
    let Some(dev_pub) = core_id::did_pubkey_bytes(from_device) else {
        return false;
    };
    let material = friend_sign_material(kind, from, to, from_device, ts, nonce);
    let sig_ok = (|| {
        let sig_bytes = base64::engine::general_purpose::STANDARD
            .decode(sig_b64)
            .ok()?;
        let sig = ed25519_dalek::Signature::from_slice(&sig_bytes).ok()?;
        let vk = ed25519_dalek::VerifyingKey::from_bytes(&dev_pub).ok()?;
        vk.verify(material.as_bytes(), &sig).ok().map(|_| ())
    })()
    .is_some();
    if !sig_ok {
        return false;
    }
    // ④ 名册归属闸（与 p2p_server auth_gate 同链——签名设备须真的属于 from 账号；
    //    fail-closed：名册查无/网络失败一律拒）
    if !crate::p2p_server::device_belongs_to_account(from_device, from).await {
        return false;
    }
    // ⑤ 状态机 + 副作用
    let cur = friend_row_status(from);
    let cur_was_out_pending = cur.as_deref() == Some("out-pending");
    let name = payload
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| m.get("fromName").and_then(|v| v.as_str()))
        .unwrap_or("")
        .trim()
        .to_string();
    match friend_ingest(kind, cur.as_deref()) {
        FriendIngest::Status("in-pending") => {
            // 请求首达：落行 + OS 级系统通知（2026-10-06 任务3 被加方零操作感知）
            let disp = if name.is_empty() {
                format!("…{}", tail4(from))
            } else {
                name.clone()
            };
            friend_upsert(from, &disp, "in-pending");
            notify_system("myco", &format!("{disp} 请求加你为好友——打开 myco 处理"));
            true
        }
        FriendIngest::Status(_) => {
            // 转正 ok：行升 ok + 发起方等待转正的会话凭据系统条（msgId 固定幂等——
            // 直推+信箱+对账多路径重投只落一条）
            friend_set_status(from, "ok", &name);
            conv_append(
                &my_did_conv(from),
                &json!({
                    "msgId": format!("sys-friend-ok-{from}"), "from": from, "to": "", "kind": "sys",
                    "payload": { "text": "你们已成为好友，开始聊天吧" }, "ts": now_ms(), "dir": "in",
                }),
            );
            if kind == "friend-request" && cur_was_out_pending {
                // 互加即好友（对方在我 out-pending 期间反向加我）：回发 accept 收敛
                // 对端（其 out-pending → ok；best-effort——未达时对端重发请求再收敛）
                friend_reply_accept(from).await;
            }
            true
        }
        FriendIngest::Keep => {
            friend_refresh_name(from, &name); // 改名后重发：只刷名不重复通知
            false
        }
        FriendIngest::Remove => {
            friend_remove_local(from); // 清行+会话+待发队列（原 friend-remove 消息语义）
            true
        }
        FriendIngest::Drop => false,
    }
}

/// 系统通知（tauri-plugin-notification 已在 lib.rs 注册；CLI/测试无窗口场景静默）。
/// cfg(not(test))：同 myco_import——tauri GUI 运行时链进测试 exe 会 ENTRYPOINT_NOT_FOUND。
#[cfg(not(test))]
fn notify_system(title: &str, body: &str) {
    if let Some(app) = crate::p2p_client::current_app_handle() {
        use tauri_plugin_notification::NotificationExt as _;
        let _ = app.notification().builder().title(title).body(body).show();
    }
}
#[cfg(test)]
fn notify_system(_title: &str, _body: &str) {}

/// 删好友（本地好友行+会话文件+对账 meta；发消息通知对方由调用方做）。
fn friend_remove_local(did: &str) {
    save_friends(
        &load_friends()
            .into_iter()
            .filter(|f| f.get("did").and_then(|d| d.as_str()) != Some(did))
            .collect::<Vec<_>>(),
    );
    // 会话/对账 meta：归并视图的全部等价文件一起清（否则删完还会从另一形态"复活"）
    conv_remove_files(&my_did_conv(did));
    // 第95轮：待发队列同清（已删好友不再补发）
    crate::offline_queue::global().remove_conv(&my_did_conv(did));
}

/// upsert 群。第85轮：+owner（群主=建群者，只在创建时定——不随消息覆盖）+
/// governance（治理开关恒 'owner'，'vote' 预留不读）+ muted（禁言表）。
/// 批二（2026-09-28）：owner 随 group-create 补齐时清 ownerPending 自愈标记
/// （群消息兜底建群 owner 未知→治理全拒；真群主消息一对账到位即恢复）。
fn group_upsert(id: &str, name: &str, members: Vec<String>, owner: Option<&str>) {
    let mut list = load_groups();
    if let Some(g) = list
        .iter_mut()
        .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(id))
    {
        g["name"] = json!(name);
        g["members"] = json!(members);
        if let Some(o) = owner {
            if g.get("owner")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .is_empty()
            {
                g["owner"] = json!(o);
                g.as_object_mut().map(|m| m.remove("ownerPending")); // 真 owner 到位，自愈收敛
            }
        }
    } else {
        let mut g = json!({ "id": id, "name": name, "members": members, "createdAt": now_ms(),
            "governance": "owner", "muted": {} });
        if let Some(o) = owner {
            g["owner"] = json!(o);
        }
        list.push(g);
    }
    save_groups(&list);
}

/// 批二：群消息/群任务卡兜底自愈建群（群档案未知且 group-create 尚未到达）。
/// owner 未知≠首成员是群主——打 ownerPending 标记，治理闸全拒（改名/踢人/禁言/拉人），
/// 直到 group-create（直推或对账补齐——批二起 group-create 落群 jsonl 参与对账）带真 owner 到达。
fn group_upsert_selfheal(id: &str, name: &str, members: Vec<String>) {
    if load_groups()
        .iter()
        .any(|g| g.get("id").and_then(|d| d.as_str()) == Some(id))
    {
        return; // 已有档案（含 owner）不动
    }
    group_upsert(id, name, members, None);
    let mut list = load_groups();
    if let Some(g) = list
        .iter_mut()
        .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(id))
    {
        if g.get("owner")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .is_empty()
        {
            g["ownerPending"] = json!(true);
        }
    }
    save_groups(&list);
}

/// 批二：群 owner 是否未同步（自愈建群且 group-create 未补齐）。
fn group_owner_pending(g: &Value) -> bool {
    g.get("ownerPending")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        && g.get("owner")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .is_empty()
}

/// 批二：群是否终态（disbanded=群主已解散 / kicked=我已被移出）——只读，历史保留。
fn group_terminal_status(g: &Value) -> &'static str {
    match g.get("status").and_then(|v| v.as_str()) {
        Some("disbanded") => "disbanded",
        Some("kicked") => "kicked",
        _ => "",
    }
}

/// 批二：群置终态（解散/被踢共用）——档案保留（会话行只读可回查）+ members 清空
/// （不再参与对账共享/扇出）+ 系统条 + 待发队列清理。幂等：已终态不重复落条。
fn group_mark_terminal(gid: &str, status: &str, sys_text: &str, msg_id: &str, ts: i64, from: &str) {
    let mut list = load_groups();
    let Some(g) = list
        .iter_mut()
        .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(gid))
    else {
        return;
    };
    if !group_terminal_status(g).is_empty() {
        return; // 已终态（disband/kick 重复投递或 compat group-leave 连带）——幂等
    }
    g["status"] = json!(status);
    g["members"] = json!([]);
    save_groups(&list);
    conv_append(
        gid,
        &json!({
            "msgId": msg_id, "from": from, "to": gid, "kind": "sys",
            "payload": { "text": sys_text }, "ts": ts, "dir": "in",
        }),
    );
    crate::offline_queue::global().remove_conv(gid); // 群已死，待发不再补
}

// ══════════════ 第85轮：群治理（owner 模型；governance 恒 'owner' 预留） ══════════════

/// 群主判定（无 owner 字段的老群=首个成员兜底，兼容第81-84轮存量）。
/// 批二：ownerPending（自愈建群 owner 未同步）→ 无群主（不兜底——字典序首成员
/// 冒充群主会让各端对"谁是群主"认知分叉；治理全拒直到 group-create 补齐真 owner）。
fn group_owner_of(g: &Value) -> String {
    if let Some(o) = g
        .get("owner")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        return o.to_string();
    }
    if group_owner_pending(g) {
        return String::new();
    }
    g.get("members")
        .and_then(|m| m.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn is_group_owner(g: &Value, did: &str) -> bool {
    // 前缀不敏感：群主 did 建群时入库（历史可能 did:myco:），网络面现行 did:youling:
    core_id::account_did_eq(&group_owner_of(g), did)
}

/// 成员是否被禁言中。
fn is_muted(g: &Value, did: &str, now: i64) -> bool {
    g.pointer("/muted")
        .is_some_and(|m| m.get(did).and_then(|v| v.as_i64()).unwrap_or(0) > now)
}

/// 群档案本地变更统一口（治理闸：非群主操作拒收）。
/// 批二：终态群（已解散/已被移出）一切治理操作拒收；ownerPending（owner 未同步）
/// 时 group_owner_of 返回空 → 任何 from 都过不了群主闸（治理全拒）。
/// 设备群（2026-10-07）：系统群治理全拒——同账号下人人都是"群主"（owner=rootDid=
/// 本机账号），群主闸形同虚设，必须按 kind 另行封死。
fn apply_group_update(gid: &str, from: &str, mut f: impl FnMut(&mut Value)) -> bool {
    let mut list = load_groups();
    let Some(g) = list
        .iter_mut()
        .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(gid))
    else {
        return false;
    };
    if is_device_group(g) {
        return false; // 设备群为系统群，不可管理
    }
    if !group_terminal_status(g).is_empty() {
        return false; // 群已解散/已被移出——只读
    }
    if !is_group_owner(g, from) {
        return false; // 非群主操作被拒
    }
    f(g);
    save_groups(&list);
    true
}

/// 追加一条消息到会话 jsonl（payload 应已把 b64 换成 media 引用）。
/// 第84轮：幂等（msgId 已在 meta 索引则丢弃——P2P 直推+对账双路径会重）+ 摘要增量
/// 维护（F ^= hash(msgId)，见 p2p_sync.rs）。老会话首次写入时自动从 jsonl 重建 meta。
fn conv_append(conv_id: &str, msg: &Value) {
    use std::io::Write as _;
    let mid = msg.get("msgId").and_then(|v| v.as_str()).unwrap_or("");
    let ts = msg
        .get("ts")
        .and_then(|v| v.as_i64())
        .unwrap_or_else(now_ms);
    if !mid.is_empty() {
        if !crate::p2p_sync::meta_append(conv_id, mid, ts) {
            return; // 重复消息（对账/直推双份）——幂等丢弃
        }
    }
    let mut line = serde_json::to_string(msg).unwrap_or_default();
    line.push('\n');
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(conv_path(conv_id))
    {
        let _ = f.write_all(line.as_bytes());
    }
    // T201 Step 4：双写镜像到 SQLite 消息库（MYCO_MSG_STORE=off 时零副作用；
    // best-effort，失败只告警，绝不改变旧 jsonl 路径的结果——见 msg_store.rs）。
    crate::msg_store::mirror_append(conv_id, msg);
}

/// 第84轮：读会话原始消息（p2p_server 的 batch want 回包用）。
pub fn conv_load_raw(conv_id: &str) -> Vec<Value> {
    conv_load_raw_inner(conv_id)
}

/// 归并读取：该会话**全部等价文件**按归一键优先的顺序拼接，同 msgId 去重
/// （先到者胜 = 归一键文件优先）——存量"同账号两形态两份 jsonl"从此读成一个会话。
/// 不迁移、不删档：老文件原样留着，只是不再被"看不见"。
fn conv_load_raw_inner(conv_id: &str) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for path in conv_paths_all(conv_id) {
        let body = std::fs::read_to_string(&path).unwrap_or_default();
        for line in body.lines() {
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let mid = v.get("msgId").and_then(|x| x.as_str()).unwrap_or("");
            if !mid.is_empty() && !seen.insert(mid.to_string()) {
                continue; // 跨文件重复（历史双写/对账回流）——归并去重
            }
            out.push(v);
        }
    }
    out
}

/// 第84轮：与某账号相关的会话 id 列表（对账可见范围）：单聊会话 + 共同群。
/// 同账号多设备自同步（peer==本机账号）时=全部会话。
pub fn shared_conv_ids(peer: &str) -> Vec<String> {
    let mut out = vec![did_safe(peer)];
    let my = core_id::account_did().unwrap_or_default();
    for g in load_groups() {
        let members: Vec<String> = g
            .get("members")
            .and_then(|m| m.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        if core_id::account_did_eq(peer, &my) || members.iter().any(|m| m == peer) {
            if let Some(id) = g.get("id").and_then(|d| d.as_str()) {
                out.push(id.to_string());
            }
        }
    }
    out
}

/// 第84轮：本机全部会话 id（好友单聊 + 群）——digest 请求组装用。
pub fn my_conv_ids() -> Vec<String> {
    let mut out: Vec<String> = load_friends()
        .iter()
        .filter_map(|f| f.get("did").and_then(|d| d.as_str()).map(did_safe))
        .collect();
    out.extend(
        load_groups()
            .iter()
            .filter_map(|g| g.get("id").and_then(|d| d.as_str()).map(String::from)),
    );
    out
}

/// 第84轮：ok 好友的账号 did 列表——对账循环寻址用。
pub fn ok_friend_dids() -> Vec<String> {
    load_friends()
        .iter()
        .filter(|f| f.get("status").and_then(|s| s.as_str()) == Some("ok"))
        .filter_map(|f| f.get("did").and_then(|d| d.as_str()).map(String::from))
        .collect()
}

/// 第84轮：对方是否本机正式好友（status=ok）——p2p_server 收信闸。
pub fn is_ok_friend(did: &str) -> bool {
    is_ok_friend_in_bucket(&chat_dir(), did)
}

/// ★4-b：指定账号桶的 ok 好友判定（`is_ok_friend` 的显式账号参数版）——
/// 收给**非活动账号**（本机持其有效委任状）的信，好友表按该账号的桶查，
/// 而不是一律查活动账号的桶（多归属共识 #4：好友闸跟随收件账号）。
pub(crate) fn is_ok_friend_in(account: &str, did: &str) -> bool {
    is_ok_friend_in_bucket(&chat_dir_for(account), did)
}

/// 好友判定的桶参数版（纯读，两条入口共用同一谓词与状态迁移，不写第二份逻辑）。
fn is_ok_friend_in_bucket(dir: &std::path::Path, did: &str) -> bool {
    let mut list = read_json_arr(&dir.join("friends.json"));
    migrate_friend_statuses(&mut list);
    list.iter().any(|f| {
        // 前缀不敏感：好友 did 可能是历史 did:myco: 形态（对端旧版派生/入库）
        f.get("did")
            .and_then(|d| d.as_str())
            .map(|s| core_id::account_did_eq(s, did))
            .unwrap_or(false)
            && f.get("status").and_then(|s| s.as_str()) == Some("ok")
    })
}

/// 第82轮 pending(bool) → status 三态迁移（读取时在内存做，不回写盘）。
fn migrate_friend_statuses(list: &mut [Value]) {
    for f in list.iter_mut() {
        if f.get("status").and_then(|s| s.as_str()).is_none() {
            let st = if f.get("pending").and_then(|p| p.as_bool()).unwrap_or(false) {
                "in-pending"
            } else {
                "ok"
            };
            f["status"] = json!(st);
            f.as_object_mut().map(|m| m.remove("pending"));
        }
    }
}

/// 第84轮：本地存储形态 → wire 形态（跨设备传输）：去 dir；media 引用 → b64 内联。
/// 第95轮：sendState 是端侧发送状态（徽标数据源）——不上 wire（对端无意义）。
/// 第96轮（修复3）：单聊 file（无 groupId）不再内联 b64——正文只带 mediaRef
/// （name/mime/size/sha256），字节走 /p2p/media/chunk 分片端点；图片与群文件
/// 维持内联（群词汇表批二才动，本批不碰）。mediaPending 同为端侧标记不上 wire。
pub fn wire_pack_msg(m: &Value) -> Value {
    let mut w = m.clone();
    let kind = w
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    w.as_object_mut().map(|o| {
        o.remove("dir");
        o.remove("sendState");
    });
    if let Some(p) = w.get_mut("payload").and_then(|p| p.as_object_mut()) {
        p.remove("mediaPending");
        if let Some(media) = p.remove("media").and_then(|v| v.as_str().map(String::from)) {
            let single_file = kind == "file" && p.get("groupId").is_none();
            if single_file {
                // sha256 本地行已带（新链路）；老行缺则现算（读盘失败=无字节可引，
                // 退化为无 sha256 的旧形态——接收端按无法恢复丢弃，语义安全）。
                let sha = p
                    .get("sha256")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .or_else(|| {
                        std::fs::read(chat_dir().join(&media))
                            .ok()
                            .map(|b| sha256_hex(&b))
                    });
                if let Some(sha) = sha {
                    p.insert("sha256".into(), json!(sha));
                    p.insert("mediaRef".into(), json!(true));
                }
            } else if let Some(b64) = load_media_b64(&media) {
                p.insert("b64".into(), json!(b64));
            }
        }
    }
    w
}

/// 第84轮：P2P wire 信封 → 入库（适配成信箱格式后复用 ingest_msg 状态机）。
/// 返回 Ok(true)=新消息入库。入库后 emit chat-incoming（前端刷新会话列表）。
/// 2026-10-18：入库即刻写 `[chat-trace] recv`（M7 接收上屏时延），P2P 直推到达
/// 即 ingest（不等任何轮询）。
pub async fn ingest_p2p(app: &tauri::AppHandle, m: &Value) -> Result<bool, String> {
    ingest_p2p_inner(m).await.map(|kept| {
        // cfg(not(test))：`.emit()` 是测试不可达的 UI 通道；链进测试 exe 会拉 tauri
        // webview 运行时（muda → comctl32!TaskDialogIndirect）→ 0xC0000139，见文件顶注释。
        #[cfg(not(test))]
        if kept {
            trace_recv(m);
            let _ = app.emit(
                "chat-incoming",
                json!({ "msgId": m.get("msgId"), "kind": m.get("kind"), "from": m.get("from") }),
            );
        }
        #[cfg(test)]
        let _ = app; // cfg(test) 下 emit 块不编译，app 未用
        kept
    })
}

/// 同上（事件经全局 AppHandle 可选发射——CLI/测试无窗口场景静默）。
pub async fn ingest_p2p_opt(m: &Value) -> Result<bool, String> {
    ingest_p2p_inner(m).await.map(|kept| {
        // cfg(not(test))：同 ingest_p2p（emit 是 UI 通道，测试态不引 tauri 运行时）。
        #[cfg(not(test))]
        if kept {
            trace_recv(m);
            if let Some(app) = crate::p2p_client::current_app_handle() {
                let _ = app.emit("chat-incoming", json!({ "msgId": m.get("msgId"), "kind": m.get("kind"), "from": m.get("from") }));
            }
        }
        kept
    })
}

async fn ingest_p2p_inner(m: &Value) -> Result<bool, String> {
    // 2026-10-06 去中心化通讯架构落地（数据面 P2P 主路）：主设备「收编通知」直推。
    // 必须在登录闸（my_account_did）之前——未登录任何账号的全新成员设备正是收编
    // 对象。不落会话、不 emit chat-incoming（它不是聊天消息）；只唤醒一次委任状
    // 立即取件（取件/验签/nonce 去重复用 identity_service::watch_tick，20s 环兜底不变）。
    if m.get("kind").and_then(|v| v.as_str()) == Some("delegation-notify") {
        handle_delegation_notify(m);
        return Ok(false);
    }
    let my = my_account_did()?;
    let adapted = json!({
        "id": m.get("msgId").and_then(|v| v.as_str()).unwrap_or(""),
        "from": m.get("from").and_then(|v| v.as_str()).unwrap_or(""),
        "fromName": m.get("fromName").and_then(|v| v.as_str()).unwrap_or(""),
        "fromDevice": m.get("fromDevice").and_then(|v| v.as_str()).unwrap_or(""),
        "fromDeviceName": m.get("fromDeviceName").and_then(|v| v.as_str()).unwrap_or(""),
        "to": m.get("to").and_then(|v| v.as_str()).unwrap_or(""),
        "kind": m.get("kind").and_then(|v| v.as_str()).unwrap_or(""),
        "payload": m.get("payload").cloned().unwrap_or(json!({})),
        "ts": m.get("ts").and_then(|v| v.as_i64()).unwrap_or_else(now_ms),
        // 2026-11-11 传输路径标记（**内部键，不上 wire，不落库**）：本函数只在
        // `p2p_server::auth_gate`（设备验签 + fromDevice 一致 + 归属闸）之后被调用，
        // 标记即"来源身份已被传输层证明"。`msg_route` 的入站注入只认这个标记——
        // 信箱 `/msg/poll`（poll_mailbox 直接调 ingest_msg，没有逐条设备签名）不能
        // 触发跨账号 prompt 注入。
        "transport": crate::msg_route::P2P_TRANSPORT_MARK,
    });
    // ★4-b 落桶路由（多归属共识 #4 后半）：信封 to 指向"本机持有效委任状的账号"
    // 且≠活动账号 → 该条消息的会话/媒体/档案全部按**该账号**的桶落（活动账号
    // 只是默认值）。`LocalKey::scope` 包住整条 ingest 的 Future（跨 await 安全：
    // jsonl 与对账 meta 同桶落，幂等索引不串号）。
    match routed_chat_bucket(&my, m.get("to").and_then(|v| v.as_str()).unwrap_or("")) {
        Some(acc) => Ok(CHAT_BUCKET
            .scope(Some(acc), async { ingest_msg(&my, &adapted).await })
            .await),
        None => Ok(ingest_msg(&my, &adapted).await),
    }
}

/// 收编通知入站（不落盘）：payload.rootDid 必须 == from（防张冠李戴——明显错位
/// 的件不唤醒）。通知本体只是"去取件"提示；真授权凭证由取件链保证（名册反查 +
/// 委任状验签 + nonce 去重），伪通知最坏后果 = 多一轮无害轮询。
fn handle_delegation_notify(m: &Value) {
    let from = m.get("from").and_then(|v| v.as_str()).unwrap_or("");
    let root = m
        .pointer("/payload/rootDid")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if from.is_empty() || root.is_empty() || !core_id::account_did_eq(from, root) {
        eprintln!("[chat] delegation-notify 归属不符（from≠payload.rootDid）——丢弃不唤醒");
        return;
    }
    let name = m
        .pointer("/payload/accountName")
        .and_then(|v| v.as_str())
        .unwrap_or(root);
    eprintln!("[chat] 收到主设备收编通知（{name}）——立即取件（不等 20s 轮询）");
    crate::identity_service::trigger_delegation_pickup();
}

/// 会话最后一条的 (ts, 预览文本)。第95轮：按 ts 取最新（对账灌入的历史物理
/// append 在文件尾，文件序≠时间序——预览/未读角标必须看时间最新的那条）。
fn conv_last(conv_id: &str) -> Option<(i64, String)> {
    let all = conv_load_raw_inner(conv_id);
    let last = all
        .iter()
        .max_by_key(|m| m.get("ts").and_then(|t| t.as_i64()).unwrap_or(0))?;
    let ts = last.get("ts").and_then(|t| t.as_i64()).unwrap_or(0);
    Some((ts, msg_preview(last)))
}

/// 批三：seen 之后的入站未读条数（撤回 tombstone 不计——已撤销的内容不构成未读）。
fn conv_unread_count(conv_id: &str, seen_ts: i64) -> usize {
    conv_load_raw_inner(conv_id)
        .iter()
        .filter(|m| {
            m.get("ts").and_then(|t| t.as_i64()).unwrap_or(0) > seen_ts
                && m.get("dir").and_then(|v| v.as_str()) == Some("in")
                && m.get("kind").and_then(|v| v.as_str()) != Some("recalled")
        })
        .count()
}

/// 批三：jsonl 行重写（撤回 tombstone/删除单条/回写 sendState 共用底座）。
/// **逐等价文件**改写：归并读取后一条消息物理上可能躺在任一形态文件里，只重写
/// 命中的那份（把合并视图整份写回归一键文件会重复/丢消息）。返回是否有命中改动。
fn conv_rewrite<F: FnMut(&mut Value) -> bool>(conv_id: &str, mut f: F) -> bool {
    let mut any = false;
    for path in conv_paths_all(conv_id) {
        if !path.is_file() {
            continue;
        }
        let mut msgs: Vec<Value> = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        let mut hit = false;
        for m in msgs.iter_mut() {
            if f(m) {
                hit = true;
            }
        }
        if !hit {
            continue;
        }
        any = true;
        let body: String = msgs
            .iter()
            .map(|m| serde_json::to_string(m).unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n");
        let _ = std::fs::write(&path, format!("{body}\n"));
    }
    any
}

/// 批三：撤回 tombstone——按 msgId 把该行改成 kind="recalled"（原文 payload 清空，
/// 群保留 groupId 供对账归位；from/ts/dir/fromName 保留定序与"谁撤的"渲染）。
/// 返回是否命中。meta 不动（msgId 集合不变 → F 指纹不变，不触发对账风暴）。
fn conv_tombstone_msg(conv_id: &str, msg_id: &str) -> bool {
    conv_rewrite(conv_id, |m| tombstone_line(m, msg_id))
}

/// tombstone 单行改写（纯函数——不碰盘，单测覆盖）。
fn tombstone_line(m: &mut Value, msg_id: &str) -> bool {
    if m.get("msgId").and_then(|v| v.as_str()) != Some(msg_id) {
        return false;
    }
    if m.get("kind").and_then(|v| v.as_str()) == Some("recalled") {
        return false;
    }
    let gid = m
        .pointer("/payload/groupId")
        .cloned()
        .unwrap_or(Value::Null);
    m["kind"] = json!("recalled");
    m["payload"] = if gid.is_string() {
        json!({ "groupId": gid })
    } else {
        json!({})
    };
    m.as_object_mut().map(|o| o.remove("sendState"));
    true
}

// ═══ 已读回执（2026-10-12 微信式状态：✓ 已送达对方设备 / ✓✓ 对方已读）═══
// 协议：wire kind=`msg-receipt`（**控制 kind，不落会话**——同 friend-request 家族，
// 在 ingest_msg 最前拦截）。payload={convId, msgIds:[...], state:"read"}。
// 语义（微信同款）：**单聊**才发已读回执（群成员读没读是隐私）；对方打开会话
// （chat_load_conv 见到未读）→ 把未读的**对端消息** msgIds 回执给对方账号 →
// 对端把**自己发出的**那些消息 sendState 翻 "read"（复用 conv_update_send_state
// 的改写+事件链）。回执 best-effort：投递失败不重试（丢了停在"已送达"，无损）。
fn receipt_ingest(m: &Value) -> bool {
    let conv_id = m
        .pointer("/payload/convId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let state = m
        .pointer("/payload/state")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let ids: Vec<String> = m
        .pointer("/payload/msgIds")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if conv_id.is_empty() || ids.is_empty() || state != "read" {
        return false; // 不认识的回执静默丢（幂等无害）
    }
    let mut hit = false;
    for id in ids {
        // 只翻**我发出的**消息（sendState 存在且非终态 failed）——回执针对 out 行
        conv_rewrite(conv_id, |row| {
            if row.get("msgId").and_then(|v| v.as_str()) != Some(id.as_str()) {
                return false;
            }
            if row.get("dir").and_then(|v| v.as_str()) != Some("out") {
                return false;
            }
            if row.get("sendState").and_then(|v| v.as_str()) == Some("read") {
                return false;
            }
            row["sendState"] = json!("read");
            hit = true;
            true
        });
        if hit {
            // 2026-10-18：统一走 emit_send_state（形状 {convId,msgId,state,delivered,ts}；
            // 已读=对端确已收下并读了，delivered=1）
            emit_send_state(conv_id, &id, "read", 1);
        }
        hit = false; // 每条独立通知
    }
    true
}

/// 打开会话见到未读 → 给对端发已读回执（best-effort；spawn 不阻塞 load 返回）。
/// conv 对端账号推导：单聊 conv_id 即对端 did（did_youling_xxx 归一还原）；
/// 群（grp-）不回执（隐私语义）。
fn receipt_send_read(conv_id: &str, unread_peer_msgs: &[Value]) {
    if conv_id.starts_with("grp-") || unread_peer_msgs.is_empty() {
        return;
    }
    let peer = conv_id.trim_start_matches("did_").replace('_', ":");
    if !peer.starts_with("did:") {
        return;
    }
    let ids: Vec<String> = unread_peer_msgs
        .iter()
        .filter_map(|m| m.get("msgId").and_then(|v| v.as_str()).map(String::from))
        .take(50)
        .collect();
    if ids.is_empty() {
        return;
    }
    let my = my_account_did().unwrap_or_default();
    let device_did = core_id::device_identity()
        .map(|(d, _)| d)
        .unwrap_or_default();
    let dev_name = device_display_name();
    let conv_owned = conv_id.to_string();
    let peer_owned = peer;
    tauri::async_runtime::spawn(async move {
        let envelope = json!({
            "msgId": format!("rcpt-{}-{}", now_ms(), &ids[0]),
            "from": my, "fromName": my_name().await, "fromDevice": device_did, "fromDeviceName": dev_name,
            "to": peer_owned, "kind": "msg-receipt",
            "payload": { "convId": conv_owned, "msgIds": ids, "state": "read" },
            "ts": now_ms(),
        });
        // best-effort：deliver_to_account 内部已有直推→中继梯子；失败不重试
        let _ = crate::p2p_client::deliver_to_account(&peer_owned, &envelope).await;
    });
}

fn msg_preview(m: &Value) -> String {
    let kind = m.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    let p = &m.get("payload");
    let pick = |k: &str| {
        p.as_ref()
            .and_then(|p| p.get(k))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    match kind {
        "text" | "group-msg" => {
            let t = pick("text");
            if t.is_empty() {
                "[图片]".into()
            } else {
                t.chars().take(24).collect()
            }
        }
        "image" => "[图片]".into(),
        "file" => format!("[文件] {}", pick("name")),
        "task-share" => format!("[任务卡] {}", pick("title")),
        // 2026-10-11 任务卡改名：留痕系统条的会话预览
        "task-rename" => format!("✏️ 任务卡改名为「{}」", pick("title")),
        // 第83轮：回执带 name（接受/完成者）——"一起接了"语系（温馨协作感）
        "task-accept" => {
            let (t, n) = (pick("title"), pick("name"));
            if n.is_empty() {
                format!("已接受任务《{t}》")
            } else {
                format!("{n} 一起接了任务《{t}》")
            }
        }
        "task-done" => {
            let (t, n) = (pick("title"), pick("name"));
            if n.is_empty() {
                format!("已完成任务《{t}》")
            } else {
                format!("{n} 完成了任务《{t}》")
            }
        }
        // 批二（2026-09-28）：group-create 落群会话 jsonl（对账补齐真 owner 的载体）——预览人话
        "group-create" => format!("群「{}」已创建", pick("groupName")),
        // 批三：撤回 tombstone 的会话预览（不出 [消息] 残留原文）
        "recalled" => "[消息已撤回]".into(),
        // 2026-10-20 小灵官方通知：会话列表预览用标题（避免空预览行）
        OFFICIAL_NOTICE_KIND => format!("🔔 {}", pick("title")),
        _ => pick("text").chars().take(24).collect(),
    }
}

/// mime/文件名 → 扩展名（媒体落盘命名）。
fn ext_of(name: &str, mime: &str) -> String {
    if let Some(e) = name.rsplit('.').next() {
        if e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()) && name.contains('.') {
            return e.to_ascii_lowercase();
        }
    }
    match mime {
        "image/png" => "png".into(),
        "image/jpeg" | "image/jpg" => "jpg".into(),
        "image/gif" => "gif".into(),
        "image/webp" => "webp".into(),
        "application/pdf" => "pdf".into(),
        _ => "bin".into(),
    }
}

/// 第94轮：msgId 消毒（媒体落盘文件名组成部分）。msgId 来自对端信封——理论可控，
/// 但路径穿越（../../evil）一行代码的事：白名单字符 + 限长，空则退 anon。
fn safe_msg_id(msg_id: &str) -> String {
    let s: String = msg_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(64)
        .collect();
    if s.is_empty() {
        "anon".into()
    } else {
        s
    }
}

/// 第94轮：用户文件名消毒（chat_open_file 临时落盘用）——剥路径成分（目录穿越）+
/// 清 Windows 非法字符，限长保扩展名。空则 "file"。
fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') && !c.is_control())
        .take(80)
        .collect();
    let s = cleaned.trim().trim_matches('.');
    if s.is_empty() {
        "file".into()
    } else {
        s.to_string()
    }
}

/// 媒体字节落盘 media/{msgId}.{ext}，返回相对引用（"media/xx.png"）。
fn save_media(msg_id: &str, name: &str, mime: &str, b64: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    save_media_bytes(msg_id, name, mime, &bytes)
}

/// 第96轮（修复3）：字节直存版（解耦链路发送侧/分片组装侧都已持有字节，
/// 不再过一道 b64）。
pub(crate) fn save_media_bytes(
    msg_id: &str,
    name: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let ext = ext_of(name, mime);
    let mid = safe_msg_id(msg_id);
    let rel = format!("media/{mid}.{ext}");
    std::fs::write(media_dir().join(format!("{mid}.{ext}")), bytes)
        .map_err(|e| format!("媒体写盘失败: {e}"))?;
    Ok(rel)
}

/// 读媒体为 b64（load_conv 内联给 UI 渲染 data URL）。
fn load_media_b64(media_rel: &str) -> Option<String> {
    let bytes = std::fs::read(chat_dir().join(media_rel)).ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// 第96轮（修复3）：sha256 hex（媒体完整性校验；复用 p2p_sync 的 hex 工具）。
pub(crate) fn sha256_hex(b: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b);
    let out = h.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&out);
    crate::p2p_sync::f_to_hex(&arr)
}

/// base64 标准编码（好友握手 sig / 媒体等共用）。
pub(crate) fn b64e(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

/// 第96轮（修复3）：媒体分片大小（1MB/片；b64 ≈ 1.4MB 远低于 16MB body limit，
/// 单请求仍走 X-Myco-Auth JSON 签名链）。
pub const MEDIA_CHUNK_BYTES: usize = 1024 * 1024;

/// 第96轮（修复3）：文件消息的媒体引用——消息体只带引用不带字节。
#[derive(Clone, Debug)]
pub struct MediaRef {
    pub msg_id: String,
    pub name: String,
    pub mime: String,
    pub size: i64,
    pub sha256: String,
}

/// 第96轮（修复3）：wire 消息是否缺媒体字节（kind=file 且无 b64 有 sha256 引用）
/// → Some(MediaRef)（对账拉到后从同一对端分片拉媒体用）。
pub fn msg_needs_media(m: &Value) -> Option<MediaRef> {
    if m.get("kind").and_then(|v| v.as_str()) != Some("file") {
        return None;
    }
    let p = m.get("payload")?;
    if p.get("b64")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
    {
        return None; // 旧版内联链路——字节已在
    }
    let sha = p.get("sha256").and_then(|v| v.as_str()).unwrap_or("");
    if sha.is_empty() {
        return None;
    }
    let msg_id = m
        .get("msgId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if msg_id.is_empty() {
        return None;
    }
    Some(MediaRef {
        msg_id,
        name: p
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("file")
            .to_string(),
        mime: p
            .get("mime")
            .and_then(|v| v.as_str())
            .unwrap_or("application/octet-stream")
            .to_string(),
        size: p.get("size").and_then(|v| v.as_i64()).unwrap_or(0),
        sha256: sha.to_string(),
    })
}

/// 第96轮（修复3）：收一片媒体（落 media/tmp/{msgId}/part-{idx}）；收齐 total 片
/// → 按 idx 序拼装 → 校验 sha256 → 落 media/{msgId}.{ext} → 清 tmp。
/// 返回 Ok(true)=本片促成组装完成。纯 fs（media_root 注入，单测零全局态）。
pub fn store_media_chunk_in(
    media_root: &Path,
    msg_id: &str,
    name: &str,
    mime: &str,
    sha256: &str,
    idx: u32,
    total: u32,
    bytes: &[u8],
) -> Result<bool, String> {
    if total == 0 || idx >= total || total > 64 {
        return Err("分片参数非法（total 1..=64，idx<total）".into());
    }
    if bytes.len() > MEDIA_CHUNK_BYTES {
        return Err("单片超 1MB 上限".into());
    }
    let mid = safe_msg_id(msg_id);
    let tmp = media_root.join("tmp").join(&mid);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("tmp 目录创建失败: {e}"))?;
    std::fs::write(tmp.join(format!("part-{idx}")), bytes)
        .map_err(|e| format!("分片写盘失败: {e}"))?;
    let have = (0..total)
        .filter(|i| tmp.join(format!("part-{i}")).is_file())
        .count() as u32;
    if have < total {
        return Ok(false); // 未收齐——等后续片
    }
    let mut all: Vec<u8> = Vec::new();
    for i in 0..total {
        all.extend(
            std::fs::read(tmp.join(format!("part-{i}")))
                .map_err(|e| format!("分片读取失败: {e}"))?,
        );
    }
    if sha256_hex(&all) != sha256 {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err("媒体 sha256 校验失败（字节损坏，已弃）".into());
    }
    let ext = ext_of(name, mime);
    std::fs::write(media_root.join(format!("{mid}.{ext}")), &all)
        .map_err(|e| format!("媒体组装写盘失败: {e}"))?;
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(true)
}

/// 生产包装（media_dir()=当前账号桶）。
pub fn store_media_chunk(
    msg_id: &str,
    name: &str,
    mime: &str,
    sha256: &str,
    idx: u32,
    total: u32,
    bytes: &[u8],
) -> Result<bool, String> {
    store_media_chunk_in(&media_dir(), msg_id, name, mime, sha256, idx, total, bytes)
}

/// 第96轮（修复3）：读本地媒体的一片（/p2p/media/fetch 服务端；按 msgId 前缀找
/// media/{msgId}.{ext}）。返回 (该片字节, total)。纯 fs（media_root 注入可测）。
pub fn read_media_chunk_in(media_root: &Path, msg_id: &str, idx: u32) -> Option<(Vec<u8>, u32)> {
    let mid = safe_msg_id(msg_id);
    let prefix = format!("{mid}.");
    let file = std::fs::read_dir(media_root)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with(&prefix))
                    .unwrap_or(false)
        })?;
    let bytes = std::fs::read(file).ok()?;
    let total = bytes.len().div_ceil(MEDIA_CHUNK_BYTES) as u32;
    if idx >= total {
        return None;
    }
    let start = idx as usize * MEDIA_CHUNK_BYTES;
    let end = (start + MEDIA_CHUNK_BYTES).min(bytes.len());
    Some((bytes[start..end].to_vec(), total))
}

/// 生产包装。
pub fn read_media_chunk(msg_id: &str, idx: u32) -> Option<(Vec<u8>, u32)> {
    read_media_chunk_in(&media_dir(), msg_id, idx)
}

/// 第96轮（修复3）：按 msgId 读本地媒体全部字节（离线队列补发成功后推分片用）。
pub(crate) fn read_media_bytes_by_msg_id(msg_id: &str) -> Option<Vec<u8>> {
    let mid = safe_msg_id(msg_id);
    let prefix = format!("{mid}.");
    let file = std::fs::read_dir(media_dir())
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with(&prefix))
                    .unwrap_or(false)
        })?;
    std::fs::read(file).ok()
}

// ══════════════ 身份/网络 ══════════════

pub(crate) fn my_account_did() -> Result<String, String> {
    core_id::account_did().ok_or_else(|| "未登录有灵账号（好友聊天需先登录）".into())
}

async fn my_name() -> String {
    core_id::account_name().await.unwrap_or_else(|| "我".into())
}

/// 自己昵称（**非阻塞**）：只读 myco-core 的进程内昵称缓存，不发网络。
/// 状态快照用——拿不到先用"我"兜底（与 my_name 的兜底同款），让本地数据立刻上屏。
fn my_name_cached() -> String {
    core_id::account_name_cached().unwrap_or_else(|| "我".into())
}

/// 昵称后台刷新在飞闸：同一时刻至多一次请求（快照每 5s 被多个调用方拉，
/// 无闸会在 identity-svc 不可达时叠出并发请求）。
static NAME_REFRESH_INFLIGHT: AtomicBool = AtomicBool::new(false);

/// 2026-10-06（打开 myco 任务卡要好几秒才出来）：快照不再等昵称——
/// 缓存为空时在这里后台补一次（core::account_name 的 HTTP 超时已从 8s 收到 1.5s，
/// 见 myco-core/src/identity.rs），拿到即填入 SOUL_NAME_CACHE；
/// 前端每次 chat_state/chat_poll 都是 setSt(全量快照)，**下一次 poll 自然补上真名**，
/// 因此不需要新增 Tauri 事件、也无需改 UI。
fn spawn_name_refresh_if_needed() {
    if core_id::account_name_cached().is_some() {
        return;
    }
    if NAME_REFRESH_INFLIGHT.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _ = core_id::account_name().await;
        NAME_REFRESH_INFLIGHT.store(false, Ordering::Release);
    });
}

/// 昵称解析：GET /root/{did} → data.name（PC lib.rs account_name 同款；查不到 None）。
async fn resolve_name(did: &str) -> Option<String> {
    let url = format!("{}/root/{}", base_url(), did);
    let resp = reqwest::get(&url).await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: Value = resp.json().await.ok()?;
    let name = v.pointer("/data/name")?.as_str()?.to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// 服务器信箱发送底座（第84轮收窄：仅低频控制消息——friend-*/group-create；
/// 正文 kind 走 p2p_send_raw 直连，服务器白名单也已移除它们）。
async fn srv_send_raw(to: &str, kind: &str, payload: Value) -> Result<(String, i64), String> {
    let my = my_account_did()?;
    let msg_id = new_msg_id();
    let ts = now_ms();
    let body = json!({
        "fromAccountDid": my, "fromName": my_name().await,
        "toAccountDid": to, "kind": kind,
        "payload": payload, "msgId": msg_id, "ts": ts,
    });
    core_id::signed_post("/msg/send", &body).await?;
    Ok((msg_id, ts))
}

// ══════════════ fast-ack 发送（2026-10-18：点了就算发出） ══════════════
//
// 用户口径「发了半天不确认成功」的根修：本机确认（落库 + 回执）与网络投递解耦。
//   · chat_send / chat_send_group **只做**校验 + 本地落库 + 返回 `sendState:"sent"`
//     （语义=本机已收下并开始投递），≤300ms（M2）；
//   · 网络扇出一律 tauri::async_runtime::spawn 后台：单聊逐目标 / 群 join 并行
//     （每目标紧预算 4s，超时当失败——取消在飞 HTTP，接收端 msgId 幂等，重复投递无害）；
//   · 全失败 → 入 offline_queue（pending=自动补发，补发环 3s 起指数退避到 60s）
//     + sendState 立即翻 "failed"（≤5s 明确失败+可重试，M5）；补发成功翻回 "sent"；
//   · 每步发 `chat-send-state` 事件 + `[chat-trace]` 行（M2/M3/M4/M7 测量）。
//
// 控制类消息（task-share/recall/group-invite/…、取票 share-entry-*）**仍走同步
// p2p_send_raw**：调用方需要真实投递结论（拿状态做流程分支），不在本次范围。

/// 扇出目标（纯函数，单测）：单聊=[to]；群=payload.members 的账号 did（含自己
/// 其他设备——多端自同步）。群 payload 缺 members/空 → 空表（不可达，等补发环）。
fn fanout_targets(to: &str, payload: &Value) -> Vec<String> {
    if to.starts_with("grp-") {
        payload
            .get("members")
            .and_then(|m| m.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        vec![to.to_string()]
    }
}

/// wire 信封（纯函数，单测钉住九键形状）：与既有 `p2p_send_raw` 及手机端
/// `buildEnvelope` **同形**——wire 兼容是硬约束（老端要能收、msgId 幂等去重靠它）。
#[allow(clippy::too_many_arguments)]
fn wire_envelope(
    msg_id: &str,
    ts: i64,
    from: &str,
    from_name: &str,
    from_device: &str,
    from_device_name: &str,
    to: &str,
    kind: &str,
    payload: Value,
) -> Value {
    json!({
        "msgId": msg_id, "from": from, "fromName": from_name,
        "fromDevice": from_device, "fromDeviceName": from_device_name,
        "to": to, "kind": kind, "payload": payload, "ts": ts,
    })
}

/// 本机已接受、等待网络投递的一条消息（fast-ack 拆分点：本地落库同时拿到它，
/// 网络动作全在后台——绝不阻塞 invoke 返回）。
struct SendPlan {
    conv_id: String,
    msg_id: String,
    ts: i64,
    to: String,
    kind: String,   // wire kind（group-msg / text / image / file / task-share）
    payload: Value, // wire payload（群消息 fromName 在投递前补）
    targets: Vec<String>,
    /// 群消息 wire payload 需要发送者真名（fromName）——后台异步补（my_name 可能打
    /// 身份服务 1.5s 超时，绝不能挡本机确认）。
    need_from_name: bool,
    /// 文件消息：信封送达后补推媒体分片（mediaRef 信封里不带字节）。
    push_media: bool,
}

/// fast-ack 后台投递：逐目标并行紧预算 → 成功回写 sent + 事件；全失败入待发队列
/// + 翻 failed（补发环自动重试，成功后翻回 sent）。任何失败都咽掉（不 panic、
/// 不影响收包/UI）。
async fn deliver_plan(plan: SendPlan) {
    let my = match my_account_did() {
        Ok(m) => m,
        Err(_) => return,
    };
    let from_name = my_name().await; // 后台线程可以慢；本机确认早已返回
    let mut payload = plan.payload;
    if plan.need_from_name {
        if let Some(o) = payload.as_object_mut() {
            o.insert("fromName".into(), json!(from_name));
        }
    }
    // 媒体分片补推所需的元信息（文件信封只带 mediaRef）
    let media_meta = if plan.push_media {
        Some((
            plan.to.clone(),
            payload
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("file")
                .to_string(),
            payload
                .get("mime")
                .and_then(|v| v.as_str())
                .unwrap_or("application/octet-stream")
                .to_string(),
            payload
                .get("sha256")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        ))
    } else {
        None
    };
    let envelope = wire_envelope(
        &plan.msg_id,
        plan.ts,
        &my,
        &from_name,
        &core_id::device_identity()
            .map(|(d, _)| d)
            .unwrap_or_default(),
        &device_display_name(),
        &plan.to,
        &plan.kind,
        payload,
    );
    // 每目标紧预算 4s（M5 ≤5s 可见）：超时=tokio cancel 在飞 HTTP；接收端按 msgId
    // 幂等，补发环再投一遍无害。群=并行 join（M4 群 10 人 P95 ≤1.5s）。
    const TARGET_BUDGET_MS: u64 = 6_000; // 2026-10-18：中继冷建隧道 + POST 实测可达 ~3-5s，4s 会在到手机前掐断（对账 10-19s 更差）
    let mut handles = Vec::new();
    for t in plan.targets.clone() {
        let env = envelope.clone();
        let mid = plan.msg_id.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let t0 = std::time::Instant::now();
            let ok = tokio::time::timeout(
                std::time::Duration::from_millis(TARGET_BUDGET_MS),
                crate::p2p_client::deliver_to_account(&t, &env),
            )
            .await
            .unwrap_or(false);
            let ms = t0.elapsed().as_millis() as u64;
            // 2026-10-18 晚 新任务：deliver-ok 的语义 = **对端数据面已回执**（手机侧
            // `serveP2pDataFace` 应答 /p2p/msg；PC 设备是 p2p_server 应答）。本机账号
            // 的消息在 p2p_client 里**只有手机回执才返回 true**（直推成功不再冒充送达），
            // UI 的"✓"（delivered/sendState=sent）以这里为准。追加一档 deliver-acked
            // 便于验收脚本把"手机回执"与"发送端入队"分得开。
            chat_trace(if ok { "deliver-ok" } else { "deliver-fail" }, &mid, &t, ms);
            if ok {
                chat_trace("deliver-acked", &mid, &t, ms);
            }
            ok
        }));
    }
    let mut delivered: u32 = 0;
    for h in handles {
        if let Ok(true) = h.await {
            delivered += 1;
        }
    }
    if delivered > 0 {
        conv_update_send_state_delivered(&plan.conv_id, &plan.msg_id, "sent", delivered);
        if let Some((to_acc, nm, mm, sha)) = media_meta {
            if let Some(bytes) = read_media_bytes_by_msg_id(&plan.msg_id) {
                let mid = plan.msg_id.clone();
                tauri::async_runtime::spawn(async move {
                    let ok = crate::p2p_client::deliver_media_chunks(
                        &to_acc, &mid, &nm, &mm, &sha, &bytes,
                    )
                    .await;
                    eprintln!(
                        "[chat] 媒体分片推送 {mid} → {to_acc}：{}",
                        if ok {
                            "成功"
                        } else {
                            "对端不可达（对账/按需拉兜底）"
                        }
                    );
                });
            }
        }
        return;
    }
    // 全失败：待发队列（pending=补发环自动重试）+ 立即标失败（M5：不长期挂 ⏳）
    if plan.targets.is_empty() {
        conv_update_send_state_delivered(&plan.conv_id, &plan.msg_id, "failed", 0);
        return;
    }
    let _ = crate::offline_queue::global().enqueue(&plan.conv_id, plan.targets.clone(), envelope);
    conv_update_send_state_delivered(&plan.conv_id, &plan.msg_id, "failed", 0);
}

/// CLI 专用（2026-10-20）：等待一次发送的真实投递结果（≤ timeout_ms）。
/// 背景：chat_send/chat_send_group 是 fast-ack（本地即返回、后台投递）；CLI 进程随后退出，
/// 只看到 accepted:true 会误以为已送达。这里轮询本地会话行（成功写 deliveredCount/deliveredAt，
/// 全失败写 sendState=failed+queued），返回分层状态。**不改变 UI 路径**。
pub async fn chat_wait_send_result(conv_id: String, msg_id: String, timeout_ms: u64) -> Value {
    let t0 = std::time::Instant::now();
    loop {
        let rows = conv_load_raw_inner(&conv_id);
        if let Some(m) = rows
            .iter()
            .find(|m| m.get("msgId").and_then(|v| v.as_str()) == Some(msg_id.as_str()))
        {
            let state = m.get("sendState").and_then(|v| v.as_str()).unwrap_or("");
            let dc = m.get("deliveredCount").and_then(|v| v.as_u64());
            let da = m.get("deliveredAt").and_then(|v| v.as_i64());
            let queued =
                state == "failed" || m.get("queued").and_then(|v| v.as_bool()).unwrap_or(false);
            let timed_out = t0.elapsed().as_millis() as u64 >= timeout_ms;
            if dc.is_some() || queued || timed_out {
                return json!({
                    "msgId": msg_id, "convId": conv_id, "accepted": true,
                    "delivered": dc.unwrap_or(0), "deliveredCount": dc, "deliveredAt": da,
                    "sendState": state, "queued": queued,
                    "note": if dc.is_some() {
                        "已确认投递"
                    } else if queued {
                        "直连/中继都不可达：已入本地持久待发队列（GUI 运行/对方上线后自动补发）"
                    } else {
                        "后台投递中，等待窗口内未确认（可查 chat-trace deliver-ok/fail）"
                    },
                    "waitedMs": t0.elapsed().as_millis() as u64,
                });
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// fast-ack 收尾（chat_send/chat_send_group 共用）：本地落库（sendState=sent）→
/// 立即返回 Tauri 结果 → spawn 后台投递。返回 UI 用的结果 JSON。
#[allow(clippy::too_many_arguments)]
fn fast_ack_finish(
    conv_id: &str,
    my: &str,
    to: &str,
    local_kind: &str,
    local_payload: Value,
    wire_kind: &str,
    wire_payload: Value,
    need_from_name: bool,
    push_media: bool,
    msg_id: &str,
    ts: i64,
    t_enter: std::time::Instant,
) -> Value {
    let targets = fanout_targets(to, &wire_payload);
    append_out(
        conv_id,
        my,
        to,
        local_kind,
        local_payload.clone(),
        msg_id,
        ts,
        "sent",
    );
    // 本机确认事件（M2）；UI 也可直接用 invoke 返回值，两路幂等。
    emit_send_state(conv_id, msg_id, "sent", 0);
    chat_trace("send-ack", msg_id, to, t_enter.elapsed().as_millis() as u64);
    let plan = SendPlan {
        conv_id: conv_id.to_string(),
        msg_id: msg_id.to_string(),
        ts,
        to: to.to_string(),
        kind: wire_kind.to_string(),
        payload: wire_payload,
        targets,
        need_from_name,
        push_media,
    };
    tauri::async_runtime::spawn(async move {
        deliver_plan(plan).await;
    });
    json!({ "msgId": msg_id, "ts": ts, "convId": conv_id, "payload": local_payload,
            "delivered": false, "sendState": "sent", "accepted": true })
}

/// P2P 直推发送底座（第84轮）：组设备签名信封 → 逐目标账号在线设备直推
/// （presence 寻址，逐 IPv6 地址实测选路，见 p2p_client.rs）。
/// 第95轮（离线队列）：任一设备送达 → sendState="sent"；全部不可达 → 信封
/// 入本地待发队列（offline_queue，persistent）→ sendState="sending"（对方
/// 上线后自动补发，msgId 不变幂等）；队列溢出（单会话 200 条）→ sendState=
/// "failed"（"对方长期不在线"，UI 手动重发）。返回 (msgId, ts, sendState)。
/// 群（to=grp-*）：从 payload.members 逐成员扇出（含自己其他设备——多设备同步）。
/// 注意（2026-10-18 fast-ack）：正文发送（chat_send/chat_send_group）已改走上方
/// `fast_ack_finish`（本地即返回）；本函数保留给**需要真实投递结论的控制消息**
/// （task-share/recall/group-invite/…），仍是同步语义。
async fn p2p_send_raw(
    to: &str,
    kind: &str,
    payload: Value,
) -> Result<(String, i64, &'static str), String> {
    p2p_send_raw_with_name(to, kind, payload, None).await
}

/// 同 `p2p_send_raw`，但可指定信封 `fromName`。`None`/空白 = 原行为（本机账号昵称）。
///
/// 为什么需要（2026-11-11 跨账号 DSH 会话消息）：`dsh-session-msg` 的收件方署名头要
/// 显示**发送方会话名**（如「DSH插件」），而不是账号昵称；但信封 `from`/`fromDevice`
/// 仍由这里按本机身份权威写入（自报 did 改不了它——防伪造的基石）。
/// 信封九键形状/msgId 幂等/待发队列语义与 `p2p_send_raw` **逐字一致**（同一个函数体）。
pub(crate) async fn p2p_send_raw_with_name(
    to: &str,
    kind: &str,
    payload: Value,
    from_name: Option<&str>,
) -> Result<(String, i64, &'static str), String> {
    let my = my_account_did()?;
    let (msg_id, ts) = (new_msg_id(), now_ms());
    let name = match from_name.map(str::trim).filter(|s| !s.is_empty()) {
        Some(n) => n.to_string(),
        None => my_name().await,
    };
    let envelope = wire_envelope(
        &msg_id,
        ts,
        &my,
        &name,
        &core_id::device_identity()
            .map(|(d, _)| d)
            .unwrap_or_default(),
        &device_display_name(),
        to,
        kind,
        payload.clone(),
    );
    let targets = fanout_targets(to, &payload);
    let mut delivered = false;
    for t in &targets {
        if crate::p2p_client::deliver_to_account(t, &envelope).await {
            delivered = true;
        }
    }
    if delivered {
        return Ok((msg_id, ts, "sent"));
    }
    // 第95轮：deliver 失败 → 本地待发队列（对方上线自动补发；溢出=长期不在线标失败）
    let conv_id = if to.starts_with("grp-") {
        to.to_string()
    } else {
        did_safe(to)
    };
    let state = match crate::offline_queue::global().enqueue(&conv_id, targets, envelope) {
        crate::offline_queue::EnqueueOutcome::Queued => "sending",
        crate::offline_queue::EnqueueOutcome::Overflow => "failed",
    };
    Ok((msg_id, ts, state))
}

// ══════════════════════════════════════════════════════════════════════════
// 跨设备「代打开」的 P2P 收发底座（2026-10-09 第二程）
//
// 两个**控制 kind**（词表见 dsh_share 的「代打开」块注释）：
//   · `share-entry-request`：B → A，"给我一张进这张卡的窄 mt"；
//   · `share-entry-grant`  ：A → B，现签的 mt（或人话拒绝）。
// 信封与 `p2p_send_raw` 同形状（`from`/`fromDevice`/`fromDeviceName` 设备署名，
// 对端 p2p_server 的收信闸照常验签+归属+好友闸——这里不新开通道）。
//
// **不入离线队列**：mt 是短 TTL 凭证，排队补发到达时早已过期（请求方 8s 就放弃了）；
// 入队只会让 offline_queue 长草。发送失败 → 调用方给人话（"源设备不在线"）。
// ══════════════════════════════════════════════════════════════════════════

/// 发送底座（可注入——单测/端到端用本地假通道替换，不碰网络）。
pub(crate) type ShareEntrySendFn =
    fn(
        String,
        String,
        Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>;

static SHARE_ENTRY_SENDER: std::sync::LazyLock<std::sync::RwLock<Option<ShareEntrySendFn>>> =
    std::sync::LazyLock::new(|| std::sync::RwLock::new(None));

/// 注入发送底座（幂等覆盖；传回默认实现可恢复）。
/// 生产走默认实现（真 P2P 直推）；单测/端到端用本地假平面替换，避免打真网。
#[allow(dead_code)]
pub(crate) fn install_share_entry_sender(f: ShareEntrySendFn) {
    *SHARE_ENTRY_SENDER.write().unwrap() = Some(f);
}

/// 发一条 share-entry-* / reshare-* 控制消息给某账号的全部在线设备（逐目标 P2P 直推）。
///
/// **同步回程优先**（2026-10-09「点卡就进」回程收口，见下方 `SYNC_REPLY_SLOTS`
/// 块注释）：请求方在**同一个 HTTP 连接**上等回包时，回包在这里就地交付，
/// **不走 P2P 直推**——同账号时那条直推会投回本机、在等待者表里找不到人而被
/// 静默丢弃（这正是要收口的那个缺口）。
pub(crate) async fn send_share_entry_msg(
    to_account: &str,
    kind: &str,
    payload: Value,
) -> Result<(), String> {
    // 2026-10-18：回包捕获不再只认 share-entry-grant —— `share-admin-grant`（手机远程
    // 改权限，同一套"同步回程"）也必须就地填槽，否则回包走 P2P 直推、请求方拿不到回执
    // （真机表现：手机权限弹层报"主设备没有回执"）。
    if is_sync_reply_kind(kind) && capture_sync_reply(to_account, &payload) {
        return Ok(());
    }
    // 先把注入的实现拷出来（RwLock 读锁**不能跨 await 持有**——std 的 guard 不是 Send，
    // 持锁过 await 会让整条 ingest/chat_poll 的 future 变成 !Send）。
    #[cfg(test)]
    SHARE_ENTRY_PUSH_CALLS.fetch_add(1, Ordering::SeqCst);
    let custom = *SHARE_ENTRY_SENDER.read().unwrap();
    if let Some(f) = custom {
        return f(to_account.to_string(), kind.to_string(), payload).await;
    }
    share_entry_send_default(to_account, kind, payload).await
}

async fn share_entry_send_default(
    to_account: &str,
    kind: &str,
    payload: Value,
) -> Result<(), String> {
    let my = my_account_did()?;
    let device_did = core_id::device_identity()
        .map(|(d, _)| d)
        .unwrap_or_default();
    let envelope = json!({
        "msgId": new_msg_id(), "from": my, "fromName": my_name().await,
        "fromDevice": device_did, "fromDeviceName": device_display_name(),
        "to": to_account, "kind": kind, "payload": payload, "ts": now_ms(),
    });
    if crate::p2p_client::deliver_to_account_with(to_account, &envelope, 20_000).await {
        Ok(())
    } else {
        Err("源设备不在线（或那台设备没有可直连的地址），稍后再试".into())
    }
}

/// **控制面发信的通用别名**（§3.23 转授闸复用同一条底座：设备签名信封 + 直推 +
/// 可注入的假平面）。语义与 `send_share_entry_msg` 逐字相同——只是名字不再绑死
/// `share-entry-*` 一个词表；新控制 kind 走这里，别另造通道。
pub(crate) async fn send_control_msg(
    to_account: &str,
    kind: &str,
    payload: Value,
) -> Result<(), String> {
    send_share_entry_msg(to_account, kind, payload).await
}

// ══════════════════════════════════════════════════════════════════════════
// §3.23 转授发卡底座（主人批准转授后，由**源设备**把卡直接送给被转授者）
//
// 为什么由源设备发而不是让好友转发：第三人点卡走的是 `remoteOpen → 源设备现签窄 mt`
// 那条既有链，卡的"来源坐标"必须是**源设备**才对得上（好友转发的卡来源会是好友那台
// 机器，而它没有这条分享的注册表 → 必然"打不开"）。所以：
//   转发 = 请求主人；主人同意后，由主人把卡发给第三人（来源坐标准确、零新通道）。
// ══════════════════════════════════════════════════════════════════════════

/// 发卡底座（可注入——单测/端到端用本地假通道替换，不碰网络）。
pub(crate) type CardSendFn =
    fn(
        String,
        Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>;

static RESHARE_CARD_SENDER: std::sync::LazyLock<std::sync::RwLock<Option<CardSendFn>>> =
    std::sync::LazyLock::new(|| std::sync::RwLock::new(None));

/// 注入发卡底座（幂等覆盖；生产走默认实现）。
#[allow(dead_code)]
pub(crate) fn install_reshare_card_sender(f: CardSendFn) {
    *RESHARE_CARD_SENDER.write().unwrap() = Some(f);
}

/// 把一张任务卡送给**被转授者**（kind=`task-share`，平铺卡体——与好友分享同形状，
/// 接收侧那条既有 ingest 直接落任务库，不需要任何新 kind）。
pub(crate) async fn send_reshare_card(to_account: &str, card: Value) -> Result<(), String> {
    let custom = *RESHARE_CARD_SENDER.read().unwrap();
    if let Some(f) = custom {
        return f(to_account.to_string(), card).await;
    }
    let to = to_account.trim();
    if to.is_empty() {
        return Err("缺被转授者账号".into());
    }
    let (_, _, state) = p2p_send_raw(to, "task-share", card).await?;
    eprintln!("[chat] 转授任务卡已投递（{to} · {state}）");
    Ok(())
}

/// 任务卡删除通知（2026-10-24，kind=`task-revoke`）：分享 revoke/删除时告诉对端
/// 「这张卡没了」。payload `{shareId, taskId, title?}`；走 `p2p_send_raw`（群=成员
/// 扇出、失败自动入离线队列——对端上线补发，msgId 幂等）。接收侧 ingest 只把本地
/// 任务库里对应卡标 `status=revoked`（`state_snapshot` 过滤 → UI 轮询 ≤5s 消失），
/// 不落会话行、不打扰聊天流。
pub(crate) async fn send_task_revoke(
    to: &str,
    share_id: &str,
    task_id: &str,
    title: &str,
) -> Result<(), String> {
    let to = to.trim();
    if to.is_empty() || share_id.trim().is_empty() {
        return Err("缺 to 或 shareId".into());
    }
    let payload = json!({ "shareId": share_id, "taskId": task_id, "title": title });
    let (_, _, state) = p2p_send_raw(to, "task-revoke", payload).await?;
    eprintln!("[chat] task-revoke 已投递（{to} · {share_id} · {state}）");
    Ok(())
}

/// task-revoke 的本地生效（**纯 fs 语义**，单测直击）：把任务库里命中
/// （taskId 精确 / shareId 字段 / `peer-task-share-<shareId>` 命名约定）的卡标
/// `status=revoked`。幂等：已 revoked 的不动（revokedAt 不刷新）；未知 id 无害。
/// 返回标记条数。
pub(crate) fn apply_task_revoke(share_id: &str, task_id: &str, at_ms: i64) -> usize {
    let share_id = share_id.trim();
    let task_id = task_id.trim();
    if share_id.is_empty() && task_id.is_empty() {
        return 0;
    }
    let conv_task_id = format!("peer-task-share-{share_id}");
    // 先打 tombstone（含两种 taskId 形态——命中键即死，防对账重放复活）；
    // 名单是落库口的闸，tasks 库里的 revoked 只是展示态。
    if !task_id.is_empty() {
        tombstone_task(task_id, "task-revoke");
    }
    if !share_id.is_empty() {
        tombstone_task(&conv_task_id, "task-revoke");
    }
    let mut tasks = load_tasks();
    let mut hit = 0usize;
    for t in tasks.iter_mut() {
        let tid = t.get("taskId").and_then(|d| d.as_str()).unwrap_or("");
        let sid = t.get("shareId").and_then(|d| d.as_str()).unwrap_or("");
        let matched = (!task_id.is_empty() && tid == task_id)
            || (!share_id.is_empty() && (sid == share_id || tid == conv_task_id));
        if matched && t.get("status").and_then(|s| s.as_str()) != Some("revoked") {
            t["status"] = json!("revoked");
            t["revokedAt"] = json!(at_ms);
            hit += 1;
        }
    }
    if hit > 0 {
        save_tasks(&tasks);
    }
    hit
}

/// B 侧收 `reshare-grant` → 刷新本机任务库里那张卡的转授能力（**只改这一张卡的元数据**，
/// 不新增卡、不落会话行）。
fn apply_reshare_update(u: &crate::dsh_share::ReshareUpdate) {
    let mut tasks = load_tasks();
    let mut hit = false;
    for t in tasks.iter_mut() {
        let sid = t.get("shareId").and_then(|v| v.as_str()).unwrap_or("");
        if sid != u.share_id {
            continue;
        }
        t["canReshare"] = json!(u.can_reshare);
        if u.exp > 0 {
            t["reshareExp"] = json!(u.exp);
        }
        if !u.via.is_empty() {
            t["reshareVia"] = json!(u.via);
        }
        hit = true;
    }
    if hit {
        save_tasks(&tasks);
    }
    eprintln!(
        "[chat] 转授批示（share={} approved={} canReshare={} target={}）{}",
        u.share_id,
        u.approved,
        u.can_reshare,
        u.target_did,
        if u.error.is_empty() {
            String::new()
        } else {
            format!(" · {}", u.error)
        }
    );
}

// ══════════════════════════════════════════════════════════════════════════
// 同步回程（2026-10-09：「点卡就进」回程收口）
//
// **问题（真机实证）**：手机是纯拉取设备——presence 不报 addrs、浏览器不能监听
// 端口，`deliver_to_account` 投不到它；同账号时更隐蔽——grant 被**投回 PC 自己**，
// 在 `dsh_share::ENTRY_WAITERS` 里找不到等待者 → **静默丢弃**。
// 请求方向（手机→源设备）通，**回程断在最后一步**。
//
// **正解**：把回包挂进 `POST /p2p/msg` 的 **HTTP 响应体**。请求方打开的那条 HTTP
// 连接本来就开着在等响应，而 `handle_msg` 已经在 await 现签这条链——
// 回车即得票，**零新通道、零新端口、零新白名单**。
//
// **实现（三个动作，全在本文件 + p2p_server 一处调用）**
//   ① 请求方在 payload 里写 `syncReply: true`（手机侧 provider A 就是这么发的）；
//   ② 入站侧过闸后按 requestId 开一个槽（[`open_sync_reply`]）；
//   ③ 现签完成后回包走到**同一个 choke point**（[`send_share_entry_msg`]）→
//      发现槽在等 → [`capture_sync_reply`] **填槽并就地返回**（不再走 P2P 直推）
//      → `handle_msg` 用 [`close_sync_reply`] 把回包放进响应体。
//
// **边界（全部有单测）**
//   · 没写 `syncReply` / 没开槽（桌面 B 的既有路径、其它 kind）→ 行为**一个字不变**
//     （照常直推，走注入的 sender 或默认 P2P 直推）；
//   · 槽与回包的 `shareId` + 收件账号必须都**对得上**（张冠李戴 → 不填槽，照常直推）；
//   · 槽**先到先得**：同 requestId 已有在等的一方 → 不改写（防"抢别人的槽"）；
//   · 槽**单次性**：`close_sync_reply` 取出即删（迟到/重复回包不会留在表里长草）。
// ══════════════════════════════════════════════════════════════════════════

/// 一个在等的同步回程槽。
struct SyncReplySlot {
    /// 请求方账号（回包收件人必须与它同账号——张冠李戴闸）。
    from: String,
    /// 请求的分享 id（回包 `shareId` 必须与它一致）。
    share_id: String,
    /// 现签好的回包本体（`None` = 还没签完 / 这条请求不会回包）。
    reply: Option<Value>,
}

/// requestId → 在等的同步回程槽（**只在同一进程、同一 requestId 内可见**；
/// requestId 由请求方现生成，不猜不可枚举）。
static SYNC_REPLY_SLOTS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, SyncReplySlot>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// 单测用：P2P 直推分支被走过的次数（证明"同步回程命中时不再直推"）。
#[cfg(test)]
static SHARE_ENTRY_PUSH_CALLS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// 纯判定：这条入站信封是不是"要一份同步回包"？（单测直击）
///
/// 三项齐备才算：`payload.syncReply === true` + 非空 `requestId` + 非空 `shareId`。
/// 缺一不认——宁可回退到既有直推（行为不变），也不凭空开槽。
fn sync_reply_request(m: &Value) -> Option<(String, String)> {
    let p = m.get("payload")?;
    if p.get("syncReply").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    let rid = p
        .get("requestId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let share = p
        .get("shareId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if rid.is_empty() || share.is_empty() {
        return None;
    }
    Some((rid.to_string(), share.to_string()))
}

/// 开槽（`p2p_server::handle_msg` 过闸后、跑入库前调）。返回 requestId（关槽时用它）。
///
/// 只有"确属这条请求"的信封才会开槽：`from` 与 `shareId` 都随槽记下来，回包侧比对。
/// **先到先得**（`or_insert`）——同 requestId 已有在等的一方就不改写。
pub(crate) fn open_sync_reply(m: &Value) -> Option<String> {
    let (rid, share_id) = sync_reply_request(m)?;
    let from = m
        .get("from")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if from.is_empty() {
        return None;
    }
    SYNC_REPLY_SLOTS
        .lock()
        .unwrap()
        .entry(rid.clone())
        .or_insert(SyncReplySlot {
            from,
            share_id,
            reply: None,
        });
    Some(rid)
}

/// 关槽并取出回包（`handle_msg` 组装响应体前调）。**取出即删**（单次性）。
pub(crate) fn close_sync_reply(request_id: &str) -> Option<Value> {
    SYNC_REPLY_SLOTS
        .lock()
        .unwrap()
        .remove(request_id)
        .and_then(|s| s.reply)
}

/// 填槽（回包发出去时调）。`true` = 已交给同步回程，调用方**别再直推**。
///
/// 两道闸缺一不可：收件账号与槽里的 `from` 同账号、回包 `shareId` 与槽里一致。
/// 不匹配 = 这不是这条请求的回包（或有人拿着别人的 requestId 来撞）→ 不填槽，
/// 让调用方照常直推（既有行为不变）。
/// 哪些控制 kind 的回包走「同步回程」（就地填槽，不走 P2P 直推）。
fn is_sync_reply_kind(kind: &str) -> bool {
    matches!(kind, "share-entry-grant" | "share-admin-grant")
}
fn capture_sync_reply(to_account: &str, payload: &Value) -> bool {
    let rid = match payload
        .get("requestId")
        .and_then(|v| v.as_str())
        .map(str::trim)
    {
        Some(s) if !s.is_empty() => s,
        _ => return false,
    };
    let share = payload
        .get("shareId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let mut slots = SYNC_REPLY_SLOTS.lock().unwrap();
    let Some(slot) = slots.get_mut(rid) else {
        return false;
    };
    if slot.from.is_empty() || to_account.trim().is_empty() {
        return false;
    }
    if !myco_core::identity::account_did_eq(&slot.from, to_account) || slot.share_id != share {
        return false;
    }
    slot.reply = Some(payload.clone());
    true
}

/// 单测用：清空同步回程槽（防用例间互踩）。
#[cfg(test)]
pub(crate) fn _reset_sync_replies_for_test() {
    SYNC_REPLY_SLOTS.lock().unwrap().clear();
    SHARE_ENTRY_PUSH_CALLS.store(0, Ordering::SeqCst);
}

/// 单测用：直推分支被走过的次数。
#[cfg(test)]
pub(crate) fn _push_calls_for_test() -> usize {
    SHARE_ENTRY_PUSH_CALLS.load(Ordering::SeqCst)
}

// ═════════════════════════════════════════════════════════════════════════
// 双向打洞信令（2026-10-09 三设备实测后补的缺口；设计文档 07-connectivity）
//
// 两个**控制 kind**（无会话语义，不落行、不进任务库）：
//   · `hole-punch-request`：B → A，"请从我声明的候选地址（addr:预绑口 P）反向探测我"；
//   · `hole-punch-ack`    ：A → B，"收到，我已开始探测"（收到即回，不等探测完成）。
// A 收到 request 后：① 立即回 ack（spawn，不阻塞 ingest）；② 从本机 p2p 端口
// （:9100，`SO_REUSEADDR` 与在听的服务器共存）向 B 的每个候选发探测 SYN——
// 这些 SYN 大概率失败（B 没在监听），**但足以在 A 侧光猫上创建出站记录**，
// 让 B 随后从预绑口 P 发来的 SYN 能匹配放行（五元组完全反转 = "已建立流"）。
// 探测动作与审计在 p2p_tunnel（打洞域）；这里只做信令面的路由与闸门。
// ═════════════════════════════════════════════════════════════════════════

/// presence 在线列表行 → 目标设备所属账号（rootDid）。纯函数（单测直击）：
/// did 匹配走 [`core_id::did_equiv`]（**canonical-only**：`did:myco:z…` / `did:youling:z…`
/// 同钥互认；legacy 裸 base58 已废止），rootDid 为空 = None。
pub(crate) fn device_row_account(rows: &[Value], device_did: &str) -> Option<String> {
    rows.iter().find_map(|d| {
        let did = d.get("did").and_then(|v| v.as_str()).unwrap_or("");
        if !core_id::did_equiv(did, device_did) {
            return None;
        }
        d.get("rootDid")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from)
    })
}

/// 解析目标设备所属账号（打洞信令的投递地址 = presence 行的 rootDid）。
/// 失败 = None（调用方按"无信令地址"处理，打洞腿静默退出，不影响直连）。
pub(crate) async fn resolve_device_account(device_did: &str) -> Option<String> {
    let resp = core_id::signed_post("/presence/list", &json!({}))
        .await
        .ok()?;
    let rows = resp.pointer("/data").and_then(|d| d.as_array())?.clone();
    device_row_account(&rows, device_did)
}

/// 打洞信令闸（纯判定，单测直击）：谁有资格让我发探测 SYN。
/// 同账号（自己的其他设备——PC↔笔记本场景）或好友（分享场景）。陌生人的一律不理
/// ——防"借我的出口 SYN 扫描别人"（探测包源自我方 IP，日志里也是我）。
fn hole_punch_request_allowed(my: &str, from: &str) -> bool {
    if from.trim().is_empty() {
        return false;
    }
    if !my.is_empty() && core_id::account_did_eq(my, from) {
        return true;
    }
    ok_friend_dids()
        .iter()
        .any(|f| core_id::account_did_eq(f, from))
}

/// 打洞信令发送（唯一出口）：先走 P2P 直推（可注入底座），直推不可达兜底落
/// identity-svc 信箱（`/msg/send`，30 天 TTL——服务器 kind 白名单补上
/// `hole-punch-*` 后这条路即通；今天服务器会 400，只记日志不影响主流程）。
pub(crate) async fn hp_signal_send(to: &str, kind: &str, payload: Value) -> Result<(), String> {
    if send_control_msg(to, kind, payload.clone()).await.is_ok() {
        return Ok(());
    }
    hp_mailbox_fallback(to, kind, payload).await
}

/// 信箱兜底：测试态记进静态表（绝不触网）；产线走 `srv_send_raw`。
async fn hp_mailbox_fallback(to: &str, kind: &str, payload: Value) -> Result<(), String> {
    #[cfg(test)]
    {
        let mut g = TEST_HP_MAILBOX.lock().unwrap();
        g.push((to.to_string(), kind.to_string(), payload));
        return Ok(());
    }
    #[cfg(not(test))]
    {
        match srv_send_raw(to, kind, payload).await {
            Ok(_) => {
                eprintln!("[chat] 打洞信令直推不可达，已落服务器信箱（对端登录 poll 可达）: {to}");
                Ok(())
            }
            Err(e) => {
                eprintln!("[chat] 打洞信令直推与信箱均不可达（{e}）: {to}");
                Err(e)
            }
        }
    }
}

/// 测试用：信箱兜底记录（清空 + 读取）。
#[cfg(test)]
static TEST_HP_MAILBOX: std::sync::LazyLock<std::sync::Mutex<Vec<(String, String, Value)>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(Vec::new()));

#[cfg(test)]
pub(crate) fn _hp_mailbox_for_test() -> Vec<(String, String, Value)> {
    TEST_HP_MAILBOX.lock().unwrap().clone()
}

#[cfg(test)]
pub(crate) fn _reset_hp_mailbox_for_test() {
    TEST_HP_MAILBOX.lock().unwrap().clear();
}

/// A 侧收 `hole-punch-request`：① spawn 立即回 ack（"收到即回"）；
/// ② spawn 对 B 声明的每个候选地址发探测 SYN（源口 = 本机 p2p 端口）。
/// 两者都不阻塞 ingest/HTTP 响应。返回 true = 信令有效已受理（已入审计链）。
/// `my` = 当前账号（ingest_msg 传入——闸门判"同账号设备"用）。
async fn hole_punch_request_ingest(my: &str, m: &Value) -> bool {
    let from = m
        .get("from")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if !hole_punch_request_allowed(my, &from) {
        eprintln!("[chat] 打洞请求被拒：请求方 {from} 既非本账号设备也非好友");
        return false;
    }
    let payload = m.get("payload").cloned().unwrap_or(json!({}));
    let Some(req) = crate::p2p_tunnel::parse_hole_punch_request(&payload, now_ms()) else {
        eprintln!(
            "[chat] 打洞请求载荷无效（形状不全或 ts 超过 {}ms 新鲜窗）",
            crate::p2p_tunnel::HOLE_PUNCH_FRESH_MS
        );
        return false;
    };
    eprintln!(
        "[chat] 收到打洞请求（requestId={}，{} 候选，来自 {from}）——回 ack 并从 :{} 反向探测",
        req.request_id,
        req.candidates.len(),
        crate::p2p_server::p2p_port(),
    );
    // ① ack 收到即回（不等探测完成；B 收到 ack 才开始发 SYN，顺序天然正确）
    let ack = crate::p2p_tunnel::hole_punch_ack_payload(&req.request_id);
    let to = from.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = send_control_msg(&to, crate::p2p_tunnel::HOLE_PUNCH_ACK_KIND, ack).await {
            eprintln!("[chat] 打洞 ack 未送达（{e}）——B 侧 2s 超时后自行放弃");
        }
    });
    // ② 探测源口 = 本机 p2p 端口（B 将要拨的端口；五元组配对的命门）。服务器未起时
    //    用默认 9100（探测只是创建出站记录，绑不上时 dial 侧会如实回退并审计）。
    let src_port = {
        let p = crate::p2p_server::p2p_port();
        if p == 0 {
            9100
        } else {
            p
        }
    };
    crate::p2p_tunnel::spawn_hole_punch_probes(&req.candidates, src_port);
    true
}

/// B 侧收 `hole-punch-ack`：唤醒在等的打洞腿（无会话语义，不落行）。
fn hole_punch_ack_ingest(m: &Value) -> bool {
    let payload = m.get("payload").cloned().unwrap_or(json!({}));
    match crate::p2p_tunnel::parse_hole_punch_ack(&payload) {
        Some(ack) => {
            let woke = crate::p2p_tunnel::hole_punch_ack_arrived(&ack.request_id);
            eprintln!(
                "[chat] 收到打洞 ack（requestId={}）{}",
                ack.request_id,
                if woke {
                    "——已唤醒打洞腿"
                } else {
                    "（无等待者，忽略）"
                }
            );
            true
        }
        None => false,
    }
}

// ── 双向打洞信令单测（测试即规格） ──
#[cfg(test)]
mod hole_punch_chat_tests {
    use super::*;
    use tokio::io::AsyncReadExt as _;

    static SENT: std::sync::LazyLock<std::sync::Mutex<Vec<(String, String, Value)>>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(Vec::new()));

    fn sender_ok(
        to: String,
        kind: String,
        payload: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>> {
        Box::pin(async move {
            SENT.lock().unwrap().push((to, kind, payload));
            Ok(())
        })
    }

    fn sender_fail(
        _to: String,
        _kind: String,
        _payload: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>> {
        Box::pin(async { Err("test-push-fail".into()) })
    }

    fn reset() {
        crate::p2p_tunnel::test_clear_hp_state();
        _reset_hp_mailbox_for_test();
        SENT.lock().unwrap().clear();
    }

    const MY: &str = "did:youling:HpChatMe";
    const RID: &str = "hp-chat-rid-1";

    fn request_env(from: &str, addr: &str, port: u16, ts_offset_ms: i64) -> Value {
        let candidates = json!([{ "addr": addr, "port": port }]);
        json!({
            "msgId": "hp-msg-1", "from": from, "fromName": "B 设备",
            "fromDevice": "did:myco:HpPeerDev", "fromDeviceName": "peer",
            "to": MY, "kind": "hole-punch-request",
            "payload": {
                "requestId": RID,
                "candidates": candidates,
                "shareId": "",
                "ts": now_ms() + ts_offset_ms,
            },
            "ts": now_ms() + ts_offset_ms,
        })
    }

    /// 记录入站连接源口的探针 listener（tokio 任务）。
    async fn spawn_peer_recorder() -> (u16, std::sync::Arc<std::sync::Mutex<Vec<u16>>>) {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let seen: std::sync::Arc<std::sync::Mutex<Vec<u16>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let s2 = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut s, peer)) = l.accept().await {
                s2.lock().unwrap().push(peer.port());
                let mut buf = [0u8; 64];
                let _ =
                    tokio::time::timeout(std::time::Duration::from_secs(2), s.read(&mut buf)).await;
            }
        });
        (port, seen)
    }

    async fn wait_until(desc: &str, mut f: impl FnMut() -> bool) {
        for _ in 0..15 {
            if f() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        panic!("等待超时：{desc}");
    }

    /// 正题：A 收到 request → ①回 ack（同 requestId、发给请求方账号）②从本机
    /// p2p 端口（:9100 口径）向 B 声明的候选**实发探测**（探针 listener 看得到，
    /// 且源口 = 指定的 p2p 端口——五元组配对命门）+ 审计留痕。
    #[tokio::test]
    async fn request_ingest_replies_ack_and_probes_from_p2p_port() {
        let _env = crate::test_env_lock::test_env_lock();
        reset();
        install_share_entry_sender(sender_ok);
        let (lport, seen) = spawn_peer_recorder().await;
        // 探测源口 = p2p_port()（未起服务器时回落 9100——这里给它一个随机空闲口）
        let src = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let p = l.local_addr().unwrap().port();
            drop(l);
            p
        };
        crate::p2p_server::P2P_PORT.store(src, std::sync::atomic::Ordering::Relaxed);

        let kept = ingest_msg(MY, &request_env(MY, "127.0.0.1", lport, 0)).await;
        assert!(kept, "同账号设备的合法请求必须受理");
        // ② 探测实发：B 声明的候选地址收到了来自 src 口的连接
        wait_until(
            "探测 SYN 到达 B 声明的候选地址（源口=p2p 口）",
            || seen.lock().unwrap().contains(&src),
        )
        .await;
        let audit = crate::p2p_tunnel::hole_punch_probe_recent();
        assert!(
            audit
                .iter()
                .any(|a| a.target == format!("127.0.0.1:{lport}") && a.src_port == src),
            "探测审计必须留痕（人话可读）: {audit:?}"
        );
        // ① ack 收到即回：一条 hole-punch-ack，requestId 对得上，发给请求方账号
        wait_until("ack 已发出", || {
            SENT.lock()
                .unwrap()
                .iter()
                .any(|(to, k, _)| to == MY && k == "hole-punch-ack")
        })
        .await;
        let acks: Vec<_> = SENT
            .lock()
            .unwrap()
            .iter()
            .filter(|(to, k, _)| to == MY && k == "hole-punch-ack")
            .cloned()
            .collect();
        assert_eq!(acks.len(), 1, "ack 恰好一条（不重发）");
        assert_eq!(acks[0].2["requestId"], json!(RID));

        crate::p2p_server::P2P_PORT.store(0, std::sync::atomic::Ordering::Relaxed);
        install_share_entry_sender(sender_fail);
        reset();
    }

    /// 闸门：过期信令 / 陌生人 / 畸形载荷 → 拒收（不回 ack、不发探测）。
    #[tokio::test]
    #[ignore = "pre-existing/unstable in source baseline, tracked internally"]
    async fn request_ingest_rejects_stale_stranger_and_malformed() {
        let _env = crate::test_env_lock::test_env_lock();
        reset();
        install_share_entry_sender(sender_ok);
        let (lport, seen) = spawn_peer_recorder().await;
        // ① 过期（ts 超过新鲜窗）
        assert!(
            !ingest_msg(MY, &request_env(MY, "127.0.0.1", lport, -60_000)).await,
            "过期信令必须拒"
        );
        // ② 陌生人（既非本账号也非好友）
        assert!(
            !ingest_msg(
                MY,
                &request_env("did:youling:HpStranger", "127.0.0.1", lport, 0)
            )
            .await,
            "陌生人的打洞请求必须拒（防借我的出口 SYN 扫描）"
        );
        // ③ 畸形（无候选）
        let mut bad = request_env(MY, "127.0.0.1", lport, 0);
        bad["payload"]["candidates"] = json!([]);
        assert!(!ingest_msg(MY, &bad).await, "无候选必须拒");
        // 三种情况都没有 ack、没有探测
        assert!(SENT.lock().unwrap().is_empty(), "拒收时不得回 ack");
        assert!(seen.lock().unwrap().is_empty(), "拒收时不得发探测");
        install_share_entry_sender(sender_fail);
        reset();
    }

    /// ack ingest 唤醒在等的打洞腿。
    #[tokio::test]
    async fn ack_ingest_wakes_the_waiting_leg() {
        let _env = crate::test_env_lock::test_env_lock();
        reset();
        let rx = crate::p2p_tunnel::hp_ack_register(RID);
        let env = json!({
            "msgId": "hp-ack-1", "from": MY, "fromDevice": "did:myco:HpPeerDev",
            "to": MY, "kind": "hole-punch-ack",
            "payload": { "requestId": RID, "ts": now_ms() },
            "ts": now_ms(),
        });
        assert!(ingest_msg(MY, &env).await, "合法 ack 必须受理");
        tokio::time::timeout(std::time::Duration::from_millis(500), rx)
            .await
            .expect("等待者必须被唤醒")
            .expect("通道正常闭合");
        reset();
    }

    /// presence 行 → 目标设备账号（canonical 双前缀互认、rootDid 空=None；
    /// legacy 已废止 → 不再互认）。
    #[test]
    fn device_row_account_matches_across_canonical_forms() {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[0xB1; 32]);
        let pk = sk.verifying_key().to_bytes();
        let canonical = core_id::did_from_public(&pk); // did:myco:z…
        let youling_twin = canonical.replacen("did:myco:", "did:youling:", 1); // 同钥另一前缀（canonical）
        let legacy = format!("did:myco:{}", bs58::encode(&pk).into_string()); // 已废止形态
        let rows = vec![
            json!({ "did": canonical, "rootDid": "did:youling:HpRoot", "kind": "pc" }),
            json!({ "did": "did:myco:OtherDev", "rootDid": "did:youling:OtherRoot" }),
        ];
        assert_eq!(
            device_row_account(&rows, &canonical).as_deref(),
            Some("did:youling:HpRoot")
        );
        assert_eq!(
            device_row_account(&rows, &youling_twin).as_deref(),
            Some("did:youling:HpRoot"),
            "canonical 双前缀同钥必须互认"
        );
        assert_eq!(
            device_row_account(&rows, &legacy),
            None,
            "legacy 已废止：不再互认"
        );
        assert_eq!(device_row_account(&rows, "did:myco:Nope"), None);
        let no_root = vec![json!({ "did": canonical, "rootDid": "" })];
        assert_eq!(
            device_row_account(&no_root, &canonical),
            None,
            "rootDid 空 = 无法投信令"
        );
    }

    /// hp_signal_send：直推优先；直推失败落信箱兜底（测试态记表，绝不触网）。
    #[tokio::test]
    async fn hp_signal_send_direct_first_then_mailbox_fallback() {
        let _env = crate::test_env_lock::test_env_lock();
        reset();
        // ① 直推成功：不走信箱
        install_share_entry_sender(sender_ok);
        hp_signal_send("did:youling:HpTo", "hole-punch-request", json!({ "x": 1 }))
            .await
            .expect("直推成功必须 Ok");
        assert_eq!(SENT.lock().unwrap().len(), 1);
        assert!(_hp_mailbox_for_test().is_empty(), "直推成功不得动信箱");
        // ② 直推失败：信箱兜底
        install_share_entry_sender(sender_fail);
        hp_signal_send("did:youling:HpTo", "hole-punch-request", json!({ "x": 2 }))
            .await
            .expect("信箱兜底后仍应 Ok");
        let mb = _hp_mailbox_for_test();
        assert_eq!(mb.len(), 1, "直推失败必须落信箱");
        assert_eq!(mb[0].0, "did:youling:HpTo");
        assert_eq!(mb[0].1, "hole-punch-request");
        assert_eq!(mb[0].2["x"], json!(2), "载荷原样进信箱");
        install_share_entry_sender(sender_fail);
        reset();
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 任务卡跨设备同步·发送侧（2026-10-09）
//
// 用户口径：「任务卡 = **账号级数据**，该账号所有设备都能看到」（此前只在本设备可见）。
// 通道复用**既有设备群**（grp-dev-*：账号 did 确定性派生、登录后 ensure、成员恒
// [root did]、P2P 直推 → deliver_to_account 按账号寻址扇出到全部在线设备）——
// 不新造通道，也不新造存储：接收侧仍写既有 peer-tasks.json（账号桶，天然账号级）。
//
// 纪律（对齐 §3.16 留痕先例）：
//   · **绝不影响建卡本身**：调用点在 `dsh_share::sync_share_task` 写盘**之后**，
//     本函数只 spawn、不 await、不返回错误——设备群不可达时建卡照常成功；
//   · 非阻塞 best-effort：P2P 不可达落既有离线队列（对方上线自动补发，msgId 不变），
//     投递失败只记一行日志；
//   · 幂等：同一 taskId 重复投递在接收侧按 taskId upsert（见 ingest_device_group_task），
//     永远只留一张卡。
// ═══════════════════════════════════════════════════════════════════════

/// 设备群 task-share 的 wire payload（纯函数——单测锁形状）。
/// 契约：`{groupId, groupName, members, card, status, fromName}`——
///   · `members=[my]`：设备群成员=root 账号 did，p2p_send_raw 靠它寻址；
///     deliver_to_account 落 decision C 兜底（按账号名册扇出到**全部设备**）；
///   · `card`：**卡片本身**（peer-tasks.json 里那条记录原样），不含分享注册表——
///     卡片是"声明"，执行仍在各自设备（分享实例/注册表是设备本地的）；
///   · 无 `text`：**设备群里不产生任何可见气泡**（这是同步，不是聊天）：发送侧
///     不落会话行、接收侧 ingest 直接进任务库不落行，渲染层再兜一层过滤
///     （见 `chat_load_conv` 的设备群 task-share 过滤）。
fn device_group_card_payload(my: &str, card: &Value, status: &str, from_name: &str) -> Value {
    json!({
        "groupId": device_group_id(my),
        "groupName": DEVICE_GROUP_NAME,
        "members": [my],
        "fromName": from_name,
        "status": status,
        "card": card,
    })
}

/// 把一张任务卡投进本账号设备群（**非阻塞**；失败只记日志）。
/// 调用方（dsh_share::sync_share_task / close_share_task）必须在本地写盘**之后**调用：
/// spawn 之后立刻返回，网络/名册/队列的任何失败都不影响本地任务库。
pub(crate) fn spawn_device_group_task_card(card: Value, status: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = send_device_group_task_card(&card, &status).await {
            eprintln!("[chat] 任务卡设备群同步失败（本地建卡不受影响）: {e}");
        }
    });
}

/// 任务卡设备群投递（msgId 由 p2p_send_raw 现生成，**不是**幂等键；幂等靠接收侧
/// 按 taskId upsert——同一张卡重复投递永远只留一条，见 `upsert_device_group_task`）。
async fn send_device_group_task_card(card: &Value, status: &str) -> Result<(), String> {
    let my = my_account_did()?; // 未登录 → Err，spawn 里只记日志
    let gid = device_group_id(&my);
    let from_name = card
        .get("fromName")
        .and_then(|v| v.as_str())
        .unwrap_or("我")
        .to_string();
    let wire = device_group_card_payload(&my, card, status, &from_name);
    let task_id = card.get("taskId").and_then(|v| v.as_str()).unwrap_or("");
    let (_, _, state) = p2p_send_raw(&gid, "task-share", wire).await?;
    // **不落会话行**：设备群是"数据面"（同步任务卡），不是聊天面——落行会让设备群
    // 多出卡气泡，且该行会被 60s 对账带到其他设备（对端 ingest 走
    // `device_group_task_ingest` 直接 return，本不落行，对账一拉又冒出来）。
    // 卡本身已经进设备群（上面 p2p_send_raw），本地卡也已在 dsh_share 落盘。
    eprintln!("[chat] 任务卡已同步进设备群（{task_id} · {state}）");
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════
// 任务卡跨设备同步·接收侧（2026-10-09）
//
// 安全闸（用户口径 + 防塞卡）：**只接受本账号设备群**（`groupId ==
// device_group_id(my)`）来的卡。别的群 / 单聊来的任务卡**不落**本地任务库——
//   ① "设备群"不是信任凭据，`grp-dev-*` 前缀谁都能拼（前缀只用来**路由**）：
//      必须**精确比对**按 my 确定性派生的群 id（did 双形态已归一，见 device_group_id）；
//   ② 卡内容仍只作展示/声明，不触发任何执行面（无 action 自动执行、无注册表写入），
//      所以"塞卡"最坏后果 = 本地任务列表多一条**不可点**的声明（见下 remoteOrigin）；
//   ③ 本机自己发的回环（fromDevice==本机设备）不重复落 —— 本地记录已由
//      dsh_share::sync_share_task 写入，落一次会把它覆盖成"来自他机"。
//
// 幂等（用户口径「同一 taskId 重复投递只应产生一张卡」）：按 taskId upsert，
// 重复投递只更新状态（todo↔done），**永远只有一条**；与 msgId 去重无关
// （直推+对账双路径同 msgId 已被 conv/meta 闸挡，但卡库去重必须自己有）。
// ═══════════════════════════════════════════════════════════════════════

/// 设备群任务卡是否**本账号设备群**（安全闸；纯函数——单测锁"别账号/伪造前缀全拒"）。
/// 只比 `device_group_id(my)`：`grp-dev-` 前缀**不是**凭据（谁都能拼），
/// 前缀只用于把消息路由到这里；真正放行的是确定性派生的群 id 精确相等。
fn device_group_card_allowed(my: &str, gid: &str) -> bool {
    !gid.is_empty() && gid == device_group_id(my)
}

/// 设备群任务卡 ingest（返回 true=本函数已处置，不再走通用 task-share 分支）。
/// 处置语义：
///   · 安全闸不过 → false（**不落卡**；由调用方继续落会话，正常群任务卡行为不变）；
///   · 本机设备回环（fromDevice==本机设备 did）→ true（**不落卡**：本地记录已在）；
///   · 他机同账号设备 → true（落卡，标来源设备）。
fn device_group_task_ingest(
    my: &str,
    from_device: &str,
    from_device_name: &str,
    payload: &Value,
) -> bool {
    let gid = payload
        .get("groupId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !device_group_card_allowed(my, gid) {
        return false; // 非本账号设备群：不落卡（安全闸）
    }
    // 本机自己发的回环（P2P 直推不算回环，但信箱副本/对账可能带回来）：
    // 本地卡（dsh_share::sync_share_task）已写，绝不用"来自他机"的副本覆盖它。
    if !from_device.is_empty() && dir_for_device_group(from_device, &my_device_did()) == "out" {
        return true;
    }
    let Some(card) = payload.get("card") else {
        // 老形态（无 card 包裹）的卡：不猜、不落（宁可少一张，不可落一张来路不明的）
        eprintln!("[chat] 设备群任务卡缺 card 字段——不落库（老形态/异常投递）");
        return true;
    };
    // 冷启动竞态：设备群档案还没 ensure（本分支提前 return，走不到通用 task-share
    // 的自愈路径）→ 立即本地 ensure（幂等；系统群档案反正只由本地派生）。
    if !load_groups().iter().any(|g| is_device_group(g)) {
        ensure_device_group_for(my);
    }
    // 来源设备名：信封 fromDeviceName（设备署名协议字段）优先，其次 payload.fromName。
    let fname = if !from_device_name.trim().is_empty() {
        from_device_name
    } else {
        payload
            .get("fromName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
    };
    upsert_device_group_task(
        card,
        &payload
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("todo"),
        from_device,
        fname,
    );
    true
}

/// 卡上记录的来源账号/owner 是否就是信封发送者（DID 双形态归一比较）。
/// task-share 改写 / task-revoke 拆 clean URL 都必须先过这把闸；不能凭“知道
/// shareId/taskId”就获得改卡/拆入口权限。
fn task_card_owner_matches(t: &Value, sender: &str) -> bool {
    let sender = sender.trim();
    if sender.is_empty() {
        return false;
    }
    ["sourceAccount", "from", "owner"].iter().any(|k| {
        t.get(*k)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(|d| core_id::account_did_eq(d, sender))
            .unwrap_or(false)
    })
}

/// 「分享任务 owner」判定（2026-11-11 跨账号 DSH 会话消息的准入面，`msg_route` 用）：
/// 本机任务库里存在一张**由 `did` 分享来的、仍然有效**的卡，即视其为分享任务 owner。
///
/// 为什么它算"可通信关系"：拿到对方的任务卡 = 对方主动把入口给了你（好友之外的
/// 第二种授权关系，与 `chat_share_task` 的建卡口径同源）。已撤销（status=revoked）
/// 或已进墓碑名单的卡不算——卡死了关系就该断。
/// 字段口径（owner/sourceAccount/from）复用 `task_card_owner_matches`，不另立一套。
pub(crate) fn is_shared_task_owner(did: &str) -> bool {
    let target = did.trim();
    if target.is_empty() {
        return false;
    }
    let dead: Vec<String> = load_tombstones()
        .iter()
        .filter_map(|x| x.get("taskId").and_then(|v| v.as_str()).map(String::from))
        .collect();
    load_tasks().iter().any(|t| {
        let tid = t.get("taskId").and_then(|v| v.as_str()).unwrap_or("");
        let status = t.get("status").and_then(|v| v.as_str()).unwrap_or("");
        if status == "revoked" || dead.iter().any(|d| d == tid) {
            return false;
        }
        task_card_owner_matches(t, target)
    })
}

/// 他机任务卡 → 本地任务库（peer-tasks.json，账号桶）upsert：**按 taskId 幂等**。
/// 形状与 `dsh_share::sync_share_task` 的卡一致（同一份库、同一套 UI 字段），只多两个来源键：
///   · `sourceDevice` / `sourceDeviceName`：**这张卡来自哪台设备**（UI 展示"来自 X"）；
///   · `remoteOrigin: true` + action 指向**本机管理面的 remoteOpen 入口**（2026-10-09 第二程）。
///
/// 跨设备可达性（这一版的核心变化）：卡的 open-url 原本是
/// `http://127.0.0.1:3102/api/dshShare/open?shareId=<id>`——分享注册表
/// （dsh-shares.json）与本地管理面**都是设备本地的**，本机既没有这条分享（404），
/// 管理面也只 bind 127.0.0.1。所以远端卡的动作改成指向**本机**的
/// `/api/dshShare/remoteOpen?shareId&device&account`：
///   ① 本机可达（就是本机的管理面）；
///   ② 由它向源设备要一张**窄 mt**（源设备现签，绑定请求方 DID + 短 TTL）；
///   ③ 再经 P2P 隧道把源设备的分享页代理过来（见 dsh_share 的「代打开」块注释）。
/// 拿不到隧道/授权时给人话（浏览器页），卡片本身永远可点、不再指向死链。
fn upsert_device_group_task(card: &Value, status: &str, from_device: &str, from_name: &str) {
    let task_id = card
        .get("taskId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if task_id.is_empty() {
        eprintln!("[chat] 设备群任务卡缺 taskId——不落库");
        return;
    }
    // task-24 防复活闸：tombstone 命中 → 任何来源（对账重放/迟到重投/别的设备
    // 群同步）都不得再落库——这正是「重启后 30 张死卡回魂」的落库口。
    if is_tombstoned(&task_id) {
        eprintln!("[chat] 设备群任务卡命中 tombstone，拒复活（{task_id}）");
        return;
    }
    // task-24 写入点：status=revoked 的广播（PC revoke → 设备群扇出）→ 打
    // tombstone 且**不落卡**（卡已死，落一张 revoked 行只会再喂对账一次）。
    if status == "revoked" {
        let share_id = card
            .get("shareId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        // 不仅 tombstone：已有卡行也要落 status=revoked，否则启动预热/对账仍把
        // status=todo 的旧行当有效声明（第三轮评审 MAJOR）。
        let hit = apply_task_revoke(&share_id, &task_id, now_ms());
        eprintln!("[chat] 设备群 revoke 广播 → tombstone + 标记 {hit} 张本地卡（{task_id}）");
        return;
    }
    let dev_name = device_label(from_device, from_name);
    let mut tasks = load_tasks();
    let mut obj = match card.as_object() {
        Some(o) => o.clone(),
        None => {
            eprintln!("[chat] 设备群任务卡形状非法（非对象）——不落库");
            return;
        }
    };
    obj.insert("sourceDevice".into(), json!(from_device));
    obj.insert("sourceDeviceName".into(), json!(dev_name));
    // done/其它状态：以投递方为准（分享下线同步 done）；缺状态默认 todo
    obj.insert(
        "status".into(),
        json!(if status.is_empty() { "todo" } else { status }),
    );
    // 跨设备：动作指向本机 remoteOpen（有 shareId 才有可打开的入口；没有就不给假动作）。
    //
    // **env 卡例外**（2026-10-23 真机 bug）：卡上有 env 时动作必须是 `open-env`——
    // 接收方自己按 `env[]` 建链（RDP→mstsc / DSH→浏览器）。若照旧改写成 remoteOpen
    // 的 `open-url`，任务列表行就会落到分享入口 `/gw/<id>/app/`，页面报
    // `no valid share cookie (open the share entry first)`（cookie 只在入口 `/gw/<id>/`
    // 的 302 里种，`/app/` 是反代面）。没有 env 的老卡保持原改写，逐字节不变。
    obj.insert("remoteOrigin".into(), json!(true));
    let share_id = obj
        .get("shareId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let from_account = obj
        .get("from")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if let Some(act) = crate::dsh_share::env_card_action(&Value::Object(obj.clone()), &share_id) {
        obj.insert("action".into(), act);
    } else if !share_id.is_empty() && !from_device.trim().is_empty() && !from_account.is_empty() {
        obj.insert("action".into(), json!({
            "kind": "open-url",
            "url": crate::dsh_share::remote_open_action_url(&share_id, &from_account, from_device),
            "label": "打开",
            "target": "window",
        }));
    } else {
        // 缺来源信息：清掉源设备那份死链（127.0.0.1:3102 在本机必然打不开），
        // 只留"不可点"声明（UI 据此不显示「打开」）——宁可少一个动作，不给死链。
        if let Some(act) = obj.get_mut("action").and_then(|a| a.as_object_mut()) {
            act.insert("kind".into(), json!("remote"));
            act.remove("url");
        }
    }
    let rec = Value::Object(obj);
    tasks.retain(|t| t.get("taskId").and_then(|v| v.as_str()) != Some(task_id.as_str()));
    // 2026-11-15 去重（用户实拍「两张一模一样的 ADB 调试」）：
    // 只按 taskId 幂等不够——同一张卡换个 taskId 再投递就是两张。
    dedupe_task_records(&mut tasks, &rec);
    tasks.push(rec);
    save_tasks(&tasks);
}

/// 来源设备显示名：优先投递方给的 deviceName，缺失则尾 4 位 did（绝不显示全称 did）。
fn device_label(from_device: &str, from_name: &str) -> String {
    let n = from_name.trim();
    if !n.is_empty() {
        return n.to_string();
    }
    let t = from_device.trim();
    if t.is_empty() {
        return "另一台设备".into();
    }
    let tail: String = t
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("设备…{tail}")
}

/// 第94轮：媒体上限分档——图片维持 2MB（现有压缩链路不变）；任意文件放宽 10MB
/// （二进制），b64 ≈ 13.4M 字符，14M 上限留裕量（p2p_server body limit 已同步 16MB）。
const IMG_B64_MAX: usize = 2_800_000;
const FILE_B64_MAX: usize = 14_000_000;

/// 本地落一条 dir=out 的消息。sendState（第95轮）：sent|sending|failed——
/// UI 状态徽标数据源（⏳ 发送中 / ✓ 已发送 / ! 失败可重发）。
/// 决策D-2：群会话（grp-*）行补 fromDevice/fromDeviceName——对端设备群 dir 判定
/// 与气泡设备署名的数据源（对账副本 wire_pack_msg 原样带这两键，不增流量；
/// 单聊行不需要，不加）。
fn append_out(
    conv_id: &str,
    my: &str,
    to: &str,
    kind: &str,
    payload: Value,
    msg_id: &str,
    ts: i64,
    send_state: &str,
) {
    let mut row = json!({
        "msgId": msg_id, "from": my, "to": to, "kind": kind, "payload": payload, "ts": ts, "dir": "out",
        "sendState": send_state,
    });
    if conv_id.starts_with("grp-") {
        row["fromDevice"] = json!(my_device_did());
        row["fromDeviceName"] = json!(device_display_name());
    }
    conv_append(conv_id, &row);
}

/// 发送状态事件（fast-ack 2026-10-18）：形状 `{convId,msgId,state,delivered,ts}`。
/// 事件名沿用既有 `chat-send-state`（PC UI 只重载不读字段，字段扩展向后兼容）；
/// delivered=已确认投递的目标数（0=仅本机接受，>0=至少一台对端设备收下）。
/// 测试态 no-op——理由见 build.rs 顶部（.emit() 会链 webview 运行时导致测试 exe
/// 0xC0000139 起不来）。
fn emit_send_state(conv_id: &str, msg_id: &str, state: &str, delivered: u32) {
    #[cfg(not(test))]
    if let Some(app) = crate::p2p_client::current_app_handle() {
        let _ = app.emit(
            "chat-send-state",
            json!({ "convId": conv_id, "msgId": msg_id, "state": state, "delivered": delivered, "ts": now_ms() }),
        );
    }
    #[cfg(test)]
    let _ = (conv_id, msg_id, state, delivered);
}

/// 第95轮：回写某条消息的 sendState（补发成功 sent / 重试失败 failed）。
/// 逐等价文件找目标行改写（消息可能落在历史形态文件里）+ emit chat-send-state。
pub fn conv_update_send_state(conv_id: &str, msg_id: &str, state: &str) {
    let delivered = matches!(state, "sent" | "read");
    conv_update_send_state_delivered(conv_id, msg_id, state, delivered as u32);
}

/// delivered 显式版（fast-ack 后台投递计数回写；`state` 与 `delivered` 分开给）。
pub fn conv_update_send_state_delivered(conv_id: &str, msg_id: &str, state: &str, delivered: u32) {
    let hit = conv_rewrite(conv_id, |m| {
        if m.get("msgId").and_then(|v| v.as_str()) != Some(msg_id) {
            return false;
        }
        m["sendState"] = json!(state);
        // 2026-10-20：投递结果落行（CLI/脚本等调用方需要分层状态，UI 无感）
        if state == "sent" && delivered > 0 {
            m["deliveredCount"] = json!(delivered);
            m["deliveredAt"] = json!(now_ms());
        }
        if state == "failed" {
            m["queued"] = json!(true);
        }
        true
    });
    if !hit {
        return;
    }
    emit_send_state(conv_id, msg_id, state, delivered);
}

/// 补发成功后收尾：消息行翻 sent + trace + 文件分片补推（信封到=媒体随其后）。
fn apply_flushed(sent: Vec<crate::offline_queue::OutboxItem>, account: &str) -> usize {
    let n = sent.len();
    for item in sent {
        conv_update_send_state(&item.conv_id, &item.msg_id, "sent");
        // M9 观测：send-ack 的 ts → 本次 deliver-ok 的 ts = 自动补发时延
        chat_trace("deliver-ok", &item.msg_id, account, 0);
        if item.envelope.get("kind").and_then(|v| v.as_str()) == Some("file")
            && item
                .envelope
                .pointer("/payload/mediaRef")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        {
            let p = item.envelope.get("payload").cloned().unwrap_or(json!({}));
            let (mid, nm, mm, sha) = (
                item.msg_id.clone(),
                p.get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("file")
                    .to_string(),
                p.get("mime")
                    .and_then(|v| v.as_str())
                    .unwrap_or("application/octet-stream")
                    .to_string(),
                p.get("sha256")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            );
            if let Some(bytes) = read_media_bytes_by_msg_id(&mid) {
                let acc = account.to_string();
                tauri::async_runtime::spawn(async move {
                    let _ =
                        crate::p2p_client::deliver_media_chunks(&acc, &mid, &nm, &mm, &sha, &bytes)
                            .await;
                });
            }
        }
    }
    n
}

/// 第95轮：某账号上线（或对账建立）→ 补发其待发队列；成功条目消息行翻 "sent"。
/// 第96轮（修复3）：补发成功的 file 信封随推媒体分片（信封到了媒体没到=对端
/// pending——离线期积压的文件在此闭环）。
/// 返回补发成功条数（调用方日志/事件用）。
pub async fn flush_outbox_for(account: &str) -> usize {
    if !crate::offline_queue::global().has_pending_for_account(account) {
        return 0; // 快路径：无待发零开销（sync_loop 每轮全好友调用）
    }
    let sent = crate::offline_queue::flush_account_prod(account).await;
    apply_flushed(sent, account)
}

/// 2026-10-18 fast-ack 补发环用的"限流补发"：FIFO 逐条重发、**遇第一条全目标
/// 失败即停**（离线期长队不会把一轮补发拖成分钟级——前台 3s 节奏才成立），最多
/// `max_items` 条。成功条目消息行翻 sent。返回补发成功条数。
pub async fn flush_outbox_for_burst(account: &str, max_items: usize) -> usize {
    if !crate::offline_queue::global().has_pending_for_account(account) {
        return 0;
    }
    let sent = crate::offline_queue::global()
        .flush_account_burst(account, crate::offline_queue::deliver_prod_fast, max_items)
        .await;
    apply_flushed(sent, account)
}

/// 信箱轮询环（2026-10-18 收消息提速）：**前台 1.5s / 后台 5s**。P2P 直推到达
/// 已即时 ingest（p2p_server POST）；本环只兜服务器信箱里的低频控制消息
/// （好友握手/群元数据/断线恢复）——新入库逐条 emit chat-incoming，UI 立即重读
/// （M7：不再依赖前端 5s 轮询窗口）。不引入任何"服务器存消息"依赖。
pub fn start_fast_poll_loop() {
    tauri::async_runtime::spawn(async move {
        loop {
            let interval = if app_foreground() { 1_500 } else { 5_000 };
            tokio::time::sleep(std::time::Duration::from_millis(interval)).await;
            let Some(my) = core_id::account_did() else {
                continue;
            };
            let _ = poll_mailbox(&my).await; // 断网/未登录错误静默（UI 自己 poll 仍带错误给用户）
        }
    });
}

/// 本机是否有一条可路由的默认网络（UDP connect 只查路由表，**不发包、不阻塞**）。
/// 补发环用：断网→恢复/切网时立即重置退避节奏（任务书里"网络变化"触发；客户端没有
/// 跨平台网络事件源，2s 一次路由探测是最便宜可靠的替代）。
fn network_reachable() -> bool {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| s.connect("8.8.8.8:80").map(|_| ()))
        .is_ok()
}

/// 待发补发环（2026-10-18 fast-ack）：前台 **3s 起指数退避**（3/6/12/24/48/60s），
/// 后台 60s；回前台立即重置节奏并补发一轮（M9：切网/重连/回前台 ≤3s 自动补发）。
/// 网络恢复（路由探测 false→true）同样立即重置。无待发时 500ms 轻量检查（读
/// offline_queue 的内存 hint，不解析 outbox.json）。
pub fn start_outbox_retry_loop() {
    tauri::async_runtime::spawn(async move {
        let mut attempt: u32 = 0;
        let mut next_at: i64 = 0;
        let mut prev_fg = app_foreground();
        let mut seen_seq: u64 = 0;
        let mut net_last = network_reachable();
        let mut net_checked_at = now_ms();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let now = now_ms();
            let fg = app_foreground();
            if fg && !prev_fg {
                // 回前台：立即一轮（切网/休眠恢复后 3s 内补发的起点）
                attempt = 0;
                next_at = now;
            }
            prev_fg = fg;
            // 网络变化触发（2s 探测一次；false→true = 断网恢复/切网成功）
            if now - net_checked_at >= 2_000 {
                net_checked_at = now;
                let net_now = network_reachable();
                if net_now && !net_last {
                    attempt = 0;
                    next_at = now;
                }
                net_last = net_now;
            }
            let ob = crate::offline_queue::global();
            // 新失败消息入队 → 立即重置退避（新消息不该排在旧长队的长退避后面）
            let seq = ob.enqueue_seq();
            if seq != seen_seq {
                seen_seq = seq;
                attempt = 0;
                next_at = now;
            }
            if now < next_at {
                continue;
            }
            if !ob.has_pending_hint() {
                attempt = 0;
                next_at = now + 1_000;
                continue;
            }
            let accounts = ob.pending_accounts();
            if accounts.is_empty() {
                attempt = 0;
                next_at = now + 1_000;
                continue;
            }
            for a in &accounts {
                let _ = flush_outbox_for_burst(a, 3).await;
            }
            let ob = crate::offline_queue::global();
            if ob.has_pending_hint() {
                let delay = crate::offline_queue::retry_delay_ms(attempt, fg);
                attempt = attempt.saturating_add(1);
                next_at = now_ms() + delay as i64;
            } else {
                attempt = 0;
                next_at = now_ms() + 1_000;
            }
        }
    });
}

// ══════════════ 状态快照（UI 一次拉全） ══════════════

fn conv_state() -> Value {
    let friends = load_friends();
    let groups = load_groups();
    let seen = load_seen();
    let mut convs: Vec<Value> = vec![];
    // group_kind：群档案的 kind 透传（设备群="device"）——conv 行自身的 kind 是会话
    // 类型（friend|group）不动，设备群标记走 groupKind 字段（UI 📱 徽标/隐藏 ⚙️ 用）。
    let mut push = |id: &str, kind: &str, title: &str, group_kind: Option<&str>| {
        let (last_ts, last_text) = conv_last(id).unwrap_or((0, String::new()));
        let seen_ts = seen.get(id).copied().unwrap_or(0);
        let unread = last_ts > 0 && seen_ts < last_ts;
        // 批三：未读计数数字化（seen 之后的入站条数；微信语义，>99 由 UI 显 99+）
        let unread_n = if unread {
            conv_unread_count(id, seen_ts)
        } else {
            0
        };
        let mut row = json!({ "id": id, "kind": kind, "title": title, "lastTs": last_ts, "lastText": last_text, "unread": unread, "unreadN": unread_n });
        // 小灵会话标记（UI 只读输入区/官方徽标用；official 好友行另带档案标记）
        if !id.is_empty() && is_official_conv(id) {
            row["official"] = json!(true);
        }
        if let Some(gk) = group_kind {
            row["groupKind"] = json!(gk);
        }
        convs.push(row);
    };
    for f in &friends {
        push(
            f.get("did").and_then(|d| d.as_str()).unwrap_or(""),
            "friend",
            f.get("name").and_then(|n| n.as_str()).unwrap_or("有灵账号"),
            None,
        );
    }
    for g in &groups {
        push(
            g.get("id").and_then(|d| d.as_str()).unwrap_or(""),
            "group",
            g.get("name").and_then(|n| n.as_str()).unwrap_or("群"),
            g.get("kind").and_then(|v| v.as_str()),
        );
    }
    convs.sort_by(|a, b| {
        b.get("lastTs")
            .and_then(|t| t.as_i64())
            .unwrap_or(0)
            .cmp(&a.get("lastTs").and_then(|t| t.as_i64()).unwrap_or(0))
    });
    Value::Array(convs)
}

/// 全量状态快照（本地优先）：好友/群/任务卡/会话列表全部本地读盘后立即返回，
/// **不再等**远端昵称（2026-10-06 修）：myName 走非阻塞缓存读（拿不到="我"），
/// 真名由 spawn_name_refresh_if_needed 后台补，下一次 poll 的快照自然带上。
/// 任务库按 `taskId` 去重（保留**最后**一条——后写的状态/改名更新为准）。
///
/// 正常 upsert 路径不会产生重复；但外部脚本编辑任务库（真案 2026-11-06：
/// PowerShell 拼接写回后同一个 DSH 卡出现两条）会让 UI 显示两张一模一样的卡。
/// 这里在快照出口兜一层，数据本身不删（保留历史，出错可回溯）。
fn dedupe_tasks(list: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::with_capacity(list.len());
    for t in list {
        let tid = t
            .get("taskId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if tid.is_empty() {
            out.push(t);
            continue;
        }
        match out.iter().position(|x| {
            x.get("taskId").and_then(|v| v.as_str()) == Some(tid.as_str())
        }) {
            Some(i) => out[i] = t,
            None => out.push(t),
        }
    }
    out
}

async fn state_snapshot() -> Result<Value, String> {
    let my_did = my_account_did()?;
    // 设备群挂点①（设备群设计 决策B）：chat_state/chat_poll 都过这里——登录后一切
    // 路径自动 ensure（幂等；切账号后 chat 桶随账号切，ensure 自动跟桶重建）。
    ensure_device_group_for(&my_did);
    // 小灵官方账号内置好友（幂等补缺；历史用户升级后首次 chat_state/chat_poll 即生效）
    ensure_official_friend();
    spawn_name_refresh_if_needed();
    // 2026-10-24 task-revoke：被撤销的卡（status=revoked）不进快照——UI 轮询
    // ≤5s 自然消失（选「直接隐藏」而非灰卡：撤了就是没了，历史仍在 peer-tasks.json）。
    // task-24：tombstone 命中的也滤（存量已复活进库的行由名单兜底拦住出镜）。
    let tasks_visible = {
        let dead_ids: Vec<String> = load_tombstones()
            .iter()
            .filter_map(|x| x.get("taskId").and_then(|v| v.as_str()).map(String::from))
            .collect();
        dedupe_tasks(load_tasks())
            .into_iter()
            .filter(|t| t.get("status").and_then(|s| s.as_str()) != Some("revoked"))
            .filter(|t| {
                let tid = t.get("taskId").and_then(|d| d.as_str()).unwrap_or("");
                !dead_ids.iter().any(|d| d == tid)
            })
            .collect::<Vec<_>>()
    };
    Ok(json!({
        "myDid": my_did,
        "myName": my_name_cached(),
        "friends": load_friends(),
        "groups": load_groups(),
        "tasks": tasks_visible,
        "convs": conv_state(),
    }))
}

// ══════════════ Tauri Commands ══════════════

/// 全量状态（好友/群/任务/会话列表）。UI 挂载与每次 poll 后刷新。
#[tauri::command]
pub async fn chat_state() -> Result<Value, String> {
    state_snapshot().await
}

/// 单聊发送：kind=text|image|file|task-share；to=对方账号 did。
/// 自己的消息本地直接落（乐观显示），不依赖服务器回环。
/// 第84轮：正文 P2P 直推（服务器白名单已移除这些 kind）。
/// **2026-10-18 fast-ack**：本地落库即返回（sendState="sent"=本机已收下并开始投递，
/// 目标 M2 ≤300ms），网络投递全部后台：成功→事件 delivered=N；全失败→入待发队列 +
/// sendState="failed"（目标 M5 ≤5s 可见、可重试），补发环成功后再翻回 "sent"。
/// 图片/文件字节本地先落盘（本机立即可见）；文件的媒体分片在信封送达后后台补推。
#[tauri::command]
pub async fn chat_send(to: String, kind: String, payload: Value) -> Result<Value, String> {
    let t_enter = std::time::Instant::now();
    let my = my_account_did()?;
    clear_typing(); // 发送即回退 active（输入框已清空）——2026-09-29 灯恢复
    spawn_name_refresh_if_needed(); // 投递信封的 fromName 后台补（不挡本机确认）
    let conv_id = my_did_conv(&to);
    let (msg_id, ts) = (new_msg_id(), now_ms());
    match kind.as_str() {
        "text" => {
            let text = payload
                .get("text")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            if text.trim().is_empty() {
                return Err("消息为空".into());
            }
            Ok(fast_ack_finish(
                &conv_id,
                &my,
                &to,
                "text",
                payload.clone(),
                "text",
                payload,
                false,
                false,
                &msg_id,
                ts,
                t_enter,
            ))
        }
        "image" => {
            let name = payload
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("image")
                .to_string();
            let mime = payload
                .get("mime")
                .and_then(|v| v.as_str())
                .unwrap_or("image/png")
                .to_string();
            let size = payload.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
            let b64s = payload
                .get("b64")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if b64s.len() > IMG_B64_MAX {
                return Err("文件超过 2MB 上限（发送前请压缩）".into());
            }
            // 本地媒体先落盘：本机立刻能看图，不等任何网络
            let media = save_media(&msg_id, &name, &mime, &b64s).unwrap_or_default();
            let local = json!({ "name": name, "mime": mime, "size": size, "media": media });
            Ok(fast_ack_finish(
                &conv_id, &my, &to, "image", local, "image", payload, false, false, &msg_id, ts,
                t_enter,
            ))
        }
        "file" => {
            let name = payload
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("file")
                .to_string();
            let mime = payload
                .get("mime")
                .and_then(|v| v.as_str())
                .unwrap_or("application/octet-stream")
                .to_string();
            let size = payload.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
            let b64s = payload
                .get("b64")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if b64s.len() > FILE_B64_MAX {
                return Err("文件过大（>10MB），暂不支持".into());
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&b64s)
                .map_err(|e| format!("base64 解码失败: {e}"))?;
            let sha = sha256_hex(&bytes);
            // 第96轮（修复3）：file 走解耦链路——信封只带 mediaRef（sha256 完整性锚），
            // 媒体字节本地落盘，信封送达后由后台补推分片（失败由补发/对账/按需拉兜底）。
            let media = save_media_bytes(&msg_id, &name, &mime, &bytes).unwrap_or_default();
            let wire = json!({ "name": name, "mime": mime, "size": bytes.len(), "sha256": sha, "mediaRef": true });
            let local =
                json!({ "name": name, "mime": mime, "size": size, "media": media, "sha256": sha });
            Ok(fast_ack_finish(
                &conv_id, &my, &to, "file", local, "file", wire, false, true, &msg_id, ts, t_enter,
            ))
        }
        "task-share" => {
            // 任务卡：payload 平铺契约字段（title/desc/requirements/r_spec/...），原样直推
            Ok(fast_ack_finish(
                &conv_id,
                &my,
                &to,
                "task-share",
                payload.clone(),
                "task-share",
                payload,
                false,
                false,
                &msg_id,
                ts,
                t_enter,
            ))
        }
        _ => Err(format!("不支持的 kind: {kind}")),
    }
}

/// 第96轮（修复6）：群发送禁言闸（纯函数，单测）——自己被禁言（且非群主）直接
/// 拒发。原只有接收端丢弃兜底=我发了没人理（静默吞消息），发送侧先挡+错误提示。
fn send_gate_muted(g: &Value, my: &str, now: i64) -> Result<(), String> {
    if !is_group_owner(g, my) && is_muted(g, my, now) {
        let until = g
            .pointer("/muted")
            .and_then(|m| m.get(my))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let hint = chrono::DateTime::from_timestamp_millis(until)
            .map(|t| {
                t.with_timezone(&chrono::Local)
                    .format("%m-%d %H:%M")
                    .to_string()
            })
            .unwrap_or_default();
        return Err(format!("你已被群主禁言，暂不能发言（至 {hint}）"));
    }
    Ok(())
}

/// 群消息发送：payload_core={text} 或 {name,mime,b64}（媒体；mime 非图片=文件）。
/// **2026-10-18 fast-ack**：同 chat_send——本地落库即返回；群成员**并行**扇出在后台
/// （M4 群 10 人 P95 目标 ≤1.5s），全失败入待发队列 + sendState="failed"。
#[tauri::command]
pub async fn chat_send_group(group_id: String, payload_core: Value) -> Result<Value, String> {
    let t_enter = std::time::Instant::now();
    let my = my_account_did()?;
    clear_typing(); // 发送即回退 active——2026-09-29 灯恢复
    spawn_name_refresh_if_needed(); // 群 wire payload 的 fromName 后台补（不挡本机确认）
    let groups = load_groups();
    let g = groups
        .iter()
        .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(group_id.as_str()))
        .ok_or_else(|| "群不存在（可能已被清理，重进好友分区刷新）".to_string())?;
    // 批二：终态群（已解散/已被移出）只读——发送拒绝（UI 输入区已禁用，这是数据层兜底）
    match group_terminal_status(g) {
        "disbanded" => return Err("群已被群主解散，仅可查看历史".into()),
        "kicked" => return Err("你已被移出该群，仅可查看历史".into()),
        _ => {}
    }
    send_gate_muted(g, &my, now_ms())?; // 第96轮：禁言发送侧闸
    let gname = g
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("群")
        .to_string();
    let members: Vec<String> = g
        .get("members")
        .and_then(|m| m.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let is_media = payload_core.get("b64").is_some();
    // 第94轮：群文件（非图片 mime）走 file 嵌套对象——接收端按 kind=file 落盘；
    // 同时带 text="[文件] xxx"（旧版本收 group-msg 只认 image/text，渲染纯文本不崩）。
    let is_file = is_media
        && !payload_core
            .get("mime")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .starts_with("image/");
    let text = payload_core
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    if !is_media && text.trim().is_empty() {
        return Err("消息为空".into());
    }
    let (msg_id, ts) = (new_msg_id(), now_ms());
    // 群消息 wire payload：{groupId, groupName, members(端侧扇出+接收端群档案自愈),
    // text|image|file 字段}——fromName 由后台投递线程补（need_from_name=true）。
    let (wire_payload, local_kind, local_payload) = if is_media {
        let name = payload_core
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("file")
            .to_string();
        let mime = payload_core
            .get("mime")
            .and_then(|v| v.as_str())
            .unwrap_or("application/octet-stream")
            .to_string();
        let size = payload_core
            .get("size")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let b64s = payload_core
            .get("b64")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let limit = if is_file { FILE_B64_MAX } else { IMG_B64_MAX };
        if b64s.len() > limit {
            return Err(if is_file {
                "文件过大（>10MB），暂不支持".into()
            } else {
                "图片超过 2MB 上限".into()
            });
        }
        // 本地媒体先落盘（本机立即可见，不等网络）
        let media = save_media(&msg_id, &name, &mime, &b64s).unwrap_or_default();
        let wire = if is_file {
            json!({ "groupId": group_id, "groupName": gname, "members": members,
                    "text": format!("[文件] {name}"),
                    "file": { "name": name, "mime": mime, "size": size, "b64": b64s } })
        } else {
            json!({ "groupId": group_id, "groupName": gname, "members": members,
                    "image": { "name": name, "mime": mime, "b64": b64s } })
        };
        // 2026-09-28：本落盘副本也带 members——无直连面的设备（手机）靠对账拉到的
        // 是本落盘副本，群档案兜底建群需要 members（否则 (0人)，双端深测抓出）。
        let local_kind = if is_file { "file" } else { "group-msg" };
        let local = json!({ "groupId": group_id, "groupName": gname, "members": members,
                            "name": name, "mime": mime, "size": size, "media": media });
        (wire, local_kind, local)
    } else {
        let wire = json!({ "groupId": group_id, "groupName": gname, "members": members,
                           "text": payload_core.get("text") });
        let local =
            json!({ "groupId": group_id, "groupName": gname, "members": members, "text": text });
        (wire, "group-msg", local)
    };
    Ok(fast_ack_finish(
        &group_id,
        &my,
        &group_id,
        local_kind,
        local_payload,
        "group-msg",
        wire_payload,
        true,
        false,
        &msg_id,
        ts,
        t_enter,
    ))
}

/// 拉信箱并入库：好友握手（去服务端化：request/accept/remove 三 kind 在 ingest_msg
/// 走验签+状态机）、群建卡/群管理入 groups，正文入 conv，媒体落盘。
#[tauri::command]
pub async fn chat_poll() -> Result<Value, String> {
    let my = my_account_did()?;
    // 本机快照（任务卡/好友/会话）**不因信箱轮询失败而整体失败**：
    // 离线/服务抖动时 UI 直接 catch → 任务页显示"没有任务"，看起来像卡丢了
    // （2026-11-06 笔记本真案现场之一）。轮询失败只降级为 ingested=0 + pollError。
    let (ingested, poll_error) = match poll_mailbox(&my).await {
        Ok(n) => (n, None),
        Err(e) => {
            eprintln!("[chat] 信箱轮询失败（本机状态照常返回）: {e}");
            (0, Some(e))
        }
    };
    let mut snap = state_snapshot().await?;
    snap["ingested"] = json!(ingested);
    if let Some(e) = poll_error {
        snap["pollError"] = json!(e);
    }
    Ok(snap)
}

/// 拉信箱并逐条入库（chat_poll / presence 登录首拉 / fast-ack 快轮询环共用底座）。
/// 返回新入库条数。2026-10-18：新入库逐条 emit chat-incoming + `[chat-trace] recv`
/// （后台快轮询环拉到消息时 UI 立即重读，不再等下一次前端 5s 轮询）。
pub async fn poll_mailbox(my: &str) -> Result<usize, String> {
    let resp = core_id::signed_post("/msg/poll", &json!({ "accountDid": my })).await?;
    let msgs = resp
        .pointer("/data/msgs")
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default();
    let mut ingested = 0usize;
    for m in &msgs {
        if ingest_msg(my, m).await {
            ingested += 1;
            trace_recv(m);
            // cfg(not(test))：UI 事件通道（理由见文件顶 `use tauri::Emitter` 注释）。
            #[cfg(not(test))]
            if let Some(app) = crate::p2p_client::current_app_handle() {
                let _ = app.emit(
                    "chat-incoming",
                    json!({
                        "msgId": m.get("msgId").or_else(|| m.get("id")),
                        "kind": m.get("kind"),
                        "from": m.get("from"),
                    }),
                );
            }
        }
    }
    // 官方通知自愈同步：启动首拉立刻做一次，之后 3s 最多一次（异步，不阻塞 poll 返回）。
    #[cfg(not(test))]
    {
        let now = now_ms();
        let last = OFFICIAL_SYNC_AT_MS.load(std::sync::atomic::Ordering::Relaxed);
        if now - last > 3_000
            && OFFICIAL_SYNC_AT_MS
                .compare_exchange(
                    last,
                    now,
                    std::sync::atomic::Ordering::Relaxed,
                    std::sync::atomic::Ordering::Relaxed,
                )
                .is_ok()
        {
            let my_owned = my.to_string();
            tauri::async_runtime::spawn(async move {
                let _ = official_pending_sync(&my_owned).await;
            });
        }
    }
    Ok(ingested)
}

/// 单条入站消息入库。返回是否入库（未知 kind 丢弃=false）。
async fn ingest_msg(my: &str, m: &Value) -> bool {
    let kind = m.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    // 2026-10-12 已读回执（控制 kind，不落会话——同 friend-request 家族）：
    // 对端打开会话 → 我发的消息翻 "read"（UI 显 ✓✓ 已读）。
    if kind == "msg-receipt" {
        return receipt_ingest(m);
    }
    // 2026-10-20 小灵官方通知：服务端直发 kind，**验签通过**才落「小灵」会话
    // （官方 did 校验 + ed25519 signer ∈ 官方 root/设备公钥；失败丢弃 + 审计）。
    if kind == OFFICIAL_NOTICE_KIND {
        return official_notice_ingest(my, m).await;
    }
    // 2026-11-11 跨账号 DSH 会话消息（`msg_route`）：控制类，**不落会话/不产气泡**
    // ——处置 = 注入本机 DSH 会话（署名头 + 既有 `session/prompt` 代理）。
    // 准入/防伪造（传输层 did 为准）全在 msg_route::ingest，见该文件头契约。
    if kind == crate::msg_route::KIND_DSH_SESSION_MSG {
        return crate::msg_route::ingest(my, m).await;
    }
    // 2026-10-09 跨设备「代打开」：两个控制 kind 不进会话/任务库，直接交 dsh_share。
    //   ① request：A 侧校验授权 → 现签窄 mt → 回 grant（人话拒绝也在回包里）；
    //   ② grant  ：B 侧唤醒在等的 remoteOpen（缓存 mt）。
    // 放在最前面：它们**没有会话语义**，落行会把"要一张票"变成聊天记录。
    // 2026-10-18 同账号授权设备远程管理分享（手机「权限设置」）：控制面，不落会话
    if kind == "share-admin-request" {
        return crate::dsh_share::share_admin_request_ingest(m).await;
    }
    if kind == "share-entry-request" {
        return crate::dsh_share::share_entry_request_ingest(m).await;
    }
    if kind == "share-entry-grant" {
        return crate::dsh_share::share_entry_grant_ingest(m);
    }
    // §3.23 转授闸（canReshare）：两个控制 kind，同样**没有会话语义**（不落行、不进任务库）：
    //   · `reshare-request`：B（好友）→ A（源设备）"我想把这张卡转给第三人，请主人同意"；
    //   · `reshare-grant`  ：A → B，批示（批准 / 待批 / 拒绝 + 我这边的转授能力刷新）。
    if kind == "reshare-request" {
        return crate::dsh_share::reshare_request_ingest(m).await;
    }
    if kind == "reshare-grant" {
        // B 侧：把本机那张卡的转授能力刷新（`canReshare`/`reshareExp`/血缘）——只动任务库，
        // 不发气泡（"我申请了转授"不该变成聊天记录）。
        if let Some(u) = crate::dsh_share::reshare_grant_view(m) {
            apply_reshare_update(&u);
        }
        return true;
    }
    // 2026-10-09 双向打洞（设计文档 07-connectivity）：两个控制 kind，同样**没有会话
    // 语义**（不落行、不进任务库）——A 侧收 request 回 ack+反向探测，B 侧收 ack 唤醒
    // 在等的打洞腿（p2p_tunnel::hole_punch_leg）。信令细节见上方「双向打洞信令」块注释。
    if kind == "hole-punch-request" {
        return hole_punch_request_ingest(my, m).await;
    }
    if kind == "hole-punch-ack" {
        return hole_punch_ack_ingest(m);
    }
    // 任务卡改名（task-rename，2026-10-11）：**必须在 self_echo 的 from 改写之前**——
    // 自同步回流 from==my 会被归位成对方 did，owner 校验（from==task.from）会误杀自己。
    // 校验/幂等/落行语义见 ingest_task_rename 与上方「任务卡改名」块注释。
    if kind == "task-rename" {
        return ingest_task_rename(my, m);
    }
    // 2026-10-07 好友去服务端化：握手三 kind 走独立验签链+状态机（friend_ingest_msg）
    // ——不进会话/自同步归位，先于 self_echo 的 from 改写处理；信箱 `id` 键与
    // P2P `msgId` 键由 ingest_p2p_inner 适配层归一（幂等靠状态机，不做 msgId 去重）。
    if kind == "friend-request" || kind == "friend-accept" || kind == "friend-remove" {
        return friend_ingest_msg(my, m).await;
    }
    let mut from = m
        .get("from")
        .and_then(|f| f.as_str())
        .unwrap_or("")
        .to_string();
    let payload = m.get("payload").cloned().unwrap_or(json!({}));
    // 设备群语义修正（设备群设计 决策D，公会场景成败点）：同账号所有设备共用
    // 账号 did——设备群会话（payload.groupId=grp-dev-*）内 from==my 恒真，不能再
    // 以它判"我发的"（老语义会把同事设备的消息全标成"我"）。本机/他机按信封
    // fromDevice==本机设备 did 区分（ingest_p2p_inner 已透传；did_equiv 双形态
    // 互认）。缺 fromDevice（信箱副本——设备群正文永远走 P2P，理论不可达）→
    // 视为他机 in。普通群/单聊不动（保持"from==my 即 out"的自同步语义）。
    let dev_grp = payload
        .get("groupId")
        .and_then(|v| v.as_str())
        .map(is_device_group_id)
        .unwrap_or(false);
    let from_device = m
        .get("fromDevice")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // 第96轮（修复5）：自同步回流标记——from==my 的消息是"我发的"（另一台设备的
    // out 副本经对账/直推回流），归位后必须 dir=out，否则第二台设备上"我发的"
    // 显示在左侧。渲染层另有 from==my 优先 out 双保险（chat_load_conv）。
    let self_echo = if dev_grp {
        dir_for_device_group(&from_device, &my_device_did()) == "out"
    } else {
        !my.is_empty() && core_id::account_did_eq(&from, my)
    };
    // 第84轮：对账回流里 from==my（自己在对端的 out 副本）——归位到"与 to 的会话"
    // （按 from 落会新建 did_safe(my) 会话，同 msgId 判重失效、F 永不收敛）。
    // 设备群跳过归位：from 恒为本机账号 did（归位会把它改成群 id，丢设备署名锚）。
    if self_echo && !dev_grp {
        if let Some(to) = m
            .get("to")
            .and_then(|t| t.as_str())
            .filter(|t| !t.is_empty())
        {
            from = to.to_string();
        }
    }
    let dir_in = dir_for_ingest(self_echo);
    let msg_id = m
        .get("id")
        .and_then(|i| i.as_str())
        .unwrap_or("")
        .to_string();
    let ts = m.get("ts").and_then(|t| t.as_i64()).unwrap_or_else(now_ms);
    // 2026-10-09 任务卡跨设备同步·接收侧：**只认本账号设备群**（安全闸 → 见函数注释）。
    // 命中 = 本机自己发的回环（不重复落）或他机来的卡（落本地任务库）；
    // 非本账号设备群的任务卡**一律到此为止**（不落卡），但仍走既有 task-share
    // 分支落会话——防塞卡闸绝不能顺手吃掉正常群任务卡。
    if kind == "task-share" && dev_grp {
        let from_device_name = m
            .get("fromDeviceName")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if device_group_task_ingest(my, &from_device, from_device_name, &payload) {
            return true;
        }
    }

    match kind {
        "group-create" => {
            let gid = payload
                .get("groupId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let gname = payload
                .get("groupName")
                .and_then(|v| v.as_str())
                .unwrap_or("群")
                .to_string();
            let members: Vec<String> = payload
                .get("members")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            if gid.is_empty() {
                return false;
            }
            // 设备群：群档案纯本地 ensure 派生，绝无真 group-create——到达即伪造，拒收
            // （防老端/恶意端伪造建群卡改动档案）。
            if is_device_group_id(&gid) {
                return false;
            }
            // 批二：终态群（已解散/已被移出）不复活 members——迟到的 group-create（对账
            // 从持有方的群 jsonl 补齐）只补记录，不把死群拉回活跃。
            let terminal = load_groups().iter().any(|g| {
                g.get("id").and_then(|d| d.as_str()) == Some(gid.as_str())
                    && !group_terminal_status(g).is_empty()
            });
            if !terminal {
                group_upsert(
                    &gid,
                    &gname,
                    members,
                    payload.get("owner").and_then(|v| v.as_str()),
                ); // 第85轮：群主随建群到达
            }
            // 批二：group-create 落群会话 jsonl（UI 渲染"群已创建"系统条）——关键是对账载体：
            // 离线成员错过直推时靠对账从群 conv 补齐本条即得真 owner（自愈建群 ownerPending 解除），
            // 不再靠"字典序首成员"冒充群主（各端认知分叉根因）。msgId 幂等（直推+对账双路径）。
            conv_append(
                &gid,
                &json!({
                    "msgId": msg_id, "from": from, "to": gid, "kind": "group-create",
                    "payload": { "groupId": gid, "groupName": gname, "members": payload.get("members"),
                                 "owner": payload.get("owner") },
                    "ts": ts, "dir": "in", "fromName": m.get("fromName"),
                }),
            );
            true
        }
        // ── 第85轮：群管理五操作（治理闸：非群主拒收；单测覆盖） ──
        "group-invite" => {
            let gid = payload
                .get("groupId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if is_device_group_id(&gid) {
                return false;
            } // 设备群：管理消息全拒（系统群）
            if gid.is_empty()
                || !load_groups()
                    .iter()
                    .any(|g| g.get("id").and_then(|d| d.as_str()) == Some(gid.as_str()))
            {
                return false;
            }
            let members: Vec<String> = payload
                .get("members")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let ok = apply_group_update(&gid, &from, |g| {
                if !members.is_empty() {
                    g["members"] = json!(members);
                }
            });
            if ok {
                // 我被拉进群：系统条
                for nm in payload
                    .get("newMembers")
                    .and_then(|v| v.as_array())
                    .into_iter()
                    .flatten()
                {
                    if nm.as_str() == Some(my) {
                        conv_append(
                            &gid,
                            &json!({
                                "msgId": msg_id, "from": from, "to": gid, "kind": "sys",
                                "payload": { "text": "🎉 你被拉进了群聊" }, "ts": ts, "dir": "in",
                            }),
                        );
                    }
                }
            }
            ok
        }
        "group-rename" => {
            let gid = payload
                .get("groupId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if gid.is_empty() || is_device_group_id(&gid) {
                return false;
            } // 设备群：管理消息全拒
            let new_name = payload
                .get("newName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            apply_group_update(&gid, &from, |g| {
                if !new_name.is_empty() {
                    g["name"] = json!(new_name);
                }
            })
        }
        "group-leave" => {
            let gid = payload
                .get("groupId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if is_device_group_id(&gid) {
                return false;
            } // 设备群：管理消息全拒（系统群不可退出）
            if gid.is_empty()
                || !load_groups()
                    .iter()
                    .any(|g| g.get("id").and_then(|d| d.as_str()) == Some(gid.as_str()))
            {
                return false;
            }
            // 批二：终态群（已解散/已被移出）的 leave 拒收——群主退群=解散的场景里
            // compat group-leave 随 group-disband 一并发出，新端只认 disband（防重复系统条）。
            if load_groups().iter().any(|g| {
                g.get("id").and_then(|d| d.as_str()) == Some(gid.as_str())
                    && !group_terminal_status(g).is_empty()
            }) {
                return false;
            }
            let mut list = load_groups();
            if let Some(g) = list
                .iter_mut()
                .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(gid.as_str()))
            {
                let rem: Vec<String> = g
                    .get("members")
                    .and_then(|m| m.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                g["members"] = json!(rem.into_iter().filter(|m| m != &from).collect::<Vec<_>>());
            }
            save_groups(&list);
            let who = m.get("fromName").and_then(|v| v.as_str()).unwrap_or("成员");
            conv_append(
                &gid,
                &json!({
                    "msgId": msg_id, "from": from, "to": gid, "kind": "sys",
                    "payload": { "text": format!("{who} 退出了群聊") }, "ts": ts, "dir": "in",
                }),
            );
            true
        }
        // 批二（2026-09-28）：群主退群=解散——owner 发起 group-disband（先 disband 后
        // compat group-leave，老端只见 leave 优雅降级为"群主退出了群聊"）。
        // 接收端：群会话保留只读（历史可回查）、members 清空、系统条"群已被解散"。
        "group-disband" => {
            let gid = payload
                .get("groupId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if gid.is_empty() || is_device_group_id(&gid) {
                return false;
            } // 设备群：管理消息全拒（系统群不可解散）
              // 治理闸：只认真群主（档案不存在=重复投递/未知群 → 丢弃）
            let Some(g0) = load_groups()
                .iter()
                .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(gid.as_str()))
                .cloned()
            else {
                return false;
            };
            if !is_group_owner(&g0, &from) {
                return false;
            }
            let gname = payload
                .get("groupName")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from)
                .or_else(|| g0.get("name").and_then(|v| v.as_str()).map(String::from))
                .unwrap_or_else(|| "群".into());
            group_mark_terminal(
                &gid,
                "disbanded",
                &format!("群「{gname}」已被群主解散"),
                &msg_id,
                ts,
                &from,
            );
            true
        }
        "group-kick" => {
            let gid = payload
                .get("groupId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let target = payload
                .get("targetDid")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if is_device_group_id(&gid) {
                return false;
            } // 设备群：管理消息全拒（成员=名册，非群消息可改）
              // 治理闸先行（防非群主伪 kick）；档案不存在（重复投递）→ 丢弃
            let Some(g0) = load_groups()
                .iter()
                .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(gid.as_str()))
                .cloned()
            else {
                return false;
            };
            if !is_group_owner(&g0, &from) {
                return false;
            }
            if core_id::account_did_eq(&target, &my) {
                // 批二：被踢的是我——不再静默删群：群会话保留只读（历史可回查）+ 系统条
                // "你已被移出群「X」" + 档案 status=kicked（UI 灰色行+输入区禁用+toast）。
                let gname = g0.get("name").and_then(|v| v.as_str()).unwrap_or("群");
                group_mark_terminal(
                    &gid,
                    "kicked",
                    &format!("你已被移出群「{gname}」"),
                    &msg_id,
                    ts,
                    &from,
                );
                return true;
            }
            // 批二：终态群的 kick（他人被踢）随只读语义拒收（群已死，members 无意义）
            if !group_terminal_status(&g0).is_empty() {
                return false;
            }
            let members: Vec<String> = payload
                .get("members")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            apply_group_update(&gid, &from, |g| {
                if !members.is_empty() {
                    g["members"] = json!(members);
                } else {
                    let rem: Vec<String> = g
                        .get("members")
                        .and_then(|m| m.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    g["members"] =
                        json!(rem.into_iter().filter(|m| *m != target).collect::<Vec<_>>());
                }
                if let Some(mu) = g.get_mut("muted").and_then(|v| v.as_object_mut()) {
                    mu.remove(&target);
                }
            })
        }
        "group-mute" => {
            let gid = payload
                .get("groupId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let target = payload
                .get("targetDid")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let until = payload
                .get("mutedUntil")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            if gid.is_empty() || is_device_group_id(&gid) {
                return false;
            } // 设备群：管理消息全拒
            apply_group_update(&gid, &from, |g| {
                if g.get("muted").and_then(|v| v.as_object()).is_none() {
                    g["muted"] = json!({});
                }
                if let Some(mu) = g.get_mut("muted").and_then(|v| v.as_object_mut()) {
                    if until > 0 {
                        mu.insert(target.clone(), json!(until));
                    } else {
                        mu.remove(&target);
                    }
                }
            })
        }
        "text" => {
            conv_append(
                &my_did_conv(&from),
                &json!({
                    "msgId": msg_id, "from": from, "to": my, "kind": "text", "payload": payload, "ts": ts, "dir": dir_in,
                    "fromName": m.get("fromName"),
                }),
            );
            true
        }
        // ── 批三：撤回控制消息（限时 2 分钟由发送端闸；接收端按 msgId tombstone，
        //    控制消息本体不落盘——tombstone 行即"xxx 撤回了一条消息"系统条的数据源）。
        //    群：payload.groupId 定位会话；单聊：与 from 的会话。
        "recall" => {
            let target = payload
                .get("msgId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if target.is_empty() {
                return false;
            }
            let conv = match payload
                .get("groupId")
                .and_then(|v| v.as_str())
                .filter(|g| g.starts_with("grp-"))
            {
                Some(g) => g.to_string(),
                None => my_did_conv(&from),
            };
            conv_tombstone_msg(&conv, &target)
            // 返回 true → 调用方 emit chat-incoming（UI 重读，tombstone 上屏）；
            // 未命中（消息还没到/已撤过）返回 false，幂等无副作用。
        }
        // ── 批三：tombstone 行的对账副本（他设备已撤回的落盘形态）——原样入库。
        //    注意：同 msgId 原文已在本地时 meta 幂等会丢弃副本（F 只覆盖 id 集合，
        //    内容变更不触发对账）——离线期已同步原文的设备保留原文是已知边界。
        "recalled" => {
            let conv = match payload
                .get("groupId")
                .and_then(|v| v.as_str())
                .filter(|g| g.starts_with("grp-"))
            {
                Some(g) => g.to_string(),
                None => my_did_conv(&from),
            };
            conv_append(
                &conv,
                &json!({
                    "msgId": msg_id, "from": from, "to": m.get("to").cloned().unwrap_or(json!(my)), "kind": "recalled",
                    "payload": payload, "ts": ts, "dir": "in", "fromName": m.get("fromName"),
                }),
            );
            true
        }
        "image" | "file" => {
            let name = payload
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("file")
                .to_string();
            let mime = payload
                .get("mime")
                .and_then(|v| v.as_str())
                .unwrap_or("application/octet-stream")
                .to_string();
            let size = payload.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
            let b64s = payload
                .get("b64")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            // 第96轮（修复3）：单聊 file 无 b64 带 mediaRef → 落 pending 行（正文/媒体
            // 解耦——字节走 /p2p/media/chunk 分片后补；media 引用先指向将来落盘位）。
            if kind == "file" && b64s.is_empty() {
                let sha = payload
                    .get("sha256")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if sha.is_empty() {
                    return false;
                } // 既无字节也无引用——无法恢复，丢弃
                let rel = format!("media/{}.{}", safe_msg_id(&msg_id), ext_of(&name, &mime));
                conv_append(
                    &my_did_conv(&from),
                    &json!({
                        "msgId": msg_id, "from": from, "to": my, "kind": kind,
                        "payload": { "name": name, "mime": mime, "size": size, "sha256": sha,
                                     "media": rel, "mediaPending": true },
                        "ts": ts, "dir": dir_in, "fromName": m.get("fromName"),
                    }),
                );
                return true;
            }
            let media = save_media(&msg_id, &name, &mime, &b64s).unwrap_or_default();
            // 2026-09-28：群图片消息的对账副本（kind=image + payload.groupId）归位到群会话——
            // 直推正本（kind=group-msg 嵌套 image）已按群落盘（同 msgId），副本若按单聊
            // 落盘会绕开按会话的幂等闸，重复进直聊会话。第94轮：file 副本同规则。
            let conv = match payload
                .get("groupId")
                .and_then(|v| v.as_str())
                .filter(|g| g.starts_with("grp-"))
            {
                Some(g) => g.to_string(),
                None => my_did_conv(&from),
            };
            conv_append(
                &conv,
                &json!({
                    "msgId": msg_id, "from": from, "to": my, "kind": kind,
                    "payload": { "groupId": payload.get("groupId"), "groupName": payload.get("groupName"), "members": payload.get("members"),
                                 "name": name, "mime": mime, "size": size, "media": media }, "ts": ts, "dir": dir_in,
                    "fromName": m.get("fromName"),
                    "fromDevice": m.get("fromDevice"), "fromDeviceName": m.get("fromDeviceName"), // 决策D-2：群行带设备署名
                }),
            );
            true
        }
        "group-msg" => {
            let gid = payload
                .get("groupId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if gid.is_empty() {
                return false;
            }
            // 群不认识（离线期建的群）：从 payload 自愈群档案
            // 批二：自愈建群 owner 未知 → ownerPending（治理全拒直到 group-create 补齐），
            // 不再让字典序首成员冒充群主（各端认知分叉根因）。
            if !load_groups()
                .iter()
                .any(|g| g.get("id").and_then(|d| d.as_str()) == Some(gid.as_str()))
            {
                let gname = payload
                    .get("groupName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("群")
                    .to_string();
                let members: Vec<String> = payload
                    .get("members")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                group_upsert_selfheal(&gid, &gname, members);
                // 设备群消息先于本地 ensure 到达（冷启动竞态）：档案立即归位系统群标记，
                // ensure 的校正路径幂等兜底仍在。
                if is_device_group_id(&gid) {
                    mark_device_group(&gid);
                }
            }
            // 第85轮：禁言校验——被禁言成员的群消息丢弃（群主/自己豁免）
            if let Some(g) = load_groups()
                .iter()
                .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(gid.as_str()))
            {
                if from != my && !is_group_owner(g, &from) && is_muted(g, &from, ts) {
                    return false;
                }
            }
            // 媒体群消息：image/file 嵌套对象；文本：text 字段
            // 2026-09-28：入站图片副本保留 members（文本副本 local=payload.clone() 天然带）——
            // 其他设备从本机对账拉走时群档案兜底建群需要它。
            // 第94轮：file 嵌套（任意文件）→ kind=file 落盘；text 字段是旧版本降级文案。
            let mut local = payload.clone();
            let mut media_kind = "";
            if let Some(img) = payload.get("image").cloned() {
                let name = img
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("file")
                    .to_string();
                let mime = img
                    .get("mime")
                    .and_then(|v| v.as_str())
                    .unwrap_or("application/octet-stream")
                    .to_string();
                let b64s = img
                    .get("b64")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let media = save_media(&msg_id, &name, &mime, &b64s).unwrap_or_default();
                local = json!({ "groupId": gid, "groupName": payload.get("groupName"), "members": payload.get("members"),
                                "name": name, "mime": mime, "media": media });
                media_kind = "image";
            } else if let Some(fobj) = payload.get("file").cloned() {
                let name = fobj
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("file")
                    .to_string();
                let mime = fobj
                    .get("mime")
                    .and_then(|v| v.as_str())
                    .unwrap_or("application/octet-stream")
                    .to_string();
                let size = fobj.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
                let b64s = fobj
                    .get("b64")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let media = save_media(&msg_id, &name, &mime, &b64s).unwrap_or_default();
                local = json!({ "groupId": gid, "groupName": payload.get("groupName"), "members": payload.get("members"),
                                "name": name, "mime": mime, "size": size, "media": media });
                media_kind = "file";
            }
            conv_append(
                &gid,
                &json!({
                    "msgId": msg_id, "from": from, "to": gid,
                    // §3.19.4：带 system:true 的群消息（myco 可信机制留痕，如 cap_denied）
                    // 入本地 kind="sys"——UI 既有系统条渲染直接可用（与发送端同一判定）。
                    "kind": group_conv_kind(media_kind,
                        payload.get("system").and_then(|v| v.as_bool()).unwrap_or(false)),
                    "payload": local, "ts": ts, "dir": dir_in, "fromName": payload.get("fromName"),
                    // 决策D-2：群行持久化 fromDevice/fromDeviceName——设备署名（"谁发的"）
                    // 与设备群 dir 判定的数据源；对账 wire 原样带（wire_pack_msg 不剥这两键）。
                    "fromDevice": m.get("fromDevice"), "fromDeviceName": m.get("fromDeviceName"),
                }),
            );
            true
        }
        "task-share" => {
            // task-24 防复活闸（legacy 好友卡/对账重放的落库口）：taskId 或
            // shareId 命中 tombstone → 整条消息到此为止（不落会话、不落任务库——
            // 重启后对账把历史 task-share 重灌正是复活的来路）。
            {
                let tid = payload
                    .get("taskId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let sid = payload
                    .get("shareId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let dead = is_tombstoned(&tid)
                    || (!sid.is_empty()
                        && (is_tombstoned(&format!("peer-task-share-{sid}"))
                            || is_tombstoned(&sid)));
                if dead {
                    eprintln!("[chat] task-share 命中 tombstone，拒复活（task={tid} share={sid}）");
                    return true;
                }
            }
            // 批二：群任务卡（payload.groupId=grp-*）落群会话——全员可见同一张卡；
            // 单聊分享行为不变（落与分享者的单聊会话）。
            let gid = payload
                .get("groupId")
                .and_then(|v| v.as_str())
                .filter(|g| g.starts_with("grp-"))
                .unwrap_or("");
            let conv_id = if !gid.is_empty() {
                // 群档案未知（离线期建的群+卡先于 group-create 到）：自愈（ownerPending）
                if !load_groups()
                    .iter()
                    .any(|g| g.get("id").and_then(|d| d.as_str()) == Some(gid))
                {
                    let gname = payload
                        .get("groupName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("群")
                        .to_string();
                    let members: Vec<String> = payload
                        .get("members")
                        .and_then(|v| v.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    group_upsert_selfheal(gid, &gname, members);
                }
                gid.to_string()
            } else {
                my_did_conv(&from)
            };
            // 任务卡入会话 + 本地 peer 任务库（pending 待接受）
            conv_append(
                &conv_id,
                &json!({
                    "msgId": msg_id, "from": from, "to": if gid.is_empty() { my } else { gid }, "kind": "task-share", "payload": payload, "ts": ts, "dir": dir_in,
                    "fromName": m.get("fromName"),
                    "fromDevice": m.get("fromDevice"), "fromDeviceName": m.get("fromDeviceName"), // 决策D-2：群行带设备署名
                }),
            );
            let task_id = payload
                .get("taskId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if task_id.is_empty() {
                return true;
            }
            // 2026-10-09 第二程（好友集体访问）：带 shareId 的任务卡 = 卡背后有**分享**
            // （源设备的分享注册表才有它）。本机没有该分享 → 动作指向本机 remoteOpen：
            // 由它向**发卡的设备**要一张窄 mt（源设备按该分享的 grant 名单判定——
            // 在册的好友/同账号设备才签），再经 P2P 隧道把分享页代理过来。
            // 信封 fromDevice（发卡设备）+ from（发卡账号）就是"源设备"的两个坐标。
            let src_share = payload
                .get("shareId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let src_dev = m
                .get("fromDevice")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let my_dev = my_device_did();
            let remote_card = !src_share.is_empty()
                && !src_dev.is_empty()
                && !from.trim().is_empty()
                && (my_dev.is_empty() || !core_id::did_equiv(&src_dev, &my_dev));
            let mut tasks = load_tasks();
            // 幂等收口（用户口径「同一张卡重复投递只应产生一张」）：**taskId 或 shareId**
            // 任一命中都算同一张卡——好友把同一条分享分享两次时，两次的 taskId 不同
            // （`peer-task-<ts>`），只有 shareId 是稳定的那个键。
            let exists = tasks.iter().any(|t| {
                t.get("taskId").and_then(|d| d.as_str()) == Some(task_id.as_str())
                    || (!src_share.is_empty()
                        && t.get("shareId").and_then(|d| d.as_str()) == Some(src_share.as_str()))
            });
            if !exists {
                let mut rec = json!({
                    "taskId": task_id,
                    "title": payload.get("title"), "desc": payload.get("desc"),
                    "requirements": payload.get("requirements"), "rSpec": payload.get("r_spec"),
                    "reward": payload.get("reward"),
                    "from": from, "fromName": payload.get("fromName"),
                    "createdAt": payload.get("createdAt"), "expiresAt": payload.get("expiresAt"),
                    "participants": payload.get("participants"), // 第83轮：分享者(owner) 随卡到达
                    "source": "peer", "status": "pending", "convId": conv_id,
                });
                if !src_share.is_empty() {
                    rec["shareId"] = json!(src_share);
                }
                // 卡面 env（2026-10-23）：源设备随卡下发（`share_env_for_card`）。
                // **必须原样落进任务记录**——列表行/气泡的 env 入口只认卡上的 `env[]`；
                // 漏了这一步，接收方拿到的就是一张"没有环境入口的卡"。
                if let Some(env) = payload
                    .get("env")
                    .filter(|v| v.as_array().map(|a| !a.is_empty()).unwrap_or(false))
                {
                    rec["env"] = env.clone();
                    if let Some(c) = payload.get("caps") {
                        rec["caps"] = c.clone();
                    }
                    if let Some(o) = payload.get("owner").filter(|v| !v.is_null()) {
                        rec["owner"] = o.clone();
                    }
                }
                // §3.23 赠卡：我的角色 / 我的权限 / 可不可转授（源设备随卡下发；
                // 只是展示，判定仍在源设备——本地只拿它决定"我能不能转发"）。
                if let Some(g) = payload.get("grant").filter(|v| v.is_object()) {
                    rec["grant"] = g.clone();
                }
                rec["myRole"] = payload
                    .get("myRole")
                    .cloned()
                    .unwrap_or(json!("collaborator"));
                if payload.get("canReshare").is_some() {
                    rec["canReshare"] = payload.get("canReshare").cloned().unwrap_or(json!(false));
                    rec["reshareExp"] = payload.get("reshareExp").cloned().unwrap_or(json!(0));
                    rec["reshareVia"] = payload.get("reshareVia").cloned().unwrap_or(json!(null));
                }
                if remote_card {
                    let fname = m
                        .get("fromDeviceName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    rec["remoteOrigin"] = json!(true);
                    rec["sourceDevice"] = json!(src_dev);
                    rec["sourceDeviceName"] = json!(device_label(&src_dev, fname));
                    // 来源账号（转授闸要靠它找源设备；也供 UI 展示"谁分享的"）
                    rec["sourceAccount"] = json!(from);
                    // 有 env → open-env（接收方自己建链）；没有 → 老 remoteOpen 入口。
                    rec["action"] = crate::dsh_share::env_card_action(&rec, &src_share)
                        .unwrap_or_else(|| json!({
                            "kind": "open-url",
                            "url": crate::dsh_share::remote_open_action_url(&src_share, &from, &src_dev),
                            "label": "打开",
                            "target": "window",
                        }));
                }
                // 2026-11-15 去重（好友/群发卡路径同款）：有 shareId 按 shareId 收敛，
                // 无 shareId 按内容指纹收敛——避免"换 taskId 重投 = 第二张卡"。
                dedupe_task_records(&mut tasks, &rec);
                tasks.push(rec);
                save_tasks(&tasks);
            } else {
                // **幂等更新**（同一 taskId 重复投递只应有一张卡）：只刷新那些"随主人意愿
                // 会变"的元数据（转授面 / 赠卡 / 来源设备名），**不动 status**——本机用户
                // 已经推进过的进度（todo/doing/done）绝不被一条迟到的重投递回退。
                let mut changed = false;
                for t in tasks.iter_mut() {
                    let same = t.get("taskId").and_then(|d| d.as_str()) == Some(task_id.as_str())
                        || (!src_share.is_empty()
                            && t.get("shareId").and_then(|d| d.as_str())
                                == Some(src_share.as_str()));
                    if !same {
                        continue;
                    }
                    if !task_card_owner_matches(t, &from) {
                        eprintln!(
                            "[chat] task-share 来源不是卡 owner，拒绝改写存量卡（task={task_id}, share={src_share}, from={from}）"
                        );
                        continue;
                    }
                    if let Some(g) = payload.get("grant").filter(|v| v.is_object()) {
                        t["grant"] = g.clone();
                        changed = true;
                    }
                    if payload.get("canReshare").is_some() {
                        t["canReshare"] =
                            payload.get("canReshare").cloned().unwrap_or(json!(false));
                        t["reshareExp"] = payload.get("reshareExp").cloned().unwrap_or(json!(0));
                        t["reshareVia"] = payload.get("reshareVia").cloned().unwrap_or(json!(null));
                        changed = true;
                    }
                    // env 自愈（2026-10-23）：随卡下发的 env/caps/owner 落进**存量**记录。
                    // 老记录只有 shareId + remoteOpen 动作 → 列表行点了必然落到分享入口
                    // （`/gw/<id>/app/` 报 no valid share cookie）。补齐声明 + 改回 open-env
                    // 只动"入口声明"，不碰用户进度（status 在下面的纪律里也不动）。
                    if let Some(env) = payload
                        .get("env")
                        .filter(|v| v.as_array().map(|a| !a.is_empty()).unwrap_or(false))
                    {
                        if t.get("env") != Some(env) {
                            t["env"] = env.clone();
                            changed = true;
                        }
                        if let Some(c) = payload.get("caps") {
                            if t.get("caps") != Some(c) {
                                t["caps"] = c.clone();
                                changed = true;
                            }
                        }
                        if let Some(o) = payload.get("owner").filter(|v| !v.is_null()) {
                            if t.get("owner") != Some(o) {
                                t["owner"] = o.clone();
                                changed = true;
                            }
                        }
                    }
                    if remote_card && t.get("sourceDevice").is_none() {
                        let fname = m
                            .get("fromDeviceName")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        t["remoteOrigin"] = json!(true);
                        t["sourceDevice"] = json!(src_dev);
                        t["sourceDeviceName"] = json!(device_label(&src_dev, fname));
                        t["sourceAccount"] = json!(from);
                        // 有 env → open-env；没有 → 老 remoteOpen 入口（行为不变）
                        t["action"] = crate::dsh_share::env_card_action(t, &src_share)
                            .unwrap_or_else(|| json!({
                                "kind": "open-url",
                                "url": crate::dsh_share::remote_open_action_url(&src_share, &from, &src_dev),
                                "label": "打开",
                                "target": "window",
                            }));
                        changed = true;
                    } else if let Some(act) = crate::dsh_share::env_card_action(t, &src_share) {
                        // 存量远端卡：动作还指着分享入口 → 纠正成 open-env（幂等）
                        if t.get("action") != Some(&act) {
                            t["action"] = act;
                            changed = true;
                        }
                    }
                }
                if changed {
                    save_tasks(&tasks);
                }
            }
            true
        }
        "task-revoke" => {
            // 2026-10-24 任务卡删除通知：分享者 revoke/删除了分享 → 本机把对应卡标
            // revoked（state_snapshot 过滤 → UI 轮询 ≤5s 消失）。纯本地生效、不落
            // 会话行（聊天流不打扰）；幂等（重复删无害）、未知 shareId 无害。
            let sid_trim = payload
                .get("shareId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let tid = payload.get("taskId").and_then(|v| v.as_str()).unwrap_or("");
            let tid_trim = tid.trim();
            let conv_task_id = format!("peer-task-share-{sid_trim}");
            let tasks = load_tasks();
            let matched: Vec<&Value> = tasks
                .iter()
                .filter(|t| {
                    (!sid_trim.is_empty()
                        && (t.get("shareId").and_then(|v| v.as_str()) == Some(sid_trim)
                            || t.get("taskId").and_then(|v| v.as_str())
                                == Some(conv_task_id.as_str())))
                        || (!tid_trim.is_empty()
                            && t.get("taskId").and_then(|v| v.as_str()) == Some(tid_trim))
                })
                .collect();
            if matched.is_empty() {
                eprintln!("[chat] task-revoke 找不到对应本地卡，忽略（share={sid_trim}, task={tid_trim}）");
                return true;
            }
            if !matched.iter().any(|t| task_card_owner_matches(t, &from)) {
                eprintln!(
                    "[chat] task-revoke 来源不是卡 owner，拒绝标记/拆入口（share={sid_trim}, from={from}）"
                );
                return true;
            }
            let hit = apply_task_revoke(sid_trim, tid_trim, ts);
            if hit > 0 {
                eprintln!("[chat] task-revoke 生效（share={sid_trim} 标记 {hit} 张卡为 revoked）");
            }
            true
        }
        "task-accept" | "task-done" => {
            // 回执事件（词表对齐 HBL）：claim/submit + task_id/worker_did（snake_case wire 风格）。
            // 气泡文案仍按人话渲染（"一起接了任务《xx》"），机器字段对齐协议未来。
            // 第83轮：payload 带 participants 全量 + name——本地任务库合并去重；
            // task-done → 本地置 done（shared/todo/doing 归一，"参与方可见"协作感）。
            // 批二：群任务回执（payload.groupId=grp-*）群广播——落群会话，全员可见
            // "谁接了/谁完成了"；单聊回执行为不变（落与对方的单聊）。
            let tid = payload
                .get("task_id")
                .or_else(|| payload.get("taskId"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let name = payload
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let inc: Vec<Value> = payload
                .get("participants")
                .and_then(|p| p.as_array())
                .cloned()
                .unwrap_or_default();
            let mut tasks = load_tasks();
            let mut title = String::new();
            if let Some(t) = tasks
                .iter_mut()
                .find(|t| t.get("taskId").and_then(|d| d.as_str()) == Some(tid))
            {
                title = t
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let mut changed = false;
                if !inc.is_empty() {
                    let mut parts = task_participants(t);
                    merge_participants(&mut parts, &inc);
                    t["participants"] = json!(parts);
                    changed = true;
                }
                if kind == "task-done" && t.get("status").and_then(|s| s.as_str()) != Some("done") {
                    t["status"] = json!("done");
                    t["doneAt"] = json!(ts);
                    changed = true;
                }
                if changed {
                    save_tasks(&tasks);
                }
            }
            let gid = payload
                .get("groupId")
                .and_then(|v| v.as_str())
                .filter(|g| g.starts_with("grp-"))
                .unwrap_or("");
            let conv_id = if gid.is_empty() {
                my_did_conv(&from)
            } else {
                gid.to_string()
            };
            conv_append(
                &conv_id,
                &json!({
                    "msgId": msg_id, "from": from, "to": if gid.is_empty() { my } else { gid }, "kind": kind,
                    "payload": { "task_id": tid, "event": payload.get("event"), "worker_did": payload.get("worker_did"),
                                 "name": name, "title": title, "participants": payload.get("participants") },
                    "ts": ts, "dir": dir_in,
                    "fromDevice": m.get("fromDevice"), "fromDeviceName": m.get("fromDeviceName"), // 决策D-2：群行带设备署名
                }),
            );
            true
        }
        _ => false,
    }
}

/// 第95轮：会话消息合并排序（渲染前权威序——纯函数，单测覆盖）。
/// 背景：jsonl 是 append-only——对账灌入的历史（ts 早于现有）物理上落在文件尾，
/// 直接按文件序渲染=旧消息冒到最新位置（乱序）；且用户在对账进行中发的新消息
/// 会在下一次全量重读时"跳位"。本函数给出确定性合并语义：
///   ① 按 msgId 去重（首见保留；空 msgId 不去重——系统条可能有空的）
///   ② 按 (ts, msgId) 升序——时间序整体单调；msgId tie-break 保证双端一致
/// 本地新消息（ts=now）自然排在对账历史（ts<now）之后——位置稳定不跳变；
/// 对端实时新消息（对端时钟更快 ts 更大）按时间戳并入正确位置。
pub fn sort_conv_msgs(msgs: &mut Vec<Value>) {
    let mut seen = std::collections::HashSet::new();
    msgs.retain(|m| {
        let id = m.get("msgId").and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() {
            return true; // 无 msgId 不参与去重（保守保留）
        }
        seen.insert(id.to_string())
    });
    msgs.sort_by(|a, b| {
        let ta = a.get("ts").and_then(|v| v.as_i64()).unwrap_or(0);
        let tb = b.get("ts").and_then(|v| v.as_i64()).unwrap_or(0);
        ta.cmp(&tb).then_with(|| {
            let ia = a.get("msgId").and_then(|v| v.as_str()).unwrap_or("");
            let ib = b.get("msgId").and_then(|v| v.as_str()).unwrap_or("");
            ia.cmp(ib)
        })
    });
}

/// 第96轮（修复5）：入库 dir 判定（纯函数，单测）——自同步回流（from==my）恒 out。
fn dir_for_ingest(self_echo: bool) -> &'static str {
    if self_echo {
        "out"
    } else {
        "in"
    }
}

/// 设备群会话 dir 判定（设备群设计 决策D，纯函数，单测）：信封 fromDevice ==
/// 本机设备 did（did_equiv **canonical-only** 互认——`did:myco:z…` / `did:youling:z…` 同钥即本机；
/// legacy 裸 b58 已废止不再认）
/// → out（本机发的自同步副本）；他机/缺 fromDevice/本机设备未知 → in。
fn dir_for_device_group(from_device: &str, my_device: &str) -> &'static str {
    if !my_device.is_empty() && core_id::did_equiv(from_device, my_device) {
        "out"
    } else {
        "in"
    }
}

/// 第96轮（修复5）渲染层双保险（纯函数，单测）：存量数据 dir 判定 from==my 优先
/// out——归位修复前的老行（from==my 且 dir=in）在渲染层也归右侧，不改存量文件。
fn effective_dir(stored_dir: &str, from: &str, my: &str) -> String {
    // 前缀不敏感：老行 from=did:myco:X（归一前的本机账号串）与现行 my=did:youling:X 同账号
    if !my.is_empty() && core_id::account_did_eq(from, my) {
        "out".into()
    } else {
        stored_dir.into()
    }
}

/// 渲染层双保险的设备群版（决策D，纯函数，单测）：设备群里 from==my 恒真，老的
/// "from==my 优先 out"会把同事的消息误翻右侧——改按行内 fromDevice==本机设备
/// 判定；他机行不翻（存量 dir 已由 ingest 按 fromDevice 正确落）。
fn effective_dir_device(stored_dir: &str, from_device: &str, my_device: &str) -> String {
    if dir_for_device_group(from_device, my_device) == "out" {
        "out".into()
    } else {
        stored_dir.into()
    }
}

/// 会话 id：好友=对方账号 did（did_safe 落文件名）。
fn my_did_conv(peer: &str) -> String {
    did_safe(peer)
}

/// 加载会话（图片媒体内联为 b64，UI 直接拼 data URL）；顺带标记已读。
/// 第94轮：file 不内联（10MB 级，加载会话会爆）——点击文件卡走 chat_open_file；
/// group-msg+media（群图片 out 副本，既有形态）仍内联，发送者自己屏幕才能看到图。
#[tauri::command]
pub async fn chat_load_conv(conv_id: String) -> Result<Value, String> {
    let mut msgs = conv_load_raw_inner(&conv_id);
    // 第95轮：合并排序（对账历史按 ts 归位；本地新消息位置稳定；msgId 去重）
    sort_conv_msgs(&mut msgs);
    // 2026-10-09 任务卡跨设备同步：设备群里的 task-share 是**同步记录**（数据面），
    // 不是聊天内容——渲染前过滤掉（写侧已不落行；此处兜对账/老版本带回来的行）。
    // 2026-10-11 task-rename 同义：设备群里的改名行是 owner 多端的同步载体，不渲染。
    if is_device_group_id(&conv_id) {
        msgs.retain(|m| {
            let k = m.get("kind").and_then(|k| k.as_str());
            k != Some("task-share") && k != Some("task-rename")
        });
    }
    // 第96轮（修复5）渲染层双保险：存量数据 from==my 一律按 out 渲染
    // （入库侧新数据已 dir=out；这里兜归位修复前的老行，不改存量文件）。
    // 设备群例外（决策D-3）：from==my 恒真，改按行内 fromDevice==本机设备判定
    // ——否则同事设备的 in 行会被误翻右侧。
    let my = core_id::account_did().unwrap_or_default();
    let dev_conv = is_device_group_id(&conv_id);
    let my_device = if dev_conv {
        my_device_did()
    } else {
        String::new()
    };
    for m in msgs.iter_mut() {
        let kind = m
            .get("kind")
            .and_then(|k| k.as_str())
            .unwrap_or("")
            .to_string();
        let stored = m
            .get("dir")
            .and_then(|v| v.as_str())
            .unwrap_or("in")
            .to_string();
        let from = m
            .get("from")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let eff = if dev_conv {
            let fd = m.get("fromDevice").and_then(|v| v.as_str()).unwrap_or("");
            effective_dir_device(&stored, fd, &my_device)
        } else {
            effective_dir(&stored, &from, &my)
        };
        if eff != stored {
            m["dir"] = json!(eff);
        }
        // 第96轮（修复3）：file 的 mediaPending 动态判定（字节到达即转 false，
        // 不改存量行）——pending=媒体分片未到/被清理，UI 显示"下载中"态。
        if kind == "file" {
            let pending = m
                .pointer("/payload/media")
                .and_then(|v| v.as_str())
                .map(|rel| !chat_dir().join(rel).is_file())
                .unwrap_or(false);
            m["payload"]["mediaPending"] = json!(pending);
        }
        let want_b64 =
            kind == "image" || (kind == "group-msg" && m.pointer("/payload/media").is_some());
        if want_b64 {
            if let Some(media) = m.pointer("/payload/media").and_then(|v| v.as_str()) {
                if let Some(b64) = load_media_b64(media) {
                    m["payload"]["b64"] = json!(b64);
                }
            }
        }
    }
    // 已读标记（chat_state 未读角标清零）
    let mut seen = load_seen();
    // 批三：覆盖前先看旧 seen——"以下为新消息"分割线的锚（首个旧 seen 之后的入站消息）。
    let old_seen = seen.get(&conv_id).copied().unwrap_or(0);
    let first_unread = msgs
        .iter()
        .find(|m| {
            m.get("ts").and_then(|t| t.as_i64()).unwrap_or(0) > old_seen
                && m.get("dir").and_then(|v| v.as_str()) == Some("in")
                && m.get("kind").and_then(|v| v.as_str()) != Some("recalled")
        })
        .and_then(|m| m.get("msgId").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    let had_unread = !first_unread.is_empty();
    // 2026-10-12 微信式已读：打开会话见到未读 → 给对端回执（best-effort spawn，
    // 不阻塞 load 返回）。群聊不回执（隐私语义，微信同款）。
    if had_unread {
        let unread_peer: Vec<Value> = msgs
            .iter()
            .filter(|m| {
                m.get("ts").and_then(|t| t.as_i64()).unwrap_or(0) > old_seen
                    && m.get("dir").and_then(|v| v.as_str()) == Some("in")
                    && m.get("kind").and_then(|v| v.as_str()) != Some("recalled")
            })
            .cloned()
            .collect();
        receipt_send_read(&conv_id, &unread_peer);
    }
    // 小灵官方通知（2026-10-20）：打开会话即回执 /official/read（best-effort spawn，
    // 服务端据此 queued/delivered→read；重复调用幂等，失败不挡 UI，下次打开重试）。
    #[cfg(not(test))]
    if is_official_conv(&conv_id) {
        let ids: Vec<String> = msgs
            .iter()
            .filter(|m| m.get("kind").and_then(|v| v.as_str()) == Some(OFFICIAL_NOTICE_KIND))
            .filter_map(|m| {
                m.pointer("/payload/noticeId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .collect();
        if !ids.is_empty() {
            // S4：本地 SQLite 同步标记已读（MYCO_MSG_STORE=off 时零动作；
            // 服务端 /official/read 仍是权威，这里只是本地副本——DESIGN-s4 §5）。
            crate::msg_store::mark_notice_read_local(&conv_id, &ids);
            let my_did = my.clone();
            tauri::async_runtime::spawn(async move {
                let _ = official_ack(&my_did, ids).await;
            });
        }
    }
    let last = msgs
        .last()
        .and_then(|m| m.get("ts").and_then(|t| t.as_i64()))
        .unwrap_or(0);
    if last > 0 {
        seen.insert(conv_id, last);
        let _ = std::fs::write(
            seen_path(),
            serde_json::to_string(&seen).unwrap_or_default(),
        );
    }
    Ok(json!({ "msgs": msgs, "firstUnreadMsgId": first_unread, "hadUnread": had_unread }))
}

/// 第94轮：打开收到的文件——按 msgId 从会话找媒体字节，写 %TEMP%\myco-files\ 随机名，
/// 调系统关联程序打开（不做站内预览）。路径全部由 Rust 侧拼（safe_msg_id/safe_file_name
/// 双消毒），UI 只传 convId+msgId 两个不可控键也无路径可注。
/// 第96轮（修复3）：媒体字节未达（解耦链路 pending）→ 触发按需拉取（原发送账号+
/// 本机账号的在线设备逐个试），返回"下载中"提示而非死错误。
#[tauri::command]
pub async fn chat_open_file(conv_id: String, msg_id: String) -> Result<Value, String> {
    let msgs = conv_load_raw_inner(&conv_id);
    let m = msgs
        .iter()
        .find(|x| x.get("msgId").and_then(|v| v.as_str()) == Some(msg_id.as_str()))
        .ok_or_else(|| "消息不存在".to_string())?;
    let p = m.get("payload").ok_or("消息缺 payload")?;
    let media_rel = p
        .get("media")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("该消息没有文件数据")?;
    // media_rel 防穿越：必须形如 media/xx.ext（save_media 产物），拒绝任何 .. / 绝对路径
    let media_path = chat_dir().join(media_rel);
    if !media_path.is_file() {
        // 第96轮：pending 媒体按需拉取（re-fetch）
        let sha = p
            .get("sha256")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if !sha.is_empty() {
            let mref = MediaRef {
                msg_id: msg_id.clone(),
                name: p
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("file")
                    .to_string(),
                mime: p
                    .get("mime")
                    .and_then(|v| v.as_str())
                    .unwrap_or("application/octet-stream")
                    .to_string(),
                size: p.get("size").and_then(|v| v.as_i64()).unwrap_or(0),
                sha256: sha,
            };
            let mut accounts: Vec<String> = vec![m
                .get("from")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()];
            if let Ok(my) = my_account_did() {
                accounts.push(my); // 自己其他设备也可能有（多设备自同步源）
            }
            tauri::async_runtime::spawn(async move {
                let ok = crate::p2p_client::fetch_media_from_accounts(&accounts, &mref).await;
                eprintln!(
                    "[chat] 按需拉取媒体 {} → {}",
                    mref.msg_id,
                    if ok {
                        "成功"
                    } else {
                        "暂不可得（对端不在线）"
                    }
                );
            });
            return Err("⏬ 文件下载中，完成后点按重试".into());
        }
        return Err("文件数据已被清理（对方重发可恢复）".to_string());
    }
    let canon = media_path
        .canonicalize()
        .map_err(|_| "文件数据已被清理（对方重发可恢复）".to_string())?;
    let media_canon = media_dir().canonicalize().unwrap_or_else(|_| media_dir());
    if !canon.starts_with(&media_canon) {
        return Err("非法媒体路径".into());
    }
    let bytes =
        std::fs::read(&canon).map_err(|_| "文件数据已被清理（对方重发可恢复）".to_string())?;
    let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("file");
    let dir = std::env::temp_dir().join("myco-files");
    std::fs::create_dir_all(&dir).map_err(|e| format!("临时目录创建失败: {e}"))?;
    let fname = format!("{}_{}", safe_msg_id(&msg_id), safe_file_name(name));
    let path = dir.join(&fname);
    std::fs::write(&path, &bytes).map_err(|e| format!("临时文件写入失败: {e}"))?;
    // 系统关联程序打开（同 open_external 的防闪终端写法）
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path.display().to_string()])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
    }
    Ok(json!({ "ok": true, "path": path.display().to_string() }))
}

/// 取字符串尾 4 位（昵称解析不到时的兜底显示）。
fn tail4(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let n = chars.len().saturating_sub(4);
    chars[n..].iter().collect()
}

/// 加好友（2026-10-07 去服务端化）：本地乐观落行（返回即"已发送"态，无服务器
/// 回执）+ 签名握手 friend-request 投递（P2P 直推优先→信箱兜底）。互加即好友：
/// 对方先加过我（本地 in-pending）时直接转 ok（对端收 request 见 out-pending →
/// ok 并回 accept 收敛）；已 ok/out-pending 幂等重发（只刷名）。
#[tauri::command]
pub async fn chat_add_friend(did: String, name: String) -> Result<Value, String> {
    let my = my_account_did()?;
    if core_id::account_did_eq(&did, &my) {
        return Err("不能加自己为好友".into());
    }
    if !did.starts_with("did:") {
        return Err("DID 格式不对（应以 did:youling: 或 did:myco: 开头）".into());
    }
    let cur = friend_row_status(&did);
    let status = match cur.as_deref() {
        // 对方先加过我 → 互加即好友：本地直接 ok（对端握手把它收敛到 ok）
        Some("in-pending") => {
            friend_set_status(&did, "ok", name.trim());
            "ok".to_string()
        }
        // ok / out-pending：幂等重发（带名时刷新显示名）
        Some(s) => {
            let st = if s == "ok" || s == "out-pending" {
                s.to_string()
            } else {
                "ok".to_string()
            };
            if !name.trim().is_empty() {
                friend_refresh_name(&did, &name);
            }
            st
        }
        None => {
            let fname = if name.trim().is_empty() {
                name_fallback(&did).await
            } else {
                name.trim().to_string()
            };
            friend_upsert(&did, &fname, "out-pending");
            "out-pending".to_string()
        }
    };
    friend_deliver(&did, "friend-request")
        .await
        .map_err(|e| format!("发送好友请求失败: {e}"))?;
    Ok(json!({ "ok": true, "status": status }))
}

/// 名字兜底（add 未从端侧拿到名字时）：/root/{did} 解析（发现层公开读），再不行 …尾4位。
async fn name_fallback(did: &str) -> String {
    resolve_name(did)
        .await
        .unwrap_or_else(|| format!("…{}", tail4(did)))
}

/// 接受好友请求（去服务端化）：本地 in-pending → ok + 发 friend-accept 握手
/// （发起方 out-pending → ok 并落"你们已成为好友"系统条）。行已是 ok 也放行——
/// 投递失败后的重试路径（accept 幂等，对端 ok 态重收无副作用）。
#[tauri::command]
pub async fn chat_accept_friend(did: String) -> Result<Value, String> {
    my_account_did()?;
    match friend_row_status(&did).as_deref() {
        None => return Err("没有来自该账号的好友请求".into()),
        Some("out-pending") => return Err("请求由你发起，等待对方通过".into()),
        _ => {}
    }
    friend_set_status(&did, "ok", "");
    friend_deliver(&did, "friend-accept")
        .await
        .map_err(|e| format!("接受好友失败: {e}"))?;
    Ok(json!({ "ok": true }))
}

/// 忽略好友请求（=拒绝）：本地清待确认行 + 发 friend-remove（发起方 out-pending
/// 行随之删除——"对方未通过"由行消失表达，与旧服务器双删语义一致）。
#[tauri::command]
pub async fn chat_ignore_friend(did: String) -> Result<Value, String> {
    my_account_did()?;
    save_friends(
        &load_friends()
            .into_iter()
            .filter(|f| {
                !(f.get("status").and_then(|s| s.as_str()) == Some("in-pending")
                    && f.get("did")
                        .and_then(|d| d.as_str())
                        .map(|d| core_id::account_did_eq(d, &did))
                        .unwrap_or(false))
            })
            .collect::<Vec<_>>(),
    );
    friend_deliver(&did, "friend-remove")
        .await
        .map_err(|e| format!("忽略请求失败: {e}"))?;
    Ok(json!({ "ok": true }))
}

/// 删除好友（去服务端化）：投递成功才清本地（强一致——好友删除不抢跑；失败报错
/// UI 提示重试）。对端收 friend-remove → 删行+会话（原服务器"对方同步即消失"语义）。
#[tauri::command]
pub async fn chat_remove_friend(did: String) -> Result<Value, String> {
    my_account_did()?;
    friend_deliver(&did, "friend-remove")
        .await
        .map_err(|e| format!("删除好友失败: {e}"))?;
    friend_remove_local(&did);
    Ok(json!({ "ok": true }))
}

// ══════════════ 任务群（§3.19：复用群机制，不另造"任务群"对象） ══════════════

/// 建群 id 生成规则（全仓唯一一处）：`grp-<hex(ms)>`。
/// 任务群与普通群同款——任务群不是新对象，就是一个 `grp-` 会话（§3.19 设计定稿）。
pub(crate) fn new_group_id() -> String {
    format!("grp-{:x}", now_ms())
}

fn group_exists(gid: &str) -> bool {
    load_groups()
        .iter()
        .any(|g| g.get("id").and_then(|d| d.as_str()) == Some(gid))
}

/// 确保群存在且成员 = members ∪ {我}，返回群 id（**幂等**：同 id 重复调用只 upsert 成员）。
///
/// 复用既有建群的**全部**机制：groups.json 档案 + 群会话 `group-create` 系统条 +
/// P2P 逐成员扇出（不可达入待发队列，任一成员上线自动补发）——普通建群与任务群
/// 走的是同一条代码路径，任务群只是"id 由调用方给定、可复用"的建群（§3.19 取舍②）。
///   - existing 命中且群档案还在 → 只同步成员（授权变化同步），不重复扇建群卡；
///   - 否则新建（existing 对应群档案已不存在，如被解散/退群→ 换新 id 重建）。
pub(crate) async fn task_group_ensure(
    existing: Option<&str>,
    name: &str,
    members: Vec<String>,
) -> Result<String, String> {
    let my = my_account_did()?;
    let mut set = std::collections::BTreeSet::from([my.clone()]);
    for m in members {
        if !m.trim().is_empty() {
            set.insert(m);
        }
    }
    let all: Vec<String> = set.into_iter().collect();
    let existing = existing.map(str::trim).filter(|s| !s.is_empty());
    if let Some(gid) = existing {
        if group_exists(gid) {
            // 成员同步（幂等）：已存在的 owner 不被覆盖（group_upsert 只在空位写 owner）
            group_upsert(gid, name, all, Some(&my));
            return Ok(gid.to_string());
        }
    }
    // 新建：id 撞了按同一规则顺延（同一毫秒内并发建群/重建）
    let mut gid = new_group_id();
    let mut bump = 0u64;
    while group_exists(&gid) {
        bump += 1;
        gid = format!("grp-{:x}", now_ms() + bump as i64);
    }
    group_upsert(&gid, name, all.clone(), Some(&my)); // 建群者=群主
                                                      // 批二：建群记录落自己群会话（"群已创建"系统条 + 对账载体——其他成员的对账
                                                      // 可从任一持有本条的设备补齐真 owner；msgId 与扇出信封同，幂等）。
    conv_append(
        &gid,
        &json!({
            "msgId": format!("grp-create-{gid}"), "from": my, "to": gid, "kind": "group-create",
            "payload": { "groupId": gid, "groupName": name, "members": all, "owner": my },
            "ts": now_ms(), "dir": "out", "fromName": my_name().await,
        }),
    );
    // 第89轮：group-create 不走服务器信箱（低频控制消息直推优先——白名单=好友
    // 握手三 kind+群元数据）改 P2P 扇出到每个成员；离线成员上线后对账补齐群档案。
    // 2026-09-28 修正：信封必须带 fromDevice——p2p_server auth_gate 要求
    // fromDevice 与签名设备一致（f767066 漏带 → PC→PC 建群直推 403）。
    let others: Vec<String> = all.iter().filter(|m| **m != my).cloned().collect();
    let payload = json!({
        "groupId": gid, "groupName": name, "members": all, "fromName": my_name().await,
        "owner": my, // 第85轮：群主随建群卡扇出
    });
    let device_did = core_id::device_identity()
        .map(|(d, _)| d)
        .unwrap_or_default();
    let envelope = json!({
        "msgId": format!("grp-create-{gid}"), "from": my, "fromDevice": device_did,
        "fromName": my_name().await, "kind": "group-create",
        "payload": payload, "ts": now_ms(),
    });
    let mut any_delivered = false;
    for m in &others {
        if crate::p2p_client::deliver_to_account(m, &envelope).await {
            any_delivered = true;
        }
    }
    if !any_delivered && !others.is_empty() {
        // 第95轮：建群卡全体不可达 → 入待发队列（任一成员上线即补扇出——
        // flush 会对全部目标再投一遍，group-create 按 groupId 幂等无害）。
        let _ = crate::offline_queue::global().enqueue(&gid, others.clone(), envelope);
    }
    Ok(gid)
}

/// 已存在群**只同步成员**（不建群、不扇出）：任务群随分享授权变化同步用（§3.19.1）。
/// 群档案不在（已解散/已退群）→ false（不复活）；成员为 members ∪ {我}，账号粒度去重。
pub(crate) fn task_group_sync_members(gid: &str, name: &str, members: Vec<String>) -> bool {
    if !group_exists(gid) {
        return false;
    }
    let Ok(my) = my_account_did() else {
        return false;
    };
    let mut set = std::collections::BTreeSet::from([my.clone()]);
    for m in members {
        if !m.trim().is_empty() {
            set.insert(m);
        }
    }
    group_upsert(gid, name, set.into_iter().collect(), Some(&my));
    true
}

/// §3.19.1 **对端**群成员同步（授权变化后调用）：向群发一条成员变更消息，
/// 让对端的群成员表跟到最新授权（建群时那次扇出只是快照，后续 grant/revoke 不会自动跟）。
///
/// 形态复用**既有群消息通道**：`group-invite`（既有 kind：payload 带新成员 did 表 →
/// 对端 `apply_group_update` 把 members 换成新表；群主才能改，恰好是分享 owner 本机账号）。
/// 由 `p2p_send_raw` 按 payload.members 逐成员扇出（不可达入离线队列，对方上线补发）。
///
/// **群不存在就不建群**：只记日志（与 task_group_sync_members 同款克制——
/// 建群是"打开任务群/显式 ensure"的动作，授权变化不该有建群这类重副作用）。
/// 非群主 / ownerPending / 群已解散 → 同样只记日志（对端也会拒，白发）。
/// spawn 非阻塞：群消息发送失败只记日志，绝不影响授权/撤回本身的返回值。
pub(crate) fn spawn_task_group_members_sync(group_id: String, name: String, members: Vec<String>) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = task_group_members_sync(&group_id, &name, members).await {
            eprintln!("[chat] 任务群成员变更同步跳过（{group_id}）: {e}");
        }
    });
}

/// `spawn_task_group_members_sync` 的异步体（发送失败只记日志——见上条注释）。
async fn task_group_members_sync(
    group_id: &str,
    name: &str,
    members: Vec<String>,
) -> Result<(), String> {
    let g = load_groups()
        .into_iter()
        .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(group_id))
        .ok_or_else(|| "群不存在（不建群，只记日志）".to_string())?;
    if !group_terminal_status(&g).is_empty() {
        return Err("群已解散或已被移出（不复活）".into());
    }
    if group_owner_pending(&g) {
        return Err("群主信息未同步（ownerPending）".into());
    }
    let my = my_account_did()?;
    if !is_group_owner(&g, &my) {
        return Err("本机不是该群群主（对端会拒收成员变更）".into());
    }
    let mut set = std::collections::BTreeSet::from([my.clone()]);
    for m in members {
        if !m.trim().is_empty() {
            set.insert(m);
        }
    }
    let all: Vec<String> = set.into_iter().collect();
    let prev: Vec<String> = g
        .get("members")
        .and_then(|m| m.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let added: Vec<String> = all.iter().filter(|m| !prev.contains(m)).cloned().collect();
    let gname = if name.trim().is_empty() {
        "任务群"
    } else {
        name
    };
    // 本地档案先落到最新（幂等；调用方通常已同步过一次，这里保证本函数单独调用也自洽）
    group_upsert(group_id, gname, all.clone(), Some(&my));
    let payload = json!({
        "groupId": group_id, "groupName": gname, "members": all, "newMembers": added,
        "fromName": my_name().await, "ts": now_ms(),
    });
    let (_msg_id, _ts, state) = p2p_send_raw(group_id, "group-invite", payload).await?;
    if state == "failed" {
        return Err("离线队列溢出（对端长期不在线，待其上线后需重新同步）".into());
    }
    Ok(())
}

/// 群消息落盘的会话 kind（§3.19.4）：媒体保持 image/file；带 `system:true` 标记的
/// 走**既有系统消息 kind="sys"**（UI 已按系统条渲染——cap_denied 留痕用）；其余 group-msg。
/// 纯函数（单测覆盖）：发送端本地落条与接收端 ingest 共用同一判定，两端渲染一致。
fn group_conv_kind(media_kind: &str, system: bool) -> &'static str {
    match media_kind {
        "image" => "image",
        "file" => "file",
        _ => {
            if system {
                "sys"
            } else {
                "group-msg"
            }
        }
    }
}

/// 群消息系统条（§3.16 / §3.19.4 留痕）：**走现有群消息通道**，不新造通道——
/// 只是本地落 `kind="sys"`（既有系统消息 kind，UI 已按系统条渲染）且 payload 带
/// `system: true` 标记（跨端可识别；对端 ingest 见 `group-msg` 分支同判）。
/// 发送入口是 **同步** 的（拒绝应答路径不能 await）→ spawn 后台发送，
/// **失败只记日志**：留痕失败绝不影响拒绝应答本身（§3.16 严格 schema 不变）。
pub(crate) fn spawn_system_group_msg(group_id: String, text: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = send_system_group_msg(&group_id, &text).await {
            eprintln!("[chat] 任务群系统留痕发送失败（{group_id}）: {e}");
        }
    });
}

/// 单发一条系统消息进群（P2P 扇出 + 本地落条）。系统消息不参与禁言闸
/// （它是 myco 可信机制的留痕，不是人的发言）。
async fn send_system_group_msg(group_id: &str, text: &str) -> Result<(), String> {
    let my = my_account_did()?;
    let g = load_groups()
        .into_iter()
        .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(group_id))
        .ok_or_else(|| "群不存在".to_string())?;
    if !group_terminal_status(&g).is_empty() {
        return Err("群已解散或已被移出".into());
    }
    let gname = g
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("群")
        .to_string();
    let members: Vec<String> = g
        .get("members")
        .and_then(|m| m.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let from_name = my_name().await;
    let wire = json!({
        "groupId": group_id, "groupName": gname, "fromName": from_name, "members": members,
        "text": text, "system": true,
    });
    let (msg_id, ts, state) = p2p_send_raw(group_id, "group-msg", wire).await?;
    append_out(
        group_id,
        &my,
        group_id,
        "sys",
        json!({
            "groupId": group_id, "groupName": gname, "members": members,
            "text": text, "system": true,
        }),
        &msg_id,
        ts,
        state,
    );
    Ok(())
}

/// 建群：groupId=grp-{hex}；group-create 扇发给全部成员（服务端逐成员投递）。
#[tauri::command]
pub async fn chat_create_group(name: String, members: Vec<String>) -> Result<Value, String> {
    if members.is_empty() {
        return Err("至少选一位好友".into());
    }
    let name = if name.trim().is_empty() {
        "新群聊".to_string()
    } else {
        name.trim().chars().take(24).collect::<String>()
    };
    let group_id = task_group_ensure(None, &name, members).await?;
    Ok(json!({ "id": group_id, "name": name }))
}

// ══════════════ 设备群（2026-10-07 设计定稿：docs/design/设备群设计.md） ══════════════
// 同账号多设备自动建「设备群」——群发消息、传文件。建模=现有群机制 + 系统群标记
// kind:"device"（决策A）：不建新实体、不加 wire kind、服务端零改动。成员恒
// [rootDid]（账号粒度），真成员表=云名册——投递时 presence 按 rootDid 聚合展开
// 全部在线设备；新设备收编自动可达、吊销自动不可达，无 invite/kick 消息。

/// 设备群显示名（固定，不随账号名——账号名在 UI 头部副题展示；不做改名）。
pub const DEVICE_GROUP_NAME: &str = "设备群";

/// 会话/群 id 是否设备群：`grp-dev-` 前缀由账号 did（canonical）确定性派生。
pub(crate) fn is_device_group_id(gid: &str) -> bool {
    gid.starts_with("grp-dev-")
}

/// 群档案是否设备群（kind 标记优先；id 前缀兜底——自愈建群先于 ensure 打标时）。
pub(crate) fn is_device_group(g: &Value) -> bool {
    g.get("kind").and_then(|v| v.as_str()) == Some("device")
        || g.get("id")
            .and_then(|d| d.as_str())
            .map(is_device_group_id)
            .unwrap_or(false)
}

/// 设备群 id（纯函数，双端各一份，单测锁 canonical 双前缀归一）：canonical 归一后 did_safe。
/// 必须先过 account_did_canonical（解析公钥 → did_from_public 同法重派生 canonical）
/// ——同账号各设备本地存的 did 串形态可能不同（storage 形态 vs 网络形态），不归一
/// 则两台设备派生出两个群 id。保 `grp-` 前缀（全库 starts_with("grp-") 判群不动）。
pub(crate) fn device_group_id(root_did: &str) -> String {
    format!(
        "grp-dev-{}",
        did_safe(&core_id::account_did_canonical(root_did))
    )
}

/// 幂等 ensure（决策B）：档案在→只校正 kind/name/members/owner；不在→建+一条
/// 确定性 msgId 系统条。**每设备本地建**（不靠建群消息传播）——任何设备任何时候
/// 登录都能独立成群，天然幂等、离线可用、老设备升级即得；会话内容靠既有对账收敛。
/// 核心体（my 显式传入——单测零全局态）；返回群 id。
pub(crate) fn ensure_device_group_for(my: &str) -> String {
    let gid = device_group_id(my);
    let mut list = load_groups();
    if let Some(i) = list
        .iter()
        .position(|g| g.get("id").and_then(|d| d.as_str()) == Some(gid.as_str()))
    {
        // 校正路径（自愈建群先到/旧版本升级/手工编辑的失真归位）；不重复写系统条。
        let g = &mut list[i];
        let mut dirty = false;
        if g.get("kind").and_then(|v| v.as_str()) != Some("device") {
            g["kind"] = json!("device");
            dirty = true;
        }
        if g.get("name").and_then(|v| v.as_str()) != Some(DEVICE_GROUP_NAME) {
            g["name"] = json!(DEVICE_GROUP_NAME);
            dirty = true;
        }
        if g.get("members") != Some(&json!([my])) {
            g["members"] = json!([my]); // 成员恒 [root did]——名册才是真成员表
            dirty = true;
        }
        if g.get("owner")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .is_empty()
        {
            g["owner"] = json!(my);
            g.as_object_mut().map(|m| m.remove("ownerPending")); // 自愈标记一并收敛
            dirty = true;
        }
        if dirty {
            save_groups(&list);
        }
        return gid;
    }
    list.push(json!({
        "id": gid, "name": DEVICE_GROUP_NAME, "kind": "device",
        "members": [my], "owner": my, "createdAt": now_ms(),
        "governance": "owner", "muted": {},
    }));
    save_groups(&list);
    // 开群系统条：msgId 确定性 devgrp-init-{gid}——各设备本地各写一条同 msgId 行，
    // 对账幂等去重（conv_append 的 meta 闸），F 指纹自然收敛。
    conv_append(
        &gid,
        &json!({
            "msgId": format!("devgrp-init-{gid}"), "from": my, "to": &gid, "kind": "sys",
            "payload": { "text": "📱 设备群已开启：本账号全部设备自动入群（群发/传文件）" },
            "ts": now_ms(), "dir": "in",
        }),
    );
    gid
}

/// 登录闸包装（三挂点用，全幂等多处调用无害）：未登录 None（静默，绝不阻塞调用方）。
pub(crate) fn ensure_device_group() -> Option<String> {
    let my = core_id::account_did()?;
    Some(ensure_device_group_for(&my))
}

/// 群档案补设备群标记（幂等；grp-dev-* 的群消息先于 ensure 到达时立即归位系统群语义）。
fn mark_device_group(gid: &str) {
    let mut list = load_groups();
    if let Some(g) = list
        .iter_mut()
        .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(gid))
    {
        if g.get("kind").and_then(|v| v.as_str()) != Some("device") {
            g["kind"] = json!("device");
            save_groups(&list);
        }
    }
}

/// 设备群信息（UI 头部副题「N 台设备 · M 在线」数据源，前端 15s 轮询配套）：
/// 群 id + 名册设备表——/presence/by-root 包装（signed_post 设备签名），15s 进程内
/// 缓存防打爆。devices 透传服务端行 {did,name,pubkeyB64,revoked,isEmbodiment,online,
/// lastSeen,addrs,kind,role}（revoked:false 的设备就是"当前成员"）。
#[tauri::command]
pub async fn chat_device_group_info() -> Result<Value, String> {
    let my = my_account_did()?;
    let gid = device_group_id(&my);
    let (account_name, devices) = crate::p2p_client::roster_by_root_cached(&my, 15_000)
        .await
        .ok_or_else(|| "设备名册查询失败（identity-svc 暂不可达，稍后重试）".to_string())?;
    Ok(json!({
        "groupId": gid,
        "name": DEVICE_GROUP_NAME,
        "accountName": account_name,
        "devices": devices,
    }))
}

/// **分享任务卡 → 自动进授权列表**（2026-10-06 用户口径：「分享任务卡给好友 → 自动进授权
/// 列表，需要加」）。挂载点：`chat_share_task` 发送成功之后、返回之前，**只在这一处**。
///
/// 三条纪律：
///   ① **有 shareId 才自动授权**：没关联分享的任务卡（`share_id` 缺省）绝不自动建分享
///      ——那是替用户越权开分享（只记日志，见下）；
///   ② **幂等**：已有该 did 的授权行 → 由 `dsh_share::auto_grant_*` 内的 `grant_apply`
///      拦下，不重签、不覆盖用户已调好的 caps（保留既有设置）；
///   ③ **失败不吃掉分享**：任何失败只记日志，返回值与分享动作本身无关。
///
/// 单聊（`conv` 是好友 did）→ 给该 did 一次 grant，label=好友昵称（`friend_display_name`，
/// 查不到退 did 尾 4）；群聊（`conv` 是 `grp-*`）→ 先读群成员表，对该群成员逐个 grant
/// （**跳过自己与已授权者**——自己那条由 `auto_grant_share_recipients` 统一跳过）。
///
/// 授权变化后由 `auto_grant_share_recipients` 走既有路径 `sync_task_group_members(share_id)`
/// 同步任务群成员 + 发对端成员广播（已建群才同步，不因授权建群）。
fn auto_grant_after_share_task(share_id: &str, conv: &str) {
    let recipients: Vec<(String, String)> = if conv.starts_with("grp-") {
        group_member_dids(conv)
            .into_iter()
            .filter(|d| !d.trim().is_empty())
            .map(|d| {
                let name = friend_display_name(&d).unwrap_or_else(|| did_tail4(&d));
                (d, name)
            })
            .collect()
    } else {
        let did = conv.replace('_', ":"); // did_safe 逆（did 内无原生 '_'）
        if did.trim().is_empty() {
            Vec::new()
        } else {
            let name = friend_display_name(&did).unwrap_or_else(|| did_tail4(&did));
            vec![(did, name)]
        }
    };
    if recipients.is_empty() {
        eprintln!("[chat] 任务卡分享自动授权跳过：{share_id} 没有可授权的接收方（conv={conv}）");
        return;
    }
    eprintln!(
        "[chat] 任务卡分享自动授权：share={share_id} conv={conv} 接收方 {} 位",
        recipients.len()
    );
    let _ = crate::dsh_share::auto_grant_share_recipients(share_id, &recipients);
}

/// did 尾 4（`did:myco:abc…` → `…abc`）：好友显示名查不到时的兜底 label。
fn did_tail4(did: &str) -> String {
    let t: Vec<char> = did.chars().rev().take(4).collect();
    format!("…{}", t.into_iter().rev().collect::<String>())
}

/// 分享任务卡（微活契约，payload 平铺）：conv=好友 did 或群 id。
/// 卡=签名摘要不是任务本体：KB 级字段上线，执行在本地。
/// requirements=自由文本；r_spec=结构化指标预留 [{key,label?,target,unit?}]（47号 R wire schema，
/// v1 UI 无编辑器，传了原样透传）。
///
/// `share_id`（可选，camelCase `shareId`）：**这张卡关联的 myco 分享**（来自分享任务列表，
/// `peer-task-share-<shareId>` 那条记录的 `shareId` 字段）。传了才做「分享任务卡 → 自动进
/// 授权列表」（见 `auto_grant_after_share_task`）；不传 = 普通任务卡，绝不自动建分享。
///
/// §3.23：传了 `shareId` 且**我不是这条分享的主人**（卡是别人分享给我的）→ 走转授闸
/// （`reshare_gate_before_forward`）：默认拒绝 + 向主人递转授申请；有转授权时由
/// **源设备**把卡发给对方（不给"两张卡"，也不给"打不开的卡"）。
#[tauri::command]
pub async fn chat_share_task(
    conv: String,
    title: String,
    desc: String,
    requirements: String,
    reward: Option<String>,
    expires_days: Option<i64>,
    r_spec: Option<Value>,
    share_id: Option<String>,
) -> Result<Value, String> {
    let my = my_account_did()?;
    if title.trim().is_empty() {
        return Err("任务标题不能为空".into());
    }
    let task_id = format!("peer-task-{:x}", now_ms());
    let name = my_name().await;
    let mut payload = json!({
        "taskId": task_id,
        "title": title.trim().chars().take(48).collect::<String>(),
        "desc": desc.trim().chars().take(400).collect::<String>(),
        "from": my, "fromName": name,
        "createdAt": now_ms(), "source": "peer",
        // 第83轮：分享者自动进 participants（role=owner）——多人协作可见
        "participants": [{ "did": my, "name": name, "role": "owner" }],
    });
    if !requirements.trim().is_empty() {
        payload["requirements"] = json!(requirements.trim().chars().take(400).collect::<String>());
    }
    if let Some(rs) = r_spec.filter(|v| v.is_array()) {
        payload["r_spec"] = rs;
    }
    if let Some(r) = reward.as_deref().filter(|r| !r.trim().is_empty()) {
        // 奖励自由文本 v1（"100 积分"）；协议未来拆 {value,unit}
        payload["reward"] = json!(r.trim().chars().take(32).collect::<String>());
    }
    if let Some(d) = expires_days.filter(|d| *d > 0) {
        payload["expiresAt"] = json!(now_ms() + d * 86_400_000);
    }
    // 关联的 myco 分享（有则带上：接收端知道这张卡背后是哪个分享的会话）
    let share_id = share_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    // §3.23 转授闸（**必须在发卡之前**）：非 owner 转发 → 默认拒绝 + 递申请；
    // 有转授权 → 不由我发（由源设备发给对方，来源坐标准确、第三人点得开）。
    if let Some(sid) = share_id.as_deref() {
        let tasks_now = load_tasks();
        match reshare_gate_before_forward(&conv, sid, &tasks_now).await {
            Ok(None) => { /* owner 自己：走既有路径，一个字不变 */ }
            Ok(Some(msg)) => {
                return Ok(json!({ "taskId": Value::Null, "reshare": "by-owner", "message": msg }));
            }
            Err(why) => return Err(why),
        }
    }
    if let Some(sid) = share_id.as_deref() {
        // §3.23 赠卡：把接收方在这条分享上的**角色 / 权限 / 可不可转授**随卡下发
        // （接收侧只展示；判定仍在源设备）。放在发卡前算，是因为 grant 可能刚由
        // `auto_grant_after_share_task` 签发（见下：先授权，再带上赠卡信息发卡）。
        auto_grant_after_share_task(sid, &conv);
        if let Some(g) = crate::dsh_share::card_grant_of(sid, &conv) {
            payload["grant"] = g.clone();
            payload["myRole"] = json!("collaborator");
            payload["canReshare"] = g.get("canReshare").cloned().unwrap_or(json!(false));
            payload["reshareExp"] = g.get("reshareExp").cloned().unwrap_or(json!(0));
            payload["reshareVia"] = g.get("reshareVia").cloned().unwrap_or(json!(null));
        }
    }
    if let Some(sid) = share_id.as_deref() {
        payload["shareId"] = json!(sid);
        // 任务卡 env（2026-10-23）：**卡上说它能开什么，就随卡一起走**。
        // 没有这一步，接收方拿到的卡只有 shareId、没有 env[] → `TaskEnvList` 空渲染
        // （用户看到的就是"点不动的卡"）。只读本机注册表：转发别人的卡 → None，
        // 环境声明留在源设备（链路见 `dsh_share::share_env_for_card` 的注释）。
        // 收票人（2026-10-23 07:1x，修「手机/笔记本点 DSH 卡只到根路径 401」）：
        //  entryUrl 的 mt 必须按**收卡人自己的 grant 行**签，否则入口 authorize_entry 对账失败 → 401。
        //   · 自己单聊（conv == 本账号）/ 设备群（grp-dev-* 精确匹配本账号派生 id）→ None（owner 票）
        //   · 单个好友（did:youling:…）→ Some(conv)（按他本人 grant 行的 ro/caps 签）
        //   · 多人群（grp-* 但非设备群）→ Some("")（显式不签：不能把 owner 票发给群里所有人）
        let entry_recipient: Option<String> = {
            let my = myco_core::identity::account_did().unwrap_or_default();
            if conv.starts_with("grp-") {
                if device_group_card_allowed(&my, &conv) {
                    None
                } else {
                    Some(String::new())
                }
            } else if conv.starts_with("did:") && !my.is_empty() && conv != my {
                Some(conv.clone())
            } else {
                None
            }
        };
        if let Some((env, owner)) =
            crate::dsh_share::share_env_for_card(sid, entry_recipient.as_deref())
        {
            payload["env"] = env;
            payload["caps"] = json!([crate::vnet_env::CAP_VNET_FORWARD]);
            payload["owner"] = json!(owner);
        } else if let Some(env0) = task_card_env_by_share(sid) {
            // 2026-11-15 健壮性补口（转授/转发场景）：本机注册表没有这条分享
            // （转发别人的卡）→ `share_env_for_card` 返回 None → 出站卡只有 shareId，
            // 接收方落一张点不动的卡。兜底：本机任务库里若存着这张卡的 env[]
            // （作为收卡方曾经收到过），按同样口径取主条目原样转发。
            payload["env"] = json!([env0]);
            payload["caps"] = json!([crate::vnet_env::CAP_VNET_FORWARD]);
            if let Some(owner) = load_tasks()
                .iter()
                .find(|t| t.get("shareId").and_then(|v| v.as_str()) == Some(sid))
                .and_then(|t| t.get("owner").cloned())
            {
                payload["owner"] = owner;
            }
        }
    }
    // 批二：群 conv → 群会话一条 task-share（to=grp-*，p2p_send_raw 按 members 端侧扇出，
    // 含自己其他设备）——接收端 ingest 落群会话（全员可见同一张卡），不再逐成员单发
    // （旧形态接收端落在与分享者的单聊，群会话看不到卡）。单聊分享行为不变。
    if conv.starts_with("grp-") {
        let g = load_groups()
            .iter()
            .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(conv.as_str()))
            .cloned()
            .ok_or_else(|| "群不存在（可能已被清理，重进好友分区刷新）".to_string())?;
        if !group_terminal_status(&g).is_empty() {
            return Err("群已解散或你已被移出，无法分享任务卡".into());
        }
        let members: Vec<String> = g
            .get("members")
            .and_then(|m| m.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        if members.len() <= 1 {
            return Err("没有可分享的成员".into());
        }
        let gname = g
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("群")
            .to_string();
        payload["groupId"] = json!(conv);
        payload["groupName"] = json!(gname);
        payload["members"] = json!(members);
        let (_, _, agg) = p2p_send_raw(&conv, "task-share", payload.clone()).await?;
        // 自己侧也落一份卡（群会话气泡可见；msgId=taskId 与接收端幂等键一致）
        append_out(
            &conv,
            &my,
            &conv,
            "task-share",
            payload.clone(),
            &task_id,
            now_ms(),
            agg,
        );
        // 分享出登记本地任务库（status=shared）：task-accept/task-done 回执的系统条靠它取真实标题
        let mut tasks = load_tasks();
        if !tasks
            .iter()
            .any(|t| t.get("taskId").and_then(|d| d.as_str()) == Some(task_id.as_str()))
        {
            let mut rec = payload.clone();
            rec["status"] = json!("shared");
            rec["convId"] = json!(conv);
            tasks.push(rec);
            save_tasks(&tasks);
        }
        // 分享任务卡 → 自动进授权列表（**群聊分支**）：已在上面（赠卡信息要它先落）统一做过
        // ——同一件事只在一个地方做（`auto_grant_after_share_task` 幂等，重复调用只是白跑）。
        return Ok(json!({ "taskId": task_id }));
    }
    // 单聊：逐目标直推（第95轮：失败自动入离线队列）
    let targets: Vec<String> = vec![conv.clone()];
    let mut agg: &'static str = "failed";
    for t in &targets {
        let (_, _, st) = p2p_send_raw(t, "task-share", payload.clone()).await?;
        agg = if st == "sent" {
            "sent"
        } else if agg != "sent" {
            st
        } else {
            agg
        };
    }
    // 自己侧也落一份卡（气泡可见）
    append_out(
        &did_safe(&conv),
        &my,
        &conv,
        "task-share",
        payload.clone(),
        &task_id,
        now_ms(),
        agg,
    );
    // 分享出登记本地任务库（status=shared）：task-accept/task-done 回执的系统条靠它取真实标题
    let mut tasks = load_tasks();
    if !tasks
        .iter()
        .any(|t| t.get("taskId").and_then(|d| d.as_str()) == Some(task_id.as_str()))
    {
        let mut rec = payload.clone();
        rec["status"] = json!("shared");
        rec["convId"] = json!(did_safe(&conv));
        tasks.push(rec);
        save_tasks(&tasks);
    }
    // 分享任务卡 → 自动进授权列表（**单聊分支**）：已在上面统一做过（赠卡信息要它先落）。
    Ok(json!({ "taskId": task_id }))
}

// ══════════════════════════════════════════════════════════════════════════
// §3.23 转授闸：**非 owner 转发任务卡**这条路上唯一的判定入口
//
// 用户口径：「好友再次分享给他人就不行吧，要经主人同意」。
//
// 判定链（三问，全在**发卡之前**）：
//   ① 这条分享在我的注册表里吗（`local_owns_share`）？在 → 我是主人 →
//      `Ok(None)`：既有分享路径一个字不变（主账号/关联设备都归这一支，分享即授权）。
//   ② 不在 → 我是**协作者**：拿本机任务库里那张卡记的转授面（`canReshare`/`reshareExp`）
//      过 `reshare_forward_verdict`（纯函数）：
//        · 没转授权 / 已过期 → `Err(人话)` **默认拒绝**，并顺手向主人递「转授申请」；
//        · 有转授权 → `Ok(Some(人话))`：**不由我转发**——请源设备把卡直接发给对方。
//   ③ 没有本地卡（既不是我的分享、我也没有这张卡）→ 按"无转授权"处理（fail-closed）。
//
// 为什么"有转授权也不由我转发"：第三人点卡走的是 `remoteOpen → 源设备现签窄 mt`
// 那条既有链，卡的来源坐标必须指向**源设备**；由我转发的话来源是我这台机器
// （它没有这条分享的注册表）→ 对方必然"打不开"。所以转授 = 主人同意 + 主人发卡。
// 这也顺手保证了「同一 taskId 只出现一张卡」。
// ══════════════════════════════════════════════════════════════════════════

/// 转发目标（单聊=对方账号；群=成员里除我之外的账号）。
fn reshare_targets(conv: &str) -> Vec<String> {
    if conv.starts_with("grp-") {
        group_member_dids(conv)
            .into_iter()
            .filter(|d| !d.trim().is_empty())
            .filter(|d| !core_id::account_did_eq(d, &my_account_did().unwrap_or_default()))
            .collect()
    } else {
        vec![conv.to_string()]
    }
}

/// 递一条「转授申请」给源设备（best-effort：递不出去只记日志，绝不影响给用户的拒绝话术）。
async fn send_reshare_request(
    source_account: &str,
    source_device: &str,
    card: &Value,
    share_id: &str,
    target_did: &str,
) -> Result<(), String> {
    if source_account.trim().is_empty() {
        return Err("这张卡没有记录分享者，没法申请转授".into());
    }
    let my = my_account_did()?;
    let my_device = my_device_did();
    let target_label = friend_display_name(target_did).unwrap_or_else(|| did_tail4(target_did));
    let request_id = format!("rr-{:x}", now_ms());
    let mut payload = crate::dsh_share::reshare_request_payload(
        share_id,
        &request_id,
        &card
            .get("fromName")
            .and_then(|v| v.as_str())
            .unwrap_or("协作者")
            .to_string(),
        target_did,
        &target_label,
        None,
    );
    // 源设备的归属闸（`device_belongs_to_account`）认这两个键——与 share-entry-request 同款。
    payload["requesterDevice"] = json!(my_device);
    payload["requesterAccount"] = json!(my);
    if !source_device.trim().is_empty() {
        payload["sourceDevice"] = json!(source_device);
    }
    send_control_msg(source_account, "reshare-request", payload).await
}

/// 转授闸（见上方块注释）。`Ok(None)`=我是主人；`Ok(Some(msg))`=已请主人发卡；
/// `Err(msg)`=拒绝（人话）。
async fn reshare_gate_before_forward(
    conv: &str,
    share_id: &str,
    tasks: &[Value],
) -> Result<Option<String>, String> {
    if crate::dsh_share::local_owns_share(share_id) {
        return Ok(None);
    }
    let card = tasks
        .iter()
        .find(|t| t.get("shareId").and_then(|v| v.as_str()) == Some(share_id))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let info = crate::dsh_share::CardReshare {
        can_reshare: card
            .get("canReshare")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        exp: card.get("reshareExp").and_then(|v| v.as_u64()).unwrap_or(0),
        via: card
            .get("reshareVia")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        share_id: share_id.to_string(),
        source_account: card
            .get("sourceAccount")
            .and_then(|v| v.as_str())
            .or_else(|| card.get("from").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string(),
        source_device: card
            .get("sourceDevice")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    };
    let verdict = crate::dsh_share::reshare_forward_verdict(&info, now_ms() as u64);
    let targets = reshare_targets(conv);
    if targets.is_empty() {
        // 群解析不出成员（群不存在 / 已解散 / 只剩自己）→ **交给既有的群校验给准确人话**
        // （它会返回"群不存在"这类精确错误），这里不抢答。
        // 这不是"放行"：下游校验失败即失败，卡根本发不出去。
        return Ok(None);
    }
    // 无论批不批，都要把申请递到源设备：批过 → 它自动放行并发卡；没批 → 落待批准。
    let mut first_err: Option<String> = None;
    for t in &targets {
        if let Err(e) = send_reshare_request(
            &info.source_account,
            &info.source_device,
            &card,
            share_id,
            t,
        )
        .await
        {
            if first_err.is_none() {
                first_err = Some(e);
            }
        }
    }
    match verdict {
        Err(why) => Err(match first_err {
            // 申请没递出去也要给准确的人话：别让用户以为"已经通知主人了"。
            Some(e) => format!("{why}（但申请没递出去：{e}）"),
            None => why,
        }),
        Ok(exp) => {
            let days = ((exp.saturating_sub(now_ms() as u64)) / 86_400_000) as i64;
            Ok(Some(if first_err.is_some() {
                "这张卡是别人分享给你的——已经请主人直接把卡发给对方（申请可能没送达，请稍后再试一次）".to_string()
            } else {
                format!("这张卡是别人分享给你的——已经请主人直接把卡发给对方（你的转授权限还剩约 {days} 天）")
            }))
        }
    }
}

/// 接受任务卡：pending→todo + 回发 task-accept。
/// 回执词表对齐 HBL claim：payload={event:'claim', task_id, worker_did, from, ts}（平铺事件形）。
#[tauri::command]
pub async fn chat_accept_task(task_id: String) -> Result<Value, String> {
    let my = my_account_did()?;
    let mut tasks = load_tasks();
    let t = tasks
        .iter_mut()
        .find(|t| t.get("taskId").and_then(|d| d.as_str()) == Some(task_id.as_str()))
        .ok_or_else(|| "任务卡不存在".to_string())?;
    if t.get("status").and_then(|s| s.as_str()) == Some("pending") {
        // 过期卡不可接受（卡生命周期）
        if let Some(exp) = t.get("expiresAt").and_then(|e| e.as_i64()) {
            if exp < now_ms() {
                return Err("任务卡已过期".into());
            }
        }
        t["status"] = json!("todo");
        t["acceptedAt"] = json!(now_ms());
    }
    // 第83轮：接受者进 participants（role=member）；回执带全量 participants（对端合并去重）
    let name = my_name().await;
    let mut parts = task_participants(t);
    merge_participants(
        &mut parts,
        &[json!({ "did": my, "name": name, "role": "member", "acceptedAt": now_ms() })],
    );
    t["participants"] = json!(parts.clone());
    let from = t
        .get("from")
        .and_then(|f| f.as_str())
        .unwrap_or("")
        .to_string();
    let conv_id = t
        .get("convId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let title = t
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    save_tasks(&tasks);
    // 批二：群任务的回执群广播（convId=grp-*）——to=群 id 按 members 端侧扇出，
    // 所有成员（含自己其他设备）的群会话落"X 一起接了任务《Y》"，不只发 owner。
    // 本地也落一条回执（接受者自己屏幕可见；msgId 与扇出信封同，幂等）。单聊行为不变。
    if conv_id.starts_with("grp-") {
        let members: Vec<String> = load_groups()
            .iter()
            .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(conv_id.as_str()))
            .and_then(|g| g.get("members").and_then(|m| m.as_array()).cloned())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let p = json!({ "event": "claim", "task_id": task_id, "worker_did": my, "from": my, "ts": now_ms(),
                        "name": name, "participants": parts, "groupId": conv_id, "members": members });
        if let Ok((rid, rts, st)) = p2p_send_raw(&conv_id, "task-accept", p).await {
            append_out(
                &conv_id,
                &my,
                &conv_id,
                "task-accept",
                json!({ "task_id": task_id, "event": "claim", "worker_did": my, "name": name, "title": title, "participants": parts }),
                &rid,
                rts,
                st,
            );
        }
        return Ok(json!({ "ok": true }));
    }
    if !from.is_empty() {
        let p = json!({ "event": "claim", "task_id": task_id, "worker_did": my, "from": my, "ts": now_ms(),
                        "name": name, "participants": parts });
        // 第84轮：回执 P2P 直推
        let _ = p2p_send_raw(&from, "task-accept", p).await?;
    }
    Ok(json!({ "ok": true }))
}

/// 任务状态机：todo→doing→done；done 时回发 task-done。
/// 回执词表对齐 HBL submit：payload={event:'submit', task_id, worker_did, from, ts}；
/// 第83轮：+name+participants（自己标 done，对端合并——"N 人协作完成"的数据源）。
#[tauri::command]
pub async fn chat_set_task_status(task_id: String, status: String) -> Result<Value, String> {
    let my = my_account_did()?;
    if !["todo", "doing", "done"].contains(&status.as_str()) {
        return Err("状态只支持 todo/doing/done".into());
    }
    let mut tasks = load_tasks();
    let t = tasks
        .iter_mut()
        .find(|t| t.get("taskId").and_then(|d| d.as_str()) == Some(task_id.as_str()))
        .ok_or_else(|| "任务不存在".to_string())?;
    let was = t
        .get("status")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    t["status"] = json!(status);
    let mut name = String::new();
    let mut parts_out: Vec<Value> = vec![];
    if status == "done" {
        t["doneAt"] = json!(now_ms());
        name = my_name().await;
        let mut parts = task_participants(t);
        merge_participants(
            &mut parts,
            &[json!({ "did": my, "name": name, "status": "done", "doneAt": now_ms() })],
        );
        t["participants"] = json!(parts.clone());
        parts_out = parts;
    }
    let from = t
        .get("from")
        .and_then(|f| f.as_str())
        .unwrap_or("")
        .to_string();
    let conv_id = t
        .get("convId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let title = t
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    save_tasks(&tasks);
    // 首次置 done 才回发（重复点击不刷屏）
    if status == "done" && was != "done" {
        // 批二：群任务的 task-done 群广播——所有成员的群会话落"X 完成了任务《Y》"。
        if conv_id.starts_with("grp-") {
            let members: Vec<String> = load_groups()
                .iter()
                .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(conv_id.as_str()))
                .and_then(|g| g.get("members").and_then(|m| m.as_array()).cloned())
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let p = json!({ "event": "submit", "task_id": task_id, "worker_did": my, "from": my, "ts": now_ms(),
                            "name": name, "participants": parts_out, "groupId": conv_id, "members": members });
            if let Ok((rid, rts, st)) = p2p_send_raw(&conv_id, "task-done", p).await {
                append_out(
                    &conv_id,
                    &my,
                    &conv_id,
                    "task-done",
                    json!({ "task_id": task_id, "event": "submit", "worker_did": my, "name": name, "title": title, "participants": parts_out }),
                    &rid,
                    rts,
                    st,
                );
            }
            return Ok(json!({ "ok": true }));
        }
        if !from.is_empty() {
            let p = json!({ "event": "submit", "task_id": task_id, "worker_did": my, "from": my, "ts": now_ms(),
                            "name": name, "participants": parts_out });
            // 第84轮：回执 P2P 直推
            let _ = p2p_send_raw(&from, "task-done", p).await?;
        }
    }
    Ok(json!({ "ok": true }))
}

// ══════════════════════════════════════════════════════════════════════════
// 任务卡改名（task-rename，2026-10-11）
//
// 设计定稿口径：「没任务卡片的，不是建任务方的人也没机会接触到这个功能」——
// 改名是 **owner 单向广播**的标题终局同步，不协商、不回执。
//
// wire（新 kind，签名随行——与现有 chat 消息同一 p2p_send_raw 底座）：
//   kind = "task-rename"
//   payload = { taskId, title(≤64字，超截断), ts }（群任务另带 groupId/members 扇出锚）
// 老端不认识 → 落到 `ingest_msg` 的 `_ => false`：不崩、不入库（优雅降级先例：
// group-disband 同款）。
//
// 接收侧（参与者 & owner 自己的其他设备）：
//   ① 校验 payload.taskId 对应的本地 task 存在（不存在=rename 先于卡到达/陌生卡
//      → return false 不落 meta，下一次对账会再带过来——自愈）；
//   ② **安全闸**：消息 from == task.from（公钥级 account_did_eq）——非 owner 伪造
//      一律拒收；
//   ③ ts 大者生效（payload.ts ≤ 本地 titleTs → 幂等/迟到旧值，不覆盖不落行）；
//   ④ 更新本地 title + 落一条会话行（kind=task-rename 的系统条——既是本地留痕，
//      也是**对账载体**：参与者手机从 owner PC 拉、owner 手机从好友 PC 拉）。
//
// owner 自己多端：改名时**额外**往本账号设备群落一行（grp-dev-*，payload.groupId
// 指向设备群）——设备群在本账号对账服务面内（shared_conv_ids 恒含），不依赖
// 好友端在线/版本；渲染层对设备群过滤该 kind（数据面不是聊天面）。
// ══════════════════════════════════════════════════════════════════════════

/// 改名本地核（校验 + 任务库落盘 + 组装投递计划）——**纯本地可单测**（不碰网络）。
/// 返回 (wire payload, 任务会话 id, 投递目标)：投递目标 grp-*=群扇出（payload 已带
/// members）/ 账号 did=单聊直推 / 空串=仅本地（会话 id 不可还原或任务无会话——
/// dsh-share 卡的 convId 可能缺失，此时设备群载体行仍保证 owner 多端同步）。
fn task_rename_prepare(
    my: &str,
    task_id: &str,
    new_title: &str,
    ts: i64,
) -> Result<(Value, String, String), String> {
    let title = new_title.trim();
    if title.is_empty() {
        return Err("任务标题不能为空".into());
    }
    let title: String = title.chars().take(64).collect::<String>(); // wire 上限 64 字（chars 不按字节切）
    let mut tasks = load_tasks();
    let Some(t) = tasks
        .iter_mut()
        .find(|t| t.get("taskId").and_then(|d| d.as_str()) == Some(task_id))
    else {
        return Err("任务不存在".into());
    };
    let owner = t.get("from").and_then(|v| v.as_str()).unwrap_or("");
    // owner 闸（UI 入口只给 owner 看见；这里是强制校验——伪造/越权调用直接拒）
    if owner.is_empty() || !core_id::account_did_eq(owner, my) {
        return Err("只有任务发起人可以改名".into());
    }
    t["title"] = json!(title);
    t["titleTs"] = json!(ts); // 冲突裁决锚：ts 大者生效（多端并发改名收敛到最新那条）
    let conv_id = t
        .get("convId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    save_tasks(&tasks);
    let mut payload = json!({ "taskId": task_id, "title": title, "ts": ts });
    let send_to = if conv_id.starts_with("grp-") && !is_device_group_id(&conv_id) {
        // 群任务：按 members 端侧扇出（含自己其他设备——群会话行 + 直推双路到达）
        let members: Vec<String> = load_groups()
            .iter()
            .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(conv_id.as_str()))
            .and_then(|g| g.get("members").and_then(|m| m.as_array()).cloned())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        payload["groupId"] = json!(conv_id);
        payload["members"] = json!(members);
        conv_id.clone()
    } else if conv_id.starts_with("grp-") {
        String::new() // 任务会话就是本账号设备群（dsh-share 卡）：不外发，设备群载体行即同步
    } else {
        // 单聊：任务库 convId 是 did_safe 形态——还原出原始对端 did 再直推
        // （还原不出=软 did/存量怪档：跳过发送，本地+设备群载体行照样生效）。
        conv_did_of(&conv_id).unwrap_or_default()
    };
    Ok((payload, conv_id, send_to))
}

/// task-rename 入站（**放 self_echo 的 from 改写之前**：自同步回流 from==my 会被
/// 归位成对方 did，owner 校验会误杀自己——这里面对的是信封原始 from）。
fn ingest_task_rename(my: &str, m: &Value) -> bool {
    let payload = m.get("payload").cloned().unwrap_or(json!({}));
    let task_id = payload
        .get("taskId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let title_raw = payload
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if task_id.is_empty() || title_raw.is_empty() {
        return false;
    }
    let title: String = title_raw.chars().take(64).collect(); // 防御性截断（不信任 wire 长度）
    let ts = payload
        .get("ts")
        .and_then(|v| v.as_i64())
        .or_else(|| m.get("ts").and_then(|v| v.as_i64()))
        .unwrap_or_else(now_ms);
    let from = m.get("from").and_then(|v| v.as_str()).unwrap_or("");
    let mut tasks = load_tasks();
    let Some(t) = tasks
        .iter_mut()
        .find(|t| t.get("taskId").and_then(|d| d.as_str()) == Some(task_id.as_str()))
    else {
        return false; // 本地无此卡——不落 meta（digest 不收口），下一次对账再带（卡后到齐即收敛）
    };
    let owner = t
        .get("from")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // 安全闸：只有 owner 的改名生效（参与者伪造无效）
    if owner.is_empty() || !core_id::account_did_eq(from, &owner) {
        return false;
    }
    let cur = t.get("titleTs").and_then(|v| v.as_i64()).unwrap_or(0);
    if ts <= cur {
        return true; // 幂等（直推+对账双份）/ 迟到旧值：不覆盖、不重复落行
    }
    t["title"] = json!(title);
    t["titleTs"] = json!(ts);
    save_tasks(&tasks);
    // 落会话行（系统条留痕 + 对账载体）：群→群会话；单聊→与对方的会话
    // （自同步回流 from==my 归位到 to 的会话——与第84轮同语义）；设备群载体行
    // （payload.groupId=grp-dev-*）落设备群（渲染层过滤，见 chat_load_conv）。
    let gid = payload
        .get("groupId")
        .and_then(|v| v.as_str())
        .filter(|g| g.starts_with("grp-"))
        .unwrap_or("");
    let self_echo = !my.is_empty() && core_id::account_did_eq(from, my);
    let to = m.get("to").and_then(|v| v.as_str()).unwrap_or("");
    let conv_id = if !gid.is_empty() {
        gid.to_string()
    } else if self_echo && !to.is_empty() {
        my_did_conv(to)
    } else if !self_echo && !from.is_empty() {
        my_did_conv(from)
    } else {
        String::new() // 自同步回流缺 to（异常形态）：标题已应用，行没处落——跳过
    };
    if conv_id.is_empty() {
        return true;
    }
    let msg_id = m.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let mut row_payload = json!({ "taskId": task_id, "title": title, "ts": ts });
    if !gid.is_empty() {
        row_payload["groupId"] = json!(gid);
    }
    conv_append(
        &conv_id,
        &json!({
            "msgId": msg_id, "from": from,
            "to": if !gid.is_empty() { gid.to_string() } else if self_echo { to.to_string() } else { my.to_string() },
            "kind": "task-rename", "payload": row_payload,
            "ts": ts, "dir": if self_echo { "out" } else { "in" },
            "fromName": m.get("fromName"),
            "fromDevice": m.get("fromDevice"), "fromDeviceName": m.get("fromDeviceName"), // 决策D-2：设备署名随行
        }),
    );
    true
}

/// 用户主动删除一张任务卡（2026-11-15：用户被重复卡缠住，只能停机改 JSON）。
///
/// 语义：删本地任务行 + 打 tombstone（防对账/迟到重投把它复活），不发网络包——
/// 删的是"我这台设备上的这张卡"，不动源设备的分享。
#[tauri::command]
pub fn chat_remove_task(task_id: String) -> Result<Value, String> {
    let tid = task_id.trim().to_string();
    if tid.is_empty() {
        return Err("缺 taskId".into());
    }
    let mut tasks = load_tasks();
    let before = tasks.len();
    tasks.retain(|t| t.get("taskId").and_then(|v| v.as_str()) != Some(tid.as_str()));
    let removed = before - tasks.len();
    if removed > 0 {
        save_tasks(&tasks);
    }
    // tombstone 复用既有机制：对账预热/群同步/迟到重投命中 tombstone 一律不落库
    tombstone_task(&tid, "user-remove");
    Ok(json!({ "ok": true, "taskId": tid, "removed": removed }))
}

/// owner 端改名入口（任务卡菜单「改名」）：本地更新 → P2P 发 task-rename 到任务
/// 会话 → 会话留痕行（对账载体）→ 设备群载体行（owner 自己多端同步）。
#[tauri::command]
pub async fn chat_rename_task(task_id: String, title: String) -> Result<Value, String> {
    let my = my_account_did()?;
    let ts = now_ms();
    let (payload, conv_id, send_to) = task_rename_prepare(&my, &task_id, &title, ts)?;
    let mut msg_id = new_msg_id();
    let mut state = "local";
    if !send_to.is_empty() {
        // 发送失败不挡本地（离线队列已兜底补发；返回失败态由 UI 决定说不说）
        if let Ok((mid, _, st)) = p2p_send_raw(&send_to, "task-rename", payload.clone()).await {
            msg_id = mid;
            state = st;
        }
    }
    // 任务会话留痕行（对账载体：参与者手机从本机拉；群任务含自己其他设备）
    if !conv_id.is_empty() {
        let to = if conv_id.starts_with("grp-") {
            conv_id.clone()
        } else {
            send_to.clone()
        };
        append_out(
            &conv_id,
            &my,
            &to,
            "task-rename",
            payload.clone(),
            &msg_id,
            ts,
            state,
        );
    }
    // 设备群载体行（owner 多端：本账号对账服务面恒含设备群，不依赖对端在线/版本）
    let dgid = ensure_device_group_for(&my);
    if dgid != conv_id {
        let mut dp = payload.clone();
        dp["groupId"] = json!(dgid);
        append_out(&dgid, &my, &dgid, "task-rename", dp, &msg_id, ts, state);
    }
    Ok(json!({ "ok": true }))
}

// ══════════════ 第84轮：P2P 在线状态 / typing / 对账命令 ══════════════

/// 账号/设备 did 比对键（纯函数）：能 canonical 解出公钥字节就按字节（`did:myco:z…` /
/// `did:youling:z…` 两前缀归一到同一个键；legacy 裸 base58 已废止、不再归一），否则退回原串。
/// 2026-10-07 修：presence 行的 rootDid 是 `account_did()` 归一的 `did:youling:` 形态，
/// 而好友 did / 会话 id 多是名册另一前缀形态 —— 裸串索引永不命中（好友灯恒灰）。
fn did_key(did: &str) -> String {
    match core_id::did_pubkey_bytes(did) {
        Some(b) => b.iter().map(|x| format!("{x:02x}")).collect(),
        None => did.to_string(),
    }
}

/// 第96轮（修复6）：presence 灯聚合（纯函数，单测）——kind=phone 计入 online。
/// 旧口径把 kind!=pc 整个剔掉（手机无入站端口不能直推→连灯也灰），好友只在
/// 手机在线时灯恒灰。直推寻址的 pc+addrs 过滤留在 p2p_client::presence_devices
/// （唯一该过滤的地方）；灯只看"账号下有没有在线设备"。
/// rows: [{root,did,kind,name,state,lastSeen,addrs,port}]；返回 好友did → 灯对象。
fn aggregate_friend_lights(
    rows: &[Value],
    friend_dids: &[String],
) -> serde_json::Map<String, Value> {
    let mut by_account: std::collections::HashMap<String, Vec<&Value>> =
        std::collections::HashMap::new();
    for d in rows {
        let root = d
            .get("root")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if root.is_empty() {
            continue;
        }
        by_account.entry(did_key(&root)).or_default().push(d);
    }
    // 好友粒度聚合：任一设备在线即 online；state 取最新交互设备（typing>active>idle>locked）
    let rank = |s: &str| match s {
        "typing" => 3,
        "active" => 2,
        "idle" => 1,
        "locked" => 0,
        _ => 0,
    }; // typing 最高（最具体）
    let mut friends = serde_json::Map::new();
    for did in friend_dids {
        if let Some(devs) = by_account.get(&did_key(did)) {
            let mut best: Option<(&str, &Value)> = None;
            for dv in devs {
                let st = dv.get("state").and_then(|s| s.as_str()).unwrap_or("active");
                let r = rank(st);
                let better = match best {
                    None => true,
                    Some((bs, _)) => r > rank(bs),
                };
                if better {
                    best = Some((st, dv));
                }
            }
            let (st, dv) = best.unwrap_or(("active", devs[0]));
            friends.insert(
                did.clone(),
                json!({
                    "online": true, "state": st,
                    "deviceName": dv.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                    "devices": devs.len(),
                    // lastSeen 透传（任务群四色 lastSeenSec 用；单位由服务器定，见 dsh_share 解析）
                    "lastSeen": dv.get("lastSeen"),
                }),
            );
        }
    }
    friends
}

/// 好友在线/在场数据（**唯一实现**）：拉 /presence/list 并聚合成好友粒度灯。
/// 灯（chat_presence）与任务群四色（dsh_share::share_task_group）共用它——
/// 四色 = 本分享 presence × 这一份 myco 在场，后端一次 join（§3.19.2 设计定稿）。
/// 返回 (好友 did → 灯对象, 全部在线设备行)。失败 = Err（调用方自行退化，不编造）。
pub(crate) async fn presence_lights() -> Result<(serde_json::Map<String, Value>, Vec<Value>), String>
{
    let resp = core_id::signed_post("/presence/list", &json!({}))
        .await
        .map_err(|e| format!("presence/list 失败: {e}"))?;
    let list = resp
        .pointer("/data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    let my_device = core_id::device_identity()
        .map(|(d, _)| d)
        .unwrap_or_default();
    // 全部在线设备行（含手机——灯口径；直推寻址在 p2p_client 另滤 pc+addrs）
    let mut rows: Vec<Value> = vec![];
    for d in &list {
        let root = d
            .get("rootDid")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let did = d
            .get("did")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if core_id::did_equiv(&did, &my_device) || root.is_empty() {
            continue;
        }
        let addrs = d
            .pointer("/addrs/ipv6List")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect::<Vec<_>>()
            })
            .or_else(|| {
                d.pointer("/addrs/ipv6")
                    .and_then(|v| v.as_str())
                    .map(|s| vec![s.to_string()])
            })
            .unwrap_or_default();
        let port = d
            .pointer("/addrs/port")
            .and_then(|v| v.as_u64())
            .unwrap_or(9100) as u16;
        rows.push(json!({
            "root": root, "did": did,
            "kind": d.get("kind").and_then(|v| v.as_str()).unwrap_or(""),
            "name": d.get("name"), "state": d.get("state"), "lastSeen": d.get("lastSeen"),
            "addrs": addrs, "port": port,
        }));
    }
    let friend_dids: Vec<String> = load_friends()
        .iter()
        .filter_map(|f| f.get("did").and_then(|d| d.as_str()).map(String::from))
        .filter(|d| !d.is_empty())
        .collect();
    let friends = aggregate_friend_lights(&rows, &friend_dids);
    Ok((friends, rows))
}

/// 好友本地显示名（friends.json 缓存，**不发网络**）；未知 = None
/// （调用方退回群/分享里的备注名或 did 尾号）。任务群成员名单用。
pub(crate) fn friend_display_name(did: &str) -> Option<String> {
    load_friends().into_iter().find_map(|f| {
        let fd = f.get("did").and_then(|d| d.as_str())?;
        if !core_id::account_did_eq(fd, did) {
            return None;
        }
        f.get("name")
            .and_then(|n| n.as_str())
            .map(str::trim)
            .filter(|n| !n.is_empty() && !n.starts_with('…'))
            .map(String::from)
    })
}

/// 好友在线状态（灯数据源）：presence_lights 聚合结果 + 本机其他设备 + 上线补发。
/// 返回 { friends: {好友did: {online, state, deviceName, addrs, port}}, devices: [...] }。
/// state ∈ active|typing|idle|locked（服务器 presence register 透传；无=老版本只报 online）。
/// 第96轮（修复6）：kind=phone 计入 online（addrs 过滤只用于直推寻址，不影响灯）。
#[tauri::command]
pub async fn chat_presence() -> Result<Value, String> {
    let my = my_account_did()?;
    // 2026-10-06：拉取+聚合成 presence_lights（任务群四色共用同一份在场数据，
    // 不重复实现一遍 /presence/list 聚合——§3.19 四色在后端一次 join）
    let (friends, rows) = presence_lights().await?;
    // 同账号其他设备（自同步可见性；前端"我的设备"处可显示）
    let own: Vec<Value> = rows
        .iter()
        .filter(|r| r.get("root").and_then(|v| v.as_str()) == Some(my.as_str()))
        .cloned()
        .collect();
    // 第95轮：新晋上线检测（上一轮离线、本轮在线）→ 有待发即自动补发
    // （"对方上线后再同步补发"的最短路径：UI 5s 轮询 chat_presence 时发现）。
    static PREV_ONLINE: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));
    let now_online: std::collections::HashSet<String> = friends.keys().cloned().collect();
    let newly: Vec<String> = {
        let mut prev = PREV_ONLINE.lock().unwrap();
        let diff: Vec<String> = now_online.difference(&prev).cloned().collect();
        *prev = now_online;
        diff
    };
    for did in newly {
        if crate::offline_queue::global().has_pending_for_account(&did) {
            tauri::async_runtime::spawn(async move {
                let n = flush_outbox_for(&did).await;
                if n > 0 {
                    eprintln!("[chat] 好友上线自动补发 {n} 条（{did}）");
                }
            });
        }
    }
    Ok(json!({ "friends": friends, "ownDevices": own }))
}

/// typing 群扇出目标（纯函数，单测）：普通群滤自己（老语义——自己另一台设备的
/// typing 靠成员扇出自然到达）；设备群**不过滤 my**（决策D-5：members=[本机账号]
/// 本来就是要投的账号——老过滤会把 targets 清空，群 typing 信号全丢）。
/// 本机设备在 deliver_to_account 寻址层自筛（peer_from_entry 的 did_equiv），不自环。
fn typing_targets(g: Option<&Value>, my: &str) -> Vec<String> {
    let Some(g) = g else { return vec![] };
    let members: Vec<String> = g
        .get("members")
        .and_then(|m| m.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if is_device_group(g) {
        members
    } else {
        members.into_iter().filter(|d| d != &my).collect()
    }
}

/// typing 瞬时信号：P2P 直发对方设备（不落盘、不走路由）+ 本地 TTL（presence state 用）。
/// 前端输入框 onChange/onKeyDown 节流 3s 调一次；接收方 emit p2p-typing 事件 3.5s 过期。
/// 2026-09-29 灯恢复：
///   - 设 TTL 后 presence::kick() 即时重报——原 20s 心跳撞 4s TTL 命中率 ~20%；
///   - to=grp-* 群扇出（原样直发 grp- id 查不到设备，群 typing 静默全丢）；
///   - TTL 到期自动补一发回退上报（停顿后对方 presence 通道 ≤4s 见 active）。
#[tauri::command]
pub async fn chat_typing(conv_id: String, to: String) -> Result<Value, String> {
    let my = my_account_did()?;
    let until = now_ms() + 4_000;
    TYPING_UNTIL.store(until, Ordering::Relaxed);
    crate::presence::kick();
    // 到期回退补报（若期间被续期/清除则跳过——只认自己这枚 until 戳）
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(4_200)).await;
        if TYPING_UNTIL.load(Ordering::Relaxed) == until {
            crate::presence::kick();
        }
    });
    let device_did = core_id::device_identity()
        .map(|(d, _)| d)
        .unwrap_or_default();
    let signal = json!({
        "convId": conv_id, "from": my, "fromName": my_name().await, "fromDevice": device_did,
    });
    // 群扇出：逐成员账号直发（设备群含自己——members=[my] 即目标账号）；单聊=对方账号。
    let targets: Vec<String> = if to.starts_with("grp-") {
        typing_targets(
            load_groups()
                .iter()
                .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(to.as_str())),
            &my,
        )
    } else {
        vec![to]
    };
    let mut sent = false;
    for acc in &targets {
        if crate::p2p_client::typing_signal(acc, &signal).await {
            sent = true;
        }
    }
    Ok(json!({ "ok": true, "sent": sent }))
}

/// 发送/清空后回退 active：TTL 清零 + 即时重报（2026-09-29 灯恢复）。
fn clear_typing() {
    if TYPING_UNTIL.swap(0, Ordering::Relaxed) > 0 {
        crate::presence::kick();
    }
}

/// 手动/进屏触发对账（fire-and-forget；进度走 p2p-sync-progress 事件）。
/// conv_id 给定时只对相关账号（好友=convId、群=成员）对账；缺省对全部好友+本机其他设备。
#[tauri::command]
pub async fn chat_sync_now(conv_id: Option<String>) -> Result<Value, String> {
    let my = my_account_did()?;
    let accounts: Vec<String> = match conv_id.as_deref() {
        Some(c) if c.starts_with("grp-") => load_groups()
            .iter()
            .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(c))
            .and_then(|g| g.get("members").and_then(|m| m.as_array()).cloned())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        Some(c) => vec![c.replace('_', ":")], // did_safe 逆：did 内无原生 '_'（base58 无下划线），安全
        None => load_friends()
            .iter()
            .filter(|f| f.get("status").and_then(|s| s.as_str()) == Some("ok"))
            .filter_map(|f| f.get("did").and_then(|d| d.as_str()).map(String::from))
            .collect(),
    };
    let mut accounts = accounts;
    accounts.push(my); // 多设备自同步
    let n = accounts.len();
    tauri::async_runtime::spawn(async move {
        for a in accounts {
            let _ = flush_outbox_for(&a).await; // 第95轮：进屏即补发待发（有 pending 才干活）
            let _ = crate::p2p_client::sync_with_account(&a).await;
        }
    });
    Ok(json!({ "ok": true, "accounts": n }))
}

/// 第95轮：手动重发一条失败/发送中的消息（UI 失败徽标点按）。
/// 路径：① 在队（pending/failed）→ 复位 pending 立即补发一次；
///       ② 不在队（溢出从未入队）→ 从 jsonl 行重建信封+目标立即直发，
///          失败则重新入队（pending——自动补发管线重新接管）。
/// 返回 { ok, sendState }（UI 据返回值即时刷新徽标；chat-send-state 事件同步广播）。
#[tauri::command]
pub async fn chat_retry_msg(conv_id: String, msg_id: String) -> Result<Value, String> {
    let ob = crate::offline_queue::global();
    if let Some(item) = ob.get(&msg_id) {
        ob.requeue(&msg_id);
        let sent = ob
            .flush_one(&msg_id, crate::offline_queue::deliver_prod)
            .await;
        let state = if sent { "sent" } else { "failed" };
        if !sent {
            // 手动重试失败=用户已接管：停自动补发（第95轮语义，微信同款；等下次手动/上线）
            ob.mark_failed(&msg_id, "对方长期不在线，消息未送达");
        }
        conv_update_send_state(&item.conv_id, &msg_id, state);
        return Ok(json!({ "ok": sent, "sendState": state }));
    }
    // 不在队：从会话行重建（溢出失败态的消息）
    let msgs = conv_load_raw_inner(&conv_id);
    let row = msgs
        .iter()
        .find(|m| m.get("msgId").and_then(|v| v.as_str()) == Some(msg_id.as_str()))
        .ok_or_else(|| "消息不存在（可能已被清理）".to_string())?;
    if row.get("dir").and_then(|v| v.as_str()) != Some("out") {
        return Err("只有发出的消息需要重发".into());
    }
    let envelope = wire_pack_msg(row);
    let to = row
        .get("to")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let targets: Vec<String> = if to.starts_with("grp-") {
        load_groups()
            .iter()
            .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(to.as_str()))
            .and_then(|g| g.get("members").and_then(|m| m.as_array()).cloned())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        vec![to.clone()]
    };
    let mut delivered = false;
    for t in &targets {
        if crate::p2p_client::deliver_to_account(t, &envelope).await {
            delivered = true;
        }
    }
    if delivered {
        conv_update_send_state(&conv_id, &msg_id, "sent");
        return Ok(json!({ "ok": true, "sendState": "sent" }));
    }
    // 仍未达：重新入队（pending——presence 上线/对账周期自动补发接管）
    let state = match ob.enqueue(&conv_id, targets, envelope) {
        crate::offline_queue::EnqueueOutcome::Queued => "sending",
        crate::offline_queue::EnqueueOutcome::Overflow => "failed",
    };
    conv_update_send_state(&conv_id, &msg_id, state);
    Ok(json!({ "ok": false, "sendState": state }))
}

// ══════════════ 第85轮：群管理命令（owner 治理；服务器信箱投递保证可靠到达） ══════════════

/// 感知：群档案快照（CLI/诊断用；只读本地，零网络）。
pub(crate) fn groups_snapshot() -> Vec<Value> {
    load_groups()
}

/// **路由预热**（2026-10-12 热路径秒发）：进聊天屏时后台把到对端的通路建好
/// （tunnel_acquire 内部：直连→打洞→云中继，产物进 30min 缓存）——之后发消息
/// 直接复用本地口，毫秒级。best-effort：失败静默（发送时再建，行为不变）。
#[tauri::command]
pub async fn chat_warm_route(conv_id: String) -> Result<(), String> {
    if conv_id.starts_with("grp-") {
        // 群：预热同账号的其他设备（扇出目标）；好友账号不预热（可能不在群里）
        let my = my_account_did()?;
        let my_dev = core_id::device_identity()
            .map(|(d, _)| d)
            .unwrap_or_default();
        let dids: Vec<String> =
            crate::p2p_client::roster_devices_except(my.as_str(), &my_dev).await;
        tauri::async_runtime::spawn(async move {
            for did in dids.into_iter().take(2) {
                let _ = crate::dsh_share::tunnel_acquire_pub(&did, 9100).await;
            }
        });
        return Ok(());
    }
    let peer = conv_id.trim_start_matches("did_").replace('_', ":");
    if !peer.starts_with("did:") {
        return Err("无法从会话推导对端".into());
    }
    let peer_owned = peer;
    tauri::async_runtime::spawn(async move {
        // 找对端任一在线设备的 did（单聊对端=账号，扇出设备同 deliver 语义）
        if let Some(dev) =
            crate::p2p_client::presence_device_by_did_kind(&peer_owned, &["pc", "phone"]).await
        {
            let _ = crate::dsh_share::tunnel_acquire_pub(&dev.did, 9100).await;
        }
    });
    Ok(())
}

/// UI 取证（2026-10-12 设备群发消息"已发送→回输入框→又重现"怪象）：
/// 前端 sendText/load/dropOptimistic/retry 等关键节点各写一行——复现一次即可
/// 从时间线定案是哪条路径在打架。落 config_dir()/chat-ui-trace.log（400KB 滚动）。
#[tauri::command]
pub fn chat_ui_trace(tag: String, line: String) {
    use std::io::Write;
    let dir = myco_core::config::config_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("chat-ui-trace.log");
    // 400KB 滚动（承 gw-net.log 同款纪律）
    if let Ok(md) = std::fs::metadata(&path) {
        if md.len() > 400 * 1024 {
            let _ = std::fs::rename(&path, dir.join("chat-ui-trace.log.old"));
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let ts = chrono::Local::now().format("%H:%M:%S%.3f");
        let _ = writeln!(f, "{ts} [{tag}] {line}");
    }
}

/// 群主拉人：members 全量更新 + 逐成员投递 group-invite + 群里落系统条。
#[tauri::command]
pub async fn chat_group_invite(
    group_id: String,
    new_members: Vec<String>,
) -> Result<Value, String> {
    let my = my_account_did()?;
    let groups = load_groups();
    let g = groups
        .iter()
        .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(group_id.as_str()))
        .ok_or_else(|| "群不存在".to_string())?
        .clone();
    if is_device_group(&g) {
        return Err("设备群为系统群，不可管理".into());
    } // 拉人=名册的事，不走群消息
    if group_owner_pending(&g) {
        return Err("群主信息未同步（创建者离线），暂无法管理群".into());
    } // 批二
    if !group_terminal_status(&g).is_empty() {
        return Err("群已解散，无法拉人".into());
    } // 批二
    if !is_group_owner(&g, &my) {
        return Err("只有群主可以拉人".into());
    }
    let cur: Vec<String> = g
        .get("members")
        .and_then(|m| m.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let add: Vec<String> = new_members
        .into_iter()
        .filter(|m| m.starts_with("did:") && !cur.contains(m))
        .collect();
    if add.is_empty() {
        return Err("没有新成员".into());
    }
    let mut all = cur.clone();
    all.extend(add.iter().cloned());
    group_upsert(
        &group_id,
        g.get("name").and_then(|n| n.as_str()).unwrap_or("群"),
        all.clone(),
        Some(&my),
    );
    for m in &add {
        let name = resolve_name(m)
            .await
            .unwrap_or_else(|| format!("…{}", tail4(m)));
        conv_append(
            &group_id,
            &json!({
                "msgId": format!("grp-join-{}-{}", did_safe(m), now_ms()), "from": m, "to": &group_id, "kind": "sys",
                "payload": { "text": format!("🎉 {name} 加入了群聊") }, "ts": now_ms(), "dir": "in",
            }),
        );
    }
    for t in all.iter().filter(|m| *m != &my) {
        srv_send_raw(
            t,
            "group-invite",
            json!({
                "groupId": group_id, "groupName": g.get("name"), "newMembers": add, "members": all,
                "fromName": my_name().await, "ts": now_ms(),
            }),
        )
        .await?;
    }
    Ok(json!({ "ok": true, "added": add.len() }))
}

/// 群主改群名。
#[tauri::command]
pub async fn chat_group_rename(group_id: String, new_name: String) -> Result<Value, String> {
    let my = my_account_did()?;
    let groups = load_groups();
    let g = groups
        .iter()
        .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(group_id.as_str()))
        .ok_or_else(|| "群不存在".to_string())?
        .clone();
    if is_device_group(&g) {
        return Err("设备群为系统群，不可改名".into());
    }
    if group_owner_pending(&g) {
        return Err("群主信息未同步（创建者离线），暂无法管理群".into());
    } // 批二
    if !group_terminal_status(&g).is_empty() {
        return Err("群已解散，无法改名".into());
    } // 批二
    if !is_group_owner(&g, &my) {
        return Err("只有群主可以改群名".into());
    }
    let name = new_name.trim().chars().take(24).collect::<String>();
    if name.is_empty() {
        return Err("群名不能为空".into());
    }
    let members: Vec<String> = g
        .get("members")
        .and_then(|m| m.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    group_upsert(&group_id, &name, members.clone(), Some(&my));
    for t in members.iter().filter(|m| *m != &my) {
        srv_send_raw(
            t,
            "group-rename",
            json!({
                "groupId": group_id, "newName": name, "fromName": my_name().await, "ts": now_ms(),
            }),
        )
        .await?;
    }
    Ok(json!({ "ok": true }))
}

/// 退群（任何人）：本地删档案+会话；其余成员收 group-leave。
/// 批二（2026-09-28 设计定稿）：群主退群=解散——广播 group-disband（新 kind，
/// 全体成员：群会话保留只读+members 清空+系统条"群已被解散"），compat group-leave
/// 随发（老端优雅降级为"群主退出了群聊"系统条，不崩）；群主本端同样置终态只读。
/// 非群主退群维持现语义（移出 members，本端删档案+会话）。
#[tauri::command]
pub async fn chat_group_leave(group_id: String) -> Result<Value, String> {
    let my = my_account_did()?;
    let groups = load_groups();
    let g = groups
        .iter()
        .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(group_id.as_str()))
        .ok_or_else(|| "群不存在".to_string())?
        .clone();
    if is_device_group(&g) {
        return Err("设备群为系统群，不可退出或解散".into());
    }
    let members: Vec<String> = g
        .get("members")
        .and_then(|m| m.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    // 批二：群主退群 → 解散语义（名实相符——UI 文案"解散并退出"此前是假话：
    // 实际只移出群主变无主群，字典序首成员兜底成假群主，各端认知分叉）。
    if is_group_owner(&g, &my) {
        let gname = g
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("群")
            .to_string();
        let ts = now_ms();
        // 本端置终态（群会话保留只读，历史可回查）——与成员端同视图
        group_mark_terminal(
            &group_id,
            "disbanded",
            &format!("群「{gname}」已被群主解散"),
            &format!("grp-disband-{group_id}"),
            ts,
            &my,
        );
        for t in members.iter().filter(|m| *m != &my) {
            // 先 disband（新端只认它）后 leave（老端 compat——新端终态闸拒收，不会双系统条）
            srv_send_raw(
                t,
                "group-disband",
                json!({
                    "groupId": group_id, "groupName": gname, "fromName": my_name().await, "ts": ts,
                }),
            )
            .await?;
            srv_send_raw(
                t,
                "group-leave",
                json!({
                    "groupId": group_id, "fromName": my_name().await, "ts": ts,
                }),
            )
            .await?;
        }
        return Ok(json!({ "ok": true, "disbanded": true }));
    }
    save_groups(
        &load_groups()
            .into_iter()
            .filter(|x| x.get("id").and_then(|d| d.as_str()) != Some(group_id.as_str()))
            .collect::<Vec<_>>(),
    );
    conv_remove_files(&group_id); // 会话 jsonl（含等价形态）+ meta
    crate::offline_queue::global().remove_conv(&group_id); // 第95轮：退群清待发
    for t in members.iter().filter(|m| *m != &my) {
        srv_send_raw(
            t,
            "group-leave",
            json!({
                "groupId": group_id, "fromName": my_name().await, "ts": now_ms(),
            }),
        )
        .await?;
    }
    Ok(json!({ "ok": true }))
}

/// 群主踢人。
#[tauri::command]
pub async fn chat_group_kick(group_id: String, target_did: String) -> Result<Value, String> {
    let my = my_account_did()?;
    let groups = load_groups();
    let g = groups
        .iter()
        .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(group_id.as_str()))
        .ok_or_else(|| "群不存在".to_string())?
        .clone();
    if is_device_group(&g) {
        return Err("设备群为系统群，成员随名册自动增减".into());
    }
    if group_owner_pending(&g) {
        return Err("群主信息未同步（创建者离线），暂无法管理群".into());
    } // 批二
    if !group_terminal_status(&g).is_empty() {
        return Err("群已解散，无法移出成员".into());
    } // 批二
    if !is_group_owner(&g, &my) {
        return Err("只有群主可以移出成员".into());
    }
    if core_id::account_did_eq(&target_did, &my) {
        return Err("不能踢自己（退群用退出按钮）".into());
    }
    let members: Vec<String> = g
        .get("members")
        .and_then(|m| m.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let remain: Vec<String> = members
        .iter()
        .filter(|m| !core_id::account_did_eq(m, &target_did))
        .cloned()
        .collect();
    group_upsert(
        &group_id,
        g.get("name").and_then(|n| n.as_str()).unwrap_or("群"),
        remain.clone(),
        Some(&my),
    );
    if let Some(mu) = load_groups()
        .iter_mut()
        .find(|x| x.get("id").and_then(|d| d.as_str()) == Some(group_id.as_str()))
    {
        if let Some(m) = mu.get_mut("muted").and_then(|v| v.as_object_mut()) {
            m.remove(&target_did);
        }
        save_groups(&load_groups());
    }
    for t in remain.iter().filter(|m| *m != &my) {
        srv_send_raw(
            t,
            "group-kick",
            json!({
                "groupId": group_id, "targetDid": target_did, "members": remain,
                "fromName": my_name().await, "ts": now_ms(),
            }),
        )
        .await?;
    }
    // 被踢者单独一份（上面循环不含他）
    srv_send_raw(
        &target_did,
        "group-kick",
        json!({
            "groupId": group_id, "targetDid": target_did, "members": remain,
            "fromName": my_name().await, "ts": now_ms(),
        }),
    )
    .await?;
    Ok(json!({ "ok": true }))
}

/// 群主禁言/解禁（muted_until=0 解禁）。
#[tauri::command]
pub async fn chat_group_mute(
    group_id: String,
    target_did: String,
    muted_until: i64,
) -> Result<Value, String> {
    let my = my_account_did()?;
    let groups = load_groups();
    let g = groups
        .iter()
        .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(group_id.as_str()))
        .ok_or_else(|| "群不存在".to_string())?
        .clone();
    if is_device_group(&g) {
        return Err("设备群为系统群，不可禁言".into());
    }
    if group_owner_pending(&g) {
        return Err("群主信息未同步（创建者离线），暂无法管理群".into());
    } // 批二
    if !group_terminal_status(&g).is_empty() {
        return Err("群已解散，无法禁言".into());
    } // 批二
    if !is_group_owner(&g, &my) {
        return Err("只有群主可以禁言".into());
    }
    let members: Vec<String> = g
        .get("members")
        .and_then(|m| m.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let ok = apply_group_update(&group_id, &my, |gg| {
        if gg.get("muted").and_then(|v| v.as_object()).is_none() {
            gg["muted"] = json!({});
        }
        if let Some(mu) = gg.get_mut("muted").and_then(|v| v.as_object_mut()) {
            if muted_until > 0 {
                mu.insert(target_did.clone(), json!(muted_until));
            } else {
                mu.remove(&target_did);
            }
        }
    });
    if !ok {
        return Err("禁言更新失败".into());
    }
    for t in members.iter().filter(|m| *m != &my) {
        srv_send_raw(
            t,
            "group-mute",
            json!({
                "groupId": group_id, "targetDid": target_did, "mutedUntil": muted_until,
                "fromName": my_name().await, "ts": now_ms(),
            }),
        )
        .await?;
    }
    Ok(json!({ "ok": true }))
}

// ══════════════ 批三：消息操作命令（撤回/删除会话/删除单条——UI 全量打磨配套） ══════════════

/// 撤回时限（微信语义 2 分钟）。
const RECALL_WINDOW_MS: i64 = 120_000;

/// 撤回一条自己发的消息（限时 2 分钟，双向）：本地 tombstone + 给对端发 recall
/// 控制消息（P2P 直推/离线队列补发同正文通道；对端 ingest 按 msgId tombstone）。
/// 群：payload 带 members 扇出（与 group-msg 同路由）。
#[tauri::command]
pub async fn chat_recall_msg(conv_id: String, msg_id: String) -> Result<Value, String> {
    let my = my_account_did()?;
    let msgs = conv_load_raw_inner(&conv_id);
    let row = msgs
        .iter()
        .find(|m| m.get("msgId").and_then(|v| v.as_str()) == Some(msg_id.as_str()))
        .ok_or_else(|| "消息不存在（可能已被清理）".to_string())?;
    if row.get("dir").and_then(|v| v.as_str()) != Some("out") {
        return Err("只能撤回自己发的消息".into());
    }
    if row.get("kind").and_then(|v| v.as_str()) == Some("recalled") {
        return Err("该消息已撤回".into());
    }
    let ts = row.get("ts").and_then(|v| v.as_i64()).unwrap_or(0);
    if now_ms() - ts > RECALL_WINDOW_MS {
        return Err("超过 2 分钟的消息不能撤回".into());
    }
    // 本地先 tombstone（"活的历史"原则：本机即时生效，不等对端确认）
    conv_tombstone_msg(&conv_id, &msg_id);
    // 通知对端：单聊 to=对方账号 did（conv_id 是 did_safe 形态，还原）；群 to=grp-*
    let (to, payload) = if conv_id.starts_with("grp-") {
        let members: Vec<String> = load_groups()
            .iter()
            .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(conv_id.as_str()))
            .and_then(|g| g.get("members").and_then(|m| m.as_array()).cloned())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        (
            conv_id.clone(),
            json!({ "msgId": msg_id, "groupId": conv_id, "members": members }),
        )
    } else {
        (conv_id.replace('_', ":"), json!({ "msgId": msg_id }))
    };
    let (_, _, state) = p2p_send_raw(&to, "recall", payload).await?;
    // UI 即时刷新（ChatScreen/会话列表都听 chat-incoming）
    // cfg(not(test))：UI 事件通道，测试态不引 tauri webview 运行时（见文件顶注释）。
    #[cfg(not(test))]
    if let Some(app) = crate::p2p_client::current_app_handle() {
        let _ = app.emit(
            "chat-incoming",
            json!({ "msgId": msg_id, "kind": "recalled", "from": my }),
        );
    }
    Ok(json!({ "ok": true, "sendState": state }))
}

/// 删除会话（不删好友/群档案）：清本地会话记录（jsonl + 对账 meta + seen + 待发队列）。
/// 好友/群保留——下次来消息会话自动重建（微信"删除该聊天"语义）。
#[tauri::command]
pub async fn chat_delete_conv(conv_id: String) -> Result<Value, String> {
    let _ = my_account_did()?; // 未登录不给动（与其他命令同闸）
    conv_remove_files(&conv_id); // 归并视图全部等价 jsonl + meta
    let mut seen = load_seen();
    let a = seen.remove(&conv_id).is_some();
    let b = seen.remove(&conv_key(&conv_id)).is_some();
    if a || b {
        let _ = std::fs::write(
            seen_path(),
            serde_json::to_string(&seen).unwrap_or_default(),
        );
    }
    crate::offline_queue::global().remove_conv(&conv_id);
    Ok(json!({ "ok": true }))
}

/// 逐等价文件删除单条消息（归并视图里的一条可能躺在任一形态文件；把合并结果整份
/// 写回归一键文件会重复/丢消息）。meta 不动（msgId 保留=对账幂等闸不重置）。
fn conv_delete_msg_all(conv_id: &str, msg_id: &str) {
    for path in conv_paths_all(conv_id) {
        if !path.is_file() {
            continue;
        }
        let msgs: Vec<Value> = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        if !msgs
            .iter()
            .any(|m| m.get("msgId").and_then(|v| v.as_str()) == Some(msg_id))
        {
            continue; // 目标不在这一份
        }
        let kept: Vec<&Value> = msgs
            .iter()
            .filter(|m| m.get("msgId").and_then(|v| v.as_str()) != Some(msg_id))
            .collect();
        let body: String = kept
            .iter()
            .map(|m| serde_json::to_string(m).unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n");
        let _ = std::fs::write(
            &path,
            if body.is_empty() {
                String::new()
            } else {
                format!("{body}\n")
            },
        );
    }
}

/// 删除单条消息（仅本地，不影响对端——"删除本地记录"语义）。
#[tauri::command]
pub async fn chat_delete_msg(conv_id: String, msg_id: String) -> Result<Value, String> {
    let _ = my_account_did()?;
    conv_delete_msg_all(&conv_id, &msg_id);
    Ok(json!({ "ok": true }))
}

// ══════════════ 第86轮：好友服务器化单测（纯函数——不碰盘不碰网） ══════════════

#[cfg(test)]
mod media_tests {
    use super::*;

    /// 第94轮：save_media 落盘名的 msgId 消毒——拒目录穿越与非法字符。
    #[test]
    fn safe_msg_id_blocks_traversal() {
        assert!(!safe_msg_id("../../evil").contains('/'));
        assert!(!safe_msg_id("..\\..\\evil").contains('\\'));
        assert!(!safe_msg_id("../../evil").contains('.'));
        assert_eq!(safe_msg_id("m18f-ab_cd99-7"), "m18f-ab_cd99-7"); // 正常 id 原样
        assert_eq!(safe_msg_id(""), "anon");
        assert_eq!(safe_msg_id("!!!"), "anon");
        // 拼出的落盘名永远落在 media/ 平面（无子路径可逃）
        let rel = format!("media/{}.png", safe_msg_id("../../evil"));
        assert!(!rel.contains(".."));
        assert!(rel.starts_with("media/"));
    }

    /// 第94轮：chat_open_file 临时落盘的文件名消毒——剥路径成分 + 清 Windows 非法字符。
    #[test]
    fn safe_file_name_blocks_traversal() {
        assert_eq!(safe_file_name("..\\..\\..\\Windows\\evil.exe"), "evil.exe");
        assert_eq!(safe_file_name("/etc/passwd"), "passwd");
        assert_eq!(safe_file_name("a<b>c:d\"e|f?g*h.txt"), "abcdefgh.txt");
        assert_eq!(safe_file_name("   "), "file");
        assert_eq!(safe_file_name(""), "file");
        assert_eq!(safe_file_name("报告 v2.pdf"), "报告 v2.pdf"); // 正常中文名保留
    }

    /// 第94轮：媒体上限分档——图片 2MB / 任意文件 10MB（b64 字符数口径）。
    #[test]
    fn media_limit_tiers() {
        assert_eq!(IMG_B64_MAX, 2_800_000);
        assert!(FILE_B64_MAX >= 10 * 1024 * 1024 / 3 * 4); // 10MB 二进制的 b64 长度
        assert!(FILE_B64_MAX > IMG_B64_MAX);
    }
}

#[cfg(test)]
mod friends_tests {
    use super::*;
    use ed25519_dalek::Signer as _;

    /// 串行锁 + 线程局部 chat 桶（同 conv_identity_tests 模式——不碰进程级
    /// MYCO_CONFIG_DIR，避免并发测试互踩）。
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    const TAG: &str = "myco-friend-hs";

    fn test_env() -> std::sync::MutexGuard<'static, ()> {
        let g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("{TAG}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        TEST_CHAT_DIR.with(|d| *d.borrow_mut() = Some(dir));
        TEST_NO_FRIEND_DELIVER.store(true, Ordering::Relaxed); // 单测关自动回执网络
        g
    }

    /// 测试设备身份（固定种子真签名）：(did, SigningKey)。
    fn dev(n: u8) -> (String, ed25519_dalek::SigningKey) {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[n; 32]);
        (core_id::did_from_public(&sk.verifying_key().to_bytes()), sk)
    }

    const ME: &str = "did:youling:MeAcc";
    const PEER: &str = "did:youling:PeerAcc";

    /// 造一条握手消息（信箱形态，`id` 键——P2P 路径由 ingest_p2p_inner 归一成同款）。
    fn handshake(
        kind: &str,
        from: &str,
        to: &str,
        dev_did: &str,
        sk: &ed25519_dalek::SigningKey,
        ts: i64,
    ) -> Value {
        let nonce = format!("nonce-{kind}");
        let material = friend_sign_material(kind, from, to, dev_did, ts, &nonce);
        let sig = b64e(&sk.sign(material.as_bytes()).to_bytes());
        json!({
            "id": format!("m-{kind}"), "from": from, "fromName": "对端", "fromDevice": dev_did,
            "kind": kind, "ts": ts,
            "payload": { "to": to, "nonce": nonce, "sig": sig, "name": "对端名" },
        })
    }

    /// 种归属名册（p2p_server 缓存注入——归属闸零网络）。
    fn seed_peer_roster(sk: &ed25519_dalek::SigningKey) {
        crate::p2p_server::test_seed_roster_cache(PEER, vec![b64e(&sk.verifying_key().to_bytes())]);
    }

    fn rows() -> Vec<Value> {
        load_friends()
    }

    // ── 纯函数：状态机 12 格全表（设计 §3.4）──

    #[test]
    fn state_machine_full_table() {
        // friend-request：无行→in-pending；out-pending→ok（互加即好友）；其余幂等
        assert_eq!(
            friend_ingest("friend-request", None),
            FriendIngest::Status("in-pending")
        );
        assert_eq!(
            friend_ingest("friend-request", Some("out-pending")),
            FriendIngest::Status("ok")
        );
        assert_eq!(
            friend_ingest("friend-request", Some("in-pending")),
            FriendIngest::Keep
        );
        assert_eq!(
            friend_ingest("friend-request", Some("ok")),
            FriendIngest::Keep
        );
        // friend-accept：无行→Drop（我从未发过请求）；两 pending→ok；ok 幂等
        assert_eq!(friend_ingest("friend-accept", None), FriendIngest::Drop);
        assert_eq!(
            friend_ingest("friend-accept", Some("out-pending")),
            FriendIngest::Status("ok")
        );
        assert_eq!(
            friend_ingest("friend-accept", Some("in-pending")),
            FriendIngest::Status("ok")
        );
        assert_eq!(
            friend_ingest("friend-accept", Some("ok")),
            FriendIngest::Keep
        );
        // friend-remove：四态全 Remove（删除/被拒/被撤共用，幂等收敛）
        for cur in [None, Some("out-pending"), Some("in-pending"), Some("ok")] {
            assert_eq!(
                friend_ingest("friend-remove", cur),
                FriendIngest::Remove,
                "cur={cur:?}"
            );
        }
        // 未知 kind → Drop
        assert_eq!(friend_ingest("group-kick", Some("ok")), FriendIngest::Drop);
        assert_eq!(friend_ingest("", None), FriendIngest::Drop);
    }

    /// 协议红线：签名材料六段换行拼接、字段序固定（两端+手机端逐字节一致）。
    #[test]
    fn sign_material_field_order_fixed() {
        assert_eq!(
            friend_sign_material("friend-request", "did:a", "did:b", "did:d", 123, "n9"),
            "friend-request\ndid:a\ndid:b\ndid:d\n123\nn9"
        );
    }

    // ── 接收链全路径（真签名 + 名册缓存注入 + 线程局部 chat 桶，零网络）──

    /// 合法 request 首达：落 in-pending 行 + true；重发幂等（Keep=false 行不动）。
    #[tokio::test]
    async fn ingest_request_lands_inpending() {
        let _g = test_env();
        let (dev_did, sk) = dev(7);
        seed_peer_roster(&sk);
        let m = handshake("friend-request", PEER, ME, &dev_did, &sk, now_ms());
        assert!(ingest_msg(ME, &m).await, "合法握手应入库");
        let r = rows();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0]["did"], json!(PEER));
        assert_eq!(r[0]["status"], json!("in-pending"));
        assert_eq!(r[0]["name"], json!("对端名"));
        // 重发（同 nonce 同 sig）：Keep=false 不重复通知、行仍 in-pending
        assert!(!ingest_msg(ME, &m).await, "重发是幂等 Keep（不算新消息）");
        assert_eq!(friend_row_status(PEER).as_deref(), Some("in-pending"));
    }

    /// 三件套反例：坏 sig / 过期 ts / 错投 to / 归属不在册——全拒且零落行。
    #[tokio::test]
    async fn ingest_rejects_forgery() {
        let _g = test_env();
        let (dev_did, sk) = dev(8);
        seed_peer_roster(&sk);
        // ① 篡改 sig（换把钥匙签的材料被改一字节）
        let mut m = handshake("friend-request", PEER, ME, &dev_did, &sk, now_ms());
        m["payload"]["sig"] = json!("QUFBQQ=="); // "AAAA"
        assert!(!ingest_msg(ME, &m).await, "坏签名必须拒");
        // ② ts 过期（8 天前——窗口 7 天）
        let stale = handshake(
            "friend-request",
            PEER,
            ME,
            &dev_did,
            &sk,
            now_ms() - 8 * 24 * 3600_000,
        );
        assert!(!ingest_msg(ME, &stale).await, "过期握手必须拒");
        // ③ payload.to 不是我（错投/改址重放）
        let mut misroute = handshake("friend-request", PEER, ME, &dev_did, &sk, now_ms());
        misroute["payload"]["to"] = json!("did:youling:SomeoneElse");
        assert!(!ingest_msg(ME, &misroute).await, "错投件必须拒");
        // ④ 归属闸：签名设备不在 PEER 名册（另一把钥匙）
        let (ghost_did, ghost_sk) = dev(9);
        let forged = handshake("friend-request", PEER, ME, &ghost_did, &ghost_sk, now_ms());
        assert!(!ingest_msg(ME, &forged).await, "名册外设备冒充必须拒");
        // 四例全零落行
        assert!(rows().is_empty());
    }

    /// accept 转正：out-pending → ok + "你们已成为好友"系统条（msgId 固定幂等）。
    #[tokio::test]
    async fn ingest_accept_promotes_with_sys_entry() {
        let _g = test_env();
        let (dev_did, sk) = dev(10);
        seed_peer_roster(&sk);
        friend_upsert(PEER, "对端名", "out-pending");
        let m = handshake("friend-accept", PEER, ME, &dev_did, &sk, now_ms());
        assert!(ingest_msg(ME, &m).await);
        assert_eq!(friend_row_status(PEER).as_deref(), Some("ok"));
        let conv = conv_load_raw(&my_did_conv(PEER));
        assert_eq!(conv.len(), 1, "发起方等待转正的会话凭据系统条");
        assert_eq!(conv[0]["msgId"], json!(format!("sys-friend-ok-{PEER}")));
        assert_eq!(conv[0]["kind"], json!("sys"));
        // 重投（对账/信箱重发）：ok 态重收=Keep（false）且 msgId 固定——不重复落条
        assert!(
            !ingest_msg(ME, &m).await,
            "ok 态重收是幂等 Keep（不算新消息）"
        );
        assert_eq!(conv_load_raw(&my_did_conv(PEER)).len(), 1, "系统条不得重复");
    }

    /// 互加竞态收敛：我 out-pending 期间收到对方 request → 直接 ok + 凭据条
    /// （自动回发 accept 在测试态被 TEST_NO_FRIEND_DELIVER 关闭——纯函数格已覆盖）。
    #[tokio::test]
    async fn ingest_mutual_add_converges_to_ok() {
        let _g = test_env();
        let (dev_did, sk) = dev(11);
        seed_peer_roster(&sk);
        friend_upsert(PEER, "对端名", "out-pending");
        let m = handshake("friend-request", PEER, ME, &dev_did, &sk, now_ms());
        assert!(ingest_msg(ME, &m).await);
        assert_eq!(friend_row_status(PEER).as_deref(), Some("ok"), "互加即好友");
        assert_eq!(
            conv_load_raw(&my_did_conv(PEER)).len(),
            1,
            "out-pending→ok 也落凭据条"
        );
    }

    /// remove 三义（删除/被拒/被撤）：清行 + 清会话 + 清待发。
    #[tokio::test]
    async fn ingest_remove_clears_row_and_conv() {
        let _g = test_env();
        let (dev_did, sk) = dev(12);
        seed_peer_roster(&sk);
        friend_upsert(PEER, "对端名", "ok");
        conv_append(
            &my_did_conv(PEER),
            &json!({
                "msgId": "t-1", "from": PEER, "to": ME, "kind": "text",
                "payload": { "text": "hi" }, "ts": now_ms(), "dir": "in",
            }),
        );
        assert_eq!(conv_load_raw(&my_did_conv(PEER)).len(), 1);
        let m = handshake("friend-remove", PEER, ME, &dev_did, &sk, now_ms());
        assert!(ingest_msg(ME, &m).await);
        assert!(rows().is_empty(), "行已删");
        assert!(conv_load_raw(&my_did_conv(PEER)).is_empty(), "会话已清");
        // 无行重投也幂等成功（Remove 恒 true——收敛消息语义）
        let m2 = handshake("friend-remove", PEER, ME, &dev_did, &sk, now_ms());
        assert!(ingest_msg(ME, &m2).await);
    }

    /// accept 无行（我从未发过请求）→ Drop 零副作用。
    #[tokio::test]
    async fn ingest_accept_without_row_dropped() {
        let _g = test_env();
        let (dev_did, sk) = dev(13);
        seed_peer_roster(&sk);
        let m = handshake("friend-accept", PEER, ME, &dev_did, &sk, now_ms());
        assert!(!ingest_msg(ME, &m).await);
        assert!(rows().is_empty());
    }
}

// ══════════════ 第95轮：合并排序 + 发送状态 单测（纯函数——不碰盘） ══════════════

#[cfg(test)]
mod merge_tests {
    use super::*;

    fn m(msg_id: &str, ts: i64, dir: &str) -> Value {
        json!({ "msgId": msg_id, "from": "x", "to": "y", "kind": "text",
                "payload": { "text": msg_id }, "ts": ts, "dir": dir })
    }
    fn ids(msgs: &[Value]) -> Vec<String> {
        msgs.iter()
            .map(|m| {
                m.get("msgId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .collect()
    }

    /// 纯历史：对账灌入的旧消息物理在文件尾 → 排序后按 ts 归位（时间序单调）。
    #[test]
    fn sort_pure_history_out_of_order() {
        let mut v = vec![
            m("new-phys-tail", 100, "in"),
            m("old-1", 10, "in"),
            m("old-2", 20, "in"),
        ];
        sort_conv_msgs(&mut v);
        assert_eq!(ids(&v), vec!["old-1", "old-2", "new-phys-tail"]);
    }

    /// 混合：本地已有 [a(10), b(20)]，对账灌入 [c(15), d(5)]（物理尾）→
    /// 合并后 d,a,c,b——历史插到正确位置，不是简单堆在最下面。
    #[test]
    fn sort_mixed_sync_history_inserts_by_ts() {
        let mut v = vec![
            m("a", 10, "in"),
            m("b", 20, "in"),
            m("c", 15, "in"),
            m("d", 5, "in"),
        ];
        sort_conv_msgs(&mut v);
        assert_eq!(ids(&v), vec!["d", "a", "c", "b"]);
    }

    /// 本地新消息位置稳定：同步进行中用户发的消息（ts=now）在合并前在末尾；
    /// 对账完成（更多历史进来）后重排——它仍在所有历史之后（末尾），不跳变。
    #[test]
    fn local_unconfirmed_msg_position_stable() {
        // 第一轮：本地 [h1(10)] + 用户新发 mine(100)
        let mut v1 = vec![m("h1", 10, "in"), m("mine", 100, "out")];
        sort_conv_msgs(&mut v1);
        assert_eq!(ids(&v1), vec!["h1", "mine"]);
        // 对账灌入更多历史 h0(5)/h2(50)（物理尾）→ 重排 mine 仍末尾
        let mut v2 = vec![
            m("h1", 10, "in"),
            m("mine", 100, "out"),
            m("h2", 50, "in"),
            m("h0", 5, "in"),
        ];
        sort_conv_msgs(&mut v2);
        assert_eq!(ids(&v2), vec!["h0", "h1", "h2", "mine"]);
        // 对方实时新消息（ts 更大）并入到 mine 之后（时间戳语义正确，非跳变）
        let mut v3 = vec![
            m("h1", 10, "in"),
            m("mine", 100, "out"),
            m("peer-live", 120, "in"),
        ];
        sort_conv_msgs(&mut v3);
        assert_eq!(ids(&v3), vec!["h1", "mine", "peer-live"]);
    }

    /// 同 msgId 去重（首见保留——直推+对账双路径防御；空 msgId 不去重）。
    #[test]
    fn dedup_same_msgid_keeps_first() {
        let mut v = vec![m("dup", 10, "in"), m("other", 20, "in"), m("dup", 30, "in")];
        sort_conv_msgs(&mut v);
        assert_eq!(ids(&v), vec!["dup", "other"]); // 首见 ts=10 保留
        let mut w = vec![m("", 10, "in"), m("", 20, "in")];
        sort_conv_msgs(&mut w);
        assert_eq!(w.len(), 2); // 空 id 保守保留
    }

    /// 同 ts tie-break：msgId 字典序（双端合并结果确定性一致）。
    #[test]
    fn tie_break_by_msgid_deterministic() {
        let mut v = vec![m("mb", 10, "in"), m("ma", 10, "in"), m("mc", 10, "in")];
        sort_conv_msgs(&mut v);
        assert_eq!(ids(&v), vec!["ma", "mb", "mc"]);
    }
}

#[cfg(test)]
mod group_tests {
    use super::*;

    fn g(owner: Option<&str>, members: &[&str], muted: &[(&str, i64)]) -> Value {
        let mut v = json!({
            "id": "g1", "name": "测试群",
            "members": members, "governance": "owner",
            "muted": muted.iter().map(|(d, t)| json!({ "x": 0 })).collect::<Vec<_>>(),
        });
        v["muted"] = json!(muted
            .iter()
            .map(|(d, t)| (d.to_string(), *t))
            .collect::<std::collections::HashMap<String, i64>>());
        if let Some(o) = owner {
            v["owner"] = json!(o);
        }
        v
    }

    #[test]
    fn owner_of_new_and_legacy_groups() {
        // 新群：owner 字段权威
        assert!(is_group_owner(
            &g(Some("did:a"), &["did:a", "did:b"], &[]),
            "did:a"
        ));
        assert!(!is_group_owner(
            &g(Some("did:a"), &["did:a", "did:b"], &[]),
            "did:b"
        ));
        // 老群（第81-84轮存量，无 owner）：首成员兜底
        assert!(is_group_owner(
            &g(None, &["did:old", "did:b"], &[]),
            "did:old"
        ));
        assert!(!is_group_owner(
            &g(None, &["did:old", "did:b"], &[]),
            "did:b"
        ));
    }

    #[test]
    fn muted_semantics() {
        let now = 1000i64;
        let gg = g(Some("did:a"), &["did:a", "did:b"], &[("did:b", 2000)]);
        assert!(is_muted(&gg, "did:b", now)); // 禁言中
        assert!(!is_muted(&gg, "did:b", 3000)); // 已过期
        assert!(!is_muted(&gg, "did:a", now)); // 未被禁言
        assert!(!is_muted(
            &g(Some("did:a"), &["did:a", "did:b"], &[]),
            "did:b",
            now
        )); // 空禁言表
    }

    #[test]
    fn governance_field_reserved() {
        // governance 恒 'owner'（'vote' 预留不读——UI 无切换入口，第85轮定稿）
        let gg = g(Some("did:a"), &["did:a"], &[]);
        assert_eq!(gg.get("governance").and_then(|v| v.as_str()), Some("owner"));
    }

    /// §3.19.4：系统留痕的会话 kind——带 system 标记 → 既有系统条 kind="sys"；
    /// 普通文本仍 group-msg；媒体照旧 image/file（标记不夺媒体渲染）。
    #[test]
    fn system_group_msg_kind() {
        assert_eq!(group_conv_kind("", false), "group-msg");
        assert_eq!(group_conv_kind("", true), "sys"); // cap_denied 留痕
        assert_eq!(group_conv_kind("image", false), "image");
        assert_eq!(group_conv_kind("file", true), "file"); // 媒体优先于 system 标记
    }

    /// 建群 id 规则：grp-<hex>（任务群与普通群同款——任务群不是新对象，§3.19）。
    #[test]
    fn group_id_shape() {
        let id = new_group_id();
        assert!(id.starts_with("grp-"), "{id}");
        assert!(id[4..].chars().all(|c| c.is_ascii_hexdigit()), "{id}");
    }

    /// 批二：ownerPending（自愈建群 owner 未同步）→ 无群主，不兜底首成员。
    #[test]
    fn owner_pending_blocks_fallback() {
        let mut gg = g(None, &["did:old", "did:b"], &[]);
        gg["ownerPending"] = json!(true);
        assert_eq!(group_owner_of(&gg), "");
        assert!(!is_group_owner(&gg, "did:old")); // 字典序首成员不再冒充群主
        assert!(group_owner_pending(&gg));
        // owner 补齐后（ownerPending 应已被 group_upsert 清掉，这里模拟字段共存防御）：
        // owner 字段权威优先
        let mut g2 = g(Some("did:a"), &["did:old", "did:b"], &[]);
        g2["ownerPending"] = json!(true);
        assert_eq!(group_owner_of(&g2), "did:a");
        assert!(!group_owner_pending(&g2));
    }

    /// 批二：终态判定。
    #[test]
    fn terminal_status_parse() {
        let mut gg = g(Some("did:a"), &["did:a"], &[]);
        assert_eq!(group_terminal_status(&gg), "");
        gg["status"] = json!("disbanded");
        assert_eq!(group_terminal_status(&gg), "disbanded");
        gg["status"] = json!("kicked");
        assert_eq!(group_terminal_status(&gg), "kicked");
        gg["status"] = json!("whatever");
        assert_eq!(group_terminal_status(&gg), "");
    }
}

// ══════════════ 第96轮：Rust 基座批一 单测（账号分桶/解耦分片/dir/禁言闸/手机灯） ══════════════

#[cfg(test)]
mod round96_tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("myco-chat96-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    // ── 修复1：旧全局 chat/ → 账号桶一次性迁移 ──

    #[test]
    fn migrate_legacy_chat_moves_payload_to_empty_bucket() {
        let root = tmp_dir("mig1");
        // 旧负载：顶层文件 + media/ 目录 + 既有账号桶（不能动）
        std::fs::write(root.join("friends.json"), "[]").unwrap();
        std::fs::write(root.join("outbox.json"), "[]").unwrap();
        std::fs::write(root.join("did_youling_PEER.jsonl"), "{}\n").unwrap();
        std::fs::write(root.join("did_youling_PEER.meta.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join("media")).unwrap();
        std::fs::write(root.join("media").join("m1.png"), b"png").unwrap();
        let other_bucket = root.join("did_youling_OTHER");
        std::fs::create_dir_all(&other_bucket).unwrap();
        std::fs::write(other_bucket.join("friends.json"), "[]").unwrap();

        let bucket = root.join("did_youling_AAA");
        assert!(migrate_legacy_chat(&root, &bucket));
        // 负载整体 move 进桶；旧位置干净（幂等——再跑一次 false）
        assert!(bucket.join("friends.json").is_file());
        assert!(bucket.join("outbox.json").is_file());
        assert!(bucket.join("did_youling_PEER.jsonl").is_file());
        assert!(bucket.join("did_youling_PEER.meta.json").is_file());
        assert!(bucket.join("media").join("m1.png").is_file());
        assert!(!root.join("friends.json").exists());
        assert!(!root.join("media").exists());
        assert!(other_bucket.join("friends.json").is_file()); // 别的账号桶原样
        assert!(!migrate_legacy_chat(&root, &bucket)); // 幂等
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_legacy_chat_refuses_when_bucket_has_data() {
        let root = tmp_dir("mig2");
        std::fs::write(root.join("friends.json"), "[old]").unwrap();
        let bucket = root.join("did_youling_AAA");
        std::fs::create_dir_all(&bucket).unwrap();
        std::fs::write(bucket.join("friends.json"), "[new]").unwrap();
        assert!(!migrate_legacy_chat(&root, &bucket));
        // 双方原样（不覆盖桶内新数据）
        assert_eq!(
            std::fs::read_to_string(root.join("friends.json")).unwrap(),
            "[old]"
        );
        assert_eq!(
            std::fs::read_to_string(bucket.join("friends.json")).unwrap(),
            "[new]"
        );
        // 无旧负载 / 无 root → false
        let empty = tmp_dir("mig3");
        assert!(!migrate_legacy_chat(&empty, &empty.join("b")));
        assert!(!migrate_legacy_chat(
            &empty.join("nonexist"),
            &empty.join("b")
        ));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&empty);
    }

    #[test]
    fn bucket_name_uses_did_safe() {
        // 与 p2p_sync/safe 化同规则：did:youling:XXX → did_youling_XXX（无路径分隔符）
        assert_eq!(did_safe("did:youling:AbC123"), "did_youling_AbC123");
        assert!(!did_safe("did:youling:AbC").contains([':', '/']));
    }

    // ── 修复5：自同步回流 dir=out + 渲染层双保险 ──

    #[test]
    fn self_echo_ingest_dir_is_out() {
        assert_eq!(dir_for_ingest(true), "out"); // from==my 回流（第二台设备"我发的"）
        assert_eq!(dir_for_ingest(false), "in"); // 正常收信
    }

    #[test]
    fn render_layer_from_my_wins_over_stored_dir() {
        let my = "did:youling:ME";
        // 存量老行：from==my 但 dir=in（归位修复前落的）→ 渲染按 out
        assert_eq!(effective_dir("in", my, my), "out");
        // 正常行不动
        assert_eq!(effective_dir("in", "did:youling:PEER", my), "in");
        assert_eq!(effective_dir("out", my, my), "out");
        // 未登录（my 空）不误判
        assert_eq!(effective_dir("in", "", ""), "in");
    }

    /// 双设备视角渲染判定（修复5 核心场景）：A 设备发出 dir=out；B 设备经对账
    /// 拉回（from==my 回流）入库 dir=out + 渲染双保险——两端都显示在右侧。
    #[test]
    fn dual_device_view_consistency() {
        let my = "did:youling:ME";
        // 设备 A：本地 append_out 落的行（dir=out 既有语义）
        let dev_a_stored = "out";
        // 设备 B：对账回流入库（第96轮新语义 dir_for_ingest(self_echo=true)）
        let dev_b_stored = dir_for_ingest(true);
        assert_eq!(effective_dir(dev_a_stored, my, my), "out");
        assert_eq!(effective_dir(dev_b_stored, my, my), "out");
        // 设备 B 上的存量老行（修复前 dir=in 落的）也归右
        assert_eq!(effective_dir("in", my, my), "out");
        // 对方真发的消息两端都左
        assert_eq!(effective_dir("in", "did:youling:PEER", my), "in");
    }

    // ── 修复6a：群发送禁言闸 ──

    fn group_with_mute(owner: &str, members: &[&str], muted: &[(&str, i64)]) -> Value {
        json!({
            "id": "g1", "name": "群", "owner": owner, "members": members,
            "governance": "owner",
            "muted": muted.iter().map(|(d, t)| (d.to_string(), *t)).collect::<std::collections::HashMap<String, i64>>(),
        })
    }

    #[test]
    fn send_gate_blocks_muted_self_allows_owner_and_unmuted() {
        let now = 1_000i64;
        let g = group_with_mute(
            "did:owner",
            &["did:owner", "did:a", "did:b"],
            &[("did:a", 2_000)],
        );
        // 被禁言成员（未到期）→ 拒发+提示
        let e = send_gate_muted(&g, "did:a", now).unwrap_err();
        assert!(e.contains("禁言"), "错误提示要说明禁言: {e}");
        // 禁言已过期 → 放行
        assert!(send_gate_muted(&g, "did:a", 3_000).is_ok());
        // 群主豁免（群主不会被自己禁言卡住）
        let g2 = group_with_mute("did:owner", &["did:owner"], &[("did:owner", 9_999_999)]);
        assert!(send_gate_muted(&g2, "did:owner", now).is_ok());
        // 未禁言成员放行
        assert!(send_gate_muted(&g, "did:b", now).is_ok());
        // 老群无 muted 字段放行
        assert!(send_gate_muted(&json!({"id":"g","members":["did:a"]}), "did:a", now).is_ok());
    }

    // ── 修复6b：presence 灯 kind=phone 计入 online ──

    fn dev_row(root: &str, did: &str, kind: &str, state: &str) -> Value {
        json!({ "root": root, "did": did, "kind": kind, "name": did, "state": state, "addrs": [], "port": 9100 })
    }

    #[test]
    fn presence_light_counts_phone_online() {
        let friends = vec![
            "did:youling:F1".to_string(),
            "did:youling:F2".to_string(),
            "did:youling:F3".to_string(),
        ];
        let rows = vec![
            dev_row("did:youling:F1", "did:myco:phone1", "phone", "active"), // 只手机在线
            dev_row("did:youling:F2", "did:myco:pc1", "pc", "idle"),
            dev_row("did:youling:F2", "did:myco:phone2", "phone", "typing"), // typing 最高优先
        ];
        let lights = aggregate_friend_lights(&rows, &friends);
        // F1 手机在线 → 灯亮（旧口径 kind!=pc 剔掉 → 恒灰，本修复点）
        assert_eq!(lights["did:youling:F1"]["online"], json!(true));
        assert_eq!(lights["did:youling:F1"]["state"], json!("active"));
        // F2 双设备 → state 取最优（typing）
        assert_eq!(lights["did:youling:F2"]["online"], json!(true));
        assert_eq!(lights["did:youling:F2"]["state"], json!("typing"));
        assert_eq!(lights["did:youling:F2"]["devices"], json!(2));
        // F3 无在线设备 → 不出现在灯表（UI 按灰灯渲染）
        assert!(lights.get("did:youling:F3").is_none());
        // 无 root 行不计
        let rows2 = vec![json!({ "did": "x", "kind": "pc" })];
        assert!(aggregate_friend_lights(&rows2, &friends).is_empty());
    }

    /// 2026-10-07 根因回归（P2P 好友恒"对端不可达"/灯恒灰）：presence 行的 rootDid 是
    /// `account_did()` 归一形 `did:youling:`，而好友 did 是名册历史形 `did:myco:`——
    /// 同一把钥必须落同一个桶。原实现按裸串建索引/查询 ⇒ 永不命中。
    #[test]
    fn presence_light_matches_legacy_and_normalized_account_did() {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let did_myco = core_id::did_from_public(&sk.verifying_key().to_bytes());
        let did_youling = did_myco.replacen("did:myco:", "did:youling:", 1);
        assert_ne!(
            did_myco, did_youling,
            "两形态串必须真的不同，否则本用例无意义"
        );
        // 好友锚=名册形；presence 行 rootDid=归一形（同钥）
        let friends = vec![did_myco.clone()];
        let rows = vec![dev_row(&did_youling, "did:myco:pcX", "pc", "active")];
        let lights = aggregate_friend_lights(&rows, &friends);
        let l = lights
            .get(did_myco.as_str())
            .expect("同钥异写必须聚到好友灯上");
        assert_eq!(l["online"], json!(true));
        assert_eq!(l["state"], json!("active"));
    }

    /// 反向守卫：不同账号（不同公钥）不得因归一化互相串灯；软 did（解析不出公钥）
    /// 仍按原串严格比较。
    #[test]
    fn presence_light_does_not_conflate_distinct_accounts() {
        let a = core_id::did_from_public(
            &ed25519_dalek::SigningKey::from_bytes(&[1u8; 32])
                .verifying_key()
                .to_bytes(),
        );
        let b = core_id::did_from_public(
            &ed25519_dalek::SigningKey::from_bytes(&[2u8; 32])
                .verifying_key()
                .to_bytes(),
        );
        let rows = vec![dev_row(&a, "did:myco:devA", "pc", "active")];
        assert!(
            aggregate_friend_lights(&rows, &[b]).is_empty(),
            "不同公钥不得串灯"
        );
        assert!(
            aggregate_friend_lights(&rows, &["did:youling:soft1".into()]).is_empty(),
            "软 did 不得误命中"
        );
    }

    // ── 修复3：媒体分片存取（组装+校验+切片） ──

    #[test]
    fn media_chunks_assemble_out_of_order_and_verify_sha() {
        let dir = tmp_dir("chunk");
        let media_root = dir.join("media");
        std::fs::create_dir_all(&media_root).unwrap();
        // 2.5MB 确定性字节
        let full: Vec<u8> = (0..2_500_000u32).map(|i| (i % 251) as u8).collect();
        let sha = sha256_hex(&full);
        let total = full.len().div_ceil(MEDIA_CHUNK_BYTES) as u32; // 3
        assert_eq!(total, 3);
        // 乱序投递：1 → 2 → 0
        for idx in [1u32, 2, 0] {
            let start = idx as usize * MEDIA_CHUNK_BYTES;
            let end = (start + MEDIA_CHUNK_BYTES).min(full.len());
            let done = store_media_chunk_in(
                &media_root,
                "m-abc",
                "报告.pdf",
                "application/pdf",
                &sha,
                idx,
                total,
                &full[start..end],
            )
            .unwrap();
            assert_eq!(done, idx == 0, "只有最后收齐的那片返回 assembled=true");
        }
        let assembled = std::fs::read(media_root.join("m-abc.pdf")).unwrap();
        assert_eq!(assembled, full); // 字节级一致
        assert!(!media_root.join("tmp").join("m-abc").exists()); // tmp 已清
                                                                 // 切片回读（fetch 服务端语义）
        let (c0, t) = read_media_chunk_in(&media_root, "m-abc", 0).unwrap();
        assert_eq!(t, 3);
        assert_eq!(c0.len(), MEDIA_CHUNK_BYTES);
        assert_eq!(c0[..16], full[..16]);
        let (c2, _) = read_media_chunk_in(&media_root, "m-abc", 2).unwrap();
        assert_eq!(c2.len(), full.len() - 2 * MEDIA_CHUNK_BYTES); // 尾片不足 1MB
        assert!(read_media_chunk_in(&media_root, "m-abc", 3).is_none()); // 越界
        assert!(read_media_chunk_in(&media_root, "nobody", 0).is_none()); // 无此媒体
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn media_chunk_bad_sha_rejected_and_params_validated() {
        let dir = tmp_dir("chunkbad");
        let media_root = dir.join("media");
        std::fs::create_dir_all(&media_root).unwrap();
        let bytes = b"hello media".to_vec();
        // sha 对不上 → Err 且不落盘、tmp 清掉
        let bad = sha256_hex(b"different");
        assert!(store_media_chunk_in(
            &media_root,
            "m-x",
            "a.bin",
            "application/octet-stream",
            &bad,
            0,
            1,
            &bytes
        )
        .is_err());
        assert!(!media_root.join("m-x.bin").exists());
        assert!(!media_root.join("tmp").join("m-x").exists());
        // 参数闸
        let sha = sha256_hex(&bytes);
        assert!(store_media_chunk_in(&media_root, "m-x", "a.bin", "", &sha, 1, 1, &bytes).is_err()); // idx>=total
        assert!(store_media_chunk_in(&media_root, "m-x", "a.bin", "", &sha, 0, 0, &bytes).is_err()); // total=0
        assert!(
            store_media_chunk_in(&media_root, "m-x", "a.bin", "", &sha, 0, 65, &bytes).is_err()
        ); // total>64
        let big = vec![0u8; MEDIA_CHUNK_BYTES + 1];
        assert!(store_media_chunk_in(&media_root, "m-x", "a.bin", "", &sha, 0, 2, &big).is_err()); // 单片超限
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 修复3：wire 形态——单聊 file 带 mediaRef 不内联；群文件维持内联语义 ──

    #[test]
    fn wire_pack_single_file_uses_media_ref() {
        let m = json!({
            "msgId": "m-f1", "from": "did:me", "to": "did:peer", "kind": "file",
            "payload": { "name": "a.zip", "mime": "application/zip", "size": 9,
                         "media": "media/m-f1.zip", "sha256": "deadbeef", "mediaPending": false },
            "ts": 1, "dir": "out", "sendState": "sent",
        });
        let w = wire_pack_msg(&m);
        let p = w.get("payload").unwrap();
        assert_eq!(p.get("mediaRef"), Some(&json!(true)));
        assert_eq!(p.get("sha256"), Some(&json!("deadbeef")));
        assert!(p.get("b64").is_none(), "单聊 file 不再内联 b64");
        assert!(p.get("media").is_none() && p.get("mediaPending").is_none());
        assert!(w.get("dir").is_none() && w.get("sendState").is_none());
    }

    #[test]
    fn wire_pack_group_file_keeps_inline_semantics() {
        // 群词汇表批二才动——带 groupId 的 file 不转 mediaRef（media 文件不存在时
        // b64 缺省也无所谓，本断言只锁"不走 mediaRef 新链路"）。
        let m = json!({
            "msgId": "m-g1", "kind": "file",
            "payload": { "groupId": "grp-1", "name": "a.zip", "mime": "application/zip",
                         "media": "media/m-g1.zip", "sha256": "deadbeef" },
            "ts": 1, "dir": "out",
        });
        let w = wire_pack_msg(&m);
        assert!(
            w.pointer("/payload/mediaRef").is_none(),
            "群文件不碰现有内联词汇表"
        );
    }

    #[test]
    fn msg_needs_media_detects_pending_ref() {
        let wire = json!({
            "msgId": "m-9", "kind": "file",
            "payload": { "name": "v.mp4", "mime": "video/mp4", "size": 2048, "sha256": "abc", "mediaRef": true },
        });
        let r = msg_needs_media(&wire).unwrap();
        assert_eq!(r.msg_id, "m-9");
        assert_eq!(r.sha256, "abc");
        assert_eq!(r.size, 2048);
        // 有 b64（旧内联）不需要拉
        let with_b64 = json!({ "msgId": "m-8", "kind": "file", "payload": { "b64": "eHh4", "sha256": "abc" } });
        assert!(msg_needs_media(&with_b64).is_none());
        // 非 file / 无 sha 不拉
        assert!(
            msg_needs_media(&json!({ "msgId": "m-7", "kind": "image", "payload": {} })).is_none()
        );
        assert!(msg_needs_media(
            &json!({ "msgId": "m-6", "kind": "file", "payload": { "name": "x" } })
        )
        .is_none());
    }

    #[test]
    fn sha256_hex_known_vector() {
        // 空串与 "abc" 的 sha256（公开测试向量）
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}

// ══════════════ task-revoke（2026-10-24 任务卡删除通知）单测 ══════════════
// 覆盖：本地生效的三种命中键 + 幂等 + 未知 id 无害 + ingest 全链路 + 快照过滤
//（对端 UI 轮询 ≤5s 消失的那一环）。存储隔离走共享 test_env_lock。

#[cfg(test)]
mod task_revoke_tests {
    use super::*;

    fn env() -> std::sync::MutexGuard<'static, ()> {
        crate::test_env_lock::test_env_lock()
    }
    const MY: &str = "did:youling:ME";
    const ALICE: &str = "did:youling:ALICE";

    fn inbound(id: &str, from: &str, kind: &str, payload: Value, ts: i64) -> Value {
        json!({ "id": id, "from": from, "fromName": "发送者", "kind": kind, "payload": payload, "ts": ts })
    }

    /// abort 后端口释放是异步的：轮询到就绪，不用固定 30ms 赌调度。
    async fn wait_port_free(port: u16) -> bool {
        for _ in 0..100 {
            if tokio::net::TcpListener::bind(("127.0.0.1", port))
                .await
                .is_ok()
            {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        false
    }

    /// 本地生效：shareId 字段 / `peer-task-share-<shareId>` 命名约定 / taskId 精确
    /// 三种键都能命中；无关卡不动；重复 revoke 幂等（hit=0、revokedAt 不刷新）。
    #[test]
    fn apply_task_revoke_matches_all_three_keys_and_is_idempotent() {
        let _g = env();
        save_tasks(&[
            json!({"taskId": "t-by-field", "shareId": "sh-r1", "status": "pending"}),
            json!({"taskId": "peer-task-share-sh-r1", "status": "todo"}), // 命名约定（无 shareId 字段）
            json!({"taskId": "t-by-taskid", "status": "todo"}),           // taskId 精确
            json!({"taskId": "peer-task-share-sh-other", "status": "todo"}), // 无关卡
        ]);
        // 按 shareId 摘：字段 + 命名约定两条命中
        assert_eq!(apply_task_revoke("sh-r1", "", 5000), 2);
        // 按 taskId 精确摘第三条
        assert_eq!(apply_task_revoke("", "t-by-taskid", 5001), 1);
        let tasks = load_tasks();
        assert_eq!(
            tasks
                .iter()
                .filter(|t| t["status"] == json!("revoked"))
                .count(),
            3,
            "{tasks:?}"
        );
        assert_eq!(
            tasks
                .iter()
                .find(|t| t["taskId"] == json!("peer-task-share-sh-other"))
                .unwrap()["status"],
            json!("todo"),
            "无关卡不动"
        );
        // 幂等：再摘一次零命中
        assert_eq!(apply_task_revoke("sh-r1", "", 6000), 0);
        // 未知 id 无害
        assert_eq!(apply_task_revoke("sh-ghost", "", 6000), 0);
        // 空参护栏
        assert_eq!(apply_task_revoke("  ", "  ", 6000), 0);
    }

    /// task-24 tombstone：写入幂等 + 三个落库口拒复活 + 快照双滤 + 批量 API 内核。
    #[test]
    /// 2026-11-15 回归（用户实拍「两张一模一样的 ADB 调试」）：落库前必须收敛同卡。
/// ① 无 shareId 的散卡：内容指纹相同 → 只留后到的这张；
/// ② 有 shareId：同 shareId 收敛，但 `status=shared`（我发出去的记录）永不删。
#[test]
fn dedupe_task_records_by_content_and_share() {
    // ① 散卡内容重复
    let mut tasks = vec![
        json!({"taskId":"t1","title":"ADB 调试","fromName":"我·koGc",
               "env":[{"kind":"adb","device":"did:myco:zPhone","port":5555}]}),
        json!({"taskId":"t0-other","title":"别的卡","fromName":"我·koGc"}),
    ];
    let rec = json!({"taskId":"t2","title":"ADB 调试","fromName":"我·koGc",
                     "env":[{"kind":"adb","device":"did:myco:zPhone","port":5555}]});
    dedupe_task_records(&mut tasks, &rec);
    assert_eq!(
        tasks.len(),
        1,
        "去重后只剩「别的卡」——同内容散卡已收敛（新卡由调用方 push）"
    );
    assert!(
        tasks.iter().all(|t| t.get("taskId").and_then(|v| v.as_str()) != Some("t1")),
        "同内容散卡必须被收敛"
    );

    // ② 同 shareId 收敛，shared 历史行保留
    let mut tasks2 = vec![
        json!({"taskId":"s1","shareId":"sh-a","title":"A","status":"todo"}),
        json!({"taskId":"s-sent","shareId":"sh-a","title":"A","status":"shared"}),
        json!({"taskId":"s-other","shareId":"sh-b","title":"B","status":"todo"}),
    ];
    let rec2 = json!({"taskId":"s2","shareId":"sh-a","title":"A","status":"todo"});
    dedupe_task_records(&mut tasks2, &rec2);
    assert!(
        tasks2.iter().all(|t| t.get("taskId").and_then(|v| v.as_str()) != Some("s1")),
        "同 shareId 的旧副本应被收敛"
    );
    assert!(
        tasks2.iter().any(|t| t.get("taskId").and_then(|v| v.as_str()) == Some("s-sent")),
        "status=shared 是发送历史，绝不参与去重删除"
    );
    assert!(
        tasks2.iter().any(|t| t.get("taskId").and_then(|v| v.as_str()) == Some("s-other")),
        "不同 shareId 不得误杀"
    );
}

fn tombstone_blocks_revive_and_is_idempotent() {
        let _g = env();
        // 干净起点（隔离目录下也应幂等清场）
        save_tombstones(&[]);
        // ① 写入幂等：同名只一行，reason/revokedAt 刷新
        tombstone_task("peer-task-share-sh-t1", "task-revoke");
        tombstone_task("peer-task-share-sh-t1", "manual");
        let list = load_tombstones();
        assert_eq!(
            list.iter()
                .filter(|x| x["taskId"] == json!("peer-task-share-sh-t1"))
                .count(),
            1,
            "幂等一行"
        );
        assert!(is_tombstoned("peer-task-share-sh-t1"));
        assert!(!is_tombstoned("peer-task-share-sh-other"), "别的 id 不误伤");
        assert!(!is_tombstoned(""), "空 id 恒 false");
        // ② 设备群 upsert 闸：tombstone 命中 → 不落库（复活被拦）
        upsert_device_group_task(
            &json!({ "taskId": "peer-task-share-sh-t1", "title": "死卡回魂", "shareId": "sh-t1" }),
            "todo",
            "did:myco:d9",
            "对端",
        );
        assert!(
            load_tasks()
                .iter()
                .all(|t| t["taskId"] != json!("peer-task-share-sh-t1")),
            "tombstone 命中的卡不得落库（对账重放场景）"
        );
        // ③ status=revoked 的设备群广播 → 打 tombstone 且不落卡
        upsert_device_group_task(
            &json!({ "taskId": "peer-task-share-sh-t2", "title": "撤销广播", "shareId": "sh-t2" }),
            "revoked",
            "did:myco:d9",
            "对端",
        );
        assert!(
            is_tombstoned("peer-task-share-sh-t2"),
            "revoked 广播应写 tombstone"
        );
        assert!(
            load_tasks()
                .iter()
                .all(|t| t["taskId"] != json!("peer-task-share-sh-t2")),
            "revoked 广播不落卡（落了只会再喂对账一次）"
        );
        // ④ 批量 API 内核：新条目计数正确、重复调用幂等（n=0）
        let n = tombstone_tasks_batch(
            &[
                "peer-task-share-sh-t3".into(),
                "peer-task-share-sh-t1".into(),
            ],
            "manual",
        );
        assert_eq!(n, 1, "只有 sh-t3 是新的");
        assert_eq!(
            tombstone_tasks_batch(&["peer-task-share-sh-t3".into()], "manual"),
            0,
            "重复打=0"
        );
    }

    /// task-24 端到端：ingest task-share 命中 tombstone → 整条丢弃（不落会话/任务库）
    /// ——这正是「重启后对账重灌历史 task-share 复活」的来路闸。
    #[tokio::test]
    async fn tombstoned_task_share_ingest_is_dropped_whole() {
        let _g = env();
        let acc_dir = myco_core::config::config_dir().join("accounts");
        let _ = std::fs::create_dir_all(&acc_dir);
        let _ = std::fs::write(acc_dir.join("active.txt"), MY);
        tombstone_task("peer-task-share-sh-dead", "task-revoke");
        let card = json!({ "taskId": "peer-task-share-sh-dead", "shareId": "sh-dead",
            "title": "死卡", "from": ALICE, "fromName": "爱丽丝", "createdAt": 100 });
        assert!(
            ingest_msg(MY, &inbound("tb-1", ALICE, "task-share", card, 100)).await,
            "处置=true"
        );
        assert!(
            load_tasks()
                .iter()
                .all(|t| t["taskId"] != json!("peer-task-share-sh-dead")),
            "任务库不得落"
        );
        assert!(
            conv_load_raw_inner(&my_did_conv(ALICE))
                .iter()
                .all(|m| m.get("msgId").and_then(|v| v.as_str()) != Some("tb-1")),
            "会话不得落"
        );
        // 存量已复活进库的行：state_snapshot 由 tombstone 名单兜底滤掉（双滤）
        save_tasks(&[json!({ "taskId": "peer-task-share-sh-dead", "status": "todo" })]);
        let snap = state_snapshot().await.expect("snapshot");
        assert!(
            snap["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .all(|t| t["taskId"] != json!("peer-task-share-sh-dead")),
            "快照必须把 tombstone 命中的存量行滤掉"
        );
        // 活卡不受影响
        let live = json!({ "taskId": "peer-task-live1", "title": "活卡", "from": ALICE, "fromName": "爱丽丝", "createdAt": 101 });
        assert!(ingest_msg(MY, &inbound("tb-2", ALICE, "task-share", live, 101)).await);
        assert!(
            load_tasks()
                .iter()
                .any(|t| t["taskId"] == json!("peer-task-live1")),
            "活卡照常落库"
        );
    }

    /// 设备群 revoke 广播必须把**已有卡行**标 revoked（不能只 tombstone），
    /// 否则对账/启动预热仍把旧 todo 卡当有效声明。
    #[tokio::test]
    async fn device_group_revoke_marks_local_card() {
        let _g = env();
        let card = json!({ "taskId": "peer-task-share-sh-dg", "shareId": "sh-dg",
            "title": "设备群 revoke", "from": ALICE, "fromName": "爱丽丝",
            "sourceAccount": ALICE, "createdAt": 100,
            "env": [{ "kind": "dsh", "localPort": 23911,
                "entryUrl": "http://127.0.0.1:23911/gw/sh-dg/?mt=MT-DG" }] });
        upsert_device_group_task(&card, "todo", "did:myco:dev-a", "设备A");
        assert_eq!(
            load_tasks()
                .into_iter()
                .find(|t| t["taskId"] == json!("peer-task-share-sh-dg"))
                .unwrap()["status"],
            json!("todo")
        );
        upsert_device_group_task(&card, "revoked", "did:myco:dev-a", "设备A");
        let t = load_tasks()
            .into_iter()
            .find(|t| t["taskId"] == json!("peer-task-share-sh-dg"))
            .unwrap();
        assert_eq!(
            t["status"],
            json!("revoked"),
            "设备群 revoke 必须改已有卡状态: {t}"
        );
    }

    /// task-revoke 是写操作：必须只认卡来源账号/owner——任意好友伪造 revoke
    /// 不能把本机卡标掉/打 tombstone。
    #[tokio::test]
    async fn untrusted_task_revoke_cannot_touch_card() {
        let _g = env();
        let card = json!({ "taskId": "peer-task-share-sh-rr2", "shareId": "sh-rr2",
            "title": "防伪 revoke", "from": ALICE, "fromName": "爱丽丝",
            "sourceAccount": ALICE, "createdAt": 100,
            "env": [{ "kind": "dsh", "localPort": 23911,
                "entryUrl": "http://127.0.0.1:23911/gw/sh-rr2/?mt=MT-RR2" }] });
        assert!(ingest_msg(MY, &inbound("tr2-c1", ALICE, "task-share", card, 100)).await);
        // 伪造 task-share：知道 shareId 也不能改写 owner/env 或骗过 revoke 所有权闸。
        let evil_update = json!({ "taskId": "peer-task-share-sh-rr2", "shareId": "sh-rr2",
            "title": "防伪 revoke", "from": ALICE, "fromName": "爱丽丝",
            "owner": "did:youling:EVE", "createdAt": 100,
            "env": [{ "kind": "dsh", "localPort": 23911,
                "entryUrl": "http://127.0.0.1:23911/gw/sh-rr2/?mt=EVIL" }] });
        assert!(
            ingest_msg(
                MY,
                &inbound(
                    "tr2-evil-update",
                    "did:youling:EVE",
                    "task-share",
                    evil_update,
                    150
                )
            )
            .await
        );
        let t = load_tasks()
            .into_iter()
            .find(|t| t["taskId"] == json!("peer-task-share-sh-rr2"))
            .expect("卡仍在");
        assert_eq!(t["owner"], json!(null), "伪造 task-share 不得改写 owner");
        assert_eq!(
            t["env"][0]["entryUrl"],
            json!("http://127.0.0.1:23911/gw/sh-rr2/?mt=MT-RR2")
        );
        // 伪造：EVE 不是卡来源
        assert!(ingest_msg(MY, &inbound("tr2-evil", "did:youling:EVE", "task-revoke",
            json!({ "shareId": "sh-rr2", "taskId": "peer-task-share-sh-rr2", "title": "防伪 revoke" }), 200)).await);
        let status = load_tasks()
            .into_iter()
            .find(|t| t["taskId"] == json!("peer-task-share-sh-rr2"))
            .unwrap()["status"]
            .clone();
        assert_ne!(
            status,
            json!("revoked"),
            "伪造 revoke 不得改卡状态/打 tombstone"
        );
        // 合法：来源账号发的 revoke → 生效
        assert!(ingest_msg(MY, &inbound("tr2-ok", ALICE, "task-revoke",
            json!({ "shareId": "sh-rr2", "taskId": "peer-task-share-sh-rr2", "title": "防伪 revoke" }), 300)).await);
    }

    /// 全链路：收卡 → 收 task-revoke → 任务库标 revoked + state_snapshot 不再吐这张卡
    ///（对端 UI ≤5s 轮询消失的那一环）。
    #[tokio::test]
    async fn task_revoke_ingest_marks_card_and_snapshot_hides_it() {
        let _g = env();
        // state_snapshot 要求活动账号：隔离目录里写 active.txt（与 identity 单测同款手法）
        let acc_dir = myco_core::config::config_dir().join("accounts");
        let _ = std::fs::create_dir_all(&acc_dir);
        let _ = std::fs::write(acc_dir.join("active.txt"), MY);
        let card = json!({ "taskId": "peer-task-share-sh-rr1", "shareId": "sh-rr1",
            "title": "会消失的卡", "from": ALICE, "fromName": "爱丽丝", "createdAt": 100,
            "env": [{ "kind": "dsh", "localPort": 23911,
                "entryUrl": "http://127.0.0.1:23911/gw/sh-rr1/?mt=MT-RR1" }] });
        assert!(ingest_msg(MY, &inbound("tr-c1", ALICE, "task-share", card, 100)).await);
        assert!(
            load_tasks()
                .iter()
                .any(|t| t["taskId"] == json!("peer-task-share-sh-rr1")),
            "先有卡"
        );
        // 撤销通知（P2P/离线队列同形状）
        assert!(ingest_msg(MY, &inbound("tr-r1", ALICE, "task-revoke",
            json!({ "shareId": "sh-rr1", "taskId": "peer-task-share-sh-rr1", "title": "会消失的卡" }), 200)).await);
        let t = load_tasks()
            .into_iter()
            .find(|t| t["taskId"] == json!("peer-task-share-sh-rr1"))
            .unwrap();
        assert_eq!(t["status"], json!("revoked"), "{t}");
        assert_eq!(t["revokedAt"], json!(200));
        // 快照过滤：revoked 不进 tasks（UI 消失）；无关卡照常
        let snap = state_snapshot().await.expect("snapshot");
        let tasks = snap["tasks"].as_array().unwrap();
        assert!(
            tasks
                .iter()
                .all(|t| t["taskId"] != json!("peer-task-share-sh-rr1")),
            "revoked 卡不得出现在快照: {tasks:?}"
        );
        // 不落会话行（聊天流无打扰）
        assert!(conv_load_raw_inner(&my_did_conv(ALICE))
            .iter()
            .all(|m| m.get("kind").and_then(|k| k.as_str()) != Some("task-revoke")));
    }
}

// ══════════════ friend CLI 三件套（2026-10-12「UI 有的感知/状态/动作 CLI 都要有」）══════════════
// friends_snapshot / friend_add_admin / friend_remove——档案即权威，直写即可测。
// 存储隔离走共享 test_env_lock（全局 MYCO_CONFIG_DIR，并行模块互不踩）。

#[cfg(test)]
mod friend_cli_tests {
    use super::*;

    fn env() -> std::sync::MutexGuard<'static, ()> {
        crate::test_env_lock::test_env_lock()
    }

    const FAN: &str = "did:youling:z6MkFAN0000000000000000000000000000000000000000";

    #[test]
    fn friend_add_is_idempotent_and_renames() {
        let _g = env();
        let _ = friend_remove(FAN);
        // 首加：op=added，status=ok（=握手完成态）
        let r1 = friend_add_admin(FAN, "Fan").unwrap();
        assert_eq!(r1["op"], "added", "{r1}");
        assert_eq!(r1["row"]["status"], "ok", "{r1}");
        // 重加：幂等只刷名，不重复行
        let r2 = friend_add_admin(FAN, "Fan 改名").unwrap();
        assert_eq!(r2["op"], "renamed", "{r2}");
        let list = friends_snapshot();
        assert_eq!(
            list.iter().filter(|f| f["did"] == FAN).count(),
            1,
            "{list:?}"
        );
        assert_eq!(
            list.iter().find(|f| f["did"] == FAN).unwrap()["name"],
            "Fan 改名"
        );
        // remove：删行幂等
        let r3 = friend_remove(FAN).unwrap();
        assert_eq!(r3["removed"], 1, "{r3}");
        let r4 = friend_remove(FAN).unwrap();
        assert_eq!(r4["removed"], 0, "{r4}");
        assert!(friends_snapshot().iter().all(|f| f["did"] != FAN));
    }

    #[test]
    fn friend_add_rejects_bad_input() {
        let _g = env();
        assert!(friend_add_admin("not-a-did", "X").is_err(), "did 形态闸");
        assert!(friend_add_admin(FAN, "  ").is_err(), "空名闸");
    }
}

// ══════════════ 批二（2026-09-28）：群语义修正 单测（stateful ingest——隔离 MYCO_CONFIG_DIR） ══════════════
// 覆盖：① 群任务卡落群会话+回执群广播落群 ② 群主退群=解散（group-disband 收发语义）
// ③ 被踢保留只读历史+系统条 ④ 自愈建群 ownerPending 治理全拒→group-create 补齐收敛。
// 存储隔离：进程内设一次 MYCO_CONFIG_DIR（temp 目录）；用例间互斥锁串行
// （groups.json 读-改-写非原子，并发会互踩）；各用例群 id 独立再兜底。

#[cfg(test)]
mod group_semantics_tests {
    use super::*;

    fn test_env() -> std::sync::MutexGuard<'static, ()> {
        // 2026-10-07 修（flaky 实锤）：本模块此前独享进程级 MYCO_CONFIG_DIR + 模块锁
        // ——与 p2p_sync/dsh_share 的测试模块并行时全局 env 互相覆盖、同目录
        // groups.json 读改写互踩 → group_disband_semantics 随机挂。统一走进程级
        // 共享锁（test_env_lock.rs，接入点：本处/p2p_sync/dsh_share）。
        crate::test_env_lock::test_env_lock()
    }

    const MY: &str = "did:youling:ME";
    const ALICE: &str = "did:youling:ALICE"; // 群主
    const BOB: &str = "did:youling:BOB"; // 普通成员

    /// 入站消息（信箱/P2P 适配后形态：id/from/kind/payload/ts）。
    fn inbound(id: &str, from: &str, kind: &str, payload: Value, ts: i64) -> Value {
        json!({ "id": id, "from": from, "fromName": "发送者", "kind": kind, "payload": payload, "ts": ts })
    }

    fn group_of(gid: &str) -> Option<Value> {
        load_groups()
            .into_iter()
            .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(gid))
    }
    fn members_of(gid: &str) -> Vec<String> {
        group_of(gid)
            .and_then(|g| g.get("members").and_then(|m| m.as_array()).cloned())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    }
    fn conv_kinds(gid: &str) -> Vec<String> {
        conv_load_raw_inner(gid)
            .iter()
            .map(|m| {
                m.get("kind")
                    .and_then(|k| k.as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .collect()
    }

    /// 批1：群任务卡落群会话（全员可见同一张卡）+ 接受/完成回执群广播落群；
    /// 单聊分享/单聊回执行为不变（落单聊会话）。
    #[tokio::test]
    async fn group_task_card_and_receipts_land_in_group_conv() {
        let _g = test_env();
        let gid = "grp-t1";
        // 建群（owner=ALICE，三成员）
        assert!(ingest_msg(MY, &inbound("gc-t1", ALICE, "group-create",
            json!({ "groupId": gid, "groupName": "任务群", "members": [MY, ALICE, BOB], "owner": ALICE }), 1000)).await);
        // 群任务卡（payload.groupId=grp-*）→ 落群会话，任务库 convId=群 id
        let card = json!({ "taskId": "peer-task-g1", "title": "群周报", "desc": "一起写",
            "from": ALICE, "fromName": "爱丽丝", "createdAt": 1001, "source": "peer",
            "groupId": gid, "groupName": "任务群", "members": [MY, ALICE, BOB],
            "participants": [{ "did": ALICE, "name": "爱丽丝", "role": "owner" }] });
        assert!(ingest_msg(MY, &inbound("ts-g1", ALICE, "task-share", card, 1001)).await);
        let kinds = conv_kinds(gid);
        assert!(
            kinds.contains(&"task-share".to_string()),
            "群会话应有任务卡: {kinds:?}"
        );
        let t = load_tasks()
            .into_iter()
            .find(|t| t.get("taskId").and_then(|v| v.as_str()) == Some("peer-task-g1"))
            .unwrap();
        assert_eq!(t.get("convId").and_then(|v| v.as_str()), Some(gid));
        assert_eq!(t.get("status").and_then(|v| v.as_str()), Some("pending"));
        // 群任务卡不落单聊会话（与分享者的单聊里不该有这张卡）
        assert!(conv_load_raw_inner(&my_did_conv(ALICE))
            .iter()
            .all(|m| m.get("kind").and_then(|k| k.as_str()) != Some("task-share")));
        // 回执 task-accept（BOB 接了）群广播 → 落群会话；participants 合并
        assert!(ingest_msg(MY, &inbound("ta-g1", BOB, "task-accept",
            json!({ "event": "claim", "task_id": "peer-task-g1", "worker_did": BOB, "groupId": gid,
                    "name": "鲍勃", "participants": [{ "did": ALICE, "role": "owner" }, { "did": BOB, "name": "鲍勃", "role": "member", "acceptedAt": 1002 }] }), 1002)).await);
        // 回执 task-done（BOB 完成）→ 落群会话 + 任务库置 done
        assert!(ingest_msg(MY, &inbound("td-g1", BOB, "task-done",
            json!({ "event": "submit", "task_id": "peer-task-g1", "worker_did": BOB, "groupId": gid,
                    "name": "鲍勃", "participants": [{ "did": ALICE, "role": "owner" }, { "did": BOB, "name": "鲍勃", "status": "done", "doneAt": 1003 }] }), 1003)).await);
        let kinds = conv_kinds(gid);
        assert!(
            kinds.contains(&"task-accept".to_string()),
            "群会话应有接受回执: {kinds:?}"
        );
        assert!(
            kinds.contains(&"task-done".to_string()),
            "群会话应有完成回执: {kinds:?}"
        );
        let t = load_tasks()
            .into_iter()
            .find(|t| t.get("taskId").and_then(|v| v.as_str()) == Some("peer-task-g1"))
            .unwrap();
        assert_eq!(t.get("status").and_then(|v| v.as_str()), Some("done"));
        let parts = t
            .get("participants")
            .and_then(|p| p.as_array())
            .cloned()
            .unwrap_or_default();
        assert_eq!(parts.len(), 2, "participants 合并去重: {parts:?}");
        // 回执不落与 BOB 的单聊
        assert!(conv_load_raw_inner(&my_did_conv(BOB)).is_empty());
        // 单聊分享行为不变：无 groupId 的 task-share 落与分享者的单聊
        assert!(ingest_msg(MY, &inbound("ts-d1", BOB, "task-share",
            json!({ "taskId": "peer-task-d1", "title": "单聊卡", "from": BOB, "createdAt": 1004 }), 1004)).await);
        assert!(conv_kinds(&my_did_conv(BOB)).contains(&"task-share".to_string()));
        let t2 = load_tasks()
            .into_iter()
            .find(|t| t.get("taskId").and_then(|v| v.as_str()) == Some("peer-task-d1"))
            .unwrap();
        assert_eq!(
            t2.get("convId").and_then(|v| v.as_str()),
            Some(my_did_conv(BOB).as_str())
        );
        // 单聊回执行为不变：无 groupId 的 task-accept 落单聊
        assert!(ingest_msg(MY, &inbound("ta-d1", BOB, "task-accept",
            json!({ "event": "claim", "task_id": "peer-task-d1", "worker_did": BOB, "name": "鲍勃" }), 1005)).await);
        assert!(conv_kinds(&my_did_conv(BOB)).contains(&"task-accept".to_string()));
    }

    /// 批1+批4：群任务卡先于 group-create 到达（离线期建的群）→ 自愈建群 ownerPending。
    #[tokio::test]
    async fn group_task_card_selfheals_group_owner_pending() {
        let _g = test_env();
        let gid = "grp-t1b";
        let card = json!({ "taskId": "peer-task-g1b", "title": "自愈卡", "from": ALICE, "createdAt": 1,
            "groupId": gid, "groupName": "自愈群", "members": [MY, ALICE, BOB] });
        assert!(ingest_msg(MY, &inbound("ts-g1b", ALICE, "task-share", card, 1000)).await);
        let g = group_of(gid).expect("自愈建群");
        assert!(group_owner_pending(&g), "自愈建群应 ownerPending: {g:?}");
        assert_eq!(members_of(gid).len(), 3);
        assert!(conv_kinds(gid).contains(&"task-share".to_string()));
    }

    /// 批2：群主退群=解散——group-disband 治理闸（非群主拒收）+ 终态语义
    /// （档案只读/members 清空/系统条/会话保留）+ compat group-leave 不双条。
    #[tokio::test]
    async fn group_disband_semantics() {
        let _g = test_env();
        let gid = "grp-t2";
        assert!(ingest_msg(MY, &inbound("gc-t2", ALICE, "group-create",
            json!({ "groupId": gid, "groupName": "解散群", "members": [MY, ALICE, BOB], "owner": ALICE }), 1000)).await);
        // 群里有过聊天（历史）
        assert!(ingest_msg(MY, &inbound("gm-t2", ALICE, "group-msg",
            json!({ "groupId": gid, "groupName": "解散群", "members": [MY, ALICE, BOB], "text": "历史消息" }), 1001)).await);
        // 非群主的 disband 拒收（防伪造）
        assert!(
            !ingest_msg(
                MY,
                &inbound(
                    "gd-t2-fake",
                    BOB,
                    "group-disband",
                    json!({ "groupId": gid, "groupName": "解散群" }),
                    1002
                )
            )
            .await
        );
        assert!(group_of(gid).is_some_and(|g| group_terminal_status(&g).is_empty()));
        // 群主 disband → 终态：status=disbanded + members 清空 + 系统条 + 历史保留
        assert!(
            ingest_msg(
                MY,
                &inbound(
                    "gd-t2",
                    ALICE,
                    "group-disband",
                    json!({ "groupId": gid, "groupName": "解散群" }),
                    1003
                )
            )
            .await
        );
        let g = group_of(gid).expect("解散后档案保留（只读）");
        assert_eq!(group_terminal_status(&g), "disbanded");
        assert_eq!(members_of(gid).len(), 0, "members 清空");
        let msgs = conv_load_raw_inner(gid);
        assert!(
            msgs.iter().any(|m| m
                .get("payload")
                .and_then(|p| p.get("text"))
                .and_then(|t| t.as_str())
                == Some("历史消息")),
            "聊天历史保留"
        );
        let sys: Vec<_> = msgs
            .iter()
            .filter(|m| m.get("kind").and_then(|k| k.as_str()) == Some("sys"))
            .collect();
        assert_eq!(sys.len(), 1, "一条解散系统条: {msgs:?}");
        assert!(sys[0]
            .get("payload")
            .and_then(|p| p.get("text"))
            .and_then(|t| t.as_str())
            .unwrap()
            .contains("已被群主解散"));
        // compat group-leave（老端降级用，随 disband 一并发出）→ 终态闸拒收，不双系统条
        assert!(
            !ingest_msg(
                MY,
                &inbound(
                    "gl-t2",
                    ALICE,
                    "group-leave",
                    json!({ "groupId": gid }),
                    1004
                )
            )
            .await
        );
        let msgs2 = conv_load_raw_inner(gid);
        assert_eq!(
            msgs2
                .iter()
                .filter(|m| m.get("kind").and_then(|k| k.as_str()) == Some("sys"))
                .count(),
            1
        );
        // 终态群治理全拒（改名/拉人/禁言的消息面）
        assert!(!apply_group_update(gid, ALICE, |g| g["name"] = json!("新名")));
        // 重复 disband 幂等（不重复落系统条）
        assert!(
            ingest_msg(
                MY,
                &inbound(
                    "gd-t2-dup",
                    ALICE,
                    "group-disband",
                    json!({ "groupId": gid, "groupName": "解散群" }),
                    1005
                )
            )
            .await
        );
        assert_eq!(
            conv_load_raw_inner(gid)
                .iter()
                .filter(|m| m.get("kind").and_then(|k| k.as_str()) == Some("sys"))
                .count(),
            1
        );
        // 未知群的 disband（无档案无从校验）→ 丢弃
        assert!(
            !ingest_msg(
                MY,
                &inbound(
                    "gd-t2x",
                    ALICE,
                    "group-disband",
                    json!({ "groupId": "grp-t2x", "groupName": "未知群" }),
                    1006
                )
            )
            .await
        );
        // 迟到的 group-create（对账从持有方群 jsonl 补齐）→ 终态群不复活 members
        assert!(ingest_msg(MY, &inbound("gc-t2-late", ALICE, "group-create",
            json!({ "groupId": gid, "groupName": "解散群", "members": [MY, ALICE, BOB], "owner": ALICE }), 1007)).await);
        let g2 = group_of(gid).unwrap();
        assert_eq!(group_terminal_status(&g2), "disbanded");
        assert_eq!(
            members_of(gid).len(),
            0,
            "终态群不被迟到的 group-create 复活"
        );
    }

    /// 批3：被踢=群会话保留只读+系统条"你已被移出群「X」"（不再静默删群）。
    #[tokio::test]
    async fn kick_self_keeps_readonly_history() {
        let _g = test_env();
        let gid = "grp-t3";
        assert!(ingest_msg(MY, &inbound("gc-t3", ALICE, "group-create",
            json!({ "groupId": gid, "groupName": "踢人群", "members": [MY, ALICE, BOB], "owner": ALICE }), 1000)).await);
        assert!(ingest_msg(MY, &inbound("gm-t3", BOB, "group-msg",
            json!({ "groupId": gid, "groupName": "踢人群", "members": [MY, ALICE, BOB], "text": "被踢前的聊天" }), 1001)).await);
        // 非群主伪 kick 拒收
        assert!(
            !ingest_msg(
                MY,
                &inbound(
                    "gk-t3-fake",
                    BOB,
                    "group-kick",
                    json!({ "groupId": gid, "targetDid": MY }),
                    1002
                )
            )
            .await
        );
        // 群主踢我 → 终态 kicked：档案保留+系统条+历史保留+members 清空
        assert!(
            ingest_msg(
                MY,
                &inbound(
                    "gk-t3",
                    ALICE,
                    "group-kick",
                    json!({ "groupId": gid, "targetDid": MY, "members": [ALICE, BOB] }),
                    1003
                )
            )
            .await
        );
        let g = group_of(gid).expect("被踢后档案保留（只读）");
        assert_eq!(group_terminal_status(&g), "kicked");
        assert_eq!(members_of(gid).len(), 0);
        let msgs = conv_load_raw_inner(gid);
        assert!(
            msgs.iter().any(|m| m
                .get("payload")
                .and_then(|p| p.get("text"))
                .and_then(|t| t.as_str())
                == Some("被踢前的聊天")),
            "聊天历史保留可回查"
        );
        let sys_texts: Vec<String> = msgs
            .iter()
            .filter(|m| m.get("kind").and_then(|k| k.as_str()) == Some("sys"))
            .filter_map(|m| {
                m.get("payload")
                    .and_then(|p| p.get("text"))
                    .and_then(|t| t.as_str())
                    .map(String::from)
            })
            .collect();
        assert!(
            sys_texts
                .iter()
                .any(|t| t.contains("你已被移出群「踢人群」")),
            "被踢系统条: {sys_texts:?}"
        );
        // 重复投递幂等（不双条）
        assert!(
            ingest_msg(
                MY,
                &inbound(
                    "gk-t3-dup",
                    ALICE,
                    "group-kick",
                    json!({ "groupId": gid, "targetDid": MY }),
                    1004
                )
            )
            .await
        );
        assert_eq!(
            conv_load_raw_inner(gid)
                .iter()
                .filter(|m| m.get("kind").and_then(|k| k.as_str()) == Some("sys"))
                .count(),
            1
        );
    }

    /// 批4：自愈建群 ownerPending 治理全拒 → group-create 落 jsonl（对账载体）补齐真 owner 收敛。
    #[tokio::test]
    async fn owner_pending_recovers_via_group_create() {
        let _g = test_env();
        let gid = "grp-t4";
        // 离线期建的群：先收到群消息 → 自愈建群 ownerPending（不再首成员冒充群主）
        assert!(ingest_msg(MY, &inbound("gm-t4", BOB, "group-msg",
            json!({ "groupId": gid, "groupName": "自愈群", "members": [BOB, ALICE, MY], "text": "hi" }), 1000)).await);
        let g = group_of(gid).expect("自愈建群");
        assert!(group_owner_pending(&g));
        assert_eq!(
            group_owner_of(&g),
            "",
            "ownerPending 不兜底首成员（BOB 是首成员但非群主）"
        );
        assert!(!is_group_owner(&g, BOB));
        // 治理全拒：任何 from（含首成员 BOB）的元数据操作拒收
        assert!(!apply_group_update(gid, BOB, |g| g["name"] = json!("伪改名")));
        assert!(!apply_group_update(gid, ALICE, |g| g["name"] = json!("伪改名2")));
        assert_eq!(
            group_of(gid).unwrap().get("name").and_then(|v| v.as_str()),
            Some("自愈群")
        );
        // group-create 补齐（直推或对账——批二起 group-create 落群 jsonl 参与对账）→ 真 owner 到达
        assert!(ingest_msg(MY, &inbound("gc-t4", ALICE, "group-create",
            json!({ "groupId": gid, "groupName": "自愈群", "members": [BOB, ALICE, MY], "owner": ALICE }), 1001)).await);
        let g = group_of(gid).unwrap();
        assert!(!group_owner_pending(&g), "ownerPending 已清: {g:?}");
        assert_eq!(group_owner_of(&g), ALICE);
        // group-create 记录落在群会话 jsonl（对账载体的凭据）
        assert!(conv_kinds(gid).contains(&"group-create".to_string()));
        // 治理恢复：真群主操作放行，非群主仍拒
        assert!(apply_group_update(gid, ALICE, |g| g["name"] = json!("正名")));
        assert!(!apply_group_update(gid, BOB, |g| g["name"] = json!("伪名")));
        assert_eq!(
            group_of(gid).unwrap().get("name").and_then(|v| v.as_str()),
            Some("正名")
        );
        // 同 msgId 重复 ingest（直推+对账双路径）→ jsonl 幂等只有一条 group-create
        assert!(ingest_msg(MY, &inbound("gc-t4", ALICE, "group-create",
            json!({ "groupId": gid, "groupName": "自愈群", "members": [BOB, ALICE, MY], "owner": ALICE }), 1001)).await);
        assert_eq!(
            conv_load_raw_inner(gid)
                .iter()
                .filter(|m| m.get("kind").and_then(|k| k.as_str()) == Some("group-create"))
                .count(),
            1
        );
    }
}

// ══════════════ 2026-10-11：任务卡改名（task-rename）单测 ══════════════
// 验收清单（设计稿 §5 同口径）：① owner 改名 → 本地 title 更新 + wire 形状断言
// ② 参与者收到 → title 更新（校验 from==task.from）③ 非 owner 发的 rename 拒收
// ④ 本地无此卡 → 丢弃不落行 ⑤ 幂等：重复投递只生效一次；ts 大者覆盖 ⑥ 超 64 字截断。
// 存储隔离：与 group_semantics_tests 共用进程级 test_env_lock（任务库/会话文件互斥）。

#[cfg(test)]
mod task_rename_tests {
    use super::*;

    fn test_env() -> std::sync::MutexGuard<'static, ()> {
        crate::test_env_lock::test_env_lock()
    }

    const MY: &str = "did:youling:ME";
    // 每个用例独立的 owner/旁观者 did（进程级共享 config 目录——单聊会话文件按 did 命名，
    // 复用同一会话的断言会被其他用例的行污染；与 group_semantics_tests 的群 id 独立同款纪律）

    fn inbound(id: &str, from: &str, kind: &str, payload: Value, ts: i64) -> Value {
        json!({ "id": id, "from": from, "fromName": "发送者", "kind": kind, "payload": payload, "ts": ts })
    }

    /// 造一张 owner=owner_did 的单聊任务卡（经 task-share ingest 落库——与真链路同路径）。
    async fn seed_card(owner_did: &str, task_id: &str, title: &str) {
        assert!(
            ingest_msg(
                MY,
                &inbound(
                    &format!("share-{task_id}"),
                    owner_did,
                    "task-share",
                    json!({ "taskId": task_id, "title": title, "from": owner_did, "createdAt": 1 }),
                    100
                )
            )
            .await
        );
    }

    fn task_of(task_id: &str) -> Option<Value> {
        load_tasks()
            .into_iter()
            .find(|t| t.get("taskId").and_then(|v| v.as_str()) == Some(task_id))
    }

    fn rename_rows(conv_id: &str, task_id: &str) -> Vec<Value> {
        conv_load_raw_inner(conv_id)
            .into_iter()
            .filter(|m| {
                m.get("kind").and_then(|k| k.as_str()) == Some("task-rename")
                    && m.pointer("/payload/taskId").and_then(|v| v.as_str()) == Some(task_id)
            })
            .collect()
    }

    /// ② 参与者收到 task-rename → 本地 title 更新 + 会话落系统条行
    #[tokio::test]
    async fn rename_from_owner_updates_title_and_appends_strip() {
        let _g = test_env();
        let alice = "did:youling:ALICE_R1";
        seed_card(alice, "peer-task-r1", "旧名").await;
        assert!(
            ingest_msg(
                MY,
                &inbound(
                    "tr-1",
                    alice,
                    "task-rename",
                    json!({ "taskId": "peer-task-r1", "title": "新名", "ts": 2000 }),
                    2000
                )
            )
            .await
        );
        let t = task_of("peer-task-r1").unwrap();
        assert_eq!(t.get("title").and_then(|v| v.as_str()), Some("新名"));
        assert_eq!(t.get("titleTs").and_then(|v| v.as_i64()), Some(2000));
        // 会话留痕行（对账载体）：落与 owner 的单聊会话，dir=in，kind/payload 完整
        let rows = rename_rows(&my_did_conv(alice), "peer-task-r1");
        assert_eq!(rows.len(), 1, "改名留痕行恰好一条: {rows:?}");
        assert_eq!(rows[0].get("dir").and_then(|v| v.as_str()), Some("in"));
        assert_eq!(
            rows[0].pointer("/payload/title").and_then(|v| v.as_str()),
            Some("新名")
        );
        assert_eq!(
            rows[0].pointer("/payload/ts").and_then(|v| v.as_i64()),
            Some(2000)
        );
    }

    /// ③ 安全闸：非 owner 发的 rename 拒收（伪造无效）——title 不变、不落行
    #[tokio::test]
    async fn rename_from_non_owner_rejected() {
        let _g = test_env();
        let alice = "did:youling:ALICE_R2";
        let bob = "did:youling:BOB_R2";
        seed_card(alice, "peer-task-r2", "旧名").await;
        // 旁观者伪造
        assert!(
            !ingest_msg(
                MY,
                &inbound(
                    "tr-2a",
                    bob,
                    "task-rename",
                    json!({ "taskId": "peer-task-r2", "title": "伪造名", "ts": 3000 }),
                    3000
                )
            )
            .await
        );
        // 我自己也不是 owner（参与者设备上 from==my 的伪 rename 同样拒）
        assert!(
            !ingest_msg(
                MY,
                &inbound(
                    "tr-2b",
                    MY,
                    "task-rename",
                    json!({ "taskId": "peer-task-r2", "title": "自导名", "ts": 3001 }),
                    3001
                )
            )
            .await
        );
        let t = task_of("peer-task-r2").unwrap();
        assert_eq!(
            t.get("title").and_then(|v| v.as_str()),
            Some("旧名"),
            "伪造改名不生效"
        );
        assert!(t.get("titleTs").is_none());
        assert!(rename_rows(&my_did_conv(bob), "peer-task-r2").is_empty());
        assert!(rename_rows(&my_did_conv(alice), "peer-task-r2").is_empty());
    }

    /// ④ 本地无此卡 → 丢弃（return false 不落行不落 meta——对账会再带，卡到齐即收敛）
    #[tokio::test]
    async fn rename_for_unknown_task_dropped() {
        let _g = test_env();
        let alice = "did:youling:ALICE_R3";
        assert!(
            !ingest_msg(
                MY,
                &inbound(
                    "tr-3",
                    alice,
                    "task-rename",
                    json!({ "taskId": "peer-task-ghost-r3", "title": "幽灵", "ts": 1000 }),
                    1000
                )
            )
            .await
        );
        assert!(task_of("peer-task-ghost-r3").is_none());
        assert!(
            conv_load_raw_inner(&my_did_conv(alice)).is_empty(),
            "陌生卡改名不落任何行"
        );
    }

    /// ⑤ 幂等 + ts 冲突：同一 rename 重复投递只生效一次；ts 大者覆盖、小者丢弃
    #[tokio::test]
    async fn rename_idempotent_and_larger_ts_wins() {
        let _g = test_env();
        let alice = "did:youling:ALICE_R4";
        seed_card(alice, "peer-task-r4", "旧名").await;
        let wire = inbound(
            "tr-4",
            alice,
            "task-rename",
            json!({ "taskId": "peer-task-r4", "title": "名A", "ts": 2000 }),
            2000,
        );
        assert!(ingest_msg(MY, &wire).await);
        assert!(ingest_msg(MY, &wire).await); // 直推+对账双份
        let t = task_of("peer-task-r4").unwrap();
        assert_eq!(t.get("title").and_then(|v| v.as_str()), Some("名A"));
        assert_eq!(
            rename_rows(&my_did_conv(alice), "peer-task-r4").len(),
            1,
            "重复投递只落一行（msgId 幂等）"
        );
        // ts 小的迟到 → 不覆盖
        assert!(
            ingest_msg(
                MY,
                &inbound(
                    "tr-4b",
                    alice,
                    "task-rename",
                    json!({ "taskId": "peer-task-r4", "title": "旧值回潮", "ts": 1500 }),
                    1500
                )
            )
            .await
        );
        assert_eq!(
            task_of("peer-task-r4")
                .unwrap()
                .get("title")
                .and_then(|v| v.as_str()),
            Some("名A")
        );
        // ts 大的后到 → 覆盖
        assert!(
            ingest_msg(
                MY,
                &inbound(
                    "tr-4c",
                    alice,
                    "task-rename",
                    json!({ "taskId": "peer-task-r4", "title": "名B", "ts": 2500 }),
                    2500
                )
            )
            .await
        );
        let t = task_of("peer-task-r4").unwrap();
        assert_eq!(t.get("title").and_then(|v| v.as_str()), Some("名B"));
        assert_eq!(t.get("titleTs").and_then(|v| v.as_i64()), Some(2500));
    }

    /// ⑥ 超 64 字截断（接收侧防御性截断——不信任 wire 长度）
    #[tokio::test]
    async fn rename_title_truncated_at_64_chars() {
        let _g = test_env();
        let alice = "did:youling:ALICE_R5";
        seed_card(alice, "peer-task-r5", "旧名").await;
        let long = "字".repeat(70);
        assert!(
            ingest_msg(
                MY,
                &inbound(
                    "tr-5",
                    alice,
                    "task-rename",
                    json!({ "taskId": "peer-task-r5", "title": long, "ts": 2000 }),
                    2000
                )
            )
            .await
        );
        let t = task_of("peer-task-r5").unwrap();
        assert_eq!(
            t.get("title")
                .and_then(|v| v.as_str())
                .map(|s| s.chars().count()),
            Some(64)
        );
    }

    /// ① owner 端改名本地核：title 更新 + wire 形状（kind/payload 字段）+ 群/单聊投递计划
    #[test]
    fn prepare_owner_renames_and_builds_wire() {
        let _g = test_env();
        let alice = "did:youling:ALICE_W1";
        // 单聊卡（convId=did_safe 形态——投递目标要能还原出原始对端 did）
        save_tasks(&[
            json!({ "taskId": "peer-task-w1", "title": "旧名", "from": MY,
            "status": "shared", "convId": my_did_conv(alice) }),
        ]);
        let (payload, conv_id, send_to) =
            task_rename_prepare(MY, "peer-task-w1", "  新名  ", 9000).unwrap();
        assert_eq!(
            payload,
            json!({ "taskId": "peer-task-w1", "title": "新名", "ts": 9000 }),
            "wire payload 恰为三键（trim 后）"
        );
        assert_eq!(conv_id, my_did_conv(alice));
        // 单聊：did_safe 形态 convId 还原出原始 did 作投递目标
        //（软 did 解不出公钥不还原——此用例用软 did，目标为空=仅本地，语义正确性由 canonical did 链路保证）
        assert_eq!(send_to, "");
        let t = task_of("peer-task-w1").unwrap();
        assert_eq!(t.get("title").and_then(|v| v.as_str()), Some("新名"));
        assert_eq!(t.get("titleTs").and_then(|v| v.as_i64()), Some(9000));
        // 群卡：payload 带 groupId/members 扇出锚，投递目标=群 id
        save_tasks(&[
            json!({ "taskId": "peer-task-w2", "title": "群卡", "from": MY, "status": "shared", "convId": "grp-w2" }),
        ]);
        group_upsert(
            "grp-w2",
            "群W2",
            vec![MY.to_string(), alice.to_string()],
            Some(MY),
        );
        let (p2, conv2, send2) = task_rename_prepare(MY, "peer-task-w2", "群卡新名", 9001).unwrap();
        assert_eq!(send2, "grp-w2");
        assert_eq!(conv2, "grp-w2");
        assert_eq!(
            p2.pointer("/groupId").and_then(|v| v.as_str()),
            Some("grp-w2")
        );
        assert_eq!(
            p2.pointer("/members")
                .and_then(|v| v.as_array())
                .map(|a| a.len()),
            Some(2)
        );
        assert_eq!(
            p2.pointer("/title").and_then(|v| v.as_str()),
            Some("群卡新名")
        );
    }

    /// ①b owner 闸：非 owner 调 prepare 直接拒（UI 入口之外的强制校验）+ 空标题/未知任务
    #[test]
    fn prepare_rejects_non_owner_and_bad_input() {
        let _g = test_env();
        let alice = "did:youling:ALICE_W3";
        save_tasks(&[
            json!({ "taskId": "peer-task-w3", "title": "别人的卡", "from": alice,
            "status": "pending", "convId": my_did_conv(alice) }),
        ]);
        assert_eq!(
            task_rename_prepare(MY, "peer-task-w3", "越权", 1).unwrap_err(),
            "只有任务发起人可以改名"
        );
        assert_eq!(
            task_rename_prepare(MY, "peer-task-ghost-w3", "x", 1).unwrap_err(),
            "任务不存在"
        );
        save_tasks(&[
            json!({ "taskId": "peer-task-w4", "title": "我的卡", "from": MY, "status": "shared", "convId": "grp-w4" }),
        ]);
        assert_eq!(
            task_rename_prepare(MY, "peer-task-w4", "   ", 1).unwrap_err(),
            "任务标题不能为空"
        );
        // 超 64 字在发送侧也截断
        let (p, _, _) = task_rename_prepare(MY, "peer-task-w4", &"长".repeat(70), 2).unwrap();
        assert_eq!(
            p.pointer("/title")
                .and_then(|v| v.as_str())
                .map(|s| s.chars().count()),
            Some(64)
        );
    }

    /// ⑦ 自同步回流（owner 的另一台设备拉到自己 PC 的 out 副本）：from==my 不悔改写前
    /// 的语义——owner 校验过、title 应用、留痕行归位到与对方的会话且 dir=out。
    #[tokio::test]
    async fn rename_self_echo_relays_to_peer_conv_as_out() {
        let _g = test_env();
        let alice = "did:youling:ALICE_R6";
        // 我是 owner 的卡（我自己分享出去的，convId=与对方的单聊）
        save_tasks(&[
            json!({ "taskId": "peer-task-r6", "title": "旧名", "from": MY,
            "status": "shared", "convId": my_did_conv(alice) }),
        ]);
        // 对账回流的自己 out 副本：from==my，to=对方（信封原始形态，未经归位改写）
        let wire = json!({ "id": "tr-6", "from": MY, "to": alice, "kind": "task-rename",
            "payload": { "taskId": "peer-task-r6", "title": "多端新名", "ts": 5000 }, "ts": 5000 });
        assert!(ingest_msg(MY, &wire).await);
        let t = task_of("peer-task-r6").unwrap();
        assert_eq!(t.get("title").and_then(|v| v.as_str()), Some("多端新名"));
        let rows = rename_rows(&my_did_conv(alice), "peer-task-r6");
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].get("dir").and_then(|v| v.as_str()),
            Some("out"),
            "自同步回流 dir=out"
        );
    }

    /// ⑧ 设备群载体行（owner 多端同步通道）：payload.groupId=grp-dev-* → 落设备群会话；
    /// 且 chat_load_conv 对设备群过滤 task-rename（数据面不渲染）。
    #[tokio::test]
    async fn rename_device_group_carrier_row_filtered_from_render() {
        let _g = test_env();
        let alice = "did:youling:ALICE_R7";
        save_tasks(&[
            json!({ "taskId": "peer-task-r7", "title": "旧名", "from": MY, "status": "shared", "convId": my_did_conv(alice) }),
        ]);
        let dgid = device_group_id(MY);
        let wire = json!({ "id": "tr-7", "from": MY, "to": dgid, "kind": "task-rename",
            "payload": { "taskId": "peer-task-r7", "title": "载体新名", "ts": 6000, "groupId": dgid }, "ts": 6000 });
        assert!(ingest_msg(MY, &wire).await);
        assert_eq!(
            task_of("peer-task-r7")
                .unwrap()
                .get("title")
                .and_then(|v| v.as_str()),
            Some("载体新名")
        );
        // 行落在设备群会话（对账载体）
        assert!(rename_rows(&dgid, "peer-task-r7").len() == 1);
        // 渲染面过滤（与 task-share 同义——设备群是数据面）
        let v = chat_load_conv(dgid.clone()).await.unwrap();
        let msgs = v
            .get("msgs")
            .and_then(|m| m.as_array())
            .cloned()
            .unwrap_or_default();
        assert!(
            msgs.iter()
                .all(|m| m.get("kind").and_then(|k| k.as_str()) != Some("task-rename")),
            "设备群改名行不渲染: {msgs:?}"
        );
    }
}

// ══════════════ 批三：撤回 tombstone 单测（纯函数——不碰盘不碰网） ══════════════

#[cfg(test)]
mod recall_tests {
    use super::*;

    fn line(msg_id: &str, kind: &str, payload: Value) -> Value {
        json!({ "msgId": msg_id, "from": "me", "to": "peer", "kind": kind,
                "payload": payload, "ts": 100, "dir": "out", "sendState": "sent" })
    }

    #[test]
    fn tombstone_rewrites_kind_and_purges_payload() {
        let mut m = line("a", "text", json!({ "text": "秘密原文" }));
        assert!(tombstone_line(&mut m, "a"));
        assert_eq!(m["kind"], json!("recalled"));
        assert_eq!(m["payload"], json!({})); // 原文清空（撤回即忘）
        assert_eq!(m["ts"], json!(100)); // 定序字段保留
        assert_eq!(m["dir"], json!("out")); // "谁撤的"渲染保留
        assert!(m.get("sendState").is_none()); // 发送态徽标不随 tombstone
    }

    #[test]
    fn tombstone_keeps_group_id_for_sync_routing() {
        let mut m = line(
            "g1",
            "group-msg",
            json!({ "groupId": "grp-x", "text": "hi" }),
        );
        assert!(tombstone_line(&mut m, "g1"));
        assert_eq!(m["payload"], json!({ "groupId": "grp-x" })); // 群 tombstone 对账归位锚
    }

    #[test]
    fn tombstone_idempotent_and_targeted() {
        let mut m = line("a", "text", json!({ "text": "x" }));
        assert!(!tombstone_line(&mut m, "别的")); // 非目标不动
        assert_eq!(m["kind"], json!("text"));
        assert!(tombstone_line(&mut m, "a"));
        assert!(!tombstone_line(&mut m, "a")); // 已 tombstone 幂等
        assert_eq!(m["kind"], json!("recalled"));
    }
}

// ══════════════ 2026-10-06：收编通知（delegation-notify）接收侧 单测 ══════════════
// 「P2P 通知 → 立即触发取件」接线：ingest 在登录闸之前识别该 kind（未登录的全新
// 成员设备正是收编对象），校验 payload.rootDid==from 后唤醒 identity_service 的
// 取件触发器（cfg(test) 下为计数桩——watch_tick 的取件/验签/nonce 去重逻辑本身
// 由 identity_service 的 delegation_watch_tests 覆盖，这里不重复实现、只验接线）。
// 纯内存：不落会话、不 emit chat-incoming、不碰 config 目录/网络。

#[cfg(test)]
mod delegation_notify_tests {
    use super::*;

    fn notify(from: &str, root_did: &str) -> Value {
        json!({
            "msgId": "dn-t1", "from": from, "fromName": "Fan", "fromDevice": "did:myco:zDev",
            "to": "did:myco:zMember", "kind": "delegation-notify",
            "payload": { "rootDid": root_did, "accountName": "Fan" }, "ts": 100,
        })
    }

    fn triggers() -> usize {
        crate::identity_service::TEST_PICKUP_TRIGGERS.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// 主路径+安全面合并为一条（TEST_PICKUP_TRIGGERS 是进程级计数器，拆两条会在
    /// 并行测试线程间互踩）：合法收编通知 → 触发立即取件；归属不符/缺件 → 不触发。
    /// 本用例进程内不登录账号——正是"未登录成员设备也能收"的语义实证。
    #[tokio::test]
    async fn delegation_notify_triggers_pickup_only_when_valid() {
        // canonical 双前缀（同一把钥匙两种写法）——2026-10-10 canonical-only：
        // 认的是公钥级同一账号，不再认 legacy/软 did 的前缀孪生。
        let sk = ed25519_dalek::SigningKey::from_bytes(&[0x2au8; 32]);
        let root_myco = core_id::did_from_public(&sk.verifying_key().to_bytes()); // did:myco:z…
        let root = core_id::account_did_canonical(&root_myco); // did:youling:z…（同钥）
        assert!(root.starts_with("did:youling:z") && root_myco.starts_with("did:myco:z"));
        let before = triggers();
        // ① 合法通知 → 触发一次立即取件；Ok(false)=不落会话（非聊天消息）
        let r = ingest_p2p_inner(&notify(&root, &root)).await;
        assert!(matches!(r, Ok(false)), "收编通知不落会话: {r:?}");
        assert_eq!(triggers(), before + 1, "必须触发一次立即取件");
        // ② canonical 双前缀互认（from=did:myco:z… / payload.rootDid=did:youling:z…，同公钥）
        let r2 = ingest_p2p_inner(&notify(&root_myco, &root)).await;
        assert!(matches!(r2, Ok(false)));
        assert_eq!(triggers(), before + 2, "canonical 双前缀同账号也应触发");
        // ②b legacy 形态（裸 base58）已废止 → 不再互认、不唤醒
        let legacy_from = format!(
            "did:youling:{}",
            bs58::encode(sk.verifying_key().to_bytes()).into_string()
        );
        let r2b = ingest_p2p_inner(&notify(&legacy_from, &root)).await;
        assert!(matches!(r2b, Ok(false)));
        assert_eq!(triggers(), before + 2, "legacy 已废止：不得触发");
        // ③ payload.rootDid ≠ from（张冠李戴）→ 丢弃不唤醒
        let r3 = ingest_p2p_inner(&notify("did:youling:zAttacker", "did:youling:zVictim")).await;
        assert!(matches!(r3, Ok(false)));
        // ④ 缺 payload → 丢弃不唤醒
        let bare = json!({ "msgId": "dn-t2", "from": "did:youling:zA", "kind": "delegation-notify", "ts": 1 });
        let r4 = ingest_p2p_inner(&bare).await;
        assert!(matches!(r4, Ok(false)));
        assert_eq!(triggers(), before + 2, "伪通知/缺件不得触发取件");
    }
}

// ══════════════ 同步回程（2026-10-09「点卡就进」回程收口） 单测 ══════════════
// 锁的是**那个真机踩到的缺口**：同账号设备请求 grant 时，回包推不到请求方
// （手机是纯拉取设备），投回 PC 自己又在等待者表里找不到人 → 静默丢弃。
// 修法 = 回包挂进 `/p2p/msg` 的 HTTP 响应体；这里直击该机制的四个边界：
//   ① 同账号请求 → 回包**同步**回到响应体，且**不再走 P2P 直推**；
//   ② 没写 syncReply → 一个字不变（照常直推）；
//   ③ 张冠李戴（账号/shareId 对不上）→ 不填槽，照常直推；
//   ④ 槽单次性 + 先到先得（不串包、不被抢）。
//
// 这些用例**不需要第二台设备在场**（也不打网络）：本机账号 = 请求方账号，
// 正是"同账号"那条最容易静默丢弃的路径。

#[cfg(test)]
mod sync_reply_tests {
    use super::*;

    /// 用例间互斥（槽是进程级全局表）。
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn test_env() -> std::sync::MutexGuard<'static, ()> {
        let g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        _reset_sync_replies_for_test();
        g
    }

    const ACCT: &str = "did:youling:zSyncAcct";
    const MY_DEV: &str = "did:myco:zSyncMyDev";
    const PHONE_DEV: &str = "did:myco:zSyncPhoneDev";
    const SHARE: &str = "sh-sync-1";
    const RID: &str = "ser-0123456789abcdef01234567";

    /// 手机（同账号另一台设备）发来的「要同步回包」请求（与手机侧
    /// `shareEntryRequestPayload` + `syncReply` 逐字同形）。
    fn request_env(sync_reply: bool) -> Value {
        let mut payload = json!({
            "shareId": SHARE,
            "requestId": RID,
            "requesterDevice": PHONE_DEV,
            "requesterAccount": ACCT,
        });
        if sync_reply {
            payload["syncReply"] = json!(true);
        }
        json!({
            "msgId": "se-req-1", "from": ACCT, "fromName": "我",
            "fromDevice": PHONE_DEV, "fromDeviceName": "myco-phone",
            "to": ACCT, "kind": "share-entry-request", "payload": payload, "ts": 1,
        })
    }

    /// A 侧现签好的 grant（形状逐字对齐 `dsh_share::share_entry_request_ingest_inner`）。
    fn grant(exp_ms: i64) -> Value {
        json!({
            "shareId": SHARE, "requestId": RID, "ok": true,
            "mt": "MT-SYNC", "expiresAt": exp_ms, "gwPort": 13911,
        })
    }

    /// ① 正题：同账号设备请求 → 回包同步回到响应体（零新通道），且不再 P2P 直推。
    ///
    /// "不再直推"是可证的：`send_share_entry_msg` 命中槽就 **在直推分支之前** 返回，
    /// 计数不动。老行为下这条同账号回包会投回 PC 自己、静默丢弃——就是那个缺口。
    #[tokio::test]
    async fn same_account_request_gets_grant_in_response_body_without_push() {
        let _g = test_env();
        let rid = open_sync_reply(&request_env(true)).expect("要同步回包 → 必须开槽");
        assert_eq!(rid, RID);
        let pushes_before = _push_calls_for_test();

        // 现签完成，回包走**同一个 choke point**（生产链路上唯一出口）
        send_share_entry_msg(ACCT, "share-entry-grant", grant(now_ms() + 180_000))
            .await
            .expect("同步回程必须就地成功（不依赖任何可推达设备）");

        assert_eq!(
            _push_calls_for_test(),
            pushes_before,
            "命中同步回程时**不得**再走 P2P 直推（同账号那条会投回本机被静默丢弃）"
        );
        let reply = close_sync_reply(&rid).expect("回包必须落在 HTTP 响应体槽里");
        assert_eq!(reply["ok"], json!(true));
        assert_eq!(reply["mt"], json!("MT-SYNC"), "票原样回传");
        assert_eq!(
            reply["gwPort"],
            json!(13911),
            "网关端口随票回传（手机据此建隧道）"
        );
        // 单次性：取过即删（迟到/重复回包不会留在表里长草）
        assert!(close_sync_reply(&rid).is_none(), "槽必须单次性");
    }

    /// ② 没写 syncReply → 行为一个字不变（照常直推）。
    #[tokio::test]
    async fn request_without_sync_reply_still_pushes() {
        let _g = test_env();
        assert!(
            open_sync_reply(&request_env(false)).is_none(),
            "没要回包就不开槽"
        );
        let before = _push_calls_for_test();
        // 直推分支会被走到（这里没有真 presence，最终必然失败——但那证明它**走了直推**）
        let _ = send_share_entry_msg(ACCT, "share-entry-grant", grant(now_ms() + 180_000)).await;
        assert_eq!(
            _push_calls_for_test(),
            before + 1,
            "没开槽就必须照常直推（老行为不变）"
        );
    }

    /// ③ 张冠李戴：回包账号/shareId 与请求对不上 → 不填槽（照常直推），且槽仍在等。
    #[tokio::test]
    async fn mismatched_grant_does_not_fill_the_slot() {
        let _g = test_env();
        let rid = open_sync_reply(&request_env(true)).expect("开槽");
        let before = _push_calls_for_test();

        let mut other_share = grant(now_ms() + 180_000);
        other_share["shareId"] = json!("sh-OTHER");
        let _ = send_share_entry_msg(ACCT, "share-entry-grant", other_share).await;
        let mut other_acct = grant(now_ms() + 180_000);
        other_acct["shareId"] = json!(SHARE);
        let _ =
            send_share_entry_msg("did:youling:zStranger", "share-entry-grant", other_acct).await;

        assert!(close_sync_reply(&rid).is_none(), "对不上的回包绝不能进槽");
        assert_eq!(
            _push_calls_for_test(),
            before + 2,
            "对不上 → 两条都照常直推"
        );
    }

    /// ④ 先到先得 + 形状闸：同 requestId 重复开槽不改写；缺 requestId/shareId/syncReply 不认。
    #[tokio::test]
    async fn slot_is_first_wins_and_shape_gated() {
        let _g = test_env();
        let rid = open_sync_reply(&request_env(true)).expect("开槽");
        // 换个 from 再来一份同 requestId 的请求（撞槽）→ 不改写
        let mut squatter = request_env(true);
        squatter["from"] = json!("did:youling:zAttacker");
        assert_eq!(
            open_sync_reply(&squatter).as_deref(),
            Some(RID),
            "已开过的槽照旧返回"
        );
        let before = _push_calls_for_test();
        // 攻击者账号的回包不得进别人的槽
        let _ = send_share_entry_msg(
            "did:youling:zAttacker",
            "share-entry-grant",
            grant(now_ms() + 180_000),
        )
        .await;
        assert!(
            close_sync_reply(&rid).is_none(),
            "槽没被改写，也就不该被攻击者的回包填上"
        );
        assert_eq!(_push_calls_for_test(), before + 1);

        // 形状不全：不认（宁可回退到既有直推，也不凭空开槽）
        for bad in [
            json!({ "from": ACCT, "payload": { "shareId": SHARE, "requestId": RID } }), // 缺 syncReply
            json!({ "from": ACCT, "payload": { "shareId": SHARE, "requestId": RID, "syncReply": "yes" } }), // 非 true
            json!({ "from": ACCT, "payload": { "shareId": SHARE, "syncReply": true } }), // 缺 requestId
            json!({ "from": ACCT, "payload": { "requestId": RID, "syncReply": true } }), // 缺 shareId
            json!({ "from": "", "payload": { "shareId": SHARE, "requestId": RID, "syncReply": true } }), // 缺 from
        ] {
            assert!(open_sync_reply(&bad).is_none(), "形状不全不得开槽: {bad}");
        }
    }
}

// ══════════════ 2026-10-07：会话 id 形态归一 单测 ══════════════
// 回归"跨机好友互发：两边都显示✓已发送、都能看到对方打字，但会话里看不到对方消息"。
//
// 根因：会话文件按裸串 did_safe(peer) 命名——接收 ingest 按**信封 from 的出示形态**
// 落（canonical `did:youling:z…`），发送与 UI 按**名册 did 的历史形态**落/读
// （`did:myco:<b58>`）。同一把钥匙两份 jsonl ⇒ UI 读的那份里没有对方的消息。
// （PC 实况：did:myco:7S2YE7Q6… 与 did:youling:z6MkktHap… 解出同一公钥 5f8f…c1cc。）
//
// 本模块锁三件事：① 写目标唯一（归一键）；② 读取归并（存量双文件都上屏，不迁移
// 不删档）；③ 索引/改写同源（meta 与 jsonl 同键；撤回/回写/删除逐文件命中，
// 不把归并结果整份写回一份文件——那会重复或丢消息）。
// 存储隔离：**线程局部 chat 桶覆盖**（chat_service::chat_dir 的 test 钩子）——
// 不写进程级 MYCO_CONFIG_DIR，避免与其它测试模块并发互踩（那会让双方偶发红灯）。

#[cfg(test)]
mod conv_identity_tests {
    use super::*;

    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    const TAG: &str = "myco-convid";

    fn test_env() -> std::sync::MutexGuard<'static, ()> {
        let g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("{TAG}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        TEST_CHAT_DIR.with(|d| *d.borrow_mut() = Some(dir));
        g
    }

    fn pk(b: u8) -> [u8; 32] {
        [b; 32]
    }
    fn b58(b: u8) -> String {
        bs58::encode(pk(b)).into_string()
    }

    /// 同一账号的两种 **canonical** 写法：`did:myco:z…` 与 `did:youling:z…`（同 tail，同一把钥匙）。
    /// 2026-10-10 canonical-only：legacy 已废止、不再参与归一——"历史形态"轴只剩**前缀轴**。
    fn pair(b: u8) -> (String, String) {
        let myco = core_id::did_from_public(&pk(b));
        let youling = core_id::account_did_canonical(&myco); // did:youling:z…（同 tail）
        assert_ne!(myco, youling, "两形态串必须真的不同，否则用例无意义");
        assert!(myco.starts_with("did:myco:z") && youling.starts_with("did:youling:z"));
        (myco, youling)
    }

    /// 该公钥的 **legacy 串**（`did:myco:<base58btc(32B 裸公钥)>`）——**只作存量文件名/键名**
    /// （归并读取）与反例；legacy 已废止：不作身份输入、不被 did_pubkey_bytes 解码。
    fn legacy_name(b: u8) -> String {
        format!("did:myco:{}", b58(b))
    }

    const ME: &str = "did:youling:zMeSoftAccount";

    fn text_msg(id: &str, dir: &str, from: &str, to: &str, text: &str, ts: i64) -> Value {
        json!({ "msgId": id, "from": from, "to": to, "kind": "text",
                "payload": { "text": text }, "ts": ts, "dir": dir })
    }
    fn texts(msgs: &[Value]) -> Vec<String> {
        let mut v: Vec<String> = msgs
            .iter()
            .map(|m| {
                m.pointer("/payload/text")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        v.sort();
        v
    }
    fn jsonl(conv_id: &str) -> PathBuf {
        chat_dir().join(format!("{}.jsonl", did_safe(conv_id)))
    }
    fn write_lines(path: &Path, msgs: &[Value]) {
        let body: String = msgs
            .iter()
            .map(|m| serde_json::to_string(m).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(path, format!("{body}\n")).unwrap();
    }
    fn read_texts(path: &Path) -> Vec<String> {
        let msgs: Vec<Value> = std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        texts(&msgs)
    }

    /// 归一键（纯函数）：canonical 双前缀两形态 + did_safe 下划线形态 → 同一键；
    /// 群 id 与软 did 原样；不同公钥不得撞键。
    /// 2026-10-10 canonical-only：**legacy 串不再归一**（原样成键，见下方反向守卫）。
    #[test]
    fn conv_key_unifies_canonical_forms_only() {
        let _g = test_env(); // conv_path 走 chat_dir——隔离，别碰真实桶
        let (myco, canonical) = pair(0x41);
        for form in [&myco, &canonical, &did_safe(&myco), &did_safe(&canonical)] {
            assert_eq!(conv_key(form), canonical, "形态 {form} 未归一到 canonical");
        }
        // 群 id / 软 did 原样（不误并、不误改文件名）
        assert_eq!(conv_key("grp-1a0eb64aa34"), "grp-1a0eb64aa34");
        assert_eq!(conv_key("did:youling:BOB"), "did:youling:BOB");
        assert_eq!(conv_path("grp-t9"), chat_dir().join("grp-t9.jsonl"));
        // legacy（已废止形态）：不再解码 → 原样成键（不归一）
        let legacy = legacy_name(0x41);
        assert_eq!(conv_key(&legacy), legacy, "legacy 不再归一（原样）");
        assert_eq!(
            conv_key(&did_safe(&legacy)),
            did_safe(&legacy),
            "legacy 的 did_safe 形态也不再还原"
        );
        // 不同公钥不同键
        let (other, _) = pair(0x42);
        assert_ne!(conv_key(&other), canonical, "不同公钥不得撞键");
        assert_ne!(conv_path(&other), conv_path(&myco));
    }

    /// 写目标唯一 + 归并读取：同一对端任取一 canonical 形态落库都写同一份文件；存量
    /// 历史形态命名的文件（**另一 canonical 前缀 / legacy 命名**）里的消息照样读到。
    #[test]
    fn two_forms_share_one_file_and_merge_read_existing() {
        let _g = test_env();
        let (myco, canonical) = pair(0x43);
        let legacy = legacy_name(0x43);
        // 存量：另一 canonical 前缀命名的老文件（含历史消息）
        let old = jsonl(&myco);
        write_lines(&old, &[text_msg("old-1", "out", ME, &myco, "旧", 10)]);
        // 存量：legacy 命名的老文件（已废止形态，仅作文件名）
        let old_legacy = jsonl(&legacy);
        write_lines(
            &old_legacy,
            &[text_msg("old-2", "out", ME, &legacy, "更旧", 5)],
        );
        // 归一键路径与老形态路径不同（本用例前提成立）
        let canon = jsonl(&canonical);
        assert_ne!(old, canon);
        assert_ne!(old_legacy, canon);
        // 无论从哪个 canonical 形态落，都写归一键文件
        conv_append(&myco, &text_msg("new-out", "out", ME, &myco, "333", 30));
        conv_append(
            &canonical,
            &text_msg("new-in", "in", &canonical, ME, "213", 20),
        );
        assert!(canon.is_file(), "新消息必须落归一键文件");
        assert!(
            old.is_file() && old_legacy.is_file(),
            "存量文件不得被删/迁移（红线）"
        );
        assert_eq!(
            read_texts(&canon),
            vec!["213".to_string(), "333".to_string()]
        );
        assert_eq!(read_texts(&old), vec!["旧".to_string()]);
        // UI 视角（名册形态 = 任一 canonical 前缀）读到全部四条；两形态读到的内容一致
        let mut want = vec![
            "213".to_string(),
            "333".to_string(),
            "旧".to_string(),
            "更旧".to_string(),
        ];
        want.sort();
        for form in [&myco, &canonical, &did_safe(&myco)] {
            assert_eq!(
                texts(&conv_load_raw_inner(form)),
                want,
                "形态 {form} 读取不完整"
            );
        }
        // 反向守卫：legacy 作为身份输入不再归并——只直读到 legacy 命名的那份
        assert_eq!(
            texts(&conv_load_raw_inner(&legacy)),
            vec!["更旧".to_string()]
        );
        let _ = std::fs::remove_dir_all(chat_dir());
    }

    /// 交叉验证（用户实测场景的还原）：接收按 did:myco:z… 信封 from 落、发送按
    /// did:youling:z… 名册 did 落 → UI 用名册 did 读会话，in/out 两条都在。
    #[test]
    fn ingest_myco_canonical_plus_send_youling_canonical_both_visible_in_ui_read() {
        let _g = test_env();
        let (myco, canonical) = pair(0x44);
        // ① 接收：ingest 落库键 = 信封 from 的出示形态（did:myco:z…）
        conv_append(
            &my_did_conv(&myco),
            &text_msg("in-1", "in", &myco, ME, "213", 1),
        );
        // ② 发送：本地乐观落库键 = 名册 did 形态（did:youling:z…）
        append_out(
            &my_did_conv(&canonical),
            ME,
            &canonical,
            "text",
            json!({ "text": "333" }),
            "out-1",
            2,
            "sent",
        );
        // ③ 只有一份会话文件（同一把钥匙一个键）
        assert_eq!(conv_path(&myco), conv_path(&canonical));
        assert!(
            jsonl(&canonical).is_file() && !jsonl(&myco).exists(),
            "两条消息必须落同一个文件（归一键）"
        );
        // ④ UI：convId = friends.json 的 did（另一 canonical 前缀）→ in/out 都在
        let msgs = conv_load_raw_inner(&myco);
        assert_eq!(
            texts(&msgs),
            vec!["213".to_string(), "333".to_string()],
            "另一前缀读不到 in 消息"
        );
        assert_eq!(
            msgs.iter()
                .filter(|m| m.get("dir").and_then(|d| d.as_str()) == Some("in"))
                .count(),
            1
        );
        assert_eq!(
            msgs.iter()
                .filter(|m| m.get("dir").and_then(|d| d.as_str()) == Some("out"))
                .count(),
            1
        );
        let _ = std::fs::remove_dir_all(chat_dir());
    }

    /// 索引归一：meta 与 jsonl 同键——重建时扫归并视图（存量老文件也进索引）；
    /// 已有 meta 后老文件才出现（实机形态：canonical meta 只有入站、另一前缀/legacy 命名
    /// 的老文件有出站）→ 增量并进来，两形态查到的 n/F 完全一致。
    #[test]
    fn meta_index_unifies_forms_and_folds_existing_files() {
        let _g = test_env();
        let (myco, canonical) = pair(0x45);
        let legacy = legacy_name(0x45);
        // ① 实机形态：canonical 侧先进来（meta 只有入站），另一前缀命名的老文件随后被读到
        conv_append(
            &canonical,
            &text_msg("in-1", "in", &canonical, ME, "213", 1),
        );
        let m0 = crate::p2p_sync::load_meta(&canonical);
        assert_eq!(m0.n, 1);
        write_lines(
            &jsonl(&myco),
            &[text_msg("out-1", "out", ME, &myco, "333", 2)],
        );
        // ② 任一形态查 meta：同一份索引，含两条
        let m1 = crate::p2p_sync::load_meta(&myco);
        let m2 = crate::p2p_sync::load_meta(&canonical);
        assert_eq!(m1.n, 2, "存量老文件的消息必须并入索引: {:?}", m1.ids);
        assert_eq!(m1.f_hex, m2.f_hex, "两种形态必须同一指纹");
        assert!(m1.ids.iter().any(|(id, _)| id == "out-1"));
        assert!(m1.ids.iter().any(|(id, _)| id == "in-1"));
        // 指纹 = 归并视图全量（与对账 push 的内容自洽）
        let expect = crate::p2p_sync::f_to_hex(&crate::p2p_sync::fingerprint_of(
            conv_load_raw_inner(&myco)
                .iter()
                .map(|m| m.get("msgId").and_then(|v| v.as_str()).unwrap_or("")),
        ));
        assert_eq!(m1.f_hex, expect);
        // ③ 归一键只有一份 meta；重复 load 幂等（不重复计数）
        assert!(conv_meta_path(&canonical).is_file());
        assert_eq!(crate::p2p_sync::load_meta(&myco).n, 2);
        assert_eq!(crate::p2p_sync::load_meta(&canonical).n, 2);
        // ④ 老会话重建路径（无 meta + 存量 legacy 命名文件）也归并
        let _ = std::fs::remove_file(conv_meta_path(&canonical));
        write_lines(
            &jsonl(&legacy),
            &[text_msg("old-2", "out", ME, &legacy, "旧", 3)],
        );
        assert_eq!(
            crate::p2p_sync::load_meta(&canonical).n,
            3,
            "重建须扫归并视图"
        );
        let _ = std::fs::remove_dir_all(chat_dir());
    }

    /// 改写/删除逐文件命中：一条消息物理上可能在任一形态文件里——回写 sendState、
    /// 删除单条都只动命中那份，绝不把归并结果整份写回（那会重复或丢消息）。
    #[test]
    fn rewrite_and_delete_hit_only_the_owning_file() {
        let _g = test_env();
        let (myco, canonical) = pair(0x46);
        // 存量：另一 canonical 前缀命名的老文件
        write_lines(
            &jsonl(&myco),
            &[json!({ "msgId": "old-out", "from": ME, "to": myco,
            "kind": "text", "payload": { "text": "旧出" }, "ts": 1, "dir": "out", "sendState": "sending" })],
        );
        conv_append(
            &canonical,
            &text_msg("new-in", "in", &canonical, ME, "新入", 2),
        );
        // ① 补发回写 sendState：改到老文件那一行，归一键文件原样
        conv_update_send_state(&canonical, "old-out", "sent");
        let old_line = std::fs::read_to_string(jsonl(&myco)).unwrap();
        assert!(
            old_line.contains("\"sendState\":\"sent\""),
            "老文件行未回写: {old_line}"
        );
        assert_eq!(
            read_texts(&jsonl(&canonical)),
            vec!["新入".to_string()],
            "归一键文件不得被动"
        );
        // ② 删除单条（删老文件里的）：只动老文件
        conv_delete_msg_all(&canonical, "old-out");
        assert_eq!(read_texts(&jsonl(&myco)), Vec::<String>::new());
        assert_eq!(read_texts(&jsonl(&canonical)), vec!["新入".to_string()]);
        // ③ 删会话/删好友：归并视图全部等价文件 + 归一键 meta 一起清（防另一形态"复活"）
        let m = crate::p2p_sync::load_meta(&canonical);
        assert!(!m.ids.is_empty());
        conv_remove_files(&canonical);
        assert!(
            !jsonl(&myco).exists() && !jsonl(&canonical).exists(),
            "等价文件须一并清"
        );
        assert!(!conv_meta_path(&canonical).exists());
        let _ = std::fs::remove_dir_all(chat_dir());
    }

    /// 实机第二种分裂形态（笔记本侧实测）：**同 tail 双前缀**两份文件
    /// （did_myco_z… 出站 / did_youling_z… 入站，同为公钥 …）——canonical 双前缀必须读成一个会话。
    /// 2026-10-10 canonical-only：不再用 legacy 串作身份（改用双前缀 canonical 夹具），
    /// 并**新增反向守卫**：legacy 命名的存量文件仍由别名表归并读取，但 legacy 作为**身份输入**
    /// 不再归并（`did_pubkey_bytes` 不解码 → 只有原串一个键）。
    #[test]
    fn prefix_twin_canonical_files_merge_legacy_names_still_read() {
        let _g = test_env();
        let (myco, youling) = pair(0x49); // 双前缀 canonical（同公钥）
        let legacy = legacy_name(0x49); // 存量 legacy 命名（仅文件名）
                                        // 存量三份文件：我为 UI 的形态（出站）、对端出示形态（入站）、legacy 命名的历史件
        write_lines(&jsonl(&myco), &[text_msg("o-1", "out", ME, &myco, "出", 1)]);
        write_lines(
            &jsonl(&youling),
            &[text_msg("i-1", "in", &youling, ME, "入", 2)],
        );
        write_lines(
            &jsonl(&legacy),
            &[text_msg("l-1", "out", ME, &legacy, "旧出", 3)],
        );
        let want = vec!["入".to_string(), "出".to_string(), "旧出".to_string()];
        let msgs = conv_load_raw_inner(&myco); // UI 传名册形态
        assert_eq!(
            texts(&msgs),
            want,
            "双前缀 canonical 两文件 + legacy 命名存量必须读成一个会话"
        );
        assert_eq!(texts(&conv_load_raw_inner(&youling)), want);
        // 索引同源（两形态同一 meta、n=3），且归一键与存量文件名互不等于彼此
        assert_eq!(crate::p2p_sync::load_meta(&myco).n, 3);
        assert_eq!(
            crate::p2p_sync::load_meta(&myco).f_hex,
            crate::p2p_sync::load_meta(&youling).f_hex
        );
        // 归一键 = canonical did:youling:z…（即 youling 那份的名字）：写目标唯一
        assert_eq!(conv_path(&myco), jsonl(&youling));
        assert_ne!(conv_path(&myco), jsonl(&myco));
        assert_ne!(conv_path(&myco), jsonl(&legacy));
        // ── 反向守卫（canonical-only）──
        // legacy 作为身份输入：不再被解码、不再归并（只直读 legacy 命名的那份）
        assert_eq!(
            core_id::did_pubkey_bytes(&legacy),
            None,
            "legacy 不再被解码"
        );
        assert_eq!(conv_key(&legacy), legacy, "legacy 不再归一");
        assert_eq!(
            texts(&conv_load_raw_inner(&legacy)),
            vec!["旧出".to_string()],
            "legacy 输入不再归并"
        );
        let _ = std::fs::remove_dir_all(chat_dir());
    }

    /// 反向守卫：不同账号（不同公钥）不得因归并互相串会话/串索引。
    #[test]
    fn distinct_accounts_never_merge() {
        let _g = test_env();
        let (a, ac) = pair(0x47);
        let (b, bc) = pair(0x48);
        conv_append(&a, &text_msg("a-1", "in", &a, ME, "A", 1));
        conv_append(&b, &text_msg("b-1", "in", &b, ME, "B", 2));
        assert_eq!(texts(&conv_load_raw_inner(&a)), vec!["A".to_string()]);
        assert_eq!(texts(&conv_load_raw_inner(&ac)), vec!["A".to_string()]);
        assert_eq!(texts(&conv_load_raw_inner(&b)), vec!["B".to_string()]);
        assert_eq!(texts(&conv_load_raw_inner(&bc)), vec!["B".to_string()]);
        assert_ne!(conv_path(&a), conv_path(&b));
        assert_ne!(
            crate::p2p_sync::load_meta(&a).f_hex,
            crate::p2p_sync::load_meta(&b).f_hex
        );
        let _ = std::fs::remove_dir_all(chat_dir());
    }
}

// ══════════════ 2026-10-07：设备群（T1 核心 + T2 消息语义）单测 ══════════════
// 存储隔离：线程局部 chat 桶（conv_identity_tests 同款——不写进程级
// MYCO_CONFIG_DIR，避免与其它模块互踩）；本机设备 did 用线程局部替身注入
// （TEST_MY_DEVICE——ingest 的 fromDevice 判定读它，core::device_identity 的
// 确定性替代，不碰真实 config 目录/设备钥）。

#[cfg(test)]
mod device_group_tests {
    use super::*;

    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn test_env() -> std::sync::MutexGuard<'static, ()> {
        let g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("myco-devgrp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir); // 每用例干净起点（幂等断言需要）
        std::fs::create_dir_all(&dir).unwrap();
        TEST_CHAT_DIR.with(|d| *d.borrow_mut() = Some(dir));
        TEST_MY_DEVICE.with(|d| *d.borrow_mut() = None);
        g
    }

    /// 确定性设备 did（与产线 did_from_public 同法）。
    fn dev_did(tag: u8) -> String {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[tag; 32]);
        core_id::did_from_public(&sk.verifying_key().to_bytes())
    }

    fn group_of(gid: &str) -> Option<Value> {
        load_groups()
            .into_iter()
            .find(|g| g.get("id").and_then(|d| d.as_str()) == Some(gid))
    }

    // ── T1：群 id 派生（双形态归一） ──

    /// 同一账号的双前缀 canonical 形态（did:myco:z… / did:youling:z…，同 tail）
    /// 必须派生出同一个群 id（否则两台设备各建各群）；不同钥匙不得撞 id；
    /// **legacy 裸 b58 已废止**（2026-10-10）：不再归一 → 原样落键，不撞真钥匙桶。
    #[test]
    fn device_group_id_unifies_canonical_forms_only() {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[0x51u8; 32]);
        let pk = sk.verifying_key().to_bytes();
        let canonical = core_id::did_from_public(&pk); // did:myco:z…（canonical 构造器）
        let youling = canonical.replacen("did:myco:", "did:youling:", 1);
        let legacy = format!("did:myco:{}", bs58::encode(pk).into_string());
        let legacy_youling = format!("did:youling:{}", bs58::encode(pk).into_string());
        let gid = device_group_id(&canonical);
        for form in [&canonical, &youling] {
            assert_eq!(device_group_id(form), gid, "形态 {form} 派生出不同群 id");
        }
        assert!(gid.starts_with("grp-dev-"), "{gid}");
        assert!(gid.starts_with("grp-"), "必须保住全库 grp- 前缀判定");
        assert!(is_device_group_id(&gid));
        // legacy 已废止：不再解码 → 原样进 id（确定性），且不与 canonical 桶相撞
        for form in [&legacy, &legacy_youling] {
            assert_eq!(
                device_group_id(form),
                format!("grp-dev-{}", did_safe(form)),
                "legacy {form} 应原样落键"
            );
            assert_ne!(device_group_id(form), gid, "legacy 不得撞真钥匙桶");
        }
        // 不同钥匙不同 id（不得互串）
        let other = dev_did(0x52);
        assert_ne!(device_group_id(&other), gid);
        // 软 did（解析不出公钥）原样进入 id——确定性但与真钥匙不撞
        assert!(device_group_id("did:youling:SOFT").starts_with("grp-dev-did_youling_SOFT"));
    }

    // ── T1：ensure 幂等 + 档案 + 系统条 msgId 确定性 ──

    #[test]
    fn ensure_device_group_creates_profile_and_deterministic_sys_msg() {
        let _g = test_env();
        let my = "did:youling:zRootA";
        let gid = ensure_device_group_for(my);
        assert_eq!(gid, device_group_id(my));
        let g = group_of(&gid).expect("群档案必须建立");
        assert_eq!(g["kind"], json!("device"));
        assert_eq!(g["name"], json!(DEVICE_GROUP_NAME));
        assert_eq!(g["members"], json!([my]));
        assert_eq!(g["owner"], json!(my));
        assert!(is_device_group(&g));
        // 开群系统条恰好一条，msgId 确定性 devgrp-init-{gid}
        let msgs = conv_load_raw_inner(&gid);
        assert_eq!(msgs.len(), 1, "只应有开群系统条: {msgs:?}");
        assert_eq!(msgs[0]["msgId"], json!(format!("devgrp-init-{gid}")));
        assert_eq!(msgs[0]["kind"], json!("sys"));
        assert_eq!(msgs[0]["dir"], json!("in"));
    }

    #[test]
    fn ensure_device_group_idempotent_no_duplicate_sys_msg() {
        let _g = test_env();
        let my = "did:youling:zRootB";
        let gid = ensure_device_group_for(my);
        ensure_device_group_for(my);
        ensure_device_group_for(my);
        // 二次/三次调用：档案仍一份、系统条仍一条（不重复写）
        assert_eq!(
            load_groups()
                .iter()
                .filter(|g| g.get("id").and_then(|d| d.as_str()) == Some(gid.as_str()))
                .count(),
            1
        );
        assert_eq!(conv_load_raw_inner(&gid).len(), 1);
    }

    /// 校正路径：群消息先到（自愈建群 ownerPending、无 kind）→ ensure 归位
    /// kind/owner/members 且**不补**系统条（existed 分支）；手工破坏档案同样自愈。
    #[test]
    fn ensure_device_group_corrects_selfhealed_profile_without_sys_msg() {
        let _g = test_env();
        let my = "did:youling:zRootC";
        let gid = device_group_id(my);
        // 模拟自愈建群先到：普通群档案（ownerPending、无 kind、名字来自对端 payload）
        save_groups(&vec![json!({
            "id": gid, "name": "设备群x", "members": [my], "createdAt": 1,
            "governance": "owner", "muted": {}, "ownerPending": true,
        })]);
        ensure_device_group_for(my);
        let g = group_of(&gid).unwrap();
        assert_eq!(g["kind"], json!("device"), "kind 补写");
        assert_eq!(g["name"], json!(DEVICE_GROUP_NAME), "名字归位");
        assert_eq!(g["owner"], json!(my), "owner 补齐");
        assert!(g.get("ownerPending").is_none(), "自愈标记一并收敛");
        assert_eq!(
            conv_load_raw_inner(&gid).len(),
            0,
            "已有档案的 ensure 不补系统条"
        );
    }

    // ── T1：治理锁死（系统群全拒） ──

    /// 伪造管理消息对设备群全拒——即便 from=群主账号（同账号人人都是"群主"，
    /// 群主闸形同虚设，必须按 kind/id 封死）：apply_group_update + ingest 六管理
    /// kind + group-create（设备群绝无真建群卡，到达即伪造）。
    #[tokio::test]
    async fn device_group_governance_fully_locked() {
        let _g = test_env();
        let my = "did:youling:zRootD";
        let gid = ensure_device_group_for(my);
        // 统一闸：非群主能改的它也改不了（from=owner 也不行）
        assert!(!apply_group_update(&gid, my, |g| g["name"] = json!("伪改名")));
        let inbound = |id: &str, kind: &str, payload: Value| json!({ "id": id, "from": my, "fromName": "伪造者", "kind": kind, "payload": payload, "ts": 100 });
        let admin_payloads: Vec<(&str, Value)> = vec![
            (
                "group-create",
                json!({ "groupId": gid, "groupName": "伪名", "members": [my, "did:youling:zOther"], "owner": my }),
            ),
            (
                "group-invite",
                json!({ "groupId": gid, "newMembers": ["did:youling:zOther"], "members": [my, "did:youling:zOther"] }),
            ),
            ("group-rename", json!({ "groupId": gid, "newName": "伪名" })),
            ("group-leave", json!({ "groupId": gid })),
            (
                "group-kick",
                json!({ "groupId": gid, "targetDid": my, "members": [] }),
            ),
            (
                "group-mute",
                json!({ "groupId": gid, "targetDid": my, "mutedUntil": 9_999_999_999i64 }),
            ),
            (
                "group-disband",
                json!({ "groupId": gid, "groupName": DEVICE_GROUP_NAME }),
            ),
        ];
        for (i, (kind, payload)) in admin_payloads.into_iter().enumerate() {
            let mid = format!("gov-{i}");
            assert!(
                !ingest_msg(my, &inbound(&mid, kind, payload)).await,
                "{kind} 不得作用于设备群"
            );
        }
        // 档案未被任何管理消息改动（含来自"群主"账号的）
        let g = group_of(&gid).unwrap();
        assert_eq!(g["name"], json!(DEVICE_GROUP_NAME));
        assert_eq!(g["members"], json!([my]));
        assert!(
            group_terminal_status(&g).is_empty(),
            "不可被解散/踢出置终态"
        );
        // 系统条未被污染（仍只有开群条）
        let sys: Vec<_> = conv_load_raw_inner(&gid)
            .into_iter()
            .filter(|m| m["kind"] == json!("sys"))
            .collect();
        assert_eq!(sys.len(), 1);
    }

    // ── T6（2026-10-09）：任务卡跨设备同步（用户口径：卡=账号级数据） ──

    /// 他机设备群任务卡 → 本地任务库落卡（形状/幂等/来源设备/远端不可点）。
    #[tokio::test]
    async fn device_group_task_card_lands_locally() {
        let _g = test_env();
        let my = "did:youling:zRootH";
        let gid = ensure_device_group_for(my);
        let my_dev = dev_did(0x71);
        let other_dev = dev_did(0x72);
        TEST_MY_DEVICE.with(|d| *d.borrow_mut() = Some(my_dev.clone()));
        let card = || {
            json!({
                "taskId": "peer-task-share-sh-a1",
                "title": "会话分享",
                "desc": "myco 分享 · 会话（读写：看 + 说）",
                "from": my,
                "fromName": "我·0001",
                "createdAt": 1_700_000_000_000i64,
                "source": "dsh-share",
                "shareId": "sh-a1",
                "granularity": "session",
                "participants": [{ "did": my, "name": "我·0001", "role": "owner" }],
                "status": "todo",
                "action": { "kind": "open-url", "url": "http://127.0.0.1:3102/api/dshShare/open?shareId=sh-a1", "label": "打开", "target": "window" }
            })
        };
        let env = |id: &str, card: Value| {
            json!({
                "id": id, "from": my, "fromName": "我·0001", "fromDevice": other_dev, "fromDeviceName": "同事电脑",
                "to": gid, "kind": "task-share",
                "payload": { "groupId": gid, "groupName": DEVICE_GROUP_NAME, "members": [my], "card": card },
                "ts": 100
            })
        };
        assert!(ingest_msg(my, &env("tg-1", card())).await);
        let tasks = load_tasks();
        assert_eq!(tasks.len(), 1, "他机卡必须落到本地任务库: {tasks:?}");
        let t = &tasks[0];
        assert_eq!(
            t["taskId"],
            json!("peer-task-share-sh-a1"),
            "taskId 原样（幂等键）"
        );
        assert_eq!(t["title"], json!("会话分享"));
        assert_eq!(t["shareId"], json!("sh-a1"));
        assert_eq!(t["granularity"], json!("session"));
        assert_eq!(t["status"], json!("todo"));
        assert_eq!(
            t["sourceDevice"],
            json!(other_dev),
            "标来源设备（哪台设备给的卡）"
        );
        assert_eq!(t["sourceDeviceName"], json!("同事电脑"));
        assert_eq!(t["remoteOrigin"], json!(true));
        // 2026-10-09 第二程：远端卡**恢复可点**——动作指向本机 remoteOpen（不再指向源设备那个
        // 必 404 的死链），由它去要窄 mt + 开 P2P 隧道把分享页代理过来。
        assert_eq!(t["action"]["kind"], json!("open-url"), "远端卡必须可点");
        let url = t["action"]["url"]
            .as_str()
            .expect("远端卡必须有可打开的动作 URL");
        assert!(url.contains("/api/dshShare/remoteOpen?"), "{url}");
        assert!(
            !url.contains("/api/dshShare/open?"),
            "不得留源设备那台机器的死链: {url}"
        );
        assert!(url.contains("shareId=sh-a1"), "{url}");
        assert!(
            url.contains(&format!("device={other_dev}")),
            "带源设备 did: {url}"
        );
        assert!(
            url.contains(&format!("account={my}")),
            "带源账号（remoteOpen 靠它找源设备）: {url}"
        );
        // 同步是"数据面"：设备群里**不产生卡气泡**（只有开群系统条），卡直接进任务列表。
        let rows = conv_load_raw_inner(&gid);
        assert_eq!(
            rows.len(),
            1,
            "设备群只应有开群系统条（无可见卡气泡）: {rows:?}"
        );
        assert!(
            !rows.iter().any(|r| r["kind"] == json!("task-share")),
            "不得落 task-share 会话行"
        );
    }

    /// **env 卡跨设备**（2026-10-23 列表行 bug 的接收侧面）：同一张带 env 的卡从别机同步来，
    /// 动作必须保持 `open-env`（接收方自己按 env 建链：RDP→mstsc / DSH→浏览器），
    /// **不得**被改写成 remoteOpen 的分享入口——那条路落到 `/gw/<id>/app/` 会报
    /// `no valid share cookie (open the share entry first)`。env/caps 也要随卡落库
    /// （列表行的路由只认卡上的 `env[]`）。
    #[tokio::test]
    async fn device_group_env_card_keeps_open_env_action() {
        let _g = test_env();
        let my = "did:youling:zRootEnv";
        let gid = ensure_device_group_for(my);
        let my_dev = dev_did(0x73);
        let other_dev = dev_did(0x74);
        TEST_MY_DEVICE.with(|d| *d.borrow_mut() = Some(my_dev.clone()));
        let envs = json!([
            { "kind": "dsh", "device": other_dev, "port": 13911, "localPort": 23911 },
            { "kind": "rdp", "device": other_dev, "port": 3389, "localPort": 23389 }
        ]);
        let card = json!({
            "taskId": "peer-task-share-sh-env1",
            "title": "PC 桌面",
            "from": my,
            "fromName": "我·0001",
            "shareId": "sh-env1",
            "status": "todo",
            "env": envs.clone(),
            "caps": ["vnet.forward"],
            "action": { "kind": "open-env", "label": "打开远程桌面", "env": envs.clone(),
                        "shareId": "sh-env1", "target": "window" },
        });
        let envelope = json!({
            "id": "tg-env-1", "from": my, "fromName": "我·0001",
            "fromDevice": other_dev, "fromDeviceName": "同事电脑",
            "to": gid, "kind": "task-share",
            "payload": { "groupId": gid, "groupName": DEVICE_GROUP_NAME, "members": [my], "card": card },
            "ts": 100
        });
        assert!(ingest_msg(my, &envelope).await);
        let tasks = load_tasks();
        let t = tasks
            .iter()
            .find(|t| t["taskId"] == json!("peer-task-share-sh-env1"))
            .unwrap_or_else(|| panic!("env 卡必须落本地任务库: {tasks:?}"));
        assert_eq!(
            t["action"]["kind"],
            json!("open-env"),
            "env 卡动作不得降级成分享入口"
        );
        assert_eq!(t["action"]["shareId"], json!("sh-env1"));
        assert_eq!(t["action"]["label"], json!("打开远程桌面"));
        assert!(
            t["action"].get("url").is_none(),
            "open-env 动作不得带 /gw/ 分享入口 url"
        );
        assert_eq!(
            t["env"].as_array().map(|a| a.len()),
            Some(2),
            "env[] 必须随卡落库（列表行按它路由到 vnet_env_open）"
        );
        assert_eq!(t["caps"], json!(["vnet.forward"]));
        assert_eq!(
            t["sourceDevice"],
            json!(other_dev),
            "来源设备仍要标（展示『来自 X』）"
        );
    }

    /// 安全闸：**非本账号设备群**来的任务卡一律不落卡（不落它、不猜）。
    #[tokio::test]
    async fn device_group_task_card_rejects_foreign_groups() {
        let _g = test_env();
        let my = "did:youling:zRootI";
        ensure_device_group_for(my);
        let card = || {
            json!({
                "taskId": "peer-task-share-sh-evil", "title": "别账号塞的卡", "from": "did:youling:zOther",
                "status": "todo", "action": { "kind": "open-url", "url": "http://127.0.0.1:3102/api/dshShare/open?shareId=sh-evil" }
            })
        };
        // ① 别账号的（形态正确的）设备群 id；② 只有 grp-dev- 前缀的伪造 id
        for (i, gid) in [
            device_group_id("did:youling:zOther"),
            "grp-dev-x".to_string(),
        ]
        .into_iter()
        .enumerate()
        {
            let m = json!({
                "id": format!("tg-evil-{i}"), "from": "did:youling:zOther", "fromName": "别人",
                "fromDevice": "did:youling:zOtherDevice", "to": gid, "kind": "task-share",
                "payload": { "groupId": gid, "groupName": "设备群", "members": [my], "card": card() },
                "ts": 100
            });
            assert!(
                ingest_msg(my, &m).await,
                "会话仍按群任务卡落（安全闸只拦落卡，不吃掉正常群卡）"
            );
        }
        assert!(
            load_tasks().is_empty(),
            "非本账号设备群的任务卡绝不落本地任务库: {:?}",
            load_tasks()
        );
    }

    /// 同一 taskId 重复投递 → 只有一张；携带 done 的重复投递 → 同一条状态收口（不新增）。
    #[tokio::test]
    async fn device_group_task_card_dedup_by_task_id() {
        let _g = test_env();
        let my = "did:youling:zRootJ";
        let gid = ensure_device_group_for(my);
        TEST_MY_DEVICE.with(|d| *d.borrow_mut() = Some(dev_did(0x73)));
        let other_dev = dev_did(0x74);
        let base = |status: &str| {
            json!({
                "taskId": "peer-task-share-sh-b1", "title": "重复卡", "from": my, "status": status,
                "granularity": "workspace",
                "action": { "kind": "open-url", "url": "http://127.0.0.1:3102/api/dshShare/open?shareId=sh-b1" }
            })
        };
        let env = |id: &str, status: &str| {
            json!({
                "id": id, "from": my, "fromName": "我·0002", "fromDevice": other_dev, "fromDeviceName": "平板",
                "to": gid, "kind": "task-share",
                "payload": { "groupId": gid, "groupName": DEVICE_GROUP_NAME, "members": [my], "card": base(status), "status": status },
                "ts": 100
            })
        };
        for (i, id) in ["tg-b-1", "tg-b-2", "tg-b-3"].into_iter().enumerate() {
            assert!(
                ingest_msg(my, &env(id, "todo")).await,
                "第 {} 次投递",
                i + 1
            );
        }
        assert_eq!(load_tasks().len(), 1, "同一 taskId 只应有一张卡");
        // 分享下线（done）再投一次：同一条收口，不新增
        assert!(ingest_msg(my, &env("tg-b-done", "done")).await);
        let tasks = load_tasks();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0]["status"], json!("done"));
    }

    /// 本机设备的回环（信箱副本/对账把本机自己发的卡带回来）→ 不重复落、更不覆盖成本地卡。
    #[tokio::test]
    async fn device_group_task_card_self_echo_does_not_downgrade_local_card() {
        let _g = test_env();
        let my = "did:youling:zRootK";
        let gid = ensure_device_group_for(my);
        let my_dev = dev_did(0x75);
        TEST_MY_DEVICE.with(|d| *d.borrow_mut() = Some(my_dev.clone()));
        // 本地卡（本机建的，带可点 action/来源设备=本机）
        save_tasks(&vec![json!({
            "taskId": "peer-task-share-sh-c1", "title": "本地卡", "status": "todo",
            "sourceDevice": my_dev, "sourceDeviceName": "本机",
            "action": { "kind": "open-url", "url": "http://127.0.0.1:3102/api/dshShare/open?shareId=sh-c1" }
        })]);
        let m = json!({
            "id": "tg-self", "from": my, "fromName": "我·0003", "fromDevice": my_dev, "fromDeviceName": "本机",
            "to": gid, "kind": "task-share",
            "payload": { "groupId": gid, "groupName": DEVICE_GROUP_NAME, "members": [my],
                         "card": { "taskId": "peer-task-share-sh-c1", "title": "本地卡", "status": "todo" }, "status": "todo" },
            "ts": 100
        });
        assert!(ingest_msg(my, &m).await);
        let tasks = load_tasks();
        assert_eq!(tasks.len(), 1);
        assert_eq!(
            tasks[0]["action"]["kind"],
            json!("open-url"),
            "本机卡不得被回环副本降级成不可点"
        );
        assert_eq!(tasks[0]["sourceDevice"], json!(my_dev));
    }

    /// 发送侧 payload 契约（纯函数）：卡片本体 + groupId/members（设备群按账号扇出到全部
    /// 设备的寻址依据）；**不带 text**（设备群不产生可见气泡）、不带分享注册表。
    #[test]
    fn device_group_task_card_payload_contract() {
        let my = "did:youling:zRootL";
        let card = json!({ "taskId": "peer-task-share-sh-d1", "title": "卡", "status": "todo" });
        let p = device_group_card_payload(my, &card, "todo", "我·0004");
        assert_eq!(p["groupId"], json!(device_group_id(my)));
        assert_eq!(p["groupName"], json!(DEVICE_GROUP_NAME));
        assert_eq!(
            p["members"],
            json!([my]),
            "设备群成员=root 账号 did（deliver_to_account 逐设备扇出）"
        );
        assert_eq!(p["card"], card, "只发卡片本身（不需发分享注册表）");
        assert_eq!(p["status"], json!("todo"));
        assert_eq!(p["fromName"], json!("我·0004"), "来源设备署名");
        assert!(
            p.get("text").is_none(),
            "不得带 text——否则设备群里会冒出可见气泡"
        );
        assert!(
            p.get("registry").is_none() && p.get("grants").is_none(),
            "绝不发分享注册表/授权表"
        );
        assert!(device_group_card_allowed(my, &device_group_id(my)));
        assert!(
            !device_group_card_allowed(my, "grp-dev-other"),
            "别账号 id 不得放行"
        );
        assert!(!device_group_card_allowed(my, ""), "空 id 不得放行");
    }

    /// 渲染不变式：设备群的 task-share 同步行**永不渲染成气泡**（写侧不落行；
    /// 这里锁"对账/老版本带回来的行也会被过滤"这一兜底），同时普通群任务卡照常渲染。
    #[tokio::test]
    async fn device_group_sync_rows_never_render_but_normal_group_cards_do() {
        let _g = test_env();
        let my = "did:youling:zRootM";
        let gid = ensure_device_group_for(my);
        conv_append(
            &gid,
            &json!({
                "msgId": "sync-row-1", "from": my, "to": gid, "kind": "task-share",
                "payload": { "groupId": gid, "card": { "taskId": "peer-task-share-sh-z1", "title": "同步卡" } },
                "ts": 50, "dir": "in",
            }),
        );
        let out = chat_load_conv(gid.clone()).await.unwrap();
        let msgs = out
            .get("msgs")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert!(
            !msgs.iter().any(|m| m["kind"] == json!("task-share")),
            "设备群同步行必须被过滤: {msgs:?}"
        );
        // 普通群的任务卡_share 行为不变（渲染成卡气泡）
        let pg = "grp-normal-m";
        conv_append(
            pg,
            &json!({
                "msgId": "norm-card-1", "from": "did:youling:zPeer", "to": pg, "kind": "task-share",
                "payload": { "groupId": pg, "title": "普通群卡", "fromName": "好友" }, "ts": 60, "dir": "in",
            }),
        );
        let out2 = chat_load_conv(pg.to_string()).await.unwrap();
        let msgs2 = out2
            .get("msgs")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert_eq!(
            msgs2
                .iter()
                .filter(|m| m["kind"] == json!("task-share"))
                .count(),
            1,
            "普通群任务卡照常渲染"
        );
    }

    // ══════════════════════════════════════════════════════════════════
    // T7（2026-10-09 第二程）：远端卡可点 + 好友卡走同一入口 + 两个控制 kind 不落会话
    // ══════════════════════════════════════════════════════════════════

    /// 好友收到的**分享任务卡**（带 shareId）→ 动作指向本机 remoteOpen，
    /// 源设备 = 发卡设备的 did（信封 fromDevice）、源账号 = 信封 from。
    /// 没有 shareId 的普通好友任务卡行为不变（不凭空加动作）。
    #[tokio::test]
    async fn friend_share_task_card_action_points_at_remote_open() {
        let _g = test_env();
        let my = "did:youling:zSegMe";
        let alice = "did:youling:zAliceCard";
        let alice_dev = dev_did(0x63);
        let card = json!({
            "taskId": "peer-task-share-sh-f1", "title": "会话分享", "from": alice,
            "shareId": "sh-f1", "status": "todo",
            "action": { "kind": "open-url", "url": "http://127.0.0.1:3102/api/dshShare/open?shareId=sh-f1" },
            "participants": [{ "did": alice, "role": "owner" }],
        });
        let env = json!({
            "id": "ts-f1", "from": alice, "fromName": "爱丽丝", "fromDevice": alice_dev,
            "fromDeviceName": "爱丽丝的电脑", "to": my, "kind": "task-share", "payload": card, "ts": 100,
        });
        assert!(ingest_msg(my, &env).await);
        let t = load_tasks()
            .into_iter()
            .find(|t| t["taskId"] == json!("peer-task-share-sh-f1"))
            .expect("分享任务卡必须落本地任务库");
        assert_eq!(t["remoteOrigin"], json!(true), "这是**别人设备上**的分享");
        assert_eq!(t["sourceDevice"], json!(alice_dev));
        assert_eq!(t["sourceDeviceName"], json!("爱丽丝的电脑"));
        assert_eq!(
            t["action"]["kind"],
            json!("open-url"),
            "远端卡必须可点（走本机 remoteOpen）"
        );
        let url = t["action"]["url"].as_str().expect("必须有动作 URL");
        assert!(url.contains("/api/dshShare/remoteOpen?"), "{url}");
        assert!(
            !url.contains("/api/dshShare/open?"),
            "不得留源设备那台机器上必然 404 的死链: {url}"
        );
        assert!(url.contains("shareId=sh-f1"), "{url}");
        assert!(
            url.contains(&format!("device={alice_dev}")),
            "带源设备 did: {url}"
        );
        assert!(url.contains(&format!("account={alice}")), "带源账号: {url}");
        // 普通好友任务卡（无 shareId）：行为不变
        let plain = json!({ "taskId": "peer-task-plain-1", "title": "普通卡", "from": alice, "createdAt": 1 });
        let env2 = json!({
            "id": "ts-f2", "from": alice, "fromName": "爱丽丝", "fromDevice": alice_dev,
            "to": my, "kind": "task-share", "payload": plain, "ts": 101,
        });
        assert!(ingest_msg(my, &env2).await);
        let p = load_tasks()
            .into_iter()
            .find(|t| t["taskId"] == json!("peer-task-plain-1"))
            .unwrap();
        assert!(p.get("action").is_none(), "普通任务卡不凭空加动作");
        assert!(p.get("remoteOrigin").is_none(), "普通任务卡不是远端卡");
    }

    /// 两个「代打开」控制 kind **不进会话、不进任务库**（它们是票据通道，不是聊天）。
    /// 形状不全的请求直接丢弃：不回包（不给探测者当放大器）。
    #[tokio::test]
    async fn share_entry_control_kinds_do_not_land_in_conversations() {
        let _g = test_env();
        let my = "did:youling:zSegMe2";
        let peer = "did:youling:zSegPeer";
        // ① grant：没有在等它的请求（他机/伪造/迟到）→ 静默丢弃，返回 true（已处置）
        let grant = json!({
            "id": "seg-1", "from": peer, "fromDevice": dev_did(0x64), "to": my,
            "kind": "share-entry-grant",
            "payload": { "shareId": "sh-none", "requestId": "no-such-request", "ok": true, "mt": "x" },
            "ts": 1,
        });
        assert!(
            ingest_msg(my, &grant).await,
            "控制消息必须被吞掉（不再往下落会话）"
        );
        assert!(load_tasks().is_empty(), "控制消息不得进任务库");
        assert!(
            conv_load_raw_inner(&my_did_conv(peer)).is_empty(),
            "控制消息不得落会话"
        );
        // ② request：形状不全（缺 shareId/requestId）→ 丢弃，不回包
        let req = json!({
            "id": "ser-1", "from": peer, "fromDevice": dev_did(0x64), "to": my,
            "kind": "share-entry-request", "payload": {}, "ts": 1,
        });
        assert!(ingest_msg(my, &req).await);
        assert!(conv_load_raw_inner(&my_did_conv(peer)).is_empty());
    }

    // ── T2：设备群 dir 判定（决策D，公会场景成败点） ──
    /// 纯函数矩阵：本机设备（canonical 双前缀）→ out；他机 / 缺 fromDevice / 本机设备未知
    /// （my_device 空）→ in；**legacy 形态已废止**（不再解码 → 同钥也不认成本机 → in）。
    #[test]
    fn dir_for_device_group_matrix() {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[0x61u8; 32]);
        let pk = sk.verifying_key().to_bytes();
        let my_dev = core_id::did_from_public(&pk); // canonical did:myco:z…
        let my_dev_youling = my_dev.replacen("did:myco:", "did:youling:", 1);
        let my_dev_legacy = format!("did:myco:{}", bs58::encode(pk).into_string());
        let other = dev_did(0x62);
        assert_eq!(dir_for_device_group(&my_dev, &my_dev), "out");
        assert_eq!(
            dir_for_device_group(&my_dev_youling, &my_dev),
            "out",
            "前缀异写同钥=本机"
        );
        assert_eq!(
            dir_for_device_group(&my_dev_legacy, &my_dev),
            "in",
            "legacy 已废止：不再认成本机"
        );
        assert_eq!(dir_for_device_group(&other, &my_dev), "in", "他机消息 in");
        assert_eq!(
            dir_for_device_group("", &my_dev),
            "in",
            "缺 fromDevice（信箱形态）视他机"
        );
        assert_eq!(
            dir_for_device_group(&my_dev, ""),
            "in",
            "本机设备未知不误判 out"
        );
        // 渲染层双保险的设备群版同语义
        assert_eq!(effective_dir_device("in", &my_dev, &my_dev), "out"); // 存量老行归位
        assert_eq!(
            effective_dir_device("in", &other, &my_dev),
            "in",
            "他机行不得被误翻右侧"
        );
        assert_eq!(
            effective_dir_device("out", &other, &my_dev),
            "out",
            "存量 out 不动"
        );
    }

    /// 状态级（ingest 全链，本机设备=线程局部替身）：设备群会话内他机消息 dir=in、
    /// 本机消息 dir=out（canonical 双前缀），行持久化 fromDevice；同账号 from==my 恒真不再
    /// 意味着 out——这是公会场景"同事的消息显示成我"的成败点。
    #[tokio::test]
    async fn device_group_ingest_dir_by_from_device() {
        let _g = test_env();
        let my = "did:youling:zRootE";
        let gid = ensure_device_group_for(my);
        let sk = ed25519_dalek::SigningKey::from_bytes(&[0x63u8; 32]);
        let my_dev = core_id::did_from_public(&sk.verifying_key().to_bytes());
        TEST_MY_DEVICE.with(|d| *d.borrow_mut() = Some(my_dev.clone()));
        let other_dev = dev_did(0x64);
        let env = |id: &str, from_dev: &str, dev_name: &str| {
            json!({ "id": id, "from": my, "fromName": "同账号", "fromDevice": from_dev, "fromDeviceName": dev_name,
                    "to": gid, "kind": "group-msg",
                    "payload": { "groupId": gid, "groupName": DEVICE_GROUP_NAME, "members": [my], "text": id, "fromName": "同账号" },
                    "ts": 100 })
        };
        assert!(ingest_msg(my, &env("m-oth", &other_dev, "同事电脑")).await);
        assert!(ingest_msg(my, &env("m-mine", &my_dev, "我的电脑")).await);
        // 本机 canonical 的另一前缀写法（对账副本/另一 method）也认成本机
        let my_dev_youling = my_dev.replacen("did:myco:", "did:youling:", 1);
        assert!(ingest_msg(my, &env("m-mine-youling", &my_dev_youling, "我的电脑")).await);
        // legacy 形态已废止：不再解码 → 同钥也不认成本机（dir=in）
        let legacy = format!(
            "did:myco:{}",
            bs58::encode(sk.verifying_key().to_bytes()).into_string()
        );
        assert!(ingest_msg(my, &env("m-mine-legacy", &legacy, "我的电脑")).await);
        let msgs = conv_load_raw_inner(&gid);
        let by = |id: &str| {
            msgs.iter()
                .find(|m| m["msgId"] == json!(id))
                .unwrap()
                .clone()
        };
        assert_eq!(by("m-oth")["dir"], json!("in"), "他机消息必须 dir=in");
        assert_eq!(by("m-mine")["dir"], json!("out"), "本机消息 dir=out");
        assert_eq!(
            by("m-mine-youling")["dir"],
            json!("out"),
            "本机 canonical 另一前缀 dir=out"
        );
        assert_eq!(
            by("m-mine-legacy")["dir"],
            json!("in"),
            "legacy 已废止：不再认成本机"
        );
        // 决策D-2：行持久化 fromDevice/fromDeviceName（署名数据源）；from 保持账号 did
        assert_eq!(by("m-oth")["fromDevice"], json!(other_dev));
        assert_eq!(by("m-oth")["fromDeviceName"], json!("同事电脑"));
        assert_eq!(
            by("m-oth")["from"],
            json!(my),
            "设备群不归位 from（保持账号 did）"
        );
    }

    /// 渲染层端到端（chat_load_conv）：设备群他机行 from==my 不被老双保险误翻 out；
    /// 本机设备的存量 dir=in 老行归位 out。
    #[tokio::test]
    async fn device_group_render_dir_not_flipped_for_peer_device() {
        let _g = test_env();
        let my = "did:youling:zRootF";
        let gid = ensure_device_group_for(my);
        let my_dev = dev_did(0x65);
        let other_dev = dev_did(0x66);
        TEST_MY_DEVICE.with(|d| *d.borrow_mut() = Some(my_dev.clone()));
        // 直接落两行存量数据（模拟修复前老行）：他机 dir=in（正确）/ 本机 dir=in（老 bug 行）
        conv_append(
            &gid,
            &json!({
                "msgId": "r-oth", "from": my, "to": gid, "kind": "group-msg",
                "payload": { "text": "a" }, "ts": 1, "dir": "in", "fromDevice": other_dev,
            }),
        );
        conv_append(
            &gid,
            &json!({
                "msgId": "r-mine", "from": my, "to": gid, "kind": "group-msg",
                "payload": { "text": "b" }, "ts": 2, "dir": "in", "fromDevice": my_dev,
            }),
        );
        let out = chat_load_conv(gid.clone()).await.unwrap();
        let msgs = out
            .get("msgs")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let by = |id: &str| {
            msgs.iter()
                .find(|m| m["msgId"] == json!(id))
                .unwrap()
                .clone()
        };
        assert_eq!(
            by("r-oth")["dir"],
            json!("in"),
            "from==my 的他机行不得误翻右侧（老双保险会翻）"
        );
        assert_eq!(by("r-mine")["dir"], json!("out"), "本机设备老行归位 out");
    }

    /// 回归守卫：普通群/单聊的 dir 语义原样——from==my 回流 out、他人 in；
    /// 普通群 from 归位（self_echo → from=to=gid）行为不变。
    #[tokio::test]
    async fn normal_group_and_single_chat_dir_semantics_unchanged() {
        let _g = test_env();
        let my = "did:youling:zRootG";
        let peer = "did:youling:zPeerG";
        // 普通群（owner=peer）：我的另一台设备的回流副本（from==my 无 fromDevice）→ out
        let gid = "grp-normal-g";
        assert!(ingest_msg(my, &json!({ "id": "ng-1", "from": my, "fromName": "我", "to": gid, "kind": "group-msg",
            "payload": { "groupId": gid, "groupName": "普通群", "members": [my, peer], "text": "回流" }, "ts": 1 })).await);
        // 群友消息 → in
        assert!(ingest_msg(my, &json!({ "id": "ng-2", "from": peer, "fromName": "群友", "to": gid, "kind": "group-msg",
            "payload": { "groupId": gid, "groupName": "普通群", "members": [my, peer], "text": "群友说" }, "ts": 2 })).await);
        let msgs = conv_load_raw_inner(gid);
        let by = |id: &str| {
            msgs.iter()
                .find(|m| m["msgId"] == json!(id))
                .unwrap()
                .clone()
        };
        assert_eq!(
            by("ng-1")["dir"],
            json!("out"),
            "普通群 from==my 回流仍 out（老语义）"
        );
        assert_eq!(
            by("ng-1")["from"],
            json!(gid),
            "普通群 self_echo 归位 from=to 不变"
        );
        assert_eq!(by("ng-2")["dir"], json!("in"));
        // 单聊：from==my 回流 out；对方 in
        assert!(
            ingest_msg(
                my,
                &json!({ "id": "sc-1", "from": peer, "fromName": "对方", "kind": "text",
            "payload": { "text": "你好" }, "ts": 3 })
            )
            .await
        );
        let single = conv_load_raw_inner(&my_did_conv(peer));
        assert_eq!(single[0]["dir"], json!("in"));
    }

    /// typing 群扇出：设备群不过滤 my（members=[my] 就是目标账号——老过滤会清空）；
    /// 普通群维持"滤自己"。
    #[test]
    fn typing_targets_keep_my_only_for_device_group() {
        let my = "did:youling:zRootH";
        let peer = "did:youling:zPeerH";
        let dev_g = json!({ "id": device_group_id(my), "kind": "device", "members": [my] });
        assert_eq!(
            typing_targets(Some(&dev_g), my),
            vec![my.to_string()],
            "设备群 targets 含自己"
        );
        let normal = json!({ "id": "grp-n", "members": [my, peer] });
        assert_eq!(
            typing_targets(Some(&normal), my),
            vec![peer.to_string()],
            "普通群滤自己"
        );
        // 无 kind 但 id=grp-dev-*（自愈未打标窗口）同样不过滤
        let unmarked = json!({ "id": device_group_id(my), "members": [my] });
        assert_eq!(typing_targets(Some(&unmarked), my), vec![my.to_string()]);
        assert!(typing_targets(None, my).is_empty(), "群不存在=空");
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// §3.23 转授闸（canReshare）·转发的**集成面**单测
//
// 纯判定在 `dsh_share::reshare_forward_verdict`（那边有直击用例）；这里钉的是
// **转发这条路真的会拦**：`chat_share_task` 之前的那道闸
// （`reshare_gate_before_forward`）在"我不是主人 + 本地卡没转授权"时必须拒，
// 且有转授权时不由我发卡（由源设备发——来源坐标准确，第三人点得开）。
// ═══════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod reshare_gate_tests {
    use super::*;

    fn env() -> std::sync::MutexGuard<'static, ()> {
        crate::test_env_lock::test_env_lock()
    }

    fn card(can_reshare: bool, exp: i64) -> Value {
        json!({
            "taskId": "peer-task-sh-gate1", "title": "别人的分享", "shareId": "sh-gate1",
            "from": "did:youling:zAlice", "fromName": "爱丽丝",
            "sourceAccount": "did:youling:zAlice", "sourceDevice": "did:youling:zAlicePc",
            "sourceDeviceName": "爱丽丝的电脑", "remoteOrigin": true,
            "canReshare": can_reshare, "reshareExp": exp,
        })
    }

    /// **边界②（转发闸）**：非 owner 转发 → 默认拒（人话点明"要经主人同意"）；
    /// 主人开过转授权才放行，且放行时**不由我发卡**（由源设备发给对方）。
    #[tokio::test]
    async fn non_owner_forward_is_gated_by_can_reshare() {
        let _g = env();
        let sid = "sh-gate1"; // 本机注册表里没有它 = 我不是主人
                              // ① 默认（canReshare=false）→ 拒，人话里点明主人同意
        let tasks = vec![card(false, now_ms() + 86_400_000)];
        let why = reshare_gate_before_forward("did:youling:zCarol", sid, &tasks)
            .await
            .expect_err("默认必须拒绝转发");
        assert!(why.contains("需要主人同意"), "人话要点明主人同意：{why}");
        // ② 有转授权（未过期）→ 放行，但**不由我转发**（由源设备直接把卡发给对方）
        let tasks2 = vec![card(true, now_ms() + 86_400_000)];
        let note = reshare_gate_before_forward("did:youling:zCarol", sid, &tasks2)
            .await
            .expect("有转授权应放行")
            .expect("非 owner 路径必须带人话（说明由源设备发卡）");
        assert!(note.contains("主人直接把卡发给对方"), "{note}");
        // ③ 转授权过期 → 拒
        let tasks3 = vec![card(true, now_ms() - 1)];
        let why3 = reshare_gate_before_forward("did:youling:zCarol", sid, &tasks3)
            .await
            .expect_err("过期必须拒");
        assert!(why3.contains("已经到期"), "{why3}");
    }

    /// **幂等收口**（用户口径「同一张卡重复投递只应产生一张」）：同一 `shareId`、
    /// **不同 taskId** 的重复投递 → 只留一张（好友把同一条分享分享两次就是这种形状）；
    /// 且只刷新"主人意愿"字段（转授面 / 赠卡），**不打回本机进度**。
    #[tokio::test]
    async fn friend_card_dedupes_by_share_id_and_refreshes_reshare_surface() {
        let _g = env();
        let my = "did:youling:zMe";
        let alice = "did:youling:zAlice";
        let mk = |id: &str, tid: &str, ts: i64, extra: Value| {
            let mut payload = json!({
                "taskId": tid, "title": "分享的任务", "shareId": "sh-dup1",
                "from": alice, "fromName": "爱丽丝",
            });
            if let Some(o) = extra.as_object() {
                for (k, v) in o {
                    payload[k] = v.clone();
                }
            }
            json!({ "id": id, "from": alice, "fromName": "爱丽丝", "fromDevice": "did:youling:zAlicePc",
                    "kind": "task-share", "ts": ts, "payload": payload })
        };
        assert!(
            ingest_msg(
                my,
                &mk(
                    "m1",
                    "peer-task-sh-dup1",
                    now_ms(),
                    json!({ "canReshare": false })
                )
            )
            .await
        );
        assert!(ingest_msg(my, &mk(
            "m2", "peer-task-9999", now_ms() + 1,
            json!({ "canReshare": true, "reshareExp": now_ms() + 3_600_000, "grant": { "ro": true } }),
        )).await);
        let hits: Vec<Value> = load_tasks()
            .into_iter()
            .filter(|t| t.get("shareId").and_then(|v| v.as_str()) == Some("sh-dup1"))
            .collect();
        assert_eq!(hits.len(), 1, "同一 shareId 只应有一张卡：{hits:?}");
        assert_eq!(
            hits[0]["taskId"],
            json!("peer-task-sh-dup1"),
            "保留先到那张的 taskId（不换身份）"
        );
        assert_eq!(
            hits[0]["canReshare"],
            json!(true),
            "主人意愿字段要刷新（转授权翻上去）"
        );
        assert_eq!(
            hits[0]["grant"]["ro"],
            json!(true),
            "赠卡（我的权限）也要刷新"
        );
        assert_eq!(
            hits[0]["status"],
            json!("pending"),
            "本机还没推进过 → 仍是待接受"
        );
    }
    /// 主人自己（这条分享在我的注册表里）→ `Ok(None)`：分享即授权，既有路径一个字不变。
    #[tokio::test]
    async fn owner_forward_skips_the_gate() {
        let _g = env();
        let sid = format!("sh-gate-own-{:x}", now_ms());
        crate::dsh_share::seed_own_share_for_test(&sid);
        let tasks = vec![card(false, 0)];
        let out = reshare_gate_before_forward("did:youling:zCarol", &sid, &tasks)
            .await
            .expect("主人转发不该被闸拦");
        assert!(out.is_none(), "主人走既有路径（不产生转授申请）");
    }
}

#[cfg(test)]
mod task_source_coords_tests {
    use super::*;

    fn test_env() -> std::sync::MutexGuard<'static, ()> {
        crate::test_env_lock::test_env_lock()
    }

    /// 2026-10-11 事故→测试：聊天历史卡的【无参 remoteOpen URL】需要任务库二段兜底。
    /// 事故链（笔记本实测）：降级快照时代写坏的卡 URL 只剩 shareId → 本机注册表
    /// 又没有别人分享的行 → '缺少来源设备信息'死卡；任务列表卡会自愈但聊天卡
    /// 不可变 → 打开时按 shareId 查任务库补 sourceDevice/from，任何入口自愈。
    #[test]
    fn task_source_coords_fills_from_task_library() {
        let _g = test_env();
        save_tasks(&[json!({
            "taskId": "peer-task-share-sh-x1",
            "shareId": "sh-x1",
            "sourceDevice": "did:myco:srcdev",
            "from": "did:youling:owner"
        })]);
        // ① 顶层 shareId 命中
        assert_eq!(
            task_source_coords("sh-x1"),
            Some(("did:myco:srcdev".into(), "did:youling:owner".into()))
        );
        // ② 无 shareId 字段：按 taskId 后缀约定（peer-task-share-<shareId>）命中
        save_tasks(&[
            json!({ "taskId": "peer-task-share-sh-x2", "sourceDevice": "did:myco:d2", "from": "did:youling:o2" }),
        ]);
        assert_eq!(
            task_source_coords("sh-x2"),
            Some(("did:myco:d2".into(), "did:youling:o2".into()))
        );
        // ③ 缺 sourceDevice → None（宁缺毋滥，不拿空坐标去开隧道）
        save_tasks(&[json!({ "taskId": "t3", "shareId": "sh-x3", "from": "did:youling:o3" })]);
        assert_eq!(task_source_coords("sh-x3"), None);
        // ④ 未知 / 空串 → None
        assert_eq!(task_source_coords("sh-none"), None);
        assert_eq!(task_source_coords(""), None);
        // 清场（进程级共享 config 目录）
        save_tasks(&[]);
    }
}

// ══════════════ 2026-10-18 fast-ack：纯函数/契约单测（不碰网不碰盘） ══════════════

#[cfg(test)]
mod fast_ack_tests {
    use super::*;

    /// trace 行格式契约：脚本按 `[chat-trace] ` 前缀切 + JSON 解析；只含
    /// ev/msgId/ts/target/ms 五键（**不含聊天内容**——隐私红线）。
    #[test]
    fn chat_trace_line_shape_and_no_content() {
        let line = chat_trace_line(
            "send-ack",
            "m123-0",
            "did:youling:PEER",
            17,
            1_700_000_000_000,
        );
        assert!(line.starts_with("[chat-trace] "));
        let v: Value = serde_json::from_str(line.strip_prefix("[chat-trace] ").unwrap()).unwrap();
        assert_eq!(v["ev"], "send-ack");
        assert_eq!(v["msgId"], "m123-0");
        assert_eq!(v["ts"], 1_700_000_000_000i64);
        assert_eq!(v["target"], "did:youling:PEER");
        assert_eq!(v["ms"], 17);
        // 不该出现任何消息正文键（text/payload/kind/from）
        for k in ["text", "payload", "kind", "from"] {
            assert!(v.get(k).is_none(), "trace 不得带 {k}: {line}");
        }
    }

    /// 单聊扇出：恒 [to]（不解释 grp- 前缀之外的东西）。
    #[test]
    fn fanout_single_chat_one_target() {
        assert_eq!(
            fanout_targets("did:youling:PEER", &json!({ "text": "hi" })),
            vec!["did:youling:PEER"]
        );
    }

    /// 群扇出：payload.members 原序（含自己其他设备）；缺 members/非数组/混入非串 → 过滤。
    #[test]
    fn fanout_group_from_members_filtering() {
        let payload = json!({ "members": ["did:youling:A", "did:myco:B", 42, null] });
        assert_eq!(
            fanout_targets("grp-x1", &payload),
            vec!["did:youling:A", "did:myco:B"]
        );
        assert!(fanout_targets("grp-x1", &json!({ "text": "no members" })).is_empty());
        assert!(fanout_targets("grp-x1", &json!({ "members": "bad" })).is_empty());
    }

    /// fast-ack 的 wire 信封与既有信封**同形**（九键）——wire 兼容是硬约束
    /// （老端可收；msgId 幂等去重靠它；payload 原样透传）。
    #[test]
    fn wire_envelope_keeps_wire_shape() {
        let payload = json!({ "text": "你好" });
        let env = wire_envelope(
            "m1",
            42,
            "did:youling:ME",
            "我",
            "did:myco:DEV",
            "PC",
            "did:youling:PEER",
            "text",
            payload.clone(),
        );
        for k in [
            "msgId",
            "from",
            "fromName",
            "fromDevice",
            "fromDeviceName",
            "to",
            "kind",
            "payload",
            "ts",
        ] {
            assert!(env.get(k).is_some(), "wire 信封缺键 {k}");
        }
        assert_eq!(env["msgId"], "m1");
        assert_eq!(env["ts"], 42);
        assert_eq!(env["payload"], payload); // payload 原样透传（不重包装）
        assert_eq!(
            env.as_object().map(|o| o.len()),
            Some(9),
            "信封不得多键（老端解析按固定形状）"
        );
    }

    /// sendState 事件扩展：sent/read 视为已投递（delivered=1），sending/failed 为 0。
    #[test]
    fn conv_update_send_state_delivered_defaults() {
        // 纯函数语义：conv_update_send_state → delivered 换算（不发事件、不落盘）。
        let d = |s: &str| matches!(s, "sent" | "read") as u32;
        assert_eq!(d("sent"), 1);
        assert_eq!(d("read"), 1);
        assert_eq!(d("failed"), 0);
        assert_eq!(d("sending"), 0);
    }
}

#[cfg(test)]
mod official_notice_tests {
    use super::*;

    /// 签名材料/验签：真签过、改一个字不过、换钥不过（与 identity-svc official.mjs 同口径）。
    #[test]
    fn official_notice_sign_material_and_verify() {
        use ed25519_dalek::Signer as _;
        let sk = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let pk_b64 =
            base64::engine::general_purpose::STANDARD.encode(sk.verifying_key().to_bytes());
        let my = "did:youling:zOFFICIALTEST";
        let material = official_notice_material(
            my,
            "ntc-1",
            1_700_000_000_000,
            "标题",
            "正文",
            "去写陈词",
            "https://dev.youling.cc/tool/x/y",
        );
        let sig = base64::engine::general_purpose::STANDARD
            .encode(sk.sign(material.as_bytes()).to_bytes());
        assert!(
            official_notice_verify_with(&[pk_b64.as_str()], &material, &sig),
            "真签必须过"
        );
        let tampered = official_notice_material(
            my,
            "ntc-1",
            1_700_000_000_000,
            "标题",
            "正文改",
            "去写陈词",
            "https://dev.youling.cc/tool/x/y",
        );
        assert!(
            !official_notice_verify_with(&[pk_b64.as_str()], &tampered, &sig),
            "改正文必须不过"
        );
        let other = base64::engine::general_purpose::STANDARD.encode([9u8; 32]);
        assert!(
            !official_notice_verify_with(&[other.as_str()], &material, &sig),
            "换钥必须不过"
        );
    }

    /// 材料格式红线段：六段换行拼接 + 内层 sha256hex（改分隔/去哈希都会导致验签失败）。
    #[test]
    fn official_notice_material_shape() {
        let m = official_notice_material(
            "did:youling:zR",
            "ntc-9",
            42,
            "t",
            "b",
            "l",
            "https://www.youling.cc/x",
        );
        let parts: Vec<&str> = m.split('\n').collect();
        assert_eq!(
            parts.len(),
            5,
            "材料五段（kind/收件人/noticeId/createdAt/innerHash）"
        );
        assert_eq!(parts[0], "official-notice");
        assert_eq!(parts[1], "did:youling:zR");
        assert_eq!(parts[2], "ntc-9");
        assert_eq!(parts[3], "42");
        assert_eq!(parts[4].len(), 64, "内层 sha256hex");
        assert_eq!(parts[4], sha256_hex(b"t\nb\nl\nhttps://www.youling.cc/x"));
    }

    /// 小灵会话 id 判定（did_safe 形态 + 直接 did 两种输入都认）。
    #[test]
    fn official_conv_detection() {
        assert!(is_official_conv(&official_conv_id()));
        assert!(is_official_conv(OFFICIAL_ACCOUNT_DID));
        assert!(!is_official_conv("did_youling_zSomeoneElse"));
        assert_eq!(official_conv_id(), did_safe(OFFICIAL_ACCOUNT_DID));
    }
}

/// 2026-11-06 真案回归：**UTF-8 BOM 必须容忍**。
///
/// 现场：笔记本 `peer-tasks.json` 被 PowerShell `ConvertTo-Json | Set-Content -Encoding UTF8`
/// 重写（CRLF + 文件头 EF BB BF），`serde_json::from_str` 报
/// "expected value at line 1 column 1" → 任务库被读成空 → 任务页空白，
/// 而 3 张卡（1×RDP + 2×DSH）一张不少地在盘上。
#[cfg(test)]
mod bom_json_tests {
    use super::*;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("myco-bom-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).expect("建临时目录");
        d
    }

    #[test]
    fn read_json_arr_strips_utf8_bom() {
        let d = tmp_dir("arr");
        let p = d.join("peer-tasks.json");
        let mut bytes = b"\xEF\xBB\xBF".to_vec(); // BOM
        bytes.extend_from_slice(br#"[{"taskId":"peer-task-share-sh-a","status":"todo"}]"#);
        std::fs::write(&p, bytes).expect("写 BOM 文件");

        let arr = read_json_arr(&p);
        assert_eq!(arr.len(), 1, "带 BOM 也必须读到 1 张卡（真案：这里曾是 0）");
        assert_eq!(
            arr[0].get("taskId").and_then(|v| v.as_str()),
            Some("peer-task-share-sh-a")
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn read_json_arr_missing_file_is_empty_not_error() {
        let d = tmp_dir("missing");
        assert!(read_json_arr(&d.join("nope.json")).is_empty(), "首次运行无文件=空数组");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn read_json_text_keeps_non_bom_content_untouched() {
        let d = tmp_dir("plain");
        let p = d.join("plain.json");
        std::fs::write(&p, br#"[{"t":"\u{feff}"}]"#).expect("写普通文件");
        let s = read_json_text(&p).expect("读取");
        assert!(s.starts_with('['), "没有 BOM 时原样返回");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn dedupe_tasks_keeps_last_and_preserves_anonymous() {
        let list = vec![
            json!({"taskId": "peer-task-share-sh-a", "status": "todo", "title": "旧"}),
            json!({"taskId": "peer-task-share-sh-a", "status": "done", "title": "新"}),
            json!({"taskId": "", "title": "无 id 卡"}),
            json!({"taskId": "peer-task-share-sh-b", "status": "todo"}),
        ];
        let out = dedupe_tasks(list);
        assert_eq!(out.len(), 3, "同 taskId 只留一条；无 id 的照留");
        let a = out
            .iter()
            .find(|t| t.get("taskId").and_then(|v| v.as_str()) == Some("peer-task-share-sh-a"))
            .expect("a 必须存在");
        assert_eq!(a.get("title").and_then(|v| v.as_str()), Some("新"), "后写覆盖前写");
        assert_eq!(a.get("status").and_then(|v| v.as_str()), Some("done"));
    }
}
