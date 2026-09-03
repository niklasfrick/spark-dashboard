# The server stores the dashboard configuration as an opaque document

**Status:** accepted (2026-09)

The server persists the dashboard configuration as **opaque bytes**: it never
parses, validates, migrates or understands the contents. `GET`, `PUT` and
`DELETE /api/dashboard` move one file, `<state-dir>/dashboards.json`, in and out
of the state directory under a 1 MiB cap. All schema knowledge — the panel types,
the geometry, the bindings, the version and every migration — lives in the
frontend (`frontend/src/lib/dashboard/`).

The reason is that the project already has exactly one cross-language contract,
the metrics wire format, and a typed configuration on the server would make two.
Every panel type added, every field added to a panel, would then be a change to
Rust structs, Rust tests, TypeScript types and TypeScript tests at once — for a
document the server has no reason to read. The schema changes with the UI,
because it *is* the UI's state; keeping it on the side that changes with it means
one migration path rather than two that can disagree.

## Consequences

- **The server cannot reject a bad document.** It enforces a size cap and
  nothing else, so a hand-edited or truncated file reaches the frontend, which
  reads tolerantly and falls back to the preset with a visible reason rather than
  throwing. That tolerance is a requirement of this decision, not a nicety.
- **Migration is a frontend obligation, permanently.** Migrations run in memory
  on load and are persisted only on the next operator-initiated save, so merely
  opening an upgraded dashboard never rewrites a document that colleagues on the
  older build are still reading.
- **The document's shape is internal.** No API consumer is promised anything
  about it, which is what keeps a versioned schema affordable and is why
  import/export is out of scope — see `CONTEXT.md`.
- **Deployment files, not the server, keep the path honest.** Since the server
  has no opinion on the contents, the only thing that can drift is *where* the
  file lives; `src/deploy_files.rs` asserts the systemd unit, the Dockerfile and
  the Compose file all agree with `DEFAULT_STATE_DIR`.
