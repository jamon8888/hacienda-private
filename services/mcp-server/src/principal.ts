import type { AuthScopes } from "@xberg-io/core";

/** The effective identity of a single request/connection. Single-owner model: subject is "owner". */
export interface Principal {
  subject: string;
  scopes: AuthScopes[];
}
