//! Action record — D-layer decision output

use serde::{Deserialize, Serialize};

/// D layer (Decision) decision record
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRecord {
    /// Action type (e.g., "select", "expand", "skip")
    pub action_type: String,
    /// Action target (belief entry id)
    pub target: String,
    /// Action details
    pub data: serde_json::Value,
    /// Timestamp (Unix ms)
    pub timestamp: u64,
}
