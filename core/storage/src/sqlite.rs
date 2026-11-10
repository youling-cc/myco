//! SQLite implementation of BeliefStore

use async_trait::async_trait;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use crate::belief::{BeliefEntry, BeliefFilter, BeliefStore, BeliefSummary};
use crate::capacity::{CapacityInfo, StorageConfig};
use crate::error::{Result, StorageError};

/// SQLite-based BeliefStore implementation
pub struct SqliteBeliefStore {
    conn: Mutex<Connection>,
    config: StorageConfig,
}

impl SqliteBeliefStore {
    /// Open (or create) a SQLite belief store
    pub async fn open(config: StorageConfig) -> Result<Self> {
        // Ensure parent directory exists
        if let Some(parent) = Path::new(&config.db_path).parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(&config.db_path)?;

        if config.wal_mode {
            conn.execute_batch("PRAGMA journal_mode=WAL;")?;
            conn.execute_batch("PRAGMA synchronous=NORMAL;")?;
        }
        // Multi-process safety: retry on SQLITE_BUSY for 5 seconds
        conn.execute_batch("PRAGMA busy_timeout=5000;")?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;

        let store = Self {
            conn: Mutex::new(conn),
            config,
        };
        store.run_migrations()?;
        Ok(store)
    }

    fn run_migrations(&self) -> Result<()> {
        let conn = self.conn.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        conn.execute_batch(SCHEMA)?;
        Ok(())
    }

    fn check_capacity(&self) -> Result<()> {
        let conn = self.conn.lock().map_err(|e| StorageError::Other(e.to_string()))?;

        // Check entry count
        let count: u64 = conn
            .query_row("SELECT COUNT(*) FROM belief_entries", [], |row| row.get(0))
            .unwrap_or(0);

        if count >= self.config.max_entries {
            return Err(StorageError::AtCapacity {
                current: count,
                max: self.config.max_entries,
            });
        }

        // Check DB file size
        if let Ok(metadata) = std::fs::metadata(&self.config.db_path) {
            let size_bytes = metadata.len();
            let max_bytes = self.config.max_db_size_bytes();
            if size_bytes > max_bytes {
                return Err(StorageError::DiskQuotaExceeded {
                    current_mb: size_bytes / 1024 / 1024,
                    max_mb: self.config.max_db_size_mb,
                });
            }
        }

        Ok(())
    }
}

#[async_trait]
impl BeliefStore for SqliteBeliefStore {
    // ═══ b(s) belief ══════════════════════════════

