# dev/

Development-only scripts for spark-dashboard. Configuration is read from a
repo-root `.env` file — copy `.env.example` to `.env` and edit before running.

For **production installs**, use `cargo install spark-dashboard` or
`packaging/install.sh`. See the repo [README](../README.md#install-on-the-dgx-spark).

## Scripts

### `./dev/dev.sh` — development loop

Runs the full dev environment:

1. rsyncs the project to `${SPARK_USER}@${SPARK_HOST}:${SPARK_DIR}`
2. builds and starts the Rust backend on the Spark (`cargo build --release`)
3. starts the Vite dev server locally on port 5173 with a proxy to the backend
4. streams remote backend logs from `/tmp/spark-dashboard.log`
5. watches `src/` and `Cargo.toml` — on change, re-syncs and rebuilds the backend

Frontend edits hot-reload in the browser via Vite. Backend edits trigger a
remote rebuild (takes about as long as `cargo build --release` does on your
Spark).

## Required environment variables

| Variable           | Purpose                                                      |
|--------------------|--------------------------------------------------------------|
| `SPARK_USER`       | SSH user on the Spark (required)                             |
| `SPARK_HOST`       | Hostname or IP of the Spark (required)                       |
| `SPARK_DIR`        | Project path on the Spark, relative to remote home (default `spark-dashboard`) |
| `VITE_BACKEND_URL` | Where Vite proxies `/ws` and `/api` (default `http://localhost:3000`) |

Missing `SPARK_USER` or `SPARK_HOST` causes the script to exit immediately with
a clear message.

## Prerequisites

- **Local machine**: Node.js 20+, npm, rsync, ssh
- **DGX Spark**: Rust 1.75+ in `~/.cargo/env`, reachable over SSH
- **SSH key auth** configured — the scripts make many non-interactive SSH calls and will block on password prompts
- Optional: `brew install fswatch` for instant change detection (otherwise the watcher polls every 2s)
