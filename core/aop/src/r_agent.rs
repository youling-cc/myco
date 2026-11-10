//! r_agent.rs — 独立 R 代理智能体:第三方客观中立的评测者(纲领四,最重要)。
//!
//! 独立性三要素:
//!   1. 独立 LLM 上下文——不共享执行者的对话历史,不受其叙事暗示;
//!   2. 独立工具——自带 read/list/bash 只读核验能力,亲自查证交付物
//!      (文件是否存在、命令是否跑通、数值是否达标),执行者自述仅作线索;
//!   3. 独立身份提示词——明确"你是第三方评审,与执行者无利益关系"。
//!
//! 产出 RVerdict{score, pass, evidence, feedback}:feedback 是给执行者的具体
//! 改进指令,驱动自强不息 loop(达标或耗尽轮次)。

use super::frames::ExecutorKind;
use super::llm::{LlmBlock, LlmClient, LlmMessage};
use super::plan::{extract_json_text, repair_json};
use super::tools::ToolRunner;

/// R 评审结论。
#[derive(Debug, Clone)]
pub struct RVerdict {
    pub score: Option<f64>,
    pub pass: bool,
    /// 评分依据(点名哪条标准达标/未达标)。
    pub evidence: String,
    /// 给执行者的具体改进指令(pass=true 时为空)。
    pub feedback: String,
}

/// 独立 R 代理。每次评审新建(上下文干净,不带历史轮次暗示)。
pub struct RAgent {
    llm: LlmClient,
    runner: ToolRunner,
}

/// 第三方中立评审系统提示词。要点:独立性声明、亲自核验、不以自述为据。
const R_AGENT_SYSTEM: &str = r#"你是独立的 R 评审智能体——AOP(Agent-Oriented Programming,面向智能体编程)任务执行质量的第三方审查者。
你与执行者(无论是 AI 子代理还是人类)无任何利益关系:没有参与它的实现过程,看不到它的对话历史,只收到它的交付物清单与 R 评价标准。

评审纪律:
1. 亲自核验,不轻信:用 read/list/bash 工具亲自检查交付物——文件是否存在、内容是否兑现契约、数值是否真实达标。执行者的自述仅作线索,必须经你独立验证才作数。
2. 能跑就跑:有测试就跑测试,有统计就自己统计(如行数用 find /c /v "" 复核),不要凭文件片段臆断。
3. 对照每一条 R 标准逐一判定:达标/未达标/无证据。
4. 评分公正:score 0-1;pass 要求 score >= 0.7 且关键标准无硬伤。宁可严格,不可放水——你的信誉就是第三方中立性。
5. 未达标时给出具体可执行的 feedback:哪条标准未达标、缺什么、执行者下一步该做什么(改哪个文件/补哪个验证)。feedback 会直接回灌给执行者重跑。

工具可用 read/list/bash(路径相对任务根目录)。bash 用于核验命令;不要修改任何交付物(你是评审,不是执行者)。
工具调用克制:每条 R 标准最多 2-3 次工具调用——先 list 看交付物清单,再针对性 read 关键行/跑关键命令;不要通读全部文件。证据够就评分,别把轮次耗在冗余阅读上。
核验完毕后,只输出一个 JSON 对象(不要代码围栏、注释、多余文字;字符串内不要裸双引号,用『』):
{"score":0.85,"pass":true,"evidence":"逐条说明哪条标准达标/未达标及实测依据","feedback":"未达标时的改进指令;达标则空串"}"#;

impl RAgent {
    pub fn new(proxy_base: &str, proxy_token: &str, model: Option<&str>, task_dir: std::path::PathBuf) -> Self {
        Self {
            llm: LlmClient::new(proxy_base, proxy_token, model),
            runner: ToolRunner::new(task_dir),
        }
    }

