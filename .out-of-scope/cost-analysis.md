# Cost Analysis & Third-Party Pricing Lookups

spark-dashboard does not do cost accounting: no cloud-vs-on-prem cost
comparison, no revenue/profit modeling, and no calls to third-party pricing
APIs (e.g. OpenRouter) to fetch per-token model rates.

## Why this is out of scope

**Scope/philosophy.** spark-dashboard is a live observability tool for a DGX
Spark host: what the hardware and inference engines are doing right now, and —
with persistent history — what they did over time. Cost analysis is a business
*interpretation* layered on top of that telemetry, and revenue/profit modeling
goes further still by assuming the operator sells inference per token. That's
one possible use of a Spark among many (development, research, homelab), so
the concept doesn't belong in the product's shared domain. Historical metrics
are the boundary: the dashboard records and serves *what happened*; what that
was worth in currency is a downstream concern for tooling that consumes the
data.

**Technical: no third-party egress.** The backend talks only to local sources
— NVML, the local Docker socket, and engine endpoints on the host. It makes no
outbound internet calls, and deployments should be able to rely on that (the
dashboard is often run on isolated or private networks). A pricing lookup to
`openrouter.ai` would introduce silent network egress from an ops tool,
couple a local dashboard's features to an external service's availability and
API stability, and surface numbers (cloud list prices) that go stale and
can't be verified from the host.

**Configuration surface.** Cost modeling drags in settings that have nothing
to do with observability — electricity rates, cloud per-token prompt/gen
rates, currency assumptions — each an unauthenticated write endpoint or config
knob to maintain.

## What *is* in scope instead

Persistent metrics history (accepted in principle during triage of #47):
recording per-engine metric rollups locally and serving them over the
dashboard's own API. Anything money-related should be built outside the
dashboard on top of exported history data.

## Prior requests

- #47 — "feat(history): add SQLite-backed historical dashboard with pricing lookup" (cost-analysis portion; the history portion was accepted)
