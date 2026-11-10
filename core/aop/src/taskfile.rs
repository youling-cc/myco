//! taskfile.rs — AOP 任务产物落盘:根 task.md、agents/<slug>/task.md、
//! traces.json、.aop/plan.json。
//!
//! 格式对齐 myco AOP.md §6(task.md 规范)+ wxbot_test 实际样例(被 scanner
//! 测试钉死),R 表格带 formula/unit/threshold/weight 列(parseMdp R 表格式,
//! 取自 aop-task-designer 的 R 丰富度)。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::plan::AopPlan;

pub const AOP_DIR: &str = ".aop";

/// define 阶段 LLM 产出的 ROSA(渲染进根 task.md 的 ## MDP 定义)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RosaDef {
    pub title: String,
    pub goal: String,
    /// 任务级 deadline(SMART 顶层时间目标;绝对日期或相对 "3d")。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<String>,
    /// key/formula/unit/threshold/weight/time
    pub r: Vec<RosaMetric>,
    /// key/type/desc
    pub s: Vec<RosaField>,
    pub o: Vec<RosaField>,
    pub a: Vec<RosaField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RosaMetric {
    pub key: String,
    pub formula: String,
    pub unit: String,
    pub threshold: String,
    pub weight: String,
    /// SMART 时间目标(SMART 的 T):"2026-08-20"/"2026-08-20T15:00"/相对"3d/12h"。
    /// None=该指标回答不了时间目标——看板红黄绿灯引擎直接亮红灯(用户规约)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RosaField {
    pub key: String,
    pub r#type: String,
    pub desc: String,
}

pub struct TaskWriter {
    root: PathBuf,
}

impl TaskWriter {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root_dir(&self) -> &Path {
        &self.root
    }

    pub fn root_task_md(&self) -> PathBuf {
        self.root.join("task.md")
    }

    pub fn aop_dir(&self) -> PathBuf {
        self.root.join(AOP_DIR)
    }

    pub fn plan_json(&self) -> PathBuf {
        self.aop_dir().join("plan.json")
    }

    pub fn history_jsonl(&self) -> PathBuf {
        self.aop_dir().join("history.jsonl")
    }

    pub fn subtask_dir(&self, slug: &str) -> PathBuf {
        self.root.join("agents").join(slug)
    }

    pub fn subtask_task_md(&self, slug: &str) -> PathBuf {
        self.subtask_dir(slug).join("task.md")
    }

    pub fn traces_json(&self, slug: &str) -> PathBuf {
        self.subtask_dir(slug).join("traces.json")
    }

    pub fn has_root_task_md(&self) -> bool {
        self.root_task_md().is_file()
    }

    pub fn read_root_task_md(&self) -> Option<String> {
        std::fs::read_to_string(self.root_task_md()).ok()
    }

    /// 读子任务 task.md 全文(执行上下文用)。
    pub async fn read_subtask_md(&self, slug: &str) -> Option<String> {
        tokio::fs::read_to_string(self.subtask_task_md(slug)).await.ok()
    }

    /// 读子任务 frontmatter 的 status 值。
    pub async fn read_subtask_status(&self, slug: &str) -> Option<String> {
        let body = tokio::fs::read_to_string(self.subtask_task_md(slug)).await.ok()?;
        body.lines().find_map(|l| l.strip_prefix("status:").map(|s| s.trim().to_string()))
    }

