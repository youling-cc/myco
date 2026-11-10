//! POMDP Agent Service
//!
//! 核心数据管理 Agent，处理 task.md 的 CRUD 操作

use anyhow::Result;
use myco_protocol::{AgentConfig, Task, TaskStatus, TaskGraph, TaskNode, TaskEdge};
use myco_transport::{RepServer, RepServerConfig, PubServer, PubServerConfig};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::parser::parse_task_file;
use crate::scanner::scan_tasks;

/// POMDP Agent
pub struct PomdpAgent {
    config: AgentConfig,
    tasks: Arc<RwLock<HashMap<String, Task>>>,
    base_path: Arc<RwLock<PathBuf>>,
    pub_server: Arc<PubServer>,
}

impl PomdpAgent {
    pub fn new(config: AgentConfig) -> Self {
        let pub_config = PubServerConfig {
            endpoint: "tcp://127.0.0.1:5556".to_string(),
        };
        Self {
            config,
            tasks: Arc::new(RwLock::new(HashMap::new())),
            base_path: Arc::new(RwLock::new(PathBuf::from("taskflow/test-tasks"))),
            pub_server: Arc::new(PubServer::new(pub_config)),
        }
    }

    /// 设置任务基础路径
    pub fn with_base_path(self, path: impl Into<PathBuf>) -> Self {
        // Use try_write since we're called before start() — the lock isn't shared yet
        if let Ok(mut bp) = self.base_path.try_write() {
            *bp = path.into();
        }
        self
    }

    /// 启动 Agent
    pub async fn start(&self) -> Result<()> {
        tracing::info!("POMDP Agent {} starting", self.config.did);

        // 启动 PUB 服务器
        self.pub_server.start().await?;
        tracing::info!("Event publisher started on tcp://127.0.0.1:5556");

        // 初始扫描任务
        self.scan_all_tasks().await?;

        // 启动 REP 服务器处理请求
        let rep_config = RepServerConfig {
            endpoint: "tcp://127.0.0.1:5555".to_string(),
        };
        let rep_server = RepServer::new(rep_config);

        let tasks = self.tasks.clone();
        let base_path = self.base_path.clone();
        let pub_server = self.pub_server.clone();

        rep_server.start(move |request| {
            let tasks = tasks.clone();
            let base_path = base_path.clone();
            let pub_server = pub_server.clone();

            async move {
                // 解析请求
                let request_str = String::from_utf8_lossy(&request);
                handle_request(&request_str, &tasks, &base_path, &pub_server).await
            }
        }).await?;

        tracing::info!("POMDP Agent {} started on tcp://127.0.0.1:5555", self.config.did);

        // 保持运行
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
        }
    }

    /// 扫描所有任务
    async fn scan_all_tasks(&self) -> Result<()> {
        let bp = self.base_path.read().await;
        tracing::info!("Scanning tasks in {:?}", bp);

        let scan_result = scan_tasks(&bp);

        let mut tasks = self.tasks.write().await;
        for task in scan_result.tasks {
            tracing::info!("Loaded task: {} - {}",
                task.front_matter.id.as_deref().unwrap_or("unknown"),
                task.front_matter.title);
            let id = task.front_matter.id.clone().unwrap_or_default();
            tasks.insert(id, task);
        }

        tracing::info!("Total tasks loaded: {}", tasks.len());
        Ok(())
    }
}

/// API 响应结构
#[derive(Debug, Serialize)]
struct ApiResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl ApiResponse {
    fn success(data: Value) -> Self {
        Self { success: true, data: Some(data), error: None }
    }

    fn error(msg: impl Into<String>) -> Self {
        Self { success: false, data: None, error: Some(msg.into()) }
    }
}

