"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Toggle } from "@/components/ui/toggle";
import { DocumentRouter } from "@/components/document-router";

interface DocumentDualViewProps {
	mimeType: string;
	fileName: string;
	src: string;
	textContent: string;
	// Redacted text reconstructed from this document's mirror chunks — the exact text a Claude
	// Desktop MCP query would retrieve, tokens (`{{PERSON_1}}`, ...) standing in for PII.
	redactedText: string;
}

export function DocumentDualView({ mimeType, fileName, src, textContent, redactedText }: DocumentDualViewProps) {
	const [syncScroll, setSyncScroll] = useState(false);

	async function copyForClaude() {
		await navigator.clipboard.writeText(redactedText);
	}

	return (
		<div className="flex h-full min-h-0 flex-col gap-3">
			<div className="min-h-0 flex-1 overflow-auto rounded-lg border">
				<DocumentRouter mimeType={mimeType} fileName={fileName} src={src} textContent={textContent} />
			</div>

			<div className="flex items-center justify-between gap-2">
				<TrustBadge />
				<div className="flex items-center gap-2">
					<Toggle pressed={syncScroll} onPressedChange={setSyncScroll} size="sm">
						Sync scroll
					</Toggle>
					<Button size="sm" variant="outline" onClick={copyForClaude}>
						Copy for Claude Desktop
					</Button>
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/30 p-4 font-mono text-sm whitespace-pre-wrap">
				{redactedText || "No redacted text available."}
			</div>
		</div>
	);
}

function TrustBadge() {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button size="sm" variant="ghost" className="gap-1">
					🔒 What Claude sees
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-80 space-y-2 text-sm">
				<p className="font-medium">This is the exact document sent to Claude Desktop.</p>
				<p>
					PII replaced with tokens: <code>{"{{PERSON_1}}"}</code>, <code>{"{{EMAIL_1}}"}</code>…
				</p>
				<p>Original PII sealed in vault (passphrase required to rehydrate).</p>
				<p>No plaintext ever leaves your browser.</p>
			</PopoverContent>
		</Popover>
	);
}
