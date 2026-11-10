//! presence.rs — 第64轮：登录器在线登记；第84轮 P2P 在线状态增强。
//!
//! 第64轮背景：第63轮 env 合并只搬了身份命令，env 的 presence 心跳随 run()
//! 一起没了 → 服务器名册 online 位永远灭灯。这里按「presence=身份域数据」重建。
//!
//! 第84轮（去中心化聊天）：
//!   - payload 增加 addrs（本机全部全球 IPv6，P2P 直连寻址）+ p2pPort（实际
//!     监听端口，与 myco-env 直连端口冲突时自动顺延）+ kind=pc + state。
//!   - state ∈ active|typing|idle|locked（灯的三态数据源）：
//!       locked: Win32 OpenInputDesktop 失败（锁屏/安全桌面）
//!       idle:   GetLastInputInfo 距上次键鼠输入 > 300s（2026-09-29：60s→300s，
//!               设计定稿"5min 无输入推导 idle"——60s 时倒杯水就橘黄，太吵）
//!       typing: chat_typing 命令设置的 TTL 内（4s）
//!       active: 其他
//!   - 心跳 60s → 20s（灯的时效性；服务器 PRESENCE_TTL=90s 内安全）。
//!   - 注册幂等；identity/register 一次（201/409 皆可）供服务器验签。
//!
//! 2026-09-29 灯恢复（用户报"打字呼吸灯/锁屏橘黄灯 UI 上看不到"）：
//!   - kick()：chat_typing/发送/状态翻转时即时重报——原 20s 心跳撞 4s typing
//!     TTL，presence 通道的 typing 态命中率仅 ~20%，呼吸灯近乎不可见。
//!   - 状态变化即报：循环记住上次上报的 state，翻转（锁屏/解锁/进 idle）立即
//!     重报，不等下一个 20s 周期。
//!
//! 2026-10-09 灭灯修复（计划任务启动 presence 失效，实为「无人交互的机器」全程失效）：
//!   原 select(周期 sleep(20s) | kick | 2s 状态轮询) 里 2s 轮询分支永远先完成，
//!   select! 每轮把没到期的 20s sleep 丢掉重建 → 周期拍实际从未到过——机器只剩
//!   启动首报一跳，90s TTL 后出表灭灯（实测 lastSeen=进程启动时刻，12 分钟不动）。
//!   交互中的机器靠状态翻转/kick 不断触发上报，掩盖了饥饿——「双击正常、计划任务
//!   灭灯」是伪相关（计划任务启动后恰好无人碰机器）。修法：周期改常驻 Interval
//!   （时刻表活在对象里，不随 select 分支 future 被丢），见 [`wait_heartbeat`]。

use base64::Engine as _;
use ed25519_dalek::Signer as _;
use myco_core::identity as core_id;

/// 已注册公钥的进程内缓存——**按 did 键控**（2026-10-09 多归属 L1 修）：
/// 原进程级单布尔在设备钥轮换（device_logout 删 device.key → 惰性生成新钥）后
/// 永不复位 → presence 对新公钥永不 /identity/register，服务端不认识新钥，
/// 后续 signed_post 全 401/403 —— presence 静默死亡（只 eprintln）。键控后
/// 新 did 自然不在集合里，首次 signed_post 重新注册。core identity.rs 有一份
/// 同款缓存，同样键控——两份各自跟随 did，无需互相通知复位。
static REGISTERED: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

/// 首次心跳成功的进程内标记（上线日志只打一次，后续 20s 心跳不刷屏）。
static ONLINE_LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn registered(did: &str) -> bool {
    REGISTERED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(did)
}

fn mark_registered(did: &str) {
    REGISTERED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(did.to_string());
}

/// 即时重报信号（2026-09-29 灯恢复）：typing/发送/状态翻转时唤醒心跳循环立即
/// refresh，不等 20s 周期。tokio::sync::Notify 无缓冲——循环外的多次 kick 合并
/// 为一次唤醒（连续打字每次 chat_typing 都 kick 也只补一发，靠 20s 周期兜底
/// 持续态；typing 期 TTL 一直被续，下一发心跳仍报 typing）。
static KICK: std::sync::LazyLock<tokio::sync::Notify> =
    std::sync::LazyLock::new(tokio::sync::Notify::new);

