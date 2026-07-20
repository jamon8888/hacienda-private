# B-Gate Spike Result — Turso in-browser (2026-07-20, CORRECTED)

**Verdict: B-GATE PARTIAL FAIL.** The Turso browser-wasm engine (`@tursodatabase/database-wasm@0.7.0`)
DOES run in-browser (OPFS + worker + SharedArrayBuffer, via napi-rs wasm32-wasip1-threads).
But the two **index-method** features the plan's B-gate requires are NOT available in the
published wasm build:

| Capability | In browser wasm @0.7.0? | Evidence (real headless-Chromium run) |
| --- | --- | --- |
| Connect `:memory:` / OPFS file | ✅ Yes | engine initialized, SQL executes |
| `F32_BLOB` + `vector32()` | ✅ Yes | works |
| Exact `vector_distance_cos/l2` (linear scan) | ✅ Yes | `vectorExact: true` |
| **`libsql_vector_idx` + `vector_top_k` (ANN index)** | ❌ No | `Parse error: invalid expression in CREATE INDEX: libsql_vector_idx` |
| **`USING fts` (Tantivy FTS) + `fts_match`/`fts_score`** | ❌ No | `index method is an experimental feature. Enable with --experimental-index-method flag` |
| Bundle size | ✅ 10.5 MB wasm / 14.5 MB inlined | under 50 MB jsDelivr limit ✅ |

## Why the earlier "FAIL" was wrong
- First subagent tested `@libsql/client` (legacy remote-only web build) — wrong package.
- `@tursodatabase/database@0.7.0` is the Node NAPI build (no browser). The **browser** package
  is `@tursodatabase/database-wasm@0.7.0` (announced 2025-10-08, blog:
  turso.tech/blog/introducing-turso-in-the-browser). That is the real B-gate target.
- The plan's `db.select(...)` API does not exist in this build — correct API is
  `db.prepare(sql).all(...args)` / `.run(...)` / `.get(...)` (better-sqlite3-style, async).

## What actually works → viable degraded design
- **Vector search works**, but only via **exact `vector_distance_cos` linear scan** (no ANN
  index). For the on-device chunk counts this pipeline handles (hundreds–low-thousands of
  chunks per matter), linear scan is acceptable and fast. RRF hybrid still works: vector leg
  = `ORDER BY vector_distance_cos(...) LIMIT k`; text leg = keyword match (SQLite `LIKE`/`GLOB`
  or a JS tokenizer) since FTS is unavailable.
- **FTS is unavailable** in wasm. Replace the FTS leg with a lightweight in-browser keyword
  search (SQLite `LIKE` over `chunks.text`, possibly with a simple inverted index in JS) until
  Turso ships `--experimental-index-method` in the wasm build.

## Browser harness requirements (for re-runs)
- Package: `@tursodatabase/database-wasm` (default or `/bundle` export).
- Must serve page with COOP/COEP headers:
  `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Opener-Policy: same-origin`
  (SharedArrayBuffer needs them).
- Real browser required (Playwright chromium). Plain Node vitest cannot load the wasm worker.
- Harness files: `src/search/spike.html` + `src/search/spike.browser.mjs` (Playwright runner
  serving the `/bundle` self-contained ESM with COOP/COEP).
- Run: `cd packages/wasm-pipeline && node src/search/spike.browser.mjs`

## Decision required
The literal B-gate (ANN index + FTS) FAILS. Two options:
- **(A) Accept degraded hybrid**: exact vector (linear scan) + JS/SQLite keyword leg in browser;
  full ANN+FTS on the Node MCP server (native `@tursodatabase/database` supports it). Keep
  `SearchStore` capability-probed: browser = exact-vector + keyword; Node = ANN + FTS.
- **(B) Hold** until `@tursodatabase/database-wasm` enables `--experimental-index-method`.

Recommended: **(A)** — delivers the perf wins (single Turso store, no EdgeVec/localStorage
rebuild, hybrid query) with a browser keyword leg instead of FTS, and full FTS/ANN on Node.

## Re-test trigger (for full B-gate PASS)
Re-run when `@tursodatabase/database-wasm` publishes a build where
`CREATE INDEX ... libsql_vector_idx(...)` and `CREATE INDEX ... USING fts (...)` succeed in
the browser (i.e. `--experimental-index-method` compiled in).
