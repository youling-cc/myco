//! Dataset utilities for traces.json test files.
//!
//! Each skill directory may contain a `traces.json` file with test cases
//! that define the MDP sub-space for testing: given `o_input`, the skill
//! should produce output matching `expected_output`.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// A single test case in a traces.json dataset.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestCase {
    /// Input observation (MDP: o). Should conform to the skill's input schema.
    pub o_input: serde_json::Value,
    /// Expected output. `None` for error scenarios where success is not expected.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_output: Option<serde_json::Value>,
    /// Scenario classification.
    pub scenario: TestCaseScenario,
    /// Optional human-readable description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Test case scenario classification.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TestCaseScenario {
    Normal,
    Boundary,
    Error,
}

/// Load test cases from a traces.json file.
pub fn load_traces(path: &Path) -> Result<Vec<TestCase>, DatasetError> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| DatasetError::Io {
            path: path.to_path_buf(),
            source: e,
        })?;
    let cases: Vec<TestCase> = serde_json::from_str(&content).map_err(|e| DatasetError::Parse {
        path: path.to_path_buf(),
        source: e,
    })?;
    Ok(cases)
}

/// Save test cases to a traces.json file.
pub fn save_traces(path: &Path, cases: &[TestCase]) -> Result<(), DatasetError> {
    let content = serde_json::to_string_pretty(cases).map_err(|e| DatasetError::Serialize {
        source: e,
    })?;
    std::fs::write(path, content).map_err(|e| DatasetError::Io {
        path: path.to_path_buf(),
        source: e,
    })?;
    Ok(())
}

/// Dataset I/O errors.
#[derive(Debug, thiserror::Error)]
pub enum DatasetError {
    #[error("IO error reading {path}: {source}")]
    Io {
        path: std::path::PathBuf,
        source: std::io::Error,
    },
    #[error("Parse error in {path}: {source}")]
    Parse {
        path: std::path::PathBuf,
        source: serde_json::Error,
    },
    #[error("Serialize error: {source}")]
    Serialize { source: serde_json::Error },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_roundtrip() {
        let cases = vec![
            TestCase {
                o_input: json!({"nodeId": "N-1"}),
                expected_output: Some(json!({"score": 0.8})),
                scenario: TestCaseScenario::Normal,
                description: Some("normal scoring".into()),
            },
            TestCase {
                o_input: json!({"nodeId": ""}),
                expected_output: None,
                scenario: TestCaseScenario::Error,
                description: Some("empty node ID".into()),
            },
        ];

        let dir = std::env::temp_dir().join("myco-dataset-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test-traces.json");

        save_traces(&path, &cases).unwrap();
        let loaded = load_traces(&path).unwrap();

        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].o_input, json!({"nodeId": "N-1"}));
        assert_eq!(loaded[0].scenario, TestCaseScenario::Normal);
        assert_eq!(loaded[1].scenario, TestCaseScenario::Error);
        assert!(loaded[1].expected_output.is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_json_format() {
        let cases = vec![TestCase {
            o_input: json!(42),
            expected_output: Some(json!("result")),
            scenario: TestCaseScenario::Boundary,
            description: None,
        }];

        let json_str = serde_json::to_string_pretty(&cases).unwrap();
        assert!(json_str.contains("\"scenario\": \"boundary\""));
        assert!(!json_str.contains("\"description\"")); // skip_serializing_if
    }
}
