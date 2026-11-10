//! p2p_sync.rs — 第84轮：去中心化聊天对账算法（"指纹-索引"两段式）。
//!
//! 消息只活在参与者的设备上——谁都不上线时一个人看不到历史，有人上线就
//! 快速对账共享（"活的历史"）。本模块是算法核心，纯逻辑 + 本地存储：
//!
//! ## 会话摘要（每会话维护，存 {convId}.meta.json）
//! ```text
//! 会话摘要 = { convId, n(条数), lastTs, F }
//! F = XOR( SHA256(msgId) for all msgs in conv )   // 无序集合指纹
//! ```
//! F 的关键性质：无序（任意合并顺序同结果）、增量 O(1)（加一条 F ^= hash(msgId)）、
//! 零冲突（msgId 全局唯一）。手机端 TS 版（apps/phone/src/p2p.ts digestOf）与
//! 本实现字节级一致——双端互验。
//!
//! ## 对账流程（设备 A 遇到设备 B）
//! ① A → B: POST /p2p/sync/digest   {myDid, convDigests}（KB 级）
//! ② B 回自己的 convDigests；双方各自对比：F 不同 → 该会话需精确对账
//! ③ A → B: POST /p2p/sync/index {convId} → B 回 msgIds 索引
//! ④ A 对比索引：差集 → POST /p2p/sync/batch {convId, msgs(我推你缺的), want(我想拉的)}
//!    B 收 push 幂等落盘 + 回 want 的 msgs —— 一回合双向收敛
//!
//! 存储：chat/{convId}.meta.json = {n, lastTs, F, ids:[[msgId,ts],...]}
//! ids 并入 meta（对账 ③ 直接读 meta，不必重扫 jsonl；也做幂等判重的快速集合）。
//! 老会话（第81-83轮无 meta）首次读时从 jsonl 全量重建。

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::PathBuf;

// ══════════════ 指纹算法（纯函数，单测覆盖） ══════════════

/// 单条消息的指纹分量 = SHA256(msgId UTF-8 字节)（32B）。
pub fn hash_msg_id(msg_id: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(msg_id.as_bytes());
    let out = h.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&out);
    arr
}

/// XOR 合并两个指纹（无序集合的并/差/对称差全靠它）。
pub fn xor_f(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = a[i] ^ b[i];
    }
    out
}

/// 全量指纹：XOR( SHA256(id) for id in ids )。空集 = 全零。
pub fn fingerprint_of<'a, I: IntoIterator<Item = &'a str>>(ids: I) -> [u8; 32] {
    let mut f = [0u8; 32];
    for id in ids {
        f = xor_f(&f, &hash_msg_id(id));
    }
    f
}

