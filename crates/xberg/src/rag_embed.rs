//! Adapter binding xberg's embedding engine to [`xberg_rag::Embedder`].
//!
//! Lives here rather than in `xberg-rag` because `xberg-rag` must never depend
//! on `xberg` — that edge would be a dependency cycle, and it is what keeps the
//! RAG core dependency-light and wasm-clean.

use crate::core::config::{EmbeddingConfig, EmbeddingModelType};
use xberg_rag::{Embedder, RagError};

/// Probe text used once at construction to measure the model's output width.
const DIM_PROBE: &str = "dimension probe";

/// A [`xberg_rag::Embedder`] backed by [`crate::embed_texts`].
///
/// Holds only the config — the underlying model engine is owned and cached by
/// `embed_texts` itself, so this type is cheap to clone and `Send + Sync`.
#[derive(Debug, Clone)]
pub struct XbergEmbedder {
    config: EmbeddingConfig,
    dim: usize,
}

impl XbergEmbedder {
    /// Build an embedder from an explicit config, measuring its dimension.
    ///
    /// # Errors
    /// Returns [`RagError::Embed`] if the model cannot be loaded or the probe
    /// embed produces no vector.
    pub fn new(config: EmbeddingConfig) -> xberg_rag::Result<Self> {
        let probe = crate::embed_texts(vec![DIM_PROBE.to_string()], &config)
            .map_err(|e| RagError::Embed(format!("failed to load embedding model: {e}")))?;
        let dim = probe
            .first()
            .map(Vec::len)
            .ok_or_else(|| RagError::Embed("probe embed returned no vectors".to_string()))?;
        if dim == 0 {
            return Err(RagError::Embed("probe embed returned a zero-length vector".to_string()));
        }
        Ok(Self { config, dim })
    }

    /// Build an embedder from a bundled preset name.
    ///
    /// The native host defaults to `"lightweight"` (model2vec, pure Rust): the
    /// spec's R3 mitigation says not to hard-require a bundled ONNX Runtime on
    /// the server target.
    pub fn from_preset(name: &str) -> xberg_rag::Result<Self> {
        Self::new(EmbeddingConfig {
            model: EmbeddingModelType::Preset { name: name.to_string() },
            ..EmbeddingConfig::default()
        })
    }
}

impl Embedder for XbergEmbedder {
    fn dim(&self) -> usize {
        self.dim
    }

    fn embed_documents(&self, texts: &[String]) -> xberg_rag::Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        crate::embed_texts(texts.to_vec(), &self.config).map_err(|e| RagError::Embed(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_batch_needs_no_model() {
        // Constructed by hand so the test never touches a model: `new()` probes,
        // this does not.
        let e = XbergEmbedder {
            config: EmbeddingConfig::default(),
            dim: 4,
        };
        assert_eq!(e.embed_documents(&[]).unwrap(), Vec::<Vec<f32>>::new());
        assert_eq!(e.dim(), 4);
    }

    #[test]
    fn unknown_preset_is_an_embed_error() {
        let err = XbergEmbedder::from_preset("no-such-preset-xyz").unwrap_err();
        assert!(matches!(err, RagError::Embed(_)), "got {err:?}");
    }

    /// Network + model download — excluded from CI (no model egress).
    /// Run manually: `cargo test -p xberg --features embeddings -- --ignored lightweight_preset_has_expected_dim`
    #[test]
    #[ignore = "downloads a model; violates the no-egress-in-CI constraint"]
    fn lightweight_preset_has_expected_dim() {
        let e = XbergEmbedder::from_preset("lightweight").unwrap();
        assert_eq!(e.dim(), 256, "model2vec potion-base-8m is 256-dimensional");
        let v = e.embed_query("hello").unwrap();
        assert_eq!(v.len(), 256);
    }
}
