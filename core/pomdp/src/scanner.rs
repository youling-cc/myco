//! Graph Scanner - 扫描任务目录构建依赖图
//!
//! 遍历目录查找所有 task.md 文件

use std::path::Path;
use walkdir::WalkDir;
use myco_protocol::{Task, TaskNode, TaskEdge, TaskGraph};

/// 扫描错误
#[derive(Debug, thiserror::Error)]
pub enum ScanError {
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Parse error in {file}: {error}")]
    ParseError {
        file: String,
        error: String,
    },
}

/// 扫描结果
pub struct ScanResult {
    pub tasks: Vec<Task>,
    pub errors: Vec<(String, String)>,
}

impl Default for ScanResult {
    fn default() -> Self {
        Self {
            tasks: Vec::new(),
            errors: Vec::new(),
        }
    }
}

/// Maximum directory depth to prevent scanning entire filesystem
const MAX_SCAN_DEPTH: usize = 10;

/// Normalize a directory for comparison: forward slashes, strip the Windows
/// UNC prefix, no trailing slash, lowercase (Windows FS is case-insensitive).
fn norm_dir(p: &str) -> String {
    let mut s = p.replace('\\', "/");
    if let Some(stripped) = s.strip_prefix("//?/") {
        s = stripped.to_string();
    }
    while s.ends_with('/') {
        s.pop();
    }
    s.to_lowercase()
}

/// 根锚定成员过滤（一个项目目录绑定一个根 task.md）。
///
/// 图只收三类节点：
///   1. 根 task（directory == base_path 的那个 task.md）；
///   2. 从根沿 dependencies 引用边可达的 task（引用即成员——跨目录引用唯一通道）；
///   3. 各成员自己 `agents/` 子树里的 PCDATR 子技能（目录约定，无需写 deps）。
///
/// base_path 下没有根 task.md → 返回空图（前端据此走"需要新建 / AOP 化"空态）。
/// 注意：目录嵌套本身**不算**成员资格——否则仓库里的测试 fixture（如
/// wxbot_test）会泄漏进父项目的图。agents/ 之外的嵌套 task.md 必须被显式引用才进图。
pub fn anchor_to_root(
    nodes: Vec<TaskNode>,
    edges: Vec<TaskEdge>,
    base_path: &str,
) -> (Vec<TaskNode>, Vec<TaskEdge>) {
    let base = norm_dir(base_path);
    let dir_of: std::collections::HashMap<String, String> = nodes
        .iter()
        .map(|n| (n.id.clone(), norm_dir(n.directory.as_deref().unwrap_or(""))))
        .collect();

    let root_id = nodes
        .iter()
        .find(|n| dir_of.get(&n.id).map(|d| d == &base).unwrap_or(false))
        .map(|n| n.id.clone());

    let Some(root_id) = root_id else {
        tracing::info!(
            "[Scanner] No root task.md at '{}' — empty graph (project not AOP-ized yet)",
            base_path
        );
        return (Vec::new(), Vec::new());
    };

    let total = nodes.len();
    let mut members: std::collections::HashSet<String> = [root_id].into_iter().collect();
    loop {
        let before = members.len();
        // (a) 成员的 agents/ 子树（可传递：子 task 若也有 agents/ 一并收）
        for n in &nodes {
            if members.contains(&n.id) {
                continue;
            }
            let dir = &dir_of[&n.id];
            let in_agents = members.iter().any(|m| {
                let mdir = &dir_of[m];
                !mdir.is_empty() && dir.starts_with(&format!("{}/agents/", mdir))
            });
            if in_agents {
                members.insert(n.id.clone());
            }
        }
        // (b) 引用锥：边方向 from=被引用方 → to=引用方，成员引用谁就收谁
        for e in &edges {
            if members.contains(&e.to) && !members.contains(&e.from) {
                members.insert(e.from.clone());
            }
        }
        if members.len() == before {
            break;
        }
    }

    let kept = members.len();
    let nodes: Vec<_> = nodes.into_iter().filter(|n| members.contains(&n.id)).collect();
    let edges: Vec<_> = edges
        .into_iter()
        .filter(|e| members.contains(&e.from) && members.contains(&e.to))
        .collect();
    tracing::info!(
        "[Scanner] Root-anchored at '{}': kept {}/{} nodes, {} edges",
        base_path,
        kept,
        total,
        edges.len()
    );
    (nodes, edges)
}

