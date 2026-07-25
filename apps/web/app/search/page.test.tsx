import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { warmupState, useModelWarmupMock } from "@/test-utils/warmup-store-mock";

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

vi.mock("@/lib/engine/warmup-store", () => ({
  useModelWarmup: useModelWarmupMock,
}));

import { SearchPageInner } from "./SearchPageInner";
import { queryRag } from "@xberg-io/wasm-pipeline";

describe("SearchPageInner", () => {
  beforeEach(() => {
    warmupState.current = { stage: "loading" };
    vi.mocked(queryRag).mockReset();
  });

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

  it("shows a models-unavailable label and disables search when warmup errored", async () => {
    warmupState.current = { stage: "error" };
    render(<SearchPageInner />);
    const button = await screen.findByRole("button", { name: /models unavailable/i });
    expect(button).toBeDisabled();
  });

  it("does not start overlapping searches when Enter is pressed repeatedly", async () => {
    warmupState.current = { stage: "ready" };
    let resolveSearch: ((chunks: []) => void) | undefined;
    vi.mocked(queryRag).mockReturnValue(
      new Promise<[]>((resolve) => {
        resolveSearch = resolve;
      }),
    );
    render(<SearchPageInner />);

    const input = await screen.findByPlaceholderText(/ask a question/i);
    fireEvent.change(input, { target: { value: "hello" } });
    await screen.findByRole("button", { name: "Search" });

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(queryRag).toHaveBeenCalledTimes(1);
    resolveSearch?.([]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Search" })).not.toBeDisabled());
  });
});
