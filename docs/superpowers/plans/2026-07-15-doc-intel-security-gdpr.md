---
title: "Document Intelligence App — Plan 5: Security & GDPR"
date: 2026-07-15
status: ready
depends_on: [2026-07-15-doc-intel-auth-scopes, 2026-07-15-doc-intel-consent-mcp, 2026-07-15-doc-intel-consent-ui]
phase: 5
summary: >
  Security & GDPR plan for the fully-local app where the browser runs the entire engine
  (extract+OCR+chunk+e5+GLiNER PII+RAG+curtain redaction) on-device, and a thin Node.js MCP server
  holds only a mirror, light metadata, consent, and an AES-GCM key vault. Document content never
  leaves the device; PII is minimized to curtain tokens; rehydration is owner-only; every MCP path
  is gated by consent + scopes + matter scope. xberg is consumed only as @xberg-io/xberg-wasm.
---

# Plan 5 — Security & GDPR

**Depends on:** Plan 1 (`services/mcp-server` auth/scopes/consent/key vault/mirror),
Plan 4 (consent-gated MCP tools `rag_query`, `list_pii`, `rehydrate_chunk`, `ingest_folder`, `redact`),
Plan 3 (consent UI in apps/web onboarding + per-matter toggle).

**Goal:** Make the fully-local lawyer doc-intel app GDPR-safe and attorney-client-privilege-respecting
by construction — document content never egresses, PII is minimized to opaque curtain tokens,
redaction is reversible *only* by the owner who holds the key, and every path that could surface PII
or redacted originals is gated by an explicit, revocable consent record and a scoped token.

---

## Context

The product is a **fully-local** document-intelligence application for lawyers. The **browser** runs
the entire engine on the user's device: `@xberg-io/xberg-wasm` (extract + Tesseract OCR + chunk),
`onnxruntime-web` (e5 embeddings), `gliner` (GLiNER.js) (GLiNER PII), `edgevec`
(in-browser RAG), and `curtain-privacy` (reversible redaction). All of this is persisted to
IndexedDB/OPFS. A single thin **Node.js** service (`services/mcp-server`) serves the UI + pinned
models, holds light metadata (matters/folders/consent), an AES-GCM key vault, and a **mirror** of the
browser's EdgeVec index so `rag_query` works even with the browser closed. There is no cloud control
plane, no engine API keys, and no network egress for document content.

For a legal workload, two regimes dominate: **GDPR** (lawful basis, data minimization, right to
erasure, purpose limitation) and **attorney-client privilege** (confidentiality of client matter
content). Both demand that raw client text stays on-device, that detected PII is minimized to opaque
tokens, and that redaction is reversible *only* by the owner who holds the key. The shared contract
types are:

- `AuthScopes` = `read | ingest | redact | admin`
- `PiiEntity { kind, start, end, text, ciphertext? }` — `text` is the matched surface only when held
  transiently; the durable store keeps tokens and drops plaintext `text`.
- MCP tools: `rag_query`, `list_pii`, `rehydrate_chunk`, `ingest_folder`, `redact`.

CORE PRINCIPLE: **the browser runs the engine; the Node service is a thin mirror + gate.** We do not
reimplement extraction/NER/embeddings/RAG/redaction. The app adds the local security layer (key
vault, consent store, scoped auth, audit) and serves pinned models.

---

## Approach / Tasks

All tasks are implemented inside the browser (`apps/web` + `packages/wasm-pipeline`) and the thin
Node service (`services/mcp-server`). No xberg crate, no ORT, no Rust in this layer.

### T1 — Local-first guarantee (no egress)

- [ ] **Step 1:** Document the guarantee as an enforced invariant: document bytes are read from local
  disk and processed in-browser. The only network calls permitted are (a) the **pinned model
  download** from `the pinned model repos` served by the Node server, and (b) localhost HTTP to the Node service.
  No telemetry, no analytics, no document-content egress.
- [ ] **Step 2:** Add a startup guard that fails closed if any network sink is wired to document
  content paths; assert the only allowed egress is the SHA256-pinned model fetcher (Node `models.ts`).
- [ ] **Step 3:** Commit. `git commit -m "feat: enforce local-first no-egress invariant"`

### T2 — PII detection in-browser (local GLiNER)

- [ ] **Step 1:** Run `gliner` (GLiNER.js) over extracted document text **in the browser**
  to produce `PiiEntity` spans. Persist only `kind`, `start`, `end` + a curtain token in IndexedDB.
- [ ] **Step 2:** Send the matched surface text to the browser key vault (T4) to obtain `ciphertext?`;
  store the ciphertext in the mirrored metadata; drop the plaintext `text` after vaulting (data
  minimization).
