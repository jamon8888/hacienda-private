import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// jsdom doesn't implement window.matchMedia. The real FileDropzone (rendered here once
// models are "ready") pulls in `border-beam`'s <BorderBeam>, which reads
// window.matchMedia("(prefers-reduced-motion: reduce)") during render — unrelated to the
// model-warmup gating under test, but required for this file's render-to-completion tests.
if (typeof window !== "undefined" && !window.matchMedia) {
	window.matchMedia = ((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	})) as unknown as typeof window.matchMedia;
}

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams("matter_id=m1"),
}));

vi.mock("@/lib/auth", () => ({
	useAuth: () => ({ auth: { token: "t1", passphrase: "pw" }, setPassphrase: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
	getFolders: async () => [{ id: "f1", name: "Folder One" }],
	getFolderDocuments: async () => [],
	createDocument: vi.fn(),
	updateDocumentStatus: vi.fn(),
}));

vi.mock("@/lib/file-store", () => ({
	saveOriginalFile: vi.fn(),
}));

vi.mock("@/lib/route-id", () => ({
	routeIdFromLocation: (_segment: string, fallback: string) => fallback,
}));

vi.mock("@xberg-io/wasm-pipeline", () => ({
	ingestFolder: vi.fn(),
}));

const warmupState: { current: { stage: string } } = { current: { stage: "loading" } };
vi.mock("@/lib/engine/warmup-store", () => ({
	useModelWarmup: () => warmupState.current,
}));

import FolderView from "./FolderView";

describe("FolderView ingest gating", () => {
	it("shows a preparing-models placeholder instead of the dropzone while models are loading", async () => {
		warmupState.current = { stage: "loading" };
		render(<FolderView id="f1" />);
		expect(await screen.findByText(/Preparing on-device AI models/i)).toBeInTheDocument();
	});

	it("does not show the preparing-models placeholder once models are ready", async () => {
		warmupState.current = { stage: "ready" };
		render(<FolderView id="f1" />);
		await screen.findByText("Folder One");
		expect(screen.queryByText(/Preparing on-device AI models/i)).not.toBeInTheDocument();
	});
});
