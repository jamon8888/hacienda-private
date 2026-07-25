"use client";

import { useEffect, useMemo, useState } from "react";
import corpus from "./corpus.json";
import {
  embedChunks,
  embedQuery,
  ensureGraniteEmbedder,
  graniteEmbeddingDimension,
  graniteEmbeddingIdentity,
} from "@xberg-io/wasm-pipeline-real";

interface CorpusDocument {
  id: string;
  language: string;
  text: string;
}

interface CorpusFixture {
  query: string;
  documents: CorpusDocument[];
}

interface ResourceReport {
  name: string;
  duration: number;
  transferSize?: number;
  encodedBodySize?: number;
}

interface VectorReport {
  id: string;
  language: string;
  vector: number[];
}

interface ReleaseReport {
  identity: string;
  dimension: number;
  query: { text: string; vector: number[] };
  documents: VectorReport[];
  firstLoadMs: number;
  batchEmbedMs: number;
  totalMs: number;
  heapBeforeBytes: number | null;
  heapAfterWarmupBytes: number | null;
  heapAfterBatchBytes: number | null;
  peakHeapBytes: number | null;
  resources: ResourceReport[];
}

interface MemoryPerformance extends Performance {
  memory?: {
    usedJSHeapSize?: number;
  };
}

declare global {
  interface Window {
    __graniteReleaseReport?: ReleaseReport;
  }
}

function currentHeap(): number | null {
  const perf = performance as MemoryPerformance;
  const used = perf.memory?.usedJSHeapSize;
  return typeof used === "number" ? used : null;
}

function graniteResources(): ResourceReport[] {
  return performance
    .getEntriesByType("resource")
    .filter(
      (entry): entry is PerformanceResourceTiming =>
        entry instanceof PerformanceResourceTiming,
    )
    .filter((entry) =>
      entry.name.includes(
        "/models/granite/granite-embedding-97m-multilingual-r2/",
      ),
    )
    .map((entry) => ({
      name: entry.name,
      duration: entry.duration,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
    }));
}

function buildReport(input: CorpusFixture) {
  return async (): Promise<ReleaseReport> => {
    const startedAt = performance.now();
    const heapBeforeBytes = currentHeap();
    await ensureGraniteEmbedder();
    const firstLoadMs = performance.now() - startedAt;
    const heapAfterWarmupBytes = currentHeap();

    const batchStartedAt = performance.now();
    const [documentVectors, queryVector] = await Promise.all([
      embedChunks(input.documents.map((document) => ({ text: document.text }))),
      embedQuery(input.query),
    ]);
    const batchEmbedMs = performance.now() - batchStartedAt;
    const heapAfterBatchBytes = currentHeap();
    const peakHeapBytes = [
      heapBeforeBytes,
      heapAfterWarmupBytes,
      heapAfterBatchBytes,
    ].reduce<number | null>((peak, value) => {
      if (value === null) return peak;
      return peak === null ? value : Math.max(peak, value);
    }, null);

    const report: ReleaseReport = {
      identity: graniteEmbeddingIdentity(),
      dimension: graniteEmbeddingDimension(),
      query: { text: input.query, vector: Array.from(queryVector) },
      documents: input.documents.map((document, index) => ({
        id: document.id,
        language: document.language,
        vector: Array.from(documentVectors[index] ?? []),
      })),
      firstLoadMs,
      batchEmbedMs,
      totalMs: performance.now() - startedAt,
      heapBeforeBytes,
      heapAfterWarmupBytes,
      heapAfterBatchBytes,
      peakHeapBytes,
      resources: graniteResources(),
    };
    window.__graniteReleaseReport = report;
    return report;
  };
}

export default function ReleaseHarness() {
  const fixture = useMemo(() => corpus as CorpusFixture, []);
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">(
    "idle",
  );
  const [report, setReport] = useState<ReleaseReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useMemo(() => buildReport(fixture), [fixture]);

  const runNow = async () => {
    setStatus("running");
    setError(null);
    try {
      const nextReport = await run();
      setReport(nextReport);
      setStatus("done");
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    }
  };

  useEffect(() => {
    const autorun =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("autorun") === "1";
    if (!autorun) return;
    setStatus("running");
    let cancelled = false;
    void run()
      .then((nextReport) => {
        if (cancelled) return;
        setReport(nextReport);
        setStatus("done");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [run]);

  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-semibold">Granite Release Harness</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Release verification surface for the shared Granite embedding backend on
        Thursday, July 23, 2026.
      </p>
      <div className="mt-4 rounded-lg border p-4">
        <p data-testid="granite-release-status" className="font-medium">
          Status: {status}
        </p>
        <button
          type="button"
          onClick={() => {
            void runNow();
          }}
          className="mt-3 rounded-md border px-3 py-2 text-sm font-medium"
        >
          Run Granite release checks
        </button>
        {error ? (
          <p
            data-testid="granite-release-error"
            className="mt-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
        {report ? (
          <pre
            data-testid="granite-release-report"
            className="mt-4 overflow-x-auto rounded-md bg-muted p-4 text-xs leading-6"
          >
            {JSON.stringify(report, null, 2)}
          </pre>
        ) : null}
      </div>
    </main>
  );
}
