//! plan.rs — PCDATR 拆解产物的类型、JSON 提取/修复与校验。
//!
//! 拆解 LLM 输出 JSON(可能包在代码围栏里、可能带尾逗号/注释),先做
//! 保守提取(取首尾大括号区间)再修复尾逗号,解析失败时把原文交回调用方
//! 用于重试提示(带"上次输出不合 JSON"的反馈)。

use serde::{Deserialize, Serialize};

use super::LAYER_ORDER;

/// 一个子任务 = 任务图上的一个节点 = PCDATR 中的一项。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubTask {
    /// P | C | D | A | T | R
    pub layer: String,
    /// 目录名(agents/<slug>/):`<layer小写>-<动作>`,如 p-scan / d-route
    pub slug: String,
    pub title: String,
    pub goal: String,
    /// 输入/前置(渲染进子任务 task.md 的 O 观察输入)
    #[serde(rename = "in", default)]
    pub inputs: Vec<String>,
    /// 产出/交付(渲染进 A 动作空间)
    #[serde(default)]
    pub out: Vec<String>,
    /// 可验证的 R 评价标准(R 评价器对照打分)
    #[serde(rename = "r_criteria", default)]
    pub r_criteria: Vec<String>,
    /// 执行者绑定(纲领五):"agent"(默认,本地子 Agent) | "human"(人类,Soul DID)
    /// | "did:myco:*"(远程 DID Agent,discovery 委托 seam)。
    #[serde(default)]
    pub executor: Option<String>,
    /// 子任务级时间目标(绝对日期时间/相对 3d·12h/探索型 "explore")。
    /// 硬约束:executor="human" 时必填(人类任务无时间目标即红灯,解析期拒收)。
    #[serde(default)]
    pub deadline: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AopPlan {
    pub title: String,
    pub r_summary: String,
    pub subtasks: Vec<SubTask>,
    /// plan 制品路径(纲领三:实施计划必须留存挂任务树节点)。
    /// 形如 `.aop/plans/20260814-021500-plan.md`,write_plan_artifact 后回填。
    #[serde(default)]
    pub plan_file: Option<String>,
}

impl AopPlan {
    /// 按 P→C→D→A→T→R 层序排序后的子任务(执行顺序)。
    pub fn in_layer_order(&self) -> Vec<&SubTask> {
        let mut order: Vec<&SubTask> = self.subtasks.iter().collect();
        order.sort_by_key(|st| {
            LAYER_ORDER
                .iter()
                .position(|l| *l == st.layer)
                .unwrap_or(usize::MAX)
        });
        order
    }
}

/// 从 LLM 回复中提取 JSON 文本:剥代码围栏 → 取首尾大括号区间 → 修尾逗号。
pub fn extract_json_text(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    // 剥 ```json ... ``` 围栏
    if let Some(inner) = s.strip_prefix("```") {
        if let Some(inner) = inner.split_once('\n') {
            s = inner.1.to_string();
        }
        if let Some(inner) = s.strip_suffix("```") {
            s = inner.trim().to_string();
        }
    }
    // 取首 `{` 到末 `}` 区间
    let start = s.find('{');
    let end = s.rfind('}');
    match (start, end) {
        (Some(a), Some(b)) if b > a => s[a..=b].to_string(),
        _ => s,
    }
}

/// 保守修复:去掉行尾 `,` 后紧跟 `}`/`]` 的尾逗号、剥 // 行注释(JSON 无注释)。
pub fn repair_json(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        // 行注释整行剥掉(拆解 LLM 偶发在 JSON 行尾加说明)
        if trimmed.starts_with("//") {
            continue;
        }
        // 去除行内 "  //..." 注释(避开 http:// 场景——值内双斜杠前有冒号时不剥,
        // 简单启发式:只在引号闭合且 // 前是空白或引号时剥;这里用保守策略,只剥
        // 行首注释,行内注释交给 parse 失败重试。)
        out.push(line.to_string());
    }
    let mut text = out.join("\n");
    // 尾逗号修复:`,}` / `,]` → `}` / `]`
    loop {
        let before = text.clone();
        text = text.replace(",}", "}").replace(",]", "]");
        if text == before {
            break;
        }
    }
    repair_unescaped_quotes(&text)
}

