/**
 * TransportObserver — first-class observability interface at the transport layer.
 *
 * Defined here (transport-core) so that HTTP and realtime sibling transports can
 * accept it through their shared options types without depending on the SDK layer.
 * `SDKObserver` in `@pellux/goodvibes-sdk` extends this interface and adds
 * SDK-level callbacks (`onEvent`, `onAuthTransition`).
 *
 * All methods are optional. Observer exceptions are always swallowed via
 * `invokeObserver` — they must never propagate into transport control flow.
 */

/**
 * Transport activity metadata surfaced at request/response boundaries.
 */
export interface TransportActivityInfo {
  /** Direction: `'send'` before the request, `'recv'` after a response. */
  readonly direction: 'send' | 'recv';
  /** The full URL of the request. */
  readonly url: string;
  /** HTTP response status code (only present on `'recv'`). */
  readonly status?: number | undefined;
  /** Round-trip duration in milliseconds (only present on `'recv'`). */
  readonly durationMs?: number | undefined;
  /** Transport kind. */
  readonly kind?: 'http' | 'sse' | 'ws' | undefined;
}

/**
 * Minimal observer interface at the transport layer.
 *
 * Implement any subset; the SDK works identically whether an observer is
 * present or not. All call sites are wrapped in a silent try/catch.
 */
export interface TransportObserver {
  /**
   * Called when the SDK catches and is about to rethrow a transport error.
   * The error is still rethrown; this is notification only.
   */
  onError?(err: Error): void;

  /**
   * Called at HTTP/SSE/WebSocket transport boundaries.
   * - `'send'` fires before the request is dispatched.
   * - `'recv'` fires after a response is received (status + duration included).
   */
  onTransportActivity?(activity: TransportActivityInfo): void;
}

/**
 * Safely invoke an observer method. Observer errors are swallowed so they
 * never disrupt transport control flow.
 *
 * @param fn - Zero-argument thunk wrapping the observer call.
 */
export function invokeTransportObserver(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    void error;
    // Observer errors must not propagate into transport logic.
  }
}
