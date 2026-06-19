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
# The builder's glibc must match the runtime's: the binary is dynamically linked
# against glibc and dlopen's libnvidia-ml.so at run time. Both this stage
# (rust:<v>-slim → Debian trixie) and the runtime stage below
# (gcr.io/distroless/cc-debian13 → Debian trixie) track Debian 13 / glibc 2.41 —
# keep them on matching Debian releases (e.g. both -debian13 or both -debian12),
# or the binary fails with a "GLIBC_x.yz not found" error at startup.
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
# Embedded by include_str! at compile time (systemd unit + config example for the
# `service` subcommand). Only these two paths — not the whole deploy/ folder — so
# the Dockerfile/compose files don't bust this layer's cache.
COPY deploy/host/systemd ./deploy/host/systemd
COPY deploy/host/config.env.example ./deploy/host/config.env.example
COPY --from=frontend /app/frontend/dist ./frontend/dist/
RUN cargo build --release --locked

# ---------- stage: runtime ----------
# Distroless: glibc + CA certs and nothing else — no shell, no package manager,
# no apt/perl/util-linux/coreutils/systemd. That removes the entire Debian-package
# CVE surface a -slim base carries while still providing the glibc dynamic loader
# the binary needs (it dlopen's libnvidia-ml.so at run time, so a static scratch
# image is not an option). The :nonroot tag runs as uid 65532 out of the box.
FROM gcr.io/distroless/cc-debian13:nonroot AS runtime

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

COPY --from=builder /app/target/release/spark-dashboard /usr/local/bin/spark-dashboard

# Already uid 65532 via the :nonroot tag; stated explicitly for clarity. NVML,
# /proc, and the docker socket all work non-root given the device/group access
# supplied at run time (see docker-compose.yml: GPU reservation + group_add).
USER nonroot
EXPOSE 3000

# Liveness probe against /healthz. Distroless has no shell or wget, so this execs
# the binary's own `healthcheck` subcommand, which reads SPARK_DASHBOARD_PORT.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD ["/usr/local/bin/spark-dashboard", "healthcheck"]

ENTRYPOINT ["/usr/local/bin/spark-dashboard"]
