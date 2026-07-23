export type MockWarmupStage = "idle" | "loading" | "ready" | "error";

export const warmupState: { current: { stage: MockWarmupStage } } = {
  current: { stage: "loading" },
};

export function useModelWarmupMock(): { stage: MockWarmupStage } {
  return warmupState.current;
}
