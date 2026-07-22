# Isomorphic RAG Core — Unifying the WASM Web UI and the MCP Server in Rust — Design

**Date:** 2026-07-21
**Status:** Draft (pending user review of this document)
**Depends on / extends:**
- `docs/superpowers/specs/2026-07-20-edgevec-pipeline-perf-design.md` (SearchStore abstraction; this spec **changes** its "Node MCP server stays" decision)
- `docs/superpowers/specs/2026-07-18-mcp-folder-ingest-design.md` (node-pipeline ingest path this spec absorbs)
- `docs/superpowers/specs/2026-07-18-mcp-local-auth-solo-design.md` (single-owner auth boundary — preserved verbatim)

## Problem

The same document-intelligence pipeline is implemented **three times**, in three
runtimes, and the one that a serious RAG product needs — real vector search on the
MCP server — is the one that doesn't exist:

1. **Browser** — `@xberg-io/xberg-wasm` (the Rust core compiled to WASM) driven by a
   TypeScript orchestration layer (`packages/wasm-pipeline/src/*`: `ingest`, `embed`,
   `ner`, `rag`, `redact`, `vault`, `mirror`) plus the third-party `edgevec` WASM
   package for the vector index, plus `onnxruntime-web`.
2. **MCP server** — a **Node/TypeScript reimplementation** (`services/mcp-server`)
   whose `rag_query` does **not** run vector search. `MirrorStore.retrieve()`
   ([services/mcp-server/src/mirror.ts:260](../../../services/mcp-server/src/mirror.ts))
   only re-sorts the chunks the browser last mirrored, by a mirror-time placeholder
   score. Ingest is delegated to a second TS reimplementation, `packages/node-pipeline`.
3. **Rust core** — `crates/xberg` already contains a **complete MCP server**
   (`crates/xberg/src/mcp`, `rmcp` 2.2.0, stdio + streamable-HTTP), an `axum` 0.8 API
   server (`crates/xberg/src/api`), a WASM-safe pure-Rust embedder
   (`crates/xberg/src/embeddings/static_engine.rs`, `model2vec_rs`), plus
   `reranking`, `late_interaction` (ColBERT MaxSim, WASM-safe), `sparse_embeddings`
   (SPLADE), `chunking`, and `extraction`. **None of it is the deployed MCP server.**

Consequences observed in the code:

- **MCP retrieval is a frozen snapshot.** External clients (Claude) and any future
  server-side query get last-mirrored chunks, never a live similarity search over the
  query. The vector index (`edgevec`) exists only in the browser.
