"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";
import { PDFViewer, type PDFViewerHandle } from "@/components/ui/pdf-viewer";
import { DocxViewerPreview } from "@/components/ui/docx-viewer";
import { XlsxViewerPreview } from "@/components/ui/xlsx-viewer";
import { PptxViewerPreview } from "@/components/ui/pptx-viewer";
import { CsvViewer } from "@/components/ui/csv-viewer";
import type { CitationTarget } from "@/lib/citation-target";

export type ViewerKind = "pdf" | "docx" | "xlsx" | "pptx" | "csv" | "image" | "text";

const EXTENSION_KIND: Record<string, ViewerKind> = {
	pdf: "pdf",
	docx: "docx",
	doc: "docx",
	xlsx: "xlsx",
	xls: "xlsx",
	pptx: "pptx",
	ppt: "pptx",
	csv: "csv",
	tsv: "csv",
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	svg: "image",
	txt: "text",
	md: "text",
	markdown: "text",
	json: "text",
};

const MIME_KIND: Record<string, ViewerKind> = {
	"application/pdf": "pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
	"text/csv": "csv",
	"text/tab-separated-values": "csv",
	"application/json": "text",
	"text/markdown": "text",
};

export function detectViewerKind(mimeType: string | undefined, fileName: string): ViewerKind {
	if (mimeType) {
		if (MIME_KIND[mimeType]) return MIME_KIND[mimeType];
		if (mimeType.startsWith("image/")) return "image";
		if (mimeType.startsWith("text/")) return "text";
	}
	const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
	return EXTENSION_KIND[ext] ?? "text";
}

interface DocumentRouterProps {
	mimeType: string | undefined;
	fileName: string;
	src: string;
	// Only used by the text/CSV/image inline branches, which render content directly rather than
	// fetching from `src` themselves.
	textContent?: string;
	// Page/bbox to scroll to and highlight, parsed from a citation deep-link. Only the PDF branch
	// acts on it; other viewers don't have a page/bbox concept.
	citationTarget?: CitationTarget;
}

export function DocumentRouter({ mimeType, fileName, src, textContent, citationTarget }: DocumentRouterProps) {
	const { resolvedTheme, setTheme } = useTheme();
	const isDark = resolvedTheme === "dark";
	const onIsDarkChange = (next: boolean) => setTheme(next ? "dark" : "light");
	const kind = detectViewerKind(mimeType, fileName);

	switch (kind) {
		case "pdf":
			return <PdfWithCitation src={src} fileName={fileName} citationTarget={citationTarget} />;
		case "docx":
			return <DocxViewerPreview src={src} fileName={fileName} isDark={isDark} onIsDarkChange={onIsDarkChange} />;
		case "xlsx":
			return <XlsxViewerPreview src={src} fileName={fileName} isDark={isDark} onIsDarkChange={onIsDarkChange} />;
		case "pptx":
			return <PptxViewerPreview src={src} fileName={fileName} />;
		case "csv":
			return <CsvViewer data={textContent ?? ""} search />;
		case "image":
			// eslint-disable-next-line @next/next/no-img-element
			return <img src={src} alt={fileName} className="max-w-full" />;
		case "text":
		default:
			return <pre className="whitespace-pre-wrap text-sm p-4">{textContent ?? ""}</pre>;
	}
}

function PdfWithCitation({
	src,
	fileName,
	citationTarget,
}: {
	src: string;
	fileName: string;
	citationTarget?: CitationTarget;
}) {
	const viewerRef = useRef<PDFViewerHandle>(null);

	useEffect(() => {
		const page = citationTarget?.page;
		if (!page) return;
		// The engine reports bbox in PDF-point corners (x,y top-left). scrollToPageArea's `top`/`left`
		// are page-relative offsets in the same space; width/height frame the cited region. Absent bbox
		// → scroll to the page top. Retry briefly: the viewport may not be laid out on first paint.
		const bbox = citationTarget?.bbox;
		const area = bbox ? { top: bbox.y, left: bbox.x, width: bbox.w, height: bbox.h } : { top: 0 };
		let tries = 0;
		const timer = setInterval(() => {
			viewerRef.current?.scrollToPageArea(page, area);
			if (viewerRef.current?.getViewportElement() || ++tries >= 10) clearInterval(timer);
		}, 150);
		return () => clearInterval(timer);
	}, [citationTarget?.page, citationTarget?.bbox]);

	return (
		<PDFViewer
			ref={viewerRef}
			src={src}
			fileName={fileName}
			renderPageOverlay={({ pageNumber, scale }) =>
				citationTarget?.bbox && citationTarget.page === pageNumber ? (
					<div
						aria-hidden
						className="pointer-events-none absolute rounded-sm bg-blue-500/20 ring-2 ring-blue-500/70"
						style={{
							left: citationTarget.bbox.x * scale,
							top: citationTarget.bbox.y * scale,
							width: citationTarget.bbox.w * scale,
							height: citationTarget.bbox.h * scale,
						}}
					/>
				) : null
			}
		/>
	);
}
