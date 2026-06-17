# syntax=docker/dockerfile:1

# ---------- stage: frontend ----------
# Build the SPA so rust-embed can bundle frontend/dist at compile time.
# Node 24 matches the version pinned in CI.
FROM node:24-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# ---------- stage: chef ----------
# cargo-chef gives honest dependency-layer caching: deps are "cooked" from
# Cargo.toml/Cargo.lock alone, so editing src/ doesn't bust the dependency
# layer. Replaces the dummy-frontend/dist + `|| true` cache trick.
# rust:<v>-slim and the runtime stage below both track Debian trixie, so their
# glibc matches — keep these two in lockstep when bumping the Debian release.
FROM rust:1.96-slim AS chef
RUN cargo install cargo-chef --locked
WORKDIR /app

FROM chef AS planner
COPY Cargo.toml Cargo.lock ./
COPY src/ ./src/
RUN cargo chef prepare --recipe-path recipe.json

# ---------- stage: builder ----------
FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
# Build & cache dependencies only (no app code yet). --locked keeps the build
# reproducible against Cargo.lock, matching CI.
RUN cargo chef cook --release --locked --recipe-path recipe.json
# Real build: app sources + the embedded frontend assets (rust-embed reads
# frontend/dist at compile time, so it must exist here).
COPY Cargo.toml Cargo.lock ./
COPY src/ ./src/
COPY packaging/ ./packaging/
COPY --from=frontend /app/frontend/dist ./frontend/dist/
RUN cargo build --release --locked

# ---------- stage: runtime ----------
FROM debian:trixie-slim AS runtime

# OCI image metadata. revision/version are injected at build time (see the
# docker-publish workflow / docker-compose build args).
ARG VCS_REF=""
ARG VERSION=""
LABEL org.opencontainers.image.source="https://github.com/niklasfrick/spark-dashboard" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.title="spark-dashboard" \
      org.opencontainers.image.description="Real-time hardware and LLM inference monitoring for Linux hosts with NVIDIA GPUs" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}"

# ca-certificates: outbound HTTPS to engine APIs. wget: HEALTHCHECK probe.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

# Run unprivileged (uid 10001), mirroring the hardened systemd profile. NVML,
# /proc, and the docker socket all work non-root given the device/group access
# supplied at run time (see docker-compose.yml: GPU reservation + group_add).
RUN useradd -r -u 10001 -s /usr/sbin/nologin spark

COPY --from=builder /app/target/release/spark-dashboard /usr/local/bin/spark-dashboard

USER spark
EXPOSE 3000

# Liveness probe against the /healthz endpoint. Honors SPARK_DASHBOARD_PORT.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD wget -qO- "http://127.0.0.1:${SPARK_DASHBOARD_PORT:-3000}/healthz" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/spark-dashboard"]
