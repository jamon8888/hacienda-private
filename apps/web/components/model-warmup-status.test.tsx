import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const warmupState: { current: { stage: string; progress: number; error: string | null; retry: () => void } } = {
	current: { stage: "loading", progress: 0, error: null, retry: vi.fn() },
};

vi.mock("@/lib/engine/warmup-store", () => ({
	useModelWarmup: () => warmupState.current,
}));

import { ModelWarmupStatus } from "./model-warmup-status";

describe("ModelWarmupStatus", () => {
	it("shows a rounded percentage while preparing models", () => {
		warmupState.current = { stage: "loading", progress: 0.416, error: null, retry: vi.fn() };
		render(<ModelWarmupStatus />);
		expect(screen.getByText(/Preparing models… 42%/)).toBeInTheDocument();
	});

	it("shows a ready badge once models are ready", () => {
		warmupState.current = { stage: "ready", progress: 1, error: null, retry: vi.fn() };
		render(<ModelWarmupStatus />);
		expect(screen.getByText("Models ready")).toBeInTheDocument();
	});

	it("shows an error state whose button calls retry when clicked", async () => {
		const retry = vi.fn();
		warmupState.current = { stage: "error", progress: 0, error: "network down", retry };
		render(<ModelWarmupStatus />);
		const button = screen.getByRole("button", { name: /models unavailable/i });
		await userEvent.setup().click(button);
		expect(retry).toHaveBeenCalledTimes(1);
	});
});
