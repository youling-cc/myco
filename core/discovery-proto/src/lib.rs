//! Discovery Protocol Types
//!
//! Pure protocol types for the Myco Agent Discovery Protocol (MADP).
//! Zero network dependencies — only serde + chrono.
//! Use this crate when you only need the protocol types (e.g., pure protocol agents,
//! code generators, non-Rust interop).

pub mod protocol;

pub use protocol::*;
