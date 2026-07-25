//! Minimal stateful WASM façade for the Candle GLiNER2 bytes backend.
//!
//! This module is intentionally hand-written and registered through
//! `[crates.wasm].custom_rust_modules`; the generated binding file only owns
//! the extraction API. Model bytes stay in this session object and never enter
//! `ExtractionConfig` or any generated DTO.

use serde::Serialize;
use wasm_bindgen::prelude::*;
use xberg_gliner::candle::Gliner2Candle;

#[derive(Debug, Serialize)]
struct Gliner2Span {
    start: usize,
    end: usize,
    text: String,
    label: String,
    probability: f32,
}

/// A reusable GLiNER2 model session owned by a browser Worker.
#[wasm_bindgen]
pub struct Gliner2Model {
    model: Option<Gliner2Candle>,
}

#[wasm_bindgen]
impl Gliner2Model {
    /// Create an empty session. Call [`loadBytes`](Self::load_bytes) once before inference.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self { model: None }
    }

    /// Load a model from its safetensors, tokenizer, and encoder-config bytes.
    ///
    /// Replacing the model is explicit and drops the previous Candle tensors before
    /// constructing the new session, which lets the Worker control artifact generations.
    #[wasm_bindgen(js_name = loadBytes)]
    pub fn load_bytes(
        &mut self,
        safetensors: &[u8],
        tokenizer_json: &[u8],
        encoder_config_json: &[u8],
    ) -> Result<(), JsValue> {
        let model = Gliner2Candle::from_bytes(safetensors, tokenizer_json, encoder_config_json)
            .map_err(|error| JsValue::from_str(&format!("GLiNER2 model load failed: {error}")))?;
        self.model = Some(model);
        Ok(())
    }

    /// Extract zero-shot entities from one text using the supplied labels.
    #[wasm_bindgen(js_name = extractNer)]
    pub fn extract_ner(&self, text: &str, labels: Vec<String>, threshold: Option<f32>) -> Result<JsValue, JsValue> {
        let model = self
            .model
            .as_ref()
            .ok_or_else(|| JsValue::from_str("GLiNER2 model is not loaded"))?;
        let label_refs: Vec<&str> = labels.iter().map(String::as_str).collect();
        let spans = model
            .extract_ner(text, &label_refs, threshold.unwrap_or(0.5))
            .map_err(|error| JsValue::from_str(&format!("GLiNER2 inference failed: {error}")))?;
        let result: Vec<Gliner2Span> = spans
            .into_iter()
            .map(|span| {
                let (start, end) = span.offsets();
                Gliner2Span {
                    start,
                    end,
                    text: span.text().to_owned(),
                    label: span.class().to_owned(),
                    probability: span.probability(),
                }
            })
            .collect();
        serde_wasm_bindgen::to_value(&result)
            .map_err(|error| JsValue::from_str(&format!("GLiNER2 result serialization failed: {error}")))
    }

    /// Whether this session currently owns initialized model tensors.
    #[wasm_bindgen(getter, js_name = isLoaded)]
    pub fn is_loaded(&self) -> bool {
        self.model.is_some()
    }
}

impl Default for Gliner2Model {
    fn default() -> Self {
        Self::new()
    }
}
