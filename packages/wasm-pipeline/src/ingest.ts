import type { Matter, Folder, PiiEntity } from "@xberg-io/core";
import { extractDocument, firstDocument } from "./runtime";
import { defaultExtractionConfig, withTesseractOcr } from "./ocr";
import {
  chunkExtraction,
  withChunking,
  chunkCitation,
  chunkPage,
  chunkBoundingBox,
} from "./chunk";
import { embedChunks } from "./embed";
import { detectPii, listPiiTypes } from "./ner";
import { buildIndex, serializeIndex, type IndexedChunk } from "./rag";
import {
  buildRedaction,
  sealVault,
  sealPayload,
  type RedactionEntry,
} from "./redact";
import { pushMirror, serializeMirrorToBytes, type MirrorGraph } from "./mirror";
import { detectCapabilities } from "./capabilities";
import { selectScenario, type ModelScenario } from "./scenario";
import {
  extractEntityGraph,
  mergeEntityGraphs,
  type EntityGraph,
} from "./entity-graph";

function runPiiWhenIdle(
  text: string,
  piiTypes: readonly string[],
  scenario: ModelScenario,
): Promise<PiiEntity[]> {
  const run = () => detectPii(text, piiTypes, scenario);
  const w =
    typeof window !== "undefined"
      ? (window as Window & {
          requestIdleCallback?: (cb: () => void) => number;
        })
      : undefined;
  if (w?.requestIdleCallback) {
    const ric = w.requestIdleCallback;
    return new Promise<PiiEntity[]>((resolve) => {
      ric(() => {
        void run().then(resolve);
      });
    });
  }
  return new Promise<PiiEntity[]>((resolve) => {
    setTimeout(() => {
      void run().then(resolve);
    }, 0);
  });
}

export interface IngestOptions {
  passphrase: string;
  scopeToken: string;
  maxCharacters?: number;
  language?: string[];
  // Opt-in entity-graph extraction (droit des affaires, etc. — see entity-graph.ts). Off by default:
  // omitting this leaves ingestFolder's behavior and performance identical to before this existed.
  // Pass a label list (e.g. DROIT_DES_AFFAIRES_LABELS) to enable it for a given vertical.
  entityGraphLabels?: readonly string[];
}

export async function ingestFolder(
  matter: Matter,
  folder: Folder,
  file: File | Uint8Array,
  options: IngestOptions,
): Promise<{ accepted: number }> {
  const base = await defaultExtractionConfig();
  const ocrConfig = await withTesseractOcr(base, "tesseract", options.language);
  const profile = await detectCapabilities();
  const scenario = selectScenario(profile);
  const config = await withChunking(ocrConfig, {
    maxCharacters: options.maxCharacters ?? scenario.chunkSize,
    chunkerType: "markdown",
  });

  const result = await extractDocument(file, config);
  const doc = firstDocument(result);
  if (!doc) {
    return { accepted: 0 };
  }

  const piiTypes = listPiiTypes();
  const chunks = chunkExtraction(doc);
  const vectors = await embedChunks(chunks.map((c) => ({ text: c.content })));

  const items: IndexedChunk[] = [];
  const allEntries: RedactionEntry[] = [];
  interface PiiTask {
    item: IndexedChunk;
    piiPromise: Promise<PiiEntity[]>;
    // Runs on the same RAW (pre-redaction) chunk text as piiPromise, and must be read before
    // t.item.text is overwritten with the redacted form below — this is the one window where a
    // real entity value is in memory, the same one buildRedaction relies on.
    entityGraphPromise?: Promise<EntityGraph>;
    index: number;
  }
  const piiTasks: PiiTask[] = [];
  for (const [i, c] of chunks.entries()) {
    const v = vectors[i];
    if (!v) continue;
    const piiPromise = scenario.deferPii
      ? runPiiWhenIdle(c.content, piiTypes, scenario)
      : detectPii(c.content, piiTypes, scenario);
    const entityGraphPromise = options.entityGraphLabels
      ? extractEntityGraph(
          c.content,
          folder.id,
          c.metadata.chunkIndex,
          options.entityGraphLabels,
        )
      : undefined;
    const entry: IndexedChunk = {
      docId: folder.id,
      chunkIndex: c.metadata.chunkIndex,
      text: c.content,
      page: chunkPage(c),
      citation: chunkCitation(folder.id, c),
      bbox: chunkBoundingBox(doc, c),
      vector: v,
    };
    items.push(entry);
    piiTasks.push({ item: entry, piiPromise, entityGraphPromise, index: i });
  }

  await Promise.all(piiTasks.map((t) => t.piiPromise));
  for (const t of piiTasks) {
    const pii = await t.piiPromise;
    const { redacted, entries } = buildRedaction(
      t.item.text,
      pii,
      `C${t.index}`,
    );
    for (const e of entries) allEntries.push(e);
    t.item.text = redacted;
  }

  const db = await buildIndex(matter.id, items);
  const indexBytes = await serializeIndex(db);
  const sealed = await sealVault(allEntries, options.passphrase);

  let graph: MirrorGraph | undefined;
  if (options.entityGraphLabels) {
    const graphs = await Promise.all(
      piiTasks.map(
        (t) =>
          t.entityGraphPromise ?? Promise.resolve({ nodes: [], edges: [] }),
      ),
    );
    const merged = mergeEntityGraphs(graphs);
    if (merged.nodes.length > 0 || merged.edges.length > 0) {
      const sealedGraph = await sealPayload(merged, options.passphrase);
      graph = {
        cipher: Array.from(sealedGraph.cipher),
        salt: Array.from(sealedGraph.salt),
      };
    }
  }

  const payload = serializeMirrorToBytes(
    indexBytes,
    sealed.cipher,
    sealed.salt,
    [],
    [],
    graph,
  );
  await pushMirror(matter.id, payload, options.scopeToken);

  return { accepted: items.length };
}
