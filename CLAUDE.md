# spark-dashboard — Claude project rules

Project-specific. Global rules in `~/.claude/rules/` still apply.

## Branches & PRs

- `main` is protected. No direct pushes. Every change goes through a PR.
- Branch name: `<type>/<slug>` (`feat/...`, `fix/...`, `docs/...`).
- Squash-merge PR title = the commit on `main` → it must be a valid Conventional Commit.
- All `ci.yml` jobs (rust, frontend, installer) must pass before merge.

## Commits drive releases

`release-please` reads commits on `main` to bump versions and publish to crates.io. Format: `<type>(<scope>)<!>: <description>`.

| Type                                                       | Bump (pre-1.0)                  |
| ---------------------------------------------------------- | ------------------------------- |
| `feat:`                                                    | minor                           |
| `fix:`                                                     | patch                           |
| `feat!:` / `BREAKING CHANGE:`                              | minor (becomes major after 1.0) |
| `chore`, `docs`, `refactor`, `test`, `ci`, `perf`, `style` | none                            |

Tags: `vX.Y.Z`. After merge, release-please opens a rolling release PR; merging it tags + triggers `publish.yml` (`cargo publish`).

**Never hand-edit**: `Cargo.toml` version, `Cargo.lock`, `.release-please-manifest.json`, `frontend/package.json`, `frontend/package-lock.json`, `CHANGELOG.md`. Release-please owns them.

## Pre-commit checks (run before pushing)

Rust changes (`src/`, `Cargo.*`):

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

Frontend changes (`frontend/`):

```bash
cd frontend && npm run build && npm test -- --run
```

If both stacks changed, run both blocks. If embedded assets changed, build the frontend first (`rust-embed` needs `frontend/dist/`).

## Metrics contract (Rust ↔ frontend)

When you change `MemoryMetrics`/`GpuMetrics`/`CpuMetrics` shape, serde names, display logic, or fields — update all of these in the same PR:

1. Rust unit tests in `src/metrics/`
2. TS types in `frontend/src/types/metrics.ts`
3. Formatters in `frontend/src/lib/format.ts`
4. Vitest specs in `frontend/src/__tests__/`
5. Components in `frontend/src/components/`

If one is genuinely N/A, say so in the commit.

## Tests ship with the change

No behavior change merges without test coverage in the same PR. Rust branches → `#[cfg(test)]`. Frontend components/formatters → Vitest. New API field → both sides.
