"use client";

import { useCallback, useMemo, useState } from "react";
import type { PiiEntity } from "@xberg-io/core";
import { Button } from "@/components/ui/button";
import { chunkIndexFromToken } from "@xberg-io/wasm-pipeline";
import { PiiMarkdownEditor, type NewSpan } from "@/components/PiiMarkdownEditor";
import {
  HumanReviewPanel,
  type ReviewField,
  type HighlightArea,
  type JsonObject,
} from "@/components/ui/bounding-box-citations";

interface MirrorChunkLoc {
  chunk_index: number;
  page?: number;
  bbox?: { x: number; y: number; w: number; h: number };
}

function bboxToHighlightArea(bbox: { x: number; y: number; w: number; h: number }): HighlightArea {
  return { left: bbox.x, top: bbox.y, width: bbox.w, height: bbox.h };
}

// PiiEntity.text is always the redaction token (e.g. "{{C0_PERSON_1}}"), which is chunk-prefixed
// and therefore unique across the whole document — unlike kind/start/end, which are chunk-local
// and can collide between two different chunks' spans (start=6,end=11 in chunk 0 vs. chunk 5).
function fieldKey(e: PiiEntity): string {
  return e.text;
}

export interface ReviewSaveDecision {
  // Free-text corrections keyed the same way as before — purely an audit annotation, doesn't by
  // itself change what's redacted.
  reviewedPii: Record<string, { expected: string | null }>;
  // Tokens of spans the reviewer marked as false positives — these get un-redacted.
  rejectedKeys: string[];
  // Missed PII spans the reviewer found still in plain text, to be redacted.
  newSpans: NewSpan[];
}

interface PiiReviewPanelProps {
  pii: PiiEntity[];
  mirror?: Uint8Array;
  // Needed to decrypt the vault for the markdown editor (PiiMarkdownEditor). Absent when the
  // matter passphrase hasn't been set yet in this session.
  passphrase?: string;
  reviewedPii?: Record<string, { expected: string | null }>;
  onSave: (decision: ReviewSaveDecision) => void | Promise<void>;
  // Matter's extraction template (Step 8) — non-empty means collapse kinds outside it.
  selectedKinds?: string[];
}

export function PiiReviewPanel({ pii, mirror, passphrase, reviewedPii, onSave, selectedKinds }: PiiReviewPanelProps) {
  const [rejectedKeys, setRejectedKeys] = useState<string[]>([]);
  const [newSpans, setNewSpans] = useState<NewSpan[]>([]);
  const [saving, setSaving] = useState(false);

  const handleDecisionChange = useCallback((nextRejected: string[], nextNewSpans: NewSpan[]) => {
    setRejectedKeys(nextRejected);
    setNewSpans(nextNewSpans);
  }, []);

  const fields = useMemo<ReviewField[]>(() => {
    let chunks: MirrorChunkLoc[] = [];
    if (mirror) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(mirror)) as { chunks?: MirrorChunkLoc[] };
        chunks = parsed.chunks ?? [];
      } catch {
        chunks = [];
      }
    }

    const filtered =
      selectedKinds && selectedKinds.length > 0
        ? pii.filter((e) => selectedKinds.some((k) => k.toLowerCase() === e.kind.toLowerCase()))
        : pii;

    return filtered.map((e) => {
      const key = fieldKey(e);
      const chunkIndex = chunkIndexFromToken(e.text);
      const chunk = chunkIndex !== null ? chunks.find((c) => c.chunk_index === chunkIndex) : undefined;
      const saved = reviewedPii?.[key];
      return {
        key,
        schema: { type: "string", title: e.kind },
        actual: e.text,
        expected: saved ? saved.expected : e.text,
        location:
          chunk?.page !== undefined && chunk.bbox
            ? { page: chunk.page, area: bboxToHighlightArea(chunk.bbox) }
            : undefined,
      } satisfies ReviewField;
    });
  }, [pii, mirror, reviewedPii, selectedKinds]);

  const expectedRef = useMemo(() => ({ current: {} as JsonObject }), [fields]);

  async function handleSave() {
    const out: Record<string, { expected: string | null }> = {};
    for (const field of fields) {
      const value = expectedRef.current[field.key];
      out[field.key] = { expected: typeof value === "string" ? value : value === null ? null : String(field.actual) };
    }
    setSaving(true);
    try {
      await onSave({ reviewedPii: out, rejectedKeys, newSpans });
      setRejectedKeys([]);
      setNewSpans([]);
    } catch {
      // onSave already surfaces the failure (DocumentView's reviewError banner) and rethrows —
      // swallow here so this doesn't become an unhandled rejection from the button's onClick, and
      // skip clearing state so the reviewer's pending rejections/new spans survive for a retry
      // instead of being silently discarded.
    } finally {
      setSaving(false);
    }
  }

  if (!mirror) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No mirror available for review — try re-ingesting this document.
      </p>
    );
  }
  if (!passphrase) {
    return <p className="p-4 text-sm text-muted-foreground">Set the matter passphrase to review PII.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {fields.length > 0 && (
        <HumanReviewPanel
          fields={fields}
          showExpected
          onExpectedChange={(expected) => {
            expectedRef.current = expected;
          }}
        />
      )}
      <PiiMarkdownEditor mirror={mirror} passphrase={passphrase} onDecisionChange={handleDecisionChange} />
      <Button size="sm" onClick={handleSave} disabled={saving} className="mx-2">
        {saving ? "Saving…" : "Save review"}
      </Button>
    </div>
  );
}
