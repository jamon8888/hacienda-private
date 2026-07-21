// `output: "export"` only ever pre-renders one variant of each `[id]` route (the placeholder
// "_" from generateStaticParams) — there's no live Next.js server to resolve a different id at
// request time. Both the server-rendered `id` prop AND next/navigation's useParams() reflect
// whatever was baked into that one prerendered page's hydration payload, i.e. always "_", for
// every real matter/folder/document. Parsing the browser's actual URL directly is the only
// reliable way to get the real id once the page is running client-side.
export function routeIdFromLocation(segment: string, fallback: string): string {
	if (typeof window === "undefined") return fallback;
	const parts = window.location.pathname.split("/").filter(Boolean);
	const index = parts.indexOf(segment);
	const raw = index !== -1 ? parts[index + 1] : undefined;
	return raw ? decodeURIComponent(raw) : fallback;
}
