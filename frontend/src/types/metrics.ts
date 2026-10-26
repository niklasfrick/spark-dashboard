export interface MetricsSnapshot {
  timestamp_ms: number
  gpu: GpuMetrics
  gpus?: GpuMetrics[]
  cpu: CpuMetrics
  memory: MemoryMetrics
  disk: DiskMetrics
  network: NetworkMetrics
  engines: EngineSnapshot[]
  gpu_events: GpuEventData[]
}

/** Wire-format GPU event matching backend GpuEvent struct */
export interface GpuEventData {
  timestamp_ms: number
  gpu_index?: number | null
  event_type: string
  detail: string
}

/** Wire-format per-request inference metrics matching backend RecentRequest struct */
export interface InferenceRequestData {
  start_ms: number
  end_ms: number
  tokens_per_sec: number
  ttft_ms: number
}

export interface GpuMetrics {
  index?: number | null
  name: string | null
  utilization_percent: number | null
  memory_total_bytes?: number | null
  memory_used_bytes?: number | null
  temperature_celsius: number | null
  power_watts: number | null
  power_limit_watts: number | null
  clock_graphics_mhz: number | null
  clock_sm_mhz: number | null
  clock_memory_mhz: number | null
  fan_speed_percent: number | null
  /** PCIe throughput in bytes/sec, the unit the disk and network rates use.
   *  Both null on a GPU with no PCIe link to report (unified-memory SoCs). */
  pcie_rx_bytes_per_sec: number | null
  pcie_tx_bytes_per_sec: number | null
}

export interface CpuMetrics {
  name: string | null
  aggregate_percent: number
  per_core: CoreMetrics[]
}

export interface CoreMetrics {
  id: number
  usage_percent: number
}

export interface MemoryMetrics {
  total_bytes: number
  /** Headline pool size for the UI. On unified-memory systems this is sourced
   *  from NVML so the marketed capacity (e.g. 128 GB on DGX Spark) is shown
   *  instead of the kernel-visible total which excludes firmware carve-outs. */
  display_total_bytes?: number
  used_bytes: number
  available_bytes: number
  cached_bytes: number
  gpu_estimated_bytes: number | null
  gpu_memory_total_bytes: number | null
  gpu_memory_used_bytes: number | null
  is_unified: boolean
}

export interface DiskMetrics {
  name: string | null
  read_bytes_per_sec: number
  write_bytes_per_sec: number
}

export interface NetworkMetrics {
  name: string | null
  rx_bytes_per_sec: number
  tx_bytes_per_sec: number
}

// --- LLM Engine Types (Phase 2) ---

export type EngineType = 'Vllm' | 'Sglang' | 'Ollama' | 'LlamaCpp' | 'Tensorfold'

export type DeploymentMode = 'Docker' | 'Native'

export type EngineStatus =
  | { type: 'Running' }
  | { type: 'Loading' }
  | { type: 'Stopped' }
  | { type: 'Error'; message: string }

/**
 * Every metric group, in wire order — the one list the frontend holds. A
 * metric group is a set of engine metrics an engine reports together or not
 * at all (ADR-0004); each engine says on its snapshot which it reports. The
 * names mirror the backend's `MetricGroup` enum, whose spec pins them.
 */
export const METRIC_GROUPS = [
  'Throughput',
  'BatchSize',
  'ActiveRequests',
  'RequestTotal',
  'Preemptions',
  'QueueTime',
  'KvCache',
  'PrefixCache',
  'SpeculativeDecoding',
  'TtftMean',
  'TtftPercentiles',
  'E2eMean',
  'E2ePercentiles',
  'ItlMean',
  'ItlPercentiles',
  'TpotMean',
  'TpotPercentiles',
] as const

export type MetricGroup = (typeof METRIC_GROUPS)[number]

/** Why model metadata could not be read from the engine's `/v1/models`
 *  endpoint. `AuthRequired` means the request was rejected as unauthorized
 *  (401/403) — the dashboard lacks the engine's API key; `Unavailable`
 *  covers every non-auth cause (unreachable, error status, empty list). */
