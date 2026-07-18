import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Xberg Document Intelligence",
  description: "On-device legal document intelligence",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
