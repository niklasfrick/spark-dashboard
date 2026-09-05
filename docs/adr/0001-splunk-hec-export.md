# ADR 0001: Splunk HEC metrics export

- **Status:** Accepted
- **Date:** 2026-08-17
- **Decided by:** design interview (24 questions, all answers settled with the product owner)

## Context

spark-dashboard collects GPU/CPU/memory/disk/network metrics and LLM inference
engine metrics (vLLM) at `poll_interval_ms` (typically ~1s) and shows them in a
local web UI. Operators also want this data in Splunk, in the **Metrics data
model**, for fleet-wide monitoring and alerting.

Facts that constrain the design:

- `metrics::metrics_collector` (`src/metrics/mod.rs`, spawned at
  `src/main.rs:249`) is the single source of the broadcast channel consumed by
  the `/ws` WebSocket → local dashboard. It cannot be stopped without blinding
  the UI.
- The vLLM adapter already scrapes `vllm_num_requests_running` and
  `vllm_num_requests_waiting` every tick (`src/engines/vllm.rs:452-458`) into
  the shared `EngineMetrics` — the "is inference active?" signal already
  exists. `EngineSnapshot` also carries `recent_requests` and `EngineStatus`.
- Configuration already lives in one server-side document:
  `dashboards.json` in the state dir (`src/config_store.rs`), served by
  `GET/PUT/DELETE /api/dashboard` with existing schema-migration and
  read-only-notices machinery.
- `reqwest` is already a dependency (engine adapters use it).

## Decision

### 1. Exporter location and data path

A new tokio task in the Rust backend subscribes to the same metrics broadcast
channel as the WebSocket handler. The collector is **never paused or
throttled** for the exporter — the local UI keeps updating at full rate
regardless of HEC state (decided: "Keep UI, back off exporter").

Steady state: one HEC JSON **array** POST per tick containing
`[current snapshot + queued backlog]`. The next tick is the retry; there is no
separate retry timer. Per-POST timeout 5s. No gzip (payloads are a few KB).

### 2. Event format

**Splunk Metrics data model, multi-metric events** (requires Splunk ≥ 8.0 —
below that, the feature is unsupported, see Consequences). One event per
snapshot:

```json
{
  "time": 1723800000,
  "host": "dgx-spark-01",
  "source": "spark-dashboard",
  "sourcetype": "spark_dashboard",
  "index": "metrics",
  "event": {
    "metric_name:gpu0.utilization_pct": 87.0,
    "metric_name:gpu0.power_watts": 142.5,
    "metric_name:gpu1.utilization_pct": 12.0,
    "metric_name:cpu.utilization_pct": 12.3,
    "metric_name:engine.vllm.req_running": 4.0
  }
}
```

- `time` (`_time`) comes from the **host clock** (the snapshot's
  `timestamp_ms`), never HEC receive time — delayed flushes must not land at
  "now".
- `host` is set explicitly to the local hostname (via the existing `sysinfo`
  dep; no new dependency). HEC would otherwise stamp the *receiving* Splunk
  host. Not exposed in the UI (footgun).
- `source=spark-dashboard`, `sourcetype=spark_dashboard`: fixed, not
  configurable.
- `index`: user-configurable in the settings menu, default `metrics`. The real
  gate is the HEC token's `indexes` allowlist.
- **Identity lives in the metric name, not in an event-level `instance`
  field**: per-GPU metrics are prefixed `gpu0.` / `gpu1.`, engine metrics
  `engine.<engineKey>`. A single multi-metric event cannot carry different
  `instance` values per metric — event-level dimension fields apply to every
  metric in the event — so the identity goes into the name. Host-level
  metrics (memory/disk/network) carry no identity prefix. Both encodings
  stay queryable in the Metrics data model (`metric_name="gpu0.utilization_pct"`).
- **gpu_events** (XID faults, power/thermal) are **not** metrics: they go as
  JSON events to a separate conventional index (`events_index` config field,
  default `main` — a metrics-type index cannot mix events and metrics).

### 3. Idle gating