/// 请求立即重报一次 presence（best-effort；循环未起时丢失无副作用）。
pub fn kick() {
    KICK.notify_one();
}

/// 无输入判 idle 的阈值（设计定稿 5min；手机端 p2p.ts 同值，两端一致）。
pub const IDLE_THRESHOLD_MS: u32 = 300_000;

fn base_url() -> String {
    std::env::var("MYCO_DID_BASE").unwrap_or_else(|_| "https://myco.youling.cc/myco-id".into())
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

/// 设备钥就绪前等待（IdentityStore 落盘是惰性的，冷启动可能要一小会儿）。
fn device_signing() -> Option<(ed25519_dalek::SigningKey, String)> {
    let (did, seed_b64) = core_id::device_identity().ok()?;
    let seed_b = base64::engine::general_purpose::STANDARD
        .decode(seed_b64)
        .ok()?;
    let arr: [u8; 32] = seed_b.try_into().ok()?;
    Some((ed25519_dalek::SigningKey::from_bytes(&arr), did))
}

/// 活动账号在本机凭据下的真实角色（#6）：embodiment=持种子（主设备）/
/// agent=无种子但持绑定本设备钥的有效委任状（成员）/ lost=凭据已失。
/// 复用 core accounts_load_with_roles 的判定（identity.rs:275-300），按
/// account_did_eq 匹配活动账号；清单缺条目时兜底直判种子槽（切换路径总会
/// upsert 入列，兜底仅防御手动清档）。
fn active_account_role(active_did: &str) -> String {
    if let Some(role) = core_id::accounts_load_with_roles()
        .iter()
        .find(|a| {
            a.get("did")
                .and_then(|d| d.as_str())
                .map(|s| core_id::account_did_eq(s, active_did))
                .unwrap_or(false)
        })
        .and_then(|a| a.get("role").and_then(|r| r.as_str()))
    {
        return role.to_string();
    }
    let has_seed = core_id::account_seed_slot_exists(active_did);
    if has_seed { "embodiment".into() } else { "agent".into() }
}

// ══════ Windows 空闲/锁屏检测（手写 FFI——不加 windows crate 依赖） ══════

/// 距上次键鼠输入的毫秒数（GetLastInputInfo）；非 Windows/失败 = 0（永不算 idle）。
#[cfg(windows)]
fn idle_ms() -> u32 {
    #[repr(C)]
    struct LASTINPUTINFO {
        cbSize: u32,
        dwTime: u32,
    }
    extern "system" {
        fn GetLastInputInfo(plii: *mut LASTINPUTINFO) -> i32;
        fn GetTickCount() -> u32;
    }
    unsafe {
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut info) == 0 {
            return 0;
        }
        GetTickCount().wrapping_sub(info.dwTime)
    }
}
#[cfg(not(windows))]
fn idle_ms() -> u32 {
    0
}

/// 是否锁屏（OpenInputDesktop 失败=输入桌面不可及=锁屏/UAC 安全桌面）。
#[cfg(windows)]
fn is_locked() -> bool {
    extern "system" {
        fn OpenInputDesktop(dwFlags: u32, fInherit: bool, dwDesiredAccess: u32) -> *mut core::ffi::c_void;
        fn CloseDesktop(hDesktop: *mut core::ffi::c_void) -> i32;
    }
    const DESKTOP_READOBJECTS: u32 = 0x0001;
    unsafe {
        let h = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
        if h.is_null() {
            return true;
        }
        CloseDesktop(h);
        false
    }
}
#[cfg(not(windows))]
fn is_locked() -> bool {
    false
}

/// 状态决策纯函数（单测可测）：locked > typing(TTL) > idle(阈值) > active。
fn decide_state(locked: bool, typing_until: i64, idle: u32, now: i64) -> &'static str {
    if locked {
        "locked"
    } else if typing_until > now {
        "typing"
    } else if idle > IDLE_THRESHOLD_MS {
        "idle"
    } else {
        "active"
    }
}

/// 本机设备状态（灯数据源）：locked > typing(TTL) > idle(300s) > active。
pub fn device_state() -> &'static str {
    let typing_until = crate::chat_service::TYPING_UNTIL.load(std::sync::atomic::Ordering::Relaxed);
    decide_state(is_locked(), typing_until, idle_ms(), now_ms() as i64)
}

