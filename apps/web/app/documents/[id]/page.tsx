import { Suspense } from "react";
import DocumentView from "./DocumentView";

export const dynamicParams = true;

export function generateStaticParams(): { id: string }[] {
  return [{ id: "_" }];
}

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<div>Loading…</div>}>
      <DocumentView id={id} />
    </Suspense>
  );
}
