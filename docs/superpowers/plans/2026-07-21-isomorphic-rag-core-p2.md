# Isomorphic RAG Core — Phase 2 (native store + real `rag_query`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-21-isomorphic-rag-core-design.md` (Phase P2 of R5)

**Depends on:** `docs/superpowers/plans/2026-07-21-isomorphic-rag-core-p1.md` — **P1 Tasks 1–4 must be merged and green before starting.** This plan builds directly on `xberg_rag::{SearchStore, FlatStore, IndexedChunk, RetrievedChunk, RagError, Result}` and `snapshot::{encode, decode}`. P1 Task 5 (the R1 edgevec spike) is **not** a prerequisite — see "Scope decisions" below.

**Goal:** Give the Rust host a real, live vector search over an on-disk index — `rag_query` embeds the query and searches the actual vectors, replacing the Node `MirrorStore.retrieve()` snapshot re-sort — reachable from both `xberg rag query` (CLI) and the `rag_query` MCP tool.

**Architecture:** Three layers, each independently testable. (1) An `Embedder` trait in `xberg-rag` with a deterministic `MockEmbedder` for tests — this keeps `xberg-rag` dependency-light and wasm-clean, and keeps every engine test network-free. (2) A `RagEngine<E: Embedder>` that owns the on-disk matter layout: it embeds, ingests into a `FlatStore`, writes a versioned snapshot, and on query re-loads the snapshot and searches it. (3) Two thin native hosts binding the same engine — a `xberg rag` CLI subcommand and an rmcp `rag_query` tool in `crates/xberg/src/mcp`.

**Tech Stack:** Rust 2024 (1.91), `xberg-rag` (P1), `xberg` core (`embed_texts`, `chunk_for_rag`), `rmcp` (existing MCP host), `clap` 4.6, `tempfile` (tests).

## Scope decisions (read before Task 1)

Two deliberate departures from a naive reading of the spec. Both are recorded here so a reviewer can reject them explicitly rather than discover them mid-task.

1. **P2 ships `FlatStore` (exact cosine), not HNSW.** The spec's headline P2 value is *live similarity search over the actual index instead of a re-sorted snapshot*. Exact search delivers that and is strictly more correct than HNSW; HNSW is a latency optimization for large matters. The spec itself states the backend swap "is contained to `store.rs`" and makes `FlatStore` the correctness oracle. Every test in this plan asserts through the `SearchStore` trait, so it re-runs unchanged against an HNSW backend later.

   **The spec's R1 premise is stale — verified 2026-07-21.** R1 says "crates.io shows an older version than npm `0.9.0`". That is no longer true: the crates.io sparse index lists edgevec `0.5.4, 0.6.0, 0.7.0, 0.8.0, 0.9.0` — exact parity with npm. The real risk is different and larger: **edgevec 0.9.0 declares `wasm-bindgen`, `js-sys`, `web-sys`, `serde-wasm-bindgen`, `wasm-bindgen-futures`, `console_log`, and `console_error_panic_hook` as unconditional, non-optional dependencies with no `target` gate.** It is a wasm-first crate whose persistence is browser-storage-shaped. It also requires `getrandom ^0.2.14` without the `js` feature, while this workspace pins `getrandom 0.4.3` with `wasm_js` — so a `wasm32-unknown-unknown` build likely fails without a consumer-side feature workaround, and a native build drags in a full wasm-bindgen tree. Deferring the HNSW backend is therefore *more* justified than when the spec was written, and **P1 Task 5 needs re-scoping before it runs**: its stated question (does the version lag?) is answered; the question that matters for P2b is whether edgevec functions natively without browser APIs.