pub fn f_to_hex(f: &[u8; 32]) -> String {
    f.iter().map(|b| format!("{:02x}", b)).collect()
}
pub fn f_from_hex(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

// ══════════════ 第96轮（修复4）：meta 写路径 conv 级锁 + 原子写 ══════════════

/// 每会话一把写锁（lazy 静态 map）——meta_append 是无锁读-改-写整文件，并发
/// （对账灌入 + 直推落盘 + 本地发送同会话同时发生）会整份覆盖丢索引项。
static CONV_LOCKS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<()>>>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

fn conv_lock(conv_id: &str) -> std::sync::Arc<std::sync::Mutex<()>> {
    let mut m = CONV_LOCKS.lock().unwrap();
    // 归一键为锁键：同一对端的两种形态串必须串行化同一份 meta/jsonl
    m.entry(crate::chat_service::conv_key(conv_id)).or_insert_with(|| std::sync::Arc::new(std::sync::Mutex::new(()))).clone()
}

// ══════════════ 第96轮（修复2）：对账批次字节预算 ══════════════

/// 单批累计字节安全线（~12MB）：p2p_server body limit 16MB——媒体 b64 内联时
/// 5×2MB 图就超限 → 413 → 对账永久卡死（条数闸 50 根本拦不住字节）。
pub const SYNC_BATCH_BYTE_BUDGET: usize = 12 * 1024 * 1024;

/// 批次双闸切分（纯函数，单测）：条数 ≤ max_count 且累计字节 ≤ max_bytes。
/// 字节按 wire 序列化长度（serde_json::to_string）计。单条超预算独占一批
/// （消息不可再拆；14MB 文件 b64 上限 + 信封仍 < 16MB 服务端收得下）。
pub fn chunk_wire_msgs(msgs: Vec<Value>, max_count: usize, max_bytes: usize) -> Vec<Vec<Value>> {
    let mut out: Vec<Vec<Value>> = vec![];
    let mut cur: Vec<Value> = vec![];
    let mut cur_bytes = 0usize;
    for m in msgs {
        let sz = serde_json::to_string(&m).map(|s| s.len()).unwrap_or(0);
        if !cur.is_empty() && (cur.len() >= max_count || cur_bytes + sz > max_bytes) {
            out.push(std::mem::take(&mut cur));
            cur_bytes = 0;
        }
        cur_bytes += sz;
        cur.push(m);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

// ══════════════ 会话元数据（存储） ══════════════

/// 2026-10-07：meta 键与 jsonl 同源——都过 chat_service 的会话归一键
/// （账号 did 四形态 → 单一 canonical）。此前 meta 按裸串命名：同一对端两份
/// jsonl 就配两份 meta，各算各的 F，"收到的消息"不进 UI 那份会话的指纹。
/// （chat 目录本体走 chat_service::chat_dir 的账号分桶口，切账号自动跟随。）
fn meta_path(conv_id: &str) -> PathBuf {
    crate::chat_service::conv_meta_path(conv_id)
}

/// 会话元数据：{n, lastTs, F(hex), ids, aliasSrc}。ids 与 jsonl 一一对应（msgId 唯一）。
/// aliasSrc（2026-10-07）= 已并入本 meta 的**存量等价文件**（非归一键本体）的
/// (文件名, 字节数) 表——归并读取上线后，同一对端的历史形态文件里的消息要并进
/// 同一份索引（否则指纹与实际内容不符）；用账本记住已并入到哪一版，后续 load 只
/// 比一次 stat，不再重扫。
#[derive(Clone, Debug, Default)]
pub struct ConvMeta {
    pub n: u64,
    pub last_ts: i64,
    pub f_hex: String,
    pub ids: Vec<(String, i64)>, // (msgId, ts)，追加序
    pub alias_src: Vec<(String, u64)>,
}

impl ConvMeta {
    pub fn digest_json(&self) -> Value {
        json!({ "n": self.n, "lastTs": self.last_ts, "F": self.f_hex })
    }

    /// 快速判重集合。
    pub fn id_set(&self) -> HashSet<&str> {
        self.ids.iter().map(|(id, _)| id.as_str()).collect()
    }
}

fn load_meta_raw(conv_id: &str) -> ConvMeta {
    std::fs::read_to_string(meta_path(conv_id))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .map(|v| ConvMeta {
            n: v.get("n").and_then(|x| x.as_u64()).unwrap_or(0),
            last_ts: v.get("lastTs").and_then(|x| x.as_i64()).unwrap_or(0),
            f_hex: v.get("F").and_then(|x| x.as_str()).unwrap_or(&"0".repeat(64)).to_string(),
            ids: v
                .get("ids")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|e| {
                            let arr = e.as_array()?;
                            Some((arr.first()?.as_str()?.to_string(), arr.get(1)?.as_i64().unwrap_or(0)))
                        })
                        .collect()
                })
                .unwrap_or_default(),
            alias_src: v
                .get("aliasSrc")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|e| {
                            let arr = e.as_array()?;
                            Some((arr.first()?.as_str()?.to_string(), arr.get(1)?.as_u64().unwrap_or(0)))
                        })
                        .collect()
                })
                .unwrap_or_default(),
        })
        .unwrap_or_default()
}

/// 该会话"归一键本体之外"的等价文件指纹表（文件名 + 字节数，排序）——meta 用它
/// 判断存量双形态文件里有没有新内容要并进索引。文件大小是增量追加的单调信号，
/// 足够触发一次重扫（重扫按 msgId 幂等，多扫无害）。
fn alias_sources(conv_id: &str) -> Vec<(String, u64)> {
    let primary = crate::chat_service::conv_path(conv_id);
    let mut out: Vec<(String, u64)> = Vec::new();
    for p in crate::chat_service::conv_paths_all(conv_id) {
        if p == primary {
            continue;
        }
        let Ok(md) = std::fs::metadata(&p) else { continue };
        out.push((p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string(), md.len()));
    }
    out.sort();
    out
}

