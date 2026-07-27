# Droit commercial fixtures

Synthetic (non-confidential, invented) French commercial-law text for
validating the `DROIT_COMMERCIAL_LABELS` GLiNER2 schema and the
`DROIT_COMMERCIAL_RULES` relation inference in
`packages/wasm-pipeline/src/entity-graph.ts`.

This is Phase B of the entity-graph plan, following the same pattern as
Phase A (`fixtures/legal-fr/droit-des-affaires/`): a flat GLiNER2 label
list plus a small rule-based relation engine, extracted from Phase A's
originally droit-des-affaires-only `inferRelations()` into a reusable
`inferRelationsFromRules()` now that a second vertical needs the identical
shape.

## Status: schema accuracy not yet validated against a real model

Same limitation as Phase A: this sandbox cannot run the real GLiNER2 model
(no downloaded weights, no built `@xberg-io/xberg-wasm` module).
`entity-graph.test.ts` covers the post-processing logic (relation
inference against the three `DROIT_COMMERCIAL_RULES`, and that droit
commercial's rules don't cross-wire with droit des affaires' entity types)
against synthetic mocked spans — proving that logic is correct, but
**not** whether the actual schema/label list extracts accurate spans from
real French commercial-law text. That's the go/no-go checkpoint the plan
calls for, and it needs a real environment to run:

1. `pnpm --filter web dev`, ingest `acte_cession_fonds_extrait.txt` with
   `entityGraphLabels: DROIT_COMMERCIAL_LABELS` enabled (and, once a
   vertical-selection UI exists, `relationRules: DROIT_COMMERCIAL_RULES`
   passed alongside it — today `FolderView.tsx`'s checkbox only wires the
   droit des affaires vertical; wiring a second one is a follow-up, not
   part of this schema sketch).
2. Compare the extracted entities against what's expected in this
   document: `Paul Lefèvre` (commerçant), `fonds de commerce de
   boulangerie-pâtisserie` (fonds de commerce), `bail commercial` (bail
   commercial), `RCS 456 789 123` (immatriculation RCS), `clause de
   non-concurrence` (clause de non-concurrence), `ABC DISTRIBUTION`
   (société commerciale), `tribunal de commerce de Lyon` (tribunal de
   commerce).
3. If recall/precision on this vocabulary is poor, that's the trigger to
   invest in a LoRA adapter (see the plan) — not something to assume up
   front.
