/**
 * What the operator has to be told about their configuration.
 *
 * This is the vocabulary the loader, the HTTP client and the save path all
 * report into, and the only thing the banner component needs to know about any
 * of them. It lives here rather than beside the hook that assembles it so the
 * component depends on the domain rather than on a hook, and so the reasons the
 * loader already speaks (`ConfigurationFallbackReason`) extend naturally.
 */

import type { ConfigurationFallbackReason } from './load'

export type ConfigurationNotice =
  /**
   * The stored document is not the one being rendered, and why: written by a
   * newer build, too old for any migration to reach, or unreadable — including
   * when it was the server that could not read it.
   */
  | ConfigurationFallbackReason
  /** The server was never reached, so what is stored is unknown. */
  | { kind: 'unavailable' }
  /** Storage is unwritable, so nothing can be saved on this instance. */
  | { kind: 'read-only' }
  /** The last save failed and is worth retrying. */
  | { kind: 'save-failed' }
  /** The last save was refused for the document's size; retrying will not help. */
  | { kind: 'too-large' }
  /** The last reset did not remove the stored document, which is still there. */
  | { kind: 'reset-failed' }
