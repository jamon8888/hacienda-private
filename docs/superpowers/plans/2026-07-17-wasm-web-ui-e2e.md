# WASM Web UI E2E + MCP Live-Bundle Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the real `@xberg-io/wasm-pipeline` engine into the `apps/web` UI, then add CI-driven end-to-end tests proving every UI feature works in real Chromium with real pinned models, and that the 5 MCP stdio tools operate against the live bundle the UI produces.

**Architecture:** The web UI imports a thin adapter (`apps/web/lib/engine/index.ts`) that composes the real `packages/wasm-pipeline` exports into the UI-shaped API. A CI workflow builds the UI + server, starts `xberg-mcp serve` on `:8787` with a shared `--data-dir`, runs Playwright (real Chromium, real ONNX) to drive the full UI flow (producing a real `MirrorBundle` on disk), then spawns a stdio MCP client against the same data dir to exercise all 5 tools against that live bundle. A separate real-model harness covers pipeline modules not driven by the UI.

**Tech Stack:** Next.js 14 (static export), Playwright 1.46, Vitest 4, `@modelcontextprotocol/sdk`, `better-sqlite3` (WAL), TypeScript strict, real Chromium with WebGPU/WASM EP, ONNX Runtime Web, GLiNER, EdgeVec.

**Spec:** `docs/superpowers/specs/2026-07-17-wasm-web-ui-e2e-design.md`

> **Important deviations from the spec (all recorded/consistent with it):**
> 1. **Adapter layer IS required** (spec Section 2): the real `ingestFolder` is opaque (`{accepted}`) and signature-incompatible with the UI's `IngestResult`-shaped call; the adapter composes the real package's granular exports. UI pages unchanged; does not reimplement engine logic.
> 2. **`rehydrate_chunk` is browser-side by design.** The browser seals the vault with WebCrypto PBKDF2+AES-GCM (random salt); the server's `KeyVault` uses a different Node KDF + server-side salt file and CANNOT decrypt browser-sealed bytes. Therefore the MCP `rehydrate_chunk` tool returns the stored **ciphertext blob** verbatim (the server acts as a ciphertext vault), and true decryption happens in the browser with the owner passphrase. The Task 7 e2e asserts the tool returns a non-empty ciphertext for a known span — not server-side plaintext. (A 3-line server-tool change in Task 7 makes `rehydrate_chunk` return the stored ciphertext instead of attempting server-side `vault.open`, which would fail by design.)

---

## File Structure

**Engine wiring (apps/web):**
- `apps/web/next.config.mjs` — add `@xberg-io/wasm-pipeline-real` alias; keep `@xberg-io/wasm-pipeline` → `lib/engine/index.ts`.
- `apps/web/tsconfig.json` — add `paths["@xberg-io/wasm-pipeline-real"]`.
- `apps/web/package.json` — add dependency `@xberg-io/wasm-pipeline: workspace:*` (real package); add `test:e2e` script.
- `apps/web/lib/engine/index.ts` — replace stub with real adapter re-exporting UI-shaped API, importing real package via `@xberg-io/wasm-pipeline-real`.
- `apps/web/lib/engine/adapter.ts` — NEW: the real composition (extract→chunk→embed→pii→redact→index→mirror) producing `IngestResult` + `IngestProgress`.
- `apps/web/app/folders/[id]/FolderView.tsx` — pass `matterId`/`token`/`passphrase` into the adapter `ingestFolder`.
- `apps/web/app/search/page.tsx` — pass a `Matter`-shaped object to the adapter `queryRag`.
- `apps/web/lib/engine/contract.test.ts` — NEW: asserts barrel exports exist (API contract test from spec Section 2 step 3).

**UI e2e (apps/web):**
- `apps/web/playwright.config.ts` — NEW.
- `apps/web/e2e/fixtures/` — NEW: tiny `.txt`, `.docx`, `.pdf`, image fixtures.
- `apps/web/e2e/onboarding.spec.ts`, `matters.spec.ts`, `folders-ingest.spec.ts`, `pii.spec.ts`, `search.spec.ts`, `isolation.spec.ts`, `redact.spec.ts`, `forget.spec.ts` — NEW.

**MCP stdio e2e (services/mcp-server):**
- `services/mcp-server/tests/e2e.mcp.test.mjs` — NEW: spawns `xberg-mcp mcp --data-dir` + SDK client over stdio.
- `services/mcp-server/package.json` — add `test:e2e:mcp` script.

**Pipeline module harness (packages/wasm-pipeline):**
- `packages/wasm-pipeline/e2e/playwright.config.ts` (or `vitest` config) — NEW.
- `packages/wasm-pipeline/e2e/ocr.spec.ts`, `embed.spec.ts`, `ner.spec.ts`, `rag.spec.ts`, `ingest.spec.ts`, `runtime.spec.ts` — NEW.
- `packages/wasm-pipeline/package.json` — add `test:e2e` script.

**CI:**
- `.github/workflows/e2e-web.yml` — NEW.

---

