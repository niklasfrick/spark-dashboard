/**
 * A stand-in for the browser WebSocket, shared by every spec that drives the
 * application through the socket seam — a log panel's stream and the metrics
 * feed both arrive this way.
 *
 * One copy, for the same reason `configurationServer.ts` is one copy: two
 * substitutes of the same seam under the same name and different behavior is
 * how the specs drift from the contract they encode.
 */
export class MockWebSocket {
  static instances: MockWebSocket[] = []

  /**
   * Whether `close()` delivers its event on a later turn, the way a real
   * browser does, instead of synchronously inside the call.
   *
   * Off by default: firing it synchronously keeps the specs that only care
   * about a socket having closed readable. Turn it on for the specs that care
   * about what happens *between* asking a socket to close and its handler
   * running, and drain the queue with `flushCloseEvents()`.
   */
  static deferCloseEvents = false
  private static pendingCloses: MockWebSocket[] = []

  url: string
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  readyState = 0

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  close() {
    this.readyState = 3
    if (MockWebSocket.deferCloseEvents) {
      MockWebSocket.pendingCloses.push(this)
      return
    }
    if (this.onclose) this.onclose(new CloseEvent('close'))
  }

  /** Deliver every close event `deferCloseEvents` has held back, oldest first. */
  static flushCloseEvents() {
    const pending = MockWebSocket.pendingCloses
    MockWebSocket.pendingCloses = []
    for (const socket of pending) socket.onclose?.(new CloseEvent('close'))
  }

  send() {}

  /** Simulate a server message. */
  receive(data: string) {
    if (this.onmessage) this.onmessage(new MessageEvent('message', { data }))
  }

  /** Simulate the connection opening. */
  connect() {
    this.readyState = 1
    if (this.onopen) this.onopen(new Event('open'))
  }
}

/** Swap the global WebSocket for the mock. `globalThis` is typed without an
 *  index signature, so widen it rather than reaching for `any`. */
export function substituteWebSocket(): void {
  ;(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    MockWebSocket as unknown as typeof WebSocket
}
