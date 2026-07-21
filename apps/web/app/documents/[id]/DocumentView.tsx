"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type { Document as DocumentType } from "@xberg-io/core";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { PiiPanel } from "@/components/PiiPanel";
import { DocumentDualView } from "@/components/DocumentDualView";
import { detectViewerKind } from "@/components/document-router";
import { useAuth } from "@/lib/auth";
import { getDocument } from "@/lib/api";
import { getOriginalFile, saveReviewedPii, saveSplits, type StoredDocument } from "@/lib/file-store";
import { createInitialSplits, type DocumentSplit } from "@/components/ui/document-splits";
import { getMatterTemplate } from "@/lib/matter-templates";
import { routeIdFromLocation } from "@/lib/route-id";

// bounding-box-citations renders via Glide Data Grid (JSON tab), which requires browser APIs not
// present during SSR/static export.
const PiiReviewPanel = dynamic(() => import("@/components/PiiReviewPanel").then((m) => m.PiiReviewPanel), {
	ssr: false,
});

// document-splits uses @dnd-kit pointer sensors, which need a real browser environment.
const DocumentSplits = dynamic(() => import("@/components/ui/document-splits").then((m) => m.DocumentSplits), {
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

export default function DocumentView({ id: propId }: DocumentViewProps) {
	const id = routeIdFromLocation("documents", propId);
	const router = useRouter();
	const { auth } = useAuth();
	const [doc, setDoc] = useState<DocumentType | null>(null);
	const [stored, setStored] = useState<StoredDocument | null>(null);
	const [notFound, setNotFound] = useState(false);
	const srcRef = useRef<string | null>(null);
	const [src, setSrc] = useState<string | null>(null);
	const [textContent, setTextContent] = useState<string>("");
	const [splits, setSplits] = useState<DocumentSplit[]>([]);
	const [selectedKinds, setSelectedKinds] = useState<string[]>([]);

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
				setSplits(cached.splits ?? createInitialSplits(metadata.pages));
				getMatterTemplate(metadata.matter_id).then((kinds) => {
					if (!cancelled) setSelectedKinds(kinds ?? []);
				});
				const kind = detectViewerKind(cached.mimeType, cached.fileName);
				if (kind === "text" || kind === "csv") {
					setTextContent(await cached.file.text());
				}
				if (cancelled) return;
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
			<ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
				<ResizablePanel defaultSize={70} minSize={30}>
					<DocumentDualView
						mimeType={stored.mimeType}
						fileName={stored.fileName}
						src={src}
						textContent={textContent}
						redactedText={redactedTextFromMirror(stored.mirror)}
					/>
				</ResizablePanel>
				<ResizableHandle withHandle />
				<ResizablePanel defaultSize={30} minSize={20} collapsible collapsedSize={0}>
					<Tabs defaultValue="pii" className="h-full min-h-0 pl-3">
						<TabsList>
							<TabsTrigger value="pii">PII</TabsTrigger>
							<TabsTrigger value="review">Review</TabsTrigger>
							<TabsTrigger value="splits">Splits</TabsTrigger>
						</TabsList>
						<TabsContent value="pii">
							<PiiPanel pii={stored.pii} mirror={stored.mirror} selectedKinds={selectedKinds} />
						</TabsContent>
						<TabsContent value="review">
							<PiiReviewPanel
								pii={stored.pii}
								mirror={stored.mirror}
								reviewedPii={stored.reviewedPii}
								selectedKinds={selectedKinds}
								onSave={async (reviewed) => {
									await saveReviewedPii(id, reviewed);
									setStored((prev) => (prev ? { ...prev, reviewedPii: reviewed } : prev));
								}}
							/>
						</TabsContent>
						<TabsContent value="splits">
							<DocumentSplits
								splits={splits}
								onSelectPage={() => {
									/* page-level jump is viewer-specific (Step 6's PDF scrollToPage); not wired for
									   non-PDF formats here. */
								}}
								onSplitsChange={(next) => {
									setSplits(next);
									void saveSplits(id, next);
								}}
							/>
						</TabsContent>
					</Tabs>
				</ResizablePanel>
			</ResizablePanelGroup>
		</main>
	);
}
