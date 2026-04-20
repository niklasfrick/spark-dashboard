# Contributing

Thanks for your interest in spark-dashboard. This is a small focused project;
bug reports, clear reproductions, and targeted PRs are all welcome.

## Local setup

```bash
git clone https://github.com/niklasfrick/spark-dashboard.git
cd spark-dashboard
cp .env.example .env           # edit with your Spark's user/host
./dev/dev.sh
```

See [`dev/README.md`](./dev/README.md) for what each script does and what
environment variables are required.

## Tests

```bash
# Frontend (runs on any OS)
cd frontend && npm test

# Backend (must run on Linux / the DGX Spark — depends on NVML, procfs)
cargo test
```

## Style

- **Rust**: `cargo fmt` + `cargo clippy -- -D warnings` before pushing.
- **TypeScript**: follow the existing code — strict TS, no `any`, no
  `console.log` in production paths.
- Keep files focused (under ~800 lines) and organized by feature, not file
  type.

## Commits and PRs

- Use [Conventional Commits](https://www.conventionalcommits.org/) — this
  project already uses `feat:`, `fix:`, `refactor:`, `perf:`, `docs:`, `chore:`.
- Keep PRs small and reviewable. One logical change per PR.
- Describe *why* in the commit body when it isn't obvious from the diff.
- New features should ship with tests or a note on how you verified them.

## Releases

Releases are fully automated by [release-please](https://github.com/googleapis/release-please).

1. Every commit to `main` must follow [Conventional Commits](https://www.conventionalcommits.org/).
   Commit types drive the version bump: `fix:` → patch, `feat:` → minor,
   `feat!:` / `BREAKING CHANGE:` → major.
2. `release-please` opens and continuously updates a **release PR** on `main`
   that bumps `Cargo.toml`, `frontend/package.json`, and regenerates
   `CHANGELOG.md`.
3. **Merging the release PR** creates the `vX.Y.Z` tag, cuts a GitHub Release,
   and triggers `.github/workflows/publish.yml`, which builds the frontend
   and runs `cargo publish` to crates.io.

`main` is the stable release branch — every tag is a commit on `main`, and
the head of `main` after a merged release PR *is* the current stable version.
Day-to-day feature work lands via PR into `main`; `release-please` batches
those commits into the next release.

### One-time repo setup

- **Branch protection** on `main`: require PR review + green CI (set in
  GitHub repo settings, not in code).
- **Secret** `CARGO_REGISTRY_TOKEN`: create a publish-scoped token at
  https://crates.io/settings/tokens and add it under
  *Settings → Secrets and variables → Actions*.

Do **not** hand-edit version numbers — `release-please` owns them.

## Reporting issues

When filing a bug, please include:

- What you expected vs. what happened
- DGX Spark OS / driver / CUDA versions (`nvidia-smi`)
- Which engine adapter was involved (vLLM, etc.), if any
- A snippet from `/tmp/spark-dashboard.log` around the failure
