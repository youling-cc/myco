//! per-peer 身份（task.md §11 H.3.1；2026-11-09 与 myco 定稿的职责分离）：
//!   身份密钥只证明「对端是谁」（可信识别 DID）；授权完全归 DID grant（宿主/钩子）。
//! PSK 继续负责载荷加密，但它是组织共享的，**不能当身份**。
//!
//! 协议：内层帧 `STREAM_TAG_AUTH(0x08)`（连接级，stream 字段不用于路由）：
//!   `[ver:1][key_id_len:1][key_id][did_len:2][did][ts:8][sig:64]`
//!   `sig = Ed25519("vnet-auth-v1" || my_peer_id(LE) || peer_peer_id(LE) || ts(LE))`
//! 已知残差（记录在 H.3.1）：sig 未绑定会话 nonce——但 AUTH 只在 PSK 加密通道内传输，
//! 无 PSK 的注入者本来就进不来；窗口内重放是残余风险，后续用 nonce 绑定收紧。
//!
//! 交付到 HTTP 层：`VNETP/1` 前导（H.3.2 方案 B）——server 在连上上游后先写
//! `VNETP/1 <did> <key_id>\r\n` 再写隧道字节；仅对 `VNET_VNETP_PORTS` 声明的端口启用，
//! 绝不污染 RDP/SSH 等非 HTTP 上游。

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use std::sync::OnceLock;

/// 内层帧 tag：连接级 AUTH（0x03/0x06/0x07 之外的下一个可用值；0x01=DATA）
pub const STREAM_TAG_AUTH: u8 = 0x08;
pub const AUTH_VER: u8 = 1;
/// 签名域分隔（防跨协议重用）
const DOMAIN: &[u8] = b"vnet-auth-v1";
/// ts 容差（客户端时钟漂移 + 重发窗口）
const TS_WINDOW_SECS: i64 = 300;

#[derive(Clone, Debug, PartialEq)]
pub struct PeerIdentity {
    pub did: String,
    pub key_id: String,
    /// 声明并经签名绑定的发送方 peer id（relay 路径会与信封 src_peer 比对）
    pub peer_id: u32,
    pub verified_at: u64,
}

/// 上游端口决策（宿主钩子）
pub enum AuthDecision {
    Allow,
    Deny { code: &'static str, reason: String },
}

/// 钩子入参：连接级身份 + 本次流要去的上游口
pub struct InboundCtx<'a> {
    pub peer: &'a PeerIdentity,
    pub target_port: u16,
    pub path: &'a str,
}

type Resolver = Box<dyn Fn(&str) -> Option<(String, VerifyingKey)> + Send + Sync>;
type Hook = Box<dyn Fn(&InboundCtx) -> AuthDecision + Send + Sync>;

struct IdentityState {
    /// 本机身份（Mutex 可覆写：本端密钥轮换 + 并行测试隔离；
    /// OnceLock 首写获胜曾让测试竞态——见 build_auth_frame 读取处注释）
    local: std::sync::Mutex<Option<(String, String, SigningKey)>>,
    resolver: std::sync::Mutex<Option<Resolver>>,
    hook: std::sync::Mutex<Option<Hook>>,
    /// 认证失败计数（status 用）
    auth_fail: std::sync::atomic::AtomicU64,
}

static STATE: OnceLock<IdentityState> = OnceLock::new();

fn state() -> &'static IdentityState {
    STATE.get_or_init(|| IdentityState {
        local: std::sync::Mutex::new(None),
        resolver: std::sync::Mutex::new(None),
        hook: std::sync::Mutex::new(None),
        auth_fail: std::sync::atomic::AtomicU64::new(0),
    })
}

