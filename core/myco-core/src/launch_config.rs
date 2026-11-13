//! Claude Code launch arguments — user-configurable startup flags.
//!
//! Which flags myco passes when spawning a claude terminal is configurable
//! (not hardcoded), so the user can toggle/add/remove them in Settings. Defaults
//! enable `--dangerously-skip-permissions` (bypass permission prompts) and
//! `--continue` (resume the last session). Persisted to the config dir (not git).

/// One launch flag + whether it's active + a human hint.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LaunchArg {
    /// The CLI flag, e.g. "--dangerously-skip-permissions".
    pub flag: String,
    /// Whether it's passed to claude.
    pub enabled: bool,
    /// Human description shown in Settings.
    pub label: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeLaunchConfig {
    pub args: Vec<LaunchArg>,
    /// 是否隐藏拉起的 claude 控制台窗口（SW_HIDE；console 功能全，ta 仍能抓屏，只是不可见）。
    /// 同时管 PC 本地打开 + 手机远程打开——两端一致。默认 true（后台代理，不偷焦点）。
    /// 关掉则弹出可见 console（调试/想看 claude 原始终端时用）。旧配置文件无此字段 → 默认 true。
    #[serde(default = "default_true")]
    pub hide_console: bool,
}

fn default_true() -> bool {
    true
}

/// Well-known claude flags offered as defaults / quick-add suggestions.
pub const FLAG_SKIP_PERMISSIONS: &str = "--dangerously-skip-permissions";
pub const FLAG_CONTINUE: &str = "--continue";

impl Default for ClaudeLaunchConfig {
    fn default() -> Self {
        Self {
            args: vec![
                LaunchArg {
                    flag: FLAG_SKIP_PERMISSIONS.to_string(),
                    enabled: true,
                    label: "免确认执行模式（跳过权限提示）".to_string(),
                },
                LaunchArg {
                    flag: FLAG_CONTINUE.to_string(),
                    enabled: true,
                    label: "自动恢复上次会话（resume）".to_string(),
                },
            ],
            hide_console: true,
        }
    }
}

/// 当前是否隐藏 claude 控制台窗口（PC 本地打开 + 手机远程打开共用，两端一致）。
pub fn hide_console() -> bool {
    read_claude_launch_config().hide_console
}

fn launch_config_path() -> std::path::PathBuf {
    crate::config::config_file("myco-claude-launch.json")
}

pub fn read_claude_launch_config() -> ClaudeLaunchConfig {
    let path = launch_config_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => ClaudeLaunchConfig::default(),
    }
}

pub fn write_claude_launch_config(config: &ClaudeLaunchConfig) -> Result<(), String> {
    let path = launch_config_path();
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize launch config: {}", e))?;
    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write launch config: {}", e))
}

/// Build the claude CLI args for a spawned terminal.
///
/// All enabled flags are included EXCEPT `--continue`, which is only added when
/// `resume` is true (a project main-terminal open) — task sub-agent terminals
/// must start fresh, not resume some prior session.
pub fn build_claude_args(resume: bool) -> Vec<String> {
    build_claude_args_ex(resume, false, None)
}

/// 扩展版(2026-09-01 项目多任务):
///  - fork=true:配 resume 使用,追加 --fork-session(以现有对话为起点分叉新会话,
///    原会话不动)——只 fork 不 resume 无意义,忽略
///  - resume_session=Some(id):--resume <claude会话id> 精确恢复(比 --continue 挑
///    "目录最新"更准——同目录多任务时 fork 源必须指定)
pub fn build_claude_args_ex(resume: bool, fork: bool, resume_session: Option<&str>) -> Vec<String> {
    let cfg = read_claude_launch_config();
    let mut args: Vec<String> = cfg
        .args
        .iter()
        .filter(|a| a.enabled && a.flag != FLAG_CONTINUE && !a.flag.trim().is_empty())
        .map(|a| a.flag.clone())
        .collect();
    if let Some(id) = resume_session.filter(|s| !s.is_empty()) {
        args.push("--resume".to_string());
        args.push(id.to_string());
        if fork {
            args.push("--fork-session".to_string());
        }
    } else if resume && cfg.args.iter().any(|a| a.flag == FLAG_CONTINUE && a.enabled) {
        args.push(FLAG_CONTINUE.to_string());
        if fork {
            args.push("--fork-session".to_string());
        }
    }
    args
}

/// True if the project directory has a resumable claude session.
///
/// Claude stores per-project conversation transcripts under
/// `~/.claude/projects/<encoded-path>/`. The encoder dashes EVERY
/// non-alphanumeric char（本机实测：`D:\Projects\labs\myco` → `D--Projects-AOP-myco`，
/// 含空格/点的路径如 `D--Projects-iroot---`）——只映射 `:'\`/` 会在带空格/点的
/// 路径上永远找不到历史 → --continue 丢失。CJK 字符按同一规则也会被 dash 掉。
/// We only add `--continue` when such history exists — otherwise
/// `claude --continue` hard-fails with "No conversation found" and the console
/// window flash-exits.
pub fn has_claude_history(project_path: &str) -> bool {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    if home.is_empty() {
        return false;
    }
    // Encode the path the way claude does: every non-ASCII-alphanumeric → '-'.
    let encoded: String = project_path
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect();
    let dir = std::path::PathBuf::from(home)
        .join(".claude")
        .join("projects")
        .join(encoded);
    std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .any(|e| e.path().extension().map(|x| x == "jsonl").unwrap_or(false))
        })
        .unwrap_or(false)
}
