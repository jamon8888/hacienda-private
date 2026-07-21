//! Isomorphic RAG core (see spec 2026-07-21).

mod error;
mod types;

pub use error::{RagError, Result};
pub use types::{IndexedChunk, RetrievedChunk};

/// Dense embedding dimension (e5). Mirrors `EMBED_DIM` in the TS pipeline.
pub const EMBED_DIM: usize = 768;
