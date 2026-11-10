//! LLM Provider configuration — types + persistence helpers.
//!
//! Shared across the A-layer (provider_save/delete) and R-layer
//! (provider_test_connection/list/get_config) command modules, plus the
//! terminal session startup (which resolves provider env). Kept here as
//! crate-root infrastructure so neither layer owns it.

use std::collections::HashMap;

use crate::domain::slugify;

// ========================================
// Provider config types
// ========================================

/// LLM 提供者配置
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LlmProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub auth_token: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default = "default_api_key_field")]
    pub api_key_field: String,
    /// 模型独有配色（hex，如 #8b5cf6）；空=跟聊天主题色。影响 AI 气泡左色带 + 模型名底色。
    #[serde(default)]
    pub color: Option<String>,
}

fn default_api_key_field() -> String {
    "ANTHROPIC_AUTH_TOKEN".to_string()
}

/// Provider 配置文件（含 per-task 分配）
#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    #[serde(default)]
    pub providers: Vec<LlmProvider>,
    #[serde(default)]
    pub task_providers: HashMap<String, String>,
    #[serde(default)]
    pub default_provider: Option<String>,
    #[serde(default)]
    pub claude_installed: Option<bool>,
    /// 各 harness CLI 的安装检测缓存（key = CLI 命令名，如 "claude"/"kimi"/"codex"）
    #[serde(default)]
    pub harness_installed: HashMap<String, bool>,
    /// per-task harness 选择（M-Harness H5）：taskId -> harnessId
    /// （claude-code / kimi-code / codex）；无记录 = 跟项目/默认 claude-code。
    #[serde(default)]
    pub task_harnesses: HashMap<String, String>,
}

/// 不含敏感信息的 Provider 摘要（用于前端显示）
#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSummary {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: Option<String>,
    pub api_key_field: String,
    pub has_token: bool,
    /// 模型独有配色（hex）；空=跟主题。
    pub color: Option<String>,
}

/// 前端安全的配置（不含 auth token）
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeProviderConfig {
    pub providers: Vec<ProviderSummary>,
    pub task_providers: HashMap<String, String>,
    pub default_provider: Option<String>,
    /// per-task harness 选择（不含敏感信息，随 provider 配置一起给前端）。
    pub task_harnesses: HashMap<String, String>,
}

// ========================================
// Persistence helpers
// ========================================

/// 获取 provider 配置文件路径（持久 config 目录，自动从旧 temp 位置迁移）
/// 前端安全的配置构造器(原 canvas reward::provider_get_config,2026-09-03 下沉——
/// aop 本地模式/provider_list HTTP 对等共用;不含 auth token)。
pub fn safe_config() -> SafeProviderConfig {
    let config = read_provider_config();
    SafeProviderConfig {
        providers: config.providers.iter().map(|p| ProviderSummary {
            id: p.id.clone(),
            name: p.name.clone(),
            base_url: p.base_url.clone(),
            model: p.model.clone(),
            api_key_field: p.api_key_field.clone(),
            has_token: !p.auth_token.is_empty(),
            color: p.color.clone(),
        }).collect(),
        task_providers: config.task_providers,
        default_provider: config.default_provider,
        task_harnesses: config.task_harnesses,
    }
}

pub fn get_provider_config_path() -> std::path::PathBuf {
    crate::config::config_file("myco-llm-providers.json")
}

/// 读取 provider 配置
pub fn read_provider_config() -> ProviderConfig {
    let path = get_provider_config_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => ProviderConfig::default(),
    }
}

/// 写入 provider 配置
pub fn write_provider_config(config: &ProviderConfig) -> Result<(), String> {
    let path = get_provider_config_path();
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize provider config: {}", e))?;
    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write provider config: {}", e))
}

/// 根据 provider 构建 env vars
pub fn build_provider_env(provider: &LlmProvider) -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert("ANTHROPIC_BASE_URL".to_string(), provider.base_url.clone());
    env.insert(provider.api_key_field.clone(), provider.auth_token.clone());
    if let Some(model) = &provider.model {
        env.insert("ANTHROPIC_MODEL".to_string(), model.clone());
    }
    env
}

/// 根据 provider ID 查找 provider 并返回 env vars
pub fn resolve_provider_env(provider_id: Option<&str>) -> HashMap<String, String> {
    let pid = match provider_id {
        Some(id) if !id.is_empty() => id,
        _ => return HashMap::new(),
    };

    let config = read_provider_config();
    match config.providers.iter().find(|p| p.id == pid) {
        Some(provider) => build_provider_env(provider),
        None => {
            tracing::warn!("Provider '{}' not found, launching without custom env", pid);
            HashMap::new()
        }
    }
}

/// 从名称生成 slug ID（小写、连字符分隔）
pub fn slugify_id(text: &str) -> String {
    slugify(text)
}
