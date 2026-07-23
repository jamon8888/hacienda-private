import type { Matter, RetrievedChunk } from "@xberg-io/core";
import { embedQuery } from "./embed";
import { retrieve } from "./rag";

export async function queryRag(matter: Matter, query: string, topK = 8): Promise<RetrievedChunk[]> {
	const vec = await embedQuery(query);
	return retrieve(matter.id, vec, topK);
}
