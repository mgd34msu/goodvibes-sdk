/**
 * TransportObserver — first-class observability interface at the transport layer.
 *
 * Defined here (transport-core) so that HTTP and realtime sibling transports can
 * accept it through their shared options types without depending on higher-level packages.
 * Higher-level SDK packages can extend this interface with product-specific
 * callbacks while sharing the same transport option shape.
 *
 * All methods are optional. Observer callback errors are reported through
 * `onObserverError` when supplied and never propagate into transport control flow.
 */
import { GoodVibesSdkError } from '@pellux/goodvibes-errors';
import { transportErrorFromUnknown } from './errors.js';

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
 * present or not. All call sites are isolated from transport control flow.
 */
export interface TransportObserver {
  /**
   * Called when another observer callback throws. This is notification only.
   */
  onObserverError?(err: Error): void;

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
 * Safely invoke an observer method. Observer errors are reported through
 * `onObserverError` when available and never disrupt transport control flow.
 *
 * @param fn - Zero-argument thunk wrapping the observer call.
 * @param onObserverError - Optional observer failure reporter.
 */
export function invokeTransportObserver(fn: () => void, onObserverError?: ((err: Error) => void) | undefined): void {
  try {
    fn();
  } catch (error) {
    if (!onObserverError) return;
    try {
      const observerError = error instanceof Error
        ? new GoodVibesSdkError(`Transport observer callback failed: ${error.message}`, {
          category: 'internal',
          source: 'transport',
          recoverable: false,
          cause: error,
        })
        : transportErrorFromUnknown(error, 'Transport observer callback failed');
      onObserverError(observerError);
    } catch {
      // The observer failure reporter itself failed; no remaining observer hook
      // can report that without risking recursive failure.
    }
  }
}
