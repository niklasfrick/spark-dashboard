/**
 * Which React component renders each panel type's content.
 *
 * The registry is keyed by the persisted panel-type vocabulary in
 * `lib/dashboard/panels`, and is deliberately allowed to lag it: a type the
 * vocabulary knows but no component implements yet renders as a placeholder
 * that keeps its grid slot. That is what lets the panel tickets (#81–#82) land
 * one at a time against a preset that already names every type.
 *
 * The eight hardware panels (#80) are implemented; the engine and log panels
 * arrive with #81/#82.
 */

import type { ComponentType, ReactElement } from 'react'
import { isKnownPanelType, type PanelType } from '@/lib/dashboard/panels'
import type { DashboardPanel } from '@/lib/dashboard/schema'
import { CpuUtilizationPanel } from './panels/CpuUtilizationPanel'
import { DiskIoPanel } from './panels/DiskIoPanel'
import { GpuClockPanel } from './panels/GpuClockPanel'
import { GpuPowerPanel } from './panels/GpuPowerPanel'
import { GpuTemperaturePanel } from './panels/GpuTemperaturePanel'
import { GpuUtilizationPanel } from './panels/GpuUtilizationPanel'
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
  'cpu-utilization': CpuUtilizationPanel,
  memory: MemoryPanel,
  'disk-io': DiskIoPanel,
  'network-io': NetworkIoPanel,
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
