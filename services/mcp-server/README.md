## Local auth (single-owner)

This service is local-first and single-owner. `subject` is always `"owner"`.

- **HTTP** (`serve`): a per-launch 256-bit token is written to `<dataDir>/session.token`
  (mode 0600) and injected into `GET /` as `window.__XBERG_TOKEN__`. All non-static
  routes require `Authorization: Bearer <token>` and reject cross-site requests
  (`Sec-Fetch-Site`). Scopes default to all four; restrict a launch with
  `XBERG_SCOPES=read` (comma list). Mutations are recorded in `audit_log`.
- **MCP stdio** (`mcp`): no token — the process spawn by the owner's client is the
  auth boundary. The owner principal is reserved for the tool layer (Plan 4).

Not built here (deliberately): JWT, multi-subject/multi-tenant, per-identity matter
scoping, per-tool consent enforcement (needs the un-stubbed tool layer — Plan 4).
