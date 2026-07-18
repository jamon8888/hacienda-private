import FolderView from "./FolderView";

export const dynamicParams = true;

export function generateStaticParams(): { id: string }[] {
  return [{ id: "_" }];
}

export default function FolderPage() {
  return <FolderView />;
}