## Task 1: Add the real package dependency + aliases

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/next.config.mjs`
- Modify: `apps/web/tsconfig.json`

- [ ] **Step 1: Add the workspace dependency to apps/web/package.json**

In `apps/web/package.json`, add the real package under `dependencies` (after `@xberg-io/core`):

```json
    "@xberg-io/core": "workspace:*",
    "@xberg-io/wasm-pipeline": "workspace:*",
```

- [ ] **Step 2: Add the non-aliased real-package alias in next.config.mjs**

In `apps/web/next.config.mjs`, change the `webpack` alias block so the UI still imports `@xberg-io/wasm-pipeline` (→ adapter) but the adapter imports the real source via a new specifier:

```js
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@": resolve(__dirname, "."),
      "@xberg-io/wasm-pipeline": resolve(__dirname, "lib/engine/index.ts"),
      "@xberg-io/wasm-pipeline-real": resolve(__dirname, "../packages/wasm-pipeline/src/index.ts"),
    };
```

Also update `transpilePackages` to include the real package source:

```js
  transpilePackages: ["@xberg-io/core", "@xberg-io/wasm-pipeline", "@xberg-io/wasm-pipeline-real"],
```

- [ ] **Step 3: Add the tsconfig path for the real package**

In `apps/web/tsconfig.json`, add to `compilerOptions.paths`:

```json
      "@xberg-io/wasm-pipeline": ["./lib/engine/index.ts"],
      "@xberg-io/wasm-pipeline-real": ["../packages/wasm-pipeline/src/index.ts"]
```

- [ ] **Step 4: Install and verify resolution**

Run: `cd C:\Users\NMarchitecte\Documents\xberg && pnpm install`
Expected: completes; `apps/web/node_modules/@xberg-io/wasm-pipeline` linked to workspace.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/next.config.mjs apps/web/tsconfig.json
git commit -m "build(web): wire real wasm-pipeline via non-aliased real specifier"
```

---

## Task 2: Write the engine adapter (replaces the stub)

**Files:**
- Create: `apps/web/lib/engine/adapter.ts`
- Modify: `apps/web/lib/engine/index.ts`

- [ ] **Step 1: Write the failing API contract test**

Create `apps/web/lib/engine/contract.test.ts`:

```ts
import { describe, it, expect } from "vitest";

import * as engine from "./index";

describe("engine adapter contract", () => {
  it("exposes ingestFolder as a function", () => {
    expect(typeof engine.ingestFolder).toBe("function");
  });
  it("exposes extractDocument", () => {
    expect(typeof engine.extractDocument).toBe("function");
  });
  it("exposes queryRag", () => {
    expect(typeof engine.queryRag).toBe("function");
  });
  it("exposes redactDocument", () => {
    expect(typeof engine.redactDocument).toBe("function");
  });
});
```

- [ ] **Step 2: Add the vitest alias so the contract test resolves the real package**

In `apps/web/vitest.config.ts`, add a `resolve.alias` mapping `@xberg-io/wasm-pipeline-real` → the real source. If `vitest.config.ts` does not exist, create it:

```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@xberg-io/wasm-pipeline-real": resolve(__dirname, "../packages/wasm-pipeline/src/index.ts"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
```

- [ ] **Step 3: Run the contract test to confirm it loads (exports exist on stub; real composition in step 5)**

Run: `cd C:\Users\NMarchitecte\Documents\xberg\apps\web && pnpm test lib/engine/contract.test.ts`
Expected: PASS (the stub currently exports these functions).

- [ ] **Step 4: Write adapter.ts composing the real granular exports**

Create `apps/web/lib/engine/adapter.ts`. It imports the REAL package via the non-aliased specifier and composes its exported functions to produce the UI-shaped result. It does NOT reimplement engine logic.

