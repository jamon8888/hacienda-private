"use client";

import type { PiiEntity } from "@xberg-io/core";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function PiiPanel({ pii }: { pii: PiiEntity[] }) {
  return (
    <Card className="col-span-1">
      <CardHeader>
        <CardTitle>Detected PII ({pii.length})</CardTitle>
      </CardHeader>
      <CardContent className="max-h-[60vh] overflow-auto">
        {pii.length === 0 ? (
          <p className="text-sm text-muted-foreground">No PII detected.</p>
        ) : (
          <ul className="space-y-2">
            {pii.map((e, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                  {e.text}
                </span>
                <Badge variant="destructive">{e.kind}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
