"use client";

import { useMemo } from "react";
import type { PiiEntity } from "@xberg-io/core";
import { Button } from "@/components/ui/button";
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

// Redaction tokens are minted per-chunk as `{{C<chunkIndex>_<CATEGORY>_<n>}}` (see
// packages/wasm-pipeline/src/redact.ts buildRedaction, called with prefix `C${chunkIndex}` in
// adapter.ts). Parsing it back out is the only way to locate which chunk (and therefore which
// page/bbox) a given PII span belongs to — PiiEntity itself carries no location.
function chunkIndexFromToken(token: string): number | null {
	const match = /^\{\{C(\d+)_/.exec(token);
	return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

function fieldKey(e: PiiEntity): string {
	return `${e.kind}-${e.start}-${e.end}`;
}

interface PiiReviewPanelProps {
	pii: PiiEntity[];
	mirror?: Uint8Array;
	reviewedPii?: Record<string, { expected: string | null }>;
	onSave: (reviewedPii: Record<string, { expected: string | null }>) => void;
	// Matter's extraction template (Step 8) — non-empty means collapse kinds outside it.
	selectedKinds?: string[];
}

export function PiiReviewPanel({ pii, mirror, reviewedPii, onSave, selectedKinds }: PiiReviewPanelProps) {
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
				location: chunk?.page !== undefined && chunk.bbox ? { page: chunk.page, area: bboxToHighlightArea(chunk.bbox) } : undefined,
			} satisfies ReviewField;
		});
	}, [pii, mirror, reviewedPii, selectedKinds]);

	const expectedRef = useMemo(() => ({ current: {} as JsonObject }), [fields]);

	function handleSave() {
		const out: Record<string, { expected: string | null }> = {};
		for (const field of fields) {
			const value = expectedRef.current[field.key];
			out[field.key] = { expected: typeof value === "string" ? value : value === null ? null : String(field.actual) };
		}
		onSave(out);
	}

	if (fields.length === 0) {
		return <p className="p-4 text-sm text-muted-foreground">No PII to review.</p>;
	}

	return (
		<div className="flex flex-col gap-2">
			<HumanReviewPanel
				fields={fields}
				showExpected
				onExpectedChange={(expected) => {
					expectedRef.current = expected;
				}}
			/>
			<Button size="sm" onClick={handleSave}>
				Save review
			</Button>
		</div>
	);
}
