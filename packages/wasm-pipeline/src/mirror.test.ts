import { describe, it, expect } from "vitest";
import { buildMirrorFormData } from "./mirror";

describe("buildMirrorFormData", () => {
  it("attaches matter id, index blob and vault blob", () => {
    const index = new Uint8Array([1, 2, 3, 4]);
    const vault = new Uint8Array([9, 8, 7]);
    const fd = buildMirrorFormData("matter-42", index, vault);

    expect(fd.get("matter_id")).toBe("matter-42");
    const idx = fd.get("index");
    const vlt = fd.get("curtain_vault");
    expect(idx).toBeInstanceOf(Blob);
    expect(vlt).toBeInstanceOf(Blob);
  });

  it("accepts an already-built Blob as the index", () => {
    const indexBlob = new Blob([new Uint8Array([5, 6])], { type: "application/octet-stream" });
    const fd = buildMirrorFormData("m-1", indexBlob, new Uint8Array([1]));
    const got = fd.get("index");
    expect(got).toBeInstanceOf(Blob);
    expect((got as Blob).size).toBe(2);
    expect((got as Blob).type).toBe("application/octet-stream");
  });
});
