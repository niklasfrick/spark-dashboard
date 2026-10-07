/**
 * Which KPI groups a single engine genuinely cannot provide.
 *
 * The distinction that matters is between a value that is **not available yet**
 * (warming up, no traffic) and a value the engine **cannot** produce. The first
 * reads as a dash — that is honest. The second, dashed, reads as a fault; a
 * panel of all-dashes under a working engine makes an operator hunt for a bug
 * that is not there. Genuinely absent groups are hidden instead.
 *
 * vLLM ships every group here. llama.cpp exposes no latency histograms, no
 * KV-cache usage gauge and no queue-time metric, so those four are hidden for
 * it. Everything else — throughput, concurrency, token totals, the derived mean
 * latencies, prefix cache, speculative decoding — it can fill, so it is not
 * gated.
 */

import type { EngineType } from '@/types/metrics'

export type EngineCapability =
  | 'kvCache'
  | 'goodput'
  | 'queueTime'
  | 'latencyPercentiles'

const UNSUPPORTED: Record<EngineType, ReadonlySet<EngineCapability>> = {
  Vllm: new Set(),
  LlamaCpp: new Set<EngineCapability>(['kvCache', 'goodput', 'queueTime', 'latencyPercentiles']),
}

/**
 * Whether `engineType` can supply `capability`.
 *
 * `null` — the all-engines aggregate, or a type this build does not know —
 * assumes full support. An aggregate is the union of its members (if any one
 * can supply a group the all-models view shows it), and a future engine type
 * must never blank a panel it might fill.
 */
export function supportsCapability(
  engineType: EngineType | null,
  capability: EngineCapability,
): boolean {
  if (engineType === null) return true
  return !UNSUPPORTED[engineType].has(capability)
}
