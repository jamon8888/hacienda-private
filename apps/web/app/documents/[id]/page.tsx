import DocumentViewPage from "./DocumentView";

export function generateStaticParams() {
  return [{ id: "index" }];
}

export default function Page() {
  return <DocumentViewPage />;
}
