//! delegation.rs — 委任状(myco 账号模型 v1,design/08-identity/MYCO-ACCOUNT-MODEL.md)。
//!
//! 一人一个 myco 账号(Soul DID);分身设备持「委任状」= 账号签的
//! {设备钥, 设备名, scope收窄?, 7天, nonce}。出示双证(对方授权+委任状)即行动。
//! 设备钥是隐形管道(不是用户可见 DID);本模块管:签发/验证/存储/吊销/续签收件箱。
//!
//! wire(与 authorized.rs attest 同风格,行式消息,ed25519):
//!   msg = "delegation\n{accountDid}\n{devicePubkeyB64}\n{deviceName}\n{scopesCsv|*}\n{issuedAt}\n{exp}\n{nonce}"
//!   出示 = base64(json 体) + "." + sigB64   ← X-Myco-Delegation 头

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

pub const DELEGATION_TTL_MS: u64 = 7 * 24 * 3600 * 1000; // 7 天(定稿)
/// DID 互换收编投递信箱的委任状 TTL：30 天（手机端 identity.ts issueDelegationToDevice
/// 对等——主设备加成员即签 30 天投 /delegation/deliver，被收编端 poll 取走）。
pub const DEVICE_DELIVER_TTL_MS: u64 = 30 * 24 * 3600 * 1000;
/// 续签阈值:剩余 <20% TTL 或 <24h 触发(分身侧判断;本模块提供 is_due_renew 供参考)
pub const RENEW_FRACTION: f64 = 0.2;
pub const RENEW_MIN_MS: u64 = 24 * 3600 * 1000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 委任状正文(签名的载体;serde 只为存储/传输方便,验证一律按行式 msg 重建)。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Delegation {
    /// 归属账号 did。serde 写出 `accountDid`；历史存量/手机端写的字段名是
    /// `mycoDid`（env 时代字段名 myco_did 的 camelCase 残留）——读侧 alias 双兼容，
    /// 不迁移数据。缺它时 delegations.json 整文件反序列化失败（Vec 一损俱损），
    /// accounts_load_with_roles 的分身判定恒 false（2026-10-01 真 bug）。
    #[serde(alias = "mycoDid")]
    pub account_did: String,
    pub device_pubkey_b64: String,
    pub device_name: String,
    /// scope 收窄(逗号串;"*"=不收窄,受授权表条目约束)
    pub scopes: String,
    pub issued_at: u64,
    pub exp: u64,
    pub nonce: String,
    /// 账号签名(base64)。构造后由 sign() 填充。
    #[serde(default)]
    pub sig_b64: String,
}

impl Delegation {
    /// 行式签名消息(规范形——验证与签发共用,字段增删必须同步改这里)。
    pub fn msg(&self) -> String {
        format!(
            "delegation\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
            self.account_did, self.device_pubkey_b64, self.device_name, self.scopes, self.issued_at, self.exp, self.nonce
        )
    }

    /// 是否该续签(剩余 <20% TTL 或 <24h)。
    pub fn is_due_renew(&self) -> bool {
        self.is_due_renew_at(now_ms())
    }

    /// 续签判定的可注入 now 形态（2026-10-11 委任状自动续约：巡签调度/单测边界用，
    /// 语义与手机端 delegation.ts isDueRenew 逐字对齐——过期也 true，由服务端宽限闸兜底）。
    pub fn is_due_renew_at(&self, now: u64) -> bool {
        now >= self.exp
            || (self.exp - now) < RENEW_MIN_MS
            || (self.exp - self.issued_at) as f64 * RENEW_FRACTION > (self.exp - now) as f64
    }

    /// 是否已过期（now >= exp，与 verify 的拒收语义同口径）。
    pub fn is_expired_at(&self, now: u64) -> bool {
        now >= self.exp
    }

    /// 委任状原始 TTL（exp - issuedAt；巡签重签时保持原 TTL 不改条款）。
    pub fn ttl_ms(&self) -> u64 {
        self.exp.saturating_sub(self.issued_at)
    }
}

/// 用 Soul 私钥签发委任状。seed 来自 identity::cached_account_seed(本体登录态)。
pub fn issue(myco_seed: &[u8; 32], account_did: &str, device_pubkey_b64: &str, device_name: &str, scopes: Option<Vec<String>>) -> Delegation {
    issue_with_ttl(myco_seed, account_did, device_pubkey_b64, device_name, scopes, DELEGATION_TTL_MS, "d")
}

/// 通用签发：ttl 与 nonce 前缀可指（设备委任状 7 天/d 前缀；会话委任状 12h/sk 前缀）。
/// 行式规范形不变（Delegation::msg），验证侧零感知。
pub fn issue_with_ttl(myco_seed: &[u8; 32], account_did: &str, device_pubkey_b64: &str, device_name: &str, scopes: Option<Vec<String>>, ttl_ms: u64, nonce_prefix: &str) -> Delegation {
    use base64::Engine as _;
    use ed25519_dalek::Signer as _;
    let mut d = Delegation {
        account_did: account_did.to_string(),
        device_pubkey_b64: device_pubkey_b64.to_string(),
        device_name: device_name.to_string(),
        scopes: scopes.map(|s| s.join(",")).unwrap_or_else(|| "*".into()),
        issued_at: now_ms(),
        exp: now_ms() + ttl_ms,
        nonce: format!("{}{}", nonce_prefix, now_ms()),
        sig_b64: String::new(),
    };
    let sk = ed25519_dalek::SigningKey::from_bytes(myco_seed);
    d.sig_b64 = base64::engine::general_purpose::STANDARD.encode(sk.sign(d.msg().as_bytes()).to_bytes());
    d
}