/// 处理 ZeroMQ 请求
async fn handle_request(
    request: &str,
    tasks: &Arc<RwLock<HashMap<String, Task>>>,
    base_path: &Arc<RwLock<PathBuf>>,
    pub_server: &Arc<PubServer>,
) -> Vec<u8> {
    tracing::debug!("Received request: {}", request);

    // 尝试找到 JSON payload 的开始位置
    let json_start = request.find('{');
    let (command, payload): (&str, &str) = if let Some(pos) = json_start {
        (&request[..pos].trim_end_matches(':'), &request[pos..])
    } else {
        // 没有 JSON，整个是命令
        (request.trim_end_matches(':'), "")
    };

    let response = match command {
        "task:list" => handle_task_list(tasks).await,
        "task:get" => handle_task_get(tasks, payload).await,
        "task:graph" => handle_task_graph(tasks, base_path).await,
        "task:create" => handle_task_create(tasks, base_path, payload, pub_server).await,
        "task:update" => handle_task_update(tasks, base_path, payload, pub_server).await,
        "task:delete" => handle_task_delete(tasks, base_path, payload, pub_server).await,
        "task:scan" => handle_task_scan(tasks, base_path, payload, pub_server).await,
        "ping" => ApiResponse::success(json!("pong")),
        _ => ApiResponse::error(format!("Unknown command: {}", command)),
    };

    serde_json::to_vec(&response).unwrap_or_default()
}

#[derive(Debug, Serialize, Deserialize)]
struct TaskSummary {
    id: String,
    title: String,
    status: TaskStatus,
    #[serde(rename = "type")]
    task_type: Option<String>,
    priority: Option<String>,
}

async fn handle_task_list(tasks: &Arc<RwLock<HashMap<String, Task>>>) -> ApiResponse {
    let tasks = tasks.read().await;
    let summaries: Vec<TaskSummary> = tasks.values().map(|t| TaskSummary {
        id: t.front_matter.id.clone().unwrap_or_default(),
        title: t.front_matter.title.clone(),
        status: t.front_matter.status,
        task_type: Some(t.task_type().to_string()),
        priority: Some(t.front_matter.priority.to_string()),
    }).collect();
    ApiResponse::success(json!(summaries))
}

async fn handle_task_get(tasks: &Arc<RwLock<HashMap<String, Task>>>, task_id: &str) -> ApiResponse {
    let tasks = tasks.read().await;
    let task_id = task_id.trim();
    if let Some(task) = tasks.get(task_id) {
        ApiResponse::success(json!(task))
    } else {
        ApiResponse::error(format!("Task not found: {}", task_id))
    }
}

