# Isomorphic RAG Core — Phase 1 (`xberg-rag` crate + SearchStore) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-21-isomorphic-rag-core-design.md` (Phase P1 of R5)

**Goal:** Create a new standalone `xberg-rag` crate exposing a `SearchStore` trait, a working flat cosine backend, and a versioned `rkyv` snapshot round-trip — and prove `edgevec` 0.9.0 compiles for both native and `wasm32` targets (gate R1).

**Architecture:** A dependency-light library crate (`serde`, `thiserror`, `rkyv` only) with a target-agnostic `SearchStore` trait. P1 ships one backend — an exact-search `FlatStore` (cosine) — which doubles as the correctness oracle for the HNSW backend added in P2. Persistence is owned by the crate's own `snapshot` module (magic + version + `rkyv`), never by `edgevec`'s broken `save`/`load`. The heavy `xberg` engine wiring (real embeddings, chunking) and the `edgevec` HNSW backend are **P2**, not here.

**Tech Stack:** Rust 2024 edition (rust 1.91), `serde` 1.0.228, `thiserror` 2.0.18, `rkyv` 0.8, `edgevec` 0.9.0 (compile-gate only in P1).

## Global Constraints

- Rust edition **2024**, `rust-version` **1.91**, inherited via `*.workspace = true` (copy the pattern from `crates/xberg-gliner/Cargo.toml`).
- `unsafe_code = "deny"` (workspace lint) — **no `unsafe`**. Use rkyv's safe `to_bytes`/`from_bytes` APIs, not `access_unchecked`.
- All shared deps come from `[workspace.dependencies]` in the root `Cargo.toml` and are referenced as `{ workspace = true }`. Add new shared deps there, not in the crate.
- Every crate ends its `Cargo.toml` with `[lints]` / `workspace = true`.
- Embedding dimension constant is **768** (mirror of `packages/wasm-pipeline/src/constants.ts` `EMBED_DIM`).
- Conventional-commit messages; end each commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- P1 crate must **not** depend on `xberg` core, `ort`, or `edgevec` in its default build (keeps it fast and wasm-clean). `edgevec` is an **optional** dep behind a `hnsw` feature, used only by the Task 5 compile-gate.

## File Structure

- `crates/xberg-rag/Cargo.toml` — new crate manifest (workspace member).
- `crates/xberg-rag/src/lib.rs` — module wiring + public re-exports + `EMBED_DIM`.
- `crates/xberg-rag/src/error.rs` — `RagError` + `Result` alias.
- `crates/xberg-rag/src/types.rs` — `IndexedChunk`, `RetrievedChunk` (rkyv+serde derives).
- `crates/xberg-rag/src/store.rs` — `SearchStore` trait.
- `crates/xberg-rag/src/flat.rs` — `FlatStore` exact-cosine backend + `cosine()`.
- `crates/xberg-rag/src/snapshot.rs` — versioned `encode`/`decode` (magic + version + rkyv).
- `crates/xberg-rag/examples/edgevec_smoke.rs` — Task 5 compile-gate (feature `hnsw`).
- `Cargo.toml` (root) — add `crates/xberg-rag` to `members`; add `rkyv` and `edgevec` to `[workspace.dependencies]`.

---

### Task 1: Scaffold the `xberg-rag` crate

**Files:**
- Create: `crates/xberg-rag/Cargo.toml`
- Create: `crates/xberg-rag/src/lib.rs`
- Modify: `Cargo.toml` (root) — `members` list + `[workspace.dependencies]`

**Interfaces:**
- Produces: an empty but buildable `xberg-rag` library crate; `pub const EMBED_DIM: usize = 768;`.

- [ ] **Step 1: Register the crate and add workspace deps**

In root `Cargo.toml`, add to `members` (keep alphabetical after `crates/xberg-py`):

```toml
    "crates/xberg-rag",
```

In root `Cargo.toml` `[workspace.dependencies]`, add:

