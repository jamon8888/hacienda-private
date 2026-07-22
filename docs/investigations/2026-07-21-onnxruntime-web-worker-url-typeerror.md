# Investigation: `e.replace is not a function` on browser ingest (onnxruntime-web + webpack)

**Date:** 2026-07-21
**Status:** onnxruntime crash **FIXED & VERIFIED** via `parser: { url: false }` (probe #3).
A **separate, newly-surfaced** downstream blocker remains at the GLiNER PII stage (see
"Downstream blocker" section) — the onnxruntime fix is correct and self-contained regardless.
**Branch:** `fix/onnxruntime-embed-typeerror` (fix applied to `next.config.mjs`, not yet committed;
a temporary `DEBUG_STACK_V3` console.error in FolderView.tsx must be reverted before commit).

## FIX (verified)

`parser: { url: false }` on the onnxruntime `.mjs` webpack rule in `apps/web/next.config.mjs`.
Verified end-to-end in-browser: the ingest console now logs the full onnxruntime path
succeeding — `ort imported, numThreads=1` → `model fetch status 200` → `model bytes 278184162
EPs ["wasm"]` → **`session created`** → embedding inference completes (upload stage advances
to `embed`, which the adapter emits only AFTER `embedChunks()` returns). Deminified chunk has
0 `.U(` call sites (was `new r.U(r(<ortModuleId>))` before). The `e.replace is not a function`
crash is gone.

## Downstream blocker (SEPARATE bug, newly surfaced — not the onnxruntime crash)

With the onnxruntime crash fixed, ingestion now reaches the GLiNER PII-detection stage
(`packages/wasm-pipeline/src/ner.ts` `detectPii` → `getModel` → gliner `model.initialize()` /
`inference()`). The document then errors with:

```
failed to load external data file: http://127.0.0.1:8799/models/gliner-pii.int8.onnx
```

Notes / caveats for the next session:
- This is an ONNX "external data" (weights stored separately from the graph) loading failure
  in GLiNER's own onnxruntime-web (gliner depends on `onnxruntime-web@1.19.2`, a different copy
  than embed's 1.27.0). GLiNER's tokenizer JSONs load fine (200 OK); the model GET is the issue.
- **The observation was contaminated**: while diagnosing, a manual `curl` for the same 183MB
  model competed for the mcp-server's SINGLE Node event loop. The server serves models with
  **synchronous, event-loop-blocking** `readFileSync(<wholeModel>)` (`serveFile`, index.ts:134)
  AND re-computes `sha256File(<wholeModel>)` on EVERY request (`ensureModel`, models.ts:75).
  Under concurrent large-model requests these serialize and can look like a multi-minute hang
  (an isolated authed curl for the 183MB model returns 200 in ~0.9s; sha256 of it is ~1.4s).
  So the "failed to load external data file" error may be a transient fetch failure caused by
  event-loop starvation during the probe — OR a genuine external-data wiring issue. **Re-run a
  CLEAN Playwright e2e with zero concurrent probing to disambiguate before investigating deeper.**
- Two latent perf/robustness issues in the model server worth fixing regardless (separate PR):
  (a) `serveFile` should stream (`createReadStream().pipe(res)`), not `readFileSync` a whole
  multi-hundred-MB model into memory and block the loop; (b) `ensureModel` re-hashes the entire
  cached model on every request — cache/skip when the file mtime+size are unchanged.

### Clean-run confirmation (uncontaminated) + external-data specifics

A CLEAN Playwright e2e (no concurrent probing from the investigator) STILL fails at the GLiNER
stage — the document sits at "Processing…" for the full 5-minute timeout (never reaches
"X PII entities"). So the GLiNER blocker is **real, not event-loop contention**. (In a
longer-lived manual browser tab the same stage instead surfaced the explicit
`failed to load external data file: …/gliner-pii.int8.onnx` error; hang vs error is a timing
difference — both are the same GLiNER-stage failure.)

**UPDATE (2026-07-22): the "missing external-data file" hypothesis is DISPROVEN.**
- `gliner-pii.int8.onnx` is a full 183MB **self-contained** model with embedded weights, and its
  SHA256 **matches the manifest** (`c76c9092…​cb061400`) — intact, not corrupt. A full-file scan
  finds **zero** `external_data` / `onnx_data` / `data_location` / `location` markers. There is no
  missing companion `.onnx_data` file to add — that theory is wrong.
- The `failed to load external data file: …/gliner-pii.int8.onnx` message (seen only in a
  contaminated manual tab) is therefore NOT a genuinely-missing-file error; it is most likely a
  downstream symptom of the model fetch failing/aborting while the mcp-server's single event loop
  was starved (blocking `readFileSync` of huge models — see perf notes above), or an ort-web
  mis-report. Do not chase a manifest/companion-file fix.
- **The clean e2e used a DIFFERENT quant tier than the manual test**, which muddied everything:
  headless Playwright chromium reports different `detectCapabilities()`, so `selectScenario()`
  picked **int4** — `e5.int4.onnx` is **823 MB** (vs int8's 278 MB), and gliner-pii.int4 is 463 MB.
  The clean run's last progress log was `e5 session created` (embed's DEBUG2), then it hung for the
  full 5-min timeout. `packages/wasm-pipeline/src/ner.ts` has NO progress logging, so the exact hang
  point (embed inference on the 823MB int4 model vs GLiNER download/session/inference) is unknown.
- **Revised assessment: the downstream blocker is deeper than a quick fix and needs its own
  investigation.** Next concrete steps (a future session): (1) add DEBUG logging in `ner.ts`
  (`getModel` before/after `model.initialize()`; `detectPii` before/after `model.inference()`) and
  in `adapter.ts` around the detectPii loop, to pin the exact hang stage; (2) force a single known
  quant (int8) in the e2e to remove the int4-vs-int8 variable; (3) time GLiNER `initialize()` and
  `inference()` in isolation on int8; (4) independently, fix the mcp-server model server to STREAM
  (`createReadStream().pipe(res)`) instead of `readFileSync`-ing 300–800MB models and blocking the
  loop, and to skip the per-request full-model re-hash — this alone may resolve or greatly mitigate
  a "hang" that is actually event-loop starvation while serving giant models. These are all distinct
  from the onnxruntime-web worker-URL crash fixed above.

Original (pre-disproof) external-data notes, kept for the record:
- `services/mcp-server/models/manifest.json` maps `gliner-pii-int8` → a SINGLE file
  `gliner-pii.int8.onnx` (HF `onnx-community/gliner_small-v2.1/onnx/model_int8.onnx`, 183MB).
  There is **no sibling `.onnx_data` external-weights file** in the manifest or the model cache
  (`/Volumes/xbergtmp/xberg-e2e-model-cache/` has only `gliner-pii.int8.onnx` + a
  `gliner-pii/` dir with `tokenizer.json`/`tokenizer_config.json`).
- Yet onnxruntime-web reports it "failed to load external data file: …/gliner-pii.int8.onnx"
  — i.e. the model GRAPH declares external-data tensors (weights stored out-of-graph via a
  `location` reference), but no external-weights file is provisioned/served, so ort-web's
  attempt to resolve them fails. gliner is configured in `ner.ts` via
  `IONNXWebSettings.modelPath = glinerModelUrl(quant)` with no `externalData` session option.
- Directions for the next session (do NOT assume — verify): (1) inspect the actual
  `model_int8.onnx` protobuf for `external_data`/`location` tensor entries; the HF repo may
  ship a companion weights file (e.g. `model_int8.onnx_data`) that the manifest doesn't
  download/serve, or the int8 export may expect embedded weights and this specific artifact is
  mis-exported; (2) if a companion weights file exists upstream, add it to `manifest.json` +
  serve it alongside so ort-web's relative `location` fetch resolves; (3) or pass ort-web's
  `session.externalData` / `externalDataFilePaths` option in gliner's `IONNXWebSettings`; (4)
  cross-check whether the fp32 or int4 gliner variants are self-contained (a variant swap in
  `scenario.ts` may sidestep it). This is a distinct bug from the onnxruntime-web worker-URL
  crash fixed above and out of scope for that fix.


## Symptom

Every browser document ingest fails. The UI shows a generic "Failed to ingest"; the
document row's `error_message` is:

```
e.replace is not a function
```

The failure is **pre-existing on `main`** (confirmed earlier by a clean stash/rebuild
comparison, unrelated to the two CodeRabbit-findings PRs #24/#25 or the extract-input
PR that fixed the *earlier* `extract input kind 'uri'` error). It surfaces one stage
later than that extract bug: during **embedding**, at the first
`await import("onnxruntime-web/wasm")` in `packages/wasm-pipeline/src/embed.ts`
(`getSession()`).

## Reproduction

The Playwright e2e (`apps/web/e2e/critical-path.spec.ts`) hits it, but the UI swallows
the real error. To see it directly:

1. exFAT env setup (see repo conventions): `TMPDIR=/Volumes/xbergtmp/`, `apps/web/.next`
   and `apps/web/out` are symlinks onto the APFS volume, purge `._*` files before builds.
2. `cd apps/web && TMPDIR=/Volumes/xbergtmp/ pnpm run build`
3. Start the e2e server: `TMPDIR=/Volumes/xbergtmp/ ../../node_modules/.bin/tsx e2e/start-server.mjs`
   (serves the static `out/` on `http://127.0.0.1:8799`).
4. In a browser: seed a matter+folder via the `/api/*` endpoints, set
   `sessionStorage["xberg.localAuth"]` with `window.__XBERG_TOKEN__` + a passphrase,
   navigate to the folder, and dispatch a synthetic `File` `change` event on the
   `input[type=file]`. Ingest runs the real pipeline.
5. Temporarily add `console.error("DEBUG_STACK", err instanceof Error ? err.stack : String(err))`
   in `apps/web/app/folders/[id]/FolderView.tsx`'s upload `catch` block, rebuild, and read
   the browser console — the UI's `catch` swallows the stack otherwise (the thrown value
   is a plain `TypeError`, message-only in the UI).