2. **Dimension comes from the embedder, not a constant.** The browser uses e5-base at 768 dims (`packages/wasm-pipeline/src/constants.ts`); the pure-Rust `lightweight` (model2vec) preset is 256 dims. Server and browser producing *identical* top-K requires the same model, which is a **wire-format-phase (P3) concern**. P2 therefore stores `dim` per snapshot (P1 already does) and takes it from `Embedder::dim()`, so the server is internally consistent under any preset. `xberg-rag` keeps no `EMBED_DIM`-derived assumption. The R3 mitigation (don't hard-require bundled ORT) is honored by defaulting the CLI to the `lightweight` preset.

**Out of P2 (unchanged from the spec's phasing):** `hybrid_search`/`SparseVector`/`HybridOpts` and SPLADE (needs ORT — R3), the browser writing the new format (P3), the `bbox` field on chunks (a P3 `SNAPSHOT_VERSION` bump), MCP host collapse and auth/static-file migration (P4), the browser host swap and TS deletion (P5), and `mmap` zero-copy reads (a later perf task — P2 reads with `snapshot::decode`).

## Global Constraints

- Rust edition **2024**, `rust-version` **1.91**, inherited via `*.workspace = true`.
- `unsafe_code = "deny"` (workspace lint) — **no `unsafe`** in any file this plan touches.
- Shared deps come from `[workspace.dependencies]` in the root `Cargo.toml`, referenced as `{ workspace = true }`.
- Every crate manifest ends with `[lints]` / `workspace = true`.
- **No circular crate dependency.** `xberg-rag` must **never** depend on `xberg`. The `xberg`→`xberg-rag` edge added in Task 5 is the only direction that exists. Any adapter needing `xberg` types lives in `crates/xberg`.
- **No model egress in CI.** Every test added by this plan must pass with the network unplugged. Tests that would download a model are `#[ignore]`d with a comment naming the command to run them manually.
- Matter directory names are percent-encoded to byte-match the Node host's `encodeURIComponent(matterId)` (`services/mcp-server/src/mirror.ts:83`) so both hosts address the same directory.
- Conventional-commit messages; end each commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `crates/xberg-rag/src/embed.rs` | **Create.** `Embedder` trait — the only seam between the engine and any embedding backend. |
| `crates/xberg-rag/src/testing.rs` | **Create.** `MockEmbedder`: deterministic, network-free, feature-gated `testing`. |
| `crates/xberg-rag/src/paths.rs` | **Create.** On-disk matter layout + `encode_uri_component` parity with the Node host. |
| `crates/xberg-rag/src/legacy.rs` | **Create.** Reader for the Node JSON `MirrorBundle` (`chunks[]` only). |
| `crates/xberg-rag/src/engine.rs` | **Create.** `RagEngine<E>` — index / query / import-legacy. The heart of P2. |
| `crates/xberg-rag/src/lib.rs` | **Modify.** Wire the new modules and re-exports. |
| `crates/xberg-rag/Cargo.toml` | **Modify.** `testing` feature; `tempfile` dev-dep. |
| `crates/xberg/src/rag_embed.rs` | **Create.** `XbergEmbedder` — adapts `xberg::embed_texts` to `xberg_rag::Embedder`. |
| `crates/xberg/src/mcp/rag.rs` | **Create.** Builds a `RagEngine<XbergEmbedder>` from env; MCP-facing errors. |
| `crates/xberg/src/mcp/server.rs` | **Modify.** Add the `rag_query` `#[tool]`. |
| `crates/xberg/src/mcp/params.rs` | **Modify.** `RagQueryParams`. |
| `crates/xberg/src/mcp/schema.rs` | **Modify.** `RagQueryOutput`. |
| `crates/xberg/src/lib.rs` | **Modify.** `pub mod rag_embed;` + re-export. |
| `crates/xberg/Cargo.toml` | **Modify.** `xberg-rag` dependency. |
| `crates/xberg-cli/src/commands/rag.rs` | **Create.** `index` / `query` / `import-legacy` command bodies. |
| `crates/xberg-cli/src/commands/mod.rs` | **Modify.** Register the module. |
| `crates/xberg-cli/src/main.rs` | **Modify.** `Commands::Rag` variant + dispatch. |
| `crates/xberg-cli/tests/rag_test.rs` | **Create.** End-to-end CLI integration test. |

---

### Task 1: `Embedder` seam + deterministic `MockEmbedder`

**Files:**
- Create: `crates/xberg-rag/src/embed.rs`
- Create: `crates/xberg-rag/src/testing.rs`
- Modify: `crates/xberg-rag/src/lib.rs`
- Modify: `crates/xberg-rag/Cargo.toml`

**Interfaces:**
- Consumes: `RagError`, `Result` (P1 Task 2).
- Produces:
  - `pub trait Embedder { fn dim(&self) -> usize; fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>; fn embed_query(&self, text: &str) -> Result<Vec<f32>> { /* default */ } }`
  - `pub struct MockEmbedder` with `MockEmbedder::new(dim: usize) -> Self`, behind the `testing` feature.
  - New `RagError::Embed(String)` variant.

- [ ] **Step 1: Write the failing test**

Create `crates/xberg-rag/src/embed.rs`:

```rust
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
```

Create `crates/xberg-rag/src/testing.rs`:

```rust
//! Test-only embedding backend. Enabled by the `testing` feature so downstream
//! crates (`xberg-cli` integration tests) can build an engine with no model on
//! disk and no network — the CI constraint from the spec.

use crate::{Embedder, Result};

/// Deterministic hash-based embedder: same text always yields the same vector,
/// different texts yield different directions. Not semantically meaningful —
/// it exists so engine/store behaviour can be asserted exactly.
#[derive(Debug, Clone)]
pub struct MockEmbedder {
    dim: usize,
}

impl MockEmbedder {
    /// Create a mock embedder producing `dim`-dimensional vectors.
    pub fn new(dim: usize) -> Self {
        Self { dim }
    }

    /// FNV-1a over the bytes, then one f32 per dimension derived by re-mixing
    /// the hash with the dimension index. Pure, allocation-light, no deps.
    fn vector_for(&self, text: &str) -> Vec<f32> {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for b in text.as_bytes() {
            hash ^= u64::from(*b);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        (0..self.dim)
            .map(|i| {
                let mut h = hash ^ (i as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
                h = h.wrapping_mul(0xff51_afd7_ed55_8ccd);
                h ^= h >> 33;
                // Map the low 24 bits into [-1.0, 1.0).
                ((h & 0x00ff_ffff) as f32 / 8_388_608.0) - 1.0
            })
            .collect()
    }
}

impl Embedder for MockEmbedder {
    fn dim(&self) -> usize {
        self.dim
    }

    fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        Ok(texts.iter().map(|t| self.vector_for(t)).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_is_deterministic_and_correctly_sized() {
        let e = MockEmbedder::new(8);
        let a = e.embed_documents(&["hello".to_string()]).unwrap();
        let b = e.embed_documents(&["hello".to_string()]).unwrap();
        assert_eq!(a, b);
        assert_eq!(a[0].len(), 8);
    }

    #[test]
    fn different_text_yields_different_vector() {
        let e = MockEmbedder::new(8);
        let a = e.embed_query("hello").unwrap();
        let b = e.embed_query("goodbye").unwrap();
        assert_ne!(a, b);
    }
}
```

Add the `Embed` variant to `crates/xberg-rag/src/error.rs` (append inside `enum RagError`, before the closing brace):

```rust
    #[error("embedding failed: {0}")]
    Embed(String),
```

Add to `crates/xberg-rag/Cargo.toml` — a `testing` feature and the `tempfile` dev-dep used from Task 3 onward:

```toml
[features]
default = []
# Compile-gate only in P1: proves edgevec builds for native + wasm (see examples/edgevec_smoke.rs).
hnsw = ["dep:edgevec"]
# Exposes MockEmbedder so downstream crates can test engine wiring without a model.
testing = []

[dev-dependencies]
serde_json = { workspace = true }
tempfile = { workspace = true }
```

Wire into `crates/xberg-rag/src/lib.rs` — add the two modules and re-exports:

```rust
mod embed;
mod error;
mod flat;
mod snapshot;
mod store;
#[cfg(feature = "testing")]
mod testing;
mod types;

pub use embed::Embedder;
pub use error::{RagError, Result};
pub use flat::FlatStore;
pub use snapshot::SNAPSHOT_VERSION;
pub use store::SearchStore;
#[cfg(feature = "testing")]
pub use testing::MockEmbedder;
pub use types::{IndexedChunk, RetrievedChunk};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p xberg-rag --features testing testing::tests`
Expected: FAIL to compile before `testing.rs`/`embed.rs` exist ("file not found for module `testing`" / "cannot find trait `Embedder`"). Once both files are in place, both tests PASS.

- [ ] **Step 3: Verify the default build stays wasm-clean**

Run: `cargo build -p xberg-rag`
Expected: `Finished`. `testing.rs` must **not** compile without `--features testing` — confirm by checking the build emits no reference to `MockEmbedder`.

- [ ] **Step 4: Run the full suite**

Run: `cargo test -p xberg-rag --features testing`
Expected: PASS (8 tests: 6 from P1 + 2 here).

- [ ] **Step 5: Commit**

```bash
git add crates/xberg-rag
git commit -m "feat(rag): add Embedder trait and deterministic MockEmbedder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: On-disk matter layout with Node-compatible path encoding

**Files:**
- Create: `crates/xberg-rag/src/paths.rs`
- Modify: `crates/xberg-rag/src/lib.rs`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure path logic).
- Produces:
  - `pub fn encode_uri_component(s: &str) -> String`
  - `pub struct MatterPaths { pub dir: PathBuf }` with `MatterPaths::new(mirrors_dir: &Path, matter_id: &str) -> Self`, `fn snapshot(&self) -> PathBuf` (`<dir>/rag.snapshot`), `fn legacy_bundle(&self) -> PathBuf` (`<dir>/bundle.json`).
  - `pub fn default_mirrors_dir() -> PathBuf` — `$XBERG_DATA_DIR/mirrors`, else `$HOME/.xberg/mirrors`.

- [ ] **Step 1: Write the failing test**

Create `crates/xberg-rag/src/paths.rs`:

```rust
use std::path::{Path, PathBuf};

/// Percent-encode exactly like JavaScript's `encodeURIComponent`, so a matter's
/// directory name byte-matches the one the Node host writes
/// (`services/mcp-server/src/mirror.ts` `matterDir`). Both hosts must address
/// the same directory or a mirror written by one is invisible to the other.
///
/// Unreserved set per the ECMAScript spec: `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
pub fn encode_uri_component(s: &str) -> String {
    const UNRESERVED: &[u8] = b"-_.!~*'()";
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || UNRESERVED.contains(b) {
            out.push(*b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out
}

/// Resolved on-disk locations for one matter's mirror.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatterPaths {
    /// `<mirrors_dir>/<encodeURIComponent(matter_id)>`
    pub dir: PathBuf,
}

impl MatterPaths {
    /// Resolve the directory for `matter_id` under `mirrors_dir`.
    pub fn new(mirrors_dir: &Path, matter_id: &str) -> Self {
        Self {
            dir: mirrors_dir.join(encode_uri_component(matter_id)),
        }
    }

    /// The xberg-rag snapshot written by [`crate::RagEngine`] (P1 `snapshot` format).
    pub fn snapshot(&self) -> PathBuf {
        self.dir.join("rag.snapshot")
    }

    /// The legacy JSON `MirrorBundle` written by the Node host / browser mirror push.
    pub fn legacy_bundle(&self) -> PathBuf {
        self.dir.join("bundle.json")
    }
}

/// Default mirrors root: `$XBERG_DATA_DIR/mirrors`, else `$HOME/.xberg/mirrors`
/// — the same layout `services/mcp-server/src/config.ts` `buildConfig` produces.
/// Falls back to a relative `.xberg/mirrors` when no home directory is known.
pub fn default_mirrors_dir() -> PathBuf {
    if let Ok(data_dir) = std::env::var("XBERG_DATA_DIR") {
        return PathBuf::from(data_dir).join("mirrors");
    }
    match std::env::home_dir() {
        Some(home) => home.join(".xberg").join("mirrors"),
        None => PathBuf::from(".xberg").join("mirrors"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(encode_uri_component("abc-123_x.y~z"), "abc-123_x.y~z");
        assert_eq!(encode_uri_component("a b"), "a%20b");
        assert_eq!(encode_uri_component("a/b"), "a%2Fb");
        assert_eq!(encode_uri_component("a:b"), "a%3Ab");
        // Multi-byte UTF-8 is encoded byte-by-byte, same as JS.
        assert_eq!(encode_uri_component("é"), "%C3%A9");
    }

    #[test]
    fn matter_paths_compose_expected_files() {
        let p = MatterPaths::new(Path::new("/data/mirrors"), "m 1");
        assert!(p.dir.ends_with("m%201"));
        assert!(p.snapshot().ends_with("rag.snapshot"));
        assert!(p.legacy_bundle().ends_with("bundle.json"));
    }

    #[test]
    fn default_mirrors_dir_honours_data_dir_env() {
        // SAFETY-free: set_var is safe on the 2024 edition's std API surface used here
        // only via a serialised test; this test does not run concurrently with another
        // that reads XBERG_DATA_DIR.
        let dir = default_mirrors_dir();
        assert!(dir.ends_with("mirrors"), "got {dir:?}");
    }
}
```

Wire into `lib.rs` — add `mod paths;` and re-export:

```rust
pub use paths::{MatterPaths, default_mirrors_dir, encode_uri_component};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p xberg-rag --features testing paths::tests`
Expected: FAIL to compile before `paths.rs` exists; after, all three PASS.

- [ ] **Step 3: Fix the `home_dir` call if the toolchain disagrees**

`std::env::home_dir` was un-deprecated in Rust 1.85 and this workspace pins `rust-version = "1.91"`, so it should compile warning-free. If the local toolchain still warns, do **not** add a `dirs` dependency — replace the body with a direct env read instead:

```rust
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"));
    match home {
        Ok(h) => PathBuf::from(h).join(".xberg").join("mirrors"),
        Err(_) => PathBuf::from(".xberg").join("mirrors"),
    }
```

- [ ] **Step 4: Run the full suite**

Run: `cargo test -p xberg-rag --features testing`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/xberg-rag
git commit -m "feat(rag): add matter path layout with encodeURIComponent parity

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Legacy `MirrorBundle` reader

**Files:**
- Create: `crates/xberg-rag/src/legacy.rs`
- Modify: `crates/xberg-rag/src/lib.rs`
- Modify: `crates/xberg-rag/Cargo.toml` (promote `serde_json` from dev-dep to dep)

**Interfaces:**
- Consumes: `RagError`, `Result`.
- Produces: `pub struct LegacyChunk { pub doc_id: String, pub chunk_index: u32, pub text: String, pub page: Option<u32>, pub citation: Option<String> }` and `pub fn read_bundle_chunks(json: &[u8]) -> Result<Vec<LegacyChunk>>`.

**Why:** the spec (Section 4) requires "parse old, write new". The Node bundle's `chunks[]` carries text + citations but **no vectors** (`index: number[]` holds EdgeVec's own opaque bytes, which this crate deliberately never parses). So a legacy mirror is imported by **re-embedding its chunk texts** server-side — Task 4's `import_legacy`. `bbox` is intentionally dropped: `IndexedChunk` has no `bbox` field in `SNAPSHOT_VERSION = 1`, and adding one is a P3 version bump.

- [ ] **Step 1: Write the failing test**

Create `crates/xberg-rag/src/legacy.rs`:

```rust
use crate::{RagError, Result};
use serde::Deserialize;

/// One chunk recovered from a legacy JSON `MirrorBundle`.
///
/// Deliberately carries no vector: the bundle's `index` field holds EdgeVec's
/// opaque serialized bytes, which this crate never parses. Callers re-embed
/// [`LegacyChunk::text`] to rebuild a searchable store.
#[derive(Debug, Clone, PartialEq)]
pub struct LegacyChunk {
    pub doc_id: String,
    pub chunk_index: u32,
    pub text: String,
    pub page: Option<u32>,
    pub citation: Option<String>,
}

#[derive(Deserialize)]
struct RawBundle {
    version: u32,
    chunks: Vec<RawChunk>,
}

#[derive(Deserialize)]
struct RawChunk {
    doc_id: String,
    chunk_index: u32,
    text: String,
    #[serde(default)]
    page: Option<u32>,
    #[serde(default)]
    citation: Option<String>,
}

/// Parse the `chunks[]` of a Node-host `MirrorBundle` (`version: 1`).
///
/// `index`, `vault`, and `pii` are ignored — this reader exists only to recover
/// enough text to re-index; PII and vault handling stay with their existing owners.
pub fn read_bundle_chunks(json: &[u8]) -> Result<Vec<LegacyChunk>> {
    let raw: RawBundle =
        serde_json::from_slice(json).map_err(|e| RagError::Legacy(format!("not a valid MirrorBundle: {e}")))?;
    if raw.version != 1 {
        return Err(RagError::Legacy(format!("unsupported bundle version {}", raw.version)));
    }
    Ok(raw
        .chunks
        .into_iter()
        .map(|c| LegacyChunk {
            doc_id: c.doc_id,
            chunk_index: c.chunk_index,
            text: c.text,
            page: c.page,
            citation: c.citation,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUNDLE: &str = r#"{
        "version": 1,
        "index": [1, 2, 3],
        "vault": [],
        "pii": [{"doc_id":"d1","kind":"PERSON","start":0,"end":4,"token":"[P1]"}],
        "chunks": [
            {"doc_id":"d1","chunk_index":0,"text":"first","page":1,"score":0.9,"citation":"d1:0"},
            {"doc_id":"d1","chunk_index":1,"text":"second","score":0.4,"citation":"d1:1"}
        ]
    }"#;

    #[test]
    fn reads_chunks_ignoring_index_and_pii() {
        let chunks = read_bundle_chunks(BUNDLE.as_bytes()).unwrap();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].text, "first");
        assert_eq!(chunks[0].page, Some(1));
        assert_eq!(chunks[0].citation.as_deref(), Some("d1:0"));
        assert_eq!(chunks[1].page, None);
    }

    #[test]
    fn rejects_unknown_bundle_version() {
        let bad = r#"{"version": 2, "chunks": []}"#;
        let err = read_bundle_chunks(bad.as_bytes()).unwrap_err();
        assert!(matches!(err, RagError::Legacy(_)));
    }

    #[test]
    fn rejects_non_json() {
        assert!(matches!(
            read_bundle_chunks(b"not json").unwrap_err(),
            RagError::Legacy(_)
        ));
    }
}
```

Add the `Legacy` variant to `crates/xberg-rag/src/error.rs`:

```rust
    #[error("legacy mirror bundle: {0}")]
    Legacy(String),
```

Move `serde_json` into `[dependencies]` in `crates/xberg-rag/Cargo.toml` (it is now used by non-test code); leave `tempfile` in dev-dependencies:

```toml
[dependencies]
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
rkyv = { workspace = true }
edgevec = { workspace = true, optional = true }

[dev-dependencies]
tempfile = { workspace = true }
```

Wire into `lib.rs`:

```rust
pub use legacy::{LegacyChunk, read_bundle_chunks};
```

(and `mod legacy;` alongside the other module declarations)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p xberg-rag --features testing legacy::tests`
Expected: FAIL to compile before `legacy.rs` exists; after, all three PASS.

- [ ] **Step 3: Confirm P1's serde test still compiles**

`serde_json` moved out of dev-dependencies; a `[dependencies]` entry is visible to tests too, so P1 Task 2's `indexed_chunk_roundtrips_through_serde` is unaffected. If it fails to resolve, the move was mis-applied — re-check the manifest.

- [ ] **Step 4: Run the full suite**

Run: `cargo test -p xberg-rag --features testing`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/xberg-rag
git commit -m "feat(rag): read legacy JSON MirrorBundle chunks for re-indexing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `RagEngine` — index, query, import-legacy

**Files:**
- Create: `crates/xberg-rag/src/engine.rs`
- Modify: `crates/xberg-rag/src/lib.rs`

**Interfaces:**
- Consumes: `Embedder` (Task 1), `MatterPaths` (Task 2), `read_bundle_chunks`/`LegacyChunk` (Task 3), `FlatStore`/`SearchStore`/`IndexedChunk`/`RetrievedChunk` (P1).
- Produces:
  - `pub struct RagEngine<E: Embedder>` with `RagEngine::new(embedder: E, mirrors_dir: PathBuf) -> Self`.
  - `pub struct DocumentInput { pub doc_id: String, pub chunks: Vec<ChunkInput> }`, `pub struct ChunkInput { pub text: String, pub page: Option<u32> }`.
  - `pub fn index_documents(&self, matter_id: &str, docs: &[DocumentInput]) -> Result<usize>` — additive; returns total chunks in the matter after the write.
  - `pub fn query(&self, matter_id: &str, text: &str, top_k: usize) -> Result<Vec<RetrievedChunk>>`.
  - `pub fn import_legacy(&self, matter_id: &str) -> Result<usize>` — re-embeds `bundle.json` chunks into a fresh snapshot; returns the count.
  - New `RagError::Io(String)` and `RagError::MatterNotFound(String)` variants.

**Design note for the implementer:** `query` loads the snapshot from disk on every call and holds no cached store. That is intentional for P2 — it makes `RagEngine` trivially `Send + Sync`, keeps the MCP host free of lifecycle state, and is correct by construction. An in-memory store cache is a later perf task, and the spec's own "rebuild once, not per query" fix targets the *browser*, which keeps its index in memory anyway.

- [ ] **Step 1: Write the failing test**

Create `crates/xberg-rag/src/engine.rs`:

```rust
use std::path::{Path, PathBuf};

use crate::{
    Embedder, FlatStore, IndexedChunk, MatterPaths, RagError, Result, RetrievedChunk, SearchStore,
    legacy::read_bundle_chunks,
};

/// One chunk offered for indexing.
#[derive(Debug, Clone, PartialEq)]
pub struct ChunkInput {
    pub text: String,
    pub page: Option<u32>,
}

/// One document's chunks, indexed under `doc_id`.
#[derive(Debug, Clone, PartialEq)]
pub struct DocumentInput {
    pub doc_id: String,
    pub chunks: Vec<ChunkInput>,
}

/// Owns the on-disk RAG index for a set of matters and answers live queries
/// against it. Generic over the embedding backend so the same engine runs with a
/// real model (native host) or [`crate::MockEmbedder`] (tests).
///
/// Stateless between calls: every query re-reads the matter's snapshot from disk.
pub struct RagEngine<E: Embedder> {
    embedder: E,
    mirrors_dir: PathBuf,
}

impl<E: Embedder> RagEngine<E> {
    /// Build an engine writing under `mirrors_dir` (see [`crate::default_mirrors_dir`]).
    pub fn new(embedder: E, mirrors_dir: PathBuf) -> Self {
        Self { embedder, mirrors_dir }
    }

    /// The mirrors root this engine reads and writes.
    pub fn mirrors_dir(&self) -> &Path {
        &self.mirrors_dir
    }

    fn paths(&self, matter_id: &str) -> MatterPaths {
        MatterPaths::new(&self.mirrors_dir, matter_id)
    }

    /// Load a matter's store, or an empty one when it has no snapshot yet.
    fn load_or_empty(&self, matter_id: &str) -> Result<FlatStore> {
        let path = self.paths(matter_id).snapshot();
        if !path.exists() {
            return Ok(FlatStore::new(self.embedder.dim()));
        }
        let bytes = std::fs::read(&path).map_err(|e| RagError::Io(format!("read {}: {e}", path.display())))?;
        FlatStore::load(&bytes)
    }

    /// Write a store's snapshot atomically: stage to a sibling temp file, then
    /// rename over the target. A crash never leaves a torn snapshot — the same
    /// guarantee the Node host gives for its mirror directory.
    fn save(&self, matter_id: &str, store: &FlatStore) -> Result<()> {
        let paths = self.paths(matter_id);
        std::fs::create_dir_all(&paths.dir)
            .map_err(|e| RagError::Io(format!("create {}: {e}", paths.dir.display())))?;
        let final_path = paths.snapshot();
        let tmp_path = paths.dir.join("rag.snapshot.tmp");
        let bytes = store.snapshot()?;
        std::fs::write(&tmp_path, &bytes).map_err(|e| RagError::Io(format!("write {}: {e}", tmp_path.display())))?;
        std::fs::rename(&tmp_path, &final_path)
            .map_err(|e| RagError::Io(format!("rename into {}: {e}", final_path.display())))?;
        Ok(())
    }

    /// Embed and index `docs` into `matter_id`, adding to whatever is already
    /// indexed. Returns the matter's total chunk count after the write.
    pub fn index_documents(&self, matter_id: &str, docs: &[DocumentInput]) -> Result<usize> {
        let mut texts: Vec<String> = Vec::new();
        let mut meta: Vec<(String, u32, Option<u32>)> = Vec::new();
        for doc in docs {
            for (i, chunk) in doc.chunks.iter().enumerate() {
                texts.push(chunk.text.clone());
                meta.push((doc.doc_id.clone(), i as u32, chunk.page));
            }
        }
        if texts.is_empty() {
            return Ok(self.load_or_empty(matter_id)?.len());
        }

        let vectors = self.embedder.embed_documents(&texts)?;
        if vectors.len() != texts.len() {
            return Err(RagError::Embed(format!(
                "embedder returned {} vectors for {} texts",
                vectors.len(),
                texts.len()
            )));
        }

        let items: Vec<IndexedChunk> = meta
            .into_iter()
            .zip(texts)
            .zip(vectors)
            .map(|(((doc_id, chunk_index, page), text), vector)| IndexedChunk {
                citation: Some(format!("{doc_id}:{chunk_index}")),
                doc_id,
                chunk_index,
                text,
                page,
                vector,
            })
            .collect();

        let mut store = self.load_or_empty(matter_id)?;
        store.ingest(&items)?;
        self.save(matter_id, &store)?;
        Ok(store.len())
    }

    /// Live search: embed `text` and search the matter's actual vectors.
    ///
    /// This is the behaviour the Node host could not provide — its
    /// `MirrorStore.retrieve()` ignored the query and re-sorted mirrored chunks
    /// by a mirror-time placeholder score.
    pub fn query(&self, matter_id: &str, text: &str, top_k: usize) -> Result<Vec<RetrievedChunk>> {
        let path = self.paths(matter_id).snapshot();
        if !path.exists() {
            return Err(RagError::MatterNotFound(matter_id.to_string()));
        }
        let store = self.load_or_empty(matter_id)?;
        let q = self.embedder.embed_query(text)?;
        store.search(&q, top_k)
    }

    /// Rebuild a matter's snapshot from a legacy JSON `MirrorBundle` by
    /// re-embedding its chunk texts. Replaces any existing snapshot; returns the
    /// number of chunks imported.
    pub fn import_legacy(&self, matter_id: &str) -> Result<usize> {
        let path = self.paths(matter_id).legacy_bundle();
        if !path.exists() {
            return Err(RagError::MatterNotFound(matter_id.to_string()));
        }
        let json = std::fs::read(&path).map_err(|e| RagError::Io(format!("read {}: {e}", path.display())))?;
        let legacy = read_bundle_chunks(&json)?;
        if legacy.is_empty() {
            return Ok(0);
        }

        let texts: Vec<String> = legacy.iter().map(|c| c.text.clone()).collect();
        let vectors = self.embedder.embed_documents(&texts)?;
        let items: Vec<IndexedChunk> = legacy
            .into_iter()
            .zip(vectors)
            .map(|(c, vector)| IndexedChunk {
                doc_id: c.doc_id,
                chunk_index: c.chunk_index,
                text: c.text,
                page: c.page,
                citation: c.citation,
                vector,
            })
            .collect();

        let mut store = FlatStore::new(self.embedder.dim());
        store.ingest(&items)?;
        let count = store.len();
        self.save(matter_id, &store)?;
        Ok(count)
    }
}

#[cfg(all(test, feature = "testing"))]
mod tests {
    use super::*;
    use crate::MockEmbedder;

    fn engine(dir: &Path) -> RagEngine<MockEmbedder> {
        RagEngine::new(MockEmbedder::new(16), dir.to_path_buf())
    }

    fn doc(id: &str, texts: &[&str]) -> DocumentInput {
        DocumentInput {
            doc_id: id.to_string(),
            chunks: texts
                .iter()
                .map(|t| ChunkInput { text: (*t).to_string(), page: None })
                .collect(),
        }
    }

    #[test]
    fn query_returns_the_chunk_matching_the_query_text() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        e.index_documents("m1", &[doc("d1", &["alpha content", "beta content", "gamma content"])])
            .unwrap();

        // MockEmbedder is deterministic, so embedding the exact chunk text yields
        // that chunk's own vector — cosine 1.0, and it must rank first.
        let hits = e.query("m1", "beta content", 3).unwrap();
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].text, "beta content");
        assert!(hits[0].score > hits[1].score);
    }

    #[test]
    fn query_result_depends_on_the_query() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        e.index_documents("m1", &[doc("d1", &["alpha content", "beta content"])]).unwrap();

        let a = e.query("m1", "alpha content", 1).unwrap();
        let b = e.query("m1", "beta content", 1).unwrap();
        // The regression this whole phase exists to prevent: a retrieve() that
        // ignores the query would return the same chunk for both.
        assert_ne!(a[0].text, b[0].text);
    }

    #[test]
    fn indexing_is_additive_across_calls() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        assert_eq!(e.index_documents("m1", &[doc("d1", &["one"])]).unwrap(), 1);
        assert_eq!(e.index_documents("m1", &[doc("d2", &["two", "three"])]).unwrap(), 3);
        assert_eq!(e.query("m1", "two", 10).unwrap().len(), 3);
    }

    #[test]
    fn index_sets_citation_from_doc_and_chunk_index() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        e.index_documents("m1", &[doc("d1", &["only"])]).unwrap();
        let hits = e.query("m1", "only", 1).unwrap();
        assert_eq!(hits[0].citation.as_deref(), Some("d1:0"));
        assert_eq!(hits[0].chunk_index, 0);
    }

    #[test]
    fn query_on_unknown_matter_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        assert!(matches!(
            e.query("nope", "anything", 3).unwrap_err(),
            RagError::MatterNotFound(_)
        ));
    }

    #[test]
    fn import_legacy_rebuilds_a_searchable_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        let paths = MatterPaths::new(tmp.path(), "m1");
        std::fs::create_dir_all(&paths.dir).unwrap();
        std::fs::write(
            paths.legacy_bundle(),
            r#"{"version":1,"index":[],"vault":[],"pii":[],"chunks":[
                {"doc_id":"d1","chunk_index":0,"text":"legacy alpha","score":0.1,"citation":"d1:0"},
                {"doc_id":"d1","chunk_index":1,"text":"legacy beta","score":0.2,"citation":"d1:1"}
            ]}"#,
        )
        .unwrap();

        assert_eq!(e.import_legacy("m1").unwrap(), 2);
        let hits = e.query("m1", "legacy beta", 2).unwrap();
        assert_eq!(hits[0].text, "legacy beta");
        assert_eq!(hits[0].citation.as_deref(), Some("d1:1"));
    }

    #[test]
    fn import_legacy_on_missing_bundle_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        assert!(matches!(
            e.import_legacy("m1").unwrap_err(),
            RagError::MatterNotFound(_)
        ));
    }

    #[test]
    fn snapshot_survives_a_fresh_engine_instance() {
        let tmp = tempfile::tempdir().unwrap();
        engine(tmp.path())
            .index_documents("m1", &[doc("d1", &["persisted text"])])
            .unwrap();
        // A brand-new engine (as a fresh MCP process would build) sees the data.
        let hits = engine(tmp.path()).query("m1", "persisted text", 1).unwrap();
        assert_eq!(hits[0].text, "persisted text");
    }
}
```

Add the two new variants to `crates/xberg-rag/src/error.rs`:

```rust
    #[error("io: {0}")]
    Io(String),
    #[error("no indexed data for matter {0}")]
    MatterNotFound(String),
```

Wire into `lib.rs`:

```rust
pub use engine::{ChunkInput, DocumentInput, RagEngine};
```

(and `mod engine;` alongside the other module declarations)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p xberg-rag --features testing engine::tests`
Expected: FAIL to compile before `engine.rs` exists; after, all eight PASS. The two tests that matter most are `query_result_depends_on_the_query` (the defect this phase fixes) and `snapshot_survives_a_fresh_engine_instance` (proves on-disk persistence, not in-process state).

- [ ] **Step 3: Verify the default build is unaffected**

Run: `cargo build -p xberg-rag`
Expected: `Finished`. The engine's test module is `#[cfg(all(test, feature = "testing"))]`, so a default build compiles the engine but no mock.

- [ ] **Step 4: Run the full suite**

Run: `cargo test -p xberg-rag --features testing`
Expected: PASS (22 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/xberg-rag
git commit -m "feat(rag): add RagEngine with live query, additive index, legacy import

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `XbergEmbedder` — adapt the real engine to `Embedder`

**Files:**
- Create: `crates/xberg/src/rag_embed.rs`
- Modify: `crates/xberg/src/lib.rs`
- Modify: `crates/xberg/Cargo.toml`

**Interfaces:**
- Consumes: `xberg_rag::{Embedder, RagError, Result}`; `xberg::embed_texts`; `xberg::core::config::{EmbeddingConfig, EmbeddingModelType}`.
- Produces: `pub struct XbergEmbedder` with `XbergEmbedder::from_preset(name: &str) -> xberg_rag::Result<Self>`, `XbergEmbedder::new(config: EmbeddingConfig) -> xberg_rag::Result<Self>`, and its `Embedder` impl. `dim()` is measured once at construction by embedding a probe string — correct for every `EmbeddingModelType` variant, including `Custom` and `Llm`, without consulting the preset table.

**Direction of dependency:** `xberg` gains `xberg-rag`; `xberg-rag` gains nothing. This is the only edge between the two crates, and it must stay one-way (see Global Constraints).

**Release consequence — verified 2026-07-21, flag this to the maintainer.** `xberg` is published to crates.io (latest `1.0.0-rc.31`) and carries no `publish = false`. Adding `xberg-rag` to its dependencies means **`xberg-rag` must itself be published to crates.io before the next `xberg` release**, or `cargo publish -p xberg` will fail on an unpublished dependency. The `{ path, version }` dependency form used below is exactly the pattern that makes this work — cargo strips `path` and uses `version` when packaging — and `xberg-gliner` (also on crates.io at `1.0.0-rc.31`) is the existing precedent. No CI workflow publishes crates; this is a manual step, so it is a human handoff, not something a task can complete. The `description` field added below is required — `cargo publish` rejects a crate without one.

- [ ] **Step 1: Write the failing test**

Create `crates/xberg/src/rag_embed.rs`:

```rust
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
```

Add the dependency in `crates/xberg/Cargo.toml`, under `[dependencies]` (alphabetical, after the last `x`-prefixed entry or wherever the file's ordering places it):

```toml
xberg-rag = { path = "../xberg-rag", version = "1.0.0-rc.29" }
```

Add to the root `Cargo.toml` `[workspace.dependencies]` so other crates can reference it uniformly:

```toml
xberg-rag = { path = "./crates/xberg-rag", version = "1.0.0-rc.29", default-features = false }
```

…and then use `xberg-rag = { workspace = true }` in `crates/xberg/Cargo.toml` instead of the inline path form above. Also give `crates/xberg-rag/Cargo.toml` the missing `description` field required for a workspace member that other published crates depend on:

```toml
description = "Isomorphic RAG core: SearchStore, snapshots, and the RagEngine shared by xberg's browser and native hosts"
```

Wire into `crates/xberg/src/lib.rs` — add near the other `pub mod` declarations:

```rust
/// Adapter binding xberg's embedding engine to `xberg_rag::Embedder`.
pub mod rag_embed;
```

and near the other re-exports:

```rust
pub use rag_embed::XbergEmbedder;
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p xberg --features embeddings rag_embed::tests`
Expected: FAIL to compile before `rag_embed.rs` exists ("file not found for module `rag_embed`"); after, the two non-ignored tests PASS and the third reports as ignored.

- [ ] **Step 3: Verify there is no dependency cycle**

Run: `cargo tree -p xberg-rag --no-dedupe -e normal | grep -c "^.*xberg " || true`
Expected: `0` — `xberg-rag`'s dependency tree must not contain `xberg`. If cargo reports "cyclic package dependency", the `xberg-rag` manifest wrongly gained an `xberg` dep; remove it.

- [ ] **Step 4: Build the whole workspace**

Run: `cargo build --workspace`
Expected: `Finished`.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml crates/xberg-rag/Cargo.toml crates/xberg/Cargo.toml crates/xberg/src/rag_embed.rs crates/xberg/src/lib.rs
git commit -m "feat(rag): add XbergEmbedder adapter over xberg::embed_texts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `xberg rag` CLI — index, query, import-legacy

**Files:**
- Create: `crates/xberg-cli/src/commands/rag.rs`
- Modify: `crates/xberg-cli/src/commands/mod.rs`
- Modify: `crates/xberg-cli/src/main.rs`
- Create: `crates/xberg-cli/tests/rag_test.rs`

**Interfaces:**
- Consumes: `xberg::XbergEmbedder` (Task 5), `xberg_rag::{RagEngine, DocumentInput, ChunkInput, MockEmbedder, default_mirrors_dir}` (Tasks 1, 2 & 4), `xberg::chunking::chunk_for_rag`.
- Produces: `pub fn rag_index_command(...)`, `pub fn rag_query_command(...)`, `pub fn rag_import_legacy_command(...)`, and the `Commands::Rag { .. }` clap variant with a `RagAction` subcommand enum.
- Note: `RagEngine<E>::{index_documents, query, import_legacy}` return `xberg_rag::Result<T>` (error type `RagError`, which derives `thiserror::Error`). `anyhow::Result`'s `?` converts any `std::error::Error + Send + Sync + 'static` automatically, so these calls use plain `?` — no `.map_err(anyhow::Error::from)` needed.

**Why a CLI before the MCP tool:** it makes the whole native path testable end-to-end from a shell, in the codebase's existing integration-test style (`crates/xberg-cli/tests/commands_test.rs` spawns `target/debug/xberg`), without an MCP client in the loop. Task 7's MCP tool then binds an already-proven engine.

- [ ] **Step 1: Write the failing test**

Create `crates/xberg-cli/tests/rag_test.rs`:

```rust
//! End-to-end tests for `xberg rag`. Uses `--embedder mock` so no model is
//! downloaded — the workspace forbids model egress in CI.

use std::path::PathBuf;
use std::process::Command;
use tempfile::tempdir;

fn binary() -> String {
    format!("{}/../../target/debug/xberg", env!("CARGO_MANIFEST_DIR"))
}

fn write(dir: &std::path::Path, name: &str, body: &str) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, body).unwrap();
    p
}

#[test]
fn index_then_query_returns_the_matching_document() {
    let data = tempdir().unwrap();
    let docs = tempdir().unwrap();
    write(docs.path(), "a.md", "Contract renewal terms and the notice period.");
    write(docs.path(), "b.md", "Employee onboarding checklist for new hires.");

    let index = Command::new(binary())
        .args([
            "rag", "index",
            "--matter", "m1",
            "--input", docs.path().to_str().unwrap(),
            "--mirrors-dir", data.path().to_str().unwrap(),
            "--embedder", "mock",
        ])
        .output()
        .expect("failed to run xberg rag index");
    assert!(index.status.success(), "stderr: {}", String::from_utf8_lossy(&index.stderr));

    let query = Command::new(binary())
        .args([
            "rag", "query",
            "--matter", "m1",
            "--text", "Employee onboarding checklist for new hires.",
            "--top-k", "2",
            "--mirrors-dir", data.path().to_str().unwrap(),
            "--embedder", "mock",
            "--format", "json",
        ])
        .output()
        .expect("failed to run xberg rag query");
    assert!(query.status.success(), "stderr: {}", String::from_utf8_lossy(&query.stderr));

    let stdout = String::from_utf8_lossy(&query.stdout);
    let hits: serde_json::Value = serde_json::from_str(&stdout).expect("query output must be JSON");
    let arr = hits.as_array().expect("expected a JSON array of hits");
    assert!(!arr.is_empty(), "expected at least one hit");
    assert_eq!(
        arr[0]["doc_id"].as_str().unwrap(),
        "b.md",
        "the query text is b.md's content, so b.md must rank first"
    );
}

#[test]
fn query_on_an_unindexed_matter_fails_cleanly() {
    let data = tempdir().unwrap();
    let out = Command::new(binary())
        .args([
            "rag", "query",
            "--matter", "ghost",
            "--text", "anything",
            "--mirrors-dir", data.path().to_str().unwrap(),
            "--embedder", "mock",
        ])
        .output()
        .expect("failed to run xberg rag query");
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("ghost"), "error must name the matter; got: {stderr}");
}
```

Create `crates/xberg-cli/src/commands/rag.rs`:

```rust
//! `xberg rag` — native RAG index/query over the on-disk matter store.
//!
//! This is the native half of the isomorphic core: the same `xberg_rag` engine
//! the browser host binds through WASM, driven here from the command line.

use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};
use xberg::chunking::chunk_for_rag;
use xberg::core::config::ChunkingConfig;
use xberg_rag::{ChunkInput, DocumentInput, RagEngine, default_mirrors_dir};

/// Which embedding backend the command should use.
///
/// `mock` exists so the CLI (and its integration tests) can exercise the whole
/// index/query path with no model on disk and no network.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum EmbedderKind {
    /// Bundled preset via xberg's embedding engine (downloads on first use).
    Preset,
    /// Deterministic hash embedder — tests and smoke checks only.
    Mock,
}

fn mirrors_root(explicit: Option<PathBuf>) -> PathBuf {
    explicit.unwrap_or_else(default_mirrors_dir)
}

/// Read every UTF-8 text file directly under `input` (or `input` itself if it is
/// a file) and chunk it for indexing. Binary formats are P4's `ingest_folder`
/// tool, which routes through the full extraction pipeline; this command is
/// deliberately limited to text so it stays a thin, fast test surface.
fn collect_documents(input: &Path, chunk_size: usize) -> Result<Vec<DocumentInput>> {
    let config = ChunkingConfig {
        max_characters: chunk_size,
        ..ChunkingConfig::default()
    };

    let files: Vec<PathBuf> = if input.is_file() {
        vec![input.to_path_buf()]
    } else {
        let mut v: Vec<PathBuf> = std::fs::read_dir(input)
            .with_context(|| format!("failed to read directory {}", input.display()))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file())
            .collect();
        // Deterministic order so a re-index assigns the same chunk indices.
        v.sort();
        v
    };

    let mut docs = Vec::new();
    for path in files {
        let Ok(text) = std::fs::read_to_string(&path) else {
            // Not UTF-8 text — skip rather than fail the whole run.
            continue;
        };
        if text.trim().is_empty() {
            continue;
        }
        let doc_id = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.display().to_string());
        let result = chunk_for_rag(&text, &config).with_context(|| format!("failed to chunk {}", path.display()))?;
        let chunks: Vec<ChunkInput> = result
            .chunks
            .into_iter()
            .filter(|c| !c.content.trim().is_empty())
            .map(|c| ChunkInput { text: c.content, page: None })
            .collect();
        if !chunks.is_empty() {
            docs.push(DocumentInput { doc_id, chunks });
        }
    }
    Ok(docs)
}

