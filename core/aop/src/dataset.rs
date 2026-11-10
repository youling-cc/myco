//! dataset.rs — 数据集记录(AOP 范式基建:人机协作过程语料,不止 myco 自用)。
//!
//! 打开后,会话事件落盘 `.aop/datasets/<ts>.jsonl`(v2 格式,首行 header + 每事件单调 seq):
//!   {"kind":"header","v":2,"format":"myco-aop-dataset","seq":0,...}
//!   {"kind":"message","seq":N,"message":{...},"at":...}     聊天消息(回放端聊天视图数据源)
//!   {"kind":"state","seq":N,"appState":...,"fineState":...} live 粗细态(gen 徽章)
//!   {"kind":"turn/start"|"turn/end","seq":N,"reason":...}   轮边界(崩溃回放平衡用)
//!   {"kind":"frame","seq":N,"frame":{...},"at":...}         o/s/a/r 过程帧(时间线)
//!   {"kind":"plan","seq":N,"plan":{...},"marks":{...}}      拆解+运行态(任务图)
//!   {"kind":"sensor","seq":N,"source":..., "payload":{...}} 原始符号观测(C 层输入语料)
//!     source 开放枚举:terminal/llm/session_file/user_input(编程 harness);
//!     机器人/RPA 等项目可扩 vision/odom/dom…同一 schema。
//! 回放:前端把事件序列 apply 进影子会话(sessionId=replay-<id>),现有全部视图
//! 零改动渲染任意历史时刻——界面=状态的纯函数,数据集即时间机器。
//! 崩溃平衡:读侧(不写盘)发现 turn/start 无配对 turn/end 时,补合成
//! turn/end{reason:"interrupted"}(对齐 dsh 的 crash-recovery 纪律:不截断、只平衡)。

use std::io::Write;
use std::path::PathBuf;

pub const FORMAT_VERSION: u32 = 2;

pub struct DatasetWriter {
    file: std::fs::File,
    pub path: PathBuf,
    pub events: u64,
}

impl DatasetWriter {
    pub fn create(task_dir: &std::path::Path, session_id: &str, cwd: &str, harness: &str) -> Result<Self, String> {
        let dir = task_dir.join(".aop").join("datasets");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let name = format!("{}.jsonl", chrono::Utc::now().format("%Y%m%d-%H%M%S"));
        let path = dir.join(name);
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path)
            .map_err(|e| format!("打开数据集失败: {e}"))?;
        let mut w = Self { file, path, events: 0 };
        // 首行 header:版本/会话/上下文。读取方按 v 分派;版本不符明确拒绝(fail-closed),
        // 不静默跳过——静默续跑残缺会话比报错危险。
        w.write_raw(&serde_json::json!({
            "kind": "header", "v": FORMAT_VERSION, "format": "myco-aop-dataset", "seq": 0,
            "session": session_id, "cwd": cwd, "harness": harness,
            "createdAt": chrono::Utc::now().to_rfc3339(),
        }));
        Ok(w)
    }

    /// 写一个事件:自动盖单调 seq。事件体自带 kind 字段。
    pub fn write(&mut self, v: &serde_json::Value) {
        let mut obj = match v {
            serde_json::Value::Object(m) => m.clone(),
            _ => return,
        };
        self.events += 1;
        obj.insert("seq".into(), serde_json::json!(self.events));
        self.write_raw(&serde_json::Value::Object(obj));
    }

    fn write_raw(&mut self, v: &serde_json::Value) {
        if let Ok(mut line) = serde_json::to_string(v) {
            line.push('\n');
            let _ = self.file.write_all(line.as_bytes());
            let _ = self.file.flush();
        }
    }
}

