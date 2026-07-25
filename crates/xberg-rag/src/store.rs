use crate::{IndexedChunk, Result, RetrievedChunk};

/// A vector store that can ingest embedded chunks and answer similarity queries.
/// Implemented once per backend (P1: `FlatStore`; P2: an edgevec HNSW backend),
/// and bound identically by the browser (wasm32) and server (native) hosts.
pub trait SearchStore: Sized {
    /// Create an empty store for `dim`-dimensional vectors.
    fn new(dim: usize) -> Self;
    /// Add embedded chunks. Errors on any vector whose length != `dim`.
    fn ingest(&mut self, items: &[IndexedChunk]) -> Result<()>;
    /// Return the `top_k` nearest chunks to `query`, highest score first.
    fn search(&self, query: &[f32], top_k: usize) -> Result<Vec<RetrievedChunk>>;
    /// Number of indexed chunks.
    fn len(&self) -> usize;
    /// Whether the store holds no chunks.
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// Serialize the whole store to a versioned, portable byte snapshot.
    fn snapshot(&self) -> Result<Vec<u8>>;
    /// Rebuild a store from bytes produced by [`SearchStore::snapshot`].
    fn load(bytes: &[u8]) -> Result<Self>;
}
