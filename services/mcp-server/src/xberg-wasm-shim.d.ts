// Fallback-only: tsconfig.json's `paths` tries the wasm-pack-generated
// `crates/xberg-wasm/pkg/web/xberg_wasm.d.ts` first and only falls back to this
// partial shim when that build hasn't been produced yet, so real exports and
// signature changes come from the generated typings once they exist.
declare module "@xberg-io/xberg-wasm" {
  export class WasmExtractInput {
    static fromBytes(bytes: Uint8Array, mimeType?: string | null, fileName?: string | null): WasmExtractInput;
  }

  export interface WasmExtractOutput {
    results: Array<{
      content?: string;
      metadata?: {
        pages?: {
          totalCount?: number;
        };
      };
    }>;
  }

  export function extract(input: WasmExtractInput, config?: unknown): Promise<WasmExtractOutput>;

  const init: (input?: BufferSource | WebAssembly.Module) => Promise<unknown>;
  export default init;
}
