"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
	Archive01Icon,
	ChevronRightIcon,
	File01Icon,
	Folder01Icon,
	FolderOpenIcon,
	LockIcon,
	Search01Icon,
	Shield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { getFolders, getFolderDocuments } from "@/lib/api";
import type { Document, Folder, Matter } from "@xberg-io/core";

interface MatterNavProps {
	matters: Matter[];
	activeMatterId?: string;
	onSelectMatter?: (matterId: string) => void;
}

type DocStub = Pick<Document, "id" | "path" | "status" | "pii_count">;

export function MatterNav({ matters, activeMatterId, onSelectMatter }: MatterNavProps) {
	const router = useRouter();
	const pathname = usePathname();
	const { auth } = useAuth();
	const [openMatter, setOpenMatter] = useState<string | null>(activeMatterId ?? matters[0]?.id ?? null);
	const [foldersByMatter, setFoldersByMatter] = useState<Record<string, Folder[]>>({});
	const [docsByFolder, setDocsByFolder] = useState<Record<string, DocStub[]>>({});
	const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set());
	const [loadingDocs, setLoadingDocs] = useState<Set<string>>(new Set());

	const token = auth?.token ?? "";

	useEffect(() => {
		if (activeMatterId) setOpenMatter(activeMatterId);
	}, [activeMatterId]);

	async function loadFolders(matterId: string) {
		if (foldersByMatter[matterId] || !token) return;
		setLoadingFolders((s) => new Set(s).add(matterId));
		try {
			const folders = await getFolders(token, matterId);
			setFoldersByMatter((m) => ({ ...m, [matterId]: folders }));
		} finally {
			setLoadingFolders((s) => {
				const n = new Set(s);
				n.delete(matterId);
				return n;
			});
		}
	}

	async function loadDocs(folderId: string) {
		if (docsByFolder[folderId] || !token) return;
		setLoadingDocs((s) => new Set(s).add(folderId));
		try {
			const docs = await getFolderDocuments(token, folderId);
			setDocsByFolder((m) => ({
				...m,
				[folderId]: docs.map((d) => ({
					id: d.id,
					path: d.path,
					status: d.status,
					pii_count: d.pii_count,
				})),
			}));
		} finally {
			setLoadingDocs((s) => {
				const n = new Set(s);
				n.delete(folderId);
				return n;
			});
		}
	}

	useEffect(() => {
		if (openMatter) void loadFolders(openMatter);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [openMatter, token]);

	function fileName(path: string) {
		return path.split(/[/\\]/).pop() || path;
	}

	return (
		<nav className="flex h-full flex-col gap-1 text-sm" aria-label="Workspace navigation">
			{matters.map((matter) => {
				const isOpen = openMatter === matter.id;
				const folders = foldersByMatter[matter.id] ?? [];
				return (
					<div key={matter.id} className="rounded-md">
						<button
							type="button"
							onClick={() => {
								const next = isOpen ? null : matter.id;
								setOpenMatter(next);
								if (next) void loadFolders(next);
								onSelectMatter?.(matter.id);
								router.push(`/matters/${matter.id}`);
							}}
							className={cn(
								"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-medium hover:bg-accent",
								isOpen && "bg-accent",
							)}
						>
							<HugeiconsIcon icon={isOpen ? FolderOpenIcon : Archive01Icon} className="size-4 text-muted-foreground" />
							<span className="flex-1 truncate">{matter.name}</span>
							<HugeiconsIcon
								icon={ChevronRightIcon}
								className={cn("size-4 text-muted-foreground transition-transform", isOpen && "rotate-90")}
							/>
						</button>
						{isOpen && (
							<div className="ml-3 border-l pl-2">
								{loadingFolders.has(matter.id) && (
									<p className="px-2 py-1 text-xs text-muted-foreground">Loading folders…</p>
								)}
								{!loadingFolders.has(matter.id) && folders.length === 0 && (
									<p className="px-2 py-1 text-xs text-muted-foreground">No folders yet.</p>
								)}
								{folders.map((folder) => (
									<FolderNode
										key={folder.id}
										folder={folder}
										docs={docsByFolder[folder.id] ?? []}
										loading={loadingDocs.has(folder.id)}
										activeDocId={pathname.startsWith("/documents/") ? decodeURIComponent(pathname.split("/").pop() ?? "") : undefined}
										onToggle={() => void loadDocs(folder.id)}
										fileName={fileName}
									/>
								))}
							</div>
						)}
					</div>
				);
			})}
		</nav>
	);
}

function FolderNode({
	folder,
	docs,
	loading,
	activeDocId,
	onToggle,
	fileName,
}: {
	folder: Folder;
	docs: DocStub[];
	loading: boolean;
	activeDocId?: string;
	onToggle: () => void;
	fileName: (p: string) => string;
}) {
	const [open, setOpen] = useState(false);
	const router = useRouter();
	const folderActive = usePathname().startsWith(`/folders/${folder.id}`);

	return (
		<div>
			<div className="flex items-center gap-1 rounded-md hover:bg-accent">
				<button
					type="button"
					onClick={() => {
						const next = !open;
						setOpen(next);
						if (next) onToggle();
						router.push(`/folders/${folder.id}?matter_id=${folder.matter_id ?? ""}`);
					}}
					className={cn(
						"flex flex-1 items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent",
						folderActive && "bg-accent",
					)}
				>
					<HugeiconsIcon icon={open ? FolderOpenIcon : Folder01Icon} className="size-4 text-muted-foreground" />
					<span className="flex-1 truncate">{folder.name}</span>
					{folder.pii_count > 0 && (
						<span
							className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
							title={`${folder.pii_count} PII entities detected`}
						>
							PII {folder.pii_count}
						</span>
					)}
					<HugeiconsIcon icon={ChevronRightIcon} className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
				</button>
			</div>
			{open && (
				<div className="ml-3 border-l pl-2">
					{loading && <p className="px-2 py-1 text-xs text-muted-foreground">Loading documents…</p>}
					{!loading && docs.length === 0 && (
						<p className="px-2 py-1 text-xs text-muted-foreground">No documents ingested.</p>
					)}
					{docs.map((doc) => (
						<button
							key={doc.id}
							type="button"
							onClick={() => router.push(`/documents/${encodeURIComponent(doc.id)}?folder_id=${folder.id}`)}
							className={cn(
								"flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent",
								activeDocId === doc.id && "bg-accent font-medium",
							)}
						>
							<HugeiconsIcon icon={File01Icon} className="size-3.5 text-muted-foreground" />
							<span className="flex-1 truncate">{fileName(doc.path)}</span>
							{doc.pii_count > 0 && (
								<HugeiconsIcon icon={Shield01Icon} className="size-3 text-destructive" aria-label="Contains PII" />
							)}
							{doc.status === "processing" && (
								<HugeiconsIcon icon={Search01Icon} className="size-3 animate-pulse text-muted-foreground" />
							)}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

export function VaultStatus({ locked }: { locked: boolean }) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
				locked ? "bg-muted text-muted-foreground" : "bg-success/10 text-success",
			)}
			aria-label={locked ? "Vault locked — PII values hidden" : "Vault unlocked — PII rehydration available"}
		>
			<HugeiconsIcon icon={LockIcon} className="size-3" />
			{locked ? "Vault locked" : "Vault unlocked"}
		</span>
	);
}
