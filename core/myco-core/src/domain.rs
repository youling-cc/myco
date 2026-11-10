//! Domain types — OSAR-aligned response shapes shared across command layers.
//!
//! These are the data-contract output types returned by the PCDATR command
//! layers (task graph nodes/edges, browse results, agent/skill info). They are
//! pure data with no behavior and no layer coupling, so every command layer can
//! reference the same canonical definition.

// ========================================
// Task graph response types
// ========================================

/// Task list entry (ZMQ task:list item).
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct TaskInfo {
    pub id: String,
    pub title: String,
    pub status: String,
    #[serde(rename = "type")]
    pub task_type: Option<String>,
    pub priority: Option<String>,
}

/// Task graph response (ZMQ task:graph).
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct TaskGraphResponse {
    pub nodes: Vec<TaskNodeResponse>,
    pub edges: Vec<TaskEdgeResponse>,
    pub base_path: Option<String>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct TaskNodeResponse {
    pub id: String,
    pub title: String,
    pub status: String,
    #[serde(rename = "type")]
    pub task_type: Option<String>,
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset: Option<String>,
    pub directory: Option<String>,
    pub file_path: Option<String>,
    pub reward: Option<RewardInfo>,
    pub perception: Option<PerceptionInfo>,
    pub action: Option<ActionInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewardInfo {
    pub goal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub success_criteria: Option<Vec<String>>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct PerceptionInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependencies: Option<serde_json::Value>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct DependencyInfo {
    pub path: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ActionInfo {
    pub executor: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commands: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outputs: Option<Vec<OutputInfo>>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct OutputInfo {
    pub target: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct TaskEdgeResponse {
    pub from: String,
    pub to: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct AgentInfo {
    pub did: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<SkillInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub endpoints: Vec<EndpointInfo>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct SkillInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<String>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct EndpointInfo {
    pub protocol: String,
    pub address: String,
}

// ========================================
// Directory browse types (P-layer observation shape)
// ========================================

#[derive(Debug, serde::Serialize)]
pub struct BrowseResult {
    pub current: String,
    pub parent: Option<String>,
    pub directories: Vec<DirEntry>,
    pub is_root: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drives: Option<Vec<String>>,
}

#[derive(Debug, serde::Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
}

// ========================================
// Pure domain util
// ========================================

/// Generate a slug from arbitrary text (lowercase, hyphen-separated,
/// alphanumeric-only). Shared by provider id generation and task scaffolding.
pub fn slugify(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}
