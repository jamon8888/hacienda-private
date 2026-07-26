"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import type { Document as DocumentType } from "@xberg-io/core";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { PiiPanel } from "@/components/PiiPanel";
import { DocumentDualView } from "@/components/DocumentDualView";
import { detectViewerKind } from "@/components/document-router";
import { useAuth } from "@/lib/auth";
import { getDocument } from "@/lib/api";
import { getOriginalFile, saveReviewedPii, saveReviewResult, saveSplits, type StoredDocument } from "@/lib/file-store";
import { reviewAndRepush } from "@xberg-io/wasm-pipeline";
import { createInitialSplits, type DocumentSplit } from "@/components/ui/document-splits";
import { getMatterTemplate } from "@/lib/matter-templates";
import { routeIdFromLocation } from "@/lib/route-id";
import { parseCitationTarget } from "@/lib/citation-target";

// bounding-box-citations renders via Glide Data Grid (JSON tab), which requires browser APIs not
// present during SSR/static export.
const PiiReviewPanel = dynamic(() => import("@/components/PiiReviewPanel").then((m) => m.PiiReviewPanel), {
  ssr: false,
});

// document-splits uses @dnd-kit pointer sensors, which need a real browser environment.
const DocumentSplits = dynamic(() => import("@/components/ui/document-splits").then((m) => m.DocumentSplits), {
  ssr: false,
});

interface MirrorChunk {
  text: string;
}

function redactedTextFromMirror(mirror: Uint8Array | undefined): string {
  if (!mirror) return "";
  try {
    const parsed = JSON.parse(new TextDecoder().decode(mirror)) as { chunks?: MirrorChunk[] };
    return (parsed.chunks ?? []).map((c) => c.text).join("\n\n");
  } catch {
    return "";
  }
}

interface DocumentViewProps {
  id: string;
}

export default function DocumentView({ id: propId }: DocumentViewProps) {
  const id = routeIdFromLocation("documents", propId);
  const router = useRouter();
  const searchParams = useSearchParams();
  const citationTarget = parseCitationTarget(searchParams);
  const { auth } = useAuth();
  const [doc, setDoc] = useState<DocumentType | null>(null);
  const [stored, setStored] = useState<StoredDocument | null>(null);
  const [notFound, setNotFound] = useState(false);
  const srcRef = useRef<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string>("");
  const [splits, setSplits] = useState<DocumentSplit[]>([]);
  const [selectedKinds, setSelectedKinds] = useState<string[]>([]);
  const [reviewError, setReviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!auth || !id) return;
    let cancelled = false;

    (async () => {
      try {
        const [metadata, cached] = await Promise.all([getDocument(auth.token, id), getOriginalFile(id)]);
        if (cancelled) return;
        setDoc(metadata);
        if (!cached) {
          setNotFound(true);
          return;
        }
        setStored(cached);
        setSplits(cached.splits ?? createInitialSplits(metadata.pages));
        getMatterTemplate(metadata.matter_id).then((kinds) => {
          if (!cancelled) setSelectedKinds(kinds ?? []);
        });
        const kind = detectViewerKind(cached.mimeType, cached.fileName);
        if (kind === "text" || kind === "csv") {
          setTextContent(await cached.file.text());
        }
        if (cancelled) return;
        const url = URL.createObjectURL(cached.file);
        srcRef.current = url;
        setSrc(url);
      } catch {
        if (!cancelled) setNotFound(true);
      }
    })();

    return () => {
      cancelled = true;
      if (srcRef.current) URL.revokeObjectURL(srcRef.current);
    };
  }, [auth, id]);

  if (notFound) {
    return (
      <main className="mx-auto max-w-3xl p-6 text-center">
        <p className="text-muted-foreground">
          {doc
            ? "This document's original file isn't cached in this browser (a different device or a cleared cache) — only metadata is available."
            : "Document not found."}
        </p>
        <Button className="mt-4" variant="ghost" onClick={() => router.back()}>
          ← Back
        </Button>
      </main>
    );
  }

  if (!doc || !stored || !src) {
    return (
      <main className="mx-auto max-w-3xl p-6 text-center">
        <p className="text-muted-foreground">Loading…</p>
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col p-4">
      <div className="mb-4 flex items-center justify-between">
        <Button variant="ghost" onClick={() => router.back()}>
          ← Folder
        </Button>
        <h1 className="truncate text-lg font-semibold">{stored.fileName}</h1>
        <span className="text-xs text-muted-foreground">{doc.pages} pages</span>
      </div>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={70} minSize={30}>
          <DocumentDualView
            mimeType={stored.mimeType}
            fileName={stored.fileName}
            src={src}
            textContent={textContent}
            redactedText={redactedTextFromMirror(stored.mirror)}
            citationTarget={citationTarget}
          />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={30} minSize={20} collapsible collapsedSize={0}>
          <Tabs defaultValue="pii" className="h-full min-h-0 pl-3">
            <TabsList>
              <TabsTrigger value="pii">PII</TabsTrigger>
              <TabsTrigger value="review">Review</TabsTrigger>
              <TabsTrigger value="splits">Splits</TabsTrigger>
            </TabsList>
            <TabsContent value="pii">
              <PiiPanel pii={stored.pii} mirror={stored.mirror} selectedKinds={selectedKinds} />
            </TabsContent>
            <TabsContent value="review">
              {reviewError && <p className="mb-2 px-2 text-xs text-destructive">{reviewError}</p>}
              <PiiReviewPanel
                pii={stored.pii}
                mirror={stored.mirror}
                passphrase={auth?.passphrase}
                reviewedPii={stored.reviewedPii}
                selectedKinds={selectedKinds}
                onSave={async (decision) => {
                  setReviewError(null);
                  await saveReviewedPii(id, decision.reviewedPii);
                  setStored((prev) => (prev ? { ...prev, reviewedPii: decision.reviewedPii } : prev));

                  if (decision.rejectedKeys.length === 0 && decision.newSpans.length === 0) return;

                  if (!auth?.token || !auth.passphrase) {
                    const message = "Set the matter passphrase before correcting PII.";
                    setReviewError(message);
                    throw new Error(message);
                  }
                  if (!stored.mirror) {
                    const message = "This document has no local mirror to re-redact — try re-ingesting it.";
                    setReviewError(message);
                    throw new Error(message);
                  }
                  try {
                    const result = await reviewAndRepush(
                      id,
                      stored.mirror,
                      { matterId: doc.matter_id, scopeToken: auth.token, passphrase: auth.passphrase },
                      { rejectedKeys: decision.rejectedKeys, newSpans: decision.newSpans },
                    );
                    await saveReviewResult(id, result.pii, result.mirror);
                    setStored((prev) =>
                      prev ? { ...prev, pii: result.pii, mirror: result.mirror, reviewedPii: undefined } : prev,
                    );
                    if (result.unappliedSpans.length > 0) {
                      setReviewError(`Could not find in this document: ${result.unappliedSpans.join(", ")}`);
                    }
                  } catch (err) {
                    setReviewError(err instanceof Error ? err.message : "Failed to save PII review.");
                    throw err;
                  }
                }}
              />
            </TabsContent>
            <TabsContent value="splits">
              <DocumentSplits
                splits={splits}
                onSelectPage={() => {
                  /* page-level jump is viewer-specific (Step 6's PDF scrollToPage); not wired for
									   non-PDF formats here. */
                }}
                onSplitsChange={(next) => {
                  setSplits(next);
                  void saveSplits(id, next);
                }}
              />
            </TabsContent>
          </Tabs>
        </ResizablePanel>
      </ResizablePanelGroup>
    </main>
  );
}