- [ ] **Step 3:** `list_pii` MCP tool returns the spans + kinds, never the plaintext (only owner
  rehydration via `rehydrate_chunk`, T5, returns plaintext).
- [ ] **Step 4:** Commit. `git commit -m "feat: in-browser PII detection (GLiNER.js), token-only persistence"`

### T3 — In-browser reversible redaction (in-house, pattern from curtain-privacy)

- [ ] **Step 1:** Apply in-house reversible tokenization (span → `{{CATEGORY_n}}`) for `PERSON` / `ORG` / `LOC` spans
  produced by browser GLiNER. Redacted documents store **tokens** (e.g. `<PERSON_1>`), not values.
- [ ] **Step 2:** Store the original matched values as **ciphertext in the browser key vault** (T4);
  redacted docs on disk contain only tokens, so a leaked redacted doc reveals nothing. Mirror the
  encrypted curtain vault to the Node service for offline rehydration.
- [ ] **Step 3:** `redact` MCP tool records a redaction marker; the browser (when open) applies
  curtain tokens on-device.
- [ ] **Step 4:** Commit. `git commit -m "feat: in-house reversible redaction coupled to GLiNER spans"`

### T4 — Key vault (AES-GCM, owner-only)

- [ ] **Step 1:** Browser: use WebCrypto AES-GCM. The symmetric key lives in the **OS credential
  store** where available (e.g. platform keychain via `window.crypto` + a passphrase-derived
  KeyEncryptionKey with Argon2id); fallback to an encrypted-at-rest blob in IndexedDB.
- [ ] **Step 2:** Node (`services/mcp-server/src/vault.ts`): an AES-GCM vault decrypts the
  browser-mirrored curtain vault **only for the owner** and **only after consent** (T5).
- [ ] **Step 3:** Round-trip test (browser + Node): encrypt → decrypt yields original; wrong key →
  throws.
- [ ] **Step 4:** Commit. `git commit -m "feat: AES-GCM key vault (browser owner + Node offline rehydration)"`

### T5 — Consent gate

- [ ] **Step 1:** Store an explicit, revocable **consent record** in the Node metadata store (Plan 1).
  Before any MCP call returns PII or a redacted original, check the consent record for the capability.
- [ ] **Step 2:** `list_pii` and `rehydrate_chunk` refuse when consent is absent/revoked. `rag_query`
  returns answers over redacted/tokenized content without surfacing raw PII.
- [ ] **Step 3:** Consent UI (Plan 3) in apps/web onboarding + a **per-matter toggle**; revocation
  takes effect immediately on the next request.
- [ ] **Step 4:** Manual check: revoke consent → `list_pii` / `rehydrate_chunk` refuse.
- [ ] **Step 5:** Commit. `git commit -m "feat: consent gate before any PII/redacted egress"`

### T6 — Auth / scoped tokens + matter/folder scoping

- [ ] **Step 1:** Issue scoped tokens (Plan 1) over `AuthScopes = read | ingest | redact | admin`.
  Enforce scope in every HTTP handler and MCP tool.
- [ ] **Step 2:** Enforce **matter/folder scoping**: a token bound to matter `M` can only touch `M`'s
  documents, PII, and redacted output. `ingest_folder` / `rag_query` / `list_pii` / `rehydrate_chunk`
  / `redact` all validate the token's scope + matter/folder binding before acting.
- [ ] **Step 3:** Test for scope enforcement: `read` token calling `redact` → refused; token scoped to
  matter A reading matter B → refused.
- [ ] **Step 4:** Commit. `git commit -m "feat: scoped tokens + matter/folder scoping enforcement"`

### T7 — Model supply chain (SHA256-pinned)

- [ ] **Step 1:** Every pinned model (`Xenova/multilingual-e5-base` e5 ONNX, `onnx-community/gliner_small-v2.1` gliner-pii ONNX, tokenizer) is fetched with a
  **SHA256 pin**; the Node `models.ts` verifies the digest before serving. No arbitrary model fetch.
- [ ] **Step 2:** Pin set is part of app config; mismatch → fail closed (refuse to serve model, refuse
  to process).
- [ ] **Step 3:** Document the only allowed egress (T1) is exactly this pinned fetcher + localhost.
- [ ] **Step 4:** Commit. `git commit -m "feat: SHA256-pinned model supply chain"`

### T8 — Data lifecycle / right to erasure

- [ ] **Step 1:** Erasure is **browser-first**: dropping a matter wipes its IndexedDB/OPFS chunks,
  vectors, PII spans, and redacted artifacts.
