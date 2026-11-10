//! authorized.rs — direct_server 的设备授权白名单 + 配对（A+B）。
//!
//! 背景：direct_server 绑公网 IPv6+IPv4，DID 签名验签只证明"是某个合法注册 DID"，
//! 而注册是开放的 → 任何人注册个 DID 就能调 /rpc 控制 PC 的 claude 终端。
//! 本模块补上"授权"这一层：PC 只放行白名单里的 DID；新设备需配对（PC 端出码、手机输码）。
//!
//! 存储：%APPDATA%/myco/authorized-dids.json（devices: [{did,name,pubkeyB64,addedAt,lastSeen,lastAddr,revoked}]）
//! 配对：/pair/request 生成一次性 6 位码（只在 PC 本地显示，绝不经网络下发）；
//!       /pair/confirm 校验码 → 入白名单。短时过期 + 一次性，防爆破/防误批。

use crate::identity::did_equiv;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

/// 设备授权状态。DID 互换添加后 Pending（首连验签自动转正）→ Allowed / Denied。
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthState {
    Pending,
    Allowed,
    Denied,
}
impl Default for AuthState {
    fn default() -> Self {
        AuthState::Allowed
    }
}

/// v1 作用域常量(design/08-identity/TWO-LAYER-AGENT-AUTH.md §4):
/// "*"=全量(老条目祖父条款);desktop.view=远程桌面视频/连接;session.input=
/// 终端控制(rpc+DataChannel 打字);remote.out=本机作为 viewer 连出。
pub const SCOPE_ALL: &str = "*";
pub const SCOPE_DESKTOP_VIEW: &str = "desktop.view";
pub const SCOPE_SESSION_INPUT: &str = "session.input";
pub const SCOPE_REMOTE_OUT: &str = "remote.out";

