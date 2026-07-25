# Shared Embedding Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-07-22

**Spec:** `docs/superpowers/specs/2026-07-22-shared-embedding-backend-design.md`

**Primary issue:** GitHub issue #30 ("RAG: browser (e5-base, 768-dim) and native host (model2vec, 256-dim) embeddings are incompatible")

**Related branch / PR stack (verified from local git):**

- `feat/isomorphic-rag-core`
- `c0d20a16ad` — docs(rag): add isomorphic RAG core spec to this branch
- `c3b431865e` — docs(rag): add isomorphic RAG core P1 and P2 implementation plans
- `ebd97abe5b` — feat(rag): add RagEngine with live query, additive index, legacy import
- `82ec73854d` — feat(cli): add xberg rag index/query/import-legacy commands
- `42b8953f05` — feat(mcp): add rag_query tool backed by live vector search
- `52e0e0522a` — docs(rag): add shared embedding backend design (scopes #30's P3 decision)
- `0cf0d816dc` — docs(rag): cross-link the shared embedding backend design from R6 and P2 status

**Ground truth this plan must change:**

- Native host defaults to the 256-dim `lightweight` static preset (`docs/superpowers/notes/2026-07-21-p2-native-rag-status.md`).
- Browser host still embeds through TypeScript + `onnxruntime-web` + e5 at 768 dims.
- `xberg-rag` persists per-matter `dim`, but not full embedder identity.
- Browser and native hosts are therefore not cross-compatible today, even when retrieval code is correct.

## Goal

Deliver one Rust-owned dense embedding backend, one model identity, and one migration story shared by:

1. native CLI / MCP / server RAG
2. browser / WASM RAG

This plan removes the current split embedding stack, replaces the browser ORT embedding path, and adds explicit snapshot/embedder identity so cross-host incompatibility becomes impossible to miss and safe to migrate.

## Scope decisions

Read this section before implementation. It constrains every later task.

1. **Dense embeddings only.**
   Sparse, late-interaction, and rerankers stay out of scope.

2. **Shared backend first, retrieval backend second.**
   This plan does not solve HNSW/P2b, edgevec viability, or MCP host collapse.

3. **One model identity across both hosts.**
   No per-host model or dimension tuning.

4. **Migration by re-embedding persisted chunk text.**
   No re-extraction requirement.

5. **BM25 is a parallel or follow-on track.**
   Valuable for legal retrieval, but must not block the dense backend cutover.

6. **NER/PII remains a separate companion pipeline.**
   Embedding and NER model identity, lifecycle, thresholds, and persistence must
   not be coupled merely because both run during browser ingest.

## Investigated model decision (2026-07-23)

Use
[`ibm-granite/granite-embedding-97m-multilingual-r2`](https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2)
as the **provisional shared dense model**, with its official INT8 ONNX artifact
as the reference quantization and 384 dimensions as the target vector shape.
This replaces the plan's unverified BGE-M3 assumption; it is not permission to
skip the Phase 1 runtime spike or the quality gates below.

Why this candidate leads:

- 97.4M parameters, 384-dimensional output, 32,768-token context, and Apache-2.0
  licensing.
- Explicit retrieval training for 52 languages, including 22 of the 24 official
  EU languages. Irish and Maltese have only the broader 200+ language pretraining
  claim, so they require dedicated evaluation.
- The official INT8 ONNX model is about 98.2 MB and its tokenizer about 25.3 MB,
  for roughly 123.5 MB of browser assets before transport compression.
- IBM reports a 60.3 multilingual MTEB retrieval score versus 50.9 for
  multilingual-e5-small. Treat this as vendor-reported general retrieval
  evidence, not proof of legal-domain quality.
- ModernBERT support exists in the repository's Candle generation, but the
  quantized ModernBERT path on `wasm32-unknown-unknown` is not yet proven.

Alternatives:

- Keep the current multilingual-e5 browser implementation as the migration
  baseline. Do not select its current Q4 artifact for constrained devices: the
  published Q4 file is larger than INT8.
- Use the existing native Qwen3 Embedding 0.6B preset as an offline quality
  ceiling or reranking candidate, not as the shared browser default.
- Reject BGE-M3 and Jina Embeddings v5 as shared defaults at this stage:
  BGE-M3 is too large for the browser budget, and Jina v5's non-commercial
  license is unsuitable for client work.

Selection gates before this becomes the default:

- pin the exact model revision, artifact checksums, tokenizer, pooling,
  normalization, maximum sequence length, and query/document formatting in
  `EmbedderIdentity`
- prove native/WASM numerical and retrieval parity on fixed fixtures
- measure download bytes, peak memory, cold start, and warm batch latency on
  representative desktop and mobile browsers
- benchmark retrieval on LEMUR, MuPLeR, and a client-approved multilingual legal
  corpus, including Irish and Maltese samples
- compare dense-only with dense + BM25 and, separately, optional Qwen3 reranking

## Global constraints

- Keep `xberg-rag` generic over its own `Embedder` seam. Do not create a dependency cycle from `xberg-rag` back into `xberg`.
- Reuse the existing embedding plugin/runtime concepts in `crates/xberg` where they help, but do not introduce a second competing abstraction with overlapping responsibilities.
- `unsafe_code = "deny"` remains in force.
- Target support must be explicit: native and `wasm32-unknown-unknown` are first-class; Android follows native unless proven otherwise.
- Every migration gate must be observable in code and snapshot metadata, not implied by docs.
- If the Candle WASM gate fails, stop and re-scope. Do not continue with speculative downstream tasks.
- Removing `onnxruntime-web` applies only to dense embeddings. Browser GLiNER
  still depends on ORT until the independent NER/PII track selects and proves a
  replacement.

## File structure target

This is the expected landing zone if the plan completes as designed.

| File | Responsibility |
|---|---|
| `docs/superpowers/notes/2026-07-22-candle-wasm-spike.md` | Compile-gate note and findings |
| `crates/xberg-candle-embed/Cargo.toml` | New shared dense embedder crate (preferred) |
| `crates/xberg-candle-embed/src/lib.rs` | Public API for shared candle embedder |
| `crates/xberg-candle-embed/src/model.rs` | Model loading and typed config |
| `crates/xberg-candle-embed/src/embed.rs` | Query/document embedding entry points |
| `crates/xberg-candle-embed/src/identity.rs` | Embedder identity metadata |
| `crates/xberg-rag/src/engine.rs` | Snapshot/open/query integration changes |
| `crates/xberg-rag/src/snapshot.rs` | Embedder identity persisted in snapshots |
| `crates/xberg/src/rag_embed.rs` | Native adapter from shared embedder into RAG |
| `crates/xberg-wasm/src/lib.rs` | WASM exports for the shared embedder |
| `packages/wasm-pipeline/src/embed.ts` | Browser TS adapter removed or reduced to wasm bridge |
| `packages/wasm-pipeline/src/rag.ts` | Browser RAG path moved onto wasm embedder |

If implementation chooses a module instead of a new crate, the tasks below still apply but file paths change accordingly. The preferred shape is still a new crate because OCR/VLM concerns should not be coupled to text embeddings.

## Phase map

- **Phase 1:** Candle WASM compile gate
- **Phase 2:** Shared candle dense embedder core
- **Phase 3:** Native cutover + snapshot identity migration
- **Phase 4:** Browser/WASM cutover
- **Parallel / follow-up:** NER/PII safety and multilingual legal evaluation
- **Parallel / follow-up:** BM25 lexical hybrid

---

## Phase 1 — Candle WASM compile gate

**Goal:** Prove the repo can compile the intended Candle text-model path for `wasm32-unknown-unknown`.

**Why this phase exists:** The shared embedding design is invalid if Candle cannot compile for the browser target in this repository with its actual dependency graph.

### Task 1: Audit the current Candle dependency graph

**Files:**

- Inspect: `crates/xberg-candle-ocr/Cargo.toml`
- Inspect: `crates/xberg/Cargo.toml`
- Inspect: any Candle-dependent modules pulled transitively by those manifests
- Create: `docs/superpowers/notes/2026-07-22-candle-wasm-spike.md`

**Consumes:**

- The July 22 shared embedding design spec
- Existing Candle OCR dependency wiring

**Produces:**

- A written spike note naming the exact native-only blockers, not a guess

- [ ] **Step 1: Identify all Candle crates and native-only feature wires**

Record:

- which Candle crates are in use now
- which features are enabled
- which target-specific native dependencies are unconditional today

- [ ] **Step 2: Identify the exact WASM blockers**

Explicitly verify whether the current blockers are:

- `cudarc`
- `metal-kernels`
- `accelerate` / MKL-related deps
- other platform-specific crates
- module-level code that assumes native I/O or threading

- [ ] **Step 3: Write the spike note**

The note must include:

- observed blockers
- candidate cfg/feature changes
- what can be isolated from OCR/VLM code
- what remains uncertain

- [ ] **Step 4: Commit**

Suggested commit:

```bash
git commit -m "docs(rag): add candle wasm spike note for shared embeddings"
```

### Task 2: Add a compile-only WASM smoke target

**Files:**

- Create: one minimal smoke target under a Candle-owned crate or a new scratch crate/example
- Modify: relevant `Cargo.toml` files for feature gating only
- Update: `docs/superpowers/notes/2026-07-22-candle-wasm-spike.md`

**Produces:**

- a compile-only target that exercises Candle text-model code without dragging in OCR/VLM paths

- [ ] **Step 1: Add the minimal text-model smoke target**

Requirements:

- no OCR code
- no VLM code
- no host/browser bridge code
- only the intended Candle text stack

- [ ] **Step 2: Add target-gated dependency fixes**

Only the minimum changes needed to let the smoke target compile should land here.

- [ ] **Step 3: Verify**

Run:

```bash
cargo check -p <smoke-target> --target wasm32-unknown-unknown
```

Expected:

- success, or a precise blocker captured in the spike note

- [ ] **Step 4: Update the spike note with results**

Document:

- pass/fail
- exact command
- remaining blockers if any

- [ ] **Step 5: Commit**

Suggested commit:

```bash
git commit -m "build(candle): add wasm smoke target for shared embeddings"
```

### Phase 1 exit criteria

- [ ] A compile-only Candle text-model path exists for `wasm32-unknown-unknown`
- [ ] The spike note records exact blockers and fixes
- [ ] If compile still fails, the plan stops here and the spec must be revised before implementation continues

---

## Phase 2 — Shared candle dense embedder core

**Goal:** Build one Rust-owned dense embedder with explicit identity, usable by both native and browser hosts.

### Task 3: Create the shared embedder crate

**Files:**

- Create: `crates/xberg-candle-embed/Cargo.toml`
- Create: `crates/xberg-candle-embed/src/lib.rs`
- Modify: root `Cargo.toml` workspace members/dependencies as needed

**Produces:**

- a new crate with no host-specific coupling

- [ ] **Step 1: Scaffold the crate**

The crate should expose:

- model load
- embed documents
- embed query
- report dimensions
- report identity

- [ ] **Step 2: Keep boundaries clean**

The crate must not depend on:

- `xberg-rag`
- `xberg-wasm`
- `packages/wasm-pipeline`

- [ ] **Step 3: Verify**

Run:

```bash
cargo check -p xberg-candle-embed
```

- [ ] **Step 4: Commit**

Suggested commit:

```bash
git commit -m "feat(embed): scaffold shared candle dense embedder crate"
```

### Task 4: Define the shared embedder API

**Files:**

- Create: `crates/xberg-candle-embed/src/identity.rs`
- Create: `crates/xberg-candle-embed/src/embed.rs`
- Modify: `crates/xberg-candle-embed/src/lib.rs`

**Interfaces:**

- `EmbedderIdentity`
- query embedding API
- document embedding API
- stable dimension reporting API

**Produces:**

- explicit identity metadata, not inferred fields

- [ ] **Step 1: Define identity metadata**

Identity must include at minimum:

- model family/name
- quantization
- dimension
- revision/checksum-like identity

- [ ] **Step 2: Separate query and document embedding**

Do not force callers to encode query/document asymmetry themselves.

- [ ] **Step 3: Add unit tests**

Tests must assert:

- dimensions are stable
- identity is serializable/comparable if needed
- query/document APIs are distinct and typed

- [ ] **Step 4: Verify**

Run:

```bash
cargo test -p xberg-candle-embed
```

- [ ] **Step 5: Commit**

Suggested commit:

```bash
git commit -m "feat(embed): define shared candle embedder API and identity"
```

### Task 5: Implement model loading and parity harness

**Files:**

- Create: `crates/xberg-candle-embed/src/model.rs`
- Create: tests or fixtures for parity checking
- Modify: `crates/xberg-candle-embed/src/lib.rs`

**Produces:**

- model loading from local/pinned assets or bytes
- parity harness against a trusted reference path

- [ ] **Step 1: Implement model load path**

Support:

- native load path
- WASM-safe byte-based load path where needed

- [ ] **Step 2: Add a parity harness**

The harness must compare fixed inputs against a trusted reference output set.

- [ ] **Step 3: Fail closed**

Any mismatch in:

- output count
- vector dimension
- identity expectations

must be surfaced as an explicit error, not tolerated silently.

- [ ] **Step 4: Verify**

Run:

```bash
cargo test -p xberg-candle-embed parity
```

- [ ] **Step 5: Commit**

Suggested commit:

```bash
git commit -m "feat(embed): load shared candle model and add parity harness"
```

### Phase 2 exit criteria

- [ ] Native code can load the shared embedder and produce vectors
- [ ] The embedder reports one stable dimension and identity
- [ ] A parity harness exists and fails closed

---

## Phase 3 — Native cutover + snapshot identity migration

**Goal:** Move native RAG onto the shared backend and make stored indices self-describing.

### Task 6: Replace the native RAG embedder adapter

**Files:**

- Modify: `crates/xberg/src/rag_embed.rs`
- Modify: `crates/xberg/Cargo.toml`
- Modify: any CLI/MCP wiring that currently assumes the old default

**Consumes:**

- the new shared embedder crate
- current `RagEngine` adapter seam

**Produces:**

- native RAG running on the shared backend by default

- [ ] **Step 1: Construct the shared embedder from native host code**

- [ ] **Step 2: Route CLI `rag` commands through it**

- [ ] **Step 3: Route MCP `rag_query` through it**

- [ ] **Step 4: Preserve only minimal fallback behavior if necessary**

Any fallback must be explicit and temporary.

- [ ] **Step 5: Verify**

Run:

```bash
cargo check -p xberg -p xberg-cli
```

- [ ] **Step 6: Commit**

Suggested commit:

```bash
git commit -m "feat(xberg): switch native rag to shared candle embedder"
```

### Task 7: Extend `xberg-rag` snapshots with embedder identity

**Files:**

- Modify: `crates/xberg-rag/src/snapshot.rs`
- Modify: `crates/xberg-rag/src/engine.rs`
- Add tests in `crates/xberg-rag`

**Produces:**

- snapshot metadata with full embedder identity
- mismatch detection on open/load

- [ ] **Step 1: Extend snapshot metadata**

Replace the effective `dim`-only identification with:

- full identity
- backwards-compatible version bump

- [ ] **Step 2: Reject foreign identity safely**

Opening an incompatible snapshot must yield an actionable error.

- [ ] **Step 3: Add migration-aware tests**

Test:

- old snapshot version
- new snapshot version
- foreign identity mismatch

- [ ] **Step 4: Verify**

Run:

```bash
cargo test -p xberg-rag snapshot
```

- [ ] **Step 5: Commit**

Suggested commit:

```bash
git commit -m "feat(rag): add embedder identity to snapshots"
```

### Task 8: Add a native re-embed migration path

**Files:**

- Modify: `crates/xberg-rag/src/engine.rs`
- Modify: `crates/xberg-cli/src/commands/rag.rs`
- Modify: MCP/native surfaces only if an operator-facing migration command is needed there too

**Produces:**

- re-embed from persisted chunk text
- no re-extraction dependency

- [ ] **Step 1: Implement re-embed from stored chunk text**

- [ ] **Step 2: Expose an operator-facing path**

CLI is required; MCP exposure is optional and should be justified separately.

- [ ] **Step 3: Add tests**

Assert that:

- no source documents are required
- chunk text is sufficient
- migrated snapshots carry the new identity

- [ ] **Step 4: Verify**

Run:

```bash
cargo test -p xberg-rag migration
```

- [ ] **Step 5: Commit**

Suggested commit:

```bash
git commit -m "feat(rag): add re-embed migration for legacy matter stores"
```

### Phase 3 exit criteria

- [ ] Native RAG uses the shared backend by default
- [ ] Snapshots record embedder identity, not just dimension
- [ ] Existing stores can be migrated from chunk text alone

---

## Phase 4 — Browser/WASM cutover

**Goal:** Remove the browser’s separate TS/ORT embedding implementation and route browser RAG through the same Rust backend.

### Task 9: Expose the shared embedder through `xberg-wasm`

**Files:**

- Modify: `crates/xberg-wasm/src/lib.rs`
- Modify: relevant wasm-facing Rust modules
- Add tests if the crate already has the right test seams

**Produces:**

- wasm exports for:
  - load/warm embedder
  - embed query
  - embed chunk batch
  - inspect embedder identity

- [ ] **Step 1: Add wasm-bindgen exports**

- [ ] **Step 2: Keep the API byte-oriented and minimal**

- [ ] **Step 3: Verify**

Run:

```bash
cargo check -p xberg-wasm --target wasm32-unknown-unknown
```

- [ ] **Step 4: Commit**

Suggested commit:

```bash
git commit -m "feat(wasm): expose shared candle embedder through xberg-wasm"
```

### Task 10: Replace the TS embedding path in `packages/wasm-pipeline`

**Files:**

- Modify: `packages/wasm-pipeline/src/embed.ts`
- Modify: `packages/wasm-pipeline/src/rag.ts`
- Modify: any ingest/query orchestration files that call the old TS embedder

**Consumes:**

- new wasm exports from `xberg-wasm`

**Produces:**

- browser RAG vectors now sourced from the Rust backend

- [ ] **Step 1: Remove or deprecate `onnxruntime-web` embedding calls**

- [ ] **Step 2: Replace them with wasm bridge calls**

- [ ] **Step 3: Keep the browser-facing behavior stable**

Search and indexing semantics should not regress at the app layer.

- [ ] **Step 4: Add/update tests**

Test:

- query embedding path
- ingest-time chunk embedding path
- identity reporting if surfaced

- [ ] **Step 5: Verify**

Run:

```bash
pnpm --filter @xberg-io/wasm-pipeline test
```

If `pnpm` tooling is unavailable in the current environment, record the verification gap explicitly.

- [ ] **Step 6: Commit**

Suggested commit:

```bash
git commit -m "feat(wasm-pipeline): route browser embeddings through shared wasm backend"
```

### Task 11: Update warmup / model-loading UX

**Files:**

- Modify: `packages/wasm-pipeline` warmup/model loading code
- Modify: browser UI/store files if status text or progress behavior changes

**Produces:**

- warmup behavior aligned to the new Rust-owned model path

- [ ] **Step 1: Remove stale ORT-specific embedding assumptions**

Do not remove ORT assets or initialization required by browser GLiNER. Give the
embedding and NER models independent quantization and lifecycle configuration;
the current shared `scenario.quant` is invalid because the smallest artifact can
differ by model family.

- [ ] **Step 2: Keep warmup status and gating behavior correct**

- [ ] **Step 3: Update tests**

- [ ] **Step 4: Commit**

Suggested commit:

```bash
git commit -m "feat(web): align warmup flow to shared wasm embedding backend"
```

### Phase 4 exit criteria

- [ ] Browser and native RAG use the same backend/model identity
- [ ] Browser `onnxruntime-web` embedding path is removed or dead-code-eliminated
- [ ] Cross-host compatibility is restored by design, not convention

---

## Parallel or follow-up track — NER/PII safety

**Goal:** Make PII redaction defensible for EU legal documents without coupling
NER model selection to dense embedding identity or delaying the embedding
cutover.

### Current-state audit

- Browser PII uses
  [`onnx-community/gliner_small-v2.1`](https://huggingface.co/onnx-community/gliner_small-v2.1)
  through `gliner` + `onnxruntime-web`. Its
  [upstream model](https://huggingface.co/urchade/gliner_small-v2.1) is a
  166M-parameter, English-only, generic zero-shot NER model rather than a
  multilingual PII-specialized model.
- Browser labels are only `person`, `organization`, `location`, `email`,
  `phone`, `date`, `ssn`, and `financial`. `ssn` is US-centric and `financial`
  is too broad for EU legal redaction policy.
- Published browser artifacts are approximately 611 MB FP32, 306 MB FP16,
  183 MB INT8, 463 MB Q4, and 245 MB Q4F16. The current constrained-device
  scenario selects Q4, which is 280 MB larger than INT8.
- Browser ingest runs NER sequentially per chunk and has no deterministic
  pattern/validator fallback for email, phone, card, IBAN, SWIFT/BIC, or
  national identifiers. Mirrored PII spans retain chunk-local offsets without
  a chunk identifier, so equal offsets in different chunks can collide.
- The installed browser GLiNER tokenizer splits words with JavaScript `\w`,
  which is ASCII-only without Unicode mode. Accented and non-Latin words can
  fragment, and the fixed span-width limit amplifies the multilingual risk.
- The browser cache is URL-keyed without client-side artifact verification or
  model revision in the key. Its flat-NER decoder uses one hard-coded 0.5
  threshold, suppresses overlapping spans, and discards confidence.
- Chunk boundaries have no overlap strategy, while the UI path sometimes sends
  the whole document to NER. These paths can disagree and can respectively miss
  boundary entities or exceed model/runtime limits.
- Native and Node NER deliberately share checksum-identical, FP32,
  multilingual `gliner-community` v2.5 ONNX models packaged through
  `xberg-io/gliner-models`; the `balanced` default resolves to
  `gliner_medium-v2.5`. Browser is the divergent host.
- Native redaction is already hybrid: pure-Rust validated patterns cover email,
  phone, SSN, credit card, postal code, IP address, IBAN, and SWIFT/BIC, while
  optional NER adds contextual person, organization, and location spans.
- Native GLiNER retains confidence and uses Unicode-aware splitting and UTF-8
  byte offsets, while the browser exposes JavaScript UTF-16 offsets. Native also
  truncates after 512 words. Cross-runtime comparison therefore requires an
  explicit offset contract and overlapping long-input windows.
- Node ingest persists detected entity text in plaintext even though its mirror
  is tokenized. Treat database plaintext removal/migration as a release gate.
- The optional native LLM NER backend may send full document text to its
  configured provider. It must be separately opt-in, disclosed, and excluded
  from an on-device privacy guarantee.
- Neither browser nor native currently persists an explicit NER model identity.

### Candidate decision

Benchmark
[`fastino/gliner2-privacy-filter-PII-multi`](https://huggingface.co/fastino/gliner2-privacy-filter-PII-multi)
as the leading **quality candidate**, not as an approved browser default. It is
Apache-2.0, targets 42 PII types, and reports the strongest exact-span F1 and
recall among the compared systems on the SPY legal/medical benchmark. However,
it is a roughly 0.3B-parameter GLiNER2 model with a 1.23 GB FP32 checkpoint,
uses fully synthetic training data, covers only English, French, Spanish,
German, Italian, Portuguese, and Dutch, has modest reported precision, and has
no production-ready browser artifact in this repository.

Upstream Xberg at pinned revision
`b06fbc71cc5f2a5aed425b56dba105122f7cd4c2` now provides a materially better
starting point:

- `xberg-gliner` contains a full GLiNER2 Candle implementation, including the
  encoder, count predictor, recurrent count head, span scorer, tokenizer, and
  decoder.
- `Gliner2Candle::from_local` supports native model directories and
  `Gliner2Candle::from_bytes` supports the browser-relevant byte-loading path.
- Native inference uses F32 while WASM converts the same F32 safetensors to F16,
  so the implementations share model semantics but are not bit-identical.
- The implementation is not yet reachable through `NerBackendKind`,
  extraction/redaction dispatch, `xberg-node`, or the published
  `xberg-wasm` API. The WASM engine remains an injected-JavaScript bridge, and
  Hacienda MCP still uses `gliner@0.0.19` with `onnxruntime-web`.
- The streaming safetensors loader reduces transient tensor duplication but
  still requires the complete 1.23 GB source buffer while building roughly
  614 MB of F16 weights. This is an unresolved browser memory, download, cache,
  and startup risk.
- The current Candle pipeline truncates at the encoder position limit, uses a
  fixed 0.5 threshold in the Xberg backend, serializes inference through a
  mutex, and has no real-model browser test.

The production direction is therefore:

1. Port the native validated pattern layer to a shared Rust/WASM-safe API first.
2. Adopt `xberg-gliner` Candle as the shared contextual-NER implementation,
   compiled natively for MCP and to WASM for the browser. Do not require the
   server to execute the browser WASM binary.
3. Keep contextual NER as a second detector with per-label thresholds.
4. Evaluate current GLiNER v2.5, GLiNER2-PII, and any compact multilingual
   candidate on the same EU legal suite before replacing either host model.
5. Keep legal entity extraction (court, judge, statute, case number, party,
   counsel) separate from privacy redaction policy; not every legal entity is
   PII or should be masked.
6. Consider a Granite-based PII head only as a later research spike. Sharing an
   encoder could reduce combined browser assets, but no compatible trained head,
   quality evidence, or Candle implementation exists yet.

### Task N0: Wire the imported Xberg GLiNER2 core

**Imported upstream foundation:**

- `crates/xberg-gliner/src/candle/`
- `crates/xberg-gliner/src/v2/`
- `crates/xberg/src/text/ner/candle.rs`
- `crates/xberg-gliner/tests/candle_smoke.rs`
- `crates/xberg-gliner/tests/candle_wasm_ner.rs`

The scoped port uses upstream commits `ea06025c6`, `92318ab54`,
`ccedc1f26`, `5eee4302a`, `907f1e835`, `c0bea600c`, `b55cf948b`,
`a4b301438`, and `9c80faf8d`, plus the GLiNER formatting pass
`cf064a798`. A full upstream merge is explicitly rejected: Hacienda and
upstream have diverged by 113 and 647 commits respectively from merge base
`2ca755300`.

- [ ] Add a `Candle` variant and explicit artifact/configuration fields to
  `NerBackendKind`/`NerConfig`; include threshold policy, immutable model
  revision, checksums, supported languages, and optional adapter identity.
- [ ] Route Candle through both extraction post-processing and redaction.
- [ ] Replace native `block_in_place` plus one model mutex with a bounded
  inference worker/queue suitable for concurrent MCP requests.
- [ ] Add deterministic overlapping windows below the backend, remapping all
  results to canonical UTF-8 byte offsets and de-duplicating overlap spans.
- [ ] Expose native GLiNER2 through the canonical Rust API and Alef-generated
  Node binding. Do not edit `crates/xberg-node` or `packages/*` manually.
- [ ] Expose a stateful browser model handle through `xberg-wasm`, loading
  verified model/tokenizer/config bytes and running inference inside a Web
  Worker. Integrate it with extraction/redaction, not only a standalone
  `engine.ner()` call.
- [ ] Add a browser-specific F16 or quantized artifact. Do not make the raw
  1.23 GB F32 checkpoint the default browser download without measured
  memory/startup evidence and storage-quota preflight.
- [ ] Keep the current JS/ORT path only as a migration fallback until native,
  WASM, and hybrid-pattern parity gates pass.

### Investigation resolution — pending work and chosen solution (2026-07-23)

The imported core is buildable; the remaining work is integration and lifecycle.
Do not begin the cutover until these decisions are treated as prerequisites:

| Pending item | Finding | Resolution |
| --- | --- | --- |
| Backend selection | `NerBackendKind` and both dispatchers only match `Onnx`/`Llm`; `CandleBackend` is unreachable. | Add an opt-in `Candle` backend and route it through NER post-processing and redaction. Keep it out of broad `full`/`wasm-target` aggregates. |
| Configuration | `NerConfig.model` is a single ONNX identifier and cannot represent three browser files or bytes. | Keep `ExtractionConfig` metadata-only: backend, model revision, threshold policy, and labels. Resolve paths/bytes in a host-owned session façade. Never put model bytes in serialized extraction config. |
| Native MCP | Hacienda MCP is TypeScript and currently calls legacy `gliner@0.0.19`. | Add a native Xberg/Candle text-NER façade callable by the generated Node binding, backed by `ModelCache` paths and a bounded inference queue. Preserve the old JS path only as fallback during rollout. |
| Browser WASM | Published `xberg-wasm` has no Candle feature, model handle, Worker, or `from_bytes` export. | Add a hand-written `Gliner2WorkerModel` WASM module through Alef `custom_rust_modules`; expose `loadBytes`/`extractNer`; run it in a dedicated Worker. Regenerate the package instead of editing generated `lib.rs`/Cargo files. |
| Bindings | Adding `Candle` changes generated enums and converters across Node/WASM/FFI. | Update Rust/Alef inputs first, run Alef generation, then run binding freshness and downstream smoke tests. Do not hand-edit generated packages. |
| Artifact lifecycle | Node verifies SHA256; browser cache is URL-only and unverified. | Define one manifest for weights/tokenizer/config with revision, precision, byte length, SHA256, license, and supported languages. Node uses atomic disk cache; browser verifies WebCrypto digests and stores immutable OPFS/Cache Storage generations with quota/LRU handling. |
| Package versions | Local `packages/wasm-pipeline` consumes `@xberg-io/xberg-wasm` rc.26 while the generated crate/package is rc.29. | Align the workspace package version and lockfile during the Alef regeneration step before testing the new WASM API. |
| Browser size | Raw F32 is ~1.23 GB; WASM converts it to ~614 MB F16 and copies can double peak usage. | Generate a pinned F16 browser artifact first. Treat it as opt-in until real Worker memory/startup tests pass; quantization is a later optimization, not a prerequisite assumption. |
| Long input | Candle truncates at encoder positions and the backend threshold is fixed at 0.5. | Add host-level overlapping token/word windows, global UTF-8 byte offsets, deterministic overlap de-duplication, and per-label thresholds before cutover. |
| Concurrency/errors | Native Candle serializes through a mutex and may expose model paths in errors. | Use a bounded native worker queue, one model singleton per artifact identity, and sanitized public errors. |

The rejected shortcut is running the browser WASM binary inside MCP: it would
share code but impose browser F16 memory and CPU constraints on the server. The
accepted definition of “same engine” is the same Rust GLiNER2 implementation,
preprocessing, decoding, artifact identity, labels, offsets, and conformance
fixtures, with native F32 and browser F16 host artifacts.

### Prerequisite spikes before implementation

- [ ] Add a tiny synthetic Candle model fixture to prove the proposed native
  façade and generated Node binding without downloading the real checkpoint.
- [ ] Add a tiny WASM custom-module fixture to prove `loadBytes`/`extractNer`
  and Worker message ownership before wiring the 614 MB artifact.
- [ ] Produce and checksum the F16 browser artifact; measure peak JS/WASM
  memory with transfer copies, OPFS/cache persistence, initialization time, and
  Worker responsiveness on the lowest supported browser profile.
- [ ] Prove native/WASM span parity on shared Unicode, custom-label, and
  overlapping-window fixtures before switching the MCP or browser default.

### Task N1: Correct browser PII safety defects

**Files:**

- Modify: `packages/wasm-pipeline/src/scenario.ts`
- Modify: `packages/wasm-pipeline/src/ner.ts`
- Modify: browser ingest and mirror-span persistence
- Reuse or expose: `crates/xberg/src/text/redaction/patterns/`

- [ ] Split embedding and NER artifact selection; pin current browser GLiNER to
  INT8 rather than the larger Q4 artifact while it remains in service.
- [ ] Add shared deterministic detectors and validators for structured PII,
  with EU-first coverage for IBAN, SWIFT/BIC, payment cards, phones, email,
  postal codes, IP addresses, and configurable national/tax identifiers.
- [ ] Batch contextual NER over chunks, retain confidence, and calibrate
  per-label thresholds. Use overlapping NER windows with deterministic
  de-duplication and global byte offsets.
- [ ] Persist `chunk_index` plus byte-offset semantics for every mirrored span;
  define one canonical offset contract and test duplicate local offsets across
  chunks, accents, non-Latin scripts, and astral Unicode characters.
- [ ] Replace the ASCII-only browser word splitter or runtime, verify the
  detector's source substring against every returned span, and define an
  explicit confidence/coverage-based overlap policy.
- [ ] Version browser cache keys by model revision and verify model/tokenizer
  checksums before initialization; never retain a rejected/corrupt artifact.
- [ ] Define a separate `NerIdentity` only where audit/persistence requires it.
  Do not place NER fields in `EmbedderIdentity` or vector snapshot compatibility.
- [ ] Stop persisting raw detected entity text in the Node database, migrate or
  invalidate affected records safely, and keep the LLM NER provider path
  explicitly opt-in with data-egress disclosure.

### Task N2: Build the multilingual legal PII evaluation gate

- [ ] Define a client-reviewed redaction taxonomy and false-negative budget.
- [ ] Create or license representative, de-identified legal fixtures across the
  supported client languages; include every official EU language claimed by
  the selected model.
- [ ] Measure exact-span precision, recall, F1, leakage rate after redaction,
  overlap handling, offset correctness, throughput, peak memory, and artifact
  size per language and document category.
- [ ] Test entity spans crossing windows/chunks, Unicode offsets, nested and
  overlapping candidates, malformed model spans, cache corruption, model-load
  failure, token collision, and vault tampering.
- [ ] Compare hybrid patterns + current GLiNER, patterns + GLiNER v2.5, and
  patterns + GLiNER2-PII. Report macro averages and worst-language results, not
  only aggregate scores.
- [ ] Require a browser runtime/export spike and pinned checksums before any
  GLiNER2 deployment decision.
- [ ] Run the real GLiNER2 model in a browser Worker and record cold download,
  initialization time, steady-state latency, peak WASM/JS memory, cache quota,
  cancellation, and recovery from OOM/corrupt bytes.
- [ ] Add native-versus-WASM golden fixtures with tolerance-based confidence
  comparison because native F32 and browser F16 are not bit-identical.
- [ ] Fail closed for high-confidence structured PII and surface uncertain
  contextual findings for review rather than claiming automatic GDPR
  compliance.

### NER/PII exit criteria

- [ ] Browser structured PII detection no longer depends on an English-only NER
  model
- [ ] Browser and native use the same redaction taxonomy and validated pattern
  behavior, even if contextual NER backends temporarily differ
- [ ] Contextual NER selection is supported by per-language legal evaluation
- [ ] NER identity is independently auditable and cannot invalidate vector
  snapshots

---

## Parallel or follow-up track — BM25 lexical hybrid

**Goal:** Improve legal exact-match retrieval independently of the dense embedding migration.

### Task 12: Add a pure-Rust lexical scorer

**Files:**

- likely `crates/xberg-rag` or adjacent retrieval crate/module

**Produces:**

- BM25 or equivalent lexical retrieval
- RRF or explicit fusion with dense scores

- [ ] **Step 1: Choose the lexical scorer location**

- [ ] **Step 2: Implement scoring over persisted chunk text**

- [ ] **Step 3: Add fusion with dense retrieval**

- [ ] **Step 4: Add tests on legal/exact-match cases**

- [ ] **Step 5: Commit**

Suggested commit:

```bash
git commit -m "feat(rag): add lexical hybrid scoring for legal retrieval"
```

### Parallel track exit criteria

- [ ] Exact-match retrieval improves independently of dense migration
- [ ] The lexical scorer composes with the shared backend rather than replacing it

---

## Required verification matrix

These checks are mandatory before the work is considered complete.

- [ ] `cargo check -p xberg-candle-embed`
- [ ] `cargo test -p xberg-candle-embed`
- [ ] `cargo check -p xberg-rag -p xberg -p xberg-cli`
- [ ] `cargo test -p xberg-rag`
- [ ] `cargo check -p xberg-wasm --target wasm32-unknown-unknown`
- [ ] compile or test evidence for the browser integration path after the TS cutover
- [ ] model artifact revision/checksum and browser payload report for Granite
  INT8 plus tokenizer
- [ ] fixed-fixture native/browser cosine-similarity and top-k parity report
- [ ] multilingual legal retrieval report with per-language results and
  dense-only versus dense + BM25 comparison
- [ ] snapshot migration tests covering:
  - old dim-only snapshot
  - new identity snapshot
  - foreign-identity rejection
  - successful re-embed migration
- [ ] NER/PII follow-up report covering:
  - structured-pattern parity between native and browser
  - exact-span and leakage metrics by language and PII type
  - Unicode/global-offset and cross-chunk behavior
  - model/tokenizer checksum and `NerIdentity`
  - browser artifact size, peak memory, and latency
  - native MCP concurrency and queue saturation behavior
  - real-model WASM execution rather than invalid-input-only coverage

## Recommended commit slicing

1. `docs(rag): add candle wasm spike note and shared embedding implementation plan`
2. `build(candle): add wasm smoke target for shared embeddings`
3. `feat(embed): scaffold shared candle dense embedder crate`
4. `feat(embed): define shared candle embedder API and identity`
5. `feat(embed): load shared candle model and add parity harness`
6. `feat(xberg): switch native rag to shared candle embedder`
7. `feat(rag): add embedder identity to snapshots`
8. `feat(rag): add re-embed migration for legacy matter stores`
9. `feat(wasm): expose shared candle embedder through xberg-wasm`
10. `feat(wasm-pipeline): route browser embeddings through shared wasm backend`
11. `feat(web): align warmup flow to shared wasm embedding backend`
12. `feat(rag): add lexical hybrid scoring for legal retrieval`

## Open questions before coding starts

- [ ] Does Granite 97M INT8 meet the agreed browser payload, memory, latency,
  legal retrieval, Irish, and Maltese gates?
- [ ] Does the shared embedder deserve its own crate, or is there a strong reason to colocate it with existing Candle code?
- [ ] Should browser-generated legacy stores auto-migrate, or fail closed and require explicit rebuild?
- [ ] Which client languages and legal document classes define the NER/PII
  release gate, and what is the maximum allowed false-negative rate per class?
- [ ] Can a preconverted F16 or quantized GLiNER2-PII artifact run within the
  browser budget? The raw upstream safetensors byte path is implemented but is
  not an acceptable default until the payload/memory gate passes.
- [ ] Is BM25 in the same milestone, or tracked as a separate issue after the dense migration?

## Stop conditions

Stop and re-scope if any of the following occur:

- Candle text-model code still cannot compile for `wasm32-unknown-unknown`
- the selected model’s WASM payload or CPU latency is unacceptable for the browser host
- real-model initialization cannot stay below the agreed browser memory and
  storage-quota budgets
- parity against a trusted reference path is not defensible
- snapshot identity cannot distinguish old/new backends safely
- any release path treats current English-only browser GLiNER as an EU PII
  compliance boundary without the hybrid detector and multilingual legal gates