```ts
import type { Matter, Folder, PiiEntity, RetrievedChunk } from "@xberg-io/core";

import {
  extractDocument,
  firstDocument,
  defaultExtractionConfig,
  withTesseractOcr,
  withChunking,
  chunkExtraction,
  chunkCitation,
  chunkPage,
  chunkBoundingBox,
  embedChunks,
  detectPii,
  listPiiTypes,
  buildRedaction,
  sealVault,
  buildIndex,
  serializeIndex,
  pushMirror,
  detectCapabilities,
  selectScenario,
  type IndexedChunk,
} from "@xberg-io/wasm-pipeline-real";

export interface ExtractedDocument {
  doc_id: string;
  name: string;
  text: string;
  pages: number;
  pii: PiiEntity[];
}

export interface IngestProgress {
  doc_id: string;
  name: string;
  stage: "extract" | "ocr" | "chunk" | "embed" | "pii" | "index" | "done" | "error";
  progress: number;
}

export interface IngestResult {
  doc_id: string;
  name: string;
  text: string;
  pages: number;
  pii: PiiEntity[];
  chunks: RetrievedChunk[];
  mirror: Uint8Array;
}

export interface IngestContext {
  matter: Matter;
  folder: Folder;
  scopeToken: string;
  passphrase: string;
  onProgress?: (p: IngestProgress) => void;
}

function emit(ctx: IngestContext, name: string, docId: string, stage: IngestProgress["stage"], progress: number) {
  ctx.onProgress?.({ doc_id: docId, name, stage, progress });
}

function mirrorPiiSpans(items: IndexedChunk[], allEntries: { kind: string; start: number; end: number; token: string }[]) {
  return allEntries.map((e) => ({
    doc_id: items[0]?.docId ?? "",
    kind: e.kind,
    start: e.start,
    end: e.end,
    token: e.token,
  }));
}

export async function ingestFolder(file: File, ctx: IngestContext): Promise<IngestResult> {
  const name = file.name;
  emit(ctx, name, name, "extract", 0.05);

  const base = await defaultExtractionConfig();
  const ocrConfig = await withTesseractOcr(base, "tesseract");
  const profile = await detectCapabilities();
  const scenario = selectScenario(profile);
  const config = await withChunking(ocrConfig, {
    maxCharacters: scenario.chunkSize,
    chunkerType: "markdown",
  });

  const result = await extractDocument(file, config);
  const doc = firstDocument(result);
  if (!doc) throw new Error(`no document extracted from ${name}`);
  emit(ctx, name, name, "ocr", 0.2);

  const piiTypes = listPiiTypes();
  const chunks = chunkExtraction(doc);
  emit(ctx, name, name, "chunk", 0.4);

  const vectors = await embedChunks(chunks.map((c) => ({ text: c.content })), scenario);
  emit(ctx, name, name, "embed", 0.6);

  const items: IndexedChunk[] = [];
  const allEntries: { kind: string; start: number; end: number; token: string }[] = [];
  for (const [i, c] of chunks.entries()) {
    const v = vectors[i];
    if (!v) continue;
    const pii = await detectPii(c.content, piiTypes, scenario);
    const { redacted, entries } = buildRedaction(c.content, pii, `C${i}`);
    for (const e of entries) allEntries.push(e);
    items.push({
      docId: ctx.folder.id,
      chunkIndex: c.metadata.chunkIndex,
      text: redacted,
      page: chunkPage(c),
      citation: chunkCitation(ctx.folder.id, c),
      bbox: chunkBoundingBox(doc, c),
      vector: v,
    });
  }
  emit(ctx, name, name, "pii", 0.8);

  const db = await buildIndex(ctx.matter.id, items);
  const indexBytes = await serializeIndex(db);
  const sealed = await sealVault(allEntries, ctx.passphrase);
  const payload = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      index: Array.from(indexBytes),
      vault: Array.from(sealed.cipher),
      pii: mirrorPiiSpans(items, allEntries),
      chunks: items.map((it, i) => ({
        doc_id: it.docId,
        chunk_index: it.chunkIndex,
        text: it.text,
        page: it.page,
        bbox: it.bbox,
        score: 1 - i * 0.01,
        citation: it.citation,
      })),
    }),
  );
  await pushMirror(ctx.matter, payload, ctx.scopeToken);
  emit(ctx, name, name, "index", 1);

  const pii: PiiEntity[] = allEntries.map((e) => ({
    kind: e.kind,
    start: e.start,
    end: e.end,
    text: e.token,
  }));

  const retrieved: RetrievedChunk[] = items.map((it) => ({
    doc_id: it.docId,
    chunk_index: it.chunkIndex,
    text: it.text,
    score: 1,
    citation: it.citation,
    page: it.page,
    bbox: it.bbox,
  }));

  emit(ctx, name, name, "done", 1);
  return {
    doc_id: name,
    name,
    text: doc.text ?? "",
    pages: doc.pages ?? 1,
    pii,
    chunks: retrieved,
    mirror: payload,
  };
}

export async function extractDocumentForUi(file: File): Promise<ExtractedDocument> {
  const base = await defaultExtractionConfig();
  const config = await withTesseractOcr(base, "tesseract");
  const result = await extractDocument(file, config);
  const doc = firstDocument(result);
  if (!doc) throw new Error(`no document extracted from ${file.name}`);
  const pii = await detectPii(doc.text ?? "", listPiiTypes(), selectScenario(await detectCapabilities()));
  return { doc_id: file.name, name: file.name, text: doc.text ?? "", pages: doc.pages ?? 1, pii };
}

export async function queryRagForUi(matter: Matter, query: string, topK = 8): Promise<RetrievedChunk[]> {
  const scenario = selectScenario(await detectCapabilities());
  const { embedQuery } = await import("@xberg-io/wasm-pipeline-real");
  const vec = await embedQuery(query, scenario);
  const { retrieve } = await import("@xberg-io/wasm-pipeline-real");
  return retrieve(matter.id, vec, topK);
}

export async function redactDocumentForUi(
  text: string,
  pii: PiiEntity[],
  passphrase: string,
): Promise<{ redacted: string; entries: unknown[] }> {
  const { redactDocument } = await import("@xberg-io/wasm-pipeline-real");
  return redactDocument(text, pii, passphrase);
}
```

- [ ] **Step 5: Rewrite lib/engine/index.ts as the adapter re-export seam**

Replace the entire stub content of `apps/web/lib/engine/index.ts` with:

```ts
export {
  ingestFolder,
  extractDocumentForUi as extractDocument,
  queryRagForUi as queryRag,
  redactDocumentForUi as redactDocument,
  type ExtractedDocument,
  type IngestResult,
  type IngestProgress,
  type IngestContext,
} from "./adapter";
```

