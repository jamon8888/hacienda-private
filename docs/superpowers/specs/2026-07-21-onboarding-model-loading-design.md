# Design: Background Model Warmup + Loading Indicator

**Date:** 2026-07-21
**Status:** Implemented on `main` via PR #26 (`feat: background model warmup + loading indicator`)
**Author:** brainstorm session
**Depends on:** `docs/superpowers/specs/2026-07-20-web-ui-lawyer-enhancement.md` (the Onboarding screen there only covers auth token + vault passphrase — this spec adds the model-loading concern that plan doesn't cover)

## Goal

This spec proposed a background warmup step that starts automatically when the
app loads, a visible progress indicator, gating for model-dependent actions,
and model-asset caching so the wait only happens on a user's genuinely first
visit (or after a model version bump).

As of July 22, 2026, that work has landed on `main`. The sections below are
kept as the design record, with the "Current State" section updated to reflect
the implemented behavior.

## Current State (verified)

- [apps/web/app/onboarding/page.tsx](../../../apps/web/app/onboarding/page.tsx) — static card, "Enter workspace" just sets local auth and navigates to `/matters`. No model interaction.
- [apps/web/components/app-shell.tsx](../../../apps/web/components/app-shell.tsx) starts warmup on mount via `startModelWarmup()`, and [apps/web/components/model-warmup-status.tsx](../../../apps/web/components/model-warmup-status.tsx) renders the status pill in the top bar.
- [apps/web/lib/engine/warmup-store.ts](../../../apps/web/lib/engine/warmup-store.ts) implements the singleton warmup store and co-locates the `useModelWarmup()` hook; there is no separate `apps/web/hooks/use-model-warmup.ts` file.
- [packages/wasm-pipeline/src/warmup.ts](../../../packages/wasm-pipeline/src/warmup.ts) now orchestrates `detectCapabilities()` → `selectScenario()` → engine/model warmup, with weighted progress and retry/backoff.
- [packages/wasm-pipeline/src/model-cache.ts](../../../packages/wasm-pipeline/src/model-cache.ts) provides Cache Storage-backed fetch helpers plus the scoped fetch override used for the GLiNER ONNX fetch path.
- [packages/wasm-pipeline/src/embed.ts](../../../packages/wasm-pipeline/src/embed.ts) now fetches the E5 model and tokenizer through the cache helpers.
- [packages/wasm-pipeline/src/ner.ts](../../../packages/wasm-pipeline/src/ner.ts) now enables `transformersSettings.useBrowserCache`, prefetches the GLiNER ONNX bytes, and initializes under a scoped fetch override.
- [apps/web/app/folders/[id]/FolderView.tsx](../../../apps/web/app/folders/[id]/FolderView.tsx) gates ingest until warmup reaches `"ready"`.
- [apps/web/app/search/SearchPageInner.tsx](../../../apps/web/app/search/SearchPageInner.tsx) also gates search on warmup readiness. This is a small UX divergence from the original design decision below, which proposed allowing the click and then showing a toast/error instead of proactively disabling the button.

## Decisions (from brainstorming)

1. **Trigger:** Warmup starts automatically as soon as the app loads (no button, no separate onboarding page/step). The user reaches `/matters` immediately; warmup runs in the background.
2. **Gating:** Only the ingest dropzone (upload/drop files) is disabled while warmup is in progress, since it needs both models. Search also requires the E5 model for query embedding — if attempted before warmup finishes, it's blocked with a toast rather than hanging, but is not proactively disabled in the UI. Matters list, browsing, and viewing existing documents are unaffected.
3. **Indicator:** A status pill in the app-shell top bar, next to the planned vault-lock indicator (per the 2026-07-20 plan's App Shell screen): `⏳ Preparing on-device models… 42%` → `✓ Models ready` → `⚠ Models unavailable — Retry`.
4. **Failure handling:** 3 automatic retries per failing model with exponential backoff (1s / 2s / 4s). On exhaustion, the pill shows an error state with a manual "Retry" action that restarts the whole warmup sequence (including re-running capability detection, in case the failure was scenario-specific).
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

- **`packages/wasm-pipeline/src/warmup.ts`** (new) — `warmupModels(onProgress): Promise<void>`. Runs `detectCapabilities()` → `selectScenario()`, then warms the E5 session/tokenizer and the GLiNER model/tokenizer (parallel where independent), reporting `{ model: "e5" | "gliner", stage, bytesLoaded, bytesTotal }` via `onProgress`. Internally owns the Cache Storage wrapping and the scoped-fetch-override described above.
- **`apps/web/lib/engine/warmup-store.ts`** (new) — a module-level singleton store (subscribe/getSnapshot pattern, `useSyncExternalStore`-compatible) holding `{ stage: "idle" | "loading" | "ready" | "error", progress: number, error?: string, attempt: number }`. Module-level singleton guarantees warmup runs exactly once per tab even under React strict-mode double-mount, and lets multiple components (pill, ingest dropzone, search) subscribe without prop drilling.
- **`apps/web/hooks/use-model-warmup.ts`** (new) — thin hook wrapping the store, plus a `retry()` action.
  Implementation note: the shipped code co-locates this hook in `apps/web/lib/engine/warmup-store.ts` instead of creating a separate file.
- **Kickoff** — a small client component mounted once in the root app-shell/layout calls `warmupModels()` on mount (guarded so it only ever fires once per store lifetime).
- **Consumers:**
  - App-shell top bar renders the status pill from `useModelWarmup()`.
  - `file-dropzone` (ingest) reads `stage !== "ready"` to disable + show a tooltip reason.
  - `queryRagForUi` callers check `stage !== "ready"` before querying and show a toast instead of calling through (avoids a hang on the embed call).

## Error Handling

- Per-model retry: 3 attempts, backoff 1s/2s/4s, independent per model (E5 failing doesn't block GLiNER retries or vice versa).
- On exhaustion of either model's retries, overall stage → `"error"`; pill shows the error state with a manual retry.
- Manual retry re-runs the full `warmupModels()` sequence from capability detection, not just the failed model, since a bad scenario pick (e.g. wrong execution provider) could be the actual cause.

## Testing

- Unit tests for `warmup.ts` progress math and retry/backoff, mocking `fetch` (colocated `warmup.test.ts`, matching existing `*.test.ts` files in `wasm-pipeline`).
- Unit test specifically for the scoped-fetch-override: verify `globalThis.fetch` is restored to the original even when the pre-fetch or `model.initialize()` throws.
- Unit test for the Cache Storage wrap: second call with the same URL doesn't hit the network.
- Implemented verification uses Vitest + Testing Library coverage around the warmup store, status pill, search gating, and ingest gating. A dedicated Playwright smoke test for this flow has not been added in `apps/web`.

## Out of Scope

- Web Worker or Service Worker based warmup (considered and rejected during brainstorming — no confirmed main-thread jank problem today, and both add infrastructure disproportionate to "warm 2 models and show progress").
- Backend `Cache-Control` header changes on the Node model-cache service (would strengthen GLiNER model caching further but isn't required given the scoped-fetch-override approach; worth a follow-up ticket, not part of this spec).
- Changing which models are used, quantization strategy, or `selectScenario()` logic itself.

## 2026-07-23 GLiNER2 loading amendment

The scoped global `fetch` override and injected JavaScript GLiNER constructor
remain the legacy path. The target Xberg Candle path fetches checksum-verified
safetensors, tokenizer, and encoder-config bytes, then passes them to a
stateful WASM model handle in a Worker.

The official 1.23 GB source checkpoint must not join eager startup warmup.
GLiNER2 is explicit opt-in/lazy loading with truthful byte progress,
cancellation, storage-quota preflight, corrupt-cache eviction, OOM recovery,
immutable revision keys, and supported-language disclosure. A browser-optimized
F16 or quantized artifact is required before default enablement.
