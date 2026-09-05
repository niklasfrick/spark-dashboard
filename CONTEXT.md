# Spark Dashboard

A live observability tool for a DGX Spark host: what the hardware and the
inference engines on it are doing right now. A Rust backend collects metrics and
serves an embedded React frontend; the frontend renders them as an arrangement
of panels the operator owns and the server stores.

This is a **single context**. The backend and the frontend share one domain and
one wire format, so there is one glossary for both. Architecture decisions live
in [`docs/adr/`](./docs/adr/).

## Language

### Who and what

**Operator**:
The person running the dashboard on their own machine. There are no accounts,
roles or per-user state — every operator on an instance sees the same thing.
_Avoid_: user, admin, viewer

**Engine**:
An inference server on the host, detected by process scan or the Docker API and
polled for Prometheus metrics. Identified to the backend by its **endpoint**;
identified in the UI by type and endpoint together, since a host can run several
of the same type.
_Avoid_: server, model, backend (the backend is the Rust process)

**Provider**:
The organization that published a model, taken from its HuggingFace-style org
prefix and used to pick the logo beside it. Not a synonym for engine — one engine
serves models from many providers, though the older
`SPARK_DASHBOARD_PROVIDER_API_KEY` flag uses the word that way.
_Avoid_: vendor, org, publisher

**GPU index**:
The integer NVML reports for a device, and the identity a panel pins to. GPUs
have no other stable key.
_Avoid_: device id, GPU name

**Metrics contract**:
The JSON snapshot shape the backend broadcasts over the WebSocket and the
frontend types mirror. It is the project's **only** cross-language contract —
see [ADR-0002](./docs/adr/0002-configuration-is-an-opaque-document.md).
_Avoid_: API schema, protocol

### The dashboard an operator arranges

**Panel**:
One metric in one rectangle on the grid — the unit an operator moves, resizes,
retitles, adds and removes. Panels are fine-grained on purpose: one per metric,
not a handful of fixed composite cards.
_Avoid_: card, widget, tile

**Panel type**:
Which panel a panel is (`gpu-temperature`, `engine-latency`, `logs`, …). The ids
are persisted verbatim in the configuration, so renaming one is a migration
rather than a refactor. `frontend/src/lib/dashboard/panels.ts` is the list.
_Avoid_: panel kind, panel variant

**Page**:
One named arrangement of panels, with its own stable id and URL. Pages are how
one dashboard holds a training view and an idle health view side by side. Header
**tabs** switch between them; a tab is the control, not the thing.
_Avoid_: tab, view, screen, dashboard (singular)

