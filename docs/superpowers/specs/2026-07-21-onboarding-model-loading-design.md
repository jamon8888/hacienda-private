# Design: Background Model Warmup + Loading Indicator

**Date:** 2026-07-21
**Status:** Implemented on `feat/isomorphic-rag-core`
**Author:** brainstorm session
**Depends on:** `docs/superpowers/specs/2026-07-20-web-ui-lawyer-enhancement.md` (the Onboarding screen there only covers auth token + vault passphrase — this spec adds the model-loading concern that plan doesn't cover)

## Goal

Today, the on-device models (E5 embedding model, GLiNER PII model, and their
tokenizers) are loaded lazily, for the first time, buried inside the first
call to `ingestFolder()`. There is no dedicated progress signal for this —
the existing per-file ingest progress bar just appears to stall during the
`embed`/`pii` stages while a multi-MB model download happens silently. There
is also no caching for the GLiNER model or tokenizer today
(`useBrowserCache: false` in `ner.ts`), so this stall repeats every session.

This spec adds a background warmup step that starts automatically when the
app loads, a visible progress indicator, gates only the actions that
actually require the models, and fixes model caching so the wait only
happens on a user's genuinely first visit (or after a model version bump).

## Current State (verified)

- [apps/web/app/onboarding/page.tsx](../../../apps/web/app/onboarding/page.tsx) — static card, "Enter workspace" just sets local auth and navigates to `/matters`. No model interaction.
- [packages/wasm-pipeline/src/runtime.ts](../../../packages/wasm-pipeline/src/runtime.ts) `initWasm()` — lazy-loads the Rust/WASM extraction engine on first call.
- [packages/wasm-pipeline/src/embed.ts](../../../packages/wasm-pipeline/src/embed.ts) `getSession()` — dynamically imports `onnxruntime-web`, fetches the E5 `.onnx` file itself (`fetch(e5ModelUrl(...))`), and `fetchJson()` fetches the E5 tokenizer + config itself.
- [packages/wasm-pipeline/src/ner.ts](../../../packages/wasm-pipeline/src/ner.ts) `getModel()` — constructs a `gliner` `Gliner` instance; **we do not fetch its model/tokenizer ourselves.**
- [packages/wasm-pipeline/src/scenario.ts](../../../packages/wasm-pipeline/src/scenario.ts) `selectScenario()` + [capabilities.ts](../../../packages/wasm-pipeline/src/capabilities.ts) `detectCapabilities()` already compute which execution provider/quant/model variant to use per device — reused as-is by warmup.
- Traced into `gliner@0.0.19`'s source (`dist/index.mjs`):
  - `ONNXWebWrapper.init()` calls `ort.InferenceSession.create(modelPath, ...)` with a **URL string**, so `onnxruntime-web` does its own internal fetch for the PII model binary — not interceptable via our own fetch calls.
  - `Gliner`'s tokenizer setup calls `AutoTokenizer.from_pretrained(tokenizerPath)` from `@xenova/transformers`, which **does** respect `transformersSettings.useBrowserCache` (currently set to `false` in `ner.ts:62`).

## Decisions (from brainstorming)

1. **Trigger:** Warmup starts automatically as soon as the app loads (no button, no separate onboarding page/step). The user reaches `/matters` immediately; warmup runs in the background.
2. **Gating:** The ingest dropzone and search view are replaced with a preparation placeholder while warmup is in progress, since both require models. Matters list, browsing, and viewing existing documents are unaffected.
3. **Indicator:** A status pill in the app-shell top bar, next to the planned vault-lock indicator (per the 2026-07-20 plan's App Shell screen): `⏳ Preparing on-device models… 42%` → `✓ Models ready` → `⚠ Models unavailable — Retry`.
4. **Failure handling:** 3 total attempts per failing model (the initial attempt plus 2 automatic retries) with exponential backoff between failures (1s, then 2s). On exhaustion, the pill shows an error state with a manual "Retry" action that restarts the whole warmup sequence (including re-running capability detection, in case the failure was scenario-specific).
5. **Caching:** Enabled for all four fetched assets, so warmup only takes meaningful time on a genuinely first visit (or after a model version bump). See table below — each asset uses whichever mechanism is simplest given who owns its fetch.

## Caching Mechanism (per asset)

| Asset | Who fetches it today | Caching approach |
|---|---|---|
| E5 embedding model (`.onnx`) | We do, directly (`embed.ts`) | Wrap the existing `fetch()` with `caches.open('xberg-models-v1')`: check cache before fetching, `cache.put()` after. Same code path also yields byte-progress via `Content-Length` + streamed reader. |
| E5 tokenizer (json + config) | We do, directly (`embed.ts` `fetchJson`) | Same direct Cache Storage wrap. |
| GLiNER tokenizer | `@xenova/transformers`' `AutoTokenizer.from_pretrained`, internally | Flip `transformersSettings.useBrowserCache` from `false` to `true` in `ner.ts` — transformers.js has its own Cache-Storage-backed caching; no custom code needed. |
| GLiNER PII model (`.onnx`) | `onnxruntime-web`'s `InferenceSession.create(modelPath)`, internally, bypassing transformers.js | No library flag covers this. Requires a temporary, narrowly-scoped `fetch` override: pre-fetch the model URL ourselves (progress + Cache Storage write), then while `model.initialize()` runs, intercept only requests to that exact URL and serve them from our Cache Storage entry; restore the real `globalThis.fetch` in a `finally` immediately after, including on error. |

The scoped-fetch-override is the only genuinely novel/risky piece of new
code in this design; everything else is either reusing an existing
fetch-you-already-own or flipping an existing library flag.

## Architecture

- **`packages/wasm-pipeline/src/model-cache.ts`** — owns the Cache Storage wrapper and narrowly scoped fetch override described above.
- **`packages/wasm-pipeline/src/warmup.ts`** — `warmupModels(onProgress): Promise<WarmupResult>`. Runs `detectCapabilities()` → `selectScenario()`, warms the WASM engine, then warms the E5 and GLiNER sessions in parallel, reporting `{ stage: "engine" | "e5" | "gliner", overall }` via `onProgress`.
- **`apps/web/lib/engine/warmup-store.ts`** — a module-level singleton store (subscribe/getSnapshot pattern, `useSyncExternalStore`-compatible) holding `{ stage: "idle" | "loading" | "ready" | "error", progress: number, error: string | null, attempt: number }`. It also exports `useModelWarmup()`, `startModelWarmup()`, and the manual retry action; there is no separate hook module.
- **Kickoff** — `AppShell` calls `startModelWarmup()` on mount. The store's `started` guard makes this idempotent under React strict-mode double-mount.
- **Consumers:**
  - App-shell top bar renders the status pill from `useModelWarmup()`.
  - `FolderView` reads `stage !== "ready"` and renders a preparation placeholder instead of the ingest dropzone.
  - `SearchPageInner` reads `stage !== "ready"` and renders the same preparation state instead of calling `queryRag` (avoids a hang on the embed call).

## Error Handling

- Per-model retry: 3 total attempts, with 1s/2s backoff before the two retries, independent per model (E5 failing doesn't block GLiNER retries or vice versa).
- On exhaustion of either model's retries, overall stage → `"error"`; pill shows the error state with a manual retry.
- Manual retry re-runs the full `warmupModels()` sequence from capability detection, not just the failed model, since a bad scenario pick (e.g. wrong execution provider) could be the actual cause.

## Testing

- Unit tests for `warmup.ts` progress math and retry/backoff, mocking `fetch` (colocated `warmup.test.ts`, matching existing `*.test.ts` files in `wasm-pipeline`).
- Unit test specifically for the scoped-fetch-override: verify `globalThis.fetch` is restored to the original even when the pre-fetch or `model.initialize()` throws.
- Unit test for the Cache Storage wrap: second call with the same URL doesn't hit the network.
- Vitest + Testing Library integration coverage verifies loading → ready transitions and the search/ingest gates. A web Playwright harness was not added because this repository has no root/app-level Playwright configuration.

## Out of Scope

- Web Worker or Service Worker based warmup (considered and rejected during brainstorming — no confirmed main-thread jank problem today, and both add infrastructure disproportionate to "warm 2 models and show progress").
- Backend `Cache-Control` header changes on the Node model-cache service (would strengthen GLiNER model caching further but isn't required given the scoped-fetch-override approach; worth a follow-up ticket, not part of this spec).
- Changing which models are used, quantization strategy, or `selectScenario()` logic itself.
