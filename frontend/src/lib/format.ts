import type { GroupCoverage } from '@/lib/engineAggregate'
import type { EngineIdentity } from '@/lib/identity'
import type {
  EngineSnapshot,
  EngineType,
  LoadedModel,
  MetricGroup,
  ModelMetadataError,
} from '@/types/metrics'

const KIB = 1024
const MIB = 1024 * 1024
const GIB = 1024 * 1024 * 1024

/** Format bytes to human-readable with auto-scaling: KB (<1MB), MB (<1GB), GB (>=1GB).
 *  Uses binary scaling (1024) under the conventional "GB" labels, matching `free -h`,
 *  `htop`, macOS, and Windows. */
export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MB`
  return `${(bytes / KIB).toFixed(1)} KB`
}

/** Format bytes as binary GiB, labelled "GB" to match OS conventions. Used
 *  where a whole pool is named rather than a rate — the memory panel's caption. */
export function formatGiB(bytes: number, decimals = 0): string {
  return `${(bytes / GIB).toFixed(decimals)} GB`
}

/** Format bytes/sec to human-readable rate string */
export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

/** Format watts with one decimal */
export function formatWatts(watts: number): string {
  return `${watts.toFixed(1)} W`
}

/** Format power as "current / limit W" */
export function formatPower(current: number | null, limit: number | null): string {
  if (current === null) return 'N/A'
  const currentStr = `${current.toFixed(1)} W`
  if (limit === null) return currentStr
  return `${current.toFixed(1)} W / ${limit.toFixed(1)} W`
}

/** Format temperature as integer with " C" suffix */
export function formatTemp(celsius: number | null): string {
  if (celsius === null) return 'N/A'
  return `${Math.round(celsius)} C`
}

/** Format percentage as integer with "%" suffix */
export function formatPercent(value: number | null): string {
  if (value === null) return 'N/A'
  return `${Math.round(value)}%`
}

/** Format clock speed as integer with " MHz" suffix */
export function formatMhz(mhz: number | null): string {
  if (mhz === null) return 'N/A'
  return `${Math.round(mhz)} MHz`
}

/**
 * How long before `now` something happened, as the coarsest unit that still
 * says it: `12s`, `3m`, `2h`.
 *
 * An age rather than a wall-clock time, because that is the question an
 * operator is asking of a live dashboard — and because a clock time would have
 * to be read against the viewer's own timezone, which the rest of the metrics
 * on the page are free of. Anything not yet in the past reads as `0s`.
 */
export function formatAge(timestampMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

/** Get temperature color class: green <70, yellow 70-85, red >85 */
export function tempColor(celsius: number | null): string {
  if (celsius === null) return 'text-zinc-500'
  if (celsius >= 85) return 'text-red-500'
  if (celsius >= 70) return 'text-yellow-500'
  return 'text-green-500'
}

// --- LLM Engine Formatting Functions (Phase 2) ---

/** Format tokens per second: one decimal place. Null -> 'N/A'. Per UI-SPEC: unit is "tok/s" */
export function formatTps(tps: number | null): string {
  if (tps === null) return 'N/A'
  return tps.toFixed(1)
}

/** Format time to first token in milliseconds: integer. Null -> 'N/A'. Per UI-SPEC: unit is "ms" */
export function formatTtft(ms: number | null): string {
  if (ms === null) return 'N/A'
  return Math.round(ms).toString()
}

/** Auto-scale a duration given in ms to the most readable unit. Returns { value, unit }. */
export function formatDurationMs(ms: number | null): { value: string; unit: string } {
  if (ms === null) return { value: 'N/A', unit: '' }
  if (ms >= 60_000) return { value: (ms / 60_000).toFixed(1), unit: 'min' }
  if (ms >= 1_000) return { value: (ms / 1_000).toFixed(2), unit: 's' }
  return { value: Math.round(ms).toString(), unit: 'ms' }
}

/** Format the value portion of an auto-scaled duration (for BigNumberSparkline format prop). */
export function formatDurationValue(ms: number): string {
  return formatDurationMs(ms).value
}

/** Get the unit string for an auto-scaled duration. */
export function formatDurationUnit(ms: number | null): string {
  return formatDurationMs(ms).unit
}

/** Format request counts: "3 active / 1 queued". Both null -> 'N/A'. Per UI-SPEC. */
export function formatRequests(active: number | null, queued: number | null): string {
  if (active === null && queued === null) return 'N/A'
  const parts: string[] = []
  if (active !== null) parts.push(`${active} active`)
  if (queued !== null) parts.push(`${queued} queued`)
  return parts.join(' / ')
}

/** Format KV cache percentage: integer with %. Null -> 'N/A'. Per UI-SPEC. */
export function formatKvCache(percent: number | null): string {
  if (percent === null) return 'N/A'
  return `${Math.round(percent)}%`
}

/** Abbreviate a large cumulative count: 950 -> "950", 1234 -> "1.2K",
 *  3.4e9 -> "3.4B". One decimal above 1000, trailing ".0" trimmed.
 *  Null/negative -> '--'. Used for lifetime token totals. */
export function formatCompactTokens(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n < 0) return '--'
  if (n < 1000) return String(Math.round(n))
  const units = [
    { value: 1e12, suffix: 'T' },
    { value: 1e9, suffix: 'B' },
    { value: 1e6, suffix: 'M' },
    { value: 1e3, suffix: 'K' },
  ]
  const unit = units.find(u => n >= u.value)
  if (!unit) return String(Math.round(n))
  const scaled = n / unit.value
  const text = scaled.toFixed(1).replace(/\.0$/, '')
  return `${text}${unit.suffix}`
}

/** Format mean acceptance length (accepted tokens per draft attempt): two
 *  decimals, e.g. "3.42". Null/non-finite/negative -> '--'. */
export function formatAcceptanceLength(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n < 0) return '--'
  return n.toFixed(2)
}

/** Label for an engine's GPU chip: "GPU 0", or "GPU 0+1" when the engine spans
 *  several GPUs (tensor parallel). Empty string when no indexes are known —
 *  callers omit the chip entirely in that case. */
export function formatGpuIndexes(indexes: number[]): string {
  if (indexes.length === 0) return ''
  return `GPU ${indexes.join('+')}`
}

/** Map EngineType enum to human-readable display name. */
export function engineDisplayName(engineType: EngineType): string {
  const names: Record<EngineType, string> = {
    Vllm: 'vLLM',
    Sglang: 'SGLang',
    Ollama: 'Ollama',
    LlamaCpp: 'llama.cpp',
    Tensorfold: 'TensorFold',
  }
  return names[engineType]
}

/** The engine type's icon, beside its name in the status chip. Every engine
 *  type in the union must have one — the record is exhaustive by typing. */
export function engineIconPath(engineType: EngineType): string {
  const icons: Record<EngineType, string> = {
    Vllm: '/icons/vllm.svg',
    Sglang: '/icons/sglang.svg',
    Ollama: '/icons/ollama.svg',
    LlamaCpp: '/icons/llamacpp.svg',
    Tensorfold: '/icons/tensorfold.svg',
  }
  return icons[engineType]
}

/**
 * The readable half of an engine endpoint — `host:port`, without the scheme or
 * any path. Falls back to the endpoint as stored when it does not parse as a
 * URL, because the operator has to be able to match it against what they
 * configured.
 */
export function formatEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).host || endpoint
  } catch {
    return endpoint
  }
}

/**
 * How an engine reads in a panel label or a placeholder: its provider plus the
 * host and port of the instance. Both halves are needed — a machine can run
 * several engines of the same provider, which is exactly when a panel has to say
 * which one it is showing.
 */
export function engineDescription(engine: EngineIdentity): string {
  return `${engineDisplayName(engine.engine_type)} ${formatEndpoint(engine.endpoint)}`
}

/** What a tile shows in place of a figure its engine does not report. */
export const NOT_REPORTED = 'not reported'

/**
 * Each metric group as it reads in a sentence — the glossary's own words, so
 * the placeholder an operator reads and the term the project uses agree.
 */
const METRIC_GROUP_NAMES: Record<MetricGroup, string> = {
  Throughput: 'throughput',
  BatchSize: 'batch size',
  ActiveRequests: 'active requests',
  RequestTotal: 'request total',
  Preemptions: 'preemptions',
  QueueTime: 'queue time',
  KvCache: 'KV cache',
  PrefixCache: 'prefix cache',
  SpeculativeDecoding: 'speculative decoding',
  TtftMean: 'TTFT mean',
  TtftPercentiles: 'TTFT percentiles',
  E2eMean: 'E2E mean',
  E2ePercentiles: 'E2E percentiles',
  ItlMean: 'ITL mean',
  ItlPercentiles: 'ITL percentiles',
  TpotMean: 'TPOT mean',
  TpotPercentiles: 'TPOT percentiles',
}

/** A metric group as it reads in running text: "latency percentiles". */
export function metricGroupName(group: MetricGroup): string {
  return METRIC_GROUP_NAMES[group]
}

/** The families of groups that read as one in a sentence: the four latency
 *  means, the four latency percentiles, and the two request groups. */
type PhraseFamily = 'latency means' | 'latency percentiles' | 'requests'

/** Which family each group belongs to, if any. Exhaustive over `MetricGroup`,
 *  so a new group fails `tsc` until it is placed. */
const PHRASE_FAMILY = {
  Throughput: null,
  ActiveRequests: 'requests',
  RequestTotal: 'requests',
  Preemptions: null,
  BatchSize: null,
  QueueTime: null,
  KvCache: null,
  PrefixCache: null,
  SpeculativeDecoding: null,
  TtftMean: 'latency means',
  TtftPercentiles: 'latency percentiles',
  E2eMean: 'latency means',
  E2ePercentiles: 'latency percentiles',
  ItlMean: 'latency means',
  ItlPercentiles: 'latency percentiles',
  TpotMean: 'latency means',
  TpotPercentiles: 'latency percentiles',
} as const satisfies Record<MetricGroup, PhraseFamily | null>

/**
 * The groups a panel shows, as a placeholder says them: a family collapses —
 * the means to "latency means", the percentiles to "latency percentiles", the
 * two request groups to "requests" — only when two or more of its members are
 * listed. A lone member, and every other group, goes by its own name. Repeats
 * are dropped, keeping the first appearance, and the phrases are joined as
 * alternatives ("throughput or TTFT mean").
 */
export function metricGroupsPhrase(groups: readonly MetricGroup[]): string {
  const members = (family: PhraseFamily) =>
    groups.filter(group => PHRASE_FAMILY[group] === family).length
  const phrases = groups.map(group => {
    const family = PHRASE_FAMILY[group]
    return family !== null && members(family) >= 2 ? family : metricGroupName(group)
  })
  return listOfAlternatives([...new Set(phrases)])
}

/**
 * What a panel says when the engine it is bound to reports none of the metric
 * groups it shows: "llama.cpp localhost:8080 does not report KV cache or prefix
 * cache." The engine is named by type and endpoint, like every other engine
 * placeholder, so the operator knows whose limitation it is — and it reads as
 * a property of the engine, not as data that has yet to arrive.
 */
export function notReportedMessage(
  engine: EngineIdentity,
  groups: readonly MetricGroup[],
): string {
  return `${engineDescription(engine)} does not report ${metricGroupsPhrase(groups)}.`
}

/** What an all-models panel says when no running engine reports any of its groups:
 *  "No running engine reports KV cache or prefix cache." The all-models
 *  counterpart of `notReportedMessage` — a property of the host's engines, not
 *  data that has yet to arrive. */
export function notReportedByAnyMessage(groups: readonly MetricGroup[]): string {
  return `No running engine reports ${metricGroupsPhrase(groups)}.`
}

/** How many engines a panel's combined figures cover, when not all of them:
 *  null when every group covers every running engine; "2 of 3 engines" when every
 *  group covers the same subset; otherwise per group —
 *  "KV cache 2 of 3, prefix cache 1 of 3 engines". The per-group form names
 *  every group the panel combines, the complete ones too, so no figure's count
 *  is left to inference. */
export function coverageNote(coverage: GroupCoverage): string | null {
  const { running, groups } = coverage
  if (groups.every(({ included }) => included === running)) return null

  const [first] = groups
  if (groups.every(({ included }) => included === first.included)) {
    return `${first.included} of ${running} engines`
  }

  const perGroup = groups
    .map(({ group, included }) => `${metricGroupName(group)} ${included} of ${running}`)
    .join(', ')
  // A caption stands alone, so it starts as a sentence: "Throughput 3 of 3, …".
  return `${perGroup.charAt(0).toUpperCase()}${perGroup.slice(1)} engines`
}

/**
 * What a panel says when the engine runs with its metrics endpoint switched
 * off by a launch flag: not "does not report" (the metrics exist — the engine
 * was just started without the flag that publishes them) and not "not yet"
 * (no traffic will fix it). Names the flag so the fix is copy-pasteable.
 */
export function metricsOffMessage(engine: EngineIdentity, flag: string): string {
  return `${engineDescription(engine)} is running with metrics off — relaunch it with ${flag}.`
}

/**
 * What a panel says when the engine's metrics endpoint refused the dashboard
 * for want of the engine's API key. The same refusal, and the same remedy, as
 * `modelMetadataWarning` gives for a refused `/v1/models` — configure the
 * provider API key — said of the metrics, and naming the engine the way every
 * other panel notice does. Not `metricsOffMessage`: the engine publishes its
 * metrics, and relaunching it with a flag would change nothing.
 */
export function metricsRefusedMessage(engine: EngineIdentity): string {
  return `${engineDescription(engine)} requires authentication — configure the provider API key to read its metrics.`
}

/** "a", "a or b", "a, b or c" — the list a negated verb ranges over. */
function listOfAlternatives(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
}

/**
 * Strip the `Organization/` prefix off a HuggingFace-style id, leaving the
 * model itself: `Qwen/Qwen3-8B` reads as `Qwen3-8B`. Used wherever the
 * organization is already said by a provider mark or does not matter, so the
 * width a long model id needs is not spent twice.
 */
export function shortModelName(name: string): string {
  return name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
}

/** What an engine with no model loaded reads as, where its model would be named. */
export const NO_MODEL_LOADED = 'No model loaded'

/**
 * The model an engine is named by, wherever the UI names one by its model: the
 * page source choices, a panel's identity row, the Engine panel's headline.
 *
 * A single-model engine type (`loaded_models` absent or null) is named by its
 * `model`, without the organization prefix — and is null without one, because
 * each caller words that absence its own way. An engine that loads models on
 * demand (Ollama) is named by the list it holds now, which the backend sorts by
 * name so the label does not jump between snapshots: nothing loaded is
 * `No model loaded` — an idle engine, not a missing name — one model is that
 * model's name, and several are the first and how many more.
 */
export function engineModelLabel(
  engine: Pick<EngineSnapshot, 'model' | 'loaded_models'>,
): string | null {
  const loaded = engine.loaded_models
  if (loaded == null) return engine.model?.name ? shortModelName(engine.model.name) : null
  if (loaded.length === 0) return NO_MODEL_LOADED
  const first = shortModelName(loaded[0].name)
  return loaded.length === 1 ? first : `${first} +${loaded.length - 1} more`
}

/**
 * How much memory a loaded model occupies: its size, and — when the engine
 * offloaded part of it to the CPU — how much of that is in VRAM, since that is
 * the half that decides how fast it runs. A model wholly in VRAM reads as its
 * size alone.
 */
export function formatLoadedModelSize(model: Pick<LoadedModel, 'size_bytes' | 'vram_bytes'>): string {
  const size = formatBytes(model.size_bytes)
  return model.vram_bytes === model.size_bytes
    ? size
    : `${size} (${formatBytes(model.vram_bytes)} VRAM)`
}

/**
 * A loaded model's context window as the chip beside its size: tokens in
 * binary thousands, the way context windows are named (2048 -> "2K ctx",
 * 131072 -> "128K ctx"), one decimal when not a whole number. Null -> null, so
 * the caller omits the chip.
 */
export function formatContextLength(tokens: number | null): string | null {
  if (tokens === null || !Number.isFinite(tokens) || tokens <= 0) return null
  if (tokens < 1024) return `${Math.round(tokens)} ctx`
  const thousands = (tokens / 1024).toFixed(1).replace(/\.0$/, '')
  return `${thousands}K ctx`
}

/**
 * When the engine will unload a model, for a tooltip: the absolute clock time
 * in the viewer's locale and time zone, "Unloads at 10:54". Absolute rather
 * than a countdown so it never ticks. Null, or a time that does not parse ->
 * null, so the caller sets no tooltip.
 */
export function formatUnloadTime(expiresAt: string | null): string | null {
  if (expiresAt === null) return null
  const at = new Date(expiresAt)
  if (Number.isNaN(at.getTime())) return null
  return `Unloads at ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

/**
 * Why the model name beside this warning may be wrong, in words an operator
 * can act on. Only the authentication rejection gets one: it is the failure
 * fixed on the dashboard's side (configure a provider API key), and telling
 * an operator to configure a key for an engine that is merely unreachable
 * would send them fixing the wrong thing. Null means nothing to warn about —
 * metadata resolved, the engine is merely down (its status already says so),
 * or an older backend that does not report the field.
 */
export function modelMetadataWarning(
  error: ModelMetadataError | null | undefined,
): string | null {
  if (error !== 'AuthRequired') return null
  return 'Engine requires authentication — configure the provider API key to read the model name.'
}

/** Apply a formatter to a nullable metric, rendering '--' when absent.
 *  The engine tiles' universal "no data yet" placeholder. */
export function fmtVal(v: number | null, fmt: (n: number) => string): string {
  return v === null ? '--' : fmt(v)
}

/** Render a nullable metric as a rounded integer, '--' when absent. */
export function fmtInt(v: number | null): string {
  return v === null ? '--' : String(Math.round(v))
}