- **Two disconnected stores** with no shared query language: `edgevec` + manual
  `localStorage` JSON metadata in the browser, `better-sqlite3` in Node (called out
  as problem #6 in the perf design spec).
- **The MirrorBundle wire format is JSON with `index: number[]` / `vault: number[]`**
  ([services/mcp-server/src/mirror.ts:30](../../../services/mcp-server/src/mirror.ts),
  [packages/wasm-pipeline/src/mirror.ts:32](../../../packages/wasm-pipeline/src/mirror.ts)) —
  every raw byte is serialized as a JSON number. Large, and re-parsed on every read.
- **Tool definitions drift** between the Node MCP server and the Rust MCP module,
  because they are written twice.
- **The pipeline is maintained twice in TypeScript** (`wasm-pipeline` +
  `node-pipeline`) on top of the Rust logic it wraps.

Newly verified fact that makes the fix tractable: **`edgevec` is itself a native Rust
crate on crates.io** (tags `#vector #wasm`, MIT/Apache-2.0). The browser's npm
`edgevec` is the `wasm-bindgen` build of a crate that also compiles natively — so the
MCP server can link the **same** HNSW index code the browser uses.

## Goals

- **One source of truth for the RAG pipeline**: a single `xberg-rag` crate owns
  `chunk → embed → index → search → hybrid-fuse → vault → MCP-tools`, compiled to
  **two targets from one source**: `wasm32-unknown-unknown` (browser host) and native
  (MCP/API server host).
- **Real vector search on the MCP server**: `rag_query` runs live HNSW (+ hybrid RRF)
  over the actual index, not a re-sorted snapshot.
- **One model on disk, reused by both hosts** (extends the existing `ModelCache`,
  [services/mcp-server/src/models.ts](../../../services/mcp-server/src/models.ts)).
- **One compact, versioned wire format** shared by both hosts, replacing the JSON
  `number[]` MirrorBundle.
- **MCP tool definitions written once** (rmcp `#[tool]`), served natively.
- **Collapse the TS orchestration** (`wasm-pipeline` + `node-pipeline`) to thin host
  glue.
- **Preserve every existing invariant**: local-first compute, single-owner auth
  boundary, owner-passphrase-gated rehydration, atomic/audited mirror writes,
  COOP/COEP cross-origin isolation, no model egress in CI.

## Non-goals (this spec)

- **Wasmtime/Wasmer plugin sandbox** — deferred by explicit decision this session
  ("keep the default"). Native-on-server / wasm-in-browser, no embedded wasm runtime.
  A future `docs/superpowers/specs/*-plugin-sandbox-design.md` may add it around the
  native core.
- **Single deterministic wasm artifact run server-side via a wasm runtime** — deferred
  with the above (compliance-driven, pays a perf/complexity tax).
- **Multi-tenant / hosted MCP** — the single-owner persona
  (`2026-07-18-mcp-local-auth-solo-design.md`) is unchanged.
- **Migrating browser storage to Turso/LanceDB** — proven impossible in browser-wasm
  by the perf spec's spike; out of scope.
- **Changing embedding models or dimensions** (`EMBED_DIM` stays); this is a plumbing
  unification, not a model change.

## Decisions (from this session's investigation)

1. **Isomorphic core, not a third rewrite.** Extract `xberg-rag` from the modules that
   already exist in `crates/xberg` (regroup behind traits; do not reimplement engine
   logic — AGENTS.md rule 1). Both targets compile the same crate.
2. **Native-on-server, wasm-in-browser.** The server compiles to native machine code
   (keeps `ort` e5 quality, threads, `mmap`, filesystem). The browser keeps running
   wasm natively in the JS engine. **No Wasmtime/Wasmer** (non-goal above).
3. **`edgevec` as a shared crate dependency** for the vector index on both targets —
   **gated behind a spike** (see Risk R1). Fallback: `rust-cv/hnsw` (serde-serializable,
   pure-Rust, wasm-clean) if the native crate lags npm `0.9.0` or its persistence is
   unusable natively.
4. **`rkyv` zero-copy snapshot** for the index+vector blob (server `mmap`s and searches
   without a full deserialize); small human/RAG metadata (PII token spans, chunk
   citations) stays `serde` (JSON today, MessagePack via the existing `rmp-serde` dep
   is a cheap upgrade). Snapshot is **versioned** with a magic header.
5. **Embeddings backend split by target, one model catalog.** WASM: `model2vec_rs`
   (`static_engine.rs`) and/or `onnxruntime-web`. Native: `ort` e5 (best quality).
   Both resolve models through the existing on-disk `ModelCache` — **no re-download**.
6. **MCP tools authored once** as rmcp `#[tool]` handlers in `xberg-rag`; the native
   host is `xberg-cli … mcp` (already exists,
   [crates/xberg-cli/src/commands/server.rs](../../../crates/xberg-cli/src/commands/server.rs)).
   The Node `services/mcp-server` is retired (its static-file + auth + audit
   responsibilities move to the Rust `api` host, which already has them).
7. **Local-first compute is preserved.** The browser still computes ingest/embed/search
   locally. The server gaining a real search path does **not** send documents anywhere;
   rehydration stays owner-passphrase-gated at call time.

## Approach

**Chosen — "Isomorphic Core + two thin hosts."** One `xberg-rag` crate; a `SearchStore`
trait (already introduced by the perf spec) with a target-split backing implementation;
two host binaries (browser wasm-bindgen module, native `xberg-cli`) that bind the same
functions; one `rkyv` snapshot synced between them.

Alternatives rejected:

- **Keep three implementations, only fix `retrieve()` in Node.** Rejected: to do real
  search in Node you must reimplement HNSW + the embedder a *fourth* time, or bind the
  native engine (blocked on Windows per `2026-07-18-mcp-folder-ingest-design.md`'s
  `ner-onnx` note). Deepens the exact fragmentation this spec removes.
- **Run the wasm core server-side under Wasmtime for uniformity.** Rejected as a
  non-goal: sandbox overhead + loses native `ort`/threads/`mmap`; `wasi-nn` recovers ML
  but at real complexity cost. Value (determinism/isolation) doesn't match the current
  single-owner persona.
- **Move the browser to a server round-trip for search.** Rejected: breaks local-first
  and the offline story; the browser already has the index in memory.

---

## Section 1 — Crate & module topology

```
crates/
├─ xberg/            (unchanged: extraction, ocr, chunking, embeddings, reranking, …)
├─ xberg-rag/        NEW — the isomorphic core
│   ├─ store.rs      SearchStore trait + edgevec-backed impl (cfg: wasm32 | native)
│   ├─ embed.rs      embed_query()/embed_chunks() — backend by target (model2vec | ort)
│   ├─ index.rs      HNSW build/insert/search/hybrid-RRF over the shared store
│   ├─ vault.rs      seal/open (aes-gcm + argon2/pbkdf2), owner-gated rehydrate
│   ├─ snapshot.rs   rkyv (de)serialize of the versioned SearchStore snapshot
│   └─ tools.rs      rmcp #[tool] rag_query / list_pii / rehydrate_chunk / ingest_folder / redact
├─ xberg-wasm/       host: adds wasm-bindgen exports that call xberg-rag (cfg wasm32)
└─ xberg-cli/        host: `mcp` + `serve` already call xberg::mcp / xberg::api
```

**Interfaces (authoritative signatures the hosts bind):**

```rust
// store.rs
pub trait SearchStore {
    fn ingest(&mut self, items: &[IndexedChunk]) -> Result<()>;
    fn search(&self, query: &[f32], top_k: usize) -> Result<Vec<RetrievedChunk>>;
    fn hybrid_search(&self, dense: &[f32], sparse: &SparseVector, opts: HybridOpts)
        -> Result<Vec<RetrievedChunk>>;
    fn snapshot(&self) -> Result<Vec<u8>>;                 // rkyv bytes
    fn load(bytes: &[u8]) -> Result<Self> where Self: Sized;
}
// snapshot.rs — versioned; magic b"XRAG" + u16 version, then rkyv archive
pub const SNAPSHOT_MAGIC: [u8; 4] = *b"XRAG";
pub const SNAPSHOT_VERSION: u16 = 1;
```

The native host may `mmap` the snapshot and read the `rkyv` archive zero-copy; the wasm
host reads the same bytes from an IndexedDB blob and rebuilds the in-memory index once
per session (the perf spec's "rebuild once, not per query" fix, now in Rust).

## Section 2 — Vector store unification (the crux)

Today `edgevec` is reached only from JS ([packages/wasm-pipeline/src/rag.ts](../../../packages/wasm-pipeline/src/rag.ts):
`buildIndex`/`loadIndex`/`retrieve`/`serializeIndex`). The perf spec documents that
`edgevec@0.9.0`'s `save`/`load` is **broken** (write-only byte export) and the old code
worked around it by replaying `insert()` on every query.

**Plan:** link `edgevec` as a Rust dependency of `xberg-rag` for both targets. The
`SearchStore` impl wraps `edgevec`'s HNSW + hybrid RRF + BQ. Persistence is **owned by
`snapshot.rs`** (rkyv), *not* by `edgevec`'s broken `save`/`load` — so the upstream bug
is bypassed identically on both hosts. The server's `rag_query` becomes:

```rust
let q = embed_query(&args.query)?;              // ort e5 natively, from ModelCache
let hits = store.hybrid_search(&q, &sparse, opts)?;   // real HNSW + BM25 RRF
```

replacing `ctx.mirror.retrieve()`'s snapshot re-sort.

## Section 3 — Model reuse (no re-download)

The existing `ModelCache` ([services/mcp-server/src/models.ts](../../../services/mcp-server/src/models.ts))
already serves one SHA256-verified on-disk copy to **both** the browser (`GET /models/*`)
and the Node pipeline. Its responsibility moves to the Rust `api` host (which serves
`/models/*` the same way) and to `xberg-rag::embed`, which calls the same
`ensureModel("e5-fp32")` resolution. Net: the query embedder on the server reuses the
exact model bytes the browser already downloaded — the answer to "réutiliser les mêmes
modèles sans retélécharger" from this session, now structural.

## Section 4 — Wire format: MirrorBundle → rkyv snapshot

Replace the JSON `MirrorBundle` (`index: number[]`, `vault: number[]`) with the
`snapshot.rs` format: `[magic|version|rkyv(SearchStore snapshot)]` for the index+vectors
+ vault bytes, and a small `serde` sidecar for PII token spans / cited chunks that HTTP
clients read without touching the index. Keep a **compatibility reader** for the legacy
JSON bundle through the transition (parse old, write new), so existing on-disk mirrors
still load. Atomic staged-write + audited-save semantics
([services/mcp-server/src/mirror.ts:111](../../../services/mcp-server/src/mirror.ts))
are preserved by the Rust `api` host.

## Section 5 — Host collapse & MCP tools

- **MCP tools** (`rag_query`, `list_pii`, `rehydrate_chunk`, `ingest_folder`, `redact`)
  are authored once as rmcp `#[tool]` in `xberg-rag::tools`, replacing the hand-written
  Node handlers ([services/mcp-server/src/mcp/tools.ts](../../../services/mcp-server/src/mcp/tools.ts)).
- **Native MCP host** is `xberg-cli mcp` (stdio) / streamable-HTTP — both already wired
  ([crates/xberg-cli/src/commands/server.rs](../../../crates/xberg-cli/src/commands/server.rs)).
- **Static UI + `/models` + auth + audit** move to the Rust `api` host. The single-owner
  session-token model (`2026-07-18-mcp-local-auth-solo-design.md`) is reimplemented
  1:1 (per-launch 256-bit token, injected into `GET /`, `/api/*` bearer-gated,
  `Sec-Fetch-Site` cross-site rejection).
- **Browser host** is `xberg-wasm` wasm-bindgen exports that call `xberg-rag`, plus
  `wasm-bindgen-rayon` for parallel embedding (COOP/COEP + SharedArrayBuffer already
  asserted in the e2e spec). `wasm-pipeline`/`node-pipeline` shrink to glue and are
  eventually deleted.

## Section 6 — Verification (must extend, not replace, existing e2e)

The `2026-07-17-wasm-web-ui-e2e-design.md` suite is the acceptance harness. New/changed
assertions:

- **Live-search equivalence:** the browser search result and a fresh MCP `rag_query`
  over the same synced snapshot return the **same top-K chunk ids** (proves the shared
  index, not a snapshot). This is a *new* guarantee — today the MCP path can't search.
- **Snapshot round-trip:** `snapshot()` → `load()` on both targets returns an index that
  answers an identical query identically; legacy JSON bundle still loads.
- **Model reuse:** server `rag_query` runs with **no network fetch** (models resolved
  from the cache the browser populated) — assert zero egress.
- **GDPR loop preserved:** `DELETE /matters/:id` → fresh MCP process → `rag_query`
  errors `not_found` (unchanged from the e2e spec).
- **Auth parity:** `/api/*` bearer + `Sec-Fetch-Site` behavior identical to the Node host.

---

## Open risks / mitigations (gates)

- **R1 — `edgevec` native crate parity (blocking gate).** crates.io shows an older
  version than npm `0.9.0`; native persistence/hybrid API may differ. **Gate:** a spike
  builds `xberg-rag` native + wasm against `edgevec`, round-trips an index through
  `snapshot.rs`, and runs hybrid RRF on both. **Fallback:** `rust-cv/hnsw` (serde) — we
  own persistence via rkyv regardless, so the swap is contained to `store.rs`.
- **R2 — wasm binary size.** `xberg-wasm/lib.rs` is already ~983 KB; adding index + rayon
  grows it. **Mitigation:** strict feature-gating (`wasm-target` already excludes ORT),
  `wasm-opt`, measure gz before/after; budget assertion in CI.
- **R3 — `ort` on the server target across OSes.** The folder-ingest spec notes Windows
  CI struggles to build `ort`. **Mitigation:** the native host uses `ort-dynamic`
  (already a feature) / `model2vec` fallback for query embedding on constrained targets;
  don't hard-require bundled ORT.
- **R4 — `rkyv` schema stability.** Zero-copy reads are UB on a mismatched schema.
  **Mitigation:** magic+version header, reject unknown versions, keep the legacy JSON
  reader through transition.
- **R5 — Scope.** This spans 5 subsystems (core extract, store, snapshot, host collapse,
  browser rewrite). **Mitigation:** ship as **phased implementation plans**, each
  independently green: (P1) `xberg-rag` extraction + SearchStore; (P2) native store +
  snapshot + real `rag_query` behind a flag; (P3) wire-format migration; (P4) MCP-tool
  + host collapse; (P5) browser host swap + TS deletion. Each phase keeps the app
  working (the e2e suite must stay green between phases).
- **R6 — Supersedes a prior decision.** The perf spec said "Node MCP server stays
  `better-sqlite3` + EdgeVec bytes mirror." This spec consciously reverses that once the
  native store lands; until P2 is green, the Node host remains the deployed one.

## Out of scope (explicit)

- Wasmtime/Wasmer, plugin sandbox, deterministic server-side wasm artifact (non-goals).
- Multi-tenant hosting; embedding-model/dimension changes; Turso/LanceDB migration.
- Fixing `edgevec` upstream `save`/`load` (we bypass it via `snapshot.rs`).
