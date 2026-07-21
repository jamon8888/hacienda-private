"use client";

import { Suspense } from "react";
import { SearchPageInner } from "./SearchPageInner";

export default function SearchPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-3xl p-6">Loading…</main>}>
      <SearchPageInner />
    </Suspense>
  );
}
