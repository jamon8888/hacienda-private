import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll } from "vitest";
import init from "edgevec";
import { EdgeVecSearchStore } from "./edgevec";
import type { IndexedChunk } from "./store";

// Per-stage benchmark harness + soak test (spec Section 5).
//
// SCOPE NOTE: the spec's full latency budget also covers Extract (<800ms),
// Embed (<400ms), and NER (<600ms). Those stages need real e5/GLiNER ONNX
// weights and tokenizers served over HTTP from a running model-serving
// origin (see constants.ts's API_BASE) -- unavailable in this offline
// Node/vitest run. They're exercised functionally (mocked models) in
// embed.test.ts/ner.test.ts/ocr.test.ts; measuring their real-world latency
// needs a live integration/e2e run, out of scope for this unit-level bench.
// What IS fully testable here, and is the actual subject of this whole
// redesign, is the SearchStore layer: Persist (<200ms) and Query (<100ms),
// plus the soak test proving query latency stays flat (no per-query rebuild).

const require = createRequire(import.meta.url);
const wasmBytes = readFileSync(require.resolve("edgevec/edgevec_bg.wasm"));

beforeAll(async () => {
  await init({ module_or_path: wasmBytes });
});

function wave(dim: number, seed: number): Float32Array {
  const raw = Float32Array.from({ length: dim }, (_, i) => Math.sin((i + 1) * seed));
  let sumSq = 0;
  for (const v of raw) sumSq += v * v;
  const norm = Math.sqrt(sumSq) || 1;
  return Float32Array.from(raw, (v) => v / norm);
}

function fixtureChunks(matterId: string, folderIdx: number, n: number): IndexedChunk[] {
  return Array.from({ length: n }, (_, i) => ({
    docId: `${matterId}-doc-${folderIdx}`,
    chunkIndex: i,
    text: `Acme Corp clause ${folderIdx}-${i} regarding matter ${matterId}`,
    citation: `${matterId}#${folderIdx}-${i}`,
    vector: wave(768, (folderIdx * 1000 + i + 1) * 0.001),
  }));
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx] ?? 0;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

describe("bench: SearchStore persist + query budgets (spec Section 5)", () => {
  it("persist stays under 200ms for a ~50-chunk folder", async () => {
    const store = new EdgeVecSearchStore();
    await store.open("bench-persist");
    await store.ingest(fixtureChunks("bench-persist", 0, 50));

    const t0 = performance.now();
    await store.persist("bench-persist");
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(200);
    await store.close();
  });

  it("query stays under 100ms against a resident index", async () => {
    const store = new EdgeVecSearchStore();
    await store.open("bench-query");
    await store.ingest(fixtureChunks("bench-query", 0, 50));

    const queryVec = fixtureChunks("bench-query", 0, 1)[0]?.vector as Float32Array;
    const t0 = performance.now();
    await store.query("bench-query", { vector: queryVec, keyword: "Acme", topK: 8 });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(100);
    await store.close();
  });
});

describe("soak: query latency stays flat across many queries (proves no per-query rebuild)", () => {
  it(
    "ingests N folders, queries M times, and p95/latency trend does not degrade",
    async () => {
      const N_FOLDERS = 20;
      const CHUNKS_PER_FOLDER = 50;
      const M_QUERIES = 100;
      const matterId = "soak-matter";

      const writer = new EdgeVecSearchStore();
      await writer.open(matterId);
      for (let f = 0; f < N_FOLDERS; f++) {
        await writer.ingest(fixtureChunks(matterId, f, CHUNKS_PER_FOLDER));
      }
      await writer.persist(matterId);
      await writer.close();

      // Fresh instance, loaded ONCE from the persisted blob -- exactly the
      // "rebuild once per session, not per query" path this redesign exists
      // to guarantee, replacing EdgeVec's broken native load().
      const reader = new EdgeVecSearchStore();
      const loaded = await reader.load(matterId);
      expect(loaded).toBe(true);

      const queryVec = fixtureChunks(matterId, 0, 1)[0]?.vector as Float32Array;
      const latencies: number[] = [];
      for (let i = 0; i < M_QUERIES; i++) {
        const t0 = performance.now();
        const hits = await reader.query(matterId, { vector: queryVec, keyword: "Acme", topK: 8 });
        latencies.push(performance.now() - t0);
        expect(hits.length).toBeGreaterThan(0);
      }

      const sorted = [...latencies].sort((a, b) => a - b);
      const p95 = percentile(sorted, 95);
      const quarter = Math.max(1, Math.floor(M_QUERIES / 4));
      const firstQuarterAvg = average(latencies.slice(0, quarter));
      const lastQuarterAvg = average(latencies.slice(-quarter));

      expect(p95).toBeLessThan(100);
      // "Flat" = no per-query-rebuild sawtooth (which would show as a
      // multi-hundred-ms linear climb per query), not zero jitter. Generous
      // slack absorbs JIT warmup/GC noise without masking a real regression.
      expect(lastQuarterAvg).toBeLessThan(firstQuarterAvg * 3 + 5);

      await reader.close();
    },
    30_000,
  );
});