    async fn get(&self, collection: &str, id: &str) -> Result<Option<BeliefEntry>> {
        let conn = self.conn.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let result = conn.query_row(
            "SELECT data, confidence, tags, created_at, updated_at FROM belief_entries WHERE collection = ?1 AND id = ?2",
            params![collection, id],
            |row| {
                let data_str: String = row.get(0)?;
                let confidence: f64 = row.get(1)?;
                let tags_str: String = row.get(2)?;
                let created_at: u64 = row.get(3)?;
                let updated_at: u64 = row.get(4)?;
                Ok((data_str, confidence, tags_str, created_at, updated_at))
            }
        ).optional();

        match result {
            Ok(Some((data_str, confidence, tags_str, created_at, updated_at))) => {
                let data: serde_json::Value = serde_json::from_str(&data_str)?;
                let tags: HashMap<String, String> = serde_json::from_str(&tags_str).unwrap_or_default();
                Ok(Some(BeliefEntry {
                    collection: collection.to_string(),
                    id: id.to_string(),
                    data,
                    confidence,
                    tags,
                    created_at,
                    updated_at,
                }))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(StorageError::from(e)),
        }
    }

    async fn put(&self, entry: &BeliefEntry) -> Result<()> {
        self.check_capacity()?;

        let conn = self.conn.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let data_str = serde_json::to_string(&entry.data)?;
        let tags_str = serde_json::to_string(&entry.tags)?;

        conn.execute(
            "INSERT INTO belief_entries (collection, id, data, confidence, tags, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(collection, id) DO UPDATE SET
               data = excluded.data,
               confidence = excluded.confidence,
               tags = excluded.tags,
               updated_at = excluded.updated_at",
            params![
                entry.collection,
                entry.id,
                data_str,
                entry.confidence,
                tags_str,
                entry.created_at,
                entry.updated_at,
            ],
        )?;
        Ok(())
    }

    async fn query(&self, filter: BeliefFilter) -> Result<Vec<BeliefEntry>> {
        let conn = self.conn.lock().map_err(|e| StorageError::Other(e.to_string()))?;

        let mut sql = String::from(
            "SELECT collection, id, data, confidence, tags, created_at, updated_at FROM belief_entries WHERE 1=1"
        );
        let mut param_idx = 1;
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = vec![];

        if let Some(ref coll) = filter.collection {
            sql.push_str(&format!(" AND collection = ?{param_idx}"));
            param_idx += 1;
            param_values.push(Box::new(coll.clone()));
        }

        if let Some(min_c) = filter.min_confidence {
            sql.push_str(&format!(" AND confidence >= ?{param_idx}"));
            param_idx += 1;
            param_values.push(Box::new(min_c));
        }

        if let Some(max_c) = filter.max_confidence {
            sql.push_str(&format!(" AND confidence <= ?{param_idx}"));
            param_idx += 1;
            param_values.push(Box::new(max_c));
        }

        for (key, value) in &filter.tag_filters {
            sql.push_str(&format!(
                " AND json_extract(tags, '$.\"{}\"') = ?{param_idx}",
                key.replace('\'', "''")
            ));
            param_idx += 1;
            param_values.push(Box::new(value.clone()));
        }

        sql.push_str(" ORDER BY confidence ASC");

        if let Some(limit) = filter.limit {
            sql.push_str(&format!(" LIMIT {limit}"));
        }
        if let Some(offset) = filter.offset {
            sql.push_str(&format!(" OFFSET {offset}"));
        }

        let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let entries = stmt.query_map(params_refs.as_slice(), |row| {
            let collection: String = row.get(0)?;
            let id: String = row.get(1)?;
            let data_str: String = row.get(2)?;
            let confidence: f64 = row.get(3)?;
            let tags_str: String = row.get(4)?;
            let created_at: u64 = row.get(5)?;
            let updated_at: u64 = row.get(6)?;
            Ok((collection, id, data_str, confidence, tags_str, created_at, updated_at))
        })?.filter_map(|r| r.ok()).map(|(collection, id, data_str, confidence, tags_str, created_at, updated_at)| {
            BeliefEntry {
                collection,
                id,
                data: serde_json::from_str(&data_str).unwrap_or_default(),
                confidence,
                tags: serde_json::from_str(&tags_str).unwrap_or_default(),
                created_at,
                updated_at,
            }
        }).collect();

        Ok(entries)
    }

    async fn count(&self, collection: &str) -> Result<u64> {
        let conn = self.conn.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let count: u64 = conn.query_row(
            "SELECT COUNT(*) FROM belief_entries WHERE collection = ?1",
            params![collection],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    async fn remove(&self, collection: &str, id: &str) -> Result<()> {
        let conn = self.conn.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let changes = conn.execute(
            "DELETE FROM belief_entries WHERE collection = ?1 AND id = ?2",
            params![collection, id],
        )?;
        if changes == 0 {
            return Err(StorageError::NotFound {
                collection: collection.to_string(),
                id: id.to_string(),
            });
        }
        Ok(())
    }

    async fn belief_summary(&self) -> Result<BeliefSummary> {
        let conn = self.conn.lock().map_err(|e| StorageError::Other(e.to_string()))?;

        let total: u64 = conn.query_row("SELECT COUNT(*) FROM belief_entries", [], |row| row.get(0))?;
        let avg_conf: f64 = conn.query_row("SELECT AVG(confidence) FROM belief_entries", [], |row| row.get(0)).unwrap_or(0.0);
        let low_count: u64 = conn.query_row("SELECT COUNT(*) FROM belief_entries WHERE confidence < 0.3", [], |row| row.get(0))?;
        let high_count: u64 = conn.query_row("SELECT COUNT(*) FROM belief_entries WHERE confidence > 0.8", [], |row| row.get(0))?;

        let now = now_ms();

        // Collection breakdown
        let mut stmt = conn.prepare("SELECT collection, COUNT(*) FROM belief_entries GROUP BY collection")?;
        let collections: HashMap<String, u64> = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
        })?.filter_map(|r| r.ok()).collect();

        Ok(BeliefSummary {
            collections,
            total_entries: total,
            avg_confidence: avg_conf,
            low_confidence_count: low_count,
            high_confidence_count: high_count,
            timestamp: now,
        })
    }

    // ═══ o observation ══════════════════════════════

    async fn observe(&self, record: &crate::observation::ObservationRecord) -> Result<()> {
        let conn = self.conn.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let entries_json = serde_json::to_string(&record.entries)?;
        conn.execute(
            "INSERT INTO observations (source, entries, timestamp) VALUES (?1, ?2, ?3)",
            params![record.source, entries_json, record.timestamp],
        )?;
        Ok(())
    }

    async fn observations(&self, limit: usize) -> Result<Vec<crate::observation::ObservationRecord>> {
        let conn = self.conn.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT source, entries, timestamp FROM observations ORDER BY timestamp DESC LIMIT ?1"
        )?;
        let records = stmt.query_map(params![limit as i64], |row| {
            let source: String = row.get(0)?;
            let entries_str: String = row.get(1)?;
            let timestamp: u64 = row.get(2)?;
            Ok((source, entries_str, timestamp))
        })?.filter_map(|r| r.ok()).map(|(source, entries_str, timestamp)| {
            crate::observation::ObservationRecord {
                source,
                entries: serde_json::from_str(&entries_str).unwrap_or_default(),
                timestamp,
            }
        }).collect();
        Ok(records)
    }

