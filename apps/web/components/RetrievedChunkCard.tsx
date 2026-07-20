"use client";

import type { RetrievedChunk } from "@xberg-io/core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function RetrievedChunkCard({ chunk }: { chunk: RetrievedChunk }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{chunk.citation}</CardTitle>
        <span className="text-xs text-muted-foreground">score {chunk.score.toFixed(3)}</span>
      </CardHeader>
      <CardContent className="text-sm whitespace-pre-wrap">{chunk.text}</CardContent>
    </Card>
  );
}
