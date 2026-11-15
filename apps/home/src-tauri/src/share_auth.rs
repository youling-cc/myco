//! share_auth — DSH 分享网关的授权存储（从 apps/env 的 authorized.rs 抽取最小集）。
//!
//! 为什么在这里：env 的运行时已退役（第 63 轮起 home 不再拉起 myco-env），分享网关
//! 迁入 myco.exe（apps/home）。本模块只保留分享所需的：
//!   · 设备白名单 + task: scope 语法（分享即任务：shareId 就是 taskKey）
//!   · 读写分层（task:<k> / task:<proj>:* / task:*，各可带 :ro）
//!   · 例外优先（具体任务 > 项目通配 > 全局通配）
//!
//! 文件格式与 env 时代**完全一致**（`config_dir()/authorized-dids.json`，JSON 数组，
//! camelCase 字段），既有文件与既有授权零迁移直接可用。
//!
//! 与 env 版的差异（刻意简化）：不做 attest/委任状签发（那部分依赖 env 的 delegation
//! 栈）；DID 互换添加设备在这里退化为本地 upsert。

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

// ── scope 常量（对齐 env 的 authorized.rs，勿改语义）──
pub const SCOPE_ALL: &str = "*";
pub const SCOPE_TASK_PREFIX: &str = "task:";
pub const SCOPE_TASK_ALL: &str = "task:*";
pub const TASK_RO_SUFFIX: &str = ":ro";
pub const TASK_RW_SUFFIX: &str = ":rw";

