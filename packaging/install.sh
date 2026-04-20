#!/usr/bin/env bash
#
# Source-build installer for spark-dashboard.
#
# Run from the root of a cloned repository on the DGX Spark:
#
#   sudo ./packaging/install.sh              # build + install + enable service
#   sudo ./packaging/install.sh --no-service # build + install binary only
#   sudo ./packaging/install.sh --uninstall  # remove service + binary
#
# Primary install path is `cargo install spark-dashboard`. Use this script when
# you want to install from a local checkout (air-gapped, auditing, or
# development installs of unreleased code).

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="/usr/local"
MODE="install"

usage() {
    cat <<'EOF'
Usage: install.sh [--prefix PATH] [--no-service] [--uninstall] [--purge]

Options:
  --prefix PATH   Install prefix (default: /usr/local)
  --no-service    Build and install the binary only; skip systemd wiring
  --uninstall     Remove the service and binary
  --purge         With --uninstall, also remove /etc/spark-dashboard
  -h, --help      Show this help
EOF
}

NO_SERVICE=0
PURGE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --prefix)
            PREFIX="${2:?--prefix requires a path}"
            shift 2
            ;;
        --no-service)
            NO_SERVICE=1
            shift
            ;;
        --uninstall)
            MODE="uninstall"
            shift
            ;;
        --purge)
            PURGE=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

require() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "error: \`$1\` is required but not installed" >&2
        exit 1
    }
}

preflight() {
    if [[ "$(uname -s)" != "Linux" ]]; then
        echo "error: this installer only supports Linux (Spark is aarch64 Linux)" >&2
        exit 1
    fi
    if [[ "$(uname -m)" != "aarch64" ]]; then
        echo "warning: expected aarch64, found $(uname -m) — continuing anyway" >&2
    fi
    require systemctl
    require sudo
}

need_root() {
    if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
        echo "error: this step needs root. Re-run with sudo." >&2
        exit 1
    fi
}

uninstall() {
    preflight
    need_root
    local bin="${PREFIX}/bin/spark-dashboard"
    if [[ -x "$bin" ]]; then
        local purge_args=()
        if [[ $PURGE -eq 1 ]]; then
            purge_args+=(--purge)
        fi
        "$bin" service uninstall "${purge_args[@]}"
    else
        echo "spark-dashboard is not installed at $bin — nothing to do"
    fi
}

install_from_source() {
    preflight
    require cargo
    require npm
    require node

    echo "==> Building frontend"
    (cd "${PROJECT_ROOT}/frontend" && npm ci && npm run build)

    echo "==> Building release binary"
    (cd "$PROJECT_ROOT" && cargo build --release --locked)

    local built="${PROJECT_ROOT}/target/release/spark-dashboard"
    if [[ ! -x "$built" ]]; then
        echo "error: expected binary at $built but it is missing" >&2
        exit 1
    fi

    if [[ $NO_SERVICE -eq 1 ]]; then
        echo "==> Installing binary to ${PREFIX}/bin/spark-dashboard (no service)"
        sudo install -m 0755 "$built" "${PREFIX}/bin/spark-dashboard"
        echo "done"
        return
    fi

    echo "==> Installing service (sudo)"
    sudo "$built" service install --prefix "$PREFIX"
}

case "$MODE" in
    install)   install_from_source ;;
    uninstall) uninstall ;;
esac