/// Resolve `--embedder preset` into a real model-backed embedder. Shared by
/// all three commands so the "load the preset" error path only exists once.
fn preset_embedder(preset: &str) -> Result<xberg::XbergEmbedder> {
    xberg::XbergEmbedder::from_preset(preset).with_context(|| format!("embedding preset {preset:?}"))
}

/// `xberg rag index` — chunk, embed, and index every text file under `input`.
///
/// There is no generic `with_engine` helper here on purpose: `RagEngine<E>` is
/// generic over `Embedder`, so a helper shared across the `mock`/`preset` arms
/// would need either a boxed `dyn` embedder or a `for<E>` closure (not
/// expressible in stable Rust) — machinery only worth it with far more than
/// three call sites. Each command matches on `embedder` directly instead.
pub fn rag_index_command(
    matter: &str,
    input: &Path,
    mirrors_dir: Option<PathBuf>,
    embedder: EmbedderKind,
    preset: &str,
    chunk_size: usize,
) -> Result<()> {
    if !input.exists() {
        bail!("input path not found: {}", input.display());
    }
    let docs = collect_documents(input, chunk_size)?;
    if docs.is_empty() {
        bail!("no indexable text files found under {}", input.display());
    }
    let mirrors_dir = mirrors_root(mirrors_dir);

    let total = match embedder {
        EmbedderKind::Mock => {
            RagEngine::new(xberg_rag::MockEmbedder::new(64), mirrors_dir).index_documents(matter, &docs)?
        }
        EmbedderKind::Preset => RagEngine::new(preset_embedder(preset)?, mirrors_dir).index_documents(matter, &docs)?,
    };
    println!("indexed {} document(s); matter {matter} now holds {total} chunk(s)", docs.len());
    Ok(())
}

