//! 统一错误类型。
//!
//! 设计约束：不引入 `thiserror`/`anyhow`（离线可复现优先，减少传递依赖），
//! 手写 `Display`/`Error` 即可满足 `?` 与测试断言。

use crate::msg::types::AckLevel;
use std::fmt;

/// store-proto 的统一错误类型。
#[derive(Debug)]
pub enum Error {
    /// SQLite 层错误（约束冲突、SQL 语法、锁超时等）。
    Sqlite(rusqlite::Error),
    /// 文件系统错误（迁移读文件、建库目录）。
    Io(std::io::Error),
    /// JSON 解析/序列化错误（带来源文件路径，便于定位迁移夹具）。
    Json(String),
    /// ACK 层级回退（已确认的水位不可降低）。
    AckRegression { from: AckLevel, to: AckLevel },
    /// outbox 中不存在该 msg_id。
    UnknownMessage(String),
    /// outbox_targets 中不存在该 (msg_id, target_device)。
    UnknownTarget { msg_id: String, target: String },
    /// notice_state 中不存在该 notice_id。
    UnknownNotice(String),
    /// 入参非法（空 msgId / 空 convId / 行字段不自洽）。
    Invalid(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Sqlite(e) => write!(f, "sqlite error: {e}"),
            Error::Io(e) => write!(f, "io error: {e}"),
            Error::Json(msg) => write!(f, "json error: {msg}"),
            Error::AckRegression { from, to } => {
                write!(f, "ack regression: {from} -> {to} (ack level must never go backwards)")
            }
            Error::UnknownMessage(id) => write!(f, "unknown msg_id: {id}"),
            Error::UnknownTarget { msg_id, target } => {
                write!(f, "unknown target: msg_id={msg_id} target_device={target}")
            }
            Error::UnknownNotice(id) => write!(f, "unknown notice_id: {id}"),
            Error::Invalid(msg) => write!(f, "invalid input: {msg}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Sqlite(e) => Some(e),
            Error::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for Error {
    fn from(value: rusqlite::Error) -> Self {
        Error::Sqlite(value)
    }
}

impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        Error::Io(value)
    }
}

impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Error::Json(value.to_string())
    }
}

/// msg 模块内统一 `Result`。
pub type Result<T> = std::result::Result<T, Error>;
