"use client";

import { useRouter, useSearchParams, useParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import type { Matter, Folder } from "@xberg-io/core";
import { ingestFolder, type IngestProgress, type IngestResult } from "@xberg-io/wasm-pipeline";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { FileDropzone } from "@/components/ui/file-dropzone";
import { useAuth } from "@/lib/auth";
import { getMatters, getFolders, pushMirror } from "@/lib/api";

interface FileState {
  file: File | null;
  status: "processing" | "done" | "error";
  progress: number;
  result?: IngestResult;
  error?: string;
}

function FolderPageInner() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const matterId = searchParams.get("matter_id") ?? "";
  const { auth, ensureAuth, setPassphrase } = useAuth();
  const [files, setFiles] = useState<FileState[]>([]);
  const [busy, setBusy] = useState(false);
  const [matter, setMatter] = useState<Matter | null>(null);
  const [folder, setFolder] = useState<Folder | null>(null);
  const [passphraseInput, setPassphraseInput] = useState("");

  useEffect(() => {
    const a = ensureAuth();
    if (!matterId) return;
    void (async () => {
      const [matters, folders] = await Promise.all([getMatters(a.token), getFolders(a.token, matterId)]);
      setMatter(matters.find((m) => m.id === matterId) ?? null);
      setFolder(folders.find((f) => f.id === params.id) ?? null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matterId, params.id]);

  const handleDrop = (accepted: File[]) => {
    setFiles((prev) => [
      ...prev,
      ...accepted.map<FileState>((f) => ({
        file: f,
        status: "processing",
        progress: 0,
      })),
    ]);
  };

  const ingest = async () => {
    const pending = files.filter((f) => f.status === "processing" && f.file);
    if (pending.length === 0 || !matter || !folder) return;
    const auth = ensureAuth();
    const passphrase = auth.passphrase ?? setPassphrase(passphraseInput).passphrase;
    if (!passphrase) return;
    setBusy(true);
    try {
      const results: IngestResult[] = [];
      for (const f of pending) {
        const file = f.file as File;
        const result = await ingestFolder(file, {
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
        });
        results.push(result);
        setFiles((prev) =>
          prev.map((s) =>
            s.file && s.file.name === result.name
              ? { ...s, status: "done" as const, progress: 100, result }
              : s,
          ),
        );
        await pushMirror(auth.token, matterId, result.mirror);
      }
      const first = results[0];
      if (first) {
        sessionStorage.setItem(
          "lastIngest",
          JSON.stringify({
            name: first.name,
            text: first.text,
            pii: first.pii,
            pages: first.pages,
          }),
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

  const needsPassphrase = !auth?.passphrase;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Process Folder</h1>
        <Button onClick={() => router.back()} variant="ghost">
          ← Back
        </Button>
      </div>

      <FileDropzone onFilesAccepted={handleDrop} />

      {needsPassphrase && (
        <div className="mt-4 flex items-center gap-2">
          <Input
            type="password"
            placeholder="Vault passphrase (protects redacted PII originals)"
            value={passphraseInput}
            onChange={(e) => setPassphraseInput(e.target.value)}
          />
          <Button
            variant="outline"
            disabled={!passphraseInput}
            onClick={() => setPassphrase(passphraseInput)}
          >
            Set passphrase
          </Button>
        </div>
      )}

      <div className="mt-4">
        <Button
          onClick={ingest}
          disabled={busy || needsPassphrase || !matter || !folder || files.every((f) => f.status !== "processing")}
        >
          {busy ? "Processing…" : "Run pipeline"}
        </Button>
      </div>

      <div className="mt-6 grid gap-3">
        {files.map((f, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{f.file?.name ?? "(unknown)"}</CardTitle>
            </CardHeader>
            <CardContent>
              <Progress value={f.progress} className="mb-2" />
              {f.status === "done" && f.result && (
                <p className="text-xs text-muted-foreground">
                  {f.result.pages} pages · {f.result.pii.length} PII entities ·{" "}
                  {f.result.chunks.length} chunks
                </p>
              )}
              {f.status === "error" && (
                <p className="text-xs text-destructive">{f.error}</p>
              )}
              {f.status === "done" && f.result && (
                <Button
                  className="mt-2"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    router.push(`/documents/${f.result?.doc_id}?matter_id=${matterId}`)
                  }
                >
                  View document
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
        {files.length === 0 && (
          <p className="text-sm text-muted-foreground">Drop files to begin processing.</p>
        )}
      </div>
    </main>
  );
}

export default function FolderView() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-3xl p-6">Loading…</main>}>
      <FolderPageInner />
    </Suspense>
  );
}