```toml
rkyv = { version = "0.8", default-features = false, features = ["alloc", "bytecheck"] }
edgevec = { version = "0.9.0", default-features = false }
```

- [ ] **Step 2: Write the crate manifest**

Create `crates/xberg-rag/Cargo.toml`:

```toml
[package]
name = "xberg-rag"
version.workspace = true
edition.workspace = true
rust-version.workspace = true
authors.workspace = true
license.workspace = true
repository.workspace = true
homepage.workspace = true

[dependencies]
serde = { workspace = true }
thiserror = { workspace = true }
rkyv = { workspace = true }
edgevec = { workspace = true, optional = true }

[features]
default = []
# Compile-gate only in P1: proves edgevec builds for native + wasm (see examples/edgevec_smoke.rs).
hnsw = ["dep:edgevec"]

[lints]
workspace = true
```

- [ ] **Step 3: Write the crate root**

Create `crates/xberg-rag/src/lib.rs`:

```rust
//! Isomorphic RAG core: `SearchStore` trait + backends shared by the browser
//! (wasm32) and MCP/API server (native) hosts. See
//! `docs/superpowers/specs/2026-07-21-isomorphic-rag-core-design.md`.

mod error;
mod flat;
mod snapshot;
mod store;
mod types;

pub use error::{RagError, Result};
pub use flat::FlatStore;
pub use store::SearchStore;
pub use types::{IndexedChunk, RetrievedChunk};

/// Dense embedding dimension (e5). Mirrors `EMBED_DIM` in the TS pipeline.
pub const EMBED_DIM: usize = 768;
```

Create empty placeholder modules so the crate compiles (real content lands in later tasks):

`crates/xberg-rag/src/error.rs`, `flat.rs`, `snapshot.rs`, `store.rs`, `types.rs` — each initially containing only `// filled in by a later task`. (Task 2 replaces `error.rs`+`types.rs`, Task 3 `store.rs`+`flat.rs`, Task 4 `snapshot.rs`.) To keep `lib.rs` compiling before those tasks, temporarily comment out the `pub use` / `mod` lines for not-yet-written modules — OR implement Tasks 2–4 back-to-back without an intermediate build here. **Recommended: treat Steps 4–5 below as the build checkpoint after Task 2**, and in this task only create `Cargo.toml` + a minimal `lib.rs` containing just the doc comment and `EMBED_DIM`:

```rust
//! Isomorphic RAG core (see spec 2026-07-21). Modules added in Tasks 2–4.

/// Dense embedding dimension (e5). Mirrors `EMBED_DIM` in the TS pipeline.
pub const EMBED_DIM: usize = 768;
```

- [ ] **Step 4: Build the empty crate**

Run: `cargo build -p xberg-rag`
Expected: `Finished` (compiles clean, no warnings under `-D`-free `warn` lints).

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml crates/xberg-rag/Cargo.toml crates/xberg-rag/src/lib.rs
git commit -m "feat(rag): scaffold xberg-rag crate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Core types + error

**Files:**
- Create: `crates/xberg-rag/src/error.rs`
- Create: `crates/xberg-rag/src/types.rs`
- Modify: `crates/xberg-rag/src/lib.rs` (wire modules + re-exports)

**Interfaces:**
- Produces:
  - `struct IndexedChunk { doc_id: String, chunk_index: u32, text: String, page: Option<u32>, citation: Option<String>, vector: Vec<f32> }`
  - `struct RetrievedChunk { doc_id: String, chunk_index: u32, text: String, score: f32, citation: Option<String>, page: Option<u32> }`
  - `enum RagError` + `type Result<T> = std::result::Result<T, RagError>`
  - Both structs derive `Clone, Debug, PartialEq, serde::{Serialize, Deserialize}, rkyv::{Archive, Serialize, Deserialize}`.

- [ ] **Step 1: Write the failing test**

Append to `crates/xberg-rag/src/types.rs`:

