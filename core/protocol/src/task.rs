//! Task 类型定义
//!
//! 任务状态、优先级和 task.md 前端字段类型

use serde::{Deserialize, Serialize};

/// 任务状态
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    #[default]
    Pending,
    Running,
    Completed,
    Failed,
    Blocked,
    Active,  // Agent 运行状态
}

impl std::fmt::Display for TaskStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TaskStatus::Pending => write!(f, "pending"),
            TaskStatus::Running => write!(f, "running"),
            TaskStatus::Completed => write!(f, "completed"),
            TaskStatus::Failed => write!(f, "failed"),
            TaskStatus::Blocked => write!(f, "blocked"),
            TaskStatus::Active => write!(f, "active"),
        }
    }
}

impl std::str::FromStr for TaskStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "pending" => Ok(TaskStatus::Pending),
            "running" | "in_progress" | "in-progress" => Ok(TaskStatus::Running),
            "completed" | "done" => Ok(TaskStatus::Completed),
            "failed" | "error" => Ok(TaskStatus::Failed),
            "blocked" => Ok(TaskStatus::Blocked),
            "active" => Ok(TaskStatus::Active),
            _ => Ok(TaskStatus::Pending),
        }
    }
}

/// 任务优先级
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, Ord, PartialOrd)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Low = 1,
    #[default]
    Medium = 2,
    High = 3,
    Critical = 4,
}

impl std::fmt::Display for Priority {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Priority::Critical => write!(f, "critical"),
            Priority::High => write!(f, "high"),
            Priority::Medium => write!(f, "medium"),
            Priority::Low => write!(f, "low"),
        }
    }
}

impl std::str::FromStr for Priority {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "critical" | "urgent" => Ok(Priority::Critical),
            "high" => Ok(Priority::High),
            "medium" | "normal" => Ok(Priority::Medium),
            "low" => Ok(Priority::Low),
            _ => Ok(Priority::Medium),
        }
    }
}

/// 任务类型 (Agent + PCDATR 分类法)
///
/// - `Agent` = 项目根节点，拥有 DID 和 skills，编排内部 PCDATR 调用
/// - `P|C|D|A|T|R` = PCDATR 处理管线中的 skill 节点
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, Hash)]
pub enum TaskType {
    /// Agent 根节点 — 智能体本身，包含/编排 PCDATR skills
    Agent,
    P,
    C,
    D,
    #[default]
    A,
    T,
    R,
}

impl std::fmt::Display for TaskType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let c = match self {
            TaskType::Agent => "Agent",
            TaskType::P => "P",
            TaskType::C => "C",
            TaskType::D => "D",
            TaskType::A => "A",
            TaskType::T => "T",
            TaskType::R => "R",
        };
        write!(f, "{}", c)
    }
}

impl std::str::FromStr for TaskType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "Agent" => Ok(TaskType::Agent),
            "P" => Ok(TaskType::P),
            "C" => Ok(TaskType::C),
            "D" => Ok(TaskType::D),
            "A" => Ok(TaskType::A),
            "T" => Ok(TaskType::T),
            "R" => Ok(TaskType::R),
            _ => Ok(TaskType::A),
        }
    }
}

/// Agent 引用
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRef {
    pub did: String,
}

/// 条件规格（用于依赖条件）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConditionSpec {
    /// 指标权重映射 {指标名: 权重}
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weights: Option<std::collections::HashMap<String, f32>>,
    /// 最低分数阈值
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_score: Option<f32>,
}

/// 条件（支持简单字符串或结构化规格）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Condition {
    /// 简单字符串条件（兼容旧格式）
    Simple(String),
    /// 结构化条件规格
    Structured(ConditionSpec),
}

impl Default for Condition {
    fn default() -> Self {
        // 默认条件：min_score = 0.6
        Condition::Structured(ConditionSpec {
            weights: None,
            min_score: Some(0.6),
        })
    }
}

impl Condition {
    /// 获取最低分数阈值
    pub fn min_score(&self) -> f32 {
        match self {
            Condition::Simple(_) => 0.6, // 简单条件默认 0.6
            Condition::Structured(spec) => spec.min_score.unwrap_or(0.6),
        }
    }

    /// 获取权重映射
    pub fn weights(&self) -> Option<&std::collections::HashMap<String, f32>> {
        match self {
            Condition::Simple(_) => None,
            Condition::Structured(spec) => spec.weights.as_ref(),
        }
    }
}

/// 任务引用
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRef {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<Condition>,
}

/// 依赖引用（支持简单字符串或结构化 TaskRef）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DependencyRef {
    /// 简单字符串（agent ID 如 "skill-cognition"）
    Simple(String),
    /// 完整任务引用
    Full(TaskRef),
}

