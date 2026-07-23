# Shared Granite embedding Candle/WASM spike

**Date:** 2026-07-23

The shared embedding implementation is `crates/xberg-candle-embed`. It loads
`ibm-granite/granite-embedding-97m-multilingual-r2` with Candle's ModernBERT
graph, maps the published Granite safetensor keys into Candle's `model.*`
namespace, converts BF16 weights to runtime F32, applies CLS pooling and L2
normalization, and exposes the same byte-loading API to native Rust and
`wasm32-unknown-unknown`.

Compile-only verification passed for the crate on native and WASM targets.
The complete `xberg-wasm` feature build is still a verification gate because it
includes the repository's other WASM assets and takes substantially longer.

Pinned artifacts are revision
`835ad14087e140460703cf0fae09f97d469d65c2`:

- `model.safetensors`: 194,889,568 bytes, SHA-256
  `f3ea88b230492811046145513710e76b4cc8c2ad49e8708da0e7247e548903be`
- `tokenizer.json`: SHA-256
  `4f2842d568e2724370aec203652a42ac783c7937f8347a1a2cc7506d71f1582f`
- `config.json`: SHA-256
  `de948b0bdc6f356afad7a84b276d8dd7e7fe10fb9add1bb5e610621c28e41ebc`

This spike proves graph construction and target portability, not numerical
parity or browser latency. Before release, download the pinned artifacts in CI
or a fixture job, compare a fixed sentence set against the reference model,
and measure first-load plus batch-indexing latency in a representative legal
document. The large weight artifact must be published through the model
manifest/CDN; it is intentionally not committed to Git.
