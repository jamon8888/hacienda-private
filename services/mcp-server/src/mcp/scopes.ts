import type { AuthScopes } from "@xberg-io/core";
import { AppError } from "../error.js";

/**
 * Deny-by-default scope check: the caller must hold `required` (or `admin`).
 * Single-owner model has no per-identity matter scoping, so there is no matter
 * argument — the old matter check was a tautology and is intentionally gone.
 */
export function authorize(scopes: AuthScopes[], required: AuthScopes): void {
  if (!scopes.includes(required) && !scopes.includes("admin")) {
    throw new AppError("scope", `missing required scope: ${required}`);
  }
}
