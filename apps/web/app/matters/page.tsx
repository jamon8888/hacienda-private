"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Matter } from "@xberg-io/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { getMatters, createMatter } from "@/lib/api";

export default function MattersPage() {
  const router = useRouter();
  const { auth } = useAuth();
  const [matters, setMatters] = useState<Matter[]>([]);
  const [name, setName] = useState("");

  useEffect(() => {
    if (!auth) return;
    getMatters(auth.token)
      .then(setMatters)
      .catch(() => setMatters([]));
  }, [auth]);

  const add = async () => {
    if (!auth || !name.trim()) return;
    const m = await createMatter(auth.token, name.trim());
    setMatters((prev) => [...prev, m]);
    setName("");
  };

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-6 text-2xl font-semibold">Matters</h1>
      <div className="mb-6 flex gap-2">
        <Input placeholder="New matter name" value={name} onChange={(e) => setName(e.target.value)} />
        <Button onClick={add}>Create</Button>
      </div>
      <div className="grid gap-3">
        {matters.map((m) => (
          <div
            key={m.id}
            className="rounded-lg border p-4 hover:bg-accent cursor-pointer"
            onClick={() => router.push(`/matters/${m.id}`)}
          >
            <div className="font-medium">{m.name}</div>
            <div className="text-sm text-muted-foreground">{m.created_at}</div>
          </div>
        ))}
        {matters.length === 0 && <p className="text-sm text-muted-foreground">No matters yet. Create one to begin.</p>}
      </div>
    </main>
  );
}
