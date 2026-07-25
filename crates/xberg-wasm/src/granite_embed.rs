//! Stateful WASM façade for the shared Granite dense embedder.

use serde::Serialize;
use wasm_bindgen::prelude::*;
use xberg_candle_embed::GraniteEmbedder;

#[derive(Debug, Serialize)]
struct GraniteIdentity {
    model: String,
    revision: String,
    artifact_sha256: String,
    tokenizer_sha256: String,
    config_sha256: String,
    source_dtype: String,
    runtime_dtype: String,
    pooling: String,
    normalize: bool,
    dimension: usize,
}

#[wasm_bindgen]
pub struct GraniteEmbeddingModel {
    model: Option<GraniteEmbedder>,
}

#[wasm_bindgen]
impl GraniteEmbeddingModel {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self { model: None }
    }

    #[wasm_bindgen(js_name = loadBytes)]
    pub fn load_bytes(&mut self, safetensors: &[u8], tokenizer_json: &[u8], config_json: &[u8]) -> Result<(), JsValue> {
        let model = GraniteEmbedder::from_safetensors_bytes(safetensors, tokenizer_json, config_json)
            .map_err(|error| JsValue::from_str(&format!("Granite embedding model load failed: {error}")))?;
        self.model = Some(model);
        Ok(())
    }

    #[wasm_bindgen(js_name = embedDocuments)]
    pub fn embed_documents(&self, texts: Vec<String>) -> Result<JsValue, JsValue> {
        let model = self
            .model
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Granite embedding model is not loaded"))?;
        let vectors = model
            .embed_documents(&texts)
            .map_err(|error| JsValue::from_str(&format!("Granite embedding failed: {error}")))?;
        serde_wasm_bindgen::to_value(&vectors)
            .map_err(|error| JsValue::from_str(&format!("Granite embedding serialization failed: {error}")))
    }

    #[wasm_bindgen(js_name = embedQuery)]
    pub fn embed_query(&self, text: &str) -> Result<JsValue, JsValue> {
        let model = self
            .model
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Granite embedding model is not loaded"))?;
        let vector = model
            .embed_query(text)
            .map_err(|error| JsValue::from_str(&format!("Granite query embedding failed: {error}")))?;
        serde_wasm_bindgen::to_value(&vector)
            .map_err(|error| JsValue::from_str(&format!("Granite query serialization failed: {error}")))
    }

    #[wasm_bindgen(js_name = identity)]
    pub fn identity(&self) -> Result<JsValue, JsValue> {
        let model = self
            .model
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Granite embedding model is not loaded"))?;
        let source = model.identity();
        serde_wasm_bindgen::to_value(&GraniteIdentity {
            model: source.model.clone(),
            revision: source.revision.clone(),
            artifact_sha256: source.artifact_sha256.clone(),
            tokenizer_sha256: source.tokenizer_sha256.clone(),
            config_sha256: source.config_sha256.clone(),
            source_dtype: source.source_dtype.clone(),
            runtime_dtype: source.runtime_dtype.clone(),
            pooling: source.pooling.clone(),
            normalize: source.normalize,
            dimension: source.dimension,
        })
        .map_err(|error| JsValue::from_str(&format!("Granite identity serialization failed: {error}")))
    }

    #[wasm_bindgen(getter, js_name = isLoaded)]
    pub fn is_loaded(&self) -> bool {
        self.model.is_some()
    }
}

impl Default for GraniteEmbeddingModel {
    fn default() -> Self {
        Self::new()
    }
}
