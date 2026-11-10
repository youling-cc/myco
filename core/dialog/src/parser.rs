//! PCDATR Parser - 解析 LLM 响应中的任务定义
//!
//! 从 LLM 返回的 JSON 中提取任务信息

use regex::Regex;
use serde::{Deserialize, Serialize};

/// 任务计划
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskPlan {
    pub title: String,
    pub goal: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub task_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<String>,
}

/// 任务列表
#[derive(Debug, Deserialize)]
pub struct TaskPlanList {
    pub tasks: Vec<TaskPlan>,
}

/// 解析 LLM 响应中的任务
pub fn parse_tasks(response: &str) -> Vec<TaskPlan> {
    // 查找 JSON 代码块
    let json_re = Regex::new(r"```json\s*([\s\S]*?)```").unwrap();

    if let Some(caps) = json_re.captures(response) {
        if let Some(json_str) = caps.get(1) {
            if let Ok(list) = serde_json::from_str::<TaskPlanList>(json_str.as_str()) {
                return list.tasks;
            }
        }
    }

    Vec::new()
}