/// A1 提交面会话钥 TTL：会话级 12 小时（工作会话跨度上限；登出/关页即焚为提前量）。
pub const SESSION_KEY_TTL_MS: u64 = 12 * 3600 * 1000;
pub const SESSION_KEY_DEVICE_NAME: &str = "browser-session";
pub const SESSION_KEY_SCOPES: &str = "submit-answer";

/// 签发「提交面会话钥」委任状（A1，refactor 仓 docs/security/2026-09-30-session-key-submission.md）：
/// 账号钥授权浏览器临时 Ed25519 钥在本会话内提交答案签名。
/// 与设备委任状同一行式规范形（平台 Java SessionKeyService / identity-svc 同款验证），
/// 仅 device_name="browser-session"、scopes="submit-answer"（收窄）、ttl=12h。
pub fn issue_session_key(myco_seed: &[u8; 32], account_did: &str, session_pubkey_b64: &str) -> Delegation {
    issue_with_ttl(
        myco_seed,
        account_did,
        session_pubkey_b64,
        SESSION_KEY_DEVICE_NAME,
        Some(vec![SESSION_KEY_SCOPES.to_string()]),
        SESSION_KEY_TTL_MS,
        "sk",
    )
}

/// 验证委任状:签名(账号公钥自 DID 派生)+ 未过期。返回 Ok(剩余毫秒) 或 Err(原因)。
/// 吊销检查不在本函数(注册表/本地存储由调用方查)。
pub fn verify(d: &Delegation) -> Result<u64, String> {
    use base64::Engine as _;
    use ed25519_dalek::Verifier as _;
    let soul_pub = pubkey_from_did(&d.account_did).ok_or("accountDid 非法")?;
    let sig = base64::engine::general_purpose::STANDARD
        .decode(&d.sig_b64)
        .map_err(|_| "签名 base64 坏")?;
    if sig.len() != 64 {
        return Err("签名长度坏".into());
    }
    let sig = ed25519_dalek::Signature::from_slice(&sig).map_err(|_| "签名构坏")?;
    let vk = ed25519_dalek::VerifyingKey::from_bytes(&soul_pub).map_err(|_| "soul 公钥坏")?;
    vk.verify(d.msg().as_bytes(), &sig).map_err(|_| "账号签名不匹配".to_string())?;
    let now = now_ms();
    if now >= d.exp {
        return Err("委任状已过期".into());
    }
    Ok(d.exp - now)
}

/// did → [u8;32] 公钥（**canonical-only**，委托 identity::did_pubkey_bytes）：
/// `did:youling:z…` / `did:myco:z…` 两种 canonical 写法都收（同一公钥）；账号 did canonical
/// 出示形态 = `did:youling:z…`（平台/手机端一致），设备 did = `did:myco:z…`。
/// **legacy 裸 base58 已废止**（2026-10-10）：不再解码 → 委任状验证按"accountDid 非法"拒。
fn pubkey_from_did(did: &str) -> Option<[u8; 32]> {
    crate::identity::did_pubkey_bytes(did)
}

// ── 本体侧存储:~/.myco/delegations.json(我签发过的委任状+吊销标记)──

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationRecord {
    pub delegation: Delegation,
    #[serde(default)]
    pub revoked: bool,
    #[serde(default)]
    pub last_renewed: u64,
}

/// load 时保留谓词（任务4 过期清理，纯函数供单测）：吊销记录保留（吊销注册表
/// revoked_pubkeys/停喂判定靠它），未吊销且 exp 已过丢弃。
pub fn keep_on_load(r: &DelegationRecord, now: u64) -> bool {
    r.revoked || r.delegation.exp > now
}

pub struct Delegations {
    recs: Mutex<Vec<DelegationRecord>>,
    /// 存储文件路径（load()=store_path()；测试用 load_at 指临时文件——
    /// save() 只写 self.path，单测绝不碰真实 config 目录）。
    path: std::path::PathBuf,
}

fn store_path() -> std::path::PathBuf {
    crate::config::config_dir().join("delegations.json")
}

/// 原样读取存储文件（**不做** load 的过期清理——2026-10-11 委任状自动续约）：
/// 巡签要能看见「已过期但未清理」的记录（宽限重签窗口；Delegations::load 的
/// retain 会把过期未吊销行从内存和磁盘上双双抹掉，先读 raw 才来得及补救）。
/// 生产走 [`read_records_raw`]；测试用本函数指临时文件。
pub fn read_records_raw_at(path: &std::path::Path) -> Vec<DelegationRecord> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<DelegationRecord>>(&s).ok())
        .unwrap_or_default()
}

/// [`read_records_raw_at`] 的生产路径（config_dir/delegations.json）。
pub fn read_records_raw() -> Vec<DelegationRecord> {
    read_records_raw_at(&store_path())
}

impl Delegations {
    pub fn load() -> Self {
        Self::load_at(store_path())
    }

