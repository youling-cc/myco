//! Observation record — P-layer perception output

use serde::{Deserialize, Serialize};

/// P layer (Perception) perception record
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationRecord {
    /// Observation source (e.g., "scan", "monitor", "external-agent")
    pub source: String,
    /// Newly discovered or changed belief entries
    pub entries: Vec<crate::belief::BeliefEntry>,
    /// Observation timestamp (Unix ms)
    pub timestamp: u64,
}
