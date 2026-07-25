# 2026-07-24 Local Build Speed Setup

This repo now has a local fast-path setup tuned for low-memory Linux machines and multi-worktree usage.

## Active Strategy

- isolate local fast Cargo tasks from the global `~/.cargo/config.toml` wrapper via `scripts/task/cargo-local.sh`
- share `target/` across worktrees with `CARGO_TARGET_DIR`
- keep `mold` enabled for faster linking
- keep `zram` enabled for reduced OOM pressure
- reuse `apps/web/out` and `crates/xberg-wasm/pkg/web` with SHA256 input markers
- keep MCP runtime/test resolution pointed at workspace sources

## Recommended Session Start

```bash
cd /home/jamin/Documents/hacienda-private
eval "$(task build:accel:env)"
task doctor:rust
task doctor:web
```

## Fast Local Commands

```bash
task build
task check:rust:fast
task build:web
task check:web
task test:web
task test:mcp
task build:cli:fast
```

## Measure Current Machine

```bash
task perf:local
```

That runs:

- `task build`
- `task build:web`
- `task test:mcp`

and prints wall time, user/sys CPU time, and max RSS when `/usr/bin/time` is available.

## Notes

- The local fast path intentionally does **not** use the current global `sccache` wrapper, because that wrapper configuration remained incompatible with the repo's Cargo behavior on Friday, July 24, 2026.
- CI can still use its own `sccache` setup independently.
- `task test:mcp` and `task test:web` were both passing at the end of this work; `task check:web` was also passing after the final MCP typing shim fixes.
