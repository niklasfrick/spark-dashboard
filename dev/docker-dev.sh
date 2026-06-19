#!/usr/bin/env bash
# Validate the containerized deployment locally and on the remote host.
# Mirrors dev/dev.sh's DEPLOY_USER/DEPLOY_HOST/DEPLOY_DIR conventions; reads
# the same repo-root .env. See dev/README.md for the high-level dev loop.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_NAME="spark-dashboard"
GHCR_IMAGE="ghcr.io/niklasfrick/spark-dashboard"
GHCR_TAG="dev"

usage() {
    cat <<EOF
Usage: docker-dev.sh <mode> [options]

Modes (exactly one required):

  --build-local         Build the image locally for linux/arm64 (DGX Spark
                        target arch) and load it into the local Docker engine.
                        Validates the multi-stage Dockerfile without needing a
                        GPU. No runtime test — there's no NVML on macOS.

  --deploy-remote       Rsync the project to \${DEPLOY_USER}@\${DEPLOY_HOST}:\${DEPLOY_DIR},
                        then run 'docker compose build && docker compose up -d'
                        on the remote. Mirrors dev/dev.sh's source-sync model
                        but builds the container on the remote rather than the
                        bare binary. Validates the full runtime path (GPU
                        passthrough, /var/run/docker.sock, pid:host, NVML).

  --deploy-ghcr         Build a multi-arch image (linux/arm64,linux/amd64) and
                        push to ${GHCR_IMAGE}:${GHCR_TAG}, then SSH to the
                        remote and 'docker compose pull && up -d'. Mirrors the
                        eventual release path (multi-arch GHCR images). Requires
                        'gh auth token' or GHCR_PAT in the environment, and
                        SPARK_DASHBOARD_IMAGE=${GHCR_IMAGE}:${GHCR_TAG} in the
                        remote .env so compose pulls the pushed tag.

  --logs                Tail logs from the running container on the remote.

  --down                Bring the remote stack down (docker compose down).

  -h, --help            Show this help.

Environment (read from repo-root .env, same as dev/dev.sh):

  DEPLOY_USER  SSH user on the remote host
  DEPLOY_HOST  Hostname or IP of the remote host
  DEPLOY_DIR   Project path on the remote host (default 'spark-dashboard')
  DOCKER_GID   Host docker group GID for socket access in compose. Set this to
               the REMOTE host's GID (getent group docker | cut -d: -f3) since
               .env is rsynced to the remote for --deploy-remote.
  GHCR_PAT     GitHub PAT with write:packages (optional; falls back to 'gh auth token')

Example workflow for testing the container:

  ./dev/docker-dev.sh --build-local       # confirm Dockerfile builds at all
  ./dev/docker-dev.sh --deploy-remote     # full runtime test on DGX Spark
  ./dev/docker-dev.sh --logs              # watch metrics stream start
EOF
}

# --- Parse flags -------------------------------------------------------------
MODE=""
for arg in "$@"; do
    case "$arg" in
        --build-local|--deploy-remote|--deploy-ghcr|--logs|--down)
            if [ -n "$MODE" ]; then
                echo "error: pass exactly one mode (got $MODE and $arg)" >&2
                exit 2
            fi
            MODE="$arg"
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "unknown flag: $arg (try --help)" >&2
            exit 2
            ;;
    esac
done

if [ -z "$MODE" ]; then
    usage
    exit 2
fi

# --- Load .env if present ----------------------------------------------------
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$PROJECT_ROOT/.env"
    set +a
fi

# DEPLOY_* canonical; SPARK_* accepted as legacy aliases (matches dev.sh).
: "${DEPLOY_USER:=${SPARK_USER:-}}"
: "${DEPLOY_HOST:=${SPARK_HOST:-}}"
: "${DEPLOY_DIR:=${SPARK_DIR:-spark-dashboard}}"
DEPLOY_DIR="${DEPLOY_DIR#\~/}"
DEPLOY_DIR="${DEPLOY_DIR/#$HOME\//}"
REMOTE="${DEPLOY_USER:-}@${DEPLOY_HOST:-}"
# Host port the dashboard is reachable on. In the default host-network mode this
# is the port the app binds directly; set SPARK_DASHBOARD_PORT in .env to move it
# (e.g. off :3000 when a cargo-installed instance already owns that port).
DASH_PORT="${SPARK_DASHBOARD_PORT:-3000}"

