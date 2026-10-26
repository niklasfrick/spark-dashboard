import { describe, it, expect } from 'vitest'
import {
  coverageNote,
  formatAge,
  formatBytes,
  formatCompactTokens,
  formatContextLength,
  formatAcceptanceLength,
  formatEndpoint,
  engineDescription,
  engineDisplayName,
  engineIconPath,
  engineModelLabel,
  formatLoadedModelSize,
  formatUnloadTime,
  metricGroupName,
  metricGroupsPhrase,
  metricsRefusedMessage,
  modelMetadataWarning,
  NOT_REPORTED,
  notReportedByAnyMessage,
  notReportedMessage,
} from '../lib/format'
import { HF_QWEN, TINYLLAMA, ollamaEngine } from '../test/ollama'
import { METRIC_GROUPS, type ModelInfo } from '../types/metrics'

const GIB = 1_073_741_824
const MIB = 1_048_576

describe('formatBytes', () => {
  it('uses binary GiB under the "GB" label', () => {
    expect(formatBytes(2 * GIB)).toBe('2.0 GB')
  })

  it('uses binary MiB under the "MB" label', () => {
    expect(formatBytes(5 * MIB)).toBe('5.0 MB')
  })

  it('falls back to KB below 1 MiB', () => {
    expect(formatBytes(2048)).toBe('2.0 KB')
  })
})

describe('formatCompactTokens', () => {
  it('renders -- for null, negative, or non-finite', () => {
    expect(formatCompactTokens(null)).toBe('--')
    expect(formatCompactTokens(-5)).toBe('--')
    expect(formatCompactTokens(Number.NaN)).toBe('--')
  })

  it('shows raw integers below 1000', () => {
    expect(formatCompactTokens(0)).toBe('0')
    expect(formatCompactTokens(999)).toBe('999')
    expect(formatCompactTokens(999.6)).toBe('1000')
  })

  it('abbreviates with K/M/B/T and trims trailing .0', () => {
    expect(formatCompactTokens(1000)).toBe('1K')
    expect(formatCompactTokens(1234)).toBe('1.2K')
    expect(formatCompactTokens(1_000_000)).toBe('1M')
    expect(formatCompactTokens(1_250_000_000)).toBe('1.3B')
    expect(formatCompactTokens(3.4e12)).toBe('3.4T')
  })
})

describe('formatAcceptanceLength', () => {
  it('renders -- for null, negative, or non-finite', () => {
    expect(formatAcceptanceLength(null)).toBe('--')
    expect(formatAcceptanceLength(-1)).toBe('--')
    expect(formatAcceptanceLength(Number.NaN)).toBe('--')
    expect(formatAcceptanceLength(Number.POSITIVE_INFINITY)).toBe('--')
  })

  it('formats accepted-tokens-per-draft to two decimals', () => {
    expect(formatAcceptanceLength(3)).toBe('3.00')
    expect(formatAcceptanceLength(3.4167)).toBe('3.42')
    expect(formatAcceptanceLength(0)).toBe('0.00')
  })
})

describe('formatEndpoint', () => {
  it('keeps the host and port an operator configured', () => {
    expect(formatEndpoint('http://localhost:8000')).toBe('localhost:8000')
    expect(formatEndpoint('https://gpu-node-2.internal:8443/v1')).toBe('gpu-node-2.internal:8443')
  })

  it('keeps a default port that the URL leaves implicit', () => {
    // Two engines can differ only by scheme, so dropping the host would be
    // worse than showing no port.
    expect(formatEndpoint('http://localhost')).toBe('localhost')
  })

  it('falls back to the endpoint as stored when it is not a URL', () => {
    // The operator has to be able to match the label against their config,
    // whatever shape the endpoint came in.
    expect(formatEndpoint('localhost:8000')).toBe('localhost:8000')
    expect(formatEndpoint('')).toBe('')
  })
})

describe('formatAge', () => {
  it('reads in the coarsest unit that still says when', () => {
    expect(formatAge(59_000, 60_000)).toBe('1s')
    expect(formatAge(0, 59_000)).toBe('59s')
    expect(formatAge(0, 60_000)).toBe('1m')
    expect(formatAge(0, 59 * 60_000)).toBe('59m')
    expect(formatAge(0, 60 * 60_000)).toBe('1h')
  })

  it('rounds down, so nothing reads as older than it is', () => {
    expect(formatAge(0, 1999)).toBe('1s')
  })

  it('does not go negative on an event stamped past the newest sample', () => {
    // Snapshots coalesce, so an event can carry a timestamp the reference
    // reading has not caught up to yet.
    expect(formatAge(5000, 1000)).toBe('0s')
  })
})

