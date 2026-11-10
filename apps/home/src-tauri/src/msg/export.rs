//! 影子读导出（MSG-20 / T104）：`conv_log` → camelCase JSON。
//!
//! 契约来自 `eval/vnet/task-messaging.md` §4.2 ②（影子读：双读对比，只记录差异）
//! 与 MSG-20 工具书（`eval/msg/shadow/`）：
//!
//! ```json
//! {
//!   "convId": "did_youling_zfriend1",
//!   "messages": [
//!     { "msgId": "...", "seq": 1, "direction": "out", "kind": "Chat",
//!       "wireKind": "text", "payload": { "text": "hello one" }, "createdMs": 1790000000100 }
//!   ],
//!   "cursor": null
//! }
//! ```
//!
//! 三条硬约束（写代码时不要绕过）：
//!
//! 1. **只读**：导出路径只有 [`Store::conv_log_rows`] / [`Store::outbox_rows`]；
//!    CLI 用 [`Store::open_read_only`] 打开库，不建表、不改 PRAGMA、不推进 cursor。
//!    影子读阶段“只记录差异、不改变行为”在这里是代码级保证，不是口头约定。
//! 2. **按 `seq` 升序**：`conv_log` 的主键顺序就是新栈的会话顺序；迁移已经按
//!    旧 UI 的 `(ts,msgId)` 口径赋过 seq，导出层**不再重排**（重排会掩盖乱序 bug）。
//! 3. **payload 原样**：字节能解析成 JSON 就内联成 JSON 值（迁移数据就是旧 payload
//!    对象），否则按 UTF-8 字符串输出（任务书允许“可能是 JSON 字符串”）；
//!    非法 UTF-8 字节用 U+FFFD 替换，绝不 panic。
//!
//! `kind` 是新栈的四值类别（`Chat/Notice/Task/Control`），`wireKind` 是旧 wire kind
//! （`text/image/group-msg/...`，只有迁移数据有值，可能为 `null`）。对比器据此可以
//! 选择“按类别比”还是“按旧词表原样比”。

use crate::msg::{MsgRow, Result, Store};
use serde_json::{Map, Value};

/// 导出格式标识（写进 README / 日志，不进 JSON：对外契约固定为三个顶层键）。
pub const EXPORT_FORMAT: &str = "store-proto-export/1";

/// 导出一条会话消息。
#[derive(Debug, Clone, PartialEq)]
pub struct ExportMessage {
    /// 全局幂等键（旧 `msgId`，迁移不改写）。
    pub msg_id: String,
    /// 会话内单调序号（快照顺序的唯一权威）。
    pub seq: i64,
    /// `out` / `in`。
    pub direction: String,
    /// 新栈类别：`Chat` / `Notice` / `Task` / `Control`。
    pub kind: String,
    /// 旧 wire kind（`text`/`image`/`group-msg`/...；新数据可能为 `None`）。
    pub wire_kind: Option<String>,
    /// 业务 payload（JSON 值；解析不了时为字符串）。
    pub payload: Value,
    /// 消息时间（旧 `ts`，epoch ms）。
    pub created_ms: i64,
}

impl ExportMessage {
    /// 从存储行构造（`payload` 按 [`payload_value`] 原样转 JSON）。
    pub fn from_row(row: &MsgRow) -> Self {
        Self {
            msg_id: row.msg_id.clone(),
            seq: row.seq,
            direction: row.direction.as_str().to_string(),
            kind: row.kind.as_str().to_string(),
            wire_kind: row.wire_kind.clone(),
            payload: payload_value(&row.payload),
            created_ms: row.created_ms,
        }
    }

    /// 转成 camelCase JSON 对象（字段集合固定 7 个）。
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("msgId".to_string(), Value::String(self.msg_id.clone()));
        map.insert("seq".to_string(), Value::from(self.seq));
        map.insert(
            "direction".to_string(),
            Value::String(self.direction.clone()),
        );
        map.insert("kind".to_string(), Value::String(self.kind.clone()));
        map.insert(
            "wireKind".to_string(),
            match &self.wire_kind {
                Some(kind) => Value::String(kind.clone()),
                None => Value::Null,
            },
        );
        map.insert("payload".to_string(), self.payload.clone());
        map.insert("createdMs".to_string(), Value::from(self.created_ms));
        Value::Object(map)
    }
}

