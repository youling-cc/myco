//! tools.rs — AOP 执行器的工具集(read/write/bash/list)。
//!
//! 路径护栏:所有文件路径相对任务根目录解析,canonicalize 后必须仍在任务
//! 根目录内(防 `../` 越界)。bash 用 `cmd /c` 无窗口执行,带超时与输出截断
//! (借鉴 Pi truncate 语义:超长输出截尾并标注)。

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

const MAX_OUTPUT_CHARS: usize = 12000;
const DEFAULT_BASH_TIMEOUT_SECS: u64 = 120;

pub struct ToolRunner {
    /// 任务根目录(绝对路径)。
    cwd: PathBuf,
}

impl ToolRunner {
    pub fn new(cwd: PathBuf) -> Self {
        // cwd 也 canonicalize:Windows 上 canonicalize 返回 \\?\ 扩展前缀,
        // 与未规范化 cwd 做 starts_with 比较会误判越界。
        let cwd = cwd.canonicalize().unwrap_or(cwd);
        Self { cwd }
    }

    /// 执行一个工具调用。返回文本结果(失败以 "Error: ..." 开头,不回传异常)。
    pub async fn run(&self, name: &str, input: &Value) -> String {
        match name {
            "read" => self.read(input).await,
            "write" => self.write(input).await,
            "bash" => self.bash(input).await,
            "list" => self.list(input).await,
            other => format!("Error: 未知工具 '{other}'(可用: read/write/bash/list)"),
        }
    }