describe('engineDescription', () => {
  it('names the provider and the instance', () => {
    // Both halves are needed: a host can run several engines of one provider,
    // which is exactly when a panel has to say which one it shows.
    expect(engineDescription({ engine_type: 'Vllm', endpoint: 'http://localhost:8001' })).toBe(
      'vLLM localhost:8001',
    )
  })
})

describe('engineDisplayName and engineIconPath', () => {
  it('names each engine type and points at its own icon', () => {
    expect(engineDisplayName('Vllm')).toBe('vLLM')
    expect(engineIconPath('Vllm')).toBe('/icons/vllm.svg')
    expect(engineDisplayName('Sglang')).toBe('SGLang')
    expect(engineIconPath('Sglang')).toBe('/icons/sglang.svg')
    expect(engineDisplayName('LlamaCpp')).toBe('llama.cpp')
    expect(engineIconPath('LlamaCpp')).toBe('/icons/llamacpp.svg')
    expect(engineDisplayName('Tensorfold')).toBe('TensorFold')
    expect(engineIconPath('Tensorfold')).toBe('/icons/tensorfold.svg')
  })

  it('names an Ollama engine and points at its own icon', () => {
    expect(engineDisplayName('Ollama')).toBe('Ollama')
    expect(engineIconPath('Ollama')).toBe('/icons/ollama.svg')
    expect(engineDescription({ engine_type: 'Ollama', endpoint: 'http://localhost:11434' })).toBe(
      'Ollama localhost:11434',
    )
  })
})

describe('engineModelLabel', () => {
  const served = (name: string): ModelInfo => ({
    name,
    parameter_size: null,
    quantization: null,
    precision: null,
    tensor_type: null,
    model_type: null,
    pipeline_tag: null,
  })

  it('names a single-model engine by its model, without the organization prefix', () => {
    expect(engineModelLabel({ model: served('Qwen/Qwen3-8B') })).toBe('Qwen3-8B')
    expect(engineModelLabel({ model: served('Qwen/Qwen3-8B'), loaded_models: null })).toBe(
      'Qwen3-8B',
    )
  })

  it('leaves the absence of a single-model engine’s model to the caller', () => {
    // Each place words it differently — the identity row omits it, the Engine
    // panel tells a refused name apart from none — so there is no one answer.
    expect(engineModelLabel({ model: null })).toBeNull()
    expect(engineModelLabel({ model: served('') })).toBeNull()
  })

  it('says an Ollama engine with nothing loaded has no model loaded', () => {
    expect(engineModelLabel(ollamaEngine([]))).toBe('No model loaded')
  })

  it('names an Ollama engine holding one model by that model', () => {
    expect(engineModelLabel(ollamaEngine([TINYLLAMA]))).toBe('tinyllama:latest')
    // The same treatment as a single-model engine's name: the organization
    // goes, the tag stays.
    expect(engineModelLabel(ollamaEngine([HF_QWEN]))).toBe('Qwen3-8B-GGUF:Q4_K_M')
  })

  it('names an Ollama engine holding several by the first and how many more', () => {
    expect(engineModelLabel(ollamaEngine([HF_QWEN, TINYLLAMA]))).toBe(
      'Qwen3-8B-GGUF:Q4_K_M +1 more',
    )
    expect(
      engineModelLabel(
        ollamaEngine([HF_QWEN, TINYLLAMA, { ...TINYLLAMA, name: 'tinyllama:q8' }]),
      ),
    ).toBe('Qwen3-8B-GGUF:Q4_K_M +2 more')
  })

  it('goes by the list, not by a model the snapshot also carries', () => {
    // The backend sends `model: null` beside a list; the list is the only truth.
    expect(engineModelLabel({ model: served('Qwen/Qwen3-8B'), loaded_models: [] })).toBe(
      'No model loaded',
    )
  })
})

describe('formatLoadedModelSize', () => {
  it('reads a model wholly in GPU memory as its size alone', () => {
    // The captured tinyllama: 800454656 bytes, all of it in VRAM.
    expect(formatLoadedModelSize(TINYLLAMA)).toBe('763.4 MB')
  })

  it('adds the VRAM share of a model partly offloaded to the CPU', () => {
    expect(formatLoadedModelSize(HF_QWEN)).toBe('6.0 GB (4.0 GB VRAM)')
  })
})

