import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
	title: "Xberg Document Intelligence",
	description: "On-device legal document intelligence",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<body>
				<AppShell>{children}</AppShell>
			</body>
		</html>
	);
}