    /// 显式路径加载（测试隔离用；生产一律 load()）。
    pub fn load_at(path: std::path::PathBuf) -> Self {
        let mut recs = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<DelegationRecord>>(&s).ok())
            .unwrap_or_default();
        // 2026-10-06 任务4：过期委任状自动清理——load 即过滤（已吊销记录保留：
        // 吊销注册表 revoked_pubkeys 语义靠它们）。有丢弃即落盘一次，旧根/旧设备
        // 的过期残留不会反复进内存（笔记本 9/4 旧根过期委任状残留的来源）。
        let before = recs.len();
        recs.retain(|r| keep_on_load(r, now_ms()));
        let dropped = before - recs.len();
        let s = Self { recs: Mutex::new(recs), path };
        if dropped > 0 {
            s.save();
        }
        s
    }

    fn save(&self) {
        let recs = self.recs.lock().unwrap().clone();
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&self.path, serde_json::to_string_pretty(&recs).unwrap_or_default());
    }

    /// 签发(或续签=同设备重发新 nonce)。设备已吊销则拒绝(停喂)。
    pub fn issue_for(
        &self,
        myco_seed: &[u8; 32],
        account_did: &str,
        device_pubkey_b64: &str,
        device_name: &str,
        scopes: Option<Vec<String>>,
    ) -> Result<Delegation, String> {
        self.issue_for_with_ttl(myco_seed, account_did, device_pubkey_b64, device_name, scopes, DELEGATION_TTL_MS)
    }

    /// 带 TTL 的签发（2026-10-06 任务1：DID 互换收编投信箱用 30 天，与手机端
    /// issueDelegationToDevice 对等；本地 issue() 默认 7 天不变）。
    /// 其余语义同 issue_for：已吊销拒签(停喂)、同设备重签原地替换、本地留档。
    pub fn issue_for_with_ttl(
        &self,
        myco_seed: &[u8; 32],
        account_did: &str,
        device_pubkey_b64: &str,
        device_name: &str,
        scopes: Option<Vec<String>>,
        ttl_ms: u64,
    ) -> Result<Delegation, String> {
        let mut recs = self.recs.lock().unwrap();
        if recs.iter().any(|r| r.delegation.device_pubkey_b64 == device_pubkey_b64 && r.revoked) {
            return Err("该设备已被吊销——续签拒绝(停喂)".into());
        }
        // 会话级 nonce(2026-09-03 残留根因):同设备同会话窗口内重签=原地续签,
        // 不同会话=新 nonce 替换旧记录(recs.retain 收合)。远程窗命名按启动时刻
        // 命名(远程窗(本机)·0903),首次签发时 nonce 带会话戳。
        // 2026-10-09 多归属修(★3 签发侧):retain 收敛键加账号维——对齐 accept_received
        // 的 (账号,设备) 收敛键(delegation.rs:247-250)。原实现只按 pubkey 互删:
        // 同一台主 PC 持 A、B 两账号种子时,给 B 签发会删掉 A 的留档(实现分叉)。
        let d = issue_with_ttl(myco_seed, account_did, device_pubkey_b64, device_name, scopes, ttl_ms, "d");
        recs.retain(|r| {
            !(r.delegation.device_pubkey_b64 == device_pubkey_b64
                && crate::identity::account_did_eq(&r.delegation.account_did, account_did))
        });
        recs.push(DelegationRecord { delegation: d.clone(), revoked: false, last_renewed: now_ms() });
        drop(recs);
        self.save();
        Ok(d)
    }

    /// 被收编端落凭据（2026-10-06 任务2）：收下的委任状写入本地库。
    /// 同（账号, 设备钥）旧记录原地替换（重投/换签收敛为一条）。调用方须先 verify()。
    pub fn accept_received(&self, d: Delegation) {
        let mut recs = self.recs.lock().unwrap();
        recs.retain(|r| {
            !(r.delegation.device_pubkey_b64 == d.device_pubkey_b64
                && crate::identity::account_did_eq(&r.delegation.account_did, &d.account_did))
        });
        recs.push(DelegationRecord { delegation: d, revoked: false, last_renewed: now_ms() });
        drop(recs);
        self.save();
    }

    /// 接收侧自查：本地是否有「该账号签给本设备钥」的有效委任状
    /// （未吊销 + 验签过 + 未过期）。轮询环据此决定要不要 /delegation/poll 取件。
    pub fn has_valid_for(&self, account_did: &str, device_pubkey_b64: &str) -> bool {
        self.recs.lock().unwrap().iter().any(|r| {
            !r.revoked
                && crate::identity::account_did_eq(&r.delegation.account_did, account_did)
                && r.delegation.device_pubkey_b64 == device_pubkey_b64
                && verify(&r.delegation).is_ok()
        })
    }

    /// 本地该账号签给本设备钥的当前委任状 nonce（未吊销即取）。
    /// 2026-10-06 用途：/delegation/poll 服务端只读不删（deliverBox.get 永久保留），
    /// 同一张委任状会反复取到——轮询环据此判重（同 nonce=已收过跳过，不同=新投递收下），
    /// 防"每 20s 重复弹授权已刷新"。
    pub fn current_nonce_for(&self, account_did: &str, device_pubkey_b64: &str) -> Option<String> {
        self.recs.lock().unwrap().iter()
            .find(|r| !r.revoked
                && crate::identity::account_did_eq(&r.delegation.account_did, account_did)
                && r.delegation.device_pubkey_b64 == device_pubkey_b64)
            .map(|r| r.delegation.nonce.clone())
    }

    /// 吊销(标记;推送注册表由调用方触发)。返回是否找到。
    /// 2026-10-09 多归属修(L2-a/★3)：吊销按 **(账号,设备)** 收敛——原实现
    /// `find` 只取第一条 pubkey 匹配行，同一设备钥在 A、B 各有一条委任状时
    /// A 侧吊销会错杀 B 的行（账号盲）。
    /// 本方法无账号入参（历史 API 形态，cli.rs 等既有调用方），账号按以下序解析：
    /// ① 活动账号（identity::account_did，且确有该账号的匹配行时）；
    /// ② 最近一条匹配行所属账号（该设备钥最新的收编关系）。
    /// 解析出账号后委托 [`Self::revoke_for`]——命中该 (账号,设备) 的**全部**行。
    /// 编排层（有明确账号上下文）应直调 [`Self::revoke_for`]，别依赖此解析序。
    pub fn revoke(&self, device_pubkey_b64: &str) -> bool {
        let target_account = {
            let recs = self.recs.lock().unwrap();
            let last = recs
                .iter()
                .rev()
                .find(|r| r.delegation.device_pubkey_b64 == device_pubkey_b64)
                .map(|r| r.delegation.account_did.clone());
            let Some(fallback) = last else { return false };
            match crate::identity::account_did() {
                Some(active)
                    if recs.iter().any(|r| {
                        r.delegation.device_pubkey_b64 == device_pubkey_b64
                            && crate::identity::account_did_eq(&r.delegation.account_did, &active)
                    }) =>
                {
                    active
                }
                _ => fallback,
            }
        };
        self.revoke_for(&target_account, device_pubkey_b64)
    }

    /// 按账号吊销（2026-10-09 多归属 L2-a）：标记该 **(账号,设备)** 的全部匹配行
    /// （对齐 accept_received 的收敛键；不再"只改第一条"）。返回是否命中。
    /// 编排层在 revoke 调用点捕获账号上下文后显式传参——推送侧同理（见
    /// push_revocations_best_effort 注释），别在动作时再读活动态。
    pub fn revoke_for(&self, account_did: &str, device_pubkey_b64: &str) -> bool {
        let mut recs = self.recs.lock().unwrap();
        let mut hit = false;
        for r in recs.iter_mut() {
            if r.delegation.device_pubkey_b64 == device_pubkey_b64
                && crate::identity::account_did_eq(&r.delegation.account_did, account_did)
            {
                r.revoked = true;
                hit = true;
            }
        }
        drop(recs);
        if hit {
            self.save();
        }
        hit
    }

    /// 本地吊销查询(闸门快速路径)。
    pub fn is_revoked(&self, device_pubkey_b64: &str) -> bool {
        self.recs.lock().unwrap().iter().any(|r| r.delegation.device_pubkey_b64 == device_pubkey_b64 && r.revoked)
    }

    pub fn list(&self) -> Vec<DelegationRecord> {
        self.recs.lock().unwrap().clone()
    }

    /// 该 账号名下已吊销的设备钥列表(推注册表用)。
    /// 2026-10-09 多归属修(L2-b/★3)：加账号参——吊销注册表按账号分账。原实现跨账号
    /// 全量收集，`push_revocations_best_effort` 再用**当前活动账号**的种子签这份
    /// 全量列表 → A 用自己的名义推走 B 的吊销记录（独立跨账号泄露通道）。
    pub fn revoked_pubkeys(&self, account_did: &str) -> Vec<String> {
        self.recs.lock().unwrap().iter()
            .filter(|r| r.revoked && crate::identity::account_did_eq(&r.delegation.account_did, account_did))
            .map(|r| r.delegation.device_pubkey_b64.clone())
            .collect()
    }
}

