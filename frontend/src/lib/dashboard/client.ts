/**
 * Talking to the server about the stored configuration document.
 *
 * The server stores opaque bytes and knows nothing about the schema, so this
 * layer is deliberately thin: it moves text across the wire and turns HTTP
 * outcomes into states the UI has a message for. Making sense of the bytes is
 * the loader's job, and it is the only reader of the schema.
 *
 * Every response carries the read-only header, so whether this instance can save
 * at all is answered by the same round trip that reads or writes — the client
 * never has to ask separately, and a directory that became unwritable after
 * startup surfaces on the next save rather than staying stale until a reload.
 *
 * Nothing here reads or writes browser-local storage. The configuration is
 * shared by everyone who opens the instance, so a per-browser copy would be an
 * invisible second source of truth — worse than a visible failure.
 */

import { serializeDashboardDocument, type DashboardDocument } from './schema'

/** The instance-scoped configuration resource. */
export const CONFIGURATION_URL = '/api/dashboard'

/** Set on every configuration response: whether storage can be written at all. */
export const READ_ONLY_HEADER = 'x-spark-dashboard-read-only'

/** What the server had when asked. */
export type StoredConfiguration =
  /** A document exists; `body` is its bytes, untouched. */
  | { status: 'stored'; body: string; readOnly: boolean }
  /** Nothing is stored. A fresh install and a reset both look like this. */
  | { status: 'absent'; readOnly: boolean }
  /**
   * The server answered and could not produce the document — it has one it
   * failed to read. The same position a document that will not parse leaves the
   * dashboard in, and it gets the same banner.
   */
  | { status: 'unreadable'; readOnly: boolean }
  /** The server was never reached, so it is not known what is stored. */
  | { status: 'unavailable'; readOnly: boolean }

/** How a save ended. */
export interface SaveOutcome {
  status:
    /** Stored. */
    | 'saved'
    /** This instance cannot save at all; no retry will change that. */
    | 'read-only'
    /** Over the server's size cap. Retrying will not help either. */
    | 'too-large'
    /** The write failed — a full disk, a dropped connection. Worth retrying. */
    | 'failed'
  readOnly: boolean
}

/** Reads the stored document. Never throws: every failure is a state above. */
export async function fetchStoredConfiguration(): Promise<StoredConfiguration> {
  let response: Response
  try {
    response = await fetch(CONFIGURATION_URL)
  } catch {
    return { status: 'unavailable', readOnly: false }
  }

  const readOnly = isReadOnly(response)

  // 204 is absence, which is not a failure and gets no banner.
  if (response.status === 204) return { status: 'absent', readOnly }
  // The server answered and could not hand over the document, which is what it
  // does when reading the file failed. That is a document the operator has that
  // cannot be read — the same thing, to them, as one that will not parse.
  if (!response.ok) return { status: 'unreadable', readOnly }

  try {
    return { status: 'stored', body: await response.text(), readOnly }
  } catch {
    return { status: 'unreadable', readOnly }
  }
}

/** Replaces the stored document. Never throws. */
export async function saveStoredConfiguration(document: DashboardDocument): Promise<SaveOutcome> {
  let response: Response
  try {
    response = await fetch(CONFIGURATION_URL, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: serializeDashboardDocument(document),
    })
  } catch {
    return { status: 'failed', readOnly: false }
  }

  const readOnly = isReadOnly(response)

  if (response.ok) return { status: 'saved', readOnly }
  // The server answers 503 only for storage it knows is unwritable, so trust it
  // over the header if the two ever disagree.
  if (response.status === 503) return { status: 'read-only', readOnly: true }
  if (response.status === 413) return { status: 'too-large', readOnly }
  return { status: 'failed', readOnly }
}

/**
 * Read-only is claimed only when the server says so in as many words. A missing
 * header — an old server, a proxy that stripped it, a connection that never
 * arrived — is not evidence of a permanent condition, and the banner promises
 * one.
 */
function isReadOnly(response: Response): boolean {
  return response.headers.get(READ_ONLY_HEADER) === 'true'
}
