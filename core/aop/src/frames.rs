//! frames.rs — O/S/A/R 过程数据帧:执行透明化的唯一数据源(纲领二)。
//!
//! 每次工具调用/评审/人工交付产出一帧,双流分发:
//!   1. 流式推 UI(AopEvent::Frame → 过程视图的 P 呈现插件消费,像看直播);
//!   2. 落盘 `.aop/traces/<session>.jsonl`(每行一帧,自含时间戳/层/轮次)——
//!      任务全部达标时整条轨迹复制到 `~/.myco/traces/<task>-ok.jsonl`
//!      登记为回归语料(格式即可回放帧序列;runner 后续里程碑)。

use std::path::PathBuf;

use chrono::Utc;
use serde::{Deserialize, Serialize};

/// env 进程 DID(S1 粒度:整个进程一个;帧 from 与注册表 env 侧归属共用,
/// S3 再细化到 skill 级)。
pub const ENV_PROCESS_DID: &str = "did:myco:agent:env-001";

/// 执行者类别(纲领五:任何一环可委托——本地子 Agent / 远程 DID Agent / 人类)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutorKind {
    /// 本地独立子 Agent(进程内 LLM 工具循环)。
    Agent,
    /// 人类执行者(Soul DID;GUI 任务卡交付)。
    Human,
    /// 远程 DID Agent(discovery 委托;S0 seam,未实装时回退 Agent)。
    Remote,
}

impl ExecutorKind {
    /// 从 plan JSON 的 executor 字段解析(缺省/未知 → Agent)。
    pub fn parse(s: Option<&str>) -> Self {
        match s.map(|v| v.trim().to_lowercase()) {
            Some(v) if v == "human" || v == "人" || v == "人工" => Self::Human,
            Some(v) if v.starts_with("did:") => Self::Remote,
            _ => Self::Agent,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Human => "human",
            Self::Remote => "remote",
        }
    }
}

/// 一帧过程数据。o/s/a/r 四元组 + 归属(slug/layer/attempt/executor)。
/// 帧语义对齐 aop-task-designer 的 trajectory 帧约定:位置即步序,
/// 下一帧的 o/s 即上一帧的转移后果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AopFrame {
    pub session_id: String,
    /// 所属子任务 slug(任务级帧为 "task")。
    pub slug: String,
    /// P/C/D/A/T/R(任务级帧为 "-")。
    pub layer: String,
    /// 自强不息轮次(1 起;非 loop 帧为 0)。
    pub attempt: u32,
    pub executor_kind: ExecutorKind,
    /// 帧类:tool(工具调用) / eval(R 评审) / human(人工交付) / note(叙事节点)。
    #[serde(rename = "kind")]
    pub frame_kind: FrameKind,
    pub o: String,
    pub s: String,
    pub a: String,
    pub r: String,
    /// r 结构化(评测帧):分数/通过/证据。r 字符串保留人读叙事;这组供查询与
    /// 按 score/pass 过滤回放。serde default 兼容旧 traces(读回 None)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r_score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r_pass: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r_evidence: Option<String>,
    pub at: String,
    /// 发帧者 DID(S1 粒度:整个 env 进程一个 DID,session.rs emit_frame 统一
    /// 盖 "did:myco:agent:env-001";S3 再细化到 skill 级)。
    /// serde default:旧 traces.jsonl 无此字段仍可反序列化(read_all 回放兼容)。
    #[serde(default)]
    pub from: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrameKind {
    Tool,
    Eval,
    Human,
    Note,
}

impl AopFrame {
    pub fn new(
        session_id: &str,
        slug: &str,
        layer: &str,
        attempt: u32,
        executor_kind: ExecutorKind,
        frame_kind: FrameKind,
    ) -> Self {
        Self {
            session_id: session_id.to_string(),
            slug: slug.to_string(),
            layer: layer.to_string(),
            attempt,
            executor_kind,
            frame_kind,
            o: String::new(),
            s: String::new(),
            a: String::new(),
            r: String::new(),
            r_score: None,
            r_pass: None,
            r_evidence: None,
            at: Utc::now().to_rfc3339(),
            from: None,
        }
    }
}

/// 轨迹录制器:追加写 `.aop/traces/<session>.jsonl`。
pub struct TraceRecorder {
    path: PathBuf,
}

impl TraceRecorder {
    pub fn new(task_dir: &std::path::Path, session_id: &str) -> Self {
        Self {
            path: task_dir.join(".aop").join("traces").join(format!("{session_id}.jsonl")),
        }
    }

    pub async fn record(&self, frame: &AopFrame) {
        use tokio::io::AsyncWriteExt;
        if let Some(parent) = self.path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let Ok(mut line) = serde_json::to_string(frame) else { return };
        line.push('\n');
        let Ok(mut f) = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .await
        else {
            return;
        };
        let _ = f.write_all(line.as_bytes()).await;
    }

    /// 读取全部帧(SSE 重连补帧 /api/labs/frames/:id 用)。
    pub async fn read_all(&self) -> Vec<AopFrame> {
        Self::read_all_path(&self.path).await
    }

    /// 按路径读帧(重启恢复兜底:直接读 traces 最新文件,免建 recorder)。
    pub async fn read_all_path(path: &std::path::Path) -> Vec<AopFrame> {
        let Ok(body) = tokio::fs::read_to_string(path).await else {
            return Vec::new();
        };
        body.lines()
            .filter_map(|l| serde_json::from_str::<AopFrame>(l).ok())
            .collect()
    }

