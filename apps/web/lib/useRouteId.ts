"use client";

import { useParams } from "next/navigation";

// output:"export" pre-renders a single "_" placeholder for each [id] route (see
// generateStaticParams in the corresponding page.tsx). Next's client router then reflects that
// build-time placeholder in useParams() — not the real URL segment — for both hard page loads
// and client-side router.push() navigations, since the placeholder is baked into the static
// route's flight data. useParams() is still the right trigger for "re-read on navigation" (it's
// tied to the router's context and reliably re-renders on route change); it's only the *value*
// that's wrong, so read the live URL instead once a render has been triggered.
export function useRouteId(): string {
  const params = useParams<{ id: string }>();
  if (typeof window !== "undefined") {
    const segments = window.location.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last !== "_") return decodeURIComponent(last);
  }
  return params.id ?? "";
}
