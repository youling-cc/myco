//! Persistent app config directory + one-time migration off the temp dir.
//!
//! Historically both provider tokens and recent paths were written into
//! `std::env::temp_dir()` — which is cleared on reboot / disk-cleanup and is
//! world-readable on shared machines (bad for plaintext auth tokens). Config
//! now lives in a per-user config dir (`%APPDATA%\myco` on Windows,
//! `~/.config/myco` elsewhere). On first use we migrate any legacy temp file
//! over so existing installs don't lose their providers/paths.

use std::path::PathBuf;

/// The persistent config directory for this app. Created on demand.
/// MYCO_CONFIG_DIR 覆盖(环境分离,2026-08-30):dev 实例设独立目录,与生产
/// %APPDATA%\youling 隔离——dev 的 formation/注册表/配置写不进生产,反之亦然。
///
/// 数据目录 v2（第66轮存储收敛,2026-09-21）：`%APPDATA%\youling`——登录器专属,
/// 与老 myco 家族(`%APPDATA%\myco`,两产品历史上共居)和 env 时代残留
/// (`%APPDATA%\youling-myco`)彻底分家。首访自动收编 myco\ 下的身份文件
/// （copy 不 move——老产品不动）,并同步去历史包袱名（iroh-secret.dpapi→device.key,
/// myco-accounts.json→accounts.json,myco-identity-session.json→session.json）。
pub fn config_dir() -> PathBuf {
    if let Ok(d) = std::env::var("MYCO_CONFIG_DIR") {
        if !d.trim().is_empty() {
            let dir = PathBuf::from(d);
            let _ = std::fs::create_dir_all(&dir);
            return dir;
        }
    }
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .or_else(|_| {
            std::env::var("HOME")
                .map(|h| PathBuf::from(h).join(".config"))
        })
        .unwrap_or_else(|_| std::env::temp_dir());
    let dir = base.join("youling");
    // Best-effort create; callers handle IO errors on the actual file write.
    let _ = std::fs::create_dir_all(&dir);
    migrate_legacy_myco_dir(&base);
    dir
}

/// 老目录(%APPDATA%\myco)身份文件 → youling\ 一次性收编（copy-if-missing,幂等）。
/// 只搬登录器身份域文件;llm-providers/projects 等老家族文件不碰。
/// （2026-10-06 删号窗口清理：旧种子单文件 myco-seed.key/myco-did.txt 不再拷入——
/// 槽迁移 migrate_legacy_account_slot 已删，拷了也没人消费。）
fn migrate_legacy_myco_dir(base: &std::path::Path) {
    let old = base.join("myco");
    if !old.is_dir() {
        return;
    }
    let new = base.join("youling");
    // 已完成收编的标志：device.key 或槽目录在——不再动（幂等 + 防覆盖新身份）
    if new.join("device.key").is_file() || new.join("accounts").is_dir() {
        return;
    }
    // (源名, 目标名)；同名=原样拷
    const MAP: &[(&str, &str)] = &[
        ("iroh-secret.dpapi", "device.key"),
        ("myco-accounts.json", "accounts.json"),
        ("myco-identity-session.json", "session.json"),
        ("delegations.json", "delegations.json"),
        ("authorized-dids.json", "authorized-dids.json"),
        ("agent-of.json", "agent-of.json"),
    ];
    for (s, d) in MAP {
        let src = old.join(s);
        let dst = new.join(d);
        if src.is_file() && !dst.is_file() {
            let _ = std::fs::copy(&src, &dst);
        }
    }
    // 账号槽目录整树（active.txt + <safe-did>.seed）
    let old_acc = old.join("accounts");
    if old_acc.is_dir() {
        let _ = std::fs::create_dir_all(new.join("accounts"));
        if let Ok(entries) = std::fs::read_dir(&old_acc) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_file() {
                    let dst = new.join("accounts").join(e.file_name());
                    if !dst.is_file() {
                        let _ = std::fs::copy(&p, &dst);
                    }
                }
            }
        }
    }
}

