"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type { Folder, Matter } from "@xberg-io/core";
import { listPiiTypes, evictLiveIndex } from "@xberg-io/wasm-pipeline-real";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth";
import { getMatters, createFolder, getFolders, getFolderDocuments, forgetMatter } from "@/lib/api";
import { getMatterTemplate, saveMatterTemplate, deleteMatterTemplate } from "@/lib/matter-templates";
import { deleteOriginalFiles } from "@/lib/file-store";
import { routeIdFromLocation } from "@/lib/route-id";
import type { SchemaBuilderSchema } from "@/components/ui/schema-builder";

// schema-builder uses @dnd-kit pointer sensors, which need a real browser environment.
const SchemaBuilderPanel = dynamic(() => import("@/components/ui/schema-builder").then((m) => m.SchemaBuilderPanel), {
  ssr: false,
});

function schemaFromSelectedKinds(kinds: readonly string[], selected: string[]): SchemaBuilderSchema {
  return {
    properties: kinds
      .filter((k) => selected.includes(k))
      .map((k) => ({ id: k, key: k, type: "boolean" as const, description: `Flag ${k} PII in this matter's review` })),
  };
}

interface MatterViewProps {
  id: string;
}

export default function MatterView({ id: propId }: MatterViewProps) {
  const router = useRouter();
  const matterId = routeIdFromLocation("matters", propId);
  const { auth } = useAuth();
  const [matter, setMatter] = useState<Matter | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [forgetOpen, setForgetOpen] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [forgetError, setForgetError] = useState<string | null>(null);
  const [selectedKinds, setSelectedKinds] = useState<string[]>([]);
  const allKinds = listPiiTypes();

  useEffect(() => {
    if (!auth) return;
    getMatters(auth.token).then((matters) => {
      const m = matters.find((m) => m.id === matterId);
      if (m) setMatter(m);
    });
    getFolders(auth.token, matterId).then(setFolders);
    getMatterTemplate(matterId).then((saved) => setSelectedKinds(saved ?? [...allKinds]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, matterId]);

  const add = async () => {
    if (!auth || !matter) return;
    const name = prompt("Folder name:");
    if (!name) return;
    const f = await createFolder(auth.token, matter.id, name);
    setFolders((prev) => [...prev, f]);
  };

  const forget = async () => {
    if (!auth) return;
    setForgetting(true);
    setForgetError(null);
    try {
      // docIds are captured up front, but the local cache (original files, PII, mirror,
      // splits) is only cleared *after* the server confirms deletion — otherwise a failed
      // forgetMatter call (network/auth/server error) would leave the matter still existing
      // server-side while its local cache is already irrecoverably gone.
      const docIds = (await Promise.all(folders.map((f) => getFolderDocuments(auth.token, f.id))))
        .flat()
        .map((d) => d.id);
      await forgetMatter(auth.token, matterId);
      evictLiveIndex(matterId);
      await deleteOriginalFiles(docIds);
      await deleteMatterTemplate(matterId);
      setForgetOpen(false);
      router.push("/matters");
    } catch (err) {
      setForgetError(err instanceof Error ? err.message : "Failed to forget matter");
    } finally {
      setForgetting(false);
    }
  };

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{matter ? matter.name : "Matter"}</h1>
        <div className="flex items-center gap-2">
          <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">Extraction template</Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>PII types this matter cares about</DialogTitle>
              </DialogHeader>
              <SchemaBuilderPanel
                schema={schemaFromSelectedKinds(allKinds, selectedKinds)}
                onSchemaChange={(schema) => {
                  const next = schema.properties.map((p) => p.key);
                  setSelectedKinds(next);
                  void saveMatterTemplate(matterId, next);
                }}
              />
            </DialogContent>
          </Dialog>
          <Dialog open={forgetOpen} onOpenChange={setForgetOpen}>
            <DialogTrigger asChild>
              <Button variant="destructive">Forget matter</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Permanently forget this matter?</DialogTitle>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                This deletes all folders, documents, consents, and audit history for <strong>{matter?.name}</strong> on
                the server, and clears every cached original file, PII span, and vault for its documents in this
                browser. This cannot be undone.
              </p>
              {forgetError && <p className="text-sm text-destructive">{forgetError}</p>}
              <Button variant="destructive" onClick={forget} disabled={forgetting}>
                {forgetting ? "Forgetting…" : "Forget permanently"}
              </Button>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="mb-6">
        <Button onClick={add}>Create Folder</Button>
      </div>

      <div className="grid gap-3">
        {folders.map((f) => (
          <div
            key={f.id}
            className="rounded-lg border p-4 hover:bg-accent cursor-pointer"
            onClick={() => router.push(`/folders/${f.id}?matter_id=${matterId}`)}
          >
            <div className="flex items-center justify-between">
              <div className="font-medium">{f.name}</div>
              <span className="text-xs rounded px-2 py-0.5 bg-muted">{f.status}</span>
            </div>
            <div className="text-sm text-muted-foreground">
              {f.document_count} document{f.document_count === 1 ? "" : "s"} · {f.pii_count} PII entities
            </div>
          </div>
        ))}
        {folders.length === 0 && <p className="text-sm text-muted-foreground">No folders yet. Create one to begin.</p>}
      </div>
    </main>
  );
}
