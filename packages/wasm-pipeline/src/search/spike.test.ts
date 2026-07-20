import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
import "fake-indexeddb/auto";
import init, { EdgeVec as EdgeVecClass, EdgeVecConfig } from "edgevec";

// edgevec's db.save()/EdgeVec.load() call the global `indexedDB` directly
// (edgevec.js storage.js snippet) — this is a real browser-API dependency,
// not just a broken-load quirk. "fake-indexeddb/auto" installs a spec-compliant
// in-memory IndexedDB polyfill on globalThis so save()/load() can run under
// Node/vitest identically to how they'd run in a browser.

// Node/vitest spike (not Playwright/browser): edgevec's default init() does
// `fetch(new URL('edgevec_bg.wasm', import.meta.url))`, and Node's native fetch
// does not support file:// URLs. Passing raw bytes bypasses fetch entirely —
// __wbg_load hands non-Response input straight to WebAssembly.instantiate
// (edgevec.js:3801-3808) — so this exercises the identical wasm binary the
// browser would load, without needing Playwright/COOP-COEP infrastructure.
const require = createRequire(import.meta.url);
const wasmBytes = readFileSync(require.resolve("edgevec/edgevec_bg.wasm"));

describe("EdgeVec capability + persistence spike", () => {
  it("hybridSearch/sparse/BQ work and load is broken via a real save->load round-trip", async () => {
    await init({ module_or_path: wasmBytes });

    const cfg = new EdgeVecConfig(768);
    cfg.metric = "cosine";
    const db = new EdgeVecClass(cfg);

    // dense + sparse insert with aligned ids
    const denseId = db.insertWithMetadata(new Float32Array(768).map(() => Math.random()), { text: "x" });
    db.insertSparse(new Uint32Array([10, 42]), new Float32Array([0.8, 1.2]), 30000);

    // hybridSearch returns a JSON STRING -> must JSON.parse; options is a JSON STRING -> must JSON.stringify
    const rRaw = db.hybridSearch(
      new Float32Array(768).map(() => 0.1),
      new Uint32Array([10]),
      new Float32Array([0.8]),
      30000,
      // real HybridSearchOptions shape (edgevec-types.d.ts:589-614): `k` is the
      // required final-fused-count field; there is no `rrf_k` override.
      JSON.stringify({ dense_k: 5, sparse_k: 5, k: 5, fusion: "rrf" }),
    );
    const r = JSON.parse(rRaw);

    // BQ path (array-like, no JSON.parse) - must enableBQ() first (edgevec.d.ts:1483);
    // BQ requires dimensions divisible by 8 (768 qualifies).
    db.enableBQ();
    const bq = db.searchBQ(new Float32Array(768).map(() => 0.1), 5);

    // load is BROKEN in 0.9.0 (PostCard `WontImplement`) - prove it with a REAL
    // save -> load round-trip, not a load of a never-saved name (which always throws
    // for the wrong reason and would produce a false positive).
    let loadBroken = false;
    await db.save("spike-roundtrip");
    try {
      await EdgeVecClass.load("spike-roundtrip");
    } catch (e) {
      // The rejection is a plain { code, message } object, not an Error
      // instance -- String(e) would yield "[object Object]" and always fail
      // this check. Inspect .message (fall back to String(e) for safety).
      const msg = (e as { message?: string })?.message ?? String(e);
      loadBroken = /PostCard|Deserialization/i.test(msg);
    }

    const hasHybrid = Array.isArray(r);
    const hasBq = Array.isArray(bq);

    expect(hasHybrid).toBe(true);
    expect(hasBq).toBe(true);
    expect(typeof denseId).toBe("number");
    expect(loadBroken).toBe(true);
  });
});