    /// 独立评审一个子任务的交付。返回 (verdict, 评审过程帧文本摘要)。
    ///
    /// - `subtask_md`: 子任务归约 task.md(含 in/out/R 标准——评审依据);
    /// - `deliverable_note`: 执行者自述的交付说明(线索,非证据);
    /// - `attempt`: 自强不息轮次(写进 user 消息,让评审知道这是第几轮复评);
    /// - `executor_kind`: agent/human——人工交付同样评审,口径一致;
    /// - `on_tool`: 每次评审工具调用的回调(产帧流给 UI 直播)。
    pub async fn evaluate(
        &self,
        subtask_md: &str,
        deliverable_note: &str,
        attempt: u32,
        executor_kind: ExecutorKind,
        on_tool: &(dyn Fn(&str, &str) + Send + Sync),
    ) -> RVerdict {
        let tools = super::tools::r_tool_defs();
        let mut user = format!(
            "【第 {attempt} 轮评审】执行者类别:{}\n\n子任务契约(task.md):\n{}\n\n执行者自述(线索,须你独立核验):\n{}\n\n请开始核验并评分。",
            executor_kind.as_str(),
            subtask_md,
            if deliverable_note.is_empty() { "(无)" } else { deliverable_note },
        );

        // glm-5.3(思考型)核验节奏慢:12 轮在"环境探测"级简单子任务上也会耗尽
        // (09:2x 实测,反馈"交付物复杂度超出评审核验能力")。16 给余量。
        const MAX_TURNS: usize = 16;
        for _ in 0..MAX_TURNS {
            let result = self
                .llm
                .stream_turn(R_AGENT_SYSTEM, vec![LlmMessage::user_text(user.clone())], Some(&tools), 8192)
                .await;
            let turn = match result {
                Ok(t) => t,
                Err(e) => {
                    return RVerdict {
                        score: None,
                        pass: false,
                        evidence: format!("R 评审调用失败: {e}"),
                        feedback: String::new(),
                    }
                }
            };
            if turn.tool_uses.is_empty() {
                let verdict = Self::parse_verdict(&turn.text);
                // 不可解析 → 一次重格式化机会(同一评审,只要求重排为 JSON,
                // 不换上下文不重新核验——独立性保持,避免白白烧掉一轮自强不息)
                if verdict.score.is_none() && verdict.evidence.starts_with("评审输出不可解析") {
                    let retry = self
                        .llm
                        .stream_turn(
                            R_AGENT_SYSTEM,
                            vec![LlmMessage::user_text(format!(
                                "{user}\n\n你刚才的结论文本(不是合法 JSON):\n{}\n\n把同一判定结论逐字填进下面模板的对应字段,只输出填好的 JSON,其它一个字都不要:\n{{\"score\":<0-1小数>,\"pass\":<true|false>,\"evidence\":<你的验证依据原文>,\"feedback\":<改进指令或空串>}}",
                                turn.text.chars().take(3000).collect::<String>()
                            ))],
                            None,
                            8192,
                        )
                        .await;
                    if let Ok(t2) = retry {
                        let v2 = Self::parse_verdict(&t2.text);
                        if !(v2.score.is_none() && v2.evidence.starts_with("评审输出不可解析")) {
                            return v2;
                        }
                    }
                }
                return verdict;
            }
            // 评审的工具循环:执行核验工具,结果回灌(单消息上下文——每轮重述,
            // 保证独立性;工具结果累积进 user 消息尾部)
            let mut results = Vec::new();
            for tu in &turn.tool_uses {
                let out = self.runner.run(&tu.name, &tu.input).await;
                on_tool(&tu.name, &out);
                results.push(format!(
                    "[{}] {} => {}",
                    tu.name,
                    serde_json::to_string(&tu.input).unwrap_or_default(),
                    out.chars().take(1500).collect::<String>()
                ));
            }
            user.push_str(&format!(
                "\n\n你的核验工具结果:\n{}\n\n继续核验或输出最终 JSON 评分。",
                results.join("\n")
            ));
        }
        RVerdict {
            score: None,
            pass: false,
            evidence: "R 评审超过工具轮次上限未产出结论(按未达标处理)".to_string(),
            feedback: "交付物复杂度超出评审核验能力,请简化交付或拆分".to_string(),
        }
    }

