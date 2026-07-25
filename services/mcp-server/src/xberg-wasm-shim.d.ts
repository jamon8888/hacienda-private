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
