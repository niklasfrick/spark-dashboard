import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { page as browserPage } from 'vitest/browser'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { GridPage } from '@/components/grid/GridPage'
import { MetricsStoreProvider } from '@/hooks/MetricsStoreProvider'
import { useMetricsStore } from '@/hooks/useMetricsStore'
import { FOLLOW } from '@/lib/dashboard/bindings'
import type { PanelGeometry } from '@/lib/dashboard/grid'
import type { PanelType } from '@/lib/dashboard/panels'
import { DEFAULT_TIME_WINDOW, type DashboardPage } from '@/lib/dashboard/schema'
import { measuredPanel } from '@/test/gridEngine'
import type { EngineMetrics, EngineSnapshot, MetricsSnapshot } from '@/types/metrics'

// The SLO Goodput panel's threshold settings, opened from the cog in the panel
// (#123). The dialog used to render inside the panel, so every clip between it
// and the page cut it off: on a single-engine host the cog sits at the panel's
// left edge and the dialog opened leftwards out of the panel, and on a short
// panel its bottom — Apply included — was out of reach.
//
// Whether a control can be clicked is a question about real geometry, so the
// assertions hit-test: `elementFromPoint` at each control's centre has to come
// back with that control, not with whatever covers or clips it. That is also
// why this one popover has a spec here: it is the only one that opens from
// inside a panel, and jsdom measures every box as 0×0.
//
// Tailwind classes do not apply here (the browser project runs no Tailwind
// build), so `overflow-hidden` on the panel body, the panel frame and the page
// would clip nothing on its own. `clipLikeTheApp` gives every container that
// carries one of those utilities its overflow inline, which puts the clips the
// operator sees back where they are in the styled app. The positioning
// utilities stay inert too, so a dialog left inside a tall panel could still
// pass the hit-test here; the last assertion — the dialog is not inside the
// panel frame at all — is what holds the fix in place on every geometry.

const ALPHA = 'http://localhost:8000'
const BETA = 'http://localhost:8001'

function engineMetrics(): EngineMetrics {
  return {
    tokens_per_sec: 120,
    avg_tokens_per_sec: 100,
    per_request_tps: 40,
    ttft_ms: 210,
    active_requests: 3,
    queued_requests: 1,
    kv_cache_percent: 42,
    kv_cache_is_estimated: false,
    total_requests: 900,
    e2e_latency_ms: 4200,
    prompt_tokens_per_sec: 3000,
    avg_prompt_tokens_per_sec: 2500,
    per_request_prompt_tps: 800,
    swapped_requests: 0,
    prefix_cache_hit_rate: 55,
    queue_time_ms: 12,
    inter_token_latency_ms: 9,
    preemptions_total: 0,
    total_prompt_tokens: 1_000_000,
    total_generation_tokens: 500_000,
    prefix_cache_queries_total: 2_000_000,
    avg_batch_size: 6.5,
    ttft_percentiles: { p50_ms: 200, p95_ms: 400, p99_ms: 900 },
    itl_percentiles: null,
    e2e_percentiles: null,
    ttft_goodput_pct: 99,
    itl_goodput_pct: 98,
    e2e_goodput_pct: 97,
    ttft_buckets: null,
    itl_buckets: null,
    e2e_buckets: null,
    tpot_ms: 8,
    tpot_percentiles: null,
    tpot_goodput_pct: 96,
    tpot_buckets: null,
    spec_decode_draft_tokens_total: null,
    spec_decode_accepted_tokens_total: null,
    spec_decode_drafts_total: null,
    spec_decode_acceptance_rate: null,
    spec_decode_acceptance_rate_live: null,
    spec_decode_mean_acceptance_length: null,
  }
}

function engine(endpoint: string, model: string): EngineSnapshot {
  return {
    engine_type: 'Vllm',
    endpoint,
    status: { type: 'Running' },
    model: {
      name: model,
      parameter_size: null,
      quantization: null,
      precision: null,
      tensor_type: null,
      model_type: null,
      pipeline_tag: null,
    },
    metrics: engineMetrics(),
    recent_requests: [],
    deployment_mode: 'Native',
  }
}

/** One engine: nothing to tell apart, so the panel has no label row text and
 *  the cog is the first thing in it — at the panel's left edge. */
const ONE_ENGINE = [engine(ALPHA, 'Qwen/Qwen3-8B')]
/** Two engines: the label takes the row's left, and the cog sits at its right. */
const TWO_ENGINES = [engine(ALPHA, 'Qwen/Qwen3-8B'), engine(BETA, 'meta-llama/Llama-3.1-8B')]