    /// 解析评审 JSON;失败走 repair_json 兜底,再失败按未达标。
    fn parse_verdict(text: &str) -> RVerdict {
        let extracted = extract_json_text(text);
        let repaired = repair_json(&extracted);
        match serde_json::from_str::<serde_json::Value>(&repaired) {
            Ok(v) => RVerdict {
                score: v.get("score").and_then(|s| s.as_f64()).map(|s| s.clamp(0.0, 1.0)),
                pass: v.get("pass").and_then(|p| p.as_bool()).unwrap_or(false),
                evidence: v.get("evidence").and_then(|e| e.as_str()).unwrap_or("").to_string(),
                feedback: v.get("feedback").and_then(|f| f.as_str()).unwrap_or("").to_string(),
            },
            Err(e) => {
                // 自然语言兜底:思考型模型(glm-5.3)偶发无视 JSON 纪律但结论写得很清楚
                //(实测:"基于我的独立验证…**验证总结:** …未达标…")——从文本保守提取:
                //显式"达标"且无"未达标"才算过;score 取 0-1 区间首个小数,缺省按判定给。
                if let Some(nl) = Self::parse_verdict_text_fallback(text) {
                    tracing::warn!("[aop/r_agent] 评审 JSON 解析失败,走自然语言兜底: {e}");
                    return nl;
                }
                tracing::warn!("[aop/r_agent] 评审 JSON 解析失败: {e}");
                RVerdict {
                    score: None,
                    pass: false,
                    evidence: format!("评审输出不可解析(按未达标处理): {}", text.chars().take(200).collect::<String>()),
                    feedback: "评审通道故障,请检查交付物是否完整后重试".to_string(),
                }
            }
        }
    }

    /// 自然语言结论文本兜底解析:评审写成了验证总结而非 JSON 时保守提取。
    /// 提取不到任何判定线索(连"达标/未达标"都没有)才返回 None 走通道故障。
    fn parse_verdict_text_fallback(text: &str) -> Option<RVerdict> {
        let has_fail = text.contains("未达标") || text.contains("不达标") || text.contains("关键缺陷");
        let has_pass = text.contains("达标") || text.contains("通过");
        if !has_fail && !has_pass {
            return None;
        }
        let pass = has_pass && !has_fail;
        // score:取 0-1 区间第一个小数(如 0.85/0.5);没有则按判定给保守值
        let mut score = None;
        for cap in text.split(|c: char| !c.is_ascii_digit() && c != '.') {
            if let Ok(v) = cap.parse::<f64>() {
                if (0.0..=1.0).contains(&v) && cap.contains('.') {
                    score = Some(v);
                    break;
                }
            }
        }
        let score = score.unwrap_or(if pass { 0.75 } else { 0.35 });
        Some(RVerdict {
            score: Some(score),
            pass: score >= 0.7 && pass,
            evidence: format!("[自然语言评审摘录] {}", text.chars().take(400).collect::<String>()),
            feedback: if pass {
                String::new()
            } else {
                let idx = text.find("改进").or_else(|| text.find("需要")).or_else(|| text.find("建议")).unwrap_or(0);
                text.chars().skip(idx).take(300).collect()
            },
        })
    }
}

// LlmBlock 引用保留(未来若改多消息上下文会用到 assistant 块构造)。
#[allow(dead_code)]
fn _unused(_: &LlmBlock) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdict_parses_clean_json() {
        let v = RAgent::parse_verdict(r#"{"score":0.9,"pass":true,"evidence":"r1 达标","feedback":""}"#);
        assert!(v.pass);
        assert_eq!(v.score, Some(0.9));
        assert!(v.feedback.is_empty());
    }

    #[test]
    fn verdict_fail_carries_feedback() {
        let v = RAgent::parse_verdict(
            r#"```json
            {"score":0.4,"pass":false,"evidence":"r2 无证据","feedback":"补上 agents/p-scan/list.txt 的实测行数"}
            ```"#,
        );
        assert!(!v.pass);
        assert!(v.feedback.contains("list.txt"));
    }

    #[test]
    fn verdict_unparseable_defaults_fail() {
        let v = RAgent::parse_verdict("完全是自然语言,没有 JSON");
        assert!(!v.pass);
        assert!(v.score.is_none());
        assert!(!v.feedback.is_empty());
    }
}
