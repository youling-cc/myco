//! Project registry — the workspace-level entity the Dock manages.
//!
//! A Project is a directory the user runs Claude Code in. It carries display
//! name, pin/favorite state, and provider (model) assignment — both a
//! project-level default and per-task overrides. Persisted to the config dir
//! (NOT temp) so pinned projects + their models survive a reboot, which is
//! what powers the "reopen my whole workspace with one click" flow.

use std::collections::HashMap;

use crate::domain::slugify;

/// A workspace project (one directory ↔ one or more terminal sessions).
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// Stable id (uuid). Dedup is by normalized `path`, not id.
    pub id: String,
    /// Absolute project directory.
    pub path: String,
    /// Display name (defaults to the directory basename; editable).
    pub name: String,
    /// Pinned projects are reopened by `open_workspace` (the reboot-restore set).
    #[serde(default)]
    pub pinned: bool,
    /// Project-level default provider id (model). Overrides global default.
    #[serde(default)]
    pub provider_id: Option<String>,
    /// Per-task provider overrides within this project: taskId -> providerId.
    #[serde(default)]
    pub task_providers: HashMap<String, String>,
    /// 项目级 harness 选择（M-Harness H5）：claude-code / kimi-code / codex；
    /// None = 默认 claude-code。打开主终端/任务终端时按此拉起对应 CLI。
    #[serde(default)]
    pub harness: Option<String>,
    /// Last time a terminal was opened for this project (unix ms).
    #[serde(default)]
    pub last_opened_at: Option<i64>,
    /// Dock ordering (lower = higher).
    #[serde(default)]
    pub order: usize,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    #[serde(default)]
    pub projects: Vec<Project>,
    /// 任务（task 卡片）：把若干项目（子任务）归组为一个工作单元——web 任务页的一级卡片。
    /// 命名用 WorkTask 避开终端会话的 taskId（那是 per-terminal 的 id，不是一回事）。
    #[serde(default)]
    pub work_tasks: Vec<WorkTask>,
}

/// 一个任务卡片：{id, title, projectIds[]}（无状态机——2026-08 定稿"先不复杂化"）。
/// 不在任何任务里的项目 = "未分组"（前端虚拟卡片，不落实体）。
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkTask {
    /// Stable id："wt-<uuid>"。
    pub id: String,
    pub title: String,
    /// 归入该任务的项目 id 列表（一个项目最多属于一个任务；移动=先从旧任务移除）。
    #[serde(default)]
    pub project_ids: Vec<String>,
    #[serde(default)]
    pub created_at: Option<i64>,
    #[serde(default)]
    pub updated_at: Option<i64>,
}

/// Build a new WorkTask with a fresh id.
pub fn new_work_task(title: &str) -> WorkTask {
    let now = chrono::Utc::now().timestamp_millis();
    WorkTask {
        id: format!("wt-{}", uuid::Uuid::new_v4()),
        title: title.to_string(),
        project_ids: Vec::new(),
        created_at: Some(now),
        updated_at: Some(now),
    }
}

fn project_config_path() -> std::path::PathBuf {
    crate::config::config_file("myco-projects.json")
}

pub fn read_project_config() -> ProjectConfig {
    let path = project_config_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => ProjectConfig::default(),
    }
}

pub fn write_project_config(config: &ProjectConfig) -> Result<(), String> {
    let path = project_config_path();
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize project config: {}", e))?;
    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write project config: {}", e))
}

/// Normalize a path for comparison (forward slashes, no trailing slash, lowercase
/// on Windows where paths are case-insensitive).
pub fn normalize_path(p: &str) -> String {
    let s = p.replace('\\', "/");
    let s = s.trim_end_matches('/').to_string();
    #[cfg(windows)]
    { s.to_lowercase() }
    #[cfg(not(windows))]
    { s }
}

/// Find a project's display name by directory path (for prefixing terminal
/// window titles as `Project · task`). Returns None if the path isn't a
/// registered project.
pub fn project_name_for_path(path: &str) -> Option<String> {
    let norm = normalize_path(path);
    read_project_config()
        .projects
        .iter()
        .find(|p| normalize_path(&p.path) == norm)
        .map(|p| p.name.clone())
}

/// Find a project's harness choice by directory path（H5 拉起解析用）。
/// Returns None if the path isn't a registered project or未设置（=默认 claude-code）。
pub fn project_harness_for_path(path: &str) -> Option<String> {
    let norm = normalize_path(path);
    read_project_config()
        .projects
        .iter()
        .find(|p| normalize_path(&p.path) == norm)
        .and_then(|p| p.harness.clone())
}

/// Derive a display name from a path (basename), falling back to the path.
pub fn default_name_for_path(path: &str) -> String {
    let norm = path.replace('\\', "/");
    let base = norm.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    if base.is_empty() { path.to_string() } else { base.to_string() }
}

/// Build a new Project with a fresh id and a default name from the path.
pub fn new_project(path: &str) -> Project {
    Project {
        id: format!("proj-{}", uuid::Uuid::new_v4()),
        path: path.to_string(),
        name: default_name_for_path(path),
        pinned: false,
        provider_id: None,
        task_providers: HashMap::new(),
        harness: None,
        last_opened_at: None,
        order: 0,
    }
}

/// slugify re-export for command layer convenience.
pub fn slugify_name(text: &str) -> String {
    slugify(text)
}
