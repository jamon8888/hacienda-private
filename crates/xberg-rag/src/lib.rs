//! Isomorphic RAG core (see spec 2026-07-21).

mod embed;
mod engine;
mod error;
mod flat;
mod legacy;
mod paths;
mod snapshot;
mod store;
#[cfg(feature = "testing")]
mod testing;
mod types;

pub use embed::Embedder;
pub use engine::{ChunkInput, DocumentInput, RagEngine};
pub use error::{RagError, Result};
pub use flat::FlatStore;
pub use legacy::{LegacyChunk, read_bundle_chunks};
pub use paths::{MatterPaths, default_mirrors_dir, encode_uri_component};
pub use snapshot::SNAPSHOT_VERSION;
pub use store::SearchStore;
#[cfg(feature = "testing")]
pub use testing::MockEmbedder;
pub use types::{EmbeddingIdentity, IndexedChunk, RetrievedChunk};

/// Shared Granite dense embedding dimension. Kept as a compatibility constant
/// for hosts that size an index before loading its persisted identity.
pub const EMBED_DIM: usize = 384;