**Use a fresh browser tab per test.** Next.js chunks are served with immutable cache
headers; a reused tab keeps serving an old chunk hash and the browser console retains
history across same-tab navigations — both produced misleading "unchanged" readings
during this investigation. A brand-new tab (or `navigate` with `force: true`) is required
to load a fresh build.

## Root cause

The crash originates in webpack's own runtime URL shim, `__webpack_require__.U` (minified
`i.U` / `n.U`), whose first statement is:

```js
i.U = function(e){ var c = new URL(e,"x:/"), a={}; ...; a.pathname = e.replace(/[?#].*/,""); ... }
```

`e.replace` throws because `e` is **not a string**. In the built onnxruntime-web chunk,
the call site (deminified) is:

```js
ew = new URL(new n.U(n(34468)).href, eg).href;   // n(34468) === __webpack_require__(<ort module id>)
```

i.e. webpack passes the **onnxruntime-web module object** (the result of requiring module
`34468`) into its URL shim. onnxruntime-web's browser bundles spawn their own emscripten
pthread/proxy worker with the pattern:

```js
new Worker(new URL(/* the ort module's own asset */, import.meta.url), { type: "module" })
```

Webpack 5 has **built-in support** for `new Worker(new URL('...', import.meta.url))`: it
detects that expression, emits the target as a separate worker chunk, and rewrites the
`new URL(...)` into a reference to that chunk. For onnxruntime's *self-referencing* worker
(the module IS its own worker), webpack's rewrite resolves the asset to
`new n.U(n(<moduleId>))` — handing the required **module export object**, not a URL string,
to the `.U` shim. Hence `e.replace is not a function`, thrown **unconditionally at module
import time** — it does not depend on `numThreads` (the real pipeline already hardcodes
`numThreads: 1` in `packages/wasm-pipeline/src/scenario.ts`, and it still crashes).

