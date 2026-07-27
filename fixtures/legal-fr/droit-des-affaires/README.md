# Droit des affaires fixtures

Synthetic (non-confidential, invented) French business-law text for
validating the `DROIT_DES_AFFAIRES_LABELS` GLiNER2 schema and the rule-based
relation inference in `packages/wasm-pipeline/src/entity-graph.ts`.

## Status: schema accuracy not yet validated against a real model

This sandbox cannot run the real GLiNER2 model (no downloaded weights, no
built `@xberg-io/xberg-wasm` module — the same limitation that has blocked
running this repo's other wasm-dependent tests throughout this work).
`entity-graph.test.ts` covers the post-processing logic (canonicalization,
relation inference, merging) against synthetic mocked spans, proving that
logic is correct — but **not** whether the actual schema/label list extracts
accurate spans from real French legal text. That's the go/no-go checkpoint
the plan calls for, and it needs a real environment to run:

1. `pnpm --filter web dev`, ingest `statuts_sasu_extrait.txt` with
   `entityGraphLabels: DROIT_DES_AFFAIRES_LABELS` enabled.
2. Compare the extracted entities against what's expected in this document:
   `SASU DUPONT CONSEIL` (société), `Jean Dupont` (dirigeant), `Marie Martin`
   (actionnaire), `AUDIT & CONSEIL SARL` (commissaire aux comptes), `10 000
   euros` / `50 000 euros` (capital social), `812 345 678` (SIREN).
3. If recall/precision on this vocabulary is poor, that's the trigger to
   invest in a LoRA adapter (see the plan) — not something to assume up
   front.
