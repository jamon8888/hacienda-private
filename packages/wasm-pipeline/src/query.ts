import type { Matter, RetrievedChunk } from "@xberg-io/core";
import { embedQuery } from "./embed";
import { retrieve } from "./rag";
import { detectCapabilities } from "./capabilities";
import { selectScenario } from "./scenario";

/**
 * Embed a query and retrieve the top-K matching chunks for a matter.
 *
 * Detects device capabilities to pick an embedding scenario, embeds the query,
 * and searches the matter's EdgeVec index.
 *
 * @param matter - The matter to search within.
 * @param query - The natural-language query text.
 * @param topK - Maximum number of chunks to return (default 8).
 * @returns The ranked {@link RetrievedChunk}s.
 */
export async function queryRag(
  matter: Matter,
  query: string,
  topK = 8,
): Promise<RetrievedChunk[]> {
  const scenario = selectScenario(await detectCapabilities());
  const vec = await embedQuery(query, scenario);
  return retrieve(matter.id, vec, topK);
}
