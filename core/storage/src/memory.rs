//! In-memory BeliefStore for testing

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Mutex;

use crate::belief::{BeliefEntry, BeliefFilter, BeliefStore, BeliefSummary};
use crate::capacity::CapacityInfo;
use crate::error::{Result, StorageError};

/// In-memory BeliefStore (testing only)
pub struct InMemoryBeliefStore {
    entries: Mutex<HashMap<(String, String), BeliefEntry>>,
    observations: Mutex<Vec<crate::observation::ObservationRecord>>,
    actions: Mutex<Vec<crate::action::ActionRecord>>,
    rewards: Mutex<Vec<crate::reward::RewardRecord>>,
    traces: Mutex<Vec<crate::trace::TraceRecord>>,
}

impl InMemoryBeliefStore {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            observations: Mutex::new(Vec::new()),
            actions: Mutex::new(Vec::new()),
            rewards: Mutex::new(Vec::new()),
            traces: Mutex::new(Vec::new()),
        }
    }
}

impl Default for InMemoryBeliefStore {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl BeliefStore for InMemoryBeliefStore {
    async fn get(&self, collection: &str, id: &str) -> Result<Option<BeliefEntry>> {
        let entries = self.entries.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        Ok(entries.get(&(collection.to_string(), id.to_string())).cloned())
    }

    async fn put(&self, entry: &BeliefEntry) -> Result<()> {
        let mut entries = self.entries.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        entries.insert(
            (entry.collection.clone(), entry.id.clone()),
            entry.clone(),
        );
        Ok(())
    }

    async fn query(&self, filter: BeliefFilter) -> Result<Vec<BeliefEntry>> {
        let entries = self.entries.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let mut results: Vec<BeliefEntry> = entries.values()
            .filter(|e| {
                if let Some(ref coll) = filter.collection {
                    if e.collection != *coll { return false; }
                }
                if let Some(min_c) = filter.min_confidence {
                    if e.confidence < min_c { return false; }
                }
                if let Some(max_c) = filter.max_confidence {
                    if e.confidence > max_c { return false; }
                }
                for (k, v) in &filter.tag_filters {
                    if e.tags.get(k) != Some(v) { return false; }
                }
                true
            })
            .cloned()
            .collect();

        // Sort by confidence ascending (most uncertain first — explore)
        results.sort_by(|a, b| a.confidence.partial_cmp(&b.confidence).unwrap_or(std::cmp::Ordering::Equal));

        if let Some(limit) = filter.limit {
            results.truncate(limit as usize);
        }

        Ok(results)
    }

    async fn count(&self, collection: &str) -> Result<u64> {
        let entries = self.entries.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        Ok(entries.values().filter(|e| e.collection == collection).count() as u64)
    }

    async fn remove(&self, collection: &str, id: &str) -> Result<()> {
        let mut entries = self.entries.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        entries.remove(&(collection.to_string(), id.to_string()))
            .ok_or(StorageError::NotFound {
                collection: collection.to_string(),
                id: id.to_string(),
            })?;
        Ok(())
    }

    async fn belief_summary(&self) -> Result<BeliefSummary> {
        let entries = self.entries.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let total = entries.len() as u64;
        let avg_conf = entries.values().map(|e| e.confidence).sum::<f64>() / total.max(1) as f64;
        let low = entries.values().filter(|e| e.confidence < 0.3).count() as u64;
        let high = entries.values().filter(|e| e.confidence > 0.8).count() as u64;

        let mut collections = HashMap::new();
        for e in entries.values() {
            *collections.entry(e.collection.clone()).or_insert(0u64) += 1;
        }

        Ok(BeliefSummary {
            collections,
            total_entries: total,
            avg_confidence: avg_conf,
            low_confidence_count: low,
            high_confidence_count: high,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        })
    }

    async fn observe(&self, record: &crate::observation::ObservationRecord) -> Result<()> {
        let mut obs = self.observations.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        obs.push(record.clone());
        Ok(())
    }

    async fn observations(&self, limit: usize) -> Result<Vec<crate::observation::ObservationRecord>> {
        let obs = self.observations.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let len = obs.len().min(limit);
        Ok(obs.iter().rev().take(len).cloned().collect())
    }

    async fn record_action(&self, action: &crate::action::ActionRecord) -> Result<()> {
        let mut actions = self.actions.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        actions.push(action.clone());
        Ok(())
    }

    async fn latest_action(&self) -> Result<Option<crate::action::ActionRecord>> {
        let actions = self.actions.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        Ok(actions.last().cloned())
    }

    async fn actions(&self, limit: usize) -> Result<Vec<crate::action::ActionRecord>> {
        let actions = self.actions.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let len = actions.len().min(limit);
        Ok(actions.iter().rev().take(len).cloned().collect())
    }

    async fn record_reward(&self, reward: &crate::reward::RewardRecord) -> Result<()> {
        let mut rewards = self.rewards.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        rewards.push(reward.clone());
        Ok(())
    }

    async fn rewards(&self, limit: usize) -> Result<Vec<crate::reward::RewardRecord>> {
        let rewards = self.rewards.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let len = rewards.len().min(limit);
        Ok(rewards.iter().rev().take(len).cloned().collect())
    }

    async fn record_trace(&self, trace: &crate::trace::TraceRecord) -> Result<()> {
        let mut traces = self.traces.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        traces.push(trace.clone());
        Ok(())
    }

    async fn query_traces(&self, filter: crate::trace::TraceFilter) -> Result<Vec<crate::trace::TraceRecord>> {
        let traces = self.traces.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let mut results: Vec<crate::trace::TraceRecord> = traces.iter()
            .filter(|t| {
                if let Some(ref skill) = filter.skill_name {
                    if t.skill_name != *skill { return false; }
                }
                if let Some(ref did) = filter.agent_did {
                    if t.agent_did != *did { return false; }
                }
                if let Some(ref tid) = filter.tick_id {
                    if t.tick_id.as_ref() != Some(tid) { return false; }
                }
                if let Some(min_s) = filter.min_score {
                    if t.r_score < Some(min_s) { return false; }
                }
                if let Some(max_s) = filter.max_score {
                    if t.r_score > Some(max_s) { return false; }
                }
                if filter.success_only == Some(true) && !t.success {
                    return false;
                }
                true
            })
            .cloned()
            .collect();

        // Most recent first
        results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

        if let Some(limit) = filter.limit {
            results.truncate(limit as usize);
        }

        Ok(results)
    }

    async fn update_trace_reward(&self, trace_id: &str, score: f64, evaluation: serde_json::Value) -> Result<()> {
        let mut traces = self.traces.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let trace = traces.iter_mut().find(|t| t.trace_id == trace_id)
            .ok_or(StorageError::NotFound {
                collection: "skill_traces".into(),
                id: trace_id.to_string(),
            })?;
        trace.r_score = Some(score);
        trace.r_evaluation = Some(evaluation);
        Ok(())
    }

    fn capacity(&self) -> CapacityInfo {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        CapacityInfo {
            total_entries: entries.len() as u64,
            max_entries: u64::MAX,
            db_size_bytes: 0,
            max_db_size_bytes: u64::MAX,
            is_at_capacity: false,
        }
    }
}
