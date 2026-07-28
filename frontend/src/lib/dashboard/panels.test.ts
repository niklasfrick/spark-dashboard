import { describe, it, expect } from 'vitest'
import {
  PANEL_TYPES,
  PANEL_TYPE_IDS,
  defaultPanelTitle,
  isKnownPanelType,
  panelBindingKind,
} from './panels'

describe('the panel type vocabulary', () => {
  it('is the exact set of ids that may appear in a saved document', () => {
    // These strings are persisted, so renaming one breaks every saved
    // dashboard that used it. This spec exists to make that a deliberate
    // decision with a migration rather than a silent rename.
    expect(PANEL_TYPE_IDS).toEqual([
      'gpu-utilization',
      'gpu-temperature',
      'gpu-power',
      'gpu-clock',
      'gpu-memory',
      'gpu-fan',
      'gpu-events',
      'cpu-utilization',
      'cpu-cores',
      'memory',
      'disk-io',
      'network-io',
      'engines-overview',
      'engine-status',
      'engine-prefill-throughput',
      'engine-decode-throughput',
      'engine-latency',
      'engine-slo-goodput',
      'engine-requests',
      'engine-cache',
      'engine-spec-decode',
      'inference-timeline',
      'logs',
    ])
  })

  it('gives every panel type a non-empty default title', () => {
    for (const id of PANEL_TYPE_IDS) {
      expect(PANEL_TYPES[id].title, id).toBeTruthy()
    }
  })
})

describe('isKnownPanelType', () => {
  it('accepts every declared type', () => {
    for (const id of PANEL_TYPE_IDS) {
      expect(isKnownPanelType(id), id).toBe(true)
    }
  })

  it('rejects a type this build does not implement', () => {
    expect(isKnownPanelType('gpu-voltage')).toBe(false)
  })

  it('rejects a type that only looks like an object key', () => {
    expect(isKnownPanelType('constructor')).toBe(false)
    expect(isKnownPanelType('toString')).toBe(false)
  })
})

describe('panelBindingKind', () => {
  it('reports the per-GPU panels as binding to a GPU', () => {
    expect(panelBindingKind('gpu-utilization')).toBe('gpu')
    expect(panelBindingKind('gpu-events')).toBe('gpu')
  })

  it('reports the per-engine panels as binding to an engine', () => {
    expect(panelBindingKind('engine-latency')).toBe('engine')
    // The log socket addresses an engine by endpoint, so a log panel is bound
    // like any other engine panel rather than being a special case.
    expect(panelBindingKind('logs')).toBe('engine')
  })

  it('reports host-wide panels as binding to nothing', () => {
    expect(panelBindingKind('memory')).toBe('none')
    expect(panelBindingKind('disk-io')).toBe('none')
    // The overview covers every engine at once, so there is nothing to pin.
    expect(panelBindingKind('engines-overview')).toBe('none')
  })

  it('reports an unimplemented type as binding to nothing', () => {
    // Nothing can be bound for a panel this build cannot render at all; it
    // shows an unsupported-panel placeholder instead.
    expect(panelBindingKind('gpu-voltage')).toBe('none')
  })
})

describe('defaultPanelTitle', () => {
  it('names a known panel in the operator-facing wording', () => {
    expect(defaultPanelTitle('gpu-utilization')).toBe('GPU Utilization')
  })

  it('falls back to the raw type for an unimplemented panel', () => {
    // The placeholder can then say which panel type it could not render,
    // which is what tells an operator they rolled the dashboard back.
    expect(defaultPanelTitle('gpu-voltage')).toBe('gpu-voltage')
  })
})