- [ ] **Step 2:** Also wipe the Node **mirror** file (`config.dataDir/mirrors/<matterId>.bin`) and the
  associated encrypted curtain vault — no recoverable plaintext remains on disk.
- [ ] **Step 3:** Audit retains an erasure event (append-only, no PII in the log) in the Node store.
- [ ] **Step 4:** Test: forget(matter) → browser IndexedDB + Node mirror + ciphertext all gone.
- [ ] **Step 5:** Commit. `git commit -m "feat: per-matter data lifecycle + forget wipes browser + mirror"`

### T9 — Local audit log (no PII in logs)

- [ ] **Step 1:** Append-only local log (Node `meta.sqlite` audit table) of accesses to PII / redacted
  content: actor, scope, action, matter id, timestamp. **Never** write PII values or plaintext.
- [ ] **Step 2:** Log entries reference `PiiEntity` by id/span, not by content; redaction tokens are
  acceptable, raw values are not.
- [ ] **Step 3:** Commit. `git commit -m "feat: local audit of PII/redacted access (no PII in logs)"`

---

## Depends on

- **Plan 1** — `services/mcp-server` auth/scopes/consent store/key vault/mirror.
- **Plan 4** — consent-gated MCP tools (`rag_query`, `list_pii`, `rehydrate_chunk`, `ingest_folder`,
  `redact`).
- **Plan 3** — consent UI in apps/web onboarding + per-matter toggle.
- **Plan 2** — browser engine (extract/OCR/chunk/e5/GLiNER/RAG/curtain) that produces the mirror.

## Verification

- **Threat walkthrough** (documented, manual trace):
  1. No egress — confirm the only network path is the pinned `the pinned model repos` model fetch (served by
     Node); document content never leaves the device.
  2. Redaction reversible only by owner — curtain token → ciphertext in vault; without the owner's
     AES-GCM key, redacted docs are un-reversible (browser or Node offline).
  3. Consent blocks PII egress via MCP — absent/revoked consent, `list_pii` / `rehydrate_chunk` refuse.
- **Tests** for:
  - key vault encrypt/decrypt round-trip + wrong-key refusal (T4, browser + Node).
  - scope enforcement: `read` ≠ `redact`; matter A ≠ matter B (T6).
  - forget(matter) wipes browser IndexedDB + Node mirror + ciphertext (T8).
- **Manual:** revoke consent → `list_pii` / `rehydrate_chunk` refuse; re-grant → succeed.

## Risks / Non-goals

- **Non-goal:** multi-tenant / cloud hosting. The app is single-owner, single-device by design.
- **Device compromise is out of scope:** local-first means a stolen/unlocked device with the keychain
  unlocked can expose data. Encourage OS disk encryption, screen lock, and a strong vault passphrase;
  document this limitation rather than solving it in-app.
- **Model accuracy** is the browser runtimes' responsibility (ORT-Web e5, GLiNER.js); this plan covers
  security wrapping, not NER/OCR quality.
- **Key loss** = permanent loss of rehydration capability (ciphertext unrecoverable). Document the
  passphrase/keychain backup expectation.
- **Node mirror holds an encrypted curtain vault** — it must be AES-GCM and owner-only; the Node
  service never serves raw PII without consent + the owner key.

## Exit criteria

- Local-first no-egress invariant enforced; only pinned `the pinned model repos` model fetch + localhost allowed.
- PII detected in-browser via gliner; spans + reversible tokens persisted, plaintext minimized.
- in-house reversible redaction coupled to GLiNER; originals survive only as vault ciphertext
  (browser + mirrored-to-Node).
- Key vault (AES-GCM, browser owner + Node offline rehydration); `rehydrate_chunk` gated by consent.
- Scoped tokens + matter/folder scoping enforced in handlers and all MCP tools.
- Per-matter forget wipes browser IndexedDB + Node mirror + ciphertext; audit log contains no PII.

## 2026-07-23 GLiNER2 privacy gates

The existing GLiNER.js/v1 detector is transitional and is not itself a GDPR
quality boundary. Before enabling the imported Xberg GLiNER2 engine by default:

- [ ] Pin and verify model/tokenizer/config bytes and record `NerIdentity`.
- [ ] Disclose the seven supported languages and require human review or a
  validated fallback outside them.
- [ ] Keep deterministic validated structured-PII detectors in front of
  contextual NER.
- [ ] Prove native/WASM span and offset parity, with F16 confidence tolerance.
- [ ] Test corrupt artifacts, resource exhaustion, cache quota, cancellation,
  long-document window boundaries, and unsupported-language behavior.
- [ ] Do not persist raw detected entity text or claim automatic GDPR
  compliance from model output.