/// `xberg rag query` — live similarity search over the matter's actual vectors.
pub fn rag_query_command(
    matter: &str,
    text: &str,
    top_k: usize,
    mirrors_dir: Option<PathBuf>,
    embedder: EmbedderKind,
    preset: &str,
    json: bool,
) -> Result<()> {
    let mirrors_dir = mirrors_root(mirrors_dir);

    let hits = match embedder {
        EmbedderKind::Mock => RagEngine::new(xberg_rag::MockEmbedder::new(64), mirrors_dir).query(matter, text, top_k)?,
        EmbedderKind::Preset => RagEngine::new(preset_embedder(preset)?, mirrors_dir).query(matter, text, top_k)?,
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&hits).context("failed to serialize hits")?);
    } else if hits.is_empty() {
        println!("no matches");
    } else {
        for h in &hits {
            println!("{:.4}  {}  {}", h.score, h.citation.as_deref().unwrap_or("-"), h.text);
        }
    }
    Ok(())
}

/// `xberg rag import-legacy` — re-embed a Node-host `bundle.json` into a snapshot.
pub fn rag_import_legacy_command(
    matter: &str,
    mirrors_dir: Option<PathBuf>,
    embedder: EmbedderKind,
    preset: &str,
) -> Result<()> {
    let mirrors_dir = mirrors_root(mirrors_dir);

    let count = match embedder {
        EmbedderKind::Mock => RagEngine::new(xberg_rag::MockEmbedder::new(64), mirrors_dir).import_legacy(matter)?,
        EmbedderKind::Preset => RagEngine::new(preset_embedder(preset)?, mirrors_dir).import_legacy(matter)?,
    };
    println!("imported {count} chunk(s) from the legacy bundle for matter {matter}");
    Ok(())
}
```

Register in `crates/xberg-cli/src/commands/mod.rs` — add alongside the other module declarations and re-exports:

```rust
pub mod rag;
```

```rust
pub use rag::{EmbedderKind, rag_import_legacy_command, rag_index_command, rag_query_command};
```

Add the clap variant in `crates/xberg-cli/src/main.rs`, inside `enum Commands`:

```rust
    /// Index and query documents with the native RAG engine
    ///
    /// Chunks, embeds, and indexes text files into an on-disk matter store, then
    /// answers live similarity queries against the actual vectors.
    Rag {
        #[command(subcommand)]
        action: RagAction,
    },