    /// 路径护栏:任务目录内的相对/绝对路径 → 绝对路径;越界返回 Err。
    fn resolve_inside(&self, path: &str) -> Result<PathBuf, String> {
        let p = Path::new(path);
        let abs = if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.cwd.join(p)
        };
        let canon = abs
            .canonicalize()
            .map_err(|e| format!("路径不可达 '{}': {e}", abs.display()))?;
        if !canon.starts_with(&self.cwd) {
            return Err(format!("路径越界(超出任务目录): {}", canon.display()));
        }
        Ok(canon)
    }

    async fn read(&self, input: &Value) -> String {
        let path = match input.get("path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return "Error: read 需要 path 参数".to_string(),
        };
        let canon = match self.resolve_inside(path) {
            Ok(c) => c,
            Err(e) => return format!("Error: {e}"),
        };
        if !canon.is_file() {
            return format!("Error: 不是文件: {}", canon.display());
        }
        let offset = input.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let limit = input.get("limit").and_then(|v| v.as_u64());
        match tokio::fs::read_to_string(&canon).await {
            Ok(content) => {
                let lines: Vec<&str> = content.lines().collect();
                let start = offset.min(lines.len());
                let end = match limit {
                    Some(l) => (start + l as usize).min(lines.len()),
                    None => lines.len(),
                };
                let selected = &lines[start..end];
                if selected.is_empty() {
                    return "(空)".to_string();
                }
                let mut out = String::new();
                for (i, line) in selected.iter().enumerate() {
                    out.push_str(&format!("{:>5} │ {}\n", start + i + 1, line));
                }
                truncate_str(&out, MAX_OUTPUT_CHARS)
            }
            Err(e) => format!("Error: 读取失败: {e}"),
        }
    }

    async fn write(&self, input: &Value) -> String {
        let path = match input.get("path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return "Error: write 需要 path 参数".to_string(),
        };
        let content = match input.get("content").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => return "Error: write 需要 content 参数".to_string(),
        };
        // 写文件不要求路径已存在(canonicalize 会失败)——解析父目录护栏。
        // 父目录不存在时在护栏内自动创建(执行者写 sub/f.txt 是合理动作,
        // 不该让它先 mkdir——DeepSeek Harness 的 write 同此语义)。
        let p = Path::new(path);
        let abs = if p.is_absolute() { p.to_path_buf() } else { self.cwd.join(p) };
        let parent = abs.parent().unwrap_or(&self.cwd).to_path_buf();
        let canon_parent = match parent.canonicalize() {
            Ok(c) => c,
            Err(_) => {
                // 父目录缺失:逐级向上找到最近存在的祖先验护栏,再建目录
                let mut ancestor = parent.as_path();
                while !ancestor.exists() {
                    ancestor = ancestor.parent().unwrap_or(&self.cwd);
                }
                let canon_ancestor = match ancestor.canonicalize() {
                    Ok(c) => c,
                    Err(e) => return format!("Error: 目录不可达 '{}': {e}", ancestor.display()),
                };
                if !canon_ancestor.starts_with(&self.cwd) {
                    return format!("Error: 路径越界(超出任务目录): {}", abs.display());
                }
                if let Err(e) = tokio::fs::create_dir_all(&parent).await {
                    return format!("Error: 建目录失败 '{}': {e}", parent.display());
                }
                match parent.canonicalize() {
                    Ok(c) => c,
                    Err(e) => return format!("Error: 目录创建后不可达: {e}"),
                }
            }
        };
        if !canon_parent.starts_with(&self.cwd) {
            return format!("Error: 路径越界(超出任务目录): {}", abs.display());
        }
        match tokio::fs::write(&abs, content).await {
            Ok(_) => format!("已写入 {} ({} 字符)", abs.display(), content.chars().count()),
            Err(e) => format!("Error: 写入失败: {e}"),
        }
    }

    async fn bash(&self, input: &Value) -> String {
        let command = match input.get("command").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => return "Error: bash 需要 command 参数".to_string(),
        };
        let timeout_secs = input
            .get("timeout_sec")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_BASH_TIMEOUT_SECS)
            .min(600);

        let cwd = self.cwd.clone();
        let cmd = command.to_string();
        let result = tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            tokio::task::spawn_blocking(move || run_cmd(&cwd, &cmd)),
        )
        .await;
        match result {
            Err(_) => format!("Error: 命令超时({timeout_secs}s): {command}"),
            Ok(Err(join_err)) => format!("Error: 命令任务失败: {join_err}"),
            Ok(Ok(inner)) => match inner {
                Ok(out) => out,
                Err(e) => format!("Error: 执行失败: {e}"),
            },
        }
    }

    async fn list(&self, input: &Value) -> String {
        let path = input.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let canon = match self.resolve_inside(path) {
            Ok(c) => c,
            Err(e) => return format!("Error: {e}"),
        };
        if !canon.is_dir() {
            return format!("Error: 不是目录: {}", canon.display());
        }
        let mut entries = match tokio::fs::read_dir(&canon).await {
            Ok(e) => e,
            Err(e) => return format!("Error: 列目录失败: {e}"),
        };
        let mut out = String::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
            out.push_str(&format!("{}{}\n", if is_dir { "📁 " } else { "   " }, name));
        }
        // 空目录 → 空串 tool_result 会触发 Kimi K3 400 "text content is empty"
        // (GLM 容忍;2026-08-18 用户实测 k3-256k 首轮即炸根因)
        if out.is_empty() {
            return "(空目录)".to_string();
        }
        truncate_str(&out, MAX_OUTPUT_CHARS)
    }
}

/// Windows:cmd /c + CREATE_NO_WINDOW;输出合并截断。
fn run_cmd(cwd: &Path, command: &str) -> Result<String, String> {
    #[cfg(windows)]
    let output = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/c", command])
            .current_dir(cwd)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    };
    #[cfg(not(windows))]
    let output = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        std::process::Command::new(shell)
            .args(["-c", command])
            .current_dir(cwd)
            .output()
    };
    let output = output.map_err(|e| e.to_string())?;
    let mut out = String::new();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stdout.is_empty() {
        out.push_str(stdout.trim_end());
        out.push('\n');
    }
    if !stderr.is_empty() {
        out.push_str("[stderr] ");
        out.push_str(stderr.trim_end());
        out.push('\n');
    }
    out.push_str(&format!("(exit {})", output.status.code().unwrap_or(-1)));
    Ok(truncate_str(&out, MAX_OUTPUT_CHARS))
}

