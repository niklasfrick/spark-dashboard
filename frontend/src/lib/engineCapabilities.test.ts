import { describe, it, expect } from 'vitest'
import { supportsCapability } from './engineCapabilities'

describe('supportsCapability', () => {
  it('vLLM supports every KPI group', () => {
    for (const cap of ['kvCache', 'goodput', 'queueTime', 'latencyPercentiles'] as const) {
      expect(supportsCapability('Vllm', cap)).toBe(true)
    }
  })

  it('llama.cpp hides the groups it genuinely cannot produce', () => {
    // No latency histograms, no KV-usage gauge, no queue-time metric.
    expect(supportsCapability('LlamaCpp', 'kvCache')).toBe(false)
    expect(supportsCapability('LlamaCpp', 'goodput')).toBe(false)
    expect(supportsCapability('LlamaCpp', 'queueTime')).toBe(false)
    expect(supportsCapability('LlamaCpp', 'latencyPercentiles')).toBe(false)
  })

  it('null (aggregate / unknown type) assumes full support', () => {
    // An all-models view is the union of its members, and a type this build
    // does not know must never blank a panel it might fill.
    for (const cap of ['kvCache', 'goodput', 'queueTime', 'latencyPercentiles'] as const) {
      expect(supportsCapability(null, cap)).toBe(true)
    }
  })
})