```rust
use serde::{Deserialize, Serialize};

/// A chunk plus its dense embedding, ready to index.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[derive(rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
pub struct IndexedChunk {
    pub doc_id: String,
    pub chunk_index: u32,
    pub text: String,
    pub page: Option<u32>,
    pub citation: Option<String>,
    pub vector: Vec<f32>,
}

/// A search hit returned to a host (browser or MCP server).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[derive(rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
pub struct RetrievedChunk {
    pub doc_id: String,
    pub chunk_index: u32,
    pub text: String,
    pub score: f32,
    pub citation: Option<String>,
    pub page: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexed_chunk_roundtrips_through_serde() {
        let c = IndexedChunk {
            doc_id: "d1".into(),
            chunk_index: 3,
            text: "hello".into(),
            page: Some(2),
            citation: Some("d1:3".into()),
            vector: vec![0.1, 0.2, 0.3],
        };
        let json = serde_json::to_string(&c).unwrap();
        let back: IndexedChunk = serde_json::from_str(&json).unwrap();
        assert_eq!(c, back);
    }
}
```

Write `crates/xberg-rag/src/error.rs`:

```rust
/// Errors returned by the RAG core.
#[derive(Debug, thiserror::Error)]
pub enum RagError {
    #[error("dimension mismatch: expected {expected}, got {got}")]
    DimMismatch { expected: usize, got: usize },
    #[error("snapshot too short: {0} bytes")]
    SnapshotTooShort(usize),
    #[error("bad snapshot magic")]
    BadMagic,
    #[error("unsupported snapshot version: {0}")]
    UnsupportedVersion(u16),
    #[error("snapshot (de)serialization failed: {0}")]
    Snapshot(String),
}

/// Convenience alias for fallible RAG operations.
pub type Result<T> = std::result::Result<T, RagError>;
```

Add `serde_json` as a dev-dependency in `crates/xberg-rag/Cargo.toml`:

```toml
[dev-dependencies]
serde_json = { workspace = true }
```

Wire modules in `lib.rs` (replace the Task 1 minimal body):

```rust
//! Isomorphic RAG core (see spec 2026-07-21).

mod error;
mod types;

pub use error::{RagError, Result};
pub use types::{IndexedChunk, RetrievedChunk};

/// Dense embedding dimension (e5). Mirrors `EMBED_DIM` in the TS pipeline.
pub const EMBED_DIM: usize = 768;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p xberg-rag types::tests::indexed_chunk_roundtrips_through_serde`
Expected: FAIL to **compile** first if rkyv derives are missing a feature; once compiling, the test passes. If it fails to compile on the rkyv derive, confirm `rkyv` has `features = ["alloc", "bytecheck"]` (Task 1). Expected end state after Step 3: PASS.

- [ ] **Step 3: Make it build and pass**

Ensure `lib.rs`, `error.rs`, `types.rs` are as above. Resolve any rkyv derive errors by confirming the workspace `rkyv` feature set. No behavioral code changes beyond the structs.

- [ ] **Step 4: Run tests**

Run: `cargo test -p xberg-rag`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add crates/xberg-rag
git commit -m "feat(rag): add IndexedChunk/RetrievedChunk types and RagError

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `SearchStore` trait + flat cosine backend

**Files:**
- Create: `crates/xberg-rag/src/store.rs`
- Create: `crates/xberg-rag/src/flat.rs`
- Modify: `crates/xberg-rag/src/lib.rs`