fn default_scopes() -> Vec<String> {
    vec![SCOPE_ALL.to_string()]
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedDevice {
    pub did: String,
    pub name: String,
    pub pubkey_b64: String,
    pub added_at: u64,
    pub last_seen: u64,
    #[serde(default)]
    pub last_addr: Option<String>,
    /// 归属 Soul（attestation 抓取，用于按 Soul 分组）。None=未知/老设备待回填。
    #[serde(default)]
    pub owner_root_did: Option<String>,
    /// 授权状态：Pending(首连待验签)/Allowed/Denied。
    #[serde(default)]
    pub auth_state: AuthState,
    /// claim 时来源 IP（二次确认展示归属地）。
    #[serde(default)]
    pub client_ip: Option<String>,
    /// 限时授权的到期时刻 ms（None=不限期）。到期 is_allowed 自动回 Denied（不删除）。
    #[serde(default)]
    pub auth_expires_at: Option<u64>,
    /// 授权作用域列表。老条目缺省 ["*"]=全量(祖父条款,行为零变化)。
    #[serde(default = "default_scopes")]
    pub scopes: Vec<String>,
    /// 出生地标签(手机/本机/…)——分组吊销用(丢手机=一键清 origin 名下全部)。None=老条目未标。
    #[serde(default)]
    pub origin: Option<String>,
    /// 三层后门:签发者 DID(None=Soul 直发;v1 恒 None,防未来迁移才留字段)。
    #[serde(default)]
    pub issued_by: Option<String>,
}

/// 信任的根账号（外来 账号的本地名片）：name=别名、note=备注（只存本地）。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedRoot {
    pub root_did: String,
    pub name: String,
    pub added_at: u64,
    #[serde(default)]
    pub revoked: bool,
    #[serde(default)]
    pub note: String,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 作用域匹配:含 "*" 或命中目标 scope。
fn scopes_include(scopes: &[String], scope: &str) -> bool {
    scopes.iter().any(|s| s == SCOPE_ALL || s == scope)
}

/// 作用域规整:去空、去重;含 "*" 或空列表 → ["*"];顺序按常量表稳定。
fn normalize_scopes(mut s: Vec<String>) -> Vec<String> {
    s.retain(|x| !x.trim().is_empty());
    if s.is_empty() || s.iter().any(|x| x == SCOPE_ALL) {
        return vec![SCOPE_ALL.to_string()];
    }
    let order = [SCOPE_DESKTOP_VIEW, SCOPE_SESSION_INPUT, SCOPE_REMOTE_OUT];
    s.sort_by_key(|x| order.iter().position(|o| o == x).unwrap_or(99));
    s.dedup();
    s
}

/// 设备授权白名单 + 账号名片。配对方式 = 纯 DID 互换（砍掉全部配对码机制）：
/// PC「添加设备」= 粘贴/扫码设备 DID → 加白名单 Pending → 设备首连验签 → 自动 Allowed。
pub struct Authorized {
    devices: Mutex<Vec<AuthorizedDevice>>,
    roots: Mutex<Vec<TrustedRoot>>,
}

impl Authorized {
    pub fn load() -> Self {
        let path = store_path();
        let devices = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<AuthorizedDevice>>(&s).ok())
            .unwrap_or_default();
        let roots = std::fs::read_to_string(roots_path())
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<TrustedRoot>>(&s).ok())
            .unwrap_or_default();
        Self {
            devices: Mutex::new(devices),
            roots: Mutex::new(roots),
        }
    }

    fn save(&self) {
        let devices = self.devices.lock().unwrap().clone();
        let path = store_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&devices).unwrap_or_default());
    }

    fn save_roots(&self) {
        let roots = self.roots.lock().unwrap().clone();
        let path = roots_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&roots).unwrap_or_default());
    }

    /// 闸门：该设备是否已放行（authState==Allowed 且限时未到期）。
    /// 限时到期 → 惰性翻转回 Denied（不删除，记录还在可再开）+ 落盘。
    pub fn is_allowed(&self, did: &str) -> bool {
        let mut devices = self.devices.lock().unwrap();
        let mut expired = false;
        let ok = devices.iter().any(|d| {
            if !did_equiv(&d.did, did) || d.auth_state != AuthState::Allowed {
                return false;
            }
            if let Some(exp) = d.auth_expires_at {
                if now_ms() >= exp {
                    expired = true;
                    return false;
                }
            }
            true
        });
        if expired {
            if let Some(d) = devices.iter_mut().find(|d| did_equiv(&d.did, did)) {
                d.auth_state = AuthState::Denied;
                d.auth_expires_at = None;
            }
            drop(devices);
            self.save();
            return false;
        }
        ok
    }

    /// 闸门(带作用域):is_allowed ∧ scopes 含 scope(或 "*")。
    /// 老条目缺省 ["*"] 全量 → 与 is_allowed 等价(祖父条款)。
    pub fn is_allowed_for(&self, did: &str, scope: &str) -> bool {
        if !self.is_allowed(did) {
            return false;
        }
        self.devices
            .lock()
            .unwrap()
            .iter()
            .find(|d| did_equiv(&d.did, did))
            .map(|d| scopes_include(&d.scopes, scope))
            .unwrap_or(false)
    }

    /// 是否在白名单且 Pending（DID 刚添加，首连验签后自动转正）。
    pub fn is_pending(&self, did: &str) -> bool {
        self.devices.lock().unwrap().iter().any(|d| did_equiv(&d.did, did) && d.auth_state == AuthState::Pending)
    }

    pub fn list(&self) -> Vec<AuthorizedDevice> {
        self.devices.lock().unwrap().clone()
    }

    /// 设备上线/活动时刷新 last_seen/last_addr；若记录缺 ownerRootDid 而本次有，回填（解决老设备分组）。
    pub fn touch(&self, did: &str, addr: Option<String>, owner_root_did: Option<String>) {
        let mut devices = self.devices.lock().unwrap();
        if let Some(d) = devices.iter_mut().find(|d| did_equiv(&d.did, did)) {
            d.last_seen = now_ms();
            if addr.is_some() {
                d.last_addr = addr;
            }
            if d.owner_root_did.is_none() && owner_root_did.is_some() {
                d.owner_root_did = owner_root_did;
            }
            drop(devices);
            self.save();
        }
    }

    /// DID 互换添加设备：PC 粘贴/扫码设备 DID → 直接加白名单 Pending。
    /// 设备首连时验签通过（X-Myco-Auth 签名）→ is_allowed 调 confirm_device 自动转 Allowed。
    /// 已存在则更新名字/公钥/重置 Pending（换机后重新添加同一 DID 的场景）。
    /// 回填归属 Soul（attest 到本 账号名册后调用）：owner_root_did 为空才写，不覆盖既有归属。
    pub fn backfill_owner_root_did(&self, did: &str, root_did: &str) {
        let mut devices = self.devices.lock().unwrap();
        if let Some(d) = devices.iter_mut().find(|d| did_equiv(&d.did, did)) {
            if d.owner_root_did.is_none() {
                d.owner_root_did = Some(root_did.to_string());
                drop(devices);
                self.save();
            }
        }
    }

    pub fn add_device_by_did(&self, did: &str, name: &str, pubkey_b64: &str, owner_root_did: Option<String>, verified: bool, scopes: Option<Vec<String>>, origin: Option<String>) -> bool {
        let mut devices = self.devices.lock().unwrap();
        // verified=true（pair 申请已经设备钥签名证明持有）→ 直接 Allowed，不再等首连转正
        let initial = if verified { AuthState::Allowed } else { AuthState::Pending };
        if let Some(d) = devices.iter_mut().find(|d| did_equiv(&d.did, did)) {
            d.auth_state = initial;
            d.last_seen = now_ms();
            if !name.is_empty() { d.name = name.to_string(); }
            if !pubkey_b64.is_empty() { d.pubkey_b64 = pubkey_b64.to_string(); }
            if d.owner_root_did.is_none() { d.owner_root_did = owner_root_did.clone(); }
            if let Some(s) = scopes { d.scopes = normalize_scopes(s); }
            if origin.is_some() { d.origin = origin; }
        } else {
            devices.push(AuthorizedDevice {
                did: did.to_string(),
                name: if name.is_empty() { "未命名设备".into() } else { name.to_string() },
                pubkey_b64: if pubkey_b64.is_empty() { String::new() } else { pubkey_b64.to_string() },
                added_at: now_ms(),
                last_seen: 0,
                last_addr: None,
                owner_root_did,
                auth_state: initial,
                client_ip: None,
                auth_expires_at: None,
                scopes: normalize_scopes(scopes.unwrap_or_else(default_scopes)),
                origin,
                issued_by: None,
            });
        }
        drop(devices);
        self.save();
        tracing::info!("[authorized] DID 添加设备: {} ({})", &did[..did.len().min(24)], name);
        true
    }

    /// 设置作用域(覆盖式;空列表按 ["*"] 全量处理)。
    pub fn set_scopes(&self, did: &str, scopes: Vec<String>) -> bool {
        let mut devices = self.devices.lock().unwrap();
        if let Some(d) = devices.iter_mut().find(|d| did_equiv(&d.did, did)) {
            d.scopes = normalize_scopes(scopes);
            drop(devices);
            self.save();
            true
        } else {
            false
        }
    }

    /// 按 origin 批量吊销(丢设备一键清):该标签名下全部条目 → Denied。返回吊销条数。
    pub fn revoke_origin(&self, origin: &str) -> usize {
        let mut devices = self.devices.lock().unwrap();
        let n = devices
            .iter_mut()
            .filter(|d| d.origin.as_deref() == Some(origin) && d.auth_state == AuthState::Allowed)
            .map(|d| {
                d.auth_state = AuthState::Denied;
                d
            })
            .count();
        if n > 0 {
            drop(devices);
            self.save();
            tracing::info!("[authorized] 按 origin 批量吊销: {origin} ×{n}");
        }
        n
    }


    /// 二次放行：Pending → Allowed（主设备在 UI 点"放行"）。
    pub fn confirm_device(&self, did: &str) -> bool {
        let mut devices = self.devices.lock().unwrap();
        if let Some(d) = devices.iter_mut().find(|d| did_equiv(&d.did, did)) {
            d.auth_state = AuthState::Allowed;
            drop(devices);
            self.save();
            true
        } else {
            false
        }
    }

    /// 拒绝放行：Pending → 移除（可重新配对）；已存在非 pending → Denied。
    pub fn reject_device(&self, did: &str) -> bool {
        let mut devices = self.devices.lock().unwrap();
        let existed = devices.iter().any(|d| did_equiv(&d.did, did));
        if !existed {
            return false;
        }
        devices.retain(|d| !did_equiv(&d.did, did));
        drop(devices);
        self.save();
        true
    }

    /// 开关：Allowed ↔ Denied（已分组设备的即时授权开关）。
    /// 开启时可带 ttl_ms（半小时/1小时/24小时/自定义）→ 到期 is_allowed 自动回 Denied（不删除）。
    pub fn set_device_auth(&self, did: &str, allowed: bool, ttl_ms: Option<u64>) -> bool {
        let mut devices = self.devices.lock().unwrap();
        if let Some(d) = devices.iter_mut().find(|d| did_equiv(&d.did, did)) {
            d.auth_state = if allowed { AuthState::Allowed } else { AuthState::Denied };
            d.auth_expires_at = if allowed { ttl_ms.map(|t| now_ms() + t) } else { None };
            drop(devices);
            self.save();
            true
        } else {
            false
        }
    }

    /// 删除设备记录（整个移除，可重新配对；区别于 Denied=禁用但保留）。
    pub fn remove_device(&self, did: &str) -> bool {
        let mut devices = self.devices.lock().unwrap();
        let before = devices.len();
        devices.retain(|d| !did_equiv(&d.did, did));
        if devices.len() != before {
            drop(devices);
            self.save();
            true
        } else {
            false
        }
    }

    /// 吊销（= 设为 Denied）。
    pub fn revoke(&self, did: &str) -> bool {
        self.set_device_auth(did, false, None)
    }

    /// 直接授权一台设备为 Allowed（用于 Soul-join 批准时顺带给连接权限——
    /// 能被具身批准加入 Soul = 更强信任，理应能连这台具身 PC）。已存在则改 Allowed。
    pub fn grant(&self, did: &str, name: &str, pubkey_b64: &str, owner_root_did: Option<String>) {
        let mut devices = self.devices.lock().unwrap();
        if let Some(d) = devices.iter_mut().find(|d| did_equiv(&d.did, did)) {
            d.auth_state = AuthState::Allowed;
            if !name.is_empty() { d.name = name.to_string(); }
            if d.owner_root_did.is_none() { d.owner_root_did = owner_root_did.clone(); }
        } else {
            devices.push(AuthorizedDevice {
                did: did.to_string(),
                name: if name.is_empty() { "未命名设备".into() } else { name.to_string() },
                pubkey_b64: pubkey_b64.to_string(),
                added_at: now_ms(),
                last_seen: 0,
                last_addr: None,
                owner_root_did,
                auth_state: AuthState::Allowed,
                client_ip: None,
                auth_expires_at: None,
                scopes: default_scopes(),
                origin: None,
                issued_by: None,
            });
        }
        drop(devices);
        self.save();
    }

    /// 改设备别名。
    pub fn rename(&self, did: &str, name: &str) -> bool {
        let mut devices = self.devices.lock().unwrap();
        if let Some(d) = devices.iter_mut().find(|d| did_equiv(&d.did, did)) {
            d.name = name.to_string();
            drop(devices);
            self.save();
            true
        } else {
            false
        }
    }