/// 读会话 meta；老会话（ids 为空但 jsonl 有内容）从**归并后的** jsonl 全量重建并
/// 回写；已有 meta 但存量等价文件有新内容 → 增量并入（F ^= hash(msgId)，O(新增)）。
/// 这是第81-83轮存量会话与 2026-10-07 归并读取的无迁移兼容：首次读触发补齐，
/// 之后靠 aliasSrc 账本跳过重扫。
/// 第96轮（修复4）：与 meta_append 共用 conv 级锁——读路径也串行化（重建回写
/// 与并发 append 不再交错丢项）。
pub fn load_meta(conv_id: &str) -> ConvMeta {
    let lock = conv_lock(conv_id);
    let _g = lock.lock().unwrap();
    load_meta_unlocked(conv_id)
}

fn load_meta_unlocked(conv_id: &str) -> ConvMeta {
    let mut m = load_meta_raw(conv_id);
    if m.ids.is_empty() && m.n == 0 {
        // 重建：扫归并后的 jsonl（含存量等价文件）
        let ids = conv_ids_from_jsonl(conv_id);
        if ids.is_empty() {
            return m;
        }
        let mut meta = meta_from_ids(&ids);
        meta.alias_src = alias_sources(conv_id);
        save_meta(conv_id, &meta);
        return meta;
    }
    // 已有索引：把存量等价文件里 meta 尚未收录的 msgId 并进来（幂等，写回一次账本）
    let cur_src = alias_sources(conv_id);
    if cur_src != m.alias_src {
        let mut known: HashSet<String> = m.ids.iter().map(|(id, _)| id.clone()).collect();
        for (id, ts) in conv_ids_from_jsonl(conv_id) {
            if !known.insert(id.clone()) {
                continue;
            }
            let f = f_from_hex(&m.f_hex).unwrap_or([0u8; 32]);
            m.f_hex = f_to_hex(&xor_f(&f, &hash_msg_id(&id)));
            m.n += 1;
            if ts > m.last_ts {
                m.last_ts = ts;
            }
            m.ids.push((id, ts));
        }
        m.alias_src = cur_src;
        save_meta(conv_id, &m);
    }
    m
}

/// jsonl → (msgId, ts) 序列（坏行跳过）。**归并读取**（chat_service::conv_load_raw
/// 已按等价文件拼接 + msgId 去重）——存量双形态文件都进同一份索引。
fn conv_ids_from_jsonl(conv_id: &str) -> Vec<(String, i64)> {
    crate::chat_service::conv_load_raw(conv_id)
        .iter()
        .filter_map(|v| {
            let id = v.get("msgId")?.as_str()?.to_string();
            if id.is_empty() {
                return None;
            }
            Some((id, v.get("ts").and_then(|t| t.as_i64()).unwrap_or(0)))
        })
        .collect()
}

/// 从 id 列表全量算 meta（重建用）。aliasSrc 由调用方按需补（build 出来是空的）。
pub fn meta_from_ids(ids: &[(String, i64)]) -> ConvMeta {
    let f = fingerprint_of(ids.iter().map(|(id, _)| id.as_str()));
    ConvMeta {
        n: ids.len() as u64,
        last_ts: ids.iter().map(|(_, ts)| *ts).max().unwrap_or(0),
        f_hex: f_to_hex(&f),
        ids: ids.to_vec(),
        alias_src: Vec::new(),
    }
}

