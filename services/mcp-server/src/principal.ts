export interface Principal {
  subject: string;
  scopes: AuthScopes[];
}

export type AuthScopes = "read" | "ingest" | "redact" | "admin";

export function ownerPrincipal(scopes: AuthScopes[]): Principal {
  return { subject: "owner", scopes };
}

export function anonymousPrincipal(): Principal {
  return { subject: "anonymous", scopes: [] };
}