### Why "just pick a different ort variant" does NOT fix it

Probe #1 (reverted): added `"onnxruntime-web-use-extern-wasm"` to
`config.resolve.conditionNames` in `apps/web/next.config.mjs`, steering the `./wasm`
export from `ort.wasm.bundle.min.mjs` to `ort.wasm.min.mjs`.

Result: the resolved chunk changed (verified: new chunk hash `4468...`, different from the
old `4911...`), but the **identical** `new n.U(n(<moduleId>))` crash occurred in the new
chunk. Both variants contain the emscripten self-worker `new Worker(new URL(...))` pattern,
so both trip webpack's worker transform. Picking a variant is the wrong axis.

### CONFIRMED root cause (sharpened after probe #2)

Deminifying the actual built chunk (`4911.844eceeeb96359b2.js`) shows three
`new __webpack_require__.U(__webpack_require__(<id>))` call sites — `.U` is webpack's
URL-shim runtime helper whose first op is `e.replace(...)`:

- `...ort-wasm-simd-threaded.wasm": new r.U(r(85709)).href` — module `85709` is the
  **`.wasm` asset** (handled by the existing `type: "asset/resource"` rule), so
  `r(85709)` returns the asset's **URL string** → `new r.U("<string>")` works. ✓
- `en(){ var e = new Worker((URL, new r.U(r(24911))), {type:"module", name:"em-pthread"}) }`
  and `eA = new URL(new r.U(r(24911)).href, eE).href` — module `24911` is the
  **onnxruntime-web `.mjs` module itself** (handled by the existing
  `type: "javascript/auto"` rule), so `r(24911)` returns the **JS module export object**,
  not a string → `object.replace` → `TypeError: e.replace is not a function`. ✗ The `eA=...`
  form is evaluated **eagerly during module init** (not lazily), which is why it throws the
  instant `import("onnxruntime-web/wasm")` runs, before any inference/proxy config — so
  `numThreads:1` / `proxy:false` cannot avoid it.

**The existing `type: "javascript/auto"` rule is the direct cause:** it makes ort's
self-referencing `new URL('./ort-…​.mjs', import.meta.url)` resolve to a JS module (object),
whereas the code needs a URL string (exactly what the sibling `.wasm` asset reference gets).

### Probe #2 (FAILED, reverted)

