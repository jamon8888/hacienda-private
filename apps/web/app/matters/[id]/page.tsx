import MatterIngestPage from "./MatterIngest";

export function generateStaticParams() {
  return [{ id: "index" }];
}

export default function Page() {
  return <MatterIngestPage />;
}