/// Resolve the persistent path for a config file, migrating the legacy temp
/// copy if the persistent one doesn't exist yet. `legacy_name` is the file
/// name previously used under temp_dir (same name is reused in the config dir).
pub fn config_file(legacy_name: &str) -> PathBuf {
    let persistent = config_dir().join(legacy_name);
    if !persistent.exists() {
        let legacy = std::env::temp_dir().join(legacy_name);
        if legacy.exists() {
            // Migrate once; ignore failure (a fresh file will be written later).
            let _ = std::fs::copy(&legacy, &persistent);
        }
    }
    persistent
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(PathBuf::from))
        .ok()
}

/// Which auth env var a spawned claude should carry the proxy token in.
///
/// To avoid Claude Code's "Both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set"
/// warning WITHOUT isolating the config dir (which would hide the user's real
/// conversation history), we set the SAME var the user's ~/.claude/settings.json
/// already uses — the process-env value (the proxy token) then overrides it, and
/// process.rs drops the OTHER var, leaving exactly one auth var. Returns
/// "ANTHROPIC_AUTH_TOKEN" only when the user settings use it exclusively;
/// otherwise defaults to "ANTHROPIC_API_KEY" (the common/standard one).
pub fn claude_auth_var_name() -> &'static str {
    let uses_auth_token = home_dir()
        .map(|h| h.join(".claude").join("settings.json"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
        .and_then(|v| {
            v.get("env")
                .and_then(|e| e.as_object())
                .map(|o| {
                    o.contains_key("ANTHROPIC_AUTH_TOKEN") && !o.contains_key("ANTHROPIC_API_KEY")
                })
        })
        .unwrap_or(false);
    if uses_auth_token {
        "ANTHROPIC_AUTH_TOKEN"
    } else {
        "ANTHROPIC_API_KEY"
    }
}

/// 生成 claude 用的代理 token（编码 taskId）。llm-proxy 据此路由到对应 provider。
/// 纯字符串，与 llm-proxy 服务的 TOKEN_PREFIX 约定一致（"myco-proxy-{taskId}"）。
pub fn proxy_token(task_id: &str) -> String {
    format!("myco-proxy-{}", task_id)
}

/// 把 myco 代理令牌加入 claude 的已批准 API key 清单（~/.claude.json
/// customApiKeyResponses.approved）。claude 对未批准的 key 直接拒绝使用
/// （报 "Not logged in"），而建会话时它还没机会交互式确认，所以由我们预批准。
/// 幂等：已存在则不重复添加；rejected 里的同名项顺手移除。
///
/// 注意：approved/rejected 里存的是**密钥末尾 20 个字符**（实测：claude 的
/// 确认弹窗显示的就是尾 20 位；被拒记录也是尾 20 位。短令牌
/// "myco-proxy-flag-test" 恰好 20 字符所以能全串匹配；57 字符的项目令牌
/// 必须存其尾 20 位才匹配得上）。
pub fn approve_proxy_token(token: &str) {
    let truncated: String = token
        .chars()
        .rev()
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let path = claude_json_path();
    let Ok(content) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut doc) = serde_json::from_str::<serde_json::Value>(&content) else {
        return;
    };
    let responses = doc
        .as_object_mut()
        .and_then(|o| o.get_mut("customApiKeyResponses"))
        .and_then(|v| v.as_object_mut());
    let Some(responses) = responses else {
        return;
    };

    let mut changed = false;
    if let Some(rejected) = responses.get_mut("rejected").and_then(|v| v.as_array_mut()) {
        let before = rejected.len();
        rejected.retain(|v| v.as_str() != Some(token) && v.as_str() != Some(&truncated));
        changed |= rejected.len() != before;
    }
    let approved = responses
        .entry("approved".to_string())
        .or_insert_with(|| serde_json::Value::Array(vec![]));
    if let Some(arr) = approved.as_array_mut() {
        // 全串与截断串只留截断串（旧版可能写过全串，清掉避免误导）
        let before = arr.len();
        arr.retain(|v| v.as_str() != Some(token));
        changed |= arr.len() != before;
        if !arr.iter().any(|v| v.as_str() == Some(&truncated)) {
            arr.push(serde_json::Value::String(truncated.clone()));
            changed = true;
        }
    }
    if changed {
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap_or_default());
    }
}

fn claude_json_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    PathBuf::from(home).join(".claude.json")
}