/// 导出的一条 outbox 行（仅在 `--outbox` 时出现）。
///
/// 只给对账需要的字段：`ackLevel` 是**消息级聚合水位**（`accepted`/`durable`/
/// `delivered`/`read`），对比器按 `ackLevel < delivered` 判“还算待发”。
#[derive(Debug, Clone, PartialEq)]
pub struct ExportOutboxItem {
    /// 全局幂等键。
    pub msg_id: String,
    /// 消息类别。
    pub kind: String,
    /// 优先级（0=P0）。
    pub priority: i32,
    /// 聚合 ACK 水位文本。
    pub ack_level: String,
    /// 已尝试投递次数。
    pub attempts: i64,
    /// 入队时刻（旧 outbox 的 `ts`）。
    pub created_ms: i64,
    /// TTL 边界（`None` = 不过期）。
    pub expires_ms: Option<i64>,
    /// 目标设备快照（per-target 行的来源）。
    pub targets: Vec<String>,
}

impl ExportOutboxItem {
    /// 从存储行构造。
    pub fn from_row(row: &MsgRow) -> Self {
        Self {
            msg_id: row.msg_id.clone(),
            kind: row.kind.as_str().to_string(),
            priority: row.priority,
            ack_level: row.ack_level.as_str().to_string(),
            attempts: row.attempts,
            created_ms: row.created_ms,
            expires_ms: row.expires_ms,
            targets: row.targets.clone(),
        }
    }

    /// 转成 camelCase JSON 对象。
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("msgId".to_string(), Value::String(self.msg_id.clone()));
        map.insert("kind".to_string(), Value::String(self.kind.clone()));
        map.insert("priority".to_string(), Value::from(self.priority));
        map.insert(
            "ackLevel".to_string(),
            Value::String(self.ack_level.clone()),
        );
        map.insert("attempts".to_string(), Value::from(self.attempts));
        map.insert("createdMs".to_string(), Value::from(self.created_ms));
        map.insert(
            "expiresMs".to_string(),
            match self.expires_ms {
                Some(ms) => Value::from(ms),
                None => Value::Null,
            },
        );
        map.insert(
            "targets".to_string(),
            Value::Array(
                self.targets
                    .iter()
                    .map(|target| Value::String(target.clone()))
                    .collect(),
            ),
        );
        Value::Object(map)
    }
}

/// 一次会话导出的完整文档。
#[derive(Debug, Clone, PartialEq)]
pub struct ExportDoc {
    /// 会话 id（原样，保留 did_safe 形态）。
    pub conv_id: String,
    /// 按 `seq` 升序的消息。
    pub messages: Vec<ExportMessage>,
    /// outbox 行；`None` = 没要求导出（JSON 里不出现该键）。
    pub outbox: Option<Vec<ExportOutboxItem>>,
    /// 顶层 `cursor`；默认 `None`（影子读不消费游标，故意不报进度）。
    pub cursor: Option<i64>,
}

impl ExportDoc {
    /// 转成对外 JSON：顶层键恰好 `convId` / `messages` / `cursor`（+ 可选 `outbox`）。
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("convId".to_string(), Value::String(self.conv_id.clone()));
        map.insert(
            "messages".to_string(),
            Value::Array(self.messages.iter().map(ExportMessage::to_value).collect()),
        );
        if let Some(outbox) = &self.outbox {
            map.insert(
                "outbox".to_string(),
                Value::Array(outbox.iter().map(ExportOutboxItem::to_value).collect()),
            );
        }
        map.insert(
            "cursor".to_string(),
            match self.cursor {
                Some(seq) => Value::from(seq),
                None => Value::Null,
            },
        );
        Value::Object(map)
    }

    /// 序列化成紧凑 JSON 字符串。
    pub fn to_json_string(&self) -> String {
        serde_json::to_string(&self.to_value())
            .expect("export document is always serialisable (no non-finite floats)")
    }

    /// 序列化成 2 空格缩进 JSON 字符串（落盘用，便于人读/diff）。
    pub fn to_pretty_json_string(&self) -> String {
        serde_json::to_string_pretty(&self.to_value())
            .expect("export document is always serialisable (no non-finite floats)")
    }
}

