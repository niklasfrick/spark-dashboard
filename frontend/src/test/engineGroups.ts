/**
 * The metric-group lists real engine types declare, shared by the specs that
 * hand a panel or the aggregate an engine of that shape (ADR-0004). Not a spec
 * itself: vitest only collects `*.test.*`.
 */

import { METRIC_GROUPS, type MetricGroup } from '@/types/metrics'

/** What an SGLang engine reports (#129): everything but TPOT, batch size and
 *  preemptions, which it has no counter for. */
export const SGLANG_GROUPS: MetricGroup[] = METRIC_GROUPS.filter(
  (group) => !['TpotMean', 'TpotPercentiles', 'BatchSize', 'Preemptions'].includes(group),
)

/** What a llama.cpp server reports (#131): throughput, the requests in flight,
 *  speculative decoding and the mean inter-token latency, in wire order. */
export const LLAMA_CPP_GROUPS: MetricGroup[] = [
  'Throughput',
  'ActiveRequests',
  'SpeculativeDecoding',
  'ItlMean',
]

/** What a TensorFold engine reports: every group but `QueueTime`, `ItlMean`
 *  and `ItlPercentiles` — it keeps no queue-wait histogram and no separate
 *  inter-token histogram. ADR-0004: this is only the shape of the declaration
 *  a spec hands the frontend, not a table the frontend itself keeps; it is the
 *  wire order of METRIC_GROUPS, filtered. */
export const TENSORFOLD_GROUPS: MetricGroup[] = METRIC_GROUPS.filter(
  (group) => !['QueueTime', 'ItlMean', 'ItlPercentiles'].includes(group),
)
