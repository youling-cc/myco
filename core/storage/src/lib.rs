//! # myco-storage — MDP data module
//!
//! Core abstraction: **BeliefStore** — persists Agent's belief state b(s).
//!
//! Every belief entry carries both `data` (μ = what agent believes) and
//! `confidence` (σ⁻¹ = how certain). This enables D-layer explore/exploit
//! tradeoff: low confidence → explore, high confidence → exploit.
//!
//! ## Module layout
//!
//! - `belief` — BeliefStore trait, BeliefEntry, BeliefFilter, BeliefSummary
//! - `observation` — ObservationRecord (P-layer output)
//! - `action` — ActionRecord (D-layer output)
//! - `reward` — RewardRecord (R-layer output)
//! - `trace` — TraceRecord, TraceFilter (unified skill execution traces)
//! - `dataset` — TestCase, traces.json load/save utilities
//! - `capacity` — CapacityInfo, StorageConfig
//! - `sqlite` — SqliteBeliefStore (production default)
//! - `memory` — InMemoryBeliefStore (testing)
//! - `error` — StorageError

pub mod belief;
pub mod observation;
pub mod action;
pub mod reward;
pub mod trace;
pub mod dataset;
pub mod capacity;
pub mod error;
pub mod sqlite;
pub mod memory;

// Re-exports
pub use belief::{BeliefStore, BeliefEntry, BeliefFilter, BeliefSummary};
pub use observation::ObservationRecord;
pub use action::ActionRecord;
pub use reward::RewardRecord;
pub use trace::{TraceRecord, TraceFilter};
pub use dataset::{TestCase, TestCaseScenario, load_traces, save_traces, DatasetError};
pub use capacity::{CapacityInfo, StorageConfig};
pub use error::StorageError;