/// 把 `conv_log.payload` 字节转成 JSON 值：能解析就内联，否则按字符串原样保留。
pub fn payload_value(bytes: &[u8]) -> Value {
    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
        return value;
    }
    Value::String(String::from_utf8_lossy(bytes).into_owned())
}

/// 导出某会话的 `conv_log`（按 `seq` 升序）。
///
/// 空会话返回 `messages: []`（**不是错误**）：影子读对比里“新侧为空”由对比器判
/// `no_data`，存储层不替它决定语义。
pub fn export_conversation(store: &Store, conv_id: &str) -> Result<ExportDoc> {
    let rows = store.conv_log_rows(conv_id)?;
    Ok(ExportDoc {
        conv_id: conv_id.to_string(),
        messages: rows.iter().map(ExportMessage::from_row).collect(),
        outbox: None,
        cursor: None,
    })
}

/// 同 [`export_conversation`]，额外导出该会话的 outbox 行（MSG-20 维度 ⑤）。
pub fn export_conversation_with_outbox(store: &Store, conv_id: &str) -> Result<ExportDoc> {
    let mut doc = export_conversation(store, conv_id)?;
    let rows = store.outbox_rows(conv_id)?;
    doc.outbox = Some(rows.iter().map(ExportOutboxItem::from_row).collect());
    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::msg::MsgKind;
    use serde_json::json;

    #[test]
    fn payload_is_passed_through_as_json_or_string() {
        // 旧数据：payload 是对象
        assert_eq!(
            payload_value(br#"{"text":"hello one"}"#),
            json!({"text": "hello one"})
        );
        // 任务书允许“payload 可能是 JSON 字符串”：非法 JSON 一律按字符串保留
        assert_eq!(payload_value(b"plain text"), json!("plain text"));
        assert_eq!(payload_value(b""), json!(""));
        // 迁移在旧行缺 payload 时写 b"null"
        assert_eq!(payload_value(b"null"), Value::Null);
        // 非法 UTF-8 不 panic，用替换字符兜底
        let lossy = payload_value(&[0xff, 0xfe]);
        assert!(lossy.is_string());
        assert!(lossy.as_str().unwrap().contains('\u{fffd}'));
    }

    #[test]
    fn export_doc_uses_camel_case_keys_and_null_cursor() {
        let doc = ExportDoc {
            conv_id: "conv-1".to_string(),
            messages: vec![ExportMessage {
                msg_id: "m-1".to_string(),
                seq: 1,
                direction: "out".to_string(),
                kind: MsgKind::Chat.as_str().to_string(),
                wire_kind: Some("text".to_string()),
                payload: json!({"text": "hi"}),
                created_ms: 1_790_000_000_100,
            }],
            outbox: None,
            cursor: None,
        };
        let value = doc.to_value();
        let mut top: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
        top.sort_unstable();
        assert_eq!(top, vec!["convId", "cursor", "messages"]);
        assert!(value["cursor"].is_null());
        assert_eq!(value["convId"].as_str(), Some("conv-1"));

        let message = &value["messages"][0];
        let mut keys: Vec<&str> = message
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "createdMs",
                "direction",
                "kind",
                "msgId",
                "payload",
                "seq",
                "wireKind"
            ]
        );
        assert_eq!(message["seq"].as_i64(), Some(1));
        assert_eq!(message["createdMs"].as_i64(), Some(1_790_000_000_100));
        assert_eq!(
            message["payload"].as_object(),
            serde_json::json!({"text": "hi"}).as_object()
        );

        // 紧凑/缩进两种序列化都必须是合法 JSON 且内容等价
        let compact: Value = serde_json::from_str(&doc.to_json_string()).unwrap();
        let pretty: Value = serde_json::from_str(&doc.to_pretty_json_string()).unwrap();
        assert_eq!(compact, value);
        assert_eq!(pretty, value);
    }
}
