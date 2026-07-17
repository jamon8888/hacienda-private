import { describe, it, expect } from "vitest";
import { assertLocalFirst } from "./egress";

describe("assertLocalFirst egress guard", () => {
  it("allows localhost and 127.0.0.1", () => {
    expect(() => assertLocalFirst("http://localhost:8787/rag/mirror")).not.toThrow();
    expect(() => assertLocalFirst("https://127.0.0.1:8787/models/e5.onnx")).not.toThrow();
  });

  it("allows pinned model-repo hosts via allowlist", () => {
    expect(() =>
      assertLocalFirst("https://huggingface.co/x/model.onnx", ["huggingface.co"]),
    ).not.toThrow();
  });

  it("rejects remote hosts", () => {
    expect(() => assertLocalFirst("https://evil.example.com/exfil")).toThrow();
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => assertLocalFirst("ftp://localhost/x")).toThrow();
    expect(() => assertLocalFirst("file:///etc/passwd")).toThrow();
  });

  it("rejects malformed URLs", () => {
    expect(() => assertLocalFirst("not a url")).toThrow();
  });
});
