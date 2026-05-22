# ---------- stage 0: frontend ----------
FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# ---------- stage 1: rust ----------
FROM rust:1.95-slim AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY .gitignore .
# create a dummy frontend/dist so `cargo build` succeeds before the real one
RUN mkdir -p frontend/dist
# cache downloads
RUN cargo build --release 2>&1 | tail -5 || true
COPY src/ ./src/
COPY packaging/ ./packaging/
COPY --from=frontend /app/frontend/dist ./frontend/dist/
RUN cargo build --release

# ---------- stage 2: runtime ----------
FROM debian:trixie-slim
# GPU: uses NVIDIA Container Toolkit (--gpus all), no libnvidia-ml mount needed
# Add docker group with GID 988 (must match host) for Docker socket access
RUN groupadd -g 988 docker && \
    apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/spark-dashboard /usr/local/bin/