    // ═══ a action ══════════════════════════════

    async fn record_action(&self, action: &crate::action::ActionRecord) -> Result<()> {
        let conn = self.conn.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let data_json = serde_json::to_string(&action.data)?;
        conn.execute(
            "INSERT INTO actions (action_type, target, data, timestamp) VALUES (?1, ?2, ?3, ?4)",
            params![action.action_type, action.target, data_json, action.timestamp],
        )?;
        Ok(())
    }

    async fn latest_action(&self) -> Result<Option<crate::action::ActionRecord>> {
        let conn = self.conn.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let result = conn.query_row(
            "SELECT action_type, target, data, timestamp FROM actions ORDER BY timestamp DESC LIMIT 1",
            [],
            |row| {
                let action_type: String = row.get(0)?;
                let target: String = row.get(1)?;
                let data_str: String = row.get(2)?;
                let timestamp: u64 = row.get(3)?;
                Ok((action_type, target, data_str, timestamp))
            }
        ).optional();

        match result {
            Ok(Some((action_type, target, data_str, timestamp))) => {
                Ok(Some(crate::action::ActionRecord {
                    action_type,
                    target,
                    data: serde_json::from_str(&data_str)?,
                    timestamp,
                }))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(StorageError::from(e)),
        }
    }

    async fn actions(&self, limit: usize) -> Result<Vec<crate::action::ActionRecord>> {
        let conn = self.conn.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT action_type, target, data, timestamp FROM actions ORDER BY timestamp DESC LIMIT ?1"
        )?;
        let records = stmt.query_map(params![limit as i64], |row| {
            let action_type: String = row.get(0)?;
            let target: String = row.get(1)?;
            let data_str: String = row.get(2)?;
            let timestamp: u64 = row.get(3)?;
            Ok(crate::action::ActionRecord {
                action_type,
                target,
                data: serde_json::from_str(&data_str).unwrap_or_default(),
                timestamp,
            })
        })?.filter_map(|r| r.ok()).collect();
        Ok(records)
    }

    // ═══ r reward ══════════════════════════════

    async fn record_reward(&self, reward: &crate::reward::RewardRecord) -> Result<()> {
        let conn = self.conn.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let data_json = serde_json::to_string(&reward.data)?;
        conn.execute(
            "INSERT INTO rewards (target, score, data, timestamp) VALUES (?1, ?2, ?3, ?4)",
            params![reward.target, reward.score, data_json, reward.timestamp],
        )?;
        Ok(())
    }