/// 单次在线登记。幂等，可反复调用；任何失败只记日志（在线态 best-effort）。
/// pub：E2E 测试直接调一次（不等心跳周期）。
pub async fn refresh() {
    let Some((signing, did)) = device_signing() else {
        // 2026-10-09：不再静默——设备钥读不出（device.key 缺失/DPAPI 解密失败等）
        // 曾让灭灯排障完全无线索；每拍留一行（20s 一行，不刷屏）。
        eprintln!("[presence] 设备身份不可用，本拍心跳跳过（device_signing=None）");
        return;
    };
    let name = std::env::var("COMPUTERNAME")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "myco-pc".into());
    let mut payload = serde_json::json!({
        "nodeId": did, "name": name,
        "kind": "pc",
        "state": device_state(), // 第84轮：active|typing|idle|locked（灯）
    });
    if let Some(root) = core_id::account_did() {
        payload["rootDid"] = serde_json::json!(root);
        // 2026-10-09 多归属修(#6)：role 如实报——成员账号（无种子、持委任状）是
        // agent，不再硬编码 embodiment（member 手机在每个账号都自称主设备）。
        // 角色计算复用 core accounts_load_with_roles 对**活动账号**的判定
        // （identity.rs:275-300：种子槽=embodiment / 委任状=agent / 都没=lost）。
        payload["role"] = serde_json::json!(active_account_role(&root));
    }
    // 第84轮：P2P 直连寻址——全部全球 IPv6（前缀轮换期多地址全报，对端实测选路）
    // + 实际监听端口（p2p_server 与 env direct_server 冲突时自动顺延）。
    let ipv6 = crate::p2p_server::detect_ipv6_all();
    let port = crate::p2p_server::p2p_port();
    if !ipv6.is_empty() && port > 0 {
        payload["addrs"] = serde_json::json!({
            "ipv6": ipv6[0],
            "ipv6List": ipv6,
            "port": port,
        });
    }
    if let Err(e) = signed_post(&signing, &did, "/presence/register", &payload).await {
        eprintln!("[presence] 登记失败: {e}");
    } else if !ONLINE_LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        // 首跳成功打一次上线日志——灭灯排障时确认链路活着（此前成功路径零输出）。
        eprintln!(
            "[presence] 心跳上线 did={did} name={name} state={}",
            payload["state"].as_str().unwrap_or("?")
        );
    }
}

/// sign-every-request：X-Myco-Auth = did.ts.sig，签 `did\nts\nrawBody`。
/// 首次调用前先 identity/register 公钥（服务器按 did 查公钥验签）。
async fn signed_post(
    signing: &ed25519_dalek::SigningKey,
    did: &str,
    path: &str,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let pubkey: [u8; 32] = signing.verifying_key().to_bytes();
    if !registered(did) {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;
        let r = http
            .post(format!("{}/identity/register", base_url()))
            .json(&serde_json::json!({ "publicKeyB64": b64e(&pubkey) }))
            .send()
            .await
            .map_err(|e| format!("register 请求失败: {e}"))?;
        let s = r.status().as_u16();
        if s != 201 && s != 409 {
            let t = r.text().await.unwrap_or_default();
            return Err(format!("register 失败 status={s} body={}", &t.chars().take(160).collect::<String>()));
        }
        mark_registered(did);
    }
    let raw = serde_json::to_string(payload).unwrap_or_default();
    let ts = now_ms();
    let msg = format!("{did}\n{ts}\n{raw}");
    let sig = signing.sign(msg.as_bytes());
    let auth = format!("{did}.{ts}.{}", b64e(&sig.to_bytes()));
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let r = http
        .post(format!("{}/{}", base_url(), path.trim_start_matches('/')))
        .header("X-Myco-Auth", auth)
        .header("content-type", "application/json")
        .body(raw)
        .send()
        .await
        .map_err(|e| format!("{path} 失败: {e}"))?;
    let status = r.status();
    let text = r.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("{path} status={status} body={}", &text.chars().take(200).collect::<String>()));
    }
    serde_json::from_str(&text)
        .map_err(|e| format!("{path} 响应非 JSON: {e}"))
}