/// 超限输出 spill(dsh 借鉴):完整内容落 .aop/spill/,返回截断+locator——
/// 执行者/R 代理可用 read 分段继续查看,长构建输出不再永久丢失。
fn truncate_str(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        return s.to_string();
    }
    let kept: String = chars[..max].iter().collect();
    match spill_write(s) {
        // locator 统一正斜杠(提示词/跨平台一致性;Windows read 也接受)
        Ok(path) => {
            let loc = path.to_string_lossy().replace('\\', "/");
            format!("{kept}\n…(已截断,共 {} 字符。完整输出已存 `{loc}`,可用 read 工具分段查看)", chars.len())
        }
        Err(_) => format!("{kept}\n…(已截断,共 {} 字符)", chars.len()),
    }
}

/// 完整输出写 spill 文件,返回任务根相对路径(执行者 read 用相对路径)。
fn spill_write(content: &str) -> Result<std::path::PathBuf, String> {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::path::Path::new(".aop").join("spill");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = format!(
        "spill-{}-{}.txt",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        N.fetch_add(1, Ordering::Relaxed)
    );
    std::fs::write(dir.join(&name), content).map_err(|e| e.to_string())?;
    Ok(std::path::Path::new(".aop").join("spill").join(name))
}

/// EXEC 阶段的工具定义(发给 LLM 的 tools 数组)。
pub fn exec_tool_defs() -> Vec<super::llm::ToolDef> {
    use super::llm::ToolDef;
    vec![
        ToolDef {
            name: "read".into(),
            description: "读取任务目录内文件(带行号);path 相对任务根目录,可 offset/limit".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "相对/绝对路径(须在任务目录内)" },
                    "offset": { "type": "integer", "description": "起始行(0 起,可选)" },
                    "limit": { "type": "integer", "description": "行数(可选)" },
                },
                "required": ["path"],
            }),
        },
        ToolDef {
            name: "write".into(),
            description: "写入文件(覆盖);path 相对任务根目录".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" },
                },
                "required": ["path", "content"],
            }),
        },
        ToolDef {
            name: "bash".into(),
            description: "在任务根目录执行 shell 命令(Windows cmd);输出被截断,可 timeout_sec".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "timeout_sec": { "type": "integer" },
                },
                "required": ["command"],
            }),
        },
        ToolDef {
            name: "list".into(),
            description: "列出任务目录内某路径下的条目(默认任务根目录)".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                },
            }),
        },
    ]
}