/// 字符串值内的未转义直引号 → 转义。状态机:字符串内遇到 `"`,
/// 若其后(跳过空白)是 `,`/`}`/`]`/`:`/换行或文末 → 字符串闭合;
/// 否则判定为值内引述文本的裸引号 → 前插 `\`。
fn repair_unescaped_quotes(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 16);
    let mut in_string = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && in_string {
            // 已有转义:原样复制转义序列,不误判其后的引号
            out.push(c);
            if i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            if !in_string {
                in_string = true;
                out.push(c);
                i += 1;
                continue;
            }
            let mut j = i + 1;
            while j < chars.len() && matches!(chars[j], ' ' | '\t' | '\r') {
                j += 1;
            }
            let closes = j >= chars.len() || matches!(chars[j], ',' | '}' | ']' | ':' | '\n');
            if closes {
                in_string = false;
                out.push(c);
            } else {
                out.push('\\');
                out.push(c);
            }
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// 解析并校验拆解 JSON;失败返回原文(供重试提示)。
pub fn parse_plan(raw: &str) -> Result<AopPlan, String> {
    let extracted = extract_json_text(raw);
    let repaired = repair_json(&extracted);
    let mut plan: AopPlan = serde_json::from_str(&repaired).map_err(|e| {
        // 把原始输出交回调用方做重试反馈
        format!("JSON 解析失败: {e}\n---\n{extracted}")
    })?;

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for st in &mut plan.subtasks {
        st.layer = st.layer.trim().to_uppercase();
        if !LAYER_ORDER.contains(&st.layer.as_str()) {
            return Err(format!(
                "子任务 '{}' 的 layer '{}' 不合法(应为 P/C/D/A/T/R)",
                st.title, st.layer
            ));
        }
        st.slug = slugify(&st.slug);
        if st.title.trim().is_empty() || st.goal.trim().is_empty() {
            return Err(format!("子任务 '{}' 缺少 title/goal", st.slug));
        }
        if st.r_criteria.is_empty() {
            return Err(format!("子任务 '{}' 缺少 R 评价标准(r_criteria)", st.slug));
        }
        // 硬约束(SMART-T,人类执行者):human 子任务必须带 deadline(可写 "explore"
        // 声明探索型豁免计时)。人类任务无时间目标=无限挂起风险,解析期拒收,
        // 由重试提示强制 LLM 补全。
        if st.executor.as_deref().map(|e| e.trim().eq_ignore_ascii_case("human")).unwrap_or(false)
            && st.deadline.as_deref().map(|d| d.trim().is_empty()).unwrap_or(true)
        {
            return Err(format!(
                "子任务 '{}' 执行者是人类(human),必须给 deadline(绝对日期如 2026-08-20/相对 3d·12h/探索型写 explore)——人类任务无时间目标即红灯",
                st.slug
            ));
        }
        if let Some(d) = st.deadline.as_mut() {
            let t = d.trim().to_string();
            *d = t;
        }
        // slug 去重:重复则加 -2/-3 后缀
        let mut unique = st.slug.clone();
        let mut i = 2;
        while !seen.insert(unique.clone()) {
            unique = format!("{}-{}", st.slug, i);
            i += 1;
        }
        st.slug = unique;
    }
    if plan.subtasks.is_empty() {
        return Err("拆解结果没有子任务".to_string());
    }
    if plan.title.trim().is_empty() {
        plan.title = "AOP 任务".to_string();
    }
    Ok(plan)
}

/// slug 规范化:小写、非 [a-z0-9-] 转 `-`、连续 `-` 折叠、去首尾 `-`。
fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for c in s.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// 校验失败重试的系统提示追加内容。
pub fn retry_hint(feedback: &str) -> String {
    format!(
        "上次输出解析失败:{}。请只输出一个合法的 JSON 对象,不要代码围栏、注释或多余文字。",
        feedback
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"好的,拆解如下:
```json
{
  "title": "微信群客服",
  "r_summary": "回复准确、及时、可追溯",
  "subtasks": [
    {"layer": "P", "slug": "p-monitor", "title": "消息监听", "goal": "监听群消息", "in": ["group_id"], "out": ["raw_message"], "r_criteria": ["消息不丢失 > 99%"]},
    {"layer": "D", "slug": "d-route", "title": "路由", "goal": "决定回复策略", "in": ["understanding"], "out": ["action"], "r_criteria": ["路由准确 > 95%"],}
  ]
}
```"#;

    #[test]
    fn extracts_fenced_json() {
        let s = extract_json_text(SAMPLE);
        assert!(s.starts_with('{') && s.ends_with('}'));
        let plan = parse_plan(SAMPLE).expect("应能解析");
        assert_eq!(plan.subtasks.len(), 2);
        assert_eq!(plan.subtasks[0].layer, "P");
        assert_eq!(plan.subtasks[0].slug, "p-monitor");
        assert_eq!(plan.subtasks[0].inputs, vec!["group_id"]);
        // 尾逗号被修复
        assert_eq!(plan.subtasks[1].r_criteria, vec!["路由准确 > 95%"]);
    }

    #[test]
    fn rejects_bad_layer_and_missing_r() {
        let bad_layer = r#"{"title":"t","r_summary":"","subtasks":[{"layer":"X","slug":"x","title":"t","goal":"g","r_criteria":["r"]}]}"#;
        assert!(parse_plan(bad_layer).is_err());
        let no_r = r#"{"title":"t","r_summary":"","subtasks":[{"layer":"A","slug":"a","title":"t","goal":"g"}]}"#;
        assert!(parse_plan(no_r).is_err());
    }

    #[test]
    fn repairs_unescaped_quotes_in_string_values() {
        // 实况:LLM 在 evidence 值里用未转义直引号引述文本 → 修复后应可解析
        let raw = r#"{"score":1.0,"pass":true,"evidence":"满足"总计等于精确求和且无截断"的标准。"}"#;
        let repaired = repair_json(raw);
        let v: serde_json::Value = serde_json::from_str(&repaired).expect("修复后应可解析");
        assert_eq!(v["score"], 1.0);
        assert_eq!(v["pass"], true);
        assert_eq!(v["evidence"], "满足\"总计等于精确求和且无截断\"的标准。");
    }

    #[test]
    fn repair_keeps_legal_json_unchanged() {
        let ok = r#"{"score":0.5,"evidence":"他说\\"好\\"","pass":false}"#;
        let repaired = repair_json(ok);
        let v: serde_json::Value = serde_json::from_str(&repaired).expect("合法 JSON 不应被破坏");
        assert_eq!(v["score"], 0.5);
    }

    #[test]
    fn dedups_slugs_and_orders_layers() {
        let dup = r#"{"title":"t","r_summary":"","subtasks":[
            {"layer":"A","slug":"a-fix","title":"1","goal":"g","r_criteria":["r"]},
            {"layer":"P","slug":"a-fix","title":"2","goal":"g","r_criteria":["r"]}]}"#;
        let plan = parse_plan(dup).unwrap();
        assert_ne!(plan.subtasks[0].slug, plan.subtasks[1].slug);
        let ordered = plan.in_layer_order();
        assert_eq!(ordered[0].layer, "P");
        assert_eq!(ordered[1].layer, "A");
    }

    #[test]
    fn human_executor_requires_deadline() {
        // human 无 deadline → 拒收(硬约束)
        let no_dl = r#"{"title":"t","r_summary":"","subtasks":[
            {"layer":"A","slug":"a-confirm","title":"人工确认","goal":"g","r_criteria":["r"],"executor":"human"}]}"#;
        let err = parse_plan(no_dl).unwrap_err();
        assert!(err.contains("deadline"), "错误信息应点名 deadline: {err}");
        // human + 空串 deadline → 同样拒收
        let blank_dl = r#"{"title":"t","r_summary":"","subtasks":[
            {"layer":"A","slug":"a-confirm","title":"人工确认","goal":"g","r_criteria":["r"],"executor":"human","deadline":"  "}]}"#;
        assert!(parse_plan(blank_dl).is_err());
        // human + 绝对日期 → 通过
        let with_dl = r#"{"title":"t","r_summary":"","subtasks":[
            {"layer":"A","slug":"a-confirm","title":"人工确认","goal":"g","r_criteria":["r"],"executor":"human","deadline":"2026-08-20"}]}"#;
        let plan = parse_plan(with_dl).unwrap();
        assert_eq!(plan.subtasks[0].deadline.as_deref(), Some("2026-08-20"));
        // human + explore(探索型豁免) → 通过
        let explore = r#"{"title":"t","r_summary":"","subtasks":[
            {"layer":"P","slug":"p-explore","title":"人工调研","goal":"g","r_criteria":["r"],"executor":"human","deadline":"explore"}]}"#;
        assert!(parse_plan(explore).is_ok());
        // agent 无 deadline → 通过(软约束:任务级红灯,不拒收)
        let agent_no_dl = r#"{"title":"t","r_summary":"","subtasks":[
            {"layer":"A","slug":"a-fix","title":"修","goal":"g","r_criteria":["r"]}]}"#;
        assert!(parse_plan(agent_no_dl).is_ok());
    }
}