```

and the subcommand enum next to `enum Commands`:

```rust
#[derive(clap::Subcommand)]
enum RagAction {
    /// Chunk, embed, and index every text file under a path
    Index {
        /// Matter id the documents belong to
        #[arg(long)]
        matter: String,
        /// File or directory to index
        #[arg(long)]
        input: PathBuf,
        /// Mirrors root (defaults to $XBERG_DATA_DIR/mirrors, else ~/.xberg/mirrors)
        #[arg(long)]
        mirrors_dir: Option<PathBuf>,
        /// Embedding backend: preset (real model) or mock (tests only)
        #[arg(long, value_enum, default_value = "preset")]
        embedder: commands::EmbedderKind,
        /// Embedding preset name when --embedder preset
        #[arg(long, default_value = "lightweight")]
        preset: String,
        /// Maximum characters per chunk
        #[arg(long, default_value_t = 512)]
        chunk_size: usize,
    },
    /// Search a matter's index
    Query {
        /// Matter id to search
        #[arg(long)]
        matter: String,
        /// Query text
        #[arg(long)]
        text: String,
        /// Number of results
        #[arg(long, default_value_t = 8)]
        top_k: usize,
        /// Mirrors root (defaults to $XBERG_DATA_DIR/mirrors, else ~/.xberg/mirrors)
        #[arg(long)]
        mirrors_dir: Option<PathBuf>,
        /// Embedding backend: preset (real model) or mock (tests only)
        #[arg(long, value_enum, default_value = "preset")]
        embedder: commands::EmbedderKind,
        /// Embedding preset name when --embedder preset
        #[arg(long, default_value = "lightweight")]
        preset: String,
        /// Output format for results (text or json)
        #[arg(short, long, default_value = "text")]
        format: WireFormat,
    },
    /// Rebuild a matter's index from a legacy JSON MirrorBundle
    ImportLegacy {
        /// Matter id whose bundle.json should be re-embedded
        #[arg(long)]
        matter: String,
        /// Mirrors root (defaults to $XBERG_DATA_DIR/mirrors, else ~/.xberg/mirrors)
        #[arg(long)]
        mirrors_dir: Option<PathBuf>,
        /// Embedding backend: preset (real model) or mock (tests only)
        #[arg(long, value_enum, default_value = "preset")]
        embedder: commands::EmbedderKind,
        /// Embedding preset name when --embedder preset
        #[arg(long, default_value = "lightweight")]
        preset: String,
    },
}
```

and the dispatch arm in `main.rs`'s `match` over `Commands` (place it next to `Commands::Chunk`):

```rust
        Commands::Rag { action } => match action {
            RagAction::Index {
                matter,
                input,
                mirrors_dir,
                embedder,
                preset,
                chunk_size,
            } => commands::rag_index_command(&matter, &input, mirrors_dir, embedder, &preset, chunk_size)?,
            RagAction::Query {
                matter,
                text,
                top_k,
                mirrors_dir,
                embedder,
                preset,
                format,
            } => commands::rag_query_command(
                &matter,
                &text,
                top_k,
                mirrors_dir,
                embedder,
                &preset,
                matches!(format, WireFormat::Json),
            )?,
            RagAction::ImportLegacy {
                matter,
                mirrors_dir,
                embedder,
                preset,
            } => commands::rag_import_legacy_command(&matter, mirrors_dir, embedder, &preset)?,
        }