impl DependencyRef {
    pub fn as_path(&self) -> &str {
        match self {
            DependencyRef::Simple(s) => s,
            DependencyRef::Full(tr) => &tr.path,
        }
    }
}

impl Default for DependencyRef {
    fn default() -> Self {
        DependencyRef::Simple(String::new())
    }
}

/// 输入定义
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputSpec {
    #[serde(rename = "type")]
    pub input_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
}

/// Reward 规格
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RewardSpec {
    pub goal: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub success_criteria: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evaluator: Option<AgentRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<f32>,
}

/// Tick 配置（定时触发）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TickConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(rename = "interval_ms", skip_serializing_if = "Option::is_none")]
    pub interval_ms: Option<u64>,
    #[serde(rename = "jitter_ms", skip_serializing_if = "Option::is_none")]
    pub jitter_ms: Option<u64>,
}

impl Default for TickConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_ms: None,
            jitter_ms: None,
        }
    }
}

/// 心跳配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(rename = "interval_ms", skip_serializing_if = "Option::is_none")]
    pub interval_ms: Option<u64>,
    #[serde(rename = "timeout_ms", skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

impl Default for HeartbeatConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_ms: None,
            timeout_ms: None,
        }
    }
}

/// Perception 规格
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerceptionSpec {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<DependencyRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inputs: Vec<InputSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<AgentRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tick: Option<TickConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heartbeat: Option<HeartbeatConfig>,
}

/// Cognition 规格
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CognitionSpec {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub understanding: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub constraints: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assumptions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoner: Option<AgentRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Decision 规格
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecisionSpec {
    #[serde(default)]
    pub approach: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alternatives: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decider: Option<AgentRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strategy: Option<String>,
}

/// Output target reference
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputTarget {
    /// 目标任务路径 (相对路径，如 ../task-cognition-001)
    pub target: String,
    /// 触发条件 (如 on_completed, on_success, on_failure)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    /// 传输协议 (如 zmq_pub, zmq_req, local)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
}

/// Action 规格
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionSpec {
    #[serde(default)]
    pub executor: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<String>,
    /// 输出目标列表 (执行流连线)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outputs: Vec<OutputTarget>,
}

/// 状态转换
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateTransition {
    pub from: TaskStatus,
    pub to: TaskStatus,
    pub condition: String,
}

/// Transition 规格
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransitionSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_time: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub state_transitions: Vec<StateTransition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orchestrator: Option<AgentRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub next_tasks: Vec<TaskRef>,
}

/// Task 元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskMeta {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
}

/// 评价条件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluationCondition {
    /// 条件表达式
    pub check: String,
    /// 人类可读描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// 评价规格（验证任务成功/失败的条件）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluationSpec {
    /// 成功条件（必须全部满足）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub success_conditions: Vec<EvaluationCondition>,
    /// 失败条件（任一满足即失败）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failure_conditions: Vec<EvaluationCondition>,
    /// 备注说明
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// 质量指标（任务输出的质量评估）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QualityMetrics {
    /// 完整度：数据是否完整 (0.0-1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completeness: Option<f32>,
    /// 正确度：结果是否准确 (0.0-1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correctness: Option<f32>,
    /// 时效性：响应速度 (0.0-1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeliness: Option<f32>,
    /// 精确度：数值精度 (0.0-1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accuracy: Option<f32>,
    /// 覆盖率：测试/扫描覆盖 (0.0-1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage: Option<f32>,
    /// 可靠性：稳定性 (0.0-1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reliability: Option<f32>,
    /// 安全性：无漏洞 (0.0-1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub security: Option<f32>,
    /// 自定义指标
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub custom: Option<serde_json::Value>,
}

/// Agent QoS 规格
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentQoSSpec {
    /// 延迟要求 (毫秒)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    /// 吞吐要求 (每秒请求数)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub throughput_rps: Option<u64>,
    /// 可用性要求 (0.0-1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub availability: Option<f32>,
}

/// Skill 规格
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSpec {
    /// Skill ID（可选，若缺失则使用 name）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Skill 名称
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Skill 类型 (P|C|D|A|T|R)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    /// 输入 Schema
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<String>,
    /// 输出 Schema
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<String>,
    /// QoS 要求
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qos: Option<AgentQoSSpec>,
}

/// Endpoint 规格
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndpointSpec {
    /// 协议 (ipc|tcp|tls|ws|wss)
    pub protocol: String,
    /// 地址
    pub address: String,
    /// 优先级
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<u32>,
}

/// Agent 规格 (用于 Discovery 注册)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSpec {
    /// Agent DID
    pub did: String,
    /// Skill 列表
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<SkillSpec>,
    /// Endpoint 列表
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub endpoints: Vec<EndpointSpec>,
}

