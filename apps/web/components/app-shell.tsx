"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
	Menu01Icon,
	Search01Icon,
	Shield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { useAuth } from "@/lib/auth";
import { getMatters } from "@/lib/api";
import type { Matter } from "@xberg-io/core";
import { Button } from "@/components/ui/button";
import { MatterNav, VaultStatus } from "@/components/matter-nav";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";

export function AppShell({ children }: { children: React.ReactNode }) {
	const router = useRouter();
	const pathname = usePathname();
	const { auth } = useAuth();
	const [matters, setMatters] = useState<Matter[]>([]);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [activeMatterId, setActiveMatterId] = useState<string | undefined>();

	useEffect(() => {
		if (auth?.token) {
			void getMatters(auth.token).then(setMatters).catch(() => setMatters([]));
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [auth?.token]);

	useEffect(() => {
		const m = pathname.match(/\/matters\/([^/?]+)/);
		if (m) setActiveMatterId(decodeURIComponent(m[1] ?? ""));
	}, [pathname]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				setPaletteOpen((o) => !o);
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, []);

	const activeMatter = matters.find((x) => x.id === activeMatterId);

	return (
		<div className="flex h-screen overflow-hidden bg-background">
			{/* Desktop sidebar */}
			<aside className="hidden w-72 shrink-0 border-r bg-muted/30 md:flex md:flex-col">
						<SidebarHeader matterName={activeMatter?.name} />
				<div className="flex-1 overflow-y-auto p-2">
					{matters.length === 0 ? (
						<p className="px-2 py-4 text-sm text-muted-foreground">No matters yet.</p>
					) : (
						<MatterNav matters={matters} activeMatterId={activeMatterId} onSelectMatter={setActiveMatterId} />
					)}
				</div>
			</aside>

			{/* Mobile drawer */}
			{drawerOpen && (
				<div className="fixed inset-0 z-40 md:hidden">
					<div className="absolute inset-0 bg-black/40" onClick={() => setDrawerOpen(false)} />
					<aside className="absolute left-0 top-0 h-full w-72 border-r bg-background p-2 shadow-xl">
				<SidebarHeader matterName={activeMatter?.name} />
						<div className="mt-2 h-[calc(100%-3rem)] overflow-y-auto">
							<MatterNav matters={matters} activeMatterId={activeMatterId} onSelectMatter={setActiveMatterId} />
						</div>
					</aside>
				</div>
			)}

			<div className="flex min-w-0 flex-1 flex-col">
				<header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
					<Button
						variant="ghost"
						size="icon"
						className="md:hidden"
						aria-label="Open navigation"
						onClick={() => setDrawerOpen(true)}
					>
						<HugeiconsIcon icon={Menu01Icon} className="size-5" />
					</Button>
					<Button
						variant="outline"
						onClick={() => setPaletteOpen(true)}
						className="h-9 flex-1 justify-start gap-2 text-muted-foreground sm:max-w-sm"
					>
						<HugeiconsIcon icon={Search01Icon} className="size-4" />
						<span className="text-sm">Search documents, PII, jump to…</span>
						<kbd className="ml-auto hidden rounded border bg-muted px-1.5 text-[10px] sm:inline">⌘K</kbd>
					</Button>
					<div className="ml-auto flex items-center gap-2">
						<Button variant="ghost" size="sm" onClick={() => router.push("/browse")}>
							Browse
						</Button>
						<VaultStatus locked={!auth?.passphrase} />
					</div>
				</header>
				<main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
			</div>

			<CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
				<CommandInput placeholder="Search documents, jump to a matter, run an action…" />
				<CommandList>
					<CommandEmpty>No results found.</CommandEmpty>
					<CommandGroup heading="Matters">
						{matters.map((m) => (
							<CommandItem
								key={m.id}
								onSelect={() => {
									setPaletteOpen(false);
									router.push(`/matters/${m.id}`);
								}}
							>
								{m.name}
							</CommandItem>
						))}
					</CommandGroup>
					<CommandGroup heading="Actions">
						<CommandItem
							onSelect={() => {
								setPaletteOpen(false);
								if (activeMatterId) router.push(`/matters/${activeMatterId}`);
							}}
						>
							<HugeiconsIcon icon={Shield01Icon} className="mr-2 size-4 text-destructive" />
							Review PII in current matter
						</CommandItem>
						<CommandItem
							onSelect={() => {
								setPaletteOpen(false);
								router.push("/search" + (activeMatterId ? `?matter_id=${activeMatterId}` : ""));
							}}
						>
							<HugeiconsIcon icon={Search01Icon} className="mr-2 size-4" />
							Search the matter index
						</CommandItem>
					</CommandGroup>
				</CommandList>
			</CommandDialog>
		</div>
	);
}

function SidebarHeader({ matterName }: { matterName?: string }) {
	return (
		<div className="flex items-center gap-2 border-b px-3 py-3">
			<HugeiconsIcon icon={Shield01Icon} className="size-5 text-primary" />
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-semibold">Xberg</p>
				<p className="truncate text-xs text-muted-foreground">{matterName ?? "No matter selected"}</p>
			</div>
		</div>
	);
}