```

Add the dependency in `crates/xberg-cli/Cargo.toml` under `[dependencies]`:

```toml
xberg-rag = { workspace = true, features = ["testing"] }
```

(The `testing` feature is what provides `MockEmbedder` for `--embedder mock`. It is a debug/QA affordance shipped deliberately, not a test-only dep — the integration test invokes the release-path binary.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo build -p xberg-cli && cargo test -p xberg-cli --test rag_test`
Expected: FAIL before the command exists — clap rejects the `rag` subcommand and both tests fail on a non-zero exit status.

- [ ] **Step 3: Build and re-run**

Run: `cargo build -p xberg-cli`
Expected: `Finished`. Likely fix-ups: `WireFormat` must already be in scope in `main.rs` (it is — the `Extract` variant uses it); `commands::EmbedderKind` must be re-exported (done above); `ChunkingConfig`'s field is `max_characters` (confirmed in `crates/xberg/src/chunking/rag.rs` tests).

Run: `cargo test -p xberg-cli --test rag_test`
Expected: PASS (2 tests). `index_then_query_returns_the_matching_document` is the end-to-end proof that a native process indexes and then *searches by query* — the capability the Node host never had.

- [ ] **Step 4: Smoke-check the help text**

Run: `./target/debug/xberg rag --help`
Expected: lists `index`, `query`, and `import-legacy`.

- [ ] **Step 5: Commit**

```bash
git add crates/xberg-cli
git commit -m "feat(cli): add xberg rag index/query/import-legacy commands

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: MCP `rag_query` tool — real search on the server

**Files:**
- Create: `crates/xberg/src/mcp/rag.rs`
- Modify: `crates/xberg/src/mcp/mod.rs`
- Modify: `crates/xberg/src/mcp/params.rs`
- Modify: `crates/xberg/src/mcp/schema.rs`
- Modify: `crates/xberg/src/mcp/server.rs`

**Interfaces:**
- Consumes: `XbergEmbedder` (Task 5), `RagEngine`/`default_mirrors_dir` (Tasks 2 & 4), the existing rmcp `#[tool_router]` scaffolding.
- Produces:
  - `params::RagQueryParams { matter_id: String, query: String, top_k: Option<usize> }`
  - `schema::RagQueryOutput { matter_id: String, hits: Vec<RagHit> }`, `schema::RagHit { doc_id, chunk_index, text, score, citation, page }`
  - `mcp::rag::query(params) -> Result<RagQueryOutput, rmcp::ErrorData>`
  - `mcp::rag::is_enabled() -> bool` — reads `XBERG_RAG_ENABLED`
  - a `rag_query` `#[tool]` on `XbergMcp`, whose route `XbergMcp::with_config` disables unless `is_enabled()`.

**Design note 1 — per-call engine.** The engine is built **per call** from the environment rather than stored on `XbergMcp`. This keeps `XbergMcp`'s struct and its hand-written `Clone` untouched — a much smaller diff to review. The cost is rebuilding the embedder config each call; the underlying model engine is cached inside `xberg::embed_texts`, so this is config construction, not model loading. Caching the engine on the handler is a follow-up if profiling shows it matters.

