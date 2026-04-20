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

# Strip a leading `~/` — bash expands that to the *local* home when sourcing
# .env, which would then rsync to the wrong place. Remote paths without a
# leading slash are resolved against the remote user's home anyway.
SPARK_DIR="${SPARK_DIR#\~/}"
SPARK_DIR="${SPARK_DIR/#$HOME\//}"

SPARK="${SPARK_USER}@${SPARK_HOST}"
PIDS=()

CLEANED_UP=false
cleanup() {
    [ "$CLEANED_UP" = true ] && return
    CLEANED_UP=true
    echo ""
    echo "==> Shutting down..."
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    ssh "${SPARK}" "pkill -f '[t]arget/release/spark-dashboard' || true" 2>/dev/null || true
    wait 2>/dev/null || true
    echo "Done."
}
trap cleanup EXIT INT TERM

# --- Remote shell prefix: ensure cargo is in PATH for non-interactive SSH ---
REMOTE_ENV="source ~/.cargo/env 2>/dev/null;"

# --- Sync backend source to Spark ---
sync_backend() {
    rsync -az --delete \
        --exclude target \
        --exclude node_modules \
        --exclude .git \
        --exclude .env \
        --exclude .planning \
        --exclude .claude \
        --exclude 'frontend/dist' \
        "${PROJECT_ROOT}/" "${SPARK}:${SPARK_DIR}/"
}

# --- Build and (re)start backend on Spark ---
rebuild_backend() {
    echo "==> Building on Spark..."
    ssh "${SPARK}" "${REMOTE_ENV} pkill -f '[t]arget/release/spark-dashboard' || true"
    if ssh "${SPARK}" "${REMOTE_ENV} cd ${SPARK_DIR} && cargo build --release"; then
        echo "==> Starting backend..."
        ssh "${SPARK}" "cd ${SPARK_DIR} && > /tmp/spark-dashboard.log && (nohup ./target/release/spark-dashboard >> /tmp/spark-dashboard.log 2>&1 < /dev/null &) &"
        echo "==> Backend running"
    else
        echo "!!! Backend build failed"
    fi
}

# --- File watcher: fswatch if available, else polling fallback ---
watch_backend() {
    if command -v fswatch &>/dev/null; then
        fswatch -0 -r -l 2 \
            --exclude '.*target.*' \
            --exclude '.*node_modules.*' \
            --exclude '.*\.git.*' \
            --exclude '.*frontend.*' \
            "${PROJECT_ROOT}/src" "${PROJECT_ROOT}/Cargo.toml" \
        | while IFS= read -r -d '' _; do
            while read -r -d '' -t 0.1 _ 2>/dev/null; do :; done
            echo ""
            echo "==> Backend change detected"
            sync_backend
            rebuild_backend
        done
    else
        local last_hash=""
        while true; do
            local current_hash
            current_hash=$(find "${PROJECT_ROOT}/src" "${PROJECT_ROOT}/Cargo.toml" \
                -type f \( -name '*.rs' -o -name 'Cargo.toml' \) \
                -exec stat -f '%m %N' {} + 2>/dev/null | sort | md5)
            if [ -n "$last_hash" ] && [ "$current_hash" != "$last_hash" ]; then
                echo ""
                echo "==> Backend change detected"
                sync_backend
                rebuild_backend
            fi
            last_hash="$current_hash"
            sleep 2
        done
    fi
}

# 1. Sync and build backend
echo "==> Syncing to ${SPARK}:${SPARK_DIR}..."
sync_backend
rebuild_backend

# 2. Stream backend logs
ssh "${SPARK}" "tail -n0 -f /tmp/spark-dashboard.log" 2>/dev/null &
PIDS+=($!)

# 3. Install frontend deps if needed
if [ ! -d "${PROJECT_ROOT}/frontend/node_modules" ]; then
    echo "==> Installing frontend dependencies..."
    (cd "${PROJECT_ROOT}/frontend" && npm install --silent)
fi

# 4. Start Vite dev server
BACKEND_URL="${VITE_BACKEND_URL:-http://localhost:3000}"
echo "==> Starting Vite dev server (proxy -> ${BACKEND_URL})..."
cd "${PROJECT_ROOT}/frontend"
VITE_BACKEND_URL="${BACKEND_URL}" npx vite --host &
PIDS+=($!)
cd "${PROJECT_ROOT}"

# 5. Watch for backend changes
if command -v fswatch &>/dev/null; then
    echo "==> Watching backend changes (fswatch)..."
else
    echo "==> Watching backend changes (polling, tip: brew install fswatch)..."
fi
watch_backend &
PIDS+=($!)

echo ""
echo "================================================"
echo "  Frontend (Vite):  http://localhost:5173"
echo "  Backend  (Spark): ${BACKEND_URL}"
echo "================================================"
echo ""
echo "  Press Ctrl+C to stop"
echo ""

wait
