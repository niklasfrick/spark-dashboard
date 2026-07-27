# Flip-Card Chart Interaction

The dashboard does not hide time-series charts behind per-card flip/tap
interactions (card fronts showing values, backs showing charts), and it does
not take piecemeal layout changes to the current frontend to make single
screens mobile-friendly.

## Why this is out of scope

**At-a-glance philosophy.** The dashboard is designed as a glanceable
one-pager: every metric and its trend visible simultaneously, with the layout
itself adapting to available space rather than asking the operator to
interact. The codebase encodes this intent — `Dashboard.tsx` collapses charts
and swaps gauges for compact bars specifically so "the dashboard stays a
one-pager when vertical space is tight". A flip interaction inverts that
model: chart data becomes invisible until each card is individually tapped,
and only one face of a card can be seen at a time. This was not rejected on
paper — the full implementation (PR #46) was built, brought up on the DGX
Spark against live engines, and evaluated in the browser before the
maintainer decided against the interaction.

**Superseded by the frontend rework.** A frontend rework is upcoming.
Incremental interaction patterns and responsive-layout patches (e.g. scoping
the viewport-filling flex constraints to `md:` so mobile scrolls) layered on
the current component tree will be obsoleted by it, so they are not accepted
in the meantime. Mobile usability itself is not rejected as a goal — it is
expected to be addressed wholesale by the rework, not via spot fixes.

## Prior requests

- #42 — monolithic PR bundling flip-card charts, a view-mode toggle, and
  mobile layout changes (closed; split at our request)
- #46 — "feat(frontend): FlipCard with card-flip charts and mobile view
  toggle" — the cleaned-up resubmission; technically sound (build and 202
  tests passed on a rebased branch), closed on product grounds
