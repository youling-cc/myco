//! Task Parser - 解析 task.md 文件
//!
//! 手动解析 YAML Front Matter + Markdown

use myco_protocol::{Task, TaskFrontMatter};

/// 解析错误
#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("YAML parse error: {0}")]
    YamlError(#[from] serde_yaml::Error),

    #[error("Missing required field: {0}")]
    MissingField(String),

    #[error("Invalid task format: {0}")]
    InvalidFormat(String),
}

/// 解析 task.md 文件
pub fn parse_task_file(path: &std::path::Path) -> Result<Task, ParseError> {
    let content = std::fs::read_to_string(path)?;

    // 手动提取 YAML front matter
    let (front_matter_str, body) = extract_front_matter(&content)?;

    // 解析 YAML
    let front_matter: TaskFrontMatter = serde_yaml::from_str(&front_matter_str)?;

    // 使用绝对路径 (canonicalize)
    let canonical_path = path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf());
    let canonical_dir = canonical_path.parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();

    Ok(Task {
        front_matter,
        body,
        file_path: canonical_path.to_string_lossy().to_string(),
        directory: canonical_dir.to_string_lossy().to_string(),
    })
}

/// 提取 YAML front matter 和 body
fn extract_front_matter(content: &str) -> Result<(String, String), ParseError> {
    let content = content.trim_start();

    // 检查是否以 --- 开始
    if !content.starts_with("---") {
        // Fallback: 从 Markdown 标题提取 id，创建最小 frontmatter
        let fallback_yaml = extract_fallback_frontmatter(content);
        return Ok((fallback_yaml, content.to_string()));
    }

    // 找到结束的 ---
    let rest = &content[3..]; // 跳过第一个 ---
    let end_pos = rest
        .find("\n---")
        .ok_or_else(|| ParseError::InvalidFormat("Missing closing ---".to_string()))?;

    // 跳过开头的换行符
    let yaml_content = rest[..end_pos].trim_start();
    let body = rest[end_pos + 4..].trim().to_string(); // +4 跳过 \n---

    Ok((yaml_content.to_string(), body))
}

/// 从纯 Markdown 文件提取最小 frontmatter（降级处理）
fn extract_fallback_frontmatter(content: &str) -> String {
    // 从第一个 # 标题提取 id
    let id = content
        .lines()
        .find(|line| line.starts_with("# "))
        .map(|line| {
            line.trim_start_matches('#')
                .trim()
                .to_lowercase()
                .replace(' ', "-")
                .replace(|c: char| !c.is_alphanumeric() && c != '-', "")
        })
        .unwrap_or_else(|| "unknown".to_string());

    format!("id: {}\ntitle: Untitled\nstatus: active", id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_parse_task_file() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("test-task.md");

        let content = r#"---
id: task-001
title: Test Task
status: pending
priority: high
---

# Task Description

This is a test task body.
"#;

        fs::write(&file_path, content).unwrap();
        let task = parse_task_file(&file_path).unwrap();

        assert_eq!(task.front_matter.id, Some("task-001".to_string()));
        assert_eq!(task.front_matter.title, "Test Task");
        assert!(task.body.contains("Task Description"));
    }

    #[test]
    fn test_extract_front_matter() {
        let content = "---\nid: test\n---\nBody content";
        let (yaml, body) = extract_front_matter(content).unwrap();
        assert_eq!(yaml, "id: test");
        assert_eq!(body, "Body content");
    }

    #[test]
    fn test_extract_front_matter_fallback() {
        // 纯 Markdown 文件（没有 frontmatter）也能解析
        let content = "# My Agent Task\n\nBody content here.";
        let (yaml, body) = extract_front_matter(content).unwrap();
        assert!(yaml.contains("id: my-agent-task"));
        assert!(body.contains("# My Agent Task"));
    }

    #[test]
    fn test_parse_task_file_without_frontmatter() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("test-no-fm.md");

        let content = "# My Custom Agent\n\nSome description here.\n";
        fs::write(&file_path, content).unwrap();
        let task = parse_task_file(&file_path).unwrap();

        assert!(task.front_matter.id.is_some());
        assert_eq!(task.front_matter.title, "Untitled");
    }

    #[test]
    fn test_parse_layer_and_dataset_fields() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("skill-task.md");

        let content = r#"---
id: perception.scan
title: Node Scanner
layer: P
dataset: traces.json
---

## Body
"#;

        fs::write(&file_path, content).unwrap();
        let task = parse_task_file(&file_path).unwrap();

        assert_eq!(task.front_matter.id, Some("perception.scan".to_string()));
        assert_eq!(task.front_matter.title, "Node Scanner");
        assert_eq!(task.front_matter.layer, Some(myco_protocol::TaskType::P));
        assert_eq!(task.front_matter.dataset, Some("traces.json".to_string()));
        // task_type defaults to A, but layer=P, so effective type is P
        assert_eq!(task.task_type(), myco_protocol::TaskType::P);
    }
}
