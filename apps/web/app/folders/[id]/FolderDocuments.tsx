"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { PiiEntity } from "@xberg-io/core";
import { Button } from "@/components/ui/button";

interface StoredDoc {
  name: string;
  text: string;
  pii: PiiEntity[];
  pages: number;
}

const STORAGE_KEY = "xberg.ingestedDocs";

function FolderDocumentsInner() {
  const params = useParams<{ id: string }>();
  const folderId = params.id;

  const raw =
    typeof window !== "undefined" ? sessionStorage.getItem(STORAGE_KEY) : null;
  const all: Record<string, StoredDoc> = raw
    ? (JSON.parse(raw) as Record<string, StoredDoc>)
    : {};
  const docNames = Object.keys(all);

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-2 text-2xl font-semibold">Folder: {folderId}</h1>
      <div className="mb-6">
        <Button asChild variant="outline" size="sm">
          <Link href="/matters">Back to matters</Link>
        </Button>
      </div>
      <div className="grid gap-3">
        {docNames.length === 0 ? (
          <p className="text-sm text-muted-foreground">No documents ingested yet.</p>
        ) : (
          docNames.map((name) => (
            <div key={name} className="flex items-center justify-between rounded-lg border p-3">
              <span className="text-sm">{name}</span>
              <Button asChild variant="outline" size="sm">
                <Link href={`/documents/${encodeURIComponent(name)}?matter_id=${encodeURIComponent(folderId)}`}>
                  View document
                </Link>
              </Button>
            </div>
          ))
        )}
      </div>
    </main>
  );
}

export default function FolderDocumentsPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-3xl p-6">Loading…</main>}>
      <FolderDocumentsInner />
    </Suspense>
  );
}
