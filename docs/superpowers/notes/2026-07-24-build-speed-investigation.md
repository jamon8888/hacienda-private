# 2026-07-24 Build Speed Investigation

## Scope

Investigated local build and check speed across Rust, WASM, and web flows, with a focus on optional `sccache` and `mold` setup that fits the current Xberg codebase.

## Findings

1. The old local Rust build path was CI-heavy.

   Before this change, `task build` routed to `rust:build:dev`, and that task ran:

   - `cargo build --locked --workspace --all-features ...`

   That is a maximal workspace build, not a fast local edit loop.

2. The old main Rust test path was also CI-heavy.

   `task rust:test` still shells into `scripts/ci/rust/run-unit-tests.sh`, which runs:

   - `cargo test -p xberg --features full --all-targets --verbose`
   - `cargo test --workspace --all-features --all-targets --verbose` for the rest
   - a separate `xberg-gliner` pass

   This is valid coverage for CI, but it is not optimized for local feedback.

3. The repo already uses `sccache` in CI, but not locally.

   `ci-rust.yaml` and other workflows use `xberg-io/actions/setup-rust@v1` with `use-sccache: "true"`. There is no equivalent local opt-in path in tasks or repo scripts.

4. The repo does not currently wire in `mold`.

   `.cargo/config.toml` has no Linux linker acceleration. That is the right default, because hardcoding `mold` would break machines that do not have it installed.

5. `.cargo/config.toml` already enables one useful local speed setting.

   It sets:

   - `incremental = true`

   So the missing acceleration is mostly compiler cache and linker speed, not incremental compilation itself.

6. Web build time is real, but not the first bottleneck.

   `apps/web` uses plain `next build`. That can be optimized around the edges, but the larger cost in this repo is that many tasks rebuild too much Rust first.

7. The web stack had no standard incremental task path.

   `apps/web`, `crates/xberg-wasm`, Playwright browser installs, and the Node server checks were all effectively ad-hoc. That makes developers pay cold-start costs repeatedly.

## Recommendations

### Highest impact

1. Use the implemented local fast path (`task build`, `task test`, `task check:rust:fast`) which isolates Cargo from the global `sccache` wrapper via `scripts/task/cargo-local.sh`. See `scripts/task/build-accel-env.sh` for the opt-in `sccache` + `mold` environment if you have those tools installed.
2. Use `mold` locally on Linux for link-heavy debug and check runs (installed via `sudo apt-get install mold`).
3. Split local-fast tasks from CI-grade tasks instead of making `task build` and `task test` do full-workspace `--all-features` by default.

### Medium impact

4. Prefer crate-scoped local commands during iteration:

   - `cargo build -p xberg-cli`
   - `cargo check -p xberg`
   - `cargo test -p xberg --lib`

5. Keep expensive full-stack checks as explicit CI-parity tasks.
6. Reuse generated web/WASM outputs when inputs are unchanged. The Granite release script already does this now.

### Lower impact

7. Add `cargo nextest` for local test execution if the team wants faster test scheduling. This is optional because the current test script is customized and not a drop-in replacement.
8. Consider lowering default local verbosity in Rust test scripts. `--verbose` adds noise and some overhead, though it is not the main bottleneck.

## Implemented Changes

1. `Cargo.toml` now uses lighter dev/test debug settings:

   - `[profile.dev] debug = "line-tables-only"`
   - `[profile.test] debug = "line-tables-only"`
   - dependency debug info disabled for `dev` and `test` via `[profile.*.package."*"]`
   - build-script / proc-macro debug info disabled via `[profile.*.build-override]`

2. Local task defaults are now fast by default:

   - `task build` -> fast `xberg` core build
   - `task test` -> fast `xberg` core tests
   - `task build:full` -> old full workspace debug build
   - `task test:full` -> old full Rust CI-parity test flow
   - `task check:rust:fast` -> fast local `xberg` cargo check

3. Optional accelerator helpers were added:

   - `task build:accel:doctor`
   - `task build:accel:env`
   - `task build:accel:zram:doctor`
   - `task build:fast:cranelift`
   - `task test:fast:cranelift`
   - `task check:rust:fast:cranelift`

