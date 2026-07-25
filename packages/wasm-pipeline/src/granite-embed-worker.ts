interface GraniteWasmModule {
  default: (input?: unknown) => Promise<unknown>;
  GraniteEmbeddingModel: new () => {
    loadBytes(weights: Uint8Array, tokenizer: Uint8Array, config: Uint8Array): void;
    embedDocuments(texts: string[]): number[][];
    embedQuery(text: string): number[];
    identity(): unknown;
  };
}

let model: InstanceType<GraniteWasmModule["GraniteEmbeddingModel"]> | null = null;

self.onmessage = async (event: MessageEvent) => {
  const message = event.data as {
    id: number;
    op: "load" | "documents" | "query";
    weights?: ArrayBuffer;
    tokenizer?: ArrayBuffer;
    config?: ArrayBuffer;
    texts?: string[];
    text?: string;
  };
  try {
    if (!model) {
      const wasm = (await import("@xberg-io/xberg-wasm")) as unknown as GraniteWasmModule;
      await wasm.default();
      model = new wasm.GraniteEmbeddingModel();
    }
    if (message.op === "load") {
      if (!message.weights || !message.tokenizer || !message.config)
        throw new Error("Granite artifact bytes are missing");
      model.loadBytes(
        new Uint8Array(message.weights),
        new Uint8Array(message.tokenizer),
        new Uint8Array(message.config),
      );
      self.postMessage({
        id: message.id,
        ok: true,
        identity: model.identity(),
      });
      return;
    }
    if (message.op === "documents") {
      self.postMessage({
        id: message.id,
        ok: true,
        vectors: model.embedDocuments(message.texts ?? []),
      });
      return;
    }
    self.postMessage({
      id: message.id,
      ok: true,
      vector: model.embedQuery(message.text ?? ""),
    });
  } catch (error) {
    self.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