    /// 写根 task.md(define 阶段)。无条件覆盖——重定义即以新定义为准
    /// (「继续」等误触发重定义的防线在 session.rs 的 executed/interrupted 语义)。
    pub async fn write_root_task(&self, rosa: &RosaDef, status: &str) -> Result<(), String> {
        let mut r_table = String::from("| key | formula | unit | threshold | weight |\n|---|---|---|---|---|\n");
        for m in &rosa.r {
            r_table.push_str(&format!(
                "| {} | {} | {} | {} | {} |\n",
                escape_td(&m.key),
                escape_td(&m.formula),
                escape_td(&m.unit),
                escape_td(&m.threshold),
                escape_td(&m.weight),
            ));
        }
        let fields = |fs: &[RosaField]| -> String {
            fs.iter()
                .map(|f| format!("- {}: {} — {}", f.key, f.r#type, f.desc))
                .collect::<Vec<_>>()
                .join("\n")
        };

        let id = slugify_id(&rosa.title);
        let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let body = format!(
            "---\nid: {id}\ntitle: {}\ntype: Agent\nstatus: {status}\ncreated: \"{date}\"\n---\n\n## 目标\n\n{}\n\n## MDP 定义\n\n### R — 回报函数\n\n{r_table}\n### S — 状态空间\n\n{}\n\n### O — 观察空间\n\n{}\n\n### A — 动作空间\n\n{}\n",
            rosa.title,
            rosa.goal,
            fields(&rosa.s),
            fields(&rosa.o),
            fields(&rosa.a),
        );
        tokio::fs::write(self.root_task_md(), body)
            .await
            .map_err(|e| format!("写根 task.md 失败: {e}"))
    }

    /// 把 ## 子任务 契约段写进根 task.md(保留其余内容,幂等替换该段)。
    /// 格式对齐 aop-task-designer 权威约定(扁平兄弟目录 + 父任务契约段):
    /// 每个子任务一块 ### 层·标题 + layer/task/executor/goal/in/out/sub_reward 字段行,
    /// sub_reward = 对下游总得分的边际贡献。段头挂 plan 制品链接(纲领三:
    /// 实施计划必须留存并可从任务树节点关联)。兼容替换旧版 ## PCDATR 拆解 段。
    pub async fn upsert_subtasks_section(&self, plan: &AopPlan) -> Result<(), String> {
        let mut blocks = String::new();
        for st in plan.in_layer_order() {
            let executor = st.executor.as_deref().unwrap_or("agent");
            let deadline_line = st
                .deadline
                .as_deref()
                .map(|d| format!("deadline: {}\n", d.trim()))
                .unwrap_or_default();
            let list = |items: &[String]| items.join(", ");
            blocks.push_str(&format!(
                "### {} · {}\nlayer: {}\ntask: {}\nexecutor: {}\n{}goal: {}\nin: {}\nout: {}\nsub_reward: 对下游总得分的边际贡献(由独立 R 评审逐轮量化)\nr_criteria: {}\n\n",
                st.layer,
                st.title,
                st.layer,
                st.slug,
                executor,
                deadline_line,
                st.goal.trim(),
                list(&st.inputs),
                list(&st.out),
                list(&st.r_criteria),
            ));
        }
        let plan_link = plan
            .plan_file
            .as_deref()
            .map(|f| format!("实施计划:[{f}](../{f})\n\n"))
            .unwrap_or_default();
        let section = format!("\n## 子任务\n\n{plan_link}{blocks}");

        let path = self.root_task_md();
        let mut body = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| format!("读根 task.md 失败: {e}"))?;
        let idx = body
            .find("## 子任务")
            .or_else(|| body.find("## PCDATR 拆解"));
        match idx {
            Some(idx) => {
                let tail = &body[idx..];
                let end_rel = tail
                    .find("\n## ")
                    .map(|e| e + 1)
                    .unwrap_or(tail.len());
                body.replace_range(idx..idx + end_rel, section.trim_end());
            }
            None => {
                if !body.ends_with('\n') {
                    body.push('\n');
                }
                body.push_str(section.trim_end());
                body.push('\n');
            }
        }
        tokio::fs::write(&path, body)
            .await
            .map_err(|e| format!("写根 task.md 失败: {e}"))
    }

    /// plan 制品留存(纲领三):实施计划全文写 `.aop/plans/<yyyymmdd-hhmmss>-plan.md`,
    /// 返回相对路径(回填 plan.plan_file,根 task.md 契约段挂链接)。
    pub async fn write_plan_artifact(&self, plan: &AopPlan, guidance: Option<&str>) -> Result<String, String> {
        let dir = self.aop_dir().join("plans");
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| format!("建 plans 目录失败: {e}"))?;
        let fname = format!("{}-plan.md", chrono::Utc::now().format("%Y%m%d-%H%M%S"));
        let rel = format!(".aop/plans/{fname}");

        let mut md = format!(
            "# 实施计划:{}\n\n> AOP PCDATR 拆解产物 · {} · 子任务 {} 个\n\n总体 R:{}\n\n",
            plan.title,
            chrono::Utc::now().format("%Y-%m-%d %H:%M UTC"),
            plan.subtasks.len(),
            plan.r_summary.trim(),
        );
        if let Some(g) = guidance {
            md.push_str(&format!("用户修订意见:{}\n\n", g.trim()));
        }
        for st in plan.in_layer_order() {
            let executor = st.executor.as_deref().unwrap_or("agent");
            md.push_str(&format!(
                "## [{}] {}(`agents/{}/`)\n\n- 执行者:{}\n- 目标:{}\n- in:{}\n- out:{}\n- R 标准:{}\n\n",
                st.layer,
                st.title,
                st.slug,
                executor,
                st.goal.trim(),
                st.inputs.join("、"),
                st.out.join("、"),
                st.r_criteria.join("、"),
            ));
        }
        tokio::fs::write(dir.join(&fname), &md)
            .await
            .map_err(|e| format!("写 plan 制品失败: {e}"))?;
        Ok(rel)
    }

