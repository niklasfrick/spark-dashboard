import { describe, it, expect } from 'vitest'
import { GRID_COLUMNS, GRID_MAX_ROWS } from './grid'
import {
  PANEL_TYPES,
  PANEL_TYPE_IDS,
  defaultPanelSize,
  defaultPanelTitle,
  isKnownPanelType,
  panelBindingKind,
  panelUsesWindow,
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

describe('defaultPanelSize', () => {
  it('gives every panel type a size that fits an empty page', () => {
    // A size no page could ever hold would make its palette entry permanently
    // refusable, which reads as a broken palette rather than as a full page.
    for (const id of PANEL_TYPE_IDS) {
      const { w, h } = defaultPanelSize(id)
      expect(w, id).toBeGreaterThanOrEqual(1)
      expect(h, id).toBeGreaterThanOrEqual(1)
      expect(w, id).toBeLessThanOrEqual(GRID_COLUMNS)
      expect(h, id).toBeLessThanOrEqual(GRID_MAX_ROWS)
    }
  })

  it('gives a log panel the extra width a line of output needs', () => {
    expect(defaultPanelSize('logs').w).toBeGreaterThan(defaultPanelSize('gpu-power').w)
  })

  it('falls back to the standard size for an unimplemented panel', () => {
    // A rolled-back build cannot add one of these from the palette, but the
    // size is still asked for wherever a panel is placed by type.
    expect(defaultPanelSize('gpu-voltage')).toEqual(defaultPanelSize('gpu-power'))
  })
})

describe('panelUsesWindow', () => {
  it('reports a charting panel as covering a time window', () => {
    expect(panelUsesWindow('gpu-power')).toBe(true)
    expect(panelUsesWindow('engine-latency')).toBe(true)
  })

  it('reports the log panel as not covering one', () => {
    // Logs are a live tail of whatever the engine last printed, so offering a
    // window to choose would be a control that changes nothing.
    expect(panelUsesWindow('logs')).toBe(false)
  })

  it('reports an unimplemented panel as not covering one', () => {
    expect(panelUsesWindow('gpu-voltage')).toBe(false)
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
