use crate::{RagError, Result};

/// Turns text into dense vectors. The only seam between [`crate::RagEngine`] and
/// any embedding backend, so the engine is testable without a model on disk and
/// `xberg-rag` never has to depend on `xberg` (which would be a dependency cycle
/// — the adapter for the real engine lives in `crates/xberg/src/rag_embed.rs`).
pub trait Embedder {
    /// Dimension of every vector this embedder produces. A store is created with
    /// this value, so it must be stable for the embedder's lifetime.
    fn dim(&self) -> usize;

    /// Embed a batch of documents (chunk texts).
    fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;

    /// Embed one query string. Defaults to a single-item [`Embedder::embed_documents`]
    /// call; backends with an asymmetric query prefix (e5's `"query: "`) override it.
    fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
        let mut out = self.embed_documents(&[text.to_string()])?;
        if out.len() != 1 {
            return Err(RagError::Embed(format!(
                "embedder returned {} vectors for 1 query",
                out.len()
            )));
        }
        Ok(out.remove(0))
    }
}
