import { detectCapabilities } from "./capabilities";
import { selectScenario, type ModelScenario } from "./scenario";
import { ensureEmbedSession, resetEmbedSession } from "./embed";
import { ensurePiiModel, resetPiiModel } from "./ner";
import { initWasm, resetWasm } from "./runtime";

export type WarmupStage = "engine" | "e5" | "gliner";

export interface WarmupProgress {
	stage: WarmupStage;
	overall: number;
}

export interface WarmupResult {
	scenario: ModelScenario;
}

const WEIGHTS: Record<WarmupStage, number> = { engine: 0.1, e5: 0.45, gliner: 0.45 };
const RETRY_ATTEMPTS = 3;

async function withRetry<T>(fn: () => Promise<T>, reset: () => void, attempts = RETRY_ATTEMPTS): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			reset();
			if (attempt < attempts - 1) {
				await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
			}
		}
	}
	throw lastErr;
}

export async function warmupModels(onProgress?: (p: WarmupProgress) => void): Promise<WarmupResult> {
	const fractions: Record<WarmupStage, number> = { engine: 0, e5: 0, gliner: 0 };
	const emit = (stage: WarmupStage) => {
		onProgress?.({
			stage,
			overall: fractions.engine * WEIGHTS.engine + fractions.e5 * WEIGHTS.e5 + fractions.gliner * WEIGHTS.gliner,
		});
	};

	const profile = await detectCapabilities();
	const scenario = selectScenario(profile);

	await withRetry(() => initWasm(), resetWasm);
	fractions.engine = 1;
	emit("engine");

	await Promise.all([
		withRetry(
			() =>
				ensureEmbedSession(scenario, (p) => {
					fractions.e5 = p.bytesTotal > 0 ? p.bytesLoaded / p.bytesTotal : 0;
					emit("e5");
				}),
			resetEmbedSession,
		),
		withRetry(
			() =>
				ensurePiiModel(scenario, (p) => {
					fractions.gliner = p.bytesTotal > 0 ? p.bytesLoaded / p.bytesTotal : 0;
					emit("gliner");
				}),
			resetPiiModel,
		),
	]);

	fractions.e5 = 1;
	fractions.gliner = 1;
	emit("gliner");

	return { scenario };
}