/// R 评审的工具定义:只读核验(read/list/bash),无 write——评审不改交付物。
pub fn r_tool_defs() -> Vec<super::llm::ToolDef> {
    exec_tool_defs()
        .into_iter()
        .filter(|t| t.name != "write")
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_guard_blocks_escape() {
        let tmp = std::env::temp_dir().join(format!("aop-guard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("a.txt"), "hello").unwrap();
        let runner = ToolRunner::new(tmp.clone());
        // 越界
        let escaped = runner.resolve_inside("../outside.txt");
        assert!(escaped.is_err(), "越界路径应被拒: {:?}", escaped);
        // 合法
        assert!(runner.resolve_inside("a.txt").is_ok());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn truncate_marks_cut() {
        let s = "x".repeat(100);
        let out = truncate_str(&s, 10);
        assert!(out.contains("已截断"));
    }
}

#[cfg(test)]
mod boundary_tests {
    use super::*;
    use serde_json::json;

    fn tmpdir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("aop-tools-b-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[tokio::test]
    async fn read_offset_limit_bounds() {
        let d = tmpdir();
        std::fs::write(d.join("f.txt"), "l1\nl2\nl3\n").unwrap();
        let r = ToolRunner::new(d.clone());
        // offset 越界 → 空,不 panic
        let out = r.run("read", &json!({"path": "f.txt", "offset": 99})).await;
        assert!(out.contains("(空)"), "offset 越界应空: {out}");
        // limit 0 → 空
        let out = r.run("read", &json!({"path": "f.txt", "limit": 0})).await;
        assert!(out.contains("(空)"));
        // 正常 offset+limit
        let out = r.run("read", &json!({"path": "f.txt", "offset": 1, "limit": 1})).await;
        assert!(out.contains("2 │ l2"));
        std::fs::remove_dir_all(&d).ok();
    }

    #[tokio::test]
    async fn read_missing_file_clear_error() {
        let d = tmpdir();
        let r = ToolRunner::new(d.clone());
        let out = r.run("read", &json!({"path": "no-such.txt"})).await;
        assert!(out.starts_with("Error:"), "缺文件应 Error 开头: {out}");
        std::fs::remove_dir_all(&d).ok();
    }

    #[tokio::test]
    async fn write_escape_via_missing_parent_rejected() {
        let d = tmpdir();
        let r = ToolRunner::new(d.clone());
        // 越界:缺失父目录的 ../ 逃逸仍必须拒绝(护栏不因自动建目录而放松)
        let out = r.run("write", &json!({"path": "../../outside/f.txt", "content": "x"})).await;
        assert!(out.starts_with("Error:"), "越界缺失父目录应拒绝: {out}");
        std::fs::remove_dir_all(&d).ok();
    }

    #[tokio::test]
    async fn write_creates_subdir_inside_root() {
        let d = tmpdir();
        let r = ToolRunner::new(d.clone());
        let out = r.run("write", &json!({"path": "sub/f.txt", "content": "x"})).await;
        assert!(out.starts_with("已写入"), "任务根内子目录应自动建: {out}");
        std::fs::remove_dir_all(&d).ok();
    }

    #[tokio::test]
    async fn bash_timeout_enforced() {
        let d = tmpdir();
        let r = ToolRunner::new(d.clone());
        let out = r.run("bash", &json!({"command": "ping -n 30 127.0.0.1", "timeout_sec": 1})).await;
        assert!(out.contains("超时"), "1s 超时应触发: {out}");
        std::fs::remove_dir_all(&d).ok();
    }

    #[tokio::test]
    async fn list_missing_dir_error_not_panic() {
        let d = tmpdir();
        let r = ToolRunner::new(d.clone());
        let out = r.run("list", &json!({"path": "no-such"})).await;
        assert!(out.starts_with("Error:"), "缺目录应 Error: {out}");
        std::fs::remove_dir_all(&d).ok();
    }

    #[tokio::test]
    async fn unknown_tool_named_in_error() {
        let d = tmpdir();
        let r = ToolRunner::new(d.clone());
        let out = r.run("rm_rf", &json!({})).await;
        assert!(out.contains("rm_rf") && out.contains("未知工具"), "未知工具应具名: {out}");
        std::fs::remove_dir_all(&d).ok();
    }
}

#[cfg(test)]
mod spill_tests {
    use super::*;

    /// spill:超限输出落盘 + locator 指回;文件内容完整。
    #[test]
    fn truncate_spills_full_output_with_locator() {
        let d = std::env::temp_dir().join(format!("aop-spill-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        let prev = std::env::current_dir().unwrap();
        std::env::set_current_dir(&d).unwrap();
        let s = "y".repeat(20000);
        let out = truncate_str(&s, 100);
        assert!(out.contains("完整输出已存"), "应带 locator: 尾={}", &out[out.len() - 120..]);
        assert!(out.contains(".aop/spill/spill-"));
        let loc = out.split('`').nth(1).expect("locator 在反引号里");
        let spilled = std::fs::read_to_string(loc).unwrap_or_default();
        assert_eq!(spilled.len(), 20000, "spill 文件应完整");
        std::env::set_current_dir(prev).ok();
        std::fs::remove_dir_all(&d).ok();
    }

    #[tokio::test]
    async fn list_empty_dir_never_empty_string() {
        // K3 400 根因回归:空目录 list 曾返回空串 → tool_result 空 text →
        // Kimi K3 "text content is empty" 400(GLM 容忍)
        let d = std::env::temp_dir().join(format!("aop-emptydir-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        let r = ToolRunner::new(d.clone());
        let out = r.run("list", &serde_json::json!({"path": "."})).await;
        assert!(!out.trim().is_empty(), "空目录 list 不得返回空串: {out:?}");
        std::fs::remove_dir_all(&d).ok();
    }
}

