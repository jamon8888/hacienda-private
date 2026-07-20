"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type { Document as DocumentType } from "@xberg-io/core";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PiiPanel } from "@/components/PiiPanel";
import { DocumentDualView } from "@/components/DocumentDualView";
import { detectViewerKind } from "@/components/document-router";
import { useAuth } from "@/lib/auth";
import { getDocument } from "@/lib/api";
import { getOriginalFile, saveReviewedPii, type StoredDocument } from "@/lib/file-store";

// bounding-box-citations renders via Glide Data Grid (JSON tab), which requires browser APIs not
// present during SSR/static export.
const PiiReviewPanel = dynamic(() => import("@/components/PiiReviewPanel").then((m) => m.PiiReviewPanel), {
	ssr: false,
});

interface MirrorChunk {
	text: string;
}

function redactedTextFromMirror(mirror: Uint8Array | undefined): string {
	if (!mirror) return "";
	try {
		const parsed = JSON.parse(new TextDecoder().decode(mirror)) as { chunks?: MirrorChunk[] };
		return (parsed.chunks ?? []).map((c) => c.text).join("\n\n");
	} catch {
		return "";
	}
}

interface DocumentViewProps {
	id: string;
}

export default function DocumentView({ id }: DocumentViewProps) {
	const router = useRouter();
	const { auth } = useAuth();
	const [doc, setDoc] = useState<DocumentType | null>(null);
	const [stored, setStored] = useState<StoredDocument | null>(null);
	const [notFound, setNotFound] = useState(false);
	const srcRef = useRef<string | null>(null);
	const [src, setSrc] = useState<string | null>(null);
	const [textContent, setTextContent] = useState<string>("");

	useEffect(() => {
		if (!auth || !id) return;
		let cancelled = false;

		(async () => {
			try {
				const [metadata, cached] = await Promise.all([getDocument(auth.token, id), getOriginalFile(id)]);
				if (cancelled) return;
				setDoc(metadata);
				if (!cached) {
					setNotFound(true);
					return;
				}
				setStored(cached);
				const kind = detectViewerKind(cached.mimeType, cached.fileName);
				if (kind === "text" || kind === "csv") {
					setTextContent(await cached.file.text());
				}
				const url = URL.createObjectURL(cached.file);
				srcRef.current = url;
				setSrc(url);
			} catch {
				if (!cancelled) setNotFound(true);
			}
		})();

		return () => {
			cancelled = true;
			if (srcRef.current) URL.revokeObjectURL(srcRef.current);
		};
	}, [auth, id]);

	if (notFound) {
		return (
			<main className="mx-auto max-w-3xl p-6 text-center">
				<p className="text-muted-foreground">
					{doc
						? "This document's original file isn't cached in this browser (a different device or a cleared cache) — only metadata is available."
						: "Document not found."}
				</p>
				<Button className="mt-4" variant="ghost" onClick={() => router.back()}>
					← Back
				</Button>
			</main>
		);
	}

	if (!doc || !stored || !src) {
		return (
			<main className="mx-auto max-w-3xl p-6 text-center">
				<p className="text-muted-foreground">Loading…</p>
			</main>
		);
	}

	return (
		<main className="flex h-screen flex-col p-4">
			<div className="mb-4 flex items-center justify-between">
				<Button variant="ghost" onClick={() => router.back()}>
					← Folder
				</Button>
				<h1 className="truncate text-lg font-semibold">{stored.fileName}</h1>
				<span className="text-xs text-muted-foreground">{doc.pages} pages</span>
			</div>
			<div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[1fr_320px]">
				<DocumentDualView
					mimeType={stored.mimeType}
					fileName={stored.fileName}
					src={src}
					textContent={textContent}
					redactedText={redactedTextFromMirror(stored.mirror)}
				/>
				<Tabs defaultValue="pii" className="min-h-0">
					<TabsList>
						<TabsTrigger value="pii">PII</TabsTrigger>
						<TabsTrigger value="review">Review</TabsTrigger>
					</TabsList>
					<TabsContent value="pii">
						<PiiPanel pii={stored.pii} mirror={stored.mirror} />
					</TabsContent>
					<TabsContent value="review">
						<PiiReviewPanel
							pii={stored.pii}
							mirror={stored.mirror}
							reviewedPii={stored.reviewedPii}
							onSave={async (reviewed) => {
								await saveReviewedPii(id, reviewed);
								setStored((prev) => (prev ? { ...prev, reviewedPii: reviewed } : prev));
							}}
						/>
					</TabsContent>
				</Tabs>
			</div>
		</main>
	);
}
