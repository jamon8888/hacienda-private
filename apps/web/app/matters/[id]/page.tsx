import MatterView from "./MatterView";

export const dynamicParams = true;

export function generateStaticParams(): { id: string }[] {
  return [{ id: "_" }];
}

export default function MatterPage() {
  return <MatterView />;
}