// ══ 按根信任（attestation 模型）══

    /// 根是否在信任列表（未吊销）。
    pub fn is_root_trusted(&self, root_did: &str) -> bool {
        self.roots.lock().unwrap().iter().any(|r| did_equiv(&r.root_did, root_did) && !r.revoked)
    }

    pub fn list_roots(&self) -> Vec<TrustedRoot> {
        self.roots.lock().unwrap().clone()
    }

    /// 连接身份 → 聊天作者显示名：归属 账号名（roots 缓存/云解析回填）优先，
    /// 设备备注名兜底，再兜底 did 尾号。用于 input/image 注入的"谁说的"归属。
    pub fn author_name_for(&self, did: &str) -> String {
        let devs = self.devices.lock().unwrap();
        if let Some(d) = devs.iter().find(|d| did_equiv(&d.did, did)) {
            if let Some(rdid) = &d.owner_root_did {
                let roots = self.roots.lock().unwrap();
                if let Some(r) = roots.iter().find(|r| did_equiv(&r.root_did, rdid) && !r.name.is_empty()) {
                    return r.name.clone();
                }
            }
            if !d.name.is_empty() {
                return d.name.clone();
            }
        }
        format!("…{}", &did[did.len().saturating_sub(4)..])
    }

    /// 信任一个根（配对根账号时调用）。
    pub fn trust_root(&self, root_did: &str, name: &str) {
        let mut roots = self.roots.lock().unwrap();
        if let Some(r) = roots.iter_mut().find(|r| did_equiv(&r.root_did, root_did)) {
            r.revoked = false;
            r.name = name.to_string();
        } else {
            roots.push(TrustedRoot { root_did: root_did.to_string(), name: name.to_string(), added_at: now_ms(), revoked: false, note: String::new() });
        }
        drop(roots);
        self.save_roots();
    }

    /// 吊销根（其下所有设备钥不再可信）。
    pub fn revoke_root(&self, root_did: &str) -> bool {
        let mut roots = self.roots.lock().unwrap();
        if let Some(r) = roots.iter_mut().find(|r| did_equiv(&r.root_did, root_did)) {
            r.revoked = true;
            drop(roots);
            self.save_roots();
            true
        } else {
            false
        }
    }

    /// 改信任根的备注名（好友列表式标注——信任的是 Soul，名字只是本地好认）。
    pub fn rename_root(&self, root_did: &str, name: &str) -> bool {
        let mut roots = self.roots.lock().unwrap();
        if let Some(r) = roots.iter_mut().find(|r| did_equiv(&r.root_did, root_did)) {
            r.name = name.to_string();
            drop(roots);
            self.save_roots();
            true
        } else {
            false
        }
    }

    /// 改外来 账号的本地备注（只存本机 trusted-roots.json，不上云）。
    pub fn set_root_note(&self, root_did: &str, note: &str) -> bool {
        let mut roots = self.roots.lock().unwrap();
        if let Some(r) = roots.iter_mut().find(|r| did_equiv(&r.root_did, root_did)) {
            r.note = note.to_string();
            drop(roots);
            self.save_roots();
            true
        } else {
            false
        }
    }

    /// 缓存云解析回来的 账号名：只在本地没名字时填（不覆盖用户手动备注）。
    /// 注意：仅为"名字缓存"新建条目，不表示信任决策（授权闸门只看设备 authState）。
    pub fn cache_root_name(&self, root_did: &str, name: &str) {
        if name.is_empty() {
            return;
        }
        let mut roots = self.roots.lock().unwrap();
        if let Some(r) = roots.iter_mut().find(|r| did_equiv(&r.root_did, root_did)) {
            if r.name.is_empty() {
                r.name = name.to_string();
            } else {
                return; // 已有名（用户备注）→ 不动
            }
        } else {
            roots.push(TrustedRoot { root_did: root_did.to_string(), name: name.to_string(), added_at: now_ms(), revoked: false, note: String::new() });
        }
        drop(roots);
        self.save_roots();
    }


}

