//! Skill execution trace — unified record for PCDATR observability, evaluation, and replay
//!
//! Each trace captures one skill invocation: input, output, timing, and (later) R-layer reward.
//! Traces form evaluation datasets automatically — query by skill_name to get real test data.

use serde::{Deserialize, Serialize};

/// A single skill execution trace — the unified POMDP trajectory record
///
/// Links the four POMDP elements:
/// - **o** (observation): `o_input` — what the skill received
/// - **s** (belief state): `s_context` — agent's world state before execution (optional)
/// - **a** (action output): `a_output` — what the skill produced
/// - **r** (reward): `r_score` + `r_evaluation` — R-layer evaluation (backfilled)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRecord {
    /// Unique trace ID (UUID)
    pub trace_id: String,
    /// PCDATR cycle ID — groups 6 traces from one builder tick
    pub tick_id: Option<String>,

    // Who executed what
    /// Agent DID (e.g., "did:myco:agent:skill-action")
    pub agent_did: String,
    /// Skill name (e.g., "action.execute")
    pub skill_name: String,

    // POMDP: o (observation / input)
    /// Skill input — the full JSON received
    pub o_input: serde_json::Value,

    // POMDP: s (belief state snapshot, optional)
    /// Agent's relevant belief state before execution (for context/replay)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s_context: Option<serde_json::Value>,

    // POMDP: a (action output)
    /// Skill output — the full JSON returned (None on failure)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub a_output: Option<serde_json::Value>,

    // POMDP: r (reward — backfilled by R-layer)
    /// Numerical reward score (backfilled by R-layer)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r_score: Option<f64>,
    /// Detailed evaluation data (backfilled by R-layer)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r_evaluation: Option<serde_json::Value>,

    // Metadata
    /// Execution duration in milliseconds
    pub duration_ms: u64,
    /// Whether the skill succeeded
    pub success: bool,
    /// Error message if failed
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Timestamp (Unix ms)
    pub timestamp: u64,
}

/// Query filter for traces
#[derive(Debug, Clone, Default)]
pub struct TraceFilter {
    /// Filter by skill name (e.g., "action.execute")
    pub skill_name: Option<String>,
    /// Filter by agent DID
    pub agent_did: Option<String>,
    /// Filter by PCDATR tick ID
    pub tick_id: Option<String>,
    /// Only traces with reward >= this value
    pub min_score: Option<f64>,
    /// Only traces with reward <= this value
    pub max_score: Option<f64>,
    /// Only successful traces
    pub success_only: Option<bool>,
    /// Maximum number of results
    pub limit: Option<u64>,
    /// Offset for pagination
    pub offset: Option<u64>,
}
