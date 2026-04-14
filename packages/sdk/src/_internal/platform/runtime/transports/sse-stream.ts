export type {
  RawServerSentEventHandlers as ServerSentEventHandlers,
  RawServerSentEventOptions as ServerSentEventOptions,
} from '../../../transport-http.js';
export { openRawServerSentEventStream as openServerSentEventStream } from '../../../transport-http.js';

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (
    typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { readonly name?: string }).name === 'AbortError'
  );
}
