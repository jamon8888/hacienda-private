//! Adapter binding xberg's embedding engine to [`xberg_rag::Embedder`].
//!
//! Lives here rather than in `xberg-rag` because `xberg-rag` must never depend
//! on `xberg` — that edge would be a dependency cycle, and it is what keeps the
//! RAG core dependency-light and wasm-clean.

use crate::core::config::{EmbeddingConfig, EmbeddingModelType};
#[cfg(feature = "embedding-presets")]
use std::path::Path;
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};
use xberg_rag::{Embedder, EmbeddingIdentity, RagError};

/// Probe text used once at construction to measure the model's output width.
const DIM_PROBE: &str = "dimension probe";
const PIPELINE_VERSION: &str = "xberg-embedding-pipeline-v1";

static PRESET_CACHE: LazyLock<Mutex<HashMap<String, XbergEmbedder>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// A [`xberg_rag::Embedder`] backed by [`crate::embed_texts`].
///
/// Holds only the config — the underlying model engine is owned and cached by
/// `embed_texts` itself. Preset adapters are cached too, avoiding a redundant
/// dimension probe for each request.
#[derive(Debug, Clone)]
pub struct XbergEmbedder {
    config: EmbeddingConfig,
    identity: EmbeddingIdentity,
}

#[cfg(feature = "embedding-presets")]
fn digest_manifest_paths(paths: &[String], context: &str) -> xberg_rag::Result<String> {
    let entries: HashMap<&str, &str> = crate::embeddings::EMBEDDING_SHA256_MANIFEST
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            line.split_once(char::is_whitespace)
                .map(|(digest, path)| (path.trim(), digest))
        })
        .collect();
    let mut paths = paths.to_vec();
    paths.sort();
    let mut hasher = blake3::Hasher::new();
    for path in paths {
        let digest = entries.get(path.as_str()).ok_or_else(|| {
            RagError::Embed(format!(
                "embedding {context} identity is not pinned in the SHA-256 manifest: {path}"
            ))
        })?;
        hasher.update(path.as_bytes());
        hasher.update(b"\0");
        hasher.update(digest.as_bytes());
        hasher.update(b"\0");
    }
    Ok(format!("blake3:{}", hasher.finalize().to_hex()))
}

#[cfg(feature = "embedding-presets")]
fn identity_for_config(config: &EmbeddingConfig, dimension: usize) -> xberg_rag::Result<EmbeddingIdentity> {
    let EmbeddingModelType::Preset { name } = &config.model else {
        return Err(RagError::Embed(
            "RAG snapshots require a pinned embedding preset identity".to_string(),
        ));
    };
    let preset = crate::embeddings::get_preset(name)
        .ok_or_else(|| RagError::Embed(format!("unknown embedding preset: {name}")))?;
    if preset.dimensions != dimension {
        return Err(RagError::Embed(format!(
            "preset {name:?} declares {} dimensions but produced {dimension}",
            preset.dimensions
        )));
    }

    let mut artifact_paths = vec![preset.model_file.clone()];
    artifact_paths.extend(preset.additional_files.clone());
    let model_dir = Path::new(&preset.model_file).parent().unwrap_or_else(|| Path::new(""));
    let tokenizer_candidates = [
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "config.json",
        "vocab.txt",
    ];
    let manifest = crate::embeddings::EMBEDDING_SHA256_MANIFEST;
    let mut tokenizer_paths: Vec<String> = tokenizer_candidates
        .into_iter()
        .map(|name| model_dir.join(name).to_string_lossy().into_owned())
        .filter(|path| manifest.lines().any(|line| line.trim_end().ends_with(path)))
        .collect();
    if !tokenizer_paths.iter().any(|path| path.ends_with("tokenizer.json"))
        || !tokenizer_paths.iter().any(|path| path.ends_with("config.json"))
    {
        return Err(RagError::Embed(format!(
            "preset {name:?} lacks a pinned tokenizer/config identity"
        )));
    }
    tokenizer_paths.push(format!(
        "max_sequence_length={}",
        config
            .max_sequence_length
            .map_or_else(|| "backend-default".to_string(), |value| value.to_string())
    ));
    let max_sequence_entry = tokenizer_paths.pop().expect("just pushed");
    let tokenizer_digest = digest_manifest_paths(&tokenizer_paths, "tokenizer/config")?;
    let tokenizer_revision = format!("{tokenizer_digest};{max_sequence_entry}");

    Ok(EmbeddingIdentity {
        artifact_digest: digest_manifest_paths(&artifact_paths, "artifact")?,
        tokenizer_revision,
        pooling: format!("{};normalize={}", preset.pooling, config.normalize),
        instruction: format!(
            "documents=raw;queries={}",
            preset.query_prefix.as_deref().unwrap_or("raw")
        ),
        quantization: if preset.model_file.contains("quantized") {
            "quantized".to_string()
        } else {
            "none".to_string()
        },
        dimension,
        pipeline_version: PIPELINE_VERSION.to_string(),
    })
}

