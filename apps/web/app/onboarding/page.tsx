"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";

export default function OnboardingPage() {
  const router = useRouter();
  const { login } = useAuth();

  const start = () => {
    login();
    router.push("/matters");
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center p-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-center text-2xl">Xberg Document Intelligence</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Fully local, on-device document processing for legal materials. Extraction, OCR,
            embeddings, PII detection, and retrieval all run in your browser.
          </p>
          <Button className="w-full" onClick={start}>
            Enter workspace
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