    /// 读根 task.md frontmatter 的 id(子任务 parent 指针用)。
    fn root_task_id(&self) -> String {
        self.read_root_task_md()
            .and_then(|body| {
                body.lines()
                    .find_map(|l| l.strip_prefix("id:").map(|s| s.trim().to_string()))
            })
            .unwrap_or_else(|| "aop-task".to_string())
    }

    /// 写子任务 task.md(skill 格式 + 归约指针:parent/parent_layer/executor,
    /// 对齐 aop-task-designer 扁平兄弟目录约定——子代理的归约 task.md 可挂回
    /// 父任务树节点,aop-task-designer 可渲染钻取)。
    pub async fn write_subtask(&self, st: &super::plan::SubTask, status: &str) -> Result<(), String> {
        let dir = self.subtask_dir(&st.slug);
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| format!("建子任务目录失败: {e}"))?;

        let list = |items: &[String]| -> String {
            items
                .iter()
                .map(|i| format!("- {}", i.trim()))
                .collect::<Vec<_>>()
                .join("\n")
        };
        let parent = self.root_task_id();
        let executor = st.executor.as_deref().unwrap_or("agent");
        let deadline_fm = st
            .deadline
            .as_deref()
            .map(|d| format!("deadline: {}\n", d.trim()))
            .unwrap_or_default();
        let body = format!(
            "---\nid: {}\ntitle: {}\nlayer: {}\nparent: {}\nparent_layer: {}\nexecutor: {}\n{}dataset: traces.json\nstatus: {status}\n---\n\n## 目标\n\n{}\n\n## MDP 子空间\n\n### O（观察输入）\n\n{}\n\n### A（动作空间）\n\n{}\n\n### R（评价标准）\n\n{}\n\n## 测试数据集\n参见 `traces.json`\n",
            st.slug,
            st.title,
            st.layer,
            parent,
            st.layer,
            executor,
            deadline_fm,
            st.goal,
            list(&st.inputs),
            list(&st.out),
            list(&st.r_criteria),
        );
        tokio::fs::write(self.subtask_task_md(&st.slug), body)
            .await
            .map_err(|e| format!("写子任务 task.md 失败: {e}"))
    }

    /// 子任务状态行更新(pending/running/completed/failed)。
    pub async fn update_subtask_status(&self, slug: &str, status: &str) -> Result<(), String> {
        let path = self.subtask_task_md(slug);
        let body = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| format!("读子任务 task.md 失败: {e}"))?;
        let mut lines: Vec<String> = body.lines().map(|l| l.to_string()).collect();
        let mut done = false;
        for line in lines.iter_mut() {
            if line.strip_prefix("status:").is_some() {
                *line = format!("status: {status}");
                done = true;
                break;
            }
        }
        if !done {
            // 插到 layer 行后
            if let Some(pos) = lines.iter().position(|l| l.starts_with("layer:")) {
                lines.insert(pos + 1, format!("status: {status}"));
            }
        }
        let mut out = lines.join("\n");
        out.push('\n');
        tokio::fs::write(&path, out)
            .await
            .map_err(|e| format!("更新子任务状态失败: {e}"))
    }

    /// traces.json 追加一条 o/s/a/r 帧(数组)。文件不存在则创建 `[]`。
    pub async fn append_trace(&self, slug: &str, frame: serde_json::Value) -> Result<(), String> {
        let path = self.traces_json(slug);
        let mut arr: Vec<serde_json::Value> = match tokio::fs::read_to_string(&path).await {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        arr.push(frame);
        tokio::fs::write(&path, serde_json::to_string_pretty(&arr).unwrap_or_else(|_| "[]".into()))
            .await
            .map_err(|e| format!("写 traces.json 失败: {e}"))
    }

    pub async fn write_plan_json(&self, plan: &AopPlan) -> Result<(), String> {
        tokio::fs::create_dir_all(self.aop_dir())
            .await
            .map_err(|e| format!("建 .aop 目录失败: {e}"))?;
        let json = serde_json::to_string_pretty(plan).map_err(|e| e.to_string())?;
        tokio::fs::write(self.plan_json(), json)
            .await
            .map_err(|e| format!("写 plan.json 失败: {e}"))
    }

    pub async fn read_plan_json(&self) -> Option<AopPlan> {
        let content = tokio::fs::read_to_string(self.plan_json()).await.ok()?;
        serde_json::from_str(&content).ok()
    }

    /// 历史追加一行(JSONL)。目录不存在则创建。
    pub async fn append_history_line(&self, line: &str) -> Result<(), String> {
        use tokio::io::AsyncWriteExt;
        tokio::fs::create_dir_all(self.aop_dir())
            .await
            .map_err(|e| format!("建 .aop 目录失败: {e}"))?;
        let mut content = line.to_string();
        content.push('\n');
        let mut f = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.history_jsonl())
            .await
            .map_err(|e| format!("打开历史文件失败: {e}"))?;
        f.write_all(content.as_bytes())
            .await
            .map_err(|e| format!("写历史失败: {e}"))?;
        Ok(())
    }

    pub fn load_history_lines(&self) -> Vec<String> {
        match std::fs::read_to_string(self.history_jsonl()) {
            Ok(content) => content.lines().map(|l| l.to_string()).collect(),
            Err(_) => Vec::new(),
        }
    }
}

