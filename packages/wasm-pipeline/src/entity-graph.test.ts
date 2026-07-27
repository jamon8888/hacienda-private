import { describe, it, expect, vi } from "vitest";

// detectGliner2 depends on the real (unbuilt-in-this-sandbox) @xberg-io/xberg-wasm module — mock it
// with synthetic spans so these tests exercise only this file's own logic (canonicalization,
// relation inference, merging), the same pattern rag.test.ts/adapter.test.ts use for edgevec.
const mockDetect = vi.fn();
vi.mock("./gliner2", () => ({
  detectGliner2: (...args: unknown[]) => mockDetect(...args),
}));

const {
  extractEntityGraph,
  mergeEntityGraphs,
  DROIT_DES_AFFAIRES_LABELS,
  DROIT_COMMERCIAL_LABELS,
  DROIT_COMMERCIAL_RULES,
} = await import("./entity-graph");

function span(text: string, kind: string, start: number, end: number) {
  return { kind, start, end, text };
}

describe("extractEntityGraph", () => {
  const text =
    "Jean Dupont, gérant de la société SASU Dupont Conseil, a signé l'accord. " +
    "Marie Martin détient 40% de la société SASU Dupont Conseil.";
  const dirigeantStart = text.indexOf("Jean Dupont");
  const dirigeantEnd = dirigeantStart + "Jean Dupont".length;
  const societe1Start = text.indexOf("SASU Dupont Conseil");
  const societe1End = societe1Start + "SASU Dupont Conseil".length;
  const societe2Start = text.indexOf("SASU Dupont Conseil", societe1End);
  const societe2End = societe2Start + "SASU Dupont Conseil".length;
  const actionnaireStart = text.indexOf("Marie Martin");
  const actionnaireEnd = actionnaireStart + "Marie Martin".length;

  it("canonicalizes duplicate entity mentions into one node (exact-normalized-match)", async () => {
    mockDetect.mockResolvedValueOnce([
      span("Jean Dupont", "dirigeant", dirigeantStart, dirigeantEnd),
      span("SASU Dupont Conseil", "société", societe1Start, societe1End),
      span("Marie Martin", "actionnaire", actionnaireStart, actionnaireEnd),
      span("SASU Dupont Conseil", "société", societe2Start, societe2End),
    ]);

    const graph = await extractEntityGraph(text, "doc-1", 0, DROIT_DES_AFFAIRES_LABELS);

    const societeNodes = graph.nodes.filter((n) => n.type === "societe");
    expect(societeNodes).toHaveLength(1);
    expect(societeNodes[0]?.label).toBe("SASU Dupont Conseil");
    expect(societeNodes[0]?.start).toBe(societe1Start); // first mention wins
    expect(graph.nodes).toHaveLength(3); // dirigeant + actionnaire + one deduped societe
  });

  it("infers a 'dirige' edge from a dirigeant mention immediately followed by a société", async () => {
    mockDetect.mockResolvedValueOnce([
      span("Jean Dupont", "dirigeant", dirigeantStart, dirigeantEnd),
      span("SASU Dupont Conseil", "société", societe1Start, societe1End),
    ]);

    const graph = await extractEntityGraph(text, "doc-1", 0, DROIT_DES_AFFAIRES_LABELS);
    const dirigeant = graph.nodes.find((n) => n.type === "dirigeant");
    const societe = graph.nodes.find((n) => n.type === "societe");
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ type: "dirige", from: dirigeant?.id, to: societe?.id }),
    );
  });

  it("infers a 'detient' edge from an actionnaire mention followed by 'détient ... de' a société, even against a canonicalized (earlier-positioned) node", async () => {
    mockDetect.mockResolvedValueOnce([
      span("Jean Dupont", "dirigeant", dirigeantStart, dirigeantEnd),
      span("SASU Dupont Conseil", "société", societe1Start, societe1End),
      span("Marie Martin", "actionnaire", actionnaireStart, actionnaireEnd),
      span("SASU Dupont Conseil", "société", societe2Start, societe2End),
    ]);

    const graph = await extractEntityGraph(text, "doc-1", 0, DROIT_DES_AFFAIRES_LABELS);
    const actionnaire = graph.nodes.find((n) => n.type === "actionnaire");
    const societe = graph.nodes.find((n) => n.type === "societe");
    // The regression this test guards: relation inference must run on each mention's own real
    // position (before canonicalization collapses the second "SASU Dupont Conseil" mention into
    // the first, earlier one) — otherwise this edge would be incorrectly filtered out.
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ type: "detient", from: actionnaire?.id, to: societe?.id }),
    );
  });

  it("produces no relation between entities in unrelated, distant clauses", async () => {
    const farText = `${"x".repeat(100)} Jean Dupont. ${"y".repeat(100)} SASU Dupont Conseil.`;
    mockDetect.mockResolvedValueOnce([
      span("Jean Dupont", "dirigeant", farText.indexOf("Jean Dupont"), farText.indexOf("Jean Dupont") + 11),
      span(
        "SASU Dupont Conseil",
        "société",
        farText.indexOf("SASU Dupont Conseil"),
        farText.indexOf("SASU Dupont Conseil") + 20,
      ),
    ]);

    const graph = await extractEntityGraph(farText, "doc-1", 0, DROIT_DES_AFFAIRES_LABELS);
    expect(graph.edges).toHaveLength(0);
  });

  it("passes the given labels through to detectGliner2", async () => {
    mockDetect.mockResolvedValueOnce([]);
    const customLabels = ["contrat", "clause"];
    await extractEntityGraph("some text", "doc-1", 0, customLabels);
    expect(mockDetect).toHaveBeenCalledWith("some text", customLabels);
  });
});

