"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Document as DocumentType, Folder } from "@xberg-io/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { getFolders, createFolder } from "@/lib/api";
import { getFolderDocuments } from "@/lib/api";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function FolderView({ params }: PageProps) {
  const resolvedParams = await params;
  const folderId = resolvedParams.id;
  const searchParams = useSearchParams();
  const matterId = searchParams.get("matter_id") ?? "";
  const router = useRouter();
  const { auth } = useAuth();
  const [folder, setFolder] = useState<Folder | null>(null);
  const [documents, setDocuments] = useState<DocumentType[]>([]);
  const [name, setName] = useState("");

  // Fetch folder details
  useEffect(() => {
    if (!auth || !matterId) return;
    getFolders(auth.token, matterId).then((folders) => {
      const f = folders.find((f) => f.id === folderId);
      if (f) setFolder(f);
    });
  }, [auth, matterId, folderId]);

  // Poll for documents while any are processing
  useEffect(() => {
    if (!auth || !folderId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const docs = await getFolderDocuments(auth.token, folderId);
      if (cancelled) return;
      setDocuments(docs);
      if (docs.some((d) => d.status === "processing")) {
        timer = setTimeout(poll, 3000);
      }
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [auth, folderId]);

  const add = async () => {
    if (!auth || !name.trim() || !matterId) return;
    const f = await createFolder(auth.token, matterId, name.trim());
    setFolder(f);
    setName("");
    router.push(`/folders/${f.id}?matter_id=${matterId}`);
  };

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-6 text-2xl font-semibold">
        {folder ? folder.name : "Folder"}
      </h1>

      <div className="mb-6 flex gap-2">
        <Input
          placeholder="Drop files or click to upload"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button onClick={add}>Create folder</Button>
      </div>

      {documents.length > 0 && (
        <div className="mt-6 grid gap-3">
          <h2 className="text-lg font-medium">Ingested documents</h2>
          {documents.map((d) => (
            <Card key={d.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  {d.path.split(/[/\\]/).pop()}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  {d.status === "processing"
                    ? "Processing…"
                    : `${d.pages} pages \u00b7 ${d.pii_count} PII entities \u00b7 ${d.chunk_count} chunks`}
                </p>
                {d.status === "error" && (
                  <p className="text-xs text-destructive">{d.error_message}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {documents.length === 0 && (
        <p className="mt-6 text-sm text-muted-foreground">
          No documents ingested yet.
        </p>
      )}
    </main>
  );
}