//! msgId 生成器（修审计发现 2 的“msgId 不唯一风险”）。
//!
//! 旧实现是 `m{nanos:x}-{进程内自增}`（`chat_service.rs:82-89`）：没有设备因子、
//! 没有随机因子，进程重启后计数器归零，跨设备理论上可撞；而 `p2p_sync` 把
//! “msgId 全局唯一”当作零冲突前提（`p2p_sync.rs:9-13`）。
//!
//! 新格式：
//!
//! ```text
//! m<epoch_ms:hex>-<device_tail>-<rand:032x>
//!  │      │            │              └ 128bit 随机数（生产用 CSPRNG）
//!  │      │            └ 设备 did 尾段（清洗为 [A-Za-z0-9_]，≤20 字符）
//!  │      └ 生成时刻（epoch 毫秒，十六进制）
//!  └ 固定前缀，保持与旧 id 的“m 开头”习惯
//! ```
//!
//! 性质：
//! * **可排序**：同一毫秒内靠随机数区分；跨毫秒前缀单调，便于排障；
//! * **设备可归因**：出问题时能看出是哪个设备生成的；
//! * **文件名安全**：只含 `[A-Za-z0-9_-]`，可直接用于 `media/<msgId>.<ext>`；
//! * **重发稳定**：调用方重试必须复用同一 msgId（幂等键），生成器本身不参与重试。
//!
//! 注意：`rand_u128` 由调用方注入，测试用递增/固定值即可完全确定；
//! 生产必须来自 `getrandom`/`OsRng` 一类 CSPRNG，**不要用时间戳或自增**。

use std::time::{SystemTime, UNIX_EPOCH};

/// 设备尾段最大长度（控制 id 总长，同时保留可归因性）。
pub const MAX_DEVICE_TAIL_LEN: usize = 20;

/// 系统当前时间（epoch 毫秒）；负值/异常一律归 0，不让时间问题污染存储。
pub fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(delta) => i64::try_from(delta.as_millis()).unwrap_or(i64::MAX),
        Err(_) => 0,
    }
}

/// 把设备 did（或任意标识）清洗成文件名安全、长度受控的尾段。
///
/// 保留 `[A-Za-z0-9_]`，其余字符折叠为 `_`；空串返回 `dev`。
/// 例：`did:youling:zabc` → `did_youling_zabc`。
pub fn sanitize_device_tail(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(MAX_DEVICE_TAIL_LEN));
    for ch in raw.chars() {
        if out.len() >= MAX_DEVICE_TAIL_LEN {
            break;
        }
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push_str("dev");
    }
    out
}

/// 生成全局唯一 msgId（设备 + 时间 + 128bit 随机）。
///
/// `rand_u128` 由调用方注入：生产用 CSPRNG，测试用可控值。
pub fn new_msg_id(device_did_tail: &str, now_ms: i64, rand_u128: u128) -> String {
    let tail = sanitize_device_tail(device_did_tail);
    // now_ms 用非负十六进制；rand 固定 32 位十六进制（左补零），保证同毫秒内可读
    let millis = now_ms.max(0) as u64;
    format!("m{millis:x}-{tail}-{rand_u128:032x}")
}

/// 便捷版：随机数从系统熵源派生（时间纳秒 + 进程内计数器 + 局部地址）。
///
/// 这是 std-only 下的“够用”实现，**不是 CSPRNG**：用于测试/原型/日志打点可以，
/// 生产接入时必须换成 `getrandom`（README §7 已记录）。同毫秒内靠自增计数器区分。
pub fn new_msg_id_now(device_did_tail: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let now = now_ms();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u128)
        .unwrap_or(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed) as u128;
    let pid = std::process::id() as u128;
    let stack = &counter as *const u128 as u128;

    // 混合成 128bit：高位放时间纳秒，低位混入进程/计数器/栈地址
    let rand = ((nanos & 0xffff_ffff) << 96) ^ (pid << 64) ^ ((counter & 0xffff_ffff) << 32) ^ (stack & 0xffff_ffff);
    new_msg_id(device_did_tail, now, rand)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn generated_ids_are_filename_safe_and_attributable() {
        let id = new_msg_id("did:youling:zac", 1_790_000_000_000, 7);
        let (head, rest) = id.split_once('-').expect("id must be dash separated");
        assert_eq!(head, format!("m{:x}", 1_790_000_000_000u64));
        assert!(rest.starts_with("did_youling_zac-"), "device tail lost: {id}");
        assert!(
            id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'),
            "unsafe char in {id}"
        );
        assert!(id.len() <= 96, "id too long: {} ({id})", id.len());
    }

    #[test]
    fn empty_or_hostile_device_tail_is_normalised() {
        assert_eq!(sanitize_device_tail(""), "dev");
        assert_eq!(sanitize_device_tail("../../etc/passwd"), "______etc_passwd");
        assert_eq!(sanitize_device_tail("a b\tc"), "a_b_c");
        let long = "x".repeat(100);
        assert_eq!(sanitize_device_tail(&long).len(), MAX_DEVICE_TAIL_LEN);
    }

    #[test]
    fn id_generator_has_no_collisions_in_10k_with_incrementing_random() {
        let mut seen = HashSet::new();
        for i in 0..10_000u128 {
            let id = new_msg_id("did:youling:zdevpc", 1_790_000_000_000, i);
            assert!(seen.insert(id.clone()), "collision at i={i}: {id}");
        }
        assert_eq!(seen.len(), 10_000);
    }

    #[test]
    fn same_random_different_device_or_time_never_collides() {
        let a = new_msg_id("dev-a", 1_000, 42);
        let b = new_msg_id("dev-b", 1_000, 42);
        let c = new_msg_id("dev-a", 1_001, 42);
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_ne!(b, c);
    }

    #[test]
    fn clock_derived_generator_is_unique_within_one_millisecond_burst() {
        let mut seen = HashSet::new();
        for _ in 0..2_000 {
            assert!(seen.insert(new_msg_id_now("did:youling:zphone")));
        }
        assert_eq!(seen.len(), 2_000);
    }
}