async fn handle_task_graph(tasks: &Arc<RwLock<HashMap<String, Task>>>, base_path: &Arc<RwLock<PathBuf>>) -> ApiResponse {
    let tasks = tasks.read().await;

    // Create directory to ID map AND id-to-id map for dependency resolution
    let dir_to_id: std::collections::HashMap<String, String> = tasks.values()
        .filter_map(|t| {
            let id = t.front_matter.id.clone()?;
            let normalized_dir = t.directory.replace("\\", "/");
            Some((normalized_dir, id))
        })
        .collect();

    // Build direct ID lookup: agent id string -> agent id string
    let id_set: std::collections::HashSet<String> = tasks.values()
        .filter_map(|t| t.front_matter.id.clone())
        .collect();

    tracing::debug!("Directory to ID map: {:?}", dir_to_id);

    let nodes: Vec<TaskNode> = tasks.values().map(|t| TaskNode {
        id: t.front_matter.id.clone().unwrap_or_default(),
        title: t.front_matter.title.clone(),
        status: t.front_matter.status,
        priority: Some(t.front_matter.priority.to_string()),
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

    // Build edges with proper path resolution
    let mut edges: Vec<TaskEdge> = tasks.values()
        .filter_map(|t| {
            let to_id = t.front_matter.id.clone()?;
            let t_dir = t.directory.clone();
            if let Some(perception) = &t.front_matter.perception {
                Some(perception.dependencies.iter().filter_map(|dep| {
                    let dep_path = dep.as_path();

                    // Case 1: Direct agent ID reference (no path separators)
                    if !dep_path.contains('/') && !dep_path.contains('\\') && !dep_path.starts_with('.') {
                        if id_set.contains(dep_path) {
                            tracing::debug!("Edge: direct ID match '{}' -> '{}'", dep_path, to_id);
                            return Some(TaskEdge {
                                from: dep_path.to_string(),
                                to: to_id.clone(),
                            });
                        }
                    }

                    // Case 2: Path-based reference (../, ./, etc.)
                    let resolved = if dep_path.starts_with("../") {
                        // Count and strip all ../ prefixes
                        let mut path_remaining = dep_path;
                        let mut current_dir = std::path::PathBuf::from(&t_dir);

                        while path_remaining.starts_with("../") {
                            path_remaining = &path_remaining[3..];
                            if let Some(parent) = current_dir.parent() {
                                current_dir = parent.to_path_buf();
                            } else {
                                return None; // Can't go up further
                            }
                        }

                        current_dir.join(path_remaining)
                    } else if dep_path.starts_with("./") {
                        let rel = dep_path.trim_start_matches("./");
                        std::path::Path::new(&t_dir).join(rel)
                    } else {
                        std::path::PathBuf::from(dep_path)
                    };

                    // Canonicalize to match the keys in dir_to_id
                    let canonical = resolved.canonicalize().unwrap_or(resolved);
                    let mut normalized = canonical.to_string_lossy().replace("\\", "/");
                    // Strip Windows UNC prefix (\\?\) which breaks path matching
                    if normalized.starts_with("//?/") {
                        normalized = normalized[4..].to_string();
                    }

                    tracing::debug!("Edge: resolved '{}' -> '{}'", dep.as_path(), normalized);

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

    // Auto-generate PCDATR chain edges for skill-level tasks without explicit dependencies
    let existing_pair: std::collections::HashSet<(String, String)> = edges.iter()
        .map(|e| (e.from.clone(), e.to.clone()))
        .collect();

    {
        use myco_protocol::TaskType;

        // Group tasks by parent directory
        let mut groups: std::collections::HashMap<String, Vec<(TaskType, String)>> = std::collections::HashMap::new();
        for t in tasks.values() {
            let group_key = std::path::Path::new(&t.directory)
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
            // 否则 R 层节点在图上孤立(与 scanner.rs build_graph 同一语义)。
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
                                    tracing::debug!("Auto PCDATR chain: {} → {}", from_id, to_id);
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

    let bp = base_path.read().await;
    let base_path_str = bp.to_string_lossy().to_string();

    // 根锚定：只收根 task + 引用链可达 + 各自 agents/ 子树（项目目录绑定根 task.md）
    let (nodes, edges) = crate::scanner::anchor_to_root(nodes, edges, &base_path_str);

    tracing::info!("Task graph: {} nodes, {} edges", nodes.len(), edges.len());

    ApiResponse::success(json!(TaskGraph {
        nodes,
        edges,
        base_path: base_path_str,
        scanned_at: chrono::Utc::now().to_rfc3339(),
    }))
}

async fn handle_task_create(
    tasks: &Arc<RwLock<HashMap<String, Task>>>,
    base_path: &Arc<RwLock<PathBuf>>,
    payload: &str,
    pub_server: &Arc<PubServer>,
) -> ApiResponse {
    let create_req: Result<TaskCreateRequest, _> = serde_json::from_str(payload);

    match create_req {
        Ok(req) => {
            let id = format!("task-{}", chrono::Utc::now().format("%Y%m%d%H%M%S"));
            let bp = base_path.read().await;
            let task_dir = bp.join(&id);
            let task_file = task_dir.join("task.md");

            // 创建目录
            if let Err(e) = std::fs::create_dir_all(&task_dir) {
                return ApiResponse::error(format!("Failed to create directory: {}", e));
            }

            // 写入 task.md
            let content = format!(r#"---
id: {}
title: "{}"
type: {}
status: pending
priority: {}
created: {}

reward:
  goal: "{}"
---

# {}

{}
"#,
                id,
                req.title,
                req.task_type.unwrap_or_else(|| "action".to_string()),
                req.priority.unwrap_or_else(|| "medium".to_string()),
                chrono::Utc::now().to_rfc3339(),
                req.goal.as_deref().unwrap_or(""),
                req.title,
                req.description.as_deref().unwrap_or("")
            );

            if let Err(e) = std::fs::write(&task_file, content) {
                return ApiResponse::error(format!("Failed to write task file: {}", e));
            }

            // 重新扫描
            let mut tasks = tasks.write().await;
            if let Ok(task) = parse_task_file(&task_file) {
                tasks.insert(id.clone(), task.clone());

                // 发布事件
                let event = json!({
                    "event": "task:created",
                    "taskId": id,
                    "task": task
                });
                let _ = pub_server.publish("tasks", &serde_json::to_vec(&event).unwrap()).await;
            }

            ApiResponse::success(json!(id))
        }
        Err(e) => ApiResponse::error(format!("Invalid request: {}", e))
    }
}

async fn handle_task_scan(
    tasks: &Arc<RwLock<HashMap<String, Task>>>,
    base_path: &Arc<RwLock<PathBuf>>,
    payload: &str,
    pub_server: &Arc<PubServer>,
) -> ApiResponse {
    // Parse optional path from payload
    let scan_path = if payload.is_empty() {
        base_path.read().await.clone()
    } else {
        #[derive(Debug, Deserialize)]
        struct ScanRequest {
            path: String,
        }
        match serde_json::from_str::<ScanRequest>(payload) {
            Ok(req) => {
                let path = PathBuf::from(&req.path);
                if path.is_absolute() {
                    // Update base_path to the scanned directory
                    let mut bp = base_path.write().await;
                    *bp = path.clone();
                    path
                } else {
                    let bp = base_path.read().await;
                    bp.join(&req.path)
                }
            }
            Err(_) => base_path.read().await.clone()
        }
    };

    tracing::info!("Scanning tasks in: {:?}", scan_path);
    let scan_result = scan_tasks(&scan_path);

    let mut tasks = tasks.write().await;
    tasks.clear();

    let count = scan_result.tasks.len();
    for task in scan_result.tasks {
        let id = task.front_matter.id.clone().unwrap_or_default();
        tasks.insert(id, task);
    }

    // 发布事件 (非阻塞，忽略错误)
    let event = json!({
        "event": "tasks:scanned",
        "count": count
    });
    let pub_server = pub_server.clone();
    tokio::spawn(async move {
        let _ = pub_server.publish("tasks", &serde_json::to_vec(&event).unwrap()).await;
    });

    ApiResponse::success(json!(count))
}

#[derive(Debug, Serialize, Deserialize)]
struct TaskCreateRequest {
    title: String,
    #[serde(rename = "type")]
    task_type: Option<String>,
    priority: Option<String>,
    goal: Option<String>,
    description: Option<String>,
}

/// 更新任务
async fn handle_task_update(
    tasks: &Arc<RwLock<HashMap<String, Task>>>,
    _base_path: &Arc<RwLock<PathBuf>>,
    payload: &str,
    pub_server: &Arc<PubServer>,
) -> ApiResponse {
    let update_req: Result<TaskUpdateRequest, _> = serde_json::from_str(payload);

    match update_req {
        Ok(req) => {
            let task_id = req.id.trim();
            let mut tasks = tasks.write().await;

            if let Some(task) = tasks.get(task_id) {
                // 获取任务文件路径
                let task_dir = task.directory.clone();
                let task_file = PathBuf::from(&task_dir).join("task.md");

                if !task_file.exists() {
                    return ApiResponse::error(format!("Task file not found: {:?}", task_file));
                }

                // 读取现有内容
                let content = match std::fs::read_to_string(&task_file) {
                    Ok(c) => c,
                    Err(e) => return ApiResponse::error(format!("Failed to read task file: {}", e)),
                };

                // 更新 YAML front matter 中的 status(+可选 deadline 覆写:探索模式)
                let updated_content = update_status_in_content(&content, &req.status);
                let updated_content = match &req.deadline {
                    Some(dl) => update_deadline_in_content(&updated_content, dl),
                    None => updated_content,
                };

                // 写回文件
                if let Err(e) = std::fs::write(&task_file, updated_content) {
                    return ApiResponse::error(format!("Failed to write task file: {}", e));
                }

                // 重新解析并更新内存中的任务
                match parse_task_file(&task_file) {
                    Ok(updated_task) => {
                        let summary = TaskSummary {
                            id: updated_task.front_matter.id.clone().unwrap_or_default(),
                            title: updated_task.front_matter.title.clone(),
                            status: updated_task.front_matter.status,
                            task_type: Some(updated_task.front_matter.task_type.to_string()),
                            priority: Some(updated_task.front_matter.priority.to_string()),
                        };
                        tasks.insert(task_id.to_string(), updated_task.clone());

                        // 发布事件
                        let event = json!({
                            "event": "task:updated",
                            "taskId": task_id,
                            "status": req.status
                        });
                        let _ = pub_server.publish("tasks", &serde_json::to_vec(&event).unwrap()).await;

                        ApiResponse::success(json!(summary))
                    }
                    Err(e) => ApiResponse::error(format!("Failed to parse updated task: {}", e))
                }
            } else {
                ApiResponse::error(format!("Task not found: {}", task_id))
            }
        }
        Err(e) => ApiResponse::error(format!("Invalid request: {}", e))
    }
}

/// 删除任务
async fn handle_task_delete(
    tasks: &Arc<RwLock<HashMap<String, Task>>>,
    _base_path: &Arc<RwLock<PathBuf>>,
    payload: &str,
    pub_server: &Arc<PubServer>,
) -> ApiResponse {
    let delete_req: Result<TaskDeleteRequest, _> = serde_json::from_str(payload);

    match delete_req {
        Ok(req) => {
            let task_id = req.id.trim();
            let mut tasks = tasks.write().await;

            if let Some(task) = tasks.remove(task_id) {
                // 删除任务目录
                let task_dir = PathBuf::from(&task.directory);
                if task_dir.exists() {
                    if let Err(e) = std::fs::remove_dir_all(&task_dir) {
                        tracing::warn!("Failed to delete task directory: {}", e);
                        // 即使删除目录失败，也从内存中移除
                    }
                }

                // 发布事件
                let event = json!({
                    "event": "task:deleted",
                    "taskId": task_id
                });
                let _ = pub_server.publish("tasks", &serde_json::to_vec(&event).unwrap()).await;

                ApiResponse::success(json!({ "deleted": task_id }))
            } else {
                ApiResponse::error(format!("Task not found: {}", task_id))
            }
        }
        Err(e) => ApiResponse::error(format!("Invalid request: {}", e))
    }
}

/// 在 Markdown 内容中更新 status 字段
fn update_status_in_content(content: &str, new_status: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let mut result: Vec<String> = Vec::new();
    let mut in_front_matter = false;
    let mut front_matter_ended = false;

    for line in &lines {
        if *line == "---" {
            if !in_front_matter {
                in_front_matter = true;
            } else {
                front_matter_ended = true;
            }
            result.push(line.to_string());
        } else if in_front_matter && !front_matter_ended {
            if line.starts_with("status:") {
                result.push(format!("status: {}", new_status));
            } else {
                result.push(line.to_string());
            }
        } else {
            result.push(line.to_string());
        }
    }

    result.join("\n")
}

/// deadline 覆写(upsert):空串=删行;否则替换或追加到 front matter。
/// 探索模式经此写 "explore: 轻目标"(蓝灯判定=deadline 含 explore/探索)。
fn yaml_safe(v: &str) -> String {
    // 含冒号/引号的值必须加引号(explore: 目标 曾让 YAML parse error)
    if v.contains(':') || v.contains('"') {
        format!("\"{}\"", v.replace('"', ""))
    } else {
        v.to_string()
    }
}

/// deadline 覆写(upsert):空串=删行;否则替换或追加到 front matter。
/// 探索模式经此写 "explore: 轻目标"(蓝灯判定=deadline 含 explore/探索)。
fn update_deadline_in_content(content: &str, new_deadline: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let mut result: Vec<String> = Vec::new();
    let mut in_front_matter = false;
    let mut front_matter_ended = false;
    let mut replaced = false;
    for line in &lines {
        if *line == "---" {
            if !in_front_matter {
                in_front_matter = true;
            } else {
                if !replaced && !new_deadline.is_empty() {
                    result.push(format!("deadline: {}", yaml_safe(new_deadline)));
                }
                front_matter_ended = true;
            }
            result.push(line.to_string());
        } else if in_front_matter && !front_matter_ended {
            if line.starts_with("deadline:") {
                if new_deadline.is_empty() {
                    continue;
                }
                result.push(format!("deadline: {}", yaml_safe(new_deadline)));
                replaced = true;
            } else {
                result.push(line.to_string());
            }
        } else {
            result.push(line.to_string());
        }
    }
    result.join("
")
}

#[derive(Debug, Serialize, Deserialize)]
struct TaskUpdateRequest {
    id: String,
    status: String,
    /// 可选 deadline 覆写(S2 探索模式):None=不动;Some("explore: 轻目标")=蓝灯;
    /// Some(日期)=正常 SMART deadline。空串=清除。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deadline: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TaskDeleteRequest {
    id: String,
}
