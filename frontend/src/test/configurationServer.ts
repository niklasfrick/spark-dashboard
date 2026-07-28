/**
 * A stand-in for the dashboard-configuration endpoint, shared by every spec
 * that drives the application through the fetch seam.
 *
 * It answers the way `src/server.rs` does — 204 for nothing stored, the bytes
 * verbatim otherwise, and the read-only header on every response — so a spec
 * describes what the server said rather than how `fetch` is shaped. One copy,
 * because two stubs of the same endpoint under the same name and different
 * signatures is how the specs drift from the contract they encode.
 */

import { vi } from 'vitest'
import { READ_ONLY_HEADER } from '@/lib/dashboard/client'

/** Typed with fetch's own signature, so recorded calls read as URL plus init. */
export type FetchMock = ReturnType<
  typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>
>

export interface ConfigurationServerOptions {
  /** The stored document's bytes, or null for "nothing stored" (204). */
  document?: string | null
  /** What the state directory reports; sets the header on every response. */
  readOnly?: boolean
  /** Overrides the read's status — 500 for a document the server cannot read. */
  getStatus?: number
  /** The write's status: 204 stored, 503 read-only, 413 too large, 500 failed. */
  putStatus?: number
}

/** Installs the stub as the global `fetch` and hands it back for assertions. */
export function serveConfiguration(options: ConfigurationServerOptions = {}): FetchMock {
  const { document = null, readOnly = false, getStatus, putStatus = 204 } = options
  const headers = { [READ_ONLY_HEADER]: String(readOnly) }

  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      return Promise.resolve(new Response(null, { status: putStatus, headers }))
    }
    if (getStatus !== undefined && getStatus !== 200) {
      return Promise.resolve(
        new Response('the server could not read it', { status: getStatus, headers }),
      )
    }
    return Promise.resolve(
      document === null
        ? new Response(null, { status: 204, headers })
        : new Response(document, { status: 200, headers }),
    )
  })

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Installs a `fetch` that never reaches the server at all. */
export function serveNothing(): FetchMock {
  const fetchMock = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The bodies of every write the code under test issued, in order. */
export function configurationWrites(fetchMock: FetchMock): string[] {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PUT')
    .map(([, init]) => String(init?.body))
}

/**
 * Settles the configuration request and the render of whatever came back.
 *
 * Specs that expect no banner settle exactly the way the ones that expect a
 * banner do, so a silent case cannot pass merely by asserting before the answer
 * arrived.
 */
export async function configurationResponse(fetchMock: FetchMock): Promise<void> {
  await (fetchMock.mock.results[0]?.value as Promise<Response> | undefined)?.catch(() => undefined)
}
