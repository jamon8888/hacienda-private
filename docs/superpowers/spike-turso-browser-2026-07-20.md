# B-Gate Spike Result — Turso in-browser (2026-07-20, FINAL)

**Verdict: B-GATE PARTIAL FAIL (authoritative).** The Turso browser-wasm engine
(`@tursodatabase/database-wasm@0.7.0`) runs in-browser and supports **exact** vector
similarity. But the **index-method** features the plan's B-gate requires — Tantivy **FTS**
and **vector ANN indexing** — are **physically absent from the wasm build**, confirmed both
by runtime test and by Turso's own source.

## Runtime matrix (real headless-Chromium run, `experimental: ["index_method"]` passed)
| Capability | Browser wasm @0.7.0 | Evidence |
| --- | --- | --- |
| Connect `:memory:` / OPFS | ✅ | engine inits, SQL runs |
| `F32_BLOB` + `vector32()` | ✅ | works |
| Exact `vector_distance_cos/l2` (linear scan) | ✅ | `vectorExact: true` |
| `experimental: ["index_method"]` accepted | ✅ | gate passes (no more "enable flag" error) |
| **`USING fts` (Tantivy FTS)** | ❌ | `unknown module name 'fts'` |
| **`libsql_vector_idx` + `vector_top_k` (ANN)** | ❌ | `invalid expression in CREATE INDEX: libsql_vector_idx` |
| Bundle | ✅ 10.5 MB wasm / 14.5 MB inlined | < 50 MB jsDelivr limit |

## Authoritative source confirmation (turso main, 2026-07-20)
- `core/index_method/mod.rs:15`:
  ```rust
  #[cfg(all(feature = "fts", not(target_family = "wasm")))]
  pub mod fts;
  ```
  → The FTS (Tantivy) index-method module is **compile-excluded for `target_family = "wasm"`**.
  Tantivy (0.26.0) does not support wasm, so it cannot be linked into the wasm32 build.
- `core/translate/index.rs:62-66`: index methods require
  `connection.experimental_index_method_enabled()` (set via JS `connect(opts)` →
  `opts.experimental: ["index_method"]`, see `bindings/javascript/src/lib.rs:179-266`).
  The flag is accepted by the wasm binding, but the FTS/vector *modules* are not compiled in,
  so it yields `unknown module name 'fts'` / `invalid expression`.
- Vector index methods (`toy_vector_sparse_ivf`, `libsql_vector_idx`) are likewise not
  available in the wasm build (runtime rejected; only the scalar `vector_distance_*` functions
  survive, because they are plain SQL functions, not index methods).

**Conclusion:** Tantivy FTS is NOT available in the Turso browser-wasm build, full stop —
not a flag, not a version wait, but a `target_family = "wasm"` compile gate. Vector *search*
works only via exact linear scan (`vector_distance_cos`); vector *ANN indexing* is also absent.

## Implications for the plan
1. **Browser**: cannot use Turso FTS. Options for the text leg:
   - SQLite `LIKE`/`GLOB` keyword search over `chunks.text` (simplest, works in wasm), or
   - a small JS inverted-index/tokenizer (e.g. minisearch/flexsearch) kept alongside Turso.
   Vector leg = exact `vector_distance_cos` linear scan (fine for our chunk counts).
2. **Node MCP server**: native `@tursodatabase/database` (Node NAPI) **does** compile with
   `feature = "fts"` (no wasm gate) → full Tantivy FTS + (where available) vector indexing.
   So Node gets the rich hybrid; browser gets the degraded hybrid.
3. `SearchStore` must be **capability-probed** at runtime, not assumed Turso-everywhere.

## Harness
- Package: `@tursodatabase/database-wasm` (`/bundle` self-contained ESM).
- Must serve with COOP/COEP (`require-corp` / `same-origin`) for SharedArrayBuffer.
- Real browser required (Playwright chromium). Files: `src/search/spike.html` +
  `src/search/spike.browser.mjs`.
- Run: `cd packages/wasm-pipeline && node src/search/spike.browser.mjs`
- API is better-sqlite3-style async: `db.prepare(sql).all(...args)` / `.run(...)` / `.get(...)`
  (there is NO `db.select`).

## Decision required
- **(A) Degraded hybrid (recommended):** exact vector (linear scan) + keyword/JS text leg in
  browser; full FTS + ANN on Node. Keeps all pipeline perf wins (single Turso store, no
  EdgeVec/localStorage rebuild, hybrid query shape).
- **(B) Hold** — not viable, since FTS is hard-gated out of wasm by upstream; waiting won't help
  unless Turso ports Tantivy to wasm (no signal of that).

Recommended: **(A)**.
