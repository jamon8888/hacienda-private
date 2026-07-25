"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useAuth } from "@/lib/auth";
import { getMatters, getFolders, getFolderDocuments } from "@/lib/api";
import type { FileSystemItem } from "@/components/ui/file-system";

// file-system renders a virtualized grid/list that needs real layout measurement.
const FileSystem = dynamic(() => import("@/components/ui/file-system").then((m) => m.FileSystem), { ssr: false });

export default function BrowsePage() {
  const router = useRouter();
  const { ensureAuth } = useAuth();
  const [items, setItems] = useState<FileSystemItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const auth = ensureAuth();
    void (async () => {
      try {
        const matters = await getMatters(auth.token);
        const out: FileSystemItem[] = [];
        for (const matter of matters) {
          const matterPath = `${matter.name}/`;
          out.push({ kind: "folder", path: matterPath });
          const folders = await getFolders(auth.token, matter.id);
          for (const folder of folders) {
            const folderPath = `${matterPath}${folder.name}/`;
            out.push({ kind: "folder", path: folderPath });
            const docs = await getFolderDocuments(auth.token, folder.id);
            for (const doc of docs) {
              const name = doc.path.split(/[/\\]/).pop() ?? doc.path;
              out.push({ kind: "file", path: `${folderPath}${name}`, key: doc.id });
            }
          }
        }
        setItems(out);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load matters");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="flex h-screen flex-col p-4">
      <h1 className="mb-4 text-2xl font-semibold">Browse</h1>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : (
        <FileSystem
          className="min-h-0 flex-1"
          items={items}
          title="Matters"
          onFileOpen={(file) => {
            if (file.key) router.push(`/documents/${encodeURIComponent(file.key)}`);
          }}
        />
      )}
    </main>
  );
}
