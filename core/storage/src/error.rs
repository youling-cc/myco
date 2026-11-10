//! Storage error types

use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("Entry not found: {collection}/{id}")]
    NotFound { collection: String, id: String },

    #[error("At capacity: {current} entries, max {max}")]
    AtCapacity { current: u64, max: u64 },

    #[error("Database quota exceeded: {current_mb}MB / {max_mb}MB")]
    DiskQuotaExceeded { current_mb: u64, max_mb: u64 },

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, StorageError>;