function snapshot(engines: EngineSnapshot[]): MetricsSnapshot {
  return {
    timestamp_ms: 1000,
    gpu: {
      index: 0,
      name: 'GPU 0',
      utilization_percent: 76,
      temperature_celsius: 61,
      power_watts: 220,
      power_limit_watts: 300,
      clock_graphics_mhz: 2100,
      clock_sm_mhz: null,
      clock_memory_mhz: null,
      fan_speed_percent: null,
    },
    cpu: { name: 'CPU', aggregate_percent: 25, per_core: [] },
    memory: {
      total_bytes: 128,
      used_bytes: 64,
      available_bytes: 64,
      cached_bytes: 8,
      gpu_estimated_bytes: null,
      gpu_memory_total_bytes: null,
      gpu_memory_used_bytes: null,
      is_unified: true,
    },
    disk: { name: 'disk', read_bytes_per_sec: 1, write_bytes_per_sec: 2 },
    network: { name: 'net', rx_bytes_per_sec: 3, tx_bytes_per_sec: 4 },
    engines,
    gpu_events: [],
  }
}

function page(panels: Array<[string, PanelType, PanelGeometry]>): DashboardPage {
  return {
    id: 'p',
    name: 'P',
    panels: panels.map(([id, type, geometry]) => ({
      id,
      type,
      geometry,
      binding: FOLLOW,
      window: DEFAULT_TIME_WINDOW,
    })),
  }
}

/** A page holding the SLO panel at `geometry`, alone. */
function sloPage(geometry: PanelGeometry): DashboardPage {
  return page([['slo', 'engine-slo-goodput', geometry]])
}

function Ingest({ engines }: { engines: EngineSnapshot[] }) {
  const store = useMetricsStore()
  useEffect(() => {
    store.ingest(snapshot(engines))
  }, [store, engines])
  return null
}

/** The app's main area: the whole viewport, less the page's padding. */
function Harness({ content, engines }: { content: DashboardPage; engines: EngineSnapshot[] }) {
  return (
    <MetricsStoreProvider>
      <Ingest engines={engines} />
      <div style={{ position: 'fixed', inset: 0, padding: 12, boxSizing: 'border-box' }}>
        <GridPage page={content} />
      </div>
    </MetricsStoreProvider>
  )
}

/**
 * The clips and scrollers the styled app puts around a panel, as inline styles:
 * every ancestor of `from` that carries one of those utilities gets the CSS the
 * utility stands for. See the note at the top of the file.
 */
function clipLikeTheApp(from: HTMLElement): void {
  for (let el = from.parentElement; el; el = el.parentElement) {
    if (el.classList.contains('overflow-hidden')) el.style.overflow = 'hidden'
    if (el.classList.contains('overflow-y-auto')) el.style.overflowY = 'auto'
  }
}

const cog = () => screen.getByRole('button', { name: 'Edit SLO thresholds' })
const dialog = () => screen.queryByRole('dialog', { name: 'SLO threshold settings' })

/** Renders the page, and waits for the grid to have settled on its row height
 *  and the engine to have resolved — a dialog opened before then is placed
 *  against a panel that is still moving. */
async function renderSettled(content: DashboardPage, engines: EngineSnapshot[]): Promise<void> {
  const { container } = render(<Harness content={content} engines={engines} />)
  await measuredPanel(container, 'slo')
  await waitFor(() => expect(cog()).toBeEnabled())
  clipLikeTheApp(cog())
}

/** Opens the settings from the cog, and lets the dialog place itself. */
async function openSettings(): Promise<HTMLElement> {
  await userEvent.click(cog())
  const opened = await screen.findByRole('dialog', { name: 'SLO threshold settings' })
  await frames()
  return opened
}

/** Two frames: whatever the dialog does to place itself has been laid out. */
async function frames(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}

/** Every control in the dialog: the four thresholds, Reset and Apply. */
function controls(opened: HTMLElement): HTMLElement[] {
  const inputs = within(opened).getAllByRole('spinbutton')
  expect(inputs).toHaveLength(4)
  return [
    ...inputs,
    within(opened).getByRole('button', { name: 'Reset' }),
    within(opened).getByRole('button', { name: 'Apply' }),
  ]
}

/** What a click at the control's centre would land on. */
function hitAt(control: HTMLElement): Element | null {
  const box = control.getBoundingClientRect()
  return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
}

function expectUsable(opened: HTMLElement): void {
  // On screen: the whole dialog inside the viewport…
  const box = opened.getBoundingClientRect()
  expect(box.left).toBeGreaterThanOrEqual(0)
  expect(box.top).toBeGreaterThanOrEqual(0)
  expect(box.right).toBeLessThanOrEqual(window.innerWidth)
  expect(box.bottom).toBeLessThanOrEqual(window.innerHeight)

  // …every control in it reachable by the pointer, not covered or clipped…
  for (const control of controls(opened)) {
    // A threshold input is named by its label's first span ("TTFT"), a button by its text.
    const label = control.closest('label')?.querySelector('span')?.textContent ?? control.textContent
    expect(control.contains(hitAt(control)), `${label} can be clicked`).toBe(true)
  }

  // …and outside the panel frame, where no clip of the panel's can reach it.
  expect(screen.getByRole('region', { name: 'SLO Goodput' }).contains(opened)).toBe(false)
}