/// Task Front Matter (YAML 部分)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskFrontMatter {
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    #[serde(rename = "type", default)]
    pub task_type: TaskType,
    /// Alternative PCDATR layer field (skill-level task.md uses `layer: P` instead of `type: P`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<TaskType>,
    /// Associated test dataset file (e.g. "traces.json")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset: Option<String>,
    /// Legacy skill_type field — ignored, type now carries PCDATR letter directly
    #[serde(rename = "skill_type", default, skip_serializing, skip_deserializing)]
    pub skill_type: Option<String>,
    #[serde(default)]
    pub status: TaskStatus,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub reward: Option<RewardSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub perception: Option<PerceptionSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cognition: Option<CognitionSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<DecisionSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<ActionSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition: Option<TransitionSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evaluation: Option<EvaluationSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<TaskMeta>,
}

impl Default for TaskFrontMatter {
    fn default() -> Self {
        Self {
            id: Some(uuid::Uuid::new_v4().to_string()),
            title: String::new(),
            task_type: TaskType::default(),
            layer: None,
            dataset: None,
            skill_type: None,
            status: TaskStatus::default(),
            priority: Priority::default(),
            created: Some(chrono::Utc::now().to_rfc3339()),
            reward: None,
            perception: None,
            cognition: None,
            decision: None,
            action: None,
            transition: None,
            evaluation: None,
            agent: None,
            meta: None,
        }
    }
}

/// 任务输出结构（执行结果）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskOutput {
    /// 业务数据
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    /// 质量指标（1-3个）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<QualityMetrics>,
    /// 错误信息（失败时）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<TaskError>,
    /// 执行元数据
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<TaskExecutionMeta>,
}

/// 任务错误信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

/// 任务执行元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskExecutionMeta {
    /// 执行耗时（毫秒）
    pub duration_ms: u64,
    /// 时间戳（ISO 8601）
    pub timestamp: String,
    /// 执行的Agent DID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor: Option<String>,
}

/// 完整的 Task (包含 Markdown body)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub front_matter: TaskFrontMatter,
    pub body: String,
    pub file_path: String,
    pub directory: String,
}

impl Task {
    pub fn id(&self) -> &str {
        self.front_matter.id.as_deref().unwrap_or("unknown")
    }

    pub fn title(&self) -> &str {
        &self.front_matter.title
    }

    pub fn status(&self) -> TaskStatus {
        self.front_matter.status
    }

    pub fn priority(&self) -> Priority {
        self.front_matter.priority
    }

    /// Returns the effective task type: prefers explicit `type`, falls back to `layer`.
    pub fn task_type(&self) -> TaskType {
        let tt = self.front_matter.task_type;
        // Agent type is always explicit, no fallback
        if tt == TaskType::Agent {
            return TaskType::Agent;
        }
        // If type is the default (A) but layer is set, use layer instead.
        // This handles skill-level task.md which uses `layer: P` instead of `type: P`.
        if tt == TaskType::default() {
            self.front_matter.layer.unwrap_or(tt)
        } else {
            tt
        }
    }
}

/// 任务图
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TaskGraph {
    #[serde(default)]
    pub nodes: Vec<TaskNode>,
    #[serde(default)]
    pub edges: Vec<TaskEdge>,
    #[serde(default)]
    pub base_path: String,
    #[serde(default)]
    pub scanned_at: String,
}

/// 任务节点 (用于图展示)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskNode {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub task_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reward: Option<RewardSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub perception: Option<PerceptionSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cognition: Option<CognitionSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<DecisionSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<ActionSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<TransitionSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<TaskMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

/// 任务边 (依赖关系)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskEdge {
    pub from: String,
    pub to: String,
}

