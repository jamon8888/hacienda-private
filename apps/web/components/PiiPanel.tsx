"use client";

import { useMemo, useState } from "react";
import type { PiiEntity } from "@xberg-io/core";
import { rehydrateSpanForUi } from "@xberg-io/wasm-pipeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

function maskFor(kind: string, indexInKind: number): string {
	const cat = kind
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return `{{${cat}_${indexInKind}}}`;
}

interface PiiPanelProps {
	pii: PiiEntity[];
	// Raw mirror payload bytes for this document (IngestResult.mirror). Required to reveal a span —
	// without it, the panel only ever shows masked tokens.
	mirror?: Uint8Array;
}

export function PiiPanel({ pii, mirror }: PiiPanelProps) {
	const masked = useMemo(() => {
		const counters = new Map<string, number>();
		return pii.map((e) => {
			const n = (counters.get(e.kind) ?? 0) + 1;
			counters.set(e.kind, n);
			return { entity: e, mask: maskFor(e.kind, n) };
		});
	}, [pii]);

	return (
		<Card className="col-span-1">
			<CardHeader>
				<CardTitle>Detected PII ({pii.length})</CardTitle>
			</CardHeader>
			<CardContent className="max-h-[60vh] overflow-auto">
				{pii.length === 0 ? (
					<p className="text-sm text-muted-foreground">No PII detected.</p>
				) : (
					<ul className="space-y-2">
						{masked.map(({ entity, mask }, i) => (
							<li key={i} className="flex items-center justify-between gap-2 text-sm">
								<RevealableSpan mask={mask} entity={entity} mirror={mirror} />
								<Badge variant="destructive">{entity.kind}</Badge>
							</li>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

function RevealableSpan({
	mask,
	entity,
	mirror,
}: {
	mask: string;
	entity: PiiEntity;
	mirror?: Uint8Array;
}) {
	const [open, setOpen] = useState(false);
	const [passphrase, setPassphrase] = useState("");
	const [revealed, setRevealed] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function onReveal() {
		if (!mirror) {
			setError("No mirror bundle available for this document.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			// Client-side only: rehydrateSpanForUi decrypts the sealed vault in-memory via WebCrypto.
			// No network call — the passphrase and plaintext never leave the browser.
			const value = await rehydrateSpanForUi(mirror, entity, passphrase);
			setRevealed(value);
			setOpen(false);
		} catch {
			setError("Wrong passphrase or no matching entry.");
		} finally {
			setBusy(false);
			setPassphrase("");
		}
	}

	return (
		<Popover
			onOpenChange={(next) => {
				// Session-only reveal: closing the popover forgets the plaintext, never persisted.
				if (!next) setRevealed(null);
			}}
		>
			<PopoverTrigger asChild>
				<span className="truncate rounded bg-muted px-2 py-1 font-mono text-xs cursor-pointer">
					{revealed ?? mask}
				</span>
			</PopoverTrigger>
			<PopoverContent className="w-64 space-y-2">
				{revealed ? (
					<p className="break-words text-sm">{revealed}</p>
				) : (
					<Dialog open={open} onOpenChange={setOpen}>
						<DialogTrigger asChild>
							<Button size="sm" variant="outline">
								Reveal
							</Button>
						</DialogTrigger>
						<DialogContent>
							<DialogHeader>
								<DialogTitle>Enter matter passphrase</DialogTitle>
							</DialogHeader>
							<Input
								type="password"
								value={passphrase}
								onChange={(e) => setPassphrase(e.target.value)}
								placeholder="Passphrase"
							/>
							{error && <p className="text-sm text-destructive">{error}</p>}
							<Button onClick={onReveal} disabled={busy || !passphrase}>
								{busy ? "Revealing…" : "Reveal"}
							</Button>
						</DialogContent>
					</Dialog>
				)}
			</PopoverContent>
		</Popover>
	);
}
