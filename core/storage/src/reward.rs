//! Reward record — R-layer evaluation output

use serde::{Deserialize, Serialize};

/// R layer (Retribution) reward record
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewardRecord {
    /// Evaluated target (belief entry id)
    pub target: String,
    /// Reward value
    pub score: f64,
    /// Evaluation details
    pub data: serde_json::Value,
    /// Timestamp (Unix ms)
    pub timestamp: u64,
}
