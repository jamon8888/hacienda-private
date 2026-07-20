## Local auth (single-owner)

This service is local-first and single-owner. `subject` is always `"owner"`.

- **HTTP** (`serve`): a per-launch 256-bit token is created via `buildConfig()`
  (`config.sessionToken`, persisted at `<dataDir>/session.token`, mode 0600) and injected into
  `GET /` as `window.__XBERG_TOKEN__`. The static routes `GET /`, `/wasm/*` and `/models/*` are
  served **without** authentication; every other (`/api/*`) route requires
  `Authorization: Bearer <token>` and rejects cross-site requests (`Sec-Fetch-Site`). Mutations
  are recorded in `audit_log` under the real subject (`"owner"`), not the scope string.
- **MCP stdio** (`mcp`): no token — the process spawn by the owner's client is the auth boundary.
  The owner principal is wired through the stdio transport and threaded into every tool call.

**Note:** the session token is a *same-machine capability* — it is injected into `GET /`, which is
unauthenticated, so any local process that can reach the loopback port can read it and replay it
as `Bearer`. It is **not** confidential against other processes or other users on the same
machine; the 0600 file permission is defense-in-depth for the owner account, not a cross-user
secret. This is an **accepted risk** for the current persona (a solo practitioner on their own
workstation) — see issue #10 for the Jupyter-style `?token=` bootstrap that would close this for a
shared-machine deployment, deliberately not built here (YAGNI for this persona).

**Mirror writes are atomic and audited.** `POST /api/rag/mirror` writes the mirror bundle via a
staged directory + atomic rename (`MirrorStore.saveMirror`) — a crash never leaves a torn mix of
old/new files on disk — and records a `save_mirror` audit entry only after a successful write.

Not built here (deliberately): JWT, multi-subject/multi-tenant, per-identity matter scoping,
loopback-token bootstrap hardening (issue #10).
