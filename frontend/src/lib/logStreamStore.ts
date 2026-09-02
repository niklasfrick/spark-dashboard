/**
 * The live container logs of every engine something on screen is watching.
 *
 * The dashboard's log console used to be one fixed drawer, so one socket was
 * all it could ever need. Logs are a panel now (#82): a page can hold several,
 * a debugging page can hold several of the same engine at different filters, and
 * a wall display can hold none. Left to themselves, N panels would open N
 * sockets to the same container and multiply the backend's docker-logs streams
 * for nothing.
 *
 * So the connection belongs to the **endpoint**, not to the panel. Panels
 * subscribe; the first subscriber of an endpoint opens the socket, the last one
 * to leave closes it. Two panels on one engine share a socket and a buffer —
 * closing one leaves the other streaming — and two panels on two engines are two
 * independent streams.
 *
 * This is an external store for React's `useSyncExternalStore` (the same shape
 * as `MetricsHistoryStore`): `read` returns a value that only changes when the
 * stream does, so a panel re-renders for its own engine's lines and for nothing
 * else.
 */

/** How many lines a stream keeps. Beyond this the oldest are dropped. */
const LINE_LIMIT = 1000

/** How long to wait before retrying a live connection that dropped. */
const RECONNECT_DELAY_MS = 2000

/**
 * Where a stream is in its connection lifecycle.
 *
 * `unavailable` is the deployment-configuration case rather than a failure: the
 * handshake never succeeded because the backend runs without
 * `--enable-log-viewer`, so `/ws/logs` is not a registered route. It is kept
 * apart from `reconnecting` because retrying a route that does not exist is a
 * loop that can never end.
 */
export type LogStreamStatus = 'connecting' | 'connected' | 'reconnecting' | 'unavailable'

/** One engine's log stream as a viewer sees it. */
export interface LogStream {
  readonly status: LogStreamStatus
  readonly lines: readonly string[]
}

/** What every endpoint reads as before anything subscribes to it. A shared
 *  constant, so an unwatched endpoint never looks like it changed. */
const NO_STREAM: LogStream = { status: 'connecting', lines: [] }

/** One endpoint's socket, buffer and subscribers. */
interface Connection {
  socket: WebSocket | null
  retry: ReturnType<typeof setTimeout> | null
  /** Whether the socket ever opened — what tells a dropped connection apart
   *  from a route the backend never registered. */
  everOpened: boolean
  stream: LogStream
  listeners: Set<() => void>
}

export class LogStreamStore {
  private connections = new Map<string, Connection>()

  /**
   * Watch one engine's logs, holding the connection open for as long as the
   * returned release function has not been called.
   *
   * The endpoint is the engine's, exactly as the metrics snapshot reports it:
   * a log panel binds to an engine like any other engine panel, so there is
   * no unaddressed connection for the backend to guess at.
   */
  subscribe(endpoint: string, listener: () => void): () => void {
    let connection = this.connections.get(endpoint)
    if (!connection) {
      connection = {
        socket: null,
        retry: null,
        everOpened: false,
        stream: NO_STREAM,
        listeners: new Set(),
      }
      this.connections.set(endpoint, connection)
      this.connect(endpoint, connection)
    }
    connection.listeners.add(listener)

    return () => {
      connection.listeners.delete(listener)
      // The last viewer left: close the socket so the backend can stop the
      // container stream too, and drop the buffer with it. Lines held for a
      // panel nobody is looking at would be stale by the time one is.
      if (connection.listeners.size === 0) {
        this.close(endpoint, connection)
      }
    }
  }

  /**
   * The endpoint's stream. Stable between changes, so it can be the
   * `getSnapshot` of a `useSyncExternalStore` subscription.
   */
  read(endpoint: string): LogStream {
    return this.connections.get(endpoint)?.stream ?? NO_STREAM
  }

  private connect(endpoint: string, connection: Connection): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const query = endpoint ? `?engine=${encodeURIComponent(endpoint)}` : ''
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/logs${query}`)
    connection.socket = socket

    socket.onopen = () => {
      connection.everOpened = true
      this.update(connection, { status: 'connected' })
    }

    socket.onmessage = (event) => {
      const line = event.data as string
      const lines = [...connection.stream.lines, line]
      this.update(connection, {
        lines: lines.length > LINE_LIMIT ? lines.slice(-LINE_LIMIT) : lines,
      })
    }

    socket.onclose = () => {
      connection.socket = null
      // This connection is no longer the endpoint's. A real browser fires
      // `close` on a later task, so between `close()` and this handler the last
      // subscriber may have left and a new one taken the endpoint over — a
      // panel removed and re-added, a following panel switching engines and
      // back. Testing that *some* connection exists for the endpoint would let
      // this orphan schedule a retry that nothing can ever cancel, leaving a
      // duplicate stream open for the life of the page.
      if (this.connections.get(endpoint) !== connection) return

      if (!connection.everOpened) {
        this.update(connection, { status: 'unavailable' })
        return
      }
      // A live connection dropped — a backend restart, a network blip. Retry on
      // a delay, the way the metrics socket does, and keep the lines: they are
      // the same container's, and they are what the operator was reading.
      this.update(connection, { status: 'reconnecting' })
      connection.retry = setTimeout(() => {
        connection.retry = null
        this.connect(endpoint, connection)
      }, RECONNECT_DELAY_MS)
    }

    socket.onerror = () => {
      socket.close()
    }
  }

  private close(endpoint: string, connection: Connection): void {
    this.connections.delete(endpoint)
    if (connection.retry) clearTimeout(connection.retry)
    connection.retry = null
    connection.socket?.close()
    connection.socket = null
  }

  /** Replace the stream value and tell this endpoint's subscribers. */
  private update(connection: Connection, change: Partial<LogStream>): void {
    connection.stream = { ...connection.stream, ...change }
    for (const listener of connection.listeners) listener()
  }
}
