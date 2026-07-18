import { test, expect } from "./harness/fixture";

test("full ingest orchestration writes a mirror via pushMirror", async ({ harness }) => {
  const result = await harness.evaluate(async () => {
    const {
      initWasm, extractDocument, firstDocument, defaultExtractionConfig, withTesseractOcr,
      chunkExtraction, withChunking, embedChunks, detectPii, listPiiTypes, buildRedaction,
      sealVault, buildIndex, serializeIndex, serializeMirrorToBytes, pushMirror,
      detectCapabilities, selectScenario,
    } = window.XbergPipeline;

    await initWasm();
    const profile = await detectCapabilities();
    const scenario = selectScenario(profile);
    const base = await defaultExtractionConfig();
    const config = await withTesseractOcr(base, "tesseract");
    const chunked = await withChunking(config, { maxCharacters: scenario.chunkSize, chunkerType: "markdown" });
    const file = new File(["John Doe email john.doe@example.com invoice 12345."], "sample.txt", { type: "text/plain" });
    const extraction = await extractDocument(file, chunked);
    const doc = firstDocument(extraction);
    if (!doc) return { ok: false, payloadLen: 0 };

    const chunks = chunkExtraction(doc);
    const vectors = await embedChunks(chunks.map((c) => ({ text: c.content })), scenario);
    const items = chunks.map((c, i) => ({
      docId: "folder1",
      chunkIndex: c.metadata.chunkIndex,
      text: c.content,
      page: c.metadata.firstPage,
      citation: `folder1#chunk-${c.metadata.chunkIndex}`,
      vector: vectors[i] ?? new Float32Array(0),
    }));
    const pii = await detectPii(doc.content ?? "", listPiiTypes(), scenario);
    const { entries } = buildRedaction(doc.content ?? "", pii, "C");
    const sealed = await sealVault(entries, "pass");
    const indexBytes = await serializeIndex(await buildIndex("harness-matter", items));
    const payload = serializeMirrorToBytes(
      indexBytes,
      sealed.cipher,
      entries.map((e) => ({ doc_id: "folder1", kind: e.kind, start: e.start, end: e.end, token: e.token })),
      items.map((it, i) => ({ doc_id: it.docId, chunk_index: it.chunkIndex, text: it.text, page: it.page, bbox: undefined, score: 1 - i * 0.01, citation: it.citation })),
    );
    const matter = { id: "harness-matter", name: "harness", created_at: new Date().toISOString() };
    // pushMirror POSTs to /rag/mirror, proxied by Vite to the MCP server on :8787.
    await pushMirror(matter, payload, "tok");
    return { ok: true, payloadLen: payload.length };
  });

  expect(result.ok).toBe(true);
  expect(result.payloadLen).toBeGreaterThan(0);
});
