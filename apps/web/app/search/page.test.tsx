import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams("matter_id=m1"),
}));

vi.mock("@/lib/auth", () => ({
	useAuth: () => ({ ensureAuth: () => ({ token: "t1" }) }),
}));

vi.mock("@/lib/api", () => ({
	getMatters: async () => [{ id: "m1", name: "Matter One" }],
}));

vi.mock("@xberg-io/wasm-pipeline", () => ({
	queryRag: vi.fn(),
}));

const warmupState: { current: { stage: string } } = { current: { stage: "loading" } };
vi.mock("@/lib/engine/warmup-store", () => ({
	useModelWarmup: () => warmupState.current,
}));

import { SearchPageInner } from "./SearchPageInner";

describe("SearchPageInner", () => {
	it("disables search and labels the button while models are loading", async () => {
		warmupState.current = { stage: "loading" };
		render(<SearchPageInner />);
		const button = await screen.findByRole("button", { name: /preparing models/i });
		expect(button).toBeDisabled();
	});

	it("enables search once models are ready", async () => {
		warmupState.current = { stage: "ready" };
		render(<SearchPageInner />);
		// The button's disabled state also depends on a non-empty query and a resolved matter
		// (both pre-existing, untouched gates) — type a query so this test isolates the new
		// modelStage gate rather than being permanently blocked by the pre-existing ones.
		const input = await screen.findByPlaceholderText(/ask a question/i);
		fireEvent.change(input, { target: { value: "hello" } });
		const button = await screen.findByRole("button", { name: "Search" });
		expect(button).not.toBeDisabled();
	});
});