4. Web-side incremental tasks were added:

   - `task build:web`
   - `task check:web`
   - `task test:web`
   - `task test:mcp`
   - `task node:web:e2e:install`
   - `task node:web:doctor`

   These reuse:

   - `crates/xberg-wasm/pkg/web/xberg_wasm.js`
   - `apps/web/out/index.html`
   - existing Playwright browser downloads

5. `services/mcp-server/package.json` now points to `@xberg-io/xberg-wasm: workspace:*`, so local web/server builds do not accidentally pull an older published WASM package during iteration.

6. `.cargo/config.toml` now defaults to `incremental = false`.

   This is required for compatibility with `sccache 0.16.0`, which rejects incremental Rust compilation. The helper script still enables `CARGO_INCREMENTAL=1` automatically when `sccache` is not installed, so low-end machines without `sccache` keep a workable fallback.

7. Local fast tasks now use `scripts/task/cargo-local.sh`.

   This isolates `CARGO_HOME` from the global `~/.cargo/config.toml` wrapper while reusing the existing `bin`, `registry`, and `git` caches via symlinks. It avoids the broken local `sccache` wrapper path without forcing a global machine change.

   The web/WASM fast path now uses that same isolated Cargo launcher explicitly via the `CARGO`
   environment variable before invoking `wasm-pack`.

8. Shared target-dir support is now enabled by the env helper.

   `task build:accel:env` exports:

   - `CARGO_TARGET_DIR=$XDG_CACHE_HOME/xberg/target-shared`
   - `SCCACHE_BASEDIRS=<repo-root>`

   That allows worktrees to share artifacts and improves cache-key stability.

9. Web/WASM reuse is now hash-based instead of timestamp-based.

   `scripts/task/web-artifact-cache.sh` stores SHA256 markers under:

   - `$XDG_CACHE_HOME/xberg/web-artifacts/wasm.sha256`
   - `$XDG_CACHE_HOME/xberg/web-artifacts/web.sha256`

   This is more reliable across branch switches and copied files.

## Safe Local Setup

Use the helper script added in `scripts/task/build-accel-env.sh`.

Inspect tool availability:

```bash
bash scripts/task/build-accel-env.sh doctor
```

Emit recommended local exports:

```bash
bash scripts/task/build-accel-env.sh env
```

Use it for the current shell:

```bash
eval "$(bash scripts/task/build-accel-env.sh env)"
```

This keeps `sccache` and `mold` opt-in and avoids breaking contributors who do not have them installed.

When `sccache` is present, the helper now exports `CARGO_INCREMENTAL=0` explicitly. This is required because this repo's Cargo config enables incremental globally, and `sccache 0.16.0` rejects that combination.

## Linux Install Commands

Ubuntu/Debian:

```bash
sudo apt-get update
sudo apt-get install -y mold
cargo install sccache --locked
```

Verify:

```bash
which mold
which sccache
sccache --version
```

Then enable for the shell:

```bash
eval "$(bash scripts/task/build-accel-env.sh env)"
```

## Ubuntu zram

On low-memory Linux machines, enable zram:

```bash
sudo apt-get update
sudo apt-get install -y zram-tools
sudo systemctl enable --now zramswap.service
```

Inspect it with:

```bash
task build:accel:zram:doctor
```

## Nightly Cranelift

Install the nightly toolchain and Cranelift backend:

```bash
rustup toolchain install nightly
rustup component add rustc-codegen-cranelift-preview --toolchain nightly
```

Then use the opt-in fast tasks:

```bash
task build:fast:cranelift
task check:rust:fast:cranelift
task test:fast:cranelift
```

## Web Loop

Fast local web flow:

```bash
task build:web
task check:web
task test:web
task node:web:e2e:install
```

Force a clean web rebuild:

```bash
FORCE_WEB_REBUILD=1 task build:web
```

Inspect the active Rust and web cache layout:

```bash
task doctor:rust
task doctor:web
```

Fast local CLI build without the heavy default feature set:

```bash
task build:cli:fast
```

## Recommended Task Follow-Up

The next repo change should be task-level, not cargo-config-level:

1. keep the current full-workspace tasks for CI parity
2. add explicit local-fast variants for build, check, and test
3. make those fast variants package-scoped or feature-scoped by default

That will save more time than linker tuning alone, because the current defaults are doing far more work than most local edits need.
