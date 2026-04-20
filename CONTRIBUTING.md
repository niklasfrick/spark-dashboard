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

## Reporting issues

When filing a bug, please include:

- What you expected vs. what happened
- DGX Spark OS / driver / CUDA versions (`nvidia-smi`)
- Which engine adapter was involved (vLLM, etc.), if any
- A snippet from `/tmp/spark-dashboard.log` around the failure
