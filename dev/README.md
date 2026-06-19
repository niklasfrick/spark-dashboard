# dev/

Development-only scripts for spark-dashboard. Configuration is read from a
repo-root `.env` file — copy `dev/.env.example` to `.env` and edit before running.

For **production installs**, use `cargo install spark-dashboard` or
`deploy/host/install.sh`. See the repo [README](../README.md#install-on-your-linux-host).

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

### `./dev/docker-dev.sh` — containerized deployment loop

Peer to `dev.sh`, but exercises the containerized path: builds the multi-stage
Dockerfile, deploys via `docker compose` on the remote host, and tails logs.
Uses the same `DEPLOY_USER` / `DEPLOY_HOST` / `DEPLOY_DIR` as `dev.sh`.

```bash
./dev/docker-dev.sh --build-local       # buildx --platform linux/arm64 --load (Mac)
./dev/docker-dev.sh --deploy-remote     # rsync + compose build/up on DGX Spark
./dev/docker-dev.sh --deploy-ghcr       # multi-arch buildx --push, remote pulls
./dev/docker-dev.sh --logs              # docker compose logs -f on the remote
./dev/docker-dev.sh --down              # docker compose down on the remote
```

`--build-local` validates the Dockerfile end-to-end on macOS without GPU access
(no NVML, no `--gpus`). `--deploy-remote` is the full runtime test on the DGX
Spark — confirms GPU passthrough, `/var/run/docker.sock` mount, `pid:host`, and
engine discovery. `--deploy-ghcr` mirrors the eventual release path (multi-arch
image published to GHCR, then `docker compose pull` on the remote).

Set `DOCKER_GID` in your repo-root `.env` to the **remote** host's docker group
GID (`getent group docker | cut -d: -f3`) — `.env` is rsynced to the remote, and
compose adds that GID so the container can read the Docker socket for engine
discovery. See [`.env.docker.example`](../.env.docker.example).

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

## Optional environment variables

| Variable                           | Purpose                                                                  |
|------------------------------------|--------------------------------------------------------------------------|
| `SPARK_DASHBOARD_PROVIDER_API_KEY` | Fallback API key for auth-gated engines. Forwarded to the remote backend. |

### Testing against an auth-gated vLLM

If vLLM is started with `--api-key`, the dashboard's `/v1/models` lookup
returns `401 Unauthorized` and the engine logs fill with auth errors. To test
the fix in the dev loop:

1. Add the key to your repo-root `.env`:

   ```bash
   SPARK_DASHBOARD_PROVIDER_API_KEY=your-vllm-api-key
   ```

2. Restart `./dev/dev.sh`. On backend start you'll see
   `==> Forwarding SPARK_DASHBOARD_PROVIDER_API_KEY to backend`.
3. In the streamed remote log (`/tmp/spark-dashboard.log`) and the vLLM
   container log, confirm `/v1/models` now returns `200` once, then is **not**
   hit again every second — it is cached and re-resolved only on engine
   restart or every 10 minutes. Without a key the dashboard falls back to the
   launch-command model name and stops the per-second 401 retry storm.

This forwards the **global** key, which also covers auto-detected engines. For
per-endpoint keys across multiple engines, run the binary with `--engine-url`
+ `--engine-api-key` (see the main
[README CLI options](../README.md#cli-options)).

## Prerequisites

- **Local machine**: Node.js 20+, npm, rsync, ssh
- **Remote host**: Linux with NVIDIA drivers, Rust 1.75+ in `~/.cargo/env`, reachable over SSH
- **SSH key auth** configured — the scripts make many non-interactive SSH calls and will block on password prompts
- Optional: `brew install fswatch` for instant change detection (otherwise the watcher polls every 2s)