- **Active** = any engine reported running or queued requests > 0, or a
  request in `recent_requests`, within the last **60 seconds** (fixed
  constant, not a config field).
- **Fail-open**: if an engine's `/metrics` scrape is broken (counts unknown),
  treat it as active. A scrape error must never silently stop the export.
- While idle: **nothing enters the export queue** — metrics snapshots are
  dropped before queueing, so there is no "held zero data" and nothing is sent
  retroactively when a job starts. The silent gap in the index is the record
  of idleness. Resume is immediate on the first active tick.
- **gpu_events are never idle-gated** — hardware faults do not wait for
  inference jobs.

### 4. HEC availability state machine

| State | Entry | Behavior |
|---|---|---|
| `Running` | configured / probe OK | per-tick array POST. Transient failures (429, 503, timeout while the endpoint is reachable) → snapshot queued (cap **1000**, drop-oldest), retried next tick |
| `Down` | connection-level failure (DNS / refused / timeout) | one best-effort final flush of the backlog, then **new metrics snapshots are dropped immediately** (no RAM growth while down). `gpu_events` are still buffered (small separate cap 1000, never dropped — they are the page-worthy data) and flushed on recovery. Liveness probe every **60s** |
| `Down` → `Running` | probe succeeds | flush buffered gpu_events, resume per-tick export. Only fresh data flows — the outage is a hole in Splunk (decided: "drop while down") |

**Liveness probe** = zero-ingest: POST a minimal body to the HEC URL. Any HTTP
response (200/400/403) proves the endpoint is alive; nothing rejected is ever
indexed. Fixed 60s interval (no exponential backoff).

**403 (bad token) and 400 code 7 (index not allowed) count as
*available*** — the network is up; the configuration problem is surfaced in
the UI status with dedicated copy. Treating 403 as "down" would let a token
typo silently stop the export forever.

### 5. Configuration

New optional section in the existing dashboard document
(`export.hec`), riding `GET/PUT/DELETE /api/dashboard` and the existing
schema/migrations/notices machinery. No second config store, no new
config endpoint.

```json
{
  "export": {
    "hec": {
      "url": "https://splunk.example.com:8088/services/collector",
      "token": "…",
      "index": "metrics",
      "events_index": "main"
    }
  }
}
```

- **Presence = enabled.** No `enabled` boolean (drift-prone). "Disable export"
  deletes the whole section, **including the token** (credentials-stored-but-
  dormant is a security smell).
- **Token is write-only through the API**: `GET` returns it masked
  (`…abcd`); `PUT` with an empty token keeps the stored one; the token never
  appears in logs or error messages. Stored plaintext in `dashboards.json`
  (file `0600`; state dir is already `0750`).
- **Single target.** A `targets: []` upgrade path exists via migration if ever
  requested.

### 6. Settings UI

First global settings surface in the app: **gear icon in the header opens a
settings dialog** (shadcn Dialog). The SLO settings stay where they are
(`EngineCard` / `SloSettingsControl`) — they are browser-local and
per-engine/model; a global menu implies host-scoped, and mixing the two
scopes in one surface would confuse.

"Export to Splunk" section: URL, token (masked input, write-only), metrics
index, events index, **Test connection** button, status light + status line,
Disable button.

**Test connection**: POSTs a real metrics event
(`metric_name:spark_dashboard.connectivity.test=1`) to the configured index.
Outcome-specific copy: `200` "OK — test event written to \<index\>";
`403` "HEC token invalid or disabled"; `400` code 7 "index not allowed by
this token — check the token's `indexes` list"; `429` "HEC queue full, try
again"; timeout "cannot reach \<url\>".

**Status light** (decided: strict reachability semantics):

- **Green** = endpoint reachable (liveness probe got an HTTP response).
- **Red** = unreachable (`Down` state, 60s heartbeat probing).
- **Gray/dim** = not configured.
- Rejections (403/400-7) do **not** turn the light red — the status line
  beneath it shows `last_error` with the dedicated copy.

