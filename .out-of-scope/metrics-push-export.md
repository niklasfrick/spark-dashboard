# Pushing Metrics to an External Sink

spark-dashboard does not push its data to another system. There is no Splunk
HEC exporter in the backend, and no other built-in exporter that sends metrics,
GPU events or engine logs to an endpoint off the host.

## Why this is out of scope

**The backend talks only to local sources.** NVML, the local Docker socket and
engine endpoints on the host are everything it reads, and it opens no outbound
connection of its own. `.out-of-scope/cost-analysis.md` records the same
boundary for pricing lookups. A push exporter is opt-in and points at an
endpoint the operator chose, so it is not the same thing as a third-party
lookup — but it changes the same property. Today "this binary sends nothing
anywhere" is a fact about the binary. With an exporter it becomes a fact about
its current configuration, and the dashboard is often run on isolated or
private networks where that difference matters.

**The target has nowhere safe to live.** The dashboard has no accounts
(`CONTEXT.md`, **Operator**), so every write endpoint is open to anyone who can
reach the instance. A push target is a URL plus a credential, and both of the
places it could be stored are wrong:

- In the **dashboard configuration**, the server has to read and rewrite a
  document it stores as opaque bytes
  ([ADR-0002](../docs/adr/0002-configuration-is-an-opaque-document.md)). #125
  parsed it on every read to mask the token and on every write to put the token
  back, which is a second cross-language contract in everything but name.
- Behind **any unauthenticated endpoint**, masking the credential does not
  protect it. A token that is write-only through the API is still sent wherever
  the URL field points, and the URL is writable by the same anonymous caller.
  Whoever can open the dashboard can redirect the host's data, and the stored
  credential travels with it.

Fixing the second point properly means an identity system, which this project
deliberately does not have
([ADR-0003](../docs/adr/0003-instance-scoped-last-write-wins-configuration.md)).

**A vendor sink is a second product.** #125 was about 2,250 lines of Rust for
one vendor's protocol: an availability state machine, idle gating, bounded
buffering, a status API, a settings dialog and a guide to configuring the
Splunk side. None of it can be checked without a Splunk instance, and each
further sink (OTLP, InfluxDB, Loki) would ask for the same again.

**Engine logs are not metrics.** #125 also forwarded engine container logs,
which can contain prompts and completions. Sending those off the host is a
bigger decision than exporting utilization figures and does not belong behind
the same switch.

## What this record does not cover

The dashboard serves what it collects; what happens to that data elsewhere is a
job for tooling that runs beside it and keeps its own credentials in its own
configuration.

A **pull-based** endpoint — the dashboard exposing its metrics for a collector
to scrape — is a different request. It adds no outbound connection and stores
no credential, so the reasons above do not apply to it. It has not been
requested or decided, and this record should not be used to turn one away.

## Prior requests

- #125 — "feat(hec): Splunk HEC metrics and events export" (closed on product
  grounds; lint, build and the test suites passed on its head commit)
- #126 — carried follow-up changes to the same exporter (a host-wide
  `hec.json`, `--hec-insecure`) stacked on #125