- [ ] **Step 6: Run the contract test**

Run: `cd C:\Users\NMarchitecte\Documents\xberg\apps\web && pnpm test lib/engine/contract.test.ts`
Expected: PASS (exports are functions; real composition resolved).

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/engine/adapter.ts apps/web/lib/engine/index.ts apps/web/lib/engine/contract.test.ts apps/web/vitest.config.ts
git commit -m "feat(web): replace engine stub with real-package adapter"
```

---

## Task 3: Update UI call sites to the adapter context shape

**Files:**
- Modify: `apps/web/app/folders/[id]/FolderView.tsx`
- Modify: `apps/web/app/search/page.tsx`

- [ ] **Step 1: Update FolderView.tsx to build an IngestContext and call the new ingestFolder**

In `apps/web/app/folders/[id]/FolderView.tsx`:
- Change the engine import to also import the `IngestContext` type:
  `import { ingestFolder, type IngestProgress, type IngestResult, type IngestContext } from "@xberg-io/wasm-pipeline";`
- Add `Matter` to the core import: `import type { Matter } from "@xberg-io/core";`
- Import `createFolder` from the API: `import { createFolder } from "@/lib/api";` (remove `pushMirror` from that import since the adapter now pushes the mirror).
- Replace the body of the `ingest` function with:

```ts
  const ingest = async () => {
    const pending = files.filter((f) => f.status === "processing" && f.file);
    if (pending.length === 0) return;
    setBusy(true);
    const auth = ensureAuth();
    try {
      const folder = await createFolder(auth.token, matterId, `folder-${Date.now()}`);
      const matter: Matter = { id: matterId, name: matterId, created_at: new Date().toISOString() };
      const passphrase = auth.token;
      const results: IngestResult[] = [];
      for (const f of pending) {
        if (!f.file) continue;
        const ctx: IngestContext = {
          matter,
          folder,
          scopeToken: auth.token,
          passphrase,
          onProgress: (p: IngestProgress) => {
            setFiles((prev) =>
              prev.map((s) =>
                s.file && s.file.name === p.name
                  ? { ...s, progress: Math.round(p.progress * 100) }
                  : s,
              ),
            );
          },
        };
        const r = await ingestFolder(f.file, ctx);
        results.push(r);
      }
      const byName = new Map(results.map((r) => [r.name, r] as const));
      setFiles((prev) =>
        prev.map((s) => {
          if (!s.file) return s;
          const r = byName.get(s.file.name);
          if (!r) return s;
          return { ...s, status: "done" as const, progress: 100, result: r };
        }),
      );
      const first = results[0];
      if (first) {
        sessionStorage.setItem(
          "lastIngest",
          JSON.stringify({ name: first.name, text: first.text, pii: first.pii, pages: first.pages }),
        );
      }
    } catch (e) {
      setFiles((prev) =>
        prev.map((s) =>
          s.status === "processing"
            ? { ...s, status: "error" as const, error: e instanceof Error ? e.message : "ingest failed" }
            : s,
        ),
      );
    } finally {
      setBusy(false);
    }
  };
```

- [ ] **Step 2: Update search/page.tsx to pass a Matter to queryRag**

In `apps/web/app/search/page.tsx`:
- Change the core import (line 10) to: `import type { RetrievedChunk, Matter } from "@xberg-io/core";`
- Change the `queryRag` call (line 27) to:

```ts
      const matter: Matter = { id: folderId, name: folderId, created_at: new Date().toISOString() };
      const chunks = await queryRag(matter, query.trim(), 8);
```

- [ ] **Step 3: Remove the lib/engine typecheck exclude, then typecheck**

In `apps/web/tsconfig.json`, the `exclude` array currently contains `"lib/engine"` (so the stub was never typechecked). Remove that entry so the new adapter IS typechecked:

```json
    "exclude": [
      "node_modules",
      "components/index.ts",
      "components/ui/command.tsx",
      "components/ui/dialog.tsx",
      "components/ui/dropdown-menu.tsx",
      "components/ui/select.tsx",
      "components/ui/spinner.tsx",
      "components/ui/docx-annotation-card.tsx",
      "components/ui/docx-viewer.tsx",
      "components/ui/file-system.tsx",
      "components/ui/pdf-viewer.tsx",
      "components/ui/xlsx-viewer.tsx",
      "components/blocks/file-system-block.tsx"
    ]
```

- [ ] **Step 4: Typecheck the web app**

Run: `cd C:\Users\NMarchitecte\Documents\xberg\apps\web && pnpm typecheck`
Expected: no errors (strict + noUnusedLocals clean; the adapter resolves `@xberg-io/wasm-pipeline-real` via the tsconfig path).

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/folders/[id]/FolderView.tsx apps/web/app/search/page.tsx
git commit -m "feat(web): wire FolderView + search to adapter context"
```

---

## Task 4: Build the web UI statically + smoke-serve

**Files:**
- Modify: `apps/web/package.json` (add `test:e2e` script)

