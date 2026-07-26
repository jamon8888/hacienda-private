"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { Decoration, EditorView, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { openVault, rehydrate, listPiiTypes, chunkIndexFromToken, type RedactionEntry } from "@xberg-io/wasm-pipeline";
import { Button } from "@/components/ui/button";

interface MirrorChunkText {
  chunk_index: number;
  text: string;
}

// A PII span translated into the concatenated whole-document buffer this editor renders.
interface GlobalSpan {
  token: string;
  kind: string;
  start: number;
  end: number;
}

export interface NewSpan {
  text: string;
  kind: string;
  chunkIndex: number;
  start: number;
  end: number;
}

interface PiiMarkdownEditorProps {
  mirror: Uint8Array;
  passphrase: string;
  onDecisionChange: (rejectedKeys: string[], newSpans: NewSpan[]) => void;
}

const SEPARATOR = "\n\n";

interface Prepared {
  fullText: string;
  spans: GlobalSpan[];
  // Chunk boundaries in the global buffer, sorted by start — used to translate a selection's
  // global offset back into (chunkIndex, localOffset) for reviewAndRepush.
  chunkBounds: { chunkIndex: number; start: number; end: number }[];
}

function globalToChunkLocal(
  chunkBounds: Prepared["chunkBounds"],
  globalOffset: number,
): { chunkIndex: number; localOffset: number } | null {
  for (const bound of chunkBounds) {
    if (globalOffset >= bound.start && globalOffset <= bound.end) {
      return { chunkIndex: bound.chunkIndex, localOffset: globalOffset - bound.start };
    }
  }
  return null;
}

async function prepare(mirror: Uint8Array, passphrase: string): Promise<Prepared> {
  const parsed = JSON.parse(new TextDecoder().decode(mirror)) as {
    vault?: number[];
    vaultSalt?: number[];
    chunks?: MirrorChunkText[];
  };
  const chunks = parsed.chunks ?? [];
  let entries: RedactionEntry[] = [];
  if (Array.isArray(parsed.vault) && Array.isArray(parsed.vaultSalt)) {
    entries = await openVault(
      { cipher: Uint8Array.from(parsed.vault), salt: Uint8Array.from(parsed.vaultSalt) },
      passphrase,
    );
  }

  const parts: string[] = [];
  const spans: GlobalSpan[] = [];
  const chunkBounds: Prepared["chunkBounds"] = [];
  let cursor = 0;

  for (const chunk of [...chunks].sort((a, b) => a.chunk_index - b.chunk_index)) {
    const chunkEntries = entries.filter((e) => chunkIndexFromToken(e.token) === chunk.chunk_index);
    const originalText = rehydrate(chunk.text, chunkEntries);

    const chunkStart = cursor;
    for (const e of chunkEntries) {
      spans.push({ token: e.token, kind: e.kind, start: chunkStart + e.start, end: chunkStart + e.end });
    }
    chunkBounds.push({ chunkIndex: chunk.chunk_index, start: chunkStart, end: chunkStart + originalText.length });

    parts.push(originalText);
    cursor += originalText.length + SEPARATOR.length;
  }

  return { fullText: parts.join(SEPARATOR), spans, chunkBounds };
}

function buildDecorations(spans: GlobalSpan[], rejected: Set<string>): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const isRejected = rejected.has(span.token);
    builder.add(
      span.start,
      span.end,
      Decoration.mark({
        attributes: {
          style: isRejected
            ? "text-decoration: line-through; opacity: 0.5; cursor: pointer;"
            : "background: rgba(250, 204, 21, 0.4); border-radius: 2px; cursor: pointer;",
          title: isRejected ? "Un-redacted — click to keep redacted" : `${span.kind} — click to un-redact`,
          "data-pii-token": span.token,
        },
      }),
    );
  }
  return builder.finish();
}

