//! Belief entry — core type for Agent's model of the world
//!
//! BeliefEntry = one piece of Agent's belief b(s):
//! - `data` = μ (value/mean — what Agent believes)
//! - `confidence` = σ⁻¹ (inverse variance — how certain)
//!
//! confidence [0.0, 1.0] in PCDATR:
//! - P: new discovery → confidence = 0.0
//! - C: evaluation updates confidence (more observations → confidence↑)
//! - D: reads confidence for explore(exploit tradeoff)
//! - R: evaluates whether confidence was calibrated

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A single belief entry in the Agent's model of the world
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeliefEntry {
    pub collection: String,
    pub id: String,
    pub data: serde_json::Value,
    /// Confidence [0.0, 1.0] — inverse of uncertainty
    /// 0.0 = completely unknown, 1.0 = fully certain
    pub confidence: f64,
    pub tags: HashMap<String, String>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Query filter with confidence range support
#[derive(Debug, Clone, Default)]
pub struct BeliefFilter {
    pub collection: Option<String>,
    pub tag_filters: HashMap<String, String>,
    /// Only entries with confidence >= this value
    pub min_confidence: Option<f64>,
    /// Only entries with confidence <= this value
    pub max_confidence: Option<f64>,
    pub limit: Option<u64>,
    pub offset: Option<u64>,
}

/// Lightweight summary of current belief state
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeliefSummary {
    pub collections: HashMap<String, u64>,
    pub total_entries: u64,
    pub avg_confidence: f64,
    /// Entries with confidence < 0.3 — exploration candidates
    pub low_confidence_count: u64,
    /// Entries with confidence > 0.8 — exploitation candidates
    pub high_confidence_count: u64,
    pub timestamp: u64,
}

/// BeliefStore trait — POMDP-aligned persistence interface
///
/// Methods grouped by POMDP concept:
/// - b(s) belief: get/put/query — Agent's model of the world
/// - o observation: observe()             — P layer records perception
/// - a action: record_action()           — D layer records decision
/// - r reward: record_reward()           — R layer records evaluation
#[async_trait::async_trait]
pub trait BeliefStore: Send + Sync {
    // ═══ b(s) belief ══════════════════════════════
    async fn get(&self, collection: &str, id: &str) -> crate::error::Result<Option<BeliefEntry>>;
    async fn put(&self, entry: &BeliefEntry) -> crate::error::Result<()>;
    async fn query(&self, filter: BeliefFilter) -> crate::error::Result<Vec<BeliefEntry>>;
    async fn count(&self, collection: &str) -> crate::error::Result<u64>;
    async fn remove(&self, collection: &str, id: &str) -> crate::error::Result<()>;
    async fn belief_summary(&self) -> crate::error::Result<BeliefSummary>;

    // ═══ o observation ══════════════════════════════
    async fn observe(&self, record: &crate::observation::ObservationRecord) -> crate::error::Result<()>;
    async fn observations(&self, limit: usize) -> crate::error::Result<Vec<crate::observation::ObservationRecord>>;

    // ═══ a action ══════════════════════════════
    async fn record_action(&self, action: &crate::action::ActionRecord) -> crate::error::Result<()>;
    async fn latest_action(&self) -> crate::error::Result<Option<crate::action::ActionRecord>>;
    async fn actions(&self, limit: usize) -> crate::error::Result<Vec<crate::action::ActionRecord>>;

    // ═══ r reward ══════════════════════════════
    async fn record_reward(&self, reward: &crate::reward::RewardRecord) -> crate::error::Result<()>;
    async fn rewards(&self, limit: usize) -> crate::error::Result<Vec<crate::reward::RewardRecord>>;

    // ═══ trace ══════════════════════════════
    /// Record a skill execution trace
    async fn record_trace(&self, trace: &crate::trace::TraceRecord) -> crate::error::Result<()>;
    /// Query traces with filter
    async fn query_traces(&self, filter: crate::trace::TraceFilter) -> crate::error::Result<Vec<crate::trace::TraceRecord>>;
    /// Backfill R-layer reward into an existing trace
    async fn update_trace_reward(&self, trace_id: &str, score: f64, evaluation: serde_json::Value) -> crate::error::Result<()>;

    // ═══ capacity ══════════════════════════════
    fn capacity(&self) -> crate::capacity::CapacityInfo;
}