Added `parser: { worker: false }` to the onnxruntime `.mjs` rule. **No effect** — the built
chunk `4911.844eceeeb96359b2.js` was byte-identical to the pristine build, and the crash was
unchanged. Reason: this is not webpack's `new Worker(new URL())` *worker* detection — it is
webpack's `new URL('…', import.meta.url)` **asset/url dependency** creation, which is
governed by `parser.javascript.url`, not `parser.javascript.worker`.

### Leading hypothesis for the real fix

`apps/web/next.config.mjs` already carries an onnxruntime-specific webpack rule:

```js
config.module.rules.push({ test: /\.mjs$/, include: /onnxruntime/, type: "javascript/auto" });
```

The correctly-targeted knob is webpack's **`parser.javascript.url`**, not `.worker`. Setting
it to `false` on the onnxruntime `.mjs` rule disables `new URL('…', import.meta.url)`
dependency creation, so webpack stops rewriting the self-`.mjs` reference into
`new r.U(r(<jsModuleId>))` and leaves the runtime `new URL(...)` untouched. onnxruntime-web's
own runtime then resolves its assets from `ort.env.wasm.wasmPaths = "/ort/"` (set in
`embed.ts`; worker + wasm assets staged under `apps/web/public/ort/`).

```js
config.module.rules.push({
  test: /\.mjs$/,
  include: /onnxruntime/,
  type: "javascript/auto",
  parser: { url: false },   // <-- the fix; NOT `worker: false` (probe #2, failed)
});
```

**Caveats to verify before committing:**
- Cheap pre-check: after rebuild, if the ort chunk hash is STILL byte-identical to the
  pristine build, webpack ignored the option (Next.js may override `module.parser`, or the
  option name/placement is wrong) — do not bother browser-testing, rethink the mechanism.
- `url: false` disables URL-dep resolution for the ENTIRE `.mjs` file, including the sibling
  `.wasm` reference at call site `@25773` (`new r.U(r(85709))`). That currently resolves
  correctly (asset → string); with `url:false` it becomes a literal runtime
  `new URL('…wasm', import.meta.url)`. Should still be fine because `embed.ts` overrides
  `ort.env.wasm.wasmPaths = "/ort/"`, so the real wasm is fetched from `/ort/` regardless —
  but VERIFY the wasm actually loads (watch for `/ort/*` 404s) and the doc reaches
  `status: "done"`, not merely "no longer crashes".
- Do NOT remove the existing `type: "javascript/auto"` — it was added to stop a *different*
  CJS-misparse crash on onnxruntime's `.mjs`. Keep it; only add `parser`.
- Fallback family if `url:false` is ignored or breaks wasm loading (architecture-level,
  discuss first): (a) mark `onnxruntime-web` external / load a local copy so webpack never
  rewrites its internal URLs; (b) emit only the sibling worker `.mjs` as `asset/resource`
  while the entry stays JS; (c) dedupe/upgrade onnxruntime-web (three copies in the store:
  1.14 / 1.19 / 1.27) in case a newer build drops the eager self-URL init.
- Current `apps/web/public/ort/` contains only `ort-wasm-simd-threaded.{mjs,wasm}`; confirm
  that covers what the selected variant fetches at runtime.
- This whole path only runs client-side; `output: "export"` static export means no COOP/COEP
  headers are set (see the next.config.mjs top comment), so multi-threaded ORT
  (SharedArrayBuffer) is effectively unavailable anyway — single-thread wasm is the target.

## Files involved

- `apps/web/next.config.mjs` — webpack config; where the fix goes.
- `packages/wasm-pipeline/src/embed.ts` — `getSession()`, the `import("onnxruntime-web/wasm")`
  call site; already sets `ort.env.wasm.wasmPaths = "/ort/"` and `numThreads` from scenario.
- `packages/wasm-pipeline/src/scenario.ts` — `numThreads` hardcoded to 1 for the real path.
- `apps/web/public/ort/` — staged worker + wasm assets served at `/ort/`.
- `apps/web/app/folders/[id]/FolderView.tsx` — upload `catch` that swallows the stack
  (only relevant for debugging; do not ship debug logging).

## onnxruntime-web version note

Three copies are in the pnpm store (`1.14.0`, `1.19.2`, `1.27.0`). `packages/wasm-pipeline`
depends on `^1.24.2` and resolves `1.27.0`; gliner drags in `1.19.2` (its self-worker chunk
also appeared in the built graph). A dependency-dedup or a version bump is a separate lever
worth considering if the parser fix proves fragile, but it is NOT the root cause.

## Status of the working tree

Both probe edits (`next.config.mjs` conditionNames, `FolderView.tsx` debug logging) were
**reverted** — `git status` is clean on `main` state on this branch. No fix committed yet.
