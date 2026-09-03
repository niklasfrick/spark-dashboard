# One instance-scoped configuration, last write wins

**Status:** accepted (2026-09)

There is **one** dashboard configuration per instance, shared by everyone who
opens it, and concurrent saves resolve by **last write wins**. There are no
per-user layouts, no locking, no merge, and no "someone else changed this"
affordance.

This follows from the product, not from expedience: the dashboard has no
authentication and is not gaining any — it is a tool an operator points at their
own machine. Per-user layouts would require an identity system to hang them on,
and building conflict resolution for a document whose only writers are people who
already share root on the same host would be machinery in front of a problem
nobody has. An operator sharing a machine gets the semantic they already
understand from the machine's own configuration files: the last person to save
wins, and there is one answer to "what does this dashboard look like".

## Consequences

- **Writes are atomic, so the race is decided cleanly.** The bytes land in a
  uniquely named temporary file in the state directory, are flushed, and are
  renamed over the target — concurrent writers race to be last rather than
  corrupting each other, and a crash mid-write leaves the old document or the new
  one, never a truncated file that would brick the dashboard for every viewer at
  once.
- **Edit mode is explicit and there is no autosave.** With a configuration this
  shared, a stray drag would mutate what everyone sees, and an intermediate drag
  position must never become shared state.
- **Reading never writes.** A document that needed migrating is migrated in
  memory and persisted only on the next save the operator asked for; an
  auto-write-back would let one upgraded viewer lock out everyone still on the
  previous build.
- **An unwritable state directory is visible, not routed around.** The dashboard
  runs read-only with a banner rather than falling back to browser-local storage,
  because a per-browser copy of an instance-scoped document is a second source of
  truth that nobody can see.
- **Resetting is confirmed and total.** `DELETE /api/dashboard` removes the one
  document there is, for everyone, which is why the UI asks first.