**Interfaces:**
- Consumes: `IndexedChunk`, `RetrievedChunk`, `RagError`, `Result` (Task 2).
- Produces:
  - `trait SearchStore: Sized` with `new(dim) -> Self`, `ingest(&mut self, &[IndexedChunk]) -> Result<()>`, `search(&self, &[f32], top_k) -> Result<Vec<RetrievedChunk>>`, `len(&self) -> usize`, `is_empty(&self) -> bool`, `snapshot(&self) -> Result<Vec<u8>>`, `load(&[u8]) -> Result<Self>`.
  - `struct FlatStore` implementing it (P1's only backend). `snapshot`/`load` are stubbed here (delegate to `snapshot` module in Task 4) — in this task they return `RagError::Snapshot("unimplemented".into())` so the trait is complete but persistence tests wait for Task 4.

- [ ] **Step 1: Write the failing test**

Write `crates/xberg-rag/src/store.rs`:

```rust
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
```

Write `crates/xberg-rag/src/flat.rs`:

```rust
use crate::{IndexedChunk, RagError, Result, RetrievedChunk, SearchStore};

/// Exact (brute-force cosine) vector store. O(n) search — correct for any n,
/// fast enough for small matters, and the correctness oracle for P2's HNSW
/// backend.
pub struct FlatStore {
    dim: usize,
    chunks: Vec<IndexedChunk>,
}

impl SearchStore for FlatStore {
    fn new(dim: usize) -> Self {
        Self { dim, chunks: Vec::new() }
    }

    fn ingest(&mut self, items: &[IndexedChunk]) -> Result<()> {
        for it in items {
            if it.vector.len() != self.dim {
                return Err(RagError::DimMismatch { expected: self.dim, got: it.vector.len() });
            }
        }
        self.chunks.extend_from_slice(items);
        Ok(())
    }

    fn search(&self, query: &[f32], top_k: usize) -> Result<Vec<RetrievedChunk>> {
        if query.len() != self.dim {
            return Err(RagError::DimMismatch { expected: self.dim, got: query.len() });
        }
        let mut scored: Vec<(f32, &IndexedChunk)> =
            self.chunks.iter().map(|c| (cosine(query, &c.vector), c)).collect();
        // total_cmp: NaN-safe, no partial_cmp unwrap. Descending by score.
        scored.sort_by(|a, b| b.0.total_cmp(&a.0));
        Ok(scored
            .into_iter()
            .take(top_k)
            .map(|(score, c)| RetrievedChunk {
                doc_id: c.doc_id.clone(),
                chunk_index: c.chunk_index,
                text: c.text.clone(),
                score,
                citation: c.citation.clone(),
                page: c.page,
            })
            .collect())
    }

    fn len(&self) -> usize {
        self.chunks.len()
    }

    fn snapshot(&self) -> Result<Vec<u8>> {
        crate::snapshot::encode(self.dim, &self.chunks)
    }

    fn load(bytes: &[u8]) -> Result<Self> {
        let (dim, chunks) = crate::snapshot::decode(bytes)?;
        Ok(Self { dim, chunks })
    }
}

/// Cosine similarity; 0.0 when either vector has zero norm.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 { 0.0 } else { dot / (na * nb) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(id: &str, idx: u32, v: Vec<f32>) -> IndexedChunk {
        IndexedChunk { doc_id: id.into(), chunk_index: idx, text: format!("{id}:{idx}"),
            page: None, citation: None, vector: v }
    }

    #[test]
    fn search_returns_nearest_first() {
        let mut s = FlatStore::new(3);
        s.ingest(&[
            chunk("d", 0, vec![1.0, 0.0, 0.0]),
            chunk("d", 1, vec![0.0, 1.0, 0.0]),
            chunk("d", 2, vec![0.9, 0.1, 0.0]),
        ]).unwrap();
        let hits = s.search(&[1.0, 0.0, 0.0], 2).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].chunk_index, 0);   // identical direction, score ~1.0
        assert_eq!(hits[1].chunk_index, 2);   // next closest
        assert!(hits[0].score > hits[1].score);
    }

    #[test]
    fn ingest_rejects_wrong_dimension() {
        let mut s = FlatStore::new(3);
        let err = s.ingest(&[chunk("d", 0, vec![1.0, 0.0])]).unwrap_err();
        assert!(matches!(err, RagError::DimMismatch { expected: 3, got: 2 }));
    }
}
```

Wire in `lib.rs` (add `mod flat; mod snapshot; mod store;` and re-exports):

```rust
mod error;
mod flat;
mod snapshot;
mod store;
mod types;

pub use error::{RagError, Result};
pub use flat::FlatStore;
pub use store::SearchStore;
pub use types::{IndexedChunk, RetrievedChunk};
```

Create a temporary `crates/xberg-rag/src/snapshot.rs` stub so it compiles (Task 4 replaces it):

```rust
use crate::{IndexedChunk, RagError, Result};

pub(crate) fn encode(_dim: usize, _chunks: &[IndexedChunk]) -> Result<Vec<u8>> {
    Err(RagError::Snapshot("unimplemented (Task 4)".into()))
}

pub(crate) fn decode(_bytes: &[u8]) -> Result<(usize, Vec<IndexedChunk>)> {
    Err(RagError::Snapshot("unimplemented (Task 4)".into()))
}
```

- [ ] **Step 2: Run tests to verify they fail (then pass)**

Run: `cargo test -p xberg-rag flat::tests`
Expected: compiles; both `search_returns_nearest_first` and `ingest_rejects_wrong_dimension` PASS. (Snapshot stub is untested here.)

- [ ] **Step 3: Fix any compile errors**

Only expected issue: ensure `snapshot` stub signatures match `flat.rs` calls. No logic changes.

- [ ] **Step 4: Run the full crate test suite**

Run: `cargo test -p xberg-rag`
Expected: PASS (3 tests: 1 from Task 2, 2 here).

- [ ] **Step 5: Commit**

```bash
git add crates/xberg-rag
git commit -m "feat(rag): add SearchStore trait and FlatStore cosine backend

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Versioned `rkyv` snapshot round-trip

**Files:**
- Modify: `crates/xberg-rag/src/snapshot.rs` (replace the Task 3 stub)

**Interfaces:**
- Consumes: `IndexedChunk`, `RagError`, `Result`.
- Produces: `pub(crate) fn encode(dim: usize, chunks: &[IndexedChunk]) -> Result<Vec<u8>>` and `pub(crate) fn decode(bytes: &[u8]) -> Result<(usize, Vec<IndexedChunk>)>`. Format: `b"XRAG"` (4) + version `u16` LE (2) + `rkyv`-archived `SnapshotBody { dim: u32, chunks: Vec<IndexedChunk> }`. `pub const SNAPSHOT_VERSION: u16 = 1`.

- [ ] **Step 1: Write the failing test**

Replace `crates/xberg-rag/src/snapshot.rs` with:

```rust
use crate::{IndexedChunk, RagError, Result};
use rkyv::rancor::Error as RkyvError;

/// Magic prefix identifying an xberg-rag snapshot blob.
const SNAPSHOT_MAGIC: [u8; 4] = *b"XRAG";
/// On-disk snapshot format version. Bump on any layout change.
pub const SNAPSHOT_VERSION: u16 = 1;
const HEADER_LEN: usize = 6; // 4 magic + 2 version

#[derive(rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
struct SnapshotBody {
    dim: u32,
    chunks: Vec<IndexedChunk>,
}

pub(crate) fn encode(dim: usize, chunks: &[IndexedChunk]) -> Result<Vec<u8>> {
    let body = SnapshotBody { dim: dim as u32, chunks: chunks.to_vec() };
    let archived = rkyv::to_bytes::<RkyvError>(&body)
        .map_err(|e| RagError::Snapshot(e.to_string()))?;
    let mut out = Vec::with_capacity(HEADER_LEN + archived.len());
    out.extend_from_slice(&SNAPSHOT_MAGIC);
    out.extend_from_slice(&SNAPSHOT_VERSION.to_le_bytes());
    out.extend_from_slice(&archived);
    Ok(out)
}

pub(crate) fn decode(bytes: &[u8]) -> Result<(usize, Vec<IndexedChunk>)> {
    if bytes.len() < HEADER_LEN {
        return Err(RagError::SnapshotTooShort(bytes.len()));
    }
    if bytes[0..4] != SNAPSHOT_MAGIC {
        return Err(RagError::BadMagic);
    }
    let version = u16::from_le_bytes([bytes[4], bytes[5]]);
    if version != SNAPSHOT_VERSION {
        return Err(RagError::UnsupportedVersion(version));
    }
    let body: SnapshotBody = rkyv::from_bytes::<SnapshotBody, RkyvError>(&bytes[HEADER_LEN..])
        .map_err(|e| RagError::Snapshot(e.to_string()))?;
    Ok((body.dim as usize, body.chunks))
}

#[cfg(test)]
mod tests {
    use crate::{FlatStore, IndexedChunk, RagError, SearchStore};

    fn store_with_two() -> FlatStore {
        let mut s = FlatStore::new(3);
        s.ingest(&[
            IndexedChunk { doc_id: "d".into(), chunk_index: 0, text: "a".into(),
                page: Some(1), citation: Some("d:0".into()), vector: vec![1.0, 0.0, 0.0] },
            IndexedChunk { doc_id: "d".into(), chunk_index: 1, text: "b".into(),
                page: None, citation: None, vector: vec![0.0, 1.0, 0.0] },
        ]).unwrap();
        s
    }

    #[test]
    fn snapshot_roundtrip_preserves_search() {
        let s = store_with_two();
        let bytes = s.snapshot().unwrap();
        let restored = FlatStore::load(&bytes).unwrap();
        assert_eq!(restored.len(), 2);
        let a = s.search(&[1.0, 0.0, 0.0], 1).unwrap();
        let b = restored.search(&[1.0, 0.0, 0.0], 1).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn decode_rejects_bad_magic() {
        let mut bytes = store_with_two().snapshot().unwrap();
        bytes[0] = b'Z';
        assert!(matches!(FlatStore::load(&bytes).unwrap_err(), RagError::BadMagic));
    }

    #[test]
    fn decode_rejects_short_input() {
        assert!(matches!(FlatStore::load(&[1, 2]).unwrap_err(), RagError::SnapshotTooShort(2)));
    }
}
```

Export the version constant from `lib.rs` (add to the `snapshot` re-exports):

```rust
pub use snapshot::SNAPSHOT_VERSION;
```

(Change `mod snapshot;` re-export: add `pub use snapshot::SNAPSHOT_VERSION;` beneath the existing `pub use` lines.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p xberg-rag snapshot::tests`
Expected: FAIL first if the Task 3 stub is still present (`unimplemented (Task 4)`); after replacing it, all three PASS. If `rkyv::from_bytes` errors at compile time, confirm the `bytecheck` feature is enabled on the workspace `rkyv` dep (Task 1).

- [ ] **Step 3: Resolve rkyv API specifics**

If the pinned `rkyv` 0.8 minor exposes a different error path, adjust the `rancor` import (`rkyv::rancor::Error`) and the `to_bytes`/`from_bytes` turbofish accordingly — the round-trip test is the oracle. Do not introduce `unsafe`.

- [ ] **Step 4: Run the full suite**

Run: `cargo test -p xberg-rag`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add crates/xberg-rag
git commit -m "feat(rag): versioned rkyv snapshot encode/decode with round-trip tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Gate R1 — prove `edgevec` 0.9.0 compiles native + wasm32

**Files:**
- Create: `crates/xberg-rag/examples/edgevec_smoke.rs`
- Create: `docs/superpowers/notes/2026-07-21-edgevec-native-spike.md` (findings)

**Interfaces:**
- Consumes: `edgevec` 0.9.0 behind the `hnsw` feature (Task 1).
- Produces: proof (two green builds) that the P2 HNSW backend can link `edgevec` on both targets, plus a findings note recording the exact native API surface (insert/search/hybrid names) P2 will bind. **No production code** — this is the risk gate from spec R1.

- [ ] **Step 1: Write the smoke example**

Create `crates/xberg-rag/examples/edgevec_smoke.rs`. Insert a couple of vectors and run one search, using edgevec's actual native API (consult `https://docs.rs/edgevec/0.9.0`). Skeleton to adapt to the real symbols:

```rust
//! R1 gate: confirm edgevec 0.9.0 links and runs natively.
//! Run: `cargo run -p xberg-rag --example edgevec_smoke --features hnsw`
fn main() {
    // Adapt to the real 0.9.0 API surface (see docs.rs/edgevec/0.9.0):
    //   let cfg = edgevec::EdgeVecConfig::new(3);
    //   let mut db = edgevec::EdgeVec::new(cfg);
    //   db.insert(&[1.0, 0.0, 0.0], /* metadata */);
    //   let hits = db.search(&[1.0, 0.0, 0.0], 1);
    //   assert!(!hits.is_empty());
    println!("edgevec smoke ok");
}
```

- [ ] **Step 2: Build + run native**

Run: `cargo run -p xberg-rag --example edgevec_smoke --features hnsw`
Expected: prints `edgevec smoke ok` (exit 0).

- [ ] **Step 3: Compile-check wasm32**

Run: `cargo build -p xberg-rag --example edgevec_smoke --features hnsw --target wasm32-unknown-unknown`
Expected: `Finished`. (If the `wasm32-unknown-unknown` target is missing: `rustup target add wasm32-unknown-unknown` first.)

- [ ] **Step 4: Record findings**

Create `docs/superpowers/notes/2026-07-21-edgevec-native-spike.md` capturing: the exact `edgevec` 0.9.0 constructor/insert/search/hybrid symbol names, whether metadata is attachable, and a one-line verdict — **"edgevec-native viable, proceed to P2"** or **"fall back to rust-cv/hnsw"** (with the reason). This note is the input to the P2 plan's backend task.

- [ ] **Step 5: Commit**

```bash
git add crates/xberg-rag/examples/edgevec_smoke.rs docs/superpowers/notes/2026-07-21-edgevec-native-spike.md
git commit -m "chore(rag): R1 gate — edgevec 0.9.0 native+wasm compile smoke test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (against P1 scope in R5 = "`xberg-rag` extraction + SearchStore"):**
- `xberg-rag` crate created → Task 1. ✓
- `SearchStore` trait (spec Section 1 signatures) → Task 3. ✓ (P1 subset: `search`; `hybrid_search` is P2 when the sparse/BM25 backend lands — noted below.)
- Versioned `rkyv` snapshot (spec Section 4, `SNAPSHOT_MAGIC`/`SNAPSHOT_VERSION`) → Task 4. ✓
- R1 edgevec-native gate (spec Open risk R1) → Task 5. ✓
- **Deliberate deferrals to P2** (consistent with spec R5 phasing): edgevec HNSW backend, `hybrid_search`/`SparseVector`/`HybridOpts`, `xberg`-core embedding wiring, zero-copy `mmap` access (P1 uses full `from_bytes`; the native host's zero-copy read is a P2 optimization), and the `vault`/`tools` modules (P2/P4). These are **out of P1 scope by design**, not gaps.

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". The only intentionally-incomplete artifact is the Task 5 example skeleton — justified because discovering edgevec's exact native symbols **is** the task's deliverable, and it ships no production code. Every production step contains complete, compilable code.

**3. Type consistency:** `IndexedChunk`/`RetrievedChunk` field names and types are identical across Tasks 2–4. `SearchStore` method names (`new`/`ingest`/`search`/`len`/`is_empty`/`snapshot`/`load`) are used verbatim in `FlatStore` (Task 3) and the snapshot tests (Task 4). `encode`/`decode` signatures match between the Task 3 stub and the Task 4 implementation. `SNAPSHOT_VERSION: u16` consistent between `snapshot.rs` and the `lib.rs` re-export.

**One flagged inconsistency to fix during execution:** Task 1 Step 3 offers two ways to keep `lib.rs` compiling (comment-out vs. minimal body). Use the **minimal-body** option (only doc + `EMBED_DIM`) to avoid a broken intermediate build; Task 2 then installs the real module wiring. This is called out in Task 1 Step 3 and is not a defect.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-21-isomorphic-rag-core-p1.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
