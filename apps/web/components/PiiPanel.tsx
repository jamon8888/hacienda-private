"use client";

import { useState } from "react";
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
import { cn } from "@/lib/utils";

interface PiiPanelProps {
	pii: PiiEntity[];
	// Raw mirror payload bytes for this document (IngestResult.mirror). Required to reveal a span —
	// without it, the panel only ever shows masked tokens.
	mirror?: Uint8Array;
	// Matter's extraction template (Step 8) — kinds the matter cares about. Non-selected kinds are
	// dimmed rather than removed, since detection itself is unaffected by the template.
	selectedKinds?: string[];
}

export function PiiPanel({ pii, mirror, selectedKinds }: PiiPanelProps) {
	const isSelected = (kind: string) =>
		!selectedKinds || selectedKinds.length === 0 || selectedKinds.some((k) => k.toLowerCase() === kind.toLowerCase());

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
						{pii.map((entity, i) => (
							<li
								key={i}
								className={cn(
									"flex items-center justify-between gap-2 text-sm",
									!isSelected(entity.kind) && "opacity-40",
								)}
							>
								<RevealableSpan entity={entity} mirror={mirror} />
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
	entity,
	mirror,
}: {
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
		} catch (err) {
			// Distinguish a stale/incompatible cached mirror (re-ingest needed) from an actual
			// wrong-passphrase/no-match failure, so the message doesn't mislead the user.
			setError(
				err instanceof Error && err.message.includes("missing vault data")
					? err.message
					: "Wrong passphrase or no matching entry.",
			);
		} finally {
			setBusy(false);
			setPassphrase("");
		}
	}

	return (
		<Popover
			onOpenChange={(next) => {
				// Session-only reveal: closing the popover forgets the plaintext, never persisted.
				if (!next) {
					setRevealed(null);
					setError(null);
				}
			}}
		>
			<PopoverTrigger asChild>
				<span className="truncate rounded bg-muted px-2 py-1 font-mono text-xs cursor-pointer">
					{revealed ?? entity.text}
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
