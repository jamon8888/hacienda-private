import FolderDocumentsPage from "./FolderDocuments";

export function generateStaticParams() {
  return [{ id: "index" }];
}

export default function Page() {
  return <FolderDocumentsPage />;
}