/// 设置本机身份（client 与 server 都可设；Mutex 可覆写——支持本端密钥轮换，
/// 也让并行测试互不吞配置；OnceLock 首写获胜曾让测试竞态）。
/// 设置后本端开始发送 AUTH，**server 侧同时启用强制校验**：
/// 未认证 peer 的流一律 `AUTH_REQUIRED` 拒绝。
pub fn set_local_identity(did: String, key_id: String, key: SigningKey) {
    *state().local.lock().unwrap() = Some((did, key_id.clone(), key));
    println!("  [AUTH] local identity set (key_id={}, auth enforcement ON)", key_id);
}

/// 本机身份是否已设置（= 认证启用）
pub fn enabled() -> bool {
    state().local.lock().unwrap().is_some()
}

pub fn local_did() -> Option<String> {
    state().local.lock().unwrap().as_ref().map(|l| l.0.clone())
}

/// key→DID 解析来源（宿主注入；返回 None = 未知设备 → fail closed；可覆写=轮换）
pub fn set_peer_resolver(f: Resolver) {
    *state().resolver.lock().unwrap() = Some(f);
}

/// 生产导入路径（给 myco 复用既有设备身份）：直接用 myco 的
/// `did:myco:z6Mk…` DID + device.key 的 Ed25519 seed（32 字节 hex）构造本机身份。
/// 返回派生 key_id（两端一致；也可用 `key_id_of` 自己算）。
/// **`vnet keygen` 只用于测试**——生产绝不生成第二身份（did:myco:dev-*），
/// 否则认证能过、DID grant 全错（myco 2026-11-09 部署对齐点）。
pub fn set_local_identity_from_seed(did: &str, seed_hex: &str) -> Option<String> {
    let seed = hex_decode(seed_hex)?;
    if seed.len() != 32 {
        return None;
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&seed);
    let key = SigningKey::from_bytes(&arr);
    let key_id = key_id_of(&VerifyingKey::from(&key));
    set_local_identity(did.to_string(), key_id.clone(), key);
    Some(key_id)
}

/// 授权钩子（每次建流回调；未设置 = 认证通过即放行，授权归 DID grant 的宿主逻辑）
pub fn set_inbound_auth_hook(f: Hook) {
    *state().hook.lock().unwrap() = Some(f);
}

pub fn auth_fail_count() -> u64 {
    state().auth_fail.load(std::sync::atomic::Ordering::Relaxed)
}

fn note_fail(code: &str) {
    state().auth_fail.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    println!("  [AUTH] DENY code={}", code);
}

// ── 帧构造/解析 ────────────────────────────────────────────────────────────

fn sign_payload(key: &SigningKey, my_peer_id: u32, peer_peer_id: u32, ts: i64) -> Signature {
    let mut msg = Vec::with_capacity(32);
    msg.extend_from_slice(DOMAIN);
    msg.extend_from_slice(&my_peer_id.to_le_bytes());
    msg.extend_from_slice(&peer_peer_id.to_le_bytes());
    msg.extend_from_slice(&ts.to_le_bytes());
    key.sign(&msg)
}