describe('formatContextLength', () => {
  it('names a window in binary thousands of tokens', () => {
    // The captured tinyllama's window.
    expect(formatContextLength(TINYLLAMA.context_length)).toBe('2K ctx')
    expect(formatContextLength(131072)).toBe('128K ctx')
    expect(formatContextLength(40960)).toBe('40K ctx')
  })

  it('keeps one decimal for a window that is not a whole number of K', () => {
    expect(formatContextLength(32000)).toBe('31.3K ctx')
  })

  it('counts a window under 1024 in tokens, and omits an unknown or empty one', () => {
    expect(formatContextLength(512)).toBe('512 ctx')
    expect(formatContextLength(null)).toBeNull()
    expect(formatContextLength(0)).toBeNull()
  })
})

describe('formatUnloadTime', () => {
  it('reads the unload time as the viewer\'s local clock time', () => {
    // The captured tinyllama's expiry; the expectation is derived from the same
    // instant so it holds in any time zone and locale.
    const clock = new Date('2026-10-16T10:54:20.322299928+02:00').toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })
    expect(formatUnloadTime(TINYLLAMA.expires_at)).toBe(`Unloads at ${clock}`)
  })

  it('gives nothing for an absent or unreadable time', () => {
    expect(formatUnloadTime(null)).toBeNull()
    expect(formatUnloadTime('not a time')).toBeNull()
  })
})

describe('modelMetadataWarning', () => {
  it('warns only on the auth rejection, which the operator can fix dashboard-side', () => {
    expect(modelMetadataWarning('AuthRequired')).toBe(
      'Engine requires authentication — configure the provider API key to read the model name.',
    )
  })

  it('stays silent for every non-auth reason', () => {
    // A merely unreachable /v1/models is already told by the engine status,
    // and a key would not help — warning here would send an operator fixing
    // the wrong thing. Absent covers older backends without the field.
    expect(modelMetadataWarning('Unavailable')).toBeNull()
    expect(modelMetadataWarning(null)).toBeNull()
    expect(modelMetadataWarning(undefined)).toBeNull()
  })
})

describe('metricsRefusedMessage', () => {
  it('names the engine and the remedy the model-name warning gives for the same refusal', () => {
    // The metrics endpoint refused the dashboard for want of the engine's key:
    // the same fix as a refused /v1/models — and not a launch flag, so not the
    // metrics-off wording either.
    expect(
      metricsRefusedMessage({ engine_type: 'Sglang', endpoint: 'http://localhost:30000' }),
    ).toBe(
      'SGLang localhost:30000 requires authentication — configure the provider API key to read its metrics.',
    )
  })
})

describe('NOT_REPORTED', () => {
  it('is the copy a tile shows for a figure its engine does not report', () => {
    expect(NOT_REPORTED).toBe('not reported')
  })
})

describe('metricGroupName', () => {
  it('names every group in the glossary’s words', () => {
    expect(METRIC_GROUPS.map(metricGroupName)).toEqual([
      'throughput',
      'batch size',
      'active requests',
      'request total',
      'preemptions',
      'queue time',
      'KV cache',
      'prefix cache',
      'speculative decoding',
      'TTFT mean',
      'TTFT percentiles',
      'E2E mean',
      'E2E percentiles',
      'ITL mean',
      'ITL percentiles',
      'TPOT mean',
      'TPOT percentiles',
    ])
  })
})

describe('metricGroupsPhrase', () => {
  it('collapses the four latency means into one phrase', () => {
    expect(metricGroupsPhrase(['TtftMean', 'E2eMean', 'ItlMean', 'TpotMean'])).toBe('latency means')
  })

  it('collapses the four latency percentiles into one phrase', () => {
    expect(
      metricGroupsPhrase(['TtftPercentiles', 'E2ePercentiles', 'ItlPercentiles', 'TpotPercentiles']),
    ).toBe('latency percentiles')
  })

  it('collapses the two request groups into "requests"', () => {
    expect(metricGroupsPhrase(['ActiveRequests', 'RequestTotal'])).toBe('requests')
  })

  it('names a lone mean, percentiles or request group on its own', () => {
    expect(metricGroupsPhrase(['TtftMean'])).toBe('TTFT mean')
    expect(metricGroupsPhrase(['E2ePercentiles'])).toBe('E2E percentiles')
    expect(metricGroupsPhrase(['ActiveRequests'])).toBe('active requests')
    expect(metricGroupsPhrase(['RequestTotal'])).toBe('request total')
  })

  it('collapses a family once two of its members are listed', () => {
    expect(metricGroupsPhrase(['TtftMean', 'ItlMean'])).toBe('latency means')
    expect(metricGroupsPhrase(['TtftPercentiles', 'TpotPercentiles'])).toBe('latency percentiles')
  })

  it('reads the prefill panel’s groups', () => {
    expect(metricGroupsPhrase(['Throughput', 'TtftMean'])).toBe('throughput or TTFT mean')
  })

  it('reads the decode panel’s groups', () => {
    expect(metricGroupsPhrase(['Throughput', 'TpotMean'])).toBe('throughput or TPOT mean')
  })

  it('reads the latency panel’s groups, in order of first appearance', () => {
    expect(
      metricGroupsPhrase([
        'TtftMean',
        'TtftPercentiles',
        'E2eMean',
        'E2ePercentiles',
        'ItlMean',
        'ItlPercentiles',
        'TpotMean',
        'TpotPercentiles',
        'QueueTime',
      ]),
    ).toBe('latency means, latency percentiles or queue time')
  })

  it('reads the requests panel’s groups', () => {
    expect(metricGroupsPhrase(['ActiveRequests', 'RequestTotal', 'Preemptions'])).toBe(
      'requests or preemptions',
    )
  })

  it('names a group that has no collapsed phrase as itself', () => {
    expect(metricGroupsPhrase(['BatchSize', 'KvCache'])).toBe('batch size or KV cache')
  })
})

