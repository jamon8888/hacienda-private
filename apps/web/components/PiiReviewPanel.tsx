"use client";

import { useMemo, useState } from "react";
import type { PiiEntity } from "@xberg-io/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { chunkIndexFromToken } from "@xberg-io/wasm-pipeline";
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

function fieldKey(e: PiiEntity): string {
  return `${e.kind}-${e.start}-${e.end}`;
}

export interface ReviewSaveDecision {
  // Free-text corrections keyed the same way as before — purely an audit annotation, doesn't by
  // itself change what's redacted.
  reviewedPii: Record<string, { expected: string | null }>;
  // fieldKeys of spans the reviewer marked as false positives — these get un-redacted.
  rejectedKeys: string[];
  // Missed PII spans the reviewer found still in plain text, to be redacted.
  newSpans: { text: string; kind: string }[];
}

interface PiiReviewPanelProps {
  pii: PiiEntity[];
  mirror?: Uint8Array;
  reviewedPii?: Record<string, { expected: string | null }>;
  onSave: (decision: ReviewSaveDecision) => void | Promise<void>;
  // Matter's extraction template (Step 8) — non-empty means collapse kinds outside it.
  selectedKinds?: string[];
}

export function PiiReviewPanel({ pii, mirror, reviewedPii, onSave, selectedKinds }: PiiReviewPanelProps) {
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [newSpans, setNewSpans] = useState<{ text: string; kind: string }[]>([]);
  const [draftText, setDraftText] = useState("");
  const [draftKind, setDraftKind] = useState("");
  const [saving, setSaving] = useState(false);

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

  function toggleRejected(key: string) {
    setRejected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function addMissedSpan() {
    const text = draftText.trim();
    const kind = draftKind.trim();
    if (!text || !kind) return;
    setNewSpans((prev) => [...prev, { text, kind }]);
    setDraftText("");
    setDraftKind("");
  }

  function removeMissedSpan(index: number) {
    setNewSpans((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSave() {
    const out: Record<string, { expected: string | null }> = {};
    for (const field of fields) {
      const value = expectedRef.current[field.key];
      out[field.key] = { expected: typeof value === "string" ? value : value === null ? null : String(field.actual) };
    }
    setSaving(true);
    try {
      await onSave({ reviewedPii: out, rejectedKeys: Array.from(rejected), newSpans });
      setRejected(new Set());
      setNewSpans([]);
    } finally {
      setSaving(false);
    }
  }

  if (fields.length === 0 && newSpans.length === 0) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <p className="text-sm text-muted-foreground">No PII detected.</p>
        <AddMissedSpanForm
          draftText={draftText}
          draftKind={draftKind}
          onDraftText={setDraftText}
          onDraftKind={setDraftKind}
          onAdd={addMissedSpan}
        />
        {newSpans.length > 0 && <NewSpansList newSpans={newSpans} onRemove={removeMissedSpan} />}
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save review"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <HumanReviewPanel
        fields={fields}
        showExpected
        onExpectedChange={(expected) => {
          expectedRef.current = expected;
        }}
      />
      <div className="flex flex-col gap-1 px-2">
        <p className="text-xs font-medium text-muted-foreground">False positives (un-redact)</p>
        {fields.map((f) => (
          <label key={f.key} className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={rejected.has(f.key)} onChange={() => toggleRejected(f.key)} />
            <span className="truncate">
              {String(f.schema.title)}: {String(f.actual)}
            </span>
          </label>
        ))}
      </div>
      <div className="flex flex-col gap-2 px-2">
        <p className="text-xs font-medium text-muted-foreground">Missed PII spans</p>
        <AddMissedSpanForm
          draftText={draftText}
          draftKind={draftKind}
          onDraftText={setDraftText}
          onDraftKind={setDraftKind}
          onAdd={addMissedSpan}
        />
        {newSpans.length > 0 && <NewSpansList newSpans={newSpans} onRemove={removeMissedSpan} />}
      </div>
      <Button size="sm" onClick={handleSave} disabled={saving} className="mx-2">
        {saving ? "Saving…" : "Save review"}
      </Button>
    </div>
  );
}

function AddMissedSpanForm({
  draftText,
  draftKind,
  onDraftText,
  onDraftKind,
  onAdd,
}: {
  draftText: string;
  draftKind: string;
  onDraftText: (v: string) => void;
  onDraftKind: (v: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        placeholder="exact text to redact"
        value={draftText}
        onChange={(e) => onDraftText(e.target.value)}
        className="h-8 text-xs"
      />
      <Input
        placeholder="kind (e.g. PERSON)"
        value={draftKind}
        onChange={(e) => onDraftKind(e.target.value)}
        className="h-8 w-32 text-xs"
      />
      <Button size="sm" variant="secondary" onClick={onAdd} disabled={!draftText.trim() || !draftKind.trim()}>
        Add
      </Button>
    </div>
  );
}

function NewSpansList({
  newSpans,
  onRemove,
}: {
  newSpans: { text: string; kind: string }[];
  onRemove: (i: number) => void;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {newSpans.map((s, i) => (
        <li key={`${s.kind}-${s.text}-${i}`} className="flex items-center justify-between text-xs">
          <span className="truncate">
            {s.kind}: {s.text}
          </span>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onRemove(i)}>
            remove
          </button>
        </li>
      ))}
    </ul>
  );
}
