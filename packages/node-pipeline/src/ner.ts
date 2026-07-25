// packages/node-pipeline/src/ner.ts
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { Gliner, IEntityResult, InitConfig, IONNXWebSettings, ITransformersSettings } from "gliner";

export const RUST_ALIGNED_PII_TYPES = [
	"person",
	"full_name",
	"first_name",
	"middle_name",
	"last_name",
	"date_of_birth",
	"email",
	"phone_number",
	"address",
	"street_address",
	"city",
	"state_or_region",
	"postal_code",
	"country",
	"government_id",
	"national_id_number",
	"passport_number",
	"drivers_license_number",
	"license_number",
	"tax_id",
	"tax_number",
	"bank_account",
	"account_number",
	"routing_number",
	"iban",
	"payment_card",
	"card_number",
	"card_expiry",
	"card_cvv",
	"username",
	"ip_address",
	"account_id",
	"sensitive_account_id",
	"password",
	"secret",
	"api_key",
	"access_token",
	"recovery_code",
	"sensitive_date",
	"document_date",
	"expiration_date",
	"transaction_date",
] as const;

export interface DetectedEntity {
  kind: string;
  start: number;
  end: number;
  text: string;
}

/**
 * Native GLiNER2 bridge contract.
 *
 * The implementation is supplied by the generated xberg-node façade once its
 * Candle entry point is exposed. Keeping the contract here lets the MCP
 * lifecycle (artifact verification and path wiring) be tested without loading
 * the multi-gigabyte model or importing an unavailable native module.
 */
export interface Gliner2NativeFacade {
	detectGliner2(
		text: string,
		modelDir: string,
		labels: readonly string[],
		threshold: number,
	): Promise<DetectedEntity[]> | DetectedEntity[];
}

let gliner2NativeFacade: Gliner2NativeFacade | undefined;

/** Install the generated native façade at application startup. */
export function configureGliner2NativeFacade(facade: Gliner2NativeFacade | undefined): void {
	gliner2NativeFacade = facade;
}

/** Run native GLiNER2 inference through the configured generated façade. */
export async function detectGliner2(
	text: string,
	modelDir: string,
	labels: readonly string[] = RUST_ALIGNED_PII_TYPES,
	threshold = 0.5,
): Promise<DetectedEntity[]> {
	if (!gliner2NativeFacade) {
		throw new Error(
			"native GLiNER2 façade is unavailable; regenerate xberg-node and configureGliner2NativeFacade() before inference",
		);
	}
	return gliner2NativeFacade.detectGliner2(text, modelDir, labels, threshold);
}

async function disableRemoteModels(): Promise<void> {
  try {
    const { env } = await import("@xenova/transformers");
    env.allowRemoteModels = false;
  } catch {
    // transformers runtime unavailable — no-op.
  }
}

/**
 * Resolves the local filesystem directory holding onnxruntime-web's WASM
 * binaries, via Node's own module resolution against the package's
 * published export map — never a hardcoded `node_modules` layout, which
 * pnpm hoisting/symlinking can rearrange at any time.
 *
 * Under pnpm's isolated node_modules, `gliner` pins its own private copy of
 * `onnxruntime-web` — a different, potentially incompatible version from
 * whatever `node-pipeline` itself depends on directly (e.g. gliner@0.0.19
 * pins onnxruntime-web@1.19.2, while node-pipeline's own direct dependency
 * can resolve to a newer 1.x). Its compiled ONNXWebWrapper imports
 * `onnxruntime-web` as a bare specifier resolved from *gliner's own*
 * installed location — not from this module's. Handing that wrapper a WASM
 * directory from a different onnxruntime-web version than its own JS
 * runtime is a real interface mismatch (the WASM binary set/format has
 * changed between versions). So resolution must walk through gliner's own
 * module context: resolve gliner's own package entry point first, then
 * create a second `require` scoped there, and use *that* to resolve
 * onnxruntime-web — landing on the exact copy gliner will actually import
 * at runtime, regardless of what version node-pipeline itself depends on.
 *
 * We resolve onnxruntime-web's main entry (not a WASM binary subpath
 * directly): older onnxruntime-web releases (e.g. the 1.19.2 gliner pins)
 * don't expose the `.wasm` files as their own entries in the package's
 * `exports` map at all, only newer releases do — so resolving a binary
 * subpath by name isn't portable across the versions different gliner
 * releases might pin. The main entry's directory (`dist/`) is where the
 * WASM binaries physically live alongside the JS bundle in every observed
 * onnxruntime-web layout, exported subpath or not.
 *
 * Returned with a trailing "/" because ONNXWebWrapper builds binary URLs
 * via plain string concatenation: `wasmPaths + "ort-wasm-simd-threaded.wasm"`.
 */
export function resolveLocalOnnxWasmPaths(): string {
  const require = createRequire(import.meta.url);
  const glinerEntryPath = require.resolve("gliner");
  const glinerRequire = createRequire(glinerEntryPath);
  const onnxEntryPath = glinerRequire.resolve("onnxruntime-web");
  const wasmDir = dirname(onnxEntryPath).replaceAll("\\", "/");
  return `${wasmDir}/`;
}

const modelCache = new Map<string, Promise<Gliner>>();

async function getModel(modelPath: string, tokenizerPath: string): Promise<Gliner> {
  const key = `${modelPath}::${tokenizerPath}`;
  let cached = modelCache.get(key);
  if (!cached) {
    cached = (async () => {
      const { Gliner: GlinerClass } = await import("gliner");
      await disableRemoteModels();
      const transformersSettings: ITransformersSettings = { allowLocalModels: true, useBrowserCache: false };
      const onnxSettings: IONNXWebSettings = {
        modelPath,
        executionProvider: "wasm",
        wasmPaths: resolveLocalOnnxWasmPaths(),
      };
      const config: InitConfig = { tokenizerPath, onnxSettings, transformersSettings };
      const model = new GlinerClass(config);
      await model.initialize();
      return model;
    })().catch((err) => {
      // Don't let a transient init failure permanently poison the cache — the next call
      // should retry instead of replaying the same rejection forever.
      modelCache.delete(key);
      throw err;
    });
    modelCache.set(key, cached);
  }
  return cached;
}

export async function detectPii(
  text: string,
  modelPath: string,
  tokenizerPath: string,
  types: readonly string[] = RUST_ALIGNED_PII_TYPES,
): Promise<DetectedEntity[]> {
  const model = await getModel(modelPath, tokenizerPath);
  const result = await model.inference({ texts: [text], entities: [...types], flatNer: true, threshold: 0.5 });
  const ents = result[0] ?? [];
  return ents.map((e: IEntityResult) => ({ kind: e.label, start: e.start, end: e.end, text: e.spanText }));
}