#[cfg(not(feature = "embedding-presets"))]
fn identity_for_config(_config: &EmbeddingConfig, _dimension: usize) -> xberg_rag::Result<EmbeddingIdentity> {
    Err(RagError::Embed(
        "RAG snapshots require the embedding-presets feature".to_string(),
    ))
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
        let identity = identity_for_config(&config, dim)?;
        Ok(Self { config, identity })
    }

    /// Build an embedder from a bundled preset name.
    ///
    /// The native host defaults to `"lightweight"` (model2vec, pure Rust): the
    /// spec's R3 mitigation says not to hard-require a bundled ONNX Runtime on
    /// the server target.
    pub fn from_preset(name: &str) -> xberg_rag::Result<Self> {
        let mut cache = PRESET_CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(embedder) = cache.get(name) {
            return Ok(embedder.clone());
        }

        let embedder = Self::new(EmbeddingConfig {
            model: EmbeddingModelType::Preset { name: name.to_string() },
            ..EmbeddingConfig::default()
        })?;
        cache.insert(name.to_string(), embedder.clone());
        Ok(embedder)
    }
}

impl Embedder for XbergEmbedder {
    fn identity(&self) -> &EmbeddingIdentity {
        &self.identity
    }

    fn embed_documents(&self, texts: &[String]) -> xberg_rag::Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        crate::embed_texts(texts.to_vec(), &self.config).map_err(|e| RagError::Embed(e.to_string()))
    }

    fn embed_query(&self, text: &str) -> xberg_rag::Result<Vec<f32>> {
        #[cfg(feature = "embedding-presets")]
        let prefix = crate::embedding_query_prefix(&self.config).unwrap_or_default();
        #[cfg(not(feature = "embedding-presets"))]
        let prefix = String::new();
        let query = format!("{prefix}{text}");
        let mut vectors = self.embed_documents(&[query])?;
        if vectors.len() != 1 {
            return Err(RagError::Embed(format!(
                "embedder returned {} vectors for 1 query",
                vectors.len()
            )));
        }
        Ok(vectors.remove(0))
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
            identity: EmbeddingIdentity {
                artifact_digest: "test".into(),
                tokenizer_revision: "test".into(),
                pooling: "test".into(),
                instruction: "test".into(),
                quantization: "none".into(),
                dimension: 4,
                pipeline_version: PIPELINE_VERSION.into(),
            },
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

    #[test]
    fn lightweight_identity_covers_the_complete_embedding_contract() {
        let config = EmbeddingConfig {
            model: EmbeddingModelType::Preset {
                name: "lightweight".to_string(),
            },
            ..EmbeddingConfig::default()
        };
        let identity = identity_for_config(&config, 256).unwrap();
        assert!(identity.artifact_digest.starts_with("blake3:"));
        assert!(identity.tokenizer_revision.starts_with("blake3:"));
        assert_eq!(identity.pooling, "mean;normalize=true");
        assert_eq!(identity.instruction, "documents=raw;queries=raw");
        assert_eq!(identity.quantization, "none");
        assert_eq!(identity.dimension, 256);
        assert_eq!(identity.pipeline_version, PIPELINE_VERSION);
    }
}
