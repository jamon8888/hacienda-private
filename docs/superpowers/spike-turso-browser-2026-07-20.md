# B-Gate Spike Result — Turso in-browser local engine (2026-07-20)

**Verdict: B-GATE FAIL (foundational premise not met).** No installable Turso package
currently runs a *local* database engine (with native vector ANN + Tantivy FTS) inside a
browser. The plan's B-gate was the hard precondition for the browser-wasm cutover; it
failed, so the browser side of Tasks 1–8 MUST NOT proceed. The Node side is still viable
(native binaries work in Node), so the spec's Node-big-bang + browser-EdgeVec escape hatch
is the correct path.

## What was actually tested

| Package | Version | Browser local engine? | Evidence |
| --- | --- | --- | --- |
| `@libsql/client` | 0.17.4 | No (remote-only web build) | `connect(":memory:")` in headless Chromium → `URL_SCHEME_NOT_SUPPORTED: ... got "file:"`. Web build only speaks `libsql:`/`ws:`/`http:`. |
| `@tursodatabase/database` | 0.7.0 | No (Node NAPI only) | npm ships **only** native optional deps (`linux-x64-gnu`, `win32-x64-msvc`, `darwin-arm64`, `linux-arm64-gnu`). No `browser.js`/WASM in tarball. README claims "browsers (through WebAssembly)" but that build is **not published to npm**. The `database-wasm32-wasi` ref is a server-side WASI target, not browser. |
| `@tursodatabase/serverless` | 1.3.1 | No (HTTP remote-only) | `connect({url:":memory:"})` → tries to fetch `:memory:/v3/pipeline`. Zero-dependency JS but is a stateless proxy to a Turso Cloud/remote server. |

## How to reproduce

```bash
# Node NAPI build (works, but Node-only):
pnpm add -D @tursodatabase/database
node -e "import('@tursodatabase/database').then(async m=>{const db=await m.connect(':memory:');await db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY)');console.log('node ok')})"
# → node ok  (proves SQL layer; not browser)

# Browser: no installable artifact exists as of 2026-07-20.
```

## Implications for the plan

- **Browser target:** keep EdgeVec + localStorage (current `rag.ts`). Do NOT delete `rag.ts`
  or the EdgeVec dependency (Task 8 delete-step is cancelled for browser).
- **Node MCP target:** `@tursodatabase/database` native build is fine for
  `services/mcp-server` (Node, not browser). Tasks touching Node store can proceed using
  the native driver, BUT the shared `SearchStore` abstraction must support a browser
  fallback (EdgeVec) — so the `SearchStore` interface (Task 1) should be capability-
  probed at runtime, not assumed Turso-everywhere.
- **Spec correction needed:** spec Section 5 "Browser: `@tursodatabase/database` wasm build
  against OPFS" is not achievable today. Update to "Browser: EdgeVec fallback; Turso only
  where a browser-wasm build ships."

## Re-test trigger

Re-run the spike if any of:
- `@tursodatabase/database` publishes a `browser.js` + WASM to npm, or
- a documented browser-wasm Turso build becomes installable.

Check `npm view @tursodatabase/database` for new optional deps like
`@tursodatabase/database-wasm32-...` that are browser (not wasi) targets.
