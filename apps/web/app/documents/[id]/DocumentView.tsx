"use client";

import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PiiPanel } from "@/components/PiiPanel";
import { useRouteId } from "@/lib/useRouteId";
import { getDocument, type StoredDocument } from "@/lib/documentStore";

// Each viewer library is large (DOCX/PDF/XLSX rendering engines) and only one is ever shown
// per document — load only the one the current document actually needs instead of bundling
// all three into every /documents/[id] page load.
const DocxViewerPreview = dynamic(
  () => import("@/components/ui/docx-viewer").then((m) => m.DocxViewerPreview),
  { ssr: false },
);
const PDFViewer = dynamic(
  () => import("@/components/ui/pdf-viewer").then((m) => m.PDFViewer),
  { ssr: false },
);
const XlsxViewerPreview = dynamic(
  () => import("@/components/ui/xlsx-viewer").then((m) => m.XlsxViewerPreview),
  { ssr: false },
);

type ViewerKind = "docx" | "pdf" | "xlsx" | "text";

function viewerKindFor(doc: StoredDocument): ViewerKind {
  if (!doc.blob) return "text";
  const name = doc.name.toLowerCase();
  if (name.endsWith(".pdf") || doc.mimeType === "application/pdf") return "pdf";
  if (
    name.endsWith(".docx") ||
    name.endsWith(".doc") ||
    doc.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "docx";
  }
  if (
    name.endsWith(".xlsx") ||
    name.endsWith(".xls") ||
    doc.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return "xlsx";
  }
  return "text";
}

export default function DocumentView() {
  const router = useRouter();
  const docId = useRouteId();
  const [doc, setDoc] = useState<StoredDocument | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    if (!docId) return;
    setLoaded(false);
    getDocument(docId)
      .then((d) => setDoc(d))
      .finally(() => setLoaded(true));
  }, [docId]);

  useEffect(() => {
    if (!doc?.blob) {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(doc.blob);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [doc]);

  if (!loaded) {
    return <main className="mx-auto max-w-3xl p-6">Loading…</main>;
  }

  if (!doc) {
    return (
      <main className="mx-auto max-w-3xl p-6 text-center">
        <p className="text-muted-foreground">No document loaded. Process a folder first.</p>
        <Button className="mt-4" variant="ghost" onClick={() => router.back()}>
          ← Back
        </Button>
      </main>
    );
  }

  const kind = viewerKindFor(doc);

  return (
    <main className="mx-auto max-w-6xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <Button variant="ghost" onClick={() => router.back()}>
          ← Folder
        </Button>
        <h1 className="text-2xl font-semibold">{doc.name}</h1>
      </div>
      <div className="grid gap-6 md:grid-cols-[1fr_320px]">
        <div className="col-span-1 min-w-0">
          {kind === "docx" && objectUrl && (
            <DocxViewerPreview
              className="h-[75vh]"
              src={objectUrl}
              fileName={doc.name}
              isDark={isDark}
              onIsDarkChange={setIsDark}
              showUpload={false}
            />
          )}
          {kind === "pdf" && objectUrl && (
            <PDFViewer className="h-[75vh]" src={objectUrl} fileName={doc.name} showUpload={false} />
          )}
          {kind === "xlsx" && objectUrl && (
            <XlsxViewerPreview
              className="h-[75vh]"
              src={objectUrl}
              fileName={doc.name}
              isDark={isDark}
              onIsDarkChange={setIsDark}
              showUpload={false}
            />
          )}
          {kind === "text" && (
            <Card>
              <CardHeader>
                <CardTitle>Extracted Text ({doc.pages} pages)</CardTitle>
              </CardHeader>
              <CardContent className="whitespace-pre-wrap text-sm max-h-[75vh] overflow-auto">
                {doc.text}
              </CardContent>
            </Card>
          )}
        </div>
        <PiiPanel pii={doc.pii} />
      </div>
    </main>
  );
}
