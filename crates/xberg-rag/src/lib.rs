//! Isomorphic RAG core (see spec 2026-07-21).

mod error;
mod flat;
mod snapshot;
mod store;
mod types;

pub use error::{RagError, Result};
pub use flat::FlatStore;
pub use snapshot::SNAPSHOT_VERSION;
pub use store::SearchStore;
pub use types::{IndexedChunk, RetrievedChunk};

/// Dense embedding dimension (e5). Mirrors `EMBED_DIM` in the TS pipeline.
pub const EMBED_DIM: usize = 768;
