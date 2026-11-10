//! Capacity and configuration types

use serde::{Deserialize, Serialize};

/// Storage capacity information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapacityInfo {
    pub total_entries: u64,
    pub max_entries: u64,
    pub db_size_bytes: u64,
    pub max_db_size_bytes: u64,
    pub is_at_capacity: bool,
}

/// Storage configuration
#[derive(Debug, Clone)]
pub struct StorageConfig {
    pub db_path: String,
    pub max_entries: u64,
    pub max_db_size_mb: u64,
    pub wal_mode: bool,
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            db_path: "data/belief.db".into(),
            max_entries: 100_000,
            max_db_size_mb: 500,
            wal_mode: true,
        }
    }
}

impl StorageConfig {
    pub fn max_db_size_bytes(&self) -> u64 {
        self.max_db_size_mb * 1024 * 1024
    }
}
