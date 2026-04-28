# spark-dashboard — Claude project rules

These rules are project-specific. Global coding/test/security rules in `~/.claude/rules/` still apply.

## Pre-commit verification (NON-NEGOTIABLE)

CI fails fast on formatting. Always run the same checks CI runs *before* committing — do not skip, do not batch for "later".

### Rust changes (anything under `src/`, `Cargo.toml`, `Cargo.lock`)

Run from the repo root, in this exact order (mirrors `.github/workflows/ci.yml` → job `rust`):

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

All three must exit 0. If `fmt --check` fails, run `cargo fmt --all` to fix, then re-run the check.

Note: the CI rust job builds the frontend first because `rust-embed` needs `frontend/dist/` at compile time. If you touched embedded assets, also run `(cd frontend && npm ci && npm run build)` before `cargo clippy`/`cargo test`.

### Frontend changes (anything under `frontend/`)

```bash
cd frontend
npm run build
npm test -- --run
```

Both must pass.

### When in doubt

If a change touches *both* Rust and frontend (e.g. metrics shape changes), run the full Rust block AND the full frontend block. CI runs both; you should too.

## Cross-stack contract: metrics

The metrics payload is consumed by the frontend. When you change *any* of the following, you must update *all* of the listed touchpoints in the same commit (or the same PR at minimum):

**Trigger** — changes to:
- `MemoryMetrics` / `GpuMetrics` / `CpuMetrics` struct shapes in `src/metrics/`
- JSON field names / `serde` rename attributes
- Display logic (e.g. `display_total_bytes`, formatters, marketed-capacity rounding)
- New metric fields (added or removed)

**Required updates**:
1. **Rust unit tests** in `src/metrics/` — cover the new field/branch (`#[cfg(test)]` modules)
2. **TypeScript types** in `frontend/src/types/metrics.ts` — keep in sync with serde output
3. **Frontend formatters** in `frontend/src/lib/format.ts` — if the value needs human formatting
4. **Vitest specs** in `frontend/src/__tests__/` — cover new rendering / formatting behavior
5. **Affected components** in `frontend/src/components/` — wire new fields through

If any of (1)–(5) is genuinely not applicable, say so explicitly in the commit message. Default assumption is that all five are needed.

## When adding or changing any feature

Add or update tests in the same commit. No behavior change ships without test coverage updates — backend OR frontend. This has been forgotten before; do not repeat.

- New Rust function with branching logic → unit test in same file's `#[cfg(test)] mod tests`
- New frontend component or formatter → Vitest spec in `frontend/src/__tests__/`
- New API field → both the Rust serializer test AND the frontend type/test
