import { Suspense } from "react";
import FolderView from "./FolderView";

export const dynamicParams = true;

export function generateStaticParams(): { id: string }[] {
  return [{ id: "_" }];
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<div>Loading…</div>}>
      <FolderView id={id} />
    </Suspense>
  );
}
