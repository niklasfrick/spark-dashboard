# dev/

Development-only scripts for spark-dashboard. Configuration is read from a
repo-root `.env` file — copy `.env.example` to `.env` and edit before running.

For **production installs**, use `cargo install spark-dashboard` or
`packaging/install.sh`. See the repo [README](../README.md#install-on-your-linux-host).

## Scripts

### `./dev/dev.sh` — development loop

Runs the full dev environment:

1. builds the frontend bundle locally (`npm run build` in `frontend/`) so the
   embedded assets shipped to the remote backend are current
2. rsyncs the project (including `frontend/dist/`) to `${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_DIR}`
3. builds and starts the Rust backend on the remote host (`cargo build --release`,
   which embeds the freshly-built `frontend/dist/`)
4. starts the Vite dev server locally on port 5173 with a proxy to the backend
5. streams remote backend logs from `/tmp/spark-dashboard.log`
6. watches `src/` and `Cargo.toml` — on change, re-syncs and rebuilds the backend

Two URLs, two behaviors:

- `http://localhost:5173` — Vite dev server. Frontend edits hot-reload in the
  browser, API/WS calls proxy to the remote backend.
- `http://${DEPLOY_HOST}:3000` — the remote backend serving the **embedded**
  bundle that was built when `dev.sh` started. To refresh it during a session,
  re-run `npm run build` locally and trigger any backend file change (or just
  restart `dev.sh`) so the next sync + `cargo build --release` re-embeds the
  fresh `frontend/dist/`.

Backend edits trigger a remote rebuild (takes about as long as
`cargo build --release` does on your remote host).

#### `--watch-frontend` (optional)

Pass `./dev/dev.sh --watch-frontend` to also watch `frontend/src/`,
`frontend/public/`, `frontend/index.html`, `vite.config.ts`, and
`package.json`. On change the script rebuilds `frontend/dist/`, re-syncs to the
remote, and rebuilds the backend — so direct hits on
`http://${DEPLOY_HOST}:3000` refresh too.

Off by default because each save triggers a full `npm run build` plus
`cargo build --release` (~10–30s on a typical remote). For normal frontend dev,
use `:5173` (Vite, instant HMR) and only enable this flag when you specifically
need the embedded bundle to stay current.

## Required environment variables

| Variable           | Purpose                                                      |
|--------------------|--------------------------------------------------------------|
| `DEPLOY_USER`      | SSH user on the remote host (required)                       |
| `DEPLOY_HOST`      | Hostname or IP of the remote host (required)                 |
| `DEPLOY_DIR`       | Project path on the remote host, relative to remote home (default `spark-dashboard`) |
| `VITE_BACKEND_URL` | Where Vite proxies `/ws` and `/api` (default `http://localhost:3000`) |

Missing `DEPLOY_USER` or `DEPLOY_HOST` causes the script to exit immediately
with a clear message.

Legacy `SPARK_USER` / `SPARK_HOST` / `SPARK_DIR` are still accepted as a
fallback when `DEPLOY_*` are unset; you'll see a one-line deprecation note on
startup.

## Prerequisites

- **Local machine**: Node.js 20+, npm, rsync, ssh
- **Remote host**: Linux with NVIDIA drivers, Rust 1.75+ in `~/.cargo/env`, reachable over SSH
- **SSH key auth** configured — the scripts make many non-interactive SSH calls and will block on password prompts
- Optional: `brew install fswatch` for instant change detection (otherwise the watcher polls every 2s)
