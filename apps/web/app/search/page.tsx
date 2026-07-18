"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RetrievedChunkCard } from "@/components/RetrievedChunkCard";
import { useAuth } from "@/lib/auth";
import { queryRag } from "@xberg-io/wasm-pipeline";
import type { RetrievedChunk, Matter } from "@xberg-io/core";

function SearchPageInner() {
  const searchParams = useSearchParams();
  const folderId = searchParams.get("folder_id") ?? searchParams.get("matter_id") ?? "";
  const { ensureAuth } = useAuth();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RetrievedChunk[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (!query.trim()) return;
    ensureAuth();
    setLoading(true);
    setError(null);
    try {
      const matter: Matter = { id: folderId, name: folderId, created_at: new Date().toISOString() };
      const chunks = await queryRag(matter, query.trim(), 8);
      setResults(chunks);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-4 text-2xl font-semibold">RAG Search</h1>
      <div className="mb-6 flex gap-2">
        <Input
          placeholder="Ask a question about your documents…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
        />
        <Button onClick={search} disabled={loading || !query.trim()}>
          {loading ? "Searching…" : "Search"}
        </Button>
      </div>
      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
      <div className="grid gap-3">
        {results.map((c, i) => (
          <RetrievedChunkCard key={i} chunk={c} />
        ))}
        {results.length === 0 && !loading && (
          <p className="text-sm text-muted-foreground">
            No results. Try a different query or ensure the matter has been processed.
          </p>
        )}
      </div>
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
