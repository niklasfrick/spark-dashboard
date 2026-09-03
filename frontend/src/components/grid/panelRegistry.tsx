/**
 * Which React component renders each panel type's content.
 *
 * The registry is keyed by the persisted panel-type vocabulary in
 * `lib/dashboard/panels`, and is deliberately allowed to lag it: a type the
 * vocabulary knows but no component implements yet renders as a placeholder
 * that keeps its grid slot. That is what lets the panel tickets land one at a
 * time against a preset that already names every type.
 *
 * Nothing is lagging today — every type in the vocabulary has a component, and
 * `panelRegistry.test` holds it that way. The lag is kept as an affordance for
 * the next type to be named, not as a description of this build.
 */

import type { ComponentType, ReactElement } from 'react'
import { isKnownPanelType, type PanelType } from '@/lib/dashboard/panels'
import type { DashboardPanel } from '@/lib/dashboard/schema'
import { CpuCoresPanel } from './panels/CpuCoresPanel'
import { CpuUtilizationPanel } from './panels/CpuUtilizationPanel'
import { DiskIoPanel } from './panels/DiskIoPanel'
import { EngineCachePanel } from './panels/EngineCachePanel'
import { EngineLatencyPanel } from './panels/EngineLatencyPanel'
import { EngineRequestsPanel } from './panels/EngineRequestsPanel'
import { EngineSloGoodputPanel } from './panels/EngineSloGoodputPanel'
import { EngineSpecDecodePanel } from './panels/EngineSpecDecodePanel'
import { EngineStatusPanel } from './panels/EngineStatusPanel'
import { EnginesOverviewPanel } from './panels/EnginesOverviewPanel'
import {
  EngineDecodeThroughputPanel,
  EnginePrefillThroughputPanel,
} from './panels/EngineThroughputPanel'
import { GpuClockPanel } from './panels/GpuClockPanel'
import { GpuEventsPanel } from './panels/GpuEventsPanel'
import { GpuFanPanel } from './panels/GpuFanPanel'
import { GpuMemoryPanel } from './panels/GpuMemoryPanel'
import { GpuPowerPanel } from './panels/GpuPowerPanel'
import { GpuTemperaturePanel } from './panels/GpuTemperaturePanel'
import { GpuUtilizationPanel } from './panels/GpuUtilizationPanel'
import { InferenceTimelinePanel } from './panels/InferenceTimelinePanel'
import { LogsPanel } from './panels/LogsPanel'
import { MemoryPanel } from './panels/MemoryPanel'
import { NetworkIoPanel } from './panels/NetworkIoPanel'

/** Every panel content component takes the panel it renders, nothing else —
 *  data comes from the metrics store, not from props threaded through the grid. */
export interface PanelContentProps {
  panel: DashboardPanel
}

const PANEL_CONTENT: Partial<Record<PanelType, ComponentType<PanelContentProps>>> = {
  'gpu-utilization': GpuUtilizationPanel,
  'gpu-temperature': GpuTemperaturePanel,
  'gpu-power': GpuPowerPanel,
  'gpu-clock': GpuClockPanel,
  'gpu-memory': GpuMemoryPanel,
  'gpu-fan': GpuFanPanel,
  'gpu-events': GpuEventsPanel,
  'cpu-utilization': CpuUtilizationPanel,
  'cpu-cores': CpuCoresPanel,
  memory: MemoryPanel,
  'disk-io': DiskIoPanel,
  'network-io': NetworkIoPanel,
  'engine-prefill-throughput': EnginePrefillThroughputPanel,
  'engine-decode-throughput': EngineDecodeThroughputPanel,
  'engine-latency': EngineLatencyPanel,
  'engine-requests': EngineRequestsPanel,
  'engine-slo-goodput': EngineSloGoodputPanel,
  'engine-cache': EngineCachePanel,
  'engine-spec-decode': EngineSpecDecodePanel,
  'engine-status': EngineStatusPanel,
  'engines-overview': EnginesOverviewPanel,
  'inference-timeline': InferenceTimelinePanel,
  logs: LogsPanel,
}

/**
 * The panel types this build renders. Exported for the spec that holds the
 * registry against the vocabulary: a type the palette offers and no component
 * renders is a gap an operator only finds by adding an empty box (#110).
 */
export function implementedPanelTypes(): PanelType[] {
  return Object.keys(PANEL_CONTENT) as PanelType[]
}

/**
 * The panel's content element, or null when this build cannot render the type.
 * Returns an element rather than the component so no caller holds a component
 * looked up during its own render — the registered components stay the only
 * component identities involved.
 */
export function renderPanelContent(panel: DashboardPanel): ReactElement | null {
  const Content = isKnownPanelType(panel.type) ? PANEL_CONTENT[panel.type] : undefined
  return Content ? <Content panel={panel} /> : null
}