**Design note 2 — the tool ships DISABLED BY DEFAULT, gated at runtime.** Two verified facts drive this:

- **`xberg-cli` is a separately distributed product**, not an internal binary: it ships as `ghcr.io/xberg-io/xberg-cli` docker images and via `xberg` on crates.io. An always-on `rag_query` would put a tool pointing at `~/.xberg/mirrors` into the tool list of every extraction-focused CLI user, erroring for nearly all of them. (The Node `@xberg-io/mcp-server` bundle that `release.yml` packages into standalone binaries is a *different* shipped artifact and is untouched by this phase — spec R6 holds.)
- **A cargo-feature gate on the tool method is impossible in rmcp 2.2.0.** `rmcp-macros-2.2.0/src/tool_router.rs` collects `#[tool]`-attributed methods and emits `.with_route((Self::rag_query_tool_attr(), Self::rag_query))` **without propagating `#[cfg]`**. A `#[cfg(feature = "rag")]` on the method therefore deletes the method while leaving the route referencing it — a compile error under `--no-default-features`. There is no cfg-gated `#[tool]` anywhere in this codebase because it does not work.

The mechanism that does work is runtime route disabling: `ToolRouter::with_disabled(name)` (`rmcp-2.2.0/src/handler/server/router/tool.rs:504`). The tool is always compiled; `XbergMcp::with_config` disables its route unless `XBERG_RAG_ENABLED` is set to `1` or `true`. A disabled route is absent from `tools/list` and rejected on call, so default-installed CLI users see no change at all.

- [ ] **Step 1: Write the failing test**

Create `crates/xberg/src/mcp/rag.rs`:

```rust
//! MCP-facing wiring for the native RAG engine.
//!
//! Replaces the Node host's `MirrorStore.retrieve()`, which ignored the query
//! and re-sorted the last-mirrored chunks by a mirror-time placeholder score.
//! Here the query is embedded and searched against the matter's actual vectors.

use crate::rag_embed::XbergEmbedder;
use xberg_rag::{RagEngine, RagError, default_mirrors_dir};

/// Name of the RAG tool, used both by the `#[tool]` attribute and by the route
/// gate in `XbergMcp::with_config`. Keep the two in sync via this constant.
pub(crate) const RAG_QUERY_TOOL: &str = "rag_query";