describe('notReportedMessage', () => {
  const engine = { engine_type: 'Vllm' as const, endpoint: 'http://localhost:8080' }

  it('names the engine by type and endpoint, and the group it does not report', () => {
    expect(notReportedMessage(engine, ['SpeculativeDecoding'])).toBe(
      'vLLM localhost:8080 does not report speculative decoding.',
    )
  })

  it('lists several groups as alternatives the engine reports none of', () => {
    expect(notReportedMessage(engine, ['KvCache', 'PrefixCache'])).toBe(
      'vLLM localhost:8080 does not report KV cache or prefix cache.',
    )
    expect(notReportedMessage(engine, ['Throughput', 'TtftMean'])).toBe(
      'vLLM localhost:8080 does not report throughput or TTFT mean.',
    )
    expect(notReportedMessage(engine, ['ActiveRequests', 'RequestTotal', 'Preemptions'])).toBe(
      'vLLM localhost:8080 does not report requests or preemptions.',
    )
  })
})

describe('notReportedByAnyMessage', () => {
  it('says no running engine reports the panel’s groups', () => {
    expect(notReportedByAnyMessage(['SpeculativeDecoding'])).toBe(
      'No running engine reports speculative decoding.',
    )
    expect(notReportedByAnyMessage(['KvCache', 'PrefixCache'])).toBe(
      'No running engine reports KV cache or prefix cache.',
    )
    expect(notReportedByAnyMessage(['TtftPercentiles', 'E2ePercentiles'])).toBe(
      'No running engine reports latency percentiles.',
    )
    expect(notReportedByAnyMessage(['ActiveRequests', 'RequestTotal', 'Preemptions'])).toBe(
      'No running engine reports requests or preemptions.',
    )
  })
})

describe('coverageNote', () => {
  it('says nothing when every figure covers every running engine', () => {
    expect(
      coverageNote({
        running: 3,
        groups: [
          { group: 'KvCache', included: 3 },
          { group: 'PrefixCache', included: 3 },
        ],
      }),
    ).toBeNull()
  })

  it('says nothing for a panel with no group to cover', () => {
    expect(coverageNote({ running: 3, groups: [] })).toBeNull()
  })

  it('counts the engines once when every figure covers the same ones', () => {
    expect(
      coverageNote({
        running: 3,
        groups: [
          { group: 'KvCache', included: 2 },
          { group: 'PrefixCache', included: 2 },
        ],
      }),
    ).toBe('2 of 3 engines')
  })

  it('counts the engines of a single group', () => {
    expect(coverageNote({ running: 4, groups: [{ group: 'Throughput', included: 1 }] })).toBe(
      '1 of 4 engines',
    )
  })

  it('counts per group when the figures cover different engines', () => {
    expect(
      coverageNote({
        running: 3,
        groups: [
          { group: 'KvCache', included: 2 },
          { group: 'PrefixCache', included: 1 },
        ],
      }),
    ).toBe('KV cache 2 of 3, prefix cache 1 of 3 engines')
  })

  it('names every group, the complete ones too, and starts as a sentence', () => {
    expect(
      coverageNote({
        running: 3,
        groups: [
          { group: 'Throughput', included: 3 },
          { group: 'ActiveRequests', included: 2 },
        ],
      }),
    ).toBe('Throughput 3 of 3, active requests 2 of 3 engines')
  })

  it('names the tile-grain latency groups one by one', () => {
    expect(
      coverageNote({
        running: 2,
        groups: [
          { group: 'TtftMean', included: 2 },
          { group: 'TpotMean', included: 1 },
        ],
      }),
    ).toBe('TTFT mean 2 of 2, TPOT mean 1 of 2 engines')
  })
})