// What the issue was measured at: a laptop.
const VIEWPORT = { width: 1280, height: 800 }
let restoreViewport = { width: 0, height: 0 }

beforeAll(async () => {
  restoreViewport = { width: window.innerWidth, height: window.innerHeight }
  await browserPage.viewport(VIEWPORT.width, VIEWPORT.height)
})

afterAll(async () => {
  await browserPage.viewport(restoreViewport.width, restoreViewport.height)
})

beforeEach(() => {
  // Thresholds are stored per model in the browser; every case starts at the
  // defaults, so Reset and Apply start out the same way too.
  window.localStorage.clear()
})

describe('the SLO settings dialog in a real layout engine', () => {
  it.each<[string, PanelGeometry, EngineSnapshot[]]>([
    ['on a single-engine host', { x: 0, y: 0, w: 4, h: 4 }, ONE_ENGINE],
    ['on a 2×2 panel', { x: 4, y: 2, w: 2, h: 2 }, ONE_ENGINE],
    ['on a panel at the grid’s right edge', { x: 9, y: 0, w: 3, h: 4 }, ONE_ENGINE],
    ['on a panel in the bottom row at h=2', { x: 0, y: 6, w: 4, h: 2 }, ONE_ENGINE],
    ['on a two-engine host at h=2', { x: 4, y: 0, w: 4, h: 2 }, TWO_ENGINES],
  ])('is whole and usable %s', async (_name, geometry, engines) => {
    await renderSettled(sloPage(geometry), engines)
    expectUsable(await openSettings())
  })

  it('applies a threshold, and is dismissed by an outside click, Escape and the cog', async () => {
    await renderSettled(sloPage({ x: 0, y: 0, w: 4, h: 4 }), ONE_ENGINE)
    const opened = await openSettings()
    const panel = screen.getByRole('region', { name: 'SLO Goodput' })

    // A click inside the dialog is not an outside click, wherever it renders.
    const [ttft] = within(opened).getAllByRole('spinbutton')
    await userEvent.click(ttft)
    expect(dialog()).toBe(opened)

    await userEvent.clear(ttft)
    await userEvent.type(ttft, '250')
    await userEvent.click(within(opened).getByRole('button', { name: 'Apply' }))
    expect(dialog()).toBeNull()
    expect(within(panel).getByText('TTFT ≤ 250ms')).toBeInTheDocument()

    await userEvent.click(cog())
    expect(dialog()).not.toBeNull()
    await userEvent.keyboard('{Escape}')
    expect(dialog()).toBeNull()

    await userEvent.click(cog())
    expect(dialog()).not.toBeNull()
    await userEvent.click(within(panel).getByText('Combined'))
    expect(dialog()).toBeNull()

    // The cog toggles it, as it always has.
    await userEvent.click(cog())
    expect(dialog()).not.toBeNull()
    await userEvent.click(cog())
    expect(dialog()).toBeNull()
  })

  it('stays usable in the single-column layout, and follows the cog when the column scrolls', async () => {
    await browserPage.viewport(390, 844)
    try {
      const content = page([
        ['cpu', 'cpu-utilization', { x: 0, y: 0, w: 6, h: 4 }],
        ['slo', 'engine-slo-goodput', { x: 6, y: 0, w: 6, h: 4 }],
        ['memory', 'memory', { x: 0, y: 4, w: 12, h: 4 }],
      ])
      await renderSettled(content, ONE_ENGINE)
      // Mid-screen, so the column can scroll it either way and it stays in view.
      cog().scrollIntoView({ block: 'center' })
      const opened = await openSettings()
      expectUsable(opened)

      // Where the dialog sits relative to the cog, before and after a scroll of
      // the stacked column — the one place the grid scrolls by design.
      const offset = () => opened.getBoundingClientRect().top - cog().getBoundingClientRect().bottom
      const before = offset()
      const column = cog().closest<HTMLElement>('.overflow-y-auto')!
      const from = column.scrollTop
      column.scrollTop = from >= 60 ? from - 60 : from + 60
      expect(column.scrollTop).not.toBe(from)

      await waitFor(() => expect(offset()).toBeCloseTo(before, 0))
      expectUsable(opened)
    } finally {
      await browserPage.viewport(VIEWPORT.width, VIEWPORT.height)
    }
  })
})
