"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export interface LocalAuth {
  token: string;
  scopes: string[];
  passphrase?: string;
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

  // Owner passphrase for the browser's curtain-privacy vault (PBKDF2-derived AES-GCM key,
  // see packages/wasm-pipeline/src/vault.ts). Chosen by the user, not auto-generated: losing
  // it means losing access to the original values behind any redacted PII in this session.
  const setPassphrase = (passphrase: string): LocalAuth => {
    const current = auth ?? ensureAuth();
    const updated: LocalAuth = { ...current, passphrase };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    setAuth(updated);
    return updated;
  };

  return { auth, ensureAuth, login, logout, setPassphrase };
}
