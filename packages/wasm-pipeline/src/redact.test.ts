import { describe, it, expect } from "vitest";
import type { PiiEntity } from "@xberg-io/core";
import { buildRedaction, rehydrate, sealVault, openVault, type RedactionEntry, redactText, rehydrateText } from "./redact";

describe("redaction round-trip", () => {
  const text = "John Doe met Jane at Acme Corp on Monday.";
  const pii: PiiEntity[] = [
    { kind: "PER", start: 0, end: 8, text: "John Doe" },
    { kind: "PER", start: 13, end: 17, text: "Jane" },
    { kind: "ORG", start: 21, end: 30, text: "Acme Corp" },
  ];

  it("redacts spans and restores them exactly", () => {
    const { redacted, entries } = buildRedaction(text, pii, "F");
    expect(redacted).not.toContain("John Doe");
    expect(redacted).not.toContain("Jane");
    expect(redacted).not.toContain("Acme Corp");
    expect(redacted).toContain("{{F_PER_1}}");
    expect(redacted).toContain("{{F_PER_2}}");
    expect(redacted).toContain("{{F_ORG_1}}");
    const restored = rehydrate(redacted, entries);
    expect(restored).toBe(text);
  });

  it("produces unique tokens per occurrence", () => {
    const { entries } = buildRedaction(text, pii, "F");
    const tokens = entries.map((e) => e.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(entries.every((e) => e.original === rehydrate(`x${e.token}y`, [e]).slice(1, -1))).toBe(true);
  });

  it("handles text with no PII", () => {
    const { redacted, entries } = buildRedaction("nothing here", [], "F");
    expect(redacted).toBe("nothing here");
    expect(entries).toEqual([]);
  });
});

describe("redactText / rehydrateText (pure reversible redaction)", () => {
  const text = "John Doe met Jane at Acme Corp on Monday.";

  it("replaces spans with per-kind <KIND_n> tokens and round-trips", () => {
    const { redacted } = redactText(text, [
      { kind: "PERSON", start: 0, end: 8 },
      { kind: "PERSON", start: 13, end: 17 },
      { kind: "ORG", start: 21, end: 30 },
    ]);
    expect(redacted).toContain("<PERSON_1>");
    expect(redacted).toContain("<PERSON_2>");
    expect(redacted).toContain("<ORG_1>");
    expect(redacted).not.toContain("John Doe");
    expect(redacted).not.toContain("Jane");
    expect(redacted).not.toContain("Acme Corp");

    const restored = rehydrateText(redacted, [
      { token: "<PERSON_1>", value: "John Doe" },
      { token: "<PERSON_2>", value: "Jane" },
      { token: "<ORG_1>", value: "Acme Corp" },
    ]);
    expect(restored).toBe(text);
  });

  it("normalizes kind names and counts per kind", () => {
    const result = redactText("A B", [
      { kind: "per-son", start: 0, end: 1 },
      { kind: "per son", start: 2, end: 3 },
    ]);
    expect(result.tokens.map((t) => t.token)).toEqual(["<PER_SON_1>", "<PER_SON_2>"]);
  });

  it("records token offsets that index into the redacted output", () => {
    const { redacted, tokens } = redactText(text, [
      { kind: "PERSON", start: 0, end: 8 },
      { kind: "PERSON", start: 13, end: 17 },
      { kind: "ORG", start: 21, end: 30 },
    ]);
    for (const t of tokens) {
      expect(redacted.slice(t.start, t.end)).toBe(t.token);
    }
  });

  it("skips overlapping spans instead of corrupting the text", () => {
    const { redacted, tokens } = redactText("John Doe", [
      { kind: "PERSON", start: 0, end: 8 },
      { kind: "NAME", start: 5, end: 8 }, // overlaps the first span
    ]);
    expect(tokens).toHaveLength(1);
    expect(redacted).toBe("<PERSON_1>");
  });
});

describe("vault seal/open round-trip", () => {
  const entries: RedactionEntry[] = [
    { token: "{{F_PER_1}}", original: "John Doe", category: "PER", kind: "PER", start: 0, end: 8 },
  ];

  it("encrypts and decrypts entries with the passphrase", async () => {
    const sealed = await sealVault(entries, "correct horse");
    const opened = await openVault(sealed, "correct horse");
    expect(opened).toEqual(entries);
  });

  it("fails to open with the wrong passphrase", async () => {
    const sealed = await sealVault(entries, "right");
    await expect(openVault(sealed, "wrong")).rejects.toThrow();
  });
});