/// 启动 presence 后台：等设备身份/端口就绪 → 首次注册 → 20s 周期重报（第84轮：
/// 60s→20s，灯的时效性；PRESENCE_TTL=90s 内安全。服务器名册分钟级可见状态变化）。
/// 2026-09-29：周期 sleep 改 select（周期 | kick 唤醒 | 状态翻转）——typing 4s TTL
/// 与锁屏/解锁转换都能即时上服务器，呼吸灯/橘黄灯不再被 20s 心跳窗口吞掉。
/// 2026-10-09 灭灯修复：上述 select 的「周期」分支从未到过期——select! 完成即丢弃
/// 其余分支 future，2s 状态轮询每轮抢先完成 → sleep(20s) 每 2s 清零重来（模块头
/// 注释）。周期改常驻 Interval 后才真正存在 20s 节拍。
pub fn start() {
    crate::startup_trace::mark("presence-spawn");
    tauri::async_runtime::spawn(run_presence());
}

/// start() 的 spawn 体原样抽出（pub：计划任务冒烟诊断 bin 在无 GUI 单实例锁的
/// 进程里跑产线同款心跳节律，见 bin/presence_sched_diag.rs）。
pub async fn run_presence() {
    crate::startup_trace::mark("presence-enter");
    // 设备种子就绪（最多等 30s；未就绪说明 IdentityStore 异常，循环里会重试）
    for _ in 0..30 {
        if device_signing().is_some() { break }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    if device_signing().is_none() {
        eprintln!("[presence] 设备身份 30s 未就绪（device.key 读取/解密异常？），心跳循环继续重试");
    }
    // 2026-10-07 好友去服务端化：登录后拉一次信箱（离线期间积压的好友握手
    // request/accept/remove 在这里首次落地；等有灵账号就绪最多 60s，best-effort，
    // 后续靠 chat_poll 轮询——原"服务器好友表首同步"随 friends 模块删除退役）
    tauri::async_runtime::spawn(async move {
        for _ in 0..60 {
            if core_id::account_did().is_some() { break }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        if let Some(my) = core_id::account_did() {
            if let Err(e) = crate::chat_service::poll_mailbox(&my).await {
                eprintln!("[presence] 信箱首拉失败（后续轮询兜底）: {e}");
            }
        }
    });
    heartbeat_loop().await;
}

/// 心跳主循环：启动首报（循环外，同旧实现）→ 常驻 Interval 的 20s 周期拍 + kick
/// （typing/发送）+ 状态翻转（2s 采样）即时插报。pub：冒烟诊断 bin 复用。
pub async fn heartbeat_loop() {
    refresh().await; // 启动首报
    crate::startup_trace::mark("presence-first-report");
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(20));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await; // interval 首拍立即到：首报已做，吃掉这拍
    let mut last_state = device_state();
    loop {
        if !wait_heartbeat(&mut ticker, || device_state(), &mut last_state).await {
            continue; // 2s 采样无变化：等下一个事件；20s 周期拍在 ticker 里照走
        }
        refresh().await;
        last_state = device_state();
    }
}

/// 心跳等待一步（单测锁死修复语义，见 tests::heartbeat_period_not_starved_by_state_poll）：
/// 20s 周期拍（常驻 Interval——schedule 活在对象里，不随 select 分支 future 被丢，
/// 2026-10-09 灭灯根因所在）| kick 即时 | 状态翻转（2s 采样节拍）。返回 true=该 refresh。
/// sample 注入采样函数：产线=device_state()；测试=固定串（真实 device_state 依赖
/// 键鼠输入/锁屏状态，测试里不可控）。
async fn wait_heartbeat<F: FnMut() -> &'static str>(
    ticker: &mut tokio::time::Interval,
    mut sample: F,
    last_state: &mut &'static str,
) -> bool {
    tokio::select! {
        _ = ticker.tick() => true,
        _ = KICK.notified() => true,
        _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {
            sample() != *last_state // 状态翻转：不等 20s 周期，立即上报
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 三态映射：active 绿 / typing 呼吸 / idle·locked 橘黄 —— decide_state 全分支。
    #[test]
    fn state_map_three_states() {
        let now = 1_000_000i64;
        assert_eq!(decide_state(false, 0, 0, now), "active");
        assert_eq!(decide_state(false, now + 4_000, 0, now), "typing"); // TTL 内
        assert_eq!(decide_state(false, 0, IDLE_THRESHOLD_MS + 1, now), "idle"); // >5min 无输入
        assert_eq!(decide_state(false, 0, IDLE_THRESHOLD_MS, now), "active"); // 恰好 5min 还不算
        assert_eq!(decide_state(true, now + 4_000, IDLE_THRESHOLD_MS + 1, now), "locked"); // 锁屏最高优先
    }

    /// typing 优先级高于 idle：打字中哪怕挂着很久也算 typing（灯跟着最具体的信号走）。
    #[test]
    fn typing_beats_idle() {
        let now = 1_000_000i64;
        assert_eq!(decide_state(false, now + 1, IDLE_THRESHOLD_MS + 999, now), "typing");
    }

    /// 超时回退：typing TTL 过期瞬间回 active（"3 秒无输入回退"的服务器侧语义——
    /// UI 节流 3s 续 TTL，停顿 ≤4s 后 decide_state 不再见 typing）。
    #[test]
    fn typing_expiry_falls_back_to_active() {
        let now = 1_000_000i64;
        let until = now + 4_000;
        assert_eq!(decide_state(false, until, 0, now), "typing");
        assert_eq!(decide_state(false, until, 0, until), "active"); // 到期（非严格大于）
        assert_eq!(decide_state(false, until, 0, until + 1), "active");
    }

    // ── 2026-10-09 灭灯修复回归锁（虚拟时钟；test-util 见 Cargo.toml dev-deps）──

    /// 20s 周期拍不许被 2s 状态轮询饿死——旧实现（select 里每轮重建 sleep(20s)）
    /// 在「状态恒不变」场景 0 拍：select! 完成即丢弃其余分支 future，2s 分支永远
    /// 先到 → 20s 计时每 2s 清零重来。线上症状=启动首报后 lastSeen 永不推进、
    /// 90s TTL 出表灭灯（计划任务启动后无人交互正是这种场景）。虚拟时间推 41s，
    /// 状态恒 active：必须恰好 2 拍（t=20/40）。
    #[tokio::test(start_paused = true)]
    async fn heartbeat_period_not_starved_by_state_poll() {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(20));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await; // 吃掉立即到的首拍（=启动首报，循环外）
        let mut last = "active";
        let mut beats = 0u32;
        let start = tokio::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_secs(41) {
            if wait_heartbeat(&mut ticker, || "active", &mut last).await {
                beats += 1;
            }
        }
        assert_eq!(beats, 2, "41s 内 20s 周期拍必须恰好 2 次（t=20/40）");
    }

    /// 状态翻转即时性保留：2s 采样发现变化立即上报，不等 20s 周期拍
    /// （锁屏/解锁/进 idle 的灯时效性——2026-09-29 行为不能被修复回退）。
    #[tokio::test(start_paused = true)]
    async fn state_flip_reports_immediately_not_waiting_period() {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(20));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await;
        let mut last = "active";
        let start = tokio::time::Instant::now();
        // 采样恒报翻转态（idle）：应在 2s 采样拍返回 true，且虚拟耗时 <20s
        let fired = wait_heartbeat(&mut ticker, || "idle", &mut last).await;
        assert!(fired, "状态翻转必须立即触发上报");
        assert!(
            start.elapsed() < std::time::Duration::from_secs(20),
            "翻转上报不该等 20s 周期（实际虚拟耗时 {:?}）",
            start.elapsed()
        );
    }

    /// 状态无变化时 2s 采样拍安静返回 false（不触发上报）——轮询节拍本身不该变成
    /// 心跳（否则 2s 一发把服务器打爆）。
    #[tokio::test(start_paused = true)]
    async fn unchanged_state_poll_stays_quiet() {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(20));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await;
        let mut last = "active";
        let start = tokio::time::Instant::now();
        let fired = wait_heartbeat(&mut ticker, || "active", &mut last).await;
        assert!(!fired, "状态无变化不该上报");
        assert_eq!(start.elapsed(), std::time::Duration::from_secs(2), "2s 采样节拍");
    }
}