/// 任务树节点（层次结构，用于 tree 觘图）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeNode {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_type: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    #[serde(default)]
    pub children: Vec<TreeNode>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_status_serialization() {
        let status = TaskStatus::Running;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, r#""running""#);
    }

    #[test]
    fn test_priority_ordering() {
        assert!(Priority::Critical > Priority::High);
        assert!(Priority::High > Priority::Medium);
        assert!(Priority::Medium > Priority::Low);
    }

    #[test]
    fn test_task_type_default() {
        let task_type = TaskType::default();
        assert_eq!(task_type, TaskType::A);
    }

    #[test]
    fn test_task_front_matter_default() {
        let fm = TaskFrontMatter::default();
        assert_eq!(fm.status, TaskStatus::Pending);
        assert_eq!(fm.priority, Priority::Medium);
        assert_eq!(fm.task_type, TaskType::A);
        assert!(fm.id.is_some());
    }

    #[test]
    fn test_condition_simple() {
        let json = r#"{"path": "../task-a", "condition": "completed"}"#;
        let task_ref: TaskRef = serde_json::from_str(json).unwrap();
        assert_eq!(task_ref.path, "../task-a");
        match task_ref.condition {
            Some(Condition::Simple(s)) => assert_eq!(s, "completed"),
            _ => panic!("Expected Simple condition"),
        }
    }

    #[test]
    fn test_condition_structured_min_score() {
        let json = r#"{"path": "../task-a", "condition": {"min_score": 0.7}}"#;
        let task_ref: TaskRef = serde_json::from_str(json).unwrap();
        assert_eq!(task_ref.path, "../task-a");
        match &task_ref.condition {
            Some(Condition::Structured(spec)) => {
                assert_eq!(spec.min_score, Some(0.7));
                assert!(spec.weights.is_none());
            }
            _ => panic!("Expected Structured condition"),
        }
    }

    #[test]
    fn test_condition_structured_weights() {
        let json = r#"{"path": "../task-a", "condition": {"weights": {"correctness": 0.7, "timeliness": 0.3}, "min_score": 0.8}}"#;
        let task_ref: TaskRef = serde_json::from_str(json).unwrap();
        assert_eq!(task_ref.path, "../task-a");
        match &task_ref.condition {
            Some(Condition::Structured(spec)) => {
                assert_eq!(spec.min_score, Some(0.8));
                let weights = spec.weights.as_ref().unwrap();
                assert_eq!(*weights.get("correctness").unwrap(), 0.7);
                assert_eq!(*weights.get("timeliness").unwrap(), 0.3);
            }
            _ => panic!("Expected Structured condition"),
        }
    }

    #[test]
    fn test_condition_default_min_score() {
        let json = r#"{"path": "../task-a"}"#;
        let task_ref: TaskRef = serde_json::from_str(json).unwrap();
        assert!(task_ref.condition.is_none());
    }

    #[test]
    fn test_condition_min_score_method() {
        let cond1 = Condition::Simple("completed".to_string());
        assert_eq!(cond1.min_score(), 0.6);

        let cond2 = Condition::Structured(ConditionSpec {
            weights: None,
            min_score: Some(0.8),
        });
        assert_eq!(cond2.min_score(), 0.8);

        let cond3 = Condition::Structured(ConditionSpec {
            weights: None,
            min_score: None,
        });
        assert_eq!(cond3.min_score(), 0.6);
    }

    #[test]
    fn test_layer_field_fallback() {
        // task.md with `layer: P` but no `type` should resolve to P
        let json = r#"{"title": "Test", "layer": "P"}"#;
        let fm: TaskFrontMatter = serde_json::from_str(json).unwrap();
        let task = Task {
            front_matter: fm,
            body: String::new(),
            file_path: String::new(),
            directory: String::new(),
        };
        // task_type defaults to A, but layer is P — task.task_type() should return P
        assert_eq!(task.front_matter.task_type, TaskType::A); // default
        assert_eq!(task.front_matter.layer, Some(TaskType::P));
        assert_eq!(task.task_type(), TaskType::P); // falls back to layer
    }

    #[test]
    fn test_layer_field_ignored_when_type_explicit() {
        // task.md with `type: D` should use D, ignoring any layer
        let json = r#"{"title": "Test", "type": "D"}"#;
        let fm: TaskFrontMatter = serde_json::from_str(json).unwrap();
        let task = Task {
            front_matter: fm,
            body: String::new(),
            file_path: String::new(),
            directory: String::new(),
        };
        assert_eq!(task.front_matter.task_type, TaskType::D);
        assert_eq!(task.front_matter.layer, None);
        assert_eq!(task.task_type(), TaskType::D);
    }

    #[test]
    fn test_dataset_field_parsed() {
        let json = r#"{"title": "Test", "layer": "C", "dataset": "traces.json"}"#;
        let fm: TaskFrontMatter = serde_json::from_str(json).unwrap();
        assert_eq!(fm.dataset, Some("traces.json".to_string()));
        assert_eq!(fm.layer, Some(TaskType::C));
    }

    #[test]
    fn test_task_node_dataset_serialization() {
        let node = TaskNode {
            id: "perception.scan".to_string(),
            title: "Scanner".to_string(),
            status: TaskStatus::Pending,
            priority: Some("medium".to_string()),
            task_type: Some("P".to_string()),
            dataset: Some("traces.json".to_string()),
            directory: None,
            file_path: None,
            reward: None,
            perception: None,
            cognition: None,
            decision: None,
            action: None,
            transition: None,
            agent: None,
            meta: None,
            body: None,
        };
        let json = serde_json::to_value(&node).unwrap();
        assert_eq!(json["dataset"], "traces.json");
        assert!(json.get("cognition").is_none()); // skip_serializing_if None
    }
}
