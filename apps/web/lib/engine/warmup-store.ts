"use client";

import { useSyncExternalStore } from "react";
import { warmupModels, type WarmupProgress } from "@xberg-io/wasm-pipeline";

export type WarmupStage = "idle" | "loading" | "ready" | "error";

export interface WarmupState {
	stage: WarmupStage;
	progress: number;
	error: string | null;
	attempt: number;
}

type Listener = () => void;

let state: WarmupState = { stage: "idle", progress: 0, error: null, attempt: 0 };
const listeners = new Set<Listener>();
let started = false;

function setState(next: Partial<WarmupState>): void {
	state = { ...state, ...next };
	for (const listener of listeners) listener();
}

async function runWarmup(): Promise<void> {
	setState({ stage: "loading", progress: 0, error: null, attempt: state.attempt + 1 });
	try {
		await warmupModels((p: WarmupProgress) => setState({ progress: p.overall }));
		setState({ stage: "ready", progress: 1, error: null });
	} catch (err) {
		setState({
			stage: "error",
			progress: 0,
			error: err instanceof Error ? err.message : "Failed to load on-device models",
		});
	}
}

export function startModelWarmup(): void {
	if (started) return;
	started = true;
	void runWarmup();
}

export function retryModelWarmup(): void {
	void runWarmup();
}

export function subscribeModelWarmup(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getModelWarmupSnapshot(): WarmupState {
	return state;
}

export function useModelWarmup(): WarmupState & { retry: () => void } {
	const snapshot = useSyncExternalStore(subscribeModelWarmup, getModelWarmupSnapshot, getModelWarmupSnapshot);
	return { ...snapshot, retry: retryModelWarmup };
}

export function __resetModelWarmupStoreForTests(): void {
	state = { stage: "idle", progress: 0, error: null, attempt: 0 };
	started = false;
	listeners.clear();
}
