//! NER (named-entity recognition) configuration.
//!
//! When `ExtractionConfig::ner` is `Some`, the NER post-processor runs after
//! extraction and populates [`ExtractedDocument::entities`](crate::types::ExtractedDocument::entities).

use crate::types::entity::EntityCategory;
use serde::{Deserialize, Serialize};

/// Configuration for the NER post-processor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "api", derive(utoipa::ToSchema))]
#[cfg_attr(feature = "alef-meta", alef(since = "5.0.0"))]
#[derive(Default)]
pub struct NerConfig {
    /// Backend that runs the entity detection.
    #[serde(default)]
    pub backend: NerBackendKind,
    /// Entity categories to detect. Defaults to a sensible PERSON/ORG/LOCATION/EMAIL set
    /// when empty.
    #[serde(default)]
    pub categories: Vec<EntityCategory>,
    /// Override the model. For ONNX this is an xberg model alias; for Candle it
    /// is a local directory containing the GLiNER2 artifacts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Optional local PEFT/LoRA adapter directory used by the Candle backend.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter: Option<String>,
    /// Optional LLM configuration — only used by [`NerBackendKind::Llm`]. Token usage
    /// for LLM backends is recorded in `ExtractedDocument::llm_usage`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm: Option<super::llm::LlmConfig>,
    /// Arbitrary user-supplied entity labels for zero-shot detection.
    ///
    /// `xberg-gliner` natively supports zero-shot inference over caller-supplied
    /// labels. The LLM backend also honours these
    /// labels by including them in the structured-output schema. Custom labels
    /// surface as [`EntityCategory::Custom`] in the resulting `Entity` stream.
    ///
    /// Use this when you need domain-specific entity types (e.g. `"Treatment"`,
    /// `"Product"`, `"Vessel"`) without forking GLiNER's taxonomy.
    #[serde(default)]
    pub custom_labels: Vec<String>,
}

/// NER backend selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "api", derive(utoipa::ToSchema))]
#[serde(rename_all = "snake_case")]
pub enum NerBackendKind {
    /// `xberg-gliner` ONNX inference. Requires `ner-onnx` feature. Models
    /// download lazily from `xberg-io/gliner-models`.
    #[default]
    Onnx,
    /// liter-llm zero-shot NER via structured-output prompts. Requires `ner-llm`
    /// feature. Useful when domain-specific categories outstrip the ONNX taxonomy.
    Llm,
    /// Pure-Rust Candle GLiNER2 inference from local safetensors artifacts.
    /// Requires the `ner-candle` feature.
    Candle,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candle_backend_round_trips_with_local_artifacts() {
        let config = NerConfig {
            backend: NerBackendKind::Candle,
            model: Some("models/gliner2".into()),
            adapter: Some("models/pii-adapter".into()),
            ..Default::default()
        };
        let json = serde_json::to_string(&config).expect("serialize config");
        let restored: NerConfig = serde_json::from_str(&json).expect("deserialize config");
        assert_eq!(restored.backend, NerBackendKind::Candle);
        assert_eq!(restored.model.as_deref(), Some("models/gliner2"));
        assert_eq!(restored.adapter.as_deref(), Some("models/pii-adapter"));
    }
}
