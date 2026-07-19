"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function HomePage() {
	const router = useRouter();
	useEffect(() => {
		router.replace("/onboarding");
	}, [router]);
	return <main className="mx-auto max-w-3xl p-6 text-center text-muted-foreground">Loading…</main>;
}