fn store_path() -> std::path::PathBuf {
    crate::config::config_dir().join("authorized-dids.json")
}

fn roots_path() -> std::path::PathBuf {
    crate::config::config_dir().join("trusted-roots.json")
}

// ══ Tauri 命令（canvas UI 设备管理页用）══

/// DID 互换添加设备：粘贴设备 DID → 加白名单 Pending + 自动 attest 到 账号名册（一步完成）。
/// 公钥从 DID 派生（base58 解码），不需要单独传入。
/// 返回 {ok, delegation?}:本机 myco 账号在线时顺签 7 天委任状回发(手机无感收下)。
pub async fn add_device_by_did(
    authorized: &std::sync::Arc<Authorized>,
    delegations: Option<&std::sync::Arc<crate::delegation::Delegations>>,
    did: String, name: String, owner_root_did: Option<String>, verified: Option<bool>,
    scopes: Option<Vec<String>>, origin: Option<String>,
) -> Result<serde_json::Value, String> {
    add_device_by_did_impl(authorized, delegations, did, name, owner_root_did, verified, scopes, origin).await
}

/// 设备 did → 裸公钥 base64（服务端 `/root/device/*` 的 `pubkeyB64` 列形态）。
/// **canonical-only 单一真源** = [`crate::identity::did_pubkey_bytes`]：解不出（legacy 已废止 /
/// 软 did / 畸形载荷）→ 空串。
///
/// 2026-10-10 修（主 agent 点名补的漏网点）：此处原为**手写 legacy-only 解码**
/// （`strip_prefix("did:myco:")` + 裸 base58 32B）——canonical 设备 did（`did:myco:z…`）尾段
/// 是 34B multibase，解不出 32B → `pubkey_b64` 恒空 → 下方委任状签发分支（`:557` 起）与
/// attest 分支被**静默跳过**（配对"成功"但拿不到委任状/名册）。
pub(crate) fn device_pubkey_b64_from_did(did: &str) -> String {
    use base64::Engine as _;
    crate::identity::did_pubkey_bytes(did)
        .map(|pk| base64::engine::general_purpose::STANDARD.encode(pk))
        .unwrap_or_default()
}

