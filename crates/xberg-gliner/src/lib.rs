//! Span-mode GLiNER ONNX inference.
//!
//! This crate vendors the span-mode preprocessing and decoding path from the
//! `gline-rs` project and replaces its pipeline wrapper with direct `ort`
//! session management.

mod config;
pub mod decode;
#[cfg(feature = "ort-backend")]
mod engine;
mod error;
mod input;
#[cfg(feature = "ort-backend")]
mod preprocess;
#[cfg(feature = "ort-backend")]
mod session;
// Only used by the ORT engines (engine.rs, preprocess.rs); dead weight
// without ort-backend.
#[cfg(feature = "ort-backend")]
mod splitter;
#[cfg(feature = "ort-backend")]
mod tensor;
#[cfg(feature = "ort-backend")]
mod tokenizer;
mod v2;

pub use config::{Parameters, RuntimeConfig};
pub use decode::{Span, SpanOutput};
#[cfg(feature = "ort-backend")]
pub use engine::Gliner;
pub use error::{GlinerError, Result};
#[cfg(feature = "ort-backend")]
pub use input::TextInput;
pub use input::Token;
#[cfg(feature = "ort-backend")]
pub use session::{INPUT_NAMES, OUTPUT_NAMES};
#[cfg(feature = "ort-backend")]
pub use v2::engine::Gliner2;
pub use v2::preprocess::{V2Encoded, encode_v2};
#[cfg(feature = "ort-backend")]
pub use v2::session::{INPUT_NAMES_V2, OUTPUT_NAMES_V2};
pub use v2::splitter::V2Splitter;
pub use v2::tokenizer::{PretokenizedEncoding, PretokenizingTokenizer, V2Tokenizer};

#[cfg(feature = "ort-backend")]
pub(crate) use decode::EntityContext;
#[cfg(feature = "ort-backend")]
pub(crate) use preprocess::EncodedInput;

#[cfg(all(test, feature = "ort-backend"))]
mod tests;