/// 构造本机的 AUTH 内层帧（未启用身份时返回 None）
/// 格式：`[ver][kid_len][kid][did_len:2][did][sender_peer_id:4][ts:8][sig:64]`
pub fn build_auth_frame(my_peer_id: u32, peer_peer_id: u32) -> Option<Vec<u8>> {
    let (did, key_id, key) = state().local.lock().unwrap().clone()?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let sig = sign_payload(&key, my_peer_id, peer_peer_id, ts);
    let mut f = Vec::with_capacity(3 + 1 + 1 + key_id.len() + 2 + did.len() + 4 + 8 + 64);
    f.extend_from_slice(&[STREAM_TAG_AUTH, 0, 0]); // stream 字段固定 0（连接级）
    f.push(AUTH_VER);
    f.push(key_id.len() as u8);
    f.extend_from_slice(key_id.as_bytes());
    f.extend_from_slice(&(did.len() as u16).to_be_bytes());
    f.extend_from_slice(did.as_bytes());
    f.extend_from_slice(&my_peer_id.to_le_bytes());
    f.extend_from_slice(&ts.to_le_bytes());
    f.extend_from_slice(&sig.to_bytes());
    Some(f)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AuthParseError {
    Malformed,
    UnknownKey,
    SigInvalid,
    Stale,
}

/// 校验对端 AUTH 帧：解析 → 解析器取公钥 → 验签 → ts 窗口。
/// 返回的 PeerIdentity 带声明 sender peer_id；relay 路径由调用方与信封 src_peer 比对。
pub fn verify_auth_frame(payload: &[u8], my_peer_id: u32) -> Result<PeerIdentity, AuthParseError> {
    let fail = |e: AuthParseError| -> Result<PeerIdentity, AuthParseError> {
        note_fail(match &e {
            AuthParseError::Malformed => "MF_BAD_FRAME",
            AuthParseError::UnknownKey => "KEY_UNKNOWN",
            AuthParseError::SigInvalid => "SIG_INVALID",
            AuthParseError::Stale => "AUTH_STALE",
        });
        Err(e)
    };
    // payload 已去掉 3 字节内层头
    if payload.len() < 1 + 1 + 2 + 4 + 8 + 64 {
        return fail(AuthParseError::Malformed);
    }
    if payload[0] != AUTH_VER {
        return fail(AuthParseError::Malformed);
    }
    let kid_len = payload[1] as usize;
    let mut off = 2;
    if payload.len() < off + kid_len + 2 {
        return fail(AuthParseError::Malformed);
    }
    let key_id = String::from_utf8_lossy(&payload[off..off + kid_len]).to_string();
    off += kid_len;
    let did_len = u16::from_be_bytes([payload[off], payload[off + 1]]) as usize;
    off += 2;
    if payload.len() < off + did_len + 4 + 8 + 64 {
        return fail(AuthParseError::Malformed);
    }
    let did = String::from_utf8_lossy(&payload[off..off + did_len]).to_string();
    off += did_len;
    let sender_id = u32::from_le_bytes([payload[off], payload[off + 1], payload[off + 2], payload[off + 3]]);
    off += 4;
    let mut ts = [0u8; 8];
    ts.copy_from_slice(&payload[off..off + 8]);
    let ts = i64::from_le_bytes(ts);
    off += 8;
    let mut sig = [0u8; 64];
    sig.copy_from_slice(&payload[off..off + 64]);

    // ts 窗口（先于验签：省掉明显陈旧帧的验签开销）
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    if (now - ts).abs() > TS_WINDOW_SECS {
        return fail(AuthParseError::Stale);
    }

    // key→DID（fail closed：解析器不在/未知 key → 拒绝）。
    // 短暂持锁调用（resolver 是廉价查表；set_peer_resolver 极少发生）
    let (pinned_did, vk) = {
        let guard = state().resolver.lock().unwrap();
        match guard.as_ref().and_then(|r| r(&key_id)) {
            Some(v) => v,
            None => return fail(AuthParseError::UnknownKey),
        }
    };
    if pinned_did != did {
        // key 与 DID 不匹配 = 冒用
        return fail(AuthParseError::SigInvalid);
    }

    let mut msg = Vec::with_capacity(32);
    msg.extend_from_slice(DOMAIN);
    msg.extend_from_slice(&sender_id.to_le_bytes());
    msg.extend_from_slice(&my_peer_id.to_le_bytes());
    msg.extend_from_slice(&ts.to_le_bytes());
    let sig = Signature::from_bytes(&sig);
    if vk.verify(&msg, &sig).is_err() {
        return fail(AuthParseError::SigInvalid);
    }
    Ok(PeerIdentity { did, key_id, peer_id: sender_id, verified_at: now as u64 })
}

/// 授权钩子（未设置 = 放行）
pub fn authorize(peer: &PeerIdentity, target_port: u16, path: &str) -> Result<(), (&'static str, String)> {
    let decision = {
        let guard = state().hook.lock().unwrap();
        match guard.as_ref() {
            Some(h) => h(&InboundCtx { peer, target_port, path }),
            None => return Ok(()),
        }
    };
    match decision {
        AuthDecision::Allow => Ok(()),
        AuthDecision::Deny { code, reason } => {
            note_fail(code);
            Err((code, reason))
        }
    }
}

/// VNETP 前导：写给上游的第一行，让 myco HTTP 入口拿到可信来源 DID。
/// `VNETP/1 <did> <key_id>\r\n`
pub fn vnetp_preamble(peer: &PeerIdentity) -> Vec<u8> {
    let mut v = Vec::with_capacity(16 + peer.did.len() + peer.key_id.len());
    v.extend_from_slice(b"VNETP/1 ");
    v.extend_from_slice(peer.did.as_bytes());
    v.push(b' ');
    v.extend_from_slice(peer.key_id.as_bytes());
    v.extend_from_slice(b"\r\n");
    v
}

/// 该上游口是否启用 VNETP（默认关闭：绝不污染非 HTTP 上游）
pub fn vnetp_enabled_for(target_port: u16) -> bool {
    static PORTS: OnceLock<Vec<u16>> = OnceLock::new();
    let ports = PORTS.get_or_init(|| {
        std::env::var("VNET_VNETP_PORTS")
            .ok()
            .map(|s| s.split(',').filter_map(|x| x.trim().parse::<u16>().ok()).collect())
            .unwrap_or_default()
    });
    ports.contains(&target_port)
}

// ── env 引导（CLI/评测用；产品路径由 myco 直接调 lib API）──────────────────

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

/// `VNET_IDENTITY="did|key_id|seed_hex"`（seed 32 字节）
pub fn init_from_env() {
    if let Ok(v) = std::env::var("VNET_IDENTITY") {
        let parts: Vec<&str> = v.split('|').collect();
        if parts.len() == 3 {
            if let Some(seed) = hex_decode(parts[2]) {
                if seed.len() == 32 {
                    let mut s = [0u8; 32];
                    s.copy_from_slice(&seed);
                    let key = SigningKey::from_bytes(&s);
                    let vk = VerifyingKey::from(&key);
                    let pub_hex: String = vk.to_bytes().iter().map(|b| format!("{:02x}", b)).collect();
                    set_local_identity(parts[0].to_string(), parts[1].to_string(), key);
                    println!("  [AUTH] identity from env (pub={})", &pub_hex[..16]);
                }
            }
        }
    }
    // `VNET_PEER_KEYS="key_id|did|pub_hex,..."` —— pinned 解析器（离线可用）。
    // 分隔符必须用 '|'：DID 本身含 ':'（did:myco:…），用 ':' 切分会解析出 0 个 key
    // （2026-11-09 e2e 实测翻车点）。
    if let Ok(v) = std::env::var("VNET_PEER_KEYS") {
        let table: Vec<(String, String, VerifyingKey)> = v
            .split(',')
            .filter_map(|ent| {
                let p: Vec<&str> = ent.trim().splitn(3, '|').collect();
                if p.len() != 3 {
                    return None;
                }
                let kb = hex_decode(p[2])?;
                let mut arr = [0u8; 32];
                if kb.len() != 32 {
                    return None;
                }
                arr.copy_from_slice(&kb);
                Some((p[0].to_string(), p[1].to_string(), VerifyingKey::from_bytes(&arr).ok()?))
            })
            .collect();
        println!("  [AUTH] pinned {} peer key(s) from env", table.len());
        set_peer_resolver(Box::new(move |kid| {
            table.iter().find(|(k, _, _)| k == kid).map(|(_, d, v)| (d.clone(), *v))
        }));
    }
}

/// 便捷：`vnet keygen` —— **开发/测试材料生成**（时间+pid 做种，不用于生产密钥；
/// 生产密钥由 myco 按自己的密钥管理生成，本函数只是让 CLI/评测能拿到可用材料）。
pub fn keygen_material() -> (String, String, String) {
    let mut seed = [0u8; 32];
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let mut x = t.as_nanos() as u64 ^ ((std::process::id() as u64) << 32);
    for b in seed.iter_mut() {
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;
        *b = (x & 0xff) as u8;
    }
    let key = SigningKey::from_bytes(&seed);
    let vk = VerifyingKey::from(&key);
    let seed_hex: String = seed.iter().map(|b| format!("{:02x}", b)).collect();
    let pub_hex: String = vk.to_bytes().iter().map(|b| format!("{:02x}", b)).collect();
    (seed_hex, pub_hex, key_id_of(&vk))
}

pub fn key_id_of(vk: &VerifyingKey) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(b"vnet-key-id");
    h.update(vk.to_bytes());
    let d = h.finalize();
    // base58 太重：取前 8 字节 hex（碰撞概率对本用途足够；轮换由宿主管）
    d.iter().take(8).map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 身份测试全用进程级全局状态（local/resolver/hook）——并行会互相覆写。
    /// 2026-11-09 两次翻车：OnceLock 首写吞配置 → 换 Mutex → Mutex 可覆写又互踩。
    /// 定论：这类测试必须串行。
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn tmp_identity(tag: u8) -> (String, String, SigningKey, VerifyingKey) {
        let mut seed = [0u8; 32];
        seed[0] = tag;
        let key = SigningKey::from_bytes(&seed);
        let vk = VerifyingKey::from(&key);
        (format!("did:myco:test{}", tag), key_id_of(&vk), key, vk)
    }

    fn frame_for(tag: u8, my: u32, peer: u32) -> (Vec<u8>, String) {
        let (did, kid, key, vk) = tmp_identity(tag);
        // 注意：tests 并行跑且共享 OnceLock resolver——每次都 pin 全部测试身份，
        // 避免「A 装的 resolver 被 B 覆盖」的竞态（曾让 tampered 用例收到 UnknownKey）。
        let ids: Vec<(String, String, VerifyingKey)> = (1..=4)
            .map(|t| {
                let (d, k, _, v) = tmp_identity(t);
                (k, d, v)
            })
            .collect();
        set_peer_resolver(Box::new(move |k| {
            ids.iter().find(|(kk, _, _)| kk == k).map(|(_, d, v)| (d.clone(), *v))
        }));
        let f = build_auth_frame_for(&did, &kid, &key, my, peer);
        (f, kid)
    }

    /// 直接用给定身份构造（绕过全局 local，测试用）
    fn build_auth_frame_for(did: &str, kid: &str, key: &SigningKey, my: u32, _peer: u32) -> Vec<u8> {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let sig = sign_payload(key, my, 222, ts);
        let mut f = vec![STREAM_TAG_AUTH, 0, 0, AUTH_VER];
        f.push(kid.len() as u8);
        f.extend_from_slice(kid.as_bytes());
        f.extend_from_slice(&(did.len() as u16).to_be_bytes());
        f.extend_from_slice(did.as_bytes());
        f.extend_from_slice(&my.to_le_bytes());
        f.extend_from_slice(&ts.to_le_bytes());
        f.extend_from_slice(&sig.to_bytes());
        f
    }

    fn payload_of(frame: &[u8]) -> &[u8] {
        &frame[3..]
    }

    #[test]
    fn test_auth_roundtrip_and_identity() {
        let _g = TEST_LOCK.lock().unwrap();
        let (f, _) = frame_for(1, 111, 222);
        let id = verify_auth_frame(payload_of(&f), 222).expect("verified");
        assert!(id.did.starts_with("did:myco:test1"));
        assert_eq!(id.peer_id, 111);
        assert_ne!(id.key_id, "");
    }

    #[test]
    fn test_auth_tampered_sig_rejected() {
        let _g = TEST_LOCK.lock().unwrap();
        let (mut f, _) = frame_for(2, 111, 222);
        let last = f.len() - 1;
        f[last] ^= 0x01;
        assert!(matches!(
            verify_auth_frame(payload_of(&f), 222),
            Err(AuthParseError::SigInvalid)
        ));
    }

    #[test]
    fn test_auth_unknown_key_rejected() {
        let _g = TEST_LOCK.lock().unwrap();
        // 解析器 pin 了 1..=4；用 tag=9（未 pin）的身份发帧
        let (_, _, _, vk3) = tmp_identity(3);
        let did3 = format!("did:myco:test3");
        let kid3 = key_id_of(&vk3);
        let ids: Vec<(String, String, VerifyingKey)> = (1..=4)
            .map(|t| {
                let (d, k, _, v) = tmp_identity(t);
                (k, d, v)
            })
            .collect();
        set_peer_resolver(Box::new(move |k| {
            ids.iter().find(|(kk, _, _)| kk == k).map(|(_, d, v)| (d.clone(), *v))
        }));
        let _ = (kid3, did3);
        let (mut f9, _) = {
            let (did, kid, key, _) = tmp_identity(9);
            let f = build_auth_frame_for(&did, &kid, &key, 111, 222);
            (f, kid)
        };
        let _ = &mut f9;
        assert!(matches!(
            verify_auth_frame(payload_of(&f9), 222),
            Err(AuthParseError::UnknownKey)
        ));
    }

    #[test]
    fn test_auth_malformed_rejected() {
        let _g = TEST_LOCK.lock().unwrap();
        assert!(matches!(
            verify_auth_frame(&[9, 1, 2], 222),
            Err(AuthParseError::Malformed)
        ));
        // 版本不对
        assert!(matches!(
            verify_auth_frame(&[2u8; 90], 222),
            Err(AuthParseError::Malformed)
        ));
    }

    #[test]
    fn test_vnetp_preamble_format() {
        let _g = TEST_LOCK.lock().unwrap();
        let p = vnetp_preamble(&PeerIdentity {
            did: "did:myco:zABC".into(),
            key_id: "a1b2c3d4e5f60718".into(),
            peer_id: 7,
            verified_at: 1,
        });
        assert!(p.starts_with(b"VNETP/1 did:myco:zABC a1b2c3d4e5f60718\r\n"));
    }

    /// 生产身份复用（myco 2026-11-09 部署对齐）：真实 `did:myco:z6Mk…` 格式的 DID
    /// 全链路通过——DID 对协议是不透明字节，只要与 resolver 里 pin 的一致即可。
    #[test]
    fn test_real_did_format_and_seed_import() {
        let _g = TEST_LOCK.lock().unwrap();
        // 真实格式 DID（z6Mk = ed25519 pubkey multicodec，48 字符 base58）
        let real_did = "did:myco:z6MkqTHR5Vp8sWQazmuaN2sSJQLBauPfZx1STLtYcH5CwF";
        let mut seed = [7u8; 32];
        seed[0] = 42;
        let key = SigningKey::from_bytes(&seed);
        let vk = VerifyingKey::from(&key);
        let seed_hex: String = seed.iter().map(|b| format!("{:02x}", b)).collect();

        // 导入路径：set_local_identity_from_seed（返回派生 key_id）
        let kid = set_local_identity_from_seed(real_did, &seed_hex)
            .expect("import from seed works");
        assert_eq!(kid, key_id_of(&vk));

        // pin 自己的 key，然后完整走 build→verify
        let did_c = real_did.to_string();
        set_peer_resolver(Box::new(move |k| {
            if k == kid {
                Some((did_c.clone(), vk))
            } else {
                None
            }
        }));
        let f = build_auth_frame(777, 888).expect("frame built with imported identity");
        let id = verify_auth_frame(&f[3..], 888).expect("verified");
        assert_eq!(id.did, real_did);
        assert_eq!(id.peer_id, 777);
    }
}
