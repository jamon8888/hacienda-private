import DocumentView from "./DocumentView";

export const dynamicParams = true;

export function generateStaticParams(): { id: string }[] {
  return [{ id: "_" }];
}

export default function DocumentPage() {
  return <DocumentView />;
}