/// 出示格式:base64(json(Delegation))——头里单段(base64 自含 sig 字段,无需双段)。
pub fn encode_present(d: &Delegation) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(d).unwrap_or_default())
}

/// 解析出示格式。
pub fn decode_present(s: &str) -> Option<Delegation> {
    use base64::Engine as _;
    let raw = base64::engine::general_purpose::STANDARD.decode(s.trim()).ok()?;
    serde_json::from_slice(&raw).ok()
}

// ══ Tauri 命令 + 本体编排 ══

/// 签发/续签委任状(需本机 账号登录态)。
pub async fn delegation_issue(
    del: &std::sync::Arc<Delegations>,
    device_pubkey_b64: String, device_name: String, scopes: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    delegation_issue_impl(del, device_pubkey_b64, device_name, scopes)
}

pub fn delegation_issue_impl(
    del: &std::sync::Arc<Delegations>,
    device_pubkey_b64: String, device_name: String, scopes: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let (seed, soul) = match (crate::identity::cached_account_seed(), crate::identity::account_did()) {
        (Some(s), Some(d)) => (s, d),
        _ => return Err("本机未登录 myco 账号(无公章,不能签委任状)".into()),
    };
    let d = del.issue_for(&seed, &soul, &device_pubkey_b64, &device_name, scopes)?;
    // 即时推一次注册表(尽力而为;失败不挡签发)
    push_revocations_best_effort(del);
    Ok(serde_json::to_value(&d).unwrap_or_default())
}

pub fn delegation_list(del: &std::sync::Arc<Delegations>) -> Vec<DelegationRecord> {
    del.list()
}

/// 吊销设备委任状(=停喂+推注册表)。
/// 2026-10-09 多归属修(★3)：账号上下文在 revoke **之前**一次性捕获（seed+did），
/// 本地吊销走 revoke_for（按 (账号,设备) 全部命中），推送显式传同一账号——
/// 不在推送时刻再读活动态（切号后推送会以新账号名义推旧账号的记录）。
pub fn delegation_revoke(
    del: &std::sync::Arc<Delegations>,
    device_pubkey_b64: String,
) -> bool {
    let ctx = match (crate::identity::cached_account_seed(), crate::identity::account_did()) {
        (Some(s), Some(d)) => Some((s, d)),
        _ => None,
    };
    let ok = match &ctx {
        Some((_, acc)) => del.revoke_for(acc, &device_pubkey_b64),
        None => del.revoke(&device_pubkey_b64),
    };
    if ok {
        if let Some((seed, acc)) = ctx {
            push_registry(&seed, &acc, del.revoked_pubkeys(&acc));
        }
    }
    ok
}

