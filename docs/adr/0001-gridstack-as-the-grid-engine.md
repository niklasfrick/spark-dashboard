# Gridstack as the grid engine, pinned exactly

**Status:** accepted (2026-09)

The dashboard needs a grid that drags, resizes, refuses a drop when a page is out
of room, and collapses to one column on a narrow viewport without destroying the
authored desktop layout. We adopted **`gridstack`**, pinned to an exact version
(`13.2.0` at the time of writing) in `frontend/package.json`, and rejected the
better-known `react-grid-layout` — the obvious choice, which is why this is
written down.

## Why not react-grid-layout

Three **open** defects landed squarely on the stack this design requires:

- **#2271** — `Maximum update depth exceeded`, an infinite render loop in
  `ResponsiveGridLayout` on container-width changes with fractional pixels,
  reproducing on the project's own demo and reported as a v2 regression. The
  container-measurement-driven responsive path is not a corner of this design; it
  *is* this design, because fit-to-viewport derives row height from the measured
  container.
- **#2268** — React 19 plus `react-draggable@4.7.0` makes drag and resize
  silently unresponsive, and the dependency range floats straight into it. Needs
  an npm `overrides` pin.
- **#2266** — `process is not defined` under Vite. Needs a `define:` block.

Its own CI still ran React 18. Adopting it meant budgeting for three workarounds
on a stack it did not test.

Also ruled out: `@dnd-kit/*` (drag primitives, no layout engine),
`react-resizable-panels` (nested split panes), `react-mosaic-component` /
`dockview` / `flexlayout-react` (tiling and dock managers, not grids), and the
unmaintained `muuri-react` / `golden-layout` / `react-grid-dnd`.

## What the spike proved

Gridstack's React wrapper was new, so adoption was gated on a browser spike
against the real stack — React 19 under `StrictMode`, with live recharts children
re-rendering at 20 Hz inside grid items. All of it passed: no StrictMode widget
duplication, live chart children surviving the library's DOM manipulation
(items are rendered through portals that keep the subtree mounted), no leaks
across repeated mount/unmount, runtime `cellHeight()` for fit-to-viewport,
`maxRow` + `willItFit()` for out-of-room rejection, real drag, and responsive
column collapse.

The strongest result was the last one: widening the container back restored the
*authored* layout exactly rather than a recompacted approximation, which is
precisely what the derived mobile layout requires — on the same
`ResizeObserver` path that is broken in `react-grid-layout` #2271.

## Consequences

- **The version is pinned exactly, and stays pinned.** Two reasons, and the
  second outlives the first. At adoption the newest line did not hold npm's
  `latest` dist-tag — `13.0.2` did — so a range or a bare `npm i gridstack`
  resolved *backwards*, to a line the spike never covered. That has since
  resolved (`latest` is `13.2.0`, the pinned version), but the standing reason
  has not: gridstack declares no React peer dependency at all, so npm will never
  warn on a React major bump. Re-run the browser-mode suite on any React or
  gridstack upgrade; that suite (`*.browser.test.tsx`, the `frontend-browser` CI
  job) exists for this reason and is the only thing that would catch a silently
  broken drag. A dependency sweep may move the pin, but not turn it into a range.
- **`save()` omits gridstack's own defaults.** A panel at `w:1, h:1` serializes
  with neither key. `readGeometry` therefore treats missing width and height as
  one, and writing is dense on purpose, so a future migration never has to guess
  what was elided.
- **Drags are driven with `MouseEvent`, not PointerEvents.** Gridstack binds
  `mousedown` on `.grid-stack-item-content`, then `mousemove`/`mouseup` on the
  document. `userEvent.pointer` silently does nothing, which looks exactly like a
  library defect and cost real debugging time in the spike.
- **The grid's dimensions have one source.** `GRID_COLUMNS` and `GRID_MAX_ROWS`
  in `frontend/src/lib/dashboard/grid.ts` configure the library; the library
  answers the same "will it fit" question during a drag, and two independent
  answers would disagree the moment either changed.
