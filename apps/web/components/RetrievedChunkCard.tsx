"use client";

import Link from "next/link";
import type { RetrievedChunk } from "@xberg-io/core";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export function RetrievedChunkCard({ chunk }: { chunk: RetrievedChunk }) {
	const params = new URLSearchParams();
	if (chunk.page !== undefined) params.set("page", String(chunk.page));
	if (chunk.bbox) params.set("bbox", JSON.stringify(chunk.bbox));
	const href = `/documents/${encodeURIComponent(chunk.doc_id)}${params.size ? `?${params.toString()}` : ""}`;

	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
				<Link href={href} className="text-sm font-medium underline-offset-2 hover:underline">
					{chunk.citation}
				</Link>
				<span className="text-xs text-muted-foreground">score {chunk.score.toFixed(3)}</span>
			</CardHeader>
			<CardContent className="text-sm whitespace-pre-wrap">{chunk.text}</CardContent>
		</Card>
	);
}
