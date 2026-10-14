# Engines declare what they report on the metrics contract

**Status:** accepted (2026-10); amended (2026-10, #142): see [The grain is the
tile](#amendment-the-grain-is-the-tile-142)

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

## Amendment: the grain is the tile (#142)

The eight groups first declared were too coarse:
- SGLang reports every latency except time per output token, and has no batch
  size, preemption or swap counter.
- llama.cpp reports only the mean inter-token latency, and no request total.

A field of a reported group left `null` reads `--`, which says "not yet"
again.

**Groups are split until each is all-or-nothing on every engine type, and the
cuts fall where the panels cut tiles.** There are seventeen:
- `Throughput`, `BatchSize`, `ActiveRequests`, `RequestTotal`, `Preemptions`,
  `QueueTime`, `KvCache`, `PrefixCache` and `SpeculativeDecoding`;
- `TtftMean`, `TtftPercentiles`, `E2eMean`, `E2ePercentiles`, `ItlMean`,
  `ItlPercentiles`, `TpotMean` and `TpotPercentiles`.

A rate derived from a latency moves with that latency's mean: per-request
decode throughput with TPOT, and per-request prefill throughput with TTFT. A
percentiles group carries its histogram buckets and the SLO goodput read off
them.

**A tile whose group is not reported keeps its slot and says so, muted, instead
of being left out.** If tiles came and went, a panel's layout would move every
time engine rotation changed the engine. The panel-level placeholder keeps its
slot for the same reason.

**All models combines at this grain** (#130): a figure combines only the
engines that report its group.

### Considered options

- **Per-field exceptions on the coarse groups.** An engine would declare a group
  and list the fields in it that it does not report. Rejected because it is a
  second mechanism, and "reports the group, except…" is no longer what a group
  is.
- **Latency as dimension groups crossed with statistic groups.** That is TTFT,
  E2E, ITL and TPOT crossed with means and percentiles: six groups instead of
  eight. Rejected for two reasons:
  - Its groups would be factors rather than sets of metrics. A figure would be
    reported only when two groups both are.
  - It assumes an engine reports the same statistics for every latency it has,
    and nothing guarantees that.