/// 扫描任务目录
pub fn scan_tasks(base_path: &Path) -> ScanResult {
    let mut tasks = Vec::new();
    let mut errors = Vec::new();

    // 检查路径是否存在
    if !base_path.exists() {
        tracing::warn!("Base path does not exist: {:?}", base_path);
        return ScanResult { tasks, errors };
    }

    // Canonicalize to resolve relative paths and verify the path
    let canonical = match base_path.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("Cannot canonicalize base path {:?}: {}", base_path, e);
            return ScanResult { tasks, errors };
        }
    };
    tracing::info!("Scanning canonical path: {:?}", canonical);

    for entry in WalkDir::new(&canonical)
        .follow_links(false)
        .max_depth(MAX_SCAN_DEPTH)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.file_name().map(|f| f == "task.md").unwrap_or(false) {
            match crate::parser::parse_task_file(path) {
                Ok(task) => {
                    tracing::debug!("Parsed task: {} from {:?}", task.front_matter.title, path);
                    tasks.push(task);
                }
                Err(e) => {
                    tracing::warn!("Failed to parse {:?}: {}", path, e);
                    errors.push((path.to_string_lossy().to_string(), e.to_string()));
                }
            }
        }
    }

    tracing::info!("Scanned {} tasks with {} errors", tasks.len(), errors.len());
    ScanResult { tasks, errors }
}