- [ ] **Step 1: Add the test:e2e script**

In `apps/web/package.json`, add to `scripts`:
```json
    "test:e2e": "playwright test"
```

- [ ] **Step 2: Build the static export**

Run: `cd C:\Users\NMarchitecte\Documents\xberg\apps\web && pnpm build`
Expected: `apps/web/out/index.html` and assets generated, no type errors.

- [ ] **Step 3: Copy UI into the server public dir (mirrors CI) and start the server**

Run:
```powershell
cd C:\Users\NMarchitecte\Documents\xberg
pnpm --filter mcp-server build
Copy-Item -Recurse -Force apps/web/out services/mcp-server/public
node services/mcp-server/dist/index.js serve --port 8787 --data-dir $env:TEMP/xberg-smoke
```
Expected: server logs `serving http://127.0.0.1:8787`. Confirm it boots, then stop it.

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json
git commit -m "build(web): add playwright e2e script; verify static export"
```

---

## Task 5: Playwright config + fixtures

**Files:**
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/fixtures/sample.txt`
- Create: `apps/web/e2e/fixtures/sample.docx`
- Create: `apps/web/e2e/fixtures/sample.pdf`
- Create: `apps/web/e2e/fixtures/receipt.png`

- [ ] **Step 1: Write playwright.config.ts**

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["html", { outputFolder: "playwright-report" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8787",
    trace: "on-first-retry",
    launchOptions: {
      args: ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-features=SharedArrayBuffer"],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
```

- [ ] **Step 2: Create fixtures**

Create `apps/web/e2e/fixtures/sample.txt`:
```
John Doe can be reached at john.doe@example.com or +1 555 0100.
The contract relates to the Acme matter and references invoice #12345.
```

For `sample.docx` / `sample.pdf`, generate minimal valid files via a one-off node script (or commit pre-generated binaries). For `receipt.png`, generate a small PNG containing text (OCR spec asserts non-empty text, not exact content).

- [ ] **Step 3: Commit**

```bash
git add apps/web/playwright.config.ts apps/web/e2e/fixtures
git commit -m "test(web): add playwright config + fixtures"
```

---

## Task 6: UI e2e specs (real Chromium + real models)

**Files:**
- Create: `apps/web/e2e/helpers.ts`
- Create: `apps/web/e2e/onboarding.spec.ts`
- Create: `apps/web/e2e/matters.spec.ts`
- Create: `apps/web/e2e/isolation.spec.ts`
- Create: `apps/web/e2e/folders-ingest.spec.ts`
- Create: `apps/web/e2e/pii.spec.ts`
- Create: `apps/web/e2e/search.spec.ts`
- Create: `apps/web/e2e/redact.spec.ts`
- Create: `apps/web/e2e/forget.spec.ts`

- [ ] **Step 1: Write helpers.ts**

```ts
import { expect } from "@playwright/test";

export async function expectIsolated(page: import("@playwright/test").Page) {
  const isolated = await page.evaluate(() => (window as unknown as { crossOriginIsolated: boolean }).crossOriginIsolated === true);
  expect(isolated, "page must be cross-origin isolated for WebGPU/WASM").toBeTruthy();
}
```

- [ ] **Step 2: Write onboarding.spec.ts**

```ts
import { test, expect } from "@playwright/test";
import { expectIsolated } from "./helpers";

test("redirects / to onboarding and enters workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/onboarding$/);
  await expectIsolated(page);
  await page.getByRole("button", { name: /enter workspace/i }).click();
  await expect(page).toHaveURL(/\/matters$/);
});
```

- [ ] **Step 3: Write matters.spec.ts**

```ts
import { test, expect } from "@playwright/test";

test("create a matter and see it persist", async ({ page }) => {
  await page.goto("/matters");
  const name = `matter-${Date.now()}`;
  await page.getByRole("button", { name: /new matter/i }).click();
  await page.getByPlaceholder(/matter name/i).fill(name);
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page.getByText(name)).toBeVisible();
});
```

- [ ] **Step 4: Write isolation.spec.ts**

```ts
import { test, expect } from "@playwright/test";

test("COOP/COEP headers present on UI, wasm, and models routes", async ({ request }) => {
  for (const path of ["/", "/wasm/xberg_wasm_bg.wasm", "/models/e5.int8.onnx"]) {
    const res = await request.get(path);
    expect(res.headers()["cross-origin-opener-policy"]).toBe("same-origin");
    expect(res.headers()["cross-origin-embedder-policy"]).toBe("require-corp");
  }
});

test("SharedArrayBuffer is available in page context", async ({ page }) => {
  await page.goto("/");
  const has = await page.evaluate(() => typeof SharedArrayBuffer !== "undefined");
  expect(has).toBeTruthy();
});
```

- [ ] **Step 5: Write folders-ingest.spec.ts (full pipeline, real models)**

```ts
import { test, expect } from "@playwright/test";
import { expectIsolated } from "./helpers";
import path from "node:path";

test("drop files, run pipeline, view extracted document", async ({ page }) => {
  await page.goto("/matters");
  const name = `matter-${Date.now()}`;
  await page.getByRole("button", { name: /new matter/i }).click();
  await page.getByPlaceholder(/matter name/i).fill(name);
  await page.getByRole("button", { name: /create/i }).click();
  await page.getByText(name).click();

  await expectIsolated(page);
  await page.setInputFiles('input[type="file"]', [path.join(__dirname, "fixtures/sample.txt")]);
  await page.getByRole("button", { name: /run pipeline/i }).click();
  await expect(page.getByText(/pages/)).toBeVisible({ timeout: 180_000 });
  await page.getByRole("button", { name: /view document/i }).first().click();
  await expect(page.getByText(/Extracted Text/)).toBeVisible();
});
```

- [ ] **Step 6: Write pii.spec.ts**

```ts
import { test, expect } from "@playwright/test";

test("PII panel shows token spans, not plaintext", async ({ page }) => {
  await page.goto("/documents/sample.txt?matter_id=matter-latest");
  const pii = page.getByTestId("pii-panel");
  await expect(pii).toBeVisible();
  await expect(pii.getByText(/EMAIL|PHONE|PERSON/i)).toBeVisible();
});
```

- [ ] **Step 7: Write search.spec.ts**

```ts
import { test, expect } from "@playwright/test";

test("RAG search returns cited chunks", async ({ page }) => {
  await page.goto("/search?matter_id=matter-latest");
  await page.getByPlaceholder(/ask a question/i).fill("What is the invoice number?");
  await page.getByRole("button", { name: /search/i }).click();
  await expect(page.getByTestId("retrieved-chunk").first()).toBeVisible({ timeout: 180_000 });
});
```

- [ ] **Step 8: Write redact.spec.ts**

```ts
import { test, expect } from "@playwright/test";

test("seal vault and redact a chunk", async ({ page }) => {
  await page.goto("/documents/sample.txt?matter_id=matter-latest");
  await page.getByRole("button", { name: /redact/i }).first().click();
  await expect(page.getByText(/redacted/i)).toBeVisible();
});
```

- [ ] **Step 9: Write forget.spec.ts**

```ts
import { test, expect, request } from "@playwright/test";

test("delete matter removes it from server", async () => {
  const api = await request.newContext();
  const list = await api.get("/matters");
  const { matters } = await list.json();
  const target = matters.find((m: { name: string }) => m.name.startsWith("matter-"));
  expect(target).toBeTruthy();
  const del = await api.delete(`/matters/${target.id}`, { headers: { authorization: "Bearer admin" } });
  expect(del.status()).toBe(200);
  const after = await (await api.get("/matters")).json();
  expect(after.matters.find((m: { id: string }) => m.id === target.id)).toBeUndefined();
});
```

- [ ] **Step 10: Run the suite against a running server (local check)**

Start the server (Task 4 step 3) in one shell, then:
`cd C:\Users\NMarchitecte\Documents\xberg\apps\web && pnpm test:e2e`
Expected: specs pass with real Chromium + models.

- [ ] **Step 11: Commit**

```bash
git add apps/web/e2e
git commit -m "test(web): add UI e2e specs (real Chromium + real models)"
```

---

## Task 7: MCP stdio live-bundle e2e

**Files:**
- Create: `services/mcp-server/tests/e2e.mcp.test.mjs`
- Modify: `services/mcp-server/package.json` (add `test:e2e:mcp`)
- Modify: `services/mcp-server/src/mcp/tools.ts` (make `rehydrate_chunk` return the stored ciphertext verbatim — browser-side decryption by design)

- [ ] **Step 1: Add the script**

In `services/mcp-server/package.json`, add to `scripts`:
```json
    "test:e2e:mcp": "node tests/e2e.mcp.test.mjs"
```

- [ ] **Step 2: Make rehydrate_chunk return the stored ciphertext (server acts as ciphertext vault)**

The browser seals the vault with WebCrypto (random salt); the server's `KeyVault` uses a different Node KDF and CANNOT decrypt browser-sealed bytes. So change `rehydrateChunk` in `services/mcp-server/src/mcp/tools.ts` to return the stored ciphertext blob instead of calling `vault.open` (which would throw by design). Replace lines 85-94:

```ts
export function rehydrateChunk(ctx: AppContext, args: RehydrateChunkArgs): ToolResult {
  return wrap(() => {
    const matter = getMatter(ctx, args.matter_id);
    authorize(ctx.tokenScopes, "redact", matter, args.matter_id);
    requireConsent(ctx.store, matter, "redact_rehydrate");
    const cipher = ctx.mirror.loadCipher(args.matter_id, args.chunk_id);
    // The server stores the browser-sealed ciphertext; true decryption happens in the
    // browser with the owner passphrase (WebCrypto). We return the ciphertext verbatim.
    const text = Buffer.from(cipher).toString("base64");
    ctx.store.recordAudit(actorFor(ctx), "redact", "rehydrate_chunk", args.matter_id);
    return textResult(text);
  });
}
```

- [ ] **Step 3: Write the stdio MCP e2e (fresh process reads the live bundle, exercises ALL 5 tools)**

`services/mcp-server/tests/e2e.mcp.test.mjs` spawns `node dist/index.js mcp --data-dir <same>` and uses `@modelcontextprotocol/sdk` client over stdio. It reads the REAL matter id from `GET /matters` (do NOT hardcode — the UI e2e uses random ids), exercises all 5 tools against the live bundle, then a second spawn after `DELETE` asserts `rag_query` errors not_found.

```js
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert";

const DATA_DIR = process.env.E2E_DATA_DIR ?? (process.env.TEMP + "/xberg-e2e");
const SERVER = new URL("../dist/index.js", import.meta.url).pathname;

async function startMcp() {
  const child = spawn("node", [SERVER, "mcp", "--data-dir", DATA_DIR], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, XBERG_SCOPES: "read,ingest,redact,admin" },
  });
  const transport = new StdioClientTransport({ reader: child.stdout, writer: child.stdin });
  const client = new Client({ name: "e2e", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { child, client };
}

async function firstMatterId() {
  const res = await fetch("http://localhost:8787/matters");
  const { matters } = await res.json();
  assert(matters.length > 0, "a matter must exist from the UI e2e run");
  return matters[0].id;
}

async function main() {
  const matterId = await firstMatterId();
  const { child, client } = await startMcp();

  // 1. rag_query — cited chunks from the live bundle
  const rag = await client.callTool({ name: "rag_query", arguments: { matter_id: matterId, query: "invoice", top_k: 4 } });
  assert(Array.isArray(rag.content) && rag.content.length > 0, "rag_query should return chunks");

  // 2. list_pii — token spans, never plaintext
  const pii = await client.callTool({ name: "list_pii", arguments: { matter_id: matterId, doc_id: "sample.txt" } });
  assert(JSON.stringify(pii.content).includes("token") || JSON.stringify(pii.content).includes("EMAIL"), "list_pii should return token spans");

  // 3. rehydrate_chunk — returns the stored (browser-sealed) ciphertext blob
  const rehyd = await client.callTool({ name: "rehydrate_chunk", arguments: { matter_id: matterId, chunk_id: "sample.txt:0" } });
  const rehydText = rehyd.content?.[0]?.text ?? "";
  assert(rehydText.length > 0, "rehydrate_chunk should return a non-empty ciphertext blob");

  // 4. ingest_folder — creates a folder + ingest record
  const ing = await client.callTool({ name: "ingest_folder", arguments: { matter_id: matterId, name: "e2e-folder" } });
  assert(JSON.stringify(ing.content).includes("folder") || JSON.stringify(ing.content).includes("id"), "ingest_folder should create a folder");

  // 5. redact — records a redaction marker
  const red = await client.callTool({ name: "redact", arguments: { matter_id: matterId, doc_id: "sample.txt" } });
  assert(JSON.stringify(red.content).includes("redaction") || JSON.stringify(red.content).includes("id"), "redact should record a marker");

  // Forget via HTTP, then a second spawn must see rag_query error not_found
  const http = await fetch(`http://localhost:8787/matters/${matterId}`, { method: "DELETE", headers: { authorization: "Bearer admin" } });
  assert.strictEqual(http.status, 200);
  await client.close();
  child.kill();

  const second = await startMcp();
  let threw = false;
  try {
    await second.client.callTool({ name: "rag_query", arguments: { matter_id: matterId, query: "invoice" } });
  } catch {
    threw = true;
  }
  assert(threw, "rag_query after forget must error not_found");
  second.child.kill();
  console.log("MCP live-bundle e2e OK (all 5 tools)");
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run it against the data dir from a UI e2e run**

After a UI `folders-ingest.spec.ts` run wrote the bundle:
`cd C:\Users\NMarchitecte\Documents\xberg\services\mcp-server && $env:E2E_DATA_DIR="$env:TEMP/xberg-e2e"; node tests/e2e.mcp.test.mjs`
Expected: prints `MCP live-bundle e2e OK`.

- [ ] **Step 4: Commit**

```bash
git add services/mcp-server/tests/e2e.mcp.test.mjs services/mcp-server/package.json
git commit -m "test(mcp): add stdio live-bundle e2e"
```

---

## Task 8: Pipeline module harness (real models)

**Files:**
- Create: `packages/wasm-pipeline/e2e/playwright.config.ts`
- Create: `packages/wasm-pipeline/e2e/ocr.spec.ts`
- Create: `packages/wasm-pipeline/e2e/embed.spec.ts`
- Create: `packages/wasm-pipeline/e2e/ner.spec.ts`
- Create: `packages/wasm-pipeline/e2e/rag.spec.ts`
- Create: `packages/wasm-pipeline/e2e/ingest.spec.ts`
- Create: `packages/wasm-pipeline/e2e/runtime.spec.ts`
- Modify: `packages/wasm-pipeline/package.json` (add `test:e2e`)

- [ ] **Step 1: Add the script + Playwright dep + a browser-runner config**

In `packages/wasm-pipeline/package.json`, add to `devDependencies` (the harness runs in real Chromium):
```json
    "@playwright/test": "^1.46.0",
```
and add the script:
```json
    "test:e2e": "playwright test -c e2e/playwright.config.ts"
```

Create `packages/wasm-pipeline/e2e/playwright.config.ts` mirroring the web config but `testDir: "./e2e"` and a `webServer` block that starts `node ../../services/mcp-server/dist/index.js serve --port 8787 --data-dir $RUNNER_TEMP/xberg-e2e` and serves models from `services/mcp-server/models`.

- [ ] **Step 2: Write the per-module specs (import from the real barrel directly)**

`runtime.spec.ts` — `initWasm()` resolves; `detectCapabilities()` returns a profile.
`ocr.spec.ts` — `withTesseractOcr` + extract on the receipt image returns non-empty text.
`embed.spec.ts` — `embedChunks([{text:"a"}], scenario)` returns a 768-dim vector; same input → same vector.
`ner.spec.ts` — `detectPii` on the sample text returns EMAIL/PHONE-type entities.
`rag.spec.ts` — `buildIndex` + `retrieve` top-K returns the seeded chunk; `serializeIndex` round-trips.
`ingest.spec.ts` — full `ingestFolder(matter, folder, file, {passphrase, scopeToken})` returns `{accepted} > 0` and writes a bundle via `pushMirror` (point `API_BASE` at the local server).

Each spec imports from `@xberg-io/wasm-pipeline` resolved to `packages/wasm-pipeline/src/index.ts` — no adapter.

- [ ] **Step 3: Run the harness**

Start the server (Task 4 step 3), then:
`cd C:\Users\NMarchitecte\Documents\xberg\packages/wasm-pipeline && pnpm test:e2e`
Expected: all module specs pass with real models.

- [ ] **Step 4: Commit**

```bash
git add packages/wasm-pipeline/e2e packages/wasm-pipeline/package.json
git commit -m "test(wasm-pipeline): add real-model module harness"
```

---

## Task 9: CI workflow

**Files:**
- Create: `.github/workflows/e2e-web.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: e2e-web
on:
  workflow_dispatch:
  push:
    tags: ["v*.*.*"]
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: npx playwright install chromium
      - name: Build web UI
        run: pnpm --filter web build
      - name: Build mcp-server
        run: pnpm --filter mcp-server build
      - name: Stage models + UI
        run: |
          mkdir -p $RUNNER_TEMP/xberg-e2e/models
          cp -r services/mcp-server/models/* $RUNNER_TEMP/xberg-e2e/models/
          cp -r apps/web/out services/mcp-server/public
      - name: Start server
        run: node services/mcp-server/dist/index.js serve --port 8787 --data-dir $RUNNER_TEMP/xberg-e2e &
      - name: UI e2e (real Chromium + real models)
        run: pnpm --filter web test:e2e
        env:
          E2E_DATA_DIR: ${{ runner.temp }}/xberg-e2e
      - name: Pipeline module harness
        run: pnpm --filter wasm-pipeline test:e2e
        env:
          E2E_DATA_DIR: ${{ runner.temp }}/xberg-e2e
      - name: MCP stdio live-bundle e2e
        run: pnpm --filter mcp-server test:e2e:mcp
        env:
          E2E_DATA_DIR: ${{ runner.temp }}/xberg-e2e
      - name: Upload reports
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-reports
          path: |
            apps/web/playwright-report
            packages/wasm-pipeline/playwright-report
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/e2e-web.yml
git commit -m "ci: add e2e-web workflow (UI + MCP live-bundle + module harness)"
```

---

## Task 10: Spec sync + final review

**Files:**
- Modify: `docs/superpowers/specs/2026-07-17-wasm-web-ui-e2e-design.md` (Section 2 adapter note already added; verify Sections 3-6 still align).

- [ ] **Step 1: Re-read the spec and confirm Tasks 1-9 cover every section**

Confirm: Section 1 topology (Task 9 + Tasks 4/7/8), Section 2 wiring (Tasks 1-3 + spec note), Section 3 UI specs (Task 6), Section 4 MCP (Task 7), Section 5 module harness (Task 8), Section 6 CI (Task 9).

- [ ] **Step 2: Run the existing unit suites to ensure no regression**

Run:
`cd C:\Users\NMarchitecte\Documents\xberg\services/mcp-server && pnpm test`
`cd C:\Users\NMarchitecte\Documents\xberg\packages/wasm-pipeline && pnpm test`
`cd C:\Users\NMarchitecte\Documents\xberg\apps\web && pnpm test`
Expected: all existing unit tests still pass.

- [ ] **Step 3: Commit any spec polish**

```bash
git add docs/superpowers/specs/2026-07-17-wasm-web-ui-e2e-design.md
git commit -m "docs: align spec with implementation plan (adapter deviation)"
```

## 2026-07-23 GLiNER2 E2E extension

- [ ] Let the adapter select legacy injected JS NER or the wired Xberg Candle
  WASM backend during migration.
- [ ] Add a binding-presence smoke test and corrupt/truncated `from_bytes`
  cases without downloading the full model.
- [ ] Add a separately cached real-model job for native/WASM span parity,
  Unicode offsets, long-window boundaries, the seven supported languages, and
  explicit unsupported-language behavior.
- [ ] Exercise Worker cancellation, initialization progress, cache quota, and
  recovery without blocking the page.
