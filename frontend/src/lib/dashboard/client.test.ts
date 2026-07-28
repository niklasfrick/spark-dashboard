import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONFIGURATION_URL,
  READ_ONLY_HEADER,
  fetchStoredConfiguration,
  saveStoredConfiguration,
} from './client'
import { defaultDashboardDocument } from './preset'
import { serializeDashboardDocument } from './schema'

/** Installs a fetch that answers with `response`, and hands back the spy. */
function respondWith(response: Response | Promise<Response>) {
  // Typed with fetch's own signature so the recorded calls can be read back as
  // a URL and an init, rather than as the empty tuple a nullary stub records.
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(response),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function body(text: string, init: ResponseInit = {}): Response {
  return new Response(text, { status: 200, ...init })
}

const readOnly = { [READ_ONLY_HEADER]: 'true' }
const writable = { [READ_ONLY_HEADER]: 'false' }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchStoredConfiguration', () => {
  it('returns the stored document verbatim', async () => {
    // Verbatim matters: the server stores opaque bytes, so anything this layer
    // normalized would be a second reader of a schema only the loader knows.
    respondWith(body('{"version":1,"pages":[]}', { headers: writable }))

    expect(await fetchStoredConfiguration()).toEqual({
      status: 'stored',
      body: '{"version":1,"pages":[]}',
      readOnly: false,
    })
  })

  it('asks the configuration endpoint', async () => {
    const fetchMock = respondWith(new Response(null, { status: 204 }))

    await fetchStoredConfiguration()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(CONFIGURATION_URL)
  })

  it('reports absence rather than failure when nothing is stored', async () => {
    respondWith(new Response(null, { status: 204, headers: writable }))

    expect(await fetchStoredConfiguration()).toEqual({ status: 'absent', readOnly: false })
  })

  it('reports read-only storage from the header', async () => {
    respondWith(body('{"version":1,"pages":[]}', { headers: readOnly }))

    expect(await fetchStoredConfiguration()).toMatchObject({ readOnly: true })
  })

  it('reports read-only storage even when nothing is stored', async () => {
    // A fresh install on an unwritable volume: there is no document to read and
    // there never will be one, which the operator has to be told.
    respondWith(new Response(null, { status: 204, headers: readOnly }))

    expect(await fetchStoredConfiguration()).toEqual({ status: 'absent', readOnly: true })
  })

  it('reports the document unreadable when the server could not read it', async () => {
    // The server answers 500 when reading the file failed, so a document exists
    // and cannot be read — which is the operator's problem, not the network's.
    respondWith(new Response('Failed to read the dashboard configuration', { status: 500 }))

    expect(await fetchStoredConfiguration()).toMatchObject({ status: 'unreadable' })
  })

  it('reports unavailable when the server cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )

    expect(await fetchStoredConfiguration()).toEqual({ status: 'unavailable', readOnly: false })
  })

  it('does not claim read-only when the response never said', async () => {
    // The read-only banner promises a permanent condition. A dropped connection
    // says nothing about the state directory, so it must not imply one.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )

    expect(await fetchStoredConfiguration()).toMatchObject({ readOnly: false })
  })
})

describe('saveStoredConfiguration', () => {
  it('puts the serialized document to the configuration endpoint', async () => {
    const fetchMock = respondWith(new Response(null, { status: 204, headers: writable }))
    const document = defaultDashboardDocument()

    expect(await saveStoredConfiguration(document)).toEqual({ status: 'saved', readOnly: false })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(CONFIGURATION_URL)
    expect(init?.method).toBe('PUT')
    expect(init?.body).toBe(serializeDashboardDocument(document))
  })

  it('reports read-only when the instance cannot save at all', async () => {
    respondWith(
      new Response('Dashboard configuration storage is read-only', {
        status: 503,
        headers: readOnly,
      }),
    )

    expect(await saveStoredConfiguration(defaultDashboardDocument())).toEqual({
      status: 'read-only',
      readOnly: true,
    })
  })

  it('reports a document the server refuses to store for its size', async () => {
    // Distinct from a plain failure because retrying will never help: the
    // operator has to remove panels or pages.
    respondWith(
      new Response('Dashboard configuration exceeds the size limit', {
        status: 413,
        headers: writable,
      }),
    )

    expect(await saveStoredConfiguration(defaultDashboardDocument())).toMatchObject({
      status: 'too-large',
    })
  })

  it('reports a failure when the write itself failed', async () => {
    // A writable directory that could not be written to — a full disk, say. Not
    // read-only: retrying is worth the operator's time here.
    respondWith(
      new Response('Failed to save the dashboard configuration', {
        status: 500,
        headers: writable,
      }),
    )

    expect(await saveStoredConfiguration(defaultDashboardDocument())).toEqual({
      status: 'failed',
      readOnly: false,
    })
  })

  it('reports a failure when the server cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )

    expect(await saveStoredConfiguration(defaultDashboardDocument())).toEqual({
      status: 'failed',
      readOnly: false,
    })
  })
})
