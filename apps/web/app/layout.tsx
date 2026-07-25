import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "next-themes";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
  title: "Xberg Document Intelligence",
  description: "On-device legal document intelligence",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
          <AppShell>{children}</AppShell>
        </ThemeProvider>
        {/* Glide Data Grid (csv-viewer, bounding-box-citations) renders cell-editor overlays here. */}
        <div id="portal" />
      </body>
    </html>
  );
}
