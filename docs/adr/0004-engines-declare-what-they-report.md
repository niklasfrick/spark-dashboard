# Engines declare what they report on the metrics contract

**Status:** accepted (2026-10)

Engine types other than vLLM report different subsets of what the engine panels
show: SGLang nearly everything, llama.cpp throughput and means but no
histograms, Ollama no metrics at all (#96). Two rules follow, and both are part
of the metrics contract.

**The backend says, per engine, which metric groups it reports.** The frontend
reads that and holds no table of its own keyed by engine type. What an engine
reports depends on its version and on how it was launched, not only on its type,
and only the backend sees the scrape. A `null` cannot carry it either: `null`
already means "warming up", "not emitted yet" and "feature not configured", and
a panel has to tell those apart from "this engine never reports this" to say
something true.

**A field holds only the quantity it names.** Arithmetic on the engine's own
counters is fine — a rate from a counter, a mean from a sum and a count. A
different quantity standing in for a missing one is not: mean prefill time is
not time to first token, and a count of requests the dashboard happened to
observe is not the engine's request count. An engine that lacks the quantity
does not report the group.

## Considered options

- **A static table in the frontend, keyed by engine type.** Simpler, and what
  the first llama.cpp contribution (#126) built. Rejected because it is a second
  copy of backend knowledge on the far side of the project's only cross-language
  contract, and it is wrong whenever a version or a launch flag changes what an
  engine exposes.
- **Stand-in values behind an "estimated" flag.** Rejected because the stand-ins
  on offer were different quantities, not estimates of the same one. They would
  sit under the same heading as another engine's real figure, and enter the
  **all models** combination as if they were comparable.

## Consequences

- **An engine panel has three empty states, and they read differently.** A
  metric group that is not reported is a placeholder that says so; **metrics
  off** names the launch flag that fixes it; "not yet" stays what it is today.
  None of them is a zero.
- **Some engines look poorer than they could be made to look.** llama.cpp has
  no time to first token, no end-to-end latency and no request count, and its
  latency is a mean that is labelled as a mean, never shown under a percentile
  heading.
- **All models combines only the engines that report the metric**, and says so
  when that is not all of them. An engine with no request count cannot enter a
  request-weighted latency mean.
- **Adding or splitting a metric group is a metrics-contract change**, with the
  usual five places to update.