export type ModelMetadataError = 'AuthRequired' | 'Unavailable'

/** Why a running engine's metrics endpoint answered without metrics.
 *  `AuthRequired` means it refused the dashboard (401/403) —
 *  the dashboard lacks the engine's API key, the same cause and remedy as
 *  `ModelMetadataError`'s, and not metrics off: no launch flag fixes it. */
export type MetricsError = 'AuthRequired'

export interface ModelInfo {
  name: string
  parameter_size: string | null
  quantization: string | null
  precision: string | null
  tensor_type: string | null
  model_type: string | null
  pipeline_tag: string | null
}

/** One model an engine that loads models on demand (Ollama) holds in memory
 *  now, as the engine's own API describes it. Matches the backend's
 *  `LoadedModel` struct field for field. */
export interface LoadedModel {
  /** The engine's name for the model, tag included: `tinyllama:latest`,
   *  `hf.co/Qwen/Qwen3-8B-GGUF:Q4_K_M`. */
  name: string
  /** Parameter count as the engine words it (`1B`); null when it does not say. */
  parameter_size: string | null
  /** Quantization level (`Q4_0`); null when the engine does not say. */
  quantization: string | null
  /** Memory the loaded model occupies, in bytes. */
  size_bytes: number
  /** The part of `size_bytes` resident in GPU memory — less than it when the
   *  engine offloaded layers to the CPU. */
  vram_bytes: number
  /** Context window the model was loaded with, in tokens; null when unknown. */
  context_length: number | null
  /** When the engine unloads the model if it stays idle, RFC 3339 as the
   *  engine served it; null when it does not say. */
  expires_at: string | null
}

/** Tail-latency percentiles in milliseconds, derived from a Prometheus
 *  histogram on the backend. Any quantile may be null when there is not
 *  yet enough data to interpolate. */
export interface LatencyPercentiles {
  p50_ms: number | null
  p95_ms: number | null
  p99_ms: number | null
}

/** One Prometheus histogram bucket as shipped by the backend. The
 *  frontend uses these to recompute goodput at user-customized SLO
 *  thresholds. The backend replaces `+Inf` with `Number.MAX_VALUE`
 *  (Rust `f64::MAX`) so the wire format stays valid JSON. */
export interface HistogramBucket {
  le_seconds: number
  cumulative_count: number
}

export interface EngineMetrics {
  tokens_per_sec: number | null
  avg_tokens_per_sec: number | null
  per_request_tps: number | null
  ttft_ms: number | null
  active_requests: number | null
  queued_requests: number | null
  kv_cache_percent: number | null
  kv_cache_is_estimated: boolean
  total_requests: number | null
  // --- New metrics ---
  e2e_latency_ms: number | null
  prompt_tokens_per_sec: number | null
  avg_prompt_tokens_per_sec: number | null
  per_request_prompt_tps: number | null
  swapped_requests: number | null
  prefix_cache_hit_rate: number | null
  queue_time_ms: number | null
  inter_token_latency_ms: number | null
  preemptions_total: number | null
  /** Cumulative prompt (prefill) tokens processed since engine start. */
  total_prompt_tokens: number | null
  /** Cumulative generation (decode) tokens produced since engine start. */
  total_generation_tokens: number | null
  /** Cumulative count of prefix-cache token queries since engine start. */
  prefix_cache_queries_total: number | null
  avg_batch_size: number | null
  ttft_percentiles: LatencyPercentiles | null
  itl_percentiles: LatencyPercentiles | null
  e2e_percentiles: LatencyPercentiles | null
  /** % of TTFT observations meeting the TTFT SLO threshold. */
  ttft_goodput_pct: number | null
  /** % of ITL observations meeting the ITL SLO threshold. */
  itl_goodput_pct: number | null
  /** % of E2E observations meeting the E2E SLO threshold. */
  e2e_goodput_pct: number | null
  /** Raw TTFT histogram buckets. Used by the frontend to recompute
   *  goodput at user-customized SLO thresholds. Null while warming up
   *  or when the engine hasn't emitted the histogram yet. */
  ttft_buckets: HistogramBucket[] | null
  /** Raw ITL histogram buckets (cumulative). */
  itl_buckets: HistogramBucket[] | null
  /** Raw E2E histogram buckets (cumulative). */
  e2e_buckets: HistogramBucket[] | null
  /** Average time per output token during decode (ms) — the gap between
   *  generating each subsequent token, excluding TTFT. */
  tpot_ms: number | null
  /** Tail latency percentiles for time per output token (ms). */
  tpot_percentiles: LatencyPercentiles | null
  /** % of TPOT observations meeting the TPOT SLO threshold. */
  tpot_goodput_pct: number | null
  /** Raw TPOT histogram buckets (cumulative). */
  tpot_buckets: HistogramBucket[] | null

