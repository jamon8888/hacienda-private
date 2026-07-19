"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Folder, Matter } from "@xberg-io/core";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { getMatters, createFolder, getFolders } from "@/lib/api";

interface MatterViewProps {
	id: string;
}

export default function MatterView({ id: matterId }: MatterViewProps) {
	const router = useRouter();
	const { auth } = useAuth();
	const [matter, setMatter] = useState<Matter | null>(null);
	const [folders, setFolders] = useState<Folder[]>([]);

	useEffect(() => {
		if (!auth) return;
		getMatters(auth.token).then((matters) => {
			const m = matters.find((m) => m.id === matterId);
			if (m) setMatter(m);
		});
		getFolders(auth.token, matterId).then(setFolders);
	}, [auth, matterId]);

	const add = async () => {
		if (!auth || !matter) return;
		const name = prompt("Folder name:");
		if (!name) return;
		const f = await createFolder(auth.token, matter.id, name);
		setFolders((prev) => [...prev, f]);
	};

	return (
		<main className="mx-auto max-w-3xl p-6">
			<h1 className="mb-6 text-2xl font-semibold">{matter ? matter.name : "Matter"}</h1>

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
				{folders.length === 0 && (
					<p className="text-sm text-muted-foreground">No folders yet. Create one to begin.</p>
				)}
			</div>
		</main>
	);
}
