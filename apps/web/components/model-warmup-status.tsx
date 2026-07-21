"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
	Alert01Icon,
	ArrowReloadHorizontalIcon,
	CheckmarkCircle02Icon,
	Loading03Icon,
} from "@hugeicons/core-free-icons";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useModelWarmup } from "@/lib/engine/warmup-store";

export function ModelWarmupStatus() {
	const { stage, progress, error, retry } = useModelWarmup();

	if (stage === "ready") {
		return (
			<Badge variant="success" aria-label="On-device AI models ready">
				<HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-3" />
				Models ready
			</Badge>
		);
	}

	if (stage === "error") {
		return (
			<Button
				variant="ghost"
				size="sm"
				onClick={retry}
				className="h-auto gap-1 py-0.5 text-destructive hover:text-destructive"
				aria-label={`Models unavailable: ${error ?? "unknown error"} — retry`}
			>
				<HugeiconsIcon icon={Alert01Icon} className="size-3" />
				Models unavailable
				<HugeiconsIcon icon={ArrowReloadHorizontalIcon} className="size-3" />
			</Button>
		);
	}

	return (
		<Badge variant="info" aria-label={`Preparing on-device models: ${Math.round(progress * 100)}%`}>
			<HugeiconsIcon icon={Loading03Icon} className="size-3 animate-spin" />
			Preparing models… {Math.round(progress * 100)}%
		</Badge>
	);
}
