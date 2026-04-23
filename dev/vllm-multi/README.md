# Multi-engine vLLM test rig

Three-instance vLLM setup, fronted by an OpenResty reverse proxy on
port 8000, for validating the spark-dashboard multi-engine view.
Designed for the NVIDIA DGX Spark (128 GB unified LPDDR5x,
GB10 Grace-Blackwell) but runs on any CUDA host with ≥ 48 GB GPU-visible
memory.

## What runs

| Service       | Host port | Model                       | `--gpu-memory-utilization` | `--max-model-len` |
|---------------|-----------|-----------------------------|----------------------------|-------------------|
| `vllm-proxy`  | **8000**  | OpenResty reverse proxy     | —                          | —                 |
| `vllm-small`  | 8001      | `unsloth/Llama-3.2-1B-Instruct` | 0.15                       | 4096              |
| `vllm-medium` | 8002      | `Qwen/Qwen2.5-3B-Instruct`  | 0.20                       | 4096              |
| `vllm-large`  | 8003      | `google/gemma-4-E2B-it`     | 0.18                       | 4096              |

Dashboard integration: the three vLLM containers are published on
`:8001`, `:8002`, `:8003` so the dashboard's Docker detector sees each as
a separate engine. Client-facing traffic goes through the proxy on `:8000`.

Sum of GPU memory reservations = 0.75 of the GPU-visible pool, leaving
~30 GB for the host OS, CPU workloads, and the dashboard itself on the
Spark's ~120 GB GPU-addressable slice.

The small and medium models are open-weight and pullable without auth.
The large slot (`google/gemma-4-E2B-it`) is **gated** — accept the model
license on Hugging Face and put `HF_TOKEN=<your-token>` in a sibling
`.env` before `docker compose up`. The same `.env` also avoids
rate-limit pushback from `huggingface.co`.

## Prereqs

- Docker 24+
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
  configured (`docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi`
  should succeed)
- ~20 GB free disk for the weights (stored in a shared Docker named volume
  so each model downloads once even if you tear the stack down and up again)

## Run

```bash
cd dev/vllm-multi
docker compose up -d
```

First boot downloads weights; expect 2–5 minutes per model on a fast link.
Watch progress:

```bash
docker compose logs -f vllm-small
docker compose logs -f vllm-medium
docker compose logs -f vllm-large
```

Readiness gate on each container is the vLLM `/health` endpoint. Once all
three are healthy, the dashboard's Docker-layer detector will pick them up
automatically within ~5 seconds.

## Using the proxy (OpenAI-compatible)

`http://localhost:8000` exposes a full OpenAI API surface backed by all
three vLLM instances. From any OpenAI-compatible client it looks like
one server that happens to serve three models:

```
GET  /v1/models                      # list every served model (aggregated)
GET  /v1/models/{id}                  # retrieve one
POST /v1/chat/completions            # routes by "model" in the body
POST /v1/completions                  # same
POST /v1/embeddings                   # same
```

Accepted model ids (what goes in the `model` field of a request, or what
`/v1/models` returns):

| Id             | Upstream     | Aliases accepted                  |
|----------------|--------------|-----------------------------------|
| `llama-3.2-1b` | `vllm-small` | `unsloth/Llama-3.2-1B-Instruct`   |
| `qwen2.5-3b`   | `vllm-medium`| `Qwen/Qwen2.5-3B-Instruct`        |
| `gemma-4-e2b`  | `vllm-large` | `google/gemma-4-E2B-it`           |

Unknown model ids return a standard OpenAI error envelope with
`code: "model_not_found"` (HTTP 404). Missing `model` in the body returns
`code: "missing_model"` (HTTP 400).

### List every model

```bash
curl -sS http://localhost:8000/v1/models | jq .
# -> { "object": "list", "data": [
#      {"id": "llama-3.2-1b", ...},
#      {"id": "qwen2.5-3b",   ...},
#      {"id": "gemma-4-e2b",  ...}
#    ]}
```

### Chat completion (routes by `model`)

```bash
curl -sS http://localhost:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gemma-4-e2b",
    "messages": [{"role": "user", "content": "say hi"}],
    "max_tokens": 32
  }' | jq .
```

### OpenAI Python SDK

```python
from openai import OpenAI
client = OpenAI(base_url="http://<host>:8000/v1", api_key="dummy")

print([m.id for m in client.models.list().data])
# ['llama-3.2-1b', 'qwen2.5-3b', 'gemma-4-e2b']

resp = client.chat.completions.create(
    model="qwen2.5-3b",
    messages=[{"role": "user", "content": "hi"}],
)
```

