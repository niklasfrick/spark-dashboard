#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- Load .env if present ----------------------------------------------------
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$PROJECT_ROOT/.env"
    set +a
fi

: "${SPARK_USER:?Set SPARK_USER in .env (copy .env.example to .env)}"
: "${SPARK_HOST:?Set SPARK_HOST in .env (copy .env.example to .env)}"
: "${SPARK_DIR:=spark-dashboard}"

# Strip leading `~/` or local home — see dev/dev.sh for rationale.
SPARK_DIR="${SPARK_DIR#\~/}"
SPARK_DIR="${SPARK_DIR/#$HOME\//}"

SPARK="${SPARK_USER}@${SPARK_HOST}"

echo "==> Building frontend locally..."
(cd "${PROJECT_ROOT}/frontend" && npm run build --silent)

echo "==> Syncing to ${SPARK}:${SPARK_DIR}..."
rsync -avz --delete \
  --exclude target \
  --exclude node_modules \
  --exclude .git \
  --exclude .env \
  --exclude .planning \
  --exclude .claude \
  "${PROJECT_ROOT}/" "${SPARK}:${SPARK_DIR}/"

echo "==> Building and running on Spark..."
ssh -t "${SPARK}" "cd ${SPARK_DIR} && touch src/server.rs && cargo build --release 2>&1 && echo '---' && ./target/release/spark-dashboard"