fn save_meta(conv_id: &str, m: &ConvMeta) {
    let v = json!({
        "n": m.n,
        "lastTs": m.last_ts,
        "F": m.f_hex,
        "ids": m.ids.iter().map(|(id, ts)| json!([id, ts])).collect::<Vec<_>>(),
        // 2026-10-07：已并入的存量等价文件账本（(文件名, 字节数)）
        "aliasSrc": m.alias_src.iter().map(|(n, len)| json!([n, len])).collect::<Vec<_>>(),
    });
    // 第96轮（修复4）：原子写——临时文件 + rename（进程崩溃/掉电不留半截 meta；
    // std::fs::rename 在 Windows 对已有目标走 MoveFileEx(REPLACE_EXISTING)）。
    let path = meta_path(conv_id);
    let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("meta.json").to_string();
    let tmp = path.with_file_name(format!("{fname}.tmp-{}", std::process::id()));
    if std::fs::write(&tmp, serde_json::to_string(&v).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    } else {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// 增量追加一条（O(1)：F ^= hash(msgId)；ids push）。幂等：已存在则跳过返回 false。
/// 第96轮（修复4）：conv 级 Mutex 包住整个读-改-写（多线程/多任务并发 append
/// 同一会话不再整份覆盖丢索引项——压测单测覆盖）。
pub fn meta_append(conv_id: &str, msg_id: &str, ts: i64) -> bool {
    let lock = conv_lock(conv_id);
    let _g = lock.lock().unwrap();
    let mut m = load_meta_unlocked(conv_id);
    if m.ids.iter().any(|(id, _)| id == msg_id) {
        return false;
    }
    let h = hash_msg_id(msg_id);
    let cur = f_from_hex(&m.f_hex).unwrap_or([0u8; 32]);
    let nf = xor_f(&cur, &h);
    m.f_hex = f_to_hex(&nf);
    m.n += 1;
    if ts > m.last_ts {
        m.last_ts = ts;
    }
    m.ids.push((msg_id.to_string(), ts));
    save_meta(conv_id, &m);
    true
}

// ══════════════ 对账差集（纯函数，单测覆盖） ══════════════

/// 索引差集：返回 (to_push=我有对方没有, to_pull=对方有我没有)。
pub fn diff_ids<'a>(
    mine: &'a [(String, i64)],
    theirs: &'a [(String, i64)],
) -> (Vec<&'a (String, i64)>, Vec<&'a (String, i64)>) {
    let my_set: HashSet<&str> = mine.iter().map(|(id, _)| id.as_str()).collect();
    let their_set: HashSet<&str> = theirs.iter().map(|(id, _)| id.as_str()).collect();
    let to_push = mine.iter().filter(|(id, _)| !their_set.contains(id.as_str())).collect();
    let to_pull = theirs.iter().filter(|(id, _)| !my_set.contains(id.as_str())).collect();
    (to_push, to_pull)
}

/// F 是否一致（hex 形态；非法 hex 视为不一致——保守，走索引精对）。
pub fn f_equal(a_hex: &str, b_hex: &str) -> bool {
    match (f_from_hex(a_hex), f_from_hex(b_hex)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

// ══════════════ 单测 ══════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<(String, i64)> {
        v.iter().enumerate().map(|(i, s)| (s.to_string(), 1000 + i as i64)).collect()
    }

    #[test]
    fn fingerprint_order_independent() {
        // 无序性：任意顺序同一集合 → 同 F
        let a = fingerprint_of(["m1", "m2", "m3", "m4", "m5"].into_iter());
        let b = fingerprint_of(["m5", "m3", "m1", "m4", "m2"].into_iter());
        let c = fingerprint_of(["m2", "m4", "m1", "m5", "m3"].into_iter());
        assert_eq!(a, b);
        assert_eq!(a, c);
    }

    #[test]
    fn fingerprint_incremental_matches_full() {
        // 增量 O(1)：逐条 XOR 与全量等价
        let mut inc = [0u8; 32];
        for id in ["a", "b", "c", "d"] {
            inc = xor_f(&inc, &hash_msg_id(id));
        }
        assert_eq!(inc, fingerprint_of(["a", "b", "c", "d"].into_iter()));
    }

    #[test]
    fn fingerprint_remove_by_xor() {
        // 删一条 = 再 XOR 一次（自逆）
        let full = fingerprint_of(["a", "b", "c"].into_iter());
        let minus_b = xor_f(&full, &hash_msg_id("b"));
        assert_eq!(minus_b, fingerprint_of(["a", "c"].into_iter()));
    }

    #[test]
    fn fingerprint_zero_conflict_free() {
        // 不同集合 → 不同 F；空集 = 全零
        assert_ne!(fingerprint_of(["a"].into_iter()), fingerprint_of(["b"].into_iter()));
        assert_eq!(fingerprint_of(std::iter::empty::<&str>()), [0u8; 32]);
        // 双端一致性锚点：固定 msgId 的 F 期望值（TS 版实现必须产出同一 hex）
        assert_eq!(
            f_to_hex(&fingerprint_of(["m-hello-84"].into_iter())),
            {
                let mut h = Sha256::new();
                h.update(b"m-hello-84");
                let mut arr = [0u8; 32];
                arr.copy_from_slice(&h.finalize());
                f_to_hex(&arr)
            }
        );
    }

    #[test]
    fn diff_disjoint_overlap_fork() {
        // 无交集
        let a1 = ids(&["a", "b"]); let b1 = ids(&["c", "d"]);
        let (p, l) = diff_ids(&a1, &b1);
        assert_eq!(p.len(), 2);
        assert_eq!(l.len(), 2);
        // 有交集
        let a2 = ids(&["a", "b", "c"]); let b2 = ids(&["b", "c", "d"]);
        let (p, l) = diff_ids(&a2, &b2);
        assert_eq!(p.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["a"]);
        assert_eq!(l.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["d"]);
        // 完全一致 → 双空
        let a3 = ids(&["a", "b"]); let b3 = ids(&["b", "a"]);
        let (p, l) = diff_ids(&a3, &b3);
        assert!(p.is_empty());
        assert!(l.is_empty());
    }

    #[test]
    fn merge_convergence() {
        // 分叉合并收敛：A∪B 后 F 相等（网状收敛的数学保证）
        let a = ids(&["a1", "a2", "common"]);
        let b = ids(&["b1", "b2", "b3", "common"]);
        let _ = &a; let _ = &b;
        let (_, pull_a) = diff_ids(&a, &b); // A 缺 B 的
        let (push_a, _) = diff_ids(&a, &b); // B 缺 A 的
        let mut merged_a: Vec<String> = a.iter().map(|(id, _)| id.clone()).collect();
        for (id, _) in pull_a {
            merged_a.push(id.clone());
        }
        let mut merged_b: Vec<String> = b.iter().map(|(id, _)| id.clone()).collect();
        for (id, _) in push_a {
            merged_b.push(id.clone());
        }
        assert_eq!(
            fingerprint_of(merged_a.iter().map(|s| s.as_str())),
            fingerprint_of(merged_b.iter().map(|s| s.as_str()))
        );
        assert_eq!(merged_a.len(), 6); // 3+4-1（common 重复）
    }

    #[test]
    fn meta_from_ids_and_edges() {
        // 空会话
        let m = meta_from_ids(&[]);
        assert_eq!(m.n, 0);
        assert_eq!(m.f_hex, "0".repeat(64));
        assert_eq!(m.last_ts, 0);
        // 单条
        let m = meta_from_ids(&ids(&["solo"]));
        assert_eq!(m.n, 1);
        assert_eq!(m.last_ts, 1000);
        assert!(f_from_hex(&m.f_hex).is_some());
        // 大量（1000 条）
        let big: Vec<(String, i64)> = (0..1000).map(|i| (format!("msg-{i}"), i)).collect();
        let m = meta_from_ids(&big);
        assert_eq!(m.n, 1000);
        assert_eq!(m.last_ts, 999);
        assert_eq!(m.f_hex, f_to_hex(&fingerprint_of((0..1000).map(|i| format!("msg-{i}")).collect::<Vec<_>>().iter().map(|s| s.as_str()))));
    }

    #[test]
    fn f_equal_edge() {
        assert!(f_equal(&"0".repeat(64), &"0".repeat(64)));
        assert!(!f_equal("zz", &"0".repeat(64))); // 非法 hex → 不等（保守）
        assert!(!f_equal(&f_to_hex(&[1u8; 32]), &f_to_hex(&[2u8; 32])));
    }

    // ── 第96轮（修复2）：批次字节预算双闸 ──

    fn wire_img(msg_id: &str, b64_len: usize) -> Value {
        json!({ "msgId": msg_id, "from": "a", "to": "b", "kind": "image",
                "payload": { "name": "p.png", "mime": "image/png", "b64": "x".repeat(b64_len) }, "ts": 1 })
    }

    fn batch_bytes(batch: &[Value]) -> usize {
        batch.iter().map(|m| serde_json::to_string(m).map(|s| s.len()).unwrap_or(0)).sum()
    }

    /// 6×2MB 图片会话（修复2 核心场景）：2MB 二进制图 b64 ≈ 2.8MB（IMG_B64_MAX
    /// 口径），6 张累计 ~16.8MB——纯 50 条闸下一批超服务端 16MB body limit → 413
    /// 对账卡死；字节预算闸下必须分批成功（每批 ≤12MB 安全线）。
    #[test]
    fn chunk_wire_msgs_splits_6x2mb_images_by_bytes() {
        let msgs: Vec<Value> = (0..6).map(|i| wire_img(&format!("m{i}"), 2_800_000)).collect();
        let batches = chunk_wire_msgs(msgs, 50, SYNC_BATCH_BYTE_BUDGET);
        assert!(batches.len() >= 2, "6×2MB 图（b64≈2.8MB）必须分批: {} 批", batches.len());
        let total: usize = batches.iter().map(|b| b.len()).sum();
        assert_eq!(total, 6, "一条不丢");
        for b in &batches {
            assert!(b.len() <= 50, "条数闸");
            assert!(batch_bytes(b) <= SYNC_BATCH_BYTE_BUDGET, "字节闸: {}B", batch_bytes(b));
        }
        // 顺序保持（对账 push 序=jsonl 序）
        let ids: Vec<&str> = batches.iter().flatten().map(|m| m["msgId"].as_str().unwrap()).collect();
        assert_eq!(ids, ["m0", "m1", "m2", "m3", "m4", "m5"]);
    }

    #[test]
    fn chunk_wire_msgs_count_gate_and_single_oversize() {
        // 条数闸：60 条小消息 → 50+10 两批（字节远未及）
        let msgs: Vec<Value> = (0..60).map(|i| wire_img(&format!("m{i}"), 10)).collect();
        let batches = chunk_wire_msgs(msgs, 50, SYNC_BATCH_BYTE_BUDGET);
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].len(), 50);
        assert_eq!(batches[1].len(), 10);
        // 单条超预算独占一批（消息不可再拆；14MB 文件上限下服务端仍收得下）
        let msgs = vec![wire_img("big", 13_000_000), wire_img("s", 10)];
        let batches = chunk_wire_msgs(msgs, 50, SYNC_BATCH_BYTE_BUDGET);
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].len(), 1);
        assert_eq!(batches[0][0]["msgId"], json!("big"));
        // 空输入 → 零批
        assert!(chunk_wire_msgs(vec![], 50, SYNC_BATCH_BYTE_BUDGET).is_empty());
    }

    // ── 第96轮（修复4）：meta 并发写不丢索引项（压测） ──

    /// 2026-10-07 修（flaky 实锤）：改走进程级共享锁（test_env_lock.rs）——本模块
    /// 此前独设 MYCO_CONFIG_DIR 且**不持锁**，与 chat_service/dsh_share 测试并行时
    /// 全局 env 互相覆盖、meta 读改写互踩。返回 Guard 请全程持有。
    fn ensure_test_config_dir() -> std::sync::MutexGuard<'static, ()> {
        crate::test_env_lock::test_env_lock()
    }

    /// 8 线程 × 50 条交替 append 同一会话：无锁读-改-写会整份覆盖丢项；
    /// conv 级锁 + 原子写下 400 条索引必须全在、F 与全量指纹一致、无 tmp 残留。
    #[test]
    fn meta_append_concurrent_no_lost_entries() {
        let _g = ensure_test_config_dir(); // 全程持锁：与其它进程级 env 测试串行
        let conv = format!("stress-conv-{}", std::process::id());
        let threads = 8usize;
        let per = 50usize;
        let mut handles = vec![];
        for t in 0..threads {
            let conv = conv.clone();
            handles.push(std::thread::spawn(move || {
                for i in 0..per {
                    let id = format!("t{t}-m{i}");
                    assert!(meta_append(&conv, &id, (t * per + i) as i64));
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let m = load_meta(&conv);
        assert_eq!(m.n, (threads * per) as u64, "索引条数不丢");
        assert_eq!(m.ids.len(), threads * per);
        assert_eq!(m.last_ts, (threads * per - 1) as i64);
        // F 与全量指纹一致（XOR 无序——并发任何交错序都收敛同一值）
        let all: Vec<String> = (0..threads).flat_map(|t| (0..per).map(move |i| format!("t{t}-m{i}"))).collect();
        assert_eq!(m.f_hex, f_to_hex(&fingerprint_of(all.iter().map(|s| s.as_str()))));
        // 幂等：重放任意一条 false 且计数不变
        assert!(!meta_append(&conv, "t0-m0", 0));
        assert_eq!(load_meta(&conv).n, (threads * per) as u64);
        // 原子写：无 tmp 残留
        let bucket = crate::chat_service::chat_dir();
        let tmp_left = std::fs::read_dir(&bucket).unwrap().flatten()
            .any(|e| e.file_name().to_string_lossy().contains(".tmp-"));
        assert!(!tmp_left, "原子写临时文件不得残留");
        // meta 文件本体可解析（非半截）
        assert!(load_meta_raw(&conv).n == (threads * per) as u64);
    }
}
