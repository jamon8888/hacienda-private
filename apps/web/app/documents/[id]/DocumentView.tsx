"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { PiiEntity } from "@xberg-io/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PiiPanel } from "@/components/PiiPanel";

interface DocState {
  name: string;
  text: string;
  pii: PiiEntity[];
  pages: number;
}

export default function DocumentView() {
  const router = useRouter();
  const [doc, setDoc] = useState<DocState | null>(null);

  useEffect(() => {
    const saved = sessionStorage.getItem("lastIngest");
    if (saved) {
      try {
        setDoc(JSON.parse(saved) as DocState);
      } catch {
        /* ignore */
      }
    }
  }, []);

  if (!doc) {
    return (
      <main className="mx-auto max-w-3xl p-6 text-center">
        <p className="text-muted-foreground">No document loaded. Process a folder first.</p>
        <Button className="mt-4" variant="ghost" onClick={() => router.back()}>
          ← Back
        </Button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <Button variant="ghost" onClick={() => router.back()}>
          ← Folder
        </Button>
        <h1 className="text-2xl font-semibold">{doc.name}</h1>
      </div>
      <div className="grid gap-6 md:grid-cols-[1fr_320px]">
        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Extracted Text ({doc.pages} pages)</CardTitle>
          </CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm max-h-[60vh] overflow-auto">
            {doc.text}
          </CardContent>
        </Card>
        <PiiPanel pii={doc.pii} />
      </div>
    </main>
  );
}