**Geometry**:
A panel's placement in grid cells — `x`, `y`, `w`, `h` on a 12-column grid with a
hard row cap. Row height is derived from the measured container at render time
and is never persisted.
_Avoid_: position, layout (a layout is the whole page's arrangement), size

**Binding**:
What a panel points at: a GPU by index, an engine by endpoint, or the sentinel
**`follow`**. A binding whose target is absent renders a placeholder keeping its
grid slot; silent substitution is prohibited.
_Avoid_: data source, target (a target is what a binding resolves *to*), filter

**Follow**:
The default binding, and the sentinel every panel in the preset carries. It
resolves to the **page selection**, which is what makes one static preset correct
on a one-GPU laptop and on a four-GPU server.
_Avoid_: auto, inherit, default binding

**Page selection**:
The GPU and engine target a page's `follow` panels resolve against. Three layers,
strongest first: what the operator chose this session (stored sparsely, so an
absent key means "never chose" rather than "chose nothing"), the page's **page
source**, then the host's defaults.
_Avoid_: current GPU, active engine, global filter

**Page source**:
The persisted per-page default for what following engine panels show: one engine
by endpoint, or **all models** — the aggregate. Absent means automatic (the host
default), which is what every page starts as and what the preset ships with.
Chosen from the **page config** control beside "Edit layout" and written the
moment it is chosen, like a rename — not part of an edit session.
_Avoid_: page filter, default engine (it may also be the aggregate), page binding

**All models**:
The combined view across every running engine: throughput and counters sum,
latencies are request-weighted means (`lib/engineAggregate`). A following panel
rendering it says so — a combined figure wearing no name would read as one
engine's. Per-engine things (logs, engine identity, a pin) never aggregate.
_Avoid_: global view, all engines (the panel type "All Engines" is the overview
panel; the page source is about what following panels render)

**Time window**:
How much history a panel's chart covers (`5m`, `10m`, `15m`). Per panel, not per
page: a spike and a trend belong on the same page.
_Avoid_: range, timespan, zoom

**Edit mode**:
The explicit mode in which panels can be dragged, resized, added and removed,
ended by **Save layout** or **Discard**. Outside it panels are fully interactive
and never move; inside it live motion freezes.
_Avoid_: design mode, unlocked, edit state

**Palette**:
The list of every panel type an operator can add, opened in edit mode.
Click-to-add places the panel in the first free slot, in reading order.
_Avoid_: panel picker, library, add menu

**Out of room**:
The state of a page that cannot take a drop, a resize or a new panel without
breaking the row cap. It is an outcome the operator is shown, never a silent
no-op.
_Avoid_: full, overflow, no space

**Preset**:
The one-page arrangement rendered when nothing is stored — a static document, not
one generated from the host it lands on. "Fresh install" and "reset" are the same
state: the document does not exist.
_Avoid_: default layout, template, seed, factory settings

### What is stored, and where

**Dashboard configuration**:
The single, instance-scoped, versioned JSON document holding every page and every
panel. Shared by everyone who opens the instance, last write wins. `document` is
the accepted short form in frontend code (`DashboardDocument`).
_Avoid_: settings, preferences, layout file, per-user config

**Schema version**:
The integer at the head of the configuration, present since the first release.
Migrations run in memory on load; there is no down-migration
([ADR-0003](./docs/adr/0003-instance-scoped-last-write-wins-configuration.md)
covers why neither is written back).
_Avoid_: config version, revision

**State directory**:
The one writable directory the server owns, holding `dashboards.json`. Defaults
to `/var/lib/spark-dashboard` — a systemd `StateDirectory=` grant, a Docker named
volume — and moves with `--state-dir` / `SPARK_DASHBOARD_STATE_DIR`.
_Avoid_: data directory, config directory, storage path

**Read-only mode**:
What the dashboard runs in when the state directory was not writable at startup:
reads work, writes are refused with `503`, every `/api/dashboard` response
carries `x-spark-dashboard-read-only: true`, and a banner says so. Falling back
to browser-local storage is prohibited.
_Avoid_: degraded mode, offline mode

## Out of scope

Recorded so it is not re-argued. Each of these was considered during the
dashboard rework (#68, spec #70) and deliberately left out.

- **Import and export of the configuration.** Sharing the document would turn
  its schema into a public contract and multiply the migration burden for a thin
  use case on a single-instance tool. The file's location is documented instead
  (README, `deploy/docker/docker.md`): copying it is the backup story.
- **Per-user layouts.** They require an identity system this project
  deliberately does not have. See
  [ADR-0003](./docs/adr/0003-instance-scoped-last-write-wins-configuration.md).
- **Conflict resolution between concurrent editors.** Last write wins is the
  documented semantic; there is no locking and no "someone else changed this"
  affordance. Same ADR.
- **Server-side understanding of the configuration.** No validation, no typed
  schema, no rendering — the server stores opaque bytes and enforces a size cap.
  See [ADR-0002](./docs/adr/0002-configuration-is-an-opaque-document.md).
- **Undo and redo inside edit mode.** Discarding the edit session is the
  substitute; undo over a grid with collision-driven reflow is disproportionately
  deep for the benefit.
- **Hand-authored mobile layouts.** The narrow-viewport layout is *derived*:
  panels collapse to a single column in desktop reading order, and widening
  restores the authored layout exactly rather than a recompacted approximation.
- **A panel-count limit separate from the row cap.** A page that cannot fit
  another cell cannot fit another panel; one cap, one explanation.
- **Alerting, per-panel thresholds, and cost accounting.** See
  `.out-of-scope/cost-analysis.md` for the last of those.
- **Flip-card chart interactions.** A glanceability decision, not a sequencing
  one — see `.out-of-scope/flip-card-charts.md`, which also records that layout
  contributions are no longer turned away now that arrangement is configuration.
- **Subpath deployment behind a reverse proxy.** Broken independently of the
  rework (assets are absolute-rooted); not regressed by it and not fixed by it.