needs_remote() {
    : "${DEPLOY_USER:?Set DEPLOY_USER in .env}"
    : "${DEPLOY_HOST:?Set DEPLOY_HOST in .env}"
}

# --- Modes -------------------------------------------------------------------

build_local() {
    cd "$PROJECT_ROOT"
    echo "==> Building $IMAGE_NAME:dev for linux/arm64 (DGX Spark target)"
    # --load can only load a single-arch image into the local daemon.
    docker buildx build \
        --platform linux/arm64 \
        --load \
        -f deploy/docker/Dockerfile \
        -t "$IMAGE_NAME:dev" \
        .
    SIZE_BYTES=$(docker image inspect "$IMAGE_NAME:dev" --format '{{.Size}}')
    SIZE_MB=$(( SIZE_BYTES / 1024 / 1024 ))
    echo "==> OK. Image: $IMAGE_NAME:dev (${SIZE_MB} MB)"
    echo "    Note: no runtime test on this host — no NVML or --gpus on macOS."
    echo "    Next: ./dev/docker-dev.sh --deploy-remote"
}

deploy_remote() {
    needs_remote
    cd "$PROJECT_ROOT"
    echo "==> Syncing project to ${REMOTE}:${DEPLOY_DIR}"
    rsync -az --delete \
        --exclude '/target/' \
        --exclude '/frontend/node_modules/' \
        --exclude '/frontend/dist/' \
        --exclude '/.git/' \
        --exclude '/.claude/' \
        --exclude '/.gstack/' \
        --exclude '/docs/' \
        ./ "${REMOTE}:${DEPLOY_DIR}/"

    echo "==> Building and starting container on remote"
    # Compose lives in deploy/docker/; --env-file keeps the repo-root .env
    # (DEPLOY_*, DOCKER_GID) as the substitution source despite the moved file.
    # shellcheck disable=SC2087  # we want $DEPLOY_DIR expanded locally
    ssh "${REMOTE}" bash -lc "set -e
        cd '${DEPLOY_DIR}'
        compose='docker compose --env-file .env -f deploy/docker/docker-compose.yml'
        \$compose build
        \$compose up -d
        echo
        echo '--- container state ---'
        \$compose ps
        echo
        echo '--- recent logs ---'
        \$compose logs --tail=20 spark-dashboard || true
    "
    echo "==> Done. Dashboard: http://${DEPLOY_HOST}:${DASH_PORT}"
    echo "    Health check: docker inspect $IMAGE_NAME --format '{{.State.Health.Status}}'"
}

deploy_ghcr() {
    needs_remote
    cd "$PROJECT_ROOT"

    : "${GHCR_PAT:=$(gh auth token 2>/dev/null || true)}"
    if [ -z "${GHCR_PAT}" ]; then
        echo "error: need GHCR_PAT in env or 'gh auth login' configured" >&2
        exit 2
    fi
    echo "==> Logging into ghcr.io"
    echo "${GHCR_PAT}" | docker login ghcr.io -u "$(gh api user --jq .login 2>/dev/null || echo niklasfrick)" --password-stdin

    echo "==> Building multi-arch image and pushing to ${GHCR_IMAGE}:${GHCR_TAG}"
    docker buildx build \
        --platform linux/arm64,linux/amd64 \
        --push \
        -f deploy/docker/Dockerfile \
        -t "${GHCR_IMAGE}:${GHCR_TAG}" \
        .

    echo "==> Deploying on remote via docker compose pull"
    ssh "${REMOTE}" bash -lc "set -e
        cd '${DEPLOY_DIR}'
        compose='docker compose --env-file .env -f deploy/docker/docker-compose.yml'
        \$compose pull
        \$compose up -d
        \$compose ps
    "
    echo "==> Done. Dashboard: http://${DEPLOY_HOST}:${DASH_PORT}"
}

remote_logs() {
    needs_remote
    ssh "${REMOTE}" "cd '${DEPLOY_DIR}' && docker compose --env-file .env -f deploy/docker/docker-compose.yml logs -f --tail=100 spark-dashboard"
}

remote_down() {
    needs_remote
    ssh "${REMOTE}" "cd '${DEPLOY_DIR}' && docker compose --env-file .env -f deploy/docker/docker-compose.yml down"
}

case "$MODE" in
    --build-local)   build_local ;;
    --deploy-remote) deploy_remote ;;
    --deploy-ghcr)   deploy_ghcr ;;
    --logs)          remote_logs ;;
    --down)          remote_down ;;
esac