export function PiiMarkdownEditor({ mirror, passphrase, onDecisionChange }: PiiMarkdownEditorProps) {
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [newSpans, setNewSpans] = useState<NewSpan[]>([]);
  const [selection, setSelection] = useState<{ from: number; to: number; text: string } | null>(null);
  const [draftKind, setDraftKind] = useState(listPiiTypes()[0] ?? "PERSON");
  // Read via a ref rather than as an effect dependency below — onDecisionChange is typically a
  // fresh closure on every parent render, and depending on it directly would either re-fire the
  // effect every render or force every caller to useCallback it themselves.
  const onDecisionChangeRef = useRef(onDecisionChange);
  onDecisionChangeRef.current = onDecisionChange;

  useEffect(() => {
    let cancelled = false;
    setPrepared(null);
    setError(null);
    setRejected(new Set());
    setNewSpans([]);
    setSelection(null);
    prepare(mirror, passphrase)
      .then((result) => {
        if (!cancelled) setPrepared(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to decrypt this document.");
      });
    return () => {
      cancelled = true;
    };
  }, [mirror, passphrase]);

  useEffect(() => {
    onDecisionChangeRef.current(Array.from(rejected), newSpans);
  }, [rejected, newSpans]);

  const extensions = useMemo<Extension[]>(() => {
    if (!prepared) return [];
    const decorations = buildDecorations(prepared.spans, rejected);
    return [
      markdown(),
      EditorView.decorations.of(decorations),
      EditorView.domEventHandlers({
        mousedown(event) {
          const target = event.target as HTMLElement;
          const token = target.closest<HTMLElement>("[data-pii-token]")?.dataset.piiToken;
          if (!token) return false;
          event.preventDefault();
          setRejected((prev) => {
            const next = new Set(prev);
            if (next.has(token)) next.delete(token);
            else next.add(token);
            return next;
          });
          return true;
        },
      }),
      EditorView.contentAttributes.of({ "aria-readonly": "true" }),
    ];
  }, [prepared, rejected]);

  function handleUpdate(viewUpdate: ViewUpdate) {
    if (!prepared) return;
    const { from, to } = viewUpdate.state.selection.main;
    if (from === to) {
      setSelection(null);
      return;
    }
    const text = prepared.fullText.slice(from, to);
    // Ignore a selection that overlaps an already-highlighted span — that's a reject, not an add.
    const overlapsExisting = prepared.spans.some((s) => from < s.end && to > s.start && !rejected.has(s.token));
    setSelection(overlapsExisting ? null : { from, to, text });
  }

  function addSelectionAsSpan() {
    if (!prepared || !selection) return;
    const loc = globalToChunkLocal(prepared.chunkBounds, selection.from);
    if (!loc) return;
    setNewSpans((prev) => [
      ...prev,
      {
        text: selection.text,
        kind: draftKind,
        chunkIndex: loc.chunkIndex,
        start: loc.localOffset,
        end: loc.localOffset + selection.text.length,
      },
    ]);
    setSelection(null);
  }

  function removeNewSpan(index: number) {
    setNewSpans((prev) => prev.filter((_, i) => i !== index));
  }

  if (error) {
    return <p className="p-4 text-sm text-destructive">{error}</p>;
  }
  if (!prepared) {
    return <p className="p-4 text-sm text-muted-foreground">Decrypting…</p>;
  }
  if (!prepared.fullText) {
    return <p className="p-4 text-sm text-muted-foreground">No content to review.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="px-1 text-xs text-muted-foreground">
        Highlighted text is detected PII — click a highlight to un-redact a false positive. Select any other text to
        mark a missed span.
      </p>
      <div className="max-h-96 overflow-auto rounded-md border">
        <CodeMirror
          value={prepared.fullText}
          extensions={extensions}
          readOnly
          basicSetup={{ lineNumbers: false, foldGutter: false }}
          onUpdate={handleUpdate}
        />
      </div>
      {selection && (
        <div className="flex items-center gap-2 px-1">
          <span className="truncate text-xs text-muted-foreground">Mark "{selection.text}" as:</span>
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs"
            value={draftKind}
            onChange={(e) => setDraftKind(e.target.value)}
          >
            {listPiiTypes().map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
          <Button size="sm" variant="secondary" onClick={addSelectionAsSpan}>
            Add
          </Button>
        </div>
      )}
      {newSpans.length > 0 && (
        <ul className="flex flex-col gap-1 px-1">
          {newSpans.map((s, i) => (
            <li key={`${s.chunkIndex}-${s.start}-${i}`} className="flex items-center justify-between text-xs">
              <span className="truncate">
                {s.kind}: {s.text}
              </span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => removeNewSpan(i)}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