The light appears **in both places**: the settings dialog (5s poll while open)
and a small dot in the app header next to the existing `ConnectionBadge`
(10s poll while the app is open).

### 7. Status API

`GET /api/export-status` →

```json
{
  "state": "exporting",
  "reachable": true,
  "last_ok_ms": 1723800000000,
  "last_error": null,
  "dropped_count": 137
}
```

`state ∈ {disabled, idle, exporting, down}`. One small axum route reusing
existing app state; the WebSocket channel is **not** overloaded with
control-plane messages (rejected).

### 8. Splunk-side prerequisites

Stated in the settings-menu help text (the app does not verify these beyond
the test probe):

1. Splunk ≥ 8.0 (on-prem or Cloud), on-prem or Cloud.
2. Target metrics index is a **metrics-type index** (pure-metrics; "metrics"
   is a conventional name, not built-in).
3. A dedicated HEC token whose `indexes` allowlist includes the configured
   index (per-event `index` is rejected with 400 code 7 otherwise).

## Rejected alternatives

- **One event per metric** (legacy `metric_name`/`value` fields): ~30-60×
  more events; only needed pre-8.0, which we don't support.
- **Plain JSON into an index named "metrics"**: no data-model semantics;
  the word "metrics" would be load-bearing nothing.
- **`sourcetype=splunkmetric` line format**: not verifiable from a live
  official source; dropped rather than betting field names on it.
- **Stopping/throttling the collector while HEC is down**: blinds the local
  dashboard — a local monitoring product must not be hostage to a remote
  sink. The CPU the collector spends is the app's actual job.
- **Disk spool for HEC outages**: adds a second persisted data file to an
  app that deliberately stores one JSON document; a bounded memory queue is
  the right trade.
- **Queueing metrics while HEC is down**: chosen against — "drop while down"
  keeps RAM flat during outages; the outage is a hole, by design.
- **Pushing export status over the existing WebSocket**: protocol change
  touching every WS consumer for a field one dialog reads.
- **Explicit `enabled` boolean / keeping the token on disable**: state that
  can desync; credentials dormant on disk.
- **Multiple targets from day one**: speculative flexibility.

## Consequences

- Feature is **off by default**; nothing is sent until the section exists.
- Requires Splunk ≥ 8.0; older installations simply can't use it (no
  fallback path built).
- The `metrics_collector` broadcast gains a second subscriber — lag on that
  channel is now exporter-relevant (the exporter task must handle
  `RecvError::Lagged` the way `ws.rs` does).
- `dropped_count` counts idle-gated and down-state drops; it is an
  operator-facing number, not a debug counter.
- New dependencies: none.

## Tests (per project rules — tests ship with the change)

Rust (`#[cfg(test)]`):

- Exporter state machine transitions (Running ↔ Down, probe semantics,
  403/400-7 counted as reachable, final flush on entering Down).
- Idle gate: window logic, fail-open on missing engine metrics, resume
  immediacy, gpu_events never gated.
- Token masking: GET redacts, PUT-empty keeps, token absent from error paths.
- Serialization mapping: snapshot → `metric_name:*` fields with identity
  prefixes (`gpu0.`, `engine.<key>`), `_time` from host clock.
- Test-probe response mapping (200/403/400-7/429/timeout → UI copy).
- `/api/export-status` shape; dashboard-document migration adding
  `export.hec` (old document without the section loads and behaves as
  disabled).

Frontend (Vitest, jsdom project):

- `export.hec` schema/migration round-trips; TS types for the section and for
  `/api/export-status`.
- Settings dialog: masked token behavior, test-button copy per outcome,
  light state mapping (green/red/gray), poll start/stop on open/close.

Metrics contract checklist: **N/A** — `MetricsSnapshot`/`GpuMetrics`/
`CpuMetrics` shapes are unchanged; the dashboard *document* schema gains a
section, and that side is covered above. Say so in the commit.

## Process

Branch `feat/splunk-hec-export`, `feat:` conventional commit → release-please
bumps 0.13.0 → 0.14.0. All four `ci.yml` jobs must pass.
