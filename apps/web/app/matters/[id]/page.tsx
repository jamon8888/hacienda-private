"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { Folder, Matter, PiiEntity } from "@xberg-io/core";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { createFolder } from "@/lib/api";
import {
  ingestFolder,
  type IngestResult,
  type IngestProgress,
} from "@xberg-io/wasm-pipeline";

interface FileProgress {
  name: string;
  progress: number;
  status: string;
  pages?: number;
}

const STORAGE_KEY = "xberg.ingestedDocs";

function saveIngest(result: IngestResult) {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  const all: Record<string, { name: string; text: string; pii: PiiEntity[]; pages: number }> =
    raw ? (JSON.parse(raw) as Record<string, { name: string; text: string; pii: PiiEntity[]; pages: number }>) : {};
  all[result.name] = {
    name: result.name,
    text: result.text,
    pii: result.pii,
    pages: result.pages,
  };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export default function MatterIngestPage() {
  const params = useParams<{ id: string }>();
  const matterId = params.id;
  const { ensureAuth } = useAuth();

  const [folder, setFolder] = useState<Folder | null>(null);
  const [progress, setProgress] = useState<FileProgress[]>([]);
  const [results, setResults] = useState<IngestResult[]>([]);
  const [busy, setBusy] = useState(false);
  const creating = useRef(false);

  const matter: Matter = {
    id: matterId,
    name: matterId,
    created_at: new Date().toISOString(),
  };

  useEffect(() => {
    if (creating.current) return;
    creating.current = true;
    const auth = ensureAuth();
    createFolder(auth.token, matterId, "folder-" + Date.now())
      .then(setFolder)
      .catch(() => {
        creating.current = false;
      });
  }, [matterId, ensureAuth]);

  const onProgress = (p: IngestProgress) => {
    setProgress((prev) => {
      const idx = prev.findIndex((f) => f.name === p.name);
      const entry: FileProgress = {
        name: p.name,
        progress: p.progress,
        status: p.stage,
      };
      if (idx === -1) return [...prev, entry];
      const next = prev.slice();
      next[idx] = entry;
      return next;
    });
  };

  const runPipeline = async (files: FileList | null) => {
    if (!files || files.length === 0 || !folder) return;
    const auth = ensureAuth();
    setBusy(true);
    const collected: IngestResult[] = [];
    try {
      for (const file of Array.from(files)) {
        const result = await ingestFolder(file, {
          matter,
          folder,
          scopeToken: auth.token,
          passphrase: auth.token,
          onProgress,
        });
        collected.push(result);
        saveIngest(result);
        setProgress((prev) => {
          const next = prev.slice();
          const idx = next.findIndex((f) => f.name === result.name);
          if (idx !== -1) next[idx] = { name: result.name, progress: 1, status: "done", pages: result.pages };
          return next;
        });
      }
      setResults((prev) => [...prev, ...collected]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-2 text-2xl font-semibold">Matter: {matterId}</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Folder: {folder ? folder.id : "creating…"}
      </p>

      <input
        type="file"
        multiple
        disabled={busy || !folder}
        onChange={(e) => runPipeline(e.target.files)}
        className="mb-4 block w-full text-sm"
      />

      <Button
        onClick={() => {
          const el = document.querySelector<HTMLInputElement>('input[type="file"]');
          runPipeline(el?.files ?? null);
        }}
        disabled={busy || !folder}
        aria-label="run pipeline"
      >
        {busy ? "Running…" : "Run pipeline"}
      </Button>

      <div className="mt-6 grid gap-3">
        {progress.map((f) => (
          <div key={f.name} className="rounded-lg border p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">{f.name}</span>
              <span className="text-muted-foreground">
                {Math.round(f.progress * 100)}% · {f.status}
                {f.pages !== undefined ? ` · Pages: ${f.pages}` : ""}
              </span>
            </div>
          </div>
        ))}
      </div>

      {results.length > 0 && (
        <div className="mt-6 grid gap-3">
          {results.map((r) => (
            <div key={r.name} className="flex items-center justify-between rounded-lg border p-3">
              <span className="text-sm">
                {r.name} · Pages: {r.pages}
              </span>
              <Button asChild variant="outline" size="sm">
                <a href={`/documents/${encodeURIComponent(r.name)}?matter_id=${encodeURIComponent(matterId)}`}>
                  View document
                </a>
              </Button>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
