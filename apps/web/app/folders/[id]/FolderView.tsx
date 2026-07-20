"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import type { Matter, Folder } from "@xberg-io/core";
import { ingestFolder, type IngestProgress, type IngestResult } from "@xberg-io/wasm-pipeline";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { FileDropzone } from "@/components/ui/file-dropzone";
import { DataGrid, type DataGridColumn } from "@/components/ui/data-grid";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth";
import { useRouteId } from "@/lib/useRouteId";
import { getMatters, getFolders, pushMirror } from "@/lib/api";
import { describeError } from "@/lib/utils";
import { saveDocument, listDocuments } from "@/lib/documentStore";

interface FileState {
  file: File | null;
  status: "processing" | "done" | "error";
  progress: number;
  result?: IngestResult;
  error?: string;
}

function FolderPageInner() {
  const router = useRouter();
  const folderId = useRouteId();
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
    if (!matterId || !folderId) return;
    void (async () => {
      const [matters, folders, stored] = await Promise.all([
        getMatters(a.token),
        getFolders(a.token, matterId),
        listDocuments(folderId),
      ]);
      setMatter(matters.find((m) => m.id === matterId) ?? null);
      setFolder(folders.find((f) => f.id === folderId) ?? null);
      setFiles((prev) => [
        ...stored.map<FileState>((d) => ({
          file: null,
          status: "done",
          progress: 100,
          result: { doc_id: d.doc_id, name: d.name, text: d.text, pages: d.pages, pii: d.pii, chunks: d.chunks, mirror: new Uint8Array() },
        })),
        ...prev,
      ]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matterId, folderId]);

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
        setFiles((prev) =>
          prev.map((s) =>
            s.file && s.file.name === result.name
              ? { ...s, status: "done" as const, progress: 100, result }
              : s,
          ),
        );
        await pushMirror(auth.token, matterId, result.mirror);
        await saveDocument({
          doc_id: result.doc_id,
          folder_id: folder.id,
          name: result.name,
          text: result.text,
          pages: result.pages,
          pii: result.pii,
          chunks: result.chunks,
          created_at: new Date().toISOString(),
          blob: file,
          mimeType: file.type,
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("ingest failed:", e);
      const message = describeError(e);
      setFiles((prev) =>
        prev.map((s) => (s.status === "processing" ? { ...s, status: "error" as const, error: message } : s)),
      );
    } finally {
      setBusy(false);
    }
  };

  const needsPassphrase = !auth?.passphrase;
  const inFlight = files.filter((f) => f.status !== "done");
  const documents = files.filter((f) => f.status === "done" && f.result);

  const documentColumns: DataGridColumn<FileState>[] = [
    {
      key: "name",
      header: "Name",
      render: (f) => f.file?.name ?? f.result?.name ?? "(unknown)",
    },
    {
      key: "pages",
      header: "Pages",
      render: (f) => f.result?.pages ?? "—",
    },
    {
      key: "pii",
      header: "PII",
      render: (f) =>
        f.result && f.result.pii.length > 0 ? (
          <Badge variant="warning">{f.result.pii.length}</Badge>
        ) : (
          <Badge variant="secondary">0</Badge>
        ),
    },
    {
      key: "chunks",
      header: "Chunks",
      render: (f) => f.result?.chunks.length ?? "—",
    },
    {
      key: "actions",
      header: "",
      className: "text-right",
      render: (f) => (
        <Button
          variant="outline"
          size="sm"
          onClick={() => router.push(`/documents/${f.result?.doc_id}?matter_id=${matterId}`)}
        >
          View document
        </Button>
      ),
    },
  ];

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

      {inFlight.length > 0 && (
        <div className="mt-6 grid gap-3">
          {inFlight.map((f, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{f.file?.name ?? "(unknown)"}</CardTitle>
              </CardHeader>
              <CardContent>
                <Progress value={f.progress} className="mb-2" />
                {f.status === "error" && (
                  <p className="text-xs text-destructive">{f.error}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-6">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Documents</h2>
        <DataGrid
          columns={documentColumns}
          rows={documents}
          rowKey={(f) => f.result?.doc_id ?? f.file?.name ?? Math.random().toString(36)}
          emptyMessage="Drop files to begin processing."
        />
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
