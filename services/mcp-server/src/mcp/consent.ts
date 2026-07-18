import type { Matter } from "@xberg-io/core";
import type { MetadataStore } from "../store.js";
import { AppError } from "../error.js";

export type ConsentKind = "pii_read" | "redact_rehydrate";

// Consent is checked against the wildcard subject "*" for the matter. The browser (owner) grants
// consent out-of-band; the server only enforces it here.
export function requireConsent(store: MetadataStore, matter: Matter, kind: ConsentKind): void {
  if (!store.isConsentActive("*", matter.id, kind)) {
    throw new AppError("consent", `consent required: ${kind}`);
  }
}
