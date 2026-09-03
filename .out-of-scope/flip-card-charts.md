# Flip-Card Chart Interaction

The dashboard does not hide time-series charts behind per-card flip/tap
interactions (panel fronts showing values, backs showing charts).

## Why this is out of scope

**At-a-glance philosophy.** The dashboard is designed as a glanceable
one-pager: every metric and its trend visible simultaneously, with the layout
itself adapting to available space rather than asking the operator to
interact. The codebase still encodes this intent — a panel measures its own
box and drops to a compact value-only rendering when there is no room to chart
in (`components/grid/panels/mode.ts`), rather than hiding the chart behind a
gesture. A flip interaction inverts that model: chart data becomes invisible
until each panel is individually tapped, and only one face can be seen at a
time. This was not rejected on paper — the full implementation (PR #46) was
built, brought up on the DGX Spark against live engines, and evaluated in the
browser before the maintainer decided against the interaction.

**What changed in 2026-09: the layout is no longer fixed.** This record used
to reject piecemeal layout and mobile patches on the grounds that a rework was
coming and would obsolete them. The rework has landed (#68, spec #70, cutover
#86): the fixed dashboard is gone, and the dashboard is now a grid of panels
an operator arranges themselves, on pages they name, saved on the server.

That reasoning is therefore spent, and **layout contributions are no longer
turned away by this record**. Two things follow from the new design instead:

- **Arrangement is configuration, not code.** Wanting different panels, sizes
  or ordering is answered by editing the dashboard and saving it — including
  a page with no log panel for a wall display, or one that gives temperature
  and power the whole screen. A PR is only the answer when the panel or the
  behavior does not exist yet.
- **The mobile layout is derived, not authored.** Panels collapse into a
  single column in desktop reading order below the breakpoint. Hand-authored
  phone layouts remain out of scope (see the spec), but mobile usability
  itself was delivered by the rework rather than deferred by it.

The flip interaction above stays rejected on its own merits — it is a
philosophy decision about glanceability, not a sequencing one, and nothing
about the rework changed it.

## Prior requests

- #42 — monolithic PR bundling flip-card charts, a view-mode toggle, and
  mobile layout changes (closed; split at our request)
- #46 — "feat(frontend): FlipCard with card-flip charts and mobile view
  toggle" — the cleaned-up resubmission; technically sound (build and 202
  tests passed on a rebased branch), closed on product grounds