    /// 任务全部达标:复制整条轨迹到 `~/.myco/traces/<task>-ok.jsonl` 登记回归语料。
    pub async fn export_success(&self, task_id: &str) -> Result<PathBuf, String> {
        let dir = crate::config::home_dir()
            .ok_or("无 home 目录")?
            .join(".myco")
            .join("traces");
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| format!("建 traces 目录失败: {e}"))?;
        let safe: String = task_id.chars().map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' }).collect();
        let dst = dir.join(format!("{safe}-ok.jsonl"));
        tokio::fs::copy(&self.path, &dst)
            .await
            .map_err(|e| format!("复制轨迹失败: {e}"))?;
        Ok(dst)
    }
}

/// R3 回放产品化:任务达标归档时,把内容引用该 task_id 的传感器语料
/// (<root>/.aop/sensors/*.jsonl)一并复制到 `~/.myco/traces/sensors/`——
/// 达标轨迹与可精确回放的现场语料同柜存放,回归/复盘成套。
pub async fn archive_related_sensors(project_root: &std::path::Path, task_id: &str) -> Result<usize, String> {
    let sdir = project_root.join(".aop").join("sensors");
    let mut rd = match tokio::fs::read_dir(&sdir).await {
        Ok(r) => r,
        Err(_) => return Ok(0), // 无 sensors 目录=没录过,正常
    };
    let out_dir = crate::config::home_dir()
        .ok_or("无 home 目录")?
        .join(".myco")
        .join("traces")
        .join("sensors");
    let mut copied = 0usize;
    while let Ok(Some(e)) = rd.next_entry().await {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(body) = tokio::fs::read_to_string(&p).await else { continue };
        if !body.contains(task_id) {
            continue;
        }
        tokio::fs::create_dir_all(&out_dir)
            .await
            .map_err(|e| format!("建 traces/sensors 目录失败: {e}"))?;
        let fname = p.file_name().and_then(|x| x.to_str()).unwrap_or("corpus.jsonl");
        tokio::fs::copy(&p, out_dir.join(fname))
            .await
            .map_err(|e| format!("复制语料失败: {e}"))?;
        copied += 1;
    }
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 旧格式帧(无 from 字段)必须仍可反序列化(旧 traces.jsonl 回放路径:
    /// TraceRecorder::read_all → /api/labs/frames/:id 补帧)。
    #[test]
    fn legacy_frame_without_from_deserializes() {
        let line = r#"{"sessionId":"s-legacy","slug":"task","layer":"-","attempt":0,"executorKind":"agent","kind":"tool","o":"obs","s":"state","a":"act","r":"","at":"2026-08-14T00:00:00+00:00"}"#;
        let f: AopFrame = serde_json::from_str(line).expect("旧格式帧必须可解析");
        assert_eq!(f.session_id, "s-legacy");
        assert!(f.from.is_none(), "缺 from 字段时必须反序列化为 None");
    }

    /// 新帧序列化带 from(camelCase 键),往返一致。
    #[test]
    fn frame_with_from_round_trips() {
        let mut f = AopFrame::new("s1", "term-model", "P", 1, ExecutorKind::Agent, FrameKind::Tool);
        f.from = Some("did:myco:agent:env-001".to_string());
        let json = serde_json::to_string(&f).expect("序列化失败");
        assert!(json.contains(r#""from":"did:myco:agent:env-001""#), "from 键必须输出: {json}");
        let back: AopFrame = serde_json::from_str(&json).expect("回环解析失败");
        assert_eq!(back.from.as_deref(), Some("did:myco:agent:env-001"));
    }

    /// Rust↔TS 帧契约:tests/contract/aop-frame.json(两侧同读该文件,
    /// TS 侧见 apps/phone/src/aop-frame-contract.test.ts)。逐条解析成功、
    /// 关键字段非空;含 from 的条目必须解析出 did: 前缀。
    #[test]
    fn contract_samples_all_parse() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/contract/aop-frame.json");
        let text = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("读契约文件失败 {path}: {e}"));
        let arr: Vec<serde_json::Value> =
            serde_json::from_str(&text).expect("契约文件必须是 JSON 数组");
        assert!(arr.len() >= 5, "契约样例至少 5 条,实际 {}", arr.len());
        let mut kinds = std::collections::HashSet::new();
        let mut with_from = 0usize;
        let mut without_from = 0usize;
        for (i, v) in arr.iter().enumerate() {
            let f: AopFrame = serde_json::from_str(&v.to_string())
                .unwrap_or_else(|e| panic!("契约第 {i} 条帧解析失败: {e}"));
            assert!(!f.session_id.is_empty(), "第 {i} 条 sessionId 为空");
            assert!(!f.slug.is_empty(), "第 {i} 条 slug 为空");
            assert!(!f.layer.is_empty(), "第 {i} 条 layer 为空");
            assert!(!f.at.is_empty(), "第 {i} 条 at 为空");
            kinds.insert(format!("{:?}", f.frame_kind));
            match &f.from {
                Some(did) => {
                    assert!(did.starts_with("did:"), "第 {i} 条 from 非 DID: {did}");
                    with_from += 1;
                }
                None => without_from += 1,
            }
        }
        // 四种帧类全覆盖(tool/eval/human/note),含 from 与不含 from 各有。
        assert_eq!(kinds.len(), 4, "tool/eval/human/note 四类必须齐备");
        assert!(with_from > 0 && without_from > 0, "含/不含 from 的样例必须各有");
    }
}
