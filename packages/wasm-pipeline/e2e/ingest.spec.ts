import { test, expect } from "@playwright/test";
import { initWasm, extractDocument, firstDocument, defaultExtractionConfig, withTesseractOcr, chunkExtraction, withChunking, embedChunks, detectPii, listPiiTypes, buildRedaction, sealVault, buildIndex, serializeIndex, pushMirror, detectCapabilities, selectScenario } from "../src/index";
import type { Matter, Folder } from "@xberg-io/core";

test("full ingest orchestration writes a mirror via pushMirror", async () => {
  await initWasm();
  const profile = await detectCapabilities();
  const scenario = selectScenario(profile);
  const base = await defaultExtractionConfig();
  const config = await withTesseractOcr(base, "tesseract");
  const chunked = await withChunking(config, { maxCharacters: scenario.chunkSize, chunkerType: "markdown" });
  const file = new File(["John Doe email john.doe@example.com invoice 12345."], "sample.txt", { type: "text/plain" });
  const result = await extractDocument(file, chunked);
  const doc = firstDocument(result);
  expect(doc).toBeTruthy();
  const chunks = chunkExtraction(doc!);
  const vectors = await embedChunks(chunks.map((c) => ({ text: c.content })), scenario);
  const items = chunks.map((c, i) => ({
    docId: "folder1",
    chunkIndex: c.metadata.chunkIndex,
    text: c.content,
    page: c.metadata.firstPage,
    citation: `folder1#chunk-${c.metadata.chunkIndex}`,
    vector: vectors[i] ?? new Float32Array(0),
  }));
  const pii = await detectPii(doc!.text ?? "", listPiiTypes(), scenario);
  const { entries } = buildRedaction(doc!.text ?? "", pii, "C");
  const sealed = await sealVault(entries, "pass");
  const payload = new TextEncoder().encode(JSON.stringify({
    version: 1,
    index: Array.from(await serializeIndex(await buildIndex("harness-matter", items))),
    vault: Array.from(sealed.cipher),
    pii: entries.map((e) => ({ doc_id: "folder1", kind: e.kind, start: e.start, end: e.end, token: e.token })),
    chunks: items.map((it, i) => ({ doc_id: it.docId, chunk_index: it.chunkIndex, text: it.text, page: it.page, citation: it.citation, score: 1 - i * 0.01 })),
  }));
  const matter: Matter = { id: "harness-matter", name: "harness", created_at: new Date().toISOString() };
  await pushMirror(matter, payload, "tok");
  expect(payload.length).toBeGreaterThan(0);
});
