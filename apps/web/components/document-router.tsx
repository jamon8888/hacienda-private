"use client";

import { useTheme } from "next-themes";
import { PDFViewer } from "@/components/ui/pdf-viewer";
import { DocxViewerPreview } from "@/components/ui/docx-viewer";
import { XlsxViewerPreview } from "@/components/ui/xlsx-viewer";
import { PptxViewerPreview } from "@/components/ui/pptx-viewer";
import { CsvViewer } from "@/components/ui/csv-viewer";

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
}

export function DocumentRouter({ mimeType, fileName, src, textContent }: DocumentRouterProps) {
	const { resolvedTheme, setTheme } = useTheme();
	const isDark = resolvedTheme === "dark";
	const onIsDarkChange = (next: boolean) => setTheme(next ? "dark" : "light");
	const kind = detectViewerKind(mimeType, fileName);

	switch (kind) {
		case "pdf":
			return <PDFViewer src={src} fileName={fileName} />;
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
