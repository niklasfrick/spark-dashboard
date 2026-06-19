# Running spark-dashboard with Docker

Containers are a first-class deployment path, peer to the `cargo install` +
systemd route. The image is published multi-arch (`linux/amd64`, `linux/arm64`)
to **`ghcr.io/niklasfrick/spark-dashboard`**, tagged `:vX.Y.Z`, `:vX.Y`, and
`:latest`.

## Quick start

```bash
docker run --rm --gpus all --pid=host -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  --group-add "$(getent group docker | cut -d: -f3)" \
  ghcr.io/niklasfrick/spark-dashboard:latest
```

The dashboard is served on port 3000. `--group-add` joins the host's docker
group so container-based engine discovery works — see
[The DOCKER_GID gotcha](#the-docker_gid-gotcha). Prefer Compose for anything
long-lived.

## Prerequisites

- Linux host with NVIDIA drivers.
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
  installed and configured (`--gpus all` / Compose device reservations rely on it).
- Docker Engine with Compose v2 (`docker compose`, not `docker-compose`).

## Compose

`docker-compose.yml` ships host networking, GPU passthrough, the read-only
Docker socket mount, and `pid:host` preconfigured. The compose files live in this
`deploy/docker/` directory — run the commands below from there (`cd deploy/docker`).
Configure it with a `.env` file (copy [`.env.docker.example`](./.env.docker.example)):

```bash
cd deploy/docker
cp .env.docker.example .env
# set DOCKER_GID — see "The DOCKER_GID gotcha" below
docker compose up -d
docker compose logs -f spark-dashboard
```

By default Compose **pulls** `ghcr.io/niklasfrick/spark-dashboard:latest`. To
build from a local checkout instead:

```bash
docker compose build && docker compose up -d
```

Pin a specific version or a dev tag with `SPARK_DASHBOARD_IMAGE` in `.env`:

```bash
SPARK_DASHBOARD_IMAGE=ghcr.io/niklasfrick/spark-dashboard:v0.10.0
```

## Networking modes

### Host (default)

`network_mode: host` lets the dashboard reach engines bound to the host network
(e.g. vLLM started via sparkrun) and discover host processes. The dashboard
listens directly on the host's port 3000. This is the right default for a
single-tenant GPU box. In this mode `SPARK_DASHBOARD_PORT` is the port the app
binds **directly on the host** (there's no port mapping) — set it to move the
dashboard off `:3000`, e.g. when a `cargo install`ed instance already owns 3000.

### Bridge (opt-in)

For network isolation, layer the bridge override:

```bash
docker compose -f docker-compose.yml -f docker-compose.bridge.yml up -d
```

This switches to bridge networking, publishes `3000:3000`, and adds
`host.docker.internal` (→ `host-gateway`) so the container can still reach host
services. **Tradeoff:** engines bound only to the host network are no longer
auto-discovered. Container-based discovery over the Docker socket still works
(`pid:host` is inherited).

## GPU passthrough

GPU metrics come from **NVML**, not device-file mounts — so no `/dev/nvidia*`
mounting is needed. The Compose file reserves all GPUs via the NVIDIA Container
Toolkit:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

For `docker run`, the equivalent is `--gpus all`. Select a specific device with
`SPARK_DASHBOARD_GPU_INDEX` on multi-GPU hosts.

## Environment variables

All are optional; defaults match the binary. Set them in `.env`.

| Variable                            | Default     | Purpose                                              |
| ----------------------------------- | ----------- | ---------------------------------------------------- |
| `DOCKER_GID`                        | `999`       | Host docker group GID for socket access (see below). |
| `SPARK_DASHBOARD_IMAGE`             | `…:latest`  | Image Compose runs when not building from source.    |
| `SPARK_DASHBOARD_PORT`              | `3000`      | Listen port.                                         |
| `SPARK_DASHBOARD_BIND`              | `0.0.0.0`   | Bind address.                                        |
| `SPARK_DASHBOARD_POLL_INTERVAL`     | `1000`      | Metrics polling interval (ms).                       |
| `SPARK_DASHBOARD_GPU_INDEX`         | `0`         | NVML GPU index to monitor.                           |
| `SPARK_DASHBOARD_PROVIDER_API_KEY`  | _(unset)_   | Fallback API key for auth-gated engines.             |
| `RUST_LOG`                          | `info`      | Log filter (`error`/`warn`/`info`/`debug`/`trace`).  |

## Health

The container exposes a liveness endpoint at **`/healthz`** (returns `200 ok`).
The image's `HEALTHCHECK` polls it every 30s. Check status with:

```bash
docker inspect spark-dashboard --format '{{.State.Health.Status}}'   # -> healthy
```

It reports that the HTTP server is up — engine/GPU health is surfaced live over
the `/ws` WebSocket in the UI.

## The DOCKER_GID gotcha

Engine discovery reads the host's `/var/run/docker.sock`. The container must
join the host's **docker group GID** to do so. This GID varies by distro
(commonly `999` on Debian/Ubuntu, sometimes `998`/`988`). Find yours:

```bash
getent group docker | cut -d: -f3
```

Set it in `.env` as `DOCKER_GID` (Compose). With plain `docker run`, pass the
equivalent `--group-add "$(getent group docker | cut -d: -f3)"`. On a mismatch
the container still starts but container-based engine discovery silently degrades
— you'll see a one-line "Docker detection unavailable" note in the logs.

## Security tradeoffs

The default configuration is tuned for a trusted single-tenant GPU host and is
deliberately permissive:

- **`network_mode: host`** — no network isolation from the host. Use the bridge
  override if you need it.
- **`pid: host`** — the container sees all host processes (required for
  process-based engine discovery).
- **`/var/run/docker.sock` (read-only)** — read access to the Docker API. Mounted
  `:ro`, but socket access is still powerful; only run this on hosts you trust.

The image itself is hardened: it runs as a non-root user (uid 65532) on
`gcr.io/distroless/cc-debian13`. Distroless ships only glibc and CA
certificates — no shell, no package manager, none of the Debian userland a
`-slim` base carries — which removes essentially the entire OS-package CVE
surface. One operational consequence: there is no shell, so `docker exec
<container> sh` won't work for debugging; the built-in liveness probe runs the
binary's own `healthcheck` subcommand instead of shelling out to `wget`.

## Updating

```bash
docker compose pull && docker compose up -d
```

Or pin to a new explicit `SPARK_DASHBOARD_IMAGE` tag and re-run `up -d`.

## Building / testing locally

Use the dev harness (see [`dev/README.md`](../../dev/README.md)):

```bash
./dev/docker-dev.sh --build-local     # buildx linux/arm64 --load — Dockerfile smoke test
./dev/docker-dev.sh --deploy-remote   # rsync + compose build/up on the remote GPU host
```