/// HTTP 路由复用体(home 窗数据面,无 tauri::State)。
pub async fn add_device_by_did_impl(
    auth: &std::sync::Arc<Authorized>,
    delegations: Option<&std::sync::Arc<crate::delegation::Delegations>>,
    did: String, name: String, owner_root_did: Option<String>, verified: Option<bool>,
    scopes: Option<Vec<String>>, origin: Option<String>,
) -> Result<serde_json::Value, String> {
    use base64::Engine as _;
    let pubkey_b64 = device_pubkey_b64_from_did(&did);

    auth.add_device_by_did(&did, &name, &pubkey_b64, owner_root_did, verified.unwrap_or(false), scopes, origin);

    // myco 账号模型(2026-08-25):本机 账号在线 → 顺签 7 天委任状随响应回发。
    // 在 attest 之前独立执行(委任状只依赖本机公章,名册服务不可达也照发)。
    let mut delegation_out: Option<crate::delegation::Delegation> = None;
    if let (Some(dels), Some(_root_seed), Some(root_did)) =
        (delegations, crate::identity::cached_account_seed(), crate::identity::account_did())
    {
        if !pubkey_b64.is_empty() {
            match dels.issue_for(&_root_seed, &root_did, &pubkey_b64, &name, None) {
                Ok(d) => {
                    tracing::info!("[authorized] 委任状随配对回发: {} …{}", &root_did[..root_did.len().min(20)], &pubkey_b64[pubkey_b64.len().saturating_sub(6)..]);
                    delegation_out = Some(d);
                }
                Err(e) => tracing::warn!("[authorized] 委任状签发失败(不挡配对): {e}"),
            }
        }
    }

    // 有 账号根钥 → attest 到 账号名册（加白名单 + Soul 身份一步完成，不需要加入码）
    if let (Some(root_seed), Some(root_did)) = (crate::identity::cached_account_seed(), crate::identity::account_did()) {
        let myco_signing = ed25519_dalek::SigningKey::from_bytes(&root_seed);
        use ed25519_dalek::Signer as _;
        let issued_at = now_ms();
        let attest_msg = format!("attest\n{root_did}\n{pubkey_b64}\n{issued_at}");
        let attest_sig = base64::engine::general_purpose::STANDARD.encode(myco_signing.sign(attest_msg.as_bytes()).to_bytes());
        let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
        let r = http.post(format!("{}/root/device/add", crate::identity::base_url()))
            .json(&serde_json::json!({ "rootDid": root_did, "pubkeyB64": pubkey_b64, "name": name, "issuedAt": issued_at, "attestSigB64": attest_sig, "rootSig": attest_sig }))
            .send().await.map_err(|e| format!("attest: {e}"))?;
        if r.status().is_success() {
            // attest 到本 账号名册的设备：归属就是本 Soul——回填 owner_root_did，
            // 否则分组落到"未分组"（PC浏览器 扫本机邀请码入册的场景）。
            auth.backfill_owner_root_did(&did, &root_did);
            tracing::info!("[authorized] DID 添加 + Soul attest 完成: {}", &did[..did.len().min(24)]);
        } else {
            tracing::warn!("[authorized] Soul attest 失败 status={}（白名单已加，仅 账号名册未更新）", r.status());
        }
    }

    Ok(serde_json::json!({ "ok": true, "delegation": delegation_out }))
}

