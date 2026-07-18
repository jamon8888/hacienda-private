"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export interface LocalAuth {
  token: string;
  scopes: string[];
}

const STORAGE_KEY = "xberg.localAuth";

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function useAuth() {
  const router = useRouter();
  const [auth, setAuth] = useState<LocalAuth | null>(null);

  useEffect(() => {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        setAuth(JSON.parse(raw) as LocalAuth);
      } catch {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    }
  }, []);

  const ensureAuth = (): LocalAuth => {
    const existing = sessionStorage.getItem(STORAGE_KEY);
    if (existing) {
      const parsed = JSON.parse(existing) as LocalAuth;
      setAuth(parsed);
      return parsed;
    }
    const created: LocalAuth = { token: randomToken(), scopes: ["read", "ingest", "redact"] };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(created));
    setAuth(created);
    return created;
  };

  const login = (scopes: string[] = ["read", "ingest", "redact"]): LocalAuth => {
    const created: LocalAuth = { token: randomToken(), scopes };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(created));
    setAuth(created);
    return created;
  };

  const logout = () => {
    sessionStorage.removeItem(STORAGE_KEY);
    setAuth(null);
    router.push("/onboarding");
  };

  return { auth, ensureAuth, login, logout };
}