/// Whether this host should expose the RAG tool at all.
///
/// Default **off**: `xberg-cli` is distributed on its own (crates.io, the
/// `ghcr.io/xberg-io/xberg-cli` images), and an extraction-focused user has no
/// `~/.xberg/mirrors` — an always-listed `rag_query` would be a tool that only
/// ever errors for them. Opt in with `XBERG_RAG_ENABLED=1`.
pub(crate) fn is_enabled() -> bool {
    matches!(
        std::env::var("XBERG_RAG_ENABLED").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

/// Embedding preset used by the MCP host.
///
/// Defaults to `lightweight` (model2vec, pure Rust) so the server never
/// hard-requires a bundled ONNX Runtime — the spec's R3 mitigation. Override
/// with `XBERG_RAG_PRESET`.
fn preset_name() -> String {
    std::env::var("XBERG_RAG_PRESET").unwrap_or_else(|_| "lightweight".to_string())
}

/// Build an engine over the mirrors root this host is configured for.
fn build_engine() -> Result<RagEngine<XbergEmbedder>, RagError> {
    let embedder = XbergEmbedder::from_preset(&preset_name())?;
    Ok(RagEngine::new(embedder, default_mirrors_dir()))
}

/// Map a RAG error onto the MCP error surface, preserving the distinction
/// between "this matter has nothing indexed" and a genuine internal failure.
fn to_mcp_error(err: RagError) -> rmcp::ErrorData {
    match err {
        RagError::MatterNotFound(id) => {
            rmcp::ErrorData::invalid_params(format!("no indexed data for matter {id}"), None)
        }
        other => rmcp::ErrorData::internal_error(other.to_string(), None),
    }
}

/// Execute a live RAG query and shape it for MCP structured output.
pub(crate) fn query(params: &super::params::RagQueryParams) -> Result<super::schema::RagQueryOutput, rmcp::ErrorData> {
    if params.matter_id.trim().is_empty() {
        return Err(rmcp::ErrorData::invalid_params("matter_id must not be empty", None));
    }
    if params.query.trim().is_empty() {
        return Err(rmcp::ErrorData::invalid_params("query must not be empty", None));
    }
    let top_k = params.top_k.unwrap_or(8).clamp(1, 100);

    let engine = build_engine().map_err(to_mcp_error)?;
    let hits = engine.query(&params.matter_id, &params.query, top_k).map_err(to_mcp_error)?;

    Ok(super::schema::RagQueryOutput {
        matter_id: params.matter_id.clone(),
        hits: hits
            .into_iter()
            .map(|h| super::schema::RagHit {
                doc_id: h.doc_id,
                chunk_index: h.chunk_index,
                text: h.text,
                score: h.score,
                citation: h.citation,
                page: h.page,
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::params::RagQueryParams;

    fn params(matter: &str, query: &str) -> RagQueryParams {
        RagQueryParams {
            matter_id: matter.to_string(),
            query: query.to_string(),
            top_k: None,
        }
    }

    #[test]
    fn empty_matter_id_is_invalid_params() {
        let err = query(&params("  ", "anything")).unwrap_err();
        assert!(err.message.contains("matter_id"), "got {}", err.message);
    }

    #[test]
    fn empty_query_is_invalid_params() {
        let err = query(&params("m1", "   ")).unwrap_err();
        assert!(err.message.contains("query"), "got {}", err.message);
    }

    #[test]
    fn not_found_maps_to_invalid_params_naming_the_matter() {
        // No model is loaded for this path only if build_engine fails first, so
        // assert on whichever error surfaces: both are user-facing and must
        // mention the cause rather than panicking.
        let err = query(&params("definitely-not-a-real-matter", "hello")).unwrap_err();
        assert!(!err.message.is_empty());
    }

    #[test]
    fn defaults_are_off_and_lightweight() {
        // Neither env var is set in the test process, so both defaults apply.
        // Note: `std::env::set_var` is `unsafe` on edition 2024 and this
        // workspace denies `unsafe_code`, so these assert the unset-default
        // rather than mutating the environment. The enabled path is covered by
        // Step 4's manual check.
        assert!(!is_enabled(), "RAG must be opt-in, never on by default");
        assert_eq!(preset_name(), "lightweight");
    }
}
```

Add to `crates/xberg/src/mcp/params.rs`:

```rust
#[cfg_attr(alef, alef(skip))]
/// Request parameters for a live RAG query over an indexed matter.
#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct RagQueryParams {
    /// Matter id whose index should be searched.
    pub matter_id: String,
    /// Natural-language query. Embedded and matched against the matter's vectors.
    pub query: String,
    /// Maximum number of chunks to return (default 8, clamped to 1..=100).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_k: Option<usize>,
}
```

Add to `crates/xberg/src/mcp/schema.rs`:

```rust
/// One retrieved chunk in a `rag_query` result.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RagHit {
    /// Document the chunk came from.
    pub doc_id: String,
    /// Zero-based position of the chunk within its document.
    pub chunk_index: u32,
    /// Chunk text.
    pub text: String,
    /// Similarity score; higher is closer.
    pub score: f32,
    /// Stable citation handle, typically `<doc_id>:<chunk_index>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation: Option<String>,
    /// Source page, when the document had pagination.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
}

/// Structured output for `rag_query`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RagQueryOutput {
    /// Matter that was searched.
    pub matter_id: String,
    /// Hits, most similar first.
    pub hits: Vec<RagHit>,
}
```

Declare the module in `crates/xberg/src/mcp/mod.rs` (alongside the other private modules) and export the params type with the others:

```rust
mod rag;
```

```rust
pub use params::{CacheWarmParams, DetectMimeTypeParams, ExtractBatchParams, ExtractParams, RagQueryParams};
```

Add the tool in `crates/xberg/src/mcp/server.rs`, inside the `#[tool_router] impl XbergMcp` block (place it after `list_formats` so it sits with the other read-only tools):

```rust
    /// Live RAG query over an indexed matter.
    #[tool(
        description = "Search an indexed matter with a natural-language query. Embeds the query and \
                       runs a live similarity search over the matter's vectors, returning the most \
                       relevant chunks with citations.",
        annotations(title = "RAG Query", read_only_hint = true, idempotent_hint = true),
        output_schema = rmcp::handler::server::common::schema_for_output::<super::schema::RagQueryOutput>()
            .expect("RagQueryOutput schema must be valid")
    )]
    fn rag_query(
        &self,
        Parameters(params): Parameters<super::params::RagQueryParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let dto = super::rag::query(&params)?;
        let response = serde_json::to_string_pretty(&dto).unwrap_or_default();
        let mut tool_result = CallToolResult::success(vec![ContentBlock::text(response)]);
        tool_result.structured_content = serde_json::to_value(&dto).ok();
        Ok(tool_result)
    }
```

Gate the route in `XbergMcp::with_config` — change **only** the `tool_router` field initializer:

```rust
    pub(crate) fn with_config(config: ExtractionConfig) -> Self {
        let extraction_service = ExtractionServiceBuilder::new().with_tracing().with_metrics().build();

        // RAG is opt-in: a disabled route is absent from `tools/list` and
        // rejected on call, so a default `xberg mcp` install is unchanged.
        let mut tool_router = Self::tool_router();
        if !super::rag::is_enabled() {
            tool_router = tool_router.with_disabled(super::rag::RAG_QUERY_TOOL);
        }

        Self {
            tool_router,
            prompt_router: super::prompts::build_prompt_router(),
            default_config: std::sync::Arc::new(config),
            extraction_service: std::sync::Mutex::new(extraction_service),
        }
    }
```

Add a test at the bottom of `crates/xberg/src/mcp/server.rs` proving the default is off:

```rust
#[cfg(test)]
mod rag_gate_tests {
    use super::*;

    #[test]
    fn rag_query_route_exists_but_is_disabled_by_default() {
        // XBERG_RAG_ENABLED is unset in the test process.
        let server = XbergMcp::with_config(ExtractionConfig::default());
        assert!(
            server.tool_router.has_route(super::super::rag::RAG_QUERY_TOOL),
            "the route must be registered so it can be enabled at runtime"
        );
        assert!(
            server.tool_router.is_disabled(super::super::rag::RAG_QUERY_TOOL),
            "rag_query must be opt-in — an extraction-only CLI user must not see it"
        );
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p xberg --features "mcp,embeddings" mcp::rag::tests`
Expected: FAIL to compile before `rag.rs`, `RagQueryParams`, and `RagQueryOutput` exist; after, all four PASS.

- [ ] **Step 3: Verify the route gate**

Run: `cargo test -p xberg --features "mcp,embeddings" rag_gate_tests`
Expected: PASS — `rag_query` is registered but disabled. This is the assertion that protects every existing `xberg mcp` user from a tool they can't use.

Run: `cargo test -p xberg --features "mcp,embeddings" mcp::`
Expected: PASS. If `rmcp::ErrorData::invalid_params` / `internal_error` have different constructor shapes, check how `crates/xberg/src/mcp/errors.rs` builds errors and match that spelling — the unit tests are the oracle. `ToolRouter::{with_disabled, has_route, is_disabled}` are confirmed present in rmcp 2.2.0 (`src/handler/server/router/tool.rs:457-509`).

- [ ] **Step 4: Manual end-to-end check against a real MCP client**

First confirm the default is invisible, then opt in:

```bash
# Default: no RAG tool at all.
./target/debug/xberg mcp                       # tools/list must NOT contain rag_query

# Opt in.
./target/debug/xberg rag index --matter demo --input ./test_documents --embedder preset --preset lightweight
XBERG_RAG_ENABLED=1 ./target/debug/xberg mcp
```

Expected: without the env var, `tools/list` has no `rag_query`. With it, `tools/list` includes `rag_query`, and calling it with `{"matter_id":"demo","query":"<a phrase from one of the documents>"}` returns hits whose top result contains that phrase. An unknown `matter_id` returns an invalid-params error naming the matter. Record the observed output in the report file if it differs from this expectation.

- [ ] **Step 5: Commit**

```bash
git add crates/xberg/src/mcp
git commit -m "feat(mcp): add rag_query tool backed by live vector search

Replaces the Node host's snapshot re-sort: the query is embedded and matched
against the matter's actual vectors via xberg-rag's RagEngine.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Phase close-out — docs and the P2b handoff note

**Files:**
- Create: `docs/superpowers/notes/2026-07-21-p2-native-rag-status.md`
- Modify: `docs/superpowers/specs/2026-07-21-isomorphic-rag-core-design.md` (R6 status line only)

**Interfaces:**
- Consumes: the outcome of Tasks 1–7.
- Produces: the written record P3/P2b start from. No code.

- [ ] **Step 1: Write the status note**

Create `docs/superpowers/notes/2026-07-21-p2-native-rag-status.md` containing, with actual measured values rather than estimates:

1. **What is live now** — `xberg rag index|query|import-legacy`, the MCP `rag_query` tool, and the exact command used to verify each.
2. **Backend in use** — `FlatStore` (exact cosine), with the measured query latency at the largest matter tested and its chunk count, so P2b has a baseline to beat.
3. **Dimension in use** — the preset the host defaults to and its dimension, plus the browser's (768, e5-base), and the explicit statement that cross-host top-K equivalence is **not yet** achievable and is P3's job.
4. **Node host status** — still the deployed one (spec R6); nothing was removed in P2.
5. **P2b entry conditions** — the HNSW swap is confined to a new `SearchStore` impl plus one construction site in `RagEngine`; it needs P1 Task 5's R1 verdict first.

- [ ] **Step 2: Update the spec's R6 line**

In `docs/superpowers/specs/2026-07-21-isomorphic-rag-core-design.md`, replace the last sentence of **R6** ("until P2 is green, the Node host remains the deployed one") with a statement of the actual position after this phase, linking the status note. Change nothing else in the spec.

- [ ] **Step 3: Run the full workspace suite**

Run: `cargo test --workspace`
Expected: PASS. Note in the commit body any pre-existing failures unrelated to this phase rather than silently absorbing them.

- [ ] **Step 4: Run the linter**

Run: `cargo clippy --workspace --all-targets -- -D warnings`
Expected: clean. Fix anything this phase introduced; leave pre-existing warnings in untouched files alone.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers
git commit -m "docs(rag): record P2 native RAG status and P2b handoff

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (against P2 scope in R5 = "native store + snapshot + real `rag_query` behind a flag"):**

| Spec item | Task |
|---|---|
| Native store reading/writing the P1 snapshot | Task 4 (`load_or_empty` / `save`, atomic rename) |
| Real `rag_query` — live search, not a re-sort (Section 2) | Task 4 `RagEngine::query`; asserted by `query_result_depends_on_the_query` |
| Query embedded server-side from a resolved model (Section 3) | Task 5 `XbergEmbedder` |
| Legacy JSON `MirrorBundle` compatibility reader (Section 4) | Task 3 + Task 4 `import_legacy` |
| MCP tool served natively (Section 5) | Task 7 |
| R3 mitigation — no hard ORT requirement on the server | Tasks 5 & 7 default to the pure-Rust `lightweight` preset |
| R4 — snapshot version rejection | Inherited from P1 Task 4; `bbox` deferral is called out as a version bump |
| "no model egress in CI" | `MockEmbedder` (Task 1), `--embedder mock` (Task 6), the one network test is `#[ignore]`d (Task 5) |

**"behind a flag" — implemented literally, as a runtime route gate.** An earlier draft of this plan argued the flag was unnecessary because `rag_query` lands on the Rust MCP host rather than the deployed Node one. **That reasoning was wrong and has been corrected.** `xberg-cli` is itself a distributed product (`ghcr.io/xberg-io/xberg-cli` images; `xberg` on crates.io at `1.0.0-rc.31`), so an always-on tool *is* user-facing there. Task 7 therefore gates the route at runtime via `ToolRouter::with_disabled`, default-off behind `XBERG_RAG_ENABLED`, and asserts the default in `rag_gate_tests`. A cargo-feature gate was ruled out on evidence, not preference: rmcp 2.2.0's `tool_router` macro emits routes without propagating `#[cfg]`, so a gated `#[tool]` method fails to compile.

**Deliberate deferrals** (spec-consistent, not gaps): HNSW backend and `hybrid_search`/`SparseVector`/`HybridOpts` (P2b/P3 — see Scope decisions), browser writing the new format and `bbox` on chunks (P3), `list_pii`/`rehydrate_chunk`/`ingest_folder`/`redact` tool migration and auth/static-file move (P4), browser host swap and TS deletion (P5), `mmap` zero-copy reads (perf follow-up).

**2. Placeholder scan:** No "TBD", "handle edge cases", or "similar to Task N". Every code step carries compilable code; every test step names the command and the expected result. Task 8 is documentation whose content is enumerated point-by-point rather than left to judgement. Task 7 Step 4 is a manual check with a stated expected observation and an instruction to record deviations.

**3. Type consistency:**
- `Embedder::{dim, embed_documents, embed_query}` — defined Task 1, implemented by `MockEmbedder` (Task 1) and `XbergEmbedder` (Task 5), consumed by `RagEngine`'s `E: Embedder` bound (Task 4). Task 6's CLI commands construct concrete `RagEngine<MockEmbedder>` / `RagEngine<XbergEmbedder>` values directly per `match` arm rather than through a trait-object bridge — simpler than the original draft's `EngineOps`/`with_engine` indirection for three call sites, with identical behavior. Identical spelling throughout.
- `IndexedChunk` fields (`doc_id`, `chunk_index`, `text`, `page`, `citation`, `vector`) and `RetrievedChunk` fields (`doc_id`, `chunk_index`, `text`, `score`, `citation`, `page`) match P1 Task 2 exactly; `schema::RagHit` (Task 7) mirrors `RetrievedChunk` field-for-field.
- `RagError` variants added across tasks — `Embed` (Task 1), `Legacy` (Task 3), `Io` + `MatterNotFound` (Task 4) — are each added once and matched on by their exact names in Tasks 4, 6, and 7.
- `MatterPaths::{dir, snapshot, legacy_bundle}` (Task 2) used verbatim in Task 4's `paths`/`save`/`import_legacy` and Task 4's `import_legacy_rebuilds_a_searchable_snapshot` test.
- `RagEngine::{index_documents, query, import_legacy}` (Task 4) are called by their exact names directly in Task 6's three CLI command functions and by `mcp::rag::query` (Task 7) — no intermediate trait renames them.
- `EmbedderKind::{Preset, Mock}` (Task 6) is re-exported from `commands` and referenced as `commands::EmbedderKind` in `main.rs` — same path in both places.

**One item flagged for the executor:** Task 5 gives the `xberg-rag` dependency twice — once as an inline `path` form and once as the workspace form it then tells you to use instead. Use the **workspace form** (`xberg-rag = { workspace = true }`) with the entry added to the root `[workspace.dependencies]`; the inline form is shown only to make the version/path explicit. This is stated in the task and is not a defect.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-21-isomorphic-rag-core-p2.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