/// 构建任务图
pub fn build_graph(tasks: &[Task], base_path: &str) -> TaskGraph {
    // Create a map from directory path to task ID for resolving dependencies
    // Normalize directory paths to use forward slashes for consistent matching
    let dir_to_id: std::collections::HashMap<String, String> = tasks.iter()
        .map(|t| {
            let normalized_dir = t.directory.replace("\\", "/");
            (normalized_dir, t.id().to_string())
        })
        .collect();

    // Direct ID lookup set
    let id_set: std::collections::HashSet<String> = tasks.iter()
        .map(|t| t.id().to_string())
        .collect();

    tracing::debug!("[Scanner] Directory to ID map:");
    for (dir, id) in &dir_to_id {
        tracing::debug!("  '{}' -> '{}'", dir, id);
    }

    let nodes: Vec<TaskNode> = tasks.iter().map(|t| TaskNode {
        id: t.id().to_string(),
        title: t.title().to_string(),
        status: t.status(),
        priority: Some(t.priority().to_string()),
        task_type: Some(t.task_type().to_string()),
        dataset: t.front_matter.dataset.clone(),
        directory: Some(t.directory.clone()),
        file_path: Some(t.file_path.clone()),
        reward: t.front_matter.reward.clone(),
        perception: t.front_matter.perception.clone(),
        cognition: t.front_matter.cognition.clone(),
        decision: t.front_matter.decision.clone(),
        action: t.front_matter.action.clone(),
        transition: t.front_matter.transition.clone(),
        agent: t.front_matter.agent.clone(),
        meta: t.front_matter.meta.clone(),
        body: Some(t.body.clone()),
    }).collect();

    // Build explicit dependency edges
    let mut edges: Vec<TaskEdge> = tasks.iter()
        .filter_map(|t| {
            let to_id = t.id().to_string();
            let t_dir = t.directory.clone();
            if let Some(perception) = &t.front_matter.perception {
                Some(perception.dependencies.iter().filter_map(|dep| {
                    let dep_path = dep.as_path();

                    // Case 1: Direct agent ID reference (no path separators)
                    if !dep_path.contains('/') && !dep_path.contains('\\') && !dep_path.starts_with('.') {
                        if id_set.contains(dep_path) {
                            tracing::debug!("[Scanner] Direct ID match '{}' -> '{}'", dep_path, to_id);
                            return Some(TaskEdge {
                                from: dep_path.to_string(),
                                to: to_id.clone(),
                            });
                        }
                    }

                    // Case 2: Path-based reference
                    let resolved_path = if dep_path.starts_with("../") {
                        let parent = Path::new(&t_dir).parent()?;
                        let dep_rel = dep_path.trim_start_matches("../");
                        parent.join(dep_rel).to_string_lossy().to_string()
                    } else if dep_path.starts_with("./") {
                        let dep_rel = dep_path.trim_start_matches("./");
                        Path::new(&t_dir).join(dep_rel).to_string_lossy().to_string()
                    } else {
                        dep_path.to_string()
                    };

                    // Normalize path separators
                    let mut normalized = resolved_path.replace("\\", "/");
                    if normalized.starts_with("//?/") {
                        normalized = normalized[4..].to_string();
                    }

                    tracing::debug!("[Scanner] Resolving dep '{}' -> '{}'", dep_path, normalized);

                    dir_to_id.get(&normalized).map(|from_id| TaskEdge {
                        from: from_id.clone(),
                        to: to_id.clone(),
                    })
                }).collect::<Vec<_>>())
            } else {
                None
            }
        })
        .flatten()
        .collect();

    // Auto-generate PCDATR chain edges for skill-level tasks
    {
        use myco_protocol::TaskType;
        let existing_pair: std::collections::HashSet<(String, String)> = edges.iter()
            .map(|e| (e.from.clone(), e.to.clone()))
            .collect();

        // Group tasks by parent directory
        let mut groups: std::collections::HashMap<String, Vec<(TaskType, String)>> = std::collections::HashMap::new();
        for t in tasks {
            let group_key = Path::new(&t.directory)
                .parent()
                .map(|p| p.to_string_lossy().replace("\\", "/"))
                .unwrap_or_default();

            if t.front_matter.layer.is_some() || t.front_matter.perception.is_none() {
                groups.entry(group_key).or_default().push((t.task_type(), t.id().to_string()));
            }
        }

        for (_group_key, members) in &groups {
            let mut type_map: std::collections::HashMap<TaskType, Vec<String>> = std::collections::HashMap::new();
            for (tt, id) in members {
                type_map.entry(*tt).or_default().push(id.clone());
            }

            // 层序 P→C→D→A→T→R:缺层时跳过缺失层直连(如无 T 则 A→R),
            // 否则 R 层节点在图上孤立(拆解允许缺层,链必须不断)。
            let layer_order = [
                TaskType::P,
                TaskType::C,
                TaskType::D,
                TaskType::A,
                TaskType::T,
                TaskType::R,
            ];
            let mut prev_layer: Option<TaskType> = None;
            for layer in layer_order {
                let Some(ids) = type_map.get(&layer) else { continue };
                if let Some(from_type) = prev_layer {
                    if let Some(from_ids) = type_map.get(&from_type) {
                        for from_id in from_ids {
                            for to_id in ids {
                                if !existing_pair.contains(&(from_id.clone(), to_id.clone())) {
                                    tracing::debug!("[Scanner] Auto PCDATR chain: {} → {}", from_id, to_id);
                                    edges.push(TaskEdge {
                                        from: from_id.clone(),
                                        to: to_id.clone(),
                                    });
                                }
                            }
                        }
                    }
                }
                prev_layer = Some(layer);
            }
        }
    }

    tracing::info!("[Scanner] Total edges created: {}", edges.len());

    // 根锚定：只收根 task + 引用链可达 + 各自 agents/ 子树（详见 anchor_to_root 文档）
    let (nodes, edges) = anchor_to_root(nodes, edges, base_path);

    TaskGraph {
        nodes,
        edges,
        base_path: base_path.to_string(),
        scanned_at: chrono::Utc::now().to_rfc3339(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_scan_wxbot_test() {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent().unwrap()
            .parent().unwrap()
            .join("wxbot_test");

        if !base.exists() {
            eprintln!("Skipping test: wxbot_test directory not found at {:?}", base);
            return;
        }

        let result = scan_tasks(&base);
        assert!(result.errors.is_empty(), "Scan errors: {:?}", result.errors);

        let tasks = &result.tasks;
        assert!(tasks.len() >= 6, "Expected at least 6 tasks, got {}", tasks.len());

        let graph = build_graph(tasks, base.to_str().unwrap());

        let ids: Vec<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"wxbot"), "Missing root node 'wxbot', got: {:?}", ids);
        assert!(ids.contains(&"p-monitor"), "Missing P node, got: {:?}", ids);
        assert!(ids.contains(&"c-understand"), "Missing C node, got: {:?}", ids);
        assert!(ids.contains(&"d-normal"), "Missing D node, got: {:?}", ids);
        assert!(ids.contains(&"d-urgent"), "Missing D node, got: {:?}", ids);
        assert!(ids.contains(&"a-reply"), "Missing A node, got: {:?}", ids);

        let edge_pairs: Vec<(&str, &str)> = graph.edges.iter()
            .map(|e| (e.from.as_str(), e.to.as_str()))
            .collect();

        assert!(edge_pairs.contains(&("p-monitor", "c-understand")),
            "Missing P→C edge, got: {:?}", edge_pairs);
        assert!(edge_pairs.contains(&("c-understand", "d-normal")),
            "Missing C→D(normal) edge, got: {:?}", edge_pairs);
        assert!(edge_pairs.contains(&("c-understand", "d-urgent")),
            "Missing C→D(urgent) edge, got: {:?}", edge_pairs);
        assert!(edge_pairs.contains(&("d-normal", "a-reply")),
            "Missing D(normal)→A edge, got: {:?}", edge_pairs);
        assert!(edge_pairs.contains(&("d-urgent", "a-reply")),
            "Missing D(urgent)→A edge, got: {:?}", edge_pairs);

        println!("Scan OK: {} nodes, {} edges", graph.nodes.len(), graph.edges.len());
        for e in &graph.edges {
            println!("  {} → {}", e.from, e.to);
        }
    }

    /// 根锚定成员过滤：根 + 引用链可达 + 自己 agents/ 子树；未引用的嵌套 task.md 排除
    #[test]
    fn test_root_anchored_filtering() {
        let tmp = std::env::temp_dir().join(format!("myco-anchor-{}", std::process::id()));
        let proj = tmp.join("proj");
        let write_task = |dir: &std::path::Path, id: &str, extra: &str| {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(
                dir.join("task.md"),
                format!("---\nid: {}\ntitle: {}\n{}\n---\n", id, id, extra),
            )
            .unwrap();
        };
        // 根（显式引用 sub）；agents/p-x 约定收编；sub 引用收编；noise 未引用须排除
        write_task(&proj, "root", "perception:\n  dependencies:\n    - sub");
        write_task(&proj.join("agents/p-x"), "p-x", "");
        write_task(&proj.join("sub"), "sub", "");
        write_task(&proj.join("noise"), "noise", "");

        let result = scan_tasks(&proj);
        assert_eq!(result.tasks.len(), 4, "scan finds all task.md, got {:?}", result.errors);
        let graph = build_graph(&result.tasks, proj.to_str().unwrap());
        let mut ids: Vec<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["p-x", "root", "sub"], "noise must be excluded by root anchoring");

        // 无根 task.md 的目录 → 空图（前端走"需要新建/AOP 化"空态）
        let rootless = tmp.join("rootless");
        write_task(&rootless.join("noise"), "noise", "");
        let result2 = scan_tasks(&rootless);
        let graph2 = build_graph(&result2.tasks, rootless.to_str().unwrap());
        assert!(graph2.nodes.is_empty(), "no root task.md → empty graph");
        assert!(graph2.edges.is_empty());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
