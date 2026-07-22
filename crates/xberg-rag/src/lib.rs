//! Isomorphic RAG core (see spec 2026-07-21).

mod embed;
mod error;
mod flat;
mod snapshot;
mod store;
#[cfg(feature = "testing")]
mod testing;
mod types;

pub use embed::Embedder;
pub use error::{RagError, Result};
pub use flat::FlatStore;
pub use snapshot::SNAPSHOT_VERSION;
pub use store::SearchStore;
#[cfg(feature = "testing")]
pub use testing::MockEmbedder;
pub use types::{IndexedChunk, RetrievedChunk};

/// Dense embedding dimension (e5). Mirrors `EMBED_DIM` in the TS pipeline.
pub const EMBED_DIM: usize = 768;