### Explicit per-upstream paths (debugging only)

Not part of the OpenAI API surface — use when you need to bypass the
model router:

```bash
curl -sS http://localhost:8000/small/v1/chat/completions  -d '{...}'
curl -sS http://localhost:8000/medium/v1/chat/completions -d '{...}'
curl -sS http://localhost:8000/large/v1/chat/completions  -d '{...}'
```

### Direct per-instance access

The three vLLM containers are also published individually for the
dashboard and for debugging:

```bash
curl -sS http://localhost:8001/v1/chat/completions  -d '{...}'   # small
curl -sS http://localhost:8002/v1/chat/completions  -d '{...}'   # medium
curl -sS http://localhost:8003/v1/chat/completions  -d '{...}'   # large
```

### Health

`GET http://localhost:8000/health` returns
`{"status":"ok","upstreams":[...]}` once the proxy is up. Individual
upstream readiness is still visible via each container's own `/health`.

## Verifying the dashboard picks them up

With `spark-dashboard` running (via `systemctl start spark-dashboard` or
the dev loop in `dev/dev.sh`), open the dashboard and:

1. The **Global** tab should be selected by default and show
   `3 of 3 running`.
2. Each of the three per-engine tabs should show its distinct model name
   (`llama-3.2-1b`, `qwen2.5-3b`, `gemma-4-e2b`).
3. Sending a request to one port lights up that engine's tab (active
   requests, throughput) while the Global tab aggregates across all three.

## Tear down

```bash
docker compose down              # stop + remove containers
docker compose down --volumes    # also drop the weights cache
```

## Troubleshooting

### `ValueError: No available memory for the cache blocks`

vLLM measures `--gpu-memory-utilization` against **currently free GPU
memory at init time**, not against the total pool. If two vLLM containers
start in parallel, the first one to finish profiling reserves its slice
and the second sees a shrunken "free" figure — it refuses to start.

This compose file works around that with
`depends_on: { condition: service_healthy }` so `vllm-medium` only starts
after `vllm-small` is up and `vllm-large` only starts after both. Starting
the whole stack therefore takes roughly the sum of the per-model warm-up
times (expect 5–10 minutes the first time). If you still see the error,
reduce `--max-model-len` (each doubling of context roughly doubles the
required KV cache) or drop `--gpu-memory-utilization` a notch.

### Dashboard says "No inference engines detected" even though containers are healthy

Two likely causes:

1. **`spark-dashboard` isn't in the `docker` group yet.** The service
   installer adds it (`SupplementaryGroups=... docker` in the unit file),
   but if you installed Docker *after* the dashboard, you need to re-apply:

   ```bash
   sudo usermod -aG docker spark-dashboard
   sudo systemctl restart spark-dashboard
   journalctl -u spark-dashboard -n 50 | grep -i docker
   ```

   You should see `Detected engine: vLLM at http://localhost:8000` within
   ~5 seconds. If you instead see `Docker detection unavailable …` the
   group change didn't take effect — confirm with
   `sudo -u spark-dashboard id` and check for `docker`.

2. **Rootless Docker.** `/var/run/docker.sock` doesn't exist; the socket
   lives at `~/.docker/run/docker.sock` or `/run/user/<uid>/docker.sock`.
   Either switch to rootful Docker (simplest on a single-user box like the
   Spark) or symlink the socket to `/var/run/docker.sock`.

Once detection works, a fresh `docker compose up` will populate the Global
tab within one poll cycle (1–2 s).

## Swapping models

Pick any Hugging Face model supported by vLLM. The back-of-envelope memory
cap is:

```
--gpu-memory-utilization ≈ (model_gb * 1.5) / gpu_visible_gb
```

The extra 1.5× accounts for activations and a minimum KV cache. On the
Spark's ~120 GB pool, that gives you roughly:

| Model size (bf16) | Suggested `--gpu-memory-utilization` |
|-------------------|--------------------------------------|
| 0.5 B             | 0.05–0.10                            |
| 3 B               | 0.15–0.25                            |
| 7 B               | 0.25–0.35                            |
| 13 B              | 0.40–0.55                            |

Keep the running sum across the three services ≤ 0.80 so the host OS and
dashboard stay responsive.

Gated models (Llama family, Gemma, Mistral Nemo, …) require setting
`HF_TOKEN` in the environment or `dev/vllm-multi/.env` after accepting
the model's license on Hugging Face.