fn default_scopes() -> Vec<String> {
    vec![SCOPE_ALL.to_string()]
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 解析单个任务 scope → (匹配目标, 只读?)。目标三态：
/// "*"（全部）| "<projKey>:*"（项目通配）| "<taskKey>"（单任务）。
fn parse_task_scope(s: &str) -> Option<(String, bool)> {
    let rest = s.strip_prefix(SCOPE_TASK_PREFIX)?;
    if rest.is_empty() {
        return None;
    }
    if let Some(core) = rest.strip_suffix(TASK_RO_SUFFIX) {
        if !core.is_empty() {
            return Some((core.to_string(), true));
        }
    }
    if let Some(core) = rest.strip_suffix(TASK_RW_SUFFIX) {
        if !core.is_empty() {
            return Some((core.to_string(), false));
        }
    }
    Some((rest.to_string(), false))
}

/// 任务 scope 判定核心。want_write=false=读（ro 或 rw 命中即可）；true=写（仅 rw）。
/// 例外优先：具体任务条目 > 项目通配 (proj:*) > 全局通配 (task:*)。
fn task_allows(scopes: &[String], task_key: &str, want_write: bool) -> bool {
    if scopes.iter().any(|s| s == SCOPE_ALL) {
        return true;
    }
    let proj_key = task_key.rsplit_once('-').map(|(p, _)| p).unwrap_or(task_key);
    let hit = |_target: String, ro: bool| if want_write { !ro } else { true };
    // ① 具体任务条目（最高优先）
    if let Some((_, ro)) = scopes
        .iter()
        .filter_map(|s| parse_task_scope(s))
        .find(|(t, _)| t == task_key)
    {
        return hit(task_key.to_string(), ro);
    }
    // ② 项目通配
    if let Some((_, ro)) = scopes
        .iter()
        .filter_map(|s| parse_task_scope(s))
        .find(|(t, _)| *t == format!("{}:*", proj_key))
    {
        return hit(proj_key.to_string(), ro);
    }
    // ③ 全局通配
    scopes
        .iter()
        .filter_map(|s| parse_task_scope(s))
        .any(|(t, ro)| t == "*" && (if want_write { !ro } else { true }))
}

/// 写判定：某 DID 能否**操作**某 taskKey（shareId）。
pub fn task_scopes_allow(scopes: &[String], task_key: &str) -> bool {
    task_allows(scopes, task_key, true)
}

/// 读判定：能否**查看**某 taskKey 的消息正文。ro 与 rw 命中都算能读。
pub fn task_scopes_allow_read(scopes: &[String], task_key: &str) -> bool {
    task_allows(scopes, task_key, false)
}

/// 提取任务 scope 子集（UI 展示用）。
pub fn task_scopes_of(scopes: &[String]) -> Vec<String> {
    scopes
        .iter()
        .filter(|s| s.starts_with(SCOPE_TASK_PREFIX))
        .cloned()
        .collect()
}

/// 作用域规整：去空、去重；含 "*" 或空列表 → ["*"]。
fn normalize_scopes(mut s: Vec<String>) -> Vec<String> {
    s.retain(|x| !x.trim().is_empty());
    s.sort();
    s.dedup();
    if s.is_empty() || s.iter().any(|x| x == SCOPE_ALL) {
        return vec![SCOPE_ALL.to_string()];
    }
    s
}

// ── 数据模型（与 env 的 authorized-dids.json 同 schema）──

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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedDevice {
    pub did: String,
    pub name: String,
    #[serde(default)]
    pub pubkey_b64: String,
    #[serde(default)]
    pub added_at: u64,
    #[serde(default)]
    pub last_seen: u64,
    #[serde(default)]
    pub last_addr: Option<String>,
    #[serde(default)]
    pub owner_root_did: Option<String>,
    #[serde(default)]
    pub auth_state: AuthState,
    #[serde(default)]
    pub client_ip: Option<String>,
    #[serde(default)]
    pub auth_expires_at: Option<u64>,
    #[serde(default = "default_scopes")]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub issued_by: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedRoot {
    pub root_did: String,
    pub name: String,
    #[serde(default)]
    pub added_at: u64,
    #[serde(default)]
    pub revoked: bool,
    #[serde(default)]
    pub note: String,
}

fn store_path() -> std::path::PathBuf {
    myco_core::config::config_dir().join("authorized-dids.json")
}

fn roots_path() -> std::path::PathBuf {
    myco_core::config::config_dir().join("trusted-roots.json")
}

/// 全局单例（进程内共享；网关与 Tauri 命令用同一份）
pub fn shared() -> std::sync::Arc<Authorized> {
    static S: std::sync::OnceLock<std::sync::Arc<Authorized>> = std::sync::OnceLock::new();
    S.get_or_init(|| std::sync::Arc::new(Authorized::load())).clone()
}

pub struct Authorized {
    devices: Mutex<Vec<AuthorizedDevice>>,
    roots: Mutex<Vec<TrustedRoot>>,
}

impl Authorized {
    pub fn load() -> Self {
        let devices = std::fs::read_to_string(store_path())
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<AuthorizedDevice>>(&s).ok())
            .unwrap_or_default();
        let roots = std::fs::read_to_string(roots_path())
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<TrustedRoot>>(&s).ok())
            .unwrap_or_default();
        Self { devices: Mutex::new(devices), roots: Mutex::new(roots) }
    }

    fn save(&self) {
        let devices = self.devices.lock().unwrap().clone();
        let path = store_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&devices).unwrap_or_default());
    }

    pub fn list(&self) -> Vec<AuthorizedDevice> {
        self.devices.lock().unwrap().clone()
    }

    pub fn list_roots(&self) -> Vec<TrustedRoot> {
        self.roots.lock().unwrap().clone()
    }

    pub fn scopes_of(&self, did: &str) -> Vec<String> {
        self.devices
            .lock()
            .unwrap()
            .iter()
            .find(|d| d.did == did)
            .map(|d| d.scopes.clone())
            .unwrap_or_default()
    }

    /// 闸门：该设备是否已放行（authState==Allowed 且限时未到期）
    pub fn is_allowed(&self, did: &str) -> bool {
        let devices = self.devices.lock().unwrap();
        devices.iter().any(|d| {
            d.did == did
                && d.auth_state == AuthState::Allowed
                && d.auth_expires_at.map_or(true, |exp| exp > now_ms())
        })
    }

    pub fn set_scopes(&self, did: &str, scopes: Vec<String>) -> bool {
        let mut devices = self.devices.lock().unwrap();
        if let Some(d) = devices.iter_mut().find(|d| d.did == did) {
            d.scopes = normalize_scopes(scopes);
            drop(devices);
            self.save();
            true
        } else {
            false
        }
    }

    // ── 2026-10-13：MycoDevices 管理面 8 命令的底座补齐（此前组件从 media 时代
    //    拷来而这些命令在 home 从未实现 → invoke 全部 unknown command 被静默吞，
    //    设备列表永远空 = 用户"PC 上看不到成员设备"）──

    /// 授权态 + 可选限时（回未授权即 Denied；None=不限期）。
    pub fn set_auth(&self, did: &str, allowed: bool, ttl_ms: Option<u64>) -> bool {
        let mut devices = self.devices.lock().unwrap();
        if let Some(d) = devices.iter_mut().find(|d| d.did == did) {
            d.auth_state = if allowed { AuthState::Allowed } else { AuthState::Denied };
            d.auth_expires_at = if allowed { ttl_ms.map(|t| now_ms() + t) } else { None };
            drop(devices);
            self.save();
            true
        } else {
            false
        }
    }

    /// 二次放行：Pending → Allowed（主设备在「新设备请求加入」卡点「✓ 确认授权」）。
    /// 与 core `Authorized::confirm_device` 同语义；限时授权到期时间清空（确认=不限期）。
    pub fn confirm_device(&self, did: &str) -> bool {
        let mut devices = self.devices.lock().unwrap();
        if let Some(d) = devices.iter_mut().find(|d| d.did == did) {
            d.auth_state = AuthState::Allowed;
            d.auth_expires_at = None;
            drop(devices);
            self.save();
            true
        } else {
            false
        }
    }

    /// 拒绝放行：**Pending → 移除**（可重新配对）；非 pending → 置 Denied（保留记录但拒用）。
    /// 与 core `Authorized::reject_device` 的文档语义一致（core 实现只做移除，这里按文档补齐分支）。
    pub fn reject_device(&self, did: &str) -> bool {
        let mut devices = self.devices.lock().unwrap();
        let Some(idx) = devices.iter().position(|d| d.did == did) else { return false };
        if devices[idx].auth_state == AuthState::Pending {
            devices.remove(idx);
        } else {
            devices[idx].auth_state = AuthState::Denied;
            devices[idx].auth_expires_at = None;
        }
        drop(devices);
        self.save();
        true
    }

    /// 按 origin 整组吊销（出生地分组的"整组移除"）：返回移除的设备数。
    pub fn remove_by_origin(&self, origin: &str) -> usize {
        let mut devices = self.devices.lock().unwrap();
        let before = devices.len();
        devices.retain(|d| d.origin.as_deref() != Some(origin));
        let removed = before - devices.len();
        if removed > 0 {
            drop(devices);
            self.save();
            return removed;
        }
        drop(devices);
        0
    }

    /// 重命名根账号（显示名，author_name_for 优先读它）。
    pub fn rename_root(&self, root_did: &str, name: &str) -> bool {
        let mut roots = self.roots.lock().unwrap();
        if let Some(r) = roots.iter_mut().find(|r| r.root_did == root_did) {
            r.name = name.to_string();
            drop(roots);
            self.save();
            true
        } else {
            false
        }
    }

    /// 根账号备注。
    pub fn set_root_note(&self, root_did: &str, note: &str) -> bool {
        let mut roots = self.roots.lock().unwrap();
        if let Some(r) = roots.iter_mut().find(|r| r.root_did == root_did) {
            r.note = note.to_string();
            drop(roots);
            self.save();
            true
        } else {
            false
        }
    }

    pub fn remove_device(&self, did: &str) -> bool {
        let mut devices = self.devices.lock().unwrap();
        let before = devices.len();
        devices.retain(|d| d.did != did);
        if devices.len() != before {
            drop(devices);
            self.save();
            true
        } else {
            false
        }
    }

    /// 重命名**本机白名单**设备（authorized-dids.json 里的显示名）。
    /// 注意语义边界：服务端名册只有 /root/device/{add,revoke,embodiment}，**没有 rename**，
    /// 所以这里改不动名册名（名册名以 myco_list_devices 为准），只影响本机白名单展示。
    pub fn rename_device(&self, did: &str, name: &str) -> bool {
        let mut devices = self.devices.lock().unwrap();
        if let Some(d) = devices.iter_mut().find(|d| d.did == did) {
            d.name = name.to_string();
            drop(devices);
            self.save();
            true
        } else {
            false
        }
    }

    pub fn collab_allows_task(&self, did: &str, task_key: &str) -> bool {
        self.collab_allows_task_impl(did, task_key, true)
    }

    pub fn collab_allows_task_read(&self, did: &str, task_key: &str) -> bool {
        self.collab_allows_task_impl(did, task_key, false)
    }

    fn collab_allows_task_impl(&self, did: &str, task_key: &str, want_write: bool) -> bool {
        let devs = self.devices.lock().unwrap();
        let Some(d) = devs.iter().find(|d| d.did == did) else { return false };
        if d.auth_state != AuthState::Allowed {
            return false;
        }
        if d.auth_expires_at.map_or(false, |exp| exp <= now_ms()) {
            return false;
        }
        task_allows(&d.scopes, task_key, want_write)
    }

    pub fn has_any_task_read(&self, did: &str) -> bool {
        let devs = self.devices.lock().unwrap();
        let Some(d) = devs.iter().find(|d| d.did == did) else { return false };
        d.auth_state == AuthState::Allowed && !task_scopes_of(&d.scopes).is_empty()
    }

    /// 连接身份 → 显示名：账号名（roots 缓存）优先，设备备注名兜底，再兜底 did 尾号。
    pub fn author_name_for(&self, did: &str) -> String {
        let devs = self.devices.lock().unwrap();
        if let Some(d) = devs.iter().find(|d| d.did == did) {
            if let Some(rdid) = &d.owner_root_did {
                let roots = self.roots.lock().unwrap();
                if let Some(r) = roots.iter().find(|r| r.root_did == *rdid && !r.name.is_empty()) {
                    return r.name.clone();
                }
            }
            if !d.name.is_empty() {
                return d.name.clone();
            }
        }
        format!("…{}", &did[did.len().saturating_sub(4)..])
    }

    /// **装饰性**名字同步：只更新**已存在**行的显示名，**绝不创建授权行**。
    ///
    /// 2026-11-15 事故（越权面 + 设备清不掉，两端实证）：
    /// 启动路径 `dsh_share::sync_device_names` 原用 `upsert_device(.., None, None, None)`
    /// 同步账号名册里的设备名——缺省 `allowed=None → unwrap_or(true)` + `scopes=None
    /// → ["*"]`，于是名册里**早已除名/换机的历史设备**在每次启动时被重新写成本机
    /// 全权放行（addedAt=lastSeen=启动那一秒）。用户清理白名单无效，且任何名册
    /// 设备都自动拿到 "*" 权限——这是授权面被装饰路径污染的典型。
    /// 现在：名字只在已有行上更新；返回是否命中（false = 不在白名单，不建）。
    pub fn cache_device_name(&self, did: &str, name: &str) -> bool {
        if name.trim().is_empty() {
            return false;
        }
        let mut devices = self.devices.lock().unwrap();
        let Some(d) = devices.iter_mut().find(|d| d.did == did) else {
            return false;
        };
        d.name = name.to_string();
        // 锁纪律（2026-11-15 实测自死锁）：save() 内部会再取 self.devices，
        // 必须先放锁再落盘——同本文件其它写方法（drop(devices); self.save();）。
        drop(devices);
        self.save();
        true
    }

    /// 本地 upsert 设备（分享授权用：不存在则建，存在则合并 scopes/归属）。
    pub fn upsert_device(
        &self,
        did: &str,
        name: &str,
        owner_root_did: Option<String>,
        allowed: Option<bool>,
        scopes: Option<Vec<String>>,
        origin: Option<String>,
    ) -> bool {
        let mut devices = self.devices.lock().unwrap();
        if let Some(d) = devices.iter_mut().find(|d| d.did == did) {
            if !name.is_empty() {
                d.name = name.to_string();
            }
            if let Some(r) = owner_root_did.clone() {
                // #9（多归属共识）：owner_root_did **空才回填**——与 core authorized.rs
                // 的 backfill_owner_root_did 同语义（两套注册表收敛到同一种），归属
                // 不得被后写者翻转（最后写入者决定归属 = 多归属下的串权面）。
                let empty = d.owner_root_did.as_deref().map(|o| o.trim().is_empty()).unwrap_or(true);
                if empty {
                    d.owner_root_did = Some(r);
                }
            }
            if let Some(a) = allowed {
                d.auth_state = if a { AuthState::Allowed } else { AuthState::Denied };
            }
            if let Some(s) = scopes.clone() {
                d.scopes = normalize_scopes(s);
            }
            if let Some(o) = origin.clone() {
                d.origin = Some(o);
            }
        } else {
            devices.push(AuthorizedDevice {
                did: did.to_string(),
                name: name.to_string(),
                pubkey_b64: String::new(),
                added_at: now_ms(),
                last_seen: now_ms(),
                last_addr: None,
                owner_root_did,
                // 2026-11-15 事故整改（同 `cache_device_name` 注释）：新建行的缺省
                // **不再是"Allowed + 全权"**——新设备必须显式放行/授权；缺省 =
                // Pending + 空 scope（等用户在设备列表点「放行」）。
                auth_state: match allowed {
                    Some(true) => AuthState::Allowed,
                    Some(false) => AuthState::Denied,
                    None => AuthState::Pending,
                },
                client_ip: None,
                auth_expires_at: None,
                scopes: match scopes {
                    Some(s) => normalize_scopes(s),
                    None => Vec::new(),
                },
                origin,
                issued_by: None,
            });
        }
        drop(devices);
        self.save();
        true
    }
}

