"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Document as DocumentType, Folder, Matter } from "@xberg-io/core";
import { ingestFolder, type IngestProgress } from "@xberg-io/wasm-pipeline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileDropzone } from "@/components/ui/file-dropzone";
import { useAuth } from "@/lib/auth";
import { useModelWarmup } from "@/lib/engine/warmup-store";
import { getFolders, getFolderDocuments, createDocument, updateDocumentStatus } from "@/lib/api";
import { saveOriginalFile } from "@/lib/file-store";
import { routeIdFromLocation } from "@/lib/route-id";

interface FolderViewProps {
  id: string;
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface UploadState {
  name: string;
  stage: IngestProgress["stage"];
  progress: number;
  error?: string;
}

export default function FolderView({ id: propId }: FolderViewProps) {
  const folderId = routeIdFromLocation("folders", propId);
  const searchParams = useSearchParams();
  const matterId = searchParams.get("matter_id") ?? "";
  const { auth, setPassphrase } = useAuth();
  const { stage: modelStage } = useModelWarmup();
  const [folder, setFolder] = useState<Folder | null>(null);
  const [documents, setDocuments] = useState<DocumentType[]>([]);
  const [uploads, setUploads] = useState<Record<string, UploadState>>({});
  const [passphraseInput, setPassphraseInput] = useState("");

  // Fetch folder details
  useEffect(() => {
    if (!auth || !matterId) return;
    getFolders(auth.token, matterId).then((folders) => {
      const f = folders.find((f) => f.id === folderId);
      if (f) setFolder(f);
    });
  }, [auth, matterId, folderId]);

  const refresh = useCallback(async () => {
    if (!auth || !folderId) return;
    const docs = await getFolderDocuments(auth.token, folderId);
    setDocuments(docs);
    return docs;
  }, [auth, folderId]);

  // Poll for documents while any are processing
  useEffect(() => {
    if (!auth || !folderId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const docs = await refresh();
      if (cancelled || !docs) return;
      if (docs.some((d) => d.status === "processing")) {
        timer = setTimeout(poll, 3000);
      }
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [auth, folderId, refresh]);

  const onFilesAccepted = useCallback(
    async (files: File[]) => {
      if (!auth?.passphrase || !folder || modelStage !== "ready") return;
      const matter: Matter = { id: matterId, name: "", created_at: "" };

      // Sequential, not Promise.all: each file's ingest reads-then-writes the matter's cumulative
      // mirror accumulator (see lib/engine/mirror-merge.ts), so concurrent uploads would race on
      // that read and one file's chunks/PII would clobber another's.
      for (const [idx, file] of files.entries()) {
        // Keyed by index, not just file.name — two files accepted in the same batch can
        // share a name (e.g. scans from different sources), and a name-only key would
        // collide, silently overwriting one file's progress/error with the other's.
        const uploadKey = `${file.name}-${idx}`;
        setUploads((prev) => ({ ...prev, [uploadKey]: { name: file.name, stage: "extract", progress: 0 } }));
        let docId: string | undefined;
        try {
          const content_hash = await sha256Hex(file);
          const doc = await createDocument(auth.token, folderId, { path: file.name, content_hash });
          docId = doc.id;
          await refresh();

          const result = await ingestFolder(file, {
            matter,
            folder,
            docId,
            scopeToken: auth.token,
            passphrase: auth.passphrase as string,
            onProgress: (p) =>
              setUploads((prev) => ({
                ...prev,
                [uploadKey]: { name: file.name, stage: p.stage, progress: p.progress },
              })),
          });

          await saveOriginalFile(docId, file, result.pii, result.mirror);
          await updateDocumentStatus(auth.token, docId, {
            status: "done",
            pages: result.pages,
            chunk_count: result.chunks.length,
            pii_count: result.pii.length,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "ingest failed";
          setUploads((prev) => ({
            ...prev,
            [uploadKey]: { name: file.name, stage: "error", progress: 1, error: message },
          }));
          if (docId) {
            await updateDocumentStatus(auth.token, docId, { status: "error", error_message: message });
          }
        } finally {
          await refresh();
        }
      }
    },
    [auth, folder, folderId, matterId, refresh, modelStage],
  );

  const vaultLocked = !auth?.passphrase;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-6 text-2xl font-semibold">{folder ? folder.name : "Folder"}</h1>

      {vaultLocked ? (
        <div className="mb-6 flex gap-2">
          <Input
            type="password"
            placeholder="Set a passphrase to unlock the vault before uploading"
            value={passphraseInput}
            onChange={(e) => setPassphraseInput(e.target.value)}
          />
          <Button
            onClick={() => {
              if (passphraseInput) setPassphrase(passphraseInput);
              setPassphraseInput("");
            }}
            disabled={!passphraseInput}
          >
            Unlock vault
          </Button>
        </div>
      ) : modelStage === "error" ? (
        <div className="mb-6 rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          On-device AI models are unavailable — see the status indicator to retry.
        </div>
      ) : modelStage !== "ready" ? (
        <div className="mb-6 rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          Preparing on-device AI models before you can upload…
        </div>
      ) : (
        <FileDropzone className="mb-6" onFilesAccepted={onFilesAccepted} />
      )}

      {Object.values(uploads).length > 0 && (
        <div className="mb-6 grid gap-2">
          {Object.entries(uploads).map(([key, u]) => (
            <div key={key} className="text-sm">
              <div className="flex items-center justify-between">
                <span className="truncate">{u.name}</span>
                <span className="text-xs text-muted-foreground">{u.error ? "error" : u.stage}</span>
              </div>
              <Progress value={u.progress * 100} />
              {u.error && <p className="text-xs text-destructive">{u.error}</p>}
            </div>
          ))}
        </div>
      )}

      {documents.length > 0 && (
        <div className="mt-6 grid gap-3">
          <h2 className="text-lg font-medium">Ingested documents</h2>
          {documents.map((d) => (
            <Card key={d.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{d.path.split(/[/\\]/).pop()}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  {d.status === "processing"
                    ? "Processing…"
                    : d.status === "error"
                      ? "Failed to ingest"
                      : `${d.pages} pages · ${d.pii_count} PII entities · ${d.chunk_count} chunks`}
                </p>
                {d.status === "error" && <p className="text-xs text-destructive">{d.error_message}</p>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {documents.length === 0 && <p className="mt-6 text-sm text-muted-foreground">No documents ingested yet.</p>}
    </main>
  );
}