/// 推吊销注册表到 identity-svc(账号签名,尽力而为,不挡调用方)。
/// msg = "revocation\n{accountDid}\n{ts}\n{revokedPubkeysCsv}"
pub fn push_registry(seed: &[u8; 32], account_did: &str, revoked: Vec<String>) {
    if revoked.is_empty() {
        return;
    }
    use base64::Engine as _;
    use ed25519_dalek::Signer as _;
    let ts = now_ms();
    let msg = format!("revocation\n{}\n{}\n{}", account_did, ts, revoked.join(","));
    let sk = ed25519_dalek::SigningKey::from_bytes(seed);
    let sig = base64::engine::general_purpose::STANDARD.encode(sk.sign(msg.as_bytes()).to_bytes());
    let body = serde_json::json!({ "accountDid": account_did, "revokedPubkeys": revoked, "ts": ts, "sigB64": sig });
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_default();
        let _ = client
            .post(format!("{}/revocation/push", crate::identity::base_url()))
            .json(&body)
            .send()
            .await;
    });
}

/// 推送编排:取已吊销列表+账号登录态 → push_registry。
/// 2026-10-09 多归属修(L2-b/★3)：只推**当前活动账号名下**的吊销记录
/// （revoked_pubkeys 加账号参）——签名账号与记录归属必须同账号，否则 A 的推送
/// 会以 A 的名义带走 B 的吊销记录。revoke 编排（delegation_revoke /
/// identity_service::delegation_revoke）在调用点捕获 (seed,account,列表) 显式
/// 传 push_registry，不经本函数（避免推送时刻再读活动态的 TOCTOU 串号）。
pub fn push_revocations_best_effort(del: &std::sync::Arc<Delegations>) {
    let Some(seed) = crate::identity::cached_account_seed() else { return };
    let Some(soul) = crate::identity::account_did() else { return };
    let revoked = del.revoked_pubkeys(&soul);
    push_registry(&seed, &soul, revoked);
}