/// 崩溃平衡(纯函数,读侧使用):事件流里 turn/start 无配对 turn/end →
/// 追加合成 turn/end{reason:"interrupted"}。不修改磁盘,只修返回流。
/// v1 数据集(无 header)原样返回(legacy 兼容)。
pub fn balance_turns(events: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    let has_header = events.first()
        .and_then(|e| e.get("kind"))
        .and_then(|k| k.as_str()) == Some("header");
    if !has_header {
        return events; // v1 legacy:无轮边界概念,原样
    }
    let mut open = false;
    let mut max_seq = 0u64;
    for e in &events {
        match e.get("kind").and_then(|k| k.as_str()) {
            Some("turn/start") => open = true,
            Some("turn/end") => open = false,
            _ => {}
        }
        if let Some(s) = e.get("seq").and_then(|s| s.as_u64()) {
            max_seq = max_seq.max(s);
        }
    }
    if open {
        let mut out = events;
        out.push(serde_json::json!({
            "kind": "turn/end", "seq": max_seq + 1, "reason": "interrupted",
            "at": chrono::Utc::now().to_rfc3339(),
        }));
        out
    } else {
        events
    }
}

/// 列出任务目录下全部数据集(按 mtime 倒序)。
pub fn list_datasets(task_dir: &std::path::Path) -> Vec<serde_json::Value> {
    let dir = task_dir.join(".aop").join("datasets");
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut out: Vec<(std::time::SystemTime, serde_json::Value)> = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".jsonl") { continue; }
        let meta = match e.metadata() { Ok(m) => m, Err(_) => continue };
        let mtime = meta.modified().ok();
        // 头尾各读一点统计消息/帧数(轻量:按行扫关键词)
        let (mut msgs, mut frames) = (0u64, 0u64);
        if let Ok(body) = std::fs::read_to_string(e.path()) {
            for l in body.lines() {
                if l.contains("\"kind\":\"message\"") { msgs += 1; }
                if l.contains("\"kind\":\"frame\"") { frames += 1; }
            }
        }
        out.push((mtime.unwrap_or(std::time::SystemTime::UNIX_EPOCH), serde_json::json!({
            "id": e.path().display().to_string(),
            "name": name,
            "messages": msgs,
            "frames": frames,
            "bytes": meta.len(),
        })));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|(_, v)| v).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_written_and_seq_monotonic() {
        let dir = std::env::temp_dir().join(format!("aop-ds-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        {
            let mut w = DatasetWriter::create(&dir, "s1", "D:/x", "aop").unwrap();
            w.write(&serde_json::json!({"kind":"message","message":{"role":"user","text":"hi"}}));
            w.write(&serde_json::json!({"kind":"state","appState":"working"}));
        }
        let body = std::fs::read_to_string(&w_path(&dir)).unwrap();
        let mut lines = body.lines();
        let header: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(header["kind"], "header");
        assert_eq!(header["v"], FORMAT_VERSION);
        assert_eq!(header["session"], "s1");
        let e1: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        let e2: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(e1["seq"], 1);
        assert_eq!(e2["seq"], 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unbalanced_turn_gets_synthetic_end() {
        let evs = vec![
            serde_json::json!({"kind":"header","v":2,"seq":0}),
            serde_json::json!({"kind":"turn/start","seq":1}),
            serde_json::json!({"kind":"message","seq":2}),
        ];
        let out = balance_turns(evs);
        assert_eq!(out.last().unwrap()["kind"], "turn/end");
        assert_eq!(out.last().unwrap()["reason"], "interrupted");
        assert_eq!(out.last().unwrap()["seq"], 3);
    }

    #[test]
    fn balanced_and_v1_untouched() {
        let balanced = vec![
            serde_json::json!({"kind":"header","v":2,"seq":0}),
            serde_json::json!({"kind":"turn/start","seq":1}),
            serde_json::json!({"kind":"turn/end","seq":2,"reason":"done"}),
        ];
        assert_eq!(balance_turns(balanced.clone()).len(), 3);
        let v1 = vec![serde_json::json!({"kind":"message","message":{}})];
        assert_eq!(balance_turns(v1.clone()).len(), 1);
    }

    fn w_path(dir: &std::path::Path) -> PathBuf {
        let d = dir.join(".aop").join("datasets");
        let mut f: Option<PathBuf> = None;
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            f = Some(e.path());
        }
        f.unwrap()
    }
}