/// DID 互换添加设备（分享场景的本地版）：加白名单 + 赋 scopes。
/// 与 env 版的差异：不签发委任状（env 的 delegation 栈随 env 退役）。
pub async fn add_device_by_did_impl(
    authz: &std::sync::Arc<Authorized>,
    runner_did: Option<String>,
    did: String,
    name: String,
    owner_root_did: Option<String>,
    allowed: Option<bool>,
    scopes: Option<Vec<String>>,
    origin: Option<String>,
) -> Result<(), String> {
    let _ = runner_did;
    authz.upsert_device(&did, &name, owner_root_did, allowed, scopes, origin);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn task_scope_allow_write_and_read() {
        let scopes = v(&["task:sh-1", "task:sh-2:ro"]);
        assert!(task_scopes_allow(&scopes, "sh-1"));
        assert!(task_scopes_allow_read(&scopes, "sh-1"));
        assert!(!task_scopes_allow(&scopes, "sh-2"));
        assert!(task_scopes_allow_read(&scopes, "sh-2"));
        assert!(!task_scopes_allow(&scopes, "sh-3"));
    }

    #[test]
    fn wildcard_and_grandfather() {
        let all = v(&["*"]);
        assert!(task_scopes_allow(&all, "sh-9"));
        assert!(task_scopes_allow_read(&all, "sh-9"));
        let t = v(&["task:*:ro"]);
        assert!(!task_scopes_allow(&t, "sh-9"));
        assert!(task_scopes_allow_read(&t, "sh-9"));
    }

    #[test]
    fn project_wildcard_and_exception_priority() {
        let scopes = v(&["task:proj-x:*", "task:proj-x-h1:ro"]);
        assert!(task_scopes_allow(&scopes, "proj-x-h2"));
        // 例外优先：具体条目收窄为 ro，不得被项目通配覆盖
        assert!(!task_scopes_allow(&scopes, "proj-x-h1"));
        assert!(task_scopes_allow_read(&scopes, "proj-x-h1"));
    }

    /// 2026-11-15 事故回归（设备清不掉 + 授权面被装饰路径污染）：
    /// 署名用的名字缓存**绝不创建授权行**；`upsert_device` 缺省不再自动 Allowed/["*"]。
    #[test]
    fn name_cache_never_creates_authorization_rows() {
        // 全局 env（MYCO_CONFIG_DIR）是进程级状态：与其它用例串行，避免并发污染。
        let _g = crate::test_env_lock::test_env_lock();
        let tmp = std::env::temp_dir().join(format!(
            "myco-share-auth-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&tmp).expect("建临时配置目录");
        std::env::set_var("MYCO_CONFIG_DIR", &tmp);

        let a = Authorized::load();
        assert!(a.list().is_empty(), "空目录起步");

        // ① 名册里存在但本机从未授权的设备：只尝试缓存名字 → 不建行
        assert!(
            !a.cache_device_name("did:myco:zHistoric", "历史设备"),
            "未授权设备不得因名字同步被创建"
        );
        assert!(a.list().is_empty(), "装饰性路径绝不产生授权行");

        // ② 显式 upsert 但缺省 allowed/scopes：必须 Pending + 空 scope（不再全权）
        a.upsert_device("did:myco:zNew", "新设备", None, None, None, None);
        let rows = a.list();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].auth_state, AuthState::Pending, "缺省不得自动放行");
        assert!(rows[0].scopes.is_empty(), "缺省不得自动给 *");

        // ③ 已存在行：放行后再改名字 → 授权状态与 scope 一字不动
        a.upsert_device(
            "did:myco:zNew",
            "新设备",
            None,
            Some(true),
            Some(v(&["*"])),
            None,
        );
        assert!(a.cache_device_name("did:myco:zNew", "改名后"));
        let rows = a.list();
        assert_eq!(rows[0].name, "改名后", "名字要更新");
        assert_eq!(rows[0].auth_state, AuthState::Allowed, "授权状态不许被改名动");
        assert_eq!(rows[0].scopes, v(&["*"]), "scope 不许被改名动");

        std::env::remove_var("MYCO_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}


// ── X-Myco-Auth 验签（2026-10-25 从 p2p_server::verify_auth 搬来的单一真源）──
// 为什么搬：CLI 变体（--no-default-features）不编译 p2p_server，但分享网关的
// claim 流（dsh_share）需要同一口径验签。纯 crypto（chrono/ed25519/base64 +
// axum HeaderMap），两变体都可编译；p2p_server 原函数改为薄委托。
pub(crate) const P2P_AUTH_WINDOW_MS: u64 = 60_000;

pub(crate) fn verify_p2p_auth(headers: &axum::http::HeaderMap, raw_body: &[u8]) -> Option<String> {
    use base64::Engine as _;
    use ed25519_dalek::Signature;
    use ed25519_dalek::VerifyingKey;
    let auth = headers.get("x-myco-auth")?.to_str().ok()?;
    let parts: Vec<&str> = auth.splitn(3, '.').collect();
    if parts.len() != 3 {
        return None;
    }
    let (did, ts_str, sig_b64) = (parts[0], parts[1], parts[2]);
    let ts: u64 = ts_str.parse().ok()?;
    let now = chrono::Utc::now().timestamp_millis() as u64;
    if now > ts + P2P_AUTH_WINDOW_MS || ts > now + P2P_AUTH_WINDOW_MS {
        return None;
    }
    let pubkey = myco_core::identity::did_pubkey_bytes(did)?;
    let body_str = std::str::from_utf8(raw_body).unwrap_or("");
    let msg = format!("{}\n{}\n{}", did, ts, body_str);
    let sig_bytes = base64::engine::general_purpose::STANDARD.decode(sig_b64).ok()?;
    if sig_bytes.len() != 64 {
        return None;
    }
    let sig = Signature::from_slice(&sig_bytes).ok()?;
    let vk = VerifyingKey::from_bytes(&pubkey).ok()?;
    use ed25519_dalek::Verifier as _;
    vk.verify(msg.as_bytes(), &sig).ok()?;
    Some(did.to_string())
}
