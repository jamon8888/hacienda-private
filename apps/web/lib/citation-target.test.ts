import { describe, it, expect } from "vitest";
import { parseCitationTarget } from "./citation-target";

function sp(entries: Record<string, string>) {
  return new URLSearchParams(entries);
}

describe("parseCitationTarget", () => {
  it("parses a valid page + bbox", () => {
    const t = parseCitationTarget(sp({ page: "3", bbox: JSON.stringify({ x: 10, y: 20, w: 30, h: 40 }) }));
    expect(t).toEqual({ page: 3, bbox: { x: 10, y: 20, w: 30, h: 40 } });
  });
  it("returns empty when params are absent", () => {
    expect(parseCitationTarget(sp({}))).toEqual({});
  });
  it("ignores a non-positive or non-integer page", () => {
    expect(parseCitationTarget(sp({ page: "0" }))).toEqual({});
    expect(parseCitationTarget(sp({ page: "abc" }))).toEqual({});
  });
  it("ignores malformed or non-numeric bbox without throwing", () => {
    expect(parseCitationTarget(sp({ bbox: "not json" }))).toEqual({});
    expect(parseCitationTarget(sp({ bbox: JSON.stringify({ x: "a", y: 1, w: 2, h: 3 }) }))).toEqual({});
  });
});
