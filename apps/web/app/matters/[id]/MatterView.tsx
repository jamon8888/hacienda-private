"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { Folder } from "@xberg-io/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { getFolders, createFolder } from "@/lib/api";

export default function MatterView() {
  const params = useParams();
  const router = useRouter();
  const { auth } = useAuth();
  const matterId = params.id as string;
  const [folders, setFolders] = useState<Folder[]>([]);
  const [name, setName] = useState("");

  useEffect(() => {
    if (!auth) return;
    getFolders(auth.token, matterId).then(setFolders).catch(() => setFolders([]));
  }, [auth, matterId]);

  const add = async () => {
    if (!auth || !name.trim()) return;
    const f = await createFolder(auth.token, matterId, name.trim());
    setFolders((prev) => [...prev, f]);
    setName("");
  };

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Folders</h1>
        <Button onClick={() => router.push("/matters")} variant="ghost">
          ← Matters
        </Button>
      </div>
      <div className="mb-6 flex gap-2">
        <Input placeholder="New folder name" value={name} onChange={(e) => setName(e.target.value)} />
        <Button onClick={add}>Create</Button>
      </div>
      <div className="grid gap-3">
        {folders.map((f) => (
          <div
            key={f.id}
            className="rounded-lg border p-4 hover:bg-accent cursor-pointer"
            onClick={() => router.push(`/folders/${f.id}?matter_id=${matterId}`)}
          >
            <div className="font-medium">{f.name}</div>
            <div className="text-sm text-muted-foreground">{f.id}</div>
          </div>
        ))}
        {folders.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No folders yet. Create one to add documents.
          </p>
        )}
      </div>
    </main>
  );
}