    async fn rewards(&self, limit: usize) -> Result<Vec<crate::reward::RewardRecord>> {
        let conn = self.conn.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT target, score, data, timestamp FROM rewards ORDER BY timestamp DESC LIMIT ?1"
        )?;
        let records = stmt.query_map(params![limit as i64], |row| {
            let target: String = row.get(0)?;
            let score: f64 = row.get(1)?;
            let data_str: String = row.get(2)?;
            let timestamp: u64 = row.get(3)?;
            Ok(crate::reward::RewardRecord {
                target,
                score,
                data: serde_json::from_str(&data_str).unwrap_or_default(),
                timestamp,
            })
        })?.filter_map(|r| r.ok()).collect();
        Ok(records)
    }

    // ═══ trace ══════════════════════════════

    async fn record_trace(&self, trace: &crate::trace::TraceRecord) -> Result<()> {
        let conn = self.conn.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let o_input = serde_json::to_string(&trace.o_input)?;
        let s_context = trace.s_context.as_ref().map(|v| serde_json::to_string(v)).transpose()?.unwrap_or_default();
        let a_output = trace.a_output.as_ref().map(|v| serde_json::to_string(v)).transpose()?;
        let r_evaluation = trace.r_evaluation.as_ref().map(|v| serde_json::to_string(v)).transpose()?;

        conn.execute(
            "INSERT INTO skill_traces (trace_id, tick_id, agent_did, skill_name, o_input, s_context, a_output, r_evaluation, r_score, duration_ms, success, error, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                trace.trace_id,
                trace.tick_id,
                trace.agent_did,
                trace.skill_name,
                o_input,
                s_context,
                a_output,
                r_evaluation,
                trace.r_score,
                trace.duration_ms,
                trace.success as i32,
                trace.error,
                trace.timestamp,
            ],
        )?;
        Ok(())
    }

    async fn query_traces(&self, filter: crate::trace::TraceFilter) -> Result<Vec<crate::trace::TraceRecord>> {
        let conn = self.conn.lock().map_err(|e| StorageError::Other(e.to_string()))?;

        let mut param_idx = 1u32;
        let mut sql = String::from(
            "SELECT trace_id, tick_id, agent_did, skill_name, o_input, s_context, a_output, r_evaluation, r_score, duration_ms, success, error, timestamp FROM skill_traces WHERE 1=1"
        );
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = vec![];

        if let Some(ref skill) = filter.skill_name {
            sql.push_str(&format!(" AND skill_name = ?{param_idx}"));
            param_idx += 1;
            param_values.push(Box::new(skill.clone()));
        }
        if let Some(ref did) = filter.agent_did {
            sql.push_str(&format!(" AND agent_did = ?{param_idx}"));
            param_idx += 1;
            param_values.push(Box::new(did.clone()));
        }
        if let Some(ref tid) = filter.tick_id {
            sql.push_str(&format!(" AND tick_id = ?{param_idx}"));
            param_idx += 1;
            param_values.push(Box::new(tid.clone()));
        }
        if let Some(min_s) = filter.min_score {
            sql.push_str(&format!(" AND r_score >= ?{param_idx}"));
            param_idx += 1;
            param_values.push(Box::new(min_s));
        }
        if let Some(max_s) = filter.max_score {
            sql.push_str(&format!(" AND r_score <= ?{param_idx}"));
            param_idx += 1;
            param_values.push(Box::new(max_s));
        }
        if filter.success_only == Some(true) {
            sql.push_str(" AND success = 1");
        }

        sql.push_str(" ORDER BY timestamp DESC");

        if let Some(limit) = filter.limit {
            sql.push_str(&format!(" LIMIT {limit}"));
        }
        if let Some(offset) = filter.offset {
            sql.push_str(&format!(" OFFSET {offset}"));
        }

        let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let traces = stmt.query_map(params_refs.as_slice(), |row| {
            let trace_id: String = row.get(0)?;
            let tick_id: Option<String> = row.get(1)?;
            let agent_did: String = row.get(2)?;
            let skill_name: String = row.get(3)?;
            let o_input_str: String = row.get(4)?;
            let s_context_str: Option<String> = row.get(5)?;
            let a_output_str: Option<String> = row.get(6)?;
            let r_eval_str: Option<String> = row.get(7)?;
            let r_score: Option<f64> = row.get(8)?;
            let duration_ms: u64 = row.get(9)?;
            let success_i: i32 = row.get(10)?;
            let error: Option<String> = row.get(11)?;
            let timestamp: u64 = row.get(12)?;
            Ok((trace_id, tick_id, agent_did, skill_name, o_input_str, s_context_str, a_output_str, r_eval_str, r_score, duration_ms, success_i, error, timestamp))
        })?.filter_map(|r| r.ok()).map(|(trace_id, tick_id, agent_did, skill_name, o_input_str, s_context_str, a_output_str, r_eval_str, r_score, duration_ms, success_i, error, timestamp)| {
            crate::trace::TraceRecord {
                trace_id,
                tick_id,
                agent_did,
                skill_name,
                o_input: serde_json::from_str(&o_input_str).unwrap_or_default(),
                s_context: s_context_str.and_then(|s| serde_json::from_str(&s).ok()),
                a_output: a_output_str.and_then(|s| serde_json::from_str(&s).ok()),
                r_evaluation: r_eval_str.and_then(|s| serde_json::from_str(&s).ok()),
                r_score,
                duration_ms,
                success: success_i != 0,
                error,
                timestamp,
            }
        }).collect();

        Ok(traces)
    }

    async fn update_trace_reward(&self, trace_id: &str, score: f64, evaluation: serde_json::Value) -> Result<()> {
        let conn = self.conn.lock().map_err(|e| StorageError::Other(e.to_string()))?;
        let eval_json = serde_json::to_string(&evaluation)?;
        let changes = conn.execute(
            "UPDATE skill_traces SET r_score = ?1, r_evaluation = ?2 WHERE trace_id = ?3",
            params![score, eval_json, trace_id],
        )?;
        if changes == 0 {
            return Err(StorageError::NotFound {
                collection: "skill_traces".into(),
                id: trace_id.to_string(),
            });
        }
        Ok(())
    }

    // ═══ capacity ══════════════════════════════

    fn capacity(&self) -> CapacityInfo {
        let conn = match self.conn.lock() {
            Ok(c) => c,
            Err(_) => return CapacityInfo::default(),
        };
        let total: u64 = conn.query_row("SELECT COUNT(*) FROM belief_entries", [], |row| row.get(0)).unwrap_or(0);
        let db_size = std::fs::metadata(&self.config.db_path)
            .map(|m| m.len())
            .unwrap_or(0);

        CapacityInfo {
            total_entries: total,
            max_entries: self.config.max_entries,
            db_size_bytes: db_size,
            max_db_size_bytes: self.config.max_db_size_bytes(),
            is_at_capacity: total >= self.config.max_entries,
        }
    }
}