  // --- Speculative decoding ---
  // Populated only when the served model has speculative decoding configured
  // (vLLM emits `vllm:spec_decode_*` only then). When all are null the UI hides
  // the speculative-decoding section entirely.
  /** Cumulative speculatively-generated (draft) tokens. Counts up over the engine's life. */
  spec_decode_draft_tokens_total: number | null
  /** Cumulative draft tokens that passed verification. Counts up. */
  spec_decode_accepted_tokens_total: number | null
  /** Cumulative number of speculative-decode draft attempts. */
  spec_decode_drafts_total: number | null
  /** Lifetime token acceptance rate (TAR), percentage: accepted/draft*100. */
  spec_decode_acceptance_rate: number | null
  /** Live (windowed) TAR from per-poll deltas, percentage. Fluctuates with recent traffic. */
  spec_decode_acceptance_rate_live: number | null
  /** Mean accepted tokens per draft attempt: accepted/drafts. */
  spec_decode_mean_acceptance_length: number | null
}

export interface EngineSnapshot {
  engine_type: EngineType
  endpoint: string
  status: EngineStatus
  model: ModelInfo | null
  /** The models the engine holds now, sorted by name — set by an engine type
   *  that loads models on demand and can hold several (Ollama), whose `model`
   *  is then always null: this list is the only truth. Empty is an idle
   *  engine, still running. Null for a single-model engine type, which is
   *  named by `model` as before — optional so snapshots from older backends
   *  still parse, absent meaning the same. */
  loaded_models?: LoadedModel[] | null
  /** Why `model` is missing or only a command-line fallback. Null when
   *  metadata resolved normally — optional so snapshots from older backends
   *  still parse. */
  model_metadata_error?: ModelMetadataError | null
  /** The metric groups this engine reports, as its backend adapter declares
   *  them. An empty list is an engine reporting nothing. Absent only from a
   *  backend older than the field, which reported every group — so read it
   *  through `reportedMetricGroups`, which says so, rather than directly. */
  metric_groups?: MetricGroup[]
  /** Set while a running engine's metrics endpoint is off; carries the launch
   *  flag that turns it on. Such an engine has `metrics: null`. Written by a
   *  backend newer than this field (#141) — optional so older snapshots parse. */
  metrics_off?: string | null
  /** Set while a running engine's metrics endpoint refuses the dashboard — for
   *  want of its API key — so the panels name the key to configure rather than
   *  a launch flag. Such an engine has `metrics: null`. Optional so snapshots
   *  from backends older than the field (#131) still parse. */
  metrics_error?: MetricsError | null
  metrics: EngineMetrics | null
  recent_requests: InferenceRequestData[]
  deployment_mode: DeploymentMode
  /** Indexes of the GPU(s) the engine was observed running on (NVML
   *  compute-process match on the backend). Empty = unknown; the UI shows
   *  the badge only on multi-GPU hosts. The backend always serializes the
   *  field — optional only so snapshots from older backends still parse. */
  gpu_indexes?: number[]
}