// ══ 单测 ══

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试确定性种子(rand 0.9 与 dalek 的 rand_core 版本不合,测试无需 CSPRNG)
    /// 账号 did 用 canonical（canonical-only：legacy 已废止，pubkey_from_did 不再收）。
    fn soul() -> ([u8; 32], String) {
        let mut seed = [7u8; 32];
        for (i, b) in seed.iter_mut().enumerate() {
            *b = b.wrapping_add(i as u8).rotate_left(3);
        }
        let sk = ed25519_dalek::SigningKey::from_bytes(&seed);
        (seed, crate::identity::did_from_public(&sk.verifying_key().to_bytes()))
    }

    #[test]
    fn issue_verify_roundtrip() {
        let (seed, soul) = soul();
        let d = issue(&seed, &soul, "dGVzdA==", "手机·PWA", None);
        assert!(verify(&d).is_ok(), "新鲜委任状应验证通过");
        // 篡改设备名 → 验签失败
        let mut bad = d.clone();
        bad.device_name = "被篡改".into();
        assert!(verify(&bad).is_err());
        // 篡改过期时间 → 失败
        let mut bad2 = d.clone();
        bad2.exp += 1000;
        assert!(verify(&bad2).is_err());
        // 过期 → 失败
        let mut old = d.clone();
        old.exp = 1;
        assert!(verify(&old).is_err());
        // 出示编解码往返
        let dec = decode_present(&encode_present(&d)).unwrap();
        assert_eq!(dec, d);
    }

    #[test]
    fn renew_due_logic() {
        let (seed, soul) = soul();
        let d = issue(&seed, &soul, "aGV5", "本", None);
        assert!(!d.is_due_renew(), "新签的 7 天委任状不该续");
        let mut stale = d.clone();
        stale.exp = now_ms() + 3600 * 1000; // 剩 1h
        assert!(stale.is_due_renew(), "剩 1h 该续");
    }

    /// A1 会话委任状：跨语言冻结向量（refactor 仓 example/client_app/tests/
    /// session_key_fixtures.py 固定种子生成）——Rust 的行式规范形与 ed25519-dalek
    /// 签名输出必须与 Python/Java/TS 逐字节一致，这是三端互操作的铁证。
    #[test]
    fn session_key_delegation_matches_cross_lang_vector() {
        use base64::Engine as _;
        use ed25519_dalek::Signer as _;
        let d = Delegation {
            account_did: "did:youling:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9".into(),
            device_pubkey_b64: "gTl3Dqh9F19Wo1Rmw0x+zMuNipG07jeiXfYPW4/Js5Q=".into(),
            device_name: SESSION_KEY_DEVICE_NAME.into(),
            scopes: SESSION_KEY_SCOPES.into(),
            issued_at: 1_790_000_000_000,
            exp: 1_790_043_200_000,
            nonce: "sk1790000000000".into(),
            sig_b64: String::new(),
        };
        assert_eq!(
            d.msg(),
            "delegation\ndid:youling:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9\ngTl3Dqh9F19Wo1Rmw0x+zMuNipG07jeiXfYPW4/Js5Q=\nbrowser-session\nsubmit-answer\n1790000000000\n1790043200000\nsk1790000000000"
        );
        let sk = ed25519_dalek::SigningKey::from_bytes(&[0x01u8; 32]);
        let sig = base64::engine::general_purpose::STANDARD.encode(sk.sign(d.msg().as_bytes()).to_bytes());
        assert_eq!(
            sig,
            "cnNTE/DvGt8Bs5H9o8dtOyhS6dzIX2CTk5T7N89Go/0UKXpL5PjBGauLIq1kDsv+klGU08aYAi1G4RpN3fISAA==",
            "与 Python 冻结向量不一致——规范形或签名实现漂移"
        );
    }

    /// issue_session_key 行为面：device_name/scopes 收窄 + 12h TTL + sk nonce 前缀。
    #[test]
    fn issue_session_key_shape() {
        let (seed, soul) = soul();
        let d = issue_session_key(&seed, &soul, "c2Vzc2lvbg==");
        assert_eq!(d.device_name, "browser-session");
        assert_eq!(d.scopes, "submit-answer");
        assert!(d.nonce.starts_with("sk"));
        let ttl = d.exp - d.issued_at;
        assert_eq!(ttl, SESSION_KEY_TTL_MS);
        assert!(!d.sig_b64.is_empty());
    }

    /// canonical 双前缀（did:youling:z… / did:myco:z…）同公钥都收；
    /// **legacy 裸 base58 已废止**（2026-10-10 canonical-only）→ 不再解码。
    #[test]
    fn pubkey_from_did_accepts_canonical_both_prefixes() {
        let (seed, soul_myco) = soul(); // did:myco:z…
        let soul_youling = format!("did:youling:{}", soul_myco.strip_prefix("did:myco:").unwrap());
        // 两 canonical 写法解析出同一公钥
        assert_eq!(pubkey_from_did(&soul_myco), pubkey_from_did(&soul_youling));
        assert!(pubkey_from_did(&soul_youling).is_some());
        // did:youling:z… 委任状签发→验证全往返（现行账号签发形态）
        let d = issue(&seed, &soul_youling, "dGVzdA==", "手机·PWA", None);
        assert!(verify(&d).is_ok(), "did:youling:z… 委任状应验证通过");
        // did:myco:z… 同钥另一写法照常可验证
        let d2 = issue(&seed, &soul_myco, "dGVzdA==", "手机·PWA", None);
        assert!(verify(&d2).is_ok(), "did:myco:z… 委任状应验证通过");
        // legacy 裸 base58（存量旧形态）已废止：解不出公钥 → 该委任状按 accountDid 非法拒
        let pk = ed25519_dalek::SigningKey::from_bytes(&seed).verifying_key().to_bytes();
        let legacy = format!("did:youling:{}", bs58::encode(pk).into_string());
        assert!(pubkey_from_did(&legacy).is_none(), "legacy 已废止：不再解码");
        assert!(verify(&issue(&seed, &legacy, "dGVzdA==", "手机·PWA", None)).is_err(), "legacy accountDid 委任状必须拒");
        // 非账号前缀拒收
        assert!(pubkey_from_did("did:web:ABC").is_none());
    }

    /// 2026-10-06 任务1：DID 互换收编投信箱的委任状=30 天 TTL + scopes="*" + d 前缀
    /// nonce——与手机端 identity.ts issueDelegationToDevice 逐字段对等（手机是参照实现，
    /// PC home 补的是同一条链路段②）。
    #[test]
    fn issue_with_ttl_30d_matches_phone_shape() {
        let (seed, soul) = soul();
        let d = issue_with_ttl(&seed, &soul, "dGVzdA==", "笔记本", None, DEVICE_DELIVER_TTL_MS, "d");
        assert_eq!(d.exp - d.issued_at, DEVICE_DELIVER_TTL_MS, "TTL 必须 30 天");
        assert_eq!(d.scopes, "*", "scopes 与手机端对等=不收窄");
        assert!(d.nonce.starts_with('d'), "nonce 前缀 d: {}", d.nonce);
        assert!(verify(&d).is_ok(), "30 天委任状应验证通过");
        // 投递体=/delegation/deliver 的 JSON——serde camelCase 字段名与手机端 body 契约一致
        let v = serde_json::to_value(&d).unwrap();
        for k in ["accountDid", "devicePubkeyB64", "deviceName", "scopes", "issuedAt", "exp", "nonce", "sigB64"] {
            assert!(v.get(k).is_some(), "投递体缺字段 {k}: {v}");
        }
    }

    /// 任务4：过期委任状 load 清理谓词——未吊销+已过期丢弃；吊销（即使也过期）保留
    /// （吊销注册表 revoked_pubkeys/停喂判定靠吊销记录，误清=被吊销设备复活）。
    #[test]
    fn keep_on_load_drops_expired_unrevoked_only() {
        let (seed, soul) = soul();
        let now = now_ms();
        let mut fresh = DelegationRecord { delegation: issue(&seed, &soul, "dGVzdA==", "手机", None), revoked: false, last_renewed: 0 };
        assert!(keep_on_load(&fresh, now), "新鲜委任状保留");
        fresh.delegation.exp = now - 1;
        assert!(!keep_on_load(&fresh, now), "过期未吊销丢弃");
        fresh.revoked = true;
        assert!(keep_on_load(&fresh, now), "吊销记录即使过期也保留（注册表语义）");
        // 边界：exp == now 视为过期（verify 同语义 now >= exp 拒）
        fresh.revoked = false;
        fresh.delegation.exp = now;
        assert!(!keep_on_load(&fresh, now), "exp==now 已过期");
    }

    /// 测试用隔离存储（绝不碰真实 config 目录——save() 写临时文件）。
    fn temp_store(tag: &str) -> Delegations {
        let p = std::env::temp_dir().join(format!("myco-deleg-test-{tag}-{}.json", now_ms()));
        let _ = std::fs::remove_file(&p);
        Delegations::load_at(p)
    }

    /// 任务2 接收侧：accept_received 落凭据 + has_valid_for 自查 +
    /// 同（账号,设备）重投原地替换（不攒重复行）。
    #[test]
    fn accept_received_and_has_valid_for() {
        let (seed, soul) = soul();
        let store = temp_store("accept");
        assert!(!store.has_valid_for(&soul, "dGVzdA=="), "空库无有效委任状");
        let d = issue_with_ttl(&seed, &soul, "dGVzdA==", "笔记本", None, DEVICE_DELIVER_TTL_MS, "d");
        store.accept_received(d.clone());
        assert!(store.has_valid_for(&soul, "dGVzdA=="), "收下后自查应命中");
        // 别的账号/别的设备钥不串
        assert!(!store.has_valid_for("did:youling:OtherTail", "dGVzdA=="));
        assert!(!store.has_valid_for(&soul, "b3RoZXI="));
        // 重投（新 nonce）原地替换——仍一条
        let d2 = issue_with_ttl(&seed, &soul, "dGVzdA==", "笔记本", None, DEVICE_DELIVER_TTL_MS, "d");
        store.accept_received(d2);
        assert_eq!(store.list().len(), 1, "同（账号,设备）重投应原地替换");
        // 过期委任状不算有效（verify 语义）
        let mut stale = d.clone();
        stale.exp = now_ms() + 1000; // 改 exp 签名即坏——双保险：验签失败也不算有效
        store.accept_received(stale);
        assert!(!store.has_valid_for(&soul, "dGVzdA=="), "篡改/过期委任状不算有效");
    }

    /// 任务1 本地留档：issue_for_with_ttl 与 issue_for 同语义（吊销拒签、同设备替换），
    /// 仅 TTL 可指。
    #[test]
    fn issue_for_with_ttl_honors_revoke_and_replace() {
        let (seed, soul) = soul();
        let store = temp_store("issue-ttl");
        let d = store
            .issue_for_with_ttl(&seed, &soul, "cHViQQ==", "笔记本", None, DEVICE_DELIVER_TTL_MS)
            .unwrap();
        assert_eq!(d.exp - d.issued_at, DEVICE_DELIVER_TTL_MS);
        assert_eq!(store.list().len(), 1);
        store.revoke("cHViQQ==");
        let e = store
            .issue_for_with_ttl(&seed, &soul, "cHViQQ==", "笔记本", None, DEVICE_DELIVER_TTL_MS)
            .unwrap_err();
        assert!(e.contains("吊销"), "已吊销设备拒签(停喂): {e}");
        // 未吊销设备重签=原地替换
        let _ = store.issue_for_with_ttl(&seed, &soul, "cHViQg==", "A", None, DEVICE_DELIVER_TTL_MS).unwrap();
        let _ = store.issue_for_with_ttl(&seed, &soul, "cHViQg==", "B", None, DEVICE_DELIVER_TTL_MS).unwrap();
        assert_eq!(store.list().iter().filter(|r| r.delegation.device_pubkey_b64 == "cHViQg==").count(), 1);
    }

    /// 2026-10-01 真 bug 回归：历史/手机端 delegations.json 的委任状字段名是
    /// `mycoDid`（env 时代 myco_did 的 camelCase），而本结构 serde 写读的是    /// `accountDid`——字段对不上时 Vec&lt;DelegationRecord&gt; 整体反序列化失败
    /// （.ok() 吞掉→空表），accounts_load_with_roles 分身判定恒 false。
    /// 修复=account_did 读侧 alias 双兼容（写出仍 accountDid，不迁移数据）。
    #[test]
    fn delegation_json_accepts_legacy_mycoDid_field() {
        // 1) mycoDid 单条记录反序列化出 account_did 正确
        let legacy = r#"{"delegation":{"mycoDid":"did:youling:TailA","devicePubkeyB64":"cHViQQ==","deviceName":"手机","scopes":"*","issuedAt":1,"exp":9,"nonce":"d1","sigB64":""},"revoked":false,"lastRenewed":0}"#;
        let rec: DelegationRecord = serde_json::from_str(legacy).expect("mycoDid 字段的委任状必须可反序列化");
        assert_eq!(rec.delegation.account_did, "did:youling:TailA");
        // 2) 混合数组（历史 mycoDid + 现行 accountDid）逐条存活——旧文件不毒化新记录
        let mixed = format!(
            "[{legacy},{}]",
            r#"{"delegation":{"accountDid":"did:youling:TailB","devicePubkeyB64":"cHViQg==","deviceName":"平板","scopes":"*","issuedAt":1,"exp":9,"nonce":"d2","sigB64":""},"revoked":false,"lastRenewed":0}"#
        );
        let recs: Vec<DelegationRecord> =
            serde_json::from_str(&mixed).expect("混合字段名数组必须整体可读（一损俱损曾致整文件丢弃）");
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].delegation.account_did, "did:youling:TailA");
        assert_eq!(recs[1].delegation.account_did, "did:youling:TailB");
        // 3) 写出端字段名不回归：序列化仍产 accountDid（alias 只影响读）
        let v = serde_json::to_value(&recs[1].delegation).unwrap();
        assert!(v.get("accountDid").is_some(), "写出应为 accountDid: {v}");
        assert!(v.get("mycoDid").is_none(), "写出不得退回 mycoDid: {v}");
        // 4) 出示编解码通道同样双收（X-Myco-Delegation 头走 base64(json)）
        let present = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD
                .encode(r#"{"mycoDid":"did:youling:TailA","devicePubkeyB64":"cHViQQ==","deviceName":"手机","scopes":"*","issuedAt":1,"exp":9,"nonce":"d1","sigB64":""}"#.as_bytes())
        };
        assert_eq!(decode_present(&present).map(|d| d.account_did).as_deref(), Some("did:youling:TailA"));
    }

    /// 2026-10-11 自动续约：is_due_renew_at 边界（可注入 now）——
    /// 20% 阈值线、24h 阈值线、恰好到期、已过期。与手机端 isDueRenew 同参语义。
    #[test]
    fn is_due_renew_at_boundaries() {
        let (seed, soul) = soul();
        let now = 1_790_000_000_000u64;
        // 30 天委任状（deliver 路径）：20% = 6 天
        let d30 = issue_with_ttl(&seed, &soul, "dGVzdA==", "本", None, DEVICE_DELIVER_TTL_MS, "d");
        assert!(!d30.is_due_renew_at(now), "刚签 30 天不该续");
        // 剩 6 天 + 1ms（> 20% 且 > 24h）→ 不续（平移窗口时保持原 ttl：issuedAt=exp-ttl）
        let mut just_ok = d30.clone();
        just_ok.exp = now + (DEVICE_DELIVER_TTL_MS / 5) + 1;
        just_ok.issued_at = just_ok.exp - DEVICE_DELIVER_TTL_MS;
        assert!(!just_ok.is_due_renew_at(now), "剩 >20% 不该续");
        // 剩恰好 20%（=6 天）→ 分支是严格大于，不续（开区间）
        let mut at_edge = d30.clone();
        at_edge.exp = now + DEVICE_DELIVER_TTL_MS / 5;
        at_edge.issued_at = at_edge.exp - DEVICE_DELIVER_TTL_MS;
        assert!(!at_edge.is_due_renew_at(now), "恰好 20% 不该续（严格大于）");
        // 剩 20% - 1ms → 续
        let mut below_edge = d30.clone();
        below_edge.exp = now + (DEVICE_DELIVER_TTL_MS / 5) - 1;
        below_edge.issued_at = below_edge.exp - DEVICE_DELIVER_TTL_MS;
        assert!(below_edge.is_due_renew_at(now), "剩 <20% 该续");
        // 剩 23h59m（< 24h）→ 续（即便 TTL 短、20% 分支不命中）
        let mut d2d = d30.clone();
        d2d.issued_at = now;
        d2d.exp = now + 2 * 24 * 3600 * 1000; // ttl=2 天，20%=9.6h<left
        let mut under24 = d2d.clone();
        under24.exp = now + RENEW_MIN_MS - 1;
        assert!(under24.is_due_renew_at(now), "剩 <24h 该续");
        // 剩恰好 24h：RENEW_MIN 分支不命中（严格小于），由 20% 分支决定（30 天的 20%=6 天>24h → 续）
        let mut at24 = d30.clone();
        at24.exp = now + RENEW_MIN_MS;
        at24.issued_at = at24.exp - DEVICE_DELIVER_TTL_MS; // ttl 仍 30 天
        assert!(at24.is_due_renew_at(now), "30 天状剩 24h：20% 分支命中该续");
        // 恰好到期 / 已过期 → 续（宽限重签语义；服务端宽限闸兜底）
        assert!(d30.is_expired_at(d30.exp), "now==exp 已过期");
        assert!(d30.is_due_renew_at(d30.exp), "恰好到期该续");
        assert!(d30.is_due_renew_at(d30.exp + 1000), "已过期该续（宽限重签）");
        assert!(!d30.is_expired_at(d30.exp - 1), "差 1ms 未过期");
    }

    /// ttl_ms：重签保持原 TTL 的取值源。
    #[test]
    fn ttl_ms_is_exp_minus_issued() {
        let (seed, soul) = soul();
        let d = issue_with_ttl(&seed, &soul, "dGVzdA==", "本", None, DEVICE_DELIVER_TTL_MS, "d");
        assert_eq!(d.ttl_ms(), DEVICE_DELIVER_TTL_MS);
        let mut weird = d.clone();
        weird.exp = weird.issued_at - 5; // 病态数据不得 panic（下溢饱和 0）
        assert_eq!(weird.ttl_ms(), 0);
    }

    /// read_records_raw_at：**不做**过期清理——过期/吊销/新鲜全量返回
    /// （Delegations::load 会把过期未吊销行清掉，宽限重签只能靠 raw 读）。
    #[test]
    fn read_records_raw_keeps_expired_rows() {
        let (seed, soul) = soul();
        let now = now_ms();
        let fresh = issue(&seed, &soul, "Zm9v", "新", None);
        let mut expired = issue(&seed, &soul, "YmFy", "旧", None);
        expired.exp = now - 1;
        let mut revoked = issue(&seed, &soul, "YmF6", "吊", None);
        revoked.exp = now - 1; // 过期且吊销——吊销注册表语义要留
        let recs = vec![
            DelegationRecord { delegation: fresh, revoked: false, last_renewed: 0 },
            DelegationRecord { delegation: expired, revoked: false, last_renewed: 0 },
            DelegationRecord { delegation: revoked, revoked: true, last_renewed: 0 },
        ];
        let dir = std::env::temp_dir().join(format!("myco-deleg-raw-{}-{}", std::process::id(), now));
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("delegations.json");
        std::fs::write(&p, serde_json::to_string(&recs).unwrap()).unwrap();
        let raw = read_records_raw_at(&p);
        assert_eq!(raw.len(), 3, "raw 读必须保留过期行（宽限重签窗口）: {raw:?}");
        // 对比：load_at 只清「过期且未吊销」一条（fresh 保留 + 吊销行保留=注册表语义）
        let loaded = Delegations::load_at(p.clone());
        assert_eq!(loaded.list().len(), 2, "load 清理后应剩 fresh+吊销两条");
        assert!(loaded.list().iter().all(|r| r.revoked || r.delegation.exp > now));
        // 缺文件/坏 JSON → 空（不 panic）
        assert!(read_records_raw_at(&dir.join("nope.json")).is_empty());
        std::fs::write(dir.join("bad.json"), "{ not json").unwrap();
        assert!(read_records_raw_at(&dir.join("bad.json")).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
