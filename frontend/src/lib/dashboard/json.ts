/**
 * The one narrowing every reader in this module starts from.
 *
 * A stored document is arbitrary JSON until proven otherwise — it may have been
 * written by a newer build, hand-edited on disk, or truncated. Each reader here
 * begins by asking whether it has an object to read at all, so that question has
 * one answer rather than five subtly different ones.
 */

/**
 * Whether the value is a plain JSON object, so its keys can be read.
 *
 * Arrays are excluded on purpose: they are objects to `typeof`, but nothing in
 * the schema is ever legitimately an array where a record is expected, and
 * treating one as a record would read `length` as a field.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
