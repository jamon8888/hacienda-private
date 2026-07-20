"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RetrievedChunkCard } from "@/components/RetrievedChunkCard";
import { useAuth } from "@/lib/auth";
import { getMatters } from "@/lib/api";
import { queryRag } from "@xberg-io/wasm-pipeline";
import { assertLocalFirst, API_BASE } from "@xberg-io/wasm-pipeline-real";
import type { Matter, RetrievedChunk } from "@xberg-io/core";

// PII tokens are minted as {{CATEGORY_n}} (see redact.ts buildRedaction) — scanning chunk text
// for this shape is the only way to facet by PII type without a server round-trip, since
// RetrievedChunk carries no PII metadata of its own.
const TOKEN_PATTERN = /\{\{(?:C\d+_)?([A-Z0-9_]+?)_\d+\}\}/g;

function piiKindsInChunk(text: string): Set<string> {
	const kinds = new Set<string>();
	for (const match of text.matchAll(TOKEN_PATTERN)) {
		if (match[1]) kinds.add(match[1]);
	}
	return kinds;
}

function SearchPageInner() {
  const searchParams = useSearchParams();
  const matterId = searchParams.get("matter_id") ?? searchParams.get("folder_id") ?? "";
  const { ensureAuth } = useAuth();
  const [matter, setMatter] = useState<Matter | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RetrievedChunk[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activePiiFilters, setActivePiiFilters] = useState<Set<string>>(new Set());
  const [minScore, setMinScore] = useState(0);

  useEffect(() => {
    if (!matterId) return;
    const auth = ensureAuth();
    void (async () => {
      const matters = await getMatters(auth.token);
      setMatter(matters.find((m) => m.id === matterId) ?? null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matterId]);

  const search = async () => {
    if (!query.trim() || !matter) return;
    ensureAuth();
    // Zero-egress guard: the search itself never leaves the browser (local EdgeVec + local
    // embedding model) — this just asserts the configured API base isn't a remote host before
    // showing the "100% on-device" badge below.
    assertLocalFirst(API_BASE);
    setLoading(true);
    setError(null);
    try {
      const chunks = await queryRag(matter, query.trim(), 8);
      setResults(chunks);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setLoading(false);
    }
  };

  const availablePiiKinds = useMemo(() => {
    const kinds = new Set<string>();
    for (const c of results) for (const k of piiKindsInChunk(c.text)) kinds.add(k);
    return Array.from(kinds).sort();
  }, [results]);

  const filteredResults = useMemo(() => {
    return results.filter((c) => {
      if (c.score < minScore) return false;
      if (activePiiFilters.size === 0) return true;
      const kinds = piiKindsInChunk(c.text);
      return Array.from(activePiiFilters).some((k) => kinds.has(k));
    });
  }, [results, activePiiFilters, minScore]);

  function togglePiiFilter(kind: string) {
    setActivePiiFilters((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">RAG Search</h1>
        {loading && (
          <Badge variant="secondary" className="animate-pulse">
            100% on-device
          </Badge>
        )}
      </div>
      <div className="mb-4 flex gap-2">
        <Input
          placeholder="Ask a question about your documents…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
        />
        <Button onClick={search} disabled={loading || !query.trim() || !matter}>
          {loading ? "Searching…" : "Search"}
        </Button>
      </div>

      {results.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {availablePiiKinds.map((kind) => (
            <Badge
              key={kind}
              variant={activePiiFilters.has(kind) ? "default" : "outline"}
              className="cursor-pointer"
              onClick={() => togglePiiFilter(kind)}
            >
              {kind}
            </Badge>
          ))}
          <Badge
            variant={minScore > 0 ? "default" : "outline"}
            className="cursor-pointer"
            onClick={() => setMinScore((s) => (s > 0 ? 0 : 0.5))}
          >
            {minScore > 0 ? "score ≥ 0.5" : "all confidence"}
          </Badge>
        </div>
      )}

      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

      <ScrollArea className="max-h-[70vh]">
        <div className="grid gap-3 pr-2">
          {filteredResults.map((c, i) => (
            <RetrievedChunkCard key={i} chunk={c} />
          ))}
          {results.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground">
              No results. Try a different query or ensure the matter has been processed.
            </p>
          )}
          {results.length > 0 && filteredResults.length === 0 && (
            <p className="text-sm text-muted-foreground">No results match the current filters.</p>
          )}
        </div>
      </ScrollArea>
    </main>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-3xl p-6">Loading…</main>}>
      <SearchPageInner />
    </Suspense>
  );
}