describe("extractEntityGraph (droit commercial vertical)", () => {
  const text =
    "Paul Lefèvre, commerçant, exploite un fonds de commerce de boulangerie. " +
    "Paul Lefèvre est titulaire d'un bail commercial sur ces mêmes locaux. " +
    "Paul Lefèvre est immatriculé sous le numéro RCS 456 789 123.";
  const commercant1Start = text.indexOf("Paul Lefèvre");
  const commercant1End = commercant1Start + "Paul Lefèvre".length;
  const fondsStart = text.indexOf("fonds de commerce de boulangerie");
  const fondsEnd = fondsStart + "fonds de commerce de boulangerie".length;
  const commercant2Start = text.indexOf("Paul Lefèvre", commercant1End);
  const commercant2End = commercant2Start + "Paul Lefèvre".length;
  const bailStart = text.indexOf("bail commercial");
  const bailEnd = bailStart + "bail commercial".length;
  const commercant3Start = text.indexOf("Paul Lefèvre", commercant2End);
  const commercant3End = commercant3Start + "Paul Lefèvre".length;
  const rcsStart = text.indexOf("RCS 456 789 123");
  const rcsEnd = rcsStart + "RCS 456 789 123".length;

  it("infers an 'exploite' edge from a commerçant mention followed by a fonds de commerce", async () => {
    mockDetect.mockResolvedValueOnce([
      span("Paul Lefèvre", "commerçant", commercant1Start, commercant1End),
      span("fonds de commerce de boulangerie", "fonds de commerce", fondsStart, fondsEnd),
    ]);

    const graph = await extractEntityGraph(text, "doc-1", 0, DROIT_COMMERCIAL_LABELS, DROIT_COMMERCIAL_RULES);
    const commercant = graph.nodes.find((n) => n.type === "commercant");
    const fonds = graph.nodes.find((n) => n.type === "fonds_de_commerce");
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ type: "exploite", from: commercant?.id, to: fonds?.id }),
    );
  });

  it("infers a 'loue' edge from a commerçant mention followed by a bail commercial", async () => {
    mockDetect.mockResolvedValueOnce([
      span("Paul Lefèvre", "commerçant", commercant2Start, commercant2End),
      span("bail commercial", "bail commercial", bailStart, bailEnd),
    ]);

    const graph = await extractEntityGraph(text, "doc-1", 0, DROIT_COMMERCIAL_LABELS, DROIT_COMMERCIAL_RULES);
    const commercant = graph.nodes.find((n) => n.type === "commercant");
    const bail = graph.nodes.find((n) => n.type === "bail_commercial");
    expect(graph.edges).toContainEqual(expect.objectContaining({ type: "loue", from: commercant?.id, to: bail?.id }));
  });

  it("infers an 'immatricule' edge from a commerçant mention followed by an immatriculation RCS", async () => {
    mockDetect.mockResolvedValueOnce([
      span("Paul Lefèvre", "commerçant", commercant3Start, commercant3End),
      span("RCS 456 789 123", "immatriculation RCS", rcsStart, rcsEnd),
    ]);

    const graph = await extractEntityGraph(text, "doc-1", 0, DROIT_COMMERCIAL_LABELS, DROIT_COMMERCIAL_RULES);
    const commercant = graph.nodes.find((n) => n.type === "commercant");
    const rcs = graph.nodes.find((n) => n.type === "immatriculation_rcs");
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ type: "immatricule", from: commercant?.id, to: rcs?.id }),
    );
  });

  it("does not cross-wire droit des affaires entity types when using the droit commercial rule set", async () => {
    // A "société"-typed span (droit des affaires) must not satisfy any droit commercial rule's
    // fromType/toType — the two rule sets are independent per vertical, not a shared free-for-all.
    mockDetect.mockResolvedValueOnce([
      span("Paul Lefèvre", "commerçant", commercant1Start, commercant1End),
      span("SASU Dupont Conseil", "société", fondsStart, fondsEnd),
    ]);
    const graph = await extractEntityGraph(text, "doc-1", 0, DROIT_COMMERCIAL_LABELS, DROIT_COMMERCIAL_RULES);
    expect(graph.edges).toHaveLength(0);
  });
});

describe("mergeEntityGraphs", () => {
  it("concatenates nodes and edges from multiple per-chunk graphs", () => {
    const a = { nodes: [{ id: "a1" } as never], edges: [{ id: "e1" } as never] };
    const b = { nodes: [{ id: "b1" } as never], edges: [] };
    const merged = mergeEntityGraphs([a, b]);
    expect(merged.nodes.map((n) => n.id)).toEqual(["a1", "b1"]);
    expect(merged.edges.map((e) => e.id)).toEqual(["e1"]);
  });
});
