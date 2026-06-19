# spark-dashboard — Claude project rules

Project-specific. Global rules in `~/.claude/rules/` still apply.

## Branches & PRs

- `main` is protected. No direct pushes. Every change goes through a PR.
- Branch name: `<type>/<slug>` (`feat/...`, `fix/...`, `docs/...`).
- **Rebase-merge** PRs (never squash) so every commit lands individually on `main` and appears in the release notes. **Every commit** must be a valid Conventional Commit, not just the PR title.
- All `ci.yml` jobs (rust, frontend, installer) must pass before merge.

## Commits drive releases

`release-please` reads commits on `main` to bump versions and publish to crates.io. Format: `<type>(<scope>)<!>: <description>`.

| Type                                                       | Bump (pre-1.0)                  |
| ---------------------------------------------------------- | ------------------------------- |
| `feat:`                                                    | minor                           |
| `fix:`                                                     | patch                           |
| `feat!:` / `BREAKING CHANGE:`                              | minor (becomes major after 1.0) |
| `chore`, `docs`, `refactor`, `test`, `ci`, `perf`, `style` | none                            |

"Bump" is version impact only — `chore`/`deps` still appear in the changelog under "Dependencies & Chores" (see `changelog-sections` in `release-please-config.json`); only `docs`/`style`/`refactor`/`test`/`build`/`ci` stay hidden.

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

Docker changes (`deploy/docker/Dockerfile`, `deploy/docker/docker-compose*.yml`):

```bash
./dev/docker-dev.sh --build-local   # buildx multi-stage build smoke test (no GPU)
```

## Dependencies — pick the latest stable

When a dependency is **introduced or selected for the first time** — a crate, npm
package, Docker base image, GitHub Action, toolchain version, anything pinned —
check its newest/latest **stable** release first and pin to that, rather than
copying an older version from memory or an existing line. Verify against the
source of truth (crates.io / npm / the registry's tags / upstream releases), not
training-data recall.

Pick the latest stable available for that distribution channel — and actually
look it up. (Lesson learned the hard way: Google distroless's newest Debian
variant is `-debian13`/trixie, which is also its default — not `-debian12`, which
recall wrongly insisted was the newest. The registry/README is the source of
truth.) State the version you picked and why in the PR/commit.

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
