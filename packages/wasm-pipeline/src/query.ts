import type { Matter, RetrievedChunk } from "@xberg-io/core";
import { embedQuery } from "./embed";
import { retrieve } from "./rag";
import { detectCapabilities } from "./capabilities";
import { selectScenario } from "./scenario";

export async function queryRag(
  matter: Matter,
  query: string,
  topK = 8,
): Promise<RetrievedChunk[]> {
  const scenario = selectScenario(await detectCapabilities());
  const vec = await embedQuery(query, scenario);
  return retrieve(matter.id, vec, topK);
}
