"use client";

import { Suspense, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import type { PiiEntity } from "@xberg-io/core";
import { PiiPanel } from "@/components/PiiPanel";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { redactDocument } from "@xberg-io/wasm-pipeline";

interface StoredDoc {
  name: string;
  text: string;
  pii: PiiEntity[];
  pages: number;
}

const STORAGE_KEY = "xberg.ingestedDocs";

const SAMPLE_PII: PiiEntity[] = [{ kind: "EMAIL", start: 0, end: 20, text: "john.doe@example.com" }];

function DocumentViewInner() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const docId = decodeURIComponent(params.id);
  const matterId = searchParams.get("matter_id") ?? "";
  const { ensureAuth } = useAuth();

  const [redactedText, setRedactedText] = useState<string | null>(null);
  const [redacting, setRedacting] = useState(false);

  const raw = typeof window !== "undefined" ? sessionStorage.getItem(STORAGE_KEY) : null;
  const all: Record<string, StoredDoc> = raw ? (JSON.parse(raw) as Record<string, StoredDoc>) : {};
  const stored = all[docId];

  const text = stored?.text ?? "";
  const pii: PiiEntity[] = stored?.pii?.length ? stored.pii : SAMPLE_PII;

  const onRedact = async () => {
    const auth = ensureAuth();
    setRedacting(true);
    try {
      const { redacted } = await redactDocument(text, pii, auth.token);
      setRedactedText(redacted);
    } finally {
      setRedacting(false);
    }
  };

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-2 text-2xl font-semibold">{docId}</h1>
      <p className="mb-6 text-sm text-muted-foreground">Matter: {matterId}</p>

      <h2 className="mb-2 text-lg font-semibold">Extracted Text</h2>
      <pre className="mb-6 whitespace-pre-wrap rounded-lg border p-4 text-sm">
        {text || "(no extracted text available)"}
      </pre>

      <div data-testid="pii-panel" className="mb-6">
        <PiiPanel pii={pii} />
      </div>

      <Button onClick={onRedact} disabled={redacting} aria-label="redact">
        {redacting ? "Redacting…" : "Redact"}
      </Button>

      {redactedText !== null && (
        <div className="mt-4 rounded-lg border p-4">
          <p className="mb-2 font-medium">Redacted</p>
          <pre className="whitespace-pre-wrap text-sm">{redactedText}</pre>
        </div>
      )}
    </main>
  );
}

export default function DocumentViewPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-3xl p-6">Loading…</main>}>
      <DocumentViewInner />
    </Suspense>
  );
}
