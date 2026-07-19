import type { AuthScopes, Matter } from "@xberg-io/core";
import { AppError } from "../error.js";
import type { Principal } from "../principal.js";

// Deny-by-default authorization: the caller must hold the required scope (or `admin`) AND the
// matter they are acting on must match the one their request targets.
export function authorize(
  principal: Principal,
  required: AuthScopes,
  matter: Matter,
  requestedMatterId?: string,
): void {
  if (!principal.scopes.includes(required) && !principal.scopes.includes("admin")) {
    throw new AppError("scope", `missing required scope: ${required}`);
  }
  if (requestedMatterId && matter.id !== requestedMatterId) {
    throw new AppError("scope", "matter scope mismatch");
  }
}
