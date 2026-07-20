import { createClient } from "@libsql/client";

/**
 * @typedef {Object} SpikeResult
 * @property {boolean} vector
 * @property {boolean} fts
 * @property {Record<string, string|null>} errors
 * @property {number|null} wasmBytes
 * @property {string[]} notes
 */

/**
 * @returns {Promise<{ok: boolean, error: string|null}>}
 */
async function runVector() {
  let db = null;
  try {
    db = await createClient({ url: ":memory:" });
    await db.batch([
      "CREATE TABLE t(id INTEGER PRIMARY KEY, e F32_BLOB(4))",
      "CREATE INDEX ti ON t(libsql_vector_idx(e,'metric=cosine'))",
      "INSERT INTO t VALUES (1, vector32('[1,0,0,0]'))",
    ]);
    const rs = await db.execute(
      "SELECT id FROM vector_top_k('ti', vector32('[1,0,0,0]'), 1) vt JOIN t ON t.id=vt.id"
    );
    return { ok: rs.rows.length === 1, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  } finally {
    try { await db?.close(); } catch { /* ignore */ }
  }
}

/**
 * @returns {Promise<{ok: boolean, error: string|null}>}
 */
async function runFts() {
  let db = null;
  try {
    db = await createClient({ url: ":memory:" });
    await db.batch([
      "CREATE TABLE d(id INTEGER PRIMARY KEY, text TEXT)",
      "CREATE INDEX di ON d USING fts (text)",
      "INSERT INTO d VALUES (1, 'client Acme Corp clause 9')",
    ]);
    const rs = await db.execute(
      "SELECT id, fts_score(text,?) AS s FROM di WHERE fts_match(text,?)", ["Acme", "Acme"]
    );
    return { ok: rs.rows.length === 1, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  } finally {
    try { await db?.close(); } catch { /* ignore */ }
  }
}

/**
 * @returns {Promise<SpikeResult>}
 */
export async function runSpike() {
  const notes = [];
  notes.push("libSQL TS client 0.17.4: browser/web build exposes only createClient (no `connect`);");
  notes.push("web build supports only libsql:/http:/ws:/file: URLs (no :memory: in-browser engine).");

  const vector = await runVector();
  const fts = await runFts();

  let wasmBytes = null;
  try {
    const resources = performance.getEntriesByType("resource");
    const found = resources.find((r) => r.name.endsWith(".wasm"));
    if (found) {
      const size = Number(Object.getOwnPropertyDescriptor(found, "transferSize")?.value);
      if (Number.isFinite(size) && size > 0) {
        wasmBytes = size;
      }
    }
  } catch { /* ignore */ }

  return {
    vector: vector.ok,
    fts: fts.ok,
    errors: { vector: vector.error, fts: fts.error },
    wasmBytes,
    notes,
  };
}