fn escape_td(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ")
}

fn slugify_id(title: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for c in title.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    let s = out.trim_matches('-').to_string();
    if s.is_empty() { "aop-task".to_string() } else { s }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{AopPlan, SubTask};

    fn sample_plan() -> AopPlan {
        AopPlan {
            title: "测试任务".into(),
            r_summary: "s".into(),
            plan_file: None,
            subtasks: vec![
                SubTask {
                    layer: "P".into(),
                    slug: "p-scan".into(),
                    title: "扫描".into(),
                    goal: "g".into(),
                    inputs: vec!["x".into()],
                    out: vec!["y".into()],
                    r_criteria: vec!["r1 > 90%".into()],
                    executor: None,
                    deadline: None,
                },
                SubTask {
                    layer: "A".into(),
                    slug: "a-fix".into(),
                    title: "修复".into(),
                    goal: "g2".into(),
                    inputs: vec![],
                    out: vec!["z".into()],
                    r_criteria: vec!["r2".into()],
                    executor: None,
                    deadline: None,
                },
            ],
        }
    }

    #[tokio::test]
    async fn writes_subtask_and_updates_status() {
        let tmp = std::env::temp_dir().join(format!("aop-tw-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let w = TaskWriter::new(tmp.clone());

        w.write_subtask(&sample_plan().subtasks[0], "pending").await.unwrap();
        let body = std::fs::read_to_string(w.subtask_task_md("p-scan")).unwrap();
        assert!(body.contains("layer: P"));
        assert!(body.contains("status: pending"));
        assert!(body.contains("### R（评价标准）"));
        assert!(body.contains("r1 > 90%"));

        w.update_subtask_status("p-scan", "completed").await.unwrap();
        let body = std::fs::read_to_string(w.subtask_task_md("p-scan")).unwrap();
        assert!(body.contains("status: completed"));
        assert!(!body.contains("status: pending"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[tokio::test]
    async fn root_task_roundtrip_and_subtasks_section_idempotent() {
        let tmp = std::env::temp_dir().join(format!("aop-rt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let w = TaskWriter::new(tmp.clone());

        let rosa = RosaDef {
            title: "示例任务".into(),
            goal: "目标".into(),
            deadline: None,
            r: vec![RosaMetric {
                key: "acc".into(),
                formula: "准确率".into(),
                unit: "%".into(),
                threshold: ">95".into(),
                weight: "0.6".into(),
                time: None,
            }],
            s: vec![RosaField { key: "s1".into(), r#type: "string".into(), desc: "状态".into() }],
            o: vec![RosaField { key: "o1".into(), r#type: "string".into(), desc: "观测".into() }],
            a: vec![RosaField { key: "a1".into(), r#type: "string".into(), desc: "动作".into() }],
        };
        w.write_root_task(&rosa, "running").await.unwrap();
        let body = std::fs::read_to_string(w.root_task_md()).unwrap();
        assert!(body.contains("## MDP 定义"));
        assert!(body.contains("| acc | 准确率 | % | >95 | 0.6 |"));
        assert!(body.contains("type: Agent"));

        // 契约段(aop-task-designer 格式:### 层·标题 + layer/task/executor/goal/in/out/sub_reward)
        let plan = sample_plan();
        w.upsert_subtasks_section(&plan).await.unwrap();
        w.upsert_subtasks_section(&plan).await.unwrap(); // 幂等
        let body = std::fs::read_to_string(w.root_task_md()).unwrap();
        assert_eq!(body.matches("## 子任务").count(), 1);
        assert!(body.contains("### P · 扫描"));
        assert!(body.contains("task: p-scan"));
        assert!(body.contains("executor: agent"));
        assert!(body.contains("sub_reward:"));

        // 子任务归约指针(parent/parent_layer;中文标题 slug 化为 aop-task)
        w.write_subtask(&plan.subtasks[0], "pending").await.unwrap();
        let sub = std::fs::read_to_string(w.subtask_task_md("p-scan")).unwrap();
        assert!(sub.contains("parent: aop-task"));
        assert!(sub.contains("parent_layer: P"));
        assert!(sub.contains("executor: agent"));

        // plan 制品留存 + 相对路径回填格式
        let rel = w.write_plan_artifact(&plan, Some("修订:x")).await.unwrap();
        assert!(rel.starts_with(".aop/plans/"));
        assert!(rel.ends_with("-plan.md"));
        let artifact = std::fs::read_to_string(tmp.join(&rel)).unwrap();
        assert!(artifact.contains("实施计划:测试任务"));
        assert!(artifact.contains("修订:x"));
        assert!(artifact.contains("[P] 扫描"));

        std::fs::remove_dir_all(&tmp).ok();
    }
}