// ═══ Schema DDL ══════════════════════════════

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS belief_entries (
    collection  TEXT NOT NULL,
    id          TEXT NOT NULL,
    data        TEXT NOT NULL DEFAULT '{}',
    confidence  REAL NOT NULL DEFAULT 0.0,
    tags        TEXT NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS idx_belief_collection ON belief_entries(collection);
CREATE INDEX IF NOT EXISTS idx_belief_confidence ON belief_entries(confidence);

CREATE TABLE IF NOT EXISTS observations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT NOT NULL,
    entries     TEXT NOT NULL DEFAULT '[]',
    timestamp   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observations_ts ON observations(timestamp DESC);

CREATE TABLE IF NOT EXISTS actions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    action_type TEXT NOT NULL,
    target      TEXT NOT NULL,
    data        TEXT NOT NULL DEFAULT '{}',
    timestamp   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actions_ts ON actions(timestamp DESC);

CREATE TABLE IF NOT EXISTS rewards (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    target      TEXT NOT NULL,
    score       REAL NOT NULL,
    data        TEXT NOT NULL DEFAULT '{}',
    timestamp   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rewards_ts ON rewards(timestamp DESC);

CREATE TABLE IF NOT EXISTS config (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_traces (
    trace_id     TEXT PRIMARY KEY,
    tick_id      TEXT,
    agent_did    TEXT NOT NULL,
    skill_name   TEXT NOT NULL,
    o_input      TEXT NOT NULL DEFAULT '{}',
    s_context    TEXT,
    a_output     TEXT,
    r_evaluation TEXT,
    r_score      REAL,
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    success      INTEGER NOT NULL DEFAULT 1,
    error        TEXT,
    timestamp    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traces_skill ON skill_traces(skill_name);
CREATE INDEX IF NOT EXISTS idx_traces_agent ON skill_traces(agent_did);
CREATE INDEX IF NOT EXISTS idx_traces_tick  ON skill_traces(tick_id);
CREATE INDEX IF NOT EXISTS idx_traces_ts    ON skill_traces(timestamp DESC);
"#;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl Default for CapacityInfo {
    fn default() -> Self {
        Self {
            total_entries: 0,
            max_entries: 0,
            db_size_bytes: 0,
            max_db_size_bytes: 0,
            is_at_capacity: false,
        }
    }
}