/// 从 账号名册除名（revoke attestation）：账号根钥签 `revoke\nrootDid\npubkeyB64` → /root/device/revoke。
/// 与 add_device_by_did 的 attest 对应——加入时名册+白名单都写，除名时也可一起吊销身份。
/// 本机须持 账号根钥（是主设备）；只吊销名册，本机白名单删不删由 UI 另行决定（一般同时删）。
pub async fn revoke_roster_device(pubkey_b64: String) -> Result<bool, String> {
    use base64::Engine as _;
    let (root_seed, root_did) = match (crate::identity::cached_account_seed(), crate::identity::account_did()) {
        (Some(s), Some(d)) => (s, d),
        _ => return Err("本机未持有 账号钥（不是主设备，无权除名）".to_string()),
    };
    let myco_signing = ed25519_dalek::SigningKey::from_bytes(&root_seed);
    use ed25519_dalek::Signer as _;
    let revoke_msg = format!("revoke\n{root_did}\n{pubkey_b64}");
    let root_sig = base64::engine::general_purpose::STANDARD.encode(myco_signing.sign(revoke_msg.as_bytes()).to_bytes());
    let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
    let r = http.post(format!("{}/root/device/revoke", crate::identity::base_url()))
        .json(&serde_json::json!({ "rootDid": root_did, "pubkeyB64": pubkey_b64, "rootSig": root_sig }))
        .send().await.map_err(|e| format!("revoke: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("名册除名失败 status={}", r.status()));
    }
    tracing::info!("[authorized] 账号名册除名完成 pubkey=…{}", &pubkey_b64[pubkey_b64.len().saturating_sub(8)..]);
    Ok(true)
}

/// 已授权设备列表。
pub fn list_authorized_devices(authorized: &std::sync::Arc<Authorized>) -> Vec<AuthorizedDevice> {
    authorized.list()
}

/// 待定配对请求（含一次性码，PC 本地显示给用户输到手机）。
/// 拒绝某个待定配对。
/// 吊销设备（踢出白名单）。
pub fn revoke_authorized_device(authorized: &std::sync::Arc<Authorized>, did: String) -> bool {
    authorized.revoke(&did)
}

/// 恢复被吊销的设备（重新放行 = Allowed）。
pub fn unrevoke_authorized_device(authorized: &std::sync::Arc<Authorized>, did: String) -> bool {
    authorized.set_device_auth(&did, true, None)
}

/// 二次放行：Pending → Allowed（主设备在 Myco 列点"放行"）。
pub fn confirm_device(authorized: &std::sync::Arc<Authorized>, did: String) -> bool {
    authorized.confirm_device(&did)
}

/// 拒绝放行：Pending → 移除。
pub fn reject_device(authorized: &std::sync::Arc<Authorized>, did: String) -> bool {
    authorized.reject_device(&did)
}

/// 即时授权开关：Allowed ↔ Denied。开启可带 ttlMs（限时授权，到期自动回 Denied 不删除）。
pub fn set_device_auth(authorized: &std::sync::Arc<Authorized>, did: String, allowed: bool, ttl_ms: Option<u64>) -> bool {
    authorized.set_device_auth(&did, allowed, ttl_ms)
}

/// 设置某 agent 的作用域(覆盖式;空=全量 ["*"])。
pub fn set_device_scopes(authorized: &std::sync::Arc<Authorized>, did: String, scopes: Vec<String>) -> bool {
    authorized.set_scopes(&did, scopes)
}

/// 按 origin 批量吊销(丢设备一键清该标签名下全部 agent)。返回吊销条数。
pub fn revoke_origin(authorized: &std::sync::Arc<Authorized>, origin: String) -> usize {
    authorized.revoke_origin(&origin)
}

/// 删除设备记录（整个移除，可重新配对）。
pub fn remove_authorized_device(authorized: &std::sync::Arc<Authorized>, did: String) -> bool {
    authorized.remove_device(&did)
}

/// 发起重连：老设备记录生成换绑码（PC 屏幕出示，手机清缓存换新钥匙后输码换回）。
/// 取消重连会话。
/// 改设备别名。
pub fn rename_authorized_device(authorized: &std::sync::Arc<Authorized>, did: String, name: String) -> bool {
    authorized.rename(&did, &name)
}

// ══ 按根信任（attestation 模型）的 Tauri 命令 ══

/// 信任的根账号列表。
pub fn list_trusted_roots(authorized: &std::sync::Arc<Authorized>) -> Vec<TrustedRoot> {
    authorized.list_roots()
}

/// 待定根配对（含一次性码，PC 本地显示给用户输到设备）。
/// 拒绝某个待定根配对。
/// 吊销根（其下设备钥不再可信）。
pub fn revoke_trusted_root(authorized: &std::sync::Arc<Authorized>, root_did: String) -> bool {
    authorized.revoke_root(&root_did)
}

/// 改信任根的备注名（好友列表式标注）。
pub fn rename_trusted_root(authorized: &std::sync::Arc<Authorized>, root_did: String, name: String) -> bool {
    authorized.rename_root(&root_did, &name)
}

/// 改外来 账号的本地备注（别名之外的补充信息，只存本机）。
pub fn set_root_note(authorized: &std::sync::Arc<Authorized>, root_did: String, note: String) -> bool {
    authorized.set_root_note(&root_did, &note)
}

/// 解析 账号名（Myco 分组头用）：本地 roots 缓存有名直接用；没名的查云
/// GET /root/:did → name 回写缓存（不覆盖用户手动备注）。离线/查不到就跳过（UI 退显示 Soul …尾号）。
pub async fn resolve_account_names(
    authorized: &std::sync::Arc<Authorized>,
    root_dids: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    resolve_account_names_impl(authorized, root_dids).await
}

/// HTTP 路由复用体(home 窗数据面,无 tauri::State)。
pub async fn resolve_account_names_impl(
    auth: &std::sync::Arc<Authorized>,
    root_dids: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let mut out = std::collections::HashMap::new();
    let mut unknown = vec![];
    for d in root_dids {
        let local = auth.list_roots().into_iter().find(|r| r.root_did == d && !r.name.is_empty());
        if let Some(r) = local {
            out.insert(d, r.name);
        } else {
            unknown.push(d);
        }
    }
    for d in unknown {
        // did 是 base58（URL 安全字符），无需编码
        let url = format!("{}/root/{}", crate::identity::base_url(), d);
        let Ok(resp) = reqwest::get(&url).await else { continue };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(v) = resp.json::<serde_json::Value>().await else { continue };
        let name = v
            .pointer("/data/name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string();
        if !name.is_empty() {
            auth.cache_root_name(&d, &name);
            out.insert(d, name);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod scope_tests {
    use super::*;

    fn v(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    /// 设备 did → pubkeyB64：canonical 必解（2026-10-10 修，此前手写 legacy-only 解码把
    /// canonical 静默解成空串 → 委任状/attest 分支被跳过）；legacy 已废止 → 空串。
    #[test]
    fn device_pubkey_b64_from_canonical_did_only() {
        use base64::Engine as _;
        let key = [0x5au8; 32];
        let want = base64::engine::general_purpose::STANDARD.encode(key);
        let myco_canonical = crate::identity::did_from_public(&key);
        assert_eq!(device_pubkey_b64_from_did(&myco_canonical), want, "canonical 设备 did 必须解出 pubkeyB64");
        // did:youling: canonical 同规（同一把钥匙另一 method 写法）
        let youling_canonical = format!("did:youling:{}", myco_canonical.strip_prefix("did:myco:").unwrap());
        assert_eq!(device_pubkey_b64_from_did(&youling_canonical), want);
        // legacy（裸 base58 32B）已废止 → 空串（不再解出）
        let legacy = format!("did:myco:{}", bs58::encode(key).into_string());
        assert_eq!(device_pubkey_b64_from_did(&legacy), "");
        assert_eq!(device_pubkey_b64_from_did("did:myco:participant:x"), "");
        assert_eq!(device_pubkey_b64_from_did(""), "");
    }

    /// 祖父条款:老 JSON(无 scopes/origin/issuedBy 字段)反序列化 → 全量+null 标签。
    #[test]
    fn legacy_entry_deserializes_to_full_scope() {
        let old = r#"{"did":"did:myco:x","name":"n","pubkeyB64":"k","addedAt":1,"lastSeen":2}"#;
        let d: AuthorizedDevice = serde_json::from_str(old).unwrap();
        assert_eq!(d.scopes, vec!["*".to_string()]);
        assert!(d.origin.is_none());
        assert!(d.issued_by.is_none());
    }

    #[test]
    fn normalize_orders_and_dedups() {
        assert_eq!(normalize_scopes(v(&[])), v(&["*"]));
        assert_eq!(normalize_scopes(v(&["*"])), v(&["*"]));
        // 含 * → 全量
        assert_eq!(normalize_scopes(v(&["session.input", "*"])), v(&["*"]));
        // 稳定排序(常量表序)+去重 + 去空
        assert_eq!(
            normalize_scopes(v(&["remote.out", "session.input", "session.input", " "])),
            v(&["session.input", "remote.out"])
        );
        // 未知 scope 保留(排尾),不误删——前向兼容
        assert_eq!(
            normalize_scopes(v(&["future.scope", "desktop.view"])),
            v(&["desktop.view", "future.scope"])
        );
    }

    #[test]
    fn scopes_include_semantics() {
        assert!(scopes_include(&v(&["*"]), SCOPE_DESKTOP_VIEW));
        assert!(scopes_include(&v(&["desktop.view"]), SCOPE_DESKTOP_VIEW));
        assert!(!scopes_include(&v(&["desktop.view"]), SCOPE_SESSION_INPUT));
        assert!(!scopes_include(&v(&["remote.out"]), SCOPE_SESSION_INPUT));
    }

    /// 作用域切换规则(与前端 toggleScope 同一套约定,两端必须一致)。
    #[test]
    fn toggle_semantics_match_frontend() {
        // 全量态点具体项 → 只留该项
        assert_eq!(normalize_scopes(v(&["desktop.view"])), v(&["desktop.view"]));
        // 取消最后一项 → 回全量
        assert_eq!(normalize_scopes(v(&[])), v(&["*"]));
    }
}
